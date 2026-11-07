#!/usr/bin/env node
'use strict';
/**
 * forge-sync-fresh-quiesce.test.cjs — category tests F9. The first Forge install into a brand-new
 * dashboard scaffold (CLAUDE.md + an empty .claude/forge-dashboard/) was refused as "not proven idle" because some
 * process ANYWHERE on the machine (a shell, the claude-mem worker, node) had a command line forge-sync cannot read.
 * The dashboard's New project button runs exactly then, while Claude sessions are open, so it would always refuse.
 * Guard: only-unknown processes do not block a FIRST install into a bare scaffold (nothing in it that a running process
 * could be writing); they still block once the folder holds app files or a Forge install, and a process that names
 * the folder, or recent session activity, blocks always.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const S = require('./forge-sync.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fresh-quiesce-'));
const NOW = Date.parse('2026-11-07T03:00:00.000Z');
const fakeProjects = fs.mkdtempSync(path.join(TMP, 'projects-'));
const unknownProc = () => [{ pid: 7064, name: 'bun.exe', cmd: null }, { pid: 37488, name: 'node.exe', cmd: '' }];
const opts = (extra) => Object.assign({ nowMs: NOW, projectsRoot: fakeProjects, listProcesses: unknownProc, selfPid: 424242, parentPid: 424241 }, extra || {});
function scaffold() {
  const p = fs.mkdtempSync(path.join(TMP, 'proj-'));
  fs.mkdirSync(path.join(p, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), '# demo\n');
  for (const f of ['CLAUDE.md']) fs.utimesSync(path.join(p, f), new Date(NOW - 3600000), new Date(NOW - 3600000));
  return p;
}

t('a bare dashboard scaffold with only unknown processes elsewhere is IDLE for a first install, and says why', () => {
  const q = S.quiesceCheck(scaffold(), opts());
  assert.strictEqual(q.idle, true, JSON.stringify(q.reasons));
  assert.strictEqual(q.checks.processes.state, 'ok');
  assert.ok(/fresh scaffold/i.test(q.checks.processes.detail), q.checks.processes.detail);
});
t('the installer\'s own lock (taken before the check) does not make the scaffold look used', () => {
  const p = scaffold();
  fs.writeFileSync(path.join(p, '.claude', '.forge-sync.lock'), JSON.stringify({ pid: 424242 }));
  assert.strictEqual(S.isBareScaffold(p), true);
});
t('the same unknown processes still block once the folder holds an app file', () => {
  const p = scaffold();
  fs.writeFileSync(path.join(p, 'index.html'), '<!doctype html>');
  assert.strictEqual(S.quiesceCheck(p, opts()).idle, false);
});
t('they still block once Forge is installed there (forge-bin present)', () => {
  const p = scaffold();
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'forge-sync.cjs'), '//');
  assert.strictEqual(S.quiesceCheck(p, opts()).idle, false);
});
t('a process that names the scaffold blocks even a first install', () => {
  const p = scaffold();
  const q = S.quiesceCheck(p, opts({ listProcesses: () => [{ pid: 999, name: 'node.exe', cmd: 'node build.js "' + p + '"' }] }));
  assert.strictEqual(q.idle, false);
  assert.strictEqual(q.checks.processes.state, 'busy');
});

// ---- an UNTOUCHED fresh install (Forge installed minutes ago, never used) is judged like a bare scaffold ----
// A real install through safeSyncProject (template with a stub doctor) writes the receipt whose file list decides what is
// "the installer's own"; everything else (an app file, a run with events, a changed Forge file, a session file) still blocks.
function freshInstall() {
  const tpl = fs.mkdtempSync(path.join(TMP, 'tpl-'));
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'forge-doctor.cjs'), '#!/usr/bin/env node\nif (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } }));\nprocess.exit(0);\n');
  const p = scaffold();
  const log = console.log; console.log = () => {};
  let r; try { r = S.safeSyncProject(tpl, p, { batchId: 'fresh-1', nowIso: new Date(NOW - 20 * 60000).toISOString(), centralBackupRoot: S.defaultCentralBackupRoot(p) }); } finally { console.log = log; }
  assert.strictEqual(r.ok, true, 'fixture install failed: ' + (r.reason || JSON.stringify(r.outcome)));
  return p;
}
t('F10 an untouched fresh install with only unknown processes elsewhere is IDLE, and says why', () => {
  const p = freshInstall();
  assert.strictEqual(S.isUntouchedFreshInstall(p), true);
  const q = S.quiesceCheck(p, opts());
  assert.strictEqual(q.idle, true, JSON.stringify(q.reasons));
  assert.ok(/untouched fresh install/i.test(q.checks.processes.detail), q.checks.processes.detail);
});
t('F10 the fresh install still blocks once an app file appears next to it', () => {
  const p = freshInstall();
  fs.writeFileSync(path.join(p, 'main.js'), 'console.log(1)');
  assert.strictEqual(S.quiesceCheck(p, opts()).idle, false);
});
t('F10 the fresh install still blocks once a run has events', () => {
  const p = freshInstall();
  const run = path.join(p, '.claude', 'forge-runs', 'forge-2026-11-07-x');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'events.jsonl'), '{}\n');
  const old = new Date(NOW - 3600000); fs.utimesSync(path.join(run, 'events.jsonl'), old, old); // old: the events check alone says ok
  assert.strictEqual(S.isUntouchedFreshInstall(p), false);
  assert.strictEqual(S.quiesceCheck(p, opts()).idle, false);
});
t('F10 the fresh install still blocks once an installed Forge file was changed', () => {
  const p = freshInstall();
  fs.appendFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), '// edited\n');
  assert.strictEqual(S.quiesceCheck(p, opts()).idle, false);
});
t('F10 the fresh install still blocks once a session wrote a file the installer did not write', () => {
  const p = freshInstall();
  fs.writeFileSync(path.join(p, '.claude', 'FORGE_MEMORY.md'), '# memory\n');
  assert.strictEqual(S.quiesceCheck(p, opts()).idle, false);
});
t('F10 recent session activity blocks the fresh install', () => {
  const p = freshInstall();
  const tdir = path.join(fakeProjects, S.claudeProjectSlug(p));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'session.jsonl'), '{}\n');
  const fresh = new Date(NOW - 60000); fs.utimesSync(path.join(tdir, 'session.jsonl'), fresh, fresh);
  const q = S.quiesceCheck(p, opts());
  assert.strictEqual(q.idle, false);
  assert.strictEqual(q.checks.transcripts.state, 'busy');
});
t('F10 a process that names the fresh install blocks it', () => {
  const p = freshInstall();
  const q = S.quiesceCheck(p, opts({ listProcesses: () => [{ pid: 999, name: 'node.exe', cmd: 'node x.js "' + p + '"' }] }));
  assert.strictEqual(q.idle, false);
});
t('F10 a folder without a receipt (Forge files copied by hand) is not a fresh install', () => {
  const p = freshInstall();
  fs.unlinkSync(path.join(p, '.claude', 'forge-sync-receipt.json'));
  assert.strictEqual(S.isUntouchedFreshInstall(p), false);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
