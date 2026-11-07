---
name: forge-router
description: "Use first on any /forge or build ask (maak, bouw, fix): team + playbook."
# A10 original description (listing budget): "Use first on any /forge or build ask (maak, bouw, automatiseer, build, fix): picks the smallest team + playbook."
# W2-BUDGET original description (listing budget): "Use first on any /forge or build ask (maak, bouw, automatiseer, build, fix): smallest team + playbook."
---

# Forge router (agent selection)

**Self-improvement substrate (wp-skill-evals, 2026-07-31):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction (an owner fix, a false assumption caught, a preference stated), append it to
`learnings.md` with a date and real evidence — never invent a lesson that didn't happen.

You are the **router**. You do **not** implement. You output a **TEAM PLAN** + **Project Adaptation** block, then hand off to the matching domain playbook. Use the smallest team that fits — never spawn an agent per trivial step.

This file is the **always-loaded core**: open the doc named for a step before you carry it out, never work from memory of an older, longer version. The `/forge` core governs project isolation, honesty, the scribe gate, the run contract and the hard gates; nothing here relaxes them. (Full original paragraph: `references/routing-checklist.md`.)

## Core routing checklist (in order)
One line per step; full wording of each step (every command, flag, clause): `references/routing-checklist.md`.
1. **Step 0 — memory + ECC inventory:** read the project profile, memory, task history and ECC mode; mark `inferred`/`unknown`, never fake.
2. **Step 0-owner:** prefs, standing rules, autonomy and owner config in `config/orchestration/precedence.md` order; only `/forge remember` writes a new active standing rule.
3. **ECC-first:** map every role to a real ECC agent/skill; native only as a labeled fallback; tag `runtime`.
4. **Step 0a — intake (BUILD, L2+), silent by default:** at most ONE owner question; then the PRD is an obligation (`forge-prd.cjs write … --tickets`).
5. **Step 0b — Skill Discovery (required before assigning subagents):** a skill gap is never ignored; every executable subagent has `skill` + `skill_source`.
6. **Step 1 — classify the domain** (run the analyze entrypoint first; table below).
7. **Step 2 — complexity L1–L4**, roster capped by config `team-max`. Per package Head Chef sizes it with `forge-wpsize.cjs` (files touched, new dependency or contract, design ambiguity; the highest tier wins; any security or public-API change is at least `standard`).
8. **Step 3 — domain → team** with exact ECC names; specialists only when the stack needs them (`payment-integration`, `electron-pro`). Every phase has a primary and a fallback Boss (`references/phase-owners.md`); a fallback is named in the package and is never an escalation.
9. **Step 3x — GOAT routing (HARD MUST):** Head Chef triage `{route, risk, checks}`; every dispatch routed; Verify Boss verifies; ONE escalation; never `escalate` up front.
10. **Step 3a — web quality:** a website, landing, spa or fullstack builder gets `config/orchestration/web-quality-contract.md` prepended to its dispatch prompt; never completed without a real screenshot.
11. **Step 3b / 3c — opt-in tools:** MCP only via `forge-mcp-gate.cjs` when config `mcp` is on; Wave J tools only when their signal is real.
12. **Step 4 — parallel vs serial:** parallelize only independent work, one worktree per parallel writer; you are the integration layer. **Hotspot lock protocol:** `forge-lock-guard.cjs acquire` before a hotspot writer, `release` on its terminal event (exit 3 = conflict → serialize or isolate).
13. **Step 5 — review & delivery** (`forge-code-review` order, Codex per config, end with `forge-report`). **Step 6 — load the playbook by name.**
14. **Output TEAM PLAN + Project Adaptation; emit work packages** with every field and dispatch clause (prompt lint, clarifications check, lesson recall + claude-mem earlier-work recall, live logging).
15. **Step 4d — WP-dispatch v10 + contract-first:** a Verify Boss pass per package; ONE authoritative contract for shared interfaces; nothing is complete until the integration gate passes.

**Superpowers precedence:** the superpowers start-up text ("invoke any skill with a 1% chance") does not replace this checklist. Inside a Forge task this router and the GOAT route choose the skills; superpowers process skills (brainstorming, systematic debugging, TDD, verification) run inside a route, the project-local Forge copy wins over a plugin duplicate, and a skill that does not fit the route is skipped with one line.

## Step 1 — Classify the domain (Quality Intelligence, REQUIRED for BUILD tasks)
Run the ONE executable analysis entrypoint FIRST (canonical multi-label source: domain-catalog.json); the table below is the human fallback:

```
node .claude/forge-bin/forge-quality.cjs analyze "<de missie>" --log-run <run_id>
```

Consume ALL of its output: `profile` + `playbook`, the 10 `lenses`, `omissions`, `knowledge_cards` and `council` from `councilTrigger()` (logged as a `decision_logged` event ALSO when the mode is NONE). If the classifier and this table disagree, the classifier + catalog win. Full output contract: `references/routing-checklist.md`.

Pick the primary domain (if mixed, pick the primary and attach the secondary playbook):

| Signals / keywords | Domain | Playbook |
|---|---|---|
| website, landing page, hero, CTA, responsive, UI/UX, a11y, SEO, frontend | Website/frontend | `forge-website` |
| app, SaaS, backend + frontend + DB, login/auth, CRUD, dashboard with data | Full-stack app | `forge-fullstack` |
| n8n, workflow, webhook, node, trigger, schedule/cron, automation pipeline | n8n/automation | `forge-n8n` |
| scrape, crawler, harvest, data collection, lead list, API pull | Scraping/data | `forge-scraping` |
| chatbot, assistant, RAG, retrieval, embeddings, knowledge base, ingestion | AI chatbot/RAG | `forge-rag` |
| prediction, forecast, sports, betting, odds, value, backtest, tips | Prediction/data | `forge-prediction` |
| integration, API, Gmail/Calendar/CRM, OAuth, webhook between apps, sync | Business automation | `forge-integration` |
| payment, checkout, Stripe/Mollie/Adyen/PayPal, iDEAL, card, PCI, subscription, refund, charge, webhook signature | Payments/billing | `forge-payments` |
| shop, store, cart, catalog, product/SKU, inventory, order, Shopify/WooCommerce/Etsy, digital product, cashflow | E-commerce | `forge-ecommerce` |
| electron, desktop app, .exe, installer, preload, IPC, contextIsolation, nodeIntegration, code signing, an accounting desktop app | Electron/desktop | `forge-electron` |
| voice agent, voicebot, phone, call, telephony, IVR, Twilio/Vapi/Retell, barge-in, Dutch call, outbound | Voice/phone agent | `forge-voice` |
| agent, LLM app, tool use, function calling, tool schema, prompt injection, jailbreak, eval, benchmark, guardrail, agent loop, MCP tool | Agent / LLM app + evals | `forge-agent` |
| API, REST, endpoint, route, OpenAPI, Swagger, GraphQL, gRPC, proto, contract test, versioning, idempotency, rate limit, pagination, error envelope, backend | Contract-first API | `forge-api` |
| bot, Discord, Slack, Telegram, slash command, interaction, webhook, Ed25519, Slack-Signature, bot token, intents, gateway, dead-letter | Chat/messaging bots | `forge-bots` |
| CLI, command line, argparse, commander, clap, cobra, flag, --help, exit code, stdin/stdout/stderr, pipe, dry-run, shell tool, terminal, subcommand | CLI / dev tool | `forge-cli` |
| CMS, WordPress, wp-config, theme, plugin, ACF, custom post type, WP-CLI, headless CMS, Contentful, Sanity, Strapi, Payload, content model | CMS | `forge-cms` |
| data pipeline, ETL, ELT, dbt, warehouse, Snowflake, BigQuery, Redshift, staging, marts, medallion, incremental load, backfill, data quality, lineage, Airflow, Dagster | Data engineering / ETL | `forge-data` |
| chrome extension, browser extension, MV3, manifest v3, service worker, content script, chrome.runtime, host_permissions, chrome.storage, CSP, CRX, Web Store | Browser extension | `forge-extension` |
| figma, design to code, mockup, redlines, design tokens, component library, variants, auto-layout, pixel-perfect, breakpoints, dev mode | Design → code | `forge-figma` |
| game, browser game, canvas, WebGL, Phaser, vanilla JS game, Godot, GDScript, game loop, win state, lose state, sprite, collision, playtest | Games | `forge-game` |
| migration, modernization, legacy, rewrite, port, upgrade, strangler fig, characterization test, golden master, parity, shadow traffic, dual-write, feature flag, replatform | Legacy modernization | `forge-migration` |
| mlops, ML pipeline, training pipeline, model registry, MLflow, DVC, feature store, train/serve skew, drift, canary, retraining, rollback, model serving | Production ML / MLOps | `forge-mlops` |
| mobile, mobile app, React Native, Expo, EAS, Flutter, Dart, iOS, Android, apk, aab, ipa, emulator, simulator, secure storage, App Store, Play Store | Mobile app | `forge-mobile` |

Dashboards fold into `forge-website` or `forge-fullstack`; card handling always folds into `forge-payments`; pure refactor/audit/debug/research/security-review → no domain playbook (fold-in rules in the reference doc). If no domain matches, default to `general-purpose` + `planner`.
Unknown, low-confidence or mixed type: never force-fit; follow `references/unknown-project-types.md` (classify, discovery brief, provisional card, `gate --domain <slug>`).
Cross-cutting craft playbooks (not domains; add them per work package on top of the domain playbook when the package touches that area): database/migrations → `forge-database`; login/sessions/roles → `forge-auth`; tests/e2e/flaky → `forge-testing`; security review, secrets, skill/MCP vetting → `forge-security-review`; WCAG/keyboard/contrast → `forge-a11y`; speed, Core Web Vitals, SEO → `forge-web-quality`; CI/CD, Docker, deploy config → `forge-devops`; logs/tracing/monitoring → `forge-observability`; translations, README/ADR/API docs → `forge-i18n-docs`.

## Reference index (on-demand, full verbatim wording)
Docs: `.claude/docs/forge-reference/router-intake-and-skill-discovery.md` (Steps 0–0b) · `.claude/docs/forge-reference/router-classify-domain-complexity.md` (Steps 1–2) · `.claude/docs/forge-reference/router-team-routing-and-goat.md` (Steps 3, 3x) · `.claude/docs/forge-reference/router-web-quality-mcp-wave-j.md` (Steps 3a–3c) · `.claude/docs/forge-reference/router-parallel-handoff-review.md` (Steps 4–6) · `.claude/docs/forge-reference/router-team-plan-and-work-packages.md` (TEAM PLAN, work packages) · `.claude/docs/forge-reference/router-dispatch-v10-contract-first.md` (Step 4d). "Read it when" table: `references/routing-checklist.md`. Prompt format: `PROMPT_TEMPLATE.md` (this folder).

## Team chat (WP A1, 2026-11-01)
All 12 Bosses hold `SendMessage`. Use it for a hand-off to the next Boss in a serial pipeline, a blocker for the Lead, or a question to another Boss; give each Boss the receiver's name in its prompt (subagents have no ListAgents). One line per message: `[<Boss> -> <Boss|Lead>] <one line> | wp=<id> | run=<id>`. Every message is also appended to the run channel `team-chat.jsonl`: Bosses with a shell run `node .claude/forge-bin/forge-say.cjs <run_id> --from "<Boss>" --to "<Boss|lead>" --wp <id> --kind message|handoff|blocker|question "<text>"`; Bosses without one list their messages under a `TEAM MESSAGES` heading and the Lead relays them with `--via lead`. Read the channel with `forge-say.cjs <run_id> --list [--wp <id>]`. The Lead stays the integration layer. Detail: `.claude/docs/forge-reference/router-parallel-handoff-review.md` Step 4c (the TEAM-CHAT note in the dev tree's docs folder `forge-systeem` holds the full contract).
