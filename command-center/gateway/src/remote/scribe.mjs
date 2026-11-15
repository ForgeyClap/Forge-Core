// Reads a project's scribe items for the phone inbox. The project's own
// .claude/forge-bin/forge-scribe.cjs is only the "this project has a scribe" marker: those are
// untrusted project bytes (a cloned repo), so the gateway runs its OWN central copy under
// PROJECT_ROOT with FORGE_PROJECT_ROOT=<project>, like routes/forge-ops.mjs does for its tools.
// execFile (no shell), 10 s timeout, minimal environment, cwd outside the project, and at most
// SCRIBE_CONCURRENCY processes at once across every request. The bridge never writes scribe state:
// owner acts go in as prompts (phone-routes). The central `list` still runs the scribe's own crash
// recovery first; forge-scribe.cjs has no read-only list path (only `gate`/`verify-chain` skip it).
// That recovery writes in the project's scribe store folder, which the project chooses (.forge/scribe
// or .claude/forge-scribe, and its canon can move it). So before every run the gateway asks the SAME
// central forge-paths.cjs the central scribe uses where that folder is, and runs nothing when its real
// location (junctions and symlinks followed) is outside the project, or when one of its store files is
// itself a link: { available: false, reason: 'store_outside_project' }. The check runs inside the
// concurrency slot, immediately before the spawn.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT, realpathOrNull } from '../paths.mjs';
import { containmentOk } from '../security.mjs';
import { realLocation } from './real-location.mjs';

export const SCRIBE_STATUSES = ['unclassified', 'open', 'planned', 'done', 'defer-proposed'];
export const SCRIBE_CONCURRENCY = 4;
const SCRIBE_FILE = 'forge-scribe.cjs';
const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME'];

const require = createRequire(import.meta.url);
let centralBinOverride = null;
const centralBin = () => centralBinOverride || path.join(PROJECT_ROOT, '.claude', 'forge-bin');
const centralScript = () => path.join(centralBin(), SCRIBE_FILE);
export const STORE_OUTSIDE_PROJECT = 'store_outside_project';

/** The scribe store folder the central scribe would use for this project: the central forge-paths.cjs
 *  stateDir(project, 'scribe') with the child's environment (no FORGE_STATE_DIR), else the legacy
 *  literal, exactly like forge-scribe-store.cjs scribeDirOf(). */
function scribeStoreDir(projectPath) {
  try {
    const fp = require(path.join(centralBin(), 'forge-paths.cjs'));
    if (fp && typeof fp.stateDir === 'function') return fp.stateDir(projectPath, 'scribe', { env: {} });
  } catch { /* missing or older forge-paths, or an unreadable canon: the scribe uses the legacy literal too */ }
  return path.join(projectPath, '.claude', 'forge-scribe');
}

/** The store files the scribe writes (forge-scribe-store.cjs paths()); none may be a link. */
const STORE_FILES = ['inbox.jsonl', 'ledger.jsonl', 'skipped.jsonl', 'state.json', 'DIGEST.md', '.lock'];

/** True when no store file is a symlink or junction (a missing file is fine; any other doubt is not). */
function storeFilesPlain(dir) {
  for (const name of STORE_FILES) {
    try {
      if (fs.lstatSync(path.join(dir, name)).isSymbolicLink()) return false;
    } catch (err) {
      if (err.code !== 'ENOENT') return false;
    }
  }
  return true;
}

/** True when the store folder really lies inside the project and holds no linked files (fail closed on any doubt). */
function storeInsideProject(projectPath) {
  try {
    const project = realpathOrNull(projectPath);
    const dir = scribeStoreDir(projectPath);
    const loc = realLocation(dir);
    return project !== null && loc !== null && containmentOk(project, loc) && storeFilesPlain(dir);
  } catch {
    return false;
  }
}

function minimalEnv(projectPath) {
  const env = {};
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.FORGE_PROJECT_ROOT = projectPath;
  return env;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** A queue that runs at most `max` async tasks at the same time. */
export function createLimiter(max) {
  let active = 0;
  let peak = 0;
  const queue = [];
  function next() {
    if (active >= max || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    peak = Math.max(peak, active);
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  }
  return {
    run(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); }); },
    stats() { return { active, queued: queue.length, peak }; },
    resetPeak() { peak = active; },
  };
}

const scribeSlots = createLimiter(SCRIBE_CONCURRENCY);

/** True when the project ships its own scribe CLI (a marker only; that copy is never run). */
export function hasScribe(projectPath) {
  return isFile(path.join(projectPath, '.claude', 'forge-bin', SCRIBE_FILE));
}

function spawnList(script, project) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, 'list', '--status', SCRIBE_STATUSES.join(','), '--json'], {
      cwd: PROJECT_ROOT, env: minimalEnv(project.path), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve({ available: true, items: [], error: 'scribe list failed: ' + String(err.killed ? 'timed out' : (err.code ?? err.message)).slice(0, 120) });
      try {
        const items = JSON.parse(stdout);
        if (!Array.isArray(items)) return resolve({ available: true, items: [], error: 'scribe list did not return a list' });
        return resolve({ available: true, items });
      } catch {
        return resolve({ available: true, items: [], error: 'scribe list returned no JSON' });
      }
    });
  });
}

/** `{ available, items, error? }` for one registry entry `{ name, path }`. Never throws. */
export function runScribeList(project) {
  if (!hasScribe(project.path)) return Promise.resolve({ available: false, items: [] });
  const script = centralScript();
  if (!isFile(script)) return Promise.resolve({ available: true, items: [], error: 'the gateway has no own copy of forge-scribe.cjs' });
  // checked inside the slot, right before the spawn: a queued request sees the store as it is then
  return scribeSlots.run(() => (storeInsideProject(project.path)
    ? spawnList(script, project)
    : { available: false, items: [], reason: STORE_OUTSIDE_PROJECT }));
}

/** Which owner actions the phone may offer for a scribe item status. */
export function scribeActions(status) {
  if (status === 'done' || status === 'defer-proposed') return ['ack'];
  if (status === 'unclassified' || status === 'open') return ['answer'];
  return [];
}

export const SCRIBE_TEXT_MAX = 300;
const EVIDENCE_MAX = 160;
// An absolute Windows (C:\..., \\server\...) or POSIX (/a/b...) path token; the phone gets its file name only.
// The drive letter must stand alone, so "https://..." is not read as a drive path.
const ABS_PATH_RE = /(?<![\w:/\\])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|]*|(?<=^|[\s"'(=])\/[^\s"'`<>|/]+\/[^\s"'`<>|]*/g;

/** Free scribe text made safe for the phone: one line, no absolute paths, at most `max` characters. */
function phoneText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(ABS_PATH_RE, (m) => m.split(/[\\/]/).filter(Boolean).pop() || '…')
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (s.length === 0) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** "wp_completed (run forge-...)" / "commit abc1234" for a done item's recorded evidence, else null. */
function doneEvidence(i) {
  const ev = i.evidence;
  if (i.status !== 'done' || !ev || typeof ev !== 'object' || typeof ev.type !== 'string' || typeof ev.ref !== 'string') return null;
  return phoneText(ev.type + ' ' + ev.ref + (typeof ev.run_id === 'string' ? ' (run ' + ev.run_id + ')' : ''), EVIDENCE_MAX);
}

/** The fields the phone gets (contract 4.4); nothing else from the scribe item leaves the PC. */
export function publicScribeItem(i) {
  return {
    rid: i.rid, status: i.status, class: i.class ?? null, title: i.title ?? null, quote: i.quote ?? null,
    created: i.created ?? null, updated: i.updated ?? null, actions: scribeActions(i.status),
    defer_reason: i.status === 'defer-proposed' || i.status === 'deferred' ? phoneText(i.reason, SCRIBE_TEXT_MAX) : null,
    done_evidence: doneEvidence(i),
  };
}

// Test-only seams. Production never calls them.
export function _setScribeCentralBinForTests(dir) { centralBinOverride = dir; }
export function _scribeSlotStatsForTests() { return scribeSlots.stats(); }
export function _resetScribeSlotStatsForTests() { scribeSlots.resetPeak(); }
