#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-device-env.test.cjs — tests for the read-only Android device probe and the mobile evidence split
// (R8B-F5). Background: in category round 8b the android Lead built an APK, never ran it on the emulator
// this machine has, and wrote "no device available"; the mobile evidence rule accepted the APK alone.
// Every probe test runs the real CLI against a fake SDK tree, a fake home and a fake Program Files folder in
// os.tmpdir() (env overrides). The fake emulator/adb/java files are not programs, so every field that executes one
// must fail soft. Nothing in this repo is written; the temp tree is removed at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const evidence = require('./forge-evidence.cjs');
const verify = require('./forge-verify.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const TOOL = path.join(__dirname, 'forge-device-env.cjs');
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-device-env-'));
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body == null ? 'not a program' : body); };
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

// Fake tree: an SDK at the default %LOCALAPPDATA%/Android/Sdk spot, one AVD, one JDK under Program Files.
const LA = path.join(TMP, 'localappdata');
const SDK = path.join(LA, 'Android', 'Sdk');
const HOME = path.join(TMP, 'home');
const PF = path.join(TMP, 'programfiles');
const BIN = path.join(TMP, 'emptybin');
write(path.join(SDK, 'emulator', 'emulator' + EXE));
write(path.join(SDK, 'platform-tools', 'adb' + EXE));
mkdir(path.join(SDK, 'build-tools', '35.0.0'));
mkdir(path.join(SDK, 'platforms', 'android-35'));
write(path.join(SDK, 'system-images', 'android-35', 'google_apis', 'x86_64', 'system.img'), 'img');
write(path.join(HOME, '.android', 'avd', 'pulsar_test.ini'), 'avd.ini.encoding=UTF-8\n');
mkdir(path.join(HOME, '.android', 'avd', 'pulsar_test.avd'));
write(path.join(PF, 'Eclipse Adoptium', 'jdk-17.0.21.9-hotspot', 'bin', 'java' + EXE));
mkdir(BIN);
const EMPTY = path.join(TMP, 'empty');
mkdir(EMPTY);

/** envWith(over) -> a child env: the real env minus every key named in `over` (case-insensitive, Windows has
 *  "Path" not "PATH"), plus the non-null values of `over`. A null value removes the variable. */
function envWith(over) {
  const names = Object.keys(over).map((k) => k.toLowerCase());
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!names.includes(k.toLowerCase())) env[k] = v;
  for (const [k, v] of Object.entries(over)) if (v != null) env[k] = v;
  return env;
}
const BASE = {
  ANDROID_HOME: null, ANDROID_SDK_ROOT: null, ANDROID_AVD_HOME: null, ANDROID_USER_HOME: null, ANDROID_EMULATOR_HOME: null,
  JAVA_HOME: null, LOCALAPPDATA: LA, USERPROFILE: HOME, HOME, PATH: BIN,
  ProgramFiles: PF, ProgramW6432: PF, 'ProgramFiles(x86)': PF,
};
function probe(over, args) {
  const r = spawnSync(process.execPath, [TOOL].concat(args || ['--json']), { env: envWith({ ...BASE, ...over }), encoding: 'utf8', cwd: TMP, timeout: 90000 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* left null: the assertions say so */ }
  return { r, j };
}
const listTree = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p) + (e.isFile() ? ':' + fs.statSync(p).size : '')); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
};

console.log('forge-device-env tests (read-only Android device probe + mobile device-run evidence)');

console.log('\n1) the probe on a fake SDK tree');
const treeBefore = listTree(TMP);
const found = probe({});
t('exit 0 and valid JSON', () => {
  assert.strictEqual(found.r.status, 0, 'exit ' + found.r.status + ' stderr: ' + found.r.stderr);
  assert.ok(found.j, 'stdout is not JSON: ' + found.r.stdout.slice(0, 300));
});
t('the default %LOCALAPPDATA%/Android/Sdk is found when ANDROID_HOME and ANDROID_SDK_ROOT are unset', () => {
  assert.strictEqual(found.j.sdk, true);
  assert.strictEqual(path.resolve(found.j.paths.sdk), path.resolve(SDK));
  assert.match(found.j.sdk_source, /LOCALAPPDATA/);
});
t('emulator true, adb true, avds [pulsar_test], build-tools, platforms and system images listed', () => {
  assert.strictEqual(found.j.emulator, true);
  assert.strictEqual(found.j.adb, true);
  assert.deepStrictEqual(found.j.avds, ['pulsar_test']);
  assert.deepStrictEqual(found.j.build_tools, ['35.0.0']);
  assert.deepStrictEqual(found.j.platforms, ['android-35']);
  assert.deepStrictEqual(found.j.system_images, ['android-35/google_apis/x86_64']);
});
t('the fake adb and emulator cannot run: devices and accel fail soft (empty / null, with a reason), no crash', () => {
  assert.deepStrictEqual(found.j.devices, []);
  assert.strictEqual(found.j.devices_checked, false);
  assert.ok(typeof found.j.devices_error === 'string' && found.j.devices_error.length > 0, 'no reason given for the failed adb call');
  assert.strictEqual(found.j.accel_ok, null);
});
t('verdict emulator-ready with a boot command for the first AVD, an install command and an exec-out screenshot', () => {
  assert.strictEqual(found.j.verdict, 'emulator-ready');
  const c = found.j.commands;
  assert.ok(c && typeof c.boot === 'string', 'no boot command');
  assert.ok(c.boot.includes('-avd pulsar_test'), c.boot);
  assert.ok(c.boot.includes(path.join(SDK, 'emulator', 'emulator' + EXE).replace(/\\/g, '/')), 'boot command does not name the probed emulator: ' + c.boot);
  assert.match(c.install, / install -r /);
  assert.match(c.screenshot, /^mkdir -p \S+\/<run_id>\/artifacts && .* exec-out screencap -p > \S+\/<run_id>\/artifacts\/device-screenshot-1\.png$/);
  assert.strictEqual(found.j.waiver, null, 'a bootable emulator must not offer the no-device waiver');
});
t('a JDK under Program Files is found when JAVA_HOME is unset and java is not on PATH (the round-8b machine)', () => {
  assert.strictEqual(found.j.java_home, null);
  assert.strictEqual(found.j.java, true);
  assert.ok(found.j.paths.java.includes('Eclipse Adoptium'), found.j.paths.java);
  assert.strictEqual(found.j.java_version, null, 'the fake java cannot run, so no version may be invented');
});
t('ANDROID_HOME wins over the default location', () => {
  const alt = path.join(TMP, 'alt-sdk');
  write(path.join(alt, 'emulator', 'emulator' + EXE));
  try {
    const r = probe({ ANDROID_HOME: alt });
    assert.ok(r.j, 'stdout is not JSON');
    assert.strictEqual(path.resolve(r.j.paths.sdk), path.resolve(alt));
    assert.strictEqual(r.j.sdk_source, 'ANDROID_HOME');
  } finally { fs.rmSync(alt, { recursive: true, force: true }); }
});
t('versions sort as numbers: build-tools 9.0.0 before 35.0.0, and the package-name command uses the newest aapt2', () => {
  const alt = path.join(TMP, 'ver-sdk');
  write(path.join(alt, 'emulator', 'emulator' + EXE));
  write(path.join(alt, 'build-tools', '9.0.0', 'aapt2' + EXE));
  write(path.join(alt, 'build-tools', '35.0.0', 'aapt2' + EXE));
  try {
    const r = probe({ ANDROID_HOME: alt });
    assert.deepStrictEqual(r.j.build_tools, ['9.0.0', '35.0.0']);
    assert.ok(r.j.commands.package_name.includes('build-tools/35.0.0/aapt2'), r.j.commands.package_name);
  } finally { fs.rmSync(alt, { recursive: true, force: true }); }
});
t('the probe is read-only: the fake tree is byte-for-byte the same afterwards', () => {
  assert.deepStrictEqual(listTree(TMP), treeBefore);
});

console.log('\n2) the probe with no SDK, no AVD, no JDK');
const none = probe({ ANDROID_HOME: path.join(TMP, 'does-not-exist'), LOCALAPPDATA: EMPTY, USERPROFILE: EMPTY, HOME: EMPTY, ProgramFiles: EMPTY, ProgramW6432: EMPTY, 'ProgramFiles(x86)': EMPTY });
t('exit 0 and every field false or empty', () => {
  assert.strictEqual(none.r.status, 0, 'exit ' + none.r.status + ' stderr: ' + none.r.stderr);
  assert.ok(none.j, 'stdout is not JSON');
  for (const k of ['sdk', 'emulator', 'adb', 'java']) assert.strictEqual(none.j[k], false, k + ' should be false');
  for (const k of ['avds', 'devices', 'build_tools', 'platforms', 'system_images']) assert.deepStrictEqual(none.j[k], [], k + ' should be empty');
});
t('verdict no-emulator-no-device, no commands, and the waiver names device-env-no-device.json in the run artifacts', () => {
  assert.strictEqual(none.j.verdict, 'no-emulator-no-device');
  assert.strictEqual(none.j.commands, null);
  assert.ok(none.j.waiver && /artifacts\/device-env-no-device\.json$/.test(none.j.waiver.artifact), JSON.stringify(none.j.waiver));
  assert.match(none.j.waiver.save, /^mkdir -p \S+\/artifacts && node .* --json > \S+\/artifacts\/device-env-no-device\.json$/);
});
t('the waiver log step is a log-event decision_logged call with an agent and the artifact (log-event refuses one without an agent)', () => {
  assert.match(none.j.waiver.log, /log-event\.cjs <run_id> decision_logged '/);
  const payload = JSON.parse(none.j.waiver.log.slice(none.j.waiver.log.indexOf("'") + 1, -1));
  assert.strictEqual(payload.agent, 'orchestrator');
  assert.strictEqual(payload.artifact, 'artifacts/device-env-no-device.json');
  assert.match(payload.reason, /no-emulator-no-device/);
});
t('an emulator binary without any AVD is not bootable: no-emulator-no-device, with a note that a system image can become an AVD', () => {
  const r = probe({ USERPROFILE: EMPTY, HOME: EMPTY });
  assert.strictEqual(r.j.emulator, true);
  assert.deepStrictEqual(r.j.avds, []);
  assert.strictEqual(r.j.verdict, 'no-emulator-no-device');
  assert.ok(r.j.notes.some((n) => /system image is installed but there is no AVD/.test(n)), JSON.stringify(r.j.notes));
});
t('a set ANDROID_HOME that points nowhere is named in the notes (not silently skipped)', () => {
  assert.ok(none.j.notes.some((n) => /ANDROID_HOME/.test(n) && /does not exist|missing/.test(n)), JSON.stringify(none.j.notes));
});

console.log('\n3) CLI surface');
t('plain output: plain English, says nothing was started, and that a built APK is not a played APK', () => {
  const r = probe({}, []);
  assert.strictEqual(r.r.status, 0, r.r.stderr);
  assert.match(r.r.stdout, /nothing was started/i);
  assert.match(r.r.stdout, /built APK is not a played APK/);
  assert.match(r.r.stdout, /-avd pulsar_test/);
});
t('an unknown flag prints usage and exits 2', () => {
  const r = probe({}, ['--bogus']);
  assert.strictEqual(r.r.status, 2);
  assert.match(r.r.stderr, /Usage: node .*forge-device-env\.cjs/);
});

console.log('\n4) required-evidence.json, mobile domain: a built APK is not a played APK');
const runDir = path.join(TMP, 'run');
write(path.join(runDir, 'artifacts', 'app-debug.apk'), 'PK fake apk bytes');
write(path.join(runDir, 'artifacts', 'device-screenshot-1.png'), Buffer.alloc(4096, 7));
write(path.join(runDir, 'artifacts', 'device-env-no-device.json'), '{"verdict":"no-emulator-no-device"}');
const mobileIds = evidence.loadConfig().domains.mobile.evidence.map((i) => i.id);
t('the mobile domain has build-evidence and device-run-evidence, and the old combined id is gone', () => {
  assert.ok(mobileIds.includes('build-evidence'), mobileIds.join(','));
  assert.ok(mobileIds.includes('device-run-evidence'), mobileIds.join(','));
  assert.ok(!mobileIds.includes('device-or-build-evidence'), 'device-or-build-evidence still present');
});
t('a run whose only artifact is app-debug.apk meets build-evidence but misses device-run-evidence', () => {
  const r = evidence.check({ domain: 'mobile', artifacts: ['app-debug.apk'], events: [] });
  assert.ok(r.satisfied.includes('build-evidence'), JSON.stringify(r));
  assert.ok(r.missing.includes('device-run-evidence'), JSON.stringify(r));
});
t('adding device-screenshot-1.png satisfies device-run-evidence', () => {
  const r = evidence.check({ domain: 'mobile', artifacts: ['app-debug.apk', 'device-screenshot-1.png'], events: [] });
  assert.ok(r.satisfied.includes('device-run-evidence'), JSON.stringify(r));
  assert.ok(r.satisfied.includes('build-evidence'), JSON.stringify(r));
});
t('the same split holds with a real run folder (artifacts checked on disk)', () => {
  const apkOnly = evidence.check({ domain: 'mobile', artifacts: ['artifacts/app-debug.apk'], events: [] }, { runDir });
  assert.strictEqual(apkOnly.artifacts_verified, true);
  assert.ok(apkOnly.missing.includes('device-run-evidence'));
  const both = evidence.check({ domain: 'mobile', artifacts: ['artifacts/app-debug.apk', 'artifacts/device-screenshot-1.png'], events: [] }, { runDir });
  assert.ok(both.satisfied.includes('device-run-evidence') && both.satisfied.includes('build-evidence'), JSON.stringify(both));
});
t('a named device screenshot that does not exist in the run folder does not count', () => {
  const r = evidence.check({ domain: 'mobile', artifacts: ['artifacts/app-debug.apk', 'artifacts/device-screenshot-9.png'], events: [] }, { runDir });
  assert.ok(r.missing.includes('device-run-evidence'), JSON.stringify(r));
});
t('a browser screenshot event alone is not a device run (the loophole the old rule had)', () => {
  const r = evidence.check({ domain: 'mobile', artifacts: ['app-debug.apk', 'screenshots/web-preview.png'], events: ['browser_screenshot_captured'] });
  assert.ok(r.missing.includes('device-run-evidence'), JSON.stringify(r));
});
t('a logged device screenshot event (screenshot_path) satisfies it through forge-verify.evidenceCheck', () => {
  const events = [
    { event_type: 'file_changed', agent: 'Build Boss', path: 'artifacts/app-debug.apk' },
    { event_type: 'browser_screenshot_captured', agent: 'Test Boss', screenshot_path: 'artifacts/device-screenshot-1.png' },
  ];
  const r = verify.evidenceCheck(events, 'mobile', { runDir });
  assert.ok(r && r.satisfied.includes('device-run-evidence') && r.satisfied.includes('build-evidence'), JSON.stringify(r));
});
t('the saved no-device probe result, referenced by a decision_logged event, is the waiver route', () => {
  const events = [
    { event_type: 'file_changed', agent: 'Build Boss', path: 'artifacts/app-debug.apk' },
    { event_type: 'decision_logged', agent: 'Lead', artifact: 'artifacts/device-env-no-device.json', reason: 'forge-device-env verdict no-emulator-no-device: no emulator, no device' },
  ];
  const r = verify.evidenceCheck(events, 'mobile', { runDir });
  assert.ok(r && r.satisfied.includes('device-run-evidence'), JSON.stringify(r));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
