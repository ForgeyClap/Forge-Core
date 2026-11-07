#!/usr/bin/env node
'use strict';
/**
 * forge-resume-brief.cjs — `SessionStart` hook for startup | resume | clear (.7, owner request R-0069).
 *
 * WHY: after a usage-limit stop, a /clear or a restart the new session started cold: the only SessionStart hook
 * (matcher "compact", forge-snapshot-reinject.cjs) prints nothing for the other sources, so unfinished work waited
 * for a manual /forge resume. This hook prints a SHORT brief that Claude Code adds to the new session's context:
 *   (a) the newest run folder without run-finalized.json and its unfinished work packages (wp_ids with an
 *       agent_work_package_created event and no later wp_completed / wp_failed): first 8 ids + total;
 *   (b) the open scribe items: count + the first 5 lines of `forge-scribe.cjs list --status ...` (80 chars each);
 *   (c) a fixed 4-line instruction to continue the work now.
 *
 * LIVE-SESSION CONTRACT: never throws, never blocks, always exit 0. Source `compact` prints nothing
 * (forge-snapshot-reinject.cjs owns it); `fork` and unknown sources print nothing; no stdin / a TTY = `startup`.
 * env FORGE_RESUME_BRIEF=off prints nothing. Output is capped at MAX_CHARS. events.jsonl is read in chunks with a
 * byte cap, the scribe child has a hard timeout and the whole hook has a FAILSAFE_MS, all under the 10 s timeout.
 * Only ids, counts and the first 80 chars of scribe lines are printed; secret-shaped tokens are masked.
 *
 * The root is CLAUDE_PROJECT_DIR (or the script's project), never the payload's `cwd`.
 * Registration: .claude/config/orchestration/resume-brief.fragment.json (merged into settings.json by the owner).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_CHARS = 2000;              // ~500 tokens, hard cap on stdout
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_RUN_DIRS = 200;            // newest run folders considered
const SCRIBE_TIMEOUT_MS = 2000;
const STDIN_WAIT_MS = 1000;
const FAILSAFE_MS = 2800;
const WP_SHOWN = 8;
const SCRIBE_SHOWN = 5;
const SCRIBE_LINE_CHARS = 80;
const BRIEF_SOURCES = new Set(['startup', 'resume', 'clear']);
const SCRIBE_STATUSES = 'unclassified,open,planned,in-progress';
const DONE_TYPES = new Set(['wp_completed', 'wp_failed']);
const CREATED = 'agent_work_package_created';

const INSTRUCTION = [
  'Continue the unfinished work above NOW, without asking whether to continue.',
  'Relaunch parallel lanes for every independent item (collision = one writer per file) and arm the lane/workflow watchdog.',
  'Owner-gated items (keys, spend, push/deploy, destructive, live) go last, batched in one list.',
  'Before planning, read the HARD MUST sections of ~/.claude/CLAUDE.md.',
];

/** Resolve the project root: explicit > CLAUDE_PROJECT_DIR > the project this script is installed in. */
function projectRoot(opts) {
  if (opts.root) return opts.root;
  const env = opts.env || process.env;
  if (env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim() !== '') return env.CLAUDE_PROJECT_DIR;
  try { return require('./forge-paths.cjs').scriptRoot(__dirname); } catch { return path.resolve(__dirname, '..', '..'); }
}

/** The run folders to scan: forge-paths' existing runs dirs when it can say, else .claude/forge-runs. */
function runsDirs(root, env) {
  try {
    const dirs = require('./forge-paths.cjs').existingStateDirs(root, 'runs', { env });
    if (Array.isArray(dirs) && dirs.length) return dirs;
  } catch { /* no canon in this root (fixtures, fresh installs): use the legacy location */ }
  const legacy = path.join(root, '.claude', 'forge-runs');
  return fs.existsSync(legacy) ? [legacy] : [];
}

function mtimeOf(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

/** Newest run folder (by events.jsonl mtime) that has events and no run-finalized.json, or null. */
function newestOpenRun(dirs) {
  const runs = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const dir = path.join(d, e.name);
      const events = path.join(dir, 'events.jsonl');
      const m = mtimeOf(events);
      if (m) runs.push({ id: e.name, dir, events, mtime: m });
    }
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  for (const r of runs.slice(0, MAX_RUN_DIRS)) {
    if (!fs.existsSync(path.join(r.dir, 'run-finalized.json'))) return r;
  }
  return null;
}

/** Feed one events.jsonl line into the open-WP map (insertion order = creation order). */
function applyLine(line, open) {
  if (!line.includes('wp_id')) return;
  const isCreated = line.includes(CREATED);
  if (!isCreated && !line.includes('wp_completed') && !line.includes('wp_failed')) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (!ev || typeof ev.wp_id !== 'string' || ev.wp_id === '') return;
  if (ev.event_type === CREATED) { open.delete(ev.wp_id); open.set(ev.wp_id, true); } else if (DONE_TYPES.has(ev.event_type)) open.delete(ev.wp_id);
}

/** Unfinished wp ids of one events.jsonl, read in chunks up to MAX_EVENT_BYTES. */
function unfinishedWps(eventsFile, maxBytes = MAX_EVENT_BYTES) {
  const open = new Map();
  let fd = null, read = 0, rest = '', truncated = false;
  try {
    fd = fs.openSync(eventsFile, 'r');
    const buf = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      if (read >= maxBytes) { truncated = true; break; }
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, maxBytes - read), null);
      if (n <= 0) break;
      read += n;
      const lines = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = lines.pop();
      for (const l of lines) applyLine(l, open);
    }
    if (!truncated && rest) applyLine(rest, open);
  } catch { /* unreadable file: report what was read */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  return { ids: [...open.keys()], truncated };
}

/** Mask secret-shaped tokens and control characters; keep the first `max` chars. */
function safeText(s, max) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza|eyJ)[-_A-Za-z0-9.]{8,}/g, '[masked]')
    .slice(0, max);
}

/** Open scribe items from the real CLI (fail-safe: any error = no scribe info). */
function scribeOpen(root) {
  const script = path.join(__dirname, 'forge-scribe.cjs');
  if (!fs.existsSync(script)) return null;
  try {
    const r = spawnSync(process.execPath, [script, 'list', '--status', SCRIBE_STATUSES], {
      cwd: root, encoding: 'utf8', timeout: SCRIBE_TIMEOUT_MS, windowsHide: true,
      env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    const lines = r.stdout.split(/\r?\n/).filter((l) => /^R-\d+/.test(l));
    return { count: lines.length, lines };
  } catch { return null; }
}

/** Cap the text at MAX_CHARS on a line boundary. */
function cap(text) {
  if (text.length <= MAX_CHARS) return text;
  const marker = '\n[brief truncated]\n';
  const cut = text.slice(0, MAX_CHARS - marker.length);
  const nl = cut.lastIndexOf('\n');
  return (nl > 0 ? cut.slice(0, nl) : cut) + marker;
}

/** Parse the hook payload; empty / unreadable = startup (a manual run). Returns the source string or null. */
function sourceOf(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'startup';
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'startup';
    return typeof p.source === 'string' && p.source !== '' ? p.source : 'startup';
  } catch { return 'startup'; }
}

/** Build the brief text (empty string = print nothing). opts: {root, env, scribe(root) -> {count, lines}|null}. */
function brief(raw, opts = {}) {
  const env = opts.env || process.env;
  if (String(env.FORGE_RESUME_BRIEF || '').toLowerCase() === 'off') return '';
  if (!BRIEF_SOURCES.has(sourceOf(raw))) return '';
  const root = projectRoot(opts);
  const run = newestOpenRun(runsDirs(root, env));
  const wps = run ? unfinishedWps(run.events) : { ids: [], truncated: false };
  const scribe = (opts.scribe || scribeOpen)(root);
  const hasRun = !!run && wps.ids.length > 0;
  const hasScribe = !!scribe && scribe.count > 0;
  if (!hasRun && !hasScribe) return '';
  const out = ['[Forge resume brief]'];
  if (hasRun) {
    out.push('Unfinished run: ' + safeText(run.id, 120) + ' (no run-finalized.json)');
    const more = wps.ids.length > WP_SHOWN ? ' ...' : '';
    out.push('Open work packages: ' + wps.ids.length + ' -> ' + wps.ids.slice(0, WP_SHOWN).map((id) => safeText(id, 40)).join(', ') + more +
      (wps.truncated ? ' (events.jsonl read partly)' : ''));
  }
  if (hasScribe) {
    out.push('Open scribe items: ' + scribe.count + ' (forge-scribe list):');
    for (const l of scribe.lines.slice(0, SCRIBE_SHOWN)) out.push('  ' + safeText(l, SCRIBE_LINE_CHARS));
  }
  out.push(...INSTRUCTION);
  return cap(out.join('\n') + '\n');
}

/** Read stdin without ever blocking: no stdin / TTY = '', otherwise wait at most STDIN_WAIT_MS. */
function readStdin(done) {
  if (process.stdin.isTTY) { done(''); return; }
  let data = '', finished = false;
  const finish = () => { if (!finished) { finished = true; done(data); } };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { if (data.length < 1024 * 1024) data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, STDIN_WAIT_MS).unref();
  } catch { finish(); }
}

function main() {
  process.exitCode = 0;
  setTimeout(() => process.exit(0), FAILSAFE_MS).unref();
  readStdin((raw) => {
    try {
      const text = brief(raw);
      if (text) process.stdout.write(text);
    } catch { /* never block a session start */ }
    process.exitCode = 0;
    try { process.stdin.destroy(); } catch { /* nothing to close */ }
  });
}

module.exports = { brief, sourceOf, unfinishedWps, newestOpenRun, safeText, cap, MAX_CHARS, INSTRUCTION };

if (require.main === module) main();
