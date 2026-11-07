'use strict';
/**
 * doctor/checks-rebind.cjs — one module of forge-doctor.cjs (WP A11 part 2): rebinding_guard (structural + behavioural), command_center_location, backfill_continuity.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const { BIN_DIR, runsDirOf } = require('./context.cjs');
const { stripJsComments } = require('./checks-completeness.cjs');
const { findMatchingBrace, maskRegexLiterals, maskStringAndTemplateLiterals } = require('./checks-testscan.cjs');

// Security self-test (originally 2026-07-11; updated; hardened 2026-09-27 — Codex
// adversarial-review finding DOCTOR-1, MEDIUM). The DNS-rebinding + cross-site guard used to live in
// the retired per-project server.cjs; that dashboard was removed and the guard now lives in the
// Command Center gateway (command-center/gateway/src/security.mjs, wired into
// command-center/gateway/src/server.mjs). command-center/ is its OWN separate git repository (owner
// decision D1, 2026-07-26) — a plain project checkout of THIS repo does not contain it at all, and
// that must never fail this project's doctor. The check is therefore only APPLICABLE when
// command-center/ actually exists under root; otherwise it degrades to an honest, non-failing "not
// applicable".
//
// DOCTOR-1: the PRE-WP-Q2 version scanned the WHOLE security.mjs file for marker WORDS ("host",
// "127.0.0.1", "localhost", "sec-fetch-site", "origin") appearing ANYWHERE, including inside a
// comment — a fabricated comment reading "Host 127.0.0.1 localhost Origin Sec-Fetch-Site" satisfied
// every marker with zero real guard code (this file's own old RG_GOOD fixture in
// forge-doctor.test.cjs proved it: `hostOk`/`crossSiteOk` that unconditionally `return true` still
// passed, purely because a comment above them named the right words).
//
// THE FIX below requires REAL code, not prose, and REAL wiring, not just a definition:
//   1. Comments are stripped first (stripJsComments, below in this file) so marker words can never
//      be read from a comment again.
//   2. security.mjs must export a real function whose body — expanded ONE call/const hop, so a thin
//      wrapper like the real hostOk() (which itself just calls hostName() and checks the LOCAL_HOSTS
//      Set) is still recognised — actually reads `req.headers` together with a `127.0.0.1`/
//      `localhost` token (the host guard), and a real exported function whose body reads
//      `req.headers` together with `sec-fetch-site`/`origin` (the cross-site guard).
//   3. server.mjs must IMPORT those exact two discovered names from a `security*.mjs` module — not
//      just define them and never use them.
//   4. server.mjs must actually CALL both, inside the function it hands to `http.createServer(...)`
//      (falling back to a function literally named `requestListener`, this codebase's own
//      convention) — imported-but-unused no longer passes.
//   5. If a routing dispatch marker (`pathname === /!== /.startsWith(/.match(`) is found in that same
//      listener body, both guard calls must occur before it — a guard wired in AFTER routing has
//      already begun is not a real guard.
// Any step that cannot be confirmed reports ok:false with a plain reason (fail closed) rather than
// guessing — per this WP's own instruction. Dependency-free: no gateway file is ever imported/run,
// only read as text.
const RG_HEADER_TOKEN_RE = /\.headers\b/;
const RG_HOST_TOKEN_RE = /127\.0\.0\.1/;
const RG_LOCALHOST_TOKEN_RE = /\blocalhost\b/i;
const RG_CROSS_SITE_TOKEN_RE = /sec-fetch-site/i;
const RG_ORIGIN_TOKEN_RE = /\.origin\b/;
const RG_ROUTING_MARKER_RE = /\bpathname\s*(===|!==|\.startsWith\(|\.match\()/;

function rgEscapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** rgFindTopLevelSemicolon(text, startIdx) -> index of the next ';' at bracket/paren/brace depth 0
 *  starting from startIdx (string-literal aware, same quote-skipping idiom as findMatchingBrace),
 *  or -1. Used to slice a top-level `const NAME = <initializer>;` statement's initializer text. */
function rgFindTopLevelSemicolon(text, startIdx) {
  let depth = 0, i = startIdx;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch; i++;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === quote) { i++; break; } i++; }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; i++; continue; }
    if (ch === ';' && depth === 0) return i;
    i++;
  }
  return -1;
}
/** rgCollectTopLevel(strippedText, mirrorText) -> { fns: Map<name, bodyText|{body,originalBody}>,
 *  consts: Map<name, initializerText|{body,originalBody}> } for every top-level `function NAME(...) { ... }`
 *  and `const NAME = ...;` in comment-stripped source (exported or not — a guard's own internal helper,
 *  e.g. the real hostName(), is rarely exported itself). Best-effort structural scan (same trade-off as
 *  this file's other regex-based checks, e.g. classifyTHelper), never a full parser.
 *  DOCTOR-1 fix (Codex adversarial-review, MEDIUM): `strippedText` finds/delineates real function and
 *  const boundaries — using the FULLY literal-masked text here (not just comment-stripped) means a decoy
 *  "function fakeGuard(req) { ... }" spelled out as plain TEXT inside a string literal is masked away
 *  BEFORE this ever scans for one, so it can never be mistaken for a real top-level declaration. When
 *  `mirrorText` is given (a text of the EXACT SAME length/positions as `strippedText` — e.g. the same
 *  source with only comments stripped, real string content intact — see maskStringAndTemplateLiterals/
 *  maskRegexLiterals's own "same-length" contract), each map value becomes `{body, originalBody}`: `body`
 *  is extracted from `strippedText` (decoy-resistant), `originalBody` is the SAME index range read from
 *  `mirrorText` (real string content intact, for checks that legitimately need to read a literal VALUE —
 *  see rgLooksLikeHostGuardBody). Without `mirrorText` the return shape is IDENTICAL to before (plain
 *  body strings) — existing callers that only need the decoy-resistant body are unaffected. */
function rgCollectTopLevel(strippedText, mirrorText) {
  const dual = mirrorText !== undefined;
  const wrap = (start, end) => (dual ? { body: strippedText.slice(start, end), originalBody: mirrorText.slice(start, end) } : strippedText.slice(start, end));
  const fns = new Map();
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = fnRe.exec(strippedText))) {
    const openBrace = fnRe.lastIndex - 1;
    const closeBrace = findMatchingBrace(strippedText, openBrace);
    if (closeBrace === -1) continue;
    fns.set(m[1], wrap(openBrace + 1, closeBrace));
  }
  const consts = new Map();
  const constRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = constRe.exec(strippedText))) {
    const initStart = constRe.lastIndex;
    const semiIdx = rgFindTopLevelSemicolon(strippedText, initStart);
    if (semiIdx === -1) continue;
    consts.set(m[1], wrap(initStart, semiIdx));
  }
  return { fns, consts };
}
function rgIsExportedFunctionName(strippedText, name) {
  return new RegExp('\\bexport\\s+function\\s+' + rgEscapeRegExp(name) + '\\s*\\(').test(strippedText);
}
/** rgExpandOneHop(own, fns, consts, selfName) -> ownBody plus, for every OTHER top-level name (function
 *  or const) it directly references, that name's own body/initializer appended too. One hop is enough
 *  for this codebase's real shape: security.mjs's hostOk(req) directly references BOTH a header-reading
 *  helper call (hostName(req)) and the LOCAL_HOSTS set in its own body.
 *  DOCTOR-1 fix (Codex adversarial-review, MEDIUM): `own` and the map values may be the DUAL
 *  `{body, originalBody}` shape rgCollectTopLevel() produces when given a mirror text — in that case this
 *  returns `{expanded, expandedOriginal}` (both expansions built from the SAME referenced names, each
 *  pulling its own variant) instead of a single string. A plain-string `own` (the pre-existing,
 *  non-dual shape) still returns a single expanded string, unchanged from before — srvFns (which only
 *  ever needs the decoy-resistant body, never real string content) keeps using that simple form. */
function rgExpandOneHop(own, fns, consts, selfName) {
  const dual = own !== null && typeof own === 'object';
  const ownCode = dual ? own.body : own;
  let expanded = ownCode;
  let expandedOriginal = dual ? own.originalBody : null;
  for (const [name, val] of fns) {
    if (name === selfName) continue;
    if (new RegExp('\\b' + rgEscapeRegExp(name) + '\\s*\\(').test(ownCode)) {
      expanded += ' ' + (dual ? val.body : val);
      if (dual) expandedOriginal += ' ' + val.originalBody;
    }
  }
  for (const [name, val] of consts) {
    if (new RegExp('\\b' + rgEscapeRegExp(name) + '\\b').test(ownCode)) {
      expanded += ' ' + (dual ? val.body : val);
      if (dual) expandedOriginal += ' ' + val.originalBody;
    }
  }
  return dual ? { expanded, expandedOriginal } : expanded;
}
/** rgLooksLikeHostGuardBody(codeOnlyBody, originalBody) / rgLooksLikeCrossSiteGuardBody(...) — DOCTOR-1
 *  fix (Codex adversarial-review, MEDIUM): `codeOnlyBody` has comments AND every string/template/regex
 *  literal masked (see rgStripForStructuralScan) — the PROPERTY-ACCESS markers (`.headers`, `.origin`)
 *  are checked ONLY here, because real code never legitimately needs `.headers`/`.origin` to sit inside a
 *  string literal; a guard that always `return`s true with the marker text hidden in a decoy STRING
 *  (e.g. `"req.headers 127.0.0.1 localhost"`) loses `.headers` entirely once literals are masked, so it
 *  now correctly fails. `originalBody` (comments-only-stripped, REAL string content intact) is where the
 *  VALUE markers (`127.0.0.1`, `localhost`, `sec-fetch-site`) are checked instead — the real gateway
 *  legitimately compares header VALUES against string literals (`LOCAL_HOSTS = new Set(['127.0.0.1', ...])`),
 *  so masking those away would make the real guard fail its own check. When no `originalBody` is given
 *  (single-string, non-dual caller), the same text is used for both halves — matches this function's
 *  pre-fix behavior exactly for that shape. */
function rgLooksLikeHostGuardBody(codeOnlyBody, originalBody) {
  const orig = originalBody != null ? originalBody : codeOnlyBody;
  return RG_HEADER_TOKEN_RE.test(codeOnlyBody) && RG_HOST_TOKEN_RE.test(orig) && RG_LOCALHOST_TOKEN_RE.test(orig);
}
function rgLooksLikeCrossSiteGuardBody(codeOnlyBody, originalBody) {
  const orig = originalBody != null ? originalBody : codeOnlyBody;
  return RG_HEADER_TOKEN_RE.test(codeOnlyBody) && (RG_CROSS_SITE_TOKEN_RE.test(orig) || RG_ORIGIN_TOKEN_RE.test(codeOnlyBody));
}
/** rgFindGuardExportName(strippedText, fns, consts, shapeFn) -> the name of the first EXPORTED
 *  top-level function whose one-hop-expanded body satisfies shapeFn, or null. Only an exported name
 *  is eligible — server.mjs can only import what security.mjs actually exports. `fns`/`consts` may be
 *  the DUAL shape (see rgCollectTopLevel/rgExpandOneHop) — shapeFn is then called with BOTH the
 *  code-only and original expansions; a plain-string shape calls shapeFn with just the one string, as
 *  before. */
function rgFindGuardExportName(strippedText, fns, consts, shapeFn) {
  for (const [name, val] of fns) {
    if (!rgIsExportedFunctionName(strippedText, name)) continue;
    const expansion = rgExpandOneHop(val, fns, consts, name);
    const isDualExpansion = expansion !== null && typeof expansion === 'object';
    const matched = isDualExpansion ? shapeFn(expansion.expanded, expansion.expandedOriginal) : shapeFn(expansion);
    if (matched) return name;
  }
  return null;
}
/** rgImportedNamesFromSecurity(strippedSrvText) -> Set of names server.mjs imports from a module
 *  path containing "security" and ending in .mjs (this repo's real `from './security.mjs'`), handling
 *  a possible `X as Y` alias by keeping the real exported name X. */
function rgImportedNamesFromSecurity(strippedSrvText) {
  const names = new Set();
  const importRe = /\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]*security[^'"]*\.mjs)['"]/g;
  let m;
  while ((m = importRe.exec(strippedSrvText))) {
    for (const raw of m[1].split(',')) {
      const nm = raw.trim().split(/\s+as\s+/)[0].trim();
      if (nm) names.add(nm);
    }
  }
  return names;
}
function rgFirstCallIndex(strippedText, name) {
  const m = new RegExp('\\b' + rgEscapeRegExp(name) + '\\s*\\(').exec(strippedText);
  return m ? m.index : -1;
}
/** rgFindListenerBody(strippedSrvText, fns) -> { name, body } for the function server.mjs hands to
 *  `http.createServer(...)` (preferred), falling back to a function literally named
 *  `requestListener` (this codebase's own convention, see server.mjs) when the createServer call
 *  itself can't be parsed. Returns null — never a guess — when neither is found. */
function rgFindListenerBody(strippedSrvText, fns) {
  const csMatch = /\bcreateServer\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(strippedSrvText);
  const candidateNames = csMatch ? [csMatch[1], 'requestListener'] : ['requestListener'];
  for (const name of candidateNames) {
    if (fns.has(name)) return { name, body: fns.get(name) };
  }
  return null;
}

/** rgStripForStructuralScan(text) -> comments AND every string/template/regex literal's own content
 *  masked (never the surrounding code) — see maskStringAndTemplateLiterals/maskRegexLiterals's own doc
 *  comments. DOCTOR-1 fix (Codex adversarial-review, MEDIUM): the pre-fix version only ran
 *  stripJsComments() before every structural regex below, which strips comments but deliberately leaves
 *  string/template/regex CONTENT untouched — a guard that unconditionally `return`s true, with the
 *  marker text hidden in a STRING instead of a comment (e.g. `"req.headers 127.0.0.1 localhost"`, or a
 *  `/req\.headers.../ ` regex literal used only for its text), satisfied every RG_*_TOKEN_RE check purely
 *  from that literal. This is used for every check EXCEPT rgImportedNamesFromSecurity() — that one
 *  legitimately needs the REAL import-specifier string content (`from './security.mjs'`), so it keeps
 *  using the comment-only-stripped text (stripJsComments alone); masking literals there would blank the
 *  very path text it needs to read. */
function rgStripForStructuralScan(text) {
  return maskRegexLiterals(maskStringAndTemplateLiterals(stripJsComments(text)));
}
function rebindingGuard(root) {
  const ccDir = path.join(root, 'command-center');
  if (!fs.existsSync(ccDir)) return { ok: true, applicable: false, reason: 'no command-center/ in this project (it is its own separate repo) — not applicable' };
  const secFile = path.join(ccDir, 'gateway', 'src', 'security.mjs');
  let secRaw; try { secRaw = fs.readFileSync(secFile, 'utf8'); } catch { return { ok: false, applicable: true, reason: 'command-center/ exists but gateway/src/security.mjs is missing' }; }
  // DOCTOR-1 fix: TWO variants, DUAL mode (see rgCollectTopLevel's own doc comment) — `sec` (fully
  // literal-masked) finds/delineates REAL function boundaries decoy-resistantly and is what the
  // property-access markers (.headers/.origin) are checked against; `secOriginal` (comments-only
  // stripped, real string content intact) is where the VALUE markers (127.0.0.1/localhost/sec-fetch-site)
  // are checked instead — the real gateway legitimately expresses those as string literals it compares
  // header values against (see rgLooksLikeHostGuardBody's own doc comment for why masking them too would
  // make the REAL guard fail its own check).
  const secOriginal = stripJsComments(secRaw);
  const sec = maskRegexLiterals(maskStringAndTemplateLiterals(secOriginal));

  // Checked BEFORE server.mjs is even read: a security.mjs with no real guard shape is worth
  // reporting precisely on its own, regardless of whether server.mjs also happens to be present.
  const { fns: secFns, consts: secConsts } = rgCollectTopLevel(sec, secOriginal);
  const hostGuardName = rgFindGuardExportName(sec, secFns, secConsts, rgLooksLikeHostGuardBody);
  const crossSiteGuardName = rgFindGuardExportName(sec, secFns, secConsts, rgLooksLikeCrossSiteGuardBody);
  if (!hostGuardName || !crossSiteGuardName) {
    return {
      ok: false, applicable: true,
      reason: 'security.mjs has no exported function with a real request-header check (host-vs-localhost guard '
        + (hostGuardName ? ('found: ' + hostGuardName) : 'NOT found') + ', cross-site/origin guard '
        + (crossSiteGuardName ? ('found: ' + crossSiteGuardName) : 'NOT found') + ')',
    };
  }

  const srvFile = path.join(ccDir, 'gateway', 'src', 'server.mjs');
  let srvRaw; try { srvRaw = fs.readFileSync(srvFile, 'utf8'); } catch { return { ok: false, applicable: true, reason: 'command-center/ exists but gateway/src/server.mjs is missing' }; }
  // DOCTOR-1 fix: TWO variants of server.mjs's own text, deliberately different —
  //  - srvForImports keeps real string content (stripJsComments only): rgImportedNamesFromSecurity()
  //    reads the ACTUAL import-specifier path out of `from '...'`, which a literal-masking pass would
  //    destroy (turning './security.mjs' into unreadable filler and breaking every legitimate import).
  //  - srv (fully stripped) is used for every OTHER check below — guard-call detection and routing-order
  //    both must never be fooled by "hostOk(req); crossSiteOk(req); pathname ===" sitting inside a STRING
  //    in the listener (DOCTOR-1's second reported shape) rather than real, executed code.
  const srvForImports = stripJsComments(srvRaw);
  const srv = rgStripForStructuralScan(srvRaw);

  const importedFromSecurity = rgImportedNamesFromSecurity(srvForImports);
  const missingImports = [hostGuardName, crossSiteGuardName].filter((n) => !importedFromSecurity.has(n));
  if (missingImports.length > 0) {
    return { ok: false, applicable: true, reason: 'server.mjs does not import ' + missingImports.join(' and ') + ' from security.mjs' };
  }

  const { fns: srvFns } = rgCollectTopLevel(srv);
  const listener = rgFindListenerBody(srv, srvFns);
  if (!listener) {
    return { ok: false, applicable: true, reason: 'could not find the request-listener function server.mjs passes to http.createServer(...)' };
  }
  const hostCallIdx = rgFirstCallIndex(listener.body, hostGuardName);
  const crossSiteCallIdx = rgFirstCallIndex(listener.body, crossSiteGuardName);
  const neverCalled = [];
  if (hostCallIdx === -1) neverCalled.push(hostGuardName);
  if (crossSiteCallIdx === -1) neverCalled.push(crossSiteGuardName);
  if (neverCalled.length > 0) {
    return { ok: false, applicable: true, reason: neverCalled.join(' and ') + ' imported from security.mjs but never called in the request listener (' + listener.name + ')' };
  }

  const routingMatch = RG_ROUTING_MARKER_RE.exec(listener.body);
  const routingIdx = routingMatch ? routingMatch.index : -1;
  if (routingIdx !== -1 && (hostCallIdx > routingIdx || crossSiteCallIdx > routingIdx)) {
    return { ok: false, applicable: true, reason: 'security guard call happens after routing has already started in ' + listener.name + ', not before' };
  }

  // hostGuardName/crossSiteGuardName are carried on a successful verdict so rebindingGuardBehavioral()
  // (below) can dynamically import the REAL security.mjs and call these exact exported names, instead of
  // re-deriving them or guessing well-known names.
  return { ok: true, applicable: true, reason: '', hostGuardName, crossSiteGuardName };
}
const REBINDGUARD_RUNNER_TIMEOUT_MS = 15000;
const REBINDGUARD_RUNNER_FILE = path.join(BIN_DIR, 'forge-rebindguard-runner.cjs');
/** rebindingGuardBehavioral(root, opts) -> {ok, applicable, reason} — SYNCHRONOUS BEHAVIOURAL companion
 *  to rebindingGuard() (DOCTOR-1 fix, Codex adversarial-review, MEDIUM — wired into runDoctor() per Lead
 *  Codex judged the finding NOT CLOSED twice while this check existed only
 *  as a standalone, exported-but-uncalled function). The structural scan above proves the guard
 *  functions are REAL, EXPORTED, IMPORTED and CALLED before routing — it cannot prove they actually
 *  implement correct rejection logic (a real-looking guard can still e.g. always `return true` behind
 *  code that legitimately touches every structural marker — see forge-doctor.test.cjs's own
 *  "always-true-with-real-code-markers" fixture, which passes rebindingGuard() cleanly).
 *  security.mjs is an ESM module, so actually calling it requires the async `import()` expression — but
 *  this whole file's call chain (runDoctor() included) is deliberately kept synchronous. Rather than
 *  make that large, heavily-tested chain async for one check, the actual import+call happens in a
 *  SEPARATE Node process (forge-rebindguard-runner.cjs, see its own header comment), spawned here with
 *  child_process.spawnSync — which blocks synchronously until that process exits or opts.timeoutMs
 *  (default REBINDGUARD_RUNNER_TIMEOUT_MS) elapses — so from THIS function's caller's point of view the
 *  whole behavioural check is one ordinary, bounded-time, synchronous call.
 *  Same "not applicable without command-center/" posture as rebindingGuard() itself, and skipped (not
 *  re-reported as a separate failure) when the structural check already failed, since there is nothing
 *  trustworthy to call in that case. A behavioural FAILURE, a runner TIMEOUT, a non-zero runner exit, or
 *  unparsable/unexpected runner output are ALL reported as ok:false with a plain reason — never a silent
 *  pass on anything short of a verified ok:true verdict actually read back from the runner.
 *  opts.timeoutMs/opts.runnerFile are test-only overrides — the real caller (rebindingGuardCombined(),
 *  runDoctor()) never passes them. */
function rebindingGuardBehavioral(root, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || REBINDGUARD_RUNNER_TIMEOUT_MS;
  const runnerFile = o.runnerFile || REBINDGUARD_RUNNER_FILE;
  const structural = rebindingGuard(root);
  if (!structural.applicable) return { ok: true, applicable: false, reason: structural.reason };
  if (!structural.ok) return { ok: false, applicable: true, reason: 'skipped — structural check already failed: ' + structural.reason };
  const secFile = path.join(root, 'command-center', 'gateway', 'src', 'security.mjs');
  let r;
  try {
    r = spawnSync(process.execPath, [runnerFile, secFile, structural.hostGuardName, structural.crossSiteGuardName], { encoding: 'utf8', timeout: timeoutMs });
  } catch (e) {
    return { ok: false, applicable: true, reason: 'could not spawn the behavioural-check runner: ' + (e && e.message) };
  }
  if (r.error) {
    const isTimeout = r.error.code === 'ETIMEDOUT' || /timed?\s?out/i.test(r.error.message || '');
    return {
      ok: false, applicable: true,
      reason: isTimeout ? 'behavioural-check runner exceeded its ' + timeoutMs + 'ms timeout' : 'behavioural-check runner error: ' + r.error.message,
    };
  }
  if (r.signal) {
    return { ok: false, applicable: true, reason: 'behavioural-check runner was killed by signal ' + r.signal + ' (likely exceeded its ' + timeoutMs + 'ms timeout)' };
  }
  if (r.status !== 0) {
    return { ok: false, applicable: true, reason: 'behavioural-check runner exited ' + r.status + ': ' + String(r.stderr || r.stdout || '').trim().slice(0, 500) };
  }
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    return { ok: false, applicable: true, reason: 'behavioural-check runner produced no output' };
  }
  const lastLine = lines[lines.length - 1];
  let parsed;
  try { parsed = JSON.parse(lastLine); }
  catch (e) { return { ok: false, applicable: true, reason: 'behavioural-check runner produced unparsable output: ' + (e && e.message) + ' (' + lastLine.slice(0, 200) + ')' }; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
    return { ok: false, applicable: true, reason: 'behavioural-check runner produced an unexpected shape: ' + JSON.stringify(parsed).slice(0, 300) };
  }
  return { ok: parsed.ok, applicable: true, reason: parsed.reason || '' };
}
/** rebindingGuardCombined(root, opts) -> {ok, applicable, reason, structural, behavioral} — the ONE
 *  verdict runDoctor()'s own `checks.rebinding_guard` field reports (Lead review round 2):
 *  the structural scan alone was judged insufficient evidence of a real, working DNS-rebinding guard.
 *  `ok` is true ONLY when not applicable (no command-center/ — nothing to guard), or when BOTH the
 *  structural AND the behavioural check report ok:true. A structural failure short-circuits (behavioral
 *  stays null — rebindingGuardBehavioral() itself has nothing trustworthy to call in that case, and this
 *  avoids computing rebindingGuard() twice) so the reported reason is always the FIRST real problem
 *  found, never a confusing composite. */
function rebindingGuardCombined(root, opts) {
  const structural = rebindingGuard(root);
  if (!structural.applicable) return { ok: true, applicable: false, reason: structural.reason, structural, behavioral: null };
  if (!structural.ok) return { ok: false, applicable: true, reason: structural.reason, structural, behavioral: null };
  const behavioral = rebindingGuardBehavioral(root, opts);
  return { ok: behavioral.ok === true, applicable: true, reason: behavioral.ok ? '' : (behavioral.reason || 'behavioural check failed'), structural, behavioral };
}

// ("forge dashboard works after a fresh install, with no manual steps") — ADVISORY ONLY,
// purely informational. Reports WHERE (if anywhere) this project's own wrappers (forge.ps1/forge.cmd/
// forge.sh -> forge-cc-launch.cjs) would find a Command Center to start: 'project-local'
// (command-center/gateway/bin.mjs under THIS project root — a developer checkout, e.g. this repo itself),
// 'central' (<home>/.claude/forge/template/command-center/gateway/bin.mjs — the installer's shared copy,
//), or 'not-installed'. `ok` is ALWAYS true: a plain project checkout normally has NEITHER
// (command-center/ is its own separate git repository per owner decision D1, and most machines never ran
// the central installer either) — that is the expected, common case, never a defect, so this must never
// fail the doctor or block a sync. Mirrors forge-cc-launch.cjs's own findCommandCenter() lookup order
// exactly (project-local first, then central) so this line can never claim a location the real wrapper
// would not also find. opts.homeDir is a TEST-ONLY override (default os.homedir()) — a test must never
// create fixture files under the real, live home directory to exercise the 'central' branch.
function commandCenterLocation(root, opts) {
  const o = opts || {};
  let homeDir;
  if (o.homeDir) homeDir = o.homeDir;
  else { try { homeDir = os.homedir(); } catch { homeDir = null; } }
  const projectLocal = path.join(root, 'command-center', 'gateway', 'bin.mjs');
  if (fs.existsSync(projectLocal)) return { ok: true, location: 'project-local', path: path.join(root, 'command-center') };
  if (homeDir) {
    const central = path.join(homeDir, '.claude', 'forge', 'template', 'command-center', 'gateway', 'bin.mjs');
    if (fs.existsSync(central)) return { ok: true, location: 'central', path: path.join(homeDir, '.claude', 'forge', 'template', 'command-center') };
  }
  return { ok: true, location: 'not-installed', path: null };
}

// dispatch_id backfill continuity — ADVISORY ONLY (FOLLOWUP A). Read-only-audit/write-no-exec
// Bosses (agent-tool-policy.json classes forbidding Bash: review-boss, security-boss, search-boss, seo-boss,
// boss, head-chef, docs-boss, skill-boss) have no shell access and therefore cannot self-log their own
// subagent_started/subagent_completed events — the Lead backfills BOTH events for them, using the SAME
// dispatch_id (the Agent-tool's own tool_use id) each time. This check flags when that backfill was done
// inconsistently (a started event carries a dispatch_id but the matching completed event carries none or a
// different one). It is intentionally:
//   • ADVISORY, never blocking — its `ok` is reported in a separate top-level `advisory` field and is NEVER
//     folded into runDoctor()'s `checks`-based ok-AND (see runDoctor below). A stale/inconsistent backfill on
//     an old run must never fail the doctor, block a sync, or turn an unrelated run's report red.
//   • PROSPECTIVE / tolerant of history — most existing runs in forge-runs/ predate this convention entirely
//     and carry no dispatch_id anywhere. A run with ZERO dispatch_id usage anywhere is treated as "not
//     applicable" (silently skipped, not a violation); only a run that DOES use dispatch_ids somewhere but
//     drops/changes one for a Bash-less Boss's completion earns a warning.
// Mirrors both the slug form (agent-tool-policy.json / agent-registry.json keys, e.g. "review-boss") and the
// canonical DISPLAY form (e.g. "Review Boss") a real events.jsonl actually holds, since log-event.cjs
// canonicalizes every `agent` field to the registry's display name before writing.
const NO_BASH_BOSS_SLUGS = ['review-boss', 'security-boss', 'search-boss', 'seo-boss', 'boss', 'head-chef', 'docs-boss', 'skill-boss'];
const NO_BASH_BOSS_DISPLAY = ['Review Boss', 'Security Boss', 'Search Boss', 'SEO Boss', 'Boss', 'Head Chef', 'Docs Boss', 'Skill Boss'];
const NO_BASH_BOSS_NAMES = new Set([...NO_BASH_BOSS_SLUGS, ...NO_BASH_BOSS_DISPLAY].map((s) => s.toLowerCase()));
function backfillContinuity(root) {
  const runsDir = runsDirOf(root);
  let runIds = [];
  try { runIds = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { ok: true, checkedRuns: 0, applicableRuns: 0, warnings: [] }; }
  const warnings = [];
  let applicableRuns = 0;
  for (const id of runIds) {
    let raw; try { raw = fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8').replace(/\n+$/, ''); } catch { continue; }
    if (!raw) continue;
    let evs; try { evs = raw.split('\n').map((l) => JSON.parse(l)); } catch { continue; } // unparseable -> chainCheck's concern, not this one
    if (!evs.some((e) => e && e.dispatch_id)) continue; // no dispatch_id anywhere in this run -> predates the convention, not applicable
    applicableRuns++;
    const pending = new Map(); // lowercased agent name -> queue of dispatch_ids from unmatched subagent_started events
    for (const e of evs) {
      if (!e || !e.event_type || !e.agent) continue;
      const name = String(e.agent).toLowerCase();
      if (!NO_BASH_BOSS_NAMES.has(name)) continue; // Bash-capable Bosses self-log and may legitimately omit dispatch_id
      if (e.event_type === 'subagent_started') {
        if (!pending.has(name)) pending.set(name, []);
        pending.get(name).push(e.dispatch_id || null);
      } else if (e.event_type === 'subagent_completed') {
        const q = pending.get(name);
        const startId = (q && q.length) ? q.shift() : undefined; // undefined = no matching start seen -> nothing to judge
        if (startId && e.dispatch_id !== startId) {
          warnings.push({ run: id, agent: e.agent, expected: startId, found: e.dispatch_id || null, reason: 'subagent_completed dispatch_id does not match its subagent_started dispatch_id (backfill likely missed)' });
        }
      }
    }
  }
  return { ok: warnings.length === 0, checkedRuns: runIds.length, applicableRuns, warnings };
}

module.exports = {
  RG_HEADER_TOKEN_RE, RG_HOST_TOKEN_RE, RG_LOCALHOST_TOKEN_RE, RG_CROSS_SITE_TOKEN_RE, RG_ORIGIN_TOKEN_RE,
  RG_ROUTING_MARKER_RE, rgEscapeRegExp, rgFindTopLevelSemicolon, rgCollectTopLevel, rgIsExportedFunctionName,
  rgExpandOneHop, rgLooksLikeHostGuardBody, rgLooksLikeCrossSiteGuardBody, rgFindGuardExportName,
  rgImportedNamesFromSecurity, rgFirstCallIndex, rgFindListenerBody, rgStripForStructuralScan, rebindingGuard,
  REBINDGUARD_RUNNER_TIMEOUT_MS, REBINDGUARD_RUNNER_FILE, rebindingGuardBehavioral, rebindingGuardCombined,
  commandCenterLocation, NO_BASH_BOSS_SLUGS, NO_BASH_BOSS_DISPLAY, NO_BASH_BOSS_NAMES, backfillContinuity,
};
