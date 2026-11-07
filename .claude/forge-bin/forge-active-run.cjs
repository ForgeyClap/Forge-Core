#!/usr/bin/env node
'use strict';
/**
 * forge-active-run.cjs — the run pointer the harness hooks read (WP A2).
 *
 * WHY: a hook payload (SubagentStart, SubagentStop, PreToolUse/PostToolUse on the Agent tool) carries a session id but
 * no Forge run id, and a hook must stay cheap, so it cannot pick "the" run itself (the run picker in forge-toolhook.cjs
 * is documented as expensive and fragile). Instead the LEAD, which knows the run, writes ONE small pointer file right
 * after it logs run_started, and every harness hook reads only that file:
 *
 *   node .claude/forge-bin/forge-active-run.cjs set <run_id> [--session <session_id>]   (right after run_started)
 *   node .claude/forge-bin/forge-active-run.cjs clear [--session <session_id>] [--run <run_id>]   (after finalize)
 *   node .claude/forge-bin/forge-active-run.cjs show [--session <session_id>] [--json]
 *
 * FILES (in <runs>/_hooks/, the folder the hooks already write to; no run.json/events.jsonl there, so run pickers skip it):
 *   active-run.<session>.json — written when the Lead passes --session (or env CLAUDE_SESSION_ID is set): the pointer
 *                               for that one session, so two sessions in one project never stamp each other's run.
 *   active-run.json           — the fallback, always written by `set`. It records the session that set it (or null);
 *                               a hook from ANOTHER known session ignores it.
 * Content: { schema, run, session, set_at } — no prompts, no paths, no secrets (the session is the same
 * forge-toolhook sessionBucket() the hook logs already use: a secret-shaped id becomes 'unknown-session').
 *
 * `clear` never deletes: it overwrites the pointer with { run: null, cleared_at, previous_run }, so a cleared session
 * file also stops the fallback from applying to that session. A pointer older than FORGE_ACTIVE_RUN_MAX_AGE_H hours
 * (default 24, 1..168) is stale and ignored, so a forgotten `clear` cannot stamp a later run.
 *
 * readActiveRun() never throws and does at most two small file reads: it is safe inside a live hook.
 */
const fs = require('fs');
const path = require('path');

let toolhook = null;
try { toolhook = require('./forge-toolhook.cjs'); } catch { toolhook = null; }

const SCHEMA = 'forge-active-run/1';
const HOOKS_DIRNAME = '_hooks';
const FALLBACK_FILE = 'active-run.json';
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_MAX_AGE_H = 24;
const MAX_POINTER_BYTES = 4096;
/** The session id shape Claude Code passes to hooks (a UUID). Anything else cannot be compared with a hook's session. */
const CLAUDE_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function validRunId(v) { return typeof v === 'string' && RUN_ID_RE.test(v); }
function bucketOf(sessionId) {
  if (!toolhook || typeof toolhook.sessionBucket !== 'function') return 'unknown-session';
  try { return toolhook.sessionBucket(sessionId); } catch { return 'unknown-session'; }
}
function runsDirOf(root) {
  if (toolhook && typeof toolhook.runsDir === 'function') { try { return toolhook.runsDir(root); } catch { /* legacy below */ } }
  return path.join(root, '.claude', 'forge-runs');
}
function hooksDir(root) { return path.join(runsDirOf(root), HOOKS_DIRNAME); }

/** pointerFiles(root, sessionId) -> {dir, bucket, session: file|null, fallback: file}. */
function pointerFiles(root, sessionId) {
  const dir = hooksDir(root);
  const bucket = bucketOf(sessionId);
  return { dir, bucket, session: bucket !== 'unknown-session' ? path.join(dir, 'active-run.' + bucket + '.json') : null, fallback: path.join(dir, FALLBACK_FILE) };
}

/** maxAgeMs(env) -> the staleness limit in ms (FORGE_ACTIVE_RUN_MAX_AGE_H, 1..168 hours; default 24). */
function maxAgeMs(env) {
  const raw = (env || process.env).FORGE_ACTIVE_RUN_MAX_AGE_H;
  const n = Number(raw);
  const h = raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 1 && n <= 168 ? n : DEFAULT_MAX_AGE_H;
  return h * 3600 * 1000;
}

/** readPointer(file) -> {present, ok, data, error}. Never throws. */
function readPointer(file) {
  if (!file) return { present: false, ok: false, data: null, error: null };
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { present: true, ok: false, data: null, error: 'not a file' };
    if (st.size > MAX_POINTER_BYTES) return { present: true, ok: false, data: null, error: 'too large' };
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) { return { present: !(e && e.code === 'ENOENT'), ok: false, data: null, error: e && e.code === 'ENOENT' ? null : ((e && e.code) || 'unreadable') }; }
  let data;
  try { data = JSON.parse(raw.replace(/^﻿/, '')); } catch { return { present: true, ok: false, data: null, error: 'not valid JSON' }; }
  if (!isObj(data) || data.schema !== SCHEMA) return { present: true, ok: false, data: null, error: 'not a forge-active-run pointer' };
  return { present: true, ok: true, data, error: null };
}

/** judge(pointer, bucket, now, limitMs, source) -> {run, source, reason, set_at} for one readable pointer. */
function judge(p, bucket, now, limitMs, source) {
  const d = p.data;
  if (d.run === null) return { run: null, source, reason: 'cleared', set_at: null };
  if (!validRunId(d.run)) return { run: null, source, reason: 'invalid run id in pointer', set_at: null };
  const setMs = Date.parse(d.set_at);
  if (!Number.isFinite(setMs)) return { run: null, source, reason: 'pointer has no valid set_at', set_at: null };
  if (now - setMs > limitMs) return { run: null, source, reason: 'stale (set ' + d.set_at + ')', set_at: d.set_at };
  // ids of two different schemes cannot be compared. A pointer set with "session-<ms>" (from
  // CLAUDE_SESSION_ID) can never equal the Claude Code UUID a hook receives, and reading it as "another session" hid the
  // run from every hook. Only ids of the same shape (both UUIDs, or both not) bind the fallback to one session.
  const sameScheme = typeof d.session === 'string' && CLAUDE_SESSION_RE.test(d.session) === CLAUDE_SESSION_RE.test(String(bucket));
  if (source === 'pointer-fallback' && typeof d.session === 'string' && d.session !== 'unknown-session' && bucket !== 'unknown-session' && sameScheme && d.session !== bucket) {
    return { run: null, source, reason: 'the fallback pointer belongs to another session', set_at: d.set_at };
  }
  return { run: d.run, source, reason: null, set_at: d.set_at };
}

/** readActiveRun(root, sessionId, opts) -> {run, source, reason, set_at}. run is a valid run id or null. NEVER throws.
 *  Order: the session's own pointer (a cleared one wins and stops the fallback), then the fallback pointer. */
function readActiveRun(root, sessionId, opts) {
  opts = opts || {};
  try {
    if (!root) return { run: null, source: null, reason: 'no project root', set_at: null };
    const f = pointerFiles(root, sessionId);
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const limit = maxAgeMs(opts.env);
    const own = readPointer(f.session);
    if (own.ok) {
      const j = judge(own, f.bucket, now, limit, 'pointer-session');
      if (j.run || j.reason === 'cleared') return j;
    }
    const fb = readPointer(f.fallback);
    if (fb.ok) return judge(fb, f.bucket, now, limit, 'pointer-fallback');
    return { run: null, source: null, reason: fb.present ? 'fallback pointer unreadable (' + fb.error + ')' : 'no active-run pointer', set_at: null };
  } catch (e) {
    return { run: null, source: null, reason: 'error: ' + ((e && e.code) || 'unknown'), set_at: null };
  }
}

/** writeAtomic(file, obj) — tmp file + rename, so a hook never reads a half-written pointer. */
function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** runFolderExists(root, runId) -> boolean: the run folder in the active runs folder or the legacy one. */
function runFolderExists(root, runId) {
  const dirs = [path.join(runsDirOf(root), runId), path.join(root, '.claude', 'forge-runs', runId)];
  return dirs.some((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/** setActiveRun(root, runId, opts) -> {ok, run, session, written:[files], reason}. opts.session, opts.allowMissing, opts.now. */
function setActiveRun(root, runId, opts) {
  opts = opts || {};
  if (!validRunId(runId)) return { ok: false, run: null, session: null, written: [], reason: 'invalid run id (allowed: A-Z a-z 0-9 _ -, starting with a letter or digit)' };
  if (!opts.allowMissing && !runFolderExists(root, runId)) return { ok: false, run: runId, session: null, written: [], reason: 'no run folder for "' + runId + '" — log run_started first (or pass --allow-missing)' };
  const f = pointerFiles(root, opts.session);
  const session = f.bucket !== 'unknown-session' ? f.bucket : null;
  const body = { schema: SCHEMA, run: runId, session, set_at: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString() };
  const written = [];
  try {
    if (f.session) { writeAtomic(f.session, body); written.push(f.session); }
    writeAtomic(f.fallback, body); written.push(f.fallback);
  } catch (e) {
    return { ok: false, run: runId, session, written, reason: 'could not write the pointer: ' + ((e && e.code) || (e && e.message) || 'unknown') };
  }
  return { ok: true, run: runId, session, written, reason: session ? null : 'no session id given: only the fallback pointer was written (every session in this project will read it)' };
}

/** clearActiveRun(root, opts) -> {ok, cleared:[files], kept:[{file, reason}]}. Overwrites, never deletes. opts.session,
 *  opts.run (only clear a pointer that names this run). The fallback is cleared only when it belongs to this session or
 *  to no session. */
function clearActiveRun(root, opts) {
  opts = opts || {};
  if (opts.run !== undefined && opts.run !== null && !validRunId(opts.run)) return { ok: false, cleared: [], kept: [], reason: 'invalid --run id' };
  const f = pointerFiles(root, opts.session);
  const now = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
  const cleared = [], kept = [];
  const consider = (file, isFallback) => {
    if (!file) return;
    const p = readPointer(file);
    if (!p.present) return;
    if (p.ok && p.data.run === null) { kept.push({ file, reason: 'already cleared' }); return; }
    if (p.ok && opts.run && p.data.run !== opts.run) { kept.push({ file, reason: 'names another run (' + p.data.run + ')' }); return; }
    if (isFallback && p.ok && typeof p.data.session === 'string' && f.bucket !== 'unknown-session' && p.data.session !== f.bucket) { kept.push({ file, reason: 'belongs to another session' }); return; }
    writeAtomic(file, { schema: SCHEMA, run: null, session: f.bucket !== 'unknown-session' ? f.bucket : null, cleared_at: now, previous_run: p.ok ? p.data.run : null });
    cleared.push(file);
  };
  try {
    consider(f.session, false);
    consider(f.fallback, true);
  } catch (e) {
    return { ok: false, cleared, kept, reason: 'could not write the pointer: ' + ((e && e.code) || 'unknown') };
  }
  return { ok: true, cleared, kept, reason: null };
}

// ---------------------------------------------------------------------------------------------------- CLI
const USAGE = 'Usage: node forge-active-run.cjs set <run_id> [--session <id>] [--allow-missing] [--root <dir>] [--json]\n'
  + '       node forge-active-run.cjs clear [--session <id>] [--run <run_id>] [--root <dir>] [--json]\n'
  + '       node forge-active-run.cjs show [--session <id>] [--root <dir>] [--json]';

function parseArgs(argv) {
  const o = { cmd: argv[0] || null, run: null, session: null, root: null, json: false, allowMissing: false, positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--allow-missing') o.allowMissing = true;
    else if (a === '--session' || a === '--root' || a === '--run') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(a + ' needs a value');
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else o.positional.push(a);
  }
  return o;
}

function main(argv, io) {
  io = io || { out: (s) => console.log(s), err: (s) => console.error(s) };
  let o;
  try { o = parseArgs(argv); } catch (e) { io.err(e.message + '\n' + USAGE); return 2; }
  const root = path.resolve(o.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const session = o.session || process.env.CLAUDE_SESSION_ID || null;
  const print = (obj, text) => io.out(o.json ? JSON.stringify(obj, null, 2) : text);
  if (o.cmd === 'set') {
    const runId = o.positional[0] || o.run;
    if (!runId) { io.err('set needs a run id\n' + USAGE); return 2; }
    const r = setActiveRun(root, runId, { session, allowMissing: o.allowMissing });
    if (!r.ok) { io.err('forge-active-run: ' + r.reason); return 1; }
    print(r, 'active run set: ' + r.run + (r.session ? ' (session ' + r.session + ')' : ' (fallback pointer only)') + ' -> ' + r.written.map((f) => path.relative(root, f)).join(', ') + (r.reason ? '\nnote: ' + r.reason : ''));
    return 0;
  }
  if (o.cmd === 'clear') {
    const r = clearActiveRun(root, { session, run: o.run || o.positional[0] || null });
    if (!r.ok) { io.err('forge-active-run: ' + r.reason); return 1; }
    print(r, 'cleared: ' + (r.cleared.length ? r.cleared.map((f) => path.relative(root, f)).join(', ') : 'nothing') + (r.kept.length ? '; kept: ' + r.kept.map((k) => path.relative(root, k.file) + ' (' + k.reason + ')').join(', ') : ''));
    return 0;
  }
  if (o.cmd === 'show') {
    const r = readActiveRun(root, session);
    print(r, r.run ? 'active run: ' + r.run + ' (' + r.source + ', set ' + r.set_at + ')' : 'no active run' + (r.reason ? ' (' + r.reason + ')' : ''));
    return 0;
  }
  io.err(USAGE);
  return 2;
}

module.exports = { readActiveRun, setActiveRun, clearActiveRun, pointerFiles, readPointer, maxAgeMs, main, SCHEMA, FALLBACK_FILE, DEFAULT_MAX_AGE_H };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
