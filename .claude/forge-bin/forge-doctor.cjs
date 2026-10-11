#!/usr/bin/env node
'use strict';
/**
 * forge-doctor.cjs — Forge self-test + leak scan (Mission Control Phase 2, WP7). Zero-dependency,
 * Windows-safe. Answers the owner's "test everything / does it execute / find leaks" ask in one command.
 *
 * Checks (all REAL, no fabrication):
 *   1. node --check on every .cjs/.js under forge-bin/ + forge-dashboard/ (does it parse?).
 *   2. runs every forge-bin/*.test.cjs and tallies passed/failed (does it execute + pass?).
 *   3. strict-event self-check: feeds log-event.cjs a KNOWN type (expect exit 0) and an UNKNOWN type
 *      (expect exit 2) in a throwaway run, then deletes it — proves the honesty gate still rejects junk.
 *   4. legacy dashboard cleanup: the retired per-project Control Center's SPA files (server.cjs,
 *      index.html, app.js, lenses.js, graph.js, panels.js, styles.css — removed from the template in
 *) are gone from THIS project. Present is advisory only (an older install `forge-sync`
 *      hasn't cleaned up yet), never a failure — see spaPresent()'s own doc comment.
 *   5. secret/leak scan of git-tracked files (git ls-files) using forge-store's HARDENED SECRET_PATTERNS —
 *      reports only {file, pattern}, NEVER the matched secret text. .env.example + binaries skipped.
 *
 * (Later WP additions, not yet reflected above: agentsCheck, chainCheck, rebindingGuard — all part of the
 * real 8-key `checks` object `runDoctor()` ANDs together for its `ok` verdict. 2026-10-06: model_routing
 * (modelRoutingCheck -> forge-policy.cjs routingCheck, GOAT model routing) is ENFORCED in that object too.
 * ship_manifest (shipManifestCheck -> forge-shipcheck.cjs, the shipping manifest) is ENFORCED
 * there as well — in the development tree only; n/a everywhere else. 2026-10-10: run_contract
 * (runContractDoctorCheck, the newest run's completion state) is ENFORCED too. 2026-10-10 (+ part
 * ii): feature_registry (featureRegistryCheck: every tool and skill is in FORGE_FEATURE_REGISTRY.json and a `wired`
 * one still has a wired caller) and skill_frontmatter (skillFrontmatterCheck: a SKILL.md frontmatter Claude Code
 * can read, every forge-* skill catalogued) are ENFORCED in the development tree only; plus four advisories under
 * report.advisory: scribe_wiring, unpublished, structure, always_loaded_budget.)
 *
 * Plus one ADVISORY-ONLY check, reported separately and NEVER folded into the `ok` verdict above:
 *   backfill_continuity — dispatch_id consistency for Bash-less Bosses' backfilled events (see its own
 *     doc comment above `backfillContinuity()`). Surfaced as top-level `report.advisory.backfill_continuity`
 *     (`{ok, checkedRuns, applicableRuns, warnings[]}`), printed as a WARN line, never a FAIL.
 *
 * Writes a machine-readable report to <run>/doctor.json (when --run) and prints a green/red summary.
 *
 * CLI:
 *   node forge-doctor.cjs [--root <dir>] [--run <run_id>] [--json]
 *     --root  project root (default: two levels up from forge-bin, i.e. this project)
 *     --run   also write <root>/.claude/forge-runs/<run_id>/doctor.json and log a doctor_run event
 *     --json  print the full report JSON to stdout
 *   Exit code: 0 if everything passes, 1 if any check fails (so CI/hooks can gate on it). The advisory
 *   field never affects this exit code.
 *
 * Module API: { nodeCheckAll, runTests, strictEventCheck, spaPresent, leakScan, agentsCheck, chainCheck,
 *   rebindingGuard, backfillContinuity, runDoctor, secretLabel }
 *
 * WAVE A / A2 — doctor COMPLETENESS checks. Originally all four were ADVISORY-ONLY
 * (report.advisory.completeness, never folded into the hard `ok` verdict — see backfillContinuity's doc
 * above for why a brand-new heuristic must never flip a healthy project's doctor run red the first time it
 * ships). V9-INTEGRATE promotes TWO of the four to ENFORCED (folded into `checks`/`ok`) — see
 * the "V9-INTEGRATE enforcement" note below for exactly which, and why each individual check was or was not
 * safe to promote:
 *   sync_completeness    — ADVISORY (unchanged). every real skill dir (skills/**\/SKILL.md) / forge-bin tool /
 *                           agent .md that exists on disk is present in forge-sync.cjs's delivery list
 *                           (listSystemFiles — derived from the shipping manifest, 2026-10-09; the
 *                           SYSTEM[] pin list is gone). NOT promoted: it was built for the old hand-pinned list,
 *                           where a new file routinely preceded its pin in the same edit session — hard-blocking
 *                           every doctor run on that ordinary in-progress state would punish normal iterative
 *                           work, not just a genuine regression.: in the DEVELOPMENT tree the
 *                           ENFORCED `ship_manifest` check (shipManifestCheck -> forge-shipcheck.cjs) supersedes it
 *                           (every source path, both drift directions, reference closure). It is KEPT because it is
 *                           the only one of the two that says anything in a synced or redistributed project, where
 *                           ship_manifest is n/a; delegating it would also silently change what the forge-audit-loop
 *                           consumers of advisory.completeness.sync_completeness read.
 *   check_the_checks      — ENFORCED (V9-INTEGRATE). a *.test.cjs suite that REPORTS a passing tally (per
 *                           runTests) but contains ZERO real assertion call sites in its own source is a
 *                           "green no-op": the tally cannot be genuine. Promoted: purely mechanical/static,
 *                           0 findings on this real project (see forge-doctor.test.cjs's static guard), and a
 *                           healthy project can never accidentally trip it — there is no code path that
 *                           creates a passing-but-assertion-free suite by ordinary means.
 *   memory_discipline     — ADVISORY (unchanged, deliberately — see WAVE A/A2 doc above). FORGE_MEMORY.md is
 *                           absent/empty, or still carries an unfilled placeholder marker
 *                           (<PLACEHOLDER>/<TODO>/TODO:/TBD/FIXME/etc). NOT promoted: a brand-new/freshly
 *                           cloned project legitimately has no memory yet — this is the canonical example of
 *                           a check that must stay advisory for a fresh project (see the plan's own framing).
 *   unregistered_event    — ENFORCED (V9-INTEGRATE). a forge-bin/*.cjs tool calls its local logEvent(...)
 *                           wrapper with a literal event_type string that is not registered in
 *                           log-event.cjs's KNOWN_EVENT_TYPES (+ cross-checked against forge-verify.cjs's own
 *                           TERMINAL_TYPES/BACKBONE mirror, when that module is available) — the 3-place
 *                           event-registration discipline the plan's invariant #6 requires. Static
 *                           best-effort scan of the logEvent(...) call convention only (see
 *                           extractLoggedEventTypes doc); a dynamically-built event_type argument can never
 *                           be resolved statically and is honestly skipped, not guessed. Promoted: purely
 *                           mechanical/static, 0 findings on this real project, and a genuinely NEW tool
 *                           always has a real registration step in the SAME wave that adds it (this very
 *                           piece is the proof) — a false-red here means a literal registration bug, not
 *                           ordinary project state.
 *   mcp_dormancy           — ADVISORY (unchanged). WAVE G / G-INTEGRATE: the MCP-as-client
 *                           SAFETY DOCTRINE self-test — see mcpDormancy() below for the full contract. NOT
 *                           promoted: security-classification heuristics deserve a human review pass before
 *                           they can hard-block a build; kept conservative on purpose.
 *   run_contract          — ENFORCED; it was ADVISORY from V9-INTEGRATE until then and
 *                           now lives in `checks`, not in this advisory group. It judges the NEWEST genuine run
 *                           (run.json or run_started; never a doctor-receipt-only folder): red when that run
 *                           logged run_completed over an unmet completion sequence, skipped finalize, or holds a
 *                           STALE receipt; never red while a run is in progress (overdue obligations are listed)
 *                           or for a completion claimed before RUN_CONTRACT_ENFORCED_SINCE. Finalized runs are
 *                           read through forge-finalize check() with cause/reverified, never re-judged live
 *                           (audit S5). The old reason not to enforce — every historical run missing
 *                           research-done — no longer applies: history is not enforced, only new completions.
 *                           See the "run_contract — ENFORCED" block doc above runContractDoctorCheck().
 *   skill_evals            — NEW (wp-skill-evals), ADVISORY-ONLY. Wraps
 *                           forge-skill-evals.cjs::runAll() — the per-skill binary-evals FOUNDATION piece
 *                           (backlog item 1, YT-SWEEP-2026-07-31: per-skill evals.json + learnings.md).
 *                           A skill with no evals.json is simply not evaluated. NOT enforced: no
 *                           autonomous keep/revert loop exists yet (nightshift-gated, a later piece) — a
 *                           real failure here is a review signal today, not yet a build gate.
 *   skill_hygiene           — NEW (wp-disclosure-ab), ADVISORY-ONLY. Progressive-disclosure
 *                           hygiene on EVERY skill under .claude/skills/ that has a SKILL.md (no opt-in,
 *                           unlike skill_evals): frontmatter `description` present and <= 200 chars (the
 *                           wp3b budget law), whole-file line count <= 500 (this project's own file-size
 *                           guidance), and every ANCHORED path-shaped `` `backtick-code-span` `` reference
 *                           in the body resolves to a real file (see skillHygiene()/extractSkillPathRefs()
 *                           below for the exact, deliberately conservative extraction/anchor rules — no
 *                           false positives on ordinary prose). NOT enforced: same reasoning as skill_evals
 *                           — a real finding here (e.g. an over-long SKILL.md) is a review signal for the
 *                           Skill Boss today, not yet a build gate.
 *
 * one further ADVISORY-ONLY check, reported under its OWN top-level key
 * `report.advisory.run_liveness` (liveness is not completeness) with its own printSummary WARN line, exactly
 * like backfill_continuity:
 *   run_liveness  — ADVISORY. Wraps forge-runwatch.cjs::watch() over every run whose run.json CLAIMS to be
 *                   running, and reports each one the events prove is not alive (finished_but_open /
 *                   stalled / no_agent_activity / no_events), carrying runwatch's OWN terminal event lines
 *                   as evidence. This is what makes forge-runwatch run automatically instead of only on
 *                   request — see runLiveness()'s doc comment for the concrete 30+-hour failure it catches
 *                   and for why it uses a much wider silence window than runwatch's interactive default.
 *
 * CONTEXT BUDGET — one further ADVISORY-ONLY check under its own top-level key
 * `report.advisory.context_budget`, on the same footing as run_liveness:
 *   context_budget — ADVISORY. Wraps forge-contextbudget.cjs::measure() over the ALWAYS-LOADED instruction
 *                   chain (global CLAUDE.md, each of its @-includes, rules/ecc/common, the workspace and
 *                   project CLAUDE.md, and the name+description of every skill), compares each post against
 *                   a recorded baseline, and reports growth and dead @-includes. Two things make it
 *                   permanently advisory: its token figures are ESTIMATES (characters/4, no tokenizer runs
 *                   — the report says so in its own words), and most of what it counts lives OUTSIDE this
 *                   project root, where this codebase reads but never writes. Its printSummary line is the
 *                   only advisory printed on EVERY run rather than only on a finding, because the failure
 *                   being guarded is silent growth: a number nobody sees is the state that let the skill
 *                   list get truncated on 31 July with no warning at all.
 *
 * BEGINNER SETUP (wp-l1 added settings-wired, wp-l4 added model-choice-hint) — eight
 * ADVISORY-ONLY checks under their own top-level key `report.advisory.beginner_setup`, one printSummary line
 * each (see beginnerSetup() for the contract): claude-md-size · path-tools · bypass-mode · wsl-mnt-c ·
 * claude-doctor · prompt-coach-present · settings-wired · model-choice-hint.
 * They describe the MACHINE and the owner's preferences (a long CLAUDE.md, a missing `node`, a bypass default,
 * a WSL project under /mnt/c), never a defect in this project's code, so none can ever turn the doctor red.
 * model-choice-hint is the one exception to "describes the machine": it is pure education (theme 5 of the
 * beginner sweep, 52/98 videos — model choice, usage limits and cost had no beginner-facing surface at all),
 * always `info`, never evaluating anything about this project or machine.
 *
 * V9-INTEGRATE ENFORCEMENT OVERRIDE PATH: a promoted-to-ENFORCED check's failure is recoverable
 * without editing code — config/orchestration/FORGE_HARD_RULES.json's `doctor_check_overrides` array (see
 * loadDoctorCheckOverrides() below) lets the owner log an explicit, reasoned, timestamped override for
 * `unregistered_event` or `check_the_checks` (or a future promoted check) that turns a genuine false-red back
 * into a visible-but-non-blocking PASS (never a silent one — see printSummary()'s `[OVERRIDDEN: ...]` tag).
 * This is the SAME file forge-runcontract.cjs's own per-run overrides already live in, reused rather than
 * inventing a second override mechanism.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const store = require('./forge-store.cjs');
// forge-policy.cjs is a SOFT sibling dependency (unlike forge-store.cjs, which agentsCheck/leakScan have
// always required): some hermetic fixtures (e.g. forge-sync.test.cjs's "copy the REAL forge-doctor.cjs"
// integration case) intentionally copy only forge-doctor.cjs + forge-store.cjs to exercise the genuine
// node_check/tests path, without forge-policy.cjs alongside it. A missing forge-policy.cjs must degrade
// the tool-policy sub-check honestly (ok:false, explicit reason) rather than crash the entire doctor run.
let policy = null;
try { policy = require('./forge-policy.cjs'); } catch { policy = null; }
// forge-sync.cjs / forge-verify.cjs are SOFT sibling dependencies too, for the same reason: sync_completeness
// and unregistered_event are ADVISORY, so a hermetic fixture that only ships forge-doctor.cjs + forge-store.cjs
// must degrade those two sub-checks honestly rather than crash the whole doctor run. Both modules guard their
// CLI body behind `require.main === module`, so requiring them here never triggers their CLI side effects.
let syncTool = null;
try { syncTool = require('./forge-sync.cjs'); } catch { syncTool = null; }
let verifyTool = null;
try { verifyTool = require('./forge-verify.cjs'); } catch { verifyTool = null; }
// V9-INTEGRATE: forge-runcontract.cjs is a SOFT sibling dependency too, same reasoning as
// forge-sync.cjs/forge-verify.cjs above — a hermetic fixture that only ships forge-doctor.cjs + forge-store.cjs
// must degrade it honestly rather than crash the whole doctor run. made run_contract ENFORCED;
// a missing module still reads as a neutral "unavailable" (ok:true, reason given), never a crash.
let runContractTool = null;
try { runContractTool = require('./forge-runcontract.cjs'); } catch { runContractTool = null; }
// wp-skill-evals: forge-skill-evals.cjs is a SOFT sibling dependency too, same reasoning as
// syncTool/verifyTool/runContractTool above — skill_evals is ADVISORY-ONLY, so a hermetic fixture that
// only ships forge-doctor.cjs + forge-store.cjs must degrade it honestly rather than crash the whole
// doctor run.
let skillEvalsTool = null;
try { skillEvalsTool = require('./forge-skill-evals.cjs'); } catch { skillEvalsTool = null; }
// forge-runwatch.cjs is a SOFT sibling dependency too, same reasoning as the four
// above — run_liveness is ADVISORY-ONLY. forge-runwatch is read-only and guards its CLI behind
// `require.main === module`, so requiring it here has no side effects.
let runwatchTool = null;
try { runwatchTool = require('./forge-runwatch.cjs'); } catch { runwatchTool = null; }
// forge-contextbudget.cjs is a SOFT sibling dependency on the same terms — context_budget is
// ADVISORY-ONLY and the meter is strictly read-only (it opens the always-loaded instruction chain, most of
// which lives OUTSIDE this project root, and never writes any of it — see that file's header on the
// project boundary). Its absence degrades to an honest "unavailable", never a doctor failure.
let contextBudgetTool = null;
try { contextBudgetTool = require('./forge-contextbudget.cjs'); } catch { contextBudgetTool = null; }
// (prd-w2-discipline M2): forge-release-check.cjs is a SOFT sibling dependency on the
// same terms as the others above (a hermetic fixture copying only forge-doctor.cjs + forge-store.cjs must
// degrade honestly rather than crash). UNLIKE those, release_exclusions is ENFORCED, not advisory — see
// releaseExclusionsCheck() below — so its absence fails the check (ok:false), the same fail-closed posture
// qualityCatalogDoctorCheck() takes for forge-quality.cjs (F-09): this install's own sync-manifest ships
// forge-release-check.cjs, so a missing copy is a real installation defect, not an optional feature.
let releaseCheckTool = null;
try { releaseCheckTool = require('./forge-release-check.cjs'); } catch { releaseCheckTool = null; }
// forge-shipcheck.cjs is a SOFT sibling dependency
// on the same terms. ship_manifest is ENFORCED in the development tree (fail-closed there when the module is
// missing, like release_exclusions) and n/a everywhere else — see shipManifestCheck().
let shipcheckTool = null;
try { shipcheckTool = require('./forge-shipcheck.cjs'); } catch { shipcheckTool = null; }
// forge-registry-gen.cjs is a SOFT sibling dependency on the same terms. feature_registry is
// ENFORCED in the development tree (fail-closed there when the module is missing) and n/a everywhere else.
let regGenTool = null;
try { regGenTool = require('./forge-registry-gen.cjs'); } catch { regGenTool = null; }

const NODE = process.execPath;
const DASH_SPA = ['server.cjs', 'index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css'];

function claudeDir(root) { return path.join(root, '.claude'); }
function listByExt(dir, exts) {
  let out = []; let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { if (e.isFile() && exts.includes(path.extname(e.name))) out.push(path.join(dir, e.name)); }
  return out.sort();
}

// WP-SPD-B: `node --check` cost one process spawn per file (about 315 spawns, 27-67 s per doctor run).
// A `.cjs` file is always CommonJS, so Node compiles it as the body of the module wrapper function
// (exports, require, module, __filename, __dirname) after dropping a BOM and a leading `#!` line. Doing exactly
// that with vm.compileFunction parses the file without running it. compileFunction parses a real function BODY,
// so a file that tries to close the wrapper early (`}); (function () {`) is rejected like `node --check` rejects
// it — a string-wrapped `new vm.Script(Module.wrap(src))` would wrongly accept that. The result is only ever
// used to SKIP a spawn for a file that parses: anything that throws (a SyntaxError or any other error) is
// re-checked by the real `node --check` spawn, so this can never turn a red file green or change its error text.
const vm = require('vm');
const CJS_WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];
function syntaxCheckInProcess(file) {
  try {
    let src = fs.readFileSync(file, 'utf8');
    // A BOM is dropped; a `#!` line only counts at the very first byte (measured: Node rejects BOM + `#!`).
    // compileFunction itself would accept that `#!`, so that shape is left to the real spawn to judge.
    if (src.charCodeAt(0) === 0xFEFF) {
      src = src.slice(1);
      if (src.startsWith('#!')) return { ok: false, error: 'BOM followed by #! — left to node --check' };
    } else if (src.startsWith('#!')) src = src.replace(/^#![^\r\n]*/, ''); // keep the line break: line numbers stay right
    vm.compileFunction(src, CJS_WRAPPER_PARAMS, { filename: file });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 1) node --check on all dashboard/bin sources
// Honesty fix: 0 files checked is NEVER a silent pass. Distinguish "the dirs are genuinely
// both absent" (still a real problem for a project that's supposed to have forge-bin/) from "a dir exists
// but yielded nothing" — both are `ok:false` with an explicit `reason`, never a vacuous green.
function nodeCheckAll(root) {
  const cd = claudeDir(root);
  const binDir = path.join(cd, 'forge-bin');
  const dashDir = path.join(cd, 'forge-dashboard');
  const files = [
    ...listByExt(binDir, ['.cjs']),
    ...listByExt(dashDir, ['.cjs', '.js']),
  ];
  const failures = [];
  let spawned = 0;
  for (const f of files) {
    // WP-SPD-B: a `.cjs` that parses in-process is accepted without a spawn. Everything else — a `.js` (its module
    // type depends on package.json) and any `.cjs` the in-process parse rejects or cannot judge — still goes to the
    // real `node --check`, and only THAT result is reported, so a failure and its error text are exactly as before.
    if (path.extname(f) === '.cjs' && syntaxCheckInProcess(f).ok) continue;
    spawned++;
    const r = spawnSync(NODE, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) failures.push({ file: path.relative(root, f), error: (r.stderr || '').split('\n')[0] });
  }
  let ok = failures.length === 0;
  let reason = '';
  if (files.length === 0) {
    ok = false; // no evidence is not a pass, regardless of why
    reason = (!fs.existsSync(binDir) && !fs.existsSync(dashDir))
      ? 'no evidence: forge-bin/ and forge-dashboard/ are both missing'
      : 'no evidence: 0 files checked (dir present but empty or unreadable)';
  }
  return { total: files.length, failed: failures.length, ok, failures, reason, spawned };
}

// 2) run every *.test.cjs and tally
// Honesty fixes: (a) a suite must report at least one REAL passing assertion (p > 0) to count
// as ok — "0 passed, 0 failed" is a vacuous/short-circuited suite, not proof; (b) 0 suites found is never a
// silent pass — same "no evidence" treatment as nodeCheckAll; (c) a suite that hits the spawn timeout is
// labeled `timedOut:true` / `blocked`, never lumped in with a real failure.
// WP-SPD-A: 300 s -> 600 s. The heaviest suite (forge-sync.test) was measured at 319 s and 438 s on a
// loaded maintainer PC, so 300 s turned a busy machine into a `blocked` doctor with nothing broken. A suite that
// hits this limit is still timedOut/blocked, never a pass; FORGE_DOCTOR_SUITE_TIMEOUT_MS still overrides it.
// WP-LIMITS: 600 s -> 1500 s. forge-sync.test grew to ~1550 assertions with an isolated TEMP and
// needs about 750 s alone; under load the 600 s default left only ~43 s headroom. Same semantics: a suite that
// hits the limit is timedOut/blocked, never a pass, and the env override still wins.
const DOCTOR_SUITE_TIMEOUT_MS = 1500000;
// a failing suite names its failing tests in the evidence. On 2026-09-27 one gate-hook test failed
// once inside a release gate and could not be identified, because perSuite held counts only. A failure line is what
// a suite's own harness prints for it: this project's `  FAIL <name>`, or node:test's `not ok` / a cross mark. At most
// FAIL_NAMES_MAX lines of FAIL_NAME_MAX_CHARS each, redacted by forge-store, so a noisy suite cannot bloat the report.
const FAIL_LINE_RE = /^\s*(?:FAIL\b|not ok\b|\u2716|\u2717)/;
const FAIL_NAMES_MAX = 5;
const FAIL_NAME_MAX_CHARS = 200;
function failingTestNames(out) {
  // redactValue() on a bare string only ever runs the pattern-shaped SECRET_PATTERNS
  // pass \u2014 its key-name heuristic (SECRET_KEY_RE) only matches OBJECT KEYS, so a failing test line like
  // "FAIL test password=hunter2" (a fixture printing a labelled secret in its own failure description) kept
  // the value. redactText() adds the missing key=value scan on top of the same SECRET_PATTERNS pass.
  return String(out || '').split(/\r?\n/).filter((l) => FAIL_LINE_RE.test(l))
    .slice(0, FAIL_NAMES_MAX).map((l) => String(store.redactText(l.trim())).slice(0, FAIL_NAME_MAX_CHARS));
}

// WP-SPD-C: the suites run in a bounded pool instead of one after another. runTests() makes ONE
// spawnSync of forge-suite-pool.cjs (so runDoctor() stays synchronous for its ~60 callers); the helper runs at most
// `jobs` suites at a time, longest-first, kills a suite that overruns its limit by its own PID only, and returns the
// raw {status, signal, stdout, stderr} per suite in the original (name-sorted) order. Every verdict — the anchored
// tally, p>0, exit 0, timedOut = blocked, 0 suites = no evidence — is still made below, by the same code, on the
// same fields. FORGE_DOCTOR_JOBS=1 (or a single suite, or a missing/broken helper) is the exact old sequential path.
const DOCTOR_SUITE_JOBS = 4;
const SUITE_POOL_FILE = path.join(__dirname, 'forge-suite-pool.cjs');
// Durations of earlier runs, only to order the next run longest-first. A hint, never evidence: it lives in the OS
// temp folder (never in a project), a missing or corrupt file just means "no hint", and at most
// SUITE_DURATIONS_MAX_ROOTS project roots are kept.
const SUITE_DURATIONS_FILE = path.join(os.tmpdir(), 'forge-doctor-suite-durations.json');
const SUITE_DURATIONS_MAX_ROOTS = 20;
function resolveSuiteJobs(opts) {
  const fromOpts = opts && Number.isFinite(opts.jobs) ? opts.jobs : NaN;
  const fromEnv = Number(process.env.FORGE_DOCTOR_JOBS);
  const n = Number.isFinite(fromOpts) && fromOpts >= 1 ? fromOpts : (Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : DOCTOR_SUITE_JOBS);
  return Math.max(1, Math.floor(n));
}
function suiteRootKey(root) {
  let r = path.resolve(root);
  if (process.platform === 'win32') r = r.toLowerCase();
  return crypto.createHash('sha256').update(r).digest('hex').slice(0, 16);
}
function readSuiteDurations(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch { return {}; }
}
/** suiteOrder(root, tests, file) — indexes of `tests`, longest-first. A suite with a recorded duration is ordered by
 *  it; a suite without one goes first (it may be long), largest file first. Ties keep name order. */
function suiteOrder(root, tests, file) {
  const known = (readSuiteDurations(file)[suiteRootKey(root)] || {}).ms || {};
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const keyed = tests.map((t, i) => {
    const ms = Number(known[path.basename(t)]);
    return { i, known: Number.isFinite(ms) && ms >= 0, ms: Number.isFinite(ms) ? ms : 0, size: size(t) };
  });
  keyed.sort((a, b) => (a.known === b.known ? 0 : (a.known ? 1 : -1))
    || (a.known ? b.ms - a.ms : b.size - a.size) || a.i - b.i);
  return keyed.map((k) => k.i);
}
function writeSuiteDurations(root, tests, results, file) {
  try {
    const all = readSuiteDurations(file);
    const ms = {};
    tests.forEach((t, i) => { if (results[i] && Number.isFinite(results[i].ms)) ms[path.basename(t)] = results[i].ms; });
    all[suiteRootKey(root)] = { at: Date.now(), ms };
    const keep = Object.entries(all).filter(([, v]) => v && typeof v === 'object')
      .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, SUITE_DURATIONS_MAX_ROOTS);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)));
    fs.renameSync(tmp, file);
  } catch { /* a hint only: failing to save it never affects a doctor verdict */ }
}
/** runSuitesPooled — {results} (raw per-suite spawn results in the order of `tests`) or {results:null, error}. */
function runSuitesPooled(root, tests, timeoutMs, jobs, opts) {
  const poolFile = (opts && opts.poolFile) || SUITE_POOL_FILE;
  const durationsFile = (opts && opts.durationsFile) || SUITE_DURATIONS_FILE;
  if (!fs.existsSync(poolFile)) return { results: null, error: 'suite pool helper missing: ' + path.basename(poolFile) };
  const job = { node: NODE, root, suites: tests, order: suiteOrder(root, tests, durationsFile), jobs, timeoutMs };
  // Backstop only: every suite already has its own limit inside the helper (plus a short kill grace), so the whole
  // pool is bounded by about (suites / jobs + 1) limits.
  const backstopMs = (Math.ceil(tests.length / jobs) + 1) * (timeoutMs + 10000) + 30000;
  const r = spawnSync(NODE, [poolFile], { input: JSON.stringify(job), encoding: 'utf8', timeout: backstopMs, maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
  const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  const shapeOk = !!results && results.length === tests.length
    && results.every((x, i) => x && x.suite === tests[i] && typeof x.stdout === 'string' && typeof x.stderr === 'string');
  if (r.status !== 0 || !shapeOk) {
    return { results: null, error: 'suite pool failed (status ' + r.status + (r.signal ? ', signal ' + r.signal : '') + '): ' + String(r.stderr || (r.error && r.error.message) || 'no valid result').split('\n')[0].slice(0, 200) };
  }
  writeSuiteDurations(root, tests, results, durationsFile);
  return { results };
}

// WP-TMP-HYGIENE: the sequential path isolates the temp folder exactly like the pool does — TEMP, TMP
// and TMPDIR point at a private forge-run-<pid>-<n> folder under os.tmpdir() that is removed after the suite ends,
// whatever the outcome. The helpers live in forge-suite-pool.cjs (one implementation); if that file is missing the
// suite still runs, only without the isolation. WP-LONGPATH: the same suiteEnv also hands every
// sequential suite core.longpaths=true + protocol.file.allow=always through GIT_CONFIG_COUNT env vars (appended to
// any already present, no git config file written), exactly as the pool does.
function suiteTmpHelpers() {
  try {
    const h = require(SUITE_POOL_FILE);
    if (typeof h.makeSuiteTmp === 'function' && typeof h.removeSuiteTmp === 'function' && typeof h.suiteEnv === 'function') return h;
  } catch { /* fall through */ }
  return null;
}
function runSuiteSequential(file, root, timeoutMs) {
  const h = suiteTmpHelpers();
  const tmpDir = h ? h.makeSuiteTmp() : null;
  try {
    return spawnSync(NODE, [file], { encoding: 'utf8', timeout: timeoutMs, cwd: root, env: h ? h.suiteEnv(process.env, tmpDir) : process.env });
  } finally {
    if (h && tmpDir) h.removeSuiteTmp(tmpDir);
  }
}

function runTests(root, opts) {
  // timeoutMs is test-only-overridable so a hermetic test can prove the timedOut/blocked classification
  // against a REAL spawnSync timeout in milliseconds instead of waiting minutes or faking the spawnSync
  // return shape. (fresh-laptop simulation): the default was 120 s, but the heaviest suite (the gate
  // hook, hundreds of real hook spawns) already takes ~95 s on the maintainer's PC — a slower laptop or a busy
  // CI runner crossed the line and the doctor went red with nothing broken. Default was raised to 300 s and, in
  // WP-SPD-A, to 600 s, and in WP-LIMITS to 1500 s (a genuinely hung suite is still caught), and
  // FORGE_DOCTOR_SUITE_TIMEOUT_MS overrides it.
  const envTimeout = Number(process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS);
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DOCTOR_SUITE_TIMEOUT_MS);
  const dir = path.join(claudeDir(root), 'forge-bin');
  const dirExists = fs.existsSync(dir);
  const tests = listByExt(dir, ['.cjs']).filter((f) => f.endsWith('.test.cjs'));
  const perSuite = []; let passed = 0, failed = 0, suitesFailed = 0, suitesBlocked = 0;
  // WP-SPD-C: run the suites in the pool when it can help (more than one suite and jobs > 1). Its raw results are
  // read by the unchanged loop below in name order; if the pool cannot deliver, the old sequential spawn runs.
  const jobs = resolveSuiteJobs(opts);
  const pooled = (jobs > 1 && tests.length > 1) ? runSuitesPooled(root, tests, timeoutMs, jobs, opts) : null;
  const pooledResults = pooled ? pooled.results : null;
  for (let ti = 0; ti < tests.length; ti++) {
    const t = tests[ti];
    // (found by the Test Boss on the published): the suite runs with the root being checked as
    // its working folder. Without it `--root <dir>` inherited the caller's folder, and suites that resolve a
    // relative target against process.cwd() (the gate hook's scratch rule) reported false failures. The pool
    // spawns each suite with the same cwd, inherited environment and limit.
    const r = pooledResults ? pooledResults[ti] : runSuiteSequential(t, root, timeoutMs);
    // spawnSync sets status:null + a kill signal (verified: SIGTERM on Windows, r.error may also carry an
    // ETIMEDOUT message) when the timeout fires; treat any status:null+signal combo as "blocked", not
    // "failed" — it never actually finished running.
    const timedOut = r.status === null && !!r.signal;
    const out = ((r.stdout || '') + (r.stderr || ''));
    // Robust tally extraction (FOLLOWUP A): the previous /(\d+)\s+passed,\s+(\d+)\s+failed/ had
    // no anchor and no /g flag, so it matched the FIRST occurrence anywhere in combined stdout+stderr —
    // including a phrase inside a test DESCRIPTION that a suite's own harness happens to echo (e.g.
    // "  ok  reports 0 passed, 0 failed when empty"), long before the suite's real trailing tally line. This
    // already caused one real false-negative (forge-chaos.test.cjs briefly read as 0/0 — fixed there by
    // renaming the colliding description, but the underlying regex class bug remained). Fix: only accept a
    // match where the digits are the FIRST thing on their line (anchor `^\s*` with the `m` flag) — a genuine
    // tally is always printed at the very start of its own line (see this file's own final
    // `console.log(pass + ' passed, ' + fail + ' failed')`), so a description embedded mid-line — prefixed by
    // "  ok  " / "  FAIL " or any other text before the digits — can never satisfy the anchor. Deliberately
    // NOT anchored at the line's END too: a real sibling suite (forge-learn.test.cjs) legitimately prints
    // "N passed, M failed, K skipped" — extra trailing content on the same summary line is normal and must
    // still be read correctly (`\b` after "failed" instead of `$` — proven by re-running this exact fix
    // against the real project's full suite battery, not just a hand-written fixture). Take the LAST such
    // anchored match (not the first) as belt-and-suspenders, since the genuine summary is always the final
    // thing a suite prints.
    const TALLY_RE = /^\s*(\d+)\s+passed,\s+(\d+)\s+failed\b/gm;
    let m = null, tm;
    while ((tm = TALLY_RE.exec(out)) !== null) m = tm;
    const p = m ? Number(m[1]) : 0, f = m ? Number(m[2]) : 0;
    const suiteOk = !timedOut && r.status === 0 && f === 0 && !!m && p > 0;
    if (timedOut) suitesBlocked++;
    else if (!suiteOk) suitesFailed++;
    passed += p; failed += f;
    const entry = { suite: path.basename(t), passed: p, failed: f, ok: suiteOk, timedOut };
    if (!suiteOk && !timedOut) { const names = failingTestNames(out); if (names.length) entry.failures = names; }
    if (timedOut && r.signal) entry.signal = r.signal;
    perSuite.push(entry);
  }
  let ok = suitesFailed === 0 && suitesBlocked === 0;
  let reason = '';
  if (tests.length === 0) {
    ok = false; // no evidence is not a pass
    reason = dirExists ? 'no evidence: 0 test suites found in forge-bin/ (dir present but empty)' : 'no evidence: forge-bin/ dir missing';
  }
  const res = { suites: tests.length, suitesFailed, suitesBlocked, passed, failed, ok, perSuite, reason,
    runner: pooledResults ? 'pool' : 'sequential', jobs: pooledResults ? jobs : 1 };
  // A pool that could not deliver is said out loud; the suites then ran sequentially (the verdict above).
  if (pooled && !pooledResults) res.poolError = pooled.error;
  return res;
}

// 3) strict-event honesty gate still rejects unknown types
// WP-CC0 (Command Center audit): this used to spawn `root`'s REAL log-event.cjs directly, writing
// 'doctor-selfcheck-<pid>/events.jsonl' straight into the REAL project's .claude/forge-runs/ and relying
// on a best-effort fs.rmSync to clean it up afterward. On Windows that rm can lose a race (the file the
// child process just wrote can still be momentarily locked — by AV scanning or the OS itself), so a
// doctor run repeated many times over a project's life leaves a 'doctor-selfcheck-<pid>' folder behind
// every time the race is lost — measured as real debris across multiple projects (this is the exact
// pattern forge-toolhook.cjs's own header comment and forge-snapshot.cjs's pickRun() doc comment already
// describe as "Doctor creates those constantly"). Fix: copy the SAME script bytes (never a
// reimplementation — see this file's own module-API contract) into a throwaway OS-tmp '.claude/
// forge-dashboard/log-event.cjs' and run the COPY there instead. This still proves the real shipped
// script's real behavior (verifyEvent()/KNOWN_EVENT_TYPES are read from the exact same file bytes); it
// just never touches the project being checked, so a lost cleanup race can only litter the OS temp
// folder, never a real project's forge-runs/.
function strictEventCheck(root) {
  const sourceLogEvent = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-selfcheck-'));
    const fixtureDash = path.join(tmp, '.claude', 'forge-dashboard');
    fs.mkdirSync(fixtureDash, { recursive: true });
    fs.copyFileSync(sourceLogEvent, path.join(fixtureDash, 'log-event.cjs'));
    const logEvent = path.join(fixtureDash, 'log-event.cjs');
    const rid = 'doctor-selfcheck';
    const good = spawnSync(NODE, [logEvent, rid, 'agent_progress', '{"agent":"orchestrator","note":"doctor self-check"}'], { encoding: 'utf8' });
    const bad = spawnSync(NODE, [logEvent, rid, 'zzz_bogus_type', '{"agent":"orchestrator"}'], { encoding: 'utf8' });
    const ok = good.status === 0 && bad.status === 2;
    return { ok, known_accepted: good.status === 0, unknown_rejected: bad.status === 2, good_status: good.status, bad_status: bad.status };
  } catch (e) {
    // No log-event.cjs at this root (a minimal/foreign project) or the tmp fixture could not be built —
    // fail closed, exactly as before when spawnSync hit a missing script (status stayed null either way).
    return { ok: false, known_accepted: false, unknown_rejected: false, good_status: null, bad_status: null, reason: 'could not run an isolated self-check: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup of an OS-tmp dir — never the real project */ } }
  }
}

// 4) dashboard SPA files —: the retired per-project Control Center (server.cjs + its 6 static
// SPA files) was REMOVED from the template. ABSENT is now the healthy state; forge-sync's
// pruneRetiredFiles() cleans an older install's leftovers automatically once they are unmodified. `ok`
// stays true EITHER WAY — this can never fail a doctor run; PRESENT is advisory only (a project that
// simply has not synced since upgrading), reported via `present`, never via a `missing` list anymore.
function spaPresent(root) {
  const dir = path.join(claudeDir(root), 'forge-dashboard');
  const present = DASH_SPA.filter((f) => fs.existsSync(path.join(dir, f)));
  return { ok: true, present, stale: present.length > 0 };
}

// friendly label for a hardened SECRET_PATTERN (source-based, no parallel list to drift)
function secretLabel(src) {
  if (src.includes('nvapi')) return 'nvidia-nvapi-key';
  if (src.includes('sk_')) return 'stripe-key';
  if (src.includes('sk-')) return 'openai-style-key';
  if (src.includes('rk_')) return 'stripe-restricted-key';
  if (src.includes('gh[')) return 'github-token';
  if (src.includes('xox')) return 'slack-token';
  if (src.includes('AKIA')) return 'aws-access-key';
  if (src.includes('AIza')) return 'google-api-key';
  if (src.includes('SG')) return 'sendgrid-key';
  if (src.includes('PRIVATE KEY')) return 'pem-private-key';
  if (src.includes('eyJ')) return 'jwt';
  if (src.includes('/') && src.includes('@')) return 'url-embedded-credentials'; // source has escaped slashes (:\/\/)
  return 'secret-pattern';
}

// 5) leak scan of git-tracked files (falls back to a bounded working-tree walk if git is unavailable)
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'forge-runs', 'forge-backups', '.cache',
  // VENV/VENDOR CONTAINMENT (gemeten op "aiTraining"): the gitless WALK crawled a Python
  // virtualenv (12.728 files) and flagged 16 third-party docstring URL-examples (fsspec/httpx/pandas/
  // pyarrow/urllib3) as url-embedded-credentials. A venv/site-packages tree is dependency territory
  // exactly like node_modules: third-party code we do not own. Fixed dir names here; arbitrary venv
  // names (.venv-train, …) are caught by the pyvenv.cfg marker check in isVenvDir() below.
  '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.mypy_cache', '.ruff_cache', '.pytest_cache']);
/** isVenvDir — definitive Python-venv detection by its marker file, so a venv is skipped whatever its
 *  directory name is (measured real case: `.venv-train`). Cheap: one existsSync per DIRECTORY walked. */
function isVenvDir(absDir) { return fs.existsSync(path.join(absDir, 'pyvenv.cfg')); }
// How deep below the project root a nested repository is still looked for. Four levels covers every real
// layout this project has met (`command-center/`, `apps/<x>/`, `packages/<x>/<y>/`) without turning repo
// discovery into a full-tree walk of a large monorepo.
const NESTED_REPO_MAX_DEPTH = 4;
/**
 * isAgentWorktreesDir(rel) -> true for a `.claude/worktrees` folder (root-relative, any depth, any case).
 *
 * WP-SYNC-R8 (measured on the 26H2 project): `.claude/worktrees/` there held 98 folders, 93 of them
 * agent checkouts made by `git worktree add` — about 3.2 million files, 29.5 GB. Each checkout has a `.git` FILE,
 * so nestedGitRepos() (depth 4) found every one as a "nested repository" at `.claude/worktrees/<name>` (depth 3)
 * and trackedFiles() fed its whole `git ls-files` into the leak scan: millions of reads. They are not nested
 * repositories of the project — they are worktrees OF the project's own repository (scratch copies of its tracked
 * content at other commits), never shipped and never app code of this tree. The doctor no longer descends into
 * them anywhere (nested-repo discovery and the gitless walk) and says so in the leak-scan line (`notScanned`).
 * Stated limit: a secret committed ONLY on an agent's worktree branch is not scanned here.
 */
function isAgentWorktreesDir(rel) {
  const segs = String(rel).split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  return segs.length >= 2 && segs[segs.length - 1] === 'worktrees' && segs[segs.length - 2] === '.claude';
}
/** hasGitEntry(dirAbs) — WP-SYNC-R10: the folder holds a `.git` entry of ANY kind (file, folder, link — lstat, never followed).
 *  In the gitless walk this is what makes a child of `.claude/worktrees` an agent checkout (skipped); every other child there is
 *  walked and scanned like the rest of the tree. Nested-repo discovery (git mode) still skips the whole `.claude/worktrees`
 *  folder: there only tracked files are scanned anyway, and every child there that is a repository is a checkout. */
function hasGitEntry(dirAbs) { try { fs.lstatSync(path.join(dirAbs, '.git')); return true; } catch { return false; } }

/**
 * nestedGitRepos(root, maxDepth) -> ['command-center', ...] (root-relative, forward slashes, sorted)
 *
 * THE BLIND SPOT THIS EXISTS FOR (measured on this project, not assumed):
 *     git ls-files | wc -l                      -> 1298
 *     git ls-files | grep -c '^command-center/' ->    0
 * `command-center/` is its own git repository nested under the project root, so the outer index has never
 * heard of a single file in it. trackedFiles() sourced the entire leak scan from that one index, which
 * means the gateway that spawns the real `claude` CLI and the Discord integration that holds a live bot
 * token were never scanned once — while the doctor printed "1146 tracked files (git) · clean" and the sync
 * gate consumed that as coverage. A scan cannot honestly call a tree clean when it never opened it, and
 * nothing in the output distinguished "found nothing" from "looked at nothing". When that same tree was
 * later published as one repository, 9 findings appeared on the first scan.
 *
 * A directory counts as a nested repo when it contains a `.git` entry of ANY kind — a directory (ordinary
 * clone) or a file (worktree / submodule gitlink). Descent continues past a found repo so a doubly-nested
 * one is still discovered, and the ordinary heavy/vendor directories are skipped exactly as the walk
 * fallback below skips them. Never throws: an unreadable directory is simply not descended into.
 */
function nestedGitRepos(root, maxDepth, notScannedOut) {
  const cap = Number.isFinite(maxDepth) ? maxDepth : NESTED_REPO_MAX_DEPTH;
  const found = [];
  (function walk(dir, depth, rel) {
    if (depth > cap) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory() || WALK_SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(dir, e.name);
      // WP-SYNC-R8: agent worktree checkouts — never a nested repo of ours, never descended (see isAgentWorktreesDir)
      if (isAgentWorktreesDir(childRel)) { if (Array.isArray(notScannedOut)) notScannedOut.push(childRel); continue; }
      if (isVenvDir(childAbs)) continue; // a venv is dependency territory — never a nested repo of ours
      if (fs.existsSync(path.join(childAbs, '.git'))) found.push(childRel);
      walk(childAbs, depth + 1, childRel);
    }
  })(root, 1, '');
  return found.sort();
}

/** gitLsFiles(dirAbs) -> string[] | null — the repo's own tracked-file list, or null when this is not a
 *  usable git repository. `git ls-files` is the only listing method used for a nested repo, deliberately:
 *  it lists TRACKED files and nothing else, so whatever that repo gitignores (its `.env`, its build output)
 *  is never opened, never scanned, and never even named as a path in the report. Widening the scan must not
 *  become a way to read files the repository itself declared out of bounds. */
function gitLsFiles(dirAbs) {
  const r = spawnSync('git', ['-C', dirAbs, 'ls-files'], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** trackedFiles(root) -> {source, files, sources}
 *  `sources` is the honest accounting the old single-number output could not give: one entry per repository
 *  that actually contributed, `{root, method, files}`, so "N tracked files" can never again mean "N files
 *  from however many of this tree's repositories we happened to notice". A source whose `git ls-files`
 *  fails is reported with `unavailable` rather than dropped — and is NOT walked as a consolation prize,
 *  because a walk would read exactly the ignored files the git listing exists to exclude.
 *  Nested discovery only applies when the ROOT itself is a git repo. When git is unavailable the walk
 *  fallback already covers the whole tree from the root down (including any nested repo's working files),
 *  and it is left byte-for-byte as it was. */
function trackedFiles(root) {
  // WP-SYNC-R8: folders deliberately not descended into (agent worktree checkouts), reported — never silently dropped
  const notScannedDirs = [];
  // WP-SYNC-R10 (Codex R8-03b): in the gitless walk only the CHECKOUTS inside .claude/worktrees are skipped; how many, per folder
  const checkoutsSkipped = new Map();
  const notScanned = () => [...new Set(notScannedDirs)].sort().map((dir) => (checkoutsSkipped.has(dir)
    ? { dir, reason: 'agent worktree checkouts (' + checkoutsSkipped.get(dir) + ' folder(s) holding a .git entry) — scratch copies of this repository, not scanned; every other file in ' + dir + '/ was scanned', checkouts: checkoutsSkipped.get(dir) }
    : { dir, reason: 'agent worktree checkouts (git worktree add) — scratch copies of this repository, not scanned' }));
  const rootList = gitLsFiles(root);
  if (rootList) {
    const files = rootList.slice();
    const seen = new Set(rootList);
    const sources = [{ root: '.', method: 'git', files: rootList.length }];
    for (const relDir of nestedGitRepos(root, NESTED_REPO_MAX_DEPTH, notScannedDirs)) {
      const nested = gitLsFiles(path.join(root, relDir.split('/').join(path.sep)));
      if (nested === null) { sources.push({ root: relDir, method: 'git', files: 0, unavailable: 'git ls-files failed' }); continue; }
      let added = 0;
      for (const f of nested) {
        // de-duplicated on purpose: a nested repo's directory can also be tracked by the outer index (an
        // added submodule, a directory that gained its own .git later), and one file must not be scanned
        // twice nor counted twice in the totals.
        const rel = relDir + '/' + f;
        if (seen.has(rel)) continue;
        seen.add(rel); files.push(rel); added++;
      }
      sources.push({ root: relDir, method: 'git', files: added });
    }
    return { source: 'git', files, sources, notScanned: notScanned() };
  }
  // fallback: bounded walk, skip the usual heavy/secret-bearing dirs (git absent). forge-runs + forge-backups
  // are Forge's OWN operational artifacts (run logs; backups of Forge's own system files, which include test
  // fixtures) — never the project source we scan for leaked credentials.
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6) return; let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // WP-SYNC-R10 (Codex R8-03b): R8 skipped the WHOLE .claude/worktrees folder here, so a plain folder or file there (not a
    // checkout) was never leak-scanned in gitless mode. Now the walk goes in, and skips only a child that holds a `.git` entry
    // of any kind (a `git worktree add` checkout's .git FILE, a clone's .git folder) — that one is named in notScanned.
    const dirRel = path.basename(dir).toLowerCase() === 'worktrees' ? path.relative(root, dir).split(path.sep).join('/') : null;
    const inWorktrees = dirRel !== null && isAgentWorktreesDir(dirRel);
    for (const e of es) {
      if (e.isDirectory()) {
        const childAbs = path.join(dir, e.name);
        if (inWorktrees && hasGitEntry(childAbs)) { notScannedDirs.push(dirRel); checkoutsSkipped.set(dirRel, (checkoutsSkipped.get(dirRel) || 0) + 1); continue; }
        if (!WALK_SKIP_DIRS.has(e.name) && !isVenvDir(childAbs)) walk(childAbs, depth + 1);
        continue;
      }
      if (e.isFile()) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  })(root, 0);
  return { source: 'walk', files: out, sources: [{ root: '.', method: 'walk', files: out.length }], notScanned: notScanned() };
}
// A matched string only counts as a REAL leak if it isn't a placeholder, a short label, or a repeated-
// filler test fixture. (Redaction patterns are intentionally aggressive; leak DETECTION must be precise so
// it doesn't cry wolf on the security tooling + test fixtures. The match text is used only transiently for
// this decision — it is NEVER stored or printed.)
// Explicit "this is not a real credential" intent markers — a human deliberately wrote one of these into a
// placeholder / fixture value. Present in the SECRET portion of a match -> exempt. (5th fix round, break-swarm
// #6: XXXX was moved OUT of this STRONG set into the WEAK signals in looksLikeRealSecret — 4 literal X's occur
// INCIDENTALLY inside real high-entropy tokens, e.g. ghp_aB3xxxxKz9..., so on their own they must never
// exempt a genuine, store-redactable secret.)
const STRONG_PLACEHOLDER_RE = /FAKE|EXAMPLE|PLACEHOLDER|REDACTED|SAMPLE|DUMMY|CHANGE[_-]?ME|YOUR[_-]?|SECRETSECRET/i;
// Fix (SYSTEM-BREAKING + HIGH, 2nd fix round): the previous "REGEX_SOURCE_RE" character-shape
// heuristic (`/\\|\{\d+,?\d*\}|\[[^\]\r\n]{1,200}\]/`, added in the FIRST fix round) was ITSELF fundamentally
// broken — it tried to distinguish a regex SOURCE from a secret VALUE by looking at loose characters
// (backslash / `{n,m}` / `[...]`), but a genuine secret can legitimately contain every one of those:
//   - a PEM private key inlined in JSON (`JSON.stringify({private_key: '...BEGIN...\n'+body+'\n...END...'})`,
//     the exact shape of a committed GCP service-account key) has LITERAL two-character `\n` escape
//     sequences in the file — the backslash alone tripped REGEX_SOURCE_RE and the WHOLE PEM match was waved
//     through as "just a regex source", even though `store.redactValue` on the same content redacts it fine.
//   - a connection-string password containing `[`, `]`, `\`, or a `{n,m}`-shaped substring (e.g.
//     `postgres://user:EXAMPLE-My[Secret]Pass99xx@host/db` — the PASSWORD is deliberately marked EXAMPLE so
//     this very comment doesn't itself trip this file's own leak_scan) tripped the same false exemption.
// There is no reliable CHARACTER-based signal here; the only reliable signal is CONTEXT: is this exact text
// sitting literally between `/` delimiters (or inside a `new RegExp('...')` call) on its own source line —
// i.e. it IS a pattern DEFINITION (like store.SECRET_PATTERNS itself, or an AGENT_INJECTION_PATTERNS entry),
// not a secret VALUE — see isPatternDefinitionContext() below, which replaces REGEX_SOURCE_RE entirely.
// looksLikeRealSecret() is now a PURE content check only (length / placeholder / repeated-filler); it no
// longer makes any regex-source judgement — that job belongs solely to isPatternDefinitionContext(), which
// needs the surrounding source text + match position to decide honestly instead of guessing from characters
// the match happens to contain.
// secretPortion — for a url-embedded-credentials match (scheme://user:YOUR_PASSWORD@) return only the password (the
// actual secret); for every other pattern the whole match IS the secret. 5th fix round (break-swarm #6,
// SYSTEM-BREAKING): the placeholder heuristic used to run against the WHOLE match, so a benign 'example'/
// 'sample' in the scheme or username (an "example_user" login with a REAL password on a staging DB — a
// ubiquitous shape) waved the REAL password through with a SILENT miss. Judging placeholders on the PASSWORD
// only fixes that while still exempting a genuine placeholder password like YOUR_PASSWORD.
function secretPortion(match) {
  if (/^[a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+:[^\s:/@]+@$/i.test(match)) {
    const noAt = match.slice(0, -1);                 // drop trailing '@'
    return noAt.slice(noAt.lastIndexOf(':') + 1);    // password after the last ':' (scheme/user colons are earlier)
  }
  return match;
}
function looksLikeRealSecret(match) {
  if (typeof match !== 'string' || match.length < 16) return false;  // real keys are long; short = a label like "nvapi-key"
  const secret = secretPortion(match);
  if (STRONG_PLACEHOLDER_RE.test(secret)) return false;              // explicit placeholder / fixture intent in the secret itself
  // WEAK signals — an XXXX run or a repeated-filler run (7+ same char). A REAL high-entropy secret can contain
  // such a substring INCIDENTALLY (ghp_...xxxx..., a base64 all-zero run -> AAAAAAA), so these exempt ONLY when
  // they DOMINATE the secret (cover >= half of it, i.e. it is really a filler/placeholder token, not a key that
  // merely happens to contain the substring). break-swarm #6 proved the old whole-match test silently dropped
  // real secrets on both triggers.
  const residue = secret.replace(/X{4,}/gi, '').replace(/(.)\1{6,}/g, '');
  if (secret.length > 0 && (secret.length - residue.length) >= secret.length / 2) return false; // dominated -> fixture/placeholder
  return true;
}
// Fix (SYSTEM-BREAKING, 3rd fix round): round 2's isPatternDefinitionContext() was context-based
// (not character-based) instead of round 1's broken character-shape guess — an improvement, but it was ITSELF
// still too broad: it judged purely from the TEXT SURROUNDING the match (an unescaped `/` immediately before
// + `/[flags]` immediately after), with no idea whether the scanned FILE is even JavaScript, or whether that
// trailing `/` is a real regex-literal close versus an ordinary trailing-slash URL/path. Two system-breaking
// misses, both proven by an adversarial break-swarm against the REAL tool:
//   1. A real secret in a NON-JS data file (.md/.yaml/.json/.env/.txt) merely WRAPPED in `/.../ ` character-
//      shape (e.g. `notes.md` containing "Deploy key: /nvapi-<realkey>/g and more") reads exactly like a regex
//      literal in raw text, even though the file has no JS regex syntax at all — store.redactValue redacts it,
//      leakScan missed it.
//   2. A real secret sitting in a URL/path that happens to END in "/" (e.g.
//      "https://api.github.com/repos/x/ghp_<realtoken>/") — the trailing slash satisfies the same
//      "regex-literal-close" text shape, so it was waved through too.
// There is no reliable way to tell a genuine JS regex literal apart from these shapes using text alone — `/`
// is division, a regex start, AND a path separator, and context alone can't disambiguate without knowing what
// kind of file it's even looking at. The root fix: shrink the exemption surface to the only place a REAL
// pattern definition can legitimately exist — the two source files that literally DEFINE
// store.SECRET_PATTERNS / doctor's own AGENT_INJECTION_PATTERNS (forge-store.cjs, forge-doctor.cjs;
// PATTERN_DEFINITION_PATHS below). Every other tracked file (.md/.yaml/.json/.env/.txt, any other .js/.cjs,
// agent-memory, docs, etc.) gets NO `/.../ ` exemption anymore — only the PLACEHOLDER_RE marker exempts there.
// isPatternDefinitionContext() itself is UNCHANGED (still the best-available regex-literal-shape heuristic);
// what changed is that leakScan() below now only ever CALLS it for a whitelisted FULL PATH, never globally.
// 4th fix round (break-swarm #4): key on the exact repo-relative PATH, not path.basename(rel).
// Basename-matching WIDENED the exemption to any file merely NAMED forge-store.cjs / forge-doctor.cjs in ANY
// subdirectory (docs/forge-store.cjs, sub/forge-doctor.cjs, an other-project copy path), silently exempting a
// real store-redactable secret disguised as a `/pattern/flags` literal there. The two files that legitimately
// DEFINE these patterns only ever live at exactly these two repo-relative paths — here and in every synced
// project (the template copies them to the same location) — so the exemption is gated on the exact path.
// 2026-09-23 (external audit II-C): the four leak-scan hits the audit saw in `command-center/` were a STALE copy of
// that code in the distribution — the source had already rewritten those lines (a PEM header split across two
// literals, comments without the dashed marker). Measured after the sync: 0 hits with the set exactly as below,
// so the exemption surface was deliberately NOT widened to a third file.
const PATTERN_DEFINITION_PATHS = new Set(['.claude/forge-bin/forge-store.cjs', '.claude/forge-bin/forge-doctor.cjs']);
// isPatternDefinitionContext — CONTEXT-based (not character-based) check: does this match sit literally
// inside a JS `/pattern/flags` regex literal, or inside the quoted first argument of a `new RegExp('...')`/
// `RegExp("...")` call, on its OWN source line in the scanned file? That is a genuine pattern DEFINITION
// (store.SECRET_PATTERNS, AGENT_INJECTION_PATTERNS, etc.), never a secret VALUE sitting in JSON/env/config
// content. Fail-closed by design (per the owner's explicit instruction): a match that spans more than one
// physical line can NEVER be a real JS regex literal (they cannot contain a literal newline), so it is
// immediately rejected here rather than risk exempting a real multi-line PEM secret. Anything this function
// cannot POSITIVELY confirm as `/…/` or `RegExp(...)` syntax is NOT exempted — ambiguous text (including a
// pattern merely quoted in prose/documentation, with no surrounding regex syntax) counts as a real leak,
// which is the safer failure mode than silently waving through an actual credential. CALLER-GATED (2026-07-15,
// 3rd/4th fix round): leakScan() below only invokes this function at all when the scanned file's exact
// repo-relative path is in PATTERN_DEFINITION_PATHS — this function no longer decides exemption scope by
// itself, only shape within an already-whitelisted file.
function isPatternDefinitionContext(text, idx, matchLen) {
  if (text.slice(idx, idx + matchLen).includes('\n')) return false; // spans lines -> can't be a JS literal
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  let lineEnd = text.indexOf('\n', idx + matchLen);
  if (lineEnd === -1) lineEnd = text.length;
  const before = text.slice(lineStart, idx);
  const after = text.slice(idx + matchLen, lineEnd);
  // `/pattern/flags` regex literal: an UNESCAPED `/` immediately precedes the match, and an unescaped `/`
  // (+ optional valid regex flags, then a normal token boundary) immediately follows it on the same line.
  const slashBefore = before === '/' || /[^\\]\/$/.test(before);
  if (slashBefore && /^\/[gimsuy]*(?:[\s,;)\]]|$)/.test(after)) return true;
  // `new RegExp('pattern')` / `RegExp("pattern")` call: match sits inside the quoted first argument.
  if (/RegExp\s*\(\s*['"`]$/.test(before) && /^['"`]\s*[,)]/.test(after)) return true;
  return false;
}
// 4th fix round (break-swarm #4): the old hard 512KB cap SILENTLY skipped any larger tracked
// file — a real committed credential in a >512KB file was never scanned, yet leak_scan still reported
// "clean / ALL GREEN" because nothing surfaced the skip. Two coupled fixes: (a) raise the scan ceiling to
// LEAK_SCAN_MAX_BYTES so every realistically-sized text file (source, config, lockfile, markdown) IS actually
// scanned — regex over a few MB of text is milliseconds; (b) make every remaining skip VISIBLE in the
// returned `skipped` array (and in printSummary), so the verdict can never again claim total coverage while
// silently dropping a file. `ok` stays hits-only on purpose: a too-large or binary file is a SURFACED
// coverage note, not a hard red — flipping the gate red on any large binary asset (an image, a dataset, a
// lockfile) would break every real project's sync gate, the exact kind of self-inflicted breakage this
// honesty loop exists to prevent. The honesty requirement is met by making the skip visible, not by lying
// about it and not by crying wolf on it.
const LEAK_SCAN_MAX_BYTES = 8 * 1024 * 1024;  // 8MB: scans every realistic text file; a larger file is surfaced in skipped, never silently dropped
const LEAK_SCAN_MAX_LINE = 16 * 1024;         // 16KB: a single line longer than this (minified bundle, data blob) is length-bounded out of regex scanning and surfaced — the structural ReDoS guard (see below)
// "test fixtures legitimately hold fake secrets" — a rule this scan has always had. Its implementation was
// /\.test\.[cm]?js$/i, i.e. JavaScript-only, and nothing about the rule was ever meant to be: a
// `chat.test.ts` holds fake credentials for exactly the same reason a `chat.test.cjs` does. The gap stayed
// invisible only because this project's one TypeScript tree (command-center/dashboard) sat inside the
// nested-repo blind spot fixed above — widening the scan surfaced 4 cry-wolf hits on *.test.ts / *.test.tsx
// in the first run. Deliberately kept to the SAME rule rather than a broader one: only the `.test.`
// infix before a JS/TS extension, so `real-source.ts` is still scanned and a file merely named
// `latest.ts` or `contest.js` is untouched. The trade-off (a genuine secret hidden in a file named
// `*.test.ts` is missed) is not new — it is the pre-existing, deliberate trade-off of the JS rule, now
// applied consistently instead of by accident of file extension.
const TEST_FIXTURE_RE = /\.test\.(?:[cm]?jsx?|[cm]?tsx?)$/i;
// leakScan detection pattern list = store.SECRET_PATTERNS EXCEPT the one MULTI-LINE PEM BLOCK pattern
// (/-----BEGIN...[\s\S]{0,N}?...-----END/) is replaced by its single-line HEADER. Reasons: (a) a
// `-----BEGIN ... PRIVATE KEY-----` line is itself the leak signal — present even in a truncated key — so
// header detection is at least as sensitive; (b) the multi-line block's lazy [\s\S]{0,N}? re-scans up to N
// chars at EVERY `-----BEGIN` position, which an adversarial many-marker file turns into O(markers*N) and
// used to take seconds on a multi-MB file. The full BLOCK pattern stays in store.SECRET_PATTERNS for
// REDACTION (redactString must remove the whole key body); leakScan only needs to DETECT, and does so
// linearly. store keeps redaction correct; leakScan stays ReDoS-proof.
const PEM_HEADER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const LEAK_SCAN_PATTERNS = store.SECRET_PATTERNS.map((re) => (re.source.includes('[\\s\\S]') ? PEM_HEADER_RE : re));
// leakScan (4th fix round, structural): scans every tracked file PER LINE with a per-line length cap, so no
// SECRET_PATTERN can ever run on more than LEAK_SCAN_MAX_LINE characters at once — catastrophic backtracking
// (O(n^2) on a long char run, which once hung the whole doctor for ~160s) is impossible by construction,
// independent of how any individual pattern is written. Coverage is honest: file-level skips (too-large /
// binary) and any length-bounded long line are all surfaced in `skipped`, never silently dropped.
function leakScan(root) {
  const { source, files, sources, notScanned } = trackedFiles(root);
  const hits = []; const skipped = []; let scanned = 0;
  for (const rel of files) {
    if (rel.endsWith('.env.example')) continue;                       // placeholders expected
    if (TEST_FIXTURE_RE.test(rel)) continue;                          // test fixtures legitimately hold fake secrets
    // Forge's OWN operational artifacts are never the project source we scan for leaked credentials: a git-
    // tracked .claude/forge-backups/ holds backups of Forge's own system files (which contain deliberate test
    // fixtures like forge-chaos.cjs's fake keys) — scanning them is circular and false-positives; .claude/
    // forge-runs/ holds Forge's own event logs (run integrity is covered by chainCheck/certify, not here).
    if (/(^|\/)\.claude\/forge-(backups|runs)\//.test(rel.replace(/\\/g, '/'))) continue;
    const abs = path.join(root, rel);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (st.size > LEAK_SCAN_MAX_BYTES) { skipped.push({ file: rel, bytes: st.size, reason: 'too-large' }); continue; }
      buf = fs.readFileSync(abs);
    } catch (e) {
      // 5th fix round (break-swarm #6): a tracked file that stat/read throws on (EACCES/EPERM permission,
      // ENOENT TOCTOU-deleted, EISDIR submodule/gitlink, EBUSY Windows lock, dangling symlink) must be
      // SURFACED, not silently swallowed — otherwise the verdict claims "clean" over a file it never scanned,
      // the exact silent-drop this round's whole design forbids. It is a coverage note, not a hard red.
      skipped.push({ file: rel, reason: 'unreadable', error: (e && e.code) ? e.code : 'read-error' });
      continue;
    }
    if (buf.includes(0)) { skipped.push({ file: rel, bytes: buf.length, reason: 'binary' }); continue; } // binary-ish
    const text = buf.toString('utf8');
    scanned++;
    // Fail-closed whitelist gate (3rd round, tightened to a FULL-PATH match in the 4th): the regex-literal-
    // context exemption is only ever eligible for the two files that actually DEFINE these patterns, at their
    // exact repo-relative path. Every other tracked file — regardless of extension OR basename, including an
    // ordinary .js/.cjs data file or a docs/forge-store.cjs decoy — gets no `/.../ ` exemption at all.
    const isPatternDefFile = PATTERN_DEFINITION_PATHS.has(rel.replace(/\\/g, '/'));
    const fired = new Set();                                          // one hit row per (file, pattern) — matches the old per-pattern semantics
    let longLines = 0;
    for (const line of text.split('\n')) {
      if (line.length > LEAK_SCAN_MAX_LINE) { longLines++; continue; } // don't regex a pathological long line
      for (const re of LEAK_SCAN_PATTERNS) {
        if (fired.has(re)) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {                        // transient only — never stored
          const exempt = isPatternDefFile && isPatternDefinitionContext(line, m.index, m[0].length);
          if (looksLikeRealSecret(m[0]) && !exempt) { hits.push({ file: rel, pattern: secretLabel(re.source) }); fired.add(re); break; }
          if (re.lastIndex === m.index) re.lastIndex++;               // guard against a zero-length match loop
        }
      }
    }
    if (longLines) skipped.push({ file: rel, reason: 'long-line', lines: longLines });
  }
  return { source, sources, scanned, skipped, ok: hits.length === 0, hits, notScanned: notScanned || [] };
}

// 6) agents check — the 12 Boss agent-files exist with valid frontmatter, AND no agent
// body carries an injection/supply-chain pattern (agent bodies become system prompts — same spirit as
// the leak scan: a `curl … | bash`, an inert context-manager plumbing block, etc. must never ship).
const BOSS_NAMES = ['boss', 'head-chef', 'review-boss', 'test-boss', 'ui-boss', 'seo-boss', 'security-boss', 'skill-boss', 'search-boss', 'build-boss', 'integration-boss', 'docs-boss'];
const AGENT_INJECTION_PATTERNS = [
  { name: 'curl-pipe-bash', re: /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i },
  { name: 'wget-pipe-sh', re: /\bwget\b[^\n]*\|\s*(ba)?sh\b/i },
  { name: 'ignore-previous-instructions', re: /ignore\s+(all\s+)?previous\s+instructions/i },
  { name: 'context-manager-plumbing', re: /Communication Protocol|context-manager/i },
];
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim(); }
  return fm;
}
// Splits a frontmatter `tools:` value ("Read, Write, Edit, Grep, Glob") into a clean array. Pure helper,
// tolerant of a missing/empty/non-string input (returns []) so a bad-frontmatter agent-md never crashes
// the tool-policy comparison below — it just shows up with an empty grant set (which will legitimately
// mismatch the policy and get flagged).
function parseToolsList(toolsStr) {
  if (typeof toolsStr !== 'string' || !toolsStr.trim()) return [];
  return toolsStr.split(',').map((s) => s.trim()).filter(Boolean);
}
function loadToolPolicy(root) {
  const file = path.join(claudeDir(root), 'config', 'agents', 'agent-tool-policy.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
/** loadToolPolicyOverlay(root) -> {present, data, error} —: .claude/config/agents/
 *  agent-tool-policy.user.json, the project's OWN never-synced overlay (forge-sync never ships or touches *.user.json).
 *  Absent is the normal state. Present-but-broken is reported, never silently ignored. */
function loadToolPolicyOverlay(root) {
  const file = path.join(claudeDir(root), 'config', 'agents', 'agent-tool-policy.user.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { present: false, data: null, error: null } : { present: true, data: null, error: 'unreadable (' + ((e && e.code) || (e && e.message)) + ')' }; }
  try { return { present: true, data: JSON.parse(raw.replace(/^﻿/, '')), error: null }; }
  catch (e) { return { present: true, data: null, error: 'not valid JSON (' + String(e.message).split('\n')[0].slice(0, 120) + ')' }; }
}
const TOOL_POLICY_OVERLAY_KEYS = new Set(['agents', '_doc', '_note']);
/** mergeToolPolicyOverlay(base, overlay) -> {policy, added[], problems[]} —. The overlay may only
 *  ADD project-own agents (e.g. 26H2's idea-reviewer), each with an EXISTING shipped class and a tools list that
 *  class allows. It can never redefine a shipped agent, add or change a class, or set any other key — every such
 *  attempt is a problem (the agents check then fails, visibly) and is not merged. Pure; the shipped policy object
 *  is never mutated (a merged copy is returned). */
function mergeToolPolicyOverlay(base, overlay) {
  const problems = [], added = [];
  if (!base || typeof base !== 'object' || overlay == null) return { policy: base, added, problems };
  if (typeof overlay !== 'object' || Array.isArray(overlay)) return { policy: base, added, problems: ['agent-tool-policy.user.json must be a JSON object'] };
  for (const k of Object.keys(overlay)) if (!TOOL_POLICY_OVERLAY_KEYS.has(k)) problems.push('agent-tool-policy.user.json: key "' + k + '" is not allowed — an overlay may only ADD agents; classes and every other field stay template-owned');
  const agents = overlay.agents;
  if (agents === undefined) return { policy: base, added, problems };
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return { policy: base, added, problems: problems.concat(['agent-tool-policy.user.json: "agents" must be an object']) };
  const classes = base.classes && typeof base.classes === 'object' ? base.classes : {};
  const shipped = base.agents && typeof base.agents === 'object' ? base.agents : {};
  const merged = Object.assign({}, shipped);
  for (const [name, entry] of Object.entries(agents)) {
    if (Object.prototype.hasOwnProperty.call(shipped, name)) { problems.push('agent "' + name + '" is defined by the shipped policy — an overlay can never redefine (or loosen) a shipped agent'); continue; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { problems.push('agent name "' + name + '" is not a plain agent file name'); continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { problems.push('agent "' + name + '" must be an object with a "class" and a "tools" list'); continue; }
    if (typeof entry.class !== 'string' || !Object.prototype.hasOwnProperty.call(classes, entry.class)) { problems.push('agent "' + name + '": class "' + entry.class + '" does not exist in the shipped policy — an overlay can only use an existing class, never create one'); continue; }
    if (!Array.isArray(entry.tools) || !entry.tools.length || entry.tools.some((x) => typeof x !== 'string' || !x.trim())) { problems.push('agent "' + name + '" needs a non-empty "tools" list of tool names'); continue; }
    const forbidden = Array.isArray(classes[entry.class].forbidden) ? classes[entry.class].forbidden : [];
    const bad = entry.tools.filter((x) => forbidden.includes(x.trim()));
    if (bad.length) { problems.push('agent "' + name + '" asks for ' + bad.join(', ') + ', which its class "' + entry.class + '" forbids'); continue; }
    merged[name] = JSON.parse(JSON.stringify(entry));
    added.push(name);
  }
  return { policy: Object.assign({}, base, { agents: merged }), added, problems };
}
/** memoryAllowedForClass(policyFile, agentName) -> true/false/null — N5 (2026-09-26 laptop re-audit):
 *  Claude Code grants Write+Edit to ANY agent whose frontmatter carries `memory: project`, regardless of its
 *  `tools:` line — so a class whose policy forbids Write (read-only-audit, exec-reviewer) must never carry
 *  `memory: project` in its agent-md, and every OTHER class must carry it (memory is how these roles persist
 *  their own notes between runs). Derived straight from agent-tool-policy.json's `classes[...].forbidden`
 *  list, never hardcoded here, so a future class stays correct without touching this file. Returns null
 *  (unresolvable) when the policy file or this agent's class entry cannot be read — callers fall back to the
 *  OLDER, stricter "memory is always required" behavior in that case rather than silently skipping the check. */
function memoryAllowedForClass(policyFile, agentName) {
  const cls = policyFile && policyFile.agents && policyFile.agents[agentName] && policyFile.agents[agentName].class;
  const forbidden = cls && policyFile.classes && policyFile.classes[cls] && Array.isArray(policyFile.classes[cls].forbidden)
    ? policyFile.classes[cls].forbidden : null;
  return forbidden ? !forbidden.includes('Write') : null;
}
// Claude Code only loads a project agent whose frontmatter `model` is one of its aliases. On 2026-09-27 the
// two agents that carried the full id "claude-opus-5-5" (verify-boss, codex-reviewer) were silently absent from the
// session's agent list while all 17 alias agents loaded — so every install shipped two agents nobody could dispatch.
const LOADABLE_AGENT_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
function agentsCheck(root) {
  const dir = path.join(claudeDir(root), 'agents');
  const missing = [], badFrontmatter = [], injection = [];
  // loaded once, up front, and reused below for the least-privilege tool-grant comparison too.
  // merged with the project's add-only agent-tool-policy.user.json overlay (never synced).
  const shippedToolPolicy = loadToolPolicy(root);
  const overlayFile = loadToolPolicyOverlay(root);
  const overlay = shippedToolPolicy ? mergeToolPolicyOverlay(shippedToolPolicy, overlayFile.data) : { policy: null, added: [], problems: [] };
  if (overlayFile.error) overlay.problems.push('agent-tool-policy.user.json is ' + overlayFile.error);
  const toolPolicyFileForAgents = overlay.policy;
  for (const name of BOSS_NAMES) {
    const file = path.join(dir, name + '.md');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { missing.push(name); continue; }
    const fm = parseFrontmatter(text);
    const memoryAllowed = memoryAllowedForClass(toolPolicyFileForAgents, name);
    // memoryAllowed === null: class unresolvable (policy missing/broken) -> fall back to requiring memory,
    // the earlier behavior, rather than silently accepting either shape.
    const memoryOk = memoryAllowed === false ? !(fm && fm.memory) : Boolean(fm && fm.memory === 'project');
    if (!fm || fm.name !== name || !fm.description || !fm.tools || !fm.model || !memoryOk) badFrontmatter.push(name);
  }
  // injection-lint EVERY agent file present (Bosses + specialists + codex-reviewer), and collect each
  // one's REAL granted tools (keyed by filename, not the frontmatter's own `name:` field, so a bad/mismatched
  // frontmatter still gets compared against the policy rather than silently skipped).
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }
  const grants = {};
  const unloadableModel = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const p of AGENT_INJECTION_PATTERNS) { if (p.re.test(text)) injection.push({ file: 'agents/' + f, pattern: p.name }); }
    const base = f.replace(/\.md$/, '');
    const fm = parseFrontmatter(text);
    grants[base] = parseToolsList(fm && fm.tools);
    if (fm && fm.model && !LOADABLE_AGENT_MODELS.has(String(fm.model).trim().toLowerCase())) unloadableModel.push({ file: 'agents/' + f, agent: base, model: String(fm.model).trim() });
  }
  // mechanical least-privilege enforcement: compare every agent-md's ACTUAL frontmatter
  // tools against the pinned .claude/config/agents/agent-tool-policy.json source of truth. A missing/
  // unparseable policy file is itself a failure (never a silent pass — same "no evidence" discipline as
  // the other checks in this file), not just a skipped sub-check.
  const toolPolicyFile = toolPolicyFileForAgents;
  let toolPolicy;
  if (!policy) {
    toolPolicy = { ok: false, reason: 'forge-policy.cjs module not available (toolPolicyCheck unavailable)', missingPolicy: [], missingAgentFile: [], classViolations: [], driftViolations: [] };
  } else if (!toolPolicyFile) {
    toolPolicy = { ok: false, reason: 'agent-tool-policy.json missing or unparseable at .claude/config/agents/agent-tool-policy.json', missingPolicy: [], missingAgentFile: [], classViolations: [], driftViolations: [] };
  } else {
    toolPolicy = policy.toolPolicyCheck(toolPolicyFile, grants);
  }
  // a rejected overlay entry fails the check visibly; accepted project agents are named on the result.
  if (overlay.problems.length || overlay.added.length) {
    toolPolicy = Object.assign({}, toolPolicy, { overlayAdded: overlay.added }, overlay.problems.length ? { ok: false, overlayProblems: overlay.problems } : {});
  }
  return {
    ok: missing.length === 0 && badFrontmatter.length === 0 && injection.length === 0 && toolPolicy.ok === true
      && !unloadableModel.some((u) => toolPolicyFileForAgents && toolPolicyFileForAgents.agents && toolPolicyFileForAgents.agents[u.agent]),
    expected: BOSS_NAMES.length,
    found: files.length,
    missing,
    badFrontmatter,
    injection,
    toolPolicy,
    unloadableModel,
  };
}

/** modelRoutingCheck(root) — GOAT model routing, ENFORCED. Delegates to forge-policy.cjs's
 *  routingCheck(): every agent's frontmatter model/effort == agent-model-map claudeTier/claudeEffort ==
 *  agent-tool-policy model, valid aliases/efforts, a complete routes table with escalate == fable, no default
 *  haiku/fable, and no CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_CODE_SUBAGENT_MODEL / modelSettings effort override in
 *  the project settings. A project with neither .claude/FORGE_MODEL_ROUTING.json nor agent-model-map.json has
 *  no Forge routing to check (applicable:false, ok:true — said so on its summary line, never a silent pass).
 *  A missing forge-policy.cjs in a project that DOES carry routing files fails the check (ok:false, reason),
 *  the same honest-degrade posture agentsCheck takes for the tool-policy sub-check. Recoverable through
 *  FORGE_HARD_RULES.json doctor_check_overrides (check id 'model_routing') like the other enforced checks. */
function modelRoutingCheck(root) {
  const hasRouting = fs.existsSync(path.join(claudeDir(root), 'FORGE_MODEL_ROUTING.json'))
    || fs.existsSync(path.join(claudeDir(root), 'config', 'agents', 'agent-model-map.json'));
  if (!policy || typeof policy.routingCheck !== 'function') {
    return hasRouting
      ? { ok: false, applicable: true, checked: 0, violations: [], notes: [], reason: 'forge-policy.cjs routingCheck not available — the model-routing files cannot be checked' }
      : { ok: true, applicable: false, checked: 0, violations: [], notes: [], reason: 'no Forge model-routing files and no forge-policy.cjs — nothing to check' };
  }
  try { return policy.routingCheck(root); }
  catch (e) { return { ok: false, applicable: true, checked: 0, violations: [], notes: [], reason: 'routingCheck threw: ' + e.message }; }
}

// Tamper-evident chain check: walk each run's events.jsonl hash-chain (log-event.cjs writes
// entry_hash = sha256(canonical(event)+prev_hash)). LEGACY runs with no entry_hash anywhere are skipped
// (not broken). A chained run is BROKEN if an event's self-hash mismatches (edited) or its prev_hash links
// nowhere (truncation/removal). Tolerant of concurrent forks: prev_hash may reference ANY prior entry_hash.
//
// Fix (HIGH bug): a MIXED run — a legacy prefix with no entry_hash, followed later by REAL
// chained events once log-event.cjs's hash chain was adopted mid-run — used to be misclassified. The old
// gate (`evs.some(e=>e.entry_hash)`) only decided "skip or not"; once ANY event had a hash, validation
// walked the WHOLE array from index 0, so the legacy prefix's hash-less events were reported as "missing
// hash fields" — indistinguishable from a genuine tamper (cry-wolf). Fix: find the FIRST index that
// carries an entry_hash and validate ONLY from there onward (mirrored in forge-certify.cjs's verifyChain
// and in log-event.cjs's own prev_hash lookup, which now searches backward for the nearest prior chained
// event instead of assuming the file's last line is always it). Earlier legacy events are skipped, not
// counted as broken; a genuine tamper anywhere in the chained section is still caught exactly as before.
//
// Fix (MEDIUM bug): a single blank/whitespace-only line inside events.jsonl (JSON.parse('')
// throws) used to make the ENTIRE run "unparseable" here, while forge-certify's readEventsJsonl already
// tolerated it — two honesty gates disagreeing on identical bytes. Blank lines are now skipped the same
// way certify does; a genuinely malformed NON-blank line still fails this check exactly as before.
//
// Fix (HIGH bug, 2nd fix round): a line that IS valid JSON but NOT a plain object (a bare
// number, array, string, `null`, or boolean — e.g. `123`, `[1,2,3]`, `"x"`) used to be accepted here via
// `out.push(JSON.parse(s))` with no type check at all, silently treated as a real "event". forge-certify's
// readEventsJsonl has ALWAYS counted exactly this shape as malformed (`if (v && typeof v==='object' &&
// !Array.isArray(v)) events.push(v); else malformed++`), so the two honesty gates gave OPPOSITE verdicts on
// identical bytes: doctor's chainCheck (via the old findIndex-for-first-entry_hash logic) would just skip
// past the non-object "event" (it has no `.entry_hash` property) and validate the real chained events that
// follow as ok:true, while certify counted the same line as malformed and returned NOT CERTIFIED. Fix:
// mirror certify's exact condition — a valid-JSON-but-non-plain-object line now THROWS here too, so the
// caller (chainCheck) reports the whole run as unparseable, exactly matching certify's malformed-line
// verdict on the same bytes. A genuine blank line remains benign/skipped (unchanged).
function chainCanon(ev) { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); }
function parseEventsJsonlLenient(raw) {
  // Skips blank/whitespace-only lines (never malformed); a genuinely malformed non-blank line — including a
  // syntactically-valid-JSON line that is NOT a plain object — throws so the caller can report the whole
  // run as unparseable — same all-or-nothing behavior as before this fix, just no longer confused by a
  // benign blank line, and no longer accepting a non-object primitive as a fake "event".
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const v = JSON.parse(s);
    if (!(v && typeof v === 'object' && !Array.isArray(v))) {
      throw new Error('events.jsonl line is valid JSON but not a plain object (mirrors forge-certify.cjs readEventsJsonl): ' + s.slice(0, 80));
    }
    out.push(v);
  }
  return out;
}
function chainCheck(root) {
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  let runIds = [];
  try { runIds = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { ok: true, checked: 0, chained: 0, broken: [], note: 'no forge-runs' }; }
  let chained = 0; const broken = [];
  for (const id of runIds) {
    let raw; try { raw = fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8'); } catch { continue; }
    if (!raw || !raw.trim()) continue;
    let evs; try { evs = parseEventsJsonlLenient(raw); } catch { broken.push({ run: id, reason: 'unparseable events.jsonl' }); continue; }
    const startIdx = evs.findIndex((e) => e && e.entry_hash);
    if (startIdx === -1) continue; // legacy / fully unchained run — skip, not broken
    chained++;
    const seen = new Set(['genesis:' + id]); let ok = true, reason = '';
    for (let i = startIdx; i < evs.length; i++) {
      const e = evs[i];
      if (!e.entry_hash || !e.prev_hash) { ok = false; reason = 'event ' + i + ' missing hash fields'; break; }
      if (crypto.createHash('sha256').update(chainCanon(e) + e.prev_hash).digest('hex') !== e.entry_hash) { ok = false; reason = 'event ' + i + ' self-hash mismatch (edited?)'; break; }
      if (!seen.has(e.prev_hash)) { ok = false; reason = 'event ' + i + ' prev_hash links nowhere (truncation/removal?)'; break; }
      seen.add(e.entry_hash);
    }
    if (!ok) broken.push({ run: id, reason });
  }
  return { ok: broken.length === 0, checked: runIds.length, chained, broken };
}

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
const REBINDGUARD_RUNNER_FILE = path.join(__dirname, 'forge-rebindguard-runner.cjs');
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
  const runsDir = path.join(claudeDir(root), 'forge-runs');
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

// ===========================================================================================================
// WAVE A / A2 — doctor completeness checks. All four are ADVISORY-ONLY (see the header doc
// comment above for why); each function below is a pure `(root) -> {ok, ...}` reader, mirroring the shape of
// every other check in this file, so they compose the same way in runDoctor()/printSummary().
// ===========================================================================================================

// --- sync-completeness: every real skill dir / forge-bin tool / agent .md is in forge-sync's delivery list
// (listSystemFiles).: that list is DERIVED from the shipping manifest
// (config/orchestration/FORGE_SHIP_MANIFEST.json — the root's own copy, else forge-sync's), which ships skill
// folders whole and globs forge-bin/agents; the hand-kept SYSTEM[] pin list and SYSTEM_GLOB are gone. This stays an
// honest regression guard: a SKILL.md, tool or agent that the manifest does NOT classify ship-sync (a narrowed or
// broken rule — the old "forge-router silent-drift bug" class) is still flagged here.
function listSkillFiles(root) {
  const base = path.join(claudeDir(root), 'skills');
  const cd = claudeDir(root);
  const out = [];
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'SKILL.md') out.push(path.relative(cd, p).split(path.sep).join('/'));
    }
  })(base);
  return out.sort();
}
function syncCompleteness(root) {
  if (!syncTool) return { ok: false, reason: 'forge-sync.cjs module not available (sync-completeness unavailable)', missing: [] };
  const cd = claudeDir(root);
  let manifestList;
  try { manifestList = syncTool.listSystemFiles(cd); } catch (e) { return { ok: false, reason: 'forge-sync.listSystemFiles threw: ' + e.message, missing: [] }; }
  const manifestSet = new Set(manifestList.map((r) => r.split(path.sep).join('/')));
  const skillFiles = listSkillFiles(root);
  const binFiles = listByExt(path.join(cd, 'forge-bin'), ['.cjs', '.ps1', '.cmd', '.sh', '.md', '.bat']).map((p) => 'forge-bin/' + path.basename(p));
  const agentFiles = listByExt(path.join(cd, 'agents'), ['.md']).map((p) => 'agents/' + path.basename(p));
  // WP-DOC-ADV: a file the shipping manifest DELIBERATELY classifies local-only (maintainer tools
  // such as forge-fresh-repo.cjs / forge-release-sync.cjs) is not a sync gap — it is reported under
  // intentionallyLocal instead of missing. ONLY the local-only class is exempt: an unclassified file or any other
  // class (a narrowed/broken ship rule) is still flagged. A manifest that cannot be loaded keeps the old behaviour.
  let ship = null;
  try { ship = syncTool.loadShipManifest ? syncTool.loadShipManifest(cd) : null; } catch { ship = null; }
  const isLocalOnly = (rel) => {
    if (!ship) return false;
    try { const r = ship.sc.classify(ship.rules, '.claude/' + rel); return !!r && r.class === 'local-only'; } catch { return false; }
  };
  const missing = [];
  const intentionallyLocal = [];
  for (const rel of skillFiles.concat(binFiles, agentFiles)) {
    if (manifestSet.has(rel)) continue;
    if (isLocalOnly(rel)) intentionallyLocal.push(rel);
    else missing.push(rel);
  }
  return { ok: missing.length === 0, checkedSkills: skillFiles.length, checkedBinTools: binFiles.length, checkedAgents: agentFiles.length, missing, intentionallyLocal };
}

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
  const invokesSecondParam = new RegExp('\\b' + escaped + '\\s*\\(').test(body);
  return invokesSecondParam ? 'callback' : 'boolean';
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

// --- memory-discipline: FORGE_MEMORY.md is absent/empty, or still carries an unfilled scaffold-placeholder
// marker. Deliberately narrow (angle-bracket ALL-CAPS/underscore tokens + explicit TODO/TBD/FIXME markers)
// so it never false-positives on ordinary lowercase prose placeholders this project's real memory legitimately
// uses (e.g. "<boss>" as a variable reference in a sentence) — proven clean against the real FORGE_MEMORY.md.
const MEMORY_PLACEHOLDER_RE = /<PLACEHOLDER>|<TODO>|<TBD>|<FILL[_ ]IN>|<[A-Z][A-Z0-9]*(_[A-Z0-9]+)+>|\[TODO\]|\[TBD\]|\bTODO:|\bFIXME\b|\bTBD\b/;
function memoryDiscipline(root) {
  const file = path.join(claudeDir(root), 'FORGE_MEMORY.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { ok: false, present: false, reason: 'FORGE_MEMORY.md is absent (expected at .claude/FORGE_MEMORY.md)', placeholderLines: [] }; }
  if (!text.trim()) return { ok: false, present: true, reason: 'FORGE_MEMORY.md exists but is empty', placeholderLines: [] };
  const placeholderLines = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (MEMORY_PLACEHOLDER_RE.test(lines[i])) placeholderLines.push(i + 1);
  return { ok: placeholderLines.length === 0, present: true, reason: placeholderLines.length ? placeholderLines.length + ' unfilled placeholder line(s)' : '', placeholderLines };
}

// --- unregistered-event: a forge-bin/*.cjs tool's local logEvent(...) wrapper is called with a literal
// event_type string that log-event.cjs's KNOWN_EVENT_TYPES does not recognize (it would be STRICT-REJECTED,
// exit 2, at write time — see strictEventCheck above). Cross-checked against forge-verify.cjs's own
// TERMINAL_TYPES/BACKBONE mirror too, per the plan's 3-place event-registration discipline.
/** stripJsComments(text) -> the same source with // line comments and block comments removed.
 *  String-literal aware, single left-to-right pass: while inside a quoted string a `//` or a block-comment
 *  opener is just text, and while inside a comment a quote character is just text. That statefulness is the
 *  whole point — the naive stateless literal regex below cannot tell the two apart, which is exactly how an
 *  APOSTROPHE in comment prose used to flip quote parity and hide every event type after it (see
 *  extractKnownEventTypesFromSource). Same idea forge-event-wiring.test.cjs already applies before reading
 *  app.js's taskStatus() buckets, generalized here to trailing and block comments as well.
 *  Newlines are preserved (line structure stays intact) — INCLUDING every newline a multi-line block comment
 *  itself contained (2026-09-26: this doc comment already promised "line structure stays intact",
 *  but the implementation collapsed a whole multi-line `/** ... *\/` block down to a single space, silently
 *  losing every embedded newline; any caller computing a LINE NUMBER from an index into the stripped text —
 *  e.g. vacuousBooleanTHelperSites' own findings below — would report a line far too early for any code
 *  after the first multi-line JSDoc-style comment, and this codebase is full of those). A block comment now
 *  collapses to one leading space plus exactly as many `\n` as it consumed, so it can never weld two tokens
 *  together AND never shifts a later line number. Not a JS parser: a `/` that starts a regex literal is out
 *  of scope, which is fine for the string-literal lists this is used on. */
function stripJsComments(text) {
  let out = '';
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;   // the '\n' itself is kept by the default branch
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      let nl = 0;
      for (let k = start; k < i && k < n; k++) if (text[k] === '\n') nl++;
      out += ' ' + '\n'.repeat(nl); // one space so tokens never weld together, plus every newline the comment consumed
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] || ''); i += 2; continue; }
        out += text[i];
        const closed = text[i] === quote;
        i++;
        if (closed) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
/** extractKnownEventTypesFromSource(text) -> Set of the event types log-event.cjs really registers.
 *  Comments are stripped from the WHOLE source FIRST — before the Set literal is located and before any
 *  string literal is read — so neither the locating regex nor the literal scan can be steered by comment
 *  prose. Measured on this project's real log-event.cjs when the strip was missing: 186 types
 *  registered, 175 seen, 20 real types silently invisible to the ENFORCED unregistered_event gate, and 9
 *  junk "types" invented out of comment text. */
function extractKnownEventTypesFromSource(text) {
  const m = stripJsComments(text).match(/KNOWN_EVENT_TYPES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) return null;
  const out = new Set();
  const re = /'([^']+)'|"([^"]+)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out.add(mm[1] || mm[2]);
  return out;
}
const EVENT_TYPE_SHAPE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // snake_case, matches KNOWN_EVENT_TYPES' own naming convention
/** extractLoggedEventTypes — for every `logEvent(` call site, reads only the argument text BEFORE the call's
 *  object-literal payload (its first `{`) — every real logEvent() wrapper in this codebase places the literal
 *  event_type string there, whether as the 1st positional arg (forge-paperclip.cjs's `logEvent(type, obj)`) or
 *  the 2nd/3rd (forge-artifact.cjs/forge-deeplearn.cjs/forge-mindmap.cjs/forge-prd.cjs/forge-registry.cjs's
 *  `logEvent(runId, eventType, extra)`). This avoids ever matching an unrelated string INSIDE the payload
 *  object (a `note`/`evidence` value). A dynamically-built event_type (e.g. `ev.event_type`, a variable) has
 *  no quoted literal to find and is honestly skipped — never guessed. Best-effort static scan only; it does
 *  not attempt to resolve every possible spawnSync/execFileSync call shape in the codebase. */
function extractLoggedEventTypes(text) {
  const out = new Set();
  const callRe = /\blogEvent\s*\(/g;
  let cm;
  while ((cm = callRe.exec(text)) !== null) {
    const start = cm.index + cm[0].length;
    let depth = 1, i = start, braceIdx = -1;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '{' && braceIdx === -1) braceIdx = i;
    }
    const argsPrefix = text.slice(start, braceIdx !== -1 ? braceIdx : i);
    const litRe = /'([^']*)'|"([^"]*)"/g;
    let lm;
    while ((lm = litRe.exec(argsPrefix)) !== null) {
      const lit = lm[1] !== undefined ? lm[1] : lm[2];
      if (EVENT_TYPE_SHAPE_RE.test(lit)) out.add(lit);
    }
  }
  return out;
}
function unregisteredEvent(root) {
  const logEventPath = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  let leText;
  try { leText = fs.readFileSync(logEventPath, 'utf8'); }
  catch (e) { return { ok: false, reason: 'could not read log-event.cjs: ' + e.message, unregistered: [] }; }
  const known = extractKnownEventTypesFromSource(leText);
  if (!known) return { ok: false, reason: 'could not statically parse KNOWN_EVENT_TYPES from log-event.cjs', unregistered: [] };
  const verifySet = new Set();
  if (verifyTool) {
    try {
      for (const t of verifyTool.TERMINAL_TYPES || []) verifySet.add(t);
      for (const t of verifyTool.BACKBONE || []) verifySet.add(t);
    } catch { /* best effort — verify cross-check stays empty */ }
  }
  const dir = path.join(claudeDir(root), 'forge-bin');
  const files = listByExt(dir, ['.cjs']).filter((f) => !f.endsWith('.test.cjs'));
  const unregistered = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const type of extractLoggedEventTypes(text)) {
      if (known.has(type)) continue;
      const missingFrom = ['log-event.KNOWN_EVENT_TYPES'];
      if (verifyTool && !verifySet.has(type)) missingFrom.push('forge-verify.allow-list');
      unregistered.push({ file: path.relative(root, f).split(path.sep).join('/'), event_type: type, missingFrom });
    }
  }
  return { ok: unregistered.length === 0, checkedFiles: files.length, unregistered };
}

// --- mcp-dormancy (WAVE G / G-INTEGRATE): the MCP-as-client SAFETY DOCTRINE self-test.
// Reads config/orchestration/mcp-registry.json + mcp-grants.json (+ an owner-authored real `.mcp.json` MCP
// host config at the project root, if one exists — NOT config/mcp/.mcp.json.example, which is a reference
// template, never live config) and asserts, purely by reading JSON (never by requiring forge-mcp-gate.cjs,
// so a malformed/adversarial fixture can be reported as a finding instead of crashing the whole doctor run):
//   (a) no registry server is status:"active"/active:true without being listed in mcp-opt-in.json's
//       opted_in[] (the owner-authored dormancy marker), and no server configured in a real `.mcp.json`
//       host file is missing from that same opt-in list;
//   (b) no boss's mcp-grants.json allow_servers entry exceeds that boss's own declared max_tier, and no
//       allow_servers entry references a server id absent from the registry;
//   (c) no boss's allow_servers ever contains a tier-3 (WRITE-PRIMITIVE) server — tier-3 must never be a
//       standing/default grant, regardless of the boss's numeric max_tier (doctrine #3/#4).
// ADVISORY-ONLY (folded into report.advisory.completeness, same discipline as the other 4 WAVE A/A2 checks
// above) — a brand-new heuristic must never flip a healthy project's doctor run red the first time it ships.
function mcpDormancy(root, opts) {
  opts = opts || {};
  const cd = claudeDir(root);
  const registryPath = opts.registryPath || path.join(cd, 'config', 'orchestration', 'mcp-registry.json');
  const grantsPath = opts.grantsPath || path.join(cd, 'config', 'orchestration', 'mcp-grants.json');
  const optInPath = opts.optInPath || path.join(cd, 'config', 'orchestration', 'mcp-opt-in.json');
  const mcpJsonPath = opts.mcpJsonPath || path.join(root, '.mcp.json'); // real owner-authored MCP host config — NOT the .example template

  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'could not read/parse mcp-registry.json: ' + e.message, violations: [] }; }
  if (!registry || !Array.isArray(registry.servers)) return { ok: false, reason: 'mcp-registry.json has no "servers" array', violations: [] };

  let grants;
  try { grants = JSON.parse(fs.readFileSync(grantsPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'could not read/parse mcp-grants.json: ' + e.message, violations: [] }; }
  if (!grants || !grants.bosses || typeof grants.bosses !== 'object') return { ok: false, reason: 'mcp-grants.json has no "bosses" object', violations: [] };

  let optIn = { opted_in: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(optInPath, 'utf8'));
    if (parsed && Array.isArray(parsed.opted_in)) optIn = parsed;
  } catch { /* missing/malformed opt-in file -> dormant default; the forge-mcp-gate live path hard-errors on a MALFORMED (not missing) file, but this advisory reader stays lenient by design */ }
  const optedIn = new Set(optIn.opted_in);

  const violations = [];

  // (a) no server auto-active without an explicit opt-in marker
  for (const s of registry.servers) {
    if (!s || typeof s.id !== 'string') continue;
    const autoActive = s.status === 'active' || s.active === true;
    if (autoActive && !optedIn.has(s.id)) {
      violations.push({ type: 'auto_active_without_optin', server: s.id, detail: 'registry entry is active/auto-active but "' + s.id + '" is not listed in mcp-opt-in.json opted_in[]' });
    }
  }
  let mcpJson = null;
  try { mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')); } catch { mcpJson = null; }
  if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') {
    for (const id of Object.keys(mcpJson.mcpServers)) {
      if (!optedIn.has(id)) violations.push({ type: 'mcp_json_server_without_optin', server: id, detail: 'a real .mcp.json configures server "' + id + '" but it is not listed in mcp-opt-in.json opted_in[]' });
    }
  }

  // (a2) REGISTRY DRIFT. The check above only ever read `.mcp.json`, which is exactly one of
  // the places Claude Code takes MCP servers from — so servers enabled through `.claude/settings.local.json`
  // (`enabledMcpjsonServers`) or `~/.claude.json` (global `mcpServers`) were invisible here. Measured on this
  // machine: claude-flow (≈400 tools, incl. terminal_execute/http_fetch) and n8n were connected and in NO
  // registry entry, so no tier and no per-Boss grant governed them — the tier-3 write gate hardened the day
  // before applied only to servers that do not exist here. forge-mcp-gate.unregisteredServers() reads every
  // real source; this stays ADVISORY and never auto-adds anything: inventing a tier for someone else's
  // server would be the same fabricated authority the doctrine exists to prevent.
  // Scope: the REAL machine only. Discovery reads machine-global sources (~/.claude.json,
  // ~/.claude/settings.json) that exist regardless of which root is being checked, so running it against
  // a hermetic fixture registry would report the machine's own servers as "missing" from a fixture — a
  // finding about nothing. A caller that supplies its own registryPath is by definition testing the
  // dormancy LOGIC on a fixture; drift is about reality, so it is checked only on the real config.
  const isOwnProject = path.resolve(root) === path.resolve(__dirname, '..', '..');

  // (a3) WAS THE GATE EVER REACHED? (broad Codex audit #1, wired 2026-08-05.) forge-mcp-gate enforces
  // tiers, allow-lists and owner-verified tier-3 writes — but it is a library nobody must call, and
  // `mcp_grant_validated` had ZERO occurrences across every run: the same shape as the run-contract gate,
  // which existed and was tested for months while never once being evaluated. Forge cannot hook Claude
  // Code's tool dispatcher, so this cross-references the PostToolUse tool ledger (which records every
  // `mcp__*` call) against the gate's own decisions. A quiet machine reports "nothing to gate" — never
  // "the gate works".
  try {
    const usage = require('./forge-mcp-usage.cjs');
    const u = usage.check({ root });
    if (u && u.ok === false) {
      violations.push({ type: 'mcp_tool_used_without_gate', detail: u.reason, tools: (u.ungated || []).map((t) => t.tool + ' x' + t.count) });
    }
  } catch { /* sibling tool unavailable -> sub-check not run; never a fabricated all-clear */ }
  try {
    const gate = isOwnProject ? require('./forge-mcp-gate.cjs') : null;
    if (gate && typeof gate.unregisteredServers === 'function') {
      const drift = gate.unregisteredServers({ registryPath, projectRoot: root, homeDir: opts.homeDir });
      for (const u of (drift.unregistered || [])) {
        violations.push({
          type: 'configured_server_not_in_registry', server: u.id, sources: u.sources,
          detail: 'MCP server "' + u.id + '" is configured on this machine (' + u.sources.join(', ') + ') but is absent from mcp-registry.json — it is governed by no tier and no per-Boss grant',
        });
      }
    }
  } catch { /* sibling tool unavailable -> this sub-check is simply not run; never a fabricated all-clear */ }

  // (b)+(c) per-boss grant self-consistency
  const serverById = new Map(registry.servers.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
  for (const [bossId, g] of Object.entries(grants.bosses)) {
    if (!g || typeof g.max_tier !== 'number' || !Array.isArray(g.allow_servers)) {
      violations.push({ type: 'malformed_grant', boss: bossId, detail: 'grant entry missing max_tier/allow_servers' });
      continue;
    }
    for (const serverId of g.allow_servers) {
      const entry = serverById.get(serverId);
      if (!entry) { violations.push({ type: 'unknown_server_in_grant', boss: bossId, server: serverId, detail: 'grant references a server id not present in mcp-registry.json' }); continue; }
      // Type-normalize the registry tier before comparing. A poisoned config (tier as a string like '3',
      // a float, out-of-range, or missing) must NOT slip past these guards — the enforcement gate
      // (forge-mcp-gate.loadRegistry) hard-rejects a non-number tier, and this advisory check is deliberately
      // decoupled from it, so it must replicate that validation itself rather than trust the JSON shape.
      // (Found by the Wave-G break-swarm: `tier:'3'` defeated the strict `=== 3` / `> max_tier` guards.)
      const t = (typeof entry.tier === 'number') ? entry.tier
        : (typeof entry.tier === 'string' && /^\d+$/.test(entry.tier.trim()) ? Number(entry.tier.trim()) : NaN);
      if (!Number.isInteger(t) || t < 0 || t > 3) { violations.push({ type: 'malformed_server_tier', boss: bossId, server: serverId, tier: entry.tier, detail: 'server tier is not an integer 0-3 (poisoned/invalid registry entry) — treated as a violation, never all-clear' }); continue; }
      if (t === 3) { violations.push({ type: 'tier3_default_grant', boss: bossId, server: serverId, detail: 'tier-3 write-primitive must never be a standing/default grant (doctrine #3/#4)' }); continue; }
      if (t > g.max_tier) { violations.push({ type: 'grant_exceeds_max_tier', boss: bossId, server: serverId, tier: t, max_tier: g.max_tier, detail: 'server tier exceeds this boss\'s declared max_tier' }); }
    }
  }

  return { ok: violations.length === 0, checkedServers: registry.servers.length, checkedBosses: Object.keys(grants.bosses).length, violations };
}

// ===========================================================================================================
// V9-INTEGRATE — run-contract wiring + the doctor_check_overrides recovery path. See the header
// doc comment ("V9-INTEGRATE ENFORCEMENT OVERRIDE PATH") for the full model.
// ===========================================================================================================

/** rankRunCandidates(root, opts) -> [{name, mtimeMs}, ...] sorted newest-first. Shared ranking core behind
 *  BOTH latestRunIdFor() and latestDispatchedRunIdFor() below — one recency algorithm, never two that could
 *  silently drift apart. Ranks by REAL recency: the latest of (a) events.jsonl's own mtime — the truest
 *  "last real activity" signal, updated on every real event append — (b) run.json's mtime, and (c) the run
 *  directory's own mtime, taking the max of whichever of these exist. Name is only a TIE-BREAK (descending)
 *  for the vanishingly-rare case of two runs with an identical mtime down to the millisecond.
 *  opts.requireDispatched:true (V9, 2026-07-22 — forge-audit-loop's own doctor-receipt-vs-real-run
 *  gap) additionally requires a REAL, parseable run.json object — a "doctor-receipt-only" directory (created
 *  solely by this file's own `--run <id>` CLI flag: a doctor.json snapshot + a single synthetic doctor_run
 *  event in events.jsonl, but NO run.json at all — see this file's own CLI body below) is never mistaken for
 *  a genuine DISPATCHED Forge run, which always has a real run.json written by the orchestration layer.
 *  Without opts.requireDispatched, behavior is byte-for-byte the original "any real run dir" filter (must
 *  have a real run.json OR events.jsonl) — unchanged. */
/** lastEventTimeMs(file) -> ms sinds epoch van het LAATSTE parseerbare event, of 0.
 *  Leest alleen de staart (8 KiB): de rangschikking mag niet duurder worden naarmate een run groeit, en
 *  het laatste event staat per definitie achteraan. Een half afgeknotte eerste regel in dat venster
 *  parseert simpelweg niet en wordt overgeslagen — daarom van achter naar voren. */
function lastEventTimeMs(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return 0;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const t = Date.parse(o && (o.ingested_at || o.timestamp)); // the writer-stamped instant wins
        if (Number.isFinite(t)) return t;
      } catch { /* afgeknotte of corrupte regel — probeer de vorige */ }
    }
    return 0;
  } catch { return 0; }
  finally { try { fs.closeSync(fd); } catch { } }
}

function rankRunCandidates(root, opts) {
  opts = opts || {};
  const dir = path.join(claudeDir(root), 'forge-runs');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(dir, e.name);
    const eventsPath = path.join(runDir, 'events.jsonl');
    const runJsonPath = path.join(runDir, 'run.json');
    const hasEvents = fs.existsSync(eventsPath);
    const hasRunJson = fs.existsSync(runJsonPath);
    if (opts.requireDispatched) {
      let parsedRunJson = null;
      if (hasRunJson) { try { parsedRunJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')); } catch { parsedRunJson = null; } }
      if (!parsedRunJson || typeof parsedRunJson !== 'object' || Array.isArray(parsedRunJson)) continue; // no real run.json -> not a genuine dispatched run
    } else if (!hasEvents && !hasRunJson) {
      continue; // not a real Forge run dir at all — never a pickable candidate
    }
    let mtimeMs = 0;
    try {
      if (hasEvents) mtimeMs = Math.max(mtimeMs, fs.statSync(eventsPath).mtimeMs);
      if (hasRunJson) mtimeMs = Math.max(mtimeMs, fs.statSync(runJsonPath).mtimeMs);
      mtimeMs = Math.max(mtimeMs, fs.statSync(runDir).mtimeMs);
    } catch { /* a stat race on an individual file never disqualifies the candidate — 0/partial mtime is still real evidence */ }
    /** REGRESSIE 2026-08-09: rangschikken op mtime laat ELKE metadata-write de geschiedenis herordenen.
     *  forge-finalize's markRunFinalized() herschreef de run.json van een oude, groene run; die ene
     *  aanraking maakte hem "laatste dispatched run", waardoor de doctor "run contract satisfied" meldde
     *  terwijl de ECHT actieve run nog 5 verplichte regels miste — een reëel gat, onzichtbaar gemaakt door
     *  boekhouding. forge-snapshot.cjs leerde dit al op 2026-08-01 en herrangschikte in zijn EIGEN code;
     *  de gedeelde kern hield het gebrek, dus de volgende aanroeper erfde het. Daarom hier, één keer:
     *  recentheid van een RUN is de recentheid van zijn WERK. Eventtijden worden één keer geschreven en
     *  nooit herschreven; mtimes wel. Zonder eventlog blijft de mtime de eerlijke terugval. */
    const activityMs = hasEvents ? lastEventTimeMs(eventsPath) : 0;
    candidates.push({ name: e.name, mtimeMs, activityMs, rankMs: activityMs || mtimeMs });
  }
  candidates.sort((a, b) => (b.rankMs - a.rankMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return candidates;
}
/** latestRunIdFor — the single most-recent run id under <root>/.claude/forge-runs/, ANY real run directory
 *  (a run.json OR an events.jsonl is enough — this is the general-purpose "most recently touched run"
 *  picker; see latestDispatchedRunIdFor() below for the stricter "genuinely dispatched" variant used by
 *  runContractDoctorCheck()). V9-fix (break-swarm DEFECT 4): the OLD implementation picked
 *  "latest" by a plain lexical name sort — a clean decoy run whose directory name simply sorts higher (e.g.
 *  "zzz-decoy") masked a genuinely NEWER, real-violating run whose name happens to sort lower. Now ranks by
 *  REAL recency via rankRunCandidates() — see that function's doc for the exact algorithm. null when no real
 *  run directories exist yet (a fresh project) or the directory can't be read — never thrown. */
function latestRunIdFor(root) {
  const candidates = rankRunCandidates(root, {});
  return candidates.length ? candidates[0].name : null;
}
/** latestDispatchedRunIdFor — V9 (forge-audit-loop's own honest-realization pass): the
 *  most-recent run id that carries a REAL, parseable run.json — i.e. a genuinely DISPATCHED Forge run, never
 *  a "doctor-receipt-only" directory (see rankRunCandidates()'s opts.requireDispatched doc above). Used by
 *  runContractDoctorCheck() below so its advisory never mistakes `forge-doctor --run <id>`'s own receipt
 *  directory (created by THIS file's CLI body — doctor.json + one synthetic doctor_run event, no run.json)
 *  for a real dispatched run whose non-negotiables are worth evaluating. null when no genuinely dispatched
 *  run exists yet under forge-runs/ (a fresh project, or a project where every run so far is receipt-only) —
 *  never thrown. */
function latestDispatchedRunIdFor(root) {
  const candidates = rankRunCandidates(root, { requireDispatched: true });
  return candidates.length ? candidates[0].name : null;
}
/** runContractDoctorCheck — ENFORCED; see the "run_contract — ENFORCED" block doc right
 *  above its implementation further down. (Until it was an ADVISORY live re-check of the latest run that had
 *  a run.json, which showed red on legitimately finalized runs once HEAD or the rules moved — audit S5.) It still
 *  never evaluates every historical run and never a doctor-receipt-only folder, and a fresh project without any
 *  run degrades to a neutral "no dispatched run to check yet". */
/** qualityCatalogDoctorCheck — ADVISORY. De domeincatalogus is de ENE verwachting; vier seams (router-
 *  playbooks, required-evidence, intake-packs, domain-presets) zijn de werkelijkheid. Elke afwijking is
 *  drift die hier zichtbaar wordt; tracked gaps (dashboard, tooling/meta) blijven benoemd, nooit stil.
 *  Degradeert eerlijk wanneer de quality-module ontbreekt (kale installatie zonder Quality-laag). */
function qualityCatalogDoctorCheck(root) {
  let Q = null;
  try { Q = require(path.join(claudeDir(root), 'forge-bin', 'forge-quality.cjs')); } catch { }
  /** F-09 (Codex batch-1-review): 'module ontbreekt' was ok:true — maar de sync-manifest SHIPT deze
   *  module, dus afwezigheid is een echte installatiefout, geen optionele feature. Fail-closed. */
  if (!Q || typeof Q.catalogDrift !== 'function') return { ok: false, reason: 'forge-quality.cjs ontbreekt of laadt niet, terwijl de sync-manifest hem verwacht — de installatie is incompleet' };
  try {
    const d = Q.catalogDrift(root);
    /** F-29 (Codex eindreview): het eindoordeel telt VIER afwijkingsvelden mee (missing, extra,
     *  not_expected, stale_tracked) maar de reason noemde er maar twee — drift door een verouderde
     *  tracked gap of een onverwachte preset gaf ok:false met een LEGE reden, dus geen
     *  herstelrichting. Alle vier velden dragen nu bij aan de probleemselectie en de reden. */
    const problemen = d.seams.filter((s2) => (s2.missing_in_seam || []).length || (s2.extra_in_seam || []).length || (s2.not_expected || []).length || (s2.stale_tracked || []).length);
    const beschrijf = (s2) => {
      const delen = [];
      if ((s2.missing_in_seam || []).length) delen.push('missing=' + JSON.stringify(s2.missing_in_seam));
      if ((s2.extra_in_seam || []).length) delen.push('extra=' + JSON.stringify(s2.extra_in_seam));
      if ((s2.not_expected || []).length) delen.push('not_expected=' + JSON.stringify(s2.not_expected));
      if ((s2.stale_tracked || []).length) delen.push('stale_tracked=' + JSON.stringify(s2.stale_tracked) + ' (de gap-notitie beschrijft een opgeloste werkelijkheid — ruim de known_gap op)');
      return s2.seam + ': ' + delen.join(' ');
    };
    return { ok: d.ok, reason: d.ok ? '' : problemen.map(beschrijf).join(' · '), seams: d.seams.length, domains: d.domains_total };
  } catch (e) { return { ok: false, reason: 'catalogDrift wierp: ' + e.message }; }
}

/** ============ run_contract — ENFORCED (audit T11/S4/S5) ============
 *  Which run: the NEWEST genuine run (ranked by real work recency, rankRunCandidates). Genuine = a parseable
 *  run.json OR a run_started event — the run.json-only filter missed real runs that never wrote one (the goat
 *  run and this overhaul run among them), while a doctor-receipt-only folder (doctor.json + one doctor_run
 *  event) still never qualifies.
 *  What makes it red (enforced, folded into doctor.ok, escape hatch: doctor_check_overrides 'run_contract'):
 *    - completed-red           the newest run logged run_completed while the completion sequence was unmet
 *                              (contract red, gate evidence missing/red, no final report, or no fresh proof);
 *    - completed-not-finalized it logged run_completed but was never finalized (step 5 skipped);
 *    - finalized-stale         its receipt (or the latest finalized run's receipt) no longer holds — STALE.
 *  What is never red:
 *    - in-progress             no completion claimed yet. Overdue obligations are listed, not enforced: the
 *                              doctor is itself a gate inside step 1, so a red verdict on unfinished work would
 *                              deadlock the very sequence it checks;
 *    - closed-failed           an honest failure close claims no completion;
 *    - finalized / finalized-historical — read through forge-finalize check() (evaluateAcceptance). A HISTORICAL
 *                              record is reported with its cause and whether it was re-verified; a bare
 *                              HISTORICAL is never presented as "re-verified OK" (S5); an unverified-archival or
 *                              otherwise unauthenticated archival receipt is never a completion proof:
 *                              red for an enforced claim, finalized-archival with completion_proof:false otherwise;
 *    - undetermined            the receipt's git state cannot be read: RED in the development tree,
 *                              an ok:true NOTE (status 'undetermined') everywhere else;
 *    - a completion claim is sticky: work logged after run_completed keeps the run 'completed' (red until
 *      it is finalized after a new run_completed, or closed as failed), it never turns back into "in progress";
 *    - anything whose completion claim PREDATES RUN_CONTRACT_ENFORCED_SINCE (the day this recipe and gate
 *      shipped): reported, not enforced — older runs never had the recipe, and a synced project must not turn
 *      red on its history (rules use `since` for the same reason).
 *  Degrades to ok:true with a reason when forge-runcontract.cjs (planFor) is unavailable or no run exists. */
// 2026-10-10 00:00 Europe/Amsterdam (CEST) — the night the completion recipe and the run_completed gate shipped.
// Written as a UTC instant on purpose: a bare '2026-10-10' would be UTC midnight, two hours AFTER the shipping
// moment, and completions in that window would wrongly read as "history" (caught by the replay test).
const RUN_CONTRACT_ENFORCED_SINCE = '2026-10-09T22:00:00Z';
function isGenuineRunDir(runDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) return true;
  } catch { /* no usable run.json — fall through to the run_started test */ }
  try { return /"event_type"\s*:\s*"run_started"/.test(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')); }
  catch { return false; }
}
function genuineRunCandidates(root) {
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  return rankRunCandidates(root, {}).filter((c) => isGenuineRunDir(path.join(runsDir, c.name)));
}
/** eventTimeMs(e) — F05 (Codex adversarial review): the WRITER-stamped `ingested_at` is the time of
 *  record; `timestamp` is only the fallback for history written before the writer stamped it (which predates
 *  every enforcement date). A caller-supplied timestamp survives only as `claimed_ts` and never decides anything. */
function eventTimeMs(e) {
  if (runContractTool && typeof runContractTool.tsOf === 'function') { const ms = runContractTool.tsOf(e); return ms === null ? null : ms; }
  for (const f of ['ingested_at', 'timestamp']) { const ms = Date.parse(e && e[f]); if (Number.isFinite(ms)) return ms; }
  return null;
}
/** completionClaimOf(runDir) -> {claimed, at_ms, started_ms} from a LENIENT read (a damaged log is the chain
 *  check's job). started_ms = the run's start (run_started, else the first dated event) for the F01 cutoff. */
function completionClaimOf(runDir) {
  let evs;
  try { evs = parseEventsJsonlLenient(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')); } catch { return { claimed: false, at_ms: null, started_ms: null, unreadable: true }; }
  let startedMs = null;
  const rs = evs.find((e) => e.event_type === 'run_started');
  if (rs) startedMs = eventTimeMs(rs);
  if (startedMs === null) for (const e of evs) { const ms = eventTimeMs(e); if (ms !== null) { startedMs = ms; break; } }
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].event_type === 'run_completed') {
      const ms = eventTimeMs(evs[i]);
      return { claimed: true, at_ms: ms, started_ms: startedMs };
    }
  }
  return { claimed: false, at_ms: null, started_ms: startedMs };
}
function finalizeCheckOf(root, runId) {
  let F;
  try { F = require('./forge-finalize.cjs'); } catch (e) { return { verdict: 'UNAVAILABLE', reason: 'forge-finalize.cjs could not be loaded (' + e.message + ')' }; }
  try { return F.check(root, runId); } catch (e) { return { verdict: 'UNAVAILABLE', reason: 'forge-finalize check threw (' + e.message + ')' }; }
}
function acceptanceText(fin) {
  if (runContractTool && typeof runContractTool.acceptanceLabel === 'function') return runContractTool.acceptanceLabel(fin);
  return String((fin && fin.verdict) || 'unknown') + (fin && fin.reason ? ' — ' + String(fin.reason).slice(0, 160) : '');
}
/** judgeRunForDoctor(root, runId, sinceIso) -> {ok, enforced, status, run_id, reason, ...} — see the block doc. */
function judgeRunForDoctor(root, runId, sinceIso) {
  const runDir = path.join(claudeDir(root), 'forge-runs', runId);
  const claim = completionClaimOf(runDir);
  const sinceMs = Date.parse(sinceIso.length === 10 ? sinceIso + 'T00:00:00Z' : sinceIso);
  // an undatable claim is enforced (the strict direction, like a `since` block rule on an undatable run)
  const claimEnforced = claim.claimed && (claim.at_ms === null || claim.at_ms >= sinceMs);
  const notEnforcedNote = claim.claimed && !claimEnforced ? ' [completion claimed before ' + sinceIso + ': reported, not enforced]' : '';
  const base = { run_id: runId, claim_at: claim.at_ms === null ? null : new Date(claim.at_ms).toISOString(), started_at: claim.started_ms == null ? null : new Date(claim.started_ms).toISOString(), enforced_since: sinceIso };
  if (fs.existsSync(path.join(runDir, 'run-finalized.json'))) {
    const fin = finalizeCheckOf(root, runId);
    const acceptance = { verdict: fin.verdict, cause: fin.cause || null, reverified: fin.reverified === true, label: acceptanceText(fin) };
    if (fin.verdict === 'FINALIZED') return Object.assign(base, { ok: true, enforced: claimEnforced, status: 'finalized', acceptance, completion_proof: true, reason: acceptance.label });
    if (fin.verdict === 'HISTORICAL') {
      /** a HISTORICAL record counts as completion proof only when
       *  finalize RE-VERIFIED it (reverified:true) or the run started before the completion-proof cutoff. An
       *  archival (not re-verified) record of an enforcement-era run is RED when its claim is enforced — the
       *  same since-rule as every other red here — and is always labelled "archival, not a completion proof". */
      const proof = runContractTool && typeof runContractTool.completionProofOf === 'function'
        ? runContractTool.completionProofOf(fin, claim.started_ms, completionProofCutoff(root))
        : { ok: fin.reverified === true, archival: fin.reverified !== true, reason: acceptance.label };
      acceptance.completion_proof = proof.ok; acceptance.archival = proof.archival; acceptance.label = proof.reason;
      if (proof.ok) return Object.assign(base, { ok: true, enforced: claimEnforced, status: proof.archival ? 'finalized-archival' : 'finalized-historical', acceptance, completion_proof: true, reason: proof.reason });
      return Object.assign(base, { ok: !claimEnforced, enforced: claimEnforced, status: 'finalized-archival', acceptance, completion_proof: false, reason: 'the finalize receipt is an ARCHIVAL record, not a completion proof — ' + proof.reason + notEnforcedNote });
    }
    if (fin.verdict === 'STALE') return Object.assign(base, { ok: !claimEnforced, enforced: claimEnforced, status: 'finalized-stale', acceptance, completion_proof: false, reason: 'the finalize receipt no longer holds — ' + acceptance.label + notEnforcedNote });
    /** a finalize checker that cannot run is a tool failure the doctor must show RED, never "undetermined, ok". */
    if (fin.verdict === 'UNAVAILABLE') return Object.assign(base, { ok: false, enforced: true, status: 'finalize-unavailable', acceptance, completion_proof: false, reason: 'the finalize receipt could not be evaluated — ' + (fin.reason || acceptance.label) });
    /** UNDETERMINED (the git state of this root cannot be read right now — dubious
     *  ownership, a repo without commits, git missing) used to be ok:true, so a broken git probe read as a pass.
     *  In the DEVELOPMENT tree (forge-dev-tree.json) it is RED with the reason: the receipt is bound to a commit
     *  nobody can confirm. Everywhere else it stays ok:true but says so (status 'undetermined', note:true), so a
     *  synced project without a working git never deadlocks on its own history. An unknown verdict string is
     *  treated the same way (never trusted as a pass). */
    if (fin.verdict !== 'NOT_FINALIZED') {
      const why = 'the finalize receipt could not be confirmed — ' + acceptance.label;
      if (readDevTreeMarker(root).valid) {
        return Object.assign(base, { ok: false, enforced: true, status: 'finalized-undetermined', acceptance, completion_proof: false, reason: why + ' — in the development tree an undetermined git state is RED: repair git for this root (safe.directory, a first commit, git on PATH) and re-run the doctor' });
      }
      return Object.assign(base, { ok: true, enforced: false, status: 'undetermined', note: true, acceptance, completion_proof: false, reason: why + ' [NOTE: reported, not enforced outside the development tree]' });
    }
    // NOT_FINALIZED: the receipt vanished between the exists-check and the read — judge the run live below
  }
  let plan;
  try { plan = runContractTool.planFor({ run_id: runId }, { root }); }
  catch (e) {
    return Object.assign(base, { ok: !claimEnforced, enforced: claimEnforced, status: 'unjudgeable', reason: 'the run contract could not be evaluated (' + e.message + ')' + (claim.claimed ? notEnforcedNote : ' — no completion claimed, so this is reported, not enforced') });
  }
  const st = plan.state;
  const steps = plan.sequence.map((s) => ({ id: s.id, status: s.status }));
  const common = { missing: plan.contract.missing, warnings: plan.contract.warnings, steps, next: plan.next.text, phase: st.phase };
  if (st.status === 'closed-failed') return Object.assign(base, common, { ok: true, enforced: false, status: 'closed-failed', reason: 'closed as failed — no completion is claimed' });
  if (st.status !== 'completed') {
    const overdue = plan.obligations.filter((o) => o.due === 'overdue').map((o) => o.id);
    return Object.assign(base, common, { ok: true, enforced: false, status: 'in-progress', overdue,
      reason: st.status + ' (phase ' + st.phase + '), completion not claimed yet' + (overdue.length ? ' · overdue (enforced only once completion is claimed): ' + overdue.join(', ') : '') });
  }
  const unmet = plan.sequence.filter((s) => s.id !== 'finalize' && (s.status === 'pending' || s.status === 'red'));
  if (unmet.length || plan.contract.ok !== true) {
    const parts = unmet.map((s) => 'step ' + s.step + ' ' + s.id + ' ' + s.status);
    return Object.assign(base, common, { ok: !claimEnforced, enforced: claimEnforced, status: 'completed-red',
      reason: 'run_completed was logged over an unmet completion sequence: ' + (parts.join(', ') || 'contract red') + (plan.contract.missing.length ? ' (missing: ' + plan.contract.missing.join(', ') + ')' : '') + ' → node .claude/forge-bin/forge-runcontract.cjs plan --run ' + runId + notEnforcedNote });
  }
  const finStep = plan.sequence.find((s) => s.id === 'finalize');
  return Object.assign(base, common, { ok: !claimEnforced, enforced: claimEnforced, status: 'completed-not-finalized',
    reason: 'run_completed is logged and steps 1-3 are met, but the run was never finalized → ' + ((finStep && finStep.command) || 'node .claude/forge-bin/forge-runcontract.cjs check --run ' + runId + ' --log-event --finalize') + notEnforcedNote });
}
/** completionProofCutoff(root) — the F01 cutoff from the ONE registry (completion_proof.enforcement_cutoff), else
 *  forge-runcontract's constant. */
function completionProofCutoff(root) {
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8'));
    if (runContractTool && typeof runContractTool.completionProofCutoffOf === 'function') return runContractTool.completionProofCutoffOf(rules);
    const v = rules && rules.completion_proof && rules.completion_proof.enforcement_cutoff;
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  } catch { /* fall through to the checker's constant */ }
  return (runContractTool && runContractTool.COMPLETION_PROOF_CUTOFF) || '2026-10-09T00:00:00Z';
}
function runContractDoctorCheck(root, opts) {
  const sinceIso = (opts && opts.enforcedSince) || RUN_CONTRACT_ENFORCED_SINCE;
  /** a checker that cannot load is a tool failure, reported RED with
   *  its reason — never ok:true. (Escape hatch, visibly: doctor_check_overrides 'run_contract'.) */
  if (!runContractTool || typeof runContractTool.planFor !== 'function') {
    return { ok: false, enforced: true, status: 'unavailable', run_id: null, enforced_since: sinceIso, reason: 'forge-runcontract.cjs (planFor) could not be loaded — the run-contract check cannot run, which is a defect of this installation, not a pass; repair/sync forge-runcontract.cjs' };
  }
  const cands = genuineRunCandidates(root);
  if (!cands.length) return { ok: true, enforced: false, status: 'no-run', run_id: null, enforced_since: sinceIso, reason: 'no dispatched run to check yet' };
  const target = judgeRunForDoctor(root, cands[0].name, sinceIso);
  // finalized runs are read through their receipt: the latest finalized one is reported too, and a STALE receipt
  // there is as real a failure as on the newest run (same since-rule)
  const finCand = cands.find((c) => fs.existsSync(path.join(claudeDir(root), 'forge-runs', c.name, 'run-finalized.json')));
  let latestFinalized = null;
  if (finCand && finCand.name !== target.run_id) {
    const lf = judgeRunForDoctor(root, finCand.name, sinceIso);
    latestFinalized = { run_id: lf.run_id, ok: lf.ok, enforced: lf.enforced, status: lf.status, acceptance: lf.acceptance || null, reason: lf.reason };
  }
  /** EVERY other run that claimed completion on/after the enforcement
   *  date is judged too — an older completed-but-unfinalized (or red) run used to drop out of the checked set
   *  the moment a newer run started. Runs that never claimed completion stay out (in-progress work is never
   *  blocking, so a new run can always start); pre-enforcement claims are history. Each unresolved claim is
   *  listed with its own status and reason; any red one keeps the whole check red. */
  const sinceMs = Date.parse(sinceIso.length === 10 ? sinceIso + 'T00:00:00Z' : sinceIso);
  const unresolved = [];
  let judgedClaims = 0;
  for (const c of cands) {
    if (c.name === target.run_id || (latestFinalized && c.name === latestFinalized.run_id)) continue;
    const claim = completionClaimOf(path.join(claudeDir(root), 'forge-runs', c.name));
    if (!claim.claimed || !(claim.at_ms === null || claim.at_ms >= sinceMs)) continue; // no claim, or history
    judgedClaims++;
    const j = judgeRunForDoctor(root, c.name, sinceIso);
    if (!j.ok) unresolved.push({ run_id: j.run_id, status: j.status, enforced: j.enforced, reason: j.reason, claim_at: j.claim_at });
  }
  const ok = target.ok && (!latestFinalized || latestFinalized.ok) && unresolved.length === 0;
  return Object.assign({}, target, { ok, latest_finalized: latestFinalized, other_claims_judged: judgedClaims, unresolved_claims: unresolved });
}
/** runContractSummary(rc) — the one-line printSummary detail for the enforced run_contract check. */
function runContractSummary(rc) {
  if (!rc) return '';
  let s = rc.run_id ? rc.run_id + ' — ' + (rc.reason || rc.status) : (rc.reason || rc.status || '');
  if (rc.latest_finalized) s += ' · latest finalized ' + rc.latest_finalized.run_id + ': ' + (rc.latest_finalized.ok ? '' : 'RED — ') + ((rc.latest_finalized.acceptance && rc.latest_finalized.acceptance.label) || rc.latest_finalized.reason);
  if (Array.isArray(rc.unresolved_claims) && rc.unresolved_claims.length) s += ' · ' + rc.unresolved_claims.length + ' older unresolved completion claim(s): ' + rc.unresolved_claims.map((u) => u.run_id + ' (' + u.status + ')').join(', ');
  return s.length > 600 ? s.slice(0, 597) + '…' : s;
}

/** skillEvalsDoctorCheck(root) -> {ok, reason, skills, summary} — ADVISORY-ONLY wrapper around
 *  forge-skill-evals.cjs::runAll() (wp-skill-evals, backlog item 1 / YT-SWEEP-2026-07-31, 2026-07-31 —
 *  see that module's own header for the full evals.json schema and assertion-type catalog). A skill with
 *  no evals.json is simply not evaluated by that module — this check never invents a requirement for a
 *  skill that hasn't opted in yet. Degrades honestly (never throws) when the sibling module is
 *  unavailable (soft dependency, same posture as syncTool/verifyTool/runContractTool above) or when the
 *  underlying runAll() call itself throws (a malformed --skill filter can never reach here — this call
 *  never passes one). Zero skills carrying an evals.json yet is vacuously ok:true (a fresh project must
 *  never doctor-fail for opting into nothing). NOT promoted to ENFORCED: this is the FOUNDATION piece of
 *  the self-improvement substrate — no autonomous keep/revert loop exists yet (that stays nightshift-
 *  gated, a later piece), so a real assertion failure here is a signal to review by hand, not yet a build
 *  gate. */
function skillEvalsDoctorCheck(root) {
  if (!skillEvalsTool) return { ok: true, reason: 'forge-skill-evals.cjs module not available (skill-evals check unavailable)', skills: [], summary: null };
  try {
    const out = skillEvalsTool.runAll({ root });
    return {
      ok: out.ok,
      reason: out.ok ? '' : (out.summary.failedSkills + ' skill(s) with a failing/malformed eval'),
      skills: out.skills,
      summary: out.summary,
    };
  } catch (e) {
    return { ok: false, reason: 'forge-skill-evals check threw: ' + e.message, skills: [], summary: null };
  }
}

/** DIST_REPO_MARKERS — the exact three paths (relative to `root`) that together mean "this root IS the
 *  Forge distribution repository" (the thing `install.sh`/`install.ps1` set up and the public release
 *  tree looks like) rather than a development checkout or an ordinary project with Forge installed into
 *  it. All three must be present — any one alone is not distinctive enough (an ordinary project could
 *  plausibly ship its own unrelated install.sh, for instance). */
const DIST_REPO_MARKERS = ['install.sh', 'install.ps1', path.join('plugins', 'forge', '.claude-plugin', 'plugin.json')];
/** looksLikeDistRepo(root) -> true only when every DIST_REPO_MARKERS path exists under root. */
function looksLikeDistRepo(root) {
  return DIST_REPO_MARKERS.every((rel) => { try { return fs.existsSync(path.join(root, rel)); } catch { return false; } });
}

/** releaseExclusionsCheck(root) -> {ok, reason, dist_checked, dist_reason, pattern_counts, method?,
 *  files_checked?, violations?} — (prd-w2-discipline M2). ENFORCED (wired into the
 *  main `checks` object, not `advisory`): "nothing private slips into a public release unnoticed" is a
 *  real build gate, not a bookkeeping nicety.
 *
 *  Two independent things can fail here, both honestly:
 *   1) the config itself is broken (unreadable, invalid JSON, a missing required list, or any pattern
 *      that does not compile) — loadExclusions() throws for all four, caught here as ok:false. This half
 *      runs on EVERY call, everywhere, because a config this tool cannot parse can never be trusted to
 *      mean "nothing is forbidden".
 *   2) `root` IS the Forge distribution repository (see looksLikeDistRepo()) and it actually TRACKS a
 *      forbidden path — forge-release-check.checkDist() reports every one.
 *
 *  In every OTHER root — the development tree, or an ordinary project with Forge installed into it,
 *  whose own real forge-runs/agent-memory/etc. are legitimate and may well be tracked by that project's
 *  own git repo — checkDist() is deliberately NOT run at all: this check cannot tell "a private file
 *  leaked into a public release" from "a project owner's own repo, which is private by construction,
 *  tracks its own run history" without the dist-repo marker, so it stays silent rather than guess. Those
 *  roots still get a real answer: ok:true with the pattern counts and an explicit reason naming why the
 *  dist check was skipped.
 *
 *  Cheap by construction: no network, and the only filesystem work beyond loadExclusions() is three
 *  fs.existsSync() calls plus (only in the distribution repo) one `git ls-files`/walk. */
function releaseExclusionsCheck(root, opts) {
  const o = opts || {};
  if (!releaseCheckTool) {
    return { ok: false, reason: 'forge-release-check.cjs module not available (release-exclusions check unavailable)', dist_checked: false, pattern_counts: null };
  }
  let ex;
  try {
    // o.configPath is test-only injection (same posture as settingsSource/env/platform/windowMs
    // elsewhere in this file) — a real run always resolves the config this install actually ships,
    // via forge-release-check.cjs's own defaultConfigPath(), never anything root-dependent.
    ex = releaseCheckTool.loadExclusions(o.configPath);
  } catch (e) {
    return { ok: false, reason: 'release-exclusions config failed to load: ' + e.message, dist_checked: false, pattern_counts: null };
  }
  const patternCounts = {
    sync_folders: ex.sync_folders.length,
    never_sync: ex.never_sync.length,
    dist_forbidden: ex.dist_forbidden.length,
  };
  if (!looksLikeDistRepo(root)) {
    return {
      ok: true,
      reason: 'not the Forge distribution repo (install.sh + install.ps1 + plugins/forge/.claude-plugin/plugin.json not all present) — dist check skipped; this root may legitimately track its own run history/memory',
      dist_checked: false,
      pattern_counts: patternCounts,
    };
  }
  try {
    // o.distCheckOpts is test-only injection (same posture as o.configPath above), passed straight through
    // to forge-release-check.checkDist()'s own opts.spawn/opts.readdir seams — see that function's doc
    // comment. A real run never sets it, so checkDist always uses the real spawnSync/fs.readdirSync.
    const res = releaseCheckTool.checkDist(root, ex, o.distCheckOpts);
    // res.error means checkDist could not even FINISH enumerating the tree (a
    // real git failure, or an unreadable directory mid-walk) — distinct from, and never conflated with,
    // "0 forbidden path(s) tracked" (which would misleadingly read as an almost-clean result). Report the
    // real failure instead.
    if (res.error) {
      return {
        ok: false,
        reason: 'could not enumerate the distribution tree: ' + res.error,
        dist_checked: true,
        method: res.method || null,
        pattern_counts: patternCounts,
      };
    }
    return {
      ok: res.ok,
      reason: res.ok ? '' : (res.violations.length + ' forbidden path(s) tracked in the distribution tree: ' + res.violations.map((v) => v.path).join(', ')),
      dist_checked: true,
      method: res.method,
      files_checked: res.files_checked,
      violations: res.violations,
      pattern_counts: patternCounts,
    };
  } catch (e) {
    return { ok: false, reason: 'forge-release-check checkDist threw: ' + e.message, dist_checked: true, pattern_counts: patternCounts };
  }
}

/** shipManifestCheck(root, opts) -> {ok, applicable, reason, failures?, warnings?, stale_known_gaps?, by_class?,
 *  sources?, delivered?, refs_checked?, ms?} — (2026-10-09,;
 *  audit F12/F5/ORG-04/SYNC-08). ENFORCED from day one (wired into `checks`).
 *
 *  In the DEVELOPMENT tree (readDevTreeMarker(): .claude/config/forge-dev-tree.json says dev_tree:true) it runs
 *  forge-shipcheck.runShipcheck() over the whole source against config/orchestration/FORGE_SHIP_MANIFEST.json:
 *  every source path classified, every ship-* entry present, retired entries carry a replacement, forge-sync's
 *  listSystemFiles() equals the manifest's ship-sync set in BOTH directions, and no file that lands in a project
 *  points at a file a project never receives (reference closure — .md/.cjs/.json, the class test 83 only covered
 *  for config/orchestration/*.json). A violation listed under the manifest's `known_gaps` (with its owner work
 *  package) is a warning; EVERY other violation fails the doctor. Measured 0.3-1.0 s on this tree on 2026-10-09
 *  (git ls-files, ~3,100 existence checks, ~517 shipped files read), cheap enough to run on every doctor call.
 *
 *  Everywhere else it is applicable:false/ok:true: a synced or redistributed project holds only shipped files plus
 *  its own data, so classification, drift and closure cannot be judged there — and a check that is new AND red
 *  after a sync counts as a regression in forge-sync's regressionCheck(), which would roll every sync back. The one
 *  thing still judged there: a shipped manifest that is present but does not load fails (a broken manifest must
 *  never land quietly). sync_completeness (advisory) is kept beside it on purpose — see the header doc.
 *  opts.shipcheckOpts is a TEST-ONLY passthrough to runShipcheck (files/delivered/manifestPath injection). */
function shipManifestCheck(root, opts) {
  const o = opts || {};
  const marker = readDevTreeMarker(root);
  const manifestPath = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
  if (!marker.valid) {
    if (!fs.existsSync(manifestPath)) return { ok: true, applicable: false, reason: 'not the development tree and no shipped FORGE_SHIP_MANIFEST.json here — the full shipcheck runs only in the development tree' };
    if (!shipcheckTool) return { ok: true, applicable: false, reason: 'not the development tree — the full shipcheck runs only there (forge-shipcheck.cjs absent, manifest shape not checked)' };
    const loaded = shipcheckTool.loadManifest(manifestPath);
    if (loaded.errors.length) return { ok: false, applicable: false, reason: 'the shipped FORGE_SHIP_MANIFEST.json does not load: ' + loaded.errors.slice(0, 3).map((e) => e.path + ' (' + e.detail + ')').join('; '), failures: loaded.errors };
    return { ok: true, applicable: false, reason: 'not the development tree — full shipcheck skipped; the shipped manifest loads (' + loaded.rules.length + ' rules)' };
  }
  if (!shipcheckTool) return { ok: false, applicable: true, reason: 'forge-shipcheck.cjs module not available in the development tree (ship-manifest check unavailable)' };
  let rep;
  try { rep = shipcheckTool.runShipcheck(root, o.shipcheckOpts); } catch (e) { return { ok: false, applicable: true, reason: 'forge-shipcheck threw: ' + e.message }; }
  return {
    ok: rep.ok,
    applicable: true,
    reason: rep.ok ? '' : rep.failures.length + ' violation(s) not covered by a known gap',
    failures: rep.failures,
    warnings: rep.warnings,
    stale_known_gaps: rep.stale_known_gaps,
    by_class: rep.by_class,
    sources: rep.enumeration ? rep.enumeration.files || 0 : 0,
    delivered: rep.delivered,
    refs_checked: rep.refs ? rep.refs.checked : 0,
    ms: rep.ms,
  };
}

// ===========================================================================================================
// + part ii (audit S3/F4, ORG-02/05/07/11/12/14).
// The owner's complaint: "many features, and everything slips through without it knowing; mind maps and other
// features were not there". A tool nothing calls, or a skill nothing registers, has to be VISIBLE (red or
// labelled), never silent. Two ENFORCED checks (development tree only, n/a or labelled elsewhere so a synced
// project never gets a new red check that forge-sync's regressionCheck would treat as a regression) and four
// ADVISORY ones (report.advisory.*, never part of doctor.ok).
// ===========================================================================================================
const FEATURE_REGISTRY_FIX = 'node .claude/forge-bin/forge-registry-gen.cjs feature-registry --write';
/** featureRegistryCheck(root) — ENFORCED in the development tree. Reads FORGE_FEATURE_REGISTRY.json and re-runs
 *  the SAME static caller scan the generator uses (forge-registry-gen.cjs classifyFeatures — one scanner, never two).
 *  Red, with exact names, when: a tool/skill on disk is not in the registry; a non-retired entry's file is gone; a
 *  `wired` entry has no wired caller chain any more; the registry does not load or has an invalid entry. `dormant`
 *  and `on-request` are NEVER red (a stale classification or a dormant entry without a note is a warning).
 *  A `wired` entry whose recorded callers include the Command Center while command-center/ is absent here cannot be
 *  judged and is listed as unverifiable, not red. Outside the development tree: applicable:false, ok:true. */
function featureRegistryCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const gen = o.regGen !== undefined ? o.regGen : regGenTool;
  const regPath = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_FEATURE_REGISTRY.json');
  if (!readDevTreeMarker(root).valid) {
    return { ok: true, applicable: false, reason: fs.existsSync(regPath)
      ? 'not the development tree — the feature registry is judged only there (this copy is not checked)'
      : 'not the development tree and no FORGE_FEATURE_REGISTRY.json here — the feature registry is judged only in the development tree' };
  }
  if (!gen || typeof gen.classifyFeatures !== 'function') return { ok: false, applicable: true, reason: 'forge-registry-gen.cjs is not available in the development tree (the feature-registry check cannot run)', fix: FEATURE_REGISTRY_FIX };
  let c;
  try { c = gen.classifyFeatures(root); } catch (e) { return { ok: false, applicable: true, reason: 'the feature scan threw: ' + e.message }; }
  const onDisk = c.nodes;
  const loaded = gen.loadFeatureRegistry(root);
  if (!loaded.present) return { ok: false, applicable: true, reason: 'FORGE_FEATURE_REGISTRY.json is missing: ' + onDisk.size + ' tool(s)/skill(s) on disk are registered nowhere', missing: [...onDisk.keys()], fix: FEATURE_REGISTRY_FIX, ms: Date.now() - t0 };
  if (loaded.error) return { ok: false, applicable: true, reason: 'FORGE_FEATURE_REGISTRY.json does not load (' + loaded.error + ')', fix: 'repair the JSON by hand (the generator refuses to overwrite it, so hand notes are not lost)' };
  const invalid = gen.validateFeatureRegistry(loaded.data);
  const entries = (Array.isArray(loaded.data.features) ? loaded.data.features : []).filter((f) => f && typeof f.id === 'string' && f.id);
  const byKey = new Map(entries.map((f) => [f.kind + ':' + f.id, f]));
  const missing = [...onDisk.keys()].filter((k) => !byKey.has(k));
  const gone = entries.filter((f) => f.status !== 'retired' && !onDisk.has(f.kind + ':' + f.id)).map((f) => f.kind + ':' + f.id);
  const wiredWithoutCaller = [], unverifiable = [], stale = [];
  for (const f of entries) {
    const n = onDisk.get(f.kind + ':' + f.id);
    if (!n || f.status === 'retired' || n.status === f.status) continue;
    if (f.status === 'wired') {
      if (!c.gatewayScanned && (f.invoked_by || []).some((s) => /^command-center\//.test(String(s)))) unverifiable.push(f.kind + ':' + f.id);
      else wiredWithoutCaller.push({ id: f.kind + ':' + f.id, now: n.status, callers: n.callers.map((x) => x.from + ' (' + x.kind + ')').slice(0, 3) });
    } else stale.push({ id: f.kind + ':' + f.id, registry: f.status, now: n.status });
  }
  const dormantWithoutNote = entries.filter((f) => f.status === 'dormant' && !(typeof f.note === 'string' && f.note.trim())).map((f) => f.kind + ':' + f.id);
  const counts = {};
  for (const k of ['tool', 'skill']) { counts[k] = {}; for (const s of ['wired', 'on-request', 'dormant', 'retired']) counts[k][s] = entries.filter((f) => f.kind === k && f.status === s).length; }
  const ok = invalid.length === 0 && missing.length === 0 && gone.length === 0 && wiredWithoutCaller.length === 0;
  const parts = [];
  if (missing.length) parts.push(missing.length + ' on disk but not registered: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', +' + (missing.length - 8) : ''));
  if (gone.length) parts.push(gone.length + ' registered but the file is gone: ' + gone.slice(0, 8).join(', '));
  if (wiredWithoutCaller.length) parts.push(wiredWithoutCaller.length + ' marked wired with no wired caller now: ' + wiredWithoutCaller.slice(0, 8).map((w) => w.id + ' (now ' + w.now + ')').join(', '));
  if (invalid.length) parts.push(invalid.length + ' invalid entr(y/ies): ' + invalid.slice(0, 4).join('; '));
  return {
    ok, applicable: true, reason: ok ? '' : parts.join(' · '), fix: ok ? null : FEATURE_REGISTRY_FIX + ' (then review every new dormant note by hand)',
    counts, entries: entries.length, missing, gone, wired_without_caller: wiredWithoutCaller, invalid, stale, dormant_without_note: dormantWithoutNote,
    unverifiable, gateway_scanned: c.gatewayScanned, ms: Date.now() - t0,
  };
}

/** skillDescriptionIssues(raw) -> [issue] for the RAW text after `description:` on its frontmatter line. YAML reads
 *  `a: b` inside an unquoted value as a nested key and fails; Claude Code then drops the description and shows the
 *  skill under its first heading instead (seen live: forge-agent listed as "Forge playbook — Agent / LLM app + evals").
 *  A plain value must not contain ": " or " #" or start with a YAML indicator; a quoted value must be closed. */
function skillDescriptionIssues(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return [];
  if (v[0] === '"') return /^"(?:[^"\\]|\\.)*"$/.test(v) ? [] : ['the double-quoted description is not closed properly (or has an unescaped " inside)'];
  if (v[0] === "'") return /^'(?:[^']|'')*'$/.test(v) ? [] : ['the single-quoted description is not closed properly'];
  if (v[0] === '>' || v[0] === '|') return ['the description is a block scalar (' + v[0] + '): the repo frontmatter parser reads one line only — put it on one line, in double quotes'];
  const issues = [];
  if (/: |:$/.test(v)) issues.push('the description contains ": " but is not quoted — YAML reads it as a nested key, so Claude Code drops it and shows the first heading instead; wrap the whole description in double quotes');
  if (/\s#/.test(v)) issues.push('the description contains " #" unquoted — YAML cuts it off there as a comment; wrap it in double quotes');
  if (/^(?:[[\]{}&*!%@`,]|[-?:](?:\s|$))/.test(v)) issues.push('the description starts with a YAML indicator character; wrap it in double quotes');
  return issues;
}
/** skillFrontmatterCheck(root) — ENFORCED in the development tree; labelled (ok:true, findings listed) elsewhere.
 *  Every TOP-LEVEL .claude/skills/<name>/SKILL.md: the frontmatter parses with this file's parseFrontmatter(), has
 *  a name and a description, the description is <= SKILL_DESCRIPTION_MAX_CHARS exactly as skill_hygiene measures it
 *  (a vendored skill's length is reported as vendored_style, never counted), and skillDescriptionIssues() finds
 *  nothing. Plus the quality drift rule, REUSED from forge-quality.cjs catalogDrift() (never duplicated): every
 *  forge-* skill folder is a domain playbook in domain-catalog.json or listed in non_domain_skills. */
function skillFrontmatterCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dev = readDevTreeMarker(root).valid;
  const cd = claudeDir(root);
  const skills = [];
  for (const rel of listSkillFiles(root)) {
    if (rel.split('/').length !== 3) continue; // skills/<name>/SKILL.md only (nested folders are not discovered as skills)
    const id = rel.split('/')[1];
    let text;
    try { text = fs.readFileSync(path.join(cd, rel.split('/').join(path.sep)), 'utf8'); } catch (e) { skills.push({ skill: id, issues: ['SKILL.md is unreadable (' + (e.code || e.message) + ')'] }); continue; }
    const issues = [];
    const vendoredStyle = [];
    const fm = parseFrontmatter(text);
    if (!fm) { skills.push({ skill: id, issues: ['no frontmatter block (--- ... ---) at the top of SKILL.md'] }); continue; }
    if (!fm.name) issues.push('no name in the frontmatter');
    if (!fm.description) issues.push('no description in the frontmatter');
    const vendored = detectVendorPin(text);
    if (fm.description && fm.description.length > SKILL_DESCRIPTION_MAX_CHARS) (vendored ? vendoredStyle : issues).push('description is ' + fm.description.length + ' chars (max ' + SKILL_DESCRIPTION_MAX_CHARS + ')');
    const block = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text) || [])[1] || '';
    const line = block.split(/\r?\n/).find((l) => /^description:/.test(l));
    if (line) for (const i of skillDescriptionIssues(line.replace(/^description:/, ''))) issues.push(i);
    const entry = { skill: id, issues };
    if (vendored && vendoredStyle.length) entry.vendored_style = vendoredStyle;
    skills.push(entry);
  }
  const hasCatalog = fs.existsSync(path.join(cd, 'config', 'orchestration', 'domain-catalog.json'));
  let catalog = { applicable: hasCatalog, checked: false, uncatalogued: [], reason: '' };
  let Q = null;
  try { Q = o.qualityModule !== undefined ? o.qualityModule : require(path.join(cd, 'forge-bin', 'forge-quality.cjs')); } catch { Q = null; }
  if (!hasCatalog) catalog.reason = 'no domain-catalog.json here (nothing to catalogue against)';
  else if (Q && typeof Q.catalogDrift === 'function') {
    try {
      const seam = (Q.catalogDrift(root).seams || []).find((s) => s.seam === 'router-playbooks') || {};
      catalog = { applicable: true, checked: true, uncatalogued: seam.extra_in_seam || [], domains_without_playbook: seam.missing_in_seam || [], reason: '' };
      for (const sk of catalog.uncatalogued) {
        const e = skills.find((s) => s.skill === sk) || (skills.push({ skill: sk, issues: [] }), skills[skills.length - 1]);
        e.issues.push('forge-* skill that is neither a domain playbook in domain-catalog.json nor listed in its non_domain_skills — the router cannot place it; add it to one of the two');
      }
    } catch (e) { catalog = { applicable: true, checked: false, uncatalogued: [], reason: 'forge-quality catalogDrift threw: ' + e.message }; }
  } else catalog.reason = 'forge-quality.cjs is missing or does not load, so the catalog rule could not run';
  const failing = skills.filter((s) => s.issues.length);
  const catalogBroken = dev && catalog.applicable && !catalog.checked; // fail-closed, like quality_catalog (F-09)
  const ok = dev ? failing.length === 0 && !catalogBroken : true;
  const reason = failing.length
    ? failing.length + ' skill(s) with frontmatter/catalog problems: ' + failing.slice(0, 6).map((s) => s.skill + ' (' + s.issues[0].split(' — ')[0] + ')').join('; ') + (failing.length > 6 ? '; +' + (failing.length - 6) + ' more' : '')
    : (catalogBroken ? catalog.reason : '');
  return {
    ok, applicable: dev, enforced: dev, checked: skills.length, failing: failing.map((s) => s.skill), skills, catalog,
    reason: (catalogBroken && failing.length ? reason + ' · ' + catalog.reason : reason) + (!dev && failing.length ? ' (not enforced outside the development tree — fix it anyway: Claude Code cannot read these descriptions)' : ''),
    ms: Date.now() - t0,
  };
}

/** scribeWiring(root) — ADVISORY. Where forge-scribe.cjs exists: both scribe hooks are in .claude/settings.json
 *  (UserPromptSubmit -> forge-scribe-hook.cjs, Stop -> forge-scribe-stop.cjs), FORGE_SCRIBE.json parses, the
 *  hash chains verify when a ledger exists (forge-scribe verifyChains, read-only), and .claude/forge-scribe/ is
 *  gitignored (owner prompts, verbatim, must never be committed). */
function scribeWiring(root, opts) {
  const o = opts || {};
  const cd = claudeDir(root);
  const bin = path.join(cd, 'forge-bin');
  if (!fs.existsSync(path.join(bin, 'forge-scribe.cjs'))) return { ok: true, applicable: false, problems: [], notes: [], reason: 'forge-scribe.cjs is not installed here' };
  const problems = [], notes = [];
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(cd, 'settings.json'), 'utf8')); } catch (e) { problems.push('.claude/settings.json does not load (' + (e.code || e.message) + '), so the scribe hooks cannot be confirmed'); }
  const hookHas = (event, file) => {
    const groups = settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    return groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(file)));
  };
  if (settings) {
    if (!hookHas('UserPromptSubmit', 'forge-scribe-hook.cjs')) problems.push('no UserPromptSubmit hook runs forge-scribe-hook.cjs: owner prompts are not captured');
    if (!hookHas('Stop', 'forge-scribe-stop.cjs')) problems.push('no Stop hook runs forge-scribe-stop.cjs: open owner requests never block a stop');
  }
  const cfgPath = path.join(cd, 'config', 'orchestration', 'FORGE_SCRIBE.json');
  try { JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { problems.push('config/orchestration/FORGE_SCRIBE.json ' + (e.code === 'ENOENT' ? 'is missing' : 'does not parse (' + String(e.message).split('\n')[0] + ')')); }
  const storeDir = path.join(cd, 'forge-scribe');
  if (fs.existsSync(path.join(storeDir, 'ledger.jsonl')) || fs.existsSync(path.join(storeDir, 'inbox.jsonl'))) {
    try {
      const scribe = o.scribeModule || require(path.join(bin, 'forge-scribe.cjs'));
      const v = scribe.verifyChains({ root });
      if (!v.ok) problems.push('forge-scribe verify-chain: BROKEN (inbox ' + (v.inbox && v.inbox.ok ? 'ok' : 'broken') + ', ledger ' + (v.ledger && v.ledger.ok ? 'ok' : 'broken') + ') — run node .claude/forge-bin/forge-scribe.cjs verify-chain');
      else notes.push('verify-chain OK (inbox ' + v.inbox.lines + ' line(s), ledger ' + v.ledger.lines + ' line(s))');
    } catch (e) { problems.push('forge-scribe verify-chain could not run: ' + String(e.message).split('\n')[0]); }
  } else notes.push('no scribe ledger yet (nothing captured in this project)');
  const gi = (o.spawnSyncImpl || spawnSync)('git', ['check-ignore', '-q', '--no-index', '.claude/forge-scribe/inbox.jsonl'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (gi.status === 1) problems.push('.claude/forge-scribe/ is NOT gitignored: verbatim owner prompts could be committed — add `.claude/forge-scribe/` to .gitignore');
  else if (gi.status !== 0) notes.push('could not ask git whether .claude/forge-scribe/ is ignored (' + (gi.error ? gi.error.message : 'exit ' + gi.status) + ')');
  return { ok: problems.length === 0, applicable: true, problems, notes, reason: problems.join(' · ') };
}

/** unpublishedCheck(root) — ADVISORY, ALWAYS ok:true. In the development tree only: forge-sync.cjs
 *  verifyPublishTemplate({devDir, templateDir}) (read-only, local files + git, never network) compares the central
 *  template (~/.claude/forge/template/.claude) with what this tree would publish. A difference is reported as
 *  "UNPUBLISHED (template): ..." with the fix command; a missing template is a skip, never a finding. */
function unpublishedCheck(root, opts) {
  const o = opts || {};
  if (!readDevTreeMarker(root).valid) return { ok: true, applicable: false, reason: 'not the development tree — nothing is published from here' };
  const tool = o.syncTool !== undefined ? o.syncTool : syncTool;
  if (!tool || typeof tool.verifyPublishTemplate !== 'function') return { ok: true, applicable: false, reason: 'forge-sync.cjs verifyPublishTemplate is not available here' };
  const templateDir = o.templateDir || (typeof tool.defaultRealTemplateDir === 'function' ? tool.defaultRealTemplateDir() : path.join(os.homedir(), '.claude', 'forge', 'template', '.claude'));
  if (!fs.existsSync(templateDir)) return { ok: true, applicable: false, reason: 'no central template at ' + templateDir + ' — skipped' };
  const fix = 'node .claude/forge-bin/forge-sync.cjs publish-template --plan (then --apply in an owner-approved window)';
  let v;
  try { v = tool.verifyPublishTemplate({ devDir: claudeDir(root), templateDir }); } catch (e) { return { ok: true, applicable: true, verified: false, reason: 'could not verify the template: ' + e.message }; }
  if (v.error) return { ok: true, applicable: true, verified: false, reason: 'could not verify the template: ' + v.error };
  if (v.ok) return { ok: true, applicable: true, verified: true, unpublished: false, reason: 'the central template holds exactly what this tree publishes', warnings: v.warnings || [] };
  const diffs = (v.differences || []).map((d) => ({ kind: d.kind, count: (d.paths || []).length, paths: (d.paths || []).slice(0, 10), detail: d.detail || null }));
  return { ok: true, applicable: true, verified: true, unpublished: true, differences: diffs, warnings: v.warnings || [], fix, template_dir: templateDir,
    summary: 'UNPUBLISHED (template): ' + diffs.map((d) => d.kind + (d.count ? ' ' + d.count : '')).join(', ') + ' — fix: ' + fix };
}

/** structureCheck(root) — ADVISORY, development tree only (a user project's root and tool set are its own).
 *  Reuses forge-registry-gen.cjs buildReport(): tools without a <tool>.test.cjs sibling; source files over 800
 *  lines (tests and JSON excluded) that are not in FORGE_FEATURE_REGISTRY.json structure.size_allowlist; README
 *  tool-table rows vs tools on disk (local-only maintainer tools are not expected there); FORGE_SKILL_REGISTRY.md
 *  rows vs skills on disk; root clutter = a root file no root-level FORGE_SHIP_MANIFEST.json pattern names; and a
 *  repository without a git remote (nothing reaches GitHub). */
function structureCheck(root, opts) {
  const o = opts || {};
  if (!readDevTreeMarker(root).valid) return { ok: true, applicable: false, reason: 'not the development tree — the structure rules describe the Forge source tree' };
  const gen = o.regGen !== undefined ? o.regGen : regGenTool;
  if (!gen || typeof gen.buildReport !== 'function') return { ok: true, applicable: false, reason: 'forge-registry-gen.cjs is not available here' };
  let rep;
  try { rep = gen.buildReport(root); } catch (e) { return { ok: true, applicable: false, reason: 'buildReport threw: ' + e.message }; }
  let allow = [];
  try { const r = JSON.parse(fs.readFileSync(path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_FEATURE_REGISTRY.json'), 'utf8')); allow = (r.structure && Array.isArray(r.structure.size_allowlist)) ? r.structure.size_allowlist : []; } catch { allow = []; }
  const oversize = rep.oversize.files.filter((f) => !/\.test\.cjs$/.test(f.file) && !/\.json$/.test(f.file) && !allow.includes(f.file));
  let rules = null;
  const manifestPath = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
  if (shipcheckTool && fs.existsSync(manifestPath)) { const lm = shipcheckTool.loadManifest(manifestPath); if (!lm.errors.length) rules = lm.rules; }
  const classOf = (p) => (rules && shipcheckTool ? (shipcheckTool.classify(rules, p) || {}).class : null);
  const readmeMissing = rep.tools.missing_from_readme.filter((t) => classOf('.claude/forge-bin/' + t) !== 'local-only');
  let rootClutter = [], rootNote = '';
  if (rules) {
    const en = shipcheckTool.enumerateSource(root, o.files ? { files: o.files } : undefined);
    const rootRules = rules.filter((r) => typeof r.pattern === 'string' && !r.pattern.replace(/\{[^}]*\}/g, '').includes('/'));
    if (en.files) rootClutter = en.files.filter((f) => !f.includes('/') && !rootRules.some((r) => r.re.test(f))).sort();
    else rootNote = 'could not list the root (' + en.error + ')';
  } else rootNote = 'no loadable FORGE_SHIP_MANIFEST.json, root clutter not judged';
  const rem = (o.spawnSyncImpl || spawnSync)('git', ['remote'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const noRemote = rem.status === 0 && !String(rem.stdout || '').trim();
  const findings = {
    tools_without_test: rep.tools.without_test, oversize: oversize.map((f) => f.file + ' (' + f.lines + ')'),
    readme_missing: readmeMissing, readme_extra: rep.tools.extra_in_readme,
    skill_registry_missing: rep.skills.missing_from_registry, skill_registry_extra: rep.skills.extra_in_registry,
    root_clutter: rootClutter, no_remote: noRemote,
  };
  const ok = Object.entries(findings).every(([, v]) => (Array.isArray(v) ? v.length === 0 : !v));
  return { ok, applicable: true, findings, allowlisted_oversize: rep.oversize.files.filter((f) => allow.includes(f.file)).length, notes: rootNote ? [rootNote] : [], remote_probe: rem.status === 0 ? 'ok' : 'git remote failed (' + (rem.error ? rem.error.message : 'exit ' + rem.status) + ')' };
}

function advisorySafe(id, fn) {
  try { return fn(); } catch (e) { return { ok: true, applicable: false, reason: id + ' could not run: ' + String((e && e.message) || e).split('\n')[0] }; }
}

/** alwaysLoadedBudget(root) — ADVISORY. The two always-loaded instruction cores stay within 's budget
 *  (mirrors forge-wp11-coverage.test.cjs CORE_BYTE_BUDGET); the current sizes are reported on every run. */
const ALWAYS_LOADED_BUDGET_BYTES = 16384;
const ALWAYS_LOADED_FILES = ['.claude/commands/forge.md', '.claude/skills/forge-router/SKILL.md'];
function alwaysLoadedBudget(root) {
  const files = ALWAYS_LOADED_FILES.map((rel) => {
    let bytes = null;
    try { bytes = fs.statSync(path.join(root, ...rel.split('/'))).size; } catch { bytes = null; }
    return { file: rel, bytes, over: bytes != null && bytes > ALWAYS_LOADED_BUDGET_BYTES };
  });
  const present = files.filter((f) => f.bytes != null);
  if (!present.length) return { ok: true, applicable: false, budget: ALWAYS_LOADED_BUDGET_BYTES, files, reason: 'neither always-loaded core exists here' };
  return { ok: !present.some((f) => f.over), applicable: true, budget: ALWAYS_LOADED_BUDGET_BYTES, files };
}

// ===========================================================================================================
// RUN LIVENESS as a doctor advisory: forge-runwatch.cjs finally runs by itself.
//
// THE CONCRETE FAILURE THIS EXISTS TO CATCH: sat on status "running" for 30+
// hours — a `run_completed` event had been logged and 135 further events followed, but nothing ever compared
// the LEDGER (run.json's `status`) against the EVIDENCE (events.jsonl). forge-runwatch.cjs could answer that
// question exactly, terminal event line included, but it only ever ran when someone asked it to, so nobody
// asked. Wiring it into the doctor — which runs before every ship/handoff — is what makes it automatic.
//
// TWO HONEST WINDOWS, NOT ONE: forge-runwatch's own interactive default is 15 minutes, right for a Lead
// watching a live swarm. That is far too tight for a batch sweep over every historical run — an agent
// legitimately thinking for 20 minutes would be branded dead. LIVENESS_WINDOW_MS below is deliberately much
// wider (6h): well beyond any real single turn, far short of the 30+ hours actually observed. The window is
// an explicit parameter (opts.windowMs) so the test can prove the exclusion of a LIVE run is really about
// elapsed silence and not about that fixture being special.
//
// ADVISORY-ONLY, and it stays that way: a stale ledger is a bookkeeping error to correct by hand, not a
// reason to fail a build. It is reported under report.advisory.run_liveness with its own printSummary line,
// exactly like backfill_continuity.
const LIVENESS_WINDOW_MS = 6 * 60 * 60 * 1000;
// Status values that CLAIM the run is still going. Anything else (completed, done, failed, aborted, absent)
// is a ledger that is not claiming liveness, so there is nothing to contradict — never a finding.
const LIVENESS_RUNNING_STATUSES = new Set(['running', 'in_progress', 'in-progress', 'active', 'dispatched', 'started']);
// WP-DOC-ADV: a finding silent for a week or more is an ABANDONED ledger, not a live problem —
// tagged `abandoned: true` and counted separately in the summary line. Still advisory; no run.json is touched.
const LIVENESS_ABANDONED_MS = 7 * 24 * 60 * 60 * 1000;

/** runLiveness(root, opts) -> {ok, checked, findings, windowMs, reason}
 *  For every run whose run.json CLAIMS to be running, asks forge-runwatch.cjs what the events actually show
 *  and reports the contradictions, each with runwatch's OWN evidence attached (never a re-derived verdict):
 *    finished_but_open  — every started agent has a real terminal event AND the run has been silent past the
 *                         window: the work is provably over, the ledger just never said so. (The silence
 *                         requirement is what keeps a genuinely live run between two waves out of this.)
 *    stalled            — an agent started, never terminated, and has been silent past the window.
 *    no_agent_activity  — events exist but not one agent ever started, and it has been silent past the window.
 *    no_events          — the ledger says running and the run never logged a single event; age is measured
 *                         from run.json's own started_at (falling back to its mtime).
 *  A run directory with no parseable run.json is skipped entirely: nothing there claims to be running, so
 *  there is nothing to contradict. Missing forge-runs directory / missing forge-runwatch degrade to a clean,
 *  explicitly-reasoned ok:true — a fresh project must never produce a fabricated finding. */
function runLiveness(root, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = (Number.isFinite(opts.windowMs) && opts.windowMs > 0) ? opts.windowMs : LIVENESS_WINDOW_MS;
  if (!runwatchTool) return { ok: true, checked: 0, findings: [], windowMs, reason: 'forge-runwatch.cjs module not available (run-liveness check unavailable)' };
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  let entries;
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); }
  catch { return { ok: true, checked: 0, findings: [], windowMs, reason: 'no forge-runs directory yet' }; }
  const findings = [];
  let checked = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runJsonPath = path.join(runsDir, e.name, 'run.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')); } catch { continue; } // no real ledger -> nothing claims "running"
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const status = String(meta.status == null ? '' : meta.status).trim().toLowerCase();
    if (!LIVENESS_RUNNING_STATUSES.has(status)) continue;
    checked++;
    const st = runwatchTool.watch(e.name, { runsDir, now, stallMs: windowMs });
    if (st == null) {
      let startedAt = Date.parse(meta.started_at || meta.startedAt || '');
      if (!Number.isFinite(startedAt)) { try { startedAt = fs.statSync(runJsonPath).mtimeMs; } catch { startedAt = now; } }
      const silentMs = now - startedAt;
      if (silentMs >= windowMs) {
        findings.push({
          run_id: e.name, status, kind: 'no_events', overall: 'no-events', silent_ms: silentMs, abandoned: silentMs >= LIVENESS_ABANDONED_MS,
          last_event_at: null, counts: null, evidence: [], stalled_agents: [],
          detail: 'run.json says "' + status + '" but this run never logged a single event',
        });
      }
      continue;
    }
    const silentMs = st.lastEventAt == null ? null : (now - st.lastEventAt);
    const silentPastWindow = silentMs == null || silentMs >= windowMs;
    let kind = null, detail = '';
    if (st.overall === 'stalled') {
      kind = 'stalled';
      detail = st.counts.stalled + ' agent(s) started and never reported a terminal event';
    } else if (st.overall === 'done' && silentPastWindow) {
      kind = 'finished_but_open';
      detail = 'every started agent has a real terminal event (' + st.evidence.length + ' proof line(s)) — the work is over, the ledger still says "' + status + '"';
    } else if (st.overall === 'empty' && silentPastWindow) {
      kind = 'no_agent_activity';
      detail = 'events exist but no agent ever started';
    }
    if (!kind) continue;
    findings.push({
      run_id: e.name, status, kind, overall: st.overall, silent_ms: silentMs,
      abandoned: silentMs != null && silentMs >= LIVENESS_ABANDONED_MS, last_event_at: st.lastEventAt,
      counts: st.counts, evidence: st.evidence, stalled_agents: st.stalledAgents, detail,
    });
  }
  return { ok: findings.length === 0, checked, findings, windowMs, reason: '' };
}

// ===========================================================================================================
// wp-disclosure-ab — progressive-disclosure hygiene as a doctor advisory (backlog item 12,
// YT-SWEEP-2026-07-31, 6 source videos: zKBPwDpBfhs, WMi0BLDLAjk, 7s9Fnorg3eI, HCwfRe5EHGQ, fOxC44g8vig,
// JN7QCdvJwwM — see .claude/forge-research/YT-SWEEP-2026-07-31.md item #12). Built on the forge-skill-evals.cjs
// FOUNDATION piece above (same ADVISORY-ONLY posture, same "a skill dir is scanned independently — one bad
// skill never crashes the whole check" discipline).
// ===========================================================================================================
const SKILL_DESCRIPTION_MAX_CHARS = 200; // the wp3b description-length budget law — see forge-skill-evals.cjs's
  // own `frontmatter_field` max_length for the SAME budget wired as a per-skill, opt-in, machine-checkable
  // assertion; this check applies it project-wide, unconditionally, to every skill.
const SKILL_BODY_MAX_LINES = 500; // this project's own CLAUDE.md file-size guidance ("Keep files under 500
  // lines"). Whole-file line count, frontmatter included — mirrors forge-skill-evals.cjs's own `max_lines`
  // assertion semantics (the frontmatter is only a few lines, a faithful proxy for "keep the body small").
const SKILL_CODE_SPAN_RE = /`([^`\n]+)`/g;
const SKILL_PATH_SHAPE_RE = /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}$/;
// Deliberately narrow anchor set — matches the work package's own two examples exactly: a fully-qualified
// project path from the repo root (".claude/...") or a skill's own tier-3 on-demand subfolder convention
// (references/ / scripts/ / assets/), resolved relative to the SKILL.md's own directory. A bare relative
// mention with NEITHER anchor (e.g. "docs/ARCHITECTURE.md", "src/contract.js" — real strings this project's
// own playbooks use to describe a DOWNSTREAM built project's OWN tree, never this Forge project's) is
// intentionally left unchecked: there is no safe, unambiguous base to resolve it against (project root? this
// project's .claude/? the skill's own folder?) — guessing one would fabricate a finding, not report one.
const SKILL_REF_WHITELIST_PREFIXES = ['.claude/', 'references/', 'scripts/', 'assets/'];

/** extractSkillPathRefs(text) -> [{ref, anchored}, ...] — every DISTINCT backtick-wrapped, path-shaped token
 *  in a SKILL.md body. ONLY scans inside backtick code-spans: a survey of every real file/tool reference
 *  across this project's actual 48 SKILL.md files found every genuine one already wrapped in
 *  backticks, and requiring the code-span boundary is what keeps this check from ever matching an ordinary
 *  prose sentence that happens to contain a slash and a period (a date, a fraction, an abbreviation) — the
 *  work package's own "no false positives on prose" requirement. Two further filters, both proven necessary
 *  against this project's real content:
 *   - a URL (http:// or https://) is stripped from the text before scanning, so a URL's own path segment
 *     (e.g. "github.com/owner/repo.git") is never mistaken for a project file reference.
 *   - an "alternation" token — e.g. "manifest.json/events.jsonl", real prose in this project meaning
 *     "manifest.json OR events.jsonl", never a nested directory — is detected (any segment BEFORE the last
 *     one that already looks like a complete "name.ext" on its own) and rejected; a genuine nested directory
 *     component in this codebase never itself has a bare "name.ext" shape.
 *  A candidate containing "<" (a placeholder like "<run_id>") or "*" (a glob, e.g.
 *  "config/orchestration/*.json") is never treated as a literal file, per the work package. `anchored` (see
 *  SKILL_REF_WHITELIST_PREFIXES above) marks whether this checker has a safe, unambiguous base to resolve
 *  the reference against; an unanchored candidate is returned but never existence-checked by skillHygiene()
 *  below — never a fabricated finding against a base this checker is only guessing at. Never throws. */
function extractSkillPathRefs(text) {
  const withoutUrls = text.replace(/https?:\/\/[^\s)`'"]+/g, '');
  const seen = new Set();
  const out = [];
  let m;
  SKILL_CODE_SPAN_RE.lastIndex = 0;
  while ((m = SKILL_CODE_SPAN_RE.exec(withoutUrls)) !== null) {
    const inner = m[1].trim();
    if (!SKILL_PATH_SHAPE_RE.test(inner)) continue;
    if (inner.includes('<') || inner.includes('*')) continue;
    if (seen.has(inner)) continue;
    const segs = inner.split('/');
    let altProse = false;
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(segs[i])) { altProse = true; break; }
    }
    if (altProse) continue;
    seen.add(inner);
    out.push({ ref: inner, anchored: SKILL_REF_WHITELIST_PREFIXES.some((p) => inner.startsWith(p)) });
  }
  return out;
}

/**
 * detectVendorPin(text) -> {source, pin} | null — is this skill third-party content copied at a recorded pin?
 *
 * Provenance has to be EARNED, not claimed: BOTH an upstream `Source:` and a `Pinned commit:` hash. One line
 * on its own proves nothing, and if a single typed word could buy an exemption then "vendored" stops being
 * evidence and becomes a way to silence a check. Only the head of the file is read, because this must be a
 * header the vendoring step wrote — not a phrase that happens to appear in 600 lines of prose.
 */
function detectVendorPin(text) {
  const head = String(text || '').slice(0, 4000);
  const source = head.match(/^[\s*/#-]*Source:\s*(\S+)/m);
  const pin = head.match(/^[\s*/#-]*Pinned commit:\s*([0-9a-f]{7,40})\b/im);
  if (!source || !pin) return null;
  return { source: source[1], pin: pin[1] };
}

/** generatedPathBasenames(root) -> Set<'naam.ext'> — bestandsnamen die onze EIGEN code wegschrijft.
 *
 *  MEASURED FALSE POSITIVE (echte doctor-run): `skill-hygiene: forge-snapshot (1 dangling
 *  reference(s): .claude/.forge-snapshot-due.json)`. Dat bestand wordt door forge-snapshot-marker.cjs
 *  GESCHREVEN en door de SessionStart-hook geconsumeerd — afwezig zijn is zijn normale toestand. Je eigen
 *  outputpad documenteren is geen kapotte link, en een advisory die volloopt met valse positieven wordt
 *  niet meer gelezen — precies zo mist hij straks een ECHTE dangling reference.
 *
 *  Bewust op BASENAME: de schrijvende code stelt het pad samen (`path.join(dueDir, '.forge-snapshot-due.json')`),
 *  dus het volledige pad bestaat nergens als literal. Om dat niet te laten ontsporen tot "elke bestandsnaam
 *  die ergens in een schrijvend bestand voorkomt", tellen alleen literals op (of vlak onder) een regel met een
 *  echte schrijf-API. Testbestanden tellen niet mee: fixtures schrijven van alles en zijn geen bron van waarheid. */
const WRITE_API_RE = /\b(writeFileSync|appendFileSync|writeAtomic|createWriteStream|copyFileSync)\b/;
const FILENAME_LITERAL_RE = /['"`](\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"`]/g;
// The write call and its argument list on one line: `fs.writeFileSync(projMarkerPath, json, 'utf8')` ->
// group 1 = api, group 2 = everything up to the first `)`. Used to find WHICH variable is being written.
const WRITE_CALL_ARGS_RE = /\b(writeFileSync|appendFileSync|writeAtomic|createWriteStream|copyFileSync)\s*\(([^()]*)/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
function generatedPathBasenames(root) {
  const out = new Set();
  for (const sub of ['forge-bin', 'forge-dashboard', 'hooks']) {
    let files = [];
    try { files = listByExt(path.join(claudeDir(root), sub), ['.cjs', '.mjs', '.js']); } catch { continue; }
    for (const f of files) {
      if (/\.test\.(cjs|mjs|js)$/.test(f)) continue;
      let lines;
      try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { continue; }
      const resolved = new Set(); // one declaration lookup per written variable per file
      for (let i = 0; i < lines.length; i++) {
        if (!WRITE_API_RE.test(lines[i])) continue;
        const window = lines[i] + '\n' + (lines[i + 1] || ''); // een gewrapte aanroep zet het pad op de volgende regel
        FILENAME_LITERAL_RE.lastIndex = 0;
        let m;
        while ((m = FILENAME_LITERAL_RE.exec(window)) !== null) out.add(m[1]);
        harvestPathHelpers(window, lines, out); // `appendFileSync(ledgerPath(root), …)` — the path comes from a helper
        // 2026-09-23 (measured on forge-setup.cjs, restored this release): the path is often built ONCE into a
        // variable — `const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json')` — and the
        // write, fifteen lines later, only names that variable: `fs.writeFileSync(projMarkerPath, …)`. Neither
        // line carries both the write API and the literal, so the marker fell through and forge-router's honest
        // reference to `.claude/.forge-setup.json` came back as a "dangling" link. Resolve the written argument
        // (the first one; for copyFileSync the second — that is the destination) to its declaration in the SAME
        // file — const/let/var, one hop, no re-assignment chasing — and take the literals from that line. Still
        // bounded: only a variable that is actually handed to a write API is ever looked up.
        const call = WRITE_CALL_ARGS_RE.exec(lines[i]);
        if (!call) continue;
        const args = call[2].split(',').map((a) => a.trim());
        const written = call[1] === 'copyFileSync' ? args[1] : args[0];
        if (!written || !IDENTIFIER_RE.test(written) || resolved.has(written)) continue;
        resolved.add(written);
        const declRe = new RegExp('\\b(?:const|let|var)\\s+' + written.replace(/\$/g, '\\$') + '\\s*=');
        for (let j = 0; j < lines.length; j++) {
          if (!declRe.test(lines[j])) continue;
          const declWindow = /[;}]\s*$/.test(lines[j]) ? lines[j] : lines[j] + '\n' + (lines[j + 1] || ''); // same spill rule as the helper hop
          FILENAME_LITERAL_RE.lastIndex = 0;
          let d;
          while ((d = FILENAME_LITERAL_RE.exec(declWindow)) !== null) out.add(d[1]);
          harvestPathHelpers(declWindow, lines, out);
        }
      }
    }
  }
  return out;
}
/** One more hop, still bounded: a written path is often produced by a small helper — `appendFileSync(ledgerPath(root), …)`
 *  or `const statePath = opts.statePath || defaultStatePath(root)` with `function defaultStatePath(root) { return
 *  path.join(root, '.claude', 'forge-research', 'docdrift-state.json'); }`. Measured on every fresh install's doctor
 *  (CI): forge-docdrift and forge-router were flagged for exactly such helper-built paths. Only identifiers
 *  that are CALLED in the write/declaration window are looked up, and only their own `function NAME(` line (+1). */
function harvestPathHelpers(window, lines, out) {
  const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const SKIP = new Set(['require', 'writeFileSync', 'appendFileSync', 'writeAtomic', 'createWriteStream', 'copyFileSync', 'join', 'resolve', 'stringify', 'parse', 'push', 'toString', 'String', 'Number', 'if', 'for', 'while', 'catch', 'function', 'Error', 'JSON']);
  let c;
  while ((c = CALL_RE.exec(window)) !== null) {
    const name = c[1];
    if (SKIP.has(name)) continue;
    const fnRe = new RegExp('\\bfunction\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    for (let k = 0; k < lines.length; k++) {
      if (!fnRe.test(lines[k])) continue;
      // Only spill onto the next line when this one is genuinely unfinished (a wrapped `return path.join(…,`); a
      // one-line helper ending in `}` must not harvest the NEXT helper's literal (measured: a never-called decoy
      // helper on the following line was classified as generated).
      const fnWindow = /[;}]\s*$/.test(lines[k]) ? lines[k] : lines[k] + '\n' + (lines[k + 1] || '');
      FILENAME_LITERAL_RE.lastIndex = 0;
      let d;
      while ((d = FILENAME_LITERAL_RE.exec(fnWindow)) !== null) out.add(d[1]);
    }
  }
}

/** skillHygiene(root) -> {ok, checked, vendored_exempt, skills:[{skill, ok, issues:[], vendored?, vendored_style?, generated_refs?}]}
 *  ADVISORY-ONLY (see header doc).
 *  Unlike skill_evals above (opt-in evals.json), EVERY skill dir under .claude/skills/ that has a SKILL.md
 *  is IN SCOPE here — there is no opt-out.
 *
 *  SCOPE DEFECT FIXED 2026-08-01 (measured on this project, not assumed): this function used to do its own
 *  single-level `readdirSync(skills/)` + `<dir>/SKILL.md` read, i.e. exactly a one-star `skills/<x>/SKILL.md`
 *  glob — which found 49 of this project's 57 real SKILL.md files. The 8 gsap sub-skills live one level deeper
 *  (`skills/gsap/gsap-core/SKILL.md` …) and were therefore evaluated by NOTHING: not passing, INVISIBLE,
 *  which is strictly worse than a red finding — and every one of them is over the description budget this
 *  check exists to police, i.e. the check was blind to precisely the surface it was written for. It now
 *  reuses listSkillFiles() (already defined and exported above for sync_completeness), the one recursive
 *  SKILL.md walker in this file — so the hygiene scope and the sync-manifest scope can never drift apart
 *  again. `skill` is the skills/-relative id ("gsap/gsap-core"), never a bare leaf name two bundles could
 *  both claim. Three checks per skill: (1) frontmatter `description` present
 *  and <= SKILL_DESCRIPTION_MAX_CHARS; (2) whole-file line count <= SKILL_BODY_MAX_LINES; (3) every
 *  ANCHORED path-shaped reference (extractSkillPathRefs above) resolves to a real file — a `.claude/`-
 *  prefixed ref resolves from the project root, everything else (references//scripts//assets/) resolves
 *  from the SKILL.md's OWN directory. A skill dir with no SKILL.md is out of scope (mirrors
 *  listSkillDirs()'s own opt-in-by-file-presence posture in forge-skill-evals.cjs — not a skill, not
 *  evaluated). Never throws: an unreadable SKILL.md is simply excluded from `checked`, never crashes the
 *  whole scan (one bad skill dir must never take down every other skill's report). NOT promoted to
 *  ENFORCED: same reasoning as skill_evals — this is advisory review signal for the Skill Boss today, not
 *  yet a build gate. */
function skillHygiene(root) {
  const cd = claudeDir(root);
  const skills = [];
  const generatedNames = generatedPathBasenames(root); // één keer scannen, niet per skill
  for (const rel of listSkillFiles(root)) {
    const skillFile = path.join(cd, rel.split('/').join(path.sep));
    const skillDir = path.dirname(skillFile);
    // skills/-relative id, so a nested skill is named the way it is actually addressed on disk
    // ("gsap/gsap-core"), never collapsed to a bare leaf name that two bundles could both claim.
    const skillId = rel.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '');
    let text;
    try { text = fs.readFileSync(skillFile, 'utf8'); } catch { continue; }
    const issues = [];
    // VENDORED CONTENT. A skill copied verbatim from an upstream repo at a recorded pin is not
    // ours to restyle: rewriting it would make the pin describe something no longer on disk. So its SHAPE
    // (description/body length) is reported separately, with the real numbers, while its FUNCTION in our
    // tree (a usable description, references that resolve) is judged exactly like anything else. See the
    // vendored fixtures in forge-doctor.test.cjs §7 for why a half-marker must not buy this exemption.
    const vendored = detectVendorPin(text);
    const vendoredStyle = [];
    const styleIssue = (msg) => (vendored ? vendoredStyle : issues).push(msg);
    const fm = parseFrontmatter(text);
    const desc = fm && fm.description;
    if (!desc) issues.push('description missing/empty in frontmatter'); // no description = undiscoverable HERE, never upstream's problem to own
    else if (desc.length > SKILL_DESCRIPTION_MAX_CHARS) styleIssue('description is ' + desc.length + ' chars (max ' + SKILL_DESCRIPTION_MAX_CHARS + ')');
    const lineCount = text.split(/\r?\n/).length;
    if (lineCount > SKILL_BODY_MAX_LINES) styleIssue('SKILL.md is ' + lineCount + ' lines (max ' + SKILL_BODY_MAX_LINES + ')');
    const dangling = [];
    const generatedRefs = [];
    const optionalRefs = [];
    for (const r of extractSkillPathRefs(text)) {
      if (!r.anchored) continue;
      const resolved = r.ref.startsWith('.claude/') ? path.resolve(root, r.ref) : path.resolve(skillDir, r.ref);
      let exists = false;
      try { exists = fs.statSync(resolved).isFile(); } catch { exists = false; }
      if (exists) continue;
      // afwezig én door onze eigen code geschreven = runtime-marker, geen kapotte link. Herclassificeren,
      // niet verzwijgen: hij blijft zichtbaar onder generated_refs zodat de informatie niet verdwijnt.
      if (generatedNames.has(path.basename(r.ref))) generatedRefs.push(r.ref);
      // convention: `*.user.json` is a PRIVATE user-state file (owner rules, scout verdicts, the Codex
      // pin, a bench baseline) — never shipped, never synced, created only when the user needs it. A skill
      // documenting where it lives is not a broken link: it is absent on every fresh install by design (the
      // maintainer's own machine has one, which is exactly how "works here, fails on the laptop" happened).
      // Reclassified, not hidden: it stays visible under optional_refs.
      else if (/\.user\.json$/i.test(r.ref)) optionalRefs.push(r.ref);
      else dangling.push(r.ref);
    }
    if (dangling.length) issues.push(dangling.length + ' dangling reference(s): ' + dangling.join(', '));
    const entry = { skill: skillId, ok: issues.length === 0, issues };
    if (generatedRefs.length) entry.generated_refs = generatedRefs;
    if (optionalRefs.length) entry.optional_refs = optionalRefs;
    if (vendored) { entry.vendored = vendored; entry.vendored_style = vendoredStyle; }
    skills.push(entry);
  }
  return {
    ok: skills.every((s) => s.ok),
    checked: skills.length,
    vendored_exempt: skills.filter((s) => s.vendored && s.vendored_style.length).length,
    skills,
  };
}

/**
 * installationProfile(root) -> {profile:'development'|'redistribution', marker, marker_present, vendored:[ids],
 *   checked, reason}
 *
 * DISCRIMINATOR CHANGED: the verdict now keys on `.claude/config/forge-dev-tree.json` (a
 * parseable `{"dev_tree": true}`), NOT on "carries vendored skills". The history below explains why vendoring
 * was once a sound marker; it stopped being one the day the public distribution began SHIPPING vendored skills
 * (13 obra/superpowers skills + frontend-design): a fresh clone would then read as the development tree
 * and run exact-count assertions against a tree that honestly holds fewer skills. The marker file is the
 * difference that survives: it exists only in the canonical checkout and the release sync deliberately never
 * ships it. The vendoring pins are still counted and quoted in `reason`, because a skip must be able to say
 * what it saw. The two profile names are kept unchanged on purpose — forge-configdrift.test.cjs and
 * forge-contextbudget.test.cjs gate on `profile === 'development'`.
 *
 * WHICH TREE IS THIS? — not a check, and deliberately never folded into any verdict. It answers
 * one narrow question that some assertions genuinely need to ask before they mean anything: is this the
 * canonical development tree, or a redistribution of it?
 *
 * The problem it exists to solve: several tests pin an EXACT property of this installation ("this project
 * has exactly 57 skills"). Those pins are real drift guards here — they are how a silently-dropped skill or
 * a walk that stops one directory too shallow gets caught. In the published distribution the same pins fail
 * for a reason that is not a defect: the 9 vendored third-party skills are deliberately not redistributed,
 * so the tree honestly has fewer. Loosening the pins to a range, or listing the acceptable counts, would
 * destroy exactly the drift detection they were written for — a count that accepts two answers guards
 * nothing.
 *
 * (Historical, 2026-08-02 until wp17 — superseded by the dev-tree marker above.) The marker WAS the
 * difference itself: a skill counts as vendored only when detectVendorPin() finds BOTH an upstream `Source:`
 * and a `Pinned commit:` hash that the vendoring step actually wrote into the file, and a tree without any
 * such skill was treated as a redistribution. What remains true: a pinned assertion outside the development
 * tree is a SKIP with a stated reason, never a quiet pass.
 *
 * Deliberately NOT a doctor check and NOT in `checks`: neither profile is a defect. Never throws — an
 * unreadable skill is simply not counted, exactly as skillHygiene() treats it.
 */
const DEV_TREE_MARKER_REL = '.claude/config/forge-dev-tree.json';
/** readDevTreeMarker(root) -> {present, valid, error?} — the marker counts only when it parses AND says
 *  `dev_tree: true`; an empty or garbled file is reported, never promoted to "development". Never throws. */
function readDevTreeMarker(root) {
  const p = path.join(claudeDir(root), 'config', 'forge-dev-tree.json');
  if (!fs.existsSync(p)) return { present: false, valid: false };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && data.dev_tree === true ? { present: true, valid: true } : { present: true, valid: false, error: 'dev_tree is not true' };
  } catch (e) { return { present: true, valid: false, error: e.code || e.name }; }
}
function installationProfile(root) {
  const cd = claudeDir(root);
  const vendored = [];
  let checked = 0;
  for (const rel of listSkillFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(cd, rel.split('/').join(path.sep)), 'utf8'); } catch { continue; }
    checked++;
    if (detectVendorPin(text)) vendored.push(rel.replace(/^skills\//, '').replace(/\/SKILL\.md$/, ''));
  }
  const marker = readDevTreeMarker(root);
  const dev = marker.valid;
  const pins = vendored.length + ' of ' + checked + ' skills carry an upstream Source: + Pinned commit: header';
  return {
    profile: dev ? 'development' : 'redistribution',
    marker: DEV_TREE_MARKER_REL,
    marker_present: marker.present,
    vendored: vendored.sort(),
    checked,
    reason: dev
      ? 'development tree: ' + DEV_TREE_MARKER_REL + ' present (' + pins + ')'
      : marker.present
        ? 'not the development tree: ' + DEV_TREE_MARKER_REL + ' exists but is not a valid {"dev_tree": true} marker (' + marker.error + '); ' + pins
        : 'not the development tree: ' + DEV_TREE_MARKER_REL + ' (the canonical-checkout marker the release sync never ships) is absent, so the exact counts measured in the development tree do not apply; ' + pins,
  };
}

/** loadDoctorCheckOverrides — reads config/orchestration/FORGE_HARD_RULES.json's `doctor_check_overrides`
 *  array (see that file's own top-level doc for the exact shape: {check, reason, by, ts}). A missing file,
 *  malformed JSON, or a missing/empty `doctor_check_overrides` array all degrade to "no overrides" ([]) —
 *  this is an OPT-IN recovery mechanism, not a required config; its absence must never be an error. Every
 *  entry MUST carry a non-empty string `check` id and a non-empty string `reason` (a blank/templated reason
 *  is silently dropped, same "no blank override" discipline forge-scout.cjs's record() enforces for its own
 *  ledger) — a malformed single entry is skipped, never crashes the whole read. */
function loadDoctorCheckOverrides(root) {
  const p = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  if (!data || !Array.isArray(data.doctor_check_overrides)) return [];
  return data.doctor_check_overrides.filter((o) => o && typeof o.check === 'string' && o.check.trim() && typeof o.reason === 'string' && o.reason.trim());
}
/** applyDoctorOverride — a promoted-to-ENFORCED check's result is passed through UNCHANGED when it already
 *  passes (an override never "improves" a real pass into something more positive than reality) or when no
 *  matching override entry exists. Only a GENUINE failure with a matching, valid override entry is turned
 *  into a visible-but-honest pass: `ok:true` PLUS `overridden:true` + the real reason/by fields, so
 *  printSummary() can render it distinctly from an ordinary clean pass (see the '[OVERRIDDEN: ...]' tag) —
 *  never a silent bypass. */
function applyDoctorOverride(overrideMap, checkId, result) {
  if (result.ok) return result;
  const ov = overrideMap.get(checkId);
  if (!ov) return result;
  return Object.assign({}, result, { ok: true, overridden: true, override_reason: ov.reason, override_by: (ov.by && String(ov.by).trim()) || 'owner' });
}

/** contextBudgetCheck(root) -> the forge-contextbudget.cjs report, or an honest "unavailable" stand-in.
 *  ADVISORY-ONLY and deliberately so: the numbers are ESTIMATES (characters/4, no tokenizer), and failing a
 *  build on an estimate would be exactly the fake precision that check refuses to produce. It is also the
 *  one doctor check that reads files OUTSIDE the project root — read-only, counted, never written (see
 *  forge-contextbudget.cjs's header). A throw is swallowed into ok:true + a reason: a meter must never be
 *  able to take down the doctor it is only advising. */
function contextBudgetCheck(root) {
  if (!contextBudgetTool) return { ok: true, reason: 'forge-contextbudget.cjs module not available (context-budget check unavailable)', posts: [], findings: [], total_approx_tokens: 0 };
  try { return contextBudgetTool.measure(root, {}); }
  catch (e) { return { ok: true, reason: 'forge-contextbudget.measure threw: ' + e.message, posts: [], findings: [], total_approx_tokens: 0 }; }
}

// wp-v4 (sec-v3 L2, independent review): EVERY module file forge-gate-hook.cjs (or something it requires)
// loads, resolved by real path relative to the TARGET project's own forge-bin — never this doctor's own bundled
// copy — so a genuinely broken or out-of-sync install is caught rather than assumed healthy just because the
// doctor's own copies happen to be fine. Deliberately placed OUTSIDE the BEGINNER SETUP section below (this is
// a security/dependency health check, not a beginner preference) so that section's own static guards (exact
// spawnSync call counts, etc.) never have to account for it.
// (2026-09-26 laptop re-audit): forge-config-cli.cjs was already listed below, but its own two
// UNCONDITIONAL top-level requires -- forge-config.cjs and forge-config-text.cjs (never wrapped in
// try/catch, unlike the OPTIONAL siblings forge-config.cjs itself soft-loads lazily inside gateIds()/
// productDefaults(), e.g. forge-autonomy.cjs and forge-prefs.cjs, which are deliberately excluded here) --
// were missing, and forge-config.cjs's own two unconditional requires (forge-config-once.cjs, in turn
// required unconditionally by forge-config-once-store.cjs) were missing too. Found by making this file's
// own test suite's 12 gateWatchdogHealth/printSummary tests genuinely execute (they used to pass a function
// literal to a boolean-style t(name, cond) helper and never actually run): the health check's isolated
// fixture copies EXACTLY this list, so a missing transitive dependency here surfaced as a hard "broken"
// result for forge-config-cli.cjs even though the real installed tree was perfectly healthy -- the same gap
// would also make this check under-report a REAL broken forge-config.cjs/forge-config-text.cjs/
// forge-config-once(-store).cjs in a live install, since the loop below only walks this named list.
const GATE_HOOK_DEPENDENCY_FILES = [
  'forge-gate-hook.cjs', 'forge-gate-watchdog.cjs', 'forge-gate-inspect.cjs',
  'forge-gate-selfdisable.cjs', 'forge-gate-messages.cjs', 'forge-gate-scratch.cjs', 'forge-gate-data.cjs',
  'forge-actiongate.cjs', 'forge-actiongate-position.cjs', 'forge-gate-quotes.cjs', 'forge-config-cli.cjs',
  'forge-config.cjs', 'forge-config-text.cjs', 'forge-config-once.cjs', 'forge-config-once-store.cjs',
];
// forge-gate-classify-worker.cjs is a worker_threads ENTRY POINT, not an ordinary library module: it reads
// `workerData` (populated ONLY inside a real Worker thread) and runs immediately on load, so a plain require()
// on the main thread always throws ("Cannot destructure property 'command' of 'workerData' as it is null") even
// when the file is perfectly healthy — found by actually running this check against the real project before
// trusting it. Checked for EXISTENCE only below; the end-to-end spawnHook() calls exercise it for real, inside
// an actual worker, exactly like production.
const GATE_HOOK_WORKER_ENTRY_FILE = 'forge-gate-classify-worker.cjs';
// sec-v3r M1 (independent re-review): used ONLY to read back the gate-hook state of the THROWAWAY isolated
// copy gateWatchdogHealth() builds for itself below (via an explicit opts.projectRoot/configHome override,
// never the real machine's actual config) — a self-check that the isolation actually produced a clean start
// state before the destructive canary runs, never a read of the real project's own current setting.
let CFG = null;
try { CFG = require('./forge-config.cjs'); } catch { CFG = null; }

/** buildIsolatedGateProject() -> { root, home, env, cleanup() } — a throwaway, fully isolated project+home
 *  pair for gateWatchdogHealth's own end-to-end spawn (fixing a regression introduced in wp-v4).
 *  `root`/`home` are freshly created empty directories; NO FORGE_CONFIG.json is ever written into either, so
 *  forge-config.cjs's own get('gate-hook') resolves to the schema DEFAULT (protective, ON) with no once-grant
 *  ever pending — never the real project's or the real machine's actual current setting or once-store.
 *  `env` is a full process.env copy with FORGE_PROJECT_ROOT/FORGE_CONFIG_HOME (and CLAUDE_PROJECT_DIR, for
 *  good measure) pointed at these two throwaway directories — confirmed by inspection to be the ONLY two
 *  inputs forge-config.cjs's own pathsFor() ever reads for its DATA files (SCHEMA_PATH_DEFAULT is a fixed,
 *  __dirname-relative path, never affected by either). The REAL, UNMODIFIED forge-gate-hook.cjs is still
 *  spawned from its real, installed location (never copied) — this stays a genuine test of the INSTALLED
 *  copy, only its config/once-store I/O is redirected. `cleanup()` never throws — best-effort only. */
function buildIsolatedGateProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-gate-health-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    root, home,
    env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root, FORGE_CONFIG_HOME: home, CLAUDE_PROJECT_DIR: root }),
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort only */ } },
  };
}

/** gate-watchdog-health — wp-v3 (sec-v1r, item 4) originally checked ONLY forge-gate-watchdog.cjs and claimed
 *  "the full inspection pipeline runs watchdog-protected" from that alone — sec-v3 L2 correctly called this an
 *  overclaim: loading ONE module proves nothing about the other eleven files the hook also needs, and loading
 *  code proves nothing about whether the DEPLOYED hook actually classifies a real command correctly end to end.
 *
 *  Fixed in two steps. (1) Resolve (fresh require, never a stale cache entry from an earlier doctor run in this
 *  same process) EVERY file in GATE_HOOK_DEPENDENCY_FILES, catching both a MISSING file and a PRESENT-but-broken
 *  (syntactically invalid) one. (2) Run the REAL forge-gate-hook.cjs end to end as a genuine spawned process —
 *  exactly how Claude Code invokes it — on two benign-timing canaries: a harmless command (must exit 0) and a
 *  harmless DESTRUCTIVE-SHAPED string (`rm -rf` on a canary path that is never created and never touched — it is
 *  only ever classified, never executed) which must exit 2 (BLOCKED). The canary's own stderr is also checked
 *  for the word "classifier-unavailable" so the ok line can honestly say whether the REAL classifier engaged or
 *  only the cruder FALLBACK_RE fail-closed fallback did (both are "safe", but they are not the same thing, and
 *  wp-v4's own M1/L1 fixes are exactly what makes the fallback path reachable at all without a crash).
 *
 *  ADVISORY, NOT ENFORCED — a deliberate choice, not an oversight (sec-v3 L2 asked for this to be explained).
 *  Three reasons: (a) the doctor's own `tests` check is ALREADY enforced and runs forge-gate-hook.test.cjs +
 *  forge-actiongate.test.cjs on every doctor call — a regression in the gate-hook's own logic is already a hard
 *  failure there; this check is a complementary signal (proving the INSTALLED copy works, not just the test
 *  suite's copy), not the only line of defense. (b) wp-v4's own M1 fix means even a WORST-CASE broken
 *  dependency still fails closed (blocks the destructive canary) rather than failing open — the exact
 *  "fallback itself is safe" precedent wp-v3 already established for the narrower watchdog-only check stays
 *  true here too, now proven for the WHOLE dependency set instead of assumed. (c) spawning a real child process
 *  as a HARD gate risks a doctor that cannot pass AT ALL in a sandboxed/CI environment that restricts spawning —
 *  a flaky enforced check would erode trust in doctor.ok more than an honest advisory warning does. If this
 *  check ever DOES report the destructive canary NOT blocked, that is a severe, doubly-layered failure (both
 *  the real classifier AND FALLBACK_RE failed) worth treating as an emergency regardless of the advisory label. */
function gateWatchdogHealth(root, opts) {
  const o = opts || {};
  const bin = path.join(claudeDir(root), 'forge-bin');
  const hookPath = path.join(bin, 'forge-gate-hook.cjs');
  const allFiles = GATE_HOOK_DEPENDENCY_FILES.concat([GATE_HOOK_WORKER_ENTRY_FILE]);
  const missing = allFiles.filter((f) => !fs.existsSync(path.join(bin, f)));
  if (missing.length) {
    return beginnerResult('gate-watchdog-health', 'warn',
      missing.length + ' hook dependency file(s) missing from ' + bin + ': ' + missing.join(', ')
      + ' — forge-gate-hook.cjs is designed to degrade safely (never runs a command unchecked) even so, but has '
      + 'NOT been run end-to-end to confirm that here', { present: false, missing });
  }
  const broken = [];
  for (const f of GATE_HOOK_DEPENDENCY_FILES) {
    try {
      const resolved = require.resolve(path.join(bin, f));
      delete require.cache[resolved];
      require(resolved);
    } catch (e) {
      broken.push(f + ' (' + String((e && e.message) || e).split('\n')[0] + ')');
    }
  }
  if (broken.length) {
    return beginnerResult('gate-watchdog-health', 'warn',
      broken.length + ' hook dependency file(s) fail to load: ' + broken.join('; ')
      + ' — forge-gate-hook.cjs is designed to degrade safely even so, but has NOT been run end-to-end to '
      + 'confirm that here', { present: true, broken });
  }
  // sec-v3r M1 (independent re-review, closes a regression introduced in wp-v4): the canaries below now run
  // against a fully ISOLATED, throwaway project+home pair (buildIsolatedGateProject, above) — never the real
  // project's own config or once-store. Before this fix, spawning with cwd:root made forge-config.cjs (loaded
  // from its real, unmodified location — its data-file paths are __dirname/env-relative, never cwd-relative)
  // read/write the REAL project's FORGE_CONFIG.json and once-store: a pending owner one-off approval would be
  // SPENT on this canary (consumeOnceGrant has no way to tell "the doctor's own canary" apart from "the
  // command the owner actually approved" — the sha256 is evidence only, never verified against anything, see
  // forge-config-once-store.cjs's own header), and a persistently-off gate would make this check report a
  // false malfunction instead of recognising it never touched anything real. opts.isolated (test seam only,
  // used by forge-doctor.test.cjs's own "grant stays unspent" test) lets a caller reuse a specific throwaway
  // pair it already armed a grant in, instead of always getting a brand-new empty one.
  const isolated = o.isolated || buildIsolatedGateProject();
  const ownsIsolated = !o.isolated;
  try {
    // A self-check on our OWN isolation setup, never a read of the real project: confirm the throwaway copy
    // actually starts clean (gate on, no once-grant pending) before running the destructive-shaped canary
    // through it. Cannot confirm (module unavailable, or the read itself throws) -> skip the canary rather
    // than assume — this ADVISORY check simply could not safely proceed this time.
    let gateState = null;
    if (CFG && typeof CFG.get === 'function') {
      try {
        const e = CFG.get('gate-hook', { projectRoot: isolated.root, configHome: isolated.home });
        gateState = { on: e.value !== false, pending: !!e.expires_at };
      } catch { gateState = null; }
    }
    if (!gateState || !gateState.on || gateState.pending) {
      return beginnerResult('gate-watchdog-health', 'warn',
        'skipped the destructive-shaped canary this time: could not confirm the throwaway isolated copy this '
        + 'check builds for itself starts clean (gate on, no one-off pending) before running it — this says '
        + 'nothing about the real project\'s own gate-hook setting, only that this ADVISORY check could not '
        + 'safely proceed', { present: true, isolated_gate_state: gateState });
    }
    const spawnSyncImpl = o.spawnSyncImpl || require('child_process').spawnSync;
    const spawnHook = (command) => {
      try {
        const r = spawnSyncImpl(process.execPath, [hookPath], {
          input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
          encoding: 'utf8', timeout: o.timeoutMs || 8000, cwd: isolated.root, env: isolated.env,
        });
        return { status: r.status, stderr: r.stderr || '', error: r.error || null, signal: r.signal || null };
      } catch (e) {
        return { status: null, stderr: '', error: e, signal: null };
      }
    };
    const harmless = spawnHook('echo forge-doctor-gate-watchdog-health-check');
    // never executed, only classified — a canary path under a name this project would never actually use.
    const canary = spawnHook('rm -rf ./__forge_doctor_gate_watchdog_health_canary__/do-not-create-this-path');
    const harmlessOk = harmless.status === 0 && !harmless.error && !harmless.signal;
    const canaryBlocked = canary.status === 2 && !canary.error && !canary.signal;
    const realClassifierEngaged = canaryBlocked && !/classifier-unavailable/i.test(canary.stderr);
    if (!harmlessOk || !canaryBlocked) {
      return beginnerResult('gate-watchdog-health', 'warn',
        'the real hook did NOT behave as expected end-to-end (isolated throwaway copy, never the real '
        + 'project\'s own config or once-store): a harmless command exited ' + harmless.status + ' (wanted 0), '
        + 'a harmless destructive-SHAPED canary (never executed, only classified) exited ' + canary.status
        + ' (wanted 2, BLOCKED)', { harmless, canary });
    }
    return beginnerResult('gate-watchdog-health', 'ok',
      'the real hook was run end-to-end against an isolated throwaway copy (never the real project\'s own '
      + 'config or once-store): a harmless command exited 0, and a harmless destructive-SHAPED canary (never '
      + 'executed, only classified) was BLOCKED (exit 2) by ' + (realClassifierEngaged ? 'the real classifier' : 'the fail-closed fallback — the real classifier itself may be degraded, see any dependency warning above'),
      { present: true, harmless_exit: harmless.status, canary_exit: canary.status, real_classifier_engaged: realClassifierEngaged });
  } finally {
    if (ownsIsolated) isolated.cleanup();
  }
}

// ===========================================================================================================
// BEGINNER SETUP (wp17, 2026-09-24) — ADVISORY-ONLY, report.advisory.beginner_setup. The setup traps a
// first-time user hits and a doctor can see (research: .claude/forge-research/beginner-sweep-2026-09-24/
// web-track-a.md): A3 an over-long CLAUDE.md gets ignored · A32/B18 `claude`/`git`/`node` "not recognized" ·
// a native Claude Code install needs no Node while every Forge tool is a .cjs file · A20/B9 bypassPermissions
// as a default · B22 a WSL project under /mnt/c · A35 `claude doctor` exists and nobody knows it · (wp-l1,
// loop iteration 1, 2026-09-24) settings-wired: is Forge's own hooks/deny payload actually merged into this
// project's settings.json, via forge-settings-merge.cjs::checkSettingsMerge() · (wp-l4, loop iteration 4,
// 2026-09-24) model-choice-hint: theme 5 of the same beginner sweep (52/98 videos — model choice, usage
// limits & cost) had NO beginner-facing surface anywhere in Forge, only the owner's own global
// TOKEN_EFFICIENCY_GLOBAL_POLICY.md, which a beginner never reads. One plain, paraphrased sentence, always
// `info` (nothing here is evaluated, so it can never be `ok` or `warn`).
// Contract of every check: {id, ok, level:'ok'|'info'|'warn'|'n-a'|'note', detail, ms, ...evidence}; ok is
// false exactly when level is 'warn'. `note` is the same non-judgmental posture as `info` — used when a
// check genuinely has nothing to compare against (see settingsWired() below) rather than a real pass/fail.
// Each result passes through applyDoctorOverride() under its printed id, so an
// owner can acknowledge a deliberate warn (a throwaway VM that really runs bypassPermissions) with the same
// reasoned doctor_check_overrides entry the enforced checks use. Nothing here reads the user's home
// directory: only the project root, the PATH it is handed, and the tools that PATH resolves to.
// ===========================================================================================================
const CLAUDE_MD_MAX_LINES = 200;
const BEGINNER_PATH_TOOLS = ['claude', 'git', 'node'];
const TOOL_VERSION_TIMEOUT_MS = 3000;
const CLAUDE_DOCTOR_TIMEOUT_MS = 5000;
const CLAUDE_DOCTOR_MAX_LINES = 5;
const PATH_MISSING_HINT = 'Close and reopen your terminal; if it is still missing, the install folder is not on PATH.';
const NODE_MISSING_HINT = "Forge's own tools are Node scripts and need Node 18 or newer, even though Claude Code itself does not.";
const WIN_EXEC_EXTS = ['.COM', '.EXE', '.BAT', '.CMD'];
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** CLAUDE_VERSION_ADVISORY_MIN —: the Claude Code release that turned on Opus 5.5's
 *  medium-effort default and the current prompt-caching behaviour (usage-minimisation research,
 *  .claude/forge-research/2026-09-26-usage-minimisation/REPORT.md, citing the CHANGELOG). An older install
 *  just gets the older behaviour silently — worth a plain, non-red nudge, never a warn: this is a version
 *  observation, not a defect in the project or machine. */
const CLAUDE_VERSION_ADVISORY_MIN = '2.1.280';

function envGet(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
function beginnerResult(id, level, detail, extra) {
  return Object.assign({ id, ok: level !== 'warn', level, detail }, extra || {});
}
/** safeCheck — times one check and turns a throw into a visible warn. An advisory must never be able to take
 *  down the doctor it only advises, but a check that crashed is not "fine" either. */
function safeCheck(id, fn) {
  const t0 = Date.now();
  try { return Object.assign({}, fn(), { ms: Date.now() - t0 }); }
  catch (e) { return beginnerResult(id, 'warn', 'check could not run: ' + e.message, { ms: Date.now() - t0 }); }
}
function textLines(text) {
  if (!text) return 0;
  const n = text.split(/\r?\n/).length;
  return /\n$/.test(text) ? n - 1 : n;
}
function cleanLines(text, max) {
  return String(text || '').replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, max)
    .map((l) => (l.length > 160 ? l.slice(0, 157) + '...' : l));
}

/** claude-md-size — the project CLAUDE.md (root, or .claude/CLAUDE.md) line count against Anthropic's ~200
 *  guidance. Absent is fine and said so; unreadable is a warn (Claude Code cannot load it either). */
function claudeMdSize(root) {
  const files = [];
  for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    try { files.push({ file: rel, lines: textLines(fs.readFileSync(abs, 'utf8')) }); }
    catch (e) { files.push({ file: rel, lines: null, error: e.code || e.message }); }
  }
  if (!files.length) return beginnerResult('claude-md-size', 'ok', 'no project CLAUDE.md — nothing to measure', { files });
  const listing = files.map((f) => f.file + ' ' + (f.lines === null ? 'UNREADABLE (' + f.error + ')' : f.lines + ' lines')).join(' · ');
  const long = files.some((f) => f.lines > CLAUDE_MD_MAX_LINES);
  const unreadable = files.some((f) => f.lines === null);
  if (!long && !unreadable) return beginnerResult('claude-md-size', 'info', listing + ' (within the ~' + CLAUDE_MD_MAX_LINES + '-line guidance)', { files });
  return beginnerResult('claude-md-size', 'warn', listing
    + (long ? ' — over ~' + CLAUDE_MD_MAX_LINES + ' lines. Anthropic: long CLAUDE.md files get ignored; move procedures into skills' : '')
    + (unreadable ? ' — a CLAUDE.md that cannot be read is never loaded' : ''), { files });
}

/** resolveOnPath(name, env, platform) -> absolute path | null. The same lookup the shell does, in-process:
 *  `where`/`which` were measured at 437-470 ms per call on Windows, which alone breaks this check's 300 ms
 *  budget three times over. Windows: every PATH dir x PATHEXT (.com/.exe/.bat/.cmd only); POSIX: an
 *  executable regular file. Never spawns, never throws. */
function resolveOnPath(name, env, platform) {
  const isWin = platform === 'win32';
  // Windows PATH entries may be wrapped in quotes (cmd strips them); a POSIX PATH entry is taken literally.
  const dirs = String(envGet(env, 'PATH') || '').split(isWin ? ';' : ':').map((d) => (isWin ? d.trim().replace(/^"(.*)"$/, '$1') : d)).filter(Boolean);
  let exts = [''];
  if (isWin) {
    const fromEnv = String(envGet(env, 'PATHEXT') || '').split(';').map((e) => e.trim().toUpperCase()).filter((e) => WIN_EXEC_EXTS.includes(e));
    exts = (fromEnv.length ? fromEnv : WIN_EXEC_EXTS).map((e) => e.toLowerCase());
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* not here — keep looking */ }
    }
  }
  return null;
}
/** spawnResolved — run an already-resolved tool read-only: no shell, stdin closed (so nothing can wait for a
 *  keypress), hard timeout. Node refuses to spawn .cmd/.bat directly since the 2024 batch-file hardening, so
 *  those go through cmd.exe with ONE pre-quoted command line, verbatim — the same /d /s /c form Node itself
 *  builds for a shell spawn. The arguments are fixed literals chosen by this file, never user input. */
function spawnResolved(file, args, env, timeoutMs, cwd) {
  const base = { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, cwd, shell: false };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const comspec = envGet(env, 'ComSpec') || envGet(process.env, 'ComSpec') || 'cmd.exe';
    return spawnSync(comspec, ['/d', '/s', '/c', '""' + file + '" ' + args.join(' ') + '"'], Object.assign({}, base, { windowsVerbatimArguments: true }));
  }
  return spawnSync(file, args, base);
}
function toolVersion(file, env, cwd) {
  const r = spawnResolved(file, ['--version'], env, TOOL_VERSION_TIMEOUT_MS, cwd);
  if (r.error && r.error.code === 'ETIMEDOUT') return { version: null, version_note: '--version timed out after ' + (TOOL_VERSION_TIMEOUT_MS / 1000) + ' s' };
  if (r.error) return { version: null, version_note: '--version failed: ' + (r.error.code || r.error.message) };
  const first = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), 1)[0];
  return first ? { version: first } : { version: null, version_note: '--version printed nothing (exit ' + r.status + ')' };
}

function isSameFile(a, b) {
  try {
    const ra = fs.realpathSync(a), rb = fs.realpathSync(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch { return false; }
}
/** parseVersionTriple(str) -> [major, minor, patch] | null — pulls the first x.y.z-looking token out of an
 *  arbitrary `--version` first line (e.g. "2.1.220 (Claude Code)", or a test stub like "0.0.1-stub"). Never
 *  guesses: a string with no such token returns null rather than a fabricated triple. */
function parseVersionTriple(str) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(str || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** compareVersionTriples(a, b) -> negative | 0 | positive, ordinary numeric triple comparison. */
function compareVersionTriples(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
/** claudeVersionAdvisory(versionString) -> string | null —. A plain-words, non-judgmental nudge
 *  when the installed `claude` predates CLAUDE_VERSION_ADVISORY_MIN; null (no advisory at all) once it is
 *  current, and null on an unparseable string too — this ADVISES, it never guesses a verdict from a string
 *  it can't read. Pure function so it is directly testable with a stubbed version string, independent of
 *  ever spawning a real binary. */
function claudeVersionAdvisory(versionString) {
  const cur = parseVersionTriple(versionString);
  if (!cur) return null;
  const min = parseVersionTriple(CLAUDE_VERSION_ADVISORY_MIN);
  if (compareVersionTriples(cur, min) >= 0) return null;
  return 'your claude (' + versionString + ') is older than ' + CLAUDE_VERSION_ADVISORY_MIN + ' — that release '
    + "turned on Opus 5.5's medium-effort default and the current caching behaviour, so an older install just "
    + 'gets the earlier behaviour silently. `claude update` picks up the newer version when convenient — this '
    + 'is only a heads-up, no action required.';
}

/** path-tools — claude, git, node resolvable on PATH, each with the first line of its --version (3 s cap).
 *  When the `node` on PATH IS the binary running this doctor, its version is process.version — the exact
 *  string `node --version` prints — and one of three spawns is saved (measured 40-140 ms per spawn here).
 *  an outdated `claude` gets a plain version advisory tacked onto the SAME `ok`/`warn` verdict
 *  path-tools already computes from missing tools — the advisory never flips that verdict (never red). */
function pathTools(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const tools = {};
  for (const name of BEGINNER_PATH_TOOLS) {
    const found = resolveOnPath(name, env, platform);
    if (!found) { tools[name] = { found: false, path: null, version: null }; continue; }
    tools[name] = name === 'node' && isSameFile(found, process.execPath)
      ? { found: true, path: found, version: process.version, version_source: 'this doctor process' }
      : Object.assign({ found: true, path: found }, toolVersion(found, env, root));
  }
  if (tools.claude && tools.claude.found && tools.claude.version) {
    const advisory = claudeVersionAdvisory(tools.claude.version);
    if (advisory) tools.claude.version_advisory = advisory;
  }
  const missing = BEGINNER_PATH_TOOLS.filter((n) => !tools[n].found);
  const listing = BEGINNER_PATH_TOOLS.map((n) => n + ': ' + (!tools[n].found ? 'MISSING' : (tools[n].version || 'found (' + tools[n].version_note + ')'))).join(' · ');
  const versionAdvisorySuffix = (tools.claude && tools.claude.version_advisory) ? ' · ' + tools.claude.version_advisory : '';
  if (!missing.length) return beginnerResult('path-tools', 'ok', listing + versionAdvisorySuffix, { tools, missing });
  return beginnerResult('path-tools', 'warn', listing + ' — not recognized on PATH: ' + missing.join(', ') + '. ' + PATH_MISSING_HINT
    + (missing.includes('node') ? ' ' + NODE_MISSING_HINT : '') + versionAdvisorySuffix, { tools, missing });
}

/** bypass-mode — the PROJECT's .claude/settings.json + settings.local.json only (never a global settings
 *  file): permissions.defaultMode "bypassPermissions" is a warn; a file that does not parse is a warn too. */
function bypassMode(root) {
  const files = [];
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (e) { files.push({ file: rel, readable: false, error: e.code || e.name }); continue; }
    const perms = data && typeof data === 'object' && data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
    files.push({ file: rel, readable: true, defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null });
  }
  const bypass = files.filter((f) => f.defaultMode === 'bypassPermissions').map((f) => f.file);
  const unreadable = files.filter((f) => !f.readable).map((f) => f.file + ' (' + f.error + ')');
  const problems = [];
  if (bypass.length) problems.push(bypass.join(', ') + ' sets permissions.defaultMode "bypassPermissions": every tool call runs without asking — keep that for a throwaway container or VM, not a real machine. Meer uitleg / more detail: .claude/skills/forge-prompt-coach/references/unsafe-advice.md');
  if (unreadable.length) problems.push('settings unreadable: ' + unreadable.join(', ') + ' — Claude Code cannot apply a settings file it cannot parse');
  if (problems.length) return beginnerResult('bypass-mode', 'warn', problems.join(' · '), { files });
  if (!files.length) return beginnerResult('bypass-mode', 'info', 'no project settings file — Claude Code asks before risky actions by default', { files });
  return beginnerResult('bypass-mode', 'info', 'no bypassPermissions default in ' + files.map((f) => f.file + (f.defaultMode ? ' (defaultMode ' + f.defaultMode + ')' : '')).join(' + '), { files });
}

/** wsl-mnt-c — a Linux (WSL) process whose project root sits under /mnt/ is working on the Windows drive
 *  through the 9P bridge: slow, and file watching there is incomplete. Pure string check, no file access. */
function wslMntC(root, opts) {
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'linux') return beginnerResult('wsl-mnt-c', 'n-a', 'not applicable on ' + platform + ' (WSL-only check)');
  if (String(root).startsWith('/mnt/')) return beginnerResult('wsl-mnt-c', 'warn', 'project root ' + root + ' is on the Windows drive seen from WSL (slow file access, incomplete file watching). WSL: keep the project inside the Linux home for speed');
  return beginnerResult('wsl-mnt-c', 'ok', 'project root is on the Linux filesystem');
}

/** claude-doctor — Anthropic's own read-only installation check, surfaced because beginners do not know it
 *  exists. Runs ONLY when the caller asks (the forge-doctor CLI does; library and fixture calls do not, so a
 *  test suite never spends 5 s per runDoctor() on it), only when `claude` resolved on PATH, with stdin
 *  closed and a 5 s cap: it can never become an interactive session — a CLI that insists on a terminal just
 *  times out, and that is reported as such. The first 5 non-empty lines are shown verbatim, never parsed. */
function claudeDoctorProbe(root, opts) {
  const o = opts || {};
  if (!o.claudePath) return beginnerResult('claude-doctor', 'info', 'not run (claude CLI absent from PATH)', { ran: false, lines: [] });
  if (!o.probe) return beginnerResult('claude-doctor', 'info', 'not run (library call — the read-only `claude doctor` probe runs from the forge-doctor CLI only)', { ran: false, lines: [] });
  const timeoutMs = o.timeoutMs || CLAUDE_DOCTOR_TIMEOUT_MS;
  const r = spawnResolved(o.claudePath, ['doctor'], o.env || process.env, timeoutMs, root);
  if (r.error && r.error.code === 'ETIMEDOUT') return beginnerResult('claude-doctor', 'info', 'not run (timed out after ' + (timeoutMs / 1000) + ' s — the doctor runs `claude doctor` read-only itself and stopped it because it was waiting for an interactive terminal; nothing for you to do, the next doctor run tries again)', { ran: false, timed_out: true, lines: [] });
  if (r.error) return beginnerResult('claude-doctor', 'info', 'not run (' + (r.error.code || r.error.message) + ')', { ran: false, lines: [] });
  const lines = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), CLAUDE_DOCTOR_MAX_LINES);
  return beginnerResult('claude-doctor', 'info', '`claude doctor` ran read-only (exit ' + r.status + ')' + (lines.length ? ', first ' + lines.length + ' line(s):' : ' but printed nothing'), { ran: true, exit: r.status, lines });
}

/** prompt-coach-present — completeness: an install that has forge-intake must also have forge-prompt-coach,
 *  the skill the intake hands a vague request to. */
function promptCoachPresent(root) {
  const skills = path.join(claudeDir(root), 'skills');
  const intake = fs.existsSync(path.join(skills, 'forge-intake', 'SKILL.md'));
  const coach = fs.existsSync(path.join(skills, 'forge-prompt-coach', 'SKILL.md'));
  if (!intake) return beginnerResult('prompt-coach-present', 'n-a', 'forge-intake is not installed here, so there is no pairing to check', { intake, coach });
  if (coach) return beginnerResult('prompt-coach-present', 'ok', 'forge-intake and forge-prompt-coach are both installed', { intake, coach });
  return beginnerResult('prompt-coach-present', 'warn', 'forge-intake is installed but .claude/skills/forge-prompt-coach/SKILL.md is missing — an incomplete install or sync', { intake, coach });
}

/** settingsTemplatePath(opts) -> absolute path to a template settings.json, or null. Mirrors forge-sync.cjs's
 *  OWN template-resolution order: an injected opts.source (test/CLI) first, then FORGE_SYNC_TEMPLATE_DIR,
 *  then the SAME canonical global template forge-sync.cjs itself falls back to —
 *  `<home>/.claude/forge/template/.claude/settings.json` — because that is exactly where install.ps1 and
 *  install.sh copy the shipped `.claude` tree on an installer install (N8, 2026-09-26 laptop re-audit:
 *  without this fallback, settings-wired could never run on an installer install and only ever said "note").
 *  This is a READ-ONLY existence check — it never writes here or anywhere else. Comparing a project's
 *  settings.json against itself is still avoided: this path is the shared template dir, not the project's
 *  own .claude, so it never trivially reads "up to date" for the wrong reason. With none of the three
 *  sources available there is honestly no template to compare against (reported as `note`, never guessed). */
function settingsTemplatePath(opts) {
  const o = opts || {};
  if (o.source) return o.source;
  const envDir = process.env.FORGE_SYNC_TEMPLATE_DIR;
  if (envDir) {
    const p = path.join(path.resolve(envDir), 'settings.json');
    if (fs.existsSync(p)) return p;
  }
  const globalTemplate = path.join(os.homedir(), '.claude', 'forge', 'template', '.claude', 'settings.json');
  if (fs.existsSync(globalTemplate)) return globalTemplate;
  return null;
}

/** settings-wired — wp-l1 (loop iteration 1): forge-settings-merge.cjs::checkSettingsMerge()
 *  (the pure, exported function — never a spawned CLI) against a genuine EXTERNAL template settings.json.
 *  `ok` when every Forge hook + deny rule the template ships is already present in this project's own
 *  settings.json; `warn` (never a hard failure — this stays advisory-only) when something from the template
 *  is missing; `note` when there is no settings.json here yet, or no template could be found to compare
 *  against (checkSettingsMerge() itself never writes anything either way). */
function settingsWired(root, opts) {
  const o = opts || {};
  const target = path.join(claudeDir(root), 'settings.json');
  if (!fs.existsSync(target)) {
    return beginnerResult('settings-wired', 'note', 'no .claude/settings.json in this project yet — nothing to compare', { target, source: null });
  }
  const source = settingsTemplatePath(o);
  if (!source) {
    return beginnerResult('settings-wired', 'note', 'no template settings.json found to compare against (set FORGE_SYNC_TEMPLATE_DIR to a template .claude dir to enable this check) — cannot judge whether Forge hooks/deny rules are wired', { target, source: null });
  }
  let mergeTool;
  try { mergeTool = require('./forge-settings-merge.cjs'); }
  catch (e) { return beginnerResult('settings-wired', 'note', 'forge-settings-merge.cjs unavailable: ' + e.message, { target, source }); }
  const r = mergeTool.checkSettingsMerge({ target, source });
  if (r.status === 'usage-error' || r.status === 'missing') {
    return beginnerResult('settings-wired', 'note', 'could not compare settings.json against the template: ' + r.message, { target, source });
  }
  if (r.ok) return beginnerResult('settings-wired', 'ok', 'every Forge hook and deny rule from the template is already wired into settings.json', { target, source });
  const upgraded = Array.isArray(r.upgraded) ? r.upgraded : [];
  return beginnerResult('settings-wired', 'warn', 'settings.json is missing ' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + upgraded.length + ' hook command update(s), ' + r.deny_added.length + ' deny rule(s) from the template — run forge-sync (or forge-settings-merge.cjs apply) to wire it in', { target, source, added: r.added, adjusted: r.adjusted, upgraded, deny_added: r.deny_added });
}

/** model-choice-hint — wp-l4 (loop iteration 4): a paraphrase of the owner's own
 *  TOKEN_EFFICIENCY_GLOBAL_POLICY.md for a beginner who has never seen that file. Pure education, not an
 *  evaluation of this project or machine, so it is always `info` — never `ok` (nothing passed) and never
 *  `warn` (nothing failed). One plain sentence, no jargon, no imperative telling the reader to run a specific
 *  command — it DESCRIBES that `/costs` and `/insights` exist rather than instructing "run /costs now".
 *  English-only, like every other beginner_setup check here (none of them branch on language either) —
 *  written in short, idiom-free sentences so it reads the same for a Dutch or English first-time user.
 *
 * added the CACHE-DISCIPLINE sentence, in the same descriptive, non-imperative
 *  register: switching model or tools mid-session, or compacting right after a long gap, is what actually
 *  costs the most (research: .claude/forge-research/2026-09-26-usage-minimisation/REPORT.md — a cache miss
 *  costs roughly 25-40x a cache read of the same content), so this is worth a beginner knowing even though
 *  Forge itself has no switch to flip for it — see the forge.md "CACHE DISCIPLINE" section for the fuller
 *  version of the same guidance. */
function modelChoiceHint() {
  return beginnerResult('model-choice-hint', 'info',
    'model choice affects quality and cost together: a balanced, Sonnet-class model already covers everyday '
    + 'work well, a heavier model is worth reaching for only on genuinely high-risk work (security, '
    + 'production, a hard bug), a usage guard pauses Forge when you near your usage limit (it measures on an '
    + 'interval, so it is a pause before the limit, not a guaranteed instant block), and both `/costs` and '
    + '`/insights` keep the amount already used visible inside Claude Code. Picking the model and effort level '
    + 'once at the start of a session and keeping both for its whole length is what keeps the cached context '
    + 'cheap — switching model partway through, or turning a tool on or off, makes the next step re-read the '
    + 'whole conversation at full price instead of the cached rate; `/compact` is cheapest at a natural break '
    + 'between tasks rather than after a long gap (which already lost the saving), and `/rewind` is the cheaper '
    + 'way back when a path is being abandoned instead of compacting past it.');
}

/** beginnerSetup(root, {env, platform, probeClaudeDoctor, claudeDoctorTimeoutMs, overrideMap, settingsSource}) ->
 *  {ok, checks:{claude_md_size, path_tools, bypass_mode, wsl_mnt_c, claude_doctor, prompt_coach_present,
 *  settings_wired, model_choice_hint}, ms}. env/platform default to this process — injectable so the tests
 *  can hand it a fake PATH or a Linux root; settingsSource is the same test/CLI injection
 *  settingsTemplatePath() honors. */
function beginnerSetup(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const overrideMap = o.overrideMap || new Map();
  const t0 = Date.now();
  const pt = safeCheck('path-tools', () => pathTools(root, { env, platform }));
  const claudePath = pt.tools && pt.tools.claude && pt.tools.claude.found ? pt.tools.claude.path : null;
  const raw = {
    claude_md_size: safeCheck('claude-md-size', () => claudeMdSize(root)),
    path_tools: pt,
    bypass_mode: safeCheck('bypass-mode', () => bypassMode(root)),
    wsl_mnt_c: safeCheck('wsl-mnt-c', () => wslMntC(root, { platform })),
    claude_doctor: safeCheck('claude-doctor', () => claudeDoctorProbe(root, { claudePath, probe: !!o.probeClaudeDoctor, env, timeoutMs: o.claudeDoctorTimeoutMs })),
    prompt_coach_present: safeCheck('prompt-coach-present', () => promptCoachPresent(root)),
    settings_wired: safeCheck('settings-wired', () => settingsWired(root, { source: o.settingsSource })),
    model_choice_hint: safeCheck('model-choice-hint', () => modelChoiceHint()),
  };
  const checks = {};
  for (const [key, res] of Object.entries(raw)) checks[key] = applyDoctorOverride(overrideMap, res.id, res);
  return { ok: Object.values(checks).every((c) => c.ok), checks, ms: Date.now() - t0 };
}

function runDoctor(root, opts) {
  root = path.resolve(root);
  const o = opts || {};
  const testsResult = runTests(root);
  const overrides = loadDoctorCheckOverrides(root);
  const overrideMap = new Map(overrides.map((o) => [o.check, o]));
  const checks = {
    node_check: nodeCheckAll(root),
    tests: testsResult,
    strict_events: strictEventCheck(root),
    dashboard_spa: spaPresent(root),
    leak_scan: leakScan(root),
    agents: agentsCheck(root),
    chain: chainCheck(root),
    rebinding_guard: rebindingGuardCombined(root),
    // V9-INTEGRATE: promoted from advisory-only to ENFORCED — see the header doc's
    // "V9-INTEGRATE enforcement" note above for exactly why these two (and no others) were safe to promote.
    // Recoverable via FORGE_HARD_RULES.json's doctor_check_overrides (loadDoctorCheckOverrides()/
    // applyDoctorOverride() above) if a genuine false-red ever surfaces.
    unregistered_event: applyDoctorOverride(overrideMap, 'unregistered_event', unregisteredEvent(root)),
    check_the_checks: applyDoctorOverride(overrideMap, 'check_the_checks', checkTheChecks(root, testsResult)),
    // (prd-w2-discipline M2): ENFORCED from day one (not promoted later like the two
    // above) — see releaseExclusionsCheck()'s own doc for exactly what it does and does not check.
    release_exclusions: applyDoctorOverride(overrideMap, 'release_exclusions', releaseExclusionsCheck(root)),
    // GOAT model routing: ENFORCED from day one — see modelRoutingCheck() above.
    model_routing: applyDoctorOverride(overrideMap, 'model_routing', modelRoutingCheck(root)),
    // the shipping manifest, ENFORCED from day one in the development tree (n/a elsewhere) —
    // see shipManifestCheck() above.
    ship_manifest: applyDoctorOverride(overrideMap, 'ship_manifest', shipManifestCheck(root)),
    // promoted from advisory.completeness to ENFORCED — red only when the newest run claimed
    // completion over an unmet completion sequence, skipped finalize, or holds a STALE receipt; see the
    // "run_contract — ENFORCED" block doc above runContractDoctorCheck().
    run_contract: applyDoctorOverride(overrideMap, 'run_contract', runContractDoctorCheck(root)),
    // every tool and skill is registered, and a `wired` one really has a wired caller —
    // ENFORCED in the development tree, n/a elsewhere. See featureRegistryCheck().
    feature_registry: applyDoctorOverride(overrideMap, 'feature_registry', featureRegistryCheck(root)),
    // part ii: skill frontmatter Claude Code can actually read + every forge-* skill catalogued —
    // ENFORCED in the development tree, labelled (never red) elsewhere. See skillFrontmatterCheck().
    skill_frontmatter: applyDoctorOverride(overrideMap, 'skill_frontmatter', skillFrontmatterCheck(root)),
  };
  // advisory checks are DELIBERATELY excluded from this ok computation — see backfillContinuity's doc above.
  const ok = Object.values(checks).every((c) => c.ok);
  const advisory = {
    // where (if anywhere) THIS project's own wrappers would find a Command Center —
    // project-local / central / not-installed. Always ok:true (see commandCenterLocation()'s own doc).
    command_center_location: commandCenterLocation(root),
    backfill_continuity: backfillContinuity(root),
    // forge-runwatch.cjs, run automatically instead of only on request — its own
    // top-level advisory key (liveness is not completeness) with its own printSummary line, exactly like
    // backfill_continuity. See runLiveness() above for the window/status rules and why it stays advisory.
    run_liveness: runLiveness(root),
    // the ALWAYS-LOADED instruction surface, metered. Its own top-level advisory key (a context
    // budget is not completeness) with its own printSummary line. See contextBudgetCheck() above.
    context_budget: contextBudgetCheck(root),
    // wp-v3 (sec-v1r, item 4): visible reporting when forge-gate-hook.cjs's own super-linear-DoS protection
    // (forge-gate-watchdog.cjs / worker_threads) fails to load. See gateWatchdogHealth() above.
    gate_watchdog_health: safeCheck('gate-watchdog-health', () => gateWatchdogHealth(root)),
    // + part ii: four advisories, each with its own printSummary line. A throw degrades to
    // an honest "could not run" (ok:true), never a crash of the whole doctor.
    scribe_wiring: advisorySafe('scribe_wiring', () => scribeWiring(root)),
    unpublished: advisorySafe('unpublished', () => unpublishedCheck(root)),
    structure: advisorySafe('structure', () => structureCheck(root)),
    always_loaded_budget: advisorySafe('always_loaded_budget', () => alwaysLoadedBudget(root)),
    // the beginner setup traps — machine/preference findings, never a code defect, so
    // advisory by construction. The `claude doctor` probe runs only when the caller opts in (the CLI does).
    beginner_setup: beginnerSetup(root, { overrideMap, env: o.env, platform: o.platform, probeClaudeDoctor: !!o.probeClaudeDoctor, claudeDoctorTimeoutMs: o.claudeDoctorTimeoutMs }),
    // WAVE A / A2 + V9-INTEGRATE: the completeness checks that remain
    // ADVISORY-ONLY, grouped under one key so printSummary can emit a single compact advisory line — see the
    // header doc comment for exactly why each one here (unlike unregistered_event/check_the_checks above)
    // was NOT promoted to enforced.
    completeness: {
      sync_completeness: syncCompleteness(root),
      memory_discipline: memoryDiscipline(root),
      // WAVE G / G-INTEGRATE: MCP-as-client safety-doctrine self-test — see mcpDormancy() above.
      mcp_dormancy: mcpDormancy(root),
      // run_contract moved OUT of this advisory group on 2026-10-10: it is an ENFORCED `checks` entry now.
      quality_catalog: qualityCatalogDoctorCheck(root),
      // wp-skill-evals: forge-skill-evals.cjs wired in, advisory-only — see
      // skillEvalsDoctorCheck() above for why this FOUNDATION piece is not yet safe to enforce.
      skill_evals: skillEvalsDoctorCheck(root),
      // wp-disclosure-ab: progressive-disclosure hygiene, advisory-only — see skillHygiene()
      // above for why this is review signal today, not yet a build gate.
      skill_hygiene: skillHygiene(root),
    },
  };
  return { ok, root, checks, advisory, generated_at: new Date().toISOString() };
}

function printSummary(rep) {
  const c = rep.checks;
  // a label of 16+ characters still gets one space before its detail (was "release exclusions8 sync_folders")
  const line = (label, ok, detail) => (ok ? '  ✓ ' : '  ✗ ') + (label.length >= 16 ? label + ' ' : label.padEnd(16)) + (detail || '');
  const out = [];
  out.push('Forge Doctor — ' + rep.root);
  out.push(line('node --check', c.node_check.ok, c.node_check.total + ' files' + (c.node_check.ok ? '' : ' · ' + (c.node_check.reason || (c.node_check.failed + ' FAILED')))));
  // 2026-09-24 (measured on the first CI run): "122 suites · 6128 passed / 0 failed · 1 SUITE(S) FAILED" named
  // NOTHING — a suite that crashed before its tally (0 failed assertions, non-zero exit) was invisible on a runner
  // where nobody can open the per-suite output. Name the red suites, with WHY (crashed / no tally / timeout).
  const redSuites = Array.isArray(c.tests.perSuite) ? c.tests.perSuite.filter((s) => s && s.ok === false) : [];
  const whySuite = (s) => s.timedOut ? 'timeout' : (s.passed === 0 && s.failed === 0 ? 'crashed or no tally' : (s.failed > 0 ? s.failed + ' failed' : 'non-zero exit'));
  const redNames = redSuites.slice(0, 6).map((s) => s.suite + ' (' + whySuite(s) + ')').join(', ') + (redSuites.length > 6 ? ', +' + (redSuites.length - 6) + ' more' : '');
  out.push(line('tests', c.tests.ok, c.tests.suites + ' suites · ' + c.tests.passed + ' passed / ' + c.tests.failed + ' failed'
    + (c.tests.ok ? '' : ' · ' + (c.tests.reason || [c.tests.suitesFailed ? c.tests.suitesFailed + ' SUITE(S) FAILED' : '', c.tests.suitesBlocked ? c.tests.suitesBlocked + ' SUITE(S) BLOCKED (timeout)' : ''].filter(Boolean).join(' · ')) + (redNames ? ' → ' + redNames : ''))));
  out.push(line('honesty gate', c.strict_events.ok, 'known accepted=' + c.strict_events.known_accepted + ' · unknown rejected=' + c.strict_events.unknown_rejected));
  // 2026-09-23 (external audit II-G): this line used to read "dashboard SPA · 7 files present", which a
  // new user reads as "the dashboard works" — but these seven files are the RETIRED per-project Control
  // Center that is never started; the live Command Center is a separate build. Say what is actually being
  // checked, so a green here is never mistaken for a working dashboard.
  out.push(line('legacy SPA files', c.dashboard_spa.ok, c.dashboard_spa.present.length === 0
    ? 'none present — retired Control Center removed in 2.9.0 (log-event.cjs stays; the dashboard is the Command Center)'
    : c.dashboard_spa.present.length + ' legacy file(s) still present (advisory only — forge-sync install removes them when unmodified): ' + c.dashboard_spa.present.join(', ')));
  const lk = c.leak_scan;
  // MULTI-REPO ACCOUNTING: when more than one repository under this root contributed files,
  // say so and say how many each gave. A single anonymous total is exactly what let "1146 tracked files ·
  // clean" stand for years while a whole nested tree was never opened. Appended ONLY when there really is
  // more than one source, so an ordinary single-repo project's line is unchanged, character for character.
  const lkSources = lk.sources || [];
  const lkFrom = lkSources.length > 1
    ? ' from ' + lkSources.length + ' repos: ' + lkSources.map((s) => s.root + ' ' + (s.unavailable ? 'UNAVAILABLE (' + s.unavailable + ')' : s.files)).join(' + ')
    : '';
  const lkSkips = lk.skipped || [];
  const lkTooLarge = lkSkips.filter((s) => s.reason === 'too-large').length;
  const lkBinary = lkSkips.filter((s) => s.reason === 'binary').length;
  const lkUnreadable = lkSkips.filter((s) => s.reason === 'unreadable').length;
  const lkLongLine = lkSkips.filter((s) => s.reason === 'long-line').length;
  // honest coverage note (4th/5th fix round): never let the verdict imply total coverage while something was
  // dropped. too-large/binary/unreadable = the WHOLE file was not scanned (all honesty-critical — a real
  // secret could hide there); long-line = the file WAS scanned except over-long lines were length-bounded
  // (ReDoS guard). All surfaced so "clean" never silently means "clean among only what we bothered to scan".
  const lkParts = [];
  const lkNotScanned = lkTooLarge + lkBinary + lkUnreadable;
  if (lkNotScanned) lkParts.push(lkNotScanned + ' file(s) not scanned (' + [lkTooLarge ? lkTooLarge + ' too-large' : '', lkBinary ? lkBinary + ' binary' : '', lkUnreadable ? lkUnreadable + ' unreadable' : ''].filter(Boolean).join(', ') + ')');
  if (lkLongLine) lkParts.push(lkLongLine + ' file(s) with over-long line(s) bounded');
  // WP-SYNC-R8: a folder deliberately not descended into is NAMED (only when there is one — an ordinary line is unchanged)
  if ((lk.notScanned || []).length) lkParts.push('not scanned: ' + lk.notScanned.map((n) => n.dir + '/').join(', ') + ' (agent worktree checkouts)');
  const lkSkip = lkParts.length ? ' · ' + lkParts.join(' · ') : '';
  out.push(line('leak scan', lk.ok, lk.scanned + ' tracked files (' + lk.source + ')' + lkFrom + (lk.ok ? ' · clean' : ' · ' + lk.hits.length + ' HIT(S): ' + lk.hits.map((h) => h.pattern + ' in ' + h.file).join('; ')) + lkSkip));
  if (c.agents) {
    const a = c.agents;
    const tp = a.toolPolicy || {};
    const tpBad = tp.ok === false ? [
      tp.reason || '',
      (tp.missingPolicy || []).length ? 'no policy entry: ' + tp.missingPolicy.join(',') : '',
      (tp.missingAgentFile || []).length ? 'policy entry but no agent-md: ' + tp.missingAgentFile.join(',') : '',
      (tp.classViolations || []).length ? 'POLICY ITSELF violates class rules: ' + tp.classViolations.map((v) => v.agent + '(' + v.forbidden.join(',') + ')').join('; ') : '',
      (tp.driftViolations || []).length ? 'TOOL-GRANT DRIFT: ' + tp.driftViolations.map((v) => v.agent + (v.extra.length ? ' +' + v.extra.join(',') : '') + (v.missing.length ? ' -' + v.missing.join(',') : '')).join('; ') : '',
      (tp.overlayProblems || []).length ? 'OVERLAY REJECTED (agent-tool-policy.user.json may only add agents): ' + tp.overlayProblems.join('; ') : '',
    ].filter(Boolean).join(' · ') : '';
    const overlayNote = (tp.overlayAdded || []).length ? ' (+' + tp.overlayAdded.length + ' project agent(s) from agent-tool-policy.user.json: ' + tp.overlayAdded.join(', ') + ')' : '';
    const detail = a.ok ? (a.expected + '/' + a.expected + ' Boss files · ' + a.found + ' agents · frontmatter valid · injection-clean · tool-policy clean' + overlayNote)
      : ([a.missing.length ? 'missing: ' + a.missing.join(',') : '', a.badFrontmatter.length ? 'bad frontmatter: ' + a.badFrontmatter.join(',') : '', a.injection.length ? 'INJECTION: ' + a.injection.map((h) => h.pattern + ' in ' + h.file).join('; ') : '', (a.unloadableModel || []).length ? 'NOT LOADABLE by Claude Code (model must be opus/sonnet/haiku/fable/inherit): ' + a.unloadableModel.map((u) => u.agent + '=' + u.model).join(', ') : '', tpBad].filter(Boolean).join(' · '));
    out.push(line('agents', a.ok, detail));
  }
  if (c.chain) {
    const ch = c.chain;
    out.push(line('event chain', ch.ok, ch.chained + '/' + ch.checked + ' runs hash-chained · tamper-evident' + (ch.ok ? '' : ' · BROKEN: ' + ch.broken.map((b) => b.run + ' (' + b.reason + ')').join('; '))));
  }
  if (c.rebinding_guard) out.push(line('rebind guard', c.rebinding_guard.ok, c.rebinding_guard.applicable === false ? c.rebinding_guard.reason : (c.rebinding_guard.ok ? 'Command Center gateway Host/Origin/Sec-Fetch guard wired' : c.rebinding_guard.reason)));
  // V9-INTEGRATE: the two completeness checks promoted from advisory to ENFORCED — printed as
  // ordinary ✓/✗ lines like every other checks-key above (they now genuinely gate `ok`). An `overridden:true`
  // result still prints ✓ (it IS a pass — see applyDoctorOverride() doc) but carries a visible
  // `[OVERRIDDEN: <reason>]` tag so an owner override is never mistaken for an ordinary clean pass.
  const overrideTag = (r) => r.overridden ? ' [OVERRIDDEN by ' + (r.override_by || 'owner') + ': ' + r.override_reason + ']' : '';
  if (c.unregistered_event) {
    const ue = c.unregistered_event;
    out.push(line('unreg. events', ue.ok, (ue.ok && !ue.overridden ? (ue.checkedFiles || 0) + ' files scanned · none unregistered' : (ue.unregistered && ue.unregistered.length ? ue.unregistered.length + ' unregistered usage(s): ' + ue.unregistered.map((u) => u.event_type + ' in ' + u.file).join('; ') : (ue.reason || ''))) + overrideTag(ue)));
  }
  if (c.check_the_checks) {
    const ctc = c.check_the_checks;
    out.push(line('no-op tests', ctc.ok, (ctc.ok && !ctc.overridden ? (ctc.checked || 0) + ' suites scanned · no green no-ops' : (ctc.noOp && ctc.noOp.length ? ctc.noOp.length + ' green no-op suite(s): ' + ctc.noOp.map((n) => n.suite).join(', ') : '')) + overrideTag(ctc)));
  }
  // (prd-w2-discipline M2): release_exclusions — see releaseExclusionsCheck()'s own
  // doc for exactly what "dist check skipped" means and why it is not a problem.
  if (c.release_exclusions) {
    const re = c.release_exclusions;
    const pc = re.pattern_counts;
    const countsText = pc ? pc.sync_folders + ' sync_folders · ' + pc.never_sync + ' never_sync · ' + pc.dist_forbidden + ' dist_forbidden pattern(s)' : '';
    const detail = re.ok && !re.overridden
      ? (re.dist_checked ? (re.files_checked || 0) + ' tracked file(s) checked via ' + re.method + ' · clean · ' + countsText : countsText + ' · ' + re.reason)
      : (re.reason || '');
    out.push(line('release exclusions', re.ok, detail + overrideTag(re)));
  }
  if (c.model_routing) {
    const mr = c.model_routing;
    const viol = mr.violations || [];
    const detail = mr.applicable === false ? 'n/a — ' + mr.reason
      : (mr.ok && !mr.overridden
        ? mr.checked + ' agent(s): frontmatter == agent-model-map == tool-policy · routes complete · escalate=fable · no env/settings override'
        : (viol.length ? viol.length + ' violation(s): ' + viol.slice(0, 4).map((v) => v.kind + ' (' + v.detail + ')').join('; ') + (viol.length > 4 ? '; +' + (viol.length - 4) + ' more' : '') : (mr.reason || '')))
      + ((mr.notes || []).length ? ' · note: ' + mr.notes.join(' · ') : '');
    out.push(line('model routing', mr.ok, detail + overrideTag(mr)));
  }
  // ship_manifest — known-gap warnings are named with their owner WP on the ✓ line itself, so a
  // green line never hides that real gaps are still open; a ✗ names the first violations.
  if (c.ship_manifest) {
    const sm = c.ship_manifest;
    const fl = sm.failures || [];
    const gapCounts = {};
    for (const w of sm.warnings || []) { const k = w.known_gap + '→' + w.owner_wp; gapCounts[k] = (gapCounts[k] || 0) + 1; }
    const gapText = Object.keys(gapCounts).length ? ' · known-gap warnings: ' + Object.entries(gapCounts).map(([k, n]) => k + ' ×' + n).join(', ') : '';
    const staleText = (sm.stale_known_gaps || []).length ? ' · STALE known gaps (remove them): ' + sm.stale_known_gaps.join(', ') : '';
    const detail = sm.applicable === false && sm.ok ? 'n/a — ' + sm.reason
      : (sm.ok && !sm.overridden
        ? (sm.sources || 0) + ' source paths classified (' + Object.entries(sm.by_class || {}).map(([k, n]) => k + ' ' + n).join(', ') + ') · sync drift both ways · ' + (sm.refs_checked || 0) + ' references closed' + gapText + staleText
        : (fl.length ? fl.length + ' violation(s): ' + fl.slice(0, 4).map((f) => f.kind + ' ' + f.path).join('; ') + (fl.length > 4 ? '; +' + (fl.length - 4) + ' more' : '') : (sm.reason || '')));
    out.push(line('ship manifest', sm.ok, detail + overrideTag(sm)));
  }
  // run_contract, ENFORCED — names the run, its state and (for a red) the exact next command.
  if (c.run_contract) out.push(line('run contract', c.run_contract.ok, runContractSummary(c.run_contract) + overrideTag(c.run_contract)));
  // feature_registry, ENFORCED in the development tree — counts on a ✓, exact names + the fix on a ✗.
  if (c.feature_registry) {
    const fr = c.feature_registry;
    const cnt = (k) => (fr.counts && fr.counts[k] ? fr.counts[k].wired + ' wired / ' + fr.counts[k]['on-request'] + ' on-request / ' + fr.counts[k].dormant + ' dormant' : '');
    const warn = [(fr.stale || []).length ? (fr.stale.length + ' stale classification(s) — regenerate') : '', (fr.dormant_without_note || []).length ? fr.dormant_without_note.length + ' dormant without a note' : '', (fr.unverifiable || []).length ? fr.unverifiable.length + ' unverifiable here (command-center/ absent)' : ''].filter(Boolean).join(' · ');
    const detail = fr.applicable === false ? 'n/a — ' + fr.reason
      : (fr.ok && !fr.overridden ? (fr.entries || 0) + ' entries · tools ' + cnt('tool') + ' · skills ' + cnt('skill') + (warn ? ' · ' + warn : '')
        : fr.reason + (fr.fix ? ' · fix: ' + fr.fix : ''));
    out.push(line('feature registry', fr.ok, detail + overrideTag(fr)));
  }
  // part ii: skill_frontmatter, ENFORCED in the development tree; outside it the findings are still printed.
  if (c.skill_frontmatter) {
    const sf = c.skill_frontmatter;
    const clean = (sf.failing || []).length === 0 && !(sf.applicable && sf.catalog && sf.catalog.applicable && !sf.catalog.checked);
    const detail = clean ? (sf.checked || 0) + ' skill(s) · frontmatter readable · descriptions quoted where needed · forge-* skills catalogued' + (sf.applicable ? '' : ' (not enforced outside the development tree)')
      : sf.reason;
    out.push(line('skill frontmatter', sf.ok, detail + overrideTag(sf)));
  }
  // ALWAYS printed (like context_budget below) — this is informational every run, not
  // only on a problem, and 'not-installed' is the NORMAL case for an ordinary project (never a ✗, never
  // part of the ALL GREEN / FAILURES verdict).
  if (rep.advisory && rep.advisory.command_center_location) {
    const ccl = rep.advisory.command_center_location;
    const detail = ccl.location === 'project-local' ? 'project-local at ' + ccl.path
      : ccl.location === 'central' ? 'central (shared) install at ' + ccl.path
      : 'not installed for this project (normal — most projects have none; "forge dashboard" installs/builds it on demand)';
    out.push('  ' + (ccl.location === 'not-installed' ? 'ℹ' : '✓') + ' command center (advisory): ' + detail);
  }
  // Advisory (never fails the doctor, never part of the ALL GREEN / FAILURES verdict above) — printed as a
  // WARN line, distinct from the ✓/✗ check lines, so it can never be mistaken for a blocking result.
  if (rep.advisory && rep.advisory.backfill_continuity) {
    const bc = rep.advisory.backfill_continuity;
    if (bc.warnings && bc.warnings.length) {
      out.push('  ⚠ backfill continuity (advisory, non-blocking): ' + bc.warnings.length + ' WARNING(S): '
        + bc.warnings.map((w) => w.agent + ' in ' + w.run + ' (expected ' + w.expected + ', found ' + w.found + ')').join('; '));
    } else {
      out.push('  ✓ backfill continuity (advisory): ' + bc.applicableRuns + '/' + bc.checkedRuns + ' run(s) use dispatch_id · consistent');
    }
  }
  // run-liveness advisory: a ledger that still claims "running" while the events
  // prove otherwise. Same WARN-line posture as backfill continuity above: never a ✓/✗ check line, never part
  // of the ALL GREEN / FAILURES verdict. The detail is capped at 3 named runs + a count so a project with a
  // long history of stale ledgers still prints one readable line.
  if (rep.advisory && rep.advisory.run_liveness) {
    const rl = rep.advisory.run_liveness;
    const fs_ = rl.findings || [];
    if (fs_.length) {
      const hrs = (ms) => (ms == null ? 'unknown' : Math.round(ms / 3600000) + 'h');
      // WP-DOC-ADV: live findings (silent < 7d) are listed by name; abandoned ones (>= 7d) are only counted.
      const live = fs_.filter((f) => !f.abandoned);
      const abandonedN = fs_.length - live.length;
      const shown = live.slice(0, 3).map((f) => f.run_id + ' (' + f.kind + ', silent ' + hrs(f.silent_ms) + ')');
      const abandonedPart = abandonedN ? abandonedN + ' abandoned (>7d, close or archive them)' : '';
      const livePart = live.length
        ? live.length + ' run(s) still marked running but proven not alive: ' + shown.join('; ') + (live.length > 3 ? '; +' + (live.length - 3) + ' more' : '')
        : '';
      out.push('  ⚠ run liveness (advisory, non-blocking): ' + [livePart, abandonedPart].filter(Boolean).join(' · '));
    } else {
      out.push('  ✓ run liveness (advisory): ' + rl.checked + ' run(s) claiming "running" checked · '
        + (rl.reason || 'each one is genuinely alive or honestly closed'));
    }
  }
  // one compact context-budget line. ALWAYS printed (unlike the failure-only advisories above):
  // the whole point is that the number is visible every run, because the failure mode being guarded is
  // silent growth — a line that only appears once a threshold is already crossed would restore exactly the
  // blindness this check exists to remove. The word "est." is in the line itself, not only in the JSON.
  if (rep.advisory && rep.advisory.context_budget) {
    const cbd = rep.advisory.context_budget;
    // the per-source skill breakdown is rendered by forge-contextbudget's own skillSourceLine() so the doctor
    // line and the tool's CLI can never quote different numbers (2026-08-01: the meter counted only this
    // project's 57 skills while the session carries 278, and the doctor line repeated that figure as if it
    // were the whole surface — one number, one renderer, from now on).
    const breakdown = (contextBudgetTool && typeof contextBudgetTool.skillSourceLine === 'function')
      ? contextBudgetTool.skillSourceLine(cbd) : '';
    const head = (cbd.total_approx_tokens || 0) + ' est. tokens always-loaded across ' + ((cbd.posts || []).length)
      + ' post(s)' + (breakdown ? ' · ' + breakdown : '');
    const fnd = cbd.findings || [];
    if (fnd.length) {
      out.push('  ⚠ context budget (advisory, non-blocking): ' + head + ' · ' + fnd.length + ' finding(s): '
        + fnd.slice(0, 3).map((f) => f.detail).join(' · ') + (fnd.length > 3 ? ' · +' + (fnd.length - 3) + ' more' : ''));
    } else {
      const notes = (cbd.notes || []).map((n) => n.detail);
      out.push('  ✓ context budget (advisory): ' + head + ' · ' + (cbd.reason || 'within baseline')
        + (notes.length ? ' · ' + notes.join(' · ') : ''));
    }
  }
  // wp-v3 (sec-v1r, item 4): forge-gate-hook.cjs's own super-linear-DoS protection depends on
  // forge-gate-watchdog.cjs/worker_threads loading — visible every run, never silent, never a hard failure
  // (the fallback itself is safe). See gateWatchdogHealth() above.
  if (rep.advisory && rep.advisory.gate_watchdog_health) {
    const gwh = rep.advisory.gate_watchdog_health;
    out.push('  ' + (gwh.ok ? '✓' : '⚠') + ' gate watchdog health (advisory' + (gwh.ok ? '' : ', non-blocking') + '): ' + gwh.detail);
  }
  // + part ii: four advisories, one line each — ⚠ on a finding, ✓/ℹ otherwise, never a ✗.
  const adv = (rep.advisory || {});
  const advLine = (label, r, okText, warnText) => {
    if (!r) return;
    if (r.applicable === false) { out.push('  ℹ ' + label + ' (advisory): n/a — ' + r.reason); return; }
    out.push('  ' + (r.ok ? '✓ ' : '⚠ ') + label + (r.ok ? ' (advisory): ' + okText : ' (advisory, non-blocking): ' + warnText));
  };
  if (adv.scribe_wiring) advLine('scribe wiring', adv.scribe_wiring, 'both hooks wired · FORGE_SCRIBE.json parses · .claude/forge-scribe/ gitignored' + ((adv.scribe_wiring.notes || []).length ? ' · ' + adv.scribe_wiring.notes.join(' · ') : ''), adv.scribe_wiring.reason);
  if (adv.unpublished) {
    const up = adv.unpublished;
    if (up.applicable === false) out.push('  ℹ unpublished (advisory): n/a — ' + up.reason);
    else if (up.unpublished) out.push('  ⚠ unpublished (advisory, non-blocking): ' + up.summary);
    else out.push('  ' + (up.verified ? '✓' : 'ℹ') + ' unpublished (advisory): ' + up.reason);
  }
  if (adv.structure) {
    const st = adv.structure, f = st.findings || {};
    const parts = [];
    if ((f.tools_without_test || []).length) parts.push(f.tools_without_test.length + ' tool(s) without a test: ' + f.tools_without_test.slice(0, 5).join(', ') + (f.tools_without_test.length > 5 ? ', +' + (f.tools_without_test.length - 5) : ''));
    if ((f.oversize || []).length) parts.push(f.oversize.length + ' new file(s) over 800 lines: ' + f.oversize.slice(0, 4).join(', '));
    if ((f.readme_missing || []).length) parts.push('README tool table misses ' + f.readme_missing.join(', '));
    if ((f.readme_extra || []).length) parts.push('README names missing tool(s) ' + f.readme_extra.join(', '));
    if ((f.skill_registry_missing || []).length) parts.push('skill registry misses ' + f.skill_registry_missing.join(', '));
    if ((f.skill_registry_extra || []).length) parts.push('skill registry names missing skill(s) ' + f.skill_registry_extra.join(', '));
    if ((f.root_clutter || []).length) parts.push('root clutter: ' + f.root_clutter.join(', '));
    if (f.no_remote) parts.push('this repository has NO git remote — nothing reaches GitHub');
    advLine('structure', st, 'every tool has a test · no new oversized file · README and skill registry match the disk · root clean · remote configured', parts.join(' · '));
  }
  if (adv.always_loaded_budget) {
    const ab = adv.always_loaded_budget;
    const sizes = (ab.files || []).map((x) => x.file.split('/').slice(-2).join('/') + ' ' + (x.bytes == null ? 'absent' : x.bytes + ' B' + (x.over ? ' OVER' : ''))).join(', ');
    advLine('always-loaded budget', ab, sizes + ' (budget ' + ab.budget + ' B each)', sizes + ' — over the ' + ab.budget + ' B budget: move detail into .claude/docs/forge-reference/');
  }
  // WAVE A / A2 + V9-INTEGRATE: one compact "completeness" advisory line for the
  // checks that remain advisory-only — never folded into ALL GREEN/FAILURES. unregistered_event/
  // check_the_checks moved OUT of this block — they are now ordinary ✓/✗ checks-lines above,
  // since they were promoted to ENFORCED (see the header doc's "V9-INTEGRATE enforcement" note).
  if (rep.advisory && rep.advisory.completeness) {
    const cm = rep.advisory.completeness;
    const parts = [];
    if (cm.sync_completeness && !cm.sync_completeness.ok) parts.push('sync-completeness: ' + (cm.sync_completeness.missing ? cm.sync_completeness.missing.length + ' file(s) not in FILES manifest' : (cm.sync_completeness.reason || 'unavailable')));
    if (cm.memory_discipline && !cm.memory_discipline.ok) parts.push('memory-discipline: ' + (cm.memory_discipline.reason || 'unfilled placeholder(s)'));
    if (cm.mcp_dormancy && !cm.mcp_dormancy.ok) parts.push('mcp-dormancy: ' + (cm.mcp_dormancy.violations ? cm.mcp_dormancy.violations.length + ' violation(s)' : (cm.mcp_dormancy.reason || 'unavailable')));
    if (cm.quality_catalog && !cm.quality_catalog.ok) parts.push('quality-catalog: ' + (cm.quality_catalog.reason || 'drift'));
    if (cm.skill_evals && !cm.skill_evals.ok) {
      const se = cm.skill_evals;
      const failNames = (se.skills || []).filter((s) => !s.ok).map((s) => s.error ? (s.skill + ' (config error: ' + s.error + ')') : (s.skill + ' (' + s.failed + '/' + s.total + ' assertion(s) failed: ' + s.results.filter((r) => !r.ok).map((r) => r.id).join(', ') + ')'));
      parts.push('skill-evals: ' + (failNames.length ? failNames.join('; ') : (se.reason || 'unavailable')));
    }
    // wp-disclosure-ab: skill_hygiene's clean-branch text carries a REAL count ("skill hygiene
    // N/M") rather than a static phrase, per the work package's requested format — computed once so it is
    // available to whichever branch below actually fires. An unhealthy result still names the failing
    // skill(s) in `parts`, the exact same convention every other completeness sub-check above already uses.
    let skillHygieneCleanText = '';
    if (cm.skill_hygiene) {
      const sh = cm.skill_hygiene;
      if (!sh.ok) {
        const failNames = (sh.skills || []).filter((s) => !s.ok).map((s) => s.skill + ' (' + s.issues.join('; ') + ')');
        parts.push('skill-hygiene: ' + (failNames.length ? failNames.join('; ') : (sh.reason || 'unavailable')));
      } else {
        skillHygieneCleanText = ' · skill hygiene ' + sh.skills.filter((s) => s.ok).length + '/' + sh.checked;
      }
    }
    out.push(parts.length
      ? '  ⚠ completeness (advisory, non-blocking): ' + parts.join(' · ')
      : '  ✓ completeness (advisory): sync manifest complete · memory populated · mcp dormant/least-privilege · skill evals green' + skillHygieneCleanText);
  }
  // one line per beginner-setup check, ALWAYS printed (a beginner reads these for the info
  // as much as for the warnings). ⚠ = warn, ℹ = info/note, ✓ = ok / not applicable — never a ✗, never in the
  // verdict. `note` (wp-l1, loop iteration 1: settings-wired) is the same non-judgmental ℹ treatment as
  // `info` — "could not compare" is not a warning, it is a fact about what data was available.
  if (rep.advisory && rep.advisory.beginner_setup && rep.advisory.beginner_setup.checks) {
    for (const bc of Object.values(rep.advisory.beginner_setup.checks)) {
      const warn = bc.level === 'warn' && !bc.overridden;
      const icon = warn ? '⚠' : ((bc.level === 'info' || bc.level === 'note') ? 'ℹ' : '✓');
      out.push('  ' + icon + ' setup ' + bc.id + (warn ? ' (advisory, non-blocking): ' : ' (advisory): ') + (bc.level === 'n-a' ? 'n/a — ' : '') + bc.detail + overrideTag(bc));
      if (Array.isArray(bc.lines)) for (const l of bc.lines) out.push('      │ ' + l);
    }
  }
  out.push(rep.ok ? '  ⇒ ALL GREEN' : '  ⇒ FAILURES ABOVE');
  return out.join('\n');
}

module.exports = { failingTestNames, FAIL_NAMES_MAX,
  // WP-SPD-B — in-process .cjs parse that lets nodeCheckAll skip a spawn for a file that parses
  syntaxCheckInProcess,
  nodeCheckAll, runTests, strictEventCheck, spaPresent, leakScan, agentsCheck, modelRoutingCheck, chainCheck, rebindingGuard, commandCenterLocation, backfillContinuity, runDoctor, printSummary, secretLabel, parseFrontmatter, parseToolsList, loadToolPolicy, BOSS_NAMES, looksLikeRealSecret, secretPortion, STRONG_PLACEHOLDER_RE, isPatternDefinitionContext, parseEventsJsonlLenient, chainCanon, PATTERN_DEFINITION_PATHS, LEAK_SCAN_MAX_BYTES, LEAK_SCAN_MAX_LINE,
  // N5 (2026-09-26 laptop re-audit) — class-aware `memory:` frontmatter requirement (see its own doc comment)
  memoryAllowedForClass,
  // the add-only agent-tool-policy.user.json overlay
  loadToolPolicyOverlay, mergeToolPolicyOverlay,
  // per-suite time limit (1500 s default since WP-LIMITS, FORGE_DOCTOR_SUITE_TIMEOUT_MS override); see runTests()
  DOCTOR_SUITE_TIMEOUT_MS,
  // WP-SPD-C — the suite pool (forge-suite-pool.cjs), its size and the longest-first ordering hints
  DOCTOR_SUITE_JOBS, SUITE_POOL_FILE, SUITE_DURATIONS_FILE, resolveSuiteJobs, suiteOrder, suiteRootKey, readSuiteDurations, runSuitesPooled,
  // WP-TMP-HYGIENE — the sequential suite spawn with a private, always-removed temp folder
  runSuiteSequential,
  // nested-repository discovery + per-source accounting for the leak scan (see nestedGitRepos)
  trackedFiles, nestedGitRepos, gitLsFiles, NESTED_REPO_MAX_DEPTH, TEST_FIXTURE_RE,
  // WP-SYNC-R8 — agent worktree checkouts are never descended into (discovery or the gitless walk)
  isAgentWorktreesDir, hasGitEntry, // WP-SYNC-R10: the gitless walk skips only children holding a .git entry
  // WAVE A / A2 — doctor completeness checks
  listSkillFiles, syncCompleteness, countAssertionSites, checkTheChecks, memoryDiscipline, MEMORY_PLACEHOLDER_RE,
  // (2026-09-26 laptop re-audit) — vacuous boolean-t-helper call-site scan, folded into checkTheChecks
  vacuousBooleanTHelperSites, classifyTHelper, splitTopLevelArgs, findMatchingBrace, BARE_FN_LITERAL_HEAD_RE, T_HELPER_DEF_RE, maskStringAndTemplateLiterals,
  // DOCTOR-1 fix (Codex adversarial-review, MEDIUM) — literal-aware structural scan + the behavioural
  // companion check for rebindingGuard(), now wired into runDoctor() via rebindingGuardCombined()
  // (Lead review round 2).
  maskRegexLiterals, REGEX_PRECEDING_KEYWORDS, rgStripForStructuralScan, rebindingGuardBehavioral,
  rebindingGuardCombined, REBINDGUARD_RUNNER_TIMEOUT_MS, REBINDGUARD_RUNNER_FILE,
  extractKnownEventTypesFromSource, stripJsComments, extractLoggedEventTypes, unregisteredEvent, ASSERTION_SITE_RE, EVENT_TYPE_SHAPE_RE,
  // WAVE G / G-INTEGRATE
  mcpDormancy,
  // V9-INTEGRATE — run-contract wiring + the enforcement-override recovery path
  latestRunIdFor, runContractDoctorCheck, loadDoctorCheckOverrides, applyDoctorOverride,
  // dispatched-run-only picker + its shared ranking core (see doc comments above)
  rankRunCandidates, latestDispatchedRunIdFor,
  // the ENFORCED run_contract check (see the "run_contract — ENFORCED" block doc)
  RUN_CONTRACT_ENFORCED_SINCE, genuineRunCandidates, isGenuineRunDir, judgeRunForDoctor, runContractSummary,
  // F01 cutoff reader, F05 event-time reader, F07 claim scan helper
  completionProofCutoff, eventTimeMs, completionClaimOf,
  // wp-skill-evals — per-skill binary-evals wiring, advisory-only (see doc comment above)
  skillEvalsDoctorCheck,
  // wp-disclosure-ab — progressive-disclosure hygiene, advisory-only (see doc comment above)
  skillHygiene, extractSkillPathRefs, SKILL_DESCRIPTION_MAX_CHARS, SKILL_BODY_MAX_LINES,
  // which tree is this? (installation-pinned assertions ask before they assert; never a check)
  installationProfile, detectVendorPin,
  // forge-runwatch.cjs wired in as an automatic advisory (see doc comment above)
  runLiveness, LIVENESS_WINDOW_MS, LIVENESS_RUNNING_STATUSES, LIVENESS_ABANDONED_MS,
  // F-23 (Codex herreview quality-laag) — geëxporteerd zodat de quality-suite dit als GEDRAG test (kale root => ok:false), niet als bron-regex
  qualityCatalogDoctorCheck,
  // forge-contextbudget.cjs wired in as an automatic advisory (see contextBudgetCheck above)
  contextBudgetCheck,
  // beginner setup advisories + the dev-tree marker behind installationProfile()
  beginnerSetup, claudeMdSize, pathTools, bypassMode, wslMntC, claudeDoctorProbe, promptCoachPresent,
  resolveOnPath, readDevTreeMarker, DEV_TREE_MARKER_REL, CLAUDE_MD_MAX_LINES, BEGINNER_PATH_TOOLS,
  TOOL_VERSION_TIMEOUT_MS, CLAUDE_DOCTOR_TIMEOUT_MS, CLAUDE_DOCTOR_MAX_LINES,
  // wp-l1 (loop iteration 1) — settings-wired beginner-setup check
  settingsWired, settingsTemplatePath,
  // wp-l4 (loop iteration 4) — model-choice-hint beginner-setup check
  modelChoiceHint,
  // the claude-version advisory folded into path-tools
  claudeVersionAdvisory, parseVersionTriple, compareVersionTriples, CLAUDE_VERSION_ADVISORY_MIN,
  // wp-v4 (sec-v3 L2) — the real hook end-to-end health check + the dependency file list it resolves
  gateWatchdogHealth, GATE_HOOK_DEPENDENCY_FILES, buildIsolatedGateProject,
  // (prd-w2-discipline M2) — release-exclusions wiring (see doc comments above)
  releaseExclusionsCheck, looksLikeDistRepo, DIST_REPO_MARKERS,
  // the enforced shipping-manifest check (see its doc comment)
  shipManifestCheck,
  // + part ii — feature registry + skill frontmatter (enforced) and four advisories
  featureRegistryCheck, skillFrontmatterCheck, skillDescriptionIssues, scribeWiring, unpublishedCheck, structureCheck,
  alwaysLoadedBudget, ALWAYS_LOADED_BUDGET_BYTES, ALWAYS_LOADED_FILES, FEATURE_REGISTRY_FIX,
};

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    /** 2026-09-23 (external audit II-G): --help used to be an unknown flag that fell through into the FULL
     *  multi-minute doctor (and with --run it even wrote doctor.json and logged an event). Help is a
     *  no-op by contract: usage on stdout, exit 0, nothing measured, nothing written. A mistyped flag
     *  likewise refuses instead of silently starting a self-test the caller did not ask for. */
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log('Usage: node forge-doctor.cjs [--root <projectDir>] [--run <run_id>] [--json]');
      console.log('');
      console.log('  Runs the full Forge self-test: every *.test.cjs suite, the leak scan, agent/hook/event checks.');
      console.log('  Takes several minutes. --json prints exactly one JSON report object; --run also writes');
      console.log('  doctor.json into that run and logs a doctor_run event. --help never runs anything.');
      return;
    }
    const bekend = new Set(['--root', '--run', '--json']);
    const onbekend = argv.filter((a, i) => a.startsWith('-') && !bekend.has(a) && !(i > 0 && (argv[i - 1] === '--root' || argv[i - 1] === '--run')));
    if (onbekend.length) {
      console.error('forge-doctor: unknown flag(s) ' + onbekend.join(' ') + ' — see --help. Refusing to start a multi-minute self-test on a mistyped flag.');
      process.exitCode = 2;
      return;
    }
    let root = path.resolve(__dirname, '..', '..'), run = null, wantJson = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--root') root = argv[++i];
      else if (argv[i] === '--run') run = argv[++i];
      else if (argv[i] === '--json') wantJson = true;
    }
    // the CLI is the one caller that runs the read-only `claude doctor` probe (5 s cap, stdin closed).
    const rep = runDoctor(root, { probeClaudeDoctor: true });
    // --json is a machine-readable CONTRACT: exactly ONE JSON object on stdout, nothing else — so a
    // consumer (e.g. forge-sync.cjs) can demand positive evidence instead of trusting only the exit code.
    // Without --json, keep the existing human-readable summary as the default.
    if (wantJson) console.log(JSON.stringify(rep, null, 2));
    else console.log(printSummary(rep));
    if (run && /^[A-Za-z0-9_-]+$/.test(run)) {
      const runDir = path.join(root, '.claude', 'forge-runs', run);
      try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify(rep, null, 2) + '\n', 'utf8'); } catch (e) { console.error('forge-doctor: could not write doctor.json: ' + e.message); }
      const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
      const ev = spawnSync(NODE, [le, run, 'doctor_run', JSON.stringify({ agent: 'reviewer', note: 'forge-doctor ' + (rep.ok ? 'ALL GREEN' : 'FAILURES'), ok: rep.ok })], { encoding: 'utf8' });
      if (ev.status !== 0) console.error('forge-doctor: log-event warning: ' + (ev.stderr || '').trim());
    }
    process.exitCode = rep.ok ? 0 : 1;
  };
  try { main(); } catch (e) { console.error('forge-doctor: ' + e.message); process.exitCode = 1; }
}
