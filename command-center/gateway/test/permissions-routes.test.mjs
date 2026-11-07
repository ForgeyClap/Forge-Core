// WP B3 (plan 4.4) + WP B3-sec-impl: routes/permissions.mjs over real HTTP against the real store.
// server.mjs is the Lead's file, so this test mounts the module exactly the way
// _scratch/b3/patches-gw.md registers it: the write-route allowlist uses isPermissionWriteRoute,
// every non-GET request goes through checkWriteToken once, and the route table is REGISTERED_ROUTES
// (request, pending, wait, answer; the trust routes are NOT registered in this release). The server's
// own route-table test covers the registration itself once the patch is applied; the last test here
// checks that whatever server.mjs registers for this family equals REGISTERED_ROUTES.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as permissions from '../src/routes/permissions.mjs';
import { sendJson } from '../src/routes/http.mjs';
import { issueAgentToken, getExecToken, EXEC_TOKEN_HEADER, _resetAgentTokensForTests } from '../src/security.mjs';
import { PROJECT_ROOT, SYNC_SCAN_ROOTS } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, readConversation } from '../src/conversations.mjs';
import { _resetPermissionStoreForTests } from '../src/permissions/store.mjs';
import { _setTrustFileForTests, isProjectTrusted } from '../src/permissions/trust.mjs';
import { describeRoutes } from '../src/server.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
// FU-STEP2 (Security Boss Step 2): a dashboard route with no valid credential now names its code, so the
// dashboard can show its pairing card. Step 1a kept this body byte-identical to the pre-B3 one; Step 2
// changes it on purpose (the text still names the execution token for older callers' messages).
const OLD_TOKEN_BODY = {
  ok: false,
  error: 'missing or invalid session cookie or execution token (x-cc-exec-token header): this window is not paired with Forge; open a new pairing link from the launcher',
  code: 'ui_session_required',
};

function matchRoute(table, method, pathname) {
  for (const [m, p, handler] of table) {
    if (m !== method) continue;
    const match = typeof p === 'string' ? (p === pathname ? [] : null) : pathname.match(p);
    if (match) return { handler, match };
  }
  return null;
}

// Mounted exactly like patches-gw.md: method guard -> checkWriteToken -> REGISTERED_ROUTES -> 404.
function listener(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && !(req.method === 'POST' && permissions.isPermissionWriteRoute(url.pathname))) {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }
  const refused = req.method !== 'GET' ? permissions.checkWriteToken(req, url.pathname) : null;
  if (refused) return sendJson(res, refused.status, refused.body);
  const found = matchRoute(permissions.REGISTERED_ROUTES, req.method, url.pathname);
  if (!found) return sendJson(res, 404, { ok: false, error: 'not found' });
  return permissions[found.handler](req, res, { pathname: url.pathname, searchParams: url.searchParams, match: found.match })
    .catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
}

// The trust handlers on their own (Security Boss Step 2 would register them; nothing does today).
const TRUST_TABLE = [['GET', permissions.PERMISSION_TRUST_PATH, 'trustGet'], ['POST', permissions.PERMISSION_TRUST_PATH, 'trustPost']];
function trustListener(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const found = matchRoute(TRUST_TABLE, req.method, url.pathname);
  if (!found) return sendJson(res, 404, { ok: false, error: 'not found' });
  return permissions[found.handler](req, res, { pathname: url.pathname, searchParams: url.searchParams, match: found.match })
    .catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
}

let server;
let port;
let trustServer;
let trustPort;
let tempDir;

async function listen(fn) {
  const s = http.createServer(fn);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return s;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-routes-'));
  _setConversationsDirForTests(tempDir);
  _setTrustFileForTests(path.join(tempDir, 'trusted-projects.json'));
  _resetProjectsCacheForTests();
  server = await listen(listener);
  port = server.address().port;
  trustServer = await listen(trustListener);
  trustPort = trustServer.address().port;
});
after(async () => {
  _setTrustFileForTests(null);
  _resetConversationsForTests();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => trustServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  _resetPermissionStoreForTests();
  _resetAgentTokensForTests();
});

const conv = () => createConversation({ project: THIS_PROJECT_NAME, title: 'perm' }).id;
const asAgent = (convId) => ({ headers: { [EXEC_TOKEN_HEADER]: issueAgentToken(convId) } });
/** POST with the dashboard token (requestWithBody's default) unless opts override the header. */
const post = (p, jsonBody, opts = {}) => requestWithBody(port, p, { jsonBody, ...opts });

test('request (agent) -> pending (with groups and rememberable) -> answer (dashboard) -> wait (agent) returns the decision; events logged', async () => {
  const convId = conv();
  const created = await post('/api/permissions/request', { conv_id: convId, turn_id: 't1', request_id: 'r1', tool_name: 'Bash', input: { command: 'rm index.html' }, tool_use_id: 'toolu_1' }, asAgent(convId));
  assert.equal(created.statusCode, 200);
  const id = created.json.id;
  assert.match(id, /^perm-/);

  const listed = await request(port, '/api/permissions/pending?conversation=' + convId);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json.pending.length, 1);
  assert.equal(listed.json.pending[0].summary_nl, '1 bestand verwijderen: index.html');
  assert.equal(listed.json.pending[0].rememberable, false, 'a shell command is never rememberable');
  assert.equal(listed.json.groups[0].count, 1);

  const pendingWait = post('/api/permissions/' + id + '/wait', { wait_ms: 5000 }, asAgent(convId));
  const answered = await post('/api/permissions/' + id + '/answer', { behavior: 'allow_session' });
  assert.equal(answered.statusCode, 200);
  assert.deepEqual(answered.json, { ok: true, id, behavior: 'allow', remembered: false }, 'allow_session on a shell call is applied as a one-time allow');
  const waited = await pendingWait;
  assert.equal(waited.statusCode, 200);
  assert.deepEqual(waited.json, { ok: true, decided: true, behavior: 'allow', updatedInput: { command: 'rm index.html' } });

  const kinds = readConversation(convId).events.map((e) => e.kind);
  assert.deepEqual(kinds, ['permission_requested', 'permission_answered']);
});

test('wait answers {decided:false} within wait_ms while nobody answered (the client polls again)', async () => {
  const convId = conv();
  const { json } = await post('/api/permissions/request', { conv_id: convId, tool_name: 'WebFetch', input: { url: 'https://a.test' } }, asAgent(convId));
  const t0 = Date.now();
  const waited = await post('/api/permissions/' + json.id + '/wait', { wait_ms: 50 }, asAgent(convId));
  assert.deepEqual(waited.json, { ok: true, decided: false });
  assert.ok(Date.now() - t0 < 3000);
});

test('errors: unknown conversation 404, bad input 400, unknown field 400, unknown id 404, bad behavior 400, double answer 409', async () => {
  const convId = conv();
  const ghost = 'c-nope-1';
  assert.equal((await post('/api/permissions/request', { conv_id: ghost, tool_name: 'Bash', input: {} }, asAgent(ghost))).statusCode, 404);
  assert.equal((await post('/api/permissions/request', { conv_id: convId, tool_name: 'Bash', input: 'rm' }, asAgent(convId))).statusCode, 400);
  assert.equal((await post('/api/permissions/request', { conv_id: convId, tool_name: 'Bash', input: {}, extra: 1 }, asAgent(convId))).statusCode, 400);
  assert.equal((await post('/api/permissions/perm-nope/wait', { wait_ms: 10 }, asAgent(convId))).statusCode, 404);
  assert.equal((await post('/api/permissions/perm-nope/answer', { behavior: 'allow' })).statusCode, 404);
  const { json } = await post('/api/permissions/request', { conv_id: convId, tool_name: 'Bash', input: { command: 'ls' } }, asAgent(convId));
  assert.equal((await post('/api/permissions/' + json.id + '/answer', { behavior: 'maybe' })).statusCode, 400);
  assert.equal((await post('/api/permissions/' + json.id + '/answer', { behavior: 'deny' })).statusCode, 200);
  assert.equal((await post('/api/permissions/' + json.id + '/answer', { behavior: 'allow' })).statusCode, 409);
  assert.equal((await request(port, '/api/permissions/pending?conversation=..%2Fx')).statusCode, 400);
});

test('REGRESSION (Step 1a): request and wait accept ONLY the agent token; answer accepts ONLY the dashboard token; each wrong kind is a 403 with its own code', async () => {
  const convId = conv();
  const body = { conv_id: convId, tool_name: 'Bash', input: { command: 'ls' } };

  const dashboardOnRequest = await post('/api/permissions/request', body);
  assert.equal(dashboardOnRequest.statusCode, 403);
  assert.equal(dashboardOnRequest.json.code, permissions.TOKEN_ERROR_CODES.DASHBOARD_TOKEN_REFUSED);
  const noneOnRequest = await post('/api/permissions/request', body, { omitExecToken: true });
  assert.equal(noneOnRequest.statusCode, 403);
  assert.equal(noneOnRequest.json.code, permissions.TOKEN_ERROR_CODES.AGENT_TOKEN_REQUIRED);

  const { json } = await post('/api/permissions/request', body, asAgent(convId));
  const dashboardOnWait = await post('/api/permissions/' + json.id + '/wait', { wait_ms: 10 });
  assert.equal(dashboardOnWait.statusCode, 403);
  assert.equal(dashboardOnWait.json.code, permissions.TOKEN_ERROR_CODES.DASHBOARD_TOKEN_REFUSED);

  const agentOnAnswer = await post('/api/permissions/' + json.id + '/answer', { behavior: 'allow' }, asAgent(convId));
  assert.equal(agentOnAnswer.statusCode, 403);
  assert.equal(agentOnAnswer.json.code, permissions.TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED);
  const noneOnAnswer = await post('/api/permissions/' + json.id + '/answer', { behavior: 'allow' }, { omitExecToken: true });
  assert.equal(noneOnAnswer.statusCode, 403);
  assert.deepEqual(noneOnAnswer.json, OLD_TOKEN_BODY, 'no token on a dashboard route: the old body, byte for byte');

  const real = await post('/api/permissions/' + json.id + '/answer', { behavior: 'deny' });
  assert.equal(real.statusCode, 200, 'a refused attempt never consumed the card');
  assert.equal((await request(port, '/api/permissions/pending')).statusCode, 200, 'GET pending needs no token');
});

test('REGRESSION (Step 1a): the agent token is bound to its conversation (request 403, wait 404 for another conversation)', async () => {
  const convA = conv();
  const convB = conv();
  const spoof = await post('/api/permissions/request', { conv_id: convB, tool_name: 'Bash', input: { command: 'ls' } }, asAgent(convA));
  assert.equal(spoof.statusCode, 403);
  assert.equal(spoof.json.code, permissions.TOKEN_ERROR_CODES.CONVERSATION_MISMATCH);
  const { json } = await post('/api/permissions/request', { conv_id: convB, tool_name: 'Bash', input: { command: 'ls' } }, asAgent(convB));
  const peek = await post('/api/permissions/' + json.id + '/wait', { wait_ms: 10 }, asAgent(convA));
  assert.equal(peek.statusCode, 404, 'another conversation\'s card looks unknown');
  await post('/api/permissions/' + json.id + '/answer', { behavior: 'allow' });
  assert.equal((await post('/api/permissions/' + json.id + '/wait', { wait_ms: 10 }, asAgent(convA))).statusCode, 404, 'also after the answer');
  assert.equal((await post('/api/permissions/' + json.id + '/wait', { wait_ms: 10 }, asAgent(convB))).json.behavior, 'allow');
});

test('the trust routes are NOT registered: POST is not a write route (405), GET has no route (404)', async () => {
  const postTrust = await post('/api/permissions/trust', { project: THIS_PROJECT_NAME, trusted: true });
  assert.equal(postTrust.statusCode, 405);
  const getTrust = await request(port, '/api/permissions/trust?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(getTrust.statusCode, 404);
  assert.equal(isProjectTrusted(PROJECT_ROOT), false);
});

test('REGISTERED_ROUTES is exactly request, pending, wait, answer; isPermissionWriteRoute covers exactly its three POST paths', () => {
  const rows = permissions.REGISTERED_ROUTES.map(([m, p, h]) => [m, typeof p === 'string' ? p : p.source, h]);
  assert.deepEqual(rows, [
    ['POST', '/api/permissions/request', 'request'],
    ['GET', '/api/permissions/pending', 'pending'],
    ['POST', '^\\/api\\/permissions\\/([^/]+)\\/wait$', 'wait'],
    ['POST', '^\\/api\\/permissions\\/([^/]+)\\/answer$', 'answer'],
  ]);
  assert.equal(rows.some(([, p, h]) => /trust/.test(p) || /trust/.test(h)), false);
  assert.ok(permissions.isPermissionWriteRoute('/api/permissions/request'));
  assert.ok(permissions.isPermissionWriteRoute('/api/permissions/perm-1/wait'));
  assert.ok(permissions.isPermissionWriteRoute('/api/permissions/perm-1/answer'));
  assert.equal(permissions.isPermissionWriteRoute('/api/permissions/trust'), false, 'the trust path is not a registered write route');
  assert.equal(permissions.isPermissionWriteRoute('/api/permissions/pending'), false);
  assert.equal(permissions.isPermissionWriteRoute('/api/permissions/a/b/answer'), false);
});

test('whatever server.mjs registers for this family is exactly REGISTERED_ROUTES (never a trust route)', () => {
  const registered = describeRoutes().filter((r) => r.module === permissions.MODULE).map((r) => [r.method, r.path, r.handler]);
  assert.equal(registered.some(([, p, h]) => /trust/.test(p) || /trust/.test(h)), false);
  if (registered.length > 0) {
    assert.deepEqual(registered, permissions.REGISTERED_ROUTES.map(([m, p, h]) => [m, typeof p === 'string' ? p : p.source, h]));
  }
});

test('checkWriteToken: the audience per route, and the old body for a dashboard route without a valid token', () => {
  const convId = conv();
  const agent = { headers: { [EXEC_TOKEN_HEADER]: issueAgentToken(convId) } };
  const dashboard = { headers: { [EXEC_TOKEN_HEADER]: getExecToken() } };
  const none = { headers: {} };
  const wrong = { headers: { [EXEC_TOKEN_HEADER]: 'not-a-token' } };
  const dashboardRoutes = ['/api/permissions/perm-1/answer', '/api/conversations', '/api/conversations/c-1/messages', '/api/config', '/api/ask/a-1/answer', '/api/permissions/trust', '/api/projects'];
  for (const p of dashboardRoutes) {
    assert.equal(permissions.writeTokenAudience(p), 'dashboard', p);
    assert.equal(permissions.checkWriteToken(dashboard, p), null, p);
    assert.equal(permissions.checkWriteToken(agent, p).body.code, permissions.TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED, p);
    assert.deepEqual(permissions.checkWriteToken(none, p), { status: 403, body: OLD_TOKEN_BODY }, p);
    assert.deepEqual(permissions.checkWriteToken(wrong, p), { status: 403, body: OLD_TOKEN_BODY }, p);
  }
  for (const p of ['/api/permissions/request', '/api/permissions/perm-1/wait']) {
    assert.equal(permissions.writeTokenAudience(p), 'agent', p);
    assert.equal(permissions.checkWriteToken(agent, p), null, p);
    assert.equal(permissions.checkWriteToken(dashboard, p).body.code, permissions.TOKEN_ERROR_CODES.DASHBOARD_TOKEN_REFUSED, p);
    assert.equal(permissions.checkWriteToken(none, p).body.code, permissions.TOKEN_ERROR_CODES.AGENT_TOKEN_REQUIRED, p);
  }
  assert.equal(permissions.writeTokenAudience('/api/ask'), 'agent_or_dashboard');
  assert.equal(permissions.checkWriteToken(agent, '/api/ask'), null, 'ask_owner (forge-ask server) uses the agent token');
  assert.equal(permissions.checkWriteToken(dashboard, '/api/ask'), null, 'still accepted for existing callers');
  assert.deepEqual(permissions.checkWriteToken(none, '/api/ask'), { status: 403, body: OLD_TOKEN_BODY });
});

test('trust handlers (not registered; mounted on their own for Step 2): GET/POST still work outside a project, refuse the agent token, and refuse a trust file inside a project', async () => {
  const getTrust = () => request(trustPort, '/api/permissions/trust?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  const postTrust = (jsonBody, opts = {}) => requestWithBody(trustPort, '/api/permissions/trust', { jsonBody, ...opts });
  assert.equal((await getTrust()).json.trusted, false, 'closed by default');
  assert.equal((await postTrust({ project: THIS_PROJECT_NAME, trusted: 'yes' })).statusCode, 400);
  assert.equal((await postTrust({ project: 'no-such-project-xyz', trusted: true })).statusCode, 404);
  const convId = conv();
  const byAgent = await postTrust({ project: THIS_PROJECT_NAME, trusted: true }, asAgent(convId));
  assert.equal(byAgent.statusCode, 403);
  assert.equal(byAgent.json.code, permissions.TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED);
  const on = await postTrust({ project: THIS_PROJECT_NAME, trusted: true });
  assert.equal(on.statusCode, 200);
  assert.equal(on.json.trusted, true);
  assert.equal(isProjectTrusted(PROJECT_ROOT), true);
  const off = await postTrust({ project: THIS_PROJECT_NAME, trusted: false });
  assert.equal(off.json.trusted, false);

  // A temp folder pushed onto the LIVE scan-root list (the config.test.mjs pattern) counts as a place
  // where projects live, so a trust file there must be refused.
  const scanRoot = path.join(tempDir, 'scan-root');
  fs.mkdirSync(scanRoot, { recursive: true });
  SYNC_SCAN_ROOTS.push(scanRoot);
  _setTrustFileForTests(path.join(scanRoot, 'trusted-projects.json'));
  try {
    const inside = await postTrust({ project: THIS_PROJECT_NAME, trusted: true });
    assert.equal(inside.statusCode, 409);
    assert.equal(inside.json.code, 'trust_file_inside_project');
    assert.equal(fs.existsSync(path.join(scanRoot, 'trusted-projects.json')), false, 'nothing was stored');
  } finally {
    SYNC_SCAN_ROOTS.splice(SYNC_SCAN_ROOTS.indexOf(scanRoot), 1);
    _setTrustFileForTests(path.join(tempDir, 'trusted-projects.json'));
  }
});
