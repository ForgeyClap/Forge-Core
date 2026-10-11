#!/usr/bin/env node
'use strict';
/**
 * forge-repair.cjs — / PRD prd-w1-plan-goal-clarity module M6: a one-command repair ladder for
 * beginners who never want to type a command. `/forge repair` runs this FOR the owner and acts on its
 * `next_step`; the owner never types it themselves.
 *
 * THE LADDER (stops at the first step that fixes or explains the problem):
 *   1. status  — is this a Forge project (.claude/forge-bin present)? Is the Command Center reachable
 *                (GET http://127.0.0.1:<CC_PORT or 4100>/api/health, short timeout)? Report reachable or
 *                not — this file never starts or stops anything itself. W1-07: this step reports the
 *                project and the dashboard only; it never runs any other status helper that can read
 *                credentials, contact the network, or write/delete files outside this project — that
 *                would break the "truly passive" promise below.
 *   2. doctor  — runs forge-doctor.cjs. forge-doctor.cjs has no quick/fast mode (see its own --help), so
 *                this runs the full self-test with a generous timeout and says so in the step detail.
 *                ALL GREEN -> continue; any failing check -> stop here and name it.
 *   3. refresh — runs forge-snapshot.cjs write, harmless and idempotent, so the mission/state files are
 *                current.
 *   4. next step — one plain sentence (in the language of --lang, default en) saying what is wrong and
 *                what Forge does next, or that everything is healthy.
 *
 * NEVER (this file's own code): deletes anything, kills a process, starts/stops the Command Center,
 * writes under ~/.claude or any global config, or asks the owner to run a command themselves. Verify Boss
 * V-04: that promise covers this file only — the forge-doctor.cjs it runs in step 2 does READ files under
 * ~/.claude (for example the installed central template) as part of its self-test. Verify Boss V04-a: the
 * doctor also starts every *.test.cjs suite, which create and delete their own temp folders (under %TEMP%,
 * inside the home folder on Windows) and start short-lived local test servers, and it runs the `claude
 * doctor` probe. Every external tool this file calls is reused through spawnSync(process.execPath,
 * [argv...]) — a real argument array, never a shell string — so this stays a thin ladder over
 * forge-doctor.cjs / forge-snapshot.cjs rather than a second implementation of what they already do.
 * apart from that doctor, it deliberately never shells out to any other status helper that can read
 * credentials, contact the network, or write/delete under a user's home directory.
 *
 * Every call to another tool or the network is an injectable seam (opts.healthFetch / opts.runDoctor /
 * opts.runSnapshot) so the test suite never spawns a real doctor/snapshot process and never makes a real
 * network call — see forge-repair.test.cjs.
 *
 * CLI: node forge-repair.cjs [--root <dir>] [--json] [--lang nl|en]
 *   --root  project root to check (default: two levels up from forge-bin, i.e. this project)
 *   --json  print exactly one JSON object: { steps: [{ name, ok, detail }], next_step }
 *   --lang  nl|en for the next_step sentence (default: en) — the caller (the /forge orchestrator)
 *           resolves the owner's language and passes it down, the same convention forge-config.cjs's own
 *           `--lang` flag already uses.
 * Exit codes: 0 healthy · 3 a problem found (explained in next_step) · 1 the tool itself could not run
 * (a bad flag, or an unexpected internal error).
 *
 * Module API: { runRepair, main, parseArgs, resolvePort, looksLikeCommandCenterHealth, defaultHealthFetch,
 *   isForgeProject, normLang, resolveLanguage, defaultRunDoctor, defaultRunSnapshot, TEXT }
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
// Child output ceiling: well above the doctor's real --json report (about 1.7 MB) and spawnSync's 1 MB default.
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;

const NODE = process.execPath;
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const HEALTH_TIMEOUT_MS = 1500;
// a health response larger than this is treated as "not reachable" instead of buffered without bound.
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
// forge-doctor.cjs has no quick/fast mode (checked: its --help says "Takes several minutes" and lists no
// flag for a lighter run) — this is the "generous timeout" the work package asks for when that is so.
const DOCTOR_TIMEOUT_MS = 10 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 30 * 1000;

/** resolvePort(env) -> number. Same rule command-center/gateway/bin.mjs, forge-cc-launch.cjs and
 *  forge-runinfo.cjs already use: process.env.CC_PORT when it parses as a positive number, else 4100. */
function resolvePort(env) {
  const n = Number((env || process.env).CC_PORT);
  return n > 0 ? n : 4100;
}

/** looksLikeCommandCenterHealth(body) — the real gateway health shape (ok:boolean, runtime, gateway.version).
 *  Kept as its own small copy, same reason forge-runinfo.cjs/forge-cc-launch.cjs each keep their own: this
 *  file never imports from command-center/, which is its own separate git repository. */
function looksLikeCommandCenterHealth(body) {
  return !!(body && typeof body === 'object' && !Array.isArray(body)
    && typeof body.ok === 'boolean'
    && 'runtime' in body
    && body.gateway && typeof body.gateway === 'object'
    && typeof body.gateway.version === 'string');
}

/** defaultHealthFetch(url, timeoutMs) -> Promise<{ok, status, body} | {ok:false, error}>. One short-timeout
 *  GET, nothing else — this never sends a body, a different method, or any write.
 *  bounded on every axis — a wall-clock deadline that fires independent of socket activity (a slow
 *  trickle of bytes could otherwise keep the socket-inactivity timeout from ever firing), a response-size
 *  cap so a streaming/oversized body is never buffered without bound, and the promise settles exactly once
 *  no matter which of request `error` / socket `timeout` / response `aborted` / response `close` before
 *  `end` / the size cap / the deadline fires first. */
function defaultHealthFetch(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/health', url); } catch (e) { resolve({ ok: false, error: 'bad url: ' + url }); return; }

    let settled = false;
    let deadlineTimer = null;
    let req = null;
    function settle(result) {
      if (settled) return;
      settled = true;
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      if (req) { try { req.destroy(); } catch { /* already closing */ } }
      resolve(result);
    }

    deadlineTimer = setTimeout(() => { settle({ ok: false, error: 'deadline exceeded after ' + timeoutMs + 'ms' }); }, timeoutMs);

    try {
      req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs }, (res) => {
        let d = '';
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > MAX_HEALTH_RESPONSE_BYTES) { settle({ ok: false, error: 'response exceeded ' + MAX_HEALTH_RESPONSE_BYTES + ' bytes' }); return; }
          d += c;
        });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(d); } catch { /* a non-JSON body is still an honest "answered" */ }
          settle({ ok: true, status: res.statusCode, body });
        });
        res.on('aborted', () => settle({ ok: false, error: 'response aborted' }));
        res.on('close', () => settle({ ok: false, error: 'connection closed before the response ended' }));
        res.on('error', (e) => settle({ ok: false, error: e.message }));
      });
    } catch (e) { settle({ ok: false, error: e.message }); return; }
    req.on('timeout', () => settle({ ok: false, error: 'timeout after ' + timeoutMs + 'ms' }));
    req.on('error', (e) => settle({ ok: false, error: e.message }));
  });
}

/** isForgeProject(root) -> true when root looks like a Forge project (.claude/forge-bin present). */
function isForgeProject(root) {
  return fs.existsSync(path.join(root, '.claude', 'forge-bin'));
}

/** normLang(x) -> 'nl' | 'en' | null. Same small rule forge-config.cjs's own normLang uses. */
function normLang(x) {
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase();
  if (s === 'nl' || s === 'dutch' || s === 'nederlands') return 'nl';
  if (s === 'en' || s === 'english' || s === 'engels') return 'en';
  return null;
}

/** resolveLanguage(opts) -> 'nl' | 'en'. --lang is the only input: this tool never reads a settings file
 *  itself (that would mean reading outside --root) — the caller (the /forge orchestrator) already knows
 *  the owner's language and passes it down, exactly the convention forge-config.cjs's own `--lang` flag
 *  already uses for its `list`/`explain` output. */
function resolveLanguage(opts) {
  return normLang(opts && opts.lang) || 'en';
}

/** defaultRunDoctor(root) -> the real forge-doctor.cjs report (spawnSync, --json, a generous timeout).
 *  Never called by the test suite — see forge-repair.test.cjs's injected fake instead. */
function defaultRunDoctor(root, opts) {
  // opts.doctorScript is a test seam. maxBuffer: the real --json report is about 1.7 MB, over spawnSync's 1 MB
  // default, which made this step fail with ENOBUFS on the first real run.
  const script = (opts && opts.doctorScript) || path.join(__dirname, 'forge-doctor.cjs');
  const r = spawnSync(NODE, [script, '--root', root, '--json'], { encoding: 'utf8', timeout: DOCTOR_TIMEOUT_MS, maxBuffer: MAX_CHILD_OUTPUT_BYTES });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status === null && r.signal) return { ok: false, error: 'forge-doctor timed out (' + r.signal + ')', timedOut: true };
  try { return JSON.parse(r.stdout); }
  catch (e) { return { ok: false, error: 'could not parse forge-doctor output: ' + e.message }; }
}

/** defaultRunSnapshot(root) -> { ok, path?, error? } from forge-snapshot.cjs write --json. Harmless and
 *  idempotent — forge-snapshot.cjs regenerates FORGE_SNAPSHOT.md from real sources every time it runs, it
 *  never appends or duplicates. Never called by the test suite — see the injected fake instead. */
function defaultRunSnapshot(root) {
  const script = path.join(__dirname, 'forge-snapshot.cjs');
  const r = spawnSync(NODE, [script, 'write', '--root', root, '--reason', 'manual', '--json'], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: MAX_CHILD_OUTPUT_BYTES });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || ('forge-snapshot exited ' + r.status)).trim() };
  try { return Object.assign({ ok: true }, JSON.parse(r.stdout)); }
  catch (e) { return { ok: false, error: 'could not parse forge-snapshot output: ' + e.message }; }
}

const TEXT = {
  nl: {
    notForgeProject: (root) => 'Dit is geen Forge-project — .claude/forge-bin ontbreekt in ' + root + '. Er is hier niets te repareren.',
    dashboardUp: (url) => 'het Command Center draait op ' + url,
    dashboardDown: (url) => 'het Command Center draait niet op ' + url,
    dashboardConflict: (url) => 'er antwoordt iets anders op ' + url + ' (niet het Forge Command Center)',
    doctorNote: 'geen snelle modus beschikbaar; de volledige zelftest kan een paar minuten duren',
    doctorGreen: 'forge-doctor: ALLES GROEN',
    doctorRed: (names) => 'forge-doctor: mislukte controles: ' + names.join(', '),
    doctorError: (msg) => 'forge-doctor kon niet draaien: ' + msg,
    refreshOk: 'FORGE_SNAPSHOT.md is bijgewerkt',
    refreshFail: (msg) => 'het verversen van de snapshot lukte niet: ' + msg,
    nextNotForge: 'Ga naar een echte Forge-projectmap, of laat Forge het hier installeren.',
    nextDashboardDown: (url) => 'Het dashboard is uit, dus Forge start het zelf met /forge dashboard (' + url + ').',
    // W1-09 + Verify Boss V03-a: the beginner never touches a port or an env var, and Forge claims no start
    // on another port — the dashboard page and the gateway's allowed origins are fixed to port 4100.
    nextDashboardConflict: (url) => 'Er draait al iets anders op ' + url + ' — dat is niet het Forge dashboard. Het Command Center werkt alleen op zijn eigen vaste poort, dus Forge laat dat programma met rust en gaat verder zonder dashboard.',
    nextDoctor: (names) => 'De zelftest toont mislukte controles (' + names.join(', ') + '), dus Forge lost die als volgende stap op.',
    nextDoctorError: (msg) => 'De zelftest kon niet draaien (' + msg + '), dus Forge kijkt daar als volgende stap naar.',
    nextRefresh: (msg) => 'Het verversen van de snapshot lukte niet (' + msg + '), dus Forge kijkt daar als volgende stap naar.',
    nextHealthy: 'Alles is gezond — Forge gaat verder met de volgende taak.',
  },
  en: {
    notForgeProject: (root) => 'This is not a Forge project — .claude/forge-bin is missing in ' + root + '. There is nothing to repair here.',
    dashboardUp: (url) => 'the Command Center is running on ' + url,
    dashboardDown: (url) => 'the Command Center is not running on ' + url,
    dashboardConflict: (url) => 'something else answers on ' + url + ' (not the Forge Command Center)',
    doctorNote: 'no quick mode available; the full self-test can take a few minutes',
    doctorGreen: 'forge-doctor: ALL GREEN',
    doctorRed: (names) => 'forge-doctor: failing checks: ' + names.join(', '),
    doctorError: (msg) => 'forge-doctor could not run: ' + msg,
    refreshOk: 'FORGE_SNAPSHOT.md was refreshed',
    refreshFail: (msg) => 'refreshing the snapshot failed: ' + msg,
    nextNotForge: 'Go to a real Forge project folder, or let Forge install it here.',
    nextDashboardDown: (url) => 'The dashboard is down, so Forge starts it itself with /forge dashboard (' + url + ').',
    // W1-09 + Verify Boss V03-a: the beginner never touches a port or an env var, and Forge claims no start
    // on another port — the dashboard page and the gateway's allowed origins are fixed to port 4100.
    nextDashboardConflict: (url) => 'Something else is already running on ' + url + ' — that is not the Forge dashboard. The Command Center only works on its own fixed port, so Forge leaves that program alone and continues without the dashboard.',
    nextDoctor: (names) => 'The doctor shows failing checks (' + names.join(', ') + '), so Forge fixes them next.',
    nextDoctorError: (msg) => 'The self-test could not run (' + msg + '), so Forge looks at that next.',
    nextRefresh: (msg) => 'Refreshing the snapshot failed (' + msg + '), so Forge looks at that next.',
    nextHealthy: 'Everything is healthy — Forge continues with the next task.',
  },
};

/** runRepair(opts) -> Promise<{ steps, next_step, ok, exitCode, lang }>. opts: { root, lang, env,
 *  healthFetch, runDoctor, runSnapshot }. Every seam defaults to the real implementation above; the test
 *  suite always overrides them. */
async function runRepair(rawOpts) {
  const opts = rawOpts || {};
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const lang = resolveLanguage(opts);
  const T = TEXT[lang];
  const steps = [];

  // ---- step 1: status ----
  if (!isForgeProject(root)) {
    steps.push({ name: 'status', ok: false, detail: T.notForgeProject(root) });
    return { steps, next_step: T.nextNotForge, ok: false, exitCode: 3, lang };
  }

  const port = resolvePort(opts.env);
  const url = 'http://127.0.0.1:' + port;
  const healthFetch = opts.healthFetch || defaultHealthFetch;
  const health = await healthFetch(url, HEALTH_TIMEOUT_MS);
  const reachable = !!(health && health.ok && looksLikeCommandCenterHealth(health.body));
  const conflict = !!(health && health.ok && !reachable);

  // status reports the project and the dashboard only — no other status helper is invoked here.
  const dashboardText = reachable ? T.dashboardUp(url) : (conflict ? T.dashboardConflict(url) : T.dashboardDown(url));
  steps.push({ name: 'status', ok: reachable, detail: dashboardText });
  if (!reachable) {
    const next = conflict ? T.nextDashboardConflict(url) : T.nextDashboardDown(url);
    return { steps, next_step: next, ok: false, exitCode: 3, lang };
  }

  // ---- step 2: doctor ----
  const runDoctor = opts.runDoctor || defaultRunDoctor;
  const doctorRep = runDoctor(root) || {};
  if (doctorRep.error) {
    steps.push({ name: 'doctor', ok: false, detail: T.doctorError(doctorRep.error) + ' (' + T.doctorNote + ')' });
    return { steps, next_step: T.nextDoctorError(doctorRep.error), ok: false, exitCode: 3, lang };
  }
  const checks = doctorRep.checks || {};
  const failing = Object.keys(checks).filter((k) => checks[k] && checks[k].ok === false);
  const doctorOk = !!doctorRep.ok && failing.length === 0;
  steps.push({ name: 'doctor', ok: doctorOk, detail: (doctorOk ? T.doctorGreen : T.doctorRed(failing)) + ' (' + T.doctorNote + ')' });
  if (!doctorOk) {
    return { steps, next_step: T.nextDoctor(failing), ok: false, exitCode: 3, lang };
  }

  // ---- step 3: refresh ----
  const runSnapshot = opts.runSnapshot || defaultRunSnapshot;
  const snap = runSnapshot(root) || {};
  steps.push({ name: 'refresh', ok: !!snap.ok, detail: snap.ok ? T.refreshOk : T.refreshFail(snap.error || 'unknown error') });
  if (!snap.ok) {
    return { steps, next_step: T.nextRefresh(snap.error || 'unknown error'), ok: false, exitCode: 3, lang };
  }

  // ---- step 4: next step (healthy) ----
  return { steps, next_step: T.nextHealthy, ok: true, exitCode: 0, lang };
}

// ---- CLI ----
function parseArgs(argv) {
  const opts = { root: null, json: false, lang: null, usageError: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--lang') opts.lang = argv[++i];
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  return 'Usage: node forge-repair.cjs [--root <dir>] [--json] [--lang nl|en]';
}
function renderHuman(payload, lang) {
  const lines = payload.steps.map((s) => '[' + (s.ok ? 'OK' : '!!') + '] ' + s.name + ': ' + s.detail);
  lines.push('');
  lines.push((lang === 'nl' ? 'Volgende stap: ' : 'Next step: ') + payload.next_step);
  return lines.join('\n');
}

/** main(argv, seams) -> Promise<{ report, text, exitCode }>. `report` is exactly the --json contract shape
 *  ({ steps, next_step }); `text` is what the CLI prints. `seams` are the same overrides runRepair()
 *  accepts, so a test can drive the whole CLI layer in-process without spawning anything real. */
async function main(argv, seams) {
  const parsed = parseArgs(argv || []);
  if (parsed.usageError) {
    return { report: null, text: 'forge-repair: ' + parsed.usageError + '\n' + printUsage(), exitCode: 1 };
  }
  const opts = Object.assign({}, seams || {}, { root: parsed.root || (seams && seams.root), json: parsed.json, lang: parsed.lang || (seams && seams.lang) });
  const rep = await runRepair(opts);
  const payload = { steps: rep.steps, next_step: rep.next_step };
  const text = parsed.json ? JSON.stringify(payload, null, 2) : renderHuman(payload, rep.lang);
  return { report: payload, text, exitCode: rep.exitCode };
}

module.exports = {
  runRepair, main, parseArgs,
  resolvePort, looksLikeCommandCenterHealth, defaultHealthFetch,
  isForgeProject, normLang, resolveLanguage,
  defaultRunDoctor, defaultRunSnapshot,
  TEXT,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((result) => {
    console.log(result.text);
    process.exitCode = result.exitCode;
  }).catch((e) => {
    console.error('forge-repair: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}
