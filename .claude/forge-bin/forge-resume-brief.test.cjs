#!/usr/bin/env node
'use strict';
/**
 * forge-resume-brief.test.cjs — the SessionStart resume brief (.7, R-0069). Exactly two tests (owner R-0068):
 * T1 a throwaway root with one unfinalized run (3 created, 1 completed WP) names the 2 unfinished ids and the
 *    'continue' instruction; source=compact and FORGE_RESUME_BRIEF=off print nothing.
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
