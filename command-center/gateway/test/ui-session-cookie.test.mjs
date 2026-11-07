// FU-STEP2 (Security Boss decision A-prime, docs/forge-systeem/B3-permissions-security-decision.md
// sections 4-7, Step 2): the dashboard credential leaves the served HTML. It is delivered out of band
// as an HttpOnly, SameSite=Strict, Path=/ cookie: the desktop main process hands the gateway a secret
// through the environment and sets the cookie itself; a browser swaps a one-time pairing code (single
// use, 120 s) for the cookie. Every request here goes through the REAL composition root
// (server.mjs requestListener) on an ephemeral port, in mock execution mode (no real `claude`).
//
// The security module is imported as a namespace on purpose: on the code from before this change the
// new functions are simply missing, so each test fails on its own (RED) instead of the whole file
// failing to load.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import * as security from '../src/security.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { setGatewayPort } from '../src/runtime-state.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { _resetAskStoreForTests } from '../src/ask-store.mjs';
import { _resetPermissionStoreForTests } from '../src/permissions/store.mjs';
import { execSpawnEnv, ASK_AGENT_TOKEN_ENV } from '../src/exec-cli.mjs';
import { TOKEN_ERROR_CODES } from '../src/routes/permissions.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';
import { needsBuiltDashboard } from './.real-data-guard.mjs';

const NEEDS_BUILD = needsBuiltDashboard();
const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const COOKIE_NAME = security.UI_SESSION_COOKIE || 'forge_ui';
const DEV_ORIGIN = 'http://127.0.0.1:5173';
const PAIRING_TTL_MS = 120000;

let server;
let port;
let tempDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-session-'));
  _setConversationsDirForTests(tempDir);
  _resetProjectsCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  // What bin.mjs does once it is bound: the gateway's own origin (an allowed Origin) follows this port.
  setGatewayPort(port);
});

after(async () => {
  delete process.env.CC_EXEC_MOCK;
  _resetConversationsForTests();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetExecBridgeForTests();
  _resetAskStoreForTests();
  _resetPermissionStoreForTests();
});

afterEach(() => {
  if (typeof security._setUiSessionClockForTests === 'function') security._setUiSessionClockForTests(null);
});

/** A fresh one-time pairing code, minted in-process (no HTTP route can mint one). */
function freshCode() {
  assert.equal(typeof security.issuePairingCode, 'function', 'security.mjs must export issuePairingCode()');
  return security.issuePairingCode();
}

function setCookies(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Pairs through the real `GET /?pair=` swap and returns the `name=value` pair the browser would store. */
async function pairedCookie() {
  const res = await request(port, '/?pair=' + freshCode(), { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(res.statusCode, 302, 'a valid pairing code answers 302');
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1, 'exactly one Set-Cookie on the swap');
  return cookies[0].split(';')[0];
}

/** POST without the in-process header token: the cookie is the only credential. */
function postWithCookie(urlPath, jsonBody, cookie, headers = {}) {
  return requestWithBody(port, urlPath, { jsonBody, omitExecToken: true, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
}

function childToken(convId) {
  const cfg = path.join(tempDir, 'cfg-' + convId + '.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'forge-ask': { env: { CC_ASK_CONV_ID: convId } } } }), 'utf8');
  return execSpawnEnv({ askMcpConfigPath: cfg })[ASK_AGENT_TOKEN_ENV];
}

// ---------------------------------------------------------------- the served HTML

test('RED-first: the served HTML carries no token of any kind and never sets a cookie (GET /, /index.html, an SPA path)', { skip: NEEDS_BUILD }, async () => {
  for (const urlPath of ['/', '/index.html', '/chat/some/deep/route']) {
    const res = await request(port, urlPath, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(res.statusCode, 200, urlPath);
    assert.ok(!res.body.includes(security.getExecToken()), urlPath + ': the exec token must not be in the page');
    assert.doesNotMatch(res.body, /<meta[^>]*cc-exec-token/i, urlPath + ': no token meta tag');
    assert.equal(setCookies(res).length, 0, urlPath + ': a plain page load never sets the cookie');
  }
});

// ---------------------------------------------------------------- the pairing swap

test('RED-first: a fresh pairing code swaps for an HttpOnly; SameSite=Strict; Path=/ session cookie and a 302 to the clean URL /', async () => {
  const res = await request(port, '/?pair=' + freshCode(), { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/');
  assert.match(String(res.headers['cache-control']), /no-store/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1);
  const parts = cookies[0].split(';').map((p) => p.trim());
  assert.match(parts[0], new RegExp('^' + COOKIE_NAME + '=[A-Za-z0-9_-]{32,}$'));
  const flags = parts.slice(1).map((p) => p.toLowerCase());
  assert.ok(flags.includes('httponly'), 'HttpOnly');
  assert.ok(flags.includes('samesite=strict'), 'SameSite=Strict');
  assert.ok(flags.includes('path=/'), 'Path=/');
  assert.ok(!flags.some((f) => f.startsWith('domain=')), 'no Domain attribute (host-only cookie)');
  assert.ok(!flags.some((f) => f.startsWith('max-age=') || f.startsWith('expires=')), 'a session cookie, never persisted with an expiry');
});

test('RED-first: a pairing code works exactly once; the second use redirects without a cookie', async () => {
  const code = freshCode();
  const first = await request(port, '/?pair=' + code, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(setCookies(first).length, 1);
  const second = await request(port, '/?pair=' + code, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(second.statusCode, 302, 'a used code still lands on the clean URL');
  assert.equal(second.headers.location, '/');
  assert.equal(setCookies(second).length, 0, 'a used code never sets the cookie again');
});

test('RED-first: a pairing code expires after 120 s', async () => {
  assert.equal(typeof security._setUiSessionClockForTests, 'function');
  let now = 1_800_000_000_000;
  security._setUiSessionClockForTests(() => now);
  const late = freshCode();
  const inTime = freshCode();
  now += PAIRING_TTL_MS - 1;
  const ok = await request(port, '/?pair=' + inTime, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(setCookies(ok).length, 1, 'one millisecond before the end it still works');
  now += 2;
  const expired = await request(port, '/?pair=' + late, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(expired.statusCode, 302);
  assert.equal(setCookies(expired).length, 0, 'an expired code never sets the cookie');
});

test('an unknown, empty or malformed pairing code, or one on another path, never sets the cookie', async () => {
  for (const urlPath of ['/?pair=0123456789abcdef0123456789abcdef', '/?pair=', '/?pair=%zz', '/?pair=' + 'a'.repeat(5000), '/index.html?pair=x']) {
    const res = await request(port, urlPath, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(setCookies(res).length, 0, urlPath);
  }
  if (typeof security.issuePairingCode === 'function') {
    const code = security.issuePairingCode();
    const other = await request(port, '/chat?pair=' + code, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(setCookies(other).length, 0, 'only GET / swaps a code');
    const post = await requestWithBody(port, '/?pair=' + code, { jsonBody: {}, omitExecToken: true });
    assert.equal(setCookies(post).length, 0, 'a POST never swaps a code');
  }
});

test('a cross-site navigation to the pairing link is refused before the code is touched', async () => {
  if (typeof security.issuePairingCode !== 'function') assert.fail('security.mjs must export issuePairingCode()');
  const code = security.issuePairingCode();
  const cross = await request(port, '/?pair=' + code, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.statusCode, 403);
  assert.equal(setCookies(cross).length, 0);
  const real = await request(port, '/?pair=' + code, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(setCookies(real).length, 1, 'the refused attempt did not burn the code');
});

// ---------------------------------------------------------------- the cookie as the dashboard credential

test('RED-first: the cookie alone authenticates a dashboard write route; no or a wrong cookie gets 403 ui_session_required', async () => {
  const cookie = await pairedCookie();
  const ok = await postWithCookie('/api/conversations', { project: THIS_PROJECT_NAME }, cookie, { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://127.0.0.1:' + port });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.json));
  assert.equal(setCookies(ok).length, 0, 'an API answer never carries Set-Cookie');

  const none = await postWithCookie('/api/conversations', { project: THIS_PROJECT_NAME }, null);
  assert.equal(none.statusCode, 403);
  assert.equal(none.json.code, 'ui_session_required');

  const wrong = await postWithCookie('/api/conversations', { project: THIS_PROJECT_NAME }, COOKIE_NAME + '=' + 'f'.repeat(64));
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json.code, 'ui_session_required');
});

test('RED-first: a tossed junk cookie with the same name next to the real one does not lock the window out', async () => {
  const cookie = await pairedCookie();
  const res = await postWithCookie('/api/conversations', { project: THIS_PROJECT_NAME }, COOKIE_NAME + '=junk; ' + cookie + '; other=1');
  assert.equal(res.statusCode, 201, JSON.stringify(res.json));
});

test('CSRF: a cross-site POST that carries the cookie is refused (foreign Origin, foreign same-site port, same-site without Origin)', async () => {
  const cookie = await pairedCookie();
  const body = { project: THIS_PROJECT_NAME };
  const crossSite = await postWithCookie('/api/conversations', body, cookie, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' });
  assert.equal(crossSite.statusCode, 403);
  const otherLocalPort = await postWithCookie('/api/conversations', body, cookie, { 'Sec-Fetch-Site': 'same-site', Origin: 'http://127.0.0.1:9999' });
  assert.equal(otherLocalPort.statusCode, 403, 'a page on another loopback port is same-site but not an allowed origin');
  const sameSiteNoOrigin = await postWithCookie('/api/conversations', body, cookie, { 'Sec-Fetch-Site': 'same-site' });
  assert.equal(sameSiteNoOrigin.statusCode, 403);
  assert.equal(sameSiteNoOrigin.json.code, 'cross_site_cookie_refused', 'a same-site cookie request must name an allowed Origin');
  const formShape = await requestWithBody(port, '/api/conversations', {
    rawBody: 'project=' + encodeURIComponent(THIS_PROJECT_NAME),
    omitExecToken: true,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', Origin: 'null' },
  });
  assert.equal(formShape.statusCode, 403, 'a cross-site form post (Origin: null) is refused');
});

// Security fix round (Security Boss FAIL, HIGH): before it, the :5173 origins got credentialed CORS on EVERY
// gateway. A script on any Vite project page (localhost:5173 is the default of every Vite app the owner or the
// agent runs) could then read transcripts and, in a paired browser, write as the dashboard. They are trusted only
// with the explicit dev switch FORGE_DEV_ORIGINS=1 (security.mjs devOriginsEnabled; see dev-origins-switch.test.mjs).
test('RED-first (security fix round): without the dev switch a Vite dev page (:5173) can neither read a transcript nor write with the cookie', async () => {
  const cookie = await pairedCookie();
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(created.statusCode, 201, JSON.stringify(created.json));
  const transcript = '/api/conversations/' + created.json.conversation.id;
  for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
    const write = await postWithCookie('/api/conversations', { project: THIS_PROJECT_NAME }, cookie, { 'Sec-Fetch-Site': 'same-site', Origin: origin });
    assert.equal(write.statusCode, 403, origin + ': a cookie write from a Vite dev page is refused: ' + JSON.stringify(write.json));
    assert.equal(write.headers['access-control-allow-origin'], undefined, origin + ': no CORS answer on the refused write');
    for (const headers of [{ Origin: origin, 'Sec-Fetch-Site': 'same-site', Cookie: cookie }, { Origin: origin }]) {
      const read = await request(port, transcript, { headers });
      assert.equal(read.headers['access-control-allow-origin'], undefined, origin + ': a transcript read gets no Access-Control-Allow-Origin');
      assert.equal(read.headers['access-control-allow-credentials'], undefined, origin + ': and no Access-Control-Allow-Credentials');
      assert.ok(!read.body.includes(created.json.conversation.id), origin + ': the transcript is not in the answer');
    }
    const preflight = await request(port, '/api/conversations', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-site', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.notEqual(preflight.statusCode, 204, origin + ': no preflight approval');
    assert.equal(preflight.headers['access-control-allow-origin'], undefined, origin);
  }
});

test('with the dev switch on (FORGE_DEV_ORIGINS=1) the Vite dev origin (:5173) may use the cookie with credentials, and gets the CORS answer it needs', async (t) => {
  assert.equal(typeof security._setDevOriginsForTests, 'function', 'security.mjs must export _setDevOriginsForTests()');
  security._setDevOriginsForTests(true);
  t.after(() => security._setDevOriginsForTests(null));
  const cookie = await pairedCookie();
  const res = await postWithCookie('/api/conversations', { project: THIS_PROJECT_NAME }, cookie, { 'Sec-Fetch-Site': 'same-site', Origin: DEV_ORIGIN });
  assert.equal(res.statusCode, 201, JSON.stringify(res.json));
  assert.equal(res.headers['access-control-allow-origin'], DEV_ORIGIN);
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  assert.match(String(res.headers.vary), /Origin/);

  const preflight = await request(port, '/api/conversations', {
    method: 'OPTIONS',
    headers: { Origin: DEV_ORIGIN, 'Sec-Fetch-Site': 'same-site', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], DEV_ORIGIN);
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
  assert.match(String(preflight.headers['access-control-allow-methods']), /POST/);
  assert.match(String(preflight.headers['access-control-allow-headers']).toLowerCase(), /content-type/);

  const foreign = await request(port, '/api/conversations', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);

  const noOrigin = await request(port, '/api/health');
  assert.equal(noOrigin.headers['access-control-allow-origin'], undefined, 'no CORS header without an allowed Origin');
});

test('RED-first: GET /api/ui-session tells the window whether it is paired, and never echoes the secret', async () => {
  const unpaired = await request(port, '/api/ui-session');
  assert.equal(unpaired.statusCode, 200);
  assert.deepEqual(unpaired.json, { ok: true, paired: false });
  const cookie = await pairedCookie();
  const paired = await request(port, '/api/ui-session', { headers: { Cookie: cookie } });
  assert.deepEqual(paired.json, { ok: true, paired: true });
  assert.ok(!paired.body.includes(cookie.split('=')[1]), 'the secret is never in a response body');
  assert.equal(setCookies(paired).length, 0);
});

// ---------------------------------------------------------------- the agent side stays as it is

test('the agent token cannot answer a permission card, with or without a forged cookie; the paired window can', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(created.statusCode, 201);
  const convId = created.json.conversation.id;
  const agent = childToken(convId);
  const card = await requestWithBody(port, '/api/permissions/request', {
    omitExecToken: true,
    headers: { 'x-cc-exec-token': agent },
    jsonBody: { conv_id: convId, tool_name: 'Bash', input: { command: 'ls' } },
  });
  assert.equal(card.statusCode, 200, JSON.stringify(card.json));
  const answerPath = '/api/permissions/' + card.json.id + '/answer';

  const byAgent = await requestWithBody(port, answerPath, { omitExecToken: true, headers: { 'x-cc-exec-token': agent }, jsonBody: { behavior: 'allow' } });
  assert.equal(byAgent.statusCode, 403);
  assert.equal(byAgent.json.code, TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED);
  const forged = await requestWithBody(port, answerPath, {
    omitExecToken: true,
    headers: { 'x-cc-exec-token': agent, Cookie: COOKIE_NAME + '=' + agent },
    jsonBody: { behavior: 'allow' },
  });
  assert.equal(forged.statusCode, 403, 'the agent token used as a cookie value is not the session secret');

  const cookie = await pairedCookie();
  const byWindow = await postWithCookie(answerPath, { behavior: 'deny' }, cookie, { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://127.0.0.1:' + port });
  assert.equal(byWindow.statusCode, 200, JSON.stringify(byWindow.json));
});

test('the cookie never opens an agent-only route (request/wait stay agent-token only)', async () => {
  const cookie = await pairedCookie();
  const res = await postWithCookie('/api/permissions/request', { conv_id: 'c-x', tool_name: 'Bash', input: { command: 'ls' } }, cookie);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.code, TOKEN_ERROR_CODES.AGENT_TOKEN_REQUIRED);
});

test('the trust route stays unregistered: POST /api/permissions/trust with the cookie is still a 405', async () => {
  const cookie = await pairedCookie();
  const res = await postWithCookie('/api/permissions/trust', { project: THIS_PROJECT_NAME, trusted: true }, cookie);
  assert.equal(res.statusCode, 405);
});

// ---------------------------------------------------------------- why the header path is kept

test('the in-process header token still works (kept ONLY for the gateway route tests: test-support/helpers.mjs sends getExecToken())', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(res.statusCode, 201, 'helpers.mjs requestWithBody() authenticates with the in-process token');
});
