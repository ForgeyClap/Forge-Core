#!/usr/bin/env node
'use strict';
/**
 * forge-active-run-auto.test.cjs — category tests O21. The /forge flow says "right after run_started run
 * forge-active-run.cjs set <run_id>", and three real runs never did it: no hook line carried the run, so every harness
 * proof was empty and dispatches could not be matched. Guard: logging run_started through the real writer points the
 * project at that run; FORGE_AUTO_ACTIVE_RUN=off leaves the pointer alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const SRC = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autorun-'));

function project() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  for (const dir of ['forge-bin', 'forge-dashboard', 'config']) fs.cpSync(path.join(SRC, dir), path.join(root, '.claude', dir), { recursive: true, filter: (p) => !/[\\/]node_modules([\\/]|$)/.test(p) });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  return root;
}
function logStart(root, runId, env) {
  return spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), runId, 'run_started', '{"agent":"orchestrator"}'],
    { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_SESSION_ID: '', FORGE_STRICT_EVENTS: '0' }, env || {}), timeout: 60000 });
}
const pointer = (root) => require(path.join(root, '.claude', 'forge-bin', 'forge-active-run.cjs')).readActiveRun(root, {});

t('run_started through the real writer points the project at that run', () => {
  const root = project();
  const r = logStart(root, 'forge-2026-11-07-auto1');
  assert.strictEqual(r.status, 0, r.stderr);
  const p = pointer(root);
  assert.strictEqual(p && p.run, 'forge-2026-11-07-auto1', JSON.stringify(p));
});
t('FORGE_AUTO_ACTIVE_RUN=off leaves the pointer alone', () => {
  const root = project();
  const r = logStart(root, 'forge-2026-11-07-auto2', { FORGE_AUTO_ACTIVE_RUN: 'off' });
  assert.strictEqual(r.status, 0, r.stderr);
  const p = pointer(root);
  assert.ok(!p || p.run !== 'forge-2026-11-07-auto2', JSON.stringify(p));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
