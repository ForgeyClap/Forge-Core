#!/usr/bin/env node
'use strict';
/**
 * forge-config-scan.cjs — (modernization 2026-10-24): a read-only scan of a project's Claude/Forge
 * configuration for five classes of risk. Written from the idea list in
 * .claude/forge-research/open-source-skills-2026-10-24.md (no external code copied).
 *
 * WHAT IT READS (only these, never anything else):
 *   .claude/settings.json, .claude/settings.local.json  permissions, defaultMode, hook commands, mcpServers
 *   the script files those hook commands run (only paths inside the project), and .claude/hooks/** if present
 *   .claude/agents/**.md and .claude/skills/**.md            prompt-injection-shaped text, hidden Unicode
 *   .mcp.json and .claude/config/orchestration/mcp-registry.json   unpinned MCP launch references
 *   any extra file given with --file (secrets + hidden Unicode only)
 * RULES (level · id)
 *   error  secret-<kind>                  a secret-shaped string; printed as file:line + rule + at most 4 chars
 *   error  perm-allow-all                 an allow rule that grants every shell command (Bash(*), Bash, "*", ...)
 *   warn   perm-allow-broad               an allow rule that grants every write/edit/fetch
 *   error  perm-bypass-mode               permissions.defaultMode = bypassPermissions
 *   warn   perm-deny-missing-secret-reads the deny list has no Read rule for a secret-file group (.env, keys, ssh)
 *   error  hook-fetch-exec                a hook pipes or feeds downloaded content into a shell / interpreter
 *   error  hook-decode-exec               a hook decodes base64 and runs the result
 *   error  hook-encoded-command           a hook runs powershell -EncodedCommand
 *   error  hook-eval-var                  a hook evals a variable or command output (eval $x, iex $x)
 *   warn   hook-js-eval                   a JS hook script calls eval() on a non-literal or new Function()
 *   warn   injection-text                 agent/skill text aimed at the model to drop its rules (HEURISTIC)
 *   error  hidden-unicode-bidi / hidden-unicode-tag, warn hidden-unicode-zero-width   code point + file:line:col
 *   error  mcp-unpinned (an active host server or an enabled registry entry is HIGH/UNVERIFIED),
 *   warn   mcp-range (MEDIUM: a version range), warn mcp-review (REVIEW: a local path, unknown binary, script or shell
 *          wrapper — no pin can be proven, a person must look), info mcp-dormant-unpinned (enabled:false entry, not pinned)
 *   info   mcp-pin-unavailable            forge-mcp-pin.cjs could not be loaded: the MCP rules did not run
 * CLI: node forge-config-scan.cjs [--root <dir>] [--file <path>]... [--json] [--strict] [--out <file>]
 *   exit 0 = report written (report mode) · 1 = --strict and at least one error-level finding · 2 = usage/root error
 * Zero dependencies, read-only: the only write is an explicit --out file whose folder already exists.
 */
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MD_FILES = 4000;
const forgePaths = (() => { try { return require('./forge-paths.cjs'); } catch { return null; } })();
const mcpPin = (() => { try { return require('./forge-mcp-pin.cjs'); } catch { return null; } })();

// ---- secret shapes (prefixes split so this source file is not itself a hit for other scanners) -------------
const P = (s) => s.split('|').join('');
const SECRET_RULES = [
  { id: 'secret-aws-key', re: new RegExp('(?<![A-Z0-9])' + P('AK|IA') + '[0-9A-Z]{16}(?![A-Z0-9])') },
  { id: 'secret-github-token', re: new RegExp('(?<![A-Za-z0-9])(?:' + P('gh|[pousr]_') + '[A-Za-z0-9]{30,}|' + P('github|_pat_') + '[A-Za-z0-9_]{40,})') },
  { id: 'secret-anthropic-key', re: new RegExp('(?<![A-Za-z0-9])' + P('sk-|ant-') + '[A-Za-z0-9_-]{20,}') },
  { id: 'secret-openai-key', re: new RegExp('(?<![A-Za-z0-9-])' + P('s|k-') + '(?:proj-)?[A-Za-z0-9]{32,}') },
  { id: 'secret-slack-token', re: new RegExp(P('xo|x[abprs]-') + '[A-Za-z0-9-]{10,}') },
  { id: 'secret-google-key', re: new RegExp(P('AI|za') + '[0-9A-Za-z_-]{35}') },
  { id: 'secret-stripe-key', re: new RegExp('(?:' + P('sk|_live_') + '|' + P('rk|_live_') + ')[A-Za-z0-9]{16,}') },
  { id: 'secret-nvidia-key', re: new RegExp(P('nva|pi-') + '[A-Za-z0-9_-]{30,}') },
  { id: 'secret-private-key', re: new RegExp(P('-----BEGIN |') + '(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?' + P('PRIVATE| KEY-----')) },
];
const ASSIGN_RE = /["']?\b([A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|access[_-]?key|auth)[A-Za-z0-9_]*)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i;
const PLACEHOLDER_RE = /x{4,}|\*{3,}|<[^>]*>|\$\{|\$[A-Z_]|\{\{|your[_-]|example|placeholder|changeme|redacted|dummy|sample|fake|replace[_-]?me|^test|\.\.\./i;

function entropy(s) {
  const c = {};
  for (const ch of s) c[ch] = (c[ch] || 0) + 1;
  let e = 0;
  for (const k of Object.keys(c)) { const p = c[k] / s.length; e -= p * Math.log2(p); }
  return e;
}
const mask = (s) => String(s).slice(0, 4) + '\u2026(' + String(s).length + ' chars)';

// ---- hook / script shapes ------------------------------------------------------------------------------------
const FETCH = '(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)';
const RUNNER = '(?:sh|bash|zsh|dash|ksh|python3?|node|perl|ruby|iex|Invoke-Expression|pwsh|powershell)';
const SHELL_RULES = [
  { id: 'hook-fetch-exec', re: new RegExp('\\b' + FETCH + '\\b[^|\\n]*\\|\\s*(?:sudo\\s+)?' + RUNNER + '\\b', 'i') },
  { id: 'hook-fetch-exec', re: new RegExp('\\b(?:sh|bash|zsh)\\s+(?:-c\\s+["\']?\\$\\(|<\\(\\s*)' + FETCH + '\\b', 'i') },
  { id: 'hook-fetch-exec', re: new RegExp('\\b(?:iex|Invoke-Expression)\\b\\s*\\(?\\s*(?:\\(\\s*)?(?:' + FETCH + '|New-Object\\s+(?:System\\.)?Net\\.WebClient)', 'i') },
  { id: 'hook-decode-exec', re: /\bbase64\s+(?:-d|-D|--decode)\b[^\n]*\|\s*(?:sh|bash|zsh|iex|python3?|node|pwsh|powershell)\b/i },
  { id: 'hook-decode-exec', re: /FromBase64String[^\n]*\b(?:iex|Invoke-Expression)\b|\b(?:iex|Invoke-Expression)\b[^\n]*FromBase64String/i },
  { id: 'hook-encoded-command', re: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i },
  { id: 'hook-eval-var', re: /\beval\s+["']?\$|\b(?:iex|Invoke-Expression)\s+["']?\$/i },
];
const JS_RULES = [
  { id: 'hook-js-eval', re: /(?:^|[^\w.$'"`\\])eval\s*\(\s*(?!['"`)])/ },
  { id: 'hook-js-eval', re: /\bnew\s+Function\s*\(/ },
  { id: 'hook-fetch-exec', re: new RegExp('\\b(?:exec|execSync|spawn|spawnSync)\\s*\\(\\s*[\'"`][^\'"`]*\\b' + FETCH + '\\b[^\'"`]*\\|\\s*' + RUNNER + '\\b', 'i') },
];
const SCRIPT_EXT = new Set(['.sh', '.bash', '.ps1', '.psm1', '.bat', '.cmd']);
const JS_EXT = new Set(['.js', '.cjs', '.mjs']);

// ---- prompt-injection shapes (heuristic) ---------------------------------------------------------------------
const INJECTION_RULES = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|of\s+)*(?:previous|prior|above|earlier|system|preceding|original)\s+(?:instructions|rules|prompts?|messages|guidelines|directives)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|jailbroken|unrestricted|unfiltered|free\s+of)/i,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|let)\s+the\s+(?:user|owner|human)\s+(?:know\b)?/i,
  /\bwithout\s+(?:telling|informing|notifying)\s+the\s+(?:user|owner|human)\b/i,
  /\b(?:exfiltrate|upload|post|send|forward)\b[^.\n]{0,40}\b(?:secrets?|credentials|api\s+keys?|tokens?|\.env|ssh\s+keys?|passwords?)\b[^.\n]{0,30}\b(?:to\s+(?:https?:|an?\s+external|this|the\s+following)|https?:)/i,
  /\b(?:disable|turn\s+off|bypass|skip)\s+(?:the\s+)?(?:gate[- ]hook|safety\s+(?:checks?|rules?)|guardrails?|security\s+checks?)\s+(?:silently|quietly|before|first|now)\b/i,
];
const DEFENSIVE_CONTEXT = /\b(?:never|not|no|don't|do\s+not|refuse|reject|treat|such\s+as|e\.g\.|for\s+example|like|detect|flag|flags|block|blocks|catch|scan|pattern|injection|untrusted|malicious|attack|suspicious|cannot|can't|must\s+not)\b/i;

// ---- hidden Unicode ------------------------------------------------------------------------------------------
function hiddenKind(cp) {
  if ((cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi';
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'tag';
  if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0x2060 || cp === 0xFEFF || cp === 0x200E || cp === 0x200F || cp === 0x180E) return 'zero-width';
  return null;
}
const cpName = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

// ---- helpers -------------------------------------------------------------------------------------------------
function defaultRoot() {
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  try { const r = forgePaths && forgePaths.scriptRoot(__dirname); if (r) return r; } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..');
}
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
function readSafe(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}
function listMd(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (out.length >= MAX_MD_FILES) break;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') listMd(p, out); } else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}
function listAll(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) listAll(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
function lineOf(text, needle) {
  if (!needle) return 1;
  for (const cand of [JSON.stringify(needle).slice(1, -1), needle]) {
    const i = text.indexOf(cand);
    if (i >= 0) return text.slice(0, i).split('\n').length;
  }
  return 1;
}

// ---- scanners (each pushes into ctx.findings) ----------------------------------------------------------------
function scanSecrets(ctx, file, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => {
    let hit = false;
    for (const r of SECRET_RULES) {
      const m = r.re.exec(ln);
      if (m) { hit = true; ctx.add('error', r.id, file, i + 1, 'a ' + r.id.slice(7).replace(/-/g, ' ') + '-shaped string', mask(m[0])); }
    }
    if (hit) return;
    const a = ASSIGN_RE.exec(ln);
    if (a && !PLACEHOLDER_RE.test(a[2]) && entropy(a[2]) >= 3.2 && /[0-9]/.test(a[2]) && /[A-Za-z]/.test(a[2])) {
      ctx.add('error', 'secret-assignment', file, i + 1, 'a high-entropy value assigned to "' + a[1] + '"', mask(a[2]));
    }
  });
}
function scanUnicode(ctx, file, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => {
    let col = 0;
    for (const ch of ln) {
      col++;
      const cp = ch.codePointAt(0);
      const k = hiddenKind(cp);
      if (!k || (cp === 0xFEFF && i === 0 && col === 1)) continue;
      ctx.add(k === 'zero-width' ? 'warn' : 'error', 'hidden-unicode-' + k, file, i + 1, 'hidden character ' + cpName(cp) + ' at column ' + col, null, col);
    }
  });
}
function scanInjection(ctx, file, text) {
  const lines = text.split(/\r?\n/);
  let fence = false;
  lines.forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; return; }
    for (const re of INJECTION_RULES) {
      const m = re.exec(ln);
      if (!m) continue;
      const before = ln.slice(Math.max(0, m.index - 80), m.index);
      const quoted = /["'`\u201C\u2018]\s*$/.test(before);
      if (fence || quoted || DEFENSIVE_CONTEXT.test(before)) continue;
      ctx.add('warn', 'injection-text', file, i + 1, 'HEURISTIC: text aimed at the model to drop its rules: "' + m[0].slice(0, 80) + '"');
      break;
    }
  });
}
function scanScript(ctx, file, text, kind) {
  const rules = kind === 'js' ? JS_RULES : SHELL_RULES;
  text.split(/\r?\n/).forEach((raw, i) => {
    const ln = kind === 'js' ? raw.replace(/^\s*(\/\/|\*|\/\*).*$/, '') : raw.replace(/^\s*#.*$/, '');
    const seen = new Set();
    for (const r of rules) {
      if (seen.has(r.id) || !r.re.test(ln)) continue;
      seen.add(r.id);
      ctx.add(r.id === 'hook-js-eval' ? 'warn' : 'error', r.id, file, i + 1, 'hook code ' + ({ 'hook-fetch-exec': 'runs downloaded content', 'hook-decode-exec': 'decodes base64 and runs it', 'hook-encoded-command': 'runs an encoded PowerShell command', 'hook-eval-var': 'evaluates a variable or command output', 'hook-js-eval': 'evaluates a non-literal string as code' }[r.id]));
    }
  });
}

const ALL_SHELL = /^(?:Bash|PowerShell|Shell)(?:\((?:\*|:\*|\*\*|)\))?$|^\*$/;
const BROAD = /^(?:Write|Edit|MultiEdit|WebFetch|NotebookEdit)(?:\((?:\*|\*\*|\/\*\*|\.\/\*\*|)\))?$/;
const DENY_GROUPS = [
  { id: '.env files', re: /\.env/ },
  { id: 'private keys (*.pem / *.key / id_rsa / id_ed25519)', re: /\.pem|\.key\b|id_rsa|id_ed25519/ },
  { id: 'ssh folder or credential files', re: /\.ssh|credentials/ },
];
function scanSettings(ctx, root, file, text, data, allDeny) {
  const perms = data && typeof data.permissions === 'object' && data.permissions ? data.permissions : {};
  for (const rule of Array.isArray(perms.allow) ? perms.allow : []) {
    if (typeof rule !== 'string') continue;
    const r = rule.trim();
    if (ALL_SHELL.test(r)) ctx.add('error', 'perm-allow-all', file, lineOf(text, rule), 'allow rule "' + r + '" grants every shell command without a prompt');
    else if (BROAD.test(r)) ctx.add('warn', 'perm-allow-broad', file, lineOf(text, rule), 'allow rule "' + r + '" grants every ' + r.replace(/\(.*$/, '') + ' without a prompt');
  }
  if (Array.isArray(perms.deny)) perms.deny.forEach((d) => { if (typeof d === 'string') allDeny.push(d); });
  if (perms.defaultMode === 'bypassPermissions') ctx.add('error', 'perm-bypass-mode', file, lineOf(text, 'bypassPermissions'), 'defaultMode bypassPermissions skips every permission prompt');
  const hooks = data && typeof data.hooks === 'object' && data.hooks ? data.hooks : {};
  for (const ev of Object.keys(hooks).sort()) {
    for (const g of Array.isArray(hooks[ev]) ? hooks[ev] : []) {
      for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || typeof h.command !== 'string') continue;
        const before = ctx.findings.length;
        scanScript(ctx, file, h.command, 'shell');
        ctx.findings.slice(before).forEach((f) => { f.line = lineOf(text, h.command); f.message += ' (' + ev + ' hook command)'; });
        for (const m of h.command.matchAll(/(?:\$\{?CLAUDE_PROJECT_DIR\}?|%CLAUDE_PROJECT_DIR%|\.)?[\\/]?(\.claude[\\/][\w.\\/-]+\.(?:cjs|js|mjs|sh|bash|ps1|py|cmd|bat))/g)) ctx.hookScripts.add(path.resolve(root, m[1]));
      }
    }
  }
  if (data && data.mcpServers) scanHostMcp(ctx, file, text, { mcpServers: data.mcpServers });
}
function scanHostMcp(ctx, file, text, cfg) {
  if (!mcpPin) { ctx.noteMcp(); return; }
  for (const s of mcpPin.scanHostConfig(cfg).servers) {
    const line = lineOf(text, '"' + s.id + '"');
    if (s.risk === 'HIGH' || s.risk === 'UNVERIFIED') ctx.add('error', 'mcp-unpinned', file, line, 'MCP server "' + s.id + '" is not pinned: ' + s.reason);
    else if (s.risk === 'REVIEW') ctx.add('warn', 'mcp-review', file, line, 'MCP server "' + s.id + '" needs a manual review (no pin can be proven): ' + s.reason);
    else if (s.risk === 'MEDIUM') ctx.add('warn', 'mcp-range', file, line, 'MCP server "' + s.id + '" uses a version range: ' + s.reason);
  }
}
function scanRegistry(ctx, file, text, reg) {
  if (!mcpPin) { ctx.noteMcp(); return; }
  for (const s of reg && Array.isArray(reg.servers) ? reg.servers : []) {
    const c = mcpPin.classifyEntry(s);
    if (!c.blocking) continue;
    const line = lineOf(text, '"' + (s && s.id) + '"');
    if (s && s.enabled === false) ctx.add('info', 'mcp-dormant-unpinned', file, line, 'dormant registry entry "' + c.id + '" is ' + c.risk + ' (blocked from any grant until pinned)');
    else ctx.add('error', 'mcp-unpinned', file, line, 'registry entry "' + c.id + '" is not dormant and is ' + c.risk + ': ' + c.reason);
  }
}

// ---- main scan -----------------------------------------------------------------------------------------------
function scanConfig(rootIn, opts) {
  const o = opts || {};
  const root = path.resolve(rootIn);
  const findings = [];
  const notes = [];
  const scanned = new Set();
  const ctx = {
    findings, hookScripts: new Set(),
    add(level, rule, file, line, message, fragment, col) { findings.push({ level, rule, file, line, col: col || null, message, fragment: fragment || null }); },
    noteMcp() { if (!notes.some((n) => n.startsWith('mcp-pin-unavailable'))) { notes.push('mcp-pin-unavailable: forge-mcp-pin.cjs could not be loaded — the MCP pin rules did not run'); ctx.add('info', 'mcp-pin-unavailable', '.claude/forge-bin/forge-mcp-pin.cjs', 1, 'forge-mcp-pin.cjs could not be loaded: unpinned-MCP rules did not run'); } },
  };
  const take = (abs) => { const t = readSafe(abs); if (t != null) scanned.add(relOf(root, abs)); return t; };
  const allDeny = [];
  let settingsSeen = null;
  for (const name of ['settings.json', 'settings.local.json']) {
    const abs = path.join(root, '.claude', name);
    const text = take(abs);
    if (text == null) continue;
    const file = relOf(root, abs);
    scanSecrets(ctx, file, text);
    let data = null;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { ctx.add('warn', 'settings-unparseable', file, 1, 'not valid JSON: ' + e.message); }
    if (data) { scanSettings(ctx, root, file, text, data, allDeny); if (!settingsSeen) settingsSeen = file; }
  }
  if (settingsSeen) {
    const reads = allDeny.filter((d) => /^Read\(/.test(d.trim()));
    const missing = DENY_GROUPS.filter((g) => !reads.some((d) => g.re.test(d))).map((g) => g.id);
    if (missing.length) ctx.add('warn', 'perm-deny-missing-secret-reads', settingsSeen, 1, 'the deny list has no Read rule for: ' + missing.join('; '));
  }
  const hookDir = path.join(root, '.claude', 'hooks');
  for (const abs of listAll(hookDir, [])) ctx.hookScripts.add(abs);
  for (const abs of [...ctx.hookScripts].sort()) {
    if (relOf(root, abs).startsWith('..')) continue;
    const text = take(abs);
    if (text == null) continue;
    const ext = path.extname(abs).toLowerCase();
    const file = relOf(root, abs);
    scanSecrets(ctx, file, text);
    scanUnicode(ctx, file, text);
    if (JS_EXT.has(ext)) scanScript(ctx, file, text, 'js');
    else if (SCRIPT_EXT.has(ext)) scanScript(ctx, file, text, 'shell');
  }
  for (const sub of ['agents', 'skills']) {
    for (const abs of listMd(path.join(root, '.claude', sub), [])) {
      const text = take(abs);
      if (text == null) continue;
      const file = relOf(root, abs);
      scanSecrets(ctx, file, text);
      scanUnicode(ctx, file, text);
      scanInjection(ctx, file, text);
    }
  }
  const mcpJson = path.join(root, '.mcp.json');
  const mt = take(mcpJson);
  if (mt != null) {
    scanSecrets(ctx, '.mcp.json', mt);
    try { scanHostMcp(ctx, '.mcp.json', mt, JSON.parse(mt.replace(/^\uFEFF/, ''))); } catch (e) { ctx.add('warn', 'mcp-unparseable', '.mcp.json', 1, 'not valid JSON: ' + e.message); }
  }
  const regAbs = path.join(root, '.claude', 'config', 'orchestration', 'mcp-registry.json');
  const rt = take(regAbs);
  if (rt != null) {
    const file = relOf(root, regAbs);
    scanSecrets(ctx, file, rt);
    try { scanRegistry(ctx, file, rt, JSON.parse(rt.replace(/^\uFEFF/, ''))); } catch (e) { ctx.add('warn', 'mcp-unparseable', file, 1, 'not valid JSON: ' + e.message); }
  }
  for (const f of o.files || []) {
    const abs = path.resolve(root, f);
    const text = take(abs);
    if (text == null) { notes.push('could not read --file ' + f + ' (missing, a link, a folder or over ' + MAX_FILE_BYTES + ' bytes)'); continue; }
    const file = relOf(root, abs);
    scanSecrets(ctx, file, text);
    scanUnicode(ctx, file, text);
  }
  const seen = new Set();
  const out = findings.filter((f) => { const k = [f.level, f.rule, f.file, f.line, f.col, f.message].join('\u0000'); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.col || 0) - (b.col || 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of out) counts[f.level]++;
  return { tool: 'forge-config-scan', version: VERSION, heuristic_rules: ['injection-text', 'secret-assignment'], files_scanned: [...scanned].sort(), counts, findings: out, notes };
}

function formatReport(rep) {
  const lines = ['forge-config-scan v' + rep.version + ': ' + rep.files_scanned.length + ' files · ' + rep.counts.error + ' error · ' + rep.counts.warn + ' warn · ' + rep.counts.info + ' info'];
  for (const f of rep.findings) lines.push('  ' + f.level.toUpperCase().padEnd(5) + ' ' + f.rule + ' ' + f.file + ':' + f.line + (f.col ? ':' + f.col : '') + ' ' + f.message + (f.fragment ? ' [' + f.fragment + ']' : ''));
  for (const n of rep.notes) lines.push('  note: ' + n);
  return lines.join('\n');
}

function writeOut(outPath, text) {
  const abs = path.resolve(outPath);
  if (!fs.existsSync(path.dirname(abs)) || !fs.statSync(path.dirname(abs)).isDirectory()) throw new Error('--out folder does not exist: ' + path.dirname(abs));
  fs.writeFileSync(abs, text + '\n');
}

function main(argv, io) {
  const a = argv || [];
  const w = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const e = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const files = [];
  let root = null, out = null;
  const flags = new Set();
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--root' || x === '--file' || x === '--out') {
      const v = a[++i];
      if (!v || v.startsWith('--')) { e('forge-config-scan: ' + x + ' needs a value'); return 2; }
      if (x === '--root') root = v; else if (x === '--out') out = v; else files.push(v);
    } else if (x === '--json' || x === '--strict' || x === '--help' || x === '-h') flags.add(x);
    else { e('forge-config-scan: unknown argument ' + x); return 2; }
  }
  if (flags.has('--help') || flags.has('-h')) { w('usage: node forge-config-scan.cjs [--root <dir>] [--file <path>]... [--json] [--strict] [--out <file>]'); return 0; }
  const r = root ? path.resolve(root) : defaultRoot();
  if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) { e('forge-config-scan: root not found: ' + r); return 2; }
  const rep = scanConfig(r, { files });
  const text = flags.has('--json') ? JSON.stringify(rep, null, 2) : formatReport(rep);
  if (out) { try { writeOut(out, text); } catch (err) { e('forge-config-scan: ' + err.message); return 2; } } else w(text);
  return flags.has('--strict') && rep.counts.error > 0 ? 1 : 0;
}

module.exports = { scanConfig, formatReport, main, mask, entropy, hiddenKind, SECRET_RULES, SHELL_RULES, JS_RULES, INJECTION_RULES, VERSION };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { process.stderr.write('forge-config-scan: internal error: ' + ((err && err.stack) || err) + '\n'); process.exitCode = 2; }
}
