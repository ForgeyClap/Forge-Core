#!/usr/bin/env node
'use strict';
/**
 * forge-cc-launch.test.cjs — hermetic unit tests for forge-cc-launch.cjs.
 *
 * SCOPE. These tests cover the pure/seam-based decision functions (resolvePort, isAlreadyRunning,
 * findCommandCenter, installerHint, ensureBuilt, pickEntry) against real temp directories and a real
 * ephemeral HTTP server (never a mocked fetch — isAlreadyRunning is exercised against genuine sockets so
 * the AbortSignal.timeout/fetch wiring itself is proven, not just the surrounding logic). npm is NEVER
 * actually invoked here — ensureBuilt's npmAvailableFn/runNpmFn seams are always overridden with fakes,
 * so this file stays fast, offline, and safe to run in any environment regardless of whether npm/network
 * access is available.
 *
 * WHAT THIS DOES NOT COVER (by design — see the work package's own live self-check instead): main()'s
 * full end-to-end flow (real os.homedir(), a real spawned gateway/supervisor process, this project's own
 * real PROJECT_ROOT) is an integration concern exercised by actually running forge.ps1/forge.cmd/forge.sh
 * `dashboard` against a real temp HOME with a real (copied) Command Center — not re-created here with
 * heavier mocking, which would prove far less than the real run does.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  resolvePort, isAlreadyRunning, looksLikeCommandCenterHealth, findCommandCenter, installerHint, ensureBuilt, pickEntry,
} = require('./forge-cc-launch.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
async function tAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const TMP_DIRS_CREATED = [];
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  TMP_DIRS_CREATED.push(dir);
  return dir;
}
function cleanupTmpDirs() {
  for (const dir of TMP_DIRS_CREATED) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ } }
}

// Wrapped in a single async function — this is a CommonJS (.cjs) file, where top-level `await` is a
// SyntaxError (that restriction is ES-module-only); everything below needs `await` available for the two
// real-socket isAlreadyRunning checks, so the whole body runs inside `run()` instead.
async function run() {
console.log('forge-cc-launch tests (WP-P2, v2.9.0 — hermetic, no real npm/gateway invocation)');

// --- resolvePort ------------------------------------------------------------------------------------------
t('resolvePort: unset CC_PORT falls back to 4100', () => {
  assert(resolvePort({}) === 4100, 'got ' + resolvePort({}));
});
t('resolvePort: a positive numeric string is used as-is', () => {
  assert(resolvePort({ CC_PORT: '5055' }) === 5055, 'got ' + resolvePort({ CC_PORT: '5055' }));
});
t('resolvePort: "0" falls back to 4100 (not a positive number)', () => {
  assert(resolvePort({ CC_PORT: '0' }) === 4100);
});
t('resolvePort: a negative value falls back to 4100', () => {
  assert(resolvePort({ CC_PORT: '-5' }) === 4100);
});
t('resolvePort: a non-numeric value falls back to 4100', () => {
  assert(resolvePort({ CC_PORT: 'not-a-port' }) === 4100);
});
t('resolvePort: an empty string falls back to 4100', () => {
  assert(resolvePort({ CC_PORT: '' }) === 4100);
});

// --- looksLikeCommandCenterHealth (pure, no sockets) -------------------------------------------------------
// A faithful mirror of command-center/gateway/src/health.mjs's real buildHealth() shape.
const REAL_HEALTH_BODY = {
  ok: true,
  runtime: { state: 'OK' },
  gateway: { version: '0.1.0', uptime_s: 5, project_root: 'C:\\fake\\root' },
  forge: { control_center: { state: 'RETIRED' }, doctor_last: { state: 'NOT CONFIGURED' } },
  execution: { state: 'UNKNOWN' },
  captured_at: new Date().toISOString(),
  age_ms: 0,
  provenance: 'LIVE',
};
t('looksLikeCommandCenterHealth: the real gateway health shape matches', () => {
  assert(looksLikeCommandCenterHealth(REAL_HEALTH_BODY) === true);
});
t('looksLikeCommandCenterHealth: DEGRADED (ok:false) still matches — the shape, not the verdict, is what counts', () => {
  assert(looksLikeCommandCenterHealth(Object.assign({}, REAL_HEALTH_BODY, { ok: false })) === true);
});
t('looksLikeCommandCenterHealth: null/non-object/array bodies never match', () => {
  assert(looksLikeCommandCenterHealth(null) === false);
  assert(looksLikeCommandCenterHealth(undefined) === false);
  assert(looksLikeCommandCenterHealth('a string') === false);
  assert(looksLikeCommandCenterHealth([1, 2, 3]) === false);
});
t('looksLikeCommandCenterHealth: a plausible but different JSON body does not match (missing gateway.version)', () => {
  assert(looksLikeCommandCenterHealth({ ok: true, status: 'healthy', service: 'some-other-app' }) === false);
});
t('looksLikeCommandCenterHealth: missing `runtime` alone is enough to reject', () => {
  const { runtime, ...withoutRuntime } = REAL_HEALTH_BODY;
  assert(looksLikeCommandCenterHealth(withoutRuntime) === false);
});
t('looksLikeCommandCenterHealth: a non-string gateway.version is rejected', () => {
  assert(looksLikeCommandCenterHealth(Object.assign({}, REAL_HEALTH_BODY, { gateway: { version: 123 } })) === false);
});

// --- isAlreadyRunning (real sockets, no mocked fetch) — LAUNCH-1 fix: 'running'/'not-running'/'conflict' ---
await tAsync('isAlreadyRunning: state "running" when the real Command Center health shape answers', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(REAL_HEALTH_BODY));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await isAlreadyRunning(port, 1500);
    assert(result.state === 'running', 'expected state "running", got ' + JSON.stringify(result));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
await tAsync('isAlreadyRunning: state "not-running" when nothing is listening on the port', async () => {
  // Bind to an OS-assigned free port, then release it immediately — a strong (not absolute) signal that
  // nothing else is listening there for the immediately-following check.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const result = await isAlreadyRunning(port, 500);
  assert(result.state === 'not-running', 'expected state "not-running", got ' + JSON.stringify(result));
});
// LAUNCH-1's exact reported bug: a plain 404 (or any non-matching response) on the port used to count as
// "already running" — must now be reported as a "conflict", never "running", and never started over.
await tAsync('isAlreadyRunning: state "conflict" when a plain 404 answers on the port (the exact LAUNCH-1 bug)', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('not found'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await isAlreadyRunning(port, 1500);
    assert(result.state === 'conflict', 'expected state "conflict", got ' + JSON.stringify(result));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
await tAsync('isAlreadyRunning: state "conflict" when a non-Command-Center JSON body answers on the port', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'healthy', service: 'totally-unrelated-app' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await isAlreadyRunning(port, 1500);
    assert(result.state === 'conflict', 'expected state "conflict", got ' + JSON.stringify(result));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- findCommandCenter -------------------------------------------------------------------------------------
t('findCommandCenter: returns null when neither project-local nor central exists', () => {
  const projectRoot = mkTmp('ccl-none-project');
  const homeDir = mkTmp('ccl-none-home');
  assert(findCommandCenter(projectRoot, homeDir) === null);
});
t('findCommandCenter: finds a project-local command-center/gateway/bin.mjs', () => {
  const projectRoot = mkTmp('ccl-local-project');
  const homeDir = mkTmp('ccl-local-home');
  const gwDir = path.join(projectRoot, 'command-center', 'gateway');
  fs.mkdirSync(gwDir, { recursive: true });
  fs.writeFileSync(path.join(gwDir, 'bin.mjs'), '// fixture');
  const found = findCommandCenter(projectRoot, homeDir);
  assert(found && found.origin === 'project-local', JSON.stringify(found));
  assert(found.root === path.join(projectRoot, 'command-center'), found.root);
});
t('findCommandCenter: falls back to the central template copy when there is no project-local one', () => {
  const projectRoot = mkTmp('ccl-central-project');
  const homeDir = mkTmp('ccl-central-home');
  const gwDir = path.join(homeDir, '.claude', 'forge', 'template', 'command-center', 'gateway');
  fs.mkdirSync(gwDir, { recursive: true });
  fs.writeFileSync(path.join(gwDir, 'bin.mjs'), '// fixture');
  const found = findCommandCenter(projectRoot, homeDir);
  assert(found && found.origin === 'central', JSON.stringify(found));
});
t('findCommandCenter: project-local takes priority when BOTH exist', () => {
  const projectRoot = mkTmp('ccl-both-project');
  const homeDir = mkTmp('ccl-both-home');
  const localGw = path.join(projectRoot, 'command-center', 'gateway');
  fs.mkdirSync(localGw, { recursive: true });
  fs.writeFileSync(path.join(localGw, 'bin.mjs'), '// fixture');
  const centralGw = path.join(homeDir, '.claude', 'forge', 'template', 'command-center', 'gateway');
  fs.mkdirSync(centralGw, { recursive: true });
  fs.writeFileSync(path.join(centralGw, 'bin.mjs'), '// fixture');
  const found = findCommandCenter(projectRoot, homeDir);
  assert(found.origin === 'project-local', JSON.stringify(found));
});

// --- installerHint -----------------------------------------------------------------------------------------
t('installerHint: win32 names install.ps1', () => {
  assert(installerHint('win32') === 'install.ps1');
});
t('installerHint: darwin/linux name install.sh', () => {
  assert(installerHint('darwin') === 'install.sh');
  assert(installerHint('linux') === 'install.sh');
});

// --- pickEntry ---------------------------------------------------------------------------------------------
t('pickEntry: prefers gateway/supervisor.mjs when it exists', () => {
  const ccRoot = mkTmp('ccl-entry-sup');
  fs.mkdirSync(path.join(ccRoot, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(ccRoot, 'gateway', 'supervisor.mjs'), '// fixture');
  fs.writeFileSync(path.join(ccRoot, 'gateway', 'bin.mjs'), '// fixture');
  assert(pickEntry(ccRoot) === path.join(ccRoot, 'gateway', 'supervisor.mjs'));
});
t('pickEntry: falls back to gateway/bin.mjs when there is no supervisor', () => {
  const ccRoot = mkTmp('ccl-entry-bin');
  fs.mkdirSync(path.join(ccRoot, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(ccRoot, 'gateway', 'bin.mjs'), '// fixture');
  assert(pickEntry(ccRoot) === path.join(ccRoot, 'gateway', 'bin.mjs'));
});

// --- ensureBuilt (npm always faked via injected seams — never a real npm process) ---------------------------
t('ensureBuilt: dist/index.html already present -> ok, built:false, npm never consulted', () => {
  const ccRoot = mkTmp('ccl-build-already');
  const distDir = path.join(ccRoot, 'dashboard', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
  let calls = 0;
  const res = ensureBuilt(ccRoot, { npmAvailableFn: () => { calls++; return true; } });
  assert(res.ok === true && res.built === false, JSON.stringify(res));
  assert(calls === 0, 'npmAvailableFn should never be called when dist already exists');
});
t('ensureBuilt: no dashboard/package.json at all -> honest failure naming the installer', () => {
  const ccRoot = mkTmp('ccl-build-nopkg');
  fs.mkdirSync(path.join(ccRoot, 'dashboard'), { recursive: true });
  const res = ensureBuilt(ccRoot);
  assert(res.ok === false, JSON.stringify(res));
  assert(/install\.(ps1|sh)/.test(res.reason), 'reason should name an installer: ' + res.reason);
});
t('ensureBuilt: package.json exists but npm is unavailable -> honest failure naming npm', () => {
  const ccRoot = mkTmp('ccl-build-nonpm');
  fs.mkdirSync(path.join(ccRoot, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(ccRoot, 'dashboard', 'package.json'), '{}');
  const res = ensureBuilt(ccRoot, { npmAvailableFn: () => false });
  assert(res.ok === false, JSON.stringify(res));
  assert(/npm/i.test(res.reason), res.reason);
});
t('ensureBuilt: uses "npm ci" when package-lock.json exists', () => {
  const ccRoot = mkTmp('ccl-build-ci');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dashboardDir, 'package-lock.json'), '{}');
  const calls = [];
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args, cwd) => {
      calls.push(args.join(' '));
      if (args[0] === 'run' && args[1] === 'build') {
        fs.mkdirSync(path.join(dashboardDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(dashboardDir, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, error: null };
    },
  });
  assert(res.ok === true && res.built === true, JSON.stringify(res));
  assert(calls[0] === 'ci', 'expected first npm call to be "ci", got: ' + calls[0]);
  assert(calls[1] === 'run build', 'expected second npm call to be "run build", got: ' + calls[1]);
});
t('ensureBuilt: uses "npm install" when there is no lockfile', () => {
  const ccRoot = mkTmp('ccl-build-install');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const calls = [];
  ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(dashboardDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(dashboardDir, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, error: null };
    },
  });
  assert(calls[0] === 'install', 'expected first npm call to be "install", got: ' + calls[0]);
});
t('ensureBuilt: install failure stops before ever running the build step', () => {
  const ccRoot = mkTmp('ccl-build-installfail');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const calls = [];
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args) => { calls.push(args.join(' ')); return { status: 1, error: null }; },
  });
  assert(res.ok === false, JSON.stringify(res));
  assert(/npm install failed/.test(res.reason), res.reason);
  assert(calls.length === 1, 'the build step must not run after a failed install; calls=' + JSON.stringify(calls));
});
t('ensureBuilt: build-step failure is reported honestly', () => {
  const ccRoot = mkTmp('ccl-build-buildfail');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args) => (args[0] === 'install' ? { status: 0, error: null } : { status: 1, error: null }),
  });
  assert(res.ok === false, JSON.stringify(res));
  assert(/npm run build failed/.test(res.reason), res.reason);
});
t('ensureBuilt: a "successful" build that never actually produced dist/index.html is still reported as a failure', () => {
  const ccRoot = mkTmp('ccl-build-silentfail');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: () => ({ status: 0, error: null }), // exits 0 but never writes dist/index.html
  });
  assert(res.ok === false, JSON.stringify(res));
  assert(/dist\/index\.html/.test(res.reason), res.reason);
});

// Verify Boss V-03 / V03-a / V03-b: on a port conflict the launcher gives no manual step and
// claims no start it does not perform. The dashboard page and the gateway's allowed origins are fixed to port
// 4100, so the Command Center is NOT moved to another port; Forge leaves the occupant alone and continues
// without the dashboard. Real run: a stand-in server holds a test port (never 4100), the launcher runs as a
// child with CC_PORT set to it, and must exit 1 without starting anything.
await tAsync('V-03: a port conflict exits 1 with an honest message, no manual step and no false start claim', async () => {
  const { spawn } = require('child_process');
  const methods = [];
  const srv = http.createServer((req, res) => { methods.push(req.method); res.writeHead(404); res.end('not here'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const env = Object.assign({}, process.env, { CC_PORT: String(port), CC_DISCORD_AUTOSTART: 'off' });
    const child = spawn(process.execPath, [path.join(__dirname, 'forge-cc-launch.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('launcher did not exit within 20s: ' + out)); }, 20000);
      child.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert(code === 1, 'expected exit 1, got ' + code + ': ' + out);
    assert(/not the Forge Command Center/.test(out), out);
    assert(/continues without the dashboard/i.test(out), 'must say Forge continues without the dashboard: ' + out);
    assert(!/free the port|and try again/i.test(out), 'must not ask the reader to free the port: ' + out);
    assert(!/on a free port|starts the Command Center/i.test(out), 'must not claim a start nothing performs: ' + out);
    assert(methods.length > 0 && methods.every((m) => m === 'GET'), 'the occupant may only be probed with GET: ' + methods.join(','));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// FU-STEP2 (Security Boss Step 2, decision A-prime): the dashboard credential is an out-of-band HttpOnly cookie.
// The launcher makes the UI session secret and a one-time pairing code, hands both to the gateway through its
// environment (never argv), and prints http://127.0.0.1:<port>/?pair=<code>; the gateway swaps the code once,
// within 120 s, for the cookie. The launcher module is read as a whole object so each test fails on its own on
// the code from before this change.
const launch = require('./forge-cc-launch.cjs');

t('FU-STEP2: makePairing gives a 64-hex secret, a 48-hex one-time code and a 120 s expiry, as gateway env', () => {
  assert(typeof launch.makePairing === 'function', 'makePairing must be exported');
  let n = 0;
  const p = launch.makePairing({ now: 1000, randomBytes: (len) => Buffer.alloc(len, ++n) });
  assert(p.secret === '01'.repeat(32), 'secret from the first 32 bytes: ' + p.secret);
  assert(p.code === '02'.repeat(24), 'code from the next 24 bytes: ' + p.code);
  assert(p.expiresAt === 121000, 'expires 120 s after now: ' + p.expiresAt);
  assert(JSON.stringify(Object.keys(p.env).sort()) === JSON.stringify(['FORGE_UI_PAIRING_CODE', 'FORGE_UI_SESSION_SECRET']), Object.keys(p.env).join(','));
  assert(p.env.FORGE_UI_SESSION_SECRET === p.secret);
  assert(p.env.FORGE_UI_PAIRING_CODE === p.code + '.121000', p.env.FORGE_UI_PAIRING_CODE);
  const real1 = launch.makePairing();
  const real2 = launch.makePairing();
  assert(/^[0-9a-f]{64}$/.test(real1.secret) && /^[0-9a-f]{48}$/.test(real1.code), 'real randomness, hex');
  assert(real1.secret !== real2.secret && real1.code !== real2.code, 'new values every run');
});

t('FU-STEP2: pairingLink is the gateway root with only the code as query', () => {
  assert(typeof launch.pairingLink === 'function', 'pairingLink must be exported');
  assert(launch.pairingLink('http://127.0.0.1:4100', 'abc123') === 'http://127.0.0.1:4100/?pair=abc123');
});

t('FU-STEP2: gatewayEnv adds the default project and the pairing env, drops any inherited FORGE_UI_* (any case), never mutates its input', () => {
  assert(typeof launch.gatewayEnv === 'function', 'gatewayEnv must be exported');
  const base = { PATH: 'p', forge_ui_session_secret: 'stale', FORGE_UI_PAIRING_CODE: 'stale-code', CC_PORT: '4100' };
  const frozen = JSON.stringify(base);
  const pairing = launch.makePairing({ now: 5, randomBytes: (len) => Buffer.alloc(len, 7) });
  const env = launch.gatewayEnv(base, 'C:\\proj', pairing);
  assert(JSON.stringify(base) === frozen, 'input untouched');
  assert(env.PATH === 'p' && env.CC_PORT === '4100', 'the rest is kept');
  assert(env.FORGE_CC_DEFAULT_PROJECT === 'C:\\proj');
  const uiKeys = Object.keys(env).filter((k) => k.toUpperCase().startsWith('FORGE_UI_'));
  assert(JSON.stringify(uiKeys.sort()) === JSON.stringify(['FORGE_UI_PAIRING_CODE', 'FORGE_UI_SESSION_SECRET']), uiKeys.join(','));
  assert(env.FORGE_UI_SESSION_SECRET === pairing.secret && env.FORGE_UI_PAIRING_CODE === pairing.env.FORGE_UI_PAIRING_CODE);
  const noProject = launch.gatewayEnv(base, null, pairing);
  assert(!('FORGE_CC_DEFAULT_PROJECT' in noProject), 'no project root: no default project');
});

t('FU-STEP2: the start and already-running texts say how to pair, and never print the secret', () => {
  assert(typeof launch.pairingLines === 'function' && typeof launch.alreadyRunningPairingLines === 'function', 'both text helpers must be exported');
  const pairing = launch.makePairing({ now: 0, randomBytes: (len) => Buffer.alloc(len, 9) });
  const start = launch.pairingLines('http://127.0.0.1:4100', pairing).join('\n');
  assert(start.includes('http://127.0.0.1:4100/?pair=' + pairing.code), start);
  assert(/once/i.test(start) && /2 minutes/.test(start), 'single use and 2 minutes are named: ' + start);
  assert(!start.includes(pairing.secret), 'the secret is never printed');
  const running = launch.alreadyRunningPairingLines().join('\n');
  assert(/forge dashboard/.test(running) && /pairing link/i.test(running), running);
});

// Security fix round (Security Boss FAIL, HIGH): the gateway trusts the Vite dev origins (:5173) only with the dev
// switch FORGE_DEV_ORIGINS=1. The launcher never sets it itself; a switch the developer set is passed on, and the
// launcher then says so out loud (never a silent dev mode).
t('FU-STEP2 fix: devOriginsLines warns only when the gateway will trust the Vite dev origins', () => {
  assert(typeof launch.devOriginsLines === 'function', 'devOriginsLines must be exported');
  for (const env of [{}, { FORGE_DEV_ORIGINS: '' }, { FORGE_DEV_ORIGINS: '0' }, { FORGE_DEV_ORIGINS: 'true' }, { PATH: 'p' }]) {
    assert(launch.devOriginsLines(env).length === 0, 'no warning for ' + JSON.stringify(env));
  }
  for (const env of [{ FORGE_DEV_ORIGINS: '1' }, { FORGE_DEV_ORIGINS: ' 1 ' }, { forge_dev_origins: '1' }]) {
    const text = launch.devOriginsLines(env).join(' ');
    assert(/FORGE_DEV_ORIGINS/.test(text) && /5173/.test(text), 'the warning names the switch and the port: ' + text);
    assert(/development/i.test(text), 'the warning says it is for development only: ' + text);
  }
});

t('FU-STEP2 fix: gatewayEnv never ADDS the dev switch; a switch the developer set is passed on unchanged', () => {
  const pairing = launch.makePairing({ now: 1, randomBytes: (len) => Buffer.alloc(len, 3) });
  const plain = launch.gatewayEnv({ PATH: 'p' }, null, pairing);
  assert(!Object.keys(plain).some((k) => k.toUpperCase() === 'FORGE_DEV_ORIGINS'), 'not set by the launcher');
  const dev = launch.gatewayEnv({ PATH: 'p', FORGE_DEV_ORIGINS: '1' }, null, pairing);
  assert(dev.FORGE_DEV_ORIGINS === '1', 'an explicit developer switch is kept');
});

// The contract with the real gateway (command-center/gateway): a real bin.mjs on a free port and a temp data dir gets
// the launcher's env and swaps the printed code for a cookie whose value is the secret. Stopped by its exact handle.
// A Forge project without its own command-center/ (an installed copy of forge-bin) skips this one, visibly.
const PAIR_CC = findCommandCenter(launch.PROJECT_ROOT, os.homedir());
if (!PAIR_CC || PAIR_CC.origin !== 'project-local') {
  console.log('  skip FU-STEP2 real-gateway pairing contract: no project-local command-center/gateway here');
} else await tAsync('FU-STEP2: a real gateway started with gatewayEnv swaps the printed pairing link once for the cookie', async () => {
  assert(typeof launch.makePairing === 'function' && typeof launch.gatewayEnv === 'function', 'makePairing/gatewayEnv must be exported');
  const found = PAIR_CC;
  const { spawn } = require('child_process');
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const dataDir = mkTmp('cc-launch-pair');
  const pairing = launch.makePairing();
  const env = launch.gatewayEnv(Object.assign({}, process.env, {
    CC_PORT: String(port), FORGE_DATA_DIR: dataDir, CC_DISCORD_AUTOSTART: 'off', CC_EXEC_MOCK: '1',
  }), null, pairing);
  const child = spawn(process.execPath, [path.join(found.root, 'gateway', 'bin.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const get = (urlPath, headers) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway did not listen within 30s: ' + out.slice(-800))), 30000);
      const check = () => { if (/gateway listening http:\/\/127\.0\.0\.1:\d+/.test(out)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', check);
      child.on('exit', (c) => { clearTimeout(timer); reject(new Error('gateway exited early (' + c + '): ' + out.slice(-800))); });
      check();
    });
    const link = launch.pairingLink('http://127.0.0.1:' + port, pairing.code);
    const first = await get(link.slice(('http://127.0.0.1:' + port).length), { 'Sec-Fetch-Site': 'none' });
    const cookie = [].concat(first.headers['set-cookie'] || [])[0] || '';
    assert(first.status === 302 && first.headers.location === '/', 'swap answers 302 to /: ' + first.status);
    assert(cookie.split(';')[0] === 'forge_ui=' + pairing.secret, 'the cookie carries the launcher secret');
    assert(/HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\//.test(cookie), cookie.replace(pairing.secret, '<secret>'));
    const second = await get(link.slice(('http://127.0.0.1:' + port).length), { 'Sec-Fetch-Site': 'none' });
    assert(!second.headers['set-cookie'], 'the printed link works once');
    assert(!out.includes(pairing.secret) && !out.includes(pairing.code), 'the gateway never logs the secret or the code');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
  }
});

cleanupTmpDirs();
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('forge-cc-launch.test.cjs: unexpected error — ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
