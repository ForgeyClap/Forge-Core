// Remote Bridge audit log: append-only JSON lines. Callers never pass tokens, codes or prompt text;
// every entry also goes through the gateway's secret redactor plus a scrub of bridge token shapes.
// Flood guard: refused requests (origin_refused, locked_out, auth_failed, rate_limited, pair_failed,
// pair_invalid, and every other 4xx line without an authenticated device) write at most
// `refusedPerWindow` lines per client IP per window; the rest are counted and written as ONE
// `audit_suppressed` line once the window is over (or on flush()). IPs past `maxTrackedIps` share
// the bucket '*'. The file rotates by size: audit.jsonl -> .1 -> .2 (three files at most).
import fs from 'node:fs';
import path from 'node:path';
import { redactDeep } from '../redact.mjs';
import { MAX_TRACKED_IPS } from './bounded-map.mjs';

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const REFUSED_ACTIONS = new Set(['origin_refused', 'locked_out', 'auth_failed', 'rate_limited', 'pair_failed', 'pair_invalid']);
const KEEP_OLD_FILES = 2; // audit.jsonl.1 and audit.jsonl.2

/** A refused request: a known refusal action, or any 4xx answered to a caller without a device. */
function isRefused(entry) {
  if (REFUSED_ACTIONS.has(entry.action)) return true;
  return entry.device_id == null && Number.isInteger(entry.status) && entry.status >= 400 && entry.status < 500;
}

function rotate(file) {
  for (let i = KEEP_OLD_FILES; i >= 1; i--) {
    const from = i === 1 ? file : file + '.' + (i - 1);
    try { fs.renameSync(from, file + '.' + i); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
const BRIDGE_TOKEN_RE = /frb_[A-Za-z0-9_-]{20,}/g;

function scrub(value) {
  if (typeof value === 'string') return value.replace(BRIDGE_TOKEN_RE, '[REDACTED:BRIDGE_TOKEN]');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

export function createAuditLog(file, {
  maxBytes = AUDIT_MAX_BYTES, refusedPerWindow = 20, windowMs = 60_000, maxTrackedIps = MAX_TRACKED_IPS, clock = Date.now,
} = {}) {
  const refused = new Map(); // ip -> { start, count, suppressed, byAction }

  function append(entry, now) {
    const line = JSON.stringify(scrub(redactDeep({
      ts: new Date(now).toISOString(),
      action: entry.action,
      status: entry.status ?? null,
      ip: entry.ip ?? null,
      device_id: entry.device_id ?? null,
      device_name: entry.device_name ?? null,
      detail: entry.detail ?? null,
    }))) + '\n';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* no file yet */ }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate(file);
      fs.appendFileSync(file, line, 'utf8');
    } catch (err) {
      console.error('remote bridge: audit log write failed: ' + (err && err.message ? err.message : err));
    }
  }

  function summarize(ip, e, now) {
    if (e.suppressed > 0) {
      append({ action: 'audit_suppressed', ip, detail: { suppressed: e.suppressed, by_action: e.byAction, window_started: new Date(e.start).toISOString(), window_s: Math.round(windowMs / 1000) } }, now);
    }
  }

  function flushExpired(now, all) {
    for (const [ip, e] of refused) {
      if (!all && now - e.start < windowMs) continue;
      summarize(ip, e, now);
      refused.delete(ip);
    }
  }

  /** False when this refused-request line is over its IP's budget (then it is only counted). */
  function underBudget(entry, now) {
    const ip = String(entry.ip ?? '');
    const key = refused.has(ip) || refused.size < maxTrackedIps ? ip : '*';
    let e = refused.get(key);
    if (!e) { e = { start: now, count: 0, suppressed: 0, byAction: {} }; refused.set(key, e); }
    e.count++;
    if (e.count <= refusedPerWindow) return true;
    e.suppressed++;
    e.byAction[entry.action] = (e.byAction[entry.action] || 0) + 1;
    return false;
  }

  return {
    write(entry) {
      const now = clock();
      flushExpired(now, false);
      if (isRefused(entry) && !underBudget(entry, now)) return;
      append(entry, now);
    },
    /** Writes every pending summary line now (the bridge calls this when it stops). */
    flush() { flushExpired(clock(), true); },
  };
}
