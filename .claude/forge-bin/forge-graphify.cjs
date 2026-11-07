#!/usr/bin/env node
'use strict';
// forge-graphify.cjs — Forge adapter for the graphify CLI (graphifyy, a uv tool) — WP SA-P1-ADAPT, PHASE2-PLAN A9 + E.
// Finds graphify (GRAPHIFY_BIN, PATH, ~/.local/bin, the uv tool python with -m graphify), runs it without a shell,
// checks/fixes the global skill frontmatter (name "graphify", no non-standard "trigger:" key, version marker current)
// and runs a real smoke test (--help, then a code-only graph build on a temp folder that is deleted afterwards).
//
// Usage: node forge-graphify.cjs which | version | smoke | check-skill [--skill-dir D] | fix-skill [--skill-dir D]
//        node forge-graphify.cjs run -- <graphify args...>
// Exit codes: 0 ok, 1 check/smoke failed, 2 graphify not found or bad usage.
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
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: o.timeout || PROBE_TIMEOUT_MS, cwd: o.cwd });
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
  const tried = [];
  for (const c of candidates({ env, home, platform })) {
    if (!exists(c.cmd)) { tried.push({ cmd: c.cmd, result: 'missing' }); continue; }
    const r = run(c.cmd, c.args.concat(['--version']), { timeout: PROBE_TIMEOUT_MS });
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

const USAGE = 'usage: forge-graphify.cjs which | version | smoke | check-skill | fix-skill [--skill-dir D] | run -- <args>  (-h/--help prints this)';

function argValue(argv, flag) { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; }

function main(argv) {
  const cmd = argv[0];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return 0; }
  const skillDir = argValue(argv, '--skill-dir') || path.join(os.homedir(), '.claude', 'skills', 'graphify');
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

module.exports = { parseVersion, candidates, locate, normalizeSkillText, checkSkill, fixSkill, smoke, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
