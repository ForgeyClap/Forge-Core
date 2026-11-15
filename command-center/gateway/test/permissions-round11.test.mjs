// WP-AUTONOMY-GW, round 11 (WP-AUTO-LOWFIX). Each row marked RED was run against d684b72
// and failed there; rows without a label guard ordinary work that must stay routine.
//   L1  the write-then-run marks only know writes the gateway saw, so a test or build runner on code that was already
//       on disk ran auto-approved. Now the first runner of each family in a project folder after a gateway start asks
//       ('first_runner'); once the owner allows that card, later runners of that family there stay routine until a new
//       code write.
//   L2  autonomy.json was read through a link (readFileSync follows it). A symbolic link or a hard link is refused like
//       code-marks.mjs does it: autonomy is OFF everywhere (fail closed).
//   L3  GET /api/permissions/pending and GET /api/permissions/auto-log answered without a credential. They now need the
//       dashboard credential the write routes use (UI session cookie or the in-process header token).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import * as store from '../src/permissions/store.mjs';
import { isAutonomyOn, readAutonomy, _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';
import { createServer } from '../src/server.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request } from '../test-support/helpers.mjs';
import { EXEC_TOKEN_HEADER, getExecToken } from '../src/security.mjs';
import { TOKEN_ERROR_CODES } from '../src/routes/permissions.mjs';

const {
  createPermissionRequest, answerPermission, listPendingPermissions, registerPermissionRun, observeStreamLine,
  setPermissionAutonomy, _resetPermissionStoreForTests,
} = store;

const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round11-')));
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const P = path.join(BASE, 'proj');
put(path.join(P, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
put(path.join(P, 'src', 'a.js'));
put(path.join(P, 'src', 'a.test.js'));

after(() => {
  fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

// ---------------------------------------------------------------- L1: the first runner per folder after a start asks
describe('L1 the first runner in a folder after a gateway start asks', () => {
  const PROJECT = 'round11-project';
  before(() => {
    fs.mkdirSync(path.join(BASE, 'conversations'), { recursive: true });
    _setConversationsDirForTests(path.join(BASE, 'conversations'));
  });
  beforeEach(() => {
    _resetPermissionStoreForTests(); // a fresh gateway start
    setPermissionAutonomy(isAutonomyOn);
    fs.rmSync(path.join(BASE, 'autonomy'), { recursive: true, force: true });
    fs.mkdirSync(path.join(BASE, 'autonomy'), { recursive: true });
    _setAutonomyDirForTests(path.join(BASE, 'autonomy'));
  });
  after(() => {
    setPermissionAutonomy(null);
    _setAutonomyDirForTests(null);
    _resetConversationsForTests();
    _resetPermissionStoreForTests();
  });
  const conversation = () => { const id = createConversation({ project: PROJECT }).id; registerPermissionRun(id, { cwd: P }); return id; };
  const card = (convId, command) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command } });
  const allowed = (r) => Boolean(r.decision && r.decision.behavior === 'allow');
  const codeOf = (r) => { const c = listPendingPermissions().find((p) => p.id === r.id); return c ? c.gate.code : null; };

  test('L1 RED the first `npm test` after a start waits for the owner (first_runner)', () => {
    const r = card(conversation(), 'npm test');
    assert.equal(r.decision, undefined, 'the card waits');
    assert.equal(codeOf(r), 'first_runner');
  });

  test('L1 RED the first `node --test` after a start waits, also without any write seen', () => {
    const r = card(conversation(), 'node --test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'first_runner');
  });

  test('L1 once the owner allows it, the next runner of that family is routine', () => {
    const c = conversation();
    const first = card(c, 'npm test');
    answerPermission(first.id, 'allow');
    assert.equal(allowed(card(c, 'npm test')), true);
  });

  test('L1 guard: after a new code write the runner asks again (wrote_code)', () => {
    const c = conversation();
    answerPermission(card(c, 'npm test').id, 'allow');
    observeStreamLine(c, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r11_w', name: 'Write', input: { file_path: path.join(P, 'src', 'b.js'), content: 'x' } }] } });
    const r = card(c, 'npm test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'wrote_code');
  });

  test('L1 RED a restart forgets the approval: the first runner asks again', () => {
    answerPermission(card(conversation(), 'npm test').id, 'allow');
    _resetPermissionStoreForTests();
    const r = card(conversation(), 'npm test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'first_runner');
  });

  test('L1 guard: routine work that runs no project code stays routine on the first call', () => {
    const c = conversation();
    assert.equal(allowed(card(c, 'git status')), true);
    assert.equal(allowed(card(c, 'ls src')), true);
    assert.equal(allowed(createPermissionRequest({ convId: c, toolName: 'Read', input: { file_path: path.join(P, 'src', 'a.js') } })), true);
  });
});

// ---------------------------------------------------------------- L1b (WP-AUTO-REWORK): one first-run card per project root
// Owner rule "Remote autonomy: routine tools (tests, builds) are auto-approved": the round-11 card asked once per folder
// PER RUNNER FAMILY, so every lane worktree and every family asked. Now one owner-approved runner card inside the
// gateway's project root (lane worktrees under .claude/worktrees and _scratch included) covers every family and every
// folder in that root for this start. The wrote_code rule stays per folder/family; folders outside the root keep asking.
describe('L1b one first-run card per gateway start covers the whole project root', () => {
  const PROJECT = 'round11b-root-project';
  const WT = path.join(P, '.claude', 'worktrees', 'lane-a');
  const OUT = path.join(BASE, 'outside-proj');
  put(path.join(WT, 'package.json'), JSON.stringify({ name: 'wt', scripts: { test: 'node --test' } }));
  put(path.join(WT, '.git'), 'gitdir: ' + path.join(P, '.git', 'worktrees', 'lane-a') + '\n');
  put(path.join(WT, 'src', 'a.js'));
  put(path.join(P, 'node_modules', '.bin', 'tsc')); // npx tsc runs only a project-local program
  put(path.join(OUT, 'package.json'), JSON.stringify({ name: 'o', scripts: { test: 'node --test' } }));
  put(path.join(OUT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  before(() => {
    fs.mkdirSync(path.join(BASE, 'conversations'), { recursive: true });
    _setConversationsDirForTests(path.join(BASE, 'conversations'));
  });
  beforeEach(() => {
    _resetPermissionStoreForTests();
    if (typeof store._setFirstRunRootForTests === 'function') store._setFirstRunRootForTests(P);
    setPermissionAutonomy(isAutonomyOn);
    fs.rmSync(path.join(BASE, 'autonomy'), { recursive: true, force: true });
    fs.mkdirSync(path.join(BASE, 'autonomy'), { recursive: true });
    _setAutonomyDirForTests(path.join(BASE, 'autonomy'));
  });
  after(() => {
    if (typeof store._setFirstRunRootForTests === 'function') store._setFirstRunRootForTests(null);
    setPermissionAutonomy(null);
    _setAutonomyDirForTests(null);
    _resetConversationsForTests();
    _resetPermissionStoreForTests();
  });
  const conversation = (cwd = P) => { const id = createConversation({ project: PROJECT }).id; registerPermissionRun(id, { cwd }); return id; };
  const card = (convId, command) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command } });
  const allowed = (r) => Boolean(r.decision && r.decision.behavior === 'allow');
  const codeOf = (r) => { const c = listPendingPermissions().find((p) => p.id === r.id); return c ? c.gate.code : null; };

  test('L1b guard: the first runner in the root still asks once (first_runner)', () => {
    const r = card(conversation(), 'npm test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'first_runner');
  });

  test('L1b RED after one approval a second runner family in the root does not ask again', () => {
    const c = conversation();
    answerPermission(card(c, 'npm test').id, 'allow');
    assert.equal(allowed(card(c, 'node --test')), true, 'node --test is routine');
    assert.equal(allowed(card(c, 'npx tsc --noEmit')), true, 'tsc is routine');
  });

  test('L1b RED after one approval a lane worktree inside the root does not ask again', () => {
    answerPermission(card(conversation(), 'npm test').id, 'allow');
    const w = conversation(WT);
    assert.equal(allowed(card(w, 'npm test')), true, 'npm test in the worktree is routine');
    assert.equal(allowed(card(w, 'node --test')), true, 'node --test in the worktree is routine');
  });

  test('L1b guard: a folder outside the project root keeps its own first-run card', () => {
    answerPermission(card(conversation(), 'npm test').id, 'allow');
    const r = card(conversation(OUT), 'npm test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'first_runner');
  });

  test('L1b guard: a new code write in the worktree still asks (wrote_code stays per folder)', () => {
    answerPermission(card(conversation(), 'npm test').id, 'allow');
    const w = conversation(WT);
    observeStreamLine(w, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r11b_w', name: 'Write', input: { file_path: path.join(WT, 'src', 'b.js'), content: 'x' } }] } });
    const r = card(w, 'npm test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'wrote_code');
  });

  test('L1b guard: a restart forgets the root approval', () => {
    answerPermission(card(conversation(), 'npm test').id, 'allow');
    _resetPermissionStoreForTests();
    store._setFirstRunRootForTests?.(P);
    const r = card(conversation(WT), 'node --test');
    assert.equal(r.decision, undefined);
    assert.equal(codeOf(r), 'first_runner');
  });
});

// ---------------------------------------------------------------- L2: autonomy.json through a link is refused
describe('L2 autonomy.json is never read through a link', () => {
  const DIR = path.join(BASE, 'autonomy-link');
  const REAL = path.join(BASE, 'elsewhere', 'real-autonomy.json');
  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    put(REAL, JSON.stringify({ projects: { other: false } }));
    _setAutonomyDirForTests(DIR);
  });
  after(() => _setAutonomyDirForTests(null));

  test('L2 guard: a plain file is read (autonomy on by default)', () => {
    fs.copyFileSync(REAL, path.join(DIR, 'autonomy.json'));
    assert.equal(readAutonomy().problem, null);
    assert.equal(isAutonomyOn('demo'), true);
  });

  test('L2 RED a hard link as autonomy.json: autonomy is OFF everywhere', () => {
    fs.linkSync(REAL, path.join(DIR, 'autonomy.json'));
    assert.notEqual(readAutonomy().problem, null, 'a hard link is refused');
    assert.equal(isAutonomyOn('demo'), false);
  });

  test('L2 RED a symbolic link as autonomy.json: autonomy is OFF everywhere', (t) => {
    try { fs.symlinkSync(REAL, path.join(DIR, 'autonomy.json'), 'file'); } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) { t.skip('this account may not make symbolic links'); return; }
      throw err;
    }
    assert.notEqual(readAutonomy().problem, null, 'a symbolic link is refused');
    assert.equal(isAutonomyOn('demo'), false);
  });
});

// ---------------------------------------------------------------- L3: the two GET routes need the dashboard credential
describe('L3 GET pending and GET auto-log need the dashboard credential', () => {
  let server;
  let port;
  let tempDir;
  before(async () => {
    process.env.CC_EXEC_MOCK = '1';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round11-routes-'));
    _setConversationsDirForTests(tempDir);
    _resetProjectsCacheForTests();
    server = createServer();
    await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
  });
  after(async () => {
    delete process.env.CC_EXEC_MOCK;
    _resetConversationsForTests();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  const withToken = { headers: { [EXEC_TOKEN_HEADER]: getExecToken() } };

  for (const p of ['/api/permissions/pending', '/api/permissions/auto-log?limit=5']) {
    test('L3 RED ' + p + ' without a credential is refused (403 ui_session_required)', async () => {
      const r = await request(port, p);
      assert.equal(r.statusCode, 403);
      assert.equal(r.json.code, TOKEN_ERROR_CODES.UI_SESSION_REQUIRED);
    });
    test('L3 RED ' + p + ' with a wrong token is refused', async () => {
      const r = await request(port, p, { headers: { [EXEC_TOKEN_HEADER]: 'x'.repeat(64) } });
      assert.equal(r.statusCode, 403);
    });
    test('L3 guard: ' + p + ' with the dashboard credential answers 200', async () => {
      const r = await request(port, p, withToken);
      assert.equal(r.statusCode, 200);
      assert.equal(r.json.ok, true);
    });
  }
});
