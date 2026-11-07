#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-start.test.cjs — the SubagentStart hook (WP A2). Throwaway roots only. Covers: a sample
 * payload parsed into exactly { ts, event:'SubagentStart', session, agent_id, agent_type } (+ run when a pointer is set),
 * no transcript path / cwd / secret on disk, fail-open CLI on garbage (exit 0, empty stdout), opt-out, no .claude -> no
 * write, the maintenance lock, the run stamped from the pointer through the real CLI, and a runtime under 5 s.
 * Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ST = require('./forge-subagent-start.cjs');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const mkRoot = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sst-')); fs.mkdirSync(path.join(r, '.claude')); roots.push(r); return r; };
const SCRIPT = path.join(__dirname, 'forge-subagent-start.cjs');
const cli = (root, input, extraEnv) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, FORGE_SUBAGENT_START_HOOK: '', FORGE_RUN_ID: '' }, extraEnv || {}) });
const logOf = (root) => path.join(root, '.claude', 'forge-runs', '_hooks', 'subagent-start.jsonl');
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const SK = 'sk' + '-' + 'canarySUBSTART0123456789abcdef';

// The documented SubagentStart input: the common fields + agent_id + agent_type (spike A2a, HOOKS_OPT_IN.md).
const payload = {
  session_id: 'sess-st-1', transcript_path: 'C:/Users/x/.claude/projects/p/s.jsonl', cwd: 'C:/proj/secret-folder', permission_mode: 'default',
  hook_event_name: 'SubagentStart', agent_id: 'a0b1c2d3e4f5a6b7c', agent_type: 'verify-boss',
};

try {
  console.log('\nA) record shape');
  const root = mkRoot();
  const r = ST.run(JSON.stringify(payload), { root, env: {} });
  const L = readLines(logOf(root));
  t('A1 one line in _hooks/subagent-start.jsonl', r.ok && r.wrote && L.length === 1 && r.path === logOf(root), JSON.stringify(r));
  t('A2 exactly the token-free fields', JSON.stringify(Object.keys(L[0]).sort()) === JSON.stringify(['agent_id', 'agent_type', 'event', 'session', 'ts']), JSON.stringify(L[0]));
  t('A3 values carried through, event SubagentStart', L[0].event === 'SubagentStart' && L[0].session === 'sess-st-1' && L[0].agent_id === 'a0b1c2d3e4f5a6b7c' && L[0].agent_type === 'verify-boss');
  t('A4 a payload without agent_type says absent (never guessed)', ST.buildRecord({ agent_id: 'a1' }).agent_type === null && ST.buildRecord({ agent_id: 'a1' }).agent_type_shape === 'absent');

  console.log('\nB) no content, no secrets on disk');
  const disk = fs.readFileSync(logOf(root), 'utf8');
  t('B1 transcript path and cwd never reach disk', !disk.includes('transcript') && !disk.includes('secret-folder') && !disk.includes('.claude/projects'));
  ST.run(JSON.stringify(Object.assign({}, payload, { session_id: SK, agent_type: SK })), { root, env: {} });
  t('B2 a secret-shaped session id / agent_type is not written raw', !fs.readFileSync(logOf(root), 'utf8').includes('canarySUBSTART'));

  console.log('\nC) fail-open, opt-out, guards');
  for (const [name, input] of [['garbage', '{{{not json'], ['empty', ''], ['array', '[]']]) {
    const c = cli(mkRoot(), input);
    t('C1 CLI on ' + name + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }
  const off = mkRoot();
  t('C2 FORGE_SUBAGENT_START_HOOK=off writes nothing', ST.run(JSON.stringify(payload), { root: off, env: { FORGE_SUBAGENT_START_HOOK: 'off' } }).wrote === false && !fs.existsSync(logOf(off)));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sst-bare-')); roots.push(bare);
  t('C3 no .claude/ -> nothing created', ST.run(JSON.stringify(payload), { root: bare, env: {} }).wrote === false && !fs.existsSync(path.join(bare, '.claude')));
  const lock = mkRoot();
  fs.writeFileSync(path.join(lock, '.claude', '.forge-sync.lock'), JSON.stringify({ started_at: new Date().toISOString() }));
  t('C4 a fresh forge-sync lock -> nothing written', ST.run(JSON.stringify(payload), { root: lock, env: {} }).wrote === false && !fs.existsSync(logOf(lock)));

  console.log('\nD) CLI end to end with the run pointer, timing');
  const cr = mkRoot();
  fs.mkdirSync(path.join(cr, '.claude', 'forge-runs', 'run-st-9'), { recursive: true });
  AR.setActiveRun(cr, 'run-st-9', { session: 'sess-st-1' });
  const t0 = Date.now();
  const c = cli(cr, JSON.stringify(payload));
  const ms = Date.now() - t0;
  const cl = readLines(logOf(cr));
  t('D1 CLI: exit 0, empty stdout, run stamped from the session pointer', c.status === 0 && c.stdout === '' && cl.length === 1 && cl[0].run === 'run-st-9' && cl[0].run_source === 'pointer-session', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr, cl }));
  t('D2 runtime under 5 s (measured ' + ms + ' ms)', ms < 5000);
  const c2 = cli(cr, JSON.stringify(payload), { FORGE_RUN_ID: 'run-env-2' });
  t('D3 env FORGE_RUN_ID wins over the pointer', c2.status === 0 && readLines(logOf(cr))[1].run === 'run-env-2');
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-subagent-start tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
