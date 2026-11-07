#!/usr/bin/env node
'use strict';
/**
 * forge-session-end.test.cjs — the SessionEnd hook (plan item 1.6). Throwaway roots only. Covers: the dry run
 * NEVER applies (argv has no --apply; an over-limit history file is byte-identical afterwards and no archive
 * appears), `consolidation_due` true/false, the reason field, fail-open on garbage stdin through the real CLI
 * (exit 0, empty stdout), opt-out, secret-shaped session id, and runtime under 5 s. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const SE = require('./forge-session-end.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const mkRoot = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-se-')); fs.mkdirSync(path.join(r, '.claude')); roots.push(r); return r; };
const SCRIPT = path.join(__dirname, 'forge-session-end.cjs');
const cli = (root, input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 15000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, FORGE_SESSION_END_HOOK: '' }) });
const logOf = (root) => path.join(root, '.claude', 'forge-runs', '_hooks', 'session-end.jsonl');
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const listTree = (d) => { const out = []; const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else out.push(path.relative(d, q)); } }; walk(d); return out.sort(); };
const SK = 'sk' + '-' + 'canarySESSEND0123456789abcdef';

/** a history file over the 50 KB rotation limit, in the section shape forge-memory-consolidate rotates */
function bigHistory(root) {
  const parts = ['# Forge Task History\n\n'];
  for (let i = 0; i < 80; i++) parts.push('## 2026-0' + (1 + (i % 9)) + '-1' + (i % 9) + ' task ' + i + '\n\n' + 'line of history text. '.repeat(40) + '\n\n');
  const f = path.join(root, '.claude', 'FORGE_TASK_HISTORY.md');
  fs.writeFileSync(f, parts.join(''));
  return f;
}

try {
  console.log('\nA) dry run only');
  t('A1 the consolidation argv never contains --apply', !SE.consolidateArgs('/x').includes('--apply') && SE.consolidateArgs('/x').includes('--json'));
  t('A2 the source never passes --apply to a child', !/['"]--apply['"]\s*[,\]]/.test(fs.readFileSync(SCRIPT, 'utf8').replace(/args\.includes\('--apply'\)/, '')));

  const due = mkRoot();
  const hist = bigHistory(due);
  const before = sha(hist);
  const treeBefore = listTree(path.join(due, '.claude'));
  const r = SE.run(JSON.stringify({ session_id: 'sess-se-1', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', cwd: 'C:/elsewhere' }), { root: due, env: {} });
  const L = readLines(logOf(due));
  t('A3 one line written, consolidate ok', r.ok && r.wrote && L.length === 1 && L[0].consolidate === 'ok', JSON.stringify(r));
  t('A4 over-limit history -> consolidation_due true, file named', L[0].consolidation_due === true && L[0].due_files.includes('.claude/FORGE_TASK_HISTORY.md'), JSON.stringify(L[0]));
  t('A5 the history file is byte-identical (nothing applied)', sha(hist) === before);
  const treeAfter = listTree(path.join(due, '.claude')).filter((p) => !p.startsWith('forge-runs'));
  t('A6 no archive / LESSONS.md / backup appeared', JSON.stringify(treeAfter) === JSON.stringify(treeBefore) && !fs.existsSync(path.join(due, '_scratch')), JSON.stringify(treeAfter));
  t('A7 reason + event recorded', L[0].reason === 'prompt_input_exit' && L[0].event === 'SessionEnd' && L[0].session === 'sess-se-1');

  const clean = mkRoot();
  SE.run(JSON.stringify({ session_id: 'sess-se-2', reason: 'clear' }), { root: clean, env: {} });
  const C = readLines(logOf(clean));
  t('A8 small memory -> consolidation_due false', C.length === 1 && C[0].consolidation_due === false && C[0].due_files.length === 0, JSON.stringify(C));

  console.log('\nB) scrubbing + field hygiene');
  SE.run(JSON.stringify({ session_id: SK, reason: 'Free text with ' + SK }), { root: clean, env: {} });
  const disk = fs.readFileSync(logOf(clean), 'utf8');
  t('B1 a secret-shaped session id or reason never reaches disk', !disk.includes('canarySESSEND'), disk.slice(-300));
  t('B2 a free-text reason is dropped, not stored', readLines(logOf(clean))[1].reason === undefined);

  console.log('\nC) fail-open + opt-out');
  for (const [name, input] of [['garbage', 'not json'], ['empty', ''], ['array', '[1]']]) {
    const c = cli(mkRoot(), input);
    t('C1 CLI on ' + name + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }
  const off = mkRoot();
  t('C2 FORGE_SESSION_END_HOOK=off writes nothing', SE.run('{}', { root: off, env: { FORGE_SESSION_END_HOOK: 'off' } }).wrote === false && !fs.existsSync(logOf(off)));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-se-bare-')); roots.push(bare);
  t('C3 no .claude/ -> nothing created', SE.run('{}', { root: bare, env: {} }).wrote === false && !fs.existsSync(path.join(bare, '.claude')));
  const slow = SE.dryRunConsolidate(due, { childTimeoutMs: 1 });
  t('C4 a child that overruns its timeout is reported, not waited on', ['timeout', 'failed'].includes(slow.consolidate) && slow.due === false, JSON.stringify(slow));

  console.log('\nD) CLI end to end + timing');
  const cr = mkRoot();
  bigHistory(cr);
  const t0 = Date.now();
  const c = cli(cr, JSON.stringify({ session_id: 'sess-cli', reason: 'other' }));
  const ms = Date.now() - t0;
  const cl = readLines(logOf(cr));
  t('D1 CLI writes the line, exit 0, empty stdout', c.status === 0 && c.stdout === '' && cl.length === 1 && cl[0].consolidation_due === true, JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr, cl }));
  t('D2 runtime under 5 s (measured ' + ms + ' ms)', ms < 5000);
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-session-end tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
