#!/usr/bin/env node
'use strict';
/**
 * forge-device-env.cjs — read-only Android device probe (R8B-F5).
 * Why: in category round 8b the android Lead built an APK, never ran it on the emulator this machine has, and wrote
 * "no device available" (its Bash/Glob probes of the SDK folder were sandbox-blocked). This tool answers "can the APK
 * run here, and how?" with node fs/child_process only, no shell globbing: JDK, Android SDK, build-tools, platforms,
 * emulator, system images, AVDs, `adb devices` and `emulator -accel-check`, then the exact commands to boot the first
 * AVD, install an APK, launch it and take a screenshot (adb exec-out screencap -p).
 * Every field fails soft: a program that cannot run leaves its field empty or null, with the reason next to it.
 * It never starts an emulator and never writes a file. `adb devices` starts the adb server when it is not running
 * yet; that is adb's own behaviour (`adb kill-server` stops it).
 * Lookup order. SDK: ANDROID_HOME, ANDROID_SDK_ROOT, %LOCALAPPDATA%/Android/Sdk. AVDs: ANDROID_AVD_HOME,
 * ANDROID_USER_HOME/avd, ANDROID_EMULATOR_HOME/avd, %USERPROFILE%/.android/avd (the emulator's own order).
 * Java: JAVA_HOME/bin, then PATH, then JDK folders under Program Files (on the round-8b machine JAVA_HOME was unset
 * and the JDK sat under Program Files/Eclipse Adoptium).
 * Verdict: device-attached | emulator-ready (emulator binary and at least one AVD) | no-emulator-no-device. Only the
 * last one offers the waiver: the --json result saved as <run>/artifacts/device-env-no-device.json, which the mobile
 * device-run-evidence item in config/orchestration/required-evidence.json accepts.
 * CLI: node forge-device-env.cjs [--json]   exit 0 = probe done, whatever it found · 2 = bad usage. Zero dependencies.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const fp = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
const EXE = process.platform === 'win32' ? '.exe' : '';
const EXEC_TIMEOUT_MS = 8000;
const JDK_VENDOR_DIRS = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft'];
const WAIVER_FILE = 'device-env-no-device.json';
const SCREENSHOT_FILE = 'device-screenshot-1.png';

const byVersion = (a, b) => a.localeCompare(b, 'en', { numeric: true }); // 9.0.0 before 35.0.0, jdk-8 before jdk-17
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const subdirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(byVersion); } catch { return []; } };
const slash = (p) => String(p).replace(/\\/g, '/');
const quote = (p) => '"' + slash(p) + '"';
const lines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function projectRoot() {
  if (!fp) return path.resolve(__dirname, '..', '..'); // forge-paths fallback
  try { return fp.scriptRoot(__dirname); } catch { return null; }
}

/** runsRel(root) -> the active runs folder relative to the project root ('.claude/forge-runs' or '.forge/runs'). */
function runsRel(root) {
  try {
    if (fp && root) {
      const rel = path.relative(root, fp.stateDir(root, 'runs'));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return slash(rel);
    }
  } catch { /* an unjudgeable layout prints the legacy folder below */ }
  return '.claude/forge-runs';
}

/** run(file, args) -> {ok, status, out} | {ok:false, error}: an absolute program path, no shell, a short timeout. */
function run(file, args) {
  try {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? 'timed out after ' + EXEC_TIMEOUT_MS / 1000 + ' s' : 'could not run ' + path.basename(file) + ' (' + (r.error.code || r.error.message) + ')' };
    return { ok: r.status === 0, status: r.status, out: (String(r.stdout || '') + '\n' + String(r.stderr || '')).trim() };
  } catch (e) { return { ok: false, error: 'could not run ' + path.basename(file) + ' (' + e.message + ')' }; }
}

function findJava(env, notes) {
  const bin = 'java' + EXE;
  if (env.JAVA_HOME) {
    const p = path.join(env.JAVA_HOME, 'bin', bin);
    if (isFile(p)) return { path: p, source: 'JAVA_HOME' };
    notes.push('JAVA_HOME is set to ' + slash(env.JAVA_HOME) + ' but bin/' + bin + ' does not exist there');
  }
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin);
    if (isFile(p)) return { path: p, source: 'PATH' };
  }
  for (const pf of [...new Set([env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean))]) {
    for (const vendor of JDK_VENDOR_DIRS) {
      for (const jdk of subdirs(path.join(pf, vendor)).reverse()) {
        const p = path.join(pf, vendor, jdk, 'bin', bin);
        if (isFile(p)) return { path: p, source: 'under ' + slash(path.join(pf, vendor)) + ', JAVA_HOME not set' };
      }
    }
    const jbr = path.join(pf, 'Android', 'Android Studio', 'jbr', 'bin', bin);
    if (isFile(jbr)) return { path: jbr, source: 'Android Studio jbr, JAVA_HOME not set' };
  }
  return null;
}

function findSdk(env, notes) {
  const tries = [['ANDROID_HOME', env.ANDROID_HOME], ['ANDROID_SDK_ROOT', env.ANDROID_SDK_ROOT],
    ['default %LOCALAPPDATA%/Android/Sdk', env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk')]];
  for (const [source, dir] of tries) {
    if (!dir) continue;
    if (isDir(dir)) return { path: dir, source };
    if (source.startsWith('ANDROID_')) notes.push(source + ' is set to ' + slash(dir) + ' but that folder does not exist');
  }
  return null;
}

function avdHome(env) {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return path.join(env.ANDROID_USER_HOME, 'avd');
  if (env.ANDROID_EMULATOR_HOME) return path.join(env.ANDROID_EMULATOR_HOME, 'avd');
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.android', 'avd');
}

function listAvds(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.ini$/i.test(f) && isFile(path.join(dir, f))).map((f) => f.slice(0, -4)).sort(); } catch { return []; }
}

/** systemImages(sdk) -> ['android-35/google_apis/x86_64', ...] (system-images/<api>/<tag>/<abi>). */
function systemImages(sdk) {
  const base = path.join(sdk, 'system-images');
  const out = [];
  for (const api of subdirs(base)) for (const tag of subdirs(path.join(base, api))) for (const abi of subdirs(path.join(base, api, tag))) out.push(api + '/' + tag + '/' + abi);
  return out;
}

/** adbDevices(adb) -> {checked, devices:[{serial, state}], error?}. `adb devices` prints "List of devices attached"
 *  and then "<serial>\t<state>" lines; "* daemon ..." lines appear when it starts the adb server. */
function adbDevices(adb) {
  if (!adb) return { checked: false, devices: [], error: 'no adb in the SDK platform-tools folder' };
  const r = run(adb, ['devices']);
  if (!r.ok) return { checked: false, devices: [], error: r.error || 'adb devices exited ' + r.status + ': ' + (lines(r.out)[0] || 'no output') };
  const devices = lines(r.out).map((l) => l.split(/\s+/)).filter((p) => p.length >= 2 && p[0] !== 'List' && !p[0].startsWith('*'))
    .map(([serial, state]) => ({ serial, state }));
  return { checked: true, devices };
}

/** accelCheck(emulator) -> {ok:true|false|null, text, error?}. ok null = the check could not run at all. */
function accelCheck(emulator) {
  if (!emulator) return { ok: null, text: null, error: 'no emulator binary' };
  const r = run(emulator, ['-accel-check']);
  if (r.error) return { ok: null, text: null, error: r.error };
  const text = lines(r.out).filter((l) => !/^accel:?$/i.test(l) && !/^\d+$/.test(l)).join(' ') || null;
  return { ok: r.ok, text };
}

function probe(env, root) {
  const notes = [];
  const java = findJava(env, notes);
  const javaRun = java ? run(java.path, ['-version']) : null;
  const sdk = findSdk(env, notes);
  const sdkPath = sdk ? sdk.path : null;
  const emulator = sdkPath && isFile(path.join(sdkPath, 'emulator', 'emulator' + EXE)) ? path.join(sdkPath, 'emulator', 'emulator' + EXE) : null;
  const adb = sdkPath && isFile(path.join(sdkPath, 'platform-tools', 'adb' + EXE)) ? path.join(sdkPath, 'platform-tools', 'adb' + EXE) : null;
  const buildTools = sdkPath ? subdirs(path.join(sdkPath, 'build-tools')) : [];
  const images = sdkPath ? systemImages(sdkPath) : [];
  const avdDir = avdHome(env);
  const avds = listAvds(avdDir);
  const dev = adbDevices(adb);
  const accel = accelCheck(emulator);
  const ready = dev.devices.filter((d) => d.state === 'device');
  if (dev.devices.some((d) => d.state === 'unauthorized')) notes.push('a device is attached but unauthorized: accept the USB debugging prompt on the phone');
  if (emulator && !avds.length && images.length) notes.push('a system image is installed but there is no AVD: create one with the avdmanager in ' + slash(path.join(sdkPath, 'cmdline-tools')));
  if (accel.ok === false) notes.push('the emulator reports no usable CPU acceleration: it may not boot, or boot very slowly');

  const verdict = ready.length ? 'device-attached' : (emulator && avds.length ? 'emulator-ready' : 'no-emulator-no-device');
  const artifactsDir = runsRel(root) + '/<run_id>/artifacts';
  const target = ready.length ? ' -s ' + ready[0].serial : '';
  const adbCmd = (adb ? quote(adb) : 'adb') + target;
  const aapt2 = buildTools.length && sdkPath ? path.join(sdkPath, 'build-tools', buildTools[buildTools.length - 1], 'aapt2' + EXE) : null;
  const rel = (p) => (root ? slash(path.relative(root, p)) : slash(p));
  const tool = rel(__filename);
  const logEventPath = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
  const logEvent = isFile(logEventPath) ? rel(logEventPath) : null;
  const commands = verdict === 'no-emulator-no-device' ? null : {
    shell: 'The commands are for Git Bash (the Bash tool). In PowerShell 5.1 put & before a quoted path, and take the screenshot from Git Bash or cmd: a PowerShell > rewrites binary output and breaks the PNG.',
    boot: verdict === 'emulator-ready' ? quote(emulator) + ' -avd ' + avds[0] + ' -no-snapshot-save -no-boot-anim' : null,
    wait_for_boot: adbCmd + ' wait-for-device shell getprop sys.boot_completed',
    install: adbCmd + ' install -r <path/to/app.apk>',
    package_name: aapt2 && isFile(aapt2) ? quote(aapt2) + ' dump badging <path/to/app.apk>' : null,
    launch: adbCmd + ' shell monkey -p <package> -c android.intent.category.LAUNCHER 1',
    screenshot: 'mkdir -p ' + artifactsDir + ' && ' + adbCmd + ' exec-out screencap -p > ' + artifactsDir + '/' + SCREENSHOT_FILE,
  };
  const waiverArtifact = artifactsDir + '/' + WAIVER_FILE;
  const waiver = verdict !== 'no-emulator-no-device' ? null : {
    artifact: waiverArtifact,
    save: 'mkdir -p ' + artifactsDir + ' && node ' + tool + ' --json > ' + waiverArtifact,
    log: (logEvent ? 'node ' + logEvent + ' <run_id> decision_logged ' : 'log decision_logged ')
      + "'" + JSON.stringify({ agent: 'orchestrator', decision: 'waive the device run', artifact: 'artifacts/' + WAIVER_FILE,
        reason: 'forge-device-env verdict no-emulator-no-device: no bootable emulator and no attached device' }) + "'",
  };

  return {
    schema: 1, tool: 'forge-device-env', probed_at: new Date().toISOString(),
    java_home: env.JAVA_HOME || null, java: !!java, java_source: java ? java.source : null,
    java_version: javaRun && javaRun.ok ? lines(javaRun.out)[0] || null : null,
    ...(javaRun && !javaRun.ok ? { java_error: javaRun.error || 'java -version exited ' + javaRun.status } : {}),
    sdk: !!sdk, sdk_source: sdk ? sdk.source : null,
    build_tools: buildTools, platforms: sdkPath ? subdirs(path.join(sdkPath, 'platforms')) : [],
    emulator: !!emulator, adb: !!adb, system_images: images, avds,
    devices: dev.devices, devices_checked: dev.checked, ...(dev.error ? { devices_error: dev.error } : {}),
    accel_ok: accel.ok, accel: accel.text, ...(accel.error ? { accel_error: accel.error } : {}),
    verdict, commands, waiver, notes,
    paths: { java: java ? slash(java.path) : null, sdk: sdkPath ? slash(sdkPath) : null, emulator: emulator ? slash(emulator) : null, adb: adb ? slash(adb) : null, avd_home: slash(avdDir) },
  };
}

function render(r) {
  const out = [];
  const row = (k, v) => out.push('  ' + k.padEnd(13) + v);
  out.push('Android device check (read-only: nothing was started, no file was written)');
  row('Java', r.java ? r.paths.java + ' · ' + r.java_source + ' · ' + (r.java_version || 'version unknown: ' + (r.java_error || 'not run')) : 'not found (JAVA_HOME not set, no java on PATH or under Program Files)');
  row('Android SDK', r.sdk ? r.paths.sdk + ' · ' + r.sdk_source : 'not found (ANDROID_HOME, ANDROID_SDK_ROOT, %LOCALAPPDATA%/Android/Sdk)');
  row('build-tools', r.build_tools.join(', ') || 'none');
  row('platforms', r.platforms.join(', ') || 'none');
  row('emulator', r.emulator ? 'yes · accelerator: ' + (r.accel || r.accel_error || 'unknown') : 'no');
  row('images', r.system_images.join(', ') || 'none');
  row('AVDs', (r.avds.join(', ') || 'none') + ' (' + r.paths.avd_home + ')');
  row('devices', r.devices_checked ? (r.devices.map((d) => d.serial + ' ' + d.state).join(', ') || 'none attached') : 'not checked: ' + r.devices_error);
  if (r.commands) {
    out.push('Verdict: ' + r.verdict + '. Run the APK and take a screenshot' + (r.commands.boot ? ' (any AVD above works; the first is used)' : '') + '.');
    out.push('  ' + r.commands.shell);
    const steps = [
      ['boot in the background (stops when you close its window or run adb emu kill)', r.commands.boot],
      ['wait until this prints 1', r.commands.wait_for_boot],
      ['install', r.commands.install],
      ['package name for launch', r.commands.package_name],
      ['launch', r.commands.launch],
      ['screenshot', r.commands.screenshot],
    ].filter(([, c]) => c);
    steps.forEach(([label, cmd], i) => { out.push('  ' + (i + 1) + ' ' + label); out.push('    ' + cmd); });
    out.push('A built APK is not a played APK: the mobile device-run-evidence item wants that screenshot in the run.');
  } else {
    out.push('Verdict: no-emulator-no-device. No bootable emulator (an emulator binary plus an AVD) and no attached device.');
    out.push('  Waiver: save this result in the run, then log a decision that points at it:');
    out.push('    ' + r.waiver.save);
    out.push('    ' + r.waiver.log);
    out.push('A built APK is not a played APK: say "not run on a device" in the report.');
  }
  for (const n of r.notes) out.push('Note: ' + n);
  return out.join('\n');
}

module.exports = { probe, render };

if (require.main === module) {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => a !== '--json');
  if (bad.length) {
    console.error('Usage: node ' + slash(path.relative(process.cwd(), __filename)) + ' [--json]\n  unknown argument: ' + bad.join(' '));
    process.exitCode = 2;
  } else {
    const r = probe(process.env, projectRoot());
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  }
}
