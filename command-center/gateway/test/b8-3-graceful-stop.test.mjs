// WP B8-3 (Test Boss observation in B8-2): the gateway child exited with code 1 on a NORMAL desktop close.
// Cause: the desktop stopped it with `taskkill /PID <pid> /T /F`, and on Windows a forced TerminateProcess
// always ends the process with exit code 1; a SIGTERM handler never runs there either (see supervisor.mjs).
// Fix: when the gateway has a Node IPC channel (the desktop spawns it with one), a { type: 'forge-gateway-stop' }
// message, or the parent closing that channel, runs a normal shutdown: stop running work, release the
// data-dir lock, exit 0. These cases start the REAL gateway (temp data dir, pinned free port, Discord autostart
// off) and only ever kill the exact child they spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR_LOCK_NAME } from '../src/runtime-state.mjs';

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const LISTEN_RE = /^gateway listening http:\/\/127\.0\.0\.1:(\d+)\r?$/m;
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 15000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startWithIpc(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-3-stop-'));
  const env = { ...process.env, CC_DISCORD_AUTOSTART: 'off', FORGE_DATA_DIR: data, CC_PORT: String(await freePort()) };
  for (const k of ['FORGE_GATEWAY_PORT', 'CC_TEST_PREFERRED_PORT', 'CC_TEST_THROW_AFTER_MS']) delete env[k];
  const child = spawn(process.execPath, [BIN], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { out.stderr += c.toString('utf8'); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (LISTEN_RE.test(out.stdout)) { clearInterval(timer); resolve(); return; }
      if (child.exitCode !== null || Date.now() - started > START_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error('gateway never listened; exit=' + child.exitCode + ' stderr=' + out.stderr.slice(-1500)));
      }
    }, 50);
  });
  return { child, out, exited, data };
}

function within(g, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('gateway did not exit; stderr=' + g.out.stderr.slice(-1500))), ms);
  });
  return Promise.race([g.exited, timeout]).finally(() => clearTimeout(timer));
}

test('a forge-gateway-stop message over IPC ends the gateway with exit code 0 and releases the data-dir lock', async (t) => {
  const g = await startWithIpc(t);
  assert.ok(fs.existsSync(path.join(g.data, DATA_DIR_LOCK_NAME)), 'setup: the running gateway holds the lock');
  g.child.send({ type: 'forge-gateway-stop' });
  const r = await within(g, STOP_TIMEOUT_MS);
  assert.deepEqual(r, { code: 0, signal: null }, 'normal stop must exit 0; stderr=' + g.out.stderr.slice(-1500));
  assert.equal(fs.existsSync(path.join(g.data, DATA_DIR_LOCK_NAME)), false, 'the lock is released on a normal stop');
  assert.match(g.out.stdout, /normal shutdown requested \(desktop\)/);
});

test('the parent closing the IPC channel also ends the gateway normally (exit 0), so it never outlives the app', async (t) => {
  const g = await startWithIpc(t);
  g.child.disconnect();
  const r = await within(g, STOP_TIMEOUT_MS);
  assert.deepEqual(r, { code: 0, signal: null }, 'stderr=' + g.out.stderr.slice(-1500));
  assert.match(g.out.stdout, /normal shutdown requested \(parent disconnected\)/);
});

test('an unrelated IPC message is ignored: the gateway keeps running', async (t) => {
  const g = await startWithIpc(t);
  g.child.send({ type: 'something-else' });
  g.child.send('forge-gateway-stop'); // a bare string is not the stop message
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(g.child.exitCode, null, 'still running');
});
