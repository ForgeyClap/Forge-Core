#!/usr/bin/env node
'use strict';
const nodeTest = require('node:test');
// The doctor and the forge-sync regression gate read the '<n> passed, <m> failed' tally line; node:test's own
// 'ℹ pass 5' summary reads as 0/0 = no evidence (26h2 sync rollback 2026-11-03).
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const X = require('./forge-export.cjs');
const REAL = path.resolve(__dirname, '..', '..');

function fake() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-export-'));
  const w = (rel, c) => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), c); };
  w('.claude/agents/ro.md', '---\nname: ro\ndescription: Reads only.\ntools: Read, Grep\nmodel: sonnet\neffort: low\nskills:\n  - s1\n---\nBody RO\n');
  w('.claude/agents/rw.md', '---\nname: rw\ndescription: Writes.\ntools: Read, Write, Bash\nmodel: opus\n---\nBody RW\n');
  w('.claude/skills/s1/SKILL.md', '---\nname: s1\ndescription: Skill one.\n---\nx');
  w('.claude/skills/s1/LICENSE', 'MIT');
  w('AGENTS.md', '# A\r\nkeep me\r\n');
  fs.mkdirSync(path.join(r, '.claude/config/orchestration'), { recursive: true });
  fs.copyFileSync(path.join(REAL, '.claude/config/orchestration/runtime-map.json'), path.join(r, '.claude/config/orchestration/runtime-map.json'));
  return r;
}

test('maps permissions, drops effort/model, lists skills, states limits', () => {
  const r = fake(); X.run(r, X.TARGETS, false);
  const ro = fs.readFileSync(path.join(r, '.opencode/agents/ro.md'), 'utf8');
  assert.match(ro, /edit: deny/); assert.match(ro, /bash: deny/); assert.doesNotMatch(ro, /^effort:/m);
  assert.doesNotMatch(ro, /^model:/m); assert.match(ro, /\.claude\/skills\/s1\/SKILL\.md/); assert.match(ro, /ADVICE, not ENFORCEMENT/);
  const rw = fs.readFileSync(path.join(r, '.opencode/agents/rw.md'), 'utf8');
  assert.match(rw, /edit: allow/); assert.match(rw, /bash: allow/);
  assert.match(fs.readFileSync(path.join(r, 'GEMINI.md'), 'utf8'), /LICENSE beside it/);
});
test('AGENTS.md: owner text kept, one generated section, idempotent', () => {
  const r = fake(); X.run(r, X.TARGETS, false);
  const a = fs.readFileSync(path.join(r, 'AGENTS.md'), 'utf8');
  assert.match(a, /keep me/); assert.strictEqual(a.split(X.BEGIN).length, 2);
  assert.deepStrictEqual(X.run(r, X.TARGETS, false).diffs, []);
});
test('no credentials: keys only as {env:VAR}', () => {
  const r = fake(); X.run(r, X.TARGETS, false);
  const j = JSON.parse(fs.readFileSync(path.join(r, '.opencode/opencode.json'), 'utf8'));
  assert.strictEqual(j.provider['forge-eigen-api'].options.apiKey, '{env:FORGE_EIGEN_API_KEY}');
  assert.doesNotMatch(JSON.stringify(j), /sk-/);
});
test('drift is detected after a manual edit', () => {
  const r = fake(); X.run(r, X.TARGETS, false);
  fs.appendFileSync(path.join(r, 'GEMINI.md'), 'tampered');
  assert.deepStrictEqual(X.run(r, X.TARGETS, true).diffs, ['GEMINI.md']);
  const p = spawnSync(process.execPath, [path.join(__dirname, 'forge-export.cjs'), 'all', '--check', '--root', r]);
  assert.strictEqual(p.status, 1);
});
// `forge-export.cjs --help` used to fall through to target "all" and WRITE AGENTS.md/GEMINI.md.
test('--help / -h prints usage and writes nothing; an unknown flag is refused (exit 2) and writes nothing', () => {
  const r = fake();
  const before = fs.readFileSync(path.join(r, 'AGENTS.md'), 'utf8');
  for (const flag of ['--help', '-h']) {
    const p = spawnSync(process.execPath, [path.join(__dirname, 'forge-export.cjs'), flag, '--root', r], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.match(p.stdout, /Usage: node forge-export\.cjs/);
  }
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'forge-export.cjs'), '--dry-run', '--root', r], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /unknown option --dry-run/);
  assert.strictEqual(fs.readFileSync(path.join(r, 'AGENTS.md'), 'utf8'), before);
  assert.strictEqual(fs.existsSync(path.join(r, 'GEMINI.md')), false);
  fs.rmSync(r, { recursive: true, force: true });
});
// The generated files (.opencode/**, GEMINI.md, the AGENTS.md section) are per-project and never shipped, so a
// synced project has none: there the real-tree drift check cannot pass by design (26h2 sync rollback 2026-11-02).
// In the dev tree the committed export must have no drift; elsewhere the project's own agents and skills are
// exported into a temp copy and must be drift-free right after generation (the portable analogue).
const DEV_TREE = fs.existsSync(path.join(REAL, '.claude', 'config', 'forge-dev-tree.json'));
test('real tree: generated export has no drift (dev tree) / exports cleanly (synced project)', () => {
  if (DEV_TREE) {
    const p = spawnSync(process.execPath, [path.join(__dirname, 'forge-export.cjs'), 'all', '--check'], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    return;
  }
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-export-real-'));
  try {
    for (const rel of ['.claude/agents', '.claude/skills']) {
      if (fs.existsSync(path.join(REAL, rel))) fs.cpSync(path.join(REAL, rel), path.join(r, rel), { recursive: true });
    }
    fs.mkdirSync(path.join(r, '.claude/config/orchestration'), { recursive: true });
    fs.copyFileSync(path.join(REAL, '.claude/config/orchestration/runtime-map.json'), path.join(r, '.claude/config/orchestration/runtime-map.json'));
    if (fs.existsSync(path.join(REAL, 'AGENTS.md'))) fs.copyFileSync(path.join(REAL, 'AGENTS.md'), path.join(r, 'AGENTS.md'));
    X.run(r, X.TARGETS, false);
    assert.deepStrictEqual(X.run(r, X.TARGETS, true).diffs, []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
