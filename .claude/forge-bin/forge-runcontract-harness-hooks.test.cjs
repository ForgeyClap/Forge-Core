#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-harness-hooks.test.cjs — WP A13 (fleet rollout): the run-contract rule
 * dispatch-harness-match is conditional on the harness hooks being installed. A project whose .claude/settings.json
 * (or settings.local.json) does not register forge-subagent-start.cjs under SubagentStart, and whose harness recorded
 * nothing start-side for the run, gets a visible warning "harness hooks not installed" instead of every dispatch being
 * counted as unmatched. Hermetic: one os.mkdtemp folder (removed at the end) holds every fixture project and the Claude
 * home the journal auto-discovery reads; the real project is only read (production FORGE_HARD_RULES.json).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_RULES = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-hh-')));
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS', 'FORGE_HARNESS_FIND_JOURNALS', 'FORGE_HARNESS_STAMP', 'FORGE_RUN_ID']) delete process.env[k];
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude-home');
process.env.FORGE_CONFIG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });

const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const RULE = 'dispatch-harness-match';
const TS = '2026-11-01T10:00:00.000Z';
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const START_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-subagent-start.cjs"';
let n = 0;

/** project({settings, local, hookLines, events}) -> root with one L2 run "run-a" holding `events` (default: one fake dispatch). */
function project(o) {
  const root = mk(TMP, 'p' + (++n));
  mk(root, '.claude', 'config', 'orchestration');
  fs.copyFileSync(REAL_RULES, path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  mk(root, '.claude', 'forge-runs', '_hooks');
  if (o.settings) fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(o.settings, null, 2));
  if (o.local) fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(o.local, null, 2));
  if (o.hookLines) fs.writeFileSync(path.join(root, '.claude', 'forge-runs', '_hooks', 'agent-tool.jsonl'), o.hookLines.map((l) => JSON.stringify(Object.assign({ ts: TS, session: 's1' }, l))).join('\n') + '\n');
  const dir = mk(root, '.claude', 'forge-runs', 'run-a');
  const evs = o.events || [{ event_type: 'subagent_started', agent: 'Build Boss', runtime: 'agent-tool', dispatch_id: 'toolu_FAKE00000001', timestamp: TS }];
  const all = [{ event_type: 'run_started', agent: 'orchestrator', timestamp: TS }].concat(evs);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ complexity: 'L2' }));
  return root;
}
const startHook = (cmd) => ({ hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }] } });
const chk = (root) => RC.check({ run_id: 'run-a' }, { root, ownerProfilePath: NO_PROFILE });
const det = (c) => c.rule_details[RULE] || {};
const hk = (d) => (d && d.harness && d.harness.hooks) || {};

try {
  console.log('\nA13) dispatch-harness-match is conditional on the harness hooks');

  let c = chk(project({}));
  let d = det(c);
  t('1 no settings.json, no harness record -> a WARNING that says "harness hooks not installed"',
    c.warnings.includes(RULE) && !c.satisfied.includes(RULE) && /^harness hooks not installed/.test(d.reason || ''), JSON.stringify(d));
  t('2 its detail records hooks.installed=false and does not judge the dispatch as unmatched in the reason',
    hk(d).installed === false && /not counted as unmatched/.test(d.reason) && !/match \d+%/.test(d.reason), JSON.stringify(d.harness));

  c = chk(project({ settings: startHook(START_CMD) }));
  d = det(c);
  t('3 settings.json registers forge-subagent-start.cjs -> the dispatch IS counted (0% matched, warning, not "not installed")',
    c.warnings.includes(RULE) && !/hooks not installed/.test(d.reason || '') && /0 matched/.test(d.reason || '') && /match 0%/.test(d.reason || '') && hk(d).installed === true && hk(d).via === '.claude/settings.json', JSON.stringify(d));

  c = chk(project({ local: startHook(START_CMD) }));
  d = det(c);
  t('4 settings.local.json registering it counts as installed too', d.harness && hk(d).installed === true && hk(d).via === '.claude/settings.local.json' && /match 0%/.test(d.reason || ''), JSON.stringify(d));

  c = chk(project({ settings: startHook('node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-subagent-stop.cjs"') }));
  t('5 a SubagentStart hook running another script is NOT the harness start hook -> "not installed"', /^harness hooks not installed/.test(det(c).reason || ''), JSON.stringify(det(c)));

  c = chk(project({ settings: { hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: START_CMD }] }] } } }));
  t('6 the right script under the WRONG event (SubagentStop) is not installed', /^harness hooks not installed/.test(det(c).reason || ''), JSON.stringify(det(c)));

  c = chk(project({ hookLines: [{ event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000002', subagent_type: 'build-boss', run: 'run-a' }],
    events: [{ event_type: 'subagent_started', agent: 'Build Boss', runtime: 'agent-tool', dispatch_id: 'toolu_REAL00000002', timestamp: TS }] }));
  d = det(c);
  t('7 no settings hook but the harness recorded this run (plugin or user-level hooks) -> judged normally: satisfied',
    c.satisfied.includes(RULE) && d.harness && hk(d).installed === true && hk(d).via === 'harness-records', JSON.stringify(d));

  c = chk(project({ events: [] }));
  t('8 no dispatch at all -> satisfied "nothing to match", hooks or not', c.satisfied.includes(RULE) && /nothing to match/.test(det(c).reason || ''), JSON.stringify(det(c)));

  const broken = project({});
  fs.writeFileSync(path.join(broken, '.claude', 'settings.json'), '{ not json');
  c = chk(broken);
  t('9 an unreadable settings.json never throws: "not installed" warning', c.warnings.includes(RULE) && /^harness hooks not installed/.test(det(c).reason || ''), JSON.stringify(det(c)));

  t('10 harnessHooksInstalled is exported and pure on a missing root', typeof RC.harnessHooksInstalled === 'function' && RC.harnessHooksInstalled(path.join(TMP, 'nope'), null).installed === false);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
