// LIVE: the real local Ollama server (http://127.0.0.1:11434). Skipped unless FORGE_LIVE=1.
// Needs Ollama running with a small model (default qwen2.5:0.5b; override FORGE_LIVE_OLLAMA_MODEL).
// Local only: no key, nothing leaves this PC. Never pulls or deletes a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';

const LIVE = process.env.FORGE_LIVE === '1';
const SKIP = LIVE ? false : 'live test: set FORGE_LIVE=1 (needs a running local Ollama)';
const MODEL = process.env.FORGE_LIVE_OLLAMA_MODEL || 'qwen2.5:0.5b';

// Deliberately the DEFAULT timeouts (http.mjs DEFAULTS): the review found that the first version hid a
// 15 s header-wait bug behind a raised connectTimeoutMs here. A cold model load must fit the defaults.
function provider() {
  return createProvider('ollama-local', { keyProvider: new MemoryKeyProvider(), registry: loadRegistry() });
}

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function summary(evs) {
  return {
    types: evs.map((e) => e.type).join(','),
    text: evs.filter((e) => e.type === 'text').map((e) => e.text).join('').slice(0, 80),
    usage: evs.find((e) => e.type === 'usage') || null,
    done: evs.find((e) => e.type === 'done') || null,
    error: evs.find((e) => e.type === 'error') || null,
  };
}

test('live ollama: health, test connection and model list', { skip: SKIP }, async () => {
  const p = provider();
  const h = await p.health();
  console.log('[live] health', JSON.stringify(h));
  assert.equal(h.state, 'reachable');
  const t = await p.testConnection();
  console.log('[live] testConnection', JSON.stringify(t));
  assert.equal(t.state, 'connected');
  const { models } = await p.listModels();
  console.log('[live] models', JSON.stringify(models.map((m) => [m.id, m.parameterSize, m.contextLength])));
  assert.ok(models.some((m) => m.id === MODEL), MODEL + ' is installed');
  const s = await p.show(MODEL);
  console.log('[live] show', JSON.stringify(s));
  assert.ok(s.contextLength > 0);
});

test('live ollama: streamed chat through /v1 yields text, usage and done', { skip: SKIP, timeout: 180_000 }, async () => {
  const evs = await collect(provider().chat({ model: MODEL, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], options: { maxTokens: 10, temperature: 0 } }));
  const s = summary(evs);
  console.log('[live] stream', JSON.stringify(s));
  assert.equal(s.error, null);
  assert.ok(s.text.length > 0);
  assert.ok(s.usage && s.usage.outputTokens > 0, 'usage arrived in the last chunk (stream_options.include_usage)');
  assert.ok(s.done);
});

test('live ollama: non-streamed chat and native num_ctx chat', { skip: SKIP, timeout: 180_000 }, async () => {
  const p = provider();
  const plain = summary(await collect(p.chat({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'Say hi.' }], options: { maxTokens: 10 } })));
  console.log('[live] non-stream', JSON.stringify(plain));
  assert.equal(plain.error, null);
  assert.ok(plain.done);
  const native = summary(await collect(p.chat({ model: MODEL, messages: [{ role: 'user', content: 'Say hi.' }], options: { maxTokens: 10, numCtx: 2048 } })));
  console.log('[live] native num_ctx', JSON.stringify(native));
  assert.equal(native.error, null);
  assert.ok(native.done);
});

test('live ollama: the model calls the get_weather tool (tool_choice dropped by the quirk, no 400)', { skip: SKIP, timeout: 180_000 }, async () => {
  const evs = await collect(provider().chat({
    model: MODEL, messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
    tools: [{ name: 'get_weather', description: 'Get the weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    options: { maxTokens: 60, temperature: 0, toolChoice: 'required' },
  }));
  const s = summary(evs);
  const call = evs.find((e) => e.type === 'tool_call') || null;
  console.log('[live] tools', JSON.stringify({ ...s, toolCall: call }));
  assert.equal(s.error, null, 'no 400 from tool_choice');
  assert.ok(s.done);
  assert.ok(call, 'a tool_call event was emitted');
  assert.equal(call.name, 'get_weather');
  assert.ok(call.arguments && typeof call.arguments.city === 'string' && call.arguments.city.length > 0, 'arguments carry a city: ' + JSON.stringify(call.arguments));
});
