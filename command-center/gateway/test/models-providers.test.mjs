// WP B2 part 2: the provider hub over the REAL registry.json (35 providers) and the new `providers`
// block of GET /api/models. NOT live: CLI detection is faked, Ollama is the in-process mock server, the
// NVIDIA probe is a fake (and the real nvidia probe that buildModelsView() runs is kept hermetic).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';
import { createProviderHub } from '../src/providers/provider-hub.mjs';
import { GatewayKeyStore } from '../src/providers/key-provider.mjs';
import { createProvider, loadRegistry, Redactor } from '../src/providers/index.mjs';
import { STATUS_WORDS } from '../src/providers/provider-status.mjs';
import { buildModelsView, _setProviderHubForTests, _resetNvidiaHealthCacheForTests } from '../src/models.mjs';

const HERMETIC = { NVIDIA_API_KEY: '', NVIDIA_SKIP_ENV_FILES: '1' };
let savedEnv;
let ollama;
let closedPort;

before(async () => {
  savedEnv = Object.fromEntries(Object.keys(HERMETIC).map((k) => [k, process.env[k]]));
  Object.assign(process.env, HERMETIC);
  const spare = net.createServer();
  await new Promise((r) => spare.listen(0, '127.0.0.1', r));
  closedPort = String(spare.address().port);
  await new Promise((r) => spare.close(r));
  ollama = await startMockServer((req, h) => {
    if (req.path === '/api/version') return h.json(200, { version: '0.40.13' });
    if (req.path === '/api/tags') return h.json(200, { models: [{ name: 'qwen2.5:0.5b', size: 397821319, details: { family: 'qwen2', parameter_size: '494.03M', quantization_level: 'Q4_K_M' } }] });
    return h.json(404, {});
  });
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setProviderHubForTests(null);
  _resetNvidiaHealthCacheForTests();
  await ollama.close();
});

const DETECT = {
  'claude-code-cli': async () => ({ installed: true, state: 'connected', detail: 'signed in (claude.ai)', version: '2.1.316', streamReady: true, capabilities: {} }),
  'codex-cli': async () => ({ installed: true, state: 'not-connected', detail: 'codex is installed but not signed in: run `codex login` yourself' }),
  'gemini-cli': async () => ({ installed: false, state: 'not-installed', detail: 'gemini was not found on PATH' }),
  'grok-build-cli': async () => ({ installed: false, state: 'not-installed', detail: 'grok was not found on PATH' }),
};

function realHub({ env = {}, nvidia = null, cliAndLocal = true } = {}) {
  const calls = [];
  const hub = createProviderHub({
    registry: loadRegistry(),
    keyStore: new GatewayKeyStore({ env, redactor: new Redactor() }),
    providerFactory: (e, opts) => { calls.push(e.id); return createProvider(e, { ...opts, detect: DETECT[e.id] }); },
    // Ollama on the mock port; the other local servers point at a port that was just freed (nothing listens).
    vars: { 'ollama-local': { port: String(ollama.port) }, lmstudio: { port: closedPort }, llamacpp: { port: closedPort }, vllm: { port: closedPort }, jan: { port: closedPort }, 'litellm-proxy': { port: closedPort } },
    nvidiaProbe: nvidia, extraModels: (id) => (id === 'nvidia-nim' ? [{ id: 'z-ai/glm-5.3', contextLength: null }] : null),
    probeCliAndLocal: cliAndLocal,
  });
  return { hub, calls };
}

test('the real registry: 35 rows, five status words only, keyed providers without a key are "geen sleutel" with no network', async () => {
  const { hub } = realHub({ cliAndLocal: false });
  const r = await hub.listProviders();
  assert.equal(r.ok, true);
  assert.equal(r.providers.length, 35);
  const words = new Set(Object.values(STATUS_WORDS));
  for (const p of r.providers) {
    assert.ok(words.has(p.status), p.id + ' has status ' + p.status);
    assert.equal(STATUS_WORDS[p.status_code], p.status);
    for (const f of ['who_pays', 'price_band', 'limits', 'tos', 'key_name', 'key_present', 'key_source', 'login', 'verified_on', 'checked_at']) assert.ok(f in p, p.id + ' lacks ' + f);
    assert.equal(p.tos.checked_on, p.verified_on);
    if (p.kind === 'api-key') {
      assert.equal(p.status, 'geen sleutel', p.id);
      assert.equal(p.live, false);
    }
  }
  assert.equal(r.counts.total, 35);
  assert.equal(r.counts.connected + r.counts.not_connected + r.counts.no_key + r.counts.not_installed + r.counts.error, 35);
});

test('keys from the vault env make the matching providers "niet verbonden, not tested" (still no network)', async () => {
  const { hub } = realHub({ env: { FORGE_KEY_GROQ_API_KEY: 'gsk_' + 'x'.repeat(40), GEMINI_API_KEY: 'AIza' + 'y'.repeat(35) }, cliAndLocal: false });
  const rows = Object.fromEntries((await hub.listProviders()).providers.map((p) => [p.id, p]));
  assert.equal(rows.groq.status, 'niet verbonden');
  assert.equal(rows.groq.tested, false);
  assert.equal(rows.groq.key_source, 'vault');
  assert.equal(rows['gemini-native'].key_source, 'env', 'two providers share GEMINI_API_KEY');
  assert.equal(rows['gemini-openai'].key_source, 'env');
  assert.equal(rows.openai.status, 'geen sleutel');
});

test('CLI and local probes: claude signed in, codex signed out, Ollama answers (mock), other local servers down', async () => {
  const { hub } = realHub({ nvidia: async () => ({ state: 'CONNECTED', models: 120, ms: 340, base_url: 'https://integrate.api.nvidia.com/v1' }) });
  const rows = Object.fromEntries((await hub.listProviders()).providers.map((p) => [p.id, p]));
  assert.equal(rows['claude-code-cli'].status, 'verbonden');
  assert.equal(rows['codex-cli'].status, 'niet verbonden');
  assert.equal(rows['gemini-cli'].status, 'niet geinstalleerd');
  assert.equal(rows['ollama-local'].status, 'verbonden');
  assert.equal(rows['ollama-local'].live, true);
  assert.equal(rows.lmstudio.status, 'niet verbonden');
  assert.equal(rows['nvidia-nim'].status, 'verbonden');
  assert.equal(rows['nvidia-nim'].key_present, true, 'a CONNECTED NVIDIA probe proves a key in the NVIDIA env');
});

test('the models block lists configured providers with models, who pays, price band and limits', async () => {
  const { hub } = realHub({ nvidia: async () => ({ state: 'CONNECTED', models: 120, ms: 340 }) });
  const block = await hub.modelsBlock();
  assert.equal(block.available, true);
  const byId = Object.fromEntries(block.list.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['claude-code-cli', 'nvidia-nim', 'ollama-local']);
  assert.deepEqual(byId['claude-code-cli'].models.map((m) => m.id), ['sonnet', 'opus', 'fable', 'haiku']);
  assert.equal(byId['claude-code-cli'].models_source, 'static');
  assert.equal(byId['claude-code-cli'].price_band, 'plan-limit');
  assert.equal(byId['claude-code-cli'].limits.kind, 'plan-window');
  assert.deepEqual(byId['ollama-local'].models, [{ id: 'qwen2.5:0.5b', context_length: null, size_bytes: 397821319 }]);
  assert.equal(byId['ollama-local'].who_pays.code, 'free-local');
  assert.equal(byId['ollama-local'].price_band, 'free');
  assert.equal(byId['nvidia-nim'].models_source, 'matrix');
  assert.equal(byId['nvidia-nim'].price_band, 'pay-per-use');
});

test('status is cached: a second listing within the TTL starts no new probe; ?fresh re-probes', async () => {
  const { hub } = realHub({ nvidia: async () => ({ state: 'OFF', note: 'NVIDIA OFF' }) });
  await hub.listProviders();
  const before = ollama.requests.length;
  await hub.listProviders();
  assert.equal(ollama.requests.length, before, 'cached: no new Ollama request');
  await hub.listProviders({ fresh: true });
  assert.ok(ollama.requests.length > before, 'fresh: Ollama probed again');
});

test('Ollama test-connection through the hub (mock): verbonden with the model count', async () => {
  const { hub } = realHub();
  const out = await hub.testProvider('ollama-local');
  assert.equal(out.result.ok, true);
  assert.equal(out.result.status, 'verbonden');
  assert.equal(out.result.models_count, 1);
});

test('NVIDIA regression: buildModelsView keeps its nvidia field and adds providers; a slow hub answers pending within the budget', async () => {
  _setProviderHubForTests({ modelsBlock: () => new Promise(() => {}) });
  const t0 = Date.now();
  const view = await buildModelsView();
  const ms = Date.now() - t0;
  assert.equal(view.ok, true);
  assert.ok(['CONNECTED', 'DISCONNECTED', 'NOT CONFIGURED', 'OFF', 'UNKNOWN'].includes(view.nvidia.state));
  assert.equal(typeof view.nvidia.age_ms, 'number');
  assert.equal(view.providers.pending, true);
  assert.deepEqual(view.providers.list, []);
  assert.ok(ms < 6000, 'answered after ' + ms + ' ms');
});

test('a failing hub never breaks /api/models: providers.available false with a redacted error', async () => {
  _setProviderHubForTests({ modelsBlock: async () => { throw new Error('boom with nvapi-' + 'Q'.repeat(20)); } });
  const view = await buildModelsView();
  assert.equal(view.ok, true);
  assert.equal(view.providers.available, false);
  assert.match(view.providers.error, /^provider status failed: boom/);
  assert.ok(!view.providers.error.includes('Q'.repeat(20)));
  _setProviderHubForTests(null);
});
