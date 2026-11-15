#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-memory-order.test.cjs — SD-MEM. Two memory defects, mitigated by hand once:
 *  - the snapshot MISSION block was copied verbatim forever, so it still named a mission closed weeks earlier and came
 *    back after every compaction;
 *  - `forge-run-file.cjs append` put new `## Status` blocks at the BOTTOM of FORGE_MEMORY.md while the file's own header
 *    and forge-snapshot read the TOP as the latest.
 * Guards: latestStatusBlock picks by date (not position), a stale mission is refreshed with a source line, a fresh one
 * is kept byte-identical, a status block appended to FORGE_MEMORY.md lands on top, and the doctor order check is red
 * on the old order. Fixtures are trimmed copies of the shape before the hand fix; every root is a fresh temp folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const load = (p) => { try { return require(p); } catch (e) { return { _loadError: e.message }; } };
const snap = load('./forge-snapshot.cjs');
const runFile = load('./forge-run-file.cjs');
const order = load('./doctor/checks-memory-order.cjs');
const fn = (mod, name) => { if (typeof mod[name] !== 'function') throw new Error(name + ' is not exported' + (mod._loadError ? ' (' + mod._loadError + ')' : '')); return mod[name]; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-order-'));
function project() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}
const write = (root, rel, text) => { const p = path.join(root, '.claude', rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (root, rel) => fs.readFileSync(path.join(root, '.claude', rel), 'utf8');
function writeRun(root, runId, iso) {
  const ev = (o) => JSON.stringify(Object.assign({ run_id: runId, timestamp: iso }, o));
  write(root, 'forge-runs/' + runId + '/events.jsonl', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'default skills' }),
    ev({ event_type: 'subagent_completed', agent: 'Build Boss', note: 'lane done' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: '12/12 green' }),
  ].join('\n') + '\n');
}

// The FORGE_MEMORY.md shape before the hand fix (trimmed): header says newest on top, the newest blocks sit at the bottom.
const HEADER = '# Forge Memory (project-local)\n\n> New entries go at the TOP of this file as `## Status <date> — …`\n> (newest first; forge-snapshot reads the topmost `## ` block as the latest status).\n\n';
const OLD_MEMORY = HEADER
  + '## Status 2026-11-04 — redesign closed out\n- rotator confirmed running\n- owner queue closed PARTIAL\n\n'
  + '## Status 2026-11-01 — modernization FINALIZED\n- receipt written\n\n'
  + '## Active decisions (still in force)\n- one writer per file\n\n'
  + '## Status 2026-11-02 ~06:00 — run forge-2026-11-01-forge-systeem RESUMED\n- closing phase\n\n'
  + '## Status 2026-11-02 ~21:00 — runs forge-2026-11-02-owner-queue-3 FINALIZED\n- contract OK\n\n'
  + '## Status 2026-11-07 — run forge-2026-11-07-category-tests: category tests done\n- Round 7 CONTRACT OK in all three\n- Open: G-FP4\n- Next: round 8\n- fourth line not copied\n';
const NEW_MEMORY = HEADER
  + '## Status 2026-11-07 — run forge-2026-11-07-category-tests: category tests done\n- Round 7 CONTRACT OK in all three\n- Open: G-FP4\n- Next: round 8\n- fourth line not copied\n\n'
  + '## Status 2026-11-04 — redesign closed out\n- rotator confirmed running\n- owner queue closed PARTIAL\n\n'
  + '## Status 2026-11-02 ~21:00 — runs forge-2026-11-02-owner-queue-3 FINALIZED\n- contract OK\n\n'
  + '## Status 2026-11-02 ~06:00 — run forge-2026-11-01-forge-systeem RESUMED\n- closing phase\n\n'
  + '## Status 2026-11-01 — modernization FINALIZED\n- receipt written\n\n'
  + '## Active decisions (still in force)\n- one writer per file\n';
// The snapshot MISSION block before the hand fix (trimmed): a paused mission of 2026-09-27.
const OLD_MISSION = '<!-- MISSION:BEGIN -->\n**PAUSED on 2026-09-27 — mission v2.9.0 (run `forge-2026-09-26-dashboard-discord-usage`).** Read RESUME.md first.\n<!-- MISSION:END -->';
const FRESH_MISSION = '<!-- MISSION:BEGIN -->\n**Mission as of 2026-11-08 (run `forge-2026-11-07-232519`).** Default skills for every agent.\n<!-- MISSION:END -->';
const snapshotWith = (block) => '# FORGE SNAPSHOT — old\n\n## 1. Mission\n' + block + '\n\n## 2. Why\nold why\n';

console.log('forge-memory-order tests (SD-MEM)');

t('latest by date not position', () => {
  const latest = fn(snap, 'latestStatusBlock');
  const b = latest(OLD_MEMORY);
  assert.ok(b, 'a status block is found');
  assert.ok(/^## Status 2026-11-07 /.test(b.heading), 'got ' + (b && b.heading));
  assert.strictEqual(b.key, '2026-11-07');
  assert.strictEqual(OLD_MEMORY.slice(b.start, b.end).split('\n')[0], b.heading);
  assert.strictEqual(b.end, OLD_MEMORY.length, 'the bottom block ends at the end of the file');
  const timed = latest(HEADER + '## Status 2026-11-02 ~06:00 — a\n- x\n\n## Status 2026-11-02 ~21:00 — b\n- y\n');
  assert.strictEqual(timed.key, '2026-11-02 21:00', 'the later time on the same date wins');
  assert.strictEqual(latest('# no status here\n## Active decisions\n'), null);
  assert.strictEqual(latest(null), null, 'total on bad input');
  assert.strictEqual(fn(runFile, 'latestStatusBlock'), latest, 'one implementation, exported from both modules');
});

t('missionIsStale: older run id or a date more than 7 days before the newest work', () => {
  const stale = fn(snap, 'missionIsStale');
  assert.strictEqual(stale(OLD_MISSION, 'forge-2026-11-07-232519', '2026-11-07T23:30:00Z'), true, 'older run id');
  assert.strictEqual(stale('<!-- MISSION:BEGIN -->\nBuild it (set 2026-10-20).\n<!-- MISSION:END -->', 'demo-run', '2026-11-07T10:00:00Z'), true, 'date 18 days old');
  assert.strictEqual(stale('<!-- MISSION:BEGIN -->\nBuild it (set 2026-11-03).\n<!-- MISSION:END -->', 'demo-run', '2026-11-07T10:00:00Z'), false, 'date 4 days old');
  assert.strictEqual(stale(FRESH_MISSION, 'forge-2026-11-07-232519', '2026-11-07T23:30:00Z'), false, 'names the newest run');
  assert.strictEqual(stale('<!-- MISSION:BEGIN -->\nBuild the thing.\n<!-- MISSION:END -->', 'forge-2026-11-07-x', '2026-11-07T10:00:00Z'), false, 'no run id, no date: cannot tell, keep');
  assert.strictEqual(stale(OLD_MISSION, null, null), false, 'no newest work known: keep');
  assert.strictEqual(stale(null, 'forge-2026-11-07-x', '2026-11-07T10:00:00Z'), false, 'total on bad input');
});

t('stale mission refreshed', () => {
  const root = project();
  write(root, 'FORGE_MEMORY.md', OLD_MEMORY);
  write(root, 'FORGE_SNAPSHOT.md', snapshotWith(OLD_MISSION));
  writeRun(root, 'forge-2026-11-07-232519', '2026-11-07T23:30:00.000Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-11-08T00:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-11-07-232519', 'the fixture run is the newest work run');
  const block = r.mission.block;
  assert.ok(!block.includes('v2.9.0'), 'the stale text is gone:\n' + block);
  assert.ok(block.startsWith('<!-- MISSION:BEGIN -->\n') && block.endsWith('\n<!-- MISSION:END -->'), 'still inside the markers');
  assert.ok(block.includes('Status 2026-11-07 — run forge-2026-11-07-category-tests: category tests done'), 'newest status heading');
  assert.ok(!/^#/m.test(block), 'no markdown heading inside section 1:\n' + block);
  for (const l of ['- Round 7 CONTRACT OK in all three', '- Open: G-FP4', '- Next: round 8']) assert.ok(block.includes(l), 'first 3 lines: ' + l);
  assert.ok(!block.includes('fourth line not copied'), 'only the first 3 lines');
  assert.ok(/refreshed/i.test(block) && block.includes('FORGE_MEMORY.md') && block.includes('forge-2026-11-07-232519'), 'a line says where it came from and why:\n' + block);
  assert.ok(/refreshed/i.test(r.mission.source), 'the source says it was refreshed: ' + r.mission.source);
  assert.ok(read(root, 'FORGE_SNAPSHOT.md').includes(block), 'written to the snapshot file');
  const again = snap.write({ root, reason: 'manual', now: new Date('2026-11-08T01:00:00Z') });
  assert.strictEqual(again.mission.block, block, 'the refreshed block is stable on the next regeneration');
});

t('fresh mission kept', () => {
  const root = project();
  write(root, 'FORGE_MEMORY.md', NEW_MEMORY);
  write(root, 'FORGE_SNAPSHOT.md', snapshotWith(FRESH_MISSION));
  writeRun(root, 'forge-2026-11-07-232519', '2026-11-07T23:30:00.000Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-11-08T00:00:00Z') });
  assert.strictEqual(r.mission.block, FRESH_MISSION, 'byte-identical');
  assert.ok(/preserved verbatim/.test(r.mission.source));
});

t('memory append goes on top', () => {
  const root = project();
  write(root, 'FORGE_MEMORY.md', NEW_MEMORY);
  const add = fn(runFile, 'appendMemoryFile');
  const r = add({ file: 'FORGE_MEMORY.md', content: '\n## Status 2026-11-08 ~10:00 — lane B7 merged\n- memory order fixed\n' }, { root });
  assert.ok(r.ok, r.reason);
  const text = read(root, 'FORGE_MEMORY.md');
  assert.ok(text.startsWith(HEADER), 'the header stays first');
  const first = text.match(/^## .*$/m)[0];
  assert.strictEqual(first, '## Status 2026-11-08 ~10:00 — lane B7 merged', 'the new block is the first ## block');
  assert.ok(text.includes('- memory order fixed\n\n## Status 2026-11-07 '), 'one blank line before the old top block');
  assert.ok(text.endsWith('## Active decisions (still in force)\n- one writer per file\n'), 'the rest is unchanged');
  assert.strictEqual(text.length, NEW_MEMORY.length + '## Status 2026-11-08 ~10:00 — lane B7 merged\n- memory order fixed\n\n'.length);
  assert.strictEqual(fn(snap, 'latestStatusBlock')(text).key, '2026-11-08 10:00');
  // a plain note (no status heading) and other memory files keep appending at the end
  assert.ok(add({ file: 'FORGE_MEMORY.md', content: 'tail note\n' }, { root }).ok);
  assert.ok(read(root, 'FORGE_MEMORY.md').endsWith('- one writer per file\ntail note\n'));
  write(root, 'FORGE_TASK_HISTORY.md', '# History\n\n## Status 2026-11-01 — old\n');
  assert.ok(add({ file: 'FORGE_TASK_HISTORY.md', content: '## Status 2026-11-08 — new\n' }, { root }).ok);
  assert.strictEqual(read(root, 'FORGE_TASK_HISTORY.md'), '# History\n\n## Status 2026-11-01 — old\n## Status 2026-11-08 — new\n');
  // a memory file without any ## heading: the status block is appended
  const bare = project();
  write(bare, 'FORGE_MEMORY.md', '# Memory\n');
  assert.ok(add({ file: 'FORGE_MEMORY.md', content: '## Status 2026-11-08 — first\n' }, { root: bare }).ok);
  assert.strictEqual(read(bare, 'FORGE_MEMORY.md'), '# Memory\n## Status 2026-11-08 — first\n');
});

t('order check', () => {
  const check = fn(order, 'memoryOrderCheck');
  const root = project();
  write(root, 'FORGE_MEMORY.md', OLD_MEMORY);
  const red = check(root);
  assert.strictEqual(red.ok, false, 'red on the old order');
  assert.ok(red.problems.length >= 1);
  const all = red.problems.join('\n');
  assert.ok(all.includes('2026-11-07') && all.includes('2026-11-04'), 'names the newer block and the older one above it:\n' + all);
  assert.ok(all.includes('2026-11-02 ~06:00') || all.includes('2026-11-02 06:00'), 'the out-of-order 11-02 block is named too:\n' + all);
  write(root, 'FORGE_MEMORY.md', NEW_MEMORY);
  const green = check(root);
  assert.strictEqual(green.ok, true, 'green after the reorder: ' + green.problems.join('; '));
  assert.deepStrictEqual(green.problems, []);
  const none = check(project());
  assert.strictEqual(none.ok, true, 'no memory file is not a problem');
  assert.deepStrictEqual(none.problems, []);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
