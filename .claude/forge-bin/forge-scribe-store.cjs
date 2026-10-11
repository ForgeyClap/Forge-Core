#!/usr/bin/env node
'use strict';
/**
 * forge-scribe-store.cjs — storage layer for Forge Scribe. Zero deps.
 * Callers go through forge-scribe.cjs; this module never decides whether a transition is allowed.
 *
 * Layout (<root>/.claude/forge-scribe/, project-local, never synced):
 *   inbox.jsonl   one record per owner prompt, word-for-word except secrets (scrubbed), hash-chained:
 *                 {v,pid,ts,session_id,source,transcript_path,uuid,prompt_id,text,redacted,truncated?,chars?,
 *                  text_sha256,duplicate_of?,prev_sha256}
 *   ledger.jsonl  append-only event log, hash-chained: {v,seq,ts,op,rid,by,pid,quote,span,class,...,prev_sha256}
 *   skipped.jsonl one counter line per prompt the hook judged machine text — NO text (Codex R3 SC-11), hash-chained
 *   state.json    folded from the ledger, a CACHE only: {ledger_offset, ledger_head, last_seq, next_rid, items, counts,
 *                 cache_sha256}. Readers that decide (gate, verify-chain) never trust it (Codex R3 SC-06).
 *   DIGEST.md     <= caps.digest_max_chars, the only thing meant to go back into model context
 *   .lock         the store lock: a FILE {pid, nonce, started_at} (Codex R3 SC-10)
 *
 * Chain rule: prev_sha256 = sha256(previous raw line, no newline); the first line uses 64 zeros. Editing a
 * middle line breaks the next line's link (verifyChain). Editing or truncating the tail is caught by the head
 * anchors forge-scribe.cjs reads from the run event logs (scribe_head / owner_requests_reconciled stamps), and the
 * cache's own ledger_head catches a naive last-line edit.
 *
 * LOCK (Codex R3 SC-10, the same rename-then-verify + owner-nonce pattern as forge-sync's lock): the lock
 * is created with open('wx') and carries {pid, nonce, started_at}. A held lock is reclaimed ONLY when it is older than
 * the stale window AND its pid is provably not running (or it names no readable owner); a live writer's lock is never
 * removed, however old. Since Codex R5 SV-08 the reclaim is serialised by a reclaim mutex and re-reads the lock BEFORE it
 * renames it (see RECLAIM below). Release removes the lock only while it still carries this process's nonce, and every
 * protected write re-checks that (fencing: appendChained and writeFenced — state.json, DIGEST.md, hook-state.json): a
 * writer whose lock was taken over stops instead of forking the chain or overwriting the new holder's state.
 * A legacy pre-R3 DIRECTORY lock (no owner identity) keeps the old age-only rule, once.
 *
 * STATUSES: unclassified, open, planned, in-progress (ACTIVE: the progress gate blocks on these), done (done, not yet
 * acked by the owner), defer-proposed (an agent proposed to carry it over; the FINAL gate blocks until the owner acks
 * the proposal — Codex R3 SC-03), deferred (owner-confirmed carry-over), acked, answered, cancelled, superseded.
 *
 * OWNER AUTHORITY (Codex R3 SC-01/SC-02/SC-03, section at the end of this file; used by forge-scribe.cjs). An agent must
 * not be able to make an owner request disappear or declare it accepted. Every act that removes an item from the owner's
 * view — ack, cancel, a confirmed defer, a reclassification to question/ack/preference, a supersede without a live
 * replacement — needs ownerAuthority():
 *   1. ORIGIN: the prompt P-n is a record of the HASH-CHAINED inbox (the chain must verify) that the UserPromptSubmit hook
 *      captured: source 'hook', a session id and a prompt id. A missing prompt id never passes.
 *   2. TRANSCRIPT: the record's transcript must resolve (realpath: a junction or symlink cannot point out) INSIDE
 *      ~/.claude/projects/<slug of THIS project>/ — the user profile from the OS account (os.userInfo), never from an
 *      environment variable — and hold a real typed user message with promptId == the record's prompt id, the same
 *      session id and the same text (after the redact-then-cap pipeline capture used) — or a human queued_command the
 *      running turn of that prompt id absorbed — whose delivery lies within owner_check.transcript_match_skew_sec of the
 *      capture; of several identical ones the CLOSEST wins, never simply the oldest (WP-ACK-TEXT). An optional second transcript
 *      (CLI --transcript) is extra corroboration under the same rules, never a replacement.
 *   3. AFFIRMATIVE ACT: forge-scribe-classify.cjs authorizes() — a sentence naming R-n (or a batch phrase) that the
 *      classifier itself reads as the intent, without a negation; ambiguous never authorises.
 *   4. FRESHNESS: the prompt was captured, and said per its transcript timestamp, AFTER the state it approves existed (an
 *      ack after done or after the defer proposal, a cancel after the item was created).
 * recheckOwnerOps() re-runs 1, 3 and 4 over every by:'owner' ledger op for the gate (transcripts may be pruned later, so
 * they are not re-read there). LIMIT (same-actor model, CODEX-R2-completion-proof.md class B): an actor who can write the
 * project AND the user profile could forge the inbox record, a transcript and the chains together; this raises the bar
 * to forging all of them consistently, it does not make it impossible. TEST SEAM (library only): opts.claudeProjectsRoot.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./forge-store.cjs');
const scrub = require('./forge-secret-scrub.cjs');
const C = require('./forge-scribe-classify.cjs');

const GENESIS = '0'.repeat(64);
const ACTIVE = ['unclassified', 'open', 'planned', 'in-progress'];
const FINAL_BLOCKING = ACTIVE.concat(['done', 'defer-proposed']);
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 3000;
const TAIL_WINDOW = 64 * 1024;

const sha256 = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

function paths(root) {
  const dir = path.join(root, '.claude', 'forge-scribe');
  return {
    dir,
    inbox: path.join(dir, 'inbox.jsonl'),
    ledger: path.join(dir, 'ledger.jsonl'),
    skipped: path.join(dir, 'skipped.jsonl'),
    state: path.join(dir, 'state.json'),
    digest: path.join(dir, 'DIGEST.md'),
    lock: path.join(dir, '.lock'),
  };
}

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } }

// ---------------------------------------------------------------- lock (SC-10)

const HELD = new Map(); // lock path -> nonce held by THIS process (re-entrancy + fencing)
/** pidAlive(pid) -> true | false | null. Signal 0 only asks whether the process exists; it never stops anything. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM' ? true : (e && e.code === 'ESRCH' ? false : null); }
}
function readLock(lp) {
  let raw = null, info = null;
  try { raw = fs.readFileSync(lp, 'utf8'); } catch { raw = null; }
  try { info = raw == null ? null : JSON.parse(raw); } catch { info = null; }
  return { raw, info };
}
/* RECLAIM (Codex R5 SV-08). The R3 reclaim renamed the lock it had judged stale WITHOUT re-checking it, so a
 * second reclaimer plus a new acquirer in between made it rename a LIVE replacement lock away, and a third acquirer then
 * blocked the put-back: the live owner's lock was stranded under a claim name. Now:
 *   1. SERIALISED: a reclaim runs only while holding the reclaim mutex <lock>.reclaim (created with open('wx'), carrying
 *      {pid, nonce, started_at}); a live reclaimer's mutex is never taken, a dead one's is taken by the same
 *      identity-checked take below.
 *   2. IDENTITY BEFORE RENAME: under the mutex the lock is re-read and must be byte-identical to the one judged stale
 *      (dead pid, older than the stale window); anything else — released, reclaimed, replaced — is left untouched. While
 *      the mutex is held only that dead owner's lock can sit there, so the rename takes exactly it.
 *   3. PUT-BACK as a last resort: if the claimed file still differs, it is linked back for a bounded time, and
 *   4. NO REPLACEMENT DURING A RECLAIM: an acquirer that created the lock while another process's live reclaim mutex
 *      exists withdraws its own fresh lock and retries, so a put-back is never blocked by a newcomer.
 * 5. Every protected write is FENCED (appendChained, writeFenced): a writer whose lock was nevertheless displaced stops.
 * LIMIT: the stale mutex of a crashed reclaimer is itself taken by check-then-rename; a race there needs a crashed
 * reclaimer AND three concurrent reclaimers, and even then (5) stops the displaced writer before it writes. */
const RECLAIM_MUTEX_SUFFIX = '.reclaim';
const RESTORE_WAIT_MS = 500;
/** holderOf(file, staleMs, opts) -> {state:'none'|'live'|'stale'|'stale-dir', raw, info} — never removes anything. */
function holderOf(file, staleMs, opts) {
  let st;
  try { st = fs.lstatSync(file); } catch { return { state: 'none' }; }
  if (st.isDirectory()) return { state: Date.now() - st.mtimeMs > staleMs ? 'stale-dir' : 'live' };
  const { raw, info } = readLock(file);
  const ownerReadable = !!(info && Number.isInteger(info.pid) && info.pid > 0);
  const started = info ? Date.parse(info.started_at || '') : NaN;
  const ageMs = Number.isFinite(started) ? Date.now() - started : Date.now() - st.mtimeMs;
  if (ageMs <= staleMs) return { state: 'live', raw, info };
  if (ownerReadable && ((opts && opts.pidAlive) || pidAlive)(info.pid) !== false) return { state: 'live', raw, info }; // alive or unknowable
  return { state: 'stale', raw, info };
}
/** restoreClaim(claim, file) — link the claimed file back (bounded retry while a newcomer withdraws). -> true when back. */
function restoreClaim(claim, file) {
  const until = Date.now() + RESTORE_WAIT_MS;
  for (;;) {
    try { fs.linkSync(claim, file); try { fs.rmSync(claim, { force: true }); } catch { /* the link is back */ } return true; } catch (e) {
      if (!e || e.code !== 'EEXIST' || Date.now() > until) return false; // left at the claim name: visible, never silently lost
      sleepMs(10);
    }
  }
}
/** takeIfUnchanged(file, raw) — rename the file to a private claim and delete it only when it still holds exactly `raw`;
 *  otherwise it is put back. -> true when the judged file was removed. */
function takeIfUnchanged(file, raw) {
  const claim = file + '.claim-' + crypto.randomBytes(6).toString('hex');
  try { fs.renameSync(file, claim); } catch { return false; }
  let got = null;
  try { got = fs.readFileSync(claim, 'utf8'); } catch { got = null; }
  if (got !== null && got === raw) { try { fs.rmSync(claim, { force: true }); } catch { /* best effort */ } return true; }
  restoreClaim(claim, file);
  return false;
}
function createExclusive(file, body) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
}
/** reclaimMutex(lp, staleMs, opts) -> {mp, nonce} | null — RECLAIM step 1. */
function reclaimMutex(lp, staleMs, opts) {
  const mp = lp + RECLAIM_MUTEX_SUFFIX;
  const nonce = crypto.randomBytes(12).toString('hex');
  const body = JSON.stringify({ pid: process.pid, nonce, started_at: new Date().toISOString() });
  try { createExclusive(mp, body); return { mp, nonce }; } catch (e) { if (!e || e.code !== 'EEXIST') return null; }
  const h = holderOf(mp, staleMs, opts);
  if (h.state !== 'stale' || !takeIfUnchanged(mp, h.raw)) return null; // a live reclaimer is at work: not this round
  try { createExclusive(mp, body); return { mp, nonce }; } catch { return null; }
}
function releaseReclaimMutex(m) {
  if (!m) return;
  const { info } = readLock(m.mp);
  if (info && info.nonce === m.nonce && info.pid === process.pid) { try { fs.rmSync(m.mp, { force: true }); } catch { /* gone */ } }
}
/** tryReclaim(lp, staleMs, opts) — see RECLAIM. Never removes a live or unknowable owner's lock, never one it did not
 *  re-read under the reclaim mutex. */
function tryReclaim(lp, staleMs, opts) {
  const h = holderOf(lp, staleMs, opts);
  if (h.state === 'stale-dir') { try { fs.rmdirSync(lp); } catch { /* raced or not empty */ } return; } // legacy pre-R3 directory lock
  if (h.state !== 'stale') return;
  const m = reclaimMutex(lp, staleMs, opts);
  if (!m) return;
  try {
    if (readLock(lp).raw !== h.raw) return; // released, reclaimed or REPLACED since it was judged: never touched
    takeIfUnchanged(lp, h.raw);
  } finally { releaseReclaimMutex(m); }
}
/** reclaimInProgress(lp, staleMs, opts) — another LIVE process holds the reclaim mutex (RECLAIM step 4). A crashed
 *  reclaimer's mutex (dead pid) never makes an acquirer wait; one still being written (no readable owner) counts by age. */
function reclaimInProgress(lp, staleMs, opts) {
  const mp = lp + RECLAIM_MUTEX_SUFFIX;
  const { raw, info } = readLock(mp);
  if (raw === null) return false;
  if (!info || !Number.isInteger(info.pid) || info.pid <= 0) return holderOf(mp, staleMs, opts).state === 'live';
  if (info.pid === process.pid) return false;
  return ((opts && opts.pidAlive) || pidAlive)(info.pid) !== false;
}
function acquireLock(p, opts) {
  opts = opts || {};
  fs.mkdirSync(p.dir, { recursive: true });
  const lp = p.lock;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : LOCK_STALE_MS;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : LOCK_WAIT_MS;
  const nonce = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      createExclusive(lp, JSON.stringify({ pid: process.pid, nonce, started_at: new Date().toISOString() }));
      if (reclaimInProgress(lp, staleMs, opts)) { // never a replacement during someone's reclaim: withdraw, retry
        if (stillHeld(lp, nonce)) { try { fs.rmSync(lp, { force: true }); } catch { /* gone */ } }
        if (Date.now() > deadline) throw Object.assign(new Error('forge-scribe: store is locked (' + lp + ', a reclaim is in progress)'), { code: 'SCRIBE_LOCKED' });
        sleepMs(15);
        continue;
      }
      HELD.set(lp, nonce);
      return { lp, nonce };
    } catch (e) {
      if (e && e.code === 'SCRIBE_LOCKED') throw e;
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EISDIR'].includes(e.code)) throw e;
      if (e.code === 'EEXIST' || e.code === 'EISDIR') tryReclaim(lp, staleMs, opts);
      if (Date.now() > deadline) throw new Error('forge-scribe: store is locked (' + lp + ')');
      sleepMs(15);
    }
  }
}
function stillHeld(lp, nonce) {
  const { info } = readLock(lp);
  return !!(info && info.nonce === nonce && info.pid === process.pid);
}
function releaseLock(lock) {
  HELD.delete(lock.lp);
  if (!stillHeld(lock.lp, lock.nonce)) return false; // not ours any more: left in place
  try { fs.rmSync(lock.lp, { force: true }); } catch { /* already gone */ }
  return true;
}
/** withLock(p, fn, opts?) — runs fn under the store lock. Re-entrant within one process. opts.waitMs / opts.staleMs /
 *  opts.pidAlive are bounds and test seams. */
function withLock(p, fn, opts) {
  if (HELD.has(p.lock)) return fn();
  const lock = acquireLock(p, opts);
  try { return fn(); } finally { releaseLock(lock); }
}
/** assertLockHeld(file) — fencing: when this process holds the lock of the file's store, it must still be ours. */
function assertLockHeld(file) {
  const lp = path.join(path.dirname(file), '.lock');
  if (!HELD.has(lp)) return;
  if (!stillHeld(lp, HELD.get(lp))) throw new Error('forge-scribe: the store lock was lost (taken over) — refusing to write ' + path.basename(file) + ' (fencing)');
}
/** writeFenced(file, data) — Codex R5 SV-08: EVERY protected store write (state.json, DIGEST.md, hook-state.json) is
 *  fenced like a chained append: the lock must still carry this process's nonce right before the write, and the file is
 *  replaced atomically (temp + rename). A writer whose lock was taken over stops instead of overwriting the new holder's
 *  state. Limit: the check and the rename are two steps (a fencing check, not a kernel-enforced token). */
function writeFenced(file, data) {
  assertLockHeld(file);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, data, 'utf8');
  try { assertLockHeld(file); fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
}

// ---------------------------------------------------------------- redaction (SC-09)

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
/** redactPem(s) — every private-key block that the full-block pass left behind (no END within reach: cut at a cap, or
 *  longer than that pass scans) is redacted from its BEGIN marker to its END marker or, unterminated, to the end. */
function redactPem(s) {
  let out = s;
  for (let guard = 0; guard < 1000; guard++) {
    const b = PEM_BEGIN_RE.exec(out);
    if (!b) break;
    const after = out.slice(b.index + b[0].length);
    const e = PEM_END_RE.exec(after);
    const end = e ? b.index + b[0].length + e.index + e[0].length : out.length;
    out = out.slice(0, b.index) + '***REDACTED-PRIVATE-KEY***' + out.slice(end);
  }
  return out;
}
/** Secret scrub: forge-store.redactText, a private-key pass, then any line forge-secret-scrub still flags is replaced
 *  whole. Always on the FULL text — callers cap afterwards (normalizePrompt). */
function scrubText(text) {
  const raw = String(text == null ? '' : text);
  let out = redactPem(store.redactText(raw));
  const hits = scrub.scanText(out, 'prompt');
  if (hits.length) {
    const bad = new Set(hits.map((h) => h.line));
    out = out.split(/\r?\n/).map((l, i) => (bad.has(i + 1) ? '***REDACTED-LINE***' : l)).join('\n');
  }
  return { text: out, redacted: out !== raw };
}
/** normalizePrompt(raw, max) — redact the FULL text first, then cap it (Codex R3 SC-09: a secret cut at the cap must be
 *  redacted in full). -> {text, redacted, truncated, chars}. The one pipeline capture and the owner check share. */
function normalizePrompt(raw, max) {
  const full = String(raw == null ? '' : raw);
  const sc = scrubText(full);
  const cap = Number(max) > 0 ? Number(max) : 20000;
  const truncated = sc.text.length > cap;
  return { text: truncated ? sc.text.slice(0, cap) : sc.text, redacted: sc.redacted, truncated, chars: full.length };
}
/** scrubMeta(v, max) — a metadata string (session id, path, id, free-text reason) through the same redactor, then
 *  capped; null for empty/absent. */
function scrubMeta(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (!s.trim()) return null;
  return scrubText(s.slice(0, 64 * 1024)).text.slice(0, Number(max) > 0 ? Number(max) : 1024);
}

// ---------------------------------------------------------------- jsonl + chain

function lastLine(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : null;
}
/** tailLine(file, size) — the last non-empty line, reading only the tail window when that suffices. */
function tailLine(file, size) {
  if (!size) return null;
  if (size > TAIL_WINDOW) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(TAIL_WINDOW);
      fs.readSync(fd, buf, 0, TAIL_WINDOW, size - TAIL_WINDOW);
      const parts = buf.toString('utf8').split('\n');
      const lines = parts.slice(1).filter((l) => l.trim()); // parts[0] may be a partial line
      if (lines.length) return lines[lines.length - 1];
    } finally { fs.closeSync(fd); }
  }
  return lastLine(file);
}

/** Append one chained record. Caller holds the lock (fencing re-checks it). Returns { record, line }. */
function appendChained(file, rec) {
  assertLockHeld(file);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  const prev = tailLine(file, size); // R5 SV-09: only the tail window is read (the whole file only for a >64 KB last line)
  const full = Object.assign({}, rec, { prev_sha256: prev ? sha256(prev) : GENESIS });
  const line = JSON.stringify(full);
  fs.appendFileSync(file, line + '\n', 'utf8');
  return { record: full, line };
}

/** Read a jsonl file. strict=true throws on a corrupt line (ledger: fail closed); else it is skipped. */
function readJsonl(file, strict) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { out.push(JSON.parse(lines[i])); } catch (e) {
      if (strict) throw new Error('forge-scribe: corrupt line ' + (i + 1) + ' in ' + file);
    }
  }
  return out;
}

/** chainOfText(text, expectedHead) -> {ok, lines (count), head, heads[], breaks}. heads[i] = sha256 of line i+1. */
function chainOfText(text, expectedHead) {
  const lines = String(text).split('\n').filter((l) => l.trim());
  const breaks = [];
  const heads = [];
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let rec = null;
    try { rec = JSON.parse(lines[i]); } catch { breaks.push({ line: i + 1, reason: 'unparseable' }); }
    if (rec && rec.prev_sha256 !== prev) breaks.push({ line: i + 1, reason: 'prev_sha256 mismatch' });
    prev = sha256(lines[i]);
    heads.push(prev);
  }
  const head = lines.length ? prev : null;
  if (expectedHead && head !== expectedHead) breaks.push({ line: lines.length, reason: 'head differs from the cached ledger_head (last line edited or file truncated)' });
  return { ok: breaks.length === 0, lines: lines.length, head, heads, breaks };
}
/** Verify a hash chain. expectedHead (optional) = sha256 of the last line. */
function verifyChain(file, expectedHead) {
  if (!fs.existsSync(file)) return { ok: true, lines: 0, head: null, breaks: [] };
  const r = chainOfText(fs.readFileSync(file, 'utf8'), expectedHead);
  return { ok: r.ok, lines: r.lines, head: r.head, breaks: r.breaks };
}

// ---------------------------------------------------------------- fold (ledger -> state)

function emptyState() {
  return { v: 2, ledger_offset: 0, ledger_head: null, last_seq: 0, next_rid: 1, items: {}, counts: {}, updated: null };
}

const uniq = (a) => Array.from(new Set(a.filter(Boolean)));

function applyOp(state, rec) {
  const it = state.items[rec.rid];
  const touch = (o) => { o.updated = rec.ts; return o; };
  if (rec.op === 'open') {
    state.items[rec.rid] = touch({
      rid: rec.rid, status: rec.class === 'unclassified' ? 'unclassified' : 'open', class: rec.class,
      title: rec.title || '', quote: rec.quote || '', span: rec.span || null, pid: rec.pid || null,
      parent: rec.parent || null, wp_ids: [], run_ids: rec.run_id ? [rec.run_id] : [], tickets: [],
      evidence: null, acked_by_pid: null, route: rec.class === 'preference' ? 'forge-remember' : null,
      multi_ask: !!rec.multi_ask, impact: rec.impact || null, reason: null, created: rec.ts, done_at: null,
    });
    // an item seeded by `import-lines` from the project's own notes has no owner prompt (pid); keep where it came from
    if (rec.by === 'import' && rec.import_source) state.items[rec.rid].imported_from = String(rec.import_source);
    if (rec.by === 'recovery') state.items[rec.rid].recovered = true;
    // WP-SCRIBE-REPEAT: this owner prompt repeats earlier asks (forge-scribe-classify.cjs findRepeats, set at capture)
    if (Array.isArray(rec.repeat_of) && rec.repeat_of.length) {
      state.items[rec.rid].repeat_of = rec.repeat_of.map(String).slice(0, 50);
      state.items[rec.rid].repeat_count = Number(rec.repeat_count) > 1 ? Number(rec.repeat_count) : 2;
    }
    const n = parseInt(String(rec.rid).slice(2), 10);
    if (n >= state.next_rid) state.next_rid = n + 1;
    return;
  }
  if (!it) return; // an op for an unknown rid cannot change state (forge-scribe.cjs refuses to write one)
  switch (rec.op) {
    case 'classify': it.status = it.status === 'unclassified' ? 'open' : it.status; it.class = rec.class; it.route = rec.class === 'preference' ? 'forge-remember' : null; break;
    case 'split': it.status = 'superseded'; it.reason = 'split into ' + (rec.children || []).join(','); break;
    case 'link': case 'plan':
      it.status = 'planned'; it.wp_ids = uniq(it.wp_ids.concat(rec.wp_ids || []));
      it.tickets = uniq(it.tickets.concat(rec.tickets || [])); it.run_ids = uniq(it.run_ids.concat(rec.run_id ? [rec.run_id] : []));
      it.impact = null; break;
    case 'start': it.status = 'in-progress'; break;
    case 'done': it.status = 'done'; it.evidence = rec.evidence || null; it.done_at = rec.ts; break;
    case 'ack': // SC-03: the owner's ack of a defer proposal confirms the carry-over; otherwise it accepts done work
      if (it.status === 'defer-proposed') { it.status = 'deferred'; it.deferred_by_pid = rec.pid || null; }
      else { it.status = 'acked'; it.acked_by_pid = rec.pid || null; }
      break;
    case 'reopen': it.status = 'open'; it.evidence = null; it.done_at = null; it.reason = rec.reason || null; break;
    case 'supersede': it.status = 'superseded'; it.superseded_by = rec.supersedes || null; it.reason = rec.reason || ('superseded by ' + (rec.supersedes || '?')); break;
    case 'cancel': it.status = 'cancelled'; it.reason = rec.reason || null; break;
    case 'defer': // SC-03: an agent's defer is a PROPOSAL; only an owner-authorised defer is a carry-over
      if (rec.by === 'owner') { it.status = 'deferred'; it.deferred_by_pid = rec.pid || null; }
      else { it.status = 'defer-proposed'; it.defer_proposed_at = rec.ts; }
      it.reason = rec.reason || null; break;
    case 'answer': it.status = 'answered'; it.reason = rec.reason || null; break;
    // WP-SCRIBE-REPEAT: links the HARD RULE made for a repeated ask; the status does not change
    case 'repeat-rule': it.repeat_rule_ref = rec.repeat_rule_ref || null; break;
    default: return;
  }
  touch(it);
}

function recount(state) {
  const counts = {};
  for (const it of Object.values(state.items)) counts[it.status] = (counts[it.status] || 0) + 1;
  counts.done_unacked = counts.done || 0;
  counts.defer_proposed = counts['defer-proposed'] || 0;
  state.counts = counts;
}

function foldLines(state, lines) {
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (state.ledger_head && rec.prev_sha256 !== state.ledger_head) throw new Error('forge-scribe: ledger chain break at seq ' + rec.seq);
    if (!state.ledger_head && rec.prev_sha256 !== GENESIS) throw new Error('forge-scribe: ledger chain break at seq ' + rec.seq);
    if (rec.seq > state.last_seq) { applyOp(state, rec); state.last_seq = rec.seq; }
    state.ledger_head = sha256(line);
  }
}

/** foldBuffer(buf) — a full fold of exactly these ledger bytes (throws on a chain break or a corrupt line). */
function foldBuffer(buf) {
  const state = emptyState();
  foldLines(state, buf.toString('utf8').split('\n').filter((l) => l.trim()));
  state.ledger_offset = buf.length;
  recount(state);
  return state;
}

/** Full rebuild from byte 0. */
function rebuildState(p) {
  if (!fs.existsSync(p.ledger)) { const s = emptyState(); recount(s); return s; }
  return foldBuffer(fs.readFileSync(p.ledger));
}

/** cacheSha(state) — the cache's own content hash: a hand-edit of state.json that does not recompute it is a rebuild. */
function cacheSha(st) {
  return sha256(JSON.stringify({ v: st.v, o: st.ledger_offset, h: st.ledger_head, s: st.last_seq, n: st.next_rid, items: st.items, counts: st.counts }));
}

/** loadState(p) — the CACHED view (hook, digest, list). Incremental: only the bytes after state.ledger_offset are read.
 *  The cache is used only when its own hash checks out and, with no new bytes, its ledger_head still equals the last
 *  ledger line; otherwise it is rebuilt from the ledger. gate() and verify-chain never use this (Codex R3 SC-06). */
function loadState(p) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(p.state, 'utf8')); } catch { st = null; }
  if (!st || typeof st.ledger_offset !== 'number' || !st.items || st.cache_sha256 !== cacheSha(st)) return rebuildState(p);
  const size = fs.existsSync(p.ledger) ? fs.statSync(p.ledger).size : 0;
  if (size < st.ledger_offset) return rebuildState(p);
  if (size === st.ledger_offset) {
    const last = tailLine(p.ledger, size);
    return (last ? sha256(last) : null) === (st.ledger_head || null) ? st : rebuildState(p);
  }
  const fd = fs.openSync(p.ledger, 'r');
  try {
    const tail = Buffer.alloc(size - st.ledger_offset);
    fs.readSync(fd, tail, 0, tail.length, st.ledger_offset);
    const lines = tail.toString('utf8').split('\n').filter((l) => l.trim());
    try { foldLines(st, lines); } catch { return rebuildState(p); }
    st.ledger_offset = size;
    recount(st);
    return st;
  } finally { fs.closeSync(fd); }
}

function saveState(p, state) {
  state.updated = new Date().toISOString();
  state.cache_sha256 = cacheSha(state);
  writeFenced(p.state, JSON.stringify(state, null, 1)); // R5 SV-08: fenced like every protected write
}

// ---------------------------------------------------------------- digest

function fmtDate(ts) { const d = new Date(ts); return isNaN(d) ? '' : String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

// ---------------------------------------------------------------- owner repeats (WP-SCRIBE-REPEAT)
/* An item with repeat_of is an owner ask the owner had to make AGAIN. It stays a visible obligation (digest head, the
 * Stop hook line) until its chain — the items connected through repeat_of — carries a HARD RULE link: a
 * `repeat-rule` op (repeat_rule_ref standing_rule:<id> | decision_logged:<event_id>, validated in forge-scribe.cjs), or
 * a preference item closed with standing_rule evidence. Never blocking; cancelled/superseded items do not count. */
const REPEAT_ACTION = "the owner had to ask again: create/refresh the HARD RULE now (global CLAUDE.md 'Owner repeats' rule 1) and apply it in this turn";
function repeatTag(it) {
  if (!it || !Array.isArray(it.repeat_of) || !it.repeat_of.length) return null;
  const of = it.repeat_of.length > 3 ? it.repeat_of.slice(-3).join(',') + ',…' : it.repeat_of.join(',');
  return 'REPEAT x' + (Number(it.repeat_count) || 2) + ' of ' + of;
}
/** repeatNote(item) -> 'REPEAT x<n> of R-.. — the owner had to ask again: ...' | null */
function repeatNote(it) { const t = repeatTag(it); return t ? t + ' — ' + REPEAT_ACTION : null; }
const repeatLive = (i) => i && i.status !== 'cancelled' && i.status !== 'superseded';
const repeatAddressed = (i) => !!(i && (i.repeat_rule_ref || (i.class === 'preference' && i.evidence && i.evidence.type === 'standing_rule')));
/** unaddressedRepeats(state) -> [item] — per repeat chain with no HARD RULE link, its highest-count live item (highest
 *  count first). */
function unaddressedRepeats(state) {
  const items = state && state.items ? state.items : {};
  const comp = new Map();
  const find = (r) => { while (comp.has(r) && comp.get(r) !== r) r = comp.get(r); return r; };
  const join = (a, b) => { if (!comp.has(a)) comp.set(a, a); if (!comp.has(b)) comp.set(b, b); const x = find(a), y = find(b); if (x !== y) comp.set(x, y); };
  for (const it of Object.values(items)) {
    if (!Array.isArray(it.repeat_of)) continue;
    for (const r of it.repeat_of) if (items[r]) join(it.rid, r);
  }
  const groups = new Map();
  for (const r of comp.keys()) { const g = find(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(items[r]); }
  const out = [];
  for (const members of groups.values()) {
    if (members.some((m) => repeatAddressed(m) && repeatLive(m))) continue;
    const top = members.filter((m) => repeatLive(m) && Array.isArray(m.repeat_of) && m.repeat_of.length)
      .sort((a, b) => (Number(b.repeat_count) || 0) - (Number(a.repeat_count) || 0) || b.rid.localeCompare(a.rid))[0];
    if (top) out.push(top);
  }
  return out.sort((a, b) => (Number(b.repeat_count) || 0) - (Number(a.repeat_count) || 0) || b.rid.localeCompare(a.rid));
}

function buildDigest(state, cap) {
  const max = Number(cap) || 1200;
  const c = state.counts || {};
  const active = Object.values(state.items).filter((i) => ACTIVE.includes(i.status))
    .sort((a, b) => (b.created || '').localeCompare(a.created || '') || b.rid.localeCompare(a.rid));
  let head = 'Scribe: ' + active.length + ' active (' + (c.unclassified || 0) + ' unclassified, ' + (c.open || 0) + ' open, ' +
    (c.planned || 0) + ' planned, ' + (c['in-progress'] || 0) + ' in-progress) · ' + (c.done_unacked || 0) + ' done-unacked · '
    + (c.defer_proposed || 0) + ' defer-proposed · ' + (c.deferred || 0) + ' deferred';
  const reps = unaddressedRepeats(state);
  if (reps.length) head += ' · ' + reps[0].rid + ' ' + repeatNote(reps[0]) + (reps.length > 1 ? ' (+' + (reps.length - 1) + ' more repeat chain(s))' : '');
  const lines = [head];
  let used = head.length;
  let shown = 0;
  for (const it of active) {
    const tag = [it.class, it.status].concat(it.wp_ids && it.wp_ids.length ? [it.wp_ids.join(',')] : []).concat(it.route ? ['-> /forge remember'] : []).concat(repeatTag(it) ? [repeatTag(it)] : []).join('|');
    const line = it.rid + ' [' + tag + '] ' + it.title + ' — ' + (it.pid || (it.imported_from ? 'import' : '?')) + ' ' + fmtDate(it.created);
    const more = '… +' + (active.length - shown - 1) + ' more (forge-scribe list)';
    const reserve = shown + 1 < active.length ? 1 + more.length : 0;
    if (used + 1 + line.length + reserve > max) break;
    lines.push(line); used += 1 + line.length; shown++;
  }
  if (shown < active.length) {
    const more = '… +' + (active.length - shown) + ' more (forge-scribe list)';
    if (used + 1 + more.length <= max) lines.push(more);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- owner authority (SC-01/SC-02/SC-03, see the header)

class OwnerRefused extends Error { constructor(msg) { super(msg); this.code = 'SCRIBE_REFUSED'; } }
const ownerRefuse = (m) => { throw new OwnerRefused(m); };

/** claudeProjectSlug(dir) — Claude Code's folder name for a project under ~/.claude/projects: every character that is not
 *  a letter or digit becomes '-' (the same rule as forge-sync.cjs claudeProjectSlug; the drive letter's case varies). */
function claudeProjectSlug(dir) { return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-'); }
function profileHome() {
  try { const h = os.userInfo().homedir; if (h) return h; } catch { /* no passwd entry: fall back */ }
  return os.homedir();
}
function projectsRootOf(opts) {
  return opts && opts.claudeProjectsRoot ? path.resolve(opts.claudeProjectsRoot) : path.join(profileHome(), '.claude', 'projects');
}
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin';
const normCase = (p) => (CASE_FOLD ? p.toLowerCase() : p);
/** transcriptDirOf(root, opts) -> the real path of ~/.claude/projects/<slug> (case-insensitive name match) or null. */
function transcriptDirOf(root, opts) {
  const base = projectsRootOf(opts);
  const slug = claudeProjectSlug(root);
  let names = [];
  try { names = fs.readdirSync(base); } catch { return null; }
  const hit = names.find((n) => normCase(n) === normCase(slug));
  if (!hit) return null;
  try { return fs.realpathSync.native(path.join(base, hit)); } catch { return null; }
}
/** containedReal(file, dirReal) -> the file's real path when it lies inside dirReal (realpath, not lexical), else null. */
function containedReal(file, dirReal) {
  let real;
  try { real = fs.realpathSync.native(file); } catch { return null; }
  const rel = path.relative(normCase(dirReal), normCase(real));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? real : null;
}

/** userText(entry) — the text of a real TYPED user message in a Claude transcript entry, or null. Explicitly accepted:
 *  type 'user', role 'user', not meta, not a sidechain (subagent), not a compaction summary, no tool result, content a
 *  string or text blocks only, and not machine text (forge-scribe-classify machineSkip: task-notification, tool echoes,
 *  command/skill bodies …). A background agent's completion (origin.kind 'task-notification') never counts. */
function userText(entry) {
  if (!entry || entry.type !== 'user' || !entry.message || entry.message.role !== 'user') return null;
  if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true || entry.toolUseResult !== undefined) return null;
  // origin.kind of a typed prompt was not probed; every machine-shaped kind is refused (the probed one is task-notification)
  if (entry.origin && typeof entry.origin === 'object' && /notification|task|agent|hook|system|tool|compact|meta|command/i.test(String(entry.origin.kind || ''))) return null;
  const text = contentText(entry.message.content);
  if (text == null || C.machineSkip(text)) return null;
  return text;
}
/** contentText(m) — the comparable text of a message content: a string as is, or ALL text parts of a block array joined
 *  with '\n' (the way Claude Code hands the joined prompt to the UserPromptSubmit hook). WP-ACK-IMAGE: an
 *  attached image or document is an owner message too — those parts are ignored, not a reason to refuse the entry. A
 *  block array holding any other part (tool_result, tool_use, unknown) is never owner text; no text part -> null. */
const ATTACHMENT_PARTS = new Set(['image', 'document']);
function contentText(m) {
  if (typeof m === 'string') return m;
  if (!Array.isArray(m) || !m.length) return null;
  const texts = [];
  for (const b of m) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (!(b && ATTACHMENT_PARTS.has(b.type))) return null;
  }
  return texts.length && texts.some((s) => s.trim()) ? texts.join('\n') : null;
}
/** wsNorm(s) — whitespace runs (newlines included) collapsed to one space, trimmed: the text comparison form. */
const wsNorm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** inboxIndex(p) -> {chain, records, byPid}. The chain is verified over the same bytes the records come from. */
function inboxIndex(p) {
  let txt = '';
  try { txt = fs.readFileSync(p.inbox, 'utf8'); } catch { txt = ''; }
  const chain = chainOfText(txt);
  const records = [];
  for (const l of txt.split('\n').filter((x) => x.trim())) { try { records.push(JSON.parse(l)); } catch { /* counted by the chain */ } }
  const byPid = new Map(records.filter((r) => r && typeof r.pid === 'string').map((r) => [r.pid, r]));
  return { chain, records, byPid };
}
/** hookOrigin(rec) -> null when the record carries a hook capture's identity, else why not. */
function hookOrigin(rec) {
  if (!rec) return 'is not in the inbox';
  if (rec.source !== 'hook') return 'was not captured by the UserPromptSubmit hook (source ' + JSON.stringify(rec.source) + ')';
  if (typeof rec.session_id !== 'string' || !rec.session_id) return 'has no session id';
  if (typeof rec.prompt_id !== 'string' || !rec.prompt_id) return 'has no prompt id';
  if (typeof rec.text !== 'string' || !rec.text) return 'has no text';
  return null;
}
const INTENT_OF = { ack: ['ack'], cancel: ['cancel'], defer: ['ack'], classify: ['ack'], supersede: ['ack', 'cancel'] };
/** refTimeOf(op, item) — the moment the approved state came to exist (freshness, SC-01). */
function refTimeOf(op, item) {
  if (op === 'ack') return item.status === 'defer-proposed' ? (item.defer_proposed_at || item.updated) : (item.done_at || item.updated);
  return item.created;
}
function actOf(rec, rid, op, item, cfg) {
  let last = null;
  for (const intent of INTENT_OF[op] || []) {
    const a = C.authorizes(rec.text, rid, intent, cfg);
    if (a.ok) {
      const ref = refTimeOf(op, item);
      if (ref && Date.parse(rec.ts) < Date.parse(ref)) return { ok: false, reason: 'was captured ' + rec.ts + ', BEFORE the state it would approve existed (' + ref + ') — an older prompt never approves later work' };
      return Object.assign({}, a, { ref: ref || null });
    }
    last = a;
  }
  return last || { ok: false, reason: 'no owner intent for ' + op };
}
/** queuedText(entry) — the text of a message the owner typed WHILE a turn was running, or null. Claude Code (2.1.29x,
 *  probed 2026-10-11 on a real transcript) writes no typed 'user' entry for it: it logs an 'attachment' entry of type
 *  'queued_command' {prompt, source_uuid, commandMode 'prompt', origin.kind 'human', humanTurn true, timestamp}, later a
 *  'queue-operation' entry {operation 'remove', commandUuid == source_uuid} when the running turn absorbs it — that is
 *  when the UserPromptSubmit hook fires, with the RUNNING turn's prompt id. Only a human, prompt-mode, human-turn queue
 *  entry with a plain text body counts. */
function queuedText(entry) {
  if (!entry || entry.type !== 'attachment' || entry.isSidechain === true || entry.isMeta === true) return null;
  const a = entry.attachment;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt' || a.humanTurn !== true) return null;
  if (!a.origin || typeof a.origin !== 'object' || a.origin.kind !== 'human') return null;
  const text = contentText(a.prompt);
  if (text == null || C.machineSkip(text)) return null;
  return text;
}
const DEFAULT_MATCH_SKEW_SEC = 120;
/** matchSkewMs(cfg) — how far (either way) a transcript entry's delivery time may lie from the inbox capture time. */
function matchSkewMs(cfg) {
  const v = Number(cfg && cfg.owner_check && cfg.owner_check.transcript_match_skew_sec);
  return (Number.isFinite(v) && v >= 0 ? v : DEFAULT_MATCH_SKEW_SEC) * 1000;
}
/** transcriptEntryOf(tp, rec, cfg) -> {entry, said, at} or null — the transcript entry holding the record's prompt as an
 *  owner message. WP-ACK-TEXT: the owner repeats the SAME words (acks, rule repeats), and Claude Code reuses
 *  the running turn's prompt id for a message absorbed mid-turn, so prompt id + text can match several entries; the
 *  first (oldest) one used to win, dating a repeated ack at its first occurrence so it could never approve later work.
 *  Now every candidate is collected — a typed entry (same prompt id, session, uuid when recorded, text) or a queued
 *  owner message (same session and text, after the turn of that prompt id started; delivered when its queue-operation
 *  removed it) — and the one whose DELIVERY time is closest to the inbox capture time wins, only within
 *  owner_check.transcript_match_skew_sec (default 120 s) either way; nothing farther matches. `said` is when the owner
 *  wrote it (the freshness clock), `at` when it reached the session. */
function transcriptEntryOf(tp, rec, cfg) {
  const max = Number(cfg.caps && cfg.caps.max_prompt_chars) || 20000;
  // WP-ACK-IMAGE: the exact hash as before, or the same text after collapsing whitespace on both sides (the hook's
  // newline-joined parts vs. however the transcript side was joined). Equality of the full texts only — no substrings.
  const inboxWs = typeof rec.text === 'string' && rec.text.trim() ? wsNorm(rec.text) : null;
  const sameText = (t) => {
    if (t == null) return false;
    const n = normalizePrompt(t, max).text;
    return sha256(n) === rec.text_sha256 || (inboxWs != null && wsNorm(n) === inboxWs);
  };
  const sameSession = (e) => (e.sessionId !== undefined ? e.sessionId === rec.session_id : path.basename(tp, '.jsonl') === rec.session_id);
  const entries = readJsonl(tp, false);
  const removedAt = new Map(); // queue command uuid -> when the running turn absorbed it
  for (const e of entries) {
    if (e && e.type === 'queue-operation' && typeof e.commandUuid === 'string' && e.operation !== 'enqueue') removedAt.set(e.commandUuid, Date.parse(e.timestamp || ''));
  }
  const cands = [];
  let turnStarted = false;
  for (const e of entries) {
    if (!e || !sameSession(e)) continue;
    if (e.promptId === rec.prompt_id && (!rec.uuid || e.uuid === rec.uuid) && sameText(userText(e))) {
      const ts = Date.parse(e.timestamp || '');
      cands.push({ entry: e, said: ts, at: ts });
    }
    if (e.promptId === rec.prompt_id && userText(e) != null) turnStarted = true;
    const a = e.attachment;
    if (turnStarted && sameText(queuedText(e)) && (!rec.uuid || rec.uuid === a.source_uuid || rec.uuid === e.uuid)) {
      const said = Date.parse(a.timestamp || e.timestamp || '');
      const removed = removedAt.get(a.source_uuid);
      cands.push({ entry: e, said, at: Number.isFinite(removed) ? removed : said });
    }
  }
  const captured = Date.parse(rec.ts || '');
  const skew = matchSkewMs(cfg);
  let best = null;
  for (const c of cands) {
    if (!Number.isFinite(c.at) || !Number.isFinite(captured)) continue;
    const d = Math.abs(c.at - captured);
    if (d <= skew && (!best || d < best.d)) best = Object.assign({ d }, c);
  }
  return best;
}
/** ownerAuthority(ctx, {pid, rid, op, item, transcript?}) -> the inbox record, or throws SCRIBE_REFUSED. ctx = {root, p,
 *  cfg, o} from forge-scribe.cjs. See the header (OWNER AUTHORITY) for the four checks. */
function ownerAuthority(c, a) {
  const op = a.op;
  if (!a.pid || !/^P-\d+$/.test(a.pid)) ownerRefuse(op + ' needs --prompt P-n: the inbox id of the owner prompt that says so (shown in the hook receipt)');
  const ix = inboxIndex(c.p);
  if (!ix.chain.ok) ownerRefuse(op + ': the inbox hash chain is broken (' + JSON.stringify(ix.chain.breaks.slice(0, 3)) + ') — owner origin cannot be trusted; run forge-scribe verify-chain');
  const rec = ix.byPid.get(a.pid);
  const why = hookOrigin(rec);
  if (why) ownerRefuse(op + ': ' + a.pid + ' ' + why + ', so it cannot carry the owner\'s authority');
  const act = actOf(rec, a.rid, op, a.item, c.cfg);
  if (!act.ok) ownerRefuse(op + ': owner prompt ' + a.pid + ' does not authorise ' + op + ' of ' + a.rid + ' — ' + act.reason);
  const dir = transcriptDirOf(c.root, c.o);
  if (!dir) ownerRefuse(op + ': this project has no Claude transcript folder (~/.claude/projects/' + claudeProjectSlug(c.root) + '), so the owner origin of ' + a.pid + ' cannot be checked');
  for (const t of [rec.transcript_path].concat(a.transcript ? [a.transcript] : [])) {
    if (!t) ownerRefuse(op + ': ' + a.pid + ' has no transcript path, so its owner origin cannot be checked');
    const real = containedReal(String(t).replace(/^~(?=$|[\\/])/, profileHome()), dir);
    if (!real) ownerRefuse(op + ': transcript ' + JSON.stringify(String(t).slice(0, 200)) + ' is missing or resolves outside this project\'s transcript folder');
    const hit = transcriptEntryOf(real, rec, c.cfg);
    if (!hit) ownerRefuse(op + ': ' + a.pid + ' was not found as an owner message (same prompt id, session and text, within ' + (matchSkewMs(c.cfg) / 1000) + ' s of its capture at ' + rec.ts + ') in ' + path.basename(real));
    // freshness on the transcript's own clock too: re-capturing an old owner message later never makes it fresh
    const said = hit.said;
    if (act.ref && Number.isFinite(said) && said < Date.parse(act.ref)) ownerRefuse(op + ': the owner said this at ' + new Date(said).toISOString() + ', before the state it would approve existed (' + act.ref + ')');
  }
  return Object.assign({}, rec, { act });
}
/** recheckOwnerOps(ledgerRecords, inbox, cfg) -> [{rid, op, seq, reason}] — every by:'owner' op whose prompt is not a
 *  hook capture, does not authorise that op affirmatively, or predates what it approves (the gate blocks on these). */
function recheckOwnerOps(records, inbox, cfg) {
  const out = [];
  const st = emptyState();
  for (const r of records) {
    if (r && r.by === 'owner' && st.items[r.rid]) {
      const rec = inbox.byPid.get(r.pid);
      const why = hookOrigin(rec);
      const act = why ? null : actOf(rec, r.rid, r.op, st.items[r.rid], cfg);
      if (why || !act.ok) out.push({ rid: r.rid, op: r.op, seq: r.seq, reason: 'owner ' + r.op + ' by ' + (r.pid || '(no prompt)') + ': ' + (why ? 'the prompt ' + why : act.reason) });
    }
    if (r && r.seq > st.last_seq) { applyOp(st, r); st.last_seq = r.seq; }
  }
  return out;
}

module.exports = {
  GENESIS, ACTIVE, FINAL_BLOCKING, LOCK_STALE_MS, sha256, paths, withLock, acquireLock, releaseLock, pidAlive, scrubText, scrubMeta, writeFenced, assertLockHeld,
  normalizePrompt, redactPem, appendChained, readJsonl, lastLine, tailLine, verifyChain, chainOfText,
  emptyState, applyOp, foldBuffer, rebuildState, loadState, saveState, cacheSha, buildDigest,
  // owner repeats (WP-SCRIBE-REPEAT)
  repeatTag, repeatNote, unaddressedRepeats, REPEAT_ACTION,
  // owner authority (Codex R3 SC-01/SC-02/SC-03)
  ownerAuthority, recheckOwnerOps, userText, queuedText, transcriptEntryOf, inboxIndex, hookOrigin, claudeProjectSlug, transcriptDirOf, projectsRootOf, containedReal, OwnerRefused, INTENT_OF,
};
