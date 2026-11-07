#!/usr/bin/env node
'use strict';
// forge-ramguard.cjs — machine-load probe for the Forge lane scheduler (WP-RAMGUARD).
//
// OWNER RULE: new lanes may start only while RAM use is below 95%.
// The Lead's Monitor calls `check` every 60 s and stops starting NEW lanes on STOP-NEW-LANES or DISK-LOW.
// Running lanes are never killed by this tool; it only reports.
//
// Usage:
//   node forge-ramguard.cjs check [--stop-at 95] [--warn-at 88] [--disk-min-gb 14] [--json]
// Output (one line):  RAM <used%> · free-disk <GB> · <state>
// States and exit codes (disk wins over RAM):
//   ok             exit 0   RAM below warn-at, disk fine
//   WARN           exit 0   RAM at/above warn-at but below stop-at
//   STOP-NEW-LANES exit 3   RAM at/above stop-at
//   DISK-LOW       exit 4   free disk on the project drive below disk-min-gb
// Free disk is read for the drive of process.cwd(): `fsutil volume diskfree` on Windows (needs admin on
// some machines), then fs.statfsSync, then `df -k` elsewhere. When every probe fails, disk_free_gb is
// null, the disk does not affect the state, and the note `disk: 'unknown'` is reported.
// Zero dependencies.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULTS = Object.freeze({ stopAt: 95, warnAt: 88, diskMinGb: 14 });
const EXIT = Object.freeze({ ok: 0, WARN: 0, 'STOP-NEW-LANES': 3, 'DISK-LOW': 4 });
const GB = 1024 ** 3;
const PROBE_TIMEOUT_MS = 5000;

function round1(n) { return Math.round(n * 10) / 10; }

// Pure: classify a reading against thresholds. Disk wins over RAM. Unknown disk never blocks.
function classify(reading, thresholds) {
  const th = { ...DEFAULTS, ...(thresholds || {}) };
  const ram = Number(reading && reading.ramUsedPct);
  const disk = reading ? reading.diskFreeGb : null;
  if (typeof disk === 'number' && Number.isFinite(disk) && disk < th.diskMinGb) return 'DISK-LOW';
  if (Number.isFinite(ram) && ram >= th.stopAt) return 'STOP-NEW-LANES';
  if (Number.isFinite(ram) && ram >= th.warnAt) return 'WARN';
  return 'ok';
}

function exitCodeFor(state) {
  return Object.prototype.hasOwnProperty.call(EXIT, state) ? EXIT[state] : 1;
}

// Linux os.freemem() reports MemFree (excludes reclaimable cache); prefer MemAvailable when present.
function linuxAvailableBytes() {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch (_e) {
    return null; // not Linux or /proc unreadable: caller falls back to os.freemem()
  }
}

function readRam() {
  const total = os.totalmem();
  let free = os.freemem();
  if (process.platform === 'linux') {
    const avail = linuxAvailableBytes();
    if (avail !== null) free = avail;
  }
  const usedPct = total > 0 ? ((total - free) / total) * 100 : 0;
  return { ramUsedPct: round1(Math.min(100, Math.max(0, usedPct))), ramFreeGb: round1(free / GB), ramTotalGb: round1(total / GB) };
}

// Parse `fsutil volume diskfree` output: the first line holding "free bytes" (avail to caller).
function parseFsutil(text) {
  const line = String(text).split(/\r?\n/).find((l) => /free bytes/i.test(l));
  if (!line) return null;
  const m = /:\s*([\d.,\s]+)/.exec(line);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

// Parse `df -k <dir>` output: the "Available" column of the last data line, in KiB.
function parseDf(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  const kb = Number(cols[3]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

function readDiskFreeBytes(dir) {
  const attempts = [];
  if (process.platform === 'win32') {
    attempts.push(['fsutil', () => parseFsutil(run('fsutil', ['volume', 'diskfree', path.parse(path.resolve(dir)).root.replace(/\\$/, '')]))]);
  }
  if (typeof fs.statfsSync === 'function') {
    attempts.push(['statfs', () => { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); }]);
  }
  if (process.platform !== 'win32') attempts.push(['df', () => parseDf(run('df', ['-k', dir]))]);
  const errors = [];
  for (const [source, probe] of attempts) {
    try {
      const bytes = probe();
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) return { bytes, source, errors };
      errors.push(source + ': unparsable output');
    } catch (e) {
      errors.push(source + ': ' + String((e && e.message) || e).split(/\r?\n/)[0]);
    }
  }
  return { bytes: null, source: null, errors };
}

function measure(thresholds, dir) {
  const th = { ...DEFAULTS, ...(thresholds || {}) };
  const ram = readRam();
  const disk = readDiskFreeBytes(dir || process.cwd());
  const diskFreeGb = disk.bytes === null ? null : round1(disk.bytes / GB);
  const state = classify({ ramUsedPct: ram.ramUsedPct, diskFreeGb }, th);
  const out = {
    ram_used_pct: ram.ramUsedPct,
    ram_free_gb: ram.ramFreeGb,
    ram_total_gb: ram.ramTotalGb,
    disk_free_gb: diskFreeGb,
    state,
    thresholds: { stop_at: th.stopAt, warn_at: th.warnAt, disk_min_gb: th.diskMinGb },
  };
  if (diskFreeGb === null) { out.disk = 'unknown'; out.disk_errors = disk.errors; } else out.disk_source = disk.source;
  return out;
}

function formatLine(r) {
  const disk = r.disk_free_gb === null ? 'unknown' : r.disk_free_gb + ' GB';
  return 'RAM ' + r.ram_used_pct + '% · free-disk ' + disk + ' · ' + r.state;
}

const FLAGS = { '--stop-at': 'stopAt', '--warn-at': 'warnAt', '--disk-min-gb': 'diskMinGb' };

// Validates CLI input at the boundary; throws a plain message on bad input.
function parseArgs(argv) {
  const opts = { cmd: argv[0], json: false, thresholds: { ...DEFAULTS } };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (!FLAGS[a]) throw new Error('unknown argument: ' + a);
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v < 0) throw new Error(a + ' needs a non-negative number');
    if (a !== '--disk-min-gb' && v > 100) throw new Error(a + ' must be a percentage (0-100)');
    opts.thresholds[FLAGS[a]] = v;
  }
  if (opts.thresholds.warnAt > opts.thresholds.stopAt) throw new Error('--warn-at must not exceed --stop-at');
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write('forge-ramguard: ' + e.message + '\n');
    return 2;
  }
  if (opts.cmd !== 'check') {
    process.stderr.write('usage: node forge-ramguard.cjs check [--stop-at 95] [--warn-at 88] [--disk-min-gb 14] [--json]\n');
    return 2;
  }
  const r = measure(opts.thresholds);
  process.stdout.write((opts.json ? JSON.stringify(r) : formatLine(r)) + '\n');
  return exitCodeFor(r.state);
}

module.exports = { classify, exitCodeFor, parseFsutil, parseDf, parseArgs, measure, formatLine, DEFAULTS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
