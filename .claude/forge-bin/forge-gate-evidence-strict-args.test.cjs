#!/usr/bin/env node
'use strict';
/**
 * forge-gate-evidence-strict-args.test.cjs — category tests G-EV1. Recording the category-test run's
 * gates, the Lead passed `--gate name::node .claude/forge-bin/forge-testrun.cjs -- node x.test.cjs` UNQUOTED: the shell
 * split it, the recorder kept only "name::node" and silently dropped the rest, ran bare `node` (no script, stdin
 * closed: exit 0, no output) for all 12 gates and printed "12 poort(en) · ALLE GROEN" with evidence_verified:true
 * over empty output. Guards, through the real CLI: (1) an argument the recorder does not understand is refused (exit 2,
 * nothing written) with a hint to quote each --gate value; (2) a gate that is only a bare interpreter or package runner
 * (node, python, npm, npx, bash, sh, pwsh, powershell, cmd) is refused. A properly quoted gate still records.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const CLI = path.join(__dirname, 'forge-gate-evidence.cjs');
const roots = [];
function mkRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gev-strict-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'r1', 'events.jsonl'), JSON.stringify({ run_id: 'r1', event_type: 'run_started', agent: 'orchestrator' }) + '\n');
  return root;
}
const run = (root, args) => spawnSync(process.execPath, [CLI, '--root', root, '--run', 'r1'].concat(args), { cwd: root, encoding: 'utf8', timeout: 60000,
  env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: '', CLAUDE_PROJECT_DIR: '' }) });
const evidenceFile = (root) => path.join(root, '.claude', 'forge-runs', 'r1', 'gate-evidence.json');

try {
  console.log('forge-gate-evidence strict arguments (G-EV1)');
  let root = mkRoot();
  let r = run(root, ['--gate', 'x::node', '.claude/forge-bin/forge-testrun.cjs', '--', 'node', 'x.test.cjs']);
  t('the real unquoted round-7 shape is refused (exit 2) and names the stray argument', r.status === 2 && /forge-testrun\.cjs|not understood|niet begrepen/i.test(r.stderr + r.stdout), JSON.stringify({ s: r.status, o: r.stdout.slice(0, 300), e: r.stderr.slice(0, 300) }));
  t('... with a hint to quote each --gate value', /quote|aanhalingstekens/i.test(r.stderr + r.stdout), r.stderr);
  t('... and writes no gate-evidence.json', !fs.existsSync(evidenceFile(root)));

  for (const bare of ['node', 'npm', 'npx', 'python', 'bash', 'pwsh']) {
    root = mkRoot();
    r = run(root, ['--gate', 'g::' + bare]);
    t('a bare "' + bare + '" gate (no script, no arguments) is refused, nothing written', r.status === 2 && !fs.existsSync(evidenceFile(root)), JSON.stringify({ s: r.status, e: r.stderr.slice(0, 200) }));
  }

  root = mkRoot();
  r = run(root, ['--gate', 'ver::node --version']);
  t('a properly quoted gate still records (exit 0, gate-evidence.json written, non-empty output)', r.status === 0 && fs.existsSync(evidenceFile(root)) && JSON.parse(fs.readFileSync(evidenceFile(root), 'utf8')).gates[0].output_bytes > 0, JSON.stringify({ s: r.status, o: r.stdout.slice(0, 300), e: r.stderr.slice(0, 300) }));
  root = mkRoot();
  r = run(root, ['--json', '--gate', 'ver::node --version']);
  t('known flags (--json) are still accepted', r.status === 0, JSON.stringify({ s: r.status, e: r.stderr.slice(0, 200) }));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
