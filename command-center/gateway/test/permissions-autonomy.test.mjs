// WP-AUTONOMY-GW: per-project autonomy for permission cards.
// Owner decision R-0203 ("ja automatisch willen we!"): when autonomy is on for the turn's project, a
// card that is NOT a hard gate is answered allow at once (status auto_allowed, logged with reason and
// classification); a hard-gate card stays pending. Default ON; the owner can switch a project off.
// The setting lives in a per-user folder (never inside a project folder: an agent may write files
// there without a card). Everything here runs against temp folders; the real ~/.forge is never read
// or written.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, readConversation } from '../src/conversations.mjs';
import {
  createPermissionRequest, listPendingPermissions, listAutoAllowed, registerPermissionRun,
  setPermissionAutonomy, _resetPermissionStoreForTests,
} from '../src/permissions/store.mjs';
import {
  readAutonomy, isAutonomyOn, setAutonomy, autonomyFile, _setAutonomyDirForTests,
  AUTONOMY_STATE_INSIDE_PROJECT, AUTONOMY_STATE_UNREADABLE,
} from '../src/permissions/autonomy.mjs';

const PROJECT = 'demo-project';
let convDir;
let autoDir;

before(() => {
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-autonomy-conv-'));
  _setConversationsDirForTests(convDir);
});

beforeEach(() => {
  _resetPermissionStoreForTests();
  setPermissionAutonomy(isAutonomyOn);
  autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-autonomy-'));
  _setAutonomyDirForTests(autoDir);
});

after(() => {
  setPermissionAutonomy(null);
  _setAutonomyDirForTests(null);
  _resetConversationsForTests();
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

/** A conversation of `project` whose run works in PROJECT_ROOT. */
function conversation(project = PROJECT) {
  const convId = createConversation({ project }).id;
  registerPermissionRun(convId, { cwd: PROJECT_ROOT });
  return convId;
}

const ask = (convId, toolName, input) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName, input });

// ---------------------------------------------------------------- the setting

test('default: autonomy is on for every project when nothing is stored', () => {
  const a = readAutonomy();
  assert.equal(a.default, true);
  assert.deepEqual(a.projects, {});
  assert.equal(a.problem, null);
  assert.equal(isAutonomyOn(PROJECT), true);
});

test('a project can be switched off and on again; the file holds only booleans', () => {
  assert.equal(setAutonomy(PROJECT, false).ok, true);
  assert.equal(isAutonomyOn(PROJECT), false);
  assert.equal(isAutonomyOn('another-project'), true, 'other projects keep the default');
  assert.deepEqual(JSON.parse(fs.readFileSync(autonomyFile(), 'utf8')).projects, { [PROJECT]: false });
  assert.equal(setAutonomy(PROJECT, true).ok, true);
  assert.equal(isAutonomyOn(PROJECT), true);
});

test('fail closed: an unknown project, an unreadable file and a file inside a project folder all mean OFF', () => {
  assert.equal(isAutonomyOn(''), false);
  assert.equal(isAutonomyOn(null), false);

  fs.writeFileSync(autonomyFile(), '{not json', 'utf8');
  assert.equal(isAutonomyOn(PROJECT), false);
  assert.equal(readAutonomy().problem, AUTONOMY_STATE_UNREADABLE);
  const refused = setAutonomy(PROJECT, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, AUTONOMY_STATE_UNREADABLE);

  _setAutonomyDirForTests(path.join(PROJECT_ROOT, '_scratch', 'autonomy-never-created'));
  assert.equal(readAutonomy().problem, AUTONOMY_STATE_INSIDE_PROJECT);
  assert.equal(isAutonomyOn(PROJECT), false);
  const inside = setAutonomy(PROJECT, true);
  assert.equal(inside.ok, false);
  assert.equal(inside.code, AUTONOMY_STATE_INSIDE_PROJECT);
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, '_scratch', 'autonomy-never-created')), false, 'nothing is written inside a project');
});

// ---------------------------------------------------------------- the permission path

test('autonomy on: a routine card is allowed at once, never listed, and logged with reason and classification', () => {
  const convId = conversation();
  const r = ask(convId, 'Bash', { command: 'git status' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.decision, { decided: true, behavior: 'allow', updatedInput: { command: 'git status' } });
  assert.equal(listPendingPermissions().length, 0);

  const log = listAutoAllowed({ limit: 50 });
  assert.equal(log.length, 1);
  const e = log[0];
  assert.equal(e.id, r.id);
  assert.equal(e.conversation_id, convId);
  assert.equal(e.project, PROJECT);
  assert.equal(e.tool_name, 'Bash');
  assert.deepEqual(e.categories, ['exec']);
  assert.equal(typeof e.summary_nl, 'string');
  assert.equal(typeof e.reason, 'string');
  assert.equal(e.command_preview, 'git status');
  assert.ok(!Number.isNaN(Date.parse(e.at)));

  const events = readConversation(convId).events.filter((ev) => ev.kind === 'permission_auto_allowed');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.status, 'auto_allowed');
  assert.equal(events[0].data.reason, e.reason);
  assert.equal(events[0].data.hard_gate, false);
});

test('autonomy on: a hard-gate card stays pending, with its Dutch gate reason', () => {
  const convId = conversation();
  const r = ask(convId, 'Bash', { command: 'git push origin main' });
  assert.equal(r.ok, true);
  assert.equal(r.decision, undefined);
  const [card] = listPendingPermissions();
  assert.equal(card.id, r.id);
  assert.equal(card.project, PROJECT);
  assert.equal(card.gate.hard, true);
  assert.equal(card.gate.code, 'push');
  assert.equal(listAutoAllowed({ limit: 50 }).length, 0);
});

test('autonomy off for the project: the same routine card waits', () => {
  setAutonomy(PROJECT, false);
  const r = ask(conversation(), 'Bash', { command: 'git status' });
  assert.equal(r.decision, undefined);
  assert.equal(listPendingPermissions()[0].gate.hard, false);
});

test('no autonomy wired into the store (as before this package): every card waits', () => {
  setPermissionAutonomy(null);
  const r = ask(conversation(), 'Bash', { command: 'git status' });
  assert.equal(r.decision, undefined);
});

test('a conversation without a known project is never auto-allowed', () => {
  registerPermissionRun('c-unknown-conversation', { cwd: PROJECT_ROOT });
  const r = ask('c-unknown-conversation', 'Bash', { command: 'git status' });
  assert.equal(r.ok, true);
  assert.equal(r.decision, undefined);
});

test('the log keeps the newest first, honours the limit, and cuts and shortens the command text', () => {
  const convId = conversation();
  // allow-listed shapes: a read of a long file name, and git status with a pathspec
  const long = 'cat "' + path.join(PROJECT_ROOT, 'tools', 'x.cjs') + '" ' + 'a'.repeat(400);
  for (let i = 0; i < 3; i++) ask(convId, 'Bash', { command: 'git status -- case' + i });
  ask(convId, 'Bash', { command: long });
  const all = listAutoAllowed({ limit: 50 });
  assert.equal(all.length, 4);
  assert.ok(all[0].command_preview.length <= 200, String(all[0].command_preview.length));
  assert.ok(!all[0].command_preview.includes(PROJECT_ROOT), 'the project folder is shortened');
  assert.ok(all[0].command_preview.startsWith('cat ".'), all[0].command_preview);
  assert.equal(all[1].command_preview, 'git status -- case2');
  assert.equal(listAutoAllowed({ limit: 2 }).length, 2);
});
