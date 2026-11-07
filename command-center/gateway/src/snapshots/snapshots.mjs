// Safety net for writing turns (WP B3b part 1): a snapshot of the project folder before every turn
// that may write, a list of what the turn changed, and "Ongedaan maken" (undo).
//
// Storage, chosen per project folder:
//   git-repo  the folder is the top level of a git repository. The snapshot is a commit on the
//             hidden ref refs/forge/snapshots/<turnId>, written with `git fast-import`, so the
//             user's HEAD, branches, index and working tree are never touched.
//   shadow    any other folder (including a sub-folder of a repository). A separate bare git dir
//             at <dataDir>/snapshots/<sha1(projectDir)>/ is used with --git-dir/--work-tree, so the
//             user's folder never gets a .git of its own.
// Contents are stored as raw bytes (no line-ending or filter conversion), so undo is byte-identical.
// This module never pushes, never fetches and never runs a user hook (plumbing commands only).
//
// Wiring (later, after A8): exec-lifecycle startExecution calls snapshotBeforeTurn before a writing
// turn and stores the turn id as the conversation record field `snapshotTurnId`; the answer card
// shows "<n> bestanden aangepast · Bekijken · Ongedaan maken" from listChanged; the undo button
// calls undo. A SnapshotError with code GIT_MISSING becomes the card GIT_MISSING_MESSAGE_NL.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runGit, gitEnv, readBlobs, writeChunk, SnapshotError, GIT_MISSING_MESSAGE_NL } from './git-runner.mjs';
import {
  DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES, DEFAULT_EXCLUDE_DIRS,
  normalizeExcludeDirs, pathKey, isWithin, absPathOf, fileModeOf,
  scanForSnapshot, makeProtectedCheck, listCurrentFiles,
} from './scan.mjs';
import { gitBlobId, encodeCommitMessage, decodeCommitMeta, parseTree, quoteFastImportPath } from './meta.mjs';
import { writeRestored, knownFolderKeys, removeCreatedFiles, recreateEmptyDirs } from './restore.mjs';

export { SnapshotError, GIT_MISSING_MESSAGE_NL, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES, DEFAULT_EXCLUDE_DIRS };

export const SNAPSHOT_REF_PREFIX = 'refs/forge/snapshots/';
// Matches the gateway's own turn ids (t-<base36>-<hex>) and UUIDs; always a valid ref component.
const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SNAPSHOT_IDENTITY = 'Forge Snapshot <forge-snapshot@localhost>';
// git refuses a --git-dir longer than PATH_MAX - 40 ("'$GIT_DIR' too big"); PATH_MAX is 260 on Windows.
const MAX_GIT_DIR_LENGTH = process.platform === 'win32' ? 220 : 4000;

function invalid(message) {
  return new SnapshotError('INVALID_INPUT', message);
}

function assertTurnId(turnId) {
  if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) throw invalid('turnId must be 1-128 letters, digits, "-" or "_", starting with a letter or digit');
  return turnId;
}

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${name} must be a positive integer`);
  return value;
}

/** realpath of `abs`, or of its nearest existing ancestor plus the missing tail. */
function realOrResolved(abs) {
  const tail = [];
  let dir = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...tail.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') throw invalid(`cannot resolve ${abs}: ${err.code}`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return abs;
    tail.push(path.basename(dir));
    dir = parent;
  }
}

async function isRepoTopLevel(projectDir) {
  const res = await runGit(['-C', projectDir, 'rev-parse', '--show-toplevel'], { label: 'rev-parse', okCodes: [0, 128] });
  if (res.code !== 0) {
    if (/dubious ownership/i.test(res.stderr)) throw new SnapshotError('GIT_FAILED', 'git refuses this folder because it belongs to another user (safe.directory)');
    return false;
  }
  const top = res.stdout.toString('utf8').trim();
  if (!top) return false;
  try {
    return pathKey(fs.realpathSync.native(path.resolve(top))) === pathKey(projectDir);
  } catch {
    return false; // git named a top level that does not resolve: treat the folder as plain
  }
}

async function resolveContext({ projectDir, dataDir }) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw invalid('projectDir must be an absolute path');
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw invalid('dataDir must be an absolute path');
  let real;
  try {
    real = fs.realpathSync.native(path.resolve(projectDir));
  } catch {
    throw invalid('projectDir does not exist');
  }
  if (!fs.statSync(real).isDirectory()) throw invalid('projectDir is not a folder');
  const dataReal = realOrResolved(path.resolve(dataDir));
  if (isWithin(dataReal, real)) throw invalid('the project folder lies inside the gateway data folder');
  // The gateway's own data folder inside the project (conversations, this snapshot store) is never
  // captured and never removed by undo.
  const excludedPrefixKeys = isWithin(real, dataReal) ? [pathKey(path.relative(real, dataReal).split(path.sep).join('/'))] : [];
  const storeRoot = path.join(dataReal, 'snapshots');
  return {
    projectDir: real,
    storeRoot,
    shadowDir: path.join(storeRoot, createHash('sha1').update(pathKey(real)).digest('hex')),
    excludedPrefixKeys,
    isRepoTop: await isRepoTopLevel(real),
    // A never-created index file: git reads it as empty, so ls-files treats every file as untracked.
    emptyIndexEnv: () => gitEnv({ GIT_INDEX_FILE: path.join(storeRoot, `empty-index-${randomUUID()}`) }),
  };
}

// All paths absolute: with -C, a relative --git-dir/--work-tree would resolve against the project.
const repoPrefix = (ctx) => ['-C', ctx.projectDir];
const shadowPrefix = (ctx) => ['-C', ctx.projectDir, '--git-dir', ctx.shadowDir, '--work-tree', ctx.projectDir];
const shadowExists = (ctx) => fs.existsSync(path.join(ctx.shadowDir, 'HEAD'));

async function ensureShadowStore(ctx) {
  if (ctx.shadowDir.length > MAX_GIT_DIR_LENGTH) {
    throw new SnapshotError('PATH_TOO_LONG', `the snapshot store path is ${ctx.shadowDir.length} characters; git accepts at most ${MAX_GIT_DIR_LENGTH}. Use a shorter data folder.`);
  }
  if (shadowExists(ctx)) return;
  fs.mkdirSync(ctx.storeRoot, { recursive: true });
  await runGit(['-c', 'init.defaultBranch=forge-snapshots', 'init', '--bare', '--quiet', '--template=', ctx.shadowDir], { label: 'init' });
  await runGit(['--git-dir', ctx.shadowDir, 'config', 'forge.projectDir', ctx.projectDir], { label: 'config' });
}

async function resolveCommit(prefix, ref) {
  const res = await runGit([...prefix, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { label: 'rev-parse', okCodes: [0, 1] });
  return res.code === 0 ? res.stdout.toString('utf8').trim() : null;
}

/** Stream every file into `git fast-import` as one root commit on `ref`. */
async function writeSnapshotCommit(prefix, ref, turnId, files, metaBase) {
  const skipped = [...metaBase.skipped];
  const captured = [];
  await runGit([...prefix, 'fast-import', '--quiet', '--done'], {
    label: 'fast-import',
    timeoutMs: 600_000,
    writeInput: async (stdin) => {
      for (const file of files) {
        let buffer;
        try {
          buffer = await fs.promises.readFile(file.abs);
        } catch (err) {
          skipped.push({ path: file.path, reason: `unreadable:${err.code || 'error'}` });
          continue;
        }
        if (buffer.length > metaBase.maxFileBytes) {
          skipped.push({ path: file.path, reason: 'too-large' });
          continue;
        }
        const mark = captured.length + 1;
        await writeChunk(stdin, `blob\nmark :${mark}\ndata ${buffer.length}\n`);
        await writeChunk(stdin, buffer);
        await writeChunk(stdin, '\n');
        captured.push({ path: file.path, mode: file.mode, mark });
      }
      const message = Buffer.from(encodeCommitMessage(turnId, { ...metaBase, skipped }), 'utf8');
      const seconds = Math.floor(metaBase.createdAt / 1000);
      await writeChunk(stdin, `commit ${ref}\ncommitter ${SNAPSHOT_IDENTITY} ${seconds} +0000\ndata ${message.length}\n`);
      await writeChunk(stdin, message);
      const lines = captured.map((c) => `M ${c.mode} :${c.mark} ${quoteFastImportPath(c.path)}\n`).join('');
      await writeChunk(stdin, `\n${lines}\ndone\n`);
    },
  });
  return { fileCount: captured.length, skipped };
}

/**
 * Take a snapshot of `projectDir` before turn `turnId` may write to it.
 * Options: maxFileBytes (default 50 MB), excludeDirs (default node_modules, dist, build, .next,
 * .git), maxFiles (default 50,000; above it TOO_MANY_FILES is thrown instead of a slow snapshot).
 * Returns { turnId, ref, commit, storage: 'git-repo'|'shadow', fileCount, skipped, createdAt }.
 */
export async function snapshotBeforeTurn({ projectDir, dataDir, turnId, maxFileBytes, excludeDirs, maxFiles } = {}) {
  assertTurnId(turnId);
  const limits = {
    maxFileBytes: positiveInt(maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes'),
    maxFiles: positiveInt(maxFiles, DEFAULT_MAX_FILES, 'maxFiles'),
    excludeDirs: normalizeExcludeDirs(excludeDirs),
  };
  const ctx = await resolveContext({ projectDir, dataDir });
  const storage = ctx.isRepoTop ? 'git-repo' : 'shadow';
  if (storage === 'shadow') await ensureShadowStore(ctx);
  const prefix = storage === 'shadow' ? shadowPrefix(ctx) : repoPrefix(ctx);
  const ref = SNAPSHOT_REF_PREFIX + turnId;
  if (await resolveCommit(prefix, ref)) throw new SnapshotError('SNAPSHOT_EXISTS', `a snapshot for turn ${turnId} already exists`);
  const createdAt = Date.now();
  const scan = await scanForSnapshot(ctx, prefix, limits);
  if (scan.files.length > limits.maxFiles) {
    throw new SnapshotError('TOO_MANY_FILES', `the project folder has ${scan.files.length} files; the snapshot limit is ${limits.maxFiles}`, { fileCount: scan.files.length });
  }
  const metaBase = {
    v: 1, createdAt, storage, maxFileBytes: limits.maxFileBytes, excludeDirs: limits.excludeDirs,
    skipped: scan.skipped, ignored: scan.ignored, emptyDirs: scan.emptyDirs,
  };
  const written = await writeSnapshotCommit(prefix, ref, turnId, scan.files, metaBase);
  const commit = await resolveCommit(prefix, ref);
  if (!commit) throw new SnapshotError('GIT_FAILED', `fast-import finished but ${ref} does not exist`);
  return { turnId, ref, commit, storage, fileCount: written.fileCount, skipped: written.skipped, createdAt };
}

/** Find the snapshot for a turn: the shadow store first (a turn may have run `git init`), then the repo. */
async function loadSnapshot(input) {
  const turnId = assertTurnId(input.turnId);
  const ctx = await resolveContext(input);
  const ref = SNAPSHOT_REF_PREFIX + turnId;
  const candidates = [];
  if (shadowExists(ctx)) candidates.push(shadowPrefix(ctx));
  if (ctx.isRepoTop) candidates.push(repoPrefix(ctx));
  for (const prefix of candidates) {
    const commit = await resolveCommit(prefix, ref);
    if (!commit) continue;
    const commitText = (await runGit([...prefix, 'cat-file', 'commit', commit], { label: 'cat-file' })).stdout.toString('utf8');
    const meta = decodeCommitMeta(commitText);
    const tree = (await runGit([...prefix, 'ls-tree', '-r', '-l', '-z', '--full-tree', commit], { label: 'ls-tree' })).stdout;
    const entries = parseTree(tree);
    return {
      ctx,
      prefix,
      meta,
      entries,
      entryKeys: new Set([...entries.keys()].map(pathKey)),
      isProtected: makeProtectedCheck(meta),
    };
  }
  throw new SnapshotError('SNAPSHOT_NOT_FOUND', `no snapshot found for turn ${turnId}`);
}

/** Snapshot files that are now missing ('deleted') or differ ('modified'). */
function snapshotSideChanges(state) {
  const out = [];
  for (const [rel, entry] of state.entries) {
    const abs = absPathOf(state.ctx.projectDir, rel);
    let stat = null;
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new SnapshotError('GIT_FAILED', `cannot inspect ${rel}: ${err.code}`);
    }
    if (!stat) { out.push({ path: rel, status: 'deleted', entry }); continue; }
    if (!stat.isFile() || stat.size !== entry.size || fileModeOf(stat) !== entry.mode) { out.push({ path: rel, status: 'modified', entry }); continue; }
    let same = false;
    try {
      same = gitBlobId(fs.readFileSync(abs), entry.sha) === entry.sha;
    } catch {
      same = false; // unreadable now (locked): report it as changed rather than guess
    }
    if (!same) out.push({ path: rel, status: 'modified', entry });
  }
  return out;
}

/** Regular files visible now that are neither in the snapshot nor recorded as outside it. */
async function createdFiles(state) {
  const out = [];
  for (const rel of await listCurrentFiles(state.ctx, state.prefix, state.meta)) {
    if (state.entryKeys.has(pathKey(rel)) || state.isProtected(rel)) continue;
    let stat;
    try {
      stat = fs.lstatSync(absPathOf(state.ctx.projectDir, rel));
    } catch {
      continue; // vanished between listing and inspection: nothing to report or remove
    }
    if (stat.isFile()) out.push(rel);
  }
  return out;
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What the turn changed since its snapshot: [{ path, status: 'modified'|'deleted'|'added' }], sorted. */
export async function listChanged({ projectDir, dataDir, turnId } = {}) {
  const state = await loadSnapshot({ projectDir, dataDir, turnId });
  const changes = snapshotSideChanges(state).map(({ path: p, status }) => ({ path: p, status }));
  for (const rel of await createdFiles(state)) changes.push({ path: rel, status: 'added' });
  return changes.sort(byPath);
}

async function restoreEntries(state, items, done) {
  const bySha = new Map();
  for (const item of items) {
    if (!bySha.has(item.entry.sha)) bySha.set(item.entry.sha, []);
    bySha.get(item.entry.sha).push(item);
  }
  const conflicts = [];
  await readBlobs(state.prefix, [...bySha.keys()], (sha, buffer) => {
    for (const item of bySha.get(sha) || []) {
      const code = writeRestored(state.ctx.projectDir, item.path, item.entry, buffer);
      if (code) conflicts.push({ ...item, code });
      else done.add(item.path);
    }
  });
  return conflicts;
}

/**
 * Put the project folder back to its snapshot: changed and deleted files get their old bytes,
 * files the turn created are removed, and so are folders it created and left empty. Returns the
 * sorted relative paths that were put back or removed. Throws UNDO_INCOMPLETE with
 * details { restored, failed: [{path, code}], leftFolders } when some file could not be handled.
 */
export async function undo({ projectDir, dataDir, turnId } = {}) {
  const state = await loadSnapshot({ projectDir, dataDir, turnId });
  const done = new Set();
  const failed = new Map();
  const leftFolders = new Map();
  const keepFolderKeys = state.meta.emptyDirs === null ? null : knownFolderKeys(state.entries, state.meta.emptyDirs);
  const removeOptions = { keepFolderKeys, done, failed, leftFolders };
  // 1. Put snapshot files back first: this also restores the snapshot's own .gitignore files, so
  //    every later "is this new?" question is answered with the ignore rules of before the turn.
  const conflicts = await restoreEntries(state, snapshotSideChanges(state), done);
  // 2. A .gitignore the turn created could hide its other new files: remove those first.
  let created = await createdFiles(state);
  const createdIgnoreFiles = created.filter((rel) => rel.split('/').pop() === '.gitignore');
  if (createdIgnoreFiles.length > 0) {
    removeCreatedFiles(state.ctx.projectDir, createdIgnoreFiles, removeOptions);
    created = await createdFiles(state);
  }
  // 3. Remove what the turn created.
  removeCreatedFiles(state.ctx.projectDir, created, removeOptions);
  // 4. Retry restores that were blocked by something the turn put in their way (a file where a
  //    folder must go, or a folder where a file must go), then bring back empty folders.
  if (conflicts.length > 0) {
    for (const item of await restoreEntries(state, conflicts, done)) failed.set(item.path, item.code);
  }
  recreateEmptyDirs(state.ctx.projectDir, state.meta.emptyDirs, leftFolders);
  const restored = [...done].sort();
  if (failed.size > 0) {
    throw new SnapshotError('UNDO_INCOMPLETE', `${failed.size} file(s) could not be put back`, {
      restored,
      failed: [...failed].map(([p, code]) => ({ path: p, code })).sort(byPath),
      leftFolders: [...leftFolders].map(([p, code]) => ({ path: p, code })),
    });
  }
  return restored;
}
