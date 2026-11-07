#!/usr/bin/env node
'use strict';
/**
 * forge-anticipate-meta-skills.test.cjs: A2b. After A2, a META mission declares one tooling type, but
 * `apply` still wrote the projects' skills (frontend-design, forge-website, forge-game, forge-mobile, ...) into
 * anticipate.json skills_to_use. The SubagentStart fallback (SK6) hands exactly that list to an executing agent while no
 * skill map is logged, so the G-FP4 gate-fix builder of the category-test run was told to open website and game skills.
 * Guard, through the real CLI: apply --scope meta writes no project skills to skills_to_use and records them as withheld;
 * apply on a normal project request keeps its skills.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); } };
const CLI = path.join(__dirname, 'forge-anticipate.cjs');
const roots = [];
function project(runId) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ams-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', runId), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl'), JSON.stringify({ run_id: runId, event_type: 'run_started', agent: 'orchestrator' }) + '\n');
  return root;
}
const apply = (root, runId, text, extra) => spawnSync(process.execPath, [CLI, 'apply', '--run', runId, '--root', root, '--text', text, '--json'].concat(extra || []),
  { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, FORGE_PROJECT_ROOT: root }) });
const overlay = (root, runId) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'forge-runs', runId, 'anticipate.json'), 'utf8')); } catch { return null; } };
const PROJECT_SKILLS = ['frontend-design', 'forge-website', 'forge-game', 'forge-mobile', 'forge-electron'];

const META = 'Test Forge in drie aparte projectmappen, elk met een verse Forge-installatie: een high-end Chinese restaurantwebsite, een Android APK-spel en een Windows exe-spel. Let op skills, agents, kwaliteit, tokens en usage.';
const SITE = 'Maak een high-end website voor een Chinees restaurant met menu, reserveren en openingstijden.';

try {
  console.log('forge-anticipate apply: a meta mission does not hand out the projects\' skills (A2b)');
  let root = project('r-meta');
  let r = apply(root, 'r-meta', META, ['--scope', 'meta']);
  let o = overlay(root, 'r-meta');
  t('apply --scope meta succeeds and writes anticipate.json', r.status === 0 && o && o.status === 'applied', JSON.stringify({ s: r.status, e: r.stderr.slice(0, 300) }));
  const leaked = o ? (o.skills_to_use || []).filter((s) => PROJECT_SKILLS.includes(s)) : ['no overlay'];
  t('... skills_to_use carries none of the projects\' skills', leaked.length === 0, JSON.stringify(o && o.skills_to_use));
  t('... the withheld skills are recorded, not silently dropped', o && Array.isArray(o.skills_withheld_meta) && o.skills_withheld_meta.some((s) => PROJECT_SKILLS.includes(s)), JSON.stringify(o && o.skills_withheld_meta));
  root = project('r-site');
  r = apply(root, 'r-site', SITE);
  o = overlay(root, 'r-site');
  t('a normal website request keeps its skills (forge-website in skills_to_use)', r.status === 0 && o && (o.skills_to_use || []).includes('forge-website'), JSON.stringify(o && o.skills_to_use));
  t('... and records no withheld list', o && !o.skills_withheld_meta, JSON.stringify(o && o.skills_withheld_meta));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
