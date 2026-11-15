#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-resume-brief.test.cjs — the SessionStart resume brief (.7, R-0069). Exactly two tests (owner R-0068):
 * T1 a throwaway root with one unfinalized run (3 created, 1 completed WP) names the 2 unfinished ids and the
 *    'continue' instruction; source=compact and FORGE_RESUME_BRIEF=off print nothing; a paused run gets no continue
 *    instruction and an aborted run is not surfaced (FB-MEMORY-F3, a second check inside T1).
 * T2 the real CLI in this repo with source=clear exits 0 and stays within the char cap. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const RB = require('./forge-resume-brief.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const SCRIPT = path.join(__dirname, 'forge-resume-brief.cjs');
const REPO = path.resolve(__dirname, '..', '..');
let root = null;

try {
  console.log('\nT1) unfinished WPs from a fixture run');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rb-'));
  const run = path.join(root, '.claude', 'forge-runs', 'forge-2026-11-01-fixture');
  fs.mkdirSync(run, { recursive: true });
  const ev = (type, wp) => JSON.stringify({ run_id: 'forge-2026-11-01-fixture', event_type: type, wp_id: wp });
  fs.writeFileSync(path.join(run, 'events.jsonl'), [
    ev('agent_work_package_created', 'WP-A'), ev('agent_work_package_created', 'WP-B'),
    ev('agent_work_package_created', 'WP-C'), ev('wp_completed', 'WP-B'),
  ].join('\n') + '\n');
  const opts = (env) => ({ root, env, scribe: () => null });
  const out = RB.brief(JSON.stringify({ source: 'startup' }), opts({}));
  const compact = RB.brief(JSON.stringify({ source: 'compact' }), opts({}));
  const off = RB.brief(JSON.stringify({ source: 'clear' }), opts({ FORGE_RESUME_BRIEF: 'off' }));
  t('T1 names WP-A + WP-C (not WP-B) and the continue instruction; compact and off print nothing',
    /Open work packages: 2 -> WP-A, WP-C\n/.test(out) && !out.includes('WP-B') && out.includes('Continue the unfinished work') &&
    out.includes('forge-2026-11-01-fixture') && compact === '' && off === '',
    JSON.stringify({ out, compact, off }));
  // FB-MEMORY-F3, part of T1: a run the owner PAUSED is labelled paused and never gets the
  // continue instruction; a later run_resumed makes it open again; an aborted run is not surfaced.
  const write = (lines) => fs.writeFileSync(path.join(run, 'events.jsonl'), lines.join('\n') + '\n');
  write([ev('run_started'), ev('agent_work_package_created', 'WP-A'), ev('run_paused')]);
  const paused = RB.brief(JSON.stringify({ source: 'startup' }), opts({}));
  write([ev('run_started'), ev('agent_work_package_created', 'WP-A'), ev('run_paused'), ev('run_resumed')]);
  const resumed = RB.brief(JSON.stringify({ source: 'startup' }), opts({}));
  write([ev('run_started'), ev('agent_work_package_created', 'WP-A'), ev('run_aborted')]);
  const aborted = RB.brief(JSON.stringify({ source: 'startup' }), opts({}));
  t('T1 a paused run is labelled PAUSED without the continue instruction; resumed is open again; aborted prints nothing',
    /PAUSED/.test(paused) && !paused.includes('Continue the unfinished work') && resumed.includes('Continue the unfinished work') &&
    !/PAUSED/.test(resumed) && aborted === '',
    JSON.stringify({ paused, resumed, aborted }));
  // Rework (Verify Boss FAIL): Forge records an abort as run_completed with a failure-close status (the registered
  // shape; run_aborted is not a log-event type). Such a run is closed; a plain run_completed without it is not.
  const closeWith = (status) => JSON.stringify({ run_id: 'forge-2026-11-01-fixture', event_type: 'run_completed', status });
  const closedBriefs = ['aborted', 'abandoned', 'cancelled', 'failed'].map((s) => {
    write([ev('run_started'), ev('agent_work_package_created', 'WP-A'), closeWith(s)]);
    return RB.brief(JSON.stringify({ source: 'startup' }), opts({}));
  });
  write([ev('run_started'), ev('agent_work_package_created', 'WP-A'), closeWith('done')]);
  const doneOpen = RB.brief(JSON.stringify({ source: 'startup' }), opts({}));
  t('T1 run_completed with status aborted/abandoned/cancelled/failed is closed; status done with an open WP still surfaces',
    closedBriefs.every((b) => b === '') && doneOpen.includes('WP-A'),
    JSON.stringify({ closedBriefs, doneOpen }));

  console.log('\nT2) real CLI in this repo, source=clear');
  const t0 = Date.now();
  const c = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ source: 'clear', hook_event_name: 'SessionStart' }),
    encoding: 'utf8', timeout: 15000, env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: REPO, FORGE_RESUME_BRIEF: '' }) });
  const ms = Date.now() - t0;
  t('T2 exit 0, stdout <= ' + RB.MAX_CHARS + ' chars (got ' + (c.stdout || '').length + ', ' + ms + ' ms)',
    c.status === 0 && typeof c.stdout === 'string' && c.stdout.length <= RB.MAX_CHARS && ms < 3000,
    JSON.stringify({ s: c.status, e: c.stderr, len: (c.stdout || '').length, ms }));
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-resume-brief tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
