// the ONE place the gateway asks "is this finalize receipt a completion proof?".
//
// Shared by proof.mjs (one run, GET /api/proof) and runs.mjs (the run list, GET /api/runs) so both answer from
// the same authoritative result: the CENTRAL forge-finalize.cjs `check --run <id> --root <project> --json`
// (read-only — it never logs and never writes). The central tool is this gateway's own host project's copy,
// never the judged project's code; it classifies the log with its OWN log-event.cjs (forge-finalize.cjs
// loadClassifier), so no selected-project code runs.
//
// Also owns the small pool of child-process slots (Codex run B F-07) that every central check shares — the
// run-contract check in proof.mjs draws from the SAME pool, so the gateway never runs more than
// MAX_CONCURRENT_CENTRAL_CHECKS central children at once, whichever endpoint asked.
//
// Caching (runs list must stay fast on 70+ runs): one entry per "<project>::<run>", valid while the receipt's
// AND the run log's file identity (mtime + size) are unchanged. Inside ACCEPTANCE_TTL_MS the entry is fresh;
// after that it is still served by peekFinalizeAcceptance() (marked `stale_cache`) while a re-check runs —
// the verdict also depends on the current ruleset and HEAD, which change without touching the receipt.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { containmentOk } from './security.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import { filteredEnv } from './exec-cli.mjs';
import { redactDeep } from './redact.mjs';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------------------------------------ */
/*  Shared slot pool (moved here from proof.mjs — same numbers, same behaviour)                      */
/* ------------------------------------------------------------------------------------------------ */
const MAX_CONCURRENT_CENTRAL_CHECKS = 2;
const MAX_CENTRAL_CHECK_QUEUE_WAITERS = 50;
let runningCount = 0;
const waitQueue = [];
let maxQueueWaitersOverride = null;
export function _setMaxCentralCheckQueueWaitersForTests(n) { maxQueueWaitersOverride = n; }
export function _resetMaxCentralCheckQueueWaitersForTests() { maxQueueWaitersOverride = null; }
export function _resetCentralCheckSlotsForTests() { runningCount = 0; waitQueue.length = 0; }
export function _getCentralCheckRunningCountForTests() { return runningCount; }
export function _getCentralCheckQueueLengthForTests() { return waitQueue.length; }

/** Resolves true once a slot is granted, or false at once when the wait queue itself is already full. */
export function acquireCentralCheckSlot() {
  if (runningCount < MAX_CONCURRENT_CENTRAL_CHECKS) { runningCount++; return Promise.resolve(true); }
  if (waitQueue.length >= (maxQueueWaitersOverride ?? MAX_CENTRAL_CHECK_QUEUE_WAITERS)) return Promise.resolve(false);
  return new Promise((resolve) => { waitQueue.push(resolve); });
}
/** Hands the freed slot straight to the next waiter; only decrements when nobody waits. */
export function releaseCentralCheckSlot() {
  const next = waitQueue.shift();
  if (next) next(true);
  else runningCount--;
}

/* ------------------------------------------------------------------------------------------------ */
/*  Spawn guards (shared with the run-contract check)                                                */
/* ------------------------------------------------------------------------------------------------ */
/** A run id never reaches a spawn when it starts with '-' (defense in depth; callers already safeIdOk). */
export function isSafeRunIdForSpawn(runId) {
  return typeof runId === 'string' && runId.length > 0 && !runId.startsWith('-');
}
/** An unknown run never triggers a spawn. */
export function runFolderExists(projectPath, runId) {
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runDir = path.join(runsDir, runId);
  if (!containmentOk(runsDir, runDir)) return false;
  try { return fs.statSync(runDir).isDirectory(); } catch { return false; }
}

/* ------------------------------------------------------------------------------------------------ */
/*  The acceptance result                                                                            */
/* ------------------------------------------------------------------------------------------------ */
const CENTRAL_FORGE_FINALIZE_CJS = path.join(PROJECT_ROOT, '.claude', 'forge-bin', 'forge-finalize.cjs');
const FINALIZE_CHECK_TIMEOUT_MS = 20000;
let finalizeCjsOverride = null;
export function _setFinalizeCjsForTests(p) { finalizeCjsOverride = p; }
function activeFinalizeCjs() { return finalizeCjsOverride || CENTRAL_FORGE_FINALIZE_CJS; }

/** The receipt's threat model, said plainly. Used when the central tool does not pass its own note. */
export const DEFAULT_THREAT_MODEL = 'Tamper-evident, not tamper-proof: the receipt pins the run log, its evidence and the code commit by '
  + 'digest, so a later edit to any of them is detected. It is not a signature: someone with write access to this project '
  + 'could rewrite the log and the receipt together.';

function parseFinalizeStdout(stdout) {
  try {
    const body = JSON.parse(stdout);
    if (body && typeof body === 'object' && typeof body.verdict === 'string') return body;
  } catch { /* not JSON — fall through */ }
  return null;
}

/** acceptanceFromCheck(body) -> the public acceptance shape: only what a reader needs, never the full receipt.
 *  completion_proof is the central finalize's own (cutoff-aware) answer: FINALIZED is a proof unless the tool says
 *  otherwise; HISTORICAL only when the tool says completion_proof:true (an older tool without the field never
 *  reads as finalized); every other verdict never. */
export function acceptanceFromCheck(body) {
  const verdict = String(body.verdict);
  const reverified = body.reverified === true;
  const completionProof = verdict === 'FINALIZED' ? body.completion_proof !== false
    : verdict === 'HISTORICAL' ? body.completion_proof === true : false;
  const threat = typeof body.threat_model === 'string' ? body.threat_model
    : typeof body.threat_model_note === 'string' ? body.threat_model_note : DEFAULT_THREAT_MODEL;
  return {
    available: true,
    verdict,
    cause: typeof body.cause === 'string' ? body.cause : null,
    reverified,
    archival: typeof body.archival === 'boolean' ? body.archival : (verdict === 'HISTORICAL' && !reverified),
    completion_proof: completionProof,
    allowlisted: typeof body.allowlisted === 'string' ? body.allowlisted : null,
    reason: typeof body.completion_proof_reason === 'string' ? body.completion_proof_reason.slice(0, 400)
      : typeof body.reason === 'string' ? body.reason.slice(0, 400) : null,
    threat_model: threat.slice(0, 600),
  };
}

async function probeFinalizeAcceptanceLive(projectPath, runId) {
  if (!isSafeRunIdForSpawn(runId)) return { available: false, note: 'refused: run id must not start with "-"' };
  if (!runFolderExists(projectPath, runId)) return { available: false, note: 'unknown run — refused before any spawn' };
  if (!fs.existsSync(activeFinalizeCjs())) return { available: false, note: 'the central forge-finalize.cjs was not found' };
  const args = [activeFinalizeCjs(), 'check', '--run', runId, '--root', projectPath, '--json'];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: PROJECT_ROOT, env: filteredEnv({ credentialFree: true }),
      timeout: FINALIZE_CHECK_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    const body = parseFinalizeStdout(stdout);
    if (!body) return { available: false, note: 'forge-finalize.cjs check returned output that is not the expected JSON shape' };
    return redactDeep(acceptanceFromCheck(body));
  } catch (err) {
    // exit 3 (anything but FINALIZED) is a normal outcome with real JSON on stdout — never a crash.
    const body = err && typeof err.stdout === 'string' ? parseFinalizeStdout(err.stdout) : null;
    if (body) return redactDeep(acceptanceFromCheck(body));
    if (err && err.killed) return { available: false, note: 'forge-finalize.cjs check timed out after ' + FINALIZE_CHECK_TIMEOUT_MS + 'ms' };
    return { available: false, note: 'forge-finalize.cjs check failed: ' + (err && err.message ? redactDeep(String(err.message)).slice(0, 300) : String(err)) };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/*  Receipt identity (the cache key) — refuses a linked receipt or run folder                        */
/* ------------------------------------------------------------------------------------------------ */
function realpathOrNull(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

/** receiptIdentity(projectPath, runId) -> { ok:true, key } | { ok:false, reason }.
 *  The receipt must be a plain file inside a plain run folder: a symbolic link or a junction (for the receipt
 *  itself or for the run folder) could point the judgement at a file outside the project, so it is refused
 *  before anything else reads it. */
export function receiptIdentity(projectPath, runId) {
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runDir = path.join(runsDir, runId);
  if (!containmentOk(runsDir, runDir)) return { ok: false, reason: 'path containment violation' };
  let runLst;
  try { runLst = fs.lstatSync(runDir); } catch { return { ok: false, reason: 'run folder missing' }; }
  if (runLst.isSymbolicLink() || !runLst.isDirectory()) return { ok: false, reason: 'the run folder is a link or junction — refused' };
  const receiptPath = path.join(runDir, 'run-finalized.json');
  let lst;
  try { lst = fs.lstatSync(receiptPath); } catch { return { ok: false, reason: 'absent' }; }
  if (lst.isSymbolicLink() || !lst.isFile()) return { ok: false, reason: 'the receipt is a link or junction, not a plain file — refused' };
  const realRuns = realpathOrNull(runsDir);
  const realReceipt = realpathOrNull(receiptPath);
  if (!realRuns || !realReceipt || !containmentOk(realRuns, realReceipt)) return { ok: false, reason: 'the receipt resolves outside the run folder — refused' };
  let ev = null;
  try { ev = fs.statSync(path.join(runDir, 'events.jsonl')); } catch { ev = null; }
  const key = [lst.mtimeMs, lst.size, ev ? ev.mtimeMs : '-', ev ? ev.size : '-'].join(':');
  return { ok: true, key };
}

/* ------------------------------------------------------------------------------------------------ */
/*  Cache + in-flight dedupe                                                                          */
/* ------------------------------------------------------------------------------------------------ */
const ACCEPTANCE_TTL_MS = 60_000;
const MAX_ACCEPTANCE_CACHE_ENTRIES = 500;
const cache = new Map(); // "<project>::<run>" -> { idKey, data, checkedAtMs }
const inFlight = new Map(); // "<project>::<run>::<idKey>" -> Promise<data>
let spawnCount = 0;
export function _resetFinalizeAcceptanceCacheForTests() { cache.clear(); inFlight.clear(); }
export function _getFinalizeAcceptanceSpawnCountForTests() { return spawnCount; }
export const _ACCEPTANCE_TTL_MS_FOR_TESTS = ACCEPTANCE_TTL_MS;

function cacheKey(projectPath, runId) { return projectPath + '::' + runId; }

/** peekFinalizeAcceptance(projectPath, runId, idKey, now) -> { data, fresh } | null — sync, never spawns. */
export function peekFinalizeAcceptance(projectPath, runId, idKey, now = Date.now()) {
  const hit = cache.get(cacheKey(projectPath, runId));
  if (!hit || hit.idKey !== idKey) return null;
  return { data: hit.data, fresh: now - hit.checkedAtMs < ACCEPTANCE_TTL_MS };
}

/** getFinalizeAcceptance(projectPath, runId, idKey, opts) -> Promise<acceptance>. A fresh cache hit is returned
 *  as is; otherwise one central check runs (deduped per run + receipt identity, through the shared slots).
 *  `force` skips the fresh-hit shortcut. A "pending" answer (the slot queue was full) is never cached. */
export function getFinalizeAcceptance(projectPath, runId, idKey, { now = Date.now(), force = false } = {}) {
  const ck = cacheKey(projectPath, runId);
  if (!force) {
    const peek = peekFinalizeAcceptance(projectPath, runId, idKey, now);
    if (peek && peek.fresh) return Promise.resolve(peek.data);
  }
  const fk = ck + '::' + idKey;
  const existing = inFlight.get(fk);
  if (existing) return existing;
  const p = (async () => {
    const granted = await acquireCentralCheckSlot();
    if (!granted) return { available: false, pending: true, note: 'too many concurrent central checks in flight — acceptance pending, try again shortly' };
    spawnCount++;
    try { return await probeFinalizeAcceptanceLive(projectPath, runId); }
    finally { releaseCentralCheckSlot(); }
  })()
    .then((data) => {
      if (!data.pending) {
        if (cache.size >= MAX_ACCEPTANCE_CACHE_ENTRIES && !cache.has(ck)) cache.delete(cache.keys().next().value);
        cache.set(ck, { idKey, data, checkedAtMs: Date.now() });
      }
      return data;
    })
    .finally(() => { inFlight.delete(fk); });
  inFlight.set(fk, p);
  return p;
}

/** The public per-run proof object the run list carries (null when there is no structurally valid receipt). */
export function proofSummary(acceptance) {
  if (!acceptance) return { available: false, pending: true, verdict: null, cause: null, reverified: null, archival: null, completion_proof: null, allowlisted: null, threat_model: DEFAULT_THREAT_MODEL, note: 'acceptance check not run yet' };
  if (acceptance.available !== true) return { available: false, pending: acceptance.pending === true, verdict: null, cause: null, reverified: null, archival: null, completion_proof: null, allowlisted: null, threat_model: DEFAULT_THREAT_MODEL, note: acceptance.note || null };
  return {
    available: true, pending: false,
    verdict: acceptance.verdict, cause: acceptance.cause, reverified: acceptance.reverified, archival: acceptance.archival,
    completion_proof: acceptance.completion_proof, allowlisted: acceptance.allowlisted, threat_model: acceptance.threat_model,
    note: acceptance.reason,
  };
}
