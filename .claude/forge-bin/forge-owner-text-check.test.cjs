#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-owner-text-check.test.cjs — SD-T8 (default skills, Task 8): owner-facing text is checked for the owner's
 * language and for AI tells. Hermetic: every fixture lives in one os.mkdtemp folder (removed at the end); the owner
 * profile, the scribe ledger and the run folders are temp files. Nothing is logged, nothing in the real project is read.
 *   A. languageOf: Dutch, English, too short, code is ignored
 *   B. expectedLanguage + languageCheck: match-owner follows the owner's own words; a fixed pref wins; no basis = no judgement
 *   C. aiTells: the phrase list, the em-dash density boundary, code blocks do not count
 *   D. ownerTextOf: the newest scribe record of the run, set-aside records skipped, fallback to the newest record
 *   E. checkReport on a temp run: warnings for language and tells; no profile = language not judged
 *   F. replay CLI: counts only, never report text
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-text-')));
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_OWNER_PROFILE']) delete process.env[k];

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };

let M = null;
try { M = require('./forge-owner-text-check.cjs'); } catch (e) { M = null; t('forge-owner-text-check.cjs loads', false, e.message); }

const MATCH = 'match-owner (nl when owner writes Dutch)';
const NL_OWNER = 'Ik wil dat je de rest van de taken nu ook afmaakt en dat het niet meer kapot gaat, kan dat?';
const NL_REPORT = 'Dit is het eindrapport. De wijziging is klaar en de tests zijn groen. Er is nog een open punt: de doctor moet de check ook kennen, maar dat doet de integrator bij de merge. Wat nog zwak is: de lijst met woorden is klein.';
const EN_REPORT = 'This is the final report. The change is done and the tests are green. There is one open item: the doctor has to know the check too, but the integrator does that at merge time. What is still weak: the word list is small.';
const words = (n) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
let rootN = 0;
const PROFILE = (ui) => JSON.stringify({ version: 1, prefs: { language: { value: { ui, code_docs: 'en' }, source: 'test fixture', confidence: 'evidenced', scope: 'global' } } });
/** mkRoot({ui, ledger}) -> a temp project root with an optional owner profile and scribe ledger lines. */
function mkRoot(opts) {
  opts = opts || {};
  const root = mk(TMP, 'p' + (++rootN));
  mk(root, '.claude');
  if (opts.ui) fs.writeFileSync(path.join(root, '.claude', 'FORGE_OWNER_PROFILE.json'), PROFILE(opts.ui));
  if (opts.ledger) fs.writeFileSync(path.join(mk(root, '.claude', 'forge-scribe'), 'ledger.jsonl'), opts.ledger.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return root;
}
const writeReport = (root, id, text) => { const d = mk(root, '.claude', 'forge-runs', id); fs.writeFileSync(path.join(d, 'final-report.md'), text); return d; };
const NO_GLOBAL = path.join(TMP, 'no-global-profile.json');

console.log('forge-owner-text-check tests (SD-T8; hermetic root=' + TMP + ')');

try {
  if (M) {
    console.log('\nA) languageOf');
    t('a Dutch text is nl', M.languageOf(NL_REPORT) === 'nl', M.languageOf(NL_REPORT));
    t('an English text is en', M.languageOf(EN_REPORT) === 'en', M.languageOf(EN_REPORT));
    t('too few stop words is unknown', M.languageOf('PASS CORE q1 q12') === 'unknown');
    t('a non-string is unknown (total, never throws)', M.languageOf(null) === 'unknown' && M.languageOf(42) === 'unknown');
    t('English inside a code block does not count', M.languageOf(NL_REPORT + '\n```\n' + EN_REPORT + '\n' + EN_REPORT + '\n```\n') === 'nl');

    console.log('\nB) expectedLanguage + languageCheck');
    t('match-owner + Dutch owner words -> nl', M.expectedLanguage(MATCH, NL_OWNER) === 'nl');
    t('match-owner without owner words -> null (no judgement)', M.expectedLanguage(MATCH, null) === null);
    t('a fixed "en" pref wins over the owner words', M.expectedLanguage('en', NL_OWNER) === 'en');
    t('no pref -> null', M.expectedLanguage(null, NL_OWNER) === null);
    const bad = M.languageCheck(EN_REPORT, MATCH, NL_OWNER);
    t('an English report while the owner wrote Dutch -> not ok, the why names both languages', bad.ok === false && /\ben\b/.test(bad.why) && /\bnl\b/.test(bad.why), JSON.stringify(bad));
    const good = M.languageCheck(NL_REPORT, MATCH, NL_OWNER);
    t('a Dutch report -> ok', good.ok === true, JSON.stringify(good));
    t('no basis for an expectation -> ok, the why says it was not judged', M.languageCheck(EN_REPORT, MATCH, null).ok === true && /not judged/.test(M.languageCheck(EN_REPORT, MATCH, null).why));
    t('a report of unknown language -> ok (never a guess)', M.languageCheck('PASS q1', MATCH, NL_OWNER).ok === true);

    console.log('\nC) aiTells');
    const hundred = 'We delve into it ' + '— a ' + '— b ' + '— c ' + words(90);
    const tells = M.aiTells(hundred);
    t('"delve" and 3 em dashes in 100 words -> 2 tells', tells.length === 2 && tells.some((x) => x.tell === 'delve' && x.count === 1) && tells.some((x) => /em-dash/.test(x.tell) && x.count === 3), JSON.stringify(tells));
    t('a clean text -> no tells', M.aiTells(EN_REPORT).length === 0, JSON.stringify(M.aiTells(EN_REPORT)));
    t('1 em dash in 120 words is at the limit -> no tell', M.aiTells(words(119) + ' — end').length === 0, JSON.stringify(M.aiTells(words(119) + ' — end')));
    t('2 em dashes in 120 words -> the density tell', M.aiTells(words(118) + ' — a — b').some((x) => /em-dash/.test(x.tell)));
    const phrases = M.aiTells("Certainly! It's worth noting this tapestry. As an AI I hope this helps. " + words(200));
    t('the phrase list: Certainly!, it\'s worth noting, tapestry, As an AI, I hope this helps', ['Certainly!', "it's worth noting", 'tapestry', 'As an AI', 'I hope this helps'].every((p) => phrases.some((x) => x.tell === p)), JSON.stringify(phrases));
    t('a tell inside a code block does not count', M.aiTells('```\ndelve tapestry\n```\n' + words(50)).length === 0);
    t('a curly apostrophe still matches it’s worth noting', M.aiTells('It’s worth noting ' + words(50)).some((x) => x.tell === "it's worth noting"));
    t('a non-string -> [] (total)', Array.isArray(M.aiTells(undefined)) && M.aiTells(undefined).length === 0);

    console.log('\nD) ownerTextOf');
    const ledger = [
      { seq: 1, op: 'open', rid: 'R-0001', quote: 'an older english prompt for the run', run_id: 'r-1' },
      { seq: 2, op: 'open', rid: 'R-0002', quote: NL_OWNER, run_id: 'r-1' },
      { seq: 3, op: 'open', rid: 'R-0003', quote: 'agent text that was set aside', run_id: 'r-1' },
      { seq: 4, op: 'supersede', rid: 'R-0003', by: 'scribe', ignored: 'system-origin' },
      { seq: 5, op: 'open', rid: 'R-0004', quote: 'the newest prompt, no run', run_id: undefined },
    ];
    const rootD = mkRoot({ ledger });
    const o1 = M.ownerTextOf(rootD, 'r-1');
    t('the newest open record of the run, a set-aside one skipped', o1.text === NL_OWNER && o1.source === 'scribe:run', JSON.stringify(o1));
    const o2 = M.ownerTextOf(rootD, 'r-none');
    // FB-FINALIZE-1-F11: the newest record is too short to tell its language, so the majority language of the owner's
    // records decides (its newest record), instead of leaving the report not judged
    t('no record of the run + newest owner record of unknown language -> the newest record of the majority language', o2.text === NL_OWNER && o2.source === 'scribe:majority', JSON.stringify(o2));
    const rootD2 = mkRoot({ ledger: [
      { seq: 1, op: 'open', rid: 'R-0001', quote: NL_OWNER, run_id: 'r-2' },
      { seq: 2, op: 'open', rid: 'R-0002', quote: 'ok ga door', run_id: 'r-2' },
      { seq: 3, op: 'open', rid: 'R-0003', quote: 'short one', run_id: 'r-3' },
    ] });
    const o2b = M.ownerTextOf(rootD2, 'r-2');
    t('the run\'s newest record is unknown -> the run\'s majority language decides', o2b.text === NL_OWNER && o2b.source === 'scribe:run-majority', JSON.stringify(o2b));
    const o2c = M.ownerTextOf(rootD2, 'r-3');
    t('the run has only unknown records -> the majority of all owner records', o2c.text === NL_OWNER && o2c.source === 'scribe:majority', JSON.stringify(o2c));
    const o2d = M.ownerTextOf(mkRoot({ ledger: [{ seq: 1, op: 'open', rid: 'R-0001', quote: 'go on', run_id: 'r-4' }] }), 'r-4');
    t('no record of a known language at all -> the newest record of the run, as before', o2d.text === 'go on' && o2d.source === 'scribe:run', JSON.stringify(o2d));
    const o3 = M.ownerTextOf(mkRoot(), 'r-1');
    t('no ledger -> text null (never throws)', o3.text === null);

    console.log('\nE) checkReport');
    const rootE = mkRoot({ ui: MATCH, ledger: [{ seq: 1, op: 'open', rid: 'R-0001', quote: NL_OWNER, run_id: 'e-1' }] });
    const dirE = writeReport(rootE, 'e-1', '# Final report\n\n' + EN_REPORT + ' We delve into it. ' + EN_REPORT + '\n');
    const rE = M.checkReport({ root: rootE, runId: 'e-1', runDir: dirE, globalProfilePath: NO_GLOBAL });
    t('an English report for a Dutch owner with "delve" -> a language warning and a tell warning', rE.warnings.length === 2 && rE.warnings.some((w) => /language/.test(w)) && rE.warnings.some((w) => /delve/.test(w)), JSON.stringify(rE));
    t('the result names the expected and the actual language', rE.language && rE.language.expected === 'nl' && rE.language.actual === 'en');
    const dirE2 = writeReport(rootE, 'e-2', '# Eindrapport\n\n' + NL_REPORT + '\n');
    fs.appendFileSync(path.join(rootE, '.claude', 'forge-scribe', 'ledger.jsonl'), JSON.stringify({ seq: 2, op: 'open', rid: 'R-0002', quote: NL_OWNER, run_id: 'e-2' }) + '\n');
    t('a Dutch report without tells -> no warnings', M.checkReport({ root: rootE, runId: 'e-2', runDir: dirE2, globalProfilePath: NO_GLOBAL }).warnings.length === 0);
    const rootE3 = mkRoot({ ledger: [{ seq: 1, op: 'open', rid: 'R-0001', quote: NL_OWNER, run_id: 'e-3' }] });
    const dirE3 = writeReport(rootE3, 'e-3', EN_REPORT);
    const rE3 = M.checkReport({ root: rootE3, runId: 'e-3', runDir: dirE3, globalProfilePath: NO_GLOBAL });
    t('no owner profile -> the language is not judged (no warning)', rE3.warnings.length === 0 && rE3.language.expected === null, JSON.stringify(rE3));
    const rE4 = M.checkReport({ root: rootE3, runId: 'e-none', runDir: path.join(rootE3, '.claude', 'forge-runs', 'e-none'), globalProfilePath: NO_GLOBAL });
    t('no final-report.md -> nothing to judge, no warnings', rE4.warnings.length === 0 && rE4.judged === false);
    const rootE5 = mkRoot();
    fs.writeFileSync(path.join(rootE5, '.claude', 'FORGE_OWNER_PROFILE.json'), '{ not json');
    const dirE5 = writeReport(rootE5, 'e-5', EN_REPORT);
    const rE5 = M.checkReport({ root: rootE5, runId: 'e-5', runDir: dirE5, globalProfilePath: NO_GLOBAL });
    t('a broken owner profile -> one warning that says so, never a throw', rE5.warnings.length === 1 && /owner profile/.test(rE5.warnings[0]), JSON.stringify(rE5));

    console.log('\nF) replay CLI (counts only)');
    const rootF = mkRoot({ ui: MATCH, ledger: [{ seq: 1, op: 'open', rid: 'R-0001', quote: NL_OWNER, run_id: 'f-1' }] });
    writeReport(rootF, 'f-1', EN_REPORT + ' UNIQUE-SENTINEL-TEXT');
    writeReport(rootF, 'f-2', NL_REPORT);
    mk(rootF, '.claude', 'forge-runs', 'f-3');
    const o = [], e = [];
    const code = M.main(['replay', '--root', rootF, '--json'], { out: (s) => o.push(s), err: (s) => e.push(s), globalProfilePath: NO_GLOBAL });
    let rep = null;
    try { rep = JSON.parse(o.join('\n')); } catch { rep = null; }
    t('replay exits 0 and counts reports, warned reports and language warnings', code === 0 && rep && rep.reports === 2 && rep.with_warning === 1 && rep.language_warning === 1, o.join('\n') + e.join('\n'));
    t('replay never prints report text', !o.concat(e).join('\n').includes('UNIQUE-SENTINEL-TEXT') && !o.concat(e).join('\n').includes('The change is done'));
    const o2t = [];
    t('replay without --json prints a counts line', M.main(['replay', '--root', rootF], { out: (s) => o2t.push(s), err: () => {}, globalProfilePath: NO_GLOBAL }) === 0 && /2 report/.test(o2t.join('\n')), o2t.join('\n'));
    t('an unknown command is a usage error (exit 2)', M.main(['nope'], { out: () => {}, err: () => {} }) === 2);
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { console.error('  note: could not remove ' + TMP + ' (' + err.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
