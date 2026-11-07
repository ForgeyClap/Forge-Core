#!/usr/bin/env node
'use strict';
/**
 * forge-review-score.test.cjs —: the review lenses of forge-code-review.
 *   A. proof: a diff with one empty catch -> exactly one finding kept at confidence >= 80 after an independent scoring pass
 *   B. proof: a style-only diff -> no candidate and nothing kept
 *   C. mutation: threshold off (0) -> the "exactly one kept" assertion of A would fail
 *   D. filter rules: independence, missing/invalid scores, self-assigned confidence ignored, orphans, nothing vanishes
 *   E. swallowed-errors pre-scan per language (JS/TS, Python, Go, shell, PowerShell, n8n JSON) + negatives
 *   F. diff mode proposes only constructs that touch an added line
 *   G. behaviour coverage (heuristic): gap, covered by a test in the diff, covered by an existing test under --root
 *   H. CLI: exit codes, --out is the only write, inputs untouched; static: zero dependencies, one write call
 * Hermetic: fixtures live in one temp folder (FORGE_TEST_TMP when set, else the OS temp folder), removed at the end.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const R = require('./forge-review-score.cjs');
const BASE = process.env.FORGE_TEST_TMP && fs.existsSync(process.env.FORGE_TEST_TMP) ? process.env.FORGE_TEST_TMP : os.tmpdir();
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'forge-review-score-')));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true })); // also after a crash mid-run

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const write = (name, text) => { const p = path.join(TMP, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rules = (list) => list.map((f) => f.rule);
const run = (argv) => { let out = '', err = ''; const code = R.main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } }); return { code, out, err }; };

const EMPTY_CATCH_DIFF = [
  'diff --git a/src/orders.js b/src/orders.js', 'index 1111111..2222222 100644', '--- a/src/orders.js', '+++ b/src/orders.js',
  '@@ -10,6 +10,10 @@ function syncOrders(db) {', '   const rows = load(db);', '+  try {', '+    save(rows);', '+  } catch (e) {', '+  }',
  '   return rows;', ' }', ''].join('\n');
const STYLE_DIFF = [
  'diff --git a/src/orders.js b/src/orders.js', '--- a/src/orders.js', '+++ b/src/orders.js', '@@ -1,5 +1,5 @@',
  "-const name = \"orders\"", "+const name = 'orders';", '-function  total(a,b){ return a+b }', '+function total(a, b) { return a + b; }',
  '   // keep the cache warm', '-let   count=0', '+let count = 0;', ''].join('\n');
const STYLE_FINDING = { id: 'style-1', lens: 'style', severity: 'LOW', file: 'src/orders.js', line: 1, title: 'prefer double quotes', confidence: 99 };
const exactlyOneEmptyCatch = (r) => r.kept.length === 1 && r.kept[0].rule === 'js-empty-catch' && r.kept[0].confidence >= 80;

// ---------- A + C ----------
const candA = R.scanDiff(EMPTY_CATCH_DIFF);
t('A1 empty-catch diff -> exactly one swallowed-errors candidate', candA.length === 1 && candA[0].rule === 'js-empty-catch', JSON.stringify(candA));
t('A2 candidate carries file:line and needs confirmation', candA[0] && candA[0].file === 'src/orders.js' && candA[0].line === 13 && candA[0].needs_confirmation === true);
const findingsA = { reviewer: 'review-boss', findings: candA.concat([STYLE_FINDING]) };
const scoresA = { scorer: 'verify-boss', scores: { [candA[0].id]: { confidence: 92, reason: 'save() failure is lost' }, 'style-1': { confidence: 40, reason: 'no project convention' } } };
const rA = R.filterFindings(findingsA, scoresA);
t('A3 after scoring: exactly one finding kept, confidence >= 80', exactlyOneEmptyCatch(rA), JSON.stringify(rA.kept));
t('A4 the low-confidence finding is not silently gone: dropped with a reason', rA.dropped.length === 1 && rA.dropped[0].id === 'style-1' && /below threshold \(40 < 80\)/.test(rA.dropped[0].reason));
t('A5 default threshold is 80', rA.threshold === 80 && R.DEFAULT_THRESHOLD === 80);
const rOff = R.filterFindings(findingsA, scoresA, { threshold: 0 });
t('C1 mutation: threshold off -> the A3 assertion fails (both findings kept)', !exactlyOneEmptyCatch(rOff) && rOff.kept.length === 2);
const rHigh = R.filterFindings(findingsA, scoresA, { threshold: 95 });
t('C2 configurable: threshold 95 keeps none', rHigh.kept.length === 0 && rHigh.dropped.length === 2);

// ---------- B ----------
const candB = R.scanDiff(STYLE_DIFF);
t('B1 style-only diff -> no swallowed-errors candidate', candB.length === 0, JSON.stringify(candB));
const rB = R.filterFindings({ reviewer: 'review-boss', findings: candB.concat([STYLE_FINDING]) }, { scorer: 'verify-boss', scores: { 'style-1': 35 } });
t('B2 style-only review -> nothing kept, the nit is in dropped', rB.kept.length === 0 && rB.dropped.length === 1);

// ---------- D ----------
t('D1 refused: scorer is the reviewer', /independent/.test(R.filterFindings(findingsA, { scorer: 'Review-Boss', scores: {} }).error || ''));
t('D2 refused: no scorer named', /scorer/.test(R.filterFindings(findingsA, { scores: {} }).error || ''));
t('D3 refused: invalid threshold', /threshold/.test(R.filterFindings(findingsA, scoresA, { threshold: 101 }).error || ''));
t('D4 refused: findings without an array / scores not an object', !!R.filterFindings({}, scoresA).error && !!R.filterFindings(findingsA, { scorer: 'x', scores: [] }).error);
const rD = R.filterFindings({ reviewer: 'r', findings: [{ id: 'a', confidence: 100 }, { id: 'b' }, { id: 'c' }, { title: 'no id' }, { id: 'c' }] },
  { scorer: 's', scores: { b: { confidence: 101 }, c: { confidence: 85 }, ghost: 90 } });
const reason = (id) => (rD.dropped.find((d) => d.id === id) || {}).reason || '';
t('D5 a self-assigned confidence never counts: unscored -> dropped "no independent score"', /no independent score/.test(reason('a')));
t('D6 invalid score -> dropped with reason', /invalid score/.test(reason('b')));
t('D7 no id and duplicate id -> dropped with reason', rD.dropped.some((d) => /no id/.test(d.reason)) && rD.dropped.some((d) => /duplicate/.test(d.reason)));
t('D8 nothing vanishes: in === kept + dropped; orphan scores listed', rD.counts.in === rD.counts.kept + rD.counts.dropped && rD.counts.in === 5 && rD.orphan_scores.join() === 'ghost');
t('D9 plain-number score accepted', R.filterFindings({ findings: [{ id: 'x' }] }, { scorer: 's', scores: { x: 80 } }).kept.length === 1);

// ---------- E ----------
const scan = (file, text) => rules(R.scanFile(file, text));
t('E1 JS inline empty catch', scan('a.ts', 'try { x() } catch (e) {}').includes('js-empty-catch-inline'));
t('E2 JS .catch(() => [])', scan('a.js', 'const r = await get().catch(() => []);').includes('js-promise-catch-swallow'));
t('E3 JS .catch(noop)', scan('a.js', 'p.catch(noop);').includes('js-promise-catch-noop'));
t('E4 JS catch returning null without context', scan('a.js', 'try {\n  a();\n} catch (err) {\n  return null;\n}').includes('js-error-to-fallback'));
t('E5 JS re-throw that drops the stack', scan('a.js', 'throw new Error("load failed: " + err.message);').includes('js-rethrow-lost-stack'));
t('E6 JS re-throw with cause is fine', !scan('a.js', 'throw new Error("load failed: " + err.message, { cause: err });').includes('js-rethrow-lost-stack'));
t('E7 JS fetch without timeout flagged; with signal not', scan('a.js', 'const r = await fetch(url);').includes('js-call-no-timeout') &&
  !scan('a.js', 'const r = await fetch(url, { signal: AbortSignal.timeout(5000) });').includes('js-call-no-timeout'));
t('E8 bot webhook: catch answers 200 OK', scan('bot.js', 'app.post("/hook", (req, res) => {\n  try { handle(req); } catch (e) {\n    res.sendStatus(200);\n  }\n});').includes('js-webhook-ack-on-error'));
t('E9 JS catch that logs and rethrows -> nothing', R.scanFile('a.js', 'try {\n  a();\n} catch (err) {\n  log.error(err);\n  throw err;\n}').length === 0);
t('E10 commented-out empty catch -> nothing', R.scanFile('a.js', '// try { x() } catch (e) {}').length === 0);
t('E11 Python except: pass (inline and block)', scan('s.py', 'try:\n    go()\nexcept Exception: pass').includes('py-except-pass-inline') &&
  scan('s.py', 'try:\n    go()\nexcept Exception as e:\n    pass\nprint(1)').includes('py-except-pass'));
t('E12 Python scraper: requests without timeout flagged; with timeout not', scan('s.py', 'r = requests.get(url)').includes('py-request-no-timeout') &&
  !scan('s.py', 'r = requests.get(url, timeout=10)').includes('py-request-no-timeout'));
t('E13 Python retry loop that silently continues', scan('s.py', 'for u in urls:\n    try:\n        fetch(u)\n    except Exception:\n        continue\n').includes('py-except-pass'));
t('E14 Python raise without from', scan('s.py', '    raise ValueError(str(e))').includes('py-raise-lost-chain'));
t('E15 Go: if err != nil { return nil } and discarded error', scan('m.go', 'if err != nil {\n\treturn nil\n}').includes('go-error-to-fallback') &&
  scan('m.go', 'v, _ := strconv.Atoi(s)').includes('go-discarded-error') && scan('m.go', 'resp, err := http.Get(u)').includes('go-default-http-client'));
t('E16 shell: || true and set +e', scan('x.sh', 'rm_old_logs || true').includes('sh-or-true') && scan('x.sh', 'set +e').includes('sh-errexit-off'));
t('E17 PowerShell: SilentlyContinue and multi-line empty catch', scan('x.ps1', 'Remove-Item $p -ErrorAction SilentlyContinue').includes('ps-silent-error-action') &&
  scan('x.ps1', 'try {\n  Get-Thing\n} catch {\n  # ignore\n}').includes('ps-empty-catch'));
t('E18 n8n: continueOnFail and a workflow without errorWorkflow', scan('wf.json', '{"nodes": [{"name": "HTTP", "continueOnFail": true}], "connections": {}, "settings": {}}').join() === 'n8n-continue-on-fail,n8n-no-error-workflow');
t('E19 n8n workflow with an errorWorkflow -> no workflow-level finding', !scan('wf.json', '{"nodes": [], "connections": {}, "settings": {"errorWorkflow": "12"}}').includes('n8n-no-error-workflow'));
t('E20 transaction without rollback', scan('db.js', 'await db.beginTransaction();\nawait db.query(q);\nawait db.commit();').includes('tx-no-rollback') &&
  !scan('db.js', 'await db.beginTransaction();\ntry { await db.commit(); } catch (e) { await db.rollback(); throw e; }').includes('tx-no-rollback'));
t('E22 JS inline catch that returns null', scan('a.js', 'const read = (p) => { try { return load(p); } catch (e) { return null; } };').includes('js-error-to-fallback-inline'));
t('E21 unknown file type -> nothing', R.scanFile('notes.md', 'catch (e) {}').length === 0);

// ---------- F ----------
const CONTEXT_ONLY = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,4 +1,5 @@', ' try {', '   a();', ' } catch (e) {', ' }', '+const x = 1;', ''].join('\n');
t('F1 diff mode: an unchanged empty catch in context is not proposed', R.scanDiff(CONTEXT_ONLY).length === 0);
const DELETED = ['diff --git a/old.js b/old.js', '--- a/old.js', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-try { a() } catch (e) {}', ''].join('\n');
t('F2 diff mode: a deleted file proposes nothing', R.scanDiff(DELETED).length === 0);
const NEW_WF = ['diff --git a/wf.json b/wf.json', 'new file mode 100644', '--- /dev/null', '+++ b/wf.json', '@@ -0,0 +1,1 @@', '+{"nodes": [], "connections": {}}', ''].join('\n');
t('F3 diff mode: a NEW n8n workflow gets the whole-file check', rules(R.scanDiff(NEW_WF)).includes('n8n-no-error-workflow'));

// ---------- G ----------
const AUTH_DIFF = ['diff --git a/src/auth.js b/src/auth.js', '--- a/src/auth.js', '+++ b/src/auth.js', '@@ -1,3 +1,4 @@',
  ' function verifyToken(token) {', '+  if (!token) return false;', '   return check(token);', ' }', ''].join('\n');
const covGap = R.coverage(AUTH_DIFF, null);
const gap = covGap.findings[0];
t('G1 untested change in auth code -> one HIGH behaviour-coverage gap, labelled heuristic', covGap.heuristic === true && covGap.findings.length === 1 &&
  gap.lens === 'behaviour-coverage' && gap.severity === 'HIGH' && /verifyToken/.test(gap.title) && /heuristic/.test(gap.title), JSON.stringify(covGap));
t('G2 without --root the report says existing tests were not searched', covGap.notes.some((n) => /NOT searched/.test(n)));
const WITH_TEST = AUTH_DIFF + ['diff --git a/tests/auth.test.js b/tests/auth.test.js', '--- a/tests/auth.test.js', '+++ b/tests/auth.test.js', '@@ -1,1 +1,2 @@',
  " const { verifyToken } = require('../src/auth');", "+assert.strictEqual(verifyToken(''), false);", ''].join('\n');
const covDiff = R.coverage(WITH_TEST, null);
t('G3 a changed test that mentions the function -> covered by diff-test, no gap', covDiff.findings.length === 0 && covDiff.changed_files.length === 1 &&
  covDiff.changed_files[0].functions[0].covered === 'diff-test');
const repo = path.join(TMP, 'repo');
write('repo/test/auth.spec.js', "it('rejects', () => verifyToken(''));\n");
write('repo/node_modules/x/other.test.js', 'verifyToken\n');
const covRoot = R.coverage(AUTH_DIFF, repo);
t('G4 an existing test under --root -> covered by existing-test (node_modules skipped)', covRoot.findings.length === 0 &&
  covRoot.changed_files[0].functions[0].covered === 'existing-test' && covRoot.changed_files[0].functions[0].tests.join() === 'test/auth.spec.js', JSON.stringify(covRoot.changed_files));
const HELPER_DIFF = ['diff --git a/src/format.js b/src/format.js', '--- a/src/format.js', '+++ b/src/format.js', '@@ -1,2 +1,3 @@',
  ' function padLeft(s) {', '+  s = String(s);', '   return s;', ' }', ''].join('\n');
write('repo2/test/format.test.js', "const F = require('../src/format');\n");
const covInd = R.coverage(HELPER_DIFF, path.join(TMP, 'repo2'));
t('G4a a low-criticality helper whose FILE is tested -> indirect, no gap', covInd.findings.length === 0 && covInd.changed_files[0].functions[0].covered === 'file-test-indirect', JSON.stringify(covInd.changed_files));
write('repo2/test/auth.test.js', "require('../src/auth');\n");
const covIndHigh = R.coverage(AUTH_DIFF, path.join(TMP, 'repo2'));
t('G4c a HIGH-criticality change tested only indirectly -> one MEDIUM finding', covIndHigh.findings.length === 1 && covIndHigh.findings[0].rule === 'cov-indirect-only' && covIndHigh.findings[0].severity === 'MEDIUM');
write('repo/tests/huge.test.js', 'x'.repeat(1024 * 1024 + 10));
const covSkip = R.coverage(AUTH_DIFF, repo);
t('G4b a test file it could not read is named in the notes, not silently skipped', covSkip.notes.some((n) => /not searched: tests\/huge\.test\.js \(larger than/.test(n)), JSON.stringify(covSkip.notes));
t('G5 criticality heuristic: payment high, parser medium, helper low', R.criticality('src/payment.js') === 'high' && R.criticality('lib/parse.js') === 'medium' && R.criticality('util/format.js') === 'low');
t('G6 test-path detection across languages', ['a.test.ts', 'x/__tests__/a.js', 'pkg/a_test.go', 'tests/test_a.py', 'A.Tests.ps1'].every(R.isTestPath) && !R.isTestPath('src/a.js'));

// ---------- H ----------
const diffP = write('in/a.diff', EMPTY_CATCH_DIFF);
const before = sha(diffP);
const outDir = path.join(TMP, 'out'); fs.mkdirSync(outDir);
const s1 = run(['scan', '--diff', diffP, '--out', path.join(outDir, 'cand.json')]);
const cand = JSON.parse(fs.readFileSync(path.join(outDir, 'cand.json'), 'utf8'));
t('H1 scan --out exit 0, writes only that file, input untouched', s1.code === 0 && fs.readdirSync(outDir).join() === 'cand.json' && sha(diffP) === before && cand.findings.length === 1);
const scoresP = write('in/scores.json', JSON.stringify({ scorer: 'verify-boss', scores: { [cand.findings[0].id]: { confidence: 90 } } }));
const s2 = run(['filter', '--findings', path.join(outDir, 'cand.json'), '--scores', scoresP, '--out', path.join(outDir, 'scored.json')]);
const scored = JSON.parse(fs.readFileSync(path.join(outDir, 'scored.json'), 'utf8'));
t('H2 scan output feeds filter directly: exit 0, one kept', s2.code === 0 && scored.kept.length === 1 && fs.readdirSync(outDir).sort().join() === 'cand.json,scored.json');
const s3 = run(['filter', '--findings', path.join(outDir, 'cand.json'), '--scores', scoresP, '--format', 'md']);
t('H3 --format md prints a table to stdout', s3.code === 0 && /\| Severity \| Confidence \|/.test(s3.out) && /\| HIGH \| 90 \|/.test(s3.out));
t('H4 usage errors exit 2', run([]).code === 2 && run(['scan']).code === 2 && run(['filter', '--findings', 'x']).code === 2 && run(['coverage']).code === 2);
const s5 = run(['scan', '--diff', diffP, '--out', path.join(TMP, 'no-such-dir', 'x.json')]);
t('H5 --out into a missing folder -> exit 1, nothing created', s5.code === 1 && !fs.existsSync(path.join(TMP, 'no-such-dir')));
t('H6 missing input file -> exit 1; same-scorer refusal -> exit 1', run(['scan', '--diff', path.join(TMP, 'absent.diff')]).code === 1 &&
  run(['filter', '--findings', path.join(outDir, 'cand.json'), '--scores', write('in/self.json', JSON.stringify({ scorer: 'forge-review-score pre-scan', scores: {} }))]).code === 1);
const src = fs.readFileSync(path.join(__dirname, 'forge-review-score.cjs'), 'utf8');
const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
t('H7 zero dependencies: only fs, path, crypto', requires.join() === 'crypto,fs,path', requires.join());
t('H8 exactly one write call in the source (the --out path)', (src.match(/\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|renameSync|unlinkSync|rmSync)\b/g) || []).length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed'); // the doctor only reads a tally whose digits start the line
process.exitCode = fail ? 1 : 0;
