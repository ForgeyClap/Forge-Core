#!/usr/bin/env node
'use strict';
/**
 * account-rotator-vault.cjs — the storage primitives of the account rotator.
 * The swap transaction itself lives in account-rotator-txn.cjs; this file only reads and writes files.
 *
 * Layout (HOME = FORGE_ACCOUNT_ROTATOR_HOME || ~/.claude — a test/isolation seam, same idea as usage-guard's
 * FORGE_USAGE_GUARD_HOME; the profile file = FORGE_ACCOUNT_ROTATOR_PROFILE || <parent of HOME>/.claude.json):
 *   HOME/.credentials.json               Claude Code's login (only the `claudeAiOauth` key is ever replaced)
 *   <profile>                            Claude Code's profile (only the `oauthAccount` key is ever replaced)
 *   HOME/forge-accounts/<name>.json      one vault slot per enrolled account: {credentials:{claudeAiOauth}, oauthAccount,
 *                                        token (setup-token mode), tokenBinding, enrolledAt, updatedAt}. Other keys of the
 *                                        login file (MCP OAuth tokens etc.) are machine-level: never copied, never swapped.
 *   HOME/forge-accounts/<name>.prev.json the previous generation of a slot, written before every capture (AR-04)
 *   HOME/forge-accounts/.credentials.pre-switch.json   ONLY the `claudeAiOauth` block of the login that was active before
 *                                        a swap (never MCP tokens); deleted again after a verified swap (L1)
 *   HOME/forge-accounts/txn.json         token-free swap transaction record (phase, names, file generations, temp names,
 *                                        salted token fingerprints — AR-V01)
 *   HOME/forge-accounts/.fp-salt         the per-vault random salt behind those fingerprints (0600; never printed)
 *   HOME/forge-accounts/txn.lock         the ONE lock around every account-changing transaction (AR-02)
 *   HOME/forge-accounts/state.json       token-free: readings, committed swaps, failures, pending verification
 *   HOME/forge-accounts/handoff.json     token-free handoff snapshot (account-rotator-handoff.cjs)
 *   HOME/forge-accounts/rotator.log      token-free log, rotated at ~1 MB · rotator.pid · rotator.stop (graceful stop)
 *   HOME/FORGE_ACCOUNT_ROTATION.json     token-free notification for dashboards/hooks
 *
 * SECRECY: every token this process loads is registered with registerSecret(); every log line, state file, handoff,
 * notification and CLI output passes scrub(), which replaces a registered secret with [redacted] — defence in depth on
 * top of never building a message from a token. Permissions: files are created 0600 (enforced on POSIX; on Windows
 * they inherit the user-profile ACL of ~/.claude, private to the user by default — Node cannot set Windows ACLs
 * without dependencies). Writes are atomic per file (temp file in the same directory, fsync, rename) and the caller's
 * "unchanged since I read it" check runs again immediately before EVERY rename attempt, including retries (AR-03).
 * HONEST LIMIT (AR-V03): a rename cannot be made conditional on Windows, so the check and the rename are two steps —
 * a write by Claude Code's own token refresher that lands in the microseconds between them is overwritten and not
 * detectable afterwards (the session still holds its tokens in memory and rewrites them at its next refresh; if it
 * exits first, that account needs `claude /login` again). This is BEST-EFFORT, DETECTED AND REPAIRED where possible
 * (post-write re-read in account-rotator-txn.cjs, reconcile + repair on every entry) — never a guaranteed conditional write.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const guardRedact = require('./usage-guard-redact.cjs');
const guardState = require('./usage-guard-state.cjs');

const RESERVED = new Set(['state', 'handoff', 'rotator', 'txn', 'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const LOG_MAX_BYTES = 1024 * 1024;
const HISTORY_MAX = 50;
const TXN_LOCK_STALE_MS = 5 * 60 * 1000;
const TMP_RE = /^\.(.+)\.(\d+)\.[0-9a-f]{8}\.tmp$/;

// ---- secrets registry + scrub ------------------------------------------------------------------------------
const SECRETS = new Set();
function registerSecret(s) { if (typeof s === 'string' && s.length >= 8) SECRETS.add(s); return s; }
function registerLogin(obj) {
  const o = obj && obj.claudeAiOauth ? obj.claudeAiOauth : obj;
  if (o && typeof o === 'object') { registerSecret(o.accessToken); registerSecret(o.refreshToken); }
}
function scrub(text) {
  let s = String(text);
  for (const sec of SECRETS) if (s.includes(sec)) s = s.split(sec).join('[redacted]');
  return s;
}

// ---- paths ------------------------------------------------------------------------------------------------
function paths(env) {
  const e = env || process.env;
  const home = path.resolve(e.FORGE_ACCOUNT_ROTATOR_HOME || path.join(os.homedir(), '.claude'));
  const vault = path.join(home, 'forge-accounts');
  return {
    home, vault,
    creds: path.join(home, '.credentials.json'),
    profile: path.resolve(e.FORGE_ACCOUNT_ROTATOR_PROFILE || path.join(path.dirname(home), '.claude.json')),
    state: path.join(vault, 'state.json'), handoff: path.join(vault, 'handoff.json'), txn: path.join(vault, 'txn.json'),
    txnLock: path.join(vault, 'txn.lock'), log: path.join(vault, 'rotator.log'), pid: path.join(vault, 'rotator.pid'),
    stop: path.join(vault, 'rotator.stop'), backup: path.join(vault, '.credentials.pre-switch.json'),
    fpSalt: path.join(vault, '.fp-salt'),
    notify: path.join(home, 'FORGE_ACCOUNT_ROTATION.json'),
  };
}
/** fpSalt(P) -> the per-vault random salt (hex), created 0600 on first use. tokenFp(P, token) -> a token-free
 *  fingerprint: HMAC-SHA256(salt, token), first 32 hex chars. Without the salt file the fingerprint cannot be derived
 *  from a token, so txn.json may carry it (AR-V01). Never a secret itself; never logged either. */
function fpSalt(P) {
  const cur = readRaw(P.fpSalt);
  if (cur && /^[0-9a-f]{64}$/.test(cur.trim())) return cur.trim();
  ensureVault(P);
  const salt = crypto.randomBytes(32).toString('hex');
  try { atomicWrite(P.fpSalt, salt + '\n'); } catch { /* another process may have created it first */ }
  const again = readRaw(P.fpSalt);
  return again && /^[0-9a-f]{64}$/.test(again.trim()) ? again.trim() : salt;
}
function tokenFp(P, token) {
  if (typeof token !== 'string' || !token) return null;
  return crypto.createHmac('sha256', fpSalt(P)).update(token).digest('hex').slice(0, 32);
}
function ensureVault(P) {
  fs.mkdirSync(P.vault, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { try { fs.chmodSync(P.vault, 0o700); } catch { /* best effort */ } }
}
function validName(name) { return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name.toLowerCase()); }
function slotPath(P, name) { return path.join(P.vault, name + '.json'); }

// ---- JSON text with its original style (BOM, EOL, indent, trailing newline) ----------------------------------
function detectStyle(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const m = /\n([ \t]+)\S/.exec(body);
  return { bom, eol: body.includes('\r\n') ? '\r\n' : '\n', indent: m ? m[1] : 0, trailing: /\n$/.test(body) };
}
function parseText(raw) { return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); }
function serialize(obj, style) {
  let s = style && style.indent ? JSON.stringify(obj, null, style.indent) : JSON.stringify(obj);
  if (style && style.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  if (style && style.trailing) s += style.eol;
  return (style && style.bom ? '﻿' : '') + s;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---- atomic write with a best-effort "unchanged" check (NOT a conditional rename — see the header) --------------
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } }
const changed = () => Object.assign(new Error('file changed under us'), { code: 'ECHANGED' });
/** renameWithRetry(tmp, file, beforeRename, renameImpl) — beforeRename() is evaluated immediately before EVERY attempt
 *  (AR-03): a retry after a transient Windows lock never renames over a file that changed while we waited. The check
 *  and the rename remain two steps (AR-V03): the window between them is minimised, not closed. */
function renameWithRetry(tmp, file, beforeRename, renameImpl) {
  const rn = renameImpl || fs.renameSync;
  for (let i = 0; ; i++) {
    if (typeof beforeRename === 'function' && !beforeRename()) throw changed();
    try { rn(tmp, file); return; }
    catch (e) { if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; sleepSync(40 * (i + 1)); }
  }
}
/** atomicWrite(file, data, opts) — opts.mode (default 0600), opts.beforeRename() -> false aborts with ECHANGED,
 *  opts.onTemp(name) reports the temp file name (for the transaction record), opts.renameImpl (test seam). */
function atomicWrite(file, data, opts) {
  const o = opts || {};
  const mode = o.mode === undefined ? 0o600 : o.mode;
  const base = '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const tmp = path.join(path.dirname(file), base);
  if (typeof o.onTemp === 'function') o.onTemp(base);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try { fs.writeSync(fd, data, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, file, o.beforeRename, o.renameImpl);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } throw e; }
}
function readRaw(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function fileMode(file) { try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; } }
function generation(file) { try { const s = fs.statSync(file); return s.mtimeMs + ':' + s.size; } catch { return null; } }
function writeJsonFile(file, obj) { atomicWrite(file, scrub(JSON.stringify(obj, null, 2)) + '\n'); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
/** sweepTemps(P, isAlive) -> [removed names]. Temp files of OUR atomic writes ('.<base>.<pid>.<8 hex>.tmp') left
 *  behind by a process that is no longer alive, in the login, profile and vault folders only (D14). */
function sweepTemps(P, isAlive) {
  const alive = isAlive || pidAlive;
  const removed = [];
  const targets = [[P.home, new Set(['.credentials.json', 'FORGE_USAGE_GUARD_STATE.json', 'FORGE_ACCOUNT_ROTATION.json'])],
    [path.dirname(P.profile), new Set([path.basename(P.profile)])], [P.vault, null]];
  for (const [dir, names] of targets) {
    let list = [];
    try { list = fs.readdirSync(dir); } catch { continue; }
    for (const f of list) {
      const m = TMP_RE.exec(f);
      if (!m || (names && !names.has(m[1])) || alive(Number(m[2]))) continue;
      try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* best effort */ }
    }
  }
  return removed;
}

// ---- the transaction lock (AR-02) ----------------------------------------------------------------------------
/** withTxnLock(P, fn, opts) -> {ok, value} | {ok:false, reason}. One exclusive lock (usage-guard-state.cjs's fenced
 *  wx lock with stale reclaim and heartbeat) around every account-changing transaction. */
async function withTxnLock(P, fn, opts) {
  ensureVault(P);
  return guardState.withStateLock(P.txnLock, fn, { timeoutMs: (opts && opts.timeoutMs) || 10000, staleMs: TXN_LOCK_STALE_MS });
}

// ---- log --------------------------------------------------------------------------------------------------
function log(P, msg, opts) {
  const line = new Date().toISOString() + ' ' + scrub(msg);
  if (!(opts && opts.quiet)) console.log(line);
  try {
    ensureVault(P);
    try { if (fs.statSync(P.log).size >= LOG_MAX_BYTES) { fs.copyFileSync(P.log, P.log + '.1'); fs.truncateSync(P.log, 0); } } catch { /* no log yet */ }
    fs.appendFileSync(P.log, line + '\n', { mode: 0o600 });
  } catch { /* a log failure never stops the rotator */ }
  return line;
}

// ---- live login (the two Claude Code files) -------------------------------------------------------------------
/** readLive(P) -> {ok, credsRaw, creds, profileRaw, profile, reason}. Fixed-text reasons only. */
function readLive(P) {
  const credsRaw = readRaw(P.creds);
  if (credsRaw === null) return { ok: false, reason: 'login file missing or unreadable (.credentials.json)' };
  let creds;
  try { creds = parseText(credsRaw); } catch { return { ok: false, reason: 'login file is not valid JSON (.credentials.json)' }; }
  if (!isObj(creds) || !isObj(creds.claudeAiOauth)) return { ok: false, reason: 'login file has no claudeAiOauth login (.credentials.json)' };
  registerLogin(creds);
  const profileRaw = readRaw(P.profile);
  if (profileRaw === null) return { ok: false, reason: 'profile file missing or unreadable (.claude.json)' };
  let profile;
  try { profile = parseText(profileRaw); } catch { return { ok: false, reason: 'profile file is not valid JSON (.claude.json)' }; }
  if (!isObj(profile)) return { ok: false, reason: 'profile file has an unexpected shape (.claude.json)' };
  return { ok: true, credsRaw, creds, profileRaw, profile };
}
function loginShapeOk(oauth) {
  return isObj(oauth) && guardRedact.validateTokenShape(oauth.accessToken) && guardRedact.validateTokenShape(oauth.refreshToken);
}

// ---- slots ------------------------------------------------------------------------------------------------
function readSlot(P, name) {
  if (!validName(name)) return null; // never a path outside the vault (e.g. "../x")
  const raw = readRaw(slotPath(P, name));
  if (raw === null) return null;
  try {
    const s = parseText(raw);
    if (!isObj(s)) return { name, broken: true };
    if (s.credentials) registerLogin(s.credentials);
    registerSecret(s.token);
    return Object.assign({}, s, { name });
  } catch { return { name, broken: true }; }
}
function listSlots(P) {
  let names = [];
  try { names = fs.readdirSync(P.vault).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -5)).filter(validName); } catch { return []; }
  return names.sort().map((n) => readSlot(P, n)).filter(Boolean);
}
/** writeSlot(P, slot, opts) — opts.keepPrev writes the CURRENT slot file to <name>.prev.json (0600) first (AR-04).
 *  NOT scrubbed: a slot IS the vault and must hold the real secrets. Never printed, never logged. */
function writeSlot(P, slot, opts) {
  if (!slot || !validName(slot.name)) throw new Error('invalid vault slot name');
  ensureVault(P);
  if (opts && opts.keepPrev) {
    const cur = readRaw(slotPath(P, slot.name));
    if (cur !== null) atomicWrite(path.join(P.vault, slot.name + '.prev.json'), cur);
  }
  const out = { version: 1, name: slot.name, credentials: slot.credentials || null, oauthAccount: slot.oauthAccount || null,
    token: slot.token || null, tokenBinding: slot.tokenBinding || null, enrolledAt: slot.enrolledAt || null,
    tokenEnrolledAt: slot.tokenEnrolledAt || null, updatedAt: new Date().toISOString() };
  atomicWrite(slotPath(P, slot.name), JSON.stringify(out, null, 2) + '\n');
  return out;
}
function removeSlot(P, name) {
  fs.unlinkSync(slotPath(P, name));
  try { fs.unlinkSync(path.join(P.vault, name + '.prev.json')); } catch { /* none */ }
}
/** matchActive(live, slots) -> {slot, rotated, inSync, reason}. The active slot is the ONE slot whose accountUuid equals
 *  the profile's — refused when the login file's refresh token belongs to a DIFFERENT slot. `rotated` = the refresh
 *  token is one no slot knows: an IDENTIFICATION HINT only — nothing is measured for, written to or captured into a
 *  slot on that basis (AR-04 / AR-V01: ownership must be established independently first — see
 *  account-rotator-txn.cjs corroboratedCapture). In-memory comparison only. */
function matchActive(live, slots) {
  const uuid = live && live.profile && live.profile.oauthAccount && live.profile.oauthAccount.accountUuid;
  const rt = live && live.creds && live.creds.claudeAiOauth && live.creds.claudeAiOauth.refreshToken;
  if (typeof uuid !== 'string' || !uuid || typeof rt !== 'string' || !rt) return { slot: null, reason: 'no-login' };
  const byUuid = slots.filter((s) => s && !s.broken && s.oauthAccount && s.oauthAccount.accountUuid === uuid);
  const rtOwner = slots.find((s) => s && !s.broken && s.credentials && s.credentials.claudeAiOauth && s.credentials.claudeAiOauth.refreshToken === rt);
  if (rtOwner && (!rtOwner.oauthAccount || rtOwner.oauthAccount.accountUuid !== uuid)) return { slot: null, reason: 'inconsistent' };
  if (byUuid.length !== 1) return { slot: null, reason: byUuid.length ? 'ambiguous' : 'not-enrolled' };
  const same = sameJson(byUuid[0].credentials && byUuid[0].credentials.claudeAiOauth, live.creds.claudeAiOauth);
  return { slot: byUuid[0], rotated: !rtOwner, inSync: same, reason: null };
}

// ---- token-free records ----------------------------------------------------------------------------------------
function readJsonFile(file) { try { const v = parseText(readRaw(file) || ''); return isObj(v) ? v : null; } catch { return null; } }
function readState(P) {
  const raw = readRaw(P.state);
  const fresh = { version: 1, readings: {}, tokenReadings: {}, history: [], swaps: [], failures: [], slotFlags: {} };
  if (raw === null) return fresh;
  try {
    const s = parseText(raw);
    if (!isObj(s)) throw new Error('shape');
    for (const k of ['readings', 'tokenReadings', 'slotFlags']) s[k] = isObj(s[k]) ? s[k] : {};
    for (const k of ['history', 'swaps', 'failures']) s[k] = Array.isArray(s[k]) ? s[k] : [];
    return s;
  } catch { return Object.assign(fresh, { corrupt: true }); }
}
function writeState(P, s) {
  ensureVault(P);
  const out = Object.assign({}, s);
  // bounded by count only (the 24 h windows are evaluated by the caller with its own clock)
  out.history = (Array.isArray(out.history) ? out.history : []).slice(-HISTORY_MAX);
  out.swaps = (Array.isArray(out.swaps) ? out.swaps : []).slice(-100);
  out.failures = (Array.isArray(out.failures) ? out.failures : []).slice(-100);
  delete out.corrupt;
  out.updatedAt = new Date().toISOString();
  writeJsonFile(P.state, out);
  return out;
}
/** updateState(P, mutate) -> the written state, or null when the lock could not be taken (never writes unlocked). */
async function updateState(P, mutate) {
  ensureVault(P);
  const r = await guardState.withStateLock(P.state + '.lock', (fence) => {
    const s = readState(P);
    const next = mutate(s) || s;
    if (!fence()) return { fenced: true };
    return { fenced: false, state: writeState(P, next) };
  }, { timeoutMs: 15000 });
  if (!r.ok || !r.value || r.value.fenced) return null;
  return r.value.state;
}
function writeHandoffFile(P, h) { ensureVault(P); writeJsonFile(P.handoff, Object.assign({}, h, { updatedAt: new Date().toISOString() })); }
function readHandoffFile(P) { return readJsonFile(P.handoff); }
function writeNotification(P, n) {
  try { fs.mkdirSync(P.home, { recursive: true }); writeJsonFile(P.notify, Object.assign({ version: 1, updatedAt: new Date().toISOString() }, n)); return true; } catch { return false; }
}

module.exports = {
  RESERVED, NAME_RE, LOG_MAX_BYTES, HISTORY_MAX, TMP_RE,
  registerSecret, registerLogin, scrub, paths, ensureVault, validName, slotPath, fpSalt, tokenFp,
  detectStyle, parseText, serialize, sameJson, isObj, atomicWrite, renameWithRetry, readRaw, fileMode, generation, sleepSync,
  pidAlive, sweepTemps, withTxnLock, log, readLive, loginShapeOk, readSlot, listSlots, writeSlot, removeSlot, matchActive,
  readJsonFile, readState, writeState, updateState, writeHandoffFile, readHandoffFile, writeNotification,
};
