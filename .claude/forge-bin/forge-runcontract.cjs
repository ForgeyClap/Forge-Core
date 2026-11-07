#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract.cjs — run-contract checker (P1 / V9-build). THE mechanism that makes
 * config/orchestration/FORGE_HARD_RULES.json's non-negotiables "cannot be skipped" instead of merely
 * documented: given a REAL run (its events.jsonl content + the real files actually sitting in that run's
 * own directory), decides which hard rules are satisfied, which are genuinely missing, and which were
 * explicitly overridden by the owner — a PURE projection of what actually happened, never an assumption
 * or a trusted self-report. Zero-dependency (fs/path only; lazily requires two SIBLING forge-bin modules
 * for reuse, never re-implementing their logic — same single-source-of-truth discipline every sibling
 * *-gate tool in this project already follows).
 *
 * MODEL:
 *   check({ run_id, domain, complexity }, opts) -> { ok, run_id, domain, satisfied:[id,...], missing:[id,...],
 *                                          warnings:[id,...], overridden:[{id,reason,by,note},...],
 *                                          complexity, complexity_source, complexity_declared,
 *                                          complexity_derived, complexity_units,
 *                                          unevaluated:[{id,trigger,kind:'trigger'|'check-type',applicable,check_type?,reason}] }
 *     run_id  — required. Resolves to <root>/.claude/forge-runs/<run_id>/events.jsonl by default.
 *     domain  — optional real domain slug (e.g. "website", "finance") — decides which trigger:"web" /
 *               trigger:"correctness-critical" / trigger:"domain:<x>" rules even APPLY to this run, and
 *               (for an event-present check with domain_aware:true) unlocks the stronger domain-specific
 *               required-evidence.json proof via forge-verify.cjs::evidenceCheck() (reused, never
 *               re-implemented).
 *     complexity — optional fan-out level ("L1".."L4"). See COMPLEXITY below; it can only RAISE the level
 *               the run's own run.json/events already establish, never lower it.
 *
 * COMPLEXITY (OWNER-PUNT B / richting 2, "the rule must discriminate"):
 *   The measured problem: FORGE_HARD_RULES.json's plan-or-prd-present is an event-present rule whose key is
 *   ["prd_generated","mission_blueprint_created","agent_work_package_created"], and hasEvent() is OR — so the
 *   router's own standing instruction ("every Lead logs an agent_work_package_created per dispatched
 *   subagent") satisfied it on EVERY run via the cheapest of the three. Counted over the 30 real runs in
 *   .claude/forge-runs on 2026-08-03: agent_work_package_created 12 events, prd_generated 2. A rule every run
 *   satisfies by construction discriminates nothing, so the expensive alternative was never chosen.
 *   The fix needs "heavy work owes a real PRD, light work does not" to be EXPRESSIBLE, which it was not: the
 *   trigger vocabulary knew only always|web|correctness-critical|domain:<x>, and no L-level ever reached the
 *   ctx. Hence (a) a new trigger form `complexity:>=L<1-4>`, and (b) a real resolver:
 *     - DECLARED — read from the run's own run.json (fields `complexity`/`fanout`/`fan_out`/`level`).
 *       Measured: run.json really does carry this ("complexity" in 10 runs, "fanout" in 5) and NO event type
 *       carries it — but 12 of 30 runs have no run.json at all, so declared is often simply absent.
 *     - DERIVED — measured from real dispatch volume (countUnits/levelFromUnits) using CLAUDE.md's own
 *       fan-out bands. A derived level is an INFERENCE, not a declaration, and is always reported as such:
 *       complexity_source says which half produced the verdict, and complexity_declared/complexity_derived/
 *       complexity_units are all reported separately so it can never be passed off as a declared level.
 *     - Reconciled by MAX (declared/derived/param), because run.json is a SELF-REPORT: a Lead must not be
 *       able to write "complexity":"L1" and dodge a heavy-work rule while really dispatching twenty agents.
 *       Lowering is possible only through the attributed owner_override route, which leaves a reason on the
 *       record. Any rule scoped by complexity therefore stays overridable — a block on an inference must
 *       always have a usable, recorded escape hatch.
 *
 * UNKNOWN TRIGGERS (same date): forge-sync.cjs ships this file and FORGE_HARD_RULES.json to 12 projects as
 *   SEPARATE files, so one half can lag the other. Previously ANY unrecognized trigger threw, turning a
 *   version skew into a hard crash. Now a structurally BROKEN trigger still throws (malformed config), while
 *   a well-formed but UNKNOWN one is skipped and reported in `unevaluated` — never counted as satisfied and
 *   never counted as missing, because it was genuinely never judged. This helps only from this version
 *   forward: a copy of forge-runcontract.cjs older than 2026-08-03 still crashes on "complexity:>=L3".
 * UNKNOWN CHECK TYPES (S6): the same degrade for a well-formed but unknown `check.type` — reported
 *   in `unevaluated` (kind 'check-type', with `applicable`), a blocking applicable one as `unknown-rule:<id>` in
 *   `missing`; never a crash, never a silent pass. A copy older than 2026-10-09 still throws on it, so this
 *   checker must reach every fleet copy BEFORE any rules file that uses a new check type.
 * V2 (part A): FORGE_HARD_RULES.json version 2 is
 *   the ONE rules registry. Four new check types (closure, sequence, reaction, file-touched — see the "V2 CHECK
 *   TYPES" block), and two new optional rule fields: `phase` (preview|wp|complete; check({phase}) / --phase
 *   judges only the rules due by then, the rest is `phase_deferred`) and `since` (an ISO date; a run that
 *   started before it is `historical_exempt` for that rule, never retroactively red). A phase-less check of a
 *   rules file without `since` behaves exactly as before. The registry's other V2 sections (lifecycle,
 *   completion_sequence, steps, orchestration enforcement labels) are DATA for docs/CLIs and are not read here.
 * I.6 (Forge Intelligence): a trigger form "run-shape:<plan-scale|plan-card|visible-deliverable|serial-plan>"
 *   (the rule applies only when the run ITSELF declares that shape in its run.json / plan-card.json / anticipate.json —
 *   opt-in, so older runs are judged exactly as before) and a check type "run-evidence" (plan card, anticipation overlay,
 *   recorded craft review, a named reason for a serial plan). Every result carries `run_shape` and `exceptions` (rules met
 *   by a recorded decision_logged exception — reported, never a silent pass). See the "RUN SHAPE + RUN EVIDENCE" block.
 * A2: run-evidence kind "dispatch-harness" (rule dispatch-harness-match, warn, complexity >= L2): the run's
 *   dispatch events joined to harness-written records by forge-harness-match.cjs; rule_details carry a `harness` summary.
 *   A13: when the project has no SubagentStart hook running forge-subagent-start.cjs (settings.json /
 *   settings.local.json) and the harness recorded nothing start-side for the run, the rule is a visible warning
 *   "harness hooks not installed" instead of counting every dispatch as unmatched (harnessHooksInstalled).
 *     params.phase     — optional 'preview'|'wp'|'complete' (default 'complete' = every rule).
 *     opts.root        — project root (default: two levels up from forge-bin, i.e. this project).
 *     opts.runDir       — override the run directory directly (test hermeticity).
 *     opts.eventsPath   — override the events.jsonl path directly (test hermeticity) — the run directory
 *                          used for the real-artifact-file scan is derived as this path's dirname.
 *     opts.rulesPath    — override config/orchestration/FORGE_HARD_RULES.json (test hermeticity).
 *     opts.ownerProfilePath — override FORGE_OWNER_PROFILE.json's path (test hermeticity).
 *
 *   Every rule in FORGE_HARD_RULES.json that APPLIES to this run (see ruleApplies()) is evaluated:
 *     - satisfied  -> its check genuinely matched real events.jsonl content or a real run-directory file
 *                      (an artifact-present check additionally requires the matched file to be genuinely
 *                      non-empty — see listRunArtifacts()/hasArtifact() — a 0-byte placeholder never counts).
 *     - missing    -> severity:"block", unsatisfied, and NO valid owner override was found — this is what
 *                      makes the whole contract `ok:false` ("NOT DONE").
 *     - warnings   -> severity:"warn", unsatisfied — reported, never affects `ok`.
 *     - overridden -> unsatisfied, rule.cannot_override is not true, AND a genuine STRUCTURED owner_override
 *                      event was found in the run's own events.jsonl (see findOwnerOverride() below) —
 *                      reported with the real reason/by as proof, never silently dropped, and never counts
 *                      toward `missing` regardless of severity.
 *   SECURITY (V9-fix, break-swarm DEFECT 2/3): an override is recognized ONLY from an explicit,
 *   structured, attributed, affirmative owner act — never a free-text substring. The old "agent_note whose
 *   note contains override:<ruleId>" convention is RETIRED: agent_note is a freely-loggable event any
 *   dispatched subagent can emit, so a substring match let the very agents these rules police clear their own
 *   rules (a forged run of nothing but such notes returned ok:true). The ONLY thing that can override a rule
 *   now is a real event shaped EXACTLY like:
 *     { event_type:'owner_override', rule:'<exact-rule-id>', reason:'<non-empty, non-bare-token reason>', by:'<owner id>' }
 *   — `rule` must EXACT-match the rule id (no substring/prefix/negation matching of any kind: an
 *   "override:research-done-later"-style mention can never clear "research-done", and a negating mention like
 *   "did NOT use override:dispatch-logged" is never even read as an override candidate — it is not the
 *   required event_type/shape at all); `reason` must be non-blank AND more than just the bare rule id/token
 *   repeated (see isMeaningfulReason()); `by` must match a configured owner id (see loadOwnerAllowlist() —
 *   read from FORGE_HARD_RULES.json's own `owners_allowlist` array and/or FORGE_OWNER_PROFILE.json), failing
 *   CLOSED to "no override possible" when neither configures any id (an empty/missing allow-list can never be
 *   treated as "anyone is the owner"). A rule flagged `cannot_override:true` in FORGE_HARD_RULES.json (the
 *   honesty-core subset: memory-read, dispatch-logged, evidence-satisfied, verify-checked, report-present)
 *   can NEVER be cleared this way, full stop — not even by a validly-attributed owner_override event; check()
 *   does not even look for one on those rules.
 *   A rule whose trigger does not apply to this run (domain) is skipped entirely — it appears in none of
 *   the four buckets, exactly like forge-orchestrate.cjs's audit() only reports on steps it can actually
 *   judge from real content.
 *
 * CLI:
 *   node forge-runcontract.cjs check --run <id> [--domain <d>] [--phase preview|wp|complete] [--root <projectRoot>] [--json]
 *   node forge-runcontract.cjs plan --run <id> [--json]   (read-only: next unmet obligations + the completion
 *     sequence with done/pending per step and the exact command; exit 0 when a plan was computed, 2 on usage/config
 *     error — see the COMPLETION RECIPE block near the end of this file)
 * Exit codes: 0 = contract satisfied (every applicable block-rule met or overridden) · 3 = NOT DONE (at
 *   least one applicable block-rule missing — mirrors forge-actiongate's gate=3 / forge-evidence's not-ok=3
 *   convention) · 2 = usage/config error (bad/missing rules file, bad run_id, unreadable events file).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RULES_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');

// WP 2.1 state paths: forge-paths.cjs decides the layout (the opt-in .forge/ folder, else the legacy .claude/forge-*
// folders exactly as before). Guarded: a missing or older forge-paths.cjs keeps the legacy paths and never crashes.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function statePath(root, key, read) {
  const legacy = path.join(root, '.claude', 'forge-' + key);
  if (!forgePaths) return legacy;
  try { return forgePaths.layout(root) !== 'forge' ? legacy : (read ? forgePaths.resolveExisting(root, key) : forgePaths.stateDir(root, key)); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return legacy; }
}
/** runDirOf(root, id) -> the run's folder: the active runs folder, or the legacy one when the run only exists there
 *  (one run never spans two folders; in the legacy layout always <root>/.claude/forge-runs/<id>). */
function runDirOf(root, id) {
  const active = path.join(statePath(root, 'runs'), id), legacy = path.join(root, '.claude', 'forge-runs', id);
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}
/** appliesPathExists(root, rel) -> true when a rule's `applies_if_exists` path exists in this project (WP 2.1). The
 *  registry names legacy state paths (".claude/forge-scribe/ledger.jsonl"); in the forge layout the same file lives
 *  under the state folder of that key (.forge/scribe/ledger.jsonl), so a legacy .claude/forge-<key>/... path is
 *  ALSO looked up there - otherwise opting in would silently switch a rule off. Legacy layout: the plain check. */
function appliesPathExists(root, rel) {
  if (fs.existsSync(path.join(root, rel))) return true;
  const m = /^\.claude[\\/]forge-([a-z][a-z0-9_]*)(?:[\\/](.*))?$/.exec(String(rel));
  if (!m) return false;
  let dir;
  try { dir = statePath(root, m[1], true); } catch { return false; } // not a canon key / unjudgeable layout
  return dir !== path.join(root, '.claude', 'forge-' + m[1]) && fs.existsSync(m[2] ? path.join(dir, m[2]) : dir);
}
/** relPosix(root, p) -> p relative to root with forward slashes (the form evidence strings and messages use). */
function relPosix(root, p) { return path.relative(root, p).split(path.sep).join('/'); }
/** runFolderLabel(ctx) -> the run folder as an owner reads it: project-relative when it lies inside the root (legacy:
 *  exactly .claude/forge-runs/<id> as before; forge layout: .forge/runs/<id>), else the old literal. */
function runFolderLabel(ctx) {
  try {
    const rp = ctx && ctx.root && ctx.runDir ? relPosix(ctx.root, ctx.runDir) : '';
    if (rp && !rp.startsWith('..') && !path.isAbsolute(rp)) return rp;
  } catch { /* the literal below */ }
  return '.claude/forge-runs/' + (ctx && ctx.runId);
}
// this copy's project (forge-paths scriptRoot); null for a plugin copy outside any project -> pass --root
const DEFAULT_ROOT = forgePaths ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..');
/** rootOf(opts) -> opts.root (resolved) or DEFAULT_ROOT; a clear error instead of a crash when neither exists. */
function rootOf(opts) {
  if (opts && opts.root) return path.resolve(opts.root);
  if (!DEFAULT_ROOT) throw new Error('forge-runcontract: no project root found (no .claude, .forge or .git above the current folder; pass --root)');
  return DEFAULT_ROOT;
}

const KNOWN_TRIGGER_LITERALS = new Set(['always', 'web', 'correctness-critical']);
// V2 (part A): closure / sequence / reaction / file-touched — see the "V2 CHECK TYPES" block
// further down for their exact semantics. A rules file using them must reach a fleet copy only AFTER this
// checker does (an older checker degrades them to `unevaluated`, S6 — never a crash).
const V2_CHECK_TYPES = new Set(['closure', 'sequence', 'reaction', 'file-touched']);
// I.6 (Forge Intelligence): the run-evidence check type and the run-shape trigger form — see the "RUN SHAPE"
// block further down. Kept out of V2_CHECK_TYPES on purpose: that set names the four version-2 types exactly.
const RUN_EVIDENCE_TYPE = 'run-evidence';
const KNOWN_CHECK_TYPES = new Set(['event-present', 'artifact-present', 'doctor-check', 'independent-verification', ...V2_CHECK_TYPES, RUN_EVIDENCE_TYPE]);
const KNOWN_SEVERITIES = new Set(['block', 'warn']);
// Rule PHASE: when an obligation is due. A check at phase X judges every rule whose phase rank is <= X;
// later-phase rules are reported in `phase_deferred`, never as missing. A rule without a phase is 'complete'
// (so a plain, phase-less check judges every rule — the pre-V2 behaviour, unchanged).
const KNOWN_PHASES = ['preview', 'wp', 'complete'];
const PHASE_RANK = { preview: 0, wp: 1, complete: 2 };
const DEFAULT_PHASE = 'complete';
// Rule SINCE: an ISO date (or date-time). The rule only applies to runs that STARTED on/after it; an
// older run is `historical_exempt` for that rule — judged by the rules of its own time, never retroactively red.
const SINCE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const WEB_DOMAINS = new Set(['web', 'website']);
const CRITICAL_DOMAINS_FALLBACK = ['finance', 'parser', 'ocr', 'data', 'prediction']; // used only if forge-fixtures.cjs can't be loaded

// ---- complexity trigger vocabulary (OWNER-PUNT B / richting 2) -------------------------------
// COMPLEXITY_TRIGGER_RE is the ONE place the new trigger form is defined: "complexity:>=L<n>", n in 1..4.
// Only the >= comparison exists — that is the whole shape of the need ("heavy work owes more"), and inventing
// <=/== operators nobody asked for would be vocabulary this file has to keep honouring forever.
const COMPLEXITY_TRIGGER_RE = /^complexity:>=L([1-4])$/;
const LEVEL_RE = /^L([1-4])$/i;
// I.6: "run-shape:<shape>" — the rule applies only when the run ITSELF declares that shape (its run.json, plan-card.json or
// anticipate.json; see readRunShape). A well-formed shape this checker does not know degrades like any unknown trigger.
const RUN_SHAPE_TRIGGER_RE = /^run-shape:([a-z][a-z0-9-]*)$/;
// S3b: web-ui-deliverable is a narrower view of visible-deliverable (the declared types include web-ui, so
// the web-ui craft lens is in the run's review plan) — same declaration source, no new detector.
const RUN_SHAPES = new Set(['plan-scale', 'plan-card', 'visible-deliverable', 'serial-plan', 'web-ui-deliverable']);
// TRIGGER_SHAPE_RE separates "structurally broken config" from "vocabulary this checker predates". A bare
// token (`always`) or a namespaced token with a NON-EMPTY payload (`domain:finance`, `complexity:>=L3`,
// `phase:beta`) is structurally well-formed; anything else (missing, non-string, blank, `domain:` with no
// payload) is a genuinely malformed rules file and still throws — see loadRules() below.
const TRIGGER_SHAPE_RE = /^[a-z][a-z0-9-]*(?::\S+)?$/i;
// CHECK_TYPE_SHAPE_RE (S6) is the same seam for
// check.type: a bare kebab token (`closure`, `file-touched`) is vocabulary this checker may PREDATE and is
// degraded honestly (see loadRulesMeta); anything else (missing, non-string, blank, spaces, punctuation) is a
// genuinely malformed rules file and still throws.
const CHECK_TYPE_SHAPE_RE = /^[a-z][a-z0-9-]*$/i;

/** parseLevel(v) -> 'L1'..'L4' | null — tolerant of case and surrounding whitespace, never throws. */
function parseLevel(v) {
  if (typeof v !== 'string') return null;
  const m = LEVEL_RE.exec(v.trim());
  return m ? 'L' + m[1] : null;
}
function levelNum(level) {
  const parsed = parseLevel(level);
  return parsed ? Number(parsed.slice(1)) : 0;
}
function maxLevel(a, b) {
  return levelNum(a) >= levelNum(b) ? (parseLevel(a) || parseLevel(b)) : (parseLevel(b) || parseLevel(a));
}

// ---- rules config (single source of truth: FORGE_HARD_RULES.json) --------------------------------------
let _rulesCache = null; // { path, sha256, data, unknownTriggers, unknownCheckTypes } — cached per-path in the SAME process; tests override via opts.rulesPath
/** isValidTrigger(t) -> boolean — true only for vocabulary THIS checker can actually evaluate. */
function isValidTrigger(t) {
  if (typeof t !== 'string') return false;
  if (KNOWN_TRIGGER_LITERALS.has(t)) return true;
  if (t.startsWith('domain:') && t.length > 'domain:'.length) return true;
  const rs = RUN_SHAPE_TRIGGER_RE.exec(t);
  if (rs) return RUN_SHAPES.has(rs[1]);
  return COMPLEXITY_TRIGGER_RE.test(t);
}
/** isWellFormedTrigger(t) -> boolean — true when `t` is at least SHAPED like a trigger, even if this
 *  checker does not know the vocabulary (see TRIGGER_SHAPE_RE). This is the seam that turns a fleet version
 *  skew into an honest degrade instead of a crash. */
function isWellFormedTrigger(t) {
  return typeof t === 'string' && TRIGGER_SHAPE_RE.test(t.trim()) && t.trim() === t;
}
/** isWellFormedCheckType(t) -> boolean — true when `t` is SHAPED like a check type, known or not (S6). */
function isWellFormedCheckType(t) {
  return typeof t === 'string' && CHECK_TYPE_SHAPE_RE.test(t);
}

/** loadRulesMeta(rulesPath) -> { data, sha256, unknownTriggers:[{id,trigger}], unknownCheckTypes:[{id,check_type}] }
 *  — the full parse result, including the rules this checker cannot judge because their trigger vocabulary
 *  or check type is newer than this file.
 *
 *  WHY: forge-sync.cjs ships config/orchestration/FORGE_HARD_RULES.json and
 *  forge-bin/forge-runcontract.cjs to 12 projects as SEPARATE files, so one half can lag the other. Before
 *  this change, ANY trigger this file did not recognize threw — meaning a project that received the newer
 *  rules file but not the newer checker would hard-crash every run-contract evaluation instead of degrading.
 *  Now: a structurally BROKEN trigger (missing/non-string/blank/`domain:` with no payload) is still a
 *  malformed config and still throws; a structurally well-formed but UNKNOWN one is collected here, skipped
 *  by check(), and reported in result.unevaluated so it is loudly visible rather than silently passing.
 *  This helps only from THIS version of the file forward — a copy of forge-runcontract.cjs older than
 *  2026-08-03 still throws on "complexity:>=L3"; the fleet fix is to sync the pair together.
 *
 *  S6 (audit-enforcement-core.txt, critical):
 *  the SAME skew existed one field over. An unknown `check.type` still THREW, so a rules file carrying a
 *  check type newer than this checker (the planned closure/sequence/reaction/file-touched) would make every
 *  contract evaluation on a lagging fleet copy exit 2 and every finalize refuse. Now a well-formed but
 *  UNKNOWN check type is collected in `unknownCheckTypes`, its key/keyless validation is skipped (this
 *  checker cannot know which shape the newer type needs), and check() reports the rule in `unevaluated`
 *  — and a BLOCKING one that applies to the run as `unknown-rule:<id>` in `missing`, so it can never read
 *  as satisfied. This is the permanent forward-compat behaviour: an entry this checker cannot judge is
 *  REPORTED, never a crash and never a silent pass. A missing/non-string/blank/oddly-shaped check.type is
 *  still a malformed config and still throws. Same limitation as above: it protects only from this
 *  version of the checker forward, so this checker must reach every fleet copy BEFORE a rules file with a
 *  new check type does. */
function loadRulesMeta(rulesPath) {
  const p = rulesPath || RULES_PATH;

  const raw = fs.readFileSync(p, 'utf8');
  /** de hash hoort bij de EXACT gelezen bytes van dit proces — zie het resultaatveld
   *  `ruleset_sha256_used` waarmee finalize het A→B→A-venster rond de contractcheck sluit. */
  const rawSha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  /** the cache used to be keyed by PATH only and returned before reading the file, so in
   *  one process an edited rules file at the same path kept being judged under the OLD rules — and
   *  `ruleset_sha256_used` reported the old hash for bytes no longer on disk. Masked until now because
   *  finalize detected rules edits with its own fresh read; forge-finalize's ruleset-superseded path now
   *  re-runs the contract in-process under the CURRENT rules and reports that outcome, so a stale cache
   *  would report the old rules as "current". Keyed by path AND content hash: re-parsing happens only when
   *  the bytes really changed; reading them is the price of never serving stale rules. */
  if (_rulesCache && _rulesCache.path === p && _rulesCache.sha256 === rawSha) return _rulesCache;
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-runcontract: ' + p + ' is not valid JSON: ' + e.message); }

  if (!data || !Array.isArray(data.rules) || data.rules.length === 0) {
    throw new Error('forge-runcontract: ' + p + ' is missing a non-empty "rules" array');
  }

  const unknownTriggers = [];
  const unknownCheckTypes = [];
  const seenIds = new Set();
  for (const r of data.rules) {
    if (!r || typeof r !== 'object') throw new Error('forge-runcontract: a rule entry in ' + p + ' is not an object: ' + JSON.stringify(r));
    if (!r.id || typeof r.id !== 'string') throw new Error('forge-runcontract: a rule entry in ' + p + ' is missing a string "id": ' + JSON.stringify(r));
    if (seenIds.has(r.id)) throw new Error('forge-runcontract: duplicate rule id "' + r.id + '" in ' + p);
    seenIds.add(r.id);
    if (!r.rule || typeof r.rule !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "rule" in ' + p);
    if (!isValidTrigger(r.trigger)) {
      if (!isWellFormedTrigger(r.trigger)) {
        throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "trigger" in ' + p + ' (must be "always", "web", "correctness-critical", "domain:<x>", "complexity:>=L<1-4>" or "run-shape:<shape>")');
      }
      // well-formed but unknown vocabulary -> this rules file is newer than this checker. Degrade honestly.
      unknownTriggers.push({ id: r.id, trigger: r.trigger });
    }
    if (!r.check || typeof r.check !== 'object' || Array.isArray(r.check)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" is missing a "check" object in ' + p);
    }
    const checkTypeKnown = KNOWN_CHECK_TYPES.has(r.check.type);
    if (!checkTypeKnown) {
      if (!isWellFormedCheckType(r.check.type)) {
        throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid check.type ' + JSON.stringify(r.check.type) + ' in ' + p + ' (must be a kebab-case token; known to this checker: ' + Array.from(KNOWN_CHECK_TYPES).join(', ') + ')');
      }
      // S6: well-formed but unknown -> this rules file is newer than this checker. Degrade honestly.
      unknownCheckTypes.push({ id: r.id, check_type: r.check.type });
    }
    // KEYLOZE CHECKTYPES: een check die de HELE eventstroom beoordeelt i.p.v. op een
    // eventnaam te matchen heeft per definitie geen `key`. Ze staan expliciet in deze set — een
    // TYPFOUT in een key-gebaseerd type blijft dus gewoon een harde configfout.
    // S6: the key shape is only validated for check types this checker KNOWS — a newer type may legitimately
    // carry no key (sequence {before, after}) or a different one.
    const KEYLESS_CHECK_TYPES = new Set(['doctor-check', 'independent-verification']);
    if (!checkTypeKnown) {
      /* shape of an unknown check type is unknowable here — skipped on purpose, see S6 above */
    } else if (r.check.type === RUN_EVIDENCE_TYPE) {
      // I.6: keyless like the whole-stream checks; an unknown `evidence` value degrades like an unknown option (S6)
      const degraded = validateRunEvidenceCheck(r, p);
      if (degraded) unknownCheckTypes.push({ id: r.id, check_type: r.check.type, reason: degraded.reason });
    } else if (V2_CHECK_TYPES.has(r.check.type)) {
      // each new type carries its own shape (open/close/key, before/after, on/require, files) — a broken
      // shape throws like any malformed config; a well-formed but UNKNOWN option value (e.g. a future
      // reaction count) degrades exactly like an unknown check type (S6), with the reason kept.
      const degraded = validateV2Check(r, p);
      if (degraded) unknownCheckTypes.push({ id: r.id, check_type: r.check.type, reason: degraded.reason });
    } else if (!KEYLESS_CHECK_TYPES.has(r.check.type)) {
      if (r.check.key == null || !(typeof r.check.key === 'string' ? r.check.key.length > 0 : (Array.isArray(r.check.key) && r.check.key.length > 0))) {
        throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid/empty check.key in ' + p);
      }
    } else if (r.check.key != null) {
      throw new Error('forge-runcontract: rule "' + r.id + '" is a keyless check type (' + r.check.type + ') but carries a check.key in ' + p + ' — remove it so the rule cannot silently look key-driven');
    }
    /** F-07 (high, GEMETEN op de echte productieconfig): de belofte staat in
     *  VRIJE TEKST (`override: "UN-OVERRIDABLE — ..."`) maar de handhaving hangt aan een BOOLEAN
     *  (`cannot_override`, zie de override-lookup verderop). Niets verbond die twee, dus de regel die
     *  zelf-goedkeuring verbiedt was zélf wegdrukbaar met een geldige owner_override — gereproduceerd:
     *  hij verscheen gewoon in `overridden`. Een belofte die niet afdwingbaar is, is erger dan geen
     *  belofte: hij wekt vertrouwen dat de code niet waarmaakt. Daarom is de tekst nu bindend. */
    if (/UN-?OVERRIDABLE/i.test(String(r.override || '')) && r.cannot_override !== true) {
      throw new Error('forge-runcontract: rule "' + r.id + '" declares UN-OVERRIDABLE in its override text but does not carry cannot_override:true in ' + p + ' — the promise is enforced by the boolean, not by prose, so without it a valid owner_override silently clears this rule');
    }
    if (!KNOWN_SEVERITIES.has(r.severity)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "severity" in ' + p + ' (must be "block" or "warn")');
    }
    if (!r.override || typeof r.override !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "override" in ' + p);
    if (!r.source || typeof r.source !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "source" in ' + p);
    if (r.cannot_override !== undefined && typeof r.cannot_override !== 'boolean') {
      throw new Error('forge-runcontract: rule "' + r.id + '" has a non-boolean "cannot_override" in ' + p);
    }
    // `phase` is a kebab token (a well-formed but unknown phase is judged like 'complete' — see
    // phaseRankOf); `since` must be a real ISO date. Both are optional; absent means the pre-V2 behaviour.
    if (r.phase !== undefined && !(typeof r.phase === 'string' && CHECK_TYPE_SHAPE_RE.test(r.phase))) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "phase" ' + JSON.stringify(r.phase) + ' in ' + p + ' (known: ' + KNOWN_PHASES.join('|') + ')');
    }
    if (r.since !== undefined && sinceMs(r.since) === null) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "since" ' + JSON.stringify(r.since) + ' in ' + p + ' (must be an ISO date such as "2026-10-09")');
    }
    // optional project-relative path; the rule applies only while that path exists under the run's root
    if (r.applies_if_exists !== undefined && !isSafeRelPath(r.applies_if_exists)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "applies_if_exists" ' + JSON.stringify(r.applies_if_exists) + ' in ' + p + ' (must be a project-relative path without "..", e.g. ".claude/forge-scribe/ledger.jsonl")');
    }
    // I.6: optional owner-facing failure text (both languages) and the one next command; an older checker ignores both
    if (r.message !== undefined && !(r.message && typeof r.message === 'object' && !Array.isArray(r.message)
      && typeof r.message.en === 'string' && r.message.en.trim() && typeof r.message.nl === 'string' && r.message.nl.trim())) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "message" in ' + p + ' (must be {"en": "<text>", "nl": "<tekst>"}, both non-empty)');
    }
    if (r.next_step !== undefined && !(typeof r.next_step === 'string' && r.next_step.trim())) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "next_step" in ' + p + ' (must be a non-empty string: the one command to run next)');
    }
  }
  if (data.owners_allowlist !== undefined && !Array.isArray(data.owners_allowlist)) {
    throw new Error('forge-runcontract: ' + p + ' has a non-array "owners_allowlist"');
  }

  _rulesCache = { path: p, sha256: rawSha, data, unknownTriggers, unknownCheckTypes };
  return _rulesCache;
}

/** loadRules(rulesPath) -> the parsed rules data (unchanged signature — every pre-existing caller keeps
 *  working; loadRulesMeta() above is the richer form check() uses). */
function loadRules(rulesPath) {
  return loadRulesMeta(rulesPath).data;
}

/** listRules(opts) -> the raw rule entries, straight from FORGE_HARD_RULES.json (see file header). */
function listRules(opts) {
  return loadRules((opts || {}).rulesPath).rules;
}

// ---- lazy sibling reuse (never re-implemented) ----------------------------------------------------------
let _fixturesCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadFixturesTool() {
  if (_fixturesCache !== undefined) return _fixturesCache;
  try { _fixturesCache = require('./forge-fixtures.cjs'); } catch { _fixturesCache = null; }
  return _fixturesCache;
}
function criticalDomains() {
  const tool = loadFixturesTool();
  return (tool && Array.isArray(tool.CRITICAL_DOMAINS) && tool.CRITICAL_DOMAINS.length) ? tool.CRITICAL_DOMAINS : CRITICAL_DOMAINS_FALLBACK;
}

let _verifyCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadVerifyTool() {
  if (_verifyCache !== undefined) return _verifyCache;
  try { _verifyCache = require('./forge-verify.cjs'); } catch { _verifyCache = null; }
  return _verifyCache;
}

let _manifestCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadManifestTool() {
  if (_manifestCache !== undefined) return _manifestCache;
  try { _manifestCache = require('./forge-manifest.cjs'); } catch { _manifestCache = null; }
  return _manifestCache;
}

// ---- manifest completeness (RC-MANIFEST-STALE, out-p5.md, companion to isStalingEvent above) ---
// The isStalingEvent fix above catches "armed AFTER a review". This catches the plainer case: a manifest was
// armed once, a package never finished, and nothing after it ever re-reviewed — the run can still show
// missing:[] for evidence-satisfied/verify-checked because those rules only ever asked "was ANY accepted
// evidence event logged", never "did the run's OWN declared plan actually finish". A named, owner-authenticated
// skip is the one legitimate way to close an armed package without a completion event.
const MANIFEST_SKIP_RULE = 'manifest-complete';
const MANIFEST_GATED_RULE_IDS = ['evidence-satisfied', 'verify-checked'];
/** findManifestSkip(events, wpId, ownerAllowlist) -> {reason,by}|null — the SAME owner_override shape and
 *  the SAME allow-list findOwnerOverride() enforces, additionally bound to ONE named wp_id: event_type
 *  'owner_override', rule EXACT 'manifest-complete', wp_id EXACT match, a meaningful reason, `by` in the
 *  configured owner allow-list. Fail-closed like every other override lookup in this file: no id, no reason,
 *  or no configured allow-list means no skip is ever recognized. */
function findManifestSkip(events, wpId, ownerAllowlist) {
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.event_type !== 'string' || e.event_type.toLowerCase() !== 'owner_override') continue;
    if (typeof e.rule !== 'string' || e.rule !== MANIFEST_SKIP_RULE) continue;
    if (e.wp_id == null || String(e.wp_id) !== String(wpId)) continue;
    if (!isMeaningfulReason(e.reason, MANIFEST_SKIP_RULE)) continue;
    const by = (typeof e.by === 'string') ? e.by.trim() : '';
    if (!by || !ownerAllowlist.has(by.toLowerCase())) continue;
    return { reason: String(e.reason).trim(), by };
  }
  return null;
}
/** manifestCompleteness(root, runId, events, ownerAllowlist) -> {applicable, ok, outstanding:[{wp_id,status}],
 *  reason?}
 *  Reads the run's OWN manifest.json (via forge-manifest.cjs's `load()`) and projects its real status purely
 *  from this run's events (forge-manifest.cjs's own pure `projectManifest()` — never writes, never re-derives
 *  a second projection algorithm). A project without forge-manifest.cjs, or a run that never armed one, is
 *  simply NOT APPLICABLE — never a fabricated block on a run that used no manifest at all.
 *
 *  V21 (2026-09-24 second Codex recheck, out-p7.md) — every `mod.load()` exception used to collapse to the
 *  SAME `{applicable:false, ok:true}` "never armed" outcome, whether the manifest was genuinely never armed
 *  (ENOENT) or was ARMED and then corrupted, made unreadable (EACCES), or deleted outright. REPRODUCED: an
 *  armed-but-unfinished manifest made the contract red; replacing manifest.json with malformed JSON, or
 *  injecting an EACCES on read, made the SAME run green again — corrupting the mandatory-work record was
 *  strictly BETTER for the run than leaving it intact. `manifest_armed` (see `isStalingEvent` above) is this
 *  run's own event-logged proof that a manifest WAS armed; when that event is present, a `load()` failure of
 *  ANY kind is a genuine defect in required evidence — reported `applicable:true, ok:false` with the reason —
 *  never silently downgraded to "not applicable". Only a run whose events never recorded arming at all stays
 *  NOT APPLICABLE, matching every other run that used no manifest. `hasEvent()` already excludes a disproven
 *  `manifest_armed` claim (content-oracle proof_verified:false), so a fabricated arming claim does not count
 *  as "armed" here either.
 *
 *  V21 (2026-09-24 THIRD Codex recheck, out-p8.md remaining gap) — the module-unavailable branch below ran
 *  BEFORE `armed` was even computed, so forcing `loadManifestTool()`'s require() itself to fail (a genuinely
 *  incomplete/damaged installation, not just a missing manifest.json for this one run) collapsed straight to
 *  the SAME "never armed" `{applicable:false, ok:true}` outcome even for a run whose OWN events already
 *  recorded `manifest_armed`. REPRODUCED: an armed fixture with a forced module-load failure reported
 *  `{ok:true, missing:[]}` exactly like a run that used no manifest at all. `armed` is now checked FIRST — an
 *  armed run whose loader is unavailable is a genuine defect (`applicable:true, ok:false`), never silently
 *  reclassified as not-applicable; only a run that never armed anything stays not-applicable, matching every
 *  other module-load failure path in this function. */
function manifestCompleteness(root, runId, events, ownerAllowlist) {
  const armed = hasEvent(events, 'manifest_armed');
  const mod = loadManifestTool();
  if (!mod || typeof mod.load !== 'function' || typeof mod.projectManifest !== 'function') {
    if (armed) {
      return { applicable: true, ok: false, outstanding: [], reason: 'manifest_armed is logged for this run but forge-manifest.cjs (load/projectManifest) is unavailable — an armed run\'s declared obligations cannot be silently discarded because the loader module itself is missing or incomplete' };
    }
    return { applicable: false, ok: true, outstanding: [] };
  }
  let wps;
  try { wps = mod.load(runId, { root }); }
  catch (e) {
    if (armed) {
      return { applicable: true, ok: false, outstanding: [], reason: 'manifest_armed is logged for this run but the manifest could not be loaded (' + (e && e.message ? e.message : String(e)) + ') — a corrupted or missing manifest after arming is a defect, never a silent pass' };
    }
    return { applicable: false, ok: true, outstanding: [] }; // no manifest ever armed for this run
  }
  const projected = mod.projectManifest(wps, events);
  const outstanding = [];
  for (const wp of projected) {
    if (wp.status === 'done') continue;
    if (findManifestSkip(events, wp.wp_id, ownerAllowlist)) continue;
    outstanding.push({ wp_id: wp.wp_id, status: wp.status });
  }
  return { applicable: true, ok: outstanding.length === 0, outstanding };
}

// ---- trigger applicability -------------------------------------------------------------------------------
/** ruleApplies(rule, domain, complexity) -> boolean — see file header MODEL section. Both `domain` and
 *  `complexity` may be null/undefined (not known for this run); a rule scoped to the axis a caller knows
 *  nothing about simply does not apply — the same under-claiming discipline the domain axis has always used,
 *  never a fabricated match. Only "always" rules apply when neither is known. Never throws. */
function ruleApplies(rule, domain, complexity, shape) {
  const d = domain ? String(domain).trim().toLowerCase() : null;
  if (rule.trigger === 'always') return true;
  // complexity is a domain-INDEPENDENT axis — evaluated before the domain guard below, so a
  // "complexity:>=L3" rule fires on a heavy run whose domain is unknown.
  const cx = COMPLEXITY_TRIGGER_RE.exec(rule.trigger);
  if (cx) {
    const level = levelNum(complexity);
    return level > 0 && level >= Number(cx[1]);
  }
  // I.6: the run-shape axis is domain-independent too. No shape passed (an older caller) = the run declares nothing =
  // the rule does not apply — the same under-claiming discipline as an unknown domain, never a fabricated match.
  const rs = RUN_SHAPE_TRIGGER_RE.exec(rule.trigger);
  if (rs) return !!(shape && shape.applies && shape.applies[rs[1]] === true);
  if (!d) return false;
  if (rule.trigger === 'web') return WEB_DOMAINS.has(d);
  if (rule.trigger === 'correctness-critical') return criticalDomains().some((x) => String(x).toLowerCase() === d);
  if (rule.trigger.startsWith('domain:')) return rule.trigger.slice('domain:'.length).toLowerCase() === d;
  return false;
}

// ---- complexity resolution (DECLARED vs DERIVED — never conflated) ---------------------------------------
// The dispatch events that count as one unit of dispatched work. Same three event types dispatch-logged's own
// check.key already uses — reused deliberately, so "a run dispatched agents" means ONE thing in this file.
const DISPATCH_EVENT_TYPES = ['agent_started', 'subagent_started', 'custom_subagent_created'];
const WORK_PACKAGE_EVENT_TYPE = 'agent_work_package_created';
// run.json field names that really carry a level in this project's own history (measured 2026-08-03 across
// the 30 runs in .claude/forge-runs: "complexity" in 10 runs, "fanout" in 5). fan_out/level are accepted as
// obvious spelling variants so a future writer does not silently produce an unread field.
const DECLARED_LEVEL_FIELDS = ['complexity', 'fanout', 'fan_out', 'level'];

/** countUnits(events) -> number — the REAL count of dispatched work units in this run: the larger of
 *  (a) how many dispatch events were logged and (b) how many work packages were created. Both are counted
 *  as raw EVENTS, not distinct agent names: this project reuses 12 permanent Boss names, so distinct names
 *  badly understate fan-out (measured: logged 26 subagent_started events
 *  across only 6 distinct names). Never throws. */
function countUnits(events) {
  let dispatch = 0, packages = 0;
  for (const e of events) {
    if (!e || typeof e !== 'object' || typeof e.event_type !== 'string') continue;
    const type = e.event_type.toLowerCase();
    if (DISPATCH_EVENT_TYPES.includes(type)) dispatch++;
    else if (type === WORK_PACKAGE_EVENT_TYPE) packages++;
  }
  return Math.max(dispatch, packages);
}

/** levelFromUnits(units) -> 'L1'..'L4' — the project's OWN fan-out bands, quoted from CLAUDE.md ("L1 small
 *  (1–3 agents) · L2 medium (3–6) · L3 complex (6–12) · L4 large (phased)"), not thresholds invented here.
 *  Boundaries are resolved downward (3 -> L1, 6 -> L2, 12 -> L3) so a run on a band edge is never pushed
 *  into owing MORE than the band it sits on. */
function levelFromUnits(units) {
  if (units <= 3) return 'L1';
  if (units <= 6) return 'L2';
  if (units <= 12) return 'L3';
  return 'L4';
}

/** declaredLevel(runMeta) -> 'L1'..'L4' | null — the level a run.json DECLARES, or null when it declares
 *  none (measured: 12 of this project's 30 runs have no run.json at all, and 2 more have one with no level
 *  field — so "declared" is genuinely often absent, never assumable). */
function declaredLevel(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;
  for (const field of DECLARED_LEVEL_FIELDS) {
    const parsed = parseLevel(runMeta[field]);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * resolveComplexity(events, runMeta, paramLevel) -> { level, declared, derived, source, units }
 *
 * HONESTY CONTRACT — a DERIVED level is not a DECLARED level, and this function never lets one masquerade
 * as the other. `declared` is what the run itself claimed (run.json; null when it claimed nothing),
 * `derived` is what the run's real events MEASURE (countUnits -> levelFromUnits), and `source` names which
 * one actually produced the returned `level`. Any rule that fires on a derived level is, by construction,
 * firing on an inference — which is why both halves are reported in check()'s result and why a rule scoped
 * this way stays overridable.
 *
 * RECONCILIATION IS BY MAX, deliberately: run.json is written by the Lead, i.e. it is a SELF-REPORT. If the
 * declared level alone decided, a Lead could write "complexity":"L1" and dodge every heavy-work rule while
 * really dispatching twenty agents. Taking the highest of declared/derived/param means a run can always be
 * held to at least what it measurably did. Lowering is therefore not possible by declaration — it is
 * possible only through the owner_override route, which is attributed and leaves a reason on the record.
 *
 * Measured bias (across the 17 of this project's 30 real runs that declare a level): derived
 * AGREES with declared on 3, UNDER-states it on 14 (e.g. declares L4 but logged
 * only 3 dispatch events; declares L4 and logged none), and NEVER over-states it.
 * So derivation on its own errs toward demanding LESS — under-claiming over over-claiming, the same bias
 * FORGE_HARD_RULES.json's own HONEST GAPS already prefer. The practical consequence is worth stating
 * plainly: a genuinely heavy run that logs no dispatch events and declares nothing will be read as L1 and
 * will NOT be asked for a PRD. That is a real hole, and it is the honest one to leave open — the alternative
 * (guessing heaviness from weaker signals) would block light runs on nothing.
 */
function resolveComplexity(events, runMeta, paramLevel, harnessUnits) {
  const units = countUnits(events || []);
  const derived = levelFromUnits(units);
  // Category tests O26: the level declared on run_started is a declaration too. A headless session cannot
  // write run.json (O25), so reading only run.json dropped restaurant-v2's L2 and judged the run L1.
  const startEv = (events || []).find((e) => e && e.event_type === 'run_started');
  const fromRunJson = declaredLevel(runMeta);
  const fromStart = declaredLevel(startEv);
  const declared = fromRunJson && fromStart ? maxLevel(fromRunJson, fromStart) : (fromRunJson || fromStart);
  const param = parseLevel(paramLevel);
  // Category tests O19: the real SubagentStart hook lines of this run (harnessUnitsFor) can only RAISE the
  // level. A Lead that logs fewer dispatches than it really made no longer lowers its own bar.
  const harness = Number.isFinite(harnessUnits) && harnessUnits > 0 ? levelFromUnits(harnessUnits) : null;

  let level = derived;
  if (harness) level = maxLevel(level, harness);
  if (declared) level = maxLevel(level, declared);
  if (param) level = maxLevel(level, param);

  const source = (declared === level) ? 'declared' : (param === level) ? 'param' : (harness === level && harness !== derived) ? 'harness' : 'derived';
  return { level, declared, derived, source, units, harness_units: Number.isFinite(harnessUnits) ? harnessUnits : null };
}

/** harnessUnitsFor(root, runId, events) -> number | null. Real SubagentStart hook lines that belong to this run: stamped
 *  with it, or unstamped and inside its time window (run_started .. run_completed, else now). null = no hook log. */
function harnessUnitsFor(root, runId, events) {
  const recs = harnessRecordsFor(root, runId, events, 'start');
  return recs === null ? null : recs.length;
}
/** harnessRecordsFor(root, runId, events, kind) -> record[] | null. The hook lines of `kind` ('start' | 'stop' | 'tool')
 *  that belong to this run: stamped with it, or unstamped and inside its time window (run_started .. run_completed, else
 *  now). null = no hook log (or the matcher is absent). The ONE window rule; harnessUnitsFor and skill-delivery share it. */
function harnessRecordsFor(root, runId, events, kind) {
  let HM; try { HM = require('./forge-harness-match.cjs'); } catch { return null; }
  let H; try { H = HM.loadHarness(root); } catch { return null; }
  if (!H || !H.records || !H.files.length || !Array.isArray(H.records[kind])) return null;
  const ms = (v) => { const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
  const tsOfEv = (e) => ms(e && (e.timestamp || e.ts || e.ingested_at));
  const startEv = (events || []).find((e) => e && e.event_type === 'run_started');
  const endEv = (events || []).filter((e) => e && e.event_type === 'run_completed').pop();
  const from = startEv ? tsOfEv(startEv) : null;
  const to = endEv ? tsOfEv(endEv) : Infinity;
  const out = [];
  for (const r of H.records[kind]) {
    if (!r || typeof r !== 'object') continue;
    if (r.run) { if (r.run === runId) out.push(r); continue; }
    const at = ms(r.ts);
    if (from !== null && at !== null && at >= from && at <= to) out.push(r);
  }
  return out;
}

// ---- reading a run's real content (PURE projection — never assumed) --------------------------------------
/** readEventsJsonl(eventsPath) -> event[] — line-delimited JSON, BOM-tolerant, malformed lines silently
 *  skipped (mirrors forge-verify.cjs/forge-orchestrate.cjs's own readEventsJsonl tolerance). Throws only
 *  when the file itself cannot be read (missing/unreadable run). */
function readEventsJsonl(eventsPath, runId) {
  // een onparseerbare regel werd hier STIL geskipt — een afgekapte staart (crash
  // mid-append) of een corrupte middenregel verdween geruisloos uit het bewijs waar dit CONTRACT zijn
  // block-oordeel op velt. Een completion-gate is fail-closed: de centrale classifier (log-event.cjs,
  // missing|empty|partial|corrupt|valid) beslist, en alles behalve valid/empty is een harde weigering
  // met de exacte toestand en regelnummers — nooit "die regel telt gewoon niet mee".
  // BEWUST de EIGEN module (__dirname-relatief), nooit de writer van de doel-root: een vreemde root kan
  // daar elk willekeurig script hebben staan en require() VOERT dat uit (de eigen testfixture bewees het
  // — een capture-stub draaide mee als "classifier"). Classificatie is puur lezen; onze module volstaat.
  let cls = null;
  try {
    const M = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));
    // Codex r5 #6: het CONTRACT leest met de STRIKTE bril — schema + hashketen + run-binding.
    // Een omgezet event met een stale hash of een geketend event van een andere run is hier corrupt.
    if (M && typeof M.readEventsClassified === 'function') cls = M.readEventsClassified(eventsPath, { verifyChain: true, runId });
  } catch (e) {
    /** R3-06 (derde herreview): de terugval parseert alleen JSON en verifieert de HASHKETEN NIET. Op een
     *  beschadigde installatie werd een completion-oordeel daarmee fail-OPEN: oudere entries konden zijn
     *  gewijzigd zonder dat iets dat opmerkte, terwijl de poort gewoon groen gaf. Een contractcheck zonder
     *  ketenvalidatie is geen contractcheck — dus geen stille terugval meer, maar een harde fout. */
    throw new Error('forge-runcontract: de event-classifier (.claude/forge-dashboard/log-event.cjs) kon niet worden geladen: ' + (e && e.message ? e.message : String(e)) + ' — zonder ketenvalidatie is een completion-oordeel niet te vertrouwen, dus fail-closed');
  }
  if (!cls) {
    throw new Error('forge-runcontract: de event-classifier levert geen readEventsClassified() — deze installatie kan de hashketen niet verifieren, dus geen completion-oordeel (fail-closed)');
  }
  if (cls) {
    if (cls.status === 'missing') throw new Error('forge-runcontract: could not read events file ' + eventsPath + ': ' + (cls.error || 'missing'));
    if (cls.status === 'partial' || cls.status === 'corrupt') {
      /** (2.2, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — this is a FACT about the run's
       *  OWN log (a genuinely damaged/tampered chain), never a tool/environment problem. Tagged so a
       *  caller like forge-certify.cjs's contractState() can tell "this run's log is damaged" apart from
       *  "this tool could not evaluate at all" (module missing, no rules file) WITHOUT re-implementing the
       *  classifier's own judgement or fragile string-matching the message. See forgeLogDamaged's doc at
       *  its one other use site (contractState) for why the distinction matters. */
      const err = new Error('forge-runcontract: events log is ' + cls.status.toUpperCase() + ' (regel ' + cls.badLines.map((b) => b.line + (b.reason ? ':' + b.reason : '')).join(',') + ') — a completion contract never judges a damaged log (fail-closed); repair or investigate ' + eventsPath);
      err.forgeLogDamaged = true;
      throw err;
    }
    return cls.entries;
  }
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); }
  catch (e) { throw new Error('forge-runcontract: could not read events file ' + eventsPath + ': ' + e.message); }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const events = [];
  let lineNo = 0;
  for (const line of raw.split(/\r?\n/)) {
    lineNo++;
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); }
    catch {
      // net als hierboven: een onparseerbare regel is een feit over DEZE log, geen infrastructuurfout.
      const err = new Error('forge-runcontract: events log has an unparseable line ' + lineNo + ' — fail-closed (was: silently skipped)');
      err.forgeLogDamaged = true;
      throw err;
    }
  }
  return events;
}

/** readEventsForCheck(eventsPath, runId, opts) —. The writer's own completion gate
 *  (log-event.cjs, before it appends run_completed) judges the run as it will look once its pending batch
 *  lands, so an IN-PROCESS caller may pass `opts.extraEvents`: events the writer already validated but has not
 *  appended yet (the batch lines before run_completed). They go AFTER the chain-verified on-disk log, never
 *  into it, and no CLI flag can supply them. With extraEvents, a run folder without an events.jsonl yet reads
 *  as an empty log rather than a missing one. Without extraEvents this is exactly readEventsJsonl(). */
function readEventsForCheck(eventsPath, runId, opts) {
  const extra = opts && Array.isArray(opts.extraEvents)
    ? opts.extraEvents.filter((e) => e && typeof e === 'object' && !Array.isArray(e))
    : null;
  if (!extra) return readEventsJsonl(eventsPath, runId);
  const onDisk = fs.existsSync(eventsPath) ? readEventsJsonl(eventsPath, runId) : [];
  return onDisk.concat(extra);
}

/** listRunArtifacts(runDir) -> {name, nonEmpty}[] — the REAL files actually sitting in the run's own
 *  directory (e.g. final-report.md, run.json), excluding events.jsonl itself (that is judged as events, not
 *  an artifact), each tagged with whether its REAL content is genuinely non-empty (V9-fix, 2026-07-22 —
 *  break-swarm DEFECT 1: a 0-byte/whitespace-only placeholder file used to satisfy an artifact-present check
 *  on filename alone — "a real final-report must actually exist" now means it, not just that some file with
 *  a matching name happens to sit there). A missing/unreadable directory yields an empty list rather than
 *  throwing — the events.jsonl read above is what surfaces a genuinely missing run. An individual file that
 *  cannot be read is honestly tagged nonEmpty:false (never assumed non-empty). */
function listRunArtifacts(runDir) {
  let entries;
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return []; }
  const files = entries.filter((e) => e.isFile() && e.name !== 'events.jsonl');
  return files.map((e) => {
    let nonEmpty = false;
    try { nonEmpty = fs.readFileSync(path.join(runDir, e.name), 'utf8').trim().length > 0; } catch { nonEmpty = false; }
    return { name: e.name, nonEmpty };
  });
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** eventIsDisproven(e) — mirrors forge-manifest.cjs::eventIsDisproven(): log-event.cjs's own CONTENT
 *  ORACLE already flagged this event's pass-claim as false (non-zero exit code / missing-or-blank proof
 *  artifact). Such an event is a CLAIM, not evidence.
 *  V23 (2026-09-24 second Codex recheck, out-p7.md) — delegates to the ONE shared predicate in
 *  forge-proof-gate.cjs (also consulted by forge-verify.cjs's taskStatus()) so this file's independent-
 *  review protocol and the task-closure path can never again disagree about what counts as disproven.
 *  Falls back to the identical inline check if the sibling is ever unreachable. */
let _proofGateCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadProofGate() {
  if (_proofGateCache !== undefined) return _proofGateCache;
  try { _proofGateCache = require('./forge-proof-gate.cjs'); } catch { _proofGateCache = null; }
  return _proofGateCache;
}
function eventIsDisproven(e) {
  const pg = loadProofGate();
  if (pg && typeof pg.isDisprovenEvent === 'function') return pg.isDisprovenEvent(e);
  return !!(e && e._forge_verify && e._forge_verify.proof_verified === false);
}

/** RC-CLAIMS-AS-PROOF (out-p5.md) — hasEvent() used to match on `event_type`
 *  alone, so an event the writer's own content oracle already flagged as false
 *  (`_forge_verify.proof_verified === false`) still satisfied any rule keyed to its type. REPRODUCED: seven
 *  claimed events, each stamped proof_verified:false, produced CONTRACT OK with no real work or check ever
 *  executed. A disproven claim is now rejected outright — never counted as satisfying evidence.
 *  SCOPE NOTE (honesty): the fuller ask ("require the evidence reference fields the rule names — path/
 *  tally/exit code — to be present") is NOT implemented for every event-present rule in this pass. Most
 *  event-present rules (memory-read, owner-prefs-loaded, research-done, dispatch-logged, …) are narrative
 *  one-shot facts with no natural path/tally/exit-code payload at all — inventing a required field for them
 *  would need a FORGE_HARD_RULES.json schema change (check.evidence_fields) that is out of this file's
 *  edit scope for this work package (that config is governed elsewhere) and would need a coordinated
 *  fixture migration across ~30 historical runs and this project's own test suites to avoid a mass false-
 *  red regression. The concrete, reproduced exploit (a disproven claim counting as proof) is fixed
 *  unconditionally here; the broader schema-level evidence-grammar requirement is DEFERRED — see this
 *  work package's report for the explicit classification. */
function hasEvent(events, key) {
  const wanted = toArray(key).map((t) => String(t).toLowerCase());
  if (wanted.length === 0) return false;
  return events.some((e) => e && typeof e === 'object' && typeof e.event_type === 'string'
    && wanted.includes(e.event_type.toLowerCase()) && !eventIsDisproven(e));
}

/** hasArtifact(artifacts, key) -> boolean — case-insensitive filename-substring match AGAINST a genuinely
 *  non-empty file only (V9-fix, DEFECT 1 — see listRunArtifacts() doc). `artifacts` is normally the
 *  {name,nonEmpty}[] shape listRunArtifacts() returns; a plain string[] (legacy direct callers / narrow unit
 *  tests that only want to prove the filename-matching half in isolation) is still accepted and treated as
 *  already-known-non-empty, so a caller that already filtered/knows its list is real content keeps working. */
function hasArtifact(artifacts, key) {
  const subs = toArray(key).map((s) => String(s).toLowerCase());
  if (subs.length === 0) return false;
  return subs.some((sub) => artifacts.some((a) => {
    const name = (typeof a === 'string') ? a : (a && a.name);
    const nonEmpty = (typeof a === 'string') ? true : !!(a && a.nonEmpty);
    return typeof name === 'string' && name.toLowerCase().includes(sub) && nonEmpty;
  }));
}

function hasDoctorRun(events) {
  return hasEvent(events, 'doctor_run');
}

/** checkSatisfied(rule, ctx) -> boolean — evaluates ONE rule's check against ctx:{events, artifacts, domain}.
 *  A domain_aware event-present check that fails on its own generic key also tries forge-verify.cjs's
 *  evidenceCheck(events, domain) (reused, never re-implemented) as an OR-fallback — see FORGE_HARD_RULES.json
 *  header doc for the exact contract. Never throws; a sibling-tool load/config failure is treated as "no
 *  domain-specific proof available", never a fabricated pass. */
/** independentVerification(events) — WIE bevestigde de claim? (research-lane A)
 *  Het defect dat dit sluit is gemeten en gereproduceerd: de un-overridable `verify-checked`-regel werd
 *  bevredigd door ELK check_passed-event, ongeacht wie het logde. Een Boss kon dus zijn eigen werk
 *  goedkeuren en CONTRACT OK krijgen (RED-baseline: red-baseline-imp001.txt). Externe onderbouwing:
 *  self-preference bias bij LLM-als-jury (arXiv:2410.21819) en Anthropic's eigen subagent-richtlijn om
 *  review door een CONTEXT-GEÏSOLEERDE agent te laten doen.
 *
 *  Een run telt als onafhankelijk geverifieerd zodra ÉÉN van deze drie waar is — elk is een echte,
 *  gelogde gebeurtenis, geen vertrouwensverklaring:
 *   (1) DIVERSITEIT — een pass-claim (check_passed/quality_gate_passed/retest_completed) is gelogd door
 *       een agent die in deze run GEEN werk-event logde (de waarnemer is niet de uitvoerder);
 *   (2) EXTERNE REVIEWER — een event met runtime 'codex' (of een verify_result/codex_review-event):
 *       een onafhankelijke reviewer buiten deze agent heeft echt gedraaid;
 *   (3) EXPLICIETE ATTRIBUTIE — een pass-claim draagt `verified_by` met een andere naam dan zijn eigen
 *       `agent`; dat maakt de tweede waarnemer expliciet en controleerbaar in de log.
 *  Geeft {ok, route, workers, verifiers, reason} terug — de reden gaat mee in de contract-uitvoer zodat
 *  een rode uitslag zegt WAT er ontbreekt, niet alleen DAT er iets ontbreekt. */

/** Waarom niet "elke agent die iets logde": `run_started`, notities en audit-events zijn geen werk, en
 *  die actor-benadering maakte `run_started(A) + review(B)` tot een geldige verificatie van een run
 *  waarin NIEMAND iets deed (F-06). Zie de omkering hieronder voor hoe "werk" nu wordt bepaald. */
/** NON_WORK_EVENT_TYPES — de OMKERING (derde herreview 2026-08-09).
 *
 *  Twee rondes lang was dit een allowlist van "werk". Die faalt structureel ONVEILIG: elk eventtype dat
 *  je vergeet — of dat later wordt toegevoegd — telt dan automatisch NIET als werk, waardoor de
 *  uitvoerder buiten de werkersverzameling valt en zichzelf mag goedkeuren. Ronde 2 vond zo zes gaten
 *  (report_generated, prd_generated, …), ronde 3 nóg een (`research_done`). Een lijst die je moet
 *  aanvullen om veilig te blijven, is de verkeerde vorm.
 *
 *  Daarom omgekeerd: ALLES is werk, tenzij het hier expliciet als niet-werk staat. Vergeet je iets, dan
 *  is de uitkomst STRENGER (te veel als werk geteld), niet zwakker. Deze lijst bevat uitsluitend events
 *  die per definitie niets produceren of veranderen: lifecycle, waarnemingen, notities, audit en de
 *  review-events zelf. Een parametrische test toetst elk geregistreerd type tegen deze indeling, zodat
 *  een nieuw type niet stilzwijgend in de verkeerde bak belandt. */
const NON_WORK_EVENT_TYPES = new Set([
  // lifecycle
  'run_started', 'run_completed', 'run_finalized',
  // waarnemen/laden — leest, verandert niets
  'project_scanned', 'profile_loaded', 'memory_loaded', 'skill_loaded', 'file_read', 'owner_prefs_loaded',
  'claude_md_checked', 'project_skill_dir_checked', 'ecc_inventory',
  /** DISPATCH — bewust non-work, met reden: `agent_started`/`subagent_started` worden door de LEAD gelogd
   *  OVER een agent, inclusief over de reviewer zelf. Telden die als werk, dan zou elke gedispatchte
   *  reviewer automatisch uitvoerder zijn en kon niemand ooit reviewen — de poort zou zichzelf blokkeren.
   *  Dit is dus geen vergeten geval maar een gemotiveerde uitzondering. */
  'agent_selected',
  /** R5-01 (vijfde herreview): `agent_progress`, `check_started`, `fix_started`, `retest_started`,
   *  `merge_started` en `rework_started` stonden hier ook, maar de writer en het dashboard behandelen ze
   *  als ACTIEVE UITVOERING. Een reviewer die zelf `fix_started` logde bleef daardoor "buitenstaander",
   *  en zulke activiteit ná een review maakte hem niet stale. Ze zijn nu werk: wie begint te fixen,
   *  voert uit. */
  // zuiver narratief: een aantekening of een volgende-stap is geen uitkomst
  'agent_note', 'agent_next_action',
  // governance/audit
  'owner_override', 'gate_evaluated',
  /** `manifest_armed` is the arm TOOL's own proof over run
   *  bookkeeping (.claude/forge-runs/<run>/manifest.json) — the same family as `gate_evaluated`: it records
   *  that a Forge tool ran, produces nothing of the reviewed product, and cannot make a review stale (the
   *  reviewed subject is code + gates, never the run's own bookkeeping). The plan CONTENT lives in
   *  `agent_work_package_created`, which stays work (for STALENESS — see isStalingEvent) but, per the D3
   *  fix below, is no longer attributed to its `agent` field as that agent doing work — see
   *  ASSIGNMENT_EVENT_TYPES. Found because forge-manifest.cjs logged this proof without an agent, which
   *  N-01 read as anonymous work and blocked finalize; the tool now stamps the orchestrator as well, so
   *  both the classification and the attribution are right. */
  'manifest_armed',
  /** VERSION 2 RULE EVENTS (part B) — bookkeeping
   *  ABOUT the work, never the work itself. Each is inert in exactly the sense this list demands (it produces
   *  and changes nothing of the reviewed product), and each is registered at the writer first (F-08):
   *   - wp_verified: the verifier's verdict on one work package. As WORK it made a Verify Boss that logs its
   *     verdict a worker, so that same agent's review of the run failed independent-verification as
   *     self-approval — the verifier punished for doing exactly its job (a BLOCK rule). The rule
   *     wp-verified-per-wp still refuses a verdict from an agent that did real work on that package.
   *   - route_assigned / escalation: the triage route and the one GOAT retry step are assignment decisions,
   *     like the bare plan in ASSIGNMENT_EVENT_TYPES (wp-verified-per-wp lists both as worker_exclude). The
   *     retried WORK itself is logged by the dispatched worker and stays work.
   *   - run_paused / run_resumed / session_resumed: lifecycle, the same family as run_started/run_completed.
   *   - gate_blocked: the gate hook recorded that it STOPPED an action; nothing was produced.
   *  Deliberately NOT here: sync_completed (a sync writes files into a project) and owner_requirement_noted (a
   *  new owner requirement changes what the run must deliver, so it must make an earlier review stale — which is
   *  exactly what counting as work does in isStalingEvent). */
  'wp_verified', 'route_assigned', 'escalation', 'run_paused', 'run_resumed', 'session_resumed', 'gate_blocked',
  /** part ii: the scribe reconciliation events, bookkeeping ABOUT the owner's requests in the same
   *  sense as the seven above. owner_requests_reconciled records that the scribe gate was OK when it was logged (the
   *  writer checks that); requirement_resolved records that one requirement reached its end state. Neither produces or
   *  changes anything of the reviewed product. The requirement ITSELF (owner_requirement_noted) stays work.
   *  Codex R3 SC-06 (same day): scribe_head is the writer-stamped anchor of the scribe ledger in the run log — the
   *  hook appends one after each owner-prompt capture; it records a hash and produces nothing. */
  'owner_requests_reconciled', 'requirement_resolved', 'scribe_head',
  /** R4-02 (vierde herreview): hier stonden ook `agent_output`, `decision_logged`, `rework_assigned` en
   *  `rejected_approach`. Dat was fout, en precies de valkuil van de omkering: de uitzonderingslijst mag
   *  alleen INERTE events bevatten. `rejected_approach` eist bij de writer zelfs BEWIJS en geldt later als
   *  vertrouwd resultaat; `agent_output` en `decision_logged` leveren inhoud op. Een reviewer die zoiets
   *  zelf produceerde viel daardoor buiten de werkersverzameling, en zulk werk ná een review maakte hem
   *  niet stale. Ze zijn nu gewoon werk — wie iets oplevert, is een uitvoerder. */
]);
/** ASSIGNMENT_EVENT_TYPES (D3 fix, 2026-09-26 fresh-laptop re-audit; NARROWED by the 2.3 fix,,
 *  same date, review C VERDICT FAIL) — an event that only ANNOUNCES who a work package is assigned to,
 *  logged by the Lead ABOUT another agent (forge.md:89), never by that agent about itself, and carrying
 *  NO proof the agent was actually dispatched (no dispatch_id, no runtime, no allowed-actions — a bare
 *  plan). It stays a work-type event for isWorkEvent/isStalingEvent (new planned work still makes a prior
 *  "everything reviewed" verdict stale), but its `agent` field must never be read as that agent doing work
 *  in independentVerification's worker-attribution loop — see the call site below.
 *
 *  2.3 REGRESSION FIX: the original D3 fix put `custom_subagent_created` in this set too, unconditionally
 *  exempting it from worker attribution. That event is NOT a bare plan — the un-overridable
 *  `dispatch-logged` rule (FORGE_HARD_RULES.json) accepts it as REAL proof an agent was dispatched
 *  (dispatch_id, mission, allowed actions), exactly like `agent_started`/`subagent_started`.
 *  REPRODUCED: `custom_subagent_created {agent:"Review Boss", role:"implementer", mission:"implement X"}`
 *  with no later event naming Review Boss let Review Boss's own later approval pass as independent —
 *  before D3 this was correctly blocked as self-approval. Moved to IV_DISPATCH_TYPES below, where it now
 *  gets the exact same `!isReviewDispatch(e)` gating as the other two real dispatch events: it counts as
 *  work UNLESS the event itself proves it was a review assignment. Only `agent_work_package_created` (the
 *  bare, unproven plan) stays unconditionally exempt here. */
const ASSIGNMENT_EVENT_TYPES = new Set(['agent_work_package_created']);
/** IV_DISPATCH_TYPES — `agent_started`/`subagent_started`/`custom_subagent_created` worden door de Lead
 *  gelogd OVER een agent, maar zijn stuk voor stuk ECHT dispatchbewijs (dispatch_id/mission/allowed
 *  actions) — geen kaal plan.
 *
 *  R6-02 (zesde herreview) weerlegde mijn eerdere aanname dat ze daarom categorisch geen werk zijn: een
 *  probe met `agent_started {agent:"Review Boss", task:"implement patch"}` liet de log letterlijk zien dat
 *  de bevestiger voor IMPLEMENTATIE was gedispatcht, terwijl de poort hem als buitenstaander behandelde.
 *  Ik had die uitzondering zelf al gemarkeerd als het punt waar ik twijfelde — terecht.
 *
 *  Nu omgekeerd: een dispatch is WERK, tenzij hij aantoonbaar een REVIEW-opdracht is. Bewijzen dat je
 *  voor review bent ingezet ligt bij het event; ontbreekt dat bewijs, dan is de veilige lezing dat er
 *  uitvoerend werk is gedispatcht. `custom_subagent_created` volgt vanaf de 2.3-fix exact
 *  dezelfde regel — zie ASSIGNMENT_EVENT_TYPES hierboven voor waarom hij daar is weggehaald. */
const IV_DISPATCH_TYPES = new Set(['agent_started', 'subagent_started', 'custom_subagent_created']);
/** R7-04 (zevende herreview) — MIJN EIGEN R6-02-FIX WAS TE RUIM. Het volstond dat "review" ergens in een
 *  vrij tekstveld voorkwam, dus `task: "implement review feedback"` gold als reviewopdracht: precies de
 *  implementatie-dispatch die R6-02 juist moest vangen. Vrije tekst laten beslissen over een
 *  veiligheidsgrens is de fout; een woord dat toevallig voorkomt is geen bewijs van intentie.
 *
 *  Nu twee eisen tegelijk: (1) een expliciet, gestructureerd veld dat de rol vastlegt, en (2) die rol
 *  moet de HELE waarde zijn, niet een woord in een zin. Zo blijft een dispatch die naar review verwijst
 *  maar iets anders doet gewoon werk — de veilige lezing. */
/** R8-01 (achtste herreview) — IK MAAKTE DEZELFDE FOUT ALS BIJ R3-01, één laag dieper. Mijn R7-04-fix
 *  gebruikte een DENYLIST van uitvoeringswerkwoorden (implement|fix|patch|…): alles wat daar niet in
 *  stond, gold als review. `task: "develop production feature"` kwam er dus gewoon door. Een denylist
 *  faalt open op precies de gevallen die je niet hebt bedacht — dat is de fout die ik bij de
 *  work-taxonomie al had omgekeerd en hier opnieuw introduceerde.
 *
 *  Nu POSITIEF BEWIJS aan beide kanten: een dispatch telt alleen als review wanneer het rolveld exact een
 *  reviewrol is EN de taak — als die er is — zelf aantoonbaar reviewwerk beschrijft. Onbekende of
 *  onbeschreven taken vallen aan de strenge kant: werk. */
const REVIEW_ROLE_RE = /^(review|reviewer|independent[ _-]?review|code[ _-]?review|verify|verification|audit|controle)$/i;
const REVIEW_TAAK_RE = /^(?:[a-z ]*\b(?:review|reviewing|verify|verifying|verification|audit|auditing|inspect|inspection|assess|assessment|controleer|controle|beoordeel|beoordeling)\b[a-z0-9 _./:#-]*)$/i;
/** R9-01 (negende herreview): mijn "positief bewijs" was nog steeds te ruim. Drie gaten bleven open:
 *   - een reviewrol ZONDER taak gold als review — terwijl "waarvoor is deze agent ingezet" dan juist
 *     onbekend is, en onbekend hoort aan de strenge kant te vallen;
 *   - `task:"review and implement production feature"` paste op de reviewregex, want die keek of de
 *     zin ergens reviewwoorden bevatte in plaats van of hij UITSLUITEND review beschrijft;
 *   - `role:"review"` naast `dispatch_role:"implementation"` telde als review: één passend veld won van
 *     een tegenstrijdig veld, precies de "verstop een afkeuring"-vorm uit R5-02.
 *  Nu: ALLE aanwezige rolvelden moeten een reviewrol zijn (geen tegenspraak), er MOET een taak zijn, en
 *  die taak mag geen uitvoerende component bevatten. */
/** DERDE KEER DEZELFDE FOUT. R3-01 leerde: een lijst die je moet aanvullen om veilig te blijven
 *  is de verkeerde vorm. In R8-01 bouwde ik hem toch als denylist van uitvoeringswerkwoorden, en in R9-01
 *  breidde ik die denylist uit in plaats van hem om te keren. Nu komt `task:"review code and update
 *  production source"` erdoor, want "update" stond er niet in. Elke uitbreiding lost één geval op en laat
 *  de rest open.
 *
 *  Daarom nu een echte ALLOWLIST op tokenniveau: elk woord in de taak moet uit een kleine, vaste
 *  reviewwoordenschat komen (of een onschuldige verwijzing zijn zoals WP2, #123, een pad). Eén onbekend
 *  woord — welk woord dan ook — maakt het uitvoerend werk. Vergeet ik een legitiem reviewwoord, dan valt
 *  een echte review ten onrechte af en vraagt iemand om herformulering; dat is de goede richting om in te
 *  falen. */
const REVIEW_WOORDEN = new Set([
  'review', 'reviewing', 'reviewed', 'rereview', 're-review', 'code-review', 'codereview',
  'verify', 'verifying', 'verification', 'validate', 'validating', 'validation',
  'audit', 'auditing', 'inspect', 'inspecting', 'inspection', 'assess', 'assessing', 'assessment',
  'check', 'checking', 'controleer', 'controle', 'beoordeel', 'beoordeling', 'nakijken', 'toets', 'toetsen',
  'independent', 'onafhankelijk', 'onafhankelijke', 'of', 'the', 'a', 'an', 'de', 'het', 'een', 'van',
  'and', 'en', 'op', 'in', 'for', 'voor', 'this', 'deze', 'dit', 'run', 'diff', 'patch', 'pr', 'commit',
  'changes', 'wijzigingen', 'work', 'werk', 'package', 'pakket', 'only', 'alleen', 'read-only',
]);
const ONSCHULDIGE_VERWIJZING_RE = /^(?:wp[-_]?\d+|#\d+|[a-f0-9]{7,40}|[\w./-]+\.(?:js|cjs|mjs|ts|json|md)|\d+)$/i;
/** N6 fix (2026-09-26 independent review, LOW) — this used to read ONLY `e.task`, but the documented
 *  `custom_subagent_created` event (commands/forge.md step 5: "log `custom_subagent_created` with: name ·
 *  role · why needed · project evidence · mission · inputs · ...") carries `mission`, never `task`. A
 *  custom reviewer dispatched EXACTLY as documented (role:"review", mission:"review the auth diff") could
 *  never be recognised as a review dispatch — it always counted as work, which fails CLOSED (safe) but
 *  wrongly blocks that reviewer's own later approval as self-approval. Now both `task` and `mission` are
 *  accepted; TAAK_VELDEN below is checked with the same "every present field must independently read as
 *  review-only, one contradiction drops the claim" discipline already used for the role fields above — a
 *  dispatch carrying `task:"implement X"` alongside `mission:"review Y"` still counts as work, the safe
 *  reading, never review just because one of the two fields looks like review. */
const TAAK_VELDEN = ['task', 'mission'];
// Alleen gestructureerde rolvelden tellen — `note`/`goal` zijn narratief en beslissen hier niets meer.
const ROL_VELDEN = ['role', 'dispatch_role', 'purpose'];
function isReviewDispatch(e) {
  if (!e || typeof e !== 'object') return false;
  // R7 fix (2026-09-26 independent review, NOTE): zelfde "één tegenspraak vervalt de claim"-regel als F5
  // al toepaste op task/mission — een AANWEZIG maar non-string rolveld (bv. `role: 123`) werd hier eerst
  // net als een AFWEZIG veld weggefilterd, dus `role:123, purpose:'review'` telde als review omdat
  // `purpose` alleen overbleef en aan REVIEW_ROLE_RE voldeed. Nu vergiftigt een aanwezig rolveld van het
  // verkeerde type de hele claim — dezelfde veilige lezing als bij task/mission.
  for (const f of ROL_VELDEN) {
    if (e[f] !== undefined && e[f] !== null && typeof e[f] !== 'string') return false;
  }
  const rolVelden = ROL_VELDEN.filter((f) => typeof e[f] === 'string' && e[f].trim() !== '');
  if (!rolVelden.length) return false;
  // Eén tegenstrijdig rolveld is genoeg om de reviewclaim te laten vervallen.
  if (!rolVelden.every((f) => REVIEW_ROLE_RE.test(e[f].trim()))) return false;
  // F5 fix (2026-09-26 independent review, NOTE): a PRESENT but NON-string task/mission (e.g. a number or
  // object) used to be silently filtered out below exactly like a genuinely ABSENT field — if the OTHER
  // field happened to be pure review text, the dispatch was wrongly classified as review-only with an
  // unexamined non-string value hiding behind it. Same "one contradiction is enough" discipline as the role
  // fields above: a present-but-wrong-shape task/mission poisons the whole claim -> counts as work (false),
  // the safe reading. `null`/`undefined` still mean "not present at all" and fall through to the normal
  // string filter below.
  for (const f of TAAK_VELDEN) {
    if (e[f] !== undefined && e[f] !== null && typeof e[f] !== 'string') return false;
  }
  // Zonder taak/mission is onbekend waarvoor de agent is ingezet — dat is geen bewijs van review.
  const taakVelden = TAAK_VELDEN.filter((f) => typeof e[f] === 'string' && e[f].trim() !== '');
  if (!taakVelden.length) return false;
  /** ALLOWLIST (uitgebreid met `mission` door N6): elk woord in ELK aanwezig taakveld moet uit de
   *  reviewwoordenschat komen of een onschuldige verwijzing zijn. Eén onbekend woord — in `task` OF
   *  `mission` — maakt het uitvoerend werk; een aanwezig veld dat niet puur review beschrijft laat de hele
   *  claim vervallen, ook als het andere veld wel puur review beschrijft. */
  for (const f of taakVelden) {
    const taak = e[f].trim();
    const woorden = taak.toLowerCase().split(/[\s,;:()[\]]+/).filter(Boolean);
    if (!woorden.length) return false;
    if (!woorden.some((w) => /review|verif|validat|audit|inspect|assess|controle|beoorde|toets|nakijk/.test(w))) return false;
    if (!woorden.every((w) => REVIEW_WOORDEN.has(w) || ONSCHULDIGE_VERWIJZING_RE.test(w))) return false;
  }
  return true;
}
function isWorkEventType(type) {
  return !NON_WORK_EVENT_TYPES.has(type) && !REVIEW_START_TYPES.has(type) && !REVIEW_DONE_TYPES.has(type);
}
/** isWorkEvent(e) — de EVENT-variant: kijkt ook naar de inhoud, want bij een dispatch bepaalt de opdracht
 *  of het werk of review was. Alle andere types volgen puur hun type. */
function isWorkEvent(e) {
  const type = e && typeof e.event_type === 'string' ? e.event_type.toLowerCase() : '';
  if (!type) return false;
  if (IV_DISPATCH_TYPES.has(type)) return !isReviewDispatch(e);
  return isWorkEventType(type);
}
/** Het CAUSALE reviewprotocol op eventtypes die de writer echt registreert (F-08). Een completion telt
 *  alleen met een eerdere start van DEZELFDE reviewer onder hetzelfde review_id. */
/** R5-06 (zelf gevonden bij het draaien van ronde 5):  hoort NIET in dit protocol.
 *  forge-verify.cjs logt lead_review_completed juist BIJ EEN MISMATCH, als trigger voor rework — het is
 *  een afkeuring, geen goedkeuring. Codex wees daar in R4-01 al op; ik had het type toen laten staan
 *  omdat de verdict-eis het toch zou tegenhouden. Dat is te slim: een eventtype dat 'review afgerond'
 *  heet maar 'er is werk mislukt' betekent, hoort geen kandidaat te zijn. Weg uit beide sets. */
const REVIEW_START_TYPES = new Set(['review_started', 'codex_review_started']);
const REVIEW_DONE_TYPES = new Set(['review_completed', 'codex_review_completed']);
/** alleen een EXPLICIET goedkeurend verdict telt. Bewust een korte, gesloten lijst: alles wat er
 *  niet in staat — CHANGES_REQUIRED, blocked, of niets — is geen goedkeuring. */
const POSITIEVE_REVIEW_VERDICTS = new Set(['pass', 'passed', 'approved', 'ok', 'akkoord', 'goedgekeurd']);
/** Events die een eerdere review STALE maken (F-04): alles wat het beoordeelde subject nog kan veranderen. */
// staleness volgt exact dezelfde definitie: alles wat het beoordeelde subject nog kan veranderen
/** Staleness volgt de werkdefinitie, PLUS `owner_override` (zesde herreview): een override kan een
 *  ontbrekende contractregel rechtstreeks opheffen, waardoor het contract ná het oordeel van "niet klaar"
 *  naar "klaar" verschuift zonder dat er ooit opnieuw is gekeken. De owner is daarmee géén uitvoerder —
 *  hij hoort niet in de werkersverzameling — maar zijn ingreep maakt een eerdere review wel verouderd. */
/** RC-MANIFEST-STALE (out-p5.md) — REVERSES the 2026-09-24 Lead decision
 *  recorded in FORGE_DECISIONS.md ("Poortclassificatie aangepast met reden"), which read `manifest_armed`
 *  as fully inert because it "produces nothing of the reviewed product, same family as gate_evaluated".
 *  That reasoning conflated two DIFFERENT questions this file asks about every event:
 *    isWorkEvent    — did this event itself EXECUTE or PRODUCE something (decides who may not self-review);
 *    isStalingEvent — can a PRIOR review still be trusted about the CURRENT state of the run.
 *  Those are not the same axis. Arming a NEW work package after a review closed does not retroactively turn
 *  the arming agent into an "executor" of that work — so manifest_armed correctly stays OUT of isWorkEvent
 *  (the earlier decision was right about that half). But it DOES mean the reviewed subject just changed:
 *  there is now unreviewed, still-armed work sitting in the run that a prior "everything looked done" review
 *  could not possibly have judged, because it did not exist yet when that review ran. Treating it as inert
 *  for BOTH axes let a green independent-review survive an arm-after-review with no re-check at all.
 *  REPRODUCED (out-p5.md): arming a package after a green L2 review, through the real arm path, kept
 *  `missing:[]` / `review.ok:true`. Removing only the manifest_armed exemption from isStalingEvent in memory
 *  restored `missing:["independent-verification"]` — proving this one-line exemption, not some other defect,
 *  was the whole gap. See manifestCompleteness() below for the companion half: even without a NEW arm-after-
 *  review event, an armed package that simply never finished must not let evidence-satisfied/verify-checked
 *  read as satisfied either. */
function isStalingEvent(e) {
  const type = e && typeof e.event_type === 'string' ? e.event_type.toLowerCase() : '';
  return type === 'owner_override' || type === 'manifest_armed' || isWorkEvent(e);
}
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** independentVerification(events, opts) -> {ok, route, workers, reviewer, reason, review}
 *  opts.noGit (D2 fix) — true only when check()'s own independent probe of the current root
 *  found NO git repository at all (never merely "caller omitted commitSha" — see check()'s noGitAtRoot).
 *  When true, the completion event's commit_sha is neither required nor format-checked (there is no HEAD
 *  to bind to); the hash-chain and evidence_digest bindings below still apply in full.
 *
 *  HERBOUWD 2026-08-09 na een onafhankelijke Codex-review (VERDICT CHANGES_REQUIRED, F-01..F-10). De
 *  eerste versie accepteerde drie routes die alle drie door de gecontroleerde partij zelf te vullen waren:
 *   - `runtime:'codex'` in de eigen eventpayload  -> een worker riep zichzelf externe reviewer (F-01);
 *   - vrije `verified_by:'wie dan ook'`           -> een verzonnen naam volstond (F-05);
 *   - `codex_review`/`verify_result`              -> types die de strict writer niet eens kent (F-08).
 *  Alle drie zijn VERWIJDERD, niet verzacht: caller-JSON is geen provenance. Wat overblijft is één route
 *  die volledig uit de gelogde, hash-geketende werkelijkheid volgt:
 *
 *    een REVIEW-COMPLETION door een agent die géén werk deed in deze run, causaal gekoppeld aan zijn
 *    EIGEN eerdere review-start onder hetzelfde review_id, gebonden aan het exacte subject, en niet stale.
 *
 *  SUBJECTBINDING (F-03) zonder externe aanroep: de log is hash-geketend, dus het `prev_hash` van het
 *  completion-event IS per constructie de digest van de runstaat vlak vóór die review. Een review die
 *  `subject_log_hash` draagt dat daarvan afwijkt, beoordeelde een andere staat en telt niet. `commit_sha`
 *  moet aanwezig en welgevormd zijn; is de actuele commit bekend (opts.commitSha), dan moet hij exact
 *  matchen. `evidence_digest` legt de bewijsset vast waarop het oordeel rust.
 *
 *  EERLIJKE GRENS (F-02, bewust NIET weggepoetst): dit scheidt op AGENTLABEL, niet op runtimeprincipal.
 *  Er bestaat in deze codebase geen writer-gestempelde principal-identiteit — de writer is een CLI die de
 *  aanroeper zelf start. Eén uitvoerder die twee geregistreerde labels voert, kan deze scheiding dus nog
 *  steeds omzeilen. Echte provenance vereist dat de gateway een ondertekend dispatchreceipt stempelt; dat
 *  raakt command-center/ en is OWNER-GATED. Tot die tijd rapporteert `label_only:true` deze grens mee, in
 *  plaats van hem stil te verzwijgen. */
/** isGoedkeuring(ev) -> {ok:true} of {ok:false, reden}. DE ENE definitie van "deze review keurde goed".
 *  er stonden er twee, en de zwakkere zat in de staleness-check — dus een latere afkeuring met een
 *  leeg veld of `ok:"true"` telde daar niet als afkeuring terwijl de hoofdvalidator hem wél zou weigeren.
 *  Twee ingangen naar hetzelfde oordeel die van elkaar verschillen, zijn erger dan één strenge.
 *  V23 (2026-09-24 second Codex recheck, out-p7.md) — deze functie keek alleen naar het VERDICT-veld en
 *  nooit naar log-event.cjs's eigen content-oracle stempel. REPRODUCED: een `review_completed` met een
 *  positief verdict MAAR `_forge_verify.proof_verified:false` (de writer kon de eigen claim niet bevestigen)
 *  gold hier gewoon als goedkeuring, en valideerde zo als een onafhankelijke review. Een weerlegde claim is
 *  geen bewijs, ongeacht welk verdict-woord ernaast staat — gecontroleerd EERST, vóór elke verdict-lezing. */
const UITKOMST_VELDEN = ['review_verdict', 'verdict', 'status', 'result', 'outcome'];
function isGoedkeuring(ev) {
  if (eventIsDisproven(ev)) return { ok: false, reden: 'dit event is door de eigen contentoracle als proof_verified:false gemarkeerd — een weerlegde claim is geen goedkeuring, welk verdict-veld er ook naast staat' };
  const norm = (a) => String(a == null ? '' : a).trim().toLowerCase();
  const aanwezig = UITKOMST_VELDEN.filter((f) => ev[f] !== undefined).map((f) => ({ f, v: norm(ev[f]) }));
  if (!aanwezig.length) return { ok: false, reden: 'geen machineleesbaar review_verdict — een review zonder uitslag bevestigt niets' };
  const leeg = aanwezig.filter((g) => g.v === '');
  if (leeg.length) return { ok: false, reden: leeg.map((g) => g.f).join(', ') + ' is aanwezig maar LEEG — een uitspraak zonder inhoud is geen goedkeuring' };
  const negatief = aanwezig.filter((g) => !POSITIEVE_REVIEW_VERDICTS.has(g.v));
  if (negatief.length) return { ok: false, reden: 'de uitkomst is niet eenduidig goedgekeurd (' + negatief.map((g) => g.f + '="' + g.v + '"').join(', ') + ') — verwacht een van: ' + [...POSITIEVE_REVIEW_VERDICTS].join(', ') };
  if (ev.ok !== undefined && ev.ok !== true) return { ok: false, reden: 'het event draagt ok=' + JSON.stringify(ev.ok) + ' — alleen de boolean true telt als goedkeuring' };
  return { ok: true };
}

function independentVerification(events, opts) {
  opts = opts || {};
  const norm = (a) => String(a == null ? '' : a).trim().toLowerCase();
  const list = Array.isArray(events) ? events : [];

  const workers = new Set();
  const anoniemWerk = [];
  const starts = new Map(); // review_id -> {agent, index}
  const completions = [];
  let lastWorkIndex = -1;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== 'object' || typeof e.event_type !== 'string') continue;
    const type = e.event_type.toLowerCase();
    const agent = norm(e.agent);
    /** N-01 (post-fix herreview): een work-event ZONDER agent viel stilzwijgend buiten de werkersverzameling.
     *  Dat is de gevaarlijkste variant: de uitvoerder logt zijn werk anoniem, verdwijnt uit `workers`, en
     *  keurt het daarna onder een naam goed. Anoniem werk maakt de onafhankelijkheid dus ONBEPAALBAAR —
     *  fail-closed, niet onzichtbaar. */
    /** D3 fix (fresh-laptop re-audit) — `agent_work_package_created` is the LEAD announcing
     *  who a work package is ASSIGNED to (forge.md:89: "agent, role, runtime, mission, ...
     *  status:'previewing'"), logged BY the Lead, naming the intended executor in `agent`, with NO proof
     *  a dispatch actually happened. Crediting that name as a WORKER let a reviewer's own work-package
     *  assignment count as the reviewer doing work in this run — REPRODUCED (executed replay of a real
     *  mission): "de reviewer (review boss) deed in deze run zelf werk — dat is zelf-goedkeuring", purely
     *  because the Lead had logged the review Boss's OWN dispatch announcement. Creating a work package
     *  FOR an agent is not that agent DOING anything — only a genuine execution event
     *  (agent_started/subagent_started/custom_subagent_created/subagent_completed/etc.) proves the named
     *  agent actually worked. This event type stays counted for STALENESS (isStalingEvent below still
     *  calls isWorkEvent — new planned work still makes a prior "everything is done" review stale), and
     *  stays OUT of `anoniemWerk` too (an assignment with no named assignee is not the dangerous "who did
     *  this?" case N-01 exists for — nobody DID anything here at all).
     *  2.3 fix (same date) — `custom_subagent_created` is REAL dispatch proof (dispatch_id,
     *  mission, allowed actions — see IV_DISPATCH_TYPES), unlike the bare plan above, so it was moved OUT
     *  of ASSIGNMENT_EVENT_TYPES and into IV_DISPATCH_TYPES: `isWorkEvent(e)` now gates it through
     *  `!isReviewDispatch(e)` exactly like `agent_started`/`subagent_started`, so it counts as work unless
     *  the event itself PROVES it was a review assignment. */
    if (isWorkEvent(e) && !ASSIGNMENT_EVENT_TYPES.has(type)) {
      if (agent) workers.add(agent);
      else anoniemWerk.push(type);
    }
    if (isStalingEvent(e)) lastWorkIndex = i;
    if (REVIEW_START_TYPES.has(type)) {
      const id = typeof e.review_id === 'string' ? e.review_id.trim() : '';
      /** een review_id dat twee keer als start voorkomt is ambigu — welke van de twee hoort bij
       *  welke completion? Volgorde-afhankelijke uitkomsten zijn precies wat een poort niet mag hebben,
       *  dus zo'n id wordt vergiftigd in plaats van "de eerste wint". */
      if (id) starts.has(id) ? starts.get(id).dubbel = true : starts.set(id, { agent, index: i });
    } else if (REVIEW_DONE_TYPES.has(type)) {
      completions.push({ ev: e, agent, index: i });
    }
  }

  const base = { workers: [...workers], label_only: true };
  /** R3-02 (derde herreview): de registrycheck van de writer dekt maar een deel van de eventtypes en faalt
   *  OPEN — ontbreekt de registry, dan geldt elke naam als geregistreerd. Een uitvoerder kon zijn werk dus
   *  onder "Phantom Worker" schrijven en het daarna onder een echt label goedkeuren. De poort toetst nu
   *  zelf: elke werker en de reviewer moeten een BEKENDE naam dragen, en zonder registry is dat niet vast
   *  te stellen — dan telt geen enkele verificatie (fail-closed, niet fail-open). */
  if (opts.knownAgents !== undefined) {
    if (!(opts.knownAgents instanceof Set) || opts.knownAgents.size === 0) {
      return Object.assign({ ok: false, route: null, reason: 'de agentregistry kon niet worden gelezen, dus namen zijn niet te toetsen — fail-closed (een niet te verifieren identiteit is geen identiteit)' }, base);
    }
    const onbekendeWerkers = [...workers].filter((w) => !opts.knownAgents.has(w));
    if (onbekendeWerkers.length) {
      return Object.assign({ ok: false, route: null, reason: 'werk gelogd onder niet-geregistreerde naam/namen: ' + onbekendeWerkers.join(', ') + ' — wie dat was is niet vast te stellen, dus onafhankelijkheid evenmin' }, base);
    }
  }
  if (anoniemWerk.length) {
    return Object.assign({ ok: false, route: null, reason: 'er is werk gelogd ZONDER agent (' + [...new Set(anoniemWerk)].join(', ') + ') — wie het deed is dan onbekend, dus onafhankelijkheid is onbepaalbaar (fail-closed)' }, base);
  }
  if (!workers.size) {
    // F-06: geen enkel toegelaten werk-event — ook wanneer de run vol notities of lifecycle-events staat,
    // en ook wanneer de strict writer alle werk-events weigerde (die staan dan simpelweg niet in de log).
    return Object.assign({ ok: false, route: null, reason: 'geen enkel toegelaten work-event in deze run — er is niets om onafhankelijk van te zijn (lifecycle-, notitie- en audit-events tellen niet als werk)' }, base);
  }
  if (!completions.length) {
    return Object.assign({ ok: false, route: null, reason: missingCompletionReason(opts) }, base);
  }


  /** R8-02 (achtste herreview): elke completion gaat nu door EEN volledige protocolvalidator, en het
   *  resultaat wordt bewaard. Vroeger stopte de lus bij de eerste geldige completion, waardoor een
   *  latere ONGELDIGE completion (hergebruikt review_id, verkeerde commit, ontbrekende start) onzichtbaar
   *  bleef: alleen een expliciet NEGATIEF verdict werd nog gezien. Een ongeldige review na een
   *  goedkeuring is net zo goed een signaal dat er iets niet klopt. Startconsumptie gebeurt in deze ene
   *  pass, dus precies een keer per completion — ongeacht de uitkomst.
   *  Geen vroege return meer: eerst alles beoordelen, dan pas oordelen. */
  function valideerCompletion(c) {
    const e = c.ev;
    const id = typeof e.review_id === 'string' ? e.review_id.trim() : '';
    const subjectLogHash = typeof e.subject_log_hash === 'string' ? e.subject_log_hash.trim() : '';
    const commitSha = typeof e.commit_sha === 'string' ? e.commit_sha.trim() : '';
    const evidenceDigest = typeof e.evidence_digest === 'string' ? e.evidence_digest.trim() : '';
    const noem = e.event_type + '#' + (id || 'zonder-review_id');

    /** R5-04 (vijfde herreview): de consumptie stond NA de verdict- en reviewercontroles, dus een
     *  afgekeurde poging verbruikte niets — start -> CHANGES_REQUIRED -> approved werkte gewoon op
     *  dezelfde start. Ik had in de vorige ronde geclaimd dat dit al opgelost was; dat was onjuist.
     *  De koppeling wordt daarom als EERSTE bepaald en de start onmiddellijk verbruikt: één start hoort
     *  bij één afrondingspoging, ongeacht de uitkomst daarvan. */
    if (!id) { return { ok: false, reden: 'mist review_id, dus er is geen causale koppeling met een review-start' }; }
    const start = starts.get(id);
    if (!start) { return { ok: false, reden: 'er bestaat geen review-start met dit review_id' }; }
    if (start.dubbel) { return { ok: false, reden: 'dit review_id komt meer dan eens als start voor — ambigu, dus onbruikbaar als causale koppeling' }; }
    if (start.consumed) { return { ok: false, reden: 'deze review-start is al door een eerdere completion gebruikt — één start hoort bij één afronding' }; }
    start.consumed = true;
    if (!c.agent) { return { ok: false, reden: 'geen agent op het completion-event' }; }
    /** R4-01 (vierde herreview) — het pijnlijkste gat van allemaal: de poort keek of er EEN review was,
     *  niet of die review POSITIEF eindigde. Een `review_completed` met verdict CHANGES_REQUIRED telde
     *  dus als bevestiging van afronding. Erger nog: forge-verify.cjs emitteert `lead_review_completed`
     *  juist bij FOUTEN ("Never marks anything done"), dus een afkeuring bevestigde de afronding.
     *  Een review zonder expliciet, machineleesbaar positief verdict bewijst niets — en het ontbreken
     *  van dat veld is geen "waarschijnlijk goed", maar fail-closed. */
    /** R5-02 (vijfde herreview): `review_verdict` won altijd van `verdict`, en alleen exact `ok:false`
     *  werd bekeken. Een event met review_verdict:"approved" naast verdict:"CHANGES_REQUIRED",
     *  status:"failed", outcome:"blocked" en ok:"false" kwam er dus doorheen. Nu telt ELK uitkomstveld
     *  mee en moet het beeld eenduidig positief zijn: één afwijkend of tegenstrijdig veld is genoeg om
     *  te weigeren. Tegenstrijdigheid is geen detail — het is precies hoe je een afkeuring verstopt. */
    /** R6-08 (zesde herreview): LEGE waarden werden genegeerd, dus `review_verdict:"approved", ok:""`
     *  kwam erdoor — terwijl ik claimde dat ieder AANWEZIG uitkomstveld ondubbelzinnig positief moet
     *  zijn. Een leeg veld is geen afwezig veld: het is een aanwezige uitspraak zonder inhoud, en dat is
     *  geen goedkeuring. Aanwezig ⇒ niet-leeg ⇒ positief; en `ok` moet exact de boolean true zijn. */
    const oordeel = isGoedkeuring(e);
    if (!oordeel.ok) { return { ok: false, reden: noem + ': ' + oordeel.reden }; }
    if (opts.knownAgents instanceof Set && opts.knownAgents.size && !opts.knownAgents.has(c.agent)) { return { ok: false, reden: 'de reviewer "' + c.agent + '" staat niet in de agentregistry — een naam die niemand kent bewijst geen tweede partij' }; }
    if (workers.has(c.agent)) { return { ok: false, reden: 'de reviewer (' + c.agent + ') deed in deze run zelf werk — dat is zelf-goedkeuring' }; }
    if (start.index >= c.index) { return { ok: false, reden: 'de review-start staat NA de completion — geen causale volgorde' }; }
    if (start.agent !== c.agent) { return { ok: false, reden: 'de start is van ' + (start.agent || '(naamloos)') + ' maar de completion van ' + c.agent + ' — een review sluit je zelf af' }; }
    /** N-05 (post-fix herreview): de start moet NA al het werk liggen dat aan deze completion voorafgaat.
     *  Zonder die eis werkte hergebruik van een review_id: work → start → complete → NIEUW werk →
     *  nogmaals complete. Die tweede completion leunde op dezelfde oude start en gold weer als geldig,
     *  terwijl er intussen werk bij was gekomen. Eén regel dekt replay, ID-hergebruik én "verse review
     *  vereist na nieuw werk": een review die begon vóór het werk kan dat werk niet beoordeeld hebben. */
    const werkVoorDeze = list.slice(0, c.index).reduce((max, x, idx) => (x && typeof x === 'object' && typeof x.event_type === 'string' && isWorkEvent(x) ? idx : max), -1);
    if (start.index < werkVoorDeze) { return { ok: false, reden: 'de review-start ligt VOOR werk dat daarna nog kwam (' + list[werkVoorDeze].event_type + ') — die review kan dat werk niet beoordeeld hebben; open een verse review' }; }
    if (!subjectLogHash) { return { ok: false, reden: 'mist subject_log_hash, dus het oordeel is aan geen enkele runstaat gebonden' }; }
    const prev = typeof e.prev_hash === 'string' ? e.prev_hash.trim() : '';
    if (!prev) { return { ok: false, reden: 'het event draagt geen prev_hash — subjectbinding is niet verifieerbaar op een ongeketende log' }; }
    if (subjectLogHash !== prev) { return { ok: false, reden: 'subject_log_hash (' + subjectLogHash.slice(0, 12) + '…) wijkt af van de werkelijke runstaat bij dit event (' + prev.slice(0, 12) + '…) — er is een ANDERE staat beoordeeld' }; }
    /** Zonder deze koppeling zou `prev_hash === subject_log_hash` te vervullen zijn door BEIDE zelf te
     *  verzinnen. De keten is de enige partij die dit niet kan liegen: prev_hash moet exact de entry_hash
     *  van het voorgaande event zijn. Is de log helemaal niet geketend, dan is subjectbinding onbewijsbaar
     *  en weigeren we — fail-closed, geen zachte route voor "log zonder keten". */
    /** N-06 (post-fix herreview): "zoek achteruit naar enig eerder entry_hash" liet een ONMIDDELLIJKE
     *  voorganger zonder hash toe — dan sluit prev_hash aan op een event dat twee plekken terug ligt en is
     *  de keten in werkelijkheid onderbroken. Het moet exact de directe voorganger zijn, met een
     *  welgevormde sha256. */
    const vorige = c.index > 0 ? list[c.index - 1] : null;
    const vorigeHash = vorige && typeof vorige === 'object' && typeof vorige.entry_hash === 'string' ? vorige.entry_hash.trim() : '';
    if (!SHA256_RE.test(vorigeHash)) { return { ok: false, reden: 'de directe voorganger draagt geen welgevormde entry_hash — de keten is hier onderbroken, dus subject_log_hash is door de aanroeper zelf te verzinnen' }; }
    if (vorigeHash !== prev) { return { ok: false, reden: 'prev_hash sluit niet aan op de directe voorganger (verwacht ' + vorigeHash.slice(0, 12) + '…) — het event is losgekoppeld van de runstaat' }; }
    /** D2 fix (fresh-laptop re-audit) — a genuinely git-less project has no commit to bind to
     *  at all: `opts.commitSha` is always null (resolveHeadCommit honestly returns null), so the unconditional
     *  version of this check made independent-verification, and therefore the whole run contract, permanently
     *  unsatisfiable on such a project. `opts.noGit` is a real, independent probe of the CURRENT root (see
     *  check()'s `noGitAtRoot`) — never true just because a caller omitted commit_sha on a project that DOES
     *  have git, so a real project keeps the exact fail-closed behaviour below, unchanged. Binding still
     *  rests on subject_log_hash/prev_hash (the hash chain, checked above) and evidence_digest (checked
     *  below, itself now bound to a real file digest instead of a commit — see canonicalEvidenceDigest's D2
     *  fix) — a git-less review is not an UNVERIFIED review, only an unversioned one. */
    if (!opts.noGit) {
      if (!SHA1_RE.test(commitSha)) { return { ok: false, reden: 'commit_sha ontbreekt of is niet welgevormd — onbekend welke code beoordeeld is' }; }
      /** N-02 (post-fix herreview): een vormcontrole zonder vergelijking is geen binding — élke geldige
       *  40-hex waarde kwam erdoor. Nu FAIL-CLOSED: is de actuele HEAD niet vast te stellen, dan kan de
       *  commitbinding niet worden getoetst en telt de review niet. Liever geen verificatie dan een
       *  verificatie waarvan niemand weet waarop hij sloeg. */
      if (!opts.commitSha) { return { ok: false, reden: 'de actuele HEAD kon niet worden vastgesteld, dus commit_sha is niet te toetsen — fail-closed' }; }
      if (norm(commitSha) !== norm(opts.commitSha)) { return { ok: false, reden: 'beoordeelde commit ' + commitSha.slice(0, 12) + '… is niet de actuele commit ' + String(opts.commitSha).slice(0, 12) + '…' }; }
    } else if (opts.evidenceCommit) {
      /** D2 anti-fabrication guard — skipping the commit_sha check above must NEVER become a way to sneak a
       *  FAKE commit through. If this root genuinely has no git (opts.noGit) but the evidence set still
       *  claims a real commit (canonicalEvidenceDigest's git-bound branch, not its D2 no_git branch), that
       *  is a contradiction a real no-git measurement could never produce — either a stale evidence set from
       *  a different (git-having) root, or a hand-tampered gate-evidence.json. Refused, never trusted, even
       *  if the completion event's own commit_sha happens to match it (the exact shape that made this gap
       *  reproducible before this guard existed). */
      return { ok: false, reden: 'deze root heeft geen git-repository, maar de bewijsset claimt toch een commit (' + String(opts.evidenceCommit).slice(0, 12) + '…) — dat kan uit een eerlijke no-git-meting nooit komen, dus geweigerd in plaats van vertrouwd' };
    }
    if (!SHA256_RE.test(evidenceDigest)) { return { ok: false, reden: 'evidence_digest ontbreekt of is niet welgevormd — onbekend welke bewijsset beoordeeld is' }; }
    /** N-03: vorm is geen binding. Zonder herberekening voldeed élke 64-hex waarde en sloeg het oordeel
     *  nergens op. De digest wordt nu tegen de CANONIEKE bewijsset van deze run gelegd; ontbreekt die set,
     *  dan is er niets om aan te binden en telt de review niet — fail-closed, geen zachte route. */
    if (!opts.evidenceDigest) { return { ok: false, reden: 'er is geen bewijsset (gate-evidence.json) voor deze run, dus evidence_digest is nergens aan te binden — fail-closed' }; }
    // a review pinned before the D2 canonical-form change carries the OLDER form of the
    // SAME evidence — see canonicalEvidenceDigest's legacy_digests doc. Only well-formed hex counts.
    const legacyForms = (Array.isArray(opts.evidenceLegacyDigests) ? opts.evidenceLegacyDigests : []).filter((d) => typeof d === 'string' && SHA256_RE.test(d)).map(norm);
    if (norm(evidenceDigest) !== norm(opts.evidenceDigest) && !legacyForms.includes(norm(evidenceDigest))) { return { ok: false, reden: 'beoordeelde bewijsset ' + evidenceDigest.slice(0, 12) + '… is niet de actuele (' + String(opts.evidenceDigest).slice(0, 12) + '…) — het bewijs is sinds de review veranderd' }; }
    if (opts.evidenceAllGreen === false) { return { ok: false, reden: 'de bewijsset bevat gefaalde poort(en) (' + (opts.evidenceFailed || []).join(', ') + ') — een goedkeuring bovenop rood bewijs bevestigt niets' }; }
    /** R9-02 (negende herreview): de canonicalizer LEVERDE de gatecommit al, maar check() gaf hem niet
     *  door — dus niets vergeleek waarop het bewijs draaide met de commit die beoordeeld wordt. Een run
     *  kon zo groen zijn met bewijs van heel andere code. Zit de commit in de bewijsset, dan moet hij
     *  gelijk zijn aan de commit die deze review claimt te beoordelen. */
    if (opts.evidenceCommit && norm(opts.evidenceCommit) !== norm(commitSha)) { return { ok: false, reden: 'het bewijs draaide op commit ' + String(opts.evidenceCommit).slice(0, 12) + '… maar de review claimt commit ' + commitSha.slice(0, 12) + '… — bewijs en oordeel gaan over verschillende code' }; }
    if (lastWorkIndex > c.index) { return { ok: false, reden: 'er is NA deze review nog werk gelogd (' + (list[lastWorkIndex].event_type) + ') — de review is stale' }; }

    return {
      ok: true,
      review: { review_id: id, commit_sha: commitSha, subject_log_hash: subjectLogHash, evidence_digest: evidenceDigest },
      reviewer: c.agent,
      reden: 'review ' + id + ' afgerond door ' + c.agent + ' (deed zelf geen werk), gekoppeld aan zijn eigen start, gebonden aan commit ' + commitSha.slice(0, 12) + '… en runstaat ' + subjectLogHash.slice(0, 12) + '…, en niet stale',
    };
  }
  const beoordeeld = completions.map((c) => ({ c, res: valideerCompletion(c) }));
  const afgewezenRedenen = beoordeeld.filter((x) => !x.res.ok).map((x) => x.c.ev.event_type + '#' + (x.c.ev.review_id || 'zonder-review_id') + ': ' + x.res.reden);
  /** R9-07 (negende herreview) — REGRESSIE UIT MIJN EIGEN R8-02-FIX. Ik verankerde het oordeel aan de
   *  EERSTE geldige goedkeuring en blokkeerde daarna op elke latere ongeldige completion. Gevolg:
   *  `goedkeuring -> ongeldig -> verse start -> geldige goedkeuring` bleef rood, terwijl mijn eigen
   *  foutmelding letterlijk zegt "open een verse review". Een gate die de voorgeschreven herstelweg
   *  afsluit, dwingt geen kwaliteit af maar blokkeert werk.
   *  Nu telt de LAATSTE completion: die bepaalt de eindstand. Is die geldig, dan is de run geverifieerd;
   *  is die ongeldig of afkeurend, dan niet — ongeacht wat ervoor stond. Herstel is daarmee mogelijk
   *  zonder dat een oude goedkeuring een nieuwere afkeuring kan overstemmen. */
  const laatste = beoordeeld.length ? beoordeeld[beoordeeld.length - 1] : null;
  if (laatste && laatste.res.ok) {
    const c = laatste.c;
    return Object.assign({ ok: true, route: 'causal-review', reviewer: c.agent, review: laatste.res.review, reason: laatste.res.reden }, base);
  }
  if (laatste && beoordeeld.some((x) => x.res.ok)) {
    return Object.assign({ ok: false, route: null, reason: 'de LAATSTE review-completion is niet geldig (' + laatste.c.ev.event_type + ' door ' + (laatste.c.agent || '(naamloos)') + ': ' + laatste.res.reden + ') — een eerdere goedkeuring telt niet meer; sluit af met een geldige verse review' }, base);
  }
  return Object.assign({ ok: false, route: null, reason: 'geen bruikbare review-completion: ' + afgewezenRedenen.join(' | ') }, base);
}

/** missingCompletionReason(opts) — R1 (category tests 2026-11-07): the reason when a run has no review completion names
 *  only the fields THIS root requires (commit_sha only where git exists: opts.noGit is the real probe) and the exact
 *  one-line log command, never a shell chain. Known values (run id, HEAD, evidence digest) are filled in. */
function missingCompletionReason(opts) {
  const o = opts || {};
  const fields = ['review_id', 'review_verdict', 'subject_log_hash'].concat(o.noGit ? [] : ['commit_sha'], ['evidence_digest']);
  const payload = { agent: '<reviewer, did no work in this run>', review_id: '<the id of your review_started>', review_verdict: 'approved', subject_log_hash: '<entry_hash of the last event in events.jsonl>' };
  if (!o.noGit) payload.commit_sha = typeof o.commitSha === 'string' && SHA1_RE.test(o.commitSha) ? o.commitSha : '<git HEAD sha>';
  payload.evidence_digest = typeof o.evidenceDigest === 'string' && SHA256_RE.test(o.evidenceDigest) ? o.evidenceDigest : '<digest of gate-evidence.json>';
  const runId = typeof o.runId === 'string' && /^[A-Za-z0-9_.-]+$/.test(o.runId) ? o.runId : '<run_id>';
  return 'geen review-completion in deze run — verwacht ' + [...REVIEW_DONE_TYPES].join('/') + ' met ' + fields.slice(0, -1).join(', ') + ' en ' + fields[fields.length - 1]
    + (o.noGit ? ' (deze root heeft geen git-repository, dus geen commit om aan te binden)' : '')
    + ', gelogd door een agent die hier geen werk deed, na zijn eigen review_started met hetzelfde review_id. Eén regel: node .claude/forge-dashboard/log-event.cjs ' + runId + " review_completed '" + JSON.stringify(payload) + "'";
}

/** sanitizeIv — alleen wat een lezer nodig heeft om te begrijpen WAAROM, nooit ruwe eventpayloads:
 *  daar kan vrije tekst (paden, commando's, output) in staan die niet in een contractuitslag hoort. */
function sanitizeIv(iv) {
  const kort = (s) => String(s == null ? '' : s).slice(0, 400);
  return {
    ok: iv.ok === true, route: iv.route || null, workers: (iv.workers || []).slice(0, 20),
    reviewer: iv.reviewer || null, label_only: iv.label_only === true,
    review: iv.review ? {
      review_id: kort(iv.review.review_id),
      commit_sha: kort(iv.review.commit_sha),
      subject_log_hash: kort(iv.review.subject_log_hash),
      evidence_digest: kort(iv.review.evidence_digest),
    } : null,
    reason: String(iv.reason == null ? '' : iv.reason).slice(0, 1000), // room for the one-line log command
  };
}

/** resolveHeadCommit(root) / gitProbe(root) — see the full doc right above their implementation,
 *  further down this file (near knownAgentNames). gitProbe is the ONE shared, three-way git probe
 *  (2.1); resolveHeadCommit is its thin backward-compatible wrapper. */
/** realpathOf(p) — the resolved, canonical path (junctions, symlinks and 8.3 short names resolved). The native
 *  resolver is preferred (it follows Windows junctions the way the OS does); the JS one is the fallback. Throws
 *  like fs.realpathSync (ENOENT for a missing path). */
function realpathOf(p) {
  try { return fs.realpathSync.native(p); }
  catch (e) { if (e && e.code === 'ENOENT') throw e; return fs.realpathSync(p); }
}
/** rootRealpath(root) — the project root resolved the same way; a root that cannot be resolved falls back to its
 *  absolute path, so a resolved output can never be "inside" it by accident of formatting. */
function rootRealpath(root) {
  try { return realpathOf(root); } catch { return path.resolve(root); }
}
/** isInsideRoot(realRoot, resolved) — true when the resolved path lies within (or is) the resolved root. */
function isInsideRoot(realRoot, resolved) {
  const rel = path.relative(realRoot, resolved);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !rel.startsWith('../') && !path.isAbsolute(rel);
}
/** canonicalEvidenceDigest(root, runId) -> {digest, gates} of null.
 *
 *  N-03 (post-fix herreview 2026-08-09): `evidence_digest` werd alleen op VORM gecontroleerd — elke
 *  willekeurige 64-hex waarde voldeed, dus de review was aan geen enkel werkelijk bewijs gebonden. Een
 *  digest die niets samenvat is een placeholder, geen binding.
 *
 *  De canonieke vorm is bewust MINIMAAL en stabiel: per poort alleen `name`, `exit_code` en
 *  `output_sha256`, gesorteerd op naam. Timestamps, duur en paden horen er NIET in — die veranderen bij
 *  elke herhaling zonder dat het bewijs verandert, en zouden de digest onbruikbaar maken. Wat er wél in
 *  zit is precies wat een oordeel draagt: welke poort, of hij slaagde, en de hash van zijn uitvoer. */
function canonicalEvidenceDigest(root, runId) {
  const file = path.join(runDirOf(root, runId), 'gate-evidence.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const gates = Array.isArray(j && j.gates) ? j.gates : null;
  if (!gates || !gates.length) return null;
  /** R3-04 (derde herreview): zonder schemavalidatie leverde zelfs `{gates:[{}]}` een bruikbare digest —
   *  een betekenisloze bewijsset ging dan door voor exact gebonden bewijs. Elke poort moet een niet-lege
   *  UNIEKE naam, een integer exitcode en een welgevormde sha256 dragen; anders is er geen bewijsset en
   *  telt de review niet. Duplicaatnamen zijn expliciet fataal: die maken de sortering ambigu, waardoor
   *  dezelfde inhoud twee verschillende digests kan opleveren. */
  /** R6-05 (zesde herreview): de canonicalizer keek alleen naar naam, exitcode en een ZELFGERAPPORTEERDE
   *  output-hash. Een poort die is afgekapt (`timed_out`), nooit gestart (`spawn_error`) of waarvan de
   *  recorder de hash niet kon herverifiëren (`evidence_verified:false`) telde gewoon mee als bewijs. Ook
   *  het `run_id` in het manifest werd niet vergeleken, dus de bewijsset van een ANDERE run paste net zo
   *  goed. Al die gevallen zijn nu fataal: liever geen bewijsset dan een bewijsset die iets anders
   *  beschrijft dan wat er gedraaid heeft. */
  /** R7-06 (zevende herreview): `run_id` was OPTIONEEL, dus oud of cross-run bewijs kon worden hergebruikt
   *  door het veld simpelweg weg te laten. En de codepin die ik in het vorige blok toevoegde was voor de
   *  contractlogica puur decoratief: hij zat niet in de digest, dus dezelfde poorten op andere code gaven
   *  dezelfde digest. Beide zijn nu bindend: run_id verplicht en exact, en de commit per poort telt mee in
   *  de canonieke vorm — ander bewijs op andere code is dan ook een andere digest. */
  if (String(j.run_id || '') !== String(runId)) return null;
  const namen = new Set();
  const canon = [];
  const unverified = []; // gates whose raw output cannot be read back right now
  const realRoot = rootRealpath(root); // containment is judged on resolved paths
  for (const g of gates) {
    if (!g || typeof g !== 'object') return null;
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!name || namen.has(name)) return null;
    /** R10-03 (tiende herreview): een handgeschreven `noop`-poort ZONDER command en zonder outputbestand
     *  leverde een groene digest — de canonicalizer accepteerde elk zelfbenoemd record. Een poort zonder
     *  command is geen uitgevoerde poort, en een poort zonder outputverwijzing heeft geen verifieerbare
     *  uitvoer. Beide zijn nu verplicht. (Een volledige VERWACHTE gatecatalogus per domein hoort bij de
     *  Quality-laag / required-evidence-integratie — daar wordt afgedwongen WELKE poorten er moeten zijn;
     *  hier wordt afgedwongen dat elke aanwezige poort echt en verifieerbaar is.) */
    const heeftCommand = (typeof g.command === 'string' && g.command.trim() !== '')
      || (Array.isArray(g.argv) && g.argv.length > 0);
    if (!heeftCommand) return null;
    if (typeof g.output_file !== 'string' || g.output_file.trim() === '') return null;
    namen.add(name);
    if (!Number.isInteger(g.exit_code)) return null;
    if (g.timed_out === true) return null;              // afgekapt = geen uitslag
    if (g.spawn_error) return null;                     // nooit gedraaid = geen bewijs
    if (g.evidence_verified !== true) return null;      // alleen een EXPLICIET bevestigde hash telt
    const sha = typeof g.output_sha256 === 'string' ? g.output_sha256.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    /** `evidence_verified` is het woord van de RECORDER. Ligt de ruwe uitvoer er nog, dan
     *  controleert de poort dat zelf — een manifest dat niet meer bij zijn eigen bestanden past, is geen
     *  bewijs (null, zoals elke vervalsing).
     *  een output die NIET leesbaar is (gitignored, andere
     *  machine, nooit geschreven, pad buiten de root) maakte de poort voorheen stilzwijgend groen — een
     *  manifest met een nooit-uitgevoerd commando, een niet-bestaand outputbestand en exit_code:0 gaf
     *  allGreen:true. Nu is zo'n poort `unverified`: hij blijft in de digest (zodat een receipt het manifest
     *  nog exact kan matchen), maar de set is NIET groen en `verified` is false. Een completion eist
     *  leesbare, hash-geverifieerde uitvoer; een archiefcontrole op een machine zonder de ruwe uitvoer
     *  krijgt een eerlijk 'unverified', nooit een groen. */
    const outputRel = g.output_file.trim().replace(/\\/g, '/');
    if (!isSafeRelPath(outputRel)) return null; // een outputpad buiten de projectroot is geen bewijs
    /** isSafeRelPath() is SYNTACTIC — `gate-link/suite.txt` passes it even when
     *  `gate-link` is a junction/symlink to a folder outside the project, and the read then follows the link.
     *  Containment is now judged on the RESOLVED target: realpath of the output and of the root; a target that
     *  resolves outside the root is a tampered manifest (null, like every other forgery). A missing output stays
     *  'unavailable'. The hash is read from the resolved path itself. */
    let outputState = 'verified';
    try {
      const resolved = realpathOf(path.join(root, outputRel)); // throws ENOENT for a missing output -> unavailable
      if (!isInsideRoot(realRoot, resolved)) return null;
      const opSchijf = fs.readFileSync(resolved);
      if (crypto.createHash('sha256').update(opSchijf).digest('hex') !== sha) return null;
    } catch { outputState = 'unavailable'; }
    if (outputState !== 'verified') unverified.push(name);
    /** R8-03 (achtste herreview): `code.commit` werd wél aan de digest toegevoegd maar niet VERPLICHT of
     *  gevalideerd — probes leverden groene digests voor ontbrekende code, `commit:"not-a-sha"` en
     *  `worktree_clean:false`. Een codepin die je niet afdwingt, bindt niets. Een poort telt nu alleen mee
     *  met een stabiele meting, een welgevormde commit én een schone bron: bewijs dat op bewegende of
     *  ongecommitte code draaide, kan niet aan die code worden opgehangen. */
    const code = g.code;
    if (!code || typeof code !== 'object') return null;
    if (code.stable !== true) return null;
    /** D2 fix (fresh-laptop re-audit) — a project with NO git repository could never produce a
     *  usable evidence digest at all: forge-gate-evidence.cjs's gitState() honestly returns
     *  {available:false} for every gate, so `code.commit` was never a well-formed sha and this whole
     *  function returned null forever, which meant independent-verification (and therefore the run
     *  contract) could never pass for a genuinely git-less project. That is not a real security
     *  requirement — a commit sha binds evidence to a VERSION, and a project with no versioning concept has
     *  nothing to bind to. forge-gate-evidence.cjs's own `record()` now marks such a gate `code.no_git:true`
     *  with `commit:null` (never a fabricated commit) — this file accepts that shape as an ALTERNATE, honest
     *  binding: the gate's evidence rests on its own real output_sha256 (already required above) instead of
     *  a commit. A no-git gate must not ALSO claim a commit or a worktree state it cannot measure — either
     *  one present is a malformed record, not evidence. KNOWN, NAMED LIMITATION (never silently smoothed
     *  over): without git there is no way to detect that two gates in the same evidence set ran against
     *  DIFFERENT source states (the whole reason R8-03 below exists) — every no-git gate is tagged with the
     *  same opaque marker, so that specific cross-gate drift protection simply does not exist for a
     *  git-less project. */
    let codeRef;
    if (code.no_git === true) {
      if (code.commit != null || code.worktree_clean != null) return null; // a no-git record claiming a commit/worktree state is malformed, not evidence
      codeRef = 'no-git';
    } else {
      const commit = typeof code.commit === 'string' ? code.commit.trim().toLowerCase() : '';
      if (!/^[0-9a-f]{40}$/.test(commit)) return null;
      if (code.worktree_clean !== true) return null;
      codeRef = 'git:' + commit;
    }
    canon.push({
      name,
      /** the COMMAND that ran and the OUTPUT REFERENCE are bound into the digest too — before this, the
       *  same name/exit/hash under a different command or a different output path was the same digest. */
      command: typeof g.command === 'string' && g.command.trim() !== '' ? g.command.trim() : null,
      argv: Array.isArray(g.argv) && g.argv.length ? g.argv.map((a) => String(a)) : null,
      exit_code: g.exit_code, output_file: outputRel, output_sha256: sha, commit: codeRef,
    });
  }
  canon.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** R5-03 (vijfde herreview): de digest vatte ook een RODE bewijsset samen, en de evaluator keek alleen
   *  of hij matchte — een positieve review kon dus een run met een gefaalde poort bevestigen en
   *  finaliseren. De digest blijft bewust over ALLE poorten gaan (anders is hij geen eerlijke
   *  samenvatting van wat er gedraaid heeft), maar een completion eist daarnaast dat elke poort groen is. */
  const rood = canon.filter((g) => g.exit_code !== 0).map((g) => g.name);
  /** poorten die op VERSCHILLENDE commits (of een mix van git- en no-git-bewijs) draaiden vormen
   *  samen geen bewijs over één staat. */
  const refs = [...new Set(canon.map((g) => g.commit))];
  if (refs.length > 1) return null;
  const ref = refs[0] || null;
  const noGit = ref === 'no-git';
  const sha256Of = (c) => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
  // the run id is part of the digest — the same gates recorded under another run are another digest.
  const strictDigest = sha256Of({ run_id: String(runId), gates: canon });
  // the pre-F03 form (name/exit_code/output_sha256/'git:'-tagged commit, no run id, no command, no output ref)
  const preF03 = sha256Of(canon.map((g) => ({ name: g.name, exit_code: g.exit_code, output_sha256: g.output_sha256, commit: g.commit })));
  // the pre-D2 form (bare commit, rejected no-git outright)
  const preD2 = noGit ? null : sha256Of(canon.map((g) => ({ name: g.name, exit_code: g.exit_code, output_sha256: g.output_sha256, commit: g.commit.slice('git:'.length) })));
  return {
    digest: strictDigest, gates: canon.length,
    /** green requires EVERY gate exit 0 AND every output readable and hash-verified right now.
     *  `verified` says whether the outputs could be re-verified at all; `unverified` names the gates whose
     *  output is unavailable (never a tamper claim — a mismatching output returns null above). */
    allGreen: rood.length === 0 && unverified.length === 0, failed: rood,
    verified: unverified.length === 0, unverified,
    // D2: a no-git evidence set never reports a commit — null, never fabricated. A git-bound set strips
    // the internal 'git:' tag back off so callers keep seeing a bare 40-hex sha, exactly as before.
    commit: noGit ? null : (ref ? ref.slice('git:'.length) : null),
    no_git: noGit,
    /** Older canonical forms of the SAME validated gates, oldest first: [pre-D2 (git sets only), pre-F03].
     *  Accepted ONLY for receipts on the project's checked-in legacy-receipt allowlist (forge-finalize.cjs
     *  evaluateAcceptance) — never for a live run's review binding (check() passes [] unless the caller
     *  asks for them with opts.acceptLegacyEvidenceDigests, which only the allowlist path does). */
    legacy_digests: (preD2 ? [preD2] : []).concat([preF03]),
  };
}
/** legacy_digests (2026-10-09, — MEASURED, not assumed; F03 on
 *  2026-10-10 appended the pre-F03 form as the second entry when the strict form began binding run id, command
 *  and output reference — the 10 evidence-bearing real receipts pin that pre-F03 form and are allowlisted):
 *  the D2 fix above changed the canonical form from `commit:'<sha>'` to `commit:'git:<sha>'`. Every receipt
 *  and every review event that pinned an evidence digest BEFORE that change therefore stopped matching
 *  although the gate-evidence.json bytes never changed: on 2026-10-09 three real receipts
 * read as
 *  "evidence changed after finalization" — a false tamper accusation. Proof: the forge-runcontract.cjs from
 *  each receipt's own commit reproduces its pinned digest exactly over the unchanged file. `legacy_digests`
 *  holds every OLDER canonical form this checker can still reproduce from the SAME validated gates (only the
 *  pre-D2 form today; never for a no-git set, which that form rejected). A match on a legacy form binds the
 *  identical name/exit_code/output_sha256/commit content, so accepting it weakens no binding.
 *  RULE FOR THE NEXT CHANGE: any change to the canonical form MUST append the previous form here, or every
 *  receipt pinned before it reads as tampered. The golden test in forge-runcontract.test.cjs pins both forms
 *  for a fixed fixture so an accidental change fails loudly. */

/** knownAgentNames(root) -> Set van gecanonicaliseerde, BEKENDE agentnamen (registry + .claude/agents/*.md
 *  + de generieke rollen), of null wanneer er geen registry te lezen is. null betekent fail-closed bij de
 *  aanroeper — niet 'dan maar iedereen toestaan'. */
function knownAgentNames(root) {
  const namen = new Set(['lead', 'boss', 'orchestrator', 'system', 'forge-router', 'main', 'codex']);
  let uitRegistry = 0;
  try {
    const raw = fs.readFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), 'utf8');
    for (const m of raw.matchAll(/"(?:name|id)"\s*:\s*"([^"]+)"/g)) { namen.add(m[1].trim().toLowerCase()); uitRegistry++; }
  } catch { return null; }
  if (!uitRegistry) return null;
  try {
    for (const f of fs.readdirSync(path.join(root, '.claude', 'agents'))) {
      if (f.endsWith('.md')) { const n = f.replace(/\.md$/, '').toLowerCase(); namen.add(n); namen.add(n.replace(/-/g, ' ')); }
    }
  } catch { /* geen agents-map is geen fout: de registry is de bron */ }
  return namen;
}

/** cleanGitEnv() -> a copy of process.env with every variable that could redirect git AWAY from the
 *  real repository at `-C root` stripped: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *  GIT_CEILING_DIRECTORIES, and any GIT_CONFIG* variable (GIT_CONFIG_COUNT/KEY_n/VALUE_n/GLOBAL/SYSTEM/
 *  NOSYSTEM/...). (2.1, 2026-09-26 laptop re-audit): before this fix a caller could prefix
 *  `GIT_DIR=<nonexistent>` (or a GIT_CEILING_DIRECTORIES above root) to a Forge tool invocation and make a
 *  project that DOES have git look exactly like one that has none — every no-git relaxation in this file
 *  trusted that false signal. Every git spawn in this module goes through this env, so the probe below can
 *  never be fooled by the calling process's own environment.
 *
 *  N4 fix (2026-09-26 independent review, LOW): gitProbe()'s `zegtNietEenRepo` check below matches git's
 *  "not a git repository" message literally — but that message is TRANSLATED by locale (LC_ALL/LANG) or
 *  LANGUAGE. Under a non-English locale a truly git-less project would get git's message in another
 *  language, the regex would miss it, and the root would read as 'undetermined' instead of the correctly
 *  relaxed 'no-repo' — fails closed (never silently wrong), but quietly undoes the D2 no-git relaxation
 *  this file exists for. Force English output from every git call fed this env, regardless of what the
 *  parent process's own locale carries: LC_ALL/LANG win over every other locale category, LANGUAGE (glibc's
 *  own priority-ordered override list) is removed so it can never re-introduce a translation underneath. */
function cleanGitEnv() {
  const env = Object.assign({}, process.env);
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE; delete env.GIT_CEILING_DIRECTORIES;
  for (const k of Object.keys(env)) { if (k.indexOf('GIT_CONFIG') === 0) delete env[k]; }
  env.LC_ALL = 'C';
  env.LANG = 'C';
  delete env.LANGUAGE;
  return env;
}

/** hasGitEntryInAncestry(root) -> true when a `.git` entry (file OR directory — a worktree's `.git` is a
 *  FILE, a normal repo's is a directory; both count) exists at `root` or any parent, up to the filesystem
 *  root. A pure filesystem check, independent of git's own exit code/stderr — the second, independent leg
 *  `gitProbe()` requires before it will ever call a root "no-repo" (see its doc). */
function hasGitEntryInAncestry(root) {
  let dir = path.resolve(root);
  for (;;) {
    try { fs.lstatSync(path.join(dir, '.git')); return true; } catch { /* geen .git hier — verder omhoog */ }
    const parent = path.dirname(dir);
    if (parent === dir) return false; // filesystem-root bereikt zonder ooit een .git te vinden
    dir = parent;
  }
}

/** gitProbe(root) -> ONE shared, honest, THREE-WAY probe of a root's git state (2.1, 2026-09-26
 *  laptop re-audit, review C VERDICT FAIL). Before this fix, `resolveHeadCommit` returned `null` for
 *  BOTH "definitely no git repository" and "git exists but refused/failed/timed out for some other
 *  reason" (dubious ownership, a repo with no commits yet, a poisoned env, ENOENT). Every no-git
 *  relaxation in this file (and in forge-gate-evidence.cjs / forge-finalize.cjs) trusted that single
 *  `null` as a confirmed "no git here" — so a repo that merely refused (Windows "dubious ownership" is
 *  the common case) could be walked straight through the relaxed path meant ONLY for a genuinely
 *  git-less project. `resolveHeadCommit`, `gitState` (forge-gate-evidence.cjs) and `headProbeOf`
 *  (forge-finalize.cjs) now ALL call into this ONE function so they can never independently disagree
 *  about the same root again.
 *
 *  Returns exactly one of:
 *   {state:'repo', commit:'<40-hex>'}   — a REAL commit was resolved. The only state a caller may bind
 *                                         gate evidence to a source commit under.
 *   {state:'no-repo'}                   — POSITIVELY confirmed, on BOTH independent legs: (1) git itself
 *                                         (run with the poisoning-resistant env below) says "not a git
 *                                         repository", AND (2) no `.git` entry exists anywhere from
 *                                         `root` up to the filesystem root. Only THIS state may relax a
 *                                         commit-binding requirement — and even then the binding is
 *                                         honestly to the gate's OWN output digest, never to a source-tree
 *                                         digest (no source-tree digest exists here; see the no_git
 *                                         branches in forge-gate-evidence.cjs / canonicalEvidenceDigest).
 *   {state:'undetermined', reason}      — git is missing (ENOENT), timed out, was killed by a signal,
 *                                         refused for a reason OTHER than "not a git repository"
 *                                         (dubious ownership / safe.directory, permission), returned a
 *                                         malformed HEAD, OR the filesystem check found a `.git` entry
 *                                         despite git's own "not a git repository" error (an inconsistent
 *                                         signal — never trusted). MUST be treated exactly like a real git
 *                                         failure by every caller — fail-closed, same as before the D2 fix
 *                                         existed. Never, ever treated as 'no-repo'. */
function gitProbe(root) {
  if (typeof root !== 'string' || !root) throw new TypeError('gitProbe: root moet een pad zijn, kreeg ' + typeof root);
  const { spawnSync } = require('child_process'); // lazy: een kale check() blijft puur
  let g;
  try {
    g = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000, env: cleanGitEnv() });
  } catch (e) {
    // git zelf is niet uitvoerbaar (ENOENT) of de spawn faalde anderszins — dat is per definitie ONBESLIST,
    // nooit stilzwijgend 'no-repo': er is helemaal niets gemeten.
    return { state: 'undetermined', reason: 'git niet uitvoerbaar: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!g) return { state: 'undetermined', reason: 'git-aanroep leverde geen resultaat' };
  if (g.error) return { state: 'undetermined', reason: 'git-aanroep faalde: ' + (g.error.message || String(g.error)) };
  if (g.signal) return { state: 'undetermined', reason: 'git-aanroep werd afgebroken door signaal ' + g.signal + ' (timeout of externe kill) — geen betrouwbare meting' };
  if (g.status === 0) {
    const s = String(g.stdout || '').trim();
    if (/^[0-9a-f]{40}$/i.test(s)) return { state: 'repo', commit: s.toLowerCase() };
    return { state: 'undetermined', reason: 'git gaf exit 0 maar geen welgevormde 40-hex HEAD terug (' + JSON.stringify(s.slice(0, 80)) + ')' };
  }
  const stderr = String(g.stderr || '');
  const zegtNietEenRepo = /not a git repository/i.test(stderr);
  if (zegtNietEenRepo && !hasGitEntryInAncestry(root)) return { state: 'no-repo' };
  if (zegtNietEenRepo) {
    // git zegt "not a git repository", maar er ligt WEL een .git-item hoger in de boom — een inconsistent
    // signaal (bv. GIT_DISCOVERY_ACROSS_FILESYSTEM, een kapotte .git, of een permissiemuur). Nooit
    // vertrouwd als bevestigd geen-git: er ligt duidelijk iets, we konden het alleen niet eerlijk lezen.
    return { state: 'undetermined', reason: 'git meldt "not a git repository", maar er is wél een .git-item boven ' + root + ' — inconsistent signaal, niet vertrouwd als bevestigd geen-git' };
  }
  // Elke andere weigering (dubious ownership/safe.directory, een repo zonder commits nog
  // ("does not have any commits yet"), permissiefouten, ...) is git dat WEL een repository ziet maar
  // niet kan/wil antwoorden — dat is onbeslist, nooit een bevestiging van geen-git.
  return { state: 'undetermined', reason: 'git weigerde (exit ' + g.status + '): ' + stderr.trim().slice(0, 300) };
}

/** resolveHeadCommit(root) -> 40-hex sha of null. A thin, backward-compatible wrapper over gitProbe():
 *  null now covers BOTH 'no-repo' and 'undetermined' — exactly as intended for a caller that only wants
 *  "a commit if there is one to bind to". Any caller that needs to tell "confirmed no git" apart from
 *  "could not determine" (the whole point of the 2.1 fix) MUST call gitProbe() directly instead — see
 *  check()'s own `noGitAtRoot` and forge-finalize.cjs's `headProbeOf` for the two real examples.
 *
 *  GEMETEN FOUT (post-fix herreview 2026-08-09, N-02): de eerste versie stond inline in de CLI en
 *  verwees naar een variabele `root` die daar niet bestaat. Dat gooide een ReferenceError, die door de
 *  eigen `catch {}` STIL werd opgeslokt — commitSha bleef null en de HEAD-vergelijking heeft nooit
 *  gedraaid, terwijl ik hem als werkend rapporteerde. Twee lessen, hier vastgelegd: (1) een catch die
 *  een programmeerfout niet onderscheidt van een verwachte omgevingsfout maakt een bug onzichtbaar;
 *  (2) een pad dat alleen in productie loopt heeft een eigen test nodig. Daarom is dit nu een
 *  geëxporteerde functie met een expliciete parameter, en gooit een ReferenceError/TypeError door
 *  in plaats van te verdwijnen. */
function resolveHeadCommit(root) {
  const p = gitProbe(root);
  return p.state === 'repo' ? p.commit : null;
}

// =====================================================================================================
// V2 CHECK TYPES (part A, 2026-10-09 —, audit findings
// T1-T6/T10/T12 + proposal P1). The four lifecycle obligations event-present could not express:
//
//   closure      {open, close, key, close_where?, skip_rule?, distinct_agent?, worker_exclude?}
//                Every OPEN event must be followed by a LATER, unconsumed CLOSE event with the same key
//                (1:1 — one close answers one open). `key` is a field name or a priority list of field names:
//                an open and a close are compared on the FIRST listed field BOTH carry; equal value = match,
//                different value = no match (never a fall-through to the next field). An open carrying none
//                of the key fields cannot be proven closed and is reported as such. `skip_rule` lets a
//                structured owner_override {rule:<skip_rule>, <key field>:<value>, reason, by:<owner>} close
//                one named item (same owner provenance as every override here). `distinct_agent:true` demands
//                that the closing event's agent/verifier did NO work on that item (no self-verification).
//   sequence     {before, after}
//                Every BEFORE item must occur before the FIRST `after` event. `before` is one item or a list
//                of items; an item is an event type, a nested list of types (any-of), or {event, where}.
//                No `after` event yet = nothing to order = vacuously satisfied.
//   reaction     {on, require, key?, on_where?, require_where?, count?, forbid_unprompted?}
//                count 'at-least-one' (default): every trigger is followed by a reaction (same key, when a
//                key is set). count 'exactly-one': per key, exactly one reaction after the first trigger.
//                forbid_unprompted:true: a reaction with no earlier matching trigger is a violation too
//                (e.g. an escalation chosen up front). An owner_override used as a reaction must carry a real
//                reason and a configured owner `by`, like every other override.
//   file-touched {files, mode?, alt_event?, baseline_field?}
//                Each project-relative file's sha256 now must differ from the one recorded on the run's
//                run_started event (field `file_hashes` by default — see snapshotFileHashes()). When no
//                baseline was recorded, an `alt_event` (e.g. memory_updated) that NAMES the file counts; when
//                a baseline exists the hash decides alone (an event claiming an update the hash disproves
//                does not count). mode 'all' (default) or 'any'.
//
// Every evaluator is a PURE projection of the run's events (plus, for file-touched, the current file bytes),
// skips claims the writer's content oracle disproved (eventIsDisproven), never throws (an internal error is a
// failed check with the error as reason, never a pass), and returns a detail object that check() reports in
// rule_details so a warning says WHAT is open, not only that something is.
// =====================================================================================================
const REACTION_COUNTS = new Set(['at-least-one', 'exactly-one']);
const FILE_TOUCHED_MODES = new Set(['all', 'any']);
const FILE_HASHES_FIELD = 'file_hashes';
// fields an alt_event may use to name a file (memory_updated really carries files_changed/evidence today)
const FILE_NAMING_FIELDS = ['files', 'files_changed', 'file', 'path', 'paths', 'evidence'];
const AGENT_ID_FIELDS = ['agent', 'verifier'];
const MAX_DETAIL_ITEMS = 20;

/** sinceMs(since) -> epoch ms of a valid ISO date/date-time (a bare date is midnight UTC), else null. */
function sinceMs(since) {
  if (typeof since !== 'string' || !SINCE_RE.test(since)) return null;
  const ms = Date.parse(since.length === 10 ? since + 'T00:00:00Z' : since);
  return Number.isFinite(ms) ? ms : null;
}
/** phaseRankOf(phase) -> 0..2. Absent = 'complete'; a well-formed phase this checker does not know is also
 *  judged as 'complete' (only a full check judges it) — never a crash on newer vocabulary. */
function phaseRankOf(phase) {
  return Object.prototype.hasOwnProperty.call(PHASE_RANK, phase) ? PHASE_RANK[phase] : PHASE_RANK.complete;
}
function isEventSpec(v) {
  if (typeof v === 'string') return v.trim().length > 0;
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim().length > 0);
}
function isWhere(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const scalar = (x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
  return keys.length > 0 && keys.every((k) => scalar(v[k]) || (Array.isArray(v[k]) && v[k].length > 0 && v[k].every(scalar)));
}
function isSequenceItem(v) {
  if (isEventSpec(v)) return true;
  return !!v && typeof v === 'object' && !Array.isArray(v) && isEventSpec(v.event) && (v.where === undefined || isWhere(v.where));
}
/** isSafeRelPath(p) — a project-relative path only: no absolute/drive/UNC path, no '.'/'..' or empty segment,
 *  no NUL. file-touched reads these under the root, so this is a containment boundary, not a style rule. */
function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p.trim() || p !== p.trim() || p.includes('\0')) return false;
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || /^[\\/]/.test(p)) return false;
  return p.split(/[\\/]/).every((s) => s !== '' && s !== '.' && s !== '..');
}
function normRel(p) { return String(p).replace(/\\/g, '/').trim().toLowerCase(); }

/** validateV2Check(rule, rulesPath) -> null (valid) | {reason} (well-formed, but an option value this checker
 *  does not know: degrade like an unknown check type). Throws on a structurally broken shape. */
function validateV2Check(r, p) {
  const c = r.check;
  const bad = (what) => { throw new Error('forge-runcontract: rule "' + r.id + '" (check.type ' + c.type + ') ' + what + ' in ' + p); };
  const optBool = (k) => { if (c[k] !== undefined && typeof c[k] !== 'boolean') bad('has a non-boolean "' + k + '"'); };
  const optWhere = (k) => { if (c[k] !== undefined && !isWhere(c[k])) bad('has an invalid "' + k + '" (must be {field: value | [values]})'); };
  const enumOpt = (k, known) => {
    if (c[k] === undefined) return null;
    if (typeof c[k] !== 'string' || !CHECK_TYPE_SHAPE_RE.test(c[k])) bad('has an invalid "' + k + '" ' + JSON.stringify(c[k]));
    return known.has(c[k]) ? null : { reason: 'unknown ' + c.type + ' ' + k + ' "' + c[k] + '" (this checker knows: ' + [...known].join(', ') + ')' };
  };
  if (c.type === 'closure') {
    if (!isEventSpec(c.open)) bad('needs "open": an event type or a non-empty list of event types');
    if (!isEventSpec(c.close)) bad('needs "close": an event type or a non-empty list of event types');
    if (!isEventSpec(c.key)) bad('needs "key": a field name or a non-empty priority list of field names');
    optWhere('close_where');
    optBool('distinct_agent');
    if (c.skip_rule !== undefined && !(typeof c.skip_rule === 'string' && c.skip_rule.trim())) bad('has an invalid "skip_rule"');
    if (c.worker_exclude !== undefined && !isEventSpec(c.worker_exclude)) bad('has an invalid "worker_exclude"');
    return null;
  }
  if (c.type === 'sequence') {
    const items = Array.isArray(c.before) ? c.before : [c.before];
    if (c.before === undefined || !items.length || !items.every(isSequenceItem)) bad('needs "before": an item or a list of items (event type | [any-of types] | {event, where})');
    if (!isEventSpec(c.after)) bad('needs "after": an event type or a non-empty list of event types');
    return null;
  }
  if (c.type === 'reaction') {
    if (!isEventSpec(c.on)) bad('needs "on": an event type or a non-empty list of event types');
    if (!isEventSpec(c.require)) bad('needs "require": an event type or a non-empty list of event types');
    if (c.key !== undefined && !isEventSpec(c.key)) bad('has an invalid "key"');
    optWhere('on_where'); optWhere('require_where'); optBool('forbid_unprompted');
    return enumOpt('count', REACTION_COUNTS);
  }
  if (c.type === 'file-touched') {
    if (!Array.isArray(c.files) || !c.files.length || !c.files.every(isSafeRelPath)) bad('needs "files": a non-empty list of project-relative paths (no absolute path, no "." or ".." segment)');
    if (c.alt_event !== undefined && !isEventSpec(c.alt_event)) bad('has an invalid "alt_event"');
    if (c.baseline_field !== undefined && !(typeof c.baseline_field === 'string' && c.baseline_field.trim())) bad('has an invalid "baseline_field"');
    return enumOpt('mode', FILE_TOUCHED_MODES);
  }
  return null;
}

function typeOf(e) { return e && typeof e === 'object' && typeof e.event_type === 'string' ? e.event_type.toLowerCase() : ''; }
function specTypes(spec) { return toArray(spec).map((t) => String(t).trim().toLowerCase()).filter(Boolean); }
function normVal(v) { return String(v).trim().toLowerCase(); }
/** normAgent — the same agent written as "Build Boss", "build-boss" or "build_boss" is one agent. */
function normAgent(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' '); }
function normKey(field, v) { return AGENT_ID_FIELDS.includes(field) ? normAgent(v) : normVal(v); }
/** fieldValue(e, f) -> a non-empty scalar as string, else null (objects/arrays never act as a key). */
function fieldValue(e, f) {
  if (!e || typeof e !== 'object') return null;
  const v = e[f];
  if (typeof v === 'string') return v.trim() ? v.trim() : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
function firstKey(e, fields) {
  for (const f of fields) { const v = fieldValue(e, f); if (v !== null) return { f, v }; }
  return null;
}
/** commonKeyMatch(a, b, fields) -> true|false on the FIRST field both carry, null when they share none. */
function commonKeyMatch(a, b, fields) {
  for (const f of fields) {
    const va = fieldValue(a, f), vb = fieldValue(b, f);
    if (va !== null && vb !== null) return normKey(f, va) === normKey(f, vb);
  }
  return null;
}
function whereMatches(e, where) {
  if (!where) return true;
  for (const f of Object.keys(where)) {
    const v = e ? e[f] : undefined;
    if (v === undefined || v === null || typeof v === 'object') return false;
    if (!toArray(where[f]).map(normVal).includes(normVal(v))) return false;
  }
  return true;
}
/** collect(events, spec, where) -> [{e, i}] — matching, NOT-disproven events in log order. */
function collect(events, spec, where) {
  const types = new Set(specTypes(spec));
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (types.has(typeOf(e)) && !eventIsDisproven(e) && whereMatches(e, where)) out.push({ e, i });
  }
  return out;
}
function fmtKey(k) { return k ? k.f + '=' + k.v : '(no key)'; }
function whereLabel(where) { return where ? ' matching ' + JSON.stringify(where) : ''; }
/** isValidOwnerAct(e, allowlist) — an owner_override used as a REACTION/skip needs the same provenance an
 *  override of a contract rule needs: a configured owner `by` and a real (non-bare-token) reason. */
function isValidOwnerAct(e, ownerAllowlist) {
  const by = typeof e.by === 'string' ? e.by.trim().toLowerCase() : '';
  if (!by || !(ownerAllowlist instanceof Set) || !ownerAllowlist.has(by)) return false;
  return isMeaningfulReason(e.reason, typeof e.rule === 'string' && e.rule.trim() ? e.rule.trim() : 'owner-override');
}
/** findKeyedOwnerSkip — the generic form of findManifestSkip(): an owner_override whose `rule` EXACT-matches
 *  skipRule and whose `field` equals the open item's value, with valid owner provenance. */
function findKeyedOwnerSkip(events, skipRule, field, value, ownerAllowlist) {
  for (const e of events) {
    if (typeOf(e) !== 'owner_override' || e.rule !== skipRule) continue;
    const v = fieldValue(e, field);
    if (v === null || normKey(field, v) !== normKey(field, value)) continue;
    if (isValidOwnerAct(e, ownerAllowlist)) return { reason: String(e.reason).trim(), by: String(e.by).trim() };
  }
  return null;
}

/** selfCloseReason — distinct_agent: the closing event must be attributed (agent/verifier) and none of its
 *  identities may have done WORK on the same item (same key). Work = isWorkEvent() (the inverted taxonomy:
 *  unknown types count as work, the strict direction), minus bare plan assignments, minus the close types
 *  themselves and any `worker_exclude` types (bookkeeping such as route_assigned). The open event's own
 *  agent is always a worker. */
/** ASSIGNEE_FIELDS — on a plan/dispatch event, who the item is assigned to (besides `agent`). */
const ASSIGNEE_FIELDS = ['agent', 'assigned_to', 'assignee', 'to', 'target', 'owner_agent'];
function selfCloseReason(c, ctx, open, close, fields) {
  const closer = AGENT_ID_FIELDS.map((f) => fieldValue(close.e, f)).filter((v) => v !== null).map(normAgent);
  if (!closer.length) return 'the closing ' + typeOf(close.e) + ' #' + close.i + ' names no agent/verifier — an unattributed verification proves no second party';
  const skip = new Set([...specTypes(c.close), ...specTypes(c.worker_exclude || [])]);
  const workers = new Set();
  const openAgent = fieldValue(open.e, 'agent');
  if (openAgent) workers.add(normAgent(openAgent));
  /** worker membership is resolved from the item's
   *  ASSIGNMENTS and DISPATCHES too, not only from keyed work events:
   *   - an agent_work_package_created / dispatch for the same key names its assignee(s) (agent, assigned_to,
   *     assignee, to, target) — the assignee of the package is a worker on it, even if it never logged a
   *     keyed work event itself;
   *   - a dispatch WITHOUT the key is linked to the item through its dispatch_id when any keyed event of the
   *     item carries that dispatch_id (a Build Boss dispatched without wp_id whose subagent_completed carries
   *     wp_id + dispatch_id is a worker on that wp_id). */
  const itemDispatchIds = new Set();
  for (const x of ctx.events) {
    if (commonKeyMatch(open.e, x, fields) !== true) continue;
    const d = fieldValue(x, 'dispatch_id');
    if (d) itemDispatchIds.add(normVal(d));
  }
  for (const x of ctx.events) {
    const t = typeOf(x);
    if (!t || skip.has(t)) continue;
    const sameItem = commonKeyMatch(open.e, x, fields) === true;
    const viaDispatch = !sameItem && itemDispatchIds.size > 0 && fieldValue(x, 'dispatch_id') !== null && itemDispatchIds.has(normVal(fieldValue(x, 'dispatch_id')));
    if (!sameItem && !viaDispatch) continue;
    if (ASSIGNMENT_EVENT_TYPES.has(t) || IV_DISPATCH_TYPES.has(t)) {
      for (const f of ASSIGNEE_FIELDS) { const a = fieldValue(x, f); if (a) workers.add(normAgent(a)); }
      continue;
    }
    if (!isWorkEvent(x)) continue;
    const a = fieldValue(x, 'agent');
    if (a) workers.add(normAgent(a));
  }
  const self = closer.filter((a) => workers.has(a));
  if (self.length) return 'self-verification: ' + self.join(', ') + ' did work on this item (' + typeOf(close.e) + ' #' + close.i + ')';
  /** work the closer logged WITHOUT any item key cannot be attributed to an item — so it cannot be
   *  shown NOT to be work on this one. Unresolved attribution = independence not proven (fail-closed).
   *  this pass only read `agent` and skipped package events entirely, so an UNKEYED
   *  package or work dispatch that named the closer as assignee (assigned_to / assignee / to / target /
   *  owner_agent) went unseen. On package and dispatch types every ASSIGNEE_FIELDS value now counts; a pure
   *  review package/dispatch (isReviewDispatch) is not work and still never disqualifies a verifier. */
  const unattributed = [];
  for (let xi = 0; xi < ctx.events.length; xi++) {
    const x = ctx.events[xi];
    const t = typeOf(x);
    if (!t || skip.has(t)) continue;
    if (firstKey(x, fields)) continue; // keyed: already judged above
    const isAssignment = ASSIGNMENT_EVENT_TYPES.has(t) || IV_DISPATCH_TYPES.has(t);
    if (isAssignment) {
      if (isReviewDispatch(x)) continue; // a review-only package/dispatch is not work
      const viaDispatch = itemDispatchIds.size > 0 && fieldValue(x, 'dispatch_id') !== null && itemDispatchIds.has(normVal(fieldValue(x, 'dispatch_id')));
      if (viaDispatch) continue; // linked to THIS item through its dispatch_id: already judged above
      const names = ASSIGNEE_FIELDS.map((f) => fieldValue(x, f)).filter((v) => v !== null).map(normAgent);
      if (names.some((nm) => closer.includes(nm))) unattributed.push(t + ' #' + xi);
      continue;
    }
    if (!isWorkEvent(x)) continue;
    const a = fieldValue(x, 'agent');
    if (a && closer.includes(normAgent(a))) unattributed.push(t + ' #' + xi);
  }
  if (unattributed.length) return 'unresolved attribution: ' + closer.join(', ') + ' logged work without a ' + fields.join('/') + ' (' + unattributed.slice(0, 3).join(', ') + (unattributed.length > 3 ? ', …' : '') + ') — it cannot be shown to be work on another item, so independence is not proven (' + typeOf(close.e) + ' #' + close.i + ')';
  return null;
}

function evaluateClosure(c, ctx) {
  const fields = toArray(c.key).map(String);
  const opens = collect(ctx.events, c.open);
  const closes = collect(ctx.events, c.close, c.close_where);
  const consumed = new Set();
  const unclosed = [];
  const rejected = new Map();
  let matched = 0, skipped = 0, unkeyed = 0;
  for (const o of opens) {
    const k = firstKey(o.e, fields);
    if (!k) {
      unkeyed++;
      unclosed.push({ index: o.i, event_type: typeOf(o.e), key: null, reason: 'carries no ' + fields.join('/') + ' — it cannot be matched to a closing event' });
      continue;
    }
    let hit = null;
    for (const cl of closes) {
      if (cl.i <= o.i || consumed.has(cl.i) || commonKeyMatch(o.e, cl.e, fields) !== true) continue;
      if (c.distinct_agent === true) {
        const why = selfCloseReason(c, ctx, o, cl, fields);
        if (why) { rejected.set(cl.i, why); continue; }
      }
      hit = cl; break;
    }
    if (hit) { consumed.add(hit.i); matched++; continue; }
    if (c.skip_rule && findKeyedOwnerSkip(ctx.events, c.skip_rule, k.f, k.v, ctx.ownerAllowlist)) { skipped++; continue; }
    unclosed.push({ index: o.i, event_type: typeOf(o.e), key: fmtKey(k), reason: 'no later ' + specTypes(c.close).join('/') + ' with the same ' + k.f + whereLabel(c.close_where) + (c.distinct_agent ? ' from an agent that did no work on it' : '') });
  }
  const opened = opens.length;
  const ok = unclosed.length === 0;
  return {
    ok, vacuous: opened === 0, opened, matched, owner_skipped: skipped, unkeyed,
    unclosed_count: unclosed.length, unclosed: unclosed.slice(0, MAX_DETAIL_ITEMS),
    rejected_closes: [...rejected.entries()].slice(0, MAX_DETAIL_ITEMS).map(([index, reason]) => ({ index, reason })),
    reason: opened === 0 ? 'no ' + specTypes(c.open).join('/') + ' in this run — nothing to close (vacuously satisfied)'
      : ok ? 'all ' + opened + ' closed (' + matched + ' matched' + (skipped ? ', ' + skipped + ' owner-skipped' : '') + ')'
        : unclosed.length + ' of ' + opened + ' ' + specTypes(c.open).join('/') + ' not closed: ' + unclosed.slice(0, 5).map((u) => (u.key || '#' + u.index)).join(', ') + (unclosed.length > 5 ? ', …' : '') + (unkeyed ? ' (' + unkeyed + ' without ' + fields.join('/') + ')' : ''),
  };
}

function normalizeSeqItem(it) {
  if (typeof it === 'string' || Array.isArray(it)) return { types: specTypes(it), where: null };
  return { types: specTypes(it.event), where: it.where || null };
}
function evaluateSequence(c, ctx) {
  const afterTypes = new Set(specTypes(c.after));
  let firstAfter = -1;
  for (let i = 0; i < ctx.events.length; i++) {
    if (afterTypes.has(typeOf(ctx.events[i])) && !eventIsDisproven(ctx.events[i])) { firstAfter = i; break; }
  }
  const items = (Array.isArray(c.before) ? c.before : [c.before]).map(normalizeSeqItem);
  const label = (it) => it.types.join('|') + whereLabel(it.where);
  if (firstAfter === -1) {
    return { ok: true, vacuous: true, required_before: items.map(label), reason: 'no ' + [...afterTypes].join('/') + ' yet — nothing to order (vacuously satisfied)' };
  }
  const head = ctx.events.slice(0, firstAfter);
  const missingBefore = items.filter((it) => !head.some((e) => it.types.includes(typeOf(e)) && !eventIsDisproven(e) && whereMatches(e, it.where))).map(label);
  const firstType = typeOf(ctx.events[firstAfter]);
  return {
    ok: missingBefore.length === 0, vacuous: false, first_after: { index: firstAfter, event_type: firstType },
    required_before: items.map(label), missing_before: missingBefore,
    reason: missingBefore.length ? 'before the first ' + firstType + ' (#' + firstAfter + ') this run never logged: ' + missingBefore.join('; ')
      : 'every required event precedes the first ' + firstType + ' (#' + firstAfter + ')',
  };
}

function evaluateReaction(c, ctx) {
  const fields = c.key === undefined ? null : toArray(c.key).map(String);
  const onTypes = specTypes(c.on), reqTypes = specTypes(c.require);
  const triggers = collect(ctx.events, c.on, c.on_where);
  const reactions = collect(ctx.events, c.require, c.require_where)
    .filter((r) => typeOf(r.e) !== 'owner_override' || isValidOwnerAct(r.e, ctx.ownerAllowlist));
  const sameGroup = (a, b) => (fields ? commonKeyMatch(a.e, b.e, fields) === true : true);
  const count = c.count || 'at-least-one';
  const violations = [];
  const noKey = (x) => ({ index: x.i, key: null, reason: typeOf(x.e) + ' #' + x.i + ' carries no ' + fields.join('/') + ' — it cannot be paired' });
  if (count === 'exactly-one') {
    const firstPerGroup = [];
    for (const t of triggers) {
      if (fields && !firstKey(t.e, fields)) { violations.push(noKey(t)); continue; }
      if (!firstPerGroup.some((g) => sameGroup(g, t))) firstPerGroup.push(t);
    }
    for (const first of firstPerGroup) {
      const n = reactions.filter((r) => r.i > first.i && sameGroup(first, r)).length;
      const k = fields ? fmtKey(firstKey(first.e, fields)) : '(run)';
      if (n === 0) violations.push({ index: first.i, key: k, reason: 'no ' + reqTypes.join('/') + ' after ' + onTypes.join('/') + whereLabel(c.on_where) + ' #' + first.i + ' (' + k + ')' });
      else if (n > 1) violations.push({ index: first.i, key: k, reason: n + ' × ' + reqTypes.join('/') + ' after ' + onTypes.join('/') + ' #' + first.i + ' (' + k + ') — exactly one is allowed' });
    }
  } else {
    for (const t of triggers) {
      if (fields && !firstKey(t.e, fields)) { violations.push(noKey(t)); continue; }
      if (!reactions.some((r) => r.i > t.i && sameGroup(t, r))) {
        const k = fields ? fmtKey(firstKey(t.e, fields)) : null;
        violations.push({ index: t.i, key: k, reason: 'no later ' + reqTypes.join('/') + (fields ? ' with the same ' + firstKey(t.e, fields).f : '') + ' after ' + typeOf(t.e) + ' #' + t.i + (k ? ' (' + k + ')' : '') });
      }
    }
  }
  if (c.forbid_unprompted === true) {
    for (const r of reactions) {
      if (fields && !firstKey(r.e, fields)) { violations.push(noKey(r)); continue; }
      if (!triggers.some((t) => t.i < r.i && sameGroup(t, r))) {
        violations.push({ index: r.i, key: fields ? fmtKey(firstKey(r.e, fields)) : null, reason: typeOf(r.e) + ' #' + r.i + ' has no earlier ' + onTypes.join('/') + whereLabel(c.on_where) + (fields ? ' for the same ' + firstKey(r.e, fields).f : '') + ' — it may not come up front' });
      }
    }
  }
  const ok = violations.length === 0;
  return {
    ok, vacuous: triggers.length === 0 && ok, triggers: triggers.length, reactions: reactions.length, count,
    violations_count: violations.length, violations: violations.slice(0, MAX_DETAIL_ITEMS),
    reason: ok ? (triggers.length ? 'every ' + onTypes.join('/') + ' got its ' + reqTypes.join('/') : 'no ' + onTypes.join('/') + whereLabel(c.on_where) + ' in this run (vacuously satisfied)')
      : violations.slice(0, 3).map((v) => v.reason).join(' | ') + (violations.length > 3 ? ' | …' : ''),
  };
}

/** hashProjectFile(root, rel) -> {hash:<sha256>|null (absent), error?} — contained under root, never throws. */
function hashProjectFile(root, rel) {
  if (!isSafeRelPath(rel)) return { hash: null, error: 'unsafe path' };
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return { hash: null, error: 'path escapes the project root' };
  try { return { hash: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') }; }
  catch (e) { return e && e.code === 'ENOENT' ? { hash: null } : { hash: null, error: (e && e.code) || 'unreadable' }; }
}
/** eventNamesFile(e, rel) — F08 (Codex adversarial review): EXACT project-relative path only. The
 *  old match also accepted a bare basename and any suffix, so `elsewhere/FORGE_MEMORY.md` (or a mention of the
 *  file name in `evidence`) "proved" the project's memory file was touched. A leading `./` and backslashes are
 *  normalised; nothing else is. */
function eventNamesFile(e, rel) {
  const want = normRel(rel).replace(/^(\.\/)+/, '');
  for (const f of FILE_NAMING_FIELDS) {
    for (const v of toArray(e[f])) {
      if (typeof v !== 'string') continue;
      if (normRel(v).replace(/^(\.\/)+/, '') === want) return true;
    }
  }
  return false;
}
/** evaluateFileTouched — F08: the hashes come from the WRITER-established baseline on run_started
 *  (`file_hashes`, stamped by log-event.cjs, never caller-supplied — a `baseline_field` option is ignored and
 *  reported). Without a valid baseline a file is `unverified`: an event merely NAMING the file is not proof
 *  that it changed (it is reported as named-by-event-unverified, informational only). */
function evaluateFileTouched(c, ctx) {
  const field = FILE_HASHES_FIELD;
  const ignoredField = c.baseline_field && c.baseline_field !== FILE_HASHES_FIELD ? c.baseline_field : null;
  const startEv = ctx.events.find((e) => typeOf(e) === 'run_started');
  const raw = startEv && startEv[field] && typeof startEv[field] === 'object' && !Array.isArray(startEv[field]) ? startEv[field] : null;
  const baseline = new Map();
  if (raw) for (const k of Object.keys(raw)) baseline.set(normRel(k), raw[k]);
  const altTypes = c.alt_event ? specTypes(c.alt_event) : [];
  const files = c.files.map((f) => {
    const rel = normRel(f);
    const now = hashProjectFile(ctx.root, f);
    const base = baseline.get(rel);
    const baseValid = baseline.has(rel) && (base === null || (typeof base === 'string' && SHA256_RE.test(base)));
    const named = altTypes.length > 0 && ctx.events.some((e) => altTypes.includes(typeOf(e)) && !eventIsDisproven(e) && eventNamesFile(e, rel));
    let status;
    if (now.error) status = 'unreadable';
    else if (baseValid) status = now.hash !== (base === null ? null : base.toLowerCase()) ? 'changed' : (named ? 'unchanged-despite-event' : 'unchanged');
    else status = named ? 'named-by-event-unverified' : 'unverified';
    return { file: f, status, touched: status === 'changed' };
  });
  const mode = c.mode || 'all';
  const ok = mode === 'any' ? files.some((x) => x.touched) : files.every((x) => x.touched);
  const open = files.filter((x) => !x.touched);
  return {
    ok, mode, baseline_field: field, baseline_recorded: !!raw, files,
    ...(ignoredField ? { baseline_field_ignored: ignoredField } : {}),
    reason: ok ? 'touched: ' + files.filter((x) => x.touched).map((x) => x.file + ' (' + x.status + ')').join(', ')
      : 'not shown as updated: ' + open.map((x) => x.file + ' (' + x.status + ')').join(', ')
        + (raw ? '' : ' — no writer-stamped ' + field + ' baseline on run_started, so a change cannot be verified' + (open.some((x) => x.status === 'named-by-event-unverified') ? ' (an event names the file, which is a claim, not proof)' : '')),
  };
}

/** evaluateV2(rule, ctx) -> detail {ok, reason, ...}. Never throws: an internal error is a FAILED check whose
 *  reason carries the error — never a pass, never a crash of the whole contract. */
function evaluateV2(rule, ctx) {
  try {
    const c = rule.check;
    if (c.type === 'closure') return evaluateClosure(c, ctx);
    if (c.type === 'sequence') return evaluateSequence(c, ctx);
    if (c.type === 'reaction') return evaluateReaction(c, ctx);
    if (c.type === 'file-touched') return evaluateFileTouched(c, ctx);
    return { ok: false, reason: 'not a V2 check type: ' + c.type };
  } catch (e) {
    return { ok: false, error: true, reason: 'evaluator error (' + (e && e.message ? e.message : String(e)) + ') — reported as not satisfied, never as a pass' };
  }
}
/** sanitizeV2 — rule_details carry counts, keys, indexes and short reasons, never raw event payloads. */
function sanitizeV2(d, type) {
  const kort = (s) => String(s == null ? '' : s).slice(0, 400);
  const out = { ok: d.ok === true, check_type: type, reason: kort(d.reason) };
  for (const k of ['vacuous', 'opened', 'matched', 'owner_skipped', 'unkeyed', 'unclosed_count', 'triggers', 'reactions', 'count', 'violations_count', 'mode', 'baseline_field', 'baseline_field_ignored', 'baseline_recorded', 'error']) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  const cap = (arr) => (Array.isArray(arr) ? arr.slice(0, MAX_DETAIL_ITEMS).map((x) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'string' ? kort(v) : v])) : kort(x))) : undefined);
  for (const k of ['unclosed', 'rejected_closes', 'violations', 'missing_before', 'required_before', 'files']) {
    if (d[k] !== undefined) out[k] = cap(d[k]);
  }
  if (d.first_after) out.first_after = d.first_after;
  return out;
}

/** runStartedAt(events, runMeta) -> {ms, iso, source} | null — when this run STARTED, for `since`: the first
 *  run_started event's timestamp, else the first timestamped event (some older runs log no run_started), else
 *  run.json started_at/created_at. Measured 2026-10-09: all 63 runs in this project carry `timestamp`. */
function tsOf(e) {
  /** the WRITER-stamped `ingested_at` wins over any `timestamp`
   *  — a caller-supplied timestamp survived logging and could backdate run_started (exempting every `since`
   *  rule) or run_completed (dodging the doctor's enforcement date). Events without `ingested_at` (all
   *  history before this fix) fall back to timestamp/ts, which is safe: they predate every cutoff. */
  for (const f of ['ingested_at', 'timestamp', 'ts']) {
    const v = e && e[f];
    const ms = typeof v === 'string' ? Date.parse(v) : (typeof v === 'number' ? v : NaN);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}
function runStartedAt(events, runMeta) {
  const at = (ms, source) => ({ ms, iso: new Date(ms).toISOString(), source });
  const rs = events.find((e) => typeOf(e) === 'run_started');
  if (rs && tsOf(rs) !== null) return at(tsOf(rs), 'run_started');
  for (const e of events) { const ms = tsOf(e); if (ms !== null) return at(ms, 'first_event'); }
  if (runMeta && typeof runMeta === 'object') {
    for (const f of ['started_at', 'created_at', 'timestamp']) {
      const ms = typeof runMeta[f] === 'string' ? Date.parse(runMeta[f]) : NaN;
      if (Number.isFinite(ms)) return at(ms, 'run.json');
    }
  }
  return null;
}
/** sinceExemption(rule, start) -> null (the rule applies) | {since, reason}. A run that provably started
 *  before `since` is exempt. A run whose start cannot be determined: a WARN rule is exempt (under-claim — it
 *  can never be red anyway), a BLOCK rule applies (fail-closed: an undatable run must not dodge a block rule). */
function sinceExemption(rule, start) {
  if (rule.since === undefined) return null;
  const s = sinceMs(rule.since);
  if (s === null) return null; // unreachable after loadRulesMeta validation; applying is the strict direction
  if (start) return start.ms < s ? { since: rule.since, reason: 'this run started ' + start.iso + ' (' + start.source + '), before the rule existed (' + rule.since + ') — judged by the rules of its own time' } : null;
  return rule.severity === 'warn' ? { since: rule.since, reason: 'the run start time is unknown (no timestamp on any event, no run.json date), so it cannot be shown to start on/after ' + rule.since + ' — a warn rule is not applied to it' } : null;
}

/** snapshotFileHashes(root, files) -> {"<rel path>": "<sha256>"|null} — the baseline a file-touched rule
 *  compares against. Meant for the run_started writer (store it as the event's `file_hashes` field); null
 *  marks a file that does not exist yet. Throws on an unsafe path (a caller bug, not run state). */
function snapshotFileHashes(root, files) {
  const out = {};
  for (const f of toArray(files)) {
    if (!isSafeRelPath(f)) throw new Error('forge-runcontract: snapshotFileHashes refuses unsafe path ' + JSON.stringify(f));
    const h = hashProjectFile(root, f);
    if (h.error) throw new Error('forge-runcontract: snapshotFileHashes could not read ' + f + ' (' + h.error + ')');
    out[f.replace(/\\/g, '/')] = h.hash;
  }
  return out;
}
/** fileTouchedTargets(rulesData) -> every distinct file a file-touched rule watches (the list a run_started
 *  writer must snapshot), read from the ONE registry so the writer never keeps its own copy. */
function fileTouchedTargets(rulesData) {
  const seen = new Map();
  for (const r of (rulesData && Array.isArray(rulesData.rules) ? rulesData.rules : [])) {
    if (!r || !r.check || r.check.type !== 'file-touched' || !Array.isArray(r.check.files)) continue;
    for (const f of r.check.files) if (isSafeRelPath(f) && !seen.has(normRel(f))) seen.set(normRel(f), f.replace(/\\/g, '/'));
  }
  return [...seen.values()];
}

/** scribeReconcileBinding(rule, ctx) -> {ok, reason, mode} — Codex R3 SC-05. For an event-present rule
 *  whose check carries `binding: 'scribe-ledger'` (owner-requests-reconciled), the event is not enough: the LAST FINAL
 *  owner_requests_reconciled must still be CURRENT — its writer stamp pins the scribe ledger (sha256/bytes/lines) and
 *  the inbox line count, and forge-scribe.cjs reconcileBinding() calls it stale when newer owner prompts or items
 *  exist, the pinned prefix changed, or the final gate is not OK now. A final:false reconciliation is progress-only.
 *  An older checker ignores `binding` and judges the plain event-present rule (a warn rule there). Never throws. */
function scribeReconcileBinding(rule, ctx) {
  const key = toArray(rule.check.key)[0];
  const evs = (ctx.events || []).filter((e) => e && e.event_type === key);
  const stampOf = (e) => (e && e._forge_verify && e._forge_verify.scribe_gate) || null;
  const finals = evs.filter((e) => { const s = stampOf(e); return s && (s.final === true || s.decision === 'not-applicable'); });
  if (!finals.length) return { ok: false, mode: 'scribe-ledger', reason: evs.length ? 'only progress-only (final:false) or unstamped ' + key + ' events — completion needs a final reconciliation (the default)' : 'no ' + key + ' event' };
  const SC = softRequire('forge-scribe.cjs');
  if (!SC || typeof SC.reconcileBinding !== 'function') return { ok: false, mode: 'scribe-ledger', reason: 'forge-scribe.cjs (reconcileBinding) is not available next to this checker — the reconciliation binding cannot be judged' };
  try {
    const b = SC.reconcileBinding(stampOf(finals[finals.length - 1]), { root: ctx.root });
    return { ok: b.current === true, mode: 'scribe-ledger', reason: String(b.reason || (b.current ? 'current' : 'stale')).slice(0, 300) };
  } catch (e) {
    return { ok: false, mode: 'scribe-ledger', reason: 'the reconciliation binding could not be judged (' + String((e && e.message) || e).split('\n')[0].slice(0, 160) + ')' };
  }
}

// =====================================================================================================
// RUN SHAPE + RUN EVIDENCE (I.6, modernization Phase I "Forge Intelligence"). Owner problem
// (docs/claude-md/intelligence-bar.md): the owner had to repeat "turn it on / start more lanes / you forgot X / sloppy
// output" because those rules lived only as prose the Lead should follow. Four contract rules now ENFORCE what the
// anticipation engine reported as default-but-not-enforced: the plan card, the anticipation overlay, the craft review and
// "serial needs a named blocker".
// BINDING DESIGN — opt-in BY RUN SHAPE. A rule with trigger "run-shape:<shape>" applies only when the run ITSELF declares
// that shape, read from three files in its own run folder and nothing else (never the domain, never an event count), so
// every run that predates the plan flow, and every older test fixture, is judged exactly as before:
//   plan-scale          run.json work_packages >= 3 (a number or a list) or lanes >= 2 (lanes.expected | lanes_expected |
//                       expected_lanes | a number), or anticipate.json input.lanes >= 2, or a readable plan card with >= 3
//                       packages or >= 2 expected lanes;
//   plan-card           a non-empty plan-card.json sits in the run folder;
//   visible-deliverable run.json deliverable_types (a list or "a,b") or anticipate.json input.type names a visible,
//                       user-facing type (VISIBLE_DELIVERABLE_TYPES);
//   serial-plan         a readable plan card with >= 4 packages and no file shared inside a wave (lanes.collisions empty)
//                       that runs with 1 expected lane (run.json's declared lanes win over the card's lanes.expected);
//   web-ui-deliverable  (S3b) the visible-deliverable types above include web-ui (same declaration, narrower view).
// The check type `run-evidence {evidence, exception?}` judges what the shape owes: plan-card (plan-card.json written by
// forge-plan-card.cjs --run), anticipation (anticipate.json for THIS run, status applied or reverted), craft-review
// (craft-review-<type>.json per visible type, re-validated through forge-craft.cjs checkRecorded: untampered, valid, no
// unresolved block DEFECT) and parallelism-reason (a recorded decision that names the blocker).
// EXCEPTION — never a dead end, never silent: the run logs
//   decision_logged {rule:'<exact rule id>', decision:'not-applicable', reason:'<why, at least 12 characters>', agent}
// (craft-review: an optional deliverable_type limits it to one type, and it never replaces a review that exists;
// parallelism-reason: decision 'serial' or 'not-applicable', and `blocking` must name the file, lock or dependency). An
// excepted rule is listed in result.exceptions and its rule_details say via:'exception' — never a plain, silent pass.
// The owner path (owner_override with a configured `by`) still applies to every one of these rules.
// =====================================================================================================
const VISIBLE_DELIVERABLE_TYPES = ['web-ui', 'copy-and-content', 'documents-and-spreadsheets', 'game-and-interactive', 'voice-and-chat', 'cli-and-devtools'];
// E.1 (owner HARD MUST 'end-of-work self-review'): `self-review` judges the run's self-review.json through
// forge-endreview.cjs checkRecorded (untampered, every question answered with evidence or an open item, for THIS run) AND
// a '## Self-review' heading in final-report.md. Its rule (end-self-review) is triggered by complexity, not by a run shape,
// and carries no agent exception: only the owner_override path clears it.
// S3b: `craft-evidence` judges <run folder>/craft-evidence-web-ui.json through forge-craft-evidence.cjs
// checkFile (the per-record check its checkRun runs, pointed at the folder this contract reads): every viewport and state
// the web-ui lens asks for, real screenshot files inside the project. Its rule (craft-evidence-recorded) is opt-in by the
// web-ui-deliverable shape and, like end-self-review, carries no agent exception: only owner_override clears it.
// A2: `dispatch-harness` joins the run's subagent_started/agent_started
// events to what the HARNESS recorded (PreToolUse/PostToolUse(Agent), SubagentStart/Stop, the Workflow journal) through
// forge-harness-match.cjs matchRun({final:true}); met when the match percentage (matched / every dispatch except an
// external CLI) reaches check.min_match_pct (default 95). Its rule (dispatch-harness-match) is triggered by complexity,
// carries no agent exception, and is fail-closed when forge-harness-match.cjs is absent.
// SK1 (category tests): `skill-delivery` joins the run's latest skill map (normalised by forge-skillmap.cjs)
// to the skills_opened on this run's SubagentStop lines (harnessRecordsFor 'stop'); see evaluateSkillDelivery. Its rule
// (skill-delivered) is triggered by complexity and carries no agent exception.
// F14 (category tests round 6): `shape-declared` asks that the run DECLARED its shape at all (an anticipate.json
// applied for this run, a plan-card.json with a card hash, or a run.json with deliverable_types). Five of eight measured
// runs declared nothing, so every run-shape rule was silently not applicable. It infers nothing: it only demands the
// declaration step /forge already prescribes.
const RUN_EVIDENCE_KINDS = new Set(['plan-card', 'anticipation', 'craft-review', 'parallelism-reason', 'self-review', 'craft-evidence', 'dispatch-harness', 'skill-delivery', 'shape-declared']);
const CRAFT_EVIDENCE_TYPE = 'web-ui';
const PLAN_SCALE_MIN_PACKAGES = 3, PLAN_SCALE_MIN_LANES = 2, SERIAL_PLAN_MIN_PACKAGES = 4;
const EXCEPTION_MIN_REASON = 12;
const ANTICIPATE_DONE_STATUSES = new Set(['applied', 'reverted']);
const CARD_HASH_RE = /^[0-9a-f]{64}$/;

/** validateRunEvidenceCheck(rule, rulesPath) -> null | {reason} (an `evidence` value this checker does not know: degrade
 *  like an unknown option, S6). Throws on a structurally broken shape. */
function validateRunEvidenceCheck(r, p) {
  const c = r.check;
  const bad = (what) => { throw new Error('forge-runcontract: rule "' + r.id + '" (check.type ' + RUN_EVIDENCE_TYPE + ') ' + what + ' in ' + p); };
  if (c.key !== undefined) bad('carries a check.key — run-evidence is keyless (its "evidence" names what it reads); remove it so the rule cannot silently look key-driven');
  if (typeof c.evidence !== 'string' || !CHECK_TYPE_SHAPE_RE.test(c.evidence)) bad('needs "evidence": one of ' + [...RUN_EVIDENCE_KINDS].join(', '));
  if (c.exception !== undefined) {
    const x = c.exception;
    if (!x || typeof x !== 'object' || Array.isArray(x)) bad('has an invalid "exception" (must be {event, decisions[, require]})');
    if (!(typeof x.event === 'string' && /^[a-z][a-z0-9_]*$/.test(x.event))) bad('exception needs "event": the registered event type that records it (decision_logged)');
    if (!Array.isArray(x.decisions) || !x.decisions.length || !x.decisions.every((d) => typeof d === 'string' && CHECK_TYPE_SHAPE_RE.test(d))) bad('exception needs "decisions": a non-empty list of decision tokens such as "not-applicable"');
    if (x.require !== undefined && !(Array.isArray(x.require) && x.require.every((f) => typeof f === 'string' && /^[a-z][a-z0-9_]*$/.test(f)))) bad('exception has an invalid "require" (a list of field names)');
  }
  // A2: the one numeric option, and only on the evidence kind that reads it
  if (c.min_match_pct !== undefined && (c.evidence !== 'dispatch-harness' || typeof c.min_match_pct !== 'number' || !Number.isFinite(c.min_match_pct) || c.min_match_pct < 0 || c.min_match_pct > 100)) {
    bad('has an invalid "min_match_pct" (a number from 0 to 100, only with evidence "dispatch-harness")');
  }
  return RUN_EVIDENCE_KINDS.has(c.evidence) ? null : { reason: 'unknown run-evidence evidence "' + c.evidence + '" (this checker knows: ' + [...RUN_EVIDENCE_KINDS].join(', ') + ')' };
}

/** readShapeFile(dir, name) -> {present, ok, data, error}. present = the file exists and is not blank; never throws. */
function readShapeFile(dir, name) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); }
  catch (e) { const code = (e && e.code) || 'unreadable'; return { present: code !== 'ENOENT', ok: false, data: null, error: code === 'ENOENT' ? null : code }; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (!raw.trim()) return { present: false, ok: false, data: null, error: 'empty file' };
  let data;
  try { data = JSON.parse(raw); } catch { return { present: true, ok: false, data: null, error: 'not valid JSON' }; }
  return data && typeof data === 'object' && !Array.isArray(data) ? { present: true, ok: true, data, error: null } : { present: true, ok: false, data: null, error: 'not a JSON object' };
}
function posInt(v) { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return Number.isInteger(n) && n > 0 ? n : null; }
function countOf(v) { return Array.isArray(v) ? (v.length || null) : posInt(v); }
function slugOf(v) { return String(v).trim().toLowerCase().replace(/\s+/g, '-'); }
function listOf(v) {
  const raw = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  return [...new Set(raw.filter((x) => typeof x === 'string' && x.trim()).map(slugOf))];
}
function declaredLanesOf(run) {
  if (run.lanes && typeof run.lanes === 'object' && !Array.isArray(run.lanes)) { const n = posInt(run.lanes.expected); if (n) return n; }
  for (const v of [run.lanes, run.lanes_expected, run.expected_lanes]) { const n = posInt(v); if (n) return n; }
  return null;
}
function planCardInfo(f) {
  if (!f || !f.ok) return null;
  const d = f.data, lanes = d.lanes && typeof d.lanes === 'object' && !Array.isArray(d.lanes) ? d.lanes : {};
  const ids = new Set([].concat(Array.isArray(d.ready) ? d.ready : [], Array.isArray(d.blocked) ? d.blocked : []).filter((x) => typeof x === 'string' && x.trim()));
  return { hash: typeof d.cardHash === 'string' && CARD_HASH_RE.test(d.cardHash) ? d.cardHash : null, packages: ids.size,
    expected: posInt(lanes.expected), collisions: Array.isArray(lanes.collisions) ? lanes.collisions.length : null };
}

/** readRunShape(runDir) -> {applies:{<shape>: bool}, why:{<shape>: [text]}, declared, card, anticipate, deliverable_types,
 *  visible_types, serial, _files} — what the run itself declares (see the block comment above). Read-only, never throws. */
function readRunShape(runDir) {
  const files = { run: readShapeFile(runDir, 'run.json'), card: readShapeFile(runDir, 'plan-card.json'), anticipate: readShapeFile(runDir, 'anticipate.json') };
  const run = files.run.ok ? files.run.data : {};
  const an = files.anticipate.ok ? files.anticipate.data : null;
  const anInput = an && an.input && typeof an.input === 'object' && !Array.isArray(an.input) ? an.input : {};
  const card = planCardInfo(files.card);
  const declared = { work_packages: countOf(run.work_packages), lanes: declaredLanesOf(run), deliverable_types: listOf(run.deliverable_types) };
  const anLanes = posInt(anInput.lanes), anType = typeof anInput.type === 'string' && anInput.type.trim() ? slugOf(anInput.type) : null;
  const types = [...new Set(declared.deliverable_types.concat(anType ? [anType] : [], listOf(an && an.deliverable_types)))];
  const visible = types.filter((t) => VISIBLE_DELIVERABLE_TYPES.includes(t));
  const why = { 'plan-scale': [], 'plan-card': [], 'visible-deliverable': [], 'serial-plan': [], 'web-ui-deliverable': [] };
  if (declared.work_packages >= PLAN_SCALE_MIN_PACKAGES) why['plan-scale'].push('run.json declares ' + declared.work_packages + ' work packages');
  if (declared.lanes >= PLAN_SCALE_MIN_LANES) why['plan-scale'].push('run.json declares ' + declared.lanes + ' expected lanes');
  if (anLanes >= PLAN_SCALE_MIN_LANES) why['plan-scale'].push('anticipate.json counted ' + anLanes + ' parallel parts');
  if (card && (card.packages >= PLAN_SCALE_MIN_PACKAGES || card.expected >= PLAN_SCALE_MIN_LANES)) why['plan-scale'].push('the plan card holds ' + card.packages + ' packages and ' + (card.expected || '?') + ' expected lane(s)');
  if (files.card.present) why['plan-card'].push('plan-card.json is in the run folder');
  if (visible.length) why['visible-deliverable'].push('declared deliverable type(s): ' + visible.join(', '));
  if (visible.includes(CRAFT_EVIDENCE_TYPE)) why['web-ui-deliverable'].push('declared deliverable type ' + CRAFT_EVIDENCE_TYPE + ' (its craft lens is in the review plan)');
  const lanesSource = declared.lanes ? 'run.json' : 'plan-card.json';
  const lanesNow = declared.lanes || (card ? card.expected : null);
  const serial = card && card.packages >= SERIAL_PLAN_MIN_PACKAGES && card.collisions === 0 && lanesNow === 1
    ? { packages: card.packages, lanes: 1, lanes_source: lanesSource, card_expected: card.expected } : null;
  if (serial) why['serial-plan'].push(serial.packages + ' packages with no file shared inside a wave, 1 expected lane (' + lanesSource + ')');
  const applies = {};
  for (const s of RUN_SHAPES) applies[s] = why[s].length > 0;
  return {
    applies, why, declared, card, serial, deliverable_types: types, visible_types: visible,
    anticipate: an ? { status: typeof an.status === 'string' ? an.status : null, run_id: typeof an.run_id === 'string' ? an.run_id : null, lanes: anLanes, type: anType } : null,
    _files: files,
  };
}
/** summarizeRunShape(shape) -> the compact, payload-free view every check() result carries as `run_shape`. */
function summarizeRunShape(s) {
  const f = (x) => (x.present ? (x.ok ? 'readable' : 'unreadable: ' + x.error) : 'absent');
  return {
    declares_shape: Object.values(s.applies).some(Boolean), applies: Object.assign({}, s.applies),
    why: Object.fromEntries(Object.entries(s.why).filter(([, v]) => v.length)),
    deliverable_types: s.deliverable_types.slice(0, 12), visible_types: s.visible_types.slice(),
    files: { 'run.json': f(s._files.run), 'plan-card.json': f(s._files.card), 'anticipate.json': f(s._files.anticipate) },
  };
}

/** findShapeException(events, rule, {type?}) -> the LAST valid recorded exception for this rule, or null; also counts
 *  near misses (a decision for this rule that was not accepted) so the reason can say why. */
function findShapeException(events, rule, opts) {
  const x = rule.check && rule.check.exception;
  const out = { hit: null, rejected: [] };
  if (!x) return out;
  const type = String(x.event).trim().toLowerCase();
  const decisions = new Set(x.decisions.map(normVal));
  const req = Array.isArray(x.require) ? x.require : [];
  for (let i = 0; i < (events || []).length; i++) {
    const e = events[i];
    if (typeOf(e) !== type || e.rule !== rule.id) continue;
    const reject = (why) => { out.rejected.push({ index: i, why }); };
    if (eventIsDisproven(e)) { reject('the writer disproved it'); continue; }
    if (typeof e.decision !== 'string' || !decisions.has(normVal(e.decision))) { reject('decision must be ' + [...decisions].join(' or ')); continue; }
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (reason.length < EXCEPTION_MIN_REASON || !isMeaningfulReason(reason, rule.id)) { reject('reason must say why in at least ' + EXCEPTION_MIN_REASON + ' characters'); continue; }
    const missingField = req.find((f) => !(typeof e[f] === 'string' && e[f].trim()));
    if (missingField) { reject('"' + missingField + '" must name the ' + (missingField === 'blocking' ? 'file, lock or dependency that blocks parallel lanes' : 'value')); continue; }
    const dt = fieldValue(e, 'deliverable_type');
    if (opts && opts.type && dt !== null && normVal(dt) !== normVal(opts.type)) continue; // an exception for another type
    out.hit = Object.assign({ index: i, decision: normVal(e.decision), reason: reason.slice(0, 300), by: fieldValue(e, 'agent') },
      req.length ? { fields: Object.fromEntries(req.map((f) => [f, String(e[f]).trim().slice(0, 200)])) } : {}, dt !== null ? { deliverable_type: normVal(dt) } : {});
  }
  return out;
}

/** evaluateRunEvidence(rule, ctx) -> detail {ok, evidence, reason, via?, exception?, types?, message?, next_step?}. Never
 *  throws: an internal error is a FAILED check whose reason carries the error — never a pass. */
function evaluateRunEvidence(rule, ctx) {
  const c = rule.check;
  const shape = ctx.runShape || readRunShape(ctx.runDir);
  const runId = String(ctx.runId || '');
  const folder = runFolderLabel(ctx);
  const subst = (s, type) => String(s).split('<run_id>').join(runId || '<run_id>').split('<type>').join(type || '<type>');
  const base = { evidence: c.evidence, shape_why: (shape.why[String(rule.trigger).replace(/^run-shape:/, '')] || []).slice() };
  const pass = (reason, via, extra) => Object.assign({}, base, { ok: true, via, reason }, extra || {});
  const fail = (reason, extra, type) => Object.assign({}, base, { ok: false, reason }, extra || {},
    rule.next_step ? { next_step: subst(rule.next_step, type) } : {}, rule.message ? { message: { en: subst(rule.message.en, type), nl: subst(rule.message.nl, type) } } : {});
  const nearMiss = (ex) => (ex.rejected.length ? ' (a decision_logged for this rule was found but not accepted: ' + ex.rejected[ex.rejected.length - 1].why + ')' : '');
  try {
    if (c.evidence === 'plan-card') {
      const f = shape._files.card, card = shape.card;
      if (card && card.hash) return pass('plan card ' + card.hash.slice(0, 12) + ' is recorded in ' + folder + '/plan-card.json (' + card.packages + ' package(s), ' + (card.expected || '?') + ' expected lane(s))', 'evidence');
      const ex = findShapeException(ctx.events, rule);
      if (ex.hit) return pass('exception recorded (' + ex.hit.decision + '): ' + ex.hit.reason, 'exception', { exception: ex.hit });
      const what = !f.present ? 'no plan card in ' + folder + ' (plan-card.json)' : !f.ok ? folder + '/plan-card.json is unreadable (' + f.error + ')' : folder + '/plan-card.json carries no card hash, so it was not written by forge-plan-card.cjs --run';
      return fail(what + ' — the rule applies because ' + (base.shape_why.join('; ') || 'the run declares a multi-package plan') + nearMiss(ex));
    }
    if (c.evidence === 'anticipation') {
      const f = shape._files.anticipate, d = f.ok ? f.data : null;
      if (d && ANTICIPATE_DONE_STATUSES.has(String(d.status)) && d.run_id === runId) return pass('anticipate.json is ' + d.status + ' for this run (' + (Array.isArray(d.active) ? d.active.length : 0) + ' active item(s), ' + (Array.isArray(d.waits_for_owner) ? d.waits_for_owner.length : 0) + ' waiting for the owner)', 'evidence');
      const ex = findShapeException(ctx.events, rule);
      if (ex.hit) return pass('exception recorded (' + ex.hit.decision + '): ' + ex.hit.reason, 'exception', { exception: ex.hit });
      const what = !f.present ? 'no anticipate.json in ' + folder : !f.ok ? 'anticipate.json is unreadable (' + f.error + ')'
        : d.run_id !== runId ? 'anticipate.json belongs to run "' + String(d.run_id).slice(0, 80) + '", not this one' : 'anticipate.json has status "' + String(d.status).slice(0, 40) + '" (applied or reverted is needed)';
      return fail('this run has a plan card but ' + what + nearMiss(ex));
    }
    if (c.evidence === 'parallelism-reason') {
      const ex = findShapeException(ctx.events, rule);
      if (ex.hit) {
        const blocking = ex.hit.fields && ex.hit.fields.blocking ? ' — blocking: ' + ex.hit.fields.blocking : '';
        return pass((ex.hit.decision === 'serial' ? 'serial run explained' : 'exception recorded (' + ex.hit.decision + ')') + blocking + ' — ' + ex.hit.reason, ex.hit.decision === 'serial' ? 'reason' : 'exception', { exception: ex.hit });
      }
      const sp = shape.serial || { packages: '?', lanes_source: 'unknown' };
      return fail('the plan card holds ' + sp.packages + ' packages with no file shared inside a wave, yet the run has 1 expected lane (' + sp.lanes_source + ') and no recorded reason names what blocks parallel lanes' + nearMiss(ex));
    }
    if (c.evidence === 'craft-review') {
      const types = shape.visible_types;
      const C = softRequire('forge-craft.cjs');
      if (!C || typeof C.checkRecorded !== 'function') return fail('forge-craft.cjs (checkRecorded) is not available next to this checker — the recorded craft review cannot be judged (fail-closed)', null, types[0]);
      const items = types.map((t) => {
        let rec;
        try { rec = C.checkRecorded({ root: ctx.root, runDir: ctx.runDir, type: t, runId }); }
        catch (e) { rec = { recorded: true, valid: false, problems: ['it could not be judged (' + String((e && e.message) || e).split('\n')[0].slice(0, 160) + ')'] }; }
        if (rec && rec.recorded) {
          const unresolved = Array.isArray(rec.unresolved_block_defects) ? rec.unresolved_block_defects : [];
          if (!rec.valid) return { type: t, ok: false, recorded: true, reason: t + ': the recorded review is not valid — ' + (rec.problems || []).slice(0, 2).join('; ') };
          if (unresolved.length) return { type: t, ok: false, recorded: true, unresolved_block_defects: unresolved.slice(0, MAX_DETAIL_ITEMS), reason: t + ': ' + unresolved.length + ' unresolved block DEFECT(s): ' + unresolved.slice(0, 6).join(', ') + ' — an accepted weakness on a block check still means not done; fix it and record the review again' };
          // owner-data checks marked WAITING_ON_OWNER (with how the placeholder is labelled) are a
          // recorded, VISIBLE exception (exceptionsOf), never a silent pass and never an unresolved block DEFECT
          const waiting = Array.isArray(rec.waiting_on_owner) ? rec.waiting_on_owner.filter((w) => w && typeof w.id === 'string') : [];
          const wait = waiting.length ? { decision: 'waiting-on-owner', deliverable_type: t, by: rec.reviewer || null, index: null,
            reason: t + ': ' + waiting.map((w) => w.id).join(', ') + ' wait on data only the owner can give; labelled to the visitor: ' + waiting.map((w) => w.id + ' — ' + String(w.evidence || '').slice(0, 160)).join(' | ') } : null;
          return Object.assign({ type: t, ok: true, recorded: true, via: 'evidence', reason: t + ': craft review recorded, no unresolved block DEFECT' + (waiting.length ? '; ' + waiting.length + ' owner-data check(s) waiting on the owner (visible exception): ' + waiting.map((w) => w.id).join(', ') : '') + (rec.notes && rec.notes.length ? ' (' + String(rec.notes[0]).slice(0, 160) + ')' : '') },
            wait ? { waiting_on_owner: wait } : {});
        }
        const ex = findShapeException(ctx.events, rule, { type: t });
        if (ex.hit) return { type: t, ok: true, recorded: false, via: 'exception', exception: Object.assign({ deliverable_type: t }, ex.hit), reason: t + ': exception recorded — ' + ex.hit.reason };
        return { type: t, ok: false, recorded: false, reason: t + ': no craft review recorded (craft-review-' + t + '.json in ' + folder + ')' + nearMiss(ex) };
      });
      const reason = items.map((i) => i.reason).join(' | ') || 'no visible deliverable type declared';
      const firstOpen = items.find((i) => !i.ok);
      if (!items.length || firstOpen) return fail(reason, { types: items }, firstOpen ? firstOpen.type : null);
      const via = items.every((i) => i.via === 'exception') ? 'exception' : items.some((i) => i.via === 'exception') ? 'evidence+exception' : 'evidence';
      return pass(reason, via, { types: items });
    }
    if (c.evidence === 'self-review') {
      const E = softRequire('forge-endreview.cjs');
      if (!E || typeof E.checkRecorded !== 'function') return fail('forge-endreview.cjs (checkRecorded) is not available next to this checker — the self-review cannot be judged (fail-closed)');
      let rec;
      try { rec = E.checkRecorded({ root: ctx.root, runDir: ctx.runDir, runId }); }
      catch (e) { return fail('the self-review could not be judged (' + String((e && e.message) || e).split('\n')[0].slice(0, 160) + ')'); }
      if (rec && rec.ok) {
        const s = rec.summary || { questions: 0, with_evidence: 0, open_items: [] };
        return pass('self-review recorded in ' + folder + '/self-review.json (' + s.questions + ' questions, ' + s.with_evidence + ' with evidence, ' + s.open_items.length + ' open item(s)) and final-report.md has the Self-review section', 'evidence');
      }
      return fail('self-review not done: ' + ((rec && rec.problems) || []).slice(0, 3).join('; '));
    }
    if (c.evidence === 'craft-evidence') {
      const t = CRAFT_EVIDENCE_TYPE, file = 'craft-evidence-' + t + '.json';
      const V = softRequire('forge-craft-evidence.cjs');
      if (!V || typeof V.checkFile !== 'function' || typeof V.checkRun !== 'function') return fail('forge-craft-evidence.cjs (checkRun/checkFile) is not available next to this checker — the screenshot evidence cannot be judged (fail-closed)', null, t);
      let rec;
      try { rec = V.checkFile({ root: ctx.root, file: path.join(ctx.runDir, file), type: t }); }
      catch (e) { return fail('the screenshot evidence could not be judged (' + String((e && e.message) || e).split('\n')[0].slice(0, 160) + ')', null, t); }
      if (rec && rec.code === 0 && rec.ok === true) {
        const s = rec.summary || { views: 0, entries_filled: 0, entries_na: 0, screenshots_verified: 0 };
        return pass(t + ' screenshot evidence complete in ' + folder + '/' + file + ' (' + s.views + ' view(s), ' + s.screenshots_verified + ' screenshot file(s) verified, ' + s.entries_na + ' n/a)', 'evidence');
      }
      const probs = ((rec && rec.problems) || []).slice(0, 3).join('; ') || 'the record could not be judged';
      return fail((rec && rec.code === 2 ? 'the screenshot evidence cannot be judged: ' : 'screenshot evidence not complete: ') + probs, null, t);
    }
    if (c.evidence === 'dispatch-harness') return evaluateDispatchHarness(c, ctx, runId, pass, fail);
    if (c.evidence === 'skill-delivery') return evaluateSkillDelivery(ctx, runId, pass, fail);
    if (c.evidence === 'shape-declared') {
      const fa = shape._files.anticipate, fc = shape._files.card, fr = shape._files.run, an = fa.ok ? fa.data : null;
      if (an && ANTICIPATE_DONE_STATUSES.has(String(an.status)) && an.run_id === runId) return pass('anticipate.json is ' + an.status + ' for this run (deliverable types: ' + (shape.deliverable_types.join(', ') || 'none detected') + ')', 'evidence');
      if (shape.card && shape.card.hash) return pass('plan card ' + shape.card.hash.slice(0, 12) + ' is recorded in ' + folder + '/plan-card.json', 'evidence');
      if (shape.declared.deliverable_types.length) return pass('run.json declares deliverable_types: ' + shape.declared.deliverable_types.join(', '), 'evidence');
      const state = (f, name, extra) => name + ' ' + (!f.present ? 'absent' : !f.ok ? 'unreadable (' + f.error + ')' : extra);
      return fail('the run never declared its shape, so every run-shape rule (plan card, anticipation, craft review, screenshot evidence) would silently not apply: '
        + state(fa, 'anticipate.json', an ? (an.run_id !== runId ? 'belongs to run "' + String(an.run_id).slice(0, 60) + '"' : 'has status "' + String(an.status).slice(0, 30) + '" (applied is needed)') : '')
        + '; ' + state(fc, 'plan-card.json', 'has no card hash (not written by forge-plan-card.cjs --run)')
        + '; ' + state(fr, 'run.json', 'declares no deliverable_types'));
    }
    return fail('unknown run-evidence evidence "' + c.evidence + '"');
  } catch (e) {
    return Object.assign({}, base, { ok: false, error: true, reason: 'evaluator error (' + (e && e.message ? e.message : String(e)) + ') — reported as not satisfied, never as a pass' });
  }
}
/** evaluateDispatchHarness(check, ctx, runId, pass, fail) -> detail — A2. The run's dispatch events joined
 *  to the harness records by forge-harness-match.cjs (final view: the run is being judged at completion). Fail-closed when
 *  the matcher is absent or throws; `harness` carries the counts and the first unmatched dispatches (ids + reasons only). */
function evaluateDispatchHarness(c, ctx, runId, pass, fail) {
  const H = softRequire('forge-harness-match.cjs');
  if (!H || typeof H.matchRun !== 'function' || typeof H.meetsThreshold !== 'function') return fail('forge-harness-match.cjs (matchRun) is not available next to this checker — the dispatches cannot be matched to harness records (fail-closed)');
  const min = typeof c.min_match_pct === 'number' ? c.min_match_pct : H.DEFAULT_MIN_MATCH_PCT;
  let rep;
  try { rep = H.matchRun({ root: ctx.root, runId, events: ctx.events, final: true }); }
  catch (e) { return fail('the dispatches could not be matched (' + String((e && e.message) || e).split('\n')[0].slice(0, 160) + ')'); }
  const s = rep.summary;
  const open = rep.items.filter((i) => i.status !== 'matched' && i.unverifiable_kind !== 'external-cli');
  const harness = {
    min_match_pct: min, dispatches: s.dispatches, matched: s.matched, unmatched: s.unmatched, unverifiable: s.unverifiable,
    unverifiable_by_kind: s.unverifiable_by_kind, match_pct: s.match_pct, orphans: s.orphans, live: rep.harness.live,
    open: open.slice(0, MAX_DETAIL_ITEMS).map((i) => ({ dispatch_id: i.dispatch_id, agent: i.agent, status: i.status, kind: i.unverifiable_kind || i.kind, reason: String(i.reason).slice(0, 200) })),
  };
  if (s.dispatches === 0) return pass('no subagent_started/agent_started dispatch event in this run — nothing to match', 'evidence', { harness });
  const hooks = harnessHooksInstalled(ctx.root, rep.harness.live);
  harness.hooks = hooks;
  if (!hooks.installed) {
    return fail('harness hooks not installed: ' + hooks.reason + ' — ' + s.dispatches + ' dispatch(es) not counted as unmatched; install the SubagentStart and PreToolUse/PostToolUse(Agent) hooks (forge-subagent-start.cjs, forge-agent-tool-hook.cjs; forge-sync merges them into .claude/settings.json)', { harness });
  }
  const kinds = Object.entries(s.unverifiable_by_kind).map(([k, n]) => k + ' ' + n).join(', ');
  const line = s.dispatches + ' dispatch(es): ' + s.matched + ' matched, ' + s.unmatched + ' unmatched, ' + s.unverifiable + ' unverifiable' + (kinds ? ' (' + kinds + ')' : '')
    + '; match ' + (s.match_pct === null ? 'n/a' : s.match_pct + '%') + ' (needs ' + min + '%)';
  if (s.provable === 0) return pass(line + ' — only dispatch kinds no Claude Code hook can see; reported, not judged', 'evidence', { harness });
  if (H.meetsThreshold(s, min)) return pass(line, 'evidence', { harness });
  return fail(line + (open.length ? ' — first open: ' + open.slice(0, 3).map((i) => String(i.dispatch_id || '(no dispatch_id)').slice(0, 60) + ' (' + (i.unverifiable_kind || i.status) + ')').join(', ') : ''), { harness });
}
/** skillMapOfEvent(ev) -> the map object a skill_map_created event carries (map, skill_map, skills, payload.map,
 *  details.map), or null. `skills` is read too: it is the field the older skill-map-recorded next step suggested. */
function skillMapOfEvent(ev) {
  const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isMap(ev)) return null;
  return [ev.map, ev.skill_map, ev.skills, isMap(ev.payload) ? ev.payload.map : null, isMap(ev.details) ? ev.details.map : null].find(isMap) || null;
}
/** evaluateSkillDelivery(ctx, runId, pass, fail) -> detail — SK1. For every agent type in ALL the run's
 *  skill map (normalised by forge-skillmap.cjs against the skills that really exist) that has SubagentStop lines for this
 *  run with transcript_scanned true, every assigned skill must be in the union of their skills_opened. Never dispatched
 *  and not-scanned types are listed, not failed; no stop line with transcript_scanned at all = not measured (pass). */
/** Agent types that build, make the UI or test: dispatching one without any assigned skill fails skill-delivered (SK4).
 *  Planning/recording roles (boss, head-chef, scribe, skill-boss, docs-boss, search-boss), read-only reviewers and the
 *  built-in Claude Code agents are deliberately absent: their core skills come from their own frontmatter preload. */
const SKILL_EXECUTOR_TYPES = new Set(['build-boss', 'ui-boss', 'test-boss', 'integration-boss', 'seo-boss', 'electron-pro', 'data-scientist', 'mcp-developer', 'ml-engineer', 'payment-integration']);
function evaluateSkillDelivery(ctx, runId, pass, fail) {
  const SM = softRequire('forge-skillmap.cjs');
  if (!SM || typeof SM.normalizeSkillMap !== 'function' || typeof SM.knownSkillNames !== 'function') return fail('forge-skillmap.cjs (normalizeSkillMap) is not available next to this checker — the skill map cannot be read (fail-closed)');
  const mapEvents = (ctx.events || []).filter((e) => e && e.event_type === 'skill_map_created');
  if (!mapEvents.length) return pass('no skill_map_created in this run — nothing assigned to deliver (skill-map-recorded judges whether a map or a skill_discovery was logged)', 'evidence');
  // SK2: EVERY map of the run counts together. A later map may add skills, never drop them — restaurant-v4's
  // Lead answered a failing skill-delivered by logging a "corrected" map of only what was opened.
  const known = SM.knownSkillNames(ctx.root);
  const map = {};
  for (const ev of mapEvents) {
    const part = SM.normalizeSkillMap(skillMapOfEvent(ev), known);
    for (const [a, skills] of Object.entries(part)) map[a] = Array.from(new Set((map[a] || []).concat(skills)));
  }
  const agents = Object.keys(map);
  if (!agents.length) return fail('the skill map names no real skills per agent; log map as {"<agent-type>": ["<skill>"]} (skill_map_created with field map, each skill a folder with a SKILL.md under .claude/skills)');
  const lines = harnessRecordsFor(ctx.root, runId, ctx.events, 'stop') || [];
  const keyOf = (t) => { const k = typeof t === 'string' ? SM.agentTypeKey(t.slice(t.lastIndexOf(':') + 1)) : null; return k; };
  if (!lines.some((l) => typeof l.transcript_scanned === 'boolean')) {
    return pass('not measured: no SubagentStop line of this run records transcript_scanned (the stop hook predates skill tracking, or no hook log) — ' + agents.length + ' agent type(s) in the map', 'evidence', { skill_delivery: { measured: false, agents } });
  }
  const sd = { measured: true, agents, delivered: [], missing: [], not_dispatched: [], not_scanned: [], unassigned: [] };
  // SK4 (windows-v5): an executing agent type dispatched in this run with no skill in ANY map of the run.
  for (const l of lines) {
    const k = keyOf(l.agent_type);
    if (k && SKILL_EXECUTOR_TYPES.has(k) && !map[k] && !sd.unassigned.includes(k)) sd.unassigned.push(k);
  }
  for (const a of agents) {
    const own = lines.filter((l) => keyOf(l.agent_type) === a);
    if (!own.length) { sd.not_dispatched.push(a); continue; }
    const scanned = own.filter((l) => l.transcript_scanned === true);
    if (!scanned.length) { sd.not_scanned.push(a); continue; }
    const opened = new Set(scanned.flatMap((l) => (Array.isArray(l.skills_opened) ? l.skills_opened : [])).filter((s) => typeof s === 'string').map((s) => s.toLowerCase()));
    const lacking = map[a].filter((s) => !opened.has(s.toLowerCase()));
    if (lacking.length) sd.missing.push({ agent: a, skills: lacking.slice(0, MAX_DETAIL_ITEMS) });
    else sd.delivered.push(a);
  }
  const listed = (sd.not_dispatched.length ? '; not dispatched in this run (not judged): ' + sd.not_dispatched.join(', ') : '')
    + (sd.not_scanned.length ? '; transcript not scanned (not measured): ' + sd.not_scanned.join(', ') : '');
  const problems = [];
  if (sd.unassigned.length) problems.push('dispatched with no assigned skill in any skill map of this run: ' + sd.unassigned.join(', ') + ' (log skill_map_created {"map":{"' + sd.unassigned[0] + '":["<the category playbook, e.g. forge-website, forge-game, forge-mobile>"]}} BEFORE dispatching it)');
  if (sd.missing.length) problems.push('assigned skill(s) never opened: ' + sd.missing.map((m) => m.agent + ' did not open ' + m.skills.join(', ')).join(' | '));
  if (problems.length) return fail(problems.join(' ; ') + listed, { skill_delivery: sd });
  return pass(sd.delivered.length + ' agent type(s) opened every assigned skill' + (sd.delivered.length ? ' (' + sd.delivered.join(', ') + ')' : '') + listed, 'evidence', { skill_delivery: sd });
}
/** harnessHooksInstalled(root, live) -> {installed, via, reason} — A13 (fleet rollout). The dispatch-start
 *  side of the harness proof only exists when forge-subagent-start.cjs is registered under SubagentStart in the project's
 *  .claude/settings.json or .claude/settings.local.json. A project that never got the hook (most of the fleet until the
 *  owner-gated rollout) would otherwise see EVERY dispatch counted as unmatched, which says "the Lead faked it" when the
 *  truth is "nothing was listening". The harness having recorded this run's start side (a SubagentStart or Agent-tool
 *  record, e.g. hooks shipped by the plugin or user-level settings) also counts as installed. Read-only, never throws. */
const HARNESS_START_HOOK = 'forge-subagent-start.cjs';
function harnessHooksInstalled(root, live) {
  const files = ['settings.json', 'settings.local.json'];
  for (const f of files) {
    const p = path.join(root || '', '.claude', f);
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const groups = j && j.hooks && Array.isArray(j.hooks.SubagentStart) ? j.hooks.SubagentStart : [];
    const hit = groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HARNESS_START_HOOK)));
    if (hit) return { installed: true, via: '.claude/' + f, reason: HARNESS_START_HOOK + ' registered under SubagentStart in .claude/' + f };
  }
  if (live && (live.start > 0 || live.tool > 0)) return { installed: true, via: 'harness-records', reason: 'the harness recorded this run (SubagentStart ' + live.start + ', Agent tool ' + live.tool + ' record(s))' };
  return { installed: false, via: null, reason: 'no SubagentStart hook running ' + HARNESS_START_HOOK + ' in .claude/settings.json or .claude/settings.local.json and no SubagentStart/Agent-tool harness record for this run' };
}
/** exceptionsOf(ruleId, detail) -> [{id, decision, reason, by, deliverable_type?, index}] — every excepted part of a rule. */
function exceptionsOf(ruleId, d) {
  const out = [];
  const add = (x) => out.push(Object.assign({ id: ruleId, decision: x.decision, reason: x.reason, by: x.by || null, index: x.index }, x.deliverable_type ? { deliverable_type: x.deliverable_type } : {}));
  if (d && d.ok && d.via === 'exception' && d.exception) add(d.exception);
  if (d && d.ok && Array.isArray(d.types)) for (const t of d.types) if (t.via === 'exception' && t.exception) add(t.exception);
  if (d && d.ok && Array.isArray(d.types)) for (const t of d.types) if (t.waiting_on_owner) add(t.waiting_on_owner); // R2
  return out;
}
/** sanitizeRunEvidence — rule_details carry short reasons, ids and the next step, never raw file or event payloads. */
function sanitizeRunEvidence(d) {
  const kort = (s, n) => String(s == null ? '' : s).slice(0, n || 400);
  const exc = (x) => (x ? Object.assign({ decision: x.decision, reason: kort(x.reason, 300), by: x.by || null, index: x.index }, x.fields ? { fields: x.fields } : {}, x.deliverable_type ? { deliverable_type: x.deliverable_type } : {}) : undefined);
  const out = { ok: d.ok === true, check_type: RUN_EVIDENCE_TYPE, evidence: d.evidence || null, reason: kort(d.reason, 600) };
  if (d.via) out.via = d.via;
  if (d.error) out.error = true;
  if (d.exception) out.exception = exc(d.exception);
  if (Array.isArray(d.types)) {
    out.types = d.types.slice(0, MAX_DETAIL_ITEMS).map((t) => Object.assign({ type: t.type, ok: t.ok === true, recorded: t.recorded === true, reason: kort(t.reason, 300) },
      t.via ? { via: t.via } : {}, Array.isArray(t.unresolved_block_defects) ? { unresolved_block_defects: t.unresolved_block_defects.slice(0, MAX_DETAIL_ITEMS) } : {}, t.exception ? { exception: exc(t.exception) } : {}, t.waiting_on_owner ? { waiting_on_owner: exc(t.waiting_on_owner) } : {}));
  }
  if (Array.isArray(d.shape_why) && d.shape_why.length) out.shape_why = d.shape_why.slice(0, 5).map((s) => kort(s, 200));
  if (d.harness && typeof d.harness === 'object') out.harness = d.harness; // A2: counts + ids/reasons only (built by evaluateDispatchHarness)
  if (d.skill_delivery && typeof d.skill_delivery === 'object') out.skill_delivery = d.skill_delivery; // SK1: agent types + skill names only
  if (d.next_step) out.next_step = kort(d.next_step, 300);
  if (d.message) out.message = { en: kort(d.message.en, 900), nl: kort(d.message.nl, 900) };
  return out;
}

function checkSatisfied(rule, ctx) {
  const c = rule.check;
  let satisfied = false;
  if (c.type === 'event-present') {
    satisfied = hasEvent(ctx.events, c.key);
    if (satisfied && c.binding === 'scribe-ledger') {
      const b = scribeReconcileBinding(rule, ctx);
      ctx._v2Detail = b; // reported in result.rule_details (why the reconciliation is stale, not only that it is)
      satisfied = b.ok;
    }
  }
  else if (c.type === 'independent-verification') {
    const iv = independentVerification(ctx.events, { commitSha: ctx.commitSha, noGit: ctx.noGit, evidenceDigest: ctx.evidenceDigest, evidenceLegacyDigests: ctx.evidenceLegacyDigests, evidenceAllGreen: ctx.evidenceAllGreen, evidenceFailed: ctx.evidenceFailed, evidenceCommit: ctx.evidenceCommit, knownAgents: ctx.knownAgents, runId: ctx.runId });
    satisfied = iv.ok;
    ctx._independentVerification = iv; // reden meegeven aan de rapportage (F-12)
  }
  else if (c.type === 'artifact-present') satisfied = hasArtifact(ctx.artifacts, c.key);
  else if (c.type === 'doctor-check') satisfied = hasDoctorRun(ctx.events);
  else if (V2_CHECK_TYPES.has(c.type)) {
    const detail = evaluateV2(rule, ctx);
    ctx._v2Detail = detail; // reported in result.rule_details (why it is open, not only that it is)
    satisfied = detail.ok === true;
  }
  else if (c.type === RUN_EVIDENCE_TYPE) {
    const detail = evaluateRunEvidence(rule, ctx); // I.6
    ctx._shapeDetail = detail; // reported in result.rule_details + result.exceptions
    satisfied = detail.ok === true;
  }

  /** RC-DOMAIN-BYPASS (out-p5.md) — TWO compounding defects, not one:
   *   (1) `{}` here starved forge-evidence.cjs's own artifactsOnDisk() of a runDir, so it always returned
   *       {verified:false} for every claimed artifact and evidenceCheck() fell back to trusting the bare
   *       claim — fixed by threading ctx.runDir through.
   *   (2) the domain-aware check only ever ran `if (!satisfied ...)` — an OR, never an override. So even
   *       with (1) fixed AND an explicit real domain passed, the cheap generic hasEvent() (ANY
   *       browser_screenshot_captured event, any path, real or fabricated) already set satisfied=true and
   *       the stronger, domain-specific 3-breakpoint check never even ran. REPRODUCED: an explicit
   *       domain:"website" plus one browser_screenshot_captured event naming a NONEXISTENT file still
   *       returned "web-responsive-evidence" satisfied.
   *   Fix (2) is DELIBERATELY SCOPED by `rule.trigger`, not blanket-authoritative for every domain_aware
   *   rule: 'web-responsive-evidence' triggers ONLY on 'web' — its domain is the entire reason it applies
   *   at all, and its own rule text demands the specific 3-breakpoint set, so a real domain match makes the
   *   stronger check AUTHORITATIVE both ways (grant AND revoke). 'evidence-satisfied' triggers 'always' and
   *   its OWN documented rule text says "either a generic evidence-fact event, OR (when a real domain is
   *   known) the domain's full required-evidence.json set" — an explicit OR, never a narrowing — so for an
   *   'always'-triggered rule the domain-aware result only ever ADDS a way to satisfy it, never revokes a
   *   real generic evidence-fact the rule already accepted on its own documented terms. */
  /** V25 (2026-09-24 THIRD Codex recheck, out-p8.md remaining gap) — this branch used to consult only the
   *  single ctx.domain value (the caller's resolved domain), so an unrelated/unknown override domain could
   *  starve the domain-specific check entirely and silently fall back to the generic, revocable event-present
   *  signal above. It now iterates ctx.domainCandidates: every domain the CALLER-INDEPENDENT rule.trigger
   *  actually matches (precomputed by the caller; falls back to [ctx.domain] for any caller that has not been
   *  updated to pass the new field, so this stays backward-compatible) — and applies each rule's own
   *  documented strictness contract (see RC-DOMAIN-BYPASS doc above) across that whole set instead of one
   *  caller-chosen value. */
  if (c.domain_aware === true) {
    const candidates = [...new Set((Array.isArray(ctx.domainCandidates) ? ctx.domainCandidates : (ctx.domain ? [ctx.domain] : [])).filter(Boolean))];
    if (candidates.length) {
      const verify = loadVerifyTool();
      if (verify && typeof verify.evidenceCheck === 'function') {
        const results = [];
        for (const d of candidates) {
          try {
            const res = verify.evidenceCheck(ctx.events, d, { runDir: ctx.runDir });
            if (res) results.push(res);
          } catch { /* this ONE candidate domain's evidence check threw — treated as unavailable for it only */ }
        }
        if (results.length) {
          if (rule.trigger !== 'always') satisfied = results.every((r) => r.ok === true); // domain IS why this rule applies — every domain it genuinely applies under must hold
          else if (results.some((r) => r.ok === true)) satisfied = true; // 'always' rule: any matching domain's proof only ADDS a path, never revokes
        }
      }
    }
  }
  return satisfied;
}

const OWNER_PROFILE_PATH = path.join(__dirname, '..', 'FORGE_OWNER_PROFILE.json');
/** ownerProfileDefault() -> this installation's owner profile (WP 2.1). An installed copy in a legacy project:
 *  OWNER_PROFILE_PATH exactly as before. In the forge layout: .forge/memory/FORGE_OWNER_PROFILE.json, falling back to
 *  the .claude copy until it exists. A plugin copy: the discovered project's profile (OWNER_PROFILE_PATH when none). */
function ownerProfileDefault() {
  const name = 'FORGE_OWNER_PROFILE.json';
  if (!DEFAULT_ROOT) return OWNER_PROFILE_PATH;
  try {
    if (forgePaths && typeof forgePaths.memoryFile === 'function' && forgePaths.layout(DEFAULT_ROOT) === 'forge') return forgePaths.memoryFile(DEFAULT_ROOT, name, { read: true });
  } catch { /* an unjudgeable layout reads the legacy file below */ }
  return DEFAULT_ROOT === path.resolve(__dirname, '..', '..') ? OWNER_PROFILE_PATH : path.join(DEFAULT_ROOT, '.claude', name);
}

/** isMeaningfulReason(reason, ruleId) -> boolean — true only when `reason` is a non-blank string that says
 *  MORE than just the bare rule id or the bare "override:<ruleId>" token (V9-fix, DEFECT 2: the doctor's own
 *  doctor_check_overrides model already demands a real, non-blank reason for exactly this honesty purpose —
 *  mirrored here, plus the extra "not just the bare token" guard this ask specifically requires so a lazy
 *  `reason:"override:dispatch-logged"` can never itself masquerade as an explanation). Mentioning the rule id
 *  ALONGSIDE real explanatory text is fine (e.g. "dispatch-logged waived — see run.json") — only a reason
 *  that reduces to NOTHING once the bare token is removed is rejected. */
function isMeaningfulReason(reason, ruleId) {
  if (typeof reason !== 'string') return false;
  const trimmed = reason.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  const idLower = String(ruleId).toLowerCase();
  const bareToken = 'override:' + idLower;
  if (lower === bareToken || lower === idLower) return false;
  const stripped = lower.split(bareToken).join(' ').split(idLower).join(' ').trim();
  return stripped.length > 0;
}

/** loadOwnerAllowlist(rulesData, opts) -> Set<string> — the lowercased set of owner ids a `by` field is
 *  allowed to match (V9-fix, DEFECT 2). Reads BOTH: (1) FORGE_HARD_RULES.json's own top-level
 *  `owners_allowlist` array (the primary, in-repo source of truth this project owns), and (2)
 *  FORGE_OWNER_PROFILE.json's optional `owner_id` (or `prefs.owner_id.value`) field, if either project ever
 *  seeds one — additive, never a replacement. A missing/malformed/absent source contributes nothing (never
 *  throws); when NEITHER source configures any id the returned set is EMPTY, which findOwnerOverride() below
 *  treats as "no override can ever be recognized" — fail CLOSED, never "any `by` value is accepted". */
function loadOwnerAllowlist(rulesData, opts) {
  const ids = new Set();
  if (rulesData && Array.isArray(rulesData.owners_allowlist)) {
    for (const id of rulesData.owners_allowlist) if (typeof id === 'string' && id.trim()) ids.add(id.trim().toLowerCase());
  }
  const profilePath = (opts && opts.ownerProfilePath) || ownerProfileDefault();
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const fromProfile = (profile && typeof profile.owner_id === 'string') ? profile.owner_id
      : (profile && profile.prefs && profile.prefs.owner_id && typeof profile.prefs.owner_id.value === 'string') ? profile.prefs.owner_id.value
      : null;
    if (fromProfile && fromProfile.trim()) ids.add(fromProfile.trim().toLowerCase());
  } catch { /* profile missing/malformed -> contributes no id, never a crash (same tolerant-degrade discipline as the rest of this file) */ }
  return ids;
}

/** findOwnerOverride(events, ruleId, ownerAllowlist) -> {reason,by}|null — recognizes an override ONLY from
 *  an explicit, structured, attributed, affirmative owner act (V9-fix, 2026-07-22 — break-swarm DEFECT 2/3;
 *  see file header doc for the full model). Requires ALL of, on the SAME event:
 *    - event_type is (case-insensitively) "owner_override" — never merely an agent_note;
 *    - `rule` is a string and EXACT-matches ruleId (no substring/prefix/negation matching — a mention of the
 *      rule id inside a longer or negated string, or a different rule id that happens to share a prefix,
 *      never matches);
 *    - `reason` passes isMeaningfulReason() (non-blank, more than just the bare token);
 *    - `by` is a non-blank string that appears (case-insensitively) in `ownerAllowlist` — an empty allowlist
 *      can never match anything, by construction (fail-closed).
 *  Returns the FIRST match, carrying the real reason/by as proof — never a bare boolean, so an override is
 *  always independently inspectable. */
function findOwnerOverride(events, ruleId, ownerAllowlist) {
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.event_type !== 'string' || e.event_type.toLowerCase() !== 'owner_override') continue;
    if (typeof e.rule !== 'string' || e.rule !== ruleId) continue;
    if (!isMeaningfulReason(e.reason, ruleId)) continue;
    const by = (typeof e.by === 'string') ? e.by.trim() : '';
    if (!by || !ownerAllowlist.has(by.toLowerCase())) continue;
    return { reason: String(e.reason).trim(), by };
  }
  return null;
}

/**
 * check({ run_id, domain }, opts) -> { ok, run_id, domain, satisfied, missing, warnings, overridden }
 * See file header for the full contract. Throws on a usage error (missing/invalid run_id, unreadable
 * events.jsonl, malformed FORGE_HARD_RULES.json) — never on a normal, even fully-empty, run.
 */
function check(params, opts) {
  params = params || {};
  opts = opts || {};
  if (!params.run_id || typeof params.run_id !== 'string') {
    throw new Error('forge-runcontract: check() requires a non-empty "run_id" string');
  }
  // an explicit phase judges only the rules due by then; absent = 'complete' = every rule (unchanged).
  const explicitPhase = (params.phase === undefined || params.phase === null) ? null : String(params.phase);
  if (explicitPhase !== null && !KNOWN_PHASES.includes(explicitPhase)) {
    throw new Error('forge-runcontract: check() phase must be one of ' + KNOWN_PHASES.join('|') + ', got ' + JSON.stringify(params.phase));
  }
  const phase = explicitPhase || DEFAULT_PHASE;

  const root = rootOf(opts);
  const runDir = opts.runDir ? path.resolve(opts.runDir) : runDirOf(root, params.run_id);
  const eventsPath = opts.eventsPath || path.join(runDir, 'events.jsonl');
  const artifactsDir = path.dirname(eventsPath);

  const events = readEventsForCheck(eventsPath, params.run_id, opts);
  const artifacts = listRunArtifacts(artifactsDir);
  /** R6-06 (zesde herreview): `opts.root` stuurde run, registry, bewijs en HEAD, maar NIET de regelset —
   *  die viel terug op het `__dirname`-gebonden RULES_PATH van de installatie. `--root project-B` kon
   *  daardoor events uit B beoordelen tegen de regels van A en CONTRACT OK geven. De E2E verborg dat
   *  juist, omdat die het script naar de tijdelijke root kopieert. Eén root bepaalt nu ook de regels. */
  const meta = loadRulesMeta(opts.rulesPath || path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const rulesData = meta.data;
  const rules = rulesData.rules;
  const ownerAllowlist = loadOwnerAllowlist(rulesData, opts);

  // The run's own manifest, read best-effort for its DECLARED complexity. A missing/malformed run.json is
  // normal here (12 of this project's 30 runs have none) — it degrades to "nothing declared", never a throw.
  let runMeta = null;
  try { runMeta = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'run.json'), 'utf8')); } catch { runMeta = null; }
  const cx = resolveComplexity(events, runMeta, params.complexity, harnessUnitsFor(root, params.run_id, events));

  /** RC-DOMAIN-BYPASS (out-p5.md) — domain used to come ONLY from `params.domain`; a run whose
   *  own run.json genuinely declared `domain:"finance"` was silently read as domain:null the moment a
   *  caller (or the CLI's default invocation with no --domain) omitted it, skipping every domain-scoped
   *  rule for a run that plainly said what domain it was. Declared metadata now provides the FALLBACK; an
   *  explicit param still WINS (a caller may deliberately check under a different/narrower domain), but a
   *  genuine conflict between the two is reported rather than silently dropped, so a mismatch is visible
   *  instead of one value quietly overwriting the other with no trace. */
  const declaredDomain = (runMeta && typeof runMeta.domain === 'string' && runMeta.domain.trim()) ? runMeta.domain.trim() : null;
  const paramDomain = params.domain ? String(params.domain).trim() : null;
  const domain = paramDomain || declaredDomain || null;
  const domainOverridden = !!(paramDomain && declaredDomain && declaredDomain.toLowerCase() !== paramDomain.toLowerCase());
  const domainSource = paramDomain ? (domainOverridden ? 'param-override' : 'param') : (declaredDomain ? 'declared' : 'none');
  /** V25 (2026-09-24 second Codex recheck, out-p7.md) — `domain` above still gave the CALLER'S param
   *  unconditional precedence for RULE APPLICABILITY, not just for the reported label: `ruleApplies(rule,
   *  domain, ...)` only ever consulted the single winning value. REPRODUCED: a run.json declaring
   *  `domain:"finance"` (a correctness-critical domain, obligated to prove real fixtures) read as fully
   *  compliant the moment a caller checked it with `--domain api` — `domain_overridden:true` was reported,
   *  but nothing actually still required the finance obligation. A caller relabeling the check must not be
   *  able to WEAKEN what the run itself declared: on a genuine conflict, a rule now applies if it applies to
   *  EITHER the declared OR the param domain (the union of both obligation sets), so an explicit but
   *  narrower override can still legitimately ADD rules (the caller's own declared intent) without ever
   *  being able to drop the run's own declared ones. No conflict (equal, or only one present) is the
   *  ordinary single-domain case, unchanged. */
  // I.6: what the run itself declares (run.json / plan-card.json / anticipate.json) — the axis run-shape triggers read
  const runShape = readRunShape(artifactsDir);
  function ruleAppliesForRun(rule, complexity) {
    if (!domainOverridden) return ruleApplies(rule, domain, complexity, runShape);
    return ruleApplies(rule, declaredDomain, complexity, runShape) || ruleApplies(rule, paramDomain, complexity, runShape);
  }
  // V25 (2026-09-24 THIRD Codex recheck, out-p8.md remaining gap) — ruleAppliesForRun() above only decided
  // whether a domain_aware rule's OBLIGATION applies at all (the union). checkSatisfied()'s domain-specific
  // evidence check still received the single caller-resolved `domain` value, so an unrelated/unknown override
  // domain could starve that check of the ACTUAL domain that made the rule apply, silently falling back to
  // the generic (revocable) event-present signal. REPRODUCED: a website-declared run with a claimed-but-
  // nonexistent screenshot correctly failed under domain:"website", but passed under an unrelated
  // domain:"unknown-audit-domain" even though nothing about the real evidence changed. Fix: precompute, per
  // rule, every candidate domain whose OWN trigger genuinely matches (never the caller's unrelated override
  // alone) and hand the whole set to checkSatisfied — it evaluates non-'always' rules AUTHORITATIVELY across
  // that set (every matching domain must be satisfied) and 'always' rules ADDITIVELY (any matching domain
  // adds a path, never revokes), preserving each rule's own documented strictness contract from RC-DOMAIN-
  // BYPASS above, just no longer collapsed onto a single caller-chosen value.
  const candidateDomainPool = domainOverridden ? [declaredDomain, paramDomain] : [domain];

  /** V2 (part A): two reasons a rule is NOT judged on this run, decided up front so they apply to every
   *  path below (normal rules, unknown-trigger and unknown-type degrades alike):
   *   - phase_deferred    — its phase is later than the phase being checked (not due yet; never missing);
   *   - historical_exempt — it has a `since` date and this run started before it (see sinceExemption()).
   *  Neither is ever counted as satisfied, missing or warned. */
  const runStart = runStartedAt(events, runMeta);
  const phaseDeferred = [];
  const historicalExempt = [];
  // I.6: a KNOWN run-shape rule whose shape this run does not declare is not applicable, not "deferred" — kept out of
  // phase_deferred so a phased check of an older run reports exactly what it reported before these rules existed.
  const shapeAbsent = (r) => { const m = RUN_SHAPE_TRIGGER_RE.exec(r.trigger); return !!m && RUN_SHAPES.has(m[1]) && !runShape.applies[m[1]]; };
  for (const r of rules) {
    if (phaseRankOf(r.phase) > PHASE_RANK[phase]) { if (!shapeAbsent(r)) phaseDeferred.push(r.id); continue; }
    const ex = sinceExemption(r, runStart);
    if (ex) historicalExempt.push({ id: r.id, since: ex.since, reason: ex.reason });
  }
  const notJudgedIds = new Set([...phaseDeferred, ...historicalExempt.map((x) => x.id)]);

  const unknownTriggerIds = new Set(meta.unknownTriggers.map((u) => u.id));
  // S6: rules whose check.type this checker predates (meta.unknownCheckTypes is absent only on a cache entry
  // shaped by a caller that stubbed loadRulesMeta — treated as "none", never a crash).
  const unknownCheckTypeById = new Map((meta.unknownCheckTypes || []).map((u) => [u.id, u.check_type]));
  // a KNOWN type whose option value is newer than this checker degrades the same way, with its own reason
  const unknownCheckReasonById = new Map((meta.unknownCheckTypes || []).filter((u) => u.reason).map((u) => [u.id, u.reason]));
  const skewReason = (id) => (unknownCheckReasonById.has(id)
    ? 'check.type "' + unknownCheckTypeById.get(id) + '" uses an option this checker does not know (' + unknownCheckReasonById.get(id) + ')'
    : 'unknown check.type "' + unknownCheckTypeById.get(id) + '"');
  const satisfied = [];
  const missing = [];
  const warnings = [];
  const overridden = [];
  const exceptions = []; // I.6: rules (or parts) met by a RECORDED exception — reported, never a silent pass
  /** part ii: a rule with `applies_if_exists` (a project-relative path) applies only while that
   *  path exists under this root — the fail-safe for a capability a project may not have (owner-requests-reconciled
   *  applies only where the scribe has captured something). Reported here, never as satisfied, missing or warned. A
   *  checker older than this field ignores it and judges the rule as written (a warn rule there never turns a run red). */
  const notApplicable = [];
  // Rules this checker genuinely CANNOT judge (their trigger vocabulary or check type is newer than this
  // file). Reported, never silently treated as met or missing — see loadRulesMeta()'s doc for the fleet-skew
  // reasoning. `kind`/`applicable` (S6) tell the two cases apart: an unknown TRIGGER makes applicability
  // itself unknowable (applicable:null); an unknown CHECK TYPE under a known trigger does not.
  const unevaluated = meta.unknownTriggers.filter((u) => !notJudgedIds.has(u.id)).map((u) => Object.assign({
    id: u.id,
    trigger: u.trigger,
    kind: 'trigger',
    applicable: null,
    reason: 'unknown trigger "' + u.trigger + '" — this rules file is newer than forge-runcontract.cjs; rule skipped, not judged'
      + (unknownCheckTypeById.has(u.id) ? ' (its ' + skewReason(u.id) + ' too)' : ''),
  }, unknownCheckTypeById.has(u.id) ? { check_type: unknownCheckTypeById.get(u.id) } : {}));
  const unknownCheckTypeBlocking = []; // rule ids: unknown check type, known trigger, APPLIES, severity block

  const ruleDetails = {};
  /** R9-09/R9-06 (gehesen): één HEAD-resolutie en één bewijsset-lezing voor de HELE check — niet
   *  per regel opnieuw. De velden gaan ook mee in het resultaat (ruleset_sha256_used e.d.), dus ze
   *  moeten buiten de lus leven. */
  /** D2 fix (fresh-laptop re-audit) / 2.1 fix (same date, review C VERDICT FAIL) —
   *  `noGitAtRoot` is a REAL, INDEPENDENT probe of THIS root (never affected by a caller-supplied
   *  params.commit_sha override), so a caller who simply omitted commit_sha on a project that DOES have
   *  git can never be confused with a project that genuinely has none. It is now the THREE-WAY gitProbe(),
   *  and `noGitAtRoot` is true ONLY on its POSITIVELY confirmed 'no-repo' state — never on 'undetermined'
   *  (git missing, timed out, dubious-ownership/safe.directory refusal, a repo with no commits yet, a
   *  poisoned env). Before this fix both 'no-repo' and 'undetermined' collapsed onto the same `null`
   *  return from resolveHeadCommit(), so an UNDETERMINED root was silently treated exactly like a
   *  confirmed no-git one — review C's 2.1 finding. Only a genuinely git-less root (state:'no-repo')
   *  relaxes the completion event's commit_sha requirement below (see independentVerification's opts.noGit)
   *  — a project with real git, OR one this probe simply could not read, keeps the exact same fail-closed
   *  behaviour as before the D2 fix ever existed. */
  const gitProbeResult = gitProbe(root);
  const headCommitProbe = gitProbeResult.state === 'repo' ? gitProbeResult.commit : null;
  const noGitAtRoot = gitProbeResult.state === 'no-repo';
  const effectieveCommit = params.commit_sha !== undefined ? params.commit_sha : headCommitProbe;
  const evidenceSet = canonicalEvidenceDigest(root, params.run_id);
  for (const rule of rules) {
    if (notJudgedIds.has(rule.id)) continue; // phase_deferred / historical_exempt — see above
    if (unknownTriggerIds.has(rule.id)) continue;
    if (typeof rule.applies_if_exists === 'string' && !appliesPathExists(root, rule.applies_if_exists)) {
      notApplicable.push({ id: rule.id, reason: rule.applies_if_exists + ' does not exist in this project, so the rule does not apply' });
      continue;
    }
    if (unknownCheckTypeById.has(rule.id)) {
      // S6: the trigger IS known, so whether the obligation applies to this run is judgeable — only HOW to
      // check it is not. A non-applicable rule owes nothing (same as every other non-applicable rule), but the
      // version skew itself is still reported so a lagging checker is visible on every run.
      const ct = unknownCheckTypeById.get(rule.id);
      const applies = ruleAppliesForRun(rule, cx.level);
      unevaluated.push({
        id: rule.id, trigger: rule.trigger, check_type: ct, kind: 'check-type', applicable: applies,
        reason: skewReason(rule.id) + ' — this rules file is newer than forge-runcontract.cjs; '
          + (applies ? 'rule skipped, not judged' : 'the rule does not apply to this run (trigger "' + rule.trigger + '"), so nothing is owed, but the version skew is reported'),
      });
      if (applies && rule.severity === 'block') unknownCheckTypeBlocking.push(rule.id);
      continue;
    }
    if (!ruleAppliesForRun(rule, cx.level)) {
      /** F-09/punt 10: op L1 triggert deze regel niet. Stilzwijgen zou de gevaarlijkste uitkomst zijn —
       *  een lezer (of dashboard) leest "geen missing rules" dan als "onafhankelijk geverifieerd". Daarom
       *  expliciet NOT_APPLICABLE, zodat L1 nergens verificatie CLAIMT die niet heeft plaatsgevonden. */
      if (rule.check && rule.check.type === 'independent-verification') {
        ruleDetails['independent-verification'] = { ok: false, applicable: false, route: null, workers: [], reviewer: null, label_only: true, review: null, reason: 'NOT_APPLICABLE — deze regel geldt vanaf ' + rule.trigger + ' en deze run is ' + cx.level + '; er is dus GEEN onafhankelijke verificatie vastgesteld (dat is iets anders dan geslaagd)' };
      }
      continue;
    }
    /** F-12: de evaluator schreef zijn reden naar een WEGGEGOOIDE ctx, dus een rood contract toonde
     *  alleen de regel-ID — niet welke workers/reviewer of welke stale binding het afkeurde. Eén ctx die
     *  blijft leven, en de gesaneerde uitkomst gaat mee in `result.rule_details`. */
    /** R9-09 (negende herreview): alleen de CLI resolveerde HEAD. Productie-aanroepers (server.cjs,
     *  forge-doctor) riepen check() zonder commit_sha aan, waarna een TOEPASSELIJKE onafhankelijke
     *  verificatie altijd fail-closed rood werd — de poort blokkeerde dus op een detail van de
     *  aanroeper in plaats van op de werkelijkheid. check() resolveert nu zelf wanneer de aanroeper
     *  niets meegeeft; expliciet meegeven blijft winnen (tests kunnen zo een vaste commit forceren). */

    /** de canonicalizer werd DRIE KEER aangeroepen voor digest, allGreen en failed — drie losse
     *  lezingen van een bestand dat tussendoor kan wijzigen. Nu een keer lezen en dat ene resultaat
     *  gebruiken, zodat de drie velden gegarandeerd bij dezelfde bewijsset horen. */

    // the candidates this SPECIFIC rule's trigger genuinely matches (never a domain the rule would not
    // even apply under on its own) — see the doc above candidateDomainPool.
    const domainCandidatesForRule = candidateDomainPool.filter((d) => d && ruleApplies(rule, d, cx.level));
    /** the OLDER canonical evidence forms are accepted for a review binding ONLY when the
     *  caller says so — forge-finalize's acceptance path does, and only for a receipt on the checked-in
     *  legacy-receipt allowlist. A live run's review must pin the current (strict) form. */
    const legacyForms = opts.acceptLegacyEvidenceDigests === true ? ((evidenceSet || {}).legacy_digests || []) : [];
    const ruleCtx = { events, artifacts, domain, domainCandidates: domainCandidatesForRule, runDir: artifactsDir, commitSha: effectieveCommit || null, noGit: noGitAtRoot, evidenceDigest: (evidenceSet || {}).digest || null, evidenceLegacyDigests: legacyForms, evidenceAllGreen: (evidenceSet || {}).allGreen === true, evidenceFailed: ((evidenceSet || {}).failed || []).concat(((evidenceSet || {}).unverified || []).map((n) => n + ' (output unverified)')), evidenceCommit: (evidenceSet || {}).commit || null, knownAgents: knownAgentNames(root) || new Set(), root, ownerAllowlist, runShape, runId: params.run_id };
    const ruleSatisfied = checkSatisfied(rule, ruleCtx);
    if (ruleCtx._independentVerification) ruleDetails['independent-verification'] = sanitizeIv(ruleCtx._independentVerification);
    if (ruleCtx._v2Detail) ruleDetails[rule.id] = sanitizeV2(ruleCtx._v2Detail, rule.check.type);
    if (ruleCtx._shapeDetail) {
      ruleDetails[rule.id] = sanitizeRunEvidence(ruleCtx._shapeDetail);
      if (ruleSatisfied) exceptions.push(...exceptionsOf(rule.id, ruleCtx._shapeDetail));
    }
    if (ruleSatisfied) { satisfied.push(rule.id); continue; }

    // V9-fix (DEFECT 2): a rule flagged cannot_override:true is NEVER even eligible for the override lookup —
    // not "eligible but never matched", genuinely never consulted, so no future change to findOwnerOverride()
    // could ever accidentally clear one of these.
    if (rule.cannot_override !== true) {
      const ov = findOwnerOverride(events, rule.id, ownerAllowlist);
      if (ov) { overridden.push({ id: rule.id, reason: ov.reason, by: ov.by, note: 'owner_override by ' + ov.by + ': ' + ov.reason }); continue; }
    }

    if (rule.severity === 'block') missing.push(rule.id);
    else warnings.push(rule.id);
  }

  /** RC-UNKNOWN-RULE-GREEN (out-p5.md) — an unevaluated rule was reported in `unevaluated` but
   *  never affected `ok`, so a version-skewed rules file with an unsupported BLOCKING rule still produced
   *  CONTRACT OK — that obligation was never judged, yet the contract claimed satisfaction. An unevaluated
   *  ADVISORY (severity:"warn") rule is left alone (a caller cannot judge it either, and it never gated
   *  anyway). A blocking one now gets its own `missing`-equivalent entry, kept namespaced (`unknown-rule:<id>`)
   *  so it is never confused with a genuinely-evaluated-and-failed rule id in `missing`/rule_details. */
  const unknownBlocking = [];
  for (const u of meta.unknownTriggers) {
    if (notJudgedIds.has(u.id)) continue; // deferred/exempt rules owe nothing on this run, known or not
    const rule = rules.find((r) => r.id === u.id);
    if (rule && rule.severity === 'block') {
      const markerId = 'unknown-rule:' + u.id;
      unknownBlocking.push(markerId);
      ruleDetails[markerId] = { ok: false, applicable: null, reason: 'BLOCKING rule "' + u.id + '" uses an unknown trigger ("' + u.trigger + '") this checker cannot evaluate — a version-skewed rules file must never read as satisfied for an obligation nobody judged' };
    }
  }
  /** S6: the same marker for a BLOCKING rule whose check.type this checker predates and whose
   *  (known) trigger applies to this run. Deliberately NOT owner-overridable here, exactly like the
   *  unknown-trigger marker above: the fix for a lagging checker is to sync the checker, not to wave the
   *  rule through. A rules file that adds new check types at severity "warn" (migration step M3) therefore
   *  never turns an older checker's runs red; one that adds them at "block" does, honestly. */
  for (const id of unknownCheckTypeBlocking) {
    const markerId = 'unknown-rule:' + id;
    unknownBlocking.push(markerId);
    ruleDetails[markerId] = { ok: false, applicable: true, reason: 'BLOCKING rule "' + id + '" ' + (unknownCheckReasonById.has(id) ? '— its ' + skewReason(id) + ', so it' : 'uses an unknown check.type ("' + unknownCheckTypeById.get(id) + '") this checker') + ' cannot evaluate — a version-skewed rules file must never read as satisfied for an obligation nobody judged; sync forge-runcontract.cjs' };
  }
  if (unknownBlocking.length) missing.push(...unknownBlocking);

  /** RC-MANIFEST-STALE, part 2 (out-p5.md) — see manifestCompleteness()'s own doc above. An
   *  armed-but-never-finished (and never owner-skipped) work package retroactively invalidates a claimed
   *  evidence-satisfied/verify-checked pass: those rules must reflect real completion of the run's OWN
   *  declared plan, not merely "some accepted evidence event exists somewhere in the log". */
  const manifestState = manifestCompleteness(root, params.run_id, events, ownerAllowlist);
  if (manifestState.applicable) {
    if (!manifestState.ok) {
      // a load-failure reason (corrupt/unreadable/deleted-after-arm) carries no `outstanding` list at
      // all — use manifestState's own reason instead of an empty-list sentence in that case.
      const reason = manifestState.outstanding.length
        ? 'armed manifest package(s) without a completion event or an owner-authenticated skip: '
          + manifestState.outstanding.map((o) => o.wp_id + ' (' + o.status + ')').join(', ')
        : (manifestState.reason || 'the run\'s manifest could not be confirmed complete');
      for (const gateId of MANIFEST_GATED_RULE_IDS) {
        const idx = satisfied.indexOf(gateId);
        if (idx !== -1) {
          satisfied.splice(idx, 1);
          if (!missing.includes(gateId)) missing.push(gateId);
          const prevReason = ruleDetails[gateId] && ruleDetails[gateId].reason;
          ruleDetails[gateId] = Object.assign({}, ruleDetails[gateId] || {}, { ok: false, reason: (prevReason ? prevReason + ' · ' : '') + 'RC-MANIFEST-STALE: ' + reason });
        }
      }
      ruleDetails['manifest-complete'] = { ok: false, applicable: true, outstanding: manifestState.outstanding, reason };
    } else {
      ruleDetails['manifest-complete'] = { ok: true, applicable: true, outstanding: [] };
    }
  }

  const result = {
    ok: missing.length === 0, run_id: params.run_id, domain, satisfied, missing, warnings, overridden,
    // RC-DOMAIN-BYPASS: a caller/reader must be able to see whether the effective domain came from an
    // explicit --domain, the run's own declared run.json, or neither — and whether the two disagreed.
    domain_source: domainSource, domain_declared: declaredDomain, domain_overridden: domainOverridden,
    // F-12: waarom een keyloze check faalde/slaagde, gesaneerd — anders toont een rood contract alleen een ID
    rule_details: ruleDetails,
    // complexity_* is reported on EVERY result, even when no rule is scoped to it — a caller must always be
    // able to see which level a verdict was reached at, and whether that level was declared or only derived.
    complexity: cx.level, complexity_source: cx.source, complexity_declared: cx.declared,
    complexity_derived: cx.derived, complexity_units: cx.units, complexity_harness_units: cx.harness_units,
    unevaluated,
    /** wat DIT proces werkelijk las. Een aanroeper (finalize) kan zelf alleen eindpunten
     *  vergelijken; het venster waarin dit kind las blijft dan onzichtbaar (A→B→A). Door de gebruikte
     *  hashes in het resultaat te rapporteren, kan finalize zijn eigen pins tegen de WERKELIJK
     *  beoordeelde staat leggen in plaats van tegen een herlezenaanname. */
    ruleset_sha256_used: meta.sha256 || null,
    evidence_digest_used: (evidenceSet || {}).digest || null,
    evidence_commit_used: (evidenceSet || {}).commit || null,
    // V2 (part A): which phase was judged, what was not due yet, what is exempt by its `since` date, and
    // the start time those `since` dates were compared with — so "not judged" is never mistaken for "met".
    phase, phase_deferred: phaseDeferred, historical_exempt: historicalExempt,
    not_applicable: notApplicable, // rules whose applies_if_exists path is absent in this project
    run_started_at: runStart ? runStart.iso : null, run_started_source: runStart ? runStart.source : null,
    ruleset_version_used: (rulesData.version === undefined ? null : rulesData.version),
    // I.6: the shape this run declares (what the run-shape rules read) and every rule met by a recorded exception
    run_shape: summarizeRunShape(runShape), exceptions,
  };

  // gate_evaluated proof event (2026-08-02, opt-in — the gap this closes: this checker existed, was
  // tested, and was cited by FORGE_HARD_RULES.json since V9, yet across 846 real events in 31 runs not
  // ONE gate_evaluated was ever logged, because nothing emitted it. A gate that evaluates silently is
  // indistinguishable from a gate that never ran. Same one-act discipline as forge-manifest's
  // manifest_armed: the check and its proof happen together; a logging failure is reported honestly in
  // result.logged but NEVER flips the verdict — the evaluation already happened.
  if (opts.logEvent === true) result.logged = logGateEvaluated(result, explicitPhase ? Object.assign({}, opts, { phase: explicitPhase }) : opts);

  return result;
}

// The ONE event writer a project has is <root>/.claude/forge-dashboard/log-event.cjs — spawned rather
// than re-implemented, so hash-chaining/honesty-stamping/strict validation are never bypassed (identical
// pattern to forge-manifest.cjs::logManifestArmed, deliberately, so there is one convention to learn).
// ROOT CONTAINMENT: the writer is resolved under the SAME root the check evaluated —
// never via __dirname. The old __dirname resolution made every foreign-root caller (hermetic tests,
// doctor suite runs, post-install validation in a fresh target) write real gate_evaluated events into
// THIS install's .claude/forge-runs/ — the "run-complete" pollution found in the project, the canonical
// template, and every fresh install target. A root without its own writer is reported honestly as
// {logged.ok:false}; it must never silently fall back to another install's writer.
function logEventScriptFor(root) {
  return path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
}

/** logGateEvaluated(result, opts) -> {ok, event_type, reason?, status?} — best-effort, never throws. */
function logGateEvaluated(result, opts) {
  opts = opts || {};
  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  if (!root && !opts.logEventPath) return { ok: false, event_type: 'gate_evaluated', reason: 'no project root found (no .claude, .forge or .git above the current folder; pass --root)' };
  const script = opts.logEventPath || logEventScriptFor(root);
  if (!opts.logEventPath && !fs.existsSync(script)) {
    return { ok: false, event_type: 'gate_evaluated', reason: 'no event writer under this root (' + script + ' missing) — refusing cross-install fallback' };
  }
  // an explicitly phased check says so in the note AND in a `phase` field, so a preview/wp PASS can never
  // be read as a full completion PASS by anyone scanning gate_evaluated events. A phase-less check is unchanged.
  const phaseTag = opts.phase && opts.phase !== DEFAULT_PHASE ? ' [phase ' + opts.phase + ']' : '';
  const note = (result.ok
    ? 'run contract' + phaseTag + ' PASSED — ' + result.satisfied.length + ' rule(s) satisfied'
    : 'run contract' + phaseTag + ' NOT DONE — missing: ' + result.missing.join(', '))
    + (result.complexity ? ' · complexity ' + result.complexity + ' (' + result.complexity_source + ')' : '')
    + (result.overridden.length ? ' · ' + result.overridden.length + ' overridden' : '')
    + (result.warnings.length ? ' · warnings: ' + result.warnings.join(', ') : '')
    + (result.unevaluated && result.unevaluated.length ? ' · unevaluated: ' + result.unevaluated.map((u) => u.id).join(', ') : '')
    + (result.exceptions && result.exceptions.length ? ' · exceptions: ' + [...new Set(result.exceptions.map((x) => x.id))].join(', ') : '');
  const ev = { run_id: result.run_id, event_type: 'gate_evaluated', agent: 'orchestrator', note, ok: result.ok };
  if (opts.phase) ev.phase = opts.phase;
  let res;
  try {
    const { spawnSync } = require('child_process'); // lazy — a plain check() never needs it
    res = spawnSync(process.execPath, [script, JSON.stringify(ev)], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, event_type: 'gate_evaluated', reason: 'could not spawn log-event.cjs: ' + e.message };
  }
  if (res.error) return { ok: false, event_type: 'gate_evaluated', reason: 'could not spawn log-event.cjs: ' + res.error.message };
  if (res.status !== 0) {
    return { ok: false, event_type: 'gate_evaluated', status: res.status, reason: 'log-event.cjs exited ' + res.status + ': ' + String(res.stderr || '').trim() };
  }
  return { ok: true, event_type: 'gate_evaluated', status: 0 };
}

// =====================================================================================================
// COMPLETION RECIPE (S2, S4, S5).
// ONE completion order, read from the registry's `completion_sequence` (data in FORGE_HARD_RULES.json), and
// judged here for three callers that must never disagree about it:
//   - completionGate() — log-event.cjs runs it IN-PROCESS before it writes run_completed, the one choke point
//                         every completion passes through: the complete-phase contract plus every sequence
//                         step BEFORE run-completed. The finalize receipt is deliberately not part of it —
//                         finalize comes after run_completed and refuses without it.
//   - planFor()        — `forge-runcontract plan --run <id>`: the next unmet obligations (phase-aware) and every
//                         sequence step marked done/pending with the exact command to run.
//   - forge-doctor.cjs — the enforced run_contract check reads the same run state and steps.
// Measured gap this closes: 19 of 42 completed runs logged run_completed with no gate_evaluated,
// 28 of 42 were never finalized, and the documented order contradicted the code (S2).
// =====================================================================================================
const DEFAULT_COMPLETION_SEQUENCE = [
  // the same step 1 command as the registry — a test gate runs through the forge-testrun wrapper
  { step: 1, id: 'gate-evidence', action: 'record the raw evidence of every gate that ran (exit code + output hash per gate)', command: 'node .claude/forge-bin/forge-gate-evidence.cjs --run <run_id> --gate "<name>::node .claude/forge-bin/forge-testrun.cjs -- <test command>" [--gate ...]' },
  // E.1: step 2 names the self-review section printer (the report needs a '## Self-review' section, end-self-review rule)
  { step: 2, id: 'final-report', action: 'write the honest final report, with its Self-review section (answer every question, then record the answers)', command: 'node .claude/forge-bin/forge-endreview.cjs template --run <run_id>', produces: 'final-report.md in the run folder' },
  { step: 3, id: 'contract-check', action: 'judge the complete contract and log the proof', command: 'node .claude/forge-bin/forge-runcontract.cjs check --run <run_id> --log-event' },
  { step: 4, id: 'run-completed', action: 'log run_completed', command: 'node .claude/forge-dashboard/log-event.cjs <run_id> run_completed \'{"agent":"orchestrator","summary":"..."}\'' },
  { step: 5, id: 'finalize', action: 'write the one authoritative receipt', command: 'node .claude/forge-bin/forge-runcontract.cjs check --run <run_id> --log-event --finalize' },
];
const RUN_COMPLETED_STEP_ID = 'run-completed';
// Mirrors forge-finalize.cjs POST_COMPLETION_ALLOWED: after run_completed only audit events may follow; anything
// else re-opens the run (finalize refuses it with "werk-event na run_completed").
const POST_COMPLETION_AUDIT_TYPES = new Set(['run_finalized', 'gate_evaluated', 'contract_checked']);
// An honest FAILURE close is not a completion claim: run_completed carrying one of these as status/outcome/
// verdict/result closes the run as failed. The gate does not apply to it (there is nothing to be green about),
// and finalize still refuses such a run, so it can never be passed off as done.
// 'incomplete' and 'partial' close the run honestly too — a run_completed that says so claims
// no completion. log-event.cjs carries a byte-identical MIRROR of these two constants for the moment this module
// cannot be loaded; log-event-completion-gate.test.cjs asserts the parity.
const FAILURE_CLOSE_FIELDS = ['status', 'outcome', 'verdict', 'result'];
const FAILURE_CLOSE_RE = /^(?:fail|failed|failure|aborted|abandoned|cancell?ed|blocked|refused|incomplete|partial)$/i;
const PLAN_MAX_LINES = 40;
const PLAN_MAX_OBLIGATION_LINES = 12;

/** isAdvisoryFlagged(s) — the registry marks a step advisory with severity 'warn' or blocks:false. */
function isAdvisoryFlagged(s) {
  return !!s && (s.blocks === false || (typeof s.severity === 'string' && s.severity.trim().toLowerCase() === 'warn'));
}

/** completionSequenceOf(rulesData) -> {steps, advisory, source:'registry'|'built-in', note?}. A rules file without a
 *  valid completion_sequence (an older registry) gets the built-in default, said out loud — never an empty recipe.
 *  `steps` are the JUDGED completion steps (the gate, finalize's re-check, plan and the doctor
 *  read only these); `advisory` are steps AFTER the finalize step that the registry flags advisory (severity warn /
 *  blocks:false, e.g. step 6 handoff) — listed, never judged, never blocking. An advisory flag on a step before
 *  finalize (or in a sequence without a finalize step) is ignored: registry data can add advice, never weaken the
 *  gate. */
function completionSequenceOf(rulesData) {
  const raw = rulesData && rulesData.completion_sequence;
  const valid = Array.isArray(raw) && raw.length > 0
    && raw.every((s) => s && typeof s === 'object' && Number.isFinite(s.step) && typeof s.id === 'string' && s.id.trim());
  if (!valid) {
    return { steps: DEFAULT_COMPLETION_SEQUENCE.map((s) => Object.assign({}, s)), advisory: [], source: 'built-in', note: 'the rules registry carries no valid completion_sequence — the built-in default (same five steps) is used' };
  }
  const all = raw.map((s) => Object.assign({}, s)).sort((a, b) => a.step - b.step);
  const fin = all.find((s) => s.id === 'finalize');
  const advisory = all.filter((s) => fin && s.step > fin.step && isAdvisoryFlagged(s));
  return { steps: all.filter((s) => !advisory.includes(s)), advisory, source: 'registry' };
}

/** isFailureClose(e) — run_completed that honestly reports a failure (see FAILURE_CLOSE_RE). */
function isFailureClose(e) {
  if (!e || typeof e !== 'object') return false;
  return FAILURE_CLOSE_FIELDS.some((f) => typeof e[f] === 'string' && FAILURE_CLOSE_RE.test(e[f].trim()));
}

/** runStateOf(events) -> where the run stands, from its own events only:
 *    status 'empty' | 'preview' (no work yet) | 'working' | 'completed' (the last run_completed is a success
 *           claim) | 'closed-failed' (the last run_completed is an honest failure close and nothing but audit
 *           events follow it) | 'reopened' (a failure close followed by more non-audit work — no claim stands)
 *    phase  'preview' | 'wp' | 'complete' — which obligations are due by now.
 *  a completion claim is STICKY. A non-audit event appended after a successful
 *  run_completed used to flip the run to 'reopened' — and the doctor then read it as "in progress", so one
 *  agent_note dropped an unfinalized completion claim out of the enforced check. The run now stays 'completed'
 *  (completion_claimed:true) with the later event in after_completion / work_after_completion; only a finalize
 *  that succeeds (after a new run_completed) or an explicit failure close resolves the claim. */
function runStateOf(events) {
  const evs = Array.isArray(events) ? events : [];
  let lastWork = -1, completed = -1, work = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (typeOf(e) === 'run_completed') { completed = i; continue; }
    if (isWorkEvent(e)) { lastWork = i; work++; }
  }
  let tail = null;
  if (completed >= 0) {
    for (let i = completed + 1; i < evs.length; i++) {
      if (!POST_COMPLETION_AUDIT_TYPES.has(typeOf(evs[i]))) { tail = { index: i, event_type: typeOf(evs[i]) }; break; }
    }
  }
  const closedAsFailure = completed >= 0 && isFailureClose(evs[completed]);
  const failureClose = closedAsFailure && !tail;
  let status;
  if (!evs.length) status = 'empty';
  else if (completed >= 0 && !closedAsFailure) status = 'completed'; // sticky, with or without a tail
  else if (completed >= 0 && !tail) status = 'closed-failed';
  else if (completed >= 0) status = 'reopened';
  else status = work ? 'working' : 'preview';
  const phase = (status === 'completed' || status === 'closed-failed') ? 'complete'
    : (status === 'working' || status === 'reopened') ? 'wp' : 'preview';
  const completedMs = completed >= 0 ? tsOf(evs[completed]) : null;
  return {
    status, phase, events: evs.length, work_events: work, last_work_index: lastWork,
    completed_index: completed, completion_claimed: status === 'completed', failure_close: failureClose,
    completed_at: completedMs === null ? null : new Date(completedMs).toISOString(), after_completion: tail,
    work_after_completion: status === 'completed' && tail !== null,
  };
}

/** freshContractProof(events, afterIndex) -> {index} | null — the proof step 3 leaves behind: the LATEST
 *  complete-phase gate_evaluated after the last work event must say ok:true. A red latest proof, a phased
 *  (preview/wp) proof, or one older than the last work event is not proof of the current state. */
function freshContractProof(events, afterIndex) {
  const evs = Array.isArray(events) ? events : [];
  for (let i = evs.length - 1; i > afterIndex; i--) {
    const e = evs[i];
    if (typeOf(e) !== 'gate_evaluated' || eventIsDisproven(e)) continue;
    if (e.phase !== undefined && e.phase !== null && String(e.phase) !== DEFAULT_PHASE) continue;
    return e.ok === true ? { index: i } : null;
  }
  return null;
}

/** COMPLETION_PROOF_CUTOFF — F01 (Codex adversarial review): a run that STARTED on/after this instant
 *  needs a VERIFIED receipt (FINALIZED, or HISTORICAL that finalize re-verified under the receipt's own pinned
 *  rules/commit, reverified:true) to count a completion step as done. An archival HISTORICAL record
 *  (reverified:false — legacy generation, ruleset without a pinned copy, unverified-archival) stays valid
 *  HISTORY for older runs but is labelled "archival, not a completion proof" and never satisfies completion for a
 *  run of the enforcement era. The registry may carry its own value under completion_proof.enforcement_cutoff. */
const COMPLETION_PROOF_CUTOFF = '2026-10-09T00:00:00Z';
function completionProofCutoffOf(rulesData) {
  const v = rulesData && rulesData.completion_proof && rulesData.completion_proof.enforcement_cutoff;
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : COMPLETION_PROOF_CUTOFF;
}
/** LEGACY_ALLOWLIST_GENERATIONS — the receipt generations a project's checked-in legacy-receipt allowlist may
 *  authenticate (the same two forge-finalize.cjs LEGACY_GENERATIONS knows; repeated here so this module stays
 *  loadable on its own — a test pins the two sets equal). */
const LEGACY_ALLOWLIST_GENERATIONS = new Set(['pre-evidence', 'pre-pinned-ruleset']);
/** ARCHIVAL_THREAT_NOTE — Codex R2 class B (owner decision O9): every archival label says what the proof model
 *  is and is not. Full statement: FORGE_HARD_RULES.json completion_proof._doc_threat_model. */
const ARCHIVAL_THREAT_NOTE = 'tamper-evident, not tamper-proof (owner decision O9)';
/** isAuthenticatedLegacy(fin) — R2/N03b: a non-re-verified HISTORICAL record is authenticated ONLY by the project's
 *  legacy-receipt allowlist (finalize's check() reports the matched generation as `allowlisted`). An
 *  'unverified-archival' record is never authenticated, allowlisted or not: its rules or raw outputs cannot be
 *  reproduced. */
function isAuthenticatedLegacy(fin) {
  return !!fin && typeof fin.allowlisted === 'string' && LEGACY_ALLOWLIST_GENERATIONS.has(fin.allowlisted) && fin.cause !== 'unverified-archival';
}
/** completionProofOf(fin, runStartMs, cutoff?) -> {ok, archival, pre_cutoff, unauthenticated?, reason} — does this
 *  finalize verdict PROVE completion for a run that started at runStartMs? An unknown start (null) is judged as
 *  enforcement-era (fail-closed: an undatable run must not dodge the cutoff).
 *  the cutoff exemption used to accept ANY non-re-verified HISTORICAL record of a
 *  pre-cutoff run — an 'unverified-archival' receipt (hand-edited pin, missing pinned rules, unreadable outputs)
 *  then read as done in plan and doctor. Now only FINALIZED, a re-verified HISTORICAL, or an allowlist-
 *  authenticated legacy record of a run started before the cutoff is a completion proof. Everything else is
 *  "archival, not a completion proof" for every run date; for a pre-cutoff run it is not red either
 *  (pre_cutoff:true lets the plan say 'archival' instead of 'red'). */
function completionProofOf(fin, runStartMs, cutoff) {
  const cutoffIso = cutoff || COMPLETION_PROOF_CUTOFF;
  const cutoffMs = Date.parse(cutoffIso);
  const preCutoff = typeof runStartMs === 'number' && Number.isFinite(runStartMs) && runStartMs < cutoffMs;
  if (!fin || typeof fin !== 'object') return { ok: false, archival: false, pre_cutoff: preCutoff, reason: 'no finalize verdict' };
  if (fin.verdict === 'FINALIZED') return { ok: true, archival: false, pre_cutoff: preCutoff, reason: 'FINALIZED — receipt current' };
  if (fin.verdict !== 'HISTORICAL') return { ok: false, archival: false, pre_cutoff: preCutoff, reason: acceptanceLabel(fin) };
  if (fin.reverified === true) return { ok: true, archival: false, pre_cutoff: preCutoff, reason: acceptanceLabel(fin) };
  if (!isAuthenticatedLegacy(fin)) {
    const what = fin.cause === 'unverified-archival' ? 'an unverified-archival record' : 'a record neither re-verified nor allowlisted';
    return { ok: false, archival: true, pre_cutoff: preCutoff, unauthenticated: true,
      reason: acceptanceLabel(fin) + ' — not a completion proof: ' + what + ' never proves completion' + (preCutoff ? ' (run predates the cutoff: archival, not red)' : '') + '; ' + ARCHIVAL_THREAT_NOTE };
  }
  if (preCutoff) return { ok: true, archival: true, pre_cutoff: true, reason: acceptanceLabel(fin) + ' — accepted as the allowlisted archival record of a run started before ' + cutoffIso + ' (' + ARCHIVAL_THREAT_NOTE + ')' };
  return { ok: false, archival: true, pre_cutoff: false, reason: acceptanceLabel(fin) + ' — not a completion proof: the run started ' + (runStartMs == null ? 'at an unknown time (judged as enforcement era)' : 'on/after ' + cutoffIso) + ', so an archival record is not accepted; it needs a re-verifiable receipt; ' + ARCHIVAL_THREAT_NOTE };
}

/** acceptanceLabel(fin) — plain words for a forge-finalize check() verdict. A HISTORICAL record is only ever
 *  called re-verified when finalize itself said reverified:true; anything else is "not re-verified" (S5).
 *  Whether such an archival record counts as a completion proof is completionProofOf()'s call, so the
 *  label itself no longer says either way. */
function acceptanceLabel(fin) {
  if (!fin || typeof fin !== 'object') return 'no finalize verdict';
  if (fin.verdict === 'FINALIZED') return 'FINALIZED — receipt current';
  if (fin.verdict === 'HISTORICAL') {
    const cause = fin.cause ? String(fin.cause) : 'unknown';
    return fin.reverified === true
      ? 'HISTORICAL — intact record, re-verified as of its own ' + (fin.judged_under === 'pinned-ruleset' ? 'pinned ruleset/commit' : 'commit/domain') + ' (cause ' + cause + ')'
      : 'HISTORICAL — archival record, not re-verified (cause ' + cause + (fin.allowlisted ? ', allowlisted ' + fin.allowlisted : ', not allowlisted') + ')';
  }
  if (fin.verdict === 'STALE') return 'STALE — ' + String(fin.reason || 'the receipt no longer holds').slice(0, 200);
  if (fin.verdict === 'UNDETERMINED') return 'UNDETERMINED — ' + String(fin.reason || 'not confirmable right now').slice(0, 200);
  if (fin.verdict === 'NOT_FINALIZED') return 'not finalized';
  return String(fin.verdict || 'unknown verdict');
}

function finalizeVerdictOf(root, runId) {
  let F;
  try { F = require(path.join(__dirname, 'forge-finalize.cjs')); } catch (e) { return { verdict: 'UNAVAILABLE', reason: 'forge-finalize.cjs could not be loaded (' + (e && e.message ? e.message : String(e)) + ')' }; }
  try { return F.check(root, runId); } catch (e) { return { verdict: 'UNAVAILABLE', reason: 'forge-finalize check threw (' + (e && e.message ? e.message : String(e)) + ')' }; }
}

/** evaluateCompletionStep(step, ctx) -> {step, id, action, command, status, detail}. status: done | pending |
 *  red | n/a | unevaluated | archival (R2/N03b: finalize only — an unauthenticated archival receipt of a run that
 *  started before the cutoff: history, neither done nor red). A step id this checker does not know (a newer
 *  registry) is 'unevaluated': reported and never counted as met; outside strict mode it is not counted against
 *  the run, under strict (completionGate opts.strict, and always in finalize) it is unmet. Never throws. */
function evaluateCompletionStep(step, ctx) {
  const command = typeof step.command === 'string' ? step.command.split('<run_id>').join(ctx.runId) : null;
  const out = (status, detail) => ({ step: step.step, id: step.id, action: step.action || null, command, status, detail: String(detail || '').slice(0, 300) });
  try {
    const st = ctx.state;
    switch (step.id) {
      case 'gate-evidence': {
        if (!fs.existsSync(path.join(ctx.runDir, 'gate-evidence.json'))) return out('pending', 'no gate-evidence.json in the run folder yet');
        const set = canonicalEvidenceDigest(ctx.root, ctx.runId);
        if (!set) return out('red', 'gate-evidence.json is present but is not a valid evidence set (every gate needs a command, an output file and hash, a verified exit code, a stable clean commit or an honest no-git mark, and the matching run_id) — record it again');
        if (set.allGreen !== true) return out('red', 'gate evidence has failing gate(s): ' + (set.failed || []).join(', '));
        return out('done', set.gates + ' gate(s) recorded, all green' + (set.no_git ? ' (no-git project)' : ''));
      }
      case 'final-report':
        return hasArtifact(ctx.artifacts, 'final-report')
          ? out('done', 'final-report.md is present and non-empty')
          : out('pending', 'write a non-empty ' + runFolderLabel(ctx) + '/final-report.md with a ## Self-review section, then forge-endreview.cjs record --run ' + ctx.runId + ' --answers <answers.json> (log report_generated before step 3)');
      case 'contract-check': {
        const c = ctx.contract;
        if (!c) return out('unevaluated', 'the contract could not be evaluated');
        if (c.ok !== true) return out('red', 'contract NOT DONE — missing: ' + (c.missing || []).join(', '));
        const proof = freshContractProof(ctx.events, st.last_work_index);
        if (!proof) return out('pending', 'the contract is green, but no ok:true gate_evaluated (complete phase) was logged after the last work event — run the command, it logs the proof');
        return out('done', 'contract green; proof gate_evaluated #' + proof.index);
      }
      case 'run-completed':
        // work after a standing claim keeps the claim open — red until a new run_completed (then finalize) or a failure close
        if (st.status === 'completed' && st.after_completion) return out('red', 'run_completed #' + st.completed_index + ' is a standing completion claim, but ' + st.after_completion.event_type + ' #' + st.after_completion.index + ' came after it — the claim stays open: log run_completed again once steps 1-3 are green and finalize, or close the run as failed');
        if (st.status === 'completed') return out('done', 'run_completed logged (#' + st.completed_index + ')');
        if (st.status === 'closed-failed') return out('n/a', 'closed as failed (run_completed #' + st.completed_index + ' carries a failure status) — no completion is claimed');
        if (st.status === 'reopened') return out('pending', 'run_completed #' + st.completed_index + ' was a failure close followed by ' + st.after_completion.event_type + ' #' + st.after_completion.index + ' — no completion is claimed; log run_completed once steps 1-3 are green');
        return out('pending', 'not logged yet');
      case 'finalize': {
        if (st.status === 'closed-failed') return out('n/a', 'a run closed as failed is not finalized');
        if (!fs.existsSync(path.join(ctx.runDir, 'run-finalized.json'))) {
          return out('pending', st.status === 'completed' ? 'run_completed is logged but no receipt exists — run the command' : 'after step 4');
        }
        const fin = ctx.finalizeVerdict();
        if (fin.verdict === 'FINALIZED' || fin.verdict === 'HISTORICAL') {
          /** an archival (not re-verified) record satisfies the step only when it is allowlist-
           *  authenticated AND the run started before the cutoff. An unauthenticated archival record (unverified-
           *  archival) never does: for a pre-cutoff run the step reads 'archival' (history, not red), otherwise red. */
          const start = runStartedAt(ctx.events, null);
          const proof = completionProofOf(fin, start ? start.ms : null, ctx.completionProofCutoff);
          const status = proof.ok ? 'done' : (proof.archival && proof.pre_cutoff ? 'archival' : 'red');
          return Object.assign(out(status, proof.reason), { verdict: fin.verdict, cause: fin.cause, reverified: fin.reverified === true, completion_proof: proof.ok, archival: proof.archival });
        }
        if (fin.verdict === 'STALE') return Object.assign(out('red', acceptanceLabel(fin)), { verdict: fin.verdict });
        return Object.assign(out('unevaluated', acceptanceLabel(fin) + (fin.reason && fin.verdict === 'UNAVAILABLE' ? ' (' + fin.reason + ')' : '')), { verdict: fin.verdict });
      }
      default:
        return out('unevaluated', 'this checker does not know completion step "' + step.id + '" (the registry is newer) — reported, never counted as met');
    }
  } catch (e) {
    return out('unevaluated', 'could not be judged (' + (e && e.message ? e.message : String(e)) + ')');
  }
}

/** evaluateAdvisoryStep(step, ctx) -> {step, id, action, command, status:'advisory', due, severity, blocks, detail}
 *. An advisory step is never done/pending/red: nothing judges it, so nothing can block on it. `due` is
 *  true once the run holds a completion proof (ctx.completionProof) or was closed as failed — from then on the plan
 *  prints its command. Never throws. */
function evaluateAdvisoryStep(step, ctx) {
  const command = typeof step.command === 'string' ? step.command.split('<run_id>').join(ctx.runId) : null;
  const closed = !!(ctx.state && ctx.state.status === 'closed-failed');
  const due = ctx.completionProof === true || closed;
  const out = (detail) => ({ step: step.step, id: step.id, action: step.action || null, command, status: 'advisory', due, severity: 'warn', blocks: false, detail: String(detail).slice(0, 300) });
  if (step.id === 'handoff') {
    return due
      ? out((closed ? 'the run is closed' : 'the run is finalized') + ' — hand the mission over now: snapshot + scribe digest; more than one open mission phase -> start the next phase in a fresh session (/clear)')
      : out('after step 5: write the snapshot and print the scribe digest; more than one open mission phase -> the next phase starts in a fresh session (/clear)');
  }
  return out('advisory step from the registry — listed, never judged, never blocks');
}

/** summarizeContract(c) — the compact contract view the gate, plan and doctor share (ids + short reasons). */
function summarizeContract(c) {
  if (!c) return null;
  const why = (id) => { const d = c.rule_details && c.rule_details[id]; return d && d.reason ? String(d.reason).slice(0, 200) : null; };
  return {
    ok: c.ok === true, phase: c.phase, complexity: c.complexity, complexity_source: c.complexity_source, domain: c.domain,
    missing: (c.missing || []).slice(), warnings: (c.warnings || []).slice(),
    missing_details: (c.missing || []).map((id) => ({ id, reason: why(id) })),
    warning_details: (c.warnings || []).map((id) => ({ id, reason: why(id) })),
    overridden: (c.overridden || []).map((o) => o.id), unevaluated: (c.unevaluated || []).map((u) => u.id),
    historical_exempt: (c.historical_exempt || []).map((x) => x.id),
    exceptions: [...new Set((c.exceptions || []).map((x) => x.id))], // I.6: met by a recorded exception, never silently
  };
}

function runPaths(params, opts) {
  if (!params || !params.run_id || typeof params.run_id !== 'string') throw new Error('forge-runcontract: a non-empty "run_id" string is required');
  if (!/^[A-Za-z0-9_-]+$/.test(params.run_id)) throw new Error('forge-runcontract: invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + params.run_id);
  const root = rootOf(opts);
  const runDir = runDirOf(root, params.run_id);
  return { root, runDir, eventsPath: path.join(runDir, 'events.jsonl'), rulesPath: (opts && opts.rulesPath) || path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json') };
}

/** completionGate({run_id, event?, domain?, complexity?}, {root?, rulesPath?, extraEvents?, ownerProfilePath?, strict?})
 *  -> {ok, applicable, run_id, steps:[the steps before run-completed], unmet:[ids], contract, warnings,
 *      warning_details, failure_close?, empty?, reason?, plan_command, strict, unevaluated_rules}
 *  The run_completed choke point. `event` is the run_completed about to be written (an honest failure
 *  close is not gated); `extraEvents` are batch lines the writer validated but has not appended yet. Throws on
 *  a tool/config failure (rules unreadable, damaged log) — the CALLER decides that a tool failure never blocks.
 *  opts.strict: a step this checker could not judge ('unevaluated' — an unknown step id
 *  from a newer registry, or a contract that could not be evaluated) is UNMET, and so is a contract rule that
 *  applies but cannot be judged (contract.unevaluated). Without strict both stay reported-only (behaviour). */
function completionGate(params, opts) {
  params = params || {}; opts = opts || {};
  const p = runPaths(params, opts);
  const planCommand = 'node .claude/forge-bin/forge-runcontract.cjs plan --run ' + params.run_id;
  if (params.event && isFailureClose(params.event)) {
    return { ok: true, applicable: false, failure_close: true, run_id: params.run_id, steps: [], unmet: [], contract: null, warnings: [], warning_details: [], plan_command: planCommand,
      reason: 'run_completed carries a failure status — an honest failure close claims no completion, so the completion sequence does not apply (finalize still refuses such a run)' };
  }
  const meta = loadRulesMeta(p.rulesPath);
  const seq = completionSequenceOf(meta.data);
  const rc = seq.steps.find((s) => s.id === RUN_COMPLETED_STEP_ID);
  const pre = seq.steps.filter((s) => (rc ? s.step < rc.step : (s.id !== 'finalize')));
  const extra = Array.isArray(opts.extraEvents) ? opts.extraEvents : [];
  if (!fs.existsSync(p.eventsPath) && !extra.length) {
    const empty = pre.map((s) => ({ step: s.step, id: s.id, action: s.action || null, command: typeof s.command === 'string' ? s.command.split('<run_id>').join(params.run_id) : null, status: 'pending', detail: 'this run has no events before run_completed' }));
    return { ok: false, applicable: true, empty: true, run_id: params.run_id, steps: empty, unmet: empty.map((s) => s.id), contract: null, warnings: [], warning_details: [], sequence_source: seq.source, plan_command: planCommand,
      reason: 'this run has no events before run_completed — nothing was started, planned or checked' };
  }
  const contract = check({ run_id: params.run_id, phase: DEFAULT_PHASE, domain: params.domain, complexity: params.complexity }, { root: p.root, rulesPath: p.rulesPath, extraEvents: extra, ownerProfilePath: opts.ownerProfilePath });
  const events = readEventsForCheck(p.eventsPath, params.run_id, { extraEvents: extra });
  const ctx = { root: p.root, runId: params.run_id, runDir: p.runDir, events, state: runStateOf(events), contract, artifacts: listRunArtifacts(p.runDir), finalizeVerdict: () => finalizeVerdictOf(p.root, params.run_id) };
  const steps = pre.map((s) => evaluateCompletionStep(s, ctx));
  const strict = opts.strict === true;
  const unmet = steps.filter((s) => isUnmetStep(s, strict)).map((s) => s.id);
  const summary = summarizeContract(contract);
  const unevaluatedRules = summary.unevaluated.slice();
  return {
    ok: contract.ok === true && unmet.length === 0 && !(strict && unevaluatedRules.length), applicable: true, run_id: params.run_id, steps, unmet,
    contract: summary, warnings: summary.warnings, warning_details: summary.warning_details,
    sequence_source: seq.source, plan_command: planCommand, strict, unevaluated_rules: unevaluatedRules,
  };
}
/** isUnmetStep(s, strict) — pending/red always; 'unevaluated' only under strict. done, n/a and archival
 *  never (archival only exists on the finalize step, which no pre-completion gate judges). */
function isUnmetStep(s, strict) {
  if (!s) return true;
  if (s.status === 'pending' || s.status === 'red') return true;
  return strict === true && s.status === 'unevaluated';
}

/** completionSequenceAtClose({run_id, domain?, commit_sha?}, {root?, rulesPath?, contract?, events?})
 *  -> {applicable, ok, steps, unmet, completed_index, sequence_source, reason}
 *  finalize's OWN re-check of the completion sequence. The writer's gate is WARN by
 *  default, so run_completed can be written over an unmet sequence; finalize used to re-run only the contract, so
 *  a claim made before the contract was proven (the proof logged only afterwards by `check --log-event
 *  --finalize`) was sealed as if the sequence had been followed. Here the steps before run-completed are judged
 *  AS OF the terminal run_completed: the fresh complete-phase proof must lie between the last work event and that
 *  claim; gate evidence and the final report are judged as they are now (files carry no log position). Strict:
 *  an unknown or unevaluated step is unmet. `opts.contract` is the contract result finalize already holds (its
 *  ok decides the contract-check step); without it check() runs here. `opts.events` lets finalize pass the
 *  chain-verified entries it already read.
 *  Scope: ONLY when the ruleset DECLARES completion_sequence. The sequence is part of the rules a receipt pins; a
 *  registry without one (an older synced project, a minimal fixture) is judged by the contract only, as before. */
function completionSequenceAtClose(params, opts) {
  params = params || {}; opts = opts || {};
  const p = runPaths(params, opts);
  const meta = loadRulesMeta(p.rulesPath);
  const seq = completionSequenceOf(meta.data);
  const base = { completed_index: -1, sequence_source: seq.source, steps: [], unmet: [] };
  if (seq.source !== 'registry') {
    return Object.assign(base, { applicable: false, ok: true, reason: 'the ruleset declares no completion_sequence — finalize judges the contract only (as before)' });
  }
  const events = Array.isArray(opts.events) ? opts.events : readEventsJsonl(p.eventsPath, params.run_id);
  let ci = -1;
  for (let i = events.length - 1; i >= 0; i--) { if (typeOf(events[i]) === 'run_completed') { ci = i; break; } }
  if (ci < 0) return Object.assign(base, { applicable: true, ok: false, reason: 'no run_completed in the log — nothing was claimed' });
  const preEvents = events.slice(0, ci);
  const rc = seq.steps.find((s) => s.id === RUN_COMPLETED_STEP_ID);
  const preSteps = seq.steps.filter((s) => (rc ? s.step < rc.step : (s.id !== 'finalize')));
  let contract = opts.contract || null;
  if (!contract) {
    const checkParams = { run_id: params.run_id, phase: DEFAULT_PHASE, domain: params.domain };
    if (params.commit_sha !== undefined) checkParams.commit_sha = params.commit_sha;
    contract = check(checkParams, { root: p.root, rulesPath: p.rulesPath });
  }
  const ctx = { root: p.root, runId: params.run_id, runDir: p.runDir, events: preEvents, state: runStateOf(preEvents), contract, artifacts: listRunArtifacts(p.runDir), finalizeVerdict: () => ({ verdict: 'UNAVAILABLE', reason: 'not part of the pre-completion sequence' }) };
  const steps = preSteps.map((s) => {
    const r = evaluateCompletionStep(s, ctx);
    // the contract-check detail speaks of "the last work event"; here the proof must ALSO precede the claim
    if (r.id === 'contract-check' && r.status === 'pending') r.detail = ('no ok:true complete-phase gate_evaluated between the last work event and run_completed #' + ci + ' — the claim was made before the contract was proven green').slice(0, 300);
    return r;
  });
  const unmet = steps.filter((s) => isUnmetStep(s, true)).map((s) => s.id);
  return Object.assign(base, {
    applicable: true, ok: unmet.length === 0, steps, unmet, completed_index: ci,
    reason: unmet.length ? 'the completion sequence was not met when run_completed #' + ci + ' was logged: ' + steps.filter((s) => isUnmetStep(s, true)).map((s) => 'step ' + s.step + ' ' + s.id + ' ' + s.status + ' (' + String(s.detail).slice(0, 160) + ')').join('; ') : 'every pre-completion step was met when run_completed #' + ci + ' was logged',
  });
}

/** howTo(rule, contract, id) — one short, honest hint for an unmet obligation (never "just log the event": an
 *  event-present rule is met by a real event of that kind, and the hint says so). */
function howTo(rule, contract, id) {
  const d = contract && contract.rule_details ? contract.rule_details[id] : null;
  if (!rule) return d && d.reason ? String(d.reason).slice(0, 180) : 'this checker cannot judge it — sync forge-runcontract.cjs with the rules file';
  const c = rule.check || {};
  if (c.type === 'event-present') {
    const keys = toArray(c.key);
    return 'when it really happened, log ' + keys.slice(0, 3).join(' / ') + (keys.length > 3 ? ' / … (' + keys.length + ' kinds)' : '');
  }
  if (c.type === 'artifact-present') return 'write a non-empty ' + toArray(c.key).join(' / ') + ' file in the run folder';
  // I.6: the rule's own next command (run id filled in), else its owner-facing message
  if (c.type === RUN_EVIDENCE_TYPE && d && (d.next_step || d.message)) return String(d.next_step || d.message.en).slice(0, 240);
  if (c.type === RUN_EVIDENCE_TYPE && (rule.next_step || rule.message)) return String(rule.next_step || rule.message.en).split('<run_id>').join((contract && contract.run_id) || '<run_id>').slice(0, 240);
  if (d && d.reason) return String(d.reason).slice(0, 180);
  return String(rule.rule || '').slice(0, 180);
}

/** classifyObligations(rules, contract, state) -> [{id, severity, phase, due, reason, how}] sorted: overdue,
 *  then due-now, then later; blocking before warn. `due` is relative to where the run stands: a rule whose
 *  phase is earlier than the run's phase is overdue, the same phase is due now, a later one is not due yet.
 *  On a run that claimed completion (or closed) everything still unmet is overdue. */
function classifyObligations(rules, contract, state) {
  const byId = new Map((rules || []).map((r) => [r.id, r]));
  const cur = PHASE_RANK[state.phase];
  const closed = state.status === 'completed' || state.status === 'closed-failed';
  const out = [];
  const add = (id, severity) => {
    const rule = byId.get(id) || byId.get(String(id).replace(/^unknown-rule:/, '')) || null;
    const phase = rule && Object.prototype.hasOwnProperty.call(PHASE_RANK, rule.phase) ? rule.phase : DEFAULT_PHASE;
    const rank = PHASE_RANK[phase];
    const due = closed || rank < cur ? 'overdue' : rank === cur ? 'due-now' : 'later';
    const d = contract.rule_details && contract.rule_details[id];
    out.push({ id, severity, phase, due, reason: d && d.reason ? String(d.reason).slice(0, 200) : null, how: howTo(rule, contract, id) });
  };
  for (const id of contract.missing || []) add(id, 'block');
  for (const id of contract.warnings || []) add(id, 'warn');
  const dueRank = { overdue: 0, 'due-now': 1, later: 2 };
  return out.sort((a, b) => (dueRank[a.due] - dueRank[b.due]) || ((a.severity === 'block' ? 0 : 1) - (b.severity === 'block' ? 0 : 1)) || (PHASE_RANK[a.phase] - PHASE_RANK[b.phase]));
}

function nextOf(state, obligations, sequence) {
  if (state.status === 'closed-failed') return { kind: 'closed', text: 'closed as failed — nothing to finalize; further work needs a new run' };
  const open = obligations.find((o) => o.severity === 'block' && (o.due === 'overdue' || o.due === 'due-now'));
  if (state.status !== 'completed' && open) return { kind: 'obligation', id: open.id, text: open.id + ': ' + open.how };
  const step = sequence.find((s) => s.status === 'pending' || s.status === 'red');
  if (!step) return { kind: 'done', text: 'every completion step is done' };
  if (step.id === 'contract-check' && step.status === 'red') {
    const firstMissing = obligations.find((o) => o.severity === 'block');
    return { kind: 'obligation', id: firstMissing ? firstMissing.id : step.id, text: firstMissing ? firstMissing.id + ': ' + firstMissing.how : step.detail };
  }
  const prefix = (state.status === 'working' || state.status === 'preview' || state.status === 'empty') && step.step <= 3 ? 'when the work is done — ' : '';
  return { kind: 'step', id: step.id, step: step.step, text: prefix + 'step ' + step.step + ' ' + step.id + ': ' + (step.command || step.detail) };
}

/** scribeSummaryOf(root) -> null when the scribe is not in use here (no .claude/forge-scribe/ledger.jsonl), else
 *  {open, done_unacked, deferred} read through the project's OWN forge-scribe.cjs gate() (read-only: it folds the
 *  ledger tail in memory and writes nothing), or {error} when that cannot be read. `open` = what the gate blocks on
 *  (unclassified, open, planned, in-progress). part ii. Never throws. */
function scribeSummaryOf(root) {
  try {
    if (!fs.existsSync(path.join(statePath(root, 'scribe', true), 'ledger.jsonl'))) return null;
    const tool = path.join(root, '.claude', 'forge-bin', 'forge-scribe.cjs');
    if (!fs.existsSync(tool)) return { error: 'forge-bin/forge-scribe.cjs is missing' };
    const g = require(tool).gate({ root });
    const counts = g && g.counts && typeof g.counts === 'object' ? g.counts : {};
    // Codex R3 SC-03/SC-06: agent-proposed deferrals wait for the owner; a broken chain/anchor is named, never hidden
    return { open: Array.isArray(g.blocking) ? g.blocking.length : 0, done_unacked: counts.done_unacked || 0, deferred: counts.deferred || 0,
      defer_proposed: counts.defer_proposed || counts['defer-proposed'] || 0, problems: Array.isArray(g.problems) ? g.problems.length : 0 };
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0].slice(0, 160) };
  }
}

/** planFor({run_id, domain?, complexity?, commit_sha?}, {root?, rulesPath?, ownerProfilePath?}) -> the plan:
 *  {run_id, state, contract, obligations, sequence, sequence_source, next, preview_check_command, ms}. Read-only
 *  (never logs, never writes). Throws on a usage/config error (missing run, unreadable rules, damaged log). */
function planFor(params, opts) {
  params = params || {}; opts = opts || {};
  const t0 = Date.now();
  const p = runPaths(params, opts);
  const meta = loadRulesMeta(p.rulesPath);
  const seq = completionSequenceOf(meta.data);
  const events = readEventsJsonl(p.eventsPath, params.run_id);
  const state = runStateOf(events);
  const checkParams = { run_id: params.run_id, domain: params.domain, complexity: params.complexity };
  if (params.commit_sha !== undefined) checkParams.commit_sha = params.commit_sha;
  const contract = check(checkParams, { root: p.root, rulesPath: p.rulesPath, ownerProfilePath: opts.ownerProfilePath });
  let finCache;
  const ctx = { root: p.root, runId: params.run_id, runDir: p.runDir, events, state, contract, artifacts: listRunArtifacts(p.runDir), finalizeVerdict: () => (finCache || (finCache = finalizeVerdictOf(p.root, params.run_id))), completionProofCutoff: completionProofCutoffOf(meta.data) };
  const sequence = seq.steps.map((s) => evaluateCompletionStep(s, ctx));
  let obligations = classifyObligations(meta.data.rules, contract, state);
  /** S5: a run whose receipt still holds (FINALIZED, or HISTORICAL = an intact record) is judged by that
   *  receipt, not by a live re-run of the contract against today's rules and HEAD. The live result stays
   *  visible, labelled informational, and the steps before finalize read "sealed by the receipt".
   *  ONLY a receipt that is a completion proof seals the run (FINALIZED, re-verified
   *  HISTORICAL, or an archival record of a run started before the cutoff). An archival record of an
   *  enforcement-era run seals nothing: the steps keep their live status and the finalize step is red. */
  const finStep = sequence.find((s) => s.id === 'finalize');
  let finalized = null;
  if (finStep && (finStep.verdict === 'FINALIZED' || finStep.verdict === 'HISTORICAL')) {
    finalized = { verdict: finStep.verdict, cause: finStep.cause || null, reverified: finStep.reverified === true, completion_proof: finStep.completion_proof === true, archival: finStep.archival === true, label: finStep.detail };
    if (finalized.completion_proof) {
      for (const s of sequence) {
        if (s.id !== 'finalize' && s.status !== 'done' && s.status !== 'n/a') {
          s.detail = ('sealed by the receipt — live re-check today: ' + s.detail).slice(0, 300);
          s.status = 'done';
        }
      }
      obligations = obligations.map((o) => Object.assign({}, o, { due: 'informational' }));
    }
  }
  // advisory steps after finalize (step 6 handoff) — listed after the sequence, never judged
  const advisory = (seq.advisory || []).map((s) => evaluateAdvisoryStep(s, Object.assign({}, ctx, { completionProof: !!(finalized && finalized.completion_proof) })));
  const handoffStep = advisory.find((s) => s.id === 'handoff' && s.due);
  return {
    run_id: params.run_id, state, contract: summarizeContract(contract), obligations, sequence, finalized, advisory,
    sequence_source: seq.source, sequence_note: seq.note || null,
    next: finalized && finalized.completion_proof ? { kind: 'done', text: 'finalized — ' + finalized.label + (handoffStep ? ' · then hand off (advisory step ' + handoffStep.step + ', see below)' : '') }
      : finalized ? { kind: 'archival', id: 'finalize', text: 'receipt is an archival record, not a completion proof — ' + finalized.label + '; owner review needed (a sealed log cannot be re-finalized)' }
        : nextOf(state, obligations, sequence),
    preview_check_command: 'node .claude/forge-bin/forge-runcontract.cjs check --run ' + params.run_id + ' --phase preview --log-event',
    scribe: scribeSummaryOf(p.root), // the owner-requests line (null when the scribe is not in use here)
    ms: Date.now() - t0,
  };
}

/** formatPlan(plan) -> text, at most PLAN_MAX_LINES lines (the rest is in --json). */
function formatPlan(plan) {
  const L = [];
  const c = plan.contract;
  L.push('PLAN ' + plan.run_id + ' — ' + plan.state.status + ' (phase ' + plan.state.phase + ') · complexity ' + c.complexity + ' (' + c.complexity_source + ') · contract '
    + (c.ok ? 'OK' : 'NOT DONE (' + c.missing.length + ' missing)') + (c.warnings.length ? ' · ' + c.warnings.length + ' warning(s)' : ''));
  // one line about the owner's captured requests, only where the scribe is in use (second line: never cut)
  if (plan.scribe) {
    L.push(plan.scribe.error
      ? 'scribe: unreadable (' + plan.scribe.error + ') — node .claude/forge-bin/forge-scribe.cjs verify-chain'
      : 'scribe: ' + plan.scribe.open + ' open / ' + plan.scribe.done_unacked + ' done-unacked' + (plan.scribe.defer_proposed ? ' / ' + plan.scribe.defer_proposed + ' defer-proposed (owner ack needed)' : '')
        + (plan.scribe.deferred ? ' / ' + plan.scribe.deferred + ' deferred' : '') + (plan.scribe.problems ? ' / ' + plan.scribe.problems + ' integrity problem(s): node .claude/forge-bin/forge-scribe.cjs verify-chain' : '')
        + (plan.scribe.open ? ' — node .claude/forge-bin/forge-scribe.cjs list --status unclassified,open,planned,in-progress' : ''));
  }
  const info = plan.obligations.filter((o) => o.due === 'informational');
  const now = plan.obligations.filter((o) => o.due === 'overdue' || o.due === 'due-now');
  const later = plan.obligations.filter((o) => o.due === 'later');
  if (plan.finalized) {
    L.push((plan.finalized.completion_proof ? 'Finalized: ' : 'Receipt (archival, NOT a completion proof): ') + plan.finalized.label);
    if (info.length) L.push('Live re-check today (informational — the receipt is authoritative): ' + info.map((o) => o.id).join(', ').slice(0, 200));
  } else if (now.length) {
    L.push('Obligations due by now (' + now.length + '):');
    for (const o of now.slice(0, PLAN_MAX_OBLIGATION_LINES)) {
      L.push('  ' + (o.severity === 'block' ? '✗' : '⚠') + ' [' + o.severity + '/' + o.phase + '] ' + o.id + ' — ' + o.due + ' — ' + String(o.how).slice(0, 150));
    }
    if (now.length > PLAN_MAX_OBLIGATION_LINES) L.push('  … +' + (now.length - PLAN_MAX_OBLIGATION_LINES) + ' more (use --json)');
  } else {
    L.push('Obligations due by now: none open');
  }
  if (later.length) L.push('Not yet due (' + later.length + '): ' + later.map((o) => o.id).join(', ').slice(0, 220));
  if (c.exceptions && c.exceptions.length) L.push('Met by a recorded exception (visible, not a plain pass): ' + c.exceptions.join(', ').slice(0, 200));
  if (plan.state.status === 'preview' || plan.state.status === 'empty') L.push('Before the first work package: ' + plan.preview_check_command);
  L.push('Completion sequence (' + plan.sequence_source + '):');
  for (const s of plan.sequence) {
    L.push('  ' + s.step + ' [' + s.status + '] ' + s.id + ' — ' + String(s.detail).slice(0, 170));
    if (s.command && (s.status === 'pending' || s.status === 'red')) L.push('       → ' + s.command);
  }
  if (plan.sequence_note) L.push('  note: ' + plan.sequence_note);
  // advisory steps after finalize — their command is shown once they are due (the run is finalized/closed)
  if (Array.isArray(plan.advisory) && plan.advisory.length) {
    L.push('After completion (advisory, never blocks):');
    for (const s of plan.advisory) {
      L.push('  ' + s.step + ' [advisory] ' + s.id + ' — ' + String(s.detail).slice(0, 170));
      if (s.command && s.due) L.push('       → ' + s.command);
    }
  }
  L.push('Next: ' + String(plan.next.text).slice(0, 240));
  if (L.length > PLAN_MAX_LINES) {
    const cut = L.slice(0, PLAN_MAX_LINES - 1);
    cut.push('… ' + (L.length - PLAN_MAX_LINES + 1) + ' more line(s) — use --json');
    return cut.join('\n');
  }
  return L.join('\n');
}

// =====================================================================================================
// HANDOFF (usage audit U-02 "one session per mission"): completion_sequence step 6, advisory.
// `forge-runcontract.cjs handoff --run <id>` hands the mission over to the next session: it writes the snapshot
// (forge-snapshot.cjs, honouring the owner setting `snapshots`), refreshes and prints the scribe digest (where the
// scribe is in use), counts the open mission phases — this run's work packages without wp_completed/wp_failed, read
// through the registry's own wp-closure check — and prints one line of advice: more than one open phase -> start the
// next phase in a fresh session (/clear). It only reuses existing tools (sibling modules, never code from the target
// root) and it NEVER appends an event: an event after run_completed would re-open the run and stale its receipt.
// =====================================================================================================
const HANDOFF_DIGEST_MAX_CHARS = 1400;
const HANDOFF_IDS_SHOWN = 8;
const WP_CLOSURE_RULE_ID = 'wp-closure';
// the check the registry's wp-closure rule carries today; used only when the registry has no such rule
const WP_CLOSURE_FALLBACK_CHECK = { type: 'closure', open: 'agent_work_package_created', close: ['wp_completed', 'wp_failed'], key: 'wp_id', skip_rule: 'manifest-complete' };
const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
function softRequire(rel) { try { return require(path.join(__dirname, rel)); } catch { return null; } }

/** openPhasesOf(events, rulesData, opts) -> {count, opened, ids, unkeyed, reason} via evaluateClosure(). */
function openPhasesOf(events, rulesData, opts) {
  const rule = rulesData && Array.isArray(rulesData.rules)
    ? rulesData.rules.find((r) => r && r.id === WP_CLOSURE_RULE_ID && r.check && r.check.type === 'closure') : null;
  const c = evaluateClosure(rule ? rule.check : WP_CLOSURE_FALLBACK_CHECK, { events, ownerAllowlist: loadOwnerAllowlist(rulesData, opts) });
  const ids = c.unclosed.map((u) => (u.key ? String(u.key).replace(/^[^=]+=/, '') : '#' + u.index + ' (no wp_id)'));
  return { count: c.unclosed_count, opened: c.opened, ids, unkeyed: c.unkeyed, reason: c.reason };
}

/** handoffSnapshot(root, runId, opts) -> {written, skipped?, failed?, path, approx_tokens?, reason?, config_note?}. */
function handoffSnapshot(root, runId, opts) {
  // where the snapshot lives in this project's layout (legacy: exactly .claude/FORGE_SNAPSHOT.md as before; forge
  // layout: the active .forge/memory file) - shown when no snapshot path comes back from the writer
  let rel = '.claude/FORGE_SNAPSHOT.md';
  try {
    if (forgePaths && typeof forgePaths.memoryFile === 'function' && forgePaths.layout(root) === 'forge') rel = relPosix(root, forgePaths.memoryFile(root, 'FORGE_SNAPSHOT.md'));
  } catch { /* the legacy label */ }
  const cfg = opts.configModule !== undefined ? opts.configModule : softRequire('forge-config.cjs');
  let configNote = null;
  try {
    if (cfg && typeof cfg.safeGet === 'function') {
      const o = Object.assign({ fallback: true }, process.env.FORGE_PROJECT_ROOT ? {} : { projectRoot: root });
      const r = cfg.safeGet('snapshots', o);
      if (r && r.value === false) return { written: false, skipped: true, path: rel, reason: 'owner config snapshots=off — the snapshot was not written' };
      if (r && r.degraded) configNote = String(r.reason || 'settings degraded').slice(0, 200);
    }
  } catch (e) { configNote = 'owner settings unreadable (' + firstLine(e) + ') — snapshots treated as on'; }
  const mod = opts.snapshotModule !== undefined ? opts.snapshotModule : softRequire('forge-snapshot.cjs');
  if (!mod || typeof mod.write !== 'function') return { written: false, failed: true, path: rel, reason: 'forge-snapshot.cjs is not available next to forge-runcontract.cjs' };
  try {
    const w = mod.write({ root, runId, reason: 'phase' });
    const out = { written: true, path: w && w.path ? path.relative(root, w.path).split(path.sep).join('/') : rel, approx_tokens: w && Number.isFinite(w.approxTokens) ? w.approxTokens : null, snapshot_run: (w && w.runId) || null };
    if (configNote) out.config_note = configNote;
    return out;
  } catch (e) {
    return { written: false, failed: true, path: rel, reason: 'forge-snapshot write failed: ' + firstLine(e) };
  }
}

/** handoffScribe(root, opts) -> {in_use, ok?, refreshed?, path?, text?, open?, done_unacked?, reason?}. */
function handoffScribe(root, opts) {
  const scribeDir = statePath(root, 'scribe', true); // legacy: .claude/forge-scribe exactly as before
  if (!fs.existsSync(path.join(scribeDir, 'ledger.jsonl'))) {
    return { in_use: false, reason: 'the scribe is not in use here (no .claude/forge-scribe/ledger.jsonl)' };
  }
  const rel = relPosix(root, path.join(scribeDir, 'DIGEST.md'));
  const mod = opts.scribeModule !== undefined ? opts.scribeModule : softRequire('forge-scribe.cjs');
  if (!mod || typeof mod.digest !== 'function') return { in_use: true, ok: false, path: rel, reason: 'forge-scribe.cjs is not available next to forge-runcontract.cjs' };
  let text = null, refreshed = false, reason = null;
  try { text = mod.digest({ root, write: true }); refreshed = true; }
  catch (e) {
    reason = 'the digest file could not be refreshed (' + firstLine(e) + ')';
    try { text = mod.digest({ root }); } catch (e2) { reason += '; reading it failed too (' + firstLine(e2) + ')'; }
  }
  let open = null, doneUnacked = null;
  try {
    const g = typeof mod.gate === 'function' ? mod.gate({ root }) : null;
    if (g) { open = Array.isArray(g.blocking) ? g.blocking.length : null; doneUnacked = g.counts && Number.isFinite(g.counts.done_unacked) ? g.counts.done_unacked : null; }
  } catch { /* the counts are optional; the digest text carries them too */ }
  return { in_use: true, ok: text != null, refreshed, path: rel, text: text == null ? null : String(text).trim().slice(0, HANDOFF_DIGEST_MAX_CHARS), open, done_unacked: doneUnacked, reason };
}

/** handoffAdvice(phases, scribe) -> one line: the next step for this session. */
function handoffAdvice(phases, scribe) {
  const n = phases.count;
  let line;
  if (n == null) line = 'open mission phases unknown (' + (phases.reason || 'the run log could not be read') + ') — if more than one phase is still open, start the next one in a fresh session (/clear); the snapshot carries the mission';
  else if (n > 1) line = n + ' mission phases are still open — start the next phase in a fresh session (/clear) instead of continuing here; the snapshot and the scribe digest carry the mission across';
  else if (n === 1) line = '1 mission phase is still open (' + phases.ids[0] + ') — it may be finished in this session; /clear first if this session is already long (the snapshot carries it)';
  else line = 'no open work package in this run — one session per mission: start the next mission in a fresh session (/clear)';
  if (scribe && scribe.in_use && Number.isFinite(scribe.open) && scribe.open > 0) line += ' · scribe: ' + scribe.open + ' open owner request(s) — see the digest';
  return line;
}

/** handoffFor({run_id}, {root?, rulesPath?, ownerProfilePath?, snapshotModule?, scribeModule?, configModule?})
 *  -> {run_id, state, receipt_present, snapshot, scribe, open_phases, advice, event_logged:false, ms}. Throws only on a
 *  usage error (invalid run id, unknown run); every other part fails soft and says so in its own field. */
function handoffFor(params, opts) {
  params = params || {}; opts = opts || {};
  const t0 = Date.now();
  const p = runPaths(params, opts);
  if (!fs.existsSync(p.eventsPath)) throw new Error('forge-runcontract: run ' + params.run_id + ' has no events.jsonl under ' + p.runDir);
  let rulesData = null;
  try { rulesData = loadRulesMeta(p.rulesPath).data; } catch { rulesData = null; }
  let state = 'unreadable', phases = { count: null, opened: null, ids: [], unkeyed: 0, reason: null };
  try {
    const events = readEventsJsonl(p.eventsPath, params.run_id);
    state = runStateOf(events).status;
    phases = openPhasesOf(events, rulesData, opts);
  } catch (e) { phases.reason = 'the run log could not be read (' + firstLine(e) + ')'; }
  const snapshot = handoffSnapshot(p.root, params.run_id, opts);
  const scribe = handoffScribe(p.root, opts);
  return {
    run_id: params.run_id, state, receipt_present: fs.existsSync(path.join(p.runDir, 'run-finalized.json')),
    snapshot, scribe, open_phases: phases, advice: handoffAdvice(phases, scribe), event_logged: false, ms: Date.now() - t0,
  };
}

/** formatHandoff(h) -> text (about 25 lines at most; the digest is already capped). */
function formatHandoff(h) {
  const L = [];
  L.push('HANDOFF ' + h.run_id + ' — run ' + h.state + ' · finalize receipt ' + (h.receipt_present ? 'present' : 'absent'));
  const s = h.snapshot;
  L.push('snapshot: ' + s.path + ' — ' + (s.written ? 'written' + (s.approx_tokens ? ' (~' + s.approx_tokens + ' tokens)' : '') : s.skipped ? 'skipped: ' + s.reason : 'NOT WRITTEN: ' + s.reason));
  if (s.config_note) L.push('  note: ' + s.config_note);
  const sc = h.scribe;
  if (!sc.in_use) L.push('scribe digest: not in use here');
  else {
    L.push('scribe digest: ' + (sc.path || '(unknown)') + ' — ' + (sc.refreshed ? 'refreshed' : sc.ok ? 'read (not refreshed)' : 'unreadable') + (sc.reason ? ' (' + sc.reason + ')' : ''));
    for (const line of String(sc.text || '').split(/\r?\n/).filter((x) => x.trim()).slice(0, 12)) L.push('  ' + line.slice(0, 200));
  }
  const ph = h.open_phases;
  L.push(ph.count == null
    ? 'open mission phases: unknown — ' + (ph.reason || 'not computed')
    : 'open mission phases: ' + ph.count + (ph.opened != null ? ' of ' + ph.opened + ' work package(s)' : '') + (ph.count ? ' — ' + ph.ids.slice(0, HANDOFF_IDS_SHOWN).join(', ') + (ph.ids.length > HANDOFF_IDS_SHOWN ? ', …' : '') : '') + ' (no wp_completed/wp_failed; rule ' + WP_CLOSURE_RULE_ID + ')');
  L.push('Next: ' + h.advice);
  L.push('(no run event was logged: an event after run_completed would re-open the run)');
  return L.join('\n');
}

module.exports = {
  // the advisory step after finalize (handoff) and the one-session-per-mission helper
  evaluateAdvisoryStep, isAdvisoryFlagged, handoffFor, formatHandoff, openPhasesOf, handoffAdvice,
  independentVerification,
  // geëxporteerd zodat tests kunnen AFDWINGEN dat elk gebruikt eventtype echt bij de writer geregistreerd
  // staat (F-08) — een magic string die niemand kan loggen is een route die alleen op papier bestaat.
  NON_WORK_EVENT_TYPES, ASSIGNMENT_EVENT_TYPES, IV_DISPATCH_TYPES, isReviewDispatch, isWorkEventType, isWorkEvent, isStalingEvent, isGoedkeuring, knownAgentNames, REVIEW_START_TYPES, REVIEW_DONE_TYPES, resolveHeadCommit, canonicalEvidenceDigest,
  // lesson fix — log-event.cjs warns when a dispatch LOOKS like a reviewer role
  // but isReviewDispatch() still says work (e.g. a task/mission word outside REVIEW_WOORDEN); it must read
  // the SAME role pattern and field names this file enforces, never a re-typed copy that could drift.
  REVIEW_ROLE_RE, ROL_VELDEN,
  // (2.1) — the ONE shared, three-way git probe + its env hardening, so gate-evidence.cjs and
  // finalize.cjs can never independently disagree with check() about the same root.
  gitProbe, cleanGitEnv, hasGitEntryInAncestry,
  check, listRules, loadRules, loadRulesMeta, ruleApplies, checkSatisfied, findOwnerOverride, isMeaningfulReason, loadOwnerAllowlist,
  readEventsJsonl, listRunArtifacts, hasEvent, hasArtifact, logGateEvaluated, eventIsDisproven,
  // RC-MANIFEST-STALE — exported so a test can exercise the manifest-completeness gate and the
  // owner-authenticated per-package skip directly, without spawning the CLI.
  manifestCompleteness, findManifestSkip, MANIFEST_SKIP_RULE, MANIFEST_GATED_RULE_IDS,
  resolveComplexity, harnessUnitsFor, countUnits, levelFromUnits, declaredLevel, parseLevel, isValidTrigger, isWellFormedTrigger, isWellFormedCheckType,
  RULES_PATH, OWNER_PROFILE_PATH, KNOWN_TRIGGER_LITERALS, KNOWN_CHECK_TYPES, KNOWN_SEVERITIES,
  COMPLEXITY_TRIGGER_RE, DISPATCH_EVENT_TYPES, DECLARED_LEVEL_FIELDS,
  // V2 (part A): the four new check types, phase/since, and the file-touched baseline helpers
  // a run_started writer needs (snapshotFileHashes + fileTouchedTargets read the ONE registry, no second list).
  V2_CHECK_TYPES, KNOWN_PHASES, PHASE_RANK, FILE_HASHES_FIELD, FILE_NAMING_FIELDS,
  evaluateClosure, evaluateSequence, evaluateReaction, evaluateFileTouched, evaluateV2, validateV2Check,
  runStartedAt, sinceExemption, sinceMs, phaseRankOf, isSafeRelPath, snapshotFileHashes, fileTouchedTargets,
  // the completion recipe — the run_completed gate log-event.cjs runs in-process, the `plan`
  // view, and the shared run state the doctor's enforced run_contract check reads.
  completionGate, planFor, formatPlan, runStateOf, completionSequenceOf, isFailureClose, freshContractProof,
  evaluateCompletionStep, classifyObligations, acceptanceLabel, readEventsForCheck,
  // the ONE failure-close predicate (F04/F06 — finalize and the
  // log-event gate share it, never re-type it), the completion-proof cutoff rule and the event time reader
  // that prefers the writer-stamped ingested_at.
  FAILURE_CLOSE_FIELDS, FAILURE_CLOSE_RE, COMPLETION_PROOF_CUTOFF, completionProofCutoffOf, completionProofOf, tsOf,
  DEFAULT_COMPLETION_SEQUENCE, RUN_COMPLETED_STEP_ID, POST_COMPLETION_AUDIT_TYPES, PLAN_MAX_LINES,
  // Codex R2 class-A fixes: the authenticated-legacy rule, resolved-path containment,
  // strict step judgement + finalize's own sequence re-check, and the archival threat-model note (class B).
  isAuthenticatedLegacy, LEGACY_ALLOWLIST_GENERATIONS, ARCHIVAL_THREAT_NOTE, realpathOf, isInsideRoot,
  isUnmetStep, completionSequenceAtClose,
  // part ii: the plan's owner-requests line (scribe summary).
  scribeSummaryOf,
  // I.6: run-shape triggers and the run-evidence check (plan card, anticipation, craft review, parallelism)
  RUN_SHAPE_TRIGGER_RE, RUN_SHAPES, RUN_EVIDENCE_TYPE, RUN_EVIDENCE_KINDS, VISIBLE_DELIVERABLE_TYPES, CRAFT_EVIDENCE_TYPE, harnessHooksInstalled,
  PLAN_SCALE_MIN_PACKAGES, PLAN_SCALE_MIN_LANES, SERIAL_PLAN_MIN_PACKAGES, EXCEPTION_MIN_REASON,
  readRunShape, summarizeRunShape, evaluateRunEvidence, findShapeException, validateRunEvidenceCheck, exceptionsOf,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, run: null, domain: null, root: null, rules: null, complexity: null, json: false, logEvent: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run') opts.run = rest[++i];
    else if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--root') opts.root = rest[++i];
    else if (a === '--rules') opts.rules = rest[++i];
    else if (a === '--complexity') opts.complexity = rest[++i];
    else if (a === '--phase') opts.phase = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--log-event') opts.logEvent = true;
    else if (a === '--finalize') opts.finalize = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-runcontract.cjs check --run <id> [--domain <d>] [--complexity L1|L2|L3|L4] [--phase preview|wp|complete] [--root <projectRoot>] [--rules <path>] [--json] [--log-event] [--finalize]');
  console.error('       node forge-runcontract.cjs plan --run <id> [--domain <d>] [--complexity L1..L4] [--root <projectRoot>] [--rules <path>] [--json]');
  console.error('       node forge-runcontract.cjs handoff --run <id> [--root <projectRoot>] [--rules <path>] [--json]');
  console.error('  plan          read-only: the next unmet obligations (by phase) and the completion sequence, each step');
  console.error('                done/pending with the exact command — follow it to complete a run (WP-5)');
  console.error('  handoff       completion step 6 (advisory, WP-12b): write the snapshot, print the scribe digest and the');
  console.error('                open mission phases; more than one open -> start the next phase in a fresh session (/clear).');
  console.error('                Logs no event. Exit 0 = handed off, 1 = the snapshot could not be written, 2 = usage error');
  console.error('  --phase       judge only the rules due by that phase (default: complete = every rule); later-phase');
  console.error('                rules are listed as not yet due, never as missing. --finalize needs the complete phase');
  console.error('  --complexity  raise the run\'s fan-out level (it is otherwise read from run.json and/or derived from real');
  console.error('                dispatch volume; this flag can only RAISE, never lower — see resolveComplexity())');
  console.error('  --rules       evaluate against a specific FORGE_HARD_RULES.json (default: this project\'s own)');
  console.error('  --log-event   also append a gate_evaluated proof event to the run (via log-event.cjs, one act)');
  console.error('  --finalize    on a green contract, immediately run forge-finalize (the ONE authoritative DONE');
  console.error('                receipt) and require it green too — the canonical completion path in one command');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'plan') {
      // read-only, never logs. Exit 0 = a plan was computed (open obligations are its content, not an
      // error); 2 = usage/config error (no --run, unknown run, unreadable rules or a damaged log).
      if (!opts.run) {
        console.error('forge-runcontract: plan requires --run <id>');
        process.exitCode = 2;
      } else {
        const callOpts = {};
        if (opts.root) callOpts.root = opts.root;
        if (opts.rules) callOpts.rulesPath = opts.rules;
        const plan = planFor({ run_id: opts.run, domain: opts.domain, complexity: opts.complexity }, callOpts);
        console.log(opts.json ? JSON.stringify(plan) : formatPlan(plan));
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'handoff') {
      // completion step 6 (advisory). Never logs an event; a snapshot that could not be written is exit 1.
      if (!opts.run) {
        console.error('forge-runcontract: handoff requires --run <id>');
        process.exitCode = 2;
      } else {
        const callOpts = {};
        if (opts.root) callOpts.root = opts.root;
        if (opts.rules) callOpts.rulesPath = opts.rules;
        const h = handoffFor({ run_id: opts.run }, callOpts);
        console.log(opts.json ? JSON.stringify(h) : formatHandoff(h));
        process.exitCode = h.snapshot && h.snapshot.failed ? 1 : 0;
      }
    } else if (opts.cmd === 'check') {
      if (!opts.run) {
        console.error('forge-runcontract: check requires --run <id>');
        process.exitCode = 2;
      } else {
        const callOpts = {};
        if (opts.root) callOpts.root = opts.root;
        if (opts.rules) callOpts.rulesPath = opts.rules;
        if (opts.logEvent) callOpts.logEvent = true;
        /** F-03: zonder de ACTUELE commit is `commit_sha` op een review een veld dat niemand controleert.
         *  De CLI kent de werkbare boom, dus die levert hem aan. Geen git-repo (of git ontbreekt) =>
         *  null: de evaluator eist dan nog steeds een welgevormde commit_sha op de review, maar kan hem
         *  niet kruiselings toetsen — dat is een eerlijke beperking, geen stille goedkeuring. */
        /** R4-04 (vierde herreview): `check()` valt zonder --root terug op DEFAULT_ROOT (de installatie
         *  waarin dit script staat), maar de HEAD werd uit `process.cwd()` gehaald. Een absolute aanroep
         *  vanuit repo B beoordeelde dan een run uit repo A tegen de HEAD van B — de commitbinding wees
         *  naar de verkeerde geschiedenis. Eén effectieve root voor run, regels, registry, bewijs én HEAD. */
        const effectiveRoot = rootOf(callOpts);
        // a phased check judges only part of the contract, so it can never be the input to finalize
        if (opts.finalize && opts.phase && opts.phase !== DEFAULT_PHASE) {
          throw new Error('--finalize needs the complete contract; drop --phase ' + opts.phase + ' (or pass --phase complete)');
        }
        const commitSha = resolveHeadCommit(effectiveRoot);
        const result = check({ run_id: opts.run, domain: opts.domain, complexity: opts.complexity, commit_sha: commitSha, phase: opts.phase }, callOpts);
        // json-mode contract: `logged` must be present whenever --log-event was asked for, so a caller
        // can always distinguish "proof written" from "proof failed" from "proof not requested".
        if (opts.logEvent && !('logged' in result)) result.logged = { ok: false, reason: 'internal: check() did not report a logging outcome' };
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          const cxLine = '  · complexity ' + result.complexity + ' (' + result.complexity_source + '; declared ' +
            (result.complexity_declared || 'none') + ', derived ' + result.complexity_derived + ' from ' +
            result.complexity_units + ' dispatched unit(s))';
          if (result.ok) {
            console.log('CONTRACT OK — ' + opts.run + ' (' + result.satisfied.length + ' rule(s) satisfied' +
              (result.overridden.length ? ', ' + result.overridden.length + ' overridden' : '') +
              (result.warnings.length ? ', ' + result.warnings.length + ' warning(s)' : '') + ')');
          } else {
            console.log('NOT DONE — ' + opts.run + ' is missing ' + result.missing.length + ' required rule(s):');
            // C1: windows-v6's Lead saw "✗ MISSING verify-checked" with no reason and no next step
            // (event-present rules carry no rule_details) and stayed stuck. A rule without its own reason now prints its how-to.
            let ruleById = new Map();
            try { ruleById = new Map(loadRules(callOpts.rulesPath || path.join(effectiveRoot, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json')).rules.map((x) => [x.id, x])); } catch { /* the hint is best-effort */ }
            var printHowTo = (id) => { const d = result.rule_details && result.rule_details[id]; if (d && (d.reason || d.message)) return; const rule = ruleById.get(id); if (rule) console.log('      ↳ how: ' + howTo(rule, result, id)); };
            /** N-09: de gesaneerde reden bestond al in `rule_details`, maar alleen de JSON-modus toonde
             *  hem. Een operator die de gewone uitvoer las, zag "MISSING independent-verification" en
             *  moest zelf raden of het zelf-goedkeuring, stale werk, een verkeerde commit of een
             *  gebroken ketenbinding was. De reden staat er nu gewoon bij. */
            for (const m of result.missing) {
              console.log('  ✗ MISSING ' + m);
              const d = result.rule_details && result.rule_details[m];
              if (d && d.reason) console.log('      ↳ ' + String(d.reason).slice(0, 300));
              // I.6: the rule's own next step, in English and Dutch (only rules that carry a message)
              if (d && d.message) { console.log('      ↳ next: ' + String(d.message.en).slice(0, 600)); console.log('      ↳ NL: ' + String(d.message.nl).slice(0, 600)); }
              printHowTo(m);
            }
          }
          console.log(cxLine);
          if (result.phase !== DEFAULT_PHASE) console.log('  · phase ' + result.phase + ' — ' + result.phase_deferred.length + ' later-phase rule(s) not yet due: ' + (result.phase_deferred.join(', ') || 'none'));
          for (const w of result.warnings) {
            console.log('  ⚠ warn: ' + w);
            const d = result.rule_details && result.rule_details[w];
            if (d && d.reason) console.log('      ↳ ' + String(d.reason).slice(0, 300));
          }
          if (result.historical_exempt.length) console.log('  · historical-exempt (this run started before the rule existed): ' + result.historical_exempt.map((x) => x.id + ' (since ' + x.since + ')').join(', '));
          if (result.not_applicable && result.not_applicable.length) console.log('  · not applicable in this project: ' + result.not_applicable.map((x) => x.id + ' (' + x.reason + ')').join(', '));
          for (const o of result.overridden) console.log('  ↷ overridden: ' + o.id + ' — "' + o.note + '"');
          for (const x of result.exceptions || []) console.log('  · exception (recorded, visible): ' + x.id + (x.deliverable_type ? ' [' + x.deliverable_type + ']' : '') + ' — "' + String(x.reason).slice(0, 200) + '"' + (x.by ? ' (by ' + x.by + ')' : ''));
          // An un-judgeable rule must be LOUD: a stale synced rules file that silently drops a rule is exactly
          // the failure this degrade path exists to make visible.
          for (const u of result.unevaluated) console.log('  ⚠ unevaluated: ' + u.id + ' — ' + u.reason);
          // RC-PROOF-WRITE-SILENT (out-p5.md) — text mode used to print NOTHING about a failed
          // --log-event write; a green contract read as "CONTRACT OK" with no trace that the requested audit
          // proof never landed. Both modes now say so explicitly.
          if (opts.logEvent && result.logged) console.log(result.logged.ok ? '  ✓ proof logged (gate_evaluated)' : '  ✗ PROOF NOT LOGGED — ' + (result.logged.reason || 'unknown reason'));
        }
        // RC-PROOF-WRITE-SILENT: the documented completion command (`.claude/commands/forge.md`) asks for
        // --log-event as PART OF the completion claim, not as decoration — a writer failure here means the
        // requested audit trail does not exist, so this run cannot honestly report exit 0 either.
        const logWriteFailed = !!(opts.logEvent && result.logged && result.logged.ok !== true);
        // r4 #7: het gezaghebbende eindverdict zit nu IN het completionpad — met --finalize
        // eindigt een groen contract pas in exit 0 wanneer ook forge-finalize zijn digest-receipt schreef.
        if (result.ok && opts.finalize) {
          const finMod = require(path.join(__dirname, 'forge-finalize.cjs'));
          const fin = finMod.finalize(rootOf(opts), opts.run);
          if (opts.json) console.log(JSON.stringify({ finalize: fin.ok ? 'finalized' : 'refused', reason: fin.reason || null }));
          else console.log(fin.ok ? '  ⇒ FINALIZED @ ' + fin.receipt.digest.slice(0, 16) + '…' + (fin.idempotent ? ' (idempotente herbevestiging)' : '') : '  ⇒ FINALIZE REFUSED — ' + fin.reason);
          process.exitCode = (fin.ok && !logWriteFailed) ? 0 : 3;
        } else {
          process.exitCode = (result.ok && !logWriteFailed) ? 0 : 3;
        }
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-runcontract: ' + e.message);
    process.exitCode = 2;
  }
}
