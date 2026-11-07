// HTTP transport for the provider layer: node:http / node:https only (zero dependencies).
//
// Reliability rules (forge-integration playbook), fixed after the B2 review:
//   - every call has explicit timeouts, in three phases:
//       1. connect + send   connectTimeoutMs    until the request (headers and body) has been handed to
//                                               the socket, which implies TCP and TLS are up;
//       2. first byte       headers wait        buffered call: the whole totalTimeoutMs budget (a
//                                               non-streamed chat only sends headers when the answer is
//                                               complete); stream: firstByteTimeoutMs; GET/HEAD: the
//                                               smaller of firstByteTimeoutMs and totalTimeoutMs;
//       3. body             totalTimeoutMs      remaining budget for a buffered body, or idleTimeoutMs
//                                               between chunks of a stream;
//   - retries are bounded (maxRetries, default 2 for GET and 1 for POST) with exponential backoff and
//     full jitter; Retry-After is honoured up to MAX_RETRY_AFTER_MS, a longer wait is not retried;
//   - a POST (or any non-idempotent method) is NEVER re-sent once its body has been flushed to the
//     socket: a header-wait timeout, a reset or an idle stall after that point is a final error. Only
//     failures before the body left this process (refused, DNS, connect timeout) and explicit rejections
//     by the server (408, 429, 500/502/503/504/529) are retried. GET and HEAD may be retried after a
//     header-wait timeout too. Nothing is ever retried after a 2xx;
//   - error messages carry the host only, never the full URL (a query could hold a key), and are
//     redacted by ProviderError itself.

import http from 'node:http';
import https from 'node:https';
import { ProviderError, ERROR_CODES, redactText } from './redact-guard.mjs';

export const DEFAULTS = Object.freeze({
  connectTimeoutMs: 15_000,      // phase 1: connect (TCP + TLS) and hand the request to the socket
  firstByteTimeoutMs: 60_000,    // phase 2 for streams and GET/HEAD: time until response headers
  totalTimeoutMs: 300_000,       // buffered calls: headers + body; a non-streamed chat can take minutes
  idleTimeoutMs: 90_000,         // streams: maximum silence between two chunks
  maxBodyBytes: 8 * 1024 * 1024,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 4_000,
});
export const POST_MAX_RETRIES = 1;
export const GET_MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 20_000;
const ERROR_BODY_TIMEOUT_MS = 10_000;
const USER_AGENT = 'forge-systeem-gateway/0.1 (+providers)';
const RETRYABLE_NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

export function joinURL(base, path, query) {
  const u = new URL(String(base).replace(/\/+$/, '') + (path ? (path.startsWith('/') ? path : '/' + path) : ''));
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return '(invalid url)'; }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

// Pulls a human message out of a provider error body (OpenAI, Anthropic, Gemini, Ollama shapes).
export function errorMessageFromBody(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const e = j && (j.error !== undefined ? j.error : j);
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
    if (j && typeof j.message === 'string') return j.message;
    if (j && typeof j.detail === 'string') return j.detail;
  } catch { /* not JSON */ }
  return text;
}

export function classifyHttpError(status, bodyText, { provider = null, host = '', retryAfter = null } = {}) {
  const detail = redactText(errorMessageFromBody(bodyText)).replace(/\s+/g, ' ').trim().slice(0, 300);
  const msg = 'HTTP ' + status + ' from ' + host + (detail ? ': ' + detail : '');
  let err;
  if (status === 401 || status === 403) err = new ProviderError(ERROR_CODES.AUTH, msg, { provider, status });
  else if (status === 404) err = new ProviderError(ERROR_CODES.NOT_FOUND, msg, { provider, status });
  else if (status === 408) err = new ProviderError(ERROR_CODES.TIMEOUT, msg, { provider, status, retryable: true });
  else if (status === 429) err = new ProviderError(ERROR_CODES.RATE_LIMIT, msg, { provider, status, retryable: true });
  else if (status >= 500) err = new ProviderError(ERROR_CODES.HTTP, msg, { provider, status, retryable: [500, 502, 503, 504, 529].includes(status) });
  else err = new ProviderError(ERROR_CODES.HTTP, msg, { provider, status });
  err.retryAfterMs = parseRetryAfter(retryAfter);
  return err;
}

// A network error is retryable only when the request can be re-sent without a duplicate side effect:
// the body never left this process, or the method is idempotent.
function networkError(err, host, provider, { bodySent = false, idempotent = false } = {}) {
  const code = err && err.code ? err.code : 'ERR';
  const safeToResend = !bodySent || idempotent;
  return new ProviderError(ERROR_CODES.NETWORK, 'network error (' + code + ') talking to ' + host + (bodySent && !idempotent ? ' after the request was sent (not retried)' : ''), {
    provider, retryable: RETRYABLE_NET_CODES.has(code) && safeToResend, cause: err,
  });
}

export function defaultMaxRetries(method) {
  return IDEMPOTENT_METHODS.has(String(method).toUpperCase()) ? GET_MAX_RETRIES : POST_MAX_RETRIES;
}

// Opens a request and resolves with the response once headers arrive. Phase 1 (connect + send) is
// bounded by connectTimeoutMs; phase 2 (headers wait) by headersTimeoutMs, counted from the moment the
// request has been flushed ('finish'). A phase-2 timeout or network error on a non-idempotent method is
// final: the server may be processing the request, so it is never sent again.
function openRequest({ url, method, headers, body, connectTimeoutMs, headersTimeoutMs, signal, provider }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new ProviderError(ERROR_CODES.CONFIG, 'invalid URL', { provider })); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new ProviderError(ERROR_CODES.CONFIG, 'unsupported protocol ' + u.protocol, { provider })); return;
    }
    if (u.username || u.password) {
      reject(new ProviderError(ERROR_CODES.CONFIG, 'credentials in a URL are refused', { provider })); return;
    }
    if (signal && signal.aborted) { reject(new ProviderError(ERROR_CODES.ABORTED, 'request aborted', { provider })); return; }
    const idempotent = IDEMPOTENT_METHODS.has(String(method).toUpperCase());
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const finalHeaders = { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...headers };
    if (payload) {
      if (!Object.keys(finalHeaders).some((h) => h.toLowerCase() === 'content-type')) finalHeaders['content-type'] = 'application/json';
      finalHeaders['content-length'] = String(payload.length);
    }
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    let bodySent = false;
    let timer = null;
    const req = mod.request(u, { method, headers: finalHeaders });
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); } };
    // Phase 1: connect + send.
    timer = setTimeout(() => {
      req.destroy();
      done(reject, new ProviderError(ERROR_CODES.TIMEOUT, 'could not connect to ' + u.host + ' and send the request within ' + connectTimeoutMs + ' ms', { provider, retryable: true }));
    }, connectTimeoutMs);
    // Phase 2: headers wait, armed once the whole request has been flushed to the socket.
    req.once('finish', () => {
      if (settled) return;
      bodySent = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        req.destroy();
        done(reject, new ProviderError(ERROR_CODES.TIMEOUT, 'no response headers from ' + u.host + ' within ' + headersTimeoutMs + ' ms after the request was sent' + (idempotent ? '' : ' (not retried: the request may be processing)'), { provider, retryable: idempotent }));
      }, headersTimeoutMs);
    });
    const onAbort = () => { req.destroy(); done(reject, new ProviderError(ERROR_CODES.ABORTED, 'request aborted', { provider })); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => done(resolve, res));
    req.on('error', (err) => done(reject, networkError(err, u.host, provider, { bodySent, idempotent })));
    if (payload) req.write(payload);
    req.end();
  });
}

// Reads a whole body with a size cap and a total deadline. Nothing here is retryable: headers (a 2xx or
// an error status) have already arrived, so the server has processed the request.
function readBody(res, { maxBodyBytes, deadlineMs, provider, host }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { res.destroy(); reject(new ProviderError(ERROR_CODES.TIMEOUT, 'body from ' + host + ' not complete in time', { provider })); }, Math.max(1, deadlineMs));
    res.on('data', (c) => {
      size += c.length;
      if (size > maxBodyBytes) {
        clearTimeout(timer); res.destroy();
        reject(new ProviderError(ERROR_CODES.BAD_RESPONSE, 'response from ' + host + ' larger than ' + maxBodyBytes + ' bytes', { provider }));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    res.on('error', (err) => { clearTimeout(timer); reject(new ProviderError(ERROR_CODES.NETWORK, 'network error (' + (err && err.code ? err.code : 'ERR') + ') while reading the body from ' + host, { provider, cause: err })); });
  });
}

export function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new ProviderError(ERROR_CODES.ABORTED, 'aborted')); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ProviderError(ERROR_CODES.ABORTED, 'aborted')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Bounded retry with exponential backoff and full jitter.
export async function withRetry(fn, { maxRetries = 2, baseDelayMs = DEFAULTS.retryBaseDelayMs, maxDelayMs = DEFAULTS.retryMaxDelayMs, signal, sleep = defaultSleep, random = Math.random, onRetry } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = err instanceof ProviderError && err.retryable;
      if (!retryable || attempt >= maxRetries || (signal && signal.aborted)) throw err;
      if (err.retryAfterMs != null && err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      let delay = Math.floor(random() * ceiling);
      if (err.retryAfterMs != null) delay = Math.max(delay, err.retryAfterMs);
      if (onRetry) onRetry({ attempt: attempt + 1, delayMs: delay, code: err.code, status: err.status });
      await sleep(delay, signal);
    }
  }
}

// Headers-wait budget for a buffered call: a non-idempotent call (a chat) may legitimately take the
// whole totalTimeoutMs before the first byte; GET/HEAD get the smaller firstByteTimeoutMs.
function bufferedHeadersTimeout(method, t) {
  return IDEMPOTENT_METHODS.has(String(method).toUpperCase()) ? Math.min(t.firstByteTimeoutMs, t.totalTimeoutMs) : t.totalTimeoutMs;
}

// Buffered request: resolves { status, headers, text } for a 2xx, throws a classified ProviderError
// otherwise. Retries per the rules above.
export async function requestText({ url, method = 'GET', headers = {}, body = null, provider = null, signal, timeouts = {}, maxRetries, sleep, random, onRetry } = {}) {
  const t = { ...DEFAULTS, ...timeouts };
  const host = hostOf(url);
  const retries = maxRetries !== undefined ? maxRetries : defaultMaxRetries(method);
  return withRetry(async () => {
    const started = Date.now();
    const res = await openRequest({ url, method, headers, body, connectTimeoutMs: t.connectTimeoutMs, headersTimeoutMs: bufferedHeadersTimeout(method, t), signal, provider });
    const text = await readBody(res, { maxBodyBytes: t.maxBodyBytes, deadlineMs: t.totalTimeoutMs - (Date.now() - started), provider, host });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw classifyHttpError(res.statusCode, text, { provider, host, retryAfter: res.headers['retry-after'] });
    }
    return { status: res.statusCode, headers: res.headers, text };
  }, { maxRetries: retries, signal, sleep, random, onRetry });
}

export async function requestJSON(opts) {
  const r = await requestText(opts);
  try {
    return { ...r, json: r.text ? JSON.parse(r.text) : null };
  } catch {
    throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'response from ' + hostOf(opts.url) + ' is not JSON', { provider: opts.provider || null });
  }
}

// Streaming request: resolves { status, headers, chunks } where chunks is an async iterable of decoded
// text. Headers must arrive within firstByteTimeoutMs after the request was sent. A non-2xx response
// is read (capped) and thrown as a classified error, with the same bounded retry as above. After a 2xx
// nothing is retried.
export async function requestStream({ url, method = 'POST', headers = {}, body = null, provider = null, signal, timeouts = {}, maxRetries, sleep, random, onRetry } = {}) {
  const t = { ...DEFAULTS, ...timeouts };
  const host = hostOf(url);
  const retries = maxRetries !== undefined ? maxRetries : defaultMaxRetries(method);
  const res = await withRetry(async () => {
    const r = await openRequest({ url, method, headers, body, connectTimeoutMs: t.connectTimeoutMs, headersTimeoutMs: t.firstByteTimeoutMs, signal, provider });
    if (r.statusCode < 200 || r.statusCode >= 300) {
      const text = await readBody(r, { maxBodyBytes: 64 * 1024, deadlineMs: Math.min(ERROR_BODY_TIMEOUT_MS, t.totalTimeoutMs), provider, host }).catch(() => '');
      throw classifyHttpError(r.statusCode, text, { provider, host, retryAfter: r.headers['retry-after'] });
    }
    return r;
  }, { maxRetries: retries, signal, sleep, random, onRetry });
  return { status: res.statusCode, headers: res.headers, chunks: iterateBody(res, { idleTimeoutMs: t.idleTimeoutMs, signal, provider, host }) };
}

async function* iterateBody(res, { idleTimeoutMs, signal, provider, host }) {
  const decoder = new TextDecoder('utf-8');
  let timer = null;
  let timedOut = false;
  let finished = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; res.destroy(new Error('idle')); }, idleTimeoutMs);
  };
  const onAbort = () => res.destroy(new Error('aborted'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  arm();
  try {
    for await (const chunk of res) {
      arm();
      const text = decoder.decode(chunk, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
    finished = true;
  } catch (err) {
    if (timedOut) throw new ProviderError(ERROR_CODES.TIMEOUT, 'stream from ' + host + ' idle for ' + idleTimeoutMs + ' ms', { provider });
    if (signal && signal.aborted) throw new ProviderError(ERROR_CODES.ABORTED, 'stream aborted', { provider });
    // After a 2xx nothing is retried, whatever the code.
    throw new ProviderError(ERROR_CODES.NETWORK, 'network error (' + (err && err.code ? err.code : 'ERR') + ') in the stream from ' + host, { provider, cause: err });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!finished) res.destroy(); // consumer stopped early: release the socket
  }
}
