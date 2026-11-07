#!/usr/bin/env node
'use strict';
/**
 * forge-session-end.cjs — `SessionEnd` hook, registered async (modernization plan item 1.6).
 *
 * WHAT: when a Claude session ends it runs `forge-memory-consolidate.cjs --json` in DRY-RUN mode (that tool writes
 * nothing without `--apply`; this hook NEVER passes `--apply`, and a test holds that) and appends one line to
 * `.claude/forge-runs/_hooks/session-end.jsonl`:
 *   { ts, event:'SessionEnd', session, reason?, consolidation_due, due_files[], lessons_stale, consolidate, ms }
 * `consolidation_due` is true when the dry run planned at least one rotation/distillation (history, ledger,
 * decisions over 50 KB, or a Boss MEMORY.md over its limit). Applying it stays a deliberate step:
 * `node .claude/forge-bin/forge-memory-consolidate.cjs --apply`.
 *
 * `consolidate` is one of: 'ok' · 'absent' (the tool is not installed here) · 'timeout' · 'failed' · 'bad-output'.
 * `due_files` are the project-relative names the dry run reported (scrubbed like every other string by
 * forge-toolhook.cjs's serialize() gate via forge-subagent-stop.cjs::appendHookLine).
 *
 * LIVE-SESSION CONTRACT: never throws, never blocks, always exit 0, NEVER writes stdout. The child process gets a
 * hard CHILD_TIMEOUT_MS; the whole hook has its own FAILSAFE_MS, both under the 5 s settings timeout. Honours the
 * forge-sync maintenance lock and env FORGE_SESSION_END_HOOK=off.
 *
 * Payload fields read: session_id, reason (both optional). The root is CLAUDE_PROJECT_DIR (or the process cwd),
 * never the payload's own `cwd`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const toolhook = require('./forge-toolhook.cjs');
const sub = require('./forge-subagent-stop.cjs');

const FAILSAFE_MS = 4500;
const CHILD_TIMEOUT_MS = 3500;
const HEAD_BYTES = 65536;
const REASON_RE = /^[a-z][a-z_-]{0,31}$/;
const CONSOLIDATE = 'forge-memory-consolidate.cjs';

/** consolidateArgs(root) — the exact argv handed to the consolidation tool. Never contains --apply. */
function consolidateArgs(root) { return [path.join(__dirname, CONSOLIDATE), '--json', '--root', root]; }

/** dryRunConsolidate(root, opts) -> { consolidate, due, due_files, lessons_stale }. Never throws. */
function dryRunConsolidate(root, opts) {
  opts = opts || {};
  const out = { consolidate: 'failed', due: false, due_files: [], lessons_stale: false };
  try {
    const script = path.join(__dirname, CONSOLIDATE);
    if (!fs.existsSync(script)) return Object.assign(out, { consolidate: 'absent' });
    const args = consolidateArgs(root);
    if (args.includes('--apply')) return out; // belt and braces: this hook never applies
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: Number.isFinite(opts.childTimeoutMs) ? opts.childTimeoutMs : CHILD_TIMEOUT_MS,
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error && /ETIMEDOUT/.test(String(r.error.code || r.error.message))) return Object.assign(out, { consolidate: 'timeout' });
    if (r.signal) return Object.assign(out, { consolidate: 'timeout' });
    if (r.status !== 0) return out;
    let res;
    try { res = JSON.parse(r.stdout); } catch { return Object.assign(out, { consolidate: 'bad-output' }); }
    if (!res || res.mode !== 'dry-run' || !Array.isArray(res.plans)) return Object.assign(out, { consolidate: 'bad-output' });
    const files = res.plans.map((p) => (p && typeof p.file === 'string' ? p.file.slice(0, 120) : null)).filter(Boolean).slice(0, 20);
    return { consolidate: 'ok', due: res.plans.length > 0, due_files: files, lessons_stale: !!(res.lessons && res.lessons.changed) };
  } catch { return out; }
}

/** run(raw, opts) -> {ok, wrote, path, reason, record?}. NEVER throws. */
function run(raw, opts) {
  opts = opts || {};
  const t0 = Date.now();
  try {
    if (sub.offBy('FORGE_SESSION_END_HOOK', opts.env)) return { ok: true, wrote: false, skipped: true, reason: 'FORGE_SESSION_END_HOOK=off', path: null };
    let payload = null;
    try { payload = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {}; // a session still ended
    const root = toolhook.resolveProjectRoot(opts);
    // WP 2.1: a project with .claude/ (as before) or one that uses the .forge/ state root (an older toolhook: .claude/ only)
    const forgeProject = typeof toolhook.isForgeProject === 'function' ? toolhook.isForgeProject(root) : fs.existsSync(path.join(root, '.claude'));
    if (!forgeProject) return { ok: true, wrote: false, reason: 'no-forge-project', path: null };
    if (toolhook.syncMaintenance(root)) return { ok: true, wrote: false, skipped: true, reason: 'maintenance mode', path: null };
    const c = dryRunConsolidate(root, opts);
    const record = {
      ts: opts.now || new Date().toISOString(),
      event: 'SessionEnd',
      session: toolhook.sessionBucket(payload.session_id),
      consolidation_due: c.due,
      due_files: c.due_files,
      lessons_stale: c.lessons_stale,
      consolidate: c.consolidate,
      ms: Date.now() - t0,
    };
    if (typeof payload.reason === 'string' && REASON_RE.test(payload.reason)) record.reason = payload.reason;
    const r = sub.appendHookLine(root, 'session-end.jsonl', record, opts);
    return Object.assign(r, { record: toolhook.scrubRecord(record) });
  } catch (e) {
    return { ok: false, wrote: false, reason: 'error: ' + ((e && e.code) || 'unknown'), path: null };
  }
}

module.exports = { run, dryRunConsolidate, consolidateArgs, FAILSAFE_MS, CHILD_TIMEOUT_MS };

if (require.main === module) {
  let finished = false;
  const finish = () => { if (finished) return; finished = true; process.exit(0); };
  const failsafe = setTimeout(finish, FAILSAFE_MS);
  if (failsafe.unref) failsafe.unref();
  const chunks = [];
  let stored = 0;
  try {
    process.stdin.on('data', (c) => { if (stored < HEAD_BYTES) { chunks.push(c); stored += c.length; } });
    process.stdin.on('error', finish);
    process.stdin.on('end', () => {
      try { run(Buffer.concat(chunks).subarray(0, HEAD_BYTES).toString('utf8')); } catch { /* never fail the turn */ }
      clearTimeout(failsafe);
      finish();
    });
    process.stdin.resume();
  } catch { finish(); }
}
