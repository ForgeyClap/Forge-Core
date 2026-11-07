#!/usr/bin/env node
'use strict';
/**
 * forge-active-run.test.cjs — the run pointer (WP A2). Throwaway roots only (os.tmpdir()). Covers the round
 * trip set -> read -> clear, session isolation (own pointer first, another session's fallback ignored), staleness, the
 * refusals (bad run id, missing run folder), a secret-shaped session id never becoming a file name, an unreadable pointer,
 * clear never deleting, the CLI exit codes, and the hooks stamping the run from the pointer end to end. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const mkRoot = (run) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ar-'));
  fs.mkdirSync(path.join(r, '.claude', 'forge-runs', run || 'run-a1'), { recursive: true });
  roots.push(r);
  return r;
};
const hooksDir = (root) => path.join(root, '.claude', 'forge-runs', '_hooks');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const SCRIPT = path.join(__dirname, 'forge-active-run.cjs');
const cli = (root, args) => spawnSync(process.execPath, [SCRIPT].concat(args, ['--root', root]), { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { CLAUDE_SESSION_ID: '' }) });
const SK = 'sk' + '-' + 'canaryACTIVERUN0123456789abcdef';

try {
  console.log('\nA) set -> read round trip, session isolation');
  const root = mkRoot();
  const s = AR.setActiveRun(root, 'run-a1', { session: 'sess-a' });
  const own = path.join(hooksDir(root), 'active-run.sess-a.json');
  const fb = path.join(hooksDir(root), 'active-run.json');
  t('A1 set writes the session pointer and the fallback', s.ok && s.written.length === 2 && fs.existsSync(own) && fs.existsSync(fb), JSON.stringify(s));
  const pj = readJson(own);
  t('A2 pointer content is exactly {schema, run, session, set_at}', JSON.stringify(Object.keys(pj).sort()) === JSON.stringify(['run', 'schema', 'session', 'set_at']) && pj.run === 'run-a1' && pj.session === 'sess-a' && pj.schema === AR.SCHEMA, JSON.stringify(pj));
  let r = AR.readActiveRun(root, 'sess-a');
  t('A3 the same session reads its own pointer', r.run === 'run-a1' && r.source === 'pointer-session', JSON.stringify(r));
  r = AR.readActiveRun(root, 'sess-b');
  t('A4 another session does not get this run (the fallback belongs to sess-a)', r.run === null && /another session/.test(r.reason), JSON.stringify(r));
  r = AR.readActiveRun(root, undefined);
  t('A5 a hook without a session id reads the fallback', r.run === 'run-a1' && r.source === 'pointer-fallback', JSON.stringify(r));
  const root2 = mkRoot();
  const s2 = AR.setActiveRun(root2, 'run-a1', {});
  t('A6 set without a session writes only the fallback and says so', s2.ok && s2.written.length === 1 && /only the fallback/.test(s2.reason), JSON.stringify(s2));
  t('A7 ... and every session reads it', AR.readActiveRun(root2, 'sess-x').run === 'run-a1' && AR.readActiveRun(root2, 'sess-y').source === 'pointer-fallback');

  console.log('\nB) clear never deletes; staleness; refusals');
  let c = AR.clearActiveRun(root, { session: 'sess-a', run: 'run-other' });
  t('B1 clear --run <other run> keeps both pointers', c.ok && c.cleared.length === 0 && c.kept.length === 2 && AR.readActiveRun(root, 'sess-a').run === 'run-a1', JSON.stringify(c));
  c = AR.clearActiveRun(root, { session: 'sess-a', run: 'run-a1' });
  t('B2 clear --run run-a1 clears both', c.ok && c.cleared.length === 2, JSON.stringify(c));
  t('B3 ... the files still exist (overwritten, never deleted) with run:null + previous_run', fs.existsSync(own) && fs.existsSync(fb) && readJson(own).run === null && readJson(own).previous_run === 'run-a1' && typeof readJson(own).cleared_at === 'string');
  r = AR.readActiveRun(root, 'sess-a');
  t('B4 a cleared session pointer reads as no run (reason cleared)', r.run === null && r.reason === 'cleared', JSON.stringify(r));
  const root3 = mkRoot();
  AR.setActiveRun(root3, 'run-a1', { session: 'sess-a' });
  const later = Date.now() + 25 * 3600 * 1000;
  r = AR.readActiveRun(root3, 'sess-a', { now: later });
  t('B5 a pointer older than 24 h is stale', r.run === null && /stale/.test(r.reason), JSON.stringify(r));
  t('B6 FORGE_ACTIVE_RUN_MAX_AGE_H=48 keeps it valid', AR.readActiveRun(root3, 'sess-a', { now: later, env: { FORGE_ACTIVE_RUN_MAX_AGE_H: '48' } }).run === 'run-a1');
  t('B7 an out-of-range max age falls back to 24 h', AR.maxAgeMs({ FORGE_ACTIVE_RUN_MAX_AGE_H: '9999' }) === 24 * 3600 * 1000);
  t('B8 set refuses a path-like or spaced run id', !AR.setActiveRun(root3, '../evil', {}).ok && !AR.setActiveRun(root3, 'a b', {}).ok);
  const miss = AR.setActiveRun(root3, 'run-not-there', {});
  t('B9 set refuses a run without a run folder (log run_started first) unless allowMissing', !miss.ok && /run_started/.test(miss.reason) && AR.setActiveRun(root3, 'run-not-there', { allowMissing: true }).ok);
  const root4 = mkRoot();
  const s4 = AR.setActiveRun(root4, 'run-a1', { session: SK });
  t('B10 a secret-shaped session id never becomes a file name (fallback only, session null)', s4.ok && s4.session === null && !fs.readdirSync(hooksDir(root4)).some((f) => f.includes('canary')) && !fs.readFileSync(path.join(hooksDir(root4), 'active-run.json'), 'utf8').includes('canary'));
  const root5 = mkRoot();
  fs.mkdirSync(hooksDir(root5), { recursive: true });
  fs.writeFileSync(path.join(hooksDir(root5), 'active-run.json'), '{not json');
  r = AR.readActiveRun(root5, 'sess-a');
  t('B11 an unreadable pointer is no run, with the reason', r.run === null && /not valid JSON/.test(r.reason), JSON.stringify(r));
  t('B12 readActiveRun never throws on a missing root', AR.readActiveRun(null, 'x').run === null);

  console.log('\nC) CLI');
  const root6 = mkRoot('run-cli-1');
  let x = cli(root6, ['set', 'run-cli-1', '--session', 'sess-cli']);
  t('C1 set -> exit 0, names the files', x.status === 0 && /active run set: run-cli-1 \(session sess-cli\)/.test(x.stdout), JSON.stringify({ s: x.status, o: x.stdout, e: x.stderr }));
  x = cli(root6, ['show', '--session', 'sess-cli', '--json']);
  t('C2 show --json -> the pointer run', x.status === 0 && JSON.parse(x.stdout).run === 'run-cli-1', x.stdout);
  x = cli(root6, ['set', 'run-missing']);
  t('C3 set for a run without a folder -> exit 1', x.status === 1 && /run_started/.test(x.stderr), JSON.stringify({ s: x.status, e: x.stderr }));
  x = cli(root6, ['clear', '--session', 'sess-cli', '--run', 'run-cli-1']);
  t('C4 clear -> exit 0', x.status === 0 && /cleared: /.test(x.stdout) && AR.readActiveRun(root6, 'sess-cli').run === null, x.stdout + x.stderr);
  t('C5 no command / unknown option -> exit 2', cli(root6, []).status === 2 && cli(root6, ['set', 'run-cli-1', '--bogus']).status === 2);

  console.log('\nD) end to end: the hooks stamp the run from the pointer');
  const SS = require('./forge-subagent-stop.cjs');
  const ST = require('./forge-subagent-start.cjs');
  const AT = require('./forge-agent-tool-hook.cjs');
  const root7 = mkRoot('run-e2e-1');
  AR.setActiveRun(root7, 'run-e2e-1', { session: 'sess-e2e' });
  const base = { session_id: 'sess-e2e', agent_id: 'a0123456789abcdef', agent_type: 'build-boss' };
  ST.run(JSON.stringify(Object.assign({ hook_event_name: 'SubagentStart' }, base)), { root: root7, env: {} });
  SS.run(JSON.stringify(Object.assign({ hook_event_name: 'SubagentStop', last_assistant_message: 'done' }, base)), { root: root7, env: {} });
  AT.run(JSON.stringify({ session_id: 'sess-e2e', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_e2e000001', tool_input: { subagent_type: 'build-boss', prompt: 'x' } }), { root: root7, env: {} });
  const lines = ['subagent-start.jsonl', 'subagent-stop.jsonl', 'agent-tool.jsonl'].map((f) => JSON.parse(fs.readFileSync(path.join(hooksDir(root7), f), 'utf8').trim()));
  t('D1 SubagentStart, SubagentStop and PreToolUse(Agent) lines all carry run-e2e-1 from the session pointer', lines.every((l) => l.run === 'run-e2e-1' && l.run_source === 'pointer-session'), JSON.stringify(lines));
  AR.clearActiveRun(root7, { session: 'sess-e2e' });
  ST.run(JSON.stringify(Object.assign({ hook_event_name: 'SubagentStart' }, base, { agent_id: 'a1111111111111111' })), { root: root7, env: {} });
  const after = fs.readFileSync(path.join(hooksDir(root7), 'subagent-start.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  t('D2 after clear the next line carries no run', after.length === 2 && after[1].run === undefined, JSON.stringify(after[1]));
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-active-run tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
