#!/usr/bin/env node
'use strict';
/**
 * forge-pack.cjs — the generic agent-pack check (owner request R-0239: agents for every project type, not only Roblox).
 * Zero dependencies.
 *
 * A pack is .claude/config/packs/<name>.json (schema forge-pack/v1): its specialist agents, the skills they need, the
 * playbook skill, the router signals and the lane presets <name>-all and process (expanded by forge-lane-skills.cjs).
 *
 *   loadPacks(root)            -> [{name, rel, pack, error}] for every pack file, sorted by name
 *   loadPackFile(root, name, {coreOnly}) -> {name, rel, pack, error}   error: null | 'missing' | 'unreadable (...)' | 'invalid: ...'
 *   packCheck(root, {devTree, pack, coreOnly}) -> {ok, applicable, packs:[{name, ok, problems, agents, skills}], problems}
 *     red per pack when: the pack file is broken; an agent has no agent file, a name that differs, no model or effort,
 *     no default route in FORGE_MODEL_ROUTING.json (unrouted), a route that is not a GOAT route, a frontmatter
 *     model/effort that differs from that route, no specialistAgents row, or a row among the 12 permanent Bosses; a pack
 *     or preset skill does not ship under .claude/skills; forge-router has no table row naming the pack (its name or a
 *     signal) together with one of its agents (a name or <prefix>-*). Not coreOnly, also red when: an agent description
 *     is over 160 characters, the playbook skill does not ship, or an agent is listed in two packs.
 *     coreOnly keeps the checks forge-roblox-pack.cjs had before packs were generic (its wrapper uses it): no name
 *     check in the pack file, and the old router test (a table row naming the pack, later on the same row <prefix>-,
 *     the prefix taken from the pack's agents; the old check hard-coded rbx-, the prefix of every Roblox pack agent).
 *     No pack files (or, with pack, no such file): red only in a development tree that carries the agent registry (a
 *     template); a project from before packs, or a tree without the registry, is n/a.
 *
 * CLI: node forge-pack.cjs [--root <dir>] [--json] [--pack <name>]   exit 0 = ok or n/a, 1 = red, 2 = usage
 */
const fs = require('fs');
const path = require('path');

const PACKS_DIR_REL = '.claude/config/packs';
const ROUTING_REL = '.claude/FORGE_MODEL_ROUTING.json';
const REGISTRY_REL = '.claude/config/agents/agent-registry.json';
const ROUTER_REL = '.claude/skills/forge-router/SKILL.md';
const EXTERNAL_PREFIX = 'mcp:'; // a plugin or MCP skill outside .claude/skills (never required to ship)
const MAX_DESCRIPTION = 160;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const packRel = (name) => PACKS_DIR_REL + '/' + name + '.json';
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function readJson(root, rel) {
  try { return { data: JSON.parse(fs.readFileSync(abs(root, rel), 'utf8').replace(/^﻿/, '')), error: null }; }
  catch (e) { return { data: null, error: e && e.code === 'ENOENT' ? 'missing' : 'unreadable (' + String((e && e.message) || e).split('\n')[0].slice(0, 120) + ')' }; }
}
function frontmatter(text) {
  const m = String(text).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) { const mm = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim().replace(/^"(.*)"$/, '$1'); }
  return fm;
}
const skillShips = (root, name) => fs.existsSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'));

function loadPackFile(root, name, opts) {
  const rel = packRel(name);
  const r = readJson(root, rel);
  if (r.error) return { name, rel, pack: null, error: r.error };
  const p = r.data;
  const bad = [];
  if (!p || typeof p !== 'object') bad.push('not an object');
  else {
    if (p.schema !== 'forge-pack/v1') bad.push('schema must be forge-pack/v1');
    if (!(opts && opts.coreOnly) && p.name !== undefined && p.name !== name) bad.push('name must equal the file name (' + name + ')');
    if (!Array.isArray(p.agents) || !p.agents.length) bad.push('agents must be a non-empty list');
    if (!Array.isArray(p.skills) || !p.skills.length) bad.push('skills must be a non-empty list');
    if (!p.presets || typeof p.presets !== 'object' || !Array.isArray(p.presets[name + '-all']) || !Array.isArray(p.presets.process)) bad.push('presets must hold the ' + name + '-all and process lists');
  }
  return bad.length ? { name, rel, pack: null, error: 'invalid: ' + bad.join('; ') } : { name, rel, pack: p, error: null };
}

function loadPacks(root) {
  let files = [];
  try { files = fs.readdirSync(abs(root, PACKS_DIR_REL)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return files.map((f) => loadPackFile(root, f.slice(0, -5)));
}

// The router row: a markdown table line that names the pack (its name or a signal) and one of its agents.
function routerRow(router, name, pack) {
  const words = [name, ...(Array.isArray(pack.signals) ? pack.signals : [])].filter((s) => typeof s === 'string' && s.trim());
  const wordRe = new RegExp(words.map((s) => (/^\w/.test(s) ? '\\b' : '') + escRe(s.trim()) + (/\w$/.test(s.trim()) ? '\\b' : '')).join('|'), 'i');
  const prefixes = [...new Set(pack.agents.map((a) => String(a).split('-')[0] + '-*'))];
  const tokens = [...pack.agents.map(String), ...prefixes];
  return String(router).split(/\r?\n/).some((line) => line.startsWith('|') && wordRe.test(line) && tokens.some((tk) => line.includes(tk)));
}
// The pre-generic router test (coreOnly): the pack name, then later on the same table row one agent prefix and '-'.
function legacyRouterRow(router, name, pack) {
  const prefixes = [...new Set(pack.agents.map((a) => String(a).split('-')[0]))];
  return new RegExp('^\\|[^\\n]*\\b' + escRe(name) + '\\b[^\\n]*(?:' + prefixes.map((p) => escRe(p) + '-').join('|') + ')', 'im').test(String(router));
}
function agentsHint(agents) {
  const count = {};
  for (const a of agents) { const p = String(a).split('-')[0]; count[p] = (count[p] || 0) + 1; }
  const [top, n] = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
  return n >= 2 ? top + '-* agents' : agents.join(', ');
}

function checkPack(root, entry, ctx, coreOnly) {
  const { name, pack } = entry;
  const problems = [];
  for (const a of pack.agents) {
    const file = path.join(root, '.claude', 'agents', a + '.md');
    if (!fs.existsSync(file)) { problems.push('agent ' + a + ': agent file missing (.claude/agents/' + a + '.md)'); continue; }
    const fm = frontmatter(fs.readFileSync(file, 'utf8'));
    if (!fm) { problems.push('agent ' + a + ': no frontmatter'); continue; }
    if (fm.name !== a) problems.push('agent ' + a + ': frontmatter name is "' + fm.name + '"');
    if (!fm.model || !fm.effort) problems.push('agent ' + a + ': frontmatter needs both model and effort (GOAT)');
    const route = ctx.defaults[a];
    if (!route) problems.push('agent ' + a + ': unrouted (no agentDefaults entry in FORGE_MODEL_ROUTING.json)');
    else if (!ctx.routes[route]) problems.push('agent ' + a + ': default route "' + route + '" is not a GOAT route');
    else if (fm.model && fm.effort && (ctx.routes[route].model !== fm.model || ctx.routes[route].effort !== fm.effort)) {
      problems.push('agent ' + a + ': frontmatter ' + fm.model + '/' + fm.effort + ' differs from its default route ' + route + ' (' + ctx.routes[route].model + '/' + ctx.routes[route].effort + ')');
    }
    if (Object.prototype.hasOwnProperty.call(ctx.bosses, a)) problems.push('agent ' + a + ': listed as a permanent Boss; pack agents are specialists only');
    if (!Object.prototype.hasOwnProperty.call(ctx.specialists, a)) problems.push('agent ' + a + ': not a specialist in agent-registry.json specialistAgents');
    if (coreOnly) continue;
    const desc = fm.description || '';
    if (desc.length > MAX_DESCRIPTION) problems.push('agent ' + a + ': description is ' + desc.length + ' characters (at most ' + MAX_DESCRIPTION + ')');
    for (const other of ctx.owners[a] || []) if (other !== name) problems.push('agent ' + a + ': also in pack ' + other + ' (an agent belongs to one pack)');
  }
  for (const s of pack.skills) if (!skillShips(root, s)) problems.push('skill ' + s + ': missing (.claude/skills/' + s + '/SKILL.md)');
  for (const [preset, list] of Object.entries(pack.presets)) {
    if (!Array.isArray(list)) continue;
    for (const s of list) if (typeof s === 'string' && !s.startsWith(EXTERNAL_PREFIX) && !skillShips(root, s)) problems.push('preset ' + preset + ': ' + s + ' is not a shipped skill');
  }
  if (!coreOnly && typeof pack.playbook === 'string' && !skillShips(root, pack.playbook)) problems.push('playbook ' + pack.playbook + ': not a shipped skill (.claude/skills/' + pack.playbook + '/SKILL.md)');
  if (coreOnly ? !legacyRouterRow(ctx.router, name, pack) : !routerRow(ctx.router, name, pack)) {
    const hint = coreOnly ? [...new Set(pack.agents.map((a) => String(a).split('-')[0] + '-*'))].join(', ') + ' agents' : agentsHint(pack.agents);
    problems.push('router: forge-router has no intent-map row that sends ' + cap(name) + ' work to the pack (' + hint + ')');
  }
  return { name, ok: problems.length === 0, problems, agents: pack.agents.length, skills: pack.skills.length };
}

function packCheck(root, opts) {
  const o = opts || {};
  // No packs is red only in a development tree that is a template (it carries the agent registry the pack agents are
  // registered in); a project from before packs, or a minimal test tree, is n/a.
  const template = !!o.devTree && fs.existsSync(abs(root, REGISTRY_REL));
  const all = loadPacks(root);
  let entries = all;
  if (o.pack) {
    const one = loadPackFile(root, o.pack, { coreOnly: !!o.coreOnly });
    if (one.error === 'missing' && !template) return { ok: true, applicable: false, packs: [], problems: [], reason: 'no ' + one.rel + ' (an install from before the ' + cap(o.pack) + ' pack)' };
    entries = [one];
  } else if (!all.length) {
    if (!template) return { ok: true, applicable: false, packs: [], problems: [], reason: 'no pack files in ' + PACKS_DIR_REL + ' (an install from before packs)' };
    return { ok: false, applicable: true, packs: [], problems: ['no pack files in ' + PACKS_DIR_REL + ' (the development tree ships its packs)'] };
  }
  const routing = readJson(root, ROUTING_REL).data || {};
  const registry = readJson(root, REGISTRY_REL).data || {};
  let router = '';
  try { router = fs.readFileSync(abs(root, ROUTER_REL), 'utf8'); } catch { /* a missing router turns every pack's router check red */ }
  const owners = {};
  for (const e of all) if (e.pack) for (const a of new Set(e.pack.agents)) (owners[a] = owners[a] || []).push(e.name);
  const ctx = { routes: routing.routes || {}, defaults: routing.agentDefaults || {}, bosses: registry.agents || {}, specialists: registry.specialistAgents || {}, router, owners };
  const packs = entries.map((e) => (e.pack ? checkPack(root, e, ctx, !!o.coreOnly) : { name: e.name, ok: false, problems: ['pack file ' + e.rel + ' ' + e.error], agents: 0, skills: 0 }));
  const problems = packs.flatMap((p) => p.problems.map((x) => 'pack ' + p.name + ': ' + x));
  return { ok: problems.length === 0, applicable: true, packs, problems };
}

const USAGE = 'usage: node forge-pack.cjs [--root <dir>] [--json] [--pack <name>]';
function main(argv) {
  let root = process.cwd(), pack = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--root' && argv[i + 1]) root = argv[++i];
    else if (a === '--pack' && argv[i + 1] && NAME_RE.test(argv[i + 1])) pack = argv[++i];
    else { console.error(USAGE); return 2; }
  }
  root = path.resolve(root);
  const devTree = fs.existsSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'));
  const r = packCheck(root, { devTree, pack });
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (!r.applicable) console.log('packs: n/a (' + r.reason + ')');
  else {
    const lines = ['packs: ' + (r.ok ? 'OK' : 'RED') + ' (' + r.packs.length + ' packs)'];
    if (!r.packs.length) lines.push(...r.problems.map((p) => '  ' + p));
    for (const p of r.packs) lines.push('  ' + p.name + ': ' + (p.ok ? 'OK' : 'RED') + ' (' + p.agents + ' agents, ' + p.skills + ' skills)', ...p.problems.map((x) => '    ' + x));
    console.log(lines.join('\n'));
  }
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { PACKS_DIR_REL, MAX_DESCRIPTION, packRel, loadPackFile, loadPacks, packCheck, main };
