#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-complexity-floor.test.cjs — SD-T6 (default skills, logic audit improvement 3, finding HIGH-90).
 * resolveComplexity only measured dispatches and the Lead's own declaration, so a Lead that built everything itself
 * stayed L1 and skipped skill-delivered, run-shape-declared and end-self-review. Category tests: restaurant-v2 (the Lead
 * built the whole site, only verify-boss and review-boss dispatched) and android-v3 (the Lead built the game, one
 * verify-boss) both closed L1. requestFloor reads what the REQUEST asked for: 2+ deliverable types or lanes in
 * anticipate.json, 2+ work packages on the plan card, or the Lead writing app files with no build dispatch.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let F;
try { F = require('./forge-complexity-floor.cjs'); } catch (e) {
  console.error('  (forge-complexity-floor.cjs not loadable: ' + (e && e.code || e) + ')');
  F = { requestFloor: () => ({ level: 0, reasons: [] }), LEAD_ONLY_MIN_FILES: undefined };
}

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cx-floor-')));
let n = 0;
const runDir = (files) => {
  const d = path.join(TMP, 'r' + (++n));
  fs.mkdirSync(d, { recursive: true });
  for (const [name, obj] of Object.entries(files || {})) fs.writeFileSync(path.join(d, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  return d;
};
const ev = (type, extra) => Object.assign({ event_type: type, agent: 'orchestrator', timestamp: '2026-11-07T10:00:00.000Z' }, extra || {});
const changed = (file, agent) => ev('file_changed', { agent: agent || 'orchestrator', file });
const started = (agent) => ev('subagent_started', { agent, subagent_type: agent });

console.log('forge-complexity-floor tests (hermetic root=' + TMP + ')');

// restaurant-v2 shape: the Lead wrote the site, then a verifier and a reviewer
const RESTAURANT_V2 = [ev('run_started'), ev('memory_loaded'), ev('agent_work_package_created', { wp_id: 'WP-1' }),
  changed('index.html'), changed('styles/site.css'), changed('scripts/menu.js'), changed('serve.mjs'),
  started('verify-boss'), started('review-boss'), ev('run_completed')];
let r = F.requestFloor(RESTAURANT_V2, runDir());
t('lead-only build is L2: app-file writes with only review dispatches (restaurant-v2)', r.level === 2 && r.reasons.length >= 1 && /app file/i.test(r.reasons.join(' ')), JSON.stringify(r));

// android-v3 shape: 7 events, the Lead built the game, one verify-boss
const ANDROID_V3 = [ev('run_started'), changed('app/src/main/java/game/MainActivity.kt'), changed('app/src/main/res/layout/main.xml'),
  changed('app/build.gradle'), started('verify-boss'), ev('check_passed'), ev('run_completed')];
r = F.requestFloor(ANDROID_V3, runDir());
t('lead-only build is L2: the android-v3 shape', r.level === 2, JSON.stringify(r));

r = F.requestFloor([ev('run_started'), changed('index.html'), changed('a.css'), changed('b.js')], runDir());
t('lead-only build is L2: app-file writes and no dispatch at all', r.level === 2, JSON.stringify(r));

r = F.requestFloor([ev('run_started'), changed('index.html'), changed('a.css'), changed('b.js'), started('build-boss')], runDir());
t('a build dispatch did the work: the lead-only signal does not fire', r.level === 1, JSON.stringify(r));

// FB-CONTRACT-2-F2: a GOAT triage, scribe or docs dispatch is not a builder.
const LEAD4 = [ev('run_started'), changed('index.html'), changed('a.css'), changed('b.js'), changed('c.js')];
r = F.requestFloor(LEAD4.concat([started('Head Chef')]), runDir());
t('a Head Chef triage dispatch is not a builder: the lead-only floor still fires', r.level === 2, JSON.stringify(r));
r = F.requestFloor(LEAD4.concat([started('Scribe')]), runDir());
t('a Scribe dispatch is not a builder', r.level === 2, JSON.stringify(r));
r = F.requestFloor(LEAD4.concat([started('docs-boss')]), runDir());
t('a Docs Boss dispatch is not a builder', r.level === 2, JSON.stringify(r));
r = F.requestFloor(LEAD4.concat([ev('subagent_started', { agent: 'Build Boss · part A' })]), runDir());
t('a Build Boss display name with a part label is a builder', r.level === 1, JSON.stringify(r));
r = F.requestFloor(LEAD4.concat([ev('subagent_started', { agent: 'lane-1', route: 'build' })]), runDir());
t('a dispatch on the build route is a builder', r.level === 1, JSON.stringify(r));
// Rework (Verify Boss FAIL): log-event records the registry display name; multi-word writers and the Roblox writers count.
for (const name of ['Data Scientist', 'Electron Pro', 'ML Engineer', 'MCP Developer', 'Payment Integration',
  'Roblox Luau Engineer', 'rbx-luau-engineer', 'Roblox World Builder', 'Roblox VFX and Audio', 'rbx-ui-engineer']) {
  r = F.requestFloor(LEAD4.concat([started(name)]), runDir());
  t('a "' + name + '" dispatch is a builder', r.level === 1, JSON.stringify(r));
}
for (const name of ['Roblox QA Tester', 'Roblox Skill Monitor', 'rbx-verifier']) {
  r = F.requestFloor(LEAD4.concat([started(name)]), runDir());
  t('a "' + name + '" dispatch is not a builder', r.level === 2, JSON.stringify(r));
}

r = F.requestFloor([ev('run_started'), changed('.claude/forge-runs/r1/final-report.md'), changed('.claude/FORGE_MEMORY.md'), changed('C:\\proj\\.claude\\FORGE_TASK_HISTORY.md')], runDir());
t('writes inside .claude/ are not app files', r.level === 1, JSON.stringify(r));

r = F.requestFloor([ev('run_started'), ev('file_changed', { files: ['index.html', 'a.css', 'b.js'] })], runDir());
t('one event naming three files counts three files (files list)', r.level === 2, JSON.stringify(r));

r = F.requestFloor([ev('run_started'), changed('index.html'), changed('./index.html'), changed('index.html')], runDir());
t('the same file written three times is one file', r.level === 1, JSON.stringify(r));

// declared request shape
r = F.requestFloor([ev('run_started')], runDir({ 'anticipate.json': { status: 'applied', deliverable_types: ['web-ui', 'docs'], input: { lanes: 1 } } }));
t('two deliverables is L2 (anticipate.json deliverable_types)', r.level === 2 && /deliverable/i.test(r.reasons.join(' ')), JSON.stringify(r));
r = F.requestFloor([ev('run_started')], runDir({ 'anticipate.json': { status: 'applied', deliverable_types: ['web-ui'], input: { lanes: 3 } } }));
t('2+ lanes in anticipate.json is L2', r.level === 2 && /lane/i.test(r.reasons.join(' ')), JSON.stringify(r));
r = F.requestFloor([ev('run_started')], runDir({ 'anticipate.json': { status: 'reverted', deliverable_types: ['web-ui', 'docs'], input: { lanes: 4 } } }));
t('a reverted anticipate.json does not count', r.level === 1, JSON.stringify(r));
r = F.requestFloor([ev('run_started')], runDir({ 'plan-card.json': { packages: 3, lanes: { expected: 1 } } }));
t('a plan card with 3 work packages is L2', r.level === 2 && /package/i.test(r.reasons.join(' ')), JSON.stringify(r));
r = F.requestFloor([ev('run_started')], runDir({ 'plan-card.json': { packages: [{ id: 'a' }, { id: 'b' }] } }));
t('a plan card whose packages is a list of 2 is L2', r.level === 2, JSON.stringify(r));

// small fix
r = F.requestFloor([ev('run_started'), changed('src/fix.js'), ev('run_completed')], runDir());
t('small fix stays L1: one file and no plan', r.level === 1 && r.reasons.length === 0, JSON.stringify(r));
r = F.requestFloor([ev('run_started')], runDir({ 'anticipate.json': '{not json', 'plan-card.json': { packages: 1 } }));
t('a damaged anticipate.json and a one-package card stay L1', r.level === 1, JSON.stringify(r));

// totality
r = F.requestFloor(null, null);
t('total: null events and no run dir give L1, no throw', r.level === 1 && Array.isArray(r.reasons));
r = F.requestFloor('junk', path.join(TMP, 'no-such-dir'));
t('total: junk events and a missing dir give L1', r.level === 1);
t('LEAD_ONLY_MIN_FILES is 3 (quick route = 1-2 files)', F.LEAD_ONLY_MIN_FILES === 3, String(F.LEAD_ONLY_MIN_FILES));

// R8B-F4 (round 8b): the Lead's own app-file writes from the harness tool log (<runs>/_toollog/<session>[.N].jsonl).
// android-v9 (Sonnet Lead) logged 3 events, no file_changed and no dispatch, and
// wrote 11 app files itself; its contract derived L1. The rows below are copied from that run's real _toollog.
const V9_RUN = 'forge-2026-11-08-android-stackr';
const V9_SESSION = '0edf26d1-4625-431b-b25e-e425b3f9aa07';
const V9_EVENTS = [
  { run_id: V9_RUN, event_type: 'run_started', goal: 'Android tap game APK (Stackr)', timestamp: '2026-11-08T03:44:55.627Z' },
  { run_id: V9_RUN, event_type: 'check_passed', command: 'node build.cjs', exit_code: 0, timestamp: '2026-11-08T03:47:49.241Z' },
  { run_id: V9_RUN, event_type: 'run_completed', status: 'partial', timestamp: '2026-11-08T03:48:06.083Z' }];
// [time on 2026-11-08 (UTC), agent_id, tool, target_kind, target, ok]
const V9_ROWS = [
  ['03:42:48.241', null, 'PowerShell', 'command', 'Get-ChildItem', true], ['03:43:08.163', null, 'Bash', 'command', 'java', false],
  ['03:43:09.696', null, 'Bash', 'command', 'node', true], ['03:44:56.098', null, 'Bash', 'command', 'node', true],
  ['03:45:00.924', null, 'Write', 'path', 'AndroidManifest.xml', true], ['03:45:02.587', null, 'Write', 'path', 'res\\values\\styles.xml', true],
  ['03:45:03.828', null, 'Write', 'path', 'res\\mipmap-anydpi-v26\\ic_launcher.xml', true], ['03:45:07.068', null, 'Write', 'path', 'res\\drawable\\ic_fg.xml', true],
  ['03:45:11.447', null, 'Write', 'path', 'src\\com\\forge\\stackr\\Rules.java', true], ['03:45:15.977', null, 'Write', 'path', 'test\\com\\forge\\stackr\\RulesTest.java', true],
  ['03:45:23.856', null, 'Write', 'path', 'src\\com\\forge\\stackr\\Sfx.java', true], ['03:45:27.306', null, 'Write', 'path', 'src\\com\\forge\\stackr\\MainActivity.java', true],
  ['03:46:06.256', null, 'Write', 'path', 'src\\com\\forge\\stackr\\GameView.java', true], ['03:46:14.653', null, 'Write', 'path', 'build.cjs', true],
  ['03:46:22.143', null, 'Bash', 'command', 'node', true], ['03:46:42.618', 'ab8be11a69d2e226a', 'PowerShell', 'command', 'node', true],
  ['03:47:20.314', null, 'Edit', 'path', 'build.cjs', true], ['03:47:26.580', null, 'Bash', 'command', 'node', true],
  ['03:47:31.979', null, 'Bash', 'command', 'node', false], ['03:47:37.573', null, 'Bash', 'command', 'node', false],
  ['03:47:39.460', null, 'Bash', 'command', 'node', false], ['03:47:44.832', null, 'Write', 'path', 'final-report-draft.md', true],
  ['03:47:49.786', null, 'Bash', 'command', 'node', true], ['03:47:51.662', null, 'Bash', 'command', 'node', false],
  ['03:47:55.625', null, 'Bash', 'command', 'node', false], ['03:47:59.214', null, 'Bash', 'command', 'node', false],
  ['03:48:02.444', null, 'Bash', 'command', 'node', true], ['03:48:06.623', null, 'Bash', 'command', 'node', true]];
const v9Rec = ([at, agent, tool, kind, target, ok]) => ({ ts: '2026-11-08T' + at + 'Z', session: V9_SESSION, agent_id: agent, agent_type: agent ? 'verify-boss' : null, tool, target, target_kind: kind, ok });
// Hand count: 10 distinct files by Write (build.cjs written then edited = 1) plus final-report-draft.md = 11.
const V9_FILES = ['androidmanifest.xml', 'build.cjs', 'final-report-draft.md', 'res/drawable/ic_fg.xml', 'res/mipmap-anydpi-v26/ic_launcher.xml',
  'res/values/styles.xml', 'src/com/forge/stackr/gameview.java', 'src/com/forge/stackr/mainactivity.java', 'src/com/forge/stackr/rules.java',
  'src/com/forge/stackr/sfx.java', 'test/com/forge/stackr/rulestest.java'];

/** A runs folder: <runs>/<run id>/ (returned) beside <runs>/_toollog/<name> for every entry of logs. */
let rn = 0;
const runWithLog = (logs, runId) => {
  const runs = path.join(TMP, 'runs' + (++rn));
  const rd = path.join(runs, runId || 'forge-2026-11-07-floor');
  fs.mkdirSync(rd, { recursive: true });
  fs.mkdirSync(path.join(runs, '_toollog'), { recursive: true });
  for (const [name, recs] of Object.entries(logs || {})) {
    fs.writeFileSync(path.join(runs, '_toollog', name), typeof recs === 'string' ? recs : recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  return rd;
};
const countOf = (res) => { const m = /(\d+) app files/.exec(res.reasons.join(' ')); return m ? Number(m[1]) : 0; };
const WIN = [ev('run_started', { timestamp: '2026-11-07T10:00:00.000Z' }), ev('run_completed', { timestamp: '2026-11-07T11:00:00.000Z' })];
const lw = (target, extra) => Object.assign({ ts: '2026-11-07T10:30:00.000Z', session: 's1', agent_id: null, agent_type: null, tool: 'Write', target, target_kind: 'path', ok: true }, extra || {});

let rd = runWithLog({ [V9_SESSION + '.jsonl']: V9_ROWS.map(v9Rec) }, V9_RUN);
r = F.requestFloor(V9_EVENTS, rd);
t('android-v9 replay: Lead writes in the tool log raise the floor to L2', r.level === 2 && /tool log/i.test(r.reasons.join(' ')), JSON.stringify(r));
t('android-v9 replay: the reason names 10 or more app files (11 by hand count)', countOf(r) >= 10 && countOf(r) === V9_FILES.length, JSON.stringify(r.reasons));
t('android-v9 replay: the counted files are exactly the 11 app files the Lead wrote',
  typeof F.toollogLeadWrites === 'function' && JSON.stringify(F.toollogLeadWrites(rd, V9_EVENTS)) === JSON.stringify(V9_FILES),
  typeof F.toollogLeadWrites === 'function' ? JSON.stringify(F.toollogLeadWrites(rd, V9_EVENTS)) : 'toollogLeadWrites not exported');
r = F.requestFloor(V9_EVENTS, runWithLog({}, V9_RUN));
t('android-v9 control: the same events without the tool log stay L1', r.level === 1, JSON.stringify(r));
r = F.requestFloor(V9_EVENTS.concat([ev('subagent_started', { agent: 'build-boss', subagent_type: 'build-boss', timestamp: '2026-11-08T03:45:30.000Z' })]), runWithLog({ [V9_SESSION + '.jsonl']: V9_ROWS.map(v9Rec) }, V9_RUN));
t('tool log: a logged build dispatch keeps the lead-only signal off', r.level === 1, JSON.stringify(r));

r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': [lw('index.html'), lw('a.css'), lw('.claude\\forge-runs\\x\\final-report.md'), lw('.forge\\runs\\x\\run.json'), lw('_scratch\\probe.cjs')] }));
t('tool log: writes under .claude/, .forge/ or _scratch/ are not app files (2 app files plus one in each stays L1)', r.level === 1, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': ['index.html', 'a.css', 'b.js', 'c.js'].map((f) => lw(f, { agent_id: 'a1b2c3', agent_type: 'build-boss' })) }));
t('tool log: writes with an agent_id (a subagent) do not count', r.level === 1, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.2.jsonl': [lw('a.js')], 's1.1.jsonl': [lw('b.js')], 's1.jsonl': [lw('c.js')] }));
t('tool log: rotated generations (.1.jsonl, .2.jsonl) are counted', r.level === 2 && countOf(r) === 3, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': [lw('a.js', { ts: '2026-11-07T09:59:59.000Z' }), lw('b.js'), lw('c.js'), lw('d.js', { ts: '2026-11-07T11:00:01.000Z' })] }));
t('tool log: a write before run_started and one after run_completed do not count (2 inside stays L1)', r.level === 1, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': ['a.js', 'b.js', 'c.js'].map((f) => lw(f, { run: 'forge-2026-11-07-other' })) }));
t('tool log: lines tagged with another run do not count', r.level === 1, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js'), lw('c.js', { ok: false }), lw('d.js', { tool: 'Read' }),
  lw('C:\\Users\\x\\AppData\\Local\\Temp\\s.js'), lw('/tmp/e.js'), lw('..\\other\\f.js'), lw('g.js', { target_kind: 'command' })] }));
t('tool log: a failed write, a Read, a path outside the project and a non-path target do not count', r.level === 1 && countOf(r) === 0, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': [lw('a.ipynb', { tool: 'NotebookEdit' }), lw('b.js', { tool: 'MultiEdit' }), lw('c.js', { tool: 'Edit' })] }));
t('tool log: Edit, MultiEdit and NotebookEdit count as writes', r.level === 2 && countOf(r) === 3, JSON.stringify(r));
// An open run (no run_completed) owns writes up to 6 h after its LAST event, as in forge-claim-reports (OPEN_SLACK_MS):
// an abandoned run must not claim every later write (the dev-tree survey had July runs claiming November writes).
const OPEN = [ev('run_started', { timestamp: '2026-11-07T10:00:00.000Z' }), ev('check_passed', { timestamp: '2026-11-07T12:00:00.000Z' })];
r = F.requestFloor(OPEN, runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js', { ts: '2026-11-07T13:00:00.000Z' }), lw('c.js', { ts: '2026-11-07T17:59:00.000Z' })] }));
t('tool log: an open run counts writes up to 6 h after its last event', r.level === 2 && countOf(r) === 3, JSON.stringify(r));
r = F.requestFloor(OPEN, runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js', { ts: '2026-11-07T17:00:00.000Z' }), lw('c.js', { ts: '2026-11-07T18:01:00.000Z' })] }));
t('tool log: an open run does not claim writes more than 6 h after its last event', r.level === 1, JSON.stringify(r));
r = F.requestFloor(WIN, runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js'), lw('c.js', { session: 'unknown-session' }), lw('d.js', { session: undefined })] }));
t('tool log: a line with no real session (missing or unknown-session, as synthetic test lines are) does not count', r.level === 1, JSON.stringify(r));
r = F.requestFloor([ev('check_passed')], runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js'), lw('c.js')] }));
t('tool log: no run_started means no window, so untagged writes do not count', r.level === 1, JSON.stringify(r));
r = F.requestFloor(WIN.concat([changed('C:\\proj\\a.js'), changed('C:\\proj\\b.js')]), runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js')] }));
t('tool log and file_changed events are not added together (no double count)', r.level === 1, JSON.stringify(r));
rd = runWithLog({ 's1.jsonl': [lw('a.js'), lw('b.js'), lw('c.js')] });
const old = new Date('2026-11-01T00:00:00.000Z');
fs.utimesSync(path.join(path.dirname(rd), '_toollog', 's1.jsonl'), old, old);
r = F.requestFloor(WIN, rd);
t('tool log: a file last written before run_started is not read (no line in it can be in the window)', r.level === 1, JSON.stringify(r));
rd = runWithLog({ 's1.jsonl': '{not json\n\n' + JSON.stringify(lw('a.js')) + '\n[1,2]\nnull\n' + JSON.stringify(lw(42)) + '\n' });
fs.mkdirSync(path.join(path.dirname(rd), '_toollog', 'dir.jsonl'));
let threw = null;
try { r = F.requestFloor(WIN, rd); } catch (e) { threw = e; }
t('tool log: junk lines, a non-string target and a folder named x.jsonl do not throw', !threw && r.level === 1, threw ? threw.stack : JSON.stringify(r));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
