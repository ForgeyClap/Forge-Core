#!/usr/bin/env node
'use strict';
/**
 * forge-setup-inventory.cjs — read-only, redacted inventory of the project and global Claude Code setup.
 * WP-AS-INV: the deterministic step 1 of the forge-audit-setup skill (a Forge rebuild of
 * sam-illingworth/audit-setup). It lists what a Claude Code setup has
 * (project layer + global layer) so an agent can compare it with the latest Claude Code features.
 *
 * Safety: never opens credential, .env, key or secrets/ files; writes key NAMES, never values, except an
 * allow-list of non-secret scalar settings; hook commands are reduced to their script file name; MCP servers to
 * name + transport; plugins to id, scope, enabled, version; plugin hooks to event, matcher and async flag.
 * Every string written out has the home path replaced by ~ and every URL by <url>.
 *
 * Usage: node forge-setup-inventory.cjs [--root <dir>] [--home <dir>] [--json] [--out <file>] [--claude-version <s>]
 *        [--plugins-json <file>]   (a saved `claude plugin list --json`; without it the CLI is asked, 20 s timeout)
 * Exit: 0 ok, 1 could not run.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA = 'forge-setup-inventory/v1';
const VALUE_KEYS = ['model', 'effortLevel', 'ultracode', 'outputStyle', 'theme', 'autoUpdates', 'cleanupPeriodDays'];
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const TRANSPORTS = new Set(['stdio', 'http', 'sse']);

/** True for a path (relative to the layer base) that must never be opened or listed. */
function isForbiddenPath(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === 'secrets')) return true;
  const b = (parts[parts.length - 1] || '').toLowerCase();
  if (b === '.credentials.json' || b === 'credentials.json') return true;
  if (b === '.env' || (b.startsWith('.env.') && b !== '.env.example')) return true;
  if (b.endsWith('.pem') || b.startsWith('id_rsa')) return true;
  return false;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function makeRedactor(userHome) {
  const h = String(userHome || '').replace(/[\\/]+$/, '');
  const homeRe = h ? new RegExp(h.split(/[\\/]+/).map(escapeRe).join('[\\\\/]+'), process.platform === 'win32' ? 'gi' : 'g') : null;
  return (s) => {
    let r = String(s).replace(/https?:\/\/[^\s"'<>)]+/gi, '<url>');
    if (homeRe) r = r.replace(homeRe, '~');
    return r;
  };
}
const redact = makeRedactor(os.homedir());

function deepRedact(v, red) {
  if (typeof v === 'string') return red(v);
  if (Array.isArray(v)) return v.map((x) => deepRedact(x, red));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[red(k)] = deepRedact(x, red);
    return o;
  }
  return v;
}

/** Reads base/rel as text, or null when it is missing. Throws on a forbidden path (fail closed). */
function safeRead(base, rel) {
  if (isForbiddenPath(rel)) throw new Error('refused to open a forbidden file');
  const p = path.join(base, rel);
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return null; throw e; }
}
function listDir(base, rel) {
  try { return fs.readdirSync(path.join(base, rel), { withFileTypes: true }).filter((d) => !isForbiddenPath(rel + '/' + d.name)); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []; throw e; }
}
function readJson(base, rel) {
  const text = safeRead(base, rel);
  if (text === null) return { exists: false, data: null, parse_error: null };
  try { return { exists: true, data: JSON.parse(text.replace(/^﻿/, '')), parse_error: null }; } catch { return { exists: true, data: null, parse_error: 'invalid JSON' }; }
}

/** Frontmatter, one line per key (no YAML parser). */
function frontmatter(text) {
  const out = {};
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// commandBasename fails CLOSED (reviews rv-as-final-034807 r1-r3: every hand-listed quoting form left another one open).
// A command that starts with an assignment, an env-setting word or a PowerShell $env: is reported as <assignment>; a
// script name is taken only at a token start (so --out=x.sh never yields x.sh); a first token that still holds a quote,
// '=', '$' or a backtick is <unparsed>. Nothing of a leading NAME=, NAME+=, env/set/export or $env: assignment can reach
// the output; a value shaped like a script name elsewhere (a mid-command assignment, a PowerShell `$K='v.ps1';`, a flag
// value `--out x.sh`) can still show as that file name (reviews r4/r5, accepted: a file name, not a secret value).
const LEAD_ASSIGN_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*\+?=|\$env:|(?:env|set|cross-env|export)(?:\s|$))/i;
const SCRIPT_RE = /(?<=^|[\s"'\\/])[^\s"'\\/=$`]+\.(?:c?js|mjs|ts|py|ps1|sh|cmd|bat|exe)(?=["'\s;&|)]|$)/i;
function commandBasename(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '';
  if (LEAD_ASSIGN_RE.test(s)) return '<assignment>';
  const script = SCRIPT_RE.exec(s);
  if (script) return script[0];
  const q = /^"([^"]+)"|^'([^']+)'/.exec(s);
  const first = q ? (q[1] || q[2]) : (s.match(/^\S+/) || [''])[0];
  if (/["'=$`]/.test(first) || first.startsWith('-')) return '<unparsed>';
  return path.basename(first.replace(/\\/g, '/'));
}

function settingsSummary(base, rel) {
  const j = readJson(base, rel);
  const out = { exists: j.exists, parse_error: j.parse_error };
  const d = j.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) { if (j.exists && !j.parse_error) out.parse_error = 'not a JSON object'; return { out, data: null }; }
  out.keys = Object.keys(d);
  out.values = {};
  for (const k of VALUE_KEYS) if (['string', 'number', 'boolean'].includes(typeof d[k])) out.values[k] = d[k];
  out.values.attribution_present = 'attribution' in d; // includeCoAuthoredBy is deprecated; its value is not reported
  out.modelSettings = {};
  for (const [m, v] of Object.entries(d.modelSettings && typeof d.modelSettings === 'object' ? d.modelSettings : {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    out.modelSettings[m] = typeof v.effortLevel === 'string' ? { effortLevel: v.effortLevel } : {};
  }
  const perm = d.permissions && typeof d.permissions === 'object' ? d.permissions : {};
  if (typeof perm.defaultMode === 'string') out.values['permissions.defaultMode'] = perm.defaultMode;
  out.hooks = {};
  for (const [ev, groups] of Object.entries(d.hooks && typeof d.hooks === 'object' ? d.hooks : {})) {
    out.hooks[ev] = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
        const row = { matcher: typeof g.matcher === 'string' ? g.matcher : '', command_basename: commandBasename(h && h.command) };
        // non-secret hook settings an audit needs (review r2 finding 4): the timeout in seconds and the onFailure mode
        if (h && typeof h.timeout === 'number') row.timeout = h.timeout;
        if (h && typeof h.onFailure === 'string' && /^[a-z-]{1,20}$/.test(h.onFailure)) row.on_failure = h.onFailure;
        out.hooks[ev].push(row);
      }
    }
  }
  const tools = new Set();
  const count = (k) => { const a = Array.isArray(perm[k]) ? perm[k] : []; for (const r of a) tools.add(String(r).split('(')[0].trim()); return a.length; };
  out.permissions = { allow: count('allow'), deny: count('deny'), ask: count('ask'), tools: [...tools].filter(Boolean).sort() };
  const env = d.env && typeof d.env === 'object' ? Object.keys(d.env) : [];
  out.env = env.map((name) => ({ name, secret_named: SECRET_NAME.test(name) }));
  out.enabledPlugins = {};
  for (const [id, v] of Object.entries(d.enabledPlugins && typeof d.enabledPlugins === 'object' ? d.enabledPlugins : {})) out.enabledPlugins[id] = v === true;
  out.experimental = out.keys.filter((k) => /experimental/i.test(k)).concat(env.filter((k) => /experimental/i.test(k)).map((k) => 'env.' + k));
  return { out, data: d };
}

function mcpList(servers, source) {
  return Object.entries(servers && typeof servers === 'object' ? servers : {}).map(([name, s]) => {
    const t = s && typeof s.type === 'string' ? s.type.toLowerCase() : (s && s.command ? 'stdio' : 'unknown');
    return { source, name, transport: TRANSPORTS.has(t) ? t : 'other' };
  });
}

function claudeMd(base, rel, withIncludes) {
  const text = safeRead(base, rel);
  if (text === null) return { exists: false, lines: 0 };
  const out = { exists: true, lines: text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) };
  if (withIncludes) out.includes = text.split(/\r?\n/).map((l) => /^@(\S+)/.exec(l.trim())).filter(Boolean).map((m) => path.basename(m[1].replace(/\\/g, '/')));
  return out;
}

function skills(base, rel) {
  const out = [];
  for (const d of listDir(base, rel)) {
    if (!d.isDirectory()) continue;
    const text = safeRead(base, rel + '/' + d.name + '/SKILL.md');
    if (text === null) continue;
    const fm = frontmatter(text);
    out.push({ name: fm.name || d.name, user_invoked: fm['disable-model-invocation'] === 'true', description_chars: (fm.description || '').length });
  }
  return out;
}
function agents(base, rel) {
  return listDir(base, rel).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => {
    const fm = frontmatter(safeRead(base, rel + '/' + d.name));
    return { name: fm.name || d.name.slice(0, -3), model: fm.model || null, effort: fm.effort || null };
  });
}
const fileNames = (base, rel, filter) => listDir(base, rel).filter((d) => d.isFile() && (!filter || filter(d.name))).map((d) => d.name).sort();

function layer(base, kind) {
  const g = kind === 'global';
  const pre = g ? '' : '.claude/';
  const out = { path: base, claude_md: claudeMd(base, 'CLAUDE.md', g), settings: {} };
  let mainData = null;
  for (const rel of g ? ['settings.json'] : ['.claude/settings.json', '.claude/settings.local.json']) {
    const { out: s, data } = settingsSummary(base, rel);
    out.settings[rel] = s;
    if (rel === 'settings.json') mainData = data;
  }
  if (g) out.mcp = mcpList(mainData && mainData.mcpServers, 'settings.json');
  else {
    const m = readJson(base, '.mcp.json');
    out.mcp = m.data ? mcpList(m.data.mcpServers, '.mcp.json') : [];
    if (m.parse_error) out.mcp_parse_error = m.parse_error;
  }
  out.skills = skills(base, pre + 'skills');
  out.agents = agents(base, pre + 'agents');
  out.commands = fileNames(base, pre + 'commands', (n) => n.endsWith('.md'));
  if (g) out.hook_scripts = fileNames(base, 'hooks');
  return out;
}

function detectClaudeVersion() {
  try {
    // win32: claude is a .cmd shim, so run through the shell as one fixed string (no args array: DEP0190).
    const opts = { encoding: 'utf8', timeout: 15000, windowsHide: true };
    const r = process.platform === 'win32'
      ? require('child_process').spawnSync('claude --version', { ...opts, shell: true })
      : require('child_process').spawnSync('claude', ['--version'], opts);
    const line = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim().split(/\r?\n/)[0] : '';
    return line || null;
  } catch { return null; }
}

/** Raw plugin list: from a JSON file when given, else `claude plugin list --json`. Never throws. */
function pluginListRaw(pluginsJson) {
  let text;
  let source = 'cli';
  if (pluginsJson) {
    source = 'file';
    if (isForbiddenPath(pluginsJson)) return { source, list: null, reason: 'refused a forbidden file' };
    try { text = fs.readFileSync(pluginsJson, 'utf8'); } catch (e) { return { source, list: null, reason: 'could not read the file (' + (e.code || 'error') + ')' }; }
  } else {
    try {
      const opts = { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
      const r = process.platform === 'win32'
        ? require('child_process').spawnSync('claude plugin list --json', { ...opts, shell: true })
        : require('child_process').spawnSync('claude', ['plugin', 'list', '--json'], opts);
      if (r.error) return { source, list: null, reason: 'claude plugin list failed (' + (r.error.code || 'error') + ')' };
      if (r.status !== 0) return { source, list: null, reason: 'claude plugin list exited ' + r.status };
      text = r.stdout;
    } catch (e) { return { source, list: null, reason: 'claude plugin list failed (' + (e.code || 'error') + ')' }; }
  }
  let list;
  try { list = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return { source, list: null, reason: 'invalid JSON' }; }
  if (!Array.isArray(list)) return { source, list: null, reason: 'not a JSON array' };
  return { source, list: list.filter((p) => p && typeof p === 'object'), reason: null };
}

/** Hooks of one installed plugin: per event, matcher and async flag only (never the command). */
function pluginHooks(p) {
  const base = path.resolve(String(p.installPath));
  const out = { plugin: String(p.id), install_path: base, source: null, hooks: {} };
  try {
    let rel = 'hooks/hooks.json';
    let data = null;
    const manifest = readJson(base, '.claude-plugin/plugin.json');
    const mh = manifest.data && manifest.data.hooks;
    if (typeof mh === 'string') rel = mh;
    else if (mh && typeof mh === 'object') { rel = '.claude-plugin/plugin.json'; data = { hooks: mh }; }
    const abs = path.resolve(base, rel);
    const relN = path.relative(base, abs);
    if (!relN || relN.startsWith('..') || path.isAbsolute(relN)) { out.error = 'hooks file outside the plugin folder'; return out; }
    out.source = relN.replace(/\\/g, '/');
    if (!data) {
      const j = readJson(base, out.source);
      if (!j.exists) { out.source = null; return out; }
      if (j.parse_error) { out.error = j.parse_error; return out; }
      data = j.data;
    }
    const events = data && data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
    for (const [ev, groups] of Object.entries(events)) {
      out.hooks[ev] = [];
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
          out.hooks[ev].push({ matcher: typeof g.matcher === 'string' ? g.matcher : '', async: !!(h && h.async === true) });
        }
      }
    }
  } catch (e) { out.error = 'could not read hooks (' + (e.code || 'refused') + ')'; }
  return out;
}

/** The inventory object, already redacted. claudeVersion: a string, or null; undefined means detect.
 *  pluginsJson: a file with `claude plugin list --json` output; without it the CLI is asked. */
function inventory({ root = process.cwd(), home = path.join(os.homedir(), '.claude'), claudeVersion, userHome = os.homedir(), pluginsJson } = {}) {
  const pl = pluginListRaw(pluginsJson);
  const inv = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    claude_code_version: claudeVersion === undefined ? detectClaudeVersion() : claudeVersion,
    root: path.resolve(root),
    home: path.resolve(home),
    project: layer(path.resolve(root), 'project'),
    global: layer(path.resolve(home), 'global'),
    plugins_cli: {
      source: pl.source,
      reason: pl.reason,
      plugins: pl.list && pl.list.map((p) => ({ id: String(p.id), scope: typeof p.scope === 'string' ? p.scope : null, enabled: p.enabled === true, version: typeof p.version === 'string' ? p.version : null })),
    },
    plugin_hooks: (pl.list || []).filter((p) => p.enabled === true && typeof p.installPath === 'string' && p.installPath).map(pluginHooks),
  };
  return deepRedact(inv, makeRedactor(userHome));
}

function textSummary(inv) {
  const L = [];
  L.push('Claude Code setup inventory (' + inv.schema + ')');
  L.push('Claude Code version: ' + (inv.claude_code_version || 'unknown'));
  for (const [name, l] of [['Project', inv.project], ['Global', inv.global]]) {
    L.push('');
    L.push(name + ': ' + l.path);
    L.push('  CLAUDE.md: ' + (l.claude_md.exists ? l.claude_md.lines + ' lines' + (l.claude_md.includes ? ', ' + l.claude_md.includes.length + ' @includes' : '') : 'missing'));
    for (const [rel, s] of Object.entries(l.settings)) {
      if (!s.exists) { L.push('  ' + rel + ': missing'); continue; }
      if (s.parse_error) { L.push('  ' + rel + ': ' + s.parse_error); continue; }
      const hooks = Object.values(s.hooks).reduce((n, a) => n + a.length, 0);
      const plugins = Object.values(s.enabledPlugins);
      L.push('  ' + rel + ': ' + s.keys.length + ' keys, ' + hooks + ' hooks in ' + Object.keys(s.hooks).length + ' events, permissions ' + s.permissions.allow + '/' + s.permissions.deny + '/' + s.permissions.ask + ' (allow/deny/ask), ' +
        s.env.length + ' env names (' + s.env.filter((e) => e.secret_named).length + ' secret-named), plugins ' + plugins.filter(Boolean).length + ' on / ' + plugins.filter((v) => !v).length + ' off');
      const vals = Object.entries(s.values).map(([k, v]) => k + '=' + v).join(', ');
      if (vals) L.push('    values: ' + vals);
      if (s.experimental.length) L.push('    experimental: ' + s.experimental.join(', '));
    }
    L.push('  MCP servers: ' + l.mcp.length + (l.mcp_parse_error ? ' (.mcp.json: ' + l.mcp_parse_error + ')' : ''));
    L.push('  skills: ' + l.skills.length + ' (' + l.skills.filter((s) => s.user_invoked).length + ' user-invoked only)');
    L.push('  agents: ' + l.agents.length + ', commands: ' + l.commands.length + (l.hook_scripts ? ', hook scripts: ' + l.hook_scripts.length : ''));
  }
  L.push('');
  const pc = inv.plugins_cli;
  if (!pc.plugins) L.push('Plugins (' + pc.source + '): unknown (' + pc.reason + ')');
  else {
    const n = inv.plugin_hooks.reduce((s, p) => s + Object.values(p.hooks).reduce((m, a) => m + a.length, 0), 0);
    L.push('Plugins (' + pc.source + '): ' + pc.plugins.length + ' (' + pc.plugins.filter((p) => p.enabled).length + ' enabled), plugin hooks: ' + n + ' in ' + inv.plugin_hooks.length + ' plugins');
  }
  return L.join('\n') + '\n';
}

const USAGE = [
  'Usage: node forge-setup-inventory.cjs [--root <dir>] [--home <dir>] [--json] [--out <file>] [--claude-version <s>] [--plugins-json <file>]',
  'Read-only, redacted inventory of the project and the global Claude Code setup (names and counts, never secret values).',
  '  --root <dir>            project folder to inventory (default: the current folder)',
  '  --home <dir>            the global Claude folder (default: ~/.claude)',
  '  --json                  print the full JSON instead of the short text summary',
  '  --out <file>            write the output to <file> (its folder is created) and print only the summary',
  '  --claude-version <s>    use this version string instead of running `claude --version`',
  '  --plugins-json <file>   read the plugin list from this JSON file instead of running `claude plugin list --json`',
  '  -h, --help              show this help',
  'Example: node .claude/forge-bin/forge-setup-inventory.cjs --root . --json --out _scratch/audit-setup/setup-inventory.json',
  'Exit codes: 0 inventory written; 1 bad argument or the inventory could not be taken (the reason is on stderr).',
  'Tested on Windows 11 (Git Bash and PowerShell); the POSIX paths of `claude --version` and the plugin list are not tested.',
  ''].join('\n');
function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(k + ' needs a value'); return argv[++i]; };
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--json') a.json = true;
    else if (k === '--root') a.root = val();
    else if (k === '--home') a.home = val();
    else if (k === '--out') a.out = val();
    else if (k === '--claude-version') a.claudeVersion = val();
    else if (k === '--plugins-json') a.pluginsJson = val();
    else throw new Error('unknown argument: ' + k);
  }
  return a;
}

function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { process.stderr.write('forge-setup-inventory: ' + e.message + '\n' + USAGE); return 1; }
  if (a.help) { process.stdout.write(USAGE); return 0; }
  try {
    const inv = inventory({ root: a.root, home: a.home, claudeVersion: a.claudeVersion, pluginsJson: a.pluginsJson });
    const text = a.json ? JSON.stringify(inv, null, 2) + '\n' : textSummary(inv);
    if (a.out) {
      // the full inventory goes to the file only; the agent's context gets the short summary (review finding 7)
      fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
      fs.writeFileSync(a.out, text);
      process.stdout.write(textSummary(inv) + 'written ' + redact(path.resolve(a.out)) + ' (' + Buffer.byteLength(text) + ' bytes)\n');
    } else process.stdout.write(text);
    return 0;
  } catch (e) {
    process.stderr.write('forge-setup-inventory: could not run (' + redact((e && (e.code || e.message)) || 'error') + ')\n');
    return 1;
  }
}

module.exports = { inventory, textSummary, isForbiddenPath, redact, commandBasename, frontmatter, SCHEMA };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
