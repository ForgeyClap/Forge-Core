#!/usr/bin/env node
'use strict';
// forge-watch-launch.cjs — Forge adapter that runs a script of the global "watch" skill with a WORKING Python 3
// (WP SA-P1-ADAPT, PHASE2-PLAN A10 + section E). Probes FORGE_PYTHON, python, py -3, python3 (python3 first on
// macOS/Linux) and keeps the first that really answers as Python 3, so a Windows Store stub that exits 9009 is skipped.
// No shell: the script path and the user's arguments are passed as an argv array.
//
// Usage: node forge-watch-launch.cjs which | smoke | <script.py> [args...]
// Skill folder: WATCH_SKILL_DIR, else ~/.claude/skills/watch. Exit: the script's own code; 2 = no Python 3 / bad usage.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE_TIMEOUT_MS = 15000;
const PROBE_CODE = 'import sys; print(sys.executable); print(sys.version_info[0])';
const SCRIPT_NAME_RE = /^[A-Za-z0-9_-]+\.py$/;

function pythonCandidates({ env, platform }) {
  const out = [];
  if (env.FORGE_PYTHON) out.push({ cmd: env.FORGE_PYTHON, args: [] });
  if (platform === 'win32') out.push({ cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }, { cmd: 'python3', args: [] });
  else out.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  return out;
}

function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: (opts && opts.timeout) || PROBE_TIMEOUT_MS });
}

function resolvePython(deps) {
  const d = deps || {};
  const run = d.run || defaultRun;
  const tried = [];
  for (const c of pythonCandidates({ env: d.env || process.env, platform: d.platform || process.platform })) {
    const r = run(c.cmd, c.args.concat(['-c', PROBE_CODE]), { timeout: PROBE_TIMEOUT_MS }) || {};
    const lines = String(r.stdout || '').trim().split(/\r?\n/);
    const label = [c.cmd].concat(c.args).join(' ');
    if (r.error) { tried.push(label + ': ' + (r.error.code || r.error.message)); continue; }
    if (r.status !== 0) { tried.push(label + ': exit ' + r.status); continue; }
    if (lines[1] !== '3') { tried.push(label + ': not Python 3'); continue; }
    return { ok: true, cmd: c.cmd, args: c.args, executable: lines[0], tried };
  }
  return { ok: false, reason: 'no working Python 3 found (' + tried.join('; ') + ')', tried };
}

function skillDir({ env, home }) {
  return env.WATCH_SKILL_DIR || path.join(home, '.claude', 'skills', 'watch');
}

function resolveScript(dir, name) {
  if (!SCRIPT_NAME_RE.test(String(name || ''))) throw new Error('invalid script name "' + name + '" (expected a bundled <name>.py)');
  const file = path.join(dir, 'scripts', name);
  if (!fs.existsSync(file)) throw new Error('script not found: ' + file);
  return file;
}

function buildInvocation(py, scriptPath, userArgs) {
  return { cmd: py.cmd, args: py.args.concat([scriptPath], userArgs || []) };
}

function smoke(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const py = resolvePython({ env, platform: d.platform, run: d.run });
  if (!py.ok) return { ok: false, reason: py.reason };
  let script;
  try { script = resolveScript(skillDir({ env, home: d.home || os.homedir() }), 'watch.py'); } catch (e) { return { ok: false, reason: e.message, python: py.executable }; }
  const inv = buildInvocation(py, script, ['--help']);
  const r = (d.run || defaultRun)(inv.cmd, inv.args, { timeout: PROBE_TIMEOUT_MS }) || {};
  const okRun = r.status === 0 && /usage:\s*watch/i.test(String(r.stdout || ''));
  return { ok: okRun, python: py.executable, via: [py.cmd].concat(py.args).join(' '), exit: r.status, reason: okRun ? '' : 'watch.py --help failed (exit ' + r.status + ')' };
}

const USAGE = 'usage: forge-watch-launch.cjs which | smoke | <script.py> [args...]  (-h/--help prints this)';

function main(argv) {
  const env = process.env;
  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') { console.log(USAGE); return 0; }
  if (!first) { console.error(USAGE); return 2; }
  if (first === 'smoke') {
    const r = smoke({});
    console.log(r.ok ? 'watch smoke OK (' + r.via + ' -> ' + r.python + ')' : 'watch smoke FAILED: ' + r.reason);
    return r.ok ? 0 : 1;
  }
  const py = resolvePython({ env });
  if (!py.ok) { console.error(py.reason); return 2; }
  if (first === 'which') { console.log([py.cmd].concat(py.args).join(' ') + '  ->  ' + py.executable); return 0; }
  let script;
  try { script = resolveScript(skillDir({ env, home: os.homedir() }), first); } catch (e) { console.error(e.message); return 2; }
  const inv = buildInvocation(py, script, argv.slice(1));
  const r = spawnSync(inv.cmd, inv.args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (r.error) { console.error('python could not start: ' + r.error.message); return 2; }
  return r.status === null ? 1 : r.status;
}

module.exports = { pythonCandidates, resolvePython, skillDir, resolveScript, buildInvocation, smoke, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
