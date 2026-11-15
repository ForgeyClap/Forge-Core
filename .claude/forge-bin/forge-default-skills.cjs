#!/usr/bin/env node
'use strict';
/**
 * forge-default-skills.cjs — loader for FORGE_DEFAULT_SKILLS.json, the one source of default skills (SD-T1).
 *
 *   loadDefaults(root)          -> {ok, data, problems}   validates against the repo's own .claude/skills only
 *   roleOf(agentType, data)     -> Boss name | 'file-less' | null
 *   baselineFor(agentType, data)-> role skills (without the conduct skill)
 *   domainFor(agentType, data)  -> the agent's own domain skills (agent_domain; never inherited by a specialist)
 *   preloadFor(agentType, data) -> [conduct, ...baseline, ...domain], deduplicated in that order, at most max_preload
 *   LIMITS                      -> the five shipped limits
 *
 * Every function is total: junk input gives an empty or null answer, never a throw.
 * CLI: `node forge-default-skills.cjs [--root <dir>] [--json]` prints the validation result (exit 0 ok, 1 problems).
 */
const fs = require('fs');
const path = require('path');

const SOURCE_REL = path.join('.claude', 'config', 'orchestration', 'FORGE_DEFAULT_SKILLS.json');
const SCHEMA = 'forge-default-skills/v1';
const DEFAULT_CONDUCT = 'forge-conduct';
const LIMITS = Object.freeze({ max_baseline: 3, max_preload: 32, max_injection_chars: 10000, max_directive_chars: 300, conduct_max_lines: 80 });
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 'Build Boss' / 'BUILD_BOSS' / ' build-boss ' -> 'build-boss'. Non-strings -> ''. */
function normalizeAgent(agentType) {
  if (typeof agentType !== 'string') return '';
  return agentType.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function skillShips(root, name) {
  try { return fs.statSync(path.join(root, '.claude', 'skills', name, 'SKILL.md')).isFile(); } catch (e) { return false; }
}

function checkName(root, name, where, problems) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) { problems.push(where + ': invalid skill name ' + JSON.stringify(name)); return; }
  if (!skillShips(root, name)) problems.push(where + ': skill "' + name + '" does not ship (no .claude/skills/' + name + '/SKILL.md)');
}

function checkList(root, list, where, problems) {
  if (!Array.isArray(list)) { problems.push(where + ': must be a list'); return; }
  list.forEach((n, i) => checkName(root, n, where + '[' + i + ']', problems));
}

function validate(root, data) {
  const problems = [];
  if (data.schema !== SCHEMA) problems.push('schema must be "' + SCHEMA + '"');
  checkName(root, data.conduct, 'conduct', problems);
  const limits = isObj(data.limits) ? data.limits : {};
  for (const k of Object.keys(LIMITS)) {
    if (limits[k] !== LIMITS[k]) problems.push('limits.' + k + ' must be ' + LIMITS[k]);
  }
  const baseline = isObj(data.role_baseline) ? data.role_baseline : null;
  if (!baseline) problems.push('role_baseline must be an object');
  for (const [role, list] of Object.entries(baseline || {})) {
    checkList(root, list, 'role_baseline.' + role, problems);
    if (Array.isArray(list) && list.length > LIMITS.max_baseline) problems.push('role_baseline.' + role + ': ' + list.length + ' skills, at most ' + LIMITS.max_baseline);
    if (Array.isArray(list) && list.includes(data.conduct)) problems.push('role_baseline.' + role + ': names the conduct skill, which every agent already preloads');
  }
  const specialists = isObj(data.specialists) ? data.specialists : {};
  if (data.specialists !== undefined && !isObj(data.specialists)) problems.push('specialists must be an object');
  for (const [spec, boss] of Object.entries(specialists)) {
    if (!baseline || typeof boss !== 'string' || !Object.prototype.hasOwnProperty.call(baseline, boss)) problems.push('specialists.' + spec + ': maps to "' + boss + '", which has no role_baseline');
  }
  const extra = isObj(data.specialist_extra) ? data.specialist_extra : {};
  for (const [spec, list] of Object.entries(extra)) {
    checkList(root, list, 'specialist_extra.' + spec, problems);
    if (!Object.prototype.hasOwnProperty.call(specialists, spec)) problems.push('specialist_extra.' + spec + ': not a declared specialist');
  }
  if (data.agent_domain !== undefined && !isObj(data.agent_domain)) problems.push('agent_domain must be an object');
  const domain = isObj(data.agent_domain) ? data.agent_domain : {};
  for (const [agent, list] of Object.entries(domain)) {
    checkList(root, list, 'agent_domain.' + agent, problems);
    const known = (baseline && Object.prototype.hasOwnProperty.call(baseline, agent)) || Object.prototype.hasOwnProperty.call(specialists, agent);
    if (!known) problems.push('agent_domain.' + agent + ': not a known agent (no role_baseline or specialists entry)');
    const total = new Set([data.conduct].concat(baselineFor(agent, data), domainFor(agent, data))).size;
    if (total > LIMITS.max_preload) problems.push('agent_domain.' + agent + ': ' + agent + ' would preload ' + total + ' skills, at most ' + LIMITS.max_preload);
  }
  for (const key of ['file_less', 'global_agents']) {
    if (!Array.isArray(data[key]) || data[key].some((v) => typeof v !== 'string' || !v)) problems.push(key + ' must be a list of agent names');
  }
  const moments = isObj(data.moments) ? data.moments : null;
  if (!moments) problems.push('moments must be an object');
  for (const [m, def] of Object.entries(moments || {})) {
    if (!isObj(def)) { problems.push('moments.' + m + ': must be {skill, directive}'); continue; }
    checkName(root, def.skill, 'moments.' + m + '.skill', problems);
    if (typeof def.directive !== 'string' || !def.directive.trim()) problems.push('moments.' + m + ': directive missing');
    else if (def.directive.length > LIMITS.max_directive_chars) problems.push('moments.' + m + ': directive is ' + def.directive.length + ' chars, at most ' + LIMITS.max_directive_chars);
  }
  return problems;
}

function loadDefaults(root) {
  if (typeof root !== 'string' || !root) return { ok: false, data: null, problems: ['root must be a directory path'] };
  const file = path.join(root, SOURCE_REL);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, data: null, problems: ['cannot read ' + SOURCE_REL + ': ' + (e && e.message || e)] };
  }
  if (!isObj(data)) return { ok: false, data: null, problems: [SOURCE_REL + ' must hold a JSON object'] };
  const problems = validate(root, data);
  return { ok: problems.length === 0, data, problems };
}

function roleOf(agentType, data) {
  const a = normalizeAgent(agentType);
  if (!a || !isObj(data)) return null;
  if (isObj(data.role_baseline) && Object.prototype.hasOwnProperty.call(data.role_baseline, a)) return a;
  if (isObj(data.specialists) && typeof data.specialists[a] === 'string') return data.specialists[a];
  if (Array.isArray(data.file_less) && data.file_less.includes(a)) return 'file-less';
  return null;
}

function baselineFor(agentType, data) {
  const role = roleOf(agentType, data);
  if (!role || role === 'file-less') return [];
  const out = [];
  const add = (list) => { if (Array.isArray(list)) for (const s of list) if (typeof s === 'string' && s && s !== data.conduct && !out.includes(s)) out.push(s); };
  add(data.role_baseline && data.role_baseline[role]);
  add(isObj(data.specialist_extra) ? data.specialist_extra[normalizeAgent(agentType)] : null);
  return out;
}

function domainFor(agentType, data) {
  const a = normalizeAgent(agentType);
  if (!a || !isObj(data) || !isObj(data.agent_domain) || !Object.prototype.hasOwnProperty.call(data.agent_domain, a)) return [];
  const list = data.agent_domain[a];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) if (typeof s === 'string' && s && !out.includes(s)) out.push(s);
  return out;
}

function preloadFor(agentType, data) {
  const conduct = isObj(data) && typeof data.conduct === 'string' && data.conduct ? data.conduct : DEFAULT_CONDUCT;
  const out = [conduct];
  for (const s of baselineFor(agentType, data).concat(domainFor(agentType, data))) if (!out.includes(s)) out.push(s);
  return out.slice(0, LIMITS.max_preload);
}

module.exports = { loadDefaults, roleOf, baselineFor, domainFor, preloadFor, normalizeAgent, LIMITS, SOURCE_REL, SCHEMA };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.resolve(__dirname, '..', '..');
  const r = loadDefaults(root);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: r.ok, problems: r.problems }, null, 2) + '\n');
  else process.stdout.write(r.ok ? 'default-skills: ok\n' : 'default-skills: ' + r.problems.length + ' problem(s)\n' + r.problems.map((p) => '  - ' + p).join('\n') + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
