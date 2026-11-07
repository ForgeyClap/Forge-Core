#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-stop.cjs — `SubagentStop` hook (modernization plan item 1.6).
 *
 * WHY: a `SubagentStop` payload is written by the HARNESS, not by the agent, so it is evidence that a subagent
 * really ran and really finished — something a self-written `subagent_completed` event can only claim (see
 * config/orchestration/HOOKS_OPT_IN.md, "CORRECTED 2026-08-01": hooks DO fire for Agent-tool subagents, and a
 * measured SubagentStop payload carried agent_id, agent_type, agent_transcript_path, last_assistant_message).
 *
 * WHERE IT WRITES: `.claude/forge-runs/_hooks/subagent-stop.jsonl` (+ one rotated generation `.1.jsonl`).
 * NOT the run's events.jsonl: that needs a run id and a registered event type (log-event.cjs KNOWN_EVENT_TYPES),
 * and a hook cannot know the run without the expensive, documented-fragile run picker (see forge-toolhook.cjs
 * header points 2-3). `_hooks/` carries no run.json/events.jsonl, so every run picker skips it, and the
 * existing `.claude/forge-runs/<dir>/<file>` .gitignore rule keeps it out of git.
 *
 * WHAT IT RECORDS — token-free, content-free: { ts, event:'SubagentStop', session, agent_id, agent_type, run?, run_source?,
 * skills_opened, transcript_scanned }. skills_opened (SK1) = the skill names the subagent's OWN transcript
 * (payload agent_transcript_path, official hooks docs "SubagentStop input") shows it opened through the Skill tool or a
 * Read of skills/<name>/SKILL.md (forge-skillmap.cjs, bounded scan); transcript_scanned:false when there was no path or
 * it could not be read. NEVER last_assistant_message, never a transcript path, never any message content. Every string passes
 * forge-toolhook.cjs's serialize() gate (forge-store.cjs SECRET_PATTERNS) before reaching disk; the session id
 * goes through its sessionBucket() (a secret-shaped id becomes 'unknown-session').
 *
 * RUN ATTRIBUTION (WP A2): `run` is present only when known, from (in order) opts.runId, env FORGE_RUN_ID,
 * or the run pointer the Lead writes with forge-active-run.cjs set <run_id> (<runs>/_hooks/active-run[.<session>].json);
 * `run_source` says which (opts | env | pointer-session | pointer-fallback). forge-harness-match.cjs joins these lines
 * to the run's subagent_started events by agent_id (and through the Workflow journal for Workflow lanes).
 *
 * LIVE-SESSION CONTRACT: never throws, never blocks (a SubagentStop hook CAN block a subagent from stopping —
 * this one never does: exit 0, no stdout, no decision), own failsafe timer, honours the forge-sync maintenance
 * lock and env FORGE_SUBAGENT_STOP_HOOK=off.
 *
 * Exports appendHookLine() so forge-session-end.cjs writes through the same bounded, scrubbed path, and
 * buildAgentRecord()/runHook()/hookMain() so forge-subagent-start.cjs (SubagentStart, WP A2) shares this exact path.
 */
const fs = require('fs');
const path = require('path');
const toolhook = require('./forge-toolhook.cjs');
let skillmap = null; // SK1: transcript scan; absent in an older install -> transcript_scanned:false
try { skillmap = require('./forge-skillmap.cjs'); } catch { skillmap = null; }
let activeRun = null; // WP A2: the run pointer reader; absent in an older install -> no pointer attribution
try { activeRun = require('./forge-active-run.cjs'); } catch { activeRun = null; }

const FAILSAFE_MS = 2500;
const HEAD_BYTES = 262144;
const HOOKS_DIRNAME = '_hooks';
const MAX_HOOK_LOG_BYTES = 1024 * 1024; // 1 MB + one kept generation per file
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** label — a short identifier or null. Free text (spaces, quotes, newlines) is never a label. */
function label(v) { return typeof v === 'string' && LABEL_RE.test(v) ? v : null; }
function offBy(name, env) { return /^(off|0|false|no)$/i.test(String((env || process.env)[name] || '')); }
// WP 2.1: the ACTIVE runs folder and "is this a Forge project" come from forge-toolhook.cjs (forge-paths inside it);
// an older forge-toolhook.cjs without them keeps the legacy .claude/forge-runs and the plain .claude/ check.
function runsDirOf(root) { return typeof toolhook.runsDir === 'function' ? toolhook.runsDir(root) : path.join(root, '.claude', 'forge-runs'); }
function forgeProject(root) { return typeof toolhook.isForgeProject === 'function' ? toolhook.isForgeProject(root) : fs.existsSync(path.join(root, '.claude')); }

/** appendHookLine(root, fileName, record, opts) -> {ok, wrote, path, reason}. Scrubbed through forge-toolhook's
 *  serialize() gate, size-capped, rotated at MAX_HOOK_LOG_BYTES. Never throws. */
function appendHookLine(root, fileName, record, opts) {
  opts = opts || {};
  try {
    if (!/^[a-z0-9-]{1,40}\.jsonl$/.test(fileName)) return { ok: false, wrote: false, reason: 'bad-file-name', path: null };
    if (!forgeProject(root)) return { ok: true, wrote: false, reason: 'no-forge-project', path: null };
    if (toolhook.syncMaintenance(root)) return { ok: true, wrote: false, skipped: true, reason: 'maintenance mode', path: null };
    const dir = path.join(runsDirOf(root), HOOKS_DIRNAME);
    const file = path.join(dir, fileName);
    const text = toolhook.serialize(record) + '\n';
    fs.mkdirSync(dir, { recursive: true });
    const maxLog = Number.isFinite(opts.maxLogBytes) ? opts.maxLogBytes : MAX_HOOK_LOG_BYTES;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + Buffer.byteLength(text, 'utf8') > maxLog) {
      const prev = file.replace(/\.jsonl$/, '.1.jsonl');
      try { fs.rmSync(prev, { force: true }); } catch { /* best effort */ }
      try { fs.renameSync(file, prev); } catch { /* keep appending rather than lose the line */ }
    }
    fs.appendFileSync(file, text, 'utf8');
    return { ok: true, wrote: true, reason: null, path: file };
  } catch (e) {
    return { ok: false, wrote: false, reason: 'error: ' + ((e && e.code) || 'unknown'), path: null };
  }
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** resolveRun(sessionId, opts) -> {run, source} | null. opts.runId, then env FORGE_RUN_ID, then (only when opts.root is
 *  given) the run pointer written by forge-active-run.cjs. An invalid id is never used. Never throws. */
function resolveRun(sessionId, opts) {
  opts = opts || {};
  if (opts.runId != null) { const r = String(opts.runId); return RUN_ID_RE.test(r) ? { run: r, source: 'opts' } : null; }
  const env = (opts.env || process.env).FORGE_RUN_ID || '';
  if (env) return RUN_ID_RE.test(env) ? { run: env, source: 'env' } : null;
  if (!opts.root || !activeRun || typeof activeRun.readActiveRun !== 'function') return null;
  try {
    const p = activeRun.readActiveRun(opts.root, sessionId, { env: opts.env });
    return p && p.run && RUN_ID_RE.test(p.run) ? { run: p.run, source: p.source } : null;
  } catch { return null; }
}

/** buildAgentRecord(payload, eventName, opts) -> the token-free line shared by SubagentStop and SubagentStart:
 *  { ts, event, session, agent_id, agent_type, agent_type_shape?, run?, run_source? }. */
function buildAgentRecord(payload, eventName, opts) {
  opts = opts || {};
  const p = isObj(payload) ? payload : {};
  const rec = {
    ts: opts.now || new Date().toISOString(),
    event: eventName,
    session: toolhook.sessionBucket(p.session_id),
    agent_id: label(p.agent_id),
    agent_type: label(p.agent_type),
  };
  // Why agent_type is null, without storing the value: absent from the payload, or present but not label-shaped.
  if (rec.agent_type === null) rec.agent_type_shape = typeof p.agent_type === 'string' && p.agent_type.length ? 'unlabelled' : 'absent';
  const r = resolveRun(p.session_id, opts);
  if (r) { rec.run = r.run; rec.run_source = r.source; }
  return rec;
}
/** transcriptPathOf(payload) -> the subagent transcript path (a leading ~ expanded) or null. Never stored. */
function transcriptPathOf(p) {
  const v = isObj(p) ? p.agent_transcript_path : null;
  if (typeof v !== 'string' || !v || v.length > 4096) return null;
  if (/^~[\\/]/.test(v)) { try { return path.join(require('os').homedir(), v.slice(2)); } catch { return null; } }
  return v;
}
/** skillsOpened(payload) -> { skills_opened, transcript_scanned } (SK1). Never throws. */
function skillsOpened(payload) {
  const file = transcriptPathOf(payload);
  if (!file || !skillmap) return { skills_opened: [], transcript_scanned: false };
  try {
    const r = skillmap.skillsOpenedInTranscript(file);
    return { skills_opened: r.scanned ? r.skills.filter((s) => label(s)) : [], transcript_scanned: r.scanned === true };
  } catch { return { skills_opened: [], transcript_scanned: false }; }
}
function buildRecord(payload, opts) { return Object.assign(buildAgentRecord(payload, 'SubagentStop', opts), skillsOpened(payload)); }
/** stopSalvage(head) — salvageIds() plus the transcript path (a JSON string, unescaped) so a cut payload is still scanned. */
function stopSalvage(head) {
  const p = salvageIds(head);
  if (!p) return null;
  const m = /"agent_transcript_path"\s*:\s*"((?:[^"\\]|\\.){1,4096})"/.exec(head);
  if (m) { try { p.agent_transcript_path = JSON.parse('"' + m[1] + '"'); } catch { /* no path */ } }
  return p;
}

/** salvageIds(head) — bounded regex salvage of the three ids from a cut payload (a very long
 *  last_assistant_message). A key inside an escaped JSON string reads \"agent_id\" and cannot match. */
function salvageIds(head) {
  // '\\s' (escaped): a bare '\s' inside a string literal is just 's', which made this regex miss `"agent_id": "x"`.
  const get = (k) => { const m = new RegExp('"' + k + '"\\s*:\\s*"([A-Za-z0-9._:@/-]{1,128})"').exec(head); return m ? m[1] : null; };
  const p = { session_id: get('session_id'), agent_id: get('agent_id'), agent_type: get('agent_type') };
  return p.agent_id || p.agent_type ? p : null;
}

/** runHook(raw, opts, spec) -> {ok, wrote, path, reason, record?}. NEVER throws. spec = {envFlag, fileName, build(payload,
 *  opts), salvage?(head), skip?(payload) -> reason|null} — the one parse/salvage/attribute/append path shared by
 *  SubagentStop, SubagentStart and the Agent-tool hook (WP A2). */
function runHook(raw, opts, spec) {
  opts = opts || {};
  try {
    if (offBy(spec.envFlag, opts.env)) return { ok: true, wrote: false, skipped: true, reason: spec.envFlag + '=off', path: null };
    let payload = null;
    try { payload = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { payload = null; }
    let truncated = false;
    if (!isObj(payload)) {
      payload = (spec.salvage || salvageIds)(typeof raw === 'string' ? raw.slice(0, HEAD_BYTES) : '');
      if (!payload) return { ok: true, wrote: false, reason: 'unparseable', path: null };
      truncated = true;
    }
    const skipReason = typeof spec.skip === 'function' ? spec.skip(payload) : null;
    if (skipReason) return { ok: true, wrote: false, skipped: true, reason: skipReason, path: null };
    const root = toolhook.resolveProjectRoot(opts);
    const record = spec.build(payload, Object.assign({}, opts, { root }));
    if (truncated) record.truncated = true;
    const r = appendHookLine(root, spec.fileName, record, opts);
    return Object.assign(r, { record: toolhook.scrubRecord(record) });
  } catch (e) {
    return { ok: false, wrote: false, reason: 'error: ' + ((e && e.code) || 'unknown'), path: null };
  }
}

/** run(raw, opts) -> {ok, wrote, path, reason, record?}. NEVER throws. */
function run(raw, opts) {
  return runHook(raw, opts, { envFlag: 'FORGE_SUBAGENT_STOP_HOOK', fileName: 'subagent-stop.jsonl', build: buildRecord, salvage: stopSalvage });
}

/** hookMain(handler) — the live-hook CLI shell: read at most HEAD_BYTES of stdin, call handler(text), exit 0 whatever
 *  happens (own failsafe timer). stdout stays empty unless the handler RETURNS a non-empty string (SK1: the
 *  SubagentStart hook's JSON); that string is written once and the process exits after the write is flushed. Shared with forge-subagent-start.cjs and forge-agent-tool-hook.cjs. */
function hookMain(handler) {
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
      // A payload longer than HEAD_BYTES (a huge last_assistant_message or prompt) does not parse; the handler then
      // salvages only the ids with bounded regexes and marks the line truncated:true.
      let out = null;
      try { out = handler(Buffer.concat(chunks).subarray(0, HEAD_BYTES).toString('utf8')); } catch { out = null; /* never fail the turn */ }
      if (typeof out === 'string' && out) {
        try { process.stdout.write(out, () => { clearTimeout(failsafe); finish(); }); return; } catch { /* fall through */ }
      }
      clearTimeout(failsafe);
      finish();
    });
    process.stdin.resume();
  } catch { finish(); }
}

module.exports = { run, runHook, hookMain, buildRecord, buildAgentRecord, resolveRun, salvageIds, stopSalvage, skillsOpened, transcriptPathOf, runsDirOf, appendHookLine, label, offBy, isObj, FAILSAFE_MS, HEAD_BYTES, HOOKS_DIRNAME, MAX_HOOK_LOG_BYTES };

if (require.main === module) hookMain(run);
