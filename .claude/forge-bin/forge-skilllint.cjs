#!/usr/bin/env node
'use strict';
/**
 * forge-skilllint.cjs — (modernization 2026-10-24): a read-only linter for SKILL.md files.
 *
 * Rules, each checked against the official docs on 2026-10-24 (not against the research report):
 *   - Anthropic skill best practices (platform.claude.com .../agent-skills/best-practices): name <= 64 chars,
 *     lowercase letters/digits/hyphens, no XML tags, no reserved words "anthropic"/"claude"; description non-empty,
 *     <= 1,024 chars, no XML tags, third person, says what it does AND when to use it; body under 500 lines;
 *     references one level deep from SKILL.md; forward slashes in paths.
 *   - Claude Code skills doc (code.claude.com/docs/en/skills): `name` defaults to the folder name; the folder
 *     names `synced` and `anthropic-skills` do not load (the only names Claude Code itself refuses); the listing
 *     cuts description + when_to_use at 1,536 chars; the whole listing has a character budget that scales at 1% of
 *     the context window (skillListingBudgetFraction / SLASH_COMMAND_TOOL_CHAR_BUDGET change it);
 *     disable-model-invocation: true keeps a skill out of the listing.
 * The 64-char / lowercase / reserved-word rules are the API's upload rules; Claude Code still loads such a skill, so
 * the reserved-word finding is a warning, and only `synced` / `anthropic-skills` are errors.
 * Heuristic rules (third person, a "use when" trigger phrase) are warnings and say they are heuristics.
 *
 * Levels: error (the skill breaks a hard rule) · warn (likely weaker discovery) · info (budget facts).
 * CLI: node forge-skilllint.cjs [--root <dir>] [--json] [--strict] [--context-window <tokens>] [--with-global [--home <dir>]]
 *   default = report mode: prints findings, exit 0. --strict: exit 1 when any error-level finding exists.
 *   --with-global (WP A10): ALSO counts the global skill listing (<home>/.claude/skills/<id>/SKILL.md) and
 *   the installed plugin skills (<home>/.claude/plugins/installed_plugins.json -> <installPath>/skills), read-only, and
 *   reports project / global / plugin / total chars with the percentage of the budget for each. The global and plugin
 *   skills are never edited. Not checked: enabled/disabled state of a plugin and global skillOverrides (they live in
 *   settings files this tool does not read), so the total is an upper bound.
 *   Without the flag the output is unchanged except one extra info line with the project total and its percentage.
 * Zero dependencies, read-only: it never writes a file. Root: --root, else FORGE_PROJECT_ROOT, else forge-paths
 * scriptRoot(__dirname), else two folders up from this file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const LISTING_ENTRY_MAX = 1536;
const BODY_MAX_LINES = 500;
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_BUDGET_FRACTION = 0.01;
const CHARS_PER_TOKEN = 4;
const RESERVED_WORDS = ['anthropic', 'claude'];
const REFUSED_NAMES = ['synced', 'anthropic-skills'];
const XML_TAG = /<\/?[A-Za-z][A-Za-z0-9_-]*(\s[^<>]*)?\/?>/;
// Heuristics: first-person / second-person-subject phrasing (EN + NL) and a trigger phrase (EN + NL).
const FIRST_PERSON = /(^|[^A-Za-z'])(I|I'm|I'll|I've|I'd)(?![A-Za-z'])|\b(my|me)\b|(^|\s)(ik|mijn)\b/;
const SECOND_PERSON = /^\s*(you|your|je|jij|u)\b|\b(you can|you should|you will|you'll|je kunt|jij kunt|u kunt)\b/i;
const TRIGGER = /\b(use (it |this |this skill )?(first|at|when|whenever|for|on|after|before|to|if|in|during|as)|use proactively|only (on|when|for|after)|when (the )?(user|owner|you|a |an |any|asked|working|building|reviewing)|whenever|trigger(s|ed)? (on|when|by)|invoke (when|for)|for any)\b|\b(gebruik (bij|wanneer|als|voor|om|na)|wanneer|als de (gebruiker|owner)|bij elke?)\b/i;

const forgePaths = (() => { try { return require('./forge-paths.cjs'); } catch { return null; } })();

function defaultRoot() {
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  try { const r = forgePaths && forgePaths.scriptRoot(__dirname); if (r) return r; } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..');
}

function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return { value: v.slice(1, -1).replace(/\\(["\\/nt])/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)), quoted: true };
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return { value: v.slice(1, -1).replace(/''/g, "'"), quoted: true };
  return { value: v.replace(/\s+#.*$/, ''), quoted: false };
}

/** parseFrontmatter(text) -> {ok, bom, openingLine, reason, keys:[{key,line}], data, duplicates, badLines, bodyStart, lines}
 *  A small top-level-only YAML reader: scalars (plain, quoted, folded/literal block), lists (block or flow) and nested
 *  maps (value kind 'map'). `ok:false` with a reason when there is no `---` on line 1 or no closing `---`. Lines are
 *  1-based. Values keep their kind: {kind:'scalar'|'list'|'map', value, quoted}. */
function parseFrontmatter(text) {
  let src = String(text == null ? '' : text);
  const bom = src.charCodeAt(0) === 0xfeff;
  if (bom) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  if (lines[0] !== '---') {
    const at = lines.slice(0, 10).findIndex((l) => l.trim() === '---');
    return { ok: false, bom, lines, openingLine: at >= 0 ? at + 1 : null, reason: at >= 0 ? 'opening --- is on line ' + (at + 1) + ', not line 1' : 'no frontmatter: line 1 is not ---' };
  }
  const close = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
  if (close < 0) return { ok: false, bom, lines, openingLine: 1, reason: 'frontmatter is never closed (no second ---)' };
  const keys = [], data = {}, duplicates = [], badLines = [];
  let i = 1;
  while (i < close) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const m = /^([^\s#'"\-][^:]*?|"[^"]+"|'[^']+'):(?:[ \t]+(.*))?$/.exec(line);
    if (!m || /^\s/.test(line)) { badLines.push(i + 1); i++; continue; }
    const key = m[1].replace(/^["']|["']$/g, '');
    const raw = (m[2] || '').trim();
    const cont = [];
    let j = i + 1;
    while (j < close && (/^\s/.test(lines[j]) || lines[j].trim() === '' || /^- /.test(lines[j]))) { cont.push(lines[j]); j++; }
    while (cont.length && !cont[cont.length - 1].trim()) cont.pop();
    let val;
    if (/^[>|][+-]?$/.test(raw)) {
      const parts = cont.map((l) => l.trim());
      val = { kind: 'scalar', value: raw[0] === '>' ? parts.filter(Boolean).join(' ') : parts.join('\n'), quoted: false, block: true };
    } else if (raw === '' && cont.some((l) => /^\s*- /.test(l))) {
      val = { kind: 'list', value: cont.filter((l) => /^\s*- /.test(l)).map((l) => unquote(l.replace(/^\s*- /, '').trim()).value) };
    } else if (raw === '' && cont.length) {
      val = { kind: 'map', value: cont.join('\n') };
    } else if (/^\[.*\]$/.test(raw)) {
      val = { kind: 'list', value: raw.slice(1, -1).split(',').map((s) => unquote(s.trim()).value).filter(Boolean) };
    } else {
      const u = unquote(raw);
      const extra = cont.map((l) => l.trim()).filter(Boolean);
      val = { kind: 'scalar', value: u.quoted || !extra.length ? u.value : [u.value].concat(extra).join(' '), quoted: u.quoted };
    }
    if (Object.prototype.hasOwnProperty.call(data, key)) duplicates.push(key);
    data[key] = val;
    keys.push({ key, line: i + 1 });
    i = j;
  }
  return { ok: true, bom, lines, openingLine: 1, keys, data, duplicates, badLines, bodyStart: close + 2 };
}

const scalar = (fm, k) => (fm && fm.data && fm.data[k] && fm.data[k].kind === 'scalar' ? String(fm.data[k].value) : '');
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/** discoverSkills(skillsDir) -> [{abs, id, nested}] — <skills>/<id>/SKILL.md (top level) and <skills>/<a>/<b>/SKILL.md. */
function discoverSkills(skillsDir) {
  const out = [];
  const isDir = (d, e) => { if (e.isDirectory()) return true; if (!e.isSymbolicLink()) return false; try { return fs.statSync(path.join(d, e.name)).isDirectory(); } catch { return false; } };
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => isDir(d, e)).map((e) => e.name).sort(); } catch { return []; } };
  for (const a of dirs(skillsDir)) {
    const top = path.join(skillsDir, a, 'SKILL.md');
    if (fs.existsSync(top)) out.push({ abs: top, id: a, nested: false });
    for (const b of dirs(path.join(skillsDir, a))) {
      const sub = path.join(skillsDir, a, b, 'SKILL.md');
      if (fs.existsSync(sub)) out.push({ abs: sub, id: a + '/' + b, nested: true });
    }
  }
  return out;
}

/** localRefs(text) -> [{target, line, backslash}] — markdown link targets and inline-code tokens that look like a
 *  relative file path (no URL, no anchor-only link, no drive-letter or rooted path). */
function localRefs(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let fence = false;
  lines.forEach((l, idx) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const add = (t, link) => {
      const target = t.replace(/[#?].*$/, '').trim();
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || /^[\\/~]/.test(target) || /^[A-Za-z]:/.test(target) || /[\s<>*{}$]/.test(target)) return;
      out.push({ target, line: idx + 1, backslash: target.includes('\\'), link });
    };
    for (const m of l.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(m[1], true);
    for (const m of l.matchAll(/`([^`\s]+\.(?:md|txt|py|js|cjs|mjs|ts|sh|ps1|json|ya?ml))`/g)) add(m[1], false);
  });
  return out;
}

/** A backslash path is a finding when it is a markdown link target (always a reference) or when its forward-slash
 *  form names a file inside the skill folder; a backslash in a Windows command example elsewhere is not a reference. */
function backslashRef(r, baseDir, skillDir) {
  if (!r.backslash) return false;
  if (r.link) return true;
  const abs = path.resolve(baseDir, r.target.replace(/\\/g, '/'));
  return abs.startsWith(skillDir + path.sep) && fs.existsSync(abs);
}

function lintReferences(root, skillDir, text, file, push) {
  const refs = localRefs(text);
  const direct = new Set();
  const self = path.join(skillDir, 'SKILL.md');
  const slash = (f, r) => push('error', 'reference_backslash', f, 'line ' + r.line + ': path "' + r.target + '" uses a backslash; use forward slashes only');
  for (const r of refs) {
    if (backslashRef(r, skillDir, skillDir)) { slash(file, r); continue; }
    if (r.backslash) continue;
    const abs = path.resolve(skillDir, r.target);
    if (abs.startsWith(skillDir + path.sep) && abs !== self && fs.existsSync(abs)) direct.add(abs);
  }
  for (const abs of direct) {
    if (!/\.md$/i.test(abs)) continue;
    let sub;
    try { sub = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const r of localRefs(sub)) {
      if (backslashRef(r, path.dirname(abs), skillDir)) { slash(rel(root, abs), r); continue; }
      if (r.backslash) continue;
      const deep = path.resolve(path.dirname(abs), r.target);
      if (!/\.md$/i.test(deep) || deep === abs || deep === self || direct.has(deep) || !deep.startsWith(skillDir + path.sep) || !fs.existsSync(deep)) continue;
      push('warn', 'reference_nested', file, 'nested reference SKILL.md -> ' + rel(skillDir, abs) + ' -> ' + rel(skillDir, deep) + ' (line ' + r.line + '); link it from SKILL.md directly so it is read whole');
    }
  }
}

function lintDescription(desc, file, push, manualOnly) {
  if (!desc.trim()) { push('error', 'description_missing', file, 'description is missing or empty (the listing falls back to the first body line)'); return; }
  if (desc.length > DESCRIPTION_MAX) push('error', 'description_too_long', file, 'description is ' + desc.length + ' chars (max ' + DESCRIPTION_MAX + ')');
  if (XML_TAG.test(desc)) push('error', 'description_xml', file, 'description contains an XML tag');
  if (FIRST_PERSON.test(desc) || SECOND_PERSON.test(desc)) push('warn', 'description_person', file, 'description may not be in the third person (heuristic): write "Reviews diffs..." rather than "I can..." / "You can..."');
  if (!manualOnly && !TRIGGER.test(desc)) push('warn', 'description_trigger', file, 'description has no "use when" / trigger phrase (heuristic, EN + NL): say when the skill applies');
}

function lintName(name, file, push) {
  if (REFUSED_NAMES.includes(name.toLowerCase()) || /^anthropic-skills:/i.test(name)) { push('error', 'name_refused', file, 'name "' + name + '" is reserved by Claude Code: the skill does not load'); return; }
  if (name.length > NAME_MAX) push('error', 'name_too_long', file, 'name is ' + name.length + ' chars (max ' + NAME_MAX + ')');
  if (!/^[a-z0-9-]+$/.test(name)) push('error', 'name_format', file, 'name "' + name.slice(0, 80) + '" must use lowercase letters, digits and hyphens only');
  if (XML_TAG.test(name)) push('error', 'name_xml', file, 'name contains an XML tag');
  const hit = RESERVED_WORDS.filter((w) => name.toLowerCase().includes(w));
  if (hit.length) push('warn', 'name_reserved_word', file, 'name contains the reserved word ' + hit.map((w) => '"' + w + '"').join(', ') + ' (an API upload rule; Claude Code still loads it)');
}

function readProjectSettings(root) {
  const out = { overrides: {}, fraction: null, maxDesc: null };
  for (const f of ['settings.json', 'settings.local.json']) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(root, '.claude', f), 'utf8')); } catch { continue; }
    if (j && j.skillOverrides && typeof j.skillOverrides === 'object') Object.assign(out.overrides, j.skillOverrides);
    if (j && typeof j.skillListingBudgetFraction === 'number' && j.skillListingBudgetFraction > 0) out.fraction = j.skillListingBudgetFraction;
    if (j && Number.isInteger(j.skillListingMaxDescChars) && j.skillListingMaxDescChars > 0) out.maxDesc = j.skillListingMaxDescChars;
  }
  return out;
}

/** listedEntries(skillsDir, entryMax, prefix) -> {entries, total_chars, nested_not_counted, not_listed_disable_model_invocation,
 *  unreadable}. Counts the listing size of one skills folder the same way the project part is counted (name + description
 *  + when_to_use cut at entryMax); `prefix` is the plugin name for a plugin skill (listed as plugin:skill). Read-only. */
function listedEntries(skillsDir, entryMax, prefix) {
  const out = { dir: skillsDir, entries: 0, total_chars: 0, nested_not_counted: 0, not_listed_disable_model_invocation: 0, unreadable: 0 };
  for (const s of discoverSkills(skillsDir)) {
    if (s.nested) { out.nested_not_counted++; continue; }
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(s.abs, 'utf8')); } catch { out.unreadable++; continue; }
    if (!fm.ok) { out.unreadable++; continue; }
    const name = scalar(fm, 'name') || s.id;
    if (REFUSED_NAMES.includes(name.toLowerCase())) continue;
    if (scalar(fm, 'disable-model-invocation') === 'true' && !fm.data['disable-model-invocation'].quoted) { out.not_listed_disable_model_invocation++; continue; }
    const desc = scalar(fm, 'description');
    const wtu = scalar(fm, 'when_to_use');
    out.entries++;
    out.total_chars += (prefix ? prefix.length + 1 : 0) + name.length + (desc + (wtu ? ' ' + wtu : '')).slice(0, entryMax).length;
  }
  return out;
}

/** pluginSkillDirs(home) -> [{plugin, dir}] — the skills folders of the installed plugins, from installed_plugins.json. */
function pluginSkillDirs(home) {
  const found = [];
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')); } catch { return found; }
  const seen = new Set();
  for (const [key, arr] of Object.entries((j && j.plugins) || {})) {
    for (const e of [].concat(arr)) {
      const p = e && typeof e.installPath === 'string' ? e.installPath : null;
      if (!p) continue;
      const dir = path.join(p, 'skills');
      if (seen.has(dir) || !fs.existsSync(dir)) continue;
      seen.add(dir);
      found.push({ plugin: String(key).split('@')[0], dir });
    }
  }
  return found;
}

const pctOf = (n, budget) => (budget > 0 ? Math.round((n / budget) * 1000) / 10 : 0);

/** lintSkills(root, opts) -> report. opts: {skillsDir, contextWindow, env, withGlobal, home}. Read-only. */
function lintSkills(root, opts) {
  const o = opts || {};
  const r = path.resolve(root);
  const skillsDir = path.resolve(o.skillsDir || path.join(r, '.claude', 'skills'));
  const env = o.env || process.env;
  const findings = [];
  const settings = readProjectSettings(r);
  const entryMax = settings.maxDesc || LISTING_ENTRY_MAX;
  const listing = { entries: 0, total_chars: 0, description_chars: 0, empty_in_listing: [], name_only_or_off: [], not_listed_disable_model_invocation: [], nested_not_counted: 0 };
  const skills = discoverSkills(skillsDir);
  for (const s of skills) {
    const file = rel(r, s.abs);
    const push = (level, rule, f, message) => findings.push({ level, rule, skill: s.id, file: f, message });
    let text;
    try { text = fs.readFileSync(s.abs, 'utf8'); } catch (e) { push('error', 'unreadable', file, 'SKILL.md is unreadable (' + (e.code || e.message) + ')'); continue; }
    const fm = parseFrontmatter(text);
    if (!fm.ok) { push('error', 'frontmatter', file, fm.reason); continue; }
    if (fm.bom) push('warn', 'frontmatter_bom', file, 'file starts with a byte-order mark before ---');
    for (const d of fm.duplicates) push('error', 'frontmatter_duplicate', file, 'key "' + d + '" appears twice');
    for (const ln of fm.badLines) push('warn', 'frontmatter_line', file, 'line ' + ln + ' is not a "key: value" line');
    const name = scalar(fm, 'name') || path.basename(path.dirname(s.abs));
    lintName(name, file, push);
    const desc = scalar(fm, 'description');
    const manualOnly = scalar(fm, 'disable-model-invocation') === 'true' && !fm.data['disable-model-invocation'].quoted;
    lintDescription(desc, file, push, manualOnly);
    const wtu = scalar(fm, 'when_to_use');
    if (desc.length + wtu.length > LISTING_ENTRY_MAX) push('warn', 'listing_cut', file, 'description + when_to_use is ' + (desc.length + wtu.length) + ' chars; the listing cuts it at ' + LISTING_ENTRY_MAX);
    const bodyLines = fm.lines.length - fm.bodyStart + 1;
    if (bodyLines >= BODY_MAX_LINES) push('warn', 'body_long', file, 'body is ' + bodyLines + ' lines (keep it under ' + BODY_MAX_LINES + '; move detail into reference files)');
    lintReferences(r, path.dirname(s.abs), fm.lines.slice(fm.bodyStart - 1).join('\n'), file, push);
    if (s.nested) { listing.nested_not_counted++; continue; }
    if (REFUSED_NAMES.includes(name.toLowerCase())) continue; // Claude Code does not load it, so it is not listed
    if (manualOnly) { listing.not_listed_disable_model_invocation.push(s.id); continue; }
    const ov = settings.overrides[name] || settings.overrides[s.id];
    if (ov === 'off') { listing.name_only_or_off.push(s.id + ' (off)'); continue; }
    listing.entries++;
    if (ov === 'name-only') { listing.name_only_or_off.push(s.id + ' (name-only)'); listing.total_chars += name.length; continue; }
    const text2 = (desc + (wtu ? ' ' + wtu : '')).slice(0, entryMax);
    if (!desc.trim()) listing.empty_in_listing.push(s.id);
    listing.description_chars += text2.length;
    listing.total_chars += name.length + text2.length;
  }
  const fixed = Number(env.SLASH_COMMAND_TOOL_CHAR_BUDGET);
  const contextWindow = Number(o.contextWindow) > 0 ? Number(o.contextWindow) : DEFAULT_CONTEXT_WINDOW;
  const fraction = settings.fraction || DEFAULT_BUDGET_FRACTION;
  listing.budget_chars = fixed > 0 ? fixed : Math.round(contextWindow * fraction * CHARS_PER_TOKEN);
  listing.budget_basis = fixed > 0 ? 'SLASH_COMMAND_TOOL_CHAR_BUDGET' : 'estimate: ' + (fraction * 100) + '% of a ' + contextWindow + '-token window x ' + CHARS_PER_TOKEN + ' chars/token (Claude Code skills doc: the budget scales at 1% of the context window)';
  listing.scope = o.withGlobal ? 'project .claude/skills + global ~/.claude/skills + installed plugin skills (read-only)' : 'project .claude/skills only; global and plugin skills share the same budget and are not counted here (run with --with-global)';
  listing.over = listing.total_chars > listing.budget_chars;
  listing.project_pct = pctOf(listing.total_chars, listing.budget_chars);
  findings.push({ level: listing.over ? 'warn' : 'info', rule: 'listing_budget', skill: null, file: rel(r, skillsDir), message: listing.entries + ' listed skill(s) use ' + listing.total_chars + ' chars of the ~' + listing.budget_chars + '-char listing budget (' + listing.budget_basis + ')' + (listing.over ? ': over budget, Claude Code drops the least-used descriptions' : '') });
  if (o.withGlobal) {
    const home = o.home || os.homedir();
    const g = listedEntries(path.join(home, '.claude', 'skills'), entryMax, '');
    const pl = { entries: 0, total_chars: 0, plugins: 0, nested_not_counted: 0, not_listed_disable_model_invocation: 0, unreadable: 0 };
    for (const p of pluginSkillDirs(home)) {
      const x = listedEntries(p.dir, entryMax, p.plugin);
      pl.plugins++;
      for (const k of ['entries', 'total_chars', 'nested_not_counted', 'not_listed_disable_model_invocation', 'unreadable']) pl[k] += x[k];
    }
    listing.global = Object.assign(g, { pct: pctOf(g.total_chars, listing.budget_chars) });
    listing.plugin = Object.assign(pl, { pct: pctOf(pl.total_chars, listing.budget_chars) });
    listing.total_all_chars = listing.total_chars + g.total_chars + pl.total_chars;
    listing.total_all_pct = pctOf(listing.total_all_chars, listing.budget_chars);
    listing.total_all_over = listing.total_all_chars > listing.budget_chars;
    findings.push({ level: listing.total_all_over ? 'warn' : 'info', rule: 'listing_total', skill: null, file: rel(r, skillsDir), message: 'listing total: project ' + listing.total_chars + ' chars (' + listing.project_pct + '%, ' + listing.entries + ' skills) + global ' + g.total_chars + ' (' + listing.global.pct + '%, ' + g.entries + ' skills) + plugin ' + pl.total_chars + ' (' + listing.plugin.pct + '%, ' + pl.entries + ' skills in ' + pl.plugins + ' plugin(s)) = ' + listing.total_all_chars + ' chars = ' + listing.total_all_pct + '% of the ~' + listing.budget_chars + '-char budget (upper bound: plugin enabled state and global skillOverrides are not checked)' + (listing.total_all_over ? ' (over)' : '') });
  } else {
    findings.push({ level: 'info', rule: 'listing_total', skill: null, file: rel(r, skillsDir), message: 'listing total (project only): ' + listing.total_chars + ' chars = ' + listing.project_pct + '% of the ~' + listing.budget_chars + '-char budget; global and plugin skills not counted (run with --with-global)' });
  }
  if (listing.empty_in_listing.length) findings.push({ level: 'warn', rule: 'listing_empty', skill: null, file: rel(r, skillsDir), message: 'listed with an empty description: ' + listing.empty_in_listing.join(', ') });
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  return { tool: 'forge-skilllint', root: r, skills: skills.length, counts, findings, listing };
}

function formatReport(rep) {
  const out = ['forge-skilllint: ' + rep.skills + ' skill(s) · ' + rep.counts.error + ' error · ' + rep.counts.warn + ' warn · ' + rep.counts.info + ' info'];
  for (const f of rep.findings) out.push('  ' + (f.level === 'error' ? 'x' : f.level === 'warn' ? '!' : 'i') + ' [' + f.rule + '] ' + f.file + ': ' + f.message);
  return out.join('\n');
}

function main(argv, io) {
  const a = argv || [];
  const w = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--help') || a.includes('-h')) { w('usage: node forge-skilllint.cjs [--root <dir>] [--json] [--strict] [--context-window <tokens>] [--with-global [--home <dir>]]'); return 0; }
  const root = val('--root') ? path.resolve(val('--root')) : defaultRoot();
  if (!fs.existsSync(root)) { w('forge-skilllint: root not found: ' + root); return 2; }
  const rep = lintSkills(root, { contextWindow: val('--context-window'), withGlobal: a.includes('--with-global'), home: val('--home') ? path.resolve(val('--home')) : undefined });
  w(a.includes('--json') ? JSON.stringify(rep, null, 2) : formatReport(rep));
  return a.includes('--strict') && rep.counts.error > 0 ? 1 : 0;
}

module.exports = { lintSkills, listedEntries, pluginSkillDirs, parseFrontmatter, localRefs, discoverSkills, formatReport, main, NAME_MAX, DESCRIPTION_MAX, BODY_MAX_LINES, LISTING_ENTRY_MAX };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-skilllint: internal error: ' + ((e && e.stack) || e) + '\n'); process.exitCode = 2; }
}
