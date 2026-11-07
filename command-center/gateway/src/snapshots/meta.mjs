// Snapshot commit format for the safety net (WP B3b): the metadata line in the commit message,
// the tree listing, blob ids and fast-import path quoting.
//
// The metadata travels inside the snapshot commit itself (one JSON line), so a snapshot needs no
// side file that could get out of step with the ref.
import { createHash } from 'node:crypto';
import { splitNul, SnapshotError } from './git-runner.mjs';
import { isSafeRelPath, normalizeExcludeDirs } from './scan.mjs';

const META_PREFIX = 'forge-snapshot-meta: ';

/** Git blob id of `buffer`, using the hash family of `likeSha` (sha1: 40 hex, sha256: 64 hex). */
export function gitBlobId(buffer, likeSha) {
  const algo = likeSha && likeSha.length === 64 ? 'sha256' : 'sha1';
  return createHash(algo).update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

/** Commit message carrying the snapshot metadata as one JSON line. */
export function encodeCommitMessage(turnId, meta) {
  return `forge snapshot ${turnId}\n\n${META_PREFIX}${JSON.stringify(meta)}\n`;
}

const isSafeEntry = (entry) => typeof entry === 'string' && isSafeRelPath(entry.endsWith('/') ? entry.slice(0, -1) : entry);

/** Parse and validate the metadata out of `git cat-file commit` output. */
export function decodeCommitMeta(commitText) {
  const bodyStart = commitText.indexOf('\n\n');
  const message = bodyStart === -1 ? '' : commitText.slice(bodyStart + 2);
  const line = message.split('\n').find((l) => l.startsWith(META_PREFIX));
  const corrupt = (why) => new SnapshotError('SNAPSHOT_CORRUPT', `snapshot metadata is unusable: ${why}`);
  if (!line) throw corrupt('no metadata line');
  let meta;
  try {
    meta = JSON.parse(line.slice(META_PREFIX.length));
  } catch {
    throw corrupt('metadata is not valid JSON');
  }
  if (!meta || meta.v !== 1) throw corrupt('unknown metadata version');
  if (!Number.isFinite(meta.createdAt)) throw corrupt('createdAt missing');
  if (!Number.isSafeInteger(meta.maxFileBytes) || meta.maxFileBytes <= 0) throw corrupt('maxFileBytes missing');
  if (!Array.isArray(meta.skipped) || !meta.skipped.every((s) => s && isSafeRelPath(s.path) && typeof s.reason === 'string')) {
    throw corrupt('skipped list malformed');
  }
  if (!Array.isArray(meta.ignored) || !meta.ignored.every(isSafeEntry)) throw corrupt('ignored list malformed');
  if (meta.emptyDirs !== null && !(Array.isArray(meta.emptyDirs) && meta.emptyDirs.every((d) => typeof d === 'string' && isSafeRelPath(d)))) {
    throw corrupt('emptyDirs malformed');
  }
  let excludeDirs;
  try {
    excludeDirs = normalizeExcludeDirs(meta.excludeDirs);
  } catch {
    throw corrupt('excludeDirs malformed');
  }
  return {
    v: 1,
    createdAt: meta.createdAt,
    storage: meta.storage,
    maxFileBytes: meta.maxFileBytes,
    excludeDirs,
    skipped: meta.skipped,
    ignored: meta.ignored,
    emptyDirs: meta.emptyDirs,
  };
}

/**
 * Parse `git ls-tree -r -l -z <commit>` into a Map path -> {mode, sha, size}. Only plain file
 * blobs are valid in a snapshot; anything else (a symlink, a gitlink, an unsafe path) means the
 * ref was not written by this module and undo must refuse it.
 */
export function parseTree(buffer) {
  const entries = new Map();
  for (const record of splitNul(buffer)) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755') || !isSafeRelPath(match[5])) {
      throw new SnapshotError('SNAPSHOT_CORRUPT', `unexpected snapshot entry: ${record.slice(0, 160)}`);
    }
    entries.set(match[5], { mode: match[1], sha: match[3], size: Number(match[4]) });
  }
  return entries;
}

/** C-style quoted path for a fast-import `M` line (always quoted, so any name is safe). */
export function quoteFastImportPath(rel) {
  let out = '"';
  for (const ch of rel) {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (code < 0x20 || code === 0x7f) out += '\\' + code.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + '"';
}
