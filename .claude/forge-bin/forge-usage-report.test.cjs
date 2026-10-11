'use strict';
let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReport, table, compareReports, compareTable, USAGE, claudeProjectSlug, transcriptDirFor } = require('./forge-usage-report.cjs');

const SECRET = 'SECRET_TEXT_DO_NOT_LEAK_sk-abc123';
function asst(id, model, input, read, write) {
  return JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: {
    id, model, content: [{ type: 'text', text: SECRET }],
    usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 } } });
}
function mk() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-fx-'));
  fs.writeFileSync(path.join(d, 's1.jsonl'), [
    asst('a', 'claude-opus-x', 10, 100, 0),
    asst('a', 'claude-opus-x', 10, 100, 0), // duplicate id, deduped
    asst('b', 'claude-sonnet-x', 20, 300, 50),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: SECRET }),
    JSON.stringify({ type: 'user', message: { content: SECRET } }),
    'not json',
  ].join('\n'));
  fs.mkdirSync(path.join(d, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-1.jsonl'), asst('c', 'claude-opus-x', 5, 20, 80) + '\n');
  return d;
}

test('averages, compaction, subagent first turn, model share', async () => {
  const d = mk();
  const r = await buildReport({ projectDir: d, root: d });
  assert.strictEqual(r.main.assistant_turns, 2);
  assert.strictEqual(r.main.avg_context_tokens_per_turn, 240);
  assert.strictEqual(r.main.avg_cache_read_tokens_per_turn, 200);
  assert.strictEqual(r.main.compactions, 1);
  assert.strictEqual(r.subagents.first_turn_cache_read_p50, 20);
  assert.strictEqual(r.subagents.first_turn_cache_write_p50, 80);
  assert.strictEqual(r.model_share['claude-opus-x'].turns, 2);
  assert.strictEqual(r.total_assistant_turns, 3);
});

test('no message text leaks into output', async () => {
  const d = mk();
  const r = await buildReport({ projectDir: d, root: d });
  assert.ok(!JSON.stringify(r).includes('SECRET_TEXT'));
  assert.ok(!table(r).includes('SECRET_TEXT'));
});

// ---- v2 fixture: runs + markers + subagent + date window ----
const A = 'forge-2026-10-01-alpha', B = 'forge-2026-10-01-beta';
const T = (h) => '2026-10-01T' + h + ':00.000Z';
function turn(id, ts, u, cmd) {
  const content = [{ type: 'text', text: SECRET }];
  if (cmd) content.push({ type: 'tool_use', name: 'Bash', input: { command: cmd + ' # ' + SECRET } });
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-x', content,
    usage: { input_tokens: u[0], cache_read_input_tokens: u[1], cache_creation_input_tokens: u[2], output_tokens: u[3] } } });
}
function ev(type, ts, extra) { return JSON.stringify(Object.assign({ run_id: 'x', event_type: type, timestamp: ts, note: SECRET }, extra || {})); }
function mk2() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-root-'));
  const tx = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tx-'));
  const runs = path.join(root, '.claude', 'forge-runs');
  fs.mkdirSync(path.join(runs, A), { recursive: true });
  fs.mkdirSync(path.join(runs, B), { recursive: true });
  fs.writeFileSync(path.join(runs, A, 'events.jsonl'), [
    ev('run_started', T('00:00')),
    ev('wp_verified', T('01:00'), { verdict: 'PASS - ' + SECRET }),
    ev('wp_verified', T('01:10'), { verdict: 'FAIL: ' + SECRET }),
    ev('check_passed', T('01:20'), { agent: 'verify-boss' }),
    ev('check_failed', T('01:30'), { agent: 'Verify Boss', result: SECRET }),
    ev('check_passed', T('01:40'), { agent: 'orchestrator' }),
    ev('escalation', T('01:50')),
    ev('run_completed', T('05:00')),
    ev('file_changed', T('05:30')),
    ev('report_generated', T('05:40')),
    ev('run_started', T('06:00')),
  ].join('\n'));
  fs.writeFileSync(path.join(runs, B, 'events.jsonl'), [
    ev('run_started', T('02:30')), ev('run_completed', T('09:00')),
  ].join('\n'));
  fs.writeFileSync(path.join(tx, 's1.jsonl'), [
    turn('m0', T('00:30'), [1, 0, 0, 0]),
    turn('m1', T('01:00'), [10, 90, 0, 5], 'node .claude/forge-dashboard/log-event.cjs ' + A + ' agent_note'),
    turn('m2', T('02:00'), [10, 0, 90, 5]),
    turn('m3', T('03:00'), [0, 100, 0, 10], 'node forge-runcontract.cjs check --run ' + B),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: T('03:30'), content: SECRET }),
  ].join('\n'));
  fs.mkdirSync(path.join(tx, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(tx, 's1', 'subagents', 'agent-9.jsonl'), [
    turn('x1', T('03:10'), [5, 20, 80, 1]), turn('x2', T('03:20'), [5, 100, 0, 1]),
  ].join('\n'));
  fs.writeFileSync(path.join(tx, 's2.jsonl'), [
    turn('n1', T('04:00'), [1, 1, 1, 1], 'node log-event.cjs ' + A + ' x; cat forge-runs/forge-2026-01-01-SECRETTEXT/x'),
    turn('n2', T('05:30'), [1, 1, 1, 1]),
  ].join('\n'));
  fs.writeFileSync(path.join(tx, 's3.jsonl'), turn('o1', T('08:00'), [2, 2, 2, 2]));
  return { root, tx };
}
const full = (f) => buildReport({ projectDir: f.tx, root: f.root, byRun: true, verifier: true, cache: true });

test('--by-run joins by run-id marker, segments, parent session and date window', async () => {
  const r = await full(mk2());
  const a = r.by_run.runs.find((x) => x.run_id === A), b = r.by_run.runs.find((x) => x.run_id === B);
  assert.strictEqual(a.tokens.total, 219);
  assert.strictEqual(a.tokens_measured, 8);
  assert.strictEqual(a.attribution, 'mixed');
  assert.strictEqual(a.main_turns, 5);
  assert.deepStrictEqual(a.method_turns, { marker: 2, marker_segment: 2, parent_marker: 0, date_window: 1 });
  assert.strictEqual(a.turns_after_first_completion, 1);
  assert.strictEqual(b.tokens.total, 330);
  assert.strictEqual(b.tokens.output, 14);
  assert.strictEqual(b.attribution, 'estimated');
  assert.strictEqual(b.subagent_turns, 2);
  assert.strictEqual(b.subagent_transcripts, 1);
  assert.strictEqual(b.compactions, 1);
  assert.strictEqual(b.method_turns.parent_marker, 2);
  assert.strictEqual(r.by_run.unattributed.turns, 0);
  assert.strictEqual(r.by_run.runs.length, 2, 'unknown run id must be ignored');
});

test('--verifier counts verdicts, escalations and rework after completion', async () => {
  const v = (await full(mk2())).verifier;
  assert.strictEqual(v.totals.verifier_pass, 2);
  assert.strictEqual(v.totals.verifier_fail, 2);
  assert.strictEqual(v.totals.verifier_fail_rate, 0.5);
  assert.strictEqual(v.totals.escalations_per_fail, 0.5);
  assert.strictEqual(v.totals.all_check_pass, 2);
  assert.strictEqual(v.totals.all_check_fail, 1);
  assert.deepStrictEqual(v.runs_with_rework_after_completion, [{ run_id: A, events: 1 }]);
  assert.strictEqual(v.totals.runs_completed, 2);
});

test('--cache gives per-session and subagent first-turn shares with p50/p90', async () => {
  const c = (await full(mk2())).cache.summary;
  assert.strictEqual(c.sessions, 3);
  assert.strictEqual(c.session_share_p50, 0.3333);
  assert.strictEqual(c.session_share_p90, 0.475);
  assert.strictEqual(c.subagent_first_turn_share_p50, 0.1905);
});

test('--json keeps every v1 field (additive schema)', async () => {
  const r = await full(mk2());
  for (const k of ['generated', 'project_dir_found', 'loaded_text', 'main', 'subagents', 'model_share', 'total_assistant_turns']) assert.ok(k in r, k);
  for (const k of ['transcripts', 'assistant_turns', 'avg_context_tokens_per_turn', 'avg_cache_read_tokens_per_turn', 'compactions']) assert.ok(k in r.main, k);
  assert.strictEqual(r.schema, 'forge-usage-report/2');
  const plain = await buildReport({ projectDir: mk2().tx, root: os.tmpdir() });
  assert.ok(!('by_run' in plain) && !('verifier' in plain) && !('cache' in plain));
});

test('--compare prints deltas and withholds them when populations differ', async () => {
  const f = mk2();
  const a = await full(f);
  const b = JSON.parse(JSON.stringify(a));
  b.main.assistant_turns += 10;
  b.subagents.transcripts += 1;
  const c = compareReports(a, b);
  const main = c.sections.find((s) => s.section === 'main');
  assert.strictEqual(main.status, 'ok');
  assert.strictEqual(main.deltas.find((d) => d.field === 'assistant_turns').delta, 10);
  const sub = c.sections.find((s) => s.section === 'subagents');
  assert.strictEqual(sub.status, 'withheld');
  assert.ok(sub.deltas.every((d) => d.delta === undefined));
  assert.ok(/DELTA WITHHELD/.test(compareTable(c)));
  const lt = c.sections.find((s) => s.section === 'loaded_text');
  assert.strictEqual(lt.deltas.find((d) => d.field === 'total_tokens_estimate').label, 'estimated');
});

test('leak: no message, tool input or event text in any output', async () => {
  const f = mk2();
  const r = await full(f);
  const outs = [JSON.stringify(r), table(r), JSON.stringify(compareReports(r, r)), compareTable(compareReports(r, r))];
  for (const o of outs) {
    assert.ok(!o.includes('SECRET_TEXT'), 'secret leaked');
    assert.ok(!o.includes('SECRETTEXT'), 'unknown run-id text leaked');
    assert.ok(!o.includes('log-event.cjs') && !o.includes('runcontract.cjs check'), 'command text leaked');
  }
  assert.ok(USAGE.includes('--by-run') && USAGE.includes('--compare'));
});

test('missing folder reports error, no throw', async () => {
  const r = await buildReport({ projectDir: path.join(os.tmpdir(), 'nope-' + Date.now()), root: os.tmpdir() });
  assert.strictEqual(r.project_dir_found, false);
  assert.ok(r.error);
});

test('transcript folder is derived from the project root at run time (no machine path in the source)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage root! x-'));
  const slug = claudeProjectSlug(root);
  assert.ok(/^[A-Za-z0-9-]+$/.test(slug) && slug.includes('usage-root--x-'), slug);
  assert.strictEqual(transcriptDirFor(root, home), path.join(home, '.claude', 'projects', slug), 'absent folder: the computed slug');
  const stored = slug.charAt(0) === slug.charAt(0).toUpperCase() ? slug.charAt(0).toLowerCase() + slug.slice(1) : slug.charAt(0).toUpperCase() + slug.slice(1);
  const tx = path.join(home, '.claude', 'projects', stored);
  fs.mkdirSync(tx, { recursive: true });
  fs.copyFileSync(path.join(mk(), 's1.jsonl'), path.join(tx, 's1.jsonl'));
  if (slug !== stored) assert.strictEqual(path.basename(transcriptDirFor(root, home)), stored, 'an existing folder differing only in case is used');
  const r = await buildReport({ root, home });
  assert.strictEqual(r.project_dir_found, true);
  assert.strictEqual(r.main.assistant_turns, 2);
  const src = fs.readFileSync(path.join(__dirname, 'forge-usage-report.cjs'), 'utf8');
  assert.ok(!/projects', '[A-Za-z]--/.test(src), 'no hardcoded project slug in the source');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + (e && e.message)); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
