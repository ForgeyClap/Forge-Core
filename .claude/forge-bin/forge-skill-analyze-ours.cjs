'use strict';
// forge-skill-analyze-ours.cjs — our own skill library, mapped onto the analyser's categories.
// Reads (never writes): <project>/.claude/skills/**/SKILL.md (source "project"), <home>/.claude/skills/**/SKILL.md
// (source "ecc" under skills/ecc/, else "global"), and the skills of every INSTALLED plugin listed in
// <home>/.claude/plugins/installed_plugins.json (source "plugin:<name@marketplace>"; marketplace checkouts that are not
// installed are not ours and are skipped). The 2026-11-04 skills audit (audit-raw.json) adds its verdict when a path matches.
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./forge-skill-harvest-parse.cjs');
const T = require('./forge-skill-analyze-taxonomy.cjs');

const MAX_DEPTH = 6; const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build']);

function findSkillFiles(dir, depth = 0, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return out;
    throw new Error(`cannot list ${dir}: ${e.code || e.message}`);
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory(); let isFile = e.isFile();
    if (e.isSymbolicLink()) { try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; /* dangling link: nothing to read */ } }
    if (isFile && e.name.toLowerCase() === 'skill.md') out.push(p);
    else if (isDir && depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) findSkillFiles(p, depth + 1, out);
  }
  return out;
}

const normPath = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const display = (p, home) => { const a = path.resolve(p).replace(/\\/g, '/'); const h = path.resolve(home).replace(/\\/g, '/'); return a.toLowerCase().startsWith(h.toLowerCase() + '/') ? '~' + a.slice(h.length) : a; };

function loadAudit(file) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return { map, used: false };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const sec of Object.values(raw || {})) {
    for (const s of (sec && Array.isArray(sec.skills) ? sec.skills : [])) {
      if (s && typeof s.path === 'string' && !s.path.includes('<')) map.set(normPath(s.path), { verdict: s.verdict || null, trigger_quality: s.trigger_quality || null });
    }
  }
  return { map, used: true };
}

function pluginRoots(home) {
  const f = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(f)) return [];
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const out = [];
  for (const [key, entries] of Object.entries((j && j.plugins) || {})) {
    for (const e of Array.isArray(entries) ? entries : []) if (e && typeof e.installPath === 'string') out.push({ source: `plugin:${key}`, dir: e.installPath });
  }
  return out;
}

function scanOurs({ projectRoot, home, auditFile }) {
  const roots = [{ source: 'project', dir: path.join(projectRoot, '.claude', 'skills') }, { source: 'home', dir: path.join(home, '.claude', 'skills') }, ...pluginRoots(home)];
  const audit = loadAudit(auditFile);
  const seen = new Set(); const skills = []; const errors = [];
  const eccDir = normPath(path.join(home, '.claude', 'skills', 'ecc')) + '/';
  for (const r of roots) {
    for (const file of findSkillFiles(r.dir)) {
      const key = normPath(file); if (seen.has(key)) continue; seen.add(key);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { errors.push({ path: display(file, home), error: e.code || e.message }); continue; }
      const fm = parseFrontmatter(text);
      const name = fm.name || path.basename(path.dirname(file));
      const source = r.source === 'home' ? (key.startsWith(eccDir) ? 'ecc' : 'global') : r.source;
      const a = audit.map.get(key);
      skills.push({ name, description: fm.description ? fm.description.slice(0, 300) : null, source, path: display(file, home),
        categories: T.categorize({ name, description: fm.description, headings: T.extractHeadings(text) }),
        verdict: a ? a.verdict : null, trigger_quality: a ? a.trigger_quality : null });
    }
  }
  skills.sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : x.path < y.path ? -1 : 1));
  return { skills, errors, audit_used: audit.used, roots: roots.map((r) => ({ source: r.source, dir: display(r.dir, home) })) };
}

module.exports = { scanOurs, findSkillFiles };
