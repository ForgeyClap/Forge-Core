#!/usr/bin/env node
'use strict';
/**
 * forge-testrun.cjs — run a test command, print only a compact summary (usage reduction U-12).
 * Usage: node forge-testrun.cjs [--max-fail-lines 15] [--log-dir <dir>] [--timeout-sec N] [--max-lines 40] -- <cmd> [args...]
 * Prints: command, exit code, duration, "N passed, M failed", failing test names + first lines, full-log path.
 * Exit code mirrors the wrapped command (124 on timeout, 2 on usage). Spawns with an args array, no shell
 * string; on timeout kills only its own child PID. Output is secret-scrubbed. Zero dependencies.
 * WP-TMP-HYGIENE: the command runs with TEMP/TMP/TMPDIR set to a private forge-run-<pid>-<n> folder under
 * os.tmpdir(), removed afterwards (pass, fail or timeout), so fixtures a test forgets to delete never pile up.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const FALLBACK_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*\S+/g,
];
function loadPatterns() {
  const out = FALLBACK_PATTERNS.slice();
  try {
    const store = require('./forge-store.cjs');
    for (const re of (store.SECRET_PATTERNS || [])) {
      if (re instanceof RegExp) out.push(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    }
  } catch { /* fallback only */ }
  return out;
}
const PATTERNS = loadPatterns();
function scrub(text) {
  let s = String(text == null ? '' : text);
  for (const re of PATTERNS) { try { s = s.replace(re, '[REDACTED]'); } catch { /* skip */ } }
  return s;
}

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); }

// Parse pass/fail counts from custom ("N passed, M failed"), node:test ("# pass N" / "# fail N"), jest-style summaries.
function parseSummary(text) {
  const t = stripAnsi(text);
  let m, last = null;
  const re = /(\d+)\s+passed\s*,\s*(\d+)\s+failed/gi;
  while ((m = re.exec(t))) last = { passed: +m[1], failed: +m[2] };
  if (last) return last;
  const np = t.match(/^\s*(?:#|ℹ)\s*pass\s+(\d+)\s*$/im), nf = t.match(/^\s*(?:#|ℹ)\s*fail\s+(\d+)\s*$/im);
  if (np && nf) return { passed: +np[1], failed: +nf[1] };
  const jt = t.match(/^\s*Tests:?\s+(.*)$/im);
  if (jt) {
    const p = jt[1].match(/(\d+)\s+passed/i), f = jt[1].match(/(\d+)\s+failed/i);
    if (p || f) return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 };
  }
  return null;
}

// Failing test names + first N lines of each failure block.
function extractFailures(text, maxLines) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:not ok\s+\d+\s*-\s*(.+)|(?:✖|✗|×|FAIL(?:ED)?:?)\s+(.+))$/);
    if (!m) continue;
    const name = (m[1] || m[2] || '').trim();
    if (!name || /^\d+\s+failed/i.test(name)) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && block.length < maxLines; j++) {
      if (/^\s*(?:not ok|ok)\s+\d+/.test(lines[j]) || /^\s*(?:✔|✓|✖|✗|×)\s/.test(lines[j])) break;
      if (lines[j].trim()) block.push(lines[j]);
    }
    out.push({ name, lines: block });
  }
  return out;
}

function parseArgs(argv) {
  const o = { maxFail: 15, logDir: null, timeoutSec: 600, maxLines: 40, cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.cmd = argv.slice(i + 1); break; }
    if (a === '--max-fail-lines') o.maxFail = Math.max(1, parseInt(argv[++i], 10) || 15);
    else if (a === '--log-dir') o.logDir = argv[++i];
    else if (a === '--timeout-sec') o.timeoutSec = Math.max(1, parseFloat(argv[++i]) || 600);
    else if (a === '--max-lines') o.maxLines = Math.max(10, parseInt(argv[++i], 10) || 40);
    else { o.bad = 'unknown option ' + a; break; }
  }
  return o;
}

// WP 2.1 state paths: forge-paths.cjs decides the layout (the opt-in .forge/ folder, else the legacy .claude/forge-*
// folders exactly as before). Guarded: a missing or older forge-paths.cjs keeps the legacy paths and never crashes.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function statePath(root, key, read) {
  const legacy = path.join(root, '.claude', 'forge-' + key);
  if (!forgePaths) return legacy;
  try { return forgePaths.layout(root) !== 'forge' ? legacy : (read ? forgePaths.resolveExisting(root, key) : forgePaths.stateDir(root, key)); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return legacy; }
}

/** defaultLogDir() -> <runs>/_testlogs of this project, or null when no project root is found (plugin copy outside a
 *  project): the full log is then not written, never into the plugin folder. */
function defaultLogDir() {
  const root = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : (forgePaths ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..'));
  return root ? path.join(statePath(root, 'runs'), '_testlogs') : null;
}

function buildReport(o, res, logPath) {
  const full = res.stdout + (res.stderr ? '\n' + res.stderr : '');
  const out = [];
  out.push('command: ' + scrub(o.cmd.join(' ')));
  out.push('exit code: ' + res.code + (res.timedOut ? ' (TIMEOUT after ' + o.timeoutSec + 's, child killed)' : ''));
  out.push('duration: ' + (res.ms / 1000).toFixed(1) + 's');
  const sum = parseSummary(full);
  if (sum) {
    out.push(sum.passed + ' passed, ' + sum.failed + ' failed');
    for (const f of extractFailures(full, o.maxFail)) {
      out.push('FAIL: ' + scrub(f.name));
      for (const l of f.lines) out.push('  ' + scrub(l).slice(0, 200));
    }
  } else {
    out.push('no pass/fail summary could be parsed; tail (last 20 lines):');
    const tail = stripAnsi(full).split(/\r?\n/).filter((l) => l.trim()).slice(-20);
    for (const l of tail) out.push('  ' + scrub(l).slice(0, 200));
  }
  out.push('full log: ' + (logPath || '(not written)'));
  if (out.length > o.maxLines) {
    const keep = out.slice(0, o.maxLines - 2);
    keep.push('... output capped at ' + o.maxLines + ' lines (' + (out.length - keep.length) + ' hidden) ...');
    keep.push(out[out.length - 1]);
    return keep;
  }
  return out;
}

// The per-run temp folder helpers are shared with the doctor's suite pool (one implementation). Without that file
// the command still runs, only without the isolation. suiteEnv also adds core.longpaths=true and
// protocol.file.allow=always through GIT_CONFIG_COUNT env vars, appended to any already present (WP-LONGPATH).
function tmpHelpers() {
  try {
    const h = require('./forge-suite-pool.cjs');
    if (typeof h.makeSuiteTmp === 'function' && typeof h.removeSuiteTmp === 'function' && typeof h.suiteEnv === 'function') return h;
  } catch { /* fall through */ }
  return null;
}

function run(o) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, done = false, timer = null, child;
    let tmp = null, tmpDir = null;
    const finish = (code) => {
      if (done) return; done = true; if (timer) clearTimeout(timer);
      if (tmpDir) tmp.removeSuiteTmp(tmpDir);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - t0 });
    };
    let cmd = o.cmd[0]; const args = o.cmd.slice(1);
    if (cmd === 'node') cmd = process.execPath;
    tmp = tmpHelpers();
    tmpDir = tmp ? tmp.makeSuiteTmp() : null;
    // A wrapped `node --test` must print human-readable text. When this wrapper itself runs under an outer
    // node:test runner (e.g. the GOAT stop gate) the inherited NODE_TEST_CONTEXT makes the child emit the
    // binary v8 reporter stream, which no summary parser can read.
    const childEnv = tmp ? tmp.suiteEnv(process.env, tmpDir) : Object.assign({}, process.env);
    delete childEnv.NODE_TEST_CONTEXT;
    try { child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }); }
    catch (e) { stderr = String(e.message); return finish(127); }
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 20e6) stdout = stdout.slice(-10e6); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20e6) stderr = stderr.slice(-10e6); });
    child.on('error', (e) => { stderr += '\nspawn error: ' + e.message; finish(127); });
    child.on('close', (code) => finish(timedOut ? 124 : (code == null ? 1 : code)));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
      setTimeout(() => finish(124), 2000).unref();
    }, o.timeoutSec * 1000);
  });
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.bad || !o.cmd.length) {
    process.stderr.write((o.bad ? o.bad + '\n' : '') + 'usage: forge-testrun.cjs [--max-fail-lines 15] [--log-dir <dir>] [--timeout-sec N] -- <command> [args...]\n');
    return 2;
  }
  const res = await run(o);
  let logPath = null;
  try {
    const base = o.logDir || defaultLogDir();
    if (!base) throw new Error('no project root found'); // -> the OS temp fallback below, never the script's own folder
    const dir = path.resolve(base);
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'testrun-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log');
    fs.writeFileSync(logPath, scrub('$ ' + o.cmd.join(' ') + '\n\n' + res.stdout + (res.stderr ? '\n--- stderr ---\n' + res.stderr : '')));
  } catch {
    try {
      logPath = path.join(os.tmpdir(), 'forge-testrun-' + process.pid + '.log');
      fs.writeFileSync(logPath, scrub(res.stdout + '\n' + res.stderr));
    } catch { logPath = null; }
  }
  process.stdout.write(buildReport(o, res, logPath).join('\n') + '\n');
  return res.code;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
module.exports = { parseSummary, extractFailures, scrub, parseArgs, buildReport, main };
