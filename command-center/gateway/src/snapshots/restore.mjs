// File-system side of "Ongedaan maken" (WP B3b): write snapshot bytes back and remove files the
// turn created, without ever writing or deleting outside the project folder.
//
// Every write first proves that the nearest existing parent folder really lies inside the project
// (realpath), so a symlink or junction the turn left behind can never redirect a restore to, for
// example, C:\Windows. Nothing here throws for a single file: problems come back as error codes so
// undo can report exactly which files it could not put back.
import fs from 'node:fs';
import path from 'node:path';
import { absPathOf, isWithin, pathKey } from './scan.mjs';
import { gitBlobId } from './meta.mjs';

const IS_WIN = process.platform === 'win32';

function lstatOrNull(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** realpath of the nearest existing ancestor of `absDir` must lie inside the project. */
function nearestExistingIsInside(projectDir, absDir) {
  let dir = absDir;
  while (isWithin(projectDir, dir)) {
    if (lstatOrNull(dir)) return isWithin(projectDir, fs.realpathSync.native(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/** mkdir -p for a folder below the project, refusing to create anything through a link. */
function makeFolderInside(projectDir, absDir) {
  if (!nearestExistingIsInside(projectDir, absDir)) return 'OUTSIDE_PROJECT';
  fs.mkdirSync(absDir, { recursive: true });
  return isWithin(projectDir, fs.realpathSync.native(absDir)) ? null : 'OUTSIDE_PROJECT';
}

function applyMode(abs, mode) {
  const current = fs.statSync(abs).mode & 0o777;
  const wanted = mode === '100755' ? current | 0o111 : current & ~0o111;
  if (wanted !== current) fs.chmodSync(abs, wanted);
}

/**
 * Write one snapshot blob back. Returns null on success, or an error code string
 * (EISDIR, OUTSIDE_PROJECT, CORRUPT_BLOB, EBUSY, ...) when this path must be retried or reported.
 */
export function writeRestored(projectDir, rel, entry, buffer) {
  if (gitBlobId(buffer, entry.sha) !== entry.sha) return 'CORRUPT_BLOB';
  try {
    const abs = absPathOf(projectDir, rel);
    const folderError = makeFolderInside(projectDir, path.dirname(abs));
    if (folderError) return folderError;
    const existing = lstatOrNull(abs);
    if (existing && existing.isDirectory()) return 'EISDIR';
    if (existing && existing.isSymbolicLink()) fs.unlinkSync(abs); // never write through a link
    try {
      fs.writeFileSync(abs, buffer);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      fs.chmodSync(abs, 0o666); // a read-only file left by the turn: make it writable once, then retry
      fs.writeFileSync(abs, buffer);
    }
    if (!IS_WIN) applyMode(abs, entry.mode);
    return null;
  } catch (err) {
    return err.code || 'WRITE_FAILED';
  }
}

/**
 * pathKey set of every folder that existed at snapshot time as far as the snapshot knows: the
 * folders holding a snapshot file plus the recorded empty folders. Those are never pruned.
 */
export function knownFolderKeys(entries, emptyDirs) {
  const keys = new Set();
  const addWithParents = (rel, includeSelf) => {
    const segments = rel.split('/');
    const last = includeSelf ? segments.length : segments.length - 1;
    for (let i = 1; i <= last; i += 1) keys.add(pathKey(segments.slice(0, i).join('/')));
  };
  for (const rel of entries.keys()) addWithParents(rel, false);
  for (const rel of emptyDirs || []) addWithParents(rel, true);
  return keys;
}

/**
 * After removing a file, remove the folders above it that the turn created and left empty.
 * Returns null, or the error code that stopped pruning (the file itself is already gone, so an
 * empty folder left behind is reported by the caller but does not count as a failed undo).
 */
function pruneEmptyParents(projectDir, rel, keepFolderKeys) {
  const segments = rel.split('/');
  segments.pop();
  try {
    while (segments.length > 0) {
      const dirRel = segments.join('/');
      if (keepFolderKeys.has(pathKey(dirRel))) return null;
      const abs = absPathOf(projectDir, dirRel);
      const stat = lstatOrNull(abs);
      if (!stat || !stat.isDirectory() || fs.readdirSync(abs).length > 0) return null;
      fs.rmdirSync(abs);
      segments.pop();
    }
    return null;
  } catch (err) {
    return err.code || 'PRUNE_FAILED';
  }
}

function unlinkFile(abs) {
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    fs.chmodSync(abs, 0o666); // read-only flag set by the turn: clear it once, then retry
    fs.unlinkSync(abs);
  }
}

/**
 * Remove files the turn created. Adds each removed path to `done`; records failures in `failed`
 * (Map path -> code) and folders that could not be pruned in `leftFolders` (Map path -> code).
 * Only regular files are removed, never folders with content or symlinks. With `keepFolderKeys`
 * null (the empty-folder record was too large to keep) no folder is pruned at all.
 */
export function removeCreatedFiles(projectDir, rels, { keepFolderKeys, done, failed, leftFolders }) {
  for (const rel of rels) {
    try {
      const abs = absPathOf(projectDir, rel);
      const stat = lstatOrNull(abs);
      if (!stat || !stat.isFile()) continue;
      if (!isWithin(projectDir, fs.realpathSync.native(path.dirname(abs)))) {
        failed.set(rel, 'OUTSIDE_PROJECT');
        continue;
      }
      unlinkFile(abs);
      done.add(rel);
      if (!keepFolderKeys) continue;
      const pruneError = pruneEmptyParents(projectDir, rel, keepFolderKeys);
      if (pruneError) leftFolders.set(path.posix.dirname(rel), pruneError);
    } catch (err) {
      failed.set(rel, err.code || 'REMOVE_FAILED');
    }
  }
}

/** Recreate recorded empty folders the turn removed. Problems go to `leftFolders`. */
export function recreateEmptyDirs(projectDir, emptyDirs, leftFolders) {
  for (const rel of emptyDirs || []) {
    try {
      const abs = absPathOf(projectDir, rel);
      if (lstatOrNull(abs)) continue;
      const error = makeFolderInside(projectDir, abs);
      if (error) leftFolders.set(rel, error);
    } catch (err) {
      leftFolders.set(rel, err.code || 'MKDIR_FAILED');
    }
  }
}
