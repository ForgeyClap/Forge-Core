#!/usr/bin/env node
'use strict';
/**
 * forge-agentlint.cjs — (modernization 2026-10-24): a read-only linter for subagent files (.claude/agents/*.md).
 *
 * Rules, checked against the Claude Code subagent docs (code.claude.com/docs/en/sub-agents, read 2026-10-24) and
 * the Forge modernization audit of 2026-10-24 (row 1a, development tree only):
 *   - Claude Code ignores an unknown frontmatter field without an error, so every key outside KNOWN_KEYS is flagged
 *     (with the closest known key when one is near).
 *   - A file is SKIPPED silently when: the opening --- is not line 1, there is no name, the name starts with "-",
 *     contains ":" or is over 256 chars, there is a name but no description, or the YAML does not parse.
 *   - Value sets: model sonnet|opus|haiku|fable|inherit or a full claude-* id; effort low|medium|high|xhigh|max;
 *     permissionMode, memory, isolation (worktree), color, booleans, a positive integer maxTurns,
 *     autoCompactWindow 100000..1000000.
 * Forge rules: model + effort equal the agent's default GOAT route in .claude/FORGE_MODEL_ROUTING.json
 * (agentDefaults -> routes); the total description text is estimated at 4 chars/token and warned above 15k tokens.
 * Advisory audits (info, never errors): a writer without isolation: worktree, no maxTurns cap, a read-only agent
 * without omitClaudeMd (a trade-off: omitClaudeMd also drops the project's honesty rules from its context).
 *
 * CLI: node forge-agentlint.cjs [--root <dir>] [--json] [--strict]
 *   default = report mode, exit 0. --strict: exit 1 when any error-level finding exists. Zero dependencies, read-only.
 */
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./forge-skilllint.cjs');

const KNOWN_KEYS = ['name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'autoCompactWindow',
  'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd', 'effort', 'isolation', 'color', 'initialPrompt', 'experimental'];
const MODELS = ['sonnet', 'opus', 'haiku', 'fable', 'inherit'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'manual'];
const MEMORY = ['user', 'project', 'local'];
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
const BOOLEAN_KEYS = ['background', 'omitClaudeMd'];
const NAME_MAX = 256;
const DESCRIPTION_TOKEN_WARN = 15000;
const CHARS_PER_TOKEN = 4;
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const EXEC_TOOLS = ['Bash', 'PowerShell'];

function defaultRoot() {
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  try { const r = require('./forge-paths.cjs').scriptRoot(__dirname); if (r) return r; } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..');
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(Array(b.length).fill(0)));
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** closestKey(key) -> the known key it most likely meant, or null. Case/underscore/hyphen differences always match. */
function closestKey(key) {
  const norm = (k) => k.toLowerCase().replace(/[_-]/g, '');
  const exact = KNOWN_KEYS.find((k) => norm(k) === norm(key));
  if (exact) return exact;
  let best = null, bestD = 3;
  for (const k of KNOWN_KEYS) { const dd = distance(norm(key), norm(k)); if (dd < bestD) { best = k; bestD = dd; } }
  return best;
}

const val = (fm, k) => (fm.data[k] ? fm.data[k] : null);
const text = (fm, k) => (fm.data[k] && fm.data[k].kind === 'scalar' ? String(fm.data[k].value).trim() : '');
const toolList = (fm) => {
  const v = val(fm, 'tools');
  if (!v) return null;
  return (v.kind === 'list' ? v.value : String(v.value).split(',')).map((s) => String(s).trim().replace(/\(.*$/, '')).filter(Boolean);
};

function loadRouting(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'FORGE_MODEL_ROUTING.json'), 'utf8'));
    return { defaults: j.agentDefaults || {}, routes: j.routes || {} };
  } catch (e) { return { error: 'FORGE_MODEL_ROUTING.json unreadable (' + (e.code || e.message) + ')' }; }
}

function lintValues(fm, push) {
  const model = text(fm, 'model');
  if (fm.data.model && !MODELS.includes(model) && !/^claude-[a-z0-9.-]+$/.test(model)) push('error', 'value_model', 'model "' + model + '" is not one of ' + MODELS.join('|') + ' or a full claude-* model id');
  const effort = text(fm, 'effort');
  if (fm.data.effort && !EFFORTS.includes(effort) && !/^\d+$/.test(effort)) push('error', 'value_effort', 'effort "' + effort + '" is not one of ' + EFFORTS.join('|'));
  const pm = text(fm, 'permissionMode');
  if (fm.data.permissionMode && !PERMISSION_MODES.includes(pm)) push('error', 'value_permissionMode', 'permissionMode "' + pm + '" is not one of ' + PERMISSION_MODES.join('|'));
  const mem = text(fm, 'memory');
  if (fm.data.memory && !MEMORY.includes(mem)) push('error', 'value_memory', 'memory "' + mem + '" is not one of ' + MEMORY.join('|'));
  if (fm.data.isolation && text(fm, 'isolation') !== 'worktree') push('error', 'value_isolation', 'isolation "' + text(fm, 'isolation') + '" — the only value is worktree');
  if (fm.data.color && !COLORS.includes(text(fm, 'color'))) push('warn', 'value_color', 'color "' + text(fm, 'color') + '" is not one of ' + COLORS.join('|'));
  for (const k of BOOLEAN_KEYS) if (fm.data[k] && (fm.data[k].quoted || !['true', 'false'].includes(text(fm, k)))) push('error', 'value_boolean', k + ' must be an unquoted true or false');
  if (fm.data.maxTurns && !/^[1-9]\d*$/.test(text(fm, 'maxTurns'))) push('error', 'value_maxTurns', 'maxTurns "' + text(fm, 'maxTurns') + '" is not a positive integer');
  if (fm.data.autoCompactWindow) {
    const n = Number(text(fm, 'autoCompactWindow'));
    if (!/^\d+$/.test(text(fm, 'autoCompactWindow')) || n < 100000 || n > 1000000) push('error', 'value_autoCompactWindow', 'autoCompactWindow must be a plain integer from 100000 to 1000000 (200k is read as 200)');
  }
}

function lintGoat(fm, name, routing, push) {
  if (routing.error) { push('info', 'goat_unavailable', routing.error); return; }
  const route = routing.defaults[name];
  if (!route) { push('info', 'goat_unlisted', 'agent "' + name + '" has no default route in FORGE_MODEL_ROUTING.json agentDefaults'); return; }
  const want = routing.routes[route];
  if (!want) { push('error', 'goat_route_unknown', 'default route "' + route + '" is not a route in FORGE_MODEL_ROUTING.json'); return; }
  for (const k of ['model', 'effort']) {
    const have = text(fm, k);
    if (!have) push('error', 'goat_' + k + '_missing', k + ' is not set; GOAT route "' + route + '" needs ' + k + ': ' + want[k]);
    else if (have !== want[k]) push('error', 'goat_' + k + '_mismatch', k + ' is ' + have + ' but GOAT route "' + route + '" says ' + want[k]);
  }
}

function lintAdvisory(fm, push) {
  const tools = toolList(fm);
  const all = tools === null;
  const writes = all || tools.some((t) => WRITE_TOOLS.includes(t));
  const execs = all || tools.some((t) => EXEC_TOOLS.includes(t));
  if (writes && !fm.data.isolation) push('info', 'audit_isolation', 'can write files but has no isolation: worktree; parallel dispatches of it share one working tree (fine when the Lead gives each its own worktree)');
  if (!fm.data.maxTurns) push('info', 'audit_maxTurns', 'no maxTurns cap: a stuck run is only stopped from outside');
  if (!writes && !execs && !fm.data.omitClaudeMd) push('info', 'audit_omitClaudeMd', 'read-only agent without omitClaudeMd: true; it loads every CLAUDE.md (trade-off: setting it also drops the project rules from its context)');
}

/** lintAgentFile(root, abs, routing) -> {agent, file, findings, descriptionChars} */
function lintAgentFile(root, abs, routing) {
  const file = path.relative(root, abs).split(path.sep).join('/');
  const findings = [];
  const out = { agent: path.basename(abs, '.md'), file, findings, descriptionChars: 0 };
  const push = (level, rule, message) => findings.push({ level, rule, agent: out.agent, file, message });
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { push('error', 'unreadable', 'unreadable (' + (e.code || e.message) + ')'); return out; }
  const fm = parseFrontmatter(src);
  if (!fm.ok) { push('error', 'frontmatter', fm.reason + ' — Claude Code reads it as documentation and skips the agent'); return out; }
  if (fm.bom) push('warn', 'frontmatter_bom', 'the file starts with a byte-order mark before ---');
  for (const d of fm.duplicates) push('error', 'frontmatter_duplicate', 'key "' + d + '" appears twice (YAML that does not parse: the agent is skipped)');
  for (const ln of fm.badLines) push('warn', 'frontmatter_line', 'line ' + ln + ' is not a "key: value" line');
  for (const { key, line } of fm.keys) {
    if (KNOWN_KEYS.includes(key)) continue;
    const near = closestKey(key);
    push('error', 'unknown_key', 'line ' + line + ': unknown key "' + key + '"' + (near ? ' (did you mean "' + near + '"?)' : '') + ' — Claude Code ignores it silently');
  }
  const name = text(fm, 'name');
  if (!name) push('error', 'name_missing', 'no name: Claude Code treats the file as documentation and skips it');
  else if (/^-/.test(name) || name.includes(':') || name.length > NAME_MAX) push('error', 'name_invalid', 'name "' + name.slice(0, 60) + '" starts with -, contains : or is over ' + NAME_MAX + ' chars: the agent is skipped');
  const desc = text(fm, 'description');
  out.descriptionChars = desc.length;
  if (!desc) push('error', 'description_missing', 'no description: Claude Code skips the agent');
  if (name) out.agent = name;
  lintValues(fm, push);
  if (name) lintGoat(fm, name, routing, push);
  lintAdvisory(fm, push);
  return out;
}

/** lintAgents(root, opts) -> report. opts: {agentsDir}. Read-only. */
function lintAgents(root, opts) {
  const o = opts || {};
  const r = path.resolve(root);
  const dir = path.resolve(o.agentsDir || path.join(r, '.claude', 'agents'));
  let files = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => path.join(dir, e.name)).sort(); } catch { files = []; }
  const routing = loadRouting(r);
  const agents = files.map((f) => lintAgentFile(r, f, routing));
  const findings = [].concat(...agents.map((a) => a.findings));
  const totalChars = agents.reduce((n, a) => n + a.descriptionChars, 0);
  const tokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const relDir = path.relative(r, dir).split(path.sep).join('/');
  findings.push({ level: tokens > DESCRIPTION_TOKEN_WARN ? 'warn' : 'info', rule: 'description_tokens', agent: null, file: relDir, message: agents.length + ' agent description(s): ' + totalChars + ' chars, ~' + tokens + ' tokens (estimate at ' + CHARS_PER_TOKEN + ' chars/token; warn above ' + DESCRIPTION_TOKEN_WARN + ')' });
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  return { tool: 'forge-agentlint', root: r, agents: agents.length, counts, findings, description_chars: totalChars, description_tokens_estimate: tokens };
}

function formatReport(rep) {
  const out = ['forge-agentlint: ' + rep.agents + ' agent(s) · ' + rep.counts.error + ' error · ' + rep.counts.warn + ' warn · ' + rep.counts.info + ' info'];
  for (const f of rep.findings) out.push('  ' + (f.level === 'error' ? 'x' : f.level === 'warn' ? '!' : 'i') + ' [' + f.rule + '] ' + f.file + ': ' + f.message);
  return out.join('\n');
}

function main(argv, io) {
  const a = argv || [];
  const w = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--help') || a.includes('-h')) { w('usage: node forge-agentlint.cjs [--root <dir>] [--json] [--strict]'); return 0; }
  const root = arg('--root') ? path.resolve(arg('--root')) : defaultRoot();
  if (!fs.existsSync(root)) { w('forge-agentlint: root not found: ' + root); return 2; }
  const rep = lintAgents(root);
  w(a.includes('--json') ? JSON.stringify(rep, null, 2) : formatReport(rep));
  return a.includes('--strict') && rep.counts.error > 0 ? 1 : 0;
}

module.exports = { lintAgents, lintAgentFile, closestKey, formatReport, main, KNOWN_KEYS, DESCRIPTION_TOKEN_WARN };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-agentlint: internal error: ' + ((e && e.stack) || e) + '\n'); process.exitCode = 2; }
}
