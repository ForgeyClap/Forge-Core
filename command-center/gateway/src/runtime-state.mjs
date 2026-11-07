// runtime-state.mjs — DEGRADED-vlag voor de gateway (audit G8.1).
// De uncaught-handlers logden alleen ("server stays up"): de gateway bleef serveren met mogelijk
// gecorrumpeerde in-memory-invarianten, /api/health bleef groen en de supervisor (die alleen op
// proces-exit reageert) kreeg nooit een signaal. Nu: de eerste uncaught markeert de runtime DEGRADED
// (health wordt rood), waarna een GECONTROLEERDE drain volgt — nieuwe verbindingen weigeren, lopende
// executies een begrensde tijd laten afronden, dan exit(1) zodat de SUPERVISOR (de enige
// herstart-autoriteit, met bestaande backoff + crash-loop-brake) een verse, integere gateway start.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let uncaughtCount = 0;
let lastUncaughtAt = null;
let lastUncaughtMessage = null;
let draining = false;

export function markUncaught(err) {
  uncaughtCount++;
  lastUncaughtAt = new Date().toISOString();
  lastUncaughtMessage = String((err && (err.stack || err.message)) || err).slice(0, 500);
}
export function markDraining() { draining = true; }
export function isDegraded() { return uncaughtCount > 0; }
export function isDraining() { return draining; }
export function getRuntimeState() {
  return uncaughtCount === 0
    ? { state: 'OK', uncaught_count: 0 }
    : { state: draining ? 'DRAINING' : 'DEGRADED', uncaught_count: uncaughtCount, last_uncaught_at: lastUncaughtAt, last_uncaught: lastUncaughtMessage };
}

// WP B1a: per-boot identity + the port this gateway REALLY listens on. Several
// gateways can now run side by side (a dev gateway on 4100 and an installed Electron app that fell
// back to a free loopback port), so a caller needs to tell which one answered (`instance_id` in
// GET /api/health) and every module that builds this gateway's own origin (security.mjs's origin
// allowlist, exec-argv.mjs's ask-MCP callback origin) must follow the actual port, never a literal.
export const DEFAULT_GATEWAY_PORT = 4100;
export const GATEWAY_HOST = '127.0.0.1';
/** Random per process, stable for the whole life of this process. */
export const INSTANCE_ID = crypto.randomUUID();

const MAX_PORT = 65535;
function parsePort(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT ? n : null;
}

/** The port the operator pinned via env (CC_PORT wins, then FORGE_GATEWAY_PORT), or null when none
 *  is set. A pinned port is strict: bin.mjs never falls back away from it. */
export function configuredGatewayPort(env = process.env) {
  return parsePort(env.CC_PORT) ?? parsePort(env.FORGE_GATEWAY_PORT);
}

let gatewayPort = configuredGatewayPort() ?? DEFAULT_GATEWAY_PORT;
/** Called by bin.mjs once the server is really bound (also after a fallback to a free port). */
export function setGatewayPort(port) {
  const p = parsePort(port);
  if (p === null) throw new Error('setGatewayPort: invalid port ' + String(port));
  gatewayPort = p;
}
export function getGatewayPort() { return gatewayPort; }
export function gatewayOrigin() { return 'http://' + GATEWAY_HOST + ':' + gatewayPort; }

/** True when a GET /api/health body comes from a gateway writing to the SAME data dir as `ours`
 *  ({ dataDir, projectRoot, usesDefaultDataDir, samePath(a, b) }). bin.mjs then refuses to start a
 *  second gateway on that data (the supervisor's EADDRINUSE fast-stop relies on it) instead of
 *  falling back to a free port. A gateway from before WP B1a reports no data_dir: it used the
 *  default data dir under its project root. */
export function isSameGatewayHealth(health, ours) {
  const g = health && typeof health === 'object' ? health.gateway : null;
  if (!g || typeof g !== 'object') return false;
  if (typeof g.data_dir === 'string') return ours.samePath(g.data_dir, ours.dataDir);
  return typeof g.project_root === 'string' && ours.samePath(g.project_root, ours.projectRoot) && ours.usesDefaultDataDir === true;
}

/** The port an unpinned gateway tries first: 4100. CC_TEST_PREFERRED_PORT replaces it for TESTS ONLY,
 *  so the duplicate-refusal and fail-closed paths run on a dev machine whose 4100 is already taken. */
export function preferredGatewayPort(env = process.env) {
  return parsePort(env.CC_TEST_PREFERRED_PORT) ?? DEFAULT_GATEWAY_PORT;
}

// ── Data-dir lock (WP B1a rework) ─────────────────────────────────────────────────────
// One gateway per data dir, whatever port it listens on. bin.mjs takes <data dir>/gateway.lock
// BEFORE it binds a port: the file is created with flag 'wx' (fails when it exists) and holds
// {pid, instance_id, port, started}. A lock whose pid is no longer running is stale and reclaimed
// with a logged notice; a live one makes the new gateway refuse to start (exit 3). The port probe in
// bin.mjs is only a second line for gateways from before this lock.
export const DATA_DIR_LOCK_NAME = 'gateway.lock';
export const LOCK_REFUSED_EXIT_CODE = 3;
export const LOCK_REFUSED_MARKER = 'another gateway owns this data dir';
// An unreadable lock this young may be a gateway that created it and has not written it yet: live.
const UNREADABLE_LOCK_GRACE_MS = 10000;
const MAX_LOCK_ATTEMPTS = 3;
let heldLock = null; // { file, record } once this process owns the lock

/** True when a process with this pid exists (EPERM = it exists but belongs to someone else). */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return Boolean(err && err.code === 'EPERM'); }
}

function readLockFile(file, now) {
  let raw;
  let mtimeMs;
  try { raw = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs; } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing' };
    throw err;
  }
  try {
    const info = JSON.parse(raw);
    if (info && Number.isInteger(info.pid) && info.pid > 0) return { state: 'ok', info };
  } catch { /* falls through: unreadable */ }
  return { state: 'unreadable', ageMs: now - mtimeMs };
}

function sameLock(a, b) {
  if (a.state !== b.state) return false;
  return a.state !== 'ok' || (a.info.pid === b.info.pid && a.info.instance_id === b.info.instance_id);
}

/** Moves a stale lock aside and removes it. If what got moved is NOT the lock judged stale (another
 *  gateway took the lock in between), it is linked back and the caller re-reads it. */
function reclaimStale(file, judged) {
  const aside = file + '.stale-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try { fs.renameSync(file, aside); } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true };
    return { ok: false, reason: 'could not move the stale lock aside (' + (err && err.code) + ')' };
  }
  if (!sameLock(readLockFile(aside, Date.now()), judged)) {
    try { fs.linkSync(aside, file); fs.unlinkSync(aside); return { ok: true }; } catch (err) {
      return { ok: false, reason: 'lock changed while reclaiming it; left at ' + aside + ' (' + (err && err.code) + ')' };
    }
  }
  fs.unlinkSync(aside);
  return { ok: true };
}

/** Takes the data-dir lock. Returns { ok: true, file, reclaimed } or { ok: false, file, owner, reason }.
 *  Fails closed: anything it cannot prove stale counts as a live owner. `isAlive`, `now` and `log`
 *  are injectable for tests. */
export function acquireDataDirLock(dataDir, { port = null, isAlive = isPidAlive, now = Date.now, log = console.error } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DATA_DIR_LOCK_NAME);
  const record = { pid: process.pid, instance_id: INSTANCE_ID, port, started: new Date(now()).toISOString() };
  let reclaimed = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
      heldLock = { file, record };
      return { ok: true, file, reclaimed };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    const cur = readLockFile(file, now());
    if (cur.state === 'missing') continue;
    if (cur.state === 'ok' && cur.info.pid !== process.pid && isAlive(cur.info.pid)) {
      return { ok: false, file, owner: cur.info, reason: 'live' };
    }
    if (cur.state === 'unreadable' && cur.ageMs < UNREADABLE_LOCK_GRACE_MS) {
      return { ok: false, file, owner: null, reason: 'unreadable lock written ' + Math.round(cur.ageMs) + ' ms ago (another gateway may be starting)' };
    }
    const r = reclaimStale(file, cur);
    if (!r.ok) return { ok: false, file, owner: null, reason: r.reason };
    reclaimed = cur.state === 'ok' ? cur.info : { unreadable: true };
    log('[gateway-lock] reclaimed a stale data-dir lock at ' + file + ' ('
      + (cur.state === 'ok' ? 'pid ' + cur.info.pid + ' is no longer running' : 'unreadable for ' + Math.round(cur.ageMs) + ' ms') + ')');
  }
  return { ok: false, file, owner: null, reason: 'could not take the lock after ' + MAX_LOCK_ATTEMPTS + ' attempts' };
}

/** Records the port this gateway really listens on in the lock it holds (atomic replace). */
export function updateDataDirLockPort(port) {
  if (!heldLock) return false;
  const record = { ...heldLock.record, port };
  const tmp = heldLock.file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record), { flag: 'w' });
  try { fs.renameSync(tmp, heldLock.file); } catch {
    // Windows refuses the replace while another process has the lock open for reading: write in place.
    fs.writeFileSync(heldLock.file, JSON.stringify(record));
    fs.unlinkSync(tmp);
  }
  heldLock = { file: heldLock.file, record };
  return true;
}

/** Removes the lock on a normal exit, only when it is still this process's own. A hard kill leaves it
 *  behind with a dead pid; the next gateway reclaims it as stale. */
export function releaseDataDirLock() {
  if (!heldLock) return false;
  const { file, record } = heldLock;
  heldLock = null;
  try {
    const cur = readLockFile(file, Date.now());
    if (cur.state === 'ok' && cur.info.pid === record.pid && cur.info.instance_id === record.instance_id) {
      fs.unlinkSync(file);
      return true;
    }
  } catch { /* best effort on the way out: a leftover lock is reclaimed as stale next time */ }
  return false;
}

/** One line for a refused start, naming the owner and the file. */
export function lockRefusalMessage(result) {
  const o = result.owner;
  const who = o ? '(pid ' + o.pid + ', port ' + (o.port ?? 'not bound yet') + ')' : '(' + result.reason + ')';
  return LOCK_REFUSED_MARKER + ' ' + who + ': ' + result.file
    + '. Stop that gateway first; if no gateway is running, the lock is left from a crash and can be removed.';
}
