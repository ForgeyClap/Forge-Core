// WP B2 part 1 rework: the HTTP transport's timeout phases and its no-replay rule, against an
// in-process mock server (no network). These tests exist because the first version timed a POST chat
// out at 15 s while waiting for headers and then sent it a second time (Review Boss HIGH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestText, requestJSON, requestStream, DEFAULTS, POST_MAX_RETRIES, GET_MAX_RETRIES, defaultMaxRetries } from '../src/providers/http.mjs';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';

const FAST = { sleep: async () => {}, random: () => 0 };

async function drain(chunks) {
  let out = '';
  for await (const c of chunks) out += c;
  return out;
}

// A port with nothing listening: open a server, read its port, close it again.
async function closedPort() {
  const s = await startMockServer(() => {});
  const { port } = s;
  await s.close();
  return port;
}

test('defaults pin the three phases and the retry counts (a mutant raising POST retries must fail here)', () => {
  assert.deepEqual(
    [DEFAULTS.connectTimeoutMs, DEFAULTS.firstByteTimeoutMs, DEFAULTS.totalTimeoutMs, DEFAULTS.idleTimeoutMs],
    [15_000, 60_000, 300_000, 90_000],
  );
  assert.equal(POST_MAX_RETRIES, 1);
  assert.equal(GET_MAX_RETRIES, 2);
  assert.equal(defaultMaxRetries('POST'), 1);
  assert.equal(defaultMaxRetries('GET'), 2);
  assert.equal(defaultMaxRetries('HEAD'), 2);
  assert.equal(defaultMaxRetries('DELETE'), 1, 'DELETE is treated as non-idempotent here (Ollama delete)');
});

test('slow headers: a POST answered 2 s after the body (buffered and streamed) succeeds with a 1 s connect timeout and is sent once', { timeout: 20_000 }, async () => {
  const server = await startMockServer(async (req, res) => {
    await res.delay(2000);
    if (req.path === '/stream') return res.sse([sseData({ choices: [{ delta: { content: 'late' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);
    return res.json(200, { ok: true, got: req.body });
  });
  try {
    const timeouts = { connectTimeoutMs: 1000, totalTimeoutMs: 10_000, firstByteTimeoutMs: 10_000 };
    const r = await requestJSON({ url: server.url + '/chat', method: 'POST', body: { q: 1 }, timeouts, ...FAST });
    assert.deepEqual(r.json, { ok: true, got: { q: 1 } });
    assert.equal(server.requests.length, 1, 'the slow POST was sent exactly once');
    const s = await requestStream({ url: server.url + '/stream', body: { q: 2 }, timeouts, ...FAST });
    assert.equal(s.status, 200);
    assert.match(await drain(s.chunks), /late/);
    assert.equal(server.requests.length, 2, 'the slow streamed POST was sent exactly once');
  } finally { await server.close(); }
});

test('no replay: a POST whose body was received but never answered times out ONCE and is not re-sent (buffered and streamed)', { timeout: 20_000 }, async () => {
  const server = await startMockServer((req, res) => res.hang());
  try {
    let retries = 0;
    const onRetry = () => { retries += 1; };
    await assert.rejects(
      () => requestText({ url: server.url + '/chat', method: 'POST', body: { q: 1 }, timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 500 }, onRetry, ...FAST }),
      (e) => e.code === 'TIMEOUT' && e.retryable === false && /not retried/.test(e.message),
    );
    assert.equal(server.requests.length, 1, 'buffered POST: exactly one request reached the server');
    await assert.rejects(
      () => requestStream({ url: server.url + '/stream', body: { q: 2 }, timeouts: { connectTimeoutMs: 2000, firstByteTimeoutMs: 500 }, onRetry, ...FAST }),
      (e) => e.code === 'TIMEOUT' && e.retryable === false,
    );
    assert.equal(server.requests.length, 2, 'streamed POST: exactly one more request reached the server');
    assert.equal(retries, 0, 'withRetry never ran a second attempt');
  } finally { await server.close(); }
});

test('no replay: a connection reset after the POST body was sent is a final NETWORK error, sent once', async () => {
  const server = await startMockServer((req, res) => res.reset());
  try {
    await assert.rejects(
      () => requestText({ url: server.url + '/chat', method: 'POST', body: { q: 1 }, ...FAST }),
      (e) => e.code === 'NETWORK' && e.retryable === false && /after the request was sent/.test(e.message),
    );
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test('connect errors happen before anything was sent: a POST is retried exactly POST_MAX_RETRIES times, a GET GET_MAX_RETRIES times', async () => {
  const port = await closedPort();
  const url = 'http://127.0.0.1:' + port + '/x';
  let postRetries = 0;
  await assert.rejects(
    () => requestText({ url, method: 'POST', body: { q: 1 }, onRetry: () => { postRetries += 1; }, ...FAST }),
    (e) => e.code === 'NETWORK' && e.retryable === true,
  );
  assert.equal(postRetries, POST_MAX_RETRIES);
  let getRetries = 0;
  await assert.rejects(() => requestText({ url, method: 'GET', onRetry: () => { getRetries += 1; }, ...FAST }), (e) => e.code === 'NETWORK');
  assert.equal(getRetries, GET_MAX_RETRIES);
  let capped = 0;
  await assert.rejects(() => requestText({ url, method: 'POST', body: {}, maxRetries: 0, onRetry: () => { capped += 1; }, ...FAST }));
  assert.equal(capped, 0, 'maxRetries: 0 disables retries (health probes)');
});

test('an idempotent GET that gets no headers is retried (the server sees 1 + GET_MAX_RETRIES requests); its 429 retry path is unchanged', { timeout: 20_000 }, async () => {
  let n = 0;
  const server = await startMockServer((req, res) => {
    if (req.path === '/hang') return res.hang();
    n += 1;
    if (n === 1) return res.json(429, { error: { message: 'slow down' } }, { 'retry-after': '0' });
    return res.json(200, { data: [] });
  });
  try {
    await assert.rejects(
      () => requestText({ url: server.url + '/hang', method: 'GET', timeouts: { firstByteTimeoutMs: 200, totalTimeoutMs: 5000 }, ...FAST }),
      (e) => e.code === 'TIMEOUT' && e.retryable === true,
    );
    assert.equal(server.requests.filter((r) => r.path === '/hang').length, 1 + GET_MAX_RETRIES);
    const r = await requestJSON({ url: server.url + '/models', ...FAST });
    assert.deepEqual(r.json, { data: [] });
    assert.equal(server.requests.filter((r) => r.path === '/models').length, 2, '429 then 200');
  } finally { await server.close(); }
});

test('a 2xx stream is never replayed: an idle stall after the first chunk is a final TIMEOUT with one request', async () => {
  const server = await startMockServer((req, res) => res.stall(sseData({ choices: [{ delta: { content: 'a' } }] })));
  try {
    const s = await requestStream({ url: server.url + '/s', body: {}, timeouts: { idleTimeoutMs: 200 }, ...FAST });
    await assert.rejects(() => drain(s.chunks), (e) => e.code === 'TIMEOUT' && /idle for 200 ms/.test(e.message));
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});
