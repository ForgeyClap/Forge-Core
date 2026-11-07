// WP B2 part 1: openai-compatible adapter against an in-process mock server (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { buildChatCompletionsBody, buildResponsesBody } from '../src/providers/adapters/openai-format.mjs';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';

const reg = loadRegistry();
const FAST = { sleep: async () => {}, random: () => 0 };
const KEY = 'test-' + 'k'.repeat(24);

function provider(id, server, { path = '', key = KEY, keyEnv, timeouts } = {}) {
  const base = reg.get(id);
  const entry = { ...base, baseURL: server.url + path, templateVars: undefined };
  const kp = new MemoryKeyProvider(base.keyEnvName ? { [keyEnv || base.keyEnvName]: key } : {});
  return createProvider(entry, { keyProvider: kp, registry: reg, transport: FAST, timeouts });
}

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const USER = [{ role: 'user', content: 'hi' }];

test('chat-completions stream: text deltas, split tool-call arguments, usage in the last chunk, done', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.sse([
      ': OPENROUTER PROCESSING\n\n',
      sseData({ model: 'm1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }),
      sseData({ choices: [{ index: 0, delta: { content: 'lo' } }] }),
      sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] }),
      sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] }),
      sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sseData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
      'data: [DONE]\n\n',
    ]);
  });
  try {
    const p = provider('openrouter', server);
    const evs = await collect(p.chat({ model: 'm1', messages: USER, tools: [{ name: 'get_weather', parameters: { type: 'object' } }] }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'text', 'tool_call', 'usage', 'done']);
    assert.equal(evs[0].text + evs[1].text, 'Hello');
    assert.deepEqual(evs[2].arguments, { city: 'Paris' });
    assert.equal(evs[2].id, 'call_1');
    assert.equal(evs[3].totalTokens, 14);
    assert.equal(evs[4].stopReason, 'tool_calls');
    const sent = server.requests[0];
    assert.equal(sent.path, '/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer ' + KEY);
    assert.equal(sent.headers['x-openrouter-title'], 'Forge Systeem');
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.tools[0].type, 'function');
  } finally { await server.close(); }
});

test('chat-completions non-stream: message content, tool calls and usage', async () => {
  const server = await startMockServer((req, res) => res.json(200, {
    model: 'm2', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi there' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 1 } },
  }));
  try {
    const evs = await collect(provider('together', server).chat({ model: 'm2', messages: USER, stream: false }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'usage', 'done']);
    assert.deepEqual([evs[1].inputTokens, evs[1].cachedInputTokens, evs[1].cacheWriteTokens, evs[1].totalTokens], [3, 1, null, 5], 'prompt_tokens already includes cached tokens; OpenAI reports no cache writes');
    assert.equal(server.requests[0].body.stream, false);
  } finally { await server.close(); }
});

test('responses API stream: output_text deltas, function call items, usage on response.completed', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.sse([
      sseData({ type: 'response.created', response: { id: 'r1' } }, 'response.created'),
      sseData({ type: 'response.output_text.delta', delta: 'Bon' }, 'response.output_text.delta'),
      sseData({ type: 'response.output_text.delta', delta: 'jour' }, 'response.output_text.delta'),
      sseData({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'lookup', arguments: '' } }),
      sseData({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":' }),
      sseData({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x"}' }),
      sseData({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'lookup' } }),
      sseData({ type: 'response.completed', response: { status: 'completed', model: 'gpt-x', usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 } } }),
    ]);
  });
  try {
    const p = provider('openai', server, { path: '/v1' });
    const evs = await collect(p.chat({ model: 'gpt-x', messages: [{ role: 'system', content: 'be brief' }, ...USER], tools: [{ name: 'lookup' }], options: { maxTokens: 50, toolChoice: 'auto' } }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'text', 'tool_call', 'usage', 'done']);
    assert.deepEqual(evs[2], { type: 'tool_call', id: 'call_9', name: 'lookup', arguments: { q: 'x' }, rawArguments: '{"q":"x"}' });
    const body = server.requests[0].body;
    assert.equal(server.requests[0].path, '/v1/responses');
    assert.equal(body.instructions, 'be brief');
    assert.equal(body.max_output_tokens, 50);
    assert.equal(body.store, false, 'storeFalse quirk for OpenAI');
    assert.deepEqual(body.input, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.tools[0].name, 'lookup');
  } finally { await server.close(); }
});

test('responses API: response.failed becomes one error event', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.sse([sseData({ type: 'response.failed', response: { error: { message: 'model overloaded' } } })]);
  });
  try {
    const evs = await collect(provider('xai', server).chat({ model: 'grok-x', messages: USER }));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'error');
    assert.match(evs[0].message, /model overloaded/);
  } finally { await server.close(); }
});

test('quirks: Groq drops logprobs and messages[].name, forces n=1, raises temperature 0 to 1e-8', () => {
  const { body, applied } = buildChatCompletionsBody(reg.get('groq'), {
    model: 'llama', messages: [{ role: 'user', content: 'hi', name: 'bob' }],
    options: { temperature: 0, n: 3, logprobs: true, maxTokens: 5 },
  }, { stream: true });
  assert.equal(body.temperature, 1e-8);
  assert.equal(body.n, 1);
  assert.equal(body.logprobs, undefined);
  assert.equal(body.messages[0].name, undefined);
  assert.ok(applied.includes('temperatureFloor') && applied.includes('forceN1') && applied.includes('dropMessageName'));
});

test('quirks: Ollama drops tool_choice and n; Mistral renames seed; Cohere drops store and parallel_tool_calls', () => {
  const ol = buildChatCompletionsBody(reg.get('ollama-local'), { model: 'q', messages: USER, tools: [{ name: 't' }], options: { toolChoice: 'required', n: 2 } }, { stream: true });
  assert.equal(ol.body.tool_choice, undefined);
  assert.equal(ol.body.n, undefined);
  assert.deepEqual(ol.body.stream_options, { include_usage: true });
  const mi = buildChatCompletionsBody(reg.get('mistral'), { model: 'm', messages: USER, options: { seed: 42 } }, { stream: false });
  assert.equal(mi.body.random_seed, 42);
  assert.equal(mi.body.seed, undefined);
  const co = buildChatCompletionsBody(reg.get('cohere'), { model: 'c', messages: USER, options: { parallelToolCalls: true, extraBody: { store: true } } }, { stream: false });
  assert.equal(co.body.store, undefined);
  assert.equal(co.body.parallel_tool_calls, undefined);
  const oa = buildResponsesBody(reg.get('openai'), { model: 'o', messages: USER, options: { temperature: 0.2, extraBody: { model: 'hijack' } } }, { stream: true });
  assert.equal(oa.body.model, 'o', 'extraBody cannot override reserved fields');
});

test('quirk noToolsWhileStreaming: DashScope sends a tools request without streaming and still yields events', async () => {
  const server = await startMockServer((req, res) => res.json(200, {
    choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] } }],
  }));
  try {
    const evs = await collect(provider('qwen-dashscope', server).chat({ model: 'qwen-max', messages: USER, tools: [{ name: 't' }] }));
    assert.equal(server.requests[0].body.stream, false);
    assert.deepEqual(evs.map((e) => e.type), ['tool_call', 'done']);
  } finally { await server.close(); }
});

test('error path: a 429 with Retry-After is retried once, then succeeds; a 400 is not retried', async () => {
  let n = 0;
  const server = await startMockServer((req, res) => {
    n += 1;
    if (req.body && req.body.model === 'bad') return res.json(400, { error: { message: 'bad model' } });
    if (n === 1) return res.json(429, { error: { message: 'slow down' } }, { 'retry-after': '0' });
    return res.json(200, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  });
  try {
    const p = provider('deepseek', server);
    const ok = await collect(p.chat({ model: 'm', messages: USER, stream: false }));
    assert.deepEqual(ok.map((e) => e.type), ['text', 'done']);
    assert.equal(server.requests.length, 2);
    const bad = await collect(p.chat({ model: 'bad', messages: USER, stream: false }));
    assert.equal(bad[0].code, 'HTTP');
    assert.equal(bad[0].status, 400);
    assert.equal(server.requests.length, 3, '400 is not retried');
  } finally { await server.close(); }
});

test('error path: a stream that stalls is cut by the idle timeout; a stream that ends early is an error', async () => {
  const server = await startMockServer(async (req, res) => {
    if (req.body.model === 'stall') return res.stall(sseData({ choices: [{ delta: { content: 'a' } }] }));
    return res.sse([sseData({ choices: [{ delta: { content: 'partial' } }] })]);
  });
  try {
    const p = provider('fireworks', server, { timeouts: { idleTimeoutMs: 300 } });
    const stalled = await collect(p.chat({ model: 'stall', messages: USER }));
    assert.deepEqual(stalled.map((e) => e.type), ['text', 'error']);
    assert.equal(stalled[1].code, 'TIMEOUT');
    const early = await collect(p.chat({ model: 'early', messages: USER }));
    assert.equal(early[early.length - 1].code, 'BAD_RESPONSE');
  } finally { await server.close(); }
});

test('an invalid request is refused before any network call', async () => {
  const server = await startMockServer((req, res) => res.json(200, {}));
  try {
    const p = provider('groq', server);
    const evs = await collect(p.chat({ model: '', messages: [] }));
    assert.equal(evs[0].code, 'CONFIG');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('testConnection: models route answers -> connected; 404 + model -> one-token chat fallback; no model -> needs-model', async () => {
  const server = await startMockServer((req, res) => {
    if (req.path === '/models' && req.headers.authorization === 'Bearer ' + KEY) return res.json(200, { data: [{ id: 'a' }, { id: 'b' }] });
    if (req.path === '/nomodels/models') return res.json(404, { error: 'not found' });
    if (req.path === '/nomodels/chat/completions') return res.json(200, { choices: [{ finish_reason: 'length', message: { content: 'p' } }] });
    if (req.path === '/nomodels/responses') return res.json(200, { status: 'completed', model: 'grok-x', output: [{ type: 'message', content: [{ type: 'output_text', text: 'p' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    return res.json(401, { error: { message: 'no' } });
  });
  try {
    const ok = await provider('mistral', server).testConnection();
    assert.equal(ok.state, 'connected');
    assert.equal(ok.modelsCount, 2);
    // xai uses the responses style: the fallback probe hits /responses with the smallest value OpenAI accepts there
    const fb = await provider('xai', server, { path: '/nomodels' }).testConnection({ model: 'grok-x' });
    assert.equal(fb.state, 'connected');
    const probe = server.requests.at(-1);
    assert.equal(probe.path, '/nomodels/responses');
    assert.equal(probe.body.max_output_tokens, 16);
    assert.equal(probe.body.model, 'grok-x');
    assert.equal(probe.body.stream, false);
    const fb2 = await provider('moonshot', server, { path: '/nomodels' }).testConnection({ model: 'kimi' });
    assert.equal(fb2.state, 'connected');
    assert.equal(server.requests.at(-1).body.max_tokens, 1);
    const nm = await provider('cohere', server).testConnection();
    assert.equal(nm.state, 'needs-model');
    const bad = await provider('mistral', server, { key: 'wrong-' + 'x'.repeat(20) }).testConnection();
    assert.equal(bad.state, 'auth-failed');
  } finally { await server.close(); }
});

test('listModels follows has_more/last_id pagination and reports static/controlplane modes honestly', async () => {
  const server = await startMockServer((req, res) => {
    if (!req.query.after) return res.json(200, { data: [{ id: 'm1' }], has_more: true, last_id: 'm1' });
    return res.json(200, { data: [{ id: 'm2', context_length: 8192 }], has_more: false });
  });
  try {
    const { models, source } = await provider('vercel-ai-gateway', server).listModels();
    assert.deepEqual(models.map((m) => m.id), ['m1', 'm2']);
    assert.equal(models[1].contextLength, 8192);
    assert.equal(source, 'endpoint');
  } finally { await server.close(); }
  const bed = createProvider('bedrock', { keyProvider: new MemoryKeyProvider(), registry: reg });
  const r = await bed.listModels();
  assert.equal(r.source, 'controlplane');
  assert.deepEqual(r.models, []);
});

test('local provider health is a real reachability probe; remote health makes no network call', async () => {
  const server = await startMockServer((req, res) => (req.path === '/health' ? res.text(200, 'ok') : res.json(200, { data: [] })));
  try {
    const entry = { ...reg.get('llamacpp'), baseURL: server.url + '/v1', templateVars: undefined };
    const h = await createProvider(entry, { keyProvider: new MemoryKeyProvider(), registry: reg }).health();
    assert.equal(h.state, 'reachable');
    assert.equal(server.requests[0].path, '/health');
  } finally { await server.close(); }
  const down = { ...reg.get('lmstudio'), baseURL: 'http://127.0.0.1:9/v1', templateVars: undefined };
  const h2 = await createProvider(down, { keyProvider: new MemoryKeyProvider(), registry: reg }).health();
  assert.equal(h2.state, 'unreachable');
  const remote = await createProvider('together', { keyProvider: new MemoryKeyProvider({ TOGETHER_API_KEY: KEY }), registry: reg }).health();
  assert.deepEqual([remote.state, remote.network], ['configured', false]);
});
