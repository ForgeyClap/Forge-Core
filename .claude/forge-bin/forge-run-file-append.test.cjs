#!/usr/bin/env node
'use strict';
/**
 * forge-run-file-append.test.cjs — category tests A2/A4. The project memory files (FORGE_MEMORY.md,
 * FORGE_TASK_HISTORY.md, FORGE_AGENT_LEDGER.md, FORGE_DECISIONS.md, FORGE_SKILL_REGISTRY.md and
 * agent-memory/<boss>/MEMORY.md) live under `.claude/`, where a headless session may not Write/Edit, and no tool wrote
 * them, so every headless run left them untouched. Guard: `forge-run-file.cjs append` appends a draft to exactly those
 * files (whitelist), creates a missing one, keeps one newline between old and new text, writes LF, refuses the rest.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TOOL = path.join(__dirname, 'forge-run-file.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-file-append-'));
function project() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '_scratch'), { recursive: true });
  return root;
}
const run = (root, args, input) => spawnSync(process.execPath, [TOOL].concat(args), { cwd: root, input, encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
const draft = (root, text) => { fs.writeFileSync(path.join(root, '_scratch', 'd.md'), text); return '_scratch/d.md'; };
const read = (root, rel) => fs.readFileSync(path.join(root, '.claude', rel), 'utf8');

t('append adds the draft to FORGE_MEMORY.md with exactly one newline between old and new text', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), '# Memory\nold line');
  const r = run(root, ['append', '--file', 'FORGE_MEMORY.md', '--from', draft(root, 'new line\n')]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(read(root, 'FORGE_MEMORY.md'), '# Memory\nold line\nnew line\n');
});
t('append does not double the newline when the old text already ends with one', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_TASK_HISTORY.md'), '# History\nrow 1\n');
  const r = run(root, ['append', '--file', 'FORGE_TASK_HISTORY.md', '--from', draft(root, 'row 2')]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(read(root, 'FORGE_TASK_HISTORY.md'), '# History\nrow 1\nrow 2\n');
});
t('append creates a missing whitelisted file, also agent-memory/<boss>/MEMORY.md', () => {
  const root = project();
  for (const f of ['FORGE_AGENT_LEDGER.md', 'FORGE_DECISIONS.md', 'FORGE_SKILL_REGISTRY.md', 'agent-memory/build-boss/MEMORY.md']) {
    const r = run(root, ['append', '--file', f, '--from', draft(root, '- lesson')]);
    assert.strictEqual(r.status, 0, f + ': ' + r.stderr);
    assert.strictEqual(read(root, f), '- lesson\n', f);
  }
});
t('append writes LF only: CRLF in the old file and the draft becomes LF', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_DECISIONS.md'), '# D\r\nd1\r\n');
  const r = run(root, ['append', '--file', 'FORGE_DECISIONS.md', '--from', draft(root, 'd2\r\nd3\r\n')]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(read(root, 'FORGE_DECISIONS.md'), '# D\nd1\nd2\nd3\n');
});
t('append reads the draft from stdin with --from -', () => {
  const root = project();
  const r = run(root, ['append', '--file', 'FORGE_MEMORY.md', '--from', '-'], 'from stdin\n');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(read(root, 'FORGE_MEMORY.md'), 'from stdin\n');
});
t('append refuses any file outside the whitelist with a plain reason', () => {
  const root = project();
  const bad = ['FORGE_CONFIG.json', 'settings.json', 'FORGE_MEMORY.md.', 'forge-runs/x/events.jsonl', '../FORGE_MEMORY.md',
    'agent-memory/../FORGE_CONFIG.json', 'agent-memory/Build_Boss/MEMORY.md', 'agent-memory/a/b/MEMORY.md',
    'agent-memory/build-boss/notes.md', 'agent-memory/nul/MEMORY.md', '/abs/FORGE_MEMORY.md', 'agent-memory\\x\\MEMORY.md', ''];
  for (const f of bad) {
    const r = run(root, ['append', '--file', f, '--from', draft(root, 'x')]);
    assert.notStrictEqual(r.status, 0, JSON.stringify(f) + ' was accepted');
    assert.ok(/REFUSED/.test(r.stderr), JSON.stringify(f) + ': ' + r.stderr);
  }
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'FORGE_CONFIG.json')));
});
t('append refuses a missing draft and an empty draft', () => {
  const root = project();
  const a = run(root, ['append', '--file', 'FORGE_MEMORY.md', '--from', '_scratch/nope.md']);
  assert.notStrictEqual(a.status, 0);
  assert.ok(/nope\.md/.test(a.stderr), a.stderr);
  const b = run(root, ['append', '--file', 'FORGE_MEMORY.md', '--from', draft(root, '  \n')]);
  assert.notStrictEqual(b.status, 0);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'FORGE_MEMORY.md')));
});
t('the usage line names both put and append', () => {
  const r = run(project(), ['nope']);
  assert.notStrictEqual(r.status, 0);
  assert.ok(/put/.test(r.stderr) && /append/.test(r.stderr), r.stderr);
});
t('module API exports appendMemoryFile and checkMemoryFile', () => {
  const m = require(TOOL);
  assert.strictEqual(typeof m.appendMemoryFile, 'function');
  assert.strictEqual(typeof m.checkMemoryFile, 'function');
  assert.strictEqual(m.checkMemoryFile('FORGE_MEMORY.md'), null);
  assert.ok(m.checkMemoryFile('FORGE_CONFIG.json'));
});
t('the memory-update step (forge.md row 12 and steps-7-14 step 12) names forge-run-file.cjs append', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'commands', 'forge.md'), 'utf8');
  const row12 = core.split('\n').find((l) => /^\| 12 \|/.test(l)) || '';
  assert.ok(/forge-run-file\.cjs append/.test(row12), 'forge.md row 12 does not name forge-run-file.cjs append');
  const ref = fs.readFileSync(path.join(__dirname, '..', 'docs', 'forge-reference', 'forge-cmd-steps-7-14.md'), 'utf8');
  const s12 = ref.slice(ref.indexOf('## 12.'), ref.indexOf('## 13.'));
  assert.ok(/forge-run-file\.cjs append/.test(s12), 'steps-7-14 step 12 does not name forge-run-file.cjs append');
});
t('the core forge.md has the one-plain-command-per-Bash-call rule for headless sessions', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'commands', 'forge.md'), 'utf8');
  const sec = core.slice(core.indexOf('## A.'), core.indexOf('## B.'));
  assert.ok(/ONE plain command per Bash call/.test(sec), 'section A has no one-command rule');
  assert.ok(/&&/.test(sec), 'the rule does not name && as refused');
});
t('skill discovery doc states the skill_map_created map format, injection at start and the skill-delivered check', () => {
  const ref = fs.readFileSync(path.join(__dirname, '..', 'docs', 'forge-reference', 'forge-cmd-steps-0-3.md'), 'utf8');
  assert.ok(/\{"map":\{"<agent-type>":\["<skill-folder-name>"/.test(ref), 'no map format');
  const m = ref.match(/\{"map":\{"([a-z-]+)":\["([a-z0-9-]+)"/g) || [];
  const real = m.map((x) => /\["([a-z0-9-]+)"/.exec(x)[1]).filter((s) => fs.existsSync(path.join(__dirname, '..', 'skills', s, 'SKILL.md')));
  assert.ok(real.length >= 1, 'no example with a real skill folder name');
  assert.ok(/skill-delivered/.test(ref) && /inject/i.test(ref), 'no skill-delivered / injection sentence');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
