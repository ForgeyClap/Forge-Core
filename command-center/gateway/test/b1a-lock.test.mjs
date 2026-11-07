// WP B1a rework: one gateway per data dir, whatever port it uses. bin.mjs takes
// <data dir>/gateway.lock (flag 'wx', {pid, instance_id, port, started}) before it binds a port:
// a live owner -> exit 3 with "another gateway owns this data dir (pid, port)"; a lock whose pid is
// gone is reclaimed with a logged notice. Unit cases call runtime-state.mjs directly; the process
// cases start the REAL gateway (pinned free port, temp FORGE_DATA_DIR, Discord autostart off) and
// kill it by its own PID afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireDataDirLock, updateDataDirLockPort, releaseDataDirLock, isPidAlive, lockRefusalMessage,
  DATA_DIR_LOCK_NAME, LOCK_REFUSED_EXIT_CODE, LOCK_REFUSED_MARKER, INSTANCE_ID,
} from '../src/runtime-state.mjs';
import { GatewaySupervisor } from '../supervisor.mjs';

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const LISTEN_RE = /^gateway listening http:\/\/127\.0\.0\.1:(\d+)\r?$/m;
const START_TIMEOUT_MS = 30000;

function tempDir(t, prefix = 'b1a-lock-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}
const lockPath = (dir) => path.join(dir, DATA_DIR_LOCK_NAME);
const readLock = (dir) => JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));

/** A pid that certainly belonged to a process that has exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(r.stdout);
  assert.ok(Number.isInteger(pid) && pid > 0 && !isPidAlive(pid), 'test setup: need a dead pid');
  return pid;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startGateway(t, extraEnv) {
  const env = { ...process.env, CC_DISCORD_AUTOSTART: 'off', ...extraEnv };
  for (const k of ['CC_PORT', 'FORGE_GATEWAY_PORT', 'CC_TEST_PREFERRED_PORT', 'CC_TEST_THROW_AFTER_MS']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, [BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { out.stderr += c.toString('utf8'); });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, out, exited };
}

function waitForListening(g) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = g.out.stdout.match(LISTEN_RE);
      if (m) { clearInterval(timer); resolve(Number(m[1])); return; }
      if (g.child.exitCode !== null || Date.now() - started > START_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error('gateway never printed its listening line; exit=' + g.child.exitCode + ' stderr=' + g.out.stderr.slice(-2000)));
      }
    }, 50);
  });
}

/** The exit code, or a rejection when the gateway is still running after START_TIMEOUT_MS (a
 *  regression that lets it start must fail the test, not hang it). */
function exitWithin(g) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('gateway did not exit; stdout=' + g.out.stdout.slice(-500) + ' stderr=' + g.out.stderr.slice(-1000))), START_TIMEOUT_MS);
  });
  return Promise.race([g.exited, timeout]).finally(() => clearTimeout(timer));
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// ── unit: runtime-state.mjs ──────────────────────────────────────────────────────────────────────

test('isPidAlive: this process yes; an exited process, 0, negatives and non-integers no', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(deadPid()), false);
  for (const v of [0, -1, 1.5, '123', null, undefined]) assert.equal(isPidAlive(v), false, String(v));
});

test('fresh data dir: the lock is created (missing dir too) with pid, instance_id, port and started; the port is recorded later; release removes it', (t) => {
  const dir = path.join(tempDir(t), 'not-yet-there');
  t.after(() => releaseDataDirLock());
  const r = acquireDataDirLock(dir, { log: () => assert.fail('no notice expected on a fresh start') });
  assert.equal(r.ok, true);
  assert.equal(r.reclaimed, null);
  const rec = readLock(dir);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.instance_id, INSTANCE_ID);
  assert.equal(rec.port, null);
  assert.ok(!Number.isNaN(Date.parse(rec.started)));
  assert.equal(updateDataDirLockPort(4567), true);
  assert.equal(readLock(dir).port, 4567);
  assert.deepEqual(fs.readdirSync(dir), [DATA_DIR_LOCK_NAME], 'no temp file left behind by the port update');
  assert.equal(releaseDataDirLock(), true);
  assert.equal(fs.existsSync(lockPath(dir)), false);
});

test('a live owner refuses: ok false, the owner named, the lock file untouched', (t) => {
  const dir = tempDir(t);
  const owner = { pid: process.ppid, instance_id: 'other-gateway', port: 4999, started: '2026-11-01T10:00:00.000Z' };
  fs.writeFileSync(lockPath(dir), JSON.stringify(owner));
  const before = fs.readFileSync(lockPath(dir), 'utf8');
  const r = acquireDataDirLock(dir); // real isPidAlive: the parent (node --test runner) is alive
  assert.equal(r.ok, false);
  assert.deepEqual(r.owner, owner);
  assert.equal(fs.readFileSync(lockPath(dir), 'utf8'), before);
  const msg = lockRefusalMessage(r);
  assert.ok(msg.startsWith(LOCK_REFUSED_MARKER + ' (pid ' + process.ppid + ', port 4999)'), msg);
  assert.ok(msg.includes(lockPath(dir)));
});

test('a stale lock (pid no longer running) is reclaimed with a logged notice and then owned by this process', (t) => {
  const dir = tempDir(t);
  t.after(() => releaseDataDirLock());
  const gone = deadPid();
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: gone, instance_id: 'old', port: 4100, started: 'x' }));
  const notices = [];
  const r = acquireDataDirLock(dir, { log: (l) => notices.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.reclaimed.pid, gone);
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp('reclaimed a stale data-dir lock .*pid ' + gone + ' is no longer running'));
  assert.equal(readLock(dir).pid, process.pid);
  assert.deepEqual(fs.readdirSync(dir), [DATA_DIR_LOCK_NAME], 'the moved-aside stale copy is removed');
});

test('an unreadable lock fails closed while it is fresh (a gateway may be mid-write) and is reclaimed once it is old', (t) => {
  const dir = tempDir(t);
  t.after(() => releaseDataDirLock());
  fs.writeFileSync(lockPath(dir), '');
  const fresh = acquireDataDirLock(dir);
  assert.equal(fresh.ok, false);
  assert.equal(fresh.owner, null);
  assert.match(fresh.reason, /unreadable lock written/);
  assert.match(lockRefusalMessage(fresh), new RegExp('^' + LOCK_REFUSED_MARKER + ' \\(unreadable lock'));

  const notices = [];
  const old = acquireDataDirLock(dir, { now: () => Date.now() + 60000, log: (l) => notices.push(l) });
  assert.equal(old.ok, true);
  assert.match(notices[0], /unreadable for \d+ ms/);
  assert.equal(readLock(dir).pid, process.pid);
});

test('a lock that carries this very pid (left by an earlier process that had the same pid) is stale, not live', (t) => {
  const dir = tempDir(t);
  t.after(() => releaseDataDirLock());
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, instance_id: 'earlier-boot', port: 1 }));
  const r = acquireDataDirLock(dir, { log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(readLock(dir).instance_id, INSTANCE_ID);
});

test('release only removes a lock that is still this process\'s own', (t) => {
  const dir = tempDir(t);
  assert.equal(acquireDataDirLock(dir).ok, true);
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, instance_id: 'someone-else' }));
  assert.equal(releaseDataDirLock(), false);
  assert.equal(readLock(dir).instance_id, 'someone-else');
});

// ── real gateway processes ───────────────────────────────────────────────────────────────────────

test('REAL: a second gateway on the same data dir (other port) refuses with exit 3 naming the owner pid and port; the first keeps serving', async (t) => {
  const data = tempDir(t, 'b1a-lock-e2e-');
  const first = startGateway(t, { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()) });
  const port1 = await waitForListening(first);
  const rec = readLock(data);
  assert.equal(rec.pid, first.child.pid);
  assert.equal(rec.port, port1, 'the lock records the real port');

  const second = startGateway(t, { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()) });
  assert.equal(await exitWithin(second), LOCK_REFUSED_EXIT_CODE);
  assert.ok(second.out.stderr.includes(LOCK_REFUSED_MARKER + ' (pid ' + first.child.pid + ', port ' + port1 + ')'), second.out.stderr);
  assert.doesNotMatch(second.out.stdout, LISTEN_RE);
  assert.equal((await getJson(port1, '/api/health')).instance_id, rec.instance_id, 'the first gateway still answers');
  assert.deepEqual(readLock(data), rec, 'the refused gateway left the lock alone');
});

test('REAL: an unpinned second gateway is refused by the lock too (the port does not matter)', async (t) => {
  const data = tempDir(t, 'b1a-lock-e2e-');
  const first = startGateway(t, { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()) });
  await waitForListening(first);
  const second = startGateway(t, { FORGE_DATA_DIR: data, CC_TEST_PREFERRED_PORT: String(await freePort()) });
  assert.equal(await exitWithin(second), LOCK_REFUSED_EXIT_CODE);
  assert.ok(second.out.stderr.includes(LOCK_REFUSED_MARKER));
});

test('REAL: a stale lock from a crashed gateway is reclaimed; the new gateway starts and owns it', async (t) => {
  const data = tempDir(t, 'b1a-lock-e2e-');
  const gone = deadPid();
  fs.writeFileSync(lockPath(data), JSON.stringify({ pid: gone, instance_id: 'crashed', port: 4100, started: 'x' }));
  const g = startGateway(t, { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()) });
  const port = await waitForListening(g);
  assert.match(g.out.stderr, new RegExp('reclaimed a stale data-dir lock .*pid ' + gone + ' is no longer running'));
  const rec = readLock(data);
  assert.equal(rec.pid, g.child.pid);
  assert.equal(rec.port, port);
});

test('REAL: a gateway that exits through its own drain path removes its lock', async (t) => {
  const data = tempDir(t, 'b1a-lock-e2e-');
  const g = startGateway(t, { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()), CC_TEST_THROW_AFTER_MS: '1500' });
  await waitForListening(g);
  assert.equal(readLock(data).pid, g.child.pid);
  assert.equal(await exitWithin(g), 1);
  assert.equal(fs.existsSync(lockPath(data)), false, 'process.exit runs the release');
});

test('REAL: the supervisor stops at once (DATA_DIR_LOCKED) instead of restart-looping when its gateway is refused by the lock', async (t) => {
  const data = tempDir(t, 'b1a-lock-e2e-');
  const owner = startGateway(t, { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()) });
  await waitForListening(owner);
  // The supervisor spawns bin.mjs with this test process's env.
  const saved = {};
  const childEnv = { FORGE_DATA_DIR: data, CC_PORT: String(await freePort()), CC_DISCORD_AUTOSTART: 'off' };
  for (const [k, v] of Object.entries(childEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const starts = [];
  const sup = new GatewaySupervisor({ childScript: BIN, logFilePath: null, initialBackoffMs: 50, crashLoopMaxCrashes: 5 });
  sup.on('child-started', (e) => starts.push(e.pid));
  const fatal = new Promise((resolve) => sup.on('fatal', resolve));
  sup.start();
  t.after(() => sup.stop());
  const result = await Promise.race([fatal, new Promise((r) => setTimeout(() => r({ reason: 'timeout' }), 30000))]);
  assert.equal(result.reason, 'DATA_DIR_LOCKED');
  assert.equal(starts.length, 1, 'no restart after a lock refusal');
});
