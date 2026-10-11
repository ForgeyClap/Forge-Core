// maintenance mode while forge-sync updates a project.
//
// `forge-sync install` holds `<project>/.claude/.forge-sync.lock` for the whole batch (pid, batch_id, started_at).
// While that lock is FRESH (younger than 6 h) the gateway's write routes that would write into that project's
// `.claude/` — or start a `claude` process that works inside it — answer HTTP 423 Locked with a plain message
// instead. Reads are never affected. A lock older than 6 h was left behind by a crashed run and is ignored
// (fail-open), the same rule as forge-sync.cjs::readLockStatus, forge-gate-hook.cjs and forge-toolhook.cjs.
// Read-only: this module never writes, removes or "repairs" a lock.
import fs from 'node:fs';
import path from 'node:path';

export const SYNC_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

let probeOverride = null;
/** Test-only seam (same `_set*ForTests` convention as the rest of this gateway): replaces the file probe so an
 *  HTTP route test can put a REGISTERED project into maintenance mode without writing a lock into a real project
 *  (a real lock would put this repo's own live hooks into maintenance mode). Call with no argument to restore. */
export function _setSyncLockProbeForTests(fn) { probeOverride = typeof fn === 'function' ? fn : null; }

/** readSyncLock(projectPath, now?) -> { locked, ageMs, pid, batchId, startedAt }. Never throws: a missing lock, an
 *  unreadable project or a stale lock is `locked:false`. The age comes from the lock's started_at/ts, else the file
 *  time; a lock dated in the future is judged by its file time. */
export function readSyncLock(projectPath, now = Date.now()) {
  if (probeOverride) return probeOverride(projectPath);
  const none = { locked: false, ageMs: null, pid: null, batchId: null, startedAt: null };
  try {
    const lp = path.join(projectPath, '.claude', '.forge-sync.lock');
    const st = fs.statSync(lp);
    let info = null;
    try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { info = null; }
    const startedMs = Date.parse(info && (info.started_at || info.ts));
    let ageMs = now - (Number.isFinite(startedMs) ? startedMs : st.mtimeMs);
    if (!(ageMs >= 0)) ageMs = now - st.mtimeMs;
    return {
      locked: ageMs < SYNC_LOCK_STALE_MS,
      ageMs,
      pid: info && Number.isInteger(info.pid) ? info.pid : null,
      batchId: info && typeof info.batch_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(info.batch_id) ? info.batch_id : null,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
    };
  } catch {
    return none;
  }
}

/** syncLockedBody(projectName, lock) — the plain JSON body of the 423 answer. */
export function syncLockedBody(projectName, lock) {
  const mins = Number.isFinite(lock.ageMs) ? Math.max(0, Math.round(lock.ageMs / 60000)) : null;
  return {
    ok: false,
    error: 'project "' + projectName + '" is being updated by forge-sync right now (maintenance mode), so nothing can be written into it'
      + (mins != null ? ' — the update started ' + mins + ' min ago' : '')
      + '. Try again when the update has finished; reading still works.',
    maintenance: true,
    sync_lock: { started_at: lock.startedAt, batch_id: lock.batchId, age_ms: lock.ageMs },
  };
}
