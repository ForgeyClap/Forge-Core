#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-howto-output.test.cjs — category tests C1. windows-v6's Lead ended with the
 * contract NOT DONE on evidence-satisfied and verify-checked and could not recover: `check` printed "✗ MISSING
 * verify-checked" with no reason and no next step (event-present rules carry no rule_details), and `plan` listed them
 * under "Not yet due" without a hint because run_completed was not logged yet — which the Lead (rightly) will not log
 * over a red contract. Guard: the human `check` output prints, for every missing or warned rule without its own
 * reason, the rule's one-line how-to (for an event-present rule: which events meet it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 900) : '')); } };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-howto-')));
const RULES = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const CLI = path.join(__dirname, 'forge-runcontract.cjs');

const root = path.join(TMP, 'p');
fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
fs.copyFileSync(RULES, path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
const dir = path.join(root, '.claude', 'forge-runs', 'r1');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'events.jsonl'), [
  { event_type: 'run_started', agent: 'orchestrator', complexity: 'L1', timestamp: '2026-11-07T12:00:00.000Z' },
  { event_type: 'memory_loaded', agent: 'orchestrator', timestamp: '2026-11-07T12:00:01.000Z' },
].map((e) => JSON.stringify(e)).join('\n') + '\n');

const r = spawnSync(process.execPath, [CLI, 'check', '--run', 'r1', '--root', root], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: '', CLAUDE_PROJECT_DIR: '' }) });
const out = (r.stdout || '') + (r.stderr || '');
const block = (id) => { const i = out.indexOf('✗ MISSING ' + id); if (i < 0) return ''; const j = out.indexOf('✗ MISSING', i + 5); return out.slice(i, j < 0 ? i + 800 : j); };

console.log('forge-runcontract check output how-to tests (hermetic root=' + TMP + ')');
t('the fixture run is NOT DONE and lists verify-checked as missing', /NOT DONE/.test(out) && /✗ MISSING verify-checked/.test(out), out.slice(0, 600));
t('verify-checked carries a how-to naming the events that meet it (check_passed / quality_gate_passed / retest_completed)', /↳ how: .*check_passed/.test(block('verify-checked')) && /quality_gate_passed/.test(block('verify-checked')), block('verify-checked'));
t('evidence-satisfied carries a how-to naming at least one event that meets it', /↳ how: when it really happened, log /.test(block('evidence-satisfied')), block('evidence-satisfied'));
t('a missing rule that already has a reason keeps it (no duplicate how-to line)', (() => { const b = block('research-done'); return !b || !/↳ how:/.test(b) || !/↳ (?!how|next|NL)/.test(b); })(), block('research-done'));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
