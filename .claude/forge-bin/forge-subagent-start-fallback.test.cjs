#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-start-fallback.test.cjs — category tests SK6. windows-v7's Lead dispatched its
 * build-boss and ui-boss at 14:21-14:22 and logged the skill map at 14:23: the SubagentStart hook found no map, injected
 * nothing, and the builders worked without their category playbook. Two guards, through the real hook CLI:
 *  1. no skill map yet -> an EXECUTING agent type (build/ui/test/integration/seo + build specialists) is handed the
 *     run's category skills that forge-anticipate already chose (anticipate.json skills_to_use, applied for THIS run),
 *     labelled as provisional; planning roles get nothing, another run's anticipate.json counts for nothing;
 *  2. the hook reads EVERY map of the run together (the contract's rule since SK2), so a later map that names only
 *     other agents no longer hides an earlier assignment.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); } };
const roots = [];
const tmp = (p) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(r); return r; };
const HOME = tmp('forge-ssf-home-');
const START = path.join(__dirname, 'forge-subagent-start.cjs');
const cli = (root, input) => spawnSync(process.execPath, [START], { input, encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, HOME, USERPROFILE: HOME, FORGE_SUBAGENT_START_HOOK: '', FORGE_RUN_ID: '' }) });
const SKILLS = ['frontend-design', 'forge-website', 'forge-craft', 'forge-game', 'forge-verify'];
const RUN = 'run-ssf-1';

function project(maps, anticipate) {
  const root = tmp('forge-ssf-');
  for (const s of SKILLS) { const d = path.join(root, '.claude', 'skills', s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# ' + s + '\n'); }
  const runDir = path.join(root, '.claude', 'forge-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  const lines = [JSON.stringify({ run_id: RUN, event_type: 'run_started' })].concat((maps || []).map((m) => JSON.stringify({ run_id: RUN, event_type: 'skill_map_created', agent: 'orchestrator', map: m })));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n');
  if (anticipate) fs.writeFileSync(path.join(runDir, 'anticipate.json'), JSON.stringify(anticipate));
  AR.setActiveRun(root, RUN, { session: 'sess-ssf' });
  return root;
}
const payload = (agentType) => JSON.stringify({ session_id: 'sess-ssf', transcript_path: 'C:/x/main.jsonl', cwd: 'C:/x', hook_event_name: 'SubagentStart', agent_id: 'a1b2c3d4', agent_type: agentType });
const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; } };
const ANT = { run_id: RUN, status: 'applied', skills_to_use: ['forge-game', 'forge-craft', 'not-a-real-skill'] };

try {
  console.log('forge-subagent-start fallback + union (SK6)');
  let r = cli(project([], ANT), payload('build-boss'));
  let c = ctxOf(r);
  t('E1 no map yet: build-boss gets the anticipate category skills (forge-game, forge-craft), exit 0', r.status === 0 && c.includes('forge-game') && c.includes('forge-craft'), JSON.stringify({ s: r.status, o: r.stdout, e: r.stderr }));
  t('E1b ... a name that is not an installed skill is dropped', !c.includes('not-a-real-skill'), c);
  t('E1c ... and the text says the skill map is not logged yet (provisional)', /not logged yet|nog niet gelogd/i.test(c), c);
  r = cli(project([], ANT), payload('forge:ui-boss'));
  t('E2 a plugin-scoped agent type (forge:ui-boss) is an executor too', ctxOf(r).includes('forge-game'), r.stdout);
  r = cli(project([], ANT), payload('head-chef'));
  t('E3 a planning role (head-chef) gets nothing from the fallback', r.status === 0 && r.stdout === '', r.stdout);
  r = cli(project([], Object.assign({}, ANT, { run_id: 'another-run' })), payload('build-boss'));
  t('E4 anticipate.json of another run counts for nothing', r.status === 0 && r.stdout === '', r.stdout);
  r = cli(project([], Object.assign({}, ANT, { status: 'planned' })), payload('build-boss'));
  t('E5 an anticipate.json that was only planned, never applied, counts for nothing', r.status === 0 && r.stdout === '', r.stdout);
  r = cli(project([], null), payload('build-boss'));
  t('E6 no map and no anticipate.json: nothing, exit 0', r.status === 0 && r.stdout === '', r.stdout);
  r = cli(project([{ 'ui-boss': ['frontend-design'] }], ANT), payload('build-boss'));
  t('E7 once a map exists the map decides: build-boss not in it -> no fallback skills', r.status === 0 && r.stdout === '', r.stdout);
  r = cli(project([{ 'build-boss': ['forge-game'] }, { 'ui-boss': ['frontend-design'] }], null), payload('build-boss'));
  c = ctxOf(r);
  t('U1 union: an earlier map\'s build-boss assignment survives a later map that names only ui-boss', c.includes('forge-game') && !/not logged yet/i.test(c), r.stdout);
  r = cli(project([{ 'ui-boss': ['frontend-design'] }, { 'ui-boss': ['forge-website'] }], null), payload('ui-boss'));
  c = ctxOf(r);
  t('U2 union: two maps for the same agent -> both skills', c.includes('frontend-design') && c.includes('forge-website'), r.stdout);
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
