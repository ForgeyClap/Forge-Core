#!/usr/bin/env node
'use strict';
/**
 * forge-agent-skills-sync.cjs — keeps every agent file's `skills:` and its `Skill` tool in sync with
 * FORGE_DEFAULT_SKILLS.json (SD-T3).
 *
 *   planAgentEdits(root, data, policy) -> [{file, agent, skillsBefore, skillsAfter, toolsBefore, toolsAfter, exec,
 *                                           bodyChanged, changed}]  (pure; changed = skills, tools or the marked block)
 *   applyAgentEdits(root, plan)        -> {written: string[]}
 *   isExecClass(agentName, policy)     -> true for the full-build and exec-reviewer classes only
 *
 * Rules: `skills:` becomes exactly preloadFor(agent), as a YAML block list; `Skill` is in `tools:` only for exec-class
 * agents (a skill can register hooks once invoked, so an agent barred from commands never gets it). The body holds ONE
 * generated paragraph between <!-- forge-skills:begin --> and <!-- forge-skills:end --> (preloads + Skill access line);
 * every other frontmatter line and everything outside the markers stay byte-identical. A body without markers is
 * migrated once (the old "Preloaded at startup" paragraph becomes the block plus its on-demand list, word for word).
 * agent-skill-map.json gets every preload listed for its agent (names appended, never dropped). CRLF files keep CRLF.
 * agent-tool-policy.json gets the same Skill grants, and the read-only-audit / write-no-exec classes list Skill under
 * forbidden.
 * --global writes the global_agents under <home>/.claude/agents (conduct first, existing preloads kept; Skill only
 * when an explicit tools line holds Bash) and copies .claude/skills/<conduct>/ to <home>/.claude/skills/. A missing
 * global agent file is a SKIP and is never created.
 *
 * CLI: node forge-agent-skills-sync.cjs --check | --write [--root <dir>] [--global [--home <dir>]] [--json]
 * Exit: 0 = in sync or written, 1 = drift on --check, 2 = usage or load error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const DS = require('./forge-default-skills.cjs');

const SKILL_TOOL = 'Skill';
const EXEC_CLASSES = Object.freeze(['full-build', 'exec-reviewer']);
const NO_EXEC_CLASSES = Object.freeze(['read-only-audit', 'write-no-exec']);
const POLICY_REL = path.join('.claude', 'config', 'agents', 'agent-tool-policy.json');
const AGENTS_REL = path.join('.claude', 'agents');
const SKILL_MAP_REL = path.join('.claude', 'config', 'agents', 'agent-skill-map.json');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function isExecClass(agentName, policy) {
  if (!isObj(policy) || !isObj(policy.agents) || typeof agentName !== 'string') return false;
  const e = Object.prototype.hasOwnProperty.call(policy.agents, agentName) ? policy.agents[agentName] : null;
  return isObj(e) && EXEC_CLASSES.includes(e.class);
}

// ---- frontmatter text surgery (only the tools and skills keys are touched) ----------------------------------------

/** splitDoc(text) -> {lines, rest} | null. lines = the frontmatter lines between the two --- markers. */
function splitDoc(text) {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(String(text));
  if (!m) return null;
  return { lines: m[1].split('\n'), rest: String(text).slice(m[0].length - m[2].length) };
}

/** The [start, end) line range of a top-level key, including its block-list items. -1 when absent. */
function keyRange(lines, key) {
  const re = new RegExp('^' + key + ':(.*)$');
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return { start: -1, end: -1 };
  let j = i + 1;
  if (re.exec(lines[i])[1].trim() === '') while (j < lines.length && /^\s+(-\s|-$)/.test(lines[j])) j++;
  return { start: i, end: j };
}

function readList(lines, key) {
  const r = keyRange(lines, key);
  if (r.start < 0) return null;
  const raw = new RegExp('^' + key + ':(.*)$').exec(lines[r.start])[1].trim();
  if (raw === '') return lines.slice(r.start + 1, r.end).map((l) => l.replace(/^\s+-\s*/, '').trim()).filter(Boolean);
  const inner = /^\[(.*)\]$/.test(raw) ? raw.slice(1, -1) : raw;
  return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function readAgentText(text) {
  const doc = splitDoc(text);
  if (!doc) return null;
  return { skills: readList(doc.lines, 'skills') || [], tools: readList(doc.lines, 'tools') };
}

/** rewrite(text, skills, tools) -> new text. tools === null leaves the tools line as it is (or absent). */
function rewrite(text, skills, tools) {
  const doc = splitDoc(text);
  if (!doc) return text;
  let lines = doc.lines.slice();
  if (tools !== null) {
    const r = keyRange(lines, 'tools');
    const line = 'tools: ' + tools.join(', ');
    lines = r.start < 0 ? lines.concat([line]) : lines.slice(0, r.start).concat([line], lines.slice(r.end));
  }
  const s = keyRange(lines, 'skills');
  const block = skills.length ? ['skills:'].concat(skills.map((n) => '  - ' + n)) : [];
  lines = s.start < 0 ? lines.concat(block) : lines.slice(0, s.start).concat(block, lines.slice(s.end));
  return '---\n' + lines.join('\n') + '\n---' + doc.rest;
}

function withSkill(tools, wanted) {
  if (tools === null) return null;
  const base = tools.filter((t) => t !== SKILL_TOOL);
  return wanted ? base.concat([SKILL_TOOL]) : base;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- line endings: parse as LF, write back in the file's own style ------------------------------------------------

const isCrlf = (text) => String(text).includes('\r\n');
const toLf = (text) => String(text).replace(/\r\n/g, '\n');
const restoreEol = (text, crlf) => (crlf ? text.replace(/\n/g, '\r\n') : text);

// ---- the one generated body paragraph (between the markers; everything outside stays byte-identical) --------------

const BLOCK_BEGIN = '<!-- forge-skills:begin -->';
const BLOCK_END = '<!-- forge-skills:end -->';
const BLOCK_NOTE = '<!-- Generated by forge-agent-skills-sync.cjs from FORGE_DEFAULT_SKILLS.json: edit the source, not this text. -->';
const READ_PATHS = 'Read `.claude/skills/<name>/SKILL.md` (else `~/.claude/skills/<name>/SKILL.md`; if neither exists, say so and go on without it).';
const STALE_RE = /^Preloaded at startup from the `skills:` frontmatter.*$/m;

function skillsBlock(skills, exec) {
  const access = exec
    ? 'You have the Skill tool: call it by name for any other skill that fits; if it is unavailable, ' + READ_PATHS
    : 'You have no Skill tool: when another skill fits, ' + READ_PATHS;
  return [BLOCK_BEGIN, BLOCK_NOTE,
    'Preloaded at startup from the `skills:` frontmatter (their full SKILL.md text is already in your context): ' + skills.join(', ') + '. ' + access,
    BLOCK_END].join('\n');
}

/** syncBody(body, skills, exec) -> body (LF) with the marked block regenerated, or migrated in once. */
function syncBody(body, skills, exec) {
  const b = String(body);
  const block = skillsBlock(skills, exec);
  const i = b.indexOf(BLOCK_BEGIN);
  const j = i < 0 ? -1 : b.indexOf(BLOCK_END, i);
  if (i >= 0 && j >= 0) return b.slice(0, i) + block + b.slice(j + BLOCK_END.length);
  const stale = STALE_RE.exec(b);
  if (stale) {
    // One-time migration: the stale paragraph becomes the block plus the agent's own on-demand list, word for word.
    const od = /say so and go on without it\): (.+)$/.exec(stale[0]);
    const tail = od ? '\nOn demand, when relevant: ' + od[1] : '';
    return b.slice(0, stale.index) + block + tail + b.slice(stale.index + stale[0].length);
  }
  const you = /^You are /m.exec(b);
  const from = you ? you.index : 0;
  const h = /^## /m.exec(b.slice(from));
  if (!h) return b.replace(/\n*$/, '') + '\n\n## Core skills\n\n' + block + '\n';
  const at = from + h.index;
  return b.slice(0, at) + '## Core skills\n\n' + block + '\n\n' + b.slice(at);
}

// ---- project agents -----------------------------------------------------------------------------------------------

function listAgentFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch (e) { return []; }
}

/** nextAgentText(text, skills, tools, exec) -> the full new text (LF), frontmatter and marked block synced. */
function nextAgentText(text, skills, tools, exec) {
  const fm = rewrite(text, skills, tools);
  const doc = splitDoc(fm);
  if (!doc) return fm;
  const head = fm.slice(0, fm.length - doc.rest.length);
  return head + syncBody(doc.rest, skills, exec);
}

function planAgentEdits(root, data, policy) {
  const dir = path.join(String(root || ''), AGENTS_REL);
  const out = [];
  for (const f of listAgentFiles(dir)) {
    const agent = f.slice(0, -3);
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    const text = toLf(raw);
    const cur = readAgentText(text);
    if (!cur) continue;
    const exec = isExecClass(agent, policy);
    const skillsAfter = DS.preloadFor(agent, data);
    const toolsAfter = withSkill(cur.tools, exec);
    const doc = splitDoc(text);
    const bodyChanged = syncBody(doc.rest, skillsAfter, exec) !== doc.rest;
    out.push({ file: path.join(AGENTS_REL, f).split(path.sep).join('/'), agent, skillsBefore: cur.skills, skillsAfter,
      toolsBefore: cur.tools, toolsAfter, exec, bodyChanged,
      changed: !same(cur.skills, skillsAfter) || !same(cur.tools, toolsAfter) || bodyChanged });
  }
  return out;
}

function applyAgentEdits(root, plan) {
  const written = [];
  for (const p of Array.isArray(plan) ? plan : []) {
    if (!p || !p.changed) continue;
    const file = path.join(String(root), p.file);
    const raw = fs.readFileSync(file, 'utf8');
    const next = restoreEol(nextAgentText(toLf(raw), p.skillsAfter, p.toolsAfter, !!p.exec), isCrlf(raw));
    if (next !== raw) { fs.writeFileSync(file, next); written.push(p.file); }
  }
  return { written };
}

// ---- agent-skill-map.json (legacy mirror): every preload is listed for its agent; names are only appended ---------

function planSkillMap(root, plan) {
  const file = path.join(String(root), SKILL_MAP_REL);
  let text; let map;
  try { text = fs.readFileSync(file, 'utf8'); map = JSON.parse(text); } catch (e) { return null; }
  if (!isObj(map) || !isObj(map.agents)) return null;
  const next = JSON.parse(JSON.stringify(map));
  const missing = [];
  for (const p of plan) {
    const list = Array.isArray(next.agents[p.agent]) ? next.agents[p.agent] : [];
    const add = p.skillsAfter.filter((s) => !list.includes(s));
    if (!add.length) continue;
    next.agents[p.agent] = list.concat(add);
    missing.push({ agent: p.agent, skills: add });
  }
  const nextText = restoreEol(JSON.stringify(next, null, 4) + '\n', isCrlf(text));
  return { file, rel: SKILL_MAP_REL.split(path.sep).join('/'), missing, text, nextText, changed: missing.length > 0 };
}

// ---- tool policy (format-preserving: 2-space indent, inline lists of plain values) ---------------------------------

function serialize(v, ind) {
  const pad = '  '.repeat(ind);
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return '[' + v.map((x) => JSON.stringify(x)).join(', ') + ']';
    return '[\n' + v.map((x) => pad + '  ' + serialize(x, ind + 1)).join(',\n') + '\n' + pad + ']';
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => pad + '  ' + JSON.stringify(k) + ': ' + serialize(v[k], ind + 1)).join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(v);
}

/** planPolicy(policy) -> a new policy object with the Skill grants and bans applied (input untouched). */
function planPolicy(policy) {
  const next = JSON.parse(JSON.stringify(policy));
  for (const [name, cls] of Object.entries(isObj(next.classes) ? next.classes : {})) {
    if (!isObj(cls)) continue;
    if (EXEC_CLASSES.includes(name) && Array.isArray(cls.tools)) cls.tools = withSkill(cls.tools, true);
    if (NO_EXEC_CLASSES.includes(name)) {
      if (Array.isArray(cls.tools)) cls.tools = withSkill(cls.tools, false);
      if (Array.isArray(cls.tools_base)) cls.tools_base = withSkill(cls.tools_base, false);
      cls.forbidden = withSkill(Array.isArray(cls.forbidden) ? cls.forbidden : [], true);
    }
  }
  for (const [name, e] of Object.entries(isObj(next.agents) ? next.agents : {})) {
    if (isObj(e) && Array.isArray(e.tools)) e.tools = withSkill(e.tools, isExecClass(name, policy));
  }
  return next;
}

// ---- global agents ------------------------------------------------------------------------------------------------

function listFilesRec(dir, base) {
  let out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of ents) {
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out = out.concat(listFilesRec(path.join(dir, ent.name), rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out.sort();
}

function planGlobal(root, home, data) {
  const conduct = data.conduct;
  const gdir = path.join(home, '.claude', 'agents');
  const agents = []; const skipped = [];
  for (const name of Array.isArray(data.global_agents) ? data.global_agents : []) {
    const file = path.join(gdir, name + '.md');
    let text;
    try { text = toLf(fs.readFileSync(file, 'utf8')); } catch (e) { skipped.push(name); continue; }
    const cur = readAgentText(text);
    if (!cur) { skipped.push(name); continue; }
    const skillsAfter = [conduct].concat(cur.skills.filter((s) => s !== conduct)).slice(0, DS.LIMITS.max_preload);
    const toolsAfter = cur.tools === null ? null : withSkill(cur.tools, cur.tools.includes('Bash'));
    agents.push({ file, agent: name, skillsBefore: cur.skills, skillsAfter, toolsBefore: cur.tools, toolsAfter,
      changed: !same(cur.skills, skillsAfter) || !same(cur.tools, toolsAfter) });
  }
  const src = path.join(root, '.claude', 'skills', conduct);
  const dst = path.join(home, '.claude', 'skills', conduct);
  const files = listFilesRec(src, '');
  const stale = files.filter((rel) => {
    try { return !fs.readFileSync(path.join(src, rel)).equals(fs.readFileSync(path.join(dst, rel))); } catch (e) { return true; }
  });
  return { agents, skipped, conduct: { src, dst, files, stale } };
}

function applyGlobal(g) {
  const written = [];
  for (const p of g.agents) {
    if (!p.changed) continue;
    const text = fs.readFileSync(p.file, 'utf8');
    const next = restoreEol(rewrite(toLf(text), p.skillsAfter, p.toolsAfter), isCrlf(text));
    if (next !== text) { fs.writeFileSync(p.file, next); written.push(p.file); }
  }
  for (const rel of g.conduct.stale) {
    const to = path.join(g.conduct.dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(g.conduct.src, rel), to);
    written.push(to);
  }
  return written;
}

// ---- CLI ----------------------------------------------------------------------------------------------------------

function argValue(argv, flag) { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; }

function run(argv) {
  const json = argv.includes('--json');
  const check = argv.includes('--check'); const write = argv.includes('--write');
  const say = (obj, text, code) => { process.stdout.write(json ? JSON.stringify(obj, null, 2) + '\n' : text + '\n'); return code; };
  if (check === write) return say({ ok: false, error: 'usage' }, 'usage: forge-agent-skills-sync.cjs --check | --write [--root <dir>] [--global [--home <dir>]] [--json]', 2);
  const root = path.resolve(argValue(argv, '--root') || path.resolve(__dirname, '..', '..'));
  const loaded = DS.loadDefaults(root);
  if (!loaded.ok) return say({ ok: false, error: 'load', problems: loaded.problems }, 'agent-skills-sync: cannot load the default-skills source:\n' + loaded.problems.map((p) => '  - ' + p).join('\n'), 2);
  let policy;
  try { policy = JSON.parse(fs.readFileSync(path.join(root, POLICY_REL), 'utf8')); } catch (e) {
    return say({ ok: false, error: 'load', problems: ['cannot read ' + POLICY_REL] }, 'agent-skills-sync: cannot read ' + POLICY_REL, 2);
  }
  if (!isObj(policy) || !isObj(policy.agents)) return say({ ok: false, error: 'load', problems: [POLICY_REL + ' has no agents map'] }, 'agent-skills-sync: ' + POLICY_REL + ' has no agents map', 2);

  const plan = planAgentEdits(root, loaded.data, policy);
  const policyFile = POLICY_REL.split(path.sep).join('/');
  const policyText = fs.readFileSync(path.join(root, POLICY_REL), 'utf8');
  const policyNext = serialize(planPolicy(policy), 0) + '\n';
  const drift = plan.filter((p) => p.changed).map((p) => ({ file: p.file, skills: [p.skillsBefore, p.skillsAfter], tools: [p.toolsBefore, p.toolsAfter], body: p.bodyChanged }));
  if (policyNext !== policyText) drift.push({ file: policyFile });
  const sm = planSkillMap(root, plan);
  if (sm && sm.changed) drift.push({ file: sm.rel, missing: sm.missing });

  let g = null;
  if (argv.includes('--global')) {
    const home = path.resolve(argValue(argv, '--home') || os.homedir());
    g = planGlobal(root, home, loaded.data);
    for (const p of g.agents) if (p.changed) drift.push({ file: p.file, skills: [p.skillsBefore, p.skillsAfter], tools: [p.toolsBefore, p.toolsAfter] });
    for (const rel of g.conduct.stale) drift.push({ file: path.join(g.conduct.dst, rel) });
  }
  const globalInfo = g ? { skipped: g.skipped, checked: g.agents.map((p) => p.agent) } : null;
  const skipText = g && g.skipped.length ? '\n' + g.skipped.map((n) => '  SKIP global agent ' + n + ' (no file; not created)').join('\n') : '';

  if (check) {
    const ok = drift.length === 0;
    return say({ ok, mode: 'check', drift, global: globalInfo },
      ok ? 'agent-skills-sync: in sync (' + plan.length + ' agents)' + skipText
        : 'agent-skills-sync: drift in ' + drift.length + ' file(s); run --write\n' + drift.map((d) => '  - ' + d.file).join('\n') + skipText, ok ? 0 : 1);
  }
  const written = applyAgentEdits(root, plan).written;
  if (policyNext !== policyText) { fs.writeFileSync(path.join(root, POLICY_REL), policyNext); written.push(policyFile); }
  if (sm && sm.changed) { fs.writeFileSync(sm.file, sm.nextText); written.push(sm.rel); }
  if (g) written.push(...applyGlobal(g));
  return say({ ok: true, mode: 'write', written, global: globalInfo },
    'agent-skills-sync: wrote ' + written.length + ' file(s)' + (written.length ? '\n' + written.map((f) => '  - ' + f).join('\n') : '') + skipText, 0);
}

module.exports = { planAgentEdits, applyAgentEdits, isExecClass, planPolicy, planGlobal, planSkillMap, rewrite, readAgentText, syncBody, skillsBlock,
  serialize, EXEC_CLASSES, BLOCK_BEGIN, BLOCK_END };

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (e) {
    process.stderr.write('agent-skills-sync: ' + (e && e.message || e) + '\n');
    process.exitCode = 2;
  }
}
