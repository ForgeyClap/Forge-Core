#!/usr/bin/env node
'use strict';
// forge-registry-gen.cjs -: read-only drift report + GENERATED proposals for the skill registry and the
// forge-bin tool table. Never overwrites FORGE_SKILL_REGISTRY.md or README.md (a human/Lead applies a proposal).
//   node forge-registry-gen.cjs report [--json] [--root <dir>]
//   node forge-registry-gen.cjs generate --target skill-registry|tool-table [--out <file>] [--root <dir>]
//   node forge-registry-gen.cjs agents [--check] [--write] [--json] [--root <dir>]   (WP 1.5: agents.generated.json
//        from the agent frontmatter; --check fails on drift; logic in forge-policy.cjs)
const fs = require('fs');
const path = require('path');

const LINE_LIMIT = 800;
const DEFAULT_OUT_REL = '.claude/forge-research/overhaul-2026-10-09/generated';
// WP 2.1: forge-paths.cjs is optional (a copied tool or an older install keeps the legacy behaviour). With it the
// default --out goes into the project's ACTIVE research folder (.forge/research once <root>/.forge/ exists) and a
// plugin copy finds the project from CLAUDE_PROJECT_DIR / the cwd, never the plugin's parent folder.
let forgePaths = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.stateDir === 'function' && typeof fp.scriptRoot === 'function') forgePaths = fp; } catch { forgePaths = null; }
function defaultRoot() {
  if (!forgePaths) return path.resolve(__dirname, '..', '..'); // forge-paths fallback
  try { return forgePaths.scriptRoot(__dirname); } catch { return null; }
}
function defaultOutDir(root) {
  const legacy = path.join(root, DEFAULT_OUT_REL);
  if (!forgePaths) return legacy;
  try { return path.join(forgePaths.stateDir(root, 'research'), ...DEFAULT_OUT_REL.split('/').slice(2)); } catch { return legacy; }
}
const SIZE_DIRS = ['.claude/forge-bin', '.claude/skills', '.claude/agents', '.claude/commands', '.claude/config'];

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

// ---- skills on disk (top-level + nested dirs containing SKILL.md) ----
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
function skillsOnDisk(root) {
  const base = path.join(root, '.claude', 'skills');
  const out = [];
  (function walk(dir, rel, depth) {
    for (const e of listDir(dir)) {
      if (!e.isDirectory()) continue;
      const d = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      const t = read(path.join(d, 'SKILL.md'));
      if (t !== null) {
        const fm = parseFrontmatter(t);
        out.push({ name: fm.name || e.name, dir: r, description: (fm.description || '').split(/\r?\n/)[0], path: '.claude/skills/' + r + '/SKILL.md' });
      } else if (depth < 2) walk(d, r, depth + 1);
    }
  })(base, '', 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- registry entries (markdown table rows) ----
function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}
function registryEntries(root) {
  const text = read(path.join(root, '.claude', 'FORGE_SKILL_REGISTRY.md'));
  if (text === null) return { present: false, header: [], rows: [] };
  let header = null; const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (header && /^##\s/.test(line)) break; // the skill table ends at the next section (e.g. the hand-kept global plugins table)
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (!header) { if (/^skill$/i.test(cells[0])) header = cells; continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells[0]) rows.push({ name: cells[0].replace(/`/g, ''), cells });
  }
  return { present: true, header: header || [], rows };
}

// ---- tools + README table ----
function toolsOnDisk(root) {
  const dir = path.join(root, '.claude', 'forge-bin');
  const all = listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.cjs')).map((e) => e.name);
  const set = new Set(all);
  return { tools: all.filter((n) => !/\.test\.cjs$/.test(n)).sort(), set };
}
function readmeTools(root) {
  const text = read(path.join(root, '.claude', 'forge-bin', 'README.md'));
  if (text === null) return { present: false, names: new Set(), rows: [] };
  const names = new Set(); const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const first = splitRow(line)[0] || '';
    const found = first.match(/[A-Za-z0-9_.-]+\.cjs/g);
    if (found) { rows.push({ line, names: found }); for (const n of found) names.add(n); }
  }
  return { present: true, names, rows };
}

// ---- version statements ----
function versionSources(root) {
  const src = [];
  const canon = read(path.join(root, '.claude', 'config', 'orchestration', 'forge-canon.json'));
  if (canon !== null) {
    try { src.push({ file: '.claude/config/orchestration/forge-canon.json', kind: 'canon', major: (JSON.parse(canon).version || {}).forge || null }); }
    catch { src.push({ file: '.claude/config/orchestration/forge-canon.json', kind: 'canon', error: 'unparseable' }); }
  }
  const fv = read(path.join(root, '.claude', 'FORGE_VERSION.json'));
  if (fv !== null) {
    try { src.push({ file: '.claude/FORGE_VERSION.json', kind: 'json', template_hash: JSON.parse(fv).forge_version || null }); }
    catch { src.push({ file: '.claude/FORGE_VERSION.json', kind: 'json', error: 'unparseable' }); }
  }
  // Every top-level markdown doc under docs/ that exists in THIS project is scanned (a synced project may have
  // none: that is fine, nothing is named literally, so no shipped-file reference to an unshipped doc exists).
  let docFiles = [];
  try { docFiles = fs.readdirSync(path.join(root, 'docs')).filter((f) => /\.md$/i.test(f)).sort().map((f) => 'docs/' + f); } catch { docFiles = []; }
  for (const rel of ['CLAUDE.md', '.claude/forge-bin/README.md', ...docFiles]) {
    const tx = read(path.join(root, rel));
    if (tx === null) continue;
    const majors = new Set((tx.match(/\bForge V(\d+)\b/gi) || []).map((s) => 'v' + s.replace(/\D+/g, '')));
    const semver = new Set((tx.match(/\bv(\d+\.\d+\.\d+)\b/g) || []).map((s) => s.slice(1)));
    src.push({ file: rel, kind: 'doc', majors: [...majors].sort(), semver: [...semver].sort() });
  }
  return src;
}
function cmpSemver(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function versionContradictions(sources) {
  const out = [];
  const canon = sources.find((s) => s.kind === 'canon');
  const canonMajor = canon && canon.major ? String(canon.major).toLowerCase() : null;
  const docMajors = new Map(); const sv = new Map();
  for (const s of sources) {
    if (s.kind !== 'doc') continue;
    for (const m of s.majors) { if (!docMajors.has(m)) docMajors.set(m, []); docMajors.get(m).push(s.file); }
    for (const v of s.semver) { if (!sv.has(v)) sv.set(v, []); sv.get(v).push(s.file); }
  }
  if (canonMajor) for (const [m, files] of docMajors) if (m !== canonMajor) out.push({ kind: 'major-vs-canon', canon: canonMajor, found: m, files });
  if (docMajors.size > 1) out.push({ kind: 'majors-disagree', values: [...docMajors.keys()].sort() });
  if (sv.size > 1) {
    const values = [...sv.keys()].sort(cmpSemver);
    out.push({ kind: 'semver-spread', note: 'multiple distinct vX.Y.Z tokens (may be historical references)', highest: values[values.length - 1], values });
  }
  return out;
}

// ---- file sizes (advisory) ----
function bigFiles(root) {
  const res = [];
  for (const d of SIZE_DIRS) {
    (function walk(dir, depth) {
      for (const e of listDir(dir)) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 5) walk(p, depth + 1); }
        else if (/\.(cjs|mjs|js|md|json)$/.test(e.name)) {
          const tx = read(p);
          const n = tx === null || !tx.length ? 0 : tx.split('\n').length;
          if (n > LINE_LIMIT) res.push({ file: path.relative(root, p).split(path.sep).join('/'), lines: n });
        }
      }
    })(path.join(root, d), 0);
  }
  return res.sort((a, b) => b.lines - a.lines);
}

function buildReport(root) {
  const skills = skillsOnDisk(root);
  const reg = registryEntries(root);
  const regNames = new Set(reg.rows.map((r) => r.name));
  const diskNames = new Set(skills.map((s) => s.name));
  const dirNames = new Set(skills.map((s) => path.basename(s.dir)));
  const { tools, set } = toolsOnDisk(root);
  const rd = readmeTools(root);
  const vs = versionSources(root);
  return {
    root,
    skills: {
      on_disk: skills.length, registry_rows: reg.rows.length, registry_present: reg.present,
      missing_from_registry: skills.filter((s) => !regNames.has(s.name) && !regNames.has(path.basename(s.dir))).map((s) => s.name),
      extra_in_registry: reg.rows.filter((r) => !diskNames.has(r.name) && !dirNames.has(r.name)).map((r) => r.name)
    },
    tools: {
      on_disk: tools.length, readme_present: rd.present, readme_names: rd.names.size,
      missing_from_readme: tools.filter((x) => !rd.names.has(x)),
      extra_in_readme: [...rd.names].filter((n) => !set.has(n)).sort(),
      without_test: tools.filter((x) => !set.has(x.replace(/\.cjs$/, '.test.cjs')))
    },
    versions: { sources: vs, contradictions: versionContradictions(vs) },
    oversize: { limit: LINE_LIMIT, advisory: true, files: bigFiles(root) }
  };
}

// ---- generators ----
const REG_COLS = ['Skill', 'Path', 'Source', 'Created by run', 'Last used run', 'Related subagents', 'Purpose', 'Status', 'Safety notes', 'Evidence req.'];
function esc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
function genSkillRegistry(root) {
  const skills = skillsOnDisk(root);
  const reg = registryEntries(root);
  const byName = new Map(reg.rows.map((r) => [r.name, r]));
  const col = (row, n) => {
    const i = reg.header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
    return row && i >= 0 ? row.cells[i] || '' : '';
  };
  const lines = ['# GENERATED PROPOSAL - skill registry (not applied; a human/Lead merges it)', '',
    'Rows come from `.claude/skills/*/SKILL.md`. Status, Safety notes, Evidence, Related subagents, Created-by and Last-used are CARRIED OVER BY NAME from the current FORGE_SKILL_REGISTRY.md; new skills get status `unreviewed` for a human to set.', '',
    '| ' + REG_COLS.join(' | ') + ' |', '|' + REG_COLS.map(() => '---').join('|') + '|'];
  let carried = 0, fresh = 0;
  for (const s of skills) {
    const old = byName.get(s.name) || byName.get(path.basename(s.dir));
    if (old) carried++; else fresh++;
    const cells = [s.name, s.path, col(old, 'Source') || 'forge', col(old, 'Created by run') || '(unknown)', col(old, 'Last used run') || '-',
      col(old, 'Related subagents') || '-', s.description || col(old, 'Purpose') || '-', col(old, 'Status') || 'unreviewed',
      col(old, 'Safety notes') || '-', col(old, 'Evidence req.') || '-'];
    lines.push('| ' + cells.map(esc).join(' | ') + ' |');
  }
  const known = new Set(skills.map((s) => s.name).concat(skills.map((s) => path.basename(s.dir))));
  const orphans = reg.rows.filter((r) => !known.has(r.name));
  if (orphans.length) lines.push('', '<!-- registry rows with no skill on disk (omitted; review): ' + orphans.map((o) => o.name).join(', ') + ' -->');
  lines.push('', '<!-- generated: ' + skills.length + ' skills, ' + carried + ' carried over, ' + fresh + ' new (unreviewed) -->');
  return { text: lines.join('\n') + '\n', stats: { skills: skills.length, carried, fresh, orphans: orphans.length } };
}
function genToolTable(root) {
  const { tools, set } = toolsOnDisk(root);
  const rd = readmeTools(root);
  const purposeOf = new Map();
  for (const r of rd.rows) {
    const purpose = splitRow(r.line).slice(1).join(' | ');
    for (const n of r.names) if (!purposeOf.has(n)) purposeOf.set(n, purpose);
  }
  const lines = ['# GENERATED PROPOSAL - forge-bin tool table (not applied; a human/Lead merges it)', '',
    'One row per non-test `.cjs`. Purpose is carried over by name from the current README.md table; tools with no existing row get `TODO (undocumented)`.', '',
    '| Tool | Test | Purpose |', '|---|---|---|'];
  let carried = 0, todo = 0;
  for (const x of tools) {
    const p = purposeOf.get(x);
    if (p) carried++; else todo++;
    lines.push('| `' + x + '` | ' + (set.has(x.replace(/\.cjs$/, '.test.cjs')) ? 'yes' : 'NO') + ' | ' + (p || 'TODO (undocumented)') + ' |');
  }
  lines.push('', '<!-- generated: ' + tools.length + ' tools, ' + carried + ' purposes carried over, ' + todo + ' undocumented -->');
  return { text: lines.join('\n') + '\n', stats: { tools: tools.length, carried, todo } };
}

// ===================================================================================================
// FEATURE REGISTRY (audit S3/F4).
// One entry per non-test forge-bin tool and per skill folder: {id, kind, status, invoked_by, consumer, since,
// note?, replacement?}. `invoked_by` is found MECHANICALLY by a static scan (never guessed by hand):
//   wired roots      - hooks in .claude/settings.json; flow docs (CLAUDE.md, commands/forge.md, the forge-cmd-*
//                      and router-* reference docs except the sub-command doc, agents/*.md); the event writer
//                      (forge-dashboard/*.cjs); the Command Center gateway/discord sources; the domain catalog's
//                      playbooks and the skill bundles (config/skills/global-skills.json, agent-skill-map.json).
//   on-request roots - the /forge sub-command docs, other slash commands, .claude/docs/*.md, the terminal
//                      wrappers (forge-bin/*.cmd|ps1|sh) and README lines that show a `node ...` command.
//   nodes            - a tool that require()s / spawns another tool; a skill whose docs name a tool or skill.
// Status = the strongest caller chain (fixed point): wired > on-request > dormant. A top-level skill with a
// description is on-request by itself (the owner or model can invoke it by name); a nested skill folder is not
// discovered by Claude Code, so it needs a caller. The doctor and the test runner are never callers: they CHECK
// a tool, they do not USE it. `retired` comes only from FORGE_SHIP_MANIFEST.json rules of class `retired`.
// ===================================================================================================
const FEATURE_REGISTRY_REL = '.claude/config/orchestration/FORGE_FEATURE_REGISTRY.json';
const FEATURE_SCHEMA = 'forge-feature-registry/v1';
const FEATURE_STATUSES = ['wired', 'on-request', 'dormant', 'retired'];
const FEATURE_KINDS = ['tool', 'skill'];
const STATUS_RANK = { dormant: 0, 'on-request': 1, wired: 2 };
const RANK_STATUS = ['dormant', 'on-request', 'wired'];
const NOT_A_CALLER = new Set(['forge-doctor.cjs', 'forge-testrun.cjs', 'forge-registry-gen.cjs']);
const INVOKED_BY_CAP = 10;
const CALL_RE = /\b(?:require|spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(|\bnew\s+Worker\s*\(|\bpath\.(?:join|resolve)\s*\(|\brequire\.resolve\s*\(/;
const TOOL_TOKEN_RE = /([A-Za-z0-9_][A-Za-z0-9_.-]*)\.cjs\b/g;
const REQUIRE_REL_RE = /require\(\s*['"`]\.{1,2}\/(?:[A-Za-z0-9_.-]+\/)*([A-Za-z0-9_.-]+?)(?:\.cjs)?['"`]\s*\)/g;
// A local loader that wraps require on its own line (`const tryRequire = (n) => { ... require(...) ... }` or
// `function load(n) { ... require(...) ... }`). A call of that loader with a tool name is a require too (A6 F1:
// forge-routing-stats.cjs loads forge-stats.cjs through tryRequire('forge-stats.cjs')).
const WRAPPER_DEF_RES = [
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>.*\brequire\s*\(/,
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{.*\brequire\s*\(/,
];
function requireWrappers(lines) {
  const names = new Set();
  for (const L of lines) for (const re of WRAPPER_DEF_RES) { const w = re.exec(L); if (w && w[1] !== 'require') names.add(w[1]); }
  return names.size ? new RegExp('\\b(?:' + [...names].map(escRe).join('|') + ')\\s*\\(') : null;
}
const GATEWAY_DIRS = ['command-center/gateway/src', 'command-center/discord/src'];
const GATEWAY_FILES = ['command-center/gateway/bin.mjs', 'command-center/gateway/supervisor.mjs'];

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function walkFiles(dir, re, skip) {
  const out = [];
  (function w(d, depth) {
    for (const e of listDir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 8 && !(skip && skip.test(e.name))) w(p, depth + 1); }
      else if (e.isFile() && re.test(e.name)) out.push(p);
    }
  })(dir, 0);
  return out.sort();
}
const relOf = (root, p) => path.relative(root, p).split(path.sep).join('/');
/** stripJsComments(src) - removes // and block comments, line by line, keeping string contents (where tool file
 *  names live). A quote never spans a line here, so a mis-read regex literal can only hide the rest of ONE line. */
function stripJsComments(src) {
  const out = []; let inBlock = false, inTpl = false;
  for (const line of String(src).split(/\r?\n/)) {
    let s = '', q = inTpl ? '`' : null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], n = line[i + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
      if (q) { s += c; if (c === '\\') { s += n || ''; i++; } else if (c === q) q = null; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      s += c;
    }
    inTpl = q === '`';
    out.push(s);
  }
  return out.join('\n');
}
/** codeCalls(src, tools) -> Map<tool, 'require'|'spawn'>. A require of './x' or a tool file name on a line that
 *  calls require/spawn/exec/fork/new Worker/path.join/path.resolve (or right after such a line). A name that
 *  only appears in a message or a plain list is NOT a call. A call of a local require wrapper (requireWrappers)
 *  with a tool name is a require. */
function codeCalls(src, tools) {
  const lines = stripJsComments(src).split('\n');
  const found = new Map();
  const wrapCallRe = requireWrappers(lines);
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let m;
    REQUIRE_REL_RE.lastIndex = 0;
    while ((m = REQUIRE_REL_RE.exec(L))) { const t = m[1] + '.cjs'; if (tools.has(t)) found.set(t, 'require'); }
    if (!L.includes('.cjs')) continue;
    const prev = lines[i - 1] || '';
    const viaWrapper = !!(wrapCallRe && wrapCallRe.test(L));
    const callish = viaWrapper || CALL_RE.test(L) || (CALL_RE.test(prev) && /[([,]\s*$/.test(prev)); // a wrapped, still-open call only
    if (!callish) continue;
    TOOL_TOKEN_RE.lastIndex = 0;
    while ((m = TOOL_TOKEN_RE.exec(L))) { const t = m[1] + '.cjs'; if (tools.has(t) && !found.has(t)) found.set(t, viaWrapper || /require/.test(L) ? 'require' : 'spawn'); }
  }
  return found;
}
function toolMentions(text, tools) {
  const out = new Set(); let m;
  TOOL_TOKEN_RE.lastIndex = 0;
  while ((m = TOOL_TOKEN_RE.exec(String(text)))) { const t = m[1] + '.cjs'; if (tools.has(t)) out.add(t); }
  return out;
}
/** skillMentions(text, names) - a forge-* skill by its bare name (never `forge-x.cjs`, `forge-x-y` or a
 *  `.claude/forge-x/` folder); any other skill only in backticks, as a `/name` command or a skills/<name>/ path,
 *  so ordinary words (teach, grilling) in prose never count. */
function skillMentions(text, names) {
  const out = new Set(); const t = String(text);
  for (const [name, id] of names) {
    const e = escRe(name);
    const strict = new RegExp('`/?' + e + '`|skills/' + e + '[/\\\\]|(?:^|\\s)/' + e + '(?![\\w-])');
    const loose = name.startsWith('forge-') ? new RegExp('(?<![\\w./\\\\-])' + e + '(?![\\w-]|\\.cjs)') : null;
    // a nested skill (gsap/gsap-core) is also reached through its bundle folder: `.claude/skills/gsap/<skill-name>/SKILL.md`
    const parent = id.includes('/') ? new RegExp('skills/' + escRe(id.split('/')[0]) + '/') : null;
    if (strict.test(t) || (loose && loose.test(t)) || (parent && parent.test(t))) out.add(id);
  }
  return out;
}
function fmBlock(text) { const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || ''); return m ? m[1] : null; }

/** featureInventory(root) -> {tools:[{id, rel}], skills:[{id, name, rel, dir, nested, described}]} */
function featureInventory(root) {
  const bin = path.join(root, '.claude', 'forge-bin');
  const tools = listDir(bin).filter((e) => e.isFile() && /\.cjs$/.test(e.name) && !/\.test\.cjs$/.test(e.name))
    .map((e) => ({ id: e.name, rel: '.claude/forge-bin/' + e.name })).sort((a, b) => a.id.localeCompare(b.id));
  const skills = skillsOnDisk(root).map((s) => {
    const fm = parseFrontmatter(read(path.join(root, s.path)) || '');
    return { id: s.dir, name: path.basename(s.dir), rel: s.path, dir: '.claude/skills/' + s.dir, nested: s.dir.includes('/'), described: !!fm.description };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { tools, skills };
}

/** featureSources(root, inv) -> [{rel, role:'wired'|'on-request'|'node', node?, kind, text, code?, skills?}] */
function featureSources(root, inv) {
  const S = [];
  const add = (rel, role, kind, extra) => { const text = read(path.join(root, rel)); if (text !== null) S.push(Object.assign({ rel, role, kind, text }, extra || {})); };
  add('CLAUDE.md', 'wired', 'doc:flow');
  add('.claude/commands/forge.md', 'wired', 'doc:flow');
  const ref = path.join(root, '.claude', 'docs', 'forge-reference');
  for (const e of listDir(ref)) {
    if (!e.isFile() || !/\.md$/.test(e.name)) continue;
    const flow = (/^forge-cmd-/.test(e.name) && e.name !== 'forge-cmd-subcommands.md') || /^router-/.test(e.name);
    add('.claude/docs/forge-reference/' + e.name, flow ? 'wired' : 'on-request', flow ? 'doc:flow' : 'doc:command');
  }
  for (const e of listDir(path.join(root, '.claude', 'agents'))) if (e.isFile() && /\.md$/.test(e.name)) add('.claude/agents/' + e.name, 'wired', 'doc:agent');
  for (const e of listDir(path.join(root, '.claude', 'commands'))) if (e.isFile() && /\.md$/.test(e.name) && e.name !== 'forge.md') add('.claude/commands/' + e.name, 'on-request', 'doc:command');
  for (const e of listDir(path.join(root, '.claude', 'docs'))) if (e.isFile() && /\.md$/.test(e.name)) add('.claude/docs/' + e.name, 'on-request', 'doc:reference');
  for (const e of listDir(path.join(root, '.claude', 'forge-bin'))) if (e.isFile() && /\.(cmd|ps1|sh)$/.test(e.name)) add('.claude/forge-bin/' + e.name, 'on-request', 'wrapper');
  const readme = read(path.join(root, '.claude', 'forge-bin', 'README.md'));
  if (readme !== null) S.push({ rel: '.claude/forge-bin/README.md', role: 'on-request', kind: 'doc:readme', text: readme.split(/\r?\n/).filter((l) => /\bnode\s/.test(l) && !/^\s*\|/.test(l)).join('\n') });
  let settings = null;
  try { settings = JSON.parse(read(path.join(root, '.claude', 'settings.json')) || 'null'); } catch { settings = null; }
  for (const [event, groups] of Object.entries((settings && settings.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) for (const h of (g && Array.isArray(g.hooks)) ? g.hooks : []) {
      if (h && typeof h.command === 'string') S.push({ rel: '.claude/settings.json', role: 'wired', kind: 'hook:' + event, text: h.command });
    }
  }
  // the run contract: `forge-runcontract plan` (mandated by commands/forge.md) prints these steps for the Lead to run
  let rules = null;
  try { rules = JSON.parse(read(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json')) || 'null'); } catch { rules = null; }
  if (rules) {
    const pick = (arr, k) => (Array.isArray(arr) ? arr : []).map((x) => (x && typeof x[k] === 'string' ? x[k] : '')).filter(Boolean);
    const steps = pick(rules.completion_sequence, 'command').concat(pick(rules.steps, 'label'), pick(rules.lifecycle, 'required_reaction'));
    S.push({ rel: '.claude/config/orchestration/FORGE_HARD_RULES.json', role: 'wired', kind: 'run-contract', text: steps.join('\n') });
  }
  for (const e of listDir(path.join(root, '.claude', 'forge-dashboard'))) if (e.isFile() && /\.cjs$/.test(e.name)) add('.claude/forge-dashboard/' + e.name, 'wired', 'code:event-writer', { code: true });
  const gw = [];
  for (const d of GATEWAY_DIRS) for (const p of walkFiles(path.join(root, d), /\.(mjs|cjs|js)$/, /^(node_modules|dist|tests?|__tests__|test-support)$/)) if (!/\.test\.(mjs|cjs|js)$/.test(p)) gw.push(relOf(root, p));
  for (const f of GATEWAY_FILES) if (fs.existsSync(path.join(root, f))) gw.push(f);
  for (const rel of gw) add(rel, 'wired', 'code:gateway', { code: true });
  const cat = (() => { try { return JSON.parse(read(path.join(root, '.claude', 'config', 'orchestration', 'domain-catalog.json')) || 'null'); } catch { return null; } })();
  if (cat && cat.domains) S.push({ rel: '.claude/config/orchestration/domain-catalog.json', role: 'wired', kind: 'catalog', text: '', skills: Object.values(cat.domains).map((d) => d && d.playbook).filter(Boolean) });
  const leaves = (o, acc) => { if (typeof o === 'string') acc.push(o); else if (o && typeof o === 'object') for (const v of Object.values(o)) leaves(v, acc); return acc; };
  for (const [rel, pick] of [['.claude/config/skills/global-skills.json', (j) => j.bundles], ['.claude/config/agents/agent-skill-map.json', (j) => j]]) {
    let j = null; try { j = JSON.parse(read(path.join(root, rel)) || 'null'); } catch { j = null; }
    if (j) S.push({ rel, role: 'wired', kind: 'bundle', text: '', skills: leaves(pick(j), []) });
  }
  for (const t of inv.tools) if (!NOT_A_CALLER.has(t.id)) add(t.rel, 'node', 'code:' + t.id, { node: 'tool:' + t.id, code: true });
  for (const s of inv.skills) {
    for (const p of walkFiles(path.join(root, s.dir), /\.md$/i, null)) {
      if (/(^|[\\/])learnings\.md$/i.test(p)) continue; // past lessons, not instructions
      // a parent skill folder (gsap) must not claim the docs of its nested skills
      if (inv.skills.some((o) => o.id !== s.id && o.id.startsWith(s.id + '/') && p.startsWith(path.join(root, o.dir) + path.sep))) continue;
      add(relOf(root, p), 'node', 'skill-doc', { node: 'skill:' + s.id });
    }
  }
  return S;
}

/** classifyFeatures(root) -> {inventory, nodes: Map<'tool:x'|'skill:y', {kind, id, status, callers:[{from, kind, role, node}]}>,
 *  gatewayScanned}. Pure read. */
function classifyFeatures(root) {
  const inv = featureInventory(root);
  const toolSet = new Set(inv.tools.map((t) => t.id));
  const names = new Map(inv.skills.map((s) => [s.name, s.id]));
  const nodes = new Map();
  for (const t of inv.tools) nodes.set('tool:' + t.id, { kind: 'tool', id: t.id, rel: t.rel, base: 0, callers: [] });
  for (const s of inv.skills) nodes.set('skill:' + s.id, { kind: 'skill', id: s.id, rel: s.rel, base: !s.nested && s.described ? 1 : 0, callers: [] });
  const sources = featureSources(root, inv);
  const nameToId = new Map(inv.skills.map((s) => [s.name, s.id]));
  for (const src of sources) {
    const hits = [];
    if (src.code) for (const [t, how] of codeCalls(src.text, toolSet)) hits.push(['tool:' + t, src.kind.startsWith('code:') && src.role === 'node' ? 'code:' + how : src.kind + ':' + how]);
    else {
      for (const t of toolMentions(src.text, toolSet)) hits.push(['tool:' + t, src.kind]);
      for (const id of skillMentions(src.text, names)) hits.push(['skill:' + id, src.kind]);
    }
    for (const n of src.skills || []) if (nameToId.has(n)) hits.push(['skill:' + nameToId.get(n), src.kind]);
    for (const [key, kind] of hits) {
      const node = nodes.get(key);
      if (!node || key === src.node) continue;
      if (node.callers.some((c) => c.from === src.rel && c.kind === kind)) continue;
      node.callers.push({ from: src.rel, kind, role: src.role, node: src.node || null });
    }
  }
  const rank = new Map([...nodes].map(([k, n]) => [k, n.base]));
  for (let changed = true, guard = 0; changed && guard < 100; guard++) {
    changed = false;
    for (const [k, n] of nodes) {
      let r = rank.get(k);
      for (const c of n.callers) r = Math.max(r, c.role === 'wired' ? 2 : c.role === 'on-request' ? 1 : (rank.get(c.node) || 0));
      if (r !== rank.get(k)) { rank.set(k, r); changed = true; }
    }
  }
  for (const [k, n] of nodes) n.status = RANK_STATUS[rank.get(k)];
  const gatewayScanned = sources.some((s) => s.kind === 'code:gateway');
  return { inventory: inv, nodes, gatewayScanned };
}

const CALLER_ORDER = (c) => (c.kind.startsWith('hook:') ? 0 : c.role === 'wired' ? 1 : c.role === 'on-request' ? 2 : 3);
function callerStrings(callers) {
  const sorted = callers.slice().sort((a, b) => CALLER_ORDER(a) - CALLER_ORDER(b) || a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind));
  const strs = sorted.map((c) => c.from + ' (' + c.kind + ')');
  return strs.length > INVOKED_BY_CAP ? strs.slice(0, INVOKED_BY_CAP).concat(['... +' + (strs.length - INVOKED_BY_CAP) + ' more']) : strs;
}
function deriveConsumer(n) {
  const c = n.callers;
  const hooks = [...new Set(c.filter((x) => x.kind.startsWith('hook:')).map((x) => x.kind.slice(5)))];
  if (hooks.length) return 'Claude Code hook (' + hooks.join(', ') + ')';
  if (c.some((x) => x.role === 'wired' && /^doc:/.test(x.kind))) return 'the Lead (main session) during a /forge run';
  if (c.some((x) => x.kind.startsWith('code:gateway'))) return 'the Command Center gateway';
  if (c.some((x) => x.kind.startsWith('code:event-writer'))) return 'log-event.cjs (every logged event)';
  if (c.some((x) => x.kind === 'catalog' || x.kind === 'bundle')) return 'the router / Skill Boss (playbook or bundle)';
  const tools = [...new Set(c.filter((x) => x.role === 'node' && x.node && x.node.startsWith('tool:')).map((x) => x.node.slice(5)))];
  if (tools.length) return 'module of ' + tools.slice(0, 4).join(', ') + (tools.length > 4 ? ' +' + (tools.length - 4) : '');
  if (n.kind === 'skill' && n.status === 'on-request') return 'the owner or model, by skill name or trigger';
  if (c.length) return 'the owner or Lead, on request';
  return '-';
}
function autoDormantNote(root, n) {
  if (n.kind === 'skill') return n.id.includes('/') ? 'nested skill folder: Claude Code does not discover it as a skill and no wired doc names it' : 'no description in its frontmatter and no caller: invisible to the model';
  const base = n.id.replace(/\.cjs$/, '');
  const bin = path.join(root, '.claude', 'forge-bin');
  const why = [];
  // WP A11 part 2: the checks live in forge-bin/doctor/*.cjs too, so "the doctor reads it" scans root + modules.
  const doctorDir = path.join(bin, 'doctor');
  const doctor = [read(path.join(bin, 'forge-doctor.cjs')) || '']
    .concat(listDir(doctorDir).filter((e) => e.isFile() && /\.cjs$/.test(e.name)).map((e) => read(path.join(doctorDir, e.name)) || ''))
    .join(' ');
  if (new RegExp('[\'"`/]' + escRe(n.id) + '[\'"`]|\\./' + escRe(base) + '[\'"`]').test(doctor)) why.push('the doctor reads it');
  const tests = listDir(bin).filter((e) => /\.test\.cjs$/.test(e.name) && (e.name === base + '.test.cjs' || (read(path.join(bin, e.name)) || '').includes(n.id)));
  if (tests.length) why.push('exercised by ' + tests.length + ' test file(s)');
  if (n.callers.length) why.push('its only callers are dormant: ' + [...new Set(n.callers.map((x) => x.from))].slice(0, 3).join(', '));
  return 'no caller found (no hook, flow doc, command doc, skill or wired tool runs it)' + (why.length ? '; ' + why.join('; ') : '');
}
function retiredFromManifest(root) {
  let m = null;
  try { m = JSON.parse(read(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json')) || 'null'); } catch { m = null; }
  // code features only (a .cjs/.js/.mjs/.html file in the pattern), never a test or a runtime-state file
  return ((m && m.rules) || []).filter((r) => r && r.class === 'retired' && typeof r.pattern === 'string' && /\.(cjs|js|mjs|html)\b/.test(r.pattern) && !/\.test\.cjs\b/.test(r.pattern))
    .map((r) => ({ id: r.pattern, kind: 'tool', status: 'retired', invoked_by: [], consumer: '-', replacement: r.replacement || '(none recorded)', note: r.reason || '' }));
}
function loadFeatureRegistry(root) {
  const p = path.join(root, FEATURE_REGISTRY_REL);
  const text = read(p);
  if (text === null) return { present: false, data: null, error: null, path: p };
  try { return { present: true, data: JSON.parse(text), error: null, path: p }; } catch (e) { return { present: true, data: null, error: 'not valid JSON: ' + e.message, path: p }; }
}
/** validateFeatureRegistry(data) -> [problem strings]: shape only (schema, kinds, statuses, duplicates, retired needs a replacement). */
function validateFeatureRegistry(data) {
  const p = [];
  if (!data || typeof data !== 'object') return ['the registry is not a JSON object'];
  if (data.schema !== FEATURE_SCHEMA) p.push('schema is ' + JSON.stringify(data.schema) + ', expected ' + FEATURE_SCHEMA);
  if (!Array.isArray(data.features)) return p.concat(['"features" is not an array']);
  const seen = new Set();
  data.features.forEach((f, i) => {
    const at = 'features[' + i + ']' + (f && f.id ? ' ' + f.id : '');
    if (!f || typeof f.id !== 'string' || !f.id) { p.push(at + ': missing id'); return; }
    if (!FEATURE_KINDS.includes(f.kind)) p.push(at + ': kind must be tool|skill');
    if (!FEATURE_STATUSES.includes(f.status)) p.push(at + ': status must be ' + FEATURE_STATUSES.join('|'));
    if (!Array.isArray(f.invoked_by)) p.push(at + ': invoked_by must be an array');
    if (f.status === 'retired' && !(typeof f.replacement === 'string' && f.replacement.trim())) p.push(at + ': a retired entry needs a replacement');
    const key = f.kind + ':' + f.id;
    if (seen.has(key)) p.push(at + ': duplicate entry'); seen.add(key);
  });
  return p;
}
/** genFeatureRegistry(root, prev, opts) -> {data, stats}. Carries `since` always, and `note` while the status is
 *  unchanged (a hand-reviewed dormant note survives regeneration). The size allowlist is seeded once and then
 *  only ever carried over, so a NEW oversized file shows up in the doctor until a human lists it. */
function genFeatureRegistry(root, prev, opts) {
  const o = opts || {};
  const today = o.today || new Date().toISOString().slice(0, 10);
  const c = classifyFeatures(root);
  const prevBy = new Map(((prev && Array.isArray(prev.features)) ? prev.features : []).filter((f) => f && f.id).map((f) => [f.kind + ':' + f.id, f]));
  const features = [];
  for (const [key, n] of c.nodes) {
    const old = prevBy.get(key);
    const e = { id: n.id, kind: n.kind, status: n.status, invoked_by: callerStrings(n.callers), consumer: deriveConsumer(n), since: (old && old.since) || today };
    const keepNote = old && old.status === n.status && typeof old.note === 'string' && old.note.trim();
    if (keepNote) e.note = old.note;
    else if (n.status === 'dormant') e.note = autoDormantNote(root, n);
    features.push(e);
  }
  const retired = retiredFromManifest(root);
  const have = new Set(features.map((f) => f.kind + ':' + f.id));
  for (const r of retired) if (!have.has(r.kind + ':' + r.id)) { const old = prevBy.get(r.kind + ':' + r.id); features.push(Object.assign(r, { since: (old && old.since) || today })); have.add(r.kind + ':' + r.id); }
  for (const [key, f] of prevBy) if (f.status === 'retired' && !have.has(key)) features.push(f);
  features.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const counts = {};
  for (const k of FEATURE_KINDS) { counts[k] = {}; for (const s of FEATURE_STATUSES) counts[k][s] = features.filter((f) => f.kind === k && f.status === s).length; }
  const oversize = bigFiles(root).filter((f) => !/\.test\.cjs$/.test(f.file) && !/\.json$/.test(f.file)).map((f) => f.file).sort();
  const sizeAllow = prev && prev.structure && Array.isArray(prev.structure.size_allowlist) ? prev.structure.size_allowlist : oversize;
  const data = {
    schema: FEATURE_SCHEMA,
    _doc: 'One entry per non-test .claude/forge-bin/*.cjs tool and per .claude/skills skill folder (WP-8b). GENERATED by `node .claude/forge-bin/forge-registry-gen.cjs feature-registry --write`; hand-edit only `note` (kept while the status stays the same) and `structure.size_allowlist`. status: wired = a hook, a flow doc (CLAUDE.md, commands/forge.md, router/forge-cmd reference docs, agents), the event writer, the Command Center gateway, the domain catalog/skill bundles or a wired tool/skill runs it; on-request = only a /forge sub-command doc, a slash command, a terminal wrapper, a README command line or an on-request skill names it (a top-level skill with a description is on-request by itself); dormant = nothing runs it (with a note); retired = gone on purpose (from FORGE_SHIP_MANIFEST.json, with its replacement). invoked_by = direct callers found by a static scan: "<path> (<kind>)", strongest first, capped at ' + INVOKED_BY_CAP + '. The doctor (feature_registry, enforced in the development tree) is red when a tool/skill on disk is missing here, an entry\'s file is gone, or a wired entry no longer has a wired caller; dormant/on-request are never red.',
    counts,
    structure: { _doc: 'Advisory doctor check `structure`: source files over 800 lines (tests and JSON excluded) that are NOT listed here are reported. Seeded once from the files that were already that big; add a file here only on purpose.', size_allowlist: sizeAllow },
    features,
  };
  return { data, stats: { tools: c.inventory.tools.length, skills: c.inventory.skills.length, retired: features.filter((f) => f.status === 'retired').length, counts, gatewayScanned: c.gatewayScanned } };
}

// ---- CLI ----
function parseArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const k = tok.slice(2); const nx = argv[i + 1];
      if (['root', 'target', 'out'].includes(k) && nx !== undefined && !nx.startsWith('--')) { a.flags[k] = nx; i++; } else a.flags[k] = true;
    } else a._.push(tok);
  }
  return a;
}
function protectedTarget(root, out) {
  const abs = path.resolve(out).toLowerCase();
  return ['.claude/FORGE_SKILL_REGISTRY.md', '.claude/forge-bin/README.md'].some((r) => path.resolve(root, r).toLowerCase() === abs);
}
function printReport(r) {
  const L = [];
  L.push('skills: ' + r.skills.on_disk + ' on disk, ' + r.skills.registry_rows + ' registry rows, ' + r.skills.missing_from_registry.length + ' missing, ' + r.skills.extra_in_registry.length + ' extra');
  if (r.skills.missing_from_registry.length) L.push('  missing from registry: ' + r.skills.missing_from_registry.join(', '));
  if (r.skills.extra_in_registry.length) L.push('  extra in registry: ' + r.skills.extra_in_registry.join(', '));
  L.push('tools: ' + r.tools.on_disk + ' on disk, ' + r.tools.readme_names + ' named in README, ' + r.tools.missing_from_readme.length + ' missing, ' + r.tools.extra_in_readme.length + ' extra, ' + r.tools.without_test.length + ' without test');
  if (r.tools.missing_from_readme.length) L.push('  missing from README: ' + r.tools.missing_from_readme.join(', '));
  if (r.tools.extra_in_readme.length) L.push('  extra in README: ' + r.tools.extra_in_readme.join(', '));
  if (r.tools.without_test.length) L.push('  without test: ' + r.tools.without_test.join(', '));
  L.push('versions: ' + r.versions.contradictions.length + ' contradiction(s)');
  for (const c of r.versions.contradictions) L.push('  ' + JSON.stringify(c));
  L.push('oversize (>' + r.oversize.limit + ' lines, advisory): ' + r.oversize.files.length);
  for (const f of r.oversize.files) L.push('  ' + f.lines + '  ' + f.file);
  return L.join('\n');
}
function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const rootArg = typeof a.flags.root === 'string' ? a.flags.root : defaultRoot();
  if (!rootArg) { process.stderr.write('forge-registry-gen: no project root found (no .claude, .forge or .git above the current folder) — pass --root <dir>\n'); return 2; }
  const root = path.resolve(rootArg);
  if (cmd === 'report') {
    const r = buildReport(root);
    process.stdout.write((a.flags.json ? JSON.stringify(r, null, 2) : printReport(r)) + '\n');
    return 0;
  }
  if (cmd === 'generate') {
    const target = a.flags.target;
    if (target !== 'skill-registry' && target !== 'tool-table') { process.stderr.write('usage: generate --target skill-registry|tool-table [--out <file>]\n'); return 2; }
    const g = target === 'skill-registry' ? genSkillRegistry(root) : genToolTable(root);
    const out = path.resolve(typeof a.flags.out === 'string' ? a.flags.out
      : path.join(defaultOutDir(root), target === 'skill-registry' ? 'FORGE_SKILL_REGISTRY.generated.md' : 'forge-bin-tool-table.generated.md'));
    if (protectedTarget(root, out)) { process.stderr.write('refused: would overwrite a hand-kept file; choose another --out\n'); return 2; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, g.text);
    process.stdout.write('wrote ' + out + ' ' + JSON.stringify(g.stats) + '\n');
    return 0;
  }
  if (cmd === 'feature-registry') {
    const prev = loadFeatureRegistry(root);
    if (prev.error) { process.stderr.write('refused: ' + FEATURE_REGISTRY_REL + ' is ' + prev.error + ' — fix or move it first (its hand notes would be lost)\n'); return 2; }
    const g = genFeatureRegistry(root, prev.data);
    const text = JSON.stringify(g.data, null, 2) + '\n';
    if (a.flags.json) process.stdout.write(text);
    const dormant = g.data.features.filter((f) => f.status === 'dormant');
    const summary = 'feature registry: ' + g.stats.tools + ' tools, ' + g.stats.skills + ' skills, ' + g.stats.retired + ' retired · '
      + FEATURE_KINDS.map((k) => k + 's ' + ['wired', 'on-request', 'dormant'].map((s) => s + ' ' + g.stats.counts[k][s]).join(' / ')).join(' · ')
      + (g.stats.gatewayScanned ? '' : ' · Command Center sources NOT scanned (command-center/ absent)');
    if (!a.flags.json) process.stdout.write(summary + '\n' + (dormant.length ? 'dormant:\n' + dormant.map((f) => '  ' + f.kind + ' ' + f.id + ' — ' + f.note).join('\n') + '\n' : ''));
    if (a.flags.write) { fs.mkdirSync(path.dirname(prev.path), { recursive: true }); fs.writeFileSync(prev.path, text); process.stderr.write('wrote ' + prev.path + '\n'); }
    else if (!a.flags.json) process.stdout.write('(dry run — add --write to update ' + FEATURE_REGISTRY_REL + ')\n');
    return 0;
  }
  if (cmd === 'agents') return agentsCommand(root, a.flags);
  process.stderr.write('usage: report [--json] | generate --target skill-registry|tool-table [--out <file>] | feature-registry [--write] [--json] | agents [--check] [--write] [--json]   (all take [--root <dir>])\n');
  return 2;
}

/** `agents` (WP 1.5): the agent .md frontmatter is the single source of truth; this writes or checks
 *  .claude/config/agents/agents.generated.json. The logic lives in forge-policy.cjs (shared with forge-doctor).
 *  --check: exit 0 in sync (or n/a), 1 on drift/violations. --write: only in the development tree, never from
 *  unreadable frontmatter. No flag: dry run (summary, or the JSON with --json). Exit 2 = refused. */
function agentsCommand(root, flags) {
  const P = require('./forge-policy.cjs');
  const rel = P.AGENTS_GENERATED_REL.join('/');
  if (flags.check) {
    const r = P.agentsGeneratedCheck(root);
    if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else {
      process.stdout.write('agents generated config — ' + (r.applicable === false ? 'n/a (' + r.reason + ')' : (r.ok ? 'IN SYNC' : 'DRIFT') + ' · ' + r.checked + ' agent(s) checked') + '\n');
      for (const x of r.violations) process.stdout.write('  ✗ ' + x.kind + ': ' + x.detail + '\n');
      for (const n of r.notes) process.stdout.write('  ℹ ' + n + '\n');
      if (!r.ok) process.stdout.write('fix: change the agent frontmatter (the source), then `node .claude/forge-bin/forge-registry-gen.cjs agents --write`\n');
    }
    return r.ok ? 0 : 1;
  }
  const g = P.buildAgentsGenerated(root);
  if (g.problems.length) { process.stderr.write('refused: ' + g.problems.map((p) => p.detail).join('; ') + '\n'); return 2; }
  const text = JSON.stringify(g.data, null, 2) + '\n';
  if (flags.write) {
    if (!P.isDevTree(root)) { process.stderr.write('refused: ' + rel + ' is a shipped template file; regenerate it in the development tree (.claude/config/forge-dev-tree.json), not in an installed project\n'); return 2; }
    const out = path.join(root, ...P.AGENTS_GENERATED_REL);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    process.stderr.write('wrote ' + out + ' (' + g.data.counts.agents + ' agents: ' + g.data.counts.bosses + ' bosses, ' + g.data.counts.specialists + ' specialists)\n');
    return 0;
  }
  if (flags.json) process.stdout.write(text);
  else process.stdout.write(g.data.counts.agents + ' agents from frontmatter (' + g.data.counts.bosses + ' bosses, ' + g.data.counts.specialists + ' specialists) — dry run, add --write to update ' + rel + '\n');
  return 0;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { buildReport, genSkillRegistry, genToolTable, skillsOnDisk, registryEntries, versionContradictions, main, agentsCommand,
  // feature registry
  FEATURE_REGISTRY_REL, FEATURE_SCHEMA, FEATURE_STATUSES, FEATURE_KINDS, NOT_A_CALLER, featureInventory, classifyFeatures,
  genFeatureRegistry, loadFeatureRegistry, validateFeatureRegistry, codeCalls, skillMentions, stripJsComments, bigFiles, LINE_LIMIT };
