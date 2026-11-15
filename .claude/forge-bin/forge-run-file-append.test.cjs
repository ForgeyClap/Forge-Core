#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
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

// CORE-1-F2: a run close-out written as `## 2026-11-09 — run …` (no "Status") landed at the BOTTOM of
// FORGE_MEMORY.md, so latestStatusBlock never saw it; and the same close-out was appended twice in three files.
const MEM_HEAD = '# Forge Memory\n\n> newest first\n\n';
t('CORE-1-F2: a dated ## heading without "Status" in a FORGE_MEMORY.md draft becomes ## Status and goes on top', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), MEM_HEAD + '## Status 2026-11-08 ~06:30 — PAUSED\n- old\n');
  const r = run(root, ['append', '--file', 'FORGE_MEMORY.md', '--from', draft(root, '## 2026-11-09 — run forge-2026-11-09-063358 (owner R-0190)\n- closed\n')]);
  assert.strictEqual(r.status, 0, r.stderr);
  const text = read(root, 'FORGE_MEMORY.md');
  assert.strictEqual(text, MEM_HEAD + '## Status 2026-11-09 — run forge-2026-11-09-063358 (owner R-0190)\n- closed\n\n## Status 2026-11-08 ~06:30 — PAUSED\n- old\n');
  assert.strictEqual(require(TOOL).latestStatusBlock(text).key, '2026-11-09');
});
t('CORE-1-F2: a draft whose heading is already in the file is refused and the file stays unchanged', () => {
  const root = project();
  const mem = MEM_HEAD + '## 2026-11-09 — run forge-2026-11-09-063358\n- closed\n';
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), mem);
  for (const d of ['## 2026-11-09 — run forge-2026-11-09-063358\n- closed again\n', '## Status 2026-11-09 — run forge-2026-11-09-063358\n- x\n']) {
    const r = run(root, ['append', '--file', 'FORGE_MEMORY.md', '--from', draft(root, d)]);
    assert.notStrictEqual(r.status, 0, 'accepted a duplicate: ' + d);
    assert.ok(/REFUSED: .*already/.test(r.stderr), r.stderr);
  }
  assert.strictEqual(read(root, 'FORGE_MEMORY.md'), mem);
  const hist = '# History\n\n## 2026-11-09 — run forge-2026-11-09-063358\n- a\n';
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_TASK_HISTORY.md'), hist);
  const h = run(root, ['append', '--file', 'FORGE_TASK_HISTORY.md', '--from', draft(root, '## 2026-11-09 — run forge-2026-11-09-063358\n- a\n')]);
  assert.notStrictEqual(h.status, 0, 'history duplicate accepted');
  assert.strictEqual(read(root, 'FORGE_TASK_HISTORY.md'), hist);
});
t('CORE-1-F2: a headingless draft already in the file (a byte-identical ledger row) is refused', () => {
  const root = project();
  const row = '| 2026-11-09 | forge-2026-11-09-063358 | Build Boss | WP-BRIDGE | opus/medium |';
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_AGENT_LEDGER.md'), '# Ledger\n' + row + '\n');
  const r = run(root, ['append', '--file', 'FORGE_AGENT_LEDGER.md', '--from', draft(root, row + '\n')]);
  assert.notStrictEqual(r.status, 0, 'duplicate row accepted');
  assert.ok(/already/.test(r.stderr), r.stderr);
  assert.strictEqual(read(root, 'FORGE_AGENT_LEDGER.md'), '# Ledger\n' + row + '\n');
  const ok = run(root, ['append', '--file', 'FORGE_AGENT_LEDGER.md', '--from', draft(root, row.replace('WP-BRIDGE', 'WP-APK') + '\n')]);
  assert.strictEqual(ok.status, 0, 'a different row must still append: ' + ok.stderr);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
