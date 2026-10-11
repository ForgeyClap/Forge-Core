#!/usr/bin/env node
'use strict';
// forge-snapshot-reinject.test.cjs — real tests for the SessionStart(matcher:compact) re-injection hook
// target. Every fixture runs under a fresh os.tmpdir() project — never touches this repo's real .claude/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const reinject = require('./forge-snapshot-reinject.cjs');
const snap = require('./forge-snapshot.cjs'); // real end-to-end proof, see section 6 below

// Hermetic owner settings (forge-config.cjs): the global settings file is read from a throwaway home,
// never ~/.claude, and FORGE_PROJECT_ROOT is cleared so each fixture ROOT decides which project file is read.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reinj-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;
// the per-compaction claim lives outside the project (OS temp); every test here uses its own folder.
const CLAIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reinj-claims-'));
process.env.FORGE_REINJECT_CLAIM_DIR = CLAIM_DIR;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeDue(root, overrides) {
  const dir = path.join(root, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge-snapshot-due.json'), JSON.stringify(Object.assign({
    reason: 'precompact-auto', compaction_type: 'auto', session_id: 's1', transcript_path: null, at: new Date().toISOString(),
  }, overrides || {})));
}
function writeSnapshot(root, sections) {
  const md = [
    '# FORGE SNAPSHOT — test',
    '',
    '## 1. Mission',
    sections.mission || '<!-- MISSION:BEGIN -->\nBuild the thing.\n<!-- MISSION:END -->',
    '',
    '## 2. Why',
    'because reasons',
    '',
    '## 3. Current state',
    sections.currentState || '### Done\n- something done',
    '',
    '## 8. Next actions',
    sections.nextActions || '- do the next thing',
    '',
    '## 9. Evidence pointers',
    '- some/path',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_SNAPSHOT.md'), md);
}

console.log('forge-snapshot-reinject tests (SessionStart matcher:compact hook target)');

// ---------------------------------------------------------------------------
console.log('\n1) no due-marker -> prints NOTHING, honest no-op');
t('no marker present -> printed:false, text:null, no throw', () => {
  const root = freshRoot('reinj-nomarker');
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, false);
  assert.strictEqual(r.text, null);
});

// ---------------------------------------------------------------------------
console.log('\n2) marker present -> bounded, high-signal block + marker consumed');
t('with a marker + a real snapshot, prints Mission/Current state/Next actions and deletes the marker', () => {
  const root = freshRoot('reinj-withmarker');
  writeDue(root, { reason: 'precompact-manual' });
  writeSnapshot(root, {});
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('Build the thing.'));
  assert.ok(r.text.includes('do the next thing'));
  assert.ok(r.text.includes('precompact-manual'));
  assert.strictEqual(r.dueConsumed, true);
  assert.ok(!fs.existsSync(path.join(root, '.claude', '.forge-snapshot-due.json')));
});

t('a SECOND run with no marker left (already consumed) prints nothing', () => {
  const root = freshRoot('reinj-secondrun');
  writeDue(root, {});
  writeSnapshot(root, {});
  reinject.run({ projectRoot: root }); // consumes it
  const r2 = reinject.run({ projectRoot: root });
  assert.strictEqual(r2.printed, false);
});

// ---------------------------------------------------------------------------
console.log('\n3) size discipline — bounded output even for an oversized snapshot');
t('an oversized Current state section is truncated so the printed block stays bounded', () => {
  const root = freshRoot('reinj-oversized');
  writeDue(root, {});
  const bigList = Array.from({ length: 300 }, (_, i) => '- item ' + i + ' with some padding text to grow the section').join('\n');
  writeSnapshot(root, { currentState: bigList });
  const r = reinject.run({ projectRoot: root });
  assert.ok(r.text.length <= reinject.MAX_CHARS + 200, 'expected the printed block to respect the size budget (with small overhead for the truncation marker)');
  assert.ok(r.text.includes('truncated'));
});

// ---------------------------------------------------------------------------
console.log('\n4) missing snapshot file — honest message, marker still consumed');
t('marker present but FORGE_SNAPSHOT.md missing -> honest "no prior snapshot" text, marker still cleared', () => {
  const root = freshRoot('reinj-nosnapshot');
  writeDue(root, {});
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('was not found'));
  assert.strictEqual(r.dueConsumed, true);
});

// ---------------------------------------------------------------------------
console.log('\n5) extractSection()');
t('extractSection isolates exactly the named section body, stopping at the next numbered heading', () => {
  const text = '## 1. Mission\nmission text\nmore mission\n\n## 2. Why\nwhy text\n';
  assert.strictEqual(reinject.extractSection(text, 'Mission'), 'mission text\nmore mission');
  assert.strictEqual(reinject.extractSection(text, 'Why'), 'why text');
});
t('extractSection returns null when the heading is not found', () => {
  assert.strictEqual(reinject.extractSection('## 1. Mission\nfoo\n', 'Nonexistent'), null);
});

// ---------------------------------------------------------------------------
console.log('\n6) CLI (real spawned subprocess, real stdin pipe)');
const CLI = path.join(__dirname, 'forge-snapshot-reinject.cjs');
function sessionStartPayload(overrides) {
  return JSON.stringify(Object.assign({ session_id: 's1', source: 'compact', hook_event_name: 'SessionStart' }, overrides || {}));
}

t('CLI with a marker present prints the re-injection block on stdout and exits 0', () => {
  const root = freshRoot('reinj-cli-with');
  writeDue(root, {});
  writeSnapshot(root, {});
  const r = spawnSync(process.execPath, [CLI], {
    input: sessionStartPayload({}),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('MISSION:'));
  assert.ok(!fs.existsSync(path.join(root, '.claude', '.forge-snapshot-due.json')));
});

t('CLI with NO marker prints nothing and exits 0', () => {
  const root = freshRoot('reinj-cli-without');
  const r = spawnSync(process.execPath, [CLI], {
    input: sessionStartPayload({ source: 'startup' }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

t('CLI with malformed stdin never blocks (still exits 0)', () => {
  const root = freshRoot('reinj-cli-malformed');
  const r = spawnSync(process.execPath, [CLI], {
    input: 'not json {{{',
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
});

// ---------------------------------------------------------------------------
console.log('\n7) owner setting `snapshots` (forge-config.cjs, v2.7.0) — OFF prints nothing and touches nothing');
function writeConfig(root, settings) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }, null, 2));
}
const dueFile = (root) => path.join(root, '.claude', '.forge-snapshot-due.json');

t('snapshots=false -> skipped, nothing printed, the due-marker is left untouched (nothing written or deleted)', () => {
  const root = freshRoot('reinj-off');
  writeDue(root, {});
  writeSnapshot(root, {});
  writeConfig(root, { snapshots: { value: false } });
  const before = fs.readFileSync(dueFile(root), 'utf8');
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'owner config snapshots=off');
  assert.strictEqual(r.printed, false);
  assert.strictEqual(r.text, null);
  assert.strictEqual(r.dueConsumed, false);
  assert.strictEqual(fs.readFileSync(dueFile(root), 'utf8'), before);
});

t('snapshots=true -> the unchanged behaviour (block printed, marker consumed)', () => {
  const root = freshRoot('reinj-on');
  writeDue(root, {});
  writeSnapshot(root, {});
  writeConfig(root, { snapshots: { value: true } });
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.skipped, undefined);
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('Build the thing.'));
  assert.ok(!fs.existsSync(dueFile(root)));
});

t('config module absent (configModule:null) or throwing -> schema default ON', () => {
  for (const configModule of [null, { get() { throw new Error('boom'); } }]) {
    const root = freshRoot('reinj-absent');
    writeDue(root, {});
    writeSnapshot(root, {});
    writeConfig(root, { snapshots: { value: false } });
    const r = reinject.run({ projectRoot: root, configModule });
    assert.strictEqual(r.printed, true);
  }
});

t('M3: a malformed FORGE_CONFIG.json -> the fail-safe read keeps snapshots ON (no data flag) and returns a one-line config_note', () => {
  const root = freshRoot('reinj-badcfg');
  writeDue(root, {});
  writeSnapshot(root, {});
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), '{ not json');
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(/damaged/.test(r.config_note || '') && !/\n/.test(r.config_note), 'config_note: ' + r.config_note);
  const clean = freshRoot('reinj-cleancfg');
  writeDue(clean, {});
  writeConfig(clean, { snapshots: { value: true } });
  assert.strictEqual(reinject.run({ projectRoot: clean }).config_note, undefined, 'no note when the settings are fine');
});

t('configOn ignores a wrong-typed value and honours a real boolean', () => {
  assert.strictEqual(reinject.configOn('snapshots', true, { configModule: { get: () => ({ value: 0 }) } }), true);
  assert.strictEqual(reinject.configOn('snapshots', true, { configModule: { get: () => ({ value: false }) } }), false);
});

const OFF_BUDGET_MS = Number(process.env.FORGE_HOOK_OFF_BUDGET_MS) || 500;
t('CLI OFF path (FORGE_PROJECT_ROOT fixture, snapshots=false) with a due-marker present: exit 0, empty stdout/stderr, marker kept, best of 3 under ' + OFF_BUDGET_MS + ' ms', () => {
  const fixture = freshRoot('reinj-cli-off-fixture');
  writeConfig(fixture, { snapshots: { value: false } });
  const acting = freshRoot('reinj-cli-off-acting');
  writeDue(acting, {});
  writeSnapshot(acting, {});
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [CLI], {
      input: sessionStartPayload({}), encoding: 'utf8',
      env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: fixture, CLAUDE_PROJECT_DIR: acting }),
    });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  }
  assert.ok(fs.existsSync(dueFile(acting)), 'the OFF path consumed the marker');
  times.sort((a, b) => a - b);
  console.log('       OFF-path timings ms: ' + times.map((x) => x.toFixed(0)).join(', '));
  assert.ok(times[0] < OFF_BUDGET_MS, 'fastest OFF run took ' + times[0].toFixed(0) + ' ms (budget ' + OFF_BUDGET_MS + ' ms; override FORGE_HOOK_OFF_BUDGET_MS on a slow runner)');
});

// ---------------------------------------------------------------------------
// 8) — end-to-end proof: the richer forge-snapshot.cjs content genuinely survives
// re-injection, through the REAL generator (snap.write()), not a hand-built fixture snapshot like the
// sections above. "Latest check failure" lives inside section 3 (Current state), one of the three sections
// this hook actually re-injects, so it must appear in reinject's OWN output text.
// ---------------------------------------------------------------------------
console.log('\n8) WP-D end-to-end — a real check_failed survives the marker -> reinject pipeline');

t('a real check_failed event (written via the real forge-snapshot.cjs) appears in the re-injected text', () => {
  const root = freshRoot('reinj-wpd-e2e');
  const runDir = path.join(root, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const events = [
    { run_id: 'r1', event_type: 'run_started', agent: 'orchestrator', task: 'end-to-end WP-D proof', timestamp: '2026-09-27T10:00:00.000Z' },
    { run_id: 'r1', event_type: 'check_failed', agent: 'Test Boss', note: 'SENTINEL-E2E-CHECK-FAILED', timestamp: '2026-09-27T10:05:00.000Z' },
  ];
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // The real generator (not a hand-built fixture) — proves this project's OWN forge-snapshot.cjs, wired
  // exactly as it ships, actually produces the new subsection.
  const written = snap.write({ root, reason: 'manual', now: new Date('2026-09-27T11:00:00Z'), runId: 'r1' });
  assert.ok(written.markdown.includes('SENTINEL-E2E-CHECK-FAILED'), 'the real generator did not render the check_failed detail');

  // Simulate the marker having fired (its own contract — a due-marker file — is independent of WHERE the
  // snapshot content came from) and run the REAL reinject hook against the REAL snapshot just written.
  writeDue(root, { reason: 'precompact-manual' });
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('SENTINEL-E2E-CHECK-FAILED'),
    'the latest check_failed must survive into the re-injected text — it lives inside "Current state", one of the three re-injected sections');
});

t('the re-inject cap (MAX_CHARS) is unchanged by WP-D, exactly as instructed', () => {
  assert.strictEqual(reinject.MAX_CHARS, 2400);
});

// ---------------------------------------------------------------------------
// 9) — run obligations appended, session_resumed logged, the
// project copy authoritative over the global copy. Fake helper modules prove the wiring and the caps; the real
// helper + the real checker + a COPIED log-event.cjs (writes only into the fixture) prove it end to end.
// ---------------------------------------------------------------------------
console.log('\n9) WP-6 — obligations block, session_resumed, fail-open, character cap, global-copy deferral');
const REPO_CLAUDE = path.resolve(__dirname, '..');
const iso = (msAgo) => new Date(Date.now() - (msAgo || 0)).toISOString();
function fakeObl(o) {
  o = o || {};
  const calls = [];
  return {
    calls,
    findActiveRun: o.findActiveRun || (() => ({ run: { run_id: 'r-fake' }, reason: null })),
    obligationsFor: o.obligationsFor || ((root, id) => ({ ok: true, run_id: id, due_count: 2, text: '[forge] run ' + id + ' — 2 obligation(s) due now\n  ✗ [block] memory-read — overdue — log memory_loaded' })),
    appendRunEvent: o.appendRunEvent || ((root, id, type, fields) => { calls.push({ id, type, fields }); return { ok: true }; }),
  };
}
function withLogEvent(root) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_CLAUDE, 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
}
function withRules(root) {
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(REPO_CLAUDE, 'config', 'orchestration', 'FORGE_HARD_RULES.json'), path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
}
function startRealRun(root, id) {
  const r = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), id, 'run_started', JSON.stringify({ agent: 'orchestrator', task: 'fixture' })], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}
const eventsOf = (root, id) => fs.readFileSync(path.join(root, '.claude', 'forge-runs', id, 'events.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

t('marker + active run -> snapshot, then OUTSTANDING RUN OBLIGATIONS, and exactly ONE session_resumed on that run', () => {
  const root = freshRoot('reinj-wp6-obl');
  writeDue(root, { reason: 'precompact-auto' });
  writeSnapshot(root, {});
  const f = fakeObl();
  const r = reinject.run({ projectRoot: root, obligations: f, configModule: null });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.indexOf('MISSION:') < r.text.indexOf('OUTSTANDING RUN OBLIGATIONS:'), r.text);
  assert.ok(r.text.includes('memory-read'));
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].type, 'session_resumed');
  assert.strictEqual(f.calls[0].id, 'r-fake');
  assert.strictEqual(f.calls[0].fields.snapshot_reinjected, true);
  assert.deepStrictEqual(r.obligations, { run_id: 'r-fake', due_count: 2, ok: true, reason: null });
});
t('CHARACTER CAP: an oversized snapshot plus an oversized obligations text stays under TOTAL_MAX_CHARS', () => {
  const root = freshRoot('reinj-wp6-cap');
  writeDue(root, {});
  writeSnapshot(root, { currentState: Array.from({ length: 400 }, (_, i) => '- state item ' + i + ' padding padding padding').join('\n') });
  const huge = fakeObl({ obligationsFor: (rt, id) => ({ ok: true, run_id: id, due_count: 99, text: 'X'.repeat(9000) }) });
  const r = reinject.run({ projectRoot: root, obligations: huge, configModule: null });
  assert.ok(r.text.length <= reinject.TOTAL_MAX_CHARS, 'length ' + r.text.length + ' > ' + reinject.TOTAL_MAX_CHARS);
  const block = r.text.slice(r.text.indexOf('OUTSTANDING RUN OBLIGATIONS:'));
  assert.ok(block.length <= reinject.OBLIGATIONS_MAX_CHARS + 40, 'block ' + block.length);
  assert.ok(reinject.TOTAL_MAX_CHARS < 4500, 'the total cap itself stays small: ' + reinject.TOTAL_MAX_CHARS);
});
t('FAIL-OPEN: a throwing active-run lookup, obligations call or append never breaks the re-inject', () => {
  const boom = () => { throw new Error('boom'); };
  for (const o of [{ findActiveRun: boom }, { obligationsFor: boom }, { appendRunEvent: boom }]) {
    const root = freshRoot('reinj-wp6-boom');
    writeDue(root, {});
    writeSnapshot(root, {});
    const r = reinject.run({ projectRoot: root, obligations: fakeObl(o), configModule: null });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.printed, true);
    assert.ok(r.text.includes('Build the thing.'), 'snapshot lost');
  }
});
t('no marker + source "compact" (another copy took it) -> obligations only, plus session_resumed; source "startup" -> nothing', () => {
  const root = freshRoot('reinj-wp6-nomarker');
  const f = fakeObl();
  const r = reinject.run({ projectRoot: root, obligations: f, source: 'compact', configModule: null });
  assert.strictEqual(r.printed, true);
  assert.ok(!r.text.includes('MISSION:') && r.text.includes('another copy') && r.text.includes('OUTSTANDING RUN OBLIGATIONS:'), r.text);
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].fields.snapshot_reinjected, false);
  const g = fakeObl();
  const s = reinject.run({ projectRoot: root, obligations: g, source: 'startup', configModule: null });
  assert.strictEqual(s.printed, false);
  assert.strictEqual(g.calls.length, 0);
});
t('no active run -> the snapshot exactly as before, no obligations block, no event', () => {
  const root = freshRoot('reinj-wp6-norun');
  writeDue(root, {});
  writeSnapshot(root, {});
  const f = fakeObl({ findActiveRun: () => ({ run: null, reason: 'no run' }) });
  const r = reinject.run({ projectRoot: root, obligations: f, configModule: null });
  assert.ok(r.printed && !r.text.includes('OUTSTANDING'), r.text);
  assert.strictEqual(f.calls.length, 0);
});
t('END TO END (real helper, real checker, copied log-event.cjs): obligations printed and exactly one session_resumed written', () => {
  const root = freshRoot('reinj-wp6-e2e');
  withLogEvent(root);
  withRules(root);
  startRealRun(root, 'r-e2e');
  writeDue(root, { reason: 'precompact-manual' });
  writeSnapshot(root, {});
  const r = reinject.run({ projectRoot: root, configModule: null });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('OUTSTANDING RUN OBLIGATIONS:') && r.text.includes('run r-e2e'), r.text);
  assert.ok(r.session_resumed && r.session_resumed.ok === true, JSON.stringify(r.session_resumed));
  const obLines = r.text.slice(r.text.indexOf('OUTSTANDING RUN OBLIGATIONS:')).split('\n').slice(1);
  assert.ok(obLines.length <= 10, 'obligation lines ' + obLines.length);
  const again = reinject.run({ projectRoot: root, configModule: null }); // no marker, no source -> nothing
  assert.strictEqual(again.printed, false);
  assert.strictEqual(eventsOf(root, 'r-e2e').filter((e) => e.event_type === 'session_resumed').length, 1);
});
t('END TO END on a CORRUPT run log: the snapshot still prints, one honest obligations line, nothing thrown, nothing appended over the damage', () => {
  const root = freshRoot('reinj-wp6-corrupt');
  withLogEvent(root);
  withRules(root);
  const dir = path.join(root, '.claude', 'forge-runs', 'r-bad');
  fs.mkdirSync(dir, { recursive: true });
  const good = JSON.stringify({ run_id: 'r-bad', event_type: 'run_started', agent: 'orchestrator', timestamp: iso(1000) });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), good + '\n{ damaged\n' + good + '\n');
  const before = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  writeDue(root, {});
  writeSnapshot(root, {});
  const r = reinject.run({ projectRoot: root, configModule: null });
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('Build the thing.') && /could not be computed/.test(r.text), r.text);
  assert.strictEqual(r.session_resumed.ok, false, 'log-event must refuse to append over a damaged log');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), before);
});
t('GLOBAL-COPY DEFERRAL: a copy that is NOT the project\'s own defers when the project wires its own; the project copy never defers', () => {
  const root = freshRoot('reinj-wp6-defer');
  writeDue(root, {});
  writeSnapshot(root, {});
  const bin = path.join(root, '.claude', 'forge-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'forge-snapshot-reinject.cjs'), path.join(bin, 'forge-snapshot-reinject.cjs'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-reinject.cjs"', timeout: 15 }] }] } }));
  const before = fs.readFileSync(dueFile(root), 'utf8');
  const d = reinject.run({ projectRoot: root, obligations: false, configModule: null }); // this module = the repo copy = "global" here
  assert.strictEqual(d.skipped, true);
  assert.ok(/defers/.test(d.reason), d.reason);
  assert.strictEqual(fs.readFileSync(dueFile(root), 'utf8'), before, 'a deferring copy must not touch the marker');
  const own = reinject.run({ projectRoot: root, obligations: false, configModule: null, selfFile: path.join(bin, 'forge-snapshot-reinject.cjs') });
  assert.strictEqual(own.printed, true, 'the project copy is authoritative');
  // a project that has the file but does NOT wire it: the other copy must still act
  const root2 = freshRoot('reinj-wp6-nowire');
  writeDue(root2, {});
  fs.mkdirSync(path.join(root2, '.claude', 'forge-bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'forge-snapshot-reinject.cjs'), path.join(root2, '.claude', 'forge-bin', 'forge-snapshot-reinject.cjs'));
  assert.strictEqual(reinject.run({ projectRoot: root2, obligations: false, configModule: null }).printed, true);
});
t('the real repo copy is never treated as a global copy of itself (sameFile on its own path)', () => {
  assert.strictEqual(reinject.sameFile(path.join(__dirname, 'forge-snapshot-reinject.cjs'), path.join(REPO_CLAUDE, 'forge-bin', 'forge-snapshot-reinject.cjs')), true);
  assert.strictEqual(reinject.deferToProjectCopy(path.resolve(REPO_CLAUDE, '..'), {}), null);
});
t('CLI (spawned, CLAUDE_PROJECT_DIR = fixture with an active run): obligations in stdout, exit 0', () => {
  const root = freshRoot('reinj-wp6-cli');
  withLogEvent(root);
  withRules(root);
  startRealRun(root, 'r-cli');
  writeDue(root, {});
  writeSnapshot(root, {});
  const r = spawnSync(process.execPath, [CLI], { input: sessionStartPayload({}), encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }) });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('MISSION:') && r.stdout.includes('OUTSTANDING RUN OBLIGATIONS:'), r.stdout);
  assert.strictEqual(eventsOf(root, 'r-cli').filter((e) => e.event_type === 'session_resumed').length, 1);
});

// ---------------------------------------------------------------------------
// 10) (usage audit U-05) — exactly ONE re-inject per compaction.
// Two registrations of this hook fire on the same compaction: the project's own copy plus a global copy, or one
// copy wired twice. Only one may print anything and log session_resumed. Real processes, started together.
// ---------------------------------------------------------------------------
console.log('\n10) WP-12b — exactly one re-inject per compaction (two registrations, real processes started together)');
const RACE_DRIVER = path.join(CLAIM_DIR, 'race-driver.cjs');
fs.writeFileSync(RACE_DRIVER, [
  "'use strict';",
  "const { spawn } = require('child_process');",
  'const spec = JSON.parse(process.argv[2]);',
  "const out = spec.scripts.map(() => ({ stdout: '', code: null }));",
  'let left = spec.scripts.length;',
  'spec.scripts.forEach((script, i) => {',
  "  const c = spawn(process.execPath, [script], { env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: spec.root }), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });",
  "  c.stdout.on('data', (d) => { out[i].stdout += d; });",
  "  c.on('close', (code) => { out[i].code = code; if (--left === 0) process.stdout.write(JSON.stringify(out)); });",
  '  c.stdin.end(spec.payload);',
  '});',
].join('\n'));
/** race(root, scripts) — start every script at once as a SessionStart(compact) hook for `root`; [{stdout, code}]. */
function race(root, scripts) {
  const r = spawnSync(process.execPath, [RACE_DRIVER, JSON.stringify({ root, scripts, payload: sessionStartPayload({}) })], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, 'race driver: ' + r.stderr);
  return JSON.parse(r.stdout);
}
const WIRED = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-reinject.cjs"', timeout: 15 }] }] } });

t('TWO REGISTRATIONS (the project copy + a fake GLOBAL copy, started together, 6 rounds, both orders): exactly ONE snapshot print, by the project copy; the global copy prints nothing', () => {
  for (let round = 0; round < 6; round++) {
    const root = freshRoot('reinj-12b-two');
    writeDue(root, {});
    writeSnapshot(root, {});
    const projectCopy = path.join(root, '.claude', 'forge-bin', 'forge-snapshot-reinject.cjs');
    fs.mkdirSync(path.dirname(projectCopy), { recursive: true });
    fs.copyFileSync(CLI, projectCopy);
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), WIRED);
    const globalCopy = path.join(freshRoot('reinj-12b-fakehome'), '.claude', 'forge-bin', 'forge-snapshot-reinject.cjs');
    fs.mkdirSync(path.dirname(globalCopy), { recursive: true });
    fs.copyFileSync(CLI, globalCopy);
    const order = round % 2 ? [globalCopy, projectCopy] : [projectCopy, globalCopy];
    const res = race(root, order);
    assert.ok(res.every((x) => x.code === 0), 'exit codes ' + JSON.stringify(res.map((x) => x.code)));
    const printers = order.filter((s, i) => res[i].stdout.includes('MISSION:'));
    assert.deepStrictEqual(printers, [projectCopy], 'round ' + round + ': ' + JSON.stringify(res.map((x) => x.stdout.slice(0, 90))));
    assert.strictEqual(res[order.indexOf(globalCopy)].stdout, '', 'the global copy must print nothing at all');
    assert.ok(!fs.existsSync(dueFile(root)), 'the marker must be consumed');
  }
});
t('DOUBLE REGISTRATION the deferral cannot see (one non-project copy wired twice, active run, 4 rounds): ONE output with snapshot + obligations, ONE session_resumed', () => {
  for (let round = 0; round < 4; round++) {
    const root = freshRoot('reinj-12b-double');
    withLogEvent(root);
    withRules(root);
    startRealRun(root, 'r-race');
    writeDue(root, {});
    writeSnapshot(root, {});
    const res = race(root, [CLI, CLI]);
    assert.ok(res.every((x) => x.code === 0), 'exit codes ' + JSON.stringify(res.map((x) => x.code)));
    const spoke = res.filter((x) => x.stdout.trim() !== '');
    assert.strictEqual(spoke.length, 1, 'round ' + round + ': both copies printed — ' + JSON.stringify(res.map((x) => x.stdout.slice(0, 140))));
    assert.ok(spoke[0].stdout.includes('MISSION:') && spoke[0].stdout.includes('OUTSTANDING RUN OBLIGATIONS:'), spoke[0].stdout);
    assert.strictEqual(eventsOf(root, 'r-race').filter((e) => e.event_type === 'session_resumed').length, 1);
  }
});
t('the copy that loses the claim prints nothing and logs nothing (in-process, same compaction)', () => {
  const root = freshRoot('reinj-12b-loser');
  writeDue(root, {});
  writeSnapshot(root, {});
  const f1 = fakeObl();
  const f2 = fakeObl();
  const a = reinject.run({ projectRoot: root, obligations: f1, source: 'compact', configModule: null });
  const b = reinject.run({ projectRoot: root, obligations: f2, source: 'compact', configModule: null });
  assert.ok(a.printed && a.text.includes('MISSION:') && a.text.includes('OUTSTANDING RUN OBLIGATIONS:'), a.text);
  assert.strictEqual(b.printed, false);
  assert.strictEqual(b.text, null);
  assert.strictEqual(b.deduped, true, JSON.stringify(b));
  assert.strictEqual(f1.calls.length, 1);
  assert.strictEqual(f2.calls.length, 0, 'the loser must not log session_resumed');
});
t('a SECOND compaction soon after (a new marker) is re-injected again — the claim belongs to one compaction, not a time window', () => {
  const root = freshRoot('reinj-12b-second');
  writeDue(root, { at: '2026-10-10T10:00:00.000Z' });
  writeSnapshot(root, {});
  assert.strictEqual(reinject.run({ projectRoot: root, obligations: false, configModule: null, source: 'compact' }).printed, true);
  writeDue(root, { at: '2026-10-10T10:00:40.000Z', reason: 'precompact-manual' });
  const r2 = reinject.run({ projectRoot: root, obligations: false, configModule: null, source: 'compact' });
  assert.ok(r2.printed && r2.text.includes('MISSION:') && r2.text.includes('precompact-manual'), JSON.stringify(r2));
});
t('a stale claim (older than CLAIM_TTL_MS) is taken over: a later compaction without a marker still gets its obligations', () => {
  const root = freshRoot('reinj-12b-stale');
  const f1 = fakeObl();
  assert.strictEqual(reinject.run({ projectRoot: root, obligations: f1, source: 'compact', configModule: null }).printed, true);
  const f2 = fakeObl();
  const later = reinject.run({ projectRoot: root, obligations: f2, source: 'compact', configModule: null, now: Date.now() + reinject.CLAIM_TTL_MS + 5000 });
  assert.ok(later.printed && later.text.includes('OUTSTANDING RUN OBLIGATIONS:'), JSON.stringify(later));
  assert.strictEqual(f2.calls.length, 1);
});
t('an OLD copy (no claim) that consumed the marker first: this copy still adds the obligations once, without the snapshot', () => {
  const root = freshRoot('reinj-12b-oldcopy');
  writeDue(root, {});
  writeSnapshot(root, {});
  fs.unlinkSync(dueFile(root)); // what the earlier global copy does: print, then delete — it knows no claim
  const f = fakeObl();
  const r = reinject.run({ projectRoot: root, obligations: f, source: 'compact', configModule: null });
  assert.ok(r.printed && !r.text.includes('MISSION:') && r.text.includes('another copy') && r.text.includes('OUTSTANDING RUN OBLIGATIONS:'), r.text);
  assert.strictEqual(f.calls.length, 1);
});
t('FAIL-OPEN: a claim folder that cannot be created never suppresses the re-inject (it prints, and says why)', () => {
  const root = freshRoot('reinj-12b-failopen');
  writeDue(root, {});
  writeSnapshot(root, {});
  const blocker = path.join(root, 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  const r = reinject.run({ projectRoot: root, obligations: false, configModule: null, claimDir: path.join(blocker, 'sub') });
  assert.strictEqual(r.printed, true);
  assert.ok(/fail-open/.test(r.claim_note || ''), JSON.stringify(r));
});
t('the claim never lands inside the project (no file that could dirty the git worktree); it lives in the claim folder', () => {
  const root = freshRoot('reinj-12b-where');
  writeDue(root, {});
  writeSnapshot(root, {});
  const r = reinject.run({ projectRoot: root, obligations: false, configModule: null });
  assert.strictEqual(r.printed, true);
  const inProject = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else inProject.push(path.relative(root, p)); } };
  walk(root);
  assert.deepStrictEqual(inProject.filter((p) => /claim/i.test(p)), [], JSON.stringify(inProject));
  assert.ok(fs.readdirSync(CLAIM_DIR).some((n) => /\.claim\.json$/.test(n)), 'no claim file in ' + CLAIM_DIR);
});

try { fs.rmSync(CONFIG_HOME, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
try { fs.rmSync(CLAIM_DIR, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
