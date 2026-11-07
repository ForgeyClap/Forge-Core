#!/usr/bin/env node
'use strict';
// forge-paths.cjs - the one resolver for every Forge runtime-state location (WP 1.2, extended in WP).
// Zero dependencies, read-only: it never writes and never creates a directory; it only computes paths, and a
// missing directory is an answer ("legacy", "none", null), never an exception.
//   node forge-paths.cjs root [--root <dir>] [--discover] [--json]   the project a tool in this folder acts on
//   node forge-paths.cjs layout [--root <dir>]                         forge | legacy
//   node forge-paths.cjs dir <key> [--root <dir>] [--json]             the ACTIVE (write) folder for <key>
//   node forge-paths.cjs memory <name> [--read] [--root <dir>] [--json]  a FORGE_*.md / memory file
//   node forge-paths.cjs list [--root <dir>] [--json]                  (root defaults to the cwd, as in WP 1.2)
//   node forge-paths.cjs resolve <key> [--existing] [--root <dir>] [--json]
//   exit 0 = ok · 1 = no project root found · 2 = bad usage, invalid key/name or an unparseable canon
// Layout comes from .claude/config/orchestration/forge-canon.json -> paths.state_root / paths.state /
// paths.state_legacy (built-in defaults when the canon file is absent). FORGE_STATE_DIR overrides state_root
// (absolute, or relative to the project root).
// OPT-IN PER PROJECT (binding, WP 2.1): a project uses the new layout only when <root>/<state_root> (.forge) is a
// directory or FORGE_STATE_DIR is set; otherwise every active path is the legacy .claude/forge-* location exactly
// as before. In the legacy layout no active path ever lies under .forge, so a write can never flip the layout.
// Writers use stateDir()/memoryFile(); readers use resolveExisting() (new location when it exists, else legacy)
// or existingStateDirs() (both, active first) during a partial migration.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANON_REL = ['.claude', 'config', 'orchestration', 'forge-canon.json'];
const STATE_ROOT_KEY = 'state_root';
const LEGACY_CONTAINER = '.claude';
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const MEMORY_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const ROOT_MARKERS = Object.freeze(['.forge', '.claude', '.git']);
const DEFAULTS = Object.freeze({
  state_root: '.forge',
  state: Object.freeze({
    runs: 'runs', research: 'research', scribe: 'scribe', tickets: 'tickets', index: 'index',
    backups: 'backups', vault: 'vault', artifacts: 'artifacts', mindmaps: 'mindmaps', memory: 'memory',
    audit: 'audit', prd: 'prd',
  }),
  state_legacy: Object.freeze({
    runs: '.claude/forge-runs', research: '.claude/forge-research', scribe: '.claude/forge-scribe',
    tickets: '.claude/forge-tickets', index: '.claude/forge-index', backups: '.claude/forge-backups',
    vault: '.claude/forge-vault', artifacts: '.claude/forge-artifacts', mindmaps: '.claude/forge-mindmaps',
    memory: '.claude', audit: '.claude/forge-audit', prd: '.claude/forge-prd',
  }),
  state_legacy_memory_prefix: 'FORGE_',
});

class PathError extends Error {
  constructor(message) { super(message); this.name = 'ForgePathError'; }
}

/** Reject anything that is not a plain relative path: absolute (POSIX or Windows), drive-letter (C:x),
 *  UNC / device prefixes, NUL bytes and any '..' segment, with either separator style. */
function assertSafeRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new PathError(label + ': empty or not a string');
  if (value.includes('\0')) throw new PathError(label + ': contains a NUL byte');
  if (/^[A-Za-z]:/.test(value)) throw new PathError(label + ': drive-letter path not allowed (' + value + ')');
  if (/^[\\/]/.test(value) || path.isAbsolute(value)) throw new PathError(label + ': absolute path not allowed (' + value + ')');
  const segments = value.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) throw new PathError(label + ': path traversal (..) not allowed (' + value + ')');
  return segments.filter((s) => s !== '' && s !== '.');
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function joinInside(base, value, label) {
  const segments = assertSafeRelative(value, label);
  const out = path.join(base, ...segments);
  if (!isInside(base, out)) throw new PathError(label + ': resolves outside ' + base);
  return out;
}

function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new PathError('projectRoot: empty or not a string');
  return path.resolve(projectRoot);
}

/** loadCanon(projectRoot) -> { state_root, state, state_legacy, state_legacy_memory_prefix, source }.
 *  Absent canon (or a canon without the state keys) -> built-in defaults. An unparseable canon throws:
 *  a corrupt source of truth must be visible, never silently replaced. */
function loadCanon(projectRoot) {
  const root = assertProjectRoot(projectRoot);
  const file = path.join(root, ...CANON_REL);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULTS, source: 'default' };
    throw new PathError('cannot read ' + file + ': ' + e.message);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new PathError('unparseable canon ' + file + ': ' + e.message); }
  const p = (parsed && typeof parsed.paths === 'object' && parsed.paths) || {};
  if (typeof p.state_root !== 'string' || !p.state || typeof p.state !== 'object') return { ...DEFAULTS, source: 'default' };
  return {
    state_root: p.state_root,
    state: { ...p.state },
    state_legacy: { ...(p.state_legacy || {}) },
    state_legacy_memory_prefix: typeof p.state_legacy_memory_prefix === 'string' ? p.state_legacy_memory_prefix : DEFAULTS.state_legacy_memory_prefix,
    source: 'canon',
  };
}

function listKeys(projectRoot) {
  return [STATE_ROOT_KEY, ...Object.keys(loadCanon(projectRoot).state)];
}

function assertKey(canon, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new PathError('invalid key: ' + JSON.stringify(key));
  if (key !== STATE_ROOT_KEY && !Object.prototype.hasOwnProperty.call(canon.state, key)) {
    throw new PathError('unknown key "' + key + '" (not in forge-canon.json paths.state)');
  }
}

/** The state root: FORGE_STATE_DIR (absolute, or relative to the project and then confined to it) or the canon value. */
function stateRoot(root, canon, env) {
  const override = env && typeof env.FORGE_STATE_DIR === 'string' ? env.FORGE_STATE_DIR.trim() : '';
  if (override) {
    if (override.includes('\0')) throw new PathError('FORGE_STATE_DIR: contains a NUL byte');
    if (path.isAbsolute(override)) {
      if (override.split(/[\\/]+/).some((s) => s === '..')) throw new PathError('FORGE_STATE_DIR: path traversal (..) not allowed');
      return path.resolve(override);
    }
    return joinInside(root, override, 'FORGE_STATE_DIR');
  }
  return joinInside(root, canon.state_root, 'paths.state_root');
}

/** resolve(projectRoot, key, opts?) -> absolute NEW-layout path for key (no disk access beyond the canon read). */
function resolve(projectRoot, key, opts = {}) {
  const root = assertProjectRoot(projectRoot);
  const canon = loadCanon(root);
  assertKey(canon, key);
  const base = stateRoot(root, canon, opts.env || process.env);
  if (key === STATE_ROOT_KEY) return base;
  return joinInside(base, canon.state[key], 'paths.state.' + key);
}

function legacyPath(root, canon, key) {
  const rel = canon.state_legacy[key];
  return typeof rel === 'string' ? joinInside(root, rel, 'paths.state_legacy.' + key) : null;
}

function legacyExists(canon, key, legacy) {
  if (!legacy) return false;
  try {
    if (key !== 'memory') return fs.statSync(legacy).isDirectory();
    const prefix = canon.state_legacy_memory_prefix;
    return fs.readdirSync(legacy).some((n) => n.startsWith(prefix) && fs.statSync(path.join(legacy, n)).isFile());
  } catch { return false; }
}

function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** locate(projectRoot, key, opts?) -> { path, source: 'new'|'legacy'|'none', new, legacy }. */
function locate(projectRoot, key, opts = {}) {
  const root = assertProjectRoot(projectRoot);
  const canon = loadCanon(root);
  const fresh = resolve(root, key, opts);
  const legacy = key === STATE_ROOT_KEY ? null : legacyPath(root, canon, key);
  if (dirExists(fresh)) return { path: fresh, source: 'new', new: fresh, legacy };
  if (legacyExists(canon, key, legacy)) return { path: legacy, source: 'legacy', new: fresh, legacy };
  return { path: legacy || fresh, source: 'none', new: fresh, legacy };
}

/** resolveExisting(projectRoot, key, opts?) -> the new location when it exists, else the legacy location. */
function resolveExisting(projectRoot, key, opts = {}) {
  return locate(projectRoot, key, opts).path;
}

// ---------------------------------------------------------------------------------------------------------------
// Project root discovery (WP). A plugin copy of a tool cannot use its own folder: it would act on the
// plugin's parent folder. Home rule: the user's home folder holds the GLOBAL ~/.claude (plugin caches, a possibly
// git-versioned config), so neither the home folder nor anything inside ~/.claude counts as a discovered project
// unless it has an explicit .forge folder.
// ---------------------------------------------------------------------------------------------------------------
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
function samePath(a, b) { return path.relative(a, b) === ''; }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function anyExists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function homeOf(opts) {
  if (opts.home === null) return null;
  if (nonEmpty(opts.home)) return path.resolve(opts.home);
  try { return path.resolve(os.homedir()); } catch { return null; }
}
function cleanDir(value, label) {
  if (value.includes('\0')) throw new PathError(label + ': contains a NUL byte');
  return path.resolve(value);
}

/** systemBases() -> absolute folders that are never a project by themselves, even when a tool once left a
 *  `.claude` in them (a stray `%LOCALAPPDATA%\.claude` made every plugin run under %TEMP% write there). Only the
 *  folder ITSELF is excluded, never what lives below it, so a real project under %TEMP% is still found first. */
function systemBases() {
  const e = process.env;
  const out = [];
  const add = (p) => { if (nonEmpty(p)) { try { out.push(path.resolve(p)); } catch { /* ignore */ } } };
  [e.LOCALAPPDATA, e.APPDATA, e.PROGRAMDATA, e.ProgramData, e.TEMP, e.TMP].forEach(add);
  try { add(os.tmpdir()); } catch { /* ignore */ }
  try {
    const h = os.homedir();
    if (nonEmpty(h)) { add(path.join(h, 'AppData', 'Local')); add(path.join(h, 'AppData', 'Roaming')); add(path.join(h, 'AppData', 'LocalLow')); }
  } catch { /* ignore */ }
  return out;
}
function isSystemBase(dir) {
  const d = path.resolve(dir);
  if (path.parse(d).root === d) return true;
  return systemBases().some((b) => samePath(b, d));
}

/** rootMarker(dir, home?) -> '.forge' | '.claude' | '.git' | null. .git may be a file (a git worktree).
 *  An explicit `.forge/` always counts (the owner opted in); the folders from systemBases() and drive roots never do
 *  through `.claude` or `.git`. */
function rootMarker(dir, home) {
  if (dirExists(path.join(dir, '.forge'))) return '.forge';
  if (isSystemBase(dir)) return null;
  if (home && (samePath(dir, home) || isInside(path.join(home, LEGACY_CONTAINER), dir))) return null;
  if (dirExists(path.join(dir, '.claude'))) return '.claude';
  if (anyExists(path.join(dir, '.git'))) return '.git';
  return null;
}

/** projectRootInfo(opts?) -> {root, source: 'explicit'|'env'|'cwd'|'fallback'|'none', marker?}.
 *  Order: opts.root (unchecked, the caller's choice) -> env CLAUDE_PROJECT_DIR (absolute and holding a marker,
 *  else ignored) -> the first folder holding .claude/.forge/.git walking up from opts.cwd (default process.cwd(),
 *  never above opts.ceiling) -> opts.fallback. A folder equal to or inside any opts.exclude entry never counts.
 *  opts.env defaults to process.env, opts.home to os.homedir() (null switches the home rule off). */
function projectRootInfo(opts = {}) {
  if (nonEmpty(opts.root)) return { root: cleanDir(opts.root, 'root'), source: 'explicit' };
  const env = opts.env || process.env;
  const home = homeOf(opts);
  const exclude = (Array.isArray(opts.exclude) ? opts.exclude : []).filter(nonEmpty).map((p) => path.resolve(p));
  const excluded = (dir) => exclude.some((ex) => isInside(ex, dir));
  const envDir = nonEmpty(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR.trim() : '';
  if (envDir && !envDir.includes('\0') && path.isAbsolute(envDir)) {
    const d = path.resolve(envDir);
    const marker = excluded(d) ? null : rootMarker(d, home);
    if (marker) return { root: d, source: 'env', marker };
  }
  let start = null;
  if (nonEmpty(opts.cwd)) start = opts.cwd;
  else { try { start = process.cwd(); } catch { start = null; } }
  if (start && !start.includes('\0')) {
    const ceiling = nonEmpty(opts.ceiling) ? path.resolve(opts.ceiling) : null;
    for (let dir = path.resolve(start); ;) {
      if (ceiling && !isInside(ceiling, dir)) break;
      const marker = excluded(dir) ? null : rootMarker(dir, home);
      if (marker) return { root: dir, source: 'cwd', marker };
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  if (nonEmpty(opts.fallback)) {
    const f = cleanDir(opts.fallback, 'fallback');
    if (!excluded(f)) return { root: f, source: 'fallback' };
  }
  return { root: null, source: 'none' };
}

/** findProjectRoot(opts?) -> absolute project root, or null when nothing qualifies. See projectRootInfo. */
function findProjectRoot(opts = {}) {
  return projectRootInfo(opts).root;
}

/** scriptRootInfo(scriptDir, opts?) -> {root, source}. THE codemod target for tools (`scriptRoot(__dirname)`):
 *  an installed copy at <project>/.claude/<folder>/<tool> keeps today's answer <project> (source 'script'), so the
 *  dev tree, fixtures and copied tools behave exactly as before; any other location (a plugin's scripts/ folder,
 *  a global copy under the home folder) is discovered via projectRootInfo with the script's package folder
 *  excluded and no fallback, so a path inside the script's own package is never returned. opts.root wins. */
function scriptRootInfo(scriptDir, opts = {}) {
  if (nonEmpty(opts.root)) return { root: cleanDir(opts.root, 'root'), source: 'explicit' };
  if (!nonEmpty(scriptDir)) throw new PathError('scriptDir: empty or not a string');
  const dir = cleanDir(scriptDir, 'scriptDir');
  const pkg = path.dirname(dir);
  if (path.basename(pkg).toLowerCase() === LEGACY_CONTAINER) {
    const root = path.dirname(pkg);
    const home = homeOf(opts);
    if (!(home && samePath(root, home)) || dirExists(path.join(root, '.forge'))) return { root, source: 'script' };
  }
  const exclude = (Array.isArray(opts.exclude) ? opts.exclude : []).concat([pkg]);
  return projectRootInfo({ ...opts, root: undefined, fallback: undefined, exclude });
}

/** scriptRoot(scriptDir, opts?) -> absolute project root or null. */
function scriptRoot(scriptDir, opts = {}) {
  return scriptRootInfo(scriptDir, opts).root;
}

// ---------------------------------------------------------------------------------------------------------------
// Layout + active (write) locations
// ---------------------------------------------------------------------------------------------------------------
/** layout(projectRoot, opts?) -> 'forge' when FORGE_STATE_DIR is set or <root>/<state_root> is a directory,
 *  else 'legacy'. A FILE named .forge does not switch the layout. */
function layout(projectRoot, opts = {}) {
  const root = assertProjectRoot(projectRoot);
  const env = opts.env || process.env;
  if (nonEmpty(env.FORGE_STATE_DIR)) return 'forge';
  const canon = loadCanon(root);
  return dirExists(joinInside(root, canon.state_root, 'paths.state_root')) ? 'forge' : 'legacy';
}

/** stateDirFor(projectRoot, key, opts?) -> {key, layout, active, forge, legacy}. active = forge in the forge
 *  layout, legacy otherwise. legacy = canon state_legacy[key], else .claude/forge-<key>; for state_root it is the
 *  .claude folder that holds the legacy state folders. */
function stateDirFor(projectRoot, key, opts = {}) {
  const root = assertProjectRoot(projectRoot);
  const canon = loadCanon(root);
  assertKey(canon, key);
  const env = opts.env || process.env;
  const forge = resolve(root, key, { env });
  const legacy = key === STATE_ROOT_KEY
    ? path.join(root, LEGACY_CONTAINER)
    : (legacyPath(root, canon, key) || joinInside(root, LEGACY_CONTAINER + '/forge-' + key, 'legacy ' + key));
  const lay = layout(root, { env });
  return { key, layout: lay, active: lay === 'forge' ? forge : legacy, forge, legacy };
}

/** stateDir(projectRoot, key, opts?) -> the ACTIVE folder for key: where a writer writes. */
function stateDir(projectRoot, key, opts = {}) {
  return stateDirFor(projectRoot, key, opts).active;
}

/** existingStateDirs(projectRoot, key, opts?) -> the folders of key that exist on disk, active first (a reader
 *  that lists runs, tickets, ... during a partial migration reads both). */
function existingStateDirs(projectRoot, key, opts = {}) {
  const d = stateDirFor(projectRoot, key, opts);
  const out = [];
  for (const p of [d.active, d.active === d.forge ? d.legacy : d.forge]) {
    if (dirExists(p) && !out.some((q) => samePath(q, p))) out.push(p);
  }
  return out;
}

function assertMemoryName(name) {
  if (typeof name !== 'string' || !MEMORY_NAME_RE.test(name) || name.includes('..')) {
    throw new PathError('invalid memory file name: ' + JSON.stringify(name) + ' (one plain file name, no folders)');
  }
}

/** memoryFileFor(projectRoot, name, opts?) -> {name, layout, active, read, forge, legacy}. forge = .forge/memory/
 *  <name>, legacy = .claude/<name>. read = active, except in the forge layout when only the legacy file exists. */
function memoryFileFor(projectRoot, name, opts = {}) {
  assertMemoryName(name);
  const d = stateDirFor(projectRoot, 'memory', opts);
  const forge = path.join(d.forge, name);
  const legacy = path.join(d.legacy, name);
  const active = d.layout === 'forge' ? forge : legacy;
  const read = d.layout === 'forge' && !fileExists(forge) && fileExists(legacy) ? legacy : active;
  return { name, layout: d.layout, active, read, forge, legacy };
}

/** memoryFile(projectRoot, name, opts?) -> the active (write) path; opts.read -> the read path (fallback). */
function memoryFile(projectRoot, name, opts = {}) {
  const m = memoryFileFor(projectRoot, name, opts);
  return opts.read ? m.read : m.active;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
const USAGE = 'Usage: node forge-paths.cjs root [--discover] | layout | dir <key> | memory <name> [--read] | list | '
  + 'resolve <key> [--existing]   [--root <dir>] [--json]\n';

function cliRoot(explicit, discover) {
  if (explicit !== null) return { root: cleanDir(explicit, 'root'), source: 'explicit' };
  return discover ? projectRootInfo({}) : scriptRootInfo(__dirname);
}

function main(argv) {
  const args = argv.slice();
  let explicit = null, json = false, existing = false, discover = false, read = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') explicit = args[++i] === undefined ? '' : args[i];
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--existing') existing = true;
    else if (args[i] === '--discover') discover = true;
    else if (args[i] === '--read') read = true;
    else rest.push(args[i]);
  }
  const [cmd, key] = rest;
  const out = (obj, text) => { process.stdout.write(json ? JSON.stringify(obj) + '\n' : text + '\n'); return 0; };
  try {
    if (explicit === '') throw new PathError('--root needs a folder');
    if (cmd === 'list') {
      const root = explicit === null ? process.cwd() : explicit;
      const rows = listKeys(root).map((k) => ({ key: k, ...locate(root, k) }));
      process.stdout.write(json ? JSON.stringify(rows, null, 2) + '\n' : rows.map((r) => r.key + '\t' + r.source + '\t' + r.path).join('\n') + '\n');
      return 0;
    }
    if (cmd === 'resolve' && key) {
      const root = explicit === null ? process.cwd() : explicit;
      const r = existing ? locate(root, key) : { key, path: resolve(root, key) };
      return out(r, r.path);
    }
    if (cmd === 'root' || cmd === 'layout' || ((cmd === 'dir' || cmd === 'memory') && key)) {
      const info = cliRoot(explicit, discover);
      if (!info.root) { process.stderr.write('forge-paths: no project root found (no .claude, .forge or .git above the current folder)\n'); return 1; }
      if (cmd === 'root') return out(info, info.root);
      if (cmd === 'layout') { const l = layout(info.root); return out({ root: info.root, layout: l }, l); }
      if (cmd === 'dir') { const d = stateDirFor(info.root, key); return out({ root: info.root, ...d }, d.active); }
      const m = memoryFileFor(info.root, key);
      return out({ root: info.root, ...m }, read ? m.read : m.active);
    }
    process.stderr.write(USAGE);
    return 2;
  } catch (e) {
    process.stderr.write('forge-paths: ' + e.message + '\n');
    return 2;
  }
}

module.exports = {
  main, resolve, resolveExisting, locate, listKeys, loadCanon, assertSafeRelative, PathError, DEFAULTS, STATE_ROOT_KEY,
  findProjectRoot, projectRootInfo, scriptRoot, scriptRootInfo, rootMarker, layout, stateDir, stateDirFor,
  existingStateDirs, memoryFile, memoryFileFor, ROOT_MARKERS, LEGACY_CONTAINER,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
