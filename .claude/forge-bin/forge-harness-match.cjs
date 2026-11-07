#!/usr/bin/env node
'use strict';
/**
 * forge-harness-match.cjs — joins a run's dispatch events to what the HARNESS recorded (WP A2, run
 * 2026-11-01; plan §5 A2, spike A2a in _scratch/spike-harness/A2a-findings.md).
 *
 * WHY: `subagent_started {dispatch_id}` is written by the Lead. Until now nothing checked it against a record the Lead
 * cannot write, so a made-up dispatch_id was accepted silently (log-event.cjs only checked that the field EXISTS). The
 * harness hooks (forge-agent-tool-hook.cjs, forge-subagent-start.cjs, forge-subagent-stop.cjs) and the Workflow journal
 * are records that Claude Code itself writes; this tool reports, per dispatch, whether such a record backs it.
 *
 * CORRELATION PATHS (by the shape of dispatch_id):
 *   toolu_…            Agent-tool dispatch: PreToolUse(Agent) record with that tool_use_id (+ its subagent_type);
 *                      PostToolUse(Agent) adds the dispatched agent's id when the response carries it.
 *   a<hex>             agent id (what the Agent tool returns): a SubagentStart or SubagentStop record with that agent_id, else
 *                      (auto-discovery on) the harness's own <session>/subagents/agent-<id>.meta.json and its agentType.
 *   wf_<id>[:<lane>]   Workflow lane: the journal of that workflow (journal.jsonl: started {agentId, label "<type> · <lane>"})
 *                      + the harness agent type (agent-<id>.meta.json agentType, or a SubagentStart/Stop record).
 *   workflow:<name>:<lane>  the same, but only against journals passed with --journal (a name does not locate a folder).
 * The claimed agent type is the event's `agent` (slugified: "Build Boss" -> build-boss) plus any identifier-shaped
 * `subagent_type` / `agent_type` / `worker`; generic actors (lead, orchestrator) claim no type.
 *
 * VERDICT per dispatch:
 *   matched       a harness record backs the dispatch and its agent type agrees (type_check agree), or the event claims
 *                 no type (type_check not-claimed).
 *   unmatched     no record although the harness recorded THIS run (records stamped with this run by the run pointer,
 *                 forge-active-run.cjs), a type mismatch, a record of another run, a lane missing from its journal, no
 *                 dispatch_id, or a dispatch_id with no correlatable shape.
 *   unverifiable  (kind) external-cli (runtime codex/cli/gateway…: no Claude Code hook sees it — not counted in the
 *                 match percentage) · harness-absent (no record and the hook recorded nothing for this run: not installed
 *                 or the pointer not set) · harness-pending (only the stop hook is live and the agent may still run) ·
 *                 journal-missing · type-absent (a record exists but carries no agent type).
 *   match_pct = matched / (every dispatch except external-cli) — so a harness gap lowers it honestly.
 * Runtime internal/native events are not dispatches and are skipped (counted in skipped_internal).
 *
 * READS ONLY: <runs>/_hooks/{agent-tool,subagent-start,subagent-stop}[.1].jsonl (active and legacy runs folder), the run's
 * events.jsonl, journals given with --journal, and (auto-discovery, off with --no-find-journals or
 * FORGE_HARNESS_FIND_JOURNALS=off) <claude home>/projects/<this project's slug>/<session>/subagents/workflows/<wf id>/
 * journal.jsonl + agent-<id>.meta.json for the wf ids the run's own events name, and <session>/subagents/agent-<id>.meta.json
 * for an agent-id dispatch without a hook line. Never a transcript (agent-*.jsonl), never a prompt.
 *
 * CLI: node forge-harness-match.cjs --run <run_id> [--journal <journal.jsonl>]... [--no-find-journals] [--min <pct>]
 *        [--root <dir>] [--json]
 *   exit 0 = match_pct >= --min (default 95) or nothing provable · 1 = below it · 2 = usage/read error.
 * Library: matchRun(opts), harnessProofFor(opts) (log-event.cjs write-time stamp; env FORGE_HARNESS_STAMP=off turns that
 *   stamp off), meetsThreshold(summary, min).
 * Contract: forge-runcontract.cjs run-evidence `dispatch-harness` (rule dispatch-harness-match) calls matchRun({final:true}).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let toolhook = null;
try { toolhook = require('./forge-toolhook.cjs'); } catch { toolhook = null; }

const DEFAULT_MIN_MATCH_PCT = 95;
const DISPATCH_EVENTS = new Set(['subagent_started', 'agent_started']);
const INTERNAL_RUNTIMES = new Set(['internal', 'native']);
const EXTERNAL_RUNTIMES = new Set(['codex', 'codex-cli', 'cli', 'claude-p', 'claude-cli', 'gateway', 'external', 'nvidia', 'ollama', 'api']);
const GENERIC_AGENTS = new Set(['lead', 'orchestrator', 'main', 'main-session', 'router', 'lead-agent']);
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;
const SENTINELS = new Set(['absent', 'unlabelled']);
const TOOL_USE_RE = /^toolu_[A-Za-z0-9_-]{6,128}$/;
const AGENT_ID_RE = /^a[0-9a-f]{12,32}$/;
const WF_RE = /^(wf_[A-Za-z0-9-]{3,64})(?::(.{1,200}))?$/;
const WF_NAME_RE = /^workflow:([A-Za-z0-9._-]{1,128}):(.{1,200})$/;
const LANE_SEP_RE = /\s+·\s+/; // "build-boss · A0"
const HOOK_SOURCES = [['tool', 'agent-tool'], ['start', 'subagent-start'], ['stop', 'subagent-stop']];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 5000;
const MAX_ORPHANS = 50;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** idOf(v) -> v when it is an identifier (never the hooks' 'absent'/'unlabelled' sentinels), else null. */
function idOf(v) { return typeof v === 'string' && LABEL_RE.test(v) && !SENTINELS.has(v) ? v : null; }
function typeOfRec(r) { const t = r ? idOf(r.agent_type) : null; return t ? t.toLowerCase() : null; }
function slugify(v) { return String(v).trim().toLowerCase().replace(/[\s_]+/g, '-'); }
function offBy(name, env) { return /^(off|0|false|no)$/i.test(String((env || process.env)[name] || '')); }

function runsDirOf(root) {
  if (toolhook && typeof toolhook.runsDir === 'function') { try { return toolhook.runsDir(root); } catch { /* legacy below */ } }
  return path.join(root, '.claude', 'forge-runs');
}
/** hookDirs(root) -> the active and the legacy <runs>/_hooks folder (deduplicated). */
function hookDirs(root) {
  const out = [];
  for (const d of [path.join(runsDirOf(root), '_hooks'), path.join(root, '.claude', 'forge-runs', '_hooks')]) {
    const r = path.resolve(d);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** readJsonl(file, notes) -> [object]; a missing file is []; bad lines are skipped; never throws. */
function readJsonl(file, notes) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (!st.isFile()) return [];
  if (st.size > MAX_FILE_BYTES) { notes.push(path.basename(file) + ' skipped: larger than ' + MAX_FILE_BYTES + ' bytes'); return []; }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { notes.push(path.basename(file) + ' unreadable (' + ((e && e.code) || 'error') + ')'); return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { const o = JSON.parse(s); if (isObj(o)) out.push(o); } catch { /* a torn or foreign line is skipped */ }
  }
  return out;
}

/** loadHarness(root) -> {pre, post, start, stop: Map, records:{tool,start,stop}, files, notes}. Older generation first, so a
 *  later line for the same id wins. */
function loadHarness(root) {
  const notes = [];
  const H = { pre: new Map(), post: new Map(), start: new Map(), stop: new Map(), records: { tool: [], start: [], stop: [] }, files: [], notes };
  for (const dir of hookDirs(root)) {
    for (const [kind, base] of HOOK_SOURCES) {
      for (const name of [base + '.1.jsonl', base + '.jsonl']) {
        const f = path.join(dir, name);
        const recs = readJsonl(f, notes);
        if (!recs.length) continue;
        H.files.push({ file: f, kind, records: recs.length });
        for (const r of recs) {
          H.records[kind].push(r);
          if (kind === 'tool') {
            const id = idOf(r.tool_use_id);
            if (!id) continue;
            if (r.event === 'PreToolUse') H.pre.set(id, r); else if (r.event === 'PostToolUse') H.post.set(id, r);
          } else {
            const id = idOf(r.agent_id);
            if (id) H[kind].set(id, r);
          }
        }
      }
    }
  }
  return H;
}

/** liveFor(H, runId) -> {tool, start, stop, any}: how many hook records of each source carry this run. */
function liveFor(H, runId) {
  const n = (k) => H.records[k].filter((r) => r.run === runId).length;
  const live = { tool: n('tool'), start: n('start'), stop: n('stop') };
  live.any = live.tool + live.start + live.stop > 0;
  return live;
}

// ---------------------------------------------------------------------------------------------------- journals
/** parseJournal(file, notes) -> {wf, file, agents:[{agentId, label, lane, labelType, metaType, phase, finished}]}. */
function parseJournal(file, notes) {
  const recs = readJsonl(file, notes);
  const dir = path.dirname(file);
  const agents = new Map();
  for (const r of recs) {
    const id = idOf(r.agentId);
    if (r.type !== 'started' || !id) continue;
    const lab = typeof r.label === 'string' ? r.label.slice(0, 200) : '';
    const parts = lab.split(LANE_SEP_RE);
    const labelType = parts.length > 1 && LABEL_RE.test(parts[0]) ? parts[0].toLowerCase() : null;
    let metaType = null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'agent-' + id + '.meta.json'), 'utf8'));
      const t = isObj(m) ? idOf(m.agentType) : null;
      if (t) metaType = t.toLowerCase();
    } catch { /* no meta file: the type then has to come from a SubagentStart/Stop record */ }
    agents.set(id, { agentId: id, label: lab, lane: parts.length > 1 ? parts.slice(1).join(' · ') : lab, labelType, metaType, phase: idOf(r.phase), finished: false });
  }
  for (const r of recs) if (r.type === 'result' && agents.has(r.agentId)) agents.get(r.agentId).finished = true;
  return { wf: path.basename(dir), file, agents: [...agents.values()] };
}
function claudeHomeOf(opts) { return (opts && opts.claudeHome) || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
/** projectSlug(root) -> the folder name Claude Code uses under <claude home>/projects for this project. */
function projectSlug(root) { return path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'); }
/** sessionDirsOf(root, opts) -> {base, sessions:[name]} — this project's session folders under <claude home>/projects. */
function sessionDirsOf(root, opts) {
  const base = path.join(claudeHomeOf(opts), 'projects', projectSlug(root));
  try { return { base, sessions: fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).slice(0, MAX_SESSIONS) }; }
  catch { return { base, sessions: [] }; }
}
/** findAgentMeta(sd, agentId) -> {agentType, file} | null: the harness's own agent-<id>.meta.json of an Agent-tool subagent
 *  (<session>/subagents/), the type proof when the SubagentStart/Stop line has rotated away. */
function findAgentMeta(sd, agentId) {
  if (!AGENT_ID_RE.test(agentId)) return null;
  for (const s of sd.sessions) {
    const f = path.join(sd.base, s, 'subagents', 'agent-' + agentId + '.meta.json');
    let m;
    try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const t = isObj(m) ? idOf(m.agentType) : null;
    return { agentType: t ? t.toLowerCase() : null, file: f };
  }
  return null;
}
/** findJournals(root, wfIds, opts) -> [journal.jsonl paths] for the given wf ids under this project's session folders. */
function findJournals(root, wfIds, opts) {
  const ids = [...new Set(wfIds.filter((w) => WF_RE.test(w) && !w.includes(':')))];
  if (!ids.length) return [];
  const { base, sessions } = (opts && opts.sessionDirs) || sessionDirsOf(root, opts);
  const found = [];
  for (const s of sessions) for (const wf of ids) {
    const f = path.join(base, s, 'subagents', 'workflows', wf, 'journal.jsonl');
    try { if (fs.statSync(f).isFile()) found.push(f); } catch { /* not in this session */ }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------- events
function readRunEvents(root, runId) {
  for (const d of [path.join(runsDirOf(root), runId), path.join(root, '.claude', 'forge-runs', runId)]) {
    const f = path.join(d, 'events.jsonl');
    if (fs.existsSync(f)) return { file: f, events: readJsonl(f, []) };
  }
  return { file: null, events: null };
}
/** dispatchesOf(events) -> one entry per distinct dispatch (dispatch_id + claimed agent); events without an id stay separate. */
function dispatchesOf(events) {
  const out = [];
  const seen = new Map();
  (events || []).forEach((e, i) => {
    if (!isObj(e) || !DISPATCH_EVENTS.has(e.event_type)) return;
    const id = e.dispatch_id == null ? '' : String(e.dispatch_id).trim().slice(0, 300);
    const key = id ? id + '|' + (e.agent == null ? '' : slugify(e.agent)) : '#' + i;
    if (seen.has(key)) { seen.get(key).event_types.add(e.event_type); return; }
    const d = { index: i, dispatch_id: id || null, agent: e.agent == null ? null : String(e.agent).slice(0, 80), runtime: typeof e.runtime === 'string' ? e.runtime.trim().toLowerCase() : null, event_types: new Set([e.event_type]), ev: e };
    seen.set(key, d);
    out.push(d);
  });
  return out;
}
/** expectedTypes(ev) -> Set of agent types the event claims (slugs, lowercased). */
function expectedTypes(ev) {
  const s = new Set();
  if (ev.agent != null) { const a = slugify(ev.agent); if (a && !GENERIC_AGENTS.has(a) && LABEL_RE.test(a)) s.add(a); }
  for (const f of ['subagent_type', 'agent_type', 'worker']) if (typeof ev[f] === 'string' && LABEL_RE.test(ev[f])) s.add(ev[f].toLowerCase());
  return s;
}

// ---------------------------------------------------------------------------------------------------- matching
function itemOf(d, kind, status, reason, extra) {
  return Object.assign({ dispatch_id: d.dispatch_id, agent: d.agent, event_types: [...d.event_types], runtime: d.runtime, kind, status, reason }, extra || {});
}
function otherRunOf(recs, runId) {
  for (const r of recs) if (r && typeof r.run === 'string' && r.run && r.run !== runId) return r.run;
  return null;
}
/** judgeType(d, kind, ht, extra) -> the verdict once a harness record is found: the type decides. */
function judgeType(d, kind, ht, extra) {
  const exp = expectedTypes(d.ev);
  const x = Object.assign({ claimed_types: [...exp] }, extra || {});
  if (!ht) return itemOf(d, kind, 'unverifiable', 'a harness record exists but carries no agent type, so it cannot show which agent ran', Object.assign(x, { unverifiable_kind: 'type-absent' }));
  if (!exp.size) return itemOf(d, kind, 'matched', 'harness record found (' + ht + ' ran); the event claims no agent type', Object.assign(x, { harness_type: ht, type_check: 'not-claimed' }));
  if (exp.has(ht)) return itemOf(d, kind, 'matched', 'harness record found and the harness agent type ' + ht + ' agrees', Object.assign(x, { harness_type: ht, type_check: 'agree' }));
  return itemOf(d, kind, 'unmatched', 'the harness says ' + ht + ' ran, the event claims ' + [...exp].join(' / '), Object.assign(x, { harness_type: ht, type_check: 'mismatch' }));
}
function agentSources(ctx, aid) {
  return [ctx.H.start.has(aid) ? 'subagent-start' : null, ctx.H.stop.has(aid) ? 'subagent-stop' : null].filter(Boolean);
}
function typeOfAgent(ctx, aid) { return typeOfRec(ctx.H.start.get(aid)) || typeOfRec(ctx.H.stop.get(aid)); }

function matchAgentTool(d, id, ctx) {
  const pre = ctx.H.pre.get(id), post = ctx.H.post.get(id);
  if (!pre && !post) {
    if (ctx.live.tool) return itemOf(d, 'agent-tool', 'unmatched', 'no PreToolUse(Agent) record carries this tool_use_id, although the Agent hook recorded this run');
    return itemOf(d, 'agent-tool', 'unverifiable', 'no PreToolUse(Agent) record for this tool_use_id and the Agent hook recorded nothing for this run (hook not installed or the run pointer not set)', { unverifiable_kind: 'harness-absent' });
  }
  const aid = post ? idOf(post.agent_id) : null;
  const other = otherRunOf([pre, post, aid ? ctx.H.start.get(aid) : null, aid ? ctx.H.stop.get(aid) : null], ctx.runId);
  if (other) return itemOf(d, 'agent-tool', 'unmatched', 'the harness record of this tool_use_id belongs to run ' + other);
  let ht = pre ? idOf(pre.subagent_type) : null;
  if (ht) ht = ht.toLowerCase();
  if (!ht && aid) ht = typeOfAgent(ctx, aid);
  const sources = [pre ? 'agent-tool:pre' : null, post ? 'agent-tool:post' : null].filter(Boolean).concat(aid ? agentSources(ctx, aid) : []);
  return judgeType(d, 'agent-tool', ht, Object.assign({ sources, finished: post ? true : (aid && ctx.H.stop.has(aid)) || null }, aid ? { agent_id: aid } : {}));
}

function matchAgentId(d, id, ctx) {
  const s = ctx.H.start.get(id), e = ctx.H.stop.get(id);
  if (!s && !e && ctx.sessionDirs) {
    const meta = findAgentMeta(ctx.sessionDirs(), id);
    if (meta) return judgeType(d, 'agent-id', meta.agentType, { agent_id: id, sources: ['agent-meta'], finished: null });
  }
  if (!s && !e) {
    if (ctx.live.start) return itemOf(d, 'agent-id', 'unmatched', 'no SubagentStart/SubagentStop record carries this agent_id, although the SubagentStart hook recorded this run');
    if (ctx.final && ctx.live.stop) return itemOf(d, 'agent-id', 'unmatched', 'no SubagentStop record carries this agent_id, although the SubagentStop hook recorded this run');
    if (ctx.live.stop) return itemOf(d, 'agent-id', 'unverifiable', 'no SubagentStart hook record for this run and the agent may still be running (only the stop hook is live)', { unverifiable_kind: 'harness-pending' });
    return itemOf(d, 'agent-id', 'unverifiable', 'no SubagentStart/SubagentStop record for this agent_id and the hooks recorded nothing for this run (not installed or the run pointer not set)', { unverifiable_kind: 'harness-absent' });
  }
  const other = otherRunOf([s, e], ctx.runId);
  if (other) return itemOf(d, 'agent-id', 'unmatched', 'the harness record of this agent_id belongs to run ' + other);
  return judgeType(d, 'agent-id', typeOfRec(s) || typeOfRec(e), { agent_id: id, sources: agentSources(ctx, id), finished: e ? true : null });
}

const VERDICT_RANK = { matched: 0, unverifiable: 1, unmatched: 2 };
function matchWorkflow(d, id, ctx) {
  const m = WF_RE.exec(id);
  const wf = m ? m[1] : null;
  const lane = m ? (m[2] || null) : WF_NAME_RE.exec(id)[2];
  const journals = wf ? ctx.journals.filter((j) => j.wf === wf) : ctx.explicitJournals;
  if (!journals.length) {
    const why = wf ? 'no Workflow journal found for ' + wf + (ctx.findJournals ? ' (auto-discovery under the project\'s session folders found none)' : '') : 'a workflow:<name> dispatch_id names no journal folder';
    return itemOf(d, 'workflow', 'unverifiable', why + ' — pass --journal <path to that workflow\'s journal.jsonl>', { unverifiable_kind: 'journal-missing' });
  }
  const want = lane ? lane.trim().toLowerCase() : null;
  // A lane matches exactly, by agent id, by the full label, or as the FIRST WORD of a longer lane ("A5" -> "A5 rework",
  // "A9" -> "A9 (2)", never "A1" -> "A10"): measured on the 2026-11-01 run, the Lead names a rework round by its WP id.
  const laneHit = (a) => {
    const l = a.lane.trim().toLowerCase();
    if (!want || l === want || a.agentId === lane || a.label.trim().toLowerCase() === want) return 'exact';
    return l.startsWith(want + ' ') ? 'first-word' : null;
  };
  const cands = [];
  for (const j of journals) for (const a of j.agents) { const h = laneHit(a); if (h) cands.push(Object.assign({}, a, { laneMatch: h })); }
  if (!cands.length) return itemOf(d, 'workflow', 'unmatched', 'lane "' + String(lane).slice(0, 60) + '" is not in the journal of ' + (wf || 'the given workflow') + ' (' + journals.reduce((n, j) => n + j.agents.length, 0) + ' lane(s) there)');
  let best = null;
  for (const a of cands) {
    const s = ctx.H.start.get(a.agentId), e = ctx.H.stop.get(a.agentId);
    const other = otherRunOf([s, e], ctx.runId);
    const it = other
      ? itemOf(d, 'workflow', 'unmatched', 'the harness record of agent ' + a.agentId + ' belongs to run ' + other, { agent_id: a.agentId })
      : judgeType(d, 'workflow', a.metaType || typeOfAgent(ctx, a.agentId), { agent_id: a.agentId, workflow: wf, lane: a.lane.slice(0, 60), lane_match: a.laneMatch,
        sources: ['workflow-journal', a.metaType ? 'agent-meta' : null].filter(Boolean).concat(agentSources(ctx, a.agentId)), finished: a.finished || !!e || null });
    // the best verdict wins; on a tie an exact lane beats a first-word one
    if (!best || VERDICT_RANK[it.status] < VERDICT_RANK[best.status] || (VERDICT_RANK[it.status] === VERDICT_RANK[best.status] && it.lane_match === 'exact' && best.lane_match !== 'exact')) best = it;
  }
  if (cands.length > 1) best.candidates = cands.length;
  return best;
}

function matchOne(d, ctx) {
  if (d.runtime && EXTERNAL_RUNTIMES.has(d.runtime)) return itemOf(d, 'external', 'unverifiable', 'runtime "' + d.runtime + '" runs outside Claude Code, so no harness hook can see it', { unverifiable_kind: 'external-cli' });
  const id = d.dispatch_id;
  if (!id) return itemOf(d, 'none', 'unmatched', 'no dispatch_id on the event, so nothing can tie it to a real dispatch');
  if (TOOL_USE_RE.test(id)) return matchAgentTool(d, id, ctx);
  if (AGENT_ID_RE.test(id)) return matchAgentId(d, id, ctx);
  if (WF_RE.test(id) || WF_NAME_RE.test(id)) return matchWorkflow(d, id, ctx);
  return itemOf(d, 'unknown', 'unmatched', 'the dispatch_id has no shape the harness records (expected toolu_…, an agent id a<hex>, wf_<id>:<lane> or workflow:<name>:<lane>)');
}

/** orphansOf(ctx, items) -> harness records stamped with THIS run that no dispatch event points at (e.g. an unlogged or
 *  nested dispatch). Informational, never counted in the match percentage. */
function orphansOf(ctx, items) {
  const linkedTools = new Set(items.filter((i) => i.kind === 'agent-tool').map((i) => i.dispatch_id));
  const linkedAgents = new Set(items.map((i) => i.agent_id).filter(Boolean));
  for (const t of linkedTools) { const p = ctx.H.post.get(t); if (p && idOf(p.agent_id)) linkedAgents.add(p.agent_id); }
  const out = [];
  for (const r of ctx.H.records.tool) {
    if (r.run !== ctx.runId || r.event !== 'PreToolUse' || !idOf(r.tool_use_id) || linkedTools.has(r.tool_use_id)) continue;
    out.push({ source: 'agent-tool', tool_use_id: r.tool_use_id, subagent_type: idOf(r.subagent_type) });
    linkedTools.add(r.tool_use_id);
  }
  for (const k of ['start', 'stop']) for (const r of ctx.H.records[k]) {
    const aid = idOf(r.agent_id);
    if (r.run !== ctx.runId || !aid || linkedAgents.has(aid)) continue;
    out.push({ source: k === 'start' ? 'subagent-start' : 'subagent-stop', agent_id: aid, agent_type: typeOfRec(r) });
    linkedAgents.add(aid);
  }
  return out.slice(0, MAX_ORPHANS);
}

/** summarize(items, orphans) -> the counts and the match percentage (see the header). */
function summarize(items, orphanCount, skippedInternal) {
  const by = (s) => items.filter((i) => i.status === s).length;
  const kinds = {};
  for (const i of items) if (i.unverifiable_kind) kinds[i.unverifiable_kind] = (kinds[i.unverifiable_kind] || 0) + 1;
  const external = kinds['external-cli'] || 0;
  const provable = items.length - external;
  const matched = by('matched');
  return {
    dispatches: items.length, matched, unmatched: by('unmatched'), unverifiable: by('unverifiable'), unverifiable_by_kind: kinds,
    provable, match_pct: provable ? Math.round((matched / provable) * 1000) / 10 : null, skipped_internal: skippedInternal, orphans: orphanCount,
  };
}
/** meetsThreshold(summary, min) -> true when there is nothing provable or match_pct >= min. */
function meetsThreshold(s, min) {
  const m = Number.isFinite(min) ? min : DEFAULT_MIN_MATCH_PCT;
  return !s || s.dispatches === 0 || s.provable === 0 || (s.match_pct !== null && s.match_pct >= m);
}

/** matchRun(opts) -> report. opts: root, runId, events? (else read from the run folder), journals? [paths],
 *  findJournals? (default true unless FORGE_HARNESS_FIND_JOURNALS=off), final? (the run is over: a missing stop record
 *  counts), claudeHome?, env?. Throws only on a bad run id or an unreadable run; the per-file reads never throw. */
function matchRun(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const runId = String(opts.runId || '');
  if (!RUN_ID_RE.test(runId)) throw new Error('forge-harness-match: invalid run id "' + runId.slice(0, 80) + '"');
  let events = opts.events;
  let eventsFile = null;
  if (!Array.isArray(events)) {
    const r = readRunEvents(root, runId);
    if (!r.events) throw new Error('forge-harness-match: no events.jsonl for run "' + runId + '" under ' + runsDirOf(root));
    events = r.events; eventsFile = r.file;
  }
  const H = opts._harness || loadHarness(root);
  const all = dispatchesOf(events);
  const dispatches = all.filter((d) => !(d.runtime && INTERNAL_RUNTIMES.has(d.runtime)));
  const findOn = opts.findJournals !== false && !offBy('FORGE_HARNESS_FIND_JOURNALS', opts.env);
  const explicit = (opts.journals || []).map((f) => path.resolve(String(f)));
  const wfIds = dispatches.map((d) => (d.dispatch_id && WF_RE.exec(d.dispatch_id) || [])[1]).filter(Boolean);
  let sdCache = null;
  const sessionDirs = findOn ? () => (sdCache || (sdCache = sessionDirsOf(root, opts))) : null;
  const found = findOn && wfIds.length ? findJournals(root, wfIds, Object.assign({}, opts, { sessionDirs: sessionDirs() })) : [];
  const parsedExplicit = explicit.map((f) => parseJournal(f, H.notes));
  const seenJ = new Set(explicit);
  const parsedFound = found.filter((f) => !seenJ.has(path.resolve(f))).map((f) => parseJournal(f, H.notes));
  for (const f of explicit) if (!fs.existsSync(f)) H.notes.push('--journal ' + f + ' does not exist');
  const ctx = { H, runId, live: liveFor(H, runId), final: opts.final === true, journals: parsedExplicit.concat(parsedFound), explicitJournals: parsedExplicit, findJournals: findOn, sessionDirs };
  const items = dispatches.map((d) => matchOne(d, ctx));
  const orphans = orphansOf(ctx, items);
  return {
    tool: 'forge-harness-match', run_id: runId, root, final: ctx.final, events_file: eventsFile,
    summary: summarize(items, orphans.length, all.length - dispatches.length),
    items, orphans,
    harness: {
      live: ctx.live, files: H.files.map((f) => ({ file: path.relative(root, f.file).split(path.sep).join('/'), kind: f.kind, records: f.records })),
      journals: ctx.journals.map((j) => ({ wf: j.wf, file: j.file, lanes: j.agents.length, source: seenJ.has(path.resolve(j.file)) ? 'explicit' : 'auto' })),
      notes: H.notes.slice(0, 20),
    },
  };
}

/** harnessProofFor({root, runId, event, ...}) -> {status, reason, kind, unverifiable_kind} | {status:'not-live'} | null.
 *  The write-time view log-event.cjs stamps from: it judges ONE dispatch event, and only once the harness recorded this
 *  run (a record stamped with it), so a project without the hooks or the pointer is never labelled. Never throws. */
function harnessProofFor(opts) {
  try {
    if (offBy('FORGE_HARNESS_STAMP', opts.env)) return { status: 'off', reason: 'FORGE_HARNESS_STAMP=off', kind: null, unverifiable_kind: null };
    if (!RUN_ID_RE.test(String(opts.runId || ''))) return null;
    const root = path.resolve(opts.root || process.cwd());
    const H = loadHarness(root);
    // liveness first: no journal or session-folder read for a run the harness never recorded
    if (!liveFor(H, opts.runId).any) return { status: 'not-live', reason: 'the harness recorded nothing for this run', kind: null, unverifiable_kind: null };
    const r = matchRun({ root, runId: opts.runId, events: [opts.event], findJournals: opts.findJournals, final: false, claudeHome: opts.claudeHome, env: opts.env, _harness: H });
    const it = r.items[0];
    return it ? { status: it.status, reason: it.reason, kind: it.kind, unverifiable_kind: it.unverifiable_kind || null } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------- CLI
const USAGE = 'Usage: node forge-harness-match.cjs --run <run_id> [--journal <journal.jsonl>]... [--no-find-journals] [--min <pct>] [--root <dir>] [--json]';
function parseArgs(argv) {
  const o = { run: null, journals: [], findJournals: true, min: DEFAULT_MIN_MATCH_PCT, root: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(a + ' needs a value'); return v; };
    if (a === '--run') o.run = val();
    else if (a === '--journal') o.journals.push(val());
    else if (a === '--no-find-journals') o.findJournals = false;
    else if (a === '--min') { const n = Number(val()); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('--min must be a number from 0 to 100'); o.min = n; }
    else if (a === '--root') o.root = val();
    else if (a === '--json') o.json = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!o.run) throw new Error('--run <run_id> is required');
  return o;
}
function formatReport(r, min) {
  const s = r.summary;
  const kinds = Object.entries(s.unverifiable_by_kind).map(([k, n]) => k + ' ' + n).join(', ');
  const lines = ['dispatch harness match — run ' + r.run_id + ': ' + s.dispatches + ' dispatch(es), ' + s.matched + ' matched, ' + s.unmatched + ' unmatched, '
    + s.unverifiable + ' unverifiable' + (kinds ? ' (' + kinds + ')' : '') + '; match ' + (s.match_pct === null ? 'n/a (nothing provable)' : s.match_pct + '%') + ' (min ' + min + '%)'
    + (s.skipped_internal ? '; ' + s.skipped_internal + ' internal/native event(s) skipped' : '')];
  lines.push('harness live for this run: agent-tool ' + r.harness.live.tool + ', subagent-start ' + r.harness.live.start + ', subagent-stop ' + r.harness.live.stop + ' record(s); journals: ' + (r.harness.journals.length ? r.harness.journals.map((j) => j.wf + ' (' + j.source + ')').join(', ') : 'none'));
  for (const i of r.items) {
    const st = i.status === 'unverifiable' ? 'unverifiable(' + i.unverifiable_kind + ')' : i.status;
    lines.push('  ' + st.padEnd(28) + ' ' + String(i.dispatch_id || '(no dispatch_id)').padEnd(34) + ' ' + String(i.agent || '?') + ' — ' + i.reason + (i.sources && i.sources.length ? ' [' + i.sources.join('+') + ']' : ''));
  }
  if (r.orphans.length) lines.push('harness records of this run that no dispatch event names (' + r.orphans.length + '): ' + r.orphans.map((o) => (o.tool_use_id || o.agent_id) + ' ' + (o.subagent_type || o.agent_type || '?')).join(', '));
  for (const n of r.harness.notes) lines.push('note: ' + n);
  return lines.join('\n');
}
function main(argv, io) {
  io = io || { out: (s) => console.log(s), err: (s) => console.error(s) };
  let o;
  try { o = parseArgs(argv); } catch (e) { io.err(e.message + '\n' + USAGE); return 2; }
  let r;
  try { r = matchRun({ root: o.root, runId: o.run, journals: o.journals, findJournals: o.findJournals, final: true }); }
  catch (e) { io.err(e.message); return 2; }
  const ok = meetsThreshold(r.summary, o.min);
  io.out(o.json ? JSON.stringify(Object.assign({ min_match_pct: o.min, meets_min: ok }, r), null, 2) : formatReport(r, o.min));
  return ok ? 0 : 1;
}

module.exports = {
  matchRun, harnessProofFor, meetsThreshold, loadHarness, liveFor, parseJournal, findJournals, projectSlug, dispatchesOf, expectedTypes,
  formatReport, main, DEFAULT_MIN_MATCH_PCT, EXTERNAL_RUNTIMES, INTERNAL_RUNTIMES,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
