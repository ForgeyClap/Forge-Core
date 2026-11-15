#!/usr/bin/env node
'use strict';
/**
 * forge-brain.cjs — every project's Obsidian memory, fed into ONE central brain (owner ask R-0234).
 * Zero-dependency (fs, path, os, crypto). Reuses forge-vault-map.cjs for the per-project map and its scrub().
 *
 * PER PROJECT (`project --root <dir>`): refreshes the project's own vault map (forge-vault-map generate) and writes
 *   <root>/.claude/forge-vault/brain/Project-Digest.md: name, type, profile summary, the last 10 runs (id, goal,
 *   status), decisions, per-agent lessons (newest lines), skills and agents used, open owner asks.
 * CENTRAL (`sync`): discovers the Forge projects on this machine (the installer registry ~/.claude/forge/projects.json
 *   when present, else one level under Documents, Desktop and the home folder) and writes into the brain folder
 *   (FORGE_BRAIN_PATH, else the owner setting brain-path, else <home>/Documents/Forge-Brain; a brain-path folder that
 *   does not exist is refused, nothing is written):
 *   Brain-Home.md · projects/<slug>/{Project,Runs,Decisions,Lessons}.md · skills/<skill>.md · agents/<agent>.md ·
 *   lessons/<agent>.md (lessons deduped across projects) · Brain-Mindmap.canvas (JSON Canvas 1.0) · brain-state.json.
 *
 * RULES: sync only READS other projects (never writes there); only named Forge files are read and a file whose name
 * looks like a secret (.env, keys, credentials) is refused; every free text passes scrub(); a note is written only
 * when its bytes change (brain-state.json, the sync receipt, is the one exception); a generated note whose source is
 * gone is removed with a single-file unlink; every wikilink points at a note in the output set and check() proves it.
 *
 * CLI:
 *   node forge-brain.cjs project --root <dir> [--date YYYY-MM-DD] [--sync] [--json]
 *   node forge-brain.cjs sync [--brain <dir>] [--json]
 *   node forge-brain.cjs check [--brain <dir>] [--json]          dead links + secret patterns; exit 1 on a finding
 *   node forge-brain.cjs hook --root <dir>                         run close / start: project + sync at most every 6 h
 *   node forge-brain.cjs wired [--root <dir>] [--json]             the doctor's brain_wired check
 * Off switch: FORGE_BRAIN=off.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const MAP = require('./forge-vault-map.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const GEN_MARK = 'generated: forge-brain';
const RUN_LIMIT = 10;
const DECISION_LIMIT = 10;
const LESSONS_PER_AGENT = 5;
const STALE_DAYS = 7;
const SYNC_EVERY_MS = 6 * 3600 * 1000;
const MAX_EVENTS_BYTES = 30 * 1024 * 1024;
const CLOSED_ASKS = new Set(['acked', 'answered', 'cancelled', 'superseded', 'done', 'deferred']);
const NOT_AGENTS = new Set(['orchestrator', 'system', 'owner', 'user', 'hook', 'unknown', 'main', 'claude', 'x']);
const EXCLUDED_NAME = /^(node_modules|AppData|forge-backups.*|forge-e2e.*|\..*)$/i;
const TEST_NAME = /(^|[^a-z])(test|tests|stress|e2e|sandbox)([^a-z]|$)/i;
const SECRET_NAME = /^\.env|\.(pem|key|p12|pfx)$|credential|id_rsa|secret/i;

const scrub = MAP.scrub;
let CONFIG; // forge-config.cjs, a soft sibling loaded once
function configModule() { if (CONFIG === undefined) { try { CONFIG = require('./forge-config.cjs'); } catch { CONFIG = null; } } return CONFIG; }
/** brainLocation(env, opts) -> {path, source}: FORGE_BRAIN_PATH ('env'), else the owner setting brain-path, an absolute
 *  folder ('setting'), else <home>/Documents/Forge-Brain ('default'). A setting that cannot be read falls back silently.
 *  Seam: opts.config replaces forge-config.cjs; env.FORGE_CONFIG_HOME picks the config home. */
function brainLocation(env, opts = {}) {
  const e = env || process.env;
  if (e.FORGE_BRAIN_PATH) return { path: path.resolve(e.FORGE_BRAIN_PATH), source: 'env' };
  let v = '';
  try { const cfg = opts.config || configModule(); if (cfg) v = cfg.safeGet('brain-path', { projectRoot: DEFAULT_ROOT, configHome: e.FORGE_CONFIG_HOME || undefined, fallback: '' }).value; } catch { v = ''; }
  if (typeof v === 'string' && v.trim() && path.isAbsolute(v.trim())) return { path: path.resolve(v.trim()), source: 'setting' };
  return { path: path.join(os.homedir(), 'Documents', 'Forge-Brain'), source: 'default' };
}
function brainPath(env, opts) { return brainLocation(env, opts).path; }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
// the owner's vault is used as given: Forge never creates it (no mkdir of a drive root or a missing drive)
function missingVault(loc) { return loc.source === 'setting' && !isDir(loc.path) ? `the brain folder ${loc.path} (setting brain-path) does not exist` : null; }
function locate(opts) { return opts.brain ? { path: path.resolve(opts.brain), source: 'flag' } : brainLocation(opts.env, opts); }
function isGenerated(t) { return t.startsWith('---') && t.slice(0, t.indexOf('\n---', 3) + 1).includes('\n' + GEN_MARK + '\n'); }

// ---------- small helpers ----------
function readText(p) {
  if (SECRET_NAME.test(path.basename(p))) return null; // never open a secret-looking file
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function readJson(p) { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }
function dirents(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function listDirs(p) { return dirents(p).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'x'; }
// harvested text keeps its words but loses its links: a markdown or wiki link from another vault would dangle here
function oneLine(s, n) { const t = scrub(String(s == null ? '' : s)).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function alias(s) { return oneLine(s, 80).replace(/[[\]|#]/g, ' ').trim() || 'x'; }
function q(s) { return JSON.stringify(String(s)); }
function walk(dir, out = []) { for (const e of dirents(dir)) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }
function relTo(base, p) { return path.relative(base, p).split(path.sep).join('/'); }
function id16(k) { return crypto.createHash('sha1').update(String(k)).digest('hex').slice(0, 16); }
function today() { return new Date().toISOString().slice(0, 10); }
function writeIfChanged(p, text, stats) {
  let cur = null; try { cur = fs.readFileSync(p, 'utf8'); } catch { cur = null; }
  if (cur === text) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  stats.written++;
}
function isForgeProject(dir) {
  try { return fs.existsSync(path.join(dir, '.claude', 'FORGE_VERSION.json')) || fs.statSync(path.join(dir, '.claude', 'forge-runs')).isDirectory(); } catch { return false; }
}
function canon(p) { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch { /* keep */ } return process.platform === 'win32' ? r.toLowerCase() : r; }

// ---------- harvest one project (read-only) ----------
function readEvents(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (st.size > MAX_EVENTS_BYTES) return [];
  const t = readText(file); if (t == null) return null;
  const out = [];
  for (const line of t.split(/\r?\n/)) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch { /* a torn line is skipped */ } }
  return out;
}
function skillTokens(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return raw.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9:_.-]{1,80}$/.test(s));
}
function agentToken(v) {
  if (typeof v !== 'string') return null;
  const s = slug(v).replace(/-wp\d+$/, ''); // a lane label (ui-boss-wp05) is the same agent
  if (s.length > 48 || NOT_AGENTS.has(s) || s.startsWith('lead')) return null;
  return s;
}
function harvestRuns(root) {
  const runsDir = path.join(root, '.claude', 'forge-runs');
  const runs = []; const skills = new Map(); const agents = new Map();
  for (const d of listDirs(runsDir)) {
    if (d.startsWith('_') || !/^[A-Za-z0-9_.-]+$/.test(d)) continue;
    const dir = path.join(runsDir, d);
    const evs = readEvents(path.join(dir, 'events.jsonl')) || [];
    const rj = readJson(path.join(dir, 'run.json'));
    const start = evs.find((e) => e.event_type === 'run_started');
    if (!start && !rj) continue; // not a real run
    let status = 'open';
    for (const e of evs) {
      if (e.event_type === 'run_started' || e.event_type === 'run_resumed') status = 'open';
      else if (e.event_type === 'run_paused') status = 'paused';
      else if (e.event_type === 'run_completed') status = 'completed';
      else if (e.event_type === 'run_finalized') status = 'finalized';
    }
    if (fs.existsSync(path.join(dir, 'run-finalized.json'))) status = 'finalized';
    const stamp = (evs.find((e) => typeof e.timestamp === 'string') || {}).timestamp || '';
    const date = (d.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || stamp.slice(0, 10);
    const goal = oneLine((start && (start.goal || start.request || start.task)) || (rj && (rj.request || rj.mission)) || '', 160);
    const usedS = new Set(); const usedA = new Set();
    for (const e of evs) {
      for (const k of ['skill', 'skills', 'skills_opened', 'skills_used']) for (const s of skillTokens(e[k])) usedS.add(s);
      const a = agentToken(e.agent); if (a) usedA.add(a);
    }
    for (const s of usedS) skills.set(s, (skills.get(s) || 0) + 1);
    for (const a of usedA) agents.set(a, (agents.get(a) || 0) + 1);
    runs.push({ id: d, date, goal, status });
  }
  runs.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return { runs, skills, agents };
}
function harvestProfile(root) {
  const t = readText(path.join(root, '.claude', 'FORGE_PROJECT_PROFILE.md')) || '';
  const m = t.match(/\*{0,2}Project type:\*{0,2}\s*(.+)$/im);
  const type = m ? oneLine(m[1].replace(/\*+/g, '').split(/\.\s/)[0].replace(/\.$/, ''), 60) : '';
  const summary = t.split(/\r?\n/).filter((l) => /^\s*-\s+.*(Project name|Stack|Maturity|Deployment)/i.test(l)).slice(0, 5)
    .map((l) => oneLine(l.replace(/^\s*-\s+/, '').replace(/\*+/g, ''), 240));
  return { type: type.startsWith('<') ? '' : type, summary }; // '<website | landing | ...>' is the unfilled template
}
function harvestDecisions(root) {
  const t = readText(path.join(root, '.claude', 'FORGE_DECISIONS.md')) || '';
  const rows = [];
  for (const line of t.split(/\r?\n/)) {
    if (!/^\|/.test(line) || /^\|\s*:?-/.test(line)) continue;
    const c = line.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 2 || /^decision$/i.test(c[1])) continue;
    rows.push({ date: oneLine(c[0], 30), decision: oneLine(c[1], 200), reason: oneLine(c[2] || '', 200) });
  }
  return rows.slice(-DECISION_LIMIT);
}
function harvestLessons(root) {
  const memRoot = path.join(root, '.claude', 'agent-memory');
  const out = {};
  for (const d of listDirs(memRoot)) {
    const t = readText(path.join(memRoot, d, 'MEMORY.md')); if (t == null) continue;
    const items = t.split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l) || /^\d{4}-\d{2}-\d{2}\b/.test(l)).map((l) => oneLine(l.replace(/^\s*-\s+/, ''), 220));
    if (items.length) out[slug(d)] = items.slice(-LESSONS_PER_AGENT);
  }
  return out;
}
function harvestAsks(root) {
  const s = readJson(path.join(root, '.claude', 'forge-scribe', 'state.json'));
  const items = s && (Array.isArray(s.items) ? s.items : s.items && typeof s.items === 'object' ? Object.values(s.items) : null);
  if (!items) return null;
  return items.filter((i) => i && !CLOSED_ASKS.has(String(i.status))).length;
}
function harvest(root) {
  root = path.resolve(root);
  const p = harvestProfile(root);
  const r = harvestRuns(root);
  return {
    name: oneLine(path.basename(root), 80), root, type: p.type || 'unknown', profile: p.summary,
    runCount: r.runs.length, runs: r.runs.slice(0, RUN_LIMIT), decisions: harvestDecisions(root), lessons: harvestLessons(root),
    openAsks: harvestAsks(root), skills: [...r.skills.keys()].sort(), agents: [...r.agents.keys()].sort(),
    skillRuns: Object.fromEntries(r.skills), agentRuns: Object.fromEntries(r.agents),
  };
}

// ---------- rendering helpers ----------
function front(fields, tags) {
  const fm = ['---'];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') fm.push(`${k}: ${q(v)}`);
  fm.push('tags:', ...tags.map((t) => `  - ${slug(t)}`), GEN_MARK, '---', '');
  return fm.join('\n');
}
function runLine(r) { return `- ${r.date || '????-??-??'} · \`${r.id}\` · ${r.status}${r.goal ? ' · ' + r.goal : ''}`; }
function decisionLine(d) { return `- ${d.date} · ${d.decision}${d.reason ? ' (' + d.reason + ')' : ''}`; }

// ---------- per project ----------
function renderDigest(d, root, date) {
  const vault = path.join(root, '.claude', 'forge-vault');
  const runLink = (r) => (fs.existsSync(path.join(vault, 'runs', r.id + '.md')) ? `${runLine(r)} · [[runs/${r.id}]]` : runLine(r));
  const out = [front({ title: d.name + ' digest', type: 'project-digest', project_type: d.type, updated: date }, ['project', 'brain']),
    `# ${d.name}`, '', `- Type: ${d.type}`, ...d.profile.map((l) => `- ${l}`),
    `- Runs: ${d.runCount}`, `- Open owner asks: ${d.openAsks == null ? 'unknown (no scribe state)' : d.openAsks}`,
    `- Central brain: \`${brainPath()}\` (run \`node .claude/forge-bin/forge-brain.cjs sync\`)`, '',
    `## Last ${Math.min(RUN_LIMIT, d.runs.length)} runs`, ...(d.runs.length ? d.runs.map(runLink) : ['- (none)']), '',
    '## Decisions', ...(d.decisions.length ? d.decisions.map(decisionLine) : ['- (none in FORGE_DECISIONS.md)']), '',
    '## Lessons per agent (newest lines)'];
  for (const [a, items] of Object.entries(d.lessons).sort()) out.push('', `### ${a}`, ...items.map((l) => `- ${l}`));
  out.push('', '## Skills used in runs', d.skills.length ? d.skills.join(', ') : '(none recorded)', '', '## Agents used in runs', d.agents.length ? d.agents.join(', ') : '(none recorded)', '');
  if (fs.existsSync(path.join(vault, 'map', 'Map-Home.md'))) out.push('Map: [[map/Map-Home]]', '');
  return out.join('\n');
}
function project(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : today();
  const map = MAP.generate(opts.date ? { root, date } : { root }); // the map keeps its own fixed date unless one is given, so it stays byte-stable
  const stats = { written: map.written };
  const p = path.join(root, '.claude', 'forge-vault', 'brain', 'Project-Digest.md');
  writeIfChanged(p, renderDigest(harvest(root), root, date), stats);
  return { written: stats.written, digest: relTo(root, p), map: { written: map.written, removed: map.removed } };
}

// ---------- discovery ----------
function discover(opts = {}) {
  const home = os.homedir();
  const registryFile = opts.registryFile || path.join(home, '.claude', 'forge', 'projects.json');
  const brain = canon(opts.brain || brainPath());
  const seen = new Set(); const projects = []; const skipped = [];
  const take = (dir) => { const c = canon(dir); if (seen.has(c) || c === brain) return; seen.add(c); projects.push({ root: path.resolve(dir), runs: harvestRuns(dir).runs.length }); };
  const reg = fs.existsSync(registryFile) ? readJson(registryFile) : null;
  if (reg && Array.isArray(reg.projects)) {
    for (const p of reg.projects) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || /^\\\\/.test(p)) { skipped.push({ path: String(p), reason: 'registry entry is not a local absolute path' }); continue; }
      if (!isForgeProject(p)) { skipped.push({ path: p, reason: 'not a Forge project (no FORGE_VERSION.json or forge-runs)' }); continue; }
      take(p);
    }
    return { source: 'registry', projects, skipped };
  }
  const roots = opts.scanRoots || [path.join(home, 'Documents'), path.join(home, 'Desktop'), home];
  for (const r of roots) {
    for (const e of dirents(r).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const dir = path.join(r, e.name);
      let link = false; try { link = fs.lstatSync(dir).isSymbolicLink(); } catch { link = true; }
      if (link || !isForgeProject(dir)) continue;
      if (EXCLUDED_NAME.test(e.name)) { skipped.push({ path: dir, reason: 'excluded name (backups, e2e, node_modules or hidden)' }); continue; }
      if (TEST_NAME.test(e.name) && harvestRuns(dir).runs.length === 0) { skipped.push({ path: dir, reason: 'test or stress folder without real runs' }); continue; }
      take(dir);
    }
  }
  return { source: 'scan', projects, skipped };
}

// ---------- central brain ----------
function renderCentral(digests) {
  const files = new Map(); // rel path (no .md) -> text
  const P = (d) => `projects/${d.slug}/Project`;
  const pl = (d) => `[[${P(d)}|${alias(d.name)}]]`;
  const skills = new Map(); const agents = new Map(); const lessons = new Map(); // agent -> Map(key -> {text, uses[]})
  for (const d of digests) {
    for (const s of d.skills) (skills.get(s) || skills.set(s, []).get(s)).push(d);
    for (const a of d.agents) (agents.get(a) || agents.set(a, []).get(a)).push(d);
    for (const [a, items] of Object.entries(d.lessons)) {
      const m = lessons.get(a) || lessons.set(a, new Map()).get(a);
      for (const raw of items) {
        const date = (raw.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
        const text = raw.replace(/^\d{4}-\d{2}-\d{2}\s*/, '');
        const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 140);
        if (!key) continue;
        const rec = m.get(key) || m.set(key, { text, uses: [] }).get(key);
        if (!rec.uses.some((u) => u.d === d)) rec.uses.push({ d, date });
      }
    }
  }
  const back = '\nBack to [[Brain-Home]]\n';
  for (const d of digests) {
    const base = `projects/${d.slug}`;
    const lessonAgents = Object.keys(d.lessons).sort();
    files.set(P(d), [front({ title: d.name, type: 'project', project_type: d.type, folder: d.root, runs: String(d.runCount), open_asks: d.openAsks == null ? 'unknown' : String(d.openAsks) }, ['project', d.type]),
      `# ${d.name}`, '', `- Type: ${d.type}`, ...d.profile.map((l) => `- ${l}`), `- Folder: \`${d.root}\``, `- Runs: ${d.runCount}${d.runs[0] ? ` (newest ${d.runs[0].date}: ${d.runs[0].goal || d.runs[0].id})` : ''}`,
      `- Open owner asks: ${d.openAsks == null ? 'unknown' : d.openAsks}`, `- Own vault digest: \`.claude/forge-vault/brain/Project-Digest.md\` in the project folder`, '',
      '## Digests', `- [[${base}/Runs|Runs]] · [[${base}/Decisions|Decisions]] · [[${base}/Lessons|Lessons]]`, '',
      '## Skills used', d.skills.length ? d.skills.map((s) => `[[skills/${slug(s)}|${alias(s)}]]`).join(', ') : '(none recorded)', '',
      '## Agents used', d.agents.length ? d.agents.map((a) => `[[agents/${a}|${alias(a)}]]`).join(', ') : '(none recorded)', '',
      '## Lessons', lessonAgents.length ? lessonAgents.map((a) => `[[lessons/${a}|${alias(a)}]]`).join(', ') : '(none)', back].join('\n'));
    files.set(`${base}/Runs`, [front({ title: d.name + ' runs', type: 'runs' }, ['runs']), `# Runs of ${pl(d)}`, '', `Runs in total: ${d.runCount}. Newest ${d.runs.length}:`, '', ...(d.runs.length ? d.runs.map(runLine) : ['- (none)']), back].join('\n'));
    files.set(`${base}/Decisions`, [front({ title: d.name + ' decisions', type: 'decisions' }, ['decisions']), `# Decisions of ${pl(d)}`, '', 'From `.claude/FORGE_DECISIONS.md` (newest last):', '', ...(d.decisions.length ? d.decisions.map(decisionLine) : ['- (none)']), back].join('\n'));
    const ll = [front({ title: d.name + ' lessons', type: 'lessons' }, ['lessons']), `# Lessons of ${pl(d)}`, '', 'Newest lines of `.claude/agent-memory/<agent>/MEMORY.md`.'];
    for (const a of lessonAgents) ll.push('', `## [[lessons/${a}|${alias(a)}]]`, ...d.lessons[a].map((l) => `- ${l}`));
    if (!lessonAgents.length) ll.push('', '- (none)');
    files.set(`${base}/Lessons`, ll.join('\n') + '\n' + back);
  }
  const usage = (kind, name, list, counts) => [front({ title: name, type: kind }, [kind]), `# ${kind === 'skill' ? 'Skill' : 'Agent'} ${name}`, '',
    `Used in runs of ${list.length} project(s):`, '', ...list.map((d) => `- ${pl(d)} (${counts(d)} run(s))`), back].join('\n');
  for (const [s, list] of skills) files.set(`skills/${slug(s)}`, usage('skill', oneLine(s, 80), list, (d) => d.skillRuns[s] || 0));
  for (const [a, list] of agents) files.set(`agents/${a}`, usage('agent', a, list, (d) => d.agentRuns[a] || 0));
  for (const [a, m] of lessons) {
    const recs = [...m.values()].sort((x, y) => (y.uses.length - x.uses.length) || x.text.localeCompare(y.text));
    files.set(`lessons/${a}`, [front({ title: 'Lessons ' + a, type: 'lessons' }, ['lessons', 'cross-project']), `# Lessons of ${a} across projects`, '',
      `Source: \`.claude/agent-memory/${a}/MEMORY.md\` of each project (newest ${LESSONS_PER_AGENT} lines each, deduped).`, '',
      ...recs.map((r) => `- ${r.text} — ${r.uses.length > 1 ? `shared by ${r.uses.length} projects: ` : ''}${r.uses.map((u) => pl(u.d) + (u.date ? ` (${u.date})` : '')).join(', ')}`),
      agents.has(a) ? `\nAgent note: [[agents/${a}]]` : '', back].join('\n'));
  }
  const home = [front({ title: 'Forge Brain', type: 'index' }, ['index', 'brain']), '# Forge Brain', '',
    'One mind map of every Forge project on this machine: what ran, what was decided, which skills and agents were used and what was learned. Open `Brain-Mindmap.canvas` for the visual map. The last sync time is in `brain-state.json`.', '',
    `## Projects (${digests.length})`, ...digests.map((d) => `- ${pl(d)} · ${d.type} · ${d.runCount} run(s)${d.openAsks ? ` · ${d.openAsks} open ask(s)` : ''}`), '',
    `## Skills (${skills.size})`, [...skills.keys()].sort().map((s) => `[[skills/${slug(s)}|${alias(s)}]]`).join(', ') || '(none)', '',
    `## Agents (${agents.size})`, [...agents.keys()].sort().map((a) => `[[agents/${a}|${alias(a)}]]`).join(', ') || '(none)', '',
    `## Lessons (${lessons.size})`, [...lessons.keys()].sort().map((a) => `[[lessons/${a}|${alias(a)}]]`).join(', ') || '(none)', ''].join('\n');
  files.set('Brain-Home', home);
  return { files, skills, agents, lessons };
}
function renderCanvas(digests, c) {
  const W = 260; const H = 60; const GAP = 20; const PAD = 40; const COLS = 4;
  const nodes = [{ id: id16('center'), type: 'text', x: -420, y: -240, width: 360, height: 140, color: '6', text: `# Forge Brain\n\n${digests.length} projects. Index: [[Brain-Home]]` }];
  const edges = []; const ids = new Map();
  const sections = [
    ['Projects', '6', digests.map((d) => `projects/${d.slug}/Project`)],
    ['Skills', '4', [...c.skills.keys()].sort().map((s) => `skills/${slug(s)}`)],
    ['Agents', '5', [...c.agents.keys()].sort().map((a) => `agents/${a}`)],
    ['Lessons', '3', [...c.lessons.keys()].sort().map((a) => `lessons/${a}`)],
  ];
  let x = 0;
  for (const [label, color, items] of sections) {
    if (!items.length) continue;
    const cols = Math.min(COLS, items.length);
    const gw = cols * (W + GAP) - GAP + PAD * 2; const gh = Math.ceil(items.length / cols) * (H + GAP) - GAP + PAD * 2;
    nodes.push({ id: id16('group:' + label), type: 'group', x, y: 0, width: gw, height: gh, label: `${label} (${items.length})`, color });
    items.forEach((k, i) => { const id = id16('node:' + k); ids.set(k, id); nodes.push({ id, type: 'file', file: k + '.md', x: x + PAD + (i % cols) * (W + GAP), y: PAD + Math.floor(i / cols) * (H + GAP), width: W, height: H }); });
    x += gw + 120;
  }
  for (const d of digests) {
    const from = ids.get(`projects/${d.slug}/Project`);
    const to = [...d.skills.map((s) => [`skills/${slug(s)}`, 'skill', '4']), ...d.agents.map((a) => [`agents/${a}`, 'agent', '5']), ...Object.keys(d.lessons).map((a) => [`lessons/${a}`, 'lesson', '3'])];
    for (const [k, label, color] of to) { const t = ids.get(k); if (from && t) edges.push({ id: id16(`edge:${from}:${t}`), fromNode: from, toNode: t, toEnd: 'arrow', label, color }); }
  }
  return JSON.stringify({ nodes, edges }, null, 2) + '\n';
}
function sync(opts = {}) {
  const loc = locate(opts); const brain = loc.path;
  const missing = missingVault(loc);
  if (missing) return { brain, location: loc.source, source: null, refused: `forge-brain sync: ${missing}; nothing written. Create it, or change it: node .claude/forge-bin/forge-config.cjs set brain-path <folder>`, projects: [], skipped: [], notes: 0, skills: 0, agents: 0, lessons: 0, written: 0, removed: 0, kept: [] };
  const found = discover({ scanRoots: opts.scanRoots, registryFile: opts.registryFile, brain });
  const used = new Set();
  const digests = found.projects.map((p) => {
    const d = harvest(p.root);
    let s = slug(d.name);
    if (used.has(s)) s = slug(d.name + '-' + path.basename(path.dirname(p.root)));
    for (let i = 2; used.has(s); i++) s = slug(d.name) + '-' + i;
    used.add(s); d.slug = s; return d;
  }).sort((a, b) => a.name.localeCompare(b.name));
  const c = renderCentral(digests);
  const stats = { written: 0, removed: 0 };
  const keep = new Set(); const kept = [];
  for (const [k, text] of c.files) { // a note of the owner at a generated path is kept, never overwritten
    const p = path.join(brain, k + '.md'); keep.add(p);
    const cur = readText(p); if (cur != null && !isGenerated(cur)) { kept.push(k + '.md'); continue; }
    writeIfChanged(p, text, stats);
  }
  writeIfChanged(path.join(brain, 'Brain-Mindmap.canvas'), renderCanvas(digests, c), stats);
  for (const f of walk(brain)) { // stale generated notes: single-file unlink, only our own marked notes
    if (keep.has(f) || !f.endsWith('.md')) continue;
    if (isGenerated(readText(f) || '')) { fs.unlinkSync(f); stats.removed++; }
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const state = { schema: 1, lastSync: now.toISOString(), source: found.source, projects: digests.length, notes: c.files.size, skipped: found.skipped.length };
  fs.mkdirSync(brain, { recursive: true });
  fs.writeFileSync(path.join(brain, 'brain-state.json'), JSON.stringify(state, null, 2) + '\n');
  return { brain, location: loc.source, source: found.source, projects: digests.map((d) => ({ name: d.name, slug: d.slug, root: d.root, runs: d.runCount })), skipped: found.skipped, notes: c.files.size, skills: c.skills.size, agents: c.agents.size, lessons: c.lessons.size, written: stats.written, removed: stats.removed, kept };
}

// ---------- checks ----------
function linksIn(text) { return [...String(text).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim()); }
function check(brain) {
  brain = path.resolve(brain || brainPath());
  const dead = []; const secrets = [];
  const exists = (t) => fs.existsSync(path.join(brain, t + '.md')) || fs.existsSync(path.join(brain, t));
  for (const f of walk(brain)) {
    if (!/\.(md|canvas|json)$/.test(f)) continue;
    const text = readText(f) || '';
    if (MAP.findSecrets(text).length) secrets.push(relTo(brain, f));
    if (f.endsWith('.md')) for (const t of linksIn(text)) if (!exists(t)) dead.push(`${relTo(brain, f)} -> ${t}`);
    if (f.endsWith('.canvas')) {
      let cv = null; try { cv = JSON.parse(text); } catch { dead.push(`${relTo(brain, f)} is not valid JSON`); }
      for (const n of (cv && cv.nodes) || []) {
        if (n.type === 'file' && !fs.existsSync(path.join(brain, n.file))) dead.push(`${relTo(brain, f)} -> ${n.file}`);
        if (n.type === 'text') for (const t of linksIn(n.text)) if (!exists(t)) dead.push(`${relTo(brain, f)} text -> ${t}`);
      }
    }
  }
  return { dead, secrets };
}
/** brainWired(root, opts) -> the doctor's ADVISORY brain_wired result {ok, applicable, problems, fix, ...}. */
function brainWired(root, opts = {}) {
  root = path.resolve(root || DEFAULT_ROOT);
  if (!fs.existsSync(path.join(root, '.claude', 'forge-bin', 'forge-brain.cjs'))) return { ok: true, applicable: false, problems: [], fix: [], reason: 'forge-brain.cjs is not installed here' };
  const loc = locate(opts); const brain = loc.path; const source = loc.source;
  const problems = []; const fix = [];
  const missing = missingVault(loc);
  if (missing) {
    problems.push(missing);
    fix.push('create that folder, or change it: node .claude/forge-bin/forge-config.cjs set brain-path <folder>');
    return { ok: false, applicable: true, brain, source, problems, fix };
  }
  if (!fs.existsSync(path.join(brain, 'Brain-Home.md'))) {
    problems.push('the central brain has no Brain-Home.md (' + brain + ')');
    fix.push('node .claude/forge-bin/forge-brain.cjs sync');
    return { ok: false, applicable: true, brain, source, problems, fix };
  }
  const st = readJson(path.join(brain, 'brain-state.json')) || {};
  const last = Date.parse(st.lastSync || '');
  const now = (opts.now instanceof Date ? opts.now : new Date()).getTime();
  if (!Number.isFinite(last)) { problems.push('brain-state.json has no last sync time'); fix.push('node .claude/forge-bin/forge-brain.cjs sync'); }
  else if (now - last > STALE_DAYS * 86400000) { problems.push(`the last brain sync of ${brain} is older than ${STALE_DAYS} days (${st.lastSync})`); fix.push('node .claude/forge-bin/forge-brain.cjs sync'); }
  const c = check(brain);
  if (c.secrets.length) { problems.push(`secret-like text in ${c.secrets.length} file(s) of the brain ${brain}: ${c.secrets.slice(0, 5).join(', ')}`); fix.push('remove the text from those notes, then sync again'); }
  if (c.dead.length) problems.push(`${c.dead.length} dead link(s) in the brain, e.g. ${c.dead[0]}`);
  return { ok: !problems.length, applicable: true, brain, source, lastSync: st.lastSync || null, projects: st.projects == null ? null : st.projects, problems, fix };
}
/** afterRun(root, opts) — the hook-free call for run close / start: the project digest always, sync at most every 6 h.
 *  Never throws. A root inside the OS temp folder (a test fixture) is skipped unless opts.force. */
function afterRun(root, opts = {}) {
  const env = opts.env || process.env;
  if (String(env.FORGE_BRAIN || '').toLowerCase() === 'off') return { skipped: 'FORGE_BRAIN=off' };
  root = path.resolve(root || DEFAULT_ROOT);
  const tmp = canon(os.tmpdir()); const r = canon(root);
  if (!opts.force && (r === tmp || r.startsWith(tmp + path.sep))) return { skipped: 'temp folder (a test fixture): the brain is left alone' };
  // FB-BRAIN-F3: the owner's vault setting governs the vault map, the digest and the central brain alike (as in
  // forge-vault.cjs); an unreadable setting keeps the built-in default (on)
  let vaultOn = true;
  try { const cfg = opts.config || configModule(); if (cfg) { const v = cfg.safeGet('vault', { projectRoot: root, configHome: env.FORGE_CONFIG_HOME || undefined, fallback: true }).value; if (typeof v === 'boolean') vaultOn = v; } } catch { vaultOn = true; }
  if (!vaultOn) return { skipped: 'vault off (owner setting): no vault map, digest or brain sync' };
  const out = {};
  try { out.project = project({ root }); } catch (e) { out.projectError = String(e.message || e).split('\n')[0]; }
  const brain = brainPath(env, opts);
  const st = readJson(path.join(brain, 'brain-state.json')) || {};
  const last = Date.parse(st.lastSync || '');
  if (Number.isFinite(last) && Date.now() - last < SYNC_EVERY_MS) { out.syncSkipped = 'synced less than 6 h ago (' + st.lastSync + ')'; return out; }
  try { const s = sync({ env, config: opts.config, scanRoots: opts.scanRoots, registryFile: opts.registryFile }); if (s.refused) { out.syncRefused = s.refused; return out; } out.sync = { projects: s.projects.length, notes: s.notes, written: s.written }; } catch (e) { out.syncError = String(e.message || e).split('\n')[0]; }
  return out;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(a); }
  return o;
}
function main(argv) {
  const a = parseArgs(argv); const cmd = a._[0];
  const root = a.root ? path.resolve(a.root) : DEFAULT_ROOT;
  const brain = a.brain ? path.resolve(a.brain) : undefined; // unset: sync/check pick FORGE_BRAIN_PATH, brain-path or the default
  const out = (obj, txt) => process.stdout.write((a.json ? JSON.stringify(obj, null, 2) : txt) + '\n');
  if (cmd === 'project') {
    const r = project({ root, date: a.date });
    const s = a.sync ? sync({ brain }) : null;
    out({ project: r, sync: s }, `forge-brain: project digest ${r.digest} (written ${r.written}, map removed ${r.map.removed})${s ? (s.refused ? '; ' + s.refused : `; brain sync: ${s.projects.length} projects, ${s.notes} notes, written ${s.written}`) : ''}`);
    return s && s.refused ? 1 : 0;
  }
  if (cmd === 'sync') {
    const s = sync({ brain });
    if (s.refused) { out(s, s.refused); return 1; }
    out(s, [`forge-brain sync: ${s.projects.length} project(s) from ${s.source} into ${s.brain}`, `notes ${s.notes} (skills ${s.skills}, agents ${s.agents}, lesson notes ${s.lessons}); written ${s.written}, removed ${s.removed}`,
      ...s.projects.map((p) => `  + ${p.name} (${p.runs} runs) -> projects/${p.slug}`), ...s.kept.map((k) => `  = kept your own note ${k} (not generated by Forge)`), ...s.skipped.map((k) => `  - skipped ${k.path}: ${k.reason}`)].join('\n'));
    return 0;
  }
  if (cmd === 'check') {
    const c = check(brain);
    out(c, `dead links: ${c.dead.length}${c.dead.length ? '\n  ' + c.dead.slice(0, 20).join('\n  ') : ''}\nfiles with secret-like text: ${c.secrets.length}${c.secrets.length ? '\n  ' + c.secrets.join('\n  ') : ''}`);
    return c.dead.length || c.secrets.length ? 1 : 0;
  }
  if (cmd === 'hook') { const r = afterRun(root); out(r, 'forge-brain hook: ' + JSON.stringify(r)); return 0; }
  if (cmd === 'wired') { const r = brainWired(root); out(r, `brain_wired: ${r.ok ? 'ok' : 'problems'}${r.brain ? ` (brain ${r.brain}, from ${r.source})` : ''}${r.problems && r.problems.length ? ' — ' + r.problems.join('; ') : ''}`); return r.ok ? 0 : 1; }
  process.stderr.write('usage: forge-brain.cjs project --root DIR [--sync] | sync [--brain DIR] | check [--brain DIR] | hook --root DIR | wired [--root DIR] [--json]\n');
  return 2;
}

module.exports = { brainPath, brainLocation, harvest, project, discover, sync, check, brainWired, afterRun, GEN_MARK };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
