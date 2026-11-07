// WP B2 part 1: KeyProvider + redaction guard. Every credential-shaped string here is assembled at run
// time and is not a real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, ProviderError, toErrorEvent, sharedRedactor } from '../src/providers/redact-guard.mjs';
import { EnvKeyProvider, MemoryKeyProvider, ChainKeyProvider } from '../src/providers/key-provider.mjs';
import { createProvider } from '../src/providers/index.mjs';
import { classifyHttpError } from '../src/providers/http.mjs';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';

const fake = (prefix, n = 32) => prefix + 'Ab1'.repeat(Math.ceil(n / 3)).slice(0, n);

test('Redactor removes registered exact secrets of any shape and keeps the label only', () => {
  const r = new Redactor();
  const odd = 'zz' + 'q9'.repeat(10) + '!!'; // a shape no pattern knows
  r.rememberSecret(odd, 'ODD_PROVIDER_KEY');
  const out = r.redact('failed with key ' + odd + ' at host');
  assert.equal(out.includes(odd), false);
  assert.match(out, /\[REDACTED:ODD_PROVIDER_KEY\]/);
});

test('Redactor catches well-known key shapes and auth header forms even when never registered', () => {
  const r = new Redactor();
  const samples = [
    fake('sk-ant-api03-'), fake('sk-proj-'), fake('nvapi-'), fake('gsk_'), fake('xai-'), 'AIza' + 'B'.repeat(35), fake('hf_'),
  ];
  for (const s of samples) assert.equal(r.redact('x ' + s + ' y').includes(s), false, 'shape leaked: ' + s.slice(0, 6));
  const hdr = r.redact('Authorization: Bearer ' + 'tok'.repeat(8) + ' and x-api-key: ' + 'k'.repeat(20) + ' and https://h/v1/models?key=' + 'g'.repeat(20) + '&a=1');
  assert.equal(hdr.includes('tok'.repeat(8)), false);
  assert.equal(hdr.includes('k'.repeat(20)), false);
  assert.equal(hdr.includes('g'.repeat(20)), false);
  assert.match(hdr, /Authorization: Bearer \[REDACTED/);
  assert.match(hdr, /&a=1/);
});

test('short values are not treated as secrets (no redaction of ordinary words)', () => {
  const r = new Redactor();
  r.rememberSecret('abc', 'X');
  assert.equal(r.redact('abc def'), 'abc def');
});

test('ProviderError redacts at construction; toErrorEvent never carries a key', () => {
  const key = fake('sk-', 40);
  sharedRedactor.rememberSecret(key, 'TEST_KEY');
  const e = new ProviderError('AUTH', 'bad key ' + key, { provider: 'p', status: 401 });
  assert.equal(e.message.includes(key), false);
  const ev = toErrorEvent(new Error('boom ' + key), 'p');
  assert.equal(JSON.stringify(ev).includes(key), false);
  assert.equal(ev.type, 'error');
});

test('classifyHttpError maps statuses and redacts a key echoed in the provider body', () => {
  const key = fake('gsk_', 30);
  const e401 = classifyHttpError(401, JSON.stringify({ error: { message: 'Invalid API Key ' + key } }), { provider: 'groq', host: 'h' });
  assert.equal(e401.code, 'AUTH');
  assert.equal(e401.message.includes(key), false);
  const e429 = classifyHttpError(429, '{}', { host: 'h', retryAfter: '2' });
  assert.equal(e429.code, 'RATE_LIMIT');
  assert.equal(e429.retryable, true);
  assert.equal(e429.retryAfterMs, 2000);
  assert.equal(classifyHttpError(503, '', { host: 'h' }).retryable, true);
  assert.equal(classifyHttpError(400, '', { host: 'h' }).retryable, false);
  assert.equal(classifyHttpError(404, '', { host: 'h' }).code, 'NOT_FOUND');
});

test('EnvKeyProvider reads only valid names from the injected env and registers values for redaction', async () => {
  const value = fake('xai-', 30);
  const kp = new EnvKeyProvider({ XAI_API_KEY: '  ' + value + '  ', EMPTY_KEY: '   ' });
  assert.equal(await kp.getKey('XAI_API_KEY'), value);
  assert.equal(await kp.getKey('EMPTY_KEY'), null);
  assert.equal(await kp.getKey('MISSING_KEY'), null);
  await assert.rejects(() => kp.getKey('path'), /invalid key name/);
  assert.deepEqual(kp.describe(), { kind: 'env', persistent: false });
  assert.equal(sharedRedactor.redact('k=' + value).includes(value), false);
});

test('ChainKeyProvider asks providers in order', async () => {
  const kp = new ChainKeyProvider([new MemoryKeyProvider({ A_KEY: 'first-value-1' }), new EnvKeyProvider({ A_KEY: 'second-value', B_KEY: 'b-value-123' })]);
  assert.equal(await kp.getKey('A_KEY'), 'first-value-1');
  assert.equal(await kp.getKey('B_KEY'), 'b-value-123');
  assert.equal(kp.describe().kind, 'chain:memory>env');
});

test('a provider never puts the key into an error, an event or info(), even when the server echoes it', async () => {
  const key = fake('sk-', 44);
  const server = await startMockServer((req, res) => {
    // a misbehaving server that echoes the Authorization header back in its error body
    res.json(401, { error: { message: 'Incorrect API key provided: ' + req.headers.authorization } });
  });
  try {
    const entry = { ...createProvider('openai', { keyProvider: new MemoryKeyProvider() }).entry, baseURL: server.url + '/v1', local: false };
    const prov = createProvider(entry, { keyProvider: new MemoryKeyProvider({ OPENAI_API_KEY: key }) });
    const events = [];
    for await (const ev of prov.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].code, 'AUTH');
    const test1 = await prov.testConnection();
    assert.equal(test1.state, 'auth-failed');
    for (const blob of [JSON.stringify(events), JSON.stringify(test1), JSON.stringify(prov.info())]) {
      assert.equal(blob.includes(key), false, 'key leaked');
      assert.equal(blob.includes(key.slice(3, 20)), false, 'part of key leaked');
    }
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + key, 'the key was really sent to the server');
  } finally {
    await server.close();
  }
});

test('a missing key gives one NOT_CONFIGURED error event and no network call', async () => {
  const server = await startMockServer((req, res) => res.json(200, {}));
  try {
    const entry = { ...createProvider('groq', { keyProvider: new MemoryKeyProvider() }).entry, baseURL: server.url };
    const prov = createProvider(entry, { keyProvider: new MemoryKeyProvider() });
    const events = [];
    for await (const ev of prov.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev);
    assert.deepEqual(events.map((e) => e.code), ['NOT_CONFIGURED']);
    assert.match(events[0].message, /GROQ_API_KEY/);
    assert.equal(server.requests.length, 0);
    const h = await prov.health();
    assert.equal(h.state, 'not-configured');
    assert.equal(h.network, false);
  } finally {
    await server.close();
  }
});
