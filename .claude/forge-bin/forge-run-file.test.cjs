#!/usr/bin/env node
'use strict';
/**
 * forge-run-file.test.cjs — category tests O25. In windows-game-v2 (a headless `claude -p` session, the way
 * the dashboard and the category tests start Forge) the Lead could not write `run.json` or `final-report.md`: Claude
 * Code treats every file under `.claude/` as sensitive, so Write/Edit there is refused without a person to approve it.
 * The run stayed open and had no report. Guard: one node tool writes a run's own files (report, run.json, plan, PRD)
 * from a draft outside `.claude/`, and the command steps that create those files name it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TOOL = path.join(__dirname, 'forge-run-file.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-file-'));
function project() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'forge-2026-11-07-120000'), { recursive: true });
  fs.mkdirSync(path.join(root, '_scratch'), { recursive: true });
  return root;
}
const run = (root, args) => spawnSync(process.execPath, [TOOL].concat(args), { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
const RUN = 'forge-2026-11-07-120000';

t('put copies a draft from outside .claude into the run folder', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '_scratch', 'report.md'), '# Eindverslag\n');
  const r = run(root, ['put', '--run', RUN, '--name', 'final-report.md', '--from', '_scratch/report.md']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude', 'forge-runs', RUN, 'final-report.md'), 'utf8'), '# Eindverslag\n');
});
t('put overwrites an existing run file (run.json status update)', () => {
  const root = project();
  const dst = path.join(root, '.claude', 'forge-runs', RUN, 'run.json');
  fs.writeFileSync(dst, '{"status":"running"}');
  fs.writeFileSync(path.join(root, '_scratch', 'run.json'), '{"status":"completed"}');
  const r = run(root, ['put', '--run', RUN, '--name', 'run.json', '--from', '_scratch/run.json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(dst, 'utf8')).status, 'completed');
});
t('a run.json that is not valid JSON is refused', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '_scratch', 'run.json'), '{status:');
  assert.notStrictEqual(run(root, ['put', '--run', RUN, '--name', 'run.json', '--from', '_scratch/run.json']).status, 0);
});
t('events.jsonl, run-finalized.json and path escapes are refused (those have their own writers)', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '_scratch', 'x'), '{}');
  for (const name of ['events.jsonl', 'run-finalized.json', '../evil.md', '..\\evil.md', 'a/../../evil.md', '/abs.md']) {
    const r = run(root, ['put', '--run', RUN, '--name', name, '--from', '_scratch/x']);
    assert.notStrictEqual(r.status, 0, name + ' was accepted');
  }
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'forge-runs', 'evil.md')));
});
t('Windows look-alikes are refused: a trailing dot or space, and device names (verifier finding)', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '_scratch', 'x'), '{}');
  for (const name of ['events.jsonl.', 'run-finalized.json.', 'final-report.md ', 'nul', 'CON.txt', 'artifacts/aux.md', 'com1', 'LPT9.log']) {
    const r = run(root, ['put', '--run', RUN, '--name', name, '--from', '_scratch/x']);
    assert.notStrictEqual(r.status, 0, JSON.stringify(name) + ' was accepted');
  }
});
t('a run id that is not a run folder, or a missing draft, is refused with a plain reason', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '_scratch', 'r.md'), 'x');
  const a = run(root, ['put', '--run', '../x', '--name', 'final-report.md', '--from', '_scratch/r.md']);
  assert.notStrictEqual(a.status, 0);
  const b = run(root, ['put', '--run', RUN, '--name', 'final-report.md', '--from', '_scratch/nope.md']);
  assert.notStrictEqual(b.status, 0);
  assert.ok(/nope\.md/.test(b.stderr), b.stderr);
});
t('a sub-folder name (artifacts/x.md) is created inside the run folder', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '_scratch', 'a.md'), 'a');
  const r = run(root, ['put', '--run', RUN, '--name', 'artifacts/self-review.md', '--from', '_scratch/a.md']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'forge-runs', RUN, 'artifacts', 'self-review.md')));
});
t('the /forge steps that create run.json and final-report.md name forge-run-file (headless sessions cannot Write there)', () => {
  const ref = path.join(__dirname, '..', 'docs', 'forge-reference');
  for (const f of ['forge-cmd-steps-0-3.md', 'forge-cmd-steps-7-14.md']) {
    const p = path.join(ref, f);
    const txt = fs.readFileSync(p, 'utf8');
    assert.ok(/forge-run-file\.cjs put/.test(txt), f + ' does not name forge-run-file.cjs put');
  }
});
t('the always-loaded core forge.md rows 1 and 14 name forge-run-file.cjs put (the android run still tried Write)', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'commands', 'forge.md'), 'utf8').split('\n');
  for (const n of ['1', '14']) {
    const row = core.find((l) => l.startsWith('| ' + n + ' |')) || '';
    assert.ok(/forge-run-file\.cjs put/.test(row), 'forge.md row ' + n + ' does not name forge-run-file.cjs put');
  }
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
