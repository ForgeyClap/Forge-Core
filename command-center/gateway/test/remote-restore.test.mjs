// Remote Bridge manager: Tailscale-mode detection, restore-on-boot of an enabled bridge, and the
// honest failure when the saved address is gone. Real sockets, temp data dir, test interfaces.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import {
  _setRemoteDataDirForTests, _setInterfacesForTests, _resetRemoteForTests,
  enableRemote, getRemoteStatus, restoreRemoteBridgeOnBoot, stopRemoteBridge,
} from '../src/remote/manager.mjs';

let dataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// restore only happens in the gateway that enabled the bridge (NEW-1): name this test process
const THIS_GATEWAY = { project_root: PROJECT_ROOT, data_dir: COMMAND_CENTER_DATA_DIR };

function writeSettings(obj) {
  obj = { enabled_by: THIS_GATEWAY, ...obj };
  fs.mkdirSync(path.join(dataDir, 'remote'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'remote', 'settings.json'), JSON.stringify(obj), 'utf8');
}

before(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-restore-')); });
afterEach(async () => {
  await _resetRemoteForTests();
  delete process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK;
  fs.rmSync(path.join(dataDir, 'remote'), { recursive: true, force: true });
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));

test('mode tailscale without a 100.64.0.0/10 interface answers 409 no_tailscale_address and starts nothing', async () => {
  _setRemoteDataDirForTests(dataDir);
  _setInterfacesForTests({ eth: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] });
  const r = await enableRemote({ mode: 'tailscale' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'no_tailscale_address');
  assert.equal(getRemoteStatus().running, false);
  assert.equal(getRemoteStatus().candidates.tailscale, null);
  assert.deepEqual(getRemoteStatus().candidates.lan_addresses, ['192.168.1.20']);
  assert.deepEqual(getRemoteStatus().candidates.lan, [{ address: '192.168.1.20', interface: 'eth', virtual: false }]);
  assert.equal(getRemoteStatus().candidates.recommended_mode, 'lan');
});

test('restore on boot: nothing happens while the bridge is off', async () => {
  _setRemoteDataDirForTests(dataDir);
  assert.deepEqual(await restoreRemoteBridgeOnBoot({ env: {} }), { outcome: 'off' });
  assert.equal(getRemoteStatus().running, false);
});

test('restore on boot: LAN mode is NOT started again; it needs an explicit enable after every gateway start', async () => {
  process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK = '1';
  _setRemoteDataDirForTests(dataDir);
  const port = await freePort();
  const on = await enableRemote({ mode: 'lan', address: '127.0.0.1', port, allow_lan_writes: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  await stopRemoteBridge();
  assert.equal(getRemoteStatus().running, false);
  assert.equal(getRemoteStatus().enabled, true, 'a shutdown stop keeps the owner setting');
  const r = await restoreRemoteBridgeOnBoot({ env: {} });
  assert.equal(r.outcome, 'lan_not_restored');
  assert.equal(getRemoteStatus().running, false);
  assert.match(getRemoteStatus().last_error, /LAN mode is not started again/);
});

test('restore on boot: Tailscale mode is started again on the detected Tailscale address', async () => {
  _setRemoteDataDirForTests(dataDir);
  // a Tailscale adapter whose address this test machine does not really have: restore must TRY it
  _setInterfacesForTests({ Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }] });
  writeSettings({ enabled: true, mode: 'tailscale', address: null, port: await freePort() });
  const r = await restoreRemoteBridgeOnBoot({ env: {} });
  assert.equal(r.outcome, 'failed', JSON.stringify(r));
  assert.match(r.detail, /not available on this PC/, 'it tried to listen on 100.101.102.103');
});

test('restore on boot: a saved Tailscale bridge with no Tailscale address fails honestly, sets last_error, never throws', async () => {
  _setRemoteDataDirForTests(dataDir);
  _setInterfacesForTests({ eth: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] });
  writeSettings({ enabled: true, mode: 'tailscale', address: null, port: 4110 });
  const r = await restoreRemoteBridgeOnBoot({ env: {} });
  assert.equal(r.outcome, 'failed');
  assert.equal(getRemoteStatus().running, false);
  assert.match(getRemoteStatus().last_error, /Tailscale/);
});
