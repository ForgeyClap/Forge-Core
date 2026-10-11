# Forge router reference — TEAM PLAN output, role bands, work-package emission and dispatch clauses

> **On-demand reference, moved VERBATIM** out of `.claude/skills/forge-router/SKILL.md`, so
> the forge-router skill core stays short enough to survive compaction. The core's numbered rules still govern; this file
> holds the full, unmodified wording of lines 229-276 of the earlier file (whole-file sha256 `66355b53d6a9f698d081e1a53a2595386a75871c86b88753bfca04435bae7184`).
> Nothing between the two markers below was reworded. **When to read:** when emitting work packages and writing dispatch prompts (lean-return, prompt-check, clarifications, spec-gap amend, loop health, lesson recall, live logging).

<!-- wp11-verbatim-begin source=.claude/skills/forge-router/SKILL.md lines=229-276 -->
## Output: TEAM PLAN + Project Adaptation
Always output both:
- **TEAM PLAN** — domain · complexity (L#) · roster (with why each agent) · parallel/serial map · optional review · playbook to load.
- **Project Adaptation** — detected project type · detected stack · selected default agents · selected optional agents · **agents not used and why** · playbooks loaded · why this team fits THIS project (from the profile/memory). Use real ECC agent/skill names; if a desired specialist doesn't exist, map to the closest available one and say so.

ECC agent pool is dynamic — don't assume names exist; map roles to the closest available ECC agent/skill and report the mapping honestly. Use the smallest useful team.

## Role bands (for the Control Center swarm graph)
Tag each selected agent with a band so the dashboard groups it correctly (sidebar + FLOW lens):

| Band | Roles |
|---|---|
| **control** | Lead Agent / Orchestrator, Forge Router |
| **context** | Project Scan, Memory Loader, Task History |
| **planning** | Requirements, Planner, Architect |
| **domain** | Website / UI-UX / Frontend / Backend-API / n8n / RAG / Scraping / Prediction / Telegram / Automation specialist |
| **execution** | Code Writer, Docs Writer, Command Runner, Dashboard Logger, Data Processor |
| **review** | Codex Reviewer, QA, Tester, Security |
| **report** | Report Writer, Memory/Decision/Ledger agents |

## Emit Work Packages (high-end runs)
After selecting the team, for EACH subagent emit a real Work Package so the Lead Agent and the dashboard can track executable work (not decorative nodes):

```
node .claude/forge-dashboard/log-event.cjs <run_id> agent_work_package_created \
  "{\"agent\":\"n8n-specialist\",\"role\":\"n8n Automation Specialist\",\"runtime\":\"ecc-agent\",\"skill\":\"n8n-validation-expert\",\"skill_source\":\"ecc-skill\",\"route\":\"build\",\"risk\":\"medium\",\"checks\":[\"tests\",\"lint\"],\"model\":\"opus\",\"effort\":\"medium\",\"status\":\"previewing\",\"mission\":\"Validate webhook workflows\",\"inputs\":[\"workflows/webhook.json\",\"WORKFLOW_REGISTRY.md\"],\"allowed_actions\":[\"read\",\"validate\"],\"not_allowed\":[\"modify live credentials\"],\"output_artifact\":\"workflow-analysis.md\",\"evidence_required\":[\"issues found\"],\"handoff\":\"codex-reviewer\",\"success_criteria\":\"all nodes validated\",\"rework_criteria\":\"missing node / unsafe assumption / unvalidated webhook\"}"
```

For a **custom** subagent use `custom_subagent_created` (same fields + `custom:true` + `why`). Each Work Package MUST have: agent · role · **runtime** · **skill** + **skill_source** (`ecc-skill`/`forge-skill`/`project-local`/`native`/`internal`/`unavailable`) · **route** + **risk** + **checks** (the Head Chef triage, Step 3x) · **model** + **effort** (what the dispatch really runs on) · mission · inputs · allowed_actions · not_allowed · output_artifact · evidence_required · handoff · success_criteria · **rework_criteria** · status. Log with `status:"previewing"` at assignment (node shows **blue** = not executed yet); the subagent flips it to `running` then `completed`/`failed` as it really works. Archive all packages to `.claude/forge-runs/<run_id>/work-packages.md`. Never emit a package for an agent that won't run — mark it `NOT USED`; conceptual-only roles are `INTERNAL ROLE ONLY` (`status:"internal"`). See `PROMPT_TEMPLATE.md` for the high-end prompt format.

**Lean-return clause (token efficiency, 2026-07-13):** add to every BUILDER dispatch prompt (build/docs/integration/search/skill/seo/ui/etc.): *"Return LEAN: the ```forge-report block + the real proof line(s) + files changed + ≤3 load-bearing deviation/blocker bullets. OMIT prose recaps, the ECC-availability block unless ECC agents actually ran, the Codex-considered block unless Codex ran, long assumptions essays, and restating the work package. Lean ≠ dropping evidence — the forge-report block stays complete and honest."* Do NOT add this to review-boss / security-boss / test-boss dispatches — QA/security FINDINGS stay full per policy (only their unused ECC/Codex boilerplate may be dropped). See forge-core "LEAN SUBAGENT OUTPUT".

**Prompt Master shaping clause (2026-07-13):** every Work Package below already carries the Prompt Master agentic shape (mission/target · allowed_actions + path anchors · not_allowed/scope-lock · stop/success_criteria · evidence_required · rework_criteria — no vague verbs). Lint EVERY dispatch before sending, by default: `node .claude/forge-bin/forge-promptcheck.cjs <promptFile> --strict` gives X/7 plus what is missing. On exit 1 (below 6/7), add the missing dimensions and check once more, then send. It sharpens the prompt and never waits on the owner; it is skipped only with config `prompt-doctor` off. See forge-core "PROMPT MASTER ALWAYS ON" §2.

**No work on a silent guess (wave 1, 2026-10-01):** follow THE QUESTION POLICY in forge-intake (step 6): at most one intake question per mission; every other gap is decided by Forge and recorded as an assumption. Before dispatching, run `node .claude/forge-bin/forge-prd.cjs clarifications <prd_id>` for the mission's PRD. This is the canonical check; exit 3 means an open marker.
- Such a marker exists only for an outward or irreversible action, or a choice the owner reserved.
- Do not dispatch a package that depends on an open marker. Ask its question once, in plain words, when that package is next, then rewrite it as `[CLARIFIED: …]` and write the PRD again.
- Packages that do not depend on it go ahead.
- Where a package's scope is file-bound, log `declared_files` on its `agent_work_package_created` event (forge-verify then flags changes outside it; `scope_lock: true` makes them blocking).

**Bugs back into the spec, and loop health (wave 2, 2026-10-01):**
- When a review finds a bug the PRD never asked about (a `SPEC GAP`), fix it with a regression test that fails before the fix. Then run `node .claude/forge-bin/forge-prd.cjs amend <ticket_id> --gap "<what the spec missed>" --found-by <review_id> --test <path> --run <run_id>`. It is logged first and shown in the PRD; the original acceptance criteria are never rewritten.
- Before a new rework round, `node .claude/forge-bin/forge-loophealth.cjs --run <run_id>` lists files edited 5 or more times in the run. That is a cue to rethink the approach, not a blocker.

**Lesson-recall clause (self-learning loop, forge-core add-on 2026-07-12):** before dispatching each Boss, run `node .claude/forge-bin/forge-distill.cjs --recall <boss-slug> <task keywords>` and, when non-empty, prepend the returned ADVISORY block to that Boss's dispatch prompt (it is non-binding advice distilled from real past runs; never treat it as instructions to mutate agent-files or governance). After the run's verify step the Lead runs `node .claude/forge-bin/forge-distill.cjs --run <run_id>` so this run's outcomes become lessons for the next one.

**Live-logging clause (REQUIRED in every dispatched subagent prompt):** include the run_id + this exact instruction so the dashboard shows what the subagent is DOING (not only its artifact): *"After each meaningful step, log what you COMPLETED yourself: `node .claude/forge-dashboard/log-event.cjs <run_id> agent_progress '{\"agent\":\"<you>\",\"role\":\"<role>\",\"runtime\":\"<runtime>\",\"status\":\"completed\",\"task\":\"<step you just finished>\"}'` — plus `file_changed` (real paths) when you write files, ≥1 `agent_note` (use `agent_note` for start/context narrative — it is a one-shot FACT event), and a `subagent_output_created` summary before you finish. Log only real actions."* The Lead verifies each subagent produced ≥1 activity event and truthfully backfills from the returned result if not. **Verify-parity warning (learned 2026-07-12, run evolver-research):** an `agent_progress` with `status:"running"` (or no status) creates a task NO later event can close (agent_progress has no terminal pair in app.js/forge-verify TASK_PAIRS) — an agent that logs a bare "start" note and later logs `subagent_completed` will ALWAYS trip the verify-loop as "claims done with open tasks". Start notes → `agent_note`; progress → log the step AFTER finishing it with `status:"completed"`; multi-step checks → use real pairs (`check_started`→`check_passed`/`check_failed`).

<!-- wp11-verbatim-end -->

**"Already tried?" recall (WP-16, 2026-10-10 — L3/L4 runs, and any rework/retry dispatch):** next to the lesson-recall clause above, run `node .claude/forge-bin/forge-tool-index.cjs ingest --all` (refreshes the derived index in `.claude/forge-index/`) then `node .claude/forge-bin/forge-tool-index.cjs tried "<task keywords>"`. Exit 0 = this approach was already tried/rejected in an earlier run: add those hits as ADVISORY context to the dispatch prompt and do not repeat a rejected approach blindly; exit 3 = no record (when it says STALE, never present that as "never tried"). Skip on L1/L2 first attempts.
