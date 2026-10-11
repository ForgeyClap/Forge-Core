// HTTP-level tests for GET /api/mindmaps — real server on an ephemeral port (never :4100), with an
// isolated registry: a stub forge-sync lists two temp projects under a temp scan root, so the route is
// exercised end to end (registry allowlist -> per-project folder) without touching the real fleet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { removeDataDirIfCreatedByTests } from './.data-dir-guard.mjs';
import {
  _resetProjectsCacheForTests,
  _setForgeSyncCjsForTests,
  _resetForgeSyncCjsForTests,
  _setScanRootsForTests,
  _resetScanRootsForTests,
} from '../src/projects.mjs';
import { _setInstalledProjectsFileForTests, _resetInstalledProjectsFileForTests } from '../src/installed-projects.mjs';
import { _resetAdmittedRegistryRootsForTests } from '../src/admitted-roots.mjs';
import { request } from '../test-support/helpers.mjs';

const temps = [];
// The server's defense-in-depth containment only admits the REAL scan roots, so the fixture projects live
// under COMMAND_CENTER_DATA_DIR (gitignored, inside this project) — same reason as approvals.test.mjs.
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-mindmaps');
const fresh = (prefix) => { fs.mkdirSync(FIXTURE_PARENT, { recursive: true }); const d = fs.mkdtempSync(path.join(FIXTURE_PARENT, prefix)); temps.push(d); return d; };

let server;
let port;
let scanRoot;
let projA;
let projB;
const NAME_A = 'mm-route-alpha';
const NAME_B = 'mm-route-beta';

function makeProject(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude', 'forge-dashboard'), { recursive: true });
  return dir;
}
function writeMap(projectDir, id, title) {
  const dir = path.join(projectDir, '.claude', 'forge-mindmaps');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
    map_id: id, title, _generated: '2026-10-09T12:00:00.000Z',
    nodes: [{ id: 'r', label: title, kind: 'root', parent: null }, { id: 'c', label: 'Child', kind: 'leaf', parent: 'r' }],
    edges: [{ from: 'r', to: 'c' }],
  }));
}

before(async () => {
  scanRoot = fresh('cc-mm-route-scan-');
  projA = makeProject(scanRoot, NAME_A);
  projB = makeProject(scanRoot, NAME_B);
  writeMap(projA, 'alpha-plan', 'Alpha plan');
  writeMap(projB, 'beta-secret', 'Beta only');
  // A file next to the project folders that no route may ever reach.
  fs.writeFileSync(path.join(scanRoot, 'outside.json'), '{"nodes":[]}');

  const stubDir = fresh('cc-mm-route-stub-');
  const stub = path.join(stubDir, 'stub-forge-sync.cjs');
  fs.writeFileSync(stub, [
    "process.stdout.write('2 Forge project(s) under X:\\n');",
    'process.stdout.write(' + JSON.stringify('  ' + projA + '\n') + ');',
    'process.stdout.write(' + JSON.stringify('  ' + projB + '\n') + ');',
  ].join('\n'));
  _setForgeSyncCjsForTests(stub);
  _setScanRootsForTests([scanRoot]);
  _setInstalledProjectsFileForTests(path.join(os.tmpdir(), 'cc-mm-route-installed-never-created.json'));
  _resetAdmittedRegistryRootsForTests();
  _resetProjectsCacheForTests();

  server = createServer();
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetInstalledProjectsFileForTests();
  _resetAdmittedRegistryRootsForTests();
  _resetProjectsCacheForTests();
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  removeDataDirIfCreatedByTests();
});

const q = (project, id) => '/api/mindmaps?project=' + encodeURIComponent(project) + (id === undefined ? '' : '&id=' + encodeURIComponent(id));

test('lists the mind maps of the named project only', async () => {
  const res = await request(port, q(NAME_A));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.available, true);
  assert.deepEqual(res.json.maps.map((m) => m.id), ['alpha-plan']);
  assert.equal(res.json.maps[0].node_count, 2);
});

test('returns one map by id', async () => {
  const res = await request(port, q(NAME_A, 'alpha-plan'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.map.title, 'Alpha plan');
  assert.equal(res.json.map.nodes.length, 2);
  assert.deepEqual(res.json.map.edges, [{ from: 'r', to: 'c' }]);
});

test('SECURITY: no cross-project read — project A cannot fetch project B\'s map id', async () => {
  const res = await request(port, q(NAME_A, 'beta-secret'));
  assert.equal(res.statusCode, 404);
  assert.ok(!res.body.includes('Beta only'));
});

test('SECURITY: traversal attempts in the map id are rejected with 400 before any lookup', async () => {
  const ids = ['../beta-secret', '..\\..\\outside', '../../outside', '..', 'a/b', 'alpha-plan.json', '%2e%2e%2foutside', ''];
  for (const id of ids) {
    const res = await request(port, q(NAME_A, id));
    assert.equal(res.statusCode, 400, 'id ' + JSON.stringify(id) + ' must be refused, got ' + res.statusCode);
    assert.equal(res.json.ok, false);
  }
  // Raw, un-encoded traversal in the query string as well.
  const raw = await request(port, '/api/mindmaps?project=' + NAME_A + '&id=../../' + NAME_B + '/.claude/forge-mindmaps/beta-secret');
  assert.equal(raw.statusCode, 400);
});

test('SECURITY: traversal attempts in the project name never escape the registry', async () => {
  for (const name of ['../../evil', '..', NAME_A + '/../' + NAME_B, scanRoot, path.join(scanRoot, '..'), '']) {
    const res = await request(port, q(name));
    assert.equal(res.statusCode, 404, 'project ' + JSON.stringify(name) + ' must be 404, got ' + res.statusCode);
    assert.equal(res.json.ok, false);
  }
});

test('an unknown project answers 404 honestly', async () => {
  const res = await request(port, q('definitely-not-a-registered-project'));
  assert.equal(res.statusCode, 404);
  assert.match(res.json.error, /unknown project/);
});

test('a registered project path (absolute) works the same as its name', async () => {
  const res = await request(port, q(projB));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json.maps.map((m) => m.id), ['beta-secret']);
});

test('a project with no mind maps yet answers 200 with available:false, not an error', async () => {
  fs.rmSync(path.join(projB, '.claude', 'forge-mindmaps'), { recursive: true, force: true });
  const res = await request(port, q(NAME_B));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.available, false);
  assert.equal(res.json.provenance, 'NOT GENERATED');
  assert.deepEqual(res.json.maps, []);
});

test('the route is GET-only (a POST does not read anything)', async () => {
  const res = await request(port, q(NAME_A), { method: 'POST' });
  assert.notEqual(res.statusCode, 200);
});
