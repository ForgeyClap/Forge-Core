// Tests for the snapshot safety net (WP B3b part 1): snapshot before a writing turn, list what the
// turn changed, undo byte-identically. Every fixture lives in its own os.tmpdir() folder; the real
// gateway data folder is never touched. Uses the system git, like the module itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  snapshotBeforeTurn, listChanged, undo, SnapshotError, GIT_MISSING_MESSAGE_NL,
} from '../src/snapshots/snapshots.mjs';
import { _setGitBinaryForTests, _resetGitBinaryForTests } from '../src/snapshots/git-runner.mjs';

const tempDirs = [];
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-snap-${label}-`));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** sha256 of every file below root (forward-slash relative paths), skipping the named folders. */
function hashTree(root, skip = []) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name) && prefix === '') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(root, '');
  return out;
}

function cleanGitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...extra };
}
function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true,
  });
}

/** The one shadow git dir the module created under dataDir/snapshots. */
function shadowDirOf(dataDir) {
  const root = path.join(dataDir, 'snapshots');
  const dirs = fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, 'HEAD')));
  assert.equal(dirs.length, 1, 'exactly one shadow store');
  return path.join(root, dirs[0]);
}
function shadowTreeNames(dataDir, ref) {
  const out = execFileSync('git', ['--git-dir', shadowDirOf(dataDir), 'ls-tree', '-r', '-z', '--name-only', ref], { env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  return out.split('\0').filter(Boolean).sort();
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SnapshotError, `expected SnapshotError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test('(a) folder without git: snapshot, modify + delete + create, undo restores every byte and never creates .git', async () => {
  const project = tempDir('plain');
  const dataDir = tempDir('data');
  write(project, 'crlf.txt', 'one\r\ntwo\r\n');
  write(project, 'lf.txt', 'x\ny\n');
  write(project, 'empty.txt', '');
  write(project, 'binary.bin', randomBytes(8192));
  write(project, 'src/lib/b.js', 'export const b = 1;\n');
  write(project, 'src/keep.js', 'keep\n');
  write(project, 'map met spatie/ünïcode – naam.txt', 'unicode content é\n');
  const before = hashTree(project);

  const snap = await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-plain-1' });
  assert.equal(snap.storage, 'shadow');
  assert.equal(snap.ref, 'refs/forge/snapshots/t-plain-1');
  assert.equal(snap.fileCount, 7);
  assert.deepEqual(snap.skipped, []);
  assert.match(snap.commit, /^[0-9a-f]{40}$/);
  assert.equal(fs.existsSync(path.join(project, '.git')), false, 'no .git inside the project after a snapshot');
  assert.deepEqual(hashTree(project), before, 'taking a snapshot changes nothing in the folder');

  // The "turn": edit, convert line endings, delete a file and a whole folder, create new files.
  write(project, 'crlf.txt', 'changed\n');
  write(project, 'lf.txt', 'x\r\ny\r\n');
  fs.rmSync(path.join(project, 'binary.bin'));
  fs.rmSync(path.join(project, 'src', 'lib'), { recursive: true });
  write(project, 'new.txt', 'brand new\n');
  write(project, 'newdir/deep/c.txt', 'deep new\n');

  assert.deepEqual(await listChanged({ projectDir: project, dataDir, turnId: 't-plain-1' }), [
    { path: 'binary.bin', status: 'deleted' },
    { path: 'crlf.txt', status: 'modified' },
    { path: 'lf.txt', status: 'modified' },
    { path: 'new.txt', status: 'added' },
    { path: 'newdir/deep/c.txt', status: 'added' },
    { path: 'src/lib/b.js', status: 'deleted' },
  ]);

  const restored = await undo({ projectDir: project, dataDir, turnId: 't-plain-1' });
  assert.deepEqual(restored, ['binary.bin', 'crlf.txt', 'lf.txt', 'new.txt', 'newdir/deep/c.txt', 'src/lib/b.js']);
  assert.deepEqual(hashTree(project), before, 'every file is byte-identical to before the turn (sha256)');
  assert.equal(fs.existsSync(path.join(project, 'newdir')), false, 'folders the turn created are removed when empty');
  assert.equal(fs.existsSync(path.join(project, '.git')), false, 'still no .git inside the project');

  assert.deepEqual(await listChanged({ projectDir: project, dataDir, turnId: 't-plain-1' }), []);
  assert.deepEqual(await undo({ projectDir: project, dataDir, turnId: 't-plain-1' }), [], 'a second undo has nothing left to do');
});

test('(b) git repo with dirty tree and staged changes: snapshot leaves HEAD, index and tree untouched; hidden ref; undo restores', async () => {
  const repo = tempDir('repo');
  const dataDir = tempDir('data');
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, 'tracked.txt', 'v1\n');
  write(repo, 'docs/readme.md', '# readme\r\n');
  write(repo, '.gitignore', 'secret.env\nout/\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  // Dirty state: an unstaged edit, a staged edit, a staged new file, an untracked file, ignored files.
  write(repo, 'tracked.txt', 'v2 unstaged\n');
  write(repo, 'docs/readme.md', '# readme staged\r\n');
  write(repo, 'staged-new.txt', 'staged new\n');
  git(repo, ['add', 'docs/readme.md', 'staged-new.txt']);
  write(repo, 'untracked.txt', 'untracked\n');
  write(repo, 'secret.env', 'TOKEN=not-a-real-value\n');
  write(repo, 'out/build.log', 'log\n');

  const status = () => git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  const indexHash = () => createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const indexBefore = indexHash();
  const statusBefore = status();
  const treeBefore = hashTree(repo, ['.git']);
  const branchesBefore = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads']);

  const snap = await snapshotBeforeTurn({ projectDir: repo, dataDir, turnId: 't-repo-1' });
  assert.equal(snap.storage, 'git-repo');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD unchanged');
  assert.equal(indexHash(), indexBefore, 'index file bytes unchanged');
  assert.equal(status(), statusBefore, 'git status output identical');
  assert.deepEqual(hashTree(repo, ['.git']), treeBefore, 'working tree unchanged');
  assert.equal(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads']), branchesBefore, 'no branch created');
  assert.equal(git(repo, ['rev-parse', '--verify', 'refs/forge/snapshots/t-repo-1']).trim(), snap.commit, 'hidden ref exists');
  assert.equal(fs.existsSync(path.join(dataDir, 'snapshots')), false, 'a repo snapshot needs no shadow store');
  const captured = git(repo, ['ls-tree', '-r', '--name-only', 'refs/forge/snapshots/t-repo-1']).trim().split('\n').sort();
  assert.deepEqual(captured, ['.gitignore', 'docs/readme.md', 'staged-new.txt', 'tracked.txt', 'untracked.txt'], 'working-tree state captured; ignored files are not');
  assert.equal(git(repo, ['show', 'refs/forge/snapshots/t-repo-1:tracked.txt']), 'v2 unstaged\n', 'the snapshot holds the working tree, not HEAD');

  // The "turn".
  write(repo, 'tracked.txt', 'v3 by the turn\n');
  fs.rmSync(path.join(repo, 'docs', 'readme.md'));
  write(repo, 'brand-new.txt', 'created by the turn\n');
  write(repo, 'staged-new.txt', 'rewritten\n');

  assert.deepEqual(await listChanged({ projectDir: repo, dataDir, turnId: 't-repo-1' }), [
    { path: 'brand-new.txt', status: 'added' },
    { path: 'docs/readme.md', status: 'deleted' },
    { path: 'staged-new.txt', status: 'modified' },
    { path: 'tracked.txt', status: 'modified' },
  ]);
  const restored = await undo({ projectDir: repo, dataDir, turnId: 't-repo-1' });
  assert.deepEqual(restored, ['brand-new.txt', 'docs/readme.md', 'staged-new.txt', 'tracked.txt']);
  assert.deepEqual(hashTree(repo, ['.git']), treeBefore, 'working tree byte-identical after undo');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD still unchanged');
  assert.equal(status(), statusBefore, 'git status identical after undo');
  assert.equal(indexHash(), indexBefore, 'undo never writes the user index');
});

test('(c) excluded folders, large files and ignored files are never captured, restored or removed', async () => {
  const project = tempDir('excl');
  const dataDir = tempDir('data');
  write(project, 'keep.js', 'keep v1\n');
  write(project, 'scripts/build', 'a FILE named build is captured; only folders are excluded\n');
  write(project, 'node_modules/pkg/index.js', 'module\n');
  write(project, 'sub/node_modules/y.js', 'nested module\n');
  write(project, 'dist/out.js', 'dist\n');
  write(project, 'build/b.js', 'build\n');
  write(project, '.next/cache.json', '{}\n');
  write(project, 'coverage/report.txt', 'coverage\n');
  write(project, 'big.bin', Buffer.alloc(2048, 7));
  write(project, '.gitignore', 'local.env\n');
  write(project, 'local.env', 'IGNORED=1\n');

  const snap = await snapshotBeforeTurn({
    projectDir: project, dataDir, turnId: 't-excl-1', maxFileBytes: 1024,
    excludeDirs: ['node_modules', 'dist', 'build', '.next', 'coverage'],
  });
  assert.deepEqual(shadowTreeNames(dataDir, snap.ref), ['.gitignore', 'keep.js', 'scripts/build']);
  assert.deepEqual(snap.skipped, [{ path: 'big.bin', reason: 'too-large' }]);

  // The "turn": touch everything outside the snapshot, plus one captured file; it also stops
  // ignoring local.env and shrinks big.bin so both would now look like new files.
  write(project, 'keep.js', 'keep v2\n');
  write(project, 'node_modules/pkg/index.js', 'module changed\n');
  write(project, 'dist/new.js', 'new dist file\n');
  write(project, 'coverage/report.txt', 'coverage changed\n');
  write(project, 'big.bin', 'small now\n');
  write(project, '.gitignore', '# local.env no longer ignored\n');

  assert.deepEqual(await listChanged({ projectDir: project, dataDir, turnId: 't-excl-1' }), [
    { path: '.gitignore', status: 'modified' },
    { path: 'keep.js', status: 'modified' },
  ], 'only captured files are reported; an un-ignored or shrunk old file is not "added"');
  const restored = await undo({ projectDir: project, dataDir, turnId: 't-excl-1' });
  assert.deepEqual(restored, ['.gitignore', 'keep.js']);
  assert.equal(fs.readFileSync(path.join(project, 'keep.js'), 'utf8'), 'keep v1\n');
  assert.equal(fs.readFileSync(path.join(project, 'local.env'), 'utf8'), 'IGNORED=1\n', 'a file the turn un-ignored is never deleted');
  assert.equal(fs.readFileSync(path.join(project, 'big.bin'), 'utf8'), 'small now\n', 'a skipped large file is left alone');
  assert.equal(fs.readFileSync(path.join(project, 'node_modules/pkg/index.js'), 'utf8'), 'module changed\n');
  assert.equal(fs.readFileSync(path.join(project, 'coverage/report.txt'), 'utf8'), 'coverage changed\n');
  assert.ok(fs.existsSync(path.join(project, 'dist', 'new.js')), 'files in excluded folders are never removed');
});

test('(c) in a git repo, tracked files under excluded folders are not captured and not touched by undo', async () => {
  const repo = tempDir('repo-excl');
  const dataDir = tempDir('data');
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, 'src/app.js', 'app v1\n');
  write(repo, 'dist/bundle.js', 'bundle v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'with a committed dist folder']);
  const snap = await snapshotBeforeTurn({ projectDir: repo, dataDir, turnId: 't-repo-excl-1' });
  assert.equal(git(repo, ['ls-tree', '-r', '--name-only', snap.ref]), 'src/app.js\n');
  write(repo, 'src/app.js', 'app v2\n');
  write(repo, 'dist/bundle.js', 'bundle v2\n');
  assert.deepEqual(await listChanged({ projectDir: repo, dataDir, turnId: 't-repo-excl-1' }), [{ path: 'src/app.js', status: 'modified' }]);
  assert.deepEqual(await undo({ projectDir: repo, dataDir, turnId: 't-repo-excl-1' }), ['src/app.js']);
  assert.equal(fs.readFileSync(path.join(repo, 'dist', 'bundle.js'), 'utf8'), 'bundle v2\n');
});

test('a file where a folder must go (and the reverse) is cleared first, then restored', async () => {
  const project = tempDir('swap');
  const dataDir = tempDir('data');
  write(project, 'lib/x.js', 'x\n');
  write(project, 'notes.txt', 'notes\n');
  const before = hashTree(project);
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-swap-1' });
  fs.rmSync(path.join(project, 'lib'), { recursive: true });
  write(project, 'lib', 'now a file\n');
  fs.rmSync(path.join(project, 'notes.txt'));
  write(project, 'notes.txt/inside.md', 'now a folder\n');
  const restored = await undo({ projectDir: project, dataDir, turnId: 't-swap-1' });
  assert.deepEqual(restored, ['lib', 'lib/x.js', 'notes.txt', 'notes.txt/inside.md']);
  assert.deepEqual(hashTree(project), before);
});

test('(c) a .gitignore created by the turn cannot hide its other new files from undo', async () => {
  const project = tempDir('ignore');
  const dataDir = tempDir('data');
  write(project, 'a.txt', 'a\n');
  const before = hashTree(project);
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-ignore-1' });
  write(project, 'pkg/.gitignore', 'secret.txt\n');
  write(project, 'pkg/secret.txt', 'hidden by the new .gitignore\n');
  write(project, 'pkg/index.js', 'visible\n');
  const restored = await undo({ projectDir: project, dataDir, turnId: 't-ignore-1' });
  assert.deepEqual(restored, ['pkg/.gitignore', 'pkg/index.js', 'pkg/secret.txt']);
  assert.deepEqual(hashTree(project), before);
  assert.equal(fs.existsSync(path.join(project, 'pkg')), false);
});

test('a rename by the turn is undone: the old name comes back and the new name goes', async () => {
  const project = tempDir('rename');
  const dataDir = tempDir('data');
  write(project, 'src/old-name.js', 'export default 1;\n');
  const before = hashTree(project);
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-rename-1' });
  fs.mkdirSync(path.join(project, 'lib'));
  fs.renameSync(path.join(project, 'src', 'old-name.js'), path.join(project, 'lib', 'new-name.js'));
  assert.deepEqual(await listChanged({ projectDir: project, dataDir, turnId: 't-rename-1' }), [
    { path: 'lib/new-name.js', status: 'added' },
    { path: 'src/old-name.js', status: 'deleted' },
  ]);
  await undo({ projectDir: project, dataDir, turnId: 't-rename-1' });
  assert.deepEqual(hashTree(project), before);
  assert.equal(fs.existsSync(path.join(project, 'lib')), false);
});

test('empty folders: a pre-existing empty folder is kept, a deleted one comes back', async () => {
  const project = tempDir('empty');
  const dataDir = tempDir('data');
  write(project, 'a.txt', 'a\n');
  fs.mkdirSync(path.join(project, 'assets', 'img'), { recursive: true });
  fs.mkdirSync(path.join(project, 'placeholder'));
  const folderId = fs.statSync(path.join(project, 'assets', 'img'), { bigint: true }).ino;
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-empty-1' });
  write(project, 'assets/img/logo.svg', '<svg/>\n');
  fs.rmdirSync(path.join(project, 'placeholder'));
  assert.deepEqual(await undo({ projectDir: project, dataDir, turnId: 't-empty-1' }), ['assets/img/logo.svg']);
  assert.deepEqual(fs.readdirSync(path.join(project, 'assets', 'img')), [], 'the folder the user made is still there, empty');
  assert.equal(fs.statSync(path.join(project, 'assets', 'img'), { bigint: true }).ino, folderId, 'never removed and re-made: the same folder');
  assert.ok(fs.statSync(path.join(project, 'placeholder')).isDirectory(), 'the empty folder the turn removed is back');
});

test('files of a nested git repository are never removed, even when the turn deletes its .git', async () => {
  const project = tempDir('nested-repo');
  const dataDir = tempDir('data');
  write(project, 'app.js', 'app\n');
  write(project, 'vendor/lib/index.js', 'vendored\n');
  git(path.join(project, 'vendor', 'lib'), ['init', '-q']);
  const snap = await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-nrepo-1' });
  assert.deepEqual(snap.skipped, [{ path: 'vendor/lib', reason: 'nested-repo' }]);
  fs.rmSync(path.join(project, 'vendor', 'lib', '.git'), { recursive: true, force: true });
  assert.deepEqual(await listChanged({ projectDir: project, dataDir, turnId: 't-nrepo-1' }), []);
  assert.deepEqual(await undo({ projectDir: project, dataDir, turnId: 't-nrepo-1' }), []);
  assert.equal(fs.readFileSync(path.join(project, 'vendor', 'lib', 'index.js'), 'utf8'), 'vendored\n');
});

test('the gateway data folder inside the project is never captured and never removed', async () => {
  const project = tempDir('nd');
  const dataDir = path.join(project, '.fd'); // short names: git caps a --git-dir at 220 chars on Windows
  write(project, 'app.js', 'v1\n');
  const snap = await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-nested-1' });
  assert.equal(snap.fileCount, 1, 'only app.js: the data folder and its snapshot store are excluded');
  write(project, 'app.js', 'v2\n');
  write(project, '.fd/conversations/c1.jsonl', '{"turn":1}\n');
  assert.deepEqual(await undo({ projectDir: project, dataDir, turnId: 't-nested-1' }), ['app.js']);
  assert.ok(fs.existsSync(path.join(dataDir, 'conversations', 'c1.jsonl')), 'gateway data written during the turn survives undo');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: dataDir, dataDir, turnId: 't-nested-2' }), 'INVALID_INPUT');
});

test('a turn that runs `git init` in a plain folder: undo still finds the shadow snapshot', async () => {
  const project = tempDir('late-init');
  const dataDir = tempDir('data');
  write(project, 'index.html', '<h1>v1</h1>\n');
  const before = hashTree(project);
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-late-1' });
  git(project, ['init', '-q']);
  write(project, 'index.html', '<h1>v2</h1>\n');
  assert.deepEqual(await undo({ projectDir: project, dataDir, turnId: 't-late-1' }), ['index.html']);
  assert.deepEqual(hashTree(project, ['.git']), before);
});

test('undo reports UNDO_INCOMPLETE instead of pretending, when a folder now blocks a file', async () => {
  const project = tempDir('blocked');
  const dataDir = tempDir('data');
  write(project, '.gitignore', '*.log\n');
  write(project, 'a.txt', 'a\n');
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-blocked-1' });
  fs.rmSync(path.join(project, 'a.txt'));
  write(project, 'a.txt/kept.log', 'an ignored file keeps the folder alive\n');
  await assert.rejects(undo({ projectDir: project, dataDir, turnId: 't-blocked-1' }), (err) => {
    assert.equal(err.code, 'UNDO_INCOMPLETE');
    assert.deepEqual(err.details.failed, [{ path: 'a.txt', code: 'EISDIR' }]);
    return true;
  });
});

test('undo never writes through a link the turn put in place of a folder', async (t) => {
  const project = tempDir('link');
  const outside = tempDir('outside');
  const dataDir = tempDir('data');
  write(project, 'src/a.txt', 'inside\n');
  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-link-1' });
  fs.rmSync(path.join(project, 'src'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(project, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot create a folder link here: ${err.code}`);
    return;
  }
  try {
    await assert.rejects(undo({ projectDir: project, dataDir, turnId: 't-link-1' }), (err) => {
      assert.equal(err.code, 'UNDO_INCOMPLETE');
      assert.deepEqual(err.details.failed, [{ path: 'src/a.txt', code: 'OUTSIDE_PROJECT' }]);
      return true;
    });
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the project');
  } finally {
    fs.unlinkSync(path.join(project, 'src')); // removes the link itself, never its target
  }
});

test('git missing: a typed GIT_MISSING error carrying the Dutch card text', async () => {
  const project = tempDir('nogit');
  const dataDir = tempDir('data');
  write(project, 'a.txt', 'a\n');
  _setGitBinaryForTests(path.join(tempDir('bin'), process.platform === 'win32' ? 'no-such-git.exe' : 'no-such-git'));
  try {
    await assert.rejects(snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-nogit-1' }), (err) => {
      assert.ok(err instanceof SnapshotError);
      assert.equal(err.code, 'GIT_MISSING');
      assert.equal(err.message, GIT_MISSING_MESSAGE_NL);
      return true;
    });
    await rejectsWithCode(undo({ projectDir: project, dataDir, turnId: 't-nogit-1' }), 'GIT_MISSING');
  } finally {
    _resetGitBinaryForTests();
  }
  assert.equal(GIT_MISSING_MESSAGE_NL, 'Ongedaan maken is niet beschikbaar: git ontbreekt');
});

test('input validation, duplicate snapshots and unknown turns are typed errors', async () => {
  const project = tempDir('input');
  const dataDir = tempDir('data');
  write(project, 'a.txt', 'a\n');
  for (const turnId of ['', '../escape', '-evil-flag', 'a/b', 'x'.repeat(129), 'a b', undefined]) {
    await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir, turnId }), 'INVALID_INPUT');
  }
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: 'relative/path', dataDir, turnId: 't-1' }), 'INVALID_INPUT');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir: 'relative', turnId: 't-1' }), 'INVALID_INPUT');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: path.join(project, 'missing'), dataDir, turnId: 't-1' }), 'INVALID_INPUT');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-1', maxFileBytes: -1 }), 'INVALID_INPUT');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-1', excludeDirs: ['../up'] }), 'INVALID_INPUT');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-1', maxFiles: 0 }), 'INVALID_INPUT');

  await snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-dup-1' });
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-dup-1' }), 'SNAPSHOT_EXISTS');
  await rejectsWithCode(listChanged({ projectDir: project, dataDir, turnId: 't-unknown' }), 'SNAPSHOT_NOT_FOUND');
  await rejectsWithCode(undo({ projectDir: project, dataDir, turnId: 't-unknown' }), 'SNAPSHOT_NOT_FOUND');
  write(project, 'b.txt', 'b\n');
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir, turnId: 't-many-1', maxFiles: 1 }), 'TOO_MANY_FILES');
});

test('a data folder so deep that git would refuse the store gives PATH_TOO_LONG, not a raw git error', { skip: process.platform !== 'win32' && 'Windows path limit only' }, async () => {
  const project = tempDir('long');
  write(project, 'a.txt', 'a\n');
  const deepData = path.join(tempDir('data'), 'x'.repeat(Math.max(1, 230 - os.tmpdir().length)));
  await rejectsWithCode(snapshotBeforeTurn({ projectDir: project, dataDir: deepData, turnId: 't-long-1' }), 'PATH_TOO_LONG');
  assert.equal(fs.existsSync(deepData), false, 'nothing is created when the store cannot work');
});
