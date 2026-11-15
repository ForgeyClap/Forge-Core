<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# GOAT model routes

Generated from: `.claude/FORGE_MODEL_ROUTING.json`.

| route | model | effort | Forge agent | when |
|---|---|---|---|---|
| `triage` | sonnet | low | head-chef | FIRST for every coding task / work package. Read-mostly. Returns {"route":"quick\|build\|deep","risk":"low\|medium\|high","checks":["tests","typecheck","lint","review"]} and records it on the package's agent_work_package_created event. |
| `quick` | sonnet | low | — | Small and well-specified, one or two files. |
| `build` | opus | medium | — | A normal feature or bug fix. |
| `deep` | opus | xhigh | — | Architecture, migrations, auth, payments, data, production, security, or anything unclear. |
| `escalate` | fable | high | — | ONLY after a failed Verify Boss check on a deep-route package (one step up from deep) — never chosen up front. |
| `verifier` | sonnet | medium | verify-boss | After EVERY work package. Runs the triage checks scaled to risk (low = tests for the touched files; high = full suite + typecheck + lint + a careful diff read) and replies PASS/FAIL with evidence. NEVER edits. |

## Default route per agent

- `ai-eval-engineer`: verifier
- `ai-rag-engineer`: build
- `ai-voice-designer`: build
- `app-architect`: deep
- `app-backend-engineer`: build
- `app-data-reviewer`: verifier
- `app-domain-reviewer`: deep
- `auto-bot-engineer`: build
- `auto-n8n-engineer`: build
- `auto-n8n-validator`: verifier
- `boss`: deep
- `build-boss`: build
- `codex-reviewer`: verifier
- `data-backtest-auditor`: verifier
- `data-compliance-reviewer`: deep
- `data-scientist`: build
- `data-scraper-engineer`: build
- `desk-installer-engineer`: build
- `desk-qa-tester`: verifier
- `docs-boss`: quick
- `electron-pro`: build
- `game-designer`: build
- `game-playtester`: verifier
- `game-programmer`: build
- `head-chef`: triage
- `integration-boss`: build
- `mcp-developer`: build
- `ml-engineer`: build
- `mob-app-engineer`: build
- `mob-qa-tester`: verifier
- `mob-release-engineer`: build
- `payment-integration`: deep
- `rbx-blender-artist`: build
- `rbx-game-director`: build
- `rbx-integrator`: deep
- `rbx-liveops-producer`: build
- `rbx-luau-engineer`: build
- `rbx-qa-tester`: build
- `rbx-security-reviewer`: deep
- `rbx-skill-monitor`: quick
- `rbx-ui-engineer`: build
- `rbx-verifier`: verifier
- `rbx-vfx-audio`: build
- `rbx-world-builder`: build
- `res-analyst`: build
- `res-fact-checker`: verifier
- `res-plan-writer`: build
- `review-boss`: deep
- `scribe`: quick
- `scribe-acker`: quick
- `search-boss`: quick
- `security-boss`: deep
- `seo-boss`: quick
- `shop-catalog-engineer`: build
- `shop-listing-writer`: build
- `shop-ops-analyst`: verifier
- `shop-product-researcher`: build
- `skill-boss`: quick
- `test-boss`: verifier
- `ui-boss`: build
- `verify-boss`: verifier
- `web-art-director`: build
- `web-content-writer`: build
- `web-dataviz-engineer`: build
- `web-frontend-engineer`: build
- `web-qa-proof`: verifier

## Escalation

- maxPerTask: 1
- processFailure: {"signal":"Verify Boss FAIL because the worker skipped a file or did not run the tests.","step":"MORE EFFORT first: same Boss, effort one level up (low -> medium -> high -> xhigh) via Workflow agent({agentType, model, effort}); without a Workflow, the next route (quick -> build)."}
- capabilityFailure: {"signal":"Verify Boss FAIL although the worker had the full context.","step":"BIGGER MODEL: build -> deep -> escalate (fable/high)."}
- secondFail: Stop. Report honestly to the owner with the evidence. No repair loop — failed cheap runs cost more than 4x a successful one.
- afterEscalation: Append ONE line to the lessons file: '<YYYY-MM-DD> <task pattern> -> <route that worked>'.
