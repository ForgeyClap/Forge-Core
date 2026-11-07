#!/usr/bin/env node
'use strict';
/**
 * forge-rollback.cjs — ROLLBACK PER RUN (WP 3.3). Zero dependencies (Node core + a plain `git` binary).
 *
 *   checkpoint --run <id>    BEFORE a run changes anything: records git HEAD, whether the tree is dirty, every
 *                            uncommitted and untracked file with its sha256, a note in the run folder (when it exists),
 *                            and a lightweight tag forge-run/<id> ONLY when the tree is clean. Never commits, never
 *                            stashes. A second call keeps the first checkpoint: the restore point never moves.
 *   plan --run <id>          what a rollback would do — the tracked files changed since the checkpoint (modified /
 *                            deleted / added, counted, paths only, never content), what is kept and why, and the risk.
 *   apply --run <id> --yes   THE ONLY DESTRUCTIVE STEP. Writes _scratch/rollback-backup-<id>-<ts>/ first (a hash-
 *                            verified copy of every file it will overwrite), then runs
 *                            `git --literal-pathspecs restore --source=<checkpoint> --worktree` for exactly those paths.
 *   undo --backup <dir> --yes  puts every file back exactly as apply found it, hash-checked (a file edited after the
 *                            apply is left alone and reported).
 *   list                     the checkpoints of this project.
 *
 * WHAT APPLY NEVER DOES: touch an untracked file; delete a file the run added (it is listed as kept); touch .forge/,
 * the Forge state folders (.claude/forge-runs, -scribe, -audit, ...), project memory (.claude/FORGE_*, LESSONS.md,
 * agent-memory/) or any ledger; restore a file that was already uncommitted at checkpoint time and is unchanged since
 * (that pre-run work is kept); run git reset / clean / checkout / stash / commit. It refuses when the checkpoint tree
 * was dirty (unless --force-dirty, and then the backup is still written first), on unmerged paths, and when HEAD is no
 * longer a descendant of the checkpoint (unless --allow-diverged). This tool is the sanctioned path: the gate hook
 * blocks a hand-typed `git restore <path>`, and documentation must point here.
 *
 * The index is left alone, with one exception: a file the run deleted AND committed is absent from the index, where a
 * worktree-only restore cannot see it, so it is restored with --staged --worktree (it comes back as a staged file);
 * undo drops exactly that index entry again (git rm --cached, which only unstages).
 * "Dirty" = a tracked file outside the protected paths has uncommitted changes (staged or not). Untracked files never
 * make a tree dirty: rollback never touches them. Storage: records + ledger in <stateDir backups>/rollback/ via
 * forge-paths.cjs (legacy .claude/forge-backups/rollback, or .forge/backups/rollback once a project opted in).
 * Exit codes: 0 ok · 1 refused / not ok · 2 usage · 3 rollback unavailable (not a git repository, no commit, no git).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' ? m : null; } catch { return null; } })();
const DEFAULT_ROOT = forgePaths && typeof forgePaths.scriptRoot === 'function' ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..');
const TOOL = 'forge-rollback.cjs';
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UNTRACKED_HASH_CAP = 5000;
const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3 };
// Forge state folders under .claude/ — mirrors forge-sync.cjs NEVER_TOUCH_DIRS (the state part); a rollback is about
// the run's WORK, never about the record of the run.
const STATE_DIRS = new Set(['forge-runs', 'forge-scribe', 'forge-research', 'forge-tickets', 'forge-index', 'forge-backups',
  'forge-backups-central', 'forge-vault', 'forge-artifacts', 'forge-mindmaps', 'forge-audit', 'forge-prd', 'forge-checkpoints',
  'forge-accounts', 'forge-beads', 'forge-codemodel', 'forge-adoption', 'forge-adopt-snapshots', 'forge-genesis-staging', 'agent-memory']);

class RollbackError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const fail = (msg, code) => { throw new RollbackError(msg, code); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
const posix = (p) => String(p).split(path.sep).join('/');

// ---------------------------------------------------------------- git
function git(cwd, args) {
  const bin = process.env.FORGE_ROLLBACK_GIT || 'git';
  const r = spawnSync(bin, ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }) });
  if (r.error && r.error.code === 'ENOENT') fail('rollback unavailable: git not found (' + bin + ')', EXIT.unavailable);
  if (r.error) fail('git failed to start: ' + r.error.message, EXIT.refused);
  return { ok: r.status === 0, code: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
}
function gitOk(cwd, args, what) {
  const r = git(cwd, args);
  if (!r.ok) fail(what + ' failed: ' + (r.err || 'exit ' + r.code), EXIT.refused);
  return r.out;
}

// ---------------------------------------------------------------- context, paths, protection
function context(opts) {
  const root = path.resolve(opts.root || DEFAULT_ROOT || process.cwd());
  if (!fs.existsSync(root)) fail('project folder not found: ' + root, EXIT.usage);
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) fail('rollback unavailable: not a git repository (' + root + ')', EXIT.unavailable);
  const gitTop = path.resolve(top.out.trim());
  const rel = posix(path.relative(realpath(gitTop), realpath(root)));
  const prefix = rel === '' ? '' : rel;
  if (prefix.startsWith('..')) fail('rollback unavailable: ' + root + ' is outside its git work tree', EXIT.unavailable);
  return { root, gitTop, prefix, dirs: stateDirs(root) };
}
function realpath(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
function stateDirs(root) {
  const fallback = { rollback: [path.join(root, '.claude', 'forge-backups', 'rollback')], runs: [path.join(root, '.claude', 'forge-runs')], extra: [] };
  if (!forgePaths) return { write: fallback.rollback[0], read: fallback.rollback, runs: fallback.runs, extra: [] };
  try {
    const active = path.join(forgePaths.stateDir(root, 'backups'), 'rollback');
    const reads = [active].concat(forgePaths.existingStateDirs(root, 'backups').map((d) => path.join(d, 'rollback')));
    const extra = [];
    for (const key of forgePaths.listKeys(root)) { try { const d = forgePaths.stateDirFor(root, key); extra.push(d.forge); if (key !== 'memory' && key !== 'state_root') extra.push(d.legacy); } catch { /* unknown key */ } }
    return { write: active, read: [...new Set(reads)], runs: forgePaths.existingStateDirs(root, 'runs'), extra };
  } catch { return { write: fallback.rollback[0], read: fallback.rollback, runs: fallback.runs, extra: [] }; }
}
/** protectedReason(ctx, rel) -> why a project-relative path is never rolled back, or null. */
function protectedReason(ctx, rel) { // ROLLBACK-PROTECT-CHECK
  const lc = rel.toLowerCase();
  const segs = lc.split('/');
  if (!rel || segs.some((s) => s === '' || s === '.' || s === '..')) return 'not a plain relative path';
  if (segs[0] === '.forge') return 'Forge state (.forge/)';
  if (segs[0] === '.git' || segs.includes('.git')) return 'git internals';
  if (segs[0] === '_scratch' && (segs[1] || '').startsWith('rollback-backup-')) return 'a rollback backup';
  if (segs[0] === '.claude') {
    if (STATE_DIRS.has(segs[1] || '')) return 'Forge state (.claude/' + segs[1] + ')';
    if (segs.length === 2 && (segs[1].startsWith('forge_') || segs[1] === 'lessons.md')) return 'project memory / state file';
    if (/ledger/.test(segs[segs.length - 1])) return 'a ledger file';
  }
  const abs = path.join(ctx.root, ...rel.split('/'));
  for (const d of ctx.dirs.extra) { const r = posix(path.relative(d, abs)); if (r === '' || (!r.startsWith('..') && !path.isAbsolute(r))) return 'Forge state (' + posix(path.relative(ctx.root, d)) + ')'; }
  return null;
}
const inScope = (ctx, p) => ctx.prefix === '' || p === ctx.prefix || p.startsWith(ctx.prefix + '/');
const projectRel = (ctx, p) => (ctx.prefix ? p.slice(ctx.prefix.length + 1) : p);
const absOf = (ctx, rel) => path.join(ctx.root, ...rel.split('/'));
function hashFile(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) return 'symlink:' + sha256(fs.readlinkSync(abs));
  if (st.isDirectory()) return 'dir';
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try { const buf = Buffer.alloc(1 << 20); let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// ---------------------------------------------------------------- records
function validRunId(id) { if (typeof id !== 'string' || !RUN_ID_RE.test(id)) fail('--run <id> is required: letters, digits, - and _ only (got ' + JSON.stringify(id) + ')', EXIT.usage); return id; }
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const recordFile = (dir, id) => path.join(dir, id + '.checkpoint.json');
function readRecord(ctx, id) {
  for (const dir of ctx.dirs.read) {
    const f = recordFile(dir, id);
    if (!fs.existsSync(f)) continue;
    let env;
    try { env = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { fail('checkpoint record unreadable: ' + f + ' (' + e.message + ')', EXIT.refused); }
    if (!env || !env.record || env._checksum !== sha256(canon(env.record))) fail('checkpoint record failed its checksum — refusing to trust it: ' + f, EXIT.refused);
    return { record: env.record, file: f };
  }
  return null;
}
function ledger(ctx, row) {
  try {
    fs.mkdirSync(ctx.dirs.write, { recursive: true });
    fs.appendFileSync(path.join(ctx.dirs.write, 'ledger.jsonl'), JSON.stringify(Object.assign({ ts: new Date().toISOString(), tool: TOOL }, row)) + '\n');
    return true;
  } catch { return false; }
}
function parseStatus(out) {
  const rows = [];
  for (const e of out.split('\0')) if (e.length > 3) rows.push({ xy: e.slice(0, 2), path: e.slice(3) });
  return rows;
}

// ---------------------------------------------------------------- checkpoint
function checkpoint(opts) {
  const ctx = context(opts);
  const id = validRunId(opts.run);
  const existing = readRecord(ctx, id);
  if (existing) return { kept: true, record: existing.record, file: existing.file };
  const head = git(ctx.gitTop, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) fail('rollback unavailable: the repository has no commit yet', EXIT.unavailable);
  const sha = head.out.trim();
  const branch = git(ctx.gitTop, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const rows = parseStatus(gitOk(ctx.gitTop, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], 'git status'));
  const dirtyFiles = [], untracked = [], skipped = [];
  let untrackedTotal = 0;
  for (const r of rows) {
    if (!inScope(ctx, r.path) || r.xy === '!!') continue;
    const rel = projectRel(ctx, r.path);
    const why = protectedReason(ctx, rel);
    if (why) { skipped.push(rel); continue; }
    if (r.xy === '??') { untrackedTotal++; if (untracked.length < UNTRACKED_HASH_CAP) untracked.push({ path: rel, sha256: hashFile(absOf(ctx, rel)) }); continue; }
    dirtyFiles.push({ path: rel, xy: r.xy, sha256: hashFile(absOf(ctx, rel)) });
  }
  const dirty = dirtyFiles.length > 0;
  let tag = null, tagNote;
  const tagName = 'forge-run/' + id;
  if (dirty) tagNote = 'no tag: the tree had uncommitted work (a tag would point at a commit that is not this state)';
  else {
    const have = git(ctx.gitTop, ['rev-parse', '-q', '--verify', 'refs/tags/' + tagName + '^{commit}']);
    if (have.ok) { tag = have.out.trim() === sha ? tagName : null; tagNote = tag ? 'tag already existed at this commit' : 'tag ' + tagName + ' already exists at another commit — left untouched'; }
    else { const t = git(ctx.gitTop, ['-c', 'tag.gpgSign=false', 'tag', tagName, sha]); tag = t.ok ? tagName : null; tagNote = t.ok ? 'lightweight tag created' : 'tag failed: ' + t.err; }
  }
  const record = { v: 1, tool: TOOL, run_id: id, created_at: new Date().toISOString(), project_root: ctx.root, git_top: ctx.gitTop, prefix: ctx.prefix,
    head: sha, branch, dirty, dirty_files: dirtyFiles, untracked, untracked_total: untrackedTotal, untracked_truncated: untrackedTotal > untracked.length,
    protected_skipped: skipped.length, tag, tag_note: tagNote };
  const file = recordFile(ctx.dirs.write, id);
  writeAtomic(file, JSON.stringify({ record, _checksum: sha256(canon(record)) }, null, 2) + '\n');
  let note = null;
  for (const runs of ctx.dirs.runs) {
    const runDir = path.join(runs, id);
    if (!fs.existsSync(runDir)) continue;
    note = path.join(runDir, 'rollback-checkpoint.json');
    writeAtomic(note, JSON.stringify({ run_id: id, created_at: record.created_at, head: sha, dirty, tag, record: posix(path.relative(ctx.root, file)),
      undo_hint: 'node .claude/forge-bin/forge-rollback.cjs plan --run ' + id }, null, 2) + '\n');
    break;
  }
  ledger(ctx, { event: 'checkpoint', run_id: id, head: sha, dirty, tag });
  return { kept: false, record, file, note };
}

// ---------------------------------------------------------------- plan
function computePlan(ctx, rec) {
  if (!git(ctx.gitTop, ['cat-file', '-e', rec.head + '^{commit}']).ok) fail('the checkpoint commit ' + rec.head + ' is gone from this repository', EXIT.refused);
  const raw = gitOk(ctx.gitTop, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', rec.head], 'git diff').split('\0');
  const dirtyAt = new Map(rec.dirty_files.map((f) => [f.path, f]));
  const out = { restore: [], dirtyChanged: [], keptDirty: [], added: [], conflicts: [], skipped: [], unrestorable: [] };
  // unmerged entries come from the index itself: `git diff <commit>` does not reliably report them as U
  const unmerged = new Set(gitOk(ctx.gitTop, ['ls-files', '-u', '-z'], 'git ls-files -u').split('\0').filter(Boolean)
    .map((l) => l.slice(l.indexOf('\t') + 1)).filter((p) => inScope(ctx, p)).map((p) => projectRel(ctx, p)));
  out.conflicts.push(...[...unmerged].filter((rel) => !protectedReason(ctx, rel)));
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i].replace(/^:/, '').split(' '), p = raw[i + 1];
    if (meta.length < 5 || !inScope(ctx, p)) continue;
    const rel = projectRel(ctx, p), status = meta[4][0], oldMode = meta[0];
    const why = protectedReason(ctx, rel);
    if (why) { out.skipped.push({ path: rel, why }); continue; }
    if (unmerged.has(rel)) continue;
    if (status === 'U') { out.conflicts.push(rel); continue; }
    if (status === 'A') { out.added.push(rel); continue; }
    if (oldMode === '160000') { out.unrestorable.push({ path: rel, why: 'a submodule' }); continue; }
    const cur = hashFile(absOf(ctx, rel));
    if (cur === 'dir' || (cur && cur.startsWith('symlink:'))) { out.unrestorable.push({ path: rel, why: cur === 'dir' ? 'is now a folder' : 'is a symlink' }); continue; }
    const entry = { path: rel, kind: status === 'D' || cur === null ? 'deleted' : 'modified', current_sha256: cur };
    const was = dirtyAt.get(rel);
    if (was && was.sha256 === cur) out.keptDirty.push(rel); // already exactly as at checkpoint time: pre-run uncommitted work, kept
    else if (was) out.dirtyChanged.push(entry);
    else out.restore.push(entry);
  }
  const nowStatus = parseStatus(gitOk(ctx.gitTop, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], 'git status'));
  const nowUntracked = new Set(nowStatus.filter((r) => r.xy === '??' && inScope(ctx, r.path)).map((r) => projectRel(ctx, r.path)));
  for (const u of rec.untracked) {
    if (protectedReason(ctx, u.path)) continue;
    const cur = hashFile(absOf(ctx, u.path));
    if (cur === null) out.unrestorable.push({ path: u.path, why: 'untracked at checkpoint, deleted since (never in git)' });
    else if (cur !== u.sha256 && nowUntracked.has(u.path)) out.unrestorable.push({ path: u.path, why: 'untracked at checkpoint, changed since (never in git)' });
  }
  const known = new Set(rec.untracked.map((u) => u.path));
  const newUntracked = [...nowUntracked].filter((p) => !known.has(p) && !protectedReason(ctx, p)).length;
  const headNow = gitOk(ctx.gitTop, ['rev-parse', 'HEAD'], 'git rev-parse').trim();
  const descendant = headNow === rec.head || git(ctx.gitTop, ['merge-base', '--is-ancestor', rec.head, headNow]).ok;
  const commitsSince = descendant ? Number(git(ctx.gitTop, ['rev-list', '--count', rec.head + '..' + headNow]).out.trim() || 0) : null;
  const restoring = new Set(out.restore.concat(out.dirtyChanged).map((e) => ctx.prefix ? ctx.prefix + '/' + e.path : e.path));
  const staged = gitOk(ctx.gitTop, ['diff', '--cached', '--name-only', '-z', '--no-renames'], 'git diff --cached').split('\0').filter((p) => restoring.has(p)).length;
  const reasons = [];
  if (rec.dirty) reasons.push('the tree had uncommitted work at checkpoint time: apply refuses unless --force-dirty');
  if (out.dirtyChanged.length) reasons.push(out.dirtyChanged.length + ' file(s) were uncommitted at checkpoint time AND changed since: --force-dirty restores them to the last COMMIT, not to their uncommitted checkpoint state (the backup keeps the current copy)');
  if (!descendant) reasons.push('HEAD is no longer a descendant of the checkpoint (branch switched or history rewritten): apply refuses unless --allow-diverged');
  if (out.conflicts.length) reasons.push(out.conflicts.length + ' unmerged path(s): finish or abort the merge first');
  if (out.added.length) reasons.push(out.added.length + ' file(s) the run added are KEPT (rollback never deletes a file)');
  if (out.unrestorable.length) reasons.push(out.unrestorable.length + ' file(s) cannot be restored (see unrestorable)');
  if (commitsSince) reasons.push(commitsSince + ' commit(s) since the checkpoint stay in history; the restored files show as changes against HEAD');
  if (staged) reasons.push(staged + ' file(s) to restore also have staged changes; the index is left as it is (unstage with git restore --staged, which only unstages)');
  const risk = (rec.dirty || !descendant || out.conflicts.length) ? 'high'
    : (out.added.length || out.unrestorable.length || commitsSince || staged || newUntracked) ? 'medium' : (out.restore.length ? 'low' : 'none');
  return Object.assign(out, { run_id: rec.run_id, checkpoint: rec.head, checkpoint_at: rec.created_at, dirty_at_checkpoint: rec.dirty, head_now: headNow,
    descendant, commits_since: commitsSince, staged_in_restore_set: staged, new_untracked_kept: newUntracked, risk, reasons,
    counts: { modified: out.restore.filter((e) => e.kind === 'modified').length, deleted: out.restore.filter((e) => e.kind === 'deleted').length,
      added_kept: out.added.length, dirty_changed: out.dirtyChanged.length, dirty_kept: out.keptDirty.length, protected_skipped: out.skipped.length,
      unrestorable: out.unrestorable.length, conflicts: out.conflicts.length } });
}
function plan(opts) {
  const ctx = context(opts);
  const id = validRunId(opts.run);
  const rec = readRecord(ctx, id);
  if (!rec) fail('no checkpoint for run ' + id + ' — take one first: node .claude/forge-bin/forge-rollback.cjs checkpoint --run ' + id, EXIT.refused);
  return computePlan(ctx, rec.record);
}

// ---------------------------------------------------------------- apply
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('.', ''); }
function apply(opts) {
  const ctx = context(opts);
  const id = validRunId(opts.run);
  const rec = readRecord(ctx, id);
  if (!rec) fail('no checkpoint for run ' + id, EXIT.refused);
  const p = computePlan(ctx, rec.record);
  if (!opts.yes) return { applied: false, refused: 'nothing changed: apply is destructive — read the plan, then add --yes', plan: p };
  if (p.conflicts.length) return { applied: false, refused: 'unmerged paths (' + p.conflicts.slice(0, 5).join(', ') + '): finish or abort the merge first', plan: p };
  if (!p.descendant && !opts.allowDiverged) return { applied: false, refused: 'HEAD is no longer a descendant of the checkpoint ' + rec.record.head.slice(0, 12) + ' — check out the branch the run worked on, or pass --allow-diverged', plan: p };
  if (rec.record.dirty && !opts.forceDirty) return { applied: false, refused: 'the tree had uncommitted work when the checkpoint was taken (' + rec.record.dirty_files.length + ' file(s)); restoring from the checkpoint COMMIT could overwrite that pre-run work. Pass --force-dirty to restore anyway — a backup of every file it overwrites is written first', plan: p };
  const todo = p.restore.concat(opts.forceDirty ? p.dirtyChanged : []);
  if (!todo.length) { ledger(ctx, { event: 'apply', run_id: id, restored: 0, note: 'nothing to restore' }); return { applied: true, restored: 0, noop: true, plan: p }; }
  const backupDir = path.join(ctx.root, '_scratch', 'rollback-backup-' + id + '-' + stamp());
  // A path the run deleted AND committed is no longer in the index, and a worktree-only restore cannot see it; those
  // come back with --staged --worktree (the index entry returns too, so git tracks the file again).
  const repoPath = (rel) => (ctx.prefix ? ctx.prefix + '/' : '') + rel;
  const indexed = new Set(gitOk(ctx.gitTop, ['ls-files', '-z'], 'git ls-files').split('\0').filter(Boolean));
  for (const e of todo) e.staged = !indexed.has(repoPath(e.path));
  const manifest = writeBackup(ctx, backupDir, id, rec.record.head, todo); // ROLLBACK-BACKUP-STEP
  let r = { ok: true, err: '' };
  for (const [staged, group] of [[false, todo.filter((e) => !e.staged)], [true, todo.filter((e) => e.staged)]]) {
    if (!group.length || !r.ok) continue;
    const specFile = path.join(backupDir, staged ? 'pathspec-staged.nul' : 'pathspec.nul');
    fs.writeFileSync(specFile, group.map((e) => repoPath(e.path)).join('\0') + '\0');
    r = git(ctx.gitTop, ['--literal-pathspecs', 'restore', '--source=' + rec.record.head].concat(staged ? ['--staged'] : [], ['--worktree', '--pathspec-from-file=' + specFile, '--pathspec-file-nul']));
  }
  for (const e of manifest.entries) e.after_sha256 = hashFile(absOf(ctx, e.path));
  writeManifest(backupDir, manifest);
  const stillDiff = new Set(gitOk(ctx.gitTop, ['diff', '--name-only', '-z', '--no-renames', rec.record.head], 'git diff').split('\0').filter(Boolean).map((x) => projectRel(ctx, x)));
  const notRestored = todo.filter((e) => stillDiff.has(e.path)).map((e) => e.path);
  const undo = 'node .claude/forge-bin/forge-rollback.cjs undo --backup "' + posix(path.relative(ctx.root, backupDir)) + '" --yes';
  ledger(ctx, { event: 'apply', run_id: id, checkpoint: rec.record.head, restored: todo.length - notRestored.length, failed: notRestored.length,
    backup: posix(path.relative(ctx.root, backupDir)), force_dirty: !!opts.forceDirty, git_ok: r.ok });
  if (!r.ok || notRestored.length) return { applied: false, refused: 'git restore did not complete (' + (r.err || notRestored.slice(0, 5).join(', ')) + ') — nothing is lost: ' + undo, backup: backupDir, undo, plan: p };
  return { applied: true, restored: todo.length, backup: backupDir, undo, plan: p };
}
/** manifestDigest(m) — sha256 over the canonical manifest WITHOUT its own _checksum key (writer and undo share it). */
function manifestDigest(m) { const body = Object.assign({}, m); delete body._checksum; return sha256(canon(body)); }
function writeManifest(dir, m) { writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({}, m, { _checksum: manifestDigest(m) }), null, 2) + '\n'); }
function writeBackup(ctx, dir, id, head, todo) {
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const entries = [];
  for (const e of todo) {
    const src = absOf(ctx, e.path), before = hashFile(src);
    if (before !== null) {
      const dst = path.join(dir, 'files', ...e.path.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      if (hashFile(dst) !== before) fail('backup copy of ' + e.path + ' does not match the original — nothing was restored', EXIT.refused);
    }
    entries.push({ path: e.path, action: before === null ? 'recreate' : 'overwrite', before_sha256: before, after_sha256: null, staged: !!e.staged });
  }
  const m = { v: 1, tool: TOOL, run_id: id, checkpoint: head, created_at: new Date().toISOString(), project_root: ctx.root, entries };
  writeManifest(dir, m);
  return m;
}

// ---------------------------------------------------------------- undo
function undo(opts) {
  const root = path.resolve(opts.root || DEFAULT_ROOT || process.cwd());
  if (!opts.backup) fail('--backup <dir> is required (the folder apply printed)', EXIT.usage);
  const dir = path.resolve(root, opts.backup);
  const scratch = realpath(path.join(root, '_scratch'));
  const rel = posix(path.relative(scratch, realpath(dir)));
  if (rel.startsWith('..') || rel.includes('/') || !rel.startsWith('rollback-backup-')) fail('not a rollback backup folder: ' + dir + ' (expected _scratch/rollback-backup-<id>-<ts>)', EXIT.refused);
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { fail('backup manifest unreadable: ' + e.message, EXIT.refused); }
  if (!m || !Array.isArray(m.entries) || m._checksum !== manifestDigest(m)) fail('backup manifest failed its checksum — refusing to trust it', EXIT.refused);
  if (!opts.yes) return { undone: false, refused: 'nothing changed: undo overwrites files — add --yes', entries: m.entries.length };
  const ctx = { root, dirs: stateDirs(root) };
  const res = { restored: [], removed: [], already: [], conflicts: [] };
  for (const e of m.entries) {
    if (protectedReason(ctx, e.path)) { res.conflicts.push(e.path + ' (protected path in manifest — refused)'); continue; }
    const abs = absOf(ctx, e.path), cur = hashFile(abs);
    if (cur === e.before_sha256) { res.already.push(e.path); continue; }
    if (cur !== e.after_sha256) { res.conflicts.push(e.path + ' (changed after the rollback — left as it is)'); continue; }
    if (e.before_sha256 === null) {
      fs.unlinkSync(abs);
      res.removed.push(e.path);
      if (e.staged) { // apply re-added this path to the index; drop exactly that entry again (unstage only, never the file)
        const gctx = context({ root });
        const u = git(gctx.gitTop, ['--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--', (gctx.prefix ? gctx.prefix + '/' : '') + e.path]);
        if (!u.ok) res.conflicts.push(e.path + ' (file removed, but its index entry could not be dropped: ' + u.err + ')');
      }
      continue;
    }
    const src = path.join(dir, 'files', ...e.path.split('/'));
    if (hashFile(src) !== e.before_sha256) { res.conflicts.push(e.path + ' (backup copy damaged — left as it is)'); continue; }
    const tmp = abs + '.forge-undo-' + process.pid;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, abs);
    res.restored.push(e.path);
  }
  ledger(ctx, { event: 'undo', run_id: m.run_id, backup: posix(path.relative(root, dir)), restored: res.restored.length, removed: res.removed.length, conflicts: res.conflicts.length });
  return Object.assign({ undone: res.conflicts.length === 0 }, res);
}

// ---------------------------------------------------------------- list
function list(opts) {
  const ctx = context(opts);
  const seen = new Map();
  for (const dir of ctx.dirs.read) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.checkpoint.json')); } catch { continue; }
    for (const n of names) {
      const id = n.slice(0, -'.checkpoint.json'.length);
      if (seen.has(id) || !RUN_ID_RE.test(id)) continue;
      try { const r = readRecord(ctx, id); seen.set(id, { run_id: id, created_at: r.record.created_at, head: r.record.head, dirty: r.record.dirty, tag: r.record.tag, file: posix(path.relative(ctx.root, r.file)) }); }
      catch (e) { seen.set(id, { run_id: id, error: e.message }); }
    }
  }
  return [...seen.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

module.exports = { checkpoint, plan, apply, undo, list, computePlan, protectedReason, context, RUN_ID_RE, EXIT, STATE_DIRS };

// ---------------------------------------------------------------- CLI
const USAGE = 'Usage: node forge-rollback.cjs checkpoint --run <id> | plan --run <id> | apply --run <id> --yes [--force-dirty] [--allow-diverged]\n'
  + '       | undo --backup <_scratch/rollback-backup-...> --yes | list   [--root <dir>] [--json]';
function parseArgs(argv) {
  const o = { cmd: argv[0] || null, json: false, yes: false, forceDirty: false, allowDiverged: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') o.run = argv[++i]; else if (a === '--root') o.root = argv[++i]; else if (a === '--backup') o.backup = argv[++i];
    else if (a === '--json') o.json = true; else if (a === '--yes') o.yes = true; else if (a === '--force-dirty') o.forceDirty = true;
    else if (a === '--allow-diverged') o.allowDiverged = true; else o.bad = a;
  }
  return o;
}
function printPlan(p) {
  const c = p.counts, lines = ['rollback plan for run ' + p.run_id + ' — checkpoint ' + p.checkpoint.slice(0, 12) + ' (' + p.checkpoint_at + ')',
    '  would restore: ' + (c.modified + c.deleted) + ' file(s) — modified ' + c.modified + ', deleted ' + c.deleted + (c.dirty_changed ? ', +' + c.dirty_changed + ' only with --force-dirty' : ''),
    '  kept as is: added ' + c.added_kept + ', uncommitted-before-the-run ' + c.dirty_kept + ', protected ' + c.protected_skipped + ', new untracked ' + p.new_untracked_kept + ', cannot restore ' + c.unrestorable,
    '  risk: ' + p.risk.toUpperCase()];
  for (const e of p.restore.concat(p.dirtyChanged).slice(0, 50)) lines.push('    ' + (e.kind === 'deleted' ? 'recreate ' : 'restore  ') + e.path);
  for (const a of p.added.slice(0, 20)) lines.push('    keep     ' + a + '  (added by the run)');
  for (const u of p.unrestorable.slice(0, 20)) lines.push('    cannot   ' + u.path + '  (' + u.why + ')');
  for (const r of p.reasons) lines.push('  - ' + r);
  return lines.join('\n');
}
function main(argv) {
  const o = parseArgs(argv);
  const out = (obj, text) => console.log(o.json ? JSON.stringify(obj, null, 2) : text);
  if (o.bad || !['checkpoint', 'plan', 'apply', 'undo', 'list'].includes(o.cmd)) { console.error((o.bad ? 'unknown argument: ' + o.bad + '\n' : '') + USAGE); return EXIT.usage; }
  try {
    if (o.cmd === 'checkpoint') {
      const r = checkpoint(o);
      out(r, (r.kept ? 'checkpoint already recorded for run ' + r.record.run_id + ' at ' + r.record.created_at + ' — kept (the restore point never moves)'
        : 'checkpoint recorded for run ' + r.record.run_id) + ': HEAD ' + r.record.head.slice(0, 12) + ', tree ' + (r.record.dirty ? 'DIRTY (' + r.record.dirty_files.length + ' uncommitted file(s))' : 'clean')
        + ', tag ' + (r.record.tag || 'none') + ' (' + r.record.tag_note + ')' + (r.note ? '\n  run folder note: ' + r.note : ''));
      return EXIT.ok;
    }
    if (o.cmd === 'plan') { const p = plan(o); out(p, printPlan(p)); return EXIT.ok; }
    if (o.cmd === 'apply') {
      const r = apply(o);
      if (!r.applied) { out(r, 'REFUSED: ' + r.refused + '\n' + printPlan(r.plan)); return EXIT.refused; }
      out(r, r.noop ? 'nothing to restore — the tracked files already match the checkpoint (run ' + r.plan.run_id + ')'
        : 'restored ' + r.restored + ' file(s) from checkpoint ' + r.plan.checkpoint.slice(0, 12) + '\n  backup: ' + r.backup + '\n  undo:   ' + r.undo);
      return EXIT.ok;
    }
    if (o.cmd === 'undo') {
      const r = undo(o);
      if (r.refused) { out(r, 'REFUSED: ' + r.refused); return EXIT.refused; }
      out(r, 'undo: restored ' + r.restored.length + ', removed ' + r.removed.length + ', already as before ' + r.already.length + (r.conflicts.length ? '\n  left alone: ' + r.conflicts.join('; ') : ''));
      return r.undone ? EXIT.ok : EXIT.refused;
    }
    const l = list(o);
    out(l, l.length ? l.map((x) => x.error ? x.run_id + '  ERROR ' + x.error : x.run_id + '  ' + x.created_at + '  ' + String(x.head).slice(0, 12) + '  ' + (x.dirty ? 'dirty' : 'clean') + '  ' + (x.tag || '-')).join('\n') : 'no checkpoints');
    return EXIT.ok;
  } catch (e) {
    if (!(e instanceof RollbackError)) throw e;
    console.error('forge-rollback: ' + e.message);
    return e.code;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
