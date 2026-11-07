#!/usr/bin/env node
'use strict';
/**
 * forge-scout.cjs — external-capability research term-generator + persistent vetting ledger (2026-07-22,
 * PIECE P5). Zero-dependency (fs/path only). This module does NOT perform the actual web-search or video
 * watching itself — that is done by the Lead/Search Boss at runtime per `forge-scout` SKILL.md doctrine
 * (real web-search, then WATCH EACH candidate's video via the `./watch` skill before forming a verdict).
 * What THIS file owns:
 *   1. terms()    — given a project domain (+ optional free-form keywords), generate a TAILORED search-term
 *      list from per-domain seed templates — deliberately NOT a generic "claude skill" search. Distinct
 *      domains produce distinct, domain-flavored terms (see SEED_TEMPLATES); an uncurated domain still gets
 *      a domain-tailored (not generic) fallback built from the domain word itself.
 *   2. record()/list()/isVetted() — an append-only ledger split (external audit N4) across TWO
 *      files: config/orchestration/FORGE_SCOUT_VETTING.json (SHIPPED, curated baseline — ships with the
 *      template, product-decided) and config/orchestration/FORGE_SCOUT_VETTING.user.json (NEVER shipped,
 *      never in forge-sync.cjs's SYSTEM/SYSTEM_GLOB list — real Scout research accumulated by USING this
 *      project). record() writes new verdicts to the user ledger by default; list()/isVetted() transparently
 *      merge both so every existing caller keeps seeing the full picture. A HARD-PASS verdict for a
 *      capability PERSISTS: once recorded, isVetted() always surfaces the HARD-PASS ahead of any later
 *      attempt to (re-)APPROVE the same capability, so junk is never re-evaluated on a future Scout pass —
 *      which is exactly why a STALE hard-pass (one covering a capability the product has since vendored/
 *      shipped, e.g. frontend-design) is corrected IN PLACE in the shipped baseline rather than "fixed" by
 *      appending a same-key approve that the persistence rule would then bury anyway. Neither ledger file is
 *      ever overwritten wholesale by record() — every call reads the existing target file, appends one new
 *      entry, and writes that one file back whole (same read-modify-write discipline as forge-store.cjs's
 *      per-entity writes); no prior entry is ever deleted or mutated in place by record() itself.
 *
 * LEDGER SHAPE (both files, identical shape):
 *   { "_doc": <string>, "version": 1, "entries": [ { capability, verdict, reason, source, ts }, ... ] }
 *   verdict is one of 'approve' | 'hard-pass'. A malformed ledger (invalid JSON, wrong top-level shape, an
 *   entry missing a required field) THROWS on read — same fail-closed posture forge-actiongate.cjs and
 *   forge-evidence.cjs use for their own config files; a corrupt ledger must never be silently treated as
 *   "nothing vetted yet."
 *
 * MODEL:
 *   terms({ domain, keywords }, opts) -> { domain, terms: [string,...], sources: [{name, url, curated, note},...] }
 *     `sources` lists WHERE to search besides the web/video search, each with an explicit
 *     `curated` flag — an uncurated source (skills.sh) is a place to FIND candidates, never evidence that one
 *     is safe; every candidate still gets its own APPROVE/HARD-PASS below.
 *   record({ capability, verdict, reason, source }, opts) -> the appended entry (with ts stamped)
 *   list(opts) -> { entries: [...] }
 *   isVetted(capability, opts) -> null (never vetted) | the prevailing entry (a HARD-PASS, if one exists
 *     for this capability, ALWAYS wins over a later approve; otherwise the most recent entry)
 *   opts.vettingPath — the ORIGINAL, still-fully-supported single-file test seam: when given (or when
 *     process.env.FORGE_SCOUT_VETTING_PATH is set), EVERY function (record/list/isVetted) reads/writes
 *     EXACTLY that one file, unmerged — this is what every existing hermetic test in forge-scout.test.cjs
 *     already relies on, and it is unchanged by the 2026-09-26 split. Only the DEFAULT (no override at all)
 *     changes: list()/isVetted() then merge CONFIG_PATH (shipped baseline) + USER_CONFIG_PATH (accumulated
 *     user ledger), and record() writes ONLY to USER_CONFIG_PATH — never to the shipped template.
 *
 * CLI:
 *   node forge-scout.cjs terms --domain <d> [--keywords <k1,k2,...>] [--json]
 *   node forge-scout.cjs record --capability <c> --verdict <approve|hard-pass> --reason "<r>" [--source <s>] [--json]
 *   node forge-scout.cjs list [--json]
 *   node forge-scout.cjs rank --query "<q>" --candidates <file.json> [--cap N] [--json]   (: a JSON list, or {candidates:[...]},
 *        of {name, description?, url?, source_kind?, updated?, web_only?})
 *   node forge-scout.cjs adopt-plan --capability <c> [--json]   (: branch + reviewed-diff plan for an APPROVED capability)
 * Exit codes: terms/list/rank: 0 (advisory, never a gate) · record: 0 = recorded · adopt-plan: 0 = plan, 3 = refused
 *   (hard-pass or never vetted) · 2 = usage/validation error (missing/invalid field, malformed ledger or candidates file).
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_SCOUT_VETTING.json');
// USER_CONFIG_PATH — real Scout research accumulated by USING this project. NEVER add this filename to
// forge-sync.cjs's SYSTEM/SYSTEM_GLOB list: it must never be synced from, or overwritten/deleted by, the
// product template. See forge-sync.cjs's own comment next to SYSTEM for the matching note.
const USER_CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_SCOUT_VETTING.user.json');
const VALID_VERDICTS = new Set(['approve', 'hard-pass']);

// ---------------------------------------------------------------------------------------------------------
// terms() — tailored, per-domain search-term generation
// ---------------------------------------------------------------------------------------------------------

// Curated seed templates per domain slug (lowercase key). Deliberately domain-flavored — never a bare
// "claude skill"/"claude plugin" phrase on its own. Domain slugs beyond the 7 in domain-presets.json are
// included here on purpose: Scout researches ANY project shape (slides, astro, etc.), not just the domains
// that have a full requirements playbook.
const SEED_TEMPLATES = {
  slides: [
    'claude powerpoint skill', 'claude slide generator skill',
    'I stopped using PowerPoint claude code skill', 'claude code slides plugin',
    'ai presentation generator mcp',
  ],
  presentation: [
    'claude powerpoint skill', 'claude slide generator skill',
    'I stopped using PowerPoint claude code skill', 'claude code slides plugin',
  ],
  astro: [
    'claude astro skill', 'bulk website generator claude',
    'claude code astro plugin', 'astro content collection claude skill',
    'static site generator claude mcp',
  ],
  website: [
    'claude website builder skill', 'claude landing page generator plugin',
    'claude code frontend skill', 'I stopped hand-coding html claude skill',
  ],
  fullstack: [
    'claude fullstack scaffolding skill', 'claude code backend generator plugin',
    'claude api boilerplate skill',
  ],
  n8n: [
    'claude n8n workflow skill', 'claude code automation builder plugin',
    'n8n workflow generator claude mcp',
  ],
  scraping: [
    'claude web scraping skill', 'claude code scraper plugin',
    'claude data extraction mcp',
  ],
  rag: [
    'claude rag pipeline skill', 'claude chatbot knowledge base plugin',
    'claude code retrieval augmented generation skill',
  ],
  prediction: [
    'claude sports prediction skill', 'claude data science forecasting plugin',
  ],
  integration: [
    'claude telegram bot skill', 'claude api integration plugin',
    'claude code webhook skill',
  ],
  electron: [
    'claude electron app skill', 'claude desktop app generator plugin',
    'I stopped building electron by hand claude skill',
  ],
  desktop: [
    'claude electron app skill', 'claude desktop app generator plugin',
    'I stopped building desktop apps by hand claude skill',
  ],
  ecommerce: [
    'claude etsy listing skill', 'claude shopify automation plugin',
    'claude ecommerce product generator skill',
  ],
  dashboard: [
    'claude dashboard builder skill', 'claude data viz plugin',
    'claude code analytics dashboard skill',
  ],
  game: [
    'claude browser game skill', 'claude code game generator plugin',
    'phaser claude skill',
  ],
  mobile: [
    'claude react native skill', 'claude mobile app generator plugin',
  ],
  mlops: [
    'claude mlops skill', 'claude model deployment plugin',
  ],
  tooling: [
    'claude dev tooling skill', 'claude cli generator plugin',
  ],
  voice: [
    'claude voice agent skill', 'claude ai phone agent plugin',
  ],
};

const MAX_TERMS = 16;

// Discovery sources handed to the Lead/Search Boss alongside the terms. `curated: false` means the listing has
// no submission review: it may surface candidates, it never vouches for them (see the ledger's standing
// hard-pass on bulk unreviewed community marketplaces as an INSTALL source).
const DISCOVERY_SOURCES = Object.freeze([
  Object.freeze({
    name: 'skills.sh (vercel-labs/skills, npx skills search)', url: 'https://skills.sh', curated: false,
    note: 'install-telemetry ranking, no submission review — never a trust signal; Scout APPROVE/HARD-PASS still applies',
  }),
]);

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = String(s).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(s).trim());
  }
  return out;
}

/** genericFallback(domain) — still domain-TAILORED (bakes the actual domain word in), just not curated. */
function genericFallback(domain) {
  return [
    'claude ' + domain + ' skill',
    'claude code ' + domain + ' plugin',
    'I stopped doing ' + domain + ' manually claude skill',
    domain + ' generator claude mcp',
  ];
}

function keywordTerms(keyword) {
  const k = String(keyword).trim();
  if (!k) return [];
  return [
    'claude ' + k + ' skill',
    k + ' claude code plugin',
    'I stopped using ' + k + ' claude code skill',
  ];
}

/** terms({domain, keywords}, opts) -> { domain, terms }. Throws on a missing/empty domain — a caller must
 *  know what it's researching; there is no "generic, no domain" mode. */
function terms(params, opts) {
  params = params || {};
  opts = opts || {};
  if (!params.domain || typeof params.domain !== 'string' || !params.domain.trim()) {
    throw new Error('forge-scout: terms() requires a non-empty "domain" string');
  }
  const domain = params.domain.trim();
  const key = domain.toLowerCase();
  const seeded = SEED_TEMPLATES[key] || [];
  const fallback = seeded.length ? [] : genericFallback(domain);

  const keywords = Array.isArray(params.keywords) ? params.keywords : (params.keywords ? [params.keywords] : []);
  const kwTerms = [];
  for (const kw of keywords) kwTerms.push(...keywordTerms(kw));

  const merged = dedupe([...seeded, ...fallback, ...kwTerms]).slice(0, MAX_TERMS);
  return { domain, terms: merged, sources: DISCOVERY_SOURCES.map((s) => ({ ...s })) }; // copies: a caller can never edit the shared list
}

// ---------------------------------------------------------------------------------------------------------
// vetting ledger — record()/list()/isVetted()
// ---------------------------------------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function defaultLedger() {
  return {
    _doc: 'Forge-Core — persistent Scout vetting ledger. Append-only: a HARD-PASS ' +
      'verdict for a capability PERSISTS and is never silently overwritten by a later approve attempt. ' +
      'Written/read by forge-bin/forge-scout.cjs only.',
    version: 1,
    entries: [],
  };
}

/** resolveExplicitPath(vettingPath) -> the ORIGINAL single-file test seam, unchanged since 2026-07-22: an
 *  explicit opts.vettingPath, or process.env.FORGE_SCOUT_VETTING_PATH, or null when neither is given (the
 *  caller then falls through to the 2026-09-26 default template+user split — see loadLedger()/record()). */
function resolveExplicitPath(vettingPath) {
  return vettingPath || process.env.FORGE_SCOUT_VETTING_PATH || null;
}
// Back-compat alias — same behavior as before the split when a caller passes an explicit path (which every
// existing hermetic test does); kept exported under its original name.
function resolvePath(vettingPath) {
  return resolveExplicitPath(vettingPath) || CONFIG_PATH;
}

/** loadLedgerFile(p) -> {_doc, version, entries} for EXACTLY the given file. Missing file degrades to an
 *  honest empty ledger (normal for a fresh project — Scout hasn't recorded anything yet there). A
 *  PRESENT-but-malformed file (invalid JSON, wrong top-level shape, or an entry missing a required field)
 *  THROWS — fail closed, same rule every sibling config/ledger reader in this project already applies. */
function loadLedgerFile(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return defaultLedger();
    throw new Error('forge-scout: ledger file unreadable (' + p + '): ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-scout: ledger file is not valid JSON (' + p + '): ' + e.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.entries)) {
    throw new Error('forge-scout: ledger file must be a JSON object with an "entries" array (' + p + ')');
  }
  for (const entry of data.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('forge-scout: ledger file has a malformed entry (not an object) in ' + p);
    }
    if (typeof entry.capability !== 'string' || !entry.capability.trim()) {
      throw new Error('forge-scout: ledger entry missing non-empty "capability" in ' + p);
    }
    if (!VALID_VERDICTS.has(entry.verdict)) {
      throw new Error('forge-scout: ledger entry "' + entry.capability + '" has invalid "verdict" in ' + p + ' (must be approve|hard-pass): ' + JSON.stringify(entry.verdict));
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error('forge-scout: ledger entry "' + entry.capability + '" missing non-empty "reason" in ' + p);
    }
  }
  return data;
}

/** loadLedger(vettingPath) -> {_doc, version, entries}. With an explicit vettingPath (or
 *  FORGE_SCOUT_VETTING_PATH) — the pre-2026-09-26 behavior, unchanged: exactly that one file, unmerged. With
 *  NO override at all — the 2026-09-26 default: the SHIPPED curated baseline (CONFIG_PATH) merged with the
 *  never-shipped, accumulated USER_CONFIG_PATH ledger, template entries first. */
function loadLedger(vettingPath) {
  const explicit = resolveExplicitPath(vettingPath);
  if (explicit) return loadLedgerFile(explicit);
  const tpl = loadLedgerFile(CONFIG_PATH);
  const usr = loadLedgerFile(USER_CONFIG_PATH);
  return { _doc: tpl._doc, version: tpl.version, entries: tpl.entries.concat(usr.entries) };
}

function saveLedgerFile(p, ledger) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

/** record({capability, verdict, reason, source}, opts) -> appends ONE new entry (never rewrites/removes an
 *  existing one) and returns it. Validates capability/verdict/reason are present and well-formed; source is
 *  optional. Throws (fail closed) on invalid input OR a malformed pre-existing ledger — never silently
 *  drops a verdict or silently "fixes" a corrupt file. With an explicit opts.vettingPath (or
 *  FORGE_SCOUT_VETTING_PATH) it appends to exactly that one file (unchanged legacy/hermetic behavior). With
 *  NO override at all (the real default) it appends to USER_CONFIG_PATH ONLY — the shipped curated baseline
 *  is never written by record(). */
function record(params, opts) {
  params = params || {};
  opts = opts || {};
  const capability = typeof params.capability === 'string' ? params.capability.trim() : '';
  if (!capability) throw new Error('forge-scout: record() requires a non-empty "capability" string');
  if (!VALID_VERDICTS.has(params.verdict)) {
    throw new Error('forge-scout: record() requires "verdict" to be one of approve|hard-pass, got: ' + JSON.stringify(params.verdict));
  }
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (!reason) throw new Error('forge-scout: record() requires a non-empty "reason" string');

  const explicit = resolveExplicitPath(opts.vettingPath);
  const writePath = explicit || USER_CONFIG_PATH; // default mode: user ledger only, never the shipped template
  const ledger = loadLedgerFile(writePath); // throws on a pre-existing malformed ledger — fail closed

  const entry = {
    capability,
    verdict: params.verdict,
    reason,
    source: typeof params.source === 'string' && params.source.trim() ? params.source.trim() : null,
    ts: nowIso(),
  };
  ledger.entries = [...ledger.entries, entry]; // append — never mutate/remove a prior entry
  saveLedgerFile(writePath, ledger);
  return entry;
}

/** list(opts) -> {entries}. Throws on a malformed ledger (same fail-closed rule as loadLedger). */
function list(opts) {
  opts = opts || {};
  const ledger = loadLedger(opts.vettingPath);
  return { entries: ledger.entries };
}

/** isVetted(capability, opts) -> null | prevailing entry. A HARD-PASS for this capability ALWAYS wins over
 *  any later approve attempt for the same capability — this is what makes a HARD-PASS "persist": once
 *  recorded, no subsequent record() call can make isVetted() report anything other than that HARD-PASS for
 *  this capability. Absent a HARD-PASS, the most recently recorded entry for the capability is returned. */
function isVetted(capability, opts) {
  opts = opts || {};
  const cap = typeof capability === 'string' ? capability.trim() : '';
  if (!cap) throw new Error('forge-scout: isVetted() requires a non-empty capability string');
  const { entries } = list(opts);
  const matches = entries.filter((e) => e.capability.trim().toLowerCase() === cap.toLowerCase());
  if (matches.length === 0) return null;
  const hardPass = matches.find((e) => e.verdict === 'hard-pass');
  if (hardPass) return hardPass;
  return matches[matches.length - 1];
}

// ---------------------------------------------------------------------------------------------------------
// rank() / adoptPlan() —. rank() orders search results deterministically: candidates with an
// inspectable source first, web-only mentions (no url, or only a blog/web page) after them; inside each group by
// name match, then description match, then source kind, then maintenance; full ties by name. At most RANK_CAP
// results; the rest is returned in `dropped`. A capability with a prior HARD-PASS is skipped, never re-ranked.
// adoptPlan() turns an APPROVED capability into a plan: a fresh branch, the copy on that branch only, a reviewed
// diff, and a merge only after the owner says so. It runs no git command itself.
// ---------------------------------------------------------------------------------------------------------

const RANK_CAP = 10;
const GENERIC_WORDS = new Set(['claude', 'code', 'skill', 'skills', 'plugin', 'plugins', 'mcp', 'server', 'servers', 'tool', 'tools', 'a', 'an', 'the', 'for', 'and', 'i', 'stopped', 'using', 'generator']);
const SOURCE_SCORE = { official: 4, curated: 3, repo: 2, listing: 1, web: 0 };
const DAY_MS = 86400000;

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const queryWords = (q) => [...new Set(words(q).filter((w) => !GENERIC_WORDS.has(w)))];

/** sourceKind(candidate) -> official|curated|repo|listing|web. An explicit valid source_kind wins; otherwise the
 *  url decides: a code host or package registry is a repo, skills.sh is a listing, anything else is web. */
function sourceKind(c) {
  if (c && Object.prototype.hasOwnProperty.call(SOURCE_SCORE, c.source_kind)) return c.source_kind;
  const url = String((c && (c.url || c.source)) || '').toLowerCase();
  if (/^https?:\/\/(www\.)?(github\.com|gitlab\.com|codeberg\.org|npmjs\.com|pypi\.org)\//.test(url)) return 'repo';
  if (/^https?:\/\/(www\.)?skills\.sh\b/.test(url)) return 'listing';
  return 'web';
}

function maintenanceScore(updated, now) {
  const t = Date.parse(updated || '');
  if (!Number.isFinite(t)) return 1; // unknown: below anything known to be maintained, above known-stale
  const days = (now - t) / DAY_MS;
  return days <= 90 ? 3 : days <= 365 ? 2 : 0;
}

function nameScore(name, q) {
  if (!q.length) return 0;
  const n = words(name);
  if (n.filter((w) => !GENERIC_WORDS.has(w)).join(' ') === q.join(' ')) return 3;
  const hits = q.filter((w) => n.includes(w)).length;
  return hits === q.length ? 2 : hits > 0 ? 1 : 0;
}

/** rank(candidates, {query, cap, now, vettingPath}) -> {query, cap, ranked[], dropped[], skipped_hard_pass[]} */
function rank(candidates, opts) {
  opts = opts || {};
  if (!Array.isArray(candidates)) throw new Error('forge-scout: rank() requires a list of candidates');
  const q = queryWords(opts.query);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cap = Math.max(1, Math.min(RANK_CAP, Number.isInteger(opts.cap) ? opts.cap : RANK_CAP));
  const skipped = [];
  const scored = [];
  for (const c of candidates) {
    const name = c && typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) throw new Error('forge-scout: rank() candidate without a non-empty "name": ' + JSON.stringify(c));
    const prior = isVetted(name, { vettingPath: opts.vettingPath });
    if (prior && prior.verdict === 'hard-pass') { skipped.push(name); continue; }
    const kind = sourceKind(c);
    const desc = words(c.description);
    scored.push({
      name, url: c.url || c.source || null, source_kind: kind,
      web_only: c.web_only === true || kind === 'web',
      scores: { name: nameScore(name, q), description: q.filter((w) => desc.includes(w)).length, source: SOURCE_SCORE[kind], maintenance: maintenanceScore(c.updated, now) },
      prior_verdict: prior ? prior.verdict : null,
    });
  }
  scored.sort((a, b) => (a.web_only - b.web_only) || (b.scores.name - a.scores.name) || (b.scores.description - a.scores.description)
    || (b.scores.source - a.scores.source) || (b.scores.maintenance - a.scores.maintenance) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const ranked = scored.slice(0, cap).map((x, i) => ({ rank: i + 1, ...x }));
  return { query: String(opts.query || ''), cap, ranked, dropped: scored.slice(cap).map((x) => x.name), skipped_hard_pass: skipped };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');

/** adoptPlan(capability, {vettingPath, now, base}) -> {capability, branch, base, steps[]}. Throws unless the
 *  capability's prevailing ledger verdict is approve (a hard-pass or a never-vetted capability is refused). */
function adoptPlan(capability, opts) {
  opts = opts || {};
  const cap = typeof capability === 'string' ? capability.trim() : '';
  if (!cap) throw new Error('forge-scout: adoptPlan() requires a non-empty capability string');
  const prior = isVetted(cap, { vettingPath: opts.vettingPath });
  if (!prior) throw new Error('forge-scout: "' + cap + '" is not vetted; run Scout and record an approve first');
  if (prior.verdict !== 'approve') throw new Error('forge-scout: "' + cap + '" has a hard-pass (' + prior.reason + '); it is never adopted');
  const day = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  const branch = 'scout/adopt-' + slug(cap) + '-' + day;
  const base = opts.base || '<current branch>';
  return {
    capability: cap, branch, base, steps: [
      'from a clean working tree: git switch -c ' + branch,
      'copy only this capability\'s files into the project on that branch; install nothing globally, add no dependency without saying so',
      'audit the copied folder before any review: node .claude/forge-bin/forge-skill-audit.cjs scan <copied folder>; any non-zero exit stops the adopt: 1 = a high finding (until Security Boss has read every flagged line), 3 = not fully scanned (fix the copy and rescan), 2 = the folder was refused',
      'review the diff (git diff ' + base + '...' + branch + ') with forge-code-review by Review Boss; Security Boss as well when it touches credentials, network or hooks',
      'merge only after the owner approves the reviewed diff; MCP-shaped capabilities also need forge-mcp-clients opt-in',
    ],
  };
}

module.exports = {
  terms, record, list, isVetted, rank, adoptPlan, sourceKind,
  loadLedger, loadLedgerFile, saveLedgerFile, defaultLedger, resolvePath, resolveExplicitPath,
  SEED_TEMPLATES, VALID_VERDICTS, CONFIG_PATH, USER_CONFIG_PATH, MAX_TERMS, DISCOVERY_SOURCES, RANK_CAP,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, domain: null, keywords: [], capability: null, verdict: null, reason: null, source: null, query: null, candidates: null, cap: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--keywords') opts.keywords = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--capability') opts.capability = rest[++i];
    else if (a === '--verdict') opts.verdict = rest[++i];
    else if (a === '--reason') opts.reason = rest[++i];
    else if (a === '--source') opts.source = rest[++i];
    else if (a === '--query') opts.query = rest[++i];
    else if (a === '--candidates') opts.candidates = rest[++i];
    else if (a === '--cap') opts.cap = Number(rest[++i]);
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-scout.cjs terms --domain <d> [--keywords <k1,k2,...>] [--json]');
  console.error('       node forge-scout.cjs record --capability <c> --verdict <approve|hard-pass> --reason "<r>" [--source <s>] [--json]');
  console.error('       node forge-scout.cjs list [--json]');
  console.error('       node forge-scout.cjs rank --query "<q>" --candidates <file.json> [--cap N] [--json]');
  console.error('       node forge-scout.cjs adopt-plan --capability <c> [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'terms') {
      if (!opts.domain) { console.error('forge-scout: terms requires --domain <d>'); process.exitCode = 2; }
      else {
        const result = terms({ domain: opts.domain, keywords: opts.keywords }, {});
        if (opts.json) console.log(JSON.stringify(result));
        else {
          console.log('domain: ' + result.domain); for (const t of result.terms) console.log('  - ' + t);
          console.log('sources:');
          for (const s of result.sources) console.log('  - ' + s.name + ' ' + s.url + (s.curated ? '' : ' [UNCURATED]') + ' — ' + s.note);
        }
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'record') {
      if (!opts.capability || !opts.verdict || !opts.reason) {
        console.error('forge-scout: record requires --capability <c> --verdict <approve|hard-pass> --reason "<r>"');
        process.exitCode = 2;
      } else {
        const entry = record({ capability: opts.capability, verdict: opts.verdict, reason: opts.reason, source: opts.source }, {});
        if (opts.json) console.log(JSON.stringify(entry));
        else console.log('recorded [' + entry.verdict + '] ' + entry.capability + ' — ' + entry.reason);
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'list') {
      const result = list({});
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log('forge-scout ledger — ' + result.entries.length + ' entrie(s)');
        for (const e of result.entries) console.log('  [' + e.verdict + '] ' + e.capability + ' — ' + e.reason + (e.source ? ' (' + e.source + ')' : ''));
      }
      process.exitCode = 0;
    } else if (opts.cmd === 'rank') {
      if (!opts.query || !opts.candidates) { console.error('forge-scout: rank requires --query "<q>" --candidates <file.json>'); process.exitCode = 2; }
      else {
        const data = JSON.parse(fs.readFileSync(opts.candidates, 'utf8'));
        const cands = Array.isArray(data) ? data : (data && data.candidates);
        const result = rank(cands, { query: opts.query, cap: Number.isInteger(opts.cap) ? opts.cap : undefined });
        if (opts.json) console.log(JSON.stringify(result));
        else {
          console.log('forge-scout rank — "' + result.query + '" (cap ' + result.cap + ')');
          for (const r of result.ranked) console.log('  ' + r.rank + '. ' + r.name + (r.web_only ? ' [web-only]' : '') + (r.prior_verdict ? ' [already ' + r.prior_verdict + ']' : '') + ' — name ' + r.scores.name + ', description ' + r.scores.description + ', source ' + r.source_kind + ', maintenance ' + r.scores.maintenance);
          if (result.dropped.length) console.log('  beyond the cap: ' + result.dropped.join(', '));
          if (result.skipped_hard_pass.length) console.log('  skipped (prior hard-pass): ' + result.skipped_hard_pass.join(', '));
        }
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'adopt-plan') {
      if (!opts.capability) { console.error('forge-scout: adopt-plan requires --capability <c>'); process.exitCode = 2; }
      else {
        let plan = null;
        try { plan = adoptPlan(opts.capability, {}); } catch (e) { if (/not vetted|hard-pass/.test(e.message)) { console.log(e.message); process.exitCode = 3; } else throw e; }
        if (plan) {
          if (opts.json) console.log(JSON.stringify(plan));
          else { console.log('adopt ' + plan.capability + ' on branch ' + plan.branch + ':'); plan.steps.forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s)); }
          process.exitCode = 0;
        }
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-scout: ' + e.message);
    process.exitCode = 2;
  }
}
