#!/usr/bin/env node
'use strict';
/**
 * forge-claim-check.test.cjs — (owner standing rule P-000094: every mistake gets an
 * automated guard that fails on the old behaviour). The mistake: a final report claimed that EVERY package was
 * independently verified/reviewed while the run ledger held exceptions (twice on 2026-11-02: once in a run's
 * final-report.md, once in the project-level EINDRAPPORT of that day in docs).
 *   A. ledgerExceptions: wp_failed, completed-after-fail, committed-before-pass, not-verified; a clean rework loop is
 *      no exception
 *   B. RED: the two real bad sentences against a fixture ledger with a wp_failed and a commit after a FAIL
 *   C. GREEN: the corrected sentences, an absolute claim over a clean ledger, code fences / inline code, NL + EN
 *   D. the decided boundary: test tallies are not package claims; "no exceptions" does not qualify; a negation must
 *      qualify the claim itself
 *   E. CLI exit codes 0 / 3 / 2 and --json
 *   F. wiring: forge-endreview record refuses (nothing written); forge-finalize refuses a NEW finalization
 *   G. linear time on a ~250 KB pathological report
 *   I. review round 1 (HIGH 2): every bypass phrasing the Review Boss found is flagged
 *   J. review round 1 (MEDIUM 3 + 4): the false positives (incl. verbatim real report lines) are no unqualified claim
 *   K. ledger model: a wp_failed re-verified PASS is cleared; PASS -> commit -> wp_completed bookkeeping is no exception
 *   L. review round 1 (HIGH 1): ONE entry point for every owner-facing report (forge-claim-reports.cjs: run report,
 *      event-named reports, docs/**\/EINDRAPPORT*.md and docs/**\/*final*report*.md changed during the run), by mtime
 *      and by git
 *   M. wiring of that entry point: CLI --all-reports, endreview record and finalize refuse a docs report; the checker
 *      without its selection sibling refuses to judge (fail-closed)
 *   N. third round (owner-approved after two Review Boss FAILs): an empty exception list does not qualify; the work-unit
 *      list (all work, task, ticket, deliverable, onderdeel, item, step, feature) without new false positives; exceptions
 *      named in the next sentence by wp id + a failure word; a quoted list literal is data; sealed drift (a report
 *      edited after run-finalized.json is re-judged with the completeness rule, git-aware), API + CLI --sealed-drift
 *   H. mutants: each guard removed in memory -> a named assertion above would fail
 * Hermetic: fixtures live in one os.mkdtemp folder, removed at the end. Prints "<n> passed, <m> failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const SRC_FILE = path.join(BIN, 'forge-claim-check.cjs');
const REP_FILE = path.join(BIN, 'forge-claim-reports.cjs');
const C = require(SRC_FILE);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-check-')));
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR']) delete process.env[k];

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const tryRun = (name, fn) => { try { fn(); } catch (e) { t(name + ' (crashed)', false, (e && e.stack) || e); } };

// the two real bad sentences (first final report; EINDRAPPORT-2026-11-02 draft)
const BAD_NL = 'Elk pakket: Verify Boss (herhaalt de commando\'s) PASS en Review Boss (Opus 5.5 high, alleen-lezen) PASS_WITH_NOTES vóór de commit, met hoogstens één herstelronde.';
const BAD_EN = 'Better: you now have a working app; every change was checked by an independent verifier and reviewer before it was committed.';
// the corrected sentences as they were written after the review
const GOOD_EN = 'Better: you now have a working app; almost every code package was checked by an independent verifier and reviewer before it was committed (exceptions: B8-2 and B8-3 were committed after a FAIL on a design bar).';
const GOOD_EN_ALL = 'Better: almost every code package was checked by an independent verifier and reviewer before it was committed (exceptions: B8-2 and B8-3 were committed after a FAIL; B8 was verified only through its sub-packages).';
const GOOD_NL = '- Bijna elk codepakket: Verify Boss PASS en Review Boss PASS_WITH_NOTES vóór de commit. **Uitzonderingen, eerlijk:** B8-2 en B8-3 zijn gecommit ná een FAIL; B8 is alleen via zijn subpakketten geverifieerd.';

// a fixture ledger: B8-2 wp_failed, B8-3 committed after a FAIL, B8 parent verified only via sub-packages, R a clean rework loop
const EXC_LEDGER = [
  { event_type: 'run_started' },
  { event_type: 'wp_completed', wp_id: 'R', commit: 'r1' },
  { event_type: 'wp_verified', wp_id: 'R', verdict: 'PASS' },
  { event_type: 'wp_verified', wp_id: 'B8-3', verdict: 'FAIL' },
  { event_type: 'review_completed', wp_id: 'B8-3', agent: 'Review Boss', verdict: 'FAIL' },
  { event_type: 'wp_completed', wp_id: 'B8-3', commit: '8be84a0' },
  { event_type: 'wp_failed', wp_id: 'B8-2', reason: 'craft review FAIL' },
  { event_type: 'wp_completed', wp_id: 'B8' },
];
const CLEAN_LEDGER = [
  { event_type: 'run_started' },
  { event_type: 'wp_completed', wp_id: 'A1', commit: 'abc' },
  { event_type: 'wp_verified', wp_id: 'A1', verdict: 'PASS' },
  { event_type: 'review_completed', wp_id: 'A1', agent: 'Review Boss', verdict: 'PASS_WITH_NOTES' },
  // a normal rework loop: FAIL -> fix -> wp_completed (no commit) -> PASS -> commit
  { event_type: 'wp_verified', wp_id: 'A2', verdict: 'FAIL' },
  { event_type: 'wp_completed', wp_id: 'A2' },
  { event_type: 'wp_verified', wp_id: 'A2', verdict: 'PASS' },
  { event_type: 'file_changed', wp_id: 'A2', commit: 'def' },
];
const report = (...paras) => '# Final report\n\n' + paras.join('\n\n') + '\n';
const flagged = (s) => { const r = C.check(report(s), EXC_LEDGER); return !r.ok && r.findings.length >= 1; };
const noClaim = (s) => C.check(report(s), EXC_LEDGER).claims.length === 0;
const okOver = (s) => C.check(report(s), EXC_LEDGER).ok;

// the bypass phrasings of review round 1 (HIGH 2) — each must be flagged over a ledger with exceptions
const BYPASS = [
  'Everything was independently verified and reviewed.',
  'Alles is onafhankelijk geverifieerd.',
  'Elk pakket: verify PASS, review PASS',
  'Elk pakket is gereviewed.',
  'Every package, without fail, was reviewed by Review Boss.',
  'Every package (all 40 of them) was verified by Verify Boss.',
  'Every package was verified by Verify Boss, not by its builder.',
  'Elk pakket: Verify PASS.',
  'Alles is gecontroleerd door een onafhankelijke verifier.',
  '100 % of the packages were verified by Verify Boss.',
  'De pakketten zijn stuk voor stuk geverifieerd.',
  'Packages were reviewed without fail.',
  'Every change was reviewed, and not one was skipped.',
  'All work packages got a Verify Boss PASS and a Review Boss PASS_WITH_NOTES before the commit.',
  'We can confirm: "every package was verified and reviewed".',
  'Every package was verified, but not re-reviewed.',
  'Elk pakket: tests groen, Verify Boss PASS.',
  'Every package was reviewed and nothing failed.',
  'Every package was code-reviewed and re-verified.',
  '| All packages | verified by Verify Boss |',
  'Each of the packages was reviewed.',
  // final-report.md line 6 (verbatim): its ledger has 10 packages with no PASS
  'Everything independent in the plan is built, committed locally, green and independently verified.',
  'Every package was verified by Verify Boss, as it must be.',
  'It would be wrong to say otherwise: every package was verified by Verify Boss.',
  'Every package was verified by Verify Boss. We claimed nothing else.',
];
// the false positives of review round 1 (MEDIUM 3 + 4) and of the real-data replay — none is an unqualified claim
const NOT_A_CLAIM = [
  'All four lanes ran independently in their own worktree.',
  'Alle lanes liepen onafhankelijk van elkaar.',
  'The verifier always runs before a commit.',
  // EINDRAPPORT-2026-11-02 line 59 (first wording): a skill content scan, not a package verification claim
  'Every new skill was checked for hidden commands, secret reads and prompt injection.',
  // final-report.md line 98 (verbatim, inline code blanked)
  '**q8 — Volg ik elke regel?** Isolatie (alleen deze map, nooit settings.json), één schrijver per bestand (één incident, hersteld en als regel vastgelegd), eerlijkheid (geen PASS zonder verifier), scratch onder `_scratch/`. Codex uit op jouw verzoek.',
  // final-report.md line 8: "elk" refers to findings, not to work packages
  'Elk eerst geverifieerd via een 4-agent read-only workflow-fan-out (4/4 CONFIRMED met file:line), elk RED-bewezen:',
  // final-report.md line 72
  'Codex reviews (one initial plus one verification each; the plugin was never installed).',
  // EINDRAPPORT-2026-11-02 line 103: a quotation of the old wrong sentence is data, not a claim
  '- This very report first claimed "every change was checked independently" — the same overgeneralisation I had already made once today.',
  'Alle 1,234 tests van de pakketten zijn groen en gereviewd.',
  'After the last commit, every new skill was checked for hidden commands.',
  // real-data replay round 2: final-report.md lines 54 and 82 (verbatim,
  // inline code blanked) and the forge-systeem master prompt doc, line 49 (shortened)
  'raw verify-protect lists 9 changes, all explained by the adoption record;',
  '| R5 scribe verify |                             | NEEDS FIXES (SV-01..09) | all nine fixed with failing-first tests (seq 172) |',
  'installer starts on a free port, every setting changes behaviour, green doctor, FALLBACK security review without CRITICAL/HIGH, craft-lens review.',
  // real-data replay round 3 (recall diff): verbatim or shortened real lines that are no package verification claim
  '(fail-closed — anders zou elke receipt-commit een nieuwe review eisen, oneindig).',
  'Every package will be reviewed by Review Boss before the merge.',
  'Fixed every confirmed defect template-first, tested each fix, synced to 8 projects, and re-ran the full verification suite.',
  '**Run:** x · **Owner-opdracht:** "doe alles behalve vloot-sync en doe dan aan het einde codex review en fix het dan"',
  'Owner-directive (letterlijk): *"codex is enabled"* — binnen de standing /goal ("… ook zouden we willen dat codex alles rechecked voor de zekerheid").',
  'Alles behalve B8-2 en B8-3 is geverifieerd door Verify Boss.',
];

try {
  // ---------------------------------------------------------------- A
  console.log('A. ledger exceptions');
  {
    const ex = C.ledgerExceptions(EXC_LEDGER);
    const has = (wp, kind) => ex.some((x) => x.wp_id === wp && x.kind === kind);
    t('A1 a wp_failed event is an exception (B8-2)', has('B8-2', 'wp_failed'), JSON.stringify(ex));
    t('A2 a commit over an uncleared FAIL is an exception (B8-3 completed-after-fail)', has('B8-3', 'completed-after-fail'), JSON.stringify(ex));
    t('A3 a parent completed without its own wp_verified PASS is an exception (B8 not-verified)', has('B8', 'not-verified'), JSON.stringify(ex));
    t('A4 a package completed then verified PASS is no exception (R)', !ex.some((x) => x.wp_id === 'R'));
    t('A5 a clean ledger (incl. FAIL -> fix -> PASS -> commit) has no exception', C.ledgerExceptions(CLEAN_LEDGER).length === 0, JSON.stringify(C.ledgerExceptions(CLEAN_LEDGER)));
    const cbp = C.ledgerExceptions([{ event_type: 'wp_verified', wp_id: 'X', verdict: 'FAIL' }, { event_type: 'wp_completed', wp_id: 'X', commit: 'c1' }, { event_type: 'wp_verified', wp_id: 'X', verdict: 'PASS' }]);
    t('A6 a commit between a FAIL and its PASS is committed-before-pass', cbp.length === 1 && cbp[0].kind === 'committed-before-pass', JSON.stringify(cbp));
    const rev = C.ledgerExceptions([{ event_type: 'review_completed', wp_id: 'Y', verdict: 'FAIL' }, { event_type: 'wp_completed', wp_id: 'Y' }, { event_type: 'wp_verified', wp_id: 'Y', verdict: 'PASS' }]);
    t('A7 a verify PASS does not clear a REVIEW FAIL (kinds are separate)', rev.some((x) => x.wp_id === 'Y' && x.kind === 'completed-after-fail'), JSON.stringify(rev));
    const note = C.ledgerExceptions([{ event_type: 'agent_note', wp_id: 'Z', agent: 'lead', verdict: 'fail' }, { event_type: 'file_changed', wp_id: 'Z' }]);
    t('A8 a note carrying wp_id + verdict fail counts as a FAIL verdict', note.some((x) => x.wp_id === 'Z' && x.kind === 'completed-after-fail'), JSON.stringify(note));
    t('A9 garbage entries are ignored, not a crash', C.ledgerExceptions([null, 7, 'x', {}]).length === 0);
  }

  // ---------------------------------------------------------------- B
  console.log('B. RED: the real bad sentences against a ledger with exceptions');
  {
    const rNl = C.check(report('## 4. Reviews', BAD_NL), EXC_LEDGER);
    t('B1 the Dutch bad sentence ("Elk pakket: Verify Boss ... PASS") is flagged', !rNl.ok && rNl.findings.length === 1, JSON.stringify(rNl.findings));
    t('B2 the finding points at the right line (5)', rNl.findings[0] && rNl.findings[0].line === 5, JSON.stringify(rNl.findings));
    t('B3 the finding names the exception wp ids', rNl.findings[0] && /B8-2/.test(rNl.findings[0].reason) && /B8-3/.test(rNl.findings[0].reason), rNl.findings[0] && rNl.findings[0].reason);
    const rEn = C.check(report(BAD_EN), EXC_LEDGER);
    t('B4 the English bad sentence ("every change was checked by an independent verifier") is flagged', !rEn.ok && rEn.findings.length === 1, JSON.stringify(rEn));
    const wrapped = C.check('# R\n\nBetter: every change was checked\nby an independent verifier.\n', EXC_LEDGER);
    t('B5 a claim wrapped over two lines is still one claim (line 3)', !wrapped.ok && wrapped.findings[0].line === 3, JSON.stringify(wrapped.findings));
    t('B6 "zonder uitzondering" / "no exceptions" does NOT qualify a claim', !C.check(report('Alle pakketten zijn onafhankelijk geverifieerd, zonder uitzondering.'), EXC_LEDGER).ok
      && !C.check(report('All packages were independently verified, with no exceptions.'), EXC_LEDGER).ok);
    const otherNeg = C.check(report('q5 het profiel is dus ook niet aangeraakt. q9 elk pakket onafhankelijk geverifieerd en gereviewd.'), EXC_LEDGER);
    t('B7 a negation in ANOTHER sentence of the paragraph does not qualify the claim (real-data replay case)', !otherNeg.ok, JSON.stringify(otherNeg));
    t('B8 "always verified" and "each ... reviewed" are claims too', !C.check(report('Packages were always verified before a commit.'), EXC_LEDGER).ok && !C.check(report('Each package was reviewed by Review Boss.'), EXC_LEDGER).ok);
  }

  // ---------------------------------------------------------------- C
  console.log('C. GREEN: corrected sentences, clean ledger, code, NL + EN');
  {
    t('C1 the corrected English sentence (almost every ... exceptions: B8-2 and B8-3) passes', C.check(report(GOOD_EN), EXC_LEDGER).ok);
    t('C2 the corrected Dutch sentence (Bijna elk ... Uitzonderingen) passes', C.check(report(GOOD_NL), EXC_LEDGER).ok);
    const sep = C.check(report(BAD_NL + '\nUitzonderingen: B8-2 en B8-3 (gecommit na een FAIL).'), EXC_LEDGER);
    t('C3 exceptions named on the next line of the same paragraph qualify the claim', sep.ok && sep.claims.length === 1 && sep.claims[0].qualified, JSON.stringify(sep));
    const clean = C.check(report(BAD_NL, BAD_EN), CLEAN_LEDGER);
    t('C4 an absolute claim over a ledger with NO exceptions passes (and is still listed as a claim)', clean.ok && clean.claims.length === 2, JSON.stringify(clean));
    t('C5 a claim inside a ``` code fence is data, not a claim', C.check('# R\n\n```\n' + BAD_EN + '\n```\n', EXC_LEDGER).ok);
    t('C6 a claim inside a ~~~ fence is data too', C.check('# R\n\n~~~text\n' + BAD_NL + '\n~~~\n', EXC_LEDGER).ok);
    t('C7 a claim inside inline code is data', C.check(report('The old sentence was `every change was checked by an independent verifier`.'), EXC_LEDGER).ok);
    t('C8 a negation in the claim\'s own sentence qualifies it ("not every package was re-reviewed")', C.check(report('Not every package was re-reviewed after the low-note fixes.'), EXC_LEDGER).ok);
    t('C9 an empty report and an empty ledger are ok', C.check('', []).ok && C.check(report(BAD_EN), []).ok);
  }

  // ---------------------------------------------------------------- D
  console.log('D. boundary: test tallies are not package claims; the claim window');
  {
    for (const s of ['Every test passed.', 'All 207 suites green, 16588 passed, 0 failed.', 'Alle tests groen.', 'All gates verified green.', 'All 12 checks verified.', 'Alle suites van beide repo\'s groen en gecontroleerd.'])
      t('D tally is no claim: ' + s, C.check(report(s), EXC_LEDGER).claims.length === 0, JSON.stringify(C.check(report(s), EXC_LEDGER).claims));
    const far = 'alle golf-B-pakketten geïntegreerd (11 commits), permissiepoort beveiligd na een onafhankelijke sign-off (zie 4).';
    t('D a sign-off of something else beside an "all packages" phrase is no claim (real report line)', C.check(report(far), EXC_LEDGER).claims.length === 0);
    t('D a heading is its own paragraph (exceptions in the heading do not leak into the next paragraph)', !C.check('# R\n\n## Exceptions\n' + BAD_EN + '\n', EXC_LEDGER).ok);
    t('D an ellipsis inside the sentence does not split the claim', C.isClaim('Elk pakket: Verify Boss ... PASS'));
    t('D a tally quantifier next to a package noun is still a tally ("All tests of the packages passed review.")', noClaim('All tests of the packages passed review.'));
  }

  // ---------------------------------------------------------------- I
  console.log('I. bypass phrasings (review round 1, HIGH 2) are flagged');
  for (const s of BYPASS) t('I flagged: ' + s, flagged(s), JSON.stringify(C.check(report(s), EXC_LEDGER).claims));
  {
    t('I a negation that qualifies the claim itself still clears it ("was not verified")', okOver('Every package was not verified by Verify Boss in this run.'));
    t('I a hedge right before the quantifier clears it ("nearly all packages ...")', okOver('Nearly all packages were reviewed by Review Boss.'));
    t('I a hedge elsewhere in the sentence does not ("... in almost no time")', flagged('Every package was verified by Verify Boss in almost no time.'));
    t('I an exception named in the claim\'s own sentence clears it ("except B8-2")', okOver('Every package was verified by Verify Boss except B8-2 and B8-3.'));
    t('I "every exception" is no exception list', flagged('Every package was verified and every exception was logged.'));
    t('I an unrelated "exception" in another sentence of the paragraph does not clear it', flagged('Every package was verified by Verify Boss. The exception handler was rewritten.'));
    t('I another sentence naming a ledger exception id with an exception word clears it', okOver('Every package was verified by Verify Boss. B8-2 is the one exception, see section 5.'));
    t('I an honest negative verdict in the window is no success claim ("review of every fix: BLOCK")', okOver('Codex verification review of every fix: BLOCK.'));
    t('I "0 FAIL" / "no FAIL" is not a negative verdict', flagged('Every package: verify PASS, review PASS, 0 FAIL.') && flagged('Every package was reviewed with no FAIL at all.') && flagged('Every package was reviewed without a single FAIL.'));
    t('I a quotation only counts as data after a distancing verb (claimed, schreef, ...)', okOver('De oude zin schreef "elk pakket is onafhankelijk geverifieerd" en dat was fout.'));
  }

  // ---------------------------------------------------------------- J
  console.log('J. false positives (review round 1, MEDIUM 3 + 4, real lines) are no unqualified claim');
  for (const s of NOT_A_CLAIM) t('J not flagged: ' + s.slice(0, 90), okOver(s), JSON.stringify(C.check(report(s), EXC_LEDGER).claims));
  {
    t('J bare independent(ly)/onafhankelijk never makes a claim on its own', noClaim('Every package was built independently.') && noClaim('Elk pakket liep onafhankelijk.'));
    t('J a lane with only a weak check word is no claim, a lane with a verify/review verdict is', noClaim('All lanes were checked out from main.') && flagged('Drie parallelle lanes, elk onafhankelijk geverifieerd (PASS), commit 406dd92.'));
    t('J a process statement without a work unit is no claim ("Verify Boss always reviews before the Lead merges")', noClaim('Verify Boss always reviews before the Lead merges.'));
    const MISSIE = '# R\n\n## 1. Missie (owner, letterlijk — /goal 2026-09-24)\n> ik wil dat codex alles rechecked en elk pakket geverifieerd wordt\n> en dat alles gereviewd is\n';
    t('J a blockquote under a line that says it quotes the owner (letterlijk/verbatim/owner/goal) is data (real run config-v250 line 6)', C.check(MISSIE, EXC_LEDGER).claims.length === 0, JSON.stringify(C.check(MISSIE, EXC_LEDGER).claims));
    t('J a blockquote WITHOUT such an introduction is judged like any text ("> Every package was verified")', !C.check('# R\n\n## Status\n> Every package was verified by Verify Boss.\n', EXC_LEDGER).ok);
    const split = C.check(report('**Eindoordeel: PASS CORE / PARTIAL PROOF.** Alles wat je vroeg is gebouwd, getest en gecommit.'), EXC_LEDGER);
    t('J a sentence ends after closing markup (".**"): a PASS label in the previous sentence does not join the next (real run owner-followups line 5)', split.ok && split.claims.length === 0, JSON.stringify(split.claims));
  }

  // ---------------------------------------------------------------- K
  console.log('K. ledger model refinements');
  {
    const k1 = C.ledgerExceptions([{ event_type: 'wp_failed', wp_id: 'X', reason: 'r1' }, { event_type: 'wp_completed', wp_id: 'X' }, { event_type: 'wp_verified', wp_id: 'X', verdict: 'PASS' }]);
    t('K1 a wp_failed that was later re-verified PASS (no commit in between) is cleared', k1.length === 0, JSON.stringify(k1));
    const k2 = C.ledgerExceptions([{ event_type: 'wp_failed', wp_id: 'X' }, { event_type: 'file_changed', wp_id: 'X', commit: 'c9' }, { event_type: 'wp_verified', wp_id: 'X', verdict: 'PASS' }]);
    t('K2 a commit between the wp_failed and the clearing PASS is committed-before-pass', k2.length === 1 && k2[0].kind === 'committed-before-pass', JSON.stringify(k2));
    const k3 = C.ledgerExceptions([{ event_type: 'wp_failed', reason: 'no id' }, { event_type: 'wp_verified', verdict: 'PASS' }]);
    t('K3 a wp_failed without a wp_id is always an exception', k3.length === 1 && k3[0].kind === 'wp_failed', JSON.stringify(k3));
    const k4 = C.ledgerExceptions([{ event_type: 'wp_verified', wp_id: 'RS', verdict: 'PASS' }, { event_type: 'file_changed', wp_id: 'RS', commit: '406dd92' }, { event_type: 'wp_completed', wp_id: 'RS' }]);
    t('K4 PASS -> commit -> wp_completed (integration bookkeeping, real run RED-SUITES) is no exception', k4.length === 0, JSON.stringify(k4));
    const k5 = C.ledgerExceptions([{ event_type: 'wp_failed', wp_id: 'X' }, { event_type: 'review_completed', wp_id: 'X', agent: 'Review Boss', verdict: 'PASS' }]);
    t('K5 a review PASS does not clear a wp_failed (only a wp_verified PASS does)', k5.some((x) => x.kind === 'wp_failed'), JSON.stringify(k5));
    const k6 = C.ledgerExceptions([{ event_type: 'wp_verified', wp_id: 'X', verdict: 'PASS' }, { event_type: 'wp_verified', wp_id: 'X', verdict: 'FAIL' }, { event_type: 'wp_completed', wp_id: 'X', commit: 'c' }]);
    t('K6 a FAIL after an earlier PASS, then work, is still completed-after-fail', k6.some((x) => x.kind === 'completed-after-fail'), JSON.stringify(k6));
  }

  // ---------------------------------------------------------------- E
  console.log('E. CLI');
  const ROOT = path.join(TMP, 'proj');
  const runDir = (id) => path.join(ROOT, '.claude', 'forge-runs', id);
  const writeRun = (id, events, rep, root) => {
    const d = path.join(root || ROOT, '.claude', 'forge-runs', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    if (rep !== undefined) fs.writeFileSync(path.join(d, 'final-report.md'), rep);
    return d;
  };
  const cli = (...a) => spawnSync(process.execPath, [SRC_FILE, '--root', ROOT, ...a], { encoding: 'utf8', timeout: 30000 });
  {
    writeRun('bad', EXC_LEDGER, report(BAD_EN));
    writeRun('good', EXC_LEDGER, report(GOOD_EN));
    writeRun('norep', EXC_LEDGER);
    const b = cli('--run', 'bad');
    t('E1 exit 3 on an unqualified claim vs exceptions', b.status === 3, b.status + ' ' + b.stdout + b.stderr);
    t('E2 the offending line and the exception wp ids are printed', /line 3: .*every change was checked/.test(b.stdout) && /B8-2 \[wp_failed\]/.test(b.stdout) && /B8-3 \[completed-after-fail\]/.test(b.stdout), b.stdout);
    const g = cli('--run', 'good');
    t('E3 exit 0 on the corrected report', g.status === 0 && /CLAIMS OK/.test(g.stdout), g.status + ' ' + g.stdout + g.stderr);
    const rp = cli('--run', 'good', '--report', path.join(runDir('bad'), 'final-report.md'));
    t('E4 --report judges another file against this run\'s ledger', rp.status === 3, rp.status + ' ' + rp.stdout);
    const j = cli('--run', 'bad', '--json');
    let jj = null; try { jj = JSON.parse(j.stdout); } catch { jj = null; }
    t('E5 --json gives code, findings and exceptions', j.status === 3 && jj && jj.code === 3 && jj.findings.length === 1 && jj.exceptions.length >= 3, j.stdout);
    t('E6 exit 2 without --run', cli().status === 2);
    t('E7 exit 2 on a bad run id', cli('--run', '../x').status === 2);
    t('E8 exit 2 when the report is missing', cli('--run', 'norep').status === 2);
    t('E9 exit 2 on an unknown flag', cli('--run', 'bad', '--nope').status === 2);
  }

  // ---------------------------------------------------------------- F
  console.log('F. wiring: forge-endreview record and forge-finalize');
  const E = require('./forge-endreview.cjs');
  const F = require('./forge-finalize.cjs');
  const QS = JSON.parse(fs.readFileSync(path.join(BIN, '..', 'config', 'quality', 'self-review-questions.json'), 'utf8')).questions;
  const answers = {};
  for (const q of QS) answers[q.id] = { answer: 'Answered ' + q.id + ' after re-reading the work.', evidence: 'node forge-claim-check.test.cjs exit 0' };
  const form = { reviewer: 'test lead', answers };
  const SR = '\n\n## Self-review\n\nq1 ... q12 below.\n';
  const withQuestions = (root) => {
    fs.mkdirSync(path.join(root, '.claude', 'config', 'quality'), { recursive: true });
    fs.copyFileSync(path.join(BIN, '..', 'config', 'quality', 'self-review-questions.json'), path.join(root, '.claude', 'config', 'quality', 'self-review-questions.json'));
  };
  const FR = path.join(TMP, 'fin');
  const LE = path.join(FR, '.claude', 'forge-dashboard', 'log-event.cjs');
  const logTo = (run, type, extra) => spawnSync(process.execPath, [LE, run, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, extra || {}))], { encoding: 'utf8', cwd: FR, env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: FR }), timeout: 30000 });
  const finDir = (run) => path.join(FR, '.claude', 'forge-runs', run);
  {
    withQuestions(ROOT);
    writeRun('er-bad', EXC_LEDGER, report(BAD_NL) + SR);
    const rb = E.recordSelfReview({ root: ROOT, runId: 'er-bad', form, log: false });
    t('F1 endreview record REFUSES (code 1) a report whose absolute claim meets ledger exceptions', rb.code === 1 && rb.problems.some((p) => /final-report\.md line 3/.test(p) && /B8-2/.test(p)), JSON.stringify(rb));
    t('F2 ... and writes nothing', !fs.existsSync(path.join(runDir('er-bad'), 'self-review.json')));
    writeRun('er-good', EXC_LEDGER, report(GOOD_NL) + SR);
    const rg = E.recordSelfReview({ root: ROOT, runId: 'er-good', form, log: false });
    t('F3 endreview record accepts the corrected report', rg.code === 0 && fs.existsSync(path.join(runDir('er-good'), 'self-review.json')), JSON.stringify(rg));
    const cliRec = spawnSync(process.execPath, [path.join(BIN, 'forge-endreview.cjs'), 'record', '--root', ROOT, '--run', 'er-bad', '--answers', '-'], { input: JSON.stringify(form), encoding: 'utf8', timeout: 30000 });
    t('F4 the endreview CLI record exits non-zero with the claim in its message', cliRec.status === 1 && /line 3/.test(cliRec.stderr + cliRec.stdout), cliRec.status + ' ' + cliRec.stdout + cliRec.stderr);

    t('F5 finalize.claimCheckRefusal refuses the bad report and names the wp ids', typeof F.claimCheckRefusal === 'function' && (() => { const r = F.claimCheckRefusal(runDir('er-bad'), EXC_LEDGER); return r && /B8-2/.test(r.reason) && r.findings.length === 1; })());
    t('F6 finalize.claimCheckRefusal passes the corrected report and a run without a report', typeof F.claimCheckRefusal === 'function' && F.claimCheckRefusal(runDir('er-good'), EXC_LEDGER) === null && F.claimCheckRefusal(runDir('norep'), EXC_LEDGER) === null);
    // end to end through finalize(): a hermetic root with the real event writer (hash chain) next to this forge-bin
    for (const d of ['forge-dashboard', 'forge-bin', path.join('config', 'orchestration')]) fs.mkdirSync(path.join(FR, '.claude', d), { recursive: true });
    fs.copyFileSync(path.join(BIN, '..', 'forge-dashboard', 'log-event.cjs'), LE);
    fs.writeFileSync(path.join(FR, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({ owners_allowlist: ['owner'], rules: [{ id: 'has-start', rule: 'start', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' }] }));
    for (const run of ['fin-bad', 'fin-good']) {
      logTo(run, 'run_started', { note: 's' });
      logTo(run, 'wp_failed', { wp_id: 'B8-2', reason: 'craft review FAIL' });
      logTo(run, 'run_completed', { command: 'x', output: 'done', note: 'done' });
    }
    const evOk = fs.existsSync(path.join(finDir('fin-bad'), 'events.jsonl'));
    t('F7 fixture: the real writer logged the events', evOk, fs.existsSync(finDir('fin-bad')) ? fs.readdirSync(finDir('fin-bad')).join(',') : 'no run dir');
    fs.writeFileSync(path.join(finDir('fin-bad'), 'final-report.md'), report(BAD_EN));
    fs.writeFileSync(path.join(finDir('fin-good'), 'final-report.md'), report(GOOD_EN));
    const fb = F.finalize(FR, 'fin-bad');
    t('F8 finalize() REFUSES a new finalization over an unqualified claim (claim_check set, B8-2 named)', fb.ok === false && Array.isArray(fb.claim_check) && fb.claim_check.length === 1 && /B8-2/.test(fb.reason), JSON.stringify(fb).slice(0, 400));
    t('F9 ... and writes no receipt', !fs.existsSync(path.join(finDir('fin-bad'), 'run-finalized.json')));
    const fg = F.finalize(FR, 'fin-good');
    t('F10 finalize() with the corrected report is not refused by the claim check (it stops later, on the missing gate evidence)', !fg.claim_check && !/claimt dat ELK/.test(String(fg.reason)), JSON.stringify(fg).slice(0, 300));
  }

  // ---------------------------------------------------------------- L
  console.log('L. one entry point for every owner-facing report');
  const LR = path.join(TMP, 'rep');
  const T0 = Date.now() - 3600e3;
  const stamped = (evs, t0) => evs.map((e, i) => Object.assign({ timestamp: new Date(t0 + i * 1000).toISOString() }, e));
  const put = (root, rel, text, mtimeMs) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (mtimeMs) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs)); return f; };
  const relsOf = (r) => r.reports.map((x) => x.rel).sort();
  tryRun('L', () => {
    const r1Events = stamped(EXC_LEDGER.concat([
      { event_type: 'report_generated', artifact: 'docs/audits/audit-report.md' },
      { event_type: 'prd_generated', path: '.claude/forge-runs/r0/final-report.md' },
      { event_type: 'report_generated', path: '../outside-report.md' },
      { event_type: 'report_generated', evidence: 'docs/plans/PLAN.md; docs/audits/missing-report.md' },
    ]), T0);
    writeRun('r1', r1Events, report(GOOD_EN_ALL), LR);
    writeRun('r0', stamped(EXC_LEDGER, T0 - 864e5), report(BAD_EN), LR);
    put(LR, 'docs/audits/audit-report.md', report(BAD_EN), T0 - 5 * 864e5);
    put(LR, 'docs/forge-systeem/EINDRAPPORT-x.md', report(BAD_NL));
    put(LR, 'docs/old/EINDRAPPORT-old.md', report(BAD_EN), T0 - 864e5);
    put(LR, 'docs/notes/my-final-test-report.md', report(BAD_EN));
    put(LR, 'docs/notes/plan.md', report(BAD_EN));
    put(LR, 'docs/plans/PLAN.md', report(BAD_EN));
    put(TMP, 'outside-report.md', report(BAD_EN));
    const sel = C.reportsForRun({ root: LR, runDir: path.join(LR, '.claude', 'forge-runs', 'r1'), events: r1Events });
    const rels = relsOf(sel);
    t('L1 the run report, the event-named report and the docs reports changed during the run are selected',
      JSON.stringify(rels) === JSON.stringify(['.claude/forge-runs/r1/final-report.md', 'docs/audits/audit-report.md', 'docs/forge-systeem/EINDRAPPORT-x.md', 'docs/notes/my-final-test-report.md']), JSON.stringify(rels) + ' notes ' + JSON.stringify(sel.notes));
    t('L2 another run\'s report named by a prd event is left to that run (with a note)', !rels.some((r) => /r0/.test(r)) && sel.notes.some((n) => /another run/.test(n)), JSON.stringify(sel.notes));
    t('L3 a path outside the project and a missing named report are noted, not judged', !rels.some((r) => /outside/.test(r)) && sel.notes.some((n) => /outside the project/.test(n)) && sel.notes.some((n) => /missing-report\.md/.test(n)), JSON.stringify(sel.notes));
    t('L4 a docs report not changed since the run\'s first event is not this run\'s (EINDRAPPORT-old)', !rels.some((r) => /EINDRAPPORT-old/.test(r)));
    t('L5 a docs file that is no report by name (plan.md) is not selected; an event-named plan is not a report', !rels.some((r) => /plan\.md$/i.test(r)));
    const cr = C.checkReports({ root: LR, runId: 'r1' });
    const byFile = (f) => cr.findings.filter((x) => x.file === f).length;
    t('L6 checkReports judges every selected report against the run ledger (code 3, 3 files flagged, the run report clean)',
      cr.code === 3 && byFile('docs/audits/audit-report.md') === 1 && byFile('docs/forge-systeem/EINDRAPPORT-x.md') === 1 && byFile('docs/notes/my-final-test-report.md') === 1 && byFile('.claude/forge-runs/r1/final-report.md') === 0, JSON.stringify(cr.findings));
    writeRun('r2', [{ event_type: 'run_started' }], report(GOOD_EN), LR);
    const s2 = C.reportsForRun({ root: LR, runDir: path.join(LR, '.claude', 'forge-runs', 'r2'), events: [{ event_type: 'run_started' }] });
    t('L7 a ledger without timestamps cannot bound the docs window: docs are skipped WITH a note', relsOf(s2).length === 1 && s2.notes.some((n) => /timestamp/.test(n)), JSON.stringify(s2));
    const fin = stamped([{ event_type: 'run_started' }, { event_type: 'run_finalized' }], T0 - 3 * 864e5);
    writeRun('r3', fin, report(GOOD_EN), LR);
    const s3 = C.reportsForRun({ root: LR, runDir: path.join(LR, '.claude', 'forge-runs', 'r3'), events: fin });
    t('L8 a sealed run (run_finalized) does not own docs reports changed after its receipt', !relsOf(s3).some((r) => /^docs\//.test(r)), JSON.stringify(relsOf(s3)));
    const old = stamped([{ event_type: 'run_started' }, { event_type: 'run_completed' }], T0 - 2 * 864e5);
    writeRun('r4', old, report(GOOD_EN), LR);
    const s4 = C.reportsForRun({ root: LR, runDir: path.join(LR, '.claude', 'forge-runs', 'r4'), events: old });
    // repeat of the report mistake (third time): an exception list that leaves out ledger exceptions passed as qualified
    writeRun('r5', stamped(EXC_LEDGER, T0), report(GOOD_EN), LR);
    const c5 = C.checkReports({ root: LR, runId: 'r5' });
    const f5 = c5.findings.filter((x) => x.file === '.claude/forge-runs/r5/final-report.md');
    t('L13 open run: a qualified claim whose exception list leaves out a ledger exception (B8) is flagged as incomplete', c5.code === 3 && f5.length === 1 && /incomplete/.test(f5[0].reason) && /B8(?![A-Za-z0-9-])/.test(f5[0].reason) && !/B8-2/.test(f5[0].reason.split('not named')[1] || ''), JSON.stringify({ code: c5.code, problems: c5.problems, f5 }));
    writeRun('r6', stamped(EXC_LEDGER, T0), report(GOOD_EN_ALL), LR);
    const c6 = C.checkReports({ root: LR, runId: 'r6' });
    t('L14 open run: an exception list that names every ledger exception id passes', c6.findings.filter((x) => /r6/.test(x.file)).length === 0, JSON.stringify(c6.findings));
    writeRun('r7', stamped(EXC_LEDGER.concat([{ event_type: 'run_finalized' }]), T0 - 4 * 864e5), report(GOOD_EN), LR);
    const c7 = C.checkReports({ root: LR, runId: 'r7' });
    t('L15 a sealed run keeps the earlier rule (a named exception list qualifies; completeness is not re-judged)', c7.findings.filter((x) => /r7/.test(x.file)).length === 0, JSON.stringify(c7.findings));
    writeRun('r8', stamped(EXC_LEDGER, T0), report('The claim guard refuses a seal when a report says every package was verified while the ledger has exceptions, also for docs reports.'), LR);
    const c8 = C.checkReports({ root: LR, runId: 'r8' });
    t('L17 open run: a sentence that DESCRIBES the guard (the noun exceptions in prose, no list) is not an incomplete list (real replay false positive)', !c8.findings.some((x) => /r8/.test(x.file) && /incomplete/.test(x.reason)), JSON.stringify(c8.findings.filter((x) => /r8/.test(x.file))));
    t('L16 check() (one report, no run state) is unchanged: GOOD_EN still qualifies', C.check(report(GOOD_EN), EXC_LEDGER).ok);
    t('L12 an open (unsealed) run does not own docs reports changed more than 6 h after its last event (real replay: 52 old runs claimed today\'s EINDRAPPORT)', !relsOf(s4).some((r) => /^docs\//.test(r)), JSON.stringify(relsOf(s4)));
  });
  // the git path: commit dates decide, not the file's mtime (a checkout touches mtimes)
  tryRun('L-git', () => {
    const gv = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (gv.status !== 0) { console.log('  note: git is not available here — the git-path assertions L9-L11 did NOT run (mtime path only)'); return; }
    const GR = path.join(TMP, 'gitproj');
    const HOOKS = path.join(TMP, 'no-hooks');
    fs.mkdirSync(GR, { recursive: true }); fs.mkdirSync(HOOKS, { recursive: true });
    const git = (args, dateMs) => spawnSync('git', ['-c', 'user.name=forge-test', '-c', 'user.email=forge-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + HOOKS, '-c', 'core.autocrlf=false', ...args],
      { cwd: GR, encoding: 'utf8', timeout: 30000, windowsHide: true, env: Object.assign({}, process.env, dateMs ? { GIT_AUTHOR_DATE: new Date(dateMs).toISOString(), GIT_COMMITTER_DATE: new Date(dateMs).toISOString() } : {}) });
    const init = git(['init', '-q']);
    if (init.status !== 0) { t('L9 git init in the fixture', false, init.stderr); return; }
    put(GR, 'docs/EINDRAPPORT-old.md', report(BAD_EN));
    git(['add', '-A']); git(['commit', '-q', '-m', 'old'], T0 - 864e5);
    fs.utimesSync(path.join(GR, 'docs/EINDRAPPORT-old.md'), new Date(), new Date()); // a checkout touched it
    put(GR, 'docs/EINDRAPPORT-new.md', report(BAD_EN));
    git(['add', '-A']); const cm = git(['commit', '-q', '-m', 'new'], T0 + 60e3);
    fs.utimesSync(path.join(GR, 'docs/EINDRAPPORT-new.md'), new Date(T0 - 2 * 864e5), new Date(T0 - 2 * 864e5));
    put(GR, 'docs/sub/EINDRAPPORT-dirty.md', report(BAD_EN));
    const gEvents = stamped([{ event_type: 'run_started' }, { event_type: 'wp_failed', wp_id: 'G1' }], T0);
    writeRun('g1', gEvents, undefined, GR);
    const sel = C.reportsForRun({ root: GR, runDir: path.join(GR, '.claude', 'forge-runs', 'g1'), events: gEvents });
    const rels = relsOf(sel);
    t('L9 git: a report COMMITTED during the run is selected even with an old mtime', cm.status === 0 && rels.includes('docs/EINDRAPPORT-new.md'), JSON.stringify(rels) + ' ' + JSON.stringify(sel.notes) + ' ' + cm.stderr);
    t('L10 git: a report committed BEFORE the run and clean is not selected, even with a fresh mtime', !rels.includes('docs/EINDRAPPORT-old.md'), JSON.stringify(rels));
    t('L11 git: an untracked report written during the run is selected', rels.includes('docs/sub/EINDRAPPORT-dirty.md'), JSON.stringify(rels));
  });

  // ---------------------------------------------------------------- M
  console.log('M. wiring of the entry point: CLI --all-reports, endreview record, finalize');
  tryRun('M', () => {
    const cliAt = (root, ...a) => spawnSync(process.execPath, [SRC_FILE, '--root', root, ...a], { encoding: 'utf8', timeout: 30000 });
    const all = cliAt(LR, '--run', 'r1', '--all-reports');
    t('M1 --all-reports exits 3 and names the docs report and its line', all.status === 3 && /docs\/forge-systeem\/EINDRAPPORT-x\.md line 3/.test(all.stdout), all.status + ' ' + all.stdout + all.stderr);
    const allJ = cliAt(LR, '--run', 'r1', '--all-reports', '--json');
    let jj = null; try { jj = JSON.parse(allJ.stdout); } catch { jj = null; }
    t('M2 --all-reports --json lists every judged report with its source', allJ.status === 3 && jj && Array.isArray(jj.reports) && jj.reports.length === 4 && jj.reports.some((r) => r.source === 'docs') && jj.reports.some((r) => r.source === 'event'), allJ.stdout.slice(0, 400));
    t('M3 --all-reports together with --report is a usage error (exit 2)', cliAt(LR, '--run', 'r1', '--all-reports', '--report', 'x.md').status === 2);
    const clean = cliAt(LR, '--run', 'r2', '--all-reports');
    t('M4 --all-reports exits 0 when every selected report is clean', clean.status === 0 && /CLAIMS OK/.test(clean.stdout), clean.status + ' ' + clean.stdout + clean.stderr);
    // the checker copied WITHOUT its selection sibling cannot select the reports: code 2, never a silent pass
    const SOLO = path.join(TMP, 'solo');
    fs.mkdirSync(SOLO, { recursive: true });
    fs.copyFileSync(SRC_FILE, path.join(SOLO, 'forge-claim-check.cjs'));
    const S = require(path.join(SOLO, 'forge-claim-check.cjs'));
    const solo = S.checkReports({ root: LR, runId: 'r1' });
    t('M4b without forge-claim-reports.cjs next to it, checkReports refuses to judge (code 2, fail-closed) and check() still works',
      solo.code === 2 && solo.problems.some((p) => /forge-claim-reports\.cjs is missing/.test(p)) && S.reportsForRun === null && S.check(report(BAD_EN), EXC_LEDGER).ok === false, JSON.stringify(solo).slice(0, 300));

    // endreview record: the run report is clean, the docs EINDRAPPORT is not
    const DR = path.join(TMP, 'er-docs');
    withQuestions(DR);
    const dEvents = stamped(EXC_LEDGER, Date.now() - 600e3);
    writeRun('d1', dEvents, report(GOOD_NL) + SR, DR);
    put(DR, 'docs/forge-systeem/EINDRAPPORT-2099-12-31.md', report('## 7. Better or not', BAD_EN));
    const rd = E.recordSelfReview({ root: DR, runId: 'd1', form, log: false });
    t('M5 endreview record REFUSES when a docs EINDRAPPORT changed during the run makes the claim', rd.code === 1 && rd.problems.some((p) => /docs\/forge-systeem\/EINDRAPPORT-2099-12-31\.md line 5/.test(p)), JSON.stringify(rd));
    t('M6 ... and writes nothing', !fs.existsSync(path.join(DR, '.claude', 'forge-runs', 'd1', 'self-review.json')));
    put(DR, 'docs/forge-systeem/EINDRAPPORT-2099-12-31.md', report('## 7. Better or not', GOOD_EN_ALL));
    const rd2 = E.recordSelfReview({ root: DR, runId: 'd1', form, log: false });
    t('M7 ... and records once the docs report names the exceptions', rd2.code === 0, JSON.stringify(rd2));

    // finalize: a run with a clean run report and a dirty docs EINDRAPPORT
    logTo('fin-docs', 'run_started', { note: 's' });
    logTo('fin-docs', 'wp_failed', { wp_id: 'B8-2', reason: 'craft review FAIL' });
    logTo('fin-docs', 'run_completed', { command: 'x', output: 'done', note: 'done' });
    fs.writeFileSync(path.join(finDir('fin-docs'), 'final-report.md'), report(GOOD_EN));
    put(FR, 'docs/forge-systeem/EINDRAPPORT-z.md', report(BAD_EN));
    const fd = F.finalize(FR, 'fin-docs');
    t('M8 finalize() REFUSES when a docs EINDRAPPORT of the run makes the claim (the file is named)', fd.ok === false && Array.isArray(fd.claim_check) && fd.claim_check.length === 1 && /EINDRAPPORT-z\.md/.test(fd.reason), JSON.stringify(fd).slice(0, 400));
    t('M9 ... and writes no receipt', !fs.existsSync(path.join(finDir('fin-docs'), 'run-finalized.json')));
  });

  // ---------------------------------------------------------------- N
  console.log('N. review round 2 + the Lead\'s replay (third round, owner-approved): empty lists, work units, next-sentence failures, quoted literals, sealed drift');
  {
    // (a) an exception list that says there are none is no exception list
    for (const s of ['Every package was verified by Verify Boss (exceptions: none).', 'Elk pakket is geverifieerd door Verify Boss (uitzonderingen: geen).', 'Every package was reviewed by Review Boss, except nothing.', 'Alle pakketten zijn gereviewd, behalve niets.', 'Every package was verified by Verify Boss (exceptions: n/a).', 'Every package was verified by Verify Boss. Exceptions: -.', 'Every package was verified by Verify Boss (exceptions: \u2014).', 'Alle pakketten zijn geverifieerd (uitzonderingen: n.v.t.).', 'Every package was verified by Verify Boss. Exceptions: none.', 'Every package was verified by Verify Boss (exceptions: 0).'])
      t('N1 an empty exception list does not qualify: ' + s, flagged(s), JSON.stringify(C.check(report(s), EXC_LEDGER).claims));
    t('N2 a dash used as a separator before real ids still qualifies ("Exceptions \u2014 B8-2 and B8-3")', okOver('Every package was verified by Verify Boss. Exceptions \u2014 B8-2 and B8-3 were committed after a FAIL.') && okOver('Every package was verified by Verify Boss (exceptions - B8-2, B8-3, B8).'));
    // (b) the work-unit list: all work / al het werk, task, ticket, deliverable, onderdeel, item, step, feature
    for (const s of ['All work was verified by Verify Boss.', 'Al het werk is door Verify Boss geverifieerd.', 'Every task was reviewed by Review Boss.', 'Alle taken zijn gereviewd.', 'Every ticket was verified before its commit.', 'Each deliverable was reviewed by Review Boss.', 'Elk onderdeel is onafhankelijk geverifieerd.', 'Every item was checked by Verify Boss.', 'Every step was verified by Verify Boss.', 'Alle stappen zijn getoetst door Verify Boss.', 'Every feature was reviewed by Review Boss.', 'Elke taak: Verify Boss PASS.', 'All the work was reviewed by Review Boss.'])
      t('N3 work unit flagged: ' + s, flagged(s), JSON.stringify(C.check(report(s), EXC_LEDGER).claims));
    for (const s of ['Log every work event before opening a review.', 'All screenshots were taken and reviewed.', 'Het pakket is al geverifieerd door Verify Boss.', 'Every work log was reviewed for gaps.', 'Alle maatregelen zijn al genomen en gereviewd.'])
      t('N4 no new false positive: ' + s, noClaim(s), JSON.stringify(C.check(report(s), EXC_LEDGER).claims));
    // (d) the exceptions named in the NEXT sentence by wp id + a failure word, without the word "exception"
    const NEXT = 'Every package was verified by Verify Boss and reviewed by Review Boss before its commit. B8-2 failed its craft review and B8-3 was reworked after a FAIL; B8 was not verified on its own.';
    t('N5 a next sentence naming the ledger ids with a failure word qualifies the claim', okOver(NEXT), JSON.stringify(C.check(report(NEXT), EXC_LEDGER)));
    t('N5b ... also in Dutch (afgekeurd / hersteld / niet geverifieerd)', okOver('Elk pakket is geverifieerd door Verify Boss. B8-2 is afgekeurd, B8-3 is hersteld na een FAIL en B8 is niet apart geverifieerd.'));
    t('N6 naming an id WITHOUT a failure word does not qualify', flagged('Every package was verified by Verify Boss. B8-2 took the longest.'));
    t('N6b an id next to "0 FAIL" / "nothing failed" is no failure naming', flagged('Every package was verified by Verify Boss. B8-2 had 0 FAIL.') && flagged('Every package was verified by Verify Boss. B8-2 and B8-3: nothing failed.'));
    writeRun('n7', stamped(EXC_LEDGER, T0), report('Every package was verified by Verify Boss and reviewed by Review Boss before its commit. B8-2 failed its craft review.'), LR);
    const c7n = C.checkReports({ root: LR, runId: 'n7' });
    const f7n = c7n.findings.filter((x) => /n7/.test(x.file));
    t('N7 open run: a next-sentence failure list that leaves out ledger exceptions is incomplete (B8-3, B8 named as missing)', c7n.code === 3 && f7n.length === 1 && /incomplete/.test(f7n[0].reason) && /B8-3/.test(f7n[0].reason) && /B8(?![A-Za-z0-9-])/.test(f7n[0].reason), JSON.stringify({ code: c7n.code, f7n, problems: c7n.problems }));
    writeRun('n8', stamped(EXC_LEDGER, T0), report(NEXT), LR);
    t('N8 open run: the complete next-sentence list passes', C.checkReports({ root: LR, runId: 'n8' }).findings.filter((x) => /n8/.test(x.file)).length === 0, JSON.stringify(C.checkReports({ root: LR, runId: 'n8' }).findings));
    // (e) a quoted exception-list literal in prose is not this paragraph's exception list
    t('N9 a quoted list literal does not qualify the claim', flagged('Every package was verified by Verify Boss. The guard treats "(exceptions: B8-2, B8-3)" as a list.') && flagged('The guard now refuses an empty "(exceptions: none)" literal; every package of this run was verified by Verify Boss.'));
    t('N9b a quoted id + failure word is not a failure naming either', flagged('Every package was verified by Verify Boss. The Lead wrote "B8-2 failed" in the log.'));
    t('N9c the real exception list outside quotes still qualifies when a quoted id sits beside it', okOver('Every package was verified by Verify Boss (exceptions: "B8-2", "B8-3" and B8).'));
    t('N9d a quoted claim after a non-distancing word is still a claim (I-section rule unchanged)', flagged('We can confirm: "every package was verified and reviewed".'));
    // (c) sealed drift: a report edited after run-finalized.json is re-judged with the completeness rule
    const sealedAt = T0 + 30 * 60e3;
    const seal = (id) => fs.writeFileSync(path.join(LR, '.claude', 'forge-runs', id, 'run-finalized.json'), JSON.stringify({ schema: 2, run_id: id, finalized_at: new Date(sealedAt).toISOString() }));
    const touch = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms));
    const sealedEvents = stamped(EXC_LEDGER.concat([{ event_type: 'run_completed' }, { event_type: 'run_finalized' }]), T0);
    const dS = writeRun('sd1', sealedEvents, report(GOOD_EN), LR); seal('sd1'); touch(path.join(dS, 'final-report.md'), sealedAt - 60e3);
    const sd1 = C.sealedDrift({ root: LR, runId: 'sd1' });
    t('N10 a sealed run whose report is older than the seal has no drift (code 0, nothing re-judged)', sd1.code === 0 && sd1.sealed === true && sd1.drifted.length === 0, JSON.stringify(sd1));
    touch(path.join(dS, 'final-report.md'), sealedAt + 120e3);
    const sd1b = C.sealedDrift({ root: LR, runId: 'sd1' });
    t('N11 the same report touched after the seal is re-judged with the completeness rule: code 3, incomplete list (B8 missing)', sd1b.code === 3 && sd1b.drifted.length === 1 && sd1b.findings.length === 1 && /incomplete/.test(sd1b.findings[0].reason) && /B8(?![A-Za-z0-9-])/.test(sd1b.findings[0].reason), JSON.stringify(sd1b));
    const dG = writeRun('sd2', sealedEvents, report(GOOD_EN_ALL), LR); seal('sd2'); touch(path.join(dG, 'final-report.md'), sealedAt + 120e3);
    const sd2 = C.sealedDrift({ root: LR, runId: 'sd2' });
    t('N12 a report edited after the seal that names every exception passes (code 0, 1 drifted, 0 findings)', sd2.code === 0 && sd2.drifted.length === 1 && sd2.findings.length === 0, JSON.stringify(sd2));
    const sd3 = C.sealedDrift({ root: LR, runId: 'r5' });
    t('N13 an unsealed run is no drift case (sealed:false, code 0)', sd3.code === 0 && sd3.sealed === false, JSON.stringify(sd3));
    const dB = writeRun('sd4', sealedEvents, report(GOOD_EN), LR); fs.writeFileSync(path.join(dB, 'run-finalized.json'), '{not json');
    t('N14 an unreadable receipt cannot be judged (code 2)', C.sealedDrift({ root: LR, runId: 'sd4' }).code === 2);
    const all = C.sealedDriftAll({ root: LR });
    t('N15 sealedDriftAll walks every sealed run of the root: sd1 drifted+failed, sd2 drifted+ok, code 3, ok:false, a one-line summary', all.code === 3 && all.ok === false && all.runs.some((r) => r.run_id === 'sd1' && r.code === 3) && all.runs.some((r) => r.run_id === 'sd2' && r.code === 0) && typeof all.summary === 'string' && /sd1/.test(all.summary), JSON.stringify(all).slice(0, 500));
    const cliAt = (root, ...a) => spawnSync(process.execPath, [SRC_FILE, '--root', root, ...a], { encoding: 'utf8', timeout: 30000 });
    const c1 = cliAt(LR, '--sealed-drift', '--run', 'sd1');
    t('N16 CLI --sealed-drift --run exits 3 and names the file and the missing id', c1.status === 3 && /sd1\/final-report\.md/.test(c1.stdout) && /B8(?![A-Za-z0-9-])/.test(c1.stdout), c1.status + ' ' + c1.stdout + c1.stderr);
    t('N17 CLI --sealed-drift --run exits 0 on sd2', cliAt(LR, '--sealed-drift', '--run', 'sd2').status === 0);
    const cAll = cliAt(LR, '--sealed-drift');
    t('N18 CLI --sealed-drift without --run walks every sealed run (exit 3, sd1 named)', cAll.status === 3 && /sd1/.test(cAll.stdout), cAll.status + ' ' + cAll.stdout + cAll.stderr);
    const cJ = cliAt(LR, '--sealed-drift', '--json');
    let jd = null; try { jd = JSON.parse(cJ.stdout); } catch { jd = null; }
    t('N19 CLI --sealed-drift --json', cJ.status === 3 && jd && jd.code === 3 && Array.isArray(jd.runs), cJ.stdout.slice(0, 300));
    t('N20 --sealed-drift with --all-reports or --report is a usage error', cliAt(LR, '--sealed-drift', '--all-reports').status === 2 && cliAt(LR, '--sealed-drift', '--report', 'x.md').status === 2);
  }
  // the git path of sealed drift: a tracked, clean report whose mtime a checkout touched is NOT drift; an edit or a commit after the seal is
  tryRun('N-git', () => {
    const gv = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (gv.status !== 0) { console.log('  note: git is not available here \u2014 the git-path assertions N21-N23 did NOT run'); return; }
    const GR2 = path.join(TMP, 'gitdrift');
    const HOOKS = path.join(TMP, 'no-hooks2');
    fs.mkdirSync(GR2, { recursive: true }); fs.mkdirSync(HOOKS, { recursive: true });
    const git = (args, dateMs) => spawnSync('git', ['-c', 'user.name=forge-test', '-c', 'user.email=forge-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + HOOKS, '-c', 'core.autocrlf=false', ...args],
      { cwd: GR2, encoding: 'utf8', timeout: 30000, windowsHide: true, env: Object.assign({}, process.env, dateMs ? { GIT_AUTHOR_DATE: new Date(dateMs).toISOString(), GIT_COMMITTER_DATE: new Date(dateMs).toISOString() } : {}) });
    if (git(['init', '-q']).status !== 0) { t('N21 git init in the fixture', false); return; }
    const sealedAt = T0 + 30 * 60e3;
    const evs = stamped(EXC_LEDGER.concat([{ event_type: 'run_completed' }, { event_type: 'run_finalized' }]), T0);
    const d = writeRun('g2', evs, report(GOOD_EN), GR2);
    fs.writeFileSync(path.join(d, 'run-finalized.json'), JSON.stringify({ schema: 2, run_id: 'g2', finalized_at: new Date(sealedAt).toISOString() }));
    git(['add', '-A']); git(['commit', '-q', '-m', 'sealed'], sealedAt - 60e3);
    fs.utimesSync(path.join(d, 'final-report.md'), new Date(), new Date()); // a checkout touched the mtime only
    const a = C.sealedDrift({ root: GR2, runId: 'g2' });
    t('N21 git: a tracked, clean report with a fresh mtime is not drift (code 0)', a.code === 0 && a.drifted.length === 0, JSON.stringify(a));
    fs.writeFileSync(path.join(d, 'final-report.md'), report(GOOD_EN) + '\nEdited after the seal.\n');
    const b = C.sealedDrift({ root: GR2, runId: 'g2' });
    t('N22 git: a dirty (edited) report after the seal is drift and is re-judged (code 3, incomplete)', b.code === 3 && b.drifted.length === 1 && /incomplete/.test(b.findings[0].reason), JSON.stringify(b));
    git(['add', '-A']); git(['commit', '-q', '-m', 'edited after seal'], sealedAt + 3600e3);
    fs.utimesSync(path.join(d, 'final-report.md'), new Date(sealedAt - 3600e3), new Date(sealedAt - 3600e3)); // an old mtime cannot hide a commit after the seal
    const c = C.sealedDrift({ root: GR2, runId: 'g2' });
    t('N23 git: a report COMMITTED after the seal is drift even with an old mtime', c.code === 3 && c.drifted.length === 1, JSON.stringify(c));
    // the seal commit: the Lead commits the receipt and the report together seconds AFTER finalize wrote the receipt
    const d3 = writeRun('g3', evs, report(GOOD_EN), GR2);
    fs.writeFileSync(path.join(d3, 'run-finalized.json'), JSON.stringify({ schema: 2, run_id: 'g3', finalized_at: new Date(sealedAt).toISOString() }));
    git(['add', '-A']); git(['commit', '-q', '-m', 'finalize g3 (receipt + report)'], sealedAt + 20e3);
    const s3 = C.sealedDrift({ root: GR2, runId: 'g3' });
    t('N24 git: a report committed only in the SEAL commit (the commit that adds run-finalized.json, 20 s after the seal) is bookkeeping, not drift', s3.code === 0 && s3.drifted.length === 0, JSON.stringify(s3));
    fs.writeFileSync(path.join(d3, 'final-report.md'), report(GOOD_EN) + '\nEdited later.\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'edit g3 after the seal commit'], sealedAt + 7200e3);
    const s3b = C.sealedDrift({ root: GR2, runId: 'g3' });
    t('N25 git: a commit after the seal commit that touches the report is drift (code 3, incomplete)', s3b.code === 3 && s3b.drifted.length === 1, JSON.stringify(s3b));
  });

  // ---------------------------------------------------------------- G
  console.log('G. linear time');
  {
    const big = report('every '.repeat(20000) + 'verified', 'a, '.repeat(30000) + 'all independent', '`'.repeat(5000) + 'x'.repeat(20000), 'alle ' + 'x '.repeat(40000) + 'geverifieerd', 'claimed "every package '.repeat(8000), '!'.repeat(30000) + 'x');
    const t0 = Date.now();
    const r = C.check(big, EXC_LEDGER);
    const ms = Date.now() - t0;
    t('G1 a ~500 KB pathological report is judged in under 3 s (' + ms + ' ms)', ms < 3000 && typeof r.ok === 'boolean');
  }

  // ---------------------------------------------------------------- H
  console.log('H. mutants (each guard removed in memory)');
  {
    const SRCS = { [SRC_FILE]: fs.readFileSync(SRC_FILE, 'utf8'), [REP_FILE]: fs.readFileSync(REP_FILE, 'utf8') };
    const load = (from, to, file) => {
      const SRC = SRCS[file];
      if (!SRC.includes(from)) return null;
      const m = new Module(file, module); m.filename = file; m.paths = module.paths;
      m._compile(SRC.split(from).join(to), file);
      return m.exports;
    };
    const r1 = () => ({ root: LR, runDir: path.join(LR, '.claude', 'forge-runs', 'r1'), events: C.readEvents(path.join(LR, '.claude', 'forge-runs', 'r1', 'events.jsonl')) });
    const mut = [
      ['no ledger exceptions', 'const out = [], seen = new Set();', 'const out = [], seen = new Set(); return out;', (M) => M.check(report(BAD_EN), EXC_LEDGER).ok === true],
      ['qualifier always true', 'function qualifyClaim(c, toks, ctx) {', 'function qualifyClaim(c, toks, ctx) { return \'mutant\';', (M) => M.check(report(BAD_NL), EXC_LEDGER).ok === true],
      ['"no exceptions" counted as a qualifier', "if (k > 0 && (NO_WORDS.has(toks[k - 1].n) || (QUANT.has(toks[k - 1].n) && EXC_NOUN_RE.test(toks[k].n)))) continue;", '', (M) => M.check(report('All packages were independently verified, with no exceptions.'), EXC_LEDGER).ok === true],
      ['negation anywhere in the sentence', 'if (verdicts.length && verdicts.every((v) => negatedAt(toks, v))) return \'negated\';', 'if (toks.some((x) => isNeg(x.n))) return \'negated\';', (M) => M.check(report('Every package was verified by Verify Boss, not by its builder.'), EXC_LEDGER).ok === true],
      ['test-tally guard removed', 'if (isTally(toks, i + qlen, i)) continue;', '', (M) => M.check(report('All tests of the packages passed review.'), EXC_LEDGER).claims.length > 0],
      ['code fences not skipped', 'if (FENCE_RE.test(raw)) { inFence = !inFence; flush(); return; }', '', (M) => M.check('# R\n\n```\n' + BAD_EN + '\n```\n', EXC_LEDGER).ok === false],
      ['wp_failed ignored', "if (e.event_type === 'wp_failed') {", "if (false && e.event_type === 'wp_failed') {", (M) => !M.ledgerExceptions(EXC_LEDGER).some((x) => x.kind === 'wp_failed')],
      ['not-verified rule removed', "if (!ok) add(wp, 'not-verified'", "if (false) add(wp, 'not-verified'", (M) => !M.ledgerExceptions(EXC_LEDGER).some((x) => x.wp_id === 'B8')],
      ['FAIL cleared by any PASS kind', 'else if (PASS_RE.test(verdict) && st[kind])', 'else if (PASS_RE.test(verdict) && (st.verify || st.review)) { for (const k of Object.keys(st)) delete st[k]; } else if (false)', (M) => !M.ledgerExceptions([{ event_type: 'review_completed', wp_id: 'Y', verdict: 'FAIL' }, { event_type: 'wp_completed', wp_id: 'Y' }, { event_type: 'wp_verified', wp_id: 'Y', verdict: 'PASS' }]).some((x) => x.wp_id === 'Y' && x.kind === 'completed-after-fail')],
      ['work-unit noun not required', 'const hasUnit = SELF_UNIT.has(toks[i].n) || unit;', 'const hasUnit = true;', (M) => M.check(report('Every new skill was checked for hidden commands, secret reads and prompt injection.'), EXC_LEDGER).ok === false],
      ['lane counts with a weak check word', 'if ((hasUnit && (strong.length || weak.length)) || (lane && strong.length))', 'if ((hasUnit && (strong.length || weak.length)) || (lane && (strong.length || weak.length)))', (M) => M.check(report('All lanes were checked out from main.'), EXC_LEDGER).claims.length > 0],
      ['quotations never data', 'if (j > 0 && j - i <= MAX_QUOTE && (all || reportedBefore(out))) {', 'if (all) {', (M) => M.check(report('- This very report first claimed "every change was checked independently" — the same overgeneralisation.'), EXC_LEDGER).ok === false],
      ['hedge anywhere in the sentence', 'for (const k of [c.q - 1, c.q - 2]) if (k >= 0 && (HEDGE.has(toks[k].n) || isNeg(toks[k].n))) return \'hedge\';', 'if (toks.some((x) => HEDGE.has(x.n))) return \'hedge\';', (M) => M.check(report('Every package was verified by Verify Boss in almost no time.'), EXC_LEDGER).ok === true],
      ['any exception word in the paragraph qualifies', 'startsWithException(o.xt) || (hasExceptionWord(o.xt) && o.xt.some((x) => exIds.has(x.n))) || namesFailure(o.xt, exIds)', 'hasExceptionWord(o.xt) || o.xt.some((x) => /^exception/.test(x.n))', (M) => M.check(report('Every package was verified by Verify Boss. The exception handler was rewritten.'), EXC_LEDGER).ok === true],
      ['"0 FAIL" read as a negative verdict', 'if (isNegVerdict(toks[k]) && !noBefore(toks, k)) return \'negative-verdict\';', 'if (isNegVerdict(toks[k])) return \'negative-verdict\';', (M) => M.check(report('Every package: verify PASS, review PASS, 0 FAIL.'), EXC_LEDGER).ok === true],
      ['a wp_failed is never cleared', "if (st.failed && e.event_type === 'wp_verified' && PASS_RE.test(verdict)) {", "if (false) {", (M) => M.ledgerExceptions([{ event_type: 'wp_failed', wp_id: 'X' }, { event_type: 'wp_verified', wp_id: 'X', verdict: 'PASS' }]).length > 0],
      ['docs reports not scanned', 'for (const f of docsReports(root, events, notes)) add(f, \'docs\');', '', (M) => !M.reportsForRun(r1()).reports.some((x) => /EINDRAPPORT-x/.test(x.rel)), REP_FILE],
      ['the docs window ignored', 'return cands.filter((f) => inWindow(f));', 'return cands;', (M) => M.reportsForRun(r1()).reports.some((x) => /EINDRAPPORT-old/.test(x.rel)), REP_FILE],
      ["another run's report not left to that run", 'if (otherRun(f)) { notes.push(', 'if (false) { notes.push(', (M) => M.reportsForRun(r1()).reports.some((x) => /forge-runs\/r0\//.test(x.rel)), REP_FILE],
      ['every hyphen part may be a verdict word', 'const anyPart = (n, re) => partsOf(n).some((p) => p && re.test(p));', 'const anyPart = (n, re) => [n.replace(/-/g, \'\')].concat(n.split(\'-\')).some((p) => p && re.test(p));', (M) => M.check(report('raw verify-protect lists 9 changes, all explained by the adoption record;'), EXC_LEDGER).ok === false],
      ['the window crosses table cells', 'if (!sameCell) continue;', '', (M) => M.check(report('| R5 scribe verify |                             | NEEDS FIXES (SV-01..09) | all nine fixed with failing-first tests (seq 172) |'), EXC_LEDGER).ok === false],
      ['a plural unit after a singular determiner counts', 'if (SINGULAR_DET.has(toks[i].n) && isPluralUnit(n) && !ofBefore) continue;', '', (M) => M.check(report('installer starts on a free port, every setting changes behaviour, green doctor, FALLBACK security review without CRITICAL/HIGH, craft-lens review.'), EXC_LEDGER).ok === false],
      ['an open run owns every later docs report', 'return Number.isFinite(since) ? { since, until: sealed ? until : last + OPEN_SLACK_MS } : null;', 'return Number.isFinite(since) ? { since, until: sealed ? until : Infinity } : null;', (M) => M.reportsForRun({ root: LR, runDir: path.join(LR, '.claude', 'forge-runs', 'r4'), events: C.readEvents(path.join(LR, '.claude', 'forge-runs', 'r4', 'events.jsonl')) }).reports.some((x) => /^docs\//.test(x.rel)), REP_FILE],
      ['"all except" not read as an exception', "if (k > 0 && (NO_WORDS.has(toks[k - 1].n) || (QUANT.has(toks[k - 1].n) && EXC_NOUN_RE.test(toks[k].n)))) continue;", "if (k > 0 && (NO_WORDS.has(toks[k - 1].n) || QUANT.has(toks[k - 1].n))) continue;", (M) => M.check(report('Alles behalve B8-2 en B8-3 is geverifieerd door Verify Boss.'), EXC_LEDGER).ok === false],
      ['a modal before the verdict ignored', "if (c.verdicts.length && toks.slice(Math.max(c.lo, c.q - 2), Math.max(...c.verdicts)).some((x) => MODAL.has(x.n))) return 'modal';", '', (M) => M.check(report('Every package will be reviewed by Review Boss before the merge.'), EXC_LEDGER).ok === false],
      ['a verification suite read as a verdict', "if (k + 1 < toks.length && SUITE_RE.test(toks[k + 1].n)) continue; // a \"verification suite\" is a test suite", '', (M) => M.check(report('Fixed every confirmed defect template-first, tested each fix, synced to 8 projects, and re-ran the full verification suite.'), EXC_LEDGER).ok === false],
      ['no sentence end after closing markup', "while (m < t.length && CLOSERS.indexOf(t[m]) >= 0) m++;", "", (M) => M.check(report('**Eindoordeel: PASS CORE / PARTIAL PROOF.** Alles wat je vroeg is gebouwd, getest en gecommit.'), EXC_LEDGER).claims.length > 0],
      ['every blockquote judged as text', 'if (bqData) return;', '', (M) => M.check('# R\n\n## 1. Missie (owner, letterlijk — /goal 2026-09-24)\n> ik wil dat codex alles rechecked en elk pakket geverifieerd wordt\n', EXC_LEDGER).claims.length > 0],
      ['every blockquote treated as data', 'bqData = QUOTE_INTRO_RE.test(lastText);', 'bqData = true;', (M) => M.check('# R\n\n## Status\n> Every package was verified by Verify Boss.\n', EXC_LEDGER).ok === true],
      ['event-named reports ignored', 'for (const f of namedReports(root, dir, events, notes)) add(f, \'event\');', '', (M) => !M.reportsForRun(r1()).reports.some((x) => /audit-report/.test(x.rel)), REP_FILE],
      // third round (owner-approved after two Review Boss FAILs)
      ['an empty exception list counted as a list', 'if (isEmptyList(toks, k)) continue;', '', (M) => M.check(report('Every package was verified by Verify Boss (exceptions: none).'), EXC_LEDGER).ok === true],
      ['a closed dash after the marker not read as empty', "if (toks[k].dash === 'closed') return true;", '', (M) => M.check(report('Every package was verified by Verify Boss (exceptions: -).'), EXC_LEDGER).ok === true],
      ['the new work units removed', 'if (anyPart(n, UNIT2_RE))', 'if (false)', (M) => M.check(report('Every task was reviewed by Review Boss.'), EXC_LEDGER).claims.length === 0],
      ['"work" counts in any position', 'if (WORK_RE.test(n)) return k > 0 && WORK_PREV.has(toks[k - 1].n) && !(k + 1 < toks.length && WORK_COMPOUND.has(toks[k + 1].n));', 'if (WORK_RE.test(n)) return true;', (M) => M.check(report('Log every work event before opening a review.'), EXC_LEDGER).claims.length > 0],
      ['"taken" counts with an English quantifier', "if (n === 'taken') return NL_QUANT.has(toks[qi].n);", "if (n === 'taken') return true;", (M) => M.check(report('All screenshots were taken and reviewed.'), EXC_LEDGER).claims.length > 0],
      ['next-sentence failure naming removed', '|| namesFailure(o.xt, exIds)', '', (M) => M.check(report('Every package was verified by Verify Boss and reviewed by Review Boss before its commit. B8-2 failed its craft review and B8-3 was reworked after a FAIL; B8 was not verified on its own.'), EXC_LEDGER).ok === false],
      ['failure naming without a wp id', 'return id && failure;', 'return failure;', (M) => M.check(report('Every package was verified by Verify Boss. One package failed its first review.'), EXC_LEDGER).ok === true],
      ['"0 FAIL" next to an id read as a failure', 'if ((FAILURE_RE.test(n) && !noBefore(toks, k))', 'if (FAILURE_RE.test(n)', (M) => M.check(report('Every package was verified by Verify Boss. B8-2 had 0 FAIL.'), EXC_LEDGER).ok === true],
      ['a quoted list literal read as a list', 'const xt = tokens(blankQuotes(s.text, true));', 'const xt = tokens(blankQuotes(s.text));', (M) => M.check(report('Every package was verified by Verify Boss. The guard treats "(exceptions: B8-2, B8-3)" as a list.'), EXC_LEDGER).ok === true],
      ['next-sentence failure list not held to completeness', '|| sents.some((o) => namesFailure(o.xt, exIds));', ';', (M) => M.checkReports({ root: LR, runId: 'n7' }).findings.filter((x) => /n7/.test(x.file)).length === 0],
      ['sealed drift: changes after the seal ignored', 'const changed = R.changedAfter(rr.root, sealedAt, sel.reports.map((r) => r.file), notes, { anchor: receipt });', 'const changed = new Set();', (M) => M.sealedDrift({ root: LR, runId: 'sd1' }).code === 0],
      ['sealed drift judged without the completeness rule', 'const j = judge(text, exceptions, { complete: true });', 'const j = judge(text, exceptions, { complete: false });', (M) => M.sealedDrift({ root: LR, runId: 'sd1' }).code === 0],
      ['sealed drift: the seal commit itself read as drift', "const range = sealCommit ? [sealCommit + '..HEAD'] : ['--since=' + iso(sinceMs - 1000)];", "const range = ['--since=' + iso(sinceMs - 1000)];", (M) => { const GR2 = path.join(TMP, 'gitdrift'); if (!fs.existsSync(GR2)) return true; const d = path.join(GR2, '.claude', 'forge-runs', 'g3'); spawnSync('git', ['-c', 'core.hooksPath=' + path.join(TMP, 'no-hooks2'), 'reset', '-q', '--hard', 'HEAD~1'], { cwd: GR2, encoding: 'utf8', timeout: 30000, windowsHide: true }); const r = M.changedAfter(GR2, T0 + 30 * 60e3, [path.join(d, 'final-report.md')], [], { anchor: path.join(d, 'run-finalized.json') }); return r.size > 0; }, REP_FILE],
      ['sealed drift: a tracked clean file with a fresh mtime is drift', '(!g.tracked.has(k) && mtimeAfter(f))', 'mtimeAfter(f)', (M) => { const GR2 = path.join(TMP, 'gitdrift'); if (!fs.existsSync(GR2)) return true; const d = path.join(GR2, '.claude', 'forge-runs', 'g2'); const since = T0 + 30 * 60e3 + 7200e3; fs.utimesSync(path.join(d, 'final-report.md'), new Date(since + 864e5), new Date(since + 864e5)); const r = M.changedAfter(GR2, since, [path.join(d, 'final-report.md')], []); return r.size > 0; }, REP_FILE],
    ];
    for (const [name, from, to, survivesWhen, file] of mut) {
      let M = null, err = null, caught = false;
      try { M = load(from, to, file || SRC_FILE); caught = !!M && survivesWhen(M) === true; } catch (e) { err = e; }
      t('H mutant "' + name + '" applies and is caught by the suite', caught, err ? err.message : (M ? 'mutant behaved like the original' : 'anchor not found'));
    }
  }
} catch (e) {
  fail++;
  console.error('  FAIL suite crashed: ' + ((e && e.stack) || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
