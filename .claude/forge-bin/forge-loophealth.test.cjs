#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-loophealth.cjs. Uses os.mkdtemp fixtures with crafted
 *  .claude/forge-runs/_toollog/*.jsonl + run.json files and an injected opts.now so nothing depends
 *  on real wall-clock timing. CLI smoke tests spawn the real file as a child process. Never touches the
 *  real project's .claude/forge-runs/.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const L = require('./forge-loophealth.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-loophealth offline tests');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loophealth-test-'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', '_toollog'), { recursive: true });
  return root;
}
function toollogDir(root) { return path.join(root, '.claude', 'forge-runs', '_toollog'); }
function writeSessionLog(root, sessionId, lines, gen) {
  const name = gen ? sessionId + '.' + gen + '.jsonl' : sessionId + '.jsonl';
  fs.writeFileSync(path.join(toollogDir(root), name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}
function writeRunJson(root, runId, data) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(data), 'utf8');
}
const line = (o) => Object.assign({ ts: '2026-10-01T10:00:00.000Z', session: 's1', tool: 'Write', target: 'src/app.js', ok: true }, o);

// ---- 1. threshold boundary: 5 edits flagged, 4 edits not --------------------------------------------
(() => {
  const root = mkProject();
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/a.js', run: 'r1' }));
  for (let i = 0; i < 4; i++) lines.push(line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/b.js', run: 'r1' }));
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r1' });
  t('run-field basis selected when lines carry run field', r.basis === 'run-field');
  t('5-edit target is flagged', r.flagged.some((f) => f.target === 'src/a.js' && f.count === 5));
  t('4-edit target is NOT flagged', !r.flagged.some((f) => f.target === 'src/b.js'));
  t('flagged sorted by count descending', r.flagged[0].target === 'src/a.js');
})();

// ---- 2. reads/Bash/other tools ignored ---------------------------------------------------------------
(() => {
  const root = mkProject();
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/c.js', tool: 'Read', run: 'r2' }));
  lines.push(line({ target: 'ls', tool: 'Bash', run: 'r2' }));
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-10-01T11:0' + i + ':00.000Z', target: 'src/d.js', tool: 'Write', run: 'r2' }));
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r2' });
  t('Read calls never counted as edits', !r.flagged.some((f) => f.target === 'src/c.js'));
  t('Bash calls never counted as edits', r.edits_counted === 5);
  t('real Write edits still flagged', r.flagged.some((f) => f.target === 'src/d.js' && f.count === 5));
})();

// ---- 3. MultiEdit and NotebookEdit count ---------------------------------------------------------------
(() => {
  const root = mkProject();
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/e.ipynb', tool: 'NotebookEdit', run: 'r3' }));
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-10-01T11:0' + i + ':00.000Z', target: 'src/f.js', tool: 'MultiEdit', run: 'r3' }));
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r3' });
  t('NotebookEdit counted and flagged', r.flagged.some((f) => f.target === 'src/e.ipynb' && f.count === 5));
  t('MultiEdit counted and flagged', r.flagged.some((f) => f.target === 'src/f.js' && f.count === 5));
})();

// ---- 4. failed edits count; ok_count correct -----------------------------------------------------------
(() => {
  const root = mkProject();
  const lines = [];
  for (let i = 0; i < 3; i++) lines.push(line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/g.js', ok: false, run: 'r4' }));
  for (let i = 0; i < 2; i++) lines.push(line({ ts: '2026-10-01T10:1' + i + ':00.000Z', target: 'src/g.js', ok: true, run: 'r4' }));
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r4' });
  const g = r.flagged.find((f) => f.target === 'src/g.js');
  t('failing edit attempts are still counted', !!g && g.count === 5);
  t('ok_count only counts the successes', !!g && g.ok_count === 2);
})();

// ---- 5. run-field lines take precedence over the time window -------------------------------------------
(() => {
  const root = mkProject();
  writeRunJson(root, 'r5', { started_at: '2026-01-01T00:00:00.000Z', finalized_at: '2026-01-02T00:00:00.000Z' });
  const lines = [];
  // 5 edits carry run:'r5' but have timestamps OUTSIDE the run.json window
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2027-05-0' + (i + 1) + 'T00:00:00.000Z', target: 'src/h.js', run: 'r5' }));
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r5' });
  t('run-field basis wins even though a time window exists', r.basis === 'run-field');
  t('run-field lines outside the window are still counted', r.flagged.some((f) => f.target === 'src/h.js' && f.count === 5));
})();

// ---- 5b. Codex W2-09: ownership per record — one tagged line never hides untagged edits in the window ------
(() => {
  const root = mkProject();
  writeRunJson(root, 'r5b', { started_at: '2026-01-01T00:00:00.000Z', finalized_at: '2026-01-01T01:00:00.000Z' });
  const lines = [line({ ts: '2026-01-01T00:05:00.000Z', target: 'src/x.js', tool: 'Read', run: 'r5b' })];
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-01-01T00:1' + i + ':00.000Z', target: 'src/k.js' })); // untagged, inside window
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r5b' });
  t('W2-09: untagged edits in the window still count when another line is tagged', r.flagged.some((f) => f.target === 'src/k.js' && f.count === 5));
  t('W2-09: a selection with tagged and window lines reports basis mixed', r.basis === 'mixed');
})();
(() => {
  const root = mkProject();
  writeRunJson(root, 'r5c', { started_at: '2026-01-01T00:00:00.000Z', finalized_at: '2026-01-01T01:00:00.000Z' });
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-01-01T00:1' + i + ':00.000Z', target: 'src/foreign.js', run: 'other-run' })); // another run, inside window
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r5c' });
  t('W2-09: edits tagged for another run are never attributed through the time window', !r.flagged.some((f) => f.target === 'src/foreign.js') && r.edits_counted === 0);
})();
// ---- 5d. Codex W2-10: internal dot segments and doubled slashes do not split one file ----------------------
(() => {
  const root = mkProject();
  writeSessionLog(root, 's1', [
    line({ target: 'src/a.js', run: 'dots' }), line({ target: 'src/a.js', run: 'dots' }), line({ target: 'src/a.js', run: 'dots' }),
    line({ target: 'src/../src/a.js', run: 'dots' }), line({ target: 'src//./a.js', run: 'dots' }),
  ]);
  const r = L.analyze({ root, runId: 'dots' });
  t('W2-10: dot segments and doubled slashes fold into one target', r.flagged.length === 1 && r.flagged[0].target === 'src/a.js' && r.flagged[0].count === 5);
})();

// ---- 5e. -10: a path that leaves and re-enters the root is the same file ---------------
(() => {
  const root = mkProject();
  const back = '../' + path.basename(root) + '/src/a.js';
  writeSessionLog(root, 's1', [
    line({ target: 'src/a.js', run: 're' }), line({ target: 'src/a.js', run: 're' }), line({ target: 'src/a.js', run: 're' }),
    line({ target: back, run: 're' }), line({ target: back, run: 're' }),
  ]);
  const r = L.analyze({ root, runId: 're' });
  t('W2-10v: a path leaving and re-entering the root folds into the same target', r.flagged.length === 1 && r.flagged[0].target === 'src/a.js' && r.flagged[0].count === 5);
})();
// ---- 5f. -N02: a UNC path and a drive-rooted path stay different files (Windows) -------
if (process.platform === 'win32') {
  const root = mkProject();
  writeSessionLog(root, 's1', [
    ...Array.from({ length: 3 }, () => line({ target: '\\\\server\\share\\a.js', run: 'unc' })),
    ...Array.from({ length: 2 }, () => line({ target: '/server/share/a.js', run: 'unc' })),
  ]);
  const r = L.analyze({ root, runId: 'unc' });
  t('W2-N02: a UNC path and a drive-rooted path are not conflated', r.flagged.length === 0);
}

// ---- 5g. Verify Boss residual: Windows long-path spellings fold into their normal form -----------
if (process.platform === 'win32') {
  const root = mkProject();
  writeSessionLog(root, 's1', [
    ...Array.from({ length: 3 }, () => line({ target: 'src/a.js', run: 'lp' })),
    ...Array.from({ length: 2 }, () => line({ target: '\\\\?\\' + path.join(root, 'src', 'a.js'), run: 'lp' })),
    ...Array.from({ length: 3 }, () => line({ target: '\\\\server\\share\\b.js', run: 'lp' })),
    ...Array.from({ length: 2 }, () => line({ target: '\\\\?\\UNC\\server\\share\\b.js', run: 'lp' })),
  ]);
  const r = L.analyze({ root, runId: 'lp' });
  const a = r.flagged.find((f) => f.target === 'src/a.js');
  const b = r.flagged.find((f) => /\/\/server\/share\/b\.js$/i.test(f.target));
  t('long-path: \\\\?\\C:\\... folds into the same in-project target', !!a && a.count === 5);
  t('long-path: \\\\?\\UNC\\server\\share\\... folds into \\\\server\\share\\...', !!b && b.count === 5);
}

// ---- 6. time-window fallback (no run field on any line) ------------------------------------------------
(() => {
  const root = mkProject();
  writeRunJson(root, 'r6', { started_at: '2026-01-01T00:00:00.000Z', finalized_at: '2026-01-01T01:00:00.000Z' });
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-01-01T00:1' + i + ':00.000Z', target: 'src/i.js' })); // inside window, no run field
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-02-01T00:1' + i + ':00.000Z', target: 'src/j.js' })); // outside window
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r6' });
  t('time-window basis selected when no line carries the run field', r.basis === 'time-window');
  t('window.from/to reported', r.window && r.window.from === '2026-01-01T00:00:00.000Z' && r.window.to === '2026-01-01T01:00:00.000Z');
  t('lines inside the window are counted', r.flagged.some((f) => f.target === 'src/i.js' && f.count === 5));
  t('lines outside the window are excluded', !r.flagged.some((f) => f.target === 'src/j.js'));
})();

// ---- 6b. time-window end falls back to completed_at when finalized_at is absent ------------------------
(() => {
  const root = mkProject();
  writeRunJson(root, 'r6b', { started_at: '2026-03-01T00:00:00.000Z', status: 'completed', completed_at: '2026-03-01T01:00:00.000Z' });
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(line({ ts: '2026-03-01T00:3' + i + ':00.000Z', target: 'src/k.js' }));
  writeSessionLog(root, 's1', lines);
  const r = L.analyze({ root, runId: 'r6b' });
  t('completed_at used as window end when finalized_at is missing', r.window && r.window.to === '2026-03-01T01:00:00.000Z');
  t('lines inside that window are still counted', r.flagged.some((f) => f.target === 'src/k.js' && f.count === 5));
})();

// ---- 7. session filter works ------------------------------------------------------------------------
(() => {
  const root = mkProject();
  writeSessionLog(root, 'sess-a', [
    ...Array.from({ length: 5 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', session: 'sess-a', target: 'src/l.js' })),
  ]);
  writeSessionLog(root, 'sess-b', [
    ...Array.from({ length: 5 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', session: 'sess-b', target: 'src/m.js' })),
  ]);
  const r = L.analyze({ root, sessionId: 'sess-a' });
  t('session basis selected', r.basis === 'session');
  t('only the requested session\'s target is flagged', r.flagged.some((f) => f.target === 'src/l.js') && !r.flagged.some((f) => f.target === 'src/m.js'));
})();

// ---- 8. rotated generation is read ----------------------------------------------------------------------
(() => {
  const root = mkProject();
  // current generation: 3 edits; rotated .1 generation: 2 more edits to the SAME target -> 5 total
  writeSessionLog(root, 'sess-rot', Array.from({ length: 3 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', session: 'sess-rot', target: 'src/rotated.js' })));
  writeSessionLog(root, 'sess-rot', Array.from({ length: 2 }, (_, i) => line({ ts: '2026-10-01T09:0' + i + ':00.000Z', session: 'sess-rot', target: 'src/rotated.js' })), 1);
  const bySession = L.analyze({ root, sessionId: 'sess-rot' });
  t('session mode reads the rotated .1 generation too', bySession.flagged.some((f) => f.target === 'src/rotated.js' && f.count === 5));
  // same via run-field across the whole _toollog directory
  writeRunJson(root, 'r8', { started_at: '2026-10-01T00:00:00.000Z' });
  fs.rmSync(path.join(toollogDir(root), 'sess-rot.jsonl'));
  fs.rmSync(path.join(toollogDir(root), 'sess-rot.1.jsonl'));
  writeSessionLog(root, 'sess-rot', Array.from({ length: 3 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', session: 'sess-rot', target: 'src/rotated2.js', run: 'r8' })));
  writeSessionLog(root, 'sess-rot', Array.from({ length: 2 }, (_, i) => line({ ts: '2026-10-01T09:0' + i + ':00.000Z', session: 'sess-rot', target: 'src/rotated2.js', run: 'r8' })), 1);
  const byRun = L.analyze({ root, runId: 'r8' });
  t('run mode reads the rotated .1 generation across the whole directory', byRun.flagged.some((f) => f.target === 'src/rotated2.js' && f.count === 5));
})();

// ---- 9. malformed lines are skipped and counted ----------------------------------------------------------
(() => {
  const root = mkProject();
  const good = Array.from({ length: 5 }, (_, i) => JSON.stringify(line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/n.js', run: 'r9' })));
  const content = [good[0], '{not valid json', good[1], good[2], 'null', good[3], good[4]].join('\n') + '\n';
  fs.writeFileSync(path.join(toollogDir(root), 's1.jsonl'), content, 'utf8');
  const r = L.analyze({ root, runId: 'r9' });
  t('malformed lines are counted', r.lines_malformed === 2); // '{not valid json' + 'null' (not a plain object)
  t('good lines still produce a flagged target', r.flagged.some((f) => f.target === 'src/n.js' && f.count === 5));
})();

// ---- 10. missing _toollog folder gives an empty, non-throwing result --------------------------------------
(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loophealth-test-'));
  writeRunJson(root, 'r10', { started_at: '2026-01-01T00:00:00.000Z', finalized_at: '2026-01-02T00:00:00.000Z' });
  let threw = null;
  let r = null;
  try { r = L.analyze({ root, runId: 'r10' }); } catch (e) { threw = e; }
  t('no _toollog folder does not throw', threw === null);
  t('no _toollog folder gives files_read=0', !!r && r.files_read === 0);
  t('no _toollog folder gives zero edits and nothing flagged', !!r && r.edits_counted === 0 && r.flagged.length === 0);
  t('no _toollog folder still carries a clear note', !!r && typeof r.note === 'string' && r.note.length > 0);
})();

// ---- 11. missing run.json gives basis 'none' --------------------------------------------------------------
(() => {
  const root = mkProject();
  writeSessionLog(root, 's1', Array.from({ length: 5 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/o.js' })));
  const r = L.analyze({ root, runId: 'no-such-run' });
  t('missing run.json gives basis none', r.basis === 'none');
  t('basis none has a null window', r.window === null);
  t('basis none flags nothing', r.flagged.length === 0);
  t('basis none carries a clear note', typeof r.note === 'string' && r.note.length > 0);
})();

// ---- 11b. run.json present but started_at unusable -> also basis 'none' -----------------------------------
(() => {
  const root = mkProject();
  writeRunJson(root, 'r11b', { started_at: 'not-a-date' });
  writeSessionLog(root, 's1', Array.from({ length: 5 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/p.js' })));
  const r = L.analyze({ root, runId: 'r11b' });
  t('unusable started_at gives basis none', r.basis === 'none');
})();

// ---- 12. invalid id rejected (path-traversal shape) --------------------------------------------------------
(() => {
  const root = mkProject();
  let threw = null;
  try { L.analyze({ root, runId: '../x' }); } catch (e) { threw = e; }
  t('a traversal-shaped run id is rejected', threw instanceof Error);
  let threw2 = null;
  try { L.analyze({ root, sessionId: '../x' }); } catch (e) { threw2 = e; }
  t('a traversal-shaped session id is rejected', threw2 instanceof Error);
  // Lead review: a dots-only id ('..' or '.') has no slash but still names a parent/current folder.
  for (const bad of ['..', '.', '...']) {
    let e3 = null;
    try { L.analyze({ root, runId: bad }); } catch (e) { e3 = e; }
    t('a dots-only run id ' + JSON.stringify(bad) + ' is rejected', e3 instanceof Error);
  }
})();

// ---- Lead review: one file under several spellings is ONE target; an unknown result is not a failure --
(() => {
  const root = mkProject();
  writeSessionLog(root, 's1', [
    line({ target: 'src\\a.js', run: 'spell' }),
    line({ target: 'src/a.js', run: 'spell' }),
    line({ target: path.join(root, 'src', 'a.js'), run: 'spell' }),
    line({ target: './src/a.js', run: 'spell' }),
    line({ target: 'src/a.js', run: 'spell' }),
  ]);
  const r = L.analyze({ root, runId: 'spell' });
  t('five spellings of one file are counted as one target', r.flagged.length === 1 && r.flagged[0].count === 5);
  t('the target is shown project-relative with forward slashes', r.flagged.length === 1 && r.flagged[0].target === 'src/a.js');
  if (process.platform === 'win32') {
    const root2 = mkProject();
    writeSessionLog(root2, 's1', Array.from({ length: 5 }, (_, i) => line({ target: i % 2 ? 'SRC/A.js' : 'src/a.js', run: 'case' })));
    const r2 = L.analyze({ root: root2, runId: 'case' });
    t('on Windows, letter case does not split one file', r2.flagged.length === 1 && r2.flagged[0].count === 5);
  }
  const root3 = mkProject();
  writeSessionLog(root3, 's1', [
    ...Array.from({ length: 3 }, () => line({ target: 'src/u.js', run: 'unk', ok: null, ok_basis: 'absent' })),
    line({ target: 'src/u.js', run: 'unk', ok: false }),
    line({ target: 'src/u.js', run: 'unk', ok: true }),
  ]);
  const r3 = L.analyze({ root: root3, runId: 'unk' });
  const f3 = r3.flagged[0] || {};
  t('ok:null counts as unknown, ok:false as failed, ok:true as succeeded', f3.ok_count === 1 && f3.failed_count === 1 && f3.unknown_count === 3);
  const cli3 = spawnSync(process.execPath, [path.join(__dirname, 'forge-loophealth.cjs'), '--run', 'unk', '--root', root3], { encoding: 'utf8' });
  t('the human line names unknown results instead of calling them unsuccessful', /1 succeeded, 1 failed, 3 result unknown/.test(cli3.stdout));
})();

// ---- 13 & 14. CLI exit codes + --threshold option -----------------------------------------------------------
(() => {
  const root = mkProject();
  writeSessionLog(root, 's1', [
    ...Array.from({ length: 5 }, (_, i) => line({ ts: '2026-10-01T10:0' + i + ':00.000Z', target: 'src/q.js', run: 'cli-run' })),
    ...Array.from({ length: 3 }, (_, i) => line({ ts: '2026-10-01T11:0' + i + ':00.000Z', target: 'src/r.js', run: 'cli-run' })),
  ]);
  const bin = path.join(__dirname, 'forge-loophealth.cjs');
  const runCli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

  const noStrict = runCli('--run', 'cli-run', '--root', root);
  t('CLI exits 0 without --strict even when something is flagged', noStrict.status === 0);
  t('CLI human output names the basis', /basis: run-field/.test(noStrict.stdout));
  t('CLI human output names the threshold', /threshold: 5/.test(noStrict.stdout));
  t('CLI prints the flagged line for src/q.js', /src\/q\.js edited 5 times/.test(noStrict.stdout));

  const strict = runCli('--run', 'cli-run', '--root', root, '--strict');
  t('CLI exits 3 with --strict when something is flagged', strict.status === 3);

  const thresholded = runCli('--run', 'cli-run', '--root', root, '--threshold', '3', '--strict');
  t('CLI --threshold 3 flags the 3-edit file too (still exits 3)', thresholded.status === 3);
  t('CLI --threshold 3 output includes src/r.js', /src\/r\.js edited 3 times/.test(thresholded.stdout));

  const thresholdedClean = runCli('--run', 'cli-run', '--root', root, '--threshold', '10', '--strict');
  t('CLI --threshold 10 flags nothing -> exits 0 even with --strict', thresholdedClean.status === 0);

  const jsonOut = runCli('--run', 'cli-run', '--root', root, '--json');
  t('CLI --json prints parseable JSON with the flagged array', (() => {
    // default threshold 5: only the 5-edit file (src/q.js) is flagged, not the 3-edit one (src/r.js)
    try { const j = JSON.parse(jsonOut.stdout.slice(jsonOut.stdout.indexOf('{'))); return Array.isArray(j.flagged) && j.flagged.length === 1 && j.flagged[0].target === 'src/q.js'; } catch { return false; }
  })());

  const badArgs = runCli('--root', root);
  t('CLI exits 1 with neither --run nor --session', badArgs.status === 1);

  const badId = runCli('--run', '../evil', '--root', root);
  t('CLI exits 1 on an invalid run id', badId.status === 1);

  const bothFlags = runCli('--run', 'cli-run', '--session', 's1', '--root', root);
  t('CLI exits 1 when both --run and --session are given', bothFlags.status === 1);
})();

// ---- 15. the tool never writes anything --------------------------------------------------------------------
(() => {
  const root = mkProject();
  writeRunJson(root, 'r15', { started_at: '2026-01-01T00:00:00.000Z', finalized_at: '2026-01-02T00:00:00.000Z' });
  writeSessionLog(root, 's1', Array.from({ length: 6 }, (_, i) => line({ ts: '2026-01-01T00:1' + i + ':00.000Z', target: 'src/s.js', run: 'r15' })));

  function snapshot(dir) {
    const out = {};
    (function walk(d) {
      for (const name of fs.readdirSync(d).sort()) {
        const p = path.join(d, name);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p); else out[p] = st.mtimeMs;
      }
    })(dir);
    return out;
  }
  const before = snapshot(root);
  L.analyze({ root, runId: 'r15' });
  L.analyze({ root, sessionId: 's1' });
  const bin = path.join(__dirname, 'forge-loophealth.cjs');
  spawnSync(process.execPath, [bin, '--run', 'r15', '--root', root, '--json', '--strict'], { encoding: 'utf8' });
  const after = snapshot(root);
  t('file list is unchanged after analyze() + CLI run', JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort()));
  t('no mtimes changed after analyze() + CLI run', Object.keys(before).every((p) => before[p] === after[p]));
})();

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
