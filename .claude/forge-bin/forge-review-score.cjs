#!/usr/bin/env node
'use strict';
/**
 * forge-review-score.cjs — review lenses made mechanical (work package).
 *
 * Three read-only helpers for the forge-code-review method (.claude/skills/forge-code-review/SKILL.md):
 *
 *   scan     --diff <file|-> | --file <path> (repeatable)   lens "swallowed errors": a deterministic, line-based
 *            pre-scan (JS/TS, Python, Go, shell, PowerShell, n8n workflow JSON) that PROPOSES candidate findings
 *            with file:line. In diff mode only constructs that touch an added line are proposed. Every candidate
 *            has needs_confirmation:true — the reviewer confirms or rejects it; the scan is not a verdict.
 *   coverage --diff <file|-> [--root <dir>]                lens "behaviour coverage" (HEURISTIC, labelled so): the
 *            changed functions/files of non-test code, and whether a changed test in the diff or (with --root) an
 *            existing test file mentions them. A gap is rated high/medium/low by a keyword heuristic.
 *   filter   --findings <file> --scores <file> [--threshold N]   confidence filter: every finding needs a 0-100
 *            confidence from an INDEPENDENT second scoring pass (scorer !== reviewer). Findings under the threshold
 *            (default 80) are dropped, but kept in a "dropped" list with the reason — nothing silently vanishes.
 *
 * Common flags: --out <file> writes the JSON there (the ONLY write this tool ever does; the parent folder must exist),
 * otherwise stdout. --format md prints a short markdown table instead (filter only).
 * Exit codes: 0 ok · 1 refused / invalid input · 2 usage. Zero dependencies, no network, no clock, no randomness.
 *
 * findings.json: {"reviewer": "<who>", "findings": [{"id","lens","severity","file","line","title",...}]}
 *   (the scan / coverage output is accepted as findings input as-is). A confidence inside a finding is IGNORED.
 * scores.json:   {"scorer": "<who, not the reviewer>", "scores": {"<finding id>": {"confidence": 0-100, "reason": "..."}}}
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DEFAULT_THRESHOLD = 80;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TEST_FILE_BYTES = 1024 * 1024;
const MAX_TEST_FILES = 5000;
const EVIDENCE_MAX = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '_scratch', 'coverage', '.next', 'vendor', '__pycache__']);

const LANG_BY_EXT = {
  '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py', '.go': 'go', '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'ps', '.psm1': 'ps', '.json': 'json',
};
const COMMENT_RE = { js: /^\s*(\/\/|\/\*|\*)/, py: /^\s*#/, go: /^\s*(\/\/|\/\*|\*)/, sh: /^\s*#/, ps: /^\s*(#|<#)/, json: /^$/ };
const langOf = (file) => LANG_BY_EXT[path.extname(file).toLowerCase()] || null;

// ---------- line rules (one line decides) ----------
const FALLBACK = String.raw`(\[\s*\]|\{\s*\}|null|undefined|false|''|""|0)`;
const LINE_RULES = [
  { id: 'js-empty-catch-inline', lang: 'js', re: /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/, sev: 'HIGH', title: 'empty catch block: the error is swallowed' },
  { id: 'js-promise-catch-swallow', lang: 'js', re: new RegExp(String.raw`\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|\(?\s*` + FALLBACK + String.raw`\s*\)?)\s*\)`), sev: 'HIGH', title: 'promise .catch turns a failure into an empty value' },
  { id: 'js-error-to-fallback-inline', lang: 'js', re: new RegExp(String.raw`\bcatch\s*(\([^)]*\))?\s*\{\s*return\s*` + FALLBACK + String.raw`?\s*;?\s*\}`), sev: 'MEDIUM', title: 'error turned into an empty/neutral value without logging or context' },
  { id: 'js-promise-catch-noop', lang: 'js', re: /\.catch\(\s*(noop|function\s*\(\s*\w*\s*\)\s*\{\s*\})\s*\)/, sev: 'HIGH', title: 'promise .catch with a no-op handler' },
  { id: 'js-rethrow-lost-stack', lang: 'js', re: /throw\s+new\s+\w*Error\([^;]*\b(e|err|error|ex)\.message\b(?![^;]*cause)/, sev: 'MEDIUM', title: 're-throw keeps only the message: the original stack/cause is lost' },
  { id: 'js-call-no-timeout', lang: 'js', re: /\b(fetch|axios\.(get|post|put|patch|delete|request)|https?\.(get|request))\(/, unless: /signal|timeout|AbortSignal/i, window: 3, sev: 'MEDIUM', title: 'network call without a timeout or abort signal' },
  { id: 'py-except-pass-inline', lang: 'py', re: /^\s*except\b[^:]*:\s*(pass|\.\.\.|continue)\s*(#.*)?$/, sev: 'HIGH', title: 'except clause that silently passes/continues' },
  { id: 'py-raise-lost-chain', lang: 'py', re: /raise\s+\w+\(\s*(str\(\s*(e|err|ex|exc)\s*\)|f?["'].*\{(e|err|ex|exc)\}.*["'])\s*\)\s*$/, sev: 'MEDIUM', title: 're-raise without "from": the original traceback chain is lost' },
  { id: 'py-request-no-timeout', lang: 'py', re: /\b(requests|httpx|session)\.(get|post|put|patch|delete|request)\(/, unless: /timeout\s*=/, window: 3, sev: 'MEDIUM', title: 'HTTP call without timeout= (a scraper/bot can hang forever)' },
  { id: 'go-discarded-error', lang: 'go', re: /^\s*(\w+\s*,\s*)?_\s*:?=\s*[\w.]+\(/, sev: 'MEDIUM', title: 'a returned value (often the error) is discarded with _' },
  { id: 'go-default-http-client', lang: 'go', re: /\bhttp\.(Get|Post|Head)\(|&http\.Client\{\s*\}/, sev: 'MEDIUM', title: 'default HTTP client: no timeout' },
  { id: 'sh-or-true', lang: 'sh', re: /\|\|\s*(true|:)\s*(;|$|#)/, sev: 'MEDIUM', title: '"|| true" hides a failing command' },
  { id: 'sh-errexit-off', lang: 'sh', re: /^\s*set\s+\+e\b/, sev: 'MEDIUM', title: 'set +e: failures no longer stop the script' },
  { id: 'sh-curl-no-timeout', lang: 'sh', re: /\bcurl\b/, unless: /--max-time|--connect-timeout|\s-m\s?\d/, window: 0, sev: 'LOW', title: 'curl without --max-time' },
  { id: 'ps-empty-catch-inline', lang: 'ps', re: /\bcatch\s*(\[[^\]]*\]\s*)?\{\s*\}/i, sev: 'HIGH', title: 'empty catch block: the error is swallowed' },
  { id: 'ps-silent-error-action', lang: 'ps', re: /-ErrorAction\s+(SilentlyContinue|Ignore)\b|\$ErrorActionPreference\s*=\s*['"]?(SilentlyContinue|Ignore)/i, sev: 'MEDIUM', title: 'ErrorAction SilentlyContinue/Ignore hides failures' },
  { id: 'ps-web-no-timeout', lang: 'ps', re: /\bInvoke-(WebRequest|RestMethod)\b/i, unless: /-TimeoutSec/i, window: 0, sev: 'LOW', title: 'web request without -TimeoutSec' },
  { id: 'n8n-continue-on-fail', lang: 'json', re: /"continueOnFail"\s*:\s*true|"onError"\s*:\s*"continue(Regular|Error)Output"/, sev: 'HIGH', title: 'n8n node continues on failure: route it to an error branch instead' },
];

// ---------- block rules (a handler line + the lines after it) ----------
const BLOCK_START = {
  js: /\bcatch\s*(\([^)]*\))?\s*\{\s*(\/\/.*)?$/, ps: /\bcatch\s*(\[[^\]]*\]\s*)?\{\s*(#.*)?$/i,
  py: /^\s*except\b[^:]*:\s*(#.*)?$/, go: /^\s*if\s+err\s*!=\s*nil\s*\{\s*$/,
};
const FALLBACK_RETURN = { js: new RegExp(String.raw`^return\s*` + FALLBACK + String.raw`?\s*;?$`), ps: /^return(\s+\$null|\s+@\(\)|\s+\$false)?\s*$/i,
  py: /^return(\s+(None|\[\]|\{\}|""|''|False|0))?\s*$/, go: /^return\s+nil\s*$/ };
const WEBHOOK_ACK = /\bres\.(sendStatus\(\s*200|status\(\s*200)|return\s+.*,\s*200\b|Response\(\s*status\s*=\s*200|StatusCode\s*=\s*200|WriteHeader\(\s*(200|http\.StatusOK)/;
const BLOCK_END = { js: /^\}/, ps: /^\}/, go: /^\}/ };

function shortId(parts) { return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10); }
function clip(s) { const t = String(s).trim(); return t.length > EVIDENCE_MAX ? t.slice(0, EVIDENCE_MAX) + '…' : t; }

function candidate(rule, file, line, endLine, text, lens) {
  return { id: (lens === 'behaviour-coverage' ? 'cov-' : 'sw-') + shortId([rule.id, file, String(line)]), lens: lens || 'swallowed-errors',
    rule: rule.id, severity: rule.sev, file, line, end_line: endLine, title: rule.title, evidence: clip(text),
    source: 'pre-scan', needs_confirmation: true };
}

/** Body lines of a handler block that starts at index i (stops at the closing brace / dedent). */
function blockBody(seg, i, lang) {
  const body = [];
  if (lang === 'py') {
    const ind = seg[i].text.match(/^\s*/)[0].length;
    for (let k = i + 1; k < seg.length && body.length < 8; k++) {
      const t = seg[k].text; if (!t.trim()) continue;
      if (t.match(/^\s*/)[0].length <= ind) break; body.push(seg[k]);
    }
    return { body, closed: true };
  }
  for (let k = i + 1; k < seg.length && body.length < 8; k++) {
    const t = seg[k].text.trim(); if (!t) continue;
    if (BLOCK_END[lang].test(t)) return { body, closed: true, end: seg[k] };
    body.push(seg[k]);
  }
  return { body, closed: false };
}

function scanBlocks(seg, file, lang, out) {
  const start = BLOCK_START[lang]; if (!start) return;
  const comment = COMMENT_RE[lang];
  for (let i = 0; i < seg.length; i++) {
    if (!start.test(seg[i].text) || comment.test(seg[i].text)) continue;
    const { body, closed, end } = blockBody(seg, i, lang);
    if (!closed) continue; // the hunk ends mid-block: not enough context to judge
    const code = body.filter((b) => !comment.test(b.text)).map((b) => b.text.trim());
    const touched = [seg[i]].concat(body, end ? [end] : []).some((b) => b.added);
    if (!touched) continue;
    const last = (end || body[body.length - 1] || seg[i]).n;
    let rule = null;
    if (code.length === 0 && lang !== 'py') rule = { id: lang === 'go' ? 'go-empty-err-branch' : lang + '-empty-catch', sev: 'HIGH', title: lang === 'go' ? 'empty if err != nil branch: the error is swallowed' : 'empty catch block (empty or comments only): the error is swallowed' };
    else if (lang === 'py' && code.length === 1 && /^(pass|\.\.\.|continue)$/.test(code[0])) rule = { id: 'py-except-pass', sev: 'HIGH', title: 'except clause that silently passes/continues' };
    else if (code.some((c) => WEBHOOK_ACK.test(c))) rule = { id: lang + '-webhook-ack-on-error', sev: 'HIGH', title: 'error path answers 200 OK: the webhook sender never retries and the failure is lost' };
    else if (code.length === 1 && FALLBACK_RETURN[lang].test(code[0])) rule = { id: lang + '-error-to-fallback', sev: 'MEDIUM', title: 'error turned into an empty/neutral value without logging or context' };
    if (rule) out.push(candidate(rule, file, seg[i].n, last, seg[i].text + ' … ' + code.join(' ')));
  }
}

function scanLines(seg, file, lang, out) {
  const comment = COMMENT_RE[lang];
  for (let i = 0; i < seg.length; i++) {
    const L = seg[i];
    if (!L.added || comment.test(L.text)) continue;
    for (const rule of LINE_RULES) {
      if (rule.lang !== lang || !rule.re.test(L.text)) continue;
      if (rule.unless) {
        const win = seg.slice(i, i + 1 + (rule.window || 0)).map((x) => x.text).join('\n');
        if (rule.unless.test(win)) continue;
      }
      out.push(candidate(rule, file, L.n, L.n, L.text));
    }
  }
}

/** File-level rules that need the whole (new) file: n8n workflow without an error workflow, transaction without rollback. */
function scanWhole(seg, file, lang, out) {
  const all = seg.map((s) => s.text).join('\n');
  if (lang === 'json' && /"nodes"\s*:/.test(all) && /"connections"\s*:/.test(all) && !/"errorWorkflow"\s*:/.test(all)) {
    out.push(candidate({ id: 'n8n-no-error-workflow', sev: 'MEDIUM', title: 'n8n workflow has no settings.errorWorkflow: failures go unnoticed' }, file, 1, seg.length, 'no "errorWorkflow" in settings'));
  }
  if (lang && lang !== 'json') {
    const begin = seg.find((s) => s.added && /\b(beginTransaction|BEGIN\s+TRANSACTION|\.begin\(\)|BeginTransaction\()/i.test(s.text));
    if (begin && !/rollback/i.test(all)) out.push(candidate({ id: 'tx-no-rollback', sev: 'HIGH', title: 'transaction started without a rollback path in view' }, file, begin.n, begin.n, begin.text));
  }
}

// ---------- diff parsing ----------
/** Parse a unified (git) diff into [{file, oldFile, segments:[[{n,text,added}]], removed:[text]}] (new-file line numbers). */
function parseDiff(text) {
  const files = []; let cur = null, seg = null, n = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) { cur = { file: null, oldFile: null, segments: [], removed: [], hunkHeaders: [] }; files.push(cur); seg = null; continue; }
    if (raw.startsWith('--- ')) { if (!cur) { cur = { file: null, oldFile: null, segments: [], removed: [], hunkHeaders: [] }; files.push(cur); } cur.oldFile = raw.slice(4).replace(/^a\//, '').trim(); continue; }
    if (raw.startsWith('+++ ') && cur && !seg) { const f = raw.slice(4).trim(); cur.file = f === '/dev/null' ? null : f.replace(/^b\//, ''); continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h && cur) { n = Number(h[1]); seg = []; cur.segments.push(seg); cur.hunkHeaders.push(h[2].trim()); continue; }
    if (!seg) continue;
    if (raw.startsWith('+')) seg.push({ n: n++, text: raw.slice(1), added: true });
    else if (raw.startsWith(' ') || raw === '') seg.push({ n: n++, text: raw.slice(1), added: false });
    else if (raw.startsWith('-')) cur.removed.push(raw.slice(1));
  }
  return files.filter((f) => f.file || f.oldFile);
}

function scanSegments(file, segments, wholeFile) {
  const lang = langOf(file); const out = [];
  if (!lang) return out;
  for (const seg of segments) { scanLines(seg, file, lang, out); scanBlocks(seg, file, lang, out); }
  if (wholeFile) scanWhole(segments[0] || [], file, lang, out);
  const seen = new Set();
  return out.filter((c) => { const k = c.file + ':' + c.line + ':' + c.title; if (seen.has(k)) return false; seen.add(k); return true; });
}

function scanDiff(diffText) {
  const findings = [];
  for (const f of parseDiff(diffText)) {
    if (!f.file) continue; // deleted file: nothing new can swallow an error
    const isNew = f.oldFile === '/dev/null';
    findings.push(...scanSegments(f.file, f.segments, isNew));
  }
  return findings;
}

function scanFile(file, text) {
  const seg = String(text).split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t, added: true }));
  return scanSegments(file, [seg], true);
}

// ---------- behaviour coverage (heuristic) ----------
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$|\.tests\.ps1$|\.bats$/i;
const FN_RES = [
  /\bfunction\s+([A-Za-z_$][\w$-]*)/, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*def\s+([A-Za-z_]\w*)/, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^\s*([A-Za-z_][\w]*)\s*\(\)\s*\{/,
  /^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
];
const CRIT = [['high', /auth|login|token|passw|secret|payment|pay(out)?\b|billing|checkout|invoice|webhook|migrat|delete|remove|crypto|sign|hmac|session|permission|role/i],
  ['medium', /api|route|handler|controller|\bdb\b|query|sql|store|save|write|parse|validat|import|export|sync|send/i]];
const isTestPath = (p) => TEST_PATH_RE.test(p.replace(/\\/g, '/'));
const criticality = (s) => { for (const [lvl, re] of CRIT) if (re.test(s)) return lvl; return 'low'; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function functionNames(lines) {
  const names = new Set();
  for (const l of lines) for (const re of FN_RES) { const m = String(l).match(re); if (m && m[1].length > 2) names.add(m[1]); }
  return [...names];
}

/** Names of the functions that enclose an added line (the nearest declaration above it inside the hunk, or the hunk header). */
function enclosingNames(f) {
  const names = new Set();
  f.segments.forEach((seg, i) => {
    let cur = functionNames([f.hunkHeaders[i] || ''])[0] || null;
    for (const l of seg) { const d = functionNames([l.text])[0]; if (d) cur = d; if (l.added && cur) names.add(cur); }
  });
  return [...names];
}

function listTestFiles(root, skipped) {
  const out = []; const stack = [root];
  while (stack.length && out.length < MAX_TEST_FILES) {
    const dir = stack.pop(); let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped.push((path.relative(root, dir) || '.') + ' (' + (e.code || e.message) + ')'); continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(p); } else if (e.isFile() && isTestPath(path.relative(root, p))) out.push(p);
    }
  }
  if (stack.length) skipped.push('search stopped at ' + MAX_TEST_FILES + ' test files');
  return out;
}

function readTest(root, p, skipped) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  try {
    if (fs.statSync(p).size > MAX_TEST_FILE_BYTES) { skipped.push(rel + ' (larger than ' + MAX_TEST_FILE_BYTES + ' bytes)'); return null; }
    return { p: rel, t: fs.readFileSync(p, 'utf8') };
  } catch (e) { skipped.push(rel + ' (' + (e.code || e.message) + ')'); return null; }
}

const firstAdded = (f) => { const a = f.segments.flat().find((s) => s.added); return a ? a.n : 1; };

function coverage(diffText, root) {
  const files = parseDiff(diffText).filter((f) => f.file);
  const diffTests = files.filter((f) => isTestPath(f.file));
  const diffTestText = diffTests.map((f) => f.segments.flat().map((s) => s.text).join('\n')).join('\n');
  let existing = null; const notes = ['heuristic: a name mention in a test is not proof the behaviour is asserted; the reviewer confirms each gap'];
  if (root) {
    const skipped = [];
    existing = listTestFiles(root, skipped).map((p) => readTest(root, p, skipped)).filter(Boolean);
    if (skipped.length) notes.push('not searched: ' + skipped.slice(0, 10).join('; ') + (skipped.length > 10 ? ' and ' + (skipped.length - 10) + ' more' : ''));
  } else notes.push('existing tests were NOT searched (no --root given)');
  const changed = []; const findings = [];
  for (const f of files) {
    if (isTestPath(f.file) || !langOf(f.file) || langOf(f.file) === 'json') continue;
    const touched = f.segments.flat().filter((s) => s.added).map((s) => s.text).concat(f.removed, f.hunkHeaders);
    const names = [...new Set(functionNames(touched).concat(enclosingNames(f)))];
    const base = path.basename(f.file).replace(/\.[^.]+$/, '');
    const units = names.length ? names : [base];
    const entry = { file: f.file, functions: [] };
    const mention = (name) => {
      const re = new RegExp('\\b' + escapeRe(name) + '\\b');
      const inDiff = diffTests.filter((t) => re.test(t.segments.flat().map((s) => s.text).join('\n'))).map((t) => t.file);
      if (inDiff.length) return { covered: 'diff-test', tests: inDiff };
      const ex = existing ? existing.filter((x) => re.test(x.t)).map((x) => x.p).slice(0, 5) : [];
      return ex.length ? { covered: 'existing-test', tests: ex } : { covered: 'none', tests: [] };
    };
    const fileHit = mention(base);
    for (const name of units) {
      let m = mention(name);
      if (m.covered === 'none' && fileHit.covered !== 'none') m = { covered: 'file-test-indirect', tests: fileHit.tests };
      const crit = criticality(f.file + ' ' + name);
      entry.functions.push({ name, covered: m.covered, tests: m.tests, criticality: crit });
      if (m.covered === 'none') {
        const sev = crit === 'high' ? 'HIGH' : crit === 'medium' ? 'MEDIUM' : 'LOW';
        findings.push(candidate({ id: 'cov-untested-change', sev, title: 'changed behaviour "' + name + '" has no test that mentions it (' + crit + ' criticality, heuristic)' }, f.file, firstAdded(f), null, name, 'behaviour-coverage'));
      } else if (m.covered === 'file-test-indirect' && crit === 'high') {
        findings.push(candidate({ id: 'cov-indirect-only', sev: 'MEDIUM', title: 'high-criticality change "' + name + '" is only tested indirectly (a test mentions the file, not this function; heuristic)' }, f.file, firstAdded(f), null, name, 'behaviour-coverage'));
      }
    }
    changed.push(entry);
  }
  return { kind: 'forge-review-coverage', version: 1, heuristic: true, reviewer: 'forge-review-score coverage', notes, changed_files: changed, findings };
}

// ---------- confidence filter ----------
function filterFindings(findingsDoc, scoresDoc, opts) {
  const threshold = opts && opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) return { error: 'threshold must be an integer 0-100' };
  if (!findingsDoc || !Array.isArray(findingsDoc.findings)) return { error: 'findings JSON needs a "findings" array' };
  if (!scoresDoc || typeof scoresDoc.scores !== 'object' || scoresDoc.scores === null || Array.isArray(scoresDoc.scores)) return { error: 'scores JSON needs a "scores" object keyed by finding id' };
  const reviewer = String(findingsDoc.reviewer || '').trim(), scorer = String(scoresDoc.scorer || '').trim();
  if (!scorer) return { error: 'scores JSON must name its "scorer" (the independent second pass)' };
  if (reviewer && scorer.toLowerCase() === reviewer.toLowerCase()) return { error: 'the scorer is the reviewer: the confidence pass must be independent' };
  const ids = new Set(); const kept = [], dropped = [];
  for (const raw of findingsDoc.findings) {
    const f = Object.assign({}, raw); delete f.confidence; // a self-assigned confidence never counts
    const id = typeof f.id === 'string' && f.id ? f.id : null;
    if (!id) { dropped.push(Object.assign(f, { confidence: null, reason: 'finding has no id, so it cannot be scored' })); continue; }
    if (ids.has(id)) { dropped.push(Object.assign(f, { confidence: null, reason: 'duplicate finding id' })); continue; }
    ids.add(id);
    const s = Object.prototype.hasOwnProperty.call(scoresDoc.scores, id) ? scoresDoc.scores[id] : undefined;
    const c = s && typeof s === 'object' ? s.confidence : s;
    if (s === undefined) { dropped.push(Object.assign(f, { confidence: null, reason: 'no independent score' })); continue; }
    if (!Number.isInteger(c) || c < 0 || c > 100) { dropped.push(Object.assign(f, { confidence: null, reason: 'invalid score (needs an integer 0-100)' })); continue; }
    const scored = Object.assign(f, { confidence: c, score_reason: s && typeof s === 'object' && s.reason ? String(s.reason) : null });
    if (c >= threshold) kept.push(scored); else dropped.push(Object.assign(scored, { reason: 'below threshold (' + c + ' < ' + threshold + ')' }));
  }
  const orphan = Object.keys(scoresDoc.scores).filter((k) => !ids.has(k));
  return { kind: 'forge-review-scored', version: 1, threshold, reviewer: reviewer || null, scorer, kept, dropped, orphan_scores: orphan,
    counts: { in: findingsDoc.findings.length, kept: kept.length, dropped: dropped.length } };
}

function toMarkdown(r) {
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = ['Confidence filter: threshold ' + r.threshold + ', scorer ' + cell(r.scorer) + ', kept ' + r.counts.kept + ' of ' + r.counts.in + '.', '',
    '| Severity | Confidence | Finding | File | Evidence |', '|---|---|---|---|---|'];
  for (const f of r.kept) lines.push('| ' + [f.severity, f.confidence, f.title, (f.file || '') + (f.line ? ':' + f.line : ''), f.evidence].map(cell).join(' | ') + ' |');
  lines.push('', 'Dropped (' + r.dropped.length + '):');
  for (const f of r.dropped) lines.push('- ' + cell(f.id || '(no id)') + ' ' + cell(f.title) + ': ' + cell(f.reason));
  return lines.join('\n') + '\n';
}

// ---------- CLI ----------
function parseArgs(argv) {
  const a = { _: [], file: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--file') a.file.push(argv[++i]);
    else if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else a._.push(k);
  }
  return a;
}

function readInput(p, label) {
  if (typeof p !== 'string' || !p) throw new Error('missing ' + label);
  if (p === '-') return fs.readFileSync(0, 'utf8');
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error(label + ' is not a file: ' + p);
  if (st.size > MAX_INPUT_BYTES) throw new Error(label + ' is larger than ' + MAX_INPUT_BYTES + ' bytes: ' + p);
  return fs.readFileSync(p, 'utf8');
}
const readJson = (p, label) => { try { return JSON.parse(readInput(p, label)); } catch (e) { throw new Error(label + ': ' + e.message, { cause: e }); } };

function emit(result, args, io) {
  const text = args.format === 'md' && result.kind === 'forge-review-scored' ? toMarkdown(result) : JSON.stringify(result, null, 2) + '\n';
  if (typeof args.out === 'string') {
    const dir = path.dirname(path.resolve(args.out));
    if (!fs.existsSync(dir)) throw new Error('--out folder does not exist: ' + dir);
    fs.writeFileSync(path.resolve(args.out), text); // the only write this tool does
    io.out('wrote ' + path.resolve(args.out) + '\n');
  } else io.out(text);
}

const USAGE = 'usage: forge-review-score.cjs scan (--diff <file|-> | --file <path>...) | coverage --diff <file|-> [--root <dir>] | filter --findings <file> --scores <file> [--threshold 0-100] [--format md]   [--out <file>]\n';

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };
  const args = parseArgs(argv); const cmd = args._[0];
  try {
    if (cmd === 'scan') {
      if (typeof args.diff !== 'string' && !args.file.length) { io.err(USAGE); return 2; }
      const findings = typeof args.diff === 'string' ? scanDiff(readInput(args.diff, '--diff')) : [];
      for (const f of args.file) findings.push(...scanFile(String(f).replace(/\\/g, '/'), readInput(f, '--file')));
      emit({ kind: 'forge-review-candidates', version: 1, lens: 'swallowed-errors', reviewer: 'forge-review-score pre-scan',
        note: 'candidates only: confirm or reject each one, then score them in an independent pass', findings }, args, io);
      return 0;
    }
    if (cmd === 'coverage') {
      if (typeof args.diff !== 'string') { io.err(USAGE); return 2; }
      const root = typeof args.root === 'string' ? path.resolve(args.root) : null;
      if (root && !fs.existsSync(root)) { io.err('--root does not exist: ' + root + '\n'); return 1; }
      emit(coverage(readInput(args.diff, '--diff'), root), args, io); return 0;
    }
    if (cmd === 'filter') {
      if (typeof args.findings !== 'string' || typeof args.scores !== 'string') { io.err(USAGE); return 2; }
      const threshold = args.threshold === undefined ? undefined : Number(args.threshold);
      const r = filterFindings(readJson(args.findings, '--findings'), readJson(args.scores, '--scores'), { threshold });
      if (r.error) { io.err('refused: ' + r.error + '\n'); return 1; }
      emit(r, args, io); return 0;
    }
  } catch (e) { io.err('error: ' + e.message + '\n'); return 1; }
  io.err(USAGE); return 2;
}

module.exports = { parseDiff, scanDiff, scanFile, coverage, filterFindings, toMarkdown, isTestPath, criticality, main, DEFAULT_THRESHOLD, LINE_RULES };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
