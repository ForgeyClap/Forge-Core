/**
 * App router (APP-ROUTER-DESIGN.md §6.1, §7.3; part P4) — the dashboard adapter against the example
 * responses of the contract (fixtures in tests/fixtures/app-router, written from the doc), the pure
 * settings model, and the chat parsers for `route` records and router events.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import getStored from '../fixtures/app-router/get-stored.json';
import getDefault from '../fixtures/app-router/get-default.json';
import statusFixture from '../fixtures/app-router/status.json';
import statusExhausted from '../fixtures/app-router/status-exhausted.json';
import post400 from '../fixtures/app-router/post-400.json';
import profiles201 from '../fixtures/app-router/profiles-201.json';
import testResults from '../fixtures/app-router/test-results.json';
import conversationRouted from '../fixtures/app-router/conversation-routed.json';

import {
  createProfile,
  parseProviderModels,
  parseRouterGet,
  parseRouterStatus,
  saveRouterConfig,
  testTarget,
} from '@/prototype/state/adapter/app-router';
import type { RouterConfig } from '@/prototype/state/adapter/app-router';
import { parseConversationDetail, readChatMessageRouteExhausted, readChatMessageRouteTurn } from '@/prototype/state/gateway-chat/live-activity';
import { readChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import {
  effectiveIds,
  entryPill,
  fallbackEntryId,
  greyedByGate,
  moveEntry,
  normalizePath,
  presetOrder,
  validateDraft,
  withMode,
} from '@/views/settings/sections/app-router/app-router-model';

type FetchAnswer = { status: number; body: unknown };

function stubFetch(answer: FetchAnswer | ((url: string, init?: RequestInit) => FetchAnswer)) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const a = typeof answer === 'function' ? answer(url, init) : answer;
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as Response;
    }),
  );
  return calls;
}

const NO_FACTS = () => ({ paid: false, notice: false });

function stored(): RouterConfig {
  const parsed = parseRouterGet(getStored as Record<string, unknown>);
  if (!parsed) throw new Error('fixture did not parse');
  return parsed.config;
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/app-router parsing', () => {
  it('keeps the stored config in its exact wire shape (a save echoes it byte for byte)', () => {
    const parsed = parseRouterGet(getStored as Record<string, unknown>);
    expect(parsed?.provenance).toBe('STORED');
    expect(parsed?.problems).toBe(0);
    expect(parsed?.config).toEqual(getStored.config);
    expect(parsed?.termsSources.map((s) => s.title)).toEqual(['Consumer Terms', 'Usage Policy', 'Claude Code legal and compliance']);
    expect(parsed?.profilesRootDisplay).toBe('~\\.forge-router\\profiles');
  });

  it('reads the defaults (mode off, only the main entry)', () => {
    const parsed = parseRouterGet(getDefault as Record<string, unknown>);
    expect(parsed?.config.mode).toBe('off');
    expect(parsed?.config.entries.map((e) => e.id)).toEqual(['main']);
  });

  it('an answer without a readable config is null (an older gateway), never a guessed default', () => {
    expect(parseRouterGet({})).toBeNull();
    expect(parseRouterGet({ ok: true, config: { version: 2 } })).toBeNull();
  });

  it('an entry it cannot round-trip is counted as a problem instead of being dropped silently', () => {
    const body = structuredClone(getStored) as { config: { entries: unknown[] } };
    body.config.entries.push({ id: 'x', kind: 'future-kind', label: 'X', enabled: true });
    const parsed = parseRouterGet(body as Record<string, unknown>);
    expect(parsed?.problems).toBe(1);
  });

  it('only renders https links for the terms sources', () => {
    const body = structuredClone(getStored) as { terms: { sources: { title: string; url: string }[] } };
    body.terms.sources.push({ title: 'Bad', url: 'javascript:alert(1)' });
    expect(parseRouterGet(body as Record<string, unknown>)?.termsSources).toHaveLength(3);
  });
});

describe('GET /api/app-router/status parsing', () => {
  it('reads states, windows and the next choice; a missing percentage stays null', () => {
    const status = parseRouterStatus(statusFixture as Record<string, unknown>);
    expect(status.entries.map((e) => e.state)).toEqual(['near-limit', 'unknown', 'unknown', 'ready']);
    expect(status.entries[0].windows[0]).toEqual({ type: 'five_hour', pct: 94, resetsAt: '2026-11-02T16:40:00.000Z', status: 'allowed_warning' });
    expect(status.entries[1].maxPct).toBeNull();
    expect(status.next).toEqual({ kind: 'target', id: 'main', label: 'Hoofdaccount', reason: 'sticky', switched: false });
  });

  it('reads the exhausted next with the first account free again', () => {
    const status = parseRouterStatus(statusExhausted as Record<string, unknown>);
    expect(status.next).toEqual({ kind: 'exhausted', resumeAt: '2026-11-02T16:40:00.000Z', firstFreeLabel: 'Hoofdaccount', firstFreeAt: '2026-11-02T16:40:00.000Z' });
    expect(status.lastSwitch?.to).toBe('werk');
  });
});

describe('writes', () => {
  it('POST /api/app-router sends the full config with its revision and adopts the answer', async () => {
    const config = stored();
    const calls = stubFetch({ status: 200, body: { ok: true, config: { ...getStored.config, revision: 8 } } });
    const outcome = await saveRouterConfig(config);
    expect(outcome.kind).toBe('saved');
    expect(outcome.kind === 'saved' && outcome.config.revision).toBe(8);
    expect(calls[0].url).toMatch(/\/api\/app-router$/);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(getStored.config);
  });

  it('400 keeps every field error (nl + en), 409 returns the newest config, 403 / 429 are their own outcomes', async () => {
    stubFetch({ status: 400, body: post400 });
    const invalid = await saveRouterConfig(stored());
    expect(invalid.kind === 'invalid' && invalid.errors.map((e) => e.code)).toEqual(['out_of_range', 'multi_account_required']);

    stubFetch({ status: 409, body: { ok: false, error: 'stale_revision', config: { ...getStored.config, revision: 9 } } });
    const stale = await saveRouterConfig(stored());
    expect(stale.kind === 'stale' && stale.config?.revision).toBe(9);

    stubFetch({ status: 403, body: { ok: false, error: 'ui session required' } });
    expect((await saveRouterConfig(stored())).kind).toBe('refused');

    stubFetch({ status: 429, body: { ok: false } });
    expect((await saveRouterConfig(stored())).kind).toBe('too-many');
  });

  it('a network failure is a typed failure, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connection refused'))));
    expect(await saveRouterConfig(stored())).toEqual({ kind: 'failed', error: 'connection refused' });
  });

  it('POST /api/app-router/profiles returns the entry, the new config and the quoted login commands', async () => {
    const calls = stubFetch({ status: 201, body: profiles201 });
    const outcome = await createProfile('Privé');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ label: 'Privé' });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.entry.profile).toBe('prive');
    expect(outcome.config.revision).toBe(8);
    expect(outcome.login.powershell).toContain("'C:\\Users\\Jan de Vries\\.forge-router\\profiles\\prive'");
    expect(outcome.dirDisplay).toBe('~\\.forge-router\\profiles\\prive');
  });

  it('409 on profiles is "exists" (duplicate or the 8-account cap)', async () => {
    stubFetch({ status: 409, body: { ok: false, error: 'exists' } });
    expect((await createProfile('Werk')).kind).toBe('exists');
  });

  it('POST /targets/:id/test reads the state and reading; 429 carries the wait', async () => {
    const calls = stubFetch({ status: 200, body: testResults.ok });
    const ok = await testTarget('werk', () => new Date('2026-11-02T14:02:00.000Z'));
    expect(calls[0].url).toMatch(/\/api\/app-router\/targets\/werk\/test$/);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
    expect(ok).toMatchObject({ kind: 'done', state: 'ready', at: '2026-11-02T14:02:00.000Z' });
    expect(ok.kind === 'done' && ok.windows[0].pct).toBeNull();

    stubFetch({ status: 429, body: testResults.too_soon });
    expect(await testTarget('werk')).toEqual({ kind: 'too-soon', retryAfterS: 240 });
  });

  it('refuses a malformed target id without calling the gateway', async () => {
    const calls = stubFetch({ status: 200, body: {} });
    expect((await testTarget('../x')).kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('provider model lists (GET /api/models providers block)', () => {
  it('keeps model ids per provider and the source (not-fetched means unknown, not empty)', () => {
    const out = parseProviderModels({
      providers: { pending: false, list: [{ id: 'ollama-local', label: 'Ollama', status_code: 'connected', models: [{ id: 'llama3.1:8b' }], models_source: 'endpoint' }] },
    });
    expect(out.list).toEqual([{ id: 'ollama-local', label: 'Ollama', statusCode: 'connected', models: ['llama3.1:8b'], source: 'endpoint' }]);
    expect(parseProviderModels({}).list).toEqual([]);
  });
});

describe('settings model', () => {
  it('a mode re-sorts into its preset order (Claude first for b, own models first for c)', () => {
    const config = stored();
    expect(presetOrder(config.entries, 'claude-then-model').map((e) => e.id)).toEqual(['main', 'werk', 'codex', 'ollama-llama31']);
    expect(presetOrder(config.entries, 'model-first').map((e) => e.id)).toEqual(['ollama-llama31', 'codex', 'main', 'werk']);
    expect(withMode(config, 'off').entries).toBe(config.entries);
  });

  it('the effective chain mirrors the multi-account gate', () => {
    const config = stored();
    expect(effectiveIds(config)).toEqual(['main', 'ollama-llama31']);
    expect(greyedByGate(config, config.entries[1])).toBe(true);
    const on = { ...config, multi_account: { enabled: true, acknowledged_at: '2026-11-02T14:00:00.000Z' } };
    expect(effectiveIds(on)).toEqual(['main', 'werk', 'ollama-llama31']);
    expect(effectiveIds({ ...on, mode: 'claude-accounts' })).toEqual(['main', 'werk']);
    expect(effectiveIds({ ...config, mode: 'off' })).toEqual([]);
  });

  it('validation mirror: mode a needs the acknowledgement and two accounts; thresholds 50-99', () => {
    const config = stored();
    const a = withMode(config, 'claude-accounts');
    expect(validateDraft(a, NO_FACTS).map((i) => i.path)).toEqual(['multi_account']);
    const one = { ...a, multi_account: { enabled: true, acknowledged_at: 'x' }, entries: a.entries.filter((e) => e.id !== 'werk') };
    expect(validateDraft(one, NO_FACTS).map((i) => i.key)).toContain('appRouter.issues.needsTwo');
    const bad = { ...config, entries: config.entries.map((e) => (e.id === 'werk' ? { ...e, threshold_pct: 120 } : e)) };
    expect(validateDraft(bad, NO_FACTS)).toEqual([{ path: 'entries[1].threshold_pct', key: 'appRouter.issues.threshold', vars: { min: 50, max: 99 } }]);
    const noFallback = { ...config, entries: config.entries.filter((e) => e.kind === 'claude-account') };
    expect(validateDraft(noFallback, NO_FACTS).map((i) => i.path)).toEqual(['fallback']);
    expect(validateDraft(config, () => ({ paid: true, notice: false })).map((i) => i.key)).toEqual(['appRouter.issues.paidAck']);
  });

  it('paths from the server match either style', () => {
    expect(normalizePath('entries.1.threshold_pct')).toBe('entries[1].threshold_pct');
    expect(normalizePath('entries[1].threshold_pct')).toBe('entries[1].threshold_pct');
  });

  it('reorders with bounds, and makes free, valid chain ids', () => {
    const entries = stored().entries;
    expect(moveEntry(entries, 0, -1)).toBe(entries);
    expect(moveEntry(entries, 0, 1).map((e) => e.id)).toEqual(['werk', 'main', 'codex', 'ollama-llama31']);
    expect(fallbackEntryId('ollama-local', 'llama3.1:8b', new Set())).toBe('ollama-local-llama3-1-8b');
    expect(fallbackEntryId('ollama-local', 'llama3.1:8b', new Set(['ollama-local-llama3-1-8b']))).toBe('ollama-local-llama3-1-8b-2');
    expect(fallbackEntryId('x', '', new Set())).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });

  it('state pills: limit with time, unknown (never 0), untested extra profile, gate, test results', () => {
    const config = stored();
    const [main, werk] = config.entries;
    const now = Date.parse('2026-11-02T14:05:00.000Z');
    const exhausted = parseRouterStatus(statusExhausted as Record<string, unknown>).entries[0];
    const base = { greyed: false, testing: false, test: null, locale: 'nl', now };
    expect(entryPill({ ...base, entry: main, status: exhausted }).key).toBe('appRouter.state.limit');
    expect(entryPill({ ...base, entry: main, status: null }).key).toBe('appRouter.state.unknown');
    expect(entryPill({ ...base, entry: werk, status: null }).key).toBe('appRouter.state.untested');
    expect(entryPill({ ...base, entry: werk, status: null, greyed: true }).key).toBe('appRouter.state.gated');
    expect(entryPill({ ...base, entry: werk, status: null, testing: true }).key).toBe('appRouter.state.testing');
    const done = { kind: 'done' as const, windows: [], detail: null, at: '2026-11-02T14:02:00.000Z' };
    expect(entryPill({ ...base, entry: werk, status: null, test: { ...done, state: 'logged_out' } }).key).toBe('appRouter.state.loggedOut');
    expect(entryPill({ ...base, entry: werk, status: null, test: { ...done, state: 'ready' } }).key).toBe('appRouter.state.signedIn');
    // A reading older than 15 minutes is no longer "ready".
    const ready = parseRouterStatus(statusFixture as Record<string, unknown>).entries[3];
    expect(entryPill({ ...base, entry: config.entries[3], status: ready, now: Date.parse('2026-11-02T15:00:00.000Z') }).key).toBe('appRouter.state.unknown');
  });
});

describe('chat: route records and router events', () => {
  it('reads the route of each assistant turn; a failed attempt 1 (route_attempt_failed) folds onto the answer', () => {
    const detail = parseConversationDetail('c-router', conversationRouted as Record<string, unknown>);
    const ids = detail.messages.map((m) => m.id);
    // A user turn and its reply share the turn_id (gateway convention); among the answers every id is unique.
    const answers = detail.messages.filter((m) => m.author === 'forge').map((m) => m.id);
    expect(new Set(answers).size).toBe(answers.length);
    expect(ids).toEqual(['t1', 't1', 't2', 't2', 't3', 't3']);
    const routes = detail.messages.map(readChatMessageRoute);
    expect(routes[0]).toBeNull();
    expect(readChatMessageRouteTurn(detail.messages[3])?.failedAttempt?.route).toMatchObject({ targetId: 'main', retried: true, outcome: 'rate_limited' });
    expect(routes[3]).toMatchObject({ targetId: 'werk', switched: true, reason: 'switch-limit', attempt: 2, handover: { turns: 3, chars: 412, truncated: false } });
    expect(routes[5]).toMatchObject({ kind: 'provider-model', capability: 'answers-only', label: 'Ollama · llama3.1' });
  });

  it('a router off turn has no route at all', () => {
    const detail = parseConversationDetail('c', { turns: [{ type: 'turn', turn_id: 't1', role: 'assistant', text: 'x' }], events: [] });
    expect(readChatMessageRoute(detail.messages[0])).toBeNull();
  });

  it('while attempt 2 runs, the retried attempt 1 does not count as the reply; the live notice and own-model text appear', () => {
    const detail = parseConversationDetail('c', {
      turns: [
        { type: 'turn', turn_id: 't1', role: 'user', text: 'hoi' },
        { type: 'turn', turn_id: 't1', role: 'assistant', text: 'half', route: { target_id: 'main', label: 'Hoofdaccount', retried: true, outcome: 'rate_limited', attempt: 1 } },
      ],
      events: [
        { kind: 'route_switched', turn_id: 't1', data: { target_id: 'ollama-llama31', label: 'Ollama · llama3.1', kind: 'provider-model', capability: 'answers-only', reason: 'switch-limit', attempt: 2, from_label: 'Hoofdaccount' } },
        { kind: 'provider_delta', turn_id: 't1', data: { text: 'Dit is ' } },
        { kind: 'provider_delta', turn_id: 't1', data: { text: 'het antwoord.' } },
      ],
    });
    const live = detail.messages[detail.messages.length - 1];
    expect(live.id).toBe('t1-live');
    expect(live.body).toBe('Dit is het antwoord.');
    expect(readChatMessageRoute(live)).toMatchObject({ targetId: 'ollama-llama31', switched: true, capability: 'answers-only' });
  });

  it('route_exhausted ends the pending turn and becomes one notice right after its user turn', () => {
    const detail = parseConversationDetail('c', {
      turns: [{ type: 'turn', turn_id: 't1', role: 'user', text: 'hoi' }],
      events: [{ kind: 'route_exhausted', turn_id: 't1', data: { resume_at: '2026-11-02T16:40:00.000Z', first_free: { label: 'Werk', resume_at: '2026-11-02T16:40:00.000Z' } } }],
    });
    expect(detail.messages.map((m) => m.id)).toEqual(['t1', 't1-exhausted']);
    expect(readChatMessageRouteExhausted(detail.messages[1])).toEqual({ resumeAt: '2026-11-02T16:40:00.000Z', firstFreeLabel: 'Werk', firstFreeAt: '2026-11-02T16:40:00.000Z', code: 'unknown', skipped: [] });
  });
});
