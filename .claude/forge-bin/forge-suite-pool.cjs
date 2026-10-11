#!/usr/bin/env node
'use strict';
/**
 * forge-suite-pool.cjs — bounded parallel runner for the doctor's test suites (WP-SPD-C, run
 *). Zero-dependency, Windows-safe. Internal helper of forge-doctor.cjs:
 * runTests() makes ONE spawnSync of this file, so runDoctor() stays synchronous for every caller.
 *
 * What it does, and nothing more:
 *   - reads one JSON job from stdin: {node, root, suites:[absolute paths], order:[indexes], jobs, timeoutMs};
 *   - runs the suites with child_process.spawn, at most `jobs` at a time, in the given `order` (the doctor
 *     passes longest-first), each with cwd = root and the inherited environment — the same spawn the doctor
 *     made before, just several at once — except TEMP/TMP/TMPDIR, which point at a private per-suite folder
 *     (forge-run-<pid>-<n> under os.tmpdir()) that is removed when the suite ends (WP-TMP-HYGIENE), and the
 *     git config core.longpaths=true + protocol.file.allow=always via GIT_CONFIG_COUNT env vars (WP-LONGPATH);
 *   - a suite still running after timeoutMs is killed BY ITS OWN PID (its process tree on Windows via
 *     `taskkill /PID <pid> /T /F`, its process group elsewhere). Never by image name: other node processes on
 *     the machine (the Command Center gateway, other lanes' suites) are never touched;
 *   - prints exactly ONE JSON document on stdout: {results:[...]} in the ORIGINAL suite order (index i is
 *     suites[i]), each {suite, status, signal, timedOut, stdout, stderr, ms}.
 *
 * It judges nothing. status/signal follow spawnSync's shape on purpose: a suite killed for its timeout reports
 * status:null + signal:'SIGTERM' (spawnSync's own timeout kill signal), so the doctor's unchanged
 * `status === null && !!signal` rule still labels it timedOut/blocked. Counting, p>0, the anchored tally line
 * and every other verdict stay in forge-doctor.cjs runTests().
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// After a timeout kill, the time to wait for the suite's pipes to close before they are closed from this side
// (a grandchild that escaped the tree kill could otherwise hold them open for ever).
const KILL_GRACE_MS = 5000;

// WP-TMP-HYGIENE: suites create fixtures with fs.mkdtempSync(os.tmpdir()) and many never remove them
// (325,000 leftover folders, ~21 GB, a full C: drive). Every suite therefore runs with TEMP, TMP and TMPDIR pointing
// at a fresh private folder <os.tmpdir()>/forge-run-<pid>-<n>, which is removed after the suite ends — pass, fail
// or timeout. Only a folder this process created, directly under os.tmpdir() with the forge-run- prefix, is ever
// removed; any other path is refused. Nested runs (a suite that runs the doctor) nest inside the parent folder.
const SUITE_TMP_PREFIX = 'forge-run-';
const RM_RETRIES = 5;
const RM_RETRY_DELAY_MS = 200;
let suiteTmpSeq = 0;

/** makeSuiteTmp(base?) — creates and returns <base>/forge-run-<pid>-<n> (base defaults to os.tmpdir()), or null. */
function makeSuiteTmp(base) {
  const root = base || os.tmpdir();
  for (let attempt = 0; attempt < 100; attempt++) {
    const dir = path.join(root, SUITE_TMP_PREFIX + process.pid + '-' + (++suiteTmpSeq));
    try { fs.mkdirSync(dir); return dir; } catch (e) { if (!e || e.code !== 'EEXIST') return null; }
  }
  return null;
}

/** isSuiteTmp(dir, base?) — true only for a DIRECT child of base (default os.tmpdir()) named forge-run-*. */
function isSuiteTmp(dir, base) {
  if (typeof dir !== 'string' || !dir) return false;
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const target = norm(dir);
  const parent = norm(base || os.tmpdir());
  if (path.dirname(target) !== parent) return false;
  const name = path.basename(target);
  return name.startsWith(SUITE_TMP_PREFIX) && name.length > SUITE_TMP_PREFIX.length;
}

/** removeSuiteTmp(dir, base?) — removes a folder made by makeSuiteTmp; refuses anything else. True when gone. */
function removeSuiteTmp(dir, base) {
  if (!isSuiteTmp(dir, base)) return false;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS }); } catch { /* reported below */ }
  return !fs.existsSync(dir);
}

// WP-LONGPATH: in an installed project that sits ~150 characters deep, suite fixtures run `git add` /
// `git worktree add` at paths over 260 characters and fail with 'Filename too long' unless core.longpaths is on, and
// git >= 2.38 refuses local-file submodules unless protocol.file.allow=always. Neither may be assumed from the
// owner's global config (a clean HOME has neither), so every suite gets them through git's environment config
// (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n) — appended after any entries already present, never
// overwriting them, never writing a git config file. A key the environment already sets is left as it is.
const SUITE_GIT_CONFIG = Object.freeze([['core.longpaths', 'true'], ['protocol.file.allow', 'always']]);

/** withSuiteGitConfig(env) — a copy of env with SUITE_GIT_CONFIG appended to its GIT_CONFIG_COUNT entries. */
function withSuiteGitConfig(env) {
  const out = Object.assign({}, env);
  const raw = out.GIT_CONFIG_COUNT;
  const hasCount = raw !== undefined && String(raw).trim() !== '';
  // A count git itself would reject is left untouched (appending to it could not make it valid).
  if (hasCount && !/^\d+$/.test(String(raw).trim())) return out;
  let count = hasCount ? Number(String(raw).trim()) : 0;
  const present = new Set();
  for (let i = 0; i < count; i++) {
    const k = out['GIT_CONFIG_KEY_' + i];
    if (typeof k === 'string') present.add(k.trim().toLowerCase());
  }
  for (const [key, value] of SUITE_GIT_CONFIG) {
    if (present.has(key.toLowerCase())) continue;
    out['GIT_CONFIG_KEY_' + count] = key;
    out['GIT_CONFIG_VALUE_' + count] = value;
    count++;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

/** suiteEnv(env, dir) — a copy of env with the suite git config (WP-LONGPATH) and TEMP/TMP/TMPDIR set to dir
 *  (temp vars unchanged when dir is null). */
function suiteEnv(env, dir) {
  const out = withSuiteGitConfig(env);
  if (dir) { out.TEMP = dir; out.TMP = dir; out.TMPDIR = dir; }
  return out;
}

function killByPid(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    // By PID, with its tree (/T): only processes this suite started. Never `taskkill /IM`.
    const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    return;
  }
  // The suite was spawned detached = its own process group; a negative PID signals that group only.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
}

function runOne(job, idx, onDone) {
  const file = job.suites[idx];
  const started = Date.now();
  const out = []; const err = [];
  let timedOut = false; let finished = false; let exitCode = null; let exitSignal = null; let spawnError = null;
  let child;
  const tmpDir = makeSuiteTmp();
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); clearTimeout(grace);
    if (tmpDir) removeSuiteTmp(tmpDir);
    const res = {
      suite: file,
      status: timedOut ? null : exitCode,
      signal: timedOut ? (exitSignal || 'SIGTERM') : exitSignal,
      timedOut,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      ms: Date.now() - started,
    };
    if (spawnError) res.error = spawnError;
    onDone(idx, res);
  };
  let timer = null; let grace = null;
  try {
    child = spawn(job.node, [file], {
      cwd: job.root, env: suiteEnv(process.env, tmpDir), windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    spawnError = String(e && e.message || e);
    finish();
    return;
  }
  // spawnSync without `input` hands the child an already-closed stdin; do the same.
  try { child.stdin.end(); } catch { /* ignore */ }
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => err.push(d));
  child.on('error', (e) => { spawnError = String(e && e.message || e); if (!child.pid) finish(); });
  child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });
  child.on('close', (code, signal) => { if (exitCode === null && exitSignal === null) { exitCode = code; exitSignal = signal; } finish(); });
  timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) { timedOut = true; killByPid(child); }
    grace = setTimeout(() => {
      try { child.stdout.destroy(); } catch { /* ignore */ }
      try { child.stderr.destroy(); } catch { /* ignore */ }
      finish();
    }, KILL_GRACE_MS);
  }, job.timeoutMs);
}

function runPool(job, done) {
  const total = job.suites.length;
  const results = new Array(total);
  if (total === 0) { done(results); return; }
  const order = Array.isArray(job.order) && job.order.length === total ? job.order : job.suites.map((_, i) => i);
  const jobs = Math.max(1, Math.floor(Number(job.jobs) || 1));
  let next = 0; let running = 0; let completed = 0;
  const launch = () => {
    while (running < jobs && next < total) {
      const idx = order[next++];
      running++;
      runOne(job, idx, (i, res) => {
        results[i] = res;
        running--; completed++;
        if (completed === total) done(results); else launch();
      });
    }
  };
  launch();
}

function validJob(job) {
  return job && typeof job.node === 'string' && typeof job.root === 'string' && Array.isArray(job.suites)
    && job.suites.every((s) => typeof s === 'string') && Number.isFinite(Number(job.timeoutMs)) && Number(job.timeoutMs) > 0;
}

if (require.main === module) {
  let job = null;
  try { job = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { job = null; }
  if (!validJob(job)) {
    process.stderr.write('forge-suite-pool: invalid job on stdin (need {node, root, suites[], timeoutMs})\n');
    process.exitCode = 2;
  } else {
    job.timeoutMs = Number(job.timeoutMs);
    runPool(job, (results) => {
      process.stdout.write(JSON.stringify({ results }), () => { process.exitCode = 0; });
    });
  }
}

module.exports = { runPool, killByPid, validJob, KILL_GRACE_MS, makeSuiteTmp, isSuiteTmp, removeSuiteTmp, suiteEnv, withSuiteGitConfig, SUITE_GIT_CONFIG, SUITE_TMP_PREFIX };
