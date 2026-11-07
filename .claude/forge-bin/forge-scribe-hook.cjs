#!/usr/bin/env node
'use strict';
/**
 * forge-scribe-hook.cjs — the project UserPromptSubmit hook that feeds Forge Scribe (part ii of run
 * 2026-10-10; design: audit SCRIBE-F1/F5/F10 in
 * .claude/forge-research/overhaul-2026-10-09/audit-scribe.txt; Codex R3 SC-06/SC-11/SC-12 fixes the same day). Owner:
 * "later komt de AI erachter dat ik nog iets wilde" must stop — every owner prompt is captured word for word (secrets
 * scrubbed) the moment it is typed, by a hook the model cannot forget to run.
 *
 * PER PROMPT (stdin = the hook JSON: prompt, session_id, transcript_path, prompt_id, cwd):
 *   0..8: closed LEADING harness blocks (<browser_instruction>, <ide_opened_file>, <ide_selection>, <system-reminder>; forge-scribe-classify stripLeadingHarness) are removed first, so only the owner's words are recorded and classified; nothing left -> skip 'harness-only' (counter only, no text); unclosed tag or any error -> the old behaviour.
 *   1. skip ONLY machine text (forge-scribe-classify.cjs machineSkip): a background agent's <task-notification> turn,
 *      tool-result / local-command echoes, the body of a slash command or skill, a slash-command expansion without
 *      arguments or for a Forge tool subcommand, a bare slash command, /forge status|runs|dashboard|config|... Each skip
 *      adds one counter line to .claude/forge-scribe/skipped.jsonl (no text) where the scribe is in use, so a wrongly
 *      skipped prompt is at least countable. A question or an ack IS the owner talking and is captured (SC-11);
 *   1b. ORIGIN FILTER (WP 3.8, forge-scribe.cjs originOf): text whose START (or a dominant wrapper) is a subagent
 *      hand-back (<agent-message ...>, "[Subagent hand-back]"), a cross-session / teammate message, a system notification
 *      or another harness envelope is skipped the same way with reason 'system-origin': no inbox record, no ledger item,
 *      no digest line and no REPEAT or split instruction. Owner prose that merely QUOTES such a tag is captured; when the
 *      origin is unsure it is captured and marked origin_uncertain (the receipt says so);
 *   2. call forge-scribe.cjs capture() IN-PROCESS (no second node) with source 'hook' — the provenance the owner check
 *      requires — passing the active run (forge-stop-obligations.cjs findActiveRun) so a mid-run item is marked
 *      impact:pending. capture() itself first re-folds any inbox prompt a crash left without an item (SC-07);
 *   3. while a run is active, append one `scribe_head` event to that run through the project's own event writer: the
 *      writer stamps the scribe ledger/inbox head and line count itself (an anchor outside the scribe store, SC-06);
 *   4. print at most three lines as additionalContext: the receipt naming the R-id it created; when the prompt REPEATS
 *      an earlier owner ask (forge-scribe.cjs OWNER REPEATS v2, WP 3.8 — owner words only, token sets, no extra I/O) one
 *      'REPEAT x<n> of R-.. — why: R-.. 75% (shared words) — the owner had to ask again: create/refresh the HARD RULE
 *      now ...' line naming at most the 3 most similar earlier owner asks; and, only when the digest differs from what
 *      this session last saw, the compact DIGEST on one line (<= 1200 chars; built from forge-scribe.cjs ownerView, so a
 *      stored repeat link shows only while v2 confirms it). WP I.8c: when the owner's own words are a "turn it on / you
 *      forgot" correction, capture tags the record 'toggle-correction' and the receipt ends with "[tc] toggle-correction
 *      (make it a default/rule/check)"; tagged items show "[tc]" in the digest line. A hand-back is never recorded (1b).
 *
 * DEADLINE (SC-12; Codex R5 SV-09): the work is synchronous, and the NODE LIMIT is that a timer cannot interrupt it — a
 * timer callback (including the CLI's failsafe below) only runs after the current synchronous task returns, so it can
 * never cut a long replay short. (A worker thread could be terminated, but killing it mid-append can tear a hash-chained
 * line; a late hook is the lesser harm.) The hook therefore bounds every step UP FRONT: the classifier only ever sees the
 * capped prompt, the store lock is waited for at most LOCK_WAIT_MS, the crash-recovery replay that capture runs first is
 * a BATCH of at most RECOVER_BATCH orphans with a deadline of RECOVER_BUDGET_MS checked before each one (the rest stay
 * ORPHANS: the gate counts them as open and the Stop hook reports them, until a later prompt or any CLI command folds
 * them), appendChained reads only the file's tail, and every step after the capture (the run anchor, the digest) runs
 * only while BUDGET_MS is left — otherwise it is skipped with a one-line notice ("captured; ... skipped: time budget").
 * The capture of the prompt itself is never skipped for time.
 *
 * GUARANTEES: fail-open (any error -> exit 0 and no output); never blocks a prompt (no exit 2, no decision); no LLM
 * call, no network. Writes only inside the scribe store folder — <root>/.claude/forge-scribe/, or <root>/.forge/scribe/
 * in a project that opted into the .forge layout (WP 2.1) — (and the one scribe_head line in the active run's event log)
 * and never creates the scribe folder for a skipped prompt. Uses ONLY the project's own forge-scribe copy (a plugin copy
 * never falls back to its own sibling modules and never writes beside its script).
 *
 * PROBE (Claude Code 2.1.291): UserPromptSubmit fires in `claude -p` mode, does NOT fire for an Agent-tool
 * subagent's own prompt, and DOES fire again for the <task-notification> turn when a background agent finishes. The
 * payload carries session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name and prompt; the
 * transcript entry of the same prompt carries promptId == prompt_id.
 *
 * OPT-OUT: env FORGE_SCRIBE_HOOK=off, or remove the UserPromptSubmit entry from .claude/settings.json.
 * MODEL: runPrompt(payload, opts) -> {print, text, captured, skipped, digest, head, reason, notice, ms}. Seams (tests):
 * opts.projectRoot, opts.env, opts.now (Date factory), opts.config, opts.scribe (module set or null), opts.activeRun
 * (null|{run_id}), opts.budgetMs, opts.claudeProjectsRoot.
 * Shared with forge-scribe-stop.cjs: loadScribe, activeRunOf, sessionKey, sessionRecord, updateSession, resolveRoot,
 * encodeRids, decodeRids.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// WP 2.1: the fallback root comes from forge-paths.cjs scriptRootInfo (guarded: an older or missing copy keeps the
// legacy literal). An installed copy (<project>/.claude/forge-bin) answers its own project exactly as before; a plugin
// copy outside any project answers null and the hook then does nothing (it never writes beside its own script).
const SCRIPT_ROOT = (() => {
  try {
    const P = require('./forge-paths.cjs');
    if (P && typeof P.scriptRootInfo === 'function') return P.scriptRootInfo(__dirname);
  } catch { /* older or missing forge-paths.cjs: the legacy literal below */ }
  return { root: path.resolve(__dirname, '..', '..'), source: 'script' };
})();
const DEFAULT_ROOT = SCRIPT_ROOT.root;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;  // a pasted log is still an owner prompt; the scribe itself caps the text
const DEADLINE_MS = 4000;                 // the settings.json timeout is 5 s; the CLI gives up silently before that
const BUDGET_MS = 2500;                   // optional steps after the capture run only while this is left
const LOCK_WAIT_MS = 1500;                // the longest the hook waits for the scribe store lock
const RECOVER_BATCH = 16;                 // R5 SV-09: at most this many crash orphans folded per prompt
const RECOVER_BUDGET_MS = 600;            // ... and none started after this much time since the hook began
const HEAD_LOCK_MS = 800;                 // the longest it waits for the run's events lock
const RECEIPT_MAX_CHARS = 320;
const DIGEST_MAX_CHARS = 1200;
const DIGEST_SEPARATOR_RESERVE = 90;      // room for the line prefix and the " | " joins of a one-line digest
const HOOK_STATE_FILE = 'hook-state.json';
const HOOK_STATE_MAX_SESSIONS = 50;
const CLASS_LIST = 'new|change|cancel|preference|question|ack';
const CLI = 'node .claude/forge-bin/forge-scribe.cjs';

function short(e) { return String((e && (e.message || e.code)) || e || 'unknown error').split('\n')[0].slice(0, 200); }
function isOff(v) { return /^(off|0|false|no)$/i.test(String(v == null ? '' : v).trim()); }
function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
function str(v, max) { return typeof v === 'string' && v.trim() ? v.slice(0, max) : null; }
function nowOf(opts) { return opts && typeof opts.now === 'function' ? opts.now() : new Date(); }

/** resolveRoot(opts) — opts.projectRoot, else CLAUDE_PROJECT_DIR (Claude Code sets it for hooks), else this file's
 *  project; null when a plugin copy is not inside any project (WP 2.1). */
function resolveRoot(opts) {
  if (opts && opts.projectRoot) return path.resolve(opts.projectRoot);
  const env = (opts && opts.env) || process.env;
  if (env.CLAUDE_PROJECT_DIR) return path.resolve(env.CLAUDE_PROJECT_DIR);
  return DEFAULT_ROOT;
}

/** loadScribe(root, opts) -> {SC, S, C} from the project's OWN forge-bin, or null (no scribe, or it does not load,
 *  or no root). WP 2.1 deliberately adds NO fallback to a plugin copy's sibling modules: that would start capturing
 *  verbatim owner prompts in every folder the plugin hook fires in — an owner decision, not a path migration. */
function loadScribe(root, opts) {
  if (opts && opts.scribe !== undefined) return opts.scribe;
  if (!root) return null;
  const dir = path.join(root, '.claude', 'forge-bin');
  const files = ['forge-scribe.cjs', 'forge-scribe-store.cjs', 'forge-scribe-classify.cjs'].map((f) => path.join(dir, f));
  if (!files.every((f) => fs.existsSync(f))) return null;
  try { return { SC: require(files[0]), S: require(files[1]), C: require(files[2]) }; } catch { return null; }
}

/** activeRunOf(root, opts) -> {run_id} | null — forge-stop-obligations.cjs findActiveRun (the ONE definition). */
function activeRunOf(root, opts) {
  if (opts && opts.activeRun !== undefined) return opts.activeRun;
  for (const f of [path.join(root, '.claude', 'forge-bin', 'forge-stop-obligations.cjs'), path.join(__dirname, 'forge-stop-obligations.cjs')]) {
    if (!fs.existsSync(f)) continue;
    try {
      const r = require(f).findActiveRun(root, {});
      return r && r.run ? { run_id: r.run.run_id } : null;
    } catch { return null; }
  }
  return null;
}

/** machineSkip(text) — the classifier module's definition (compatibility export; null when it cannot be loaded). */
function machineSkip(text) {
  try { return require('./forge-scribe-classify.cjs').machineSkip(text); } catch { return null; }
}

// ---- compact R-id sets (SC-12: the Stop hook's per-session "reminded" memory has no item cap) ----------------------
/** encodeRids(iterable of 'R-n') -> "1-5,7,9-12" (sorted numeric ranges). */
function encodeRids(rids) {
  const ns = Array.from(new Set(Array.from(rids || []).map((r) => parseInt(String(r).replace(/^R-/i, ''), 10)).filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    parts.push(j > i ? ns[i] + '-' + ns[j] : String(ns[i]));
    i = j;
  }
  return parts.join(',');
}
/** decodeRids(str) -> Set of 'R-nnnn' ids (4-digit padded like the scribe's own ids, longer ids kept as they are). */
function decodeRids(s) {
  const out = new Set();
  const pad = (n) => 'R-' + String(n).padStart(4, '0');
  for (const part of String(s || '').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let n = a; n <= b && n - a < 1000000; n++) out.add(pad(n));
  }
  return out;
}

// ---- per-session cache (shared with forge-scribe-stop.cjs) -------------------------------------------------------
function hookStateFile(p) { return path.join(p.dir, HOOK_STATE_FILE); }
function sessionKey(sessionId) { return sha(String(sessionId || 'no-session')).slice(0, 16); }
function readHookState(p) {
  try {
    const j = JSON.parse(fs.readFileSync(hookStateFile(p), 'utf8'));
    if (j && typeof j === 'object' && j.sessions && typeof j.sessions === 'object' && !Array.isArray(j.sessions)) return j;
  } catch { /* missing or corrupt: a cache, start fresh */ }
  return { v: 1, sessions: {} };
}
function sessionRecord(p, key) {
  const s = readHookState(p).sessions[key];
  return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
}
/** updateSession(S, p, key, mutate, iso, lockOpts?) — read-modify-write of one session record under the scribe store
 *  lock, atomic rename, the newest HOOK_STATE_MAX_SESSIONS sessions kept. Throws on failure (callers decide). */
function updateSession(S, p, key, mutate, iso, lockOpts) {
  return S.withLock(p, () => {
    const st = readHookState(p);
    const cur = st.sessions[key] && typeof st.sessions[key] === 'object' ? Object.assign({}, st.sessions[key]) : {};
    const next = mutate(cur) || cur;
    next.at = iso;
    st.sessions[key] = next;
    const keys = Object.keys(st.sessions).sort((a, b) => String(st.sessions[b].at || '').localeCompare(String(st.sessions[a].at || '')));
    for (const k of keys.slice(HOOK_STATE_MAX_SESSIONS)) delete st.sessions[k];
    const f = hookStateFile(p);
    if (typeof S.writeFenced === 'function') S.writeFenced(f, JSON.stringify(st)); // R5 SV-08: a fenced protected write
    else { const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st), 'utf8'); fs.renameSync(tmp, f); }
    return next;
  }, lockOpts);
}

// ---- the run anchor (SC-06) ---------------------------------------------------------------------------------------
/** writeScribeHead(root, runId, rid, timeoutMs) — one scribe_head event in the run through the project's OWN event
 *  writer, which stamps the head itself. Never throws; returns {ok, reason?}. */
function writeScribeHead(root, runId, rid, timeoutMs) {
  try {
    const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
    if (!fs.existsSync(le)) return { ok: false, reason: 'no event writer in this project' };
    const LE = require(le);
    if (typeof LE.appendChainedLocked !== 'function' || typeof LE.validateForWrite !== 'function' || !LE.KNOWN_EVENT_TYPES || !LE.KNOWN_EVENT_TYPES.has('scribe_head')) {
      return { ok: false, reason: 'this event writer does not know scribe_head (older Forge)' };
    }
    const rd = LE.resolveRunDir(runId);
    if (!rd.ok) return { ok: false, reason: rd.message };
    const ev = { run_id: runId, event_type: 'scribe_head', agent: 'orchestrator', runtime: 'internal', status: 'internal', note: 'scribe head after capturing ' + rid };
    const v = LE.validateForWrite(ev);
    if (!v.ok) return { ok: false, reason: v.message };
    const w = LE.appendChainedLocked(rd.runDir, [ev], { timeoutMs: Math.max(50, timeoutMs) });
    return w.ok ? { ok: true } : { ok: false, reason: w.message };
  } catch (e) { return { ok: false, reason: short(e) }; }
}

// ---- output lines ------------------------------------------------------------------------------------------------
function receiptLine(r, act) {
  if (!r || !r.receipt) return null;
  let s = '[forge-scribe] ' + r.receipt;
  if (r.ledger_error) s += ' — ledger error, check: ' + CLI + ' verify-chain';
  else if (r.duplicate) s += ' (' + r.pid + ' kept as a duplicate of ' + r.duplicate_of + ')';
  else if (r.rid) {
    if (r.multi_ask) s += ' — ' + r.asks + ' asks in one prompt: split with ' + CLI + ' classify ' + r.rid + ' <class> --split "<exact quote>"';
    else if (r.class === 'unclassified') s += ' — classify: ' + CLI + ' classify ' + r.rid + ' <' + CLASS_LIST + '>';
    else if (r.class === 'preference') s += ' — preference: ' + CLI + ' route ' + r.rid;
    else if (r.class === 'question' || r.class === 'ack') s += ' — answer it (' + CLI + ' transition ' + r.rid + ' answer --reason "...") or apply it with --prompt ' + r.pid;
    else if (act && (r.class === 'new' || r.class === 'change' || r.class === 'cancel')) s += ' — run ' + act.run_id + ' is active: ' + CLI + ' impact ' + r.rid + ' --run ' + act.run_id;
    if (r.truncated) s += ' (prompt longer than the cap: kept up to the cap)';
    if (r.origin_uncertain) s += ' (origin uncertain: ' + oneLine(r.origin_reason || 'may be pasted system text', 70) + ' — check these are the owner\'s words)';
  }
  return oneLine(s, RECEIPT_MAX_CHARS);
}
const REPEAT_MAX_CHARS = 600;
/** repeatLine(captured) -> '[forge-scribe] R-n REPEAT x<n> of R-.. — the owner had to ask again: ...' + how to link it. */
function repeatLine(r) {
  return oneLine('[forge-scribe] ' + r.rid + ' ' + r.repeat_note + ' — then: ' + CLI + ' transition ' + r.rid + ' repeat-rule --ref standing_rule:<id>|decision_logged:<event_id>', REPEAT_MAX_CHARS);
}
function digestLine(digest) {
  return oneLine('[forge-scribe digest] ' + String(digest).split('\n').map((l) => l.trim()).filter(Boolean).join(' | '), DIGEST_MAX_CHARS);
}

/** runPrompt(payload, opts) -> see the file header MODEL. Never throws. */
function runPrompt(payload, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const budget = Number.isFinite(opts.budgetMs) ? opts.budgetMs : BUDGET_MS;
  const left = () => budget - (Date.now() - t0);
  const out = (o) => Object.assign({ print: false, text: null, captured: null, skipped: null, digest: false, head: null, reason: null, notice: null }, o, { ms: Date.now() - t0 });
  try {
    const env = opts.env || process.env;
    if (isOff(env.FORGE_SCRIBE_HOOK)) return out({ reason: 'disabled (FORGE_SCRIBE_HOOK=off)' });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out({ reason: 'no hook payload' });
    const rawPrompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (!rawPrompt.trim()) return out({ reason: 'empty prompt' });
    const root = resolveRoot(opts);
    if (!root) return out({ reason: 'no project root found (a copy outside any project); nothing captured' });
    const mod = loadScribe(root, opts);
    if (!mod) return out({ reason: 'forge-scribe is not installed in this project' });
    const { SC, S, C } = mod;
    //.8: leading harness blocks (<browser_instruction>, <ide_opened_file>, ...) are not owner words (header, 0)
    let prompt = rawPrompt;
    try {
      const lead = typeof C.stripLeadingHarness === 'function' ? C.stripLeadingHarness(rawPrompt) : null;
      if (lead && lead.stripped > 0 && typeof lead.text === 'string') {
        if (!lead.text.trim()) {
          if (typeof SC.recordSkip === 'function') SC.recordSkip('harness-only', { root, config: opts.config, now: opts.now, session_id: str(payload.session_id, 200), chars: rawPrompt.length, lockWaitMs: LOCK_WAIT_MS });
          return out({ skipped: 'harness-only', reason: 'not an owner instruction (harness-only: ' + lead.stripped + ' leading block(s))' });
        }
        prompt = lead.text;
      }
    } catch { prompt = rawPrompt; } // fail-open: the old behaviour
    const machine = typeof C.machineSkip === 'function' ? C.machineSkip(prompt) : null;
    // WP 3.8 origin filter: a subagent hand-back / harness envelope is not the owner talking (see the header, 1b)
    const origin = !machine && typeof SC.originOf === 'function' ? SC.originOf(prompt) : null;
    const skipWhy = machine || (origin && origin.origin === 'system' ? 'system-origin' : null);
    if (skipWhy) {
      if (typeof SC.recordSkip === 'function') SC.recordSkip(skipWhy, { root, config: opts.config, now: opts.now, session_id: str(payload.session_id, 200), chars: prompt.length, lockWaitMs: LOCK_WAIT_MS });
      return out({ skipped: skipWhy, reason: 'not an owner instruction (' + skipWhy + (machine ? '' : ': ' + origin.kind) + ')' });
    }
    const cfg = opts.config || C.loadConfig();
    const cap = Math.max(200, (Number(cfg.caps && cfg.caps.digest_max_chars) || DIGEST_MAX_CHARS) - DIGEST_SEPARATOR_RESERVE);
    const p = S.paths(root);
    // WP 3.8: the digest comes from the owner view (only confirmed repeat links) when this project's scribe has it;
    // WP I.8c: with the toggle-correction index, a tagged owner item shows its '[tc]' mark (an older scribe: no index)
    const tagsOf = () => { try { return typeof SC.toggleTagIndex === 'function' ? SC.toggleTagIndex(p) : undefined; } catch { return undefined; } };
    const digestOf = (st) => (typeof SC.digestOfState === 'function' ? SC.digestOfState(st, cap, cfg, tagsOf()) : S.buildDigest(st, cap));
    let pre = null;
    if (fs.existsSync(p.ledger)) { try { pre = digestOf(S.loadState(p)); } catch { pre = null; } }
    const act = activeRunOf(root, opts);
    const captured = SC.capture(prompt, {
      root, config: cfg, source: 'hook', by: 'hook', now: opts.now, lockWaitMs: LOCK_WAIT_MS,
      session_id: str(payload.session_id, 200), transcript_path: str(payload.transcript_path, 1024), prompt_id: str(payload.prompt_id, 80),
      run_id: act ? act.run_id : undefined, run_active: !!act,
      // R5 SV-09: a bounded crash-recovery batch with a deadline (see DEADLINE) — never an unbounded replay
      recoverMax: Number.isFinite(opts.recoverBatch) ? opts.recoverBatch : RECOVER_BATCH, recoverDeadline: t0 + (Number.isFinite(opts.recoverBudgetMs) ? opts.recoverBudgetMs : RECOVER_BUDGET_MS),
    });
    const lines = [];
    let rl = receiptLine(captured, act);
    if (rl && captured && captured.orphans_left > 0) rl = oneLine(rl + ' · ' + captured.orphans_left + ' earlier prompt(s) still wait to become items (recovered in batches, counted as open: ' + CLI + ' recover)', RECEIPT_MAX_CHARS + 140);
    if (rl) lines.push(rl);
    // WP-SCRIBE-REPEAT: an owner prompt that repeats an earlier ask is a HARD RULE at once — always its own line
    if (captured && captured.repeat_note && !captured.duplicate) lines.push(repeatLine(captured));
    const skippedSteps = [];
    let head = null;
    if (act && captured && captured.rid && !captured.duplicate) {
      if (left() > 100) head = opts.writeHead === false ? { ok: false, reason: 'disabled' } : writeScribeHead(root, act.run_id, captured.rid, Math.min(HEAD_LOCK_MS, left() - 50));
      else skippedSteps.push('run anchor');
    }
    let digestShown = false;
    if (fs.existsSync(p.ledger)) {
      if (left() > 50) {
        try {
          const post = digestOf(S.loadState(p));
          const key = sessionKey(payload.session_id);
          const rec = sessionRecord(p, key);
          const seen = rec && typeof rec.digest_sha === 'string' ? rec.digest_sha : null;
          const changed = !seen || pre === null || sha(pre) !== seen;
          if (changed && !/^Scribe: 0 active/.test(post)) { lines.push(digestLine(post)); digestShown = true; }
          updateSession(S, p, key, (r) => Object.assign(r, { digest_sha: sha(post) }), nowOf(opts).toISOString(), { waitMs: Math.max(50, Math.min(LOCK_WAIT_MS, left())) });
        } catch { /* fail-open: the receipt still stands; the digest comes back on a later prompt */ }
      } else skippedSteps.push('digest');
    }
    const notice = skippedSteps.length ? '[forge-scribe] captured; ' + skippedSteps.join(' and ') + ' skipped: time budget (' + budget + ' ms) used up' : null;
    if (notice) lines.push(notice);
    return out({ print: lines.length > 0, text: lines.join('\n') || null, captured, digest: digestShown, head, notice });
  } catch (e) {
    return out({ reason: 'internal: ' + short(e) });
  }
}

module.exports = {
  runPrompt, machineSkip, receiptLine, repeatLine, digestLine, writeScribeHead, encodeRids, decodeRids,
  loadScribe, activeRunOf, resolveRoot, sessionKey, sessionRecord, readHookState, updateSession, hookStateFile, isOff, oneLine, str,
  DEADLINE_MS, BUDGET_MS, LOCK_WAIT_MS, RECOVER_BATCH, RECOVER_BUDGET_MS, DIGEST_MAX_CHARS, RECEIPT_MAX_CHARS, HOOK_STATE_FILE, CLI,
};

// ---- CLI (UserPromptSubmit hook target — ALWAYS exits 0; prints the additionalContext JSON or nothing) ----
if (require.main === module) {
  let done = false;
  const finish = (text) => {
    if (done) return;
    done = true;
    if (text) {
      try { fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) + '\n'); } catch { /* nothing left to report to */ }
    }
    process.exit(0);
  };
  const failsafe = setTimeout(() => finish(null), DEADLINE_MS);
  if (failsafe.unref) failsafe.unref();
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (c) => { size += c.length; if (size <= MAX_STDIN_BYTES) chunks.push(c); });
  process.stdin.on('error', () => finish(null));
  process.stdin.on('end', () => {
    if (size > MAX_STDIN_BYTES) { finish(null); return; } // a truncated payload cannot be parsed honestly
    let payload = null;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { payload = null; }
    let r = null;
    try { r = runPrompt(payload, {}); } catch { r = null; }
    finish(r && r.print ? r.text : null);
  });
  process.stdin.resume();
}
