// WP B2 part 1: gemini-native adapter (listing + Test only; chat honestly NOT_IMPLEMENTED) and the
// gemini-openai entry that carries Gemini chat. In-process mock server, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';

const reg = loadRegistry();
const KEY = 'AIza' + 'T'.repeat(35); // key-shaped, built at run time, not real

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

test('gemini-native lists models with the key in x-goog-api-key (never in the URL) and pages through results', async () => {
  const server = await startMockServer((req, res) => {
    if (req.headers['x-goog-api-key'] !== KEY) return res.json(400, { error: { code: 400, message: 'API key not valid' } });
    if (!req.query.pageToken) return res.json(200, { models: [{ name: 'models/gemini-a', displayName: 'A', inputTokenLimit: 1000, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'p2' });
    return res.json(200, { models: [{ name: 'models/gemini-b' }] });
  });
  try {
    const entry = { ...reg.get('gemini-native'), baseURL: server.url + '/v1beta' };
    const p = createProvider(entry, { keyProvider: new MemoryKeyProvider({ GEMINI_API_KEY: KEY }), registry: reg });
    const { models } = await p.listModels();
    assert.deepEqual(models.map((m) => m.id), ['gemini-a', 'gemini-b']);
    assert.equal(models[0].contextLength, 1000);
    for (const r of server.requests) {
      assert.equal(r.path, '/v1beta/models');
      assert.equal(r.query.key, undefined, 'key must not travel in the query string');
    }
    const t = await p.testConnection();
    assert.equal(t.state, 'connected');
  } finally { await server.close(); }
});

test('gemini-native: a rejected key gives a redacted error result', async () => {
  const server = await startMockServer((req, res) => res.json(403, { error: { message: 'API key ' + req.headers['x-goog-api-key'] + ' is invalid' } }));
  try {
    const entry = { ...reg.get('gemini-native'), baseURL: server.url };
    const t = await createProvider(entry, { keyProvider: new MemoryKeyProvider({ GEMINI_API_KEY: KEY }), registry: reg }).testConnection();
    assert.equal(t.state, 'auth-failed');
    assert.equal(JSON.stringify(t).includes(KEY), false);
  } finally { await server.close(); }
});

test('gemini-native chat is NOT_IMPLEMENTED and points to gemini-openai (no request is sent)', async () => {
  const server = await startMockServer((req, res) => res.json(200, {}));
  try {
    const entry = { ...reg.get('gemini-native'), baseURL: server.url };
    const evs = await collect(createProvider(entry, { keyProvider: new MemoryKeyProvider({ GEMINI_API_KEY: KEY }), registry: reg })
      .chat({ model: 'gemini-a', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].code, 'NOT_IMPLEMENTED');
    assert.match(evs[0].message, /gemini-openai/);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('gemini-openai chats through the OpenAI-compatible route with Bearer auth', async () => {
  const server = await startMockServer(async (req, res) => {
    await res.sse([sseData({ choices: [{ delta: { content: 'ok' } }] }), sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);
  });
  try {
    const entry = { ...reg.get('gemini-openai'), baseURL: server.url + '/v1beta/openai' };
    const evs = await collect(createProvider(entry, { keyProvider: new MemoryKeyProvider({ GEMINI_API_KEY: KEY }), registry: reg })
      .chat({ model: 'gemini-a', messages: [{ role: 'user', content: 'hi' }] }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'done']);
    assert.equal(server.requests[0].path, '/v1beta/openai/chat/completions');
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + KEY);
  } finally { await server.close(); }
});
