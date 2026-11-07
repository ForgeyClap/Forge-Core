// WP B8-3 (Review B8-2, HIGH swallowed error): a `claude` child that exits before its FIRST output line used
// to close the turn with error:null, so chat-runs.mjs counted it 'completed' and the conversation stayed
// silent. It must close as a FAILED turn: turn.error starts with the Dutch 'Claude kon niet starten' and one
// forge_error event carries an error-catalogue code (`unknown` unless the stderr/spawn text names a closer
// one, e.g. cli_missing). Real child processes (process.execPath -e ...), swapped in through the test-only
// spawn-spec seam; mock-mode normal turns are the control and must stay untouched.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, _resetExecBridgeForTests, _setSpawnSpecOverrideForTests, START_FAILED_MESSAGE } from '../src/exec-lifecycle.mjs';
import { listChatRuns } from '../src/chat-runs.mjs';
import { ERROR_CODES } from '../src/error-catalogue.mjs';

let tempDir;
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-start-failure-'));
  _setConversationsDirForTests(tempDir);
});
beforeEach(() => { _resetExecBridgeForTests(); });
after(() => {
  delete process.env.CC_EXEC_MOCK;
  _resetExecBridgeForTests();
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

async function runToClose(project, script, text = 'hallo') {
  if (script !== null) _setSpawnSpecOverrideForTests(() => ({ cmd: process.execPath, args: ['-e', script], askMcpConfigPath: undefined }));
  const conv = createConversation({ project });
  const user = appendUserTurn(conv.id, text);
  const { turnId, requestId } = user;
  assert.ok(turnId, 'setup: user turn id ' + JSON.stringify(user));
  const start = startExecution({ convId: conv.id, turnId, requestId, text, cwd: execCwd });
  assert.equal(start.started, true, JSON.stringify(start));
  const deadline = Date.now() + 15000;
  for (;;) {
    const full = readConversation(conv.id);
    const turn = (full.turns || []).find((x) => x.role === 'assistant' && x.turn_id === turnId);
    if (turn) return { conv, full, turn };
    if (Date.now() > deadline) throw new Error('no assistant turn; events=' + JSON.stringify((full.events || []).map((e) => e.kind)));
    await new Promise((r) => setTimeout(r, 50));
  }
}

const forgeErrors = (full) => (full.events || []).filter((e) => e.kind === 'forge_error').map((e) => e.data);

test('the message is the Dutch one the owner asked for', () => {
  assert.equal(START_FAILED_MESSAGE, 'Claude kon niet starten');
});

test('a child that exits 0 at once with no output is a FAILED turn with an error-catalogue code', async () => {
  const { full, turn } = await runToClose('start-fail-0', 'process.exit(0)');
  assert.ok(typeof turn.error === 'string' && turn.error.startsWith(START_FAILED_MESSAGE), 'turn.error=' + turn.error);
  assert.equal(turn.exit_code, 0);
  const errs = forgeErrors(full);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.equal(errs[0].type, 'forge_error');
  assert.equal(errs[0].code, 'unknown');
  assert.ok(ERROR_CODES.includes(errs[0].code));
  assert.match(errs[0].details, /Claude kon niet starten/);
  const run = listChatRuns('start-fail-0').find((r) => r.status);
  assert.equal(run.status, 'failed', 'chat-runs must show it as failed, not completed: ' + JSON.stringify(run));
});

test('a child that exits 1 at once with only stderr is FAILED; the catalogue code comes from the stderr', async () => {
  const { full, turn } = await runToClose('start-fail-1', "process.stderr.write(\"'claude' is not recognized as an internal or external command\n\");process.exit(1)");
  assert.ok(turn.error.startsWith(START_FAILED_MESSAGE), 'turn.error=' + turn.error);
  assert.match(turn.error, /1/);
  const errs = forgeErrors(full);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.equal(errs[0].code, 'cli_missing');
});

test('control: a normal mock turn with output is not marked as a start failure', async () => {
  _setSpawnSpecOverrideForTests(null);
  const { full, turn } = await runToClose('start-ok', null, 'gewoon antwoord');
  assert.equal(turn.error, null);
  assert.equal(forgeErrors(full).length, 0);
});
