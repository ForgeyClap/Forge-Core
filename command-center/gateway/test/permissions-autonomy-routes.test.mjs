// WP-AUTONOMY-GW: the autonomy setting and the auto-allow log over the
// REAL composition root (server.mjs createServer), in mock execution mode. createServer() wires the
// autonomy check into the permission store; these tests prove that wiring end to end: a routine
// card registered with the agent token comes back allowed at once, a hard-gate card waits.
//   GET  /api/permissions/autonomy           -> { ok, default, projects, problem }
//   PUT  /api/permissions/autonomy           { project, enabled } (dashboard credential only)
//   GET  /api/permissions/auto-log?limit=N   -> { ok, items: [...] } newest first
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetPermissionStoreForTests, registerPermissionRun, setTurnFromLanPhone, createPermissionRequest } from '../src/permissions/store.mjs';
import { enterDrainMode, _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import { _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';
import { execSpawnEnv, ASK_AGENT_TOKEN_ENV } from '../src/exec-cli.mjs';
import { EXEC_TOKEN_HEADER, getExecToken } from '../src/security.mjs';
import { TOKEN_ERROR_CODES } from '../src/routes/permissions.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

// Round 11 (L3): GET pending and GET auto-log need the dashboard credential.
const asDashboard = { headers: { [EXEC_TOKEN_HEADER]: getExecToken() } };
const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
let server;
let port;
let tempDir;
let autoDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-autonomy-routes-'));
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
  _setAutonomyDirForTests(null);
  _resetConversationsForTests();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetPermissionStoreForTests();
  autoDir = fs.mkdtempSync(path.join(tempDir, 'autonomy-'));
  _setAutonomyDirForTests(autoDir);
});

async function makeConversation() {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(created.statusCode, 201);
  const convId = created.json.conversation.id;
  registerPermissionRun(convId, { cwd: PROJECT_ROOT }); // what exec-lifecycle does when a turn starts
  return convId;
}

function childToken(convId) {
  const cfg = path.join(tempDir, 'cfg-' + convId + '.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'forge-ask': { env: { CC_ASK_CONV_ID: convId } } } }), 'utf8');
  return execSpawnEnv({ askMcpConfigPath: cfg })[ASK_AGENT_TOKEN_ENV];
}

const asAgent = (token, jsonBody) => ({ omitExecToken: true, headers: { [EXEC_TOKEN_HEADER]: token }, jsonBody });
const putAutonomy = (jsonBody, opts = {}) => requestWithBody(port, '/api/permissions/autonomy', { method: 'PUT', jsonBody, ...opts });

async function card(convId, command) {
  const r = await requestWithBody(port, '/api/permissions/request', asAgent(childToken(convId), { conv_id: convId, tool_name: 'Bash', input: { command } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  return r.json;
}

test('GET autonomy: default on, every registered project listed with its effective value', async () => {
  const r = await request(port, '/api/permissions/autonomy');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.default, true);
  assert.equal(r.json.problem, null);
  assert.equal(r.json.projects[THIS_PROJECT_NAME], true);
});

test('PUT autonomy switches one project off and on again (dashboard credential)', async () => {
  const off = await putAutonomy({ project: THIS_PROJECT_NAME, enabled: false });
  assert.equal(off.statusCode, 200, JSON.stringify(off.json));
  assert.equal(off.json.ok, true);
  assert.equal(off.json.project, THIS_PROJECT_NAME);
  assert.equal(off.json.enabled, false);
  assert.equal((await request(port, '/api/permissions/autonomy')).json.projects[THIS_PROJECT_NAME], false);
  const on = await putAutonomy({ project: THIS_PROJECT_NAME, enabled: true });
  assert.equal(on.statusCode, 200);
  assert.equal((await request(port, '/api/permissions/autonomy')).json.projects[THIS_PROJECT_NAME], true);
});

test('PUT autonomy refuses a bad body, an unknown project, the agent token and no credential', async () => {
  assert.equal((await putAutonomy({ project: THIS_PROJECT_NAME, enabled: 'no' })).statusCode, 400);
  assert.equal((await putAutonomy({ project: THIS_PROJECT_NAME })).statusCode, 400);
  assert.equal((await putAutonomy({ project: THIS_PROJECT_NAME, enabled: true, extra: 1 })).statusCode, 400);
  assert.equal((await putAutonomy({ project: 'no-such-project-xyz', enabled: false })).statusCode, 404);
  const convId = await makeConversation();
  const byAgent = await putAutonomy({ project: THIS_PROJECT_NAME, enabled: false }, { omitExecToken: true, headers: { [EXEC_TOKEN_HEADER]: childToken(convId) } });
  assert.equal(byAgent.statusCode, 403);
  assert.equal(byAgent.json.code, TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED);
  const none = await putAutonomy({ project: THIS_PROJECT_NAME, enabled: false }, { omitExecToken: true });
  assert.equal(none.statusCode, 403);
  assert.equal((await request(port, '/api/permissions/autonomy')).json.projects[THIS_PROJECT_NAME], true, 'nothing was changed');
});

test('PUT autonomy answers 409 when the setting file would sit inside a project folder', async () => {
  _setAutonomyDirForTests(path.join(PROJECT_ROOT, '_scratch', 'autonomy-never-created'));
  const r = await putAutonomy({ project: THIS_PROJECT_NAME, enabled: false });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json.code, 'autonomy_state_inside_project');
  const g = await request(port, '/api/permissions/autonomy');
  assert.equal(g.json.problem, 'autonomy_state_inside_project');
  assert.equal(g.json.default, false, 'fail closed: nothing is auto-allowed while the problem exists');
});

test('through the real server: a routine card is allowed at once and logged; a hard-gate card waits', async () => {
  const convId = await makeConversation();
  const routine = await card(convId, 'git status');
  assert.deepEqual(routine.decision, { decided: true, behavior: 'allow', updatedInput: { command: 'git status' } });

  const gated = await card(convId, 'git push origin main');
  assert.equal(gated.decision, undefined);
  const pending = await request(port, '/api/permissions/pending?conversation=' + convId, asDashboard);
  assert.deepEqual(pending.json.pending.map((p) => p.id), [gated.id]);
  assert.equal(pending.json.pending[0].gate.code, 'push');

  const log = await request(port, '/api/permissions/auto-log?limit=50', asDashboard);
  assert.equal(log.statusCode, 200);
  assert.equal(log.json.ok, true);
  assert.equal(log.json.items.length, 1);
  const e = log.json.items[0];
  assert.deepEqual(Object.keys(e).sort(), ['at', 'categories', 'command_preview', 'conversation_id', 'id', 'project', 'reason', 'summary_nl', 'tool_name']);
  assert.equal(e.id, routine.id);
  assert.equal(e.project, THIS_PROJECT_NAME);
});

test('through the real server: with autonomy off for the project the routine card waits too', async () => {
  await putAutonomy({ project: THIS_PROJECT_NAME, enabled: false });
  const convId = await makeConversation();
  const routine = await card(convId, 'git status');
  assert.equal(routine.decision, undefined);
});

test('auto-log: limit must be 1..200', async () => {
  for (const bad of ['0', '201', 'abc', '-1']) {
    assert.equal((await request(port, '/api/permissions/auto-log?limit=' + bad, asDashboard)).statusCode, 400, bad);
  }
  assert.equal((await request(port, '/api/permissions/auto-log', asDashboard)).statusCode, 200, 'no limit = the default');
});

// M1 (security review rv-autonomy-sec-2): a dashboard send that does not start (it lost the race to a
// phone turn that is running, or the gateway is draining) must not take the LAN mark off the conversation.
test('a dashboard send that does not start leaves the LAN phone mark in place', async (t) => {
  const convId = await makeConversation();
  setTurnFromLanPhone(convId, true); // a turn sent from a phone over LAN is running in this conversation
  enterDrainMode('test: no new executions');
  t.after(() => _resetExecBridgeForTests());
  const send = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'and from the PC' } });
  assert.equal(send.statusCode, 202, JSON.stringify(send.json));
  assert.equal(send.json.execution_started, false);
  const r = createPermissionRequest({ convId, toolName: 'Bash', input: { command: 'git status' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.decision, undefined, 'the phone turn still has no autonomy');
});
