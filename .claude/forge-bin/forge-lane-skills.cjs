#!/usr/bin/env node
'use strict';
/**
 * forge-lane-skills.cjs — lane skill check (owner rules R-0070 and R-0093, generic Forge version of the lane check
 * an owner Roblox project used). A lane or Workflow agent must open every skill its prompt requires before the Lead
 * accepts its result. Zero dependencies; read-only.
 *
 *   node forge-lane-skills.cjs --workflow <wfDir> --require roblox-all,process [--presets <file>] [--skills-dir <dir>]
 *       every agent-*.jsonl transcript in <wfDir> must show each required skill; exit 1 + SKILLS-NOT-USED per agent.
 *   node forge-lane-skills.cjs <lanesDir> --check <lane> [--require a,b]
 *       one headless lane log <lanesDir>/<lane>.log (claude -p --output-format stream-json); the required list comes
 *       from --require or <lanesDir>/skills-required.json ({"<lane>": [...]}).
 *   node forge-lane-skills.cjs <lanesDir>      report every lane: tool calls, skills available, Skill calls.
 *
 * A required skill counts as opened when the transcript shows (1) a Skill tool call with that name (a plugin
 * namespace like `plugin:name` counts), (2) a Read of `.claude/skills/<name>/SKILL.md` (agents without the Skill
 * tool read the file), or (3) the skill's first body line that no other skill in the catalogue has (a frontmatter `skills:` preload or a start-of-agent
 * injection delivers the text without a call). Preset names expand from the presets of .claude/config/packs/*.json
 * (the Roblox pack: roblox-all, process, gamedev-extra) or from --presets <file> ({presets:{...}} or a flat map).
 * Exit: 0 ok, 1 SKILLS-NOT-USED or a missing lane log, 2 usage or an unreadable folder.
 */
const fs = require('fs');
const path = require('path');

const argAt = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** loadPresets(root, file?) -> {name: [skills]} from every .claude/config/packs/*.json, or from one file. */
function loadPresets(root, file) {
  const out = {};
  const take = (j) => { const p = j && typeof j === 'object' ? (j.presets && typeof j.presets === 'object' ? j.presets : j) : {}; for (const [k, v] of Object.entries(p)) if (Array.isArray(v)) out[k] = v.slice(); };
  if (file) { take(JSON.parse(fs.readFileSync(file, 'utf8'))); return out; }
  const dir = path.join(root, '.claude', 'config', 'packs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return out; }
  for (const f of names) { try { take(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* a broken pack file is the pack check's job */ } }
  return out;
}
/** expandRequired(list, presets) -> the names with every preset expanded, first occurrence kept. */
function expandRequired(list, presets) {
  const seen = new Set();
  for (const s of list) for (const n of (presets && Array.isArray(presets[s]) ? presets[s] : [s])) seen.add(n);
  return [...seen];
}
function bodyLinesOf(skillsDir, name) {
  try {
    const lines = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8').replace(/\r/g, '').split('\n');
    let seen = 0, i = 0;
    if (lines[0] === '---') { for (; i < lines.length && seen < 2; i++) if (lines[i] === '---') seen++; }
    return lines.slice(i).filter((x) => x.trim().length > 20 && !x.startsWith('#')).map((x) => x.trim());
  } catch { return []; }
}
// FB-LANES-F2: the probe is the first body line no other skill in the catalogue has, so a line many vendored skills share
// (a "Source:" provenance line, a self-improvement note) never proves that one particular skill was opened.
function catalogueOf(skillsDir) {
  const cat = new Map();
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch { /* no catalogue: no probes */ }
  for (const n of names) cat.set(n, bodyLinesOf(skillsDir, n));
  return cat;
}
function probeOf(skillsDir, name, cat) {
  cat = cat || catalogueOf(skillsDir);
  const own = cat.get(name) || bodyLinesOf(skillsDir, name);
  const others = new Set();
  for (const [n, ls] of cat) if (n !== name) for (const l of ls) others.add(l);
  return own.find((l) => !others.has(l)) || null;
}
const SKILL_READ_RE = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
/** openedIn(text) -> Set of skill names opened by a Skill call or a SKILL.md Read in one transcript or lane log. */
function openedIn(text) {
  const used = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const c = (o.message || o).content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x || x.type !== 'tool_use') continue;
      if (x.name === 'Skill') { const s = x.input && (x.input.skill || x.input.name); if (s) used.add(String(s)); }
      if (x.name === 'Read' && x.input && typeof x.input.file_path === 'string') { const m = x.input.file_path.match(SKILL_READ_RE); if (m) used.add(m[1]); }
    }
  }
  return used;
}
function missingIn(text, required, skillsDir, cat) {
  const used = [...openedIn(text)];
  if (skillsDir && !cat) cat = catalogueOf(skillsDir);
  return {
    opened: used,
    missing: required.filter((s) => {
      if (used.some((u) => u === s || u.endsWith(':' + s))) return false;
      const probe = skillsDir ? probeOf(skillsDir, s, cat) : null;
      return !(probe && (text.includes(probe) || text.includes(JSON.stringify(probe).slice(1, -1))));
    }),
  };
}
/** checkWorkflow(dir, required, {skillsDir}) -> {agents, bad:[{file, missing, opened}]} */
function checkWorkflow(dir, required, opts) {
  const skillsDir = (opts && opts.skillsDir) || null;
  const files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort();
  const bad = [];
  const cat = skillsDir ? catalogueOf(skillsDir) : null;
  for (const f of files) {
    const r = missingIn(fs.readFileSync(path.join(dir, f), 'utf8'), required, skillsDir, cat);
    if (r.missing.length) bad.push({ file: f, missing: r.missing, opened: r.opened });
  }
  return { agents: files.length, bad };
}

function main(argv) {
  const usage = 'usage: node forge-lane-skills.cjs --workflow <wfDir> --require <a,b|preset> [--presets <file>] [--skills-dir <dir>]\n'
    + '       node forge-lane-skills.cjs <lanesDir> [--check <lane>] [--require <a,b|preset>]';
  const root = process.cwd();
  let presets;
  try { presets = loadPresets(root, argAt(argv, '--presets')); } catch (e) { console.error('cannot read presets: ' + e.message); return 2; }
  const skillsDir = argAt(argv, '--skills-dir') || path.join(root, '.claude', 'skills');
  if (argv.includes('--workflow')) {
    const dir = argAt(argv, '--workflow');
    const req = expandRequired(splitList(argAt(argv, '--require')), presets);
    if (!dir || !req.length) { console.error(usage); return 2; }
    let r;
    try { r = checkWorkflow(dir, req, { skillsDir }); } catch (e) { console.error('cannot read ' + dir + ': ' + e.message); return 2; }
    for (const b of r.bad) console.log('SKILLS-NOT-USED ' + b.file + ': ' + b.missing.join(', ') + ' (opened ' + (b.opened.join(', ') || 'none') + ')');
    console.log('workflow ' + path.basename(dir) + ': ' + r.agents + ' agents, ' + r.bad.length + ' missing required skills (' + req.join(', ') + ')');
    return r.bad.length ? 1 : 0;
  }
  const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (!dir) { console.error(usage); return 2; }
  let files;
  try { files = fs.readdirSync(dir).filter((x) => x.endsWith('.log')); } catch (e) { console.error('cannot read ' + dir + ': ' + e.message); return 2; }
  const lane = argAt(argv, '--check');
  if (lane) {
    let req = splitList(argAt(argv, '--require'));
    if (!req.length) { try { req = JSON.parse(fs.readFileSync(path.join(dir, 'skills-required.json'), 'utf8'))[lane] || []; } catch { req = []; } }
    req = expandRequired(req, presets);
    if (!files.includes(lane + '.log')) { console.log('CHECK ' + lane + ': no log ' + lane + '.log in ' + dir); return 1; }
    const r = missingIn(fs.readFileSync(path.join(dir, lane + '.log'), 'utf8'), req, skillsDir);
    console.log('CHECK ' + lane + ': required ' + (req.join(', ') || 'none') + '; opened ' + (r.opened.join(', ') || 'none') + '; ' + (r.missing.length ? 'SKILLS-NOT-USED ' + r.missing.join(', ') : 'OK'));
    return r.missing.length ? 1 : 0;
  }
  let calls = 0, withSkill = 0;
  for (const f of files.sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const used = [...openedIn(text)];
    let available = '?';
    for (const l of text.split(/\r?\n/)) { if (!l.startsWith('{')) continue; try { const o = JSON.parse(l); if (o.type === 'system' && o.subtype === 'init' && Array.isArray(o.skills)) { available = o.skills.length; break; } } catch { /* skip */ } }
    calls += used.length; if (used.length) withSkill++;
    console.log(f.replace(/\.log$/, '').padEnd(22) + ' available ' + String(available).padStart(4) + '  opened: ' + (used.join(', ') || 'none'));
  }
  console.log('lanes ' + files.length + '; lanes that opened a skill ' + withSkill + '; skills opened ' + calls);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { loadPresets, expandRequired, openedIn, checkWorkflow, main };
