// Tests for the project-folder guard (WP B3b): which folders the project picker refuses, with a
// Dutch reason per case and the "Documenten\Forge Projecten\<naam>" suggestion. Windows rules are
// tested with an injected home folder and environment, so they run the same on every machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAllowedProjectFolder, forgeProjectsRoot, FOLDER_GUARD_REASONS_NL, FORGE_PROJECTS_FOLDER_NAME,
} from '../src/snapshots/folder-guard.mjs';

const WIN = {
  platform: 'win32',
  homeDir: 'C:\\Users\\Test',
  env: {
    SystemDrive: 'C:',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
    APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    OneDrive: 'C:\\Users\\Test\\OneDrive',
  },
};
const winCheck = (p, extra = {}) => isAllowedProjectFolder(p, { ...WIN, ...extra });

const refused = [
  ['C:\\', 'DRIVE_ROOT'],
  ['D:\\', 'DRIVE_ROOT'],
  ['d:/', 'DRIVE_ROOT'],
  ['C:\\Users\\Test', 'HOME'],
  ['c:\\users\\test\\', 'HOME'],
  ['C:\\Users', 'USERS_ROOT'],
  ['C:\\Users\\Test\\Desktop', 'DESKTOP'],
  ['C:\\Users\\Test\\Documents', 'DOCUMENTS_ROOT'],
  ['c:\\USERS\\test\\documents\\', 'DOCUMENTS_ROOT'],
  ['C:\\Users\\Test\\OneDrive\\Documenten', 'DOCUMENTS_ROOT'],
  ['C:\\Users\\Test\\OneDrive\\Bureaublad', 'DESKTOP'],
  ['C:\\Users\\Test\\Downloads', 'DOWNLOADS_ROOT'],
  ['C:\\Program Files', 'PROGRAM_FILES'],
  ['C:\\Program Files\\Foo\\bar', 'PROGRAM_FILES'],
  ['C:\\Program Files (x86)\\Steam', 'PROGRAM_FILES'],
  ['C:\\Windows', 'WINDOWS'],
  ['C:\\Windows\\System32', 'WINDOWS'],
  ['C:\\ProgramData\\Vendor', 'PROGRAM_DATA'],
  ['C:\\Users\\Test\\AppData', 'APPDATA'],
  ['C:\\Users\\Test\\AppData\\Local\\Temp\\proj', 'APPDATA'],
  ['C:\\Users\\Test\\Documents\\..\\AppData\\Roaming\\x', 'APPDATA'],
  ['\\\\server\\share\\project', 'NETWORK_PATH'],
  ['//server/share', 'NETWORK_PATH'],
  ['', 'INVALID'],
  ['   ', 'INVALID'],
  ['projects\\mine', 'INVALID'],
  ['C:relative', 'INVALID'],
  ['\\rooted-without-drive', 'INVALID'],
  ['C:\\ok\u0007bell', 'INVALID'],
];

for (const [input, code] of refused) {
  test(`refuses ${JSON.stringify(input)} as ${code}`, () => {
    const result = winCheck(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.reason, FOLDER_GUARD_REASONS_NL[code]);
    assert.equal(result.suggestion, 'Maak liever een nieuwe projectmap aan in Documenten\\Forge Projecten\\<naam>.');
    assert.equal(result.suggestedParent, 'C:\\Users\\Test\\Documents\\Forge Projecten');
  });
}

test('non-string input is refused, never thrown on', () => {
  for (const value of [undefined, null, 42, {}, ['C:\\x']]) {
    assert.equal(winCheck(value).code, 'INVALID');
  }
});

test('ordinary project folders are allowed, including folders inside Documents and Desktop', () => {
  for (const ok of [
    'C:\\Users\\Test\\Documents\\Forge Projecten\\demo',
    'C:\\Users\\Test\\Documents\\mijn-site',
    'C:\\Users\\Test\\Desktop\\project',
    'C:\\Users\\Test\\code\\app',
    'D:\\Projects\\app',
  ]) {
    const result = winCheck(ok);
    assert.deepEqual(result, { ok: true, path: ok }, ok);
  }
});

test('every reason is distinct Dutch text', () => {
  const reasons = Object.values(FOLDER_GUARD_REASONS_NL);
  assert.equal(new Set(reasons).size, reasons.length);
  for (const reason of reasons) assert.match(reason, /^(Dit|Deze) /);
});

test('known folders from the desktop app (e.g. Electron app.getPath) are honoured', () => {
  const extra = { knownFolders: { documents: 'E:\\Docs', desktop: ['F:\\Bureau'] } };
  assert.equal(winCheck('E:\\Docs', extra).code, 'DOCUMENTS_ROOT');
  assert.equal(winCheck('F:\\Bureau', extra).code, 'DESKTOP');
  assert.equal(winCheck('E:\\Docs', extra).suggestedParent, 'E:\\Docs\\Forge Projecten');
  assert.equal(forgeProjectsRoot({ ...WIN, ...extra }), 'E:\\Docs\\Forge Projecten');
  assert.equal(forgeProjectsRoot(WIN), `C:\\Users\\Test\\Documents\\${FORGE_PROJECTS_FOLDER_NAME}`);
});

test('POSIX: root, home, the folder holding home, system folders and app data are refused', () => {
  const opts = { platform: 'linux', homeDir: '/home/test', env: {} };
  const cases = [
    ['/', 'DRIVE_ROOT'],
    ['/home/test', 'HOME'],
    ['/home', 'USERS_ROOT'],
    ['/usr/local/src', 'SYSTEM'],
    ['/etc', 'SYSTEM'],
    ['/home/test/.config/app', 'APPDATA'],
    ['/home/test/Documents', 'DOCUMENTS_ROOT'],
    ['/home/test/Desktop', 'DESKTOP'],
    ['/home/test/Downloads', 'DOWNLOADS_ROOT'],
    ['relative/dir', 'INVALID'],
  ];
  for (const [input, code] of cases) assert.equal(isAllowedProjectFolder(input, opts).code, code, input);
  assert.deepEqual(isAllowedProjectFolder('/home/test/code/app', opts), { ok: true, path: '/home/test/code/app' });
  assert.equal(isAllowedProjectFolder('/home', opts).suggestion, 'Maak liever een nieuwe projectmap aan in Documenten/Forge Projecten/<naam>.');
});

const linkTemp = [];
after(() => {
  for (const dir of linkTemp) fs.rmSync(dir, { recursive: true, force: true });
});

test('a link that points into a protected folder is refused by where it really points', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-guard-'));
  linkTemp.push(base);
  const fakeWindows = path.join(base, 'FakeWindows');
  fs.mkdirSync(fakeWindows);
  const link = path.join(base, 'looks-harmless');
  try {
    fs.symlinkSync(fakeWindows, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot create a folder link here: ${err.code}`);
    return;
  }
  try {
    const opts = process.platform === 'win32'
      ? { platform: 'win32', homeDir: 'C:\\Users\\Nobody', env: { SystemRoot: fakeWindows } }
      : { platform: process.platform, homeDir: '/nonexistent-home', env: {} };
    if (process.platform === 'win32') {
      assert.equal(isAllowedProjectFolder(fakeWindows, opts).code, 'WINDOWS', 'the target itself');
      assert.equal(isAllowedProjectFolder(link, opts).code, 'WINDOWS', 'the link to it');
    } else {
      assert.equal(isAllowedProjectFolder(link, { ...opts, knownFolders: { documents: fs.realpathSync(fakeWindows) } }).code, 'DOCUMENTS_ROOT');
    }
  } finally {
    fs.unlinkSync(link); // removes the link only, never its target
  }
});
