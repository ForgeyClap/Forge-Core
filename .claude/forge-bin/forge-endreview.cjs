#!/usr/bin/env node
'use strict';
/**
 * forge-endreview.cjs — the END-OF-WORK SELF-REVIEW, made mechanical (work package E.1).
 *
 * Owner HARD MUST (CLAUDE.md "End-of-work self-review", docs/claude-md/end-self-review.md): before any work is reported
 * done, the lead answers a fixed list of questions in writing, with evidence, and acts on every weak answer. This tool
 * holds no opinion of its own: it prints the questions, prints the report section to fill, and validates + stores what
 * the lead wrote. It never writes an answer.
 *
 * The questions live in ONE file: .claude/config/quality/self-review-questions.json (ids q1..q12, NL + EN).
 *
 * CLI (--root <dir> or FORGE_PROJECT_ROOT points at another project root; --json for machine output; --lang en|nl):
 *   questions                                     print the questions
 *   template --run <id>                           print the "## Self-review" section skeleton for final-report.md
 *                                                 (--json: the answers.json skeleton that `record` reads)
 *   record --run <id> --answers <file.json|->     validate that every question has a non-empty answer AND evidence or an
 *                                                 open item, then write self-review.json (sha256-bound) in the run folder
 *                                                 and log ONE agent_note through log-event.cjs (the forge-craft record
 *                                                 convention). Exit 0 recorded · 1 refused, nothing written · 2 usage
 *                                                 Also refused when a report of the run (final-report.md, reports
 *                                                 named by its report/prd events, docs EINDRAPPORT / final report
 *                                                 files changed during the run) claims EVERY package was verified
 *                                                 while the ledger has exceptions (forge-claim-check.cjs).
 *   check --run <id>                              exit 0 = self-review.json is untampered and complete AND final-report.md
 *                                                 holds a "## Self-review" heading · 1 missing or incomplete · 2 usage
 *
 * answers.json: {"reviewer": "<who>", "answers": {"q1": {"answer": "...", "evidence": "..."}, "q2": {"answer": "...",
 * "open": "..."}, ...}} (an array [{id, answer, evidence|open}] is accepted too). Zero dependencies; the only siblings
 * it touches are an optional, guarded require of forge-paths.cjs (run folder in either layout) and log-event.cjs.
 * Deterministic: no clock, no randomness in the record (a temp-file suffix only), no network.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const QUESTIONS_REL = '.claude/config/quality/self-review-questions.json';
const QUESTIONS_KIND = 'forge-self-review-questions';
const RECORD_KIND = 'forge-self-review-record', RECORD_VERSION = 1, RECORD_FILE = 'self-review.json';
const REPORT_FILE = 'final-report.md';
const MIN_NOTE = 8; // an answer, evidence or open item: at least this many characters ("ok", "yes" say nothing)
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const QID_RE = /^q[1-9][0-9]*$/;
// the heading the contract needs; an optional section number ("## 15. Self-review") is allowed
const HEADING_RE = /^##[ \t]+(?:\d+[a-z]?\.?[ \t]+)?Self-review\b/im;
// a template placeholder that was never filled in
const PLACEHOLDER_RE = /^\s*(?:<[^>]*>|todo|tbd|n\/?a|-|\.\.\.|…)\s*$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const note = (v) => isText(v) && v.trim().length >= MIN_NOTE && !PLACEHOLDER_RE.test(v);
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const defaultRoot = () => (process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..'));
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.layout === 'function' ? m : null; } catch { return null; } })();

/** canon(v) — canonical JSON (sorted keys): the record hash never depends on key order. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
/** runDirFor(root, runId) — the run folder in this project's layout (.forge runs folder when the project opted in, else
 *  .claude/forge-runs; a run that only exists in the legacy folder stays there). Same rule as forge-craft / forge-plan-card. */
function runDirFor(root, runId) {
  const legacy = path.join(root, '.claude', 'forge-runs', runId);
  let active = legacy;
  try { if (forgePaths && forgePaths.layout(root) === 'forge') active = path.join(forgePaths.stateDir(root, 'runs'), runId); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; }
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, data: JSON.parse(raw.replace(/^﻿/, '')) };
}

/** validateQuestions(data) -> problems[] — the shape of the questions file. */
function validateQuestions(d) {
  const P = [];
  if (!isObj(d) || d.kind !== QUESTIONS_KIND) return ['not a ' + QUESTIONS_KIND + ' file'];
  if (!Array.isArray(d.questions) || !d.questions.length) return ['"questions" must be a non-empty list'];
  const seen = new Set();
  d.questions.forEach((q, i) => {
    const at = 'question ' + (i + 1);
    if (!isObj(q) || !QID_RE.test(String(q.id))) { P.push(at + ': id must look like q1, q2 ...'); return; }
    if (q.id !== 'q' + (i + 1)) P.push(at + ': id is ' + q.id + ', expected q' + (i + 1) + ' (the numbering is stable: never renumber, only append)');
    if (seen.has(q.id)) P.push(at + ': duplicate id ' + q.id);
    seen.add(q.id);
    for (const k of ['short', 'ask']) if (!isObj(q[k]) || !isText(q[k].en) || !isText(q[k].nl)) P.push(q.id + ': "' + k + '" needs non-empty en and nl text');
  });
  return P;
}
/** loadQuestions(root) -> {questions, sha256, rel} | {error, rel}. */
function loadQuestions(root) {
  const file = path.join(root, ...QUESTIONS_REL.split('/'));
  let r;
  try { r = readJson(file); } catch (e) { return { error: QUESTIONS_REL + ' could not be read (' + (e.code || e.message) + ')', rel: QUESTIONS_REL }; }
  const P = validateQuestions(r.data);
  if (P.length) return { error: QUESTIONS_REL + ' is invalid: ' + P.slice(0, 3).join('; '), rel: QUESTIONS_REL };
  return { questions: r.data.questions, version: r.data.version, sha256: sha(r.raw), rel: QUESTIONS_REL };
}

/** answersList(form) -> [{id, answer, evidence, open}] from either accepted shape (object map or array). */
function answersList(form) {
  const a = isObj(form) ? form.answers : null;
  if (Array.isArray(a)) return a.filter(isObj).map((x) => ({ id: String(x.id || ''), answer: x.answer, evidence: x.evidence, open: x.open }));
  if (isObj(a)) return Object.keys(a).map((id) => (isObj(a[id]) ? { id, answer: a[id].answer, evidence: a[id].evidence, open: a[id].open } : { id, answer: a[id] }));
  return null;
}
/** validateAnswers(form, questions) -> {ok, problems[], answers[]} — every question answered, each with evidence or an
 *  open item; unknown or duplicate ids are refused (a typo must not hide a missing answer). */
function validateAnswers(form, questions) {
  const P = [];
  if (!isObj(form)) return { ok: false, problems: ['the answers file must be a JSON object {"reviewer": ..., "answers": {...}}'], answers: [] };
  if (!note(form.reviewer)) P.push('"reviewer" must name who answered (at least ' + MIN_NOTE + ' characters, e.g. "Lead (main session)")');
  const list = answersList(form);
  if (!list) return { ok: false, problems: P.concat(['"answers" must be an object {"q1": {"answer": ..., "evidence": ...}} or a list']), answers: [] };
  const known = new Map(questions.map((q) => [q.id, q]));
  const byId = new Map();
  for (const x of list) {
    if (!known.has(x.id)) { P.push('unknown question id "' + x.id.slice(0, 20) + '" (known: ' + questions.map((q) => q.id).join(', ') + ')'); continue; }
    if (byId.has(x.id)) { P.push(x.id + ': answered twice'); continue; }
    byId.set(x.id, x);
  }
  const out = [];
  for (const q of questions) {
    const x = byId.get(q.id);
    const label = q.id + ' (' + q.short.en + ')';
    if (!x) { P.push(label + ': no answer'); continue; }
    if (!note(x.answer)) { P.push(label + ': the answer is empty, a placeholder or shorter than ' + MIN_NOTE + ' characters'); continue; }
    const ev = note(x.evidence) ? x.evidence.trim() : null, op = note(x.open) ? x.open.trim() : null;
    if (!ev && !op) { P.push(label + ': needs "evidence" (what proves the answer) or "open" (the open item it leaves), at least ' + MIN_NOTE + ' characters'); continue; }
    out.push({ id: q.id, question: q.short.en, answer: x.answer.trim(), evidence: ev, open: op });
  }
  return { ok: P.length === 0, problems: P, answers: out };
}

function writeAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
/** logRecorded(...) -> null | a warning. ONE agent_note through the project's own writer (forge-craft convention: a
 *  narrative note, so the lead who records never becomes a "worker"). A logging failure never undoes the record. */
function logRecorded(root, runId, evidence, summary, reviewer) {
  const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  if (!fs.existsSync(le)) return 'log-event.cjs not found: the self-review is recorded, not logged';
  const text = 'self-review recorded: ' + summary.questions + ' questions answered · ' + summary.with_evidence + ' with evidence · '
    + summary.open_items.length + ' open item(s)' + (summary.open_items.length ? ' (' + summary.open_items.join(', ') + ')' : '') + ' · reviewer ' + String(reviewer).slice(0, 80);
  const r = require('child_process').spawnSync(process.execPath, [le, runId, 'agent_note', JSON.stringify({ agent: 'orchestrator', role: 'lead', note: text, evidence })], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? null : 'log-event warning (the self-review is recorded): ' + String(r.stderr || r.stdout || (r.error && r.error.message) || 'exit ' + r.status).trim().slice(0, 200);
}
function summarize(answers) {
  return { questions: answers.length, with_evidence: answers.filter((a) => a.evidence).length, open_items: answers.filter((a) => a.open).map((a) => a.id) };
}

/** claimProblems(root, dir) -> problems[] — queue-3 (owner rule P-000094): an owner-facing report of the run
 *  that claims EVERY package was verified/reviewed while the run ledger holds exceptions is refused here. The reports
 *  are the ONE set forge-claim-check.cjs reportsForRun selects: <run>/final-report.md, the reports named by the run's
 *  report/prd events, and docs/**\/EINDRAPPORT*.md + docs/**\/*final*report*.md changed during the run (the second
 *  incident was in docs/, outside every run folder). No report yet = nothing to judge (finalize judges again); the
 *  checker missing next to this tool = refused (fail-closed). */
function claimProblems(root, dir) {
  let C = null;
  try { C = require('./forge-claim-check.cjs'); } catch { C = null; }
  if (!C || typeof C.checkReports !== 'function' || typeof C.readEvents !== 'function') return ['forge-claim-check.cjs is not available next to this tool — the claims in the run reports cannot be checked (fail-closed)'];
  let r;
  try {
    const ledger = path.join(dir, 'events.jsonl');
    r = C.checkReports({ root, runDir: dir, events: fs.existsSync(ledger) ? C.readEvents(ledger) : [] });
  } catch (e) { return ['the claims in the run reports could not be checked (' + String((e && e.message) || e).slice(0, 160) + ')']; }
  if (r.code === 0) return [];
  if (!r.findings.length) return r.problems.map((p) => 'the claims in the run reports could not be checked: ' + p);
  return r.findings.map((f) => f.file + ' line ' + f.line + ': "' + f.text.slice(0, 160) + '" — ' + f.reason
    + ' (name the exceptions in that sentence or paragraph or drop the absolute claim; node .claude/forge-bin/forge-claim-check.cjs --run <id> --all-reports)');
}

/** queueProblems(dir) -> string[] — the owner queue of <dir>/final-report.md may only hold hard-gated items
 *  (forge-owner-queue-check.cjs, 2026-11-05: the owner had to say "maak de beste keuzes" again because a report ended
 *  with choices the Lead could take itself). No report or no owner-queue section = nothing to judge. Fail-closed when
 *  the checker is missing. */
function queueProblems(dir) {
  const file = path.join(dir, REPORT_FILE);
  if (!fs.existsSync(file)) return [];
  let Q = null;
  try { Q = require('./forge-owner-queue-check.cjs'); } catch { Q = null; }
  if (!Q || typeof Q.checkFile !== 'function') return ['forge-owner-queue-check.cjs is not available next to this tool — the owner queue cannot be checked (fail-closed)'];
  let r;
  try { r = Q.checkFile(file); } catch (e) { return ['the owner queue could not be checked (' + String((e && e.message) || e).slice(0, 160) + ')']; }
  return r.findings.map((f) => REPORT_FILE + (f.item === 'next' ? ' closing section' : ' item ' + f.item) + ' (line ' + f.line + '): ' + f.reason);
}

/** recordSelfReview({root, runId, form, log?}) -> {code, ok, problems?, file?, summary?, warnings?}.
 *  code 0 recorded · 1 refused (nothing written) · 2 usage (bad id, no run folder, unreadable questions). */
function recordSelfReview(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot()), runId = opts.runId;
  if (!RUN_ID_RE.test(String(runId || ''))) return { code: 2, ok: false, problems: ['--run id may only hold A-Z a-z 0-9 _ -'] };
  const Q = loadQuestions(root);
  if (Q.error) return { code: 2, ok: false, problems: [Q.error] };
  let dir;
  try { dir = runDirFor(root, runId); } catch (e) { return { code: 2, ok: false, problems: ['the run folder could not be resolved (' + e.message + ')'] }; }
  const rel = path.relative(root, dir).split(path.sep).join('/');
  if (!fs.existsSync(dir)) return { code: 2, ok: false, problems: ['run folder ' + rel + ' does not exist: start the run first (nothing was written)'] };
  const v = validateAnswers(opts.form, Q.questions);
  if (!v.ok) return { code: 1, ok: false, problems: v.problems };
  const claims = claimProblems(root, dir);
  if (claims.length) return { code: 1, ok: false, problems: claims };
  const queue = queueProblems(dir);
  if (queue.length) return { code: 1, ok: false, problems: queue };
  const review = { reviewer: opts.form.reviewer.trim(), answers: v.answers };
  const summary = summarize(v.answers);
  const record = { kind: RECORD_KIND, version: RECORD_VERSION, run_id: runId,
    questions: { file: Q.rel, version: Q.version, sha256: Q.sha256, ids: Q.questions.map((q) => q.id) }, review, summary, record_sha256: sha(canon(review)) };
  writeAtomic(path.join(dir, RECORD_FILE), record);
  const warnings = [];
  if (opts.log !== false) { const w = logRecorded(root, runId, rel + '/' + RECORD_FILE, summary, review.reviewer); if (w) warnings.push(w); }
  return { code: 0, ok: true, file: rel + '/' + RECORD_FILE, summary, warnings };
}

/** checkRecorded({root, runDir|runId}) -> {recorded, valid, report_heading, ok, problems[], notes[], summary?, file}.
 *  Read-only. ok = an untampered, complete self-review for THIS run AND a "## Self-review" heading in final-report.md.
 *  Completeness is judged against the CURRENT question set (a question added later must be answered too). */
function checkRecorded(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot());
  const out = { recorded: false, valid: false, report_heading: false, ok: false, problems: [], notes: [], file: RECORD_FILE };
  const dir = opts.runDir ? path.resolve(opts.runDir) : runDirFor(root, opts.runId);
  const id = RUN_ID_RE.test(String(opts.runId || '')) ? opts.runId : '<id>';
  try { out.report_heading = HEADING_RE.test(fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8')); }
  catch (e) { out.problems.push(REPORT_FILE + ' is ' + (e && e.code === 'ENOENT' ? 'not written yet' : 'unreadable (' + ((e && e.code) || 'error') + ')')); }
  if (!out.report_heading && !out.problems.length) out.problems.push(REPORT_FILE + ' has no "## Self-review" section (print it with: forge-endreview.cjs template --run ' + id + ')');
  let rec;
  try { rec = readJson(path.join(dir, RECORD_FILE)).data; out.recorded = true; }
  catch (e) {
    if (e && e.code === 'ENOENT') out.problems.unshift('no ' + RECORD_FILE + ' in the run folder (record it with: forge-endreview.cjs record --run ' + id + ' --answers <answers.json>)');
    else { out.recorded = true; out.problems.unshift(RECORD_FILE + ' ' + (e instanceof SyntaxError ? 'is not valid JSON' : 'could not be read (' + ((e && e.code) || 'error') + ')')); }
    return out;
  }
  const bad = (p) => { out.problems.unshift(p); return out; };
  if (!isObj(rec) || rec.kind !== RECORD_KIND || rec.version !== RECORD_VERSION) return bad(RECORD_FILE + ' is not a forge-endreview record (write it with forge-endreview.cjs record)');
  if (opts.runId && rec.run_id !== opts.runId) return bad(RECORD_FILE + ' belongs to run "' + String(rec.run_id).slice(0, 80) + '", not ' + opts.runId);
  if (!isObj(rec.review) || rec.record_sha256 !== sha(canon(rec.review))) return bad(RECORD_FILE + ' was edited after it was recorded (record_sha256 no longer matches) — record it again with forge-endreview.cjs record');
  const Q = loadQuestions(root);
  if (Q.error) return bad('the question set cannot be judged here: ' + Q.error);
  if (isObj(rec.questions) && rec.questions.sha256 !== Q.sha256) out.notes.push('the question set changed since this self-review was recorded; judged against the current questions');
  const v = validateAnswers({ reviewer: rec.review.reviewer, answers: rec.review.answers }, Q.questions);
  if (!v.ok) { out.problems.unshift(...v.problems.slice(0, 6)); return out; }
  out.valid = true;
  out.summary = summarize(v.answers);
  // an edit after `record` must not slip a choice back into the report; re-judged here.
  const queue = out.report_heading ? queueProblems(dir) : [];
  if (queue.length) out.problems.push(...queue);
  out.ok = out.valid && out.report_heading && !queue.length;
  return out;
}

/** renderQuestions(questions, lang) -> text. */
function renderQuestions(questions, lang) {
  const L = [lang === 'nl' ? 'Zelfreview aan het eind (' + questions.length + ' vragen):' : 'End-of-work self-review (' + questions.length + ' questions):'];
  for (const q of questions) L.push('  ' + q.id.padEnd(4) + ' ' + q.short[lang] + ' — ' + q.ask[lang]);
  return L.join('\n');
}
/** renderTemplate(questions, runId, lang) -> the markdown section to paste into final-report.md. */
function renderTemplate(questions, runId, lang) {
  const nl = lang === 'nl';
  const L = ['## Self-review', '',
    nl ? '_Beantwoord elke vraag met bewijs (commando + uitvoer, bestand, screenshot) of een open punt. Zwakke antwoorden die goedkoop te fixen zijn, eerst fixen._'
      : '_Answer every question with evidence (command + output, file, screenshot) or an open item. Fix the weak answers that are cheap to fix first._', ''];
  for (const q of questions) {
    L.push('**' + q.id + ' — ' + q.short[lang] + '** ' + q.ask[lang]);
    L.push('- ' + (nl ? 'Antwoord' : 'Answer') + ': <...>');
    L.push('- ' + (nl ? 'Bewijs of open punt' : 'Evidence or open item') + ': <...>', '');
  }
  L.push((nl ? 'Vastleggen' : 'Record') + ': `node .claude/forge-bin/forge-endreview.cjs record --run ' + runId + ' --answers <answers.json>` (`template --run ' + runId + ' --json` prints the answers.json skeleton)');
  return L.join('\n');
}
function answersSkeleton(questions) {
  return { reviewer: '<who answered, e.g. Lead (main session)>', answers: Object.fromEntries(questions.map((q) => [q.id, { question: q.short.en, answer: '<...>', evidence: '<...>', open: '' }])) };
}

const USAGE = ['usage: node forge-endreview.cjs questions [--lang en|nl] [--json]',
  '       node forge-endreview.cjs template --run <id> [--lang en|nl] [--json]',
  '       node forge-endreview.cjs record --run <id> --answers <answers.json|-> [--json]',
  '       node forge-endreview.cjs check --run <id> [--json]',
  '  --root <dir> or FORGE_PROJECT_ROOT selects the project root'].join('\n');

/** main(argv, io) -> exit code. io = {out, err, root} (all optional) so tests can run it in-process. */
function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const err = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const [cmd, ...rest] = argv;
  const has = (f) => rest.includes(f);
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 && i + 1 < rest.length && (rest[i + 1] === '-' || !rest[i + 1].startsWith('--')) ? rest[i + 1] : undefined; };
  const root = val('--root') ? path.resolve(val('--root')) : ((io && io.root) || defaultRoot());
  const json = has('--json');
  const lang = (val('--lang') || 'en').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out(USAGE); return 0; }
  if (lang !== 'en' && lang !== 'nl') { err('forge-endreview: --lang must be en or nl\n' + USAGE); return 2; }
  const run = val('--run');
  if (cmd === 'questions' || cmd === 'template') {
    if (cmd === 'template' && !(run && RUN_ID_RE.test(run))) { err(USAGE); return 2; }
    const Q = loadQuestions(root);
    if (Q.error) { err('forge-endreview: ' + Q.error); return 2; }
    if (cmd === 'questions') out(json ? JSON.stringify({ file: Q.rel, sha256: Q.sha256, questions: Q.questions }, null, 2) : renderQuestions(Q.questions, lang));
    else out(json ? JSON.stringify(answersSkeleton(Q.questions), null, 2) : renderTemplate(Q.questions, run, lang));
    return 0;
  }
  if (cmd === 'record') {
    const file = val('--answers');
    if (!run || !file) { err(USAGE); return 2; }
    let form;
    try { form = JSON.parse((file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8')).replace(/^﻿/, '')); }
    catch (e) { err('forge-endreview: cannot read the answers (' + file + '): ' + e.message); return 2; }
    const r = recordSelfReview({ root, runId: run, form });
    if (json) out(JSON.stringify(r, null, 2));
    else if (r.code === 0) {
      out('Self-review recorded for run ' + run + ' -> ' + r.file);
      out('  ' + r.summary.questions + ' questions answered, ' + r.summary.with_evidence + ' with evidence, ' + r.summary.open_items.length + ' open item(s)' + (r.summary.open_items.length ? ': ' + r.summary.open_items.join(', ') + ' — name them in the report' : ''));
      for (const w of r.warnings) err('forge-endreview: warning: ' + w);
    } else {
      err('Self-review NOT recorded (nothing was written)' + (r.problems.length > 1 ? ' — ' + r.problems.length + ' problems:' : ':'));
      for (const p of r.problems) err('  - ' + p);
    }
    return r.code;
  }
  if (cmd === 'check') {
    if (!run || !RUN_ID_RE.test(run)) { err(USAGE); return 2; }
    let dir;
    try { dir = runDirFor(root, run); } catch (e) { err('forge-endreview: the run folder could not be resolved (' + e.message + ')'); return 2; }
    const c = checkRecorded({ root, runDir: dir, runId: run });
    if (json) out(JSON.stringify(Object.assign({ run_id: run, folder: path.relative(root, dir).split(path.sep).join('/') }, c), null, 2));
    else {
      out('Self-review for run ' + run + ': ' + (c.ok ? 'OK — recorded, complete, and final-report.md has the Self-review section' : 'NOT DONE'));
      if (c.summary) out('  ' + c.summary.questions + ' answered, ' + c.summary.with_evidence + ' with evidence, ' + c.summary.open_items.length + ' open item(s)');
      for (const p of c.problems) out('  - ' + p);
      for (const n of c.notes) out('  note: ' + n);
    }
    return c.ok ? 0 : 1;
  }
  err(USAGE);
  return 2;
}

module.exports = {
  QUESTIONS_REL, RECORD_KIND, RECORD_VERSION, RECORD_FILE, REPORT_FILE, MIN_NOTE, HEADING_RE,
  canon, runDirFor, loadQuestions, validateQuestions, validateAnswers, recordSelfReview, checkRecorded, queueProblems,
  renderQuestions, renderTemplate, answersSkeleton, main,
};

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-endreview: internal error: ' + (e && e.stack || e) + '\n'); process.exitCode = 1; }
}
