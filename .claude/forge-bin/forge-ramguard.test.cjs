#!/usr/bin/env node
'use strict';
// forge-ramguard.test.cjs — tests the lane-scheduler load probe (WP-RAMGUARD).
// Fake readings go through the pure classify(); one test runs the real `check --json` CLI.
// Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classify, exitCodeFor, parseFsutil, parseDf, parseArgs, formatLine } = require('./forge-ramguard.cjs');

const TOOL = path.join(__dirname, 'forge-ramguard.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ramguard-'));
const TH = { stopAt: 95, warnAt: 88, diskMinGb: 14 };

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge ramguard tests');

t('low RAM and enough disk is ok, exit 0', () => {
  const s = classify({ ramUsedPct: 40, diskFreeGb: 200 }, TH);
  assert.strictEqual(s, 'ok'); assert.strictEqual(exitCodeFor(s), 0);
});
t('RAM at warn-at is WARN, exit 0', () => {
  const s = classify({ ramUsedPct: 88, diskFreeGb: 200 }, TH);
  assert.strictEqual(s, 'WARN'); assert.strictEqual(exitCodeFor(s), 0);
});
t('RAM just below 95 is still WARN (owner rule: lanes start while RAM < 95%)', () => {
  assert.strictEqual(classify({ ramUsedPct: 94.9, diskFreeGb: 200 }, TH), 'WARN');
});
t('RAM at stop-at is STOP-NEW-LANES, exit 3', () => {
  const s = classify({ ramUsedPct: 95, diskFreeGb: 200 }, TH);
  assert.strictEqual(s, 'STOP-NEW-LANES'); assert.strictEqual(exitCodeFor(s), 3);
});
t('low disk is DISK-LOW, exit 4', () => {
  const s = classify({ ramUsedPct: 40, diskFreeGb: 13.9 }, TH);
  assert.strictEqual(s, 'DISK-LOW'); assert.strictEqual(exitCodeFor(s), 4);
});
t('disk wins over RAM when both are bad', () => {
  assert.strictEqual(classify({ ramUsedPct: 99, diskFreeGb: 2 }, TH), 'DISK-LOW');
});
t('unknown disk (null) never blocks; RAM still decides', () => {
  assert.strictEqual(classify({ ramUsedPct: 40, diskFreeGb: null }, TH), 'ok');
  assert.strictEqual(classify({ ramUsedPct: 97, diskFreeGb: null }, TH), 'STOP-NEW-LANES');
});
t('custom thresholds are honoured', () => {
  assert.strictEqual(classify({ ramUsedPct: 80, diskFreeGb: 50 }, { stopAt: 80, warnAt: 70, diskMinGb: 10 }), 'STOP-NEW-LANES');
  assert.strictEqual(classify({ ramUsedPct: 10, diskFreeGb: 50 }, { diskMinGb: 60 }), 'DISK-LOW');
});
t('parseFsutil reads the free-bytes line with thousands separators', () => {
  const out = 'Total free bytes                :  203,669,250,048 (189.7 GB)\nTotal bytes                     : 999,999,999,999 (931 GB)\n';
  assert.strictEqual(parseFsutil(out), 203669250048);
  assert.strictEqual(parseFsutil('nothing useful'), null);
});
t('parseDf reads the Available column in KiB', () => {
  const out = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100000 40000 60000 40% /\n';
  assert.strictEqual(parseDf(out), 60000 * 1024);
});
t('parseArgs rejects bad input and warn-at above stop-at', () => {
  assert.throws(() => parseArgs(['check', '--stop-at', 'abc']));
  assert.throws(() => parseArgs(['check', '--warn-at', '96', '--stop-at', '95']));
  assert.throws(() => parseArgs(['check', '--bogus']));
  assert.strictEqual(parseArgs(['check', '--stop-at', '90', '--warn-at', '80']).thresholds.stopAt, 90);
});
t('formatLine prints RAM, free disk and state on one line', () => {
  assert.strictEqual(formatLine({ ram_used_pct: 51.2, disk_free_gb: 120.5, state: 'ok' }), 'RAM 51.2% · free-disk 120.5 GB · ok');
  assert.strictEqual(formatLine({ ram_used_pct: 51.2, disk_free_gb: null, state: 'ok' }), 'RAM 51.2% · free-disk unknown · ok');
});

t('real `check --json` returns the documented shape and a consistent exit code', () => {
  const r = spawnSync(process.execPath, [TOOL, 'check', '--json'], { cwd: TMP, encoding: 'utf8', timeout: 30000 });
  const j = JSON.parse(r.stdout);
  for (const k of ['ram_used_pct', 'ram_free_gb', 'ram_total_gb', 'disk_free_gb', 'state', 'thresholds']) assert.ok(k in j, 'missing ' + k);
  assert.ok(typeof j.ram_used_pct === 'number' && j.ram_used_pct >= 0 && j.ram_used_pct <= 100, 'ram_used_pct out of range: ' + j.ram_used_pct);
  assert.ok(j.ram_total_gb > 0);
  assert.ok(j.disk_free_gb === null ? j.disk === 'unknown' : typeof j.disk_free_gb === 'number');
  assert.ok(['ok', 'WARN', 'STOP-NEW-LANES', 'DISK-LOW'].includes(j.state));
  assert.deepStrictEqual(j.thresholds, { stop_at: 95, warn_at: 88, disk_min_gb: 14 });
  assert.strictEqual(r.status, exitCodeFor(j.state));
});
t('real `check` with a bad flag exits 2', () => {
  const r = spawnSync(process.execPath, [TOOL, 'check', '--stop-at', 'x'], { cwd: TMP, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 2);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
