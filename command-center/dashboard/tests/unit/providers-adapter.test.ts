/**
 * WP B2 part 2 — the dashboard's provider adapter: parse functions drop malformed rows and copy only
 * whitelisted fields, every gateway state maps to one status word, the redaction second line hides
 * key shapes, the vault answers are parsed without ever carrying a key, and the bridge is detected.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  callVault,
  isPrimary,
  parseKeyStatus,
  parseProviderRow,
  parseProviders,
  parseReconnectOutcome,
  parseTestResult,
  parseVaultList,
  parseVaultOutcome,
  payerOf,
  PROVIDER_STATUSES,
  readKeysBridge,
  scrubSecrets,
  statusFrom,
  signInProgram,
  statusFromState,
  testProvider,
  toneOf,
} from '@/prototype/state/adapter/providers';

const FAKE_KEY = 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseProviders', () => {
  it('keeps good rows, drops malformed and duplicate ones, and counts them', () => {
    const payload = parseProviders({
      providers: [
        { id: 'openai', label: 'OpenAI', key_env_name: 'OPENAI_API_KEY', state: 'configured', key_source: 'vault' },
        { id: 'BAD ID', label: 'x' },
        { id: 'groq' },
        'not an object',
        null,
        { id: 'openai', label: 'OpenAI again' },
        { id: 'ollama-local', label: 'Ollama', local: true, state: 'reachable' },
      ],
    });
    expect(payload.available).toBe(true);
    expect(payload.rows.map((row) => row.id)).toEqual(['openai', 'ollama-local']);
    expect(payload.dropped).toBe(5);
  });

  it('is unavailable (not empty) when the answer has no provider list', () => {
    expect(parseProviders({}).available).toBe(false);
    expect(parseProviders({ providers: 'nope' }).available).toBe(false);
    expect(parseProviders({ providers: [] })).toEqual({ available: true, rows: [], dropped: 0 });
  });

  it('copies only whitelisted fields: a key in any other field never reaches the row', () => {
    const row = parseProviderRow({
      id: 'openai',
      label: 'OpenAI',
      key_env_name: 'OPENAI_API_KEY',
      key: FAKE_KEY,
      value: FAKE_KEY,
      secret: FAKE_KEY,
      detail: `failed with Authorization: Bearer ${FAKE_KEY}`,
    });
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    expect(row?.detail).toContain('[verborgen]');
  });

  it('derives kind, key need, notice, verification date and the NOT-live mark', () => {
    const sub = parseProviderRow({ id: 'claude-code-cli', label: 'Claude Code', subscription: true, notice_required: true, verified_on: '2026-11-01' });
    expect(sub).toMatchObject({ kind: 'subscription', takesKey: false, noticeRequired: true, verifiedOn: '2026-11-01' });
    const local = parseProviderRow({ id: 'lmstudio', label: 'LM Studio', local: true });
    expect(local?.kind).toBe('local');
    const key = parseProviderRow({ id: 'groq', label: 'Groq', keyEnvName: 'GROQ_API_KEY', mock: true, verifiedOn: 'yesterday' });
    expect(key).toMatchObject({ kind: 'key', takesKey: true, live: false, verifiedOn: null });
    expect(parseProviderRow({ id: 'x', label: 'X', key_env_name: 'lower_case' })?.takesKey).toBe(false);
    expect(parseProviderRow({ id: 'x', label: 'X', key_source: 'clipboard' })?.keySource).toBeNull();
  });

  it('reads the state from a nested health object when the row has none', () => {
    expect(parseProviderRow({ id: 'x', label: 'X', health: { state: 'auth-failed' } })?.status).toBe('keyRejected');
  });
});

describe('contract-providers.md v1 rows', () => {
  const ROW = {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai-compatible',
    kind: 'api-key',
    status: 'niet verbonden',
    status_code: 'not-connected',
    state: 'configured',
    detail: 'key present, not tested',
    tested: false,
    live: false,
    who_pays: { code: 'api-key', label: 'Jouw API-sleutel (betaald per gebruik)' },
    tos: { required: false, note: null, checked_on: '2026-11-01' },
    key_name: 'OPENAI_API_KEY',
    key_present: true,
    key_source: 'vault',
    login: { kind: 'api-key' },
    local: false,
  };

  it('reads kind, key name, key source and the terms date; live:false (config only) is NOT a mock', () => {
    const row = parseProviderRow(ROW);
    expect(row).toMatchObject({ kind: 'key', takesKey: true, keySource: 'vault', verifiedOn: '2026-11-01', noticeRequired: false, live: null });
    // not-connected + state configured (a tone-ok state): the code decides, the key is there but untested.
    expect(row?.status).toBe('notConnected');
  });

  it('maps kind cli-detect-only and subscription to a sign-in account with the notice', () => {
    const row = parseProviderRow({ ...ROW, id: 'gemini-cli', kind: 'cli-detect-only', key_name: null, tos: { required: true, checked_on: '2026-11-01' } });
    expect(row).toMatchObject({ kind: 'subscription', takesKey: false, noticeRequired: true });
  });

  it('a row marked as mock (or provenance MOCK) is shown NOT-live', () => {
    expect(parseProviderRow({ ...ROW, mock: true })?.live).toBe(false);
    expect(parseProviderRow({ ...ROW, provenance: 'MOCK' })?.live).toBe(false);
  });

  it.each([
    ['connected', 'signed-in', 'connected'],
    ['connected', null, 'connected'],
    ['no-key', 'not-configured', 'noKey'],
    ['not-installed', 'not-found', 'missing'],
    ['not-connected', 'not-connected', 'signedOut'],
    ['not-connected', 'unreachable', 'unreachable'],
    ['not-connected', 'configured', 'notConnected'],
    ['not-connected', null, 'notConnected'],
    ['error', 'auth-failed', 'keyRejected'],
    ['error', 'rate-limited', 'limit'],
    ['error', 'connected', 'error'],
    ['error', null, 'error'],
    [null, 'installed', 'found'],
    [null, null, 'unknown'],
  ] as const)('status_code %s + state %s -> %s', (code, state, word) => {
    expect(statusFrom(code, state)).toBe(word);
  });

  it('a test answer: top-level ok means "it ran", result.ok decides', () => {
    const failed = parseTestResult({
      ok: true,
      provider: 'openai',
      result: { ok: false, status: 'fout', status_code: 'error', state: 'auth-failed', latency_ms: 412, http_status: 401, detail: 'HTTP 401 from api host' },
      live: true,
    });
    expect(failed).toMatchObject({ ok: false, status: 'keyRejected', latencyMs: 412, live: true });
    const passed = parseTestResult({ ok: true, result: { ok: true, status_code: 'connected', state: 'connected', latency_ms: 88 }, live: true });
    expect(passed).toMatchObject({ ok: true, status: 'connected', latencyMs: 88 });
  });
});

describe('status words', () => {
  it.each([
    ['connected', 'connected'],
    ['signed-in', 'connected'],
    ['configured', 'keySaved'],
    ['reachable', 'running'],
    ['not-configured', 'noKey'],
    ['auth-failed', 'keyRejected'],
    ['unreachable', 'unreachable'],
    ['needs-model', 'noModel'],
    ['not-found', 'missing'],
    ['not-installed', 'missing'],
    ['rate-limited', 'limit'],
    ['not-connected', 'signedOut'],
    ['not-implemented', 'unsupported'],
    ['error', 'error'],
    ['unknown-auth', 'unknown'],
    ['something-new', 'unknown'],
    ['constructor', 'unknown'],
  ] as const)('gateway state %s -> %s', (state, status) => {
    expect(statusFromState(state)).toBe(status);
  });

  it('every status word has a tone', () => {
    for (const status of PROVIDER_STATUSES) expect(['ok', 'warn', 'off', 'bad']).toContain(toneOf(status));
  });
});

describe('who pays, sign-in program, primary', () => {
  it('names the payer per kind', () => {
    expect(payerOf({ id: 'claude-code-cli', kind: 'subscription' })).toBe('claudeSub');
    expect(payerOf({ id: 'codex-cli', kind: 'subscription' })).toBe('chatgptSub');
    expect(payerOf({ id: 'gemini-cli', kind: 'subscription' })).toBe('ownSub');
    expect(payerOf({ id: 'openai', kind: 'key' })).toBe('key');
    expect(payerOf({ id: 'ollama-local', kind: 'local' })).toBe('free');
  });

  it('only Claude Code and Codex have a sign-in program', () => {
    expect(signInProgram('claude-code-cli')).toBe('claude');
    expect(signInProgram('codex-cli')).toBe('codex');
    expect(signInProgram('gemini-cli')).toBeNull();
  });

  it('primary = sign-in accounts, Ollama, accounts with a key (gateway or vault), and answering local servers', () => {
    const row = (extra: Record<string, unknown>) => parseProviderRow({ label: 'X', ...extra })!;
    expect(isPrimary(row({ id: 'claude-code-cli', subscription: true }))).toBe(true);
    expect(isPrimary(row({ id: 'ollama-local', local: true, state: 'unreachable' }))).toBe(true);
    expect(isPrimary(row({ id: 'groq', key_env_name: 'GROQ_API_KEY', key_source: 'env' }))).toBe(true);
    expect(isPrimary(row({ id: 'groq', key_env_name: 'GROQ_API_KEY' }))).toBe(false);
    expect(isPrimary(row({ id: 'groq', key_env_name: 'GROQ_API_KEY' }), new Set(['groq']))).toBe(true);
    expect(isPrimary(row({ id: 'lmstudio', local: true, state: 'reachable' }))).toBe(true);
    expect(isPrimary(row({ id: 'lmstudio', local: true, state: 'unreachable' }))).toBe(false);
  });
});

describe('test result', () => {
  it('parses ok, latency and the NOT-live mark, and scrubs the detail', () => {
    expect(parseTestResult({ ok: true, result: { ok: true, state: 'connected', latencyMs: 231.6 } })).toEqual({
      ok: true,
      status: 'connected',
      latencyMs: 232,
      detail: null,
      live: null,
      row: null,
    });
    const failed = parseTestResult({ ok: true, state: 'auth-failed', latency_ms: -1, detail: `401 for key=${FAKE_KEY}`, mock: true });
    expect(failed).toMatchObject({ ok: false, status: 'keyRejected', latencyMs: null, live: false });
    expect(failed.detail).not.toContain(FAKE_KEY);
  });

  it('testProvider posts to the provider route and turns a transport failure into a scrubbed error', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: `upstream said ${FAKE_KEY}` }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const result = await testProvider('openai');
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/providers\/openai\/test$/);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.detail).not.toContain(FAKE_KEY);
  });

  it('testProvider sends the exec token header like every other write call (contract-providers.md §4)', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'cc-exec-token');
    meta.setAttribute('content', 'exec-token-for-test');
    document.head.appendChild(meta);
    try {
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { ok: true, state: 'connected' } }) }) as unknown as Response);
      vi.stubGlobal('fetch', fetchSpy);
      await testProvider('openai');
      const init = (fetchSpy.mock.calls[0] as unknown[])[1] as { method?: string; headers?: Record<string, string> };
      expect(init.method).toBe('POST');
      expect(init.headers?.['x-cc-exec-token']).toBe('exec-token-for-test');
    } finally {
      meta.remove();
    }
  });

  it('testProvider without the token meta sends no token header (the gateway then refuses honestly)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    await testProvider('openai');
    const init = (fetchSpy.mock.calls[0] as unknown[])[1] as { headers?: Record<string, string> };
    expect(init.headers?.['x-cc-exec-token']).toBeUndefined();
  });

  it('a test answer carries the refreshed row, so the card can update its status word', () => {
    const parsed = parseTestResult({
      ok: true,
      provider: 'anthropic',
      result: { ok: true, status_code: 'connected', state: 'connected', latency_ms: 90 },
      row: { id: 'anthropic', label: 'Anthropic API', key_name: 'ANTHROPIC_API_KEY', key_source: 'vault', status_code: 'connected', state: 'connected' },
      live: true,
    });
    expect(parsed.row).toMatchObject({ id: 'anthropic', status: 'connected' });
    expect(parseTestResult({ ok: true, result: { ok: true, state: 'connected' } }).row).toBeNull();
    expect(parseTestResult({ ok: true, result: { ok: true, state: 'connected' }, row: { id: 'BAD ID' } }).row).toBeNull();
  });

  it('testProvider refuses an id that is not a provider id, without a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await testProvider('../etc')).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('scrubSecrets', () => {
  it.each([
    'sk-ant-' + 'api03-abcdefghijklmnop',
    'nvapi-abcdefghijklmnop',
    'gsk_abcdefghijklmnop',
    'xai-abcdefghijklmnop',
    'AIzaSyabcdefghijklmnop',
    'hf_abcdefghijklmnop',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh',
    'Bearer abcdefghijklmnop',
    'x-api-key: abcdefghijklmnop',
  ])('hides %s', (secret) => {
    expect(scrubSecrets(`before ${secret} after`)).not.toContain(secret);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('connect timeout after 3000 ms to api host')).toBe('connect timeout after 3000 ms to api host');
  });
});

describe('the desktop vault', () => {
  it('parses a key status: last4 only when configured and exactly four printable characters', () => {
    expect(parseKeyStatus({ provider_id: 'openai', configured: true, last4: 'Wx9z', updated_at: '2026-11-02T08:00:00Z' })).toEqual({
      providerId: 'openai',
      configured: true,
      last4: 'Wx9z',
      updatedAt: '2026-11-02T08:00:00Z',
    });
    expect(parseKeyStatus({ provider_id: 'openai', configured: true, last4: FAKE_KEY })?.last4).toBeNull();
    expect(parseKeyStatus({ provider_id: 'openai', configured: false, last4: 'Wx9z' })?.last4).toBeNull();
    expect(parseKeyStatus({ provider_id: 'Not Valid', configured: true })).toBeNull();
  });

  it('parses a set result with its apply state, and an error with its Dutch message', () => {
    const ok = parseVaultOutcome(
      { ok: true, status: { provider_id: 'groq', configured: true, last4: 'abcd' }, apply: { state: 'waiting-for-idle', detail: null } },
      'groq',
    );
    expect(ok).toMatchObject({ ok: true, apply: 'waiting-for-idle', status: { last4: 'abcd' } });
    expect(parseVaultOutcome({ ok: true, status: {}, apply: { state: 'bogus' } }, 'groq')).toMatchObject({
      ok: true,
      apply: 'unknown',
      status: { providerId: 'groq', configured: false },
    });
    expect(parseVaultOutcome({ ok: false, code: 'VAULT_UNAVAILABLE', message: 'Versleutelen werkt niet.' }, 'groq')).toEqual({
      ok: false,
      code: 'VAULT_UNAVAILABLE',
      message: 'Versleutelen werkt niet.',
    });
    expect(parseVaultOutcome('nonsense', 'groq')).toMatchObject({ ok: false });
  });

  it('a missing or unknown apply state is never read as applied (contract v1.2 §5)', () => {
    const status = { provider_id: 'groq', configured: true, last4: 'abcd' };
    expect(parseVaultOutcome({ ok: true, status }, 'groq')).toMatchObject({ ok: true, apply: 'unknown', applyDetail: null, applyAction: null });
    expect(parseVaultOutcome({ ok: true, status, apply: null }, 'groq')).toMatchObject({ apply: 'unknown' });
    expect(parseVaultOutcome({ ok: true, status, apply: {} }, 'groq')).toMatchObject({ apply: 'unknown' });
    expect(parseVaultOutcome({ ok: true, status, apply: { state: 'later-maybe' } }, 'groq')).toMatchObject({ apply: 'unknown' });
    expect(parseVaultOutcome({ ok: true, status, apply: { state: 'applied', detail: null } }, 'groq')).toMatchObject({ apply: 'applied' });
  });

  it('parses apply.detail and apply.action {id, label}; only the reconnect-now action is kept', () => {
    const status = { provider_id: 'groq', configured: true, last4: 'abcd' };
    const waiting = parseVaultOutcome(
      {
        ok: true,
        status,
        apply: {
          state: 'waiting-for-idle',
          detail: 'Sleutel wordt toegepast zodra de huidige klus klaar is',
          action: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' },
        },
      },
      'groq',
    );
    expect(waiting).toMatchObject({
      ok: true,
      apply: 'waiting-for-idle',
      applyDetail: 'Sleutel wordt toegepast zodra de huidige klus klaar is',
      applyAction: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' },
    });
    expect(parseVaultOutcome({ ok: true, status, apply: { state: 'waiting-for-idle', action: { id: 'format-disk', label: 'Doe iets' } } }, 'groq')).toMatchObject({
      applyAction: null,
    });
    expect(parseVaultOutcome({ ok: true, status, apply: { state: 'waiting-for-idle', action: { id: 'reconnect-now' } } }, 'groq')).toMatchObject({
      applyAction: { id: 'reconnect-now', label: null },
    });
  });

  it('parses the reconnect answer: ok with the new apply state, or the Dutch refusal with its code', async () => {
    expect(parseReconnectOutcome({ ok: true, apply: { state: 'restarting', detail: 'Even opnieuw verbinden...' } })).toEqual({
      ok: true,
      apply: 'restarting',
      applyDetail: 'Even opnieuw verbinden...',
      applyAction: null,
    });
    expect(
      parseReconnectOutcome({ ok: false, code: 'TURN_RUNNING', message: 'Er loopt nu een klus. De sleutel wordt actief zodra die klaar is.' }),
    ).toEqual({ ok: false, code: 'TURN_RUNNING', message: 'Er loopt nu een klus. De sleutel wordt actief zodra die klaar is.' });
    expect(parseReconnectOutcome('junk')).toMatchObject({ ok: false, code: 'BAD_ANSWER' });
    const thrown = await callVault(() => Promise.reject(new Error(`echo ${FAKE_KEY}`)), 'groq', 'reconnect');
    expect(thrown).toEqual({ ok: false, code: 'BRIDGE_FAILED', message: '' });
    const passed = await callVault(() => Promise.resolve({ ok: false, code: 'NOTHING_PENDING', message: '' }), 'groq', 'reconnect');
    expect(passed).toEqual({ ok: false, code: 'NOTHING_PENDING', message: '' });
  });

  it('parses the list: only configured keys, and the vault state', () => {
    const list = parseVaultList({
      ok: true,
      vault: { state: 'ready', reason: null, persistent: true },
      keys: [{ provider_id: 'groq', configured: true, last4: 'abcd' }, { provider_id: 'openai', configured: false }, 'junk'],
    });
    expect(list.ready).toBe(true);
    expect(list.keys.map((key) => key.providerId)).toEqual(['groq']);
    expect(parseVaultList({ ok: false, vault: { state: 'unavailable', reason: 'Geen versleuteling.' } })).toEqual({
      ready: false,
      reason: 'Geen versleuteling.',
      keys: [],
    });
  });

  it('callVault never throws and never passes on the rejection text (it could echo the input)', async () => {
    const outcome = await callVault(() => Promise.reject(new Error(`bad key ${FAKE_KEY}`)), 'groq');
    expect(outcome).toEqual({ ok: false, code: 'BRIDGE_FAILED', message: '' });
  });

  it('detects the bridge only when window.forge.keys.set is a function', () => {
    expect(readKeysBridge()).toBeNull();
    vi.stubGlobal('forge', { gatewayOrigin: () => 'http://127.0.0.1:4100' });
    expect(readKeysBridge()).toBeNull();
    vi.stubGlobal('forge', { keys: { set: 'nope' } });
    expect(readKeysBridge()).toBeNull();
    const set = vi.fn();
    vi.stubGlobal('forge', { keys: { set } });
    expect(readKeysBridge()?.set).toBe(set);
  });
});
