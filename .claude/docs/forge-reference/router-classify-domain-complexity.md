# Forge router reference — Step 1 domain classification (Quality Intelligence) + Step 2 complexity

> **On-demand reference, moved VERBATIM** out of `.claude/skills/forge-router/SKILL.md`, so
> the forge-router skill core stays short enough to survive compaction. The core's numbered rules still govern; this file
> holds the full, unmodified wording of lines 37-85 of the earlier file (whole-file sha256 `66355b53d6a9f698d081e1a53a2595386a75871c86b88753bfca04435bae7184`).
> Nothing between the two markers below was reworded. **When to read:** when classifying a BUILD task: the full analyze-entrypoint contract (profile, lenses, omissions, knowledge cards, council) and the fold-in rules for mixed domains.

<!-- wp11-verbatim-begin source=.claude/skills/forge-router/SKILL.md lines=37-85 -->
## Step 1 — Classify the domain (Quality Intelligence, REQUIRED for BUILD tasks)
**Run the ONE executable analysis entrypoint FIRST** (F-14: one command, the whole chain — no prose function names to remember). It is the canonical multi-label source (domain-catalog.json); the table below is the human fallback:

```
node .claude/forge-bin/forge-quality.cjs analyze "<de missie>"
```

One JSON output carries the whole chain — consume ALL of it, not just the profile:
1. `profile` + `playbook`: `primary_domain` picks the playbook; ALL `project_type` labels steer quality discovery. `classification_confidence: 'none'` means the type was NOT recognized — resolve the type explicitly (intake) before building; the fullstack fallback is an assumption, not a classification.
2. `lenses` (10): every lens carries an explicit disposition (RELEVANT / NOT_APPLICABLE / DEFERRED / OWNER_GATED) with a reason; silently skipping a dimension is not allowed.
3. `omissions`: forgotten-requirement cards along five axes, all pre-validated (`omissions_valid` must be true; re-validate edited cards with `validateRequirementCard`); accepted cards become PRD acceptance criteria.
4. `knowledge_cards`: validated descriptors (slug/path/exists/sha256/relevance). Load only cards with `exists: true` via `node .claude/forge-bin/forge-quality.cjs card <slug>` — max 6, max 3 retrieval rounds; a missing card is an honest gap, never invented content.
5. `council`: NONE is the default (computed by `councilTrigger()` inside the analysis; call it directly for standalone decision points). **Log the trigger decision as a `decision_logged` event — ALSO when the mode is NONE** (deciding NOT to convene a council is a decision with a reason, not silence): run the analysis with `--log-run <run_id>` (`node .claude/forge-bin/forge-quality.cjs analyze "<de missie>" --log-run <run_id>`) so the event is written by the real event writer, not by prose; on FULL, follow the `forge-council` skill and persist the record via `council-save`. Council consensus is never evidence.

If the classifier and this table disagree, the classifier + catalog win; fix the catalog (one source), never fork the table.

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

Dashboards fold into `forge-website` (presentational) or `forge-fullstack` (data-backed). Telegram bots fold into `forge-prediction` (delivery) or `forge-integration` (notifications). **Card handling always folds into `forge-payments`** (never re-implement card capture in another playbook); a **store** is `forge-ecommerce` + `forge-payments` for checkout + `forge-website` for the storefront; a **desktop app** wrapping a service is `forge-electron` + the service's playbook; a **voice agent** with a knowledge layer is `forge-voice` + `forge-rag`. Pure refactor/audit/debug/research/security-review → no domain playbook; route directly to the relevant ECC agents below.

## Step 2 — Classify complexity (L1–L4)
Use the fan-out table in `CLAUDE.md` (don't restate it). L-level sets the team size budget: L1 1–3 · L2 3–6 · L3 6–12 · L4 phased. **Cap the roster at the owner config `team-max`** (`node .claude/forge-bin/forge-config.cjs get team-max`): `auto` (default) = the L-level budget; a number N = never more than N Bosses dispatched at the same time, whatever the level — put the rest in later waves instead of dropping work.

<!-- wp11-verbatim-end -->
