// (feat-discord-gateway) — the genuinely-real spawn tests: actually launch the imported bot
// (command-center/discord/src/main.js) as a real child process, with TRANSPORT=mock/RUNNER=fake and
// an isolated ephemeral port + temp state dir per test — NEVER the real Discord token, NEVER the
// real port 3979 (where the owner's separately-run LIVE instance lives right now). These prove the
// real spawn/health-merge/stop wiring end-to-end, not just the mocked unit logic in
// discord-service.test.mjs.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDiscordStatus,
  startDiscordService,
  stopDiscordService,
  _setDiscordPathsForTests,
  _setExtraEnvOverridesForTests,
  _setFetchFnForTests,
  _setNpmInstallRunnerForTests,
  _resetDiscordServiceForTests,
  _resetDiscordDepsInstallStateForTests,
} from '../src/discord-service.mjs';
import { DISCORD_DIR, DISCORD_MAIN_JS, DISCORD_ENV_EXAMPLE_FILE } from '../src/paths.mjs';

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function pollUntil(fn, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('pollUntil timed out — last status: ' + JSON.stringify(last));
}

const tempDirs = [];

/** Fresh isolated real-bot setup for ONE test: own free port, own temp state dir, own temp .env —
 *  never shared across tests (avoids any port/state race between the two real-spawn tests below). */
async function setupRealBot() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-real-spawn-test-'));
  tempDirs.push(tempDir);
  const testPort = await findFreePort();
  const envFile = path.join(tempDir, '.env');
  fs.writeFileSync(envFile, `TRANSPORT=mock\nBOT_HTTP_PORT=${testPort}\n`, 'utf8');
  _setDiscordPathsForTests({
    discordDir: DISCORD_DIR, // real command-center/discord
    mainJs: DISCORD_MAIN_JS, // the REAL imported bot entry point
    envFile, // synthetic — never the real .env (no token ever read here)
    envExampleFile: DISCORD_ENV_EXAMPLE_FILE,
    stateDir: path.join(tempDir, 'state'),
    logFile: path.join(tempDir, 'discord-bot.log'),
  });
  _setExtraEnvOverridesForTests({
    TRANSPORT: 'mock',
    RUNNER: 'fake',
    BOT_HTTP_PORT: String(testPort),
    STATE_DIR: path.join(tempDir, 'state'),
    OWNER_USER_IDS: '',
    DISCORD_BOT_TOKEN: '',
    DISCORD_GUILD_ID: '',
  });
  // WP-NONET: a test must never run a real `npm ci` (network + ~3,100 files in the real
  // command-center/discord/node_modules). TRANSPORT=mock never imports discord.js (it is a lazy
  // `await import` only on the real Discord transport), so on a clean checkout without
  // node_modules this injected runner simply reports success without touching disk or network.
  // On a dev checkout that already has discord.js installed it is never called at all.
  _setNpmInstallRunnerForTests((command, args, options, callback) => {
    queueMicrotask(() => callback(null, '', ''));
    return { pid: 0 };
  });
  return { testPort };
}

afterEach(async () => {
  await stopDiscordService(); // best-effort cleanup if a test failed mid-way
  _resetDiscordServiceForTests();
  _resetDiscordDepsInstallStateForTests();
});

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('REAL spawn (mock transport): start actually launches the imported bot; status merges live pid+health; stop actually terminates it', async () => {
  await setupRealBot();
  const started = await startDiscordService();
  assert.equal(started.ok, true, 'start failed: ' + JSON.stringify(started));
  assert.equal(started.status, 202);
  assert.equal(typeof started.pid, 'number');

  // The real child's own health-server needs a moment to bind + reach phase 'ready' — poll rather
  // than a fixed sleep, bounded at 8s (generous for a mock-transport boot on this machine).
  const readyStatus = await pollUntil(async () => {
    const s = await getDiscordStatus();
    return s.health && s.health.phase === 'ready' ? s : null;
  });

  assert.equal(readyStatus.running, true);
  assert.equal(readyStatus.pid, started.pid);
  assert.equal(readyStatus.health.pid, started.pid, "the real child's own reported pid must match the tracked pid");
  assert.equal(readyStatus.health.live, true);
  assert.equal(readyStatus.transport, 'mock');
  assert.equal(readyStatus.conflict, null, 'no conflict should be reported for a service THIS gateway itself started');

  const stopped = await stopDiscordService();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);

  const afterStop = await pollUntil(async () => {
    const s = await getDiscordStatus();
    return s.running === false && s.health === null ? s : null;
  });
  assert.equal(afterStop.running, false);
  assert.equal(afterStop.pid, null);
  assert.equal(afterStop.health, null);
});

// The test above's stop() succeeds via the bot's OWN graceful `POST /api/shutdown` path — it never
// actually proves the force-kill (killChildTree) fallback works, since the graceful path wins the
// race every time in the happy case (caught live during this WP's own RED-proof pass: neutralizing
// killChildTree entirely still left the happy-path test green). This test forces the graceful path
// to fail (a stubbed fetch that only intercepts the '/api/shutdown' URL — the health-check GETs
// still hit the REAL child) so stop() has no choice but to fall through to the real OS-level
// taskkill/tree-kill, then proves the real child process is actually gone via a genuine
// (non-stubbed) health probe.
test('REAL spawn (mock transport): when the graceful shutdown path is unavailable, stop() force-kills the real child process', async () => {
  await setupRealBot();
  const started = await startDiscordService();
  assert.equal(started.ok, true, 'start failed: ' + JSON.stringify(started));

  await pollUntil(async () => {
    const s = await getDiscordStatus();
    return s.health && s.health.phase === 'ready' ? s : null;
  });

  const realFetch = fetch;
  _setFetchFnForTests(async (url, opts) => {
    if (String(url).includes('/api/shutdown')) throw new Error('simulated: graceful shutdown endpoint unreachable');
    return realFetch(url, opts);
  });

  const stopped = await stopDiscordService();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);

  // Real (non-stubbed-for-shutdown) health probe: proves the OS process is genuinely gone, reached
  // ONLY via the real killChildTree taskkill/tree-kill path this time.
  const afterStop = await pollUntil(async () => {
    const s = await getDiscordStatus();
    return s.health === null ? s : null;
  });
  assert.equal(afterStop.health, null, 'the real child must actually be dead — proven via a real (non-stubbed) health probe');
});
