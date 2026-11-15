#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-runcontract-harness-complexity.test.cjs — category tests O19. The contract derived a run's level only
 * from the dispatches the Lead LOGGED. android-game-v2 logged 1 while the harness hooks recorded 11 real subagent starts
 * (head-chef, build-boss x4, ui-boss, review-boss, verify-boss, three reviewers): it read as L1, so every L2+ rule
 * (independent verification, dispatch-harness-match, end-self-review) stayed off. Under-logging lowered its own bar.
 * Guard: real SubagentStart hook lines inside the run's time window (or stamped with the run) raise the derived level.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-harness-cx-'));
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');

function project(hookLines, events) {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  const rules = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(rules, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), path.join(rules, 'FORGE_HARD_RULES.json'));
  const runs = path.join(root, '.claude', 'forge-runs');
  fs.mkdirSync(path.join(runs, 'r1'), { recursive: true });
  fs.mkdirSync(path.join(runs, '_hooks'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'r1', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(runs, '_hooks', 'subagent-start.jsonl'), hookLines.map((e) => JSON.stringify(e)).join('\n') + (hookLines.length ? '\n' : ''));
  return root;
}
const EVENTS = [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-11-07T02:40:00.000Z' },
  { event_type: 'subagent_started', agent: 'Head Chef', timestamp: '2026-11-07T02:41:00.000Z' },
];
const start = (i, ts, extra) => Object.assign({ ts, event: 'SubagentStart', session: 's1', agent_id: 'a' + i, agent_type: 'build-boss' }, extra || {});

t('without hook lines the level stays the logged-dispatch level (L1)', () => {
  const r = RC.check({ run_id: 'r1' }, { root: project([], EVENTS), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L1', JSON.stringify(r.complexity));
});
t('11 real SubagentStart lines inside the run window raise it to L3 and say the harness decided', () => {
  const hooks = Array.from({ length: 11 }, (_, i) => start(i, '2026-11-07T02:4' + (1 + (i % 8)) + ':30.000Z'));
  const r = RC.check({ run_id: 'r1' }, { root: project(hooks, EVENTS), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L3', JSON.stringify({ c: r.complexity, s: r.complexity_source }));
  assert.strictEqual(r.complexity_source, 'harness');
});
t('hook lines from before the run started, or stamped with another run, never count', () => {
  const hooks = Array.from({ length: 8 }, (_, i) => start(i, '2026-11-07T01:00:00.000Z'))
    .concat(Array.from({ length: 8 }, (_, i) => start(100 + i, '2026-11-07T02:45:00.000Z', { run: 'some-other-run' })));
  const r = RC.check({ run_id: 'r1' }, { root: project(hooks, EVENTS), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L1', JSON.stringify(r.complexity));
});

// FB-CONTRACT-1-F1: an open run (no run_completed) had a window that ended at Infinity, so months of
// later unstamped hook lines from other sessions pushed a July run to L4.
t('an open run does not count unstamped hook lines from months after its last event', () => {
  const july = [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-07-14T10:00:00.000Z' },
    { event_type: 'subagent_started', agent: 'Head Chef', timestamp: '2026-07-14T10:05:00.000Z' },
  ];
  const hooks = Array.from({ length: 30 }, (_, i) => start(i, '2026-11-0' + (3 + (i % 6)) + 'T12:00:00.000Z', { session: 'other-' + i }));
  const r = RC.check({ run_id: 'r1' }, { root: project(hooks, july), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L1', JSON.stringify({ c: r.complexity, s: r.complexity_source }));
});
t('when the run has stamped hook lines, unstamped lines of another session in the window do not count', () => {
  const own = [start(0, '2026-11-07T02:41:10.000Z', { run: 'r1', session: 's1' })];
  const other = Array.from({ length: 20 }, (_, i) => start(200 + i, '2026-11-07T02:4' + (1 + (i % 8)) + ':40.000Z', { session: 's2' }));
  const r = RC.check({ run_id: 'r1' }, { root: project(own.concat(other), EVENTS), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L1', JSON.stringify({ c: r.complexity, s: r.complexity_source }));
});
t('... but unstamped lines of the run\'s own (stamped) session still count', () => {
  const own = [start(0, '2026-11-07T02:41:10.000Z', { run: 'r1', session: 's1' })]
    .concat(Array.from({ length: 10 }, (_, i) => start(300 + i, '2026-11-07T02:4' + (1 + (i % 8)) + ':50.000Z', { session: 's1' })));
  const r = RC.check({ run_id: 'r1' }, { root: project(own, EVENTS), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L3', JSON.stringify({ c: r.complexity, s: r.complexity_source }));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
