#!/usr/bin/env node
'use strict';
/**
 * forge-endreview.test.cjs — E.1 (owner HARD MUST "end-of-work self-review"): forge-endreview.cjs
 * (questions, template, record, check) and the run-contract rule end-self-review. Hermetic: every fixture lives in one
 * os.mkdtemp folder (removed at the end); the real project is only read (the production FORGE_HARD_RULES.json, the
 * question set and docs/claude-md/end-self-review.md when it is present — it exists only in the development tree).
 *   A. the question set: q1..q12 in order, NL + EN, the same questions as the doc
 *   B. questions / template CLI output and exit codes
 *   C. record: every refusal mode writes nothing; a valid record is sha256-bound and logs one agent_note
 *   D. check: untampered + complete + the report heading, in the legacy and the .forge layout
 *   E. contract: L2+ without a self-review -> warn; with a valid record -> clean; L1 / older run -> not judged;
 *      the owner_override path; plan names the commands
 *   F. mutations: the rule removed / the evidence kind unknown -> the warn assertions would fail
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = __dirname;
const CLAUDE_SRC = path.join(BIN, '..');
const REAL_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const REAL_QUESTIONS = path.join(CLAUDE_SRC, 'config', 'quality', 'self-review-questions.json');
const DOC = path.join(CLAUDE_SRC, '..', 'docs', 'claude-md', 'end-self-review.md');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-endreview-')));
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete process.env[k];
process.env.FORGE_CONFIG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });

const E = require('./forge-endreview.cjs');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const PROD = JSON.parse(fs.readFileSync(REAL_RULES, 'utf8'));
const QS = JSON.parse(fs.readFileSync(REAL_QUESTIONS, 'utf8')).questions;
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
let rootN = 0;

/** mkRoot({forge, rules, logStub}) -> a project root with the production rules (or `rules`) and the real questions. */
function mkRoot(opts) {
  opts = opts || {};
  const root = mk(TMP, 'p' + (++rootN));
  mk(root, '.claude', 'config', 'orchestration');
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), opts.rules ? JSON.stringify(opts.rules, null, 2) : fs.readFileSync(REAL_RULES));
  fs.copyFileSync(REAL_QUESTIONS, path.join(mk(root, '.claude', 'config', 'quality'), 'self-review-questions.json'));
  if (opts.forge) mk(root, '.forge');
  if (opts.logStub) {
    // a stand-in event writer: it records its argv, so the test sees exactly what record() logs
    fs.writeFileSync(path.join(mk(root, '.claude', 'forge-dashboard'), 'log-event.cjs'),
      "require('fs').appendFileSync(require('path').join(__dirname, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  }
  return root;
}
const runDirIn = (root, id) => (fs.existsSync(path.join(root, '.forge')) ? path.join(root, '.forge', 'runs', id) : path.join(root, '.claude', 'forge-runs', id));
const TS = '2026-10-24T12:00:00.000Z';
const BASE_EVENTS = [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: TS },
  { event_type: 'memory_loaded', agent: 'orchestrator', timestamp: TS },
];
function writeRun(root, id, opts) {
  opts = opts || {};
  const dir = mk(runDirIn(root, id));
  const events = (opts.events || BASE_EVENTS).concat(opts.extra || []);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(Object.assign({ complexity: opts.level || 'L2' }, opts.run || {})));
  if (opts.report !== undefined) fs.writeFileSync(path.join(dir, 'final-report.md'), opts.report);
  return dir;
}
const REPORT = '# Final report\n\n## 13. Final verdict\nPASS CORE\n\n## Self-review\n\nq1 ... q12 answered below.\n';
/** a complete answers form (every question answered with evidence; q11 with an open item). */
function goodForm() {
  const answers = {};
  for (const q of QS) answers[q.id] = { answer: 'Answered ' + q.id + ' after re-reading the work package.', evidence: 'node forge-endreview.test.cjs exit 0, output read' };
  answers.q11 = { answer: 'The registrations in the ship manifest are still open.', open: 'lead integrates the registry rows' };
  return { reviewer: 'Lead (main session)', answers };
}
const chk = (root, id, extra) => RC.check(Object.assign({ run_id: id }, extra || {}), { root, ownerProfilePath: NO_PROFILE });
const cli = (root, argv) => { const o = [], e = []; const code = E.main(argv.concat(['--root', root]), { out: (s) => o.push(s), err: (s) => e.push(s) }); return { code, out: o.join('\n'), err: e.join('\n') }; };

console.log('forge-endreview tests (E.1 end-of-work self-review; hermetic root=' + TMP + ')');

try {
  // ================================================================================================
  console.log('\nA) the question set');
  // ================================================================================================
  {
    t('the question set file is valid (kind, q1..q12 in order, en + nl)', E.validateQuestions(JSON.parse(fs.readFileSync(REAL_QUESTIONS, 'utf8'))).length === 0);
    t('exactly 12 questions, ids q1..q12', QS.length === 12 && QS.every((q, i) => q.id === 'q' + (i + 1)));
    if (fs.existsSync(DOC)) {
      const doc = fs.readFileSync(DOC, 'utf8');
      const docQs = [...doc.matchAll(/^(\d+)\.\s+\*\*(.+?)\*\*/gm)].map((m) => ({ n: Number(m[1]), q: m[2].trim() }));
      t('the doc lists the same 12 questions in the same order (q<n>.short.en == doc question n)', docQs.length === 12 && docQs.every((d, i) => d.n === i + 1 && QS[i].short.en === d.q), JSON.stringify(docQs.map((d) => d.q)));
    } else console.log('  (docs/claude-md/end-self-review.md is not shipped here — doc parity is checked in the development tree)');
    const renumbered = JSON.parse(fs.readFileSync(REAL_QUESTIONS, 'utf8'));
    renumbered.questions[2].id = 'q9';
    t('a renumbered question set is refused (numbering is stable)', E.validateQuestions(renumbered).some((p) => /expected q3/.test(p)));
    const noNl = JSON.parse(fs.readFileSync(REAL_QUESTIONS, 'utf8'));
    delete noNl.questions[0].short.nl;
    t('a question without Dutch text is refused', E.validateQuestions(noNl).some((p) => /q1: "short" needs non-empty en and nl/.test(p)));
  }

  // ================================================================================================
  console.log('\nB) questions / template');
  // ================================================================================================
  {
    const root = mkRoot();
    let r = cli(root, ['questions']);
    t('questions: exit 0 and all 12 ids printed', r.code === 0 && QS.every((q) => r.out.includes(q.id + ' ')), r.out);
    r = cli(root, ['questions', '--lang', 'nl']);
    t('questions --lang nl prints the Dutch text', r.code === 0 && r.out.includes('Werkt het echt?'));
    t('questions --lang de -> usage exit 2', cli(root, ['questions', '--lang', 'de']).code === 2);
    r = cli(root, ['template', '--run', 'tpl-1']);
    t('template: exit 0, starts with the "## Self-review" heading the check needs', r.code === 0 && /^## Self-review\n/.test(r.out) && E.HEADING_RE.test(r.out));
    t('template: every question and the record command with the run id', QS.every((q) => r.out.includes('**' + q.id + ' — ' + q.short.en + '**')) && r.out.includes('forge-endreview.cjs record --run tpl-1 --answers'));
    t('template without --run -> exit 2', cli(root, ['template']).code === 2);
    t('template with a bad run id -> exit 2', cli(root, ['template', '--run', '../x']).code === 2);
    r = cli(root, ['template', '--run', 'tpl-1', '--json']);
    const skel = JSON.parse(r.out);
    t('template --json: the answers.json skeleton holds every question id', r.code === 0 && QS.every((q) => skel.answers[q.id]));
    writeRun(root, 'tpl-1');
    const rec = E.recordSelfReview({ root, runId: 'tpl-1', form: skel, log: false });
    t('the unfilled skeleton is refused by record (placeholders are not answers), nothing written', rec.code === 1 && !fs.existsSync(path.join(runDirIn(root, 'tpl-1'), 'self-review.json')) && rec.problems.some((p) => /placeholder/.test(p)), JSON.stringify(rec.problems.slice(0, 3)));
    const missing = path.join(TMP, 'no-questions');
    mk(missing);
    t('no question set in the root -> questions exit 2 (said plainly)', (() => { const x = cli(missing, ['questions']); return x.code === 2 && /self-review-questions\.json could not be read/.test(x.err); })());
  }

  // ================================================================================================
  console.log('\nC) record');
  // ================================================================================================
  {
    const root = mkRoot({ logStub: true });
    const dir = writeRun(root, 'rec-1');
    const file = path.join(dir, 'self-review.json');
    const refuse = (label, mutate, re) => {
      const f = goodForm(); mutate(f);
      const r = E.recordSelfReview({ root, runId: 'rec-1', form: f, log: false });
      t('refused: ' + label + ' (exit 1, nothing written)', r.code === 1 && !fs.existsSync(file) && r.problems.some((p) => re.test(p)), JSON.stringify(r.problems));
    };
    refuse('a question left out', (f) => { delete f.answers.q7; }, /^q7 .*: no answer/);
    refuse('an empty answer', (f) => { f.answers.q2.answer = '   '; }, /^q2 .*the answer is empty/);
    refuse('a too-short answer', (f) => { f.answers.q3.answer = 'yes'; }, /^q3 /);
    refuse('neither evidence nor open', (f) => { f.answers.q4 = { answer: 'It looks good to me overall.' }; }, /^q4 .*needs "evidence".*or "open"/);
    refuse('a placeholder evidence', (f) => { f.answers.q5.evidence = '<...>'; }, /^q5 .*needs "evidence"/);
    refuse('an unknown question id', (f) => { f.answers.q99 = { answer: 'an extra answer here', evidence: 'some evidence here' }; }, /unknown question id "q99"/);
    refuse('no reviewer', (f) => { delete f.reviewer; }, /"reviewer" must name who answered/);
    refuse('answers not an object or list', (f) => { f.answers = 'all fine'; }, /"answers" must be an object/);
    const dup = goodForm();
    dup.answers = Object.entries(dup.answers).map(([id, a]) => Object.assign({ id }, a)).concat([Object.assign({ id: 'q1' }, dup.answers.q1)]);
    const rd = E.recordSelfReview({ root, runId: 'rec-1', form: dup, log: false });
    t('refused: a question answered twice in the list form', rd.code === 1 && rd.problems.some((p) => /q1: answered twice/.test(p)) && !fs.existsSync(file));
    t('bad run id -> exit 2', E.recordSelfReview({ root, runId: 'a/b', form: goodForm() }).code === 2);
    t('no run folder -> exit 2, nothing written', (() => { const r = E.recordSelfReview({ root, runId: 'nope', form: goodForm() }); return r.code === 2 && /does not exist/.test(r.problems[0]) && !fs.existsSync(runDirIn(root, 'nope')); })());

    const listForm = goodForm();
    listForm.answers = Object.entries(listForm.answers).map(([id, a]) => Object.assign({ id }, a));
    const answersFile = path.join(TMP, 'answers-rec-1.json');
    fs.writeFileSync(answersFile, JSON.stringify(listForm));
    const r = cli(root, ['record', '--run', 'rec-1', '--answers', answersFile]);
    t('record CLI (list form): exit 0, self-review.json written', r.code === 0 && fs.existsSync(file) && /Self-review recorded for run rec-1/.test(r.out), r.out + r.err);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    t('the record: kind/version/run id, 12 answers, question-set sha256, summary with the open item',
      saved.kind === E.RECORD_KIND && saved.version === 1 && saved.run_id === 'rec-1' && saved.review.answers.length === 12
      && /^[0-9a-f]{64}$/.test(saved.questions.sha256) && saved.summary.with_evidence === 11 && saved.summary.open_items.join() === 'q11');
    t('record_sha256 is the canonical hash of the review', saved.record_sha256 === require('crypto').createHash('sha256').update(E.canon(saved.review), 'utf8').digest('hex'));
    const calls = fs.readFileSync(path.join(root, '.claude', 'forge-dashboard', 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const payload = calls.length === 1 ? JSON.parse(calls[0][2]) : {};
    t('one agent_note logged through the project writer (forge-craft convention), evidence = the record path',
      calls.length === 1 && calls[0][0] === 'rec-1' && calls[0][1] === 'agent_note' && payload.agent === 'orchestrator' && /self-review recorded: 12 questions/.test(payload.note) && /self-review\.json$/.test(payload.evidence), JSON.stringify(calls));
    const noLog = mkRoot();
    writeRun(noLog, 'rec-2');
    const w = E.recordSelfReview({ root: noLog, runId: 'rec-2', form: goodForm() });
    t('without log-event.cjs the record is still written, with a warning (never a silent log)', w.code === 0 && w.warnings.some((x) => /log-event\.cjs not found/.test(x)));
    t('record CLI with an unreadable answers file -> exit 2', cli(root, ['record', '--run', 'rec-1', '--answers', path.join(TMP, 'missing.json')]).code === 2);
  }

  // ================================================================================================
  console.log('\nD) check');
  // ================================================================================================
  for (const forge of [false, true]) {
    const L = forge ? '[.forge]' : '[legacy]';
    const root = mkRoot({ forge });
    const dir = writeRun(root, 'chk-1', { report: REPORT });
    t(L + ' nothing recorded -> check exit 1, names the record command', (() => { const r = cli(root, ['check', '--run', 'chk-1']); return r.code === 1 && /record --run chk-1/.test(r.out); })());
    t(L + ' record lands in the layout\'s run folder', E.recordSelfReview({ root, runId: 'chk-1', form: goodForm(), log: false }).code === 0 && fs.existsSync(path.join(dir, 'self-review.json')));
    let r = cli(root, ['check', '--run', 'chk-1']);
    t(L + ' recorded + heading -> check exit 0', r.code === 0 && /OK/.test(r.out), r.out);
    fs.writeFileSync(path.join(dir, 'final-report.md'), '# Final report\n\nno self-review here\n');
    r = cli(root, ['check', '--run', 'chk-1']);
    t(L + ' report without the heading -> exit 1, names the template command', r.code === 1 && /no "## Self-review" section .*template --run chk-1/.test(r.out), r.out);
    fs.writeFileSync(path.join(dir, 'final-report.md'), '# Final report\n\n## 15. Self-review\n\n...\n');
    t(L + ' a numbered heading "## 15. Self-review" counts', cli(root, ['check', '--run', 'chk-1']).code === 0);
    fs.writeFileSync(path.join(dir, 'final-report.md'), '# Final report\n\n### Self-review\n');
    t(L + ' a level-3 heading does not count (the contract names "## Self-review")', cli(root, ['check', '--run', 'chk-1']).code === 1);
    fs.writeFileSync(path.join(dir, 'final-report.md'), REPORT);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'self-review.json'), 'utf8'));
    rec.review.answers[1].answer = 'Edited later without recording again.';
    fs.writeFileSync(path.join(dir, 'self-review.json'), JSON.stringify(rec));
    r = cli(root, ['check', '--run', 'chk-1', '--json']);
    t(L + ' an answer edited after recording -> exit 1 (tamper caught)', r.code === 1 && /edited after it was recorded/.test(JSON.parse(r.out).problems.join(' ')));
    E.recordSelfReview({ root, runId: 'chk-1', form: goodForm(), log: false });
    fs.copyFileSync(path.join(dir, 'self-review.json'), path.join(mk(runDirIn(root, 'chk-2')), 'self-review.json'));
    fs.writeFileSync(path.join(runDirIn(root, 'chk-2'), 'final-report.md'), REPORT);
    t(L + ' a record copied from another run -> exit 1 (belongs to run chk-1)', (() => { const x = cli(root, ['check', '--run', 'chk-2']); return x.code === 1 && /belongs to run "chk-1"/.test(x.out); })());
    fs.writeFileSync(path.join(runDirIn(root, 'chk-2'), 'self-review.json'), '{not json');
    t(L + ' an unreadable record -> exit 1', /not valid JSON/.test(cli(root, ['check', '--run', 'chk-2']).out));
    t(L + ' check without --run -> exit 2', cli(root, ['check']).code === 2);
  }
  {
    // a question added after recording must be answered too (judged against the CURRENT set)
    const root = mkRoot();
    writeRun(root, 'grow-1', { report: REPORT });
    E.recordSelfReview({ root, runId: 'grow-1', form: goodForm(), log: false });
    const qf = path.join(root, '.claude', 'config', 'quality', 'self-review-questions.json');
    const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
    q.questions.push({ id: 'q13', short: { en: 'A new question?', nl: 'Een nieuwe vraag?' }, ask: { en: 'Answer it.', nl: 'Beantwoord haar.' } });
    fs.writeFileSync(qf, JSON.stringify(q));
    const c = E.checkRecorded({ root, runId: 'grow-1' });
    t('a question appended after recording -> not complete (q13 has no answer), with a note', !c.ok && c.problems.some((p) => /^q13 .*no answer/.test(p)) && c.notes.some((n) => /question set changed/.test(n)), JSON.stringify(c));
  }

  // ================================================================================================
  console.log('\nE) the run-contract rule end-self-review');
  // ================================================================================================
  const rule = PROD.rules.find((r) => r.id === 'end-self-review');
  {
    t('the rule is in the production registry: run-evidence self-review, warn, complexity:>=L2, phase complete, since 2026-10-24',
      !!rule && rule.check.type === 'run-evidence' && rule.check.evidence === 'self-review' && rule.severity === 'warn' && rule.trigger === 'complexity:>=L2' && rule.phase === 'complete' && rule.since === '2026-10-24');
    t('no agent exception and not cannot_override: only the owner_override path clears it', !!rule && rule.check.exception === undefined && rule.cannot_override === undefined && /owner_override/.test(rule.override));
    t('it carries message {en, nl} and a next_step naming template and record', !!rule && rule.message.en.length > 60 && rule.message.nl.length > 60 && /forge-endreview\.cjs template/.test(rule.next_step) && /forge-endreview\.cjs record/.test(rule.next_step));
    const meta = RC.loadRulesMeta(REAL_RULES);
    t('this checker knows the self-review evidence (nothing degraded)', !meta.unknownCheckTypes.length && !meta.unknownTriggers.length && RC.RUN_EVIDENCE_KINDS.has('self-review'));
    const step2 = PROD.completion_sequence.find((s) => s.id === 'final-report');
    t('completion step 2 points at forge-endreview template and names the rule', /forge-endreview\.cjs template --run <run_id>/.test(step2.command) && step2.rule_ids.includes('end-self-review') && /forge-endreview\.cjs record/.test(step2.produces));
  }
  for (const forge of [false, true]) {
    const L = forge ? '[.forge]' : '[legacy]';
    const root = mkRoot({ forge });
    writeRun(root, 'c-none', { report: REPORT });
    let c = chk(root, 'c-none');
    const d = c.rule_details['end-self-review'] || {};
    t(L + ' L2 run without a self-review -> end-self-review is a WARNING (not missing, the run is not turned red by it)',
      c.warnings.includes('end-self-review') && !c.missing.includes('end-self-review') && !c.satisfied.includes('end-self-review'), JSON.stringify({ w: c.warnings, m: c.missing }));
    t(L + ' its detail says why and gives the next command with the run id filled in', /no self-review\.json/.test(d.reason) && /forge-endreview\.cjs template --run c-none/.test(d.next_step || '') && /forge-endreview\.cjs record --run c-none/.test((d.message || {}).en || ''), JSON.stringify(d));
    writeRun(root, 'c-ok', { report: REPORT, level: 'L3' });
    E.recordSelfReview({ root, runId: 'c-ok', form: goodForm(), log: false });
    c = chk(root, 'c-ok');
    t(L + ' L3 run with a valid record and the heading -> end-self-review is satisfied (clean)', c.satisfied.includes('end-self-review') && !c.warnings.includes('end-self-review') && c.rule_details['end-self-review'].via === 'evidence', JSON.stringify(c.rule_details['end-self-review']));
    fs.writeFileSync(path.join(runDirIn(root, 'c-ok'), 'final-report.md'), '# Final report without the section\n');
    t(L + ' the same record but the report lost its heading -> warning again', chk(root, 'c-ok').warnings.includes('end-self-review'));
  }
  {
    const root = mkRoot();
    writeRun(root, 'c-l1', { level: 'L1', report: REPORT });
    const c = chk(root, 'c-l1');
    t('an L1 run: the rule does not apply (neither warned nor satisfied)', !c.warnings.includes('end-self-review') && !c.satisfied.includes('end-self-review'));
    writeRun(root, 'c-old', { events: [{ event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-10-20T09:00:00.000Z' }], report: REPORT });
    const o = chk(root, 'c-old');
    t('a run that started before 2026-10-24 is judged by the rules of its own time (historical_exempt)', o.historical_exempt.some((x) => x.id === 'end-self-review') && !o.warnings.includes('end-self-review'));
    writeRun(root, 'c-own', { report: REPORT, extra: [{ event_type: 'owner_override', rule: 'end-self-review', reason: 'owner reviewed this run in person with the lead', by: 'owner' }] });
    const w = chk(root, 'c-own');
    t('a valid owner_override clears it and is reported as overridden', w.overridden.some((x) => x.id === 'end-self-review') && !w.warnings.includes('end-self-review'), JSON.stringify(w.overridden));
    writeRun(root, 'c-agent', { report: REPORT, extra: [{ event_type: 'owner_override', rule: 'end-self-review', reason: 'build boss says it is fine', by: 'build-boss' }, { event_type: 'decision_logged', agent: 'orchestrator', rule: 'end-self-review', decision: 'not-applicable', reason: 'a tiny change, no self-review needed' }] });
    t('an agent cannot excuse it: an override by a non-owner and a decision_logged exception do not count', chk(root, 'c-agent').warnings.includes('end-self-review'));
    writeRun(root, 'c-plan');
    const plan = RC.planFor({ run_id: 'c-plan' }, { root, ownerProfilePath: NO_PROFILE });
    const text = RC.formatPlan(plan);
    const s2 = plan.sequence.find((s) => s.id === 'final-report');
    t('plan: step 2 is pending with the template command and the record hint', s2 && s2.status === 'pending' && /forge-endreview\.cjs template --run c-plan/.test(s2.command) && /forge-endreview\.cjs record --run c-plan/.test(s2.detail), JSON.stringify(s2));
    t('plan text prints the template command under step 2', /→ node \.claude\/forge-bin\/forge-endreview\.cjs template --run c-plan/.test(text), text);
  }

  // ================================================================================================
  console.log('\nF) mutations (the assertions above bite)');
  // ================================================================================================
  {
    const noRule = JSON.parse(JSON.stringify(PROD));
    noRule.rules = noRule.rules.filter((r) => r.id !== 'end-self-review');
    const root = mkRoot({ rules: noRule });
    writeRun(root, 'm-1', { report: REPORT });
    const c = chk(root, 'm-1');
    t('MUTANT rule removed: an L2 run without a self-review raises no end-self-review warning -> the E warn test would fail', !c.warnings.includes('end-self-review') && !c.rule_details['end-self-review']);
    const unknownKind = JSON.parse(JSON.stringify(PROD));
    unknownKind.rules.find((r) => r.id === 'end-self-review').check.evidence = 'self-reviews';
    const root2 = mkRoot({ rules: unknownKind });
    writeRun(root2, 'm-2', { report: REPORT });
    E.recordSelfReview({ root: root2, runId: 'm-2', form: goodForm(), log: false });
    const meta = RC.loadRulesMeta(path.join(root2, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
    const c2 = chk(root2, 'm-2');
    t('MUTANT evidence kind misspelt: the rule is reported degraded and never satisfied -> the E clean test would fail', meta.unknownCheckTypes.some((u) => u.id === 'end-self-review') && !c2.satisfied.includes('end-self-review'));
    const blockRule = JSON.parse(JSON.stringify(PROD));
    blockRule.rules.find((r) => r.id === 'end-self-review').severity = 'block';
    const root3 = mkRoot({ rules: blockRule });
    writeRun(root3, 'm-3', { report: REPORT });
    t('MUTANT severity block: the rule lands in missing instead of warnings -> the E warn test would fail', chk(root3, 'm-3').missing.includes('end-self-review'));
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
