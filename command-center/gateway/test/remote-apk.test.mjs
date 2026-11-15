// Where the phone app (.apk) is on this PC, for the dashboard's Telefoon section (RB2-F2). The admin
// status route reports it as an absolute path; a missing build or a missing mobile folder (the packaged
// desktop app) is reported honestly. Contract: command-center/docs/REMOTE-BRIDGE-CONTRACT.md section 3.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apkInfo, APK_SEGMENTS } from '../src/remote/apk.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-apk-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));

test('apk: a built app reports its absolute path, exists and its size in bytes', () => {
  const mobile = path.join(tmp, 'built', 'mobile');
  const file = path.join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(1234));
  const info = apkInfo(mobile);
  assert.deepEqual(info, { path: file, exists: true, size_bytes: 1234 });
  assert.ok(path.isAbsolute(info.path));
});

test('apk: the mobile folder without a build reports the expected absolute path, not built', () => {
  const mobile = path.join(tmp, 'unbuilt', 'mobile');
  fs.mkdirSync(mobile, { recursive: true });
  assert.deepEqual(apkInfo(mobile), { path: path.join(mobile, ...APK_SEGMENTS), exists: false, size_bytes: null });
});

test('apk: no mobile folder (the packaged desktop app) reports no path at all', () => {
  assert.deepEqual(apkInfo(path.join(tmp, 'nowhere', 'mobile')), { path: null, exists: false, size_bytes: null });
});

test('apk: a folder where the apk file should be is not an app', () => {
  const mobile = path.join(tmp, 'dir-instead', 'mobile');
  fs.mkdirSync(path.join(mobile, ...APK_SEGMENTS), { recursive: true });
  assert.deepEqual(apkInfo(mobile), { path: path.join(mobile, ...APK_SEGMENTS), exists: false, size_bytes: null });
});

test('apk: a relative mobile folder is refused (the field is always absolute or null)', () => {
  assert.deepEqual(apkInfo('mobile'), { path: null, exists: false, size_bytes: null });
});
