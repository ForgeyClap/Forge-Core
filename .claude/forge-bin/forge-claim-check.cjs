#!/usr/bin/env node
'use strict';
/**
 * forge-claim-check.cjs — an absolute "everything was verified" claim in a report must match the run ledger
 * (owner standing rule P-000094: every mistake gets an automated guard).
 *
 * THE MISTAKE (twice on 2026-11-02: a run's final-report.md, then the project-level EINDRAPPORT of that day in docs): a
 * report said EVERY package/change was independently verified and reviewed while the run's events.jsonl held
 * exceptions. Such a sentence is honest only when the ledger has no exception or the sentence/paragraph names them.
 *
 * HEURISTIC — read this first. A word-window detector, not a parser: it catches the phrasings below and was tuned on
 * every real report in this repo (forge-claim-check.test.cjs sections I/J hold the real lines), but a determined
 * writer can phrase around it. The owner's text rule ("never write every/all about verification or reviews without
 * listing the ledger's exceptions") cannot be fully machine-checked; the self-review and the Lead's reading remain.
 *
 * A CLAIM is one sentence (fenced code, inline code, a quotation after a distancing word such as claimed / wrote /
 * schreef / letterlijk / /goal / Owner-opdracht, and a blockquote right under a line that says it quotes — letterlijk,
 * verbatim, owner, goal, opdracht — are data) holding:
 *   a QUANTIFIER: every, all, each, always, everything, everyone, elk(e), alle, altijd, ieder(e), allemaal, alles,
 *     iedereen, 100 %, without fail, without exception, stuk voor stuk, zonder uitzondering;
 *   + a WORK UNIT it governs: package, work package, change, wp, commit, fix, pakket, codepakket, wijziging, and
 *    task/taak/taken, ticket, deliverable, onderdeel, item, step/stap, feature, "all work" / "al het werk"
 *     ("work"/"werk" only right after all/the/het/de and not before "event(s)/log(s)"; "taken" only with a Dutch
 *     quantifier — "were taken and reviewed" is English) (up to 4 words after a determiner, up to 6 before a floating
 *     "always/allemaal/..."; after every/each/elk/ieder a PLURAL unit is a verb unless "of/van" comes first);
 *     "everything"/"alles" carry their own unit; a LANE counts only with a strong verdict word; in a table row the
 *     unit or verdict must sit in the quantifier's own cell;
 *   + a VERIFICATION word from 6 words before to 12 after the quantifier, NOT cut at commas or parentheses: strong =
 *     verify/verified/verification/verifier, review(ed)/reviewer, Verify/Review Boss, geverifieerd, verificatie,
 *     gereviewd/gereviewed, getoetst, (goed)gekeurd, approved, a PASS / PASS_WITH_NOTES label; weak (not for lanes) =
 *     checked, gecontroleerd, gecheckt, nagekeken. A hyphen compound counts by its joined form or last part
 *     ("code-reviewed" yes, "verify-protect" no); a verification word right before "suite" names a test suite.
 *   Boundaries: bare independent(ly)/onafhankelijk never counts ("All four lanes ran independently" is no claim); no
 *   work unit = a PROCESS statement ("The verifier always runs", "Every new skill was checked for hidden commands");
 *   a process statement that names packages ("the verifier checks every package") IS judged; a quantifier whose next
 *   3 words name tests before any unit is a tally ("every test passed", "alle tests groen"), judged by gate evidence.
 * A claim is QUALIFIED only by something that qualifies IT: a hedge or negation right before the quantifier (almost,
 *   nearly, bijna, vrijwel, nagenoeg, not, niet); a modal before its verdict word (will, would, must, zou, moet ... =
 *   a requirement or a plan, not a result); every non-role verification word negated ("was not verified"); an honest
 *   negative label in the window (FAIL, BLOCK(ED), REJECTED, afgekeurd — not "0 FAIL", "no FAIL", "without a single
 *   FAIL"); an exception in its own sentence (except, excluding, apart from, other than, behalve, uitgezonderd,
 *   exception(s), uitzondering(en); "all except" counts; "no/without/zonder/geen exception(s)" and "every exception"
 *   do not, and neither does a list that says there are none — "(exceptions: none / geen / nothing / niets / n/a /
 *   nvt / 0 / -)", "except nothing", "behalve niets"); or another sentence of its paragraph that starts with an
 *   exception marker ("Exceptions: ...") or names a ledger exception wp id next to an exception word, or
 *   names a ledger exception wp id in the same sentence as a failure word (FAIL/failed/BLOCK/rejected/afgekeurd/
 *   reworked/hersteld/skipped or a negated verification word — not "0 FAIL" / "nothing failed") without the word
 *   exception. Qualifiers are read with every balanced double-quoted span blanked: a quoted list literal in prose
 *   ('an empty "(exceptions: none)" still counts') is never THIS paragraph's exception list, while a quoted claim
 *   stays a claim unless it follows a distancing word. An unrelated "not" ("by Verify Boss, not by its builder") or a
 *   modal far before the claim clears nothing.
 *   LIMIT of the heuristic (unchanged in kind): word lists and windows, no grammar. A new noun for a work
 *   unit, a failure word outside the list, or an exception named two paragraphs away is not seen; a quoted claim after
 *   a distancing word is data even when the writer meant it. Add the phrasing and its test (sections I/J/N) when a
 *   real report shows one.
 *
 * LEDGER EXCEPTIONS (events.jsonl, in file order):
 *   wp_failed             a wp_failed never cleared by a later wp_verified PASS of the same wp (without a wp_id: always);
 *   completed-after-fail  a FAIL verdict (wp_verified, review_completed or any event with wp_id + verdict FAIL) followed
 *                         by work (wp_completed, file_changed, a commit) and never cleared by a PASS of the same kind;
 *   committed-before-pass a commit for the wp between a FAIL (or wp_failed) and the PASS that cleared it;
 *   not-verified          a wp with a wp_completed and no wp_verified PASS at all (incl. "verified via sub-packages").
 *   Boundaries (real data): FAIL -> fix -> wp_completed -> PASS is no exception; PASS -> commit -> wp_completed is
 *   integration bookkeeping, no exception (RED-SUITES, 2026-11-02 replay).
 *
 * THE REPORTS OF A RUN (checkReports / --all-reports; used by forge-endreview record and forge-finalize) are chosen by
 * the sibling forge-claim-reports.cjs, the ONE entry point: <run>/final-report.md, reports named by the run's
 * report/prd events, docs/**\/EINDRAPPORT*.md + docs/**\/*final*report*.md changed during the run. That sibling
 * missing = checkReports cannot judge (code 2, fail-closed).
 *
 * SEALED DRIFT (the Lead's replay): a report edited AFTER its run was sealed (run-finalized.json) was never
 * judged again — finalize and endreview run before the seal. sealedDrift({root, runId|runDir}) reads the receipt's
 * finalized_at, takes the run's reports (the same selection as --all-reports), asks forge-claim-reports.changedAfter
 * which of them changed after the seal (when the root is a git top level: a commit strictly after the SEAL COMMIT —
 * the commit that added the receipt; the Lead commits receipt and report together seconds after the seal, which is
 * bookkeeping, not drift — or a dirty file; a tracked, clean report whose mtime a checkout touched is NOT drift;
 * an uncommitted receipt or no git: by time and mtime, 2 s slack) and re-judges
 * those with the completeness rule (every ledger exception id named). sealedDriftAll({root}) does it for every run
 * folder holding a receipt. Read-only; the receipt holds no report hash, so the seal TIME is the reference.
 * WIRING: CLI --sealed-drift [--run <id>] below (exit 0 · 3 drift that fails · 2 cannot judge). forge-doctor is NOT
 * wired by this file (not its owner): the Lead adds one ADVISORY_CHECKS row in forge-doctor.cjs,
 *   claim_sealed_drift: ({ root }) => advisorySafe('claim_sealed_drift', () => require('./forge-claim-check.cjs').sealedDriftAll({ root })),
 * whose result already carries {ok, status, summary, runs, findings} in the advisory shape.
 *
 * API: check(text, events) -> {ok, claims[], findings[{line, text, reason}], exceptions[]} · ledgerExceptions(events)
 *      checkReports({root, runId | runDir, events?}) -> {code, ok, reports[], findings[{file, line, text, reason}], ...}
 *      checkRun({root, runId | runDir, report?}) -> one report · reportsForRun = forge-claim-reports.cjs (or null)
 *      sealedDrift({root, runId | runDir}) -> {code, ok, sealed, finalized_at, drifted[], findings[], ...}
 *      sealedDriftAll({root}) -> {code, ok, status, summary, sealed_runs, drifted, runs[], findings[], problems[]}
 * CLI: node forge-claim-check.cjs --run <id> [--report <path> | --all-reports] [--root <dir>] [--json]
 *      node forge-claim-check.cjs --sealed-drift [--run <id>] [--root <dir>] [--json]
 *      exit 0 ok · 3 an unqualified absolute claim meets ledger exceptions · 2 usage / cannot judge
 * Optional, guarded forge-paths.cjs (run folder layout). Linear time: words are split once, windows are bounded.
 */
const fs = require('fs'), path = require('path');

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const REPORT_FILE = 'final-report.md';
const WIN_BEFORE = 6, WIN_AFTER = 12, UNIT_AFTER = 4, TALLY_LOOK = 3, MAX_TOKEN = 60, MAX_QUOTE = 300, MAX_IDS = 12;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const PASS_RE = /^\s*pass/i, FAIL_RE = /^\s*fail/i;
const ABBREV_RE = /(?:^|[\s(])(?:e\.g|i\.e|bv|vs|nr|zgn|o\.a|d\.w\.z|etc)$/i;
// word lists, matched on normalised words (lower case, outer punctuation and a trailing 's stripped)
const QUANT = new Set(['every', 'all', 'each', 'always', 'everything', 'everyone', 'elk', 'elke', 'alle', 'altijd', 'ieder', 'iedere', 'allemaal', 'alles', 'iedereen', '100%']);
const QUANT_PHRASES = [['without', 'fail'], ['without', 'exception'], ['stuk', 'voor', 'stuk'], ['zonder', 'uitzondering'], ['100', '%'], ['100', 'procent'], ['100', 'percent'], ['al', 'het'], ['al', 'de']];
const NL_QUANT = new Set(['elk', 'elke', 'alle', 'altijd', 'ieder', 'iedere', 'allemaal', 'alles', 'iedereen', 'al', 'stuk', 'zonder']); // a Dutch quantifier: "taken" is then a noun
const AFTER_ONLY = new Set(['every', 'ieder', 'iedere', 'everyone', 'iedereen', '100%', '100']); // determiners: the unit follows
const BEFORE_ONLY = new Set(['always', 'altijd', 'allemaal', 'without', 'stuk', 'zonder']); // floating: the unit precedes
const SINGULAR_DET = new Set(['every', 'each', 'elk', 'elke', 'ieder', 'iedere']); // + a plural unit = a verb, unless "of"
const SELF_UNIT = new Set(['everything', 'alles']);
const UNIT_RE = /^(?:(?:work|sub)?packages?|changes?|wps?|commits?|fix|fixes)$|pakket(?:ten)?$|wijziging(?:en)?$/;
// round 3 (Review Boss round 2, MEDIUM): the wider work-unit list; "work"/"werk" and "taken" are gated in unitAt()
const UNIT2_RE = /^(?:tasks?|taak|taken|tickets?|deliverables?|onderdeel|onderdelen|items?|steps?|stap|stappen|features?)$/;
const WORK_RE = /^(?:work|werk)$/, WORK_PREV = new Set(['all', 'the', 'het', 'de']), WORK_COMPOUND = new Set(['event', 'events', 'log', 'logs']);
const ANY_UNIT_RE = new RegExp(UNIT_RE.source + '|' + UNIT2_RE.source);
// an exception list that says there are none ("(exceptions: none)", "uitzonderingen: geen", "except nothing", "n/a", "-")
const EMPTY_LIST = new Set(['none', 'geen', 'nothing', 'niets', 'nil', 'nihil', 'niemand', 'nobody', 'nvt', 'n.v.t', 'zero', '0']);
// a failure word that, in one sentence with a ledger exception wp id, names that exception without the word "exception"
const FAILURE_RE = /^(?:fail(?:ed|s|ing)?|block(?:ed)?|rejected|afgekeurd|gefaald|gezakt|rework(?:ed)?|hersteld|herstelronde|skipped|overgeslagen|unverified|ongeverifieerd)$/;
const LANE_RE = /^lanes?$/;
const TEST_NOUN_RE = /^(?:(?:unit|e2e)?tests?|(?:test)?suites?|assertions?|(?:test)?cases?|toetsen|specs?|checks?|gates?)$/;
const STRONG_RE = /^(?:re)?(?:verif(?:y|ied|ies|ication|ier|iers)|review(?:s|ed|er|ers)?)$|^(?:ge|her)verifieerd$|^verificatie$|^gereview(?:d|ed)$|^getoetst$|^(?:goed)?gekeurd$|^approved$/;
const WEAK_RE = /^(?:re)?checked$|^gecontroleerd$|^gecheckt$|^nagekeken$/;
const PASS_LABEL_RE = /^PASS(?:ED|_WITH_NOTES)?$/;
const NEG_LABEL_RE = /^(?:FAIL(?:ED|S)?|BLOCK(?:ED)?|REJECTED)$/;
const NEG_NL = new Set(['afgekeurd', 'gefaald', 'gezakt']);
const NEG = new Set(['not', 'niet', 'never', 'nooit']);
const NO_WORDS = new Set(['no', 'zero', '0', 'geen', 'zonder', 'without', 'never', 'nooit', 'not', 'niet', 'nothing', 'none', 'niets', 'nobody', 'niemand']);
const ANY_WORDS = new Set(['any', 'a', 'one', 'single', 'enige', 'een', 'één', 'other', 'andere']);
const HEDGE = new Set(['almost', 'nearly', 'bijna', 'vrijwel', 'nagenoeg']);
const EXC_RE = /^(?:except|excluding|behalve|uitgezonderd|exceptions?|uitzonderingen|uitzondering)$/;
const EXC_NOUN_RE = /^(?:exceptions?|uitzonderingen|uitzondering)$/; // "every exception" is no exception list
const MODAL = new Set(['would', 'should', 'must', 'will', 'shall', 'need', 'needs', 'require', 'requires', 'zou', 'zouden', 'moet', 'moeten', 'zal', 'zullen', 'dient', 'dienen', 'vereist', 'eist', 'eisen']);
const SUITE_RE = /^(?:test)?suites?$/;
const CLOSERS = '*_"' + "'" + ')]' + '\u201D\u2019';
const QUOTE_INTRO_RE = /letterlijk|verbatim|literal|quot|citaat|owner|eigenaar|opdracht|missi|goal|asked|vroeg|prompt/i;
const REPORTED = new Set(['claimed', 'claims', 'claim', 'said', 'says', 'wrote', 'writes', 'write', 'stated', 'states', 'quoted', 'quote', 'called', 'sentence', 'phrase', 'wording', 'text', 'beweerde', 'beweert', 'claimde', 'claimt', 'schreef', 'schrijft', 'zei', 'zegt', 'luidde', 'luidt', 'noemde', 'zin', 'tekst',
  'letterlijk', 'verbatim', 'literally', 'goal', 'doel', 'opdracht', 'owneropdracht', 'ownerdirective', 'directive', 'asked', 'vroeg', 'request', 'verzoek', 'instruction', 'instructie', 'mission', 'missie', 'prompt']);
const QUOTE_OPEN = '"\u201C\u201E', QUOTE_CLOSE = '"\u201D\u201C';
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.layout === 'function' ? m : null; } catch { return null; } })();
const defaultRoot = () => (process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..'));
// the report selection (run report, event-named reports, docs reports changed during the run); required, fail-closed
const R = (() => { try { const m = require('./forge-claim-reports.cjs'); return m && typeof m.reportsForRun === 'function' ? m : null; } catch { return null; } })();

/** runDirFor(root, runId) — same rule as forge-endreview / forge-craft (.forge layout when opted in, else legacy). */
function runDirFor(root, runId) {
  const legacy = path.join(root, '.claude', 'forge-runs', runId);
  let active = legacy;
  try { if (forgePaths && forgePaths.layout(root) === 'forge') active = path.join(forgePaths.stateDir(root, 'runs'), runId); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; }
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}

/** paragraphs(text) -> [{lines:[{no, text}]}] — blank lines and headings split paragraphs; fenced code is dropped,
 *  inline code spans are blanked (same length, so nothing shifts), and a blockquote right under a line that says it
 *  quotes (QUOTE_INTRO_RE) is dropped; any other blockquote is judged as text. */
function paragraphs(text) {
  const out = []; let cur = null, inFence = false, inBq = false, bqData = false, lastText = '';
  const flush = () => { if (cur && cur.lines.length) out.push(cur); cur = null; };
  String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    if (FENCE_RE.test(raw)) { inFence = !inFence; flush(); return; }
    if (inFence) return;
    if (!raw.trim()) { flush(); inBq = false; return; }
    let src = raw;
    if (/^\s{0,3}>/.test(raw)) {
      if (!inBq) { flush(); bqData = QUOTE_INTRO_RE.test(lastText); }
      inBq = true;
      if (bqData) return;
      src = raw.replace(/^\s{0,3}(?:>\s?)+/, '');
      if (!src.trim()) { flush(); return; }
    } else { if (inBq) flush(); inBq = false; lastText = raw; }
    const line = src.replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length));
    if (/^\s{0,3}#{1,6}\s/.test(line)) { flush(); out.push({ lines: [{ no: i + 1, text: line }] }); return; }
    if (!cur) cur = { lines: [] };
    cur.lines.push({ no: i + 1, text: line });
  });
  flush();
  return out;
}
/** sentences(para) -> [{line, text}] — split after . ! ? ; (and closing * _ " ) ]) followed by white space, and before a new list item or
 *  table row; a plain char scan, no backtracking regex. */
function sentences(para) {
  const segs = [];
  for (const ln of para.lines) {
    const isItem = /^\s*(?:[-*+]|\d+[.)]|\|)\s/.test(ln.text);
    if (!segs.length || isItem) segs.push({ line: ln.no, parts: [{ no: ln.no, text: ln.text.trim() }] });
    else segs[segs.length - 1].parts.push({ no: ln.no, text: ln.text.trim() });
  }
  const res = [];
  for (const seg of segs) {
    let buf = '', line = null;
    for (const part of seg.parts) {
      const t = part.text + ' ';
      for (let k = 0; k < t.length; k++) {
        if (line === null && t[k] !== ' ') line = part.no;
        buf += t[k];
        const c = t[k];
        if (c !== '.' && c !== '!' && c !== '?' && c !== ';') continue;
        let m = k + 1;
        while (m < t.length && CLOSERS.indexOf(t[m]) >= 0) m++;
        const end = m < t.length && (t[m] === ' ' || t[m] === '\t');
        // an ellipsis ("Verify Boss ... PASS") or a short abbreviation (e.g. / i.e. / bv. / o.a.) does not end a sentence
        if (end && !(c === '.' && (t[k - 1] === '.' || ABBREV_RE.test(t.slice(Math.max(0, k - 6), k))))) {
          buf += t.slice(k + 1, m); k = m - 1;
          if (buf.trim()) res.push({ line, text: buf.trim() });
          buf = ''; line = null;
        }
      }
    }
    if (buf.trim()) res.push({ line: line === null ? seg.line : line, text: buf.trim() });
  }
  return res;
}

/** blankQuotes(s, all) — a double-quoted span right after a distancing verb ("first claimed "..."", "schreef "...") is a
 *  quotation: data, blanked. Any other quote stays text ("We can confirm: "every package ..."" is still a claim).
 *  all = true blanks EVERY balanced span (bounded length): the qualifier view, where a quoted list literal in prose
 *  ('an empty "(exceptions: none)" still counts') must never read as this paragraph's exception list. */
function blankQuotes(s, all) {
  if (!/["\u201C\u201D\u201E]/.test(s)) return s;
  const next = new Array(s.length + 1); next[s.length] = -1;
  for (let k = s.length - 1; k >= 0; k--) next[k] = QUOTE_CLOSE.indexOf(s[k]) >= 0 ? k : next[k + 1];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (QUOTE_OPEN.indexOf(s[i]) >= 0) {
      const j = i + 1 < s.length ? next[i + 1] : -1;
      if (j > 0 && j - i <= MAX_QUOTE && (all || reportedBefore(out))) {
        out += ' '.repeat(j - i + 1); i = j; continue;
      }
    }
    out += s[i];
  }
  return out;
}
function reportedBefore(out) {
  return out.slice(-60).split(/\s+/).filter(Boolean).slice(-3).some((w) => REPORTED.has(w.toLowerCase().replace(/[^\p{L}]+/gu, '')));
}

const isWordChar = (c) => /[\p{L}\p{N}%]/u.test(c);
/** tokens(text) -> [{n, r, cell}] — n = normalised word, r = the word with outer punctuation stripped (case kept),
 *  cell = the table cell it sits in (a "|" starts the next one; 0 outside tables). */
function tokens(text) {
  const out = []; let cell = 0, lastDash = false;
  for (const raw of String(text).replace(/\|/g, ' | ').split(/[\s/]+/)) {
    if (!raw) continue;
    if (raw === '|') { cell++; continue; } // a table cell boundary
    if (raw.length > MAX_TOKEN) { out.push({ n: '', r: '', cell }); continue; } // no word is this long; keeps the distance
    const s = raw.replace(/\u2019/g, "'");
    let i = 0, j = s.length;
    while (i < j && !isWordChar(s[i])) i++;
    while (j > i && !(isWordChar(s[j - 1]) || s[j - 1] === '_')) j--;
    const r = s.slice(i, j);
    const n = r.toLowerCase().replace(/'s$/, '');
    if (n) { out.push({ n, r, cell }); lastDash = false; continue; }
    // a token without a word character: a dash-only entry ("exceptions: -", "(uitzonderingen: \u2014)") marks the word
    // before it — 'closed' when a closing bracket follows or the sentence ends there, 'open' when more words follow
    if (out.length && /[-\u2013\u2014]/.test(raw)) { out[out.length - 1].dash = /[)\]]/.test(raw) ? 'closed' : 'open'; lastDash = true; }
  }
  if (lastDash && out.length && out[out.length - 1].dash === 'open') out[out.length - 1].dash = 'closed';
  return out;
}
const partsOf = (n) => { const h = n.lastIndexOf('-'); return h >= 0 ? [n.replace(/-/g, ''), n.slice(h + 1)] : [n]; };
const anyPart = (n, re) => partsOf(n).some((p) => p && re.test(p));
const isNeg = (n) => NEG.has(n) || /n't$/.test(n);
const isPluralUnit = (n) => /(?:s|en)$/.test(n) && anyPart(n, ANY_UNIT_RE);
/** unitAt(toks, k, qi) — the token is a work unit for the quantifier at qi: the core nouns always; the round-3 nouns
 *  with two gates ("taken" only after a Dutch quantifier; "work"/"werk" only after all/the/het/de and not before a
 *  compound such as "work event" — real line "Log every work event before opening a review"). */
function unitAt(toks, k, qi) {
  const n = toks[k].n;
  if (anyPart(n, UNIT_RE)) return true;
  if (anyPart(n, UNIT2_RE)) {
    if (n === 'taken') return NL_QUANT.has(toks[qi].n);
    return true;
  }
  if (WORK_RE.test(n)) return k > 0 && WORK_PREV.has(toks[k - 1].n) && !(k + 1 < toks.length && WORK_COMPOUND.has(toks[k + 1].n));
  return false;
}
const isNegVerdict = (tok) => NEG_LABEL_RE.test(tok.r) || NEG_NL.has(tok.n);
const isRole = (toks, v) => /^(?:verifiers?|reviewers?)$/.test(toks[v].n) || /-boss$/.test(toks[v].n) || (v + 1 < toks.length && toks[v + 1].n === 'boss');
const negatedAt = (toks, v) => /^(?:non|un|niet)-/.test(toks[v].n) || [v - 1, v - 2].some((k) => k >= 0 && isNeg(toks[k].n));
const noBefore = (toks, k) => [k - 1, k - 2, k - 3].some((x) => x >= 0 && NO_WORDS.has(toks[x].n));

function quantAt(toks, i) {
  if (QUANT.has(toks[i].n)) return 1;
  for (const ph of QUANT_PHRASES) if (ph.every((w, k) => i + k < toks.length && toks[i + k].n === w)) return ph.length;
  return 0;
}
/** isTally(toks, j) — the words after a quantifier name tests before any work unit: a test count, not a package claim. */
function isTally(toks, j, qi) {
  for (let k = j; k < Math.min(toks.length, j + TALLY_LOOK); k++) {
    if (unitAt(toks, k, qi) || anyPart(toks[k].n, LANE_RE)) return false;
    if (anyPart(toks[k].n, TEST_NOUN_RE)) return true;
  }
  return false;
}
/** analyse(sentence) -> {toks, claims[{q, qlen, lo, hi, verdicts[]}]} — one entry per quantifier that makes a claim. */
function analyse(text) {
  const toks = tokens(blankQuotes(text));
  const claims = [];
  for (let i = 0; i < toks.length; i++) {
    const qlen = quantAt(toks, i);
    if (!qlen) continue;
    if (isTally(toks, i + qlen, i)) continue;
    const lo = Math.max(0, i - WIN_BEFORE), hi = Math.min(toks.length, i + qlen + WIN_AFTER);
    const uLo = AFTER_ONLY.has(toks[i].n) ? i + qlen : lo, uHi = BEFORE_ONLY.has(toks[i].n) ? i : Math.min(toks.length, i + qlen + UNIT_AFTER);
    // the unit or a verdict word must sit in the quantifier's own table cell (a row is not one sentence)
    let unit = false, lane = false, ofBefore = false, sameCell = SELF_UNIT.has(toks[i].n); const strong = [], weak = [];
    for (let k = lo; k < hi; k++) {
      if (k >= i && k < i + qlen) continue;
      const n = toks[k].n, here = toks[k].cell === toks[i].cell;
      if (k > i && (n === 'of' || n === 'van')) ofBefore = true;
      if (k + 1 < toks.length && SUITE_RE.test(toks[k + 1].n)) continue; // a "verification suite" is a test suite
      if (PASS_LABEL_RE.test(toks[k].r) || anyPart(n, STRONG_RE)) { strong.push(k); sameCell = sameCell || here; }
      else if (anyPart(n, WEAK_RE)) { weak.push(k); sameCell = sameCell || here; }
      if (k < uLo || k >= uHi) continue;
      if (k > i) { if (SINGULAR_DET.has(toks[i].n) && isPluralUnit(n) && !ofBefore) continue; }
      if (unitAt(toks, k, i)) { unit = true; sameCell = sameCell || here; } else if (anyPart(n, LANE_RE)) { lane = true; sameCell = sameCell || here; }
    }
    if (!sameCell) continue;
    const hasUnit = SELF_UNIT.has(toks[i].n) || unit;
    if ((hasUnit && (strong.length || weak.length)) || (lane && strong.length)) claims.push({ q: i, qlen, lo, hi, verdicts: strong.concat(weak) });
  }
  return { toks, claims };
}
const isClaim = (text) => analyse(text).claims.length > 0; // an absolute verification claim, qualified or not

function isExceptionMarker(toks, k) {
  const n = toks[k].n, nx = k + 1 < toks.length ? toks[k + 1].n : '';
  return EXC_RE.test(n) || (n === 'apart' && nx === 'from') || (n === 'other' && nx === 'than');
}
/** isEmptyList(toks, k) — the exception marker at k is followed by "none / geen / nothing / niets / n/a / nvt / 0" or by
 *  a dash that closes the entry ("exceptions: -", "(uitzonderingen: \u2014)"): a list that says there are none (Review
 *  Boss round 2, HIGH). "Exceptions \u2014 B8-2 and B8-3" (a dash as separator before real ids) is not empty. */
function isEmptyList(toks, k) {
  if (toks[k].dash === 'closed') return true;
  const skip = (toks[k].n === 'apart' || toks[k].n === 'other') ? 2 : 1; // "apart from", "other than"
  const nx = toks[k + skip];
  if (!nx) return false;
  if (EMPTY_LIST.has(nx.n)) return true;
  return nx.n === 'n' && k + skip + 1 < toks.length && toks[k + skip + 1].n === 'a'; // "n/a" splits on the slash
}
/** hasExceptionWord(toks) — an exception word that is not negated ("no exceptions", "zonder uitzondering", "without
 *  any exception"), not quantified ("every exception") and not an empty list ("exceptions: none"). */
function hasExceptionWord(toks) {
  for (let k = 0; k < toks.length; k++) {
    if (!isExceptionMarker(toks, k)) continue;
    if (k > 0 && (NO_WORDS.has(toks[k - 1].n) || (QUANT.has(toks[k - 1].n) && EXC_NOUN_RE.test(toks[k].n)))) continue;
    if (k > 1 && NO_WORDS.has(toks[k - 2].n) && ANY_WORDS.has(toks[k - 1].n)) continue;
    if (isEmptyList(toks, k)) continue;
    return true;
  }
  return false;
}
/** startsWithException(toks) — "Exceptions: ...", "Uitzonderingen, eerlijk: ...", "With the exception of ..."; not
 *  "Exceptions: none." */
function startsWithException(toks) {
  if (!toks.length) return false;
  if (isExceptionMarker(toks, 0)) return !isEmptyList(toks, 0);
  const a = toks.slice(0, 3).map((x) => x.n).join(' ');
  if (a === 'with the exception') return !(toks[4] && EMPTY_LIST.has(toks[4].n));
  if (a.startsWith('met uitzondering')) return !(toks[3] && EMPTY_LIST.has(toks[3].n));
  return false;
}
/** namesFailure(toks, exIds) — one sentence holds a ledger exception wp id AND a failure word (FAIL, failed, BLOCK,
 *  rejected, afgekeurd, reworked, hersteld, skipped, or a negated non-role verification word such as "not verified"):
 *  the exception is named without the word "exception" (the Lead's replay). "0 FAIL", "no FAIL", "nothing
 *  failed" next to an id name nothing. */
function namesFailure(toks, exIds) {
  let id = false, failure = false;
  for (let k = 0; k < toks.length; k++) {
    const n = toks[k].n;
    if (exIds.has(n)) { id = true; continue; }
    if ((FAILURE_RE.test(n) && !noBefore(toks, k)) || (anyPart(n, STRONG_RE) && !isRole(toks, k) && negatedAt(toks, k))) failure = true;
  }
  return id && failure;
}
/** qualifyClaim(claim, toks, ctx) -> null | how — see the header: only a qualifier that qualifies THIS claim counts. */
function qualifyClaim(c, toks, ctx) {
  for (const k of [c.q - 1, c.q - 2]) if (k >= 0 && (HEDGE.has(toks[k].n) || isNeg(toks[k].n))) return 'hedge';
  if (c.verdicts.length && toks.slice(Math.max(c.lo, c.q - 2), Math.max(...c.verdicts)).some((x) => MODAL.has(x.n))) return 'modal';
  const verdicts = c.verdicts.filter((v) => !isRole(toks, v));
  if (verdicts.length && verdicts.every((v) => negatedAt(toks, v))) return 'negated';
  for (let k = c.lo; k < c.hi; k++) {
    if (k >= c.q && k < c.q + c.qlen) continue;
    if (isNegVerdict(toks[k]) && !noBefore(toks, k)) return 'negative-verdict';
  }
  if (hasExceptionWord(ctx.xt || toks)) return 'exception';
  if (ctx.paraList) return 'exception-list';
  return null;
}
const LIST_RE = /\b(?:exceptions?|uitzonderingen|uitzondering)\b[^.\n]{0,12}?[:(]|\bexcept\b|\bexcluding\b|\bbehalve\b|\buitgezonderd\b|\bapart from\b|\bother than\b|\bwith the exception of\b|\bmet uitzondering van\b/i;
/** namedIn(text, id) — the wp id appears as its own word ("B8" is not named by "B8-2"). */
function namedIn(text, id) {
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
  return new RegExp('(?:^|[^A-Za-z0-9_-])' + esc + '(?![A-Za-z0-9_-])', 'i').test(text);
}
/** judge(text, exceptions, opts) -> {ok, claims, findings} — the report text against an already computed exception list.
 *  opts.complete (an OPEN run; owner rule 2026-11-02 after the third repeat): a claim whose paragraph carries an
 *  exception list only counts as qualified when EVERY ledger exception id is named somewhere in the report; an
 *  incomplete list (the repeated mistake) is a finding. Sealed runs and check() keep the earlier rule. */
function judge(text, exceptions, opts) {
  const complete = !!(opts && opts.complete);
  const missing = complete ? [...new Set(exceptions.map((x) => String(x.wp_id)).filter((id) => id !== '(no wp_id)' && !namedIn(text, id)))] : [];
  const exIds = new Set(exceptions.map((x) => String(x.wp_id).toLowerCase()));
  const ids = exceptions.map((x) => x.wp_id + ' (' + x.kind + ')');
  const idText = ids.slice(0, MAX_IDS).join(', ') + (ids.length > MAX_IDS ? ' and ' + (ids.length - MAX_IDS) + ' more' : '');
  const claims = [], findings = [];
  for (const p of paragraphs(text)) {
    const sents = sentences(p).map((s) => Object.assign({ a: analyse(s.text) }, s));
    if (!sents.some((s) => s.a.claims.length)) continue;
    // the qualifier view of each sentence: every balanced double-quoted span blanked (a quoted list literal is data)
    for (const s of sents) { const xt = tokens(blankQuotes(s.text, true)); s.xt = xt; }
    const paraList = sents.some((o) => startsWithException(o.xt) || (hasExceptionWord(o.xt) && o.xt.some((x) => exIds.has(x.n))) || namesFailure(o.xt, exIds));
    // a real exception LIST ("exceptions: ...", "(uitzonderingen: ...)", "except ...", "behalve ...", or a sentence naming
    // ledger ids with a failure word), not the noun in prose ("refuses when the ledger has exceptions"): real replay
    // 2026-11-02 flagged two such descriptions of the guard itself
    const paraHasList = LIST_RE.test(blankQuotes(p.lines.map((l) => l.text).join(' '), true)) || sents.some((o) => namesFailure(o.xt, exIds));
    for (const s of sents) {
      if (!s.a.claims.length) continue;
      const how = s.a.claims.map((c) => qualifyClaim(c, s.a.toks, { paraList, xt: s.xt }));
      const qualified = how.every(Boolean);
      claims.push({ line: s.line, text: s.text.slice(0, 300), qualified, how: qualified ? how[0] : null });
      if (!qualified && exceptions.length) findings.push({ line: s.line, text: s.text.slice(0, 300), reason: 'absolute verification claim with no named exception, but the ledger has ' + exceptions.length + ' exception(s): ' + idText });
      else if (qualified && missing.length && paraHasList && how.some((h) => h === 'exception' || h === 'exception-list' || h === 'hedge')) findings.push({ line: s.line, text: s.text.slice(0, 300), reason: 'exception list incomplete: the ledger has ' + exceptions.length + ' exception(s); not named anywhere in the report: ' + missing.slice(0, MAX_IDS).join(', ') + (missing.length > MAX_IDS ? ' and ' + (missing.length - MAX_IDS) + ' more' : '') });
    }
  }
  return { ok: findings.length === 0, claims, findings };
}

const wpOf = (e) => { const v = e && (e.wp_id || e.wp || e.work_package); return typeof v === 'string' && v.trim() ? v.trim() : null; };
const kindOf = (e) => (e.event_type === 'review_completed' || /review/i.test(String(e.agent || '') + ' ' + String(e.role || '')) ? 'review' : 'verify');
const isCommitLike = (e) => e.event_type === 'wp_completed' || e.event_type === 'file_changed' || /^(?:commit|git_commit|committed)$/.test(String(e.event_type)) || (typeof e.commit === 'string' && e.commit.trim().length > 0);

/** ledgerExceptions(events) -> [{wp_id, kind, reason, index}] (see the header for the four kinds). */
function ledgerExceptions(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const out = [], seen = new Set();
  const add = (wp, kind, reason, index) => { const k = wp + '|' + kind; if (!seen.has(k)) { seen.add(k); out.push({ wp_id: wp, kind, reason, index }); } };
  // per wp: the open FAIL per kind (verify / review / failed = a wp_failed) and the work done while it was open
  const openFail = new Map();
  const closeWork = (wp, st, kind) => { const w = st[kind]; if (w && w.commit) add(wp, 'committed-before-pass', w.commit.type + ' #' + w.commit.index + ' carried a commit after the ' + (kind === 'failed' ? 'wp_failed' : kind + ' FAIL') + ' #' + w.index + ' and before its PASS', w.commit.index); };
  list.forEach((e, i) => {
    const wp = wpOf(e);
    if (e.event_type === 'wp_failed') {
      if (!wp) { add('(no wp_id)', 'wp_failed', 'wp_failed #' + i + ': ' + String(e.reason || '').slice(0, 120), i); return; }
      const sf = openFail.get(wp) || {}; openFail.set(wp, sf);
      if (!sf.failed) sf.failed = { index: i, work: null, commit: null, reason: String(e.reason || '').slice(0, 120) };
      return;
    }
    if (!wp) return;
    const st = openFail.get(wp) || {};
    openFail.set(wp, st);
    const verdict = typeof e.verdict === 'string' ? e.verdict : null;
    if (verdict && e.event_type !== 'wp_completed') {
      if (st.failed && e.event_type === 'wp_verified' && PASS_RE.test(verdict)) { closeWork(wp, st, 'failed'); delete st.failed; }
      const kind = kindOf(e);
      if (FAIL_RE.test(verdict)) { if (!st[kind]) st[kind] = { index: i, work: null, commit: null }; }
      else if (PASS_RE.test(verdict) && st[kind]) { closeWork(wp, st, kind); delete st[kind]; }
      return;
    }
    if (isCommitLike(e)) {
      const hasCommit = (typeof e.commit === 'string' && e.commit.trim()) || /^(?:commit|git_commit|committed)$/.test(String(e.event_type));
      for (const kind of Object.keys(st)) {
        if (!st[kind].work) st[kind].work = { type: e.event_type, index: i };
        if (hasCommit && !st[kind].commit) st[kind].commit = { type: e.event_type, index: i };
      }
    }
  });
  // still open at the end: a wp_failed never re-verified, or a FAIL with work done after it and never cleared
  for (const [wp, st] of openFail) {
    for (const kind of Object.keys(st)) {
      const w = st[kind];
      if (kind === 'failed') add(wp, 'wp_failed', 'wp_failed #' + w.index + ': ' + w.reason + ' — never re-verified PASS', w.index);
      else if (w.work) add(wp, 'completed-after-fail', (w.commit || w.work).type + ' #' + (w.commit || w.work).index + ' after the ' + kind + ' FAIL #' + w.index + ', never cleared by a later ' + kind + ' PASS', w.index);
    }
  }
  const lastCompleted = new Map(), passed = new Set();
  list.forEach((e, i) => {
    const wp = wpOf(e);
    if (!wp) return;
    if (e.event_type === 'wp_completed') lastCompleted.set(wp, i);
    if (e.event_type === 'wp_verified' && typeof e.verdict === 'string' && PASS_RE.test(e.verdict)) passed.add(wp);
  });
  for (const [wp, i] of lastCompleted) { const ok = passed.has(wp); if (!ok) add(wp, 'not-verified', 'wp_completed #' + i + ' and no wp_verified PASS for this package', i); }
  return out;
}
/** check(reportText, events) -> {ok, claims, findings, exceptions}. */
function check(reportText, events) {
  const exceptions = ledgerExceptions(events);
  return Object.assign(judge(reportText, exceptions), { exceptions });
}
/** readEvents(file) -> events[] (unparsable lines are skipped; the ledger's integrity is judged elsewhere). */
function readEvents(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** resolveRun(opts) -> {root, dir} | {problems} — root null with a runDir: forge-claim-reports infers it. */
function resolveRun(opts) {
  if (opts.runDir) return { dir: path.resolve(opts.runDir), root: opts.root ? path.resolve(opts.root) : null };
  const root = path.resolve(opts.root || defaultRoot());
  if (!RUN_ID_RE.test(String(opts.runId || ''))) return { problems: ['--run id may only hold A-Z a-z 0-9 _ -'] };
  try { return { root, dir: runDirFor(root, opts.runId) }; } catch (e) { return { problems: ['the run folder could not be resolved (' + e.message + ')'] }; }
}
/** checkReports({root, runId|runDir, events?}) — every owner-facing report of the run against its ledger.
 *  code 0 ok · 3 an unqualified claim vs exceptions · 2 cannot judge (bad id, no ledger, unreadable report). */
function checkReports(opts) {
  opts = opts || {};
  const empty = { ok: false, reports: [], findings: [], claims: [], exceptions: [], notes: [] };
  if (!R) return Object.assign({ code: 2 }, empty, { problems: ['forge-claim-reports.cjs is missing next to forge-claim-check.cjs: the reports of the run cannot be selected (fail-closed)'] });
  const rr = resolveRun(opts);
  if (rr.problems) return Object.assign({ code: 2 }, empty, { problems: rr.problems });
  let events = opts.events;
  if (!Array.isArray(events)) {
    const ledger = path.join(rr.dir, 'events.jsonl');
    if (!fs.existsSync(ledger)) return Object.assign({ code: 2 }, empty, { problems: ['no events.jsonl in ' + rr.dir] });
    try { events = readEvents(ledger); } catch (e) { return Object.assign({ code: 2 }, empty, { problems: ['events.jsonl could not be read (' + ((e && e.code) || e) + ')'] }); }
  }
  const sel = R.reportsForRun({ root: rr.root || undefined, runDir: rr.dir, events });
  const exceptions = ledgerExceptions(events);
  const reports = [], findings = [], claims = [], problems = [];
  for (const r of sel.reports) {
    let text;
    try {
      if (fs.statSync(r.file).size > MAX_REPORT_BYTES) throw new Error('larger than ' + MAX_REPORT_BYTES + ' bytes');
      text = fs.readFileSync(r.file, 'utf8');
    } catch (e) { problems.push(r.rel + ' could not be judged (' + ((e && (e.code || e.message)) || e) + ')'); continue; }
    const j = judge(text, exceptions, { complete: !events.some((e) => e && e.event_type === 'run_finalized') });
    reports.push({ file: r.rel, source: r.source, ok: j.ok, claims: j.claims.length, findings: j.findings.length });
    for (const f of j.findings) findings.push(Object.assign({ file: r.rel }, f));
    for (const c of j.claims) claims.push(Object.assign({ file: r.rel }, c));
  }
  const code = problems.length ? 2 : findings.length ? 3 : 0;
  return { code, ok: code === 0, root: sel.root, run_dir: rr.dir, reports, findings, claims, exceptions, problems, notes: sel.notes };
}
const RECEIPT_FILE = 'run-finalized.json';
/** runsDirFor(root) — the folder that holds the run folders (same layout rule as runDirFor). */
function runsDirFor(root) {
  const legacy = path.join(root, '.claude', 'forge-runs');
  let active = legacy;
  try { if (forgePaths && forgePaths.layout(root) === 'forge') active = forgePaths.stateDir(root, 'runs'); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; }
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}
/** sealedDrift({root, runId|runDir}) — the reports of a SEALED run that changed after its receipt, re-judged with the
 *  completeness rule. {code 0 no drift or drift that passes · 3 a drifted report fails · 2 cannot judge, ok, sealed,
 *  finalized_at, run_dir, reports[{file, source, changed}], drifted[rel], findings[], claims[], exceptions[], problems[],
 *  notes[]}. An unsealed run: sealed:false, code 0 (finalize and endreview judge it). */
function sealedDrift(opts) {
  opts = opts || {};
  const empty = { ok: false, sealed: false, finalized_at: null, reports: [], drifted: [], findings: [], claims: [], exceptions: [], problems: [], notes: [] };
  if (!R || typeof R.changedAfter !== 'function') return Object.assign({ code: 2 }, empty, { problems: ['forge-claim-reports.cjs (with changedAfter) is missing next to forge-claim-check.cjs: sealed drift cannot be judged (fail-closed)'] });
  const rr = resolveRun(opts);
  if (rr.problems) return Object.assign({ code: 2 }, empty, { problems: rr.problems });
  const receipt = path.join(rr.dir, RECEIPT_FILE);
  if (!fs.existsSync(receipt)) return Object.assign({ code: 0, ok: true }, empty, { run_dir: rr.dir, notes: ['not sealed (no ' + RECEIPT_FILE + '): finalize and endreview judge an open run'] });
  let sealedAt;
  try { sealedAt = Date.parse(JSON.parse(fs.readFileSync(receipt, 'utf8')).finalized_at); } catch (e) { sealedAt = NaN; }
  if (!Number.isFinite(sealedAt)) return Object.assign({ code: 2 }, empty, { sealed: true, run_dir: rr.dir, problems: [RECEIPT_FILE + ' in ' + rr.dir + ' has no readable finalized_at: sealed drift cannot be judged'] });
  const ledger = path.join(rr.dir, 'events.jsonl');
  let events;
  try { events = readEvents(ledger); } catch (e) { return Object.assign({ code: 2 }, empty, { sealed: true, run_dir: rr.dir, problems: ['events.jsonl could not be read (' + ((e && e.code) || e) + ')'] }); }
  const notes = [];
  const sel = R.reportsForRun({ root: rr.root || undefined, runDir: rr.dir, events });
  notes.push(...sel.notes);
  const changed = R.changedAfter(rr.root, sealedAt, sel.reports.map((r) => r.file), notes, { anchor: receipt });
  const exceptions = ledgerExceptions(events);
  const reports = [], drifted = [], findings = [], claims = [], problems = [];
  for (const r of sel.reports) {
    const isChanged = changed.has(r.file);
    reports.push({ file: r.rel, source: r.source, changed: isChanged });
    if (!isChanged) continue;
    drifted.push(r.rel);
    let text;
    try {
      if (fs.statSync(r.file).size > MAX_REPORT_BYTES) throw new Error('larger than ' + MAX_REPORT_BYTES + ' bytes');
      text = fs.readFileSync(r.file, 'utf8');
    } catch (e) { problems.push(r.rel + ' changed after the seal but could not be judged (' + ((e && (e.code || e.message)) || e) + ')'); continue; }
    const j = judge(text, exceptions, { complete: true });
    for (const f of j.findings) findings.push(Object.assign({ file: r.rel }, f));
    for (const c of j.claims) claims.push(Object.assign({ file: r.rel }, c));
  }
  const code = problems.length ? 2 : findings.length ? 3 : 0;
  return { code, ok: code === 0, sealed: true, finalized_at: new Date(sealedAt).toISOString(), root: sel.root, run_dir: rr.dir, reports, drifted, findings, claims, exceptions, problems, notes };
}
/** sealedDriftAll({root}) — sealedDrift over every run folder with a receipt; the advisory shape for forge-doctor:
 *  {code, ok, status: 'ok'|'fail'|'error', summary, sealed_runs, drifted, runs[{run_id, code, drifted, findings}],
 *  findings[], problems[]}. code = the worst run code (3 beats 2 beats 0). */
function sealedDriftAll(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot());
  let dir;
  try { dir = runsDirFor(root); } catch (e) { return { code: 2, ok: false, status: 'error', summary: 'the runs folder could not be resolved (' + e.message + ')', sealed_runs: 0, drifted: 0, runs: [], findings: [], problems: [e.message] }; }
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).map((e) => e.name).sort(); } catch (e) { names = []; }
  const runs = [], findings = [], problems = [];
  let drifted = 0;
  for (const id of names) {
    const d = path.join(dir, id);
    if (!fs.existsSync(path.join(d, RECEIPT_FILE))) continue;
    const r = sealedDrift({ root, runDir: d });
    runs.push({ run_id: id, code: r.code, drifted: r.drifted, findings: r.findings.length, problems: r.problems });
    drifted += r.drifted.length;
    for (const f of r.findings) findings.push(Object.assign({ run_id: id }, f));
    for (const p of r.problems) problems.push(id + ': ' + p);
  }
  const code = runs.some((r) => r.code === 3) ? 3 : runs.some((r) => r.code === 2) ? 2 : 0;
  const bad = runs.filter((r) => r.code !== 0).map((r) => r.run_id);
  const summary = runs.length + ' sealed run(s), ' + drifted + ' report(s) changed after the seal, ' + findings.length + ' claim finding(s)' + (problems.length ? ', ' + problems.length + ' problem(s)' : '') + (bad.length ? ' — ' + bad.slice(0, 8).join(', ') + (bad.length > 8 ? ' and ' + (bad.length - 8) + ' more' : '') : '');
  return { code, ok: code === 0, status: code === 0 ? 'ok' : code === 3 ? 'fail' : 'error', summary, sealed_runs: runs.length, drifted, runs, findings, problems };
}
/** checkRun({root, runId|runDir, report?}) — ONE report (default <run>/final-report.md); code 0 · 3 · 2. */
function checkRun(opts) {
  opts = opts || {};
  const rr = resolveRun(opts);
  if (rr.problems) return { code: 2, ok: false, problems: rr.problems };
  const report = opts.report ? path.resolve(opts.report) : path.join(rr.dir, REPORT_FILE);
  if (!fs.existsSync(report)) return { code: 2, ok: false, report, report_present: false, problems: ['no report at ' + report] };
  const ledger = path.join(rr.dir, 'events.jsonl');
  if (!fs.existsSync(ledger)) return { code: 2, ok: false, report, report_present: true, problems: ['no events.jsonl in ' + rr.dir] };
  let r;
  try { r = check(fs.readFileSync(report, 'utf8'), readEvents(ledger)); }
  catch (e) { return { code: 2, ok: false, report, report_present: true, problems: ['could not be judged (' + ((e && e.message) || e) + ')'] }; }
  return Object.assign({ code: r.ok ? 0 : 3, report, report_present: true, problems: [] }, r);
}

const USAGE = 'usage: node forge-claim-check.cjs --run <id> [--report <path> | --all-reports] [--root <dir>] [--json]\n       node forge-claim-check.cjs --sealed-drift [--run <id>] [--root <dir>] [--json]';
function printExceptions(out, exceptions) {
  out('  ledger exceptions:');
  for (const x of exceptions) out('    ' + x.wp_id + ' [' + x.kind + '] ' + x.reason);
  out('  fix: name the exceptions in the same sentence or paragraph (e.g. "almost every package ... exceptions: <wp ids>") or remove the absolute claim');
}
function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s + '\n')), err = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--all-reports') o.all = true;
    else if (a === '--sealed-drift') o.drift = true;
    else if (a === '--run' || a === '--report' || a === '--root') { if (i + 1 >= argv.length) { err('forge-claim-check: ' + a + ' needs a value'); return 2; } o[a.slice(2)] = argv[++i]; }
    else { err(USAGE); return 2; }
  }
  if (o.drift && (o.all || o.report)) { err(USAGE + ' (--sealed-drift takes neither --all-reports nor --report)'); return 2; }
  if (o.drift) return mainDrift(o, out, err);
  if (!o.run || (o.all && o.report)) { err(USAGE + (o.all && o.report ? ' (--all-reports and --report exclude each other)' : '')); return 2; }
  if (o.all) {
    const r = checkReports({ root: o.root, runId: o.run });
    if (o.json) { out(JSON.stringify({ run: o.run, code: r.code, ok: r.ok, reports: r.reports, problems: r.problems, notes: r.notes, findings: r.findings, claims: r.claims, exceptions: r.exceptions })); return r.code; }
    for (const p of r.problems) err('forge-claim-check: ' + p);
    if (r.code === 2 && !r.findings.length) return 2;
    const n = r.exceptions.length, names = r.reports.map((x) => x.file + ' (' + x.source + ')').join(', ') || 'none';
    if (!r.findings.length) out('CLAIMS OK — ' + o.run + ': ' + r.reports.length + ' report(s) judged [' + names + ']; ' + r.claims.length + ' absolute verification claim(s), ' + r.claims.filter((c) => c.qualified).length + ' qualified; ledger exceptions: ' + n);
    else {
      out('CLAIM CHECK FAILED — ' + o.run + ': ' + r.findings.length + ' unqualified absolute verification claim(s) in ' + r.reports.filter((x) => !x.ok).length + ' of ' + r.reports.length + ' report(s) while the ledger has ' + n + ' exception(s)');
      for (const f of r.findings) out('  ' + f.file + ' line ' + f.line + ': ' + f.text);
      printExceptions(out, r.exceptions);
    }
    for (const nt of r.notes) out('  note: ' + nt);
    return r.code;
  }
  const r = checkRun({ root: o.root, runId: o.run, report: o.report });
  if (o.json) { out(JSON.stringify({ run: o.run, code: r.code, ok: r.ok, report: r.report || null, problems: r.problems || [], findings: r.findings || [], claims: r.claims || [], exceptions: r.exceptions || [] })); return r.code; }
  if (r.code === 2) { err('forge-claim-check: ' + r.problems.join('; ')); return 2; }
  const n = r.exceptions.length;
  if (r.ok) out('CLAIMS OK — ' + o.run + ': ' + r.claims.length + ' absolute verification claim(s), ' + r.claims.filter((c) => c.qualified).length + ' qualified; ledger exceptions: ' + n + ' (one report; --all-reports judges every report of the run)');
  else {
    out('CLAIM CHECK FAILED — ' + o.run + ': ' + r.findings.length + ' unqualified absolute verification claim(s) while the ledger has ' + n + ' exception(s)');
    for (const f of r.findings) out('  line ' + f.line + ': ' + f.text);
    printExceptions(out, r.exceptions);
  }
  return r.code;
}

/** mainDrift — the --sealed-drift mode: one run with --run, else every sealed run under the root. */
function mainDrift(o, out, err) {
  if (o.run) {
    const r = sealedDrift({ root: o.root, runId: o.run });
    if (o.json) { out(JSON.stringify(Object.assign({ run: o.run }, r))); return r.code; }
    for (const p of r.problems) err('forge-claim-check: ' + p);
    if (r.code === 2 && !r.findings.length) return 2;
    if (!r.sealed) { out('SEALED DRIFT n/a — ' + o.run + ': ' + r.notes.join('; ')); return 0; }
    if (!r.findings.length) out('SEALED DRIFT OK — ' + o.run + ': sealed at ' + r.finalized_at + '; ' + r.drifted.length + ' of ' + r.reports.length + ' report(s) changed after the seal' + (r.drifted.length ? ' [' + r.drifted.join(', ') + '], re-judged with the completeness rule, 0 finding(s)' : '') + '; ledger exceptions: ' + r.exceptions.length);
    else {
      out('SEALED DRIFT FAILED — ' + o.run + ': ' + r.findings.length + ' finding(s) in ' + r.drifted.length + ' report(s) edited after the seal (' + r.finalized_at + ') while the ledger has ' + r.exceptions.length + ' exception(s)');
      for (const f of r.findings) out('  ' + f.file + ' line ' + f.line + ': ' + f.text + '\n    ' + f.reason);
      printExceptions(out, r.exceptions);
    }
    for (const nt of r.notes) out('  note: ' + nt);
    return r.code;
  }
  const r = sealedDriftAll({ root: o.root });
  if (o.json) { out(JSON.stringify(r)); return r.code; }
  for (const p of r.problems) err('forge-claim-check: ' + p);
  out((r.code === 0 ? 'SEALED DRIFT OK — ' : r.code === 3 ? 'SEALED DRIFT FAILED — ' : 'SEALED DRIFT UNJUDGED — ') + r.summary);
  for (const f of r.findings) out('  ' + f.run_id + ' ' + f.file + ' line ' + f.line + ': ' + f.text + '\n    ' + f.reason);
  return r.code;
}

module.exports = { check, ledgerExceptions, checkRun, checkReports, sealedDrift, sealedDriftAll, reportsForRun: R ? R.reportsForRun : null, isClaim, analyse, paragraphs, sentences, readEvents, runDirFor, runsDirFor, REPORT_FILE, RECEIPT_FILE };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-claim-check: internal error: ' + ((e && e.stack) || e) + '\n'); process.exitCode = 2; }
}
