#!/usr/bin/env node
// Entry point: starts the Forge Compatibility Gateway bound to 127.0.0.1 ONLY.
// Port (WP B1a): CC_PORT (or FORGE_GATEWAY_PORT) pins the port strictly. Unset, the
// gateway tries 4100; when 4100 is taken by something that is NOT this same gateway it falls back to
// a free loopback port. Either way it prints one machine-readable line for the Electron main process:
//   gateway listening http://127.0.0.1:<port>
// B1a rework: one gateway per data dir is guaranteed by <data dir>/gateway.lock (runtime-state.mjs),
// taken BEFORE any port is bound and independent of the port; a live owner -> exit 3. The 4100 probe
// is a second line only, for gateways from before the lock, and it fails closed: no answer -> EADDRINUSE.
import http from 'node:http';
import {
  SYNC_SCAN_ROOTS, PROJECT_ROOT, COMMAND_CENTER_DATA_DIR, DEFAULT_COMMAND_CENTER_DATA_DIR, isSameResolvedPath,
} from './src/paths.mjs';
import {
  configuredGatewayPort, preferredGatewayPort, GATEWAY_HOST, setGatewayPort, isSameGatewayHealth,
  acquireDataDirLock, updateDataDirLockPort, releaseDataDirLock, lockRefusalMessage, LOCK_REFUSED_EXIT_CODE,
} from './src/runtime-state.mjs';

const PINNED_PORT = configuredGatewayPort();
const PREFERRED_PORT = preferredGatewayPort();
const HOST = GATEWAY_HOST;
// A busy gateway can take longer than the first window to answer /api/health; one longer retry
// before the probe gives up and the start fails closed.
const PROBE_TIMEOUTS_MS = [1500, 5000];

// WP10 should-fix-now #9 (AP-4, HIGH), defence-in-depth layer: static.mjs now guards its own
// decodeURIComponent() call (the actual fix), but this handler exists so that ANY future
// unforeseen synchronous throw inside a request handler logs honestly and keeps the gateway
// serving, instead of the whole process dying on one malformed request. This is a safety net,
// never a substitute for fixing the real throw site — a crash that reaches here is still a bug.
// AUDIT G8.1: "log + serveer door" liet de gateway na een uncaught met mogelijk
// gecorrumpeerde in-memory-staat doorleven terwijl /api/health groen bleef en de supervisor (die
// alleen op proces-exit reageert) nooit ingreep. Nu: markeer DEGRADED (health wordt rood), weiger
// nieuwe verbindingen, geef lopende executies een begrensde drain (10s) en exit(1) — de SUPERVISOR
// is de enige herstart-autoriteit (supervisor.mjs: backoff + crash-loop-brake bestaan al).
const DRAIN_MS = 10000;
let drainStarted = false;
/** degradeAndDrain (r4 #13, r5 #28/#29): de reentrancy-guard, de exitcode ÉN de
 *  exit-deadline staan VÓÓR elke await — faalt zelfs de runtime-state-import, dan eindigt het proces
 *  hoe dan ook binnen het drain-venster met code 1 (de timer is bewust NIET ge-unref'd: hij MOET het
 *  proces levend houden tot de exit). Kills worden afgewacht (Promise-based, met eigen deadline) zodat
 *  de supervisor geen verse gateway naast nog levende oude kinderen start. */
async function degradeAndDrain(kind, err) {
  process.exitCode = 1; // SYNCHROON, voor enige await — ook een importfout eindigt dan met 1
  console.error('Forge Command Center gateway: ' + kind + ' — runtime DEGRADED, gecontroleerde drain gestart:', err && err.stack ? err.stack : err);
  if (drainStarted) return;
  drainStarted = true;
  // gegarandeerde exit-deadline: referenced (geen unref) — dit is nu het maximum-leven van het proces
  setTimeout(() => {
    console.error('Forge Command Center gateway: drain-venster (' + DRAIN_MS + 'ms) voorbij — exit(1) zodat de supervisor een verse gateway start');
    process.exit(1);
  }, DRAIN_MS);
  try {
    try {
      const { markUncaught, markDraining } = await import('./src/runtime-state.mjs');
      markUncaught(err);
      markDraining();
    } catch (e) { console.error('drain: runtime-state-markering faalde (door met drain): ' + (e && e.message)); }
    await stopActiveWork(kind, Math.max(2000, DRAIN_MS - 3000));
  } finally {
    // niets meer te doen: niet op het drain-venster wachten
    process.exit(1);
  }
}
/** Shared by the fatal drain and the normal stop: close the listener, interrupt running executions (tree-kill)
 *  and wait, bounded, until those children are gone, then stop the Discord service. Never throws. */
async function stopActiveWork(kind, waitMs) {
  try { if (globalThis.__forgeGatewayServer && typeof globalThis.__forgeGatewayServer.close === 'function') globalThis.__forgeGatewayServer.close(); } catch { /* drain gaat door */ }
  try {
    const lc = await import('./src/exec-lifecycle.mjs');
    lc.enterDrainMode(kind);
    const interrupted = lc.interruptAllExecutions(kind);
    if (interrupted.length) {
      console.error('Forge Command Center gateway: ' + interrupted.length + ' lopende executie(s) interrupted + tree-kill gestart: ' + interrupted.map((i) => i.convId + '#' + i.pid).join(', '));
      // r5 #28: wacht (begrensd) tot de kinderen echt weg zijn — geen verse gateway naast oude schrijvers
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + waitMs;
      while (interrupted.some((i) => i.pid && alive(i.pid)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      const survivors = interrupted.filter((i) => i.pid && alive(i.pid));
      if (survivors.length) console.error('drain: ' + survivors.length + ' kind(eren) nog levend na de kill-deadline: ' + survivors.map((i) => i.pid).join(',') + ' — exit volgt toch; supervisor-log draagt dit eerlijk');
      else console.error('drain: alle geinterrumpeerde kinderen zijn aantoonbaar beeindigd');
    }
  } catch (e) { console.error('drain: exec-interrupt faalde (door met exit): ' + (e && e.message)); }
  try {
    const ds = await import('./src/discord-service.mjs');
    const r = await ds.stopDiscordService();
    console.error('Forge Command Center gateway: Discord-service gestopt bij ' + kind + ' (' + JSON.stringify(r).slice(0, 120) + ')');
  } catch (e) { console.error('drain: discord-stop faalde (door met exit): ' + (e && e.message)); }
}

// Normal stop (WP B8-3). On Windows the desktop cannot send a signal a handler would see: child.kill() and
// taskkill /F terminate the process outright, and a forced TerminateProcess always reports exit code 1, which
// made every normal app close look like a gateway failure. The desktop therefore spawns the gateway with a
// Node IPC channel and sends { type: 'forge-gateway-stop' }; the channel closing (the app died) means the same.
// SIGTERM covers POSIX. A normal stop exits 0, also when its bounded window runs out (it was asked to stop).
const STOP_MS = 8000;
let stopStarted = false;
async function normalStop(reason) {
  if (stopStarted || drainStarted) return;
  stopStarted = true;
  console.log('Forge Command Center gateway: normal shutdown requested (' + reason + ')');
  setTimeout(() => {
    console.error('Forge Command Center gateway: stop window (' + STOP_MS + 'ms) passed; exiting anyway');
    process.exit(0);
  }, STOP_MS);
  try {
    try { (await import('./src/runtime-state.mjs')).markDraining(); } catch { /* the stop goes on */ }
    await stopActiveWork('gateway stopped', STOP_MS - 2000);
  } finally {
    process.exit(0); // the 'exit' handler below releases the data-dir lock
  }
}
function installStopHandlers() {
  process.on('SIGTERM', () => { void normalStop('SIGTERM'); });
  if (typeof process.send !== 'function') return; // no IPC channel: started from a terminal or the supervisor
  process.on('message', (msg) => {
    if (msg && typeof msg === 'object' && msg.type === 'forge-gateway-stop') void normalStop('desktop');
  });
  process.on('disconnect', () => { void normalStop('parent disconnected'); });
}

// TESTHAAK (alleen actief met CC_TEST_THROW_AFTER_MS gezet — nooit in productie): injecteert een echte
// uncaught throw zodat de drain-keten (readiness-rood -> weiger nieuw -> begrensde drain -> exit(1) ->
// supervisor-herstart) met een ECHT proces getest kan worden i.p.v. alleen op papier te bestaan.
if (Number(process.env.CC_TEST_THROW_AFTER_MS) > 0) {
  setTimeout(() => { throw new Error('CC_TEST_THROW_AFTER_MS fault-injection'); }, Number(process.env.CC_TEST_THROW_AFTER_MS));
}
process.on('uncaughtException', (err) => { void degradeAndDrain('uncaught exception', err); });
process.on('unhandledRejection', (reason) => { void degradeAndDrain('unhandled rejection', reason); });

// Data-dir lock first, before the server module loads and before any port is bound.
let lockResult;
try {
  lockResult = acquireDataDirLock(COMMAND_CENTER_DATA_DIR);
} catch (err) {
  console.error('Forge Command Center gateway failed to start: could not take the data-dir lock in ' + COMMAND_CENTER_DATA_DIR + ': ' + (err && err.message ? err.message : err));
  process.exit(1);
}
if (!lockResult.ok) {
  console.error('Forge Command Center gateway: ' + lockRefusalMessage(lockResult));
  process.exit(LOCK_REFUSED_EXIT_CODE);
}
process.on('exit', () => { releaseDataDirLock(); });
installStopHandlers();
const { createServer } = await import('./src/server.mjs');
const { runAskBootScan } = await import('./src/ask-boot-scan.mjs');

/** One GET /api/health; resolves { answered: false } on a timeout or connection error, otherwise
 *  { answered: true, body } with body = parsed JSON or null. Never rejects. */
function probeHealthOnce(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, path: '/api/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => { try { resolve({ answered: true, body: JSON.parse(body) }); } catch { resolve({ answered: true, body: null }); } });
      res.on('error', () => resolve({ answered: false }));
    });
    req.on('error', () => resolve({ answered: false }));
    req.on('timeout', () => { req.destroy(); resolve({ answered: false }); });
    req.end();
  });
}

async function probeHealth(port) {
  let r = { answered: false };
  for (const timeoutMs of PROBE_TIMEOUTS_MS) {
    r = await probeHealthOnce(port, timeoutMs);
    if (r.answered) return r;
  }
  return r;
}

const OUR_GATEWAY = Object.freeze({
  dataDir: COMMAND_CENTER_DATA_DIR,
  projectRoot: PROJECT_ROOT,
  usesDefaultDataDir: isSameResolvedPath(COMMAND_CENTER_DATA_DIR, DEFAULT_COMMAND_CENTER_DATA_DIR),
  samePath: isSameResolvedPath,
});

function listenOnce(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { srv.off('listening', onListening); reject(err); };
    const onListening = () => { srv.off('error', onError); resolve(); };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, HOST);
  });
}

async function bindGateway(srv) {
  if (PINNED_PORT !== null) return listenOnce(srv, PINNED_PORT);
  try {
    return await listenOnce(srv, PREFERRED_PORT);
  } catch (err) {
    if (!err || err.code !== 'EADDRINUSE') throw err;
    const probe = await probeHealth(PREFERRED_PORT);
    if (!probe.answered) {
      // Fail closed: a holder that does not answer may be a busy gateway from before the data-dir
      // lock on this same data. EADDRINUSE keeps the supervisor's fast-stop working.
      err.message = 'EADDRINUSE: port ' + PREFERRED_PORT + ' is taken and its holder did not answer /api/health; not falling back (' + err.message + ')';
      throw err;
    }
    if (isSameGatewayHealth(probe.body, OUR_GATEWAY)) {
      err.message = 'EADDRINUSE: a gateway with this same data dir already listens on port ' + PREFERRED_PORT + ' (' + err.message + ')';
      throw err;
    }
    console.error('Forge Command Center gateway: port ' + PREFERRED_PORT + ' is taken by another process; falling back to a free loopback port');
    return listenOnce(srv, 0);
  }
}

const server = createServer();
globalThis.__forgeGatewayServer = server; // drain-handle voor de uncaught-afhandeling (G8.1)
bindGateway(server).then(onListening, (err) => {
  console.error('Forge Command Center gateway failed to start:', err && err.message ? err.message : err);
  process.exit(1);
});

function onListening() {
  server.on('error', (err) => {
    console.error('Forge Command Center gateway server error:', err && err.message ? err.message : err);
    process.exit(1);
  });
  const port = server.address().port;
  setGatewayPort(port);
  try { updateDataDirLockPort(port); } catch (err) {
    console.error('Forge Command Center gateway: could not record the port in the data-dir lock (the lock still holds): ' + (err && err.message ? err.message : err));
  }
  console.log('gateway listening http://' + HOST + ':' + port);
  console.log('Forge Command Center gateway listening on http://' + HOST + ':' + port);
  console.log('Forge Command Center gateway: data dir: ' + COMMAND_CENTER_DATA_DIR);
  // A3 fix (2026-09-26 laptop re-audit): project discovery now scans several roots
  // (paths.mjs's SYNC_SCAN_ROOTS) — print the real, active list exactly once per real boot so an
  // operator can see (and a support log can show) what was actually scanned, including whether a
  // CC_PROJECTS_EXTRA_ROOT value was accepted or silently ignored (that rejection, if any, was
  // already logged by paths.mjs itself at import time, above this line).
  console.log('Forge Command Center gateway: project scan roots: ' + SYNC_SCAN_ROOTS.join(', '));
  // fix-ghost-asks item 2: runs AFTER the "listening" line above is already printed and the port is
  // already bound — this scan is deliberately NOT on the critical path to "the gateway is up" (see
  // ask-boot-scan.mjs's own header for the real file/byte bound this relies on to stay fast).
  // Best-effort: a scan failure degrades to a logged warning, never a dead gateway.
  try {
    const result = runAskBootScan();
    if (result.abandonedCount > 0) {
      console.log('[ask-boot-scan] closed out ' + result.abandonedCount + ' dangling ask(s) left over from a previous boot');
    }
  } catch (err) {
    console.error('Forge Command Center gateway: ask boot scan failed (server stays up):', err && err.stack ? err.stack : err);
  }
  // WP-DA: bring the owner's Discord bot back by itself (after a reboot, or after this gateway
  // was restarted by the supervisor, whose drain stops the bot). Off paths are explained in the log and
  // in GET /api/discord/status; see discord-autostart.mjs for the exact rule. Never blocks startup and
  // never takes the gateway down. A temp/test gateway sets CC_DISCORD_AUTOSTART=off.
  import('./src/discord-autostart.mjs')
    .then((m) => m.autostartDiscordOnBoot())
    .then((r) => console.log('[discord-autostart] ' + r.outcome + ': ' + r.detail))
    .catch((err) => console.error('Forge Command Center gateway: Discord autostart failed (server stays up):', err && err.message ? err.message : err));
}
