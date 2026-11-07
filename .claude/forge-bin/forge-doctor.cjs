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
 * report.advisory: scribe_wiring, unpublished, structure, always_loaded_budget; WP 3.7 added plugin_validate; +
 * added skill_lint and agent_lint; (wired in package 2.9e) added config_scan and
 * harness_score. SA-P1B-DOCTOR: skill_adapters (adapterSmokeCheck, doctor/checks-adapters.cjs: the graphify
 * and watch adapters run while their skill is installed) is ENFORCED in the development tree, labelled elsewhere. W2-WIRE
 * ecc_path and citations (doctor/checks-tools.cjs: the ECC skill resolver and the citation matcher still do
 * their one job) are ENFORCED the same way.)
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
 *
 * MODULES (WP A11 part 2): the checks live in doctor/*.cjs (DOCTOR_MODULES below lists them in order);
 * this file is the composition root — the CLI, the ordered check tables runDoctor() evaluates, and the public
 * module.exports, which re-exports every name the checks export so every caller keeps requiring this file.
 * forge-sync delivers doctor/*.cjs with the rest of forge-bin (FORGE_SHIP_MANIFEST.json rule for doctor/).
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { NODE, stateWriteDir } = require('./doctor/context.cjs');
const {
  DOCTOR_SUITE_JOBS, FAIL_NAMES_MAX, SUITE_DURATIONS_FILE, SUITE_POOL_FILE, failingTestNames, nodeCheckAll,
  readSuiteDurations, resolveSuiteJobs, runSuiteSequential, runSuitesPooled, runTests, spaPresent, strictEventCheck,
  suiteOrder, suiteRootKey, syntaxCheckInProcess,
} = require('./doctor/checks-core.cjs');
const {
  LEAK_SCAN_MAX_BYTES, LEAK_SCAN_MAX_LINE, NESTED_REPO_MAX_DEPTH, PATTERN_DEFINITION_PATHS, STRONG_PLACEHOLDER_RE,
  TEST_FIXTURE_RE, gitLsFiles, hasGitEntry, isAgentWorktreesDir, isPatternDefinitionContext, leakScan,
  looksLikeRealSecret, nestedGitRepos, secretLabel, secretPortion, trackedFiles,
} = require('./doctor/checks-leak.cjs');
const {
  BOSS_NAMES, agentsCheck, chainCanon, chainCheck, loadToolPolicy, loadToolPolicyOverlay, memoryAllowedForClass,
  mergeToolPolicyOverlay, modelRoutingCheck, parseEventsJsonlLenient, parseFrontmatter, parseToolsList,
} = require('./doctor/checks-agents.cjs');
const {
  REBINDGUARD_RUNNER_FILE, REBINDGUARD_RUNNER_TIMEOUT_MS, backfillContinuity, commandCenterLocation, rebindingGuard,
  rebindingGuardBehavioral, rebindingGuardCombined, rgStripForStructuralScan,
} = require('./doctor/checks-rebind.cjs');
const {
  EVENT_TYPE_SHAPE_RE, MEMORY_PLACEHOLDER_RE, extractKnownEventTypesFromSource, extractLoggedEventTypes,
  listSkillFiles, mcpDormancy, memoryDiscipline, stripJsComments, syncCompleteness, unregisteredEvent,
} = require('./doctor/checks-completeness.cjs');
const {
  ASSERTION_SITE_RE, BARE_FN_LITERAL_HEAD_RE, REGEX_PRECEDING_KEYWORDS, T_HELPER_DEF_RE, checkTheChecks,
  classifyTHelper, countAssertionSites, findMatchingBrace, maskRegexLiterals, maskStringAndTemplateLiterals,
  splitTopLevelArgs, vacuousBooleanTHelperSites,
} = require('./doctor/checks-testscan.cjs');
const {
  RUN_CONTRACT_ENFORCED_SINCE, completionClaimOf, completionProofCutoff, eventTimeMs, genuineRunCandidates,
  isGenuineRunDir, judgeRunForDoctor, latestDispatchedRunIdFor, latestRunIdFor, qualityCatalogDoctorCheck,
  rankRunCandidates, runContractDoctorCheck, runContractSummary, skillEvalsDoctorCheck,
} = require('./doctor/checks-runs.cjs');
const {
  DIST_REPO_MARKERS, FEATURE_REGISTRY_FIX, SKILL_BOOLEAN_KEYS, SKILL_LISTING_ENTRY_MAX_CHARS, featureRegistryCheck,
  frontmatterScalarText, looksLikeDistRepo, releaseExclusionsCheck, shipManifestCheck, skillDescriptionIssues,
  skillFrontmatterCheck,
} = require('./doctor/checks-ship.cjs');
const {
  ALWAYS_LOADED_BUDGET_BYTES, ALWAYS_LOADED_FILES, HARNESS_MIN, LIVENESS_ABANDONED_MS, LIVENESS_RUNNING_STATUSES,
  LIVENESS_WINDOW_MS, PLUGIN_DIST_REL, PLUGIN_VALIDATE_TIMEOUT_MS, advisorySafe, agentLint, alwaysLoadedBudget,
  globalForgeHandover, configScan, harnessScore, lintSummary, pluginValidate, runLiveness, scribeWiring, skillLint, structureCheck,
  unpublishedCheck,
} = require('./doctor/checks-advisory.cjs');
const {
  DEV_TREE_MARKER_REL, SKILL_BODY_MAX_LINES, SKILL_DESCRIPTION_MAX_CHARS, detectVendorPin, extractSkillPathRefs,
  installationProfile, readDevTreeMarker, skillHygiene,
} = require('./doctor/checks-hygiene.cjs');
const { applyDoctorOverride, loadDoctorCheckOverrides } = require('./doctor/overrides.cjs');
const { adapterSmokeCheck } = require('./doctor/checks-adapters.cjs');
const { eccPathCheck, citationsCheck } = require('./doctor/checks-tools.cjs');
const {
  GATE_HOOK_DEPENDENCY_FILES, buildIsolatedGateProject, contextBudgetCheck, gateWatchdogHealth,
} = require('./doctor/checks-gate.cjs');
const {
  BEGINNER_PATH_TOOLS, CLAUDE_DOCTOR_MAX_LINES, CLAUDE_DOCTOR_TIMEOUT_MS, CLAUDE_MD_MAX_LINES,
  CLAUDE_VERSION_ADVISORY_MIN, TOOL_VERSION_TIMEOUT_MS, beginnerSetup, bypassMode, claudeDoctorProbe, claudeMdSize,
  claudeVersionAdvisory, compareVersionTriples, modelChoiceHint, parseVersionTriple, pathTools, promptCoachPresent,
  resolveOnPath, safeCheck, settingsTemplatePath, settingsWired, wslMntC,
} = require('./doctor/checks-setup.cjs');
const { printSummary } = require('./doctor/report.cjs');

// forge-sync.test.cjs reads this literal from this file's source to compare its own mirror (case 156d); the value is
// owned by doctor/checks-core.cjs and forge-doctor.test.cjs asserts the two are equal.
const DOCTOR_SUITE_TIMEOUT_MS = 1500000;

// WP 2.1: the CLI finds its default root through forge-paths.cjs, a SOFT sibling dependency (doctor/context.cjs loads
// the same module for the checks; require() returns the one cached instance). Loaded here too so the CLI's marked
// "forge-paths fallback" line below stays a guarded fallback in the plugin path scan.
let forgePathsTool = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.stateDir === 'function' && typeof fp.resolveExisting === 'function' && typeof fp.memoryFile === 'function' && typeof fp.scriptRoot === 'function') forgePathsTool = fp; } catch { forgePathsTool = null; }

/** DOCTOR_MODULES — the doctor/*.cjs modules in load order (README "Doctor modules"). */
const DOCTOR_MODULES = Object.freeze(["doctor/context.cjs","doctor/checks-core.cjs","doctor/checks-leak.cjs","doctor/checks-agents.cjs","doctor/checks-rebind.cjs","doctor/checks-completeness.cjs","doctor/checks-testscan.cjs","doctor/checks-runs.cjs","doctor/checks-ship.cjs","doctor/checks-adapters.cjs","doctor/checks-tools.cjs","doctor/checks-advisory.cjs","doctor/checks-hygiene.cjs","doctor/overrides.cjs","doctor/checks-gate.cjs","doctor/checks-setup.cjs","doctor/report.cjs"]);

// ===========================================================================================================
// THE ORDERED CHECK TABLES (WP A11 part 2). runDoctor() used to build its report from three object
// literals; the same rows now live in three ordered tables, evaluated top to bottom in exactly the old order (a
// row may have side effects, e.g. strict_events writes and removes a throwaway run, so the order is part of the
// contract). Every row receives one context object c = {root, o, testsResult, overrideMap}. DOCTOR_CHECK_ORDER
// exports the key order of all three tables; forge-doctor.test.cjs pins it against a snapshot so a lost,
// duplicated or reordered check fails a test instead of silently changing the doctor.
// ===========================================================================================================
const ENFORCED_CHECKS = {
  node_check: ({ root }) => nodeCheckAll(root),
  tests: ({ testsResult }) => testsResult,
  strict_events: ({ root }) => strictEventCheck(root),
  dashboard_spa: ({ root }) => spaPresent(root),
  leak_scan: ({ root }) => leakScan(root),
  agents: ({ root }) => agentsCheck(root),
  chain: ({ root }) => chainCheck(root),
  rebinding_guard: ({ root }) => rebindingGuardCombined(root),
  // V9-INTEGRATE: promoted from advisory-only to ENFORCED — see the header doc's
  // "V9-INTEGRATE enforcement" note above for exactly why these two (and no others) were safe to promote.
  // Recoverable via FORGE_HARD_RULES.json's doctor_check_overrides (loadDoctorCheckOverrides()/
  // applyDoctorOverride() in doctor/overrides.cjs) if a genuine false-red ever surfaces.
  unregistered_event: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'unregistered_event', unregisteredEvent(root)),
  check_the_checks: ({ root, overrideMap, testsResult }) => applyDoctorOverride(overrideMap, 'check_the_checks', checkTheChecks(root, testsResult)),
  // (prd-w2-discipline M2): ENFORCED from day one (not promoted later like the two
  // above) — see releaseExclusionsCheck()'s own doc for exactly what it does and does not check.
  release_exclusions: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'release_exclusions', releaseExclusionsCheck(root)),
  // GOAT model routing: ENFORCED from day one — see modelRoutingCheck() (doctor/checks-agents.cjs).
  model_routing: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'model_routing', modelRoutingCheck(root)),
  // the shipping manifest, ENFORCED from day one in the development tree (n/a elsewhere) —
  // see shipManifestCheck() (doctor/checks-ship.cjs).
  ship_manifest: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'ship_manifest', shipManifestCheck(root)),
  // promoted from advisory.completeness to ENFORCED — red only when the newest run claimed
  // completion over an unmet completion sequence, skipped finalize, or holds a STALE receipt; see the
  // "run_contract — ENFORCED" block doc above runContractDoctorCheck() (doctor/checks-runs.cjs).
  run_contract: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'run_contract', runContractDoctorCheck(root)),
  // every tool and skill is registered, and a `wired` one really has a wired caller —
  // ENFORCED in the development tree, n/a elsewhere. See featureRegistryCheck().
  feature_registry: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'feature_registry', featureRegistryCheck(root)),
  // part ii: skill frontmatter Claude Code can actually read + every forge-* skill catalogued —
  // ENFORCED in the development tree, labelled (never red) elsewhere. See skillFrontmatterCheck().
  skill_frontmatter: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'skill_frontmatter', skillFrontmatterCheck(root)),
  skill_adapters: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'skill_adapters', adapterSmokeCheck(root)),
  // W2-WIRE: the two research tools still do their one job — see doctor/checks-tools.cjs.
  ecc_path: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'ecc_path', eccPathCheck(root)),
  citations: ({ root, overrideMap }) => applyDoctorOverride(overrideMap, 'citations', citationsCheck(root)),
};
// WAVE A / A2 + V9-INTEGRATE: the completeness checks that remain ADVISORY-ONLY, grouped
// under report.advisory.completeness so printSummary can emit a single compact advisory line — see the header doc
// comment for exactly why each one here (unlike unregistered_event/check_the_checks above) was NOT promoted to
// enforced.
const COMPLETENESS_CHECKS = {
  sync_completeness: ({ root }) => syncCompleteness(root),
  memory_discipline: ({ root }) => memoryDiscipline(root),
  // WAVE G / G-INTEGRATE: MCP-as-client safety-doctrine self-test — see mcpDormancy().
  mcp_dormancy: ({ root }) => mcpDormancy(root),
  // run_contract moved OUT of this advisory group on 2026-10-10: it is an ENFORCED `checks` entry now.
  quality_catalog: ({ root }) => qualityCatalogDoctorCheck(root),
  // wp-skill-evals: forge-skill-evals.cjs wired in, advisory-only — see skillEvalsDoctorCheck() for
  // why this FOUNDATION piece is not yet safe to enforce.
  skill_evals: ({ root }) => skillEvalsDoctorCheck(root),
  // wp-disclosure-ab: progressive-disclosure hygiene, advisory-only — see skillHygiene() for why
  // this is review signal today, not yet a build gate.
  skill_hygiene: ({ root }) => skillHygiene(root),
};
// Advisory checks are DELIBERATELY excluded from doctor.ok — see backfillContinuity's doc.
const ADVISORY_CHECKS = {
  // where (if anywhere) THIS project's own wrappers would find a Command Center —
  // project-local / central / not-installed. Always ok:true (see commandCenterLocation()'s own doc).
  command_center_location: ({ root }) => commandCenterLocation(root),
  backfill_continuity: ({ root }) => backfillContinuity(root),
  // forge-runwatch.cjs, run automatically instead of only on request — its own
  // top-level advisory key (liveness is not completeness) with its own printSummary line, exactly like
  // backfill_continuity. See runLiveness() for the window/status rules and why it stays advisory.
  run_liveness: ({ root }) => runLiveness(root),
  // the ALWAYS-LOADED instruction surface, metered. Its own top-level advisory key (a context
  // budget is not completeness) with its own printSummary line. See contextBudgetCheck().
  context_budget: ({ root }) => contextBudgetCheck(root),
  // wp-v3 (sec-v1r, item 4): visible reporting when forge-gate-hook.cjs's own super-linear-DoS protection
  // (forge-gate-watchdog.cjs / worker_threads) fails to load. See gateWatchdogHealth().
  gate_watchdog_health: ({ root }) => safeCheck('gate-watchdog-health', () => gateWatchdogHealth(root)),
  // + part ii: four advisories, each with its own printSummary line. A throw degrades to
  // an honest "could not run" (ok:true), never a crash of the whole doctor.
  scribe_wiring: ({ root }) => advisorySafe('scribe_wiring', () => scribeWiring(root)),
  unpublished: ({ root }) => advisorySafe('unpublished', () => unpublishedCheck(root)),
  // 2026-11-02 (claim guard round 3): an owner report edited after its run was sealed is judged again
  claim_sealed_drift: ({ root }) => advisorySafe('claim_sealed_drift', () => require('./forge-claim-check.cjs').sealedDriftAll({ root })),
  structure: ({ root }) => advisorySafe('structure', () => structureCheck(root)),
  always_loaded_budget: ({ root }) => advisorySafe('always_loaded_budget', () => alwaysLoadedBudget(root)),
  // Category tests F8: the personal ~/.claude/commands/forge.md must hand /forge over to this project's own command.
  global_forge_handover: ({ root }) => advisorySafe('global_forge_handover', () => globalForgeHandover(root)),
  // Category tests 2026-11-07: a modified tracked file must keep its line-ending style (Windows edits flipped 7 LF files to CRLF).
  eol_drift: ({ root }) => advisorySafe('eol_drift', () => { const r = require('./forge-eol-drift.cjs').eolDrift(root); return r.applicable ? { ok: !r.drift.length, applicable: true, drift: r.drift.slice(0, 20), fix: r.drift.length ? 'restore each file to its HEAD line endings before committing' : undefined } : { ok: true, applicable: false, reason: r.reason }; }),
  // WP 3.7: `claude plugin validate dist/forge-plugin`, only when both exist — see pluginValidate().
  plugin_validate: ({ root, o }) => advisorySafe('plugin_validate', () => pluginValidate(root, { env: o.env, platform: o.platform })),
  // skill and agent frontmatter linters in report mode — see lintSummary().
  skill_lint: ({ root }) => advisorySafe('skill_lint', () => skillLint(root)),
  agent_lint: ({ root }) => advisorySafe('agent_lint', () => agentLint(root)),
  // (wired in package 2.9e): the config scanner and the harness scorecard — see configScan() /
  // harnessScore(). Both run in-process, read-only.
  config_scan: ({ root }) => advisorySafe('config_scan', () => configScan(root)),
  harness_score: ({ root }) => advisorySafe('harness_score', () => harnessScore(root)),
  // the beginner setup traps — machine/preference findings, never a code defect, so
  // advisory by construction. The `claude doctor` probe runs only when the caller opts in (the CLI does).
  beginner_setup: ({ root, o, overrideMap }) => beginnerSetup(root, { overrideMap, env: o.env, platform: o.platform, probeClaudeDoctor: !!o.probeClaudeDoctor, claudeDoctorTimeoutMs: o.claudeDoctorTimeoutMs }),
  completeness: (c) => runCheckTable(COMPLETENESS_CHECKS, c),
};
/** runCheckTable(table, c) -> {key: result}, the rows evaluated in table order (string keys keep insertion order). */
function runCheckTable(table, c) {
  const out = {};
  for (const [key, fn] of Object.entries(table)) out[key] = fn(c);
  return out;
}
/** DOCTOR_CHECK_ORDER — the ordered key lists of the three tables (pinned by a snapshot test). */
const DOCTOR_CHECK_ORDER = Object.freeze({
  checks: Object.freeze(Object.keys(ENFORCED_CHECKS)),
  advisory: Object.freeze(Object.keys(ADVISORY_CHECKS)),
  completeness: Object.freeze(Object.keys(COMPLETENESS_CHECKS)),
});

function runDoctor(root, opts) {
  root = path.resolve(root);
  const o = opts || {};
  const testsResult = runTests(root);
  const overrides = loadDoctorCheckOverrides(root);
  const overrideMap = new Map(overrides.map((ov) => [ov.check, ov]));
  const ctx = { root, o, testsResult, overrideMap };
  const checks = runCheckTable(ENFORCED_CHECKS, ctx);
  // advisory checks are DELIBERATELY excluded from this ok computation — see backfillContinuity's doc.
  const ok = Object.values(checks).every((c) => c.ok);
  const advisory = runCheckTable(ADVISORY_CHECKS, ctx);
  return { ok, root, checks, advisory, generated_at: new Date().toISOString() };
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
  featureRegistryCheck, skillFrontmatterCheck, adapterSmokeCheck, eccPathCheck, citationsCheck, skillDescriptionIssues, SKILL_LISTING_ENTRY_MAX_CHARS, SKILL_BOOLEAN_KEYS, frontmatterScalarText, scribeWiring, unpublishedCheck, structureCheck,
  alwaysLoadedBudget, ALWAYS_LOADED_BUDGET_BYTES, ALWAYS_LOADED_FILES, FEATURE_REGISTRY_FIX,
  pluginValidate, PLUGIN_DIST_REL, PLUGIN_VALIDATE_TIMEOUT_MS,
  // the two lint advisories
  skillLint, agentLint, lintSummary, configScan, harnessScore, HARNESS_MIN,
  // WP A11 part 2 — the ordered check tables behind runDoctor (pinned by a snapshot test)
  DOCTOR_CHECK_ORDER, DOCTOR_MODULES,
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
    // WP 2.1: the default root is forge-paths scriptRoot when it is there (an installed copy: exactly the old own-folder
    // answer; a plugin copy: the project from CLAUDE_PROJECT_DIR / the cwd, never the plugin's parent folder).
    let root = null, run = null, wantJson = false;
    if (!forgePathsTool) root = path.resolve(__dirname, '..', '..'); // forge-paths fallback
    else { try { root = forgePathsTool.scriptRoot(__dirname); } catch { root = null; } }
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--root') root = argv[++i];
      else if (argv[i] === '--run') run = argv[++i];
      else if (argv[i] === '--json') wantJson = true;
    }
    if (!root) { console.error('forge-doctor: no project root found (no .claude, .forge or .git above the current folder) — pass --root <dir>'); process.exitCode = 2; return; }
    // the CLI is the one caller that runs the read-only `claude doctor` probe (5 s cap, stdin closed).
    const rep = runDoctor(root, { probeClaudeDoctor: true });
    // --json is a machine-readable CONTRACT: exactly ONE JSON object on stdout, nothing else — so a
    // consumer (e.g. forge-sync.cjs) can demand positive evidence instead of trusting only the exit code.
    // Without --json, keep the existing human-readable summary as the default.
    if (wantJson) console.log(JSON.stringify(rep, null, 2));
    else console.log(printSummary(rep));
    if (run && /^[A-Za-z0-9_-]+$/.test(run)) {
      const runDir = path.join(stateWriteDir(root, 'runs', 'forge-runs'), run); // WP 2.1: the active runs folder
      try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify(rep, null, 2) + '\n', 'utf8'); } catch (e) { console.error('forge-doctor: could not write doctor.json: ' + e.message); }
      const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
      const ev = spawnSync(NODE, [le, run, 'doctor_run', JSON.stringify({ agent: 'reviewer', note: 'forge-doctor ' + (rep.ok ? 'ALL GREEN' : 'FAILURES'), ok: rep.ok })], { encoding: 'utf8' });
      if (ev.status !== 0) console.error('forge-doctor: log-event warning: ' + (ev.stderr || '').trim());
    }
    process.exitCode = rep.ok ? 0 : 1;
  };
  try { main(); } catch (e) { console.error('forge-doctor: ' + e.message); process.exitCode = 1; }
}
