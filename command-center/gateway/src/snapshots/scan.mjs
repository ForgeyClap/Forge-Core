// File listing and path safety for the snapshot safety net (WP B3b).
//
// What a snapshot covers: every regular file git would see in the project folder — tracked files
// plus untracked files that are not ignored by .gitignore / info/exclude / core.excludesFile —
// minus the excluded folder names (node_modules, dist, build, .next, .git by default), minus files
// over the size limit, minus the gateway's own data folder when it sits inside the project.
// Everything else that exists at snapshot time (ignored files, symlinks, nested git repositories,
// large files) is RECORDED so undo never mistakes it for something the turn created: undo neither
// restores nor deletes it.
import fs from 'node:fs';
import path from 'node:path';
import { runGit, splitNul, SnapshotError } from './git-runner.mjs';

export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 50_000;
export const DEFAULT_EXCLUDE_DIRS = Object.freeze(['node_modules', 'dist', 'build', '.next', '.git']);
// Above this many folders the empty-folder record is dropped and undo simply never prunes folders.
const MAX_WALK_DIRS = 100_000;

const EXCLUDE_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;
const IS_WIN = process.platform === 'win32';

/** Validate and normalise the excluded folder names; '.git' is always included. */
export function normalizeExcludeDirs(list) {
  if (list === undefined) return [...DEFAULT_EXCLUDE_DIRS];
  if (!Array.isArray(list)) throw new SnapshotError('INVALID_INPUT', 'excludeDirs must be an array of folder names');
  const out = new Set(['.git']);
  for (const name of list) {
    if (typeof name !== 'string' || !EXCLUDE_NAME_RE.test(name)) {
      throw new SnapshotError('INVALID_INPUT', `excludeDirs entry is not a plain folder name: ${String(name).slice(0, 80)}`);
    }
    out.add(name);
  }
  return [...out];
}

/** Compare key for paths: case-folded on Windows, where the file system is case-insensitive. */
export function pathKey(p) {
  return IS_WIN ? p.toLowerCase() : p;
}

/**
 * A git-relative path that is safe to join onto the project folder: forward slashes only, no
 * empty/'.'/'..' segment, and on Windows no backslash, colon (drive or alternate data stream) or
 * segment ending in a dot or space (Windows strips those, which would alias another name).
 */
export function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.startsWith('/')) return false;
  if (IS_WIN && /[\\:]/.test(rel)) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !(IS_WIN && /[. ]$/.test(seg)));
}

/** True when `target` is `base` itself or lies below it (both absolute, already resolved). */
export function isWithin(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Absolute path of a validated relative path; throws if it would leave the project folder. */
export function absPathOf(projectDir, rel) {
  const abs = path.resolve(projectDir, ...rel.split('/'));
  if (abs === projectDir || !isWithin(projectDir, abs)) {
    throw new SnapshotError('SNAPSHOT_CORRUPT', `path escapes the project folder: ${rel.slice(0, 200)}`);
  }
  return abs;
}

/** Git file mode for a regular file: the executable bit only matters off Windows. */
export function fileModeOf(stat) {
  return !IS_WIN && (stat.mode & 0o111) ? '100755' : '100644';
}

/** True when `rel` equals or sits below one of the relative prefix keys. */
function underAnyPrefix(key, prefixKeys) {
  for (const prefix of prefixKeys) {
    if (key === prefix || key.startsWith(prefix + '/')) return true;
  }
  return false;
}

/**
 * Static filters shared by every listing. keepFile: a safe path that is not under an excluded
 * folder name (only folder segments count, so a FILE named "build" is kept) and not under the data
 * folder. keepFolder: the same test for a folder path, where the last segment is a folder too.
 */
function makeStaticFilter(excludeDirs, excludedPrefixKeys) {
  const excludeKeys = new Set(excludeDirs.map(pathKey));
  const check = (rel, folderSegments) => {
    if (!isSafeRelPath(rel)) return false;
    const segments = rel.split('/');
    for (let i = 0; i < folderSegments(segments); i += 1) {
      if (excludeKeys.has(pathKey(segments[i]))) return false;
    }
    return !underAnyPrefix(pathKey(rel), excludedPrefixKeys);
  };
  return {
    keepFile: (rel) => check(rel, (segments) => segments.length - 1),
    keepFolder: (rel) => check(rel, (segments) => segments.length),
  };
}

const excludeArgs = (excludeDirs) => excludeDirs.map((name) => `--exclude=${name}/`);
const stripSlash = (entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ignored entries present at snapshot time: ignored files by name, and folders that are ignored
 * themselves as 'folder/'. A folder git only reports because everything inside it is ignored is
 * not recorded as a whole (a new file the turn puts there must still count as new).
 */
async function listIgnoredEntries(prefixArgs, limits, filter) {
  const { stdout } = await runGit([...prefixArgs, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', ...excludeArgs(limits.excludeDirs)], { label: 'ls-files' });
  const files = [];
  const dirs = [];
  for (const entry of splitNul(stdout)) {
    const isDir = entry.endsWith('/');
    const rel = stripSlash(entry);
    if (isDir ? !filter.keepFolder(rel) : !filter.keepFile(rel)) continue; // excluded folders stay protected statically
    (isDir ? dirs : files).push(rel);
  }
  let ignoredDirs = [];
  if (dirs.length > 0) {
    const res = await runGit([...prefixArgs, 'check-ignore', '-z', '--stdin', '--no-index'], { label: 'check-ignore', input: dirs.join('\0') + '\0', okCodes: [0, 1] });
    ignoredDirs = splitNul(res.stdout).map((d) => stripSlash(d) + '/');
  }
  return [...files, ...ignoredDirs].sort(byString);
}

/** Folders with nothing in them, so undo can tell them apart from folders the turn created. */
function findEmptyDirs(projectDir, filter, skipPrefixKeys) {
  const empty = [];
  const stack = [''];
  let visited = 0;
  while (stack.length > 0) {
    const rel = stack.pop();
    visited += 1;
    if (visited > MAX_WALK_DIRS) return null;
    let entries;
    try {
      entries = fs.readdirSync(rel ? absPathOf(projectDir, rel) : projectDir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: undo will simply not prune below it
    }
    if (rel && entries.length === 0) { empty.push(rel); continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // links are never followed
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (!filter.keepFolder(child) || underAnyPrefix(pathKey(child), skipPrefixKeys)) continue;
      stack.push(child);
    }
  }
  return empty.sort(byString);
}

/**
 * Everything a snapshot needs to know about the folder right now:
 * { files: [{path, abs, size, mode}], skipped: [{path, reason}], ignored: [string], emptyDirs: [string]|null }.
 * Tracked files come from the user's own index (read only); the user index is never written.
 */
export async function scanForSnapshot(ctx, prefixArgs, limits) {
  const filter = makeStaticFilter(limits.excludeDirs, ctx.excludedPrefixKeys);
  const { stdout } = await runGit([...prefixArgs, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', ...excludeArgs(limits.excludeDirs)], { label: 'ls-files' });
  const files = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of splitNul(stdout)) {
    const isDir = entry.endsWith('/'); // an untracked nested git repository
    const rel = stripSlash(entry);
    if (seen.has(rel) || !(isDir ? filter.keepFolder(rel) : filter.keepFile(rel))) continue;
    seen.add(rel);
    if (isDir) { skipped.push({ path: rel, reason: 'nested-repo' }); continue; }
    const abs = absPathOf(ctx.projectDir, rel);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // in the index but deleted from disk: nothing to capture
    }
    if (stat.isSymbolicLink()) skipped.push({ path: rel, reason: 'symlink' });
    else if (stat.isDirectory()) skipped.push({ path: rel, reason: 'nested-repo' }); // a submodule
    else if (!stat.isFile()) continue;
    else if (stat.size > limits.maxFileBytes) skipped.push({ path: rel, reason: 'too-large' });
    else files.push({ path: rel, abs, size: stat.size, mode: fileModeOf(stat) });
  }
  files.sort((a, b) => byString(a.path, b.path));
  const ignored = await listIgnoredEntries(prefixArgs, limits, filter);
  const skipPrefixKeys = [
    ...ignored.filter((e) => e.endsWith('/')).map((e) => pathKey(stripSlash(e))),
    ...skipped.filter((s) => s.reason === 'nested-repo').map((s) => pathKey(s.path)),
  ];
  return { files, skipped, ignored, emptyDirs: findEmptyDirs(ctx.projectDir, filter, skipPrefixKeys) };
}

/**
 * Predicate: was this path recorded at snapshot time as something outside the snapshot
 * (skipped file, ignored entry, nested repository)? Such a path is never "created by the turn".
 */
export function makeProtectedCheck(meta) {
  const exact = new Set();
  const prefixes = [];
  for (const s of meta.skipped) {
    if (s.reason === 'nested-repo') prefixes.push(pathKey(s.path));
    else exact.add(pathKey(s.path));
  }
  for (const e of meta.ignored) {
    if (e.endsWith('/')) prefixes.push(pathKey(stripSlash(e)));
    else exact.add(pathKey(e));
  }
  return (rel) => {
    const key = pathKey(rel);
    return exact.has(key) || underAnyPrefix(key, prefixes);
  };
}

/**
 * Regular-file candidates visible NOW that are not ignored, listed against an empty temporary
 * index so tracked and untracked files are treated alike. Used to find files the turn created.
 */
export async function listCurrentFiles(ctx, prefixArgs, meta) {
  const env = ctx.emptyIndexEnv();
  const { stdout } = await runGit([...prefixArgs, 'ls-files', '-z', '--others', '--exclude-standard', ...excludeArgs(meta.excludeDirs)], { label: 'ls-files', env });
  const filter = makeStaticFilter(meta.excludeDirs, ctx.excludedPrefixKeys);
  return [...new Set(splitNul(stdout).filter((rel) => !rel.endsWith('/') && filter.keepFile(rel)))];
}
