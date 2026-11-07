'use strict';
/**
 * doctor/checks-testscan.cjs — one module of forge-doctor.cjs (WP A11 part 2): check_the_checks: the green no-op suite scan and its literal-aware t-helper parser.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { claudeDir, listByExt } = require('./context.cjs');
const { stripJsComments } = require('./checks-completeness.cjs');

// --- check-the-checks: detect a "green no-op" — a *.test.cjs suite that runTests() reports as passing
// (passed > 0) but that contains ZERO real assertion call sites in its own source. Matches this codebase's two
// real local-helper conventions (`t('name', ...)` and `test('name', ...)`) plus direct `assert(...)`/
// `assert.foo(...)` calls, so it stays accurate across every existing suite regardless of which convention it
// uses (proven against all 51 real forge-bin/*.test.cjs suites at build time — every one has >=1 site).
const ASSERTION_SITE_RE = /\b(t|test)\s*\(\s*['"`]|\bassert(\.[A-Za-z]+)?\s*\(/g;
function countAssertionSites(text) {
  let n = 0, m; ASSERTION_SITE_RE.lastIndex = 0;
  while ((m = ASSERTION_SITE_RE.exec(text)) !== null) n++;
  return n;
}

// --- vacuous-boolean-t-helper: a DIFFERENT, narrower shape of "green no-op" than the whole-suite check
// above (2026-09-26 laptop re-audit). The whole-suite check only catches a suite with ZERO
// assertion call sites; it cannot catch a suite that has hundreds of real `t(...)` sites, all but a
// handful of which are genuine, and a FEW of which are individually dead: this codebase's dominant local
// convention is a BOOLEAN-style helper — `const t = (name, cond) => { if (cond) {...} else {...} }` — and
// passing it a bare, un-invoked function literal as `cond` (instead of a real boolean, or an IIFE that
// actually calls the literal and passes its result) always evaluates truthy, because a function reference
// is truthy regardless of what calling it would return. Every assertion inside that literal's body then
// never runs, forever, while the suite's own tally stays green. Found in this file's own
// forge-doctor.test.cjs: 12 gateWatchdogHealth/printSummary tests were written exactly this way.
// Deliberately exempts this codebase's OTHER real convention — a helper that genuinely INVOKES its second
// parameter as a callback, e.g. forge-standing.test.cjs's `function t(name, fn) { try { fn(); ... } catch
// (e) {...} }` — passing a function literal there is exactly the contract, not a defect. A file whose `t`
// helper cannot be classified at all (some other shape, or none) is left alone rather than guessed at.
// Best-effort static scan, not a full JS parser (same trade-off ASSERTION_SITE_RE above already makes) —
// see BARE_FN_LITERAL_HEAD_RE's own comment for the exact, deliberately narrow rule and its known limits.
const T_HELPER_DEF_RE = /\b(?:const|let|var)\s+t\s*=\s*\(([^)]*)\)\s*=>|\bfunction\s+t\s*\(([^)]*)\)/;
/** findMatchingBrace(text, openIdx) -> index of the '}' matching the '{' at openIdx, or -1 if unbalanced.
 *  String-literal aware (same quote-skipping idiom as stripJsComments) so a stray brace inside a string
 *  literal in the scanned body never miscounts. Assumes comments were already stripped by the caller. */
function findMatchingBrace(text, openIdx) {
  let depth = 0, i = openIdx;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch; i++;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === quote) { i++; break; } i++; }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}
/** splitTopLevelArgs(text, openParenIdx) -> { args: [argText, ...], closeIdx } for the call whose opening
 *  '(' is at openParenIdx: each argument's raw text, split on commas at bracket depth 0 relative to this
 *  call, plus the index of the call's own closing ')' (-1 if unbalanced — callers must treat that as
 *  "could not parse", never guess). Tracks (), {}, [] together as one nesting depth and skips over
 *  '/"/`  string and template-literal contents (so a comma or bracket INSIDE a string argument, e.g. the
 *  test name itself, is never mistaken for a real argument boundary). Not a full parser — no regex-literal
 *  handling — which is fine: none of this codebase's `t(...)` call sites put a bare regex literal there. */
function splitTopLevelArgs(text, openParenIdx) {
  let i = openParenIdx + 1;
  const n = text.length;
  let depth = 1;
  let argStart = i;
  const args = [];
  while (i < n && depth > 0) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch; i++;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === quote) { i++; break; } i++; }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { args.push(text.slice(argStart, i)); return { args, closeIdx: i }; }
      i++; continue;
    }
    if (ch === ',' && depth === 1) { args.push(text.slice(argStart, i)); i++; argStart = i; continue; }
    i++;
  }
  return { args, closeIdx: -1 };
}
/** BARE_FN_LITERAL_HEAD_RE — matches when an ALREADY-TRIMMED argument text starts with a function-literal
 *  head: `function`, a parenthesized-params arrow (`(a, b) =>`), or a single bare-param arrow (`x =>`),
 *  optionally `async`. Deliberately does NOT match an IIFE like `(() => {...})()` or `(function(){...})()`:
 *  both start with an EXTRA wrapping `(` before the literal itself, which breaks the `[^()]*` parameter
 *  capture (it cannot contain a nested unescaped `(`) and never matches bare `function\b` either (the `(`
 *  is in the way) — so an already-invoked literal never matches this head, by construction, without needing
 *  a separate "was it called" check. Combined with `cond.endsWith('}')` at the call site (a function
 *  literal whose OWN closing brace is the very last character of the argument was never followed by an
 *  invocation inside that argument), this reliably distinguishes "passed bare" from "passed already run".
 *  Known limitation: an expression-bodied arrow with no braces (`x => x.ok`) passed bare would be missed by
 *  the `endsWith('}')` half of that pair — not observed anywhere in this codebase's real `t(...)` call
 *  sites (every real body has multiple statements/assert calls, which requires a block body), and precision
 *  (no false positives) matters more here than covering every theoretical shape. */
const BARE_FN_LITERAL_HEAD_RE = /^(async\s+)?(function\b|\(([^()]*)\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
/** maskStringAndTemplateLiterals(strippedText) -> same-length text with every string/template literal's
 *  CONTENT (quotes included) replaced by spaces, newlines kept as real newlines (so a LINE NUMBER computed
 *  from an index into the result still matches the original file).: found by this very
 *  detector flagging ITS OWN test fixtures below — this project's *.test.cjs files routinely embed literal
 *  source code as string fixtures (e.g. `"t('...', () => { assert...` inside a JS string), and a structural
 *  scan that is not string-aware mistakes that DATA for a real call site. Used for every REGEX-based
 *  structural scan below (finding the `t` definition, finding `t(` call sites); the caller still reads real
 *  argument content from the UNMASKED text at the SAME index (masking never changes length/positions). */
function maskStringAndTemplateLiterals(text) {
  let out = '';
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += (text[i + 1] === '\n' ? '\n' : '  '); i += 2; continue; }
        if (text[i] === quote) { out += ' '; i++; break; }
        out += (text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
/** REGEX_PRECEDING_KEYWORDS — the JS keywords after which a bare `/` unambiguously opens a REGEX literal
 *  despite ending in a letter (return/typeof/instanceof/... all end in a word character, which would
 *  otherwise read like "the last token was a VALUE" and misclassify the following `/` as division). Used
 *  by maskRegexLiterals()'s own regex-vs-division heuristic (DOCTOR-1). */
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield']);
/** maskRegexLiterals(text) -> same-length text (mirrors maskStringAndTemplateLiterals's own contract:
 *  masked content becomes spaces, newlines stay real newlines) with every regex literal's (/…/flags) own
 *  PATTERN text masked — delimiters and flags themselves are left alone, only what sits BETWEEN the
 *  slashes is blanked. DOCTOR-1 fix (Codex adversarial-review, MEDIUM): callers must mask string/template
 *  content FIRST (see maskStringAndTemplateLiterals) so every remaining quote character is already gone
 *  and a `/` that used to sit inside a string can never be mistaken for a regex delimiter here.
 *  Regex-vs-division is the one classic JS-tokenizer ambiguity a bare `/` creates; this applies the
 *  common practical heuristic — a `/` opens a regex literal unless the last significant token read like
 *  the END of a value (an identifier/digit/`$`/`_` character, or one of `)]`), with
 *  REGEX_PRECEDING_KEYWORDS overriding that for the keywords that legitimately precede a regex literal
 *  despite ending in a letter. Best-effort, like every other regex-based check in this file (never a full
 *  parser) — good enough to stop a regex literal from smuggling marker text past a structural scan. */
function maskRegexLiterals(text) {
  let out = '';
  let i = 0;
  let lastChar = '';
  let curWord = '', lastWord = '';
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (/[A-Za-z0-9_$]/.test(ch)) { curWord += ch; out += ch; lastChar = ch; i++; continue; }
    if (curWord) { lastWord = curWord; curWord = ''; }
    if (ch === '/') {
      const opensRegex = !lastChar || REGEX_PRECEDING_KEYWORDS.has(lastWord) || !/[A-Za-z0-9_$)\]]/.test(lastChar);
      if (opensRegex) {
        let j = i + 1, inClass = false, closed = false;
        while (j < n) {
          const c = text[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '\n') break; // a real regex literal never spans a raw newline — bail, this was not one
          if (c === '[') { inClass = true; j++; continue; }
          if (c === ']') { inClass = false; j++; continue; }
          if (c === '/' && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) {
          let k = j + 1;
          while (k < n && /[a-z]/i.test(text[k])) k++; // flags
          out += '/' + text.slice(i + 1, j).replace(/[^\n]/g, ' ') + text.slice(j, k);
          i = k; lastChar = '/'; curWord = '';
          continue;
        }
      }
    }
    out += ch;
    if (ch === '\n') lastChar = '';
    else if (!/\s/.test(ch)) lastChar = ch;
    i++;
  }
  return out;
}
/** classifyTHelper(strippedText) -> 'boolean' | 'callback' | null. strippedText must already have had its
 *  comments removed (stripJsComments) so a `t(` mentioned only in prose can never be mistaken for a real
 *  definition; string/template content is masked internally (see maskStringAndTemplateLiterals) so a `t`
 *  definition mentioned only inside a STRING (e.g. an embedded source-code fixture) can never be mistaken
 *  for this file's own real one either. null means no local `t` helper of a recognised shape was found — the
 *  file is left alone rather than guessed at (some suites, e.g. usage-guard-state.test.cjs's async-queueing
 *  `t`, use a shape this deliberately narrow classifier does not attempt to judge). */
function classifyTHelper(strippedText) {
  const masked = maskStringAndTemplateLiterals(strippedText);
  const m = T_HELPER_DEF_RE.exec(masked);
  if (!m) return null;
  const paramsText = m[1] !== undefined ? m[1] : m[2];
  const second = (paramsText || '').split(',')[1];
  if (!second || !second.trim()) return null;
  const secondName = second.trim();
  const braceStart = masked.indexOf('{', m.index + m[0].length);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingBrace(masked, braceStart);
  if (braceEnd === -1) return null;
  const body = masked.slice(braceStart, braceEnd + 1);
  const escaped = secondName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a QUEUEING helper stores the parameter and runs it later (`queue.push({ name, fn })`,
  // `jobs.push([name, fn])`). That is neither "invoked here" nor boolean, so it is not judged (null), as the doc says —
  // reading it as boolean rolled back every install over forge-wait.test.cjs's real, queued assertions.
  const storesSecondParam = new RegExp('\\.push\\s*\\([^;]*\\b' + escaped + '\\b').test(body);
  if (storesSecondParam) return null;
  const invokesSecondParam = new RegExp('\\b' + escaped + '\\s*\\(').test(body);
  // forwarding the parameter to a test-runner registration (`test(name, fn)` / `it(name, fn)` from node:test) also
  // makes it a callback: the runner invokes it. Passing it to assert.ok(cond) does not, so only these names count.
  const forwardsToRunner = new RegExp('(?:^|[^.\\w])(?:test|it)\\s*\\([^()]*\\b' + escaped + '\\b').test(body);
  return invokesSecondParam || forwardsToRunner ? 'callback' : 'boolean';
}
/** vacuousBooleanTHelperSites(rawText) -> [{ line, snippet }, ...] every call site, in a file whose OWN `t`
 *  helper is boolean-style, where `t(name, cond)` is passed a bare, un-invoked function literal as `cond`
 *  (see BARE_FN_LITERAL_HEAD_RE for the exact rule). Returns [] for a 'callback'-style or unclassifiable
 *  file — see classifyTHelper. `line` is 1-based and matches the ORIGINAL file (stripJsComments now
 *  preserves every newline a block comment consumed, see its own header). The `t(`-call-site SCAN runs
 *  against the MASKED text (so a call site written only inside a string fixture is never matched, same
 *  reasoning as classifyTHelper above); each matched argument is then read back from the UNMASKED text at
 *  the identical index, so the reported snippet keeps its real content. */
function vacuousBooleanTHelperSites(rawText) {
  const text = stripJsComments(rawText);
  if (classifyTHelper(text) !== 'boolean') return [];
  const masked = maskStringAndTemplateLiterals(text);
  const out = [];
  const callRe = /\bt\s*\(/g;
  let cm;
  while ((cm = callRe.exec(masked)) !== null) {
    if (masked[cm.index - 1] === '.') continue; // a member call like `foo.t(`, not this file's own t()
    if (/\bfunction\s*$/.test(masked.slice(Math.max(0, cm.index - 20), cm.index))) continue; // the `function t(...)` DEFINITION site itself
    const openParen = cm.index + cm[0].length - 1;
    const { args, closeIdx } = splitTopLevelArgs(text, openParen); // read real content from the UNMASKED text
    if (closeIdx === -1 || args.length < 2) continue; // unbalanced, or not this 2-arg call shape -- never guess
    const cond = args[1].trim();
    if (BARE_FN_LITERAL_HEAD_RE.test(cond) && cond.endsWith('}')) {
      out.push({ line: text.slice(0, cm.index).split('\n').length, snippet: cond.replace(/\s+/g, ' ').slice(0, 70) });
    }
  }
  return out;
}

// --- check-the-checks: detect a "green no-op" — a *.test.cjs suite that runTests() reports as passing
// (passed > 0) but that contains ZERO real assertion call sites in its own source. Matches this codebase's two
// real local-helper conventions (`t('name', ...)` and `test('name', ...)`) plus direct `assert(...)`/
// `assert.foo(...)` calls, so it stays accurate across every existing suite regardless of which convention it
// uses (proven against all 51 real forge-bin/*.test.cjs suites at build time — every one has >=1 site).
//additionally folds in vacuousBooleanTHelperSites() above: a suite that clears the whole-suite
// check (it DOES have real assertion sites) can still carry individually-dead call sites the whole-suite check
// cannot see — see that function's own header for exactly what it catches and why the whole-suite check alone
// missed it (its own 12-site regression in this project's forge-doctor.test.cjs).
function checkTheChecks(root, testsResult) {
  const dir = path.join(claudeDir(root), 'forge-bin');
  const files = listByExt(dir, ['.cjs']).filter((f) => f.endsWith('.test.cjs'));
  const perSuite = (testsResult && Array.isArray(testsResult.perSuite)) ? testsResult.perSuite : [];
  const noOp = [];
  for (const f of files) {
    const base = path.basename(f);
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (countAssertionSites(text) > 0) {
      for (const vf of vacuousBooleanTHelperSites(text)) {
        noOp.push({
          suite: base, line: vf.line, snippet: vf.snippet,
          reason: 'line ' + vf.line + ': boolean-style t(name, cond) called with a bare, un-invoked function '
            + 'literal as cond ("' + vf.snippet + '…") -- a function reference is always truthy, so this '
            + 'one assertion body never runs even though the suite’s own tally looks clean',
        });
      }
      continue; // has real assertion call sites -> not a WHOLE-suite no-op (individual sites handled above)
    }
    const suiteResult = perSuite.find((s) => s.suite === base);
    // Only flag when the suite ALSO reported a passing tally (passed>0) with zero real assertion sites — that
    // exact combination means the printed tally cannot be genuine. A 0-assertion suite that also reports 0
    // passed is already caught honestly by runTests' own vacuous-tally rejection (suiteOk=false) — not a NEW
    // finding here, so it is intentionally not double-flagged.
    if (suiteResult && suiteResult.passed > 0) {
      noOp.push({ suite: base, passed: suiteResult.passed, reason: 'reports a passing tally but has 0 real assertion call sites (t(...)/test(...)/assert(...)) in its source — the tally cannot be genuine' });
    }
  }
  return { ok: noOp.length === 0, checked: files.length, noOp };
}

module.exports = {
  ASSERTION_SITE_RE, countAssertionSites, T_HELPER_DEF_RE, findMatchingBrace, splitTopLevelArgs,
  BARE_FN_LITERAL_HEAD_RE, maskStringAndTemplateLiterals, REGEX_PRECEDING_KEYWORDS, maskRegexLiterals,
  classifyTHelper, vacuousBooleanTHelperSites, checkTheChecks,
};
