// WP-AUTONOMY-GW, verify round 9. Each row marked RED was run against the code before this round and
// failed there (the card was auto-approved, or a mark was lost or kept too long); the fix makes it wait for the owner.
// Rows without a label are guards for ordinary work.
//   F1  the store stopped recording stream tool uses at 4000, so a subagent's card after a long run was judged in the
//       run folder. Now the oldest ids are dropped instead (newest kept), and once any subagent has been seen in the
//       run, a card the stream has not placed (an unseen id, an id dropped as the oldest, a parent that is not a
//       dispatch the stream showed) waits as 'outside_folder'.
//   F2  a card without a tool_use_id while any subagent runs waits ('outside_folder'): it cannot be placed.
//   F3  a subagent's folder is checked again at every card at its real location: a junction made (or swapped in)
//       after the dispatch makes its cards wait.
//   F4  WebSearch: a query that carries encoded data (base64 or hex chunks, long letter or digit runs, percent
//       escapes, a run of emoji, full-width or zero-width tricks, a bare host name with a long or data-like label,
//       host:port, IPv6), a field other than query/allowed_domains/blocked_domains/mode, a mode other than
//       standard/extended, or domain filters over 10 entries, 24 characters per label, 5 labels or 200 characters
//       in total, waits as 'outbound'.
//   F5  the marks file: a mark dated in the future is clamped (a write) or ignored (an approval); an approval with a
//       number above the file's own is ignored; a save merges with what is on disk (two gateways keep each other's
//       marks); a marks file that is a link (symbolic or hard) is refused and treated as corrupt; a stale lock file
//       does not stop a save.
//   A1  (round-9 probe a1) an Agent or Task `cwd` that is drive-relative (`C:foo`) and a field that is not enumerable
//       are not proven safe.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyHardGate } from '../src/permissions/hard-gate.mjs';
import { sessionRuleKey } from '../src/permissions/rules.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import * as store from '../src/permissions/store.mjs';
import * as marks from '../src/permissions/code-marks.mjs';
import { isAutonomyOn, _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';

const {
  createPermissionRequest, answerPermission, listPendingPermissions, observeStreamLine, registerPermissionRun,
  setPermissionAutonomy, _resetPermissionStoreForTests,
} = store;
// Round 11: these suites test the write marks alone; the first-runner rule has its own tests (permissions-round11).
store._setFirstRunnerForTests(false);

const WIN = process.platform === 'win32';
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round9-')));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const link = (target, at) => fs.symlinkSync(target, at, WIN ? 'junction' : 'dir');
const pkg = (dir, scripts) => put(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
const SECRET_DIR = 'sec' + 'rets'; // split so no hook mistakes this file for a secret read

// P: a project that is its own repository; OUT: a folder outside it; QA: a second project (another gateway's work)
const P = path.join(BASE, 'proj');
const OUT = path.join(BASE, 'outside');
const QA = path.join(BASE, 'qa');
pkg(P, { test: 'node --test' });
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
for (const rel of ['src/a.js', 'src/a.test.js', 'notes.txt', SECRET_DIR + '/a.txt']) put(path.join(P, rel));
put(path.join(OUT, 'a.js'));
put(path.join(OUT, 'notes.txt'));
pkg(QA, { test: 'node --test' });
put(path.join(QA, '.git', 'HEAD'), 'ref: refs/heads/main\n');
put(path.join(QA, 'src', 'a.test.js'));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const OPTS = { cwd: P, home: HOME, tmp: TMP };
const run = (tool, input, opts = OPTS) => classifyHardGate(tool, input, opts);
const show = (v) => JSON.stringify(v).split(BASE).join('').slice(0, 150);

function expectHard(name, tool, input, code) {
  test(name + ': ' + tool + ' ' + show(input), () => {
    const got = run(tool, input);
    assert.equal(got.hard, true, JSON.stringify({ input, got }));
    assert.notEqual(got.code, 'routine');
    if (code) assert.equal(got.code, code, JSON.stringify({ input, got }));
  });
}
function expectRoutine(name, tool, input) {
  test(name + ': ' + tool + ' ' + show(input), () => {
    const got = run(tool, input);
    assert.equal(got.code, 'routine', JSON.stringify({ input, got }));
  });
}

// ---------------------------------------------------------------- F4: WebSearch queries that carry data
const b64 = Buffer.from('DUMMY_VALUE_FOR_A_TEST_1234567890_abcdef').toString('base64');
const hex = Buffer.from('DUMMY_VALUE_1234').toString('hex');
const chunks = (s, n) => s.match(new RegExp('.{1,' + n + '}', 'g')).join(' ');
const FW_URL = 'ｈｔｔｐ：／／evil．com'; // full-width h t t p : / / and a full-width dot
for (const query of [
  chunks(b64, 12), chunks(b64, 20), chunks(b64, 8), chunks(hex, 8), chunks(hex, 6),
  '1234567890'.repeat(4), 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn', 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'ñ'.repeat(50) + '1', 'аbс1'.repeat(20), '\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}\u{1F605}\u{1F606}\u{1F607}',
  '%44%55%4d%4d%59%5f%56%41%4c', '%44%55 %4d%4d %59%5f', FW_URL, 'evil．com／path',
  'secretdata.attacker.example', 'x9f3k2.evil.com', 'a.b.c.d.example', 'evil.example:8080', 'see 2001:db8::1 now', 'fe80::1ff:fe23:4567:890a',
  'Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1A Cd2Cd2Cd2Cd2Cd2Cd2Cd2Cd2Cd2Cd2C Ef3Ef3Ef3Ef3Ef3Ef3Ef3Ef3Ef3Ef3E',
  'q1w2e3r4t5y6 a1s2d3f4g5h6 z1x2c3v4b5n6', 'note​book',
]) {
  expectHard('F4 RED a WebSearch query that carries data', 'WebSearch', { query }, 'outbound');
}
for (const extra of [{ secret: 'DATA' }, { max_results: 5 }, { mode: 'x' }, { mode: 1 }, { query2: 'y' }]) {
  expectHard('F4 RED a WebSearch with a field Forge does not know', 'WebSearch', { query: 'node test runner', ...extra }, 'outbound');
}
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
for (const extra of [
  { allowed_domains: many(11, (i) => 'd' + i + '.com') }, { blocked_domains: many(50, (i) => 'xq' + i.toString(36) + '.org') },
  { allowed_domains: ['a1b2c3d4e5f6g7h8i9j0k1l2m.com'] }, { allowed_domains: ['a1.b2.c3.d4.e5.f6.g7.com'] },
  { allowed_domains: many(8, (i) => 'abcdefghijklmnopqrstuv' + i + '.com') }, { allowed_domains: ['aGVsbG8gd29y.example.com'] },
]) {
  expectHard('F4 RED a WebSearch domain filter that carries data', 'WebSearch', { query: 'docs', ...extra }, 'outbound');
}
// what real WebSearch calls look like (from the local transcripts) stays routine
for (const input of [
  { query: 'node test runner docs' },
  { query: 'Intel Wireless Wi-Fi Drivers for Windows 10 and Windows 11 download page', mode: 'standard', allowed_domains: ['intel.com'] },
  { query: 'AMD chipset drivers AM5 download Ryzen 9000 Windows 11 support page', mode: 'extended' },
  { query: 'ADLX IADLX3DSettingsServices GetAntiLag GetBoost GetChill ResetShaderCache gpuopen manual', mode: 'standard', allowed_domains: ['gpuopen.com', 'github.com', 'amd.com'] },
  { query: 'Kingston FURY Renegade DDR5 6400 CL32 datasheet 1.4V XMP profile', mode: 'standard' },
  { query: 'valorant support article', allowed_domains: ['support-valorant.riotgames.com', 'support-leagueoflegends.riotgames.com', 'playvalorant.com', 'riotgames.com'] },
  { query: 'vitest config', blocked_domains: ['example.com', 'w3schools.com'] },
  { query: 'learn.microsoft.com' }, { query: 'tsconfig.json' }, { query: 'python 3.12 what is new 2024 2025 2026' },
  { query: 'react useEffect cleanup function TypeScript example' }, { query: 'Donaudampfschifffahrt history' },
]) {
  expectRoutine('F4 guard: a real WebSearch', 'WebSearch', input);
}
test('F4 RED a WebSearch that carries data is never remembered for the conversation', () => {
  assert.equal(sessionRuleKey('WebSearch', { query: chunks(b64, 12) }, { cwd: P }), null);
  assert.equal(sessionRuleKey('WebSearch', { query: 'x', secret: 'y' }, { cwd: P }), null);
  assert.notEqual(sessionRuleKey('WebSearch', { query: 'node test runner', mode: 'standard' }, { cwd: P }), null);
});

// ---------------------------------------------------------------- A1: dispatch fields the probe found
const agent = (extra) => ({ description: 'd', prompt: 'p', ...extra });
if (WIN) expectHard('A1 RED an Agent with a drive-relative cwd', 'Agent', agent({ cwd: P[0] + ':foo' }));
expectHard('A1 RED an Agent with a cwd that is not enumerable', 'Agent', Object.defineProperty(agent({}), 'cwd', { value: OUT, enumerable: false }));
expectHard('A1 RED a Task with a mode that is not enumerable', 'Task', Object.defineProperty(agent({}), 'mode', { value: 'bypassPermissions', enumerable: false }));
expectHard('A1 RED a Bash card with a cwd that is not enumerable', 'Bash', Object.defineProperty({ command: 'cat src/a.js' }, 'cwd', { value: OUT, enumerable: false }));
expectHard('A1 RED a WebSearch with a field that is not enumerable', 'WebSearch', Object.defineProperty({ query: 'x' }, 'secret', { value: 'DATA', enumerable: false }));
expectRoutine('A1 guard', 'Agent', agent({ cwd: 'src' }));
expectRoutine('A1 guard', 'Bash', { command: 'cat src/a.js', description: 'read' });

// ---------------------------------------------------------------- the store
describe('round 9 store', () => {
  const PROJECT = 'round9-project';
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
    store._setCodeMarksDirForTests(null);
    _resetConversationsForTests();
    _resetPermissionStoreForTests();
  });
  const conversation = (cwd = P) => { const id = createConversation({ project: PROJECT }).id; registerPermissionRun(id, { cwd }); return id; };
  const ask = (convId, toolName, input, toolUseId) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName, input, ...(toolUseId !== undefined ? { toolUseId } : {}) });
  const card = (convId, command, toolUseId) => ask(convId, 'Bash', { command }, toolUseId);
  let n = 0;
  const id = () => 'toolu_r9_' + (n += 1);
  const line = (convId, name, input, { parent = null, toolUseId = id() } = {}, s = store) => {
    s.observeStreamLine(convId, { type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
    return toolUseId;
  };
  const dispatch = (convId, extra, opts) => line(convId, 'Agent', { description: 'd', prompt: 'p', subagent_type: 'general-purpose', ...extra }, opts);
  const allowed = (r) => Boolean(r.decision && r.decision.behavior === 'allow');
  const codeOf = (r) => { const c = listPendingPermissions().find((p) => p.id === r.id); return c ? c.gate.code : null; };
  const waits = (r, code) => {
    assert.equal(r.decision, undefined, 'the card waits for the owner');
    if (code) assert.equal(codeOf(r), code);
  };
  const filler = (convId, count) => { for (let i = 0; i < count; i++) line(convId, 'Read', { file_path: path.join(P, 'notes.txt') }); };

  // ---------------------------------------------------------------- F1
  describe('F1 a long run keeps placing the newest tool uses', () => {
    test('F1 RED after 4100 tool uses, a subagent working in a folder of secret files has its card judged there', () => {
      const c = conversation();
      filler(c, 4100);
      const a = dispatch(c, { cwd: SECRET_DIR });
      const tu = line(c, 'Bash', { command: 'cat a.txt' }, { parent: a });
      waits(card(c, 'cat a.txt', tu));
    });
    test('F1 RED an id dropped as the oldest, while a subagent runs, waits', () => {
      const c = conversation();
      const first = line(c, 'Bash', { command: 'cat src/a.js' });
      dispatch(c, {});
      filler(c, 4100);
      waits(card(c, 'cat src/a.js', first), 'outside_folder');
    });
    test('F1 RED an id the stream never showed, while a subagent without a cwd runs, waits', () => {
      const c = conversation();
      dispatch(c, {});
      waits(card(c, 'cat src/a.js', 'toolu_never_seen'), 'outside_folder');
    });
    test('F1 RED a tool use under a parent the stream never showed waits', () => {
      const c = conversation();
      const tu = line(c, 'Read', { file_path: 'notes.txt' }, { parent: 'toolu_ghost_parent' });
      waits(ask(c, 'Read', { file_path: 'notes.txt' }, tu), 'outside_folder');
    });
    test('F1 RED a tool use under a parent that is not an Agent or Task call waits', () => {
      const c = conversation();
      const b = line(c, 'Bash', { command: 'git status' });
      const tu = line(c, 'Read', { file_path: 'notes.txt' }, { parent: b });
      waits(ask(c, 'Read', { file_path: 'notes.txt' }, tu), 'outside_folder');
    });
    test('F1 guard: without any subagent, an id the stream has not shown yet is judged in the run folder', () => {
      const c = conversation();
      assert.equal(allowed(card(c, 'cat src/a.js', 'toolu_not_yet')), true);
      filler(c, 4100);
      assert.equal(allowed(card(c, 'cat src/a.js', 'toolu_not_yet_2')), true);
    });
    test('F1 guard: the main agent\'s placed cards and an inside subagent\'s cards stay routine after a long run', () => {
      const c = conversation();
      filler(c, 4100);
      const a = dispatch(c, { cwd: 'src' });
      const sub = line(c, 'Bash', { command: 'cat a.js' }, { parent: a });
      assert.equal(allowed(card(c, 'cat a.js', sub)), true);
      const main = line(c, 'Bash', { command: 'cat src/a.js' });
      assert.equal(allowed(card(c, 'cat src/a.js', main)), true);
    });
  });

  // ---------------------------------------------------------------- F2
  describe('F2 a card without a tool_use_id while a subagent runs', () => {
    test('F2 RED a subagent works in a sub-folder: a card without an id waits', () => {
      const c = conversation();
      dispatch(c, { cwd: SECRET_DIR });
      waits(card(c, 'cat a.txt'), 'outside_folder');
    });
    test('F2 RED a subagent without a cwd: a card without an id waits too (it cannot be placed)', () => {
      const c = conversation();
      dispatch(c, {});
      waits(card(c, 'cat src/a.js'), 'outside_folder');
    });
    test('F2 guard: without any subagent, a card without an id is judged in the run folder', () => {
      assert.equal(allowed(card(conversation(), 'cat src/a.js')), true);
    });
  });

  // ---------------------------------------------------------------- F3
  describe('F3 a subagent folder is checked again at every card', () => {
    test('F3 RED a junction made after the dispatch, where the folder did not exist yet', () => {
      const c = conversation();
      const a = dispatch(c, { cwd: 'later' });
      link(OUT, path.join(P, 'later'));
      const tu = line(c, 'Read', { file_path: 'notes.txt' }, { parent: a });
      waits(ask(c, 'Read', { file_path: 'notes.txt' }, tu), 'outside_folder');
    });
    test('F3 RED a folder swapped for a junction after the dispatch', () => {
      const c = conversation();
      fs.mkdirSync(path.join(P, 'swap'));
      put(path.join(P, 'swap', 'notes.txt'));
      const a = dispatch(c, { cwd: 'swap' });
      fs.rmSync(path.join(P, 'swap'), { recursive: true, force: true });
      link(OUT, path.join(P, 'swap'));
      const tu = line(c, 'Read', { file_path: 'notes.txt' }, { parent: a });
      waits(ask(c, 'Read', { file_path: 'notes.txt' }, tu), 'outside_folder');
    });
    test('F3 RED an Agent card allowed while its folder did not exist, then a junction', () => {
      const c = conversation();
      const a = ask(c, 'Agent', agent({ cwd: 'later2' }), 'toolu_agent_later2');
      assert.equal(allowed(a), true, 'a cwd inside the run folder is routine');
      link(OUT, path.join(P, 'later2'));
      const tu = line(c, 'Bash', { command: 'cat notes.txt' }, { parent: 'toolu_agent_later2' });
      waits(card(c, 'cat notes.txt', tu), 'outside_folder');
    });
    test('F3 guard: a subagent in a folder that stays inside is judged there', () => {
      const c = conversation();
      const a = dispatch(c, { cwd: 'src' });
      const tu = line(c, 'Read', { file_path: 'a.js' }, { parent: a });
      assert.equal(allowed(ask(c, 'Read', { file_path: 'a.js' }, tu)), true);
    });
  });

  // ---------------------------------------------------------------- F5: the marks file
  describe('F5 the marks file', () => {
    const MARKS = path.join(BASE, 'marks');
    const file = () => path.join(MARKS, 'code-marks.json');
    const restart = () => _resetPermissionStoreForTests();
    const flush = () => store._flushCodeMarksForTests();
    const key = (p) => (WIN ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
    const keyOf = (p) => (WIN ? path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)).toLowerCase() : path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)));
    const NOW = () => Date.now();
    const FUTURE = Date.UTC(2100, 0, 1);
    const writeLine = (convId, f, s = store) => line(convId, 'Write', { file_path: f, content: 'x' }, {}, s);
    let storeB = null; // a second gateway: its own store state, the same marks file
    before(async () => { storeB = await import('../src/permissions/store.mjs?gateway=b'); });
    beforeEach(() => {
      fs.rmSync(MARKS, { recursive: true, force: true });
      fs.mkdirSync(MARKS, { recursive: true });
      store._setCodeMarksDirForTests(MARKS);
      _resetPermissionStoreForTests();
      if (storeB) storeB._resetPermissionStoreForTests();
    });

    test('F5 RED a write mark dated in the future is clamped to now: it expires at the 30-day floor from now', () => {
      const k = keyOf(path.join(P, 'src', 'n.js'));
      fs.writeFileSync(file(), JSON.stringify({ version: 1, seq: 5, writes: { [k]: { seq: 5, at: FUTURE } }, clean: {} }));
      const now = NOW();
      const got = marks.loadCodeMarks(now);
      assert.ok(got && got.writes && got.writes.has(k), 'the mark is kept (fail closed)');
      assert.ok(got.writes.get(k).at <= now + 60_000, 'clamped, not ' + new Date(got.writes.get(k).at).toISOString());
      marks.saveCodeMarks(got, now);
      const later = marks.loadCodeMarks(now + 31 * 24 * 3600 * 1000);
      assert.equal(later.writes.has(k), false, 'expired at the 30-day safety floor after it was seen (round 10 raised it from 24h)');
    });
    test('F5 RED an approval dated in the future is ignored: the runner still asks', () => {
      const c = conversation();
      writeLine(c, path.join(P, 'src', 'n.js'));
      const r = card(c, 'npm test');
      waits(r, 'wrote_code');
      answerPermission(r.id, 'allow');
      flush();
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      assert.ok(Object.keys(data.clean).length > 0, 'the approval is on disk');
      for (const fam of Object.values(data.clean)) for (const m of Object.values(fam)) m.at = FUTURE;
      fs.writeFileSync(file(), JSON.stringify(data));
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F5 RED an approval numbered above the file\'s own number is ignored', () => {
      const c = conversation();
      writeLine(c, path.join(P, 'src', 'n.js'));
      const r = card(c, 'npm test');
      answerPermission(r.id, 'allow');
      flush();
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const m of Object.values(data.writes)) m.seq = 1;
      data.seq = 1;
      for (const fam of Object.values(data.clean)) for (const m of Object.values(fam)) m.seq = 99;
      fs.writeFileSync(file(), JSON.stringify(data));
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F5 RED two gateways saving in turn keep each other\'s marks on disk', () => {
      writeLine(conversation(), path.join(P, 'src', 'one.js'));
      flush();
      writeLine(conversation(QA), path.join(QA, 'src', 'two.js'), storeB);
      storeB._flushCodeMarksForTests();
      writeLine(conversation(), path.join(P, 'src', 'three.js'));
      flush();
      const keys = Object.keys(JSON.parse(fs.readFileSync(file(), 'utf8')).writes);
      for (const f of [path.join(P, 'src', 'one.js'), path.join(QA, 'src', 'two.js'), path.join(P, 'src', 'three.js')]) {
        assert.ok(keys.includes(keyOf(f)), path.basename(f) + ' is still on disk: ' + show(keys));
      }
    });
    test('F5 RED a running gateway that saves takes over the other gateway\'s marks: its runner there asks', () => {
      const c = conversation();
      writeLine(c, path.join(P, 'src', 'one.js')); // gateway A starts (an empty file) and saves
      flush();
      writeLine(conversation(QA), path.join(QA, 'src', 'four.js'), storeB); // gateway B writes in another project
      storeB._flushCodeMarksForTests();
      writeLine(c, path.join(P, 'src', 'five.js')); // A saves again: it merges what B saved
      flush();
      waits(card(conversation(QA), 'npm test'), 'wrote_code');
      const keys = Object.keys(JSON.parse(fs.readFileSync(file(), 'utf8')).writes);
      assert.ok(keys.includes(keyOf(path.join(QA, 'src', 'four.js'))), show(keys));
    });
    test('F5 RED a marks file that is a hard link to another file is refused: every folder asks once', () => {
      const other = path.join(BASE, 'other-marks.json');
      const empty = JSON.stringify({ version: 1, seq: 0, writes: {}, clean: {} });
      fs.writeFileSync(other, empty);
      fs.linkSync(other, file());
      restart();
      const c = conversation();
      const r = card(c, 'npm test');
      waits(r, 'wrote_code');
      answerPermission(r.id, 'allow');
      assert.equal(allowed(card(c, 'npm test')), true, 'asked once');
      flush();
      assert.equal(fs.readFileSync(other, 'utf8'), empty, 'the other file is never written');
      assert.equal(fs.lstatSync(file()).nlink, 1, 'the marks file is its own file again');
    });
    test('F5 RED a marks file that is a symbolic link is refused', (t) => {
      const other = path.join(BASE, 'other-marks-2.json');
      const empty = JSON.stringify({ version: 1, seq: 0, writes: {}, clean: {} });
      fs.writeFileSync(other, empty);
      try { fs.symlinkSync(other, file(), 'file'); } catch (err) { t.skip('no file symlinks here: ' + err.code); return; }
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
      flush();
      assert.equal(fs.readFileSync(other, 'utf8'), empty, 'the link target is never written');
      assert.equal(fs.lstatSync(file()).isSymbolicLink(), false);
    });
    test('F5 NEW a stale lock file does not stop a save', () => {
      const lock = file() + '.lock';
      fs.writeFileSync(lock, '1');
      const old = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(lock, old, old);
      writeLine(conversation(), path.join(P, 'src', 'n.js'));
      flush();
      const keys = Object.keys(JSON.parse(fs.readFileSync(file(), 'utf8')).writes);
      assert.ok(keys.includes(keyOf(path.join(P, 'src', 'n.js'))), show(keys));
      assert.equal(fs.existsSync(lock), false, 'the stale lock is gone');
    });
    test('F5 a file broken while the gateway runs makes every folder ask once more (fail closed)', () => {
      const c = conversation();
      writeLine(c, path.join(P, 'src', 'n.js'));
      const r = card(c, 'npm test');
      answerPermission(r.id, 'allow');
      flush();
      assert.equal(allowed(card(c, 'npm test')), true);
      fs.writeFileSync(file(), '{broken');
      writeLine(conversation(QA), path.join(QA, 'src', 'n.js'));
      flush();
      waits(card(c, 'npm test'), 'wrote_code');
      assert.equal(JSON.parse(fs.readFileSync(file(), 'utf8')).version, 1, 'and the file is repaired');
    });
    test('F5 guard: one gateway alone still clears what the owner approved', () => {
      const c = conversation();
      writeLine(c, path.join(P, 'src', 'n.js'));
      const r = card(c, 'npm test');
      answerPermission(r.id, 'allow');
      flush();
      restart();
      assert.equal(allowed(card(conversation(), 'npm test')), true);
      assert.equal(key(P).length > 0, true);
    });
  });
});

after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
