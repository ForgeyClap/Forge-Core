#!/usr/bin/env node
'use strict';
// forge-secret-scrub.test.cjs — tests the advisory runtime-artifact secret scanner. Uses
// OBVIOUSLY-FAKE strings shaped to match forge-store's real SECRET_PATTERNS (never a real secret). The
// load-bearing test is that output reports LOCATION ONLY and never echoes the matched secret text.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scrub = require('./forge-secret-scrub.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

// obviously fake, but matches /sk-[A-Za-z0-9_-]{20,}/ and /nvapi-[A-Za-z0-9_-]+/ shapes
const FAKE_SK = 'sk-' + 'x'.repeat(24);
const FAKE_NV = 'nvapi-' + 'y'.repeat(16);

console.log('forge-secret-scrub tests');

t('patterns actually loaded from forge-store (single source of truth)', () => {
  assert.ok(scrub.PATTERN_COUNT > 0, 'expected >0 shared secret patterns');
});

t('detects a fake OpenAI-shaped key and reports file/line/pattern', () => {
  const hits = scrub.scanText('line one\nsome token=' + FAKE_SK + ' here\nline three', 'events.jsonl');
  assert.ok(hits.length >= 1, 'expected a hit');
  assert.strictEqual(hits[0].file, 'events.jsonl');
  assert.strictEqual(hits[0].line, 2, 'hit is on line 2');
  assert.ok(/^secret-pattern#\d+$/.test(hits[0].pattern), 'pattern is a numbered label');
});

t('HONESTY: output never contains the matched secret text', () => {
  const hits = scrub.scanText('key=' + FAKE_SK + '\nnvidia=' + FAKE_NV, 'mem.md');
  const dump = JSON.stringify(hits);
  assert.ok(!dump.includes(FAKE_SK), 'must NOT echo the sk- secret');
  assert.ok(!dump.includes(FAKE_NV), 'must NOT echo the nvapi- secret');
  assert.ok(!dump.includes('xxxx'), 'must not leak any of the secret body');
});

t('clean text produces zero hits', () => {
  assert.strictEqual(scrub.scanText('nothing secret here\njust normal log lines\nrun completed', 'x').length, 0);
});

t('scanFile reads a real file and detects a planted fake secret', () => {
  const f = path.join(os.tmpdir(), 'forge-scrub-test-' + process.pid + '.jsonl');
  fs.writeFileSync(f, '{"event":"agent_note","note":"ok"}\n{"leak":"' + FAKE_SK + '"}\n');
  const hits = scrub.scanFile(f);
  assert.ok(hits.length >= 1 && hits[0].line === 2);
  try { fs.unlinkSync(f); } catch {}
});

t('scan() over an explicit clean file returns clean:true, hits:[]', () => {
  const f = path.join(os.tmpdir(), 'forge-scrub-clean-' + process.pid + '.jsonl');
  fs.writeFileSync(f, '{"event":"run_completed"}\n');
  const r = scrub.scan([f]);
  assert.strictEqual(r.clean, true);
  assert.strictEqual(r.hits.length, 0);
  assert.strictEqual(r.scanned, 1);
  try { fs.unlinkSync(f); } catch {}
});

t('scanFile on a nonexistent file is a safe empty result (never throws)', () => {
  assert.deepStrictEqual(scrub.scanFile(path.join(os.tmpdir(), 'nope-' + process.pid + '.xyz')), []);
});

t('WP-9b: defaultTargets() includes the rotated FORGE_MEMORY_ARCHIVE_*.md files and a secret in one is found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scrub-archive-'));
  try {
    fs.writeFileSync(path.join(dir, 'FORGE_MEMORY.md'), '# current state\nclean\n');
    fs.writeFileSync(path.join(dir, 'FORGE_MEMORY_ARCHIVE_2026-10.md'), '# archive\nold note\nleak ' + FAKE_SK + '\n');
    fs.writeFileSync(path.join(dir, 'FORGE_MEMORY_ARCHIVE_2026-09.md'), '# older archive\nclean\n');
    fs.writeFileSync(path.join(dir, 'FORGE_MEMORY_ARCHIVE_notes.txt'), 'not markdown ' + FAKE_SK + '\n');
    fs.mkdirSync(path.join(dir, 'FORGE_MEMORY_ARCHIVE_dir.md'));
    const targets = scrub.defaultTargets(dir).map((p) => path.basename(p));
    assert.deepStrictEqual(targets, ['FORGE_MEMORY.md', 'FORGE_MEMORY_ARCHIVE_2026-09.md', 'FORGE_MEMORY_ARCHIVE_2026-10.md']);
    const r = scrub.scan(scrub.defaultTargets(dir));
    assert.strictEqual(r.clean, false);
    assert.ok(r.hits.every((h) => path.basename(h.file) === 'FORGE_MEMORY_ARCHIVE_2026-10.md' && h.line === 3), JSON.stringify(r.hits));
    assert.ok(!JSON.stringify(r).includes(FAKE_SK), 'location only, never the secret');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('WP-9b: memoryArchiveFiles() on a missing directory is [] (never throws)', () => {
  assert.deepStrictEqual(scrub.memoryArchiveFiles(path.join(os.tmpdir(), 'no-such-dir-' + process.pid)), []);
});

// WP 1.9: forge-memory-consolidate.cjs (WP 1.4) archives history/ledger/decisions as
// FORGE_<NAME>_ARCHIVE_<YYYY-MM>[-b].md, distills Boss memory into agent-memory/<agent>/lessons-archive-*.md and
// builds LESSONS.md. All of them hold verbatim memory text, so all of them are scanned like FORGE_MEMORY_ARCHIVE_*.md.
t('WP 1.9: defaultTargets() also scans every FORGE_*_ARCHIVE_*.md, LESSONS.md and agent-memory/*/lessons-archive-*.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scrub-archive19-'));
  try {
    fs.writeFileSync(path.join(dir, 'FORGE_MEMORY.md'), '# current state\nclean\n');
    fs.writeFileSync(path.join(dir, 'LESSONS.md'), '| lesson | evidence |\n| leak ' + FAKE_SK + ' | x |\n');
    for (const n of ['FORGE_TASK_HISTORY_ARCHIVE_2026-10.md', 'FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.md', 'FORGE_MEMORY_ARCHIVE_2026-10-24.md']) {
      fs.writeFileSync(path.join(dir, n), '# archive\nkey ' + FAKE_NV + '\n');
    }
    fs.writeFileSync(path.join(dir, 'FORGE_DECISIONS_ARCHIVE_2026-10.txt'), 'not markdown ' + FAKE_SK + '\n');
    fs.writeFileSync(path.join(dir, 'forge_memory_archive_2026-10.md'), 'lower case is not a Forge archive ' + FAKE_SK + '\n');
    fs.mkdirSync(path.join(dir, 'agent-memory', 'build-boss'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agent-memory', 'verify-boss'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-memory', 'build-boss', 'lessons-archive-2026-10-23.md'), '# archive\nleak ' + FAKE_SK + '\n');
    fs.writeFileSync(path.join(dir, 'agent-memory', 'build-boss', 'lessons-archive-2026-09-27b.md'), 'clean\n');
    fs.writeFileSync(path.join(dir, 'agent-memory', 'build-boss', 'MEMORY.md'), 'live file is git-tracked, the doctor leak scan covers it\n');
    fs.writeFileSync(path.join(dir, 'agent-memory', 'verify-boss', 'lessons-archive-2026-10-23.md'), 'clean\n');
    fs.mkdirSync(path.join(dir, 'agent-memory', 'verify-boss', 'lessons-archive-dir.md'));
    fs.mkdirSync(path.join(dir, 'agent-memory', 'deep', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-memory', 'deep', 'nested', 'lessons-archive-2026-10-23.md'), 'two levels down: out of scope\n');
    const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
    const targets = scrub.defaultTargets(dir).map(rel);
    assert.deepStrictEqual(targets, [
      'FORGE_MEMORY.md', 'LESSONS.md',
      'FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.md', 'FORGE_MEMORY_ARCHIVE_2026-10-24.md', 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md',
      'agent-memory/build-boss/lessons-archive-2026-09-27b.md', 'agent-memory/build-boss/lessons-archive-2026-10-23.md', 'agent-memory/verify-boss/lessons-archive-2026-10-23.md',
    ]);
    const r = scrub.scan(scrub.defaultTargets(dir));
    const hitFiles = [...new Set(r.hits.map((h) => rel(h.file)))].sort();
    assert.deepStrictEqual(hitFiles, ['FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.md', 'FORGE_MEMORY_ARCHIVE_2026-10-24.md', 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md', 'LESSONS.md', 'agent-memory/build-boss/lessons-archive-2026-10-23.md']);
    assert.ok(!JSON.stringify(r).includes(FAKE_SK) && !JSON.stringify(r).includes(FAKE_NV), 'location only, never the secret');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('WP 1.9: the archive patterns accept the consolidation names and refuse look-alikes', () => {
  for (const ok of ['FORGE_MEMORY_ARCHIVE_2026-10.md', 'FORGE_TASK_HISTORY_ARCHIVE_2026-10-b.md', 'FORGE_AGENT_LEDGER_ARCHIVE_2026-10.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.md']) assert.ok(scrub.MEMORY_ARCHIVE_RE.test(ok), ok);
  for (const bad of ['FORGE_ARCHIVE_2026-10.md', 'FORGE_MEMORY_ARCHIVE_.md', 'FORGE_MEMORY_ARCHIVE_2026-10.txt', 'x/FORGE_MEMORY_ARCHIVE_2026-10.md', 'FORGE_memory_ARCHIVE_2026-10.md']) assert.ok(!scrub.MEMORY_ARCHIVE_RE.test(bad), bad);
  assert.ok(scrub.LESSONS_ARCHIVE_RE.test('lessons-archive-2026-09-27g.md') && scrub.LESSONS_ARCHIVE_RE.test('lessons-archive-2026-07-30-b.md'));
  assert.ok(!scrub.LESSONS_ARCHIVE_RE.test('lessons-archive-2026-10-23.txt') && !scrub.LESSONS_ARCHIVE_RE.test('MEMORY.md') && !scrub.LESSONS_ARCHIVE_RE.test('../lessons-archive-x.md'));
  assert.deepStrictEqual(scrub.lessonsArchiveFiles(path.join(os.tmpdir(), 'no-such-dir-' + process.pid)), []);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
