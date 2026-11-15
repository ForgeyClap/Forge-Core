#!/usr/bin/env node
'use strict';
/**
 * forge-vault-map.cjs — the Forge "mind map" layer of the Obsidian vault. Zero-dependency (fs + path only).
 *
 * WHAT IT ADDS (beside forge-vault.cjs, which keeps owning Home.md, runs/ and decisions/ — this file never
 * writes there): a generated map under <root>/.claude/forge-vault/map/
 *   Map-Home.md            index of every map note, by kind
 *   agents/<id>.md         one note per Boss / specialist (.claude/agents/*.md + config/agents/agent-registry.json)
 *   skills/<name>.md       one note per skill in .claude/skills/<name>/SKILL.md, plus ECC/plugin skills named in
 *                          config/skills/global-skills.json bundles (playbooks are skills tagged "playbook")
 *   routes/<route>.md      GOAT routes from .claude/FORGE_MODEL_ROUTING.json
 *   rules/<slug>.md        CLAUDE.md "## " sections, FORGE_HARD_RULES.json and FORGE_STANDING_RULES.json rules
 *   config/<key>.md        one note per setting in FORGE_CONFIG_SCHEMA.json
 *   runs/<run_id>.md       header data only, from .claude/forge-runs/<id>/run.json (folder name when absent)
 *   memory/<agent>.md      "memory per agent": points at .claude/agent-memory/<agent>/MEMORY.md, its newest lines
 *   hooks/<script>.md      hook scripts registered in .claude/settings.json (read only)
 *   gates/<id>.md          hard gates from hard-gates.json (command gates enforced by the gate hook vs owner gates)
 *   notes/<date>-<slug>.md lessons/decisions written by `add-note` (never regenerated or removed by `generate`)
 *   Forge-Mindmap.canvas   JSON Canvas 1.0 with groups and agent->skill / agent->route edges
 *
 * RULES: reads only inside <root>; never reads .env, keys or credentials; every free text passes scrub() (JWTs,
 * known token prefixes, long mixed-case base64-like runs and long hex runs become [REDACTED]). Idempotent: the
 * date comes from --date (default 2026-11-10), output is sorted, a file is written only when its bytes change.
 * Generated notes carry `generated: forge-vault-map`; a generated note whose source is gone is removed with a
 * single-file unlink (never a recursive delete). Every wikilink is emitted only when its target note is in the
 * output set, and findDeadLinks() re-checks that on disk.
 *
 * CLI:
 *   node forge-vault-map.cjs generate [--root <dir>] [--date YYYY-MM-DD] [--json]
 *   node forge-vault-map.cjs recall "<term>" [--root <dir>] [--limit N] [--json]
 *   node forge-vault-map.cjs add-note --title "<t>" --body "<text>" [--kind lesson|decision] [--links a,b] [--date D]
 *   node forge-vault-map.cjs check [--root <dir>]       dead links + secret patterns in map/
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATE = '2026-11-10';
const GEN_MARK = 'generated: forge-vault-map';
const CANVAS_RUN_LIMIT = 40;
const MEMORY_TAIL_LINES = 6;

// ---------- secret scrubbing ----------
const SECRET_RES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
];
const LONG_RE = /[A-Za-z0-9+/=_]{32,}/g;
function looksSecretRun(s) {
  if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return true;
  return /^[0-9a-fA-F]{32,}$/.test(s) && /[0-9]/.test(s) && /[a-fA-F]/.test(s);
}
// FB-BRAIN-F5: forge-store.redactText (URL passwords, key=value labels, every SECRET_PATTERNS shape) runs first, the
// local patterns stay as an extra layer. Fail closed like forge-vault.cjs when the store module cannot load.
let storeRedact = null;
try { const store = require('./forge-store.cjs'); if (typeof store.redactText === 'function') storeRedact = store.redactText; } catch { storeRedact = null; }
function scrub(text) {
  if (!storeRedact) return '[content unavailable: redaction module missing]';
  let t = storeRedact(String(text == null ? '' : text));
  for (const re of SECRET_RES) t = t.replace(re, '[REDACTED]');
  return t.replace(LONG_RE, (m) => (looksSecretRun(m) ? '[REDACTED]' : m));
}
function findSecrets(text) {
  const out = [];
  const t = String(text);
  for (const re of SECRET_RES) for (const m of t.matchAll(re)) out.push(m[0]);
  for (const m of t.matchAll(LONG_RE)) if (looksSecretRun(m[0])) out.push(m[0]);
  if (!storeRedact || redactChangesText(t)) out.push('[text that forge-store.redactText would mask]');
  return out;
}

// forge-store.redactText cuts its input at 50000 chars, so a plain compare on a longer file always "differs" and every
// long file read as secret (2026-11-13: the 85 KB Brain-Mindmap.canvas). Compare overlapping windows below the cap;
// the overlap keeps a secret that straddles a window edge inside one window.
const REDACT_WINDOW = 40000; const REDACT_OVERLAP = 2000;
function redactChangesText(t) {
  if (t.length <= REDACT_WINDOW) return storeRedact(t) !== t;
  for (let i = 0; i < t.length; i += REDACT_WINDOW - REDACT_OVERLAP) {
    const w = t.slice(i, i + REDACT_WINDOW);
    if (storeRedact(w) !== w) return true;
    if (i + REDACT_WINDOW >= t.length) break;
  }
  return false;
}

// ---------- small helpers ----------
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }
function listDirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; } }
function listFiles(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort(); } catch { return []; } }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'x'; }
function oneLine(s, n) { const t = scrub(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function q(s) { return JSON.stringify(String(s)); }
function rel(root, p) { return path.relative(root, p).split(path.sep).join('/'); }
function walk(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
function hex16(key) { // FNV-1a 64-bit, deterministic canvas ids
  let h = 0xcbf29ce484222325n;
  for (const ch of Buffer.from(String(key), 'utf8')) { h ^= BigInt(ch); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

function parseFrontmatter(text) {
  const out = {};
  if (!text || !text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  const lines = text.slice(3, end).split(/\r?\n/);
  let key = null; let mode = null;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      key = m[1]; const v = m[2].trim();
      if (v === '' ) { out[key] = []; mode = 'list'; }
      else if (v === '>' || v === '|' || v === '>-' || v === '|-') { out[key] = ''; mode = 'block'; }
      else { out[key] = v.replace(/^["']|["']$/g, ''); mode = null; }
      continue;
    }
    if (!key) continue;
    const li = line.match(/^\s*-\s+(.*)$/);
    if (mode === 'list' && li) { out[key].push(li[1].trim().replace(/^["']|["']$/g, '')); continue; }
    if (mode === 'block' && line.trim()) out[key] = (out[key] ? out[key] + ' ' : '') + line.trim();
    if (mode === 'list' && line.trim() && !li && Array.isArray(out[key]) && out[key].length === 0) { out[key] = line.trim(); mode = null; }
  }
  return out;
}

// ---------- collect the sources ----------
function collect(root) {
  const C = path.join(root, '.claude');
  const notes = new Map(); // key "kind/id" -> note record
  const add = (kind, id, rec) => { const k = `${kind}/${id}`; if (!notes.has(k)) notes.set(k, { kind, id, links: [], ...rec }); return notes.get(k); };

  // agents
  const registry = readJson(path.join(C, 'config/agents/agent-registry.json')) || {};
  const regAgents = registry.agents || {};
  const regSpec = Object.fromEntries(Object.entries(registry.specialistAgents || {}).filter(([k]) => !k.startsWith('_')));
  const agentFiles = listFiles(path.join(C, 'agents')).filter((f) => f.endsWith('.md'));
  const agentIds = new Set([...agentFiles.map((f) => f.replace(/\.md$/, '')), ...Object.keys(regAgents), ...Object.keys(regSpec)]);
  const routing = readJson(path.join(C, 'FORGE_MODEL_ROUTING.json')) || {};
  const routes = Object.fromEntries(Object.entries(routing.routes || {}).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object'));
  const defaults = routing.agentDefaults || {};
  const skillMap = (readJson(path.join(C, 'config/agents/agent-skill-map.json')) || {}).agents || {};

  for (const [r, v] of Object.entries(routes).sort()) {
    add('routes', slug(r), { title: `Route ${r}`, tags: ['route'], source: '.claude/FORGE_MODEL_ROUTING.json', props: { model: v.model || '', effort: v.effort || '' }, body: [`- model: ${v.model || '?'} · effort: ${v.effort || '?'}`, v.when ? `- when: ${oneLine(v.when, 400)}` : ''].filter(Boolean) });
  }

  // skills
  const skillsDir = path.join(C, 'skills');
  for (const d of listDirs(skillsDir)) {
    const p = path.join(skillsDir, d, 'SKILL.md');
    const t = readText(p); if (t == null) continue;
    const fm = parseFrontmatter(t);
    const desc = typeof fm.description === 'string' ? fm.description : '';
    const playbook = /^playbook\b/i.test(desc);
    add('skills', slug(d), { title: d, tags: ['skill', playbook ? 'playbook' : (d.startsWith('forge-') ? 'forge-skill' : 'vendored-skill')], source: rel(root, p), playbook, props: { origin: 'project' }, body: [`- description: ${oneLine(desc, 500) || '(none)'}`] });
  }
  const bundles = ((readJson(path.join(C, 'config/skills/global-skills.json')) || {}).bundles) || {};
  for (const [b, arr] of Object.entries(bundles).sort()) {
    for (const s of Array.isArray(arr) ? arr : []) {
      if (!s || typeof s.skill !== 'string') continue;
      const id = slug(s.skill);
      const ex = notes.get(`skills/${id}`);
      if (ex) { if (s.kind === 'forge-playbook' && !ex.playbook) { ex.playbook = true; ex.tags = ['skill', 'playbook']; } ex.bundles = [...new Set([...(ex.bundles || []), b])]; continue; }
      if (!/^ecc|plugin/.test(String(s.kind || ''))) continue; // only skills that exist somewhere real
      add('skills', id, { title: s.skill, tags: ['skill', 'ecc-skill'], source: '.claude/config/skills/global-skills.json', props: { origin: String(s.kind) }, bundles: [b], body: [`- kind: ${s.kind}`, s.fallback ? `- fallback: ${oneLine(s.fallback, 300)}` : ''].filter(Boolean) });
    }
  }
  for (const n of notes.values()) if (n.kind === 'skills' && n.bundles) n.body.push(`- project-type bundles: ${n.bundles.sort().join(', ')}`);

  // memory per agent
  const memRoot = path.join(C, 'agent-memory');
  const memIds = new Set();
  for (const d of listDirs(memRoot)) {
    const files = listFiles(path.join(memRoot, d));
    const memP = path.join(memRoot, d, 'MEMORY.md');
    const t = readText(memP);
    const lines = t == null ? [] : t.split(/\r?\n/);
    const lessonLines = lines.filter((l) => /^\s*-\s+\S/.test(l));
    const head = lines.find((l) => /^#\s/.test(l));
    const body = [
      t == null ? '- MEMORY.md: (not present)' : `- MEMORY.md: \`${rel(root, memP)}\` (${lines.length} lines, ${lessonLines.length} list items)`,
      `- files in folder: ${files.map((f) => '`' + oneLine(f, 80) + '`').join(', ') || '(none)'}`,
      head ? `- heading: ${oneLine(head.replace(/^#\s*/, ''), 160)}` : '',
      '', '## Newest lines (first list items, scrubbed, cut at 240 chars)',
      ...(lessonLines.slice(0, MEMORY_TAIL_LINES).map((l) => `- ${oneLine(l.replace(/^\s*-\s+/, ''), 240)}`)),
    ].filter((x) => x !== null);
    add('memory', slug(d), { title: `Memory ${d}`, tags: ['memory', 'agent-memory'], source: t == null ? rel(root, path.join(memRoot, d)) : rel(root, memP), agent: d, body });
    memIds.add(slug(d));
  }

  // agents (after skills + memory so links resolve)
  for (const id of [...agentIds].sort()) {
    const fileP = path.join(C, 'agents', `${id}.md`);
    const t = readText(fileP);
    const fm = t ? parseFrontmatter(t) : {};
    const reg = regAgents[id] || regSpec[id] || {};
    const isBoss = Object.prototype.hasOwnProperty.call(regAgents, id);
    const route = typeof defaults[id] === 'string' ? defaults[id] : null;
    const preload = Array.isArray(fm.skills) ? fm.skills : [];
    const core = Array.isArray(skillMap[id]) ? skillMap[id] : [];
    add('agents', slug(id), {
      title: reg.name || fm.name || id,
      tags: ['agent', isBoss ? 'boss' : 'specialist'],
      source: t ? rel(root, fileP) : '.claude/config/agents/agent-registry.json',
      isBoss, route, skills: [...new Set([...preload, ...core])].sort(), agent: id,
      props: { model: fm.model || '', effort: fm.effort || '' },
      body: [
        `- role: ${oneLine(reg.role || (isBoss ? 'Boss' : 'specialist'), 200)}`,
        `- model / effort (frontmatter): ${fm.model || '?'} / ${fm.effort || '?'}`,
        `- description: ${oneLine(fm.description || reg.responsibilities || '', 600) || '(none)'}`,
        preload.length ? `- preloaded skills (frontmatter): ${preload.join(', ')}` : '- preloaded skills (frontmatter): (none)',
        `- sources: ${t ? '`' + rel(root, fileP) + '`, ' : ''}\`.claude/config/agents/agent-registry.json\`, \`.claude/config/agents/agent-skill-map.json\``,
      ],
    });
  }

  // rules
  const claudeMd = readText(path.join(root, 'CLAUDE.md'));
  if (claudeMd) {
    const parts = claudeMd.split(/^## /m).slice(1);
    for (const part of parts) {
      const nl = part.indexOf('\n');
      const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
      const text = nl < 0 ? '' : part.slice(nl + 1);
      add('rules', 'claude-md-' + slug(heading), { title: heading, tags: ['rule', 'claude-md', /HARD|REQUIRED/.test(heading) ? 'hard-must' : 'standing'], source: 'CLAUDE.md', body: [`> [!info] From \`CLAUDE.md\`, section "${oneLine(heading, 120)}"`, '', oneLine(text, 1200)] });
    }
  }
  const hard = readJson(path.join(C, 'config/orchestration/FORGE_HARD_RULES.json')) || {};
  for (const r of [...(hard.rules || []), ...(hard.orchestration_hard_rules || [])]) {
    if (!r || !r.id) continue;
    add('rules', 'hard-' + slug(r.id), { title: `Hard rule ${r.id}`, tags: ['rule', 'hard-rule'], source: '.claude/config/orchestration/FORGE_HARD_RULES.json', body: [`- rule: ${oneLine(r.rule || r.text || '', 900)}`, r.severity ? `- severity: ${r.severity}` : '', r.phase ? `- phase: ${r.phase}` : ''].filter(Boolean) });
  }
  const standing = readJson(path.join(C, 'config/orchestration/FORGE_STANDING_RULES.json')) || {};
  for (const r of standing.rules || []) {
    if (!r || !r.id) continue;
    add('rules', 'standing-' + slug(r.id), { title: `Standing rule ${r.id}`, tags: ['rule', 'standing-rule'], source: '.claude/config/orchestration/FORGE_STANDING_RULES.json', body: [`- text: ${oneLine(r.text || r.rule || '', 900)}`, r.topic ? `- topic: ${r.topic}` : '', r.scope ? `- scope: ${r.scope}` : ''].filter(Boolean) });
  }

  // config settings
  const schema = readJson(path.join(C, 'config/orchestration/FORGE_CONFIG_SCHEMA.json')) || {};
  for (const [k, v] of Object.entries(schema.settings || {}).sort()) {
    if (k.startsWith('_') || !v || typeof v !== 'object') continue;
    const desc = v.desc && typeof v.desc === 'object' ? v.desc : {};
    add('config', slug(k.replace(/\./g, '_')), { title: `Setting ${k}`, tags: ['config', 'setting'], source: '.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json', body: [`- key: \`${k}\``, `- type: ${v.type || '?'} · default: ${oneLine(JSON.stringify(v.default), 120)} · group: ${v.group || '?'}`, desc.nl ? `- nl: ${oneLine(desc.nl, 500)}` : '', desc.en ? `- en: ${oneLine(desc.en, 500)}` : ''].filter(Boolean) });
  }

  // hooks + gates
  const settings = readJson(path.join(C, 'settings.json')) || {};
  const hookMap = new Map();
  for (const [ev, arr] of Object.entries(settings.hooks || {})) {
    for (const a of Array.isArray(arr) ? arr : []) for (const h of (a && a.hooks) || []) {
      const m = String(h.command || '').match(/([A-Za-z0-9_.-]+\.(?:c?js|mjs|ps1|sh|py))/);
      if (!m) continue;
      const k = m[1];
      if (!hookMap.has(k)) hookMap.set(k, []);
      hookMap.get(k).push(`${ev}${a.matcher ? ' (matcher `' + oneLine(a.matcher, 80) + '`)' : ''}`);
    }
  }
  for (const [script, evs] of [...hookMap.entries()].sort()) {
    add('hooks', slug(script.replace(/\.[a-z]+$/, '')), { title: `Hook ${script}`, tags: ['hook'], source: '.claude/settings.json', script, body: [`- script: \`.claude/forge-bin/${script}\``, ...[...new Set(evs)].sort().map((e) => `- event: ${e}`)] });
  }
  const COMMAND_GATES = new Set(['kill-by-name', 'destructive-delete', 'git-destructive', 'opaque-exec', 'secret-print', 'plugin-install-command', 'settings-edit-command', 'global-input-command']);
  const gatesCfg = readJson(path.join(C, 'config/orchestration/hard-gates.json')) || {};
  for (const g of gatesCfg.gates || []) {
    if (!g || !g.id) continue;
    const cmd = COMMAND_GATES.has(g.id);
    add('gates', slug(g.id), { title: `Gate ${g.id}`, tags: ['gate', cmd ? 'command-gate' : 'owner-gate'], source: '.claude/config/orchestration/hard-gates.json', commandGate: cmd, body: [`- class: ${g.class || '?'}`, `- kind: ${cmd ? 'command gate, enforced by the PreToolUse gate hook' : 'owner gate (classifier + prose; the owner decides)'}`, `- reason: ${oneLine(g.reason || '', 500)}`] });
  }

  // runs (header only)
  const runsDir = path.join(C, 'forge-runs');
  for (const d of listDirs(runsDir)) {
    if (d.startsWith('_') || !/^[A-Za-z0-9_-]+$/.test(d)) continue;
    const rj = readJson(path.join(runsDir, d, 'run.json'));
    const date = (d.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const body = rj ? [
      `- request: ${oneLine(rj.request || rj.mission || '', 300) || '(none)'}`,
      `- status: ${oneLine(rj.status || '?', 60)} · project type: ${oneLine(rj.project_type || '?', 60)}`,
    ] : ['- no run.json in this run folder (header = folder name only)'];
    const files = listFiles(path.join(runsDir, d));
    body.push(`- files: ${files.slice(0, 20).map((f) => '`' + oneLine(f, 60) + '`').join(', ')}${files.length > 20 ? ` (+${files.length - 20} more)` : ''}`);
    add('runs', slug(d), { title: `Run ${d}`, tags: ['run'], source: rel(root, path.join(runsDir, d, rj ? 'run.json' : '')), date, runId: d, body });
  }
  return notes;
}

// ---------- links + rendering ----------
function linkTo(n) { return `map/${n.kind}/${n.id}`; }
function buildLinks(notes, vault) {
  const get = (k) => notes.get(k);
  const link = (a, b, label) => { if (a && b && a !== b) { a.links.push({ to: linkTo(b), label }); b.backFrom = (b.backFrom || []).concat(linkTo(a)); } };
  for (const n of notes.values()) {
    if (n.kind === 'agents') {
      if (n.route) link(n, get(`routes/${slug(n.route)}`), 'route');
      for (const s of n.skills) link(n, get(`skills/${slug(s)}`), 'skill');
      link(n, get(`memory/${slug(n.agent)}`), 'memory');
      n.missingSkills = n.skills.filter((s) => !get(`skills/${slug(s)}`));
    }
    if (n.kind === 'memory') link(n, get(`agents/${slug(n.agent)}`), 'agent');
    if (n.kind === 'hooks' && n.script === 'forge-gate-hook.cjs') for (const g of notes.values()) if (g.kind === 'gates' && g.commandGate) link(n, g, 'enforces');
    if (n.kind === 'runs' && fs.existsSync(path.join(vault, 'runs', `${n.runId}.md`))) n.links.push({ to: `runs/${n.runId}`, label: 'run report note' });
  }
}

function renderNote(n, date) {
  const fm = ['---', `title: ${q(n.title)}`, `type: ${q(n.kind.replace(/s$/, ''))}`, `name: ${q(n.id)}`, `source: ${q(n.source)}`, `updated: ${q(date)}`];
  for (const [k, v] of Object.entries(n.props || {})) if (v) fm.push(`${k}: ${q(v)}`);
  fm.push('tags:', ...n.tags.map((t) => `  - ${slug(t)}`), GEN_MARK, '---', '');
  const body = [`# ${n.title}`, '', `Source: \`${n.source}\``, '', ...n.body.map(scrub)];
  if (n.missingSkills && n.missingSkills.length) body.push('', `> [!warning] Skills named for this agent without a skill note in this vault: ${n.missingSkills.join(', ')}`);
  const groups = {};
  for (const l of n.links) (groups[l.label] = groups[l.label] || []).push(l.to);
  if (Object.keys(groups).length) {
    body.push('', '## Links');
    for (const [label, arr] of Object.entries(groups).sort()) body.push(`- ${label}: ${[...new Set(arr)].sort().map((t) => `[[${t}]]`).join(', ')}`);
  }
  body.push('', 'Back to [[map/Map-Home]]', '');
  return fm.join('\n') + body.join('\n');
}

const KIND_LABEL = { agents: 'Agents (Bosses and specialists)', skills: 'Skills', routes: 'Routes', rules: 'Rules', config: 'Config settings', runs: 'Runs', memory: 'Memory per agent', hooks: 'Hooks', gates: 'Gates', notes: 'Lessons and decisions (add-note)' };
function renderHome(notes, addNotes, date) {
  const out = ['---', 'title: "Forge Map"', 'type: "index"', 'name: "map-home"', 'source: ".claude/forge-bin/forge-vault-map.cjs"', `updated: ${q(date)}`, 'tags:', '  - index', '  - map', GEN_MARK, '---', '',
    '# Forge Map', '', 'Generated mind map of the Forge system: every agent, skill, route, rule, setting, hook, gate, run and agent memory. Open `map/Forge-Mindmap.canvas` for the visual map; the run and decision notes of [[Home]] stay as they are.', ''];
  const byKind = {};
  for (const n of notes.values()) (byKind[n.kind] = byKind[n.kind] || []).push(n);
  if (addNotes.length) byKind.notes = addNotes;
  for (const k of Object.keys(KIND_LABEL)) {
    const arr = byKind[k]; if (!arr || !arr.length) continue;
    out.push(`## ${KIND_LABEL[k]} (${arr.length})`);
    for (const n of [...arr].sort((a, b) => (k === 'runs' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)))) out.push(`- [[${linkTo(n)}|${oneLine(n.title, 100)}]]`);
    out.push('');
  }
  return out.join('\n');
}

function renderCanvas(notes) {
  const nodes = []; const edges = []; const ids = new Map();
  const W = 260; const H = 60; const GAP = 20; const PAD = 40; const COLS = 4;
  const all = [...notes.values()];
  const sections = [
    ['Bosses & specialists', '6', all.filter((n) => n.kind === 'agents').sort((a, b) => (b.isBoss - a.isBoss) || a.id.localeCompare(b.id))],
    ['Routes', '5', all.filter((n) => n.kind === 'routes')],
    ['Skills', '4', all.filter((n) => n.kind === 'skills' && !n.playbook)],
    ['Playbooks', '3', all.filter((n) => n.kind === 'skills' && n.playbook)],
    ['Hooks/Gates', '1', all.filter((n) => n.kind === 'hooks' || (n.kind === 'gates' && n.commandGate))],
    ['Owner-poorten', '2', all.filter((n) => n.kind === 'gates' && !n.commandGate)],
    ['Rules', '5', all.filter((n) => n.kind === 'rules')],
    ['Memory per agent', '6', all.filter((n) => n.kind === 'memory')],
    ['Runs', '3', all.filter((n) => n.kind === 'runs').sort((a, b) => b.id.localeCompare(a.id)).slice(0, CANVAS_RUN_LIMIT)],
  ];
  const totalRuns = all.filter((n) => n.kind === 'runs').length;
  nodes.push({ id: hex16('center'), type: 'text', x: -400, y: -260, width: 360, height: 160, color: '6', text: `# Forge Mindmap\n\nGenerated by forge-vault-map.cjs. Index: [[map/Map-Home]]. Runs on this canvas: newest ${Math.min(CANVAS_RUN_LIMIT, totalRuns)} of ${totalRuns}.` });
  let x = 0; let y = 0; let rowH = 0; const ROW_W = 4 * (COLS * (W + GAP) + PAD * 2 + 80);
  for (const [label, color, items] of sections) {
    if (!items.length) continue;
    const cols = Math.min(COLS, items.length);
    const gw = cols * (W + GAP) - GAP + PAD * 2;
    const gh = Math.ceil(items.length / cols) * (H + GAP) - GAP + PAD * 2;
    if (x > 0 && x + gw > ROW_W) { x = 0; y += rowH + 120; rowH = 0; }
    nodes.push({ id: hex16('group:' + label), type: 'group', x, y, width: gw, height: gh, label: `${label} (${items.length})`, color });
    items.forEach((n, i) => {
      const id = hex16('node:' + linkTo(n)); ids.set(linkTo(n), id);
      nodes.push({ id, type: 'file', file: `${linkTo(n)}.md`, x: x + PAD + (i % cols) * (W + GAP), y: y + PAD + Math.floor(i / cols) * (H + GAP), width: W, height: H, ...(color ? {} : {}) });
    });
    x += gw + 80; rowH = Math.max(rowH, gh);
  }
  for (const n of all.filter((a) => a.kind === 'agents')) {
    const from = ids.get(linkTo(n)); if (!from) continue;
    for (const l of n.links) {
      if (l.label !== 'skill' && l.label !== 'route') continue;
      const to = ids.get(l.to); if (!to) continue;
      edges.push({ id: hex16(`edge:${from}:${to}`), fromNode: from, toNode: to, toEnd: 'arrow', label: l.label, ...(l.label === 'route' ? { color: '5' } : {}) });
    }
  }
  const gh = all.find((n) => n.kind === 'hooks' && n.script === 'forge-gate-hook.cjs');
  if (gh && ids.get(linkTo(gh))) for (const l of gh.links) { const to = ids.get(l.to); if (to) edges.push({ id: hex16(`edge:${ids.get(linkTo(gh))}:${to}`), fromNode: ids.get(linkTo(gh)), toNode: to, toEnd: 'arrow', label: 'enforces', color: '1' }); }
  return JSON.stringify({ nodes, edges }, null, 2) + '\n';
}

// ---------- add-note records ----------
function readAddNotes(vault) {
  const dir = path.join(vault, 'map', 'notes');
  return listFiles(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const fm = parseFrontmatter(readText(path.join(dir, f)) || '');
    return { kind: 'notes', id: f.replace(/\.md$/, ''), title: fm.title || f };
  });
}

function writeIfChanged(p, text, stats) {
  if (readText(p) === text) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  stats.written++;
}

function generate(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : DEFAULT_DATE;
  const vault = path.join(root, '.claude', 'forge-vault');
  const mapDir = path.join(vault, 'map');
  const notes = collect(root);
  buildLinks(notes, vault);
  const stats = { written: 0, removed: 0, counts: {} };
  const keep = new Set();
  for (const n of notes.values()) {
    const p = path.join(mapDir, n.kind, `${n.id}.md`);
    keep.add(p);
    writeIfChanged(p, renderNote(n, date), stats);
    stats.counts[n.kind] = (stats.counts[n.kind] || 0) + 1;
  }
  const home = path.join(mapDir, 'Map-Home.md'); keep.add(home);
  const addNotes = readAddNotes(vault);
  writeIfChanged(home, renderHome(notes, addNotes, date), stats);
  const canvasP = path.join(mapDir, 'Forge-Mindmap.canvas'); keep.add(canvasP);
  const canvasText = renderCanvas(notes);
  writeIfChanged(canvasP, canvasText, stats);
  const cv = JSON.parse(canvasText);
  stats.counts.canvasNodes = cv.nodes.length; stats.counts.canvasEdges = cv.edges.length; stats.counts.notes = addNotes.length;
  // stale generated notes: single-file unlink only, never outside map/, never notes/ or hand-written files
  for (const f of walk(mapDir)) {
    if (keep.has(f) || !f.endsWith('.md') || f.startsWith(path.join(mapDir, 'notes') + path.sep)) continue;
    const t = readText(f) || '';
    if (t.startsWith('---') && t.slice(0, t.indexOf('\n---', 3) + 1).includes('\n' + GEN_MARK + '\n')) { fs.unlinkSync(f); stats.removed++; }
  }
  return stats;
}

// ---------- checks ----------
function linksIn(text) { return [...String(text).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim()); }
function findDeadLinks(vault) {
  const dead = [];
  for (const f of walk(path.join(vault, 'map')).filter((x) => x.endsWith('.md'))) {
    for (const t of linksIn(readText(f))) if (!fs.existsSync(path.join(vault, t + '.md')) && !fs.existsSync(path.join(vault, t))) dead.push(`${rel(vault, f)} -> ${t}`);
  }
  const cv = readJson(path.join(vault, 'map', 'Forge-Mindmap.canvas'));
  if (cv) {
    for (const n of cv.nodes || []) if (n.type === 'file' && !fs.existsSync(path.join(vault, n.file))) dead.push(`canvas -> ${n.file}`);
    for (const n of cv.nodes || []) if (n.type === 'text') for (const t of linksIn(n.text)) if (!fs.existsSync(path.join(vault, t + '.md'))) dead.push(`canvas text -> ${t}`);
  }
  return dead;
}

// ---------- recall ----------
function recall(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const vault = path.join(root, '.claude', 'forge-vault');
  const terms = String(opts.query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const docs = walk(vault).filter((f) => f.endsWith('.md')).map((f) => {
    const text = readText(f) || ''; const r = rel(vault, f);
    const fm = parseFrontmatter(text);
    return { path: r, key: r.replace(/\.md$/, ''), title: fm.title || path.basename(f, '.md'), text, lower: text.toLowerCase(), links: linksIn(text) };
  });
  const back = {};
  for (const d of docs) for (const t of new Set(d.links)) (back[t] = back[t] || []).push(d.key);
  const hits = [];
  for (const d of docs) {
    let score = 0; let allFound = true;
    for (const t of terms) {
      const inTitle = d.title.toLowerCase().includes(t) || d.key.toLowerCase().includes(t);
      const count = d.lower.split(t).length - 1;
      if (!inTitle && !count) allFound = false;
      score += (inTitle ? 10 : 0) + Math.min(count, 20);
    }
    if (!score || !allFound) continue;
    if (d.key === 'map/Map-Home' || d.key === 'Home') score = Math.max(1, Math.floor(score / 10));
    const bodyText = d.text.replace(/^---[\s\S]*?\n---\r?\n/, '');
    const at = bodyText.toLowerCase().indexOf(terms[0]);
    const excerpt = at < 0 ? oneLine(bodyText, 200) : oneLine(bodyText.slice(Math.max(0, at - 80), at + 160), 240);
    hits.push({ title: d.title, path: d.path, score, excerpt, backlinks: (back[d.key] || []).filter((k) => k !== d.key).sort() });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, Number(opts.limit) > 0 ? Number(opts.limit) : 8);
}

// ---------- add-note ----------
function addNote(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const vault = path.join(root, '.claude', 'forge-vault');
  const title = oneLine(opts.title || '', 120);
  if (!title) throw new Error('add-note needs --title');
  const kind = opts.kind === 'decision' ? 'decision' : 'lesson';
  // FB-BRAIN-F6: a note is dated today unless --date is given (only generate() needs the fixed date for byte-stability).
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : new Date().toISOString().slice(0, 10);
  const links = (Array.isArray(opts.links) ? opts.links : String(opts.links || '').split(',')).map((s) => s.trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '')).filter(Boolean);
  const kept = links.filter((l) => fs.existsSync(path.join(vault, l + '.md')));
  const dropped = links.filter((l) => !kept.includes(l));
  const text = ['---', `title: ${q(title)}`, `type: ${q(kind)}`, `name: ${q(slug(title))}`, `source: ${q('add-note')}`, `updated: ${q(date)}`, 'tags:', `  - ${kind}`, '  - add-note', '---', '',
    `# ${title}`, '', `> [!${kind === 'decision' ? 'important' : 'tip'}] ${kind}`, ...scrub(String(opts.body || '')).split(/\r?\n/).map((l) => `> ${l}`), '',
    ...(kept.length ? ['## Links', ...kept.sort().map((l) => `- [[${l}]]`), ''] : []), 'Back to [[map/Map-Home]]', ''].join('\n');
  // A note with the same date and title but other content is never overwritten: it gets a -2, -3 ... suffix.
  let relP = `map/notes/${date}-${slug(title)}.md`;
  for (let n = 2; ; n++) {
    const cur = readText(path.join(vault, relP));
    if (cur == null || cur === text) break;
    relP = `map/notes/${date}-${slug(title)}-${n}.md`;
  }
  const p = path.join(vault, relP);
  const st = { written: 0 };
  writeIfChanged(p, text, st);
  if (st.written) { // keep the index in step without a full regenerate when the map exists
    const home = path.join(vault, 'map', 'Map-Home.md');
    if (fs.existsSync(home)) generate({ root, date: opts.date });
  }
  return { path: relP, written: st.written > 0, droppedLinks: dropped };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } else o._.push(a);
  }
  return o;
}
function main(argv) {
  const a = parseArgs(argv); const cmd = a._[0];
  const root = a.root ? path.resolve(a.root) : DEFAULT_ROOT;
  const out = (obj, txt) => process.stdout.write((a.json ? JSON.stringify(obj, null, 2) : txt) + '\n');
  if (cmd === 'generate') { const s = generate({ root, date: a.date }); out(s, `forge-vault-map: written ${s.written}, removed ${s.removed}; ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`); return 0; }
  if (cmd === 'recall') {
    const hits = recall({ root, query: a._.slice(1).join(' '), limit: a.limit });
    out(hits, hits.length ? hits.map((h, i) => `${i + 1}. ${h.title}  (${h.path}, score ${h.score})\n   ${h.excerpt}\n   backlinks: ${h.backlinks.slice(0, 8).join(', ') || '(none)'}${h.backlinks.length > 8 ? ` (+${h.backlinks.length - 8})` : ''}`).join('\n') : 'no notes found');
    return 0;
  }
  if (cmd === 'add-note') { const r = addNote({ root, title: a.title, body: a.body, kind: a.kind, links: a.links, date: a.date }); out(r, `${r.written ? 'wrote' : 'unchanged'} ${r.path}${r.droppedLinks.length ? `; dropped unknown links: ${r.droppedLinks.join(', ')}` : ''}`); return 0; }
  if (cmd === 'check') {
    const vault = path.join(root, '.claude', 'forge-vault');
    const dead = findDeadLinks(vault);
    const secrets = walk(path.join(vault, 'map')).filter((f) => findSecrets(readText(f) || '').length).map((f) => rel(vault, f));
    out({ dead, secrets }, `dead links: ${dead.length}${dead.length ? '\n  ' + dead.slice(0, 20).join('\n  ') : ''}\nfiles with secret-like text: ${secrets.length}${secrets.length ? '\n  ' + secrets.join('\n  ') : ''}`);
    return dead.length || secrets.length ? 1 : 0;
  }
  process.stderr.write('usage: forge-vault-map.cjs generate|recall "<term>"|add-note --title T --body B|check [--root DIR] [--date YYYY-MM-DD] [--json]\n');
  return 2;
}

module.exports = { generate, recall, addNote, findDeadLinks, findSecrets, scrub, parseFrontmatter, DEFAULT_DATE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
