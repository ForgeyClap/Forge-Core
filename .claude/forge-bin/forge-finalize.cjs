#!/usr/bin/env node
'use strict';
/**
 * forge-finalize.cjs — HET ene gezaghebbende eindverdict van een run.
 *
 * PROBLEEM: runwatch, runcontract, verify, trace, tickets, budget en het dashboard projecteerden elk hun
 * EIGEN "klaar" uit andere signalen — dezelfde run kon tegelijk done en niet-done zijn, en geen enkel
 * oordeel was tegen een vaste log-inhoud gepind. Deze poort produceert tegen EEN eventlog-digest een
 * duurzame receipt; elke consument die "is deze run af?" wil weten hoort DEZE receipt te lezen en elk
 * ander signaal hooguit als voortgangsweergave te tonen.
 *
 * MODEL:
 *   finalize --run <id> [--root <projectRoot>]
 *     1. leest events.jsonl via log-event.cjs::readEventsClassified — FAIL-CLOSED: missing/empty/
 *        partial/corrupt is een weigering met de exacte toestand, nooit "geen events dus ok";
 *     2. eist een terminaal run_completed-event in de log (zonder afronding valt er niets te finaliseren);
 *     3. draait forge-runcontract.cjs check --run <id> (het bestaande hard-rules-contract) — exit != 0 is
 *        een weigering die de contract-uitvoer meegeeft;
 *     4. schrijft ATOMISCH <run>/run-finalized.json: { run_id, digest: sha256(events.jsonl-bytes),
 *        seq_last, events, contract: 'ok', finalized_at } en logt een run_finalized-event (dat event ligt
 *        NA de digest — de receipt pint de log ZOALS GEFINALISEERD; het event is de audittrail).
 *     IDEMPOTENT: een tweede finalize tegen dezelfde digest herbevestigt de bestaande receipt (exit 0,
 *     geen tweede event); een gegroeide/gewijzigde log na finalisatie is een weigering (exit 3) — een
 *     "afgeronde" run waar nog events bij komen is precies de inconsistentie die dit zichtbaar maakt.
 *   check --run <id> [--json]
 *     FINALIZED  — receipt aanwezig en de digest matcht de huidige log (het event dat de finalisatie
 *                  zelf logde wordt daarbij verdisconteerd: de log mag exact die staart-events dragen);
 *     STALE      — receipt aanwezig maar de log, het bewijs of de commitbinding is daarna veranderd/vervalst,
 *                  of het contract is (bij een ONGEWIJZIGDE regelset) niet meer groen;
 *     HISTORICAL — een intact record waarvan het onderwerp niet meer de live staat is: cause 'commit'/'domain'
 *                  (HEAD/domein verschoof, contract herbevestigd), 'ruleset' (beoordeeld onder een oudere
 *                  regelset —, 2026-10-09: voorheen STALE) of 'legacy-receipt' (oudere receipt-generatie);
 *     UNDETERMINED — de git-staat van deze root is nu niet vast te stellen;
 *     NOT_FINALIZED — geen receipt.
 *   Exit: 0 ok/FINALIZED · 3 geweigerd/STALE/NOT_FINALIZED · 2 usage/config.
 *
 * SCRIBE BINDING (part ii, F11 item 12): when <root>/.claude/forge-scribe/
 *   ledger.jsonl exists (the owner-requests ledger of forge-scribe.cjs), finalize pins it ADDITIVELY: the receipt gets
 *   scribe_ledger_sha256 (sha256 of the ledger bytes at finalize), scribe_ledger_bytes, scribe_ledger_lines and
 *   scribe_chain_ok (its hash chain verified then), and the run_finalized audit event carries the same sha256/bytes.
 *   check() (and the idempotent re-confirmation) re-verifies it: the first scribe_ledger_bytes bytes of today's ledger
 *   must still hash to the pin. The ledger is append-only, so entries appended AFTER finalize (later owner prompts) are
 *   legitimate and never invalidate the receipt; an edit, truncation or deletion of the pinned prefix is STALE, and so
 *   is a receipt whose scribe binding was removed while its hash-chained run_finalized event still names one. Without
 *   a ledger nothing is pinned (the scribe is not in use) and nothing changes. Schema stays 2: an older checker in the
 *   fleet ignores the extra fields.
 *   SC-08 — the pin is never taken from a caller: a dangling run_finalized slot's pin is
 *   re-verified against today's ledger bytes (prefix hash) and its line count / chain are recomputed; a slot WITHOUT a
 *   pin while the ledger exists is refused; a zero-byte pin, an empty ledger, a broken chain, or an inbox holding owner
 *   prompts with no ledger is refused at finalize and a zero-byte or chain_ok:false pin is STALE at check; and a receipt
 *   WITHOUT a binding is STALE when its run demonstrably had scribe items (scribe events in its log, or ledger items
 *   carrying its run id created before it was finalized). SC-05 — when the run logged a final owner_requests_reconciled,
 *   finalize re-checks its BINDING (forge-scribe.cjs reconcileBinding: no newer owner prompt or item, pinned prefix
 *   intact, final gate OK now) and refuses a stale one; the rule itself stays warn.
 *   Codex R5 SV-05: for a SCRIBE-ACTIVE run (scribeActiveReason: the scribe is in use here and the run met
 *   it, owner prompts/items arrived during it, or it started on/after the rule's since) an ABSENT or PROGRESS-ONLY
 *   reconciliation is refused as well (verdict refused, scribe_reconciliation 'missing'); the contract rule stays warn.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');

function runsDirOf(root) { return path.join(root, '.claude', 'forge-runs'); }
function eventsFileOf(root, runId) { return path.join(runsDirOf(root), runId, 'events.jsonl'); }
function receiptFileOf(root, runId) { return path.join(runsDirOf(root), runId, 'run-finalized.json'); }
function logEventCli(root) { return path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'); }

/** loadClassifier(root) — the central JSONL semantics live in log-event.cjs; a consumer never
 *  re-implements them. Codex R2/N06 hardening: the classifier is THIS installation's own sibling
 *  (.claude/forge-dashboard/log-event.cjs next to this forge-bin), never the copy under the judged root — the same
 *  rule forge-runcontract.cjs readEventsJsonl() follows: require() EXECUTES a file, and a foreign root (the
 *  Command Center gateway checks other projects with the central finalize) may hold any script there.
 *  Classification is pure reading, so our own module suffices. For a project's own finalize both paths are the
 *  same file. The judged root is no longer used to pick code. */
function loadClassifier() {
  try { return require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs')); } catch (e) { return null; }
}

function digestOf(file) {
  const buf = fs.readFileSync(file);
  return { digest: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

// ---- SCRIBE BINDING (part ii) — see the file header ------------------------------------------
const SCRIBE_LEDGER_REL = path.join('.claude', 'forge-scribe', 'ledger.jsonl');
const SCRIBE_PIN_FIELDS = ['scribe_ledger_sha256', 'scribe_ledger_bytes', 'scribe_ledger_lines', 'scribe_chain_ok'];
function scribeLedgerFileOf(root) { return path.join(root, SCRIBE_LEDGER_REL); }
/** This installation's own store module (never the judged root's copy — same reasoning as loadClassifier). */
function loadScribeStore() { try { return require(path.join(__dirname, 'forge-scribe-store.cjs')); } catch { return null; } }
function loadScribeCore() { try { return require(path.join(__dirname, 'forge-scribe.cjs')); } catch { return null; } }
/** inboxPromptCount(root) — owner prompts in .claude/forge-scribe/inbox.jsonl (0 when absent/unreadable). */
function inboxPromptCount(root) {
  try {
    return fs.readFileSync(path.join(root, '.claude', 'forge-scribe', 'inbox.jsonl'), 'utf8').split('\n')
      .filter((l) => { if (!l.trim()) return false; try { const r = JSON.parse(l); return !!r && typeof r.pid === 'string' && !r.duplicate_of; } catch { return false; } }).length;
  } catch { return 0; }
}
/** prefixPinOf(buf, bytes) -> {sha256, bytes, lines, chain_ok} recomputed from the first `bytes` bytes of the ledger. */
function prefixPinOf(buf, bytes) {
  const prefix = buf.subarray(0, bytes);
  const text = prefix.toString('utf8');
  const S = loadScribeStore();
  let chainOk = false;
  if (S && typeof S.chainOfText === 'function') { try { chainOk = S.chainOfText(text).ok === true; } catch { chainOk = false; } }
  return { sha256: crypto.createHash('sha256').update(prefix).digest('hex'), bytes, lines: text.split('\n').filter((l) => l.trim()).length, chain_ok: chainOk };
}
/** scribePinOf(root) -> null (the scribe is not in use: no ledger and no inbox prompt) | {sha256, bytes, lines, chain_ok}
 *  | {error}. Codex R3 SC-08: an empty ledger, a broken chain, or inbox prompts with no ledger are errors (refused), never
 *  a zero-byte pin that would bind nothing. */
function scribePinOf(root) {
  const f = scribeLedgerFileOf(root);
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) {
    if (!(e && e.code === 'ENOENT')) return { error: 'the scribe ledger exists but is unreadable (' + ((e && (e.code || e.message)) || e) + ')' };
    const n = inboxPromptCount(root);
    return n ? { error: 'the scribe inbox holds ' + n + ' owner prompt(s) but the ledger is missing (a crash between the two appends) — run any forge-scribe command (crash recovery) first' } : null;
  }
  if (!buf.length) return { error: 'the scribe ledger exists but is empty — a zero-byte pin would bind nothing' };
  const pin = prefixPinOf(buf, buf.length);
  if (pin.chain_ok !== true) return { error: 'the scribe ledger hash chain is broken (or cannot be checked here) — a receipt is never bound to a broken owner-requests record; run forge-scribe verify-chain' };
  return pin;
}
/** runHadScribeItems(root, runId, events, finalizedAt) -> null | why — SC-08: evidence that this run had owner requests
 *  the receipt must bind: scribe events in its own log, or ledger items carrying its run id created before finalize. */
function runHadScribeItems(root, runId, events, finalizedAt) {
  const ev = (events || []).find((e) => e && (e.event_type === 'scribe_head' || (e.event_type === 'owner_requests_reconciled' && e._forge_verify && e._forge_verify.scribe_gate && e._forge_verify.scribe_gate.decision === 'pass')));
  if (ev) return 'its log has ' + ev.event_type + ' #' + ev.seq;
  if (!runId) return null;
  const cut = Date.parse(finalizedAt || '');
  let txt;
  try { txt = fs.readFileSync(scribeLedgerFileOf(root), 'utf8'); } catch { return null; }
  for (const l of txt.split('\n')) {
    if (!l.trim() || l.indexOf(runId) < 0) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r && r.run_id === runId && (!Number.isFinite(cut) || Date.parse(r.ts) <= cut)) return 'scribe ledger op seq ' + r.seq + ' (' + r.op + ' ' + r.rid + ') names this run';
  }
  return null;
}
/** SCRIBE-ACTIVE RUN (Codex R5 SV-05): a run that must carry a CURRENT FINAL owner_requests_reconciled before
 *  it is finalized. The scribe is in use in this project (a ledger, or owner prompts in the inbox) AND at least one of:
 *  the run demonstrably met the scribe (runHadScribeItems: scribe events in its own log, or ledger ops naming it), an
 *  owner prompt or item was captured at or after the run started (writer-stamped ingested_at of run_started), or the run
 *  started on or after the owner-requests-reconciled rule's `since` (read from this root's FORGE_HARD_RULES.json; the rule
 *  itself stays `warn` in the contract — finalize is where it is enforced). */
const SCRIBE_RECONCILE_SINCE_DEFAULT = '2026-10-10';
function reconcileSinceMs(root) {
  let since = SCRIBE_RECONCILE_SINCE_DEFAULT;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8').replace(/^﻿/, ''));
    const r = (j && Array.isArray(j.rules) ? j.rules : []).find((x) => x && x.id === 'owner-requests-reconciled');
    if (r && typeof r.since === 'string' && Number.isFinite(Date.parse(r.since))) since = r.since;
  } catch { /* the default */ }
  return Date.parse(since.length === 10 ? since + 'T00:00:00Z' : since);
}
function runStartMsOf(events) {
  const ev = (events || []).find((e) => e && e.event_type === 'run_started') || (events || [])[0];
  return ev ? Date.parse(ev.ingested_at || ev.timestamp || '') : NaN;
}
/** scribeActiveReason(root, runId, events) -> null | why — see SCRIBE-ACTIVE RUN. */
function scribeActiveReason(root, runId, events) {
  let ledgerTxt = null;
  try { ledgerTxt = fs.readFileSync(scribeLedgerFileOf(root), 'utf8'); } catch { ledgerTxt = null; }
  const prompts = inboxPromptCount(root);
  if (!(ledgerTxt && ledgerTxt.trim()) && !prompts) return null; // the scribe is not in use here
  const had = runHadScribeItems(root, runId, events, null);
  if (had) return 'the run met the scribe (' + had + ')';
  const start = runStartMsOf(events);
  if (!Number.isFinite(start)) return 'the run has no readable start time while the scribe is in use';
  if (start >= reconcileSinceMs(root)) return 'the run started on/after the owner-requests-reconciled rule took effect, in a project where the scribe is in use';
  for (const l of String(ledgerTxt || '').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r && r.op === 'open' && Date.parse(r.ts) >= start) return 'item ' + r.rid + ' was opened during the run';
  }
  try {
    for (const l of fs.readFileSync(path.join(root, '.claude', 'forge-scribe', 'inbox.jsonl'), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (r && typeof r.pid === 'string' && Date.parse(r.ts) >= start) return 'owner prompt ' + r.pid + ' was captured during the run';
    }
  } catch { /* no inbox */ }
  return null;
}
/** reconcileBindingOfRun(root, events, required?) -> null (nothing to re-check) | {ok, reason, missing?} — SC-05: the
 *  run's LAST final owner_requests_reconciled must still be current (forge-scribe.cjs reconcileBinding, this installation's
 *  own copy). R5 SV-05: with `required` (scribeActiveReason) an ABSENT or PROGRESS-ONLY (final:false) reconciliation is
 *  {ok:false, missing:true}, never "nothing to re-check". */
function reconcileBindingOfRun(root, events, required) {
  const stampOf = (e) => (e && e._forge_verify && e._forge_verify.scribe_gate) || null;
  const all = (events || []).filter((e) => e && e.event_type === 'owner_requests_reconciled');
  const finals = all.filter((e) => stampOf(e) && stampOf(e).final === true);
  if (!finals.length) {
    if (!required) return null;
    return { ok: false, missing: true, reason: (all.length ? 'only progress-only (final:false) or unstamped owner_requests_reconciled events' : 'no owner_requests_reconciled event') + ' — this run is scribe-active (' + required + ') and needs a FINAL reconciliation (the default) that is still current' };
  }
  const SC = loadScribeCore();
  if (!SC || typeof SC.reconcileBinding !== 'function') return { ok: false, reason: 'forge-scribe.cjs (reconcileBinding) is not available next to forge-finalize.cjs — a final reconciliation cannot be re-checked' };
  try { const b = SC.reconcileBinding(stampOf(finals[finals.length - 1]), { root }); return { ok: b.current === true, reason: b.reason }; }
  catch (e) { return { ok: false, reason: 'the reconciliation binding could not be judged (' + ((e && e.message) || e) + ')' }; }
}
/** scribeFieldsOf(pin) -> the receipt / run_finalized fields for a pin (empty object without one). */
function scribeFieldsOf(pin) {
  if (!pin || pin.error) return {};
  return { scribe_ledger_sha256: pin.sha256, scribe_ledger_bytes: pin.bytes, scribe_ledger_lines: pin.lines, scribe_chain_ok: pin.chain_ok };
}
/** scribeBindingOf(root, receipt, lastEvent) -> {ok:true, applicable, appended_bytes?} | {ok:false, reason}. lastEvent =
 *  the log's last entry (the run_finalized slot event); its pin is hash-chained and digest-pinned, so a receipt that
 *  drops or changes the binding cannot hide behind it. Never throws. */
function scribeBindingOf(root, receipt, lastEvent, runCtx) {
  try {
    const ev = lastEvent && lastEvent.event_type === 'run_finalized' ? lastEvent : null;
    const evSha = ev && typeof ev.scribe_ledger_sha256 === 'string' ? ev.scribe_ledger_sha256 : null;
    const has = !!receipt && Object.prototype.hasOwnProperty.call(receipt, 'scribe_ledger_sha256');
    if (!has) {
      if (evSha) return { ok: false, reason: 'the run_finalized event pins scribe ledger ' + evSha.slice(0, 12) + '… but the receipt carries no scribe binding — it was removed from the receipt' };
      // Codex R3 SC-08: no binding anywhere, but the run demonstrably had owner requests -> the binding was stripped
      const had = runCtx ? runHadScribeItems(root, runCtx.runId, runCtx.events, receipt && receipt.finalized_at) : null;
      if (had) return { ok: false, reason: 'the receipt carries no scribe binding although the run had owner requests (' + had + ') — a stripped binding is never "not applicable"' };
      return { ok: true, applicable: false };
    }
    const want = receipt.scribe_ledger_sha256;
    const bytes = receipt.scribe_ledger_bytes;
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/i.test(want) || !Number.isInteger(bytes) || bytes < 0) return { ok: false, reason: 'the receipt carries a malformed scribe binding' };
    // Codex R3 SC-08: a zero-byte pin binds nothing, and a pin taken over a broken chain proves nothing
    if (bytes === 0) return { ok: false, reason: 'the receipt pins a zero-byte scribe ledger — that binds nothing (finalize never writes one)' };
    if (receipt.scribe_chain_ok !== true) return { ok: false, reason: 'the receipt pins a scribe ledger whose chain was not verified OK (scribe_chain_ok ' + JSON.stringify(receipt.scribe_chain_ok) + ')' };
    if (evSha && (evSha !== want || Number(ev.scribe_ledger_bytes) !== bytes)) return { ok: false, reason: 'the receipt scribe binding (' + want.slice(0, 12) + '…, ' + bytes + ' bytes) differs from the one its run_finalized event pins (' + evSha.slice(0, 12) + '…)' };
    let buf;
    try { buf = fs.readFileSync(scribeLedgerFileOf(root)); } catch (e) { return { ok: false, reason: 'the scribe ledger this receipt pins is gone or unreadable (' + ((e && e.code) || 'error') + ')' }; }
    if (buf.length < bytes) return { ok: false, reason: 'the scribe ledger is ' + buf.length + ' bytes, shorter than the ' + bytes + ' pinned at finalize — truncated or rewritten' };
    if (crypto.createHash('sha256').update(buf.subarray(0, bytes)).digest('hex') !== want) return { ok: false, reason: 'the first ' + bytes + ' bytes of the scribe ledger changed after finalize — a non-append edit of the owner-requests record' };
    return { ok: true, applicable: true, appended_bytes: buf.length - bytes };
  } catch (e) {
    return { ok: false, reason: 'the scribe binding could not be checked (' + ((e && e.message) || e) + ')' };
  }
}

function writeAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    // r5 #11: gefsynct vóór de rename — een receipt die de rename overleeft maar zijn bytes niet is erger
    // dan geen receipt (parent-dir-fsync bestaat niet op Windows/Node; gedocumenteerd restrisico).
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, contents, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  catch (e) { try { fs.unlinkSync(tmp); } catch { } throw e; }
}

/** markRunFinalized — stopt de valse liveness-claim van een gefinaliseerde run.
 *
 *  GEMETEN DEFECT (volledige doctor): `run liveness` meldde als
 *  "still marked running but proven not alive (stalled, silent 12h)" terwijl die run een GELDIGE receipt
 *  had. Oorzaak: finalize LAS run.json (voor het domein) maar schreef hem nooit terug, dus elke
 *  gefinaliseerde run bleef liveness claimen die hij niet waarmaakte — een advisory die met valse
 *  positieven volloopt, wordt genegeerd, en dan mist hij de ECHTE stalled run.
 *
 *  Twee bewuste beperkingen:
 *   - run.json is METADATA, niet bewijs. Het gezag is en blijft de receipt (sha256 over events.jsonl);
 *     die wordt hier niet aangeraakt, dus geen enkele digest of ketenclaim verschuift.
 *   - FAIL-SAFE: ontbrekende, onparseerbare of niet-schrijfbare run.json geeft een reden terug en laat
 *     een geslaagde finalisatie ongemoeid. Metadata mag bewijs nooit omverhalen.
 *  Bewust GEEN nieuwe statuswaarde: 'completed' is het bestaande vocabulaire (19 runs) en finalize
 *  slaagt alleen op een groen contract met run_completed als laatste lifecycle-event, dus hij is waar. */
/** evidenceDigestOf — de canonieke bewijsdigest van deze run, of null als er geen (geldige) bewijsset is.
 *  Leunt op forge-runcontract's canonicalizer zodat er ÉÉN definitie van "de bewijsset" bestaat en de
 *  poort en de receipt niet uit elkaar kunnen groeien. */
function canonicalEvidenceOf(root, runId) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    if (typeof RC.canonicalEvidenceDigest !== 'function') return null;
    return RC.canonicalEvidenceDigest(root, runId);
  } catch { return null; }
}

function evidenceDigestOf(root, runId) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    if (typeof RC.canonicalEvidenceDigest !== 'function') return null;
    const r = RC.canonicalEvidenceDigest(root, runId);
    return r ? r.digest : null;
  } catch { return null; }
}

/** headProbeOf(root) — (D2), REBUILT (2.1, same date, review C VERDICT
 *  FAIL): an INDEPENDENT, LIVE probe of THIS root's git state, reusing forge-runcontract.cjs's own
 *  shared, THREE-WAY `gitProbe()` (the same helper check() itself uses for its `noGitAtRoot`). A
 *  receipt's `code_commit` is allowed to be `null` only when a real check of the CURRENT root, run right
 *  now, POSITIVELY CONFIRMS there is no git repository here (`gitProbe`'s `state:'no-repo'`) — never
 *  merely because `gate-evidence.json` (the run's OWN, possibly stale/hand-edited/cross-machine output)
 *  says `code.no_git:true`, and never merely because the probe could not determine an answer.
 *
 *  2.1 REGRESSION FIX: the previous version called `resolveHeadCommit` directly, which returns `null`
 *  for BOTH a confirmed no-git root AND an UNDETERMINED one (dubious ownership, no commits yet, a
 *  poisoned GIT_DIR, git missing) — so `ok:true, commit:null` fired on an undetermined root exactly as
 *  readily as on a genuinely git-less one, and the two call sites below (which only ever compared
 *  `commit !== null`) could never tell them apart. Now `ok:true` is returned ONLY for gitProbe's two
 *  DETERMINED states ('repo' and 'no-repo'); 'undetermined' always yields `ok:false`, so it is refused by
 *  both call sites' existing `if (!probe.ok) return refused` branch — fail-closed, same discipline as
 *  the rest of this file. */
function headProbeOf(root) {
  let RC;
  try { RC = require(path.join(__dirname, 'forge-runcontract.cjs')); }
  catch (e) { return { ok: false, reason: 'forge-runcontract.cjs niet laadbaar: ' + (e && e.message ? e.message : String(e)) }; }
  if (typeof RC.gitProbe !== 'function') return { ok: false, reason: 'gitProbe niet beschikbaar in forge-runcontract.cjs' };
  let p;
  try { p = RC.gitProbe(root); }
  catch (e) { return { ok: false, reason: 'git-probe faalde: ' + (e && e.message ? e.message : String(e)) }; }
  if (p.state === 'repo') return { ok: true, commit: p.commit, state: 'repo' };
  if (p.state === 'no-repo') return { ok: true, commit: null, state: 'no-repo' };
  return { ok: false, reason: p.reason || 'git-staat van deze root kon niet worden vastgesteld', state: 'undetermined' };
}

/** independentVerificationStatus — de gesaneerde onafhankelijkheidsstand die in de receipt hoort.
 *  Draagt ALTIJD `label_only` mee (de owner-gated grens uit F-02) en, wanneer de regel op dit niveau niet
 *  geldt, expliciet `applicable:false` — zodat NOT_APPLICABLE nooit als "geverifieerd" leest. */
function independentVerificationStatus(root, runId) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    if (typeof RC.check !== 'function') return { available: false, reason: 'runcontract niet laadbaar', label_only: true };
    /** R7-08 (zevende herreview): deze aanroep gaf GEEN commit_sha mee, terwijl de evaluator zonder
     *  actuele commit fail-closed rood wordt. Een geldige finalisatie schreef daardoor een receipt die
     *  tegelijk FINALIZED en `independent_verification.ok:false` zei — twee tegenstrijdige gezaghebbende
     *  signalen uit één bestand. Dezelfde HEAD-resolutie als de CLI, dus dezelfde uitkomst. */
    const commitSha = typeof RC.resolveHeadCommit === 'function' ? RC.resolveHeadCommit(root) : null;
    const r = RC.check({ run_id: runId, commit_sha: commitSha }, { root });
    const d = r && r.rule_details && r.rule_details['independent-verification'];
    if (!d) return { available: false, reason: 'de regel is op deze run niet geevalueerd', label_only: true };
    return {
      available: true,
      applicable: d.applicable !== false,
      ok: d.ok === true,
      route: d.route || null,
      reviewer: d.reviewer || null,
      review_id: d.review && d.review.review_id ? d.review.review_id : null,
      label_only: true,
      caveat: 'De scheiding werker/reviewer rust op AGENTLABEL, niet op een runtimeprincipal. Een uitvoerder met twee geregistreerde labels kan deze poort passeren; echte provenance is owner-gated (zie OWNER-GATED.md).',
    };
  } catch (e) {
    return { available: false, reason: 'status niet vast te stellen: ' + (e && e.message ? e.message : String(e)), label_only: true };
  }
}

function markRunFinalized(root, runId, receipt) {
  const p = path.join(runsDirOf(root), runId, 'run.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { updated: false, reason: 'geen run.json aanwezig' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { updated: false, reason: 'run.json is onparseerbaar — met rust gelaten' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { updated: false, reason: 'run.json is geen object — met rust gelaten' };
  const before = j.status;
  j.status = 'completed';
  j.finalized_at = receipt.finalized_at;
  j.finalize_digest = receipt.digest;
  try { writeAtomic(p, JSON.stringify(j, null, 2) + '\n'); }
  catch (e) { return { updated: false, reason: 'schrijven mislukt: ' + (e && e.message ? e.message : String(e)) }; }
  return { updated: true, status_before: before === undefined ? null : before, status_after: 'completed' };
}

function classify(root, runId) {
  const M = loadClassifier();
  const file = eventsFileOf(root, runId);
  if (!M || typeof M.readEventsClassified !== 'function') {
    // geen writer-module bereikbaar = we kunnen de log niet eerlijk beoordelen — fail-closed
    return { status: 'unreadable', entries: [], badLines: [], reason: 'log-event.cjs (de centrale JSONL-semantiek) is niet laadbaar naast deze forge-finalize.cjs (' + path.join(__dirname, '..', 'forge-dashboard') + ')' };
  }
  // r4 #11: de completion-poort valideert schema + hashketen, niet alleen JSON-parseerbaarheid
  // — een omgezet event, seq-gat of vervalste staartregel is hier 'corrupt', nooit 'valid'.
  return M.readEventsClassified(file, { verifyChain: true, runId });
}

// De gereduceerde lifecycle-staat van een run: het LAATSTE event uit deze set bepaalt of de run "af" is.
// run_completed -> rework_started/check_failed betekent: er kwam werk NA de afronding — niet finaliseren (r4 #8).
// run_finalized zit er bewust NIET in: dat is de audittrail van deze poort zelf (de idempotente hercheck
// zou anders zijn eigen slotevent als "werk na de afronding" lezen).
const LIFECYCLE_EVENTS = new Set(['run_started', 'run_completed', 'rework_started', 'check_failed']);

function runDomainOf(root, runId) {
  // gezaghebbende runmetadata (r4 #8-rest): run.json > declared domain in events > null (runcontract deriveert dan zelf)
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runsDirOf(root), runId, 'run.json'), 'utf8'));
    if (meta && typeof meta.domain === 'string' && meta.domain.trim()) return meta.domain.trim();
  } catch { }
  return null;
}
/** rulesetPinOf(root) -> {sha256, version} | null — (2026-10-09,,
 *  audit S7): the hash AND the ruleset's own declared `version` come from ONE read of the same bytes, so a
 *  receipt can never pin a version that belongs to different bytes than its hash. `version` is the top-level
 *  `version` field of FORGE_HARD_RULES.json (number or string), null when absent or unparseable — the hash
 *  stays the exact pin; the version is the human-readable label of WHICH ruleset generation judged a run. */
function rulesetPinOf(root) {
  let buf;
  try { buf = fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json')); }
  catch { return null; }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  let version = null;
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (j && (typeof j.version === 'number' || typeof j.version === 'string')) version = j.version;
  } catch { version = null; }
  // the exact bytes travel with the pin so finalize can store a content-addressed copy next to the receipt
  return { sha256, version, bytes: buf };
}
function rulesetHashOf(root) {
  const pin = rulesetPinOf(root);
  return pin ? pin.sha256 : null;
}
const kort = (v) => String(v).slice(0, 12) + '…';

/** ================= LEGACY-RECEIPT ALLOWLIST =================
 *  Before this fix, receiptState() classified ANY schema-2 receipt lacking evidence_digest/code_commit/
 *  independent_verification as 'legacy' — so stripping those three fields from a NEW receipt made it an
 *  unfalsifiable HISTORICAL record, and the plan/doctor treated HISTORICAL as done. Legacy eligibility is now
 *  AUTHENTICATED: a checked-in, per-project allowlist names each real legacy receipt by run id AND the sha256
 *  of its exact bytes. Anything else lacking the fields is invalid (STALE). The allowlist is per-project state
 *  (never shipped by forge-sync — the `*.user.json` class of FORGE_SHIP_MANIFEST.json), because it describes
 *  THIS project's receipts; a synced project keeps its own.
 *  Two generations are allowlistable:
 *   - 'pre-evidence'        schema 2, pins log + ruleset, no evidence_digest/code_commit/IV (finalized 2026-08-06..09)
 *   - 'pre-pinned-ruleset'  evidence-bearing, but finalized before the rules bytes were stored next to the receipt
 *                           accepted as HISTORICAL cause 'ruleset' (reverified:false) when the rules
 *                           changed, and its evidence may match an older canonical form (legacy_digests). */
const LEGACY_RECEIPTS_REL = path.join('.claude', 'config', 'orchestration', 'FORGE_LEGACY_RECEIPTS.user.json');
const LEGACY_RECEIPTS_SCHEMA = 'forge-legacy-receipts/v1';
const LEGACY_GENERATIONS = new Set(['pre-evidence', 'pre-pinned-ruleset']);
const RULESET_PINNED_FILE = 'ruleset-pinned.json';
function legacyReceiptsFileOf(root) { return path.join(root, LEGACY_RECEIPTS_REL); }
/** loadLegacyReceipts(root) -> {entries:[{run_id, sha256, generation}], error?} — never throws; a malformed
 *  allowlist authenticates NOTHING (entries []), with the error reported. */
function loadLegacyReceipts(root) {
  let raw;
  try { raw = fs.readFileSync(legacyReceiptsFileOf(root), 'utf8'); } catch (e) { return { entries: [], absent: true, error: e && e.code === 'ENOENT' ? null : (e && e.message) || String(e) }; }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { entries: [], error: 'allowlist is not valid JSON: ' + e.message }; }
  if (!j || j.schema !== LEGACY_RECEIPTS_SCHEMA || !Array.isArray(j.receipts)) return { entries: [], error: 'allowlist must be {schema:"' + LEGACY_RECEIPTS_SCHEMA + '", receipts:[...]}' };
  const entries = [];
  for (const r of j.receipts) {
    if (!r || typeof r.run_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(r.run_id)) continue;
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(r.sha256)) continue;
    if (!LEGACY_GENERATIONS.has(r.generation)) continue;
    entries.push({ run_id: r.run_id, sha256: r.sha256.toLowerCase(), generation: r.generation });
  }
  return { entries };
}
/** allowlistedReceipt(root, runId, receiptBytes) -> the matching entry (run id AND exact bytes) or null. */
function allowlistedReceipt(root, runId, receiptBytes) {
  const sha = crypto.createHash('sha256').update(receiptBytes).digest('hex');
  const { entries } = loadLegacyReceipts(root);
  return entries.find((e) => e.run_id === runId && e.sha256 === sha) || null;
}
function rulesetPinnedFileOf(root, runId) { return path.join(runsDirOf(root), runId, RULESET_PINNED_FILE); }
/** pinnedRulesetOf(root, runId, expectedSha) -> {state:'present'|'absent'|'mismatch', path, sha256?} — the
 *  content-addressed copy of the rules a receipt was judged under. */
function pinnedRulesetOf(root, runId, expectedSha) {
  const p = rulesetPinnedFileOf(root, runId);
  let buf;
  try { buf = fs.readFileSync(p); } catch { return { state: 'absent', path: p }; }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { state: sha256 === String(expectedSha || '').toLowerCase() ? 'present' : 'mismatch', path: p, sha256 };
}

/** evaluateAcceptance(root, runId, receipt) -> ONE shared acceptance judgement (V22 fix, 2026-09-24 second
 *  Codex recheck, out-p7.md) — used by the IDEMPOTENT finalize reconfirmation and by check() alike, closing
 *  an inconsistency where each path recomputed a DIFFERENT subset of the same live facts.
 *
 *  GEREPRODUCEERD: a matching-digest receipt whose CURRENT evidence set was no longer all-green still
 *  reconfirmed successfully on a repeat `finalize()` call (the old idempotent branch never asked
 *  `nuSet.allGreen`, only whether the digest happened to match). Moving real git HEAD after finalization
 *  left a repeat `finalize()` still reporting success while `check()` correctly said HISTORICAL — the old
 *  idempotent branch compared only the STATIC commit gate-evidence.json itself recorded, never the LIVE
 *  current HEAD, and never re-ran the contract at all. `check()`'s own HEAD/domain comparison ran BEFORE
 *  its contract re-evaluation, so a run that was ALSO currently contract-red could read as merely
 *  "HISTORICAL" (sounds like "just old") instead of the real failure it was.
 *
 *  V22 REGRESSION (2026-09-24 THIRD Codex recheck, out-p8.md) — the rebuild above dropped the ONE check that
 *  actually binds the evidence to the receipt's OWN commit claim: `nuSet.commit !== receipt.code_commit`.
 *  Everything above still matches on the evidence DIGEST (a hash over per-gate name/exit_code/output_sha256/
 *  commit — see canonicalEvidenceDigest's doc) and separately compares LIVE HEAD to `receipt.code_commit`,
 *  but `receipt.code_commit` is a PLAIN field, not itself covered by that digest — a receipt file can be
 *  hand-edited to claim a DIFFERENT `code_commit` (e.g. the current HEAD) while `gate-evidence.json` (and
 *  therefore the matching digest) still genuinely names an OLDER commit. REPRODUCED: a green L1 fixture whose
 *  evidence names commit A, with `receipt.code_commit` overwritten to equal current HEAD, passed digest/
 *  allGreen/ruleset/contract/HEAD-vs-receipt every time — nothing ever compared the evidence's OWN commit to
 *  what the receipt claims that evidence ran on. Restored here, unconditionally, for every caller.
 *
 *  (2026-10-09,, audit S7 — MEASURED on this project's 14 real
 *  receipts before the change: 13 STALE, only 1 HISTORICAL, and not one of the 13 was tampered with):
 *   - A RULESET change is no longer 'fail'. Any edit to FORGE_HARD_RULES.json used to flip every receipt
 *     ever written to 'fail' (6 of the 13), although nothing in those runs changed. The receipt was judged
 *     against the ruleset it pins; that ruleset is gone, so the contract cannot honestly be re-judged under
 *     it, and judging it under the NEW rules would retroactively apply obligations the run never had. It
 *     is now status 'historical' with cause 'ruleset' and reverified:false. The contract is still re-run
 *     under the CURRENT rules and its result is reported, never hidden (contract_under_current_ruleset), so
 *     a consumer that needs more than "valid record" can see it. Evidence, commit and log tampering stay
 *     'fail': those checks all run BEFORE the ruleset comparison, unchanged.
 *   - The evidence comparison also accepts the OLDER canonical form of the SAME evidence (forge-runcontract
 *     canonicalEvidenceDigest's legacy_digests — the D2 canonical-form change made 3 of the 13 read as
 *     "evidence changed" with byte-identical gate-evidence.json). Reported as evidence_canon:'legacy'.
 *
 *  Returns exactly one of:
 *   {status:'fail', reason}      — evidence changed, the evidence's commit differs from the receipt's claim,
 *                                  the live evidence set is not (or no longer) all-green, or (ruleset
 *                                  UNCHANGED) the contract does not re-evaluate to ok:true RIGHT NOW. Never
 *                                  acceptable from ANY caller.
 *   {status:'historical', cause, reverified, reason, ...} — a structurally intact record whose subject no
 *                                  longer matches the live state:
 *       cause:'commit'|'domain' — the contract IS currently green against this receipt's own pinned
 *                                  subject (reverified:true), but the pinned commit and/or declared domain
 *                                  no longer matches the LIVE state (code_commit_then/now, domain_then/now).
 *                                  Computed ONLY after the contract re-evaluation succeeded — with an
 *                                  unchanged ruleset a genuinely red contract is always 'fail', never
 *                                  quietly hidden behind 'historical'.
 *       cause:'ruleset'         — judged against a ruleset that is no longer the current one (ruleset_then/
 *                                  now, ruleset_version_then/now); reverified:false; the current-rules
 *                                  outcome is in contract_under_current_ruleset {ok, missing, unevaluated}.
 *   {status:'undetermined', reason} — the LIVE git state of this root right now is neither a confirmed
 *                                  repo nor a confirmed no-repo (`gitProbe`'s `state:'undetermined'` —
 *                                  dubious ownership, no commits yet, a poisoned GIT_DIR, git missing,
 *                                  timeout). Also-noted fix (2026-09-26 independent review, alongside N2/
 *                                  this receipt is bound to a REAL commit (`code_commit`),
 *                                  so a right-now-unreadable HEAD can never honestly be called either
 *                                  'current' (we do not know it still matches) or 'historical' (we do not
 *                                  know it does not) — it is reported as exactly what it is, undetermined,
 *                                  same fail-closed discipline `headProbeOf`'s other two call sites in this
 *                                  file already use. The contract is deliberately NEVER re-evaluated in
 *                                  this branch: passing a fabricated `commit_sha` (e.g. `null`, as if this
 *                                  were a confirmed no-git root) into `RC.check()` could wrongly trigger a
 *                                  no-git relaxation path on a root that may well have a repository it
 *                                  simply could not read right now — exactly the class of bug 's D2
 *                                  fix closed elsewhere.
 *   {status:'current'}           — contract is currently green AND the pinned subject (commit + domain)
 *                                  still matches the live state: fully valid and current.
 *  Never throws — a re-check failure folds into {status:'fail'}. */
function evaluateAcceptance(root, runId, receipt, ctx) {
  ctx = ctx || {};
  // an OLDER canonical evidence form is accepted ONLY for a receipt on the checked-in allowlist
  const allow = ctx.allowlisted !== undefined ? ctx.allowlisted : allowlistedReceipt(root, runId, readReceiptBytes(root, runId));
  const nuSet = canonicalEvidenceOf(root, runId);
  const nu = nuSet ? nuSet.digest : null;
  // the pinned digest may be the pre-D2 canonical form of the SAME evidence (see the doc above).
  const legacyForms = allow && nuSet && Array.isArray(nuSet.legacy_digests) ? nuSet.legacy_digests : [];
  const evidenceCanon = (nu !== null && nu === receipt.evidence_digest) ? 'current'
    : (typeof receipt.evidence_digest === 'string' && legacyForms.includes(receipt.evidence_digest) ? 'legacy' : null);
  if (!evidenceCanon) {
    return { status: 'fail', reason: 'de bewijsset is sinds de finalisatie veranderd (gate-evidence ' + String(receipt.evidence_digest).slice(0, 12) + '… -> ' + (nu ? nu.slice(0, 12) + '…' : 'ontbreekt/ongeldig') + ') — het oordeel sloeg op ander bewijs' + (!allow && nuSet && (nuSet.legacy_digests || []).includes(receipt.evidence_digest) ? ' (de pin matcht alleen een OUDERE canonieke vorm, en deze receipt staat niet op de legacy-allowlist ' + LEGACY_RECEIPTS_REL + ')' : '') };
  }
  const canonInfo = Object.assign(evidenceCanon === 'legacy' ? { evidence_canon: 'legacy' } : {}, allow ? { allowlisted: allow.generation } : {});
  /** V22 REGRESSION FIX (2026-09-24 THIRD Codex recheck, out-p8.md) — the evidence digest matching is not
   *  enough: `receipt.code_commit` is a plain field the digest does not cover, so a receipt whose evidence is
   *  byte-for-byte unchanged can still claim a DIFFERENT commit than the one that evidence actually ran on
   *  (e.g. hand-edited to equal current HEAD after the fact). `nuSet.commit` is the commit the CURRENT,
   *  digest-matching evidence itself recorded (canonicalEvidenceDigest requires every gate to carry one,
   *  well-formed and identical across gates — see its own doc) — it must equal what the receipt claims that
   *  evidence ran on, independent of the separate live-HEAD-drift check further below. */
  if (!nuSet || nuSet.commit !== receipt.code_commit) {
    return { status: 'fail', reason: 'de bewijsset draait op commit ' + String(nuSet && nuSet.commit).slice(0, 12) + '… maar de receipt claimt code_commit ' + String(receipt.code_commit).slice(0, 12) + '… — het bewijs en de receipt wijzen naar verschillende commits' };
  }
  if (!nuSet || (nuSet.failed || []).length) {
    return { status: 'fail', reason: 'de huidige bewijsset bevat gefaalde poort(en) (' + ((nuSet && nuSet.failed) || []).join(', ') + ') — een receipt met bijpassende hash maar rode uitvoer wordt niet geaccepteerd' };
  }
  /** the manifest still matches the pin, but the raw gate output(s) cannot be read back on this machine
   *  — nothing proves them wrong, nothing can re-verify them. Not 'fail' (no tamper evidence), never
   *  'current' or a re-verified 'historical' either: an archival record that is not a completion proof. */
  if (nuSet.allGreen !== true || (nuSet.unverified || []).length) {
    return Object.assign({ status: 'unverified-archival', cause: 'unverified-archival', reverified: false, unverified_gates: nuSet.unverified || [],
      reason: 'de ruwe uitvoer van poort(en) ' + (nuSet.unverified || []).join(', ') + ' is hier niet leesbaar (gitignored, andere machine of nooit geschreven) — het manifest matcht de receipt, maar het bewijs is niet opnieuw te verifiëren; een ARCHIEFRECORD, geen completion-bewijs' }, canonInfo);
  }
  // (S7): a changed ruleset is no longer a 'fail' — it is decided AFTER the HEAD probe below and routed
  // to rulesetSupersededAcceptance(); every tamper check above has already run unchanged.
  const nuPin = rulesetPinOf(root);
  const rulesetChanged = (nuPin ? nuPin.sha256 : null) !== receipt.ruleset_sha256;
  const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
  // the contract re-run may accept an older evidence form in the review binding ONLY for an allowlisted receipt
  const checkOpts = { root, acceptLegacyEvidenceDigests: evidenceCanon === 'legacy' };
  /** Also-noted fix (2026-09-26 independent review): this used to call `RC.resolveHeadCommit(root)`
   *  directly, which collapses gitProbe's THREE states into just a commit-or-null — so an UNDETERMINED
   *  root (git could not answer right now) read exactly like a CONFIRMED no-repo root: `headNow` was
   *  falsy either way, the `if (headNow && ...)` drift check below never fired, and execution fell
   *  straight through to `{status:'current'}` for a receipt that is bound to a real `code_commit` we
   *  simply could not reconfirm. `headProbeOf` (same three-way `gitProbe` this file's other two call
   *  sites already gate on) tells the two apart; 'undetermined' short-circuits here, honestly, before the
   *  contract is ever re-run with a commit_sha we do not actually know. */
  const headProbe = headProbeOf(root);
  if (!headProbe.ok) {
    return { status: 'undetermined', reason: 'de huidige git-staat van deze root kon niet worden vastgesteld (' + headProbe.reason + ') — dit eindverdict is noch bevestigd actueel, noch bevestigd historisch' };
  }
  const headNow = headProbe.commit; // null ONLY for a POSITIVELY CONFIRMED no-repo root (headProbe.ok === true)
  /** when HEAD has moved past the finalized commit, the contract is judged AS OF that commit —
   *  the commit this receipt, its (digest-matching) evidence and the run's independent review are all bound to.
   *  Re-running it against the NEW HEAD made the review's commit binding fail on any later commit, docs-only
   *  included, so every verified receipt read as STALE once someone committed a report (the and
   *  release runs). The contract is still re-run before `historical` is ever reported: red as of the finalized
   *  commit remains the real failure (STALE). Without drift nothing changes: it is judged against HEAD. */
  const drifted = !!(headNow && receipt.code_commit && headNow !== receipt.code_commit);
  const judgedCommit = drifted ? receipt.code_commit : headNow;
  if (rulesetChanged) {
    return Object.assign(rulesetSupersededAcceptance(root, runId, receipt, { RC, nuPin, headNow, judgedCommit, allow, checkOpts }), canonInfo);
  }
  let contractNow = null;
  try { contractNow = RC.check({ run_id: runId, domain: receipt.domain || undefined, commit_sha: judgedCommit }, checkOpts); }
  catch (e) { return { status: 'fail', reason: 'het contract kon bij acceptatie niet worden herbeoordeeld (' + (e && e.message ? e.message : String(e)) + ') — een receipt die niet herbevestigd kan worden, wordt niet vertrouwd' }; }
  if (!contractNow || contractNow.ok !== true) {
    return { status: 'fail', reason: 'het contract is bij acceptatie NIET meer groen (missing: ' + ((contractNow && contractNow.missing) || []).join(', ') + ') — een opgeslagen contract:"ok" wordt niet blind vertrouwd; deze receipt wordt niet geaccepteerd' };
  }
  const domainNow = runDomainOf(root, runId);
  if (headNow && headNow !== receipt.code_commit) {
    return Object.assign({ status: 'historical', cause: 'commit', reverified: true, reason: 'deze receipt geldt voor commit ' + receipt.code_commit.slice(0, 12) + '… maar de huidige HEAD is ' + headNow.slice(0, 12) + '… — dit eindverdict is HISTORISCH, niet actueel', code_commit_then: receipt.code_commit, code_commit_now: headNow }, canonInfo);
  }
  if (domainNow !== (receipt.domain || null)) {
    return Object.assign({ status: 'historical', cause: 'domain', reverified: true, reason: 'deze receipt geldt voor domein ' + JSON.stringify(receipt.domain) + ' maar run.json declareert nu ' + JSON.stringify(domainNow) + ' — dit eindverdict is HISTORISCH, niet actueel', domain_then: receipt.domain, domain_now: domainNow }, canonInfo);
  }
  return Object.assign({ status: 'current' }, canonInfo);
}

/** rulesetSupersededAcceptance(root, runId, receipt, ctx) -> {status:'historical', cause:'ruleset', ...} —
 *  (S7). Called ONLY after every tamper check (log digest in check(), evidence digest, evidence-vs-receipt
 *  commit, all-green evidence) passed and the live git state was determined, so reaching it means: the record
 *  itself is intact; only the rules it was judged by are no longer the current ones.
 *  The contract is re-run under the CURRENT rules as of the same commit the normal path would judge, and the
 *  outcome is REPORTED (never decisive): red there is what one expects when the new rules add obligations
 *  this run never had, so it is not a 'fail' — but it is never hidden either. Never throws. */
function rulesetSupersededAcceptance(root, runId, receipt, ctx) {
  const { RC, nuPin, headNow, judgedCommit, allow } = ctx;
  const checkOpts = ctx.checkOpts || { root };
  const domainNow = runDomainOf(root, runId);
  const drifted = !!(headNow && receipt.code_commit && headNow !== receipt.code_commit);
  const domainDrifted = domainNow !== (receipt.domain || null);
  const versionThen = receipt.ruleset_version === undefined ? null : receipt.ruleset_version;
  const versionNow = nuPin ? nuPin.version : null;
  const label = (sha, v) => kort(sha) + (v != null ? ' (versie ' + v + ')' : '');
  const driftNote = (drifted ? '; ook de HEAD verschoof (' + kort(receipt.code_commit) + ' -> ' + kort(headNow) + ')' : '')
    + (domainDrifted ? '; ook het domein verschoof (' + JSON.stringify(receipt.domain) + ' -> ' + JSON.stringify(domainNow) + ')' : '');
  const driftFields = Object.assign({}, drifted ? { code_commit_then: receipt.code_commit, code_commit_now: headNow } : {}, domainDrifted ? { domain_then: receipt.domain, domain_now: domainNow } : {});
  const common = { ruleset_then: receipt.ruleset_sha256, ruleset_now: nuPin ? nuPin.sha256 : null, ruleset_version_then: versionThen, ruleset_version_now: versionNow };

  /** the receipt was judged under rules whose exact bytes finalize
   *  stored next to it (ruleset-pinned.json, content-addressed by the receipt's own ruleset_sha256). On a
   *  ruleset mismatch the contract is RE-EVALUATED UNDER THOSE PINNED RULES, as of the receipt's commit:
   *  red there is a real failure (STALE) — it used to read 'historical' for any mismatch, including a
   *  hand-edited receipt pin; green there is a genuinely re-verified historical record (reverified:true). */
  // the CURRENT-rules outcome is always computed and reported (informational, never decisive) — "never hidden"
  let underCurrent;
  try {
    const c = RC.check({ run_id: runId, domain: receipt.domain || undefined, commit_sha: judgedCommit }, checkOpts);
    underCurrent = { ok: !!(c && c.ok === true), missing: (c && c.missing) || [], unevaluated: ((c && c.unevaluated) || []).map((u) => u.id) };
  } catch (e) {
    underCurrent = { ok: false, missing: [], unevaluated: [], error: e && e.message ? e.message : String(e) };
  }
  const huidig = underCurrent.error ? 'niet te beoordelen (' + underCurrent.error.slice(0, 160) + ')'
    : (underCurrent.ok ? 'groen' : 'NIET groen (missing: ' + underCurrent.missing.join(', ') + ')');
  const pinned = pinnedRulesetOf(root, runId, receipt.ruleset_sha256);
  if (pinned.state === 'present') {
    let underPinned;
    try {
      const c = RC.check({ run_id: runId, domain: receipt.domain || undefined, commit_sha: judgedCommit }, Object.assign({}, checkOpts, { rulesPath: pinned.path }));
      underPinned = { ok: !!(c && c.ok === true), missing: (c && c.missing) || [], unevaluated: ((c && c.unevaluated) || []).map((u) => u.id), ruleset_sha256_used: c && c.ruleset_sha256_used };
    } catch (e) {
      return Object.assign({ status: 'fail', reason: 'het contract kon niet worden herbeoordeeld onder de GEPINDE regelset ' + label(receipt.ruleset_sha256, versionThen) + ' (' + (e && e.message ? e.message : String(e)) + ') — een receipt die niet herbevestigd kan worden, wordt niet vertrouwd' }, common);
    }
    if (underPinned.ruleset_sha256_used !== receipt.ruleset_sha256) {
      return Object.assign({ status: 'fail', reason: 'de gepinde regelset-kopie werd gelezen als ' + kort(underPinned.ruleset_sha256_used) + ' terwijl de receipt ' + kort(receipt.ruleset_sha256) + ' pint — de kopie wisselde tijdens de herbeoordeling' }, common);
    }
    if (!underPinned.ok) {
      return Object.assign({ status: 'fail', reason: 'het contract is onder de GEPINDE regelset ' + label(receipt.ruleset_sha256, versionThen) + ' NIET meer groen (missing: ' + underPinned.missing.join(', ') + ') — een regelwijziging verzacht een rood contract niet tot HISTORICAL' + driftNote, contract_under_pinned_ruleset: underPinned }, common, driftFields);
    }
    return Object.assign({
      status: 'historical', cause: 'ruleset', reverified: true, judged_under: 'pinned-ruleset',
      reason: 'deze receipt is beoordeeld tegen regelset ' + label(receipt.ruleset_sha256, versionThen) + ', de huidige is ' + (nuPin ? label(nuPin.sha256, versionNow) : 'onleesbaar')
        + ' — HISTORISCH maar HERBEVESTIGD: het contract is opnieuw groen onder de gepinde kopie van die regelset (ruleset-pinned.json) als van commit ' + kort(judgedCommit || receipt.code_commit) + '; onder de huidige regels is het ' + huidig + driftNote,
      contract_under_pinned_ruleset: underPinned, contract_under_current_ruleset: underCurrent,
    }, common, driftFields);
  }

  /** No usable pinned copy. For a receipt on the checked-in allowlist (generation 'pre-pinned-ruleset': finalized
   *  before F02 existed) the record stays HISTORICAL with reverified:false and the current-rules outcome reported
   *  (never decisive). Anything else — a receipt from after this fix whose pinned copy is missing or does not
   *  hash to its own pin (an edited pin included) — is 'unverified-archival': intact log/evidence/commit, but the
   *  rules it claims to have been judged under cannot be produced, so it is not a completion proof. */
  if (allow && allow.generation === 'pre-pinned-ruleset') {
    return Object.assign({
      status: 'historical', cause: 'ruleset', reverified: false,
      reason: 'deze receipt is beoordeeld tegen regelset ' + label(receipt.ruleset_sha256, versionThen)
        + ', de huidige is ' + (nuPin ? label(nuPin.sha256, versionNow) : 'onleesbaar')
        + ' — dit eindverdict is HISTORISCH (allowlist-generatie pre-pinned-ruleset): log, bewijs en commit zijn intact, maar de regels van toen zijn niet gepind, dus het contract is niet opnieuw te beoordelen; onder de huidige regels is het ' + huidig + driftNote,
      contract_under_current_ruleset: underCurrent,
    }, common, driftFields);
  }
  return Object.assign({
    status: 'unverified-archival', cause: 'unverified-archival', reverified: false,
    pinned_ruleset: pinned.state,
    reason: 'deze receipt pint regelset ' + label(receipt.ruleset_sha256, versionThen) + ' maar de gepinde kopie (' + RULESET_PINNED_FILE + ') is ' + (pinned.state === 'absent' ? 'afwezig' : 'hasht niet naar die pin (' + kort(pinned.sha256) + ')')
      + ' en deze receipt staat niet op de legacy-allowlist (' + LEGACY_RECEIPTS_REL + ') — de regels waaronder dit oordeel geveld zou zijn, zijn niet te reproduceren: een ARCHIEFRECORD zonder herverificatie, geen completion-bewijs; onder de huidige regels is het ' + huidig + driftNote,
    contract_under_current_ruleset: underCurrent,
  }, common, driftFields);
}

/** legacyAcceptance(root, runId, receipt) -> {status:'historical', cause:'legacy-receipt', ...} —
 *. For a receipt receiptState() classifies 'legacy': written by an older finalize generation
 *  that pinned the log and the ruleset but not yet evidence_digest/code_commit/independent_verification
 *  (4 of this project's 14 real receipts, finalized 2026-08-06..09). check() reaches this ONLY after the
 *  log itself was re-verified (chain-valid, ends on run_finalized, exact digest+bytes match). Nothing else
 *  CAN be re-verified for it — so it is a historical record with reverified:false, never FINALIZED and
 *  never 'current'. Before it read STALE ("ongeldig") although nothing about the run changed. */
function legacyAcceptance(root, runId, receipt) {
  const nuPin = rulesetPinOf(root);
  return {
    status: 'historical', cause: 'legacy-receipt', reverified: false, legacy_receipt: true, allowlisted: 'pre-evidence',
    reason: 'receipt uit een oudere finalize-generatie (pint log en regelset, nog geen evidence_digest/code_commit) — de log matcht nog byte-exact en de hashketen is geldig, maar bewijs, commit en contract zijn voor deze receipt niet opnieuw te verifiëren; een HISTORISCH record, nooit FINALIZED',
    ruleset_then: receipt.ruleset_sha256, ruleset_now: nuPin ? nuPin.sha256 : null,
    ruleset_version_then: receipt.ruleset_version === undefined ? null : receipt.ruleset_version,
    ruleset_version_now: nuPin ? nuPin.version : null,
  };
}

/** finalize (herbouwd, Codex r4 #8-rest/#9/#10-rest) — de receipt pint nu de VOLLEDIGE log
 *  INCLUSIEF exact het eigen run_finalized-audittrail-event als laatste regel:
 *    1. keten-gevalideerde classificatie (fail-closed);
 *    2. lifecycle: het laatste lifecycle-event moet run_completed zijn (afronding is terminaal);
 *    3. contract met het ECHTE domein uit run.json (web-/correctness-critical-regels tellen mee);
 *    4. digest-stabiliteit: de digest wordt NA de contractcheck herlezen — is de log intussen veranderd,
 *       dan is er geen stabiele transactie en weigeren we (#9);
 *    5. het run_finalized-event wordt EERST geappend (via de writer, onder de events-lock, keten-gehasht);
 *       faalt die append, dan is er GEEN receipt — auditlogging is verplicht, niet best-effort (#9);
 *    6. de receipt pint digest+bytes van de log MET dat event. check() = exacte digest-match: elke
 *       truncatie, aangroei of vervalste extra run_finalized-regel wijzigt de digest ⇒ STALE (#10-rest).
 *  Idempotent: bestaande receipt + exacte digest-match = herbevestiging zonder tweede event. */
/** finalizeLock — de hele finalize-transactie (classify → contract → audittrail-append → receipt) is
 *  exclusief per run: twee gelijktijdige finalizers zouden anders BEIDE een run_finalized appenden en
 *  elkaars receipt overschrijven (gevonden door de 2-finalizers-racetest). wx-create; een
 *  achterblijver ouder dan 60s is een crash-artefact en wordt gereapt. */
function acquireFinalizeLock(root, runId) {
  const lockPath = path.join(runsDirOf(root), runId, 'run-finalized.lock');
  const t0 = process.hrtime.bigint();
  const elapsed = () => Number((process.hrtime.bigint() - t0) / 1000000n);
  for (;;) {
    try { const fd = fs.openSync(lockPath, 'wx'); try { fs.writeSync(fd, String(process.pid)); } catch { } return { fd, lockPath }; }
    catch (e) {
      if (e.code !== 'EEXIST') return null;
      // r5 #8: de 60s-leeftijdsreap kon een LEVENDE finalizer (contract-child mag 120s lopen) bestelen.
      // Reap nu pas boven de maximale operatieduur (180s > 120s contract-timeout) EN alleen met een
      // aantoonbaar dode houder-pid (onleesbaar token = crash-artefact). Monotone klok tegen NTP-sprongen.
      try {
        const st = fs.statSync(lockPath);
        const age = Date.now() - st.mtimeMs;
        let holderPid = null;
        try { const n = Number(fs.readFileSync(lockPath, 'utf8').trim()); if (Number.isFinite(n) && n > 0) holderPid = n; } catch { }
        const holderDead = holderPid === null ? true : (() => { try { process.kill(holderPid, 0); return false; } catch { return true; } })();
        if (age > 180000 && holderDead) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; }
      if (elapsed() > 30000) return null;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); } catch { }
    }
  }
}
function releaseFinalizeLock(l) { if (!l) return; try { fs.closeSync(l.fd); } catch { } try { fs.unlinkSync(l.lockPath); } catch { } }

/** loadVaultModule/maybeUpdateVault — best-effort, non-blocking knowledge-vault refresh
 *  after a REAL finalize. Runs OUTSIDE the finalize-lock (already released above) and AFTER `result` is
 *  final, so it can never affect the finalize verdict, never hold the lock longer, and — critically —
 *  never writes an event: a consumer that appended anything to events.jsonl after run_finalized would
 *  make this very receipt STALE on its next check. opts.vaultModule is a test-only injection seam (a
 *  fake module, or a real one whose updateVault() is made to throw) — every other caller leaves it
 *  undefined and gets the real .claude/forge-bin/forge-vault.cjs when present. */
function loadVaultModule(root, opts) {
  if (opts && opts.vaultModule !== undefined) return opts.vaultModule;
  try { return require(path.join(__dirname, 'forge-vault.cjs')); } catch { return null; }
}
function maybeUpdateVault(root, runId, opts) {
  try {
    const vault = loadVaultModule(root, opts);
    if (!vault || typeof vault.updateVault !== 'function') return;
    const r = vault.updateVault(root, runId, {});
    if (r && r.ok === false) console.error('forge-finalize: vault update skipped (' + r.reason + ')');
  } catch (e) {
    console.error('forge-finalize: vault update failed (' + (e && e.message ? e.message : String(e)) + ') — finalize itself is unaffected');
  }
}

function finalize(root, runId, opts) {
  const flock = acquireFinalizeLock(root, runId);
  if (!flock) return { ok: false, verdict: 'refused', reason: 'finalize-lock niet verkregen (een andere finalizer is bezig of een crash-artefact blokkeert) — probeer opnieuw' };
  let result;
  try { result = finalizeLocked(root, runId); }
  finally { releaseFinalizeLock(flock); }
  if (result && result.ok === true) maybeUpdateVault(root, runId, opts);
  return result;
}
function finalizeLocked(root, runId) {
  const file = eventsFileOf(root, runId);
  const cls = classify(root, runId);
  if (cls.status !== 'valid') {
    return { ok: false, verdict: 'refused', reason: 'events.jsonl is ' + cls.status + (cls.badLines && cls.badLines.length ? ' (regel ' + cls.badLines.map((b) => b.line + (b.reason ? ':' + b.reason : '')).join(',') + ')' : '') + ' — een completion-poort finaliseert nooit over een onleesbare/gemanipuleerde log (fail-closed)', classification: cls.status };
  }
  const events = cls.entries;
  const lastLifecycle = [...events].reverse().find((e) => LIFECYCLE_EVENTS.has(e.event_type));
  if (!lastLifecycle || lastLifecycle.event_type !== 'run_completed') {
    return { ok: false, verdict: 'refused', reason: 'de gereduceerde lifecycle-staat is ' + (lastLifecycle ? lastLifecycle.event_type : 'geen lifecycle-event') + ', niet run_completed — na de afronding kwam er werk bij of de run claimt zelf nog geen afronding' };
  }
  /** a run_completed that honestly reports a FAILURE
   *  (status/outcome/verdict/result failed|aborted|blocked|…) closes the run as failed — it claims no
   *  completion, so there is nothing to finalize. Before this check a failure close with otherwise green
   *  prerequisites produced ok:true, verdict 'finalized' and a receipt. The predicate is forge-runcontract's
   *  isFailureClose — the SAME one log-event's completion gate uses — never a second copy. */
  if (isFailureCloseEvent(lastLifecycle)) {
    return { ok: false, verdict: 'refused', failure_close: true, reason: 'run_completed #' + events.indexOf(lastLifecycle) + ' is een EERLIJKE FAALAFSLUITING (' + failureCloseLabel(lastLifecycle) + ') — zo\'n run claimt geen afronding en wordt nooit gefinaliseerd; verder werk vraagt een nieuwe run' };
  }
  /** r5 #10: "laatste lifecycle-event = run_completed" liet WERK-events na de afronding toe
   *  (file_changed, wp_failed, fix_started, ...) zolang ze niet in de lifecycle-set zaten. Na
   *  run_completed zijn uitsluitend audit-events legitiem — al het andere is werk-na-afronding en
   *  blokkeert finalisatie. */
  const POST_COMPLETION_ALLOWED = new Set(['run_finalized', 'gate_evaluated', 'contract_checked']);
  const completedIdx = events.lastIndexOf(lastLifecycle);
  const illegalTail = events.slice(completedIdx + 1).find((e) => !POST_COMPLETION_ALLOWED.has(e.event_type));
  if (illegalTail) {
    return { ok: false, verdict: 'refused', reason: 'na run_completed volgt nog een werk-event (' + illegalTail.event_type + ') — de afronding is niet terminaal; rond het werk echt af en log opnieuw run_completed' };
  }

  /** R7-01 (zevende herreview): de idempotente tak las de receipt met `readReceipt()` — een kale
   *  JSON-parse — en vergeleek alleen digests. Schema, run_id, contract en de pinvorm werden NIET
   *  gevalideerd, terwijl `check()` dat wél doet. Een schema-1-receipt of een receipt van een andere run
   *  kreeg zo exit 0 en "finalized". Twee ingangen naar hetzelfde oordeel met verschillende strengheid,
   *  voor de derde keer in deze reeks — daarom nu dezelfde poortwachter voor allebei. */
  const bestaandeStaat = receiptState(root, runId);
  if (bestaandeStaat.state === 'invalid') {
    return { ok: false, verdict: 'refused', reason: 'er ligt al een receipt, maar die is ONGELDIG (' + bestaandeStaat.reason + ') — een herbevestiging kan dat niet repareren; verwijder of herstel hem bewust' };
  }
  /** a legacy-generation receipt is a historical record, not something finalize may silently replace.
   *  Without this branch it would fall through as "no receipt" and — because its log already ends on
   *  run_finalized (the dangling-slot recovery path) — be OVERWRITTEN with a new receipt. Refused instead,
   *  exactly like the other non-current outcomes of the idempotent path. */
  if (bestaandeStaat.state === 'legacy') {
    return { ok: false, verdict: 'refused', historical: true, reason: 'er ligt al een receipt uit een oudere finalize-generatie (zonder evidence_digest/code_commit) — finalize overschrijft die niet; check() rapporteert hem als HISTORICAL' };
  }
  const existing = bestaandeStaat.state === 'valid' ? bestaandeStaat.receipt || readReceipt(root, runId) : null;
  if (existing) {
    const d0 = digestOf(file);
    // De herbevestiging verzoent ook de metadata: runs die vóór deze fix zijn gefinaliseerd dragen nog
    // status 'running' en blijven liveness claimen. Zelfgenezend, want de receipt bewijst hier al dat de
    // run klaar is — en fail-safe, dus een onveranderbare run.json breekt de herbevestiging niet.
    if (d0.digest === existing.digest && d0.bytes === existing.bytes) {
      /** R4-03 (vierde herreview) / V22 (2026-09-24 second Codex recheck, out-p7.md): de idempotente
       *  herbevestiging vergeleek ALLEEN logdigest en bytes en gaf daarna direct succes — gewijzigd bewijs
       *  of een gewijzigde regelset bleef zo groen, terwijl check() wél STALE zou melden; en géén van beide
       *  vergeleek de LEVENDE HEAD/het levende domein of herbeoordeelde het contract. Twee (en straks drie)
       *  ingangen naar hetzelfde verdict mogen niet verschillen — evaluateAcceptance() is nu de ENE
       *  gedeelde poortwachter. Een `historical` uitkomst is hier GEEN succes: finalize() bevestigt de
       *  HUIDIGE staat, dus een verschoven HEAD/domein weigert net als elke andere afwijking — check() is
       *  de losstaande leesfunctie die HISTORICAL als eigen, eerlijke status mag teruggeven. */
      // the same scribe-binding check as check(), so the two entry points cannot disagree about it
      const sbIdem = scribeBindingOf(root, existing, events[events.length - 1], { runId, events });
      if (!sbIdem.ok) return { ok: false, verdict: 'refused', stale: true, reason: 'scribe binding: ' + sbIdem.reason };
      const acceptance = evaluateAcceptance(root, runId, existing);
      if (acceptance.status !== 'current') {
        return { ok: false, verdict: 'refused', reason: acceptance.reason, historical: acceptance.status === 'historical' };
      }
      return { ok: true, verdict: 'finalized', receipt: existing, idempotent: true, run_meta: markRunFinalized(root, runId, existing) };
    }
    return { ok: false, verdict: 'refused', reason: 'run is al gefinaliseerd op digest ' + String(existing.digest).slice(0, 12) + '… maar de log is daarna veranderd (nu ' + d0.digest.slice(0, 12) + '…) en matcht de receipt niet meer — onderzoek de aangroei; een afgeronde run verandert niet', stale: true };
  }

  // digest VOOR de contractcheck — en HERLEZEN erna: het contract mag de bewijslog niet onder ons vandaan
  // zien veranderen (r4 #9). runcontract wordt hier bewust ZONDER --log-event gedraaid (leest alleen).
  const dPre = digestOf(file);
  /** R7-02 (zevende herreview): ik CLAIMDE dat de pins vóór de contractcheck werden bepaald, maar ze
   *  stonden er ná — en `rulesetPin` mocht null zijn, waardoor `null === null` een "geslaagde" finalize
   *  met een direct ongeldige receipt kon opleveren. Nu echt vóór, welgevormd geëist, en na elke stap
   *  opnieuw vergeleken. Wat je pint moet de staat zijn die BEOORDEELD is, niet de staat die daarna
   *  toevallig op schijf stond. */
  /** ÉÉN canonieke lezing voor digest én commit — de eerdere aparte tweede lezing op het
   *  receipt-schrijfpunt was zelf een TOCTOU-venster. */
  const evidenceSetPre = canonicalEvidenceOf(root, runId);
  const evidencePre = evidenceSetPre ? evidenceSetPre.digest : null;
  if (!evidencePre) {
    return { ok: false, verdict: 'refused', reason: 'geen geldige bewijsset (gate-evidence.json) voor deze run — een eindverdict dat aan geen bewijs gebonden is, is geen eindverdict' };
  }
  /** D2 anti-fabrication guard (fresh-laptop re-audit) — mirrors
   *  forge-runcontract.cjs's own `opts.noGit` guard (independentVerification): a no-git evidence claim is
   *  only trusted when an INDEPENDENT probe of the CURRENT root, run right now, confirms there really is
   *  no git repository here. Scoped deliberately to the no_git branch only — a project that genuinely has
   *  git keeps writing/reading a real 40-hex commit exactly as before; this never touches that path. */
  if (evidenceSetPre.no_git === true) {
    const probePre = headProbeOf(root);
    if (!probePre.ok) {
      return { ok: false, verdict: 'refused', reason: 'de bewijsset claimt no-git, maar de git-staat van deze root kon niet onafhankelijk worden vastgesteld (' + probePre.reason + ') — zonder die controle wordt een no-git-claim niet vertrouwd' };
    }
    if (probePre.commit !== null) {
      return { ok: false, verdict: 'refused', reason: 'de bewijsset claimt no-git, maar deze root heeft wél een git-repository (HEAD ' + probePre.commit.slice(0, 12) + '…) — dat kan uit een eerlijke no-git-meting nooit komen, dus geweigerd in plaats van vertrouwd' };
    }
    if (evidenceSetPre.commit != null) {
      // canonicalEvidenceDigest() itself already refuses a mixed no_git+commit record, so this can only
      // fire if that invariant is ever weakened — kept here as a second, independent line of defense.
      return { ok: false, verdict: 'refused', reason: 'de bewijsset claimt no-git maar draagt toch een commit (' + String(evidenceSetPre.commit).slice(0, 12) + '…) — een no-git-record met commit is vervalst, geen bewijs' };
    }
  }
  /** FINALIZE-FAILED-GATE (out-p5.md) — finalize eiste een BINDBARE bewijsset (evidencePre
   *  hierboven), maar niet dat die bewijsset ZELF groen was: dat werd alleen getoetst BINNEN de L2+
   *  independent-review-regel (opts.evidenceAllGreen), dus een L1-run met een gefaalde poort (exit_code:1)
   *  kon gewoon FINALIZED worden zolang het contract verder groen was. GEREPRODUCEERD: een L1-fixture met
   *  gate-evidence.json exit_code:1 gaf `{"contract":{"ok":true},"evidenceAllGreen":false,"finalizeOk":true}`.
   *  Nu VERPLICHT op ELKE complexity: een rode poort in de bewijsset weigert finalize altijd, ongeacht welke
   *  regel er wel/niet op dit niveau van toepassing is. */
  if ((evidenceSetPre.failed || []).length) {
    return { ok: false, verdict: 'refused', reason: 'de bewijsset bevat gefaalde poort(en) (' + (evidenceSetPre.failed || []).join(', ') + ') — finalize weigert een eindverdict te schrijven bovenop rood bewijs, op elke complexity' };
  }
  /** every gate's raw output must be readable and hash-verified RIGHT NOW. A manifest whose
   *  output file is missing (never executed, gitignored away, another machine) is `unverified` — not red, but
   *  never green, and never finalized. */
  if (evidenceSetPre.allGreen !== true || (evidenceSetPre.unverified || []).length) {
    return { ok: false, verdict: 'refused', unverified_gates: evidenceSetPre.unverified || [], reason: 'de ruwe uitvoer van poort(en) ' + (evidenceSetPre.unverified || []).join(', ') + ' is niet leesbaar/herverifieerbaar (output_file ontbreekt of is onleesbaar) — een poort zonder herleesbare, hash-geverifieerde uitvoer is UNVERIFIED, nooit groen; finalize weigert (draai forge-gate-evidence opnieuw zodat de uitvoer naast het manifest ligt)' };
  }
  // hash and declared version from ONE read (rulesetPinOf); the hash is re-verified after the contract
  // check and after the receipt write below, so the stored version always belongs to the pinned bytes.
  const rulesetPinPre = rulesetPinOf(root);
  const rulesetPre = rulesetPinPre ? rulesetPinPre.sha256 : null;
  if (typeof rulesetPre !== 'string' || !/^[0-9a-f]{64}$/i.test(rulesetPre)) {
    return { ok: false, verdict: 'refused', reason: 'de regelset levert geen welgevormde sha256 (' + JSON.stringify(rulesetPre) + ') — zonder die pin is onbekend tegen welke regels het oordeel gold' };
  }
  const domain = runDomainOf(root, runId);
  const contractCli = path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs');
  const rcArgs = [contractCli, 'check', '--run', runId, '--root', root, '--json'];
  if (domain) rcArgs.push('--domain', domain);
  const rc = spawnSync(process.execPath, rcArgs, { encoding: 'utf8', timeout: 120000 });
  if (rc.status !== 0) {
    return { ok: false, verdict: 'refused', reason: 'forge-runcontract is niet groen (exit ' + rc.status + (domain ? ', domein ' + domain : '') + ') — finaliseren over een rood contract zou het ene eindverdict corrumperen', contract_output: String(rc.stdout || '').trim().slice(0, 800) };
  }
  /** R10-04 (tiende herreview): eindpunten vergelijken laat het venster WAARIN het kind las onzichtbaar
   *  (ruleset A → zwakkere B → A tijdens de child = groen beoordeeld onder B, receipt pint A). Het kind
   *  rapporteert daarom nu ZELF welke hashes het las, en die moeten exact onze pins zijn. Onparseerbare
   *  kinduitvoer is fail-closed: een contract waarvan we niet weten wat het las, bewijst niets. */
  let kind;
  try { kind = JSON.parse(String(rc.stdout || '')); }
  catch { return { ok: false, verdict: 'refused', reason: 'de contractcheck gaf geen parseerbare JSON terug — onbekend welke regelset/bewijsset het kind werkelijk las (fail-closed)' }; }
  if (kind.ruleset_sha256_used !== rulesetPre) {
    return { ok: false, verdict: 'refused', reason: 'het contract-kind las regelset ' + String(kind.ruleset_sha256_used).slice(0, 12) + '… terwijl finalize ' + rulesetPre.slice(0, 12) + '… pinde — de regels wisselden tijdens de check (A→B→A is nu zichtbaar)' };
  }
  if (kind.evidence_digest_used !== evidencePre) {
    return { ok: false, verdict: 'refused', reason: 'het contract-kind las bewijsset ' + String(kind.evidence_digest_used).slice(0, 12) + '… terwijl finalize ' + evidencePre.slice(0, 12) + '… pinde — het bewijs wisselde tijdens de check' };
  }
  const dPost = digestOf(file);
  if (dPost.digest !== dPre.digest) {
    return { ok: false, verdict: 'refused', reason: 'de eventlog veranderde TIJDENS de contractcheck (digest ' + dPre.digest.slice(0, 12) + '… -> ' + dPost.digest.slice(0, 12) + '…) — geen stabiele transactie; draai finalize opnieuw op een rustende log' };
  }
  /** finalize re-checks the completion SEQUENCE itself, not only the contract. A
   *  run_completed the writer let through in WARN mode over an unmet sequence (its own stamp says so), or one whose
   *  green contract proof was only logged AFTER the claim, is refused — the claim came before the proof. */
  const seqCheck = completionSequenceRecheck(root, runId, domain, kind, events, lastLifecycle);
  if (!seqCheck.ok) {
    return { ok: false, verdict: 'refused', sequence_unmet: seqCheck.unmet || [], reason: seqCheck.reason };
  }

  /** r5 #11: crash-recovery — eindigt de log al op een run_finalized-slotevent ZONDER receipt (een
   *  eerdere finalize crashte tussen slotevent en receipt-write), dan appenden we GEEN tweede slotevent
   *  maar schrijven we de receipt over de bestaande staat. */
  const lastEntry = events[events.length - 1];
  const danglingSlot = lastEntry && lastEntry.event_type === 'run_finalized';
  /** Codex R3 SC-05: a final owner_requests_reconciled in this run must still be CURRENT (no newer owner prompt or item,
   *  the pinned ledger prefix intact, the final gate OK now). Codex R5 SV-05: for a SCRIBE-ACTIVE run (see
   *  scribeActiveReason) an absent or progress-only reconciliation is refused too — the contract rule stays warn, the
   *  enforcement is here. A run in a project where the scribe is not in use is unaffected. */
  const scribeNeed = scribeActiveReason(root, runId, events);
  const rb = reconcileBindingOfRun(root, events, scribeNeed);
  if (rb && !rb.ok) {
    return { ok: false, verdict: 'refused', scribe_reconciliation: rb.missing ? 'missing' : 'stale', reason: 'owner-requests reconciliation is ' + (rb.missing ? 'missing' : 'stale') + ': ' + rb.reason + ' — reconcile (node .claude/forge-bin/forge-scribe.cjs gate --final, then log owner_requests_reconciled before run_completed), log run_completed and finalize' };
  }
  /** SCRIBE BINDING: the owner-requests ledger is pinned BEFORE the audit event, and the event carries the
   *  same sha256/bytes. Codex R3 SC-08: a recovered dangling slot's pin is NOT trusted — it is re-verified against today's
   *  ledger bytes (prefix hash), its line count and chain are recomputed, and a slot without a pin while the scribe is in
   *  use is refused. */
  let scribePin;
  const currentPin = scribePinOf(root);
  if (danglingSlot) {
    const slotSha = typeof lastEntry.scribe_ledger_sha256 === 'string' ? lastEntry.scribe_ledger_sha256 : null;
    if (!slotSha) {
      if (currentPin) {
        return { ok: false, verdict: 'refused', reason: 'the dangling run_finalized slot carries no scribe binding while the scribe is in use here' + (currentPin.error ? ' (' + currentPin.error + ')' : '') + ' — the receipt cannot be recovered without one; owner review needed' };
      }
      scribePin = null;
    } else {
      const bytes = Number(lastEntry.scribe_ledger_bytes);
      let buf = null;
      try { buf = fs.readFileSync(scribeLedgerFileOf(root)); } catch { buf = null; }
      if (!buf || !Number.isInteger(bytes) || bytes <= 0 || buf.length < bytes) {
        return { ok: false, verdict: 'refused', reason: 'the dangling run_finalized slot pins ' + bytes + ' scribe ledger byte(s), which today\'s ledger (' + (buf ? buf.length : 'missing') + ') cannot confirm — the recovery never accepts a pin it cannot re-verify' };
      }
      const re = prefixPinOf(buf, bytes);
      if (re.sha256 !== slotSha || re.chain_ok !== true) {
        return { ok: false, verdict: 'refused', reason: 'the dangling run_finalized slot\'s scribe pin does not match the first ' + bytes + ' bytes of today\'s ledger (or that prefix has a broken chain) — refused, never trusted' };
      }
      scribePin = re;
    }
  } else {
    scribePin = currentPin;
  }
  if (scribePin && scribePin.error) {
    return { ok: false, verdict: 'refused', reason: scribePin.error + ' — a receipt cannot be bound to an owner-requests ledger it cannot verify; fix .claude/forge-scribe/ and finalize again' };
  }
  const scribeFields = scribeFieldsOf(scribePin);
  if (!danglingSlot) {
    // audittrail EERST (verplicht, via de writer onder de events-lock) — daarna pint de receipt de log MET dit event.
    const le = spawnSync(process.execPath, [logEventCli(root), runId, 'run_finalized', JSON.stringify(Object.assign({ agent: 'orchestrator', evidence: 'run-finalized.json', note: 'digest-basis ' + dPost.digest.slice(0, 16) + '… · ' + events.length + ' events · contract ok' + (domain ? ' · domein ' + domain : '') }, scribeFields))], { encoding: 'utf8', timeout: 60000 });
    if (le.status !== 0) {
      return { ok: false, verdict: 'refused', reason: 'het verplichte run_finalized-audittrail-event kon niet worden gelogd (exit ' + le.status + ': ' + String(le.stderr || '').trim().slice(0, 200) + ') — zonder audittrail geen receipt', event_error: String(le.stderr || '').trim().slice(0, 200) };
    }
  }
  const clsFinal = classify(root, runId);
  if (clsFinal.status !== 'valid') {
    return { ok: false, verdict: 'refused', reason: 'de log is na het audittrail-event niet meer keten-valide (' + clsFinal.status + ') — receipt geweigerd' };
  }
  /** r5 #9: is er TUSSEN de contractcheck en het slotevent alsnog een werk-/lifecycle-event geland
   *  (check_failed, file_changed, ...), dan pint de receipt anders een rood log. Herbeoordeel de
   *  volledige lifecycle + staartregel op de eindstand; het exacte slotevent moet de laatste regel zijn. */
  const finalEvents = clsFinal.entries;
  const lastFinal = finalEvents[finalEvents.length - 1];
  if (!lastFinal || lastFinal.event_type !== 'run_finalized') {
    return { ok: false, verdict: 'refused', reason: 'na het audittrail-event landde nog een ander event (' + (lastFinal ? lastFinal.event_type : 'geen') + ' als laatste regel) — geen stabiele transactie; receipt geweigerd' };
  }
  const lastLifecycleFinal = [...finalEvents].reverse().find((e) => LIFECYCLE_EVENTS.has(e.event_type));
  if (!lastLifecycleFinal || lastLifecycleFinal.event_type !== 'run_completed') {
    return { ok: false, verdict: 'refused', reason: 'tijdens het finaliseren veranderde de lifecycle-staat (' + (lastLifecycleFinal ? lastLifecycleFinal.event_type : 'geen') + ') — receipt geweigerd' };
  }
  if (isFailureCloseEvent(lastLifecycleFinal)) { // F04, re-checked on the final state (same discipline as R7-03)
    return { ok: false, verdict: 'refused', failure_close: true, reason: 'de afsluiting op de eindstand is een faalafsluiting (' + failureCloseLabel(lastLifecycleFinal) + ') — receipt geweigerd' };
  }
  /** R7-03 (zevende herreview): na de contractcheck werd alleen gecontroleerd dat `run_finalized` de
   *  laatste regel is en `run_completed` het laatste lifecycle-event. De illegalTail-controle uit de
   *  voorfase werd NIET herhaald, dus een `file_changed` of `owner_override` kon precies tussen de
   *  contractcheck en onze eigen slot-append landen: daarna is het slotevent weer netjes de laatste regel
   *  en werd een onbeoordeelde staat gefinaliseerd. Dezelfde controle hoort op de eindstand te draaien. */
  const completedIdxFinal = finalEvents.map((e) => e.event_type).lastIndexOf('run_completed');
  const illegalTailFinal = finalEvents.slice(completedIdxFinal + 1).find((e) => !POST_COMPLETION_ALLOWED.has(e.event_type));
  if (illegalTailFinal) {
    return { ok: false, verdict: 'refused', reason: 'tussen de contractcheck en het slotevent landde nog een werk-event (' + illegalTailFinal.event_type + ') — die staat is nooit beoordeeld; receipt geweigerd' };
  }
  // the receipt's scribe fields must agree with the slot event and still be a prefix of today's ledger
  const sbFinal = scribeBindingOf(root, scribeFields, lastFinal);
  if (!sbFinal.ok) return { ok: false, verdict: 'refused', reason: 'scribe binding: ' + sbFinal.reason + ' — receipt geweigerd' };
  /** een receipt zonder bindbare bewijsset is geen receipt. Eerder schreef finalize dan
   *  gewoon `evidence_digest: null`, waarna check() de vergelijking oversloeg (die was conditioneel) en
   *  alsnog FINALIZED gaf. Nu weigert finalize eerlijk. De pins worden HIER bepaald en na de
   *  receipt-write opnieuw geverifieerd, zodat een wijziging tussen contractcheck en write niet als
   *  nooit-beoordeeld bewijs kan worden ingepind. */
  /** de pins die het CONTRACT beoordeeld heeft, moeten na het slotevent nog exact gelden — anders
   *  pinnen we een staat die niemand heeft beoordeeld. */
  const evidenceDigest = evidencePre;
  const rulesetPin = rulesetPre;
  if (evidenceDigestOf(root, runId) !== evidenceDigest || rulesetHashOf(root) !== rulesetPin) {
    return { ok: false, verdict: 'refused', reason: 'de bewijsset of regelset veranderde TIJDENS de contractcheck — het groene oordeel gold over een andere staat; draai finalize opnieuw op een rustende staat' };
  }
  const dFinal = digestOf(file);
  const lastSeq = finalEvents.reduce((m, e) => Number.isFinite(Number(e.seq)) ? Math.max(m, Number(e.seq)) : m, 0);
  /** een receipt die tegelijk FINALIZED en een RODE toepasselijke IV-status draagt, geeft twee
   *  tegenstrijdige gezaghebbende signalen af (HEAD-race tussen contractcheck en statusbepaling). Dat
   *  is geen metadata-detail: dan is niet bewezen wat de receipt claimt. Fail-closed. */
  const ivStatus = independentVerificationStatus(root, runId);
  if (ivStatus && ivStatus.available === true && ivStatus.applicable !== false && ivStatus.ok !== true) {
    return { ok: false, verdict: 'refused', reason: 'de independent-verification-status is TOEPASSELIJK maar niet groen op het moment van finaliseren — een FINALIZED-receipt naast een rode IV-status zou twee tegenstrijdige eindsignalen afgeven; los de verificatie op of draai finalize opnieuw op een rustende staat' };
  }
  const receipt = {
    schema: 2, run_id: runId, digest: dFinal.digest, bytes: dFinal.bytes, events: finalEvents.length, seq_last: lastSeq || null,
    contract: 'ok', domain: domain, ruleset_sha256: rulesetPin,
    /** (audit S7): WHICH ruleset generation judged this run, next to the exact hash pin — a
     *  later ruleset edit turns this receipt HISTORICAL (cause 'ruleset'), and this field is what a reader
     *  sees as "judged under version N". Additive: schema stays 2, so an older checker in the fleet that
     *  requires schema 2 still reads this receipt (it simply ignores the field). */
    ruleset_version: rulesetPinPre.version,
    /** R3-05 (derde Codex-herreview 2026-08-09): de receipt pinde de eventlog en de ruleset, maar NIET de
     *  bewijsset. Daardoor kon `gate-evidence.json` ná finalisatie veranderen terwijl het gezaghebbende
     *  verdict FINALIZED bleef — een TOCTOU-gat precies op de plek waar het oordeel definitief hoort te
     *  zijn. De canonieke digest gaat nu mee in de receipt en wordt bij elke check herberekend. */
    evidence_digest: evidenceDigest,
    /** R8-05 (achtste herreview): de receipt pinde log, bewijs en regelset — maar niet de CODE. Na
     *  finalisatie kon HEAD of de bron veranderen terwijl check() en de idempotente herbevestiging
     *  FINALIZED bleven zeggen. De commit waarop het bewijs draaide staat nu in de receipt en wordt bij
     *  elke check hervergeleken; verschuift hij, dan is het oordeel over andere code geveld. */
    code_commit: (evidenceSetPre && evidenceSetPre.commit) || null,
    /** R4-07/R5-08 (twee rondes, zelfde punt): de gezaghebbende receipt droeg de owner-gated caveat NIET.
     *  Een consument las FINALIZED en kon dat als principal-onafhankelijk opvatten, terwijl OWNER-GATED.md
     *  juist vastlegt dat de scheiding op agentLABEL rust. Een eindverdict dat zijn eigen beperking niet
     *  meedraagt, laat de lezer een sterkere claim maken dan het bewijs toestaat. */
    independent_verification: ivStatus,
    /** the exact rules bytes this receipt was judged under are stored next to it, content-
     *  addressed by ruleset_sha256, so a later rules edit re-evaluates the contract under THESE rules instead
     *  of softening every mismatch to "historical". Additive field: an older checker ignores it. */
    ruleset_pinned_file: RULESET_PINNED_FILE,
    /** the owner-requests ledger prefix this run was finalized against — additive, only when
     *  the scribe is in use (see the file header SCRIBE BINDING). */
    ...scribeFields,
    finalized_at: new Date().toISOString(), ...(danglingSlot ? { recovered_dangling_slot: true } : {}),
  };
  /** the pinned copy is written BEFORE the receipt (never a receipt without its rules), from the SAME
   *  bytes rulesetPinOf() hashed for the pin, and read back to the pin's hash before the receipt lands. A
   *  failure here is a refusal — a receipt whose rules cannot be reproduced is not a completion proof. */
  try {
    writeAtomic(rulesetPinnedFileOf(root, runId), rulesetPinPre.bytes);
    const back = pinnedRulesetOf(root, runId, rulesetPin);
    if (back.state !== 'present') throw new Error('de gepinde kopie hasht naar ' + kort(back.sha256) + ', de pin is ' + kort(rulesetPin));
  } catch (e) {
    try { fs.unlinkSync(rulesetPinnedFileOf(root, runId)); } catch { }
    return { ok: false, verdict: 'refused', reason: 'de gepinde regelset-kopie (' + RULESET_PINNED_FILE + ') kon niet worden geschreven/geverifieerd (' + (e && e.message ? e.message : String(e)) + ') — zonder reproduceerbare regels geen receipt' };
  }
  writeAtomic(receiptFileOf(root, runId), JSON.stringify(receipt, null, 2) + '\n');
  /** r5 #9 (staart): landde er een append tussen dFinal en de receipt-write, dan zou finalize "ok"
   *  teruggeven met een direct-STALE receipt. Naverificatie: matcht de log de receipt niet meer exact,
   *  dan gaat de receipt weg en faalt de finalize eerlijk. */
  /** de log werd na de receipt-write al nageverifieerd, maar bewijs en regelset niet — een
   *  wijziging in dat venster belandde ongezien als "nieuwe" pin in de receipt. */
  if (evidenceDigestOf(root, runId) !== evidenceDigest || rulesetHashOf(root) !== rulesetPin) {
    try { fs.unlinkSync(receiptFileOf(root, runId)); } catch { }
    return { ok: false, verdict: 'refused', reason: 'de bewijsset of regelset veranderde TIJDENS het finaliseren — receipt teruggetrokken; draai finalize opnieuw op een rustende staat' };
  }
  const dVerify = digestOf(file);
  if (dVerify.digest !== dFinal.digest || dVerify.bytes !== dFinal.bytes) {
    try { fs.unlinkSync(receiptFileOf(root, runId)); } catch { }
    return { ok: false, verdict: 'refused', reason: 'de log veranderde tijdens het schrijven van de receipt (digest ' + dFinal.digest.slice(0, 12) + '… -> ' + dVerify.digest.slice(0, 12) + '…) — receipt teruggetrokken; draai finalize opnieuw op een rustende log' };
  }
  // Bewust NA de staartverificatie: pas als de receipt onherroepelijk staat, mag de metadata volgen.
  // Faalt dit, dan blijft de finalisatie geldig en meldt run_meta eerlijk waarom hij niet is bijgewerkt.
  const runMeta = markRunFinalized(root, runId, receipt);
  return { ok: true, verdict: 'finalized', receipt, event_logged: true, run_meta: runMeta };
}

/** completionSequenceRecheck(root, runId, domain, contractResult, events, lastCompleted) -> {ok, applicable?,
 *  unmet?, reason?} — Codex R2/N07. Two independent signals, both judged against the LAST run_completed:
 *   1. the writer's own stamp on that event (_forge_verify.completion_gate, written by log-event.cjs): decision
 *      'warn' over a registry-declared sequence means the claim was written while the sequence was unmet;
 *   2. forge-runcontract completionSequenceAtClose(): the pre-completion steps judged as of that claim (the
 *      fresh contract proof must precede it), strict — for claims written without a stamp (an older writer, a
 *      library append).
 *  Applies only when the ruleset declares completion_sequence (it is part of the pinned rules). A contract
 *  module that cannot be loaded or judged is a refusal (fail-closed), like every other gate here. */
function completionSequenceRecheck(root, runId, domain, contractResult, events, lastCompleted) {
  let RC;
  try { RC = require(path.join(__dirname, 'forge-runcontract.cjs')); }
  catch (e) { return { ok: false, reason: 'forge-runcontract.cjs could not be loaded (' + (e && e.message ? e.message : String(e)) + ') — the completion sequence cannot be re-checked, so finalize refuses (fail-closed)' }; }
  if (typeof RC.completionSequenceAtClose !== 'function') return { ok: false, reason: 'this forge-runcontract.cjs has no completionSequenceAtClose() — sync forge-runcontract.cjs with forge-finalize.cjs; the completion sequence cannot be re-checked (fail-closed)' };
  let r;
  try { r = RC.completionSequenceAtClose({ run_id: runId, domain: domain || undefined }, { root, contract: contractResult, events }); }
  catch (e) { return { ok: false, reason: 'the completion sequence could not be re-checked (' + (e && e.message ? e.message : String(e)) + ') — finalize refuses (fail-closed)' }; }
  if (!r || r.applicable === false) return { ok: true, applicable: false };
  const idx = Array.isArray(events) ? events.indexOf(lastCompleted) : -1;
  const fv = lastCompleted && lastCompleted._forge_verify && typeof lastCompleted._forge_verify === 'object' ? lastCompleted._forge_verify : null;
  const stamp = fv && fv.completion_gate && typeof fv.completion_gate === 'object' ? fv.completion_gate : null;
  if (stamp && stamp.decision === 'warn' && stamp.sequence_source === 'registry') {
    const open = Array.isArray(stamp.unmet) ? stamp.unmet.map(String) : [];
    return { ok: false, unmet: open, reason: 'run_completed #' + idx + ' was written in WARN mode over an UNMET completion sequence (open at the time of the claim: ' + (open.join(', ') || 'see the writer warning') + ') — the claim came before the proof; finish the sequence, then log run_completed again (finalize judges the LAST run_completed)' };
  }
  if (!r.ok) return { ok: false, unmet: r.unmet || [], reason: String(r.reason || 'the completion sequence was not met') + ' — finish the open step(s), then log run_completed again (finalize judges the LAST run_completed)' };
  return { ok: true, applicable: true };
}

/** withCompletionProof(root, out, entries) — Codex R2/N03b + N06: `completion_proof` on a HISTORICAL
 *  verdict is the cutoff-aware answer of forge-runcontract completionProofOf(), so plan, doctor and the Command
 *  Center gateway read ONE value: true for a re-verified record, or for an allowlist-authenticated legacy record of
 *  a run that started before completion_proof.enforcement_cutoff; false for every unverified-archival or other
 *  unauthenticated record, whatever the run date. When the contract module cannot be loaded the reverified-only
 *  answer verdictForAcceptance() set stands (the stricter one). Mutates and returns `out`. */
function withCompletionProof(root, out, entries) {
  if (!out || out.verdict !== 'HISTORICAL') return out;
  let RC;
  try { RC = require(path.join(__dirname, 'forge-runcontract.cjs')); } catch { return out; }
  if (typeof RC.completionProofOf !== 'function') return out;
  try {
    const start = typeof RC.runStartedAt === 'function' ? RC.runStartedAt(Array.isArray(entries) ? entries : [], null) : null;
    let rules = null;
    try { rules = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8').replace(/^﻿/, '')); } catch { rules = null; }
    const cutoff = typeof RC.completionProofCutoffOf === 'function' ? RC.completionProofCutoffOf(rules) : undefined;
    const proof = RC.completionProofOf(out, start ? start.ms : null, cutoff);
    out.completion_proof = proof.ok === true;
    out.archival = proof.archival === true;
    out.pre_cutoff = proof.pre_cutoff === true;
    out.completion_proof_reason = String(proof.reason || '').slice(0, 400);
  } catch { /* keep the reverified-only answer */ }
  return out;
}

function readReceipt(root, runId) {
  try { return JSON.parse(fs.readFileSync(receiptFileOf(root, runId), 'utf8')); } catch { return null; }
}
function readReceiptBytes(root, runId) {
  try { return fs.readFileSync(receiptFileOf(root, runId)); } catch { return Buffer.alloc(0); }
}
/** isFailureCloseEvent / failureCloseLabel — F04: the ONE shared predicate lives in forge-runcontract.cjs. When
 *  that module cannot be loaded, a run_completed is treated as a failure close ONLY by that module's exported
 *  regex — there is no second copy here; unloadable means "cannot judge", and finalize's other paths already
 *  refuse without the contract checker. */
function isFailureCloseEvent(e) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    return typeof RC.isFailureClose === 'function' ? RC.isFailureClose(e) : false;
  } catch { return false; }
}
function failureCloseLabel(e) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    const f = (RC.FAILURE_CLOSE_FIELDS || []).find((k) => typeof e[k] === 'string' && RC.FAILURE_CLOSE_RE.test(e[k].trim()));
    return f ? f + '=' + JSON.stringify(e[f]) : 'faalstatus';
  } catch { return 'faalstatus'; }
}
/** receiptState — r5 #7/#11: onderscheid AFWEZIG (nooit gefinaliseerd) van ONLEESBAAR/ONGELDIG
 *  (fail-closed: een corrupt of zelfgeschreven receipt is nooit stilzwijgend "geen receipt" of
 *  "geldig"). Een geldig receipt draagt run_id-binding, digest/bytes en contract:'ok'. */
function receiptState(root, runId) {
  const file = receiptFileOf(root, runId);
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { state: 'absent' }; }
  const raw = buf.toString('utf8');
  let r;
  try { r = JSON.parse(raw); } catch { return { state: 'invalid', reason: 'receipt is onparseerbaar (fail-closed)' }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { state: 'invalid', reason: 'receipt is geen object' };
  if (r.run_id !== runId) return { state: 'invalid', reason: 'receipt draagt run_id ' + String(r.run_id).slice(0, 40) + ', niet ' + runId };
  if (typeof r.digest !== 'string' || r.digest.length !== 64 || !Number.isFinite(r.bytes)) return { state: 'invalid', reason: 'receipt mist een geldige digest/bytes-pin' };
  if (r.contract !== 'ok') return { state: 'invalid', reason: 'receipt claimt geen groen contract' };
  /** R5-06 (vijfde herreview): de evidence- en rulesetvergelijkingen in check() draaiden alleen ALS de
   *  receipt die pins al droeg — en receiptState eiste ze niet. Een legacy of zelfgeschreven receipt zonder
   *  beide pins kreeg dus gewoon FINALIZED en sloeg alle nieuwe controles over. Een conditionele controle
   *  op een veld dat je niet verplicht stelt, is geen controle. Vanaf schema 2 zijn ze verplicht en
   *  welgevormd; een receipt zonder die binding is ONGELDIG, niet "oud maar goed". */
  if (r.schema !== 2) return { state: 'invalid', reason: 'receipt draagt schema ' + JSON.stringify(r.schema) + ' — alleen schema 2 bindt bewijs en regelset, dus een oudere receipt is niet te vertrouwen' };
  /** the LEGACY generation — schema 2 receipts written before finalize pinned evidence
   *  and code (4 real receipts here, 2026-08-06..09) carry NONE of evidence_digest, code_commit and
   *  independent_verification, and DO carry a well-formed ruleset_sha256. Exactly that shape is 'legacy'
   *  (check() -> HISTORICAL with reverified:false, never FINALIZED); a receipt with only SOME of those
   *  fields stripped is not a generation that ever existed and stays 'invalid' below (R5-06 unchanged). */
  const heeft = (k) => Object.prototype.hasOwnProperty.call(r, k);
  /** that shape is 'legacy' ONLY when this exact receipt (run id + sha256 of its bytes) is on
   *  the checked-in allowlist as generation 'pre-evidence'. A NEW receipt with the three fields stripped used to
   *  become an unfalsifiable HISTORICAL record; it is now invalid (STALE), like every other receipt that lacks
   *  the binding fields. */
  const allowlisted = allowlistedReceipt(root, runId, buf);
  if (!heeft('evidence_digest') && !heeft('code_commit') && !heeft('independent_verification')
      && typeof r.ruleset_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(r.ruleset_sha256)) {
    if (allowlisted && allowlisted.generation === 'pre-evidence') return { state: 'legacy', receipt: r, allowlisted };
    return { state: 'invalid', reason: 'receipt mist evidence_digest/code_commit/independent_verification en staat NIET (met deze exacte bytes) op de legacy-allowlist ' + LEGACY_RECEIPTS_REL + ' — een receipt die aan geen bewijs gebonden is, is geen eindverdict, en "oud" is alleen wat de allowlist authenticeert' };
  }
  if (typeof r.evidence_digest !== 'string' || !/^[0-9a-f]{64}$/i.test(r.evidence_digest)) return { state: 'invalid', reason: 'receipt mist een welgevormde evidence_digest — het oordeel is dan aan geen bewijsset gebonden' };
  if (typeof r.ruleset_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(r.ruleset_sha256)) return { state: 'invalid', reason: 'receipt mist een welgevormde ruleset_sha256 — onbekend tegen welke regels het oordeel gold' };
  /** R9-04 (negende herreview): code_commit werd wel GESCHREVEN maar door niets geeist of vergeleken —
   *  receiptState liet hem weg, de idempotente herbevestiging keek er niet naar. Een pin die geen enkele
   *  ingang controleert, bindt niets; dat is exact hetzelfde patroon als R8-03 een laag hoger. */
  /** D2 fix (fresh-laptop re-audit) — a genuinely git-less project could never
   *  finalize at all: `code_commit` was required to be a well-formed 40-hex sha UNCONDITIONALLY, even
   *  though a project with no versioning concept has nothing to bind to (see canonicalEvidenceDigest's own
   *  D2 fix in forge-runcontract.cjs). `code_commit: null` is now accepted, but ONLY when an INDEPENDENT,
   *  LIVE probe of the CURRENT root (headProbeOf — never a flag the receipt or the run itself wrote)
   *  confirms there really is no git repository here right now. A receipt claiming `code_commit: null` on
   *  a root that DOES have git is refused as invalid, never trusted at face value. Every other project
   *  keeps the exact 40-hex requirement, unchanged. */
  if (r.code_commit === null) {
    const probe = headProbeOf(root);
    if (!probe.ok) return { state: 'invalid', reason: 'receipt claimt code_commit:null (no-git), maar de git-staat van deze root kon niet onafhankelijk worden vastgesteld (' + probe.reason + ') — zonder die controle wordt een no-git-claim niet vertrouwd' };
    if (probe.commit !== null) return { state: 'invalid', reason: 'receipt claimt code_commit:null (no-git), maar deze root heeft wél een git-repository (HEAD ' + probe.commit.slice(0, 12) + '…) — dat kan uit een eerlijke no-git-meting nooit komen' };
  } else if (typeof r.code_commit !== 'string' || !/^[0-9a-f]{40}$/i.test(r.code_commit)) {
    return { state: 'invalid', reason: 'receipt mist een welgevormde code_commit — onbekend op welke code het bewijs draaide' };
  }
  return { state: 'valid', receipt: r, allowlisted };
}

/** check — het ene eindverdict voor consumenten (herbouwd, r4 #10-rest): de receipt pint de VOLLEDIGE
 *  log inclusief het run_finalized-slotevent, dus het verdict is een EXACTE digest+bytes-match plus een
 *  keten-valide log. Truncatie, aangroei, bewerking of een vervalste extra run_finalized-regel wijzigt de
 *  bytes of breekt de keten ⇒ STALE. Er bestaat geen "toegestane staart" meer om te vervalsen. */
function check(root, runId) {
  const rs = receiptState(root, runId);
  if (rs.state === 'absent') return { verdict: 'NOT_FINALIZED', reason: 'geen run-finalized.json receipt' };
  if (rs.state === 'invalid') return { verdict: 'STALE', reason: 'receipt ongeldig: ' + rs.reason + ' — fail-closed (r5 #7)' };
  const receipt = rs.receipt;
  const cls = classify(root, runId);
  if (cls.status === 'missing') return { verdict: 'STALE', receipt, reason: 'receipt aanwezig maar de eventlog ontbreekt' };
  if (cls.status !== 'valid') {
    return { verdict: 'STALE', receipt, reason: 'eventlog is ' + cls.status + ' — het gefinaliseerde bewijs is niet meer keten-integer' };
  }
  // r5 #7: de log moet ook INHOUDELIJK de gefinaliseerde vorm hebben — het exacte slotevent als laatste
  // regel. Een pre-r5-receipt (zonder slotevent-in-digest) valt hierdoor eerlijk op STALE en vergt een
  // bewuste herfinalizatie, nooit een stilzwijgende acceptatie onder oude semantiek.
  const last = cls.entries[cls.entries.length - 1];
  if (!last || last.event_type !== 'run_finalized') {
    return { verdict: 'STALE', receipt, reason: 'de log eindigt niet op het run_finalized-slotevent (laatste: ' + (last ? last.event_type : 'geen') + ') — geen geldige gefinaliseerde vorm' };
  }
  let d = null;
  try { d = digestOf(eventsFileOf(root, runId)); } catch { return { verdict: 'STALE', receipt, reason: 'eventlog onleesbaar' }; }
  if (d.digest !== receipt.digest || d.bytes !== receipt.bytes) {
    return { verdict: 'STALE', receipt, reason: 'de log matcht de receipt niet meer exact (digest/bytes gewijzigd — afgekapt, aangegroeid of bewerkt)' };
  }
  /** a receipt over a run whose terminal run_completed is an honest FAILURE close claims a completion the
   *  run itself never claimed — never accepted, whatever else matches. */
  const lastCompleted = [...cls.entries].reverse().find((e) => e.event_type === 'run_completed');
  if (lastCompleted && isFailureCloseEvent(lastCompleted)) {
    return { verdict: 'STALE', receipt, reason: 'de receipt ligt over een FAALAFSLUITING (run_completed met ' + failureCloseLabel(lastCompleted) + ') — zo\'n run claimt geen afronding, dus een receipt erover is ongeldig' };
  }
  /** SCRIBE BINDING: an append to the owner-requests ledger after finalize is fine; an edit, truncation or
   *  deletion of the pinned prefix, or a receipt whose binding was removed, is STALE (see the file header). */
  const sb = scribeBindingOf(root, receipt, last, { runId, events: cls.entries });
  if (!sb.ok) return { verdict: 'STALE', receipt, reason: 'scribe binding: ' + sb.reason };
  /** V22 (2026-09-24 second Codex recheck, out-p7.md) — the evidence/ruleset/HEAD/domain/contract
   *  acceptance checks that used to live here inline (FINALIZE-STALE-CODE, RECEIPT-FORGERY)
   *  are now ONE shared judgement (`evaluateAcceptance`, also used by the idempotent finalize path) so the
   *  two entry points can never again disagree about the same receipt. Ordering matters: `evaluateAcceptance`
   *  re-runs the contract BEFORE ever reporting `historical` — a receipt whose commit/domain has drifted
   *  AND whose contract is currently red is reported as the real failure (STALE), never masked behind a
   *  softer-sounding HISTORICAL. */
  // a legacy-generation receipt has nothing beyond the log (re-verified just above) to re-verify.
  // a HISTORICAL verdict carries the cutoff-aware completion_proof (withCompletionProof).
  if (rs.state === 'legacy') return withCompletionProof(root, verdictForAcceptance(legacyAcceptance(root, runId, receipt), receipt), cls.entries);
  return withCompletionProof(root, verdictForAcceptance(evaluateAcceptance(root, runId, receipt, { allowlisted: rs.allowlisted || null }), receipt), cls.entries);
}

/** verdictForAcceptance(acceptance, receipt) -> the final {verdict, ...} object check() returns for a given
 *  evaluateAcceptance() result. F6 fix (2026-09-26 independent review, NOTE): this used to be an inline
 *  if/if/if chain that only NAMED the statuses to REJECT (fail/historical/undetermined) and let everything
 *  else — including any status this code has never seen, past or future — fall through to the strongest
 *  verdict, FINALIZED. Extracted as its own function and inverted: FINALIZED is returned ONLY for the exact
 *  known-good status `'current'`; every other value, known or not, is mapped explicitly, with an unknown
 *  status treated the same as `'undetermined'` (honest, non-committal) rather than trusted as green. Exported
 *  so this mapping can be tested directly against a synthetic/future status, independent of a real
 *  evaluateAcceptance() run (evaluateAcceptance() itself only ever returns the four known values today). */
function verdictForAcceptance(acceptance, receipt) {
  if (acceptance.status === 'fail') {
    return { verdict: 'STALE', receipt, reason: acceptance.reason };
  }
  if (acceptance.status === 'historical' || acceptance.status === 'unverified-archival') {
    /** 'unverified-archival' — an intact record (log, evidence manifest and commit
     *  match) whose rules or raw outputs cannot be reproduced and which no allowlist authenticates — is
     *  reported under the HISTORICAL verdict an older consumer already knows, with cause 'unverified-archival',
     *  reverified:false and completion_proof:false. The plan and the doctor refuse it as a completion proof for
     *  an enforcement-era run (forge-runcontract completionProofOf); an older doctor keeps treating it as it
     *  treated every HISTORICAL — no regression, no new verdict string in the fleet. */
    const out = {
      verdict: 'HISTORICAL', receipt, reason: acceptance.reason,
      code_commit_then: acceptance.code_commit_then, code_commit_now: acceptance.code_commit_now,
      domain_then: acceptance.domain_then, domain_now: acceptance.domain_now,
      cause: acceptance.cause || (acceptance.status === 'unverified-archival' ? 'unverified-archival' : undefined),
      reverified: acceptance.reverified === true,
      completion_proof: acceptance.reverified === true,
      archival: acceptance.reverified !== true,
    };
    /** WHY it is historical (cause) and whether the contract was re-judged under its own rules
     *  (reverified) — copied only when present, so the long-standing four fields above keep their shape. */
    for (const k of ['legacy_receipt', 'evidence_canon', 'allowlisted', 'judged_under', 'pinned_ruleset', 'unverified_gates', 'ruleset_then', 'ruleset_now', 'ruleset_version_then', 'ruleset_version_now', 'contract_under_current_ruleset', 'contract_under_pinned_ruleset']) {
      if (acceptance[k] !== undefined) out[k] = acceptance[k];
    }
    return out;
  }
  if (acceptance.status === 'current') {
    /** ook de UITSLAG draagt de caveat, niet alleen de receipt — een consument die alleen
     *  `verdict` leest, mag de owner-gated beperking niet mislopen. */
    return Object.assign({
      verdict: 'FINALIZED', receipt, completion_proof: true, archival: false,
      evidence_pinned: typeof receipt.evidence_digest === 'string' && !!receipt.evidence_digest,
      independent_verification: receipt.independent_verification || { available: false, reason: 'receipt van vóór deze pinning', label_only: true },
      label_only: true,
    }, acceptance.evidence_canon !== undefined ? { evidence_canon: acceptance.evidence_canon } : {});
  }
  /** Also-noted fix (2026-09-26 independent review) + F6: `'undetermined'`, AND any status this function
   *  does not recognize at all, both land here. Neither STALE (we have no evidence it is actually wrong) nor
   *  HISTORICAL (we have no evidence the commit drifted) nor FINALIZED (we have no confirmed-current
   *  acceptance) is honest for either case — a dedicated, non-committal verdict says plainly that this
   *  outcome was not positively confirmed. */
  const known = acceptance.status === 'undetermined';
  return {
    verdict: 'UNDETERMINED', receipt,
    reason: known ? acceptance.reason
      : 'onbekende acceptance-status ' + JSON.stringify(acceptance.status) + ' (verwacht: fail/historical/undetermined/current) — dit eindverdict wordt niet vertrouwd als FINALIZED zonder een herkende positieve bevestiging',
  };
}

// evaluateAcceptance/receiptState/rulesetPinOf exported (additive) — the audit's S5 proposal has
// consumers read the acceptance status (current/historical/fail) instead of re-running check() themselves.
module.exports = {
  finalize, check, readReceipt, receiptFileOf, classify, verdictForAcceptance, evaluateAcceptance, receiptState, rulesetPinOf,
  // the legacy-receipt allowlist and the pinned-ruleset copy
  loadLegacyReceipts, allowlistedReceipt, legacyReceiptsFileOf, pinnedRulesetOf, rulesetPinnedFileOf,
  LEGACY_RECEIPTS_REL, LEGACY_RECEIPTS_SCHEMA, LEGACY_GENERATIONS, RULESET_PINNED_FILE, isFailureCloseEvent,
  // Codex R2 class-A fixes: finalize's own completion-sequence re-check and the cutoff-aware
  // completion_proof on a HISTORICAL verdict.
  completionSequenceRecheck, withCompletionProof,
  // part ii: the owner-requests (scribe) ledger binding.
  scribePinOf, scribeBindingOf, scribeFieldsOf, SCRIBE_LEDGER_REL, SCRIBE_PIN_FIELDS,
  // SC-08 strip detection and SC-05 reconciliation re-check.
  runHadScribeItems, reconcileBindingOfRun,
  // Codex R5 SV-05: a scribe-active run needs a current FINAL reconciliation at finalize.
  scribeActiveReason,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const get = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
  const root = get('root') ? path.resolve(get('root')) : PROJECT_ROOT_DEFAULT;
  const runId = get('run');
  const asJson = args.includes('--json');
  if (!cmd || !runId || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    console.error('usage: node forge-finalize.cjs finalize|check --run <id> [--root <projectRoot>] [--json]');
    process.exit(2);
  }
  if (cmd === 'finalize') {
    const r = finalize(root, runId);
    console.log(asJson ? JSON.stringify(r, null, 2) : (r.ok ? 'FINALIZED — ' + runId + ' @ ' + r.receipt.digest.slice(0, 16) + '… (' + r.receipt.events + ' events' + (r.idempotent ? ', idempotente herbevestiging' : '') + ')' : 'REFUSED — ' + r.reason));
    process.exit(r.ok ? 0 : 3);
  }
  if (cmd === 'check') {
    const r = check(root, runId);
    console.log(asJson ? JSON.stringify(r, null, 2) : r.verdict + (r.reason ? ' — ' + r.reason : ''));
    process.exit(r.verdict === 'FINALIZED' ? 0 : 3);
  }
  console.error('unknown command: ' + cmd);
  process.exit(2);
}
