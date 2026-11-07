'use strict';
// forge-skill-analyze-features.cjs — per-skill features of the skill-corpus analyser:
// risk flags (from the harvester's `ships` record + install commands in the text), a quality score with its parts,
// and a MinHash text fingerprint (64 x 32-bit over word 3-shingles) used for near-duplicate search.

const { words: splitWords } = require('./forge-skill-analyze-taxonomy.cjs');

// ---- risk flags --------------------------------------------------------------------------------------------------
const INSTALL_PATH_RE = /(^|\/)(install|setup|bootstrap|postinstall|preinstall)[^/]*\.(sh|bash|ps1|py|js|cjs|mjs|bat|cmd)$/i;
const INSTALL_TEXT_RE = /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]{0,300}\|\s*(sudo\s+)?(ba|z)?sh\b|\b(curl|wget|iwr|irm)\b[^\n|]{0,300}\|\s*iex\b|\bnpm\s+(i|install)\s+(-g|--global)\b|\bnpx\s+-y\b|\bpip3?\s+install\b|\buv\s+tool\s+install\b|\bbrew\s+install\b|\bgo\s+install\b|\bcargo\s+install\b/i;

function riskFlags(ships, text) {
  const s = ships || {};
  const net = s.network || {};
  const scriptCount = Object.values(s.scripts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const flags = {
    scripts: scriptCount > 0,
    hooks: (s.hooks || []).length > 0,
    mcp: (s.mcp || []).length > 0,
    network: (Number(net.files_with_network) || 0) > 0 || (net.markers || []).length > 0,
    install: (s.package_json || []).length > 0 || (s.script_paths || []).some((p) => INSTALL_PATH_RE.test(p)) || INSTALL_TEXT_RE.test(String(text || '').slice(0, 200000)),
    binaries: (Number(s.binaries) || 0) > 0,
  };
  return { flags, risky: Object.values(flags).some(Boolean) };
}

// ---- quality -----------------------------------------------------------------------------------------------------
// Parts (max 100): frontmatter 25 (name AND description present), trigger 20 (a "when to use" cue in description or
// body), length 15 (SKILL.md 300..40000 bytes; 7 for 120..299 or 40001..100000), description 5 (40..1024 chars),
// stars 15 (5 * log10(stars + 1), capped), recent 10 (last commit <= 180 days; 5 for <= 365), license 10.
// Bands: high >= 70, medium 40..69, low < 40.
const TRIGGER_RE = /\b(use (this skill |it )?(when|whenever|for|to|if|before|after)|when to use|use cases?|triggers?( on| when|:)|invoke (this )?(when|for)|activate (when|for)|should be used (when|for))\b/i;
const DAY = 864e5;
function quality(rec, info, nowMs) {
  const desc = typeof rec.description === 'string' ? rec.description.trim() : '';
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  const bytes = Number(rec.bytes) || 0;
  const stars = Math.max(0, Number(rec.stars) || 0);
  const ts = Date.parse(rec.last_commit || rec.pushed_at || '');
  const age = Number.isFinite(ts) ? (nowMs - ts) / DAY : Infinity;
  const parts = {
    frontmatter: name && desc ? 25 : 0,
    trigger: (info && info.trigger) || TRIGGER_RE.test(desc) ? 20 : 0,
    length: bytes >= 300 && bytes <= 40000 ? 15 : (bytes >= 120 && bytes <= 100000 ? 7 : 0),
    description: desc.length >= 40 && desc.length <= 1024 ? 5 : 0,
    stars: Math.min(15, Math.round(5 * Math.log10(stars + 1))),
    recent: age <= 180 ? 10 : (age <= 365 ? 5 : 0),
    license: rec.license && String(rec.license).toUpperCase() !== 'NOASSERTION' ? 10 : 0,
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score, band: score >= 70 ? 'high' : (score >= 40 ? 'medium' : 'low'), parts };
}

// ---- MinHash -----------------------------------------------------------------------------------------------------
const K = 64; const MIN_SHINGLES = 8; const MAX_CHARS = 60000;
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mix(x, seed) { // murmur3 fmix32 over x ^ seed: a cheap, well-spread family of hash functions
  let h = (x ^ seed) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
const SEEDS = (() => { const s = new Uint32Array(K); let x = 0x9e3779b9; for (let i = 0; i < K; i++) { x = mix(x + i, 0x5bd1e995); s[i] = x; } return s; })();

// Signature of lower-cased word 3-shingles (CJK/Thai: character 3-shingles, see taxonomy words()); null when the text has fewer than MIN_SHINGLES distinct shingles.
function minhash(text) {
  const words = splitWords(String(text || '').slice(0, MAX_CHARS));
  const seen = new Set();
  for (let i = 0; i + 2 < words.length; i++) seen.add(fnv1a(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]));
  if (seen.size < MIN_SHINGLES) return null;
  const sig = new Uint32Array(K).fill(0xffffffff);
  for (const x of seen) for (let i = 0; i < K; i++) { const v = mix(x, SEEDS[i]); if (v < sig[i]) sig[i] = v; }
  return sig;
}
function jaccard(a, b) {
  if (!a || !b) return 0;
  let eq = 0; for (let i = 0; i < K; i++) if (a[i] === b[i]) eq++;
  return eq / K;
}
// The first four MinHash values as 32 hex chars: equal text -> equal fingerprint; near copies share most of it.
const fingerprint = (sig) => (sig ? Array.from(sig.slice(0, 4), (v) => v.toString(16).padStart(8, '0')).join('') : null);

// Body without the frontmatter block.
function bodyOf(text) {
  const t = String(text || '');
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(t);
  return m ? t.slice(m[0].length) : t;
}
// A SKILL.md that is only a relative path (a symlink stored as text by git) — "../../commands/okr.md".
const isPointer = (text) => { const t = String(text || '').trim(); return t.length > 0 && t.length < 300 && !/\s/.test(t) && /[./]/.test(t); };

module.exports = { riskFlags, quality, minhash, jaccard, fingerprint, bodyOf, isPointer, TRIGGER_RE, K };
