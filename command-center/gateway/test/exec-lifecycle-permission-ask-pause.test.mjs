// WP B3-gw FIX (Review Boss LOW): the run reaper has two independent pause reasons — an open
// ask_owner question (capped at the ask's own window) and an open permission card (no cap). Each
// has its own flag; the original remaining exec budget comes back only when BOTH are clear.
// Mock execution mode (CC_EXEC_MOCK=1, no real `claude`).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversation, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import {
  startExecution,
  stopExecution,
  isConversationBusy,
  _execTimeoutRemainingMsForTests,
  _setExecTimeoutMsForTests,
  _resetExecBridgeForTests,
} from '../src/exec-bridge.mjs';
import { pauseExecTimeoutForAsk, resumeExecTimeoutAfterAsk } from '../src/exec-lifecycle.mjs';
import { createPermissionRequest, answerPermission, _resetPermissionStoreForTests } from '../src/permissions/store.mjs';

let tempDir;
let projectDir;

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-ask-pause-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-ask-project-'));
  _setConversationsDirForTests(tempDir);
});
after(async () => {
  // Killed mock children (taskkill is asynchronous on Windows) must be gone before their cwd goes.
  await new Promise((r) => setTimeout(r, 1500));
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  _resetExecBridgeForTests();
  _resetPermissionStoreForTests();
  process.env.CC_EXEC_MOCK_DELAY_MS = '8000';
});

function start(conv) {
  assert.equal(startExecution({ convId: conv.id, turnId: 't1', requestId: 'r1', text: 'x', cwd: projectDir }).started, true);
}

function openCard(conv) {
  return createPermissionRequest({ convId: conv.id, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'npm install' } }).id;
}

test('OVERLAP: ask open + permission answered first -> the reaper waits for the ask window, not the stale exec budget', async () => {
  _setExecTimeoutMsForTests(150);
  const conv = createConversation({ project: 'demo' });
  start(conv);
  pauseExecTimeoutForAsk(conv.id, 900);
  const card = openCard(conv);
  assert.equal(_execTimeoutRemainingMsForTests(conv.id), Infinity, 'an open card removes every deadline');

  answerPermission(card, 'allow');
  const remaining = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(remaining > 600 && remaining <= 900, 'the ask is still open: its own window applies (got ' + remaining + 'ms, the stale budget was 150ms)');

  await new Promise((r) => setTimeout(r, 350));
  assert.equal(isConversationBusy(conv.id), true, 'the reaper must not fire before the ask window ends');

  resumeExecTimeoutAfterAsk(conv.id);
  const restored = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(restored > 100 && restored <= 150, 'both pauses clear: the ORIGINAL remaining budget comes back (got ' + restored + 'ms)');
  stopExecution(conv.id);
});

test('OVERLAP: permission open, then an ask opens and closes -> still no deadline while the card is open', () => {
  _setExecTimeoutMsForTests(5000);
  const conv = createConversation({ project: 'demo' });
  start(conv);
  const card = openCard(conv);
  pauseExecTimeoutForAsk(conv.id, 1000);
  assert.equal(_execTimeoutRemainingMsForTests(conv.id), Infinity, 'an ask under an open card does not re-arm a capped deadline');
  resumeExecTimeoutAfterAsk(conv.id);
  assert.equal(_execTimeoutRemainingMsForTests(conv.id), Infinity);
  answerPermission(card, 'allow');
  const restored = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(restored > 4000 && restored <= 5000, 'the original remaining budget, never the ask cap (got ' + restored + 'ms)');
  stopExecution(conv.id);
});

test('OVERLAP: permission open, then an ask opens, the card is answered first -> the ask window (from its start) applies', () => {
  _setExecTimeoutMsForTests(5000);
  const conv = createConversation({ project: 'demo' });
  start(conv);
  const card = openCard(conv);
  pauseExecTimeoutForAsk(conv.id, 1000);
  answerPermission(card, 'allow');
  const remaining = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(remaining > 800 && remaining <= 1000, 'the ask window applies while the ask is open (got ' + remaining + 'ms)');
  resumeExecTimeoutAfterAsk(conv.id);
  const restored = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(restored > 4000 && restored <= 5000, 'then the original budget (got ' + restored + 'ms)');
  stopExecution(conv.id);
});

test('a second ask pause never overwrites the saved ORIGINAL budget with the first ask\'s cap', () => {
  _setExecTimeoutMsForTests(5000);
  const conv = createConversation({ project: 'demo' });
  start(conv);
  pauseExecTimeoutForAsk(conv.id, 200);
  pauseExecTimeoutForAsk(conv.id, 300);
  const capped = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(capped > 200 && capped <= 300, 'the newest ask window applies (got ' + capped + 'ms)');
  resumeExecTimeoutAfterAsk(conv.id);
  const restored = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(restored > 4000 && restored <= 5000, 'the ORIGINAL budget, not the first cap (got ' + restored + 'ms)');
  stopExecution(conv.id);
});
