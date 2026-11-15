// Remote Bridge Tailscale diagnosis (WP-TS-DIAG): the owner saw "Aan via Tailscale" while the phone
// was not in the tailnet, and the bridge ran on the VirtualBox host-only adapter. This file checks the
// read-only Tailscale health (`tailscale status --json` through an injected runner: no real CLI call),
// the virtual-adapter marking of LAN candidates, the recommended mode, the bound-to-virtual hint, and
// the new `tailscale` fields on GET /api/remote and GET /remote/v1/status.
// Contract: command-center/docs/REMOTE-BRIDGE-CONTRACT.md. Temp folders only.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createServer } from '../src/server.mjs';
import * as manager from '../src/remote/manager.mjs';
import { isVirtualAdapter, lanCandidateDetails, lanCandidates } from '../src/remote/bind-guard.mjs';
import {
  readTailscaleHealth, parseTailscaleStatus, createCliRunner, tailscaleCliSkipReason,
  _setTailscaleRunnerForTests, _resetTailscaleHealthForTests, TAILSCALE_CACHE_MS, TAILSCALE_TIMEOUT_MS,
} from '../src/remote/tailscale-health.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

// The owner's PC as measured on 2026-11-09 (read-only), with a made-up account.
const OWNER_IFACES = {
  'VirtualBox Host-Only Network': [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
  'Wi-Fi': [{ address: '192.168.1.83', family: 'IPv4', internal: false }],
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.27.80.1', family: 'IPv4', internal: false }],
  Tailscale: [{ address: '100.64.163.38', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};

function statusJson({ peers = {}, backend = 'Running', ips = ['100.64.163.38', 'fd7a:115c:a1e0::1'] } = {}) {
  return JSON.stringify({
    Version: '1.90.0',
    BackendState: backend,
    TailscaleIPs: ips,
    Self: { ID: 'n1', HostName: 'OWNER-PC', OS: 'windows', UserID: 42, TailscaleIPs: ips, Online: true },
    User: { 42: { ID: 42, LoginName: 'owner@example.test', DisplayName: 'Owner' } },
    Peer: peers,
  });
}

function fakeRunner(answer) {
  const calls = [];
  const fn = async () => { calls.push(Date.now()); return typeof answer === 'function' ? answer() : answer; };
  fn.calls = calls;
  return fn;
}

afterEach(() => { _setTailscaleRunnerForTests(null); _resetTailscaleHealthForTests(); });

// ---------------------------------------------------------------- virtual adapters

test('virtual adapters: VirtualBox host-only, vEthernet/WSL/Hyper-V, VMware, Docker and loopback are virtual; Wi-Fi is not', () => {
  assert.equal(isVirtualAdapter('VirtualBox Host-Only Network', '192.168.56.1'), true);
  assert.equal(isVirtualAdapter('vEthernet (WSL (Hyper-V firewall))', '172.27.80.1'), true);
  assert.equal(isVirtualAdapter('vEthernet (Default Switch)', '172.20.0.1'), true);
  assert.equal(isVirtualAdapter('VMware Network Adapter VMnet8', '192.168.79.1'), true);
  assert.equal(isVirtualAdapter('vEthernet (DockerNAT)', '10.0.75.1'), true);
  assert.equal(isVirtualAdapter('Loopback Pseudo-Interface 1', '127.0.0.1'), true);
  assert.equal(isVirtualAdapter('Ethernet 3', '192.168.56.101'), true, 'the VirtualBox host-only range counts whatever the adapter is called');
  assert.equal(isVirtualAdapter('Wi-Fi', '192.168.1.83'), false);
  assert.equal(isVirtualAdapter('Ethernet', '10.0.0.12'), false);
});

test('LAN candidates carry address, interface and virtual; the plain address list is unchanged', () => {
  assert.deepEqual(lanCandidateDetails(OWNER_IFACES), [
    { address: '192.168.56.1', interface: 'VirtualBox Host-Only Network', virtual: true },
    { address: '192.168.1.83', interface: 'Wi-Fi', virtual: false },
    { address: '172.27.80.1', interface: 'vEthernet (WSL (Hyper-V firewall))', virtual: true },
  ]);
  assert.deepEqual(lanCandidates(OWNER_IFACES), ['192.168.56.1', '192.168.1.83', '172.27.80.1']);
});

test('GET /api/remote candidates: Tailscale is the recommended mode and a virtual adapter is never the recommended LAN address', () => {
  manager._setInterfacesForTests(OWNER_IFACES);
  try {
    const c = manager.getRemoteStatus().candidates;
    assert.equal(c.tailscale, '100.64.163.38');
    assert.equal(c.recommended_mode, 'tailscale');
    assert.equal(c.recommended_lan, '192.168.1.83');
    assert.deepEqual(c.lan_addresses, ['192.168.56.1', '192.168.1.83', '172.27.80.1']);
    assert.equal(c.lan.find((l) => l.address === '192.168.56.1').virtual, true);
    manager._setInterfacesForTests({ 'VirtualBox Host-Only Network': OWNER_IFACES['VirtualBox Host-Only Network'] });
    const onlyVirtual = manager.getRemoteStatus().candidates;
    assert.equal(onlyVirtual.recommended_mode, null, 'only a virtual adapter: nothing is recommended');
    assert.equal(onlyVirtual.recommended_lan, null);
    manager._setInterfacesForTests({ 'Wi-Fi': OWNER_IFACES['Wi-Fi'] });
    assert.equal(manager.getRemoteStatus().candidates.recommended_mode, 'lan');
  } finally {
    manager._setInterfacesForTests(null);
  }
});

test('bridge hint: running on a virtual adapter says so; LAN while Tailscale is available says so too', () => {
  assert.deepEqual(manager.bridgeHint({ running: true, mode: 'lan', address: '192.168.56.1', interfaces: OWNER_IFACES }).code, 'bound_to_virtual_adapter');
  assert.match(manager.bridgeHint({ running: true, mode: 'lan', address: '192.168.56.1', interfaces: OWNER_IFACES }).text, /VirtualBox Host-Only Network/);
  assert.equal(manager.bridgeHint({ running: true, mode: 'lan', address: '192.168.1.83', interfaces: OWNER_IFACES }).code, 'tailscale_available');
  assert.equal(manager.bridgeHint({ running: true, mode: 'tailscale', address: '100.64.163.38', interfaces: OWNER_IFACES }), null);
  assert.equal(manager.bridgeHint({ running: false, mode: 'lan', address: null, interfaces: OWNER_IFACES }), null);
  const noTs = { 'Wi-Fi': OWNER_IFACES['Wi-Fi'] };
  assert.equal(manager.bridgeHint({ running: true, mode: 'lan', address: '192.168.1.83', interfaces: noTs }), null);
});

// ---------------------------------------------------------------- tailscale status --json

test('parse: the owner\'s live state (Tailscale up, zero peers) gives running, the PC address, the account and 0 peers', () => {
  const h = parseTailscaleStatus(JSON.parse(statusJson({ peers: null })));
  assert.deepEqual(h, {
    installed: true, checked: true, running: true, pc_ip: '100.64.163.38', account: 'owner@example.test',
    peers_total: 0, peers_online: 0, peers: [], error: null,
  });
});

test('parse: peers are counted and listed with name, OS and online; nothing else from the peer leaks', () => {
  const h = parseTailscaleStatus(JSON.parse(statusJson({
    peers: {
      'nodekey:a': { HostName: 'pixel-8', DNSName: 'pixel-8.tail1.ts.net.', OS: 'android', Online: true, TailscaleIPs: ['100.70.1.2'], UserID: 42 },
      'nodekey:b': { HostName: 'laptop', OS: 'windows', Online: false },
      'nodekey:c': { DNSName: 'nas.tail1.ts.net.', OS: 'linux' },
    },
  })));
  assert.equal(h.peers_total, 3);
  assert.equal(h.peers_online, 1);
  assert.deepEqual(h.peers, [
    { name: 'pixel-8', os: 'android', online: true },
    { name: 'laptop', os: 'windows', online: false },
    { name: 'nas', os: 'linux', online: false },
  ]);
});

test('parse: logged out (NeedsLogin) is installed but not running, with unknown peer counts', () => {
  const h = parseTailscaleStatus(JSON.parse(statusJson({ backend: 'NeedsLogin', ips: [], peers: null })));
  assert.equal(h.installed, true);
  assert.equal(h.running, false);
  assert.equal(h.pc_ip, null);
  assert.equal(h.peers_total, null);
  assert.equal(h.peers_online, null);
});

test('health: a missing CLI (ENOENT) is installed:false and never throws; the adapter address is still reported', async () => {
  _setTailscaleRunnerForTests(fakeRunner({ error: { code: 'ENOENT', message: 'spawn tailscale ENOENT' } }));
  const h = await readTailscaleHealth({ interfaces: OWNER_IFACES });
  assert.equal(h.installed, false);
  assert.equal(h.running, false);
  assert.equal(h.pc_ip, '100.64.163.38');
  assert.equal(h.peers_total, null);
});

test('health: a timeout or bad JSON is installed but not running, with an error text and no throw', async () => {
  _setTailscaleRunnerForTests(fakeRunner({ error: { code: 'ETIMEDOUT', killed: true, message: 'timed out' } }));
  const t = await readTailscaleHealth({ interfaces: {} });
  assert.equal(t.installed, true);
  assert.equal(t.running, false);
  assert.match(t.error, /timed out|did not answer/i);
  _resetTailscaleHealthForTests();
  _setTailscaleRunnerForTests(fakeRunner({ stdout: 'not json' }));
  const b = await readTailscaleHealth({ interfaces: {} });
  assert.equal(b.installed, true);
  assert.equal(b.running, false);
  assert.match(b.error, /JSON/);
});

test('health: the CLI answer is cached for about 10 s', async () => {
  const runner = fakeRunner({ stdout: statusJson() });
  _setTailscaleRunnerForTests(runner);
  assert.equal(TAILSCALE_CACHE_MS, 10_000);
  await readTailscaleHealth({ now: 1_000 });
  await readTailscaleHealth({ now: 5_000 });
  assert.equal(runner.calls.length, 1);
  await readTailscaleHealth({ now: 11_001 });
  assert.equal(runner.calls.length, 2);
});

test('runner: execFile with an args array, no shell, a 3 s timeout and the Windows install path when it exists', async () => {
  const seen = [];
  const execFile = (file, args, opts, cb) => { seen.push({ file, args, opts }); cb(null, statusJson(), ''); };
  const exe = path.join('C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const win = createCliRunner({ execFile, platform: 'win32', exists: (p) => p === exe, programFiles: 'C:\\Program Files' });
  const r = await win();
  assert.equal(typeof r.stdout, 'string');
  assert.equal(seen[0].file, exe);
  assert.deepEqual(seen[0].args, ['status', '--json']);
  assert.equal(seen[0].opts.timeout, TAILSCALE_TIMEOUT_MS);
  assert.ok(TAILSCALE_TIMEOUT_MS <= 3000);
  assert.ok(!seen[0].opts.shell, 'never through a shell');
  const nix = createCliRunner({ execFile, platform: 'linux', exists: () => false });
  await nix();
  assert.equal(seen[1].file, 'tailscale');
  const failing = createCliRunner({ execFile: (f, a, o, cb) => cb(Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })), platform: 'linux', exists: () => false });
  assert.equal((await failing()).error.code, 'ENOENT');
});

test('health: under the Node test runner (and with FORGE_TAILSCALE_CLI=off) the real CLI is never run', async () => {
  assert.ok(tailscaleCliSkipReason({ NODE_TEST_CONTEXT: 'child-v8' }));
  assert.ok(tailscaleCliSkipReason({ FORGE_TAILSCALE_CLI: 'off' }));
  assert.equal(tailscaleCliSkipReason({}), null);
  const h = await readTailscaleHealth({ interfaces: OWNER_IFACES }); // no injected runner, this process is a test
  assert.equal(h.checked, false);
  assert.equal(h.installed, null);
  assert.equal(h.pc_ip, '100.64.163.38');
});

// ---------------------------------------------------------------- the routes

let server; let port; let dataDir; let bridgePort; let token;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function bridge(method, urlPath, { body, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (auth && token) h.authorization = 'Bearer ' + token;
    if (body !== undefined) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: bridgePort, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ statusCode: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK = '1';
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-tsdiag-'));
  manager._setRemoteDataDirForTests(dataDir);
  manager._setScribeRunnerForTests(async () => ({ available: false, items: [] }));
  server = createServer();
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  bridgePort = await freePort();
});

after(async () => {
  await manager._resetRemoteForTests();
  manager._setRemoteDataDirForTests(null);
  delete process.env.CC_EXEC_MOCK;
  delete process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK;
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

const PEERS = { 'nodekey:a': { HostName: 'pixel-8', OS: 'android', Online: true }, 'nodekey:b': { HostName: 'laptop', OS: 'windows', Online: false } };

test('admin GET /api/remote carries the full tailscale block (account and peer names stay on the PC side)', async () => {
  _setTailscaleRunnerForTests(fakeRunner({ stdout: statusJson({ peers: PEERS }) }));
  const r = await request(port, '/api/remote');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json.tailscale, {
    installed: true, checked: true, running: true, pc_ip: '100.64.163.38', account: 'owner@example.test',
    peers_total: 2, peers_online: 1, peers: [{ name: 'pixel-8', os: 'android', online: true }, { name: 'laptop', os: 'windows', online: false }], error: null,
  });
});

test('admin GET /api/remote: a missing CLI still answers 200 with installed:false', async () => {
  _setTailscaleRunnerForTests(fakeRunner({ error: { code: 'ENOENT', message: 'spawn tailscale ENOENT' } }));
  const r = await request(port, '/api/remote');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.tailscale.installed, false);
});

test('enable answers carry the tailscale block too, and the bridge on loopback reports the bound-to-virtual hint', async () => {
  _setTailscaleRunnerForTests(fakeRunner({ stdout: statusJson({ peers: null }) }));
  manager._setInterfacesForTests({ 'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }], Tailscale: OWNER_IFACES.Tailscale });
  const on = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'lan', address: '127.0.0.1', port: bridgePort } });
  assert.equal(on.statusCode, 200, JSON.stringify(on.json));
  assert.equal(on.json.tailscale.peers_total, 0);
  assert.equal(on.json.hint.code, 'bound_to_virtual_adapter');
});

test('phone GET /remote/v1/status carries only pc_ip and peers_online (no account, no peer names)', async () => {
  _setTailscaleRunnerForTests(fakeRunner({ stdout: statusJson({ peers: PEERS }) }));
  const p = await requestWithBody(port, '/api/remote/pairing', { jsonBody: {} });
  assert.equal(p.statusCode, 200, JSON.stringify(p.json));
  const paired = await bridge('POST', '/remote/v1/pair', { body: { code: p.json.code, device_name: 'Pixel 8' }, auth: false });
  assert.equal(paired.statusCode, 201, JSON.stringify(paired.json));
  token = paired.json.token;
  const st = await bridge('GET', '/remote/v1/status');
  assert.equal(st.statusCode, 200, JSON.stringify(st.json));
  assert.deepEqual(st.json.tailscale, { pc_ip: '100.64.163.38', peers_online: 1 });
  const text = JSON.stringify(st.json);
  assert.ok(!text.includes('owner@example.test'), 'no account on the phone side');
  assert.ok(!text.includes('laptop'), 'no peer names on the phone side');
});
