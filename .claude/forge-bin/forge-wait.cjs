#!/usr/bin/env node
'use strict';
/**
 * forge-wait.cjs — wait in the FOREGROUND until a session's subagents have stopped (category finding H1).
 *
 * WHY: in a headless `claude -p` session (the Command Center, the category tests) a Lead that launches a background
 * Workflow or Agent and then ends its turn gets that subagent killed when Claude Code exits ("[Request interrupted by
 * user for tool use]"), and the run stays NOT DONE. The harness logs prove it: <runs>/_hooks/subagent-start.jsonl has a
 * line for the agent_id and subagent-stop.jsonl has none. This command keeps the turn alive instead:
 *
 *   node .claude/forge-bin/forge-wait.cjs [--session <id>] [--max-sec 540] [--poll-sec 3] [--root <project>]
 *
 * It polls the two harness-written logs (forge-subagent-start.cjs / forge-subagent-stop.cjs, both generations) and
 * prints one short line whenever the open count changes. Exit 0 "all done" once every subagent of the session that
 * STARTED (within OPEN_MAX_AGE_MS) has a SubagentStop line with the same agent_id; exit 3 "still N open after X s:
 * <types>" at --max-sec (default 540, under the Bash tool's 10-minute limit; just run it again to keep waiting);
 * exit 2 on a bad argument; exit 1 on an internal error (never a false "all done").
 * Session default: the most recent session (by its newest start line) that has an open subagent; none -> exit 0.
 *
 * Reads only those two logs (bounded: the last MAX_LOG_BYTES of each file), never a transcript or any message text.
 * The runs folder is resolved the way forge-subagent-start.cjs / forge-active-run.cjs do (forge-toolhook.cjs
 * runsDir(), the legacy .claude/forge-runs and .forge/runs as well during a partial migration). Zero dependencies.
 * Shared with forge-stop-obligations.cjs (I.8 OPEN-SUBAGENTS): openAgents(), runsDirsFor().
 */
const fs = require('fs');
const path = require('path');

const OPEN_MAX_AGE_MS = 2 * 60 * 60 * 1000; // a start line older than this is a crash leftover, not a running agent
const MAX_LOG_BYTES = 4 * 1024 * 1024;      // per file generation (the writer rotates at 1 MB)
const DEFAULT_MAX_SEC = 540;
const MAX_MAX_SEC = 590;
const DEFAULT_POLL_SEC = 3;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // = forge-toolhook SESSION_RE
const HOOKS = '_hooks';

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** runsDirsFor(root) -> the existing runs folders, the hook writer's own first. Never throws. */
function runsDirsFor(root) {
  const out = [];
  const add = (d) => { if (d && !out.includes(d) && isDir(d)) out.push(d); };
  try { const th = require('./forge-toolhook.cjs'); if (th && typeof th.runsDir === 'function') add(th.runsDir(root)); } catch { /* legacy below */ }
  add(path.join(root, '.claude', 'forge-runs'));
  add(path.join(root, '.forge', 'runs'));
  return out;
}

/** readTail(file) -> text of at most the last MAX_LOG_BYTES (a cut first line is dropped), or ''. Never throws. */
function readTail(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size <= MAX_LOG_BYTES) return fs.readFileSync(file, 'utf8');
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(MAX_LOG_BYTES);
    const n = fs.readSync(fd, b, 0, b.length, size - MAX_LOG_BYTES);
    const t = b.toString('utf8', 0, n);
    return t.slice(t.indexOf('\n') + 1);
  } catch { return ''; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
}

/** hookRecords(dirs, base) -> parsed lines of <dir>/_hooks/<base>.1.jsonl and <base>.jsonl. Bad lines skipped. */
function hookRecords(dirs, base) {
  const out = [];
  for (const d of dirs) for (const n of [base + '.1.jsonl', base + '.jsonl']) {
    for (const line of readTail(path.join(d, HOOKS, n)).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line.replace(/^﻿/, '')); if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r); } catch { /* skip */ }
    }
  }
  return out;
}

/** openAgents(dirs, opts) -> [{agent_id, agent_type, session, ms}] — started (within maxAgeMs of now, per session when
 *  opts.session is set) and not stopped (a stop line with the same agent_id, any session). Never throws. */
function openAgents(dirs, opts) {
  opts = opts || {};
  try {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : OPEN_MAX_AGE_MS;
    const stopped = new Set();
    for (const r of hookRecords(dirs, 'subagent-stop')) if (typeof r.agent_id === 'string' && r.agent_id) stopped.add(r.agent_id);
    const open = new Map();
    for (const r of hookRecords(dirs, 'subagent-start')) {
      if (typeof r.agent_id !== 'string' || !r.agent_id || stopped.has(r.agent_id)) continue;
      if (typeof r.session !== 'string' || (opts.session && r.session !== opts.session)) continue;
      const ms = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (!Number.isFinite(ms) || now - ms > maxAge) continue;
      if (!open.has(r.agent_id)) open.set(r.agent_id, { agent_id: r.agent_id, agent_type: typeof r.agent_type === 'string' && r.agent_type ? r.agent_type : 'unlabelled', session: r.session, ms });
    }
    return [...open.values()].sort((a, b) => a.ms - b.ms);
  } catch { return []; }
}

/** latestOpenSession(dirs, opts) -> the session whose newest open start line is the most recent, or null. */
function latestOpenSession(dirs, opts) {
  let best = null;
  for (const a of openAgents(dirs, Object.assign({}, opts, { session: null }))) if (!best || a.ms >= best.ms) best = a;
  return best ? best.session : null;
}

function typesOf(list) {
  const c = new Map();
  for (const a of list) c.set(a.agent_type, (c.get(a.agent_type) || 0) + 1);
  return [...c].map(([t, n]) => (n > 1 ? t + ' x' + n : t)).join(', ');
}

function parseArgs(argv) {
  const o = { session: null, maxSec: DEFAULT_MAX_SEC, pollSec: DEFAULT_POLL_SEC, root: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--session' || k === '--max-sec' || k === '--poll-sec' || k === '--root') {
      if (v === undefined) return { error: k + ' needs a value' };
      i++;
      if (k === '--session') { if (!SESSION_RE.test(v)) return { error: 'invalid --session' }; o.session = v; }
      else if (k === '--root') o.root = path.resolve(v);
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { error: k + ' must be a positive number' };
        if (k === '--max-sec') o.maxSec = Math.min(MAX_MAX_SEC, n); else o.pollSec = Math.max(0.2, Math.min(30, n));
      }
    } else if (k === '--help' || k === '-h') return { help: true };
    else return { error: 'unknown argument ' + k };
  }
  return o;
}

/** wait(opts, log) -> Promise<{code, text, open}>. opts = parseArgs() result. Never rejects. */
function wait(opts, log) {
  const say = typeof log === 'function' ? log : () => {};
  return new Promise((resolve) => {
    try {
      const root = opts.root || (process.env.CLAUDE_PROJECT_DIR ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd());
      const t0 = Date.now();
      const secs = () => Math.round((Date.now() - t0) / 1000);
      let session = opts.session;
      let last = -1;
      const tick = () => {
        try {
          const dirs = runsDirsFor(root);
          if (!session) session = latestOpenSession(dirs);
          const open = session ? openAgents(dirs, { session }) : [];
          if (!open.length) { resolve({ code: 0, text: '[forge-wait] all done: no open subagents' + (session ? ' in session ' + session : '') + ' (' + secs() + ' s)', open }); return; }
          if (open.length !== last) { say('[forge-wait] ' + open.length + ' open: ' + typesOf(open)); last = open.length; }
          if (Date.now() - t0 >= opts.maxSec * 1000) {
            resolve({ code: 3, text: '[forge-wait] still ' + open.length + ' open after ' + secs() + ' s: ' + typesOf(open) + ' (run it again to keep waiting)', open });
            return;
          }
          setTimeout(tick, Math.min(opts.pollSec * 1000, Math.max(50, opts.maxSec * 1000 - (Date.now() - t0))));
        } catch (e) { resolve({ code: 1, text: '[forge-wait] error: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200), open: [] }); }
      };
      tick();
    } catch (e) { resolve({ code: 1, text: '[forge-wait] error: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200), open: [] }); }
  });
}

module.exports = { openAgents, latestOpenSession, runsDirsFor, hookRecords, readTail, parseArgs, wait, typesOf, OPEN_MAX_AGE_MS, MAX_LOG_BYTES, DEFAULT_MAX_SEC, SESSION_RE };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write('usage: node .claude/forge-bin/forge-wait.cjs [--session <id>] [--max-sec 540] [--poll-sec 3]\n'); process.exit(0); }
  if (o.error) { process.stdout.write('[forge-wait] ' + o.error + '\n'); process.exit(2); }
  wait(o, (l) => process.stdout.write(l + '\n')).then((r) => { process.stdout.write(r.text + '\n'); process.exit(r.code); });
}
