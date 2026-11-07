#!/usr/bin/env node
'use strict';
/**
 * forge-rotator-supervisor.cjs - PATH A of the account rotator (work packages R.2+R.3): run ONE headless
 * Claude Code job to completion across usage limits, on ONE account. It never switches accounts.
 *
 * WHY: interactive Claude Code already waits out a usage limit and continues by itself (`autoContinueAtUsageLimit`,
 * default on since v2.1.234). `claude -p`, the Agent SDK, background sessions and the Command Center gateway do not:
 * the run just fails. This wrapper closes that gap for `-p` jobs:
 *   1. spawn  claude -p <prompt> --output-format json [owner args]       (binary injectable for tests)
 *   2. read session_id from the JSON result; detect a limit from the StopFailure marker written by
 *      forge-rotator-hook.cjs for THIS session, or from a recognised error class in the result / stderr
 *   3. wait until the reset time (marker -> result text -> bounded backoff: 15 min + up to 10% load-spreading jitter,
 *      at most `rotator-max-waits` waits), inside a total wall-clock cap
 *   4. relaunch  claude -p "continue" --resume <session_id> --output-format json [owner args]   (fallback --continue)
 *   5. stop after `rotator-max-attempts` launches. Every step lands in a token-free JSON status file the dashboard
 *      can read: <runs>/_rotator/supervisor-<job>.json
 * Waiting and relaunching happen only while the owner setting `rotator-auto-resume` is on (default OFF); when off,
 * a limit ends the job with outcome `limit-hit:auto-resume-off` and the manual resume command.
 *
 * SAFETY: the child inherits this process's environment UNCHANGED (spawn gets no `env` option); this file reads
 * only the allowlisted variables in ENV_NAMES, never a login variable, never the account vault, and requires no
 * account-rotator-*.cjs module. Processes are stopped only by the exact PID this file spawned. The prompt, the
 * owner's args and the child's output are never written to disk.
 * Windows: claude.exe is spawned directly; a .cmd/.bat shim goes through cmd.exe /d /v:off /s /c with every word
 * quoted and unsafe words REFUSED, never escaped; a .ps1 shim is refused (rules copied from
 * account-rotator-token.cjs::cmdArgsUnsafe/cmdWrapperArgv/binUnsafe, which Path A deliberately does not load).
 * SIGINT/SIGTERM/SIGBREAK, or `stop --job <id>`, end the job: no relaunch, the child gets a grace period, then its
 * exact PID tree is ended. Exit codes: 0 completed, 1 failed, 2 usage, 3 refused, 4 gave up / limit hit, 130 stopped.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const toolhook = require('./forge-toolhook.cjs');
const hook = require('./forge-rotator-hook.cjs');

const STATUS_SCHEMA = 'forge-rotator-supervisor/1';
const DEFAULTS = Object.freeze({ maxAttempts: 8, maxWaits: 6, maxWallMs: 24 * 3600e3, continuePrompt: 'continue' });
const LIMITS = Object.freeze({ attempts: [1, 30], waits: [1, 24], hours: [1, 168] });
const BACKOFF_MS = 15 * 60e3;
const OVERLOAD_BASE_MS = 60e3;
const JITTER = 0.1;
const MARGIN_MS = 90e3;
const MIN_WAIT_MS = 30e3;
const CHUNK_MS = 15e3;
const HEARTBEAT_MS = 60e3;
const POLL_MS = 2000;
const GRACE_MS = 10e3;
const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MAX_HISTORY = 20;
const MAX_PROMPT = 100000;
const ENV_NAMES = Object.freeze(['FORGE_ROTATOR_CLAUDE_BIN', 'PATH', 'Path', 'FORGE_STATE_DIR', 'ComSpec']);
const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_RE = /^(-p|--print|--output-format|--resume|-r|--continue|-c|--session-id|--fork-session|--input-format)(=|$)/;
const EXIT = Object.freeze({ completed: 0, failed: 1, usage: 2, refused: 3, gaveUp: 4, stopped: 130 });
const FATAL_RE = /spend limit|shared budget|individual usage limit|credit balance|usage credits required|billing|authentication|unauthori[sz]ed|invalid api key|not logged in|\/login|account (is )?on hold|not allowed for this organi[sz]ation/i;
const RATE_RE = /hit your (session|weekly|opus|sonnet|fable|haiku) limit|usage limit reached|claude ai usage limit|rate[ _-]?limit|too many requests|request rejected \(429\)|(error|status|http|api)[^\n]{0,20}\b429\b/i;
const OVER_RE = /overloaded|(error|status|http|api)[^\n]{0,20}\b529\b|high load|temporarily limiting requests|at capacity/i;
const NOT_FOUND_RE = /no conversation found|(session|conversation)[^\n]{0,40}not found|could not find (a |the )?(session|conversation)/i;

function envGet(deps, name) {
  if (!ENV_NAMES.includes(name)) throw new Error('supervisor: env read outside the allowlist refused');
  const v = (deps.env || process.env)[name];
  return typeof v === 'string' ? v : undefined;
}
function stateEnv(deps) { const v = envGet(deps, 'FORGE_STATE_DIR'); return v ? { FORGE_STATE_DIR: v } : {}; }

// ---- argument safety (rules copied from account-rotator-token.cjs; see header) ----------------------------------
function cmdArgsUnsafe(args) {
  if (args.some((a) => typeof a !== 'string')) return 'a non-string argument';
  if (args.some((a) => /[%!"\r\n\0]/.test(a))) return 'arguments with % ! " or a newline';
  if (args.some((a) => /\\$/.test(a))) return 'an argument ending in a backslash (it would escape the closing quote)';
  return null;
}
function binUnsafe(bin) {
  if (typeof bin !== 'string' || !bin.trim()) return 'no launcher path';
  if (/\.ps1$/i.test(bin)) return 'a PowerShell shim (.ps1) cannot be launched directly - point --claude or FORGE_ROTATOR_CLAUDE_BIN at claude.exe or claude.cmd';
  if (/[\r\n\0]/.test(bin)) return 'a launcher path with a newline';
  return null;
}
/** launchPlan(bin, args, platform, comspec) -> {cmd, argv, verbatim} | {refused}. Pure. */
function launchPlan(bin, args, platform, comspec) {
  const badBin = binUnsafe(bin);
  if (badBin) return { refused: badBin };
  if (args.some((a) => typeof a !== 'string' || a.includes('\0'))) return { refused: 'a non-string argument or a NUL byte' };
  if (/\.(c|m)?js$/i.test(bin)) return { cmd: process.execPath, argv: [bin, ...args], verbatim: false };
  if ((platform || process.platform) === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const bad = cmdArgsUnsafe([bin, ...args]);
    if (bad) return { refused: bad + ' cannot be passed safely through a .cmd shim - install the native claude.exe or point --claude at it' };
    return { cmd: comspec || 'cmd.exe', argv: ['/d', '/v:off', '/s', '/c', '"' + [bin, ...args].map((a) => '"' + a + '"').join(' ') + '"'], verbatim: true };
  }
  return { cmd: bin, argv: args.slice(), verbatim: false };
}
function resolveBin(o, deps) {
  if (o.bin) return o.bin;
  const fromEnv = envGet(deps, 'FORGE_ROTATOR_CLAUDE_BIN');
  if (fromEnv) return fromEnv;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(envGet(deps, 'PATH') || envGet(deps, 'Path') || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const p = path.join(dir, 'claude' + e); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}
/** validateJob(o) -> error text | null: prompt + owner args that this wrapper can pass on safely. */
function validateJob(o) {
  for (const [label, p] of [['prompt', o.prompt], ['continue prompt', o.continuePrompt]]) {
    if (typeof p !== 'string' || !p.trim() || p.length > MAX_PROMPT || p.includes('\0')) return 'the ' + label + ' must be 1-' + MAX_PROMPT + ' characters without NUL bytes';
    if (p.startsWith('-')) return 'the ' + label + ' must not start with "-" (it would be read as a flag)';
  }
  for (const a of o.extraArgs) {
    if (typeof a !== 'string' || a.includes('\0')) return 'every claude argument must be a string without NUL bytes';
    if (RESERVED_RE.test(a) || /^-[A-Za-z]*[prc][A-Za-z]*$/.test(a)) return 'the supervisor sets -p, --output-format, --resume and --continue itself; remove "' + a.slice(0, 40) + '"';
  }
  return null;
}
/** buildArgs(mode, o, sessionId) -> the exact claude argv for one launch. */
function buildArgs(mode, o, sessionId) {
  if (mode === 'resume') return ['-p', o.continuePrompt, '--resume', sessionId, '--output-format', 'json', ...o.extraArgs];
  if (mode === 'continue') return ['-p', o.continuePrompt, '--continue', '--output-format', 'json', ...o.extraArgs];
  return ['-p', o.prompt, '--output-format', 'json', ...o.extraArgs];
}

// ---- spawning (real) ------------------------------------------------------------------------------------------
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
      return;
    } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}
/** spawnRun(bin, args, o) -> Promise<{code, stdout, stderr, aborted, pid} | {refused}>. o: cwd, signal, graceMs,
 *  onSpawn(pid), comspec. No `env` option: the child inherits this process's environment unchanged. */
function spawnRun(bin, args, o) {
  const plan = launchPlan(bin, args, process.platform, o.comspec);
  if (plan.refused) return Promise.resolve({ refused: plan.refused });
  return new Promise((resolve) => {
    let child;
    try { child = spawn(plan.cmd, plan.argv, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: plan.verbatim }); } catch { resolve({ code: 127, stdout: '', stderr: '', aborted: false, pid: null }); return; }
    let out = '', err = '', aborted = false, graceTimer = null;
    child.stdout.on('data', (c) => { if (out.length < MAX_STDOUT) out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { if (err.length < MAX_STDERR) err += c.toString('utf8'); });
    const onAbort = () => {
      aborted = true;
      if (process.platform !== 'win32') { try { child.kill('SIGINT'); } catch { /* gone */ } }
      graceTimer = setTimeout(() => killTree(child), Number.isFinite(o.graceMs) ? o.graceMs : GRACE_MS);
    };
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    if (o.onSpawn) o.onSpawn(child.pid, (now) => { if (now) killTree(child); });
    child.on('error', () => { if (graceTimer) clearTimeout(graceTimer); resolve({ code: 127, stdout: out, stderr: err, aborted, pid: child.pid || null }); });
    child.on('close', (code) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      resolve({ code: code === null ? 1 : code, stdout: out, stderr: err, aborted, pid: child.pid });
    });
  });
}
function realSleep(ms, signal) {
  return new Promise((res) => {
    if (signal && signal.aborted) { res(); return; }
    const t = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); res(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

// ---- result parsing + classification (text is read in memory only) --------------------------------------------
function parseResult(stdout) {
  const s = typeof stdout === 'string' ? stdout.trim() : '';
  if (!s) return null;
  for (const cand of [s, s.split(/\r?\n/).filter(Boolean).pop()]) {
    try { const j = JSON.parse(cand); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch { /* next */ }
  }
  return null;
}
function sessionOf(parsed) {
  const sid = parsed && parsed.session_id;
  return typeof sid === 'string' && toolhook.sessionBucket(sid) === sid ? sid : null;
}
function haystack(r, parsed) {
  const p = parsed || {};
  return [p.result, p.error, p.subtype, r.stderr].filter((x) => typeof x === 'string').join('\n').slice(0, 20000);
}
/** classify(r, parsed, marker) -> {cls, source}. cls: success|rate_limit|overloaded|fatal|resume-not-found|failed|interrupted. */
function classify(r, parsed, marker) {
  if (r.aborted) return { cls: 'interrupted', source: null };
  if (r.code === 0 && !(parsed && parsed.is_error === true)) return { cls: 'success', source: null };
  if (marker) return { cls: marker.matcher, source: 'marker' };
  const p = parsed || {};
  if (p.api_error_status === 429) return { cls: 'rate_limit', source: 'result' };
  if (p.api_error_status === 529) return { cls: 'overloaded', source: 'result' };
  if (hook.MATCHERS.includes(p.error)) return { cls: p.error, source: 'result' };
  const hay = haystack(r, parsed);
  if (FATAL_RE.test(hay)) return { cls: 'fatal', source: 'text' };
  if (RATE_RE.test(hay)) return { cls: 'rate_limit', source: 'text' };
  if (OVER_RE.test(hay)) return { cls: 'overloaded', source: 'text' };
  if (NOT_FOUND_RE.test(hay)) return { cls: 'resume-not-found', source: 'text' };
  return { cls: 'failed', source: null };
}
function backoffMs(cls, waitIndex, rnd) {
  const base = cls === 'overloaded' ? Math.min(BACKOFF_MS, OVERLOAD_BASE_MS * 2 ** waitIndex) : BACKOFF_MS;
  const j = Math.min(1, Math.max(0, Number(rnd()) || 0));
  return Math.round(base * (1 + JITTER * j));
}

// ---- settings + status -------------------------------------------------------------------------------------
function clampInt(v, [lo, hi], fb) { return Number.isInteger(v) && v >= lo && v <= hi ? v : fb; }
function resolveSettings(o, deps, root) {
  const read = (k, fb) => toolhook.configRead(k, fb, { projectRoot: root, configModule: deps.configModule });
  const ar = read('rotator-auto-resume', false);
  return {
    autoResume: ar.value === true,
    configNote: ar.degraded ? ar.reason : null,
    maxAttempts: clampInt(o.maxAttempts !== undefined ? o.maxAttempts : read('rotator-max-attempts', DEFAULTS.maxAttempts).value, LIMITS.attempts, DEFAULTS.maxAttempts),
    maxWaits: clampInt(o.maxWaits !== undefined ? o.maxWaits : read('rotator-max-waits', DEFAULTS.maxWaits).value, LIMITS.waits, DEFAULTS.maxWaits),
    maxWallMs: Number.isFinite(o.maxWallMs) && o.maxWallMs > 0 ? o.maxWallMs : DEFAULTS.maxWallMs,
  };
}
function jobFile(root, job, deps, ext) { return path.join(hook.rotatorDir(root, stateEnv(deps)), 'supervisor-' + job + ext); }
function iso(t) { return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function newJobId(now) { return 'sv-' + new Date(now).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + process.pid; }

/** supervise(o, deps) -> Promise<{outcome, exitCode, status}>.
 *  o: root, prompt, extraArgs[], continuePrompt, job, bin, maxAttempts, maxWaits, maxWallMs.
 *  deps (all optional): now, sleep(ms, signal), spawnRun, random, env, configModule, signals, out, log, chunkMs, pollMs, graceMs, comspec. */
async function supervise(o, deps) {
  deps = deps || {};
  const now = deps.now || Date.now;
  const sleep = deps.sleep || realSleep;
  const run = deps.spawnRun || spawnRun;
  const log = deps.log || ((s) => process.stderr.write('[rotator-supervisor] ' + s + '\n'));
  const job = Object.assign({ extraArgs: [], continuePrompt: DEFAULTS.continuePrompt }, o);
  const root = path.resolve(job.root || process.cwd());
  const bad = validateJob(job) || (job.job !== undefined && !JOB_RE.test(job.job) ? 'the job id must be 1-64 letters, digits, _ or -' : null);
  if (bad) return { outcome: 'usage', exitCode: EXIT.usage, status: null, error: bad };
  const S = resolveSettings(job, deps, root);
  const t0 = now();
  const id = job.job || newJobId(t0);
  let file, stopFile;
  try { file = jobFile(root, id, deps, '.json'); stopFile = jobFile(root, id, deps, '.stop'); } catch (e) {
    return { outcome: 'refused', exitCode: EXIT.refused, status: null, error: 'cannot resolve the state folder: ' + ((e && e.message) || e) };
  }
  const st = {
    schema: STATUS_SCHEMA, job: id, pid: process.pid, child_pid: null, phase: 'starting', outcome: null, exit_code: null,
    started_at: iso(t0), updated_at: iso(t0), finished_at: null, wall_deadline: iso(t0 + S.maxWallMs),
    auto_resume: S.autoResume, attempts: 0, max_attempts: S.maxAttempts, waits: 0, max_waits: S.maxWaits,
    session_id: null, resume_mode: 'fresh', last_class: null, detect_source: null,
    resume_after: null, resume_after_source: null, wake_at: null, history: [],
  };
  const save = () => { st.updated_at = iso(now()); try { fs.mkdirSync(path.dirname(file), { recursive: true }); hook.writeAtomic(file, JSON.stringify(st, null, 2) + '\n'); } catch { /* status is best effort */ } };
  if (S.configNote) log('settings note: ' + S.configNote);
  const ac = new AbortController();
  let stopReason = null, childKill = null;
  const signals = deps.signals || process;
  const onSig = (name) => () => {
    if (ac.signal.aborted) { if (childKill) childKill(true); return; }
    stopReason = 'interrupted'; log(name + ' received - stopping, no relaunch'); ac.abort();
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGBREAK'].map((n) => [n, onSig(n)]);
  for (const [n, h] of handlers) { try { signals.on(n, h); } catch { /* signal not supported here */ } }
  const stopRequested = () => { try { return fs.existsSync(stopFile); } catch { return false; } };
  const finish = (outcome, code) => {
    for (const [n, h] of handlers) { try { signals.removeListener(n, h); } catch { /* ignore */ } }
    Object.assign(st, { phase: 'done', outcome, exit_code: code, finished_at: iso(now()), child_pid: null });
    save();
    return { outcome, exitCode: code, status: st };
  };
  const deadline = t0 + S.maxWallMs;
  const bin = resolveBin(job, deps);
  if (!bin) { log('claude not found on PATH - pass --claude <path> or set FORGE_ROTATOR_CLAUDE_BIN'); return finish('refused', EXIT.refused); }
  save();
  let attempt = 0, waits = 0, mode = 'fresh', sid = null, triedContinue = false;
  for (;;) {
    if (ac.signal.aborted) return finish(stopReason || 'stopped', EXIT.stopped);
    attempt += 1;
    const args = buildArgs(mode, job, sid);
    const launchedAt = now();
    Object.assign(st, { phase: 'running', attempts: attempt, resume_mode: mode, wake_at: null });
    save();
    const poll = setInterval(() => { if (stopRequested() && !ac.signal.aborted) { stopReason = 'stopped'; ac.abort(); } }, deps.pollMs || POLL_MS);
    if (poll.unref) poll.unref();
    let r;
    try {
      r = await run(bin, args, { cwd: root, signal: ac.signal, graceMs: deps.graceMs, comspec: deps.comspec || envGet(deps, 'ComSpec'),
        onSpawn: (pid, kill) => { st.child_pid = Number.isInteger(pid) ? pid : null; childKill = kill; save(); } });
    } finally { clearInterval(poll); childKill = null; }
    st.child_pid = null;
    if (r.refused) { log('refused - ' + r.refused); return finish('refused', EXIT.refused); }
    const parsed = parseResult(r.stdout);
    sid = sessionOf(parsed) || sid;
    const mk = hook.readMarker(root, stateEnv(deps));
    const marker = mk && sid && mk.session_id === sid && mk.ts >= launchedAt - 2000 ? mk : null;
    const c = classify(r, parsed, marker);
    Object.assign(st, { session_id: sid, last_class: c.cls, detect_source: c.source });
    st.history = st.history.concat([{ attempt, mode, exit_code: r.code, class: c.cls, source: c.source, at: iso(now()) }]).slice(-MAX_HISTORY);
    if (c.cls === 'interrupted') return finish(stopReason || 'interrupted', EXIT.stopped);
    if (c.cls === 'success') { (deps.out || ((s) => process.stdout.write(s)))(r.stdout); return finish('completed', EXIT.completed); }
    if (c.cls === 'resume-not-found' && mode === 'resume' && !triedContinue) {
      if (attempt >= S.maxAttempts) return finish('gave-up:max-attempts', EXIT.gaveUp);
      log('session not found for --resume - one fallback launch with --continue'); triedContinue = true; mode = 'continue'; continue;
    }
    if (c.cls !== 'rate_limit' && c.cls !== 'overloaded') return finish('failed', EXIT.failed);
    const tNow = now();
    let at = marker && marker.resume_after > tNow ? marker.resume_after : null;
    let src = at ? 'marker' : null;
    if (!at) { at = hook.parseResetText(haystack(r, parsed), tNow); src = at ? 'result-text' : null; }
    const wakeAt = Math.max(at ? at + MARGIN_MS : tNow + backoffMs(c.cls, waits, deps.random || Math.random), tNow + MIN_WAIT_MS);
    Object.assign(st, { resume_after: iso(at), resume_after_source: src || 'backoff', wake_at: iso(wakeAt) });
    const manual = sid ? 'claude -p "continue" --resume ' + sid : 'claude -p "continue" --continue';
    if (!S.autoResume) { log('usage limit (' + c.cls + ') - rotator-auto-resume is off; resume by hand after ' + iso(wakeAt) + ': ' + manual); return finish('limit-hit:auto-resume-off', EXIT.gaveUp); }
    if (attempt >= S.maxAttempts) return finish('gave-up:max-attempts', EXIT.gaveUp);
    if (waits >= S.maxWaits) return finish('gave-up:max-waits', EXIT.gaveUp);
    if (wakeAt > deadline) { log('the reset (' + iso(wakeAt) + ') is past the wall-clock cap; resume by hand: ' + manual); return finish('gave-up:wall-clock', EXIT.gaveUp); }
    waits += 1;
    Object.assign(st, { phase: 'waiting', waits });
    save();
    log(c.cls + ' (' + (c.source || 'unknown') + '); waiting until ' + iso(wakeAt) + ' (wait ' + waits + '/' + S.maxWaits + ', next launch ' + (attempt + 1) + '/' + S.maxAttempts + ')');
    let beat = now();
    while (now() < wakeAt && !ac.signal.aborted) {
      if (stopRequested()) { stopReason = 'stopped'; ac.abort(); break; }
      await sleep(Math.min(deps.chunkMs || CHUNK_MS, wakeAt - now()), ac.signal);
      if (now() - beat >= HEARTBEAT_MS) { beat = now(); save(); }
    }
    mode = sid ? 'resume' : 'continue';
  }
}

// ---- CLI --------------------------------------------------------------------------------------------------------
const USAGE = 'Usage:\n'
  + '  node forge-rotator-supervisor.cjs run [--root <dir>] [--job <id>] [--claude <path>] [--max-attempts 1-30]\n'
  + '      [--max-waits 1-24] [--max-hours 1-168] [--continue-prompt <text>] -- <prompt> [claude args...]\n'
  + '  node forge-rotator-supervisor.cjs status [--root <dir>] [--job <id>]\n'
  + '  node forge-rotator-supervisor.cjs stop --job <id> [--root <dir>]\n'
  + 'Runs ONE headless claude -p job across usage limits on ONE account (never switches accounts). Waiting and\n'
  + 'relaunching need /forge config set rotator-auto-resume on. Exit: 0 done, 1 failed, 2 usage, 3 refused, 4 gave up, 130 stopped.\n';
function parseCli(argv) {
  const sep = argv.indexOf('--');
  const head = sep >= 0 ? argv.slice(0, sep) : argv.slice();
  const tail = sep >= 0 ? argv.slice(sep + 1) : [];
  const o = { cmd: head.shift() };
  const num = (v, [lo, hi], int) => { const n = Number(v); return (int ? Number.isInteger(n) : Number.isFinite(n)) && n >= lo && n <= hi ? n : NaN; };
  for (let i = 0; i < head.length; i++) {
    const k = head[i], v = head[i + 1];
    if (k === '--root') { o.root = v; i++; } else if (k === '--job') { o.job = v; i++; } else if (k === '--claude') { o.bin = v; i++; }
    else if (k === '--continue-prompt') { o.continuePrompt = v; i++; }
    else if (k === '--max-attempts') { o.maxAttempts = num(v, LIMITS.attempts, true); i++; }
    else if (k === '--max-waits') { o.maxWaits = num(v, LIMITS.waits, true); i++; }
    else if (k === '--max-hours') { const h = num(v, LIMITS.hours, false); o.maxWallMs = h * 3600e3; i++; }
    else return { error: 'unknown option ' + String(k).slice(0, 40) };
  }
  for (const k of ['maxAttempts', 'maxWaits', 'maxWallMs']) if (o[k] !== undefined && !Number.isFinite(o[k])) return { error: k + ' is out of range' };
  if (tail.length) { o.prompt = tail[0]; o.extraArgs = tail.slice(1); }
  return o;
}
async function main(argv, deps) {
  deps = deps || {};
  const err = deps.log || ((s) => process.stderr.write(s + '\n'));
  const o = parseCli(argv);
  if (!o.cmd || o.cmd === '--help' || o.cmd === '-h') { err(USAGE); return o.cmd ? 0 : EXIT.usage; }
  if (o.error) { err(o.error + '\n' + USAGE); return EXIT.usage; }
  const root = path.resolve(o.root || process.cwd());
  if (o.cmd === 'run') {
    if (o.prompt === undefined) { err('run needs -- <prompt>\n' + USAGE); return EXIT.usage; }
    const r = await supervise(Object.assign({}, o, { root }), deps);
    if (r.error) err(r.error);
    return r.exitCode;
  }
  if (o.cmd === 'stop' || o.cmd === 'status') {
    if (o.job !== undefined && !JOB_RE.test(o.job)) { err('invalid --job'); return EXIT.usage; }
    if (o.cmd === 'stop') {
      if (!o.job) { err('stop needs --job <id>'); return EXIT.usage; }
      const f = jobFile(root, o.job, deps, '.stop');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ requested_at: new Date().toISOString() }) + '\n');
      err('stop requested for ' + o.job);
      return 0;
    }
    const dir = hook.rotatorDir(root, stateEnv(deps));
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^supervisor-[A-Za-z0-9_-]+\.json$/.test(n)); } catch { names = []; }
    if (o.job) names = names.filter((n) => n === 'supervisor-' + o.job + '.json');
    const rows = names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } }).filter(Boolean);
    (deps.out || ((s) => process.stdout.write(s)))(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  err('unknown command ' + String(o.cmd).slice(0, 40) + '\n' + USAGE);
  return EXIT.usage;
}

module.exports = {
  supervise, main, parseCli, buildArgs, validateJob, launchPlan, cmdArgsUnsafe, binUnsafe, classify, parseResult, backoffMs,
  resolveSettings, spawnRun, realSleep, ENV_NAMES, DEFAULTS, LIMITS, EXIT, STATUS_SCHEMA, BACKOFF_MS, MARGIN_MS, MIN_WAIT_MS, JITTER,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write('[rotator-supervisor] internal error: ' + ((e && e.message) || e) + '\n'); process.exitCode = 1; });
}
