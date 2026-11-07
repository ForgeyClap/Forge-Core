// "Eigen API" (ANY-MODEL-PLAN 2.2 A/C): the provider hub on the MERGED registry. A custom entry
// added, changed or removed while the gateway runs is picked up without a restart, its cached status, test
// result and model list never outlive the entry they belong to, the saved address is re-checked before the
// outbound Test, and models.mjs builds the production hub this way (proven in a child process with its own
// FORGE_DATA_DIR and a planted vault key, which must be scrubbed from the environment).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProviderHub } from '../src/providers/provider-hub.mjs';
import { GatewayKeyStore } from '../src/providers/key-provider.mjs';
import { Redactor, loadRegistry } from '../src/providers/index.mjs';
import { loadMergedRegistry, verifyCustomTarget, _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';
import {
  createCustomProvider, updateCustomProvider, deleteCustomProvider, customProvidersFile, readCustomProviders, _setCustomProvidersDirForTests,
} from '../src/providers/custom-store.mjs';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'providers-custom');
const MODELS_URL = pathToFileURL(path.join(HERE, '..', 'src', 'models.mjs')).href;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const BUNDLED_COUNT = loadRegistry().ids().length;
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-hub-'));
  _setCustomProvidersDirForTests(dir);
  _resetMergedRegistryCacheForTests();
});
afterEach(() => {
  _setCustomProvidersDirForTests(null);
  _resetMergedRegistryCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function hub({ env = {}, verifyTarget = verifyCustomTarget, probes = false } = {}) {
  return createProviderHub({
    loadRegistryFn: () => loadMergedRegistry(), dynamicRegistry: true, verifyTarget,
    keyStore: new GatewayKeyStore({ env, scrub: false, redactor: new Redactor() }), probeCliAndLocal: probes,
    statusTtlMs: 60_000,
  });
}
function rev() { return readCustomProviders().doc.revision; }
function add(over) {
  const r = createCustomProvider({ label: 'Thuis', format: 'openai-chat', baseURL: 'https://llm.example.com/v1', auth: { type: 'bearer' }, models: { mode: 'endpoint' }, ...over }, { expectRevision: rev(), now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.provider;
}
const rowsById = async (h) => Object.fromEntries((await h.listProviders()).providers.map((p) => [p.id, p]));

test('custom rows appear next to the bundled ones, marked source custom with their warnings', async () => {
  fs.copyFileSync(path.join(FIXTURES, 'valid.json'), customProvidersFile());
  const h = hub();
  const r = await h.listProviders();
  assert.equal(r.ok, true);
  assert.equal(r.providers.length, BUNDLED_COUNT + 2);
  const rows = Object.fromEntries(r.providers.map((p) => [p.id, p]));
  assert.equal(rows['custom-mijn-vllm'].source, 'custom');
  assert.deepEqual(rows['custom-mijn-vllm'].warnings, ['http_lan']);
  assert.equal(rows.openai.source, 'bundled');
  assert.deepEqual(rows.openai.warnings, []);
  assert.equal(rows['custom-claude-proxy'], undefined, 'a disabled entry is not a provider');
  assert.equal(h.hasProvider('custom-team-gateway'), true);
});

test('a keyed custom-header entry without a key reads "geen sleutel", pays per use, and makes no call', async () => {
  add({ label: 'Team', auth: { type: 'custom', header: 'X-Auth-Token' } });
  const rows = await rowsById(hub());
  const row = rows['custom-team'];
  assert.equal(row.status, 'geen sleutel');
  assert.equal(row.key_name, 'CUSTOM_TEAM_API_KEY');
  assert.equal(row.key_present, false);
  assert.equal(row.who_pays.code, 'api-key');
  assert.equal(row.price_band, 'pay-per-use');
  assert.equal(row.login.kind, 'api-key');
  assert.equal(row.live, false);
});

test('a keyless remote custom entry is "not tested yet" without claiming a key was found', async () => {
  add({ label: 'Open', auth: { type: 'none' } });
  const row = (await rowsById(hub()))['custom-open'];
  assert.equal(row.status, 'niet verbonden');
  assert.equal(/key/i.test(row.detail), false, row.detail);
});

test('the vault key (FORGE_KEY_CUSTOM_*) is found for the derived name', async () => {
  add({ label: 'Thuis' });
  const keys = await hub({ env: { FORGE_KEY_CUSTOM_THUIS_API_KEY: 'vault-value-' + 'v'.repeat(20) } }).keyStatuses();
  const k = keys.keys.find((x) => x.provider_id === 'custom-thuis');
  assert.deepEqual({ name: k.key_env_name, present: k.present, source: k.source }, { name: 'CUSTOM_THUIS_API_KEY', present: true, source: 'vault' });
});

test('entries added, changed and removed while running are picked up; a cached Test never outlives its address', async () => {
  const good = await startMockServer((req, h) => h.json(200, { data: [{ id: 'model-a' }] }));
  const other = await startMockServer((req, h) => h.json(401, { error: { message: 'no' } }));
  try {
    // probes on: a loopback entry's status is a live probe that is cached for 60 s (stale-while-revalidate)
    const h = hub({ env: { CUSTOM_THUIS_API_KEY: 'plain-env-value-' + 'p'.repeat(20) }, probes: true });
    assert.equal(h.hasProvider('custom-thuis'), false);
    const p = add({ label: 'Thuis', baseURL: good.url + '/v1' });
    assert.equal(h.hasProvider('custom-thuis'), true, 'added without a restart');
    assert.equal((await h.providerRow('custom-thuis')).status, 'verbonden');
    const t1 = await h.testProvider('custom-thuis');
    assert.equal(t1.result.status, 'verbonden');
    const u = updateCustomProvider(p.id, { label: 'Thuis', format: 'openai-chat', baseURL: other.url + '/v1', auth: { type: 'bearer' }, models: { mode: 'endpoint' } }, { expectRevision: rev(), now: NOW });
    assert.equal(u.ok, true);
    const goodCalls = good.requests.length;
    const row = await h.providerRow('custom-thuis');
    assert.notEqual(row.status, 'verbonden', 'the cached status of the old address was reused for the new one');
    const t2 = await h.testProvider('custom-thuis');
    assert.equal(t2.result.state, 'auth-failed');
    assert.ok(other.requests.length >= 2, 'the new address was probed and tested');
    assert.equal(good.requests.length, goodCalls, 'the old address was contacted after the change');
    deleteCustomProvider(p.id, { expectRevision: rev(), now: NOW });
    assert.equal(h.hasProvider('custom-thuis'), false);
    assert.equal(await h.providerRow('custom-thuis'), null);
  } finally { await good.close(); await other.close(); }
});

test('a Test still running for the old address is not joined by a Test for the changed entry', async () => {
  const slow = await startMockServer(async (req, h) => { await h.delay(400); return h.json(200, { data: [{ id: 'old' }] }); });
  const fresh = await startMockServer((req, h) => h.json(401, { error: { message: 'no' } }));
  try {
    const h = hub({ env: { CUSTOM_THUIS_API_KEY: 'plain-env-value-' + 'p'.repeat(20) } });
    const p = add({ label: 'Thuis', baseURL: slow.url + '/v1' });
    const first = h.testProvider('custom-thuis');
    await new Promise((r) => setTimeout(r, 50));
    updateCustomProvider(p.id, { label: 'Thuis', format: 'openai-chat', baseURL: fresh.url + '/v1', auth: { type: 'bearer' }, models: { mode: 'endpoint' } }, { expectRevision: rev(), now: NOW });
    const second = await h.testProvider('custom-thuis');
    assert.equal(second.result.state, 'auth-failed', 'the second Test returned the old address result');
    assert.equal(fresh.requests.length, 1);
    assert.equal((await first).result.state, 'connected');
    const row = await h.providerRow('custom-thuis');
    assert.notEqual(row.status, 'verbonden', 'the old Test wrote its result into the new entry');
    assert.equal(h.customState().revision, rev());
  } finally { await slow.close(); await fresh.close(); }
});

test('a slow Test of the old address that ends last never becomes the status of the changed (remote, keyed) entry', async () => {
  // A fake adapter per address (no network): the old address answers after 300 ms, the new one at once.
  const factory = (entry) => ({
    async listModels() {
      if (entry.baseURL.includes('slow')) { await new Promise((r) => setTimeout(r, 300)); return { models: [{ id: 'old' }], source: 'endpoint' }; }
      throw Object.assign(new Error('HTTP 401 from fresh.example.com'), { code: 'AUTH', status: 401 });
    },
    async health() { return { ok: true, state: 'configured', network: false }; },
  });
  const h = createProviderHub({
    loadRegistryFn: () => loadMergedRegistry(), dynamicRegistry: true, verifyTarget: verifyCustomTarget, providerFactory: factory,
    keyStore: new GatewayKeyStore({ env: { CUSTOM_THUIS_API_KEY: 'plain-env-value-' + 'p'.repeat(20) }, scrub: false, redactor: new Redactor() }), probeCliAndLocal: false,
  });
  const p = add({ label: 'Thuis', baseURL: 'https://slow.example.com/v1' });
  const first = h.testProvider('custom-thuis');
  await new Promise((r) => setTimeout(r, 30));
  updateCustomProvider(p.id, { label: 'Thuis', format: 'openai-chat', baseURL: 'https://fresh.example.com/v1', auth: { type: 'bearer' }, models: { mode: 'endpoint' } }, { expectRevision: rev(), now: NOW });
  const second = await h.testProvider('custom-thuis');
  assert.equal(second.result.state, 'auth-failed');
  assert.equal((await first).result.state, 'connected');
  const row = await h.providerRow('custom-thuis');
  assert.equal(row.status, 'fout', 'the old address result (connected) overwrote the new one');
});

test('a fixed registry whose get() hands out copies still caches status (old behaviour unchanged)', async () => {
  const base = loadRegistry();
  const copying = { schema: 1, providers: base.providers, get: (id) => (base.get(id) ? { ...base.get(id) } : null), ids: () => base.ids() };
  let probes = 0;
  let tick = Date.parse('2026-11-02T12:00:00.000Z');
  const h = createProviderHub({
    registry: copying, keyStore: new GatewayKeyStore({ env: {}, scrub: false, redactor: new Redactor() }), probeCliAndLocal: false,
    now: () => (tick += 1000), // every probe gets its own time, so a second probe is visible in checked_at
    providerFactory: () => ({ async health() { probes += 1; return { ok: false, state: 'not-configured', network: false, detail: 'no key' }; } }),
  });
  await h.providerRow('openai');
  await h.providerRow('openai');
  assert.equal(probes, 0, 'openai without a key needs no probe at all');
  const row1 = await h.providerRow('groq');
  const row2 = await h.providerRow('groq');
  assert.equal(row1.checked_at, row2.checked_at, 'the second call was not served from the status cache');
});

test('the saved address is re-checked before the outbound Test; a refusal sends nothing', async () => {
  const server = await startMockServer((req, h) => h.json(200, { data: [] }));
  try {
    add({ label: 'Thuis', baseURL: server.url + '/v1', auth: { type: 'none' } });
    const h = hub({ verifyTarget: () => ({ ok: false, code: 'target_changed', nl: 'Het adres is gewijzigd.', en: 'The address changed.' }) });
    const t = await h.testProvider('custom-thuis');
    assert.equal(t.result.ok, false);
    assert.equal(t.result.status, 'fout');
    assert.match(t.result.detail, /address changed/);
    assert.equal(server.requests.length, 0);
    const ok = await hub().testProvider('custom-thuis');
    assert.equal(ok.result.ok, true);
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test('a damaged overlay keeps the hub up: bundled rows answer, registryState reports the overlay problem', async () => {
  fs.copyFileSync(path.join(FIXTURES, 'damaged.json'), customProvidersFile());
  const h = hub();
  const s = h.registryState();
  assert.equal(s.ok, true);
  assert.equal(s.custom.provenance, 'UNREADABLE');
  assert.ok(s.custom.problems.length > 0);
  assert.equal((await h.listProviders()).providers.length, BUNDLED_COUNT);
});

test('a hub with a fixed registry keeps the old behaviour (no reload, no custom fields needed)', async () => {
  const h = createProviderHub({ registry: loadRegistry(), keyStore: new GatewayKeyStore({ env: {}, scrub: false, redactor: new Redactor() }), probeCliAndLocal: false });
  add({ label: 'Thuis' });
  assert.equal(h.hasProvider('custom-thuis'), false);
  assert.equal((await h.listProviders()).providers.length, BUNDLED_COUNT);
});

test('models.mjs: the production hub runs on the merged registry and the vault scrub covers CUSTOM_* keys', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-models-'));
  try {
    fs.mkdirSync(path.join(dataDir, 'providers'));
    fs.copyFileSync(path.join(FIXTURES, 'valid.json'), path.join(dataDir, 'providers', 'custom.json'));
    const script = [
      "const models = await import(" + JSON.stringify(MODELS_URL) + ");",
      "const { execFileSync } = await import('node:child_process');",
      "const left = Object.keys(process.env).filter((k) => /^FORGE_KEY_/i.test(k)).length;",
      "const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Object.keys(process.env).filter((k) => /^FORGE_KEY_/i.test(k)).length))'], { encoding: 'utf8' });",
      "const hub = models.getProviderHub();",
      "const list = await hub.listProviders();",
      "const keys = await hub.keyStatuses();",
      "const k = keys.keys.find((x) => x.provider_id === 'custom-mijn-vllm');",
      "process.stdout.write(JSON.stringify({ left, seen, custom: list.providers.filter((p) => p.source === 'custom').map((p) => p.id), key: { present: k.present, source: k.source } }));",
    ].join('\n');
    const env = { ...process.env, FORGE_DATA_DIR: dataDir, NODE_TEST_CONTEXT: 'child-v8', FORGE_LIVE: '', FORGE_KEYS_FROM_VAULT: '1', FORGE_KEY_CUSTOM_MIJN_VLLM_API_KEY: 'planted-vault-' + 'q'.repeat(24), NVIDIA_SKIP_ENV_FILES: '1' };
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 60_000 }));
    assert.equal(out.left, 0, 'a FORGE_KEY_* variable is still in the gateway env');
    assert.equal(out.seen, '0', 'a child inherited a vault key');
    assert.deepEqual(out.custom, ['custom-mijn-vllm', 'custom-team-gateway']);
    assert.deepEqual(out.key, { present: true, source: 'vault' });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('models.mjs: the production hub picks up a new entry live and re-checks the saved address before the Test', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-models-live-'));
  const STORE_URL = pathToFileURL(path.join(HERE, '..', 'src', 'providers', 'custom-store.mjs')).href;
  try {
    // The read seam: node:fs's default export is the object custom-store calls, so a patched readFileSync
    // makes the SAVED file say another port than the entry the hub holds in memory (an outside edit the
    // store stamp did not see). Ports 18081/18082: nothing is expected to listen; a refusal sends nothing.
    const script = [
      "const fsm = (await import('node:fs')).default;",
      "const models = await import(" + JSON.stringify(MODELS_URL) + ");",
      "const store = await import(" + JSON.stringify(STORE_URL) + ");",
      "const hub = models.getProviderHub();",
      "const before = hub.hasProvider('custom-thuis');",
      "const c = store.createCustomProvider({ label: 'Thuis', format: 'openai-chat', baseURL: 'http://127.0.0.1:18081/v1', auth: { type: 'none' }, models: { mode: 'endpoint' } }, { expectRevision: 0 });",
      "const after = hub.hasProvider('custom-thuis');",
      "const real = fsm.readFileSync;",
      "fsm.readFileSync = function (p, ...rest) { const out = real.call(fsm, p, ...rest); return String(p).endsWith('custom.json') ? String(out).replace(':18081/', ':18082/') : out; };",
      "const t = await hub.testProvider('custom-thuis');",
      "fsm.readFileSync = real;",
      "process.stdout.write(JSON.stringify({ before, after, created: c.ok, state: t.result.state, detail: t.result.detail }));",
    ].join('\n');
    const env = { ...process.env, FORGE_DATA_DIR: dataDir, NODE_TEST_CONTEXT: 'child-v8', FORGE_LIVE: '', NVIDIA_SKIP_ENV_FILES: '1' };
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 60_000 }));
    assert.equal(out.created, true);
    assert.equal(out.before, false);
    assert.equal(out.after, true, 'a new entry needed a gateway restart');
    assert.equal(out.state, 'error');
    assert.match(out.detail, /address of this own API changed/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
