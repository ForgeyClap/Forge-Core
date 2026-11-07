#!/usr/bin/env node
'use strict';
/**
 * forge-secret-scrub.cjs — ADVISORY secret/PII scanner for RUNTIME artifacts. Zero-dependency,
 * Windows-safe. Reuses the SINGLE source of truth for secret patterns — forge-store.cjs's hardened
 * SECRET_PATTERNS (the exact set forge-doctor's leak-scan already trusts) — so there is only ever one
 * pattern list to maintain, never a drifting copy.
 *
 * WHY it is NOT redundant with forge-doctor's leak scan: the doctor scans git-TRACKED source files. This
 * scans RUNTIME artifacts, most notably `.claude/forge-runs/<id>/events.jsonl` — deliberately NOT
 * git-tracked (see .gitignore's forge-runs ignore rule; NOTE: never write a literal "star-slash" glob
 * inside this block comment — it closes the comment early and breaks the file) and therefore never
 * reached by that scan, where a leaked key or token could quietly accumulate across runs.
 * CORRECTION (wp7 triage):
 * an earlier version of this comment also claimed the `.claude/FORGE_*.md` memory files were "deliberately
 * NOT git-tracked" — that was wrong. Those files ARE git-tracked (no .gitignore rule covers them) and are
 * therefore already covered by the doctor's leak scan; scanning them here is redundant belt-and-suspenders,
 * not the genuine gap. `events.jsonl` is the one real, uncovered target this tool exists for.
 *
 * SECURITY / HONESTY: it reports ONLY the location — { file, line, pattern } — and NEVER the matched secret
 * text (identical discipline to the doctor's leakScan). Per-line scanning (ReDoS-hardened, mirrors the
 * doctor's per-regel approach). It is ADVISORY (scan-and-report) — it changes NOTHING and blocks NOTHING,
 * consistent with Forge's security-light "no mandatory gates" posture. An owner who wants it to fire on every
 * write can wire it as an opt-in PostToolUse hook — see config/orchestration/HOOKS_OPT_IN.md (shipped
 * DISABLED). The non-zero exit on findings is only so such an opt-in hook COULD gate on it if the owner chooses.
 *
 * MODEL (pure scanners are testable without the real project):
 *   scanText(text, label)     -> [{ file:label, line, pattern }]   (pattern = "secret-pattern#<i>", never the secret)
 *   scanFile(file, label?)    -> hits[] for one file (unreadable file -> [])
 *   defaultTargets(claudeDir?) -> runtime artifacts to scan (events.jsonl across runs + memory files incl. LESSONS.md,
 *                                the rotated history in FORGE_*_ARCHIVE_*.md — and forge-memory-consolidate
 *                                moved old memory there — and agent-memory/<agent>/lessons-archive-*.md)
 *   memoryArchiveFiles(dir)   -> sorted FORGE_*_ARCHIVE_*.md regular files directly in <dir> (no recursion)
 *   lessonsArchiveFiles(cdir) -> sorted agent-memory/<agent>/lessons-archive-*.md regular files (one level deep)
 *   scan(files?)              -> { scanned, hits, clean }          (files omitted -> defaultTargets())
 *
 * CLI (exit: 0 = clean · 3 = finding(s) — advisory, never a hard block · 2 = usage):
 *   node forge-secret-scrub.cjs [file ...] [--json]     (no files -> scan runtime artifacts by default)
 */
const fs = require('fs');
const path = require('path');
const store = require('./forge-store.cjs');

const PATTERNS = Array.isArray(store.SECRET_PATTERNS) ? store.SECRET_PATTERNS : [];
// WP 2.1 (opt-in .forge layout): the default targets come from forge-paths.cjs — run logs from EVERY run folder that
// exists and memory files from EVERY memory folder (.forge/memory and the legacy .claude), so a partly migrated project
// is scanned in full; a project without .forge scans exactly the legacy paths, in the same order. agent-memory/ stays
// in .claude. Guarded: an older or missing forge-paths.cjs keeps the legacy literals. The scribe inbox is redacted at
// capture by forge-scribe-store.cjs through this module's patterns (path-independent), as before.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.existingStateDirs === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function viaForgePaths(fn, legacy) { if (forgePaths) { try { return fn(forgePaths); } catch { /* unresolvable root or canon: legacy */ } } return legacy(); }
const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT)
  : viaForgePaths((P) => P.scriptRoot(__dirname), () => path.resolve(__dirname, '..', '..'));
// LESSONS.md (WP 1.9): the distilled lessons table forge-memory-consolidate.cjs builds from memory text.
const MEMORY_FILES = ['FORGE_MEMORY.md', 'FORGE_DECISIONS.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_PROJECT_PROFILE.md', 'LESSONS.md'];
// the memory rotation moves old FORGE_MEMORY.md history into dated archive files next to it.
// WP 1.9: forge-memory-consolidate.cjs (WP 1.4) rotates FORGE_TASK_HISTORY / FORGE_AGENT_LEDGER /
// FORGE_DECISIONS.md the same way (FORGE_<NAME>_ARCHIVE_<YYYY-MM>[-b].md), so every FORGE_*_ARCHIVE_*.md is scanned.
const MEMORY_ARCHIVE_RE = /^FORGE_[A-Z][A-Z_]*_ARCHIVE_[A-Za-z0-9_.-]+\.md$/;
// ... and moves an over-long agent-memory/<boss>/MEMORY.md verbatim to lessons-archive-<YYYY-MM-DD>[-b].md beside it.
const LESSONS_ARCHIVE_RE = /^lessons-archive-[A-Za-z0-9_.-]+\.md$/;

/** memoryArchiveFiles(dir) -> absolute paths of the FORGE_*_ARCHIVE_*.md regular files in dir, sorted; [] when unreadable. */
function memoryArchiveFiles(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile() && MEMORY_ARCHIVE_RE.test(e.name)).map((e) => e.name).sort().map((n) => path.join(dir, n));
}

/** lessonsArchiveFiles(claudeDir) -> absolute paths of the lessons-archive-*.md regular files one level inside
 *  <claudeDir>/agent-memory/<agent>/ (real directories only, a symlinked folder is skipped), sorted by agent then
 *  name; [] when agent-memory/ is absent or unreadable. */
function lessonsArchiveFiles(claudeDir) {
  const base = path.join(claudeDir, 'agent-memory');
  let agents; try { agents = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const a of agents.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    let entries; try { entries = fs.readdirSync(path.join(base, a), { withFileTypes: true }); } catch { continue; }
    for (const n of entries.filter((e) => e.isFile() && LESSONS_ARCHIVE_RE.test(e.name)).map((e) => e.name).sort()) out.push(path.join(base, a, n));
  }
  return out;
}

// Detect a hit WITHOUT ever capturing/returning the secret. Per-line so a huge file can't ReDoS on one regex,
// and .match() (not .test()) so the shared /g patterns' lastIndex state can never bleed across calls.
function lineHasPattern(line, re) { try { return !!String(line).match(re); } catch { return false; } }

function scanText(text, label) {
  const hits = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (let p = 0; p < PATTERNS.length; p++) {
      if (lineHasPattern(lines[i], PATTERNS[p])) hits.push({ file: label, line: i + 1, pattern: 'secret-pattern#' + p });
    }
  }
  return hits;
}

function scanFile(file, label) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return scanText(raw, label || file);
}

/** defaultTargets(claudeDir?) — an explicit claudeDir is scanned exactly as before (its forge-runs/, its memory files,
 *  their archives, agent-memory/). Without one: this project's runtime artifacts in every location that exists
 *  (projectTargets). No project root (a plugin copy outside any project) -> []. */
function defaultTargets(claudeDir) {
  if (!claudeDir) return PROJECT_ROOT ? projectTargets(PROJECT_ROOT) : [];
  const cdir = path.resolve(claudeDir);
  return targetsIn([path.join(cdir, 'forge-runs')], [cdir], cdir);
}
/** projectTargets(root) — WP 2.1: run logs from every existing run folder, memory files + archives from every memory
 *  folder (active first), agent-memory archives from root/.claude. In the legacy layout: exactly the old target list. */
function projectTargets(root) {
  const cdir = path.join(root, '.claude');
  const runsDirs = viaForgePaths((P) => P.existingStateDirs(root, 'runs'), () => [path.join(cdir, 'forge-runs')]);
  const memDirs = viaForgePaths((P) => { const d = P.existingStateDirs(root, 'memory'); return d.length ? d : [cdir]; }, () => [cdir]);
  return targetsIn(runsDirs, memDirs, cdir);
}
function targetsIn(runsDirs, memDirs, cdir) {
  const targets = [];
  for (const runsDir of runsDirs) {
    try {
      for (const d of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (d.isDirectory()) { const p = path.join(runsDir, d.name, 'events.jsonl'); if (fs.existsSync(p)) targets.push(p); }
      }
    } catch {}
  }
  for (const dir of memDirs) for (const m of MEMORY_FILES) { const p = path.join(dir, m); if (fs.existsSync(p)) targets.push(p); }
  let archives = [];
  for (const dir of memDirs) archives = archives.concat(memoryArchiveFiles(dir));
  return targets.concat(archives, lessonsArchiveFiles(cdir));
}

function scan(files) {
  const list = (Array.isArray(files) && files.length) ? files : defaultTargets();
  let hits = [];
  for (const f of list) hits = hits.concat(scanFile(f));
  return { scanned: list.length, hits, clean: hits.length === 0 };
}

module.exports = { scanText, scanFile, scan, defaultTargets, projectTargets, memoryArchiveFiles, lessonsArchiveFiles, MEMORY_ARCHIVE_RE, LESSONS_ARCHIVE_RE, PATTERN_COUNT: PATTERNS.length };

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length && !PROJECT_ROOT) {
    console.error('forge-secret-scrub: no project root found (this copy is not inside a project) — pass the files to scan, or set FORGE_PROJECT_ROOT');
    process.exit(2);
  }
  const r = scan(files);
  if (json) { console.log(JSON.stringify(r, null, 2)); }
  else {
    console.log('forge-secret-scrub (advisory) · scanned ' + r.scanned + ' runtime artifact(s) · ' + (r.clean ? 'CLEAN' : r.hits.length + ' finding(s)'));
    // location only — never the secret
    r.hits.slice(0, 50).forEach((h) => console.log('  ⚠ ' + h.pattern + ' in ' + h.file + ':' + h.line));
    if (r.hits.length > 50) console.log('  … ' + (r.hits.length - 50) + ' more');
    if (!r.clean) console.log('  (advisory only — nothing was blocked or modified; rotate any real exposed secret)');
  }
  process.exit(r.clean ? 0 : 3);
}
