'use strict';
// forge-skill-harvest-net.cjs — the only network layer of the skill harvester.
// gh: read-only `gh api -i` calls (argv array, no shell). HTTPS: plain GETs. Responses are DATA, never executed.
// Rate limits: one shared token bucket per resource (-bucket.cjs), wait for the reset on 403/429, bounded retries.
const https = require('https');
const { spawn } = require('child_process');
const { bucketFor, observeResponse } = require('./forge-skill-harvest-bucket.cjs');

const MAX_ATTEMPTS = 6;
const MAX_WAIT_MS = 65 * 60 * 1000;
const SECONDARY_WAIT_MS = 90 * 1000;
// Minimum gap per resource; the shared token bucket (-bucket.cjs) enforces it together with the documented limits.
const PACE_MS = { code_search: 6000, search: 2000, core: 0, graphql: 300 };

function redact(line) {
  return String(line)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
    .replace(/(authorization:\s*)(\S+\s*)+/gi, '$1[redacted]');
}

function parseGhOutput(stdout) {
  const s = String(stdout || '');
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(s);
  if (!m) return { status: 0, headers: {}, body: s };
  const sep = s.search(/\r?\n\r?\n/);
  const head = sep < 0 ? s : s.slice(0, sep);
  const body = sep < 0 ? '' : s.slice(sep).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers, body };
}

function rateLimitWaitMs(resp, now) {
  if (resp.status !== 403 && resp.status !== 429) return 0;
  const h = resp.headers || {};
  if (h['retry-after']) return Math.min(MAX_WAIT_MS, Number(h['retry-after']) * 1000);
  if (h['x-ratelimit-remaining'] === '0' && h['x-ratelimit-reset']) {
    return Math.min(MAX_WAIT_MS, Math.max(1000, Number(h['x-ratelimit-reset']) * 1000 - now + 1000));
  }
  if (resp.status === 429 || /rate limit/i.test(resp.body || '')) return SECONDARY_WAIT_MS;
  return 0;
}

const isGraphqlRateLimited = (json) => Array.isArray(json && json.errors) && json.errors.some((e) => e && e.type === 'RATE_LIMITED');

// Every call draws one token from the bucket shared by all workers on this ctx.
const pace = (ctx, resource) => bucketFor(ctx, resource).acquire(1);

// One gh api request with rate-limit handling. Returns { ok, status, json, headers, error }.
async function ghJson(ctx, args, { resource = 'core', input, serverRetries = MAX_ATTEMPTS } = {}) {
  ctx.requests = (ctx.requests || 0) + 1;
  if (ctx.maxRequests && ctx.requests > ctx.maxRequests) return { ok: false, status: 0, error: 'request_budget_spent' };
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await pace(ctx, resource);
    const resp = await ctx.gh(args, input);
    last = resp;
    let json = null;
    try { json = resp.body ? JSON.parse(resp.body) : null; } catch { json = null; }
    let wait = rateLimitWaitMs(resp, ctx.now());
    if (!wait) observeResponse(ctx, resource, resp.headers, json);
    if (!wait && resource === 'graphql' && isGraphqlRateLimited(json)) wait = SECONDARY_WAIT_MS;
    if (wait) {
      ctx.log(`rate-limit ${resource}: waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await ctx.sleep(wait);
      continue;
    }
    if (resp.status >= 500 || resp.status === 0) {
      if (attempt >= Math.min(serverRetries, MAX_ATTEMPTS)) break;
      ctx.log(`server error ${resp.status} on ${resource}: retry ${attempt}/${serverRetries - 1}`);
      await ctx.sleep(Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    const good = resp.status >= 200 && resp.status < 300;
    return { ok: good, status: resp.status, json, headers: resp.headers || {}, error: good ? null : `http_${resp.status}` };
  }
  const limited = last && (last.status === 403 || last.status === 429);
  return { ok: false, status: last ? last.status : 0, json: null, headers: {}, error: limited ? 'rate_limited' : 'server_error' };
}

// Async (spawn, not spawnSync), so parallel workers really overlap; same argv, no shell, same timeout and size cap.
const GH_TIMEOUT_MS = 180000;
const GH_MAX_BYTES = 512 * 1024 * 1024;
function realGh(args, input) {
  return new Promise((resolve) => {
    const fail = { status: 0, headers: {}, body: '' };
    let child;
    try { child = spawn('gh', ['api', '-i', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { resolve(fail); return; }
    const chunks = []; let size = 0; let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill(); finish(fail); }, GH_TIMEOUT_MS);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > GH_MAX_BYTES) { child.kill(); finish(fail); return; }
      chunks.push(c);
    });
    child.on('error', () => finish(fail));
    child.on('close', () => finish(parseGhOutput(Buffer.concat(chunks).toString('utf8'))));
    child.stdin.on('error', () => {}); // gh may close stdin early (EPIPE); its stdout still decides the result
    child.stdin.end(input === undefined ? '' : input);
  });
}

function httpsGet(url, { maxBytes = 64 * 1024 * 1024, timeoutMs = 60000, redirects = 5 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, body: '', error: 'bad_url' }); return; }
    if (u.protocol !== 'https:') { resolve({ status: 0, body: '', error: 'not_https' }); return; }
    const req = https.get(u, { headers: { 'User-Agent': 'forge-skill-harvest/1 (read-only research)' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, u).href, { maxBytes, timeoutMs, redirects: redirects - 1 }));
        return;
      }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      res.on('error', () => resolve({ status: 0, body: '', error: 'stream_error' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message === 'timeout' ? 'timeout' : 'net_error' }));
  });
}

// GET with bounded retries on 429 / 5xx / network errors.
async function getText(ctx, url) {
  let r = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    r = await ctx.get(url);
    if (r.status === 429 || r.status >= 500 || r.status === 0) { await ctx.sleep(3000 * attempt); continue; }
    break;
  }
  return r;
}

function realCtx({ maxRequests = 0, log } = {}) {
  return {
    gh: realGh, get: (u) => httpsGet(u), maxRequests,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    log: log || ((line) => process.stdout.write(redact(line) + '\n')),
  };
}

module.exports = { MAX_ATTEMPTS, MAX_WAIT_MS, PACE_MS, redact, parseGhOutput, rateLimitWaitMs, ghJson, httpsGet, getText, realCtx };
