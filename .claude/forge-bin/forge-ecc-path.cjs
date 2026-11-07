#!/usr/bin/env node
'use strict';
// forge-ecc-path.cjs: find a skill folder, wherever it is installed (W2-ECCPATH).
// Several ECC skills and commands hard-code `~/.claude/skills/<name>`, but ECC is installed under
// `~/.claude/skills/ecc/<name>`, and some use POSIX `find -maxdepth 2`. Forge wrapper skills call this
// resolver instead. Zero dependencies, no shell, Windows-proof (path + os.homedir()).
//
// Usage:
//   node forge-ecc-path.cjs resolve <skill-name> [--json] [--home DIR] [--project DIR]
//   node forge-ecc-path.cjs list [--depth N] [--json] [--home DIR] [--project DIR]
// <skill-name> may be bare (`skill-stocktake`) or plugin-qualified (`skill-creator:skill-creator`).
// The project root defaults to the nearest folder above the cwd with .claude/skills (never the home folder).
// Search order for resolve: project, global, ecc, plugin. Exit 1 when not found, exit 2 on bad usage.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DEPTH = 2; // same meaning as `find <root> -maxdepth 2 -name SKILL.md`
const MAX_DEPTH = 6;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

// Installed plugins come from ~/.claude/plugins/installed_plugins.json (one read, no directory scan).
function pluginRoots(home) {
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
  const plugins = data && typeof data.plugins === 'object' && data.plugins ? data.plugins : {};
  const out = [];
  for (const [key, entries] of Object.entries(plugins)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.installPath !== 'string' || !entry.installPath) continue;
      const dir = path.join(entry.installPath, 'skills');
      if (isDir(dir)) out.push({ source: 'plugin', plugin: key, dir });
    }
  }
  return out;
}

// Nearest folder at or above `start` that has .claude/skills; the home folder itself is the global root,
// never a project. Falls back to `start`.
function findProjectRoot(start, home) {
  let dir = path.resolve(start);
  for (;;) {
    if (dir.toLowerCase() === home.toLowerCase()) break;
    if (isDir(path.join(dir, '.claude', 'skills'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(start);
}

/** The skill roots in search order: project, global, ecc, plugin. */
function skillRoots(opts = {}) {
  const home = path.resolve(opts.home || os.homedir());
  const project = opts.project ? path.resolve(opts.project) : findProjectRoot(opts.cwd || process.cwd(), home);
  const roots = [
    { source: 'project', dir: path.join(project, '.claude', 'skills') },
    { source: 'global', dir: path.join(home, '.claude', 'skills') },
    { source: 'ecc', dir: path.join(home, '.claude', 'skills', 'ecc') },
  ];
  const plugins = opts.plugins === false ? [] : pluginRoots(home);
  return roots.concat(plugins).filter((r) => isDir(r.dir));
}

function parseName(raw) {
  const s = String(raw || '').trim();
  const parts = s.split(':');
  if (parts.length > 2) return null;
  const [a, b] = parts.length === 2 ? parts : [null, parts[0]];
  if (!NAME_RE.test(b) || (a !== null && !NAME_RE.test(a))) return null;
  return { plugin: a, name: b };
}

/** Absolute folder of a skill, or null. Throws on an invalid name (no path separators, no `..`). */
function resolveSkill(rawName, opts = {}) {
  const parsed = parseName(rawName);
  if (!parsed || parsed.name === '..' || parsed.name === '.') throw new Error('invalid skill name: ' + JSON.stringify(rawName));
  for (const root of skillRoots(opts)) {
    if (parsed.plugin && (root.source !== 'plugin' || root.plugin.split('@')[0] !== parsed.plugin)) continue;
    // `ecc` is a container under the global root, never a skill of its own
    if (root.source === 'global' && parsed.name === 'ecc') continue;
    const dir = path.join(root.dir, parsed.name);
    const skillMd = path.join(dir, 'SKILL.md');
    if (isFile(skillMd)) {
      const hit = { name: parsed.name, path: dir, skillMd, source: root.source };
      if (root.plugin) hit.plugin = root.plugin;
      return hit;
    }
  }
  return null;
}

// Node replacement for `find <root> -maxdepth N -name SKILL.md`; follows symlinks, guards against loops.
function walk(root, depth, skip, seen, found) {
  const stack = [{ dir: root.dir, level: 1 }];
  while (stack.length) {
    const { dir, level } = stack.pop();
    let real;
    try { real = fs.realpathSync(dir); } catch (_) { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names.sort()) {
      const p = path.join(dir, n);
      if (n === 'SKILL.md' && isFile(p)) found.push({ root, file: p });
      else if (level < depth && isDir(p) && !(dir === root.dir && skip.has(n))) stack.push({ dir: p, level: level + 1 });
    }
  }
}

/** Every SKILL.md under the roots, each with its source label. depth counts like find -maxdepth. */
function listSkills(opts = {}) {
  const depth = opts.depth === undefined ? DEFAULT_DEPTH : Number(opts.depth);
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) throw new Error('depth must be an integer 1..' + MAX_DEPTH);
  const out = [];
  for (const root of skillRoots(opts)) {
    // the ecc subtree is listed under its own label, so the global walk skips it
    const skip = new Set(root.source === 'global' ? ['ecc'] : []);
    const found = [];
    walk(root, depth, skip, new Set(), found);
    for (const { file } of found.sort((x, y) => x.file.localeCompare(y.file))) {
      const item = { name: path.basename(path.dirname(file)), skillMd: file, source: root.source };
      if (root.plugin) item.plugin = root.plugin;
      out.push(item);
    }
  }
  return out;
}

function parseArgs(argv) {
  const a = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--depth' || v === '--home' || v === '--project') {
      if (i + 1 >= argv.length) throw new Error(v + ' needs a value');
      a[v.slice(2)] = argv[++i];
    } else if (v.startsWith('--')) throw new Error('unknown option ' + v);
    else a._.push(v);
  }
  return a;
}

const USAGE = 'usage: forge-ecc-path.cjs resolve <skill-name> | list [--depth N]  [--json] [--home DIR] [--project DIR]';

function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message + '\n' + USAGE); return 2; }
  const opts = { home: a.home, project: a.project };
  const cmd = a._[0];
  try {
    if (cmd === 'resolve' && a._.length === 2) {
      const hit = resolveSkill(a._[1], opts);
      if (!hit) {
        const where = skillRoots(opts).map((r) => r.source + ' ' + r.dir).join('; ');
        const msg = 'skill not found: ' + a._[1] + ' (searched ' + (where || 'no existing skill roots') + ')';
        if (a.json) console.log(JSON.stringify({ ok: false, name: a._[1], error: msg }));
        else console.error(msg);
        return 1;
      }
      console.log(a.json ? JSON.stringify(Object.assign({ ok: true }, hit)) : hit.path);
      return 0;
    }
    if (cmd === 'list' && a._.length === 1) {
      const items = listSkills(Object.assign({ depth: a.depth === undefined ? undefined : Number(a.depth) }, opts));
      if (a.json) console.log(JSON.stringify({ ok: true, count: items.length, items }));
      else for (const it of items) console.log(it.source + (it.plugin ? '(' + it.plugin + ')' : '') + '\t' + it.skillMd);
      return 0;
    }
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  console.error(USAGE);
  return 2;
}

module.exports = { skillRoots, resolveSkill, listSkills, findProjectRoot, DEFAULT_DEPTH };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
