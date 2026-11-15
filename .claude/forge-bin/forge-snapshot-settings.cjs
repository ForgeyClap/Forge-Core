#!/usr/bin/env node
'use strict';
/**
 * forge-snapshot-settings.cjs — safe, idempotent `.claude/settings.json` MERGE helper for wiring the
 * PreCompact (matchers manual+auto) + SessionStart(matcher:compact) snapshot hooks, without ever clobbering
 * pre-existing hooks/keys. Used ONCE by hand against THIS project's `.claude/settings.json` (absent ->
 * created minimal) and against the GLOBAL `~/.claude/settings.json` (existing, with a real PreToolUse/
 * PostToolUse/UserPromptSubmit/SessionStart/SessionEnd/Stop/PreCompact/SubagentStart/SubagentStop/
 * Notification config already live) — see HOOKS_OPT_IN.md for the wiring record.
 *
 * SAFETY MODEL (this is the load-bearing property forge-snapshot-settings.test.cjs proves):
 *   - `mergeSnapshotHooks(existing, opts)` is a PURE function: deep-clones `existing`, never mutates it,
 *     and only ever APPENDS new entries into `hooks.PreCompact[]` / `hooks.SessionStart[]` arrays — every
 *     other top-level key, every other hook event array, and every existing entry WITHIN PreCompact/
 *     SessionStart is preserved byte-for-byte (same key order via JSON.parse(JSON.stringify(...)) deep
 *     clone, not a hand-rolled partial copy that could drop a field).
 *   - IDEMPOTENT: re-running against an already-merged object adds nothing new (checked by exact
 *     matcher+command match), so applying this twice (e.g. a re-run after an interrupted first attempt)
 *     never duplicates hook entries.
 *   - The CLI's `apply` command REFUSES to write if the existing file is present but not valid JSON
 *     (fail closed — never overwrites something it can't parse) and can `--backup` the original first.
 *
 * MODEL:
 *   mergeSnapshotHooks(existing, {markerCommand, reinjectCommand, timeoutSec}) -> merged settings object.
 *   hasExactHook(list, matcher, command) -> boolean.
 *
 * CLI:
 *   node forge-snapshot-settings.cjs apply --target <path> --marker-command "<cmd>" --reinject-command "<cmd>"
 *     [--timeout-sec <n>] [--backup] [--json]   (a hook `timeout` is in SECONDS, 1-60; default 15)
 * Exit codes: 0 = written (or already up to date). 2 = usage error / existing file present but not valid JSON.
 */
const fs = require('fs');
const path = require('path');

// FB-MEMORY-F6: a Claude Code hook `timeout` is in SECONDS (HOOKS_OPT_IN.md); 5000 meant 83 minutes, not 5 s.
const DEFAULT_TIMEOUT_SEC = 15;
const MAX_TIMEOUT_SEC = 60;

function hasExactHook(list, matcher, command) {
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if ((entry.matcher || null) !== (matcher || null)) return false;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.some((h) => h && h.command === command);
  });
}
function buildEntry(matcher, command, timeoutSec) {
  return { matcher, hooks: [{ type: 'command', command, timeout: timeoutSec }] };
}

/** mergeSnapshotHooks(existing, opts) -> merged settings object. See file header SAFETY MODEL. Never
 *  mutates `existing`. `existing` may be null/undefined (treated as `{}` — the "file absent" case). */
function mergeSnapshotHooks(existing, opts) {
  opts = opts || {};
  if (!opts.markerCommand) throw new Error('forge-snapshot-settings: markerCommand is required');
  if (!opts.reinjectCommand) throw new Error('forge-snapshot-settings: reinjectCommand is required');
  const timeoutSec = opts.timeoutSec == null ? DEFAULT_TIMEOUT_SEC : opts.timeoutSec;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) throw new Error('forge-snapshot-settings: timeoutSec must be a whole number of seconds from 1 to ' + MAX_TIMEOUT_SEC + ' (got ' + timeoutSec + ')');

  const out = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? JSON.parse(JSON.stringify(existing))
    : {};
  out.hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? out.hooks : {};

  const added = [];

  out.hooks.PreCompact = Array.isArray(out.hooks.PreCompact) ? out.hooks.PreCompact.slice() : [];
  for (const matcher of ['manual', 'auto']) {
    if (!hasExactHook(out.hooks.PreCompact, matcher, opts.markerCommand)) {
      out.hooks.PreCompact.push(buildEntry(matcher, opts.markerCommand, timeoutSec));
      added.push('PreCompact[' + matcher + ']');
    }
  }

  out.hooks.SessionStart = Array.isArray(out.hooks.SessionStart) ? out.hooks.SessionStart.slice() : [];
  if (!hasExactHook(out.hooks.SessionStart, 'compact', opts.reinjectCommand)) {
    out.hooks.SessionStart.push(buildEntry('compact', opts.reinjectCommand, timeoutSec));
    added.push('SessionStart[compact]');
  }

  return { settings: out, added };
}

module.exports = { mergeSnapshotHooks, hasExactHook, DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { target: null, markerCommand: null, reinjectCommand: null, timeoutSec: null, backup: false, json: false, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--target') opts.target = rest[++i];
    else if (a === '--marker-command') opts.markerCommand = rest[++i];
    else if (a === '--reinject-command') opts.reinjectCommand = rest[++i];
    else if (a === '--timeout-sec') opts.timeoutSec = Number(rest[++i]);
    else if (a === '--backup') opts.backup = true;
    else if (a === '--json') opts.json = true;
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return { cmd, opts };
}
function printUsage() {
  console.error('Usage: node forge-snapshot-settings.cjs apply --target <path> --marker-command "<cmd>" --reinject-command "<cmd>" [--timeout-sec <1-60>] [--backup] [--json]');
}
if (require.main === module) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!opts.usageError && opts.timeoutSec != null && !(Number.isInteger(opts.timeoutSec) && opts.timeoutSec >= 1 && opts.timeoutSec <= MAX_TIMEOUT_SEC)) opts.usageError = '--timeout-sec must be a whole number from 1 to ' + MAX_TIMEOUT_SEC + ' (a hook timeout is in seconds)';
  if (cmd !== 'apply' || opts.usageError || !opts.target || !opts.markerCommand || !opts.reinjectCommand) {
    if (opts.usageError) console.error('forge-snapshot-settings: ' + opts.usageError);
    printUsage();
    process.exitCode = 2;
  } else {
    let existing = null;
    let raw = null;
    try { raw = fs.readFileSync(opts.target, 'utf8'); } catch { raw = null; }
    if (raw != null) {
      try { existing = JSON.parse(raw); }
      catch (e) {
        console.error('forge-snapshot-settings: ' + opts.target + ' exists but is not valid JSON — refusing to overwrite (' + e.message + ')');
        process.exitCode = 2;
        return;
      }
    }
    if (raw != null && opts.backup) {
      const backupPath = opts.target + '.bak-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(backupPath, raw, 'utf8');
      console.error('forge-snapshot-settings: backed up existing file to ' + backupPath);
    }
    const { settings, added } = mergeSnapshotHooks(existing, { markerCommand: opts.markerCommand, reinjectCommand: opts.reinjectCommand, timeoutSec: opts.timeoutSec });
    fs.mkdirSync(path.dirname(opts.target), { recursive: true });
    fs.writeFileSync(opts.target, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    const result = { target: opts.target, added, wasPresent: raw != null };
    if (opts.json) console.log(JSON.stringify(result));
    else console.log('forge-snapshot-settings: wrote ' + opts.target + ' (added: ' + (added.length ? added.join(', ') : 'nothing — already wired') + ')');
    process.exitCode = 0;
  }
}
