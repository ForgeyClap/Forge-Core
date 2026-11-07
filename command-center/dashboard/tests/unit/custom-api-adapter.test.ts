/**
 * the dashboard adapter for "Eigen API" entries (ANY-MODEL-PLAN.md §2.2 A + D), against the
 * HTTP contract the C1b routes answer (fixtures here; the gateway part is built in parallel):
 *   GET    /api/providers/custom          -> {ok, revision, providers:[entry]}
 *   POST   /api/providers/custom          {revision, provider} -> 201 {ok, revision, provider}
 *   PATCH  /api/providers/custom/:id      {revision, provider} -> 200 {ok, revision, provider}
 *   DELETE /api/providers/custom/:id      -> 200 {ok, revision}
 * Errors: 400 {errors:[{path,code,nl,en}]}, 409 stale/duplicate, 403, 404 (an older gateway), 429.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCustomProvider,
  deleteCustomProvider,
  parseCustomEntry,
  parseCustomList,
  updateCustomProvider,
} from '@/prototype/state/adapter/providers-custom';
import type { CustomDefinition } from '@/prototype/state/adapter/providers-custom';

const ENTRY = {
  id: 'custom-mijn-vllm',
  label: 'Mijn vLLM-server',
  format: 'openai-chat',
  baseURL: 'http://192.168.1.20:8000/v1',
  auth: { type: 'bearer' },
  models: { mode: 'endpoint' },
  extraHeaders: {},
  contextLength: null,
  enabled: true,
  created_at: '2026-11-02T19:00:00.000Z',
  updated_at: '2026-11-02T19:00:00.000Z',
};

const DEF: CustomDefinition = {
  label: 'Mijn vLLM-server',
  format: 'openai-chat',
  baseURL: 'http://192.168.1.20:8000/v1',
  auth: { type: 'bearer' },
  models: { mode: 'endpoint' },
  extraHeaders: {},
  contextLength: null,
  enabled: true,
};

function answer(status: number, body: unknown) {
  const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', headers: init?.headers ?? {} });
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCustomEntry: strict, field whitelist', () => {
  it('reads a full entry', () => {
    expect(parseCustomEntry(ENTRY)).toEqual({
      id: 'custom-mijn-vllm',
      label: 'Mijn vLLM-server',
      format: 'openai-chat',
      baseURL: 'http://192.168.1.20:8000/v1',
      auth: { type: 'bearer' },
      models: { mode: 'endpoint' },
      extraHeaders: {},
      contextLength: null,
      enabled: true,
      createdAt: '2026-11-02T19:00:00.000Z',
      updatedAt: '2026-11-02T19:00:00.000Z',
    });
  });

  it('keeps a manual model list and a custom header, drops anything else', () => {
    const parsed = parseCustomEntry({
      ...ENTRY,
      auth: { type: 'custom', header: 'X-Auth-Token', prefix: 'Token ', value: 'should-never-be-copied' },
      models: { mode: 'manual', ids: ['qwen2.5-coder:32b', 'bad id'] },
      secret: 'sk-should-never-be-copied-0123456789',
    });
    expect(parsed?.auth).toEqual({ type: 'custom', header: 'X-Auth-Token', prefix: 'Token ' });
    expect(parsed?.models).toEqual({ mode: 'manual', ids: ['qwen2.5-coder:32b'] });
    expect(JSON.stringify(parsed)).not.toContain('should-never-be-copied');
  });

  it('refuses an id outside custom-*, an unknown format, or a missing address', () => {
    expect(parseCustomEntry({ ...ENTRY, id: 'openai' })).toBeNull();
    expect(parseCustomEntry({ ...ENTRY, format: 'gemini' })).toBeNull();
    expect(parseCustomEntry({ ...ENTRY, baseURL: '' })).toBeNull();
    expect(parseCustomEntry('nope')).toBeNull();
  });
});

describe('parseCustomList', () => {
  it('a list with a revision is available; bad rows are counted, not guessed', () => {
    expect(parseCustomList({ ok: true, revision: 3, providers: [ENTRY, { id: 'x' }] })).toMatchObject({
      available: true,
      revision: 3,
      dropped: 1,
    });
  });

  it('an answer without a revision is not this list (an older or other route)', () => {
    expect(parseCustomList({ ok: true, providers: [ENTRY] }).available).toBe(false);
  });
});

describe('create / update / delete', () => {
  it('create POSTs {revision, provider} with the exec token header and returns the saved entry', async () => {
    const meta = document.createElement('meta');
    meta.name = 'cc-exec-token';
    meta.content = 'tok-123';
    document.head.appendChild(meta);
    const calls = answer(201, { ok: true, revision: 4, provider: ENTRY });
    const outcome = await createCustomProvider(DEF, 3);
    meta.remove();
    expect(outcome).toMatchObject({ kind: 'saved', revision: 4, entry: { id: 'custom-mijn-vllm' } });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/providers\/custom$/);
    expect(JSON.parse(calls[0].body)).toEqual({ revision: 3, provider: DEF });
    expect(calls[0].headers['x-cc-exec-token']).toBe('tok-123');
  });

  it('update PATCHes the one id', async () => {
    const calls = answer(200, { ok: true, revision: 5, provider: ENTRY });
    const outcome = await updateCustomProvider('custom-mijn-vllm', DEF, 4);
    expect(outcome.kind).toBe('saved');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toMatch(/\/api\/providers\/custom\/custom-mijn-vllm$/);
  });

  it('update refuses an id outside custom-* without calling anything', async () => {
    const calls = answer(200, {});
    expect((await updateCustomProvider('openai', DEF, 1)).kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('delete sends DELETE and returns the new revision', async () => {
    const calls = answer(200, { ok: true, revision: 6 });
    expect(await deleteCustomProvider('custom-mijn-vllm')).toEqual({ kind: 'deleted', revision: 6, routerEntries: null });
    expect(calls[0].method).toBe('DELETE');
  });

  it.each([
    [400, { ok: false, errors: [{ path: 'baseURL', code: 'https_required', nl: 'Gebruik https.', en: 'Use https.' }] }, 'invalid'],
    [409, { ok: false, error: 'stale_revision', revision: 9 }, 'stale'],
    [409, { ok: false, error: 'duplicate_id', revision: 9 }, 'duplicate'],
    [403, { ok: false, error: 'pairing required' }, 'refused'],
    [404, {}, 'missing'],
    [429, {}, 'too-many'],
    [500, { ok: false, error: 'boom' }, 'failed'],
  ] as const)('HTTP %s -> %s', async (status, body, kind) => {
    answer(status, body);
    const outcome = await createCustomProvider(DEF, 1);
    expect(outcome.kind).toBe(kind);
    if (outcome.kind === 'invalid') expect(outcome.errors[0]).toEqual({ path: 'baseURL', code: 'https_required', nl: 'Gebruik https.', en: 'Use https.' });
    if (outcome.kind === 'stale') expect(outcome.revision).toBe(9);
  });

  it('a network failure is a typed failure, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await createCustomProvider(DEF, 1)).toEqual({ kind: 'failed', error: 'offline' });
  });

  it('refuses to send a definition with a key-shaped value', async () => {
    const calls = answer(201, { ok: true, revision: 1, provider: ENTRY });
    const outcome = await createCustomProvider({ ...DEF, label: 'sk-abcdefghijklmnop123456' }, 1);
    expect(outcome.kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});
