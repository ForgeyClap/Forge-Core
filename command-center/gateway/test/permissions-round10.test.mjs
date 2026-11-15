// WP-AUTONOMY-GW, verify round 10. Each row marked RED was run against the code before this round and
// failed there (the card was auto-approved, or a mark expired too soon); the fix makes it wait for the owner.
// Rows without a label are guards for ordinary work that must stay routine.
//   F1  WebSearch: data hidden in the dot-separated labels of a host-like word inside a longer query
//       ('ab12cd34ef56gh78.example.com resolve', 'what is 4f6e65.4f7468.6572.example.com'). The encoded-data /
//       hex / long-run rules now run per dot label of every host-like word, not only on a whole-query host.
//   F2  WebSearch domain filters carry data in a label (8 x 20-hex .com was routine). A data-like label asks, and
//       the total filter length is capped to 120 characters.
//   F3  the write-then-run marks no longer expire by age at 24 hours; a mark stays until an owner-approved runner of
//       its family covers it, with only a 30-day safety expiry.
//   F4  the first placement of a subagent dispatch wins: a card for an Agent/Task id can never loosen an existing
//       OUTSIDE placement (from the stream) to inside; an outside subagent's cards keep waiting.
//   F5  a card for a tool_use id the stream has not placed, while an Agent/Task dispatch is in flight (pending),
//       waits as 'outside_folder' rather than being judged in the run folder (explicit, not only via subagentRuns).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyHardGate } from '../src/permissions/hard-gate.mjs';
import { webSearchProblem } from '../src/permissions/allow-list.mjs';
import { sessionRuleKey } from '../src/permissions/rules.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import * as store from '../src/permissions/store.mjs';
import { isAutonomyOn, _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';

const {
  createPermissionRequest, answerPermission, listPendingPermissions, observeStreamLine, registerPermissionRun,
  setPermissionAutonomy, _resetPermissionStoreForTests,
} = store;
// Round 11: these suites test the write marks alone; the first-runner rule has its own tests (permissions-round11).
store._setFirstRunnerForTests(false);

const WIN = process.platform === 'win32';
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round10-')));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pkg = (dir, scripts) => put(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
const SECRET_DIR = 'sec' + 'rets';

const P = path.join(BASE, 'proj');
const OUT = path.join(BASE, 'outside');
pkg(P, { test: 'node --test' });
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
for (const rel of ['src/a.js', 'src/a.test.js', 'notes.txt', SECRET_DIR + '/a.txt']) put(path.join(P, rel));
put(path.join(OUT, 'a.js'));
put(path.join(OUT, 'notes.txt'));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const OPTS = { cwd: P, home: HOME, tmp: TMP };
const run = (tool, input, opts = OPTS) => classifyHardGate(tool, input, opts);
const show = (v) => JSON.stringify(v).split(BASE).join('').slice(0, 160);

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

// ---------------------------------------------------------------- F1: data in a host-like word's labels
const HEX = (n) => Array.from({ length: n }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
for (const query of [
  'ab12cd34ef56gh78.example.com resolve',
  'what is 4f6e65.4f7468.6572.example.com',
  'resolve ' + HEX(28) + '.' + HEX(28) + '.' + HEX(28) + '.' + HEX(28) + '.example.com',
  'ab12cd34ef56gh78.example.com resolve now please',
  'nslookup 6a7b8c9d0e1f2a3b4c5d.evil.example dns',
  'lookup ' + Array.from({ length: 10 }, () => HEX(28)).join('.'),
  'see ' + HEX(28) + '.' + HEX(28) + '.' + HEX(28) + ' docs',
  'ver 1.' + HEX(28) + '.' + HEX(28),
]) {
  expectHard('F1 RED a host-like word carrying data in a longer query', 'WebSearch', { query }, 'outbound');
}
// ordinary host names and file/version words in a longer query stay routine (no new false positive)
for (const query of [
  'how do I use docs.python.org for help',
  'read the learn.microsoft.com guide about azure functions',
  'fix a merge conflict in package-lock.json after npm install',
  'why does docker-compose.yml not start my service',
  'edit vite.config.ts and tsconfig.json for a monorepo',
  'open src/app.module.ts and app.component.ts in the editor',
  'upgrade to node v18.17.0 and npm 10.2.3 today',
  'Kingston FURY Renegade DDR5 6400 CL32 datasheet 1.4V XMP profile',
  'support-leagueoflegends.riotgames.com article about ranked',
  'ffmpeg 6.1 convert file.mkv to file.mp4 without re-encoding',
]) {
  expectRoutine('F1 guard: an ordinary host/file/version word', 'WebSearch', { query });
}

// ---------------------------------------------------------------- F2: domain filters that carry data / are too long
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
for (const extra of [
  { allowed_domains: many(8, (i) => HEX(20) + (i % 2) + '.com') }, // ~192 chars of hex labels
  { blocked_domains: [HEX(20) + '.io'] },
  { allowed_domains: ['deadbeef0123.io'] },
  { allowed_domains: ['a1b2c3d4e5f6.example.com'] },
  { allowed_domains: many(6, (i) => 'zzzxxxqqqwwwkkkjjjv' + i + '.net') }, // long few-vowel labels + over 120 chars
]) {
  expectHard('F2 RED a WebSearch domain filter that carries data', 'WebSearch', { query: 'docs', ...extra }, 'outbound');
}
for (const input of [
  { query: 'valorant support article', allowed_domains: ['support-valorant.riotgames.com', 'support-leagueoflegends.riotgames.com', 'playvalorant.com', 'riotgames.com'] },
  { query: 'vitest config', blocked_domains: ['example.com', 'w3schools.com'] },
  { query: 'ADLX manual', allowed_domains: ['gpuopen.com', 'github.com', 'amd.com'] },
  { query: 'office 365 admin', allowed_domains: ['office365.com', 'microsoft.com'] },
  { query: 'intel drivers', allowed_domains: ['intel.com'] },
]) {
  expectRoutine('F2 guard: real domain filters', 'WebSearch', input);
}
test('F2/F1 a WebSearch that carries data is never remembered for the conversation', () => {
  assert.equal(sessionRuleKey('WebSearch', { query: 'ab12cd34ef56gh78.example.com resolve' }, { cwd: P }), null);
  assert.equal(sessionRuleKey('WebSearch', { query: 'docs', allowed_domains: ['deadbeef0123.io'] }, { cwd: P }), null);
  assert.notEqual(sessionRuleKey('WebSearch', { query: 'node test runner', mode: 'standard' }, { cwd: P }), null);
});
test('F1 webSearchProblem is pure and never throws on odd input', () => {
  assert.equal(webSearchProblem({ query: 'what is 4f6e65.4f7468.6572.example.com' }), 'outbound');
  assert.equal(webSearchProblem({ query: 'how do I use docs.python.org' }), null);
});

// ---------------------------------------------------------------- the store (F3, F4, F5)
describe('round 10 store', () => {
  const PROJECT = 'round10-project';
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
  const id = () => 'toolu_r10_' + (n += 1);
  const line = (convId, name, input, { parent = null, toolUseId = id() } = {}) => {
    observeStreamLine(convId, { type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
    return toolUseId;
  };
  const dispatch = (convId, extra, opts) => line(convId, 'Agent', { description: 'd', prompt: 'p', subagent_type: 'general-purpose', ...extra }, opts);
  const allowed = (r) => Boolean(r.decision && r.decision.behavior === 'allow');
  const codeOf = (r) => { const c = listPendingPermissions().find((p) => p.id === r.id); return c ? c.gate.code : null; };
  const waits = (r, code) => {
    assert.equal(r.decision, undefined, 'the card waits for the owner');
    if (code) assert.equal(codeOf(r), code);
  };

  // ---------------------------------------------------------------- F3: the age-only expiry is 30 days, not 24h
  describe('F3 the write-then-run marks do not expire by age at 24 hours', () => {
    const MARKS = path.join(BASE, 'marks10');
    const file = () => path.join(MARKS, 'code-marks.json');
    const restart = () => _resetPermissionStoreForTests();
    const writeLine = (convId, f) => line(convId, 'Write', { file_path: f, content: 'x' });
    beforeEach(() => {
      fs.rmSync(MARKS, { recursive: true, force: true });
      fs.mkdirSync(MARKS, { recursive: true });
      store._setCodeMarksDirForTests(MARKS);
      _resetPermissionStoreForTests();
    });
    const ageMark = (ms) => {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const v of Object.values(data.writes)) v.at = Date.now() - ms;
      fs.writeFileSync(file(), JSON.stringify(data));
    };
    test('F3 RED a 25-hour-old write mark still makes the runner wait', () => {
      writeLine(conversation(), path.join(P, 'src', 'n.js'));
      restart();
      ageMark(25 * 3600 * 1000);
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F3 RED a 10-day-old write mark still makes the runner wait', () => {
      writeLine(conversation(), path.join(P, 'src', 'n.js'));
      restart();
      ageMark(10 * 24 * 3600 * 1000);
      restart();
      waits(card(conversation(), 'npm test'), 'wrote_code');
    });
    test('F3 a write mark older than 30 days has expired (the safety floor)', () => {
      writeLine(conversation(), path.join(P, 'src', 'n.js'));
      restart();
      ageMark(31 * 24 * 3600 * 1000);
      restart();
      assert.equal(allowed(card(conversation(), 'npm test')), true);
    });
    test('F3 guard: an owner-approved runner still clears the mark regardless of age', () => {
      const c = conversation();
      writeLine(c, path.join(P, 'src', 'n.js'));
      const r = card(c, 'npm test');
      waits(r, 'wrote_code');
      answerPermission(r.id, 'allow');
      assert.equal(allowed(card(c, 'npm test')), true, 'the tests the owner approved are clear now');
    });
  });

  // ---------------------------------------------------------------- F4: a card cannot loosen an outside placement
  describe('F4 the first (stream) placement of a dispatch wins over a later card', () => {
    test('F4 RED the stream placed the Agent outside; a card for the same id claims inside; the child still waits', () => {
      const c = conversation();
      const agentId = dispatch(c, { cwd: '../outside' });
      ask(c, 'Agent', { description: 'd', prompt: 'p', cwd: 'src' }, agentId); // a card tries to loosen it to inside
      const tu = line(c, 'Bash', { command: 'cat a.js' }, { parent: agentId });
      waits(card(c, 'cat a.js', tu), 'outside_folder');
    });
    test('F4 RED the stream placed the Agent outside; a card without a cwd for the same id; the child still waits', () => {
      const c = conversation();
      const agentId = dispatch(c, { cwd: '../outside' });
      ask(c, 'Agent', { description: 'd', prompt: 'p' }, agentId); // no cwd -> would be the run folder (inside)
      const tu = line(c, 'Bash', { command: 'cat a.js' }, { parent: agentId });
      waits(card(c, 'cat a.js', tu), 'outside_folder');
    });
    test('F4 guard: a card may still TIGHTEN an inside placement to outside', () => {
      const c = conversation();
      const agentId = dispatch(c, { cwd: 'src' });
      ask(c, 'Agent', { description: 'd', prompt: 'p', cwd: '../outside' }, agentId);
      const tu = line(c, 'Bash', { command: 'cat a.js' }, { parent: agentId });
      waits(card(c, 'cat a.js', tu), 'outside_folder');
    });
    test('F4 guard: two stream dispatches with one id keep last-wins (outside then inside -> inside)', () => {
      const c = conversation();
      dispatch(c, { cwd: '../outside' }, { toolUseId: 'toolu_reuse10' });
      dispatch(c, { cwd: 'src' }, { toolUseId: 'toolu_reuse10' });
      const tu = line(c, 'Bash', { command: 'cat a.js' }, { parent: 'toolu_reuse10' });
      assert.equal(allowed(card(c, 'cat a.js', tu)), true);
    });
    test('F4 guard: an ordinary inside subagent and the main agent stay routine', () => {
      const c = conversation();
      const agentId = dispatch(c, { cwd: 'src' });
      const sub = line(c, 'Bash', { command: 'cat a.js' }, { parent: agentId });
      assert.equal(allowed(card(c, 'cat a.js', sub)), true);
      const main = line(c, 'Bash', { command: 'cat src/a.js' });
      assert.equal(allowed(card(c, 'cat src/a.js', main)), true);
    });
  });

  // ---------------------------------------------------------------- F5: an unplaced card while a dispatch is in flight
  describe('F5 an unplaced card waits while an Agent/Task dispatch is pending', () => {
    test('F5 a child card with an id the stream has not placed waits while an Agent dispatch card is pending', () => {
      const c = conversation();
      const d = ask(c, 'Agent', { description: 'd', prompt: 'p', cwd: '../outside' }, 'toolu_disp10');
      assert.equal(d.decision, undefined, 'the outside dispatch itself waits');
      waits(card(c, 'cat src/a.js', 'toolu_child_unseen10'), 'outside_folder');
    });
    test('F5 a card with no id at all waits while an Agent dispatch is pending', () => {
      const c = conversation();
      ask(c, 'Agent', { description: 'd', prompt: 'p', cwd: '../outside' }, 'toolu_disp10b');
      waits(card(c, 'cat src/a.js'), 'outside_folder');
    });
    test('F5 guard: with no dispatch at all an unplaced card is judged in the run folder', () => {
      assert.equal(allowed(card(conversation(), 'cat src/a.js', 'toolu_lonely10')), true);
    });
    test('F5 guard: a pending non-dispatch card does not make an unplaced card wait', () => {
      const c = conversation();
      ask(c, 'Bash', { command: 'git push' }, 'toolu_push10'); // a hard-gate card that waits, but not a dispatch
      assert.equal(allowed(card(c, 'cat src/a.js', 'toolu_child_ok10')), true);
    });
  });
});

after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
