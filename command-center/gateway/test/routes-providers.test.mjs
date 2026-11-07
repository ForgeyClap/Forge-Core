// WP B2 part 2: routes/providers.mjs against a hand-built registry, an in-process mock provider server
// (providers/testing/mock-http-server.mjs) and fake CLI detectors. NOT live: no real provider, CLI or
// key is used. The routes are mounted here with the same (method, path, handler) rows the Lead adds to
// server.mjs from _scratch/b2/patches-gw.md.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';
import { createProviderHub } from '../src/providers/provider-hub.mjs';
import { GatewayKeyStore } from '../src/providers/key-provider.mjs';
import { createProvider, RegistryError, sharedRedactor } from '../src/providers/index.mjs';
import { buildModelsView, _setProviderHubForTests } from '../src/models.mjs';
import * as providers from '../src/routes/providers.mjs';

const PLANTED = 'sk-forge-ROUTES-planted-0123456789abcdefK3y4';
const PLANTED_BAD = 'sk-forge-ROUTES-badkey-0123456789abcdefB4d5';

const ROUTES = [
  ['GET', '/api/providers', 'list'],
  ['GET', '/api/providers/keys', 'keys'],
  ['POST', providers.KEYS_RELOAD_PATH, 'keysReload'],
  ['POST', providers.PROVIDER_TEST_RE, 'test'],
  ['GET', providers.PROVIDER_LOGIN_HINT_RE, 'loginHint'],
];

let mock;
let gw;
let port;
let factoryCalls;
let nvidiaCalls;

function entry(over) {
  return {
    adapter: 'openai-compatible', apiStyle: 'chat-completions', authType: 'bearer', extraHeaders: {},
    modelsMode: 'endpoint', modelsEndpoint: '/models', testCall: 'models', streaming: true, toolCalling: true,
    local: false, subscription: false, noticeRequired: false, tosNote: null, docsURL: 'https://example.invalid/docs',
    verifiedOn: '2026-11-01', verification: 'verified', ...over,
  };
}

function cli(id, adapter, label, command, tos) {
  return entry({
    id, label, adapter, apiStyle: null, baseURL: null, authType: 'cli-managed', keyEnvName: null, modelsMode: 'static',
    modelsEndpoint: null, staticModels: id === 'claude-code-cli' ? ['sonnet', 'opus'] : [], testCall: 'cli-version',
    toolCalling: 'internal', subscription: true, noticeRequired: true, tosNote: tos, command,
  });
}

function buildRegistry(url) {
  const list = [
    entry({ id: 'mock-ai', label: 'Mock AI', baseURL: url + '/v1', keyEnvName: 'MOCKAI_API_KEY' }),
    entry({ id: 'mock-bad', label: 'Mock Bad', baseURL: url + '/bad/v1', keyEnvName: 'MOCKBAD_API_KEY' }),
    entry({ id: 'mock-nokey', label: 'Mock No Key', baseURL: url + '/nokey/v1', keyEnvName: 'MOCKNOKEY_API_KEY' }),
    entry({ id: 'mock-local', label: 'Mock Local', baseURL: url + '/local/v1', authType: 'none', keyEnvName: null, local: true }),
    entry({ id: 'mock-local-down', label: 'Mock Local Down', baseURL: 'http://127.0.0.1:1/v1', authType: 'none', keyEnvName: null, local: true }),
    entry({ id: 'nvidia-nim', label: 'NVIDIA NIM', baseURL: url + '/nvidia/v1', keyEnvName: 'NVIDIA_API_KEY' }),
    cli('claude-code-cli', 'cli-claude', 'Claude Code (your own sign-in)', 'claude', 'Forge only starts the unmodified claude program.'),
    cli('codex-cli', 'cli-codex', 'Codex (your own sign-in)', 'codex', 'Forge only starts the unmodified codex program.'),
    cli('gemini-cli', 'cli-generic', 'Gemini CLI (not recommended)', 'gemini', 'Reusing Gemini CLI OAuth tokens is forbidden.'),
  ];
  const byId = new Map(list.map((e) => [e.id, Object.freeze(e)]));
  return { schema: 1, providers: [...byId.values()], get: (id) => byId.get(id) || null, ids: () => [...byId.keys()] };
}

const DETECT = {
  'claude-code-cli': async () => ({ installed: true, state: 'connected', detail: 'signed in (claude.ai)', version: '2.1.316', streamReady: true, capabilities: {} }),
  'codex-cli': async () => ({ installed: false, state: 'not-installed', detail: 'codex was not found on PATH' }),
  'gemini-cli': async () => ({ installed: false, state: 'not-installed', detail: 'gemini was not found on PATH' }),
};

function makeHub(overrides = {}) {
  const keyStore = new GatewayKeyStore({ env: { FORGE_KEY_MOCKAI_API_KEY: PLANTED, FORGE_KEY_MOCKBAD_API_KEY: PLANTED_BAD, FORGE_KEYS_FROM_VAULT: '1' }, redactor: sharedRedactor });
  return createProviderHub({
    registry: buildRegistry(mock.url), keyStore,
    providerFactory: (e, opts) => { factoryCalls.push(e.id); return createProvider(e, { ...opts, detect: DETECT[e.id] }); },
    nvidiaProbe: async ({ fresh }) => { nvidiaCalls.push(fresh); return { state: 'NOT CONFIGURED', note: 'NVIDIA MOCK MODE (no key — NOT live-ready)' }; },
    isOllamaInstalled: async () => true,
    ...overrides,
  });
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep text */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const providerPaths = () => mock.requests.filter((r) => !r.path.startsWith('/local/'));

// buildModelsView() also runs the REAL nvidia-provider.cjs probe for its `nvidia` field: keep it hermetic
// (no key, no dotenv files) exactly like models.test.mjs does, so this file never calls NVIDIA.
const HERMETIC = { NVIDIA_API_KEY: '', NVIDIA_SKIP_ENV_FILES: '1' };
let savedEnv;

before(async () => {
  savedEnv = Object.fromEntries(Object.keys(HERMETIC).map((k) => [k, process.env[k]]));
  Object.assign(process.env, HERMETIC);
  mock = await startMockServer((req, h) => {
    if (req.path === '/v1/models') {
      if (req.headers.authorization !== 'Bearer ' + PLANTED) return h.json(401, { error: { message: 'bad key' } });
      return h.json(200, { object: 'list', data: [{ id: 'mock-small', owned_by: 'mock', context_length: 8192 }, { id: 'mock-large' }] });
    }
    // A misbehaving server that echoes the key back: the response must still never carry it.
    if (req.path === '/bad/v1/models') return h.json(401, { error: { message: 'invalid api key ' + req.headers.authorization } });
    if (req.path === '/local/v1/models') return h.json(200, { data: [{ id: 'local-tiny' }] });
    return h.json(404, { error: { message: 'no route' } });
  });
  gw = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    for (const [method, path, handler] of ROUTES) {
      if (method !== req.method) continue;
      const match = typeof path === 'string' ? (path === url.pathname ? [] : null) : url.pathname.match(path);
      if (match) return providers[handler](req, res, { pathname: url.pathname, searchParams: url.searchParams, match });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  port = gw.address().port;
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setProviderHubForTests(null);
  await new Promise((r) => gw.close(r));
  await mock.close();
});

beforeEach(() => {
  factoryCalls = [];
  nvidiaCalls = [];
  mock.requests.length = 0;
  _setProviderHubForTests(makeHub());
});

test('isProvidersWriteRoute matches exactly the two POST routes', () => {
  assert.equal(providers.isProvidersWriteRoute('/api/providers/keys/reload'), true);
  assert.equal(providers.isProvidersWriteRoute('/api/providers/groq/test'), true);
  for (const p of ['/api/providers', '/api/providers/keys', '/api/providers/groq/login-hint', '/api/providers/Groq/test', '/api/providers/a/b/test', '/api/providers/../test', '/api/providers/groq/test/x']) {
    assert.equal(providers.isProvidersWriteRoute(p), false, p);
  }
});

test('GET /api/providers: status words, who pays, ToS date, and NO call to a remote provider', async () => {
  const res = await request('GET', '/api/providers');
  assert.equal(res.status, 200);
  const row = Object.fromEntries(res.json.providers.map((p) => [p.id, p]));
  assert.equal(row['mock-ai'].status, 'niet verbonden');
  assert.equal(row['mock-ai'].tested, false);
  assert.equal(row['mock-ai'].key_present, true);
  assert.equal(row['mock-ai'].key_source, 'vault');
  assert.equal(row['mock-ai'].who_pays.code, 'api-key');
  assert.equal(row['mock-ai'].price_band, 'pay-per-use');
  assert.equal(row['mock-nokey'].status, 'geen sleutel');
  assert.equal(row['mock-nokey'].status_code, 'no-key');
  assert.equal(row['mock-local'].status, 'verbonden');
  assert.equal(row['mock-local'].who_pays.code, 'free-local');
  assert.equal(row['mock-local'].live, true);
  assert.equal(row['mock-local-down'].status, 'niet verbonden');
  assert.equal(row['claude-code-cli'].status, 'verbonden');
  assert.equal(row['claude-code-cli'].version, '2.1.316');
  assert.equal(row['claude-code-cli'].who_pays.code, 'subscription');
  assert.deepEqual(row['claude-code-cli'].tos, { required: true, note: 'Forge only starts the unmodified claude program.', checked_on: '2026-11-01' });
  assert.equal(row['codex-cli'].status, 'niet geinstalleerd');
  assert.equal(row['nvidia-nim'].status, 'geen sleutel', 'the NVIDIA probe (not the registry adapter) decides nvidia-nim');
  assert.deepEqual(nvidiaCalls, [false]);
  assert.equal(res.json.tos_checked_on, '2026-11-01');
  assert.deepEqual(res.json.vault, { from_app: true, captured: 2, source_order: ['vault', 'env'] });
  assert.deepEqual(res.json.counts, { total: 9, connected: 2, not_connected: 3, no_key: 2, not_installed: 2, error: 0 });
  assert.deepEqual(providerPaths(), [], 'GET made an outbound call to a remote provider');
  assert.ok(!res.text.includes(PLANTED) && !res.text.includes(PLANTED_BAD));
});

test('POST /api/providers/:id/test: lists models with the vault key, row becomes verbonden, /api/models lists the models', async () => {
  const res = await request('POST', '/api/providers/mock-ai/test', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.result.ok, true);
  assert.equal(res.json.result.status, 'verbonden');
  assert.equal(res.json.result.models_count, 2);
  assert.equal(res.json.row.status, 'verbonden');
  assert.equal(res.json.row.tested, true);
  assert.equal(res.json.live, true);
  const sent = mock.requests.find((r) => r.path === '/v1/models');
  assert.equal(sent.headers.authorization, 'Bearer ' + PLANTED, 'the vault key was used for the call');
  assert.ok(!res.text.includes(PLANTED), 'the key is not in the response');
  const view = await buildModelsView();
  const m = view.providers.list.find((p) => p.id === 'mock-ai');
  assert.equal(view.providers.available, true);
  assert.equal(m.models_source, 'test-cache');
  assert.deepEqual(m.models, [{ id: 'mock-small', context_length: 8192, size_bytes: null }, { id: 'mock-large', context_length: null, size_bytes: null }]);
  assert.equal(view.providers.list.find((p) => p.id === 'mock-local').models[0].id, 'local-tiny');
  assert.ok(!view.providers.list.some((p) => p.id === 'mock-nokey' || p.id === 'codex-cli'), 'unconfigured providers are not listed');
  assert.ok(['CONNECTED', 'DISCONNECTED', 'NOT CONFIGURED', 'OFF', 'UNKNOWN'].includes(view.nvidia.state), 'the existing nvidia field is unchanged');
});

test('POST test with a refused key: fout / auth-failed, and a server that echoes the key cannot leak it', async () => {
  const res = await request('POST', '/api/providers/mock-bad/test');
  assert.equal(res.status, 200);
  assert.equal(res.json.result.ok, false);
  assert.equal(res.json.result.status, 'fout');
  assert.equal(res.json.result.state, 'auth-failed');
  assert.equal(res.json.result.http_status, 401);
  assert.ok(!res.text.includes(PLANTED_BAD), 'echoed key leaked: ' + res.text);
  assert.equal(res.json.row.status, 'fout');
});

test('POST test without a key: geen sleutel, and nothing is sent', async () => {
  const res = await request('POST', '/api/providers/mock-nokey/test', {});
  assert.equal(res.json.result.status, 'geen sleutel');
  assert.deepEqual(providerPaths(), []);
});

test('POST nvidia-nim test uses ONLY the NVIDIA probe, fresh', async () => {
  const res = await request('POST', '/api/providers/nvidia-nim/test', {});
  assert.equal(res.status, 200);
  assert.equal(nvidiaCalls[0], true, 'the Test button forces a fresh NVIDIA probe');
  assert.ok(!factoryCalls.includes('nvidia-nim'), 'the registry adapter must not run for nvidia-nim');
  assert.deepEqual(providerPaths(), []);
});

test('two concurrent tests of one provider share ONE outbound call', async () => {
  const [a, b] = await Promise.all([request('POST', '/api/providers/mock-ai/test', {}), request('POST', '/api/providers/mock-ai/test', {})]);
  assert.equal(a.json.result.ok, true);
  assert.equal(b.json.result.ok, true);
  assert.equal(mock.requests.filter((r) => r.path === '/v1/models').length, 1);
});

test('POST test input validation: unknown id 404, bad model 400, unknown field 400, non-JSON 400 without echo, oversize 413', async () => {
  assert.equal((await request('POST', '/api/providers/nope/test', {})).status, 404);
  assert.equal((await request('POST', '/api/providers/mock-ai/test', { model: 'a b' })).status, 400);
  assert.equal((await request('POST', '/api/providers/mock-ai/test', { model: 7 })).status, 400);
  const unknown = await request('POST', '/api/providers/mock-ai/test', { apiKey: PLANTED });
  assert.equal(unknown.status, 400);
  assert.ok(!unknown.text.includes(PLANTED));
  const raw = await request('POST', '/api/providers/mock-ai/test', PLANTED + ' not json');
  assert.equal(raw.status, 400);
  assert.ok(!raw.text.includes('not json') && !raw.text.includes(PLANTED), 'the parser message must not echo the body');
  // Node's JSON.parse message quotes a SHORT input whole (a pasted short key would come back).
  const short = await request('POST', '/api/providers/mock-ai/test', 'pasted-k3y');
  assert.equal(short.status, 400);
  assert.deepEqual(short.json, { ok: false, error: 'request body is not valid JSON' });
  assert.ok(!short.text.includes('pasted-k3y'));
  assert.equal((await request('POST', '/api/providers/mock-ai/test', { model: 'x'.repeat(5000) })).status, 413);
  assert.deepEqual(providerPaths(), [], 'a rejected request never reaches the provider');
});

test('GET /api/providers/keys: status, source and last4 only, never the value', async () => {
  const res = await request('GET', '/api/providers/keys');
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.keys.map((k) => [k.provider_id, k]));
  assert.deepEqual(byId['mock-ai'], { provider_id: 'mock-ai', key_env_name: 'MOCKAI_API_KEY', present: true, source: 'vault', last4: PLANTED.slice(-4), extra: [] });
  assert.equal(byId['mock-nokey'].present, false);
  assert.equal(byId['mock-nokey'].last4, null);
  assert.ok(!('claude-code-cli' in byId), 'subscriptions have no key');
  assert.ok(!res.text.includes(PLANTED) && !res.text.includes(PLANTED_BAD));
});

test('POST /api/providers/keys/reload: {} re-scans; key material is refused without echo; non-loopback peer 403', async () => {
  const ok = await request('POST', providers.KEYS_RELOAD_PATH, {});
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.reloaded, { vault_captured: 2, vault_new: 0 });
  const empty = await request('POST', providers.KEYS_RELOAD_PATH);
  assert.equal(empty.status, 200);
  const withKey = await request('POST', providers.KEYS_RELOAD_PATH, { keys: { OPENAI_API_KEY: PLANTED } });
  assert.equal(withKey.status, 400);
  assert.match(withKey.json.error, /never accepted over HTTP/);
  assert.ok(!withKey.text.includes(PLANTED));
  let status = null;
  let body = null;
  const fakeRes = { writeHead: (s) => { status = s; }, end: (b) => { body = b; } };
  await providers.keysReload({ socket: { remoteAddress: '10.0.0.5' } }, fakeRes);
  assert.equal(status, 403);
  assert.match(body, /only accepted from this PC/);
});

test('GET /api/providers/:id/login-hint: the official CLI command only; the gateway never runs it', async () => {
  const claude = (await request('GET', '/api/providers/claude-code-cli/login-hint')).json;
  assert.equal(claude.kind, 'cli-login');
  assert.equal(claude.command, 'claude auth login');
  assert.equal(claude.status_command, 'claude auth status --json');
  assert.equal(claude.gateway_runs_it, false);
  const codex = (await request('GET', '/api/providers/codex-cli/login-hint')).json;
  assert.equal(codex.command, 'codex login');
  const key = (await request('GET', '/api/providers/mock-ai/login-hint')).json;
  assert.equal(key.kind, 'api-key');
  assert.equal(key.key_env_name, 'MOCKAI_API_KEY');
  assert.equal(key.command, null);
  assert.equal((await request('GET', '/api/providers/gemini-cli/login-hint')).json.kind, 'not-supported');
  assert.equal((await request('GET', '/api/providers/mock-local/login-hint')).json.kind, 'none');
  assert.equal((await request('GET', '/api/providers/nope/login-hint')).status, 404);
});

test('an invalid registry answers 503 with the problems, on every route', async () => {
  const keyStore = new GatewayKeyStore({ env: {}, redactor: sharedRedactor });
  _setProviderHubForTests(createProviderHub({ keyStore, loadRegistryFn: () => { throw new RegistryError(['providers[0] id=x: duplicate id']); } }));
  for (const [method, path] of [['GET', '/api/providers'], ['GET', '/api/providers/keys'], ['POST', '/api/providers/x/test'], ['GET', '/api/providers/x/login-hint'], ['POST', providers.KEYS_RELOAD_PATH]]) {
    const res = await request(method, path, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 503, method + ' ' + path);
    assert.deepEqual(res.json.problems, ['providers[0] id=x: duplicate id']);
  }
});

test('NEVER-LOG GUARD: driving every route writes no log line containing a planted key', async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  process.stdout.write = (c, ...r) => { lines.push(String(c)); return origOut(c, ...r); };
  process.stderr.write = (c, ...r) => { lines.push(String(c)); return origErr(c, ...r); };
  const bodies = [];
  try {
    for (const [m, p, b] of [
      ['GET', '/api/providers'], ['GET', '/api/providers?fresh=1'], ['POST', '/api/providers/mock-ai/test', {}], ['POST', '/api/providers/mock-bad/test', {}],
      ['POST', '/api/providers/mock-ai/test', { model: 'mock-small' }], ['GET', '/api/providers/keys'], ['POST', providers.KEYS_RELOAD_PATH, {}],
      ['POST', providers.KEYS_RELOAD_PATH, { keys: { A: PLANTED } }], ['GET', '/api/providers/mock-ai/login-hint'],
    ]) bodies.push((await request(m, p, b)).text);
    bodies.push(JSON.stringify(await buildModelsView()));
  } finally {
    Object.assign(console, orig);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const all = bodies.join('\n') + '\n' + lines.join('\n');
  assert.ok(!all.includes(PLANTED), 'planted vault key leaked');
  assert.ok(!all.includes(PLANTED_BAD), 'planted bad key leaked');
});
