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
 *     (OWNER REPEATS v2 below, WP 3.8); `transition R-n repeat-rule --ref standing_rule:<id>|decision_logged:<event_id>
 *     [--run id]` links the HARD RULE made for it (checked against real files; status unchanged; not owner-gated because
 *     it removes nothing from the owner's view). Until a chain has that link the digest head and the Stop hook show it.
 *   Applying an owner ack/cancel also answers the owner's own ack/cancel prompt item when it carries nothing else.
 *   toggle-correction (WP I.8c): a TAG, not a status or class — see TOGGLE CORRECTIONS below.
 *   set-aside (WP 3.8): an item whose stored text is system-origin (ORIGIN below: a subagent hand-back or another
 *     harness envelope the hook recorded before WP 3.8) is set aside by `reclassify --system-origin --apply` with a
 *     `supersede` op {by:'scribe', ignored:'system-origin'} — the text is kept, nothing is deleted. The store folds it as
 *     superseded (forge-scribe-store.cjs has no 'ignored' status); the gate replays the origin check on the item's text
 *     (recheckAgentOps), so it can never hide owner text. `reopen` brings such an item back by hand.
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
 *   reclassify --system-origin [--apply] [--json]
 *            (WP 3.8 one-time clean-up: dry run by default; --apply backs up ledger.jsonl + state.json next to them and
 *             sets aside every live item whose text is system-origin; idempotent)
 *   retag --toggle-correction [--apply] [--skip R-n,...] [--json]
 *            (WP I.8c one-time back-fill: dry run by default; re-judges every OWNER record with the toggle-correction
 *             classifier and, with --apply, backs up ledger.jsonl + state.json and appends one `tag` op per hit; --skip
 *             leaves the named ids out; idempotent; see TOGGLE CORRECTIONS below)
 *   rebuild                                   (refold state.json from ledger byte 0)
 *   verify-chain [--json]                     (exit 3 on a broken inbox/ledger chain or a disagreeing run-log anchor)
 * Exit codes: 0 ok · 2 usage/refused transition · 3 gate blocked / chain broken.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./forge-scribe-store.cjs');
const C = require('./forge-scribe-classify.cjs');

// WP 2.1 (opt-in .forge layout): roots and run folders come from forge-paths.cjs (guarded: an older or missing copy keeps
// the legacy literals). FORGE_PROJECT_ROOT keeps first place; an installed copy (<project>/.claude/forge-bin) still acts
// on its own project; a plugin copy discovers the project from CLAUDE_PROJECT_DIR / the cwd and is null outside one.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function viaForgePaths(fn, legacy) { if (forgePaths) { try { return fn(forgePaths); } catch { /* unresolvable root or canon: legacy */ } } return legacy(); }
const DEFAULT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT)
  : viaForgePaths((P) => P.scriptRoot(__dirname), () => path.resolve(__dirname, '..', '..'));
const NO_ROOT = 'no project root found (this copy is not inside a project and neither CLAUDE_PROJECT_DIR nor the current folder names one); run it inside the project or set FORGE_PROJECT_ROOT';
/** runDirsOf(root) -> the run folders that exist, active first (legacy layout: just .claude/forge-runs). */
function runDirsOf(root) {
  return viaForgePaths((P) => P.existingStateDirs(root, 'runs'), () => { const d = path.join(root, '.claude', 'forge-runs'); return fs.existsSync(d) ? [d] : []; });
}
/** runEventsFileOf(root, runId) -> events.jsonl of runId in whichever run folder holds it, else the active folder's path. */
function runEventsFileOf(root, runId) {
  for (const d of runDirsOf(root)) { const f = path.join(d, runId, 'events.jsonl'); if (fs.existsSync(f)) return f; }
  return path.join(viaForgePaths((P) => P.stateDir(root, 'runs'), () => path.join(root, '.claude', 'forge-runs')), runId, 'events.jsonl');
}
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
  if (!root) refuse(NO_ROOT);
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
  S.writeFenced(c.p.digest, digestOfState(next, c.cfg.caps.digest_max_chars, c.cfg, toggleTagIndex(c.p)) + '\n');
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
    const org = originOf(r.text);
    const st0 = S.loadState(c.p);
    const rid = 'R-' + pad(st0.next_rid, 4);
    const an = analysisOf(c, r.text, st0);
    const rp = an.repeat;
    const cl = classifyOwner(r.text, c.cfg, an.pastedQuotes);
    let tc = null; // WP I.8c: owner orphans are tagged like a capture (fail-open: untagged); system-origin ones never
    if (org.origin !== 'system') { try { tc = toggleOfOwner(r.text, c.cfg, an.pastedQuotes); } catch { tc = TC_NONE; } }
    writeOp(c, Object.assign({ op: 'open', rid, by: 'recovery', pid: r.pid, quote: r.text, span: [0, r.text.length], class: cl.class,
      title: titleOf(r.text, c.cfg.caps.title_max_chars), multi_ask: cl.multi_ask || undefined,
      repeat_of: rp ? rp.repeat_of : undefined, repeat_count: rp ? rp.repeat_count : undefined, repeat_why: rp ? rp.why : undefined,
      origin_uncertain: org.uncertain || undefined }, tc ? toggleFields(tc) : {}));
    // WP 3.8: an orphan that is harness text (written before the origin filter) becomes an item only so the gate stops
    // counting it as an orphan, and is set aside at once — the gate replays that decision on the text (recheckAgentOps)
    if (org.origin === 'system') writeOp(c, ignoreOp(rid, org));
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

// ---------------------------------------------------------------- origin filter (WP 3.8)
/* ORIGIN (WP 3.8): the UserPromptSubmit hook also fires for text the harness or another agent puts in the owner's turn —
 * a subagent hand-back (<agent-message from=...> "[Subagent hand-back] ... NOT a message from the user"), a cross-session
 * or teammate message, a system notification. Measured 2026-10-24: 28 of the 57 ledger items since 2026-10-10 were such
 * hand-backs, and their pasted reports made almost every later prompt a "REPEAT". originOf(text) judges the START of the
 * text or a DOMINANT wrapper, never a mere mention:
 *   system            the text starts with a known envelope tag (ENVELOPE_TAGS) that is closed at the end with no owner
 *                     words after it (or is never closed and carries attributes or a harness marker), or with a harness
 *                     notice ("[Subagent hand-back]", "[SYSTEM NOTIFICATION - NOT USER INPUT]"), or closed envelope
 *                     blocks cover >= DOMINANT_SHARE of the text with < DOMINANT_REST_LETTERS letters outside them;
 *   owner + uncertain recorded, but flagged origin_uncertain: owner words after a pasted closing tag, envelope blocks
 *                     covering >= UNCERTAIN_SHARE (or one of UNCERTAIN_BLOCK_CHARS+ covering >= UNCERTAIN_BLOCK_SHARE), an
 *                     unknown hyphenated tag at the start, an unclosed envelope tag without attributes, or a harness
 *                     SENTENCE ("NOT a message from the user", "NOT USER INPUT") in the text — when unsure the scribe
 *                     records (a lost owner message is worse than a noisy one);
 *   owner             everything else, including owner prose that quotes a tag, a short envelope or a notice name
 *                     ("[Subagent hand-back]") in the middle.
 * The hook writes a system-origin prompt to skipped.jsonl (reason 'system-origin', no text) and records nothing else.
 * forge-scribe-classify.cjs machineSkip still runs first and keeps its own reasons (task-notification, tool-result, ...).
 * Pure and bounded: at most ORIGIN_MAX_INPUT chars are looked at, ORIGIN_SCAN_MAX of them for wrappers. */
const ENVELOPE_TAGS = ['agent-message', 'cross-session-message', 'teammate-message', 'task-notification', 'system-reminder',
  'system-notification', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'user-prompt-submit-hook'];
const COMMAND_TAGS = ['command-name', 'command-message', 'command-args'];
const ENVELOPE_BLOCK_SRC = '<(' + ENVELOPE_TAGS.join('|') + ')(?=[\\s>/])[^>]*>[\\s\\S]*?</\\1\\s*>';
const START_NOTICE_RE = /^\[\s*(?:subagent hand-back|system notification\b[^\]\n]*|[^\]\n]{0,60}\bnot user input\b[^\]\n]*)\]/i;
const HARNESS_MARK_RE = /\[\s*subagent hand-back\s*\]|\bnot a message from the user\b/i;
const ORIGIN_MAX_INPUT = 1024 * 1024;
const ORIGIN_SCAN_MAX = 256 * 1024;
const DOMINANT_SHARE = 0.85;
const DOMINANT_REST_LETTERS = 15;
const UNCERTAIN_SHARE = 0.5;          // a pasted envelope block this big makes the origin uncertain ...
const UNCERTAIN_BLOCK_CHARS = 400;    // ... or one of 400+ chars filling >= 30% (a hand-back header alone is ~650 chars)
const UNCERTAIN_BLOCK_SHARE = 0.3;
const QUOTE_MARK_RE = /\bnot a message from the user\b/i; // a harness SENTENCE inside owner text (a bare notice name is a mention)
const OWNER_TAIL_MIN_LETTERS = 3;
const IGNORE_REASON = 'system-origin';
const lettersIn = (s) => (String(s).match(/\p{L}/gu) || []).length;
const withoutEnvelopes = (s) => String(s).replace(new RegExp(ENVELOPE_BLOCK_SRC, 'gi'), '\n');

/** envelopeBlocks(s) -> [{tag, at, end}] — closed known envelope blocks, left to right, non-overlapping. */
function envelopeBlocks(s) {
  const re = new RegExp(ENVELOPE_BLOCK_SRC, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) out.push({ tag: m[1].toLowerCase(), at: m.index, end: m.index + m[0].length });
  return out;
}

/** originOf(text) -> {origin:'owner'|'system', kind, uncertain, reason} — see ORIGIN above. Pure. */
function originOf(text) {
  const raw = String(text == null ? '' : text);
  const s = (raw.length > ORIGIN_MAX_INPUT ? raw.slice(0, ORIGIN_MAX_INPUT) : raw).replace(/^﻿/, '').trimStart();
  const res = (origin, kind, uncertain, reason) => ({ origin, kind: kind || null, uncertain: !!uncertain, reason: reason || null });
  if (!s) return res('owner');
  const head = s.slice(0, 600);
  const tm = /^<([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)(?=[\s>/])([^>\n]*)/i.exec(head);
  if (tm) {
    const tag = tm[1].toLowerCase();
    if (ENVELOPE_TAGS.includes(tag)) {
      const close = '</' + tag + '>';
      const at = s.lastIndexOf(close);
      if (at < 0) {
        return /=/.test(tm[2]) || HARNESS_MARK_RE.test(head)
          ? res('system', tag, false, 'starts with <' + tag + '> (cut off before its closing tag)')
          : res('owner', tag, true, 'starts with an unclosed <' + tag + '> tag');
      }
      const tail = withoutEnvelopes(s.slice(at + close.length, at + close.length + 8000));
      if (lettersIn(tail) >= OWNER_TAIL_MIN_LETTERS) return res('owner', tag, true, 'owner words after a pasted </' + tag + '>');
      return res('system', tag, false, 'wrapped in <' + tag + '>');
    }
    if (!COMMAND_TAGS.includes(tag)) return res('owner', tag, true, 'starts with an unknown <' + tag + '> tag');
  }
  if (START_NOTICE_RE.test(head)) return res('system', 'system-notice', false, 'starts with a harness notice ' + JSON.stringify(head.slice(0, 40)));
  const scan = s.length > ORIGIN_SCAN_MAX ? s.slice(0, ORIGIN_SCAN_MAX) : s;
  const blocks = envelopeBlocks(scan);
  if (blocks.length) {
    let covered = 0, rest = '', last = 0;
    for (const b of blocks) { covered += b.end - b.at; rest += scan.slice(last, b.at) + ' '; last = b.end; }
    rest += scan.slice(last);
    const share = covered / scan.length;
    const pct = Math.round(share * 100) + '% of the text';
    if (share >= DOMINANT_SHARE && lettersIn(rest) < DOMINANT_REST_LETTERS) return res('system', blocks[0].tag, false, 'a <' + blocks[0].tag + '> wrapper fills ' + pct);
    if (share >= UNCERTAIN_SHARE || (covered >= UNCERTAIN_BLOCK_CHARS && share >= UNCERTAIN_BLOCK_SHARE)) return res('owner', blocks[0].tag, true, 'a pasted <' + blocks[0].tag + '> block fills ' + pct);
  }
  if (QUOTE_MARK_RE.test(scan) || /NOT USER INPUT/.test(scan)) return res('owner', null, true, 'quotes a harness sentence');
  return res('owner');
}

/* OWNER WORDS (WP 3.8): what the owner wrote, for repeat scoring, the class and the split counter (the inbox and the
 * ledger keep the full text). Removed: harness envelopes; slash-command wrappers (their <command-args> stay); YAML front
 * matter; a pasted command or skill body — from its "# /cmd" heading (the long '# /forge (global)' body) or its "Base
 * directory for this skill:" line to the end, keeping an "ARGUMENTS:" line and a "... for: **args**" phrase inside it;
 * fenced code; block-quote lines; quotations of QUOTE_MIN_CHARS+ characters; a leading "/command" name. */
const QUOTE_MIN_CHARS = 40;
const BODY_HEAD_RE = /^(?:#{1,3}[ \t]+\/[\w:.-]+|Base directory for this skill:)/m;
/** stripLongQuotes(s) — straight double quotes pair in order (1st-2nd, 3rd-4th, ...) so the prose BETWEEN two short
 *  quotations is never taken for one; smart quotes and guillemets pair by direction. */
function stripLongQuotes(s) {
  const t = s.replace(/“[^”]{40,4000}”|«[^»]{40,4000}»/g, ' ');
  const at = [];
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 34) at.push(i);
  let out = '', last = 0;
  for (let k = 0; k + 1 < at.length; k += 2) if (at[k + 1] - at[k] - 1 >= QUOTE_MIN_CHARS) { out += t.slice(last, at[k]) + ' '; last = at[k + 1] + 1; }
  return out + t.slice(last);
}
/** ownerWords(text) -> the owner's own words (line breaks kept; '' for system-origin text). Pure. */
function ownerWords(text) {
  const raw = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (originOf(raw).origin === 'system') return '';
  let s = withoutEnvelopes(raw);
  s = s.replace(/<command-args>([\s\S]*?)<\/command-args>/gi, '\n$1\n').replace(/<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/gi, '\n');
  s = s.replace(/^\s*---\n(?:[^\n]*\n){0,40}?---[ \t]*(?:\n|$)/, '');
  const bm = BODY_HEAD_RE.exec(s);
  if (bm) {
    const body = s.slice(bm.index);
    const kept = [];
    for (const m of body.matchAll(/^ARGUMENTS:[ \t]*(.+)$/gm)) kept.push(m[1]);
    for (const m of body.matchAll(/\bfor:[ \t]*\*\*([^*\n]{1,2000})\*\*/g)) kept.push(m[1]);
    s = s.slice(0, bm.index) + '\n' + kept.join('\n');
  }
  s = s.replace(/```[^`\n]*```/g, ' ').replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '$1');
  s = s.replace(/^[ \t]*>.*$/gm, '');
  s = stripLongQuotes(s);
  s = s.replace(/^\s*\/[\w:.-]+(?=\s|$)/, '');
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}
/** cutPasted(words, quote) — words minus the first whitespace/punctuation-insensitive copy of quote's owner words. */
function cutPasted(words, quote) {
  const toks = (ownerWords(quote).match(/[\p{L}\p{N}]+/gu) || []).slice(0, 600);
  if (!toks.length) return words;
  const re = new RegExp(toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+'), 'iu');
  return words.replace(re, '\n');
}
/** classifyOwner(text, cfg, pastedQuotes?) — the classifier on the owner's own words (the full text when nothing is
 *  left), so pasted boilerplate, hand-back lines or a re-pasted earlier owner prompt (already its own item) never count
 *  as asks (the 'N asks in one prompt: split' hint). */
function classifyOwner(text, cfg, pastedQuotes) {
  if (originOf(text).origin === 'system') return C.classify('', cfg); // harness text holds no owner ask at all
  let w = ownerWords(text);
  for (const q of (Array.isArray(pastedQuotes) ? pastedQuotes : [])) w = cutPasted(w, q).trim();
  return C.classify(w || text, cfg);
}
/** ignoreOp(rid, origin) — the set-aside ledger op for a system-origin item (see the header 'set-aside'). */
function ignoreOp(rid, org) {
  return { op: 'supersede', rid, by: 'scribe', ignored: IGNORE_REASON, origin_kind: org && org.kind ? String(org.kind).slice(0, 60) : undefined,
    reason: IGNORE_REASON + ': ' + String((org && org.reason) || 'harness text').slice(0, 160) + ' — not an owner prompt (text kept)' };
}
/** isSetAside(item) — set aside as system-origin: folded as superseded (no replacement, reason starts with
 *  'system-origin'), or as 'ignored' once forge-scribe-store.cjs folds the set-aside op to that status itself. */
function isSetAside(it) {
  if (!it) return false;
  if (it.status === 'ignored') return true;
  return it.status === 'superseded' && !it.superseded_by && new RegExp('^' + IGNORE_REASON + '\\b').test(String(it.reason || ''));
}

// ---------------------------------------------------------------- toggle corrections (WP I.8c)
/* TOGGLE CORRECTIONS (intelligence-bar rule 4: "count the owner's turn-it-on / you-forgot corrections per mission"). The
 * classifier (forge-scribe-classify.cjs toggleCorrection) judges the OWNER'S OWN WORDS only: system-origin text never, the
 * owner words (ownerWords: no pasted bodies, fenced code, block quotes, long quotations) minus re-pasted earlier owner
 * prompts, never the raw text as a fallback. Where the tag lives:
 *   ledger   every owner `open` op written by capture / crash recovery carries `tags` — ['toggle-correction'] plus
 *            `toggle_cue` (the cue name and switch word, never owner text) on a hit, [] otherwise (the scribe judged it:
 *            forge-anticipate.cjs `metric` reads a ledger with a tags array as "marked"). Split children, imports and
 *            set-aside items carry none (one owner message counts once). Older records get an append-only `tag` op
 *            {by:'scribe', tags, toggle_cue, run_id (of the item's open op), item_ts (its capture time)} from the one-time
 *            `retag --toggle-correction --apply`; the store folds an unknown op as a no-op, so status/class never change.
 *   view     toggleTagIndex(paths) collects the tagged rids from the ledger (memoised by size + mtime); ownerView /
 *            digestOfState with that index prefix the item title with '[tc]' (a split child shows its parent's mark) in
 *            DIGEST.md, the hook's digest line and `list`; `list --json` items carry tags. Without the index the view is
 *            exactly as before (forge-stop-obligations.cjs calls ownerView(state, cfg)).
 *   receipt  the capture receipt ends with TC_RECEIPT, so the Lead turns the correction into a default, rule or check. */
const TC_TAG = C.TOGGLE_TAG || 'toggle-correction';   // literal fallbacks: a classifier copy older than WP I.8c tags nothing
const TC_MARK = C.TOGGLE_MARK || '[tc]';
const TC_RECEIPT = TC_MARK + ' toggle-correction (make it a default/rule/check)';
const TC_NONE = { tagged: false, tag: null, cue: null, strong: false, switch_word: null, sentence: null };
/** toggleOfOwner(text, cfg, pastedQuotes?) -> the classifier verdict on the owner's own words (never system text). */
function toggleOfOwner(text, cfg, pastedQuotes) {
  if (typeof C.toggleCorrection !== 'function' || originOf(text).origin === 'system') return TC_NONE;
  let w = ownerWords(text); // TC-OWNER-WORDS
  for (const q of (Array.isArray(pastedQuotes) ? pastedQuotes : [])) w = cutPasted(w, q).trim();
  return w ? C.toggleCorrection(w, cfg) : TC_NONE;
}
/** toggleFields(verdict) -> the ledger fields of an owner open op: {tags:[TAG], toggle_cue} on a hit, {tags:[]} otherwise. */
function toggleFields(tc) {
  if (!tc || !tc.tagged) return { tags: [] };
  return { tags: [TC_TAG], toggle_cue: String(tc.cue + (tc.switch_word ? ':' + tc.switch_word : '')).slice(0, 60) };
}
/** isToggleRec(record) — a ledger line that marks its rid as a toggle correction (the forge-anticipate metric's rule). */
const isToggleRec = (r) => !!(r && r.rid && (r.class === TC_TAG || (Array.isArray(r.tags) && r.tags.includes(TC_TAG))));
let tcMemo = { key: null, map: null };
/** toggleTagIndex(p) -> Map rid -> {cue} of every rid a ledger line tags (memoised by size + mtime). Fail-open: empty. */
function toggleTagIndex(p) {
  const empty = new Map();
  try {
    const stat = fs.statSync(p.ledger);
    const key = p.ledger + ':' + stat.size + ':' + stat.mtimeMs;
    if (tcMemo.key === key) return tcMemo.map;
    const txt = fs.readFileSync(p.ledger, 'utf8');
    const map = new Map();
    if (txt.indexOf(TC_TAG) >= 0) {
      for (const line of txt.split('\n')) {
        if (line.indexOf(TC_TAG) < 0) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (isToggleRec(r) && !map.has(r.rid)) map.set(r.rid, { cue: r.toggle_cue || null });
      }
    }
    tcMemo = { key, map };
    return map;
  } catch { return empty; }
}
/** markToggle(state, tags) -> a copy whose tagged items (or children of a tagged parent) show '[tc] ' + title and carry tags. */
function markToggle(state, tags) {
  if (!(tags instanceof Map) || !tags.size || !state || !state.items) return state;
  const out = {};
  for (const [rid, it] of Object.entries(state.items)) {
    const hit = it && (tags.has(rid) || (it.parent && tags.has(it.parent)));
    out[rid] = !hit ? it : Object.assign({}, it, { tags: [TC_TAG], title: String(it.title || '').startsWith(TC_MARK) ? it.title : TC_MARK + ' ' + (it.title || '') });
  }
  return Object.assign({}, state, { items: out });
}

// ---------------------------------------------------------------- owner repeats v2 (WP 3.8; v1 WP-SCRIBE-REPEAT)
/* OWNER REPEATS v2 (WP 3.8). v1 (forge-scribe-classify.cjs findRepeats, still exported there) matched on three
 * shared words, which a long prompt shares with almost anything, and compared hand-backs and pasted boilerplate too: R-0055
 * carried "REPEAT x37" while it repeated nothing. v2:
 *   1. OWNER TEXT ONLY: both sides are owner-origin items (a pid, not system-origin, not cancelled/superseded); a new
 *      prompt may repeat an open or closed ask, never an ack or an answered pure question.
 *   2. OWNER WORDS ONLY: ownerWords() above; a verbatim copy (>= paste_min_chars) of an earlier owner prompt inside the
 *      new one is a quotation too and is cut before scoring (R-0026 pasted R-0025 as the goal of a CLAUDE.md: no repeat).
 *   3. TOKENS: forge-scribe-classify.cjs repeatTokens (stopwords, light stemming, concept groups; config repeat.*).
 *   4. MATCH new N vs earlier E, s = weighted shared tokens (+cue_bonus once a distinctive token is shared and N holds a
 *      repeat cue): >= 1 shared distinctive token, shared >= pair_min_shared (2) before the bonus, weight(N) >=
 *      new_min_weight (2), and dice = 2s/(wN+wE) >= dice_min (0.40) OR cover = s/wN >= cover_min (0.60). The QUIET RULE
 *      for a pure status question (classify repeatStatusQuestion) still holds. v1's "3 shared words" clause is gone.
 *      QUESTION RULE (S-FP2, config repeat.question_rule, default on): a new QUESTION (classifyOwner) vs an
 *      earlier non-question needs dice >= dice_min or a repeat cue; cover alone is not enough. Real false repeats it
 *      removes: "wat is de 3e project wat doet het?" (cover 1.00, dice 0.05) and "welke skills werden bij de
 *      restaurant website gebruikt?" (cover 0.75, dice 0.07). "meer lanes?" (dice 0.80) still repeats.
 *      Thresholds from the real ledger (29 owner prompts, _scratch/baseline/scribe-replay-3.8.txt): the parallel-lane asks
 *      and the "hard rule" complaint score dice 0.50-1.00; the closest non-repeats score dice <= 0.33 and cover <= 0.50
 *      (R-0012 watchdog vs R-0006 0.33/0.20, R-0027 rotator vs R-0025 0.10/0.50, R-0055 vs R-0025 0.19/0.24), and two
 *      short prompts sharing one word ("project") stay under pair_min_shared.
 *   5. REPORT: repeat_of = the <= 3 most similar earlier items (best first), repeat_count = 1 + the earlier items reachable
 *      from all matches through CONFIRMED links, repeat_why = [{rid, overlap %, dice, cover, shared words}].
 * STORED LINKS ARE RE-JUDGED: an item captured before WP 3.8 keeps its ledger line, but the digest, `list` and every chain
 * count use a stored repeat_of link only while this rule confirms it (ownerView) — the old false chains drop out without
 * rewriting a ledger line. */
const ridNum = (r) => parseInt(String(r).replace(/^R-/i, ''), 10) || 0;
const byRid = (a, b) => ridNum(a.rid) - ridNum(b.rid);
const normWords = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
const weightSum = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };
const GONE = ['cancelled', 'superseded', 'ignored'];

function repeatRuleOf(cfg) {
  const r = cfg && cfg.repeat && typeof cfg.repeat === 'object' ? cfg.repeat : {};
  const num = (v, d) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return { enabled: r.enabled !== false, dice: num(r.dice_min, 0.4), cover: num(r.cover_min, 0.6), minShared: num(r.pair_min_shared, 2),
    minWeight: num(r.new_min_weight, 2), pasteMin: num(r.paste_min_chars, 80), cue: num(r.cue_bonus, 1),
    maxCandidates: Math.max(1, num(r.max_candidates, 400)), maxOf: 3, questionRule: r.question_rule !== false };
}

/** repeatModel(items, cfg) — memoised per call: profiles, pair scores, confirmed links, chain sizes. */
function repeatModel(items, cfg) {
  const R = repeatRuleOf(cfg);
  const all = (Array.isArray(items) ? items : Object.values(items || {})).filter((i) => i && i.rid).sort(byRid);
  const byId = new Map(all.map((i) => [i.rid, i]));
  const profs = new Map(), toks = new Map(), links = new Map();
  const complaints = C.repeatConfig(cfg).complaints;
  const profileOfText = (text) => {
    const o = originOf(text);
    const words = o.origin === 'system' ? '' : ownerWords(text);
    return { system: o.origin === 'system', uncertain: o.uncertain, words, norm: normWords(words) };
  };
  const prof = (it) => { if (!profs.has(it.rid)) profs.set(it.rid, profileOfText(it.quote || it.title || '')); return profs.get(it.rid); };
  const tok = (it) => { if (!toks.has(it.rid)) toks.set(it.rid, C.repeatTokens(prof(it).norm, cfg)); return toks.get(it.rid); };
  const member = (it) => !!(it && it.pid && !GONE.includes(it.status) && !prof(it).system);
  const candidate = (it) => member(it) && it.class !== 'ack' && !(it.class === 'question' && it.status === 'answered') && tok(it).size > 0;
  /** cut(norm, earlier) -> {norm, pasted} — verbatim copies of earlier owner prompts are quotations (rule 2). */
  const cut = (norm, earlier) => {
    let n = ' ' + norm + ' ';
    const pasted = [];
    for (const e of earlier) {
      const en = prof(e).norm;
      if (en.length < R.pasteMin) continue;
      const needle = ' ' + en + ' ';
      if (n.includes(needle)) { n = n.split(needle).join(' '); pasted.push(e.rid); }
    }
    return { norm: n.trim(), pasted };
  };
  const complaintIn = (norm) => norm.split(' ').some((w) => complaints.has(w));
  /** score(newSide, it) — newSide = {tok, cue, statusQ, complaint}; -> the pair verdict (rule 4). */
  const score = (ns, it) => {
    const et = tok(it);
    let shared = 0, distinct = 0, w2 = 0;
    const words = [];
    for (const [k, v] of ns.tok) {
      if (!et.has(k)) continue;
      const w = Math.max(v, et.get(k));
      shared += w; words.push(k.replace(/^#/, ''));
      if (C.repeatDistinctive(k, cfg)) distinct++;
      if (k.charAt(0) === '#' && w >= 2) w2++;
    }
    const wN = weightSum(ns.tok), wE = weightSum(et);
    const s = shared + (ns.cue && distinct > 0 ? R.cue : 0);
    const dice = wN + wE > 0 ? Math.min(1, (2 * s) / (wN + wE)) : 0;
    const cover = wN > 0 ? Math.min(1, s / wN) : 0;
    let match = distinct > 0 && shared >= R.minShared && wN >= R.minWeight && (dice >= R.dice || cover >= R.cover);
    if (match && ns.statusQ && it.class !== 'question' && !(w2 > 0 && ns.complaint)) match = false; // QUIET RULE 2
    // QUESTION RULE (S-FP2): a question asks the same thing again only when it is mutually similar (dice), holds a
    // repeat cue, or the earlier item is a question too; a few words of a short question inside a long instruction
    // (cover alone) are no repeat
    if (match && R.questionRule && ns.question && it.class !== 'question' && !ns.cue && dice < R.dice) match = false;
    return { match, dice, cover, overlap: Math.max(dice, cover), shared, words };
  };
  const sideOf = (words, norm, question) => ({ tok: C.repeatTokens(norm, cfg), cue: C.repeatCue(norm, cfg), statusQ: C.repeatStatusQuestion(words, cfg), complaint: complaintIn(norm), question: !!question });
  /** link(a, b) — a stored link a -> b (b earlier): the pair verdict when the rule confirms it, else null. */
  const link = (a, b) => {
    const key = a.rid + '>' + b.rid;
    if (links.has(key)) return links.get(key);
    let v = null;
    if (member(a) && member(b) && ridNum(b.rid) < ridNum(a.rid)) {
      const c0 = cut(prof(a).norm, [b]);
      const sc = score(sideOf(prof(a).words, c0.norm, a.class === 'question'), b);
      v = sc.match ? sc : null;
    }
    links.set(key, v);
    return v;
  };
  const linkedBy = new Map();
  for (const i of all) for (const r of (Array.isArray(i.repeat_of) ? i.repeat_of : [])) { if (!linkedBy.has(r)) linkedBy.set(r, []); linkedBy.get(r).push(i.rid); }
  /** chainSize(startRids, below) — owner items reachable from the start items through confirmed links, all with a rid
   *  number below `below` (Infinity at capture time). */
  const chainSize = (startRids, below) => {
    const lim = Number.isFinite(below) ? below : Infinity;
    const seen = new Set(startRids.filter((r) => byId.has(r) && ridNum(r) < lim));
    const queue = Array.from(seen);
    while (queue.length) {
      const r = queue.pop();
      const it = byId.get(r);
      for (const n of [].concat((it && Array.isArray(it.repeat_of)) ? it.repeat_of : [], linkedBy.get(r) || [])) {
        if (seen.has(n) || ridNum(n) >= lim) continue;
        const other = byId.get(n);
        if (!other) continue;
        const ok = ridNum(n) < ridNum(r) ? link(it, other) : link(other, it);
        if (ok) { seen.add(n); queue.push(n); }
      }
    }
    return seen.size;
  };
  return { R, all, byId, prof, tok, member, candidate, cut, score, sideOf, link, chainSize, profileOfText };
}
/** bySimilarity — best first: overlap, then dice (mutual similarity breaks a tie of two 100% covers: "meer lanes?" is
 *  closer to "kan je niet parallel werken?" than to the long watchdog ask), then the newer item. */
const bySimilarity = (a, b) => b.sc.overlap - a.sc.overlap || b.sc.dice - a.sc.dice || ridNum(b.rid) - ridNum(a.rid);
const whyOf = (rid, sc) => ({ rid, overlap: Math.round(sc.overlap * 100), dice: Math.round(sc.dice * 100) / 100, cover: Math.round(sc.cover * 100) / 100, shared: sc.words.slice(0, 6) });
/** whyText(why) -> 'R-0001 75% (parallel, extra); R-0006 57% (parallel)' — the WHY of a REPEAT line. */
function whyText(why) {
  return (Array.isArray(why) ? why : []).map((w) => w.rid + ' ' + w.overlap + '%' + (w.shared && w.shared.length ? ' (' + w.shared.slice(0, 4).join(', ') + ')' : '')).join('; ');
}

/** ownerAnalysis(text, items, cfg) -> {repeat: null | {repeat_of, repeat_count, why, pasted}, pasted:[rid], pastedQuotes}
 *  — OWNER REPEATS v2 for a NEW prompt against the items that exist now, plus the earlier owner prompts it pastes
 *  verbatim. Pure, bounded (max_candidates newest candidates). */
function ownerAnalysis(text, items, cfg) {
  const none = { repeat: null, pasted: [], pastedQuotes: [] };
  const M = repeatModel(items, cfg);
  if (!M.R.enabled) return none;
  const np = M.profileOfText(text);
  if (np.system || !np.norm) return none;
  const cands = M.all.filter(M.candidate).slice(-M.R.maxCandidates);
  const c0 = M.cut(np.norm, cands);
  const pasted = { pasted: c0.pasted, pastedQuotes: c0.pasted.map((r) => M.byId.get(r).quote || '') };
  let isQ = false;
  try { isQ = classifyOwner(text, cfg, pasted.pastedQuotes).class === 'question'; } catch { isQ = false; }
  const side = M.sideOf(np.words, c0.norm, isQ);
  const hits = [];
  if (side.tok.size) for (const it of cands) { const sc = M.score(side, it); if (sc.match) hits.push({ rid: it.rid, sc }); }
  if (!hits.length) return Object.assign(none, pasted);
  hits.sort(bySimilarity);
  const top = hits.slice(0, M.R.maxOf);
  return Object.assign({ repeat: { repeat_of: top.map((h) => h.rid), repeat_count: 1 + M.chainSize(hits.map((h) => h.rid), Infinity), why: top.map((h) => whyOf(h.rid, h.sc)), pasted: c0.pasted } }, pasted);
}
/** ownerRepeats(text, items, cfg) -> null | {repeat_of, repeat_count, why, pasted} (see ownerAnalysis). */
function ownerRepeats(text, items, cfg) { return ownerAnalysis(text, items, cfg).repeat; }
/** analysisOf(c, text, state) — ownerAnalysis against the ledger's items. Fail-open: an error means "no repeat, nothing
 *  pasted", never a lost prompt. */
function analysisOf(c, text, state) {
  try { return ownerAnalysis(text, Object.values(state.items || {}), c.cfg); } catch { return { repeat: null, pasted: [], pastedQuotes: [] }; }
}
/** ownerView(state, cfg) -> a copy of state whose items show only the repeat links OWNER REPEATS v2 confirms (best <= 3
 *  first, count = 1 + the earlier items reachable through confirmed links); the stored items are never changed. Used for
 *  DIGEST.md, the hook's digest line and `list` (and meant for forge-stop-obligations.cjs). Fail-open: the state as is.
 *  tags (optional, WP I.8c): toggleTagIndex(paths) — tagged items then show the '[tc]' mark (see TOGGLE CORRECTIONS). */
function ownerView(state, cfg, tags) {
  const v = repeatView(state, cfg);
  try { return markToggle(v, tags); } catch { return v; }
}
function repeatView(state, cfg) {
  try {
    const items = state && state.items ? state.items : {};
    if (!Object.values(items).some((i) => i && Array.isArray(i.repeat_of) && i.repeat_of.length)) return state;
    const M = repeatModel(items, cfg);
    const out = {};
    for (const [rid, it] of Object.entries(items)) {
      if (!it || !Array.isArray(it.repeat_of) || !it.repeat_of.length) { out[rid] = it; continue; }
      const conf = [];
      for (const r of it.repeat_of) { const b = items[r]; const sc = b ? M.link(it, b) : null; if (sc) conf.push({ rid: r, sc }); }
      const copy = Object.assign({}, it);
      if (!conf.length) { delete copy.repeat_of; delete copy.repeat_count; }
      else {
        conf.sort(bySimilarity);
        copy.repeat_of = conf.slice(0, M.R.maxOf).map((x) => x.rid);
        copy.repeat_count = 1 + M.chainSize(conf.map((x) => x.rid), ridNum(rid));
      }
      out[rid] = copy;
    }
    return Object.assign({}, state, { items: out });
  } catch { return state; }
}
/** digestOfState(state, cap, cfg, tags?) — the digest text from the owner view (see ownerView; tags = toggleTagIndex). */
function digestOfState(state, cap, cfg, tags) { return S.buildDigest(ownerView(state, cfg, tags), cap); }

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
  // WP 3.8: harness / agent text is not an owner prompt — no inbox record, no item (the hook skips it before this point)
  const org = originOf(nm.text);
  if (org.origin === 'system') refuse('capture: system-origin text (' + org.kind + ': ' + org.reason + ') is not an owner prompt — not recorded');
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
      const st0 = S.loadState(c.p);
      const rid = 'R-' + pad(st0.next_rid, 4);
      const an = analysisOf(c, nm.text, st0);
      const rp = an.repeat;
      // WP 3.8: class and asks from the owner's own words — never pasted boilerplate, hand-back lines or a re-pasted
      // earlier owner prompt (that one is already its own item)
      const cl = classifyOwner(nm.text, c.cfg, an.pastedQuotes);
      // WP I.8c: the toggle-correction TAG on the owner's own words (see TOGGLE CORRECTIONS); fail-open: untagged
      let tc = TC_NONE;
      try { tc = toggleOfOwner(nm.text, c.cfg, an.pastedQuotes); } catch { tc = TC_NONE; }
      const tf = toggleFields(tc);
      const state = writeOp(c, Object.assign({
        op: 'open', rid, by: a.source === 'hook' ? 'hook' : (a.by && !RESERVED_BY.includes(String(a.by).toLowerCase()) ? String(a.by).slice(0, 40) : 'cli'), pid, quote: nm.text, span: [0, nm.text.length], class: cl.class,
        title: titleOf(nm.text, c.cfg.caps.title_max_chars), multi_ask: cl.multi_ask || undefined,
        run_id: a.run_id, impact: a.run_active ? 'pending' : undefined, truncated: nm.truncated || undefined,
        repeat_of: rp ? rp.repeat_of : undefined, repeat_count: rp ? rp.repeat_count : undefined, repeat_why: rp ? rp.why : undefined,
        origin_uncertain: org.uncertain || undefined, origin_reason: org.uncertain ? String(org.reason || '').slice(0, 120) : undefined,
      }, tf));
      const item = state.items[rid];
      const rtag = item ? S.repeatTag(item) : null;
      const why = rp ? whyText(rp.why) : '';
      return Object.assign({ duplicate: false, pid, rid, class: cl.class, multi_ask: cl.multi_ask, asks: cl.asks, redacted: nm.redacted, truncated: nm.truncated,
        tags: tf.tags, toggle_cue: tf.toggle_cue,
        receipt: receipt(state, rid, cl.class) + (rtag ? ' · ' + rtag : '') + (tc.tagged ? ' · ' + TC_RECEIPT : ''),
        repeat_of: item && item.repeat_of ? item.repeat_of : undefined, repeat_count: item && item.repeat_count ? item.repeat_count : undefined,
        repeat_why: rp ? rp.why : undefined,
        repeat_note: rtag ? rtag + (why ? ' — why: ' + why : '') + ' — ' + S.REPEAT_ACTION : undefined,
        origin_uncertain: org.uncertain || undefined, origin_reason: org.uncertain ? org.reason : undefined }, rec0);
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
  const f = runEventsFileOf(c.root, runId);
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
    if (it && r.op === 'supersede' && r.by !== 'owner' && r.ignored === IGNORE_REASON) {
      // WP 3.8 set-aside: valid only while the item's own text is still judged system-origin (never on an agent's word)
      const o = originOf(it.quote);
      if (o.origin !== 'system') flagged.set(r.rid, { rid: r.rid, op: 'supersede', seq: r.seq, status: 'unbacked-set-aside', reason: r.rid + ' was set aside as system-origin, but its text is ' + (o.uncertain ? 'of uncertain origin (' + o.reason + ')' : 'owner text') + ' — reopen ' + r.rid });
    } else if (it && r.op === 'supersede' && r.by !== 'owner') {
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
    // WP 3.8: a set-aside (system-origin) item may always be reopened by hand — reopening only ever adds visibility
    const isFlaggedReopen = op === 'reopen' && (isSetAside(it) || (it.status === 'superseded' && recheckAgentOps(S.readJsonl(c.p.ledger, true), c.cfg).some((x) => x.rid === rid)));
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
  const out = [];
  // WP 2.1: every run folder that exists (the .forge layout may still hold older runs in the legacy folder)
  for (const runsDir of runDirsOf(root)) anchorsIn(runsDir, out);
  return out;
}
function anchorsIn(runsDir, out) {
  let dirents;
  try { dirents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return out; }
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
  const tags = toggleTagIndex(c.p); // WP I.8c: a tagged item carries tags:['toggle-correction'] (stored state unchanged)
  return Object.values(st.items).filter((i) => !want || want.includes(i.status)).sort((a, b) => a.rid.localeCompare(b.rid))
    .map((i) => (tags.has(i.rid) ? Object.assign({}, i, { tags: [TC_TAG] }) : i));
}

function digest(opts) {
  const c = ctx(opts);
  const st = S.loadState(c.p);
  const d = digestOfState(st, c.cfg.caps.digest_max_chars, c.cfg, toggleTagIndex(c.p));
  if (c.o.write) S.withLock(c.p, () => { S.saveState(c.p, st); S.writeFenced(c.p.digest, d + '\n'); });
  return d;
}

function rebuild(opts) {
  const c = ctx(opts);
  return S.withLock(c.p, () => {
    const st = S.rebuildState(c.p);
    S.saveState(c.p, st);
    S.writeFenced(c.p.digest, digestOfState(st, c.cfg.caps.digest_max_chars, c.cfg, toggleTagIndex(c.p)) + '\n');
    return st;
  });
}

// ---------------------------------------------------------------- one-time clean-up (WP 3.8)
/** reclassify(opts) — WP 3.8: every LIVE item (not cancelled/superseded) whose stored text is system-origin (originOf,
 *  certain — never an uncertain one) is set aside with ignoreOp: by 'scribe', text kept, nothing deleted, the gate
 *  replays the origin check. Dry run unless opts.apply; --apply first copies ledger.jsonl and state.json to
 *  <file>.bak-<timestamp> next to them (exclusive create, never overwrites). Idempotent: set-aside items are skipped, and
 *  so is an item reopened by hand after an earlier set-aside (kept). opts.systemOrigin must be true (the only kind).
 *  -> {apply, candidates:[{rid, status, class, kind, reason, title}], applied:[rid], kept:[{rid, why}], backup} */
function reclassify(opts) {
  const c = ctx(opts);
  if (!c.o.systemOrigin) refuse('reclassify: say what to reclassify (--system-origin is the only kind)');
  const empty = { apply: !!c.o.apply, candidates: [], applied: [], kept: [], backup: null };
  if (!fs.existsSync(c.p.ledger)) return empty;
  const scan = () => {
    const st = S.loadState(c.p);
    const setAsideAt = new Map(), reopenAt = new Map();
    for (const r of S.readJsonl(c.p.ledger, false)) {
      if (!r || !r.rid) continue;
      if (r.op === 'supersede' && r.ignored === IGNORE_REASON) setAsideAt.set(r.rid, r.seq);
      if (r.op === 'reopen') reopenAt.set(r.rid, r.seq);
    }
    const candidates = [], kept = [];
    for (const it of Object.values(st.items).sort(byRid)) {
      if (GONE.includes(it.status)) continue; // cancelled, superseded or (a future store's) ignored
      const o = originOf(it.quote);
      if (o.origin !== 'system') continue;
      if (setAsideAt.has(it.rid) && (reopenAt.get(it.rid) || 0) > setAsideAt.get(it.rid)) { kept.push({ rid: it.rid, why: 'reopened by hand after an earlier set-aside' }); continue; }
      candidates.push({ rid: it.rid, status: it.status, class: it.class, kind: o.kind, reason: o.reason, title: titleOf(it.quote, 60) });
    }
    return { candidates, kept };
  };
  if (!c.o.apply) return Object.assign(empty, scan());
  return S.withLock(c.p, () => {
    const s = scan();
    if (!s.candidates.length) return Object.assign(empty, s);
    const stamp = iso(c).replace(/[:.]/g, '-');
    const backup = { ledger: c.p.ledger + '.bak-' + stamp, state: fs.existsSync(c.p.state) ? c.p.state + '.bak-' + stamp : null };
    fs.copyFileSync(c.p.ledger, backup.ledger, fs.constants.COPYFILE_EXCL);
    if (backup.state) fs.copyFileSync(c.p.state, backup.state, fs.constants.COPYFILE_EXCL);
    const applied = [];
    for (const x of s.candidates) { writeOp(c, ignoreOp(x.rid, { kind: x.kind, reason: x.reason })); applied.push(x.rid); }
    return Object.assign(empty, s, { applied, backup });
  }, lockOpts(c));
}

/** retag(opts) — WP I.8c one-time back-fill of the toggle-correction TAG (see TOGGLE CORRECTIONS). Every OWNER record — an
 *  item with a pid, no parent (a split child carries no tag of its own), owner origin, not set aside — is re-judged with
 *  toggleOfOwner (re-pasted earlier owner prompts cut, as at capture). A hit with no tag on the ledger yet becomes a
 *  candidate; opts.skip ([rid]) leaves ids out by hand. Dry run unless opts.apply; --apply first copies ledger.jsonl and
 *  state.json to <file>.bak-<timestamp> (exclusive create, like reclassify) and appends one `tag` op per candidate
 *  {by:'scribe', tags:['toggle-correction'], toggle_cue, run_id of the item's open op, item_ts}. Idempotent (an already
 *  tagged rid is never tagged twice). opts.toggleCorrection must be true (the only kind).
 *  -> {apply, owner_records, candidates:[{rid, class, status, cue, strong, switch_word, run_id, item_ts, title}],
 *      misses:[{rid, class, status, title}], skipped:[{rid, why}], already:[rid], applied:[rid], backup} */
function retag(opts) {
  const c = ctx(opts);
  if (!c.o.toggleCorrection) refuse('retag: say what to retag (--toggle-correction is the only kind)');
  const skip = new Set((Array.isArray(c.o.skip) ? c.o.skip : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean));
  for (const x of skip) if (!/^R-\d+$/.test(x)) refuse('retag: --skip takes item ids like R-0006 (got ' + JSON.stringify(x) + ')');
  const empty = { apply: !!c.o.apply, owner_records: 0, candidates: [], misses: [], skipped: [], already: [], applied: [], backup: null };
  if (!fs.existsSync(c.p.ledger)) return empty;
  const scan = () => {
    const st = S.loadState(c.p);
    const openOf = new Map(), tagged = new Set();
    for (const r of S.readJsonl(c.p.ledger, false)) {
      if (!r || !r.rid) continue;
      if (r.op === 'open' && !openOf.has(r.rid)) openOf.set(r.rid, r);
      if (isToggleRec(r)) tagged.add(r.rid);
    }
    const items = Object.values(st.items).sort(byRid);
    const out = { owner_records: 0, candidates: [], misses: [], skipped: [], already: [] };
    for (const it of items) {
      if (!it.pid || it.parent || isSetAside(it) || originOf(it.quote).origin === 'system') continue;
      out.owner_records++;
      const earlier = items.filter((x) => ridNum(x.rid) < ridNum(it.rid));
      const tc = toggleOfOwner(it.quote, c.cfg, ownerAnalysis(it.quote, earlier, c.cfg).pastedQuotes);
      const title = titleOf(ownerWords(it.quote) || it.quote, 50);
      if (!tc.tagged) { out.misses.push({ rid: it.rid, class: it.class, status: it.status, title }); continue; }
      if (tagged.has(it.rid)) { out.already.push(it.rid); continue; }
      if (skip.has(it.rid)) { out.skipped.push({ rid: it.rid, why: '--skip' }); continue; }
      const op = openOf.get(it.rid);
      out.candidates.push({ rid: it.rid, class: it.class, status: it.status, cue: tc.cue, strong: tc.strong, switch_word: tc.switch_word,
        run_id: op && op.run_id ? op.run_id : null, item_ts: it.created || (op && op.ts) || null, title });
    }
    return out;
  };
  if (!c.o.apply) return Object.assign(empty, scan());
  return S.withLock(c.p, () => {
    const s = scan();
    if (!s.candidates.length) return Object.assign(empty, s);
    const stamp = iso(c).replace(/[:.]/g, '-');
    const backup = { ledger: c.p.ledger + '.bak-' + stamp, state: fs.existsSync(c.p.state) ? c.p.state + '.bak-' + stamp : null };
    fs.copyFileSync(c.p.ledger, backup.ledger, fs.constants.COPYFILE_EXCL);
    if (backup.state) fs.copyFileSync(c.p.state, backup.state, fs.constants.COPYFILE_EXCL);
    const applied = [];
    for (const x of s.candidates) {
      const tf = toggleFields({ tagged: true, cue: x.cue, switch_word: x.switch_word });
      writeOp(c, Object.assign({ op: 'tag', rid: x.rid, by: 'scribe', run_id: x.run_id || undefined, item_ts: x.item_ts || undefined,
        reason: 'retag --toggle-correction (WP I.8c): ' + tf.toggle_cue }, tf));
      applied.push(x.rid);
    }
    return Object.assign(empty, s, { applied, backup });
  }, lockOpts(c));
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
  // WP 3.8: origin filter, owner words, OWNER REPEATS v2, the owner view and the one-time clean-up
  originOf, ownerWords, classifyOwner, ownerAnalysis, ownerRepeats, ownerView, digestOfState, whyText, repeatRuleOf, reclassify, isSetAside, recheckAgentOps,
  ENVELOPE_TAGS, IGNORE_REASON,
  // WP I.8c: toggle corrections (a TAG on owner records) and their one-time back-fill
  toggleOfOwner, toggleFields, toggleTagIndex, markToggle, isToggleRec, retag, TC_RECEIPT,
};

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [], split: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const boolFlags = ['json', 'write', 'final', 'stdin', 'run-active', 'system-origin', 'apply', 'toggle-correction'];
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
      else {
        // WP 3.8: the REPEAT marker comes from the owner view (only links OWNER REPEATS v2 confirms); WP I.8c: '[tc]' too
        const lp = S.paths(DEFAULT_ROOT);
        const view = ownerView(S.loadState(lp), C.loadConfig(), toggleTagIndex(lp)).items || {};
        items.forEach((i0) => {
          const i = view[i0.rid] || i0;
          const rp = S.repeatTag(i);
          console.log(i.rid + ' [' + i.class + '|' + i.status + (isSetAside(i) ? '(' + IGNORE_REASON + ')' : '') + (i.wp_ids.length ? '|' + i.wp_ids.join(',') : '') + '] ' + (rp ? rp + (i.repeat_rule_ref ? ' (rule: ' + i.repeat_rule_ref.type + ':' + i.repeat_rule_ref.ref + ')' : ' (no HARD RULE linked yet)') + ' ' : '') + i.title);
        });
      }
      return 0;
    }
    case 'reclassify': {
      if (!a['system-origin']) throw new ScribeError('reclassify needs --system-origin (the only kind) [--apply] [--json]');
      const r = reclassify({ systemOrigin: true, apply: !!a.apply });
      if (a.json) { out(r); return 0; }
      const n = r.apply ? r.applied.length : r.candidates.length;
      console.log('forge-scribe reclassify --system-origin: ' + n + ' item(s) ' + (r.apply ? 'set aside' : 'would be set aside (dry run; add --apply)') + (r.kept.length ? ' · ' + r.kept.length + ' kept (reopened by hand)' : ''));
      r.candidates.forEach((x) => console.log('  ' + x.rid + ' [' + x.class + '|' + x.status + '] ' + x.kind + ': ' + x.title));
      r.kept.forEach((x) => console.log('  kept ' + x.rid + ': ' + x.why));
      if (r.backup) console.log('  backup: ' + r.backup.ledger + (r.backup.state ? ' + ' + r.backup.state : ''));
      return 0;
    }
    case 'retag': {
      if (!a['toggle-correction']) throw new ScribeError('retag needs --toggle-correction (the only kind) [--apply] [--skip R-n,...] [--json]');
      const r = retag({ toggleCorrection: true, apply: !!a.apply, skip: csv(a.skip) });
      if (a.json) { out(r); return 0; }
      const n = r.apply ? r.applied.length : r.candidates.length;
      console.log('forge-scribe retag --toggle-correction: ' + n + ' of ' + r.owner_records + ' owner record(s) ' + (r.apply ? 'tagged' : 'would be tagged (dry run; add --apply)')
        + (r.already.length ? ' · ' + r.already.length + ' already tagged' : '') + (r.skipped.length ? ' · ' + r.skipped.length + ' skipped' : '') + ' · ' + r.misses.length + ' not a correction');
      r.candidates.forEach((x) => console.log('  ' + x.rid + ' [' + x.class + '|' + x.status + '] ' + x.cue + (x.switch_word ? ' (' + x.switch_word + ')' : '') + ': ' + x.title));
      r.skipped.forEach((x) => console.log('  skipped ' + x.rid + ': ' + x.why));
      if (r.backup) console.log('  backup: ' + r.backup.ledger + (r.backup.state ? ' + ' + r.backup.state : ''));
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
      console.error('usage: forge-scribe.cjs <capture|list|digest|classify|link|transition|impact|route|gate|import-lines|recover|reclassify|retag|rebuild|verify-chain> ... (see file header)');
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
