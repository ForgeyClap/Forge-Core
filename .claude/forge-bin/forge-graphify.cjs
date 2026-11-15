#!/usr/bin/env node
'use strict';
// forge-graphify.cjs — Forge adapter for the graphify CLI (graphifyy, a uv tool) — WP SA-P1-ADAPT, PHASE2-PLAN A9 + E.
// Finds graphify (GRAPHIFY_BIN, PATH, ~/.local/bin, the uv tool python with -m graphify), runs it without a shell,
// checks/fixes the global skill frontmatter (name "graphify", no non-standard "trigger:" key, version marker current)
// and runs a real smoke test (--help, then a code-only graph build on a temp folder that is deleted afterwards).
//
// Usage: node forge-graphify.cjs which | version | smoke | check-skill [--skill-dir D] | fix-skill [--skill-dir D]
//        node forge-graphify.cjs run -- <graphify args...>
//        node forge-graphify.cjs ensure [--root D] [--json] [--wait]   (fresh|built|building|skipped|unavailable, always exit 0)
//          without --wait it starts this file again, detached, as `ensure --wait --found <json>` and returns at once;
//          --found must be one of candidates(). A failed --wait build is recorded in graphify-out/.forge-build.last and
//          later calls answer unavailable (no new build) until a code edit or 6 hours have passed.
// Exit codes: 0 ok, 1 check/smoke failed, 2 graphify not found or bad usage (ensure: 2 only for bad usage).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE_TIMEOUT_MS = 30000;
const BUILD_TIMEOUT_MS = 180000;
const SKILL_NAME = 'graphify';

function parseVersion(text) {
  const m = /^\s*graphify\s+(\d+\.\d+\.\d+\S*)\s*$/m.exec(String(text || ''));
  return m ? m[1] : null;
}

function defaultRun(cmd, args, opts) {
  const o = opts || {};
  // the timeout kills only this child (its own pid), never anything by name
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: o.timeout || PROBE_TIMEOUT_MS, cwd: o.cwd, stdio: o.stdio });
}

function uvToolPython(env, home, platform) {
  if (platform === 'win32') {
    const appdata = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const base = env.UV_TOOL_DIR || path.join(appdata, 'uv', 'tools');
    return path.join(base, 'graphifyy', 'Scripts', 'python.exe');
  }
  const base = env.UV_TOOL_DIR || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'uv', 'tools');
  return path.join(base, 'graphifyy', 'bin', 'python');
}

function candidates({ env, home, platform }) {
  const exe = platform === 'win32' ? 'graphify.exe' : 'graphify';
  const out = [];
  if (env.GRAPHIFY_BIN) out.push({ cmd: env.GRAPHIFY_BIN, args: [], source: 'env:GRAPHIFY_BIN' });
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) {
    out.push({ cmd: path.join(dir, exe), args: [], source: 'path' });
  }
  out.push({ cmd: path.join(home, '.local', 'bin', exe), args: [], source: 'local-bin' });
  out.push({ cmd: uvToolPython(env, home, platform), args: ['-m', 'graphify'], source: 'uv-tool-python' });
  const seen = new Set();
  return out.filter((c) => { const k = path.resolve(c.cmd).toLowerCase() + '|' + c.args.join(' '); if (seen.has(k)) return false; seen.add(k); return true; });
}

function locate(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const home = d.home || os.homedir();
  const platform = d.platform || process.platform;
  const exists = d.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  const run = d.run || defaultRun;
  const timeout = d.probeTimeout || PROBE_TIMEOUT_MS;
  const tried = [];
  for (const c of candidates({ env, home, platform })) {
    if (!exists(c.cmd)) { tried.push({ cmd: c.cmd, result: 'missing' }); continue; }
    const r = run(c.cmd, c.args.concat(['--version']), { timeout });
    const version = r && r.status === 0 ? parseVersion((r.stdout || '') + '\n' + (r.stderr || '')) : null;
    if (version) return { ok: true, cmd: c.cmd, args: c.args, source: c.source, version, tried };
    tried.push({ cmd: c.cmd, result: r && r.error ? 'spawn error: ' + r.error.code : 'exit ' + (r ? r.status : '?') });
  }
  return { ok: false, reason: 'graphify not found (tried ' + tried.length + ' locations)', tried };
}

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) throw new Error('SKILL.md has no YAML frontmatter');
  return { head: m[1], rest: text.slice(m[0].length), close: m[2] };
}

function normalizeSkillText(text) {
  const fm = splitFrontmatter(String(text));
  const changes = [];
  const lines = fm.head.split(/\r?\n/).filter((line) => {
    if (/^trigger\s*:/.test(line)) { changes.push('dropped non-standard key "' + line.trim() + '" (Claude Code maps /graphify from the skill name)'); return false; }
    return true;
  }).map((line) => {
    const nm = /^name\s*:\s*(.*)$/.exec(line);
    if (nm && nm[1].trim().replace(/^["']|["']$/g, '') !== SKILL_NAME) {
      changes.push('name "' + nm[1].trim() + '" -> "' + SKILL_NAME + '"');
      return 'name: ' + SKILL_NAME;
    }
    return line;
  });
  if (!changes.length) return { text: String(text), changes };
  return { text: '---\n' + lines.join('\n') + '\n---' + fm.close + fm.rest, changes };
}

function readFrontName(head) {
  const m = /^name\s*:\s*(.*)$/m.exec(head);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

function checkSkill(skillDir, packageVersion) {
  const problems = [];
  const file = path.join(skillDir, 'SKILL.md');
  let head = '';
  try { head = splitFrontmatter(fs.readFileSync(file, 'utf8')).head; } catch (e) { problems.push('cannot read SKILL.md frontmatter: ' + e.message); }
  const name = head ? readFrontName(head) : null;
  if (head && name !== SKILL_NAME) problems.push('frontmatter name is "' + name + '", expected "' + SKILL_NAME + '"');
  if (/^trigger\s*:/m.test(head)) problems.push('frontmatter has a non-standard "trigger:" key');
  let marker = null;
  try { marker = fs.readFileSync(path.join(skillDir, '.graphify_version'), 'utf8').trim(); } catch (e) { problems.push('missing .graphify_version'); }
  if (marker !== null && packageVersion && marker !== packageVersion) problems.push('.graphify_version is ' + marker + ', package is ' + packageVersion);
  return { ok: problems.length === 0, problems, name, marker };
}

function fixSkill(skillDir, opts) {
  const date = (opts && opts.date) || new Date().toISOString().slice(0, 10);
  const file = path.join(skillDir, 'SKILL.md');
  const before = fs.readFileSync(file, 'utf8');
  const r = normalizeSkillText(before);
  if (!r.changes.length) return { changed: false, changes: [] };
  const backup = file + '.bak-' + date;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = file + '.tmp-forge';
  fs.writeFileSync(tmp, r.text);
  fs.renameSync(tmp, file);
  return { changed: true, changes: r.changes, backup };
}

const SMOKE_FILES = {
  'greet.py': 'def greet(name):\n    return "hi " + name\n\n\ndef main():\n    return greet("forge")\n',
  'util.js': 'function shout(s) { return String(s).toUpperCase(); }\nmodule.exports = { shout };\n',
  'app.js': 'const { shout } = require("./util");\nfunction run() { return shout("graph"); }\nmodule.exports = { run };\n',
};

function smoke(deps) {
  const d = deps || {};
  const found = d.found || locate(d);
  if (!found.ok) return { ok: false, reason: found.reason, steps: [] };
  const run = d.run || defaultRun;
  const steps = [];
  const help = run(found.cmd, found.args.concat(['--help']), { timeout: PROBE_TIMEOUT_MS });
  steps.push({ step: '--help', exit: help.status });
  if (help.status !== 0 || !/Usage:/i.test(help.stdout || '')) return { ok: false, reason: 'graphify --help failed (exit ' + help.status + ')', steps };
  const tmpDir = fs.mkdtempSync(path.join(d.tmpRoot || os.tmpdir(), 'forge-graphify-smoke-'));
  try {
    for (const [n, body] of Object.entries(SMOKE_FILES)) fs.writeFileSync(path.join(tmpDir, n), body);
    const b = run(found.cmd, found.args.concat(['update', tmpDir]), { timeout: BUILD_TIMEOUT_MS, cwd: tmpDir });
    steps.push({ step: 'update <tmp>', exit: b.status });
    if (b.status !== 0) return { ok: false, reason: 'graphify update failed (exit ' + b.status + ')', steps, tmpDir };
    const gj = path.join(tmpDir, 'graphify-out', 'graph.json');
    let g;
    try { g = JSON.parse(fs.readFileSync(gj, 'utf8')); } catch (e) { return { ok: false, reason: 'no readable graph.json: ' + e.message, steps, tmpDir }; }
    const nodes = Array.isArray(g.nodes) ? g.nodes.length : 0;
    const links = Array.isArray(g.links) ? g.links.length : (Array.isArray(g.edges) ? g.edges.length : 0);
    steps.push({ step: 'graph.json', nodes, links });
    if (nodes < 1) return { ok: false, reason: 'graph.json has no nodes', steps, tmpDir, nodes, links };
    return { ok: true, version: found.version, steps, tmpDir, nodes, links };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- ensure(): keep <root>/graphify-out/graph.json current with a code-only build (`graphify update`, no LLM) ----
// Mirrors graphify's own skip set (graphify/detect.py _SKIP_DIRS and _is_noise_dir, 0.8.x) plus Forge's _scratch, so code
// graphify never reads cannot make the graph look stale.
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out', '_scratch',
  'venv', '.venv', 'env', '.env', '__pycache__', 'target', 'out', 'coverage', 'site-packages', 'lib64', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tox', '.eggs', 'lcov-report', 'visual-tests', 'visual-test', '__snapshots__', 'snapshots',
  'storybook-static', 'dist-protected', '.nuxt', '.angular', '.idea', '.cache', '.parcel-cache', '.svelte-kit', '.terraform',
  '.serverless', '.graphify', '.worktrees']);
const IGNORE_REL = new Set(['.claude/forge-runs']);
function noiseDir(name, parentRel) {
  if (IGNORE_DIRS.has(name) || /(_venv|_env|\.egg-info)$/.test(name)) return true;
  return name === 'worktrees' && path.posix.basename(parentRel).startsWith('.'); // .claude/worktrees, like graphify
}
const SHORT_PROBE_MS = 5000; // the start brief must not hang on a slow `graphify --version`
const STAMP_NAME = '.forge-graph-stamp';
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.c', '.h',
  '.cpp', '.hpp', '.rb', '.php', '.swift', '.scala', '.lua', '.sh', '.ps1', '.vue', '.svelte']);
const MIN_CODE_FILES = 3;
const SCAN_MAX_ENTRIES = 50000; // shortcut: a huge tree is judged on the first 50k entries; raise if graphs go stale unseen
const LOCK_TTL_MS = 15 * 60 * 1000;
const LOCK_NAME = '.forge-build.lock';
const LAST_NAME = '.forge-build.last'; // {failed, newest, reason, at} of the last failed --wait build; removed by a good one
const RETRY_AFTER_MS = 6 * 3600 * 1000; // a failed build is tried again after a code edit or after 6 hours

function mtimeIfFile(p) { try { const s = fs.statSync(p); return s.isFile() ? s.mtimeMs : null; } catch (e) { return null; } }

/** Folder rules from the root .gitignore, read line by line: plain names match anywhere, names with a slash match from the
 *  root. shortcut: wildcard and negated lines are skipped (only a trailing slash-star or slash-double-star is stripped);
 *  use a real gitignore matcher if graphs go stale because of an unusual ignore file. */
function gitignoreDirs(root) {
  const names = new Set(); const rels = new Set();
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch (e) { return { names, rels }; } // no .gitignore: nothing extra
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    line = line.replace(/\/\*\*?$/, '').replace(/\/+$/, '');
    if (!line || /[*?[\\]/.test(line)) continue;
    const anchored = line.startsWith('/');
    line = line.replace(/^\/+/, '');
    if (!line) continue;
    if (anchored || line.includes('/')) rels.add(line); else names.add(line);
  }
  return { names, rels };
}

function scanCode(root) {
  const gi = gitignoreDirs(root);
  const skipDir = (name, rel, parentRel) => noiseDir(name, parentRel) || IGNORE_REL.has(rel) || gi.names.has(name) || gi.rels.has(rel);
  let count = 0; let newest = 0; let seen = 0;
  const stack = [''];
  while (stack.length && seen < SCAN_MAX_ENTRIES) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { continue; } // unreadable dir: skip it
    for (const ent of entries) {
      if (++seen > SCAN_MAX_ENTRIES) break;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { if (!skipDir(ent.name, childRel, rel)) stack.push(childRel); continue; }
      if (!ent.isFile() || !CODE_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      count++;
      const m = mtimeIfFile(path.join(root, childRel));
      if (m !== null && m > newest) newest = m;
    }
  }
  return { count, newest };
}

function sameDir(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
// signal 0 only asks whether the pid exists; it stops nothing. EPERM = exists but belongs to someone else.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } } // missing or broken file: no data
function hasMarker(root) {
  try { if (fs.statSync(path.join(root, '.claude')).isDirectory()) return true; } catch (e) { /* no .claude folder: try .git */ }
  try { fs.statSync(path.join(root, '.git')); return true; } catch (e) { return false; } // .git may be a folder or a worktree file
}
function makeOutDir(outDir) {
  if (fs.existsSync(outDir)) return; // graphify's own folder (or a damaged one) is left alone
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n'); // the graph output never becomes committable
}
function writeLock(outDir, pid, now) { makeOutDir(outDir); fs.writeFileSync(path.join(outDir, LOCK_NAME), JSON.stringify({ pid, started: now })); }
function releaseOwnLock(outDir, pid) {
  const lock = path.join(outDir, LOCK_NAME);
  const l = readJson(lock);
  if (l && l.pid === pid) fs.unlinkSync(lock); // only the lock this builder holds
}

/** ensure(opts) -> {status, reason, out_dir, graph, report}. Without wait: start a detached node wrapper
 *  (`ensure --wait`) and return at once. With wait: run `graphify update .` (cwd = root) under a timeout; on exit 0 write
 *  a stamp with the newest code mtime seen BEFORE the build, because graphify leaves graph.json untouched when the
 *  topology did not change. Fails open: every problem becomes a status, never a throw. */
function ensure(opts) {
  const o = opts || {};
  const root = path.resolve(o.root || process.cwd());
  const env = o.env || process.env;
  const outDir = path.join(root, 'graphify-out');
  const graph = path.join(outDir, 'graph.json');
  const reportPath = path.join(outDir, 'GRAPH_REPORT.md');
  const done = (status, reason) => ({ status, reason, out_dir: outDir, graph, report: mtimeIfFile(reportPath) !== null ? reportPath : null });
  try {
    if (String(env.FORGE_GRAPHIFY || '').toLowerCase() === 'off') return done('skipped', 'FORGE_GRAPHIFY=off');
    if (sameDir(root, o.home || os.homedir())) return done('skipped', 'root is the home folder');
    if (sameDir(root, path.parse(root).root)) return done('skipped', 'root is a drive root');
    if (!hasMarker(root)) return done('skipped', 'no project marker (no .claude folder or .git in the root)');
    const src = scanCode(root);
    if (src.count < MIN_CODE_FILES) return done('skipped', 'only ' + src.count + ' code files (need ' + MIN_CODE_FILES + ')');
    const gm = mtimeIfFile(graph);
    const stamp = readJson(path.join(outDir, STAMP_NAME));
    const stamped = stamp && typeof stamp.newest === 'number' ? stamp.newest : 0;
    if (gm !== null && gm >= src.newest) return done('fresh', 'graph.json is newer than the newest code file');
    if (gm !== null && stamped >= src.newest) return done('fresh', 'the last good build covers the newest code file (graph unchanged)');
    const now = o.now === undefined ? Date.now() : o.now;
    if (!o.wait) {
      const l = readJson(path.join(outDir, LOCK_NAME));
      const age = l && typeof l.started === 'number' ? now - l.started : -1;
      // a lock without a pid comes from a spawn that failed: dead, like a lock whose pid is gone
      if (age >= 0 && age < LOCK_TTL_MS && typeof l.pid === 'number' && (o.isAlive || pidAlive)(l.pid)) return done('building', 'a background build is already running');
      const f = readJson(path.join(outDir, LAST_NAME));
      const since = f && typeof f.at === 'number' ? now - f.at : -1;
      if (f && f.failed === true && typeof f.newest === 'number' && src.newest <= f.newest && since >= 0 && since < RETRY_AFTER_MS) {
        return done('unavailable', 'the last graph build failed (' + String(f.reason).slice(0, 200) + '); it is tried again after a code edit or in 6 hours');
      }
    }
    const found = o.found || (o.locate || locate)({ env, run: o.run, home: o.home, exists: o.exists, platform: o.platform, probeTimeout: o.wait ? PROBE_TIMEOUT_MS : SHORT_PROBE_MS });
    if (!found || !found.ok) return done('unavailable', (found && found.reason) || 'graphify not found');
    if (o.wait) {
      try { writeLock(outDir, process.pid, now); } catch (e) { /* lock is best effort: the build still runs */ }
      const r = (o.run || defaultRun)(found.cmd, found.args.concat(['update', '.']), { timeout: o.buildTimeout || BUILD_TIMEOUT_MS, cwd: root, stdio: 'ignore' });
      if (r && r.status === 0 && mtimeIfFile(graph) !== null) {
        try { fs.writeFileSync(path.join(outDir, STAMP_NAME), JSON.stringify({ newest: src.newest, built: Date.now() })); }
        catch (e) { /* no stamp: the next call builds once more, nothing breaks */ }
        try { fs.unlinkSync(path.join(outDir, LAST_NAME)); } catch (e) { /* no failure on record: nothing to clear */ }
        return done('built', 'graphify update finished');
      }
      const why = r && r.error ? r.error.code || r.error.message : r && r.status === 0 ? 'exit 0 but no graph.json' : 'exit ' + (r ? r.status : '?');
      const reason = 'graphify update failed (' + why + ')';
      // recorded so the next start does not launch the same doomed build again (see the !o.wait branch above)
      try { fs.writeFileSync(path.join(outDir, LAST_NAME), JSON.stringify({ failed: true, newest: src.newest, reason, at: now })); }
      catch (e) { /* no record: the next call simply tries once more */ }
      return done('unavailable', reason);
    }
    const spawn = o.spawn || require('child_process').spawn;
    const wrapperArgs = [__filename, 'ensure', '--root', root, '--wait', '--found', JSON.stringify({ cmd: found.cmd, args: found.args })];
    const child = spawn(process.execPath, wrapperArgs, { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    if (child && typeof child.on === 'function') child.on('error', () => {}); // fail open: a late spawn error must not crash the caller
    if (child && typeof child.unref === 'function') child.unref();
    try { writeLock(outDir, child && child.pid, now); }
    catch (e) { /* lock is best effort: without it the next call may start one more build */ }
    return done('building', 'background build started (graphify update)');
  } catch (e) {
    return done('unavailable', 'graphify ensure failed: ' + e.message);
  } finally {
    if (o.wait) { try { releaseOwnLock(outDir, process.pid); } catch (e) { /* lock already gone or unreadable: nothing to release */ } }
  }
}

const USAGE = 'usage: forge-graphify.cjs which | version | smoke | check-skill | fix-skill [--skill-dir D] | run -- <args> | ensure [--root D] [--json] [--wait] [--found <json>]  (-h/--help prints this)';

/** --found '{"cmd":"...","args":[...]}' is how the background wrapper gets the graphify its caller located. Only a value
 *  that is one of candidates() for this process (same env, home and platform) is accepted, so the flag can never run an
 *  arbitrary program: the wrapper is a bare `node` command line anyone can call. */
function parseFound(text) {
  let f;
  try { f = JSON.parse(text); } catch (e) { return null; }
  if (!f || typeof f.cmd !== 'string' || !f.cmd || !Array.isArray(f.args) || !f.args.every((a) => typeof a === 'string')) return null;
  const key = (c) => path.resolve(c.cmd).toLowerCase() + '|' + JSON.stringify(c.args);
  const known = candidates({ env: process.env, home: os.homedir(), platform: process.platform });
  if (!known.some((c) => key(c) === key(f))) return null;
  return { ok: true, cmd: f.cmd, args: f.args, source: 'wrapper', version: null };
}

function ensureCli(argv) {
  const flags = { root: null, json: false, wait: false, found: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--wait') flags.wait = true;
    else if (a === '--root' && argv[i + 1] && !argv[i + 1].startsWith('--')) flags.root = argv[++i];
    else if (a === '--found' && i + 1 < argv.length) {
      flags.found = parseFound(argv[++i]);
      if (!flags.found) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const r = ensure({ root: flags.root || process.cwd(), wait: flags.wait, found: flags.found || undefined });
  console.log(flags.json ? JSON.stringify(r) : 'graphify: ' + r.status + ' (' + r.reason + ')' + (r.status === 'fresh' || r.status === 'built' ? ' ' + r.graph : ''));
  return 0;
}

function argValue(argv, flag) { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; }

function main(argv) {
  const cmd = argv[0];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return 0; }
  const skillDir = argValue(argv, '--skill-dir') || path.join(os.homedir(), '.claude', 'skills', 'graphify');
  if (cmd === 'ensure') return ensureCli(argv);
  if (cmd === 'smoke') {
    const r = smoke({});
    for (const s of r.steps) console.log('  ' + JSON.stringify(s));
    console.log(r.ok ? 'graphify smoke OK (' + r.version + ', ' + r.nodes + ' nodes, ' + r.links + ' links; temp folder removed)' : 'graphify smoke FAILED: ' + r.reason);
    return r.ok ? 0 : (r.steps.length ? 1 : 2);
  }
  const found = locate({});
  if (cmd === 'which' || cmd === 'version') {
    if (!found.ok) { console.error(found.reason); return 2; }
    console.log(cmd === 'which' ? [found.cmd].concat(found.args).join(' ') + '  (' + found.source + ', ' + found.version + ')' : found.version);
    return 0;
  }
  if (cmd === 'check-skill' || cmd === 'fix-skill') {
    if (cmd === 'fix-skill') { const f = fixSkill(skillDir); console.log(f.changed ? 'fixed: ' + f.changes.join('; ') + ' (backup ' + f.backup + ')' : 'frontmatter already correct'); }
    const c = checkSkill(skillDir, found.ok ? found.version : null);
    if (!found.ok) c.problems.push(found.reason);
    console.log(c.problems.length ? 'skill problems:\n  - ' + c.problems.join('\n  - ') : 'graphify skill OK (name ' + c.name + ', marker ' + c.marker + ')');
    return c.problems.length ? 1 : 0;
  }
  if (cmd === 'run') {
    if (!found.ok) { console.error(found.reason); return 2; }
    const rest = argv.slice(argv.indexOf('--') >= 0 ? argv.indexOf('--') + 1 : 1);
    const r = spawnSync(found.cmd, found.args.concat(rest), { stdio: 'inherit', windowsHide: true, shell: false });
    if (r.error) { console.error('graphify could not start: ' + r.error.message); return 2; }
    return r.status === null ? 1 : r.status;
  }
  console.error(USAGE);
  return 2;
}

module.exports = { parseVersion, candidates, locate, normalizeSkillText, checkSkill, fixSkill, smoke, ensure, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
