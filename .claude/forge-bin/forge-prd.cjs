#!/usr/bin/env node
'use strict';
/**
 * forge-prd.cjs — zero-dependency PRD writer for Forge Mission Control Phase 2 (WP3 "PRD generator").
 * Windows-safe (node "C:/Program Files/nodejs/node.exe" or any Node on PATH).
 *
 * Renders a structured PRD object to a markdown document + a JSON meta sidecar, stores both via
 * forge-store.cjs (`.claude/forge-prd/`), and can auto-create one ticket per acceptance criterion
 * (`.claude/forge-tickets/`) so review gates and the Ticket Board pick them up automatically.
 *
 * REUSES forge-bin/forge-store.cjs (do not re-implement its guards):
 *   - redactValue      — deep-redacts every string leaf before anything touches disk or stdout.
 *   - resolveStoreDir  — path-contained resolution of the forge-prd/ store dir.
 *   - putEntity        — hardened, redacting, id-validated ticket writer (forge-tickets/).
 *   - isValidId        — same ^[A-Za-z0-9_-]+$ guard used everywhere in Forge (blocks traversal).
 *   - CLAUDE_DIR        — project .claude/ root (honors FORGE_STORE_ROOT for hermetic tests).
 *
 * PRD shape (`prd.sections` object, snake_case keys, each value a string OR an array of strings):
 *   goal, users, problem, solution, modules, user_stories, mvp_scope, non_goals, architecture, risks,
 *   test_plan, roadmap, and acceptance_criteria (array of {id?, text, owner?, required_tests?[]} or
 *   plain strings). A missing section renders as "_(not specified)_" — never crashes.
 *
 * FAILURE CONDITIONS. `failure_conditions` is the mirror of `acceptance_criteria`: the same
 * shape (array of {id?, text} or plain strings, ids defaulting to `fc-<n>` exactly as criteria default to
 * `ac-<n>`), rendered directly after them. It exists because measured on 2026-08-01 this project had a rich
 * vocabulary for "this must be true" and NONE for "this result is unacceptable" — the words
 * `failure_conditions`, `on_stuck`, `requires_inputs` and `result_caveat` returned zero hits repo-wide. A
 * spec that only lists successes cannot describe a run that technically passed every check and still produced
 * something nobody would accept ("looks like a generic template", "broken on mobile", "a file over 500 lines").
 *
 * The verify side lives in forge-verify.cjs::checkFailureConditions — a HIT condition is a blocker exactly
 * like a silently dropped acceptance criterion, and it gates. It is DELIBERATELY not created as tickets the
 * way criteria are: a ticket is work to do, while a failure condition is a state to stay out of, and minting
 * "tickets" nobody can ever close would make the board lie. NOTHING here is mandatory — a PRD without
 * failure_conditions renders "_(not specified)_" like any other absent section and no existing run changes
 * behaviour.
 *
 * OPTIONAL SECTIONS — `assumptions`, `invariants`, `stop_bound`. Unlike
 * every other section these render ONLY when the key is actually present with real content; when absent the
 * heading itself is skipped (not "_(not specified)_"), so an existing PRD written before this change renders
 * byte-identical (PRD failure condition fc-1). `assumptions` (prose or an array) sits right after Non-Goals —
 * four skills already tell the Lead to record guesses there and this renderer used to drop the key silently.
 * `invariants` is an id-bearing section like acceptance_criteria (default id prefix `inv-`), sitting right
 * after Failure Conditions; `stop_bound` (prose) sits right after Invariants — together the goal-contract
 * fields forge-verify reports on.
 *
 * CLARIFICATION MARKERS. Any string anywhere in `prd.sections` (prose, array entries, or an item's `text`)
 * may contain `[NEEDS CLARIFICATION: <question>]`. The Lead resolves one by rewriting it in place as
 * `[CLARIFIED: <answer>]`, which openClarifications() no longer reports. `openClarifications(prd)` is pure,
 * never throws, and returns every OPEN marker in document order — each returned question is ALSO redacted
 * by openClarifications() itself, independent of whether the source meta.json was ever written via
 * writePrd(). The CLI `clarifications <prd_id>` command reads the stored meta.json and exits 3/0/1 so a
 * beginner or the Head Chef can gate on it without parsing anything; `write`/`render` additionally print
 * `open clarifications: N` when N >= 1.
 *
 * CLI:
 *   node forge-prd.cjs render '<prd-json>'
 *     -> prints the rendered markdown to stdout. DRY — never writes anything.
 *   node forge-prd.cjs write '<prd-json>' [--run <run_id>] [--tickets]
 *     -> writePrd(); with --tickets also runs criteriaToTickets(); with --run logs prd_generated
 *        (and one ticket_created per created ticket) to that run's dashboard events via
 *        ../forge-dashboard/log-event.cjs (event types are already registered — nothing to add there).
 *   node forge-prd.cjs clarifications <prd_id>
 *     -> reads the stored .claude/forge-prd/<prd_id>.meta.json and prints one open marker per line as
 *        "<section>[/<id>]: <question>". Exit 3 when 1+ markers are open, 0 when none, 1 on a bad id or a
 *        missing file.
 *   node forge-prd.cjs amend <ticket_id> --gap "<text>" --found-by <review_id> --test <path>
 *       [--test <path> ...] --run <run_id> [--no-history]
 *     -> records a spec gap a review found: EVENT FIRST (ticket_updated with the spec_gap shape — if
 *        logging fails nothing is written, see amendTicket() below), then the ticket and the PRD meta
 *        both gain a `spec_gaps` entry `{id, ticket_id, gap, found_by, tests, run_id, at}`, the PRD
 *        markdown is re-rendered (a 'Spec gaps found in review' section appears only when spec_gaps is
 *        non-empty), and one line is appended to .claude/FORGE_TASK_HISTORY.md (skipped with
 *        --no-history). Exit 1 with a clear message, writing nothing, on any invalid input (bad/missing
 *        ticket or PRD, empty --gap, invalid --found-by/--run id, a credential-shaped ticket/found-by/run
 *        id, no --test, a --test path that escapes the project root (also through a link) / does not
 *        exist / is not a file, or the PRD locked by another amend). Exit 0 on success.
 *   Bad or missing JSON exits 1 with a clear message. Guarded end-to-end; never throws uncaught.
 *
 * Module API: require('./forge-prd.cjs') -> { renderPrd, writePrd, criteriaToTickets, openClarifications, amendTicket }
 *
 * SECRET HYGIENE: every string in the PRD is redacted (forge-store's redactValue) before it is
 * rendered to markdown or written to disk — a raw secret is never rendered, stored, or printed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactValue, redactText, resolveStoreDir, putEntity, isValidId, CLAUDE_DIR } = require('./forge-store.cjs');
const lockGuard = require('./forge-lock-guard.cjs');

// WP 2.1 state paths: forge-paths.cjs decides the layout (the opt-in .forge/ folder, else the legacy .claude/forge-*
// folders exactly as before). Guarded: a missing or older forge-paths.cjs keeps the legacy paths and never crashes.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
/** storeProject() -> the project root behind forge-store's CLAUDE_DIR when that is a real .claude folder, else null
 *  (a bare FORGE_STORE_ROOT test folder: every path below keeps its legacy literal under CLAUDE_DIR). */
function storeProject() {
  return CLAUDE_DIR && path.basename(CLAUDE_DIR).toLowerCase() === '.claude' ? path.dirname(CLAUDE_DIR) : null;
}
function inForgeLayout(root) {
  if (!forgePaths || !root) return false;
  try { return forgePaths.layout(root) === 'forge'; }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return false; }
}
/** storeRunsDir() -> the runs folder (forge layout: forge-paths stateDir; else <CLAUDE_DIR>/forge-runs as before). */
function storeRunsDir() {
  const root = storeProject();
  return inForgeLayout(root) ? forgePaths.stateDir(root, 'runs') : path.join(CLAUDE_DIR, 'forge-runs');
}
/** storeMemoryFile(name) -> the FORGE_* memory file IN USE: legacy <CLAUDE_DIR>/<name> as before; in the forge layout
 *  .forge/memory/<name>, or the legacy file while only that one exists (an append-only file never splits in two). */
function storeMemoryFile(name) {
  const root = storeProject();
  return inForgeLayout(root) && typeof forgePaths.memoryFile === 'function' ? forgePaths.memoryFile(root, name, { read: true }) : path.join(CLAUDE_DIR, name);
}

// ---- markdown rendering ----
const SECTION_ORDER = [
  ['Goal', 'goal'], ['Users', 'users'], ['Problem', 'problem'], ['Solution', 'solution'],
  ['Modules', 'modules'], ['User Stories', 'user_stories'], ['MVP Scope', 'mvp_scope'],
  ['Non-Goals', 'non_goals'],
  // OPTIONAL — renders only when present; see OPTIONAL_SECTIONS below.
  ['Assumptions (auto-filled)', 'assumptions'],
  ['Architecture', 'architecture'], ['Risks', 'risks'],
  ['Acceptance Criteria', 'acceptance_criteria'],
  // directly after the criteria it mirrors — a reader who has just read what must be true reads what must
  // never be true in the same breath, which is the whole point of writing the failure side down
  ['Failure Conditions', 'failure_conditions'],
  // OPTIONAL — the goal-contract fields: what must stay true (invariants) and
  // where a run must stop. Sit right after the criteria/failures they constrain.
  ['Invariants', 'invariants'],
  ['Stop Bound', 'stop_bound'],
  ['Test Plan', 'test_plan'], ['Roadmap', 'roadmap'],
];
/** ITEM_SECTIONS — sections whose entries are id-bearing items rather than free prose, with the id PREFIX
 *  each one defaults to. Kept as data so the renderer treats criteria and failure conditions identically
 *  (they are the two halves of one spec) and so a third such section is one line, not a copied branch. */
const ITEM_SECTIONS = { acceptance_criteria: 'ac-', failure_conditions: 'fc-', invariants: 'inv-' };
// OPTIONAL_SECTIONS — sections that render ONLY when present with real content; when absent the heading
// itself is skipped rather than falling back to NOT_SPECIFIED, so a PRD written before this change (no such
// keys) renders byte-identical (PRD failure condition fc-1). Every other section keeps its existing
// "always render the heading, NOT_SPECIFIED when empty" behaviour unchanged.
const OPTIONAL_SECTIONS = new Set(['assumptions', 'invariants', 'stop_bound']);
const NOT_SPECIFIED = '_(not specified)_';
/** hasSectionContent(value) -> true when an OPTIONAL_SECTIONS value actually has something to render:
 *  a non-empty array, or a non-blank string. Anything else (undefined, null, '', [], a stray number/object)
 *  counts as absent. Never throws. */
function hasSectionContent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return false;
}

function renderCriterion(c, idx, prefix) {
  if (typeof c === 'string') { const s = c.trim(); return '- ' + (s || '(empty criterion)'); }
  if (c && typeof c === 'object') {
    const id = c.id || ((prefix || 'ac-') + (idx + 1));
    const text = (typeof c.text === 'string' && c.text.trim()) || '(no text)';
    let line = '- **' + id + '** — ' + text;
    if (c.owner) line += ' _(owner: ' + c.owner + ')_';
    if (Array.isArray(c.required_tests) && c.required_tests.length) line += ' _(tests: ' + c.required_tests.join(', ') + ')_';
    return line;
  }
  return '- (invalid criterion)';
}
function renderSectionBody(key, value) {
  if (Object.prototype.hasOwnProperty.call(ITEM_SECTIONS, key)) {
    const arr = Array.isArray(value) ? value : (value ? [value] : []);
    if (!arr.length) return NOT_SPECIFIED;
    return arr.map((c, i) => renderCriterion(c, i, ITEM_SECTIONS[key])).join('\n');
  }
  if (Array.isArray(value)) {
    if (!value.length) return NOT_SPECIFIED;
    return value.map((v) => '- ' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return NOT_SPECIFIED;
}
// ---- spec gaps found in review (forge-prd.cjs amend) ----
// `spec_gaps` is a TOP-LEVEL array (prd.spec_gaps), deliberately NOT inside `sections` — see
// amendTicket() below for why: openClarifications() must never scan a found gap for a
// "[NEEDS CLARIFICATION: ...]" marker that was never meant to open one. Renders only when non-empty,
// exactly like the OPTIONAL_SECTIONS pattern above, so a PRD with no spec_gaps (every PRD written before
// this feature existed) renders byte-identical to before (fc-1).
/** inertText(s) -> s with every line break collapsed to a single space. Markdown only treats a leading
 *  "#" as a heading when it starts a LINE, so collapsing embedded newlines is enough to stop a gap's own
 *  free text ("...\n## Heading...") from creating new document structure once interpolated into the
 *  rendered markdown or a one-line FORGE_TASK_HISTORY.md entry. Never throws. */
function inertText(s) { return String(s == null ? '' : s).replace(/\r\n|\r|\n/g, ' '); }
/** jsonFailure(e) -> why a JSON file or argument could not be used, as the end of a sentence, never quoting its
 *  text. A parse error's message can carry an excerpt of the input ('Unexpected token ..., ""prd_id":ghp_A1b2"...
 *  is not valid JSON'), which may hold part of a credential (Verify Boss round 3, note 4), so a SyntaxError is
 *  described without it. A read error (EISDIR, EACCES, ENOENT ...) keeps its own message — it names the cause
 *  and the path, none of the content — and is not called invalid JSON. */
function jsonFailure(e) {
  if (e instanceof SyntaxError || (e && e.name === 'SyntaxError')) return 'is not valid JSON (the parser excerpt is not shown, it may contain sensitive text)';
  return 'could not be read: ' + String((e && e.message) || e || 'unknown error');
}
/** escapeGapInline(s) -> inertText(s) with markdown/HTML metacharacters neutralised (W2-11, Codex finding:
 *  inertText() alone only stops a NEW LINE from starting document structure — it does nothing about a tag,
 *  an HTML comment, a markdown link, or markdown emphasis sitting on the SAME line). Order matters: the
 *  backslash itself is escaped FIRST (W2-11 verification — a literal backslash in the SOURCE text
 *  must be doubled before any later step in this function inserts its OWN backslash, or a source backslash
 *  sitting right before a '*'/'_'/backtick could combine with an escape this function just added and change
 *  its meaning); then '&' (so none of the entities this function inserts next is escaped a second time);
 *  then '<'/'>' (blocks a raw HTML tag and an HTML comment delimiter); then '['/']' as &#91;/&#93; (same idea
 *  as forge-vault.cjs's inert() — blocks a markdown link); then '*'/'_' are backslash-escaped (blocks
 *  markdown emphasis); then a backtick is backslash-escaped (blocks a markdown code span). Never throws. */
function escapeGapInline(s) {
  return inertText(s)
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    // Verify Boss F5: GFM strikethrough and extended autolinks. '~' is backslash-escaped; a scheme's
    // '://' and a bare 'www.' get an entity in the middle, so they are no longer one literal run of text
    // that a GFM renderer would turn into a link.
    .replace(/~/g, '\\~')
    .replace(/:\/\//g, '&#58;//')
    .replace(/\bwww\./gi, (m) => m.slice(0, 3) + '&#46;');
}
/** renderSpecGapEntry(g) -> one markdown bullet for a spec_gaps[] entry, or null for a malformed one —
 *  same defensive, never-crash-the-whole-render posture as renderCriterion(). EVERY interpolated field
 *  (id, ticket_id, gap text, found_by, tests — W2-11 verification widened this to id/ticket_id too,
 *  which previously rendered raw) goes through escapeGapInline() here too (belt-and-braces): this guarantee
 *  must hold for the renderer itself, independent of whether the entry arrived via amendTicket() (whose own
 *  ids/ticket ids are already isValidId()-shaped and so never need it in practice) or a hand-written meta
 *  fixture (whose id/ticket_id are NOT shape-restricted at all). */
function renderSpecGapEntry(g) {
  if (!g || typeof g !== 'object') return null;
  const id = escapeGapInline((typeof g.id === 'string' && g.id.trim()) || '(no id)');
  const ticketId = escapeGapInline((typeof g.ticket_id === 'string' && g.ticket_id.trim()) || '(no ticket)');
  const text = escapeGapInline((typeof g.gap === 'string' && g.gap.trim()) || '(no gap text)');
  const foundBy = escapeGapInline((typeof g.found_by === 'string' && g.found_by.trim()) || '(unknown)');
  const tests = Array.isArray(g.tests) && g.tests.length ? g.tests.map((x) => escapeGapInline(String(x))).join(', ') : '(no tests linked)';
  return '- **' + id + '** on ' + ticketId + ' — ' + text + ' _(found by: ' + foundBy + '; regression test(s): ' + tests + ')_';
}
/** renderPrd(prd) -> markdown string. Pure, guarded — never throws on a malformed/partial prd. */
function renderPrd(prd) {
  const p = (prd && typeof prd === 'object') ? redactValue(prd) : {};
  const sections = (p.sections && typeof p.sections === 'object') ? p.sections : {};
  const lines = [];
  lines.push('# ' + (p.title || 'Untitled PRD'));
  lines.push('');
  lines.push('_prd_id: ' + (p.prd_id || '—') + ' · project: ' + (p.project || '—') + ' · created: ' + (p.created || '—') + '_');
  for (const [heading, key] of SECTION_ORDER) {
    // fc-1: an optional section absent from an old-shape PRD is skipped entirely (no heading at all),
    // not rendered as NOT_SPECIFIED — that is what makes a pre-existing PRD render byte-identical.
    if (OPTIONAL_SECTIONS.has(key) && !hasSectionContent(sections[key])) continue;
    lines.push('');
    lines.push('## ' + heading);
    lines.push('');
    lines.push(renderSectionBody(key, sections[key]));
  }
  if (Array.isArray(p.spec_gaps) && p.spec_gaps.length) {
    lines.push('');
    lines.push('## Spec gaps found in review');
    lines.push('');
    lines.push(p.spec_gaps.map(renderSpecGapEntry).filter(Boolean).join('\n'));
  }
  return lines.join('\n').trimEnd() + '\n';
}

// ---- clarification markers (scanner rewritten 2026-10-01) ----
// A resolved marker is rewritten by the Lead as [CLARIFIED: ...] in place, which the literal
// "[NEEDS CLARIFICATION:" prefix below simply does not match — no separate "resolved" bookkeeping needed.
const CLARIFICATION_PREFIX = '[NEEDS CLARIFICATION:';
// placeholder recognition is limited to EXACTLY these documented forms (compared after trimming) —
// documentation of the marker SYNTAX itself, found by dogfooding on the PRD. Anything else in angle
// brackets, such as "<EU or US?>", is a REAL question, not a placeholder — a broad "any <...>" rule used to
// swallow it.
const PLACEHOLDER_FORMS = new Set(['', '...', '…', '<question>', '<plain question>']);
function isPlaceholderQuestion(q) { return PLACEHOLDER_FORMS.has(q); }
/** findMarkers(str) -> array of trimmed, OPEN question strings found in str, in document order. Never
 *  throws. W1-02: a bounded, LINEAR scanner (no regex) — finds the literal "[NEEDS CLARIFICATION:" prefix
 *  and reads the question up to the MATCHING closing "]", counting nested "["/"]" so a question that itself
 *  contains a bracket pair ("use [EU] or US?") stays whole instead of truncating at the first "]". A marker
 *  whose closing bracket never arrives is ignored; because finding that out already means scanning every
 *  remaining character once, that single failed attempt ends the whole scan (nothing after it is left
 *  unexamined) — so many repeated unterminated prefixes stay linear instead of the old regex's quadratic
 *  blow-up (measured: ~8/23/88ms for 1k/2k/4k repeats before this fix). */
/** capQuestion(q) -> q capped at MAX_QUESTION_CHARS. Applied only AFTER redaction (Codex W1-N04). */
const MAX_QUESTION_CHARS = 200;
function capQuestion(q) { const s = String(q == null ? '' : q); return s.length > MAX_QUESTION_CHARS ? s.slice(0, MAX_QUESTION_CHARS - 1) + '…' : s; }
function findMarkers(str) {
  if (typeof str !== 'string' || !str) return [];
  const out = [];
  const len = str.length;
  let i = 0;
  while (i < len) {
    if (str.startsWith(CLARIFICATION_PREFIX, i)) {
      // Codex W1-N01: the prefix written as documentation (inside `backticks`, or escaped as \[) is text, not a
      // question. Skip past it and keep scanning, which stays linear.
      const before = i > 0 ? str.charCodeAt(i - 1) : 0;
      if (before === 92 /* '\' */) { i += CLARIFICATION_PREFIX.length; continue; }
      // Verify Boss V-01: after a backtick it is documentation ONLY when that code span closes (the next
      // backtick) before the marker's own closing bracket, as in `[NEEDS CLARIFICATION:`. A whole marker in
      // backticks is a real question: the instructions themselves show it that way. The scan stops at the first
      // backtick, so this stays linear.
      const inTicks = before === 96 /* '`' */;
      let depth = 1; // the marker's own opening "["
      let j = i + CLARIFICATION_PREFIX.length;
      let end = -1;
      let spanClosed = false;
      while (j < len) {
        const ch = str.charCodeAt(j);
        if (inTicks && ch === 96 /* '`' */) { spanClosed = true; break; }
        if (ch === 91 /* '[' */) depth++;
        else if (ch === 93 /* ']' */) { depth--; if (depth === 0) { end = j; break; } }
        j++;
      }
      if (inTicks && spanClosed) { i += CLARIFICATION_PREFIX.length; continue; }
      // Unterminated: the scan above already reached the end of the string, so stopping keeps this linear. The
      // malformed marker is reported as OPEN with its text so far (capped), so neither it nor a valid marker
      // after it can silently disappear: blocking is the safe side.
      if (end === -1) {
        // Codex W1-N04: NOT cut here. openClarifications() redacts first and only then caps the length, so a
        // token crossing the cut can never leak as a fragment the redactor no longer recognises.
        const rest = str.slice(i + CLARIFICATION_PREFIX.length).trim();
        out.push('(marker without a closing bracket) ' + rest);
        return out;
      }
      const q = str.slice(i + CLARIFICATION_PREFIX.length, end).trim();
      if (!isPlaceholderQuestion(q)) out.push(q);
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
}
/** openClarifications(prd) -> [{ section, id|null, question }] for every OPEN [NEEDS CLARIFICATION: ...]
 *  marker in prd.sections, in document order (known sections in SECTION_ORDER first, then any remaining
 *  keys in their own object order). Scans: a section's own prose string; each string entry of an array
 *  section; and the `.text` of each item in an id-bearing item section (acceptance_criteria,
 *  failure_conditions, invariants) or any object item with an explicit `.id`. `id` is the item's explicit
 *  id, or the same default (`<prefix>-<n>`) the renderer assigns for an id-bearing section, or null when
 *  the marker sits in prose/a plain string entry.
 *  an item section is scanned in EVERY shape renderSectionBody accepts for it — an array of items,
 *  OR a single item (string or object) not wrapped in an array at all — using the same
 *  `Array.isArray(value) ? value : (value ? [value] : [])` unwrap the renderer already applies, so a lone
 *  criterion/failure-condition/invariant object can no longer disappear just because it wasn't an array.
 *  every returned `question` is redacted here, at the source, via the same redactValue() this file
 *  already imports — this does NOT depend on the prd/meta object having passed through writePrd() first,
 *  so a hand-written or directly-read meta fixture still comes out redacted.
 *  Pure and guarded — a malformed prd returns []. */
function openClarifications(prd) {
  try {
    const sections = (prd && typeof prd === 'object' && prd.sections && typeof prd.sections === 'object' && !Array.isArray(prd.sections)) ? prd.sections : null;
    if (!sections) return [];
    const results = [];
    const orderedKeys = SECTION_ORDER.map(([, k]) => k).filter((k) => Object.prototype.hasOwnProperty.call(sections, k));
    for (const k of Object.keys(sections)) if (!orderedKeys.includes(k)) orderedKeys.push(k);

    const pushQuestions = (section, id, text) => {
      // every returned field is redacted (an item id can carry a token too), and the question
      // is capped only AFTER redaction.
      for (const question of findMarkers(text)) {
        results.push({ section: redactValue(section), id: id == null ? null : redactValue(String(id)), question: capQuestion(redactValue(question)) });
      }
    };

    for (const key of orderedKeys) {
      const value = sections[key];
      const isItemSection = Object.prototype.hasOwnProperty.call(ITEM_SECTIONS, key);
      if (isItemSection) {
        // same singleton unwrap as renderSectionBody, so a lone (non-array) item is still scanned.
        const arr = Array.isArray(value) ? value : (value ? [value] : []);
        arr.forEach((item, i) => {
          if (typeof item === 'string') pushQuestions(key, null, item);
          else if (item && typeof item === 'object') pushQuestions(key, item.id || (ITEM_SECTIONS[key] + (i + 1)), item.text);
        });
      } else if (typeof value === 'string') {
        pushQuestions(key, null, value);
      } else if (Array.isArray(value)) {
        value.forEach((item) => {
          if (typeof item === 'string') pushQuestions(key, null, item);
          else if (item && typeof item === 'object') pushQuestions(key, item.id || null, item.text);
        });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

// ---- store writes (forge-prd/<id>.md + <id>.meta.json + index.jsonl) ----
function resolvePrdFile(id, ext) {
  if (!isValidId(id)) throw new Error('writePrd: invalid prd_id (allowed: A-Z a-z 0-9 _ -): ' + id);
  const dir = resolveStoreDir('prd');
  const file = path.join(dir, id + ext);
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('writePrd: id escapes forge-prd/ — refused');
  return { dir, file };
}
/** writePrd(prd) -> { prd_id, mdPath, metaPath }. Validates prd_id, redacts, writes md+meta+index row. */
function writePrd(prd) {
  if (!prd || typeof prd !== 'object') throw new Error('writePrd: prd must be an object');
  const id = prd.prd_id;
  const { dir, file: mdPath } = resolvePrdFile(id, '.md');
  const { file: metaPath } = resolvePrdFile(id, '.meta.json');
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactValue(prd);
  const md = renderPrd(redacted);
  const generated = new Date().toISOString();
  const meta = Object.assign({}, redacted, { _generated: generated });
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ id, ts: generated, store: 'prd', title: redacted.title || '' }) + '\n', 'utf8');
  return { prd_id: id, mdPath, metaPath };
}

// ---- acceptance criteria -> tickets (forge-tickets/tk-<prd_id>-<n>) ----
/** criteriaToTickets(prd, opts) -> array of created ticket ids. Never crashes on a bad ticket id — skips + warns. */
function criteriaToTickets(prd, opts) {
  opts = opts || {};
  if (!prd || typeof prd !== 'object') return [];
  const redacted = redactValue(prd);
  const prdId = redacted.prd_id;
  const raw = (redacted.sections && redacted.sections.acceptance_criteria) || [];
  const criteria = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const created = [];
  criteria.forEach((c, i) => {
    const n = i + 1;
    const ticketId = 'tk-' + prdId + '-' + n;
    if (!isValidId(ticketId)) { console.error('forge-prd: skipping invalid ticket id "' + ticketId + '"'); return; }
    const text = typeof c === 'string' ? c : ((c && c.text) || ('acceptance criterion ' + n));
    const owner = (c && typeof c === 'object' && c.owner) || null;
    const requiredTests = (c && typeof c === 'object' && Array.isArray(c.required_tests)) ? c.required_tests : [];
    const criterionId = (c && typeof c === 'object' && c.id) || ('ac-' + n);
    const value = {
      ticket_id: ticketId, prd_id: prdId, run_id: opts.run_id || opts.run || null,
      title: text, description: 'Acceptance criterion ' + criterionId + ' for PRD ' + prdId,
      owner, status: 'open', required_tests: requiredTests, related_files: [], risk_level: 'med',
      created: new Date().toISOString(),
    };
    try { putEntity('tickets', ticketId, value); created.push(ticketId); }
    catch (e) { console.error('forge-prd: failed to create ticket ' + ticketId + ': ' + e.message); }
  });
  return created;
}

// W2-08a: bounded well below forge-lock-guard's DEFAULT_TTL_MS (30 min) so a
// wedged/hung child process can never hold the PRD-scoped amend lock open indefinitely. On a timeout Node's
// spawnSync sets status to null (and signal to 'SIGTERM') — amendTicket's existing
// `!logResult || logResult.status !== 0` check already treats that as a hard logging failure ("aborting,
// nothing written"); no separate handling is needed here beyond supplying the bound itself.
const LOG_EVENT_TIMEOUT_MS = 30000;
function logEvent(runId, eventType, extra) {
  const logEventPath = path.join(CLAUDE_DIR, 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8', timeout: LOG_EVENT_TIMEOUT_MS });
}

// ---- amend: write a review-found spec gap back into a ticket + its PRD ----
// prd-w2-discipline ac-4: "When a review finds a bug, nothing writes the gap back into the originating
// ticket or links a regression test." amendTicket() is the fix — see the CLI doc comment above for the
// exact shape and failure modes.
const MAX_GAP_CHARS = 500;
function capGapText(s) {
  const str = String(s == null ? '' : s);
  return str.length > MAX_GAP_CHARS ? str.slice(0, MAX_GAP_CHARS) : str;
}
/** containedEntityFile(dir, id, ext) -> absolute file path, or null when id is not isValidId()-shaped or
 *  the resolved path would escape dir. Mirrors forge-store.cjs's own resolveEntityFile()/resolvePrdFile()
 *  above — kept local because amendTicket() takes dir as a SEAM (tests need a store dir that is not tied
 *  to the single process-wide FORGE_STORE_ROOT), so it cannot call through resolveStoreDir() directly. */
function containedEntityFile(dir, id, ext) {
  if (!isValidId(id)) return null;
  const file = path.join(dir, id + ext);
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return file;
}
/** isPathContained(base, candidate) -> true iff candidate IS base or lies strictly inside it, using
 *  path.relative() rather than a lexical startsWith() (Codex finding). A lexical check is wrong two
 *  ways on win32: it treats a differently-cased drive letter ("C:\..." vs "c:\...") as a DIFFERENT path
 *  even though NTFS/ReFS are case-insensitive (a false escape), and — when applied to an UNRESOLVED path —
 *  it can accept a path that only LOOKS contained before symlinks/junctions are followed. This helper does
 *  no filesystem I/O itself; the caller decides whether to pass raw resolved paths or realpath-resolved
 *  ones. Case-insensitive on win32, case-sensitive elsewhere. Never throws. */
function isPathContained(base, candidate) {
  const nocase = process.platform === 'win32';
  const b = nocase ? base.toLowerCase() : base;
  const c = nocase ? candidate.toLowerCase() : candidate;
  if (b === c) return true;
  const rel = path.relative(b, c);
  if (!rel || path.isAbsolute(rel)) return false; // different drive on win32 -> relative() returns the target unchanged (absolute)
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}
/** resolveTestPath(root, rawPath) -> {ok:true, rel} | {ok:false, reason}. `rel` is POSIX-style
 *  (forward slashes) and relative to root, for a stable, Windows-safe stored record. An absolute path
 *  INSIDE root is accepted (path.resolve(root, abs) returns abs unchanged, and it still passes
 *  containment); an absolute or ".."-relative path OUTSIDE root is refused. Never throws.
 *
 *  containment is checked TWICE. First a cheap lexical pass on the resolved-but-not-
 *  realpath'd paths (via isPathContained, case-insensitive on win32) — this runs BEFORE the existence check
 *  below so a target that does not exist on disk is still reported as "escapes the project root" rather than
 *  "does not exist", exactly as before, and it is what makes an uppercase/lowercase drive-letter spelling of
 *  a real in-root path pass instead of being wrongly rejected. Second, AFTER the file is confirmed to exist
 *  and be a regular file, both root and candidate are resolved through fs.realpathSync() and re-checked —
 *  statSync() above already follows symlinks/junctions, so a junction placed INSIDE root that points OUTSIDE
 *  it would otherwise pass every earlier check while the real file lives elsewhere; realpath resolution
 *  catches exactly that. */
function resolveTestPath(root, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, reason: 'empty --test path' };
  const candidate = rawPath.trim();
  const base = path.resolve(root);
  const abs = path.resolve(base, candidate);
  if (!isPathContained(base, abs)) return { ok: false, reason: '--test path escapes the project root: ' + candidate };
  if (!fs.existsSync(abs)) return { ok: false, reason: '--test path does not exist: ' + candidate };
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { return { ok: false, reason: '--test path cannot be read (' + e.message + '): ' + candidate }; }
  if (!stat.isFile()) return { ok: false, reason: '--test path is not a file: ' + candidate };
  let realBase, realAbs;
  try { realBase = fs.realpathSync(base); realAbs = fs.realpathSync(abs); }
  catch (e) { return { ok: false, reason: '--test path cannot be resolved (' + e.message + '): ' + candidate }; }
  if (!isPathContained(realBase, realAbs)) return { ok: false, reason: '--test path escapes the project root: ' + candidate };
  const rel = path.relative(realBase, realAbs).split(path.sep).join('/');
  return { ok: true, rel: rel || candidate };
}
/** sanitizeGapField(s) -> s run through redactText() THEN redactValue() (Codex findings).
 *  redactText() catches a LABELLED credential sitting in ordinary free prose ("password=hunter2",
 *  "client_secret: abc123") that redactValue()'s pattern-only pass never looks for (it only scans object
 *  KEY names, and this is free text, not a key); redactValue() then re-applies the fixed-shape
 *  SECRET_PATTERNS (an unlabelled nvapi-/sk-/ghp_-style token embedded anywhere, including inside an id or
 *  a file name). Used for EVERY string field of a spec_gaps entry — gap text, found_by, each test path —
 *  so the SAME sanitised value is what gets logged, stored, rendered, and written to history; nothing
 *  downstream can see a value that skipped this pass. Never throws (both callees are themselves guarded). */
function sanitizeGapField(s) {
  return redactValue(redactText(s == null ? '' : String(s)));
}
/** maxGapNumber(arr) -> the highest N found across every well-formed "gap-N" id in arr, or 0. Used to
 *  allocate a NEW gap id as max(meta.spec_gaps, ticket.spec_gaps) + 1 (W2-07c) instead of
 *  meta.spec_gaps.length + 1 — a retry after a partial failure (ticket written, meta write failed) must
 *  never reallocate the SAME id a second time just because meta's own array still looks short. */
function maxGapNumber(arr) {
  if (!Array.isArray(arr)) return 0;
  let max = 0;
  for (const g of arr) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string') continue;
    const m = /^gap-(\d+)$/.exec(g.id.trim());
    if (!m) continue;
    const v = parseInt(m[1], 10);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}
/** maxGapNumberAcrossTickets(ticketsDir, prdId) -> the highest "gap-N" found across EVERY ticket file in
 *  ticketsDir whose prd_id === prdId (W2-07b, Codex finding). maxGapNumber(meta.spec_gaps) alone is not
 *  enough: if ticket A's OWN write succeeds but the PRD meta's write then fails, meta.spec_gaps stays empty
 *  while A's ticket.spec_gaps already carries "gap-1" — a later amend on a DIFFERENT ticket B of the same
 *  PRD would otherwise see max(meta=0, B's-own-ticket=0)+1 = "gap-1" again, colliding with A's already-
 *  persisted entry. Scanning every ticket of the PRD (not just the one being amended) closes that gap.
 *  Reads only *.json files already inside ticketsDir (no path built from untrusted input); a ticket file
 *  that fails to parse, or belongs to a different PRD, is skipped. Never throws. */
function maxGapNumberAcrossTickets(ticketsDir, prdId) {
  let files = [];
  try { files = fs.readdirSync(ticketsDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let max = 0;
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(ticketsDir, f), 'utf8')); } catch { continue; }
    if (!data || typeof data !== 'object' || data.prd_id !== prdId) continue;
    const m = maxGapNumber(data.spec_gaps);
    if (m > max) max = m;
  }
  return max;
}
/** findMatchingGapEntry(arr, ticketId, gap, foundBy, tests) -> the existing entry in arr whose ticket_id/
 *  gap/found_by/tests are ALL IDENTICAL to the (already-validated/sanitised) values of this call, or null.
 *  Powers the W2-07d idempotent repair: a retry of the exact same amend reuses the matching entry's id
 *  instead of minting a new one, so re-running a failed amend heals the missing side (ticket or meta)
 *  rather than creating a duplicate. ticket_id is REQUIRED in the match (W2-N01, Codex finding): meta.
 *  spec_gaps is the UNION of every ticket's gaps for this PRD, so without a ticket_id check, amending a
 *  DIFFERENT ticket with textually-identical gap/found_by/tests would wrongly match and REUSE the first
 *  ticket's entry — misattributing it to the wrong ticket instead of allocating its own id. */
function findMatchingGapEntry(arr, ticketId, gap, foundBy, tests) {
  if (!Array.isArray(arr)) return null;
  const testsKey = JSON.stringify(tests);
  for (const g of arr) {
    if (g && typeof g === 'object' && g.ticket_id === ticketId && g.gap === gap && g.found_by === foundBy && JSON.stringify(g.tests) === testsKey) return g;
  }
  return null;
}
/** writeFileAtomic(file, content) -> writes content to a temp file in the SAME directory, then
 *  fs.renameSync()s it over the target (W2-07a, Codex finding). A direct fs.writeFileSync() on the real
 *  path can be interrupted mid-write (crash, disk full, kill) leaving a truncated, unparseable JSON file on
 *  disk; a rename is atomic on both POSIX and NTFS, so `file` is always either the OLD complete content or
 *  the NEW complete content, never a partial one. Same idea as forge-lock-guard.cjs's replaceOwnAtomic(). */
function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
/**
 * amendTicket(opts) -> { ok:true, ticketId, prdId, gapId, ticketFile, metaFile, mdFile, historyPath,
 * historyAppended }. Throws a plain Error (message safe to print) on any invalid input, a failed log, a
 * held PRD lock, or a write failure — in every case NOTHING new reaches disk beyond whatever a PRIOR
 * (already-returned) call already wrote: a change that cannot be logged is not made, a bad input never
 * lands partially, and a write that fails partway never corrupts an existing file (see writeFileAtomic()).
 *
 * opts: ticketId, gap, foundBy, tests (array of path strings), runId, noHistory (bool), and SEAMS for
 * hermetic testing (a single test PROCESS cannot vary FORGE_STORE_ROOT per call, since forge-store.cjs
 * resolves CLAUDE_DIR once at module load — these let one test file exercise many independent scenarios):
 *   - log(runId, type, extra) -> {status, stderr?}  — defaults to logEvent() above.
 *   - ticketsDir / prdDir — default resolveStoreDir('tickets') / resolveStoreDir('prd').
 *   - root — the project root test paths must resolve inside; default the real project root
 *     (path.resolve(CLAUDE_DIR, '..')), i.e. CLAUDE_DIR's parent, matching every other tool's "project
 *     root is .claude's parent" convention.
 *   - historyPath — default .claude/FORGE_TASK_HISTORY.md (path.join(CLAUDE_DIR, ...), already hermetic
 *     via FORGE_STORE_ROOT like every other path in this file).
 *   - writeFile(file, content) -> void — defaults to writeFileAtomic() above; a test seam only, to inject
 *     a failure on one specific file and prove the OTHER file is left untouched.
 *
 * one PRD-scoped exclusive lock (forge-lock-guard.cjs, hotspot
 * "forge-prd-amend:<prd_id>") is held across the authoritative read, id allocation, the event log, and
 * every write, so two concurrent amends on the SAME PRD can never both read the same spec_gaps length and
 * both allocate "gap-N". A second amend while the lock is held FAILS FAST with a clear "locked" message and
 * writes nothing — chosen over a wait-and-retry loop because a review-found gap is reported by a human
 * workflow that should see the conflict immediately, not hang silently. A stale lock (its holder crashed)
 * is taken over automatically by forge-lock-guard's own TTL logic; the lock is always released in a
 * `finally`, success or failure. The lock key needs prd_id, which lives INSIDE the ticket, so a lightweight
 * unlocked peek read happens first purely to pick the right lock; everything that actually matters (the
 * authoritative ticket/meta read used for id-allocation and the idempotent-repair check) happens again
 * AFTER the lock is held.
 *
 * Order of operations (ac-4 + W2-07/W2-08): validate everything that does not need PRD state first (write
 * nothing on failure) -> acquire the PRD lock -> re-read ticket+meta -> sanitise every gap field (W2-04/
 * W2-05) -> find a matching existing entry or allocate a new id (W2-07c/d) -> log ticket_updated with the
 * spec_gap FIRST -> only once that succeeds, compute ALL new file contents (W2-07b), then write only the
 * files that actually changed, atomically -> (unless --no-history) append one FORGE_TASK_HISTORY.md line
 * -> release the lock.
 */
function amendTicket(opts) {
  opts = opts || {};
  const log = typeof opts.log === 'function' ? opts.log : logEvent;
  const ticketsDir = opts.ticketsDir || resolveStoreDir('tickets');
  const prdDir = opts.prdDir || resolveStoreDir('prd');
  if (!CLAUDE_DIR) throw new Error('forge-prd amend: no project root found (no .claude, .forge or .git above the current folder)');
  const root = opts.root ? path.resolve(opts.root) : path.resolve(CLAUDE_DIR, '..');
  const historyPath = opts.historyPath || storeMemoryFile('FORGE_TASK_HISTORY.md');
  const noHistory = !!opts.noHistory;
  const writeFile = typeof opts.writeFile === 'function' ? opts.writeFile : writeFileAtomic;
  // Lock storage rides on CLAUDE_DIR (not forge-lock-guard's own FORGE_PROJECT_ROOT default) so it
  // automatically inherits FORGE_STORE_ROOT's hermetic-test redirection like every other path in this file.
  // WP 2.1: for a real project's .claude it is the runs folder of that project's layout - the same folder
  // forge-lock-guard.cjs uses - and a bare FORGE_STORE_ROOT test folder keeps <dir>/forge-runs as before.
  const lockDir = path.join(storeRunsDir(), '.hotspot-locks');

  // ---- validation that needs no PRD state (ac-4: write nothing on failure) ----
  const ticketId = opts.ticketId;
  if (!isValidId(ticketId)) throw new Error('forge-prd amend: invalid or missing ticket_id');
  // REJECT outright — before any ticket/PRD read, the lock, or logging —
  // any identifier whose own redaction differs from itself (i.e. it LOOKS like a secret: nvapi-/sk-/ghp_-
  // style and similar). Masking an identifier field is the wrong fix here: a masked ticket_id/run_id/
  // found_by can no longer be used to find the record it names, so the only safe move is to refuse the
  // whole amend and write nothing. A --test PATH is NOT an identifier field, so it is unaffected by this
  // rule — it stays on the "sanitise, don't reject" side (sanitizeGapField below).
  if (redactText(ticketId) !== ticketId) throw new Error('forge-prd amend: ticket_id looks credential-shaped — refusing (nothing written)');
  const ticketFile = containedEntityFile(ticketsDir, ticketId, '.json');
  if (!ticketFile || !fs.existsSync(ticketFile)) throw new Error('forge-prd amend: ticket not found: ' + ticketId);

  const rawGap = typeof opts.gap === 'string' ? opts.gap.trim() : '';
  if (!rawGap) throw new Error('forge-prd amend: --gap is required and must be non-empty');

  const foundBy = opts.foundBy;
  if (!isValidId(foundBy)) throw new Error('forge-prd amend: --found-by must be a valid id (allowed: A-Z a-z 0-9 _ -)');
  if (redactText(foundBy) !== foundBy) throw new Error('forge-prd amend: --found-by looks credential-shaped — refusing (nothing written)');

  const runId = opts.runId;
  if (!isValidId(runId)) throw new Error('forge-prd amend: --run must be a valid id — an event needs a run first');
  if (redactText(runId) !== runId) throw new Error('forge-prd amend: --run looks credential-shaped — refusing (nothing written)');

  const rawTests = Array.isArray(opts.tests) ? opts.tests : [];
  if (!rawTests.length) throw new Error('forge-prd amend: at least one --test is required');
  const resolvedTests = [];
  for (const rawPath of rawTests) {
    const r = resolveTestPath(root, rawPath);
    if (!r.ok) throw new Error('forge-prd amend: ' + r.reason);
    resolvedTests.push(r.rel);
  }

  // Lightweight, UNLOCKED peek — only to learn prd_id so the right PRD-scoped lock can be taken.
  // The authoritative read happens again just below, once the lock is held.
  let ticketPeek;
  try { ticketPeek = JSON.parse(fs.readFileSync(ticketFile, 'utf8')); }
  catch (e) { throw new Error('forge-prd amend: ticket ' + ticketId + ' ' + jsonFailure(e)); }
  const prdId = ticketPeek && ticketPeek.prd_id;
  if (!isValidId(prdId)) throw new Error('forge-prd amend: ticket ' + ticketId + ' has no valid prd_id');
  // Verify Boss residual: the prd_id names the lock, the md path and the history line, so a
  // credential-shaped one (possible in a hand-edited ticket file; the store redacts on write) is refused here,
  // before the lock and before logging, and is never echoed in the message.
  if (redactText(prdId) !== prdId) throw new Error('forge-prd amend: ticket ' + ticketId + ' has a credential-shaped prd_id — refusing (nothing written)');

  const hotspot = 'forge-prd-amend:' + prdId;
  const acq = lockGuard.acquire({ hotspot, runId, owner: 'forge-prd-amend-' + process.pid }, { dir: lockDir });
  if (!acq.ok) {
    const waitS = acq.conflict ? Math.ceil(acq.conflict.remaining_ms / 1000) : null;
    throw new Error('forge-prd amend: PRD ' + prdId + ' is locked by another amend in progress' + (waitS != null ? ' (retry in ~' + waitS + 's)' : '') + ' — nothing written, try again');
  }
  // W2-08b: right before EACH write (ticket, meta, md, history), re-confirm
  // this run STILL owns the lock. lockGuard.refresh() is the CAS-based ownership check (forge-lock-guard.cjs):
  // it fails when the lock file is gone, expired, or now carries a DIFFERENT token — exactly what "a
  // different holder took the hotspot over between logging and writing" looks like. Without this, an expired
  // holder could keep writing after a takeover purely because its in-memory `acq` reference still looked
  // valid to IT.
  const assertLockHeld = () => {
    const r = lockGuard.refresh({ hotspot, runId, token: acq.token }, { dir: lockDir });
    if (!r.ok) throw new Error('forge-prd amend: lock lost before write (' + r.reason + ') — aborting, nothing written');
  };
  try {
    // ---- authoritative re-read, now holding the PRD lock ----
    let ticket;
    try { ticket = JSON.parse(fs.readFileSync(ticketFile, 'utf8')); }
    catch (e) { throw new Error('forge-prd amend: ticket ' + ticketId + ' ' + jsonFailure(e)); }

    const metaFile = containedEntityFile(prdDir, prdId, '.meta.json');
    if (!metaFile || !fs.existsSync(metaFile)) throw new Error('forge-prd amend: PRD not found: ' + prdId);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); }
    catch (e) { throw new Error('forge-prd amend: PRD meta ' + prdId + ' ' + jsonFailure(e)); }
    const mdFile = path.join(prdDir, prdId + '.md');

    // ---- sanitise every free-text field the SAME way, once ----
    // Redact THEN cap (same discipline as capQuestion()/W1-N04 above) — a secret must never survive a cut
    // at the 500-char boundary as an unredacted fragment.
    const gapText = capGapText(sanitizeGapField(rawGap));
    const sanitizedFoundBy = sanitizeGapField(foundBy);
    const sanitizedTests = resolvedTests.map(sanitizeGapField);

    // ---- idempotent id allocation / repair (W2-07c/d; ticket_id now part of the match, W2-N01) ----
    const ticketMatch = findMatchingGapEntry(ticket.spec_gaps, ticketId, gapText, sanitizedFoundBy, sanitizedTests);
    const metaMatch = findMatchingGapEntry(meta.spec_gaps, ticketId, gapText, sanitizedFoundBy, sanitizedTests);
    let entry;
    if (ticketMatch) entry = ticketMatch;
    else if (metaMatch) entry = metaMatch;
    else {
      // W2-07b: scan EVERY ticket of this PRD (not just meta.spec_gaps + this one ticket's own spec_gaps) —
      // see maxGapNumberAcrossTickets() above for why that matters after a partial (meta-write) failure.
      const n = Math.max(maxGapNumber(meta.spec_gaps), maxGapNumberAcrossTickets(ticketsDir, prdId)) + 1;
      entry = { id: 'gap-' + n, ticket_id: ticketId, gap: gapText, found_by: sanitizedFoundBy, tests: sanitizedTests, run_id: runId, at: new Date().toISOString() };
    }
    const gapId = entry.id;
    // Verify Boss F4: when the ticket AND the PRD meta already hold this exact entry, an earlier call
    // fully succeeded — this re-run records nothing new, so it logs no second event and appends no second
    // history line (the md is still re-rendered below as a harmless repair).
    const alreadyRecorded = !!(ticketMatch && metaMatch);

    // EVENT FIRST: a change that cannot be logged is not made. `entry` is already fully sanitised, so the
    // logged payload can never carry a raw credential the ticket/meta/md/history would otherwise mask.
    if (!alreadyRecorded) {
      const logResult = log(runId, 'ticket_updated', { agent: 'orchestrator', ticket_id: ticketId, prd_id: prdId, note: 'Spec gap found in review', spec_gap: entry });
      if (!logResult || logResult.status !== 0) {
        const detail = (logResult && logResult.stderr && String(logResult.stderr).trim()) || (logResult && logResult.error && (logResult.error.message || String(logResult.error))) || 'no result';
        throw new Error('forge-prd amend: logging ticket_updated failed (' + detail + ') — aborting, nothing written');
      }
    }

    // ---- compute ALL new file contents before writing any of them (W2-07b) ----
    const ticketNeedsWrite = !ticketMatch;
    const metaNeedsWrite = !metaMatch;
    const updatedTicket = ticketNeedsWrite
      ? redactValue(Object.assign({}, ticket, { spec_gaps: Array.isArray(ticket.spec_gaps) ? ticket.spec_gaps.concat([entry]) : [entry] }))
      : null;
    const finalMeta = metaNeedsWrite
      ? redactValue(Object.assign({}, meta, { spec_gaps: Array.isArray(meta.spec_gaps) ? meta.spec_gaps.concat([entry]) : [entry] }))
      : meta;
    // W2-07a: the md is ALWAYS re-rendered from the FINAL meta and ALWAYS
    // written on every successful amend — including a pure repair/no-op retry where NEITHER the ticket nor
    // the meta needed a new entry. Without this, a PRIOR call that wrote meta successfully but then failed
    // on the md write alone would leave a permanently stale md: a later "nothing to do" retry (ticket and
    // meta both already match) would otherwise never touch the md again.
    const mdContent = renderPrd(finalMeta);

    // ---- writes (only reached once the event above was logged); each is atomic (W2-07a); a file whose
    // JSON content already matches (idempotent repair, W2-07d) is skipped rather than rewritten; the md is
    // unconditional (see above). W2-08b: re-confirm lock ownership immediately before EACH write. ----
    if (ticketNeedsWrite) {
      assertLockHeld();
      fs.mkdirSync(ticketsDir, { recursive: true });
      writeFile(ticketFile, JSON.stringify(updatedTicket, null, 2) + '\n');
    }
    if (metaNeedsWrite) {
      assertLockHeld();
      fs.mkdirSync(prdDir, { recursive: true });
      writeFile(metaFile, JSON.stringify(finalMeta, null, 2) + '\n');
    }
    assertLockHeld();
    fs.mkdirSync(prdDir, { recursive: true });
    writeFile(mdFile, mdContent);

    // Codex stop-time review: whether the history line is still missing is decided by the history
    // file itself, not by alreadyRecorded — a call that wrote ticket and meta but failed on the md write
    // never reached this line, so its recovery retry must still append it (exactly once). Gap ids are unique
    // per PRD, so this marker identifies the line.
    const historyMarker = '- Spec gap ' + escapeGapInline(gapId) + ' on ' + escapeGapInline(ticketId) + ' (' + escapeGapInline(prdId) + '):';
    let historyHasLine = false;
    if (!noHistory && alreadyRecorded) {
      try { historyHasLine = fs.readFileSync(historyPath, 'utf8').includes(historyMarker); } catch { historyHasLine = false; }
    }
    let historyAppended = false;
    if (!noHistory && !historyHasLine) {
      const line = historyMarker + ' ' + escapeGapInline(entry.gap) +
        ' — found by ' + escapeGapInline(entry.found_by) + '; regression test(s): ' + entry.tests.map(escapeGapInline).join(', ') +
        ' (run ' + escapeGapInline(entry.run_id) + ')\n';
      assertLockHeld();
      fs.appendFileSync(historyPath, line, 'utf8');
      historyAppended = true;
    }

    return { ok: true, ticketId, prdId, gapId, ticketFile, metaFile, mdFile, historyPath: noHistory ? null : historyPath, historyAppended, alreadyRecorded };
  } finally {
    lockGuard.release({ hotspot, runId, token: acq.token }, { dir: lockDir });
  }
}

module.exports = { renderPrd, writePrd, criteriaToTickets, openClarifications, amendTicket };

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (cmd === 'render') {
      const json = argv[1];
      if (!json) { console.error("Usage: node forge-prd.cjs render '<prd-json>'"); process.exitCode = 1; return; }
      let prd;
      try { prd = JSON.parse(json); } catch (e) { console.error('forge-prd: the PRD argument ' + jsonFailure(e)); process.exitCode = 1; return; }
      console.log(renderPrd(prd));
      const open = openClarifications(prd);
      if (open.length) console.log('open clarifications: ' + open.length);
      return;
    }

    if (cmd === 'write') {
      const json = argv[1];
      if (!json) { console.error("Usage: node forge-prd.cjs write '<prd-json>' [--run <id>] [--tickets]"); process.exitCode = 1; return; }
      let prd;
      try { prd = JSON.parse(json); } catch (e) { console.error('forge-prd: the PRD argument ' + jsonFailure(e)); process.exitCode = 1; return; }

      let run = null, wantTickets = false;
      for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--run') run = argv[++i];
        else if (argv[i] === '--tickets') wantTickets = true;
      }

      let result;
      try { result = writePrd(prd); }
      catch (e) { console.error('forge-prd: write failed: ' + e.message); process.exitCode = 1; return; }

      let ticketIds = [];
      if (wantTickets) {
        try { ticketIds = criteriaToTickets(prd, { run_id: run }); }
        catch (e) { console.error('forge-prd: ticket creation failed: ' + e.message); }
      }

      if (run) {
        const g = logEvent(run, 'prd_generated', { agent: 'orchestrator', note: 'PRD generated: ' + (prd.title || result.prd_id), prd_id: result.prd_id });
        if (g.status !== 0) console.error('forge-prd: log-event (prd_generated) warning: ' + (g.stderr || '').trim());
        for (const tid of ticketIds) {
          const te = logEvent(run, 'ticket_created', { agent: 'orchestrator', note: 'Ticket created from acceptance criterion', ticket_id: tid, prd_id: result.prd_id });
          if (te.status !== 0) console.error('forge-prd: log-event (ticket_created) warning: ' + (te.stderr || '').trim());
        }
      }

      console.log('PRD written: ' + result.prd_id);
      console.log('  md:   ' + result.mdPath);
      console.log('  meta: ' + result.metaPath);
      console.log('  tickets created: ' + ticketIds.length + (ticketIds.length ? ' (' + ticketIds.join(', ') + ')' : ''));
      const open = openClarifications(prd);
      if (open.length) console.log('open clarifications: ' + open.length);
      return;
    }

    if (cmd === 'clarifications') {
      const id = argv[1];
      if (!id || !isValidId(id)) { console.error('forge-prd: invalid or missing prd_id'); process.exitCode = 1; return; }
      let dir;
      try { dir = resolveStoreDir('prd'); }
      catch (e) { console.error('forge-prd: ' + e.message); process.exitCode = 1; return; }
      const metaPath = path.join(dir, id + '.meta.json');
      if (!fs.existsSync(metaPath)) { console.error('forge-prd: not found: ' + id); process.exitCode = 1; return; }
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
      catch (e) { console.error('forge-prd: meta.json for ' + id + ' ' + jsonFailure(e)); process.exitCode = 1; return; }
      const open = openClarifications(meta);
      for (const m of open) console.log(m.section + (m.id ? '/' + m.id : '') + ': ' + m.question);
      process.exitCode = open.length ? 3 : 0;
      return;
    }

    if (cmd === 'amend') {
      const ticketId = argv[1];
      let gap = null, foundBy = null, runId = null, noHistory = false;
      const tests = [];
      for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--gap') gap = argv[++i];
        else if (a === '--found-by') foundBy = argv[++i];
        else if (a === '--test') tests.push(argv[++i]);
        else if (a === '--run') runId = argv[++i];
        else if (a === '--no-history') noHistory = true;
      }
      let result;
      try { result = amendTicket({ ticketId, gap, foundBy, tests, runId, noHistory }); }
      catch (e) { console.error('forge-prd: ' + e.message); process.exitCode = 1; return; }
      console.log('Spec gap ' + result.gapId + ' recorded on ' + result.ticketId + ' (' + result.prdId + ')' +
        (result.alreadyRecorded
          ? (result.historyAppended ? ' — already recorded earlier; the missing history line was restored' : ' — already recorded earlier, nothing new logged')
          : (result.historyAppended ? ' — FORGE_TASK_HISTORY.md updated' : ' — history skipped (--no-history)')));
      return;
    }

    console.error('Usage: node forge-prd.cjs <render|write|clarifications|amend> \'<prd-json>\'|<prd_id>|<ticket_id> [--run <id>] [--tickets] [--gap <text> --found-by <id> --test <path> [--no-history]]');
    process.exitCode = 1;
  };
  try { main(); } catch (e) { console.error('forge-prd: ' + e.message); process.exitCode = 1; }
}
