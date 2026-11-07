#!/usr/bin/env node
'use strict';
// forge-citations.cjs — citation ledger for Forge research runs (W2-CITATIONS).
//
// Provenance: idea only, reimplemented in Forge's own design. Source idea: the grounded-citations
// skill of NousResearch/hermes-agent (skills/research/grounded-citations/SKILL.md and
// scripts/sources.py, commit 6fdc365d4bf9a7b37dd674a3d8dfb1215e44779b, fetched 2026-11-06,
// MIT License, Copyright (c) 2025 Nous Research). Ideas taken: a quote counts only when it appears
// verbatim in the fetched page text, matching may ignore whitespace, case and markdown markup,
// quotes need at least 3 words, and claims that cannot be backed carry an [unverified] label.
// No code or text was copied. Differences: a claim-level JSONL ledger (not a url->[n] map), three
// statuses instead of reject-on-attach, and a coverage gate.
//
// Zero dependencies, no shell, no network. Sources are fetched elsewhere; the ledger points at a
// saved text file. Every path is resolved against the project root (resolveRoot: --root, else the
// repo holding this file, else the nearest ancestor of the cwd with a .claude folder strictly below
// the home folder; never the home folder or a drive root, and no cwd fallback: exit 2 instead).
//
// Ledger: JSONL, default <root>/.claude/forge-runs/<run>/citations.jsonl (--run <id>), or
// --ledger <path> (must be inside the root). One record per claim:
//   {claim_id, claim, source_id, source_path, url, quote, retrieved_at, status, reason, checked_at}
// status: verified   = the source text was read and contains the quote
//         unverified = no readable local source (missing, unreadable, url only, too large, outside
//                      the root)
//         mismatch   = the source was read and does not contain the quote (or the quote is < 3 words)
//
// CLI (exit 0 ok, 1 gate failed, 2 usage or safety error):
//   add    --claim <text> --quote <text> [--source <file>] [--url <u>] [--source-id <s>]
//          [--id <claim_id>] [--as-of YYYY-MM-DD]          append one claim, checked at once
//   check  [--json]                                         re-check every claim, rewrite statuses
//   report [--json] [--min-verified <pct>]                  coverage; exit 1 on any mismatch or
//                                                           when verified% < --min-verified
//   label  <file.md> [--write]                              append " [unverified]" after citation
//          markers ([c12] or [^c12]) whose claim is not verified or not in the ledger; prints the
//          result, or with --write rewrites the file in place (target must be inside the root).
//          Fenced code, inline code, link labels ([c1](..)) and the label of a footnote definition
//          ([^c1]:) are skipped; a marker inside a footnote's body is labelled like any other.
//   refs   <file.md> [--json]                              offline reference-list check of ONE report (no ledger, no
//          write, no network; W2-CITE-MACHINE 2026-11-07): markers [1] [1, 3] [2-4] [^id] (Smith 2024) against the
//          References/Sources/Bronnen list both ways (undefined_marker, unused_reference, duplicate_reference,
//          duplicate_work, no_reference_list) and the form of every DOI and arXiv id (malformed_doi,
//          malformed_arxiv). Exit 0 clean, 1 findings, 2 usage/refused. Same target rules and size cap as label.
//          Plain numbered lists and author-year bullets count as references only when the text uses that style;
//          [0,..] intervals, a lone year [2026] and unsorted data lists are not taken for citation markers.
// Common flags: --root <dir> --run <id> | --ledger <path> --max-bytes <n> (source cap, default
// 5 MiB) --allow-outside-sources (follow source paths outside the root).
// report and label evaluate in memory and never write the ledger; check is the only rewriter.
// Safety (Security Boss review 2026-11-06): the root defaults to the repo holding this file and is
// never the home folder or a drive root; UNC/device paths (\\host, //host, \\?\, \\.\) are refused
// before any fs call; label only reads .md/.markdown/.txt inside the root and refuses secret-shaped
// names; writes refuse symlinks and hard links and use an exclusive random temp file; Windows
// reserved names and trailing dot/space are refused; quotes are capped at 1000 characters.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_LEDGER_BYTES = 20 * 1024 * 1024;
const MAX_DRAFT_BYTES = 5 * 1024 * 1024;
const MIN_QUOTE_WORDS = 3;
const MAX_QUOTE_CHARS = 1000;
const LABEL_EXT_RE = /\.(md|markdown|txt)$/i;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(\..*)?$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_ID_RE = /^c\d+$/;
const STATUSES = ['verified', 'unverified', 'mismatch'];

class UsageError extends Error {}

// ---------------------------------------------------------------- matching

// Honest normalisation: only differences a reader would not call a different wording.
function normalizeForMatch(text) {
  let s = String(text || '').normalize('NFKC');
  s = s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');
  s = s.replace(/[‐-―−]/g, '-').replace(/…/g, '...');
  s = s.replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g, '$1'); // [label](url) -> label
  s = s.replace(/\*+|`+|~~/g, '');
  s = s.replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ''); // _emphasis_, not snake_case
  s = s.replace(/\\(?=[^\w\s])/g, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function wordCount(text) {
  const n = normalizeForMatch(text);
  return n ? n.split(' ').length : 0;
}

const isWordChar = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

// True when the already-normalised quote occurs in the normalised text on word boundaries.
function matchNormalized(q, hay) {
  if (!q) return false;
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + 1)) {
    const startOk = !isWordChar(q[0]) || !isWordChar(hay[i - 1]);
    const endOk = !isWordChar(q[q.length - 1]) || !isWordChar(hay[i + q.length]);
    if (startOk && endOk) return true;
  }
  return false;
}

function quoteInText(quote, text) {
  return matchNormalized(normalizeForMatch(quote), normalizeForMatch(text));
}

// ---------------------------------------------------------------- paths

// Lexical only, no fs call: \\host\share, //host/share, \\?\..., \\.\...
const isUncLike = (p) => /^[\\/]{2}/.test(String(p || ''));

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

function samePath(a, b) {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// Real path of p, or of its nearest existing ancestor plus the missing tail. Walks up only on
// ENOENT/ENOTDIR; an existing path whose realpath fails returns null (treated as outside).
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { fs.lstatSync(cur); }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null;
      const up = path.dirname(cur);
      if (up === cur) return null;
      tail.unshift(path.basename(cur));
      cur = up;
      continue;
    }
    try { return path.join(fs.realpathSync.native(cur), ...tail); } catch (e) { return null; }
  }
}

function insideRoot(root, p) {
  const abs = path.resolve(root, p);
  if (isUncLike(abs) && !isUncLike(root)) return false;
  const r = realish(root);
  const c = realish(abs);
  return !!r && !!c && isInside(r, c);
}

// Refuse Windows reserved device names and names ending in a dot or space, in every segment.
function assertSafeNames(input, what) {
  for (const seg of String(input).split(/[\\/]+/)) {
    if (!seg || seg === '.' || seg === '..' || /^[A-Za-z]:$/.test(seg)) continue;
    if (RESERVED_RE.test(seg) || /[. ]$/.test(seg)) throw new UsageError(`${what} has a reserved or trailing-dot/space name: ${seg}`);
  }
}

function isSecretShaped(p) {
  const segs = String(p).split(/[\\/]+/).map((s) => s.toLowerCase());
  const base = segs[segs.length - 1] || '';
  return (base.startsWith('.env') && base !== '.env.example') || /\.(pem|key)$/.test(base) ||
    base.startsWith('id_rsa') || base === '.credentials.json' || segs.includes('secrets');
}

// Refuse writing through a symlink or a hard link (another name for the same file).
function assertWritable(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (st.isSymbolicLink() || st.nlink > 1) throw new UsageError(`refusing to write through a link: ${file}`);
  if (!st.isFile()) throw new UsageError(`write target is not a regular file: ${file}`);
}

// Root: --root (never home or a drive root), else the repo holding this file, else the nearest
// ancestor of cwd with a .claude folder that is strictly below the home folder.
function resolveRoot({ root, cwd = process.cwd(), home = os.homedir(), scriptDir = __dirname } = {}) {
  const banned = (r) => path.parse(r).root === r || samePath(r, home);
  if (root) {
    if (isUncLike(root)) throw new UsageError(`--root is a UNC or device path: ${root}`);
    const r = path.resolve(root);
    if (banned(r)) throw new UsageError(`--root may not be the home folder or a drive root: ${r}`);
    return r;
  }
  const repo = path.resolve(scriptDir, '..', '..');
  if (!banned(repo) && fs.existsSync(path.join(repo, '.claude', 'forge-bin'))) return repo;
  for (let cur = path.resolve(cwd); !banned(cur); cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.claude'))) return cur;
  }
  throw new UsageError('no project root found below the home folder; pass --root <dir>');
}

// ---------------------------------------------------------------- ledger

function ledgerPath(root, { run, ledger }) {
  let p;
  if (ledger) {
    if (isUncLike(ledger) || (isUncLike(path.resolve(root, ledger)) && !isUncLike(root))) {
      throw new UsageError(`ledger is a UNC or device path: ${ledger}`);
    }
    assertSafeNames(ledger, 'ledger path');
    p = path.resolve(root, ledger);
  } else if (run) {
    if (!RUN_RE.test(run) || run.includes('..')) throw new UsageError(`invalid run id: ${run}`);
    assertSafeNames(run, 'run id');
    p = path.join(root, '.claude', 'forge-runs', run, 'citations.jsonl');
  } else throw new UsageError('give --run <id> or --ledger <path>');
  if (!insideRoot(root, p)) throw new UsageError(`ledger path is outside the project root: ${p}`);
  return p;
}

function loadLedger(file) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  if (size > MAX_LEDGER_BYTES) throw new UsageError(`ledger too large (${size} bytes): ${file}`);
  const out = [];
  const seen = new Set();
  fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { throw new UsageError(`ledger line ${i + 1} is not valid JSON: ${file}`); }
    if (!rec || typeof rec !== 'object' || typeof rec.claim_id !== 'string' || !ID_RE.test(rec.claim_id)) {
      throw new UsageError(`ledger line ${i + 1} has no valid claim_id: ${file}`);
    }
    if (seen.has(rec.claim_id)) throw new UsageError(`ledger line ${i + 1} repeats claim_id ${rec.claim_id}: ${file}`);
    seen.add(rec.claim_id);
    out.push(rec);
  });
  return out;
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) { /* short back-off for a Windows file lock */ }
    }
  }
}

// Exclusive random temp file next to the target, renamed over it; removed when anything fails.
function atomicWrite(file, data) {
  assertWritable(file);
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    renameWithRetry(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tmp); }
      catch (e) { if (e.code !== 'ENOENT') process.stderr.write(`forge-citations: could not remove temp file ${tmp}: ${e.code}\n`); }
    }
  }
}

function saveLedger(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

// ---------------------------------------------------------------- evaluation

function evaluateClaim(rec, opts = {}) {
  const root = opts.root || process.cwd();
  const maxBytes = opts.maxBytes || DEFAULT_MAX_SOURCE_BYTES;
  const res = (status, reason) => ({ claim_id: rec.claim_id, status, reason });
  if (!rec.source_path) return res('unverified', rec.url ? 'no_local_source' : 'no_source');
  const abs = path.resolve(root, rec.source_path);
  // Lexical refusal first: a UNC/device path must never reach the fs (it can hit the network).
  if ((isUncLike(rec.source_path) || isUncLike(abs)) && !isUncLike(root)) return res('unverified', 'source_unc_refused');
  if (!opts.allowOutsideSources && !insideRoot(root, abs)) return res('unverified', 'source_outside_root');
  let st;
  try { st = fs.statSync(abs); } catch (e) {
    // EACCES/EPERM: the file may well exist but cannot be read; do not call that missing (W2-REVIEWFIX L6).
    return res('unverified', e && (e.code === 'EACCES' || e.code === 'EPERM') ? 'source_unreadable' : 'source_missing');
  }
  if (!st.isFile()) return res('unverified', 'source_not_a_file');
  if (st.size > maxBytes) return res('unverified', 'source_too_large');
  const key = `${abs}|${st.size}|${st.mtimeMs}`;
  let hay = opts.cache && opts.cache.get(key);
  if (hay === undefined) {
    try { hay = normalizeForMatch(fs.readFileSync(abs, 'utf8')); } catch (e) { return res('unverified', 'source_unreadable'); }
    if (opts.cache) opts.cache.set(key, hay);
  }
  if (String(rec.quote || '').length > MAX_QUOTE_CHARS) return res('mismatch', 'quote_too_long');
  if (wordCount(rec.quote) < MIN_QUOTE_WORDS) return res('mismatch', 'quote_too_short');
  return matchNormalized(normalizeForMatch(rec.quote), hay) ? res('verified', 'quote_found') : res('mismatch', 'quote_not_found');
}

// One normalised-text cache per run, so a source shared by many claims is read once.
function checkRecords(records, opts = {}) {
  const now = new Date().toISOString();
  const o = opts.cache ? opts : { ...opts, cache: new Map() };
  return records.map((r) => {
    const e = evaluateClaim(r, o);
    return { ...r, status: e.status, reason: e.reason, checked_at: now };
  });
}

function coverage(records) {
  const counts = { verified: 0, unverified: 0, mismatch: 0 };
  for (const r of records) counts[STATUSES.includes(r.status) ? r.status : 'unverified']++;
  const total = records.length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    ...counts,
    verified_pct: pct(counts.verified),
    unverified_pct: pct(counts.unverified),
    mismatch_pct: pct(counts.mismatch),
    without_source: records.filter((r) => !r.source_path && !r.url).map((r) => r.claim_id),
    mismatches: records.filter((r) => r.status === 'mismatch').map((r) => ({ claim_id: r.claim_id, reason: r.reason })),
  };
}

// ---------------------------------------------------------------- label

const MARKER_GROUP_RE = /(?:\[\^?[A-Za-z0-9][A-Za-z0-9._-]{0,63}\])+/g;

function labelSegment(seg, statusMap, marked) {
  return seg.replace(MARKER_GROUP_RE, (group, offset, whole) => {
    const next = whole[offset + group.length];
    if (next === '(' || next === ':' || whole[offset - 1] === ']') return group;
    const ids = [...group.matchAll(/\[\^?([^\]]+)\]/g)].map((m) => m[1]);
    if (ids.some((id) => id.toLowerCase() === 'unverified')) return group;
    if (/^\s*\[unverified\]/i.test(whole.slice(offset + group.length))) return group;
    const cited = ids.filter((id) => statusMap.has(id) || DEFAULT_ID_RE.test(id));
    const weak = cited.filter((id) => statusMap.get(id) !== 'verified');
    if (!weak.length) return group;
    marked.push(...weak);
    return group + ' [unverified]';
  });
}

function labelMarkdown(text, statusMap) {
  const marked = [];
  let fence = null;
  const lines = String(text).split('\n').map((line) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return line;
    }
    if (fence) return line;
    return line.split(/(`+[^`]*`+)/).map((seg, i) => (i % 2 ? seg : labelSegment(seg, statusMap, marked))).join('');
  });
  return { text: lines.join('\n'), marked };
}

// ---------------------------------------------------------------- refs (offline reference-list check)

const REF_HEADING_RE = /^(#{1,6})\s+(?:\d+(?:\.\d+)*[.)]?\s+)?(?:references|sources|bronnen|bibliography|works cited|literature|literatuur|referenties)\b/i;
const REF_BOLD_RE = /^\s*\*\*(?:references|sources|bronnen|bibliography|works cited|literatuur|referenties)\s*:?\*\*\s*:?\s*$/i;
const HEADING_RE = /^(#{1,6})\s/;
const NUM_DEF_RE = /^\s*(?:[-*+]\s+)?\[(\d{1,4})\](:?)(?=\s|$)/;
const ORDERED_DEF_RE = /^\s*(\d{1,4})[.)]\s+\S/;
const FOOT_DEF_RE = /^\s{0,3}\[\^([^\]\s]{1,64})\]:/;
const SURNAME = "[\\p{Lu}][\\p{L}'’-]+";
const AY_ENTRY_RE = new RegExp(`^\\s*(?:[-*+]|\\d{1,4}[.)])?\\s*(?:\\*\\*)?(${SURNAME}),?(?:[^\\n]*?)\\(?((?:19|20)\\d{2}[a-z]?)\\)?(?=[.,;:)\\s]|$)`, 'u');
const AY_PART_RE = new RegExp(`^(?:(?:see|cf\\.|e\\.g\\.,?)\\s+)?(${SURNAME})(?:\\s+et al\\.?|\\s+(?:and|&)\\s+${SURNAME})?,?\\s+((?:19|20)\\d{2}[a-z]?)$`, 'u');
const NUM_MARKER_RE = /\[(\d{1,4}(?:\s*[-–]\s*\d{1,4})?(?:\s*,\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?)*)\]/g;
const MAX_RANGE = 200;
const YEAR_RE = /^(?:19|20)\d{2}$/;
const DOI_FORM_RE = /^10\.\d{4,9}\/\S+$/;
const ARXIV_NEW_RE = /^(\d{2})(0[1-9]|1[0-2])\.(\d{4,5})(v\d+)?$/;
// New-style ids began in 0704 with a 4-digit number; from 1501 the number has 5 digits.
function arxivNewOk(v) {
  const m = ARXIV_NEW_RE.exec(v);
  if (!m) return false;
  const yymm = Number(m[1] + m[2]);
  return yymm >= 704 && m[3].length === (yymm >= 1501 ? 5 : 4);
}
const ARXIV_OLD_RE = /^[a-z][a-z-]*(\.[A-Z]{2})?\/\d{2}(0[1-9]|1[0-2])\d{3}(v\d+)?$/;
const REFS_HELP = 'usage: forge-citations.cjs refs <file.md> [--json] [--root <dir>]\n' +
  'Checks ONE markdown/text report offline: in-text markers ([1], [1, 3], [2-4], [^id], (Smith 2024)) against the\n' +
  'reference list (a References/Sources/Bronnen heading, [n] entries, [^id]: definitions) both ways, duplicate ids and\n' +
  'works, and the form of every DOI and arXiv id. It never fetches anything: resolving a reference at a canonical\n' +
  'source stays the agent\'s job (skills/forge-research-evidence/references/citation-existence.md).\n' +
  'Exit 0 = clean, 1 = findings, 2 = usage or refused input. Read-only: refs never writes.\n';

// Text without fenced code blocks and inline code (blanked, so line numbers stay true).
function proseLines(text) {
  let fence = null;
  return String(text).replace(/^﻿/, '').split(/\r?\n/).map((line) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return '';
    }
    return fence ? '' : line.replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length));
  });
}

// Line indexes that belong to a references section: from its heading to the next heading of the same or a higher level.
function refSectionLines(lines) {
  const inRef = new Array(lines.length).fill(false);
  let level = 0;
  lines.forEach((line, i) => {
    const h = line.match(HEADING_RE);
    if (level && h && h[1].length <= level) level = 0;
    if (REF_HEADING_RE.test(line)) { level = line.match(HEADING_RE)[1].length; return; }
    if (REF_BOLD_RE.test(line)) { level = 7; return; }
    if (level) inRef[i] = true;
  });
  return inRef;
}

function expandIds(list) {
  const ids = [];
  for (const part of list.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > MAX_RANGE) { ids.push(String(a)); continue; }
    for (let n = a; n <= b; n++) ids.push(String(n));
  }
  return ids;
}

const ayKey = (surname, year) => `${surname.toLowerCase()} ${year.toLowerCase()}`;
const unbalanced = (t) => (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length;
// Drop what a DOI picked up from its sentence: markup, and a closing paren it never opened (also before . , ; :).
function stripTrail(s) {
  let t = s.replace(/[>\]"'*_]+$/, '');
  for (;;) {
    if (/\)$/.test(t) && unbalanced(t)) t = t.slice(0, -1);
    else if (/\)[.,;:]+$/.test(t) && unbalanced(t.replace(/[.,;:]+$/, ''))) t = t.replace(/\)[.,;:]+$/, '');
    else return t;
  }
}

// DOI and arXiv candidates of one line; pushes findings, returns normalised work ids for duplicate detection.
// A bare DOI needs "10.<digits>/" (so 10.5 or 10.15.7 is a version, not a DOI); "arxiv:" needs a digit or "archive/".
function idForms(line, n, findings) {
  const works = [];
  const DX = /(?:https?:\/\/(?:dx\.)?doi\.org\/([^\s<>"'\]`]*)|\bdoi:\s*(\d[^\s<>"'\]`]*))/gi; // "DOI:…" is prose
  for (const m of line.matchAll(DX)) checkDoi(stripTrail(m[1] !== undefined ? m[1] : m[2]), n, findings, works);
  for (const m of line.matchAll(/(?<![\w./:-])(?<![Dd][Oo][Ii]:\s+)10\.\d+\/[^\s<>"'\]`]*/g)) checkDoi(stripTrail(m[0]), n, findings, works);
  const AX = /(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^\s<>"'\]`)]*)|\barxiv(?::\s*|\s+)(\d[^\s<>"'\]`)]*|[a-z][a-z.-]*\/[^\s<>"'\]`)]*))/gi;
  for (const m of line.matchAll(AX)) {
    const v = (m[1] || m[2]).replace(/[>\]"'*_]+$/, '').replace(/\.pdf$/i, '').replace(/[.,;:]+$/, '');
    if (arxivNewOk(v) || ARXIV_OLD_RE.test(v)) works.push('arxiv:' + v.replace(/v\d+$/, '').toLowerCase());
    else findings.push({ kind: 'malformed_arxiv', line: n, id: v, detail: `"${v}" is not YYMM.NNNNN[vN] or archive/YYMMNNN[vN]` });
  }
  return works;
}

function checkDoi(v, n, findings, works) {
  if (/[.,;:]$/.test(v)) {
    findings.push({ kind: 'malformed_doi', line: n, id: v, detail: `"${v}" has trailing punctuation; a copied DOI would not resolve` });
  } else if (!DOI_FORM_RE.test(v)) {
    findings.push({ kind: 'malformed_doi', line: n, id: v, detail: `"${v}" is not 10.<4-9 digits>/<suffix>` });
  } else works.push('doi:' + v.toLowerCase());
}

// checkRefs(text) -> {references, markers, findings[{kind, line, id, detail}]}; pure, no fs, no network.
function checkRefs(text) {
  const lines = proseLines(text);
  const inRef = refSectionLines(lines);
  const defs = new Map(); // key -> {line, style, strict}
  const findings = [];
  const workOwner = new Map();
  const define = (key, n, style, strict) => {
    if (defs.has(key)) findings.push({ kind: 'duplicate_reference', line: n, id: key, detail: `reference ${key} is already defined on line ${defs.get(key).line}` });
    else defs.set(key, { line: n, style, strict });
    return key;
  };
  const uses = { num: new Map(), foot: new Map(), ay: new Map(), year: new Map() };
  const use = (style, key, n) => { if (!uses[style].has(key)) uses[style].set(key, n); };
  let markers = 0;
  let numGroups = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    let key = null;
    let body = line;
    const fd = line.match(FOOT_DEF_RE);
    if (fd) { key = define('^' + fd[1], n, 'foot', true); body = line.slice(fd[0].length); }
    else if (inRef[i]) {
      const nd = line.match(NUM_DEF_RE);
      const od = !nd && line.match(ORDERED_DEF_RE);
      const ay = !nd && !od && line.match(AY_ENTRY_RE);
      if (nd) { key = define(nd[1], n, 'num', true); body = ''; }
      else if (od) { key = define(od[1], n, 'num', false); body = ''; }
      else if (ay) { key = define(ayKey(ay[1], ay[2]), n, 'ay', false); body = ''; }
    } else {
      const nd = line.match(/^\s{0,3}\[(\d{1,4})\]:\s*\S/);
      if (nd) { key = define(nd[1], n, 'num', true); body = ''; }
    }
    for (const w of idForms(line, n, findings)) {
      if (key === null) continue;
      const owner = workOwner.get(w);
      if (owner && owner !== key) findings.push({ kind: 'duplicate_work', line: n, id: key.replace(/^\^/, ''), detail: `${w} is also reference ${owner.replace(/^\^/, '')}` });
      else workOwner.set(w, key);
    }
    if (inRef[i] && !fd) return;
    for (const m of body.matchAll(/\[\^([^\]\s]{1,64})\](?!:)/g)) { markers++; use('foot', '^' + m[1], n); }
    for (const m of body.matchAll(NUM_MARKER_RE)) {
      const before = body[m.index - 1] || '';
      const after = body[m.index + m[0].length] || '';
      if (after === '(' || after === ':' || /[\p{L}\p{N}_!\\]/u.test(before)) continue;
      if (before === ']' && /,/.test(m[1])) continue;
      const ids = expandIds(m[1]);
      if (ids.includes('0')) continue; // [0,1] is an interval: reference lists start at 1
      markers++;
      // [2026] alone is a year (a video title, a table cell), not a citation, unless a reference [2026] exists.
      if (YEAR_RE.test(m[1])) { use('year', m[1], n); continue; }
      // An unsorted list ([18,3,10,2] in a JSON line) is data: it still counts as a use, but not as a citation-style sign.
      if (ids.every((id, k) => k === 0 || Number(id) > Number(ids[k - 1]))) numGroups++;
      for (const id of ids) use('num', id, n);
    }
    for (const m of body.matchAll(/\(([^()\n]{3,200})\)/g)) {
      for (const part of m[1].split(';')) {
        const a = part.trim().match(AY_PART_RE);
        if (a) { markers++; use('ay', ayKey(a[1], a[2]), n); }
      }
    }
  });
  for (const [id, n] of uses.year) if (defs.has(id)) use('num', id, n);
  const styleDefs = (style) => [...defs].filter(([, d]) => d.style === style);
  const hasAyList = styleDefs('ay').length > 0;
  for (const style of ['num', 'foot', 'ay']) {
    if (style === 'ay' && !hasAyList) continue;
    for (const [key, n] of uses[style]) {
      if (defs.has(key)) continue;
      if (style === 'num' && !styleDefs('num').length) continue;
      findings.push({ kind: 'undefined_marker', line: n, id: key.replace(/^\^/, ''), detail: `marker ${key.replace(/^\^/, '')} has no reference entry` });
    }
    const anyUse = uses[style].size > 0;
    for (const [key, d] of styleDefs(style)) {
      if (uses[style].has(key) || (!d.strict && !anyUse)) continue;
      findings.push({ kind: 'unused_reference', line: d.line, id: key.replace(/^\^/, ''), detail: `reference ${key.replace(/^\^/, '')} is never cited in the text` });
    }
  }
  // One lone bracket group ([31,15,46,4,6] in a JSON line) is too weak a sign of a citation style; two or more are not.
  if (numGroups >= 2 && !styleDefs('num').length) {
    const first = Math.min(...uses.num.values());
    findings.push({ kind: 'no_reference_list', line: first, id: null, detail: `${numGroups} numeric marker(s) but no reference list` });
  }
  findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return { references: defs.size, markers, findings };
}

// ---------------------------------------------------------------- CLI

const VALUE_FLAGS = new Set(['root', 'run', 'ledger', 'claim', 'quote', 'source', 'url', 'source-id', 'as-of', 'id', 'min-verified', 'max-bytes']);
const BOOL_FLAGS = new Set(['json', 'write', 'allow-outside-sources', 'help']);
const USAGE = 'usage: forge-citations.cjs <add|check|report|label> [--root <dir>] (--run <id> | --ledger <path>) [options] | refs <file.md> [--json]; see the file header';

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      flags[name] = argv[++i];
    } else throw new UsageError(`unknown flag --${name}`);
  }
  return { cmd: pos[0], pos: pos.slice(1), flags };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function positiveInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

function nextId(records) {
  let max = 0;
  for (const r of records) { const m = /^c(\d+)$/.exec(r.claim_id); if (m) max = Math.max(max, Number(m[1])); }
  return `c${max + 1}`;
}

function cmdAdd(f, ctx, io) {
  if (!f.claim || !f.quote) throw new UsageError('add needs --claim and --quote');
  const asOf = f['as-of'] || today();
  if (!validDate(asOf)) throw new UsageError(`--as-of must be YYYY-MM-DD: ${asOf}`);
  const records = loadLedger(ctx.ledger);
  const id = f.id || nextId(records);
  if (!ID_RE.test(id)) throw new UsageError(`invalid claim id: ${id}`);
  if (records.some((r) => r.claim_id === id)) throw new UsageError(`claim id already in the ledger: ${id}`);
  const base = {
    claim_id: id,
    claim: f.claim,
    source_id: f['source-id'] || (f.source ? path.basename(f.source) : f.url || null),
    source_path: f.source || null,
    url: f.url || null,
    quote: f.quote,
    retrieved_at: asOf,
  };
  const [rec] = checkRecords([base], ctx.opts);
  fs.mkdirSync(path.dirname(ctx.ledger), { recursive: true });
  assertWritable(ctx.ledger);
  fs.appendFileSync(ctx.ledger, JSON.stringify(rec) + '\n');
  io.out(`[${rec.claim_id}] ${rec.status} (${rec.reason})\n`);
  return 0;
}

function cmdCheck(f, ctx, io) {
  const checked = checkRecords(loadLedger(ctx.ledger), ctx.opts);
  saveLedger(ctx.ledger, checked);
  if (f.json) io.out(JSON.stringify({ ledger: ctx.ledger, claims: checked, summary: coverage(checked) }, null, 2) + '\n');
  else {
    for (const r of checked) io.out(`[${r.claim_id}] ${r.status} (${r.reason})\n`);
    const c = coverage(checked);
    io.out(`${c.total} claims: ${c.verified} verified, ${c.unverified} unverified, ${c.mismatch} mismatch\n`);
  }
  return 0;
}

function cmdReport(f, ctx, io) {
  const c = coverage(checkRecords(loadLedger(ctx.ledger), ctx.opts));
  const min = f['min-verified'] === undefined ? null : Number(f['min-verified']);
  if (min !== null && (!Number.isFinite(min) || min < 0 || min > 100)) throw new UsageError('--min-verified must be 0..100');
  const failures = [];
  if (c.mismatch) failures.push(`${c.mismatch} mismatch`);
  if (min !== null && c.verified_pct < min) failures.push(`verified ${c.verified_pct}% < ${min}%`);
  if (f.json) io.out(JSON.stringify({ ledger: ctx.ledger, ...c, min_verified: min, pass: !failures.length, failures }, null, 2) + '\n');
  else {
    io.out(`Citation coverage (${ctx.ledger})\n`);
    io.out(`  total ${c.total}: verified ${c.verified} (${c.verified_pct}%), unverified ${c.unverified} (${c.unverified_pct}%), mismatch ${c.mismatch} (${c.mismatch_pct}%)\n`);
    io.out(`  without any source: ${c.without_source.length ? c.without_source.join(', ') : 'none'}\n`);
    for (const m of c.mismatches) io.out(`  mismatch ${m.claim_id} (${m.reason})\n`);
    io.out(failures.length ? `FAIL: ${failures.join('; ')}\n` : 'PASS\n');
  }
  return failures.length ? 1 : 0;
}

// One text document inside the root (label and refs): UNC refused before any fs call, safe names, .md/.markdown/.txt,
// no secret-shaped name, inside the root after resolving links, a regular file under MAX_DRAFT_BYTES.
function resolveTextTarget(root, input, cmd) {
  if (!input) throw new UsageError(`${cmd} needs a markdown file`);
  if (isUncLike(input) || (isUncLike(path.resolve(root, input)) && !isUncLike(root))) {
    throw new UsageError(`${cmd} target is a UNC or device path: ${input}`);
  }
  assertSafeNames(input, `${cmd} target`);
  if (!LABEL_EXT_RE.test(input)) throw new UsageError(`${cmd} only reads .md, .markdown or .txt files: ${input}`);
  if (isSecretShaped(input)) throw new UsageError(`${cmd} refuses a secret-shaped file name: ${input}`);
  const file = path.resolve(root, input);
  if (!insideRoot(root, file)) throw new UsageError(`${cmd} target is outside the project root: ${file}`);
  let st;
  try { st = fs.statSync(file); } catch (e) { throw new UsageError(`${cmd} target cannot be read (${e.code || e.message}): ${file}`); }
  if (!st.isFile()) throw new UsageError(`${cmd} target is not a file: ${file}`);
  if (st.size > MAX_DRAFT_BYTES) throw new UsageError(`markdown file too large (${st.size} bytes)`);
  return file;
}

function cmdRefs(f, pos, ctx, io) {
  const file = resolveTextTarget(ctx.root, pos[0], 'refs');
  const r = checkRefs(fs.readFileSync(file, 'utf8'));
  const pass = r.findings.length === 0;
  if (f.json) io.out(JSON.stringify({ file, ...r, pass }, null, 2) + '\n');
  else {
    io.out(`References check (${file}): ${r.references} reference(s), ${r.markers} marker(s)\n`);
    for (const x of r.findings) io.out(`  line ${x.line}: ${x.kind}${x.id ? ' ' + x.id : ''} (${x.detail})\n`);
    io.out(pass ? 'PASS\n' : `FAIL: ${r.findings.length} finding(s)\n`);
  }
  return pass ? 0 : 1;
}

function cmdLabel(f, pos, ctx, io) {
  const file = resolveTextTarget(ctx.root, pos[0], 'label');
  const checked = checkRecords(loadLedger(ctx.ledger), ctx.opts);
  const statusMap = new Map(checked.map((r) => [r.claim_id, r.status]));
  const { text, marked } = labelMarkdown(fs.readFileSync(file, 'utf8'), statusMap);
  if (f.write) {
    atomicWrite(file, text);
    io.out(`labelled ${marked.length} marker(s) in ${file}${marked.length ? ': ' + marked.join(', ') : ''}\n`);
  } else {
    io.out(text);
    io.err(`labelled ${marked.length} marker(s)\n`);
  }
  return 0;
}

function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const { cmd, pos, flags } = parseArgs(argv);
    if (flags.help) { io.out(USAGE + '\n' + REFS_HELP); return 0; }
    if (!['add', 'check', 'report', 'label', 'refs'].includes(cmd)) throw new UsageError(cmd ? `unknown command: ${cmd}` : 'no command');
    const root = realish(resolveRoot({ root: flags.root }));
    if (!root) throw new UsageError('the project root cannot be resolved');
    if (cmd === 'refs') return cmdRefs(flags, pos, { root }, io);
    const ctx = {
      root,
      ledger: ledgerPath(root, flags),
      opts: {
        root,
        maxBytes: flags['max-bytes'] ? positiveInt(flags['max-bytes'], 'max-bytes') : DEFAULT_MAX_SOURCE_BYTES,
        allowOutsideSources: !!flags['allow-outside-sources'],
      },
    };
    if (cmd === 'add') return cmdAdd(flags, ctx, io);
    if (cmd === 'check') return cmdCheck(flags, ctx, io);
    if (cmd === 'report') return cmdReport(flags, ctx, io);
    return cmdLabel(flags, pos, ctx, io);
  } catch (e) {
    if (e instanceof UsageError) { io.err(`forge-citations: ${e.message}\n${USAGE}\n`); return 2; }
    io.err(`forge-citations: ${e.code ? e.code + ' ' : ''}${e.message}\n`);
    return 2;
  }
}

module.exports = {
  normalizeForMatch, quoteInText, wordCount, isInside, insideRoot, evaluateClaim, checkRecords,
  coverage, labelMarkdown, checkRefs, loadLedger, saveLedger, ledgerPath, main, STATUSES, MIN_QUOTE_WORDS,
  DEFAULT_MAX_SOURCE_BYTES, MAX_QUOTE_CHARS, resolveRoot, isUncLike, isSecretShaped, UsageError,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
