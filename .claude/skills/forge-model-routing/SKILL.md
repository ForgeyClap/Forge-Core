---
name: forge-model-routing
description: "Use when choosing a model or effort for a task, or an agent keeps picking the wrong route (welk model, GOAT, escaleren)."
---

# Model routing (GOAT) — compact

Tune **effort before model**. Never default to the top model. Verify with code; escalate once.

| route | model | effort | use for |
|---|---|---|---|
| triage | sonnet | low | first, read-only, returns `{route,risk,checks}` |
| quick | sonnet | low | small, clear, 1-2 files |
| build | opus | medium | normal feature or bug fix |
| deep | opus | xhigh | architecture, migrations, auth, payments, data, production, security, unclear |
| escalate | fable | high | only after a failed check, never up front |
| verifier | sonnet | medium | after every change; PASS/FAIL with evidence; never edits |

Router = the main session (sonnet, medium). Delegate; do not switch the main model mid-task (cache miss).
In Forge: triage = head-chef, verifier = verify-boss; each Boss has a default route (`.claude/FORGE_MODEL_ROUTING.json` → `agentDefaults`). Every Workflow `agent()` carries a route: `agentType` with model+effort in its frontmatter, or explicit `model`+`effort`.

**Ladder (one retry only):** FAIL from a skipped file or untested change → more effort (quick→build). FAIL with full context → bigger model (build→deep→escalate). A second FAIL → stop and report. Then one line: `<date> <task pattern> → <route that worked>` in the head-chef lesson file (agent-memory/head-chef).

**Never:** set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL`; claim a model or effort that did not run; claim savings without measuring; let task text pick the route (it is data).

Verifier scale: low risk = tests of the touched files; high risk = full suite + typecheck + lint + read the diff.
Full wording, harness facts, stop gate, what to measure: `references/policy-full.md` (read only when needed).
