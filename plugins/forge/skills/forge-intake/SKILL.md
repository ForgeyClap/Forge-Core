---
name: forge-intake
description: "Use at the start of a /forge build (nieuwe opdracht, nieuw project)."
# A10 original description (listing budget): "Use at the start of a /forge build (nieuwe opdracht, nieuw project, new build, requirements): capture the real goal."
# W2-BUDGET original description (listing budget): "Use at the start of a /forge build (nieuwe opdracht, nieuw project, new build, requirements): capture the real goal."
---

# forge-intake — Prompt Master intake + dispatch shaping

**Self-improvement substrate (wp-skill-evals):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction (an owner fix, a false assumption caught, a preference stated), append it to
`learnings.md` with a date and real evidence — never invent a lesson that didn't happen.

Two standing behaviours the owner requested: **Prompt Master is always on.**

## 1. INTAKE — answer before building (every build task; trivial tasks skip; SILENT by default since 2026-09-23)

**Mode = the owner's config key `intake`** (`node .claude/forge-bin/forge-config.cjs get intake`; the owner changes it with `/forge config set intake interview`, and Forge runs that command itself): **`silent`** (default) — the Lead answers the intake itself, steps 1–5 below; **`interview`** — every build starts with the one-question-at-a-time interview in *Iteratieve intake* below (the same as typing `/forge interview`; the `grill-me` / `grilling` skills are its interview engine). A current "vraag het me eerst" / "ask me first" from the owner always wins for that run.

At the START of any `/forge` task that BUILDS/creates/automates a real deliverable (L2+), before writing work packages, run the intake so the project's goal is captured. Skip only truly trivial turns (a status question, a one-line fix, "what does X do").

1. **Detect the project type** with `forge-router` (website · ecommerce · fullstack · electron · n8n · integration · rag · voice · prediction · scraping · dashboard · or a new/mixed type).
2. **Generate the question list** (the Lead answers it — the owner is not shown the list unless they ran `/forge interview`):
   ```
   node .claude/forge-bin/forge-intake.cjs --type <slug> --task "<one-line task>" --run <run_id>
   ```
   It reads the subagent-brainstormed bank at `.claude/config/intake/question-bank.json` (universal questions first, then type-specific; required before recommended). Use `--json` if you want to map it to an ask-tool; use `--tier required` for a quick essential round on small builds.
3. **For a NEW / mixed / unusual project type** (no matching `byType` slug): dispatch ONE subagent to brainstorm 6-10 extra high-value questions for that specific project, save them as a JSON array, and merge with `--extra <file.json>`. (This is the "Prompt Master creates questions with subagent help" path.) Optionally propose adding the new type to the bank.
4. **Answer the key questions internally first.** Before deciding whether the one question is needed, answer internally from the prompt and the project: who has the problem, what the problem is, why it cannot be solved today, why now, and how success will be measured. These are inferred from the mission text, project scan, and context, not asked; this clarity determines whether a question is even needed.
5. **Coach the raw request, then answer the list yourself.** Before answering the list, apply `forge-prompt-coach` to the raw request: run `node .claude/forge-bin/forge-promptcheck.cjs ask "<raw request>"` and read which gaps it names. Answer every intake question yourself from the mission text, the project scan, `.claude/.forge-setup.json` and `FORGE_PROJECT_PROFILE.md`; where nothing in the request, the scan, `.forge-setup.json` or the profile answers one, use that question's `beginner.assume` (`assume_nl` in Dutch) from the bank and record it under *Assumptions (auto-filled)* with its F-id. Ask the owner **at most one** question, and only when **(a)** two readings would lead to materially different builds or **(b)** the request implies an outward or irreversible action (send, publish, pay, deploy). Choose it from the highest-ranked gap (the bank questions for that gap: `node .claude/forge-bin/forge-intake.cjs --type <slug> --task "<task>" --trigger F<id> --lang nl --json`) and ask it in beginner form (`question_nl` + `beginner.options_nl`: 2–3 outcome options + "iets anders", the recommended one first with a one-line reason). Then confirm in one sentence ("Ik bouw dus: … Klopt dat?") and, when `explain-mode` is on, add at most one teaching tip per failure type per session. The two-equally-plausible-targets case is F8 and stays covered. With config `prompt-doctor` off, skip the `promptcheck ask` step (the intake still runs silently). Presenting the whole list as ONE consolidated set (or batched `AskUserQuestion` rounds of ≤4) is the `/forge interview` opt-in — external audit 2026-09-23: the default flow used to show 21–24 questions per build. Let the owner answer per number or pick options; every question is skippable.
6. **Record the answers** into the run: they become the basis for `forge-prd` (PRD → tickets) and are quoted in the Boss dispatch prompts. In the PRD, assumptions go in the `assumptions` section, rendered as *Assumptions (auto-filled)*.

**THE QUESTION POLICY. This is the single source of truth; forge-router, forge-prompt-coach and the Head Chef point here.**
- Per mission, Forge asks the owner at most ONE intake question (step 5). The only later questions are the two
  exceptions below (an outward or irreversible action, a reserved choice), each asked once.
- Every other gap Forge decides itself. It picks the recommended safe option, writes it under *Assumptions (auto-filled)*, and names it in one line of the plan. This includes a gap that would change the build.
- A `[NEEDS CLARIFICATION: <question>]` marker is ONLY for a gap Forge must not decide alone:
  - an outward or irreversible action (send, publish, pay, deploy; these also hit a hard gate);
  - a choice the owner explicitly reserved ("vraag mij eerst", "ask me first").
- Such a marker blocks only the packages that depend on it. Its question is asked once, in plain words, when such a package is next. No other question may be pending at that point, so the owner never gets two questions at once.
- The owner's answer, or an explicit delegation ("beslis jij maar", "you decide"), resolves the marker as `[CLARIFIED: <answer or "delegated: chose X">]`. It is never asked again.
- The canonical check is `node .claude/forge-bin/forge-prd.cjs clarifications <prd_id>` (exit 3 while open). A text search is only a hint, because a PRD that documents the syntax with a placeholder such as `...` has no open question. A material answer the owner corrects can also be persisted via `forge-reflect` as an owner-correction lesson.

HONESTY: never build on assumed answers — if the owner skips a *required* question, state the assumption you're proceeding with. The intake sharpens the goal; it does not replace owner approval gates.

**How to ask the one question:** only when two readings lead to materially different builds or the action is outward/irreversible; 2–3 outcome options + "iets anders", A recommended with a one-line reason; confirm in one sentence ("Ik bouw dus: … Klopt dat?"); at most one teaching tip per F-id per session when `explain-mode` is on. The 9 ingredients and F1–F13 live in `forge-prompt-coach`. Full wording (the `promptcheck ask` JSON fields, exit codes, the bank fields): `references/asking-the-one-question.md`.

## 1b. PLAN CARD — think with the user, then show ONE card (WP 3.2)

The intake ends in one plan card, never in a list of questions: **goal → real intent → assumptions → at most ONE question → plan card → proceed.**
1. **Render it, always.** Write the mission JSON (goal, intent, assumptions, the one question or null, packages with owns/route/deps/owner, risks, wont_do, gates, proof) and run `node .claude/forge-bin/forge-plan-card.cjs --file <mission.json> --request "<raw owner request>" --run <run_id>` (add `--lang nl` for a Dutch owner). Every run renders and logs it: `plan-card.md` + `plan-card.json` in the run folder and one `agent_note`. The card shows scope, work packages with owners and routes, expected lanes, risks, what Forge will NOT do, the hard gates that need the owner and how done is proven.
2. **Assumptions** go on the card under *Assumptions (auto-filled)* with their F-id: `--request` merges `forge-promptcheck.cjs plan-input`, a gap answered from the bank uses its `beginner.assume`. The PRD `assumptions` section repeats them.
3. **The one question** comes from the vetted bank: `node .claude/forge-bin/forge-plan-card.cjs question --domain <slug> [--trigger F<id>]` returns exactly one question with its choices and the default used when unanswered. A mission with more than one owner question is refused (exit 2). Ask it in the same message as the card; unanswered means the default, recorded as an assumption and never asked again.
4. **plan-approval** (config, default `gated`; exit 3 = the card needs the owner). `gated`: only the packages in `blocked` wait (they hold a hard-gate item such as push, deploy, spend, DNS, production, credentials, outbound, outside-root or a destructive delete, or depend on one); start every package in `ready` at once. `always`: the whole card waits. `auto`: never waits. Approving the card never unlocks a gate: each gate action still uses its own yes-path, batched at the end of the mission.
5. **Approved scope is never re-asked.** "Approval given once for a scope stays valid for that whole scope" (owner), and Forge "does not ask 'shall I continue?' between phases — only a hard gate or a real usage-limit pause interrupts" (standing rule `does-it-for-you`). Store the card's `approvalRecord` as `approval` in the mission; a re-render then needs no new OK unless a gate item changed.

Full contract, verdict table and examples: `references/plan-card.md`.

## 2. DISPATCH SHAPING — every Boss dispatch is Prompt Master-shaped

Every work package the Lead/Head Chef emits MUST already carry the Prompt Master agentic shape (this is the existing forge-router Work Package format): **target/deliverable · allowed actions + path anchors · forbidden actions / scope lock · stop condition + human-review triggers · success/acceptance criteria · evidence-required · no vague verbs.**

Lint EVERY dispatch prompt before sending, by default (it used to be an optional nudge):
```
node .claude/forge-bin/forge-promptcheck.cjs <promptFile> --strict   # or: echo "<prompt>" | forge-promptcheck.cjs - --strict
```
It scores the prompt X/7 across those dimensions and names what is missing (for example "add a scope lock").
- **Exit 1** (below 6/7): add the missing dimensions and check once more, then send.
- **Exit 0**: send as is.

This sharpens what a Boss receives; it never waits on the owner. A canonical Forge work package already scores 6-7/7, so this catches the weak, vague ones ("improve the thing and fix stuff" scores 1/7) before they reach a Boss. With config `prompt-doctor` off, this step is skipped too.

## Notes
- Zero-dependency, deterministic, no LLM inside the tools, no telemetry, no UI changes (dashboard stays read-only). The bank is owner-editable JSON.
- The intake question bank was generated by a 6-agent subagent brainstorm and is Forge-owned + synced; extend `byType` for new domains.
- Intake fires for BUILD tasks; it is not a gate on Q&A/status turns. Dispatch shaping applies to every real Boss dispatch.

## Iteratieve intake — OPT-IN via `/forge interview` of config `intake: interview` (sweep-verbetering 2026-07-31; opt-in sinds 2026-09-23)
Opt-in only: the Lead fills the intake itself by default. In interview mode ask **one question per turn**, close with the meta-question **"Wat moet ik zelf nog verhelderen dat ik niet gevraagd heb?"**, and record scope in four layers (core · nice-to-have · maybe-later with a trigger · explicitly out of scope); the recommended tag per question stays verdiend advies (evidence-earned, never random). Full Dutch text: `references/iterative-intake.md`.
