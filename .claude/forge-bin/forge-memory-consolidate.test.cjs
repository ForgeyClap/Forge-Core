#!/usr/bin/env node
'use strict';
// forge-memory-consolidate.test.cjs — tests for the zero-loss memory consolidator (plan item 1.4). Every fixture
// lives in a fresh os.tmpdir() folder that is removed at the end; this file never touches the real .claude/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const M = require('./forge-memory-consolidate.cjs');

let passed = 0, failed = 0;
const dirs = [];
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const NOW = '2026-10-24T08:00:00.000Z';
const TOOL = path.join(__dirname, 'forge-memory-consolidate.cjs');

function filler(seed, n) { return Array.from({ length: n }, (_, i) => '- detail ' + seed + '-' + i + ' ' + 'x'.repeat(60)).join('\r\n'); }
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmc-')); dirs.push(root);
  const cd = path.join(root, '.claude'); fs.mkdirSync(path.join(cd, 'agent-memory', 'test-boss'), { recursive: true });
  fs.mkdirSync(path.join(cd, 'agent-memory', 'global'), { recursive: true });
  // history: newest-first block then an appended block, mixed order like the real file; CRLF line ends
  const days = ['2026-09-24', '2026-08-06', '2026-07-01', '2026-06-27', '2026-10-01', '2026-10-11'];
  const hist = ['# Forge Task History', ''].concat(days.flatMap((d) => ['## ' + d + ' — run ' + d, filler(d, 140), ''])).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md'), hist);
  const dec = ['# Forge Decisions Log', '', '| Date/time | Decision | Reason |', '|---|---|---|', '| 2026-06-27 | Founding choice | why |', '',
    '## 2026-07-04 (old)', '- 2026-07-04: **Plugin opt-in** (SUPERSEDES the 2026-07-02 auto-provision).', filler('d1', 400), '',
    '## 2026-10-10 (new)', '- Decision: no version number (supersedes the A/B choice).', filler('d2', 400), ''].join('\n') + '\n';
  fs.writeFileSync(path.join(cd, 'FORGE_DECISIONS.md'), dec);
  fs.writeFileSync(path.join(cd, 'FORGE_AGENT_LEDGER.md'), '# Forge Agent Activity Ledger\n\n## Run small (2026-10-01)\n| a | b |\n');
  const mem = ['# Test Boss — Memory Index', '', 'Prose intro line.', '', '## Lessons', '']
    .concat(Array.from({ length: 60 }, (_, i) => '- Lesson ' + i + ' opening sentence about verification, e.g. a probe. ' + 'More detail '.repeat(30)), ['2026-10-09 dated pattern line -> build route']);
  fs.writeFileSync(path.join(cd, 'agent-memory', 'test-boss', 'MEMORY.md'), mem.join('\n') + '\n');
  const rec = (id, text, ts) => JSON.stringify({ id, type: 'semantic', tags: [], text, evidence: JSON.stringify({ run_id: 'run-' + id }), ts });
  fs.writeFileSync(path.join(cd, 'agent-memory', 'global', 'lessons.jsonl'),
    [rec('a1', 'Repeat this lesson', '2026-08-01T00:00:00Z'), rec('a2', 'repeat  this lesson', '2026-08-02T00:00:00Z'), rec('a3', 'Repeat this lesson', '2026-08-03T00:00:00Z'), rec('b1', 'A single | piped lesson', '2026-09-01T00:00:00Z')].join('\n') + '\n');
  return root;
}
function snapshot(root) {
  const out = {};
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = sha(fs.readFileSync(p)); } })(root);
  return out;
}
const runApply = (root, extra) => M.run(Object.assign({ root, apply: true, now: NOW }, extra));
const lines = (b) => M.splitLines(b).length;

t('dry-run (default) writes nothing', () => {
  const root = makeRoot(); const before = snapshot(root);
  const r = M.run({ root, now: NOW });
  assert.strictEqual(r.mode, 'dry-run'); assert.ok(r.plans.length >= 2, 'expected plans');
  assert.deepStrictEqual(snapshot(root), before);
  const cli = spawnSync(process.execPath, [TOOL, '--root', root, '--now', NOW], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr); assert.match(cli.stdout, /dry-run: nothing written/);
  assert.deepStrictEqual(snapshot(root), before);
});

t('rotation keeps the newest sections + preamble, archives the rest, header sha256 recomputes', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude');
  const orig = fs.readFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md'));
  runApply(root);
  const live = fs.readFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md'));
  const arcPath = path.join(cd, 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md'); const arc = fs.readFileSync(arcPath);
  assert.ok(orig.length > M.ROTATE_THRESHOLD && live.length <= M.ROTATE_THRESHOLD, 'live ' + live.length);
  const s = live.toString();
  assert.ok(s.startsWith('# Forge Task History\r\n'), 'title kept');
  assert.ok(s.includes('## 2026-10-11') && s.includes('## 2026-10-01'), 'newest kept');
  assert.ok(!s.includes('## 2026-06-27') && arc.toString().includes('## 2026-06-27'), 'oldest archived');
  assert.ok(s.indexOf('## 2026-10-01') < s.indexOf('## 2026-10-11'), 'original order kept');
  const h = arc.toString().split(M.MARKER)[0];
  assert.match(h, /Source file: `\.claude\/FORGE_TASK_HISTORY\.md`/); assert.match(h, /Moved on \(UTC\): 2026-10-24T08:00:00\.000Z/);
  const body = arc.subarray(arc.indexOf(M.MARKER) + M.MARKER.length + 2);
  assert.ok(h.includes('sha256: `' + sha(body) + '`'), 'header sha256 = recomputed body sha256');
  assert.ok(h.includes('lines: ' + lines(body) + ' '), 'header line count = body lines');
  assert.ok(M.readArchive(arc).ok);
  const cli = spawnSync(process.execPath, [TOOL, 'verify', arcPath], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0); assert.match(cli.stdout, /^OK /);
});

t('line-count invariant + byte-exact reconstruction (archive body + live minus pointer = original)', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude');
  const orig = { h: fs.readFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md')), d: fs.readFileSync(path.join(cd, 'FORGE_DECISIONS.md')) };
  runApply(root);
  for (const [k, name] of [['h', 'FORGE_TASK_HISTORY'], ['d', 'FORGE_DECISIONS']]) {
    const live = fs.readFileSync(path.join(cd, name + '.md')); const arc = fs.readFileSync(path.join(cd, name + '_ARCHIVE_2026-10.md'));
    const ptr = live.toString().split(/\n/).findIndex((l) => l.startsWith(M.PTR_BEGIN));
    const ptrEnd = live.toString().split(/\n/).findIndex((l) => l.startsWith(M.PTR_END));
    assert.ok(ptr >= 0 && ptrEnd > ptr, name + ' pointer block');
    assert.strictEqual(M.readArchive(arc).lines + lines(live) - (ptrEnd - ptr + 1), lines(orig[k]), name + ' line invariant');
    assert.ok(M.verifyRotation(live, arc, orig[k]).ok, name + ' reconstruct');
  }
  const dec = fs.readFileSync(path.join(cd, 'FORGE_DECISIONS.md'), 'utf8');
  assert.ok(dec.includes('| 2026-06-27 | Founding choice'), 'decisions preamble table kept');
});

t('refuses on a mismatching plan and writes nothing', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude'); const before = snapshot(root);
  const plan = M.planRotation(cd, 'FORGE_TASK_HISTORY.md', NOW);
  const ls = M.splitLines(plan.newLiveBuf); plan.newLiveBuf = Buffer.concat(ls.slice(0, -3).concat(ls.slice(-2))); // one line lost
  assert.throws(() => M.commitPlan(plan, root, path.join(root, '_scratch', 'bak')), /REFUSED.*line count/);
  const plan2 = M.planRotation(cd, 'FORGE_TASK_HISTORY.md', NOW);
  plan2.archiveBuf = Buffer.from(plan2.archiveBuf.toString().replace('detail 2026-06-27-5 ', 'detail 2026-06-27-X '));
  assert.throws(() => M.commitPlan(plan2, root, path.join(root, '_scratch', 'bak')), /REFUSED.*archive/);
  assert.deepStrictEqual(snapshot(root), before);
});

t('refuses when the live file changed after planning', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude');
  const plan = M.planRotation(cd, 'FORGE_TASK_HISTORY.md', NOW);
  fs.appendFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md'), 'late line\r\n');
  assert.throws(() => M.commitPlan(plan, root, path.join(root, '_scratch', 'bak')), /changed since planning/);
  assert.ok(!fs.existsSync(plan.archivePath));
});

t('a tampered archive fails verification (CLI exit 1)', () => {
  const root = makeRoot(); runApply(root);
  const p = path.join(root, '.claude', 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md');
  fs.appendFileSync(p, 'extra\r\n');
  assert.strictEqual(M.readArchive(fs.readFileSync(p)).ok, false);
  assert.strictEqual(spawnSync(process.execPath, [TOOL, 'verify', p], { encoding: 'utf8' }).status, 1);
});

t('idempotent: a second --apply changes nothing', () => {
  const root = makeRoot(); const r1 = runApply(root); const s1 = snapshot(root);
  assert.ok(r1.written.length >= 3);
  const r2 = runApply(root);
  assert.strictEqual(r2.written.length, 0, JSON.stringify(r2.written)); assert.strictEqual(r2.plans.length, 0);
  assert.deepStrictEqual(snapshot(root), s1);
});

t('MEMORY.md distill: <=200 lines, under 20 KB, literal prefixes, full original verbatim in archive', () => {
  const root = makeRoot(); const mp = path.join(root, '.claude', 'agent-memory', 'test-boss', 'MEMORY.md');
  const orig = fs.readFileSync(mp); runApply(root);
  const live = fs.readFileSync(mp, 'utf8'); const arcName = 'lessons-archive-2026-10-24.md';
  const arc = M.readArchive(fs.readFileSync(path.join(path.dirname(mp), arcName)));
  assert.ok(arc.ok && sha(arc.body) === sha(orig) && arc.lines === lines(orig), 'archive body is the original');
  assert.ok(lines(Buffer.from(live)) <= 200 && Buffer.byteLength(live) <= M.MEMORY_THRESHOLD);
  assert.ok(live.startsWith('# Test Boss — Memory Index'));
  const src = orig.toString().split('\n');
  const bullets = live.split('\n').filter((l) => /^- Lesson/.test(l));
  assert.strictEqual(bullets.length, 60);
  for (const b of bullets) {
    const m = b.match(/^- (.*?)(?: …)? — \[lessons-archive-2026-10-24\.md L(\d+)\]/); assert.ok(m, b);
    const archLine = arc.body.toString().split('\n')[Number(m[2]) - arc.headerLines - 1];
    assert.ok(archLine.startsWith('- ' + m[1]), 'pointer line holds the full lesson: ' + m[1]);
    assert.ok(src.includes(archLine));
  }
  assert.ok(!/e\.g\. —/.test(live), 'sentence cut does not stop at e.g.');
});

t('LESSONS.md: <=200 lines, merges repeats, marks supersedes, only source text', () => {
  const root = makeRoot(); runApply(root);
  const L = fs.readFileSync(path.join(root, '.claude', 'LESSONS.md'), 'utf8');
  assert.ok(L.split('\n').length <= 201);
  assert.match(L, /\| Repeat this lesson \(repeated 3×: preference candidate\) \| agent-memory\/global\/lessons\.jsonl L1/);
  assert.match(L, /A single \\\| piped lesson/);
  assert.match(L, /dated pattern line -> build route \| agent-memory\/test-boss\/MEMORY\.md L\d+ \| 2026-10-09/);
  assert.match(L, /SUPERSEDES the 2026-07-02 auto-provision.*FORGE_DECISIONS_ARCHIVE_2026-10\.md L\d+ \| 2026-07-04/);
  assert.match(L, /supersedes the A\/B choice.*FORGE_DECISIONS\.md L\d+/);
  const arcLines = fs.readFileSync(path.join(root, '.claude', 'FORGE_DECISIONS_ARCHIVE_2026-10.md'), 'utf8').split('\n');
  const n = Number(L.match(/FORGE_DECISIONS_ARCHIVE_2026-10\.md L(\d+)/)[1]);
  assert.match(arcLines[n - 1], /SUPERSEDES the 2026-07-02/, 'evidence pointer lands on the line');
});

t('a file between the keep target and 50 KB is left alone', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude');
  const txt = ['# Forge Agent Activity Ledger', ''].concat(['2026-08-01', '2026-09-01', '2026-10-01'].flatMap((d) => ['## Run ' + d, filler(d, 180), ''])).join('\n') + '\n';
  fs.writeFileSync(path.join(cd, 'FORGE_AGENT_LEDGER.md'), txt);
  assert.ok(txt.length > 32 * 1024 && txt.length < M.ROTATE_THRESHOLD, 'fixture size ' + txt.length);
  const r = runApply(root, { only: 'FORGE_AGENT_LEDGER.md' });
  assert.strictEqual(r.written.length, 0); assert.strictEqual(fs.readFileSync(path.join(cd, 'FORGE_AGENT_LEDGER.md'), 'utf8'), txt);
});

t('--only restricts the run to one file', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude');
  const r = runApply(root, { only: 'FORGE_DECISIONS.md' });
  assert.deepStrictEqual(r.written.map((w) => w.file), ['.claude/FORGE_DECISIONS.md']);
  assert.ok(!fs.existsSync(path.join(cd, 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md')) && !fs.existsSync(path.join(cd, 'LESSONS.md')));
});

t('a later rotation adds a -b archive and keeps the earlier pointer; backups never overwrite', () => {
  const root = makeRoot(); const cd = path.join(root, '.claude'); runApply(root);
  const hp = path.join(cd, 'FORGE_TASK_HISTORY.md'); const mid = fs.readFileSync(hp);
  fs.appendFileSync(hp, ['## 2026-10-20 — later', filler('late', 400), ''].join('\r\n'));
  const grown = fs.readFileSync(hp);
  runApply(root);
  const live = fs.readFileSync(hp); const arcB = fs.readFileSync(path.join(cd, 'FORGE_TASK_HISTORY_ARCHIVE_2026-10-b.md'));
  assert.ok(live.toString().includes('FORGE_TASK_HISTORY_ARCHIVE_2026-10.md') && live.toString().includes('FORGE_TASK_HISTORY_ARCHIVE_2026-10-b.md'));
  assert.ok(M.verifyRotation(live, arcB, grown).ok);
  const bak = path.join(root, '_scratch', 'memory-preconsolidate');
  const copies = fs.readdirSync(bak).filter((f) => f.startsWith('FORGE_TASK_HISTORY.md'));
  assert.strictEqual(copies.length, 2, copies.join(','));
  assert.ok(copies.some((f) => sha(fs.readFileSync(path.join(bak, f))) === sha(grown)) && mid.length > 0);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
