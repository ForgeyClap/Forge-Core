// WP B2 part 1: anthropic adapter against an in-process mock server (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { buildAnthropicBody, FORBIDDEN_SAMPLING_PARAMS } from '../src/providers/adapters/anthropic.mjs';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';

const reg = loadRegistry();
const KEY = 'ant-test-' + 'z'.repeat(24);
const FAST = { sleep: async () => {}, random: () => 0 };

function provider(server, opts = {}) {
  const entry = { ...reg.get('anthropic'), baseURL: server.url };
  return createProvider(entry, { keyProvider: new MemoryKeyProvider({ ANTHROPIC_API_KEY: KEY, ...(opts.extraKeys || {}) }), registry: reg, transport: FAST, ...opts });
}

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

test('body never contains temperature, top_p or top_k, also not via extraBody', () => {
  const { body, removed } = buildAnthropicBody({
    model: 'claude-x', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    options: { temperature: 0.7, topP: 0.9, topK: 5, maxTokens: 64, extraBody: { temperature: 1, top_k: 3, metadata: { user_id: 'u' } } },
  }, { stream: true });
  for (const p of FORBIDDEN_SAMPLING_PARAMS) assert.equal(p in body, false, p + ' must not be sent');
  assert.deepEqual(removed.sort(), ['temperature', 'top_k', 'top_p']);
  assert.equal(body.system, 'sys');
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.metadata, { user_id: 'u' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('tool history maps to tool_use / tool_result blocks; consecutive tool results share one user turn', () => {
  const { body } = buildAnthropicBody({
    model: 'c', options: { toolChoice: 'required' },
    tools: [{ name: 'calc', description: 'adds', parameters: { type: 'object', properties: { a: { type: 'number' } } } }],
    messages: [
      { role: 'user', content: 'add' },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 'tu1', name: 'calc', arguments: '{"a":1}' }, { id: 'tu2', name: 'calc', arguments: { a: 2 } }] },
      { role: 'tool', toolCallId: 'tu1', content: '1' },
      { role: 'tool', toolCallId: 'tu2', content: '2' },
    ],
  }, { stream: false });
  assert.deepEqual(body.tool_choice, { type: 'any' });
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.deepEqual(body.messages[1].content[1], { type: 'tool_use', id: 'tu1', name: 'calc', input: { a: 1 } });
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[2].content.map((b) => b.tool_use_id), ['tu1', 'tu2']);
});

test('stream: SSE events normalise to text, tool_call, usage and done; headers carry version and Bearer auth', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.sse([
      sseData({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 21, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 6 } } }, 'message_start'),
      sseData({ type: 'ping' }, 'ping'),
      sseData({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'),
      sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } }, 'content_block_delta'),
      sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } }, 'content_block_delta'),
      sseData({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
      sseData({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'calc', input: {} } }, 'content_block_start'),
      sseData({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } }, 'content_block_delta'),
      sseData({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '41}' } }, 'content_block_delta'),
      sseData({ type: 'content_block_stop', index: 1 }, 'content_block_stop'),
      // message_delta repeats the cumulative input/cache counts (2026 API) plus the final output_tokens
      sseData({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15, input_tokens: 21, cache_read_input_tokens: 4, cache_creation_input_tokens: 6 } }, 'message_delta'),
      sseData({ type: 'message_stop' }, 'message_stop'),
    ]);
  });
  try {
    const evs = await collect(provider(server).chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], options: { temperature: 0.3 } }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'text', 'tool_call', 'usage', 'done']);
    assert.deepEqual(evs[2].arguments, { a: 41 });
    // inputTokens = input_tokens + cache_read + cache_creation (21 + 4 + 6); the delta's repeat is not double-counted
    assert.deepEqual(
      [evs[3].inputTokens, evs[3].outputTokens, evs[3].totalTokens, evs[3].cachedInputTokens, evs[3].cacheWriteTokens],
      [31, 15, 46, 4, 6],
    );
    assert.equal(evs[4].stopReason, 'tool_use');
    const sent = server.requests[0];
    assert.equal(sent.path, '/v1/messages');
    assert.equal(sent.headers['anthropic-version'], '2026-10-21');
    assert.equal(sent.headers.authorization, 'Bearer ' + KEY);
    assert.equal(sent.headers['x-api-key'], undefined);
    assert.equal('temperature' in sent.body, false, 'temperature passed by the caller is still not sent');
  } finally { await server.close(); }
});

test('x-api-key mode and the optional workspace header', async () => {
  const server = await startMockServer((req, res) => res.json(200, { data: [{ id: 'claude-a', display_name: 'A' }], has_more: false }));
  try {
    const p = provider(server, { authHeaderMode: 'x-api-key', extraKeys: { ANTHROPIC_WORKSPACE_ID: 'wrkspc_123456' } });
    const t = await p.testConnection();
    assert.equal(t.state, 'connected');
    const sent = server.requests[0];
    assert.equal(sent.path, '/v1/models');
    assert.equal(sent.query.limit, '1');
    assert.equal(sent.headers['x-api-key'], KEY);
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers['anthropic-workspace-id'], 'wrkspc_123456');
    const { models } = await p.listModels();
    assert.deepEqual(models, [{ id: 'claude-a', label: 'A' }]);
  } finally { await server.close(); }
});

test('error paths: an error event mid-stream and a 401 become one redacted error event each', async () => {
  const server = await startMockServer(async (req, res) => {
    if (req.body.model === 'denied') return res.json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key ' + KEY } });
    await res.sse([
      sseData({ type: 'message_start', message: { model: 'c', usage: { input_tokens: 1 } } }),
      sseData({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
    ]);
  });
  try {
    const p = provider(server);
    const over = await collect(p.chat({ model: 'busy', messages: [{ role: 'user', content: 'hi' }] }));
    assert.deepEqual(over.map((e) => e.type), ['error']);
    assert.equal(over[0].code, 'RATE_LIMIT');
    assert.match(over[0].message, /overloaded_error/);
    const denied = await collect(p.chat({ model: 'denied', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(denied[0].code, 'AUTH');
    assert.equal(JSON.stringify(denied).includes(KEY), false);
  } finally { await server.close(); }
});

test('non-stream response normalises content blocks and usage', async () => {
  const server = await startMockServer((req, res) => res.json(200, {
    model: 'c', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 10 },
    content: [{ type: 'text', text: 'Yes.' }, { type: 'tool_use', id: 't9', name: 'calc', input: { a: 3 } }],
  }));
  try {
    const evs = await collect(provider(server).chat({ model: 'c', stream: false, messages: [{ role: 'user', content: 'q' }] }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'tool_call', 'usage', 'done']);
    assert.deepEqual(evs[1].arguments, { a: 3 });
    assert.deepEqual([evs[2].inputTokens, evs[2].cachedInputTokens, evs[2].cacheWriteTokens, evs[2].totalTokens], [18, 3, 10, 20]);
    assert.equal(evs[3].stopReason, 'end_turn');
  } finally { await server.close(); }
});
