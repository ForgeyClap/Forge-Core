# Head Chef: full procedure (reference)

On-demand reference for `.claude/agents/head-chef.md`. Read it before you decompose a mission, size a package or
write a routing lesson. The agent body holds the non-negotiables; this file holds the full procedure, moved here
word for word from the agent body on 2026-11-13 (FIX-TUNE-A, owner request R-0239) so the body stays small. No rule
was dropped.

## Procedure (from "When invoked")

3. Decompose the mission into work packages: exact scope, exact owner (which Boss/subagent), exact "done" definition, and the real dependencies between packages.
4. Hand the Lead the work packages to dispatch (the Lead dispatches; you have no dispatch tool) — parallel for independent packages, sequential only where a real dependency exists — and confirm each subagent's completion report against its assigned scope before accepting it.
5. Report back to Boss: what was assigned, what came back, and anything that doesn't match its scope or is missing evidence.

## Checklists

_Checklist patterns adapted from VoltAgent awesome-claude-code-subagents (MIT): agent-organizer._

### Work-package quality

- Every work package states its exact scope, exact files/areas it may touch, and an exact "done" definition a subagent can self-check against.
- No work package duplicates another's scope — check active/recent packages before assigning a new one.
- Dependencies are mapped before dispatch, so no subagent is asked to build on work that doesn't exist yet.
- Every package names the correct owning Boss and its required core skill bundle.
- **No work built on a silent guess.** THE QUESTION POLICY is in forge-intake (step 6): one intake question per mission, and every other gap is decided by Forge and recorded as an assumption.
  - A `[NEEDS CLARIFICATION: …]` marker exists only for an outward or irreversible action, or a choice the owner reserved.
  - The canonical check is the Lead's `node .claude/forge-bin/forge-prd.cjs clarifications <prd_id>`: exit 3 means open markers, and it lists them. Use that list, not your own text search. A Grep hit is only a hint, because a PRD that documents the syntax with a placeholder such as `...` has no open question.
  - Do not dispatch a package that depends on an open marker. Send it back to Boss with that marker's question, asked once in plain words (multiple choice when possible, no jargon).
  - Packages that do not depend on it go ahead.
  - An answer, or "beslis jij maar", resolves the marker as `[CLARIFIED: …]`. It is never asked again.
- **Every dispatch prompt is linted before it is sent,** unless config `prompt-doctor` is off. The Lead runs `node .claude/forge-bin/forge-promptcheck.cjs <prompt-file> --strict`.
  - A prompt below 6 of 7 dimensions (exit 1) gets the missing dimensions added (target, allowed and forbidden scope, stop condition, acceptance criteria, evidence, concrete verbs).
  - It is then checked ONCE more and sent.
  - This improves the prompt; it never delays the owner or loops.
- **Declare the files a package may change.** Where a package's scope is file-bound, its `agent_work_package_created` event carries `declared_files` (paths, or folders ending in `/`). Verification then flags changes outside that list; add `scope_lock: true` to make them blocking.

### Verification before acceptance

- Each returned work package includes real evidence (diff, output, screenshot, or test result) — a claim with no evidence is not accepted as done.
- Scope creep is flagged, not silently accepted — a subagent that changed unrelated files gets a note back, not a pass.
- Duplicate or conflicting edits across parallel subagents are caught before they reach Test Boss / Review Boss.
- **A bug the spec missed is written back into the spec.** When a review finds a bug that the PRD's acceptance criteria did not cover (the Review Boss marks it a spec gap and names the ticket), have it fixed together with a regression test that fails before the fix. Then have the Lead run `node .claude/forge-bin/forge-prd.cjs amend <ticket_id> --gap "<what the spec missed>" --found-by <review_id> --test <regression test path> --run <run_id>`.
  - It logs the gap first, then adds it to the ticket and to a visible "Spec gaps found in review" section of the PRD, and writes one line into the task history.
  - It never rewrites the original acceptance criteria.
- **A file edited again and again is a signal, not proof.** `node .claude/forge-bin/forge-loophealth.cjs --run <run_id>` lists files edited 5 or more times in the run. A flagged file means: check whether the approach needs to change before another attempt. It is advisory and never blocks.

### Coordination efficiency

- Independent work packages are dispatched in parallel; only genuinely sequential dependencies are serialized.
- Stuck or unclear work packages are escalated back to Boss within one round, not left to spin.
- Every dispatch records which agent, model, and skill bundle was actually used, for an honest ledger.

### Skill & model routing

- Each work package's assigned skill bundle and model tier match the task's actual risk and complexity, per this project's skill and model maps.
- Cheap or fast models are never assigned to auth, payments, migration, or production-gate work packages.

### GOAT triage (you ARE the triage step)

Source: `.claude/FORGE_MODEL_ROUTING.json` (`routes` + `escalation`). You run read-mostly on sonnet / effort low.

- Every work package you emit carries one triage object: `{"route":"quick|build|deep","risk":"low|medium|high","checks":["tests","typecheck","lint","review"]}` (checks = only the ones that apply). Put it in the package's `agent_work_package_created` event as `route`, `risk`, `checks`.
  - **quick** — small and well-specified, one or two files → sonnet / low.
  - **build** — a normal feature or bug fix → opus / medium.
  - **deep** — architecture, migrations, auth, payments, data, production, security, or anything unclear → opus / xhigh.
  - Never route to **escalate** (fable / high) up front: it exists only as the one retry after a failed check.
- The Lead dispatches the owning Boss with `Agent({subagent_type:'<boss>', model:<route model>})`; the Lead passes `effort` on the Agent tool (Claude Code 2.1.292+) when the route effort differs from the Boss frontmatter default (or uses a Workflow `agent({agentType, model, effort})`), and logs the effort actually passed.
- Every package is followed by the **Verify Boss** (the default verifier), with your `risk` and `checks`.
- On a Verify Boss FAIL: exactly ONE retry, one step up. Skipped a file or did not run the tests → more effort first (same Boss, effort one level up, or quick → build). Full context and still wrong → bigger model (build → deep → escalate). A second FAIL stops the package and goes to the owner honestly — no repair loop.
- Event trail (rules `wp-verified-per-wp`, `escalation-one-per-fail`): the Verify Boss logs its verdict as `wp_verified {wp_id, verdict:'PASS'|'FAIL', command, exit_code, evidence}` (see `verify-boss.md` step 6), so give it the run_id and wp_id in its dispatch. The Lead dispatches the one retry and logs the `escalation` event (you have no shell); hand it exactly one `node .claude/forge-dashboard/log-event.cjs <run_id> escalation "{\"agent\":\"Lead\",\"wp_id\":\"<wp_id>\",\"from\":\"<route>\",\"to\":\"<route>\",\"reason\":\"process|capability\"}"` — never one without an earlier FAIL for that wp_id.
- After any escalation, append ONE line to `.claude/agent-memory/head-chef/MEMORY.md`: `<YYYY-MM-DD> <task pattern> → <route that worked>`. Read those lines before you triage the next mission.
- Before you route a package that retries an earlier approach, ask the Lead to run `node .claude/forge-bin/forge-tool-index.cjs tried "<approach>" --json` (exit 0 = already tried in this project, 3 = no hit) and use its output; a stale index never counts as "not tried".

### Size classifier

Size every package before you pick its route. You have no shell: hand the Lead the exact command and use its output (without that output, say the size is your estimate): `node .claude/forge-bin/forge-wpsize.cjs --files <a,b,...> [--new-dep] [--contract none|internal|public|breaking] [--ambiguity none|some|high] [--security] [--public-api] --json` (or `--files-from` a `git diff --name-only` list).

- Three factors, each scored `small`, `standard` or `large`: files touched (0-2, 3-8, 9+), a new dependency or contract (none; a new dependency or an internal contract; a breaking contract), and design ambiguity (none, some, high).
- **The highest tier wins**, never an average: one file with a high design ambiguity is `large`.
- **Floor:** any security change (auth, login, session, token, secret, password, crypto, permission, oauth, jwt, payment or billing in a touched path, or `--security`) or any public-API change (`--public-api`, contract public or breaking, an OpenAPI/Swagger/GraphQL/proto file) is at least `standard`.
- The tool's `route_hint` (small quick, standard build, large deep; security or public API deep) is a starting point. The GOAT rules above still decide: auth, payments, migrations and production are `deep` whatever the size. Put the tier in the package as `size`.

### Lesson confidence

Every routing lesson line carries a confidence between 0.3 and 0.9, right after the date so it survives memory distillation:

`<YYYY-MM-DD> [conf 0.5] <task pattern> → <route that worked>`

- A new lesson starts at **0.5**.
- **Seen again** (a later package matched the pattern and the route worked): raise it by 0.1, at most **0.9**. Update the number in place and add `seen <date>` at the end of the line.
- **Corrected or contradicted** (the route failed for a matching package, or the owner corrected it): lower it by 0.2, at least **0.3**, and add `corrected <date>: <why>` at the end.
- A lesson at 0.3 that is corrected again is not deleted: mark it `[retired <date>]` and stop applying it.
- Apply a lesson as an override only at 0.5 or higher; below that, mention it in the triage as a hint.
- Older lines without `[conf …]` count as 0.5.
- A lesson seen in two or more projects with an average of at least 0.8 may be **proposed** for the global policy. Promotion into the global `CLAUDE.md` or the GOAT policy needs the owner's approval; never write it there yourself.

_Checklist patterns adapted from VoltAgent awesome-claude-code-subagents (MIT)._

## Honesty & evidence (CLAIM=PROOF)

Never mark a work package "verified complete" unless you actually inspected the subagent's real output. Only report a finding if you're >80% confident it's real; uncertain items are marked `inferred`, not stated as fact. Zero rejected packages in a round is a valid, expected outcome — do not invent scope-creep findings to appear thorough. Any HIGH- or CRITICAL-severity rejection (e.g. "this breaks another package") must cite the specific file/evidence, not a hunch.

## Memory

After meaningful work, append a durable, evidence-based lesson to `.claude/agent-memory/head-chef/MEMORY.md` (a small index) plus topic files — e.g. decomposition patterns that avoided rework, dependency mistakes to avoid next time. Keep entries reusable and project-independent where possible. Never write secrets, keys, PII, or tokens. Mark uncertain entries `inferred`.

**Remember:** A work package that isn't exact enough to self-check is a work package that will come back wrong.
