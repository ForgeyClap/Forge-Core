// "Eigen API" (ANY-MODEL-PLAN 2.2 B): compiled custom entries run through the EXISTING adapters
// against the in-process mock server: openai chat/responses, anthropic with x-api-key taken from the entry,
// the new custom-header auth, manual model lists, and no redirect following. No network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry, MemoryKeyProvider, ProviderError, ERROR_CODES } from '../src/providers/index.mjs';
import { compileCustomEntry } from '../src/providers/custom-registry.mjs';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';

const bundled = loadRegistry();
const KEY = 'custom-test-key-' + 'k'.repeat(24);
const FAST = { sleep: async () => {}, random: () => 0 };

function entryFor(server, over = {}, pathSuffix = '/v1') {
  const { entry, problems } = compileCustomEntry({
    id: 'custom-mock', label: 'Mock', format: 'openai-chat', baseURL: server.url + pathSuffix,
    auth: { type: 'bearer' }, models: { mode: 'endpoint' }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
  }, { bundled });
  assert.deepEqual(problems, []);
  return entry;
}
function make(entry, opts = {}) {
  return createProvider(entry, { keyProvider: new MemoryKeyProvider({ CUSTOM_MOCK_API_KEY: KEY }), transport: FAST, ...opts });
}
const chatOk = { id: 'c1', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

test('openai-chat + bearer + endpoint: Test lists models with Authorization: Bearer <vault key>', async () => {
  const server = await startMockServer((req, h) => h.json(200, { data: [{ id: 'qwen2.5-coder:32b' }] }));
  try {
    const p = make(entryFor(server));
    const t = await p.testConnection();
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(server.requests[0].path, '/v1/models');
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + KEY);
  } finally { await server.close(); }
});

test('openai-responses + custom header with prefix + manual list: one tiny chat to /responses, no Authorization header', async () => {
  const server = await startMockServer((req, h) => h.json(200, { id: 'r1', object: 'response', status: 'completed', model: 'team-large', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'p' }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
  try {
    const p = make(entryFor(server, { format: 'openai-responses', auth: { type: 'custom', header: 'X-Auth-Token', prefix: 'Token ' }, models: { mode: 'manual', ids: ['team-large'] } }));
    const listed = await p.listModels();
    assert.deepEqual(listed.models.map((m) => m.id), ['team-large']);
    assert.equal(server.requests.length, 0, 'a manual list never calls the server');
    const t = await p.testConnection({ model: 'team-large' });
    assert.equal(t.ok, true, JSON.stringify(t));
    const r = server.requests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/v1/responses');
    assert.equal(r.headers['x-auth-token'], 'Token ' + KEY);
    assert.equal(r.headers.authorization, undefined);
  } finally { await server.close(); }
});

test('openai-chat + x-api-key: the key goes in x-api-key, never in Authorization', async () => {
  const server = await startMockServer((req, h) => h.json(200, chatOk));
  try {
    const p = make(entryFor(server, { auth: { type: 'x-api-key' }, models: { mode: 'manual', ids: ['m'] } }));
    const t = await p.testConnection({ model: 'm' });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(server.requests[0].path, '/v1/chat/completions');
    assert.equal(server.requests[0].headers['x-api-key'], KEY);
    assert.equal(server.requests[0].headers.authorization, undefined);
  } finally { await server.close(); }
});

test('anthropic format: authHeaderMode x-api-key comes from the ENTRY (no constructor option), with anthropic-version', async () => {
  const server = await startMockServer((req, h) => h.json(200, { data: [{ id: 'proxy-model-1', display_name: 'P1' }], has_more: false }));
  try {
    const p = make(entryFor(server, { format: 'anthropic', auth: { type: 'x-api-key' } }, ''));
    const t = await p.testConnection();
    assert.equal(t.ok, true, JSON.stringify(t));
    const r = server.requests[0];
    assert.equal(r.path, '/v1/models');
    assert.equal(r.headers['x-api-key'], KEY);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers['anthropic-version'], bundled.get('anthropic').extraHeaders['anthropic-version']);
  } finally { await server.close(); }
});

test('anthropic format: the bundled entry still defaults to Bearer and still honours the constructor option', async () => {
  const server = await startMockServer((req, h) => h.json(200, { data: [], has_more: false }));
  try {
    const entry = { ...bundled.get('anthropic'), baseURL: server.url };
    await createProvider(entry, { keyProvider: new MemoryKeyProvider({ ANTHROPIC_API_KEY: KEY }), transport: FAST }).testConnection();
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + KEY);
    await createProvider(entry, { keyProvider: new MemoryKeyProvider({ ANTHROPIC_API_KEY: KEY }), transport: FAST, authHeaderMode: 'x-api-key' }).testConnection();
    assert.equal(server.requests[1].headers['x-api-key'], KEY);
  } finally { await server.close(); }
});

test('anthropic format with a manual list: listModels makes no call; Test needs a model, then sends ONE 1-token message', async () => {
  const server = await startMockServer((req, h) => h.json(200, { id: 'msg', type: 'message', role: 'assistant', model: 'proxy-model-1', content: [{ type: 'text', text: 'p' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } }));
  try {
    const p = make(entryFor(server, { format: 'anthropic', auth: { type: 'bearer' }, models: { mode: 'manual', ids: ['proxy-model-1'] } }, ''));
    assert.deepEqual((await p.listModels()).models.map((m) => m.id), ['proxy-model-1']);
    const noModel = await p.testConnection();
    assert.equal(noModel.state, 'needs-model');
    assert.equal(server.requests.length, 0);
    const t = await p.testConnection({ model: 'proxy-model-1' });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, '/v1/messages');
    assert.equal(server.requests[0].body.max_tokens, 1);
    assert.equal(server.requests[0].body.stream, false);
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + KEY);
  } finally { await server.close(); }
});

test('anthropic format, endpoint mode: a proxy without /v1/models falls back to the 1-token message when a model is given', async () => {
  const server = await startMockServer((req, h) => {
    if (req.path === '/v1/models') return h.json(404, { error: { type: 'not_found_error', message: 'no models route' } });
    return h.json(200, { id: 'msg', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    const p = make(entryFor(server, { format: 'anthropic' }, ''));
    const without = await p.testConnection();
    assert.equal(without.state, 'not-found');
    const t = await p.testConnection({ model: 'x' });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.deepEqual(server.requests.map((r) => r.path), ['/v1/models', '/v1/models', '/v1/messages']);
  } finally { await server.close(); }
});

test('an entry with an unknown authHeaderMode is refused at construction (config error, no request)', () => {
  const entry = { ...bundled.get('anthropic'), authHeaderMode: 'cookie' };
  assert.throws(() => createProvider(entry, { keyProvider: new MemoryKeyProvider({}) }), (err) => err instanceof ProviderError && err.code === ERROR_CODES.CONFIG);
});

test('custom-header at runtime: a framing header name or a bad prefix is refused without sending, and the key is never in the message', async () => {
  const server = await startMockServer((req, h) => h.json(200, { data: [] }));
  try {
    const good = entryFor(server, { auth: { type: 'custom', header: 'X-Auth-Token' } });
    for (const customAuth of [{ header: 'host', prefix: '' }, { header: 'X-Ok', prefix: 'a\r\nb' }, { header: 'X-Ok' }, null]) {
      const forged = { ...good, customAuth };
      const t = await make(forged).testConnection();
      assert.equal(t.ok, false, JSON.stringify(customAuth));
      assert.equal(JSON.stringify(t).includes(KEY), false);
    }
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('health() of a keyed custom-header entry without a key is not-configured (no network)', async () => {
  const server = await startMockServer((req, h) => h.json(200, { data: [] }));
  try {
    const e = entryFor(server, { auth: { type: 'custom', header: 'X-Auth-Token' } }, '/v1');
    const remote = { ...e, local: false };
    const h = await createProvider(remote, { keyProvider: new MemoryKeyProvider({}) }).health();
    assert.equal(h.state, 'not-configured');
    assert.match(h.detail, /CUSTOM_MOCK_API_KEY/);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('no redirect is followed: a 302 to another server is an error, the other server is never contacted', async () => {
  const target = await startMockServer((req, h) => h.json(200, { data: [{ id: 'stolen' }] }));
  const server = await startMockServer((req, h) => h.json(302, {}, { location: target.url + '/v1/models' }));
  try {
    const t = await make(entryFor(server)).testConnection();
    assert.equal(t.ok, false);
    assert.equal(target.requests.length, 0, 'the redirect target was contacted');
    assert.equal(server.requests.length, 1);
    assert.equal(JSON.stringify(t).includes(KEY), false);
  } finally { await server.close(); await target.close(); }
});

test('a server that echoes the key back in a 401 never gets it into the result', async () => {
  const server = await startMockServer((req, h) => h.json(401, { error: { message: 'bad key ' + req.headers.authorization } }));
  try {
    const t = await make(entryFor(server)).testConnection();
    assert.equal(t.state, 'auth-failed');
    assert.equal(JSON.stringify(t).includes(KEY), false);
  } finally { await server.close(); }
});
