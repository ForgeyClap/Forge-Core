# Phase owners — a primary and a fallback Boss per phase

Every phase of a Forge run has one **primary** Boss and one **fallback** Boss from the fixed roster
(`.claude/agents/`). The fallback is used only when the primary cannot take the package: its agent file is
missing in this project, it stalled (the lane watchdog flagged it and it was stopped), or the owner asked for
someone else. A fallback is **not** an escalation: a Verify Boss FAIL still gets the one GOAT retry on the same
Boss (more effort, then a bigger model) before anyone else is tried.

| Phase | Primary | Fallback | Why this fallback |
|---|---|---|---|
| Mission plan (deep packages) | boss | head-chef | Head Chef already decomposes; it plans small missions alone |
| Decompose + triage + size | head-chef | boss | Boss owns the mission and can cut packages itself |
| Intake + PRD | head-chef | boss | the PRD is part of decomposition |
| Research, current facts | search-boss | skill-boss | Skill Boss searches skills and tools daily |
| Skill discovery, Scout vetting | skill-boss | search-boss | Search Boss runs Scout's search step anyway |
| Code build | build-boss | integration-boss | same build route, writes code |
| UI / frontend | ui-boss | build-boss | Build Boss builds the UI with the web-quality contract prepended |
| Integrations, automations | integration-boss | build-boss | same build route |
| Tests written | test-boss | build-boss | Build Boss writes the tests; Verify Boss then runs them |
| Verify gate | verify-boss | test-boss | Test Boss runs the checks read-only and logs the verdict |
| Code review | review-boss | codex-reviewer | an independent reviewer; label it if it did not run |
| Security review | security-boss | review-boss | deep route, runs the security checklist |
| Docs | docs-boss | skill-boss | same quick route, already edits skill docs |
| SEO | seo-boss | ui-boss | UI Boss owns the page markup |

Rules:
- **No self-review through the fallback.** A Boss that built a package never verifies or reviews that same
  package as a fallback; pick the next Boss in the review chain instead and say so in the work package.
- **Name it.** A package run by a fallback says `fallback for <primary>: <reason>` in its dispatch text and in
  the agent ledger line, so the dashboard and the report show who really did the work.
- **Route stays the package's route.** The fallback runs on the model and effort Head Chef triaged for the
  package, not on its own default, when the Lead can set it (Workflow `agent({agentType, model, effort})`).
