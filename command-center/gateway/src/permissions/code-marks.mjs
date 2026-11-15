// Forge gateway: the write-then-run marks on disk (WP-AUTONOMY-GW, verify round 8). permissions/store.mjs keeps,
// per folder, which code was written that no owner-approved run has covered yet (see its header). Before this round
// those marks lived in memory only, so a gateway restart forgot them and the next test run was auto-allowed. This file
// keeps them across a restart.
//
// Where: the per-user folder of the other permission state, ~/.forge/permissions/code-marks.json, never the gateway
// data dir (in the dev layout that sits inside this repository, where an agent may write files without a card and
// could wipe the marks). An agent's write to ~/.forge/permissions asks (hard-gate.mjs SETTINGS_RE). Same location rule
// as permissions/autonomy.mjs: when the file resolves inside a project folder the gateway knows, nothing is read or
// written and the marks stay in memory only.
//
// Rules: written atomically (a temp file renamed over the old one); bounded (the store caps the entries, a file over
// MAX_FILE_BYTES is not read); a mark older than CODE_MARKS_TTL_MS (30 days, the safety floor) has expired; a file that cannot be read
// or parsed is CORRUPT and the store then marks every folder once (fail closed: unknown history means "something may
// have been written"); a missing file is an empty one. Under the Node test runner nothing is read or written unless a
// test folder is set, and outside it only after enableCodeMarkPersistence() (routes/permissions.mjs, so the running
// gateway persists and a script that imports the store does not touch the owner's file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, realpathOrNull } from '../paths.mjs';
import { getContainmentRoots } from '../admitted-roots.mjs';
import { anyContainmentOk } from '../security.mjs';
import { realLocation } from '../remote/real-location.mjs';

export const CODE_MARKS_VERSION = 1;
// a write mark no longer expires by age after a day. Code a routine step wrote stays "uncovered" until an
// owner-approved runner of its family covers it; only this long safety floor (30 days) ever drops it by age alone.
export const CODE_MARKS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_ENTRIES = 5000; // a file with more is not one this gateway wrote: corrupt

const PER_USER_DIR = path.join(os.homedir(), '.forge', 'permissions');
let dirOverride = null;
let enabled = false;

export function codeMarksFile() {
  return path.join(dirOverride || PER_USER_DIR, 'code-marks.json');
}

/** routes/permissions.mjs (the running gateway) switches persistence on. */
export function enableCodeMarkPersistence() {
  enabled = true;
}

export function _setCodeMarksDirForTests(dir) {
  dirOverride = dir || null;
}

function active() {
  if (dirOverride) return true;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return enabled;
}

/** True when the file is outside every project folder the gateway knows (its real location). Fail closed. */
function locationOk() {
  try {
    const folders = [PROJECT_ROOT, ...getContainmentRoots()].map((f) => realpathOrNull(f) || path.resolve(f));
    const loc = realLocation(codeMarksFile());
    return loc !== null && !anyContainmentOk(folders, loc);
  } catch {
    return false;
  }
}

const isMark = (m) => m && typeof m === 'object' && Number.isSafeInteger(m.seq) && m.seq >= 0 && Number.isFinite(m.at);
const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
// a clock may be a little ahead on another gateway; a mark dated further ahead than this is not trusted.
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 250;

/**
 * The stored marks: null when persistence is off, refused by the location rule, or the file is missing;
 * `{ corrupt: true }` when it cannot be read or does not have the expected shape, or is a link (round 9, F5: a
 * symbolic link, or a hard link to another file, is never read); otherwise
 * `{ seq, writes: Map<key, {seq, at}>, clean: Map<folderKey, Map<family, {seq, at}>> }` without expired marks.
 * a write mark dated in the future counts from `now` (it still expires at the 30-day floor); an approval dated
 * in the future, or numbered above the file's own number, is dropped (fail closed: the folder stays marked).
 */
export function loadCodeMarks(now = Date.now()) {
  if (!active() || !locationOk()) return null;
  return readMarks(codeMarksFile(), now);
}

function readMarks(file, now) {
  let raw;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_FILE_BYTES) return { corrupt: true };
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? null : { corrupt: true };
  }
  let data;
  try { data = JSON.parse(raw); } catch { return { corrupt: true }; }
  if (!isPlainObject(data) || data.version !== CODE_MARKS_VERSION || !Number.isSafeInteger(data.seq) || data.seq < 0
    || !isPlainObject(data.writes) || !isPlainObject(data.clean)) return { corrupt: true };
  const writes = new Map();
  const clean = new Map();
  let count = 0;
  let maxSeq = data.seq;
  for (const [key, mark] of Object.entries(data.writes)) {
    if (!isMark(mark) || (count += 1) > MAX_ENTRIES) return { corrupt: true };
    const at = mark.at > now + FUTURE_SKEW_MS ? now : mark.at;
    if (now - at <= CODE_MARKS_TTL_MS) writes.set(key, { seq: mark.seq, at });
    maxSeq = Math.max(maxSeq, mark.seq);
  }
  for (const [key, families] of Object.entries(data.clean)) {
    if (!isPlainObject(families)) return { corrupt: true };
    const kept = new Map();
    for (const [family, mark] of Object.entries(families)) {
      if (!isMark(mark) || (count += 1) > MAX_ENTRIES) return { corrupt: true };
      if (mark.at > now + FUTURE_SKEW_MS || mark.seq > maxSeq) continue;
      if (now - mark.at <= CODE_MARKS_TTL_MS) kept.set(family, { seq: mark.seq, at: mark.at });
    }
    if (kept.size) clean.set(key, kept);
  }
  return { seq: maxSeq, writes, clean };
}

/**
 * Writes the marks atomically. False when persistence is off or refused, or the write failed. Never throws.
 * with `merge`, the save is a read-modify-write under a short lock file: `merge(disk)` gets what is on
 * disk now (null, `{ corrupt: true }` or the marks, read like loadCodeMarks) and returns the marks to write, so two
 * gateways that share the file keep each other's marks. A lock older than 10 seconds is stale; a lock held longer
 * than a quarter second is waited out no further (the save then runs without it).
 */
export function saveCodeMarks(state, now = Date.now(), { merge = null } = {}) {
  if (!active() || !locationOk()) return false;
  const file = codeMarksFile();
  const unlock = takeLock(file);
  try {
    let next = state;
    if (typeof merge === 'function') next = merge(readMarks(file, now)) || state;
    return writeMarks(file, next, now);
  } catch {
    return false;
  } finally {
    unlock();
  }
}

function writeMarks(file, { seq, writes, clean }, now) {
  const data = { version: CODE_MARKS_VERSION, seq, saved_at: new Date(now).toISOString(), writes: {}, clean: {} };
  for (const [key, mark] of writes) if (now - mark.at <= CODE_MARKS_TTL_MS) data.writes[key] = { seq: mark.seq, at: mark.at };
  for (const [key, families] of clean) {
    const kept = {};
    for (const [family, mark] of families) if (now - mark.at <= CODE_MARKS_TTL_MS) kept[family] = { seq: mark.seq, at: mark.at };
    if (Object.keys(kept).length) data.clean[key] = kept;
  }
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing was left */ }
    return false;
  }
}

const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

/** The lock beside the marks file; returns the function that gives it back (a no-op when it was not taken). */
function takeLock(file) {
  const lockFile = file + '.lock';
  const until = Date.now() + LOCK_WAIT_MS;
  let clearedStale = false;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the write reports it */ }
  while (Date.now() <= until) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(lockFile); } catch { /* already gone */ } };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return () => {};
    }
    try {
      const st = fs.lstatSync(lockFile);
      const removable = st.isFile() || st.isSymbolicLink();
      if (!clearedStale && removable && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        clearedStale = true;
        fs.unlinkSync(lockFile);
        continue;
      }
      if (!removable) return () => {}; // not a lock this gateway made: save without it
    } catch { /* it went away: try again */ }
    pause(10);
  }
  return () => {};
}
