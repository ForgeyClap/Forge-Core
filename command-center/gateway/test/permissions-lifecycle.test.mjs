// WP B3 (plan 4.4): the exec-lifecycle hooks for permissions and stopping, in mock execution mode
// (CC_EXEC_MOCK=1, no real `claude`):
//   - stop sequence: interrupt -> close stdin -> kill the exact PID (interruptThenKill);
//   - an open permission card pauses the run's wall-clock reaper WITHOUT a cap, and the original
//     remaining budget comes back once the last card is answered;
//   - stopping a run abandons its open cards; a bypass request on an untrusted project is spawned
//     as acceptEdits and logged; a gateway drain adds a gateway_restarted forge_error.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createConversation, readConversation, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, stopExecution, _execTimeoutRemainingMsForTests, _setExecTimeoutMsForTests, _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { interruptThenKill, interruptAllExecutions, pauseExecTimeoutForAsk, resumeExecTimeoutAfterAsk } from '../src/exec-lifecycle.mjs';
import { createPermissionRequest, answerPermission, hasOpenPermissions, _resetPermissionStoreForTests } from '../src/permissions/store.mjs';
import { _setTrustFileForTests, setProjectTrusted } from '../src/permissions/trust.mjs';

let tempDir;
let projectDir;

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-lifecycle-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-project-'));
  _setConversationsDirForTests(tempDir);
  _setTrustFileForTests(path.join(tempDir, 'trusted.json'));
});
after(async () => {
  // Killed mock children (taskkill is asynchronous on Windows) must be gone before their cwd and
  // the conversation dir are removed.
  await new Promise((r) => setTimeout(r, 1500));
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _setTrustFileForTests(null);
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  _resetExecBridgeForTests();
  _resetPermissionStoreForTests();
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
});

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function fakeChild({ sigintOk = true } = {}) {
  const calls = [];
  return {
    calls,
    exitCode: null,
    signalCode: null,
    kill(sig) { calls.push('kill:' + sig); return sigintOk; },
    stdin: { destroyed: false, end() { calls.push('stdin.end'); } },
  };
}

test('STOP SEQUENCE (Windows): no signal can interrupt, so stdin is closed and the exact PID is killed at once', () => {
  const child = fakeChild();
  const killed = [];
  const steps = interruptThenKill(child, { platform: 'win32', kill: (c) => killed.push(c) });
  assert.deepEqual(steps, ['interrupt_unavailable', 'stdin_closed', 'killed']);
  assert.deepEqual(child.calls, ['stdin.end'], 'no signal is sent on win32 (it would terminate, not interrupt)');
  assert.deepEqual(killed, [child]);
});

test('STOP SEQUENCE (POSIX): SIGINT first, stdin closed, the kill only after the grace period if still alive', async () => {
  const alive = fakeChild();
  const killed = [];
  assert.deepEqual(interruptThenKill(alive, { platform: 'linux', graceMs: 30, kill: (c) => killed.push(c) }), ['interrupt', 'stdin_closed', 'kill_scheduled']);
  assert.deepEqual(alive.calls, ['kill:SIGINT', 'stdin.end']);
  assert.equal(killed.length, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(killed, [alive], 'still running after the grace period -> killed');

  const exited = fakeChild();
  const killed2 = [];
  interruptThenKill(exited, { platform: 'linux', graceMs: 30, kill: (c) => killed2.push(c) });
  exited.exitCode = 0; // it stopped by itself after the interrupt
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(killed2.length, 0, 'a child that exited after the interrupt is not killed');
});

test('STOP SEQUENCE (real child): a node process waiting on stdin is really ended', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let closed = false;
  child.on('close', () => { closed = true; });
  await new Promise((r) => setTimeout(r, 150));
  const steps = interruptThenKill(child, { graceMs: 300 });
  assert.ok(steps.includes('stdin_closed'));
  assert.ok(await waitUntil(() => closed, 8000), 'the child process must be gone');
});

test('PAUSE: an open permission card pauses the reaper without a cap; answering restores the original remaining budget', async () => {
  _setExecTimeoutMsForTests(5000);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo' });
  assert.equal(startExecution({ convId: conv.id, turnId: 't1', requestId: 'r1', text: 'x', cwd: projectDir }).started, true);
  await new Promise((r) => setTimeout(r, 200));

  const { id } = createPermissionRequest({ convId: conv.id, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'npm install' } });
  assert.equal(_execTimeoutRemainingMsForTests(conv.id), Infinity, 'no reaper deadline while a card waits');

  // An ask that opens and closes meanwhile must not restart the reaper under an open card.
  pauseExecTimeoutForAsk(conv.id, 1000);
  resumeExecTimeoutAfterAsk(conv.id);
  assert.equal(_execTimeoutRemainingMsForTests(conv.id), Infinity);

  answerPermission(id, 'allow');
  const remaining = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(remaining > 4000 && remaining < 5000, 'the ORIGINAL remaining budget (~4800ms) is restored: got ' + remaining);
  stopExecution(conv.id);
});

test('STOP: open permission cards of the run are abandoned (event), never left waiting', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo' });
  startExecution({ convId: conv.id, turnId: 't1', requestId: 'r1', text: 'x', cwd: projectDir });
  createPermissionRequest({ convId: conv.id, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'rm x' } });
  assert.equal(stopExecution(conv.id).stopped, true);
  assert.equal(hasOpenPermissions(conv.id), false);
  const kinds = readConversation(conv.id).events.map((e) => e.kind);
  assert.ok(kinds.includes('permission_abandoned'));
  assert.ok(kinds.includes('stopped_by_user'));
});

test('MODE: bypass on an UNtrusted project is downgraded to acceptEdits and logged; on a trusted project no downgrade', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo' });
  startExecution({ convId: conv.id, turnId: 't1', requestId: 'r1', text: 'x', cwd: projectDir, mode: 'bypass' });
  const ev = readConversation(conv.id).events.find((e) => e.kind === 'permission_mode');
  assert.deepEqual(ev.data, { requested: 'bypass', effective: 'accept-edits', downgraded: true, reason: 'project_not_trusted' });
  stopExecution(conv.id);

  setProjectTrusted(projectDir, true);
  _resetExecBridgeForTests();
  const conv2 = createConversation({ project: 'demo' });
  startExecution({ convId: conv2.id, turnId: 't2', requestId: 'r2', text: 'x', cwd: projectDir, mode: 'bypass' });
  assert.equal(readConversation(conv2.id).events.some((e) => e.kind === 'permission_mode'), false);
  stopExecution(conv2.id);
  setProjectTrusted(projectDir, false);
});

test('DRAIN: an interrupted turn also gets a gateway_restarted forge_error event', () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo' });
  startExecution({ convId: conv.id, turnId: 't1', requestId: 'r1', text: 'x', cwd: projectDir });
  interruptAllExecutions('test drain');
  const ev = readConversation(conv.id).events.find((e) => e.kind === 'forge_error');
  assert.equal(ev.data.code, 'gateway_restarted');
  assert.equal(ev.data.type, 'forge_error');
});
