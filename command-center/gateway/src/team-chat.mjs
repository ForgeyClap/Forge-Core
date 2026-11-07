// WP B4: GET /api/runs/:id/team-chat — the run's team channel.
//
// Reads `<project>/.claude/forge-runs/<run_id>/team-chat.jsonl`, the append-only channel that
// `.claude/forge-bin/forge-say.cjs` writes (contract: docs/forge-systeem/TEAM-CHAT.md). Read-only,
// no exec token (a GET, same as /api/events).
//
// Honesty and safety rules, mirrored from events.mjs (the other per-run reader):
//   - the run id must pass safeIdOk() (no '.', '/', '\\'), and the resolved file must sit inside the
//     project's own forge-runs/ directory (containmentOk) — a traversal can never reach another file;
//   - every returned record is passed through redactDeep(), so a credential that slipped past the
//     writer's own secret gate never reaches the dashboard;
//   - a missing file is the honest empty state (`lines: []`, `exists: false`), never an error and
//     never fabricated activity; malformed lines are counted, not guessed at;
//   - the read is bounded: at most MAX_READ_BYTES from the END of the file (the newest lines), and at
//     most `limit` lines (default DEFAULT_LIMIT, capped at MAX_LIMIT) are returned, oldest first.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, safeIdOk } from './security.mjs';
import { redactDeep } from './redact.mjs';

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
// 2 MB covers well over a thousand maximum-length (2000 char) lines.
export const MAX_READ_BYTES = 2 * 1024 * 1024;

const WP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KINDS = new Set(['message', 'handoff', 'blocker', 'question', 'decision']);

export function safeWpIdOk(wp) {
  return typeof wp === 'string' && WP_ID_RE.test(wp);
}

/** Clamps a raw `?limit=` value; anything unusable falls back to the default. */
export function parseLimit(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function str(value) {
  return typeof value === 'string' ? value : null;
}

// Keeps only the contract fields, typed. Unknown kinds stay visible as 'message' with the raw kind
// kept in `kind_raw`, so a newer writer never makes a line disappear.
function normalize(record) {
  const kindRaw = str(record.kind);
  const kind = kindRaw && KINDS.has(kindRaw) ? kindRaw : 'message';
  return {
    ts: str(record.ts),
    run_id: str(record.run_id),
    from: str(record.from),
    to: str(record.to),
    wp_id: str(record.wp_id),
    kind,
    kind_raw: kindRaw && kindRaw !== kind ? kindRaw : null,
    text: str(record.text) ?? '',
    via: record.via === 'lead' ? 'lead' : 'direct',
  };
}

function readTail(filePath) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const length = stat.size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  // A cut in the middle of the file starts mid-line: drop that partial first line.
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return { text, truncated: start > 0 };
}

/**
 * @param {string} projectPath absolute project root (already resolved through the project registry)
 * @param {string} runId
 * @param {{ wp?: string|null, limit?: number }} [opts]
 */
export function readTeamChat(projectPath, runId, opts = {}) {
  if (!safeIdOk(runId) || runId.length > 128) return { ok: false, status: 400, error: 'invalid run id' };
  const wp = opts.wp == null || opts.wp === '' ? null : opts.wp;
  if (wp !== null && !safeWpIdOk(wp)) return { ok: false, status: 400, error: 'invalid ?wp=<id>' };
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MAX_LIMIT) : DEFAULT_LIMIT;

  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const filePath = path.join(runsDir, runId, 'team-chat.jsonl');
  if (!containmentOk(runsDir, filePath)) return { ok: false, status: 400, error: 'path containment violation' };

  const base = { ok: true, run_id: runId, wp, limit };
  if (!fs.existsSync(filePath)) {
    return { ...base, exists: false, lines: [], total: 0, malformed: 0, truncated: false };
  }

  let tail;
  try {
    tail = readTail(filePath);
  } catch (err) {
    return { ok: false, status: 500, error: 'team chat could not be read: ' + (err && err.code ? err.code : 'unknown error') };
  }

  const records = [];
  let malformed = 0;
  for (const raw of tail.text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }
    const rec = normalize(redactDeep(parsed));
    if (wp !== null && rec.wp_id !== wp) continue;
    records.push(rec);
  }

  // Ordered by ts (append order breaks ties and covers a missing ts), oldest first.
  const ordered = records
    .map((rec, index) => ({ rec, index }))
    .sort((a, b) => {
      const at = a.rec.ts ? Date.parse(a.rec.ts) : NaN;
      const bt = b.rec.ts ? Date.parse(b.rec.ts) : NaN;
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return a.index - b.index;
    })
    .map((entry) => entry.rec);

  const lines = ordered.slice(-limit);
  return {
    ...base,
    exists: true,
    lines,
    total: ordered.length,
    malformed,
    truncated: tail.truncated || ordered.length > lines.length,
  };
}

export const TEAM_CHAT_ROUTE_RE = /^\/api\/runs\/([^/]+)\/team-chat$/;
