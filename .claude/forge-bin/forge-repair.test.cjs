#!/usr/bin/env node
'use strict';
/**
 * forge-repair.test.cjs — hermetic tests for forge-repair.cjs (PRD prd-w1-plan-goal-clarity M6).
 *
 * Every external call forge-repair.cjs can make (Command Center health GET, forge-doctor.cjs,
 * forge-snapshot.cjs) is exercised through an injected fake seam here — no real doctor or snapshot writer
 * ever runs in this file. The only real network calls are the W1-08 tests, which talk to a real local
 * HTTP server bound to 127.0.0.1 on a random (OS-assigned) port — never 4100, never a real remote host.
 * Fixtures are real temp directories (fs.mkdtempSync), cleaned up at the end.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  runRepair, main, parseArgs, resolvePort, looksLikeCommandCenterHealth, defaultHealthFetch,
  isForgeProject, normLang, resolveLanguage, TEXT,
} = require('./forge-repair.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message ? e.message : e)); }
}
async function tAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message ? e.message : e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const TMP_DIRS = [];
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  TMP_DIRS.push(dir);
  return dir;
}
function cleanupTmpDirs() {
  for (const dir of TMP_DIRS) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ } }
}
/** makeForgeProject() -> a real temp dir with a `.claude/forge-bin` marker, so isForgeProject(root) is true. */
function makeForgeProject() {
  const dir = mkTmp('repair-project');
  fs.mkdirSync(path.join(dir, '.claude', 'forge-bin'), { recursive: true });
  return dir;
}

const REAL_HEALTH_BODY = { ok: true, runtime: { state: 'OK' }, gateway: { version: '1.0.0' } };
const GREEN_DOCTOR = { ok: true, checks: { node_check: { ok: true }, tests: { ok: true }, leak_scan: { ok: true } } };
const RED_DOCTOR = { ok: false, checks: { node_check: { ok: true }, tests: { ok: true }, leak_scan: { ok: false } } };

/** fakeSeams(overrides) -> a full set of call-recording fake seams, all defaulting to "healthy", so each
 *  test only needs to override the one thing it cares about. `calls` records every seam invocation with
 *  its exact arguments, for the "only read or run, never delete/kill" assertions. */
function fakeSeams(overrides) {
  const calls = { healthFetch: [], runDoctor: [], runSnapshot: [] };
  const base = {
    env: {},
    healthFetch: async (url, timeoutMs) => { calls.healthFetch.push([url, timeoutMs]); return { ok: true, status: 200, body: REAL_HEALTH_BODY }; },
    runDoctor: (root) => { calls.runDoctor.push([root]); return GREEN_DOCTOR; },
    runSnapshot: (root) => { calls.runSnapshot.push([root]); return { ok: true, path: path.join(root, '.claude', 'FORGE_SNAPSHOT.md') }; },
  };
  return { seams: Object.assign(base, overrides), calls };
}

async function run() {
console.log('forge-repair tests (WP-W1-D/W1-fix-repair — hermetic doctor/snapshot; real local HTTP for W1-08)');

// --- pure helpers -------------------------------------------------------------------------------------
t('resolvePort: unset CC_PORT falls back to 4100', () => { assert(resolvePort({}) === 4100); });
t('resolvePort: a positive numeric string is used as-is', () => { assert(resolvePort({ CC_PORT: '5055' }) === 5055); });
t('resolvePort: "0" falls back to 4100', () => { assert(resolvePort({ CC_PORT: '0' }) === 4100); });
t('resolvePort: a non-numeric value falls back to 4100', () => { assert(resolvePort({ CC_PORT: 'nope' }) === 4100); });

t('looksLikeCommandCenterHealth: matches the real gateway shape', () => {
  assert(looksLikeCommandCenterHealth(REAL_HEALTH_BODY) === true);
});
t('looksLikeCommandCenterHealth: rejects null/array/plain objects', () => {
  assert(looksLikeCommandCenterHealth(null) === false);
  assert(looksLikeCommandCenterHealth([1, 2]) === false);
  assert(looksLikeCommandCenterHealth({ ok: true, status: 'healthy' }) === false);
});

t('isForgeProject: true when .claude/forge-bin exists', () => {
  const dir = makeForgeProject();
  assert(isForgeProject(dir) === true);
});
t('isForgeProject: false for an ordinary empty folder', () => {
  const dir = mkTmp('repair-not-a-project');
  assert(isForgeProject(dir) === false);
});

t('normLang: recognizes nl/en (case-insensitive) and rejects everything else', () => {
  assert(normLang('nl') === 'nl');
  assert(normLang('NL') === 'nl');
  assert(normLang('en') === 'en');
  assert(normLang('EN') === 'en');
  assert(normLang('fr') === null);
  assert(normLang(undefined) === null);
});
t('resolveLanguage: defaults to en when --lang is absent', () => {
  assert(resolveLanguage({}) === 'en');
});
t('resolveLanguage: honors an explicit --lang', () => {
  assert(resolveLanguage({ lang: 'nl' }) === 'nl');
  assert(resolveLanguage({ lang: 'en' }) === 'en');
});

t('parseArgs: reads --root/--json/--lang', () => {
  const p = parseArgs(['--root', '/tmp/x', '--json', '--lang', 'nl']);
  assert(p.root === '/tmp/x' && p.json === true && p.lang === 'nl' && !p.usageError);
});
t('parseArgs: flags an unknown argument', () => {
  const p = parseArgs(['--bogus']);
  assert(typeof p.usageError === 'string');
});

// --- runRepair: not a Forge project --------------------------------------------------------------------
await tAsync('runRepair: not a Forge project stops the ladder at status, exit 3', async () => {
  const dir = mkTmp('repair-nonproject');
  const { seams, calls } = fakeSeams();
  const rep = await runRepair(Object.assign({ root: dir }, seams));
  assert(rep.exitCode === 3, 'exitCode: ' + rep.exitCode);
  assert(rep.steps.length === 1 && rep.steps[0].name === 'status', JSON.stringify(rep.steps));
  assert(rep.steps[0].ok === false);
  assert(/not a Forge project/i.test(rep.steps[0].detail), rep.steps[0].detail);
  assert(/Forge project|install/i.test(rep.next_step), rep.next_step);
  // nothing else was ever consulted — the ladder truly stopped at step 1
  assert(calls.healthFetch.length === 0, 'healthFetch must not be called');
  assert(calls.runDoctor.length === 0, 'runDoctor must not be called');
  assert(calls.runSnapshot.length === 0, 'runSnapshot must not be called');
});

// --- runRepair: dashboard down --------------------------------------------------------------------------
await tAsync('runRepair: dashboard down stops the ladder at status, names /forge dashboard, exit 3', async () => {
  const dir = makeForgeProject();
  const { seams, calls } = fakeSeams({
    healthFetch: async (url, timeoutMs) => { calls.healthFetch.push([url, timeoutMs]); return { ok: false, error: 'ECONNREFUSED' }; },
  });
  const rep = await runRepair(Object.assign({ root: dir }, seams));
  assert(rep.exitCode === 3, 'exitCode: ' + rep.exitCode);
  assert(rep.steps.length === 1 && rep.steps[0].name === 'status', JSON.stringify(rep.steps));
  assert(rep.steps[0].ok === false);
  assert(/not running/i.test(rep.steps[0].detail), rep.steps[0].detail);
  // the status detail is the project/dashboard line only — no usage-guard text of any kind.
  assert(!/usage-guard/i.test(rep.steps[0].detail), 'status detail must not mention usage-guard: ' + rep.steps[0].detail);
  assert(/\/forge dashboard/.test(rep.next_step), rep.next_step);
  assert(calls.healthFetch.length === 1, 'healthFetch called once');
  assert(calls.healthFetch[0][0] === 'http://127.0.0.1:4100', calls.healthFetch[0][0]);
  assert(calls.runDoctor.length === 0, 'runDoctor must not be called when the dashboard is down');
  assert(calls.runSnapshot.length === 0, 'runSnapshot must not be called when the dashboard is down');
});

// --- runRepair: dashboard port conflict (something else answers) -----------------------------------------
await tAsync('runRepair: a port conflict is reported honestly, never as "starting" the dashboard', async () => {
  const dir = makeForgeProject();
  const { seams, calls } = fakeSeams({
    healthFetch: async (url, timeoutMs) => { calls.healthFetch.push([url, timeoutMs]); return { ok: true, status: 200, body: { ok: true, status: 'healthy', service: 'unrelated-app' } }; },
  });
  const rep = await runRepair(Object.assign({ root: dir }, seams));
  assert(rep.exitCode === 3);
  assert(/something else answers/i.test(rep.steps[0].detail), rep.steps[0].detail);
  // W1-09 + Verify Boss V03-a: the next step is Forge's own action (leave the occupant alone and continue
  // without the dashboard — the Command Center only works on its fixed port), never a beginner instruction
  // to free a port or set an env var by hand, and never a claim that it starts on another port.
  assert(/Forge/.test(rep.next_step) && /without the dashboard/i.test(rep.next_step), rep.next_step);
  assert(!/CC_PORT|free port/i.test(rep.next_step), 'must not claim an alternate-port start: ' + rep.next_step);
  assert(!/free that port/i.test(rep.next_step), 'must not be the old "free that port" instruction: ' + rep.next_step);
  assert(!/set CC_PORT to a different one/i.test(rep.next_step), 'must not be the old "set CC_PORT" instruction: ' + rep.next_step);
  assert(calls.runDoctor.length === 0 && calls.runSnapshot.length === 0);
});

// --- runRepair: doctor failing -----------------------------------------------------------------------
await tAsync('runRepair: failing doctor checks stop the ladder at doctor, names the checks, exit 3', async () => {
  const dir = makeForgeProject();
  const { seams, calls } = fakeSeams({ runDoctor: (root) => { calls.runDoctor.push([root]); return RED_DOCTOR; } });
  const rep = await runRepair(Object.assign({ root: dir }, seams));
  assert(rep.exitCode === 3, 'exitCode: ' + rep.exitCode);
  assert(rep.steps.length === 2, JSON.stringify(rep.steps));
  assert(rep.steps[0].ok === true, 'status should be ok when the dashboard is reachable');
  assert(rep.steps[1].name === 'doctor' && rep.steps[1].ok === false);
  assert(/leak_scan/.test(rep.steps[1].detail), rep.steps[1].detail);
  assert(/leak_scan/.test(rep.next_step), rep.next_step);
  assert(calls.runDoctor.length === 1 && calls.runDoctor[0][0] === dir);
  assert(calls.runSnapshot.length === 0, 'runSnapshot must not be called when the doctor is red');
});

// --- runRepair: healthy end-to-end ---------------------------------------------------------------------
await tAsync('runRepair: healthy project runs all three steps and reports the next task, exit 0', async () => {
  const dir = makeForgeProject();
  const { seams, calls } = fakeSeams();
  const rep = await runRepair(Object.assign({ root: dir }, seams));
  assert(rep.exitCode === 0, 'exitCode: ' + rep.exitCode);
  assert(rep.ok === true);
  assert(rep.steps.length === 3, JSON.stringify(rep.steps));
  assert(rep.steps.every((s) => s.ok === true), JSON.stringify(rep.steps));
  assert(rep.steps.map((s) => s.name).join(',') === 'status,doctor,refresh');
  assert(/healthy/i.test(rep.next_step), rep.next_step);
  assert(calls.healthFetch.length === 1 && calls.runDoctor.length === 1 && calls.runSnapshot.length === 1);
});

// --- runRepair: refresh failure ------------------------------------------------------------------------
await tAsync('runRepair: a snapshot refresh failure is the final step and is reported honestly, exit 3', async () => {
  const dir = makeForgeProject();
  const { seams } = fakeSeams({ runSnapshot: (root) => ({ ok: false, error: 'disk full' }) });
  const rep = await runRepair(Object.assign({ root: dir }, seams));
  assert(rep.exitCode === 3);
  assert(rep.steps[2].name === 'refresh' && rep.steps[2].ok === false);
  assert(/disk full/.test(rep.steps[2].detail), rep.steps[2].detail);
  assert(/disk full/.test(rep.next_step), rep.next_step);
});

// --- Dutch and English next-step text ------------------------------------------------------------------
await tAsync('runRepair: --lang nl produces a Dutch next_step sentence for the dashboard-down case', async () => {
  const dir = makeForgeProject();
  const { seams } = fakeSeams({ healthFetch: async () => ({ ok: false, error: 'ECONNREFUSED' }) });
  const rep = await runRepair(Object.assign({ root: dir, lang: 'nl' }, seams));
  assert(rep.lang === 'nl');
  assert(/dashboard is uit/i.test(rep.next_step), rep.next_step);
  assert(/\/forge dashboard/.test(rep.next_step), rep.next_step);
});
await tAsync('runRepair: --lang en produces the English next_step sentence for the dashboard-down case', async () => {
  const dir = makeForgeProject();
  const { seams } = fakeSeams({ healthFetch: async () => ({ ok: false, error: 'ECONNREFUSED' }) });
  const rep = await runRepair(Object.assign({ root: dir, lang: 'en' }, seams));
  assert(rep.lang === 'en');
  assert(/dashboard is down/i.test(rep.next_step), rep.next_step);
});
await tAsync('runRepair: healthy next_step differs between nl and en', async () => {
  const dirNl = makeForgeProject();
  const { seams: seamsNl } = fakeSeams();
  const repNl = await runRepair(Object.assign({ root: dirNl, lang: 'nl' }, seamsNl));
  const dirEn = makeForgeProject();
  const { seams: seamsEn } = fakeSeams();
  const repEn = await runRepair(Object.assign({ root: dirEn, lang: 'en' }, seamsEn));
  assert(repNl.next_step !== repEn.next_step, 'nl and en next_step must differ: ' + repNl.next_step);
  assert(/gezond/i.test(repNl.next_step), repNl.next_step);
  assert(/healthy/i.test(repEn.next_step), repEn.next_step);
});

// --- port-conflict wording never instructs the beginner (both languages) -------------------------
t('W1-09: the nl port-conflict next_step is Forge\'s own action, not a beginner instruction', () => {
  const s = TEXT.nl.nextDashboardConflict('http://127.0.0.1:4100');
  assert(/Forge/.test(s) && /zonder dashboard/i.test(s), s);
  assert(!/CC_PORT|vrije poort/i.test(s), 'must not claim an alternate-port start (V03-a): ' + s);
  assert(!/\bvrij\b/i.test(s), 'must not tell the reader to free the port: ' + s);
  assert(!/maak die poort/i.test(s), 'must not be the old "maak die poort vrij" instruction: ' + s);
});
t('W1-09: the en port-conflict next_step is Forge\'s own action, not a beginner instruction', () => {
  const s = TEXT.en.nextDashboardConflict('http://127.0.0.1:4100');
  assert(/Forge/.test(s) && /without the dashboard/i.test(s), s);
  assert(!/CC_PORT|free port/i.test(s), 'must not claim an alternate-port start (V03-a): ' + s);
  assert(!/\byou\b/i.test(s), 'must not address the reader directly: ' + s);
  assert(!/free that port/i.test(s), 'must not be the old "free that port" instruction: ' + s);
});

// --- no usage-guard call anywhere in this tool ----------------------------------------------------
t('W1-07: forge-repair.cjs source no longer references usage-guard in any form', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-repair.cjs'), 'utf8');
  assert(!/usage-guard/i.test(src), 'forge-repair.cjs must not mention usage-guard');
  assert(!/usageguard/i.test(src), 'forge-repair.cjs must not reference an UsageGuard identifier');
});
t('W1-07: runRepair\'s default seams contain no usage-guard runner', () => {
  const mod = require('./forge-repair.cjs');
  const usageGuardNamedExports = Object.keys(mod).filter((k) => /usage-?guard/i.test(k));
  assert(usageGuardNamedExports.length === 0, 'unexpected usage-guard export(s): ' + usageGuardNamedExports.join(', '));
});
await tAsync('W1-07: runRepair ignores an injected runUsageGuard seam entirely (not part of the contract)', async () => {
  const dir = makeForgeProject();
  const { seams } = fakeSeams();
  let injectedCalled = false;
  const rep = await runRepair(Object.assign({ root: dir, runUsageGuard: () => { injectedCalled = true; return { available: true, line: 'x' }; } }, seams));
  assert(injectedCalled === false, 'runRepair must never call a runUsageGuard seam, injected or not');
  assert(!/usage-guard/i.test(JSON.stringify(rep)), 'the report must never contain usage-guard text');
});

// --- the health check is bounded on every axis (real local server, 127.0.0.1, random port) --------
function withTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
await tAsync('W1-08: a response that streams forever settles quickly as not reachable', async () => {
  let iv = null;
  let lastRes = null;
  const server = await withTestServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    lastRes = res;
    iv = setInterval(() => { try { res.write('{'); } catch { clearInterval(iv); } }, 20);
  });
  const port = server.address().port;
  const start = Date.now();
  const result = await defaultHealthFetch('http://127.0.0.1:' + port, 400);
  const elapsed = Date.now() - start;
  clearInterval(iv);
  if (lastRes) { try { lastRes.destroy(); } catch { /* already closing */ } }
  await new Promise((r) => server.close(r));
  assert(result.ok === false, JSON.stringify(result));
  assert(elapsed < 2000, 'took too long to settle: ' + elapsed + 'ms');
});
await tAsync('W1-08: a response larger than the size cap settles quickly as not reachable', async () => {
  const server = await withTestServer((req, res) => { res.writeHead(200); res.end(Buffer.alloc(1024 * 1024, 'x')); });
  const port = server.address().port;
  const start = Date.now();
  const result = await defaultHealthFetch('http://127.0.0.1:' + port, 3000);
  const elapsed = Date.now() - start;
  await new Promise((r) => server.close(r));
  assert(result.ok === false, JSON.stringify(result));
  assert(elapsed < 2000, 'took too long to settle: ' + elapsed + 'ms (should be near-instant on the size cap)');
});
await tAsync('W1-08: the server closing the connection mid-response settles quickly as not reachable', async () => {
  const server = await withTestServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":true');
    setTimeout(() => { try { res.socket.destroy(); } catch { /* already closing */ } }, 30);
  });
  const port = server.address().port;
  const start = Date.now();
  const result = await defaultHealthFetch('http://127.0.0.1:' + port, 2000);
  const elapsed = Date.now() - start;
  await new Promise((r) => server.close(r));
  assert(result.ok === false, JSON.stringify(result));
  assert(elapsed < 2000, 'took too long to settle: ' + elapsed + 'ms');
});

// --- main(): --json shape -------------------------------------------------------------------------------
await tAsync('main: --json prints exactly {steps, next_step}, nothing else', async () => {
  const dir = makeForgeProject();
  const { seams } = fakeSeams();
  const result = await main(['--root', dir, '--json'], seams);
  assert(result.exitCode === 0, 'exitCode: ' + result.exitCode);
  const parsed = JSON.parse(result.text);
  assert(Object.keys(parsed).sort().join(',') === 'next_step,steps', Object.keys(parsed).join(','));
  assert(Array.isArray(parsed.steps) && parsed.steps.length === 3);
  for (const s of parsed.steps) {
    assert(typeof s.name === 'string' && typeof s.ok === 'boolean' && typeof s.detail === 'string', JSON.stringify(s));
  }
  assert(typeof parsed.next_step === 'string' && parsed.next_step.length > 0);
});
await tAsync('main: --json on a failing project still yields the {steps, next_step} shape, exit 3', async () => {
  const dir = mkTmp('repair-json-fail');
  const { seams } = fakeSeams();
  const result = await main(['--root', dir, '--json'], seams);
  assert(result.exitCode === 3);
  const parsed = JSON.parse(result.text);
  assert(Object.keys(parsed).sort().join(',') === 'next_step,steps');
  assert(parsed.steps.length === 1 && parsed.steps[0].ok === false);
});
await tAsync('main: an unknown flag never runs the ladder and exits 1', async () => {
  const { seams, calls } = fakeSeams();
  const result = await main(['--bogus'], seams);
  assert(result.exitCode === 1, 'exitCode: ' + result.exitCode);
  assert(result.report === null);
  assert(calls.healthFetch.length === 0 && calls.runDoctor.length === 0 && calls.runSnapshot.length === 0);
});
await tAsync('main: without --json prints human-readable text carrying every step and the next step', async () => {
  const dir = makeForgeProject();
  const { seams } = fakeSeams();
  const result = await main(['--root', dir], seams);
  assert(result.exitCode === 0);
  assert(/status/.test(result.text) && /doctor/.test(result.text) && /refresh/.test(result.text), result.text);
  assert(/Next step:/.test(result.text), result.text);
});

// --- no delete / kill / global write ---------------------------------------------------------------------
t('source scan: forge-repair.cjs never references a destructive or process-killing call', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-repair.cjs'), 'utf8');
  const forbidden = [
    'rmSync', 'rmdirSync', 'unlinkSync', 'fs.rm(', 'rimraf',
    'taskkill', 'process.kill', 'Stop-Process', 'pkill', 'kill(',
    'execSync(', 'exec(', "'-Force'", '--force', 'git push', 'git reset', 'git checkout', 'git clean',
    'homedir(', 'os.homedir',
  ];
  for (const needle of forbidden) {
    assert(!src.includes(needle), 'forge-repair.cjs must not contain "' + needle + '"');
  }
});
await tAsync('seam contract: every seam is called with only a plain root/url argument, never a flag or path outside root', async () => {
  const dir = makeForgeProject();
  const { seams, calls } = fakeSeams();
  await runRepair(Object.assign({ root: dir }, seams));
  assert(calls.healthFetch.length === 1 && calls.healthFetch[0].length === 2, JSON.stringify(calls.healthFetch));
  assert(typeof calls.healthFetch[0][0] === 'string' && typeof calls.healthFetch[0][1] === 'number');
  assert(calls.runDoctor.length === 1 && calls.runDoctor[0].length === 1 && calls.runDoctor[0][0] === dir);
  assert(calls.runSnapshot.length === 1 && calls.runSnapshot[0].length === 1 && calls.runSnapshot[0][0] === dir);
});

// Found by the first real run on the Forge source repo: the real doctor's --json report is about 1.7 MB, over
// spawnSync's 1 MB default buffer, so the doctor step failed with ENOBUFS. A fake doctor prints 2 MB here.
t('defaultRunDoctor reads a doctor report larger than 1 MB (no ENOBUFS)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-repair-big-'));
  const script = path.join(dir, 'fake-doctor.cjs');
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ ok: true, pad: 'x'.repeat(2 * 1024 * 1024) }));\n");
  const { defaultRunDoctor } = require('./forge-repair.cjs');
  const r = defaultRunDoctor(dir, { doctorScript: script });
  fs.rmSync(dir, { recursive: true, force: true });
  assert(r && r.ok === true && !r.error, JSON.stringify(r).slice(0, 200));
});

cleanupTmpDirs();
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('forge-repair.test.cjs: unexpected error — ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
