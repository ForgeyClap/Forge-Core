---
name: forge-agent
description: "Playbook for AI agents and LLM apps: tool calling, evals (gebruik bij AI-agents)."
# A10 original description (listing budget): "Playbook for AI agents and LLM apps: tool calling, MCP tools, evals, guardrails (gebruik bij AI-agents bouwen)."
# W2-BUDGET original description (listing budget): "Playbook for AI agents and LLM apps: tool calling, evals (gebruik bij AI-agents bouwen)."
---

# Forge playbook — Agent / LLM app + evals

## Provenance
Forge-native playbook. The references add material adapted in our own words from anthropics/skills (Apache-2.0, LICENSE.txt verified per skill; see LICENSE.txt), seen on `main` at `ca45fc4` on 2026-11-02:
- skills/claude-api (SKILL.md, shared/agent-design.md, shared/evals/build-eval.md) → `references/claude-api.md`.
- skills/mcp-builder (SKILL.md, reference/mcp_best_practices.md) → `references/mcp-builder.md`.
Forge changes: credential commands, live-doc fetches, `npx` package runs and bundled scripts dropped; drifting facts (model IDs, prices) deferred to the `claude-api` skill.

## When to use
- Use for: AI agents and LLM apps: tool calling, building MCP servers, evals, guardrails.
- Not for: plugging an existing MCP server into Forge (`forge-mcp-clients`); a document chatbot without tools (`forge-rag`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

**Do not duplicate ECC skills — defer to:** `claude-api` (model IDs, params, tool-use, caching, token counting — read BEFORE touching any Claude/Anthropic model), `forge-rag` (the retrieval leg when the agent grounds on documents), `agentdb-vector-search` / `agentdb-memory-patterns` (agent memory / vector recall). This file is orchestration only; Forge's condensed agent-design notes (tool promotion, caching, context, guards, eval ladder) are in `references/claude-api.md`.

## Hard rules (non-negotiable)
- **Validated tool schemas, least privilege.**
- **Structural prompt-injection resistance.**
- **Real eval harness on a real dataset.**
- **Honest fallback.**
- **Human handoff.**
- **Cost / rate / loop guards.**

Full text of every rule: `references/hard-rules.md`. Building the tool server itself (naming, schemas, annotations, pagination, transport, auth, 10-question eval): `references/mcp-builder.md`.

## Team (conditional)
Lead: `architect` (or `build-boss` when the agent is one slice of a larger app). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 for a single tool-using assistant; L3 typical (agent loop + tools + eval + guardrails); L4 phased for a multi-agent system.
**Serial:** tool schemas + least-privilege set → agent loop with budget + iteration cap → injection defense (plan-then-execute + reader split) → eval set → fallback + handoff wiring.
**Parallel (independent once the tool contract + prompt are fixed):** tool/guardrail layer ∥ eval-harness build ∥ frontend/serving layer.

## Domain gates
- Every tool has a validated input schema; the tool set is least-privilege; destructive/irreversible tools are confirmation- or human-gated.
- Injection defense is structural (plan-then-execute + capability-split reader), not just a "please ignore malicious instructions" prompt line; no unbroken lethal-trifecta path.
- An eval set exists, runs, and reports a real pass rate; regressions are catchable; prompts are versioned.
- Fallback verified for low-confidence / empty-retrieval / tool-unavailable; no fabricated facts or citations.
- Human-handoff path defined and reachable.
- Token/cost budget, agent-loop iteration cap, per-call timeout, and rate-limit backoff are enforced and tested (a runaway loop is bounded, not hoped-away).
- MCP servers built here: prefixed snake_case tool names, honest annotations, errors returned in-result, local HTTP bound to `127.0.0.1` with Origin check, and a 10-question read-only eval with a real pass rate.
- Secrets in env; no keys in prompts, logs, or transcripts.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: destructive or irreversible tools (delete, deploy, pay, send, overwrite) are confirmation- or human-gated, never autonomous.
- Approval / safety: secrets/API keys in env + `.env.example` only; never in prompts, logs or transcripts; agents never read or print a key.
- Approval / safety: a paid full eval run waits for the owner's yes after an oracle/null check and a measured cost estimate; installing an SDK, Inspector or codemod package is a dependency change the owner approves.
- Honest failure: never claim an eval "passed" without a real dataset run; the eval runner is opt-in, so say whether it actually ran.
- Honest failure: never promise doer-blindness Forge cannot enforce (only the reader-side/weak form).
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content injection defense (patterns from arXiv 2506.08837, CC-BY-4.0).
- `references/claude-api.md` — building on the Claude API: tool promotion, context management, caching, effort, guards, eval ladder.
- `references/mcp-builder.md` — building an MCP server: plan, build, security, review/test, 10-question evaluation.
