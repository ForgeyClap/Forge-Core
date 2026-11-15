// WP-AUTONOMY-GW, verify round 8. Each row marked RED was run against the code before this round and
// failed there (the card was auto-approved, or a mark was lost); the fix makes it wait for the owner. Rows marked NEW
// routine asked before and are allowed now on purpose. Rows without a label are guards for ordinary work.
//   F1 (MEDIUM-HIGH) an Agent or Task call was auto-allowed whatever its input. It now waits when its `cwd` is not
//            inside the run folder (real location: a junction, an 8.3 short name and letter case are followed), when
//            `isolation` is anything but `worktree`, when it has a `mode`, or when it has any other field that could
//            change where or with what permissions the subagent runs. A plain call (description, prompt,
//            subagent_type, model, effort, name, run_in_background) stays routine. Root cause: a subagent's own cards
//            were judged in the conversation's folder. The store now follows the stream: a card whose tool call
//            belongs to a subagent is judged in that subagent's cwd, and every card of a subagent that was started
//            with a cwd outside the run folder waits ('outside_folder'); so does a card the stream has not placed yet
//            while such a subagent runs.
//   F2       approving a 'wrote_code' card clears the mark only for the runner family of that card: node's test
//            runner, vitest/jest/mocha, tsc, eslint/prettier, one family per package script name, make/cmake,
//            pytest/python, cargo, go, dotnet, gradle/mvn, and one default family for the rest.
//   A4       while a card that writes code waits for the owner (or after the owner allowed it: the write lands
//            then), a runner in the same folder asks.
//   F3       the marks survive a gateway restart: ~/.forge/permissions/code-marks.json (atomic write, bounded, marks
//            expire only at the 30-day safety floor since round 10 (was 24 hours), a corrupt file makes every folder ask once).
//   LOW      commands that rewrite project code when they run (cargo add, go get, dotnet add, cmake, make, eslint
//            --fix, prettier --write, tsc that emits, vitest -u) mark the folder; an owner-approved package script
//            other than test/lint/typecheck, or vite build, marks it when the owner allows it. A WebSearch whose
//            query looks like an address, a token or a secret, or is very long, asks (and is never remembered for
//            the conversation). Writes of mise.toml, .tool-versions, bunfig.toml, .cargo/config.toml and
//            .git/hooks/* ask ('auto_run').
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyHardGate, codeWriteTargets } from '../src/permissions/hard-gate.mjs';
import { sessionRuleKey } from '../src/permissions/rules.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import * as store from '../src/permissions/store.mjs';
import { isAutonomyOn, _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';

const {
  createPermissionRequest, answerPermission, listPendingPermissions, observeStreamLine, registerPermissionRun,
  abandonPermissionsForConversation, setPermissionAutonomy, _resetPermissionStoreForTests,
} = store;
// Round 11: these suites test the write marks alone; the first-runner rule has its own tests (permissions-round11).
store._setFirstRunnerForTests(false);

const WIN = process.platform === 'win32';
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round8-')));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const link = (target, at) => fs.symlinkSync(target, at, WIN ? 'junction' : 'dir');
const pkg = (dir, scripts) => put(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
const bins = (dir) => { for (const b of ['vitest', 'tsc', 'eslint', 'vite', 'prettier']) { put(path.join(dir, 'node_modules', '.bin', b)); put(path.join(dir, 'node_modules', '.bin', b + '.cmd')); } };

// P: a project that is its own repository, with the runners of the allow-list installed.
const P = path.join(BASE, 'proj');
const OUT = path.join(BASE, 'outside');
const ALIAS = path.join(BASE, 'alias'); // a junction outside P that points INTO P
pkg(P, { test: 'node --test', build: 'tsc --noEmit', lint: 'eslint .', typecheck: 'tsc --noEmit', fix: 'eslint --fix .', vb: 'vite build' });
bins(P);
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
for (const rel of ['src/a.js', 'src/a.test.js', 'sub/a.test.js', 'notes.txt']) put(path.join(P, rel));
pkg(path.join(P, 'sub'), { test: 'node --test' });
put(path.join(OUT, 'a.js'));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
link(OUT, path.join(P, 'jct')); // inside P by name, outside by real location
link(P, ALIAS);
// QA: the root's npm test is routine, its sub-package's is not; QB the other way round
const QA = path.join(BASE, 'qa');
const QB = path.join(BASE, 'qb');
pkg(QA, { test: 'node --test' });
pkg(path.join(QA, 'bad'), { test: 'node tools/run.js' });
pkg(QB, { test: 'node tools/run.js' });
pkg(path.join(QB, 'good'), { test: 'node --test' });
for (const dir of [QA, QB]) put(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

// an 8.3 short name of a long-named folder outside P and of one inside P (when the volume has short names)
const LONG_OUT = path.join(BASE, 'outside long folder name');
const LONG_IN = path.join(P, 'inside long folder name');
fs.mkdirSync(LONG_OUT, { recursive: true });
fs.mkdirSync(LONG_IN, { recursive: true });
function shortName(p) {
  if (!WIN) return null;
  try {
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'for %I in ("' + p + '") do @echo %~sI'], { windowsVerbatimArguments: true, encoding: 'utf8' }).trim();
    return out && out.toLowerCase() !== p.toLowerCase() && fs.existsSync(out) ? out : null;
  } catch { return null; }
}
const SHORT_OUT = shortName(LONG_OUT);
const SHORT_IN = shortName(LONG_IN);

const OPTS = { cwd: P, home: HOME, tmp: TMP };
const sh = (command) => ['Bash', { command }];
const run = ([tool, input], opts = OPTS) => classifyHardGate(tool, input, opts);
const label = (call) => call[0] + ' ' + JSON.stringify(call[1]).split(BASE).join('').slice(0, 140);

function expectHard(name, call, code, opts = OPTS) {
  test(name + ': ' + label(call), () => {
    const got = run(call, opts);
    assert.equal(got.hard, true, JSON.stringify({ call, got }));
    assert.notEqual(got.code, 'routine');
    if (code) assert.equal(got.code, code, JSON.stringify({ call, got }));
  });
}
function expectRoutine(name, call, opts = OPTS) {
  test(name + ': ' + label(call), () => {
    const got = run(call, opts);
    assert.equal(got.code, 'routine', JSON.stringify({ call, got }));
  });
}

// ---------------------------------------------------------------- F1: what an Agent or Task call may ask for
const agent = (extra) => ['Agent', { description: 'd', prompt: 'p', ...extra }];
const task = (extra) => ['Task', { description: 'd', prompt: 'p', ...extra }];
const gb = (p) => '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/'); // the Git Bash spelling

for (const cwd of [OUT, HOME, '..', '../outside', path.join(P, 'jct'), path.join(P, 'jct', 'deeper'), OUT.replace(/\\/g, '/'), path.join(P, '..', 'outside')]) {
  expectHard('F1 RED an Agent with a cwd outside the run folder', agent({ cwd }), 'outside_folder');
}
if (WIN) expectHard('F1 RED an Agent with a Git Bash cwd outside', agent({ cwd: gb(OUT) }), 'outside_folder');
expectHard('F1 RED a Task with a cwd outside', task({ cwd: OUT }), 'outside_folder');
expectHard('F1 RED an Agent with a cwd on a network share', agent({ cwd: '\\\\host\\share\\x' }));
test('F1 RED an Agent whose cwd is the 8.3 short name of a folder outside', (t) => {
  if (!SHORT_OUT) { t.skip('no 8.3 short name on this volume'); return; }
  assert.equal(run(agent({ cwd: SHORT_OUT })).code, 'outside_folder');
});
for (const cwd of [42, true, ['x'], { p: P }, '']) expectHard('F1 RED an Agent with a cwd that is not a folder name', agent({ cwd }));
expectHard('F1 RED isolation remote runs elsewhere', agent({ isolation: 'remote' }), 'outbound');
for (const isolation of ['cloud', '', 'none', 1]) expectHard('F1 RED an unknown isolation', agent({ isolation }));
for (const mode of ['bypassPermissions', 'acceptEdits', 'dontAsk', 'plan', 'default', 'auto']) {
  expectHard('F1 RED an Agent with a permission mode', agent({ mode }), 'settings');
  expectHard('F1 RED a Task with a permission mode', task({ subagent_type: 'general-purpose', mode }), 'settings');
}
for (const [key, value] of [['permissionMode', 'bypassPermissions'], ['dangerouslyDisableSandbox', true], ['allowedTools', ['Bash']], ['tools', ['Bash']],
  ['settings', { permissions: { allow: ['Bash'] } }], ['env', { NODE_OPTIONS: '--require=x' }]]) {
  expectHard('F1 RED a field that changes the permissions', agent({ [key]: value }), 'settings');
}
for (const key of ['working_directory', 'directory', 'root', 'path', 'workdir', 'worktree_path']) {
  expectHard('F1 RED a path field outside the run folder', agent({ [key]: OUT }), 'outside_folder');
  expectHard('F1 RED a path field Forge does not know', agent({ [key]: path.join(P, 'sub') }));
}
for (const [key, value] of [['team_name', 't'], ['foo', 'bar'], ['resume', 'abc']]) expectHard('F1 RED an unknown field', agent({ [key]: value }));
for (const extra of [{ prompt: { text: 'p' } }, { run_in_background: 'yes' }, { model: 5 }, { subagent_type: ['x'] }]) {
  expectHard('F1 RED a field of the wrong type', agent(extra));
}
// what the router really dispatches stays routine
for (const extra of [{}, { subagent_type: 'build-boss' }, { subagent_type: 'general-purpose', model: 'opus', effort: 'high' }, { name: 'lane-1' },
  { run_in_background: true }, { run_in_background: false }, { isolation: 'worktree' }, { cwd: P }, { cwd: path.join(P, 'sub') }, { cwd: 'sub' },
  { cwd: './sub' }, { cwd: P.replace(/\\/g, '/') + '/' }, { cwd: ALIAS }, { cwd: path.join(ALIAS, 'sub') }]) {
  expectRoutine('F1 guard', agent(extra));
}
if (WIN) { expectRoutine('F1 guard: letter case', agent({ cwd: P.toUpperCase() })); expectRoutine('F1 guard: Git Bash spelling', agent({ cwd: gb(P) })); }
test('F1 guard: the 8.3 short name of a folder inside the run folder', (t) => {
  if (!SHORT_IN) { t.skip('no 8.3 short name on this volume'); return; }
  assert.equal(run(agent({ cwd: SHORT_IN })).code, 'routine');
});
expectRoutine('F1 guard', task({ subagent_type: 'general-purpose' }));
// the same rule for a shell card: a field that changes where or how it runs is not proven (the probe's Bash shapes)
expectHard('F1 RED a Bash card with a cwd outside', ['Bash', { command: 'cat src/a.js', cwd: OUT }], 'outside_folder');
expectHard('F1 RED a PowerShell card with a cwd outside', ['PowerShell', { command: 'Get-Content src\\a.js', cwd: OUT }], 'outside_folder');
expectHard('F1 RED a Bash card with a cwd inside (not judged there)', ['Bash', { command: 'cat a.test.js', cwd: path.join(P, 'sub') }]);
expectHard('F1 RED a Bash card outside the sandbox', ['Bash', { command: 'echo hi', dangerouslyDisableSandbox: true }], 'settings');
expectHard('F1 RED a Bash card with an unknown field', ['Bash', { command: 'echo hi', shell: 'cmd' }]);
for (const extra of [{ description: 'Print hi' }, { timeout: 60000 }, { run_in_background: true }, { dangerouslyDisableSandbox: false }]) {
  expectRoutine('F1 guard: what Claude Code sends with a shell card', ['Bash', { command: 'echo hi', ...extra }]);
}
expectRoutine('F1 guard', ['PowerShell', { command: 'Get-Date', description: 'date', timeout: 1000 }]);

// ---------------------------------------------------------------- the store: shared setup
describe('round 8 store', () => {
  const PROJECT = 'round8-project';
  const MARKS = path.join(BASE, 'marks');
  before(() => {
    fs.mkdirSync(path.join(BASE, 'conversations'), { recursive: true });
    _setConversationsDirForTests(path.join(BASE, 'conversations'));
  });
  beforeEach(() => {
    _resetPermissionStoreForTests();
    setPermissionAutonomy(isAutonomyOn);
    fs.rmSync(path.join(BASE, 'autonomy'), { recursive: true, force: true });
    fs.mkdirSync(path.join(BASE, 'autonomy'), { recursive: true });
    _setAutonomyDirForTests(path.join(BASE, 'autonomy'));
  });
  after(() => {
    setPermissionAutonomy(null);
    _setAutonomyDirForTests(null);
    if (typeof store._setCodeMarksDirForTests === 'function') store._setCodeMarksDirForTests(null);
    _resetConversationsForTests();
    _resetPermissionStoreForTests();
  });
  const conversation = (cwd = P) => { const id = createConversation({ project: PROJECT }).id; registerPermissionRun(id, { cwd }); return id; };
  const ask = (convId, toolName, input, toolUseId) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName, input, ...(toolUseId !== undefined ? { toolUseId } : {}) });
  const card = (convId, command, toolUseId) => ask(convId, 'Bash', { command }, toolUseId);
  const writeCard = (convId, rel, root = P) => ask(convId, 'Write', { file_path: path.join(root, rel), content: 'x' });
  let n = 0;
  const id = () => 'toolu_r8_' + (n += 1);
  const line = (convId, name, input, { parent = null, toolUseId = id() } = {}) => {
    observeStreamLine(convId, { type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
    return toolUseId;
  };
  const dispatch = (convId, extra, opts) => line(convId, 'Agent', { description: 'd', prompt: 'p', subagent_type: 'general-purpose', ...extra }, opts);
  const streamWrite = (convId, file) => line(convId, 'Write', { file_path: file, content: 'x' });
  const allowed = (r) => Boolean(r.decision && r.decision.behavior === 'allow');
  const codeOf = (r) => { const c = listPendingPermissions().find((p) => p.id === r.id); return c ? c.gate.code : null; };
  const waits = (r, code) => {
    assert.equal(r.decision, undefined, 'the card waits for the owner');
    if (code) assert.equal(codeOf(r), code);
  };

  // ---------------------------------------------------------------- F1 root cause: a subagent's cards
  describe('F1 a subagent is judged where it works', () => {
    test('F1 RED a subagent started with a cwd outside: its own read of a project file waits', () => {
      const c = conversation();
      const a1 = dispatch(c, { cwd: OUT });
      const tu = line(c, 'Bash', { command: 'cat src/a.js' }, { parent: a1 });
      waits(card(c, 'cat src/a.js', tu), 'outside_folder');
    });
    test('F1 RED while such a subagent runs, a card the stream has not placed yet waits', () => {
      const c = conversation();
      dispatch(c, { cwd: OUT });
      waits(card(c, 'cat src/a.js', 'toolu_not_seen_yet'), 'outside_folder');
      waits(card(c, 'cat src/a.js'), 'outside_folder'); // a card without a tool_use_id
    });
    test('F1 RED an Agent card with a cwd outside, allowed by the owner: its subagent\'s cards still wait', () => {
      const c = conversation();
      const a = ask(c, 'Agent', { description: 'd', prompt: 'p', cwd: OUT }, 'toolu_agent_card');
      waits(a, 'outside_folder');
      assert.equal(answerPermission(a.id, 'allow').ok, true);
      const tu = line(c, 'Read', { file_path: path.join(P, 'src', 'a.js') }, { parent: 'toolu_agent_card' });
      waits(ask(c, 'Read', { file_path: path.join(P, 'src', 'a.js') }, tu), 'outside_folder');
    });
    test('F1 RED a subagent of a subagent started outside waits too', () => {
      const c = conversation();
      const a1 = dispatch(c, { cwd: OUT });
      const a2 = dispatch(c, {}, { parent: a1 });
      const tu = line(c, 'Bash', { command: 'git status' }, { parent: a2 });
      waits(card(c, 'git status', tu), 'outside_folder');
    });
    test('F1 RED a subagent in a sub-package runs THAT package\'s npm test: judged there', () => {
      const c = conversation(QA);
      const a1 = dispatch(c, { cwd: path.join(QA, 'bad') });
      const tu = line(c, 'Bash', { command: 'npm test' }, { parent: a1 });
      waits(card(c, 'npm test', tu), 'not_allowlisted');
    });
    test('F1 RED a relative cwd is read from the run folder', () => {
      const c = conversation(QA);
      const a1 = dispatch(c, { cwd: 'bad' });
      const tu = line(c, 'Bash', { command: 'npm test' }, { parent: a1 });
      waits(card(c, 'npm test', tu));
    });
    test('F1 RED an Agent card with a cwd inside: its subagent is judged in that cwd', () => {
      const c = conversation(QA);
      const a = ask(c, 'Agent', { description: 'd', prompt: 'p', cwd: path.join(QA, 'bad') }, 'toolu_agent_in');
      assert.equal(allowed(a), true, 'a cwd inside the run folder is routine');
      const tu = line(c, 'Bash', { command: 'npm test' }, { parent: 'toolu_agent_in' });
      waits(card(c, 'npm test', tu));
    });
    test('F1 NEW routine: a subagent in a sub-package with a safe npm test is allowed there', () => {
      const c = conversation(QB);
      const a1 = dispatch(c, { cwd: path.join(QB, 'good') });
      const tu = line(c, 'Bash', { command: 'npm test' }, { parent: a1 });
      assert.equal(allowed(card(c, 'npm test', tu)), true);
    });
    test('F1 guard: the main agent\'s placed cards are judged as before while an outside subagent runs', () => {
      const c = conversation();
      dispatch(c, { cwd: OUT });
      const tu = line(c, 'Bash', { command: 'cat src/a.js' });
      assert.equal(allowed(card(c, 'cat src/a.js', tu)), true);
    });
    test('F1 guard: a subagent without a cwd is judged in the run folder', () => {
      const c = conversation();
      const a1 = dispatch(c, {});
      const tu = line(c, 'Bash', { command: 'cat src/a.js' }, { parent: a1 });
      assert.equal(allowed(card(c, 'cat src/a.js', tu)), true);
      // once any subagent runs, a card the stream has not placed may be any subagent's: it waits
      waits(card(c, 'cat src/a.js', 'toolu_unplaced'), 'outside_folder');
    });
    test('F1 guard: after the run ended, the next turn starts clean', () => {
      const c = conversation();
      dispatch(c, { cwd: OUT });
      abandonPermissionsForConversation(c, 'execution_closed');
      registerPermissionRun(c, { cwd: P });
      assert.equal(allowed(card(c, 'cat src/a.js', 'toolu_next_turn')), true);
    });
    test('F1 guard: a subagent through a junction into the project is inside', () => {
      const c = conversation();
      const a1 = dispatch(c, { cwd: path.join(ALIAS, 'sub') });
      const tu = line(c, 'Bash', { command: 'cat a.test.js' }, { parent: a1 });
      assert.equal(allowed(card(c, 'cat a.test.js', tu)), true);
    });
  });

  // ---------------------------------------------------------------- F2: runner families
  describe('F2 approving one runner clears only its family', () => {
    const dirtyThenApprove = (c, command) => {
      streamWrite(c, path.join(P, 'src', 'n.js'));
      const r = card(c, command);
      waits(r, 'wrote_code');
      assert.equal(answerPermission(r.id, 'allow').ok, true);
    };
    test('F2 RED approving lint does not clear the tests', () => {
      const c = conversation();
      dirtyThenApprove(c, 'npm run lint');
      waits(card(c, 'node --test'), 'wrote_code');
      waits(card(c, 'npm test'), 'wrote_code');
    });
    test('F2 RED approving a typecheck does not clear the tests', () => {
      const c = conversation();
      dirtyThenApprove(c, 'tsc --noEmit');
      waits(card(c, 'npm test'), 'wrote_code');
      waits(card(c, 'npx vitest run'), 'wrote_code');
    });
    test('F2 RED approving the tests does not clear the build', () => {
      const c = conversation();
      dirtyThenApprove(c, 'npm test');
      waits(card(c, 'npm run build'), 'wrote_code');
      waits(card(c, 'npx eslint .'), 'wrote_code');
    });
    test('F2 RED approving vitest does not clear eslint', () => {
      const c = conversation();
      dirtyThenApprove(c, 'npx vitest run');
      waits(card(c, 'npx eslint .'), 'wrote_code');
    });
    test('F2 RED approving an unknown family (vite build) clears only that family', () => {
      const c = conversation();
      dirtyThenApprove(c, 'npx vite build');
      waits(card(c, 'npm test'), 'wrote_code');
    });
    test('F2 guard: the approved family itself runs on', () => {
      const c = conversation();
      dirtyThenApprove(c, 'npm test');
      assert.equal(allowed(card(c, 'npm test')), true);
      assert.equal(allowed(card(c, 'node --test')), true, 'npm test ran node --test, which the owner saw');
    });
    test('F2 guard: npx and the bare program are one family', () => {
      const c = conversation();
      dirtyThenApprove(c, 'npx vitest run');
      assert.equal(allowed(card(c, 'vitest run')), true);
      const d = conversation();
      dirtyThenApprove(d, 'npx tsc --noEmit');
      assert.equal(allowed(card(d, 'tsc --noEmit')), true);
    });
    test('F2 the classifier takes the dirty families as a function', () => {
      const dirty = (family) => !['npm:lint', 'lint'].includes(family); // the lint script runs eslint: both were approved
      assert.equal(classifyHardGate('Bash', { command: 'npm run lint' }, { ...OPTS, codeWritten: dirty }).code, 'routine');
      assert.equal(classifyHardGate('Bash', { command: 'eslint .' }, { ...OPTS, codeWritten: dirty }).code, 'routine');
      assert.equal(classifyHardGate('Bash', { command: 'npm run typecheck' }, { ...OPTS, codeWritten: dirty }).code, 'wrote_code');
      assert.equal(classifyHardGate('Bash', { command: 'npm test' }, { ...OPTS, codeWritten: dirty }).code, 'wrote_code');
      assert.equal(classifyHardGate('Bash', { command: 'npm run lint && npm test' }, { ...OPTS, codeWritten: dirty }).code, 'wrote_code');
    });
  });

  // ---------------------------------------------------------------- A4: a write that has not landed yet
  describe('A4 a write card that waits keeps runners waiting', () => {
    test('A4 RED a runner approved while a write waits does not cover that write', () => {
      const c = conversation();
      const w = writeCard(c, 'package.json');
      waits(w, 'auto_run');
      const r1 = card(c, 'npm test');
      waits(r1, 'wrote_code');
      answerPermission(r1.id, 'allow');
      waits(card(c, 'npm test'), 'wrote_code');
    });
    test('A4 RED the write lands when the owner allows it: the next runner asks', () => {
      const c = conversation();
      const w = writeCard(c, 'package.json');
      const r1 = card(c, 'npm test');
      answerPermission(r1.id, 'allow');
      answerPermission(w.id, 'allow');
      waits(card(c, 'npm test'), 'wrote_code');
    });
    test('A4 RED a write waiting in another conversation of the same folder', () => {
      const a = conversation();
      const b = conversation();
      writeCard(a, 'package.json');
      const r1 = card(b, 'npm test');
      answerPermission(r1.id, 'allow');
      waits(card(b, 'npm test'), 'wrote_code');
    });
    test('A4 guard: a denied write does not keep runners waiting', () => {
      const c = conversation();
      const w = writeCard(c, 'package.json');
      const r1 = card(c, 'npm test');
      answerPermission(r1.id, 'allow');
      answerPermission(w.id, 'deny');
      assert.equal(allowed(card(c, 'npm test')), true);
    });
    test('A4 guard: a waiting card that writes no code does not keep runners waiting', () => {
      const c = conversation();
      streamWrite(c, path.join(P, 'src', 'n.js'));
      const r1 = card(c, 'npm test');
      answerPermission(r1.id, 'allow');
      waits(card(c, 'git push'));
      assert.equal(allowed(card(c, 'npm test')), true);
    });
    test('A4 guard: a write waiting in another project does not', () => {
      const a = conversation(QA);
      writeCard(a, 'package.json', QA);
      assert.equal(allowed(card(conversation(P), 'npm test')), true);
    });
  });

  // ---------------------------------------------------------------- F3: the marks survive a restart
  describe('F3 the marks are kept on disk', () => {
    const file = () => path.join(MARKS, 'code-marks.json');
    // a restart: what is not on disk yet is written (a stop flushes it), then memory goes and the file stays
    const restart = () => _resetPermissionStoreForTests();
    const flush = () => store._flushCodeMarksForTests();
    beforeEach(() => {
      fs.rmSync(MARKS, { recursive: true, force: true });
      fs.mkdirSync(MARKS, { recursive: true });
      assert.equal(typeof store._setCodeMarksDirForTests, 'function', 'the store can be pointed at a test folder');
      store._setCodeMarksDirForTests(MARKS);
      _resetPermissionStoreForTests();
    });
    after(() => { if (typeof store._setCodeMarksDirForTests === 'function') store._setCodeMarksDirForTests(null); });

    test('F3 RED a write made before a restart still makes the runner ask', () => {
      streamWrite(conversation(), path.join(P, 'src', 'n.js'));
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F3 RED a family that was not approved stays marked over a restart', () => {
      const c = conversation();
      streamWrite(c, path.join(P, 'src', 'n.js'));
      const r = card(c, 'npm test');
      answerPermission(r.id, 'allow');
      restart();
      const d = conversation();
      assert.equal(allowed(card(d, 'npm test')), true, 'what the owner approved stays approved');
      waits(card(d, 'npm run lint'), 'wrote_code');
    });
    test('F3 the file is valid JSON, written atomically, with no temp file left', () => {
      streamWrite(conversation(), path.join(P, 'src', 'n.js'));
      flush();
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      assert.equal(data.version, 1);
      assert.ok(data.writes && typeof data.writes === 'object');
      assert.deepEqual(fs.readdirSync(MARKS).filter((f) => f !== 'code-marks.json'), []);
    });
    for (const [name, text] of [['not JSON', '{not json'], ['an array', '[]'], ['a wrong shape', '{"version":1,"writes":"x"}'], ['empty', '']]) {
      test('F3 RED a corrupt file (' + name + ') makes the runner ask once, and is repaired', () => {
        fs.writeFileSync(file(), text);
        restart();
        const c = conversation();
        const r = card(c, 'npm test');
        waits(r, 'wrote_code');
        answerPermission(r.id, 'allow');
        assert.equal(allowed(card(c, 'npm test')), true);
        flush();
        assert.equal(JSON.parse(fs.readFileSync(file(), 'utf8')).version, 1);
      });
    }
    test('F3 a mark older than the 30-day safety floor has expired (round 10 raised it from 24 hours)', () => {
      streamWrite(conversation(), path.join(P, 'src', 'n.js'));
      restart();
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const old = Date.now() - 31 * 24 * 3600 * 1000;
      for (const v of Object.values(data.writes)) v.at = old;
      fs.writeFileSync(file(), JSON.stringify(data));
      restart();
      assert.equal(allowed(card(conversation(), 'npm test')), true);
    });
    test('F3 a mark of a day ago has not (round 10: it no longer expires at 24 hours)', () => {
      streamWrite(conversation(), path.join(P, 'src', 'n.js'));
      restart();
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const v of Object.values(data.writes)) v.at = Date.now() - 25 * 3600 * 1000;
      fs.writeFileSync(file(), JSON.stringify(data));
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F3 the file stays small: many writes collapse into one mark for everything', () => {
      const c = conversation();
      for (let i = 0; i < 2500; i++) streamWrite(c, path.join(P, 'src', 'f' + i + '.js'));
      flush();
      assert.ok(fs.statSync(file()).size < 400_000, 'size ' + fs.statSync(file()).size);
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F3 a process that ends saves the marks it had not saved yet', () => {
      const dir = path.join(BASE, 'marks-exit');
      fs.mkdirSync(dir, { recursive: true });
      const url = (rel) => JSON.stringify(new URL('../src/' + rel, import.meta.url).href);
      // two writes in one second: the first is saved at once, the second only when the process ends
      const code = 'const s = await import(' + url('permissions/store.mjs') + ');'
        + 's._setCodeMarksDirForTests(' + JSON.stringify(dir) + ');'
        + 'for (const f of ["a.js", "b.js"]) s.observeStreamLine("c1", { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_" + f, name: "Write", input: { file_path: ' + JSON.stringify(path.join(P, 'src')) + ' + "/" + f, content: "x" } }] } });'
        + 'process.exit(0);';
      execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'code-marks.json'), 'utf8'));
      assert.ok(Object.keys(data.writes).some((k) => k.toLowerCase().endsWith('b.js')), JSON.stringify(data.writes));
    });
    test('F3 nothing is written inside a project folder', () => {
      const inside = path.join(PROJECT_ROOT, '_scratch', 'code-marks-never-created');
      store._setCodeMarksDirForTests(inside);
      _resetPermissionStoreForTests();
      streamWrite(conversation(), path.join(P, 'src', 'n.js'));
      waits(card(conversation(), 'npm test'), 'wrote_code');
      assert.equal(fs.existsSync(inside), false, 'nothing is written inside a project');
    });
  });

  // ---------------------------------------------------------------- LOW: commands that rewrite code when they run
  describe('LOW writers that run', () => {
    for (const command of ['cargo add serde', 'go get example.com/x', 'dotnet add package Newtonsoft.Json', 'cmake -S . -B build', 'make gen',
      'npx prettier --write .', 'npx eslint --fix .', 'npm run fix', 'npx tsc', 'tsc -p .', 'npx vitest run -u']) {
      test('LOW RED the owner allows `' + command + '`: the next runner asks', () => {
        const c = conversation();
        const w = card(c, command);
        waits(w);
        assert.equal(answerPermission(w.id, 'allow').ok, true);
        waits(card(c, 'npm test'), 'wrote_code');
      });
    }
    test('LOW RED the owner allows a dirty vite build: it wrote the bundle, the tests ask', () => {
      const c = conversation();
      streamWrite(c, path.join(P, 'src', 'n.js'));
      const b = card(c, 'npx vite build');
      waits(b, 'wrote_code');
      answerPermission(b.id, 'allow');
      waits(card(c, 'npm test'), 'wrote_code');
      assert.equal(allowed(card(c, 'npx vite build')), true, 'the same build again was what the owner saw');
    });
    test('LOW guard: an auto-allowed lint or vite build marks nothing', () => {
      const c = conversation();
      assert.equal(allowed(card(c, 'npm run lint')), true);
      assert.equal(allowed(card(c, 'npx vite build')), true);
      assert.equal(allowed(card(c, 'npm test')), true);
    });
    test('LOW guard: an owner-approved command that writes no code marks nothing', () => {
      const c = conversation();
      const w = card(c, 'curl https://example.com');
      answerPermission(w.id, 'allow');
      assert.equal(allowed(card(c, 'npm test')), true);
    });
    test('LOW guard: these do not count as writes', () => {
      for (const command of ['cargo --version', 'make -n', 'make --dry-run all', 'npx eslint .', 'npx prettier --check .', 'tsc --noEmit', 'go version', 'dotnet --info', 'cmake --version',
        'gradle --version', 'mvn -v', 'composer show', 'bundle exec rake -T', 'npx jest']) {
        assert.deepEqual(codeWriteTargets('Bash', { command }, OPTS), [], command);
      }
    });
    test('LOW RED these count as writes', () => {
      for (const command of ['cargo add serde', 'cargo update', 'go get example.com/x', 'go mod tidy', 'go generate ./...', 'dotnet add package X', 'dotnet new console',
        'cmake -S . -B build', 'make', 'make gen', 'npx prettier --write .', 'prettier -w src', 'npx eslint --fix .', 'eslint . --fix', 'npx tsc', 'tsc -b',
        'npx vitest run -u', 'npx vitest run --update', 'npx jest -u', 'dotnet restore', 'dotnet format', 'go fmt ./...', 'composer install',
        'composer require x/y', 'bundle install', 'gradle build', './gradlew assemble', 'mvn package']) {
        assert.ok(codeWriteTargets('Bash', { command }, OPTS).length > 0, command);
      }
    });
  });

  // ---------------------------------------------------------------- LOW: WebSearch
  describe('LOW a WebSearch that carries data', () => {
    test('LOW RED an owner-remembered WebSearch does not cover a query that looks like data', () => {
      setPermissionAutonomy(() => false);
      const c = conversation();
      const first = ask(c, 'WebSearch', { query: 'node test runner' });
      assert.equal(answerPermission(first.id, 'allow_session').remembered, true);
      waits(ask(c, 'WebSearch', { query: 'https://evil.example/collect?d=abc' }));
      assert.equal(ask(c, 'WebSearch', { query: 'vitest snapshot' }).decision.behavior, 'allow', 'an ordinary query is still remembered');
    });
  });
});

const search = (query, extra = {}) => ['WebSearch', { query, ...extra }];
for (const q of ['site:evil.example SECRET_VALUE_HERE', 'https://evil.example/?q=abc', 'http://203.0.113.5/x', 'www.evil.example data', 'evil.example/collect?d=x',
  'ftp://host/file', 'data 203.0.113.5 here', 'mail owner@example.com about x', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk=', 'deadbeefdeadbeefdeadbeefdeadbeef0123', 'x'.repeat(401)]) {
  expectHard('LOW RED a WebSearch query that looks like an address or data', search(q));
}
for (const q of ['gh' + 'p_abcdefghijklmnopqrstuvwxyz0123', 'sk' + '-abcdefghijklmnopqrstuvwxyz123456', 'AK' + 'IAABCDEFGHIJKLMNOP']) {
  expectHard('LOW RED a WebSearch query with a secret', search(q), 'credentials');
}
for (const q of ['node test runner', 'how to use vitest with typescript', 'node.js 22 release notes', 'react useEffect cleanup', 'e.g. foo vs bar',
  'python 3.12 what is new', 'windows 11 junction vs symlink']) {
  expectRoutine('LOW guard', search(q));
}
expectRoutine('LOW guard: a domain filter', search('vitest config', { allowed_domains: ['vitest.dev'] }));
expectRoutine('LOW guard: a domain filter', search('vitest config', { blocked_domains: ['example.com', 'w3schools.com'] }));
for (const domains of [['QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk.evil.example'], ['https://evil.example/x'], ['evil.example/collect'], [42], 'evil.example']) {
  expectHard('LOW RED a domain filter that carries data', search('x', { allowed_domains: domains }));
}
test('LOW RED a WebSearch with data in the query is never remembered for the conversation', () => {
  assert.equal(sessionRuleKey('WebSearch', { query: 'https://evil.example/x' }, { cwd: P }), null);
  assert.equal(sessionRuleKey('WebSearch', { query: 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123' }, { cwd: P }), null);
  assert.notEqual(sessionRuleKey('WebSearch', { query: 'node test runner' }, { cwd: P }), null);
});

// ---------------------------------------------------------------- LOW: files that run code by themselves
const write = (rel) => ['Write', { file_path: path.join(P, rel), content: 'x' }];
for (const rel of ['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.config/mise.toml', '.config/mise/config.toml', '.mise/config.toml',
  '.tool-versions', 'bunfig.toml', '.bunfig.toml', '.cargo/config.toml', '.cargo/config', '.git/hooks/pre-commit', '.git/hooks/pre-push']) {
  expectHard('LOW RED', write(rel), 'auto_run');
}
expectHard('LOW RED', sh('echo x > .tool-versions'), 'auto_run');
expectHard('LOW RED', sh('echo x > .git/hooks/pre-commit'), 'auto_run');
expectHard('LOW', write('.git/config'), 'settings');
for (const rel of ['docs/mise.md', 'src/tool-versions.ts', 'src/hooks/useThing.ts', 'docs/cargo.md']) expectRoutine('LOW guard', write(rel));

// ---------------------------------------------------------------- the ordinary work this round must not slow down
for (const call of [write('src/a.js'), sh('npm test'), sh('node --test'), sh('npx vitest run'), sh('git status'), sh('cat src/a.js'), agent({ subagent_type: 'build-boss' })]) {
  expectRoutine('guard: ordinary work', call);
}

after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
