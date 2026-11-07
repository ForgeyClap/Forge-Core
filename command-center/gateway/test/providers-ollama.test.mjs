// WP B2 part 1: ollama adapter against an in-process mock server (no network). The real local Ollama
// is exercised separately in providers-ollama.live.test.mjs (FORGE_LIVE=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';

const reg = loadRegistry();

function local(server) {
  return createProvider('ollama-local', { keyProvider: new MemoryKeyProvider(), registry: reg, vars: { port: String(server.port) } });
}

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

test('health uses /api/version; models come from native /api/tags with details', async () => {
  const server = await startMockServer((req, res) => {
    if (req.path === '/api/version') return res.json(200, { version: '0.40.13' });
    if (req.path === '/api/tags') return res.json(200, { models: [{ name: 'qwen2.5:0.5b', size: 397821319, details: { family: 'qwen2', parameter_size: '494.03M', quantization_level: 'Q4_K_M', context_length: 32768 }, capabilities: ['completion', 'tools'] }] });
    return res.json(404, { error: 'nope' });
  });
  try {
    const p = local(server);
    const h = await p.health();
    assert.deepEqual([h.state, h.version], ['reachable', '0.40.13']);
    const { models } = await p.listModels();
    assert.deepEqual(models[0], { id: 'qwen2.5:0.5b', sizeBytes: 397821319, family: 'qwen2', parameterSize: '494.03M', quantization: 'Q4_K_M', contextLength: 32768, capabilities: ['completion', 'tools'] });
    const t = await p.testConnection();
    assert.equal(t.state, 'connected');
    assert.equal(server.requests.every((r) => r.headers.authorization === undefined), true, 'local Ollama gets no auth header');
  } finally { await server.close(); }
});

test('chat goes through /v1/chat/completions with the no-tool_choice quirk applied', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.sse([
      sseData({ model: 'qwen', choices: [{ delta: { content: 'Hi' } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sseData({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 } }),
      'data: [DONE]\n\n',
    ]);
  });
  try {
    const evs = await collect(local(server).chat({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't' }], options: { toolChoice: 'required', n: 2 } }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'usage', 'done']);
    const sent = server.requests[0];
    assert.equal(sent.path, '/v1/chat/completions');
    assert.equal(sent.body.tool_choice, undefined);
    assert.equal(sent.body.n, undefined);
    assert.deepEqual(sent.body.stream_options, { include_usage: true });
  } finally { await server.close(); }
});

test('numCtx switches to native /api/chat with options.num_ctx and NDJSON streaming (incl. a tool call)', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.ndjson([
      { model: 'qwen', message: { role: 'assistant', content: 'Look' }, done: false },
      { model: 'qwen', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }] }, done: false },
      { model: 'qwen', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 },
    ]);
  });
  try {
    const evs = await collect(local(server).chat({ model: 'qwen', messages: [{ role: 'user', content: 'weather?' }], options: { numCtx: 4096, maxTokens: 30, temperature: 0 } }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'tool_call', 'usage', 'done']);
    assert.deepEqual(evs[1].arguments, { city: 'Paris' });
    assert.equal(evs[2].totalTokens, 49);
    const sent = server.requests[0];
    assert.equal(sent.path, '/api/chat');
    assert.deepEqual(sent.body.options, { num_ctx: 4096, temperature: 0, num_predict: 30 });
  } finally { await server.close(); }
});

test('pull streams NDJSON progress until success; an error line fails the pull', async () => {
  const server = await startMockServer(async (req, res) => {
    if (req.body.model === 'broken:1b') return res.ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]);
    await res.ndjson([
      { status: 'pulling manifest' },
      { status: 'pulling abc', digest: 'sha256:abc', total: 100, completed: 40 },
      { status: 'pulling abc', digest: 'sha256:abc', total: 100, completed: 100 },
      { status: 'verifying sha256 digest' },
      { status: 'success' },
    ], { delayMs: 5 });
  });
  try {
    const p = local(server);
    const steps = await collect(p.pull('tiny:1b'));
    assert.equal(steps.at(-1).status, 'success');
    assert.equal(steps[2].completed, 100);
    assert.deepEqual(server.requests[0].body, { model: 'tiny:1b', stream: true });
    await assert.rejects(() => collect(p.pull('broken:1b')), /file does not exist/);
    await assert.rejects(() => collect(p.pull('bad name; rm')), (e) => e.code === 'CONFIG');
  } finally { await server.close(); }
});

test('delete needs confirm:true; show returns capabilities and context length', async () => {
  const server = await startMockServer((req, res) => {
    if (req.path === '/api/delete') return res.text(200, '');
    if (req.path === '/api/show') return res.json(200, { capabilities: ['completion'], details: { family: 'qwen2' }, model_info: { 'qwen2.context_length': 32768 } });
    return res.json(404, {});
  });
  try {
    const p = local(server);
    await assert.rejects(() => p.delete('tiny:1b'), /confirm: true/);
    assert.equal(server.requests.length, 0, 'nothing was sent without confirmation');
    assert.deepEqual(await p.delete('tiny:1b', { confirm: true }), { ok: true, model: 'tiny:1b' });
    assert.equal(server.requests[0].method, 'DELETE');
    const s = await p.show('tiny:1b');
    assert.deepEqual([s.contextLength, s.capabilities], [32768, ['completion']]);
  } finally { await server.close(); }
});

test('Ollama Cloud: Bearer auth, config-only health, and no pull or delete', async () => {
  const key = 'ollama-' + 'c'.repeat(30);
  const server = await startMockServer((req, res) => res.json(200, { models: [{ name: 'gpt-oss:120b-cloud' }] }));
  try {
    const entry = { ...reg.get('ollama-cloud'), baseURL: server.url };
    const p = createProvider(entry, { keyProvider: new MemoryKeyProvider({ OLLAMA_API_KEY: key }), registry: reg });
    const h = await p.health();
    assert.deepEqual([h.state, h.network], ['configured', false]);
    const { models } = await p.listModels();
    assert.equal(models[0].id, 'gpt-oss:120b-cloud');
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + key);
    await assert.rejects(() => collect(p.pull('x:1b')), (e) => e.code === 'NOT_IMPLEMENTED');
    await assert.rejects(() => p.delete('x:1b', { confirm: true }), (e) => e.code === 'NOT_IMPLEMENTED');
  } finally { await server.close(); }
});

test('health reports a stopped local Ollama as unreachable with a plain explanation', async () => {
  const gone = await startMockServer((req, res) => res.json(200, {}));
  const port = String(gone.port);
  await gone.close(); // the port is now closed: a refused connection, like a stopped Ollama
  const p = createProvider('ollama-local', { keyProvider: new MemoryKeyProvider(), registry: reg, vars: { port } });
  const h = await p.health();
  assert.equal(h.state, 'unreachable');
  assert.match(h.detail, /not running on this PC/);
});

test('a port value outside the registry pattern is a CONFIG error, never a request', async () => {
  const p = createProvider('ollama-local', { keyProvider: new MemoryKeyProvider(), registry: reg, vars: { port: '9' } });
  const h = await p.health();
  assert.equal(h.state, 'error');
  assert.match(h.detail, /does not match/);
});
