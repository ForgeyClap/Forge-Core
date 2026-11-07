#!/usr/bin/env node
'use strict';
/**
 * forge-release-check.test.cjs — hermetic tests for forge-release-check.cjs.
 *
 * Every fixture lives under a fresh os.tmpdir() mkdtemp root. NEVER touches this project's real
 * release-exclusions.json content assumptions beyond what the task spec itself fixes (the near-miss
 * paths and the curated-placeholder name), makes ZERO network calls, and never writes/commits/switches
 * branches in the real public release tree — the one read-only run against it lives in the build
 * report, not in this suite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
const tFn = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };

const CLI = path.join(__dirname, 'forge-release-check.cjs');
const REAL_CONFIG = path.join(__dirname, '..', 'config', 'orchestration', 'release-exclusions.json');

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function git(cwd, ...args) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }
/** makeRepo(prefix) -> a fresh dir, `git init`-ed with a local identity so commits never depend on the
 *  machine's global git config. Returns null (never throws) when git itself is unavailable here. */
function makeRepo(prefix) {
  const dir = freshDir(prefix);
  const init = git(dir, 'init', '-q');
  if (init.error) return null;
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}
function writeFile(dir, rel, content) {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}
function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  const c = git(dir, 'commit', '-q', '-m', msg);
  return c;
}
function headLooksReal(dir) {
  const r = git(dir, 'rev-parse', 'HEAD');
  return !r.error && r.status === 0 && /^[0-9a-f]{7,40}$/i.test((r.stdout || '').trim());
}
function runCLI(args) { return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }

// require() the module under test directly for the pure-function tests (loadExclusions/isNeverSync).
let RC = null;
try { RC = require('./forge-release-check.cjs'); } catch (e) { console.error('require failed (expected RED before implementation exists): ' + e.message); }

// ---------------------------------------------------------------------------------------------------
// loadExclusions() against the REAL shipped config — must load cleanly and expose all three lists.
// ---------------------------------------------------------------------------------------------------
if (RC) {
  tFn('loadExclusions: the real shipped release-exclusions.json loads with all three lists non-empty', () => {
    const ex = RC.loadExclusions(REAL_CONFIG);
    assert.ok(Array.isArray(ex.sync_folders) && ex.sync_folders.length > 0, 'sync_folders');
    assert.ok(Array.isArray(ex.never_sync) && ex.never_sync.length > 0, 'never_sync');
    assert.ok(Array.isArray(ex.dist_forbidden) && ex.dist_forbidden.length > 0, 'dist_forbidden');
    assert.ok(ex.never_sync.every((p) => p && p.re instanceof RegExp), 'every never_sync pattern compiled');
    assert.ok(ex.dist_forbidden.every((p) => p && p.re instanceof RegExp), 'every dist_forbidden pattern compiled');
  });

  // --- bad config: missing file, bad JSON, missing list, pattern that does not compile — all throw ---
  tFn('loadExclusions: throws a clear error when the config file does not exist', () => {
    const dir = freshDir('rc-missing');
    assert.throws(() => RC.loadExclusions(path.join(dir, 'nope.json')), /release-exclusions/i);
  });
  tFn('loadExclusions: throws a clear error on invalid JSON', () => {
    const dir = freshDir('rc-badjson');
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{ not valid json', 'utf8');
    assert.throws(() => RC.loadExclusions(p));
  });
  tFn('loadExclusions: throws when a required list is missing', () => {
    const dir = freshDir('rc-nolist');
    const p = path.join(dir, 'nolist.json');
    fs.writeFileSync(p, JSON.stringify({ schema: 'x', sync_folders: [], never_sync: [] }), 'utf8'); // dist_forbidden missing
    assert.throws(() => RC.loadExclusions(p), /dist_forbidden/);
  });
  tFn('loadExclusions: throws when a pattern does not compile', () => {
    const dir = freshDir('rc-badpattern');
    const p = path.join(dir, 'badpattern.json');
    fs.writeFileSync(p, JSON.stringify({ schema: 'x', sync_folders: [], never_sync: ['[unterminated'], dist_forbidden: [] }), 'utf8');
    assert.throws(() => RC.loadExclusions(p), /does not compile/);
  });

  // ---------------------------------------------------------------------------------------------------
  // isNeverSync() — the BLOK cases named in the work package, plus one that must NOT match.
  // ---------------------------------------------------------------------------------------------------
  const ex = RC.loadExclusions(REAL_CONFIG);
  t('isNeverSync: forge-runs/x/events.jsonl is blocked', !!RC.isNeverSync('forge-runs/x/events.jsonl', ex));
  t('isNeverSync: FORGE_MEMORY.md is blocked', !!RC.isNeverSync('FORGE_MEMORY.md', ex));
  t('isNeverSync: skills/DESCRIPTIONS-BACKUP/x is blocked', !!RC.isNeverSync('skills/DESCRIPTIONS-BACKUP/x', ex));
  t('isNeverSync: forge-bin/forge-prd.cjs is NOT blocked', !RC.isNeverSync('forge-bin/forge-prd.cjs', ex));
  t('isNeverSync: forge-bin/forge-runs.cmd (near miss) is NOT blocked', !RC.isNeverSync('forge-bin/forge-runs.cmd', ex));
  // backslash input (Windows-style relative path) must normalise the same as forward-slash input
  t('isNeverSync: backslash path forge-runs\\x\\events.jsonl is blocked identically', !!RC.isNeverSync('forge-runs\\x\\events.jsonl', ex));

  // --- case-insensitive matching — Windows treats FORGE-RUNS and forge-runs
  // as the SAME folder, so an uppercase/mixed-case variant must be blocked identically to the lowercase one.
  t('isNeverSync W2-01: uppercase FORGE-RUNS/x/events.jsonl is blocked (case-insensitive)', !!RC.isNeverSync('FORGE-RUNS/x/events.jsonl', ex));
  t('isNeverSync W2-01: mixed-case Forge-Research/y.md is blocked (case-insensitive)', !!RC.isNeverSync('Forge-Research/y.md', ex));
}

// ---------------------------------------------------------------------------------------------------
// checkDist() / CLI — git-tracked fixtures. Skips gracefully (never silently green) if git is
// genuinely unavailable in this environment.
// ---------------------------------------------------------------------------------------------------
const PROBE_REPO = makeRepo('rc-probe');
const gitAvailable = PROBE_REPO !== null;
if (gitAvailable) { writeFile(PROBE_REPO, 'seed.txt', 'seed\n'); commitAll(PROBE_REPO, 'seed'); }
const gitWorks = gitAvailable && headLooksReal(PROBE_REPO);

if (!gitWorks) {
  console.log('  SKIP all checkDist/CLI git-fixture tests — git is not usable in this environment');
} else {
  // 1) a forbidden tracked file gives exit 3 and names it
  {
    const dir = makeRepo('rc-forbidden');
    writeFile(dir, '.claude/forge-research/notes.md', 'private research\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'add forbidden file');
    const res = runCLI(['--dist', dir]);
    t('CLI: a forbidden tracked file exits 3', res.status === 3, 'status=' + res.status + ' stdout=' + res.stdout);
    t('CLI: the violation output names the forbidden path', res.stdout.includes('forge-research/notes.md'), res.stdout);
  }

  // 2) a clean tree gives exit 0
  {
    const dir = makeRepo('rc-clean');
    writeFile(dir, '.claude/forge-bin/forge-doctor.cjs', '// fine\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'clean tree');
    const res = runCLI(['--dist', dir]);
    t('CLI: a clean tree exits 0', res.status === 0, 'status=' + res.status + ' stdout=' + res.stdout);
  }

  // 3) a non-git folder is walked (not a git repo at all)
  {
    const dir = freshDir('rc-nongit');
    writeFile(dir, '.claude/forge-runs/x/events.jsonl', '{}\n');
    writeFile(dir, 'readme.md', '# ok\n');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI: non-git folder exits 3 (walked, finds the forbidden file)', res.status === 3, 'status=' + res.status + ' stdout=' + res.stdout);
    let parsed = null;
    tFn('CLI: non-git folder JSON output reports method=walk', () => {
      parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.method, 'walk');
      assert.ok(parsed.violations.some((v) => v.path.includes('forge-runs/x/events.jsonl')));
    });
  }

  // 4) an UNTRACKED forbidden file in a git repo is NOT a violation (only tracked files count)
  {
    const dir = makeRepo('rc-untracked');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'tracked baseline');
    writeFile(dir, '.claude/forge-runs/untracked.jsonl', '{}\n'); // never git add'ed
    const res = runCLI(['--dist', dir]);
    t('CLI: an untracked forbidden file is NOT reported as a violation', res.status === 0, 'status=' + res.status + ' stdout=' + res.stdout);
  }

  // 5) near misses do not match: forge-bin/forge-runs.cmd and skills/forge-prd/SKILL.md are legitimate
  {
    const dir = makeRepo('rc-nearmiss');
    writeFile(dir, '.claude/forge-bin/forge-runs.cmd', '@echo off\n');
    writeFile(dir, '.claude/skills/forge-prd/SKILL.md', '# forge-prd skill\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'near-miss baseline');
    const res = runCLI(['--dist', dir]);
    t('CLI: near-miss files (forge-runs.cmd, skills/forge-prd/SKILL.md) do NOT trigger a violation', res.status === 0, 'status=' + res.status + ' stdout=' + res.stdout);
  }

  // 6) a curated placeholder .claude/FORGE_MEMORY.md is allowed in the dist tree
  {
    const dir = makeRepo('rc-placeholder');
    writeFile(dir, '.claude/FORGE_MEMORY.md', '# Memory\n\n(placeholder — see your own project memory)\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'placeholder memory file');
    const res = runCLI(['--dist', dir]);
    t('CLI: curated placeholder .claude/FORGE_MEMORY.md is allowed (exit 0)', res.status === 0, 'status=' + res.status + ' stdout=' + res.stdout);
  }

  // 6b) more curated placeholders + more near-misses from the W2-01/W2-02 ticket's "must still pass" list,
  // all in one clean tree
  {
    const dir = makeRepo('rc-nearmiss-full');
    writeFile(dir, '.claude/FORGE_TASK_HISTORY.md', '# Task history\n');
    writeFile(dir, '.claude/FORGE_AGENT_LEDGER.md', '# Agent ledger\n');
    writeFile(dir, '.claude/FORGE_DECISIONS.md', '# Decisions\n');
    writeFile(dir, '.claude/forge-bin/forge-runs.ps1', '# runs\n');
    writeFile(dir, '.claude/forge-bin/forge-runs.sh', '#!/bin/sh\n');
    writeFile(dir, '.claude/forge-bin/forge-runinfo.cjs', '// runinfo\n');
    writeFile(dir, 'plugins/forge/skills/forge-prd/SKILL.md', '# forge-prd skill (plugin copy)\n');
    writeFile(dir, 'docs/forge-runs.md', '# forge-runs doc\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'more near misses + placeholders');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI: the full extra near-miss/placeholder set does NOT trigger a violation', res.status === 0, 'status=' + res.status + ' stdout=' + res.stdout);
  }

  // 6c) WP 1.9: the memory archives (FORGE_<NAME>_ARCHIVE_*.md), LESSONS.md and the Boss
  // lessons-archive files are private project memory without a placeholder: a tracked copy in the dist tree is a
  // violation, while the curated live placeholders next to them stay allowed (6/6b).
  {
    const dir = makeRepo('rc-archives');
    const archives = ['.claude/FORGE_MEMORY_ARCHIVE_2026-10.md', '.claude/FORGE_MEMORY_ARCHIVE_2026-10-24.md', '.claude/FORGE_TASK_HISTORY_ARCHIVE_2026-10.md',
      '.claude/FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md', '.claude/FORGE_DECISIONS_ARCHIVE_2026-10.md', '.claude/LESSONS.md', '.claude/agent-memory/build-boss/lessons-archive-2026-10-23.md'];
    for (const a of archives) writeFile(dir, a, '# private archive\n');
    writeFile(dir, '.claude/FORGE_DECISIONS.md', '# Decisions (placeholder)\n');
    writeFile(dir, '.claude/forge-bin/forge-memory-consolidate.cjs', '// the tool itself ships\n');
    writeFile(dir, 'docs/LESSONS.md', '# a public doc of that name outside .claude/ is not project memory\n');
    commitAll(dir, 'archives tracked by mistake');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI WP 1.9: a dist tree that tracks memory archives / LESSONS.md exits 3', res.status === 3, 'status=' + res.status + ' stdout=' + res.stdout);
    tFn('CLI WP 1.9: every archive is reported, the placeholder, the tool and docs/LESSONS.md are not', () => {
      const paths = JSON.parse(res.stdout).violations.map((v) => v.path).sort();
      assert.deepStrictEqual(paths, archives.slice().sort());
    });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort: this block cleans its own fixture */ }
  }
  tFn('WP 1.9: in the REAL config the archives are dist_forbidden and never_sync, the live placeholders stay allowed in dist', () => {
    const ex = RC.loadExclusions(REAL_CONFIG);
    const forbidden = (p) => ex.dist_forbidden.some((x) => x.re.test(p));
    for (const p of ['.claude/FORGE_TASK_HISTORY_ARCHIVE_2026-10.md', '.claude/FORGE_AGENT_LEDGER_ARCHIVE_2026-10.md', '.claude/FORGE_DECISIONS_ARCHIVE_2026-10.md', '.claude/FORGE_MEMORY_ARCHIVE_2026-10-24.md', '.claude/LESSONS.md', '.claude/agent-memory/test-boss/lessons-archive-2026-10-23.md']) assert.ok(forbidden(p), 'dist_forbidden must match ' + p);
    for (const p of ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md', '.claude/FORGE_DECISIONS.md', '.claude/forge-bin/forge-memory-consolidate.cjs', '.claude/skills/forge-scribe/SKILL.md']) assert.ok(!forbidden(p), 'must stay allowed in dist: ' + p);
    for (const inner of ['FORGE_TASK_HISTORY_ARCHIVE_2026-10.md', 'FORGE_AGENT_LEDGER_ARCHIVE_2026-10.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.md', 'FORGE_MEMORY_ARCHIVE_2026-10-24.md', 'agent-memory/verify-boss/lessons-archive-2026-10-23.md']) assert.ok(RC.isNeverSync(inner, ex), 'never_sync must match ' + inner);
  });

  // 7) W2-01 (Codex): dist_forbidden matches case-insensitively — an uppercase/mixed-case
  // variant of a forbidden path is the SAME folder on Windows and must be caught identically.
  {
    const dir = makeRepo('rc-caseinsensitive');
    writeFile(dir, '.CLAUDE/FORGE-RUNS/x/events.jsonl', '{}\n');
    writeFile(dir, '.Claude/Forge-Research/y.md', 'private\n');
    writeFile(dir, 'build.LOG', 'noisy\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'case-variant forbidden paths');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI W2-01: a case-variant forbidden tree exits 3', res.status === 3, 'status=' + res.status + ' stdout=' + res.stdout);
    tFn('CLI W2-01: all three case-variant paths are reported as violations', () => {
      const parsed = JSON.parse(res.stdout);
      const paths = parsed.violations.map((v) => v.path);
      assert.ok(paths.some((p) => /FORGE-RUNS/i.test(p) && /\.CLAUDE/i.test(p)), 'uppercase forge-runs path: ' + JSON.stringify(paths));
      assert.ok(paths.some((p) => /Forge-Research/i.test(p)), 'mixed-case forge-research path: ' + JSON.stringify(paths));
      assert.ok(paths.some((p) => /build\.LOG/i.test(p)), 'uppercase .LOG path: ' + JSON.stringify(paths));
    });
  }

  // 8) W2-02 (Codex): a private .claude/ subfolder nested at ANY depth (not just the release
  // root) must still be caught — a .claude tree copied under plugins/forge/, or a doubly-nested .claude.
  {
    const dir = makeRepo('rc-nesteddepth');
    writeFile(dir, 'plugins/forge/.claude/forge-runs/r/events.jsonl', '{}\n');
    writeFile(dir, '.claude/docs/example/.claude/forge-runs/r2/events.jsonl', '{}\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'nested private .claude folders');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI W2-02: a nested-depth .claude/forge-runs/ tree exits 3', res.status === 3, 'status=' + res.status + ' stdout=' + res.stdout);
    tFn('CLI W2-02: both nested paths are reported as violations', () => {
      const parsed = JSON.parse(res.stdout);
      const paths = parsed.violations.map((v) => v.path);
      assert.ok(paths.includes('plugins/forge/.claude/forge-runs/r/events.jsonl'), JSON.stringify(paths));
      assert.ok(paths.includes('.claude/docs/example/.claude/forge-runs/r2/events.jsonl'), JSON.stringify(paths));
    });
  }

  // 9) W2-02 regression guard: a legitimate nested-.claude template file (the real shape the public repo
  // ships under global-install/.claude/...) must NOT be caught by the any-depth fix.
  {
    const dir = makeRepo('rc-nesteddepth-legit');
    writeFile(dir, 'global-install/.claude/commands/forge.md', '# forge command template\n');
    writeFile(dir, 'global-install/.claude/skills/forge-core/SKILL.md', '# forge-core skill template\n');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'legit nested .claude template content');
    const res = runCLI(['--dist', dir]);
    t('CLI W2-02: legitimate nested .claude template files are NOT flagged', res.status === 0, 'status=' + res.status + ' stdout=' + res.stdout);
  }

  // 10) a bad config (via --config) gives exit 1, never exit 3 or 0
  {
    const dir = makeRepo('rc-badconfig-dist');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'baseline');
    const badConfig = path.join(freshDir('rc-badconfig-cfg'), 'bad.json');
    fs.writeFileSync(badConfig, '{ this is not json', 'utf8');
    const res = runCLI(['--dist', dir, '--config', badConfig]);
    t('CLI: a broken config exits 1 (error), not 3 or 0', res.status === 1, 'status=' + res.status + ' stderr=' + res.stderr);
  }

  // 11) a missing --dist directory is also a clean exit-1 error, never a crash
  {
    const res = runCLI(['--dist', path.join(freshDir('rc-nodist'), 'does-not-exist')]);
    t('CLI: a missing --dist directory exits 1', res.status === 1, 'status=' + res.status + ' stderr=' + res.stderr);
  }

  // ---------------------------------------------------------------------------------------------------
  // enumeration failures must surface as a real error, never a clean verdict.
  // ---------------------------------------------------------------------------------------------------

  // 12) a REAL git error that is NOT "not a git repository" (a bogus .git FILE — confirmed above by
  // direct probing to produce "fatal: invalid gitfile format", not the "not a git repository" message)
  // must make the CLI exit 1 with a clear message, never fall back to the walk and never report clean.
  {
    const dir = freshDir('rc-badgitfile');
    writeFile(dir, 'readme.md', '# ok\n');
    fs.writeFileSync(path.join(dir, '.git'), 'not a real gitdir reference\n', 'utf8');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI W2-03: a bogus .git file is a real git ERROR, not a clean/violation verdict', res.status === 1, 'status=' + res.status + ' stdout=' + res.stdout + ' stderr=' + res.stderr);
  }

  // 13) a confirmed git repo whose INDEX is corrupt: `rev-parse --is-inside-work-tree` still says true,
  // but `git ls-files` itself fails — this must also be a real error, never a silent "0 files checked, ok".
  {
    const dir = makeRepo('rc-corruptindex');
    writeFile(dir, 'readme.md', '# ok\n');
    commitAll(dir, 'seed');
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'garbage not an index\n', 'utf8');
    const res = runCLI(['--dist', dir, '--json']);
    t('CLI W2-03: a corrupt git index is a real git ERROR, never a clean ok:true', res.status === 1, 'status=' + res.status + ' stdout=' + res.stdout + ' stderr=' + res.stderr);
  }
}

// ---------------------------------------------------------------------------------------------------
// W2-03 unit-level tests: checkDist()/listTrackedFiles() injection seams (opts.spawn / opts.readdir)
// prove the git-error-vs-non-git-repo distinction and the unreadable-directory case WITHOUT depending on
// real git corruption or real filesystem permission errors (hermetic, deterministic).
// ---------------------------------------------------------------------------------------------------
if (RC) {
  const ex2 = RC.loadExclusions(REAL_CONFIG);

  tFn('checkDist W2-03: a git failure that is NOT "not a git repository" is a real error, never a walk fallback', () => {
    const dir = freshDir('rc-fakegiterror');
    const fakeSpawn = (cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: unable to read config file .git/config\n', error: null };
      throw new Error('unexpected spawn call: ' + args.join(' '));
    };
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.ok(res.error, 'expected an error field: ' + JSON.stringify(res));
    assert.ok(!/not a git repository/i.test(res.error), 'must not be misclassified as a confirmed non-repo: ' + res.error);
  });

  // Codex verification (W2-03 partly fixed): a broken git-dir REFERENCE also says "not a git repository",
  // but with a path ("not a git repository: <path>") instead of "(or any of the parent directories)".
  tFn('checkDist W2-03v: "not a git repository: <path>" (a broken git-dir reference) is an error, never a walk', () => {
    const dir = freshDir('rc-brokenref-injected');
    const fakeSpawn = (cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: not a git repository: C:/missing/.git/worktrees/x\n', error: null };
      throw new Error('unexpected spawn call: ' + args.join(' '));
    };
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.ok(res.error, 'expected an error field: ' + JSON.stringify(res));
  });
  tFn('checkDist W2-03v: a folder with its own .git entry is never treated as a confirmed non-repo', () => {
    const dir = freshDir('rc-gitentry-nonrepo-msg');
    fs.mkdirSync(path.join(dir, '.git'));
    const fakeSpawn = (cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', error: null };
      throw new Error('unexpected spawn call: ' + args.join(' '));
    };
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.ok(res.error, 'expected an error field: ' + JSON.stringify(res));
  });
  tFn('CLI W2-03v: a real .git file pointing at a missing git dir exits 1 (never clean)', () => {
    const dir = freshDir('rc-brokenref-real');
    fs.writeFileSync(path.join(dir, 'readme.md'), '# ok\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ' + path.join(os.tmpdir(), 'forge-rc-no-such-gitdir-' + process.pid) + '\n', 'utf8');
    const res = runCLI(['--dist', dir, '--json']);
    assert.strictEqual(res.status, 1, 'status=' + res.status + ' stdout=' + res.stdout + ' stderr=' + res.stderr);
  });

  tFn('checkDist W2-03: git spawn itself failing (e.g. git not installed) is a real error', () => {
    const dir = freshDir('rc-fakegitmissing');
    const fakeSpawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT: spawn git ENOENT') });
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.ok(res.error, 'expected an error field: ' + JSON.stringify(res));
  });

  tFn('checkDist W2-03: a confirmed non-git repo still falls back to the walk (regression guard)', () => {
    const dir = freshDir('rc-confirmednongit');
    writeFile(dir, 'readme.md', '# ok\n');
    const fakeSpawn = (cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', error: null };
      throw new Error('unexpected spawn call for a confirmed non-repo: ' + args.join(' '));
    };
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn });
    assert.strictEqual(res.method, 'walk', JSON.stringify(res));
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(!res.error, JSON.stringify(res));
  });

  tFn('checkDist W2-03: an unreadable directory during the walk is INCOMPLETE — a named error, not a silent skip', () => {
    const dir = freshDir('rc-unreadabledir');
    writeFile(dir, 'readme.md', '# ok\n');
    fs.mkdirSync(path.join(dir, 'secretdir'));
    writeFile(dir, 'secretdir/.claude/forge-runs/x/events.jsonl', '{}\n');
    const fakeSpawn = (cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', error: null };
      throw new Error('unexpected spawn call: ' + args.join(' '));
    };
    const fakeReaddir = (d) => {
      if (path.basename(d) === 'secretdir') throw new Error('EACCES: permission denied, scandir \'' + d + '\'');
      return fs.readdirSync(d, { withFileTypes: true });
    };
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn, readdir: fakeReaddir });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.ok(res.error, 'expected an error field: ' + JSON.stringify(res));
    assert.ok(res.error.includes('secretdir'), 'error should name the unreadable path: ' + res.error);
  });

  tFn('checkDist W2-03: the error path never reports files_checked/violations as a false clean pass', () => {
    const dir = freshDir('rc-errorshape');
    const fakeSpawn = (cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: unable to read config file .git/config\n', error: null };
      throw new Error('unexpected spawn call: ' + args.join(' '));
    };
    const res = RC.checkDist(dir, ex2, { spawn: fakeSpawn });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.strictEqual(res.files_checked, 0, 'an error must report 0 files_checked, not a vacuous count: ' + JSON.stringify(res));
    assert.deepStrictEqual(res.violations, [], 'an error must not also claim violations were enumerated');
  });

  // Verify Boss residual: a check that found 0 tracked files is technically clean but says nothing —
  // it carries a plain note (the JSON and the human output) so pointing --dist at the wrong folder is visible.
  tFn('checkDist: 0 tracked files gives ok with a plain note, never a silent "clean"', () => {
    const dir = makeRepo('rc-zerofiles');
    const res = RC.checkDist(dir, ex2);
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.files_checked, 0, JSON.stringify(res));
    assert.ok(typeof res.note === 'string' && /0 tracked files/.test(res.note), 'expected a note: ' + JSON.stringify(res));
    const cli = runCLI(['--dist', dir]);
    assert.strictEqual(cli.status, 0, 'status=' + cli.status);
    assert.ok(/0 tracked files/.test(cli.stdout), 'the human output must show the note: ' + cli.stdout);
  });
  tFn('checkDist: a normal tree carries no zero-file note', () => {
    const dir = makeRepo('rc-somefiles');
    fs.writeFileSync(path.join(dir, 'readme.md'), '# ok\n', 'utf8');
    commitAll(dir, 'seed');
    const res = RC.checkDist(dir, ex2);
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(!res.note, 'unexpected note: ' + JSON.stringify(res));
  });
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
