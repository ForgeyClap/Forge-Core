// Remote Bridge, third security review LOW findings N-1..N-6 (
// WP-BRIDGE-LOW). Every test here was seen RED on the code before the fix.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as manager from '../src/remote/manager.mjs';
import * as scribe from '../src/remote/scribe.mjs';
import { realLocation } from '../src/remote/real-location.mjs';
import { createDeviceStore } from '../src/remote/devices.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-low-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
afterEach(async () => {
  scribe._setScribeCentralBinForTests(null);
  await manager._resetRemoteForTests();
  manager._setRemoteDataDirForTests(null);
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
function scribeProject(name) {
  const project = path.join(sub('proj'), name);
  writeFile(path.join(project, '.claude', 'forge-bin', 'forge-scribe.cjs'), 'process.exit(3);\n');
  fs.mkdirSync(path.join(project, '.claude', 'forge-scribe'), { recursive: true });
  return project;
}
/** A fake central scribe: leaves a marker per run; a project named "blocker-*" waits for `release`. */
function fakeCentral() {
  const dir = sub('central');
  const marker = path.join(dir, 'RAN-');
  const release = path.join(dir, 'release');
  writeFile(path.join(dir, 'forge-scribe.cjs'), [
    "const fs = require('fs'), path = require('path');",
    'const name = path.basename(process.env.FORGE_PROJECT_ROOT);',
    'fs.writeFileSync(' + JSON.stringify(marker) + ' + name, "ran");',
    "if (!name.startsWith('blocker')) { console.log('[]'); return; }",
    'const t = setInterval(() => { if (fs.existsSync(' + JSON.stringify(release) + ')) { clearInterval(t); console.log("[]"); } }, 20);',
  ].join('\n') + '\n');
  return { dir, ran: (name) => fs.existsSync(marker + name), release: () => fs.writeFileSync(release, 'go') };
}

// ---------------------------------------------------------------- N-1 check inside the slot

test('N-1: the store check runs inside the slot, right before the spawn (a store moved outside while queued is refused)', async () => {
  const central = fakeCentral();
  scribe._setScribeCentralBinForTests(central.dir);
  const blockers = [];
  for (let i = 0; i < scribe.SCRIBE_CONCURRENCY; i++) {
    const p = scribeProject('blocker' + i);
    blockers.push(scribe.runScribeList({ name: 'b' + i, path: p }));
  }
  assert.equal(scribe._scribeSlotStatsForTests().active, scribe.SCRIBE_CONCURRENCY, 'every slot is taken');
  const project = scribeProject('moved');
  const queued = scribe.runScribeList({ name: 'moved', path: project }); // the store is inside right now
  // while it waits for a slot the store folder becomes a junction to outside the project
  const outside = sub('outside');
  fs.rmSync(path.join(project, '.claude', 'forge-scribe'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(project, '.claude', 'forge-scribe'), 'junction');
  central.release();
  const results = await Promise.all(blockers);
  for (const r of results) assert.equal(r.available, true, JSON.stringify(r));
  const r = await queued;
  assert.deepEqual(r, { available: false, items: [], reason: 'store_outside_project' });
  assert.equal(central.ran('moved'), false, 'the scribe ran against a store that had moved outside the project');
});

// ---------------------------------------------------------------- N-2 links on the store files

test('N-2: a store FILE that is a link (junction named inbox.jsonl / .lock) is refused; plain files run', async () => {
  const central = fakeCentral();
  scribe._setScribeCentralBinForTests(central.dir);
  for (const name of ['inbox.jsonl', 'ledger.jsonl', 'skipped.jsonl', 'state.json', 'DIGEST.md', '.lock']) {
    const project = scribeProject('linkfile');
    const outside = sub('outside-file');
    fs.symlinkSync(outside, path.join(project, '.claude', 'forge-scribe', name), 'junction');
    const r = await scribe.runScribeList({ name: 'linkfile', path: project });
    assert.deepEqual(r, { available: false, items: [], reason: 'store_outside_project' }, name);
    assert.equal(central.ran('linkfile'), false, 'the scribe ran with a linked ' + name);
  }
  // control: the same store with plain files runs
  const project = scribeProject('plainfiles');
  for (const name of ['inbox.jsonl', 'ledger.jsonl', 'state.json', 'DIGEST.md']) writeFile(path.join(project, '.claude', 'forge-scribe', name), '');
  const ok = await scribe.runScribeList({ name: 'plainfiles', path: project });
  assert.equal(ok.available, true, JSON.stringify(ok));
  assert.equal(central.ran('plainfiles'), true);
});

// ---------------------------------------------------------------- N-3 dangling link

test('N-3: realLocation walks up only past a missing path; a dangling link gives null', () => {
  const base = sub('n3');
  const realBase = fs.realpathSync.native(base);
  assert.equal(realLocation(path.join(base, 'a', 'b')), path.join(realBase, 'a', 'b'), 'missing parts still walk up');
  const target = sub('n3-target');
  const link = path.join(base, 'dangling');
  fs.symlinkSync(target, link, 'junction');
  fs.rmSync(target, { recursive: true, force: true });
  assert.equal(realLocation(link), null);
  assert.equal(realLocation(path.join(link, 'scribe')), null);
});

test('N-3: a store folder that is a dangling junction is refused; the scribe never runs', async () => {
  const central = fakeCentral();
  scribe._setScribeCentralBinForTests(central.dir);
  const project = scribeProject('dangling');
  const target = sub('gone');
  fs.rmSync(path.join(project, '.claude', 'forge-scribe'), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(project, '.claude', 'forge-scribe'), 'junction');
  fs.rmSync(target, { recursive: true, force: true });
  const r = await scribe.runScribeList({ name: 'dangling', path: project });
  assert.deepEqual(r, { available: false, items: [], reason: 'store_outside_project' });
  assert.equal(central.ran('dangling'), false);
});

test('N-3: a remote state folder that is a dangling junction is a state problem (fail closed)', () => {
  const base = sub('n3-state');
  const target = sub('n3-state-target');
  fs.symlinkSync(target, path.join(base, 'remote'), 'junction');
  fs.rmSync(target, { recursive: true, force: true });
  manager._setRemoteDataDirForTests(base);
  assert.equal(manager.getRemoteStatus().state_problem, manager.STATE_INSIDE_PROJECT);
});

// ---------------------------------------------------------------- N-4 contract wording

test('N-4: the contract does not claim every call is audited', () => {
  const text = fs.readFileSync(path.join(HERE, '..', '..', 'docs', 'REMOTE-BRIDGE-CONTRACT.md'), 'utf8');
  assert.doesNotMatch(text, /Every call is written to the audit log/);
  assert.match(text, /every call that reaches a route handler, plus auth and origin refusals/i);
});

// ---------------------------------------------------------------- N-5 autostart_off shows why

test('N-5: an opted-out boot restore of an enabled bridge sets last_error to the opt-out reason', async () => {
  const dataDir = sub('n5');
  manager._setRemoteDataDirForTests(dataDir);
  writeFile(path.join(dataDir, 'remote', 'settings.json'), JSON.stringify({
    enabled: true, mode: 'tailscale', address: null, port: 47999, enabled_by: { project_root: PROJECT_ROOT, data_dir: COMMAND_CENTER_DATA_DIR },
  }));
  const r = await manager.restoreRemoteBridgeOnBoot({ env: { FORGE_REMOTE_BRIDGE_AUTOSTART: 'off' } });
  assert.equal(r.outcome, 'autostart_off');
  assert.match(String(manager.getRemoteStatus().last_error), /FORGE_REMOTE_BRIDGE_AUTOSTART=off/);
  assert.equal(fs.existsSync(path.join(dataDir, 'remote', 'audit.jsonl')), false, 'an opted-out gateway still writes nothing');
});

test('N-5: an opted-out boot restore of a bridge that was never enabled leaves last_error empty', async () => {
  manager._setRemoteDataDirForTests(sub('n5-off'));
  const r = await manager.restoreRemoteBridgeOnBoot({ env: { FORGE_REMOTE_BRIDGE_AUTOSTART: 'off' } });
  assert.equal(r.outcome, 'autostart_off');
  assert.equal(manager.getRemoteStatus().last_error, null);
});

// ---------------------------------------------------------------- N-6 revoke rolls back on a failed save

test('N-6: revoke whose save throws leaves the device active in memory and on disk', () => {
  const dir = sub('n6');
  const store = createDeviceStore(dir);
  const { token, device } = store.add('Pixel');
  // the atomic write's temp path is a folder: writeFileSync throws EISDIR
  fs.mkdirSync(path.join(dir, 'devices.json.' + process.pid + '.tmp'));
  assert.throws(() => store.revoke(device.id), /EISDIR|EPERM|illegal operation/i);
  assert.equal(store.list().find((d) => d.id === device.id).revoked_at, null, 'memory says revoked while the disk does not');
  assert.equal(store.authenticate(token)?.id, device.id);
  assert.equal(createDeviceStore(dir).activeCount(), 1);
});
