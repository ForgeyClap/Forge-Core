#!/usr/bin/env node
'use strict';
/**
 * forge-agent-tool-hook.cjs — `PreToolUse` + `PostToolUse` hook, matcher "Agent" (WP A2,,
 * 2026-11-01).
 *
 * WHY: the Lead logs `subagent_started {dispatch_id}`; until now nothing the harness wrote could confirm that id. This
 * hook records the two harness facts that make an Agent-tool dispatch provable (spike A2a, plan §4 F3):
 *   PreToolUse(Agent)  -> tool_use_id + tool_input.subagent_type (WHICH agent the harness was asked to run), and
 *   PostToolUse(Agent) -> tool_use_id + the dispatched agent's id from tool_response (links to SubagentStart/Stop).
 * forge-harness-match.cjs joins a `dispatch_id` of the form toolu_… to these lines. Workflow lanes never fire it (no Agent
 * tool call in the Lead session); they are proven through the Workflow journal + SubagentStart/Stop instead.
 *
 * FIELD NAMES: the hook input fields used are the ones measured in this repo (config/orchestration/HOOKS_OPT_IN.md,
 * "CORRECTED 2026-08-01": session_id, hook_event_name, tool_name, tool_use_id, tool_input, tool_response, agent_id,
 * agent_type). The Agent tool's own input keys (subagent_type, name, model, effort, run_in_background) and the key
 * that carries the new agent's id in tool_response are NOT pinned by a measurement here, so every one is read
 * defensively: a missing field is recorded as the string 'absent', a present value that is not a short identifier as
 * 'unlabelled' (its content is never stored), and the response key that held the id is recorded (agent_id_key).
 *
 * WHERE IT WRITES: `<runs>/_hooks/agent-tool.jsonl` (+ one rotated generation), through forge-subagent-stop.cjs's shared
 * runHook/appendHookLine path (forge-toolhook serialize() gate: SECRET_PATTERNS scrub, 2 KB line cap).
 * WHAT IT RECORDS — token-free, content-free:
 *   Pre : { ts, event:'PreToolUse', session, tool, tool_use_id, subagent_type, name, model, effort, background,
 *           caller_agent_id?, caller_agent_type?, run?, run_source? }
 *   Post: { ts, event:'PostToolUse', session, tool, tool_use_id, agent_id, agent_id_key, status, ok, ok_basis,
 *           caller_agent_id?, caller_agent_type?, run?, run_source? }
 * NEVER the prompt, the description, or any part of the response text.
 * caller_agent_id is the payload's own agent_id: present only when a SUBAGENT made the Agent call (nested dispatch).
 *
 * LIVE-SESSION CONTRACT: a PreToolUse hook that exits 2 BLOCKS the Agent call — this one never does: exit 0, no stdout,
 * no decision JSON, own failsafe timer. Only tool_name Agent (or the older Task) is recorded; anything else is skipped.
 * Honours the forge-sync maintenance lock and env FORGE_AGENT_TOOL_HOOK=off.
 *
 * DISPATCH FIT (W2-REVIEWFIX 2026-11-06): on PreToolUse it also runs forge-dispatch-fit (infer the tools the prompt seems
 * to need, check them against the agent's tools: line) and prints a one-line ADVISORY warning on STDERR when one is
 * missing. Still exit 0, still empty stdout: it never blocks or refuses a dispatch. Off: env FORGE_DISPATCH_FIT=off.
 */
const toolhook = require('./forge-toolhook.cjs');
const SS = require('./forge-subagent-stop.cjs');

const FILE_NAME = 'agent-tool.jsonl';
const ENV_FLAG = 'FORGE_AGENT_TOOL_HOOK';
const FIT_ENV_FLAG = 'FORGE_DISPATCH_FIT';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:@\/-]{0,63}$/; // a display name may hold spaces ("Build Boss"), never quotes/newlines
const RESPONSE_ID_KEYS = ['agentId', 'agent_id', 'agentID', 'resumedAgentId'];

/** field(v, re) -> the value when it is a short identifier, 'absent' when missing/empty, 'unlabelled' otherwise. */
function field(v, re) {
  if (v === undefined || v === null || v === '') return 'absent';
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6) return String(v);
  return typeof v === 'string' && (re || LABEL_RE).test(v) ? v : 'unlabelled';
}

/** eventOf(p) -> 'PreToolUse' | 'PostToolUse' — from hook_event_name, else from whether a tool_response is present. */
function eventOf(p) {
  if (p.hook_event_name === 'PreToolUse' || p.hook_event_name === 'PostToolUse') return p.hook_event_name;
  return p.tool_response !== undefined ? 'PostToolUse' : 'PreToolUse';
}

/** agentIdOf(resp) -> {agent_id, agent_id_key}: the dispatched agent's id from a known response key, or 'absent'. */
function agentIdOf(resp) {
  if (!SS.isObj(resp)) return { agent_id: 'absent', agent_id_key: null };
  for (const k of RESPONSE_ID_KEYS) {
    if (resp[k] === undefined || resp[k] === null || resp[k] === '') continue;
    return { agent_id: field(resp[k]), agent_id_key: k };
  }
  return { agent_id: 'absent', agent_id_key: null };
}

/** buildRecord(payload, opts) -> the token-free line for one Pre/PostToolUse(Agent) payload. */
function buildRecord(payload, opts) {
  opts = opts || {};
  const p = SS.isObj(payload) ? payload : {};
  const ev = eventOf(p);
  const rec = {
    ts: opts.now || new Date().toISOString(),
    event: ev,
    session: toolhook.sessionBucket(p.session_id),
    tool: field(p.tool_name),
    tool_use_id: field(p.tool_use_id),
  };
  if (ev === 'PreToolUse') {
    const ti = SS.isObj(p.tool_input) ? p.tool_input : {};
    rec.subagent_type = field(ti.subagent_type);
    rec.name = field(ti.name, NAME_RE);
    rec.model = field(ti.model);
    rec.effort = field(ti.effort);
    rec.background = typeof ti.run_in_background === 'boolean' ? ti.run_in_background : 'absent';
  } else {
    const resp = p.tool_response;
    Object.assign(rec, agentIdOf(resp));
    rec.status = SS.isObj(resp) ? field(resp.status) : 'absent';
    const ok = typeof toolhook.deriveOk === 'function' ? toolhook.deriveOk(resp) : { ok: null, ok_basis: 'absent' };
    rec.ok = ok.ok;
    rec.ok_basis = ok.ok_basis;
  }
  // The payload's own agent_id/agent_type name the CALLER (a subagent that dispatched another one), not the dispatched agent.
  if (p.agent_id !== undefined) rec.caller_agent_id = field(p.agent_id);
  if (p.agent_type !== undefined) rec.caller_agent_type = field(p.agent_type);
  const r = SS.resolveRun(p.session_id, opts);
  if (r) { rec.run = r.run; rec.run_source = r.source; }
  return rec;
}

/** salvage(head) — bounded regex salvage of the ids from a cut payload (a very long prompt). A key inside an escaped JSON
 *  string reads \"tool_use_id\" and cannot match. Only the Pre side is salvageable: a cut Post payload lost its response. */
function salvage(head) {
  const get = (k) => { const m = new RegExp('"' + k + '"\\s*:\\s*"([A-Za-z0-9._:@/-]{1,128})"').exec(head); return m ? m[1] : null; };
  const p = { session_id: get('session_id'), hook_event_name: get('hook_event_name'), tool_name: get('tool_name'), tool_use_id: get('tool_use_id') };
  if (!p.tool_use_id) return null;
  const st = get('subagent_type');
  if (p.hook_event_name !== 'PostToolUse') p.tool_input = st ? { subagent_type: st } : {};
  else p.tool_response = null;
  return p;
}

/** skip(payload) -> a reason when this is not an Agent-tool call (the hook may be wired to a broader matcher). */
function skip(p) {
  const t = SS.isObj(p) ? p.tool_name : undefined;
  return t === undefined || AGENT_TOOLS.has(t) ? null : 'not an Agent tool call';
}

/** fitWarning(payloadOrRaw, opts) -> a one-line warning string, or null. NEVER throws (W2-REVIEWFIX M2b).
 *  On a PreToolUse(Agent) call: infer the tools the prompt seems to need (forge-dispatch-fit infer) and check them
 *  against the dispatched agent's tools: line. ADVISORY ONLY: infer is a keyword guess, so a false positive must never
 *  block a legitimate dispatch; the caller prints the line on stderr and still exits 0. An unknown agent type (a built-in
 *  or plugin agent without a file here) gives no warning. A cut payload (prompt over HEAD_BYTES) is not parsed: no check.
 *  Off: env FORGE_DISPATCH_FIT=off. The prompt text itself is never stored or echoed. */
function fitWarning(input, opts) {
  opts = opts || {};
  try {
    if (SS.offBy(FIT_ENV_FLAG, opts.env)) return null;
    let p = input;
    if (typeof input === 'string') { try { p = JSON.parse(input); } catch { return null; } }
    if (!SS.isObj(p) || (p.tool_name !== undefined && !AGENT_TOOLS.has(p.tool_name)) || eventOf(p) !== 'PreToolUse') return null;
    const ti = SS.isObj(p.tool_input) ? p.tool_input : {};
    if (typeof ti.subagent_type !== 'string' || typeof ti.prompt !== 'string') return null;
    const FIT = require('./forge-dispatch-fit.cjs');
    const needs = FIT.inferTools(ti.prompt);
    if (!needs.length) return null;
    const fitOpts = opts.agentsDirs ? { agentsDirs: opts.agentsDirs } : {};
    const r = FIT.checkFit(ti.subagent_type, needs, fitOpts);
    const tag = '[forge dispatch-fit] warning (advisory, not blocking): ';
    if (r.unknown) return null;
    if (r.unreadable) return tag + `cannot read tools of ${r.agent} (${r.note}); check its agent file before relying on it.`;
    if (r.ok) return null;
    const alt = FIT.suggest(needs, fitOpts).slice(0, 6);
    const near = (r.nearMiss || []).map((m) => ` "${m.have}" differs only in case from "${m.need}".`).join('');
    return tag + `${r.agent} lacks ${r.missing.join(', ')}, which the prompt seems to need (inferred: ${needs.join(', ')}).`
      + near + ` Agents that have them: ${alt.length ? alt.join(', ') : 'none found'}.`;
  } catch (e) {
    return '[forge dispatch-fit] warning: the tool-fit check failed (' + ((e && (e.code || e.message)) || 'unknown') + '); the dispatch is not blocked.';
  }
}

/** run(raw, opts) -> {ok, wrote, path, reason, record?, fit_warning?}. NEVER throws. */
function run(raw, opts) {
  const res = SS.runHook(raw, opts, { envFlag: ENV_FLAG, fileName: FILE_NAME, build: buildRecord, salvage, skip });
  const w = fitWarning(raw, opts);
  if (w) res.fit_warning = w;
  return res;
}

/** cli(raw) — the live hook: record the dispatch, print a dispatch-fit warning on STDERR (stdout stays empty, exit 0). */
function cli(raw) {
  const r = run(raw);
  if (r && r.fit_warning) { try { process.stderr.write(r.fit_warning + '\n'); } catch { /* never fail the turn */ } }
}

module.exports = { run, fitWarning, buildRecord, salvage, agentIdOf, field, FILE_NAME, ENV_FLAG, FIT_ENV_FLAG, RESPONSE_ID_KEYS };

if (require.main === module) SS.hookMain(cli);
