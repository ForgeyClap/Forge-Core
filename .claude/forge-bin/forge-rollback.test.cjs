#!/usr/bin/env node
'use strict';
// forge-rollback.test.cjs — real tests for ROLLBACK PER RUN (WP 3.3). Every case runs the REAL CLI as a
// spawned process against a throwaway git repository under os.tmpdir(), with hermetic git (an empty global config, no
// system config, a ceiling directory so a parent repository can never be discovered). Two MUTATION checks run a
// patched copy of the tool and prove the backup and protected-path assertions would catch a regression.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, 'forge-rollback.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rollback-test-'));
const GITCFG = path.join(TMP, 'empty-gitconfig');
fs.writeFileSync(GITCFG, '');
const ENV = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: GITCFG, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: TMP,
  GIT_TERMINAL_PROMPT: '0', FORGE_STATE_DIR: '' });
delete ENV.GIT_DIR; delete ENV.GIT_WORK_TREE; delete ENV.GIT_INDEX_FILE; delete ENV.FORGE_ROLLBACK_GIT;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout;
}
const gTry = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
let seq = 0;
function write(d, rel, s) { const p = path.join(d, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function read(d, rel) { try { return fs.readFileSync(path.join(d, ...rel.split('/')), 'utf8'); } catch { return null; } }
function repo(files, opts) {
  const d = path.join(TMP, 'r' + (++seq) + (opts && opts.suffix ? '-' + opts.suffix : ''));
  fs.mkdirSync(d, { recursive: true });
  g(d, 'init', '-q');
  for (const [k, v] of [['user.email', 't@example.invalid'], ['user.name', 'test'], ['core.autocrlf', 'false'], ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false']]) g(d, 'config', k, v);
  for (const [rel, s] of Object.entries(files)) write(d, rel, s);
  g(d, 'add', '-A');
  g(d, 'commit', '-qm', 'init');
  return d;
}
function run(args, opts) {
  const o = opts || {};
  return spawnSync(process.execPath, [o.tool || TOOL].concat(args), { encoding: 'utf8', env: Object.assign({}, ENV, o.env || {}), cwd: o.cwd || TMP });
}
const ok = (r, code) => { assert.strictEqual(r.status, code === undefined ? 0 : code, 'exit ' + r.status + '\nstdout: ' + r.stdout + '\nstderr: ' + r.stderr); return r; };
const json = (r) => JSON.parse(r.stdout);
const backups = (d) => { try { return fs.readdirSync(path.join(d, '_scratch')).filter((n) => n.startsWith('rollback-backup-')); } catch { return []; } };
const head = (d) => g(d, 'rev-parse', 'HEAD').trim();
/** the rollback folder follows the opt-in layout: .forge/backups/rollback once <root>/.forge exists, else .claude/forge-backups/rollback */
const rbDir = (d) => (fs.existsSync(path.join(d, '.forge')) ? path.join(d, '.forge', 'backups', 'rollback') : path.join(d, '.claude', 'forge-backups', 'rollback'));
const ledgerRows = (d) => fs.readFileSync(path.join(rbDir(d), 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const BASE_FILES = { 'a.txt': 'alpha original\n', 'b.txt': 'bravo original\n', 'src/app.js': 'console.log(1);\n',
  '.claude/FORGE_MEMORY.md': 'memory v1\n', '.claude/forge-audit/ledger.jsonl': '{"n":1}\n', '.claude/LESSONS.md': 'lessons v1\n',
  '.claude/agent-memory/build-boss/MEMORY.md': 'boss v1\n', '.claude/forge-scribe/log.jsonl': 'scribe v1\n', '.forge/memory/x.md': 'forge state v1\n' };
const PROTECTED = ['.claude/FORGE_MEMORY.md', '.claude/forge-audit/ledger.jsonl', '.claude/LESSONS.md', '.claude/agent-memory/build-boss/MEMORY.md', '.claude/forge-scribe/log.jsonl', '.forge/memory/x.md'];

console.log('forge-rollback tests (hermetic tmp=' + TMP + ')');

// ---------------------------------------------------------------------------
console.log('\n1) unavailable: not a git repository, no commit, no git');
t('a folder that is not a git repository: every command exits 3 with "rollback unavailable: not a git repository"', () => {
  const d = path.join(TMP, 'nogit'); fs.mkdirSync(d);
  for (const args of [['checkpoint', '--run', 'x1'], ['plan', '--run', 'x1'], ['apply', '--run', 'x1', '--yes'], ['list']]) {
    const r = ok(run(args.concat(['--root', d])), 3);
    assert.ok(r.stderr.includes('rollback unavailable: not a git repository'), r.stderr);
  }
  assert.deepStrictEqual(fs.readdirSync(d), [], 'nothing may be written into a non-git folder');
});
t('a repository without any commit: checkpoint exits 3 (no commit yet)', () => {
  const d = path.join(TMP, 'empty-repo'); fs.mkdirSync(d); g(d, 'init', '-q');
  const r = ok(run(['checkpoint', '--run', 'x1', '--root', d]), 3);
  assert.ok(r.stderr.includes('no commit yet'), r.stderr);
});
t('git missing: exits 3 with "git not found" (FORGE_ROLLBACK_GIT points at a binary that does not exist)', () => {
  const d = repo({ 'a.txt': 'x\n' });
  const r = ok(run(['checkpoint', '--run', 'x1', '--root', d], { env: { FORGE_ROLLBACK_GIT: path.join(TMP, 'no-such-git.exe') } }), 3);
  assert.ok(r.stderr.includes('rollback unavailable: git not found'), r.stderr);
});
t('usage: a bad run id or an unknown argument exits 2', () => {
  const d = repo({ 'a.txt': 'x\n' });
  for (const id of ['../x', 'a b', '', '-x', 'a.lock']) ok(run(['checkpoint', '--run', id, '--root', d]), 2);
  ok(run(['checkpoint', '--root', d]), 2);
  ok(run(['plan', '--run', 'x1', '--bogus', '--root', d]), 2);
  ok(run(['frobnicate']), 2);
});

// ---------------------------------------------------------------------------
console.log('\n2) checkpoint');
t('clean tree: record + checksum, lightweight tag at HEAD, run-folder note, ledger row; no commit, no stash', () => {
  const d = repo(Object.assign({}, BASE_FILES, { '.claude/forge-runs/run-a/run.json': '{}\n' }));
  const before = head(d), commits = g(d, 'rev-list', '--count', 'HEAD').trim();
  const r = ok(run(['checkpoint', '--run', 'run-a', '--root', d, '--json']));
  const rec = json(r).record;
  assert.strictEqual(rec.head, before); assert.strictEqual(rec.dirty, false); assert.strictEqual(rec.tag, 'forge-run/run-a');
  assert.strictEqual(g(d, 'rev-parse', 'forge-run/run-a^{commit}').trim(), before);
  assert.strictEqual(g(d, 'cat-file', '-t', 'forge-run/run-a').trim(), 'commit', 'a lightweight tag points straight at the commit');
  assert.strictEqual(head(d), before); assert.strictEqual(g(d, 'rev-list', '--count', 'HEAD').trim(), commits, 'checkpoint never commits');
  assert.strictEqual(g(d, 'stash', 'list').trim(), '', 'checkpoint never stashes');
  assert.ok(fs.existsSync(path.join(d, '.forge')), 'BASE_FILES has .forge/, so this project is on the opt-in layout');
  const env = JSON.parse(fs.readFileSync(path.join(rbDir(d), 'run-a.checkpoint.json'), 'utf8'));
  assert.ok(env._checksum && env._checksum.length === 64);
  const note = JSON.parse(read(d, '.claude/forge-runs/run-a/rollback-checkpoint.json'));
  assert.strictEqual(note.head, before, 'the note goes into the run folder that exists (legacy .claude/forge-runs here)');
  assert.ok(ledgerRows(d).some((e) => e.event === 'checkpoint' && e.run_id === 'run-a'));
});
t('no run folder: no note is written (and nothing else in .claude/forge-runs)', () => {
  const d = repo({ 'a.txt': 'x\n' });
  ok(run(['checkpoint', '--run', 'run-b', '--root', d]));
  assert.ok(!fs.existsSync(path.join(d, '.claude', 'forge-runs')));
});
t('opt-in .forge/ layout: the record goes to .forge/backups/rollback (forge-paths stateDir)', () => {
  const d = repo({ 'a.txt': 'x\n', '.forge/runs/run-c/run.json': '{}\n' });
  ok(run(['checkpoint', '--run', 'run-c', '--root', d]));
  assert.ok(fs.existsSync(path.join(d, '.forge', 'backups', 'rollback', 'run-c.checkpoint.json')));
  assert.ok(fs.existsSync(path.join(d, '.forge', 'runs', 'run-c', 'rollback-checkpoint.json')), 'the note follows the runs folder too');
  assert.ok(!fs.existsSync(path.join(d, '.claude', 'forge-backups')));
});
t('dirty tree: dirty:true, every uncommitted and untracked file with its sha256, and NO tag', () => {
  const d = repo({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
  write(d, 'a.txt', 'pre-run edit\n'); write(d, 'new.txt', 'untracked\n');
  const rec = json(ok(run(['checkpoint', '--run', 'run-d', '--root', d, '--json']))).record;
  assert.strictEqual(rec.dirty, true); assert.strictEqual(rec.tag, null);
  assert.deepStrictEqual(rec.dirty_files.map((f) => [f.path, f.sha256]), [['a.txt', sha('pre-run edit\n')]]);
  assert.deepStrictEqual(rec.untracked.map((f) => [f.path, f.sha256]), [['new.txt', sha('untracked\n')]]);
  assert.strictEqual(g(d, 'tag', '-l').trim(), '', 'no tag on a dirty tree');
});
t('changes ONLY in protected paths (memory, ledger, scribe, .forge) do not make the tree dirty', () => {
  const d = repo(BASE_FILES);
  for (const p of PROTECTED) write(d, p, 'changed\n');
  const rec = json(ok(run(['checkpoint', '--run', 'run-e', '--root', d, '--json']))).record;
  assert.strictEqual(rec.dirty, false); assert.strictEqual(rec.tag, 'forge-run/run-e');
  assert.ok(rec.protected_skipped >= PROTECTED.length, 'protected_skipped ' + rec.protected_skipped);
});
t('a second checkpoint for the same run keeps the first (the restore point never moves)', () => {
  const d = repo({ 'a.txt': 'x\n' });
  const first = json(ok(run(['checkpoint', '--run', 'run-f', '--root', d, '--json']))).record;
  write(d, 'a.txt', 'changed by the run\n');
  const r = ok(run(['checkpoint', '--run', 'run-f', '--root', d]));
  assert.ok(r.stdout.includes('kept'), r.stdout);
  const again = json(ok(run(['checkpoint', '--run', 'run-f', '--root', d, '--json']))).record;
  assert.strictEqual(again.created_at, first.created_at); assert.strictEqual(again.dirty, false);
});
t('a tampered checkpoint record is refused (checksum), never trusted', () => {
  const d = repo({ 'a.txt': 'x\n' });
  ok(run(['checkpoint', '--run', 'run-g', '--root', d]));
  const f = path.join(rbDir(d), 'run-g.checkpoint.json');
  const env = JSON.parse(fs.readFileSync(f, 'utf8')); env.record.head = '0'.repeat(40); fs.writeFileSync(f, JSON.stringify(env));
  const r = ok(run(['plan', '--run', 'run-g', '--root', d]), 1);
  assert.ok(r.stderr.includes('checksum'), r.stderr);
});

// ---------------------------------------------------------------------------
console.log('\n3) plan, apply, undo on a clean checkpoint');
/** the canonical scenario: a clean checkpoint, then the "run" modifies, deletes, adds+commits, leaves an untracked
 *  file, and also changes every protected path. Returns the repo. */
function scenario(tool) {
  const d = repo(BASE_FILES);
  ok(run(['checkpoint', '--run', 'run-1', '--root', d], { tool }));
  write(d, 'a.txt', 'SECRET-CONTENT-MARKER run edit\n');
  fs.unlinkSync(path.join(d, 'b.txt'));
  write(d, 'c.txt', 'added by the run\n'); g(d, 'add', 'c.txt'); g(d, 'commit', '-qm', 'run adds c');
  write(d, 'd.txt', 'untracked by the run\n');
  for (const p of PROTECTED) write(d, p, 'run touched ' + p + '\n');
  return d;
}
t('plan: exact counts and paths (modified/deleted/added), protected skipped, risk, and never any file content', () => {
  const d = scenario();
  const p = json(ok(run(['plan', '--run', 'run-1', '--root', d, '--json'])));
  assert.deepStrictEqual(p.restore.map((e) => [e.path, e.kind]).sort(), [['a.txt', 'modified'], ['b.txt', 'deleted']]);
  assert.deepStrictEqual(p.added, ['c.txt']);
  assert.strictEqual(p.counts.modified, 1); assert.strictEqual(p.counts.deleted, 1); assert.strictEqual(p.counts.added_kept, 1);
  assert.strictEqual(p.new_untracked_kept, 1); assert.strictEqual(p.commits_since, 1); assert.strictEqual(p.descendant, true);
  assert.ok(p.counts.protected_skipped >= PROTECTED.length - 1, 'protected ' + p.counts.protected_skipped); // .forge may be untracked-only
  assert.strictEqual(p.risk, 'medium');
  const text = ok(run(['plan', '--run', 'run-1', '--root', d])).stdout;
  assert.ok(!text.includes('SECRET-CONTENT-MARKER') && !p.restore.some((e) => JSON.stringify(e).includes('SECRET')), 'the plan must never print content');
  assert.ok(/restore\s+a\.txt/.test(text) && /recreate b\.txt/.test(text) && /keep\s+c\.txt/.test(text), text);
});
t('apply without --yes: exit 1, nothing changes, no backup folder', () => {
  const d = scenario();
  const r = ok(run(['apply', '--run', 'run-1', '--root', d]), 1);
  assert.ok(r.stdout.includes('--yes'), r.stdout);
  assert.strictEqual(read(d, 'a.txt'), 'SECRET-CONTENT-MARKER run edit\n'); assert.strictEqual(read(d, 'b.txt'), null);
  assert.deepStrictEqual(backups(d), []);
});
/** assertAppliedWithBackup — the apply contract the mutation check below proves is load-bearing. */
function assertAppliedWithBackup(d) {
  assert.strictEqual(read(d, 'a.txt'), 'alpha original\n', 'modified file restored');
  assert.strictEqual(read(d, 'b.txt'), 'bravo original\n', 'deleted file recreated');
  const b = backups(d);
  assert.strictEqual(b.length, 1, 'exactly one backup folder, got ' + JSON.stringify(b));
  const dir = path.join(d, '_scratch', b[0]);
  assert.strictEqual(read(dir, 'files/a.txt'), 'SECRET-CONTENT-MARKER run edit\n', 'the backup holds the copy apply overwrote');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const byPath = Object.fromEntries(m.entries.map((e) => [e.path, e]));
  assert.strictEqual(byPath['a.txt'].action, 'overwrite'); assert.strictEqual(byPath['a.txt'].before_sha256, sha('SECRET-CONTENT-MARKER run edit\n'));
  assert.strictEqual(byPath['b.txt'].action, 'recreate'); assert.strictEqual(byPath['b.txt'].before_sha256, null);
  return dir;
}
/** assertProtectedUntouched — protected paths, untracked files and run-added files are left exactly as the run left them. */
function assertProtectedUntouched(d) {
  for (const p of PROTECTED) assert.strictEqual(read(d, p), 'run touched ' + p + '\n', 'protected path touched: ' + p);
  assert.strictEqual(read(d, 'c.txt'), 'added by the run\n', 'a file the run added is kept');
  assert.strictEqual(read(d, 'd.txt'), 'untracked by the run\n', 'an untracked file is never touched');
}
t('apply --yes: restores modified + deleted from the checkpoint, writes the backup first, leaves protected/untracked/added alone, logs one event, prints the undo', () => {
  const d = scenario();
  const r = ok(run(['apply', '--run', 'run-1', '--root', d, '--yes']));
  const dir = assertAppliedWithBackup(d);
  assertProtectedUntouched(d);
  assert.ok(r.stdout.includes('undo:   node .claude/forge-bin/forge-rollback.cjs undo --backup "_scratch/' + path.basename(dir) + '" --yes'), r.stdout);
  const events = ledgerRows(d).filter((e) => e.event === 'apply');
  assert.strictEqual(events.length, 1); assert.strictEqual(events[0].restored, 2);
  assert.strictEqual(head(d), g(d, 'rev-parse', 'HEAD').trim(), 'apply never moves HEAD');
  assert.strictEqual(g(d, 'stash', 'list').trim(), '');
});
t('apply is idempotent: a second apply says nothing to restore, exits 0 and writes no second backup', () => {
  const d = scenario();
  ok(run(['apply', '--run', 'run-1', '--root', d, '--yes']));
  const r = ok(run(['apply', '--run', 'run-1', '--root', d, '--yes']));
  assert.ok(r.stdout.includes('nothing to restore'), r.stdout);
  assert.strictEqual(backups(d).length, 1);
});
t('undo puts every file back exactly as apply found it; a second undo is a no-op', () => {
  const d = scenario();
  const r = ok(run(['apply', '--run', 'run-1', '--root', d, '--yes']));
  const cmd = /undo --backup "([^"]+)" --yes/.exec(r.stdout)[1];
  ok(run(['undo', '--backup', cmd, '--yes', '--root', d]));
  assert.strictEqual(read(d, 'a.txt'), 'SECRET-CONTENT-MARKER run edit\n'); assert.strictEqual(read(d, 'b.txt'), null, 'the recreated file is removed again');
  assertProtectedUntouched(d);
  const again = ok(run(['undo', '--backup', cmd, '--yes', '--root', d]));
  assert.ok(again.stdout.includes('already as before 2'), again.stdout);
});
t('undo never clobbers an edit made AFTER the apply: that file is left alone and reported (exit 1)', () => {
  const d = scenario();
  const r = ok(run(['apply', '--run', 'run-1', '--root', d, '--yes']));
  const cmd = /undo --backup "([^"]+)" --yes/.exec(r.stdout)[1];
  write(d, 'a.txt', 'owner edit after the rollback\n');
  const u = ok(run(['undo', '--backup', cmd, '--yes', '--root', d]), 1);
  assert.ok(u.stdout.includes('a.txt (changed after the rollback'), u.stdout);
  assert.strictEqual(read(d, 'a.txt'), 'owner edit after the rollback\n');
  assert.strictEqual(read(d, 'b.txt'), null, 'the other entry was still undone');
});
t('undo refuses a folder that is not a rollback backup, a tampered manifest, and a missing --yes', () => {
  const d = scenario();
  const r = ok(run(['apply', '--run', 'run-1', '--root', d, '--yes']));
  const cmd = /undo --backup "([^"]+)" --yes/.exec(r.stdout)[1];
  ok(run(['undo', '--backup', '_scratch', '--yes', '--root', d]), 1);
  ok(run(['undo', '--backup', '../elsewhere', '--yes', '--root', d]), 1);
  ok(run(['undo', '--backup', cmd, '--root', d]), 1);
  const mf = path.join(d, ...cmd.split('/'), 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.entries[0].path = '.claude/FORGE_MEMORY.md'; fs.writeFileSync(mf, JSON.stringify(m));
  const u = ok(run(['undo', '--backup', cmd, '--yes', '--root', d]), 1);
  assert.ok(u.stderr.includes('checksum'), u.stderr);
  assert.strictEqual(read(d, '.claude/FORGE_MEMORY.md'), 'run touched .claude/FORGE_MEMORY.md\n');
});
t('a file the run deleted AND committed is recreated from the checkpoint (as a staged file: it was gone from the index)', () => {
  const d = repo({ 'a.txt': 'x\n', 'b.txt': 'keep me\n' });
  ok(run(['checkpoint', '--run', 'run-h', '--root', d]));
  g(d, 'rm', '-q', 'b.txt'); g(d, 'commit', '-qm', 'run deletes b');
  const r = ok(run(['apply', '--run', 'run-h', '--root', d, '--yes']));
  assert.strictEqual(read(d, 'b.txt'), 'keep me\n');
  assert.strictEqual(g(d, 'ls-files', '--', 'b.txt').trim(), 'b.txt', 'git tracks the file again');
  assert.deepStrictEqual(json(ok(run(['plan', '--run', 'run-h', '--root', d, '--json']))).restore, [], 'a fresh plan sees nothing left to restore');
  // undo returns to exactly the post-run state: file gone AND its index entry dropped again
  ok(run(['undo', '--backup', /undo --backup "([^"]+)" --yes/.exec(r.stdout)[1], '--yes', '--root', d]));
  assert.strictEqual(read(d, 'b.txt'), null);
  assert.strictEqual(g(d, 'ls-files', '--', 'b.txt').trim(), '');
  assert.strictEqual(g(d, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'nothing staged or modified after the undo');
});
t('paths with spaces, brackets, a leading dash and non-ASCII are restored by their exact names', () => {
  const names = ['dir with space/file [1].txt', '-dash.txt', 'café.txt'];
  const d = repo(Object.fromEntries(names.map((n) => [n, 'orig ' + n + '\n'])));
  ok(run(['checkpoint', '--run', 'run-i', '--root', d]));
  for (const n of names) write(d, n, 'changed\n');
  ok(run(['apply', '--run', 'run-i', '--root', d, '--yes']));
  for (const n of names) assert.strictEqual(read(d, n), 'orig ' + n + '\n', n);
});
/** literalScenario(tool) — a restorable file literally named notes[0-9].txt next to notes5.txt, which holds pre-run
 *  uncommitted work that the run never touched (so it must be KEPT). Read as a glob, the first path also matches
 *  notes5.txt and git would restore it to the commit, destroying that work. */
function literalScenario(tool) {
  const d = repo({ 'notes[0-9].txt': 'literal orig\n', 'notes5.txt': 'five committed\n' });
  write(d, 'notes5.txt', 'five PRE-RUN uncommitted\n');
  ok(run(['checkpoint', '--run', 'run-q', '--root', d], { tool }));
  write(d, 'notes[0-9].txt', 'literal changed by the run\n');
  ok(run(['apply', '--run', 'run-q', '--root', d, '--yes', '--force-dirty'], { tool }));
  return d;
}
const assertLiteral = (d) => {
  assert.strictEqual(read(d, 'notes[0-9].txt'), 'literal orig\n', 'the bracket-named file is restored');
  assert.strictEqual(read(d, 'notes5.txt'), 'five PRE-RUN uncommitted\n', 'a glob match must never restore a kept file');
};
t('pathspecs are LITERAL: restoring notes[0-9].txt never touches notes5.txt (kept pre-run work)', () => assertLiteral(literalScenario()));
t('a project nested inside a bigger repository only rolls back its own folder', () => {
  const d = repo({ 'outside.txt': 'outside v1\n', 'sub/in.txt': 'in v1\n', 'sub/.claude/x.md': 'x\n' });
  const sub = path.join(d, 'sub');
  ok(run(['checkpoint', '--run', 'run-j', '--root', sub]));
  write(d, 'outside.txt', 'outside changed\n'); write(d, 'sub/in.txt', 'in changed\n');
  const p = json(ok(run(['plan', '--run', 'run-j', '--root', sub, '--json'])));
  assert.deepStrictEqual(p.restore.map((e) => e.path), ['in.txt']);
  ok(run(['apply', '--run', 'run-j', '--root', sub, '--yes']));
  assert.strictEqual(read(d, 'sub/in.txt'), 'in v1\n'); assert.strictEqual(read(d, 'outside.txt'), 'outside changed\n');
});

// ---------------------------------------------------------------------------
console.log('\n4) dirty checkpoints, conflicts, divergence');
t('dirty checkpoint: apply refuses without --force-dirty — nothing changes and no backup is written', () => {
  const d = repo({ 'a.txt': 'a committed\n', 'b.txt': 'b committed\n' });
  write(d, 'a.txt', 'a PRE-RUN uncommitted\n');
  ok(run(['checkpoint', '--run', 'run-k', '--root', d]));
  write(d, 'b.txt', 'b changed by the run\n');
  const r = ok(run(['apply', '--run', 'run-k', '--root', d, '--yes']), 1);
  assert.ok(r.stdout.includes('--force-dirty'), r.stdout);
  assert.strictEqual(read(d, 'b.txt'), 'b changed by the run\n'); assert.deepStrictEqual(backups(d), []);
});
t('--force-dirty: the backup is written BEFORE the overwrite, pre-run uncommitted work that the run did not touch is KEPT', () => {
  const d = repo({ 'a.txt': 'a committed\n', 'b.txt': 'b committed\n' });
  write(d, 'a.txt', 'a PRE-RUN uncommitted\n');
  ok(run(['checkpoint', '--run', 'run-l', '--root', d]));
  write(d, 'b.txt', 'b changed by the run\n');
  const p = json(ok(run(['plan', '--run', 'run-l', '--root', d, '--json'])));
  assert.strictEqual(p.risk, 'high'); assert.deepStrictEqual(p.keptDirty, ['a.txt']);
  ok(run(['apply', '--run', 'run-l', '--root', d, '--yes', '--force-dirty']));
  assert.strictEqual(read(d, 'a.txt'), 'a PRE-RUN uncommitted\n', 'pre-run uncommitted work must survive the rollback');
  assert.strictEqual(read(d, 'b.txt'), 'b committed\n');
  assert.strictEqual(read(path.join(d, '_scratch', backups(d)[0]), 'files/b.txt'), 'b changed by the run\n');
});
t('--force-dirty on a file that was uncommitted at checkpoint AND changed since: restored to the COMMIT, backup keeps the run copy', () => {
  const d = repo({ 'a.txt': 'a committed\n' });
  write(d, 'a.txt', 'a PRE-RUN\n');
  ok(run(['checkpoint', '--run', 'run-m', '--root', d]));
  write(d, 'a.txt', 'a RUN\n');
  const p = json(ok(run(['plan', '--run', 'run-m', '--root', d, '--json'])));
  assert.deepStrictEqual(p.dirtyChanged.map((e) => e.path), ['a.txt']); assert.deepStrictEqual(p.restore, []);
  ok(run(['apply', '--run', 'run-m', '--root', d, '--yes', '--force-dirty']));
  assert.strictEqual(read(d, 'a.txt'), 'a committed\n');
  assert.strictEqual(read(path.join(d, '_scratch', backups(d)[0]), 'files/a.txt'), 'a RUN\n');
});
t('unmerged paths: plan lists the conflict and apply refuses (exit 1)', () => {
  const d = repo({ 'a.txt': 'line\n' });
  const main = g(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  g(d, 'checkout', '-q', '-b', 'feature'); write(d, 'a.txt', 'feature line\n'); g(d, 'commit', '-qam', 'f');
  g(d, 'checkout', '-q', main); write(d, 'a.txt', 'main line\n'); g(d, 'commit', '-qam', 'm');
  ok(run(['checkpoint', '--run', 'run-n', '--root', d]));
  assert.notStrictEqual(gTry(d, 'merge', 'feature').status, 0, 'the merge must conflict for this test');
  const p = json(ok(run(['plan', '--run', 'run-n', '--root', d, '--json'])));
  assert.deepStrictEqual(p.conflicts, ['a.txt']); assert.strictEqual(p.risk, 'high');
  const r = ok(run(['apply', '--run', 'run-n', '--root', d, '--yes']), 1);
  assert.ok(r.stdout.includes('unmerged'), r.stdout);
});
t('HEAD no longer a descendant of the checkpoint: apply refuses unless --allow-diverged', () => {
  const d = repo({ 'a.txt': 'v1\n' });
  ok(run(['checkpoint', '--run', 'run-o', '--root', d]));
  g(d, 'checkout', '-q', '--orphan', 'other'); write(d, 'a.txt', 'orphan\n'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'orphan root');
  const r = ok(run(['apply', '--run', 'run-o', '--root', d, '--yes']), 1);
  assert.ok(r.stdout.includes('--allow-diverged'), r.stdout);
  assert.strictEqual(read(d, 'a.txt'), 'orphan\n');
  ok(run(['apply', '--run', 'run-o', '--root', d, '--yes', '--allow-diverged']));
  assert.strictEqual(read(d, 'a.txt'), 'v1\n');
});

// ---------------------------------------------------------------------------
console.log('\n5) list, gate verdict, mutation checks');
t('list shows every checkpoint (text and --json)', () => {
  const d = repo({ 'a.txt': 'x\n' });
  ok(run(['checkpoint', '--run', 'run-p1', '--root', d])); ok(run(['checkpoint', '--run', 'run-p2', '--root', d]));
  const l = json(ok(run(['list', '--root', d, '--json'])));
  assert.deepStrictEqual(l.map((x) => x.run_id), ['run-p1', 'run-p2']);
  assert.ok(ok(run(['list', '--root', d])).stdout.includes('run-p2'));
  assert.ok(ok(run(['list', '--root', repo({ 'z.txt': 'z\n' })])).stdout.includes('no checkpoints'));
});
t('the sanctioned CLI lines trigger no hard gate in the classifier (the hook therefore allows them)', () => {
  const gate = require('./forge-actiongate.cjs');
  for (const c of ['node .claude/forge-bin/forge-rollback.cjs apply --run run-1 --yes', 'node .claude/forge-bin/forge-rollback.cjs apply --run run-1 --yes --force-dirty',
    'node .claude/forge-bin/forge-rollback.cjs undo --backup "_scratch/rollback-backup-run-1-20261024T120000000Z" --yes']) {
    assert.deepStrictEqual(gate.classify(c).matched, [], c);
  }
  assert.ok(gate.classify('git restore src/app.js').matched.includes('git-destructive'), 'the hand-typed discard is still gated');
});
/** mutant(name, from, to) -> path of a patched copy of the tool (with forge-paths.cjs beside it). */
function mutant(name, from, to) {
  const dir = path.join(TMP, 'mutant-' + name);
  fs.mkdirSync(dir, { recursive: true });
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(src.includes(from), 'mutation anchor moved: ' + from);
  fs.writeFileSync(path.join(dir, 'forge-rollback.cjs'), src.replace(from, to));
  fs.copyFileSync(path.join(__dirname, 'forge-paths.cjs'), path.join(dir, 'forge-paths.cjs'));
  return path.join(dir, 'forge-rollback.cjs');
}
t('MUTATION: a tool that skips the backup step is caught by the backup assertion', () => {
  const tool = mutant('nobackup', "const manifest = writeBackup(ctx, backupDir, id, rec.record.head, todo); // ROLLBACK-BACKUP-STEP",
    "fs.mkdirSync(backupDir, { recursive: true }); const manifest = { entries: [] }; // mutant: backup skipped");
  const d = scenario(tool);
  ok(run(['apply', '--run', 'run-1', '--root', d, '--yes'], { tool }));
  assert.throws(() => assertAppliedWithBackup(d), /backup holds the copy|overwrite|Cannot read/);
});
t('MUTATION: a tool that stops protecting memory/ledger/state paths is caught by the protected assertion', () => {
  const tool = mutant('noprotect', 'function protectedReason(ctx, rel) { // ROLLBACK-PROTECT-CHECK', 'function protectedReason(ctx, rel) { return null; // mutant');
  const d = scenario(tool);
  ok(run(['apply', '--run', 'run-1', '--root', d, '--yes'], { tool }));
  assert.throws(() => assertProtectedUntouched(d), /protected path touched/);
});

t('MUTATION: a tool that drops --literal-pathspecs restores the glob match too, and the literal assertion catches it', () => {
  const tool = mutant('globspec', "['--literal-pathspecs', 'restore',", "['restore',");
  assert.throws(() => assertLiteral(literalScenario(tool)), /glob match must never restore/);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ }
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
