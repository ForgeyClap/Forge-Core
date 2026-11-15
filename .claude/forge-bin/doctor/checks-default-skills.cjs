'use strict';
/**
 * doctor/checks-default-skills.cjs — SD-T9. Claude Code skips a preloaded skill with only a debug-log line
 * when it is missing, turned off in skillOverrides or marked disable-model-invocation, and on a listing overflow it
 * drops skill descriptions. This static check makes every one of those silent skips visible.
 *
 * defaultSkillsCheck(root, opts?) -> {ok, problems: string[], skipped: string[], checked: number, advisory: string[]}
 *   Red when: an agent file drifted from FORGE_DEFAULT_SKILLS.json; a preloaded skill has no SKILL.md, is marked
 *   disable-model-invocation: true, or is off ("off" or false) in skillOverrides; a skill preloaded by a no-exec agent
 *   has a hooks: key or a dynamic-command line (!`cmd`); an exec-class agent lacks the Skill tool or a no-exec agent
 *   has it; an agent preloads more than 32 skills; a role's SubagentStart injection is over 10,000 characters.
 *   Global GOAT agents (global_agents) absent under <home>/.claude/agents are SKIP; present ones must preload conduct.
 *   "name-only" or "on" overrides are never red; "name-only" on a preloaded skill gives an advisory line.
 *   A drift line names the part that drifted: skills, tools, the generated body block, or the agent-skill-map.json entry.
 *   Measured delivery (SD-T12c): over the last 10 runs, the SubagentStart lines whose defaults_sha is the sha of the
 *   current source are joined (by agent_id) to their SubagentStop lines. A project agent with at least one such start
 *   is red when a preloadFor(agent) skill shows up in none of its skills_preloaded or skills_opened; one without any is
 *   a SKIP ("not measured yet"); more than half of its measured stops with conduct_seen false is an advisory, never red.
 * listingBudgetCheck(root, opts?) -> {ok: true, advisory, estimateChars, budgetChars, budgetChars1m} (always advisory)
 *   Counts the skills in <root>/.claude/skills and <home>/.claude/skills (top-level <name>/SKILL.md; project wins on
 *   a name clash). Plugin skills are NOT counted, so the estimate is a lower bound. Each entry is
 *   min(len(description) + len(name), 1536); a skill off in skillOverrides is not listed, a name-only one counts its
 *   name only. Budget: 1% of the window (or skillListingBudgetFraction) at 4 characters per token, so 8,000 characters
 *   for 200,000 tokens and 40,000 for 1,000,000.
 *
 * opts.home (default os.homedir()), opts.runsRoot (default the project's runs folder; the hook lines are in
 * <runsRoot>/_hooks) and opts.settingsFiles (default <home>/.claude/settings.json,
 * <root>/.claude/settings.json, <root>/.claude/settings.local.json; later files win) are the test seams. Read-only:
 * it never writes a file, and every fix it names is a command or a settings key for the owner.
 * Registered in forge-doctor.cjs by the integrator.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const DS = require('../forge-default-skills.cjs');
const SYNC = require('../forge-agent-skills-sync.cjs');
const START = require('../forge-subagent-start.cjs');
const STOP = require('../forge-subagent-stop.cjs');
const USE = require('../forge-skill-use.cjs');
const { parseFrontmatter } = require('../forge-skilllint.cjs');

const POLICY_REL = path.join('.claude', 'config', 'agents', 'agent-tool-policy.json');
const FIX_SYNC = 'node .claude/forge-bin/forge-agent-skills-sync.cjs --write';
const FIX_GLOBAL = FIX_SYNC + ' --global';
const DOCTOR_RUN = '_doctor-default-skills';
const LISTING_ENTRY_MAX = 1536;
const CHARS_PER_TOKEN = 4;
const DEFAULT_FRACTION = 0.01;
const WINDOWS = Object.freeze([200000, 1000000]);
const NAMES_SHOWN = 20;
const MEASURE_RUNS = 10;
const RUNS_SHOWN = 5;
const FIX_MEASURED = 'check skillOverrides, the skill file, or run ' + FIX_SYNC;
const DYNAMIC_RE = /!`[^`\n]+`/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function homeOf(opts) {
  if (opts && typeof opts.home === 'string' && opts.home) return opts.home;
  try { return os.homedir(); } catch { return null; }
}

function settingsFilesOf(root, opts) {
  if (opts && Array.isArray(opts.settingsFiles)) return opts.settingsFiles.filter((f) => typeof f === 'string' && f);
  const home = homeOf(opts);
  return [home ? path.join(home, '.claude', 'settings.json') : null,
    path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')].filter(Boolean);
}

/** readSettings(files) -> {overrides: Map name -> {value, file}, fraction}. Junk or missing files are ignored. */
function readSettings(files) {
  const overrides = new Map();
  let fraction = null;
  for (const file of files) {
    let j;
    try { j = JSON.parse(String(readText(file))); } catch { continue; }
    if (!isObj(j)) continue;
    if (isObj(j.skillOverrides)) for (const [k, v] of Object.entries(j.skillOverrides)) overrides.set(k, { value: v, file });
    if (typeof j.skillListingBudgetFraction === 'number' && j.skillListingBudgetFraction > 0) fraction = j.skillListingBudgetFraction;
  }
  return { overrides, fraction };
}
const isOff = (o) => !!o && (o.value === false || (typeof o.value === 'string' && o.value.trim().toLowerCase() === 'off'));
const isNameOnly = (o) => !!o && typeof o.value === 'string' && o.value.trim().toLowerCase() === 'name-only';

/** skillInfo(dirs, name) -> {file, fm, text} | null: the first <dir>/<name>/SKILL.md that exists. */
function skillInfo(dirs, name) {
  for (const d of dirs) {
    if (!d) continue;
    const file = path.join(d, name, 'SKILL.md');
    const text = readText(file);
    if (text !== null) return { file, fm: parseFrontmatter(text), text };
  }
  return null;
}
const scalar = (fm, k) => (fm && fm.ok && fm.data[k] && fm.data[k].kind === 'scalar' ? String(fm.data[k].value) : '');

/** checkPreloads(agent, skills, ctx, noExec) -> problems for one agent's preload list. */
function checkPreloads(agent, skills, ctx, noExec) {
  const out = [];
  if (skills.length > DS.LIMITS.max_preload) out.push(agent + ': preloads ' + skills.length + ' skills, more than ' + DS.LIMITS.max_preload + '; trim its skills: list (fix: ' + ctx.fix + ')');
  for (const s of skills) {
    const info = skillInfo(ctx.skillDirs, s);
    if (!info) { out.push(agent + ': preloaded skill ' + s + ' has no SKILL.md (looked in ' + ctx.skillDirsLabel + '); it is skipped silently. Fix: add the skill or ' + ctx.fix); continue; }
    if (scalar(info.fm, 'disable-model-invocation').trim().toLowerCase() === 'true') out.push(agent + ': preloaded skill ' + s + ' has disable-model-invocation: true, so it is skipped silently. Fix: remove that line from ' + info.file + ' or drop the skill from the source');
    const o = ctx.overrides.get(s);
    if (isOff(o)) out.push(agent + ': preloaded skill ' + s + ' is off in skillOverrides (' + o.file + '), so it is skipped silently. Fix (owner): remove the key skillOverrides["' + s + '"] from that file or set it to "on"');
    else if (isNameOnly(o)) ctx.advisory.push(agent + ': preloaded skill ' + s + ' is "name-only" in skillOverrides (' + o.file + '); the preload still works, but the listing shows no description');
    if (noExec && info.fm.ok && Object.prototype.hasOwnProperty.call(info.fm.data, 'hooks')) out.push(agent + ': preloaded skill ' + s + ' has a hooks: key, but ' + agent + ' may not run commands. Fix: drop the skill from this role in FORGE_DEFAULT_SKILLS.json, then ' + FIX_SYNC);
    if (noExec) {
      const body = info.fm.ok ? info.fm.lines.slice(info.fm.bodyStart - 1).join('\n') : info.text;
      if (DYNAMIC_RE.test(body)) out.push(agent + ': preloaded skill ' + s + ' has a dynamic-command line (!`cmd`), but ' + agent + ' may not run commands. Fix: drop the skill from this role in FORGE_DEFAULT_SKILLS.json, then ' + FIX_SYNC);
    }
  }
  return out;
}

/** driftParts(entry, mapMissing) -> one phrase per part of this agent that is out of sync with the generator. */
function driftParts(e, mapMissing) {
  const parts = [];
  if (!same(e.skillsBefore, e.skillsAfter)) parts.push('skills ' + JSON.stringify(e.skillsBefore) + ', expected ' + JSON.stringify(e.skillsAfter));
  if (!same(e.toolsBefore, e.toolsAfter)) parts.push('tools ' + JSON.stringify(e.toolsBefore) + ', expected ' + JSON.stringify(e.toolsAfter));
  if (e.bodyChanged === true) parts.push('generated body block (between ' + SYNC.BLOCK_BEGIN + ' and ' + SYNC.BLOCK_END + ') is missing or out of date');
  if (mapMissing && mapMissing.length) parts.push('skill map: .claude/config/agents/agent-skill-map.json lacks ' + JSON.stringify(mapMissing));
  if (!parts.length && e.changed === true) parts.push('agent file text differs from what the generator writes');
  return parts;
}

/** checkProjectAgent(entry, ctx) -> problems for one project agent file. */
function checkProjectAgent(e, ctx) {
  const out = [];
  const parts = driftParts(e, ctx.mapMissing.get(e.agent));
  if (parts.length) out.push(e.agent + ': ' + e.file + ' drifted from FORGE_DEFAULT_SKILLS.json: ' + parts.join('; ') + '. Fix: ' + FIX_SYNC);
  const exec = SYNC.isExecClass(e.agent, ctx.policy);
  const tools = e.toolsBefore;
  const hasSkill = tools === null || tools.includes('Skill');
  if (exec && !hasSkill) out.push(e.agent + ': exec-class agent without the Skill tool in tools:, so it cannot call its skills. Fix: ' + FIX_SYNC);
  if (!exec && hasSkill) out.push(e.agent + ': no-exec agent ' + (tools === null ? 'without a tools: line inherits' : 'has') + ' the Skill tool; a skill can register hooks that run commands. Fix: ' + FIX_SYNC);
  return out.concat(checkPreloads(e.agent, e.skillsBefore || [], Object.assign({}, ctx, { fix: FIX_SYNC }), !exec));
}

/** checkInjection(agent, preloaded, ctx) -> a problem when the role's SubagentStart text is over the limit. */
function checkInjection(agent, preloaded, ctx) {
  const record = { run: DOCTOR_RUN, agent_type: agent, skills_preloaded: preloaded };
  const text = START.skillContext(record, { root: ctx.root, home: ctx.home }, Infinity);
  const len = typeof text === 'string' ? text.length : 0;
  // skillContext caps its text at the limit; a text AT the limit was hard-cut there, so it counts as over.
  return len >= DS.LIMITS.max_injection_chars
    ? [agent + ': SubagentStart injection reaches ' + len + ' characters (limit ' + DS.LIMITS.max_injection_chars + '), so its end is cut off. Fix: shorten the role baseline in FORGE_DEFAULT_SKILLS.json']
    : [];
}

function checkGlobal(ctx) {
  const problems = []; const skipped = []; let checked = 0;
  const conduct = ctx.data.conduct;
  const gdir = ctx.home ? path.join(ctx.home, '.claude', 'agents') : null;
  for (const name of Array.isArray(ctx.data.global_agents) ? ctx.data.global_agents : []) {
    const text = gdir ? readText(path.join(gdir, name + '.md')) : null;
    const cur = text === null ? null : SYNC.readAgentText(text);
    if (!cur) { skipped.push('global agent ' + name + ': no file under <home>/.claude/agents (SKIP; a public install has none)'); continue; }
    checked++;
    if (!cur.skills.includes(conduct)) problems.push(name + ' (global): does not preload ' + conduct + ' in skills:. Fix: ' + FIX_GLOBAL);
    const noExec = Array.isArray(cur.tools) && !cur.tools.includes('Bash') && !cur.tools.includes('PowerShell');
    const gctx = Object.assign({}, ctx, { fix: FIX_GLOBAL, skillDirs: [path.join(ctx.home, '.claude', 'skills')], skillDirsLabel: '<home>/.claude/skills' });
    problems.push(...checkPreloads(name + ' (global)', cur.skills, gctx, noExec));
  }
  return { problems, skipped, checked };
}

const agentKey = (t) => { const s = String(t || ''); return DS.normalizeAgent(s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s); };
const namesOf = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n) : []);

/** measuredDelivery(ctx, agents, runsRoot) -> {problems, skipped, advisory, measured}: preloadFor checked against what
 *  the SubagentStart/SubagentStop hook lines of the current source really show. Read-only, never throws on junk lines. */
function measuredDelivery(ctx, agents, runsRoot) {
  const out = { problems: [], skipped: [], advisory: [], measured: { sha: START.defaultsSha(ctx.root), runs: 0, starts: 0 } };
  const sha = out.measured.sha;
  if (!sha) { out.skipped.push('measured delivery: FORGE_DEFAULT_SKILLS.json has no readable sha, not measured'); return out; }
  const w = USE.hookWindow(ctx.root, { lastRuns: MEASURE_RUNS, hooksDir: path.join(runsRoot, STOP.HOOKS_DIRNAME) });
  const starts = w.starts.filter((l) => l.defaults_sha === sha);
  out.measured.runs = new Set(starts.map((l) => l.run)).size;
  out.measured.starts = starts.length;
  const byAgent = new Map();
  for (const l of starts) { const k = agentKey(l.agent_type); if (!byAgent.has(k)) byAgent.set(k, []); byAgent.get(k).push(l); }
  for (const agent of agents) {
    const mine = byAgent.get(agent) || [];
    if (!mine.length) { out.skipped.push(agent + ': measured delivery not measured yet (no SubagentStart line of the current source sha ' + sha + ' in the last ' + MEASURE_RUNS + ' runs)'); continue; }
    const ids = new Set(mine.map((l) => l.agent_id).filter((id) => typeof id === 'string' && id));
    const stops = w.stops.filter((l) => ids.has(l.agent_id));
    // FB-CONFIG-2-F4: only what the AGENT produced is evidence. skills_preloaded on the start line is the agent file's
    // own skills: list (copied by the start hook), so counting it made "never delivered" unable to fire.
    const delivered = new Set();
    for (const l of stops) namesOf(l.skills_opened).forEach((n) => delivered.add(n));
    if (stops.some((l) => l.conduct_seen === true)) delivered.add(ctx.data.conduct);
    const runs = [...new Set(mine.map((l) => l.run))];
    const runText = runs.slice(0, RUNS_SHOWN).join(', ') + (runs.length > RUNS_SHOWN ? ', +' + (runs.length - RUNS_SHOWN) + ' more' : '');
    for (const s of DS.preloadFor(agent, ctx.data)) {
      if (!delivered.has(s)) out.skipped.push(agent + ': ' + s + ' not measured (no skills_opened or conduct_seen evidence in ' + mine.length + ' measured starts, runs ' + runText + '; a preload itself cannot be seen from the hooks)');
    }
    // Stays advisory: the canary is read only from the agent's last TEXT turn, so a Workflow agent that
    // ends with a StructuredOutput tool call always reads false (measured: 117 of 117 stops false while the preload
    // was in the agent's context). Red only once forge-skillmap's canary read also covers that final tool call.
    const unseen = stops.filter((l) => l.conduct_seen === false).length;
    if (stops.length && unseen * 2 > stops.length) {
      out.advisory.push(agent + ': ' + unseen + ' of ' + stops.length + ' measured SubagentStop lines have conduct_seen false; the ' + ctx.data.conduct
        + ' preload may have failed silently, or the agent ignored its canary line');
    }
  }
  return out;
}

function defaultSkillsCheck(root, opts) {
  const r = path.resolve(String(root || '.'));
  const home = homeOf(opts);
  const advisory = [];
  const loaded = DS.loadDefaults(r);
  if (!loaded.data) return { ok: false, problems: loaded.problems.map((p) => 'source: ' + p), skipped: [], checked: 0, advisory };
  const problems = loaded.problems.map((p) => 'source: ' + p + ' (fix: edit .claude/config/orchestration/FORGE_DEFAULT_SKILLS.json)');
  let policy;
  try { policy = JSON.parse(fs.readFileSync(path.join(r, POLICY_REL), 'utf8')); } catch { policy = null; }
  if (!isObj(policy) || !isObj(policy.agents)) {
    problems.push('cannot read the agents map of ' + POLICY_REL.split(path.sep).join('/') + '; the Skill-tool rule cannot be checked');
    return { ok: false, problems, skipped: [], checked: 0, advisory };
  }
  const settings = readSettings(settingsFilesOf(r, opts));
  const ctx = { root: r, home, data: loaded.data, policy, overrides: settings.overrides, advisory,
    skillDirs: [path.join(r, '.claude', 'skills'), home ? path.join(home, '.claude', 'skills') : null],
    skillDirsLabel: '.claude/skills and <home>/.claude/skills' };
  const plan = SYNC.planAgentEdits(r, loaded.data, policy);
  const sm = SYNC.planSkillMap(r, plan);
  ctx.mapMissing = new Map(sm ? sm.missing.map((m) => [m.agent, m.skills]) : []);
  let checked = 0;
  for (const e of plan) {
    checked++;
    problems.push(...checkProjectAgent(e, ctx));
    problems.push(...checkInjection(e.agent, e.skillsBefore || [], ctx));
  }
  for (const agent of Array.isArray(loaded.data.file_less) ? loaded.data.file_less : []) {
    checked++;
    problems.push(...checkInjection(agent, [], ctx));
  }
  const g = checkGlobal(ctx);
  problems.push(...g.problems);
  const runsRoot = opts && typeof opts.runsRoot === 'string' && opts.runsRoot ? opts.runsRoot : STOP.runsDirOf(r);
  const m = measuredDelivery(ctx, plan.map((e) => e.agent), runsRoot);
  problems.push(...m.problems);
  advisory.push(...m.advisory);
  return { ok: problems.length === 0, problems, skipped: g.skipped.concat(m.skipped), checked: checked + g.checked, advisory, measured: m.measured };
}

// ---- listing budget -----------------------------------------------------------------------------------------------

function skillDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))).map((d) => d.name).sort();
  } catch { return []; }
}

/** listingEntries(root, home, overrides) -> [{name, chars}] in listing-priority order (declared defaults first). */
function listingEntries(root, home, overrides, data) {
  const seen = new Map();
  for (const dir of [path.join(root, '.claude', 'skills'), home ? path.join(home, '.claude', 'skills') : null]) {
    if (!dir) continue;
    for (const name of skillDirNames(dir)) {
      if (seen.has(name)) continue;
      const o = overrides.get(name);
      if (isOff(o)) continue;
      const fm = parseFrontmatter(readText(path.join(dir, name, 'SKILL.md')) || '');
      const listed = scalar(fm, 'name') || name;
      const chars = isNameOnly(o) ? listed.length : Math.min(scalar(fm, 'description').length + listed.length, LISTING_ENTRY_MAX);
      seen.set(name, { name, chars });
    }
  }
  const declared = new Set();
  if (isObj(data)) {
    declared.add(data.conduct);
    for (const list of Object.values(isObj(data.role_baseline) ? data.role_baseline : {})) if (Array.isArray(list)) list.forEach((s) => declared.add(s));
  }
  const all = [...seen.values()];
  return all.filter((e) => declared.has(e.name)).concat(all.filter((e) => !declared.has(e.name)));
}

function listingBudgetCheck(root, opts) {
  const r = path.resolve(String(root || '.'));
  const home = homeOf(opts);
  const settings = readSettings(settingsFilesOf(r, opts));
  const loaded = DS.loadDefaults(r);
  const entries = listingEntries(r, home, settings.overrides, loaded.data);
  const estimateChars = entries.reduce((n, e) => n + e.chars, 0);
  const fraction = settings.fraction || DEFAULT_FRACTION;
  const budgets = WINDOWS.map((w) => Math.round(w * fraction * CHARS_PER_TOKEN));
  const advisory = [];
  WINDOWS.forEach((w, i) => {
    if (estimateChars <= budgets[i]) return;
    let used = 0;
    const lost = entries.filter((e) => { used += e.chars; return used > budgets[i]; }).map((e) => e.name);
    advisory.push('skill listing estimate ' + estimateChars + ' chars is over the ' + budgets[i] + '-char budget of a ' + w + '-token window; '
      + lost.length + ' skill(s) would lose their description (estimate; Claude Code drops the least-invoked first): '
      + lost.slice(0, NAMES_SHOWN).join(', ') + (lost.length > NAMES_SHOWN ? ' (+' + (lost.length - NAMES_SHOWN) + ' more)' : '')
      + '. Owner fix: settings key skillListingBudgetFraction (for example 0.02), or "name-only" in skillOverrides for rarely used skills');
  });
  return { ok: true, advisory, estimateChars, budgetChars: budgets[0], budgetChars1m: budgets[1] };
}

module.exports = { defaultSkillsCheck, listingBudgetCheck };
