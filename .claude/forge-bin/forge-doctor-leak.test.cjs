'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-doctor-leak.test.cjs — coverage holes of doctor/checks-leak.cjs:
//   FB-CONFIG-1-F4  the gitless walk cut off folders deeper than its cap and recorded nothing
//   FB-CONFIG-1-F7  tracked .claude/forge-runs/ files were skipped without a trace
//   FB-CONFIG-1-F11 `git ls-files` octal-quoted a non-ASCII name, so the file was "unreadable", not scanned
// Every secret below is synthetic, built at runtime from random hex (never a real credential).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const L = require('./doctor/checks-leak.cjs');
const { printSummary } = require('./doctor/report.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const synth = () => 'gh' + 'p_' + crypto.randomBytes(20).toString('hex'); // synthetic, high-entropy, no placeholder word
const w = (root, rel, text) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const gitOk = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).status === 0;
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-leak-' + tag + '-'));
const made = [];

console.log('forge-doctor-leak tests');

// F4: gitless walk, a file 7 folders deep
const deep = tmp('deep'); made.push(deep);
w(deep, 'a/b/c/d/e/f/g/config.js', 'const k = "' + synth() + '";\n');
const insideGit = spawnSync('git', ['-C', deep, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status === 0;
t('F4: the gitless walk never drops a too-deep folder silently (scanned or named in notScanned as depth-cap)', () => {
  if (insideGit) { console.log('  skip (the OS temp folder is inside a git work tree; gitless mode cannot be reached here)'); return; }
  const r = L.leakScan(deep);
  ok(r.source === 'walk', 'expected the walk, got ' + r.source);
  const named = r.notScanned.some((n) => /depth-cap/.test(n.reason) && /^a\/b\/c\/d\/e\/f/.test(n.dir));
  ok(r.hits.length === 1 || named, 'deep file neither scanned nor named: ' + JSON.stringify({ scanned: r.scanned, hits: r.hits.length, notScanned: r.notScanned }));
});
t('F4: printSummary names a depth-cap folder with its own reason (not as "agent worktree checkouts")', () => {
  if (insideGit) return;
  const s = printSummaryFor(L.leakScan(deep));
  ok(/not scanned: a\/b\/c\/d\/e\/f\/g\/ \(depth-cap/.test(s), s);
});

// F7 + F11: a git repo with a run record and a non-ASCII file name
const repo = tmp('git'); made.push(repo);
w(repo, 'readme.md', 'nothing here\n');
w(repo, '.claude/forge-runs/run-1/report.md', 'pasted by mistake: ' + synth() + '\n');
w(repo, '.claude/forge-backups/b1/forge-chaos.cjs', 'const fixture = "' + synth() + '";\n');
w(repo, 'src/café.js', 'module.exports = "' + synth() + '";\n');
const gitReady = gitOk(repo, 'init', '-q') && gitOk(repo, 'add', '-A');
t('F7: a tracked file under .claude/forge-runs/ is scanned like any other tracked file', () => {
  ok(gitReady, 'git fixture could not be built');
  const r = L.leakScan(repo);
  ok(r.source === 'git', r.source);
  ok(r.hits.some((h) => h.file === '.claude/forge-runs/run-1/report.md'), JSON.stringify(r.hits));
});
t('F7: .claude/forge-backups/ stays exempt (copies of Forge\'s own fixtures)', () => {
  ok(gitReady);
  ok(!L.leakScan(repo).hits.some((h) => /forge-backups/.test(h.file)));
});
t('F11: a tracked file with a non-ASCII name is listed by its real name and scanned, never "unreadable"', () => {
  ok(gitReady);
  ok((L.gitLsFiles(repo) || []).includes('src/café.js'), JSON.stringify(L.gitLsFiles(repo)));
  const r = L.leakScan(repo);
  ok(!r.skipped.some((s) => s.reason === 'unreadable'), JSON.stringify(r.skipped));
  ok(r.hits.some((h) => h.file === 'src/café.js'), JSON.stringify(r.hits));
});

function printSummaryFor(leak) {
  // printSummary needs the whole report; only the leak line is read here, so the rest are minimal stand-ins
  let text;
  try { text = String(printSummary(stubReport(leak))); } catch (e) { return 'THREW ' + e.message; }
  return text.split('\n').filter((l) => /leak scan/.test(l)).join('\n');
}
function stubReport(leak) {
  return { root: 'x', ok: true, checks: {
    node_check: { ok: true, total: 0 }, tests: { ok: true, suites: 0, passed: 0, failed: 0, perSuite: [] },
    strict_events: { ok: true, known_accepted: 0, unknown_rejected: 0 }, dashboard_spa: { ok: true, present: [] }, leak_scan: leak,
  }, advisory: {} };
}

for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.log('  note: could not remove ' + d + ' (' + e.code + ')'); } }
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
