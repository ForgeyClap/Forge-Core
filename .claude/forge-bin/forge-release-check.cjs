#!/usr/bin/env node
'use strict';
/**
 * forge-release-check.cjs — (prd-w2-discipline). The rule that keeps private data out of
 * the public Forge release used to live only in a gitignored scratch script that a fresh checkout could
 * never run or re-check. This file makes that rule a real, versioned, zero-dependency tool:
 *
 *   - loadExclusions(configPath)  reads+validates .claude/config/orchestration/release-exclusions.json
 *     (or an injected path, for tests): every pattern in `never_sync` and `dist_forbidden` is compiled
 *     to a real RegExp up front, so a broken config fails loudly and immediately, never silently later.
 *   - isNeverSync(relUnderClaude, ex)  answers "does the SYNC step skip this path" for a path relative
 *     to .claude/ (used by the release sync script itself — M6 wiring, not this ticket).
 *   - listTrackedFiles(dir)  lists every file actually TRACKED in a release tree: `git ls-files` when
 *     the directory is a git repository, otherwise an honest recursive walk (skipping `.git` and
 *     `node_modules`, never following a symlink) — and always says which method it used.
 *   - checkDist(dir, ex)  cross-references every tracked file against `dist_forbidden` and reports every
 *     violation.
 *
 * CLI: `node forge-release-check.cjs --dist <dir> [--json] [--config <file>]`
 *   exit 0  — clean (no forbidden path tracked)
 *   exit 3  — one or more forbidden paths are tracked; each one is named
 *   exit 1  — an error (unreadable/invalid config, a pattern that does not compile, or a missing --dist
 *             directory) — never a silent pass and never confused with a real violation (3).
 *
 * Only TRACKED files count: an untracked forbidden-looking file sitting in a git working tree was never
 * going to ship in a `git archive`/clone-based release, so flagging it would just be noise the owner
 * cannot act on by removing it from the release (it isn't in the release).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** defaultConfigPath() -> the config this tool ships beside itself (.claude/forge-bin/.. -> config/
 *  orchestration/release-exclusions.json). Resolved relative to THIS file's own location, never to the
 *  --dist tree being checked or to the doctor's `root`, so the rule is always the one this install
 *  actually ships, regardless of what directory is being audited. */
function defaultConfigPath() {
  return path.join(__dirname, '..', 'config', 'orchestration', 'release-exclusions.json');
}

/** normalizeSlashes(p) -> p with every backslash turned into '/', so a pattern written with a forward
 *  slash matches a path handed in Windows style (either from fs on win32 or a caller passing a raw
 *  Windows-relative path) exactly the same as one already using '/'. */
function normalizeSlashes(p) {
  return String(p).split('\\').join('/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/** loadExclusions(configPath) -> {schema, note, sync_folders, never_sync, dist_forbidden, path}
 *  never_sync/dist_forbidden are arrays of {source, re}. Throws a clear, specific Error on: an unreadable
 *  file, invalid JSON, a missing/non-array required list, or any pattern string that fails to compile as
 *  a RegExp — fail loud, never fail quiet, because a config this tool cannot parse must never be treated
 *  as "nothing is forbidden". */
function loadExclusions(configPath) {
  const p = configPath || defaultConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error('release-exclusions config unreadable at ' + p + ': ' + e.message);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('release-exclusions config is not valid JSON (' + p + '): ' + e.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('release-exclusions config must be a JSON object (' + p + ')');
  }
  const REQUIRED_LISTS = ['sync_folders', 'never_sync', 'dist_forbidden'];
  for (const key of REQUIRED_LISTS) {
    if (!Array.isArray(data[key])) {
      throw new Error('release-exclusions config missing required array "' + key + '" (' + p + ')');
    }
  }
  // compiled with the 'i' flag — Windows treats `.CLAUDE/FORGE-RUNS` and
  // `.claude/forge-runs` as the identical folder, so a case-sensitive pattern was a real escape hatch for
  // private data under a differently-cased path. Applies to BOTH lists uniformly, since both are matched
  // against filesystem paths that are case-insensitive on the platform this tool most needs to protect.
  const compile = (list, label) => list.map((src, i) => {
    if (typeof src !== 'string' || !src.trim()) {
      throw new Error('release-exclusions config "' + label + '[' + i + ']" must be a non-empty string pattern (' + p + ')');
    }
    let re;
    try {
      re = new RegExp(src, 'i');
    } catch (e) {
      throw new Error('release-exclusions config "' + label + '[' + i + ']" (' + JSON.stringify(src) + ') does not compile: ' + e.message);
    }
    return { source: src, re };
  });
  return {
    schema: typeof data.schema === 'string' ? data.schema : null,
    note: typeof data.note === 'string' ? data.note : '',
    sync_folders: data.sync_folders.slice(),
    never_sync: compile(data.never_sync, 'never_sync'),
    dist_forbidden: compile(data.dist_forbidden, 'dist_forbidden'),
    path: p,
  };
}

/** isNeverSync(relUnderClaude, ex) -> the matching pattern's source string, or null when nothing in
 *  ex.never_sync matches. relUnderClaude is normalised (backslashes -> '/', a leading './' or '/'
 *  stripped) before matching, so a caller can pass either a POSIX-style or a Windows-style relative
 *  path and get the identical answer. */
function isNeverSync(relUnderClaude, ex) {
  const rel = normalizeSlashes(relUnderClaude);
  for (const pat of ex.never_sync) {
    if (pat.re.test(rel)) return pat.source;
  }
  return null;
}

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules']);
const DEFAULT_READDIR = (d) => fs.readdirSync(d, { withFileTypes: true });

/** walkTree(baseDir, relDir, out, readdirFn) -> appends every regular file's path (relative to baseDir,
 *  '/'-joined) found under relDir to out, and returns null on success. Skips .git/node_modules, and —
 *  "never follow symlinks" — skips ANY symlinked entry entirely (file or directory) rather than resolving
 *  through it, so a release tree can never leak something reachable only via a symlink outside the tree.
 *
 *  an unreadable directory used to be silently skipped, which could turn a
 *  real permissions problem into a false "0 files checked, clean" verdict. A walk that cannot fully
 *  enumerate the tree is INCOMPLETE, not clean: this now returns a descriptive error string (naming the
 *  path) the first time readdirFn throws, and stops recursing — the caller (listTrackedFiles) turns that
 *  into checkDist()'s {ok:false, error} shape instead of a silent partial result. */
function walkTree(baseDir, relDir, out, readdirFn) {
  const absDir = relDir ? path.join(baseDir, relDir) : baseDir;
  let entries;
  try {
    entries = readdirFn(absDir);
  } catch (e) {
    return 'cannot read directory "' + (relDir || '.') + '": ' + (e && e.message ? e.message : String(e));
  }
  for (const e of entries) {
    if (WALK_SKIP_DIRS.has(e.name)) continue;
    if (e.isSymbolicLink()) continue;
    const relPath = relDir ? relDir + '/' + e.name : e.name;
    if (e.isDirectory()) {
      const err = walkTree(baseDir, relPath, out, readdirFn);
      if (err) return err;
    } else if (e.isFile()) {
      out.push(relPath);
    }
  }
  return null;
}

/** gitRepoStatus(dir, spawnFn) -> {isRepo, reason} — W2-03 (Codex). Confirms with
 *  `git -C dir rev-parse --is-inside-work-tree` whether `dir` is CONFIRMED not a git repository, which is
 *  the ONLY case allowed to fall back to a filesystem walk:
 *    isRepo === true  -> dir genuinely is a git work tree (rev-parse exited 0 and printed "true")
 *    isRepo === false -> dir is CONFIRMED not a git repository (rev-parse's own stderr says so)
 *    isRepo === null  -> inconclusive: git itself is missing/crashed, or rev-parse failed for any OTHER
 *                        reason (corrupt index/config, unparseable output, a non-"not a git repository"
 *                        fatal error) — this is a real ERROR, never a silent walk fallback. `reason` names
 *                        it either way (null case) or is '' (the two confirmed cases need no reason). */
function gitRepoStatus(dir, spawnFn) {
  // LC_ALL/LANGUAGE=C: the message match below needs git's untranslated wording on any machine locale.
  const r = spawnFn('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C', LANGUAGE: 'C' }) });
  if (r.error) {
    return { isRepo: null, reason: 'git rev-parse --is-inside-work-tree failed to run: ' + r.error.message };
  }
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  if (r.status === 0 && stdout === 'true') return { isRepo: true, reason: '' };
  // a broken git-dir REFERENCE (a .git file pointing at a missing folder, a
  // dangling worktree) also says "not a git repository", but with ": <path>" instead of git's discovery
  // wording "(or any of the parent directories)". Only that discovery wording, in a folder with no .git
  // entry of its own, confirms a plain non-repository; every other shape is an enumeration error.
  if (r.status !== 0 && /not a git repository \(or any of the parent directories\)/i.test(stderr)) {
    let hasGitEntry = false;
    try { fs.lstatSync(path.join(dir, '.git')); hasGitEntry = true; } catch { hasGitEntry = false; }
    if (!hasGitEntry) return { isRepo: false, reason: '' };
    return { isRepo: null, reason: 'git says "not a git repository" but ' + path.join(dir, '.git') + ' exists — a broken or unreadable git folder, not a plain non-repository' };
  }
  return {
    isRepo: null,
    reason: 'git rev-parse --is-inside-work-tree gave an unrecognized result (exit ' + r.status + '): ' + (stderr || stdout || '(no output)'),
  };
}

/** listTrackedFiles(dir, opts) -> {files, method, error}. method is 'git' when `dir` is a CONFIRMED git
 *  work tree (uses `git ls-files -z` via spawnSync with an argument array, never a shell string), 'walk'
 *  when `dir` is CONFIRMED not a git repository (a real recursive filesystem walk, see walkTree()), or
 *  null when enumeration could not be completed at all. git ls-files already reports only TRACKED paths,
 *  which is exactly the contract checkDist() needs: an untracked file was never going into a real release.
 *
 *  previously ANY git failure (git missing, a corrupt index, a crash) fell back
 *  to the walk — the exact failure mode that let a git error PLUS a directory-read error compound into a
 *  silent {ok:true, files_checked:0}. Now the walk fallback is gated on gitRepoStatus() CONFIRMING "not a
 *  git repository"; any other git failure, and any walk failure, is returned as `error` and `files: null`
 *  — never a result the caller could mistake for a clean, complete enumeration.
 *
 *  opts.spawn / opts.readdir are TEST-ONLY injection points (default: real spawnSync / fs.readdirSync)
 *  so hermetic tests can simulate a git failure or an unreadable directory without corrupting a real git
 *  repo or relying on real filesystem permissions. */
function listTrackedFiles(dir, opts) {
  const o = opts || {};
  const spawnFn = o.spawn || spawnSync;
  const readdirFn = o.readdir || DEFAULT_READDIR;
  const status = gitRepoStatus(dir, spawnFn);
  if (status.isRepo === true) {
    const r = spawnFn('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
      const why = r.error ? r.error.message : 'exit ' + r.status + (r.stderr ? ' — ' + String(r.stderr).trim() : '');
      return { files: null, method: 'git', error: 'git ls-files failed in a confirmed git repository: ' + why };
    }
    const files = r.stdout.split('\0').filter(Boolean).map(normalizeSlashes);
    return { files, method: 'git', error: null };
  }
  if (status.isRepo === false) {
    const files = [];
    const walkError = walkTree(dir, '', files, readdirFn);
    if (walkError) {
      return { files: null, method: 'walk', error: walkError };
    }
    return { files: files.map(normalizeSlashes), method: 'walk', error: null };
  }
  // status.isRepo === null: a genuine git error — never silently fall back to the walk.
  return { files: null, method: null, error: 'git enumeration failed: ' + status.reason };
}

/** checkDist(dir, ex, opts) -> {ok, method, files_checked, violations:[{path, pattern}], error, note?} (note
 *  only when 0 tracked files were found: technically clean, but nothing was checked). Every
 *  tracked file is tested against every ex.dist_forbidden pattern; a file is reported once per match found
 *  (first match wins — the point is "this path is forbidden", not an exhaustive list of every pattern that
 *  agrees). W2-03 (Codex): when enumeration itself fails (listTrackedFiles returns an error),
 *  this returns {ok:false, error, files_checked:0, violations:[]} — a broken enumeration is reported as an
 *  explicit error, distinct from (and never mistaken for) "0 forbidden files found". opts is passed
 *  through to listTrackedFiles unchanged (test-only spawn/readdir injection — see its own doc comment). */
function checkDist(dir, ex, opts) {
  const { files, method, error } = listTrackedFiles(dir, opts);
  if (error) {
    return { ok: false, error, method, files_checked: 0, violations: [] };
  }
  const violations = [];
  for (const f of files) {
    for (const pat of ex.dist_forbidden) {
      if (pat.re.test(f)) {
        violations.push({ path: f, pattern: pat.source });
        break;
      }
    }
  }
  const result = { ok: violations.length === 0, method, files_checked: files.length, violations, error: null };
  // Verify Boss residual: 0 tracked files is technically clean but checked nothing — say so plainly,
  // so a --dist pointed at the wrong folder (or a subfolder with nothing tracked) is visible.
  if (files.length === 0) result.note = '0 tracked files were found in this folder, so nothing was checked — make sure --dist points at the root of the release tree';
  return result;
}

function parseArgs(argv) {
  const out = { dist: null, json: false, config: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') { out.dist = argv[++i]; }
    else if (a === '--json') { out.json = true; }
    else if (a === '--config') { out.config = argv[++i]; }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.dist) {
    console.error('Usage: forge-release-check.cjs --dist <dir> [--json] [--config <file>]');
    process.exit(1);
    return;
  }
  const absDist = path.resolve(args.dist);
  let st;
  try { st = fs.statSync(absDist); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    console.error('forge-release-check: --dist directory not found: ' + absDist);
    process.exit(1);
    return;
  }
  let ex;
  try {
    ex = loadExclusions(args.config);
  } catch (e) {
    console.error('forge-release-check: ' + e.message);
    process.exit(1);
    return;
  }
  const result = checkDist(absDist, ex);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.error) {
    console.error('forge-release-check: could not enumerate tracked files in ' + absDist + ': ' + result.error);
  } else if (result.ok) {
    console.log('forge-release-check: clean — ' + result.files_checked + ' tracked file(s) checked via ' + result.method + ' in ' + absDist);
    if (result.note) console.log('  note: ' + result.note);
  } else {
    console.log('forge-release-check: ' + result.violations.length + ' forbidden file(s) tracked in ' + absDist + ' (' + result.files_checked + ' checked via ' + result.method + ')');
    for (const v of result.violations) console.log('  ' + v.path + '  [' + v.pattern + ']');
  }
  // a broken enumeration (result.error) is its OWN exit code — 1, the same as
  // every other "this tool could not do its job" case (bad config, missing --dist) — never 3 (which means
  // "forbidden paths were found") and never 0 (which means "a complete, clean check ran").
  if (result.error) { process.exit(1); return; }
  process.exit(result.ok ? 0 : 3);
}

if (require.main === module) main(process.argv);

module.exports = { defaultConfigPath, loadExclusions, isNeverSync, listTrackedFiles, checkDist, normalizeSlashes };
