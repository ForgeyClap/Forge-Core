'use strict';
/**
 * doctor/checks-core.cjs — one module of forge-doctor.cjs (WP A11 part 2): node_check (in-process parse + node --check), tests (the suite pool / sequential runner), strict_events, dashboard_spa.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { BIN_DIR, DASH_SPA, NODE, claudeDir, listByExt, store } = require('./context.cjs');

// WP-SPD-B: `node --check` cost one process spawn per file (about 315 spawns, 27-67 s per doctor run).
// A `.cjs` file is always CommonJS, so Node compiles it as the body of the module wrapper function
// (exports, require, module, __filename, __dirname) after dropping a BOM and a leading `#!` line. Doing exactly
// that with vm.compileFunction parses the file without running it. compileFunction parses a real function BODY,
// so a file that tries to close the wrapper early (`}); (function () {`) is rejected like `node --check` rejects
// it — a string-wrapped `new vm.Script(Module.wrap(src))` would wrongly accept that. The result is only ever
// used to SKIP a spawn for a file that parses: anything that throws (a SyntaxError or any other error) is
// re-checked by the real `node --check` spawn, so this can never turn a red file green or change its error text.
const vm = require('vm');
const CJS_WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];
function syntaxCheckInProcess(file) {
  try {
    let src = fs.readFileSync(file, 'utf8');
    // A BOM is dropped; a `#!` line only counts at the very first byte (measured: Node rejects BOM + `#!`).
    // compileFunction itself would accept that `#!`, so that shape is left to the real spawn to judge.
    if (src.charCodeAt(0) === 0xFEFF) {
      src = src.slice(1);
      if (src.startsWith('#!')) return { ok: false, error: 'BOM followed by #! — left to node --check' };
    } else if (src.startsWith('#!')) src = src.replace(/^#![^\r\n]*/, ''); // keep the line break: line numbers stay right
    vm.compileFunction(src, CJS_WRAPPER_PARAMS, { filename: file });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 1) node --check on all dashboard/bin sources
// Honesty fix: 0 files checked is NEVER a silent pass. Distinguish "the dirs are genuinely
// both absent" (still a real problem for a project that's supposed to have forge-bin/) from "a dir exists
// but yielded nothing" — both are `ok:false` with an explicit `reason`, never a vacuous green.
/** listByExtDeep(dir, exts) -> sorted files with one of exts in dir and every sub-folder below it, never node_modules
 *  and never through a symlink. */
function listByExtDeep(dir, exts) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p);
      else if (e.isFile() && exts.includes(path.extname(e.name))) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
function nodeCheckAll(root) {
  const cd = claudeDir(root);
  const binDir = path.join(cd, 'forge-bin');
  const dashDir = path.join(cd, 'forge-dashboard');
  // 2026-11-07 (category tests F5c): forge-bin is walked into its sub-folders (forge-bin/doctor/ since the 2026-11-02
  // split). forge-sync install trusts this check only when total >= the .cjs files it wrote, so a top-level-only list
  // rolled back every fresh install. node_modules is never walked.
  const files = [
    ...listByExtDeep(binDir, ['.cjs']),
    ...listByExt(dashDir, ['.cjs', '.js']),
  ];
  const failures = [];
  let spawned = 0;
  for (const f of files) {
    // WP-SPD-B: a `.cjs` that parses in-process is accepted without a spawn. Everything else — a `.js` (its module
    // type depends on package.json) and any `.cjs` the in-process parse rejects or cannot judge — still goes to the
    // real `node --check`, and only THAT result is reported, so a failure and its error text are exactly as before.
    if (path.extname(f) === '.cjs' && syntaxCheckInProcess(f).ok) continue;
    spawned++;
    const r = spawnSync(NODE, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) failures.push({ file: path.relative(root, f), error: (r.stderr || '').split('\n')[0] });
  }
  let ok = failures.length === 0;
  let reason = '';
  if (files.length === 0) {
    ok = false; // no evidence is not a pass, regardless of why
    reason = (!fs.existsSync(binDir) && !fs.existsSync(dashDir))
      ? 'no evidence: forge-bin/ and forge-dashboard/ are both missing'
      : 'no evidence: 0 files checked (dir present but empty or unreadable)';
  }
  return { total: files.length, failed: failures.length, ok, failures, reason, spawned };
}

// 2) run every *.test.cjs and tally
// Honesty fixes: (a) a suite must report at least one REAL passing assertion (p > 0) to count
// as ok — "0 passed, 0 failed" is a vacuous/short-circuited suite, not proof; (b) 0 suites found is never a
// silent pass — same "no evidence" treatment as nodeCheckAll; (c) a suite that hits the spawn timeout is
// labeled `timedOut:true` / `blocked`, never lumped in with a real failure.
// WP-SPD-A: 300 s -> 600 s. The heaviest suite (forge-sync.test) was measured at 319 s and 438 s on a
// loaded maintainer PC, so 300 s turned a busy machine into a `blocked` doctor with nothing broken. A suite that
// hits this limit is still timedOut/blocked, never a pass; FORGE_DOCTOR_SUITE_TIMEOUT_MS still overrides it.
// WP-LIMITS: 600 s -> 1500 s. forge-sync.test grew to ~1550 assertions with an isolated TEMP and
// needs about 750 s alone; under load the 600 s default left only ~43 s headroom. Same semantics: a suite that
// hits the limit is timedOut/blocked, never a pass, and the env override still wins.
const DOCTOR_SUITE_TIMEOUT_MS = 1500000;
// a failing suite names its failing tests in the evidence. On 2026-09-27 one gate-hook test failed
// once inside a release gate and could not be identified, because perSuite held counts only. A failure line is what
// a suite's own harness prints for it: this project's `  FAIL <name>`, or node:test's `not ok` / a cross mark. At most
// FAIL_NAMES_MAX lines of FAIL_NAME_MAX_CHARS each, redacted by forge-store, so a noisy suite cannot bloat the report.
const FAIL_LINE_RE = /^\s*(?:FAIL\b|not ok\b|\u2716|\u2717)/;
const FAIL_NAMES_MAX = 5;
const FAIL_NAME_MAX_CHARS = 200;
function failingTestNames(out) {
  // redactValue() on a bare string only ever runs the pattern-shaped SECRET_PATTERNS
  // pass \u2014 its key-name heuristic (SECRET_KEY_RE) only matches OBJECT KEYS, so a failing test line like
  // "FAIL test password=hunter2" (a fixture printing a labelled secret in its own failure description) kept
  // the value. redactText() adds the missing key=value scan on top of the same SECRET_PATTERNS pass.
  return String(out || '').split(/\r?\n/).filter((l) => FAIL_LINE_RE.test(l))
    .slice(0, FAIL_NAMES_MAX).map((l) => String(store.redactText(l.trim())).slice(0, FAIL_NAME_MAX_CHARS));
}

// WP-SPD-C: the suites run in a bounded pool instead of one after another. runTests() makes ONE
// spawnSync of forge-suite-pool.cjs (so runDoctor() stays synchronous for its ~60 callers); the helper runs at most
// `jobs` suites at a time, longest-first, kills a suite that overruns its limit by its own PID only, and returns the
// raw {status, signal, stdout, stderr} per suite in the original (name-sorted) order. Every verdict — the anchored
// tally, p>0, exit 0, timedOut = blocked, 0 suites = no evidence — is still made below, by the same code, on the
// same fields. FORGE_DOCTOR_JOBS=1 (or a single suite, or a missing/broken helper) is the exact old sequential path.
const DOCTOR_SUITE_JOBS = 4;
const SUITE_POOL_FILE = path.join(BIN_DIR, 'forge-suite-pool.cjs');
// Durations of earlier runs, only to order the next run longest-first. A hint, never evidence: it lives in the OS
// temp folder (never in a project), a missing or corrupt file just means "no hint", and at most
// SUITE_DURATIONS_MAX_ROOTS project roots are kept.
const SUITE_DURATIONS_FILE = path.join(os.tmpdir(), 'forge-doctor-suite-durations.json');
const SUITE_DURATIONS_MAX_ROOTS = 20;
function resolveSuiteJobs(opts) {
  const fromOpts = opts && Number.isFinite(opts.jobs) ? opts.jobs : NaN;
  const fromEnv = Number(process.env.FORGE_DOCTOR_JOBS);
  const n = Number.isFinite(fromOpts) && fromOpts >= 1 ? fromOpts : (Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : DOCTOR_SUITE_JOBS);
  return Math.max(1, Math.floor(n));
}
function suiteRootKey(root) {
  let r = path.resolve(root);
  if (process.platform === 'win32') r = r.toLowerCase();
  return crypto.createHash('sha256').update(r).digest('hex').slice(0, 16);
}
function readSuiteDurations(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch { return {}; }
}
/** suiteOrder(root, tests, file) — indexes of `tests`, longest-first. A suite with a recorded duration is ordered by
 *  it; a suite without one goes first (it may be long), largest file first. Ties keep name order. */
function suiteOrder(root, tests, file) {
  const known = (readSuiteDurations(file)[suiteRootKey(root)] || {}).ms || {};
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const keyed = tests.map((t, i) => {
    const ms = Number(known[path.basename(t)]);
    return { i, known: Number.isFinite(ms) && ms >= 0, ms: Number.isFinite(ms) ? ms : 0, size: size(t) };
  });
  keyed.sort((a, b) => (a.known === b.known ? 0 : (a.known ? 1 : -1))
    || (a.known ? b.ms - a.ms : b.size - a.size) || a.i - b.i);
  return keyed.map((k) => k.i);
}
function writeSuiteDurations(root, tests, results, file) {
  try {
    const all = readSuiteDurations(file);
    const ms = {};
    tests.forEach((t, i) => { if (results[i] && Number.isFinite(results[i].ms)) ms[path.basename(t)] = results[i].ms; });
    all[suiteRootKey(root)] = { at: Date.now(), ms };
    const keep = Object.entries(all).filter(([, v]) => v && typeof v === 'object')
      .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, SUITE_DURATIONS_MAX_ROOTS);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)));
    fs.renameSync(tmp, file);
  } catch { /* a hint only: failing to save it never affects a doctor verdict */ }
}
/** runSuitesPooled — {results} (raw per-suite spawn results in the order of `tests`) or {results:null, error}. */
function runSuitesPooled(root, tests, timeoutMs, jobs, opts) {
  const poolFile = (opts && opts.poolFile) || SUITE_POOL_FILE;
  const durationsFile = (opts && opts.durationsFile) || SUITE_DURATIONS_FILE;
  if (!fs.existsSync(poolFile)) return { results: null, error: 'suite pool helper missing: ' + path.basename(poolFile) };
  const job = { node: NODE, root, suites: tests, order: suiteOrder(root, tests, durationsFile), jobs, timeoutMs };
  // Backstop only: every suite already has its own limit inside the helper (plus a short kill grace), so the whole
  // pool is bounded by about (suites / jobs + 1) limits.
  const backstopMs = (Math.ceil(tests.length / jobs) + 1) * (timeoutMs + 10000) + 30000;
  const r = spawnSync(NODE, [poolFile], { input: JSON.stringify(job), encoding: 'utf8', timeout: backstopMs, maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
  const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  const shapeOk = !!results && results.length === tests.length
    && results.every((x, i) => x && x.suite === tests[i] && typeof x.stdout === 'string' && typeof x.stderr === 'string');
  if (r.status !== 0 || !shapeOk) {
    return { results: null, error: 'suite pool failed (status ' + r.status + (r.signal ? ', signal ' + r.signal : '') + '): ' + String(r.stderr || (r.error && r.error.message) || 'no valid result').split('\n')[0].slice(0, 200) };
  }
  writeSuiteDurations(root, tests, results, durationsFile);
  return { results };
}

// WP-TMP-HYGIENE: the sequential path isolates the temp folder exactly like the pool does — TEMP, TMP
// and TMPDIR point at a private forge-run-<pid>-<n> folder under os.tmpdir() that is removed after the suite ends,
// whatever the outcome. The helpers live in forge-suite-pool.cjs (one implementation); if that file is missing the
// suite still runs, only without the isolation. WP-LONGPATH: the same suiteEnv also hands every
// sequential suite core.longpaths=true + protocol.file.allow=always through GIT_CONFIG_COUNT env vars (appended to
// any already present, no git config file written), exactly as the pool does.
function suiteTmpHelpers() {
  try {
    const h = require(SUITE_POOL_FILE);
    if (typeof h.makeSuiteTmp === 'function' && typeof h.removeSuiteTmp === 'function' && typeof h.suiteEnv === 'function') return h;
  } catch { /* fall through */ }
  return null;
}
function runSuiteSequential(file, root, timeoutMs) {
  const h = suiteTmpHelpers();
  const tmpDir = h ? h.makeSuiteTmp() : null;
  try {
    return spawnSync(NODE, [file], { encoding: 'utf8', timeout: timeoutMs, cwd: root, env: h ? h.suiteEnv(process.env, tmpDir) : process.env });
  } finally {
    if (h && tmpDir) h.removeSuiteTmp(tmpDir);
  }
}

function runTests(root, opts) {
  // timeoutMs is test-only-overridable so a hermetic test can prove the timedOut/blocked classification
  // against a REAL spawnSync timeout in milliseconds instead of waiting minutes or faking the spawnSync
  // return shape. (fresh-laptop simulation): the default was 120 s, but the heaviest suite (the gate
  // hook, hundreds of real hook spawns) already takes ~95 s on the maintainer's PC — a slower laptop or a busy
  // CI runner crossed the line and the doctor went red with nothing broken. Default was raised to 300 s and, in
  // WP-SPD-A, to 600 s, and in WP-LIMITS to 1500 s (a genuinely hung suite is still caught), and
  // FORGE_DOCTOR_SUITE_TIMEOUT_MS overrides it.
  const envTimeout = Number(process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS);
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DOCTOR_SUITE_TIMEOUT_MS);
  const dir = path.join(claudeDir(root), 'forge-bin');
  const dirExists = fs.existsSync(dir);
  const tests = listByExt(dir, ['.cjs']).filter((f) => f.endsWith('.test.cjs'));
  const perSuite = []; let passed = 0, failed = 0, suitesFailed = 0, suitesBlocked = 0;
  // WP-SPD-C: run the suites in the pool when it can help (more than one suite and jobs > 1). Its raw results are
  // read by the unchanged loop below in name order; if the pool cannot deliver, the old sequential spawn runs.
  const jobs = resolveSuiteJobs(opts);
  const pooled = (jobs > 1 && tests.length > 1) ? runSuitesPooled(root, tests, timeoutMs, jobs, opts) : null;
  const pooledResults = pooled ? pooled.results : null;
  for (let ti = 0; ti < tests.length; ti++) {
    const t = tests[ti];
    // (found by the Test Boss on the published): the suite runs with the root being checked as
    // its working folder. Without it `--root <dir>` inherited the caller's folder, and suites that resolve a
    // relative target against process.cwd() (the gate hook's scratch rule) reported false failures. The pool
    // spawns each suite with the same cwd, inherited environment and limit.
    const r = pooledResults ? pooledResults[ti] : runSuiteSequential(t, root, timeoutMs);
    // spawnSync sets status:null + a kill signal (verified: SIGTERM on Windows, r.error may also carry an
    // ETIMEDOUT message) when the timeout fires; treat any status:null+signal combo as "blocked", not
    // "failed" — it never actually finished running.
    const timedOut = r.status === null && !!r.signal;
    const out = ((r.stdout || '') + (r.stderr || ''));
    // Robust tally extraction (FOLLOWUP A): the previous /(\d+)\s+passed,\s+(\d+)\s+failed/ had
    // no anchor and no /g flag, so it matched the FIRST occurrence anywhere in combined stdout+stderr —
    // including a phrase inside a test DESCRIPTION that a suite's own harness happens to echo (e.g.
    // "  ok  reports 0 passed, 0 failed when empty"), long before the suite's real trailing tally line. This
    // already caused one real false-negative (forge-chaos.test.cjs briefly read as 0/0 — fixed there by
    // renaming the colliding description, but the underlying regex class bug remained). Fix: only accept a
    // match where the digits are the FIRST thing on their line (anchor `^\s*` with the `m` flag) — a genuine
    // tally is always printed at the very start of its own line (see this file's own final
    // `console.log(pass + ' passed, ' + fail + ' failed')`), so a description embedded mid-line — prefixed by
    // "  ok  " / "  FAIL " or any other text before the digits — can never satisfy the anchor. Deliberately
    // NOT anchored at the line's END too: a real sibling suite (forge-learn.test.cjs, archived by A6 2026-11-02, still in archive/) legitimately prints
    // "N passed, M failed, K skipped" — extra trailing content on the same summary line is normal and must
    // still be read correctly (`\b` after "failed" instead of `$` — proven by re-running this exact fix
    // against the real project's full suite battery, not just a hand-written fixture). Take the LAST such
    // anchored match (not the first) as belt-and-suspenders, since the genuine summary is always the final
    // thing a suite prints.
    const TALLY_RE = /^\s*(\d+)\s+passed,\s+(\d+)\s+failed\b/gm;
    let m = null, tm;
    while ((tm = TALLY_RE.exec(out)) !== null) m = tm;
    const p = m ? Number(m[1]) : 0, f = m ? Number(m[2]) : 0;
    const suiteOk = !timedOut && r.status === 0 && f === 0 && !!m && p > 0;
    if (timedOut) suitesBlocked++;
    else if (!suiteOk) suitesFailed++;
    passed += p; failed += f;
    const entry = { suite: path.basename(t), passed: p, failed: f, ok: suiteOk, timedOut };
    if (!suiteOk && !timedOut) { const names = failingTestNames(out); if (names.length) entry.failures = names; }
    if (timedOut && r.signal) entry.signal = r.signal;
    perSuite.push(entry);
  }
  let ok = suitesFailed === 0 && suitesBlocked === 0;
  let reason = '';
  if (tests.length === 0) {
    ok = false; // no evidence is not a pass
    reason = dirExists ? 'no evidence: 0 test suites found in forge-bin/ (dir present but empty)' : 'no evidence: forge-bin/ dir missing';
  }
  const res = { suites: tests.length, suitesFailed, suitesBlocked, passed, failed, ok, perSuite, reason,
    runner: pooledResults ? 'pool' : 'sequential', jobs: pooledResults ? jobs : 1 };
  // A pool that could not deliver is said out loud; the suites then ran sequentially (the verdict above).
  if (pooled && !pooledResults) res.poolError = pooled.error;
  return res;
}

// 3) strict-event honesty gate still rejects unknown types
// WP-CC0 (Command Center audit): this used to spawn `root`'s REAL log-event.cjs directly, writing
// 'doctor-selfcheck-<pid>/events.jsonl' straight into the REAL project's .claude/forge-runs/ and relying
// on a best-effort fs.rmSync to clean it up afterward. On Windows that rm can lose a race (the file the
// child process just wrote can still be momentarily locked — by AV scanning or the OS itself), so a
// doctor run repeated many times over a project's life leaves a 'doctor-selfcheck-<pid>' folder behind
// every time the race is lost — measured as real debris across multiple projects (this is the exact
// pattern forge-toolhook.cjs's own header comment and forge-snapshot.cjs's pickRun() doc comment already
// describe as "Doctor creates those constantly"). Fix: copy the SAME script bytes (never a
// reimplementation — see this file's own module-API contract) into a throwaway OS-tmp '.claude/
// forge-dashboard/log-event.cjs' and run the COPY there instead. This still proves the real shipped
// script's real behavior (verifyEvent()/KNOWN_EVENT_TYPES are read from the exact same file bytes); it
// just never touches the project being checked, so a lost cleanup race can only litter the OS temp
// folder, never a real project's forge-runs/.
function strictEventCheck(root) {
  const sourceLogEvent = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-selfcheck-'));
    const fixtureDash = path.join(tmp, '.claude', 'forge-dashboard');
    fs.mkdirSync(fixtureDash, { recursive: true });
    fs.copyFileSync(sourceLogEvent, path.join(fixtureDash, 'log-event.cjs'));
    const logEvent = path.join(fixtureDash, 'log-event.cjs');
    const rid = 'doctor-selfcheck';
    const good = spawnSync(NODE, [logEvent, rid, 'agent_progress', '{"agent":"orchestrator","note":"doctor self-check"}'], { encoding: 'utf8' });
    const bad = spawnSync(NODE, [logEvent, rid, 'zzz_bogus_type', '{"agent":"orchestrator"}'], { encoding: 'utf8' });
    const ok = good.status === 0 && bad.status === 2;
    return { ok, known_accepted: good.status === 0, unknown_rejected: bad.status === 2, good_status: good.status, bad_status: bad.status };
  } catch (e) {
    // No log-event.cjs at this root (a minimal/foreign project) or the tmp fixture could not be built —
    // fail closed, exactly as before when spawnSync hit a missing script (status stayed null either way).
    return { ok: false, known_accepted: false, unknown_rejected: false, good_status: null, bad_status: null, reason: 'could not run an isolated self-check: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup of an OS-tmp dir — never the real project */ } }
  }
}

// 4) dashboard SPA files —: the retired per-project Control Center (server.cjs + its 6 static
// SPA files) was REMOVED from the template. ABSENT is now the healthy state; forge-sync's
// pruneRetiredFiles() cleans an older install's leftovers automatically once they are unmodified. `ok`
// stays true EITHER WAY — this can never fail a doctor run; PRESENT is advisory only (a project that
// simply has not synced since upgrading), reported via `present`, never via a `missing` list anymore.
function spaPresent(root) {
  const dir = path.join(claudeDir(root), 'forge-dashboard');
  const present = DASH_SPA.filter((f) => fs.existsSync(path.join(dir, f)));
  return { ok: true, present, stale: present.length > 0 };
}

module.exports = {
  CJS_WRAPPER_PARAMS, syntaxCheckInProcess, nodeCheckAll, DOCTOR_SUITE_TIMEOUT_MS, FAIL_LINE_RE, FAIL_NAMES_MAX,
  FAIL_NAME_MAX_CHARS, failingTestNames, DOCTOR_SUITE_JOBS, SUITE_POOL_FILE, SUITE_DURATIONS_FILE,
  SUITE_DURATIONS_MAX_ROOTS, resolveSuiteJobs, suiteRootKey, readSuiteDurations, suiteOrder, writeSuiteDurations,
  runSuitesPooled, suiteTmpHelpers, runSuiteSequential, runTests, strictEventCheck, spaPresent,
};
