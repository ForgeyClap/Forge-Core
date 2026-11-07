# Forge reference — flow steps 4-6 (team selection, work packages, parallel execution, live logging)

> **On-demand reference, moved VERBATIM** out of `.claude/commands/forge.md`, so
> the `/forge` command core stays short enough to survive compaction. The core's numbered rules still govern; this file
> holds the full, unmodified wording of lines 77-93 of the earlier file (whole-file sha256 `6ab6d9160d6d321dff530a6b2c25e4c0c1a8d4c85ab8aaeb6595b7ef2b6dfdbd`).
> Nothing between the two markers below was reworded. **When to read:** when selecting the team, logging work packages, writing the shared contract, dispatching subagents, or logging/backfilling subagent activity.

<!-- wp11-verbatim-begin source=.claude/commands/forge.md lines=77-93 -->
## 4. Dynamic Role-Based Subagent Selection → load skill `forge-router`
The target folder is the cwd (BUILD BY DEFAULT — never ask when it is a project; a home folder or drive root is refused). Classify L1–L4. The Lead Agent **decides the roles** — but **team names come from the permanent Boss registry** (`.claude/config/agents/agent-registry.json`): map each required work area to the covering Boss (+ its ECC agents/skills, ECC-first). A genuinely new role is allowed ONLY per the registry's `extensionRule` (permanent standardized name + role + skill bundle + model mapping + self-review + loop position, added template-first) — never ad-hoc/random names for work a Boss covers. `forge-router` returns the **smallest useful but powerful** team + matching playbook. Log `role_map_created`, then `agent_selected` per agent (with `runtime`). For each **custom** subagent log `custom_subagent_created` with: name · role · why needed · project evidence · mission · inputs · allowed/not-allowed · expected output + artifact path · evidence required · handoff · success/rework criteria · runtime target · status. Show the plan in one line and continue building (BUILD BY DEFAULT); wait for an explicit go-ahead only when config `start-gate` asks for it (`l4-only` → an **L4** mission, `always` → every build), when the owner wrote "wait"/"ask first"/"plan only", or when a hard gate is in play.

## 5. Assign Subagent Work Packages
For **each** selected/custom subagent log `agent_work_package_created` (custom roles: `custom_subagent_created`, `custom:true`) with: `agent, role, runtime, mission, inputs[], allowed_actions[], not_allowed[], output_artifact, evidence_required[], handoff, success_criteria, rework_criteria, status:"previewing"` **plus the assigned `skill` + `skill_source`** (`ecc-skill`/`forge-skill`/`project-local`/`native`/`internal`/`unavailable`) — log `skill_assigned` if assigned separately. Archive `.claude/forge-runs/<run_id>/work-packages.md`. (`previewing` → node previews **blue** until the agent really starts.) Subagents must do **different** parts — not all the same general analysis.

## 6. Parallel Subagent Execution (this folder only) — ECC-first
**CONTRACT-FIRST (required before any parallel builders that share interfaces).** Write ONE authoritative contract (`docs/ARCHITECTURE.md` and/or `src/contract.js`) pinning the LITERAL shared details — exact action/message shapes + payload key names + nesting, exact function/API names+signatures, exact DOM ids AND CSS class names/tokens, file ownership (one owner per file), and the component lifecycle (`mount()` returns a cleanup the host calls on unmount/switch). Embed each builder's slice in its prompt; builders code against it VERBATIM (no inventing action/class names). No parallel build without the contract. **INTEGRATION GATE before "complete":** run the ASSEMBLED product headless — boots with no console errors, cross-module actions round-trip, every view/panel mounts, one real user-flow passes. A failure is a BLOCKER, not "done". Green unit tests + `node --check` are NOT enough (they miss cross-module mismatches). Every planned module/view must have an owner. See forge-core "CONTRACT-FIRST BUILDS + INTEGRATION GATE".

**REAL DISPATCH OR HONEST INTERNAL (hard rule — deep-scan 2026-07-07).** A `subagent_started/completed` event MUST correspond to a REAL Agent-tool dispatch (`Agent({subagent_type, name:"<Boss>", …})` or Workflow `agent()`) — pass the Agent tool_use id as `dispatch_id` on that subagent's events. **If YOU (the main session) do the work yourself, do NOT emit a separate named subagent — log it under the Lead/Boss node with `runtime:"internal"` (INTERNAL ROLE ONLY).** Emitting engine-boss/shell-boss/db-boss for work no real subagent did = a fake swarm; `log-event.cjs` stamps it `UNREGISTERED`/`UNVERIFIED` and the dashboard flags it. The `agent` field MUST be one of the 12 registry Bosses (`.claude/config/agents/agent-registry.json`); specialization goes in `role`. Run with `FORGE_STRICT_EVENTS=1` to hard-reject fakes. See forge-core "REAL AGENTS ONLY".

**Really invoke the selected ECC agents/skills** (this is ECC Normal Mode, not a description). Parallel writers → separate git worktrees; you integrate. As work really happens log `subagent_started` (≈ `agent_started`) · `file_read`/`file_changed` · `command_run` · `skill_loaded` · `agent_note` (visible working note, NOT hidden chain-of-thought) · `subagent_output_created` — always with `agent` (a Boss name) + `role` + **`runtime`** (+ `dispatch_id` for a real dispatch). **Fallback:** if an ECC agent/skill is blocked or fails, log `ecc_blocked` / `ecc_agent_failed` (reason), then a native role **only if safe**, logging `native_fallback_used` + `runtime:"native"`. Never silently substitute native for ECC.

**SUBAGENT LIVE LOGGING (required — the dashboard must show WHAT each subagent is doing, not just its .md).** Tool grants are class-based and least-privilege (`.claude/config/agents/agent-tool-policy.json`): only `full-build`/`exec-reviewer` subagents (Build/Test/UI/Integration Boss, codex-reviewer) HAVE Bash and MAY self-log their own progress as they work —
`node .claude/forge-dashboard/log-event.cjs <run_id> agent_progress "{\"agent\":\"<its-name>\",\"role\":\"<role>\",\"runtime\":\"<runtime>\",\"status\":\"running\",\"task\":\"<what I am doing right now>\"}"`
after **each meaningful step** (read inputs · analysis milestone · section written · file created/edited via `file_changed` with real paths · check run), plus ≥1 `agent_note` with visible reasoning and a `subagent_output_created` summary before finishing. `read-only-audit`/`write-no-exec` subagents (Review/Security/SEO/Search Boss, Boss, Head Chef, Docs Boss, Skill Boss — 8 of the 12 permanent Bosses) CANNOT run Bash by design (least-privilege), so for THESE the **Lead backfills their events from the subagent's returned result immediately after it completes, tagged with that subagent's `dispatch_id`** — this backfill is the **DEFAULT path for these classes, not a fallback exception**, and applies only to a subagent that actually ran, never a way to invent one that didn't. Target: **≥3 real activity events per subagent** (self-logged or Lead-backfilled), so the FLOW node shows a live "⚡ doing…" line + progress bar instead of only the artifact. Planned work stays TODO, never faked as done. A running subagent with zero logged activity renders as "⚠ running — no activity logged yet" on the dashboard — treat that as a logging bug and fix it during the run, not after.

<!-- wp11-verbatim-end -->

## Amendment A2 (2026-11-01): harness proof first, backfill is the labelled exception

This section CHANGES the verbatim text above (which is kept unedited for the coverage proof). Where they differ, this
section wins.

- **The proof of a dispatch is a record the harness wrote, not the Lead's event.** With the hooks of
  the settings-diff proposal of 2026-11-01 (dev tree, folder `forge-systeem` under docs; section 1) installed, Claude Code itself records every Agent-tool call
  (`forge-agent-tool-hook.cjs`: PreToolUse/PostToolUse on the Agent tool, `tool_use_id` + `subagent_type`) and every
  subagent start and stop (`forge-subagent-start.cjs`, `forge-subagent-stop.cjs`: `agent_id` + `agent_type`). Workflow lanes
  are recorded in the Workflow journal. `node .claude/forge-bin/forge-harness-match.cjs --run <run_id>` joins the run's
  `subagent_started` / `agent_started` events to those records: matched, unmatched or unverifiable (with the kind).
- **Run pointer.** Right after `run_started` the Lead runs `node .claude/forge-bin/forge-active-run.cjs set <run_id> --session
  <session id>`; the hooks read only that pointer to stamp the run on their lines, and after finalize the Lead runs
  `node .claude/forge-bin/forge-active-run.cjs clear --session <session id> --run <run_id>`.
- **`dispatch_id` must be correlatable:** the Agent `tool_use_id` (`toolu_…`), the agent id the Agent tool returned
  (`a…`), or `<wf run id>:<lane>` for a Workflow lane. A free-text id (`pending`, `demo-preview`) can never be matched.
- **Backfill is the exception, not the default.** The Lead still logs `subagent_started` for Bosses that cannot run Bash
  (that event is the claim; the harness record is the proof). When the harness recorded the run but no harness record
  backs a dispatch event, `log-event.cjs` still writes the event (strict mode too) but stamps
  `_forge_verify.dispatch_unverified: true`, `dispatch_unverified_reason: "no-harness-proof: …"` and
  `dispatch_unverified_accepted: true`, prints a warning, and tags it `NO-HARNESS-PROOF`. An event with no `dispatch_id` at
  all keeps its old treatment (`dispatch_unverified_reason: "no-dispatch-id"`, refused in strict mode).
- **Contract rule `dispatch-harness-match`** (from L2, severity warn): at least 95 % of the run's dispatches
  must be matched. Dispatches no Claude Code hook can see (runtime `codex`, `cli`, `gateway` and the like) are reported as
  unverifiable and left out of the percentage. It becomes blocking only by owner decision once
  `forge-rule-promotion` shows the last 3 applicable real runs each met it.
