// Remote Bridge, second security review notes (WP-BRIDGE-NOTES): restore only in the gateway that
// enabled the bridge and never in a test/temp gateway (NEW-1), audit flood cap for bad pair bodies,
// rate_limited and unauthenticated 4xx lines plus three audit files (NEW-2), no gateway paths or
// registry text through passThrough (NEW-3), a revoke from another gateway survives a last_seen
// save (NEW-5), and a scribe store that points outside its project is never touched (NV-1).
// Temp folders only; the real per-user state folder (~/.forge/remote) is never read or written.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import * as manager from '../src/remote/manager.mjs';
import * as scribe from '../src/remote/scribe.mjs';
import * as phone from '../src/remote/phone-routes.mjs';
import * as audit from '../src/remote/audit.mjs';
import * as bridge from '../src/remote/bridge-server.mjs';
import { createPairing } from '../src/remote/pairing.mjs';
import { createDeviceStore } from '../src/remote/devices.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-notes-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
afterEach(async () => {
  scribe._setScribeCentralBinForTests(null);
  await manager._resetRemoteForTests();
  manager._setRemoteDataDirForTests(null);
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
function auditLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
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

const TS_IFACES = { Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }] };
const OWNER_HERE = { project_root: PROJECT_ROOT, data_dir: COMMAND_CENTER_DATA_DIR };

function writeSettings(dataDir, obj) {
  writeFile(path.join(dataDir, 'remote', 'settings.json'), JSON.stringify(obj));
}

// ---------------------------------------------------------------- NEW-1 restore only where it belongs

test('NEW-1: FORGE_REMOTE_BRIDGE_AUTOSTART=off (and a Node test runner process) never restores the bridge', async () => {
  const dataDir = sub('autostart');
  manager._setRemoteDataDirForTests(dataDir);
  manager._setInterfacesForTests(TS_IFACES);
  writeSettings(dataDir, { enabled: true, mode: 'tailscale', address: null, port: await freePort(), enabled_by: OWNER_HERE });
  for (const env of [{ FORGE_REMOTE_BRIDGE_AUTOSTART: 'off' }, { FORGE_REMOTE_BRIDGE_AUTOSTART: 'OFF' }, { NODE_TEST_CONTEXT: 'child-v8' }, { CC_TEST_THROW_AFTER_MS: '50' }]) {
    const r = await manager.restoreRemoteBridgeOnBoot({ env });
    assert.equal(r.outcome, 'autostart_off', JSON.stringify(env) + ' ' + JSON.stringify(r));
    assert.equal(manager.getRemoteStatus().running, false);
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'remote', 'audit.jsonl')), false, 'an opted-out gateway writes nothing');
  // control: the same settings in a normal process are tried (and fail: this PC has no 100.101.102.103)
  const tried = await manager.restoreRemoteBridgeOnBoot({ env: {} });
  assert.equal(tried.outcome, 'failed', JSON.stringify(tried));
  assert.match(tried.detail, /not available on this PC/);
});

test('NEW-1: enable records which gateway enabled the bridge (project root + data dir)', async () => {
  process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK = '1';
  const dataDir = sub('owner-record');
  manager._setRemoteDataDirForTests(dataDir);
  const r = await manager.enableRemote({ mode: 'lan', address: '127.0.0.1', port: await freePort() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote', 'settings.json'), 'utf8'));
  assert.deepEqual(s.enabled_by, OWNER_HERE);
  await manager.disableRemote();
  const off = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote', 'settings.json'), 'utf8'));
  assert.equal(off.enabled, false);
});

test('NEW-1: another gateway (other data dir or other install root), or settings without an owner, never restore', async () => {
  const dataDir = sub('not-owner');
  manager._setRemoteDataDirForTests(dataDir);
  manager._setInterfacesForTests(TS_IFACES);
  const port = await freePort();
  const others = [
    { project_root: PROJECT_ROOT, data_dir: path.join(tmp, 'some-temp-gateway-data') },
    { project_root: path.join(tmp, 'Forge Command Center install'), data_dir: COMMAND_CENTER_DATA_DIR },
    undefined,
    'C:\\x',
  ];
  for (const enabledBy of others) {
    writeSettings(dataDir, { enabled: true, mode: 'tailscale', address: null, port, ...(enabledBy === undefined ? {} : { enabled_by: enabledBy }) });
    const r = await manager.restoreRemoteBridgeOnBoot({ env: {} });
    assert.equal(r.outcome, 'not_owner', JSON.stringify(enabledBy) + ' ' + JSON.stringify(r));
    assert.match(r.detail, /another gateway/);
    assert.equal(manager.getRemoteStatus().running, false);
  }
  writeSettings(dataDir, { enabled: true, mode: 'tailscale', address: null, port, enabled_by: OWNER_HERE });
  assert.equal((await manager.restoreRemoteBridgeOnBoot({ env: {} })).outcome, 'failed', 'the enabling gateway itself tries to restore');
});

// ---------------------------------------------------------------- NEW-2 audit flooding

test('NEW-2: rate_limited, pair_failed, pair_invalid and every unauthenticated 4xx line are capped per IP', () => {
  const file = path.join(sub('audit-cap'), 'audit.jsonl');
  let now = Date.parse('2026-11-09T08:00:00Z');
  const log = audit.createAuditLog(file, { refusedPerWindow: 3, windowMs: 60_000, clock: () => now });
  const ip = '10.0.0.9';
  for (let i = 0; i < 10; i++) log.write({ action: 'rate_limited', status: 429, ip: '10.0.0.1', device_id: 'd1', device_name: 'Phone' });
  for (let i = 0; i < 10; i++) log.write({ action: 'pair_invalid', status: 400, ip });
  for (let i = 0; i < 10; i++) log.write({ action: 'pair_failed', status: 401, ip: '10.0.0.2' });
  for (let i = 0; i < 10; i++) log.write({ action: 'request', status: 404, ip: '10.0.0.3', device_id: null });
  for (let i = 0; i < 5; i++) log.write({ action: 'request', status: 404, ip: '10.0.0.4', device_id: 'd1' });
  log.write({ action: 'pair_ok', status: 201, ip: '10.0.0.5' });
  const lines = auditLines(file);
  for (const capped of ['10.0.0.1', ip, '10.0.0.2', '10.0.0.3']) assert.equal(lines.filter((l) => l.ip === capped).length, 3, capped);
  assert.equal(lines.filter((l) => l.ip === '10.0.0.4').length, 5, 'an authenticated 4xx is a normal action');
  assert.equal(lines.filter((l) => l.ip === '10.0.0.5').length, 1);
  now += 61_000;
  log.flush();
  const summary = auditLines(file).find((l) => l.action === 'audit_suppressed' && l.ip === '10.0.0.1');
  assert.ok(summary);
  assert.deepEqual(summary.detail.by_action, { rate_limited: 7 });
});

test('NEW-2: rotation keeps three files: audit.jsonl, audit.jsonl.1 and audit.jsonl.2', () => {
  const file = path.join(sub('audit-rot'), 'audit.jsonl');
  const log = audit.createAuditLog(file, { maxBytes: 400 });
  for (let i = 0; i < 40; i++) log.write({ action: 'request', status: 200, ip: '10.0.0.1', detail: { n: i } });
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(fs.existsSync(file + '.2'));
  assert.equal(fs.existsSync(file + '.3'), false, 'never more than three files');
  const newestOld = auditLines(file + '.1').map((l) => l.detail.n);
  const oldest = auditLines(file + '.2').map((l) => l.detail.n);
  assert.ok(Math.max(...oldest) < Math.min(...newestOld), '.2 holds older lines than .1');
});

async function startBridge(extra) {
  const lines = [];
  const port = await freePort();
  const srv = bridge.createBridgeServer({
    address: '127.0.0.1', port, mode: 'tailscale',
    devices: { authenticate: () => null, add: () => { throw new Error('must not pair'); } },
    pairing: createPairing(),
    audit: { write: (e) => lines.push(e) },
    limits: bridge.createLimits(),
    scribeRunner: async () => ({ available: false, items: [] }),
    ...extra,
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, lines, close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

test('NEW-2: a bad pair body counts as a pairing failure (lockout after 5) and is audited as a refused pair_invalid', async () => {
  const pairing = createPairing();
  const { code } = pairing.createCode();
  const b = await startBridge({ pairing });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await rawRequest(b.port, 'POST', '/remote/v1/pair', { body: { code: 'x', device_name: '' } });
      assert.equal(r.statusCode, 400, JSON.stringify(r.json));
    }
    assert.equal(b.lines.filter((l) => l.action === 'pair_invalid').length, 5, JSON.stringify(b.lines));
    const right = await rawRequest(b.port, 'POST', '/remote/v1/pair', { body: { code, device_name: 'Phone' } });
    assert.equal(right.statusCode, 429, 'five bad bodies lock the IP out, also for the right code');
    assert.equal(right.json.code, 'locked_out');
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- NEW-3 passThrough

test('NEW-3: passThrough maps 502 to the generic text and strips matches (absolute paths) from a 409', () => {
  const bad = phone.passThrough({ status: 502, json: { ok: false, error: 'cannot read C:\\Users\\owner\\.claude\\forge\\projects.json' } });
  assert.equal(bad.status, 502);
  assert.equal(bad.body.code, 'registry_error');
  assert.doesNotMatch(bad.body.error, /Users|projects\.json/);
  assert.match(bad.body.error, /project list on the PC could not be read/);
  const amb = phone.passThrough({ status: 409, json: { ok: false, error: 'two projects share this name', matches: [{ name: 'x', path: 'C:\\Users\\owner\\a\\x' }, { name: 'x', path: 'D:\\x' }] } });
  assert.equal(amb.status, 409);
  assert.equal('matches' in amb.body, false, JSON.stringify(amb.body));
  assert.doesNotMatch(JSON.stringify(amb.body), /Users/);
  const ok = phone.passThrough({ status: 200, json: { ok: true, answered: true } });
  assert.deepEqual(ok.body, { ok: true, answered: true });
});

// ---------------------------------------------------------------- NEW-5 revoke race

test('NEW-5: a revoke by another gateway between authenticate\'s read and its last_seen save is kept, and the token is refused', () => {
  const dir = sub('devices-race');
  let t = Date.parse('2026-11-09T08:00:00Z');
  const storeB = createDeviceStore(dir, { clock: () => t });
  const { token, device } = storeB.add('Phone');
  let revokeOnNextClock = false;
  const storeA = createDeviceStore(dir, {
    clock: () => {
      if (revokeOnNextClock) { revokeOnNextClock = false; storeB.revoke(device.id); }
      return t;
    },
  });
  assert.equal(storeA.authenticate(token).id, device.id);
  t += 5 * 60_000; // past the last_seen write interval: A will save
  revokeOnNextClock = true; // the other gateway revokes right after A read the file
  const r = storeA.authenticate(token);
  assert.equal(r, null, 'the token was revoked before the save');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8')).devices.find((d) => d.id === device.id);
  assert.ok(onDisk.revoked_at, 'the revoke on disk was not undone by the last_seen save');
  assert.equal(storeB.authenticate(token), null);
  assert.equal(createDeviceStore(dir).activeCount(), 0);
});

// ---------------------------------------------------------------- NV-1 scribe store outside the project

/** A fake central scribe that leaves a marker when it runs. */
function markerCentral() {
  const dir = sub('central');
  const marker = path.join(dir, 'CENTRAL-RAN');
  writeFile(path.join(dir, 'forge-scribe.cjs'), "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran'); console.log('[]');\n");
  return { dir, marker };
}
function scribeProject(name) {
  const project = path.join(sub('proj'), name);
  writeFile(path.join(project, '.claude', 'forge-bin', 'forge-scribe.cjs'), 'process.exit(3);\n');
  return project;
}

test('NV-1: a legacy scribe store (.claude/forge-scribe) that is a junction to outside the project is skipped; the scribe never runs', async () => {
  const central = markerCentral();
  scribe._setScribeCentralBinForTests(central.dir);
  const project = scribeProject('junction-legacy');
  const outside = sub('outside-store');
  fs.symlinkSync(outside, path.join(project, '.claude', 'forge-scribe'), 'junction');
  const r = await scribe.runScribeList({ name: 'junction-legacy', path: project });
  assert.deepEqual(r, { available: false, items: [], reason: 'store_outside_project' });
  assert.equal(fs.existsSync(central.marker), false, 'the scribe ran against a store outside the project');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the project');
  // control: a real folder inside the project runs the central scribe
  fs.rmSync(path.join(project, '.claude', 'forge-scribe'), { recursive: true, force: true });
  fs.mkdirSync(path.join(project, '.claude', 'forge-scribe'));
  const ok = await scribe.runScribeList({ name: 'junction-legacy', path: project });
  assert.equal(ok.available, true, JSON.stringify(ok));
  assert.equal(fs.existsSync(central.marker), true);
});

test('NV-1: a .forge state root that is a junction to outside is skipped (store folder from the central forge-paths)', async () => {
  // no central override: the real central forge-paths.cjs decides the store folder (.forge/scribe here)
  const project = scribeProject('junction-forge');
  const outside = sub('outside-forge');
  fs.symlinkSync(outside, path.join(project, '.forge'), 'junction');
  const r = await scribe.runScribeList({ name: 'junction-forge', path: project });
  assert.deepEqual(r, { available: false, items: [], reason: 'store_outside_project' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('NV-1: a whole .claude folder that is a junction to outside is skipped too', async () => {
  const central = markerCentral();
  scribe._setScribeCentralBinForTests(central.dir);
  const project = path.join(sub('proj'), 'junction-claude');
  fs.mkdirSync(project, { recursive: true });
  const outsideClaude = sub('outside-claude');
  writeFile(path.join(outsideClaude, 'forge-bin', 'forge-scribe.cjs'), 'process.exit(3);\n');
  fs.symlinkSync(outsideClaude, path.join(project, '.claude'), 'junction');
  const r = await scribe.runScribeList({ name: 'junction-claude', path: project });
  assert.equal(r.reason, 'store_outside_project', JSON.stringify(r));
  assert.equal(fs.existsSync(central.marker), false);
});
