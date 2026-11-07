// WP B1a: paths.mjs resolves its core dir, data dir and project scan roots from env. paths.mjs
// computes its constants once at import, so every case runs a fresh child process with its own env
// and reads the resolved values back as JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PATHS_URL = pathToFileURL(fileURLToPath(new URL('../src/paths.mjs', import.meta.url))).href;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ENV_KEYS = ['FORGE_CORE_DIR', 'FORGE_DATA_DIR', 'FORGE_PROJECT_ROOTS', 'CC_PROJECTS_EXTRA_ROOT'];

function resolvePaths(extraEnv) {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  Object.assign(env, extraEnv);
  const script = `import(${JSON.stringify(PATHS_URL)}).then((m) => {
    process.stdout.write(JSON.stringify({
      PROJECT_ROOT: m.PROJECT_ROOT, CLAUDE_DIR: m.CLAUDE_DIR, COMMAND_CENTER_DATA_DIR: m.COMMAND_CENTER_DATA_DIR,
      DEFAULT_COMMAND_CENTER_DATA_DIR: m.DEFAULT_COMMAND_CENTER_DATA_DIR, CONVERSATIONS_DIR: m.CONVERSATIONS_DIR,
      ATTACHMENTS_DIR: m.ATTACHMENTS_DIR, DISCORD_STATE_DIR: m.DISCORD_STATE_DIR, DISCORD_LOG_FILE: m.DISCORD_LOG_FILE,
      SYNC_SCAN_ROOT: m.SYNC_SCAN_ROOT, SYNC_SCAN_ROOTS: m.SYNC_SCAN_ROOTS, FORGE_PROJECTS_ROOT: m.FORGE_PROJECTS_ROOT,
    }));
  }, (e) => { process.stderr.write('IMPORT-FAILED: ' + e.message); process.exit(3); });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 20000 });
  return { status: r.status, stderr: r.stderr, values: r.status === 0 ? JSON.parse(r.stdout) : null };
}

function makeTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1a-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

test('without env the dev derivation is unchanged: repo root as core, command-center/.data as data dir', () => {
  const r = resolvePaths({});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(samePath(r.values.PROJECT_ROOT, REPO_ROOT));
  assert.equal(r.values.COMMAND_CENTER_DATA_DIR, path.join(REPO_ROOT, 'command-center', '.data'));
  assert.equal(r.values.COMMAND_CENTER_DATA_DIR, r.values.DEFAULT_COMMAND_CENTER_DATA_DIR);
  assert.equal(r.values.SYNC_SCAN_ROOT, path.dirname(r.values.PROJECT_ROOT));
});

test('FORGE_CORE_DIR and FORGE_DATA_DIR relocate the core and every data writer path', (t) => {
  const core = makeTemp(t);
  const data = path.join(makeTemp(t), 'Forge Systeem'); // need not exist yet: writers mkdir it
  const r = resolvePaths({ FORGE_CORE_DIR: core, FORGE_DATA_DIR: data });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.values.PROJECT_ROOT, core);
  assert.equal(r.values.CLAUDE_DIR, path.join(core, '.claude'));
  assert.equal(r.values.COMMAND_CENTER_DATA_DIR, data);
  assert.equal(r.values.CONVERSATIONS_DIR, path.join(data, 'conversations'));
  assert.equal(r.values.ATTACHMENTS_DIR, path.join(data, 'attachments'));
  assert.equal(r.values.DISCORD_STATE_DIR, path.join(data, 'discord', 'state'));
  assert.equal(r.values.DISCORD_LOG_FILE, path.join(data, 'discord', 'discord-bot.log'));
  assert.notEqual(r.values.COMMAND_CENTER_DATA_DIR, r.values.DEFAULT_COMMAND_CENTER_DATA_DIR);
});

test('an invalid FORGE_DATA_DIR / FORGE_CORE_DIR fails the import loudly instead of writing elsewhere', (t) => {
  const missing = path.join(makeTemp(t), 'does-not-exist');
  const cases = [
    [{ FORGE_DATA_DIR: 'relative/dir' }, /FORGE_DATA_DIR is invalid: .*not an absolute path/],
    [{ FORGE_DATA_DIR: '\\\\host\\share\\data' }, /FORGE_DATA_DIR is invalid: a network or device path/],
    [{ FORGE_DATA_DIR: path.join(os.tmpdir(), 'x\ny') }, /FORGE_DATA_DIR is invalid: it contains control characters/],
    [{ FORGE_CORE_DIR: missing }, /FORGE_CORE_DIR is invalid: .*does not exist/],
  ];
  for (const [env, re] of cases) {
    const r = resolvePaths(env);
    assert.equal(r.status, 3, 'import must fail for ' + JSON.stringify(env));
    assert.match(r.stderr, re);
  }
});

test('FORGE_PROJECT_ROOTS replaces the built-in scan roots; the first root also hosts ForgeProjects', (t) => {
  const a = makeTemp(t);
  const b = makeTemp(t);
  const r = resolvePaths({ FORGE_PROJECT_ROOTS: [a, b].join(path.delimiter) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.values.SYNC_SCAN_ROOTS, [a, b]);
  assert.equal(r.values.SYNC_SCAN_ROOT, a);
  assert.equal(r.values.FORGE_PROJECTS_ROOT, path.join(a, 'ForgeProjects'));
  assert.ok(!r.values.SYNC_SCAN_ROOTS.some((p) => samePath(p, path.join(os.homedir(), 'Desktop'))), 'no hardcoded user folder');
});

test('FORGE_PROJECT_ROOTS skips a rejected entry (home, missing) with a named log line when another entry is accepted', (t) => {
  const a = makeTemp(t);
  const missing = path.join(a, 'nope');
  const partial = resolvePaths({ FORGE_PROJECT_ROOTS: [os.homedir(), missing, a].join(path.delimiter) });
  assert.equal(partial.status, 0, partial.stderr);
  assert.deepEqual(partial.values.SYNC_SCAN_ROOTS, [a]);
  assert.match(partial.stderr, /FORGE_PROJECT_ROOTS entry ignored: .*is the home folder itself/);
  assert.match(partial.stderr, /FORGE_PROJECT_ROOTS entry ignored: .*nope" does not exist/);
});

test('FORGE_PROJECT_ROOTS set but NO entry accepted: the import fails naming every rejected entry (dev and installed mode), never a silent fallback', (t) => {
  const a = makeTemp(t);
  const missing = path.join(a, 'unplugged-usb');
  const value = [missing, 'relative/projects'].join(path.delimiter);
  for (const extra of [{}, { FORGE_CORE_DIR: makeTemp(t) }]) {
    const r = resolvePaths({ FORGE_PROJECT_ROOTS: value, ...extra });
    assert.equal(r.status, 3, 'import must fail for ' + JSON.stringify(extra) + '; stderr=' + r.stderr);
    assert.match(r.stderr, /FORGE_PROJECT_ROOTS is invalid: no entry was accepted/);
    assert.ok(r.stderr.includes(missing), 'the rejected missing folder is named');
    assert.match(r.stderr, /"relative\/projects" is not an absolute path/);
  }
});

// Installed mode: FORGE_CORE_DIR set. The home folder is pointed at a temp dir in the child
// (USERPROFILE on Windows, HOME elsewhere) so the built-in Documents/Desktop roots are deterministic.
function installedLayout(t) {
  const base = makeTemp(t);
  const install = path.join(base, 'Programs', 'Forge Systeem', 'resources');
  const core = path.join(install, 'forge-core');
  const home = path.join(base, 'home');
  fs.mkdirSync(core, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { install, core, home, homeEnv: { USERPROFILE: home, HOME: home } };
}
const isInside = (child, parent) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

test('installed mode without FORGE_PROJECT_ROOTS: the install parent is never a scan root nor the ForgeProjects host', (t) => {
  const L = installedLayout(t);
  const r = resolvePaths({ FORGE_CORE_DIR: L.core, ...L.homeEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.values.PROJECT_ROOT, L.core);
  assert.ok(!r.values.SYNC_SCAN_ROOTS.some((p) => isInside(p, L.install)), 'no scan root inside the install tree: ' + r.values.SYNC_SCAN_ROOTS);
  assert.ok(!r.values.SYNC_SCAN_ROOTS.some((p) => samePath(p, path.dirname(L.core))), 'dirname(FORGE_CORE_DIR) is not scanned');
  assert.deepEqual(r.values.SYNC_SCAN_ROOTS, [path.join(L.home, 'Documents'), path.join(L.home, 'Desktop')]);
  assert.equal(r.values.FORGE_PROJECTS_ROOT, path.join(L.home, 'Documents', 'ForgeProjects'));
  assert.ok(!isInside(r.values.FORGE_PROJECTS_ROOT, path.dirname(L.core)), 'ForgeProjects never under the install parent');
});

test('installed mode with FORGE_PROJECT_ROOTS: only the chosen roots, ForgeProjects in the first one', (t) => {
  const L = installedLayout(t);
  const chosen = makeTemp(t);
  const r = resolvePaths({ FORGE_CORE_DIR: L.core, FORGE_PROJECT_ROOTS: chosen, ...L.homeEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.values.SYNC_SCAN_ROOTS, [chosen]);
  assert.equal(r.values.FORGE_PROJECTS_ROOT, path.join(chosen, 'ForgeProjects'));
});

test('dev mode keeps the old roots: the repo parent first (it hosts ForgeProjects), then Documents and Desktop', (t) => {
  const home = makeTemp(t);
  const r = resolvePaths({ USERPROFILE: home, HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.values.SYNC_SCAN_ROOTS, [path.dirname(r.values.PROJECT_ROOT), path.join(home, 'Documents'), path.join(home, 'Desktop')]);
  assert.equal(r.values.FORGE_PROJECTS_ROOT, path.join(path.dirname(r.values.PROJECT_ROOT), 'ForgeProjects'));
});
