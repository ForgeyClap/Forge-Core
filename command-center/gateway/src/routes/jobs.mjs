// Read-only routes for the "Klussen & bewijs" screen (WP B5 part BUILD).
//
//   GET /api/jobs?project=<name>[&limit=<n>]        newest runs (klussen) with their status and a
//                                                    work-package tally
//   GET /api/jobs/detail?project=<name>&run=<id>    one run: every work package with its status,
//                                                    verdicts, reviews and evidence pointers
//
// Data: `<project>/.claude/forge-runs/<run_id>/events.jsonl` (the mission ledger) plus which known
// evidence files sit in the run folder. Nothing is executed and nothing is written.
//
// Security conventions, the same as the other per-run readers (team-chat.mjs, events.mjs):
//   - the gateway's request listener already refuses any non-loopback Host / cross-site request
//     (security.mjs hostOk / crossSiteOk) before a route runs; these are GETs, so no exec token;
//   - `?project=` resolves only through the trusted registry (projectOrRespond), never as a path;
//   - a run id must pass safeIdOk() (no '.', '/', '\') and be at most 128 chars; every resolved
//     path must sit inside the project's own forge-runs/ (containmentOk); a run folder that is a
//     symbolic link or junction is skipped (list) or refused (detail);
//   - every events file is read up to MAX_READ_BYTES (2 MB) from its start, and the cut is reported
//     as `truncated: true`, never hidden;
//   - every free-text field is redacted on the full value and then capped (redactAndCap), and the
//     whole response passes redactDeep() once more before it leaves.
// Honesty: `receipt_present` only says a run-finalized.json file exists. Whether it is an accepted
// completion proof is answered by GET /api/proof, never guessed here.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, safeIdOk } from '../security.mjs';
import { redactAndCap, redactDeep } from '../redact.mjs';
import { readDirBounded } from '../bounded-readdir.mjs';
import { sendJson, projectOrRespond } from './http.mjs';

export const MODULE = 'jobs';

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
export const MAX_RUN_DIR_ENTRIES = 2000;
export const MAX_WORK_PACKAGES = 300;
export const MAX_ENTRIES_PER_WP = 20;
export const MAX_TEXT = 500;
const MAX_RUN_ID = 128;

// Files a run folder may carry as evidence; only their names are reported, never their content.
export const EVIDENCE_FILES = Object.freeze([
  'final-report.md', 'run-finalized.json', 'gate-evidence.json', 'self-review.json', 'team-chat.jsonl', 'lane-reports',
]);

const LIFECYCLE = new Map([
  ['run_started', 'open'], ['run_resumed', 'open'], ['session_resumed', 'open'], ['run_paused', 'paused'],
  ['run_completed', 'completed'], ['run_failed', 'failed'], ['run_cancelled', 'cancelled'], ['run_aborted', 'cancelled'],
]);

const text = (value) => redactAndCap(typeof value === 'number' ? String(value) : value, MAX_TEXT);
const ts = (e) => (typeof e.timestamp === 'string' ? e.timestamp : typeof e.ts === 'string' ? e.ts : null);
const wpIdOf = (e) => (typeof e.wp_id === 'string' && e.wp_id.length > 0 && e.wp_id.length <= 64 ? e.wp_id : null);

/** Clamps a raw `?limit=` value; anything unusable falls back to the default. */
export function parseJobsLimit(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Maps a verdict word to a work-package status. Unknown words stay visible as 'checked'. */
export function verdictStatus(verdict) {
  const v = typeof verdict === 'string' ? verdict.trim().toUpperCase() : '';
  if (v === 'PASS' || v === 'PASSED' || v === 'PASS_WITH_NOTES') return 'verified';
  if (v === 'FAIL' || v === 'FAILED') return 'failed';
  if (v === 'NEEDS_MORE_EVIDENCE') return 'needs_evidence';
  return 'checked';
}

function newWp(id) {
  return { wp_id: id, owner: null, route: null, task: null, status: 'planned', created_at: null, updated_at: null,
    completed: null, verifications: [], reviews: [], rework_rounds: 0, dropped_entries: 0 };
}

function pushCapped(wp, list, item) {
  if (list.length < MAX_ENTRIES_PER_WP) list.push(item);
  else wp.dropped_entries += 1;
}

// One event applied to its work package, in ledger order (a small state machine).
function applyWpEvent(wp, e) {
  const at = ts(e);
  if (at) wp.updated_at = at;
  switch (e.event_type) {
    case 'agent_work_package_created':
      wp.owner = text(e.owner); wp.route = text(e.route); wp.task = text(e.task); wp.created_at = wp.created_at || at;
      break;
    case 'subagent_started':
      if (wp.status === 'planned') wp.status = 'running';
      break;
    case 'wp_completed':
      wp.status = 'built';
      wp.completed = { at, agent: text(e.agent), exit_code: Number.isInteger(e.exit_code) ? e.exit_code : null,
        partial: e.partial === true, command: text(e.command), evidence: text(e.evidence) };
      break;
    case 'rework_task_created':
      wp.status = 'rework'; wp.rework_rounds += 1;
      break;
    case 'rework_completed':
      if (wp.status === 'rework') wp.status = 'built';
      break;
    case 'wp_verified':
      wp.status = verdictStatus(e.verdict);
      pushCapped(wp, wp.verifications, { at, agent: text(e.agent), verdict: text(e.verdict), command: text(e.command),
        exit_code: Number.isInteger(e.exit_code) ? e.exit_code : null, evidence: text(e.evidence) });
      break;
    case 'review_completed':
      pushCapped(wp, wp.reviews, { at, agent: text(e.agent), verdict: text(e.verdict), finding: text(e.finding), evidence: text(e.evidence) });
      break;
    default:
      break;
  }
}

/**
 * Summarises the text of an events.jsonl. Pure: no filesystem access.
 * @returns {{title, goal, started_at, last_event_at, status, work_packages, events, malformed, wp_truncated}}
 */
export function summarizeEvents(body) {
  const out = { title: null, goal: null, started_at: null, last_event_at: null, status: 'unknown',
    work_packages: [], events: 0, malformed: 0, wp_truncated: false };
  const wps = new Map();
  for (const raw of String(body).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    let e;
    try { e = JSON.parse(line); } catch { out.malformed += 1; continue; }
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.event_type !== 'string') { out.malformed += 1; continue; }
    out.events += 1;
    const at = ts(e);
    if (at) out.last_event_at = at;
    if (e.event_type === 'run_started') {
      out.title = out.title || text(e.task);
      out.goal = out.goal || text(e.goal);
      out.started_at = out.started_at || at;
    }
    if (LIFECYCLE.has(e.event_type)) out.status = LIFECYCLE.get(e.event_type);
    const id = wpIdOf(e);
    if (!id) continue;
    if (!wps.has(id)) {
      if (wps.size >= MAX_WORK_PACKAGES) { out.wp_truncated = true; continue; }
      wps.set(id, newWp(id));
    }
    applyWpEvent(wps.get(id), e);
  }
  out.work_packages = [...wps.values()];
  return out;
}

/** Counts work packages per status. */
export function tally(workPackages) {
  const counts = { total: workPackages.length };
  for (const wp of workPackages) counts[wp.status] = (counts[wp.status] || 0) + 1;
  return counts;
}

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, MAX_READ_BYTES);
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, 0);
    let body = buf.subarray(0, got).toString('utf8');
    const truncated = size > MAX_READ_BYTES;
    // A cut in the middle of the file ends mid-line: drop that partial last line.
    if (truncated) body = body.slice(0, body.lastIndexOf('\n') + 1);
    return { body, truncated, size };
  } finally {
    fs.closeSync(fd);
  }
}

function isPlainDir(p) {
  try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}

function evidencePresent(runPath) {
  return EVIDENCE_FILES.filter((name) => fs.existsSync(path.join(runPath, name)));
}

// Reads and summarises one run folder. Returns null when it is not a run (no events.jsonl).
function readRun(runsDir, runId) {
  const runPath = path.join(runsDir, runId);
  const eventsPath = path.join(runPath, 'events.jsonl');
  if (!containmentOk(runsDir, eventsPath) || !isPlainDir(runPath) || !fs.existsSync(eventsPath)) return null;
  const { body, truncated, size } = readHead(eventsPath);
  const summary = summarizeEvents(body);
  const evidence = evidencePresent(runPath);
  return {
    run_id: runId,
    title: summary.title,
    goal: summary.goal,
    status: summary.status,
    started_at: summary.started_at,
    last_event_at: summary.last_event_at,
    receipt_present: evidence.includes('run-finalized.json'),
    final_report_present: evidence.includes('final-report.md'),
    evidence_files: evidence,
    work_package_counts: tally(summary.work_packages),
    events: summary.events,
    malformed: summary.malformed,
    events_bytes: size,
    truncated: truncated || summary.wp_truncated,
    work_packages: summary.work_packages,
  };
}

function runsDirOf(projectPath) {
  return path.join(projectPath, '.claude', 'forge-runs');
}

/** The newest runs of a project (by events.jsonl mtime), without their work-package lists. */
export function buildJobsList(projectPath, { limit = DEFAULT_LIMIT } = {}) {
  const runsDir = runsDirOf(projectPath);
  const max = Math.min(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT, MAX_LIMIT);
  if (!fs.existsSync(runsDir)) return { ok: true, jobs: [], total: 0, truncated: false };
  let listed;
  try {
    listed = readDirBounded(runsDir, MAX_RUN_DIR_ENTRIES);
  } catch (err) {
    return { ok: false, status: 500, error: 'runs folder could not be read: ' + (err && err.code ? err.code : 'unknown error') };
  }
  const candidates = [];
  for (const entry of listed.entries) {
    if (!entry.isDirectory() || !safeIdOk(entry.name) || entry.name.length > MAX_RUN_ID) continue;
    const eventsPath = path.join(runsDir, entry.name, 'events.jsonl');
    if (!containmentOk(runsDir, eventsPath)) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(eventsPath).mtimeMs; } catch { continue; }
    candidates.push({ runId: entry.name, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.runId.localeCompare(a.runId));
  const jobs = [];
  for (const { runId } of candidates.slice(0, max)) {
    let run;
    try { run = readRun(runsDir, runId); } catch { run = null; }
    if (!run) continue;
    const { work_packages: _omitted, ...row } = run;
    jobs.push(row);
  }
  return { ok: true, jobs, total: candidates.length, truncated: listed.truncated || candidates.length > max };
}

/** One run with its work packages. */
export function buildJobDetail(projectPath, runId) {
  if (!safeIdOk(runId) || runId.length > MAX_RUN_ID) return { ok: false, status: 400, error: 'invalid or missing ?run=<id>' };
  const runsDir = runsDirOf(projectPath);
  const runPath = path.join(runsDir, runId);
  if (!containmentOk(runsDir, runPath)) return { ok: false, status: 400, error: 'path containment violation' };
  if (fs.existsSync(runPath) && !isPlainDir(runPath)) return { ok: false, status: 400, error: 'run folder is not a plain folder' };
  let run;
  try {
    run = readRun(runsDir, runId);
  } catch (err) {
    return { ok: false, status: 500, error: 'run could not be read: ' + (err && err.code ? err.code : 'unknown error') };
  }
  if (!run) return { ok: false, status: 404, error: 'unknown run (no events.jsonl in this project)' };
  return { ok: true, job: run };
}

function refuseNonGet(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  sendJson(res, 405, { ok: false, error: 'method not allowed (GET only)' }, { Allow: 'GET' });
  return true;
}

function answer(res, result, extra) {
  if (!result.ok) return sendJson(res, result.status || 400, { ok: false, error: result.error });
  return sendJson(res, 200, redactDeep({ ...result, ...extra, captured_at: new Date().toISOString(), provenance: 'DERIVED' }));
}

/** GET /api/jobs?project=<name>[&limit=<n>] */
export async function jobsList(req, res, { searchParams }) {
  if (refuseNonGet(req, res)) return undefined;
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  return answer(res, buildJobsList(entry.path, { limit: parseJobsLimit(searchParams.get('limit')) }));
}

/** GET /api/jobs/detail?project=<name>&run=<id> */
export async function jobDetail(req, res, { searchParams }) {
  if (refuseNonGet(req, res)) return undefined;
  const runId = searchParams.get('run') || '';
  // Like /api/proof: an invalid id is refused before any project lookup.
  if (!safeIdOk(runId) || runId.length > MAX_RUN_ID) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  return answer(res, buildJobDetail(entry.path, runId));
}
