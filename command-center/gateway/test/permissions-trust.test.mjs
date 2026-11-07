// WP B3-sec-impl (Security Boss Step 1c): permissions/trust.mjs fails closed when the trust file sits
// inside a project folder (the agent could write it there without a card), and every trust change
// or ignored mark is logged next to the trust file (trust-events.jsonl). mode.mjs then never spawns
// bypass for such a project. Everything runs in temp folders; nothing is written into a real project.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isProjectTrusted,
  setProjectTrusted,
  listTrustedProjects,
  TRUST_FILE_INSIDE_PROJECT,
  _setTrustFileForTests,
} from '../src/permissions/trust.mjs';
import { resolveEffectiveMode } from '../src/permissions/mode.mjs';
import { setAdmittedRegistryRoots, _resetAdmittedRegistryRootsForTests } from '../src/admitted-roots.mjs';
import { SYNC_SCAN_ROOTS } from '../src/paths.mjs';

let tempDir;
let project; // the folder a conversation runs in
let dataDir; // a data dir OUTSIDE every project (the desktop layout)

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-trust-'));
});
after(() => {
  _setTrustFileForTests(null);
  _resetAdmittedRegistryRootsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  _resetAdmittedRegistryRootsForTests();
  const run = fs.mkdtempSync(path.join(tempDir, 'case-'));
  project = path.join(run, 'my-project');
  dataDir = path.join(run, 'appdata', 'Forge Systeem');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

/** What an agent could do inside its own folder: write a trust file that names that folder. */
function plantTrustFile(file, trusted) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ trusted }), 'utf8');
  _setTrustFileForTests(file);
}

function trustEvents(file) {
  const log = path.join(path.dirname(file), 'trust-events.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('REGRESSION (Step 1c): a trust file inside the project folder itself trusts nothing, is logged, and bypass is never spawned', () => {
  const file = path.join(project, '.data', 'permissions', 'trusted-projects.json');
  plantTrustFile(file, [project]);
  assert.equal(isProjectTrusted(project), false);
  assert.deepEqual(listTrustedProjects(), []);
  const [event] = trustEvents(file);
  assert.equal(event.kind, 'permission_trust_ignored');
  assert.equal(event.reason, TRUST_FILE_INSIDE_PROJECT);
  assert.equal(event.project, project);
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  const mode = resolveEffectiveMode('bypass', { trusted: isProjectTrusted(project) });
  assert.deepEqual(mode, { mode: 'accept-edits', requested: 'bypass', downgraded: true, reason: 'project_not_trusted' });
});

test('REGRESSION (Step 1c): a trust file inside ANOTHER registered project folder trusts nothing either', () => {
  const other = path.join(path.dirname(project), 'registered-other');
  fs.mkdirSync(other, { recursive: true });
  setAdmittedRegistryRoots([fs.realpathSync(other)]);
  const file = path.join(other, '.data', 'trusted-projects.json');
  plantTrustFile(file, [project]);
  assert.equal(isProjectTrusted(project), false);
  assert.equal(trustEvents(file)[0].kind, 'permission_trust_ignored');
});

test('REGRESSION (Step 1c): a trust file under a scan root (where discovered projects live) trusts nothing', () => {
  const root = path.join(path.dirname(project), 'scan-root');
  fs.mkdirSync(root, { recursive: true });
  SYNC_SCAN_ROOTS.push(root);
  try {
    const file = path.join(root, 'some-project', '.data', 'trusted-projects.json');
    plantTrustFile(file, [project]);
    assert.equal(isProjectTrusted(project), false);
  } finally {
    SYNC_SCAN_ROOTS.splice(SYNC_SCAN_ROOTS.indexOf(root), 1);
  }
});

test('setProjectTrusted refuses (code trust_file_inside_project), stores nothing, and logs the refusal', () => {
  const file = path.join(project, '.data', 'trusted-projects.json');
  _setTrustFileForTests(file);
  assert.throws(() => setProjectTrusted(project, true, { source: 'dashboard' }), (err) => err.code === TRUST_FILE_INSIDE_PROJECT);
  assert.equal(fs.existsSync(file), false);
  const [event] = trustEvents(file);
  assert.equal(event.kind, 'permission_trust_ignored');
  assert.equal(event.action, 'set');
  assert.equal(event.source, 'dashboard');
  assert.equal(event.trusted, true);
});

test('a trust file OUTSIDE every project still works, and every change is logged with its source', () => {
  const file = path.join(dataDir, 'permissions', 'trusted-projects.json');
  _setTrustFileForTests(file);
  assert.equal(isProjectTrusted(project), false, 'closed by default');
  setProjectTrusted(project, true, { source: 'dashboard' });
  assert.equal(isProjectTrusted(project), true);
  assert.equal(listTrustedProjects().length, 1);
  assert.equal(resolveEffectiveMode('bypass', { trusted: isProjectTrusted(project) }).mode, 'bypass');
  setProjectTrusted(project, false, { source: 'dashboard' });
  assert.equal(isProjectTrusted(project), false);
  const events = trustEvents(file).map((e) => [e.kind, e.trusted, e.source]);
  assert.deepEqual(events, [['permission_trust_changed', true, 'dashboard'], ['permission_trust_changed', false, 'dashboard']]);
});

test('no trust file, an unreadable one, or an empty path: nothing is trusted and nothing is logged', () => {
  const file = path.join(dataDir, 'permissions', 'trusted-projects.json');
  _setTrustFileForTests(file);
  assert.equal(isProjectTrusted(project), false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.equal(isProjectTrusted(project), false);
  assert.equal(isProjectTrusted(''), false);
  assert.equal(isProjectTrusted(null), false);
  assert.deepEqual(trustEvents(file), []);
});
