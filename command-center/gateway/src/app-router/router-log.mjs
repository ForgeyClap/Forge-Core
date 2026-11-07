// App router — the router folder and its audit/switch log (design sections 2.1 and 4.7).
// <data dir>/app-router/router-events.jsonl: token-free by construction. Only the listed keys per
// event kind are written (ids, labels' ids, reasons, times), every string is redacted and capped,
// and message text never reaches it. Capped at 2 MB with one .1 rotation. Best-effort: logging
// never throws and never changes a routing answer.
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_CENTER_DATA_DIR } from '../paths.mjs';
import { redact } from '../redact.mjs';
import { LIMITS } from './contract.mjs';

let dirOverride = null;
let capOverride = null;

/** The router's own folder: <COMMAND_CENTER_DATA_DIR>/app-router (follows FORGE_DATA_DIR). */
export function routerDataDir() {
  return dirOverride || path.join(COMMAND_CENTER_DATA_DIR, 'app-router');
}
export function _setRouterDataDirForTests(dir) { dirOverride = dir || null; }
export function _setRouterLogCapForTests(bytes) { capOverride = Number.isInteger(bytes) && bytes > 0 ? bytes : null; }

const LOG_NAME = 'router-events.jsonl';
const MAX_STRING = 64;
const EVENT_KEYS = Object.freeze({
  router_config_changed: ['revision', 'mode', 'entries'],
  router_switch: ['conv_id', 'turn_id', 'from', 'to', 'reason'],
  router_limit_hit: ['target_id', 'window', 'resume_at'],
  router_test: ['target_id', 'outcome'],
  router_exhausted: ['conv_id', 'resume_at'],
  // Q5-EIGEN-API: a chain entry walked past during a turn (reason 'provider_unavailable': its Eigen API is gone;
  // 'paid_ack_required': it now needs a key and the entry never confirmed the cost).
  router_entry_skipped: ['conv_id', 'turn_id', 'target_id', 'provider', 'reason'],
});
export const ROUTER_EVENT_KINDS = Object.freeze(Object.keys(EVENT_KEYS));

function cleanScalar(v) {
  if (typeof v === 'string') return redact(v).slice(0, MAX_STRING);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  return null;
}

function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, LIMITS.MAX_ENTRIES).map((e) => ({
    id: cleanScalar(e && e.id),
    kind: cleanScalar(e && e.kind),
    enabled: e && e.enabled === true,
  }));
}

function logFile() { return path.join(routerDataDir(), LOG_NAME); }

/**
 * Appends one router event. Unknown kinds are refused (false). Never throws.
 * @param {'router_config_changed'|'router_switch'|'router_limit_hit'|'router_test'|'router_exhausted'|'router_entry_skipped'} kind
 * @param {object} data   only the kind's listed keys are kept
 * @param {{now?: number}} [opts]
 * @returns {boolean} true when the line was written
 */
export function appendRouterEvent(kind, data, { now = Date.now() } = {}) {
  const keys = EVENT_KEYS[kind];
  if (!keys) return false;
  const src = data && typeof data === 'object' ? data : {};
  const record = { at: new Date(now).toISOString(), kind };
  for (const k of keys) record[k] = k === 'entries' ? cleanEntries(src.entries) : cleanScalar(src[k]);
  const line = JSON.stringify(record) + '\n';
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cap = capOverride || LIMITS.LOG_MAX_BYTES;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + Buffer.byteLength(line) > cap) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The most recent router events (live file only, at most the last 256 KB read), oldest first.
 * @param {{limit?: number}} [opts]
 * @returns {object[]}
 */
export function readRouterEvents({ limit = 200 } = {}) {
  const max = 256 * 1024;
  let text;
  try {
    const fd = fs.openSync(logFile(), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - max);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn line is skipped */ }
  }
  return out.slice(-Math.max(1, limit));
}
