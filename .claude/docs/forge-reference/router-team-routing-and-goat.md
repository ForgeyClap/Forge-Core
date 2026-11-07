# Forge router reference — Step 3 domain-to-team table, repomap, Step 3x GOAT routing

> **On-demand reference, moved VERBATIM** out of `.claude/skills/forge-router/SKILL.md`, so
> the forge-router skill core stays short enough to survive compaction. The core's numbered rules still govern; this file
> holds the full, unmodified wording of lines 86-126 of the earlier file (whole-file sha256 `66355b53d6a9f698d081e1a53a2595386a75871c86b88753bfca04435bae7184`).
> Nothing between the two markers below was reworded. **When to read:** when picking the roster for a domain (exact ECC agents/skills per domain) or dispatching on a GOAT route.

<!-- wp11-verbatim-begin source=.claude/skills/forge-router/SKILL.md lines=86-126 -->
## Step 3 — Domain → team routing (exact ECC names; specialists are CONDITIONAL by stack/level)

| Domain | Lead/plan | Core specialists | Key ECC skills / commands / MCP | Default level |
|---|---|---|---|---|
| Website/frontend | `planner` / `architect` | `a11y-architect`, `seo-specialist`, `react-reviewer` *or* `vue-reviewer`, `performance-optimizer`, `marketing-agent` | `design-is`, `browser`, `/react-build` `/react-review`, `/test-coverage` | L2–L3 |
| Full-stack app | `architect`, `planner` | `typescript-reviewer`/`python-reviewer`, `react-reviewer`, `fastapi-reviewer`/`django-reviewer`, `database-reviewer`, `security-reviewer`, `e2e-runner`, `tdd-guide` | `make-plan`→`do`, `using-git-worktrees`, language build/test commands | L3–L4 |
| n8n/automation | `planner` (skill+MCP-driven) | `security-reviewer` (creds only) | `n8n-mcp-tools-expert`, `n8n-workflow-patterns`, `n8n-node-configuration`, `n8n-validation-expert`, `n8n-expression-syntax`, `n8n-code-javascript`/`-python`, n8n MCP tools | L2–L3 |
| Scraping/data | `architect` | `python-reviewer`, `security-reviewer`, `silent-failure-hunter`, `database-reviewer` | `browser`, `systematic-debugging` | L2–L3 |
| AI chatbot/RAG | `architect` | `mle-reviewer`, `python-reviewer`/`typescript-reviewer`, `security-reviewer`, `database-reviewer` | `agentdb-vector-search`, `docs-lookup`, `learn-codebase`, `claude-api` | L3 |
| Prediction/data | `mle-reviewer`, `planner` | `mle-reviewer`, `python-reviewer`, `silent-failure-hunter`, `database-reviewer` | `systematic-debugging`, `/test-coverage`, `forge-n8n` (delivery) | L3 |
| Business automation/API | `architect` | `security-reviewer` (lead), `silent-failure-hunter`, `python-reviewer`/`typescript-reviewer`, `database-reviewer` | `n8n-workflow-patterns`, Gmail/Calendar/CRM MCP via ToolSearch | L2–L3 |
| Payments/billing | `integration-boss`/`build-boss` | `payment-integration` (specialist), `silent-failure-hunter`, `typescript-reviewer`/`python-reviewer`, `database-reviewer`, `codex-reviewer` (recommended) | `forge-payments`, gateway SDK docs (Context7), `claude-api` (if LLM) | L2–L3 |
| E-commerce/store | `build-boss`/`integration-boss` | `payment-integration`, `database-reviewer`, `silent-failure-hunter`, `typescript-reviewer`/`python-reviewer` | `forge-ecommerce` + `forge-payments` + `forge-website`, connector SDK docs | L2–L4 |
| Electron/desktop | `build-boss`/`integration-boss` | `electron-pro` (specialist), `typescript-reviewer`, `security-reviewer`, `database-reviewer` | `forge-electron` + `forge-website` (renderer), electron-builder docs, `systematic-debugging` | L2–L3 |
| Voice/phone agent | `integration-boss` (+`head-chef`) | `silent-failure-hunter`, `typescript-reviewer`/`python-reviewer`, `database-reviewer`, `security-reviewer` (consent path) | `forge-voice` + `forge-rag` (answers) + `forge-integration` (post-call), `humanizer`, telephony SDK docs | L2–L3 |
| Refactor / dead code | `code-architect` | `refactor-cleaner`, `code-simplifier`, language reviewer | `/refactor-clean`, `smart-explore` | L1–L2 |
| Audit / explain | `code-explorer` | language reviewer, `security-reviewer` | `graphify`, `learn-codebase`, `smart-explore` | L1–L2 |
| Debugging | (lead yourself) | `silent-failure-hunter`, relevant build-resolver, language reviewer | `systematic-debugging`, `forge-debug` (Forge orchestration wrapper) | L1–L3 |
| Agent / LLM app + evals | `architect`/`build-boss` | `mcp-developer` (tool/MCP schema safety), `ml-engineer` (eval harness + drift), `data-scientist` (eval-dataset design), `security-boss` (injection/trifecta) | `claude-api`, `forge-rag`, `agentdb-vector-search` | L2–L4 |
| Contract-first API | `architect` | `integration-boss`/`build-boss`, `security-boss` (authN/authZ), `database-reviewer`, `test-boss` (contract tests), `docs-boss` | `forge-api`, OpenAPI/contract-test tooling | L2–L3 |
| Chat/messaging bots | `integration-boss`/`build-boss` | `security-boss` (signature/secret verification), `test-boss`, `silent-failure-hunter`, `mcp-developer` (if MCP-exposed) | `forge-bots`, platform SDK docs (Context7) | L2 |
| CLI / dev tool | `architect`/`build-boss` | `build-boss`, `test-boss` (exit-code/stdio), `docs-boss` (`--help`/README), `security-boss` (opt., shell-out/secrets) | `forge-cli`, `systematic-debugging` | L1–L2 |
| CMS (WordPress/headless) | `build-boss`/`integration-boss` | `security-boss` (escaping/nonces/secrets), `database-reviewer`, `seo-boss`, `test-boss`, `php-reviewer`/`typescript-reviewer` | `forge-cms`, `forge-website` (rendered front-end) | L2–L3 |
| Data engineering / ETL / dbt | `build-boss`/`integration-boss` | `data-scientist` (dq-test design), `database-reviewer` (SQL/schema/merge), `silent-failure-hunter`, `security-boss` (opt., PII) | `forge-data`, Airflow/dbt docs (Context7) | L2–L3 |
| Browser extension (MV3) | `build-boss` | `security-boss` (permissions/CSP/no-remote-code), `test-boss` (E2E via Playwright/Puppeteer), `ui-boss`, `typescript-reviewer` | `forge-extension`, `forge-integration` (backend calls) | L2 |
| Design → code (Figma) | `ui-boss`/`build-boss` | `a11y-architect`, `react-reviewer`/`vue-reviewer`, `mcp-developer` (opt., Figma MCP), `seo-boss` (if landing surface) | `forge-figma`, `design-is` | L2 |
| Games (browser/Godot) | `build-boss` | `ui-boss` (HUD/responsive canvas), `test-boss` (loop QA via `browser`), `typescript-reviewer`, `ml-engineer`/`data-scientist` (opt., procedural/ML content) | `forge-game`, `browser` | L2–L3 |
| Legacy modernization / migration | `build-boss` + `head-chef` (phasing) | `test-boss` (characterization/parity harness), `database-reviewer`, `silent-failure-hunter`, `security-boss`, `review-boss` (per-slice gate) | `forge-migration` + the rebuild target's own playbook | L3–L4 |
| Production ML / MLOps | `build-boss`/`integration-boss` | `ml-engineer` (pipeline/serving/rollout), `data-scientist` (offline eval, leakage), `database-reviewer` (feature parity), `silent-failure-hunter`, `security-boss` (opt.) | `forge-mlops` (opt-in Python) | L3 |
| Mobile app (RN/Expo/Flutter) | `build-boss` | `mobile-dev` (native work), `ui-boss` (touch/safe-area/orientation), `test-boss` (device/emulator QA), `security-boss` (secure storage) | `forge-mobile`, `forge-integration` (backend calls) | L2–L3 |

**Invoke `forge-repomap.cjs` WHEN** the codebase is large/unfamiliar and you need cheap, token-light orientation before committing to a read plan **and config `code-index` is on**: `node .claude/forge-bin/forge-repomap.cjs --root <dir> --json` (a bounded directory walk + per-file symbol skim — no whole-repo read, no AST, no LLM call). Follow with `Explore` / `smart-explore` (or `graphify`) for a deeper pass, **then** route. If no domain matches, default to `general-purpose` + `planner`.

## Step 3x — GOAT model routing (HARD MUST, 2026-10-06)
Routes and values live in `.claude/FORGE_MODEL_ROUTING.json` (forge-core v11; `~/.claude/MODEL_ROUTING_GLOBAL_POLICY.md`). Per work package:
1. **Triage first:** Head Chef (sonnet · low) adds `{route: quick|build|deep, risk: low|medium|high, checks: [tests, typecheck, lint, review]}`. Fallback when Head Chef is unavailable: `node .claude/forge-bin/forge-policy.cjs route "<task>" [--risk …]`. Never pick `escalate` up front.
2. **Dispatch on the route model:** `Agent({subagent_type:'<boss>', model:<route model>, …})`. When the route effort differs from the Boss frontmatter effort, pass it too: `Agent({…, effort:<route effort>})` (updated 2026-11-01: Claude Code 2.1.292 added the Agent-tool `effort` param, installed 2.1.316), or dispatch through a Workflow `agent({agentType, model, effort})`, or pick a Boss whose default route matches. A dispatch without `effort` runs at the Boss frontmatter effort; log the ACTUAL model + effort.
   **Ultracode (on by default):** prefer a Workflow `agent({agentType:'<boss>', label:'<Boss Name> · <part>', model:<route model>, effort:<route effort>})` per part — every `agent()` routed (agentType frontmatter or explicit opts; `~/.claude/hooks/goat-workflow-guard.cjs` denies an unrouted one); the plain Agent tool is the fallback (`FORGE_MODEL_ROUTING.json` → `ultracodeDispatch`).
3. **Verify:** Verify Boss (sonnet · medium, never edits) runs the triaged `checks` and replies PASS/FAIL with evidence (see Step 4d).
4. **One escalation:** on FAIL, `node .claude/forge-bin/forge-policy.cjs escalate <route> <process|context>` — process failure → more effort first, capability failure → bigger model (build → deep → fable/high). A second FAIL stops and is reported to the owner. Append one lesson line to `.claude/agent-memory/head-chef/MEMORY.md`.
   Before the retry the Lead (or Head Chef) logs `escalation {wp_id, from, to, reason: process|capability}` and the Verify Boss logs `wp_verified {wp_id, verdict, command, exit_code}` for every work package (PASS and FAIL), both via `.claude/forge-dashboard/log-event.cjs`.

<!-- wp11-verbatim-end -->
