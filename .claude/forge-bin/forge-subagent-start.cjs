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
 * agent_type_shape?, run?, run_source?, skills_preloaded?, defaults_sha? } — the run from the pointer the Lead writes with
 * `node .claude/forge-bin/forge-active-run.cjs set <run_id>` right after run_started. skills_preloaded (SD-T4,
 * 2026-11-08) = the frontmatter `skills:` of the agent file (.claude/agents/<type>.md, then ~/.claude/agents/<type>.md),
 * which Claude Code injects at start; absent when nothing is preloaded (no agent file, or one without skills:).
 * defaults_sha (SD-T12c) = the first 12 hex characters of the sha256 of the FORGE_DEFAULT_SKILLS.json bytes,
 * absent (read as null) when that file is absent or unreadable, like skills_preloaded, so the line keeps its old shape
 * there; the doctor measures delivery only on lines of the current source.
 * Never a transcript path, never any message
 * content; every string passes forge-toolhook.cjs's serialize() gate (exactly the path forge-subagent-stop.cjs uses:
 * runHook/appendHookLine/buildAgentRecord are shared, not copied).
 *
 * SKILL DELIVERY (category finding SK1, SD-T4): the skills for this agent are the union of
 * every skill_map_created map of the active run (forge-skillmap.cjs normalises both map shapes and display-name keys,
 * keeping only skills that have a SKILL.md) and the role baseline from FORGE_DEFAULT_SKILLS.json
 * (forge-default-skills.cjs) and the agent's own domain skills (agent_domain), MINUS what the agent file already preloads. With no map yet, an executing agent type also
 * gets the run's forge-anticipate skills (provisional). A file-less agent (general-purpose) cannot preload, so it also
 * gets the forge-conduct body as text. An agent that has the Skill tool is told to call it; one without it is told to
 * Read the SKILL.md, so the text never promises a tool the agent lacks. The hook prints the official SubagentStart
 * output {"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}, at most MAX_CONTEXT_CHARS
 * (Claude Code saves a longer text to a file the agent is not told to read): a list that does not fit ends with
 * "+N more in .claude/config/orchestration/FORGE_DEFAULT_SKILLS.json". With no run or nothing to inject it prints nothing.
 *
 * LIVE-SESSION CONTRACT: never throws, never blocks (exit 0; stdout is empty or that one JSON object), own failsafe
 * timer, honours the forge-sync maintenance lock and env FORGE_SUBAGENT_START_HOOK=off.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SS = require('./forge-subagent-stop.cjs');
const toolhook = require('./forge-toolhook.cjs');
let SM = null; // absent in an older install -> no skill delivery, the start line is still written
try { SM = require('./forge-skillmap.cjs'); } catch { SM = null; }
let DS = null; // absent in an older install -> no role baseline, the map alone decides (the SK1 behaviour)
try { DS = require('./forge-default-skills.cjs'); } catch { DS = null; }

const FILE_NAME = 'subagent-start.jsonl';
const ENV_FLAG = 'FORGE_SUBAGENT_START_HOOK';
const MAX_SKILLS = 12;
const MAX_CONTEXT_CHARS = 10000;
const CONDUCT_MAX_CHARS = 4000;
const DEFAULTS_MAX_BYTES = 256 * 1024;
const DEFAULTS_POINTER = '.claude/config/orchestration/FORGE_DEFAULT_SKILLS.json';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** rootOf(opts) -> the project root (opts.root, else the hook's own resolution). */
function rootOf(opts) { return (opts && opts.root) || toolhook.resolveProjectRoot(opts || {}); }

/** sourcePath(root) -> the FORGE_DEFAULT_SKILLS.json path of this root. */
function sourcePath(root) { return path.join(root, (DS && DS.SOURCE_REL) || DEFAULTS_POINTER); }

/** defaultsSha(root) -> first 12 hex of sha256 over the FORGE_DEFAULT_SKILLS.json bytes, or null (absent, unreadable,
 *  over DEFAULTS_MAX_BYTES). Never throws. Shared with doctor/checks-default-skills.cjs. */
function defaultsSha(root) {
  try {
    if (typeof root !== 'string' || !root) return null;
    const file = sourcePath(root);
    if (fs.statSync(file).size > DEFAULTS_MAX_BYTES) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch { return null; }
}

/** buildRecord(payload, opts) -> the shared start line, plus skills_preloaded when the agent has an agent file, and
 *  defaults_sha. shortcut: the source is read again for the offered set; a write in between those reads is not caught. */
function buildRecord(payload, opts) {
  const rec = SS.buildAgentRecord(payload, 'SubagentStart', opts);
  try { const sha = defaultsSha(rootOf(opts)); if (sha) rec.defaults_sha = sha; } catch { /* absent = not measured */ }
  try {
    if (SM && typeof SM.agentFileInfo === 'function' && rec.agent_type) {
      const info = SM.agentFileInfo(rootOf(opts), rec.agent_type, opts);
      const pre = info.found ? info.skills.filter((s) => SS.label(s)) : [];
      if (pre.length) rec.skills_preloaded = pre; // absent = nothing preloaded (no agent file, or one without skills:)
    }
  } catch { /* the start line is written without it */ }
  return rec;
}

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

/** defaultsOf(root) -> the FORGE_DEFAULT_SKILLS.json data object, or null (no loader, no file, too big, unreadable).
 *  The data is used even when its validation lists problems: every name is filtered against the installed skills. */
function defaultsOf(root) {
  try {
    if (!DS || typeof DS.loadDefaults !== 'function' || typeof root !== 'string' || !root) return null;
    const size = fs.statSync(sourcePath(root)).size;
    if (size > DEFAULTS_MAX_BYTES) return null;
    const r = DS.loadDefaults(root);
    return r && isObj(r.data) ? r.data : null;
  } catch { return null; }
}

/** typesOf(agentType) -> {type, bare}: the normalised type and, for a plugin-scoped one ("forge:ui-boss"), its bare name. */
function typesOf(agentType) {
  const raw = String(agentType);
  return { type: SM.agentTypeKey(raw), bare: raw.includes(':') ? SM.agentTypeKey(raw.slice(raw.lastIndexOf(':') + 1)) : null };
}

/** assignedSkillsDetailed(record, opts) -> {skills: [{name, file}], provisional, total}. (Union of EVERY skill map of
 *  the run (SK6) or, with no map yet and for an executing type, the forge-anticipate skills marked provisional) ∪ the
 *  role baseline (SD-T4), minus the agent file's preloads, in that order, at most MAX_SKILLS; total = the uncut count.
 *  Never throws. */
function assignedSkillsDetailed(record, opts) {
  const none = { skills: [], provisional: false, total: 0 };
  try {
    if (!SM || !record || !record.run || !record.agent_type) return none;
    const root = rootOf(opts);
    const runDir = path.join(SS.runsDirOf(root), record.run);
    const where = SM.skillLocations(root, opts);
    const known = new Set(where.keys());
    const { type, bare } = typesOf(record.agent_type);
    const maps = typeof SM.allSkillMaps === 'function' ? SM.allSkillMaps(runDir) : [SM.latestSkillMap(runDir)].filter(Boolean);
    let names = [];
    let provisional = false;
    if (maps.length) {
      const norm = typeof SM.unionSkillMap === 'function' ? SM.unionSkillMap(maps, known) : SM.normalizeSkillMap(maps[maps.length - 1], known);
      names = (type && norm[type]) || (bare && norm[bare]) || [];
    } else {
      const executors = SM.EXECUTOR_TYPES || new Set();
      if (executors.has(type) || executors.has(bare)) {
        names = anticipatedSkills(runDir, record.run).filter((n) => known.has(n));
        provisional = names.length > 0;
      }
    }
    const data = defaultsOf(root);
    // Offered = preloadFor minus the conduct skill: role baseline + the agent's own domain (bare name too, for "forge:x").
    const declared = (t) => DS.baselineFor(t, data).concat(typeof DS.domainFor === 'function' ? DS.domainFor(t, data) : []);
    const baseline = data ? declared(type || '').concat(bare ? declared(bare) : []) : [];
    const preloaded = new Set((Array.isArray(record.skills_preloaded) ? record.skills_preloaded : []).map((s) => String(s).toLowerCase()));
    const all = [...new Set(names.concat(baseline.filter((n) => known.has(n))))].filter((n) => !preloaded.has(n.toLowerCase()));
    return { skills: all.slice(0, MAX_SKILLS).map((n) => ({ name: n, file: where.get(n) })), provisional, total: all.length };
  } catch { return none; }
}

/** assignedSkills(record, opts) -> [{name, file}] for this agent in the active run, or []. Never throws. */
function assignedSkills(record, opts) { return assignedSkillsDetailed(record, opts).skills; }

/** access(record, opts) -> 'skill' (has the Skill tool), 'read' (an agent file without it) or 'either' (unknown).
 *  A file-less agent (general-purpose) and an agent file without a `tools:` line inherit every tool, Skill included. */
function access(record, opts, fileLess) {
  try {
    if (fileLess) return 'skill';
    const info = SM.agentFileInfo(rootOf(opts), record.agent_type, opts);
    if (!info.found) return 'either';
    return info.tools === null || info.tools.includes('Skill') ? 'skill' : 'read';
  } catch { return 'either'; }
}

const WORDING = {
  skill: ['EN: Open each listed skill FIRST, before other work: call the Skill tool with its name. In your final report, name which of these skills you actually used.',
    'NL: Open elke genoemde skill EERST, voor ander werk: roep de Skill-tool aan met de naam. Noem in je eindrapport welke van deze skills je echt gebruikt hebt.'],
  read: ['EN: Open each listed skill FIRST, before other work: Read the SKILL.md at the path above. In your final report, name which of these skills you actually used.',
    'NL: Open elke genoemde skill EERST, voor ander werk: lees de SKILL.md op het pad hierboven. Noem in je eindrapport welke van deze skills je echt gebruikt hebt.'],
  either: ['EN: Open each assigned skill FIRST, before other work: Read its SKILL.md at the path above, or use the Skill tool. In your final report, name which of these skills you actually used.',
    'NL: Open elke toegewezen skill EERST, voor ander werk: lees de SKILL.md op het pad hierboven, of gebruik de Skill-tool. Noem in je eindrapport welke van deze skills je echt gebruikt hebt.'],
};

/** fitList(skills, total, budget) -> list lines within `budget` characters (newlines included); when skills are left
 *  out (count cap or budget) the last line is "- (+N more in FORGE_DEFAULT_SKILLS.json and the run skill map)". */
function fitList(skills, total, budget) {
  const more = (n) => '- (+' + n + ' more in ' + DEFAULTS_POINTER + ' and the run skill map)';
  const lines = [];
  let used = 0;
  for (let i = 0; i < skills.length; i++) {
    const line = '- ' + skills[i].name + ' (' + skills[i].file + ')';
    const left = total - (i + 1);
    const tail = left > 0 ? more(left).length + 1 : 0;
    if (used + line.length + 1 + tail > budget) { lines.push(more(total - i)); return lines; }
    lines.push(line); used += line.length + 1;
  }
  if (total > skills.length) lines.push(more(total - skills.length));
  return lines;
}

/** skillContext(record, opts, budget) -> the additionalContext text (at most `budget`, default MAX_CONTEXT_CHARS), or
 *  null when nothing is assigned and the agent is not file-less. Never throws. */
function skillContext(record, opts, budget) {
  try {
    const max = Number.isFinite(budget) ? Math.min(budget, MAX_CONTEXT_CHARS) : MAX_CONTEXT_CHARS;
    if (!record || !record.run || max <= 0) return null;
    const got = assignedSkillsDetailed(record, opts);
    const root = rootOf(opts);
    const data = defaultsOf(root);
    const fileLess = !!(data && DS.roleOf(record.agent_type, data) === 'file-less');
    const conduct = fileLess && typeof data.conduct === 'string'
      ? SM.skillBody(root, data.conduct, Object.assign({}, opts, { maxChars: CONDUCT_MAX_CHARS })) : null;
    if (!got.skills.length && !conduct) return null;
    const parts = [];
    if (got.skills.length) {
      const head = got.provisional
        ? 'Forge category skills for this run (' + record.run + '); the Lead has not logged the skill map yet, so these come from forge-anticipate / de Lead heeft de skill-map nog niet gelogd, deze komen uit forge-anticipate:'
        : 'Forge skills assigned to you (' + record.agent_type + ') for run ' + record.run + ' / Forge-skills voor jou in deze run:';
      const words = WORDING[access(record, opts, fileLess)].join('\n');
      const conductText = conduct ? '\n\nForge house rules (forge-conduct); follow them for this whole task:\n' + conduct : '';
      const fixed = head.length + 1 + 1 + words.length + conductText.length;
      const list = fitList(got.skills, got.total, max - fixed);
      parts.push(head, list.join('\n'), words);
      let text = parts.join('\n') + conductText;
      if (text.length > max) text = text.slice(0, max);
      return text;
    }
    const text = 'Forge house rules (forge-conduct); follow them for this whole task:\n' + conduct;
    return text.length > max ? text.slice(0, max) : text;
  } catch { return null; }
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

/** hookOutput(result, opts, extra) -> the JSON string to print, or '' (nothing). The context is at most
 *  MAX_CONTEXT_CHARS: `extra` (the worktree warning) first, the skill text in what is left. Never throws. */
function hookOutput(result, opts, extra) {
  try {
    const first = typeof extra === 'string' && extra ? extra.slice(0, MAX_CONTEXT_CHARS) : null;
    const room = MAX_CONTEXT_CHARS - (first ? first.length + 2 : 0);
    const skills = result && result.record && room > 0 ? skillContext(result.record, opts, room) : null;
    const ctx = [first, skills].filter(Boolean).join('\n\n').slice(0, MAX_CONTEXT_CHARS);
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

module.exports = { run, cli, buildRecord, defaultsSha, assignedSkills, skillContext, hookOutput, foreignWorktreeWarning, fitList, FILE_NAME, ENV_FLAG, MAX_CONTEXT_CHARS, MAX_SKILLS };

if (require.main === module) SS.hookMain(cli);
