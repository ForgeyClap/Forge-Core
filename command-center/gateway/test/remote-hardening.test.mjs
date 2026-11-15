// Remote Bridge hardening (Security Boss rework of WP-BRIDGE): central scribe copy only (H1), state
// folder outside every project (H2), LAN read-only by default (H3), Tailscale adapter detection and
// no LAN restore on boot (M1), audit flood cap + rotation (M2), scribe dedupe + one shared limit of 4
// (M3), dashboard-only asks (M4), bounded failure maps (L2), no http://localhost origin (L3), and a
// device store that sees another process's revoke. Temp folders only; nothing is written into a
// real project or into the real per-user state folder.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import * as scribe from '../src/remote/scribe.mjs';
import * as phone from '../src/remote/phone-routes.mjs';
import * as bind from '../src/remote/bind-guard.mjs';
import * as audit from '../src/remote/audit.mjs';
import * as bridge from '../src/remote/bridge-server.mjs';
import * as manager from '../src/remote/manager.mjs';
import { createPairing } from '../src/remote/pairing.mjs';
import { createDeviceStore } from '../src/remote/devices.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR, SYNC_SCAN_ROOTS, realpathOrNull } from '../src/paths.mjs';
import { setAdmittedRegistryRoots, _resetAdmittedRegistryRootsForTests } from '../src/admitted-roots.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, appendUserTurn } from '../src/conversations.mjs';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-hard-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
afterEach(async () => {
  scribe._setScribeCentralBinForTests?.(null);
  await manager._resetRemoteForTests();
  manager._setRemoteDataDirForTests(null);
  _resetAdmittedRegistryRootsForTests();
  delete process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK;
});

function sub(name) {
  const d = path.join(tmp, name + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** A fake project with its OWN forge-scribe.cjs that would leave a marker file when it runs. */
function fakeProject(name) {
  const project = path.join(sub('proj'), name);
  const marker = path.join(project, 'PROJECT-COPY-RAN');
  writeFile(path.join(project, '.claude', 'forge-bin', 'forge-scribe.cjs'),
    "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran'); console.log('[]');\n");
  return { project, marker };
}

/** A fake CENTRAL scribe: echoes its root and args as one item, after `sleepMs`. */
function fakeCentral(sleepMs = 0) {
  const dir = sub('central');
  writeFile(path.join(dir, 'forge-scribe.cjs'),
    'setTimeout(() => console.log(JSON.stringify([{ rid: "R-0001", status: "open", root: process.env.FORGE_PROJECT_ROOT, args: process.argv.slice(2), cwd: process.cwd() }])), ' + sleepMs + ');\n');
  return dir;
}

// ---------------------------------------------------------------- H1 central scribe copy

test('H1: the inbox runs the gateway\'s CENTRAL forge-scribe.cjs with FORGE_PROJECT_ROOT; the project\'s own copy never runs', async () => {
  const { project, marker } = fakeProject('cloned-repo');
  scribe._setScribeCentralBinForTests?.(fakeCentral());
  const r = await scribe.runScribeList({ name: 'cloned-repo', path: project });
  assert.equal(fs.existsSync(marker), false, 'the project\'s own forge-scribe.cjs ran (untrusted project bytes)');
  assert.equal(r.available, true);
  assert.equal(r.items.length, 1, JSON.stringify(r));
  assert.equal(r.items[0].root, project, 'FORGE_PROJECT_ROOT names the project');
  assert.deepEqual(r.items[0].args.slice(0, 1), ['list']);
  assert.ok(r.items[0].args.includes('--json'));
  assert.notEqual(path.resolve(r.items[0].cwd).toLowerCase(), path.resolve(project).toLowerCase(), 'the child does not run inside the project folder');
});

test('H1: the project\'s copy is only the "has scribe" marker; a missing central copy runs nothing', async () => {
  const plain = sub('no-scribe');
  scribe._setScribeCentralBinForTests(fakeCentral());
  assert.equal(scribe.hasScribe(plain), false);
  assert.deepEqual(await scribe.runScribeList({ name: 'plain', path: plain }), { available: false, items: [] });
  const { project, marker } = fakeProject('has-scribe');
  scribe._setScribeCentralBinForTests(sub('empty-central'));
  const r = await scribe.runScribeList({ name: 'has-scribe', path: project });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(r.available, true);
  assert.deepEqual(r.items, []);
  assert.match(r.error, /no own copy of forge-scribe\.cjs/);
});

// ---------------------------------------------------------------- M3 scribe fan-out

test('M3: createLimiter runs at most N tasks at once and runs every task', async () => {
  const lim = scribe.createLimiter(4);
  let active = 0; let peak = 0; const done = [];
  const tasks = Array.from({ length: 10 }, (_, i) => lim.run(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active--; done.push(i); return i;
  }));
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(peak, 4);
  assert.equal(done.length, 10);
  await assert.rejects(lim.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lim.run(async () => 'next'), 'next', 'a failed task frees its slot');
});

test('M3: scribe processes share ONE limit of 4 across all callers', async () => {
  scribe._setScribeCentralBinForTests(fakeCentral(300));
  scribe._resetScribeSlotStatsForTests();
  const projects = Array.from({ length: 7 }, (_, i) => fakeProject('p' + i).project);
  const results = await Promise.all(projects.map((p, i) => scribe.runScribeList({ name: 'p' + i, path: p })));
  assert.ok(results.every((r) => r.available && r.items.length === 1), JSON.stringify(results));
  assert.equal(scribe._scribeSlotStatsForTests().peak, 4);
});

test('M3: N parallel cold requests start each project\'s scribe at most once (in-flight dedupe)', async () => {
  const calls = new Map();
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = {
    scribeCache: new Map(),
    limits: { scribeCacheMs: () => 0 },
    scribeRunner: async (p) => { calls.set(p.path, (calls.get(p.path) || 0) + 1); await gate; return { available: true, items: [{ rid: 'R-1', status: 'open' }] }; },
  };
  const projects = ['a', 'b', 'c'].map((n) => ({ name: n, path: path.join(tmp, n) }));
  const pending = [];
  for (let i = 0; i < 6; i++) for (const p of projects) pending.push(phone.cachedScribe(ctx, p));
  release();
  const results = await Promise.all(pending);
  assert.equal(results.length, 18);
  assert.ok(results.every((r) => r.items.length === 1));
  for (const p of projects) assert.equal(calls.get(p.path), 1, p.name + ' was spawned more than once');
  // after it settled and the (0 ms) cache window passed, the next poll reads fresh again
  await phone.cachedScribe(ctx, projects[0]);
  assert.equal(calls.get(projects[0].path), 2);
});

// ---------------------------------------------------------------- M1 Tailscale detection

const CGNAT_AND_TS = {
  'vEthernet (CGNAT ISP)': [{ address: '100.70.0.1', family: 'IPv4', internal: false }],
  Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
};
const CGNAT_ONLY = { Ethernet: [{ address: '100.70.0.1', family: 'IPv4', internal: false }] };

test('M1: auto-detect prefers the adapter named Tailscale over another 100.64/10 address', () => {
  assert.equal(bind.detectTailscaleAddress(CGNAT_AND_TS), '100.101.102.103');
  assert.equal(bind.detectTailscaleAddress({ tailscale0: [{ address: '100.88.1.2', family: 'IPv4' }] }), '100.88.1.2');
});

test('M1: a 100.64/10 address on a non-Tailscale adapter is refused with tailscale_adapter_unknown', async () => {
  assert.equal(bind.detectTailscaleAddress(CGNAT_ONLY), null);
  const d = bind.detectTailscale(CGNAT_ONLY);
  assert.equal(d.code, 'tailscale_adapter_unknown');
  assert.match(d.error, /Ethernet/);
  manager._setRemoteDataDirForTests(sub('m1-data'));
  manager._setInterfacesForTests(CGNAT_ONLY);
  const r = await manager.enableRemote({ mode: 'tailscale' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'tailscale_adapter_unknown');
  assert.equal(manager.getRemoteStatus().running, false);
});

// ---------------------------------------------------------------- M2 audit flood cap + rotation

function auditLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('M2: refused-request lines are capped per IP per window, then one summary line counts the rest', () => {
  const file = path.join(sub('audit'), 'audit.jsonl');
  let now = Date.parse('2026-11-09T08:00:00Z');
  const log = audit.createAuditLog(file, { refusedPerWindow: 3, windowMs: 60_000, clock: () => now });
  for (let i = 0; i < 10; i++) log.write({ action: 'auth_failed', status: 401, ip: '10.0.0.9', detail: { reason: 'x' } });
  log.write({ action: 'origin_refused', status: 403, ip: '10.0.0.9' });
  log.write({ action: 'locked_out', status: 429, ip: '10.0.0.9' });
  log.write({ action: 'auth_failed', status: 401, ip: '10.0.0.10' });
  log.write({ action: 'request', status: 200, ip: '10.0.0.9' });
  let lines = auditLines(file);
  assert.equal(lines.filter((l) => l.ip === '10.0.0.9' && l.action !== 'request').length, 3, 'only 3 refused lines from one IP in the window');
  assert.equal(lines.filter((l) => l.ip === '10.0.0.10').length, 1, 'another IP has its own budget');
  assert.equal(lines.filter((l) => l.action === 'request').length, 1, 'normal actions are never capped');
  now += 61_000;
  log.write({ action: 'request', status: 200, ip: '10.0.0.11' });
  lines = auditLines(file);
  const summary = lines.find((l) => l.action === 'audit_suppressed' && l.ip === '10.0.0.9');
  assert.ok(summary, 'a summary line follows the window');
  assert.equal(summary.detail.suppressed, 9);
  assert.deepEqual(summary.detail.by_action, { auth_failed: 7, origin_refused: 1, locked_out: 1 });
  log.write({ action: 'auth_failed', status: 401, ip: '10.0.0.9' });
  assert.equal(auditLines(file).filter((l) => l.ip === '10.0.0.9' && l.action === 'auth_failed').length, 4, 'a new window has a new budget');
});

test('M2: flush() writes the pending summary; IPs past the tracking cap share one bucket', () => {
  const file = path.join(sub('audit'), 'audit.jsonl');
  const log = audit.createAuditLog(file, { refusedPerWindow: 1, windowMs: 60_000, maxTrackedIps: 4, clock: () => 1000 });
  for (let i = 0; i < 10; i++) log.write({ action: 'auth_failed', status: 401, ip: '10.0.1.' + i });
  assert.equal(auditLines(file).length, 5, '4 tracked IPs + 1 line for the shared overflow bucket');
  log.flush();
  const s = auditLines(file).find((l) => l.action === 'audit_suppressed');
  assert.equal(s.ip, '*');
  assert.equal(s.detail.suppressed, 5);
});

test('M2: audit.jsonl rotates by size into audit.jsonl.1 and .2 and keeps at most three files (NEW-2)', () => {
  const dir = sub('audit-rot');
  const file = path.join(dir, 'audit.jsonl');
  const log = audit.createAuditLog(file, { maxBytes: 2000 });
  for (let i = 0; i < 40; i++) log.write({ action: 'request', status: 200, ip: '10.0.0.5', detail: { path: '/remote/v1/status', i } });
  assert.ok(fs.existsSync(file + '.1'), 'rotated file exists');
  assert.ok(fs.statSync(file).size <= 2000, 'current file stays under the limit');
  assert.ok(fs.statSync(file + '.1').size <= 2000);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2']);
  const all = [...auditLines(file + '.2'), ...auditLines(file + '.1'), ...auditLines(file)].map((l) => l.detail.i);
  assert.deepEqual(all, [...all].sort((a, b) => a - b), 'oldest lines in .2, newest in the current file');
  assert.equal(all[all.length - 1], 39, 'the newest line is in the current file');
});

test('M2: the default rotation size is 10 MB', () => {
  assert.equal(audit.AUDIT_MAX_BYTES, 10 * 1024 * 1024);
});

// ---------------------------------------------------------------- L2 bounded failure maps

test('L2: the per-IP auth-failure map is swept and bounded', () => {
  const limits = bridge.createLimits({ maxTrackedIps: 50 });
  const t0 = 1_000_000;
  for (let i = 0; i < 500; i++) limits.authFailed('10.1.' + Math.floor(i / 250) + '.' + (i % 250), t0);
  assert.ok(limits._sizesForTests().authFails <= 50, 'size ' + limits._sizesForTests().authFails);
  for (let i = 0; i < 10; i++) limits.authFailed('10.9.9.9', t0);
  assert.ok(limits.lockedFor('10.9.9.9', t0) > 0, 'the newest offender is locked');
  limits.authFailed('10.9.9.8', t0 + 16 * 60 * 1000);
  assert.equal(limits._sizesForTests().authFails, 1, 'expired entries are swept on the next failure');
});

test('L2: the pairing per-IP failure map is swept and bounded', () => {
  let now = 1_000_000;
  const p = createPairing({ clock: () => now, maxTrackedIps: 30 });
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 19; i++) p.consume('WRONGWRONG', '10.2.' + round + '.' + i);
    now += 16 * 60 * 1000;
  }
  assert.ok(p._stateForTests().trackedIps <= 30, 'tracked ' + p._stateForTests().trackedIps);
});

// ---------------------------------------------------------------- devices across processes

test('devices: a store sees a device paired and then revoked by another store on the same folder', () => {
  const dir = sub('devices');
  const a = createDeviceStore(dir);
  const b = createDeviceStore(dir); // e.g. the desktop app's gateway and a dev gateway
  const { token, device } = a.add('Pixel');
  assert.equal(b.authenticate(token)?.id, device.id, 'b sees the new device');
  assert.equal(a.revoke(device.id).ok, true);
  assert.equal(b.authenticate(token), null, 'b honours the revoke made by a');
  assert.equal(b.activeCount(), 0);
});

// ---------------------------------------------------------------- H3 + L3 bridge listener

function rawRequest(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: '127.0.0.1:' + port, ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ statusCode: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startBridge(extra) {
  const lines = [];
  const port = await freePort(); // the bridge checks Host against its own address:port
  const real = bridge.createBridgeServer({
    address: '127.0.0.1', port,
    devices: { authenticate: (t) => (t === 'frb_good' ? { id: 'd1', name: 'Phone' } : null) },
    pairing: createPairing(),
    audit: { write: (e) => lines.push(e) },
    limits: bridge.createLimits(),
    scribeRunner: async () => ({ available: false, items: [] }),
    ...extra,
  });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  return { port, lines, close: () => new Promise((r) => { real.close(() => r()); real.closeAllConnections(); }) };
}

const AUTH = { authorization: 'Bearer frb_good' };

test('H3: LAN mode is read-only by default: every POST except pair answers 403 lan_read_only', async () => {
  const b = await startBridge({ mode: 'lan' });
  try {
    const prompt = await rawRequest(b.port, 'POST', '/remote/v1/prompt', { headers: AUTH, body: {} });
    assert.equal(prompt.statusCode, 403);
    assert.equal(prompt.json.code, 'lan_read_only');
    const ans = await rawRequest(b.port, 'POST', '/remote/v1/asks/ask-1/answer', { headers: AUTH, body: { answers: [] } });
    assert.equal(ans.json.code, 'lan_read_only');
    const ack = await rawRequest(b.port, 'POST', '/remote/v1/scribe/x/R-1/ack', { headers: AUTH, body: {} });
    assert.equal(ack.json.code, 'lan_read_only');
    const pair = await rawRequest(b.port, 'POST', '/remote/v1/pair', { body: { code: 'WRONGWRONG', device_name: 'P' } });
    assert.equal(pair.statusCode, 401, 'pairing stays possible in LAN mode');
    const noToken = await rawRequest(b.port, 'POST', '/remote/v1/prompt', { body: {} });
    assert.equal(noToken.statusCode, 401, 'auth is still checked first');
    assert.ok(b.lines.some((l) => l.action === 'write_refused' && l.detail.reason === 'lan_read_only'));
  } finally { await b.close(); }
});

test('H3: Tailscale mode, and LAN mode with allowLanWrites, accept writes (the request reaches validation)', async () => {
  for (const extra of [{ mode: 'tailscale' }, { mode: 'lan', allowLanWrites: true }]) {
    const b = await startBridge(extra);
    try {
      const r = await rawRequest(b.port, 'POST', '/remote/v1/prompt', { headers: AUTH, body: {} });
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.equal(r.json.code, 'invalid_request');
    } finally { await b.close(); }
  }
});

test('H3: an unknown or missing mode fails closed to read-only', async () => {
  const b = await startBridge({});
  try {
    const r = await rawRequest(b.port, 'POST', '/remote/v1/prompt', { headers: AUTH, body: {} });
    assert.equal(r.json.code, 'lan_read_only');
  } finally { await b.close(); }
});

test('L3: http://localhost is not an allowed origin (the Capacitor app is https://localhost)', async () => {
  const b = await startBridge({ mode: 'tailscale' });
  try {
    const pre = await rawRequest(b.port, 'OPTIONS', '/remote/v1/status', { headers: { origin: 'http://localhost', 'access-control-request-method': 'GET' } });
    assert.equal(pre.statusCode, 403);
    const ok = await rawRequest(b.port, 'OPTIONS', '/remote/v1/status', { headers: { origin: 'https://localhost', 'access-control-request-method': 'GET' } });
    assert.equal(ok.statusCode, 204);
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- H2 state folder outside projects

test('H2: the production state folder is per-user, outside the gateway project and its data dir', () => {
  manager._setRemoteDataDirForTests(null);
  const dir = manager.remoteStateDir();
  assert.equal(dir, path.join(os.homedir(), '.forge', 'remote'));
  const inside = (base, p) => { const rel = path.relative(base, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  assert.equal(inside(PROJECT_ROOT, dir), false);
  assert.equal(inside(COMMAND_CENTER_DATA_DIR, dir), false);
});

test('H2: planted devices.json and settings.json inside a project folder are never loaded; the bridge refuses to start or restore', async () => {
  process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK = '1';
  const project = sub('agent-project');
  setAdmittedRegistryRoots([realpathOrNull(project)]);
  const dataDir = path.join(project, '.data');
  const remote = path.join(dataDir, 'remote');
  const token = 'frb_' + 'P'.repeat(43);
  writeFile(path.join(remote, 'devices.json'), JSON.stringify({ devices: [{ id: 'planted', name: 'Attacker', token_sha256: crypto.createHash('sha256').update(token).digest('hex'), created_at: 'x', last_seen_at: 'x', revoked_at: null }] }));
  writeFile(path.join(remote, 'settings.json'), JSON.stringify({ enabled: true, mode: 'lan', address: '127.0.0.1', port: 47999, allow_lan_writes: true }));
  manager._setRemoteDataDirForTests(dataDir);
  const restored = await manager.restoreRemoteBridgeOnBoot({ env: {} });
  assert.equal(restored.outcome, 'refused');
  const st = manager.getRemoteStatus();
  assert.equal(st.running, false);
  assert.equal(st.enabled, false, 'a planted settings file is not read');
  assert.equal(st.devices_active, 0, 'a planted devices file is not read');
  assert.equal(st.state_problem, 'remote_state_inside_project');
  assert.match(st.last_error, /inside a project folder/);
  const en = await manager.enableRemote({ mode: 'lan', address: '127.0.0.1', port: 47999 });
  assert.equal(en.status, 409);
  assert.equal(en.body.code, 'remote_state_inside_project');
  assert.equal(manager.listDevices().status, 409);
  assert.equal(manager.createPairingCode().status, 409);
  assert.equal(fs.existsSync(path.join(remote, 'audit.jsonl')), false, 'nothing is written into the project');
});

test('H2: the dev-layout data dir (inside the gateway\'s own project root) is refused too, also with no scan root around it', async () => {
  // this repo happens to sit under a scan root (Documents); the gateway's own root must count on its own
  const saved = SYNC_SCAN_ROOTS.splice(0, SYNC_SCAN_ROOTS.length);
  try {
    manager._setRemoteDataDirForTests(path.join(PROJECT_ROOT, 'command-center', '.data'));
    const st = manager.getRemoteStatus();
    assert.equal(st.state_problem, 'remote_state_inside_project');
    assert.equal((await manager.restoreRemoteBridgeOnBoot({ env: {} })).outcome, 'refused');
  } finally { SYNC_SCAN_ROOTS.push(...saved); }
});

test('M2: stopping the bridge writes the pending audit_suppressed summary', async () => {
  process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK = '1';
  const dataDir = sub('m2-stop');
  manager._setRemoteDataDirForTests(dataDir);
  const port = await freePort();
  assert.equal((await manager.enableRemote({ mode: 'lan', address: '127.0.0.1', port })).status, 200);
  for (let i = 0; i < 25; i++) await rawRequest(port, 'GET', '/remote/v1/status', { headers: { authorization: 'Bearer frb_wrong' + i } });
  const file = path.join(dataDir, 'remote', 'audit.jsonl');
  assert.equal(auditLines(file).filter((l) => l.action === 'audit_suppressed').length, 0, 'still inside the window');
  await manager.disableRemote();
  const s = auditLines(file).find((l) => l.action === 'audit_suppressed');
  assert.ok(s, 'summary written on stop');
  assert.equal(s.detail.suppressed, 5);
  assert.equal(auditLines(file).filter((l) => ['auth_failed', 'locked_out'].includes(l.action)).length, 20);
});

// ---------------------------------------------------------------- M4 ask gate (unit)

test('M4: asks are dashboard-only when the turn is unknown or the classifier cannot load', async () => {
  const gateMod = await import('../src/remote/ask-gate.mjs');
  const convDir = sub('conv');
  _setConversationsDirForTests(convDir);
  try {
    const conv = createConversation({ project: 'x' });
    const q = [{ question: 'Which color?', options: ['red', 'blue'] }];
    assert.deepEqual(gateMod.askDashboardOnly({ convId: conv.id, turnId: null, questions: q }), { dashboardOnly: true, reason: 'unknown_turn' });
    const { turnId } = appendUserTurn(conv.id, 'pick a color', { mode: 'execute' });
    assert.deepEqual(gateMod.askDashboardOnly({ convId: conv.id, turnId, questions: q }), { dashboardOnly: false, reason: null });
    assert.deepEqual(gateMod.askDashboardOnly({ convId: conv.id, turnId: null, questions: q }), { dashboardOnly: false, reason: null }, 'no turn id: the latest user turn decides');
    gateMod._setActionGateForTests(null);
    assert.deepEqual(gateMod.askDashboardOnly({ convId: conv.id, turnId, questions: q }), { dashboardOnly: true, reason: 'classifier_unavailable' });
    gateMod._setActionGateForTests(undefined);
    for (const text of ['Shall I push to origin main?', 'Deploy to production now?', 'Mag ik de database wissen?']) {
      const r = gateMod.askDashboardOnly({ convId: conv.id, turnId, questions: [{ question: text, options: ['yes', 'no'] }] });
      assert.equal(r.dashboardOnly, true, text);
      assert.equal(r.reason, 'hard_gate', text);
    }
    const opt = gateMod.askDashboardOnly({ convId: conv.id, turnId, questions: [{ question: 'Next step?', options: ['git push origin main', 'stop'] }] });
    assert.equal(opt.reason, 'hard_gate', 'an option text counts too');
  } finally { _resetConversationsForTests(); }
});
