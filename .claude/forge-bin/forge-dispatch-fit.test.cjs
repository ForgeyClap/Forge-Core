#!/usr/bin/env node
'use strict';
// forge-dispatch-fit.test.cjs — tests for the dispatch tool-fit guard (W2-DISPATCHLINT).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const F = require('./forge-dispatch-fit.cjs');

const CLI = path.join(__dirname, 'forge-dispatch-fit.cjs');
let passed = 0, failed = 0;
const dirs = [];
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input });
}
function fixture(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-fit-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, 'agents'));
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(d, 'agents', n + '.md'), body);
  return path.join(d, 'agents');
}

try {
  const dir = fixture({
    reader: '---\nname: reader\ntools: Read, Grep\n---\nbody\n',
    full: '---\nname: full\ndescription: x\n---\nbody\n',
    writer: '---\nname: writer\ntools: Read, Write, Edit, Bash\n---\nbody\n',
    nofm: '# no frontmatter at all\ntools: Read\n',
    bom: '﻿---\nname: bom\ntools: Read, Grep\n---\nbody\n',
    yamllist: '---\nname: yamllist\ntools:\n  - Read\n  - Bash\n  - Write\nmodel: sonnet\n---\nbody\n',
    star: '---\nname: star\ntools: "*"\n---\nbody\n',
    alltools: '---\nname: alltools\ntools: All tools\n---\nbody\n',
    commented: '---\nname: commented\ntools: Read, Bash # shell for the probe\n---\nbody\n',
    flow: '---\nname: flow\ntools: [Read, Bash]\n---\nbody\n',
    lower: '---\nname: lower\ntools: Read, bash\n---\nbody\n',
  });
  const env = ['--agents-dir', dir];
  t('fixture: missing tool -> exit 1 and names it', () => {
    const r = run(['check', '--agent', 'reader', '--needs', 'Bash,Read', ...env]);
    assert.strictEqual(r.status, 1); assert.ok(/Bash/.test(r.stdout + r.stderr));
  });
  t('fixture: all present -> exit 0', () => {
    assert.strictEqual(run(['check', '--agent', 'writer', '--needs', 'Bash,Write', ...env]).status, 0);
  });
  t('fixture: no tools line = all tools, pass with note', () => {
    const r = run(['check', '--agent', 'full', '--needs', 'Bash', ...env]);
    assert.strictEqual(r.status, 0); assert.ok(/all tools/i.test(r.stdout));
  });
  t('unknown agent -> exit 2', () => {
    assert.strictEqual(run(['check', '--agent', 'nope-zzz', '--needs', 'Bash', ...env]).status, 2);
  });
  t('bad usage -> exit 2', () => { assert.strictEqual(run(['check']).status, 2); });
  t('--json output parses', () => {
    const r = run(['check', '--agent', 'reader', '--needs', 'Bash', '--json', ...env]);
    const j = JSON.parse(r.stdout); assert.deepStrictEqual(j.missing, ['Bash']); assert.strictEqual(j.ok, false);
  });
  t('infer from stdin', () => {
    const r = run(['infer', '--brief', '-'], 'Please run the probe with gh api and write the file');
    assert.ok(/Bash/.test(r.stdout) && /Write/.test(r.stdout));
  });
  t('infer pure-read brief infers nothing risky', () => {
    assert.deepStrictEqual(F.inferTools('summarise the docs'), []);
  });
  t('module: checkFit', () => {
    const r = F.checkFit('reader', ['Bash'], { agentsDirs: [dir] });
    assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.missing, ['Bash']);
  });
  t('suggest lists fixture agents with all tools', () => {
    const r = run(['suggest', '--needs', 'Bash,Write', ...env]);
    assert.ok(/writer/.test(r.stdout) && !/reader/.test(r.stdout));
  });
  // W2-REVIEWFIX M2a: fail closed on an unreadable file, parse the real frontmatter forms
  t('no frontmatter block -> exit 2 "cannot read tools" (fail closed)', () => {
    const r = run(['check', '--agent', 'nofm', '--needs', 'Bash', ...env]);
    assert.strictEqual(r.status, 2); assert.ok(/cannot read tools/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
  });
  t('module: no frontmatter is unreadable, never ok', () => {
    const r = F.checkFit('nofm', ['Bash'], { agentsDirs: [dir] });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.unreadable, true);
  });
  t('a UTF-8 BOM is stripped: tools still read (Bash missing -> exit 1)', () => {
    const r = run(['check', '--agent', 'bom', '--needs', 'Bash', ...env]);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr); assert.ok(/Bash/.test(r.stdout));
  });
  t('no tools line: all tools, the note names the Claude Code default', () => {
    const r = run(['check', '--agent', 'full', '--needs', 'Bash', ...env]);
    assert.strictEqual(r.status, 0); assert.ok(/Claude Code default/i.test(r.stdout), r.stdout);
  });
  t('YAML list form is parsed', () => {
    assert.deepStrictEqual(F.parseTools('---\ntools:\n  - Read\n  - Bash\nmodel: x\n---\n'), ['Read', 'Bash']);
    assert.strictEqual(run(['check', '--agent', 'yamllist', '--needs', 'Bash,Write', ...env]).status, 0);
    assert.strictEqual(run(['check', '--agent', 'yamllist', '--needs', 'Edit', ...env]).status, 1);
  });
  t('tools: "*" and "All tools" mean all tools', () => {
    assert.strictEqual(run(['check', '--agent', 'star', '--needs', 'Bash', ...env]).status, 0);
    assert.strictEqual(run(['check', '--agent', 'alltools', '--needs', 'Bash', ...env]).status, 0);
  });
  t('an inline # comment is not part of the last tool', () => {
    assert.strictEqual(run(['check', '--agent', 'commented', '--needs', 'Bash', ...env]).status, 0);
  });
  t('a YAML flow list [Read, Bash] is parsed', () => {
    assert.strictEqual(run(['check', '--agent', 'flow', '--needs', 'Bash', ...env]).status, 0);
  });
  t('matching is case-sensitive, a case-only near miss is warned', () => {
    const r = run(['check', '--agent', 'lower', '--needs', 'Bash', ...env]);
    assert.strictEqual(r.status, 1); assert.ok(/case/i.test(r.stdout + r.stderr) && /bash/.test(r.stdout + r.stderr), r.stdout + r.stderr);
    const j = F.checkFit('lower', ['Bash'], { agentsDirs: [dir] });
    assert.deepStrictEqual(j.nearMiss, [{ need: 'Bash', have: 'bash' }]);
  });
  t('suggest never lists an unreadable agent', () => {
    assert.ok(!/nofm/.test(run(['suggest', '--needs', 'Read', ...env]).stdout));
  });
  // real tree (read-only)
  t('real: search-boss lacks Bash,Write -> exit 1', () => {
    const r = run(['check', '--agent', 'search-boss', '--needs', 'Bash,Write']);
    assert.strictEqual(r.status, 1); assert.ok(/Bash/.test(r.stdout) && /Write/.test(r.stdout));
  });
  t('real: security-boss lacks Bash -> exit 1', () => {
    assert.strictEqual(run(['check', '--agent', 'security-boss', '--needs', 'Bash']).status, 1);
  });
  t('real: build-boss has Bash,Write -> exit 0', () => {
    assert.strictEqual(run(['check', '--agent', 'build-boss', '--needs', 'Bash,Write']).status, 0);
  });
  t('real: suggest Bash,Write includes build-boss', () => {
    assert.ok(/build-boss/.test(run(['suggest', '--needs', 'Bash,Write']).stdout));
  });
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
