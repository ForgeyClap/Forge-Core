// App router P1 (design section 3.2 and 3.3): profile folders. Slug rules incl. Windows device
// names, traversal refused, symlink/junction refused, login commands quoted for paths with spaces
// and apostrophes, the FORGE_ROUTER_PROFILES_DIR seam. Only temp folders are touched; nothing is
// ever read inside a profile folder.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  profilesRoot,
  profileSlugOk,
  profileDir,
  ensureProfileDir,
  loginCommands,
  slugFromLabel,
  displayPath,
} from '../src/app-router/profiles.mjs';

const ENV = 'FORGE_ROUTER_PROFILES_DIR';
let tempDir;
let root;
let saved;

before(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-approuter-profiles-')); });
after(() => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
beforeEach(() => {
  saved = process.env[ENV];
  root = path.join(fs.mkdtempSync(path.join(tempDir, 'case-')), "Jan de Vries's map", 'profiles');
  process.env[ENV] = root;
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

test('profilesRoot follows the env seam, else ~/.forge-router/profiles', () => {
  assert.equal(profilesRoot(), path.resolve(root));
  delete process.env[ENV];
  assert.equal(profilesRoot(), path.join(os.homedir(), '.forge-router', 'profiles'));
  process.env[ENV] = 'relative/dir';
  assert.equal(profilesRoot(), path.join(os.homedir(), '.forge-router', 'profiles'), 'a relative seam value is ignored');
});

test('slug rules: pattern, length, reserved names', () => {
  for (const ok of ['werk', 'a', 'prive-2', '0x', 'a'.repeat(32)]) assert.equal(profileSlugOk(ok), true, ok);
  for (const bad of ['', 'Werk', '-a', 'a b', 'a/b', 'a\\b', '..', '.', 'a.b', 'a'.repeat(33), 'main', 'con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9', null, 7]) {
    assert.equal(profileSlugOk(bad), false, String(bad));
  }
});

test('profileDir joins under the root; traversal and bad slugs are refused', () => {
  assert.deepEqual(profileDir('werk'), { ok: true, dir: path.join(path.resolve(root), 'werk') });
  for (const bad of ['..', '../x', 'a/../../b', 'C:\\x', 'con']) {
    const r = profileDir(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, 'bad_profile');
  }
});

test('ensureProfileDir creates the empty folder (and the root) and is idempotent', () => {
  const r = ensureProfileDir('werk');
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.ok(fs.statSync(r.dir).isDirectory());
  assert.deepEqual(fs.readdirSync(r.dir), [], 'directory only, never file content');
  const again = ensureProfileDir('werk');
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(profileDir('werk', { mustExist: true }).ok, true);
});

test('mustExist: a missing folder is reported, not created', () => {
  const r = profileDir('nieuw', { mustExist: true });
  assert.deepEqual(r, { ok: false, code: 'missing' });
  assert.equal(fs.existsSync(path.join(root, 'nieuw')), false);
});

test('a profile folder that is a symlink or junction is refused', () => {
  fs.mkdirSync(root, { recursive: true });
  const elsewhere = path.join(tempDir, 'elsewhere-' + Date.now());
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, 'link'), 'junction');
  assert.deepEqual(profileDir('link', { mustExist: true }), { ok: false, code: 'symlink' });
  assert.deepEqual(ensureProfileDir('link'), { ok: false, code: 'symlink' });
});

test('a file where the folder should be is refused', () => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'plat'), '', 'utf8');
  assert.deepEqual(profileDir('plat', { mustExist: true }), { ok: false, code: 'not_dir' });
  assert.equal(ensureProfileDir('plat').ok, false);
});

test('login commands quote a path with spaces and an apostrophe for each shell', () => {
  const dir = path.join(path.resolve(root), 'werk');
  const c = loginCommands('werk');
  assert.equal(c.powershell, "& { $env:CLAUDE_CONFIG_DIR = '" + dir.replace(/'/g, "''") + "'; try { claude } finally { Remove-Item Env:CLAUDE_CONFIG_DIR } }");
  assert.equal(c.cmd, 'set "CLAUDE_CONFIG_DIR=' + dir + '" && claude');
  assert.equal(c.posix, "CLAUDE_CONFIG_DIR='" + dir.replace(/'/g, "'\\''") + "' claude");
  assert.ok(c.powershell.includes("Jan de Vries''s map"));
  assert.ok(c.posix.includes("Jan de Vries'\\''s map"));
});

test('login commands: a bad slug gives null; a path cmd cannot quote gives cmd null', () => {
  assert.equal(loginCommands('../x'), null);
  process.env[ENV] = path.join(tempDir, '100%done', 'profiles');
  const c = loginCommands('werk');
  assert.equal(c.cmd, null);
  assert.equal(typeof c.powershell, 'string');
});

test('the PowerShell command really sets the folder and removes the variable afterwards', { skip: process.platform !== 'win32' }, () => {
  const dir = path.join(path.resolve(root), 'werk');
  const cmd = loginCommands('werk').powershell.replace('{ claude }', '{ Write-Output ("in=" + $env:CLAUDE_CONFIG_DIR) }');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd + '; Write-Output ("after=" + [string]$env:CLAUDE_CONFIG_DIR)'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(out, ['in=' + dir, 'after=']);
});

// PowerShell reads the curly single quotes U+2018-U+201B as quote marks inside '...': each one must be
// doubled, or a folder name could end the string and run the rest as a command.
const CURLY = ['\u2018', '\u2019', '\u201A', '\u201B'];
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function runPs(command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 60_000 });
}
const PS_SHOW = '{ Write-Output ("in=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:CLAUDE_CONFIG_DIR))) }';
const PS_AFTER = '; Write-Output ("after=" + [string]$env:CLAUDE_CONFIG_DIR)';
const lines = (out) => out.split(/\r?\n/).filter(Boolean);

test('login commands: curly single quotes are doubled for PowerShell; % and a curly apostrophe are handled per shell', () => {
  process.env[ENV] = path.join(tempDir, 'Jan\u2019s 100% ' + CURLY.join('') + ' map', 'profiles');
  const dir = path.join(path.resolve(process.env[ENV]), 'werk');
  const c = loginCommands('werk');
  for (const q of CURLY) assert.ok(c.powershell.includes(q + q), 'U+' + q.charCodeAt(0).toString(16) + ' is doubled');
  const quoted = c.powershell.slice(c.powershell.indexOf("= '") + 3, c.powershell.indexOf("'; try"));
  assert.equal(quoted.replace(/(['\u2018-\u201B])\1/g, ''), dir.replace(/['\u2018-\u201B]/g, ''), 'every quote mark in the folder is doubled, nothing else changed');
  assert.equal(c.cmd, null, 'cmd.exe expands % even inside quotes: no cmd line is offered');
  assert.equal(c.posix, "CLAUDE_CONFIG_DIR='" + dir.replace(/'/g, "'\\''") + "' claude", 'curly quotes are plain characters for sh');
  process.env[ENV] = path.join(tempDir, 'Jan\u2019s map', 'profiles');
  const plainCmd = loginCommands('werk').cmd;
  assert.equal(plainCmd, 'set "CLAUDE_CONFIG_DIR=' + path.join(path.resolve(process.env[ENV]), 'werk') + '" && claude', 'a curly apostrophe is safe inside cmd quotes');
});

test('the PowerShell command keeps a path with %, curly quotes and a would-be command intact (nothing runs from the path)', { skip: process.platform !== 'win32' }, () => {
  process.env[ENV] = path.join(tempDir, 'a\u2019; Write-Output INJECTED; \u2018b 100% \u201A\u201B', 'profiles');
  const dir = path.join(path.resolve(process.env[ENV]), 'werk');
  const cmd = loginCommands('werk').powershell.replace('{ claude }', PS_SHOW);
  const r = runPs(cmd + PS_AFTER);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['in=' + b64(dir), 'after='], 'the exact folder reaches the variable and nothing from the path is run');
});

test('the PowerShell command removes the variable even when the program stops with an error (try/finally)', { skip: process.platform !== 'win32' }, () => {
  const cmd = loginCommands('werk').powershell.replace('{ claude }', "{ throw 'stopped' }");
  const r = runPs('try { ' + cmd + ' } catch { Write-Output caught }' + PS_AFTER);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['caught', 'after=']);
});

test('Windows: the containment check ignores letter case (a folder WERK on disk is the profile werk)', { skip: process.platform !== 'win32' }, () => {
  fs.mkdirSync(path.join(root, 'WERK'), { recursive: true });
  const r = profileDir('werk', { mustExist: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ensureProfileDir('werk').ok, true);
});

test('the POSIX command really passes the folder', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(path.resolve(root), 'werk');
  const cmd = loginCommands('werk').posix.replace(/ claude$/, ' printenv CLAUDE_CONFIG_DIR');
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), dir);
});

test('slugFromLabel: lower case, accents dropped, separators collapsed, reserved names avoided', () => {
  assert.equal(slugFromLabel('Werk'), 'werk');
  assert.equal(slugFromLabel('  Privé Account 2 '), 'prive-account-2');
  assert.equal(slugFromLabel('A--B__C'), 'a-b-c');
  assert.equal(slugFromLabel('Main'), 'main-account');
  assert.equal(slugFromLabel('CON'), 'con-account');
  assert.equal(slugFromLabel('COM0'), 'com0-account');
  assert.equal(slugFromLabel('lpt0'), 'lpt0-account');
  assert.equal(slugFromLabel('***'), 'account');
  assert.equal(slugFromLabel('x'.repeat(80)).length, 32);
  assert.equal(profileSlugOk(slugFromLabel('-'.repeat(5) + 'y'.repeat(40))), true);
  for (const bad of ['', '   ', null, 5]) assert.equal(slugFromLabel(bad), null, String(bad));
});

test('displayPath shortens the home folder to ~', () => {
  assert.equal(displayPath(path.join(os.homedir(), '.forge-router', 'profiles')), path.join('~', '.forge-router', 'profiles'));
  const outside = path.resolve(tempDir);
  assert.equal(displayPath(outside), outside.startsWith(os.homedir()) ? path.join('~', path.relative(os.homedir(), outside)) : outside);
});
