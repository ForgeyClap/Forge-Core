'use strict';
/**
 * forge-shipcheck-refs.cjs — reference extraction for forge-shipcheck.cjs's REFERENCE-CLOSURE check
 *.
 *
 * The question it answers: "which project paths does this shipped file point at?" — so the checker can
 * fail when a shipped file points at a file a synced project will never receive (the HOOKS_OPT_IN.md /
 * PROMPT_TEMPLATE.md / activation-test-template.md class of ship gap). Pure functions, zero dependencies,
 * no filesystem access: the caller hands in the text and the set of source paths.
 *
 * Five extractors, each deliberately conservative (a missed reference is a gap in coverage; a false
 * reference is noise that trains people to ignore the check, which is worse):
 *   1. claude   — `.claude/<path>` with a project-relative prefix context only. `~/.claude/...`, an absolute
 *                 `C:/Users/x/.claude/...` or any other `/.claude` (home / other machine) is NOT a project
 *                 path and is skipped. Allowed prefixes: start of text, whitespace, a quote/backtick, ( [ = , : ; |,
 *                 `./`, `$CLAUDE_PROJECT_DIR/`, `${CLAUDE_PROJECT_DIR}/`, `%CLAUDE_PROJECT_DIR%/`, `<word>/`.
 *   2. relative — `<top>/<path>` where <top> is a .claude subfolder name (forge-bin, config, skills, agents,
 *                 commands, docs, forge-dashboard, forge-fixtures), same boundary rule (never after a `/`, so a
 *                 URL or a deeper path is never re-read as a .claude path).
 *   3. join     — (code only) a run of 2+ quoted literals separated by commas, e.g. path.join(cd, 'config',
 *                 'orchestration', '<name>.json'), whose first literal is '.claude', a <top> name or 'orchestration'
 *                 (read as config/orchestration, the same convention forge-sync.test.cjs test 83 uses).
 *   4. sibling  — a token equal to the path of an EXISTING file in the same folder (for a file inside
 *                 skills/<name>/, relative to the skill folder root): "See PROMPT_TEMPLATE.md",
 *                 require('./forge-store.cjs'), `references/activation-test-template.md`. Known-target only, so
 *                 it can never invent a reference to something that does not exist.
 *   5. bare     — a bare `FORGE_<NAME>.md|json` token (the root-level Forge state/registry files):
 *                 `.claude/FORGE_X` when that is a source file, else the single source file with that basename,
 *                 else nothing (ambiguous or runtime-only names are skipped, never guessed).
 *
 * Syntactic skips (documented, applied before any classification): a path followed by `*`, `<`, `{` or `$`
 * (a glob or placeholder, e.g. `.claude/forge-runs/<run_id>/events.jsonl`); a path ending in `/` (a folder);
 * any `.` or `..` segment; trailing sentence dots are trimmed. Backslashes are read as `/` first, so a Windows
 * path in a doc (a `.\.claude\forge-bin\<tool>.ps1` spelling) is read the same as its POSIX spelling.
 */

const TOP_DIRS = ['forge-bin', 'config', 'skills', 'agents', 'commands', 'docs', 'forge-dashboard', 'forge-fixtures'];
const SEG = '[A-Za-z0-9_.@+\\-]+';
const PATH_BODY = SEG + '(?:\\/' + SEG + ')*';
// the allowed left-context of a project path (see header): never a bare '/', so home/absolute paths are skipped
const LEFT = '(?<=^|[\\s`\'"(\\[=,:;|]|\\$CLAUDE_PROJECT_DIR\\/|\\$\\{CLAUDE_PROJECT_DIR\\}\\/|%CLAUDE_PROJECT_DIR%\\/|<[A-Za-z_-]+>\\/|(?<![.\\w])\\.\\/)';
const CLAUDE_RE = new RegExp(LEFT + '\\.claude\\/(' + PATH_BODY + ')(\\/?)([*<{$]?)', 'gm');
const REL_RE = new RegExp(LEFT + '(' + TOP_DIRS.join('|') + ')\\/(' + PATH_BODY + ')(\\/?)([*<{$]?)', 'gm');
const JOIN_RE = /(?:(['"])[A-Za-z0-9_.@+\-]+\1\s*,\s*)+(['"])[A-Za-z0-9_.@+\-]+\2/g;
const LITERAL_RE = /['"]([A-Za-z0-9_.@+\-]+)['"]/g;
const TOKEN_RE = /[A-Za-z0-9_.@+\-]+(?:\/[A-Za-z0-9_.@+\-]+)*/g;
const BARE_FORGE_RE = /^FORGE_[A-Z0-9_]+\.(?:md|json)$/;
const CODE_EXTS = new Set(['.cjs', '.js', '.mjs']);

function hasExtension(p) { return /\.[A-Za-z0-9]+$/.test(p.split('/').pop()); }
function extOf(p) { const b = p.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; }
function cleanPath(p) {
  const trimmed = String(p).replace(/\.+$/, '');
  if (!trimmed) return null;
  const segs = trimmed.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return trimmed;
}

/** normalizeText(text) — backslashes read as '/', so Windows-spelled paths match the POSIX extractors. */
function normalizeText(text) { return String(text).replace(/\\+/g, '/'); }

/** extractRefs(text, fromRel, ctx) -> [{target, via}] — every project-root-relative target path the file
 *  `fromRel` (project-root-relative, e.g. '.claude/forge-bin/x.cjs') points at, deduplicated.
 *  ctx.sourceSet: Set of every source path (project-root-relative) — used by the sibling/bare extractors and
 *  to resolve an ambiguous relative path (`.claude/<rel>` first, then the project root).
 *  ctx.byBasename: Map basename -> [paths] (optional; built on demand when absent). */
function extractRefs(text, fromRel, ctx) {
  const c = ctx || {};
  const sourceSet = c.sourceSet || new Set();
  const out = new Map();
  const add = (target, via) => { const t = cleanPath(target); if (t && !out.has(t)) out.set(t, via); };
  const norm = normalizeText(text);
  let m;

  CLAUDE_RE.lastIndex = 0;
  while ((m = CLAUDE_RE.exec(norm)) !== null) {
    if (m[3] || m[2]) continue; // a glob/placeholder follows, or it names a folder
    if (!hasExtension(m[1].replace(/\.+$/, ''))) continue; // folder-like (no extension): never a file reference
    add('.claude/' + m[1], 'claude');
  }

  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(norm)) !== null) {
    if (m[4] || m[3]) continue;
    const rel = m[1] + '/' + m[2];
    if (!hasExtension(rel.replace(/\.+$/, ''))) continue;
    const cleaned = cleanPath(rel);
    if (!cleaned) continue;
    // `.claude/<rel>` first (the shipped-file convention); the project root only when that is where it exists
    const claudeTarget = '.claude/' + cleaned;
    if (!sourceSet.has(claudeTarget) && sourceSet.has(cleaned)) add(cleaned, 'relative-root');
    else add(claudeTarget, 'relative');
  }

  if (CODE_EXTS.has(extOf(fromRel))) {
    JOIN_RE.lastIndex = 0;
    while ((m = JOIN_RE.exec(norm)) !== null) {
      const lits = []; let l; LITERAL_RE.lastIndex = 0;
      while ((l = LITERAL_RE.exec(m[0])) !== null) lits.push(l[1]);
      if (lits.length < 2) continue;
      let parts = lits;
      if (parts[0] === '.claude') parts = parts.slice(1);
      else if (parts[0] === 'orchestration') parts = ['config'].concat(parts);
      if (!parts.length || !TOP_DIRS.includes(parts[0])) continue;
      const joined = parts.join('/');
      if (!hasExtension(joined)) continue;
      add('.claude/' + joined, 'join');
    }
  }

  // sibling + bare: one tokenisation pass, then set lookups (linear, never a per-candidate substring scan)
  const tokens = new Set();
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(norm)) !== null) tokens.add(m[0].replace(/^\.\//, '').replace(/\.+$/, ''));
  const fromDir = fromRel.split('/').slice(0, -1).join('/');
  const skillRoot = /^\.claude\/skills\/[^/]+\//.test(fromRel) ? fromRel.split('/').slice(0, 3).join('/') : null;
  const bases = skillRoot ? [skillRoot, fromDir] : [fromDir];
  for (const base of bases) {
    const prefix = base + '/';
    for (const tok of tokens) {
      if (!hasExtension(tok)) continue;
      const candidate = prefix + tok;
      if (candidate !== fromRel && sourceSet.has(candidate)) add(candidate, 'sibling');
    }
  }
  for (const tok of tokens) {
    if (!BARE_FORGE_RE.test(tok)) continue;
    const atRoot = '.claude/' + tok;
    if (sourceSet.has(atRoot)) { add(atRoot, 'bare'); continue; }
    const byBase = c.byBasename || buildBasenameIndex(sourceSet);
    c.byBasename = byBase;
    const hits = byBase.get(tok) || [];
    if (hits.length === 1) add(hits[0], 'bare');
  }
  return [...out.entries()].map(([target, via]) => ({ target, via }));
}

function buildBasenameIndex(sourceSet) {
  const idx = new Map();
  for (const p of sourceSet) {
    const b = p.split('/').pop();
    if (!idx.has(b)) idx.set(b, []);
    idx.get(b).push(p);
  }
  return idx;
}

module.exports = { extractRefs, normalizeText, buildBasenameIndex, cleanPath, hasExtension, TOP_DIRS };
