#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * log-event-active-run-close.test.cjs — FB-CONTRACT-2-F4. The writer points the project at a run on
 * run_started, but never let go of it: after run_completed or run_finalized the pointer still named the closed run, so
 * hook lines of the next work were filed under a finished run. Guard: closing a run through the real writer clears a
 * pointer that names that run, and leaves a pointer to another run alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const SRC = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runclose-'));

function project() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  for (const dir of ['forge-bin', 'forge-dashboard', 'config']) fs.cpSync(path.join(SRC, dir), path.join(root, '.claude', dir), { recursive: true, filter: (p) => !/[\\/]node_modules([\\/]|$)/.test(p) });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  return root;
}
function log(root, runId, type, payload, env) {
  return spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), runId, type, JSON.stringify(payload || { agent: 'orchestrator' })],
    { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_SESSION_ID: '', FORGE_STRICT_EVENTS: '0' }, env || {}), timeout: 60000 });
}
const pointer = (root) => require(path.join(root, '.claude', 'forge-bin', 'forge-active-run.cjs')).readActiveRun(root, {});

t('run_completed (honest failure close) clears the pointer to that run', () => {
  const root = project();
  assert.strictEqual(log(root, 'forge-2026-11-13-close1', 'run_started').status, 0);
  assert.strictEqual((pointer(root) || {}).run, 'forge-2026-11-13-close1');
  const r = log(root, 'forge-2026-11-13-close1', 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'test close' });
  assert.strictEqual(r.status, 0, r.stderr);
  const p = pointer(root);
  assert.ok(!p || p.run !== 'forge-2026-11-13-close1', 'pointer still names the closed run: ' + JSON.stringify(p));
});
t('run_finalized clears the pointer to that run', () => {
  const root = project();
  assert.strictEqual(log(root, 'forge-2026-11-13-close2', 'run_started').status, 0);
  const r = log(root, 'forge-2026-11-13-close2', 'run_finalized', { agent: 'orchestrator', summary: 'test finalize' });
  assert.strictEqual(r.status, 0, r.stderr);
  const p = pointer(root);
  assert.ok(!p || p.run !== 'forge-2026-11-13-close2', 'pointer still names the finalized run: ' + JSON.stringify(p));
});
t('closing another run leaves the pointer to the active run alone', () => {
  const root = project();
  assert.strictEqual(log(root, 'forge-2026-11-13-other', 'run_started').status, 0);
  assert.strictEqual(log(root, 'forge-2026-11-13-active', 'run_started').status, 0);
  const r = log(root, 'forge-2026-11-13-other', 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'test close' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual((pointer(root) || {}).run, 'forge-2026-11-13-active');
});
t('FORGE_AUTO_ACTIVE_RUN=off leaves the pointer alone on a close', () => {
  const root = project();
  assert.strictEqual(log(root, 'forge-2026-11-13-close3', 'run_started').status, 0);
  const r = log(root, 'forge-2026-11-13-close3', 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'test close' }, { FORGE_AUTO_ACTIVE_RUN: 'off' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual((pointer(root) || {}).run, 'forge-2026-11-13-close3');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
