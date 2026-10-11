#!/usr/bin/env node
'use strict';
/**
 * forge-lane-watchdog.cjs — read-only watchdog for parallel background Agent-tool lanes: it notices a lane that is
 * stuck, idle, looping or failing, and machine trouble (low disk, a flooded temp folder) that would break every lane.
 *
 * WHY: Forge works in parallel by default. When more than one lane (a background Agent-tool subagent) runs at the
 * same time, the Lead arms this watchdog as a Monitor so a silent hang is seen within minutes instead of hours.
 * It reads the lanes' transcripts (`agent-<id>.jsonl` in the session's `subagents` folder) and nothing else.
 * It never writes, never kills, never touches a transcript, needs no packages, and prints at most 80 characters
 * of any tool input.
 *
 * USAGE:
 *   node .claude/forge-bin/forge-lane-watchdog.cjs --ids <agentId,agentId,...> [--session <subagentsDir>]
 *        [--once | --watch <sec>] [--stall-min 12] [--hang-min 15] [--noop-min 8] [--loop-n 6] [--err-n 5]
 *        [--disk-min-gb 5] [--tmp-max 50000]
 *   --ids      the lanes that are RUNNING now (remove a lane from the list when its completion notice arrives)
 *   --session  the `<claude config>/projects/<slug>/<session>/subagents` folder. Default: the newest session folder
 *              of the project slug derived from the current directory, under $CLAUDE_CONFIG_DIR/projects when that
 *              variable is set, otherwise under <home>/.claude/projects.
 *   --once     (default) print one report and exit: 0 = every lane healthy, 1 = at least one flag, 2 = usage error
 *   --watch N  poll every N seconds (minimum 2) and print ONE line per NEW flag and per cleared flag, so it can
 *              run as a Monitor event stream. Flag keys ignore numbers, so a growing minute count is not "new".
 *
 * FLAGS:
 *   STALLED       transcript not written for >= stall-min minutes while the lane is listed as running
 *                 (a lane whose last substantive entry is an assistant end_turn with no open tool call has
 *                 FINISHED and is never reported as stalled)
 *   HUNG-TOOL     a tool call without a result for >= hang-min minutes (a stuck command or CLI)
 *   NO-WORK       lane older than noop-min minutes with zero tool calls
 *   LOOP          the same tool call (same name and input) repeated loop-n times in a row
 *   ERROR-STREAK  err-n consecutive failing tool results (is_error, ENOSPC, EACCES, EBUSY, Traceback, non-zero exit)
 *   NO-TRANSCRIPT no agent-<id>.jsonl for a listed lane in the session folder
 *   DISK-LOW      free space on the system drive below disk-min-gb
 *   TMP-FLOOD     more than tmp-max top-level entries in the OS temp folder
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = { stallMin: 12, hangMin: 15, noopMin: 8, loopN: 6, errN: 5, diskMinGb: 5, tmpMax: 50000 };
const MIN_POLL_SEC = 2;
const MAX_SHOWN = 80;
const ERR_RE = /ENOSPC|no space left|EACCES|EBUSY|EPERM|Traceback|Unhandled|ECONNREFUSED|command not found|exit code [1-9]|"is_error":true/i;

function parseArgs(argv) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const num = (n, d) => { const v = Number(opt(n, d)); return Number.isFinite(v) ? v : d; };
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    ids: String(opt('--ids', '')).split(',').map((s) => s.trim()).filter(Boolean),
    session: opt('--session', null),
    watch: argv.includes('--watch') ? Math.max(MIN_POLL_SEC, num('--watch', 60)) : 0,
    stallMs: num('--stall-min', DEFAULTS.stallMin) * 60000,
    hangMs: num('--hang-min', DEFAULTS.hangMin) * 60000,
    noopMs: num('--noop-min', DEFAULTS.noopMin) * 60000,
    loopN: num('--loop-n', DEFAULTS.loopN),
    errN: num('--err-n', DEFAULTS.errN),
    diskMinGb: num('--disk-min-gb', DEFAULTS.diskMinGb),
    tmpMax: num('--tmp-max', DEFAULTS.tmpMax),
  };
}

function projectsDir(env) {
  const base = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// Claude Code names a project folder after its path with every non-alphanumeric character turned into '-'.
const slugOf = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase();

function newestSessionDir(cwd, env) {
  const base = projectsDir(env);
  const want = slugOf(cwd);
  let best = null;
  let projects = [];
  try { projects = fs.readdirSync(base); } catch { return null; }
  for (const proj of projects) {
    if (slugOf(proj) !== want) continue;
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(base, proj)); } catch { continue; }
    for (const s of sessions) {
      const sub = path.join(base, proj, s, 'subagents');
      try {
        const st = fs.statSync(sub);
        if (st.isDirectory() && (!best || st.mtimeMs > best.m)) best = { dir: sub, m: st.mtimeMs };
      } catch { /* no subagents folder in this session */ }
    }
  }
  return best && best.dir;
}

function readEntries(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch { /* a half-written last line is skipped */ }
  }
  return out;
}

function scanCalls(entries, now) {
  const pending = new Map();
  const calls = [];
  let toolCalls = 0, firstTs = null, errStreak = 0;
  for (const e of entries) {
    const ts = Date.parse(e.timestamp || '') || null;
    if (ts && (firstTs === null || ts < firstTs)) firstTs = ts;
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const p of content) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'tool_use') {
        toolCalls++;
        const key = p.name + ' ' + JSON.stringify(p.input || {}).slice(0, 200);
        calls.push(key);
        pending.set(p.id, { name: p.name, at: ts || now, key });
      } else if (p.type === 'tool_result') {
        pending.delete(p.tool_use_id);
        const body = typeof p.content === 'string' ? p.content : JSON.stringify(p.content || '');
        const bad = p.is_error === true || ERR_RE.test(body.slice(0, 1500));
        errStreak = bad ? errStreak + 1 : 0;
      }
    }
  }
  return { pending, calls, toolCalls, firstTs, errStreak };
}

// Finished = the last substantive entry is an assistant message that ended its turn with no open tool call.
function isFinished(entries, pendingCount) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'attachment' || e.type === 'system') continue;
    return !!(e.type === 'assistant' && e.message && e.message.stop_reason === 'end_turn' && pendingCount === 0);
  }
  return false;
}

function longestRun(calls) {
  let run = calls.length ? 1 : 0, best = run;
  for (let i = 1; i < calls.length; i++) { run = calls[i] === calls[i - 1] ? run + 1 : 1; if (run > best) best = run; }
  return best;
}

function analyse(id, session, cfg, now) {
  const f = path.join(session || '', 'agent-' + id + '.jsonl');
  let st;
  try { st = fs.statSync(f); } catch { return { id, flags: ['NO-TRANSCRIPT ' + id + ' (no agent-' + id + '.jsonl in the session folder)'] }; }
  const entries = readEntries(f);
  const s = scanCalls(entries, now);
  const idle = now - st.mtimeMs;
  const finished = isFinished(entries, s.pending.size);
  const flags = [];
  if (!finished && idle >= cfg.stallMs) flags.push('STALLED ' + id + ' (no transcript write for ' + Math.round(idle / 60000) + ' min)');
  for (const t of s.pending.values()) {
    if (now - t.at >= cfg.hangMs) flags.push('HUNG-TOOL ' + id + ' ' + t.name + ' open ' + Math.round((now - t.at) / 60000) + ' min: ' + t.key.slice(0, MAX_SHOWN));
  }
  const age = s.firstTs ? now - s.firstTs : null;
  if (age !== null && age >= cfg.noopMs && s.toolCalls === 0) flags.push('NO-WORK ' + id + ' (' + Math.round(age / 60000) + ' min old, 0 tool calls)');
  if (longestRun(s.calls) >= cfg.loopN) flags.push('LOOP ' + id + ' (same tool call repeated >= ' + cfg.loopN + ' times in a row: ' + (s.calls[s.calls.length - 1] || '').slice(0, MAX_SHOWN) + ')');
  if (s.errStreak >= cfg.errN) flags.push('ERROR-STREAK ' + id + ' (' + s.errStreak + ' failing tool results in a row)');
  return { id, finished, lines: entries.length, idleMin: Math.round(idle / 60000), toolCalls: s.toolCalls, pending: s.pending.size, errStreak: s.errStreak, flags };
}

function globalFlags(cfg) {
  const flags = [];
  try {
    const root = path.parse(os.tmpdir()).root;
    const s = fs.statfsSync(root);
    const freeGb = (s.bavail * s.bsize) / 2 ** 30;
    if (freeGb < cfg.diskMinGb) flags.push('DISK-LOW ' + root + ' free ' + freeGb.toFixed(1) + ' GB < ' + cfg.diskMinGb + ' GB (lanes will fail with ENOSPC)');
  } catch { /* statfs not available on this Node or platform */ }
  try {
    const n = fs.readdirSync(os.tmpdir()).length;
    if (n > cfg.tmpMax) flags.push('TMP-FLOOD ' + n + ' top-level entries in ' + os.tmpdir() + ' (> ' + cfg.tmpMax + ')');
  } catch { /* temp folder unreadable */ }
  return flags;
}

function snapshot(cfg, session, now = Date.now()) {
  const lanes = cfg.ids.map((id) => analyse(id, session, cfg, now));
  const flags = lanes.flatMap((l) => l.flags).concat(globalFlags(cfg));
  return { lanes, flags, at: new Date(now).toISOString() };
}

// Numbers that stand alone (minutes, counts, GB) become '#'; digits inside an agent id are kept.
const keyOf = (flag) => String(flag).replace(/\b\d+(\.\d+)?\b/g, '#');

function laneLine(l) {
  const head = (l.flags && l.flags.length ? 'FLAG ' : l.finished ? 'done ' : 'ok   ') + l.id;
  if (l.lines === undefined) return head;
  return head + '  lines ' + l.lines + '  idle ' + l.idleMin + 'm  tools ' + l.toolCalls + '  pending ' + l.pending + '  errStreak ' + l.errStreak;
}

function runOnce(cfg, session, log) {
  const r = snapshot(cfg, session);
  for (const l of r.lanes) log(laneLine(l));
  for (const f of r.flags) log('[WATCHDOG] ' + f);
  if (!r.flags.length) log('[WATCHDOG] all ' + cfg.ids.length + ' lane(s) healthy at ' + r.at);
  return r.flags.length ? 1 : 0;
}

function runWatch(cfg, session, log) {
  let prev = new Set();
  const tick = () => {
    const r = snapshot(cfg, session);
    const cur = new Set(r.flags.map(keyOf));
    for (const f of r.flags) if (!prev.has(keyOf(f))) log('[WATCHDOG] ' + f);
    for (const k of prev) if (!cur.has(k)) log('[WATCHDOG] cleared: ' + k);
    prev = cur;
  };
  log('[WATCHDOG] armed for ' + cfg.ids.length + ' lane(s), poll ' + cfg.watch + 's, session ' + path.basename(path.dirname(session)));
  tick();
  return setInterval(tick, cfg.watch * 1000);
}

function main(argv) {
  const cfg = parseArgs(argv);
  if (cfg.help) {
    const src = fs.readFileSync(__filename, 'utf8');
    const m = src.match(/\/\*\*([\s\S]*?)\*\//);
    console.log(m ? m[1].replace(/^ \* ?/gm, '').trim() : 'forge-lane-watchdog');
    return 0;
  }
  if (!cfg.ids.length) { console.error('forge-lane-watchdog: --ids <agentId,...> is required (the lanes running now)'); return 2; }
  const session = cfg.session || newestSessionDir(process.cwd(), process.env);
  if (!session) { console.error('forge-lane-watchdog: no session subagents folder found under ' + projectsDir(process.env) + '; pass --session'); return 2; }
  if (!cfg.watch) return runOnce(cfg, session, (s) => console.log(s));
  runWatch(cfg, session, (s) => console.log(s));
  return null; // keeps running until the Monitor stops it
}

module.exports = { parseArgs, projectsDir, slugOf, newestSessionDir, analyse, globalFlags, snapshot, keyOf, longestRun, isFinished, DEFAULTS };

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
}
