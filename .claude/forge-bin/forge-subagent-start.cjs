#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-start.cjs — `SubagentStart` hook (WP A2).
 *
 * WHY: forge-subagent-stop.cjs proves a subagent FINISHED; this hook proves it STARTED, at the moment it starts. Both
 * lines are written by the harness, not by the agent, so forge-harness-match.cjs can join the Lead's subagent_started
 * event to a real dispatch while the agent is still running (a background Agent-tool dispatch or a Workflow lane).
 * Spike A2a (Claude Code 2.1.316): SubagentStop carries agent_id + agent_type for Workflow lanes with an agentType and
 * for Agent-tool dispatches; SubagentStart carries the same two ids (plus the common session_id/transcript_path/cwd).
 *
 * WHERE IT WRITES: `<runs>/_hooks/subagent-start.jsonl` (+ one rotated generation), beside subagent-stop.jsonl.
 * WHAT IT RECORDS — token-free, content-free: { ts, event:'SubagentStart', session, agent_id, agent_type,
 * agent_type_shape?, run?, run_source? } — the run from the pointer the Lead writes with
 * `node .claude/forge-bin/forge-active-run.cjs set <run_id>` right after run_started. Never a transcript path, never any
 * message content; every string passes forge-toolhook.cjs's serialize() gate (exactly the path forge-subagent-stop.cjs
 * uses: runHook/appendHookLine/buildAgentRecord are shared, not copied).
 *
 * SKILL DELIVERY (category finding SK1): when the active run's LAST skill_map_created event assigns skills
 * to this agent_type (forge-skillmap.cjs normalises both map shapes and display-name keys, keeping only skills that
 * have a SKILL.md), the hook prints the official SubagentStart output
 * {"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}} (Claude Code hooks docs,
 * "SubagentStart": "String added to the subagent's context at the start of its conversation, before its first
 * prompt"), telling the subagent which skills to open first and to name the used ones in its report. With no run, no
 * map or no assignment it prints nothing, as before.
 *
 * LIVE-SESSION CONTRACT: never throws, never blocks (exit 0; stdout is empty or that one JSON object), own failsafe
 * timer, honours the forge-sync maintenance lock and env FORGE_SUBAGENT_START_HOOK=off.
 */
const fs = require('fs');
const path = require('path');
const SS = require('./forge-subagent-stop.cjs');
const toolhook = require('./forge-toolhook.cjs');
let SM = null; // absent in an older install -> no skill delivery, the start line is still written
try { SM = require('./forge-skillmap.cjs'); } catch { SM = null; }

const FILE_NAME = 'subagent-start.jsonl';
const ENV_FLAG = 'FORGE_SUBAGENT_START_HOOK';
const MAX_SKILLS = 12;

function buildRecord(payload, opts) { return SS.buildAgentRecord(payload, 'SubagentStart', opts); }

/** run(raw, opts) -> {ok, wrote, path, reason, record?}. NEVER throws. */
function run(raw, opts) { return SS.runHook(raw, opts, { envFlag: ENV_FLAG, fileName: FILE_NAME, build: buildRecord }); }

/** anticipatedSkills(runDir, runId) -> skills_to_use of an anticipate.json APPLIED for this run, or []. Never throws. */
function anticipatedSkills(runDir, runId) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(runDir, 'anticipate.json'), 'utf8').replace(/^﻿/, ''));
    if (!a || a.run_id !== runId || a.status !== 'applied' || !Array.isArray(a.skills_to_use)) return [];
    return a.skills_to_use.filter((s) => typeof s === 'string');
  } catch { return []; }
}

/** assignedSkillsDetailed(record, opts) -> {skills: [{name, file}], provisional}. The union of EVERY skill map of the run
 *  (SK6: the contract has judged the union since SK2); with no map at all yet, an executing agent type gets the category
 *  skills forge-anticipate chose for this run, marked provisional (windows-v7's Lead dispatched before logging its map).
 *  Never throws. */
function assignedSkillsDetailed(record, opts) {
  const none = { skills: [], provisional: false };
  try {
    if (!SM || !record || !record.run || !record.agent_type) return none;
    const root = (opts && opts.root) || toolhook.resolveProjectRoot(opts || {});
    const runDir = path.join(SS.runsDirOf(root), record.run);
    const where = SM.skillLocations(root, opts);
    const known = new Set(where.keys());
    const type = SM.agentTypeKey(record.agent_type);
    const rawType = String(record.agent_type);
    const bare = rawType.includes(':') ? SM.agentTypeKey(rawType.slice(rawType.lastIndexOf(':') + 1)) : null; // plugin-scoped ("forge:ui-boss", "Forge:UI Boss")
    const maps = typeof SM.allSkillMaps === 'function' ? SM.allSkillMaps(runDir) : [SM.latestSkillMap(runDir)].filter(Boolean);
    const pick = (names) => names.slice(0, MAX_SKILLS).map((n) => ({ name: n, file: where.get(n) }));
    if (maps.length) {
      const norm = typeof SM.unionSkillMap === 'function' ? SM.unionSkillMap(maps, known) : SM.normalizeSkillMap(maps[maps.length - 1], known);
      return { skills: pick((type && norm[type]) || (bare && norm[bare]) || []), provisional: false };
    }
    const executors = SM.EXECUTOR_TYPES || new Set();
    if (!executors.has(type) && !executors.has(bare)) return none;
    const names = [...new Set(anticipatedSkills(runDir, record.run).filter((n) => known.has(n)))];
    return { skills: pick(names), provisional: names.length > 0 };
  } catch { return none; }
}

/** assignedSkills(record, opts) -> [{name, file}] for this agent in the active run, or []. Never throws. */
function assignedSkills(record, opts) { return assignedSkillsDetailed(record, opts).skills; }

/** skillContext(record, opts) -> the additionalContext text, or null when nothing is assigned. */
function skillContext(record, opts) {
  const got = assignedSkillsDetailed(record, opts);
  const skills = got.skills;
  if (!skills.length) return null;
  const list = skills.map((s) => '- ' + s.name + ' (' + s.file + ')').join('\n');
  return [
    got.provisional
      ? 'Forge category skills for this run (' + record.run + '); the Lead has not logged the skill map yet, so these come from forge-anticipate / de Lead heeft de skill-map nog niet gelogd, deze komen uit forge-anticipate:'
      : 'Forge skills assigned to you (' + record.agent_type + ') for run ' + record.run + ' / Forge-skills voor jou in deze run:',
    list,
    'EN: Open each assigned skill FIRST, before other work: Read its SKILL.md at the path above, or use the Skill tool. In your final report, name which of these skills you actually used.',
    'NL: Open elke toegewezen skill EERST, voor ander werk: lees de SKILL.md op het pad hierboven, of gebruik de Skill-tool. Noem in je eindrapport welke van deze skills je echt gebruikt hebt.',
  ].join('\n');
}

/** foreignWorktreeWarning(cwd, root) -> STOP text when cwd is an agent worktree of ANOTHER repository than the project
 *  root (own mistake 2026-11-07: a Workflow launched from command-center/dashboard put both builder lanes in worktrees of
 *  the nested command-center repo), else null. Never throws. */
function foreignWorktreeWarning(cwd, root) {
  try {
    if (typeof cwd !== 'string' || !root) return null;
    const norm = (x) => path.resolve(x).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const c = norm(cwd), r = norm(root), i = c.indexOf('/.claude/worktrees/');
    if (i < 0 || c.slice(0, i) === r) return null;
    return 'STOP / STOP: you were started in an agent worktree of ANOTHER git repository (' + cwd.slice(0, i) + '), not of this project ('
      + root + '). The files you were asked to change are not in this checkout. Do not copy the project into it and do not edit the project root '
      + 'from here: end now and report "wrong worktree (repository ' + cwd.slice(0, i) + ')" so the Lead relaunches you from the project root. '
      + 'NL: je bent gestart in een worktree van een ANDERE repository; stop en meld "wrong worktree" zodat de Lead je opnieuw start vanuit de projectroot.';
  } catch { return null; }
}

/** hookOutput(result, opts, extra) -> the JSON string to print, or '' (nothing). Never throws. */
function hookOutput(result, opts, extra) {
  try {
    const ctx = [extra, result && result.record ? skillContext(result.record, opts) : null].filter(Boolean).join('\n\n');
    if (!ctx) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: ctx } });
  } catch { return ''; }
}

/** cli(raw) — the live hook: write the start line, return the context JSON (hookMain prints it) or ''. */
function cli(raw) {
  const result = run(raw);
  let warn = null;
  if (String(process.env[ENV_FLAG] || '').toLowerCase() !== 'off') {
    try { warn = foreignWorktreeWarning(JSON.parse(raw).cwd, toolhook.resolveProjectRoot({})); } catch { warn = null; }
  }
  return hookOutput(result, undefined, warn);
}

module.exports = { run, cli, buildRecord, assignedSkills, skillContext, hookOutput, foreignWorktreeWarning, FILE_NAME, ENV_FLAG };

if (require.main === module) SS.hookMain(cli);
