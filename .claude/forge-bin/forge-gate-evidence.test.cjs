#!/usr/bin/env node
'use strict';
/**
 * forge-gate-evidence.cjs — bewijsrecorder (Codex rapport-review R-01/R-05).
 * Hermetisch: eigen temp-root, eigen mini-poorten (echte node-processen), nooit de echte runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

const TOOL = path.join(__dirname, 'forge-gate-evidence.cjs');
const E = require(TOOL);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));
const RUN = 'evidence-run';
fs.mkdirSync(path.join(ROOT, '.claude', 'forge-runs', RUN), { recursive: true });

// mini-poorten: echte node-processen met bekende uitvoer en exitcode
const okScript = path.join(ROOT, 'ok.cjs');
fs.writeFileSync(okScript, "console.log('7 passed, 0 failed');process.exit(0);");
const badScript = path.join(ROOT, 'bad.cjs');
fs.writeFileSync(badScript, "console.log('3 passed, 2 failed');console.error('boem');process.exit(1);");

console.log('forge-gate-evidence (hermetisch, root=' + ROOT + ')');

// 1) groene poort: record klopt en is zelf-verifieerbaar
{
  const { manifest, manifestFile } = E.record(RUN, [{ name: 'groen', cmd: process.execPath, args: [okScript] }], { root: ROOT, quiet: true });
  const g = manifest.gates[0];
  t('1 manifest bevat de poort met exit 0 en all_green', manifest.all_green === true && manifest.gates_total === 1 && g.exit_code === 0);
  t('1 de exacte argv is vastgelegd (geen shell-string)', Array.isArray(g.argv) && g.argv[0] === process.execPath && g.argv[1] === okScript);
  t('1 timestamps + duur zijn echt', typeof g.started_at === 'string' && typeof g.ended_at === 'string' && g.duration_ms >= 0 && Date.parse(g.ended_at) >= Date.parse(g.started_at));
  t('1 de tail draagt de echte uitslagregel', (g.tail || []).join(' ').includes('7 passed, 0 failed'));
  const raw = fs.readFileSync(path.join(ROOT, g.output_file), 'utf8');
  t('1 output_sha256 hoort ECHT bij de opgeslagen ruwe uitvoer', crypto.createHash('sha256').update(raw, 'utf8').digest('hex') === g.output_sha256);
  t('1 het manifest staat op de verwachte plek', fs.existsSync(manifestFile) && manifestFile.endsWith('gate-evidence.json'));
}

// 2) rode poort: het manifest is NOOIT groen over een non-zero exit (de kern van deze recorder)
{
  const { manifest } = E.record(RUN, [{ name: 'rood', cmd: process.execPath, args: [badScript] }], { root: ROOT, quiet: true });
  const g = manifest.gates.find((x) => x.name === 'rood');
  t('2 een rode poort levert exit 1 in het record', g.exit_code === 1);
  t('2 het manifest is NIET groen', manifest.all_green === false && manifest.gates_failed >= 1);
  t('2 stderr zit mee in de vastgelegde uitvoer', fs.readFileSync(path.join(ROOT, g.output_file), 'utf8').includes('boem'));
}

// 3) --merge: eerdere poorten blijven, gelijknamige worden vervangen
{
  E.record(RUN, [{ name: 'blijft', cmd: process.execPath, args: [okScript] }], { root: ROOT, quiet: true });
  const { manifest } = E.record(RUN, [{ name: 'rood', cmd: process.execPath, args: [okScript] }], { root: ROOT, quiet: true, merge: true });
  const namen = manifest.gates.map((g) => g.name);
  t('3 merge behoudt de eerder vastgelegde poort', namen.includes('blijft'));
  t('3 merge VERVANGT de gelijknamige poort (rood is nu groen)', manifest.gates.filter((g) => g.name === 'rood').length === 1 && manifest.gates.find((g) => g.name === 'rood').exit_code === 0);
  t('3 en het manifest wordt daarmee groen', manifest.all_green === true, JSON.stringify(namen));
}

// 4) CLI-contract: exit 1 zodra een poort rood is, exit 0 als alles groen is
{
  // paden met spaties MOETEN werken (node staat in "C:\Program Files\..."; deze projectmap heet
  // "my project!") — daarom quotes in de inline --gate-vorm.
  const q = (x) => '"' + x + '"';
  const r1 = spawnSync(process.execPath, [TOOL, '--run', RUN, '--root', ROOT, '--gate', 'cli-rood::' + q(process.execPath) + ' ' + q(badScript)], { encoding: 'utf8' });
  t('4 CLI exit 1 bij een rode poort', r1.status === 1, 'status=' + r1.status);
  const r2 = spawnSync(process.execPath, [TOOL, '--run', RUN, '--root', ROOT, '--gate', 'cli-groen::' + q(process.execPath) + ' ' + q(okScript)], { encoding: 'utf8' });
  t('4 CLI exit 0 wanneer de opgegeven poort groen is (pad met spaties werkt)', r2.status === 0, 'status=' + r2.status + ' :: ' + (r2.stdout || '').slice(0, 160));
  const rawPad = String.raw`C:\Program Files\nodejs\node.exe`;
  t('4 de tokenizer houdt een gequoteerd pad met spaties heel',
    JSON.stringify(E.tokenize('"' + rawPad + '" --flag x')) === JSON.stringify([rawPad, '--flag', 'x']),
    JSON.stringify(E.tokenize('"' + rawPad + '" --flag x')));
  t('4 en splitst een ONgequoteerd pad met spaties wél (documenteert waarom quotes nodig zijn)',
    E.tokenize(rawPad + ' --flag').length === 3);
  const r3 = spawnSync(process.execPath, [TOOL, '--root', ROOT], { encoding: 'utf8' });
  t('4 CLI zonder --run weigert met usage (exit 2)', r3.status === 2 && /usage:/.test(r3.stderr || ''));
}

// 5) npm-shell-uitzondering (win32): VASTE argumenten mogen, vrije/variabele NIET
{
  let threw = null;
  try { E.record(RUN, [{ name: 'npm-vrij', cmd: 'npm', args: ['test', '--silent', 'iets met spaties & ampersand'] }], { root: ROOT, quiet: true }); }
  catch (e) { threw = e; }
  if (process.platform === 'win32') {
    t('5 npm met vrije/onveilige argumenten wordt geweigerd (shell-uitzondering blijft eng)', threw !== null && /VASTE, simpele argumenten/.test(threw.message), threw && threw.message);
  } else {
    t('5 SKIP-voorwaarde geverifieerd: de npm-shell-uitzondering geldt alleen op win32 (dit is ' + process.platform + ')', process.platform !== 'win32');
  }
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { }
/** R9-08 (negende herreview): de recorder-suite dekte de codebinding en de read-back niet. Beide zijn
 *  claims die pas iets betekenen als ze worden AFGEDWONGEN — dus horen ze een test te hebben die faalt
 *  zodra de handhaving wegvalt. */
{
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-r9-'));
  const R = require(path.join(__dirname, 'forge-gate-evidence.cjs'));
  const res = R.record('r9', [{ name: 'echo', cmd: process.execPath, args: ['-e', 'console.log("hallo")'] }], { root: ROOT });
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'forge-runs', 'r9', 'gate-evidence.json'), 'utf8'));
  const g = m.gates[0];
  t('R9-08 elke poort draagt een eigen codemeting', !!g.code, JSON.stringify(g.code));
  t('R9-08 met een expliciete stable-vlag (per poort gemeten, niet achteraf geplakt)', typeof g.code.stable === 'boolean');
  t('R9-08 evidence_verified is op READ-BACK gebaseerd: het bestand op schijf hoort echt bij de hash',
    g.evidence_verified === true && crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, g.output_file), 'utf8'), 'utf8').digest('hex') === g.output_sha256);
  // sabotage de bewaarde uitvoer -> een MERGE moet dat zien en het record rood maken
  fs.writeFileSync(path.join(ROOT, g.output_file), 'gemanipuleerd\n');
  R.record('r9', [{ name: 'tweede', cmd: process.execPath, args: ['-e', 'console.log("x")'] }], { root: ROOT, merge: true });
  const m2 = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'forge-runs', 'r9', 'gate-evidence.json'), 'utf8'));
  const oud = m2.gates.find((x) => x.name === 'echo');
  t('R9-08 een gemanipuleerd bewijsbestand maakt het behouden record ONgeverifieerd',
    oud && oud.evidence_verified === false, JSON.stringify(oud && { v: oud.evidence_verified, p: oud.evidence_problem }));
  t('R9-08 en het manifest is daardoor niet meer all_green', m2.all_green === false);
  t('R9-08 de A->B->A-grens staat expliciet IN het manifest', typeof m2.code.stable_limitation === 'string' && /A->B->A/.test(m2.code.stable_limitation));
  fs.rmSync(ROOT, { recursive: true, force: true });
}

// ================================================================================================
// (usage audit U-12) — a test gate given in the forge-testrun wrapper form. Only the wrapper's
// summary reaches the caller; the manifest carries the REAL test command, its exit code, and output_file = the
// wrapper's FULL log under gate-output/ (sha256 over its bytes, read back). The F03 binding points at that log.
// ================================================================================================
{
  const RC = require('./forge-runcontract.cjs');
  const TESTRUN = path.join(__dirname, 'forge-testrun.cjs');
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-wrap-'));
  const mk = (run) => { fs.mkdirSync(path.join(W, '.claude', 'forge-runs', run), { recursive: true }); return run; };
  const okS = path.join(W, 'ok.cjs');
  fs.writeFileSync(okS, "console.log('ok 1 - alpha works');console.log('7 passed, 0 failed');");
  const badS = path.join(W, 'bad.cjs');
  fs.writeFileSync(badS, "console.log('not ok 1 - beta breaks');console.log('  expected 1, got 2');console.log('3 passed, 2 failed');process.exit(1);");
  const slowS = path.join(W, 'slow.cjs');
  fs.writeFileSync(slowS, 'setTimeout(() => {}, 30000);');
  const wrapGate = (name, script, extra) => ({ name, cmd: process.execPath, args: [TESTRUN].concat(extra || [], ['--', process.execPath, script]) });

  const run1 = mk('wrap-green');
  const { manifest: m1 } = E.record(run1, [wrapGate('suite', okS)], { root: W, quiet: true });
  const g1 = m1.gates[0];
  t('W1 the manifest records the REAL test command and argv, not the wrapper', g1.command === process.execPath + ' ' + okS && JSON.stringify(g1.argv) === JSON.stringify([process.execPath, okS]), g1.command);
  t('W1 the exit code mirrors the wrapped command (0) and the manifest is green', g1.exit_code === 0 && m1.all_green === true);
  t('W1 output_file is the wrapper\'s full log inside this run\'s gate-output folder', /^\.claude\/forge-runs\/wrap-green\/gate-output\/testrun-.+\.log$/.test(g1.output_file || ''), g1.output_file);
  const bytes1 = fs.readFileSync(path.join(W, g1.output_file));
  t('W1 output_sha256 + output_bytes are the sha256 and size of the log BYTES, read back (evidence_verified)', crypto.createHash('sha256').update(bytes1).digest('hex') === g1.output_sha256 && g1.output_bytes === bytes1.length && g1.evidence_verified === true);
  t('W1 the log is the FULL output (header with the real command + every line); the record keeps only the summary', /^\$ /.test(bytes1.toString('utf8')) && bytes1.toString('utf8').includes('ok 1 - alpha works') && !!g1.runner && g1.runner.tool === 'forge-testrun' && g1.runner.summary === '7 passed, 0 failed', JSON.stringify(g1.runner));
  t('W1 the wrapper log was written during the gate, so the code state stays stable (per-gate binding intact)', !!g1.code && g1.code.stable === true, JSON.stringify(g1.code));
  const set1 = RC.canonicalEvidenceDigest(W, run1);
  t('W1 the F03 canonical evidence digest accepts the wrapped gate: valid, verified, green', !!set1 && set1.allGreen === true && set1.verified === true && set1.gates === 1, JSON.stringify(set1));
  fs.appendFileSync(path.join(W, g1.output_file), 'tampered\n');
  t('W1 a tampered wrapper log breaks the evidence set (the hash binding is on the log itself)', RC.canonicalEvidenceDigest(W, run1) === null);

  const run2 = mk('wrap-red');
  const { manifest: m2 } = E.record(run2, [wrapGate('suite', badS)], { root: W, quiet: true });
  const g2 = m2.gates[0];
  t('W2 a red wrapped gate: exit 1 recorded, manifest NOT green, the failing test is named in the record', g2.exit_code === 1 && m2.all_green === false && (g2.runner.failing || []).some((n) => /beta breaks/.test(n)) && g2.runner.summary === '3 passed, 2 failed', JSON.stringify(g2.runner));

  const run3 = mk('wrap-refuse');
  const refused = (gate) => { try { E.record(run3, [gate], { root: W, quiet: true }); return null; } catch (e) { return e.message; } };
  t('W3 a wrapped gate with its own --log-dir is refused (gate-evidence chooses the log folder)', /--log-dir/.test(refused(wrapGate('own-logdir', okS, ['--log-dir', W])) || ''));
  t('W3 a wrapped gate without "-- <test command>" is refused', /-- <test command>/.test(refused({ name: 'no-cmd', cmd: process.execPath, args: [TESTRUN, '--max-lines', '20'] }) || ''));
  t('W3 an unknown wrapper option is refused (never silently passed through)', /option/.test(refused(wrapGate('bad-opt', okS, ['--shell', 'yes'])) || ''));

  // a "wrapper" that wrote no log inside the run folder: FAIL CLOSED (exit -2, unverified, not green)
  const fakeDir = path.join(W, 'fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeWrapper = path.join(fakeDir, 'forge-testrun.cjs');
  fs.writeFileSync(fakeWrapper, "console.log('9 passed, 0 failed');console.log('full log: ' + process.argv[process.argv.indexOf('--log-dir') + 1].replace(/gate-output$/, 'elsewhere.log'));");
  const run4 = mk('wrap-nolog');
  const { manifest: m4 } = E.record(run4, [{ name: 'suite', cmd: process.execPath, args: [fakeWrapper, '--', process.execPath, okS] }], { root: W, quiet: true });
  const g4 = m4.gates[0];
  t('W4 a wrapper log that is missing or outside this run\'s gate-output folder fails CLOSED (unverified, exit -2, not green)', g4.evidence_verified === false && g4.exit_code === -2 && m4.all_green === false && /log/.test(g4.evidence_problem || ''), JSON.stringify({ v: g4.evidence_verified, x: g4.exit_code, p: g4.evidence_problem }));
  t('W4 ... and the evidence set is not green for completion', (() => { const s = RC.canonicalEvidenceDigest(W, run4); return !s || s.allGreen !== true; })());

  const run5 = mk('wrap-timeout');
  const { manifest: m5 } = E.record(run5, [wrapGate('slow', slowS, ['--timeout-sec', '1'])], { root: W, quiet: true });
  const g5 = m5.gates[0];
  t('W5 a wrapped gate the wrapper timed out: exit 124, timed_out:true, never green', g5.exit_code === 124 && g5.timed_out === true && m5.all_green === false && RC.canonicalEvidenceDigest(W, run5) === null, JSON.stringify({ x: g5.exit_code, to: g5.timed_out }));

  // CLI, the exact recipe form: only the summary reaches the caller, never the full test output
  const run6 = mk('wrap-cli');
  const q = (x) => '"' + x + '"';
  const cli = spawnSync(process.execPath, [TOOL, '--run', run6, '--root', W, '--gate', 'suite::' + q(process.execPath) + ' ' + q(TESTRUN) + ' -- ' + q(process.execPath) + ' ' + q(okS)], { encoding: 'utf8' });
  t('W6 CLI recipe form: exit 0 and the summary line is printed', cli.status === 0 && /7 passed, 0 failed/.test(cli.stdout || ''), (cli.stdout || '') + (cli.stderr || ''));
  t('W6 ... the full test output never reaches the caller (it stays in the log)', !/ok 1 - alpha works/.test((cli.stdout || '') + (cli.stderr || '')));
  const cliBad = spawnSync(process.execPath, [TOOL, '--run', run6, '--root', W, '--gate', 'red::' + q(process.execPath) + ' ' + q(TESTRUN) + ' -- ' + q(process.execPath) + ' ' + q(badS)], { encoding: 'utf8' });
  t('W6 CLI on a red wrapped gate: exit 1, the failing test name and the log path are printed', cliBad.status === 1 && /beta breaks/.test(cliBad.stdout || '') && /gate-output[\\/]testrun-/.test(cliBad.stdout || ''), cliBad.stdout);

  // a plain (unwrapped) gate keeps its old shape: <name>.txt written by the recorder, no runner field
  const run7 = mk('plain-gate');
  const { manifest: m7 } = E.record(run7, [{ name: 'plain', cmd: process.execPath, args: [okS] }], { root: W, quiet: true });
  t('W7 an unwrapped gate is recorded exactly as before (<name>.txt, no runner field)', /gate-output\/plain\.txt$/.test(m7.gates[0].output_file) && m7.gates[0].runner === undefined && m7.gates[0].evidence_verified === true);
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ================================================================================================
// (2.1, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — gitState()/record() must accept ONLY
// a POSITIVELY CONFIRMED no-git root (`confirmed_no_repo:true` on BOTH before/after readings) as no_git:true.
// An UNDETERMINED reading (a repo with no commits yet, a poisoned GIT_DIR) must fall through to stable:false
// exactly like before the D2 no-git path ever existed — never a silently relaxed no_git:true record.
// ================================================================================================
{
  const gitAvailable = (() => { try { const r = spawnSync('git', ['--version'], { encoding: 'utf8' }); return !!r && r.status === 0; } catch { return false; } })();
  if (!gitAvailable) {
    console.log('  SKIP WP-S13 gitState scenarios: no working `git` on PATH in this environment');
  } else {
    // 8a: a genuinely git-less root (no .git anywhere) — the ONLY case allowed to record no_git:true.
    const NOGIT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-nogit-'));
    fs.mkdirSync(path.join(NOGIT, '.claude', 'forge-runs', 'r-nogit'), { recursive: true });
    const rNoGit = E.record('r-nogit', [{ name: 'g', cmd: process.execPath, args: ['-e', 'console.log("x")'] }], { root: NOGIT, quiet: true });
    const gNoGit = rNoGit.manifest.gates[0];
    t('8a a confirmed no-git root records no_git:true, stable:true, commit:null', gNoGit.code.no_git === true && gNoGit.code.stable === true && gNoGit.code.commit === null, JSON.stringify(gNoGit.code));
    fs.rmSync(NOGIT, { recursive: true, force: true });

    // 8f: a repo with NO commits yet — UNDETERMINED, must never record no_git:true (the exact class this
    // fix closes: before it, both readings' `available:false` looked identical to a confirmed no-git root).
    const EMPTYREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-emptyrepo-'));
    spawnSync('git', ['init', '-q'], { cwd: EMPTYREPO, encoding: 'utf8' });
    fs.mkdirSync(path.join(EMPTYREPO, '.claude', 'forge-runs', 'r-emptyrepo'), { recursive: true });
    const rEmpty = E.record('r-emptyrepo', [{ name: 'g', cmd: process.execPath, args: ['-e', 'console.log("x")'] }], { root: EMPTYREPO, quiet: true });
    const gEmpty = rEmpty.manifest.gates[0];
    t('8f a repo with NO commits yet is UNDETERMINED — never recorded no_git:true (was the exact D2-vs-2.1 gap)', gEmpty.code.no_git === false && gEmpty.code.stable === false, JSON.stringify(gEmpty.code));
    fs.rmSync(EMPTYREPO, { recursive: true, force: true });

    // 8c: a poisoned GIT_DIR on a REAL repo (with a real commit) must NOT be recorded as no_git — the
    // env-hardening in gitProbe()/cleanGitEnv() must make record() see the REAL commit regardless.
    const REALREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-realrepo-'));
    const git = (...args) => spawnSync('git', args, { cwd: REALREPO, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(REALREPO, 'seed.txt'), 'seed\n');
    git('add', '.'); git('commit', '-q', '-m', 'seed');
    const realHead = git('rev-parse', 'HEAD').stdout.trim();
    fs.mkdirSync(path.join(REALREPO, '.claude', 'forge-runs', 'r-poisoned'), { recursive: true });
    const savedGitDir = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = path.join(os.tmpdir(), 'gate-evidence-nonexistent-gitdir-' + Date.now());
      const rPoisoned = E.record('r-poisoned', [{ name: 'g', cmd: process.execPath, args: ['-e', 'console.log("x")'] }], { root: REALREPO, quiet: true });
      const gPoisoned = rPoisoned.manifest.gates[0];
      t('8c a poisoned GIT_DIR on a real repo is NEUTRALIZED — record() still sees the REAL commit, never a false no_git:true', gPoisoned.code.no_git === false && gPoisoned.code.commit === realHead.toLowerCase(), JSON.stringify(gPoisoned.code));
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
    }
    fs.rmSync(REALREPO, { recursive: true, force: true });
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
