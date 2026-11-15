#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-start.test.cjs — R8B-F1. Category round 8b: a Sonnet Lead skipped the /forge procedure (no plan, no
 * memory_loaded, no owner_prefs_loaded, a hand-typed run id, run_started without agent/runtime). forge-start.cjs does the
 * bootstrap in one call through the existing tools. Proven in TEMP copies of a fresh install (the dev tree's forge-bin,
 * forge-dashboard, config, agents, commands and skills; never a real project), each removed at the end:
 *   - after forge-start the preview contract no longer lists memory-read or owner-prefs-loaded (a control run with only
 *     run_started lists both), run_started carries agent + runtime, the id is forge-YYYY-MM-DD-HHMMSS, complexity is L2
 *     for 'Maak een Android spel', memory files are printed capped and logged with their real hashes;
 *   - L1 needs --reason; no --text or a bad level creates nothing (exit 1);
 *   - a failing sub-step (forge-echo stubbed to exit 1) logs nothing for that step and the rest still runs;
 *   - forge-device-env.cjs is spawned when present (a stub), a hint is printed when absent, and nothing for a non-device task.
 * Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 900) : '')); }
};
const section = (name, fn) => { try { fn(); } catch (e) { fail++; console.error('  FAIL ' + name + ' threw: ' + String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } };

const SRC = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-start-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const RUN_ID_RE = /^forge-\d{4}-\d{2}-\d{2}-\d{6}$/;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// one fresh-install template, copied per project (the device tool of the parallel part is left out on purpose)
const TPL = path.join(TMP, 'tpl');
const keep = (p) => !/[\\/]node_modules([\\/]|$)/.test(p) && !/\.test\.cjs$/.test(p) && !/[\\/]forge-device-env\.cjs$/.test(p);
for (const dir of ['forge-bin', 'forge-dashboard', 'config', 'agents', 'commands', 'skills']) {
  if (fs.existsSync(path.join(SRC, dir))) fs.cpSync(path.join(SRC, dir), path.join(TPL, '.claude', dir), { recursive: true, filter: keep });
}
function project(name) {
  const root = path.join(TMP, name);
  fs.cpSync(TPL, root, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  return root;
}
function envFor(root) {
  const e = Object.assign({}, process.env, { HOME, USERPROFILE: HOME, CLAUDE_SESSION_ID: '', FORGE_STRICT_EVENTS: '1' });
  for (const k of ['CLAUDE_PROJECT_DIR', 'FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'FORGE_AUTO_ACTIVE_RUN', 'FORGE_COMPLETION_GATE', 'FORGE_SCRIBE_HOOK']) delete e[k];
  e.CLAUDE_PROJECT_DIR = root;
  e.FORGE_GRAPHIFY = 'off'; // no real graphify build ever starts from these tests
  return e;
}
const run = (root, args) => spawnSync(process.execPath, [path.join(root, '.claude', 'forge-bin', 'forge-start.cjs'), ...args], { cwd: root, encoding: 'utf8', env: envFor(root), timeout: 240000 });
const out = (r) => String(r.stdout || '') + String(r.stderr || '');
const runsOf = (root) => fs.readdirSync(path.join(root, '.claude', 'forge-runs')).filter((d) => RUN_ID_RE.test(d) || /^forge-/.test(d));
const events = (root, id) => {
  const f = path.join(root, '.claude', 'forge-runs', id, 'events.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
function previewMissing(root, id) {
  const r = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs'), 'check', '--run', id, '--phase', 'preview', '--json', '--root', root], { cwd: root, encoding: 'utf8', env: envFor(root), timeout: 120000 });
  let j = null;
  try { j = JSON.parse(String(r.stdout).trim()); } catch { j = null; }
  return { j, raw: out(r) };
}
const runIdOf = (r) => ((/^RUN (forge-\S+)/m.exec(String(r.stdout || '')) || [])[1]) || null;

try {
  console.log('A) the bootstrap on a fresh install: one call, every preview precondition the Lead used to skip');
  section('A', () => {
    const root = project('p-main');
    const memLines = Array.from({ length: 130 }, (_, i) => 'memory line ' + (i + 1));
    fs.writeFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), memLines.join('\n') + '\n');
    fs.writeFileSync(path.join(root, '.claude', 'FORGE_PROJECT_PROFILE.md'), '# Project profile\nType: android game\n');
    // control: a run with only run_started lists both rules as missing, so the check below proves something
    const ctl = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), 'forge-2026-01-01-000001', 'run_started', '{"agent":"orchestrator","runtime":"internal"}'], { cwd: root, encoding: 'utf8', env: Object.assign(envFor(root), { FORGE_AUTO_ACTIVE_RUN: 'off' }) });
    const c = previewMissing(root, 'forge-2026-01-01-000001');
    t('A0 control: a run with only run_started misses memory-read and owner-prefs-loaded in the preview check',
      ctl.status === 0 && c.j && c.j.missing.includes('memory-read') && c.j.missing.includes('owner-prefs-loaded'), c.raw.slice(0, 400));

    const r = run(root, ['--text', 'Maak een Android spel']);
    const id = runIdOf(r);
    t('A1 exit 0 and the minted run id has the shape forge-YYYY-MM-DD-HHMMSS', r.status === 0 && RUN_ID_RE.test(String(id)), out(r).slice(0, 600));
    t('A1b FB-INSTALL-2-F7: right after run_started the run gets its config baseline, and step [1/8] says so',
      fs.existsSync(path.join(root, '.claude', 'forge-runs', String(id), 'config-baseline.json')) && /\[1\/8\][^\n]*config baseline written/.test(out(r)), out(r).slice(0, 600));
    const ev = events(root, id);
    const started = ev.find((e) => e.event_type === 'run_started');
    t('A2 run_started carries agent, runtime internal and complexity L2 (default for a build request)',
      !!started && typeof started.agent === 'string' && started.agent.trim() && started.runtime === 'internal' && started.complexity === 'L2' && started.complexity_source === 'default', JSON.stringify(started));
    const p = previewMissing(root, id);
    t('A3 the preview contract no longer lists memory-read or owner-prefs-loaded',
      p.j && Array.isArray(p.j.missing) && !p.j.missing.includes('memory-read') && !p.j.missing.includes('owner-prefs-loaded'), p.raw.slice(0, 600));
    t('A3b ... and the contract reads complexity L2 for this run', p.j && p.j.complexity === 'L2', p.j && JSON.stringify({ c: p.j.complexity, s: p.j.complexity_source }));
    const mem = ev.find((e) => e.event_type === 'memory_loaded');
    const fr = mem && Array.isArray(mem.files_read) ? mem.files_read : [];
    const memRec = fr.find((f) => f.path === '.claude/FORGE_MEMORY.md');
    const profRec = fr.find((f) => f.path === '.claude/FORGE_PROJECT_PROFILE.md');
    t('A4 memory_loaded lists only the files really read, with their real sha256; the absent ones are listed as absent',
      fr.length === 2 && memRec && memRec.sha256 === sha(fs.readFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'))) && profRec && profRec.sha256 === sha(fs.readFileSync(path.join(root, '.claude', 'FORGE_PROJECT_PROFILE.md')))
        && Array.isArray(mem.absent) && mem.absent.includes('.claude/FORGE_TASK_HISTORY.md') && mem.absent.includes('.claude/FORGE_AGENT_LEDGER.md'), JSON.stringify(mem));
    t('A4b project_scanned is logged too, with the same files', ev.some((e) => e.event_type === 'project_scanned' && Array.isArray(e.files_read) && e.files_read.length === 2));
    t('A5 owner_prefs_loaded is logged (through forge-echo)', ev.some((e) => e.event_type === 'owner_prefs_loaded'));
    t('A5b the councilTrigger decision is logged (through forge-quality analyze --log-run)', ev.some((e) => e.event_type === 'decision_logged' && /council/i.test(String(e.decision || ''))));
    t('A5c the anticipation overlay exists (through forge-anticipate apply)', fs.existsSync(path.join(root, '.claude', 'forge-runs', id, 'anticipate.json')));
    const so = String(r.stdout);
    t('A6 the memory is printed capped: line 120 shown, line 121 not, with the path for the rest',
      /memory line 120\b/.test(so) && !/memory line 121\b/.test(so) && /first 120 of 130 lines; the rest: \.claude\/FORGE_MEMORY\.md/.test(so), so.slice(0, 2000));
    t('A6b an absent memory file is printed as absent', /\.claude\/FORGE_TASK_HISTORY\.md: absent/.test(so));
    t('A7 the run pointer names the new run (forge-active-run)', (() => { try { return require(path.join(root, '.claude', 'forge-bin', 'forge-active-run.cjs')).readActiveRun(root, null).run === id; } catch { return false; } })());
    t('A8 a mobile/game task without forge-device-env.cjs gets a one-line device hint', /^\[7\/8\] device: .*forge-device-env\.cjs is not installed/m.test(so), so.split('\n').filter((l) => /device/.test(l)).join(' | '));
    const lastLine = so.trim().split('\n').pop();
    t('A9 the last line is NEXT: with the exact preview check command for this run', lastLine === 'NEXT: node .claude/forge-bin/forge-runcontract.cjs check --run ' + id + ' --phase preview --log-event', lastLine);
    t('A9b the contract plan is printed before it', so.includes('PLAN ' + id), so.slice(-1500));
    t('A10 no event the tool did not earn: no research_done, skill map, work package or dispatch',
      !ev.some((e) => ['research_done', 'skill_map_created', 'agent_work_package_created', 'subagent_started', 'agent_started', 'custom_subagent_created'].includes(e.event_type)), ev.map((e) => e.event_type).join(','));

    const l1 = run(root, ['--text', 'Fix the typo in the README title', '--complexity', 'L1', '--reason', 'one-word typo in one file', '--json']);
    let j = null;
    try { j = JSON.parse(String(l1.stdout).trim()); } catch { j = null; }
    const l1Start = j && events(root, j.run_id).find((e) => e.event_type === 'run_started');
    t('B1 --complexity L1 --reason: exit 0, --json output parses, run_started says L1 with the reason and source flag',
      l1.status === 0 && j && j.ok === true && RUN_ID_RE.test(j.run_id) && j.run_id !== id && l1Start && l1Start.complexity === 'L1' && l1Start.complexity_source === 'flag' && l1Start.complexity_reason === 'one-word typo in one file', out(l1).slice(0, 600));
    t('B1b ... the JSON names every step with ok and what it logged, and the NEXT command', j && Array.isArray(j.steps) && j.steps.length === 8 && j.steps.every((s) => typeof s.id === 'string' && typeof s.ok === 'boolean' && Array.isArray(s.logged)) && /--phase preview --log-event$/.test(String(j.next)), JSON.stringify(j && j.steps));
    t('B1c a task that is not mobile, game or desktop has no device step output', j && j.steps.find((s) => s.id === 'device') && j.steps.find((s) => s.id === 'device').note === 'not a mobile, game or desktop task', JSON.stringify(j && j.steps.find((s) => s.id === 'device')));
    const before = runsOf(root).length;
    const noReason = run(root, ['--text', 'Fix a typo', '--complexity', 'L1']);
    const noText = run(root, []);
    const badLevel = run(root, ['--text', 'Maak een site', '--complexity', 'L9']);
    t('B2 L1 without --reason, no --text and a bad level: exit 1 and no run folder created',
      noReason.status === 1 && noText.status === 1 && badLevel.status === 1 && runsOf(root).length === before && /--reason/.test(out(noReason)), [out(noReason), out(noText), out(badLevel)].join(' || ').slice(0, 600));
  });

  console.log('\nC) a failing sub-step logs nothing for that step; the rest still runs; the device tool is spawned when present');
  section('C', () => {
    const root = project('p-fail');
    fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'forge-echo.cjs'), "'use strict';\nconsole.error('stub: forge-echo is broken');\nprocess.exit(1);\n");
    // a stub in the shape of the real forge-device-env.cjs --json result (verdict, avds, devices, commands, notes)
    const DEV = { schema: 1, tool: 'forge-device-env', verdict: 'emulator-ready', avds: ['Pixel_7'], devices: [], notes: ['stub note'], waiver: null,
      commands: { shell: 'The commands are for Git Bash.', boot: '"emu" -avd Pixel_7', install: 'adb install -r <path/to/app.apk>', screenshot: 'adb exec-out screencap -p > .claude/forge-runs/<run_id>/artifacts/device-screenshot-1.png' } };
    fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'forge-device-env.cjs'), "'use strict';\nif (process.argv[2] !== '--json') process.exit(2);\nconsole.log(JSON.stringify(" + JSON.stringify(DEV) + ', null, 2));\n');
    const r = run(root, ['--text', 'Maak een Android spel', '--json']);
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim()); } catch { j = null; }
    const ev = j ? events(root, j.run_id) : [];
    const prefs = j && j.steps.find((s) => s.id === 'owner-prefs');
    t('C1 exit 0: the run was created although one step failed', r.status === 0 && j && j.ok === true, out(r).slice(0, 600));
    t('C2 the failed step says so and claims nothing: no owner_prefs_loaded event', prefs && prefs.ok === false && /forge-echo/.test(prefs.note) && !prefs.logged.includes('owner_prefs_loaded') && !ev.some((e) => e.event_type === 'owner_prefs_loaded'), JSON.stringify(prefs));
    t('C3 the later steps still ran: memory_loaded (fresh install: all four files absent) and the council decision', ev.some((e) => e.event_type === 'memory_loaded' && Array.isArray(e.absent) && e.absent.length === 4 && e.files_read.length === 0) && ev.some((e) => e.event_type === 'decision_logged'), ev.map((e) => e.event_type).join(','));
    const dev = j && j.steps.find((s) => s.id === 'device');
    t('C4 forge-device-env.cjs --json is spawned for a mobile/game task and its verdict is relayed', dev && dev.ok === true && dev.note === 'verdict emulator-ready · AVDs Pixel_7 · devices none attached', JSON.stringify(dev));
    const p = previewMissing(root, j && j.run_id);
    t('C5 the contract stays honest: owner-prefs-loaded is still missing, memory-read is met', p.j && p.j.missing.includes('owner-prefs-loaded') && !p.j.missing.includes('memory-read'), p.raw.slice(0, 400));
    const txt = run(root, ['--text', 'Maak een Android spel']);
    const tid = runIdOf(txt);
    const so = String(txt.stdout);
    t('C6 text mode: the device commands are printed with this run id filled in, and the notes', txt.status === 0 && so.includes('  screenshot: adb exec-out screencap -p > .claude/forge-runs/' + tid + '/artifacts/device-screenshot-1.png') && so.includes('  boot: "emu" -avd Pixel_7') && so.includes('  note: stub note'), so.split('\n').filter((l) => /device|screenshot|boot|note/.test(l)).join(' | '));
    t('C6b ... and the failed prefs step is marked FAILED in the text', /^\[3\/8\] owner preferences: FAILED — /m.test(so), so.split('\n').find((l) => l.startsWith('[3/8]')));
    fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'forge-device-env.cjs'), "'use strict';\nconsole.log('not json');\n");
    const bad = run(root, ['--text', 'Maak een Android spel', '--json']);
    let bj = null;
    try { bj = JSON.parse(String(bad.stdout).trim()); } catch { bj = null; }
    const bdev = bj && bj.steps.find((s) => s.id === 'device');
    t('C7 a device tool without a verdict is a failed step, never a made-up summary', bad.status === 0 && bdev && bdev.ok === false && /gave no verdict/.test(bdev.note), JSON.stringify(bdev));
  });

  console.log('\nD) the graph line in the memory step: an injected ensure, never a real graphify');
  section('D', () => {
    const S = require(path.join(__dirname, 'forge-start.cjs'));
    t('D0 graphLine is exported', typeof S.graphLine === 'function');
    const seen = [];
    const stub = (res) => (opts) => { seen.push(opts); return res; };
    const fresh = S.graphLine(stub({ status: 'fresh', reason: 'graph.json is newer than every source file' }), '/proj');
    t('D1 fresh: the line names the status, the report to read first and the query command',
      fresh === 'graph: fresh - read graphify-out/GRAPH_REPORT.md first when it exists, query with: graphify query "<question>" (set GRAPHIFY_QUERY_LOG_DISABLE=1 first, or graphify logs each query to ~/.cache)', fresh);
    t('D1b ensure is called with this root and wait false (forge-start never waits for a build)', seen.length === 1 && seen[0].root === '/proj' && seen[0].wait === false, JSON.stringify(seen));
    const building = S.graphLine(stub({ status: 'building', reason: 'started in the background' }), '/proj');
    t('D2 building: says it is being built in the background, plus the read-first and query hint',
      /^graph: building - being built in the background; read graphify-out\/GRAPH_REPORT\.md first when it exists, query with: graphify query "<question>" \(set GRAPHIFY_QUERY_LOG_DISABLE=1 first, or graphify logs each query to ~\/\.cache\)$/.test(String(building)), building);
    const unav = S.graphLine(stub({ status: 'unavailable', reason: 'graphify is not installed' }), '/proj');
    t('D3 unavailable: one short plain reason, no query hint', unav === 'graph: unavailable - graphify is not installed', unav);
    const skip = S.graphLine(stub({ status: 'skipped', reason: '' }), '/proj');
    t('D3b skipped without a reason still gets a short plain reason', /^graph: skipped - \S/.test(String(skip)) && !/graphify query/.test(String(skip)), skip);
    t('D4 ensure throws: no line, no throw', S.graphLine(() => { throw new Error('boom'); }, '/proj') === null);
    t('D5 module missing (no ensure function): no line', S.graphLine(null, '/proj') === null && S.graphLine(undefined, '/proj') === null);
    t('D6 a result without a known status: no line', S.graphLine(stub(null), '/proj') === null && S.graphLine(stub({ status: 'weird' }), '/proj') === null);
  });

  console.log('\nE) end to end: the graph line reaches the memory step; a broken or missing graphify never breaks forge-start');
  section('E', () => {
    const root = project('p-graph');
    const mod = path.join(root, '.claude', 'forge-bin', 'forge-graphify.cjs');
    const memStep = (r) => { try { return JSON.parse(String(r.stdout).trim()).steps.find((s) => s.id === 'memory'); } catch { return null; } };
    fs.writeFileSync(mod, "'use strict';\nmodule.exports = { ensure: (o) => ({ status: o && o.wait === false ? 'fresh' : 'built', reason: 'stub', out_dir: null, graph: null, report: null }) };\n");
    const r1 = run(root, ['--text', 'Fix the typo in the README title']);
    const so = String(r1.stdout);
    const memAt = so.split('\n').findIndex((l) => l.startsWith('[4/8] project memory'));
    const gAt = so.split('\n').findIndex((l) => l.startsWith('graph: fresh - read graphify-out/GRAPH_REPORT.md first'));
    const qAt = so.split('\n').findIndex((l) => l.startsWith('[5/8]'));
    t('E1 a stub ensure (wait false -> fresh) gives the graph line inside the memory step output', r1.status === 0 && memAt >= 0 && gAt > memAt && gAt < qAt, so.slice(0, 1500));
    fs.writeFileSync(mod, "'use strict';\nmodule.exports = { ensure: () => { throw new Error('graphify exploded'); } };\n");
    const r2 = run(root, ['--text', 'Fix the typo in the README title', '--json']);
    t('E2 ensure throws: exit 0, the memory step is still ok, nothing about the throw leaks', r2.status === 0 && memStep(r2) && memStep(r2).ok === true && !/graphify exploded/.test(out(r2)), out(r2).slice(0, 600));
    fs.writeFileSync(mod, "'use strict';\nthis is not javascript\n");
    const r3 = run(root, ['--text', 'Fix the typo in the README title']);
    t('E3 a module that does not load: exit 0, no graph line, memory step not FAILED', r3.status === 0 && !/^graph: /m.test(String(r3.stdout)) && /^\[4\/8\] project memory: (?!FAILED)/m.test(String(r3.stdout)), out(r3).slice(0, 600));
    fs.rmSync(mod);
    const r4 = run(root, ['--text', 'Fix the typo in the README title']);
    t('E4 module missing: exit 0, no graph line, 8 steps still printed', r4.status === 0 && !/^graph: /m.test(String(r4.stdout)) && /^\[8\/8\] /m.test(String(r4.stdout)), out(r4).slice(0, 600));
    t('E5 no graphify-out folder was created by any of these runs', !fs.existsSync(path.join(root, 'graphify-out')));
  });
  // CF-4-F6: the brief printed template rules first and the newest owner rule last, so at the 40-line cap the
  // newest owner rule was the one cut; template rules copied from the always-loaded project CLAUDE.md were repeated too.
  section('CF-4-F6 standing rule order', () => {
    const S = require(path.join(SRC, 'forge-bin', 'forge-start.cjs'));
    t('CF-4-F6 forge-start exports standingLines', typeof S.standingLines === 'function');
    const rules = [
      { id: 'tpl-mirrored', scope: 'global', text: 'mirrored', _origin: 'template', source: "CLAUDE.md (this project's root, section 'Honesty (REQUIRED)') — verbatim" },
      { id: 'tpl-kept', scope: 'global', text: 'kept', _origin: 'template', source: 'commands/forge.md (BEGINNER PROMISE)' },
      { id: 'user-old', scope: 'global', text: 'old', _origin: 'user', source: 'owner /forge remember' },
      { id: 'user-new', scope: 'global', text: 'new', _origin: 'user', source: 'owner /forge remember' },
    ];
    const r = S.standingLines(rules);
    t('CF-4-F6 user rules newest first, then template rules; the CLAUDE.md mirror is skipped',
      JSON.stringify(r.lines) === JSON.stringify(['user-new	[global]	new', 'user-old	[global]	old', 'tpl-kept	[global]	kept']) && r.skipped === 1, JSON.stringify(r));
    const many = Array.from({ length: 45 }, (_, k) => ({ id: 'u' + k, scope: 'global', text: 't', _origin: 'user', source: 'owner /forge remember' }));
    t('CF-4-F6 at the cap the newest owner rule is printed, the oldest is the one cut', S.standingLines(many).lines[0].startsWith('u44	') && !S.standingLines(many).lines.slice(0, 40).some((l) => l.startsWith('u0	')));
  });
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log('\nforge-start tests:');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
