'use strict';
/**
 * doctor/checks-adapters.cjs — one module of forge-doctor.cjs (SA-P1B-DOCTOR): skill_adapters.
 * Rule "added = installed + wired + used": a global skill that Forge runs through an adapter in forge-bin is only
 * usable while that adapter still works. The doctor RUNS each adapter's cheap step (no build, no network):
 *   graphify — node forge-graphify.cjs check-skill --skill-dir <home>/skills/graphify (locates the CLI with
 *              --version, checks the skill frontmatter and its version marker);
 *   watch    — node forge-watch-launch.cjs which (resolves a working Python 3) plus the launcher's own
 *              resolveScript(<skill>, 'watch.py') step;
 *   claude-mem — files only: the enabled plugin's install path, its CLAUDE_CODE_PATH, and the bare `claude-mem` hook
 *              launcher on PATH (red when no PATH has it, warn when only this session lacks it);
 *   agent-skill-refs — the on-demand skills named in .claude/agents bodies resolve (red on a retired skill, warn when
 *              a name is found nowhere; 2026-11-05 review M2).
 * An adapter is applicable only when its skill is installed (<home>/skills/<id>/SKILL.md). ENFORCED in the development
 * tree; elsewhere a broken adapter is labelled (ok:true, enforced:false), like skill_frontmatter. The machine is only
 * read for this doctor's own project root or an explicit opts.claudeHome, so a fixture root never runs the real tools.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { BIN_DIR } = require('./context.cjs');
const { readDevTreeMarker } = require('./checks-hygiene.cjs');

const ADAPTER_TIMEOUT_MS = 60000;
const ADAPTERS = Object.freeze([
  { id: 'graphify', tool: 'forge-graphify.cjs', args: (skillDir) => ['check-skill', '--skill-dir', skillDir] },
  { id: 'watch', tool: 'forge-watch-launch.cjs', args: () => ['which'], env: (skillDir) => ({ WATCH_SKILL_DIR: skillDir }), script: 'watch.py' },
]);

function claudeHomeDir(o) {
  if (o.claudeHome) return o.claudeHome;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  try { return path.join(require('os').homedir(), '.claude'); } catch { return null; }
}
function isOwnProjectRoot(root) {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch { /* keep resolved */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(root) === norm(path.join(__dirname, '..', '..', '..'));
}
function defaultRun(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: opts.timeout, env: opts.env });
}
/** firstLine(r) -> the most telling output line: a "- problem" line, else the first non-empty stderr/stdout line. */
function firstLine(r) {
  const text = String((r && r.stderr) || '') + '\n' + String((r && r.stdout) || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const problem = lines.find((l) => l.startsWith('- '));
  return (problem ? problem.slice(2) : (lines.find((l) => !/^skill problems:?$/i.test(l)) || '')).slice(0, 200);
}
/** runAdapter(spec, home, binDir, run) -> {id, applicable, ok, tool, exit, ms, reason}. */
function runAdapter(spec, home, binDir, run) {
  const t0 = Date.now();
  const skillDir = path.join(home, 'skills', spec.id);
  const base = { id: spec.id, tool: spec.tool, skill_dir: skillDir };
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return Object.assign(base, { applicable: false, ok: true, ms: 0, reason: 'skill not installed' });
  const toolPath = path.join(binDir, spec.tool);
  if (!fs.existsSync(toolPath)) return Object.assign(base, { applicable: true, ok: false, ms: 0, reason: spec.tool + ' is missing from forge-bin' });
  const env = Object.assign({}, process.env, spec.env ? spec.env(skillDir) : {});
  let r;
  try { r = run(process.execPath, [toolPath].concat(spec.args(skillDir)), { timeout: ADAPTER_TIMEOUT_MS, env, shell: false }) || {}; } catch (e) { r = { status: null, error: e }; }
  const ms = Date.now() - t0;
  if (r.error || r.status === null || r.status === undefined) {
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out after ' + ADAPTER_TIMEOUT_MS + ' ms (ETIMEDOUT)' : (r.error.code || r.error.message)) : 'no exit code';
    return Object.assign(base, { applicable: true, ok: false, exit: null, ms, reason: spec.tool + ' did not finish: ' + why });
  }
  if (r.status !== 0) return Object.assign(base, { applicable: true, ok: false, exit: r.status, ms, reason: spec.tool + ' exit ' + r.status + (firstLine(r) ? ' (' + firstLine(r) + ')' : '') });
  if (spec.script && !fs.existsSync(path.join(skillDir, 'scripts', spec.script))) {
    return Object.assign(base, { applicable: true, ok: false, exit: 0, ms, reason: 'script not found: ' + path.join(skillDir, 'scripts', spec.script) });
  }
  return Object.assign(base, { applicable: true, ok: true, exit: 0, ms, reason: '' });
}
/** claudeMemHealth(home, memDir) -> one adapter-shaped entry for the global claude-mem plugin Forge calls
 *  its CLAUDE_CODE_PATH pointed at a removed VS Code extension build, so every summary run failed
 *  and nothing was recorded for months). Applicable only while <home>/settings.json enables claude-mem@thedotmack.
 *  Reads files only: the install path from <home>/plugins/installed_plugins.json must hold scripts/worker-service.cjs,
 *  and a CLAUDE_CODE_PATH in <memDir>/settings.json must exist on disk. No network, no spawn. */
const CLAUDE_MEM_ID = 'claude-mem@thedotmack';
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function claudeMemHealth(home, memDir, opts) {
  const base = { id: 'claude-mem', tool: '(plugin files)', timed: false };
  const settings = readJson(path.join(home, 'settings.json'));
  if (!settings || !settings.enabledPlugins || settings.enabledPlugins[CLAUDE_MEM_ID] !== true) return Object.assign(base, { applicable: false, ok: true, reason: 'plugin not enabled' });
  const inst = readJson(path.join(home, 'plugins', 'installed_plugins.json'));
  const rows = inst && ((inst.plugins || inst)[CLAUDE_MEM_ID]);
  const installPath = Array.isArray(rows) && rows[0] && rows[0].installPath;
  if (!installPath) return Object.assign(base, { applicable: true, ok: false, reason: 'enabled but no install record in plugins/installed_plugins.json' });
  if (!fs.existsSync(path.join(installPath, 'scripts', 'worker-service.cjs'))) return Object.assign(base, { applicable: true, ok: false, reason: 'install path missing or incomplete: ' + installPath });
  const mem = readJson(path.join(memDir, 'settings.json')) || {};
  if (mem.CLAUDE_CODE_PATH && !fs.existsSync(mem.CLAUDE_CODE_PATH)) {
    return Object.assign(base, { applicable: true, ok: false, reason: 'CLAUDE_CODE_PATH in ' + path.join(memDir, 'settings.json') + ' does not exist (' + mem.CLAUDE_CODE_PATH + '); summaries cannot run' });
  }
  const launcher = launcherState(installPath, opts || {});
  if (launcher.state === 'missing') return Object.assign(base, { applicable: true, ok: false, reason: launcher.reason });
  return Object.assign(base, { applicable: true, ok: true, reason: '' }, launcher.state === 'stale-session' ? { warn: launcher.reason } : {});
}
/** launcherState(installPath, {env, readUserPath}) -> {state: 'n/a'|'ok'|'stale-session'|'missing', reason}.
 *  the plugin's hooks run the bare command `claude-mem` (a launcher in %LOCALAPPDATA%/claude-mem/bin). It was
 *  installed and added to the user PATH at 13:44, but a Claude Code started earlier keeps its old PATH, so every
 *  claude-mem hook failed silently and nothing was recorded since 2026-10-16. 'stale-session' = only the persisted user
 *  PATH has it (the next session started from a new terminal works); 'missing' = not on this process PATH and either no
 *  persisted PATH has it or the registry read failed (the reason says which; round-5 N7). */
function findOnPath(name, pathValue, platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name];
  for (const dir of String(pathValue || '').split(sep)) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d) continue;
    for (const n of names) { try { if (fs.statSync(path.join(d, n)).isFile()) return path.join(d, n); } catch { /* not there */ } }
  }
  return null;
}
/** The PATH a NEW session would get: the persisted user PATH (HKCU) plus the system PATH (HKLM), env vars expanded.
 *  readRegPath -> {value, error}: round-5 N7 keeps a failed read (spawn error, timeout, non-zero exit, no
 *  Path value) apart from an empty PATH, so a failed read is never reported as "no PATH has the launcher". */
function readRegPath(key) {
  try {
    const r = require('child_process').spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.error) return { value: '', error: key + ': ' + (r.error.code || r.error.message) };
    if (r.status !== 0) return { value: '', error: key + ': reg query exit ' + r.status };
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => /\sREG_(EXPAND_)?SZ\s/.test(l));
    if (!line) return { value: '', error: key + ': no Path value in the reg query output' };
    return { value: line.replace(/^.*?REG_(EXPAND_)?SZ\s+/, '').replace(/%([^%]+)%/g, (m, k) => process.env[k] || m), error: null };
  } catch (e) { return { value: '', error: key + ': ' + ((e && e.message) || e) }; }
}
/** defaultReadUserPath() -> {path, error} (error null when every read worked; off Windows there is no persisted PATH,
 *  so path '' with no error). An injected readUserPath may return a plain string (a read that worked) or {path, error}. */
function defaultReadUserPath() {
  if (process.platform !== 'win32') return { path: '', error: null };
  const reads = [readRegPath('HKCU\\Environment'), readRegPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')];
  const errors = reads.map((r) => r.error).filter(Boolean);
  return { path: reads.map((r) => r.value).filter(Boolean).join(';'), error: errors.length ? errors.join('; ') : null };
}
function launcherState(installPath, o) {
  let hooks = '';
  try { hooks = fs.readFileSync(path.join(installPath, 'hooks', 'hooks.json'), 'utf8'); } catch { return { state: 'n/a', reason: '' }; }
  if (!/"command"\s*:\s*"claude-mem"/.test(hooks)) return { state: 'n/a', reason: '' };
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  if (findOnPath('claude-mem', env.PATH || env.Path, platform)) return { state: 'ok', reason: '' };
  const read = (o.readUserPath || defaultReadUserPath)();
  const userPath = read && typeof read === 'object' ? read.path : read;
  const readError = read && typeof read === 'object' ? read.error : null;
  if (userPath && findOnPath('claude-mem', userPath, platform)) {
    return { state: 'stale-session', reason: 'claude-mem hook launcher is on the user PATH but not on this process PATH: this Claude Code session started before it was added, so its claude-mem hooks record nothing; a session started from a new terminal records normally' };
  }
  if (readError) {
    return { state: 'missing', reason: 'the plugin hooks run the command claude-mem, which is not on this process PATH, so the claude-mem hooks of this session fail; the persisted user/system PATH could not be checked because the registry read failed (' + readError + '), so whether a new session finds the launcher is unknown (check: where claude-mem in a new terminal)' };
  }
  return { state: 'missing', reason: 'the plugin hooks run the command claude-mem, but no claude-mem launcher is on PATH, so every claude-mem hook fails and nothing is recorded (fix: npx claude-mem install, then restart Claude Code from a new terminal)' };
}
/** agentSkillRefs(root, home) -> one adapter-shaped entry. An agent body names on-demand skills
 *  after "say so and go on without it):". RED when a name now exists ONLY in a dated <home>/skills-retired-* folder (a
 *  pointer to a skill Forge retired: skill-builder in skill-boss.md); WARN when a name resolves nowhere the agent could
 *  read it (project or global skills incl. ecc/, a plugin skill, a global command or agent, or a built-in). Files only. */
const BUILTIN_NAMES = new Set(['claude-api', 'dataviz', 'deep-research']);
const REF_RE = /say so and go on without it\):\s*([^\n]*)/;
function pluginSkillExists(home, n) {
  const cache = path.join(home, 'plugins', 'cache');
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const a of ls(cache)) for (const b of ls(path.join(cache, a))) for (const c of ls(path.join(cache, a, b))) {
    if (fs.existsSync(path.join(cache, a, b, c, 'skills', n, 'SKILL.md'))) return true;
  }
  return false;
}
function resolveSkillRef(n, root, home) {
  const f = (...p) => fs.existsSync(path.join(...p));
  if (f(root, '.claude', 'skills', n, 'SKILL.md') || f(home, 'skills', n, 'SKILL.md') || f(home, 'skills', 'ecc', n, 'SKILL.md')) return 'skill';
  if (f(home, 'commands', n + '.md') || f(home, 'agents', n + '.md') || BUILTIN_NAMES.has(n) || pluginSkillExists(home, n)) return 'other';
  let retired = [];
  try { retired = fs.readdirSync(home).filter((d) => /^skills-retired-/.test(d)); } catch { retired = []; }
  return retired.some((d) => f(home, d, n, 'SKILL.md')) ? 'retired' : null;
}
function agentSkillRefs(root, home) {
  const base = { id: 'agent-skill-refs', tool: '(agent bodies)', timed: false };
  const dir = path.join(root, '.claude', 'agents');
  let files = [];
  try { files = fs.readdirSync(dir).filter((x) => x.endsWith('.md')); } catch { return Object.assign(base, { applicable: false, ok: true, reason: 'no .claude/agents' }); }
  const retired = [], unresolved = [];
  for (const file of files) {
    const m = REF_RE.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const n = raw.replace(/\(.*$/, '').replace(/[.`*]/g, '').trim();
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(n)) continue;
      const r = resolveSkillRef(n, root, home);
      if (r === 'retired') retired.push(file + ': ' + n);
      else if (r === null) unresolved.push(file + ': ' + n);
    }
  }
  if (retired.length) return Object.assign(base, { applicable: true, ok: false, reason: 'agent bodies point at retired skills (only in ~/.claude/skills-retired-*): ' + retired.join('; ') });
  return Object.assign(base, { applicable: true, ok: true, reason: '' }, unresolved.length ? { warn: 'named skill(s) not found anywhere: ' + unresolved.join('; ') } : {});
}
/** timingLabel(entry) -> ' (N ms)' for an adapter that was really run and timed, '' for a files-only entry (timed:false)
 *  or one without a number (round-5 N6, 2026-11-06: the files-only entries printed "(0 ms)" although nothing was timed). */
function timingLabel(a) { return a && a.timed !== false && typeof a.ms === 'number' ? ' (' + a.ms + ' ms)' : ''; }
/** adapterSmokeCheck(root, opts) -> {ok, applicable, enforced, adapters[], broken[], reason, ms}.
 *  opts: {claudeHome, claudeMemDir (default: .claude-mem next to the Claude home), run (injectable spawn), binDir (default forge-bin),
 *  env / readUserPath / platform (injectable PATH sources for the claude-mem launcher check)}. */
function adapterSmokeCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dev = readDevTreeMarker(root).valid;
  const home = (o.claudeHome || isOwnProjectRoot(root)) ? claudeHomeDir(o) : null;
  if (!home) {
    return { ok: true, applicable: false, enforced: dev, broken: [], ms: 0, reason: 'not this doctor\'s own project root — machine adapters not run',
      adapters: ADAPTERS.map((s) => ({ id: s.id, tool: s.tool, applicable: false, ok: true, ms: 0, reason: 'not run' })) };
  }
  const adapters = ADAPTERS.map((s) => runAdapter(s, home, o.binDir || BIN_DIR, o.run || defaultRun))
    .concat([claudeMemHealth(home, o.claudeMemDir || path.join(path.dirname(home), '.claude-mem'), { env: o.env, readUserPath: o.readUserPath, platform: o.platform }),
      agentSkillRefs(root, home)]);
  const broken = adapters.filter((a) => a.applicable && !a.ok);
  const warnings = adapters.filter((a) => a.applicable && a.ok && a.warn).map((a) => a.id + ': ' + a.warn);
  const applicable = adapters.some((a) => a.applicable);
  const reason = broken.length ? broken.map((a) => a.id + ': ' + a.reason).join('; ') + (dev ? '' : ' (not enforced outside the development tree)')
    : (warnings.length ? 'warn: ' + warnings.join('; ') : (applicable ? '' : 'no adapter skill installed (graphify, watch) and claude-mem not enabled — nothing to run'));
  return { ok: dev ? broken.length === 0 : true, applicable, enforced: dev, adapters, broken: broken.map((a) => a.id), warnings, reason, ms: Date.now() - t0 };
}

module.exports = { ADAPTERS, ADAPTER_TIMEOUT_MS, adapterSmokeCheck, claudeMemHealth, launcherState, agentSkillRefs, timingLabel };
