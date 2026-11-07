// WP B1a: bin.mjs port selection, proven with the REAL gateway process. Unpinned, the gateway tries
// 4100 and falls back to a free loopback port when 4100 is held by something that is not a gateway
// on the same data dir; a holder that does not answer at all makes it fail closed (EADDRINUSE). It
// prints one machine-readable "gateway listening http://127.0.0.1:<port>"
// line. A pinned port (CC_PORT / FORGE_GATEWAY_PORT) is used exactly. Every spawned gateway gets a
// temp FORGE_DATA_DIR and CC_DISCORD_AUTOSTART=off, and is killed by its own PID afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const LISTEN_RE = /^gateway listening http:\/\/127\.0\.0\.1:(\d+)\r?$/m;
const START_TIMEOUT_MS = 30000;

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1a-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

function startGateway(t, extraEnv) {
  const env = { ...process.env, CC_DISCORD_AUTOSTART: 'off', ...extraEnv };
  for (const k of ['CC_PORT', 'FORGE_GATEWAY_PORT', 'CC_TEST_PREFERRED_PORT']) if (!(k in extraEnv)) delete env[k];
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
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Binds 127.0.0.1:port with a server answering `handler`; resolves null when the port is already taken. */
function occupy(t, port, handler = (req, res) => { res.writeHead(200); res.end('not a gateway'); }) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => {
      t.after(() => new Promise((r) => srv.close(() => r())));
      resolve(srv);
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test('4100 taken by a non-gateway: the gateway falls back to a free loopback port and says so on one line', async (t) => {
  await occupy(t, 4100); // null when something (e.g. the live dev gateway on another data dir) already holds it: still occupied
  const data = tempDataDir(t);
  const g = startGateway(t, { FORGE_DATA_DIR: data });
  const port = await waitForListening(g);
  assert.notEqual(port, 4100);
  assert.match(g.out.stderr, /port 4100 is taken by another process; falling back/);
  const h = await getJson(port, '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.gateway.port, port, 'health reports the real port');
  assert.equal(h.json.gateway.data_dir, data);
  assert.match(h.json.instance_id, /^[0-9a-f-]{36}$/);
  const again = await getJson(port, '/api/health');
  assert.equal(again.json.instance_id, h.json.instance_id, 'instance_id is stable for the process');
});

test('a pinned CC_PORT is used exactly (no fallback)', async (t) => {
  const pinned = await freePort();
  const g = startGateway(t, { FORGE_DATA_DIR: tempDataDir(t), CC_PORT: String(pinned) });
  assert.equal(await waitForListening(g), pinned);
});

test('a pinned port that is taken fails with EADDRINUSE instead of moving (supervisor fast-stop keeps working)', async (t) => {
  const pinned = await freePort();
  assert.ok(await occupy(t, pinned), 'test setup: could not hold the pinned port');
  const g = startGateway(t, { FORGE_DATA_DIR: tempDataDir(t), FORGE_GATEWAY_PORT: String(pinned) });
  assert.equal(await exitWithin(g), 1);
  assert.match(g.out.stderr, /EADDRINUSE/);
  assert.doesNotMatch(g.out.stdout, LISTEN_RE);
});

// B1a rework: the preferred port is injectable for tests (CC_TEST_PREFERRED_PORT), so the three
// cases below always run, also on a machine whose 4100 is held by the live dev gateway.

test('preferred port held by an older (lock-less) gateway on the SAME data dir: refuse with EADDRINUSE instead of starting a duplicate', async (t) => {
  const data = tempDataDir(t);
  const preferred = await freePort();
  assert.ok(await occupy(t, preferred, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gateway: { data_dir: data } }));
  }), 'test setup: could not plant the fake gateway');
  const g = startGateway(t, { FORGE_DATA_DIR: data, CC_TEST_PREFERRED_PORT: String(preferred) });
  assert.equal(await exitWithin(g), 1);
  assert.match(g.out.stderr, new RegExp('EADDRINUSE: a gateway with this same data dir already listens on port ' + preferred));
});

test('preferred port held by a holder that never answers /api/health: fail closed with EADDRINUSE, no fallback', async (t) => {
  const preferred = await freePort();
  const sockets = new Set();
  const silent = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); // accepts, never replies
  await new Promise((resolve, reject) => { silent.once('error', reject); silent.listen(preferred, '127.0.0.1', resolve); });
  t.after(() => new Promise((r) => { for (const s of sockets) s.destroy(); silent.close(() => r()); }));
  const g = startGateway(t, { FORGE_DATA_DIR: tempDataDir(t), CC_TEST_PREFERRED_PORT: String(preferred) });
  assert.equal(await exitWithin(g), 1);
  assert.match(g.out.stderr, new RegExp('EADDRINUSE: port ' + preferred + ' is taken and its holder did not answer /api/health; not falling back'));
  assert.doesNotMatch(g.out.stdout, LISTEN_RE);
});

test('preferred port held by a program that answers but is not a gateway: fall back to a free port', async (t) => {
  const preferred = await freePort();
  assert.ok(await occupy(t, preferred), 'test setup: could not hold the preferred port');
  const g = startGateway(t, { FORGE_DATA_DIR: tempDataDir(t), CC_TEST_PREFERRED_PORT: String(preferred) });
  const port = await waitForListening(g);
  assert.notEqual(port, preferred);
  assert.match(g.out.stderr, new RegExp('port ' + preferred + ' is taken by another process; falling back'));
});
