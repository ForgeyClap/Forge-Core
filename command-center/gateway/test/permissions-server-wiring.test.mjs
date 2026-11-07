// WP B3-sec-impl: the permission routes and the token split through the REAL composition root
// (server.mjs requestListener), in mock execution mode (no real `claude`). For the Lead: copy this
// file to gateway/test/ in the same commit that applies _scratch/b3/patches-gw.md; it fails on a
// server.mjs without the patch (the agent token is refused everywhere) and passes with it.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, describeRoutes } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { _resetAskStoreForTests } from '../src/ask-store.mjs';
import { _resetPermissionStoreForTests } from '../src/permissions/store.mjs';
import { execSpawnEnv, ASK_AGENT_TOKEN_ENV, ASK_EXEC_TOKEN_ENV } from '../src/exec-cli.mjs';
import { EXEC_TOKEN_HEADER } from '../src/security.mjs';
import { REGISTERED_ROUTES, MODULE, TOKEN_ERROR_CODES } from '../src/routes/permissions.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
// FU-STEP2 (Security Boss Step 2): the no-credential body now carries `code: ui_session_required` (the
// dashboard's pairing card keys on it); Step 1a had kept it byte-identical to the pre-B3 body.
const OLD_TOKEN_BODY = {
  ok: false,
  error: 'missing or invalid session cookie or execution token (x-cc-exec-token header): this window is not paired with Forge; open a new pairing link from the launcher',
  code: 'ui_session_required',
};

let server;
let port;
let tempDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-wiring-'));
  _setConversationsDirForTests(tempDir);
  _resetProjectsCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
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

async function makeConversation() {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(created.statusCode, 201);
  return created.json.conversation.id;
}

/** The token a real turn of `convId` hands its `claude` child (and so every process the agent starts). */
function childToken(convId) {
  const cfg = path.join(tempDir, 'cfg-' + convId + '.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'forge-ask': { env: { CC_ASK_CONV_ID: convId } } } }), 'utf8');
  const env = execSpawnEnv({ askMcpConfigPath: cfg });
  assert.equal(ASK_EXEC_TOKEN_ENV in env, false, 'the dashboard token is never in the child environment');
  return env[ASK_AGENT_TOKEN_ENV];
}

const withToken = (token, extra = {}) => ({ headers: { [EXEC_TOKEN_HEADER]: token }, ...extra });

test('the child token registers and long-polls its own card through the real server; only the dashboard token answers it', async () => {
  const convId = await makeConversation();
  const token = childToken(convId);
  const created = await requestWithBody(port, '/api/permissions/request', withToken(token, { jsonBody: { conv_id: convId, tool_name: 'Bash', input: { command: 'ls' } } }));
  assert.equal(created.statusCode, 200, JSON.stringify(created.json));
  const id = created.json.id;

  const listed = await request(port, '/api/permissions/pending?conversation=' + convId);
  assert.equal(listed.json.pending[0].rememberable, false);

  const selfAnswer = await requestWithBody(port, '/api/permissions/' + id + '/answer', withToken(token, { jsonBody: { behavior: 'allow' } }));
  assert.equal(selfAnswer.statusCode, 403);
  assert.equal(selfAnswer.json.code, TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED);

  const waiting = requestWithBody(port, '/api/permissions/' + id + '/wait', withToken(token, { jsonBody: { wait_ms: 5000 } }));
  const answered = await requestWithBody(port, '/api/permissions/' + id + '/answer', { jsonBody: { behavior: 'allow' } });
  assert.equal(answered.statusCode, 200);
  assert.equal((await waiting).json.behavior, 'allow');
});

test('the dashboard token is refused on request and wait (dashboard_token_refused)', async () => {
  const convId = await makeConversation();
  const req = await requestWithBody(port, '/api/permissions/request', { jsonBody: { conv_id: convId, tool_name: 'Bash', input: { command: 'ls' } } });
  assert.equal(req.statusCode, 403);
  assert.equal(req.json.code, TOKEN_ERROR_CODES.DASHBOARD_TOKEN_REFUSED);
  const wait = await requestWithBody(port, '/api/permissions/perm-x/wait', { jsonBody: { wait_ms: 10 } });
  assert.equal(wait.statusCode, 403);
  assert.equal(wait.json.code, TOKEN_ERROR_CODES.DASHBOARD_TOKEN_REFUSED);
});

test('the child token is refused on every dashboard write route; the trust routes do not exist', async () => {
  const convId = await makeConversation();
  const token = childToken(convId);
  const cases = [
    ['POST', '/api/conversations', { project: THIS_PROJECT_NAME }],
    ['POST', '/api/conversations/' + convId + '/messages', { text: 'hi', mode: 'bypass' }],
    ['POST', '/api/conversations/' + convId + '/stop', {}],
    ['PATCH', '/api/conversations/' + convId, { title: 'x' }],
    ['DELETE', '/api/conversations/' + convId, undefined],
    ['POST', '/api/config', { key: 'x', value: 'y' }],
    ['POST', '/api/projects', { name: 'x' }],
    ['POST', '/api/ask/ask-1/answer', { answers: [] }],
    ['POST', '/api/permissions/perm-1/answer', { behavior: 'allow' }],
  ];
  for (const [method, p, jsonBody] of cases) {
    const res = await requestWithBody(port, p, withToken(token, { method, jsonBody }));
    assert.equal(res.statusCode, 403, method + ' ' + p);
    assert.equal(res.json.code, TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED, method + ' ' + p);
  }
  assert.equal((await requestWithBody(port, '/api/permissions/trust', withToken(token, { jsonBody: { project: THIS_PROJECT_NAME, trusted: true } }))).statusCode, 405);
  assert.equal((await requestWithBody(port, '/api/permissions/trust', { jsonBody: { project: THIS_PROJECT_NAME, trusted: true } })).statusCode, 405);
  assert.equal((await request(port, '/api/permissions/trust?project=' + encodeURIComponent(THIS_PROJECT_NAME))).statusCode, 404);
});

test('no token on a dashboard write route: the old 403 body, byte for byte', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME }, omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, JSON.stringify(OLD_TOKEN_BODY));
});

test('ask_owner shares the mechanism: POST /api/ask accepts the child token; only the dashboard token answers the ask', async () => {
  const convId = await makeConversation();
  const token = childToken(convId);
  const askPromise = requestWithBody(port, '/api/ask', withToken(token, { jsonBody: { conv_id: convId, turn_id: 't-w', questions: [{ question: 'Which?' }] } }));
  let askId = null;
  const deadline = Date.now() + 5000;
  while (!askId && Date.now() < deadline) {
    const conv = await request(port, '/api/conversations/' + convId);
    const evt = conv.json.events.find((e) => e.kind === 'ask_questions');
    if (evt) askId = evt.data.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(askId, 'the ask was registered with the child token');
  const self = await requestWithBody(port, '/api/ask/' + askId + '/answer', withToken(token, { jsonBody: { answers: [{ answer: 'x' }] } }));
  assert.equal(self.statusCode, 403);
  assert.equal(self.json.code, TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED);
  const real = await requestWithBody(port, '/api/ask/' + askId + '/answer', { jsonBody: { answers: [{ answer: 'x' }] } });
  assert.equal(real.statusCode, 200);
  assert.equal((await askPromise).statusCode, 200);
});

test('the server registers exactly REGISTERED_ROUTES for the permissions family', () => {
  const registered = describeRoutes().filter((r) => r.module === MODULE).map((r) => [r.method, r.path, r.handler]);
  assert.deepEqual(registered, REGISTERED_ROUTES.map(([m, p, h]) => [m, typeof p === 'string' ? p : p.source, h]));
});
