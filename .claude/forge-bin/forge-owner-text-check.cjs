#!/usr/bin/env node
'use strict';
/**
 * forge-owner-text-check.cjs — owner-facing text is checked for the owner's language and for AI tells (SD-T8, default
 * skills Task 8; design: .claude/docs/default-skills.md). It WARNS, it never
 * blocks: forge-endreview.cjs `check` prints the result as warnings and keeps its own exit code.
 *
 * Language. The expected language comes from the owner profile pref `language.ui` (read through forge-prefs.cjs):
 *   - a fixed value ("nl", "en", "Dutch", "English") is the expectation;
 *   - "match-owner ..." means: the language of the owner's own words, taken from the newest scribe record of the run
 *     (the newest `open` op in the scribe ledger with that run_id, set-aside records skipped), or, when the run has no
 *     record, the newest owner record overall (labelled `scribe:newest`); when that record is too short to tell its
 *     language, the newest record of the majority language decides (`scribe:run-majority`, then `scribe:majority`);
 *   - no pref, or no owner words to match, means: not judged (never a guess).
 * The text's own language is a small stop-word heuristic (languageOf): fenced code, inline code, URLs and paths are
 * removed, then the words are counted against two short lists of frequent function words that the other language does
 * not use (shared words such as "in", "is", "over", "door" are left out on purpose). At least MIN_HITS hits are needed;
 * a share of NL_SHARE or more Dutch hits is nl, of 1 - NL_SHARE or less is en, anything between is mixed = unknown.
 *
 * AI tells (aiTells). A fixed phrase list (delve, tapestry, it's worth noting, I hope this helps, Certainly!, As an AI)
 * plus an em-dash density above 1 per 120 words. Code blocks and inline code do not count. Rewrite help: the humanizer
 * skill.
 *
 * CLI (--root <dir> or FORGE_PROJECT_ROOT selects the project root; --json for machine output):
 *   check --run <id>   the warnings for that run's final-report.md (exit 0 always when the run id is valid; 2 usage)
 *   replay             every <runs>/<id>/final-report.md, read-only: COUNTS only (reports, warned, language, tells,
 *                      not judged). It never prints report text.
 * Zero dependencies; read-only (it writes nothing, logs nothing). Deterministic: no clock, no randomness, no network.
 */
const fs = require('fs'), path = require('path');

const REPORT_FILE = 'final-report.md';
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const MIN_HITS = 5;          // fewer stop-word hits than this: too little text to call a language
const NL_SHARE = 0.65;       // share of Dutch hits from which a text is nl (and 1 - this, or less, is en)
const DASH_WORDS = 120;      // em-dash density limit: more than 1 em dash per this many words is a tell
const NL_WORDS = new Set(('de het een en van niet dat die met voor zijn wordt ook maar nog wel als er naar bij aan je ik wat '
  + 'geen dan nu moet kan heeft hebben deze om uit zoals waar alle welke zou mij wij jij ze hij zij worden kunnen moeten').split(' '));
const EN_WORDS = new Set(('the and of to that it for with not this are be was on but what no can should now which has have '
  + 'from by they you we will would there their been does only also than when were could into our your its').split(' '));
const TELLS = [
  { tell: 'delve', re: /\bdelv(?:e|es|ed|ing)\b/gi },
  { tell: 'tapestry', re: /\btapestr(?:y|ies)\b/gi },
  { tell: "it's worth noting", re: /\bit['’]s worth noting\b/gi },
  { tell: 'I hope this helps', re: /\bI hope this helps\b/gi },
  { tell: 'Certainly!', re: /\bCertainly!/gi },
  { tell: 'As an AI', re: /\bas an AI\b/gi },
];
const EM_DASH = '—';

const defaultRoot = () => (process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..'));
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.layout === 'function' ? m : null; } catch { return null; } })();

/** prose(text) -> the text without fenced code, inline code, URLs and file paths (they are not owner-facing prose). */
function prose(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/(?:[A-Za-z]:)?(?:[\w.-]*[\\/])+[\w.-]+/g, ' ');
}
const wordsOf = (text) => prose(text).toLowerCase().match(/[a-zà-ÿ]+(?:['’][a-z]+)?/g) || [];

/** languageOf(text) -> 'nl'|'en'|'unknown' — the stop-word share (see the header). Total: never throws. */
function languageOf(text) {
  let nl = 0, en = 0;
  for (const w of wordsOf(text)) { if (NL_WORDS.has(w)) nl++; else if (EN_WORDS.has(w)) en++; }
  if (nl + en < MIN_HITS) return 'unknown';
  const share = nl / (nl + en);
  return share >= NL_SHARE ? 'nl' : share <= 1 - NL_SHARE ? 'en' : 'unknown';
}

/** expectedLanguage(uiPref, ownerText) -> 'nl'|'en'|null. A fixed pref wins; "match-owner" follows the owner's words. */
function expectedLanguage(uiPref, ownerText) {
  if (typeof uiPref !== 'string' || !uiPref.trim()) return null;
  const p = uiPref.trim().toLowerCase();
  if (/^(?:nl|dutch|nederlands)\b/.test(p)) return 'nl';
  if (/^(?:en|english|engels)\b/.test(p)) return 'en';
  if (/^match-owner\b/.test(p)) { const l = languageOf(ownerText); return l === 'unknown' ? null : l; }
  return null;
}

/** languageCheck(text, uiPref, ownerText?) -> {ok, why, expected, actual}. ok unless both languages are known and differ. */
function languageCheck(text, uiPref, ownerText) {
  const expected = expectedLanguage(uiPref, ownerText);
  const actual = languageOf(text);
  if (!expected) return { ok: true, why: 'not judged: no owner language to compare with (language.ui ' + (uiPref ? '"' + String(uiPref).slice(0, 60) + '"' : 'not set') + ')', expected, actual };
  if (actual === 'unknown') return { ok: true, why: 'not judged: the text is too short or mixed to tell its language', expected, actual };
  if (actual === expected) return { ok: true, why: 'written in ' + actual + ', as the owner expects', expected, actual };
  return { ok: false, why: 'written in ' + actual + ', but the owner reads ' + expected + ' (language.ui "' + String(uiPref).slice(0, 60) + '")', expected, actual };
}

/** aiTells(text) -> [{tell, count}] — the phrase list plus the em-dash density (see the header). Total: never throws. */
function aiTells(text) {
  const p = prose(text);
  const out = [];
  for (const x of TELLS) { const n = (p.match(x.re) || []).length; if (n) out.push({ tell: x.tell, count: n }); }
  const dashes = p.split(EM_DASH).length - 1;
  const words = (p.match(/[A-Za-zÀ-ÿ0-9]+/g) || []).length;
  if (dashes && words && dashes * DASH_WORDS > words) out.push({ tell: 'em-dash density (more than 1 per ' + DASH_WORDS + ' words)', count: dashes, words });
  return out;
}

/** scribeLedgerOf(root) -> the scribe ledger path (same folder rule as forge-scribe-store.cjs). */
function scribeLedgerOf(root) {
  if (forgePaths) { try { return path.join(forgePaths.stateDir(root, 'scribe'), 'ledger.jsonl'); } catch { /* legacy below */ } }
  return path.join(root, '.claude', 'forge-scribe', 'ledger.jsonl');
}
/** readOpens(root) -> the owner `open` ops of the scribe ledger, in ledger order, set-aside ones removed. Read-only. */
function readOpens(root) {
  let raw;
  try { raw = fs.readFileSync(scribeLedgerOf(root), 'utf8'); } catch { return []; }
  const ops = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { const o = JSON.parse(line); if (o && typeof o === 'object') ops.push(o); } catch { /* a torn line is skipped */ } }
  const ignored = new Set(ops.filter((o) => o.op === 'supersede' && o.ignored).map((o) => o.rid));
  return ops.filter((o) => o.op === 'open' && typeof o.quote === 'string' && o.quote.trim() && !ignored.has(o.rid));
}
/** ownerTextOf(root, runId) -> {text|null, source: 'scribe:run'|'scribe:run-majority'|'scribe:newest'|'scribe:majority'|'none'}
 *  (the owner's own words). */
function ownerTextOf(root, runId, opens) {
  const all = opens || readOpens(root);
  const ofRun = all.filter((o) => o.run_id === runId);
  // FB-FINALIZE-1-F11: one short newest record ("ok ga door") must not leave the report not judged: when its language
  // is unknown, the newest record of the majority language decides (the run's records first, then all of them)
  const newestKnown = (list) => { const l = list.length ? languageOf(list[list.length - 1].quote) : 'unknown'; return l !== 'unknown'; };
  const majority = (list) => {
    const n = { nl: 0, en: 0 }; let last = null;
    for (const o of list) { const l = languageOf(o.quote); if (l !== 'unknown') { n[l]++; last = l; } }
    if (!n.nl && !n.en) return null;
    const lang = n.nl === n.en ? last : n.nl > n.en ? 'nl' : 'en';
    for (let i = list.length - 1; i >= 0; i--) if (languageOf(list[i].quote) === lang) return list[i].quote;
    return null;
  };
  if (ofRun.length && newestKnown(ofRun)) return { text: ofRun[ofRun.length - 1].quote, source: 'scribe:run' };
  const runMaj = majority(ofRun);
  if (runMaj) return { text: runMaj, source: 'scribe:run-majority' };
  if (!ofRun.length && newestKnown(all)) return { text: all[all.length - 1].quote, source: 'scribe:newest' };
  const allMaj = majority(all);
  if (allMaj) return { text: allMaj, source: 'scribe:majority' };
  if (ofRun.length) return { text: ofRun[ofRun.length - 1].quote, source: 'scribe:run' };
  if (all.length) return { text: all[all.length - 1].quote, source: 'scribe:newest' };
  return { text: null, source: 'none' };
}

/** uiPrefOf(root, opts) -> {ui: string|null, problem: string|null} — language.ui through forge-prefs.cjs. */
function uiPrefOf(root, opts) {
  let P = null;
  try { P = require('./forge-prefs.cjs'); } catch { P = null; }
  if (!P || typeof P.get !== 'function') return { ui: null, problem: 'forge-prefs.cjs is not available: the owner language is not judged' };
  try {
    const g = P.get('language', { profilePath: path.join(root, '.claude', 'FORGE_OWNER_PROFILE.json'), globalProfilePath: opts && opts.globalProfilePath });
    const v = g.found && g.entry ? g.entry.value : null;
    const ui = v && typeof v === 'object' ? v.ui : (typeof v === 'string' ? v : null);
    return { ui: typeof ui === 'string' ? ui : null, problem: null };
  } catch (e) { return { ui: null, problem: 'the owner profile could not be read (' + String((e && e.message) || e).slice(0, 160) + '): the owner language is not judged' }; }
}

function runsDirOf(root) {
  const legacy = path.join(root, '.claude', 'forge-runs');
  try { if (forgePaths && forgePaths.layout(root) === 'forge') { const d = forgePaths.stateDir(root, 'runs'); if (fs.existsSync(d)) return d; } } catch { /* legacy */ }
  return legacy;
}

/** checkReport({root, runId, runDir?, globalProfilePath?, ui?, opens?}) -> {judged, warnings[], language, tells}. Read-only. */
function checkReport(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot());
  const dir = opts.runDir ? path.resolve(opts.runDir) : path.join(runsDirOf(root), String(opts.runId || ''));
  const out = { judged: false, warnings: [], language: null, tells: [], owner_source: 'none' };
  let text;
  try { text = fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8'); } catch { return out; }
  out.judged = true;
  const pref = opts.ui !== undefined ? { ui: opts.ui, problem: null } : uiPrefOf(root, opts);
  if (pref.problem) out.warnings.push(pref.problem);
  const owner = ownerTextOf(root, opts.runId, opts.opens);
  out.owner_source = owner.source;
  out.language = languageCheck(text, pref.ui, owner.text);
  if (!out.language.ok) out.warnings.push(REPORT_FILE + ' language: ' + out.language.why + ': write owner-facing text in ' + out.language.expected + ' (owner words from ' + owner.source + ')');
  out.tells = aiTells(text);
  if (out.tells.length) out.warnings.push(REPORT_FILE + ' has AI tells: ' + out.tells.map((x) => x.tell + ' x' + x.count).join(', ') + ': rewrite them in plain words (humanizer skill)');
  return out;
}

/** replay({root, globalProfilePath?}) -> counts over every run's final-report.md. Never returns report text. */
function replay(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot());
  const dir = runsDirOf(root);
  const c = { runs_dir: path.relative(root, dir).split(path.sep).join('/'), reports: 0, with_warning: 0, language_warning: 0, tell_warning: 0, language_not_judged: 0, profile_problem: 0, by_tell: {} };
  let ids = [];
  try { ids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name)).map((d) => d.name).sort(); } catch { ids = []; }
  const pref = uiPrefOf(root, opts);
  const opens = readOpens(root);
  for (const id of ids) {
    const r = checkReport({ root, runId: id, runDir: path.join(dir, id), ui: pref.ui, opens });
    if (!r.judged) continue;
    c.reports++;
    if (pref.problem) c.profile_problem++;
    const lw = r.language && !r.language.ok, tw = r.tells.length > 0;
    if (lw) c.language_warning++;
    if (tw) c.tell_warning++;
    if (lw || tw || pref.problem) c.with_warning++;
    if (r.language && r.language.expected === null) c.language_not_judged++;
    for (const x of r.tells) c.by_tell[x.tell] = (c.by_tell[x.tell] || 0) + 1;
  }
  return c;
}

const USAGE = ['usage: node forge-owner-text-check.cjs check --run <id> [--json]',
  '       node forge-owner-text-check.cjs replay [--json]   (counts only, never report text)',
  '  --root <dir> or FORGE_PROJECT_ROOT selects the project root'].join('\n');

/** main(argv, io) -> exit code. io = {out, err, globalProfilePath} (all optional) so tests run it in-process. */
function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const err = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const [cmd, ...rest] = argv || [];
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined; };
  const root = val('--root') ? path.resolve(val('--root')) : defaultRoot();
  const json = rest.includes('--json');
  const gp = io && io.globalProfilePath;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out(USAGE); return 0; }
  if (cmd === 'check') {
    const run = val('--run');
    if (!run || !RUN_ID_RE.test(run)) { err(USAGE); return 2; }
    const r = checkReport({ root, runId: run, globalProfilePath: gp });
    if (json) out(JSON.stringify(r, null, 2));
    else if (!r.judged) out('owner text for run ' + run + ': no ' + REPORT_FILE + ' yet, nothing to judge');
    else { out('owner text for run ' + run + ': ' + (r.warnings.length ? r.warnings.length + ' warning(s)' : 'no warnings')); for (const w of r.warnings) out('  warning: ' + w); }
    return 0;
  }
  if (cmd === 'replay') {
    const c = replay({ root, globalProfilePath: gp });
    if (json) out(JSON.stringify(c, null, 2));
    else out(c.reports + ' report(s) in ' + c.runs_dir + ': ' + c.with_warning + ' would get a warning (language ' + c.language_warning + ', AI tells ' + c.tell_warning
      + ', language not judged ' + c.language_not_judged + (c.profile_problem ? ', owner profile unreadable ' + c.profile_problem : '') + ')');
    return 0;
  }
  err(USAGE);
  return 2;
}

module.exports = { REPORT_FILE, MIN_HITS, NL_SHARE, DASH_WORDS, TELLS, languageOf, expectedLanguage, languageCheck, aiTells, ownerTextOf, readOpens, uiPrefOf, checkReport, replay, main };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-owner-text-check: internal error: ' + (e && e.stack || e) + '\n'); process.exitCode = 1; }
}
