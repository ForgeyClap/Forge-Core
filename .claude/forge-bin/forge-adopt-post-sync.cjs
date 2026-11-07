#!/usr/bin/env node
'use strict';
/**
 * forge-adopt-post-sync.cjs — post-sync adoption + parity gate (* spec .claude/forge-research/overhaul-2026-10-09/.md, owner addendum R11 2026-10-10).
 * Zero dependencies, no network, no LLM. It works on ANY Forge project named with --project, from any location (the
 * baseline runs BEFORE the sync, when the project does not have this tool yet).
 *
 * Commands (all take --project <dir>; --json prints the machine result; exit 0 ok/PASS · 1 FAIL/violation · 2 usage):
 *   baseline  --out <file> [--doctor-timeout <ms>] [--doctor-json <file>] [--protect-manifest <file>]
 *       BEFORE the sync. Records, OUTSIDE the project (an --out inside it is refused): the project's own doctor summary
 *       (counts, red check names, per-suite green/red — names only; "none" when the project has no doctor), the hook list
 *       + deny rules + settings.json hash, the agent files, the `forge-policy check` result, the FORGE_VERSION.json hash,
 *       the protect-manifest path, the finalize receipts (run id + sha256) and a hash map of every project file (secret-
 *       like files: size + mtime only, never read). Read-only on the project apart from what its own doctor does.
 *   parity    --baseline <file> --out <report.md> [--plan <dry-run.json>] [--protect-manifest <file>] [--batch <id>]
 *             [--doctor-json <file>] [--doctor-timeout <ms>] [--forge-sync <file>] [--record <adopt-record>]
 *       AFTER the sync. PASS only when: no suite that was green is red; every red suite/check was already red in the
 *       baseline; the hook + deny delta equals the one the dry-run plan announced; the protect manifest verifies; and every
 *       changed file is a planned ship-sync/seed file or sync bookkeeping. FAIL lists each violation in plain language.
 *       With --record it is the post-ADOPTION gate: files the adoption record wrote (unchanged since) are explained too —
 *       some post-sync reds are only fixed by the adoption itself (a project-own agent, the legacy receipts).
 *   adopt     [--apply] [--baseline <file>]
 *       Default plan-only (prints the actions). --apply, additive only, writes ONLY under <project>/.claude/:
 *       (a) registers project-own agents (agents/*.md the shipped policy does not know) in the add-only overlay
 *           config/agents/agent-tool-policy.user.json, class = the least-privileged EXISTING class that allows its tools
 *           (or its `forge_class:` frontmatter, which must exist) — otherwise skipped with the reason;
 *       (b) seeds the scribe: open items from tasks/RESUME-*.md and FORGE_TASK_HISTORY.md "open"/"TODO" lines, through
 *           the project's own `forge-scribe.cjs import-lines` (sources are only read);
 *       (c) merge-adds the project's pre-sync finalize receipts (run id + exact sha256, proven by --baseline) to
 *           config/orchestration/FORGE_LEGACY_RECEIPTS.user.json so they stay archival, never STALE;
 *       (d) APPENDS one dated "Forge-Core sync adoption" entry to FORGE_MEMORY.md (append-only, once per batch);
 *       (e) writes FORGE-SYNC-BRIEFING.md (plain Dutch: what changed, what stays, what to do first, the pickup sentence).
 *       Every write is recorded (pre/post hashes) in .claude/forge-adoption/adopt-<stamp>.json so `undo` can reverse it.
 *   integrity --baseline <file> [--record <adopt-record>] [--allow <path>]...
 *       Every memory path in the baseline is byte-identical now, except an append-only growth or merge the adoption
 *       record explains; a new memory file must be one the record created. Anything else is a violation.
 *   resume-note
 *       Prints (writes nothing) the text for the resumed session's first message.
 *   undo      --record <file> [--apply]
 *       Reverses one adoption record — refused for any file changed since (hash-checked); plan-only without --apply.
 *
 * Never touched: application code, and every memory file except the one append in FORGE_MEMORY.md. Refuses while
 * .claude/.forge-sync.lock exists (a sync is running).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BASELINE_SCHEMA = 'forge-adopt-baseline/v1';
const RECORD_SCHEMA = 'forge-adopt-record/v1';
const DEFAULT_DOCTOR_TIMEOUT_MS = 900000;
const PICKUP_SENTENCE = 'Je geheugen en alle projectbestanden zijn intact. Lees eerst FORGE_MEMORY.md, FORGE_TASK_HISTORY.md, de agent-memory en je resume-notitie, en pak daar alles weer op. Wat er veranderd is staat in het wijzigingsrapport.';
const BRIEFING_REL = 'FORGE-SYNC-BRIEFING.md'; // under .claude/
const RECORD_DIR_REL = 'forge-adoption'; // under .claude/
const OVERLAY_REL = 'config/agents/agent-tool-policy.user.json';
const LEGACY_REL = 'config/orchestration/FORGE_LEGACY_RECEIPTS.user.json';
const LEGACY_SCHEMA = 'forge-legacy-receipts/v1';
const MEMORY_REL = 'FORGE_MEMORY.md';
/** RECORD_TARGETS / SCRIBE_FILES — the ONLY write targets an adoption record may name (WP-ADOPT-R2, audit MEDIUM-1):
 *  rel -> the kinds adoptApply writes it with, and the scribe file names. A record naming anything else is forged. */
const RECORD_TARGETS = { [OVERLAY_REL]: ['json-merge', 'create'], [LEGACY_REL]: ['json-merge', 'create'], [BRIEFING_REL]: ['create'], [MEMORY_REL]: ['append'] };
const SCRIBE_FILES = ['ledger.jsonl', 'state.json', 'DIGEST.md'];
/** LEGACY_CUTOFF — mirrors forge-runcontract COMPLETION_PROOF_CUTOFF. Legacy receipts only matter for runs before
 *  it; the project's own FORGE_HARD_RULES.json value is never trusted alone (see legacyCutoff). */
const LEGACY_CUTOFF = '2026-10-09T00:00:00Z';
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ADOPT_MARK = '<!-- forge-adopt-post-sync batch=';
const WALK_SKIP_DIRS = new Set(['node_modules', '.git']);
const CLAUDE_NOT_WALKED = new Set(['forge-backups', 'forge-backups-central']); // the sync's own backups
const MAX_FILES = 200000;
const MEMORY_RES = [
  /^\.claude\/FORGE_(MEMORY|TASK_HISTORY|AGENT_LEDGER|DECISIONS|PROJECT_PROFILE)\.md$/,
  /^\.claude\/FORGE_MEMORY_ARCHIVE_[^/]+\.md$/,
  /^\.claude\/FORGE_(OWNER_PROFILE|PREF_CANDIDATES)\.json$/,
  /^\.claude\/(agent-memory|forge-runs|forge-scribe)\//,
  /^\.forge\//, // WP 2.1: the opt-in state root holds the same runs, scribe and memory as the legacy folders above
  /^\.claude\/skills\/.+\/learnings\.md$/,
  /^\.claude\/config\/.+\.user\.json$/,
  /^\.claude\/config\/forge-overrides\.json$/,
  /^tasks\//,
];
const BOOKKEEPING_ANY = new Set(['.claude/forge-sync-receipt.json', '.claude/FORGE_VERSION.json', '.claude/settings.json']);
const BOOKKEEPING_ADD = [/^\.claude\/settings\.json\.forge-bak-[^/]+$/, /^\.claude\/settings\.forge-recommended-[^/]+\.json$/, /^\.claude\/forge-sync-report-[^/]+\.md$/];

class AdoptError extends Error { constructor(msg, code) { super(msg); this.exitCode = code || 2; } }

// WP 2.1: forge-paths.cjs is optional here (guarded: a copied tool or an older resolver keeps the legacy behaviour).
// A project that opted into the .forge/ state root: finalize receipts are read from every runs folder that exists
// (.forge/runs first, then .claude/forge-runs), .forge/backups is not walked (like .claude/forge-backups), and the two
// steps that WRITE project memory (the scribe import, the FORGE_MEMORY.md append) are skipped with a reason, because
// their adoption record format names .claude/ targets only — never a write into the wrong memory location.
let forgePaths = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.layout === 'function' && typeof fp.existingStateDirs === 'function') forgePaths = fp; } catch { forgePaths = null; }
function forgeLayout(project) {
  if (!forgePaths) return false;
  try { return forgePaths.layout(project) === 'forge'; } catch { return false; }
}
function runsDirsOf(project) {
  const legacy = path.join(project, '.claude', 'forge-runs');
  if (!forgePaths) return [legacy];
  try { const d = forgePaths.existingStateDirs(project, 'runs'); return d.length ? d : [legacy]; } catch { return [legacy]; }
}
function runDirOf(project, runId) {
  for (const d of runsDirsOf(project)) if (lstat(path.join(d, runId))) return path.join(d, runId);
  return path.join(project, '.claude', 'forge-runs', runId);
}
const FORGE_LAYOUT_SKIP = 'the project uses the .forge/ state root (WP 2.1); this step only knows the legacy .claude/ location, so it is not adopted automatically — do it by hand';

// ------------------------------------------------------------------ small helpers
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => String(p).split(path.sep).join('/');
const claudeDir = (project) => path.join(project, '.claude');
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { exists: !(e && e.code === 'ENOENT'), data: null, error: e && e.code === 'ENOENT' ? null : 'unreadable (' + (e.code || e.message) + ')' }; }
  try { return { exists: true, data: JSON.parse(raw.replace(/^﻿/, '')), error: null, raw }; } catch (e) { return { exists: true, data: null, error: 'not valid JSON (' + String(e.message).split('\n')[0].slice(0, 120) + ')', raw }; }
}
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function isSecretLike(rel) {
  const segs = String(rel).split('/');
  const base = segs[segs.length - 1];
  return /^\.env(\..*)?$/i.test(base) || base === '.credentials.json' || /\.(key|pem|p12|pfx)$/i.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/i.test(base) || segs.includes('secrets');
}
const isMemoryRel = (rel) => MEMORY_RES.some((re) => re.test(rel));
function projectOf(opts) {
  if (!opts.project) throw new AdoptError('--project <dir> is required');
  const p = path.resolve(opts.project);
  const st = lstat(claudeDir(p));
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new AdoptError('not a Forge project (.claude missing, or a symlink/junction): ' + p);
  return p;
}
function refuseWhileSyncing(project) {
  if (lstat(path.join(claudeDir(project), '.forge-sync.lock'))) throw new AdoptError('a forge-sync run holds .claude/.forge-sync.lock in ' + project + ' — wait until it has finished', 1);
}
/** fileEntry(abs, rel) -> {size, sha256} | {size, mtimeMs, meta:true} (secret-like: content never read) | {symlink:true} */
function fileEntry(abs, rel) {
  const st = lstat(abs);
  if (!st) return null;
  if (st.isSymbolicLink()) return { symlink: true };
  if (!st.isFile()) return null;
  if (isSecretLike(rel)) return { size: st.size, mtimeMs: Math.round(st.mtimeMs), meta: true };
  try { return { size: st.size, sha256: sha256(fs.readFileSync(abs)) }; } catch (e) { return { unreadable: e.code || e.message }; }
}
/** WP-SYNC-R10: the ONE file-map entry for .claude/worktrees. R8 stored the child COUNT only, so swapping checkout A
 *  for checkout B (or a folder for a file of the same name) left the entry equal. Now: {size: <child count>, mtimeMs: 0, meta: true}
 *  (the R8 fields, so an R8 baseline stays readable and comparable) PLUS worktrees: WORKTREES_ENTRY_VERSION, namesHash (sha256 over
 *  the sorted "name<TAB>kind" lines of every child) and names (the first 200, for reading). Kinds: 'g:<hash>' a checkout (a folder
 *  holding a .git entry; the hash identifies that .git entry — a worktree's small gitdir FILE, 'dir' for a clone, a link target),
 *  'd' another folder, 'f:<sha256>' a plain file (content; size+mtime above 16 MB), 'l:<target>' a link, 'o' other. One readdir
 *  and one small read per child, never a walk. Two v2 entries compare count + namesHash; an R8 entry against a v2 one compares the
 *  count only (all R8 recorded) and the parity report says so. The folder name is matched case-folded on Windows/macOS. */
const WORKTREES_ENTRY_VERSION = 2;
const WORKTREES_NAMES_MAX = 200;
const WORKTREES_FILE_HASH_MAX = 16 * 1024 * 1024;
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s) => (CASE_FOLD ? String(s).toLowerCase() : String(s));
function worktreesEntry(dirAbs) {
  let list;
  try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return { size: 0, mtimeMs: 0, meta: true, worktrees: WORKTREES_ENTRY_VERSION, namesHash: 'unreadable', names: [] }; }
  const kindOf = (e) => {
    const p = path.join(dirAbs, e.name);
    if (e.isSymbolicLink()) { let t = ''; try { t = fs.readlinkSync(p); } catch { /* unreadable target */ } return 'l:' + t; }
    if (e.isDirectory()) {
      const g = lstat(path.join(p, '.git'));
      if (!g) return 'd';
      if (g.isSymbolicLink()) { let t = ''; try { t = fs.readlinkSync(path.join(p, '.git')); } catch { /* unreadable */ } return 'g:link:' + t; }
      if (g.isDirectory()) return 'g:dir';
      if (g.isFile() && g.size <= 65536) { try { return 'g:file:' + sha256(fs.readFileSync(path.join(p, '.git'))); } catch { return 'g:unreadable'; } }
      return 'g:size:' + g.size;
    }
    if (e.isFile()) {
      const st = lstat(p);
      if (st && st.size > WORKTREES_FILE_HASH_MAX) return 'f:size:' + st.size + ':' + Math.round(st.mtimeMs);
      try { return 'f:' + sha256(fs.readFileSync(p)); } catch { return 'f:unreadable'; }
    }
    return 'o';
  };
  const lines = list.map((e) => e.name + '\t' + kindOf(e)).sort();
  return { size: lines.length, mtimeMs: 0, meta: true, worktrees: WORKTREES_ENTRY_VERSION, namesHash: sha256(lines.join('\n')), names: lines.slice(0, WORKTREES_NAMES_MAX).map((l) => l.split('\t')[0]) };
}
/** fileMap(project) -> {files:{rel: entry}, truncated} — every project file except .git/, node_modules/ and the sync's
 *  own backups (.claude/forge-backups*, the lock). Symlinks are recorded, never followed. */
function fileMap(project) {
  const files = {};
  let count = 0, truncated = false;
  const walk = (dirAbs, rel) => {
    let list;
    try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (truncated) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (WALK_SKIP_DIRS.has(e.name) && e.isDirectory()) continue;
      if (rel === '.claude' && (CLAUDE_NOT_WALKED.has(e.name) || e.name === '.forge-sync.lock')) continue;
      if (rel === '.forge' && e.name === 'backups') continue; // WP 2.1: the sync's own backups in the .forge/ layout
      // WP-SYNC-R8: .claude/worktrees holds agent scratch checkouts (26H2: 98 folders, ~3.2M files, 29 GB) — never walked,
      // recorded as ONE entry (the same stance as forge-sync's protect manifest). WP-SYNC-R10: that entry now carries every
      // child's name + kind + a hash (worktreesEntry), and the folder name is matched case-folded on Windows/macOS.
      if (rel === '.claude' && fold(e.name) === 'worktrees' && e.isDirectory() && !e.isSymbolicLink()) {
        files[r] = worktreesEntry(path.join(dirAbs, e.name));
        count++;
        continue;
      }
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) { walk(abs, r); continue; }
      const ent = fileEntry(abs, r);
      if (!ent) continue;
      files[r] = ent;
      if (++count >= MAX_FILES) { truncated = true; return; }
    }
  };
  walk(project, '');
  return { files, truncated };
}
/** sameEntry(a, b) — two file-map entries describe the same thing. Secret-like files (meta): size + mtime. WP-SYNC-R10 (Codex
 *  two versioned worktrees entries also need the same child name/kind hash; an R8 count-only worktrees entry against a
 *  versioned one can only compare the count — all R8 recorded (compareFiles names that limit in its notes). */
function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a.meta || b.meta) {
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false;
    if (a.worktrees && b.worktrees) return a.namesHash === b.namesHash;
    if (a.worktrees || b.worktrees) return isR8WorktreesEntry(a.worktrees ? b : a);
    return true;
  }
  return a.sha256 === b.sha256 && a.size === b.size && !!a.symlink === !!b.symlink;
}
/** isR8WorktreesEntry(e) — the R8 shape of the worktrees entry: {size: <child count>, mtimeMs: 0, meta: true}, nothing else. */
function isR8WorktreesEntry(e) { return !!e && e.meta === true && e.mtimeMs === 0 && e.sha256 === undefined && e.worktrees === undefined && e.namesHash === undefined; }
function prefixHashOk(abs, oldEntry) {
  try { const buf = fs.readFileSync(abs); return buf.length >= oldEntry.size && sha256(buf.subarray(0, oldEntry.size)) === oldEntry.sha256; } catch { return false; }
}
function frontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return fm;
}
function nodeRun(args, cwd, timeoutMs, input) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 * 1024, input });
  return { status: r.status, signal: r.signal || null, timedOut: r.status === null && (!!r.signal || !!(r.error && r.error.code === 'ETIMEDOUT')), stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : null, ms: Date.now() - t0 };
}
const tail = (s, n) => String(s || '').split(/\r?\n/).filter(Boolean).slice(-(n || 5)).join('\n').slice(-1200);

// ------------------------------------------------------------------ measurements
/** summarizeDoctor(parsed, meta) — names and counts only (never failure text, which may quote file content). */
function summarizeDoctor(parsed, meta) {
  const out = { state: 'ok', ok: !!parsed.ok, exitCode: meta.exitCode, durationMs: meta.durationMs, checks: {}, redChecks: [], tests: null, suites: {}, redSuites: [] };
  for (const [k, v] of Object.entries(parsed.checks || {})) { const ok = !!(v && v.ok); out.checks[k] = ok; if (!ok) out.redChecks.push(k); }
  const t = parsed.checks && parsed.checks.tests;
  if (t) {
    out.tests = { suites: t.suites, passed: t.passed, failed: t.failed, suitesFailed: t.suitesFailed, suitesBlocked: t.suitesBlocked };
    const per = Array.isArray(t.perSuite) ? t.perSuite : (t.perSuite && typeof t.perSuite === 'object' ? Object.entries(t.perSuite).map(([k, s]) => Object.assign({ suite: k }, s)) : []);
    for (const s of per) {
      if (!s || !s.suite) continue;
      const st = s.timedOut ? 'blocked' : (s.ok ? 'green' : 'red');
      out.suites[s.suite] = st;
      if (st !== 'green') out.redSuites.push(s.suite);
    }
  }
  out.redChecks.sort(); out.redSuites.sort();
  return out;
}
/** doctorSummary(project, opts) — runs the project's OWN doctor (or reads --doctor-json). */
function doctorSummary(project, opts) {
  if (opts.doctorJson) {
    const j = readJson(path.resolve(opts.doctorJson));
    if (!j.data || !j.data.checks) return { state: 'unparsable', source: path.resolve(opts.doctorJson), reason: j.error || 'no "checks" in the doctor JSON' };
    return Object.assign(summarizeDoctor(j.data, { exitCode: null, durationMs: null }), { source: path.resolve(opts.doctorJson) });
  }
  const doctor = path.join(claudeDir(project), 'forge-bin', 'forge-doctor.cjs');
  if (!fs.existsSync(doctor)) return { state: 'none', reason: 'the project has no .claude/forge-bin/forge-doctor.cjs' };
  const timeoutMs = Number(opts.doctorTimeout) > 0 ? Number(opts.doctorTimeout) : DEFAULT_DOCTOR_TIMEOUT_MS;
  const r = nodeRun([doctor, '--root', project, '--json'], project, timeoutMs);
  if (r.timedOut) return { state: 'timeout', durationMs: r.ms, timeoutMs, reason: 'the doctor did not finish within ' + timeoutMs + ' ms (a suite it started may still be running)' };
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  if (!parsed || !parsed.checks) return { state: 'unparsable', exitCode: r.status, durationMs: r.ms, reason: 'no JSON report on stdout', stderrTail: tail(r.stderr, 3) };
  return Object.assign(summarizeDoctor(parsed, { exitCode: r.status, durationMs: r.ms }), { source: 'run' });
}
function hookKey(h) { return [h.event, h.matcher == null ? '' : String(h.matcher), h.command].join('\u0001'); }
/** hooksOf(project) -> {present, sha256, hooks:[{event, matcher, command}], deny:[], error} */
function hooksOf(project) {
  const f = path.join(claudeDir(project), 'settings.json');
  const j = readJson(f);
  if (!j.exists) return { present: false, sha256: null, hooks: [], deny: [], error: null };
  const out = { present: true, sha256: j.raw != null ? sha256(Buffer.from(fs.readFileSync(f))) : null, hooks: [], deny: [], error: j.error };
  const d = j.data;
  if (!d || typeof d !== 'object') return out;
  for (const [event, groups] of Object.entries(d.hooks && typeof d.hooks === 'object' ? d.hooks : {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) if (h && typeof h.command === 'string') out.hooks.push({ event, matcher: g.matcher == null ? null : String(g.matcher), command: h.command });
    }
  }
  out.deny = d.permissions && Array.isArray(d.permissions.deny) ? d.permissions.deny.filter((x) => typeof x === 'string') : [];
  out.hooks.sort((a, b) => hookKey(a).localeCompare(hookKey(b)));
  return out;
}
function agentsOf(project) {
  const dir = path.join(claudeDir(project), 'agents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { names = []; }
  return names.map((f) => { const e = fileEntry(path.join(dir, f), 'agents/' + f); return { name: f.replace(/\.md$/, ''), sha256: e && e.sha256 ? e.sha256 : null }; });
}
function policyOf(project) {
  const tool = path.join(claudeDir(project), 'forge-bin', 'forge-policy.cjs');
  if (!fs.existsSync(tool)) return { state: 'none', reason: 'no forge-policy.cjs in the project' };
  const r = nodeRun([tool, 'check', '--json', '--root', project], project, 120000);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { j = null; }
  if (!j) return { state: 'unparsable', exitCode: r.status, stderrTail: tail(r.stderr, 3) };
  return { state: 'ok', exitCode: r.status, ok: !!j.ok, applicable: j.applicable !== false, checked: j.checked, violations: (j.violations || []).map((v) => v.kind + (v.agent ? ':' + v.agent : '')).sort() };
}
function receiptsOf(project) {
  const out = [];
  const seen = new Set();
  for (const runs of runsDirsOf(project)) { // WP 2.1: one folder in a legacy project (exactly as before)
    let names = [];
    try { names = fs.readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort(); } catch { names = []; }
    for (const n of names) {
      if (seen.has(n)) continue;
      const f = path.join(runs, n, 'run-finalized.json');
      const st = lstat(f);
      if (!st || !st.isFile() || st.isSymbolicLink()) continue;
      try { out.push({ run_id: n, sha256: sha256(fs.readFileSync(f)) }); seen.add(n); } catch { /* unreadable: not recorded */ }
    }
  }
  return out;
}

// ------------------------------------------------------------------ baseline
function baseline(opts) {
  const project = projectOf(opts);
  if (!opts.out) throw new AdoptError('baseline needs --out <file> (outside the project)');
  const out = path.resolve(opts.out);
  if (isInside(out, project)) throw new AdoptError('--out must be OUTSIDE the project (the baseline belongs in the run folder, never in ' + project + ')');
  const t0 = Date.now();
  const vf = fileEntry(path.join(claudeDir(project), 'FORGE_VERSION.json'), '.claude/FORGE_VERSION.json');
  const vj = readJson(path.join(claudeDir(project), 'FORGE_VERSION.json')).data;
  const pm = opts.protectManifest ? path.resolve(opts.protectManifest) : null;
  const doctor = doctorSummary(project, opts);
  const fm = fileMap(project);
  const b = {
    schema: BASELINE_SCHEMA, project, takenAt: new Date().toISOString(),
    doctor, hooks: hooksOf(project), agents: agentsOf(project), policy: policyOf(project),
    version: { sha256: vf && vf.sha256 ? vf.sha256 : null, forge_version: vj && vj.forge_version ? vj.forge_version : null },
    protectManifest: pm ? { path: pm, sha256: (fileEntry(pm, 'x') || {}).sha256 || null } : null,
    receipts: receiptsOf(project), files: fm.files, filesTruncated: fm.truncated,
  };
  b.durationMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(b, null, 1) + '\n', 'utf8');
  return { ok: true, out, baseline: b };
}
function loadBaseline(file, project) {
  if (!file) throw new AdoptError('--baseline <file> is required');
  const j = readJson(path.resolve(file));
  if (!j.data || j.data.schema !== BASELINE_SCHEMA) throw new AdoptError('not a ' + BASELINE_SCHEMA + ' file: ' + path.resolve(file) + (j.error ? ' (' + j.error + ')' : ''));
  if (project && path.resolve(j.data.project).toLowerCase() !== path.resolve(project).toLowerCase()) throw new AdoptError('the baseline was taken for ' + j.data.project + ', not ' + project);
  return Object.assign(j.data, { _sha256: sha256(Buffer.from(j.raw, 'utf8')), _file: path.resolve(file) });
}

// ------------------------------------------------------------------ parity
function compareDoctor(before, after, v, notes) {
  if (!before || before.state === 'none') { notes.push('no doctor before the sync — suites could not be compared'); return; }
  if (!after || after.state !== 'ok') { v.push('the doctor after the sync could not be measured (' + (after ? after.state + (after.reason ? ': ' + after.reason : '') : 'missing') + ')'); return; }
  if (before.state !== 'ok') { v.push('the baseline doctor was not usable (' + before.state + ') — parity cannot be proven'); return; }
  const wasRed = (s) => before.suites[s] === 'red' || before.suites[s] === 'blocked';
  for (const s of Object.keys(after.suites).sort()) {
    if (after.suites[s] === 'green') continue;
    if (before.suites[s] === 'green') v.push('suite ' + s + ' was green before the sync and is ' + after.suites[s] + ' now');
    else if (!wasRed(s)) v.push('suite ' + s + ' is ' + after.suites[s] + ' and was not red before the sync (' + (before.suites[s] ? before.suites[s] : 'it did not exist') + ')');
  }
  for (const s of Object.keys(before.suites).sort()) if (!(s in after.suites)) notes.push('suite ' + s + ' (' + before.suites[s] + ' before) no longer runs after the sync');
  for (const k of Object.keys(after.checks).sort()) {
    if (after.checks[k]) continue;
    if (before.checks[k] === true) v.push('doctor check "' + k + '" was green before the sync and is red now');
    else if (before.checks[k] === undefined) v.push('doctor check "' + k + '" is new and red (nothing was green before it to compare)');
  }
  for (const k of Object.keys(before.checks).sort()) if (before.checks[k] === true && !(k in after.checks)) v.push('doctor check "' + k + '" was green before the sync and no longer exists');
  const fixed = before.redSuites.filter((s) => after.suites[s] === 'green');
  if (fixed.length) notes.push('red before, green now: ' + fixed.join(', '));
}
function compareHooks(before, after, plan, v, notes) {
  const set = (arr) => new Set(arr.map(hookKey));
  const b = set(before.hooks), a = set(after.hooks);
  const added = [...a].filter((k) => !b.has(k)), removed = [...b].filter((k) => !a.has(k));
  const denyAdded = after.deny.filter((d) => !before.deny.includes(d)), denyRemoved = before.deny.filter((d) => !after.deny.includes(d));
  const show = (k) => k.split('\u0001').map((x, i) => (i === 1 ? '[' + x + ']' : x)).join(' ');
  if (!plan) {
    if (added.length || removed.length || denyAdded.length || denyRemoved.length) v.push('settings.json changed (' + added.length + ' hook(s) added, ' + removed.length + ' removed, ' + denyAdded.length + ' deny rule(s) added) but no --plan was given to prove it was the announced delta');
    return;
  }
  const s = plan.settings || {};
  const expAdd = new Set((s.hooksAdded || []).map(hookKey));
  const expRem = new Set();
  for (const c of s.hooksChanged || []) if (c && c.kind === 'command-upgrade') { expAdd.add(hookKey({ event: c.event, matcher: c.matcher, command: c.to })); expRem.add(hookKey({ event: c.event, matcher: c.matcher, command: c.from })); }
  for (const k of added) if (!expAdd.has(k)) v.push('hook added that the dry-run did not announce: ' + show(k));
  for (const k of expAdd) if (!a.has(k)) v.push('hook the dry-run announced is not active after the sync: ' + show(k));
  for (const k of removed) if (!expRem.has(k)) v.push('hook removed that the dry-run did not announce: ' + show(k));
  const expDeny = new Set(s.denyAdded || []);
  for (const d of denyAdded) if (!expDeny.has(d)) v.push('deny rule added that the dry-run did not announce: ' + d);
  for (const d of expDeny) if (!after.deny.includes(d)) v.push('deny rule the dry-run announced is missing: ' + d);
  for (const d of denyRemoved) v.push('deny rule removed by the sync: ' + d);
  notes.push('settings.json: ' + added.length + ' hook command(s) added, ' + removed.length + ' removed, ' + denyAdded.length + ' deny rule(s) added (announced: ' + expAdd.size + ' / ' + expRem.size + ' / ' + expDeny.size + ')');
}
function shipcheckClassifier(project) {
  try {
    const sc = require(path.join(claudeDir(project), 'forge-bin', 'forge-shipcheck.cjs'));
    const m = sc.loadManifest(path.join(claudeDir(project), 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'));
    if (!m.rules || !m.rules.length) return null;
    return (rel) => { const r = sc.classify(m.rules, rel); return r ? r.class : null; };
  } catch { return null; }
}
/** adoptionExplains(project, rec) -> fn(rel, kind, baseEntry) -> reason|null. A post-ADOPTION parity run (--record): a file
 *  the adoption record wrote is explained when its bytes still equal what the record wrote (an append also needs the
 *  pre-sync bytes as an exact prefix); the record file itself is explained. Anything the record did not write is not. */
function adoptionExplains(project, rec) {
  if (!rec) return () => null;
  const by = new Map();
  for (const a of rec.actions || []) {
    if (!a.ok) continue;
    if (a.kind === 'scribe') { for (const [f, post] of Object.entries((a.post && a.post.files) || {})) by.set('.claude/forge-scribe/' + f, { kind: 'scribe', post }); continue; }
    by.set('.claude/' + a.rel, { kind: a.kind, post: a.post });
  }
  return (rel, kind, b) => {
    if (/^\.claude\/forge-adoption\/adopt-[^/]+\.json$/.test(rel) && kind === 'added') return 'the adoption record itself';
    const t = by.get(rel);
    if (!t || !t.post) return null;
    const abs = path.join(project, ...rel.split('/'));
    const cur = fileEntry(abs, rel);
    if (!cur || cur.sha256 !== t.post.sha256) return null;
    if (t.kind === 'append') return b && b.sha256 && prefixHashOk(abs, b) ? 'appended by the adoption record (old bytes are an exact prefix)' : null;
    return 'written by the adoption record (' + t.kind + ')';
  };
}
function compareFiles(project, base, plan, receipt, v, notes, rec) {
  const now = fileMap(project);
  const byAdoption = adoptionExplains(project, rec);
  let adopted = 0;
  if (base.filesTruncated || now.truncated) notes.push('the file map was truncated at ' + MAX_FILES + ' files — not every file was compared');
  // WP-SYNC-R10: a baseline written by R8 recorded .claude/worktrees by child COUNT only — said, never hidden
  for (const rel of Object.keys(base.files)) {
    if (fold(rel) === '.claude/worktrees' && isR8WorktreesEntry(base.files[rel]) && now.files[rel] && now.files[rel].worktrees) notes.push('the baseline recorded ' + rel + ' by child COUNT only (an older baseline) — swapping one agent checkout for another with the same count is not detected in this comparison');
  }
  const planned = new Map();
  for (const f of (plan && plan.files) || []) if (['add', 'update', 'seed-created'].includes(f.action)) planned.set('.claude/' + f.rel, f.action);
  if (!plan && receipt && Array.isArray(receipt.filesChanged)) for (const f of receipt.filesChanged) planned.set('.claude/' + f.rel, f.overrideClass === 'seed' ? 'seed-created' : 'update');
  if (!plan) notes.push('no --plan: changed files were checked against the receipt\'s filesChanged only');
  const sc = plan && plan.scaffold ? plan.scaffold : {};
  const mig = (plan && plan.migrations) || {};
  const allowMig = new Set();
  if (mig.standingRules && Array.isArray(mig.standingRules.ids) && mig.standingRules.ids.length) allowMig.add('.claude/config/orchestration/FORGE_STANDING_RULES.user.json');
  if (mig.scoutVerdicts && Array.isArray(mig.scoutVerdicts.moved) && mig.scoutVerdicts.moved.length) allowMig.add('.claude/config/orchestration/FORGE_SCOUT_VETTING.user.json');
  const removable = new Set((((plan && plan.retiredPrune) || {}).removable || []).concat(((plan && plan.orphans) || {}).unmodified || []).map((r) => '.claude/' + r));
  const classOf = shipcheckClassifier(project);
  if (!classOf) notes.push('the manifest class of each changed file could not be cross-checked (no readable shipcheck/manifest in the project)');
  const keys = new Set(Object.keys(base.files).concat(Object.keys(now.files)));
  let changedOk = 0;
  for (const rel of [...keys].sort()) {
    const b = base.files[rel], a = now.files[rel];
    if (sameEntry(b, a)) continue;
    const kind = !b ? 'added' : (!a ? 'removed' : 'changed');
    if (kind === 'removed') { if (removable.has(rel)) { changedOk++; continue; } v.push('file removed by the sync: ' + rel); continue; }
    if (planned.has(rel)) {
      const cls = classOf ? classOf(rel) : null;
      if (classOf && cls !== 'ship-sync' && cls !== 'seed-only') { v.push(kind + ' ' + rel + ' was in the plan but the manifest classifies it ' + (cls || 'unclassified') + ', not ship-sync/seed-only'); continue; }
      if (planned.get(rel) === 'seed-created' && kind !== 'added') { v.push('seed-only file ' + rel + ' was overwritten (seed-only files may only be created)'); continue; }
      changedOk++; continue;
    }
    if (BOOKKEEPING_ANY.has(rel) || (kind === 'added' && BOOKKEEPING_ADD.some((re) => re.test(rel))) || allowMig.has(rel)) { changedOk++; continue; }
    if (rel === '.gitignore' && b && b.sha256 && sc.gitignore && sc.gitignore.action === 'append' && prefixHashOk(path.join(project, '.gitignore'), b)) { changedOk++; continue; }
    if (rel === '.gitignore' && !b && sc.gitignore && sc.gitignore.action === 'create') { changedOk++; continue; }
    if (rel === 'CLAUDE.md' && !b && sc.claudeMd && sc.claudeMd.action === 'create') { changedOk++; continue; }
    if (byAdoption(rel, kind, b)) { adopted++; continue; }
    v.push(kind + ' ' + rel + ' — not a planned ship-sync/seed file and not sync bookkeeping' + (rec ? ' (nor written by the adoption record)' : ''));
  }
  notes.push(changedOk + ' changed/added file(s) explained by the plan or the sync\'s bookkeeping' + (rec ? '; ' + adopted + ' by the adoption record' : ''));
}
function verifyProtectVia(project, manifest, batch, forgeSync) {
  const tool = forgeSync ? path.resolve(forgeSync) : path.join(claudeDir(project), 'forge-bin', 'forge-sync.cjs');
  if (!fs.existsSync(tool)) return { ok: false, reason: 'no forge-sync.cjs to verify with (' + tool + ')' };
  const args = [tool, 'verify-protect', project, manifest, '--json'].concat(batch ? ['--batch', batch] : []);
  const r = nodeRun(args, project, 600000);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { j = null; }
  if (!j) return { ok: false, reason: 'verify-protect gave no JSON (exit ' + r.status + '): ' + tail(r.stderr, 3) };
  const items = [].concat((j.changed || []).map((x) => ({ kind: 'changed', key: x.key || x })), (j.added || []).map((x) => ({ kind: 'added', key: x.key || x })), (j.removed || []).map((x) => ({ kind: 'removed', key: x.key || x })));
  // WP-ADOPT-VERIFIED: verify-protect counts inventoried / verified / notVerified (forge-sync R13B); an older one only `checked`
  const num = (x) => (Number.isFinite(x) ? x : null);
  const inventoried = num(j.inventoried) !== null ? j.inventoried : (num(j.checked) !== null ? j.checked : 0);
  const notVerified = num(j.notVerified) !== null ? j.notVerified : 0;
  const verified = num(j.verified) !== null ? j.verified : Math.max(0, inventoried - notVerified);
  return { ok: !!j.ok && r.status === 0, checked: j.checked, inventoried, verified, notVerified, allowed: (j.allowed || []).length, items, problems: items.map((x) => x.kind + ' ' + x.key), batch: j.batch || batch || null };
}
/** filterProtectByAdoption(protect, project, base, rec) — post-adoption mode: a protect finding the adoption record
 *  explains (a file it wrote, unchanged since; a folder that only holds such files) is moved to `explainedByAdoption`. */
function filterProtectByAdoption(protect, project, base, rec) {
  if (!rec || !protect || !protect.items) return protect;
  const explains = adoptionExplains(project, rec);
  const fileOk = (key, kind) => !!explains(key, kind, base.files[key]);
  const keep = [], explained = [];
  const now = fileMap(project).files;
  for (const it of protect.items) {
    const isDir = !now[it.key] && Object.keys(now).some((k) => k.startsWith(it.key + '/'));
    const ok = it.kind !== 'removed' && (isDir ? Object.keys(now).filter((k) => k.startsWith(it.key + '/')).every((k) => fileOk(k, base.files[k] ? 'changed' : 'added')) : fileOk(it.key, it.kind));
    (ok ? explained : keep).push(it);
  }
  return Object.assign({}, protect, { ok: keep.length === 0 && !protect.reason, items: keep, problems: keep.map((x) => x.kind + ' ' + x.key), explainedByAdoption: explained.map((x) => x.kind + ' ' + x.key) });
}
function parity(opts) {
  const project = projectOf(opts);
  const base = loadBaseline(opts.baseline, project);
  if (!opts.out) throw new AdoptError('parity needs --out <report.md>');
  const outAbs = path.resolve(opts.out);
  if (isInside(outAbs, project) && !isInside(outAbs, claudeDir(project))) throw new AdoptError('--out inside the project must be under its .claude/');
  // L2 (WP-ADOPT-R2): never overwrite anything, and never write into a memory path
  if (lstat(outAbs)) throw new AdoptError('--out already exists (never overwritten): ' + outAbs);
  if (isInside(outAbs, project) && isMemoryRel(posix(path.relative(project, outAbs)))) throw new AdoptError('--out may not be a project memory path: ' + outAbs);
  const v = [], notes = [];
  const plan = opts.plan ? readJson(path.resolve(opts.plan)).data : null;
  if (opts.plan && !plan) v.push('the --plan file could not be read as JSON: ' + path.resolve(opts.plan));
  const receipt = readJson(path.join(claudeDir(project), 'forge-sync-receipt.json')).data;
  const after = { doctor: doctorSummary(project, opts), hooks: hooksOf(project), policy: policyOf(project), agents: agentsOf(project) };
  compareDoctor(base.doctor, after.doctor, v, notes);
  compareHooks(base.hooks, after.hooks, plan, v, notes);
  if (base.policy && base.policy.state === 'ok' && base.policy.ok && !(after.policy.state === 'ok' && after.policy.ok)) v.push('forge-policy check was OK before the sync and is not now (' + (after.policy.violations || [after.policy.state]).join(', ') + ')');
  const pm = opts.protectManifest || (base.protectManifest && base.protectManifest.path);
  const batch = opts.batch || (receipt && receipt.batchId) || null;
  const rec = opts.record ? loadRecord(opts.record, project) : null;
  if (rec) notes.push('post-adoption parity: writes of adoption record ' + path.basename(path.resolve(opts.record)) + ' count as explained');
  let protect = null;
  if (!pm) v.push('no protect manifest was given (--protect-manifest) or recorded in the baseline — protected files could not be verified');
  else {
    protect = filterProtectByAdoption(verifyProtectVia(project, path.resolve(pm), batch, opts.forgeSync), project, base, rec);
    if (protect.explainedByAdoption && protect.explainedByAdoption.length) notes.push('protect manifest: ' + protect.explainedByAdoption.length + ' finding(s) explained by the adoption record (' + protect.explainedByAdoption.slice(0, 8).join('; ') + ')');
    if (!protect.ok) v.push('protect manifest does NOT verify: ' + (protect.reason || protect.problems.slice(0, 20).join('; ')));
  }
  compareFiles(project, base, plan, receipt, v, notes, rec);
  const result = { ok: v.length === 0, verdict: v.length ? 'FAIL' : 'PASS', phase: rec ? 'after-adoption' : 'after-sync', project, batch, baseline: base._file, violations: v, notes, before: { doctor: slimDoctor(base.doctor), policy: base.policy, hooks: base.hooks.hooks.length }, after: { doctor: slimDoctor(after.doctor), policy: after.policy, hooks: after.hooks.hooks.length }, protect };
  const out = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, parityReport(result), 'utf8');
  result.report = out;
  return result;
}
function slimDoctor(d) { return d ? { state: d.state, ok: d.ok, redChecks: d.redChecks, redSuites: d.redSuites, tests: d.tests, durationMs: d.durationMs } : null; }
/** protectLine(p) — WP-ADOPT-VERIFIED: "unchanged" only for what verify-protect actually verified; not-comparable entries
 *  (unreadable on both sides, e.g. worktree scratch) are named separately and never counted as unchanged. */
function protectLine(p) {
  const verified = Number.isFinite(p.verified) ? p.verified : (Number.isFinite(p.checked) ? p.checked : 0);
  const notVerified = Number.isFinite(p.notVerified) ? p.notVerified : 0;
  return 'verified ' + verified + ' unchanged, ' + notVerified + ' not verifiable (unreadable worktree scratch)'
    + (notVerified ? ' — those ' + notVerified + ' are NOT claimed unchanged' : '') + ' (' + p.allowed + ' allowed by the batch records)';
}
function parityReport(r) {
  const L = ['# Parity gate after the Forge sync' + (r.phase === 'after-adoption' ? ' and the adoption' : '') + ' — ' + r.verdict, '', '- Project: `' + r.project + '`', '- Batch: ' + (r.batch || '(unknown)'), '- Baseline: `' + r.baseline + '`', ''];
  const dl = (d) => (!d ? 'not measured' : d.state !== 'ok' ? d.state : (d.ok ? 'all green' : 'red checks: ' + (d.redChecks.join(', ') || 'none') + ' · red suites: ' + (d.redSuites.join(', ') || 'none')) + (d.tests ? ' · tests ' + d.tests.passed + ' passed, ' + d.tests.failed + ' failed in ' + d.tests.suites + ' suites' : ''));
  L.push('## Doctor', '', '- Before: ' + dl(r.before.doctor), '- After: ' + dl(r.after.doctor), '');
  L.push('## forge-policy check', '', '- Before: ' + (r.before.policy.state === 'ok' ? (r.before.policy.ok ? 'OK' : 'RED (' + r.before.policy.violations.join(', ') + ')') : r.before.policy.state), '- After: ' + (r.after.policy.state === 'ok' ? (r.after.policy.ok ? 'OK' : 'RED (' + r.after.policy.violations.join(', ') + ')') : r.after.policy.state), '');
  L.push('## Protected files', '', r.protect ? '- ' + (r.protect.ok ? protectLine(r.protect) : 'NOT verified: ' + (r.protect.reason || r.protect.problems.slice(0, 20).join('; '))) : '- not checked', '');
  L.push('## Violations (' + r.violations.length + ')', '');
  if (!r.violations.length) L.push('- none — everything that worked before the sync still works, and nothing outside the plan changed');
  for (const x of r.violations) L.push('- ' + x);
  L.push('', '## Notes', '');
  for (const n of r.notes) L.push('- ' + n);
  if (!r.ok) L.push('', 'What to do: stop here. Roll the batch back (`forge-sync rollback "<project>" --batch ' + (r.batch || '<id>') + '`), restore any damaged protected file from the B1 backup, and report.');
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------------ adopt: planning
function shippedPolicy(project) {
  const j = readJson(path.join(claudeDir(project), 'config', 'agents', 'agent-tool-policy.json'));
  return j.data && j.data.classes && j.data.agents ? j.data : null;
}
/** inferClass(classes, tools) — the least-privileged existing class (the one forbidding the most) whose forbidden list
 *  excludes every tool; null + reason when none fits or two equally strict classes both fit. */
function inferClass(classes, tools) {
  const fits = Object.entries(classes).filter(([, c]) => !(Array.isArray(c.forbidden) ? c.forbidden : []).some((t) => tools.includes(t)))
    .map(([name, c]) => ({ name, strict: (Array.isArray(c.forbidden) ? c.forbidden : []).length })).sort((a, b) => b.strict - a.strict);
  if (!fits.length) return { cls: null, reason: 'no existing class allows the tools ' + tools.join(', ') };
  if (fits.length > 1 && fits[0].strict === fits[1].strict) return { cls: null, reason: 'two classes fit equally (' + fits[0].name + ', ' + fits[1].name + ') — set forge_class: in its frontmatter' };
  return { cls: fits[0].name, reason: null };
}
function planAgents(project) {
  const pol = shippedPolicy(project);
  if (!pol) return { actions: [], skipped: [{ step: 'agents', reason: 'config/agents/agent-tool-policy.json missing or unreadable — nothing can be registered' }] };
  const ov = readJson(path.join(claudeDir(project), ...OVERLAY_REL.split('/')));
  if (ov.exists && (!ov.data || typeof ov.data !== 'object' || Array.isArray(ov.data))) return { actions: [], skipped: [{ step: 'agents', reason: OVERLAY_REL + ' is ' + (ov.error || 'not a JSON object') + ' — never overwritten; fix it by hand' }] };
  const have = ov.data && ov.data.agents && typeof ov.data.agents === 'object' ? ov.data.agents : {};
  const dir = path.join(claudeDir(project), 'agents');
  let files = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort(); } catch { files = []; }
  const add = {}, skipped = [];
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    if (Object.prototype.hasOwnProperty.call(pol.agents, name) || Object.prototype.hasOwnProperty.call(have, name)) continue;
    const say = (reason) => skipped.push({ step: 'agents', item: name, reason });
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { say('not a plain agent file name'); continue; }
    let fm = null;
    try { fm = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { fm = null; }
    if (!fm) { say('no frontmatter'); continue; }
    const tools = String(fm.tools || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!tools.length || tools.includes('*')) { say('no explicit tools: line — the overlay needs its exact tools; register it by hand'); continue; }
    let cls;
    if (fm.forge_class) {
      if (!Object.prototype.hasOwnProperty.call(pol.classes, fm.forge_class)) { say('forge_class "' + fm.forge_class + '" is not an existing class (' + Object.keys(pol.classes).join(', ') + ')'); continue; }
      const forb = pol.classes[fm.forge_class].forbidden || [];
      if (tools.some((t) => forb.includes(t))) { say('forge_class "' + fm.forge_class + '" forbids ' + tools.filter((t) => forb.includes(t)).join(', ')); continue; }
      cls = fm.forge_class;
    } else {
      const inf = inferClass(pol.classes, tools);
      if (!inf.cls) { say(inf.reason); continue; }
      cls = inf.cls;
    }
    add[name] = Object.assign({ class: cls, tools }, fm.model ? { model: fm.model } : {}, { rationale: 'project-own agent, registered after the Forge sync by forge-adopt-post-sync (class ' + (fm.forge_class ? 'from its forge_class: line' : 'inferred: the least-privileged existing class allowing its tools') + ')' });
  }
  if (!Object.keys(add).length) return { actions: [], skipped };
  return { actions: [{ step: 'agents', rel: OVERLAY_REL, kind: ov.exists ? 'json-merge' : 'create', add, summary: Object.entries(add).map(([n, e]) => n + ' → ' + e.class).join(', ') }], skipped };
}
const OPEN_HEADING = /\b(open|todo|to do|nog te doen|openstaand\w*|volgende stap\w*|next steps?|vervolg\w*|wat nog)\b/i;
const DONE_HEADING = /\b(gedaan|done|klaar|afgerond|context|achtergrond|history|geschiedenis)\b/i;
const DONE_MARK = /\[x\]|✅|\b(done|klaar|afgerond|gesloten|opgelost)\b/i;
/** openLines(text, file, mode) -> [{text, source}] — resume note: unchecked boxes anywhere, plus list items whose NEAREST
 *  heading names open work ("Open punten", "TODO", "Nog te doen", "Volgende stappen", "Vervolg"); task history: list
 *  items or table rows naming TODO/open/openstaand. Anything marked done ([x], ✅, klaar, afgerond, ...) is left out. */
function openLines(text, file, mode) {
  const out = [];
  let inOpen = false;
  String(text).split(/\r?\n/).forEach((line, i) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { inOpen = OPEN_HEADING.test(h[2]) && !DONE_HEADING.test(h[2]); return; }
    const box = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
    const item = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    const row = /^\s*\|(.+)\|\s*$/.exec(line);
    let t = null;
    if (box) t = box[1];
    else if (mode === 'resume' && inOpen && item && !/^\[[xX]\]/.test(item[1])) t = item[1];
    else if (mode === 'history' && (item || row) && /\b(TODO|open|openstaand)\b/i.test(line) && !/^\s*\|?\s*-{3,}/.test(line)) t = (item ? item[1] : row[1].split('|').map((c) => c.trim()).filter(Boolean).join(' — '));
    if (t && !DONE_MARK.test(t) && t.replace(/[^\p{L}\p{N}]/gu, '').length >= 6) out.push({ text: t.trim(), source: file + ':' + (i + 1) });
  });
  return out;
}
function resumeNotes(project) {
  const dir = path.join(project, 'tasks');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /^RESUME-.*\.md$/i.test(e.name)).map((e) => e.name).sort(); } catch { names = []; }
  return names.map((n) => 'tasks/' + n);
}
function planScribe(project) {
  if (forgeLayout(project)) return { actions: [], skipped: [{ step: 'scribe', reason: FORGE_LAYOUT_SKIP }] };
  const items = [];
  for (const rel of resumeNotes(project)) { try { items.push(...openLines(fs.readFileSync(path.join(project, ...rel.split('/')), 'utf8'), rel, 'resume')); } catch { /* unreadable: nothing */ } }
  try { items.push(...openLines(fs.readFileSync(path.join(claudeDir(project), 'FORGE_TASK_HISTORY.md'), 'utf8'), '.claude/FORGE_TASK_HISTORY.md', 'history')); } catch { /* none */ }
  const tool = path.join(claudeDir(project), 'forge-bin', 'forge-scribe.cjs');
  if (!items.length) return { actions: [], skipped: [{ step: 'scribe', reason: 'no open items found in tasks/RESUME-*.md or FORGE_TASK_HISTORY.md' }] };
  let hasImport = false;
  try { hasImport = /case 'import-lines'/.test(fs.readFileSync(tool, 'utf8')); } catch { hasImport = false; }
  if (!hasImport) return { actions: [], skipped: [{ step: 'scribe', reason: 'the project\'s forge-scribe.cjs has no import-lines command (sync the current Forge first) — ' + items.length + ' item(s) not imported' }] };
  return { actions: [{ step: 'scribe', rel: 'forge-scribe/ledger.jsonl', kind: 'scribe', items, summary: items.length + ' open item(s) from ' + [...new Set(items.map((x) => x.source.replace(/:\d+$/, '')))].join(', ') }], skipped: [] };
}
/** receiptGeneration(buf, runId, runDir) -> {generation} | {skip: reason} — mirrors forge-finalize's receiptState shapes. */
function receiptGeneration(buf, runId, runDir) {
  let r;
  try { r = JSON.parse(buf.toString('utf8')); } catch { return { skip: 'not valid JSON' }; }
  if (!r || typeof r !== 'object' || r.run_id !== runId) return { skip: 'run_id does not match its folder' };
  if (r.schema !== 2) return { skip: 'schema ' + JSON.stringify(r.schema) + ' — no allowlistable generation (only schema 2)' };
  const has = (k) => Object.prototype.hasOwnProperty.call(r, k);
  if (!has('evidence_digest') && !has('code_commit') && !has('independent_verification') && /^[0-9a-f]{64}$/i.test(String(r.ruleset_sha256 || ''))) return { generation: 'pre-evidence', finalized_at: r.finalized_at || null };
  if (/^[0-9a-f]{64}$/i.test(String(r.evidence_digest || '')) && !fs.existsSync(path.join(runDir, 'ruleset-pinned.json'))) return { generation: 'pre-pinned-ruleset', finalized_at: r.finalized_at || null };
  return { skip: 'current generation (carries its own pinned rules) — needs no allowlist' };
}
/** legacyCutoff(project) — the EARLIER of this tool's constant and the project's completion_proof.enforcement_cutoff:
 *  the project's own FORGE_HARD_RULES.json may only make the allowlist stricter, never move the cutoff later. */
function legacyCutoff(project) {
  const j = readJson(path.join(claudeDir(project), 'config', 'orchestration', 'FORGE_HARD_RULES.json')).data;
  const v = j && j.completion_proof && j.completion_proof.enforcement_cutoff;
  const pv = typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : Infinity;
  return Math.min(Date.parse(LEGACY_CUTOFF), pv);
}
/** legacyBaselineProblem(project, base) -> reason|null — WP-ADOPT-R2 MEDIUM-2. "Proven by --baseline" is only as good as
 *  the baseline's provenance: it must live OUTSIDE the project (realpath) and have been taken BEFORE the sync
 *  (baseline.takenAt < receipt.syncedAt). TAMPER-EVIDENT, NOT TAMPER-PROOF: someone who controls the machine can still
 *  forge a baseline + receipt; this only stops the project (or a session in it) from authenticating its own receipts. */
function legacyBaselineProblem(project, base) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (base._file && isInside(real(base._file), real(project))) return 'the baseline lies inside the project — it cannot prove anything about the project\'s own receipts';
  const rc = readJson(path.join(claudeDir(project), 'forge-sync-receipt.json')).data;
  const synced = rc && STRICT_ISO.test(String(rc.syncedAt || '')) ? Date.parse(rc.syncedAt) : NaN;
  const taken = STRICT_ISO.test(String(base.takenAt || '')) ? Date.parse(base.takenAt) : NaN;
  if (!Number.isFinite(synced)) return 'no sync receipt with a valid syncedAt — the baseline cannot be shown to predate the sync';
  if (!Number.isFinite(taken) || !(taken < synced)) return 'the baseline (takenAt ' + base.takenAt + ') was not taken before the sync (syncedAt ' + rc.syncedAt + ')';
  return null;
}
function planLegacy(project, base) {
  const skipped = [];
  if (!base) return { actions: [], skipped: [{ step: 'legacy-receipts', reason: 'needs --baseline: only receipts recorded BEFORE the sync (same bytes) are allowlisted' }] };
  const prob = legacyBaselineProblem(project, base);
  if (prob) return { actions: [], skipped: [{ step: 'legacy-receipts', reason: prob + ' — nothing allowlisted' }] };
  const takenMs = Date.parse(base.takenAt), cutoffMs = legacyCutoff(project);
  const file = path.join(claudeDir(project), ...LEGACY_REL.split('/'));
  const cur = readJson(file);
  if (cur.exists && !(cur.data && cur.data.schema === LEGACY_SCHEMA && Array.isArray(cur.data.receipts))) return { actions: [], skipped: [{ step: 'legacy-receipts', reason: LEGACY_REL + ' exists but is ' + (cur.error || 'not a ' + LEGACY_SCHEMA + ' file') + ' — never overwritten' }] };
  const listed = new Set(((cur.data && cur.data.receipts) || []).map((e) => e && e.run_id + '\u0001' + String(e.sha256 || '').toLowerCase()));
  const pre = new Map((base.receipts || []).map((x) => [x.run_id, x.sha256]));
  const add = [];
  for (const rc of receiptsOf(project)) {
    const runDir = runDirOf(project, rc.run_id);
    if (!pre.has(rc.run_id)) { skipped.push({ step: 'legacy-receipts', item: rc.run_id, reason: 'not in the pre-sync baseline (written after it) — never allowlisted automatically' }); continue; }
    if (pre.get(rc.run_id) !== rc.sha256) { skipped.push({ step: 'legacy-receipts', item: rc.run_id, reason: 'its bytes changed since the baseline' }); continue; }
    if (listed.has(rc.run_id + '\u0001' + rc.sha256)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(runDir, 'run-finalized.json')); } catch { continue; }
    const g = receiptGeneration(buf, rc.run_id, runDir);
    if (g.skip) { skipped.push({ step: 'legacy-receipts', item: rc.run_id, reason: g.skip }); continue; }
    // finalized_at bounds the run start from above: it must predate the baseline AND the (stricter) legacy cutoff
    const fin = STRICT_ISO.test(String(g.finalized_at || '')) ? Date.parse(g.finalized_at) : NaN;
    if (!Number.isFinite(fin) || !(fin < takenMs)) { skipped.push({ step: 'legacy-receipts', item: rc.run_id, reason: 'finalized_at ' + JSON.stringify(g.finalized_at) + ' is missing or not before the baseline (' + base.takenAt + ')' }); continue; }
    if (!(fin < cutoffMs)) { skipped.push({ step: 'legacy-receipts', item: rc.run_id, reason: 'finalized at/after the enforcement cutoff ' + new Date(cutoffMs).toISOString() + ' — a legacy receipt cannot prove that run' }); continue; }
    add.push({ run_id: rc.run_id, sha256: rc.sha256, generation: g.generation, finalized_at: g.finalized_at, added: new Date().toISOString().slice(0, 10), by: 'forge-adopt-post-sync (post-sync adoption)', reason: 'pre-existing receipt recorded in the pre-sync baseline (sha256 ' + String(base._sha256).slice(0, 12) + '…), kept archival after the Forge-Core sync' });
  }
  if (!add.length) return { actions: [], skipped };
  return { actions: [{ step: 'legacy-receipts', rel: LEGACY_REL, kind: cur.exists ? 'json-merge' : 'create', add, summary: add.length + ' receipt(s): ' + add.map((x) => x.run_id + ' (' + x.generation + ')').join(', ') }], skipped };
}
function syncFacts(project) {
  const rc = readJson(path.join(claudeDir(project), 'forge-sync-receipt.json')).data;
  if (!rc || !rc.batchId) return { batch: null };
  const byArea = {};
  for (const f of rc.filesChanged || []) { const s = String(f.rel).split('/'); const a = s.length === 1 ? '.claude' : (s[0] === 'skills' && s.length > 2 ? 'skills/' + s[1] : s[0]); byArea[a] = (byArea[a] || 0) + 1; }
  return { batch: rc.batchId, from: rc.templateVersionFrom || null, to: rc.templateVersionTo || null, syncedAt: rc.syncedAt || null, changed: (rc.filesChanged || []).length, byArea, report: rc.report ? '.claude/' + rc.report : '.claude/forge-sync-report-' + rc.batchId + '.md', devFrom: rc.provenance && rc.provenance.devCommitFrom, devTo: rc.provenance && rc.provenance.devCommitTo };
}
function briefingText(project, facts, plan) {
  const notes = resumeNotes(project);
  const L = ['# Forge-Core sync — briefing voor deze sessie', ''];
  L.push('> ' + PICKUP_SENTENCE, '');
  L.push('## Wat er veranderd is', '');
  if (!facts.batch) L.push('- Er is geen sync-receipt gevonden; welke bestanden veranderd zijn, is daarom onbekend.');
  else {
    L.push('- Forge is bijgewerkt in batch `' + facts.batch + '`' + (facts.syncedAt ? ' (' + facts.syncedAt.slice(0, 16).replace('T', ' ') + ')' : '') + ': ' + facts.changed + ' Forge-systeembestand(en) toegevoegd of bijgewerkt.');
    L.push('- Per gebied: ' + Object.entries(facts.byArea).sort().map(([a, n]) => a + ' ' + n).join(' · '));
    if (facts.devFrom || facts.devTo) L.push('- Ontwikkelversie: ' + (facts.devFrom || 'onbekend') + ' → ' + (facts.devTo || 'onbekend') + '.');
    L.push('- Het volledige wijzigingsrapport (bestanden, hooks, deny-regels, doctor voor/na): `' + facts.report + '`.');
  }
  const done = plan.actions.map((a) => '- ' + ({ agents: 'Eigen agents geregistreerd in `.claude/' + OVERLAY_REL + '`: ', scribe: 'Notulist (scribe) gevuld met open punten uit je eigen notities: ', 'legacy-receipts': 'Oude finalize-receipts blijven archiefrecords via `.claude/' + LEGACY_REL + '`: ' }[a.step] || a.step + ': ') + a.summary);
  if (done.length) L.push('', '## Wat de adoptie heeft gedaan (alleen toegevoegd, niets overschreven)', '', ...done);
  L.push('', '## Wat hetzelfde blijft', '');
  L.push('- Je geheugen: FORGE_MEMORY.md (alleen één gedateerd adoptie-item onderaan toegevoegd), FORGE_TASK_HISTORY.md, FORGE_AGENT_LEDGER.md, FORGE_DECISIONS.md, de agent-memory, forge-runs en je learnings — byte voor byte gecontroleerd.');
  L.push('- Je eigen agents, skills, commands, `*.user.json`-instellingen en de applicatiecode zijn niet aangeraakt.');
  L.push('- Je modelroutering en je eigen regels blijven zoals ze waren.');
  L.push('', '## Wat je als eerste doet', '');
  L.push('1. Lees `.claude/FORGE_MEMORY.md`, `.claude/FORGE_TASK_HISTORY.md`, de agent-memory (`.claude/agent-memory/`) en je resume-notitie' + (notes.length ? ' (`' + notes[notes.length - 1] + '`)' : '') + '.');
  L.push('2. Lees het wijzigingsrapport' + (facts.batch ? ' (`' + facts.report + '`)' : '') + ' en deze briefing.');
  L.push('3. Bekijk de open punten van de notulist: `node .claude/forge-bin/forge-scribe.cjs list --status open` — koppel elk aan een werkpakket of zet het met een reden door (`transition R-n defer --reason "..."`).');
  L.push('4. Draai één goedkope controle-run (plan → `node .claude/forge-bin/forge-runcontract.cjs check --run <run_id>`) om te bewijzen dat het nieuwe runcontract, de notulist en het afrondrecept hier werken.');
  L.push('5. Pak daarna je werk op waar je gebleven was.');
  return L.join('\n') + '\n';
}
function memoryEntry(facts, plan, stamp) {
  const L = ['', '', ADOPT_MARK + (facts.batch || 'none') + ' -->', '## ' + stamp.slice(0, 10) + ' — Forge-Core sync adoption', ''];
  L.push('- Sync: ' + (facts.batch ? 'batch `' + facts.batch + '`, ' + facts.changed + ' Forge-systeembestand(en) bijgewerkt; rapport `' + facts.report + '`.' : 'geen sync-receipt gevonden.'));
  L.push('- Geheugen en projectbestanden intact (protect-manifest + integriteitscontrole); dit item is de enige toevoeging aan dit bestand.');
  for (const a of plan.actions.filter((x) => x.step !== 'memory' && x.step !== 'briefing')) L.push('- Adoptie ' + a.step + ': ' + a.summary + '.');
  L.push('- Briefing voor de volgende sessie: `.claude/' + BRIEFING_REL + '`.');
  return L.join('\n') + '\n';
}
/** adoptPlan(opts) -> {project, facts, actions[], skipped[]} — read-only. */
function adoptPlan(opts) {
  const project = projectOf(opts);
  refuseWhileSyncing(project);
  const base = opts.baseline ? loadBaseline(opts.baseline, project) : null;
  const facts = syncFacts(project);
  const parts = [planAgents(project), planScribe(project), planLegacy(project, base)];
  const plan = { project, facts, actions: [].concat(...parts.map((p) => p.actions)), skipped: [].concat(...parts.map((p) => p.skipped)) };
  const bf = path.join(claudeDir(project), BRIEFING_REL);
  // L3 (WP-ADOPT-R2): --now names the record file and dates the memory entry — strict ISO (UTC, Z) only
  if (opts.now != null && !(STRICT_ISO.test(String(opts.now)) && Number.isFinite(Date.parse(opts.now)) && new Date(opts.now).toISOString().slice(0, 19) === String(opts.now).slice(0, 19))) throw new AdoptError('--now must be a strict ISO timestamp like 2026-10-10T12:00:00.000Z: ' + JSON.stringify(String(opts.now)));
  const stamp = opts.now || new Date().toISOString();
  const briefing = briefingText(project, facts, plan);
  if (lstat(bf)) {
    let same = false;
    try { same = fs.readFileSync(bf, 'utf8') === briefing; } catch { same = false; }
    plan.skipped.push({ step: 'briefing', reason: same ? 'already written (identical)' : '.claude/' + BRIEFING_REL + ' already exists — kept; rename it to write a new briefing' });
  } else plan.actions.push({ step: 'briefing', rel: BRIEFING_REL, kind: 'create', text: briefing, summary: 'nieuwe briefing (Nederlands)' });
  const mf = path.join(claudeDir(project), MEMORY_REL);
  let memText = null;
  try { memText = fs.readFileSync(mf, 'utf8'); } catch { memText = null; }
  if (forgeLayout(project)) plan.skipped.push({ step: 'memory', reason: FORGE_LAYOUT_SKIP });
  else if (memText == null) plan.skipped.push({ step: 'memory', reason: 'no .claude/FORGE_MEMORY.md — nothing is created in memory files' });
  else if (memText.includes(ADOPT_MARK + (facts.batch || 'none') + ' -->')) plan.skipped.push({ step: 'memory', reason: 'FORGE_MEMORY.md already has the adoption entry for this batch' });
  else plan.actions.push({ step: 'memory', rel: MEMORY_REL, kind: 'append', text: memoryEntry(facts, plan, stamp), summary: 'één gedateerd adoptie-item onderaan' });
  plan.stamp = stamp;
  return plan;
}

// ------------------------------------------------------------------ adopt: applying (record-first, hash-checked)
/** safeTarget(project, rel) -> abs. Refuses a symlink anywhere between .claude/ and the target, and any escape. */
function safeTarget(project, rel) {
  const base = claudeDir(project);
  const abs = path.join(base, ...String(rel).split('/'));
  if (!isInside(abs, base) || abs === base) throw new AdoptError('refusing a write outside .claude/: ' + rel, 1);
  let cur = base;
  for (const seg of path.relative(base, abs).split(path.sep)) {
    cur = path.join(cur, seg);
    const st = lstat(cur);
    if (st && st.isSymbolicLink()) throw new AdoptError('refusing to write through a symlink/junction: ' + posix(path.relative(project, cur)), 1);
  }
  return abs;
}
function snap(abs) { const st = lstat(abs); if (!st) return { exists: false }; const buf = fs.readFileSync(abs); return { exists: true, sha256: sha256(buf), size: buf.length }; }
function writeAtomic(abs, data) { fs.mkdirSync(path.dirname(abs), { recursive: true }); const tmp = abs + '.adopt-' + process.pid + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, abs); }
function applyJsonMerge(project, a) {
  const abs = safeTarget(project, a.rel);
  const pre = snap(abs);
  let doc;
  if (pre.exists) {
    const raw = fs.readFileSync(abs, 'utf8');
    doc = JSON.parse(raw.replace(/^﻿/, ''));
    pre.bytesB64 = Buffer.from(raw, 'utf8').toString('base64');
  }
  if (a.step === 'agents') {
    doc = doc || { _doc: 'Project-own agents (add-only overlay on the shipped agent-tool-policy.json; never synced). Written by forge-adopt-post-sync.', agents: {} };
    doc.agents = doc.agents && typeof doc.agents === 'object' ? doc.agents : {};
    for (const [n, e] of Object.entries(a.add)) if (!Object.prototype.hasOwnProperty.call(doc.agents, n)) doc.agents[n] = e;
  } else {
    doc = doc || { schema: LEGACY_SCHEMA, _doc: 'Per-project allowlist of finalize receipts kept as archival HISTORICAL records (forge-finalize F01). Authenticated by run id AND the sha256 of the exact run-finalized.json bytes. Never shipped by forge-sync.', receipts: [] };
    const have = new Set(doc.receipts.map((e) => e && e.run_id + '\u0001' + String(e.sha256 || '').toLowerCase()));
    for (const e of a.add) if (!have.has(e.run_id + '\u0001' + e.sha256)) doc.receipts.push(e);
  }
  const now = snap(abs);
  if (now.sha256 !== pre.sha256) throw new AdoptError(a.rel + ' changed while adopting — nothing written for it', 1);
  writeAtomic(abs, JSON.stringify(doc, null, 2) + '\n');
  return { pre, post: snap(abs) };
}
function applyScribe(project, a) {
  const tool = path.join(claudeDir(project), 'forge-bin', 'forge-scribe.cjs');
  const dir = safeTarget(project, 'forge-scribe');
  const files = SCRIBE_FILES;
  const pre ={ dirExisted: !!lstat(dir), files: {} };
  for (const f of files) { const abs = path.join(dir, f); const s = snap(abs); if (s.exists && f !== 'ledger.jsonl') s.bytesB64 = fs.readFileSync(abs).toString('base64'); pre.files[f] = s; }
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: project });
  const r = spawnSync(process.execPath, [tool, 'import-lines', '--stdin', '--json'], { cwd: project, env, encoding: 'utf8', input: JSON.stringify(a.items), timeout: 120000, windowsHide: true });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { j = null; }
  if (r.status !== 0 || !j) throw new AdoptError('forge-scribe import-lines failed (exit ' + r.status + '): ' + tail(r.stderr, 3), 1);
  const post = { files: {} };
  for (const f of files) post.files[f] = snap(path.join(dir, f));
  return { pre, post, imported: j.imported.length, skippedItems: j.skipped.length, rids: j.imported.map((x) => x.rid) };
}
/** adoptApply(opts) — runs the plan; the record is written FIRST (pending) and completed after each step, so a crash
 *  leaves an exact trail. Returns {record, recordPath, done[], skipped[]}. */
function adoptApply(opts) {
  const plan = adoptPlan(opts);
  const project = plan.project;
  const stamp = plan.stamp.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const recRel = RECORD_DIR_REL + '/adopt-' + stamp + '.json';
  const recAbs = safeTarget(project, recRel);
  if (lstat(recAbs)) throw new AdoptError('adoption record ' + recRel + ' already exists — retry in a moment', 1);
  const record = { schema: RECORD_SCHEMA, project, createdAt: plan.stamp, batch: plan.facts.batch, baseline: opts.baseline ? path.resolve(opts.baseline) : null, state: 'pending', actions: [], skipped: plan.skipped };
  const save = () => writeAtomic(recAbs, JSON.stringify(record, null, 2) + '\n');
  save();
  const order = ['agents', 'legacy-receipts', 'scribe', 'briefing', 'memory'];
  for (const step of order) {
    for (const a0 of plan.actions.filter((x) => x.step === step)) {
      // the briefing and the memory entry describe what REALLY happened above (a failed step is not claimed)
      const done = { actions: record.actions.filter((x) => x.ok && ['agents', 'legacy-receipts', 'scribe'].includes(x.step)) };
      const a = a0.step === 'briefing' ? Object.assign({}, a0, { text: briefingText(project, plan.facts, done) })
        : (a0.step === 'memory' ? Object.assign({}, a0, { text: memoryEntry(plan.facts, done, plan.stamp) }) : a0);
      const entry = { step: a.step, rel: a.rel, kind: a.kind, summary: a.summary };
      try {
        if (a.kind === 'json-merge' || (a.kind === 'create' && (a.step === 'agents' || a.step === 'legacy-receipts'))) Object.assign(entry, applyJsonMerge(project, a));
        else if (a.kind === 'scribe') {
          Object.assign(entry, applyScribe(project, a));
          entry.summary = entry.imported + ' open item(s) geïmporteerd' + (entry.skippedItems ? ' (' + entry.skippedItems + ' al eerder geïmporteerd of leeg)' : '') + ' uit ' + [...new Set(a.items.map((x) => x.source.replace(/:\d+$/, '')))].join(', ') + (entry.rids.length ? ' — ' + entry.rids[0] + (entry.rids.length > 1 ? '…' + entry.rids[entry.rids.length - 1] : '') : '');
        }
        else if (a.kind === 'create') {
          const abs = safeTarget(project, a.rel);
          entry.pre = { exists: false };
          fs.writeFileSync(abs, a.text, { encoding: 'utf8', flag: 'wx' });
          entry.post = snap(abs);
        } else if (a.kind === 'append') {
          const abs = safeTarget(project, a.rel);
          const st = lstat(abs);
          if (!st || !st.isFile()) throw new AdoptError(a.rel + ' is not a regular file', 1);
          entry.pre = snap(abs);
          fs.appendFileSync(abs, a.text, 'utf8');
          entry.post = snap(abs);
        }
        entry.ok = true;
      } catch (e) { entry.ok = false; entry.error = e.message; }
      record.actions.push(entry);
      save();
    }
  }
  record.state = record.actions.every((x) => x.ok) ? 'complete' : 'partial';
  save();
  return { ok: record.state === 'complete', record, recordPath: recAbs, plan };
}

// ------------------------------------------------------------------ integrity / undo / resume-note
/** loadRecord(file, project) — WP-ADOPT-R2 MEDIUM-1: a record is accepted only from <project>/.claude/forge-adoption/
 *  (realpath containment; the folder and the file must not be symlinks/junctions), and every ok action must name one of
 *  the known targets (RECORD_TARGETS with its kind) or, for the scribe, only SCRIBE_FILES in pre.files AND post.files.
 *  A record that names anything else is refused as a whole (exit 1) — `undo` never joins an untrusted name to a path. */
function loadRecord(file, project) {
  const abs = path.resolve(file);
  if (project) {
    const dir = path.join(claudeDir(project), RECORD_DIR_REL);
    const dst = lstat(dir), fst = lstat(abs);
    if (!dst || !dst.isDirectory() || dst.isSymbolicLink() || !fst || !fst.isFile() || fst.isSymbolicLink()) throw new AdoptError('an adoption record is only accepted as a regular file in ' + dir + ' (no symlinks/junctions): ' + abs, 1);
    let real = null, realDir = null;
    try { real = fs.realpathSync(abs); realDir = fs.realpathSync(dir); } catch { real = null; }
    if (!real || path.dirname(real).toLowerCase() !== realDir.toLowerCase()) throw new AdoptError('the adoption record is not stored in ' + dir + ': ' + abs, 1);
  }
  const j = readJson(abs);
  if (!j.data || j.data.schema !== RECORD_SCHEMA) throw new AdoptError('not a ' + RECORD_SCHEMA + ' file: ' + abs);
  if (project && path.resolve(j.data.project).toLowerCase() !== path.resolve(project).toLowerCase()) throw new AdoptError('the record belongs to ' + j.data.project);
  const bad = recordProblems(j.data);
  if (bad.length) throw new AdoptError('refusing a forged/invalid adoption record ' + abs + ': ' + bad.slice(0, 5).join('; '), 1);
  return j.data;
}
function recordProblems(rec) {
  const out = [];
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!Array.isArray(rec.actions)) return ['no actions list'];
  rec.actions.forEach((a, i) => {
    if (!isObj(a) || !a.ok) return;
    const where = 'action ' + i;
    if (a.kind === 'scribe') {
      if (a.rel !== 'forge-scribe/ledger.jsonl' || !isObj(a.pre) || !isObj(a.pre.files) || !isObj(a.post) || !isObj(a.post.files)) { out.push(where + ': malformed scribe entry'); return; }
      for (const f of Object.keys(a.pre.files).concat(Object.keys(a.post.files))) if (!SCRIBE_FILES.includes(f)) out.push(where + ': scribe file name not allowed: ' + JSON.stringify(f));
      return;
    }
    const kinds = Object.prototype.hasOwnProperty.call(RECORD_TARGETS, a.rel) ? RECORD_TARGETS[a.rel] : null;
    if (!kinds) { out.push(where + ': target not allowed: ' + JSON.stringify(a.rel)); return; }
    if (!kinds.includes(a.kind)) out.push(where + ': kind ' + JSON.stringify(a.kind) + ' not allowed for ' + a.rel);
    if (!isObj(a.pre) || !isObj(a.post)) out.push(where + ': pre/post missing');
  });
  return out;
}
function integrity(opts) {
  const project = projectOf(opts);
  const base = loadBaseline(opts.baseline, project);
  const rec = opts.record ? loadRecord(opts.record, project) : null;
  const allow = new Set([].concat(opts.allow || []).map(posix));
  const touched = new Map();
  for (const a of (rec && rec.actions) || []) {
    if (!a.ok) continue;
    if (a.kind === 'scribe') { touched.set('.claude/forge-scribe/', a); continue; }
    touched.set('.claude/' + a.rel, a);
  }
  const now = fileMap(project).files;
  const v = [], ok = [];
  const mem = (m) => Object.keys(m).filter(isMemoryRel);
  // a seed-only default the SYNC created (receipt filesChanged, overrideClass 'seed') is the sync's own recorded write
  const rc = readJson(path.join(claudeDir(project), 'forge-sync-receipt.json')).data;
  const seeded = new Map(((rc && rc.filesChanged) || []).filter((f) => f && f.overrideClass === 'seed' && f.oldHash == null).map((f) => ['.claude/' + f.rel, f.newHash]));
  // L1 (WP-ADOPT-R2): a record explains a file only while its bytes still equal what the record wrote (a.post.sha256;
  // per file for the scribe) — a later edit of an adopted file is a violation, not "explained".
  const touchedFor = (rel) => {
    const t = touched.get(rel) || (rel.startsWith('.claude/forge-scribe/') ? touched.get('.claude/forge-scribe/') : null);
    if (!t || !now[rel] || !now[rel].sha256) return null;
    const post = t.kind === 'scribe' ? ((t.post && t.post.files) || {})[rel.slice('.claude/forge-scribe/'.length)] : t.post;
    return post && post.sha256 === now[rel].sha256 ? t : null;
  };
  for (const rel of mem(base.files).sort()) {
    const b = base.files[rel], a = now[rel];
    if (!a) { v.push('memory file is gone: ' + rel); continue; }
    if (sameEntry(b, a)) continue;
    const t = touchedFor(rel);
    if (t && t.kind === 'append' && b.sha256 && prefixHashOk(path.join(project, ...rel.split('/')), b)) { ok.push('appended only (old bytes are an exact prefix): ' + rel); continue; }
    if (t && (t.kind === 'json-merge' || t.kind === 'scribe')) { ok.push('merged/appended by the adoption record: ' + rel); continue; }
    if (allow.has(rel)) { ok.push('allowed by --allow: ' + rel); continue; }
    v.push('memory file changed: ' + rel);
  }
  for (const rel of mem(now).filter((r) => !base.files[r]).sort()) {
    const t = touchedFor(rel);
    if (t) { ok.push('created by the adoption record: ' + rel); continue; }
    if (seeded.has(rel) && now[rel].sha256 && now[rel].sha256 === seeded.get(rel)) { ok.push('seed-only default created by sync batch ' + rc.batchId + ' (receipt), unchanged since: ' + rel); continue; }
    if (allow.has(rel)) { ok.push('allowed by --allow: ' + rel); continue; }
    v.push('new file in a memory path, not explained by the adoption record' + (seeded.has(rel) ? ' (the sync seeded it, but it changed since)' : '') + ': ' + rel);
  }
  return { ok: v.length === 0, verdict: v.length ? 'VIOLATION' : 'INTACT', checked: mem(base.files).length, violations: v, explained: ok, record: opts.record ? path.resolve(opts.record) : null };
}
function undo(opts) {
  const project = projectOf(opts);
  refuseWhileSyncing(project);
  const rec = loadRecord(opts.record, project);
  const steps = [], conflicts = [];
  for (const a of rec.actions.slice().reverse()) {
    if (!a.ok) continue;
    if (a.kind === 'scribe') {
      const dir = safeTarget(project, 'forge-scribe');
      // names come from SCRIBE_FILES only (loadRecord already refused any other key); each target is re-checked by safeTarget
      for (const f of SCRIBE_FILES.filter((x) => a.post.files[x])) {
        const cur = snap(safeTarget(project, 'forge-scribe/' + f));
        if (cur.sha256 !== a.post.files[f].sha256) conflicts.push('forge-scribe/' + f + ' changed since the adoption');
      }
      steps.push({ a, run: () => {
        for (const f of SCRIBE_FILES.filter((x) => a.pre.files[x])) {
          const pre = a.pre.files[f];
          const abs = safeTarget(project, 'forge-scribe/' + f);
          if (!pre.exists) { try { fs.unlinkSync(abs); } catch { /* gone */ } }
          else if (f === 'ledger.jsonl') { fs.truncateSync(abs, pre.size); if (snap(abs).sha256 !== pre.sha256) throw new AdoptError('ledger truncate did not restore the old bytes', 1); }
          else writeAtomic(abs, Buffer.from(pre.bytesB64, 'base64'));
        }
        if (!a.pre.dirExisted) { try { fs.rmdirSync(dir); } catch { /* not empty: left */ } }
      } });
      continue;
    }
    const abs = safeTarget(project, a.rel);
    const cur = snap(abs);
    if (cur.sha256 !== a.post.sha256) { conflicts.push(a.rel + ' changed since the adoption'); continue; }
    steps.push({ a, run: () => {
      if (!a.pre.exists) fs.unlinkSync(abs);
      else if (a.kind === 'append') { fs.truncateSync(abs, a.pre.size); if (snap(abs).sha256 !== a.pre.sha256) throw new AdoptError('truncate did not restore ' + a.rel, 1); }
      else writeAtomic(abs, Buffer.from(a.pre.bytesB64, 'base64'));
    } });
  }
  if (conflicts.length || !opts.apply) return { ok: !conflicts.length, applied: false, conflicts, steps: steps.map((s) => s.a.step + ' ' + s.a.kind + ' ' + s.a.rel) };
  for (const s of steps) s.run();
  return { ok: true, applied: true, conflicts: [], steps: steps.map((s) => s.a.step + ' ' + s.a.kind + ' ' + s.a.rel) };
}
function resumeNote(opts) {
  const project = projectOf(opts);
  const f = syncFacts(project);
  const notes = resumeNotes(project);
  const L = ['Forge is bijgewerkt' + (f.batch ? ' (batch ' + f.batch + ', ' + f.changed + ' systeembestanden)' : '') + '. ' + PICKUP_SENTENCE];
  L.push('Wijzigingsrapport: ' + (f.batch ? f.report : '(geen sync-receipt gevonden)') + ' · Briefing: .claude/' + BRIEFING_REL + (lstat(path.join(claudeDir(project), BRIEFING_REL)) ? '' : ' (nog niet geschreven — draai eerst adopt --apply)') + ' · Resume-notitie: ' + (notes.length ? notes[notes.length - 1] : '(geen tasks/RESUME-*.md gevonden)') + '.');
  L.push('Begin met de briefing, bekijk daarna de open punten van de notulist (forge-scribe list --status open) en draai één goedkope controle-run voordat je verder bouwt.');
  return L.join('\n');
}

module.exports = {
  baseline, parity, adoptPlan, adoptApply, integrity, undo, resumeNote, summarizeDoctor, hooksOf, inferClass, openLines, receiptGeneration,
  fileMap, isMemoryRel, compareDoctor, compareHooks, parityReport, briefingText, PICKUP_SENTENCE, BRIEFING_REL, BASELINE_SCHEMA, RECORD_SCHEMA, AdoptError,
  // WP-SYNC-R10: the versioned .claude/worktrees entry and the comparison that reads it
  worktreesEntry, sameEntry, isR8WorktreesEntry, WORKTREES_ENTRY_VERSION,
};

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const o = { _: [], allow: [] };
  const bool = new Set(['json', 'apply']);
  const camel = (k) => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (bool.has(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new AdoptError('missing value for --' + k);
    if (k === 'allow') o.allow.push(v); else o[camel(k)] = v;
  }
  return o;
}
function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  const print = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
  if (cmd === 'baseline') {
    const r = baseline(o);
    const d = r.baseline.doctor;
    if (o.json) print({ ok: true, out: r.out, doctor: slimDoctor(d), hooks: r.baseline.hooks.hooks.length, agents: r.baseline.agents.length, policy: r.baseline.policy, receipts: r.baseline.receipts.length, files: Object.keys(r.baseline.files).length, durationMs: r.baseline.durationMs });
    else print('baseline written to ' + r.out + '\n  doctor: ' + (d.state === 'ok' ? (d.ok ? 'all green' : 'red checks ' + (d.redChecks.join(', ') || 'none') + ' · red suites ' + (d.redSuites.join(', ') || 'none')) : d.state) + (d.durationMs ? ' (' + Math.round(d.durationMs / 1000) + ' s)' : '')
      + '\n  hooks ' + r.baseline.hooks.hooks.length + ' · deny ' + r.baseline.hooks.deny.length + ' · agents ' + r.baseline.agents.length + ' · policy ' + (r.baseline.policy.state === 'ok' ? (r.baseline.policy.ok ? 'OK' : 'RED') : r.baseline.policy.state) + ' · receipts ' + r.baseline.receipts.length + ' · files ' + Object.keys(r.baseline.files).length);
    return 0;
  }
  if (cmd === 'parity') {
    const r = parity(o);
    if (o.json) print(r);
    else { print('parity ' + r.verdict + ' — report: ' + r.report); r.violations.forEach((x) => console.log('  ✗ ' + x)); }
    return r.ok ? 0 : 1;
  }
  if (cmd === 'adopt') {
    if (!o.apply) {
      const p = adoptPlan(o);
      if (o.json) print({ apply: false, facts: p.facts, actions: p.actions.map((a) => ({ step: a.step, rel: a.rel, kind: a.kind, summary: a.summary, items: a.items, add: a.add })), skipped: p.skipped });
      else { print('adopt plan (nothing written; add --apply) for ' + p.project); p.actions.forEach((a) => console.log('  + ' + a.step + ' ' + a.kind + ' .claude/' + a.rel + ' — ' + a.summary)); p.skipped.forEach((s) => console.log('  - skipped ' + s.step + (s.item ? ' ' + s.item : '') + ': ' + s.reason)); }
      return 0;
    }
    const r = adoptApply(o);
    if (o.json) print({ ok: r.ok, record: r.recordPath, actions: r.record.actions.map((a) => ({ step: a.step, rel: a.rel, kind: a.kind, ok: a.ok, error: a.error, summary: a.summary, imported: a.imported })), skipped: r.record.skipped });
    else { print('adopt ' + (r.ok ? 'done' : 'PARTIAL') + ' — record: ' + r.recordPath); r.record.actions.forEach((a) => console.log('  ' + (a.ok ? '✓' : '✗') + ' ' + a.step + ' ' + a.kind + ' .claude/' + a.rel + (a.ok ? ' — ' + a.summary : ' — ' + a.error))); r.record.skipped.forEach((s) => console.log('  - skipped ' + s.step + (s.item ? ' ' + s.item : '') + ': ' + s.reason)); }
    return r.ok ? 0 : 1;
  }
  if (cmd === 'integrity') {
    const r = integrity(o);
    if (o.json) print(r);
    else { print('integrity ' + r.verdict + ' — ' + r.checked + ' memory file(s) from the baseline checked'); r.explained.forEach((x) => console.log('  ok ' + x)); r.violations.forEach((x) => console.log('  ✗ ' + x)); }
    return r.ok ? 0 : 1;
  }
  if (cmd === 'resume-note') { print(resumeNote(o)); return 0; }
  if (cmd === 'undo') {
    const r = undo(o);
    if (o.json) print(r);
    else { print('undo ' + (r.applied ? 'APPLIED' : (r.ok ? 'plan (add --apply)' : 'REFUSED')) ); r.steps.forEach((s) => console.log('  ' + s)); r.conflicts.forEach((c) => console.log('  ✗ ' + c)); }
    return r.ok ? 0 : 1;
  }
  console.error('usage: forge-adopt-post-sync.cjs <baseline|parity|adopt|integrity|resume-note|undo> --project <dir> ... (see the file header)');
  return 2;
}
if (require.main === module) {
  let code = 2;
  try { code = main(process.argv.slice(2)); } catch (e) { console.error('forge-adopt-post-sync: ' + (e && e.message ? e.message : e)); code = e && e.exitCode ? e.exitCode : 2; }
  process.exitCode = code;
}
