#!/usr/bin/env node
/**
 * Forge event logger — appends ONE real event to a run's events.jsonl.
 *
 * Usage:
 *   node log-event.cjs <run_id> <event_type> ['<json-extra>']
 *   node log-event.cjs '<full-json-with-run_id-and-event_type>'
 *
 * Examples:
 *   node .claude/forge-dashboard/log-event.cjs forge-2026-06-27-120000 agent_started "{\"agent\":\"Build Boss\",\"role\":\"hero\",\"dispatch_id\":\"toolu_...\",\"task\":\"build hero\"}"
 *   node .claude/forge-dashboard/log-event.cjs <run_id> agent_note "{\"agent\":\"orchestrator\",\"role\":\"lead\",\"note\":\"Selected forge-n8n; workflows/ present.\",\"evidence\":\"WORKFLOW_REGISTRY.md\"}"
 *   node .claude/forge-dashboard/log-event.cjs <run_id> agent_output "{\"agent\":\"forge-router\",\"output\":\"Project type: n8n; playbook forge-n8n.\"}"
 *
 * Event types (ENFORCED — event_type MUST be one of these; unknown names are hard-rejected under strict mode):
 *   LIFECYCLE: run_started · project_scanned · profile_loaded · memory_loaded · memory_updated · decision_logged ·
 *     agent_selected · agent_started · agent_progress · agent_completed · agent_failed · skill_loaded ·
 *     command_run · file_read · file_changed · check_started · check_passed · check_failed · report_generated · run_completed
 *   OWNER GOVERNANCE (WAVE B / B4): owner_prefs_loaded — the applied-prefs ECHO, logged once before
 *     intake by forge-bin/forge-echo.cjs::emitEcho(), summarizing which .claude/FORGE_OWNER_PROFILE.json prefs
 *     (forge-prefs.cjs) and which active config/orchestration/FORGE_STANDING_RULES.json rules (forge-standing.cjs)
 *     apply to this run, per config/orchestration/precedence.md's ordering. Informational/one-shot, like
 *     profile_loaded/memory_loaded — see forge-verify.cjs TERMINAL_TYPES for its mirrored registration (the
 *     same event-registration discipline every event type here follows; a 3rd place, forge-dashboard/app.js's
 *     taskStatus(), existed at the time this was written but was removed with the rest of the retired
 *     per-project Control Center in).
 *   config_changed — forge-bin/forge-config.cjs::diff({run}) logs ONE when an owner setting changed
 *     since the last run (changed[] + count); one-shot fact like owner_prefs_loaded, mirrored in forge-verify.cjs.
 *   VISIBLE-REASONING (NOT hidden chain-of-thought): agent_note · agent_output · agent_decision_summary · agent_next_action · agent_evidence_added
 *   SWARM EXECUTION (Lead-Agent studio): mission_packet_created · mission_blueprint_created · role_map_created ·
 *     skill_discovery · skill_map_created · custom_skill_created · skill_assigned ·
 *     agent_work_package_created · custom_subagent_created · subagent_started · subagent_completed · subagent_failed ·
 *     subagent_output_created · subagent_artifact_created · agent_artifact_created · agent_handoff ·
 *     lead_review_started · lead_review_completed · rework_task_created · rework_assigned · rework_started · rework_completed ·
 *     merge_started · merge_completed · codex_review_started · codex_review_completed · codex_finding · codex_blocked · codex_not_invoked ·
 *     fix_started · fix_completed · retest_started · retest_completed · quality_gate_passed · quality_gate_blocked · final_output_created
 *   ECC (ECC-first): ecc_inventory · ecc_blocked · ecc_agent_failed · native_fallback_used
 *   PROJECT GOVERNANCE (CLAUDE.md + project-local skills): claude_md_checked · claude_md_created · claude_md_updated · claude_md_conflict_detected ·
 *     project_skill_dir_checked · custom_skill_created · custom_skill_updated · custom_skill_used · custom_skill_skipped · custom_skill_conflict_detected
 *   SKILL REGISTRY: skill_registry_checked · skill_registry_created · skill_registry_updated · skill_registry_conflict_detected
 *   CODEX UNLOCK: codex_diagnosis_started · codex_diagnosis_completed · codex_trust_gate_detected · codex_interactive_retry_required ·
 *     codex_manual_command_created · codex_retry_started · codex_retry_completed · codex_retry_blocked (carry `reason`: trust/tty | no-git | no-output | not-available)
 *   BROWSER PROOF: browser_proof_started · browser_screenshot_captured · browser_layout_verified · browser_proof_blocked
 *   PROJECT ISOLATION: dashboard_isolation_check_started · dashboard_isolation_check_completed · dashboard_project_root_detected ·
 *     dashboard_state_project_mismatch · dashboard_state_reset_for_project · dashboard_port_selected · dashboard_health_verified · dashboard_cross_project_leak_blocked
 *   MISSION CONTROL PHASE 2 (WP1 — hardened flat-file store writer, forge-bin/forge-store.cjs): ticket_created · ticket_updated ·
 *     artifact_stored · prd_generated · mindmap_generated · deep_learn_started · deep_learn_completed · cost_sampled · doctor_run ·
 *     gate_evaluated · registry_scanned
 *   WAVE J (J1 forge-genesis.cjs, J2 forge-tournament.cjs, J3 forge-secondbrain.cjs, J4 forge-codemodel.cjs,
 *     J5 forge-briefing.cjs, J-INTEGRATE registration, 2026-07-19 — none of these 5 modules call logEvent()
 *     themselves per the shared-file rule; forward-declared here exactly like WAVE G/H so a future call site
 *     is never STRICT-REJECTED at write time): skill_proposed — forge-genesis.cjs::proposeSkill() staged a
 *     draft (never active). skill_approved — forge-genesis.cjs::approve() promoted a staged draft into
 *     `.claude/skills/` with a real owner-approval token. proposal_rejected — a staged proposal was
 *     explicitly declined by the owner (never inferred from silence). tournament_planned /
 *     tournament_scored — forge-tournament.cjs::plan()/score() produced a real best-of-N variant plan or
 *     rubric-weighted score. portfolio_scanned — forge-secondbrain.cjs::scan()/report() completed a
 *     read-only, evidence-cited cross-project portfolio scan. codemodel_built / codemodel_updated —
 *     forge-codemodel.cjs::build()/update() wrote or incrementally refreshed the living codebase index.
 *     briefing_generated — forge-briefing.cjs::generate() produced a real morning-briefing digest from a
 *     run's own manifest.json/events.jsonl.
 *   V9-INTEGRATE (P1 forge-runcontract.cjs, P2 forge-capabilities.cjs, P4 forge-projectbrain.cjs,
 *     P5 forge-scout.cjs, V9-INTEGRATE registration, 2026-07-22 — none of these 4 modules call logEvent()
 *     themselves per the shared-file rule for this wave; forward-declared here exactly like WAVE G/H/J so a
 *     future real call site is never STRICT-REJECTED at write time): research_done — a genuine research/reuse
 *     pass happened before new implementation work (CLAUDE.md "Research & Reuse" step, previously unlogged;
 *     also the ONE new run-contract rule with zero historical call sites — see FORGE_HARD_RULES.json's own
 *     _doc HONEST GAPS #1). run_contract_checked / run_contract_violated — forge-runcontract.cjs::check()
 *     resolved a run's non-negotiables to ok:true (every applicable block-rule satisfied or overridden) /
 *     ok:false (at least one applicable block-rule genuinely missing) respectively. capabilities_reported —
 *     forge-capabilities.cjs::report() produced a real capability-vs-usage inventory. scout_researched /
 *     capability_vetted — forge-scout.cjs's Search Boss/Skill Boss doctrine: a tailored-term research session
 *     completed, and a real APPROVE/HARD-PASS verdict was recorded to the persistent vetting ledger,
 *     respectively (see skills/forge-scout/SKILL.md "Events"). projectbrain_generated —
 *     forge-projectbrain.cjs::writeClaudeMd() actually wrote (created/merged/overwritten-forced) a real
 *     project CLAUDE.md.
 *   V9 (forge-bin/forge-audit-loop.cjs): the continuous AUDIT-LOOP tool's own events —
 *     audit_iteration (one real audit iteration completed; `note` carries a summary, `iteration` carries the
 *     ledger sequence number) and audit_finding (one real finding surfaced by that iteration; `category`/
 *     `severity`/`note`/`evidence` carry the finding itself, never fabricated). Only logged when the CLI is
 *     given an explicit `--run <id>` (same optional convention as forge-doctor.cjs's own `--run`/doctor_run
 *     pairing) — a plain `iterate --json` run with no --run only appends to the ledger; no event is logged.
 *   V9-fix (2026-07-22, break-swarm DEFECT 2/3 honesty-gap close-out — forge-runcontract.cjs already READS
 *     this event type from a run's events.jsonl via findOwnerOverride(), and FORGE_HARD_RULES.json's own
 *     `override` strings for every overridable rule already document its exact shape; this registration is
 *     what lets an owner actually LOG one through the strict CLI without a STRICT REFUSED, and keeps the
 *     vocabulary honestly complete): owner_override — a real, structured, attributed owner act clearing ONE
 *     named non-`cannot_override` FORGE_HARD_RULES.json rule for the current run, shaped EXACTLY
 *     `{event_type:'owner_override', rule:'<exact-rule-id>', reason:'<real, non-bare-token reason>',
 *     by:'<configured owner id>'}` — see forge-runcontract.cjs's findOwnerOverride()/isMeaningfulReason() for
 *     the full recognition contract (exact rule-id match, meaningful reason, allow-listed `by`). One-shot
 *     fact event, same taxonomy as decision_logged/manifest_armed — the event IS the completed override act.
 *   PAPERCLIP CONTROL PLANE (forge-bin/forge-paperclip.cjs, registered WAVE C / C-INTEGRATE, 2026-07-18 — these
 *     23 event types were REAL pre-existing paperclip_* events emitted by forge-paperclip.cjs's own logEvent()
 *     calls that had never been added here, tripping forge-doctor's advisory `unregistered_event` completeness
 *     check; registering them is the fix, not a new feature):
 *     paperclip_runtime_reused · paperclip_runtime_blocked · paperclip_runtime_started ·
 *     paperclip_skills_catalog_installed · paperclip_agent_instructions_set · paperclip_agent_instructions_failed ·
 *     paperclip_agent_skills_attached · paperclip_agent_skills_failed · paperclip_selected · paperclip_git_guard_warning ·
 *     paperclip_company_reused · paperclip_company_created · paperclip_goal_created · paperclip_project_created ·
 *     paperclip_workspace_bound · paperclip_agent_reused · paperclip_agent_failed · paperclip_agent_created ·
 *     paperclip_agent_docs_written · paperclip_ticket_created · paperclip_agents_paused · paperclip_agents_resumed ·
 *     paperclip_runtime_stopped
 *   REQUIRED-EVIDENCE (WAVE C / C2+C-INTEGRATE, 2026-07-18 — config/orchestration/required-evidence.json's
 *     `any_of_events` entries per domain, consumed by forge-bin/forge-evidence.cjs::check() and forge-verify.cjs's
 *     evidenceCheck(); registered here so a future Boss logging one of these real proof-facts is never
 *     STRICT-REJECTED at write time): zero_console_errors_noted · e2e_passed · e2e_result · integration_gate_passed ·
 *     validate_workflow_passed · workflow_validated · workflow_imported_inactive · robots_checked ·
 *     source_compliance_noted · citation_verified · ingestion_idempotency_verified · backtest_completed ·
 *     uncertainty_labels_applied · webhook_auth_verified · outreach_drafted_only_noted
 *   WAVE H (H1 forge-docs.cjs, H2 forge-repomap.cjs, H4 forge-beads.cjs, H-INTEGRATE registration):
 *     doc_generated — a real .docx/.xlsx/.pptx/.pdf deliverable was written (forge-docs.cjs's CLI `--run`
 *     flag, logDocEvent()); REAL pre-existing call site. repomap_generated — a repo context map was produced
 *     (forge-repomap.cjs::map()). bead_added / bead_closed — a backlog "bead" work item was created / marked
 *     done (forge-beads.cjs::add()/close()). repomap_generated and bead_added/bead_closed are registered here
 *     per the Wave-H event vocabulary but have NO current call site in forge-repomap.cjs/forge-beads.cjs (those
 *     tools do not yet log events) — forward-declared so a future `--run`/logging wire-up is never
 *     STRICT-REJECTED at write time, same allow-first-use-later posture as most of this vocabulary.
 *   REJECTED-APPROACH MEMORY (forge-bin/forge-tool-index.cjs, 2026-07-31 — mining-ronde-1 §1, see
 *     `.claude/forge-research/MINING-RONDE-1-2026-07-31.md` §1): rejected_approach — ONE real, already-made,
 *     already-evidenced decision that a specific approach was tried and rejected, so a later run does not
 *     silently repeat it. Shaped EXACTLY
 *     `{event_type:'rejected_approach', agent:'<who>', approach:'<what was tried>', reason:'<why it was
 *     rejected>', evidence:'<the proof>'}`. It is a PROOF_EVENT (see PROOF_EVENTS below): a rejected approach
 *     with no `evidence`/`output`/`command`/`output_artifact` is STRICT-REFUSED (exit 2) rather than landing
 *     as a bare assertion — "we decided X is wrong" is only memory-worthy when it says how that was
 *     established. One-shot FACT event, same taxonomy as decision_logged/lessons_harvested: the event IS the
 *     completed, proven decision, NOT an open problem — so forge-verify.cjs classifies it terminal/'done' and
 *     deliberately keeps it OUT of FINDING_EVENT_TYPES (a rejected approach must never count as a recurring
 *     finding in the loop-convergence check). forge-bin/forge-tool-index.cjs indexes these across runs and
 *     answers `tried <query>` from them.
 *   WORK-PACKAGE OUTCOMES ("pakket 1: repareer de bedrading"): wp_completed / wp_failed — the
 *     per-WP done/failed facts `forge-bin/forge-manifest.cjs`'s DONE_EVENT_TYPES/FAILED_EVENT_TYPES (L65/66)
 *     and `forge-bin/forge-briefing.cjs`'s RAN_EVENT_TYPES/BLOCKED_EVENT_TYPES (L62/66) have consumed since
 *     WAVE D — but which were never registered HERE, so under STRICT mode (the default) that entire
 *     manifest/resume/briefing chain could never receive a single real line. They are per-WP siblings of the
 *     already-registered `wp_resumed` (its "started again" counterpart, which pairs with them in
 *     forge-verify.cjs's TASK_PAIRS), never run-level BACKBONE milestones. Shape:
 *     `{event_type:'wp_completed'|'wp_failed', agent:'<who>', wp_id:'<the manifest wp_id>', ...}` — the
 *     `wp_id` is what `forge-manifest.cjs::projectManifest` matches on; without it the event still logs but
 *     flips no work package. wp_completed is BOTH a PROOF_EVENT and a PASS_ASSERTION event (see below): it
 *     must carry real proof AND must not contradict itself (a non-zero `exit_code`, or a
 *     `result`/`outcome`/`verdict`/`status` field that reads as a failure, is refused — a work package is
 *     the exact unit a manifest flips to "done", so a bare or self-contradicting completion claim is
 *     precisely the fabricated completion this file exists to stop). wp_failed is deliberately NOT
 *     proof-gated, exactly like check_failed — honest failure reporting must never be harder than a
 *     success claim.
 *   MODEL PROVENANCE: agent_model_used — the dashboard event
 *     `.claude/FORGE_MODEL_ROUTING.json`'s own `_doc` has always promised ("Forge logs the ACTUAL model used
 *     in FORGE_AGENT_LEDGER.md + a dashboard event") while no model-related event type existed at all.
 *     Records the model ONE agent actually ran on, shaped
 *     `{event_type:'agent_model_used', agent:'<registered agent>', model:'<real model id>'|null,
 *     source:'<how it was observed>', note:'...'}`. HONESTY GATE (MODEL_EVENTS below): the `model` key is
 *     MANDATORY and may be explicitly `null` when the runtime model is genuinely not observable — omitting
 *     it, blanking it, or filling in a placeholder/guess ("unknown", "default", "probably", …) is
 *     STRICT-REFUSED, and the stamp records `model_observed` either way. It is agent-name-checked (it is in
 *     WORKING_AGENT_EVENTS) but NOT dispatch-checked, so an agent can self-log its own model without
 *     knowing the parent's tool_use id.
 *   VERSION 2 RULE EVENTS (part B): the event types the
 *     config/orchestration/FORGE_HARD_RULES.json version-2 rules and lifecycle table name. Before this they were
 *     STRICT-REFUSED here, so every rule waiting for one stayed open or vacuous. Shapes:
 *     wp_verified {wp_id, verdict:'PASS'|'FAIL', agent, evidence} — the verifier's verdict on ONE work package
 *       (rules wp-verified-per-wp and escalation-one-per-fail). The verdict goes in `verdict`, never in `status`:
 *       the verifier finished its own job whatever the verdict says. Name-checked like the working events (it is
 *       in WORKING_AGENT_EVENTS, not dispatch-checked): wp-verified-per-wp decides from this `agent` who verified,
 *       so a phantom verifier is refused. Deliberately NOT a PROOF_EVENT/PASS_ASSERTION event: an honest FAIL
 *       verdict must never be refused as a contradicting pass claim.
 *     escalation {wp_id, from, to, reason:'process'|'capability'} — the ONE GOAT retry one step up after a FAIL.
 *     route_assigned {wp_id, route, model, effort, risk} — the triage route a work package was dispatched on.
 *     run_paused {reason, e.g. 'usage-limit'} / run_resumed — the run stopped / continued (rule pause-resume).
 *     session_resumed — a session continued after compaction (the snapshot re-inject logs it).
 *     gate_blocked {gate, command_digest} — a hard gate stopped an action (rule gate-blocked-resolved; the gate
 *       hook appends it).
 *     sync_completed {source_hash, target_hash, doctor_ok, preserved_ok} — a Forge sync into a project finished.
 *     owner_requirement_noted {req_id} — the owner added or changed a requirement mid-run (the scribe).
 *     All nine are mirrored in forge-bin/forge-verify.cjs (see its VERSION 2 note). The seven bookkeeping types
 *     (wp_verified, escalation, route_assigned, run_paused, run_resumed, session_resumed, gate_blocked) are also in
 *     forge-bin/forge-runcontract.cjs NON_WORK_EVENT_TYPES: logging them is not work, so a Verify Boss that logs
 *     wp_verified never becomes a "worker" and can still be the run's independent reviewer. sync_completed and
 *     owner_requirement_noted stay WORK there (a sync writes files; a new owner requirement changes what the run
 *     must deliver, so it makes an earlier review stale).
 *   RUN-START BASELINE (same work package): on EVERY run_started this writer itself stores `file_hashes` — the
 *     sha256 of each file a `file-touched` rule watches (forge-runcontract.cjs fileTouchedTargets() over this
 *     project's FORGE_HARD_RULES.json, hashed by its snapshotFileHashes(); never a second list here) — so the
 *     memory-files-touched rule has a baseline to compare against at completion. It is writer-owned: a caller-
 *     supplied file_hashes is REPLACED (a forged baseline could fake "every memory file changed") and the event is
 *     stamped `_forge_verify.file_hashes_replaced:true` (printed as FILE-HASHES-REPLACED). It can never block
 *     run_started: a missing file is recorded as null (absent at run start); an unreadable one is left OUT of
 *     file_hashes and listed in `file_hashes_unreadable` (null would mean "absent", and the file then could count
 *     as "created since"); a corrupt registry or a missing forge-runcontract.cjs gives `file_hashes_unavailable`
 *     with the reason; a project with no rules file or no file-touched rule gets no baseline fields at all.
 *     Anything other than a clean snapshot or "nothing to snapshot" prints one NOTE line on stderr (exit stays 0).
 *     the exported appendChainedLocked() applies the same baseline stamping to a run_started a
 *     library caller hands it without validateForWrite() (replaced + flagged, never trusted).
 *   COMPLETION GATE: run_completed is judged before it is written — the complete-phase run
 *     contract plus the completion_sequence steps before it (gate evidence, final-report.md, a fresh green
 *     contract proof), in-process via forge-runcontract.cjs::completionGate(). Default WARN (stderr, still
 *     written); FORGE_COMPLETION_GATE=strict refuses with exit 2 and writes nothing. In warn mode a tool failure
 *     never blocks; under strict an unavailable/empty/unevaluated verdict refuses a success claim.
 *     The writer stamps its own verdict on the written run_completed (_forge_verify.completion_gate), and
 *     forge-finalize refuses a claim stamped "warn" over a registry-declared sequence.
 *     See evaluateCompletionGate() below; the recipe itself: forge-runcontract.cjs plan --run <run_id>.
 *   SCRIBE RECONCILIATION (part ii): two bookkeeping events about the owner's
 *     requests that forge-bin/forge-scribe.cjs keeps (.claude/forge-scribe/). Both are non-work (forge-runcontract.cjs
 *     NON_WORK_EVENT_TYPES) and run milestones in the forge-verify.cjs mirror (BACKBONE + done).
 *     owner_requests_reconciled {agent, final?:false, note?} — "every captured owner request is planned, done, answered,
 *       cancelled or carried over". It is a CLAIM, so the writer checks it before writing: it recomputes `forge-scribe
 *       gate` IN-PROCESS and REFUSES the event (exit 2, nothing written, a batch refused as a whole) unless the gate is
 *       OK. FINAL IS THE DEFAULT (Codex R3 SC-05): a completion-time reconciliation also blocks on items
 *       that are done but not acked by the owner and on agent-proposed deferrals (defer-proposed) the owner has not
 *       confirmed; `final:false` is a PROGRESS-ONLY check that never satisfies the owner-requests-reconciled rule or
 *       finalize. The gate itself is recomputed from the scribe ledger + inbox (never its cache) and also blocks on an
 *       inbox prompt that never became an item, an owner op no hook prompt authorises, a broken chain and a disagreeing
 *       run-log anchor. Not opt-out with FORGE_STRICT_EVENTS=0: this is the content check of the claim itself. The SAME
 *       check runs on the library path (appendChainedLocked, SC-04): no caller can append this event unchecked. Codex R5
 *       SV-04: appendChainedLocked re-judges EVERY append under the events lock and overwrites the stamp (no reuse of an
 *       earlier verdict by object identity); a refusal there exits 2 like the CLI pre-check.
 *       Fail-safe: a project where the scribe is not in use (no forge-bin/forge-scribe.cjs, or nothing captured yet:
 *       no ledger.jsonl and no inbox.jsonl) writes the event with a NOTE; a scribe that exists but cannot be loaded or
 *       judged REFUSES. The writer stamps its own verdict as _forge_verify.scribe_gate {decision, final, ledger_head,
 *       ledger_lines, ledger_bytes, scribe_ledger_sha256, inbox_head, inbox_lines, chain_ok, counts} — the BINDING that
 *       forge-runcontract.cjs and forge-finalize.cjs re-check (stale when newer owner prompts/items exist); a caller-
 *       supplied stamp is replaced. The rule owner-requests-reconciled (FORGE_HARD_RULES.json) asks for this event.
 *     requirement_resolved {req_id, resolution:'done'|'deferred'|'rejected', reason} — one owner requirement reached
 *       its end state (the lifecycle row owner-changes-requirement); registered for that record, no content check.
 *     scribe_head {agent, note?} — Codex R3 SC-06: an ANCHOR of the scribe store in this run's hash-chained log. The
 *       scribe hook appends one after each capture while the run is active. The writer, under the events lock, stamps
 *       _forge_verify.scribe_head {ledger_lines, ledger_head, ledger_bytes, inbox_lines, inbox_head} from the project's
 *       own .claude/forge-scribe/ files (complete lines only; any caller value is replaced), so `forge-scribe
 *       verify-chain` can prove a later ledger still extends what was anchored. Refused when the scribe is not in use,
 *       when the run has no log yet, and when the run is closed (run_completed with only audit events after it, or
 *       run_finalized): an anchor never reopens or stales a finished run. Bookkeeping, never work.
 *   (back-compat: old agent_started/agent_completed/agent_output/agent_artifact_created/agent_handoff/review_started/review_completed still render.)
 * Common fields: agent, role, runtime (ecc-agent|ecc-skill|native|codex|internal), status (running|done|completed|waiting|previewing|failed|internal), task, note, output,
 *   decision_summary, next_action, evidence, files_read[], files_changed[], artifact, handoff/to, severity, iteration, custom (bool),
 *   work-package fields (mission, inputs[], allowed_actions[], not_allowed[], output_artifact, evidence_required[], handoff, success_criteria, rework_criteria),
 *   skill-routing fields (skill, skill_source: ecc-skill|forge-skill|project-local|native|internal|unavailable), and rework fields (target/to, issue, reason, required_fix).
 * WP23 heartbeat/evidence-closure fields, read by forge-verify.cjs::verifyRun() (also mirrored
 *   in the retired per-project dashboard's app.js::buildNodes() until that file was;
 *   never enforced here either way — plain optional extra fields):
 *   `wp_id` on an `agent_progress` heartbeat AND on the matching `subagent_completed`/`subagent_failed` lets
 *   the completion close that heartbeat (falls back to matching `role` when the completion has no `wp_id`);
 *   `closes_event_id` on a `fix_completed`/`check_passed` names the EARLIER event's own `event_id` it closes —
 *   only takes effect together with a non-empty `evidence` string, otherwise it is ignored with a printed
 *   advisory (no evidence / unknown event_id / forward reference) and closes nothing.
 * STATUS legend: running=orange · completed=green · waiting=cyan · previewing=blue (work package logged, not executed) ·
 *   failed=red · internal=gray (INTERNAL ROLE ONLY). VISIBLE summaries/outputs only — never hidden chain-of-thought.
 *
 * It writes into THIS project's .claude/forge-runs/<run_id>/events.jsonl only.
 * Use this for real activity — do not log agents/notes/checks that did not actually happen.
 *
 * EVENT VOCABULARY IS ENFORCED (an accounting desktop app progamma incident): event_type MUST be one
 * of the names listed above (KNOWN_EVENT_TYPES). Do NOT invent new event_type names for free-form
 * progress (e.g. "wp16_started", "contract_v8", "run_done" are FORBIDDEN — they render as nothing on
 * the dashboard and break the lenses). Put narrative/detail in `note`/`output`/`decision_summary` on a
 * STANDARD event type instead (e.g. {event_type:"agent_progress", agent:"Build Boss", note:" done: 252 tests, smoke OK"}).
 * FORGE_STRICT_EVENTS defaults ON (opt out with =0) — an unregistered agent name, unproven dispatch, or
 * unknown event_type is HARD-REJECTED (exit 2), not just flagged.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLAUDE_DIR = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
// lesson fix: reuse forge-runcontract.cjs's OWN isReviewDispatch()/REVIEW_ROLE_RE/
// ROL_VELDEN so the "does this dispatch read as review-only" question is answered by exactly one set of
// rules — never a second, re-typed copy here that could quietly drift from the contract's own judgement.
// forge-runcontract.cjs only requires THIS file back lazily, inside a function body (readEventsJsonl), never
// at its own top level, so this top-level require here creates no load-time cycle either direction.
let RUNCONTRACT = null;
try { RUNCONTRACT = require(path.join(CLAUDE_DIR, 'forge-bin', 'forge-runcontract.cjs')); } catch { RUNCONTRACT = null; }

function nowIso() { return new Date().toISOString(); }

/** resolveRunDir — run-id-vorm + containment (dezelfde guard-vorm als forge-bin/forge-runinfo.cjs's
 * readRun();: het oude server.cjs, waar deze guard oorspronkelijk ook in stond, is verwijderd).
 * Retourneert {ok,runDir} of
 *  {ok:false,message}; de CLI mapt message naar stderr+exit 1. Functie i.p.v. top-level code (H1-refactor
 *  2026-08-06) zodat batch-modus en tests dezelfde guard delen. */
function resolveRunDir(runId) {
  if (!runId) return { ok: false, message: 'run_id is required' };
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return { ok: false, message: 'invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + runId };
  const runDir = path.join(RUNS_DIR, runId);
  const base = path.resolve(RUNS_DIR), resolved = path.resolve(runDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return { ok: false, message: 'run_id escapes forge-runs — refused' };
  return { ok: true, runDir };
}
// ── HONESTY ENFORCEMENT (deep-scan 2026-07-07) ──────────────────────────────────────────────
// Stamp every event with `_forge_verify` so the dashboard can tell a REAL dispatched/proven event
// from a claim the main session merely logged. This is what stops a solo session painting a fake
// swarm: unregistered agent names + unproven proof events are made VISIBLE, never silently trusted.
// STRICT mode is the DEFAULT (opt OUT with FORGE_STRICT_EVENTS=0). It HARD-REJECTS (exit 2): an unknown
// event_type, an unregistered agent name, a dispatch-proof START event without dispatch_id, and a
// PROOF_EVENT (check_passed/retest_completed/quality_gate_passed/codex_*_completed/browser_*/custom_skill_*)
// that carries no proof field. Without strict it only STAMPS _forge_verify and the dashboard flags it.
function loadBossRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'config', 'agents', 'agent-registry.json'), 'utf8'));
    const names = new Set();   // membership test (lowercased slug + lowercased display name)
    const canon = new Map();   // lowercased slug / lowercased name → canonical display name
    for (const [slug, a] of Object.entries(reg.agents || {})) {
      const display = a.name ? String(a.name) : slug;
      names.add(slug.toLowerCase()); canon.set(slug.toLowerCase(), display);
      if (a.name) { names.add(String(a.name).toLowerCase()); canon.set(String(a.name).toLowerCase(), display); }
    }
    return { names, canon };
  } catch { return null; } // no registry → cannot judge names (older/foreign project)
}
// Load the registry ONCE (was re-read per event) and use it for TWO jobs: (a) validate agent names, and
// (b) CANONICALIZE them. Node-duplication bug (black-box run 2026-07-11): the Lead logs the display name
// ("Build Boss") while a self-logging subagent logs the slug ("build-boss"), so the dashboard drew TWO
// nodes for one agent. Folding every agent-referencing field to the registry's canonical display name
// keeps exactly one node per Boss. The mapping was already loaded here — it was just never applied.
const BOSS_REGISTRY = loadBossRegistry();
function loadBossNames() { return BOSS_REGISTRY ? BOSS_REGISTRY.names : null; }
function canonicalAgent(v) {
  if (v == null) return v;
  const key = String(v).toLowerCase();
  // Boss registry FIRST: a Boss also has an agents/*.md file, and its registry display name ("Build Boss")
  // must win over the file slug so the dashboard keeps drawing exactly one node per Boss.
  if (BOSS_REGISTRY && BOSS_REGISTRY.canon.has(key)) return BOSS_REGISTRY.canon.get(key);
  // Project agents fold their aliases (filename / spaced spelling) to their own declared name,
  // same one-node-per-agent reason — never to a Boss name, since they are not Bosses.
  if (PROJECT_AGENTS.canon.has(key)) return PROJECT_AGENTS.canon.get(key);
  return v;
}
const GENERIC_AGENTS = new Set(['lead', 'boss', 'orchestrator', 'system', 'paperclip', 'forge-router', 'main', 'codex', '']);
// REAL PROJECT AGENTS — the 12 permanent Bosses are NOT the only agents that really
// exist: `.claude/agents/*.md` also defines OPTIONAL, on-request specialists (verify-boss, codex-reviewer,
// data-scientist, electron-pro, mcp-developer, ml-engineer, payment-integration). Every one of them was
// hard-REFUSED by the name gate above, so e.g. `verify-boss` — the independent second witness whose ENTIRE
// job is to record a verdict nobody else can produce — could not log a single event about its own work
// (measured 2026-07-31: `STRICT REFUSED agent_started — unregistered agent "verify-boss"`). The fix is
// narrow on purpose: accept an agent name that is backed by a REAL agent-definition FILE on disk, and STAMP
// it `agent_kind:'project-agent'` so it is never silently indistinguishable from a permanent Boss.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not promote anyone to a 13th Boss. `config/agents/
// agent-registry.json` still documents exactly 12, its own `extensionRule` still governs real promotions,
// and a name with NO agent file (a fabricated "phantom-boss") is refused exactly as before. Existence of a
// real definition file is the evidence; the registry remains the authority on who is permanent.
function loadProjectAgents() {
  const dir = path.join(CLAUDE_DIR, 'agents');
  const names = new Set();  // membership test (lowercased slug / frontmatter name / spaced variant)
  const canon = new Map();  // any of those → the agent's own declared name
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return { names, canon, files: 0 }; }
  for (const f of files) {
    const base = f.replace(/\.md$/i, '');
    let declared = null;
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) { const n = fm[1].match(/^name:\s*(.+)$/m); if (n) declared = n[1].trim().replace(/^["']|["']$/g, ''); }
    } catch { /* unreadable agent file — fall back to the filename, never guess a different agent */ }
    const display = declared || base;
    for (const alias of [base, display, String(display).replace(/-/g, ' ')]) {
      const key = String(alias).toLowerCase();
      if (!key) continue;
      names.add(key);
      if (!canon.has(key)) canon.set(key, display);
    }
  }
  return { names, canon, files: files.length };
}
const PROJECT_AGENTS = loadProjectAgents();
const WORKING_AGENT_EVENTS = new Set(['subagent_started', 'subagent_completed', 'subagent_failed', 'subagent_output_created', 'subagent_artifact_created', 'agent_started', 'agent_completed', 'custom_subagent_created',
  // agent_model_used is name-checked here — a model must be attributable to an agent that
  // really exists — but it is NOT in DISPATCH_PROOF_EVENTS below, so a self-logging agent can record its
  // own model without knowing the parent's dispatch_id.
  'agent_model_used',
  /** R6-07 (zesde Codex-herreview): de identiteitscontrole dekte alleen agent-/subagent-events, dus een
   *  phantom of naamloze actor kon nog gewoon `file_changed`, `report_generated` of `wp_completed`
   *  schrijven. De onafhankelijkheidspoort weigert zulk werk later fail-closed, maar dan staat het al in
   *  de audittrail — en mijn claim dat de writer work-identiteit afdwingt was dus te sterk. Deze drie
   *  dragen het meeste gewicht in die poort (ze bepalen wie "uitvoerder" is) en worden nu wél
   *  naamgecontroleerd. Ze staan bewust NIET in DISPATCH_PROOF_EVENTS: een zelf-loggende agent kent de
   *  dispatch_id van zijn ouder niet. */
  'file_changed', 'report_generated', 'wp_completed',
  /** part B: wp_verified carries the identity the version-2 rule wp-verified-per-wp judges
   *  ("an agent that did no work on that package verified it"). Same reasoning as R6-07 above: an unchecked
   *  name would let a phantom verifier close a work package. Name-checked only, not dispatch-checked — the
   *  verifier self-logs its verdict and does not know its parent's dispatch_id. */
  'wp_verified']);
// dispatch_id proves a REAL Agent-tool call — but only the PARENT (Lead) knows the tool_use id, and it
// logs it on the START/creation event. A running subagent self-logs its own progress/output/completion
// and CANNOT know that id (fix 2026-07-09 checkup: strict-mode was rejecting the mandated self-logging
// contract). So the dispatch_id requirement applies ONLY to the start/creation events below; all other
// working events are still Boss-name-checked, just not dispatch-checked.
/** De events waarop de independent-verification-poort haar identiteitsoordeel bouwt. Hun agent MOET
 *  aanwezig en geregistreerd zijn (N-01) — anders is 'wie reviewde dit' een vrij invulbaar veld. */
// lead_review_* staat hier BEWUST niet in: forge-verify logt lead_review_completed bij een MISMATCH
// (rework-trigger), niet als goedkeuring — het is geen onafhankelijk reviewprotocol.
const REVIEW_IDENTITY_EVENTS = new Set(['review_started', 'review_completed', 'codex_review_started', 'codex_review_completed']);
const DISPATCH_PROOF_EVENTS = new Set(['subagent_started', 'agent_started', 'custom_subagent_created']);
// Canonical vocabulary — the exact set documented in the header comment above, incl. back-compat names.
const KNOWN_EVENT_TYPES = new Set([
  'run_started', 'project_scanned', 'profile_loaded', 'memory_loaded', 'memory_updated', 'decision_logged',
  'agent_selected', 'agent_started', 'agent_progress', 'agent_completed', 'agent_failed', 'skill_loaded',
  'command_run', 'file_read', 'file_changed', 'check_started', 'check_passed', 'check_failed', 'report_generated', 'run_completed',
  // OWNER GOVERNANCE (WAVE B / B4): the applied-prefs ECHO — see header comment above.
  // config_changed: forge-config.cjs diff with a run id logs one line per batch of owner setting changes.
  'owner_prefs_loaded', 'config_changed',
  'agent_note', 'agent_output', 'agent_decision_summary', 'agent_next_action', 'agent_evidence_added',
  'mission_packet_created', 'mission_blueprint_created', 'role_map_created', 'skill_discovery', 'skill_map_created',
  'custom_skill_created', 'skill_assigned', 'agent_work_package_created', 'custom_subagent_created',
  'subagent_started', 'subagent_completed', 'subagent_failed', 'subagent_output_created', 'subagent_artifact_created',
  'agent_artifact_created', 'agent_handoff', 'lead_review_started', 'lead_review_completed',
  'rework_task_created', 'rework_assigned', 'rework_started', 'rework_completed', 'merge_started', 'merge_completed',
  'codex_review_started', 'codex_review_completed', 'codex_finding', 'codex_blocked', 'codex_not_invoked',
  'fix_started', 'fix_completed', 'retest_started', 'retest_completed', 'quality_gate_passed', 'quality_gate_blocked', 'final_output_created',
  'ecc_inventory', 'ecc_blocked', 'ecc_agent_failed', 'native_fallback_used',
  'claude_md_checked', 'claude_md_created', 'claude_md_updated', 'claude_md_conflict_detected',
  'project_skill_dir_checked', 'custom_skill_updated', 'custom_skill_used', 'custom_skill_skipped', 'custom_skill_conflict_detected',
  'skill_registry_checked', 'skill_registry_created', 'skill_registry_updated', 'skill_registry_conflict_detected',
  'codex_diagnosis_started', 'codex_diagnosis_completed', 'codex_trust_gate_detected', 'codex_interactive_retry_required',
  'codex_manual_command_created', 'codex_retry_started', 'codex_retry_completed', 'codex_retry_blocked',
  'browser_proof_started', 'browser_screenshot_captured', 'browser_layout_verified', 'browser_proof_blocked',
  'dashboard_isolation_check_started', 'dashboard_isolation_check_completed', 'dashboard_project_root_detected',
  'dashboard_state_project_mismatch', 'dashboard_state_reset_for_project', 'dashboard_port_selected',
  'dashboard_health_verified', 'dashboard_cross_project_leak_blocked',
  // MISSION CONTROL PHASE 2 (WP1 — flat-file stores: tickets/artifacts/prd/mindmaps, forge-bin/forge-store.cjs)
  'ticket_created', 'ticket_updated', 'artifact_stored', 'prd_generated', 'mindmap_generated',
  'deep_learn_started', 'deep_learn_completed', 'cost_sampled', 'doctor_run', 'gate_evaluated', 'registry_scanned',
  // WORK-PACKAGE OUTCOMES + MODEL PROVENANCE — see the header doc comment above for
  // the full model of all three. wp_completed / wp_failed are the per-WP done/failed facts
  // forge-bin/forge-manifest.cjs and forge-bin/forge-briefing.cjs already consume but that were never
  // registered here, so under STRICT mode that whole chain could never receive one real line. wp_completed
  // is a PROOF_EVENT and a PASS_ASSERTION event (below); wp_failed is not proof-gated, exactly like
  // check_failed. agent_model_used records the model an agent ACTUALLY ran on, with a mandatory model field
  // that may be null when the runtime model is not observable but may never be a guess (MODEL_EVENTS below).
  // PLACEMENT NOTE, on purpose: this block sits ABOVE the required-evidence block that follows.
  // forge-doctor.cjs::extractKnownEventTypesFromSource scans this Set body INCLUDING comment lines, so an
  // apostrophe in later comment prose flips its quote parity and hides every type after it from the
  // ENFORCED unregistered_event gate (measured 2026-08-01: 20 of 183 real types invisible to it).
  // Registering these three here keeps them visible to that gate. For the same reason there is no
  // apostrophe or quote character anywhere in this comment block.
  'wp_completed', 'wp_failed', 'agent_model_used',
  // VERSION 2 RULE EVENTS (part B) - see the header
  // doc comment above for each shape. Named by the FORGE_HARD_RULES.json version-2 rules and lifecycle table and
  // mirrored in forge-bin/forge-verify.cjs. The seven bookkeeping types are also non-work in forge-runcontract.cjs.
  // Same placement rule as the block above: no quote or apostrophe character anywhere in this comment block.
  'wp_verified', 'escalation', 'route_assigned', 'run_paused', 'run_resumed', 'session_resumed', 'gate_blocked',
  'sync_completed', 'owner_requirement_noted',
  // SCRIBE RECONCILIATION EVENTS (part ii) - see the
  // header doc comment above. Bookkeeping about the owner requests, never work: forge-runcontract.cjs lists both in
  // NON_WORK_EVENT_TYPES and forge-verify.cjs mirrors them as BACKBONE milestones. The writer refuses
  // owner_requests_reconciled unless the scribe gate is OK. No quote or apostrophe character in this comment block.
  'owner_requests_reconciled', 'requirement_resolved',
  // SCRIBE HEAD ANCHOR (Codex R3 SC-06) - writer-stamped scribe ledger and inbox head in the run log,
  // bookkeeping only, never work. Same placement rule: no quote or apostrophe character in this comment block.
  'scribe_head',
  // PAPERCLIP CONTROL PLANE (forge-bin/forge-paperclip.cjs) — registered WAVE C / C-INTEGRATE, 2026-07-18.
  // See header doc comment above: these were REAL pre-existing emitted events, previously unregistered.
  'paperclip_runtime_reused', 'paperclip_runtime_blocked', 'paperclip_runtime_started',
  'paperclip_skills_catalog_installed', 'paperclip_agent_instructions_set', 'paperclip_agent_instructions_failed',
  'paperclip_agent_skills_attached', 'paperclip_agent_skills_failed', 'paperclip_selected', 'paperclip_git_guard_warning',
  'paperclip_company_reused', 'paperclip_company_created', 'paperclip_goal_created', 'paperclip_project_created',
  'paperclip_workspace_bound', 'paperclip_agent_reused', 'paperclip_agent_failed', 'paperclip_agent_created',
  'paperclip_agent_docs_written', 'paperclip_ticket_created', 'paperclip_agents_paused', 'paperclip_agents_resumed',
  'paperclip_runtime_stopped',
  // REQUIRED-EVIDENCE (WAVE C / C2+C-INTEGRATE) — config/orchestration/required-evidence.json's
  // any_of_events per domain. See header doc comment above.
  'zero_console_errors_noted', 'e2e_passed', 'e2e_result', 'integration_gate_passed',
  'validate_workflow_passed', 'workflow_validated', 'workflow_imported_inactive', 'robots_checked',
  'source_compliance_noted', 'citation_verified', 'ingestion_idempotency_verified', 'backtest_completed',
  'uncertainty_labels_applied', 'webhook_auth_verified', 'outreach_drafted_only_noted',
  // WAVE D (D1 forge-manifest.cjs/forge-swarm-resume.cjs, D2 forge-fixtures.cjs, D-INTEGRATE):
  // manifest_armed — a run-level swarm dispatch manifest was persisted (forge-manifest.cjs::arm()), a
  // one-shot structural fact analogous to registry_scanned/prd_generated. wp_resumed — a specific
  // unfinished work package was re-dispatched after forge-swarm-resume.cjs::resume() (per-WP, mirrors
  // check_started's "running" semantics, not a run-level backbone milestone). fixtures_required —
  // forge-fixtures.cjs::check() found a correctness-critical domain with no real fixtures and no waiver
  // (BLOCKED, exit 3). fixtures_waived — check() accepted an explicit, logged waiver in place of real
  // fixtures (OK, but flagged, never silent). See forge-manifest.cjs/forge-swarm-resume.cjs/forge-fixtures.cjs
  // header comments for the full model.
  'manifest_armed', 'wp_resumed', 'fixtures_required', 'fixtures_waived',
  // forge-harvest.cjs (post-WAVE-E): lessons_harvested — a READ-ONLY cross-project learning
  // harvest run completed (forge-harvest.cjs::harvest()), a one-shot structural fact analogous to
  // memory_updated/registry_scanned — the event IS the completed harvest, never a per-agent task. See
  // forge-harvest.cjs header doc comment for the full read-only/secret-exclusion/canonical-quote model.
  'lessons_harvested',
  // WAVE H (H1/H2/H4 + H-INTEGRATE): doc_generated (REAL call site, forge-docs.cjs --run) /
  // repomap_generated / bead_added / bead_closed (forward-declared — see header comment above).
  'doc_generated', 'repomap_generated', 'bead_added', 'bead_closed',
  // run_finalized — de audittrail van forge-finalize.cjs, het ene gezaghebbende
  // eindverdict. De receipt (run-finalized.json) pint de log-digest; dit event legt de finalisatie vast.
  // Geen aanhalingsteken in dit commentaarblok — de doctor-scanner leest deze Set inclusief comments.
  'run_finalized',
  // WAVE G (G1 forge-mcp-gate.cjs + G-INTEGRATE): MCP-as-client least-privilege events — the
  // gate module itself does NOT call logEvent (see forge-mcp-gate.cjs header, "shared-file rule for this
  // wave"); these are forward-declared for the Bosses/Head Chef call sites that will invoke validateGrant()/
  // planLoad() during real dispatch. mcp_grant_validated/mcp_grant_denied — a validateGrant() call resolved
  // allowed:true/false. mcp_tool_loaded — a planLoad() tool entry was actually used by a Boss. mcp_native_
  // fallback — a relevant tool was not usable (not opted-in / above tier / not granted) and the Boss fell
  // back to native Claude runtime instead (mirrors the existing native_fallback_used, MCP-specific).
  'mcp_grant_validated', 'mcp_grant_denied', 'mcp_tool_loaded', 'mcp_native_fallback',
  // WAVE J (J1-J5 + J-INTEGRATE): see header doc comment above for the full model per event.
  'skill_proposed', 'skill_approved', 'proposal_rejected',
  'tournament_planned', 'tournament_scored',
  'portfolio_scanned',
  'codemodel_built', 'codemodel_updated',
  'briefing_generated',
  // V9-INTEGRATE (P1/P2/P4/P5 + V9-INTEGRATE): see header doc comment above for the full model
  // per event. Forward-declared — none of the 4 source modules call logEvent() themselves (shared-file rule).
  'research_done', 'run_contract_checked', 'run_contract_violated', 'capabilities_reported',
  'scout_researched', 'capability_vetted', 'projectbrain_generated',
  // V9-fix (break-swarm DEFECT 2/3 honesty-gap close-out): owner_override — see header doc
  // comment above. forge-runcontract.cjs already reads this event type; this just registers the vocabulary.
  'owner_override',
  // V9 (forge-bin/forge-audit-loop.cjs): the continuous AUDIT-LOOP tool's own events —
  // see header doc comment above for the full model.
  'audit_iteration', 'audit_finding',
  // REJECTED-APPROACH MEMORY (forge-bin/forge-tool-index.cjs, mining-ronde-1 §1): a real,
  // evidenced tried-and-rejected fact, indexed cross-run so a later run cannot silently repeat it. See the
  // header doc comment above for the exact shape; it is a PROOF_EVENT (below). NOTE: no apostrophe or quote
  // character in this comment block — forge-doctor.cjs::extractKnownEventTypesFromSource() scans this Set
  // body INCLUDING comment lines, so stray quote characters in comment prose corrupt its parse.
  'rejected_approach',
  // back-compat
  'review_started', 'review_completed',
]);
const PROOF_EVENTS = {
  check_passed: ['command', 'output', 'evidence', 'output_artifact'], retest_completed: ['command', 'output', 'evidence'],
  quality_gate_passed: ['evidence', 'output_artifact', 'command'], codex_review_completed: ['codex_job_id', 'evidence', 'output_path', 'codex_command'],
  codex_retry_completed: ['codex_job_id', 'evidence', 'output_path'], browser_screenshot_captured: ['screenshot_path', 'artifact', 'evidence'],
  browser_layout_verified: ['screenshot_path', 'artifact', 'evidence'], custom_skill_created: ['path'], custom_skill_updated: ['path'],
  // 2026-07-31 (mining-ronde-1 §1): a rejected approach without proof is an opinion, not memory — and this
  // index is what a LATER run trusts instead of re-deriving. Refuse it at write time rather than let a bare
  // assertion become the reason a future agent skips a viable route.
  rejected_approach: ['evidence', 'output', 'command', 'output_artifact'],
  // a work package is the exact unit forge-manifest.cjs::projectManifest flips to
  // "done" and forge-briefing.cjs reports as RAN. A bare "wp5 is finished" with nothing behind it is the
  // fabricated completion this whole gate exists to stop, so it needs the same real proof check_passed
  // needs. wp_failed is intentionally absent from this map (see the header) — proving a failure must never
  // be harder than claiming a success.
  wp_completed: ['command', 'output', 'evidence', 'output_artifact'],
};
// CONTENT ORACLE: a proof must not merely EXIST, it must not CONTRADICT success.
// (a) a "*_passed" event carrying a non-zero exit_code is a lie, not a pass; (b) a screenshot that is
// 0-byte/blank/truncated is not visual proof. This turns "artifact exists" into "artifact proves success".
const PASS_ASSERTION_EVENTS = new Set(['check_passed', 'retest_completed', 'quality_gate_passed', 'wp_completed']);
// (a2) RESULT-FIELD ORACLE: the exit_code oracle above only catches a contradiction
// that happens to be expressed as a number. A pass event whose OWN result/outcome/verdict/status field reads
// as a failure ("wp_completed" + status:"failed") contradicts its own claim just as loudly, and the
// dashboard would render it red while forge-manifest.cjs flipped the work package to done — two readers,
// two answers, from one event. Refuse it at write time instead.
const CONTRADICTION_FIELDS = ['result', 'outcome', 'verdict', 'status'];
const FAILURE_VALUE_RE = /\b(fail|fails|failed|failing|failure|error|errored|blocked|refused|rejected|aborted|crash|crashed|timeout|timed[ _-]?out|not[ _-]?ok|nok)\b/i;
const SCREENSHOT_EVENTS = new Set(['browser_screenshot_captured', 'browser_layout_verified']);
const MIN_SCREENSHOT_BYTES = 512; // a real PNG/JPEG capture is many KB; below this it is empty/failed, not proof
// MODEL PROVENANCE gate — see the header doc comment. `model` is MANDATORY on these
// events; explicit null is the ONLY honest way to say "the runtime model was not observable". A placeholder
// or hedge is a guess dressed as a fact and is refused, because the entire value of this event is that a
// later reader can trust it without re-deriving anything.
const MODEL_EVENTS = new Set(['agent_model_used']);
const MODEL_PLACEHOLDER_RE = /^(unknown|unspecified|unobserved|not[ _-]?observed|n\/?a|tbd|todo|none|nil|null|undefined|\?+|guess|guessed|assumed|presumed|probably|maybe|default|auto|model|placeholder|x+|-+)$/i;
function verifyEvent(ev) {
  const v = {}; const et = ev.event_type;
  if (!KNOWN_EVENT_TYPES.has(et)) {
    v.event_type_unknown = true;
    v.event_type_warning = 'unknown event_type "' + et + '" — not in the standard vocabulary (see file header). Use a standard event_type and put free-form narrative in note/output/decision_summary, not a new event_type.';
  }
  /** N-01 (Codex post-fix herreview 2026-08-09): review-events vielen buiten WORKING_AGENT_EVENTS, dus
   *  hun `agent` werd NOOIT tegen de registry gelegd — een niet-bestaande reviewer ("No Such Reviewer")
   *  kwam er gewoon door. En omdat de naamcheck alleen liep bij `agent != null`, kon je hem ook helemaal
   *  weglaten. Voor de events waarop de onafhankelijkheidspoort steunt is een naamloze of onbekende
   *  actor geen detail maar het hele punt: dan is niet vast te stellen WIE iets deed of goedkeurde. */
  if (REVIEW_IDENTITY_EVENTS.has(et) && (ev.agent == null || String(ev.agent).trim() === '')) {
    v.agent_registered = false;
    v.agent_warning = 'event_type "' + et + '" vereist een `agent`: zonder naam is niet vast te stellen wie deze review opende of afsloot, en de onafhankelijkheidspoort steunt daarop.';
  }
  else if ((WORKING_AGENT_EVENTS.has(et) || REVIEW_IDENTITY_EVENTS.has(et)) && ev.agent != null) {
    const name = String(ev.agent).toLowerCase();
    const boss = loadBossNames();
    const internalRole = ['internal', 'native'].includes(String(ev.runtime || '').toLowerCase());
    const isBoss = boss ? boss.has(name) : false;
    const isGeneric = GENERIC_AGENTS.has(name);
    const isProjectAgent = PROJECT_AGENTS.names.has(name);
    /** R5-05 (vijfde herreview): zonder registry stond dit standaard op `true` — fail-OPEN op precies het
     *  veld dat identiteit moet bewijzen. Voor gewone events blijft dat zo (een kale installatie zonder
     *  registry moet gewoon kunnen loggen), maar voor REVIEW-events niet: daar is "ik kan het niet
     *  controleren" gelijk aan "niet aangetoond". */
    v.agent_registered = boss ? (isBoss || isGeneric || isProjectAgent) : !REVIEW_IDENTITY_EVENTS.has(et);
    if (!boss && REVIEW_IDENTITY_EVENTS.has(et)) v.agent_warning = 'geen agentregistry beschikbaar, dus de reviewer "' + ev.agent + '" is niet te verifieren — bij review-events is dat fail-closed';
    if (!v.agent_registered) v.agent_warning = 'unregistered agent "' + ev.agent + '" — not a permanent Boss (config/agents/agent-registry.json) and no matching agent definition in .claude/agents/. Use a Boss name, or add a real agent file first; put specialization in `role`.';
    // A real-but-not-permanent agent is ACCEPTED and LABELLED, never silently promoted — the
    // dashboard/certify/ledger readers can tell a permanent Boss from an optional project specialist.
    else if (!isBoss && !isGeneric && isProjectAgent) { v.agent_kind = 'project-agent'; v.agent_source = '.claude/agents/'; }
    // Only the parent-logged START/creation events must carry a dispatch id (proof of a real Agent call);
    // self-logged progress/output/completion events are name-checked only (see DISPATCH_PROOF_EVENTS note).
    if (DISPATCH_PROOF_EVENTS.has(et) && !ev.dispatch_id && !internalRole) v.dispatch_unverified = true;
  }
  /** lesson fix — a real incident: the Lead logged `subagent_started` for a
   *  reviewer with `role:"reviewer"` and `task:"independent read-only verification review of "`.
   *  forge-runcontract.cjs's isReviewDispatch() rejected it (the word " " is not in its REVIEW_WOORDEN
   *  allowlist), so this dispatch counted as WORK, and that reviewer could never be this run's independent
   *  reviewer — discovered only after the hash-chained log could no longer be corrected. This does NOT
   *  refuse the event (the writer is not the place to police wording — refusing here would make an
   *  append-only, hash-chained log uncorrectable for a mistake that is still perfectly legal to log) and it
   *  does NOT change what counts as a review (that stays exactly forge-runcontract.cjs's own call, reused
   *  as-is, never re-typed here). It only WARNS, loudly and early, on the one shape most likely to repeat
   *  this incident: a dispatch START/creation event whose role field READS like a reviewer but whose
   *  task/mission text does not pass isReviewDispatch()'s stricter allowlist. */
  if (RUNCONTRACT && DISPATCH_PROOF_EVENTS.has(et)) {
    const rolVelden = RUNCONTRACT.ROL_VELDEN || ['role', 'dispatch_role', 'purpose'];
    const looksLikeReviewer = rolVelden.some((f) => typeof ev[f] === 'string' && RUNCONTRACT.REVIEW_ROLE_RE.test(ev[f].trim()));
    if (looksLikeReviewer && !RUNCONTRACT.isReviewDispatch(ev)) {
      v.review_dispatch_counts_as_work = true;
      /** this warning used to embed the RAW VALUE of every present role-ish field
       *  (`purpose:"access_token=abc123"`) into _forge_verify AND stderr. A role/purpose/task field is free
       *  text a caller controls, so a secret-shaped value pasted in there got echoed a second time onto a
       *  diagnostic surface that had no reason to carry it. Fixed: name only the FIELD NAMES that triggered
       *  the warning (a fixed, safe label), never their values — the field's own value still lands in the
       *  event line exactly as the caller wrote it (unchanged, that is the caller's own data), it is just
       *  never additionally repeated inside this warning text. */
      const flaggedFieldNames = rolVelden.filter((f) => typeof ev[f] === 'string');
      v.review_dispatch_warning = 'this ' + et + ' has a reviewer-shaped role (fields: ' + flaggedFieldNames.join(', ') + ') but forge-runcontract.cjs::isReviewDispatch() says its task/mission is not on the strict review-word allowlist — this dispatch counts as WORK, so this agent cannot review this run. Use only review words in task/mission (see forge-runcontract.cjs REVIEW_WOORDEN). / deze dispatch heeft een reviewrol maar de taak/mission-tekst staat niet op de strikte reviewwoorden-toelaatlijst van forge-runcontract.cjs::isReviewDispatch() — deze dispatch telt als WERK, dus deze agent kan geen reviewer van deze run zijn. Gebruik alleen reviewwoorden in task/mission.';
    }
  }
  if (PROOF_EVENTS[et]) {
    const need = PROOF_EVENTS[et];
    const has = need.find((k) => ev[k] != null && String(ev[k]).length);
    if (!has) { v.proof_verified = false; v.proof_reason = 'no proof field (' + need.join('/') + ') — CLAIMED, not verified'; }
    else {
      v.proof_verified = true;
      // (a) exit_code oracle — a "*_passed" event with a non-zero exit_code contradicts its own claim.
      if (PASS_ASSERTION_EVENTS.has(et) && ev.exit_code != null && Number(ev.exit_code) !== 0) {
        v.proof_verified = false; v.proof_reason = 'exit_code ' + ev.exit_code + ' != 0 — a pass event must carry a zero exit code';
      }
      // (a2) result-field oracle — same idea as the exit_code oracle, for the contradiction
      // expressed in words instead of a number. See CONTRADICTION_FIELDS/FAILURE_VALUE_RE above.
      if (v.proof_verified && PASS_ASSERTION_EVENTS.has(et)) {
        for (const f of CONTRADICTION_FIELDS) {
          const raw = ev[f];
          if (raw == null || typeof raw === 'object') continue;
          if (FAILURE_VALUE_RE.test(String(raw))) {
            v.proof_verified = false;
            v.proof_reason = f + ' "' + raw + '" contradicts the ' + et + ' claim — a pass event cannot also report a failed/blocked/refused outcome';
            break;
          }
        }
      }
      // (b) path oracle — the proof path must exist; a screenshot proof must also be non-trivial in size.
      const pathish = ev.screenshot_path || ev.output_path || ev.path || ev.artifact || ev.output_artifact;
      if (v.proof_verified && pathish && typeof pathish === 'string' && /[\\/]/.test(pathish)) {
        const abs = path.isAbsolute(pathish) ? pathish : path.join(CLAUDE_DIR, '..', pathish);
        if (!fs.existsSync(abs)) { v.proof_verified = false; v.proof_reason = 'proof path missing: ' + pathish; }
        else if (SCREENSHOT_EVENTS.has(et)) {
          let sz = 0; try { sz = fs.statSync(abs).size; } catch {}
          if (sz < MIN_SCREENSHOT_BYTES) { v.proof_verified = false; v.proof_reason = 'screenshot only ' + sz + ' bytes (< ' + MIN_SCREENSHOT_BYTES + ') — blank/failed capture, not proof'; }
        }
      }
    }
  }
  // MODEL PROVENANCE gate — see MODEL_EVENTS above and the header doc comment. The
  // stamp records model_observed either way, so a null model is visibly an honest "not observable", never
  // an accident that reads the same as a forgotten field.
  if (MODEL_EVENTS.has(et)) {
    if (!Object.prototype.hasOwnProperty.call(ev, 'model')) {
      v.model_unverified = true;
      v.model_reason = 'no `model` field — ' + et + ' requires an explicit model; log null when the actual model is not observable, never omit it and never guess';
    } else if (ev.model === null) {
      v.model_observed = false;
    } else {
      const m = String(ev.model).trim();
      if (!m) { v.model_unverified = true; v.model_reason = 'blank `model` value — log null when the actual model is not observable, never an empty string'; }
      else if (MODEL_PLACEHOLDER_RE.test(m)) { v.model_unverified = true; v.model_reason = 'placeholder model "' + ev.model + '" — a model that was not actually observed must be logged as null, never guessed'; }
      else v.model_observed = true;
    }
  }
  return Object.keys(v).length ? v : null;
}
/** RUN-START BASELINE (part B) — see the header doc comment. runStartBaseline(opts) returns the
 *  baseline fields for a run_started event and NEVER throws: {file_hashes, file_hashes_unreadable?} on a
 *  snapshot, {file_hashes_unavailable} when the registry exists but cannot be used, {} when there is nothing to
 *  snapshot (no rules file, or no file-touched rule in it). The file list and the hashing both come from
 *  forge-runcontract.cjs (fileTouchedTargets/snapshotFileHashes) — this writer keeps no list of its own.
 *  opts.claudeDir / opts.runcontract exist for tests only (default: this writer's own project).
 *  Known edge, fail-closed: under `--batch --txn` the stamped hashes are part of the batch digest, so retrying the
 *  SAME key after a watched file changed is refused as "same key, different content" (loud, never a silent loss). */
const RUN_START_BASELINE_FIELDS = ['file_hashes', 'file_hashes_unreadable', 'file_hashes_unavailable'];
function shortReason(e) { return String((e && (e.code || e.message)) || e || 'unknown error').slice(0, 200); }
function runStartBaseline(opts) {
  opts = opts || {};
  try {
    const claudeDir = opts.claudeDir || CLAUDE_DIR;
    const rc = opts.runcontract !== undefined ? opts.runcontract : RUNCONTRACT;
    const rulesPath = path.join(claudeDir, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
    let raw;
    try { raw = fs.readFileSync(rulesPath, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return {}; // no rules registry: nothing declares a watched file
      return { file_hashes_unavailable: 'rules registry unreadable (' + shortReason(e) + ')' };
    }
    let rules;
    try { rules = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch (e) { return { file_hashes_unavailable: 'rules registry is not valid JSON (' + shortReason(e) + ')' }; }
    // No file-touched rule at all (e.g. an older registry): nothing to snapshot, and no notice either — even when
    // this project still runs an older forge-runcontract.cjs without the snapshot helpers (a mixed-version sync).
    // This only asks WHETHER such a rule exists; WHICH files it watches still comes from fileTouchedTargets().
    const hasFileTouched = Array.isArray(rules && rules.rules) && rules.rules.some((r) => r && r.check && r.check.type === 'file-touched');
    if (!hasFileTouched) return {};
    if (!rc || typeof rc.fileTouchedTargets !== 'function' || typeof rc.snapshotFileHashes !== 'function') {
      return { file_hashes_unavailable: 'forge-runcontract.cjs (fileTouchedTargets/snapshotFileHashes) could not be loaded' };
    }
    const targets = rc.fileTouchedTargets(rules);
    if (!Array.isArray(targets) || !targets.length) return {};
    const root = path.resolve(claudeDir, '..');
    const hashes = {};
    const unreadable = [];
    for (const f of targets) {
      // one file at a time: snapshotFileHashes throws on an unreadable file, which must not lose the others
      try { Object.assign(hashes, rc.snapshotFileHashes(root, [f])); }
      catch (e) { unreadable.push({ file: f, error: shortReason(e) }); }
    }
    const out = { file_hashes: hashes };
    if (unreadable.length) out.file_hashes_unreadable = unreadable;
    return out;
  } catch (e) {
    return { file_hashes_unavailable: 'baseline snapshot failed (' + shortReason(e) + ')' };
  }
}
/** stampRunStartBaseline(ev, opts?) — writer-owned baseline on a run_started event (mutates ev). Returns true when
 *  the caller had supplied any baseline field itself (it is replaced, never trusted). opts goes to runStartBaseline
 *  (the library append path passes the claudeDir of the run folder it writes into). */
function stampRunStartBaseline(ev, opts) {
  const callerSupplied = RUN_START_BASELINE_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(ev, f));
  for (const f of RUN_START_BASELINE_FIELDS) delete ev[f];
  Object.assign(ev, runStartBaseline(opts));
  return callerSupplied;
}
/** WRITER_VALIDATED — Codex R2/N10: the event objects that went through validateForWrite() in this
 *  process. appendChainedLocked() is exported, so a library caller can hand it events that never passed the
 *  writer's stamping; for those it applies the writer-owned stamps itself (see there). A WeakSet: identity only,
 *  nothing a caller can forge through the event body. */
const WRITER_VALIDATED = new WeakSet();
/** claudeDirOfRunDir(runDir) — <root>/.claude for a run folder <root>/.claude/forge-runs/<id>; this writer's own
 *  .claude for anything else (the CLI path's baseline root). */
function claudeDirOfRunDir(runDir) {
  const parent = path.dirname(path.resolve(runDir));
  return path.basename(parent) === 'forge-runs' ? path.dirname(parent) : CLAUDE_DIR;
}
/** stampLibraryEvent(ev, runDir) — R2/N10: the writer-owned stamps the CLI path applies, for an event that skipped
 *  validateForWrite(): a run_started gets the writer's file_hashes baseline (a caller-supplied one is replaced and
 *  flagged file_hashes_replaced, exactly like the CLI), and a caller-supplied _forge_verify.completion_gate is
 *  dropped (only the writer's own gate may write it). ingested_at/timestamp are stamped under the lock as before.
 *  Mutates ev. */
function stampLibraryEvent(ev, runDir) {
  if (!ev || typeof ev !== 'object' || WRITER_VALIDATED.has(ev)) return ev;
  // the scribe_gate stamp on owner_requests_reconciled is writer-owned too, so a library append carries none
  for (const stampKey of ['completion_gate', 'scribe_gate']) {
    if (ev._forge_verify && typeof ev._forge_verify === 'object' && Object.prototype.hasOwnProperty.call(ev._forge_verify, stampKey)) {
      const fv = Object.assign({}, ev._forge_verify);
      delete fv[stampKey];
      if (Object.keys(fv).length) ev._forge_verify = fv; else delete ev._forge_verify;
    }
  }
  if (ev.event_type === 'run_started') {
    const replaced = stampRunStartBaseline(ev, { claudeDir: claudeDirOfRunDir(runDir) });
    if (replaced) ev._forge_verify = Object.assign({}, ev._forge_verify && typeof ev._forge_verify === 'object' ? ev._forge_verify : {}, { file_hashes_replaced: true });
  }
  return ev;
}

/** validateForWrite — canonicaliseer + verify + STRICT-poort voor EEN event (muteert ev). Exact dezelfde
 *  regels als de oude top-level flow; alleen als functie zodat single-event CLI, batch-modus en tests een
 *  identieke poort delen (H1-refactor 2026-08-06). Retourneert {ok:true,verify} of {ok:false,exitCode:2,message}. */
/** WRITER-CONTROLLED TIME: a caller-supplied `timestamp` used to
 *  survive logging unchanged, so a backdated run_started exempted every `since` rule and a backdated
 *  run_completed dodged the doctor's enforcement date. Now EVERY event gets a writer-stamped `ingested_at`
 *  (never accepted from the caller — a supplied value is dropped) and `timestamp` is set to the same instant.
 *  A caller's own timestamp survives only as `claimed_ts` (its claim, kept verbatim, never trusted for
 *  ordering); when that claim lies before the previous event's ingestion the writer flags it
 *  (_forge_verify.claimed_ts_backdated). Readers (forge-runcontract tsOf, forge-doctor) prefer ingested_at and
 *  fall back to timestamp only for history written before this fix, which predates every cutoff. */
const WRITER_TIME_FIELDS = ['ingested_at', 'claimed_ts'];
function stampWriterTime(ev, nowIsoValue) {
  const now = nowIsoValue || nowIso();
  const claimed = Object.prototype.hasOwnProperty.call(ev, 'timestamp') ? ev.timestamp : undefined;
  for (const f of WRITER_TIME_FIELDS) delete ev[f]; // writer fields: a caller value is never kept
  ev.ingested_at = now;
  ev.timestamp = now;
  if (claimed !== undefined && claimed !== null && String(claimed) !== '' && String(claimed) !== now) ev.claimed_ts = claimed;
  return ev;
}
function validateForWrite(ev) {
  stampWriterTime(ev);
  // Canonicalize agent-referencing fields to the registry's display name BEFORE verify + write, so a slug
  // ("build-boss") and its display name ("Build Boss") never split into two dashboard nodes for one agent.
  for (const f of ['agent', 'to', 'target', 'handoff']) { if (ev[f] != null) ev[f] = canonicalAgent(ev[f]); }
  // part B: every run_started (single CLI, batch and library callers alike) carries the writer's own
  // file_hashes baseline — see runStartBaseline(). Fail-safe by construction: it never throws or refuses.
  const baselineReplaced = ev.event_type === 'run_started' ? stampRunStartBaseline(ev) : false;
  let v = verifyEvent(ev);
  if (baselineReplaced) v = Object.assign(v || {}, { file_hashes_replaced: true });
  if (v) ev._forge_verify = v;
  // STRICT is the DEFAULT since 2026-07-07 (was opt-in via =1; nobody turned it on, which let a fake
  // swarm + free-form event names through undetected — an accounting desktop app progamma incident). Opt OUT with =0.
  const STRICT = process.env.FORGE_STRICT_EVENTS !== '0';
  /** R4-05 (vierde Codex-herreview 2026-08-09): identiteit op REVIEW-events is niet opt-out. Met
   *  FORGE_STRICT_EVENTS=0 kwam een spookreviewer er alsnog door, en juist die events dragen het hele
   *  onafhankelijkheidsoordeel. Strict mode uitzetten mag een build soepeler maken; het mag niet betekenen
   *  dat "wie dit goedkeurde" een vrij invulbaar veld wordt. Deze weigering staat daarom BUITEN de vlag. */
  if (!STRICT && v && v.agent_registered === false && REVIEW_IDENTITY_EVENTS.has(ev.event_type)) {
    return { ok: false, exitCode: 2, message: 'REFUSED ' + ev.event_type + ' — ' + (v.agent_warning || 'onbekende reviewer') + ' (identiteit op review-events is NIET opt-out: FORGE_STRICT_EVENTS=0 verandert hier niets)' };
  }
  if (STRICT && v && (v.agent_registered === false || v.proof_verified === false || v.dispatch_unverified || v.event_type_unknown || v.model_unverified)) {
    return { ok: false, exitCode: 2, message: 'STRICT REFUSED ' + ev.event_type + ' — ' + (v.event_type_warning || v.agent_warning || v.proof_reason || v.model_reason || 'unproven dispatch (no dispatch_id, runtime not internal/native)') + ' (set FORGE_STRICT_EVENTS=0 to opt out of strict mode — not recommended)' };
  }
  WRITER_VALIDATED.add(ev); // appendChainedLocked will not stamp this event a second time
  return { ok: true, verify: v };
}

/** ================= VERGRENDELDE HASH-KETEN-APPEND =================
 *  De append was read-tail → hash → append ZONDER enige vergrendeling: twee gelijktijdige writers lazen
 *  dezelfde staart-hash, stempelden allebei prev_hash=H en de keten VORKTE — elke lineaire chain-walk
 *  (forge-doctor/forge-certify) las de run daarna als getamperd terwijl beide events eerlijk waren. De
 *  kritieke sectie zit nu achter een exclusieve lock-file (open 'wx' — atomair op Windows en POSIX) met
 *  retry/backoff+jitter; een stale lock (ouder dan ~10s of dode pid) wordt overgenomen; een timeout is
 *  een EERLIJKE fout (exit != 0), nooit een stille ongelockte append. Elk event krijgt bovendien een
 *  monotone `seq` (onder dezelfde lock bepaald, mee-gehasht via de canonical) zodat gaten/duplicaten ook
 *  zonder hash-walk detecteerbaar zijn. */
const LOCK_STALE_MS = 10000;
// Onder een burst van tientallen gelijktijdige writers serialiseert de lock ze allemaal; met de
// node-bootstorm erbij kan de staart van de rij ruim boven 5s uitkomen. 30s default (env-instelbaar)
// — een eerlijke wachttijd onder pathologische contentie is beter dan een valse timeout.
const LOCK_TIMEOUT_MS = Number(process.env.FORGE_EVENTS_LOCK_TIMEOUT_MS) > 0 ? Number(process.env.FORGE_EVENTS_LOCK_TIMEOUT_MS) : 30000;
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* geen SAB: dan best-effort spin-vrij doorgaan */ } }
function pidAliveHere(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
/** DE LOCK IS HANDLE-GEDRAGEN (definitieve vorm na de 120-writer stresstrace).
 *  Eerste versie: wx-create + stale-takeover op pid/leeftijd. De trace op 120 echte writers toonde 70
 *  onterechte takeovers via een ABA-race: wachter leest houder-pid X, X is intussen klaar en GEËXIT, een
 *  nieuwe houder Y heeft een verse lock — de wachter beoordeelt X als dood en unlinkt daarmee Y's levende
 *  lock (leeftijden van 17-300ms in de trace). Vorken dus, ondanks de lock.
 *  De sluitende eigenschap op Windows (libuv opent met FILE_SHARE_DELETE): de houder HOUDT ZIJN FD OPEN.
 *  Een unlink van een levend-gehouden lock maakt de naam slechts delete-pending — een nieuwe CREATE op
 *  die naam faalt (EACCES/EPERM) tot de houder zijn handle sluit. Een onterechte takeover-unlink is
 *  daarmee ONSCHADELIJK: de echte houder maakt gewoon af (zijn fd blijft geldig), en niemand kan de
 *  kritieke sectie binnen tot hij sluit. Exclusie is kernel-afgedwongen, niet evidence-gebaseerd.
 *  Takeover gebeurt UITSLUITEND via unlink (nooit rename — rename geeft de naam direct vrij en heropent
 *  de race); EACCES/EPERM/EBUSY op de create is contentie (delete-pending venster), geen fout. */
function acquireEventsLock(runDir, opts) {
  opts = opts || {};
  const lockPath = path.join(runDir, 'events.jsonl.lock');
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : LOCK_TIMEOUT_MS;
  // Monotone deadline (Codex r4 #1): een NTP-stap mag de wachttijd niet oprekken of inkorten.
  const t0 = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - t0) / 1000000n);
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })); } catch { /* token is diagnostisch; de FD is de echte lock */ }
      // Eigen identiteit vastleggen voor de fencing-verificatie bij append en release: is de naam
      // intussen door een (onterechte) takeover vervangen, dan wijkt ino/birthtime af en ABORT de
      // houder eerlijk in plaats van een gevorkte keten te schrijven.
      let ino = null, birthtimeMs = null;
      try { const st = fs.fstatSync(fd, { bigint: true }); ino = st.ino; birthtimeMs = st.birthtimeMs; } catch { /* fencing degradeert tot best-effort */ }
      return { ok: true, lockPath, fd, ino, birthtimeMs };
    } catch (e) {
      const contention = e.code === 'EEXIST' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EBUSY';
      if (!contention) return { ok: false, message: 'could not create events lock (' + e.message + ')' };
      if (e.code === 'EEXIST') {
        /** TAKEOVER: LEEFTIJD ÉN DOODSBEWIJS, INO-GEVERIFIEERD (Codex r4 #1).
         *  Historie: pid-ALLEEN was ABA-gevoelig (70 onterechte takeovers in de 120-writer trace:
         *  ms-houders exitten en hun pid las als dood terwijl de naam al een verse lock droeg);
         *  leeftijd-ALLEEN stal vervolgens een LEVENDE houder die >10s in de kritieke sectie zat en
         *  liet een voorwaartse kloksprong een levende lock stelen. De conjunctie kent geen van beide:
         *  leeftijd filtert de ms-ABA weg (een verse lock is nooit >10s oud), het pid-doodsbewijs
         *  beschermt de levende lange houder en de kloksprong (pid leeft -> geen takeover). Een
         *  onleesbaar/leeg lockbestand ouder dan de drempel is een crash-artefact (de houder schrijft
         *  zijn token direct na de wx-create) en mag weg. ageMs < 0 (mtime in de toekomst) is verdacht:
         *  reap alleen met een leesbaar, aantoonbaar dood pid — anders eerlijk wachten/timeouten. */
        try {
          const st1 = fs.statSync(lockPath, { bigint: true });
          const ageMs = Date.now() - Number(st1.mtimeMs);
          let tokenPid = null;
          try { const tok = JSON.parse(fs.readFileSync(lockPath, 'utf8')); if (Number.isFinite(Number(tok.pid))) tokenPid = Number(tok.pid); } catch { /* leeg/onparseerbaar token */ }
          const holderDead = tokenPid !== null ? !pidAliveHere(tokenPid) : true;
          const reapable = (ageMs > LOCK_STALE_MS && holderDead) || (ageMs < 0 && tokenPid !== null && holderDead);
          if (reapable) {
            const st2 = fs.statSync(lockPath, { bigint: true });
            if (st2.ino === st1.ino && st2.birthtimeMs === st1.birthtimeMs) {
              try { fs.unlinkSync(lockPath); } catch { /* iemand anders was eerder */ }
            }
            continue;
          }
        } catch { continue; /* lock verdween onder ons: opnieuw proberen */ }
      }
      if (elapsedMs() >= timeoutMs) return { ok: false, message: 'events lock not acquired within ' + timeoutMs + 'ms (' + lockPath + ' held) — refusing an UNLOCKED append (the chain would fork)' };
      sleepMs(15 + Math.floor(Math.random() * 35));
    }
  }
}
/** stillOwnsLock — fencing-verificatie: draagt de locknaam nog ONZE inode? Na een onterechte takeover
 *  (of welke verstoring dan ook) wijkt de identiteit af en hoort de houder te ABORTEN, niet te schrijven.
 *  Zonder vastgelegde identiteit (fstat faalde bij acquire) degradeert dit eerlijk tot true. */
function stillOwnsLock(lock) {
  if (!lock || lock.ino == null) return true;
  try { const st = fs.statSync(lock.lockPath, { bigint: true }); return st.ino === lock.ino && st.birthtimeMs === lock.birthtimeMs; }
  catch { return false; /* naam weg = lock verloren */ }
}
function releaseEventsLock(lock) {
  if (!lock) return;
  // Fencing ook hier (Codex r4 #1): unlink alleen als de naam nog ONZE lock draagt — na een takeover
  // zou de unlink anders de VERSE lock van de opvolger verwijderen. Daarna pas de handle sluiten:
  // zolang de fd open is kan een 'wx'-create de naam niet herclaimen, dus het verify->unlink-venster
  // is niet door een legitieme nieuwe houder te raken.
  const owns = stillOwnsLock(lock);
  if (owns && lock.lockPath) { try { fs.unlinkSync(lock.lockPath); } catch { /* al weg */ } }
  if (lock.fd != null) { try { fs.closeSync(lock.fd); } catch { /* al dicht */ } }
}

/** chainTail — bepaal {prevHash, lastSeq} uit het bestand. Leest eerst alleen de laatste 64KB (de
 *  volledige-file-read per append was O(n^2) over de levensduur van een run — audit G3-bijvangst); alleen
 *  wanneer dat venster GEEN geketend event bevat en het bestand groter is dan het venster, volgt de
 *  volledige read (legacy-runs met een lange ongeketende kop behouden hun oude semantiek exact). */
function chainTail(eventsFile, runId) {
  const scan = (text) => {
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s) continue; // blank/whitespace-only line — skip, not the chain tail
      let parsed;
      try { parsed = JSON.parse(s); } catch { continue; } // defensively skip an unparseable line rather than crash
      if (parsed && parsed.entry_hash) {
        // the previous event's ingestion instant (ingested_at; timestamp for pre-F05 history) for the backdating flag
        const ms = Date.parse(parsed.ingested_at || parsed.timestamp);
        return { prevHash: parsed.entry_hash, lastSeq: Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : 0, lastIngestedMs: Number.isFinite(ms) ? ms : null };
      }
      // a real, parseable event without entry_hash — keep searching further back for an earlier chained one
    }
    return null;
  };
  try {
    const st = fs.statSync(eventsFile);
    const WINDOW = 64 * 1024;
    if (st.size > WINDOW) {
      const fd = fs.openSync(eventsFile, 'r');
      let tailText;
      try {
        const buf = Buffer.alloc(WINDOW);
        fs.readSync(fd, buf, 0, WINDOW, st.size - WINDOW);
        tailText = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
      const hit = scan(tailText);
      if (hit) return hit;
      // venster zonder geketend event: volledige read als eerlijke fallback (legacy-run kop)
    }
    const full = scan(fs.readFileSync(eventsFile, 'utf8'));
    if (full) return full;
  } catch { /* bestand ontbreekt nog — verse run */ }
  return { prevHash: 'genesis:' + runId, lastSeq: 0, lastIngestedMs: null };
}

/** walRecover — maak een eerder afgebroken append transactioneel af of ongedaan (Codex r4 #2).
 *  De WAL (events.jsonl.wal) wordt VOOR de append geschreven en gefsynct en NA een geslaagde append
 *  verwijderd. Bestaat hij nog bij de volgende lock-houder, dan is er precies een afgebroken poging:
 *    log == base_bytes           -> append landde nooit: payload alsnog appenden;
 *    log == base + payload       -> append landde volledig: alleen de WAL opruimen;
 *    base < log < base+payload   -> short write/ENOSPC-fragment: terugkappen naar base en her-appenden;
 *    log > base + payload        -> na het fragment is doorgeschreven zonder recovery: dat kan alleen
 *                                   buiten deze writer om — fail-closed laten aan de damage-classifier;
 *    log < base                  -> extern ingekort: fail-closed (niet "repareren" over tamper heen).
 *  Een onparseerbare/sha-mismatchende WAL is zelf het crash-artefact (de crash viel IN de WAL-write;
 *  de log is dan per constructie onaangeroerd) en wordt verwijderd. */
/** writeAllSync (Codex r6 #3): fs.writeSync mag partieel schrijven — lus tot ALLE bytes staan. */
function writeAllSync(fd, str, position) {
  const buf = Buffer.from(str, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off, position === null || position === undefined ? null : position + off);
    if (!(n > 0)) throw new Error('writeSync schreef 0 bytes (ENOSPC/afgebroken) — append geweigerd');
    off += n;
  }
  return buf.length;
}

function walRecover(eventsFile, walFile) {
  let wal;
  try { wal = JSON.parse(fs.readFileSync(walFile, 'utf8')); } catch { try { fs.unlinkSync(walFile); } catch { } return { ok: true, action: 'discarded-broken-wal' }; }
  const payload = typeof wal.payload === 'string' ? wal.payload : null;
  const base = Number(wal.base_bytes);
  if (payload === null || !Number.isFinite(base) || wal.payload_sha256 !== crypto.createHash('sha256').update(payload, 'utf8').digest('hex')) {
    try { fs.unlinkSync(walFile); } catch { } return { ok: true, action: 'discarded-broken-wal' };
  }
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  let size = 0;
  try { size = fs.statSync(eventsFile).size; } catch { size = 0; }
  if (size < base) return { ok: false, message: 'events log (' + size + 'B) is SMALLER than the WAL base (' + base + 'B) — externally truncated; refusing to repair over tampering (fail-closed)' };
  if (size === base + payloadBytes) {
    // r6 #4: verifieer dat de staart ECHT de payload is en fsync de log voordat de WAL verdwijnt —
    // anders kan een latere power loss de nog-vuile staart verliezen terwijl het vangnet al weg is.
    const fdv = fs.openSync(eventsFile, 'r+');
    try {
      const tailBuf = Buffer.alloc(payloadBytes);
      fs.readSync(fdv, tailBuf, 0, payloadBytes, base);
      if (!tailBuf.equals(Buffer.from(payload, 'utf8'))) {
        fs.closeSync(fdv);
        return { ok: false, message: 'events log heeft de WAL-lengte maar NIET de WAL-inhoud op de staart — extern bewerkt; fail-closed' };
      }
      fs.fsyncSync(fdv);
    } finally { try { fs.closeSync(fdv); } catch { } }
    try { fs.unlinkSync(walFile); } catch { }
    return { ok: true, action: 'append-was-complete' };
  }
  if (size > base + payloadBytes) return { ok: false, message: 'events log grew past an unresolved WAL (log ' + size + 'B, wal wil ' + (base + payloadBytes) + 'B) — a writer bypassed recovery; investigate (fail-closed)' };
  // base <= size < base+payload: fragment terugkappen en de volledige payload alsnog schrijven.
  const fd = fs.openSync(eventsFile, size === 0 && base === 0 ? 'a' : 'r+');
  try {
    fs.ftruncateSync(fd, base);
    writeAllSync(fd, payload, base);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.unlinkSync(walFile); } catch { }
  return { ok: true, action: size === base ? 'replayed' : 'truncated-and-replayed' };
}

/** appendChainedLocked — schrijf een of meer GEVALIDEERDE events onder EEN lock: WAL-recovery, damage-
 *  check, tail-read, per event prev_hash/seq/entry_hash, dan WAL -> append -> fsync -> WAL weg. De
 *  append is daarmee transactioneel: een crash/ENOSPC op elk punt laat of een intacte log zonder batch,
 *  of een intacte log met de VOLLEDIGE batch achter — nooit een fragment dat met een volgende regel
 *  versmelt (Codex r4 #2). Fencing: direct voor de append wordt geverifieerd dat de lock nog van ons is
 *  (Codex r4 #1) — zo niet, dan is er NIETS geschreven en faalt de aanroep eerlijk. */
/** opts.txnId (Codex r5 #3): een CALLER-stabiele idempotency-key maakt de append
 *  exact-once over crash-retries heen. De key wordt op elk event van de batch gestempeld (txn_id,
 *  mee-gehasht) en een volgende aanroep met dezelfde key is een bevestigde no-op
 *  (alreadyApplied:true) — ook wanneer een crash mid-append via de WAL is gerepareerd (de replay
 *  draagt dezelfde txn_id). Elk event krijgt bovendien een event_id (uuid, mee-gehasht) als de
 *  caller er geen meegaf. Additief schema: aanroepen zonder txnId gedragen zich exact als voorheen. */
function appendChainedLocked(runDir, events, opts) {
  opts = opts || {};
  fs.mkdirSync(runDir, { recursive: true });
  const eventsFile = path.join(runDir, 'events.jsonl');
  const walFile = eventsFile + '.wal';
  const lock = acquireEventsLock(runDir, opts);
  if (!lock.ok) return { ok: false, message: lock.message };
  try {
    /** r6 #1: txn_id/txn_sha/txn_count zijn WRITER-gestempelde velden. Een caller die ze zelf in de
     *  event-body meegeeft kan anders andermans toekomstige transactie voor-vervuilen (spoofing: de
     *  echte txn krijgt dan een valse "already applied"). Input met die velden wordt geweigerd. */
    for (const ev of events) {
      if (ev.txn_id !== undefined || ev.txn_sha256 !== undefined || ev.txn_count !== undefined) {
        return { ok: false, message: 'txn_id/txn_sha256/txn_count zijn writer-gestempelde velden — geef de idempotency-key via --txn / opts.txnId, nooit in de event-body (r6 #1)' };
      }
    }
    /** r6 #2: de idempotency-key is gebonden aan de CALLER-inhoud van de batch — dezelfde key met een
     *  ANDERE payload is geen retry maar een bug/aanval en wordt geweigerd i.p.v. stil ge-no-op't.
     *  De digest dekt uitsluitend de SEMANTISCHE caller-inhoud: alle volatiele/writer-gestempelde
     *  velden (timestamp — per aanroep vers gestempeld door validateForWrite —, _forge_verify,
     *  event_id en de keten-/txn-velden) zijn uitgesloten, anders is geen enkele retry ooit gelijk. */
    // ingested_at is writer-stamped per call, like timestamp — outside the content digest
    const TXN_VOLATILE = new Set(['timestamp', 'ingested_at', '_forge_verify', 'event_id', 'prev_hash', 'seq', 'entry_hash', 'txn_id', 'txn_sha256', 'txn_count']);
    const txnNormalize = (ev) => { const k = Object.keys(ev).filter((x) => !TXN_VOLATILE.has(x)).sort(); const o = Object.create(null); for (const x of k) o[x] = ev[x]; return o; };
    /** r6b #2: de digest sluit timestamp/event_id uit omdat de WRITER ze stempelt — maar een caller
     *  die ze ZELF meegaf kreeg daardoor dezelfde digest voor andere inhoud, en zijn tweede batch
     *  verdween stil. Onder een txn zijn deze velden daarom writer-only: caller-aangeleverde waarden
     *  worden geweigerd i.p.v. genegeerd. (Zonder txn verandert er niets — dan is er geen digest.) */
    if (opts.txnId) {
      for (const ev of events) {
        if (ev.event_id !== undefined) return { ok: false, message: 'event_id is onder een txn een WRITER-veld — geef het niet zelf mee (r6b #2); de writer stempelt een uniek, hash-gebonden id' };
      }
    }
    // an event that never passed validateForWrite (a library caller) gets the writer-owned stamps the
    // CLI path applies — BEFORE the txn digest, so a library run_started digests its writer baseline like the CLI does.
    for (const ev of events) stampLibraryEvent(ev, runDir);
    // Codex R3 SC-04 / R5 SV-04: owner_requests_reconciled is judged against the scribe gate on EVERY append, under the
    // events lock, and the writer's stamp is OVERWRITTEN from that verdict each time. No object-identity shortcut: the
    // same event object appended twice (its `final` flag or stamp changed in between, the gate turned red meanwhile) is
    // judged twice. The CLI's earlier check only prints its NOTE/refusal text; this one decides.
    for (const ev of events) {
      if (ev && ev.event_type === 'owner_requests_reconciled') {
        const sr = gateScribeEvent(ev, { claudeDir: claudeDirOfRunDir(runDir) });
        if (sr.decision === 'refuse') return { ok: false, refused: true, message: sr.lines.join('\n') };
      }
    }
    // Codex R3 SC-06: the scribe head anchor is writer-stamped here for every caller (any caller value is replaced).
    const scribeHeads = events.filter((ev) => ev && ev.event_type === 'scribe_head');
    if (scribeHeads.length) {
      const h = scribeHeadOf(claudeDirOfRunDir(runDir));
      if (!h) return { ok: false, message: 'scribe_head refused: the scribe is not in use in this project — nothing to anchor' };
      if (!fs.existsSync(eventsFile)) return { ok: false, message: 'scribe_head refused: this run has no event log yet — an anchor never opens a run' };
      for (const ev of scribeHeads) ev._forge_verify = Object.assign({}, ev._forge_verify && typeof ev._forge_verify === 'object' ? ev._forge_verify : {}, { scribe_head: h });
    }
    const txnSha = opts.txnId ? crypto.createHash('sha256').update(JSON.stringify(events.map(txnNormalize)), 'utf8').digest('hex') : null;
    if (fs.existsSync(walFile)) {
      const rec = walRecover(eventsFile, walFile);
      if (!rec.ok) return { ok: false, message: rec.message };
    }
    // Codex ronde-4 #2: appenden aan een PARTIAL/CORRUPT log liet de nieuwe regel met een
    // afgekapt fragment versmelten en ketende verder over kapot bewijs heen. Fail-closed ook op de
    // SCHRIJFkant: een beschadigde log wordt eerst onderzocht/gerepareerd, nooit stil doorgeschreven.
    // Sinds r4 #11 verifieert dit ook schema en hashketen, niet alleen JSON-parseerbaarheid.
    if (fs.existsSync(eventsFile)) {
      // schrijversbril: geketende hashes/linkage/seq hard geverifieerd, maar de legacy BACKSEARCH-vorm
      // (echte ongeketende events tussen geketende) blijft appendbaar — zie readEventsClassified.
      const cls = readEventsClassified(eventsFile, { verifyChain: true, runId: events[0].run_id, allowUnchainedAfterChained: true });
      if (cls.status === 'partial' || cls.status === 'corrupt') {
        return { ok: false, message: 'events log is ' + cls.status.toUpperCase() + ' (regel ' + cls.badLines.map((b) => b.line).join(',') + ') — refusing to append over a damaged log (fail-closed); investigate/repair first' };
      }
      // Codex R3 SC-06: an anchor never lands after the completion (it would reopen the run and make finalize refuse it)
      if (scribeHeads.length && runClosed(cls.entries)) return { ok: false, message: 'scribe_head refused: the run is closed (run_completed/run_finalized) — an anchor never reopens a finished run' };
      // exact-once (r5 #3 · inhoudsgebonden sinds r6 #2 · fail-closed op ambiguïteit sinds r6b #1):
      // dedupe ONDER de lock. Zelfde key + zelfde inhoud = bevestigde no-op; zelfde key + ANDERE
      // inhoud = harde weigering; zelfde key ZONDER verifieerbare digest = ambigu, dus ook geweigerd.
      if (opts.txnId) {
        const hit = cls.entries.find((e) => e && e.txn_id === opts.txnId);
        if (hit) {
          /** r6b #1: een hit ZONDER opgeslagen digest is niet te verifiëren — het kan een record van
           *  vóór de digest-invoering zijn, maar net zo goed een gespoofte legacy-regel die een echte
           *  latere transactie stil laat no-oppen. Ambigu = FAIL-CLOSED: de aanroeper moet het
           *  onderzoeken en desnoods een nieuwe key kiezen, nooit stilzwijgend "al toegepast" horen. */
          if (!hit.txn_sha256) {
            return { ok: false, message: 'txn-key ' + opts.txnId + ' komt voor in de log ZONDER verifieerbare digest (pre-r6-record of gespoofd) — ambigu, dus fail-closed (r6b #1): onderzoek de regel of gebruik een nieuwe key' };
          }
          if (hit.txn_sha256 !== txnSha || Number(hit.txn_count) !== events.length) {
            return { ok: false, message: 'txn-key ' + opts.txnId + ' is al gebruikt met ANDERE inhoud (digest/count wijkt af) — sleutelhergebruik met een andere batch is geen retry; kies een nieuwe key (r6 #2)' };
          }
          return { ok: true, written: 0, alreadyApplied: true, txn_id: opts.txnId, message: 'txn ' + opts.txnId + ' is al toegepast — idempotente no-op (exact-once, digest geverifieerd)' };
        }
      }
    }
    const tail = chainTail(eventsFile, events[0].run_id);
    let prevHash = tail.prevHash;
    let seq = tail.lastSeq;
    const lines = [];
    /** the authoritative ingestion instant is stamped HERE, under the lock, right before the entry hash
     *  binds it — so no caller and no pre-lock delay can move it. A claimed_ts earlier than the previous
     *  event's ingestion (chainTail's lastIngestedMs, or this batch's predecessor) is flagged, never silently
     *  accepted as the order of events. */
    let prevIngestedMs = Number.isFinite(tail.lastIngestedMs) ? tail.lastIngestedMs : null;
    const backdated = [];
    const stampedAt = nowIso();
    for (const ev of events) {
      if (!ev.event_id) ev.event_id = crypto.randomUUID();
      const claimedBefore = Object.prototype.hasOwnProperty.call(ev, 'claimed_ts') ? ev.claimed_ts : undefined;
      if (!Object.prototype.hasOwnProperty.call(ev, 'ingested_at') || !Object.prototype.hasOwnProperty.call(ev, 'timestamp')) stampWriterTime(ev, stampedAt); // a library caller that skipped validateForWrite
      ev.ingested_at = stampedAt; ev.timestamp = stampedAt;
      if (claimedBefore !== undefined) ev.claimed_ts = claimedBefore;
      const claimedMs = typeof ev.claimed_ts === 'string' ? Date.parse(ev.claimed_ts) : (typeof ev.claimed_ts === 'number' ? ev.claimed_ts : NaN);
      if (Number.isFinite(claimedMs) && prevIngestedMs !== null && claimedMs < prevIngestedMs) {
        ev._forge_verify = Object.assign(ev._forge_verify || {}, { claimed_ts_backdated: true, claimed_ts_warning: 'claimed_ts ' + ev.claimed_ts + ' lies BEFORE the previous event was ingested (' + new Date(prevIngestedMs).toISOString() + ') — the claim is kept verbatim, but ordering and every cutoff use ingested_at' });
        backdated.push(ev.event_type);
      }
      prevIngestedMs = Date.parse(stampedAt);
      if (opts.txnId) { ev.txn_id = opts.txnId; ev.txn_sha256 = txnSha; ev.txn_count = events.length; }
      ev.prev_hash = prevHash;
      ev.seq = ++seq;
      const canon = (() => { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = Object.create(null); for (const x of k) o[x] = ev[x]; return JSON.stringify(o); })();
      ev.entry_hash = crypto.createHash('sha256').update(canon + prevHash).digest('hex');
      prevHash = ev.entry_hash;
      lines.push(JSON.stringify(ev));
    }
    const payload = lines.join('\n') + '\n';
    let baseBytes = 0;
    try { baseBytes = fs.statSync(eventsFile).size; } catch { baseBytes = 0; }
    if (!stillOwnsLock(lock)) return { ok: false, message: 'events lock lost before append (fencing) — refusing to write; nothing was appended' };
    // WAL eerst (durable), dan de append, dan fsync van de log, dan pas de WAL weg.
    const wfd = fs.openSync(walFile, 'w');
    try {
      writeAllSync(wfd, JSON.stringify({ base_bytes: baseBytes, payload_sha256: crypto.createHash('sha256').update(payload, 'utf8').digest('hex'), payload })); // r6 #3: alle bytes, gegarandeerd
      fs.fsyncSync(wfd);
    } finally { fs.closeSync(wfd); }
    const afd = fs.openSync(eventsFile, 'a');
    try {
      writeAllSync(afd, payload); // r6 #3
      fs.fsyncSync(afd);
    } finally { fs.closeSync(afd); }
    try { fs.unlinkSync(walFile); } catch { /* recovery ruimt hem anders op als append-was-complete */ }
    return Object.assign({ ok: true, written: events.length }, backdated.length ? { backdated } : {});
  } finally { releaseEventsLock(lock); }
}

/** readEventsClassified — DE centrale JSONL-foutsemantiek. Elke completion-gate
 *  hoort deze toestanden te onderscheiden i.p.v. "onleesbaar = geen events" (fail-open):
 *    missing — bestand bestaat niet · empty — bestaat maar bevat geen enkele regel ·
 *    partial — alleen de LAATSTE regel is onparseerbaar (afgekapte staart: een crash mid-append) ·
 *    corrupt — een NIET-laatste regel is onparseerbaar (echte beschadiging/bewerking) · valid.
 *  entries bevat alle wel-parseerbare events; badLines de onparseerbare met regelnummer. */
function readEventsClassified(file, opts) {
  opts = opts || {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { status: 'missing', entries: [], badLines: [], error: e.code || e.message }; }
  const rawLines = raw.split(/\r?\n/);
  const entries = [], badLines = [], entryLines = [];
  let lastNonBlank = -1;
  for (let i = 0; i < rawLines.length; i++) { if (rawLines[i].trim()) lastNonBlank = i; }
  if (lastNonBlank === -1) return { status: 'empty', entries: [], badLines: [] };
  for (let i = 0; i <= lastNonBlank; i++) {
    const s = rawLines[i].trim();
    if (!s) continue;
    try { entries.push(JSON.parse(s)); entryLines.push(i + 1); }
    catch { badLines.push({ line: i + 1, snippet: s.slice(0, 80) }); }
  }
  if (badLines.length > 0) {
    const onlyTail = badLines.length === 1 && badLines[0].line === lastNonBlank + 1;
    return { status: onlyTail ? 'partial' : 'corrupt', entries, badLines };
  }
  /** verifyChain (Codex r4 #11): "parseert als JSON" was hier het hele oordeel — een
   *  omgezette check_failed->check_passed (hash klopt niet meer), een seq-gat/fork of een kaal {a:1}
   *  telde als 'valid' en completion-consumers (runcontract/finalize) vertrouwden het. Onder deze vlag
   *  wordt schema + keten hard gevalideerd: plain object, event_type, run_id (indien opgegeven),
   *  genesis-anker, prev_hash-koppeling, seq strikt +1 zodra aanwezig, en de HERBEREKENDE entry_hash
   *  (zelfde canonical als de writer). Een ongeketende LEGACY-kop (entries zonder entry_hash voor het
   *  eerste geketende event) blijft toegestaan; na het eerste geketende event is ongeketend = corrupt.
   *  Weergave-consumenten houden de parse-only default — dit is de completion-poort. */
  if (opts.verifyChain) {
    const bad = (idx, reason) => ({ status: 'corrupt', entries, badLines: [{ line: entryLines[idx], snippet: JSON.stringify(entries[idx]).slice(0, 80), reason }] });
    /** Codex r5 #4: een ongeketende KOP voor de eerste geketende entry was overal toegestaan
     *  — een aanvaller kon dus hashloze "bewijs"-events VOOR de keten invoegen (de eerste echte entry
     *  bleef correct naar genesis wijzen) en completion-consumers telden ze mee. Strikte bril: een log
     *  die geketende entries BEVAT mag geen enkele ongeketende entry dragen (mixed = corrupt). Een
     *  volledig ongeketend legacy-log blijft leesbaar (historische runs), en de schrijversbril
     *  (allowUnchainedAfterChained) accepteert de BACKSEARCH-mengvorm bewust — appends aan legacy-runs
     *  blijven mogelijk, maar zo'n run kan nooit meer een strikte completion-poort passeren. */
    const hasChained = entries.some((e) => e && typeof e === 'object' && e.entry_hash !== undefined);
    let prevHash = null, prevSeq = null, chained = false;
    for (let i = 0; i < entries.length; i++) {
      const ev = entries[i];
      if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) return bad(i, 'not a plain object');
      if (typeof ev.event_type !== 'string' || !ev.event_type) return bad(i, 'missing/invalid event_type');
      if (Object.keys(ev).some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) return bad(i, 'forbidden prototype-polluting key');
      if (ev.entry_hash === undefined) {
        if (hasChained && !opts.allowUnchainedAfterChained) return bad(i, 'unchained entry in a chained log (unanchored injection)');
        /** Twee striktheden: completion-consumers (runcontract/finalize) weigeren een
         *  ongeketend event NA een geketend — een aanvaller zou anders hashloze "bewijs"-events kunnen
         *  bijschrijven. Maar de WRITER (damage-gate voor een append) moet de historisch ondersteunde
         *  BACKSEARCH-vorm blijven accepteren: oude runs bevatten echte ongeketende events tussen
         *  geketende (de keten springt aantoonbaar over ze heen — chainTail koppelt aan de laatste
         *  GEKETENDE voorouder). opts.allowUnchainedAfterChained kiest de schrijversbril; de geketende
         *  entries zelf worden in beide standen volledig geverifieerd. */
        if (chained && !opts.allowUnchainedAfterChained) return bad(i, 'unchained entry after a chained one');
        /** EVENT-RUN-BINDING-GAP (out-p5.md) — this `continue` ran BEFORE any run_id check, so
         *  an unchained/legacy entry carrying a FOREIGN run_id (`ev.run_id:"OTHER"` inside a log being read
         *  for run "THIS") was classified valid regardless — reproduced: exactly that shape read as valid
         *  for the wrong run. An entry whose run_id field is genuinely ABSENT (true pre-stamping legacy, or a
         *  narrow unit fixture that never set one) still gets the historical free pass, unchanged — only a
         *  run_id that is PRESENT and WRONG is now rejected here, closing the reproduced gap without
         *  reclassifying every run_id-less fixture across this project's own test suites as corrupt. */
        if (opts.runId && ev.run_id !== undefined && ev.run_id !== opts.runId) return bad(i, 'run_id mismatch (' + String(ev.run_id).slice(0, 40) + ') on an unchained/legacy entry');
        continue; // legacy-entry: draagt soms geen run_id/seq — schema-checks hierboven gelden wel
      }
      // run_id-binding geldt voor GEKETENDE entries (de writer zet run_id altijd; een geketend event van
      // een andere run in deze log is per definitie manipulatie).
      if (opts.runId && ev.run_id !== opts.runId) return bad(i, 'run_id mismatch (' + String(ev.run_id).slice(0, 40) + ')');
      const expectedPrev = chained ? prevHash : (opts.runId ? 'genesis:' + opts.runId : ev.prev_hash);
      if (ev.prev_hash !== expectedPrev) return bad(i, 'prev_hash broken (chain fork or edit)');
      const canon = (() => { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = Object.create(null); for (const x of k) o[x] = ev[x]; return JSON.stringify(o); })();
      const recomputed = crypto.createHash('sha256').update(canon + ev.prev_hash).digest('hex');
      if (ev.entry_hash !== recomputed) return bad(i, 'entry_hash does not match recomputed content hash');
      if (ev.seq !== undefined) {
        const s = Number(ev.seq);
        if (!Number.isFinite(s) || s < 1) return bad(i, 'invalid seq');
        if (prevSeq !== null && s !== prevSeq + 1) return bad(i, 'seq not monotone (+1): ' + prevSeq + ' -> ' + s);
        prevSeq = s;
      } else if (prevSeq !== null) {
        return bad(i, 'seq missing after sequenced entries');
      }
      prevHash = ev.entry_hash;
      chained = true;
    }
  }
  return { status: 'valid', entries, badLines };
}

function flagsTag(v) {
  // only emit a tag when there is real flag content — otherwise accepted events printed a confusing ' []'
  const flags = v ? [v.event_type_unknown ? 'UNKNOWN-TYPE' : '', v.agent_registered === false ? 'UNREGISTERED' : '', v.proof_verified === false ? 'UNVERIFIED' : '', v.dispatch_unverified ? 'NO-DISPATCH-ID' : '', v.model_unverified ? 'MODEL-UNVERIFIED' : '', v.review_dispatch_counts_as_work ? 'REVIEW-DISPATCH-COUNTS-AS-WORK' : '', v.file_hashes_replaced ? 'FILE-HASHES-REPLACED' : '', v.claimed_ts_backdated ? 'CLAIMED-TS-BACKDATED' : ''].filter(Boolean) : [];
  return flags.length ? ' [' + flags.join(' ') + ']' : '';
}
/** printRunBaselineNotice(ev) — part B. One stderr NOTE when a run_started baseline is degraded or was
 *  replaced, so the memory-files-touched rule never silently loses its baseline. Exit code is unaffected. */
function printRunBaselineNotice(ev) {
  if (!ev || ev.event_type !== 'run_started') return;
  const parts = [];
  if (ev.file_hashes_unavailable) parts.push('no file_hashes baseline — ' + ev.file_hashes_unavailable);
  if (Array.isArray(ev.file_hashes_unreadable) && ev.file_hashes_unreadable.length) parts.push('file_hashes baseline skipped unreadable file(s): ' + ev.file_hashes_unreadable.map((x) => x.file + ' (' + x.error + ')').join(', '));
  if (ev._forge_verify && ev._forge_verify.file_hashes_replaced) parts.push('a caller-supplied file_hashes baseline was replaced by the writer snapshot (the baseline is writer-owned)');
  if (parts.length) console.error('forge-log-event: NOTE run_started — ' + parts.join('; ') + ' (the event was still written)');
}
/** printReviewDispatchWarning(v) — lesson fix. The event is still WRITTEN either way (see
 *  verifyEvent()'s own doc comment above for why refusing here would be worse); this only makes the
 *  consequence impossible to miss on the terminal, in both languages, right when it happens. */
function printReviewDispatchWarning(v) {
  if (v && v.review_dispatch_counts_as_work) console.error('forge-log-event: WARNING — ' + v.review_dispatch_warning);
}

/** ================= COMPLETION GATE =================
 *  This writer is the one place every completion passes through, so it judges run_completed before writing it:
 *  forge-runcontract.cjs::completionGate() evaluates, IN-PROCESS, the complete-phase run contract plus every
 *  completion_sequence step before run-completed (gate evidence, final-report.md, a fresh green contract proof).
 *  The finalize receipt is not part of it — finalize comes after run_completed.
 *   - default (WARN): the unmet obligations go to stderr and the event is still written (exit 0);
 *   - FORGE_COMPLETION_GATE=strict: refused with exit 2 and NOTHING is written (a batch is refused as a whole);
 *   - an honest failure close (run_completed with status/outcome/verdict/result "failed" etc.) is not gated;
 *   - fail-safe: when the checker cannot be loaded, or the run cannot be judged (unreadable folder, damaged log),
 *     a NOTE goes to stderr and the event is written in BOTH modes — a tool failure never blocks a completion.
 *  Known limits: the gate reads the log without the events lock (a concurrent append can land in between —
 *  finalize re-checks everything anyway), and batch lines before run_completed carry no chain hashes yet, so a
 *  review completion logged in the same batch can read as unbound — log run_completed in its own call. */
const COMPLETION_GATE_ENV = 'FORGE_COMPLETION_GATE';
function completionGateMode() {
  return String(process.env[COMPLETION_GATE_ENV] || '').trim().toLowerCase() === 'strict' ? 'strict' : 'warn';
}
/** evaluateCompletionGate(ev, pendingBefore, opts) -> {decision:'skip'|'pass'|'warn'|'refuse'|'unavailable', lines, gate?}.
 *  Never throws. opts.mode / opts.runcontract / opts.claudeDir exist for tests (defaults: env / this project). */
/** FAILURE-CLOSE PREDICATE — the ONE definition lives in forge-runcontract.cjs (isFailureClose). This
 *  mirror is used ONLY when that module cannot be loaded at all (then strict mode must still let an honest
 *  failure close through); log-event-completion-gate.test.cjs asserts the mirror equals the exported original
 *  byte for byte, so it can never drift unnoticed. */
const FAILURE_CLOSE_FIELDS_MIRROR = ['status', 'outcome', 'verdict', 'result'];
const FAILURE_CLOSE_RE_MIRROR = /^(?:fail|failed|failure|aborted|abandoned|cancell?ed|blocked|refused|incomplete|partial)$/i;
function isFailureCloseEvent(ev, rc) {
  if (rc && typeof rc.isFailureClose === 'function') { try { return rc.isFailureClose(ev) === true; } catch { /* fall through to the mirror */ } }
  if (!ev || typeof ev !== 'object') return false;
  return FAILURE_CLOSE_FIELDS_MIRROR.some((f) => typeof ev[f] === 'string' && FAILURE_CLOSE_RE_MIRROR.test(ev[f].trim()));
}
function evaluateCompletionGate(ev, pendingBefore, opts) {
  opts = opts || {};
  if (!ev || ev.event_type !== 'run_completed') return { decision: 'skip', lines: [] };
  const mode = opts.mode || completionGateMode();
  const rc = opts.runcontract !== undefined ? opts.runcontract : RUNCONTRACT;
  const root = path.resolve(opts.claudeDir || CLAUDE_DIR, '..');
  const runId = String(ev.run_id || '');
  /** in STRICT mode an evaluation that is UNAVAILABLE (checker not
   *  loadable, or it threw) REFUSES a successful completion — "the gate could not run" must never read as
   *  "the gate passed" when the owner asked for strict. An honest failure/incomplete close is still written
   *  (it claims nothing). Default warn mode stays fail-open with a loud NOTE. */
  const unavailable = (what) => {
    if (mode === 'strict' && !isFailureCloseEvent(ev, rc)) {
      return { decision: 'refuse', unavailable: true, lines: ['forge-log-event: COMPLETION GATE REFUSED run_completed for ' + runId + ' (' + COMPLETION_GATE_ENV + '=strict) — the gate could not be evaluated: ' + what + '. Under strict an unevaluable completion is not written (a failure close — status/outcome/verdict/result failed|aborted|blocked|… — would be). Repair the checker or check by hand: node .claude/forge-bin/forge-runcontract.cjs check --run ' + runId] };
    }
    return { decision: 'unavailable', lines: ['forge-log-event: NOTE completion gate unavailable — ' + what + '; run_completed is written without the gate' + (mode === 'strict' ? ' (honest failure close)' : ' (a tool failure never blocks a completion in warn mode; with ' + COMPLETION_GATE_ENV + '=strict it would be refused)') + '. Check by hand: node .claude/forge-bin/forge-runcontract.cjs check --run ' + runId] };
  };
  if (!rc || typeof rc.completionGate !== 'function') return unavailable('forge-runcontract.cjs (completionGate) could not be loaded');
  let g;
  try { g = rc.completionGate({ run_id: runId, event: ev }, { root, extraEvents: Array.isArray(pendingBefore) ? pendingBefore : [], strict: mode === 'strict' }); }
  catch (e) { return unavailable('the checker could not judge run ' + runId + ' (' + shortReason(e) + ')'); }
  /** a checker verdict that is null/undefined, carries no boolean ok, or says
   *  "not applicable" for a completion that is NOT an honest failure close used to read as a PASS ("no gate, so
   *  through"). Every such outcome is now unavailable: refused under strict (a failure close still passes),
   *  written with a NOTE in warn mode — never silently passed. */
  if (g === null || g === undefined || typeof g !== 'object') return unavailable('the checker returned no verdict for run ' + runId + ' (' + String(g) + ')');
  if (g.applicable === false) {
    if (g.failure_close === true && isFailureCloseEvent(ev, rc)) {
      return { decision: 'pass', gate: g, lines: ['forge-log-event: NOTE run_completed for ' + runId + ' is an honest failure close — no completion is claimed, the completion gate does not apply, and this run cannot be finalized'] };
    }
    return unavailable('the checker called the gate not applicable to a run_completed that is not an honest failure close (run ' + runId + ')');
  }
  if (typeof g.ok !== 'boolean') return unavailable('the checker returned no ok/not-ok verdict for run ' + runId);
  // a step the checker could not judge (unknown id from a newer registry, contract not evaluable) is UNMET
  // under strict — also when an older checker without opts.strict reported it as merely 'unevaluated'.
  const unevaluatedSteps = (g.steps || []).filter((x) => x && x.status === 'unevaluated');
  const unevaluatedRules = Array.isArray(g.unevaluated_rules) ? g.unevaluated_rules : [];
  const strictUnmet = mode === 'strict' && (unevaluatedSteps.length > 0 || unevaluatedRules.length > 0);
  const warnText = (g.warnings || []).length ? 'open warn rule(s) (non-blocking): ' + g.warnings.join(', ') : '';
  if (g.ok && !strictUnmet) {
    const notes = [];
    if (warnText) notes.push('forge-log-event: NOTE completion gate met for ' + runId + ' — ' + warnText);
    if (unevaluatedSteps.length || unevaluatedRules.length) notes.push('forge-log-event: NOTE run ' + runId + ' — ' + unevaluatedSteps.map((s) => 'step ' + s.step + ' ' + s.id).concat(unevaluatedRules.map((r) => 'rule ' + r)).join(', ') + ' could not be judged by this checker (unevaluated); with ' + COMPLETION_GATE_ENV + '=strict this run_completed would be refused');
    return { decision: 'pass', gate: g, lines: notes };
  }
  const lines = [mode === 'strict'
    ? 'forge-log-event: COMPLETION GATE REFUSED run_completed for ' + runId + ' (' + COMPLETION_GATE_ENV + '=strict) — nothing was written; the completion sequence is not met:'
    : 'forge-log-event: COMPLETION GATE WARNING — run_completed for ' + runId + ' is written, but the completion sequence is not met:'];
  if (g.empty) lines.push('  ✗ ' + g.reason);
  else for (const s of (g.steps || []).filter((x) => x.status === 'pending' || x.status === 'red' || (mode === 'strict' && x.status === 'unevaluated'))) {
    lines.push('  ✗ step ' + s.step + ' ' + s.id + ' — ' + (s.status === 'unevaluated' ? '[unevaluated — unmet under strict] ' : '') + String(s.detail).slice(0, 220) + (s.command ? ' → ' + s.command : ''));
  }
  if (mode === 'strict' && unevaluatedRules.length) lines.push('  ✗ contract rule(s) this checker cannot judge (unmet under strict): ' + unevaluatedRules.join(', '));
  if (warnText) lines.push('  ⚠ ' + warnText);
  lines.push('  next: ' + (g.plan_command || ('node .claude/forge-bin/forge-runcontract.cjs plan --run ' + runId)) + (mode === 'strict' ? '' : ' · with ' + COMPLETION_GATE_ENV + '=strict this event would be refused'));
  return { decision: mode === 'strict' ? 'refuse' : 'warn', gate: g, lines };
}
function printCompletionGate(res) {
  if (res && Array.isArray(res.lines)) for (const l of res.lines) console.error(l);
}
/** stampCompletionGate(ev, res, mode) — Codex R2/N07: the writer records ITS OWN gate verdict on the
 *  run_completed it writes, as `_forge_verify.completion_gate {decision, mode, sequence_source, unmet}` (hash-
 *  chained with the event). forge-finalize reads it: a claim written in WARN mode over a registry-declared, unmet
 *  sequence is never finalized — the agent finishes the sequence and logs run_completed again. Writer-owned: a
 *  caller-supplied completion_gate is always overwritten here (and stripped on library appends, see
 *  appendChainedLocked). Mutates ev; only run_completed is stamped. */
function stampCompletionGate(ev, res, mode) {
  if (!ev || ev.event_type !== 'run_completed' || !res || res.decision === 'skip') return ev;
  const g = res.gate && typeof res.gate === 'object' ? res.gate : null;
  const stamp = {
    decision: String(res.decision), mode: mode || completionGateMode(),
    sequence_source: g && typeof g.sequence_source === 'string' ? g.sequence_source : null,
    unmet: g && Array.isArray(g.unmet) ? g.unmet.slice(0, 20).map(String) : [],
  };
  if (g && g.failure_close === true) stamp.failure_close = true;
  ev._forge_verify = Object.assign({}, ev._forge_verify && typeof ev._forge_verify === 'object' ? ev._forge_verify : {}, { completion_gate: stamp });
  return ev;
}

/** ================= OWNER-REQUESTS RECONCILIATION (part ii) =================
 *  evaluateScribeReconciliation(ev, opts) -> {decision:'skip'|'pass'|'not-applicable'|'refuse', lines, stamp?}. See the
 *  header doc (SCRIBE RECONCILIATION). Never throws. opts.claudeDir / opts.scribe exist for tests (defaults: this
 *  writer's own project and its forge-bin/forge-scribe.cjs). */
const SCRIBE_REFUSE_LIST_MAX = 8;
const intOrNull = (v) => (Number.isInteger(v) ? v : null);
const hexOrNull = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);
function evaluateScribeReconciliation(ev, opts) {
  opts = opts || {};
  if (!ev || ev.event_type !== 'owner_requests_reconciled') return { decision: 'skip', lines: [] };
  const claudeDir = opts.claudeDir || CLAUDE_DIR;
  const root = path.resolve(claudeDir, '..');
  const runId = String(ev.run_id || '');
  const final = ev.final !== false; // Codex R3 SC-05: completion-time reconciliation is FINAL unless explicitly progress-only
  const gateCmd = 'node .claude/forge-bin/forge-scribe.cjs gate' + (final ? ' --final' : '');
  const refuse = (why) => ({ decision: 'refuse', lines: ['forge-log-event: OWNER REQUESTS NOT RECONCILED — owner_requests_reconciled for ' + runId + ' REFUSED (exit 2, nothing written): ' + why + '. Check by hand: ' + gateCmd] });
  let SC = opts.scribe;
  if (SC === undefined) {
    const tool = path.join(claudeDir, 'forge-bin', 'forge-scribe.cjs');
    const store = path.join(claudeDir, 'forge-scribe');
    // SC-07: an inbox without a ledger (a crash between the two appends) is the scribe IN USE, never "nothing captured"
    const inUse = fs.existsSync(path.join(store, 'ledger.jsonl')) || fs.existsSync(path.join(store, 'inbox.jsonl'));
    if (!fs.existsSync(tool) || !inUse) {
      return { decision: 'not-applicable', stamp: { decision: 'not-applicable', final },
        lines: ['forge-log-event: NOTE owner_requests_reconciled for ' + runId + ' — the scribe is not in use in this project (' + (fs.existsSync(tool) ? 'nothing captured yet: no .claude/forge-scribe/ledger.jsonl or inbox.jsonl' : 'no forge-bin/forge-scribe.cjs') + '), so there is nothing to reconcile; the event is written'] };
    }
    try { SC = require(tool); } catch (e) { return refuse('forge-scribe.cjs could not be loaded (' + shortReason(e) + ') — a reconciliation nobody could check is not written'); }
  }
  if (!SC || typeof SC.gate !== 'function') return refuse('this forge-scribe.cjs has no gate() — the reconciliation cannot be checked');
  let g;
  try { g = SC.gate({ root, final }); } catch (e) { return refuse('the scribe gate could not be evaluated (' + shortReason(e) + ')'); }
  if (!g || typeof g.ok !== 'boolean') return refuse('the scribe gate returned no verdict');
  const counts = g.counts && typeof g.counts === 'object' ? g.counts : {};
  if (!g.ok) {
    const blocking = Array.isArray(g.blocking) ? g.blocking : [];
    const problems = Array.isArray(g.problems) ? g.problems : [];
    const lines = ['forge-log-event: OWNER REQUESTS NOT RECONCILED — owner_requests_reconciled for ' + runId + ' REFUSED (exit 2, nothing written): ' + gateCmd + ' reports ' + blocking.length + ' item(s) still ' + (final ? 'open, done-but-not-acked or proposed for deferral without the owner' : 'unclassified, open, planned or in-progress') + (problems.length ? ' and ' + problems.length + ' integrity problem(s)' : '') + ':'];
    for (const b of blocking.slice(0, SCRIBE_REFUSE_LIST_MAX)) lines.push('  ✗ ' + (b.rid || b.pid) + ' [' + b.class + '|' + b.status + '] ' + String(b.title || '').slice(0, 90));
    if (blocking.length > SCRIBE_REFUSE_LIST_MAX) lines.push('  … +' + (blocking.length - SCRIBE_REFUSE_LIST_MAX) + ' more (node .claude/forge-bin/forge-scribe.cjs list)');
    for (const p of problems.slice(0, 3)) lines.push('  ! ' + String(p).slice(0, 200));
    lines.push('  next: plan (forge-scribe link R-n --wp <wp> --run ' + runId + '), finish (transition R-n done --evidence ...), propose a carry-over (transition R-n defer --reason "..."), answer a question/ack (transition R-n answer)' + (final ? ', then present the done items and the proposed deferrals to the owner for one batched ack (transition R-n ack --prompt P-n)' : '') + ' — then log owner_requests_reconciled again');
    return { decision: 'refuse', lines };
  }
  return { decision: 'pass', lines: [], stamp: {
    decision: 'pass', final, ledger_head: typeof g.ledger_head === 'string' ? g.ledger_head : null,
    ledger_lines: intOrNull(g.ledger_lines), ledger_bytes: intOrNull(g.ledger_bytes), scribe_ledger_sha256: hexOrNull(g.ledger_sha256),
    inbox_head: typeof g.inbox_head === 'string' ? g.inbox_head : null, inbox_lines: intOrNull(g.inbox_lines), chain_ok: g.chain_ok === true,
    counts: { deferred: counts.deferred || 0, defer_proposed: counts.defer_proposed || 0, done_unacked: counts.done_unacked || 0, acked: counts.acked || 0, cancelled: counts.cancelled || 0, answered: counts.answered || 0 },
  } };
}
function printScribeReconciliation(res) {
  if (res && Array.isArray(res.lines)) for (const l of res.lines) console.error(l);
}
/** stampScribeReconciliation(ev, res) — the writer's own verdict on owner_requests_reconciled, replacing any
 *  caller-supplied one (writer-owned, like completion_gate). Mutates ev. A caller that stamps through this export is
 *  still re-judged by appendChainedLocked, which re-evaluates and overwrites the stamp on every append (R5 SV-04). */
function stampScribeReconciliation(ev, res) {
  if (!ev || ev.event_type !== 'owner_requests_reconciled' || !res || !res.stamp) return ev;
  ev._forge_verify = Object.assign({}, ev._forge_verify && typeof ev._forge_verify === 'object' ? ev._forge_verify : {}, { scribe_gate: Object.assign({}, res.stamp) });
  return ev;
}
/** gateScribeEvent(ev, opts) — judge owner_requests_reconciled and stamp the verdict (a fresh object each time). Codex R5
 *  SV-04: there is NO identity-based authorization any more (the R3 WeakSet let a judged object be mutated —
 *  progress stamp turned final, gate turned red — and appended again unjudged); appendChainedLocked calls this for every
 *  append under the events lock, so the stamp written is always the verdict of that append. A refusal also strips any
 *  stamp the object carries, so a refused object never keeps an earlier pass. */
function gateScribeEvent(ev, opts) {
  const res = evaluateScribeReconciliation(ev, opts);
  if (res.decision !== 'refuse' && res.decision !== 'skip') stampScribeReconciliation(ev, res);
  else if (res.decision === 'refuse' && ev && ev._forge_verify && typeof ev._forge_verify === 'object' && Object.prototype.hasOwnProperty.call(ev._forge_verify, 'scribe_gate')) {
    const fv = Object.assign({}, ev._forge_verify);
    delete fv.scribe_gate;
    if (Object.keys(fv).length) ev._forge_verify = fv; else delete ev._forge_verify;
  }
  return res;
}
/** scribeHeadOf(claudeDir) -> {ledger_lines, ledger_head, ledger_bytes, inbox_lines, inbox_head} | null (not in use) —
 *  Codex R3 SC-06. The definition forge-scribe.cjs (checkAnchors) checks: the non-empty lines of each file up to its last
 *  newline (a write in flight is not anchored), head = sha256 of the last such line. Pure reading, no project code. */
function scribeHeadOf(claudeDir) {
  const dir = path.join(claudeDir, 'forge-scribe');
  const one = (f) => {
    let txt;
    try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { lines: 0, head: null, bytes: 0 } : null; }
    const cut = txt.lastIndexOf('\n');
    const complete = cut >= 0 ? txt.slice(0, cut + 1) : '';
    const lines = complete.split('\n').filter((l) => l.trim());
    return { lines: lines.length, head: lines.length ? crypto.createHash('sha256').update(lines[lines.length - 1], 'utf8').digest('hex') : null, bytes: Buffer.byteLength(complete, 'utf8') };
  };
  const l = one('ledger.jsonl'), i = one('inbox.jsonl');
  if (!l || !i || (!l.lines && !i.lines)) return null;
  return { ledger_lines: l.lines, ledger_head: l.head, ledger_bytes: l.bytes, inbox_lines: i.lines, inbox_head: i.head };
}
const RUN_CLOSED_AUDIT = new Set(['run_finalized', 'gate_evaluated', 'contract_checked']);
/** runClosed(entries) — finalized, or run_completed with only audit events after it (same rule as findActiveRun). */
function runClosed(entries) {
  if (entries.some((e) => e && e.event_type === 'run_finalized')) return true;
  let last = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i] && entries[i].event_type === 'run_completed') last = i;
  return last >= 0 && entries.slice(last + 1).every((e) => e && RUN_CLOSED_AUDIT.has(e.event_type));
}

// ---- CLI ----
function mainCli() {
  const args = process.argv.slice(2);
  // BATCH-MODUS (all-or-nothing sinds Codex r4 #2): leest JSONL-events
  // van stdin (een object per regel, event_type verplicht; run_id komt van het argument) en schrijft ze
  // onder EEN lock met EEN node-boot. Elke regel doorloopt exact dezelfde validatie/STRICT-poort, maar de
  // batch is een TRANSACTIE: een geweigerde regel weigert de HELE batch (exit 2, NIETS geschreven), zodat
  // een retry na een fout nooit de eerder-geaccepteerde regels dupliceert. Wie partial-commit wil, splitst
  // zijn batch zelf.
  if (args[0] === '--batch') {
    const runId = args[1];
    const rd = resolveRunDir(runId);
    if (!rd.ok) { console.error(rd.message); process.exit(1); }
    // r5 #3: optionele caller-stabiele idempotency-key — dezelfde batch na een crash/onzekere exit
    // opnieuw aanbieden met dezelfde --txn is een bevestigde no-op (exit 0, 'txn already applied').
    let txnId = null;
    const txnIdx = args.indexOf('--txn');
    if (txnIdx !== -1) {
      txnId = args[txnIdx + 1] || '';
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(txnId)) { console.error('batch: --txn moet [A-Za-z0-9_-]{8,128} zijn (caller-stabiel over retries)'); process.exit(1); }
    }
    let stdin = '';
    try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; }
    const lines = stdin.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { console.error('batch: no events on stdin (one JSON object per line)'); process.exit(1); }
    const accepted = [];
    let refusals = 0;
    for (let i = 0; i < lines.length; i++) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch (e) { console.error('batch line ' + (i + 1) + ': invalid JSON: ' + e.message); refusals++; continue; }
      // r6b #2: onder een txn zijn timestamp en event_id WRITER-velden. Ze vallen buiten de
      // inhouds-digest (de writer stempelt ze per aanroep vers), dus een caller die ze zelf meegeeft
      // zou met dezelfde key andere inhoud kunnen aanbieden die stil verdwijnt. Weiger ze expliciet —
      // dit wordt VOOR validateForWrite gecontroleerd, want die stempelt timestamp zelf.
      if (txnId && (Object.prototype.hasOwnProperty.call(ev, 'timestamp') || Object.prototype.hasOwnProperty.call(ev, 'event_id'))) {
        console.error('batch line ' + (i + 1) + ': timestamp/event_id zijn onder --txn writer-velden — laat ze weg (r6b #2)');
        refusals++; continue;
      }
      ev.run_id = runId;
      if (!ev.event_type) { console.error('batch line ' + (i + 1) + ': event_type is required'); refusals++; continue; }
      const val = validateForWrite(ev);
      if (!val.ok) { console.error('batch line ' + (i + 1) + ': ' + val.message); refusals++; continue; }
      printReviewDispatchWarning(val.verify);
      printRunBaselineNotice(ev);
      accepted.push(ev);
    }
    if (refusals) {
      console.error('batch REFUSED as a whole: ' + refusals + ' bad line(s), 0 written (all-or-nothing; retry after fixing is safe)');
      process.exit(2);
    }
    // an owner_requests_reconciled line is judged against the scribe gate; one refusal refuses the batch.
    for (let i = 0; i < accepted.length; i++) {
      const sr = gateScribeEvent(accepted[i]);
      printScribeReconciliation(sr);
      if (sr.decision === 'refuse') {
        console.error('batch REFUSED as a whole: line ' + (i + 1) + ' (owner_requests_reconciled) fails the scribe gate, 0 written (all-or-nothing)');
        process.exit(2);
      }
    }
    // completion gate: each run_completed in the batch is judged with the batch lines BEFORE it included.
    for (let i = 0; i < accepted.length; i++) {
      const gate = evaluateCompletionGate(accepted[i], accepted.slice(0, i));
      printCompletionGate(gate);
      if (gate.decision === 'refuse') {
        console.error('batch REFUSED as a whole: line ' + (i + 1) + ' (run_completed) fails the completion gate, 0 written (all-or-nothing)');
        process.exit(2);
      }
      stampCompletionGate(accepted[i], gate); // the writer's own verdict travels with the claim
    }
    const w = appendChainedLocked(rd.runDir, accepted, txnId ? { txnId } : undefined);
    if (!w.ok) { console.error(w.message); process.exit(w.refused ? 2 : 1); }
    if (w.backdated) console.error('forge-log-event: NOTE ' + w.backdated.length + ' event(s) carry a claimed_ts earlier than their predecessor was ingested (' + w.backdated.join(', ') + ') — flagged claimed_ts_backdated; ordering and cutoffs use ingested_at');
    if (w.alreadyApplied) console.log('txn already applied (' + txnId + ') — 0 written, exact-once bevestigd -> ' + path.join('forge-runs', runId, 'events.jsonl'));
    else console.log('logged ' + accepted.length + ' event(s) (batch' + (txnId ? ', txn ' + txnId : '') + ') -> ' + path.join('forge-runs', runId, 'events.jsonl'));
    process.exit(0);
  }

  let ev = {};
  if (args.length === 1) {
    try { ev = JSON.parse(args[0]); } catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }
  } else if (args.length >= 2) {
    ev.run_id = args[0];
    ev.event_type = args[1];
    // --env <VAR> (external audit II-G): the JSON payload is read from an ENVIRONMENT VARIABLE
    // instead of an argv token. cmd.exe re-tokenises argv on = ; , and treats & as a command separator, so
    // forge-log-event.cmd used to write silently rewritten payloads and could execute text after an &.
    // An env var is never re-tokenised by any shell. The wrappers use this route; direct callers may too.
    if (args[2] === '--env') {
      const raw = process.env[String(args[3] || '')];
      if (!raw) { console.error('--env ' + (args[3] || '<VAR>') + ': that environment variable is empty or unset'); process.exit(1); }
      try { Object.assign(ev, JSON.parse(raw)); } catch (e) { console.error('Invalid extra JSON in env ' + args[3] + ':', e.message); process.exit(1); }
    } else if (args[2] === '--file') {
      // --file <path>: the payload is read from a file, so no shell ever tokenises it. This is the ONLY route
      // that is safe from cmd.exe for JSON containing quotes AND an & — cmd toggles its quote state on every
      // embedded quote, so even `set "VAR=..."` can expose an & inside a value (verified 2026-09-23).
      const fp = String(args[3] || '');
      if (!fp) { console.error('--file: a path is required'); process.exit(1); }
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { console.error('--file ' + fp + ': ' + e.message); process.exit(1); }
      try { Object.assign(ev, JSON.parse(raw.replace(/^﻿/, ''))); } catch (e) { console.error('Invalid extra JSON in file ' + fp + ':', e.message); process.exit(1); }
    } else if (args[2]) { try { Object.assign(ev, JSON.parse(args[2])); } catch (e) { console.error('Invalid extra JSON:', e.message); process.exit(1); } }
  } else {
    console.error('Usage: node log-event.cjs <run_id> <event_type> [json | --env <VAR>] | node log-event.cjs <json> | node log-event.cjs --batch <run_id> < events.jsonl');
    process.exit(1);
  }
  if (!ev.run_id) { console.error('run_id is required'); process.exit(1); }
  if (!ev.event_type) { console.error('event_type is required'); process.exit(1); }
  const rd = resolveRunDir(ev.run_id);
  if (!rd.ok) { console.error(rd.message); process.exit(1); }
  const val = validateForWrite(ev);
  if (!val.ok) { console.error(val.message); process.exit(val.exitCode); }
  printReviewDispatchWarning(val.verify);
  printRunBaselineNotice(ev);
  // owner_requests_reconciled is written only while the scribe gate is OK (exit 2, nothing written otherwise).
  const scribeGate = gateScribeEvent(ev);
  printScribeReconciliation(scribeGate);
  if (scribeGate.decision === 'refuse') process.exit(2);
  // completion gate (run_completed only): WARN by default, exit 2 and nothing written under strict.
  const gate = evaluateCompletionGate(ev, []);
  printCompletionGate(gate);
  if (gate.decision === 'refuse') process.exit(2);
  stampCompletionGate(ev, gate); // the writer's own verdict travels with the claim
  const w = appendChainedLocked(rd.runDir, [ev]);
  if (!w.ok) { console.error(w.message); process.exit(w.refused ? 2 : 1); }
  if (w.backdated) console.error('forge-log-event: NOTE ' + ev.event_type + ' carries a claimed_ts earlier than the previous event was ingested — kept as claimed_ts, flagged claimed_ts_backdated; ordering and cutoffs use the writer-stamped ingested_at');
  console.log('logged ' + ev.event_type + ' -> ' + path.join('forge-runs', ev.run_id, 'events.jsonl') + flagsTag(ev._forge_verify || val.verify));
}

module.exports = {
  validateForWrite, appendChainedLocked, acquireEventsLock, releaseEventsLock, chainTail,
  readEventsClassified, resolveRunDir, verifyEvent, canonicalAgent, KNOWN_EVENT_TYPES,
  stillOwnsLock, walRecover,
  // part B: the run_started baseline writer, exported for tests and future callers.
  runStartBaseline, RUN_START_BASELINE_FIELDS,
  // the run_completed completion gate.
  evaluateCompletionGate, completionGateMode, COMPLETION_GATE_ENV,
  // the writer's own gate stamp on run_completed and the library-append stamping.
  stampCompletionGate, stampLibraryEvent,
  // writer-controlled time and the failure-close mirror
  stampWriterTime, WRITER_TIME_FIELDS, isFailureCloseEvent, FAILURE_CLOSE_FIELDS_MIRROR, FAILURE_CLOSE_RE_MIRROR,
  // part ii: the owner-requests reconciliation check (scribe gate) and its writer-owned stamp.
  evaluateScribeReconciliation, stampScribeReconciliation,
  // Codex R3 SC-06: the writer-side scribe head anchor (the definition forge-scribe verify-chain checks).
  scribeHeadOf,
};

// The CLI runs AFTER module.exports is assigned: the completion gate calls forge-runcontract.cjs
// in-process, and that checker requires THIS file back for its chain-verifying event classifier. Started any
// earlier, it would receive this module's still-empty exports object and every completion would read as
// "checker unavailable". Function declarations are hoisted, so nothing above depends on this position.
if (require.main === module) mainCli();
