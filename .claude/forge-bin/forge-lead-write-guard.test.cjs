#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-lead-write-guard.test.cjs — the lead-write guard (R8B-F2) that forge-toolhook.cjs calls after a
 * Write/Edit/MultiEdit/NotebookEdit. Throwaway roots only (os.tmpdir()), hermetic owner settings (FORGE_CONFIG_HOME in
 * a temp home, FORGE_PROJECT_ROOT cleared).
 *
 * The round 8b fixture is embedded (it ships into other projects, which do not have the evidence folder): the android
 * Lead (session 0edf26d1-...) logged run_started, one check_passed and run_completed 'partial' — no owner_prefs_loaded,
 * no memory_loaded, no work package — and then wrote the app itself with agent_id null on every Write.
 * The /forge session marker is written straight from the shared contract: <runs>/_hooks/forge-session/<sha16>.json,
 * sha16 = the first 16 hex chars of sha256(session_id).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lwg-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

const guard = require('./forge-lead-write-guard.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}

const ANDROID_SESSION = '0edf26d1-4625-431b-b25e-e425b3f9aa07';
const ANDROID_RUN = 'forge-2026-11-08-android-stackr';
// The three events of the real round 8b android run (hash-chain fields left out; the guard never reads them).
const ANDROID_EVENTS = [
  { run_id: ANDROID_RUN, event_type: 'run_started', goal: 'Android game Stackr', timestamp: '2026-11-08T03:44:51.000Z' },
  { run_id: ANDROID_RUN, event_type: 'check_passed', command: 'node build.cjs', exit_code: 0, evidence: 'apk built', timestamp: '2026-11-08T03:47:30.000Z' },
  { run_id: ANDROID_RUN, event_type: 'run_completed', status: 'partial', note: '9 red rules', timestamp: '2026-11-08T03:48:10.000Z' },
];

const roots = [];
function tmpRoot(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lwg-' + label + '-'));
  fs.mkdirSync(path.join(d, '.claude', 'forge-runs'), { recursive: true });
  roots.push(d);
  return d;
}
const runsDir = (root) => path.join(root, '.claude', 'forge-runs');
function sha16(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16); }
function writeMarker(root, sid, over) {
  const dir = path.join(runsDir(root), '_hooks', 'forge-session');
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.assign({ schema: 1, session_sha: sha16(sid), kind: 'forge-build', created_at: new Date().toISOString(), prompt_rid: null }, over || {});
  fs.writeFileSync(path.join(dir, sha16(sid) + '.json'), typeof over === 'string' ? over : JSON.stringify(body));
}
function setPointer(root, runId, session) {
  const dir = path.join(runsDir(root), '_hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-run.json'), JSON.stringify({ schema: 'forge-active-run/1', run: runId, session: session || null, set_at: new Date().toISOString() }));
}
function writeEvents(root, runId, events) {
  const dir = path.join(runsDir(root), runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function appendEvents(root, runId, events) {
  fs.appendFileSync(path.join(runsDir(root), runId, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const PREFS = { event_type: 'owner_prefs_loaded', summary: 'prefs echo' };
const MEMORY = { event_type: 'memory_loaded', note: 'memory read' };
function writeConfig(root, settings) {
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }, null, 2));
}
/** android(label) -> a root shaped like android-game-v9 after round 8b: marker, fallback pointer, the three events. */
function android(label) {
  const root = tmpRoot(label);
  writeMarker(root, ANDROID_SESSION);
  setPointer(root, ANDROID_RUN, null);
  writeEvents(root, ANDROID_RUN, ANDROID_EVENTS);
  return root;
}
/** leadWrite(root, rel, over) -> the PostToolUse payload of a main-thread (Lead) Write: no agent_id at all. */
function leadWrite(root, rel, over) {
  return Object.assign({
    session_id: ANDROID_SESSION, hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(root, rel), content: 'package com.forge.stackr;' },
    tool_response: { type: 'create', filePath: path.join(root, rel) }, tool_use_id: 'toolu_lead1', permission_mode: 'acceptEdits',
  }, over || {});
}
const ev = (payload, root, extra) => guard.evaluate(payload, Object.assign({ root }, extra || {}));

console.log('forge-lead-write-guard tests (R8B-F2: the Lead writes app files itself in a /forge build)');

console.log('\nA) the round 8b android fixture');
t('A1 android-v9 shape (no prefs, no memory): the Lead Write of AndroidManifest.xml is blocked (case a) with the forge-start step', () => {
  const root = android('a1');
  const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  assert.strictEqual(r.decision, 'blocked-a', JSON.stringify(r));
  assert.strictEqual(r.shown, true);
  assert.ok(r.feedback && r.feedback.decision === 'block', 'feedback must be a PostToolUse block object');
  assert.ok(r.feedback.reason.includes('node .claude/forge-bin/forge-start.cjs --text "'), r.feedback.reason);
  assert.ok(/owner_prefs_loaded/.test(r.feedback.reason) && /memory_loaded/.test(r.feedback.reason), 'the reason names what is missing');
  assert.ok(/\n- NL: /.test(r.feedback.reason) && /\n- EN: /.test(r.feedback.reason), 'NL + EN lines');
  assert.ok(/already written|staat er al/.test(r.feedback.reason), 'the reason says the write already happened');
});
t('A2 no active run for the session at all: also case a, the reason says there is no active run', () => {
  const root = tmpRoot('a2');
  writeMarker(root, ANDROID_SESSION);
  const r = ev(leadWrite(root, 'src/Main.java'), root);
  assert.strictEqual(r.decision, 'blocked-a');
  assert.ok(/no active run/.test(r.feedback.reason), r.feedback.reason);
});
t('A3 only one of the two start events (prefs without memory): still case a, naming memory_loaded only', () => {
  const root = android('a3');
  appendEvents(root, ANDROID_RUN, [PREFS]);
  const r = ev(leadWrite(root, 'build.cjs'), root);
  assert.strictEqual(r.decision, 'blocked-a');
  assert.ok(/memory_loaded/.test(r.feedback.reason) && !/no owner_prefs_loaded/.test(r.feedback.reason), r.feedback.reason);
});
t('A4 a start event only NAMED inside another event (a command, a note) does not count: still case a', () => {
  const root = android('a4');
  appendEvents(root, ANDROID_RUN, [
    { event_type: 'check_passed', command: 'grep owner_prefs_loaded events.jsonl', evidence: 'owner_prefs_loaded and memory_loaded are still missing' },
    { event_type: 'agent_note', agent: 'Lead', note: 'memory_loaded comes after the scan' },
  ]);
  const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  assert.strictEqual(r.decision, 'blocked-a', JSON.stringify(r));
  assert.ok(/no owner_prefs_loaded and no memory_loaded/.test(r.feedback.reason), r.feedback.reason);
});

console.log('\nB) started run without a work package');
t('B1 after owner_prefs_loaded + memory_loaded but no agent_work_package_created: blocked (case b), router wording', () => {
  const root = android('b1');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY]);
  const r = ev(leadWrite(root, 'src/com/forge/stackr/GameView.java'), root);
  assert.strictEqual(r.decision, 'blocked-b', JSON.stringify(r));
  assert.strictEqual(r.shown, true);
  const why = r.feedback.reason;
  assert.ok(/router/.test(why) && /agent_work_package_created/.test(why), why);
  assert.ok(/build-boss/.test(why) && /ui-boss/.test(why), 'names the Bosses to dispatch');
  assert.ok(/"internal"/.test(why) && /20/.test(why) && /2\)/.test(why), 'explains the Lead-internal work package rules');
});
t('B2 a dispatch work package (assigned to a Boss) lets Lead writes through: ok', () => {
  const root = android('b2');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY, { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1', owner: 'Build Boss', route: 'build' }]);
  const r = ev(leadWrite(root, 'src/Main.java'), root);
  assert.strictEqual(r.decision, 'ok');
  assert.strictEqual(r.feedback, null);
});
t('B3 Lead-internal WP with a 20+ char reason and 2 files: those 2 pass, a third file blocks (case b)', () => {
  const root = android('b3');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY, {
    event_type: 'agent_work_package_created', agent: 'Lead', runtime: 'internal', wp_id: 'L1',
    reason: 'one-line typo fix in the build script and its test', files: ['build.cjs', 'test/build.test.cjs'],
  }]);
  const a = ev(leadWrite(root, 'build.cjs', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'build.cjs'), old_string: 'a', new_string: 'b' } }), root);
  const b = ev(leadWrite(root, path.join('test', 'build.test.cjs')), root);
  const c = ev(leadWrite(root, 'src/Other.java'), root);
  assert.deepStrictEqual([a.decision, b.decision, c.decision], ['ok', 'ok', 'blocked-b']);
  assert.ok(/build\.cjs/.test(c.feedback.reason), 'the reason lists what the Lead work package covers: ' + c.feedback.reason);
});
t('B4 an invalid Lead WP (3 files, a short reason, no files, or no runtime internal) covers nothing and is no dispatch: case b with feedback', () => {
  const REASON = 'one-line typo fix in the build script and its test';
  const bad = [
    { agent: 'Lead', runtime: 'internal', reason: REASON, files: ['a.js', 'b.js', 'c.js'] },
    { agent: 'Lead', runtime: 'internal', reason: 'typo', files: ['a.js'] },
    { agent: 'Lead', runtime: 'internal', reason: REASON, files: [] },
    // a Lead/orchestrator WP WITHOUT runtime internal was counted as a dispatch, so every later Lead
    // write passed silently. The real shape of such an event (category-tests events.jsonl lines 130-131) comes first.
    { agent: 'Lead', wp_id: 'R8B-F2', title: 'lead-write guard inside forge-toolhook', route: 'deep', risk: 'high' },
    { agent: 'Lead', reason: REASON, files: ['a.js', 'b.js', 'c.js'] },
    { agent: 'orchestrator', wp_id: 'X' },
    { agent: 'Lead', reason: REASON, files: ['a.js'] },
  ];
  for (const [i, extra] of bad.entries()) {
    const root = android('b4-' + i);
    appendEvents(root, ANDROID_RUN, [PREFS, MEMORY, Object.assign({ event_type: 'agent_work_package_created' }, extra)]);
    const r = ev(leadWrite(root, 'a.js'), root);
    assert.strictEqual(r.decision, 'blocked-b', 'case ' + i + ': ' + JSON.stringify(r));
    assert.ok(r.shown === true && r.feedback && r.feedback.decision === 'block', 'case ' + i + ' must give feedback');
    assert.ok(/1 Lead work package\(s\) do not count/.test(r.feedback.reason), 'case ' + i + ' names the invalid Lead WP: ' + r.feedback.reason);
  }
});
t('B7 the assignee decides: a Lead WP handed off to a Boss is a dispatch; a WP with no assignee at all is not', () => {
  const handoff = android('b7-handoff');
  appendEvents(handoff, ANDROID_RUN, [PREFS, MEMORY, { event_type: 'agent_work_package_created', agent: 'Lead', wp_id: 'WP2', handoff: 'test-boss' }]);
  assert.strictEqual(ev(leadWrite(handoff, 'src/Main.java'), handoff).decision, 'ok');
  const boss = android('b7-boss');
  appendEvents(boss, ANDROID_RUN, [PREFS, MEMORY, { event_type: 'agent_work_package_created', agent: 'build-boss', wp_id: 'WP3' }]);
  assert.strictEqual(ev(leadWrite(boss, 'src/Main.java'), boss).decision, 'ok');
  const none = android('b7-none');
  appendEvents(none, ANDROID_RUN, [PREFS, MEMORY, { event_type: 'agent_work_package_created', wp_id: 'WP4', title: 'no assignee named' }]);
  assert.strictEqual(ev(leadWrite(none, 'src/Main.java'), none).decision, 'blocked-b');
});
t('B5 the Lead-internal file list matches an absolute path and a different letter case on Windows', () => {
  const root = android('b5');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY, {
    event_type: 'agent_work_package_created', agent: 'lead', runtime: 'internal',
    reason: 'one-line typo fix in the Gradle settings', files: [path.join(root, 'settings.gradle')],
  }]);
  assert.strictEqual(ev(leadWrite(root, 'settings.gradle'), root).decision, 'ok');
  if (process.platform === 'win32') assert.strictEqual(ev(leadWrite(root, 'SETTINGS.gradle'), root).decision, 'ok');
});
t('B6 a work package only NAMED in a note is not a work package: still case b', () => {
  const root = android('b6');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY, { event_type: 'agent_note', agent: 'Lead', note: 'agent_work_package_created for WP-1 comes next' }]);
  const r = ev(leadWrite(root, 'src/Main.java'), root);
  assert.strictEqual(r.decision, 'blocked-b', JSON.stringify(r));
});

console.log('\nC) who and where: never a block');
t('C1 a subagent payload (agent_id present) is never judged: skipped', () => {
  const root = android('c1');
  const r = ev(leadWrite(root, 'AndroidManifest.xml', { agent_id: 'a99237b506479d272', agent_type: 'ui-boss' }), root);
  assert.strictEqual(r.decision, 'skipped');
  assert.strictEqual(r.why, 'subagent');
  assert.strictEqual(r.feedback, null);
});
t('C2 targets under .claude/, .forge/, _scratch/ and the OS temp folder are skipped', () => {
  const root = android('c2');
  for (const rel of ['.claude/FORGE_MEMORY.md', '.forge/runs/x.json', '_scratch/probe.cjs']) {
    const r = ev(leadWrite(root, rel), root);
    assert.deepStrictEqual([r.decision, r.why], ['skipped', 'excluded-path'], rel);
  }
  const fakeTmp = path.join(root, 'faketmp');
  const r = ev(leadWrite(root, path.join('faketmp', 'scratch.txt')), root, { tmpDir: fakeTmp });
  assert.deepStrictEqual([r.decision, r.why], ['skipped', 'excluded-path'], 'a target in the OS temp folder');
});
t('C3 a target outside the project is skipped', () => {
  const root = android('c3');
  const other = tmpRoot('c3-other');
  const p = leadWrite(root, 'x');
  p.tool_input.file_path = path.join(other, 'notes.md');
  const r = ev(p, root);
  assert.deepStrictEqual([r.decision, r.why], ['skipped', 'outside-project']);
});
t('C4 no /forge session marker: skipped (not a /forge build session)', () => {
  const root = tmpRoot('c4');
  setPointer(root, ANDROID_RUN, null);
  writeEvents(root, ANDROID_RUN, ANDROID_EVENTS);
  const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  assert.deepStrictEqual([r.decision, r.why], ['skipped', 'no-marker']);
});
t('C5 an unparsable marker, a marker of another kind, or one naming another session: skipped (fail open)', () => {
  for (const [i, over] of ['{ not json', { kind: 'chat' }, { session_sha: '0000000000000000' }].entries()) {
    const root = android('c5-' + i);
    writeMarker(root, ANDROID_SESSION, over);
    const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
    assert.deepStrictEqual([r.decision, r.why], ['skipped', 'no-marker'], 'case ' + i);
  }
});
t('C6 a marker for ANOTHER session does not apply to this session', () => {
  const root = android('c6');
  const p = leadWrite(root, 'AndroidManifest.xml', { session_id: '11111111-2222-4333-8444-555555555555' });
  assert.strictEqual(ev(p, root).why, 'no-marker');
});
t('C7 only Write/Edit/MultiEdit/NotebookEdit are judged; NotebookEdit reads notebook_path', () => {
  const root = android('c7');
  assert.strictEqual(ev(leadWrite(root, 'x', { tool_name: 'Bash', tool_input: { command: 'echo hi > a.txt' } }), root).why, 'not-a-write');
  assert.strictEqual(ev(leadWrite(root, 'x', { tool_name: 'Read' }), root).why, 'not-a-write');
  const nb = ev(leadWrite(root, 'x', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(root, 'nb.ipynb'), new_source: 'x' } }), root);
  assert.strictEqual(nb.decision, 'blocked-a');
});
t('C8 a marker saved with a UTF-8 byte order mark (a Windows editor adds one) is still read', () => {
  const root = android('c8');
  const file = path.join(runsDir(root), '_hooks', 'forge-session', sha16(ANDROID_SESSION) + '.json');
  fs.writeFileSync(file, String.fromCharCode(0xFEFF) + fs.readFileSync(file, 'utf8'));
  assert.strictEqual(ev(leadWrite(root, 'AndroidManifest.xml'), root).decision, 'blocked-a');
});

console.log('\nD) once per case per session, settings, damaged input');
t('D1 the second offence of the same case in one session is recorded only (no feedback); the other case is still shown once', () => {
  const root = android('d1');
  const first = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  const second = ev(leadWrite(root, 'res/values/styles.xml'), root);
  assert.deepStrictEqual([first.decision, first.shown, second.decision, second.shown], ['blocked-a', true, 'blocked-a', false]);
  assert.strictEqual(second.feedback, null);
  assert.strictEqual(second.why, 'repeat');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY]);
  const b1 = ev(leadWrite(root, 'src/Rules.java'), root);
  const b2 = ev(leadWrite(root, 'src/Sfx.java'), root);
  assert.deepStrictEqual([b1.decision, b1.shown, b2.decision, b2.shown], ['blocked-b', true, 'blocked-b', false]);
  const other = ev(leadWrite(root, 'src/Rules.java', { session_id: 'ffffffff-2222-4333-8444-555555555555' }), root);
  assert.strictEqual(other.why, 'no-marker', 'the once-state is per session, the marker too');
});
t('D2 config lead-write-guard off -> no block (decision off); on/absent -> the guard works', () => {
  const root = android('d2');
  writeConfig(root, { 'lead-write-guard': { value: false } });
  const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  assert.deepStrictEqual([r.decision, r.feedback], ['off', null]);
  writeConfig(root, { 'lead-write-guard': { value: true } });
  assert.strictEqual(ev(leadWrite(root, 'AndroidManifest.xml'), root).decision, 'blocked-a');
});
t('D3 unreadable events (events.jsonl is a folder, or missing) -> no block', () => {
  const root = android('d3');
  const ef = path.join(runsDir(root), ANDROID_RUN, 'events.jsonl');
  fs.rmSync(ef);
  const missing = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  fs.mkdirSync(ef);
  const folder = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  for (const r of [missing, folder]) assert.deepStrictEqual([r.decision, r.why, r.feedback], ['skipped', 'events-unreadable', null]);
});
t('D4 a state file that cannot be written -> recorded, never shown (the guard does not block on its own error)', () => {
  const root = android('d4');
  fs.mkdirSync(path.join(runsDir(root), '_hooks'), { recursive: true });
  fs.writeFileSync(path.join(runsDir(root), '_hooks', 'lead-write-guard'), 'a file where the state folder should be');
  const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
  assert.deepStrictEqual([r.decision, r.shown, r.feedback, r.why], ['blocked-a', false, null, 'state-unwritable']);
});
t('D5 garbage never throws: null, a string, an array, odd tool_input, no session id', () => {
  const root = android('d5');
  for (const p of [null, 'x', [], { tool_name: 'Write' }, { tool_name: 'Write', session_id: ANDROID_SESSION, tool_input: 'x' },
    { tool_name: 'Write', session_id: ANDROID_SESSION, tool_input: { file_path: 42 } }, leadWrite(root, 'a.js', { session_id: '' })]) {
    const r = ev(p, root);
    assert.ok(r && r.decision === 'skipped' && r.feedback === null, JSON.stringify(p) + ' -> ' + JSON.stringify(r));
  }
  assert.strictEqual(guard.evaluate(leadWrite(root, 'a.js'), { root: 42 }).decision, 'skipped');
});
t('D6 the reason stays within one hook message (under 2000 chars) and names the file project-relative with /', () => {
  const root = android('d6');
  const r = ev(leadWrite(root, path.join('src', 'com', 'forge', 'stackr', 'MainActivity.java')), root);
  assert.ok(r.feedback.reason.length < 2000, String(r.feedback.reason.length));
  assert.ok(r.feedback.reason.includes('src/com/forge/stackr/MainActivity.java'), r.feedback.reason);
  assert.ok(!r.feedback.reason.includes(root), 'no absolute project path in the reason');
});
t('D7 the state file holds no paths or prompts: only schema, session sha and the shown times', () => {
  const root = android('d7');
  ev(leadWrite(root, 'AndroidManifest.xml'), root);
  const sf = path.join(runsDir(root), '_hooks', 'lead-write-guard', sha16(ANDROID_SESSION) + '.json');
  const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  assert.deepStrictEqual(Object.keys(st).sort(), ['schema', 'session_sha', 'shown']);
  assert.strictEqual(st.session_sha, sha16(ANDROID_SESSION));
  assert.ok(typeof st.shown.a === 'string' && st.shown.b === null, JSON.stringify(st));
});
t('D8 the run pointer module is missing, incomplete or throws -> skipped, never case a (no block on the guard\'s own error)', () => {
  const root = android('d8');
  for (const mod of [null, {}, { readActiveRun() { throw new Error('boom'); } }, { readActiveRun: () => 'not an object' }]) {
    const r = ev(leadWrite(root, 'AndroidManifest.xml'), root, { activeRunModule: mod });
    assert.deepStrictEqual([r.decision, r.why, r.feedback], ['skipped', 'run-pointer-unavailable', null], JSON.stringify(r));
  }
  assert.strictEqual(ev(leadWrite(root, 'AndroidManifest.xml'), root).decision, 'blocked-a', 'the real module still finds the run');
});
t('D9 a run pointer that is there but unreadable (not JSON, another schema, a folder) -> skipped; no pointer at all stays case a', () => {
  for (const [label, body] of [['json', '{ not json'], ['schema', JSON.stringify({ schema: 'other/1', run: ANDROID_RUN })], ['folder', null]]) {
    const root = tmpRoot('d9-' + label);
    writeMarker(root, ANDROID_SESSION);
    writeEvents(root, ANDROID_RUN, ANDROID_EVENTS);
    const pointer = path.join(runsDir(root), '_hooks', 'active-run.json');
    if (body === null) fs.mkdirSync(pointer); else fs.writeFileSync(pointer, body);
    const r = ev(leadWrite(root, 'AndroidManifest.xml'), root);
    assert.deepStrictEqual([r.decision, r.why, r.feedback], ['skipped', 'run-pointer-unreadable', null], label + ': ' + JSON.stringify(r));
  }
  const none = tmpRoot('d9-none');
  writeMarker(none, ANDROID_SESSION);
  assert.strictEqual(ev(leadWrite(none, 'AndroidManifest.xml'), none).decision, 'blocked-a', 'no pointer file = no run started');
});

console.log('\nE) folders come from forge-paths');
t('E1 plugin layout (.forge/ exists): marker, pointer and events are read under .forge/runs, a legacy-only marker does not count', () => {
  const root = tmpRoot('e1');
  const runs = path.join(root, '.forge', 'runs');
  const sha = sha16(ANDROID_SESSION);
  fs.mkdirSync(path.join(runs, '_hooks', 'forge-session'), { recursive: true });
  fs.mkdirSync(path.join(runsDir(root), '_hooks', 'forge-session'), { recursive: true });
  const body = JSON.stringify({ schema: 1, session_sha: sha, kind: 'forge-build', created_at: new Date().toISOString(), prompt_rid: null });
  fs.writeFileSync(path.join(runsDir(root), '_hooks', 'forge-session', sha + '.json'), body);
  assert.strictEqual(ev(leadWrite(root, 'app.js'), root).why, 'no-marker', 'the legacy folder is not the active one here');
  fs.writeFileSync(path.join(runs, '_hooks', 'forge-session', sha + '.json'), body);
  fs.writeFileSync(path.join(runs, '_hooks', 'active-run.json'), JSON.stringify({ schema: 'forge-active-run/1', run: ANDROID_RUN, session: null, set_at: new Date().toISOString() }));
  fs.mkdirSync(path.join(runs, ANDROID_RUN), { recursive: true });
  fs.writeFileSync(path.join(runs, ANDROID_RUN, 'events.jsonl'), ANDROID_EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = ev(leadWrite(root, 'app.js'), root);
  assert.deepStrictEqual([r.decision, r.run], ['blocked-a', ANDROID_RUN]);
  assert.ok(fs.existsSync(path.join(runs, '_hooks', 'lead-write-guard', sha + '.json')), 'the once-state lives in the active runs folder');
});

console.log('\nG) the case b advice works with the real event writer');
function g1Setup(label) {
  const root = tmpRoot(label);
  const claude = path.join(root, '.claude');
  fs.mkdirSync(path.join(claude, 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'config', 'agents'), { recursive: true });
  const writer = path.join(claude, 'forge-dashboard', 'log-event.cjs');
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), writer);
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(claude, 'config', 'agents', 'agent-registry.json'));
  const env = Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' });
  for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_RUN_ID', 'FORGE_STATE_DIR']) delete env[k];
  const log = (type, obj) => spawnSync(process.execPath, [writer, ANDROID_RUN, type, JSON.stringify(obj)], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  for (const [type, obj] of [['run_started', { goal: 'Android game Stackr', agent: 'orchestrator', runtime: 'internal' }],
    ['owner_prefs_loaded', { summary: 'prefs echo', agent: 'orchestrator', runtime: 'internal' }],
    ['memory_loaded', { note: 'memory read', agent: 'orchestrator', runtime: 'internal' }]]) {
    const r = log(type, obj);
    assert.strictEqual(r.status, 0, type + ' refused: ' + r.stderr);
  }
  writeMarker(root, ANDROID_SESSION);
  setPointer(root, ANDROID_RUN, null);
  return { root, env };
}
// FB-GUARDS-1-F16: the printed Example line, run verbatim in Git Bash AND in Windows PowerShell 5.1, writes the work
// package (the old single-quoted JSON argument lost its inner quotes in PowerShell 5.1).
for (const [shell, cmd] of [['bash', (line) => ['bash', ['-c', line]]], ['powershell', (line) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], line + '\n']]]) {
  t('G2 the Example line runs verbatim in ' + shell + ' and makes exactly that file pass', () => {
    const probe = spawnSync(cmd('exit 0')[0], shell === 'bash' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000 });
    if (probe.error || probe.status !== 0) { console.log('    (skipped: ' + shell + ' not available)'); return; }
    const { root, env } = g1Setup('g2-' + shell);
    const first = ev(leadWrite(root, 'src/Main.java'), root);
    assert.strictEqual(first.decision, 'blocked-b', JSON.stringify(first));
    const m = /\nExample: (.*)\n/.exec(first.feedback.reason);
    assert.ok(m, 'no Example line: ' + first.feedback.reason);
    const [exe, args, input] = cmd(m[1]);
    const r = spawnSync(exe, args, { cwd: root, env, input, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, shell + ' run of the example failed: ' + r.stdout + r.stderr);
    assert.strictEqual(ev(leadWrite(root, 'src/Main.java'), root).why, 'lead-internal-wp', shell + ': ' + r.stdout + r.stderr);
  });
}
t('G1 the Example line of case b, run through the real log-event.cjs (strict), makes exactly that file pass', () => {
  const root = tmpRoot('g1');
  const claude = path.join(root, '.claude');
  fs.mkdirSync(path.join(claude, 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'config', 'agents'), { recursive: true });
  const writer = path.join(claude, 'forge-dashboard', 'log-event.cjs');
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), writer);
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(claude, 'config', 'agents', 'agent-registry.json'));
  const env = Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' });
  for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_RUN_ID', 'FORGE_STATE_DIR']) delete env[k];
  const log = (type, obj) => spawnSync(process.execPath, [writer, ANDROID_RUN, type, JSON.stringify(obj)], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  for (const [type, obj] of [['run_started', { goal: 'Android game Stackr', agent: 'orchestrator', runtime: 'internal' }],
    ['owner_prefs_loaded', { summary: 'prefs echo', agent: 'orchestrator', runtime: 'internal' }],
    ['memory_loaded', { note: 'memory read', agent: 'orchestrator', runtime: 'internal' }]]) {
    const r = log(type, obj);
    assert.strictEqual(r.status, 0, type + ' refused: ' + r.stderr);
  }
  writeMarker(root, ANDROID_SESSION);
  setPointer(root, ANDROID_RUN, null);
  const first = ev(leadWrite(root, 'src/Main.java'), root);
  assert.strictEqual(first.decision, 'blocked-b', JSON.stringify(first));
  const m = /\nExample: echo '(.*)' \| node \.claude\/forge-dashboard\/log-event\.cjs --batch (\S+)\n/.exec(first.feedback.reason);
  assert.ok(m && m[2] === ANDROID_RUN, 'the reason carries a runnable example: ' + first.feedback.reason);
  const wp = Object.assign(JSON.parse(m[1]), { reason: 'one-file fix: the main class needs its package line' });
  assert.strictEqual(wp.event_type, 'agent_work_package_created');
  delete wp.event_type;
  const r = log('agent_work_package_created', wp);
  assert.strictEqual(r.status, 0, 'the real writer refused the example: ' + r.stderr);
  assert.deepStrictEqual([ev(leadWrite(root, 'src/Main.java'), root).why, ev(leadWrite(root, 'src/Other.java'), root).decision], ['lead-internal-wp', 'blocked-b']);
});

console.log('\nR) replay of the real round 8b tool logs (android-game-v9, chinees-restaurant-site-v9; read 2026-11-08)');
// Every main-thread Write/Edit of the android Lead in log order (agent_id null on each line of its _toollog); the one
// subagent call in that log is a verify-boss PowerShell call (agent_id ab8be11a69d2e226a) between build.cjs and its Edit.
const ANDROID_LEAD_WRITES = [
  'Write AndroidManifest.xml', 'Write res/values/styles.xml', 'Write res/mipmap-anydpi-v26/ic_launcher.xml', 'Write res/drawable/ic_fg.xml',
  'Write src/com/forge/stackr/Rules.java', 'Write test/com/forge/stackr/RulesTest.java', 'Write src/com/forge/stackr/Sfx.java',
  'Write src/com/forge/stackr/MainActivity.java', 'Write src/com/forge/stackr/GameView.java', 'Write build.cjs',
  'Edit build.cjs', 'Write final-report-draft.md',
];
function toolCall(root, entry, over) {
  const [tool, rel] = entry.split(' ');
  const file = path.join(root, ...rel.split('/'));
  const input = tool === 'Edit' ? { file_path: file, old_string: 'a', new_string: 'b' } : { file_path: file, content: 'x' };
  return leadWrite(root, rel, Object.assign({ tool_name: tool, tool_input: input }, over || {}));
}
function replayAndroid(root) {
  const lead = [];
  let sub = null;
  for (const [i, entry] of ANDROID_LEAD_WRITES.entries()) {
    lead.push(ev(toolCall(root, entry), root));
    if (i === 9) sub = ev(leadWrite(root, 'x', { tool_name: 'PowerShell', tool_input: { command: 'node build.cjs' }, agent_id: 'ab8be11a69d2e226a', agent_type: 'verify-boss' }), root);
  }
  return { lead, sub };
}
t('R1 the android Lead sequence (10 Write + 1 Edit + the report draft) without a started run: blocked-a every time, shown ONCE', () => {
  const { lead, sub } = replayAndroid(android('r1'));
  assert.strictEqual(lead.length, 12);
  assert.deepStrictEqual([...new Set(lead.map((r) => r.decision))], ['blocked-a']);
  assert.deepStrictEqual(lead.map((r) => r.shown), [true].concat(Array(11).fill(false)));
  assert.strictEqual(lead.filter((r) => r.feedback).length, 1, 'exactly one feedback object for the whole sequence');
  assert.deepStrictEqual([sub.decision, sub.why], ['skipped', 'not-a-write']);
});
t('R2 the same sequence after forge-start (prefs + memory) but no work package: blocked-b, shown once; with a work package: all ok', () => {
  const root = android('r2');
  appendEvents(root, ANDROID_RUN, [PREFS, MEMORY]);
  const { lead } = replayAndroid(root);
  assert.deepStrictEqual([...new Set(lead.map((r) => r.decision))], ['blocked-b']);
  assert.strictEqual(lead.filter((r) => r.shown).length, 1);
  const ok = android('r2-wp');
  appendEvents(ok, ANDROID_RUN, [PREFS, MEMORY, { event_type: 'agent_work_package_created', agent: 'Lead', wp_id: 'WP-1', owner: 'build-boss', route: 'build' }]);
  assert.deepStrictEqual([...new Set(replayAndroid(ok).lead.map((r) => r.decision))], ['ok']);
});
t('R3 the restaurant run: 14 ui-boss writes (agent_id a99237b506479d272) are never judged; a Lead write there would be', () => {
  const sid = '0fa521d6-d441-4e7b-8199-a68bf1e01075';
  const run = 'forge-2026-11-08-034500';
  const root = tmpRoot('r3');
  writeMarker(root, sid);
  setPointer(root, run, null);
  writeEvents(root, run, [
    { run_id: run, event_type: 'run_started', request: 'Jade Paviljoen restaurant site', mode: 'build', project_type: 'website' },
    { run_id: run, event_type: 'agent_note', agent: 'UI Boss', role: 'site build', runtime: 'agent-tool', status: 'running' },
  ]);
  const writes = ['Write site/data.js', 'Edit site/data.js', 'Write site/index.html', 'Write site/styles.css', 'Edit site/styles.css',
    'Edit site/styles.css', 'Edit site/styles.css', 'Write site/app.js', 'Edit site/styles.css', 'Write site/_verify/verify.mjs',
    'Edit site/_verify/verify.mjs', 'Edit site/_verify/verify.mjs', 'Edit site/_verify/verify.mjs', 'Edit site/styles.css'];
  const res = writes.map((w) => ev(toolCall(root, w, { session_id: sid, agent_id: 'a99237b506479d272', agent_type: 'ui-boss' }), root));
  assert.strictEqual(res.length, 14);
  assert.ok(res.every((r) => r.decision === 'skipped' && r.why === 'subagent' && r.feedback === null), JSON.stringify(res[0]));
  assert.ok(!fs.existsSync(path.join(runsDir(root), '_hooks', 'lead-write-guard')), 'no once-state for subagent writes');
  assert.strictEqual(ev(toolCall(root, 'Write site/index.html', { session_id: sid }), root).decision, 'blocked-a', 'the same write by the Lead is judged');
});

for (const d of roots.concat([CONFIG_HOME])) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ } }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
