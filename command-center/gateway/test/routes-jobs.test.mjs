// WP B5 part BUILD: routes/jobs.mjs, the read-only routes behind "Klussen & bewijs".
// Temp project folder per test under os.tmpdir(); every folder is removed afterwards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildJobsList, buildJobDetail, summarizeEvents, verdictStatus, parseJobsLimit, jobDetail, jobsList,
  MAX_READ_BYTES, MAX_LIMIT, DEFAULT_LIMIT,
} from '../src/routes/jobs.mjs';

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-jobs-'));
  made.push(root);
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  return root;
}

function writeRun(root, runId, events, { files = [], mtime } = {}) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const body = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, body, 'utf8');
  for (const f of files) fs.writeFileSync(path.join(dir, f), '{}');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return dir;
}

const T = (m) => '2026-11-01T10:' + String(m).padStart(2, '0') + ':00.000Z';
// Built by concatenation so the repo's own leak scans never see a token-shaped literal.
const PLANTED = 'sk-' + 'ant-api03-' + 'A'.repeat(30);

const LEDGER = [
  { event_type: 'run_started', task: 'Bouw de app', goal: 'Een werkende app', timestamp: T(0) },
  { event_type: 'agent_work_package_created', wp_id: 'A1', owner: 'Build Boss', route: 'build', task: 'Scherm', timestamp: T(1) },
  { event_type: 'agent_work_package_created', wp_id: 'A2', owner: 'Build Boss', route: 'quick', task: 'Tekst', timestamp: T(1) },
  { event_type: 'agent_work_package_created', wp_id: 'A3', owner: 'Test Boss', route: 'verifier', task: 'Tests', timestamp: T(1) },
  { event_type: 'agent_work_package_created', wp_id: 'A4', owner: 'Docs Boss', route: 'quick', task: 'Docs', timestamp: T(1) },
  { event_type: 'subagent_started', wp_id: 'A1', timestamp: T(2) },
  { event_type: 'wp_completed', wp_id: 'A1', agent: 'Build Boss', exit_code: 0, command: 'npm test', evidence: 'lane-reports/A1.md key ' + PLANTED, timestamp: T(3) },
  { event_type: 'wp_verified', wp_id: 'A1', agent: 'verify-boss', verdict: 'PASS', command: 'npm test', exit_code: 0, evidence: '12/12', timestamp: T(4) },
  { event_type: 'subagent_started', wp_id: 'A2', timestamp: T(2) },
  { event_type: 'wp_completed', wp_id: 'A2', exit_code: 0, timestamp: T(3) },
  { event_type: 'review_completed', wp_id: 'A2', agent: 'Review Boss', verdict: 'FAIL', finding: 'copy wrong', evidence: 'lane-reports/A2.md', timestamp: T(5) },
  { event_type: 'rework_task_created', wp_id: 'A2', reason: 'copy wrong', timestamp: T(6) },
  { event_type: 'subagent_started', wp_id: 'A3', timestamp: T(2) },
  'this line is not json',
  { event_type: 'run_paused', reason: 'owner', timestamp: T(9) },
];

test('summarizeEvents walks the ledger in order into per-work-package states', () => {
  const s = summarizeEvents(LEDGER.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\r\n'));
  assert.equal(s.title, 'Bouw de app');
  assert.equal(s.goal, 'Een werkende app');
  assert.equal(s.status, 'paused');
  assert.equal(s.started_at, T(0));
  assert.equal(s.last_event_at, T(9));
  assert.equal(s.malformed, 1);
  const byId = Object.fromEntries(s.work_packages.map((w) => [w.wp_id, w]));
  assert.deepEqual(Object.fromEntries(s.work_packages.map((w) => [w.wp_id, w.status])), { A1: 'verified', A2: 'rework', A3: 'running', A4: 'planned' });
  assert.equal(byId.A1.owner, 'Build Boss');
  assert.equal(byId.A1.verifications[0].verdict, 'PASS');
  assert.equal(byId.A1.completed.exit_code, 0);
  assert.equal(byId.A2.rework_rounds, 1);
  assert.equal(byId.A2.reviews[0].finding, 'copy wrong');
});

test('a rework that completes and is re-verified ends verified; a FAIL verdict ends failed', () => {
  const lines = [
    { event_type: 'agent_work_package_created', wp_id: 'X' },
    { event_type: 'rework_task_created', wp_id: 'X' },
    { event_type: 'rework_completed', wp_id: 'X' },
    { event_type: 'wp_verified', wp_id: 'X', verdict: 'PASS_WITH_NOTES' },
    { event_type: 'wp_verified', wp_id: 'Y', verdict: 'FAIL' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const s = summarizeEvents(lines);
  assert.deepEqual(s.work_packages.map((w) => [w.wp_id, w.status]), [['X', 'verified'], ['Y', 'failed']]);
  assert.equal(s.status, 'unknown');
  assert.equal(verdictStatus('NEEDS_MORE_EVIDENCE'), 'needs_evidence');
  assert.equal(verdictStatus('maybe'), 'checked');
});

test('buildJobDetail returns the work packages, redacts a planted secret and lists evidence files by name', () => {
  const root = makeProject();
  writeRun(root, 'forge-run-1', LEDGER, { files: ['final-report.md', 'run-finalized.json'] });
  const r = buildJobDetail(root, 'forge-run-1');
  assert.equal(r.ok, true);
  assert.equal(r.job.status, 'paused');
  assert.equal(r.job.receipt_present, true);
  assert.equal(r.job.final_report_present, true);
  assert.deepEqual(r.job.evidence_files, ['final-report.md', 'run-finalized.json']);
  assert.deepEqual(r.job.work_package_counts, { total: 4, verified: 1, rework: 1, running: 1, planned: 1 });
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes(PLANTED), false, 'the planted secret must never come back');
  assert.match(r.job.work_packages[0].completed.evidence, /\[REDACTED:/);
});

test('buildJobDetail refuses bad ids, traversal and a linked run folder; a missing run is 404', () => {
  const root = makeProject();
  writeRun(root, 'real', LEDGER);
  fs.writeFileSync(path.join(root, '.claude', 'events.jsonl'), JSON.stringify({ event_type: 'run_started', task: 'outside' }) + '\n');
  for (const bad of ['', '..', '../x', '..\\x', 'a/b', 'a.b', 'x'.repeat(129)]) {
    const r = buildJobDetail(root, bad);
    assert.equal(r.ok, false, 'run id ' + JSON.stringify(bad) + ' must be refused');
    assert.equal(r.status, 400);
  }
  assert.equal(buildJobDetail(root, 'nope').status, 404);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-jobs-outside-'));
  made.push(outside);
  fs.writeFileSync(path.join(outside, 'events.jsonl'), JSON.stringify({ event_type: 'run_started', task: 'secret outside' }) + '\n');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(root, '.claude', 'forge-runs', 'linked'), 'junction'); } catch { linked = false; }
  if (linked) {
    const r = buildJobDetail(root, 'linked');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.deepEqual(buildJobsList(root).jobs.map((j) => j.run_id), ['real'], 'a linked folder is never listed');
  }
});

test('buildJobsList: newest first by events mtime, limit, skips non-runs, no work-package lists', () => {
  const root = makeProject();
  writeRun(root, 'old-run', LEDGER, { mtime: new Date('2026-10-01T00:00:00Z') });
  writeRun(root, 'new-run', LEDGER, { mtime: new Date('2026-11-01T00:00:00Z') });
  writeRun(root, 'mid-run', LEDGER, { mtime: new Date('2026-10-15T00:00:00Z') });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', '.hotspot-locks'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'no-events'));
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'PAUSE.md'), 'x');
  const all = buildJobsList(root);
  assert.equal(all.ok, true);
  assert.deepEqual(all.jobs.map((j) => j.run_id), ['new-run', 'mid-run', 'old-run']);
  assert.equal(all.total, 3);
  assert.equal(all.truncated, false);
  assert.equal('work_packages' in all.jobs[0], false);
  assert.equal(all.jobs[0].work_package_counts.total, 4);
  const two = buildJobsList(root, { limit: 2 });
  assert.deepEqual(two.jobs.map((j) => j.run_id), ['new-run', 'mid-run']);
  assert.equal(two.truncated, true);
});

test('a project without forge-runs is the honest empty state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-jobs-empty-'));
  made.push(root);
  assert.deepEqual(buildJobsList(root), { ok: true, jobs: [], total: 0, truncated: false });
});

test('an events file over 2 MB is read only up to the cap and reported as truncated', () => {
  const root = makeProject();
  const dir = writeRun(root, 'big', LEDGER.slice(0, 2));
  const filler = JSON.stringify({ event_type: 'agent_note', text: 'x'.repeat(1000) }) + '\n';
  fs.appendFileSync(path.join(dir, 'events.jsonl'), filler.repeat(Math.ceil(MAX_READ_BYTES / filler.length) + 10));
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ event_type: 'run_completed' }) + '\n');
  const r = buildJobDetail(root, 'big');
  assert.equal(r.ok, true);
  assert.equal(r.job.truncated, true);
  assert.equal(r.job.malformed, 0, 'the partial last line is dropped, not counted as malformed');
  assert.equal(r.job.status, 'open', 'an event past the cap is never read');
  assert.ok(r.job.events_bytes > MAX_READ_BYTES);
});

test('parseJobsLimit clamps', () => {
  assert.equal(parseJobsLimit(null), DEFAULT_LIMIT);
  assert.equal(parseJobsLimit('-3'), DEFAULT_LIMIT);
  assert.equal(parseJobsLimit('5'), 5);
  assert.equal(parseJobsLimit('100000'), MAX_LIMIT);
});

function fakeRes() {
  const res = { status: null, headers: null, body: null };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; };
  res.end = (b) => { res.body = b ? JSON.parse(b) : null; };
  return res;
}

test('handlers: non-GET is 405, a bad run id is 400 before any project lookup', async () => {
  const post = fakeRes();
  await jobsList({ method: 'POST' }, post, { searchParams: new URLSearchParams('project=x') });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  const del = fakeRes();
  await jobDetail({ method: 'DELETE' }, del, { searchParams: new URLSearchParams('project=x&run=a') });
  assert.equal(del.status, 405);
  const bad = fakeRes();
  await jobDetail({ method: 'GET' }, bad, { searchParams: new URLSearchParams('project=x&run=../etc') });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
});
