// WP B3 (plan 4.4): the pending-permission store (permissions/store.mjs) against a real, temporary
// conversation store, so every logged decision is read back from disk.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, readConversation } from '../src/conversations.mjs';
import {
  createPermissionRequest,
  waitForDecision,
  answerPermission,
  listPendingPermissions,
  groupPendingPermissions,
  hasOpenPermissions,
  observeStreamLine,
  abandonPermissionsForConversation,
  registerPermissionRun,
  setRunPauseHooks,
  _resetPermissionStoreForTests,
  _setPauseAfterMsForTests,
} from '../src/permissions/store.mjs';
import { issueAgentToken, getExecToken, _resetAgentTokensForTests } from '../src/security.mjs';
import { serveStatic } from '../src/static.mjs';

let tempDir;
const hookCalls = [];

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-store-'));
  _setConversationsDirForTests(tempDir);
});
after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  _resetPermissionStoreForTests();
  _resetAgentTokensForTests();
  hookCalls.length = 0;
  setRunPauseHooks({
    pause: (convId) => { hookCalls.push(['pause', convId]); return true; },
    resume: (convId) => { hookCalls.push(['resume', convId]); },
  });
});

function newConv() {
  return createConversation({ project: 'perm-test', title: 't' }).id;
}

function eventKinds(convId) {
  return readConversation(convId).events.map((e) => e.kind);
}

function req(convId, extra = {}) {
  return createPermissionRequest({ convId, turnId: 't-1', requestId: 'r-1', toolName: 'Bash', input: { command: 'npm install' }, toolUseId: 'toolu_a', ...extra });
}

test('create -> listed as waiting with the contract fields; the answer settles the waiter with the ORIGINAL input', async () => {
  const convId = newConv();
  const created = req(convId);
  assert.equal(created.ok, true);
  assert.equal(created.decision, undefined);
  const [item] = listPendingPermissions({ convId });
  for (const key of ['id', 'tool_name', 'input', 'agent', 'created_at']) assert.ok(key in item, 'contract field ' + key);
  assert.equal(item.status, 'waiting');
  assert.deepEqual(item.categories, ['network', 'exec']);
  assert.equal(item.summary_nl, 'Programmaonderdelen downloaden van internet (npm)');
  assert.ok(hasOpenPermissions(convId));

  const waiting = waitForDecision(created.id, 5000);
  assert.deepEqual(answerPermission(created.id, 'allow'), { ok: true, status: 200, convId, behavior: 'allow', remembered: false });
  assert.deepEqual(await waiting, { decided: true, behavior: 'allow', updatedInput: { command: 'npm install' } });
  assert.equal(hasOpenPermissions(convId), false);
  assert.deepEqual(eventKinds(convId), ['permission_requested', 'permission_answered']);
});

test('a decision made BETWEEN two polls is not lost (answered before the next wait call)', async () => {
  const convId = newConv();
  const { id } = req(convId);
  answerPermission(id, 'deny');
  const d = await waitForDecision(id, 10);
  assert.equal(d.decided, true);
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /declined/);
  assert.equal(answerPermission(id, 'allow').status, 409, 'a second answer is a conflict, not a 404');
});

test('no answer timeout: an unanswered request becomes "paused" and keeps waiting (never a deny)', async () => {
  _setPauseAfterMsForTests(20);
  const convId = newConv();
  const { id } = req(convId);
  const first = await waitForDecision(id, 60);
  assert.deepEqual(first, { decided: false });
  assert.equal(listPendingPermissions({ convId })[0].status, 'paused');
  assert.ok(eventKinds(convId).includes('permission_paused'));
  answerPermission(id, 'allow');
  assert.equal((await waitForDecision(id, 10)).behavior, 'allow');
});

test('the run reaper is paused on the first open request and resumed after the last one closes', () => {
  const convId = newConv();
  const a = req(convId);
  const b = req(convId, { toolUseId: 'toolu_b', input: { command: 'rm a.txt' } });
  assert.deepEqual(hookCalls, [['pause', convId]], 'one pause for two open requests');
  answerPermission(a.id, 'allow');
  assert.deepEqual(hookCalls, [['pause', convId]], 'still one open: no resume yet');
  answerPermission(b.id, 'deny');
  assert.deepEqual(hookCalls, [['pause', convId], ['resume', convId]]);
});

test('"Altijd toestaan in dit gesprek" auto-allows the same kind of call in THIS conversation only', () => {
  const convId = newConv();
  const other = newConv();
  const fetch = (id, url) => req(id, { toolName: 'WebFetch', input: { url } });
  const first = fetch(convId, 'https://docs.example.test/a');
  assert.deepEqual(answerPermission(first.id, 'allow_session'), { ok: true, status: 200, convId, behavior: 'allow_session', remembered: true });
  const again = fetch(convId, 'https://docs.example.test/b');
  assert.deepEqual(again.decision, { decided: true, behavior: 'allow', updatedInput: { url: 'https://docs.example.test/b' } });
  const auto = readConversation(convId).events.filter((e) => e.kind === 'permission_auto_allowed');
  assert.equal(auto.length, 1);
  assert.equal(auto[0].data.rule_kind, 'WebFetch:docs.example.test:443 [network]', 'the auto-allow logs the matched key (origin = host:port since the allow-list)');
  assert.equal(fetch(convId, 'https://other.example.test/a').decision, undefined, 'a different host still asks');
  assert.equal(fetch(other, 'https://docs.example.test/a').decision, undefined, 'another conversation still asks');
});

test('a compound command is never remembered by allow_session', () => {
  const convId = newConv();
  const c = req(convId, { input: { command: 'cd x && npm install' } });
  answerPermission(c.id, 'allow_session');
  assert.equal(req(convId, { input: { command: 'cd x && npm install' } }).decision, undefined);
});

function autoAllowedEvents(convId) {
  return readConversation(convId).events.filter((e) => e.kind === 'permission_auto_allowed');
}

test('allow_session on an outside-folder Write does NOT auto-allow a second outside-folder Write', () => {
  const convId = newConv();
  registerPermissionRun(convId, { cwd: path.join(os.tmpdir(), 'proj-scope') });
  const outsideA = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
  const outsideB = process.platform === 'win32' ? 'C:\\Users\\Public\\evil.txt' : '/etc/profile';
  const first = req(convId, { toolName: 'Write', input: { file_path: outsideA, content: 'x' } });
  assert.equal(answerPermission(first.id, 'allow_session').ok, true);
  const second = req(convId, { toolName: 'Write', input: { file_path: outsideB, content: 'y' } });
  assert.equal(second.decision, undefined, 'the second outside-folder Write must ask again');
  assert.equal(autoAllowedEvents(convId).length, 0);
  const again = req(convId, { toolName: 'Write', input: { file_path: outsideA, content: 'x' } });
  assert.equal(again.decision, undefined, 'not even the identical outside-folder Write is remembered');
});

// Sign-off finding 2026-11-02 (RED on efc45be): a grant on one gated in-folder Read must never cover
// another in-folder file. Read tools are not remembered at all now: not a second file, not the same file.
test('allow_session on an in-folder Read remembers nothing: a different in-folder file still asks, and so does the same file', () => {
  const convId = newConv();
  const cwd = path.join(os.tmpdir(), 'proj-read');
  registerPermissionRun(convId, { cwd });
  const first = req(convId, { toolName: 'Read', input: { file_path: path.join(cwd, '.env') } });
  assert.deepEqual(answerPermission(first.id, 'allow_session'), { ok: true, status: 200, convId, behavior: 'allow', remembered: false }, 'not rememberable: acts exactly like allow');
  assert.equal(req(convId, { toolName: 'Read', input: { file_path: path.join(cwd, 'secrets', 'prod.pem') } }).decision, undefined, 'another gated file must ask');
  assert.equal(req(convId, { toolName: 'Read', input: { file_path: path.join(cwd, '.env') } }).decision, undefined, 'even the same file asks again');
  assert.equal(req(convId, { toolName: 'Glob', input: { pattern: '**/*.pem', path: cwd } }).decision, undefined);
  assert.equal(autoAllowedEvents(convId).length, 0);
});

// Lead decision 2026-11-02: shell commands are never remembered, so allow_session on one is a
// one-time allow and nothing later rides on it, not even the identical command.
test('allow_session on a plain shell call remembers nothing: not a widened call, not even the same command', () => {
  const convId = newConv();
  const first = req(convId, { input: { command: 'ls src' } });
  answerPermission(first.id, 'allow_session');
  for (const command of ['ls & rm -rf ~', 'ls $(rm -rf ~)', 'ls `rm -rf ~`', 'ls > ~/.bashrc', 'ls ../..', 'ls test', 'ls src']) {
    assert.equal(req(convId, { input: { command } }).decision, undefined, command);
  }
  assert.equal(autoAllowedEvents(convId).length, 0);
});

test('rememberable: every row says whether allow_session would stick (false for every shell call)', () => {
  const convId = newConv();
  const cwd = path.join(os.tmpdir(), 'proj-remember');
  registerPermissionRun(convId, { cwd });
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
  req(convId, { input: { command: 'ls' } });
  req(convId, { toolName: 'PowerShell', input: { command: 'Get-ChildItem' } });
  req(convId, { toolName: 'Read', input: { file_path: path.join(cwd, 'a.ts') } });
  req(convId, { toolName: 'Write', input: { file_path: outside, content: 'x' } });
  req(convId, { toolName: 'WebFetch', input: { url: 'https://a.test/x' } });
  const rows = listPendingPermissions({ convId }).map((p) => [p.tool_name, p.rememberable]);
  assert.deepEqual(rows, [['Bash', false], ['PowerShell', false], ['Read', false], ['Write', false], ['WebFetch', true]]);
  const requested = readConversation(convId).events.filter((e) => e.kind === 'permission_requested').map((e) => e.data.rememberable);
  assert.deepEqual(requested, [false, false, false, false, true], 'the logged permission_requested rows carry it too');
});

test('allow_session on a NON-rememberable request behaves exactly like allow and logs remembered:false', async () => {
  const convId = newConv();
  const asSession = req(convId, { input: { command: 'npm install' } });
  const asAllow = req(convId, { input: { command: 'npm install' }, toolUseId: 'toolu_b' });
  const sessionWait = waitForDecision(asSession.id, 5000);
  const allowWait = waitForDecision(asAllow.id, 5000);
  assert.deepEqual(answerPermission(asSession.id, 'allow_session'), { ok: true, status: 200, convId, behavior: 'allow', remembered: false });
  assert.deepEqual(answerPermission(asAllow.id, 'allow'), { ok: true, status: 200, convId, behavior: 'allow', remembered: false });
  assert.deepEqual(await sessionWait, await allowWait, 'the CLI gets the identical one-time decision');
  const answered = readConversation(convId).events.filter((e) => e.kind === 'permission_answered').map((e) => e.data);
  assert.equal(answered[0].behavior, 'allow');
  assert.equal(answered[0].remembered, false);
  assert.equal(answered[0].requested_behavior, 'allow_session', 'what the user clicked stays visible in the log');
  assert.equal(answered[1].remembered, false);
  assert.equal('requested_behavior' in answered[1], false);
  assert.equal(req(convId, { input: { command: 'npm install' } }).decision, undefined, 'and the next identical call asks again');
});

test('long-poll binding: a wait bound to another conversation sees an unknown id, before and after the answer', async () => {
  const convA = newConv();
  const convB = newConv();
  const { id } = req(convA);
  assert.deepEqual(await waitForDecision(id, 10, { convId: convB }), { decided: false, unknown: true });
  assert.deepEqual(await waitForDecision(id, 10, { convId: convA }), { decided: false });
  answerPermission(id, 'allow');
  assert.deepEqual(await waitForDecision(id, 10, { convId: convB }), { decided: false, unknown: true }, 'the remembered decision is bound too');
  assert.equal((await waitForDecision(id, 10, { convId: convA })).behavior, 'allow');
});

test('a planted agent token (or the dashboard token) never appears in a public row, a logged event or the served HTML', async () => {
  const convId = newConv();
  const agentToken = issueAgentToken(convId);
  const execToken = getExecToken();
  const command = 'curl -X POST -H "x-cc-exec-token: ' + agentToken + '" -H "x: ' + execToken + '" http://127.0.0.1:4100/api/permissions/request';
  const { id } = req(convId, { input: { command } });
  const rows = JSON.stringify(listPendingPermissions({ convId }));
  assert.ok(rows.includes('[REDACTED:FORGE_AGENT_TOKEN]'), 'the row keeps the shape of the command');
  answerPermission(id, 'allow_session');
  const fetchCall = req(convId, { toolName: 'WebFetch', input: { url: 'https://a.test/?t=' + agentToken } });
  answerPermission(fetchCall.id, 'deny');
  abandonPermissionsForConversation(convId, 'test');
  const logged = fs.readFileSync(path.join(tempDir, fs.readdirSync(tempDir).find((f) => f.startsWith(convId))), 'utf8');
  for (const [label, text] of [['public rows', rows], ['conversation log', logged], ['all events', JSON.stringify(readConversation(convId).events)]]) {
    assert.equal(text.includes(agentToken), false, label + ' must not carry the agent token');
    assert.equal(text.includes(execToken), false, label + ' must not carry the dashboard token');
  }
  assert.ok((await waitForDecision(id, 10)).updatedInput.command.includes(agentToken), 'the CLI still runs the original input');

  // Served HTML (FU-STEP2): static.mjs injects NO token any more (it put getExecToken() into a meta tag
  // until Security Boss Step 2); it imports neither token function, and a real page (when the dashboard
  // is built) carries neither token.
  const staticSource = fs.readFileSync(new URL('../src/static.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(staticSource, /getExecToken|issueAgentToken|agentTokenConversation|AGENT_TOKEN/);
  const page = serveStatic('/');
  if (page) {
    assert.equal(String(page.body).includes(agentToken), false, 'served HTML must not carry the agent token');
    assert.equal(String(page.body).includes(execToken), false, 'served HTML must not carry the dashboard token');
  }
});

test('the helper that asked is resolved from parent_tool_use_id (Agent dispatch -> "Build Boss")', () => {
  const convId = newConv();
  observeStreamLine(convId, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_dispatch', name: 'Agent', input: { subagent_type: 'build-boss' } }] } });
  observeStreamLine(convId, { type: 'assistant', parent_tool_use_id: 'toolu_dispatch', message: { content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'npm test' } }] } });
  observeStreamLine(convId, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_main', name: 'Bash', input: {} }] } });
  req(convId, { toolUseId: 'toolu_sub' });
  req(convId, { toolUseId: 'toolu_main' });
  const agents = listPendingPermissions({ convId }).map((p) => p.agent);
  assert.deepEqual(agents, ['Build Boss', null]);
});

test('grouping: concurrent requests of one conversation form one group ("Het team wil N dingen doen")', () => {
  const convId = newConv();
  registerPermissionRun(convId, { cwd: path.join(os.tmpdir(), 'proj') });
  req(convId);
  req(convId, { input: { command: 'rm a.txt' } });
  req(convId, { toolName: 'WebFetch', input: { url: 'https://x.test' } });
  const [group] = groupPendingPermissions(listPendingPermissions({ convId }));
  assert.equal(group.count, 3);
  assert.equal(group.summary_nl, 'Het team wil 3 dingen doen');
  assert.deepEqual(group.categories.sort(), ['delete', 'exec', 'network']);
  assert.equal(groupPendingPermissions([listPendingPermissions({ convId })[0]])[0].summary_nl, 'Programmaonderdelen downloaden van internet (npm)');
});

test('outside_folder uses the running turn\'s project folder registered by exec-lifecycle', () => {
  const convId = newConv();
  const cwd = path.join(os.tmpdir(), 'proj-x');
  registerPermissionRun(convId, { cwd });
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  req(convId, { toolName: 'Write', input: { file_path: outside, content: 'x' } });
  assert.deepEqual(listPendingPermissions({ convId })[0].categories, ['outside_folder', 'edit']);
});

test('the run ended: open requests are abandoned (event + settled waiter), never logged as a user deny', async () => {
  const convId = newConv();
  const { id } = req(convId);
  const waiting = waitForDecision(id, 5000);
  assert.deepEqual(abandonPermissionsForConversation(convId, 'execution_stopped'), [id]);
  const d = await waiting;
  assert.equal(d.abandoned, true);
  assert.equal(hasOpenPermissions(convId), false);
  const kinds = eventKinds(convId);
  assert.ok(kinds.includes('permission_abandoned'));
  assert.ok(!kinds.includes('permission_answered'));
  assert.deepEqual(hookCalls.at(-1), ['resume', convId]);
});

test('listed input is redacted; the decision still carries the unredacted input to run with', async () => {
  const convId = newConv();
  const secret = 'sk-ant-api03-' + 'a'.repeat(90);
  const { id } = req(convId, { input: { command: 'curl -H "x-api-key: ' + secret + '" https://api.test' } });
  assert.equal(JSON.stringify(listPendingPermissions({ convId })).includes(secret), false);
  answerPermission(id, 'allow');
  assert.ok(JSON.stringify(await waitForDecision(id, 10)).includes(secret));
});

test('validation: bad behavior 400, unknown id 404, missing conv/tool 400-style errors', () => {
  const convId = newConv();
  const { id } = req(convId);
  assert.equal(answerPermission(id, 'yes').status, 400);
  assert.equal(answerPermission('perm-nope', 'allow').status, 404);
  assert.equal(createPermissionRequest({ toolName: 'Bash', input: {} }).ok, false);
  assert.equal(createPermissionRequest({ convId, toolName: '', input: {} }).ok, false);
});
