'use strict';
// forge-skill-harvest-parse.cjs — pure parsers for the skill harvester. No I/O, no network.
// Everything downloaded is DATA: these functions only read strings; nothing here evaluates or runs them.
const crypto = require('crypto');

const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function parseSitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(String(xml)))) out.push(m[1].replace(/&(amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e]));
  return out;
}

function parseSkillsShLoc(loc) {
  let u;
  try { u = new URL(loc); } catch { return null; }
  if (!/^(www\.)?skills\.sh$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 3) return null;
  return { repo: `${parts[0]}/${parts[1]}`, skill: parts[2] };
}

// GitHub top-level paths that are not user/org names.
const NON_OWNERS = new Set(['topics', 'sponsors', 'orgs', 'features', 'marketplace', 'settings', 'login', 'join',
  'about', 'apps', 'collections', 'search', 'site', 'pricing', 'enterprise', 'explore', 'notifications', 'issues',
  'pulls', 'trending', 'readme', 'security', 'customer-stories', 'contact', 'events', 'github-copilot', 'new', 'codespaces']);
const REPO_RE = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})/g;

function cleanRepo(owner, name) {
  const n = name.replace(/\.git$/i, '').replace(/[.]+$/, '');
  if (!n || NON_OWNERS.has(owner.toLowerCase())) return null;
  return `${owner}/${n}`;
}

function extractGithubRepos(text) {
  const seen = new Map();
  let m;
  REPO_RE.lastIndex = 0;
  while ((m = REPO_RE.exec(String(text)))) {
    const repo = cleanRepo(m[1], m[2]);
    if (repo) seen.set(repo.toLowerCase(), repo.toLowerCase());
  }
  return [...seen.values()];
}

function parseMarketplace(jsonText, listRepo) {
  let j;
  try { j = JSON.parse(jsonText); } catch { return []; }
  const out = new Set();
  for (const p of Array.isArray(j && j.plugins) ? j.plugins : []) {
    const s = p && p.source;
    if (typeof s === 'string') { if (s.startsWith('./') || s.startsWith('../')) out.add(listRepo); continue; }
    if (s && s.source === 'github' && typeof s.repo === 'string') out.add(s.repo.replace(/\.git$/i, ''));
    if (s && typeof s.url === 'string') extractGithubRepos(s.url).forEach((r) => out.add(r));
  }
  return [...out];
}

function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

// Minimal YAML frontmatter reader: top-level `key: value`, quoted values, `>` / `|` block scalars.
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text));
  if (!m) return { raw: null, name: null, description: null, fields: {} };
  const raw = m[1].slice(0, 8000);
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!km) continue;
    let val = km[2];
    if (/^[>|][+-]?$/.test(val.trim()) || val.trim() === '') {
      const folded = val.trim().startsWith('>') || val.trim() === '';
      const block = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && !/^[A-Za-z0-9_-]+:/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.filter((b, k) => b || k < block.length - 1).join(folded ? ' ' : '\n').trim();
    } else val = unquote(val);
    fields[km[1]] = val.slice(0, 4000);
  }
  return { raw, name: fields.name || null, description: fields.description || null, fields };
}

const SIZE_FACETS = ['path:skills', 'path:.claude/skills', 'path:plugins', 'path:.agents', 'path:.codex',
  'path:.cursor', 'path:agents', 'path:src', 'claude', 'agent', 'mcp', 'python', 'api', 'test', 'data'];
function splitPartition(part) {
  if (part.lo < part.hi) {
    const mid = Math.floor((part.lo + part.hi) / 2);
    return [{ lo: part.lo, hi: mid }, { lo: mid + 1, hi: part.hi }];
  }
  if (!part.facet) return SIZE_FACETS.map((facet) => ({ lo: part.lo, hi: part.hi, facet }));
  return [];
}
const codeQuery = (p) => `filename:SKILL.md size:${p.lo}..${p.hi}${p.facet ? ' ' + p.facet : ''}`;

const DAY = 864e5;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function splitDateRange(r) {
  const a = Date.parse(r.from); const b = Date.parse(r.to);
  if (!(b > a)) return [];
  const mid = a + Math.floor((b - a) / DAY / 2) * DAY;
  return [{ from: r.from, to: isoDay(mid) }, { from: isoDay(mid + DAY), to: r.to }];
}

const SCRIPT_EXT = new Set(['.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.rb',
  '.go', '.rs', '.php', '.pl', '.bat', '.cmd', '.lua', '.swift', '.java', '.kt', '.r', '.jl', '.cs']);
const extOf = (p) => { const b = p.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };

function classifyShips(entries, skillDir) {
  const pre = skillDir ? skillDir.replace(/\/+$/, '') + '/' : '';
  const s = { files: 0, scripts: {}, script_paths: [], hooks: [], mcp: [], package_json: [], binaries: 0 };
  for (const e of entries) {
    if (e.type !== 'blob' || !e.path.startsWith(pre)) continue;
    s.files++;
    const rel = e.path.slice(pre.length); const base = rel.split('/').pop().toLowerCase(); const ext = extOf(rel);
    if (SCRIPT_EXT.has(ext)) { s.scripts[ext] = (s.scripts[ext] || 0) + 1; s.script_paths.push(e.path); }
    if (/(^|\/)hooks\//i.test(rel) || base === 'hooks.json') s.hooks.push(e.path);
    if (base === '.mcp.json' || base === 'mcp.json' || /mcp.*\.json$/.test(base)) s.mcp.push(e.path);
    if (base === 'package.json') s.package_json.push(e.path);
    if (e.isBinary) s.binaries++;
  }
  return s;
}

const NET_MARKERS = [['fetch', /\bfetch\s*\(/], ['axios', /\baxios\b/], ['requests', /\brequests\.(get|post|put|delete|patch|request|Session)\b|^\s*import requests\b/m],
  ['urllib', /\burllib\b/], ['httpx', /\bhttpx\b/], ['http.client', /\bhttp\.client\b/], ['node-http', /\bhttps?\.(request|get)\s*\(/],
  ['curl', /\bcurl\s/], ['wget', /\bwget\s/], ['powershell-web', /Invoke-(WebRequest|RestMethod)/i], ['xhr', /XMLHttpRequest/],
  ['go-net-http', /"net\/http"/], ['socket', /\bsocket\b/], ['websocket', /WebSocket/]];
function grepNetwork(text) {
  const t = String(text);
  const markers = NET_MARKERS.filter(([, re]) => re.test(t)).map(([n]) => n);
  const hosts = new Set();
  const re = /\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g; let m;
  while ((m = re.exec(t)) && hosts.size < 25) hosts.add(m[1].toLowerCase());
  return { markers, hosts: [...hosts] };
}

const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-');
function resolveSkillsSh(skill, skillPaths) {
  if (!skillPaths.length) return null;
  const want = norm(skill);
  const hit = skillPaths.find((p) => { const parts = p.split('/'); return parts.length > 1 && norm(parts[parts.length - 2]) === want; });
  if (hit) return hit;
  return skillPaths.length === 1 ? skillPaths[0] : null;
}

const isSkillFile = (p) => p.split('/').pop().toLowerCase() === 'skill.md';
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

module.exports = { sha256, parseSitemapLocs, parseSkillsShLoc, extractGithubRepos, parseMarketplace, parseFrontmatter,
  splitPartition, codeQuery, splitDateRange, isoDay, classifyShips, grepNetwork, resolveSkillsSh, isSkillFile, dirOf,
  SIZE_FACETS, SCRIPT_EXT };
