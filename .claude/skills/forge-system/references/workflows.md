<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# How a Forge run goes

Generated from: `.claude/commands/forge.md`, `.claude/config/orchestration/run-checklist.json`, `.claude/workflows/`.

Order: `/forge <task>` starts a run → run contract plan → work packages (Head Chef triage) → routed lanes (Bosses) → Verify Boss per package → report → run contract `check --finalize`.

## Build flow (from the /forge command file, section C)

1. First command: `node .claude/forge-bin/forge-start.cjs --text "<raw request>"` (L1 only with `--complexity L1 --reason "..."`).
2. Do the `NEXT` line it prints; unsure? Run `node .claude/forge-bin/forge-runcontract.cjs plan --run <id>` again.
3. You are the router: a dispatched Boss writes app files; the write guard stops a Lead that writes them. A one/two-file Lead fix first logs `agent_work_package_created` (agent `Lead`, runtime `internal`, `reason`, `files`).
4. Close only through the plan's completion sequence: the Stop hook refuses a red close; a failure close needs a `blocker` naming what you cannot do.
- step —: BUILD BY DEFAULT setup: `forge-start.cjs` first (target folder = cwd) → intake (silent by default, at most ONE owner question via `forge-prompt-coach`, `forge-promptcheck.cjs ask`) → dashboard → usage guard → git checkpoint (`forge-setup.cjs gitignore` + `checkpoint-scan --json` BEFORE staging; a refused checkpoint never stops the build; then `forge-rollback.cjs checkpoint --run <id>`) → CLAUDE.md + Mission Blueprint + PRD for L2+ (`forge-prd.cjs write … --tickets`) → contract preview → roster (≤ config `team-max`). Destructive words → keep-list first + mandatory checkpoint. (reference: `forge-cmd-session-build-default.md`)
- step —: GATE HOOK yes-path · VERIFY-AND-CORRECT + SCREENSHOT PROOF (reference: `forge-cmd-gates-verify.md`)
- step —: MODEL ROUTING (GOAT) · CACHE DISCIPLINE · PERMANENT BOSSES + QA LOOP + NVIDIA ROUTING (reference: `forge-cmd-routing-cache-bosses.md`)
- step —: GOAL INTAKE + PLAN · install/first activation (CLAUDE.md `## Forge Studio` safe-merge, skills, `FORGE_SKILL_REGISTRY.md`) · terminal wrappers · ECC-first (Normal ON, Full Test OFF unless config `ecc-full-test`) (reference: `forge-cmd-intake-install-ecc.md`)
- step 1: Steps 0–2 = `forge-start.cjs`; autonomy per precedence.md. Then `run.json` (status `running`) via `forge-run-file.cjs put`; read `FORGE_ECC_MODE.json`, log `ecc_inventory`, `profile_loaded`, `agent_decision_summary`; real-fixtures intake for finance/parser/ocr/data/prediction (reference: `forge-cmd-steps-0-3.md`)
- step 3: Mission Blueprint (`mission-blueprint.md`, `mission_blueprint_created`) incl. **3a Skill Discovery** (`skill_discovery` → `skill_map_created`; no subagent without a skill/method route) (reference: `forge-cmd-steps-0-3.md`)
- step 4: Team: load skill `forge-router`; Boss names from the registry; log `role_map_created`, `agent_selected`, `custom_subagent_created` (reference: `forge-cmd-steps-4-6.md`)
- step 5: Work packages: `agent_work_package_created` per subagent (status `previewing`, `skill` + `skill_source`, route/risk/checks, model/effort); archive `work-packages.md` (reference: `forge-cmd-steps-4-6.md`)
- step 6: Execution: CONTRACT-FIRST, REAL DISPATCH OR HONEST INTERNAL, ECC-first invocation, SUBAGENT LIVE LOGGING (≥3 real activity events per subagent; Lead backfills read-only Bosses) (reference: `forge-cmd-steps-4-6.md`)
- step 7: Outputs: `subagent_artifact_created`, `agent_handoff`, `subagent_completed`/`_failed` + `wp_completed`/`wp_failed` with the exact `wp_id` (reference: `forge-cmd-steps-7-14.md`)
- step 8: Lead review + ONE rework round per package (GOAT cap; critical/high first); a second FAIL = `wp_failed` + owner-queue item (reference: `forge-cmd-steps-7-14.md`)
- step 9: Merge & synthesis (`merge_started` → `merge_completed`) (reference: `forge-cmd-steps-7-14.md`)
- step 10: Codex review per config `codex-review` (auto/on-request/off); exact state reported, never faked; unlock diagnosis if blocked (reference: `forge-cmd-steps-7-14.md`)
- step 11: Quality gate (`quality_gate_passed` / `quality_gate_blocked` + reason); optional `/code-review`, `/security-review`, `/verify` (reference: `forge-cmd-steps-7-14.md`)
- step 12: Memory update (always, each via `forge-run-file.cjs append`): `FORGE_MEMORY.md` (current-state summary; history in `FORGE_MEMORY_ARCHIVE_*.md`), `FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`, `FORGE_DECISIONS.md`, session state; retention per config `cleanup` (reference: `forge-cmd-steps-7-14.md`)
- step 13: Dashboard + browser proof (PARTIAL with exact reason when unavailable) (reference: `forge-cmd-steps-7-14.md`)
- step 14: Final report (load skill `forge-report`): RUN-CONTRACT GATE via rule 4, scribe gate via rule 3, then `final-report.md` (via `forge-run-file.cjs put`) with strict verdict, a plain "Wat is er veranderd", and the closing `/clear` line in the owner's language (reference: `forge-cmd-steps-7-14.md`)

## Run checklist (10 steps)

1. `read-memory`: Read project memory (FORGE_PROJECT_PROFILE.md / FORGE_MEMORY.md / FORGE_TASK_HISTORY.md / FORGE_AGENT_LEDGER.md) before routing
2. `load-owner-prefs`: Load owner-profile prefs (forge-prefs.cjs) + active standing-rules (forge-standing.cjs) and emit the applied-prefs ECHO (Step 0-owner, precedence.md order) + owner config diff (forge-config.cjs)
3. `autonomy-decide`: Decide continue-within-mission autonomy (forge-autonomy.cjs::decide()), always deferring to the live hard-gate classifier first
4. `intake`: Run Prompt Master intake (forge-intake.cjs) and capture the owner's real goal before any team is spawned
5. `route`: Classify domain + complexity and select the team (forge-router SKILL, + domain-presets where applicable)
6. `arm-manifest` (advisory): ARM the run's dispatch manifest BEFORE any work package goes out (node .claude/forge-bin/forge-manifest.cjs arm --run <run_id> --wps <file.json> --log-event) so wp_id/agent/narrowed_prompt/deps are recorded, /forge resume can re-dispatch only the unfinished work, and forge-manifest.cjs::waves() can…
7. `dispatch`: Dispatch the selected team as real Agent-tool subagents (REAL AGENTS ONLY)
8. `verify`: Verify claimed work against real evidence — a check/quality-gate must carry required proof, not just a claim
9. `report`: Generate the final, honest forge-report
10. `update-memory`: Update project memory + the agent activity ledger with what actually happened

## Workflow scripts (2)

- `forge-build`: GOAT pipeline as a workflow: triage, 1-4 routed workers with disjoint file ownership, verifier, at most one escalation
  - Triage: head-chef or triage, sonnet/low, returns {route, risk, checks}
  - Build: one worker per part on the route model + effort
  - Verify: verify-boss or verifier, sonnet/medium, PASS/FAIL with evidence
  - Escalate: at most one step: more effort first, then a bigger model, fable/high last
- `forge-verify`: Read-only verification: one verifier agent per check in parallel, returns a PASS/FAIL table with evidence
  - Verify: verify-boss or verifier, sonnet/medium, one per check, at most maxParallel (default and cap 16) at a time

## Resume a run

- `resume <run_id>` — read `.claude/docs/forge-reference/resume.md` first. `learn` — read `.claude/docs/forge-reference/learn-harvest.md` first.
- Tool: `node .claude/forge-bin/forge-swarm-resume.cjs --run <run_id>` (exit 0 = nothing to resume, 3 = resumable, 4 = not complete but every unfinished package is leased elsewhere, 2 = no manifest was armed; --refresh/--release --wp <id> --token <t> manage a claimed lease). Re-dispatch only the unfinished packages; a done package is never re-dispatched.
- After a limit, /clear or restart: the SessionStart hook `forge-resume-brief.cjs` injects the starting facts. Then read the state files and start every independent item again.
- Full rule: `.claude/docs/forge-reference/resume.md`.
