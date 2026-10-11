#!/usr/bin/env node
'use strict';
/**
 * forge-scribe.cjs — Forge Scribe core (design: audit
 * SCRIBE-F2/F5/F6/F7/F10/F11 in .claude/forge-research/overhaul-2026-10-09/audit-scribe.txt; hardened for Codex R3
 * SC-01..SC-12, 2026-10-10, findings in codex-r3-scribe.md). The ONLY sanctioned way to change scribe state. Zero deps,
 * no LLM call, no network.
 *
 * Purpose: every owner prompt is kept word-for-word (secrets scrubbed) in a hash-chained inbox, becomes a tracked item
 * (R-n) in an append-only ledger, and stays visible until it is planned, done WITH evidence, and acked BY THE OWNER — so
 * a 7-day project never silently drops a change request. An agent must not be able to make a wish disappear or declare
 * it accepted: everything that removes an item from the owner's view needs the owner (forge-scribe-store.cjs, OWNER AUTHORITY).
 *
 * Lifecycle (enforced here; storage + fold in forge-scribe-store.cjs, classifier in forge-scribe-classify.cjs):
 *   unclassified -classify-> open -link/plan-> planned -start-> in-progress -done(evidence)-> done -ack(OWNER)-> acked
 *   defer (agent, --reason)         -> defer-proposed: progress gate OK, FINAL gate blocks until the OWNER acks it
 *   defer --prompt P-n (owner) / ack of a defer-proposed item (owner) -> deferred (a confirmed carry-over)
 *   cancel (OWNER) from any state except cancelled/superseded; reopen: done|acked|deferred|defer-proposed|answered -> open
 *   supersede --supersedes R-m -> superseded, only when R-m still carries an outstanding WORK obligation (status
 *     unclassified/open/planned/in-progress, class new/change/cancel/unclassified — never a question, ack, preference,
 *     or a done/acked/deferred/answered item; Codex R5 SV-03); without such a replacement (or itself): OWNER only
 *   classify to question/ack/preference: OWNER only (--prompt), EXCEPT the classifier's own capture-time class and the
 *     children of a split (every CHARACTER span of the parent outside the split quotes stays visible: each uncovered
 *     non-ack span becomes a child too, checked before the parent is superseded; Codex R5 SV-02)
 *   the gate replays both (recheckAgentOps): a split or agent supersede that dropped scope blocks until the item is
 *     reopened (allowed for exactly such a flagged item) or the owner cancels it
 *   answer: only question/ack items; preference items close with `done --evidence standing_rule:<id>`
 *   repeat-rule (WP-SCRIBE-REPEAT): a captured prompt that repeats earlier owner asks carries repeat_of + repeat_count
 *     (forge-scribe-classify.cjs OWNER REPEATS); `transition R-n repeat-rule --ref standing_rule:<id>|decision_logged:<event_id>
 *     [--run id]` links the HARD RULE made for it (checked against real files; status unchanged; not owner-gated because
 *     it removes nothing from the owner's view). Until a chain has that link the digest head and the Stop hook show it.
 *   Applying an owner ack/cancel also answers the owner's own ack/cancel prompt item when it carries nothing else.
 *
 * Evidence for done (checked against real files, never a bare claim):
 *   wp_completed:<wp_id>   a wp_completed event with that wp_id in the run's events.jsonl; wp_id must be linked
 *   check_passed:<event_id> a check_passed event with that event_id in the run's events.jsonl
 *   commit:<sha>           `git cat-file -e <sha>^{commit}` succeeds in the project
 *   standing_rule:<id>     the rule id exists in FORGE_STANDING_RULES.user.json (preference items only)
 *
 * Owner authority (SC-01/SC-02, forge-scribe-store.cjs ownerAuthority): --prompt P-n must be a HOOK-captured record of the hash-chained
 * inbox (source hook, session id, prompt id), found as a typed owner message in this project's own Claude transcript
 * folder (realpath containment), with an affirmative act for that R-id (classifier intent, no negation) made AFTER the
 * state it approves. --transcript <path> adds a second corroborating transcript. Limit: a classifier plus provenance,
 * not a proof (an actor who can write the inbox, a transcript and the chains together is the documented class B).
 *
 * Crash recovery (SC-07): every command and the hooks first re-fold inbox prompts that never became an item (a crash
 * between the inbox and the ledger append) as open items; the gate counts such an orphan as open until then.
 *
 * CLI (root = FORGE_PROJECT_ROOT or two levels above this file):
 *   capture  (--text "<prompt>" | --stdin) [--source cli|dashboard|discord] [--session id] [--transcript path]
 *            [--uuid id] [--prompt-id id] [--run id] [--run-active] [--by lead]   (source hook: the hook module only)
 *   list     [--status s[,s]] [--json]
 *   digest   [--write]
 *   classify R-n <new|change|cancel|preference|question|ack> [--split "<exact quote>"]... [--prompt P-n]
 *   link     R-n --wp wp-3,wp-5 [--ticket T-1] [--run id]
 *   transition R-n <plan|start|done|ack|reopen|supersede|cancel|defer|answer>
 *            [--evidence type:ref] [--ref type:ref] [--run id] [--prompt P-n] [--transcript path] [--reason "..."] [--supersedes R-m] [--wp ..]
 *            (--pid is an alias of --prompt)
 *   impact   R-n --run id [--json]           (read-only proposal; confirm with `link`)
 *   route    R-n                              (prints the /forge remember command for a preference item)
 *   gate     [--final] [--until iso] [--json] (exit 3 while blocked; recomputed from ledger + inbox, never the cache)
 *   import-lines (--stdin | --file <json>) [--class new|change] [--run id] [--json]
 *            seed OPEN items from a project's own notes — [{text, source}] — no inbox record, no pid,
 *             by:'import', idempotent per (source file, text); used by forge-adopt-post-sync.cjs)
 *   recover                                   (re-fold orphan inbox prompts as open items; every command does this)
 *   rebuild                                   (refold state.json from ledger byte 0)
 *   verify-chain [--json]                     (exit 3 on a broken inbox/ledger chain or a disagreeing run-log anchor)
 * Exit codes: 0 ok · 2 usage/refused transition · 3 gate blocked / chain broken.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./forge-scribe-store.cjs');
const C = require('./forge-scribe-classify.cjs');

const DEFAULT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const TERMINAL_NO_RETURN = ['cancelled', 'superseded'];
const FROM = {
  classify: ['unclassified', 'open'],
  link: ['open', 'planned', 'deferred', 'defer-proposed'],
  plan: ['open', 'planned', 'deferred', 'defer-proposed'],
  start: ['planned'],
  done: ['in-progress'],
  ack: ['done', 'defer-proposed'],
  reopen: ['done', 'acked', 'deferred', 'defer-proposed', 'answered'],
  answer: ['unclassified', 'open'],
  defer: ['unclassified', 'open', 'planned', 'in-progress', 'defer-proposed'],
};
const OPS = ['classify', 'link', 'plan', 'start', 'done', 'ack', 'reopen', 'supersede', 'cancel', 'defer', 'answer', 'repeat-rule'];
// WP-SCRIBE-REPEAT: the link that closes a repeat obligation (a NOTE field, not done-evidence: the status never changes)
const REPEAT_RULE_TYPES = ['standing_rule', 'decision_logged'];
const EVIDENCE_TYPES = ['wp_completed', 'check_passed', 'commit', 'standing_rule'];
// SC-03: classes with a close path that needs no work evidence — only the classifier or the owner may set them
const OWNER_GATED_CLASSES = ['question', 'ack', 'preference'];
// identities a caller may never claim with --by: they are set by this module from verified facts only
const RESERVED_BY = ['owner', 'scribe', 'recovery', 'import', 'hook'];
const CLI_SOURCES = ['cli', 'dashboard', 'discord'];
const RUN_ID_RE = /^[A-Za-z0-9_.-]+$/;

class ScribeError extends Error { constructor(msg) { super(msg); this.code = 'SCRIBE_REFUSED'; } }
const refuse = (m) => { throw new ScribeError(m); };

function ctx(opts) {
  const o = opts || {};
  const root = o.root ? path.resolve(o.root) : DEFAULT_ROOT;
  const cfg = o.config || C.loadConfig(o.configPath);
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  return { o, root, cfg, now, p: S.paths(root) };
}
const iso = (c) => c.now().toISOString();
const pad = (n, w) => String(n).padStart(w, '0');
const lockOpts = (c) => (Number.isFinite(c.o.lockWaitMs) ? { waitMs: c.o.lockWaitMs } : undefined);

function titleOf(text, max) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Append a ledger op (caller holds the lock), then fold incrementally and persist state + digest. Free text (reason)
 *  goes through the same redactor as a prompt (SC-09). */
function writeOp(c, rec) {
  const state = S.loadState(c.p);
  const full = Object.assign({ v: 1, seq: state.last_seq + 1, ts: iso(c) }, rec);
  if (full.reason !== undefined && full.reason !== null) full.reason = S.scrubMeta(full.reason, 500);
  for (const k of Object.keys(full)) if (full[k] === undefined || full[k] === null) delete full[k];
  S.appendChained(c.p.ledger, full);
  const next = S.loadState(c.p);
  S.saveState(c.p, next);
  S.writeFenced(c.p.digest, S.buildDigest(next, c.cfg.caps.digest_max_chars) + '\n');
  return next;
}

function receipt(state, rid, cls) {
  const active = Object.values(state.items).filter((i) => S.ACTIVE.includes(i.status)).length;
  return 'Genoteerd: ' + rid + ' (' + cls + ') · ' + active + ' open';
}
function maxPid(records) {
  let m = 0;
  for (const r of records) { const x = r && /^P-(\d+)$/.exec(String(r.pid || '')); if (x) m = Math.max(m, parseInt(x[1], 10)); }
  return m;
}

// ---------------------------------------------------------------- crash recovery (SC-07)

/* BOUNDED RECOVERY (Codex R5 SV-09): Node cannot interrupt synchronous work — a timer callback only runs once the current
 * task returns, so a deadline timer around a long replay fires too late. (A worker thread could be terminated, but
 * terminating it mid-append can tear a hash-chained line, which is worse than a late hook.) The bound is therefore set UP
 * FRONT: every replay takes a batch size and a deadline that is checked BEFORE each item, so one call does at most
 * `max` items and starts none after the deadline. Whatever is left stays an ORPHAN, which the gate counts as open
 * (blocking) and the Stop hook reports, until a later call (any CLI command, the next prompt, `recover`) folds it. */
const CAPTURE_RECOVER_MAX = 50;   // the library capture's default batch (the hook passes a smaller one)

/** recoverOrphans(c, lim?) — caller holds the lock. Inbox prompts without an item become open items (by:'recovery'),
 *  oldest first, at most lim.max of them and none started at or after lim.deadline (epoch ms). -> [{rid, pid}] with a
 *  non-enumerable `left` (orphans still waiting). */
function recoverOrphans(c, lim) {
  lim = lim || {};
  const max = Number.isFinite(lim.max) && lim.max >= 0 ? lim.max : Infinity;
  const deadline = Number.isFinite(lim.deadline) ? lim.deadline : Infinity;
  const out = [];
  Object.defineProperty(out, 'left', { value: 0, writable: true, enumerable: false });
  if (!fs.existsSync(c.p.inbox)) return out;
  const ix = S.inboxIndex(c.p);
  if (!ix.records.length) return out;
  const have = new Set(Object.values(S.loadState(c.p).items).map((i) => i.pid).filter(Boolean));
  for (const r of ix.records) {
    if (!isPromptRecord(r) || have.has(r.pid)) continue;
    if (out.length >= max || Date.now() >= deadline) { out.left++; continue; }
    const cl = C.classify(r.text, c.cfg);
    const st0 = S.loadState(c.p);
    const rid = 'R-' + pad(st0.next_rid, 4);
    const rp = repeatsOf(c, r.text, st0);
    writeOp(c, { op: 'open', rid, by: 'recovery', pid: r.pid, quote: r.text, span: [0, r.text.length], class: cl.class,
      title: titleOf(r.text, c.cfg.caps.title_max_chars), multi_ask: cl.multi_ask || undefined,
      repeat_of: rp ? rp.repeat_of : undefined, repeat_count: rp ? rp.repeat_count : undefined });
    have.add(r.pid);
    out.push({ rid, pid: r.pid });
  }
  return out;
}
/** recover(opts) -> [{rid, pid}] (+ non-enumerable `left`) — the CLI/hook start step (takes the lock). opts.max and
 *  opts.deadline (epoch ms) bound it (see BOUNDED RECOVERY); absent = everything (the CLI). */
function recover(opts) {
  const c = ctx(opts);
  if (!fs.existsSync(c.p.inbox)) return [];
  return S.withLock(c.p, () => recoverOrphans(c, { max: c.o.max, deadline: c.o.deadline }), lockOpts(c));
}

// ---------------------------------------------------------------- owner repeats (WP-SCRIBE-REPEAT)
/** repeatsOf(c, text, state) -> null | {repeat_of, repeat_count} — forge-scribe-classify.cjs findRepeats against the
 *  items already in the ledger (token sets, bounded, no I/O). Fail-open: an error means "no repeat", never a lost prompt. */
function repeatsOf(c, text, state) {
  try { return C.findRepeats(text, Object.values(state.items || {}), c.cfg); } catch { return null; }
}

// ---------------------------------------------------------------- capture

/** capture(text, opts) — redact the full prompt, then cap it (SC-09); dedupe only within the SAME session and a short
 *  window, and even then keep the record with duplicate_of (SC-11); a ledger failure leaves an orphan that recovery
 *  re-folds (SC-07). Metadata goes through the redactor too. opts.lockWaitMs bounds the wait (the hook's deadline);
 *  opts.recoverMax (default CAPTURE_RECOVER_MAX) and opts.recoverDeadline (epoch ms) bound the orphan replay that runs
 *  first (R5 SV-09) — the prompt itself is always captured. */
function capture(text, opts) {
  const c = ctx(opts);
  const a = c.o;
  const max = Number(c.cfg.caps.max_prompt_chars) || 20000;
  const nm = S.normalizePrompt(text, max);
  if (!nm.text.trim()) refuse('capture: empty prompt');
  if (a.run_id !== undefined && a.run_id !== null && !RUN_ID_RE.test(String(a.run_id))) refuse('capture: invalid run id');
  const textSha = S.sha256(nm.text);
  const windowMs = (Number(c.cfg.caps.inbox_dedupe_window_sec) || 30) * 1000;
  const sess = S.scrubMeta(a.session_id, 200);
  const recLim = { max: Number.isFinite(a.recoverMax) ? a.recoverMax : CAPTURE_RECOVER_MAX, deadline: a.recoverDeadline };
  return S.withLock(c.p, () => {
    let recovered = [];
    try { recovered = recoverOrphans(c, recLim); } catch { /* fail-open: the gate still counts an orphan as open */ }
    const nowMs = c.now().getTime();
    const ix = S.inboxIndex(c.p);
    const dup = ix.records.slice().reverse().find((r) => isPromptRecord(r) && r.text_sha256 === textSha && (r.session_id || null) === sess && Math.abs(nowMs - Date.parse(r.ts)) <= windowMs);
    const pid = 'P-' + pad(maxPid(ix.records) + 1, 6);
    // prompt_id: the UserPromptSubmit hook payload's prompt_id, which Claude Code also writes as `promptId`
    // on the matching transcript entry — the owner check binds an ack/cancel to that exact entry.
    const rec = {
      v: 1, pid, ts: iso(c), session_id: sess, source: S.scrubMeta(a.source || 'cli', 40),
      transcript_path: S.scrubMeta(a.transcript_path, 1024), uuid: S.scrubMeta(a.uuid, 200), text: nm.text, redacted: nm.redacted, text_sha256: textSha,
    };
    if (nm.truncated) { rec.truncated = true; rec.chars = nm.chars; }
    if (a.prompt_id) rec.prompt_id = S.scrubMeta(a.prompt_id, 80);
    if (dup) rec.duplicate_of = dup.pid;
    S.appendChained(c.p.inbox, rec);
    const rec0 = { recovered: recovered.length, orphans_left: recovered.left || 0 };
    if (dup) {
      const item = Object.values(S.loadState(c.p).items).find((i) => i.pid === dup.pid);
      return Object.assign({ duplicate: true, pid, duplicate_of: dup.pid, rid: item ? item.rid : null, receipt: 'Al genoteerd: ' + dup.pid + (item ? ' (' + item.rid + ')' : '') }, rec0);
    }
    // Fail-open from here on: the prompt is already safely in the inbox (an orphan is recovered on the next start).
    try {
      const cl = C.classify(nm.text, c.cfg);
      const st0 = S.loadState(c.p);
      const rid = 'R-' + pad(st0.next_rid, 4);
      const rp = repeatsOf(c, nm.text, st0);
      const state = writeOp(c, {
        op: 'open', rid, by: a.source === 'hook' ? 'hook' : (a.by && !RESERVED_BY.includes(String(a.by).toLowerCase()) ? String(a.by).slice(0, 40) : 'cli'), pid, quote: nm.text, span: [0, nm.text.length], class: cl.class,
        title: titleOf(nm.text, c.cfg.caps.title_max_chars), multi_ask: cl.multi_ask || undefined,
        run_id: a.run_id, impact: a.run_active ? 'pending' : undefined, truncated: nm.truncated || undefined,
        repeat_of: rp ? rp.repeat_of : undefined, repeat_count: rp ? rp.repeat_count : undefined,
      });
      const item = state.items[rid];
      const rtag = item ? S.repeatTag(item) : null;
      return Object.assign({ duplicate: false, pid, rid, class: cl.class, multi_ask: cl.multi_ask, asks: cl.asks, redacted: nm.redacted, truncated: nm.truncated,
        receipt: receipt(state, rid, cl.class) + (rtag ? ' · ' + rtag : ''),
        repeat_of: item && item.repeat_of ? item.repeat_of : undefined, repeat_count: item && item.repeat_count ? item.repeat_count : undefined,
        repeat_note: item ? S.repeatNote(item) || undefined : undefined }, rec0);
    } catch (e) {
      return Object.assign({ duplicate: false, pid, rid: null, class: null, ledger_error: String(e && e.message || e), receipt: 'Genoteerd: ' + pid + ' (ledger niet bijgewerkt)' }, rec0);
    }
  }, lockOpts(c));
}

/** recordSkip(reason, opts) — SC-11: one counter line per machine text the hook skipped (no text, no raw session id),
 *  only where the scribe is already in use (a skipped prompt never creates the store). Never throws. */
function recordSkip(reason, opts) {
  try {
    const c = ctx(opts);
    if (!fs.existsSync(c.p.ledger) && !fs.existsSync(c.p.inbox)) return false;
    const sk = c.o.session_id ? S.sha256(String(c.o.session_id)).slice(0, 16) : null;
    S.withLock(c.p, () => { S.appendChained(c.p.skipped, { v: 1, ts: iso(c), reason: String(reason).slice(0, 40), session_key: sk, chars: Number(c.o.chars) || 0 }); }, lockOpts(c));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- evidence

function runEvents(c, runId) {
  if (!runId || !RUN_ID_RE.test(runId)) refuse('evidence: a valid --run id is required');
  const f = path.join(c.root, '.claude', 'forge-runs', runId, 'events.jsonl');
  if (!fs.existsSync(f)) refuse('evidence: no events.jsonl for run ' + runId);
  return S.readJsonl(f, false);
}

function verifyEvidence(c, it, ev, runId) {
  if (!ev || !ev.type || !ev.ref) refuse('done needs --evidence <type>:<ref> (types: ' + EVIDENCE_TYPES.join(', ') + ')');
  if (!EVIDENCE_TYPES.includes(ev.type)) refuse('unknown evidence type ' + ev.type);
  if (ev.type === 'wp_completed') {
    if (!it.wp_ids.includes(ev.ref)) refuse('evidence wp ' + ev.ref + ' is not linked to ' + it.rid);
    const evs = runEvents(c, runId);
    const hit = evs.find((e) => e.event_type === 'wp_completed' && e.wp_id === ev.ref && !/fail/i.test(String(e.status || '')));
    if (!hit) refuse('evidence: no wp_completed for ' + ev.ref + ' in run ' + runId);
    return { type: ev.type, ref: ev.ref, run_id: runId, event_id: hit.event_id || null };
  }
  if (ev.type === 'check_passed') {
    const evs = runEvents(c, runId);
    if (!evs.find((e) => e.event_type === 'check_passed' && e.event_id === ev.ref)) refuse('evidence: no check_passed event ' + ev.ref + ' in run ' + runId);
    return { type: ev.type, ref: ev.ref, run_id: runId };
  }
  if (ev.type === 'commit') {
    if (!/^[0-9a-f]{7,40}$/i.test(ev.ref)) refuse('evidence: commit ref must be a hex sha');
    const r = spawnSync('git', ['--no-optional-locks', '-C', c.root, 'cat-file', '-e', ev.ref + '^{commit}'], { encoding: 'utf8' });
    if (r.status !== 0) refuse('evidence: commit ' + ev.ref + ' not found in ' + c.root);
    return { type: ev.type, ref: ev.ref };
  }
  // standing_rule
  if (it.class !== 'preference') refuse('standing_rule evidence is only valid for a preference item');
  requireStandingRule(c, ev.ref, 'evidence');
  return { type: ev.type, ref: ev.ref };
}
function requireStandingRule(c, id, what) {
  const f = c.o.standingRulesPath || path.join(c.root, '.claude', 'config', 'orchestration', 'FORGE_STANDING_RULES.user.json');
  let rules = [];
  try { rules = JSON.parse(fs.readFileSync(f, 'utf8')).rules || []; } catch { rules = []; }
  if (!rules.some((r) => r && r.id === id)) refuse(what + ': standing rule ' + id + ' not found in ' + f);
}
/** verifyRepeatRule(c, it, ref, runId) — WP-SCRIBE-REPEAT: the HARD RULE behind a repeated ask must exist: a standing
 *  rule id in FORGE_STANDING_RULES.user.json, or a decision_logged event (by event_id) in the run's events.jsonl. This
 *  does NOT widen standing_rule done-evidence (still preference items only); it only records a note on the item. */
function verifyRepeatRule(c, it, ref, runId) {
  if (!Array.isArray(it.repeat_of) || !it.repeat_of.length) refuse('repeat-rule: ' + it.rid + ' is not a repeat (no repeat_of)');
  if (!ref || !ref.type || !ref.ref) refuse('repeat-rule needs --ref <type>:<ref> (types: ' + REPEAT_RULE_TYPES.join(', ') + ')');
  if (!REPEAT_RULE_TYPES.includes(ref.type)) refuse('repeat-rule: unknown ref type ' + ref.type + ' (types: ' + REPEAT_RULE_TYPES.join(', ') + ')');
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(ref.ref)) refuse('repeat-rule: invalid ref');
  if (ref.type === 'standing_rule') { requireStandingRule(c, ref.ref, 'repeat-rule'); return { type: ref.type, ref: ref.ref }; }
  const evs = runEvents(c, runId);
  if (!evs.find((e) => e.event_type === 'decision_logged' && e.event_id === ref.ref)) refuse('repeat-rule: no decision_logged event ' + ref.ref + ' in run ' + runId);
  return { type: ref.type, ref: ref.ref, run_id: runId };
}

/** ownerCheck(c, pid, rid, op, item, transcript?) — forge-scribe-store.cjs ownerAuthority (see its OWNER AUTHORITY header). */
function ownerCheck(c, pid, rid, op, item, transcript) {
  try { return S.ownerAuthority(c, { pid, rid, op, item, transcript }); } catch (e) { if (e && e.code === 'SCRIBE_REFUSED') refuse(e.message); throw e; }
}
/** onlyActs(text, intent, cfg) — true when the owner's prompt carries nothing but acts of this intent (no new, change or
 *  preference anywhere; for an ack prompt no cancel either), so applying it may close the prompt's own item. */
function onlyActs(text, intent, cfg) {
  const req = intent === 'ack' ? ['new', 'change', 'preference', 'cancel'] : ['new', 'change', 'preference'];
  return C.splitSentences(text).every((s) => { const sc = C.scoreText(s.text, cfg); return req.every((k) => !(Number(sc[k]) > 0)); });
}
/** answerOwnPrompt(c, rec, intent, applied) — the owner's own ack/cancel prompt item is answered once applied. */
function answerOwnPrompt(c, rec, intent, applied) {
  if (!onlyActs(rec.text, intent, c.cfg)) return;
  for (const it of Object.values(S.loadState(c.p).items)) {
    if (it.pid === rec.pid && it.class === intent && ['unclassified', 'open'].includes(it.status)) {
      writeOp(c, { op: 'answer', rid: it.rid, by: 'scribe', pid: rec.pid, reason: 'applied: ' + applied });
    }
  }
}

// ---------------------------------------------------------------- transitions

function getItem(c, rid, st0) {
  const st = st0 || S.loadState(c.p);
  const it = st.items[rid];
  if (!it) refuse('unknown item ' + rid);
  return { st, it };
}

// ---------------------------------------------------------------- split coverage + supersede replacement (R5 SV-02/SV-03)
const MEANINGFUL_RE = /[\p{L}\p{N}]/u;
// SV-03: a replacement keeps the work obligation only while it is still outstanding work that closes with evidence
const WORK_STATUSES = ['unclassified', 'open', 'planned', 'in-progress'];
const WORK_CLASSES = ['new', 'change', 'cancel', 'unclassified'];
/** bareAck(text, cfg) — an ack/thanks with no new/change/cancel/preference words (nothing to track). */
function bareAck(text, cfg) {
  const cl = C.classify(text, cfg);
  const sc = cl.scores || {};
  return cl.class === 'ack' && !['new', 'change', 'cancel', 'preference'].some((k) => Number(sc[k]) > 0);
}
/** uncoveredPieces(quote, spans, cfg) -> [{q, at, end, bareAck}] — Codex R5 SV-02: EVERY character of the quote outside
 *  the given spans is accounted for. Each maximal uncovered run is cut into sentences; leading separators (", ") are
 *  dropped; a piece without a letter or digit is nothing. A partial overlap never hides the rest of a sentence. */
function uncoveredPieces(quote, spans, cfg) {
  const q = String(quote || '');
  const cov = new Uint8Array(q.length);
  for (const x of spans) for (let i = Math.max(0, x.at); i < Math.min(q.length, x.end); i++) cov[i] = 1;
  const out = [];
  for (let i = 0; i < q.length;) {
    if (cov[i]) { i++; continue; }
    let j = i;
    while (j < q.length && !cov[j]) j++;
    const run = q.slice(i, j);
    for (const s of C.splitSentences(run)) {
      let a = s.start;
      while (a < s.end && !MEANINGFUL_RE.test(run[a])) a++;
      if (a >= s.end) continue;
      const text = run.slice(a, s.end).trimEnd();
      out.push({ q: text, at: i + a, end: i + a + text.length, bareAck: bareAck(text, cfg) });
    }
    i = j;
  }
  return out;
}
/** coverageGaps(quote, spans) -> [{at, text}] — letters/digits of the quote inside none of the spans (must be none). */
function coverageGaps(quote, spans) {
  const q = String(quote || '');
  const cov = new Uint8Array(q.length);
  for (const x of spans) for (let i = Math.max(0, x.at); i < Math.min(q.length, x.end); i++) cov[i] = 1;
  const gaps = [];
  for (let i = 0; i < q.length; i++) if (!cov[i] && MEANINGFUL_RE.test(q[i])) { gaps.push({ at: i, text: q.slice(i, i + 40) }); while (i < q.length && !cov[i]) i++; }
  return gaps;
}
/** replacementProblem(items, rid, sup) -> null | why — SV-03: why R-sup cannot carry R-rid's scope forward. */
function replacementProblem(items, rid, sup) {
  if (!sup) return 'no replacement is named';
  if (sup === rid) return 'it names itself';
  const rep = items[sup];
  if (!rep) return 'the replacement ' + sup + ' does not exist';
  if (!WORK_STATUSES.includes(rep.status)) return 'the replacement ' + sup + ' is ' + rep.status + ' — no outstanding work carries the scope forward';
  if (!WORK_CLASSES.includes(rep.class)) return 'the replacement ' + sup + ' is a ' + rep.class + ' item — it closes without work evidence';
  return null;
}
/** recheckAgentOps(records, cfg) -> [{rid, op, seq, status, reason}] — Codex R5 SV-02/SV-03, the gate's replay check of
 *  agent ops that drop scope (like recheckOwnerOps for owner ops): a split whose children leave a non-ack part of the
 *  parent quote untracked (uncovered-split), a non-owner supersede whose replacement did not, at that moment, carry an
 *  outstanding work obligation (unbacked-supersede), and a superseded_by cycle (supersede-cycle). A later reopen of the
 *  item (allowed for a flagged item) or an owner cancel clears its flag. */
function recheckAgentOps(records, cfg) {
  const st = S.emptyState();
  const flagged = new Map();
  for (const r of records) {
    if (!r || !(r.seq > st.last_seq)) continue;
    const it = st.items[r.rid];
    if (it && r.op === 'split') {
      const kids = (r.children || []).map((k) => st.items[k]).filter((k) => k && k.parent === r.rid && Array.isArray(k.span)).map((k) => ({ at: k.span[0], end: k.span[1] }));
      const lost = uncoveredPieces(it.quote, kids, cfg).filter((x) => !x.bareAck);
      if (lost.length) flagged.set(r.rid, { rid: r.rid, op: 'split', seq: r.seq, status: 'uncovered-split', reason: 'the split of ' + r.rid + ' tracks ' + lost.length + ' part(s) of the owner prompt in no child (' + JSON.stringify(lost[0].q.slice(0, 60)) + ') — reopen ' + r.rid + ' and split it again' });
    }
    if (it && r.op === 'supersede' && r.by !== 'owner') {
      const why = replacementProblem(st.items, r.rid, r.supersedes);
      if (why) flagged.set(r.rid, { rid: r.rid, op: 'supersede', seq: r.seq, status: 'unbacked-supersede', reason: r.rid + ' was superseded without the owner, but ' + why + ' — reopen ' + r.rid + ' or let the owner decide' });
    }
    if (it && (r.op === 'reopen' || (r.op === 'cancel' && r.by === 'owner'))) flagged.delete(r.rid);
    S.applyOp(st, r);
    st.last_seq = r.seq;
  }
  for (const it of Object.values(st.items)) {
    if (it.status !== 'superseded' || !it.superseded_by || flagged.has(it.rid)) continue;
    const seen = new Set([it.rid]);
    for (let cur = st.items[it.superseded_by]; cur && cur.status === 'superseded' && cur.superseded_by; cur = st.items[cur.superseded_by]) {
      if (seen.has(cur.rid)) { flagged.set(it.rid, { rid: it.rid, op: 'supersede', seq: null, status: 'supersede-cycle', reason: it.rid + ' is superseded through a cycle (' + Array.from(seen).join(' -> ') + ') — no item carries its scope' }); break; }
      seen.add(cur.rid);
    }
  }
  return Array.from(flagged.values());
}

/** splitChildren(c, it, splits, label) — the split quotes plus EVERY uncovered character span of the parent that is not a
 *  bare ack (Codex R5 SV-02: a partial overlap never covers the rest of a sentence), and a self-check that nothing
 *  meaningful is left untracked before the parent is superseded (SC-03). */
function splitChildren(c, it, splits, label) {
  const spans = splits.map((q) => {
    const at = it.quote.indexOf(q);
    if (at < 0) refuse('split quote is not an exact substring of ' + it.rid + ': ' + JSON.stringify(q));
    if (!MEANINGFUL_RE.test(q)) refuse('split quote ' + JSON.stringify(q) + ' holds no words');
    return { q, at, end: at + q.length };
  });
  const pieces = uncoveredPieces(it.quote, spans, c.cfg);
  for (const x of pieces) if (!x.bareAck) spans.push({ q: x.q, at: x.at, end: x.end, uncovered: true });
  const gaps = coverageGaps(it.quote, spans.concat(pieces.filter((x) => x.bareAck)));
  if (gaps.length) refuse('split of ' + it.rid + ' would leave part of the owner prompt untracked (' + JSON.stringify(gaps[0].text) + ') — refused');
  return spans.sort((x, y) => x.at - y.at).map((x) => {
    const cl = C.classify(x.q, c.cfg).class;
    const fallback = OWNER_GATED_CLASSES.includes(label) ? 'unclassified' : label;
    return { q: x.q, at: x.at, end: x.end, class: cl === 'unclassified' ? fallback : cl, uncovered: !!x.uncovered };
  });
}

function transition(rid, op, args, opts) {
  const c = ctx(opts);
  const a = args || {};
  if (!OPS.includes(op)) refuse('unknown op ' + op + ' (ops: ' + OPS.join(', ') + ')');
  if (a.by && RESERVED_BY.includes(String(a.by).toLowerCase())) refuse('--by ' + a.by + ' is reserved: that identity is set only from verified facts');
  if (a.run_id !== undefined && a.run_id !== null && !RUN_ID_RE.test(String(a.run_id))) refuse('invalid run id');
  return S.withLock(c.p, () => {
    try { recoverOrphans(c); } catch { /* the gate still counts an orphan */ }
    const { st, it } = getItem(c, rid);
    const isPrefDone = op === 'done' && it.class === 'preference' && a.evidence && a.evidence.type === 'standing_rule' && ['open', 'planned', 'in-progress'].includes(it.status);
    // R5 SV-02/SV-03: an item the gate's replay check flags (a split that lost scope, an unbacked supersede) may be reopened
    const isFlaggedReopen = op === 'reopen' && it.status === 'superseded' && recheckAgentOps(S.readJsonl(c.p.ledger, true), c.cfg).some((x) => x.rid === rid);
    if (FROM[op] && !FROM[op].includes(it.status) && !isPrefDone && !isFlaggedReopen) refuse('illegal transition ' + op + ' from ' + it.status + ' for ' + rid);
    if (!FROM[op] && TERMINAL_NO_RETURN.includes(it.status)) refuse('illegal transition ' + op + ' from ' + it.status + ' for ' + rid);
    const base = { rid, by: a.by || 'lead', run_id: a.run_id };
    const owner = (kind) => ownerCheck(c, a.pid, rid, kind, it, a.transcript);
    switch (op) {
      case 'classify': {
        if (!a.class || a.class === 'unclassified' || !C.CLASSES.includes(a.class)) refuse('classify needs a class: ' + C.CLASSES.filter((x) => x !== 'unclassified').join('|'));
        const splits = (a.split || []).filter(Boolean);
        if (!splits.length) {
          if (OWNER_GATED_CLASSES.includes(a.class) && a.class !== it.class) {
            if (!a.pid) refuse('classify ' + rid + ' ' + a.class + ' needs the owner: a ' + a.class + ' item can close without work evidence, so only the owner may reclassify to it — present it and pass --prompt P-n (an owner prompt that acks ' + rid + ')');
            const rec = owner('classify');
            return writeOp(c, Object.assign(base, { op: 'classify', class: a.class, by: 'owner', pid: rec.pid })).items[rid];
          }
          return writeOp(c, Object.assign(base, { op: 'classify', class: a.class })).items[rid];
        }
        let next = st.next_rid;
        const children = [];
        const recs = splitChildren(c, it, splits, a.class).map((x) => {
          const child = 'R-' + pad(next++, 4);
          children.push(child);
          return { op: 'open', rid: child, by: base.by, pid: it.pid, parent: rid, quote: x.q, span: [x.at, x.end], class: x.class,
            title: titleOf(x.q, c.cfg.caps.title_max_chars), run_id: a.run_id, uncovered_split: x.uncovered || undefined };
        });
        for (const r of recs) writeOp(c, r);
        return writeOp(c, Object.assign(base, { op: 'split', children })).items[rid];
      }
      case 'link': case 'plan': {
        const wp = (a.wp_ids || []).filter(Boolean), tk = (a.tickets || []).filter(Boolean);
        if (!wp.length && !tk.length) refuse(op + ' needs at least one --wp or --ticket');
        if (wp.some((w) => !/^[A-Za-z0-9_.-]+$/.test(w))) refuse('invalid wp id');
        if (tk.some((w) => !/^[A-Za-z0-9_.-]+$/.test(w))) refuse('invalid ticket id');
        return writeOp(c, Object.assign(base, { op: 'link', wp_ids: wp, tickets: tk })).items[rid];
      }
      case 'start': return writeOp(c, Object.assign(base, { op })).items[rid];
      case 'done': {
        const runId = a.run_id || it.run_ids[it.run_ids.length - 1];
        const evidence = verifyEvidence(c, it, a.evidence, runId);
        return writeOp(c, Object.assign(base, { op, evidence, run_id: runId })).items[rid];
      }
      case 'ack': case 'cancel': {
        const rec = owner(op);
        const next = writeOp(c, Object.assign(base, { op, by: 'owner', pid: rec.pid, reason: a.reason }));
        answerOwnPrompt(c, rec, op, op + ' of ' + rid);
        return S.loadState(c.p).items[rid] || next.items[rid];
      }
      case 'defer': {
        if (!a.reason) refuse('defer needs --reason');
        if (a.pid) { // the owner confirms the carry-over directly
          const rec = owner('defer');
          const next = writeOp(c, Object.assign(base, { op, by: 'owner', pid: rec.pid, reason: a.reason }));
          answerOwnPrompt(c, rec, 'ack', 'deferral of ' + rid);
          return S.loadState(c.p).items[rid] || next.items[rid];
        }
        if (it.status === 'defer-proposed') refuse(rid + ' is already proposed for deferral — the owner confirms it (ack ' + rid + ' --prompt P-n)');
        return writeOp(c, Object.assign(base, { op, reason: a.reason })).items[rid];
      }
      case 'reopen': {
        if (!a.reason) refuse('reopen needs --reason');
        return writeOp(c, Object.assign(base, { op, reason: a.reason })).items[rid];
      }
      case 'supersede': {
        const rep = a.supersedes ? st.items[a.supersedes] : null;
        if (a.supersedes && !rep) refuse('supersede: unknown item ' + a.supersedes);
        // Codex R5 SV-03: only a replacement that still carries an outstanding WORK obligation (unclassified/open/planned/
        // in-progress, class new/change/cancel/unclassified) carries the scope forward — never an open question, an ack,
        // a preference, or an item that is already done, acked, deferred, answered, cancelled or superseded
        const problem = replacementProblem(st.items, rid, a.supersedes);
        if (!problem) return writeOp(c, Object.assign(base, { op, supersedes: a.supersedes, reason: a.reason })).items[rid];
        // no replacement carries the scope forward: that removes it, which only the owner may do (SC-03)
        if (!a.pid) refuse('supersede ' + rid + (a.supersedes ? ' by ' + a.supersedes : ' without a replacement') + ' would drop it (' + problem + ') — only the owner may: pass --prompt P-n, or name a replacement that is still open work with --supersedes R-m');
        if (!a.reason && !a.supersedes) refuse('supersede needs --supersedes R-m or --reason');
        const rec = owner('supersede');
        return writeOp(c, Object.assign(base, { op, by: 'owner', pid: rec.pid, supersedes: a.supersedes, reason: a.reason })).items[rid];
      }
      case 'answer': {
        if (!['question', 'ack'].includes(it.class)) refuse('answer is only for question/ack items (' + rid + ' is ' + it.class + ')');
        return writeOp(c, Object.assign(base, { op, reason: a.reason })).items[rid];
      }
      case 'repeat-rule': {
        const ref = a.ref || a.evidence;
        const runId = ref && ref.type === 'decision_logged' ? (a.run_id || it.run_ids[it.run_ids.length - 1]) : a.run_id;
        const repeatRuleRef = verifyRepeatRule(c, it, ref, runId);
        return writeOp(c, Object.assign(base, { op, run_id: runId, repeat_rule_ref: repeatRuleRef, reason: a.reason })).items[rid];
      }
      default: return refuse('unhandled op ' + op);
    }
  }, lockOpts(c));
}

// ---------------------------------------------------------------- impact / gate / list

function tokens(text, cfg) {
  const s = String(text || '');
  const stop = new Set((cfg.impact.stopwords || []).map((w) => w.toLowerCase()));
  const paths = (s.match(/[\w.\-\\/]*[\w\-]\.[a-z0-9]{1,6}\b|[\w\-]+\/[\w\-./]+/gi) || []).map((x) => x.replace(/\\/g, '/').toLowerCase());
  const words = (s.toLowerCase().match(/\p{L}{4,}/gu) || []).filter((w) => !stop.has(w));
  return { paths: Array.from(new Set(paths)), words: Array.from(new Set(words)) };
}

function impact(rid, runId, opts) {
  const c = ctx(opts);
  const { it } = getItem(c, rid);
  const evs = runEvents(c, runId);
  const wps = new Map();
  for (const e of evs) if (e.event_type === 'agent_work_package_created' && e.wp_id) wps.set(e.wp_id, e);
  const tk = tokens(it.quote, c.cfg);
  const pw = Number(c.cfg.impact.path_weight) || 5, ww = Number(c.cfg.impact.word_weight) || 1;
  const scored = [];
  for (const [wpId, e] of wps) {
    const body = ['task', 'mission', 'title', 'inputs', 'allowed_actions', 'output_artifact', 'files', 'related_files']
      .map((k) => (e[k] == null ? '' : (typeof e[k] === 'string' ? e[k] : JSON.stringify(e[k])))).join(' ').replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
    const pathHits = tk.paths.filter((pth) => body.includes(pth) || body.includes(path.posix.basename(pth)));
    const wt = new Set(tokens(body, c.cfg).words);
    const wordHits = tk.words.filter((w) => wt.has(w));
    scored.push({ wp_id: wpId, path_hits: pathHits, word_hits: wordHits, score: pathHits.length * pw + wordHits.length * ww });
  }
  scored.sort((x, y) => y.score - x.score || x.wp_id.localeCompare(y.wp_id));
  let proposed;
  if (scored.some((s) => s.path_hits.length)) proposed = scored.filter((s) => s.path_hits.length).map((s) => s.wp_id);
  else {
    const top = scored.length ? scored[0].word_hits.length : 0;
    proposed = top >= (Number(c.cfg.impact.min_word_overlap) || 2) ? scored.filter((s) => s.word_hits.length === top).map((s) => s.wp_id) : [];
  }
  return { rid, run_id: runId, proposed, scored, next: proposed.length ? 'forge-scribe link ' + rid + ' --wp ' + proposed.join(',') + ' --run ' + runId : 'no package matched — plan a new work package for ' + rid };
}

// ---------------------------------------------------------------- integrity: gate, anchors, binding (SC-05/06/07)
/* GATE (SC-06/SC-07): recomputed from the ledger AND inbox bytes on every call — state.json is never consulted. It blocks
 * on items in a blocking status (progress: unclassified/open/planned/in-progress; final adds done and defer-proposed),
 * inbox prompts that never became an item (an ORPHAN counts as open), by:'owner' ops no hook prompt authorises, a broken
 * inbox/ledger chain, and a ledger that disagrees with a head ANCHOR recorded in a run event log.
 * ANCHORS (SC-06): forge-dashboard/log-event.cjs stamps the scribe ledger + inbox head and line count on every scribe_head
 * event (one per hook capture while a run is active) and on owner_requests_reconciled. Those run logs are hash-chained and
 * finalize-pinned outside the scribe store, so a ledger truncated to an earlier prefix and rebuilt no longer matches the
 * head an anchor recorded at that line. Codex R5 SV-06: gate() and verify-chain check EVERY anchor in EVERY run log — no
 * newest-N window (12 newer anchor-free runs used to hide an older anchor), no mtime cut-off and no size cut-off (both are
 * attacker-settable): a log is selected by its CONTENT (it holds a scribe_head / scribe_gate stamp) and large logs are
 * read in chunks. Measured 2026-10-10: 63 run logs / 2.8 MB read in ~9 ms. The gate also replays agent ops that drop
 * scope (recheckAgentOps, SV-02/SV-03) next to the owner-op replay (recheckOwnerOps).
 * RECONCILE BINDING (SC-05): a writer-stamped owner_requests_reconciled pins scribe_ledger_sha256 / ledger_bytes /
 * ledger_lines / inbox_lines; it is current only when FINAL, the pinned prefix is intact, no owner prompt or item arrived
 * after it, and the final gate is OK now. A final:false reconciliation is progress-only. */
const ANCHOR_CHUNK_BYTES = 1024 * 1024;
const ANCHOR_MARKERS = ['"scribe_head"', '"scribe_gate"'];
const RUN_DIR_RE = /^[A-Za-z0-9_-]+$/;
/** markedLines(file, markers, onLine) — calls onLine(line) for every complete line holding one of the markers; reads the
 *  file in ANCHOR_CHUNK_BYTES chunks, so a log of any size is scanned with bounded memory (SV-06: never skipped). */
function markedLines(file, markers, onLine) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.alloc(ANCHOR_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      const data = n > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : carry;
      const cut = n > 0 ? data.lastIndexOf(10) : data.length;
      const whole = cut >= 0 ? data.subarray(0, n > 0 ? cut : data.length) : Buffer.alloc(0);
      carry = n > 0 ? (cut >= 0 ? Buffer.from(data.subarray(cut + 1)) : data) : Buffer.alloc(0);
      if (whole.length) {
        const txt = whole.toString('utf8');
        if (markers.some((m) => txt.indexOf(m) >= 0)) for (const line of txt.split('\n')) if (markers.some((m) => line.indexOf(m) >= 0)) onLine(line);
      }
      if (n <= 0) break;
    }
  } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** isPromptRecord(r) — an inbox record that is an owner prompt (not a duplicate link of an earlier one). */
function isPromptRecord(r) { return !!r && typeof r.pid === 'string' && /^P-\d+$/.test(r.pid) && typeof r.text === 'string' && !r.duplicate_of; }
/** snapshotOf(p) — ONE read of the ledger bytes and the inbox: everything a judgement uses comes from these bytes. */
function snapshotOf(p) {
  let lbuf = null;
  try { lbuf = fs.readFileSync(p.ledger); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const ltxt = lbuf ? lbuf.toString('utf8') : '';
  const records = [];
  for (const l of ltxt.split('\n').filter((x) => x.trim())) { try { records.push(JSON.parse(l)); } catch { records.push(null); } }
  return { lbuf, lchain: S.chainOfText(ltxt), records, ix: S.inboxIndex(p) };
}
/** anchorsOf(root) -> [{run_id, seq, event_type, ledger_lines, ledger_head, inbox_lines, inbox_head}] — the writer-stamped
 *  heads in EVERY run event log of the project (Codex R5 SV-06: no window, no mtime or size cut-off; see GATE above). */
function anchorsOf(root) {
  const runsDir = path.join(root, '.claude', 'forge-runs');
  let dirents;
  try { dirents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirents.filter((x) => x.isDirectory() && RUN_DIR_RE.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    markedLines(path.join(runsDir, d.name, 'events.jsonl'), ANCHOR_MARKERS, (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      const fv = e && e._forge_verify;
      let s = null;
      if (e.event_type === 'scribe_head' && fv && fv.scribe_head) s = fv.scribe_head;
      else if (e.event_type === 'owner_requests_reconciled' && fv && fv.scribe_gate && fv.scribe_gate.decision === 'pass') s = fv.scribe_gate;
      if (s) out.push({ run_id: d.name, seq: e.seq, event_type: e.event_type, ledger_lines: s.ledger_lines, ledger_head: s.ledger_head, inbox_lines: s.inbox_lines, inbox_head: s.inbox_head });
    });
  }
  return out;
}
/** checkAnchors(lchain, ichain, anchors) -> [{file, line, reason}] — every anchor's line must still carry its head. */
function checkAnchors(lchain, ichain, anchors) {
  const out = [];
  const one = (file, chain, n, head, a) => {
    if (!Number.isInteger(n) || n <= 0 || typeof head !== 'string') return;
    const who = a.event_type + ' #' + a.seq + ' in run ' + a.run_id;
    if (chain.lines < n) out.push({ file, line: chain.lines, reason: 'the ' + file + ' has ' + chain.lines + ' line(s), fewer than the ' + n + ' that ' + who + ' recorded — truncated' });
    else if (chain.heads[n - 1] !== head) out.push({ file, line: n, reason: file + ' line ' + n + ' differs from the head ' + who + ' recorded — rewritten after it was anchored' });
  };
  for (const a of anchors) {
    one('ledger', lchain, Number(a.ledger_lines), a.ledger_head, a);
    one('inbox', ichain, Number(a.inbox_lines), a.inbox_head, a);
  }
  return out;
}
/** gateOf(c) — see GATE above. c = {root, p, cfg, o:{final, until}}. Read-only. */
function gateOf(c) {
  const snap = snapshotOf(c.p);
  const problems = [];
  if (!snap.lchain.ok) problems.push('the ledger hash chain is broken: ' + JSON.stringify(snap.lchain.breaks.slice(0, 3)));
  if (!snap.ix.chain.ok) problems.push('the inbox hash chain is broken: ' + JSON.stringify(snap.ix.chain.breaks.slice(0, 3)));
  let st = null;
  if (snap.lchain.ok) { try { st = S.foldBuffer(snap.lbuf || Buffer.alloc(0)); } catch (e) { problems.push('the ledger cannot be folded (' + String(e.message).slice(0, 160) + ')'); } }
  if (!st) { st = S.emptyState(); st.counts = {}; }
  const final = !!c.o.final;
  const until = c.o.until ? Date.parse(c.o.until) : null;
  const inWindow = (ts) => !until || Date.parse(ts) <= until;
  const blockOn = final ? S.FINAL_BLOCKING : S.ACTIVE;
  const blocking = Object.values(st.items).filter((i) => blockOn.includes(i.status) && inWindow(i.created))
    .sort((a, b) => a.rid.localeCompare(b.rid)).map((i) => ({ rid: i.rid, status: i.status, class: i.class, title: i.title }));
  const withItem = new Set(Object.values(st.items).map((i) => i.pid).filter(Boolean));
  const orphans = snap.ix.records.filter((r) => isPromptRecord(r) && !withItem.has(r.pid) && inWindow(r.ts));
  for (const r of orphans) blocking.push({ rid: null, pid: r.pid, status: 'orphan', class: 'unclassified', title: 'inbox ' + r.pid + ' never became an item (crash recovery pending): ' + titleOf(r.text, 50) });
  const unauthorized = snap.lchain.ok ? S.recheckOwnerOps(snap.records.filter(Boolean), snap.ix, c.cfg) : [];
  for (const u of unauthorized) blocking.push({ rid: u.rid, status: 'unauthorized-owner-op', class: u.op, title: u.reason });
  const dropped = snap.lchain.ok ? recheckAgentOps(snap.records.filter(Boolean), c.cfg) : [];
  for (const u of dropped) blocking.push({ rid: u.rid, status: u.status, class: u.op, title: u.reason });
  const anchors = anchorsOf(c.root);
  const anchorBreaks = checkAnchors(snap.lchain, snap.ix.chain, anchors);
  for (const b of anchorBreaks) problems.push(b.reason);
  const lbuf = snap.lbuf || Buffer.alloc(0);
  return {
    ok: problems.length === 0 && blocking.length === 0, final, blocking, problems, counts: st.counts,
    orphans: orphans.length, unauthorized: unauthorized.length, dropped_scope: dropped.length, chain_ok: snap.lchain.ok && snap.ix.chain.ok && anchorBreaks.length === 0,
    ledger_head: snap.lchain.head, ledger_lines: snap.lchain.lines, ledger_bytes: lbuf.length, ledger_sha256: S.sha256(lbuf),
    inbox_head: snap.ix.chain.head, inbox_lines: snap.ix.chain.lines, anchors_checked: anchors.length,
  };
}
/** verifyChainsOf(c) — inbox + ledger chains, every anchor in every run log, and (secondary, tamper-evident against a
 *  naive edit only) the cache's own head when the cache's hash checks out. A missing ledger that an anchor or the cache
 *  expects is broken, never "nothing to verify". */
function verifyChainsOf(c) {
  const snap = snapshotOf(c.p);
  const ledger = { ok: true, lines: snap.lchain.lines, head: snap.lchain.head, breaks: snap.lchain.breaks.slice() };
  const inbox = { ok: true, lines: snap.ix.chain.lines, head: snap.ix.chain.head, breaks: snap.ix.chain.breaks.slice() };
  let cache = null;
  try { const s = JSON.parse(fs.readFileSync(c.p.state, 'utf8')); if (s && s.cache_sha256 === S.cacheSha(s)) cache = s; } catch { cache = null; }
  const anchors = anchorsOf(c.root);
  if (!snap.lbuf) {
    if (anchors.some((a) => Number(a.ledger_lines) > 0) || (cache && cache.ledger_head)) ledger.breaks.push({ line: 0, reason: 'the ledger is missing although ' + (cache && cache.ledger_head ? 'the cache' : 'a run event log') + ' recorded a head for it' });
  } else if (cache && cache.ledger_head && Number.isInteger(cache.ledger_offset)) {
    const off = cache.ledger_offset;
    if (snap.lbuf.length < off) ledger.breaks.push({ line: snap.lchain.lines, reason: 'the ledger is shorter than the ' + off + ' bytes the cache covered — truncated' });
    else {
      const prefix = snap.lbuf.subarray(0, off).toString('utf8');
      const k = prefix.split('\n').filter((l) => l.trim()).length;
      if (off > 0 && !prefix.endsWith('\n')) ledger.breaks.push({ line: k, reason: 'the cached byte boundary no longer ends a line — the ledger was edited before it' });
      else if (k > 0 && snap.lchain.heads[k - 1] !== cache.ledger_head) ledger.breaks.push({ line: k, reason: 'line ' + k + ' differs from the cached ledger_head (edited)' });
    }
  }
  for (const b of checkAnchors(snap.lchain, snap.ix.chain, anchors)) (b.file === 'inbox' ? inbox : ledger).breaks.push({ line: b.line, reason: b.reason });
  ledger.ok = ledger.breaks.length === 0;
  inbox.ok = inbox.breaks.length === 0;
  return { ok: ledger.ok && inbox.ok, inbox, ledger, anchors: anchors.length };
}
/** reconcileBindingOf(c, stamp, gateFn) -> {current, stale?, progress_only?, not_applicable?, reason} — see above. */
function reconcileBindingOf(c, stamp, gateFn) {
  const ix = S.inboxIndex(c.p);
  const inUse = fs.existsSync(c.p.ledger) || ix.records.some(isPromptRecord);
  if (!stamp || typeof stamp !== 'object') return { current: false, reason: 'owner_requests_reconciled carries no writer stamp (_forge_verify.scribe_gate)' };
  if (stamp.decision === 'not-applicable') {
    return inUse ? { current: false, stale: true, reason: 'the scribe captured owner requests after this reconciliation (it found the scribe not in use then)' }
      : { current: true, not_applicable: true, reason: 'the scribe is not in use here' };
  }
  if (stamp.decision !== 'pass') return { current: false, reason: 'the reconciliation stamp says ' + JSON.stringify(stamp.decision) };
  if (stamp.final !== true) return { current: false, progress_only: true, reason: 'a progress-only reconciliation (final:false) — completion needs a final one (the default)' };
  if (!Number.isInteger(stamp.ledger_bytes) || !/^[0-9a-f]{64}$/.test(String(stamp.scribe_ledger_sha256 || ''))) return { current: false, reason: 'the reconciliation carries no ledger binding (an older writer) — log owner_requests_reconciled again' };
  let buf;
  try { buf = fs.readFileSync(c.p.ledger); } catch { return { current: false, stale: true, reason: 'the ledger this reconciliation pinned is gone' }; }
  if (buf.length < stamp.ledger_bytes) return { current: false, stale: true, reason: 'the ledger is shorter than the ' + stamp.ledger_bytes + ' bytes pinned at reconciliation — truncated or rewritten' };
  if (S.sha256(buf.subarray(0, stamp.ledger_bytes)) !== stamp.scribe_ledger_sha256) return { current: false, stale: true, reason: 'the pinned ledger prefix changed after the reconciliation — rewritten' };
  let newItems = 0;
  for (const l of buf.subarray(stamp.ledger_bytes).toString('utf8').split('\n').filter((x) => x.trim())) { try { const r = JSON.parse(l); if (r && (r.op === 'open' || r.op === 'reopen')) newItems++; } catch { newItems++; } }
  const newPrompts = Number.isInteger(stamp.inbox_lines) ? ix.records.slice(stamp.inbox_lines).filter(isPromptRecord).length : 0;
  if (newItems || newPrompts) {
    return { current: false, stale: true, new_items: newItems, new_prompts: newPrompts, reason: (newPrompts ? newPrompts + ' owner prompt(s)' : '') + (newPrompts && newItems ? ' and ' : '') + (newItems ? newItems + ' new/reopened item(s)' : '') + ' arrived after the reconciliation — reconcile again (final)' };
  }
  const g = gateFn();
  if (!g.ok) return { current: false, stale: true, reason: 'the final scribe gate is not OK now (' + g.blocking.length + ' item(s)' + (g.problems.length ? '; ' + g.problems[0] : '') + ')' };
  return { current: true, reason: 'final reconciliation of ' + stamp.ledger_lines + ' ledger line(s) is current' };
}

/** gate(opts) — recomputed from the ledger + inbox every time (gateOf above; never the cache).
 *  opts.final also blocks on done-unacked and defer-proposed; opts.until limits items to those created by then. */
function gate(opts) { return gateOf(ctx(opts)); }
/** reconcileBinding(stamp, opts) — is a writer-stamped owner_requests_reconciled still current (SC-05)? */
function reconcileBinding(stamp, opts) {
  const c = ctx(opts);
  return reconcileBindingOf(c, stamp, () => gateOf(Object.assign({}, c, { o: Object.assign({}, c.o, { final: true }) })));
}
function verifyChains(opts) { return verifyChainsOf(ctx(opts)); }

function list(opts) {
  const c = ctx(opts);
  const st = S.loadState(c.p);
  const want = c.o.status ? String(c.o.status).split(',') : null;
  return Object.values(st.items).filter((i) => !want || want.includes(i.status)).sort((a, b) => a.rid.localeCompare(b.rid));
}

function digest(opts) {
  const c = ctx(opts);
  const st = S.loadState(c.p);
  const d = S.buildDigest(st, c.cfg.caps.digest_max_chars);
  if (c.o.write) S.withLock(c.p, () => { S.saveState(c.p, st); S.writeFenced(c.p.digest, d + '\n'); });
  return d;
}

function rebuild(opts) {
  const c = ctx(opts);
  return S.withLock(c.p, () => {
    const st = S.rebuildState(c.p);
    S.saveState(c.p, st);
    S.writeFenced(c.p.digest, S.buildDigest(st, c.cfg.caps.digest_max_chars) + '\n');
    return st;
  });
}

function route(rid, opts) {
  const c = ctx(opts);
  const { it } = getItem(c, rid);
  if (it.class !== 'preference') refuse(rid + ' is not a preference item');
  return 'Ask the owner to confirm, then: node .claude/forge-bin/forge-standing.cjs remember ' + JSON.stringify(it.quote) +
    '\nthen: node .claude/forge-bin/forge-scribe.cjs transition ' + rid + ' done --evidence standing_rule:<new rule id>';
}

// ---------------------------------------------------------------- import

const IMPORT_CLASSES = ['new', 'change'];
const IMPORT_MAX_ITEMS = 500;
/** importLines(items, opts) -> {imported:[{rid, source, title}], skipped:[{index, source, reason}]} — (post-sync
 *  adoption). Seeds the ledger with OPEN work items taken from a project's own existing notes (a resume note, task-
 *  history TODO lines), so a project that predates the scribe keeps its open work visible. These are NOT owner prompts:
 *  nothing is written to the inbox, the item carries no pid (so the Stop hook, which only reminds about prompts of the
 *  current session, never fires for it, and ack/cancel still need a real owner prompt), and the ledger op is
 *  `by: 'import'` with `import_source` ("<file>:<line>"). Idempotent: an item whose (file, scrubbed text) was imported
 *  before is skipped, so a re-run never duplicates. Text is secret-scrubbed exactly like a captured prompt. items:
 *  [{text, source}]; opts.class 'new' (default) or 'change'. The source files themselves are never read or written here. */
function importLines(items, opts) {
  const c = ctx(opts);
  const a = c.o;
  if (!Array.isArray(items)) refuse('import-lines: expects a JSON array of {text, source}');
  if (items.length > IMPORT_MAX_ITEMS) refuse('import-lines: at most ' + IMPORT_MAX_ITEMS + ' items per call (got ' + items.length + ')');
  const cls = a.class || 'new';
  if (!IMPORT_CLASSES.includes(cls)) refuse('import-lines: --class must be ' + IMPORT_CLASSES.join(' or ') + ' (imported notes are work items)');
  const max = Number(c.cfg.caps.max_prompt_chars) || 20000;
  return S.withLock(c.p, () => {
    const seen = new Set(S.readJsonl(c.p.ledger, false).filter((r) => r && r.op === 'open' && r.import_key).map((r) => r.import_key));
    const out = { imported: [], skipped: [] };
    items.forEach((it, index) => {
      const source = it && typeof it.source === 'string' ? it.source.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      if (!it || typeof it.text !== 'string' || !it.text.trim()) { out.skipped.push({ index, source, reason: 'empty text' }); return; }
      if (!source) { out.skipped.push({ index, source, reason: 'a source ("<file>:<line>") is required' }); return; }
      // Codex R5 SV-07: the SAME redact-then-cap pipeline as a captured prompt (normalizePrompt) — never cap first: a
      // secret that crosses the cap would be cut to a prefix the scrubber no longer recognises and stored as is
      const sc = S.normalizePrompt(it.text.trim(), max);
      if (!sc.text.trim()) { out.skipped.push({ index, source, reason: 'empty text after redaction' }); return; }
      const key = S.sha256(source.replace(/:\d+$/, '') + '\n' + sc.text);
      if (seen.has(key)) { out.skipped.push({ index, source, reason: 'already imported' }); return; }
      const rid = 'R-' + pad(S.loadState(c.p).next_rid, 4);
      const title = titleOf(sc.text, c.cfg.caps.title_max_chars);
      writeOp(c, { op: 'open', rid, by: 'import', quote: sc.text, span: [0, sc.text.length], class: cls, title,
        import_key: key, import_source: source, redacted: sc.redacted ? true : undefined, truncated: sc.truncated || undefined, run_id: a.run_id });
      seen.add(key);
      out.imported.push({ rid, source, title });
    });
    return out;
  });
}

module.exports = {
  REPEAT_RULE_TYPES,
  capture, transition, impact, gate, list, digest, rebuild, verifyChains, reconcileBinding, recover, recordSkip, route, importLines,
  ownerCheck, userText: S.userText, anchorsOf, checkAnchors, ScribeError, OPS, EVIDENCE_TYPES, OWNER_GATED_CLASSES, RESERVED_BY,
};

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [], split: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const boolFlags = ['json', 'write', 'final', 'stdin', 'run-active'];
    if (boolFlags.includes(k)) { out[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new ScribeError('missing value for --' + k);
    if (k === 'split') out.split.push(v); else out[k] = v;
  }
  return out;
}
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
function parseEvidence(v) {
  if (!v) return null;
  const i = String(v).indexOf(':');
  return i < 0 ? { type: v, ref: '' } : { type: v.slice(0, i), ref: v.slice(i + 1) };
}

function main(argv) {
  const a = parseArgs(argv);
  const [cmd, rid, extra] = a._;
  const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  const pid = a.prompt || a.pid;
  // SC-07: every command (except the read-only chain check and gate, which count orphans themselves) first re-folds
  // inbox prompts that never became an item. A failure is reported, never fatal here — the gate stays the judge.
  if (cmd && !['verify-chain', 'gate'].includes(cmd)) {
    try { const r = recover(); if (r.length) console.error('forge-scribe: recovered ' + r.length + ' inbox prompt(s) as open item(s): ' + r.map((x) => x.rid + '<-' + x.pid).join(', ')); }
    catch (e) { console.error('forge-scribe: NOTE crash recovery could not run (' + String(e && e.message || e).slice(0, 160) + ')'); }
  }
  switch (cmd) {
    case 'capture': {
      if (a.source && !CLI_SOURCES.includes(a.source)) throw new ScribeError('capture --source must be ' + CLI_SOURCES.join('|') + ' (the hook source is set only by the hook itself)');
      if (a.by && RESERVED_BY.includes(String(a.by).toLowerCase())) throw new ScribeError('--by ' + a.by + ' is reserved');
      const text = a.stdin ? fs.readFileSync(0, 'utf8') : a.text;
      const r = capture(text, { source: a.source || 'cli', session_id: a.session, transcript_path: a.transcript, uuid: a.uuid, prompt_id: a['prompt-id'], run_id: a.run, run_active: !!a['run-active'], by: a.by });
      out(a.json ? r : r.receipt);
      return 0;
    }
    case 'list': {
      const items = list({ status: a.status });
      if (a.json) out(items);
      else items.forEach((i) => { const rp = S.repeatTag(i); console.log(i.rid + ' [' + i.class + '|' + i.status + (i.wp_ids.length ? '|' + i.wp_ids.join(',') : '') + '] ' + (rp ? rp + (i.repeat_rule_ref ? ' (rule: ' + i.repeat_rule_ref.type + ':' + i.repeat_rule_ref.ref + ')' : ' (no HARD RULE linked yet)') + ' ' : '') + i.title); });
      return 0;
    }
    case 'digest': out(digest({ write: !!a.write })); return 0;
    case 'classify': out(transition(rid, 'classify', { class: extra, split: a.split, run_id: a.run, by: a.by, pid, transcript: a.transcript })); return 0;
    case 'link': out(transition(rid, 'link', { wp_ids: csv(a.wp), tickets: csv(a.ticket), run_id: a.run, by: a.by })); return 0;
    case 'transition':
      out(transition(rid, extra, { wp_ids: csv(a.wp), tickets: csv(a.ticket), run_id: a.run, evidence: parseEvidence(a.evidence), ref: parseEvidence(a.ref), pid, transcript: a.transcript, reason: a.reason, supersedes: a.supersedes, class: a.class, by: a.by }));
      return 0;
    case 'impact': out(impact(rid, a.run)); return 0;
    case 'route': out(route(rid)); return 0;
    case 'gate': {
      const r = gate({ final: !!a.final, until: a.until });
      if (a.json) out(r);
      else {
        console.log('forge-scribe gate: ' + (r.ok ? 'OK' : 'BLOCKED') + ' (' + r.blocking.length + ' item(s)' + (r.final ? ', final' : '') + ')');
        r.blocking.forEach((b) => console.log('  ' + (b.rid || b.pid) + ' [' + b.class + '|' + b.status + '] ' + b.title));
        r.problems.forEach((p) => console.log('  ! ' + p));
      }
      return r.ok ? 0 : 3;
    }
    case 'import-lines': {
      const raw = a.stdin ? fs.readFileSync(0, 'utf8') : (a.file ? fs.readFileSync(a.file, 'utf8') : null);
      if (raw == null) throw new ScribeError('import-lines needs --stdin or --file <json> (an array of {text, source})');
      let items;
      try { items = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { throw new ScribeError('import-lines: input is not valid JSON (' + e.message + ')'); }
      const r = importLines(items, { class: a.class, run_id: a.run });
      if (a.json) out(r);
      else {
        console.log('forge-scribe import-lines: ' + r.imported.length + ' imported, ' + r.skipped.length + ' skipped');
        r.imported.forEach((x) => console.log('  ' + x.rid + ' [open] ' + x.title + ' — ' + x.source));
        r.skipped.forEach((x) => console.log('  skipped #' + x.index + (x.source ? ' (' + x.source + ')' : '') + ': ' + x.reason));
      }
      return 0;
    }
    case 'recover': out('recovered: ' + recover().length + ' orphan prompt(s)'); return 0;
    case 'rebuild': { const st = rebuild(); out('rebuilt: ' + Object.keys(st.items).length + ' item(s), last_seq ' + st.last_seq); return 0; }
    case 'verify-chain': {
      const r = verifyChains();
      if (a.json) out(r); else console.log('forge-scribe verify-chain: ' + (r.ok ? 'OK' : 'BROKEN') + ' · inbox ' + r.inbox.lines + ' line(s)' + (r.inbox.ok ? '' : ' BROKEN ' + JSON.stringify(r.inbox.breaks)) + ' · ledger ' + r.ledger.lines + ' line(s)' + (r.ledger.ok ? '' : ' BROKEN ' + JSON.stringify(r.ledger.breaks)) + ' · ' + r.anchors + ' run-log anchor(s)');
      return r.ok ? 0 : 3;
    }
    default:
      console.error('usage: forge-scribe.cjs <capture|list|digest|classify|link|transition|impact|route|gate|import-lines|recover|rebuild|verify-chain> ... (see file header)');
      return 2;
  }
}

if (require.main === module) {
  let code = 2;
  try { code = main(process.argv.slice(2)); } catch (e) {
    console.error('forge-scribe: ' + (e && e.message ? e.message : e));
    code = 2;
  }
  process.exitCode = code;
}
