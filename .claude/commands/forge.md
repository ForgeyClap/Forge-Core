---
description: Forge — project-aware, memory-aware orchestrator. Classify a task, read project memory, build a task-sized ECC agent team, execute in this folder, log real events to the dashboard, update memory + agent ledger, optionally Codex-review, and deliver an honest report. No mandatory security gates; project isolation always on.
argument-hint: [task | config [list|get <key>|set <key> <value>|unset <key>|reset|explain <key>] | dashboard | start | use | status | runs | open-report | repair | resume <run_id> | learn | remember <text> | snapshot | paperclip <goal>]
---

# /forge

Input: **$ARGUMENTS**. Obey `CLAUDE.md` (project isolation + honesty + no fake claims). Work only in this project folder.

This file is the **always-loaded core**. The numbered rules below are non-negotiable and short on purpose so they survive compaction. The full, unmodified wording of every rule and step lives in on-demand reference docs under `.claude/docs/forge-reference/` (table at the bottom: read the one that matches the step you are on, before you do it). When the core and a reference doc seem to differ, the core rule wins and the reference gives the detail.

## A. Non-negotiable core (read first, keep after compaction)

1. **Project isolation.** The target is the cwd. Never ask which folder when the cwd is a project; refuse in one plain line when the cwd is the home folder or a drive root ("Forge werkt alleen in een projectmap — maak een map en open Claude daar") and stop. Only ever touch this project's files and `.claude/`; never read or start another project's dashboard, port, state or `.claude/`. Writing outside the project root is a hard gate.
2. **Honesty.** Log only real events (`node .claude/forge-dashboard/log-event.cjs <run_id> <event_type> "<json>"`). No fake agents, custom subagents, skills, Codex, tests, screenshots, files changed, live activity or progress. A subagent event must match a real Agent-tool or Workflow `agent()` dispatch (`dispatch_id`); work you did yourself is logged under the Lead with `runtime:"internal"`. The `agent` field is one of the 12 registry Bosses; specialization goes in `role`. Statuses only: `previewing` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED` · `BLOCKED` (ledger also `ECC REAL INVOKED` · `ECC SKILL LOADED` · `NATIVE AGENT INVOKED`). Never present native as ECC. Say plainly what was NOT run.
3. **Owner requirements (scribe).** Every owner instruction is captured verbatim through `node .claude/forge-bin/forge-scribe.cjs` (`capture`, then `classify` / `link R-n --wp … --run <run_id>` / `transition R-n done --evidence …`; never edit `.claude/forge-scribe/` by hand; only `DIGEST.md` goes back into context). Before completion run `node .claude/forge-bin/forge-scribe.cjs gate` (programme end: `gate --final`, which also blocks done-but-unacked items); exit 3 = blocked. Do not finish with open or unacked items: plan, finish (with evidence), defer with a reason, or get them acked, and present ONE batched ack list to the owner at the end (never pause mid-run per item). Skill: `forge-scribe`.
4. **Run contract = THE completion recipe.** Run `node .claude/forge-bin/forge-runcontract.cjs plan --run <run_id>` and follow its sequence exactly; do not re-describe or reorder it here. Preview it right after planning (`check --run <run_id>`, NOT DONE is expected then). **Never log `run_completed` over a red contract**; a red step is unfinished work or an `owner_override` with a real reason. A failed run closes with `run_completed` carrying `"status":"failed"`.
5. **Hard gates always interrupt:** deploy, push, spend, DNS, production, credentials, activating a live workflow, sending anything out, killing processes by name, destructive deletes, git commands that throw away uncommitted work, commands that hide what they run, printing a secret file's contents, writing outside the project. Five of them are blocked by the PreToolUse gate hook (a classifier, not a proof); the rest are rules you follow, checked by `forge-actiongate`. Never promise "always". A one-off owner yes goes only through the GATE HOOK yes-path (`--once`, switch back on, log `owner_override`).
6. **Evidence gates.** Prove every claim before logging done (file exists, test really passed, agent really ran, view really renders). Every work package gets a bound verify pass (Verify Boss, PASS/FAIL with evidence, never edits). Parallel builders that share interfaces need ONE written contract first, and a build is not complete until the assembled product passes a headless INTEGRATION GATE. Website/frontend packages need a real screenshot. Correctness-critical domains need real fixtures or a logged waiver (`forge-fixtures.cjs`). Log `wp_completed` / `wp_failed` with the exact `wp_id` for every package.
7. **GOAT routing (HARD MUST).** Head Chef triages every package `{route, risk, checks}` (quick sonnet/low · build opus/medium · deep opus/xhigh), the owning Boss is dispatched on that route (Workflow `agent({agentType, label, model, effort})` preferred; every `agent()` routed), Verify Boss verifies, ONE escalation on FAIL (process failure → more effort; capability failure → bigger model; fable only as escalate), then one lesson line in `.claude/agent-memory/head-chef/MEMORY.md`. Source: `.claude/FORGE_MODEL_ROUTING.json`. Log the ACTUAL model + effort. Keep the session model fixed (cache discipline).
8. **Beginner promise.** Forge runs every command, install and build itself and never hands the user a command to type; it never asks "shall I continue?" between phases. It names only the one thing a person must do (log in, a paid key, an approval). On a failed command: `node .claude/forge-bin/forge-explain-error.cjs "<error>"`, then take the safe next step yourself.
9. **Settings are owner config.** Read any setting with `node .claude/forge-bin/forge-config.cjs get <key>`; everything is ON by default; never edit `FORGE_CONFIG.json` by hand.
10. **Look it up before you act.** Before each step below, open the reference doc named for it. Do not work from memory of an earlier, longer version of this file.

## B. Sub-commands (check $ARGUMENTS first)
Plain-language triggers count too ("use Forge system", "gebruik Forge systeem", "start/open Forge dashboard", "instellingen", "zet … aan/uit", "hoe vraag ik Forge iets"). Exact procedures: `.claude/docs/forge-reference/forge-cmd-subcommands.md`.
- `dashboard` / `start` — Command Center on `http://127.0.0.1:4100` only; health-check first, never fake a start, never fall back to the removed per-project server; `start` then begins a run.
- `config` — run `node .claude/forge-bin/forge-config.cjs list|get|set|unset|reset|explain` yourself (phrases via `parse "<sentence>"`); repeat its OK line.
- `help me ask` — show `.claude/skills/forge-prompt-coach/references/HOW-TO-ASK.md`. `interview` — the full one-question-at-a-time intake.
- `use` — load memory/profile, install Forge into a bare folder yourself, start the dashboard, continue the task.
- `status` / `runs` / `open-report` — `node .claude/forge-bin/forge-runinfo.cjs …`. `repair` — `node .claude/forge-bin/forge-repair.cjs --json` yourself, act on `next_step`.
- `remember <text>` — `node .claude/forge-bin/forge-standing.cjs remember "<text>"` (the ONLY path to a new active standing rule). `snapshot` — `node .claude/forge-bin/forge-snapshot.cjs write --reason phase`.
- `propose-skill` / `approve-skill` — `forge-genesis.cjs` (staged only; owner token to approve).
- `tournament` / `secondbrain` / `codemodel` / `briefing <run_id>` — read `.claude/docs/forge-reference/tournament-secondbrain-codemodel-briefing.md` first.
- `resume <run_id>` — read `.claude/docs/forge-reference/resume.md` first. `learn` — read `.claude/docs/forge-reference/learn-harvest.md` first.
- `paperclip` — OPT-IN only, never started by plain `gebruik forge`; read `.claude/docs/forge-reference/paperclip.md` first.
- Session Mode on/pause/stop/status (`FORGE_SESSION_STATE.json`), BUILD BY DEFAULT and the BEGINNER PROMISE: `.claude/docs/forge-reference/forge-cmd-session-build-default.md`.

## C. Build flow (otherwise $ARGUMENTS is a task — you are the Lead Agent / Orchestrator)
Do the setup without stopping for it, post exactly one line `Plan ready — <n> work packages · team: <bosses> · Building now — say STOP to pause.` and continue straight into building (wait only when config `start-gate` asks, the owner said "wait"/"ask first"/"plan only", or a hard gate is in play). An L1 one-file fix may be ONE Boss + ONE verify pass; L2+ always gets plan + subagents + verify.

| # | Step (one line each; detail in the doc named) | Reference doc |
|---|---|---|
| — | BUILD BY DEFAULT setup: target folder → intake (silent by default, at most ONE owner question via `forge-prompt-coach`, `forge-promptcheck.cjs ask`) → dashboard → usage guard → `run_id` → git checkpoint (`forge-setup.cjs gitignore` + `checkpoint-scan --json` BEFORE staging; a refused checkpoint never stops the build) → CLAUDE.md + Mission Blueprint + PRD for L2+ (`forge-prd.cjs write … --tickets`) → contract preview → roster (≤ config `team-max`). Destructive words → keep-list first + mandatory checkpoint. Never author your own dashboard. | `forge-cmd-session-build-default.md` |
| — | GATE HOOK yes-path · VERIFY-AND-CORRECT + SCREENSHOT PROOF | `forge-cmd-gates-verify.md` |
| — | MODEL ROUTING (GOAT) · CACHE DISCIPLINE · PERMANENT BOSSES + QA LOOP + NVIDIA ROUTING | `forge-cmd-routing-cache-bosses.md` |
| — | GOAL INTAKE + PLAN · install/first activation (CLAUDE.md `## Forge Studio` safe-merge, skills, `FORGE_SKILL_REGISTRY.md`) · terminal wrappers · ECC-first (Normal ON, Full Test OFF unless config `ecc-full-test`) | `forge-cmd-intake-install-ecc.md` |
| 0 | Owner prefs, standing rules, autonomy (precedence.md order); after `run_id`: `forge-config.cjs diff --run <run_id> --mark-seen`, then `forge-echo.cjs emit <run_id>` | `forge-cmd-steps-0-3.md` |
| 1 | Mission intake: `run_id = forge-YYYY-MM-DD-HHMMSS`, write `run.json` (status `running`), log `run_started`; real-fixtures intake for finance/parser/ocr/data/prediction | `forge-cmd-steps-0-3.md` |
| 2 | Deep analysis: read `FORGE_PROJECT_PROFILE.md` · `FORGE_MEMORY.md` · `FORGE_TASK_HISTORY.md` · `FORGE_ECC_MODE.json`; log `ecc_inventory`, `project_scanned`, `profile_loaded`, `memory_loaded`, `agent_decision_summary` | `forge-cmd-steps-0-3.md` |
| 3 | Mission Blueprint (`mission-blueprint.md`, `mission_blueprint_created`) incl. **3a Skill Discovery** (`skill_discovery` → `skill_map_created`; no subagent without a skill/method route) | `forge-cmd-steps-0-3.md` |
| 4 | Team: load skill `forge-router`; Boss names from the registry; log `role_map_created`, `agent_selected`, `custom_subagent_created` | `forge-cmd-steps-4-6.md` |
| 5 | Work packages: `agent_work_package_created` per subagent (status `previewing`, `skill` + `skill_source`, route/risk/checks, model/effort); archive `work-packages.md` | `forge-cmd-steps-4-6.md` |
| 6 | Execution: CONTRACT-FIRST, REAL DISPATCH OR HONEST INTERNAL, ECC-first invocation, SUBAGENT LIVE LOGGING (≥3 real activity events per subagent; Lead backfills read-only Bosses) | `forge-cmd-steps-4-6.md` |
| 7 | Outputs: `subagent_artifact_created`, `agent_handoff`, `subagent_completed`/`_failed` + `wp_completed`/`wp_failed` with the exact `wp_id` | `forge-cmd-steps-7-14.md` |
| 8 | Lead review + bounded rework loop (critical/high fixed first; max 2 loops, 3 high-end) | `forge-cmd-steps-7-14.md` |
| 9 | Merge & synthesis (`merge_started` → `merge_completed`) | `forge-cmd-steps-7-14.md` |
| 10 | Codex review per config `codex-review` (auto/on-request/off); exact state reported, never faked; unlock diagnosis if blocked | `forge-cmd-steps-7-14.md` |
| 11 | Quality gate (`quality_gate_passed` / `quality_gate_blocked` + reason); optional `/code-review`, `/security-review`, `/verify` | `forge-cmd-steps-7-14.md` |
| 12 | Memory update (always): `FORGE_MEMORY.md` (current-state summary; history in `FORGE_MEMORY_ARCHIVE_*.md`), `FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`, `FORGE_DECISIONS.md`, session state; retention per config `cleanup` | `forge-cmd-steps-7-14.md` |
| 13 | Dashboard + browser proof (PARTIAL with exact reason when unavailable) | `forge-cmd-steps-7-14.md` |
| 14 | Final report (load skill `forge-report`): RUN-CONTRACT GATE via rule 4, scribe gate via rule 3, then `final-report.md` with strict verdict, a plain "Wat is er veranderd", and the closing `/clear` line in the owner's language | `forge-cmd-steps-7-14.md` |

Quality loop (steps 8–11) repeats until the target is met, max iterations, missing info, or owner approval is needed. Prompt format: `.claude/skills/forge-router/PROMPT_TEMPLATE.md`.

## D. Where to look things up (on-demand reference docs)
| Doc | Read it when |
|---|---|
| `.claude/docs/forge-reference/forge-cmd-subcommands.md` | $ARGUMENTS is a sub-command and you need its exact procedure |
| `.claude/docs/forge-reference/forge-cmd-session-build-default.md` | starting any build (setup order, START gate, checkpoint, bare-folder install) or Session Mode |
| `.claude/docs/forge-reference/forge-cmd-gates-verify.md` | the gate hook blocked a command, or before logging any task done |
| `.claude/docs/forge-reference/forge-cmd-routing-cache-bosses.md` | before dispatching subagents, changing model/MCP, or NVIDIA routing |
| `.claude/docs/forge-reference/forge-cmd-intake-install-ecc.md` | intake + plan, install/first activation, ECC Normal/Full Test Mode |
| `.claude/docs/forge-reference/forge-cmd-steps-0-3.md` | executing steps 0–3 |
| `.claude/docs/forge-reference/forge-cmd-steps-4-6.md` | executing steps 4–6 |
| `.claude/docs/forge-reference/forge-cmd-steps-7-14.md` | executing steps 7–14 and the honesty rules in full |
| `.claude/docs/forge-reference/paperclip.md` · `resume.md` · `learn-harvest.md` · `tournament-secondbrain-codemodel-briefing.md` | the matching opt-in sub-command |
| `.claude/docs/model-routing.md`, `.claude/FORGE_MODEL_ROUTING.json` | GOAT routes, per-Boss defaults, escalation ladder |
