#!/usr/bin/env node
'use strict';
/**
 * forge-tool-failure.cjs — `PostToolUseFailure` hook (modernization plan item 1.6).
 *
 * WHY: `PostToolUse` (forge-toolhook.cjs) only fires when a tool call SUCCEEDS, so the tool ledger in
 * `.claude/forge-runs/_toollog/<session>.jsonl` never saw a failed call. forge-loophealth.cjs already counts
 * `ok:false` attempts ("EVERY attempt counts, including a failed one") but had nothing to count. This hook
 * writes one line per FAILED tool call into the SAME per-session file, in the SAME line shape, with `ok:false`.
 *
 * REUSE, NOT A COPY: the line is built by forge-toolhook.cjs's own buildLine() (target summary rules, session
 * bucket, routing labels) and written through its own serialize() gate, so every string in the record is
 * scrubbed by forge-store.cjs's SECRET_PATTERNS before it reaches disk — the same single scrub source of truth.
 * Extra fields on a failure line: `failure:true`, `hook:'PostToolUseFailure'`, `error_class` (a constant from
 * ERROR_CLASSES, never input bytes), `error` (the harness's error text: control characters flattened, redacted
 * on the full string FIRST, then capped by serialize's 200-character field cap) and `interrupt` when the payload
 * says the call was interrupted. `ok_basis` is the existing `'is_error'` value (no new vocabulary for readers).
 *
 * LIVE-SESSION CONTRACT (same as forge-toolhook.cjs): never throws, never blocks, always exit 0, NEVER writes
 * stdout, own failsafe timer (FAILSAFE_MS) well under the 5 s settings timeout. Respects the owner setting
 * `tool-log` (off -> nothing written), the forge-sync maintenance lock, and env FORGE_TOOL_FAILURE_HOOK=off.
 *
 * Payload fields read (others ignored): session_id, agent_id, agent_type, tool_name, tool_input, tool_use_id,
 * error, is_interrupt, permission_mode, effort, model, duration_ms. Every one is optional except tool_name.
 *
 * MODEL: classifyError(text, isInterrupt) -> constant · flattenError(v) -> string|null ·
 *        buildFailureLine(payload, opts) -> record · run(raw, opts) -> {ok, wrote, path, reason, line?}
 * CLI: reads stdin, calls run(), ALWAYS exits 0, ALWAYS silent.
 */
const fs = require('fs');
const path = require('path');
const toolhook = require('./forge-toolhook.cjs');

const FAILSAFE_MS = 2500;
const HEAD_BYTES = 262144;         // same head as forge-toolhook; a longer payload is salvaged, never parsed whole
const ERROR_SCAN_CHARS = 4000;     // redaction runs on this much of the error text, before the 200-char cap
const ERROR_CLASSES = ['interrupted', 'timeout', 'permission', 'not-found', 'exit-code', 'validation', 'network', 'other', 'none', 'unknown'];

/** classifyError — a constant label for the failure kind. The label is never derived from input bytes. */
function classifyError(text, isInterrupt) {
  if (isInterrupt === true) return 'interrupted';
  if (typeof text !== 'string' || !text.trim().length) return 'none';
  const s = text.slice(0, ERROR_SCAN_CHARS);
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(s)) return 'timeout';
  if (/permission|denied|not allowed|EACCES|EPERM|blocked by/i.test(s)) return 'permission';
  if (/ENOENT|not found|no such file|does not exist/i.test(s)) return 'not-found';
  if (/exit(?:ed)?\s*(?:with\s*)?(?:code|status)\s*-?\d+/i.test(s)) return 'exit-code';
  if (/invalid|validation|schema|must be|required parameter|InputValidationError/i.test(s)) return 'validation';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up/i.test(s)) return 'network';
  return 'other';
}

/** flattenError — the error as ONE line of at most ERROR_SCAN_CHARS characters (redaction happens later, on this
 *  whole string, inside serialize()). Accepts a string or an object carrying message/error. */
function flattenError(v) {
  let s = null;
  if (typeof v === 'string') s = v;
  else if (v && typeof v === 'object') {
    if (typeof v.message === 'string') s = v.message;
    else if (typeof v.error === 'string') s = v.error;
  }
  if (s === null) return null;
  s = s.slice(0, ERROR_SCAN_CHARS).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length ? s : null;
}

function buildFailureLine(payload, opts) {
  opts = opts || {};
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  // tool_response is deliberately NOT passed: buildLine would derive ok from it; a failure is ok:false by event.
  const base = toolhook.buildLine(Object.assign({}, p, { tool_response: undefined }), { root: opts.root, runId: opts.runId, now: opts.now });
  const errText = flattenError(p.error);
  const line = Object.assign(base, { ok: false, ok_basis: 'is_error', failure: true, hook: 'PostToolUseFailure', error_class: classifyError(errText, p.is_interrupt) });
  if (errText) line.error = errText;
  if (p.is_interrupt === true) line.interrupt = true;
  return line;
}

function hookOff(env) { return /^(off|0|false|no)$/i.test(String((env || process.env).FORGE_TOOL_FAILURE_HOOK || '')); }
// WP 2.1: the ACTIVE runs folder and "is this a Forge project" come from forge-toolhook.cjs (forge-paths inside it);
// an older forge-toolhook.cjs without them keeps the legacy .claude/forge-runs and the plain .claude/ check.
function runsDirOf(root) { return typeof toolhook.runsDir === 'function' ? toolhook.runsDir(root) : path.join(root, '.claude', 'forge-runs'); }
function forgeProject(root) { return typeof toolhook.isForgeProject === 'function' ? toolhook.isForgeProject(root) : fs.existsSync(path.join(root, '.claude')); }

/** run — NEVER throws. Writes one line to <root>/.claude/forge-runs/_toollog/<session>.jsonl. */
function run(raw, opts) {
  opts = opts || {};
  try {
    if (hookOff(opts.env)) return { ok: true, wrote: false, skipped: true, reason: 'FORGE_TOOL_FAILURE_HOOK=off', path: null };
    const root = toolhook.resolveProjectRoot(opts);
    if (!forgeProject(root)) return { ok: true, wrote: false, reason: 'no-forge-project', path: null };
    if (toolhook.syncMaintenance(root)) return { ok: true, wrote: false, skipped: true, reason: 'maintenance mode', path: null };
    if (toolhook.configRead('tool-log', true, { projectRoot: root, configModule: opts.configModule }).value === false) {
      return { ok: true, wrote: false, skipped: true, reason: 'owner config tool-log=off', path: null };
    }
    const text0 = typeof raw === 'string' ? raw : '';
    let payload = null;
    let truncated = !!opts.truncated;
    if (!truncated) { try { payload = JSON.parse(text0); } catch { payload = null; } }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      // Oversized/cut payload: forge-toolhook's bounded salvage still proves the failure happened. The error text
      // itself is NOT salvaged (it may be cut mid-secret), so error_class is 'unknown' and no error is stored.
      payload = toolhook.salvage(text0.slice(0, HEAD_BYTES));
      if (!payload) return { ok: true, wrote: false, reason: 'unparseable', path: null };
      truncated = true;
    }
    if (typeof payload.tool_name !== 'string' || !payload.tool_name.length) return { ok: true, wrote: false, reason: 'no-tool_name', path: null };

    const dir = path.join(runsDirOf(root), toolhook.LOG_DIRNAME);
    const bucket = toolhook.sessionBucket(payload.session_id);
    const file = path.join(dir, bucket + '.jsonl');
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return { ok: false, wrote: false, reason: 'containment-refused', path: null };

    const built = buildFailureLine(payload, { root, runId: opts.runId, now: opts.now });
    if (truncated) { built.truncated = true; built.error_class = 'unknown'; delete built.error; }
    const line = toolhook.scrubRecord(built);
    const text = toolhook.serialize(line) + '\n';
    fs.mkdirSync(dir, { recursive: true });
    const maxLog = Number.isFinite(opts.maxLogBytes) ? opts.maxLogBytes : toolhook.MAX_LOG_BYTES;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + Buffer.byteLength(text, 'utf8') > maxLog) {
      const prev = path.join(dir, bucket + '.1.jsonl');
      try { fs.rmSync(prev, { force: true }); } catch { /* best effort, same rotation as forge-toolhook */ }
      try { fs.renameSync(file, prev); } catch { /* keep appending rather than lose the line */ }
    }
    fs.appendFileSync(file, text, 'utf8');
    return { ok: true, wrote: true, reason: null, path: file, line };
  } catch (e) {
    return { ok: false, wrote: false, reason: 'error: ' + ((e && e.code) || 'unknown'), path: null };
  }
}

module.exports = { run, classifyError, flattenError, buildFailureLine, ERROR_CLASSES, FAILSAFE_MS, HEAD_BYTES };

if (require.main === module) {
  let finished = false;
  const finish = () => { if (finished) return; finished = true; process.exit(0); };
  const failsafe = setTimeout(finish, FAILSAFE_MS);
  if (failsafe.unref) failsafe.unref();
  const chunks = [];
  let stored = 0;
  try {
    let dropped = false;
    process.stdin.on('data', (c) => { if (stored < HEAD_BYTES) { chunks.push(c); stored += c.length; } else dropped = true; });
    process.stdin.on('error', finish);
    process.stdin.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        run(buf.subarray(0, HEAD_BYTES).toString('utf8'), { truncated: dropped || buf.length > HEAD_BYTES });
      } catch { /* never fail the turn */ }
      clearTimeout(failsafe);
      finish();
    });
    process.stdin.resume();
  } catch { finish(); }
}
