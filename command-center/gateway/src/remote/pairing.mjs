// Remote Bridge pairing codes: one active one-time code (sha256 only, 5 minutes, single use) plus
// lockouts for wrong codes: per IP (5 in 15 min) and across all IPs (20 in 15 min, which also drops
// the current code). In memory only: a gateway restart drops the code and the counters.
import crypto from 'node:crypto';
import { pruneMap, MAX_TRACKED_IPS } from './bounded-map.mjs';

export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const PER_IP_FAILS = 5;
const GLOBAL_FAILS = 20;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function randomCode() {
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  return out;
}

/** Upper-case, spaces and dashes removed. */
export function normalizeCode(input) {
  return typeof input === 'string' ? input.replace(/[\s-]+/g, '').toUpperCase() : '';
}

export function createPairing({ clock = Date.now, maxTrackedIps = MAX_TRACKED_IPS } = {}) {
  let current = null; // { hash: Buffer, expiresAt }
  const ipFails = new Map(); // ip -> { times: number[], lockedUntil }
  let globalFails = [];
  let globalLockedUntil = 0;

  const recent = (times, now) => times.filter((t) => now - t < WINDOW_MS);

  function lockedFor(ip, now) {
    const until = Math.max(globalLockedUntil, (ipFails.get(ip) || {}).lockedUntil || 0);
    return until > now ? until - now : 0;
  }

  function recordFail(ip, now) {
    const e = ipFails.get(ip) || { times: [], lockedUntil: 0 };
    e.times = recent(e.times, now).concat(now);
    if (e.times.length >= PER_IP_FAILS) e.lockedUntil = now + LOCK_MS;
    ipFails.delete(ip); // re-insert: the newest offender is the last one pruned
    ipFails.set(ip, e);
    pruneMap(ipFails, (v) => v.lockedUntil > now || v.times.some((t) => now - t < WINDOW_MS), maxTrackedIps);
    globalFails = recent(globalFails, now).concat(now);
    if (globalFails.length >= GLOBAL_FAILS) {
      globalLockedUntil = now + LOCK_MS;
      current = null;
    }
  }

  return {
    createCode() {
      const code = randomCode();
      const expiresAt = clock() + PAIRING_TTL_MS;
      current = { hash: sha256(code), expiresAt };
      return { code, expiresAt };
    },
    active() {
      return current !== null && current.expiresAt > clock();
    },
    /** `{ ok: true }`, or `{ ok: false, code: 'pairing_failed' | 'locked_out', retryAfterS? }`. */
    consume(input, ip) {
      const now = clock();
      const wait = lockedFor(ip, now);
      if (wait > 0) return { ok: false, code: 'locked_out', retryAfterS: Math.ceil(wait / 1000) };
      const given = sha256(normalizeCode(input));
      const valid = current !== null && current.expiresAt > now && crypto.timingSafeEqual(given, current.hash);
      if (!valid) {
        recordFail(ip, now);
        return { ok: false, code: 'pairing_failed' };
      }
      current = null; // single use
      return { ok: true };
    },
    /** A malformed pair request counts as a wrong code: `{ ok: false, code: 'invalid_request' | 'locked_out', retryAfterS? }`. */
    refuse(ip) {
      const now = clock();
      const wait = lockedFor(ip, now);
      if (wait > 0) return { ok: false, code: 'locked_out', retryAfterS: Math.ceil(wait / 1000) };
      recordFail(ip, now);
      return { ok: false, code: 'invalid_request' };
    },
    _stateForTests() {
      return { current: current && { hash: current.hash.toString('hex'), expiresAt: current.expiresAt }, globalLockedUntil, trackedIps: ipFails.size };
    },
  };
}
