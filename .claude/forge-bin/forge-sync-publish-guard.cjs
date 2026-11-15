'use strict';
/**
 * forge-sync-publish-guard.cjs — two blockers for `forge-sync publish-template --apply` (category tests round 8,
 * 2026-11-07). Zero-dependency (fs/path/crypto only). Required lazily by forge-sync.cjs (publishApplyBlockers, fail
 * closed when it cannot be loaded) and by forge-doctor.cjs only when `--receipt` is passed.
 *
 * Why. Two failures reached the published template the same day and made fresh installs roll back:
 *   P1  a NEW published test required a module that the shipping manifest keeps local-only, so every installed project's
 *       doctor failed with "Cannot find module". The development tree's own doctor was green: the module exists there.
 *   P2  a command file grew past its byte budget; the suite that pins the budget runs only in the FULL doctor, and the
 *       publish ran after two hand-picked suites (the same happened in round 5, finding I1).
 *
 * 1. STATIC: every published test (*.test.cjs / *.test.mjs / *.test.js) is tokenised (strings, template literals,
 *    comments and regex literals are told apart, so a require() inside a comment or inside fixture text is no load) and
 *    its relative targets are collected: require('./x'), require(`./x`), require(path.join|resolve(__dirname, 'a', 'b'))
 *    with literal segments only, import ... from './x', import './x', import('./x'), export ... from './x'. A target that
 *    resolves (Node's order: exact, .js, .json, .node, index.js, index.json) to a file of the development tree that is NOT
 *    in the published set — or to a file outside .claude/ at all — refuses the publish, naming test:line, the target and
 *    the fix. A target that exists nowhere is left to the doctor (it fails in the development tree as well). A load behind
 *    an existence check that names the same file — `if (fs.existsSync(path.join(__dirname, 'x.cjs'))) { require('./x.cjs') }`,
 *    a braceless if, or `existsSync(...'x.cjs'...) ? require(...) : null` / `&&` — is portable (skipped where the file is
 *    absent; forge-init.test.cjs does this for the local-only forge-plugin-build.cjs) and is not a finding. FIX-SYNC D-F2: the
 *    check counts only as `[fs.]existsSync(path.join|resolve(__dirname, '<lit>', ...))` whose path resolves to the load target,
 *    never negated, as the whole if-condition (or an && chain of such checks) or as the test of a `?` / `&&` on the same line;
 *    every guarded load is listed in the publish plan (guardedLoads), never passed silently. Not seen
 *    (stated limits): a require() of a variable or a computed path, a guard on a variable path, and spawn/fork targets.
 * 2. FULL-DOCTOR RECEIPT: `node .claude/forge-bin/forge-doctor.cjs --receipt` (opt-in; development tree only) hashes the
 *    published set before and after its run and writes <dev root>/_scratch/forge-doctor-receipt.json (git-ignored, never
 *    published): {schema, ok, doctor_ok, fingerprint_stable, started_at, finished_at, root, published_fingerprint,
 *    published_count, published_files, tests, failing_checks}. ok = the doctor was green AND no published file changed
 *    while it ran. The fingerprint is sha256 over the sorted [path, sha256] pairs of exactly the files publish-template
 *    hashes (publishSourceSet). --apply refuses unless that receipt exists, is valid (its fingerprint matches its own file
 *    list), belongs to this tree, is not dated in the future, says ok:true, and its fingerprint equals the published set
 *    NOW — so an older run (bytes changed since), a red run or another tree's run can never satisfy it. Required only
 *    when the development tree has forge-bin/forge-doctor.cjs (no doctor: installs cannot run one either). The one way
 *    around it is --skip-doctor-receipt "<reason>" (forge-sync prints a WARNING; the reason and the receipt state go into
 *    the template's publish receipt); it never bypasses the static check.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCTOR_RECEIPT_SCHEMA = 'forge-doctor-receipt/v1';
const DOCTOR_RECEIPT_REL = '_scratch/forge-doctor-receipt.json'; // relative to the development tree's root (above .claude)
const DOCTOR_REL = 'forge-bin/forge-doctor.cjs';
const DEV_TREE_MARKER_REL = 'config/forge-dev-tree.json';
const TEST_FILE_RE = /\.test\.(?:c|m)?js$/;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
// FIX-SYNC C-F8: doctor checks that judge this tree's own run records (forge-runs/), which publish-template never ships and an
// install never runs against — a receipt red only on these still proves the published bytes.
const RUN_STATE_CHECKS = new Set(['run_contract']);
const NAMES_MAX = 6;
const RERUN = 'run "node .claude/forge-bin/forge-doctor.cjs --receipt" in the development tree (it runs every suite, the way an install does), then publish';
const ESCAPE = 'an owner-approved exception is --apply --skip-doctor-receipt "<reason>" (warned and recorded)';

let syncMod = null;
function syncLib() { if (!syncMod) syncMod = require('./forge-sync.cjs'); return syncMod; } // lazy: forge-sync requires this file
const sha256Str = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const foldCase = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
const toPosix = (p) => String(p).split(path.sep).join('/');
const isSha = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
function realOf(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }

// ---------------------------------------------------------------------------------------------------------------------
// 1. the static scan
// ---------------------------------------------------------------------------------------------------------------------
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/;

function readQuoted(s, i, q) {
  let j = i + 1, v = '', esc = false, nl = 0;
  while (j < s.length && s[j] !== q && s[j] !== '\n') {
    if (s[j] === '\\') { esc = true; if (s[j + 1] === '\n') nl++; v += s[j + 1] || ''; j += 2; continue; }
    v += s[j]; j++;
  }
  return { value: v, esc, nl, end: Math.min(j + 1, s.length) };
}
function skipExpr(s, j) {
  let depth = 1;
  while (j < s.length && depth > 0) {
    const c = s[j];
    if (c === '\'' || c === '"') { j = readQuoted(s, j, c).end; continue; }
    if (c === '`') { j = skipTemplate(s, j); continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    j++;
  }
  return j;
}
function skipTemplate(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && s[j + 1] === '{') { j = skipExpr(s, j + 2); continue; }
    j++;
  }
  return s.length;
}
function skipRegex(s, i) {
  let j = i + 1, inClass = false;
  while (j < s.length) {
    const c = s[j];
    if (c === '\n') return -1;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; while (j < s.length && /[A-Za-z]/.test(s[j])) j++; return j; }
    j++;
  }
  return -1;
}
const countNl = (s, a, b) => { let k = 0; for (let x = a; x < b; x++) if (s.charCodeAt(x) === 10) k++; return k; };

/** lexTokens(src) -> [{t:'id'|'str'|'tpl'|'re'|'num'|'p', v?, esc?, line}] — just enough JavaScript to tell code from
 *  strings, template literals, comments and regex literals (a `/` starts a regex after an operator, `(`/`,`/`{`..., a
 *  keyword such as return, or at the start; after a name, a number, `)` or `]` it is a division). */
function lexTokens(src) {
  const s = String(src || '');
  const toks = [];
  let i = 0, line = 1;
  if (s.startsWith('#!')) while (i < s.length && s[i] !== '\n') i++;
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'p') return p.v !== ')' && p.v !== ']';
    return p.t === 'id' && REGEX_AFTER_WORD.has(p.v);
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; i++; continue; }
    if (c <= ' ' || c === ' ' || c === '﻿') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); const end = e === -1 ? s.length : e + 2; line += countNl(s, i, end); i = end; continue; }
    if (c === '\'' || c === '"') { const r = readQuoted(s, i, c); toks.push({ t: 'str', v: r.value, esc: r.esc, line }); line += r.nl; i = r.end; continue; }
    if (c === '`') {
      const end = skipTemplate(s, i);
      const body = s.slice(i + 1, end - 1);
      toks.push(body.includes('${') || body.includes('\\') ? { t: 'tpl', line } : { t: 'str', v: body, esc: false, line });
      line += countNl(s, i, end); i = end; continue;
    }
    if (c === '/' && regexAllowed()) { const end = skipRegex(s, i); if (end > 0) { toks.push({ t: 're', line }); i = end; continue; } }
    if (ID_START.test(c)) { let j = i + 1; while (j < s.length && ID_PART.test(s[j])) j++; toks.push({ t: 'id', v: s.slice(i, j), line }); i = j; continue; }
    if (c >= '0' && c <= '9') { let j = i + 1; while (j < s.length && /[0-9A-Za-z_.]/.test(s[j])) j++; toks.push({ t: 'num', line }); i = j; continue; }
    toks.push({ t: 'p', v: c, line }); i++;
  }
  return toks;
}

function matchParen(T, open) {
  let depth = 0;
  for (let k = open; k < T.length; k++) {
    if (T[k].t !== 'p') continue;
    if (T[k].v === '(') depth++;
    else if (T[k].v === ')' && --depth === 0) return k;
  }
  return -1;
}
/** existsCallAt(T, k) -> {segs, end} | null — FIX-SYNC D-F2: an existence check counts as a guard only in its exact portable
 *  form: `[fs.]existsSync(path.join|resolve(__dirname, '<lit>', ...))` with literal segments only. `end` is the index of the
 *  ')' that closes existsSync(...). Anything else (a variable, a cwd-relative string, a computed segment) is no guard. */
function existsCallAt(T, k) {
  const isP = (j, v) => !!T[j] && T[j].t === 'p' && T[j].v === v;
  const isId = (j, v) => !!T[j] && T[j].t === 'id' && T[j].v === v;
  let j = k;
  if (isId(j, 'fs') && isP(j + 1, '.')) j += 2;
  if (!isId(j, 'existsSync') || !isP(j + 1, '(') || !isId(j + 2, 'path') || !isP(j + 3, '.') || !(isId(j + 4, 'join') || isId(j + 4, 'resolve')) || !isP(j + 5, '(') || !isId(j + 6, '__dirname')) return null;
  const segs = [];
  let m = j + 7;
  while (isP(m, ',') && T[m + 1] && T[m + 1].t === 'str' && !T[m + 1].esc) { segs.push(T[m + 1].v); m += 2; }
  if (!segs.length || !isP(m, ')') || !isP(m + 1, ')')) return null;
  return { segs, end: m + 1 };
}
/** ifConditionGuards(T, open, close) -> [segs] — the guarded paths of an if-condition that is exactly one existence check or a
 *  chain of them joined by `&&` (never negated, never mixed with anything else); [] otherwise. */
function ifConditionGuards(T, open, close) {
  const out = [];
  let k = open + 1;
  while (k < close) {
    const c = existsCallAt(T, k);
    if (!c) return [];
    out.push(c.segs);
    k = c.end + 1;
    if (k === close) return out;
    if (!(T[k] && T[k].t === 'p' && T[k].v === '&' && T[k + 1] && T[k + 1].t === 'p' && T[k + 1].v === '&')) return [];
    k += 2;
  }
  return [];
}
const guardName = (segs) => path.posix.basename(String(segs[segs.length - 1]).replace(/\\/g, '/'));

/** requireRefs(src) -> [{kind:'spec', spec, line, guards} | {kind:'dirname', fn, segs, line, guards}] — every LITERAL load
 *  target (relative or not; the caller keeps the relative ones). A method call (`x.require(...)`) and a variable target are
 *  not loads. `guards` = the file names an enclosing existence check tests: the block or braceless statement after
 *  `if (existsSync(path.join(__dirname, ..., '<name>')))`, or the same line after `existsSync(...) ?` / `&&` (exact forms only,
 *  see existsCallAt); `guardPaths` = those checks' __dirname path segments, which unpublishedTestRequires compares. */
function requireRefs(src) {
  const T = lexTokens(src);
  const isP = (k, v) => !!T[k] && T[k].t === 'p' && T[k].v === v;
  const isId = (k, v) => !!T[k] && T[k].t === 'id' && T[k].v === v;
  const lit = (k) => !!T[k] && T[k].t === 'str' && !T[k].esc;
  const out = [];
  const frames = [[]]; // one guard list (of guarded path segments) per open brace (the root first)
  const ifClose = new Map(); // index of the ')' that closes an if-condition -> the paths its existence checks test
  // FIX-SYNC D-F2: a statement guard comes ONLY from an exact, non-negated existence check in a test position (`<check> ?` or
  // `<check> &&`); it covers that line up to the next ';', ',', ':' or brace — a comma declaration, the else branch of a
  // ternary, or the next line of a statement without a semicolon are never guarded by it.
  let stmt = null, single = null, pendingBlock = null;
  const guardsNow = (line) => {
    const all = [].concat(...frames, stmt && stmt.line === line ? stmt.paths : [], single ? single.paths : []);
    const seen = new Set(), paths = [];
    for (const segs of all) { const key = segs.join('\u0000'); if (!seen.has(key)) { seen.add(key); paths.push(segs); } }
    return { guards: [...new Set(paths.map(guardName))], guardPaths: paths };
  };
  const ref = (o, line) => Object.assign(o, guardsNow(line));
  for (let k = 0; k < T.length; k++) {
    const tk = T[k];
    if (tk.t === 'p') {
      if (tk.v === '{') { frames.push(pendingBlock || []); pendingBlock = null; stmt = null; }
      else if (tk.v === '}') { if (frames.length > 1) frames.pop(); stmt = null; if (single && frames.length - 1 < single.depth) single = null; }
      else if (tk.v === ';') { stmt = null; if (single && frames.length - 1 === single.depth) single = null; }
      else if (tk.v === ',' || tk.v === ':') stmt = null;
      else if (tk.v === ')' && ifClose.has(k)) { const paths = ifClose.get(k); if (isP(k + 1, '{')) pendingBlock = paths; else if (paths.length) single = { paths, depth: frames.length - 1 }; }
      continue;
    }
    if (tk.t !== 'id') continue;
    const afterDot = isP(k - 1, '.');
    if (!afterDot && tk.v === 'if' && isP(k + 1, '(')) {
      const close = matchParen(T, k + 1);
      if (close > 0) ifClose.set(close, ifConditionGuards(T, k + 1, close));
      continue;
    }
    if (!afterDot && (tk.v === 'fs' || tk.v === 'existsSync') && !isP(k - 1, '!')) {
      const c = existsCallAt(T, k);
      if (c && (isP(c.end + 1, '?') || (isP(c.end + 1, '&') && isP(c.end + 2, '&')))) stmt = { paths: [c.segs], line: tk.line };
      if (c) { k = c.end; continue; } // past the call: the ',' between its path segments must not end the statement guard
    }
    if (afterDot) continue;
    if (tk.v === 'require' && isP(k + 1, '(')) {
      if (lit(k + 2) && isP(k + 3, ')')) { out.push(ref({ kind: 'spec', spec: T[k + 2].v, line: tk.line }, tk.line)); continue; }
      if (isId(k + 2, 'path') && isP(k + 3, '.') && (isId(k + 4, 'join') || isId(k + 4, 'resolve')) && isP(k + 5, '(') && isId(k + 6, '__dirname')) {
        const segs = [];
        let j = k + 7;
        while (isP(j, ',') && lit(j + 1)) { segs.push(T[j + 1].v); j += 2; }
        if (segs.length && isP(j, ')') && isP(j + 1, ')')) out.push(ref({ kind: 'dirname', fn: T[k + 4].v, segs, line: tk.line }, tk.line));
      }
      continue;
    }
    if (tk.v === 'import' && isP(k + 1, '(') && lit(k + 2) && isP(k + 3, ')')) { out.push(ref({ kind: 'spec', spec: T[k + 2].v, line: tk.line }, tk.line)); continue; }
    if ((tk.v === 'import' || tk.v === 'from') && lit(k + 1)) out.push(ref({ kind: 'spec', spec: T[k + 1].v, line: tk.line }, tk.line));
  }
  return out;
}

function refLabel(ref) { return ref.kind === 'dirname' ? 'path.' + ref.fn + '(__dirname, ' + ref.segs.map((x) => "'" + x + "'").join(', ') + ')' : "'" + ref.spec + "'"; }
function resolveRef(fromAbs, ref) {
  const base = path.dirname(fromAbs);
  const target = ref.kind === 'dirname' ? path.resolve(base, ...ref.segs) : path.resolve(base, ref.spec);
  for (const c of [target, target + '.js', target + '.json', target + '.node', path.join(target, 'index.js'), path.join(target, 'index.json')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }
  }
  return null;
}

/** unpublishedTestRequires(devDir, publishedRels) -> {scanned, findings[{test, line, spec, target, where}], guarded[],
 *  unreadable[]}. where: 'unpublished' (a .claude file outside the published set) | 'outside-claude' (a file of the
 *  checkout outside .claude/, which publish-template never ships). A load behind an existence check that names the same
 *  file (see requireRefs) is portable — it is skipped where the file is absent — and is listed under `guarded` instead. */
function unpublishedTestRequires(devDir, publishedRels) {
  const dev = path.resolve(devDir), devRoot = path.dirname(dev);
  const rels = [...publishedRels];
  const published = new Set(rels.map(foldCase));
  const findings = [], unreadable = [], guarded = [];
  let scanned = 0;
  for (const rel of rels) {
    if (!TEST_FILE_RE.test(rel)) continue;
    const abs = path.join(dev, ...rel.split('/'));
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { unreadable.push(rel); continue; }
    scanned++;
    for (const ref of requireRefs(src)) {
      if (ref.kind === 'spec' && !/^\.\.?(?:\/|$)/.test(ref.spec)) continue; // a package or built-in, not a tree file
      const hit = resolveRef(abs, ref);
      if (!hit) continue; // exists nowhere: the doctor fails on it in the development tree too
      const inClaude = toPosix(path.relative(dev, hit));
      const inRoot = toPosix(path.relative(devRoot, hit));
      const f = { test: rel, line: ref.line, spec: ref.kind === 'dirname' ? refLabel(ref) : ref.spec };
      if (inClaude && !inClaude.startsWith('../') && inClaude !== '..' && !path.isAbsolute(inClaude)) {
        if (published.has(foldCase(inClaude))) continue;
        Object.assign(f, { target: inClaude, where: 'unpublished' });
      } else if (inRoot && !inRoot.startsWith('../') && !path.isAbsolute(inRoot)) Object.assign(f, { target: inRoot, where: 'outside-claude' });
      else continue;
      // FIX-SYNC D-F2: the check must name the SAME file (its __dirname path resolves to the load target), not a same-named one
      const hitKey = foldCase(hit);
      if ((ref.guardPaths || []).some((segs) => foldCase(path.resolve(path.dirname(abs), ...segs)) === hitKey)) guarded.push(f); else findings.push(f);
    }
  }
  return { scanned, findings, guarded, unreadable };
}
function requireFindingsReason(findings) {
  const shown = findings.slice(0, NAMES_MAX).map((f) => f.test + ':' + f.line + ' requires ' + (/^path\./.test(f.spec) ? f.spec : "'" + f.spec + "'") + ' -> ' + f.target + (f.where === 'outside-claude' ? ' (outside .claude/, never published)' : ' (not published)'));
  return findings.length + ' published test(s) require a module the template will not get, so every installed project\'s doctor would fail with "Cannot find module": '
    + shown.join('; ') + (findings.length > NAMES_MAX ? '; … +' + (findings.length - NAMES_MAX) + ' more' : '')
    + ' — fix: mark each such test local-only too (a FORGE_SHIP_MANIFEST.json rule like its module\'s), or publish the module'
    + ' (or load it only behind if (fs.existsSync(path.join(__dirname, \'<module>\'))) when the test must stay portable)';
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. the full-doctor receipt
// ---------------------------------------------------------------------------------------------------------------------
/** fingerprintOf({rel: sha256}) -> sha256 over the sorted [rel, hash] pairs. */
function fingerprintOf(hashes) {
  const keys = Object.keys(hashes || {}).sort();
  return sha256Str(JSON.stringify(keys.map((k) => [k, hashes[k]])));
}
/** publishedHashes(devDir) -> {rel: sha256} of exactly what publish-template would publish (unreadable files left out,
 *  as the plan leaves them out). Throws when the tree has no shipping manifest of its own. */
function publishedHashes(devDir) {
  const S = syncLib();
  const dev = path.resolve(devDir);
  const out = {};
  for (const rel of S.publishSourceSet(dev).files.keys()) {
    const h = S.sha256(path.join(dev, ...rel.split('/')));
    if (h) out[rel] = h;
  }
  return out;
}
function doctorReceiptPath(devDir) { return path.join(path.dirname(path.resolve(devDir)), ...DOCTOR_RECEIPT_REL.split('/')); }
function doctorRequired(devDir) { try { return fs.statSync(path.join(path.resolve(devDir), ...DOCTOR_REL.split('/'))).isFile(); } catch { return false; } }
function isDevTree(devDir) {
  try { return JSON.parse(fs.readFileSync(path.join(path.resolve(devDir), ...DEV_TREE_MARKER_REL.split('/')), 'utf8')).dev_tree === true; } catch { return false; }
}

/** beginDoctorReceipt(root, opts) -> start token. Called by forge-doctor.cjs --receipt BEFORE the run; throws (the
 *  doctor refuses before any self-test) outside a development tree or when the published set cannot be listed. */
function beginDoctorReceipt(root, opts) {
  const o = opts || {};
  const r = path.resolve(root);
  const devDir = path.join(r, '.claude');
  if (!isDevTree(devDir)) throw new Error('--receipt is only for the Forge development tree (' + path.join(devDir, ...DEV_TREE_MARKER_REL.split('/')) + ' with dev_tree:true is missing): publish-template reads the receipt there');
  const hashes = publishedHashes(devDir);
  return { root: r, devDir, startedAt: typeof o.nowIso === 'string' ? o.nowIso : new Date().toISOString(), hashes, fingerprint: fingerprintOf(hashes) };
}
/** finishDoctorReceipt(start, report, opts) -> {path, receipt}. Re-hashes the published set, then writes the receipt. */
function finishDoctorReceipt(start, report, opts) {
  const o = opts || {};
  let after = null;
  try { after = fingerprintOf(publishedHashes(start.devDir)); } catch { after = null; }
  const stable = after === start.fingerprint;
  const doctorOk = !!report && report.ok === true;
  const checks = (report && report.checks && typeof report.checks === 'object') ? report.checks : {};
  const tests = checks.tests && typeof checks.tests === 'object' ? checks.tests : {};
  const num = (x) => (Number.isFinite(x) ? x : null);
  const receipt = {
    schema: DOCTOR_RECEIPT_SCHEMA, ok: doctorOk && stable, doctor_ok: doctorOk, fingerprint_stable: stable,
    started_at: start.startedAt, finished_at: typeof o.nowIso === 'string' ? o.nowIso : new Date().toISOString(), root: realOf(start.root),
    published_fingerprint: start.fingerprint, published_count: Object.keys(start.hashes).length, published_files: start.hashes,
    tests: { suites: num(tests.suites), suitesFailed: num(tests.suitesFailed), passed: num(tests.passed), failed: num(tests.failed),
      // SD-FLAKE: suites that were green only on their one retry — the receipt is never silently green
      flaky: Array.isArray(tests.flaky) ? tests.flaky : [] },
    failing_checks: Object.keys(checks).filter((k) => checks[k] && checks[k].ok === false).sort(),
    note: stable ? null : 'a published file changed while the doctor ran — this run proves nothing about the bytes publish-template would ship',
  };
  const file = doctorReceiptPath(start.devDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, fs.readFileSync(tmp)); try { fs.unlinkSync(tmp); } catch { /* left beside it, harmless */ } }
  return { path: file, receipt };
}

/** judgeDoctorReceipt(devDir, hashes, nowMs) -> {state, problem, receipt, path}. state: green | missing | invalid | foreign
 *  | future | red | unstable | mismatch. problem is null only for green. */
function judgeDoctorReceipt(devDir, hashes, nowMs) {
  const file = doctorReceiptPath(devDir);
  const res = (state, problem, receipt) => ({ state, problem, receipt: receipt || null, path: file });
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return res(e.code === 'ENOENT' ? 'missing' : 'invalid', e.code === 'ENOENT' ? 'none at ' + file : 'not valid (' + file + ' cannot be read: ' + e.code + ')'); }
  let r;
  try { r = JSON.parse(raw); } catch { return res('invalid', 'not valid (' + file + ' is not JSON — a truncated or hand-edited file)'); }
  if (!r || typeof r !== 'object' || r.schema !== DOCTOR_RECEIPT_SCHEMA) return res('invalid', 'not valid (schema is not ' + DOCTOR_RECEIPT_SCHEMA + ')');
  if (typeof r.ok !== 'boolean' || !isSha(r.published_fingerprint) || !r.published_files || typeof r.published_files !== 'object' || Array.isArray(r.published_files)
    || typeof r.root !== 'string' || !Number.isFinite(Date.parse(r.finished_at))) return res('invalid', 'not valid (a required field is missing or malformed)', r);
  if (fingerprintOf(r.published_files) !== r.published_fingerprint) return res('invalid', 'not valid (its fingerprint does not match its own file list — edited by hand?)', r);
  // FB-SYNC-D-F1: finishDoctorReceipt writes ok = doctor_ok && fingerprint_stable, and a green doctor has no failing
  // check; a receipt whose ok contradicts its own fields was edited by hand and proves nothing
  if (r.ok !== (r.doctor_ok === true && r.fingerprint_stable === true) || (r.ok && !(Array.isArray(r.failing_checks) && r.failing_checks.length === 0))) {
    return res('invalid', 'not valid (its ok field contradicts doctor_ok, fingerprint_stable or failing_checks — edited by hand?)', r);
  }
  const here = realOf(path.dirname(path.resolve(devDir)));
  if (foldCase(r.root) !== foldCase(here)) return res('foreign', 'it belongs to another tree (' + r.root + ', not ' + here + ')', r);
  if (Date.parse(r.finished_at) > nowMs + FUTURE_SKEW_MS) return res('future', 'its finished_at (' + r.finished_at + ') is in the future — it proves nothing', r);
  // FIX-SYNC C-F8: a doctor that was red ONLY on checks about this tree's own run records (never published, never run by an
  // install) still proves the published bytes: green with a warning, never a gate that every publish has to skip.
  const runStateOnly = r.ok !== true && r.doctor_ok === false && r.fingerprint_stable === true && Array.isArray(r.failing_checks)
    && r.failing_checks.length > 0 && r.failing_checks.every((c) => RUN_STATE_CHECKS.has(c));
  if (runStateOnly && fingerprintOf(hashes) === r.published_fingerprint) {
    return Object.assign(res('green', null, r), { warning: 'the doctor was red only on ' + r.failing_checks.join(', ') + ' (this tree\'s own run records, not published bytes) — accepted for the publish; fix it in the development tree' });
  }
  if (r.ok !== true && !runStateOnly) {
    if (r.doctor_ok === false) return res('red', 'the doctor was RED (finished ' + r.finished_at + (Array.isArray(r.failing_checks) && r.failing_checks.length ? '; failing: ' + r.failing_checks.slice(0, NAMES_MAX).join(', ') : '') + ') — fix it first', r);
    return res('unstable', 'published files changed WHILE the doctor ran (finished ' + r.finished_at + ')', r);
  }
  if (fingerprintOf(hashes) === r.published_fingerprint) return res('green', null, r);
  const was = r.published_files, now = hashes;
  const changed = Object.keys(now).filter((k) => k in was && was[k] !== now[k]).sort();
  const added = Object.keys(now).filter((k) => !(k in was)).sort();
  const removed = Object.keys(was).filter((k) => !(k in now)).sort();
  const parts = [];
  const list = (label, xs) => { if (xs.length) parts.push(label + ' ' + xs.slice(0, NAMES_MAX).join(', ') + (xs.length > NAMES_MAX ? ' (+' + (xs.length - NAMES_MAX) + ' more)' : '')); };
  list('changed', changed); list('added', added); list('removed', removed);
  return res('mismatch', 'published files changed after the green doctor (finished ' + r.finished_at + '): ' + (parts.join('; ') || 'the published set differs'), r);
}

/** doctorReceiptVerdict(plan, o, hashes) -> {required, state, skipped, blocker, record}. */
function doctorReceiptVerdict(plan, o, hashes) {
  const devDir = plan.devDir;
  if (!doctorRequired(devDir)) return { required: false, state: 'not-required', skipped: null, blocker: null, record: { required: false, state: 'not-required', skipped: null } };
  const nowMs = typeof o.nowIso === 'string' && Number.isFinite(Date.parse(o.nowIso)) ? Date.parse(o.nowIso) : Date.now();
  const j = judgeDoctorReceipt(devDir, hashes, nowMs);
  const skipped = typeof o.skipDoctorReceipt === 'string' && o.skipDoctorReceipt.trim() ? o.skipDoctorReceipt.trim() : null;
  const r = j.receipt || {};
  const record = {
    required: true, state: j.state, problem: j.problem, skipped, path: j.path,
    finished_at: r.finished_at || null, published_fingerprint: isSha(r.published_fingerprint) ? r.published_fingerprint : null,
    published_count: Number.isFinite(r.published_count) ? r.published_count : null, tests: r.tests || null,
    warning: j.warning || null, // FIX-SYNC C-F8
  };
  const blocker = j.problem && !skipped ? 'full-doctor receipt: ' + j.problem + ' — ' + RERUN + '; ' + ESCAPE : null;
  return { required: true, state: j.state, skipped, blocker, record };
}

function hashesFor(plan) {
  if (plan && plan.srcHashes && typeof plan.srcHashes === 'object') return plan.srcHashes;
  return publishedHashes(plan.devDir);
}
/** applyBlockers(plan, o) -> [reason]. Both checks; read-only. */
function applyBlockers(plan, o) {
  const opt = o || {};
  let hashes;
  try { hashes = hashesFor(plan); } catch (e) { return ['the publish guard cannot list the published set (' + e.message + ') — refusing']; }
  const reasons = [];
  const scan = unpublishedTestRequires(plan.devDir, Object.keys(hashes));
  if (scan.findings.length) reasons.push(requireFindingsReason(scan.findings));
  if (scan.unreadable.length) reasons.push(scan.unreadable.length + ' published test(s) could not be read for the require() check: ' + scan.unreadable.slice(0, NAMES_MAX).join(', '));
  const d = doctorReceiptVerdict(plan, opt, hashes);
  if (d.blocker) reasons.push(d.blocker);
  return reasons;
}
/** guardedLoads(plan) -> [{test, line, spec, target, where}] — FIX-SYNC D-F2: the published tests' loads of an unpublished module
 *  behind an existence check. Portable, so no blocker — but listed in the publish plan, never passed silently. */
function guardedLoads(plan) { return unpublishedTestRequires(plan.devDir, Object.keys(hashesFor(plan))).guarded; }
/** receiptRecord(plan, o) -> what the template's publish receipt records about the doctor receipt. */
function receiptRecord(plan, o) {
  try { return doctorReceiptVerdict(plan, o || {}, hashesFor(plan)).record; } catch (e) { return { required: null, state: 'error', problem: e.message, skipped: (o && o.skipDoctorReceipt) || null }; }
}

module.exports = {
  lexTokens, requireRefs, unpublishedTestRequires, requireFindingsReason,
  fingerprintOf, publishedHashes, doctorReceiptPath, doctorRequired, beginDoctorReceipt, finishDoctorReceipt, judgeDoctorReceipt,
  doctorReceiptVerdict, applyBlockers, receiptRecord, guardedLoads,
  DOCTOR_RECEIPT_SCHEMA, DOCTOR_RECEIPT_REL, TEST_FILE_RE,
};
