<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# Forge skills (133)

Generated from: `.claude/skills/`.

Each line: the skill name and its description (the line the model sees in the skill listing). Open a skill with the Skill tool, or Read its SKILL.md under the skills folder.

## Forge playbooks (one per project type) (23)

- `forge-a11y`: Playbook for WCAG 2.2 audits: axe, keyboard (gebruik bij toegankelijkheid).
- `forge-agent`: Playbook for AI agents and LLM apps: tool calling, evals (gebruik bij AI-agents).
- `forge-api`: Playbook for APIs: REST, GraphQL, OpenAPI (gebruik bij een API).
- `forge-auth`: Playbook for login: sessions, OAuth, RBAC (gebruik bij inloggen).
- `forge-cli`: Playbook for CLIs and dev tools: flags, exit codes (gebruik bij een CLI-tool).
- `forge-cms`: Playbook for WordPress and headless CMS: themes, plugins (gebruik bij een CMS).
- `forge-data`: Playbook for data pipelines: ETL/ELT, dbt (gebruik bij een datapijplijn).
- `forge-database`: Playbook for databases: Postgres, Prisma, migrations (gebruik bij database).
- `forge-ecommerce`: Playbook for web shops: checkout, Shopify, WooCommerce, Etsy (gebruik bij een webwinkel).
- `forge-electron`: Playbook for Electron desktop apps: safe IPC, installer (gebruik bij een desktop-app).
- `forge-extension`: Playbook for MV3 browser extensions: permissions, CSP (gebruik bij een extensie).
- `forge-figma`: Playbook for design-to-code: Figma, design tokens (gebruik bij ontwerp naar code).
- `forge-fullstack`: Playbook for full-stack apps: backend, auth, SaaS, CRUD dashboards (gebruik bij een webapp).
- `forge-game`: Playbook for browser and Godot games: game loop, win/lose states (gebruik bij een spel).
- `forge-migration`: Playbook for legacy modernization: strangler fig (gebruik bij een migratie).
- `forge-mlops`: Playbook for production ML: model registry, serving, drift (gebruik bij ML in productie).
- `forge-mobile`: Playbook for mobile apps: React Native, Expo, Flutter (gebruik bij een mobiele app).
- `forge-payments`: Playbook for payments and billing: Stripe, Mollie, refunds (gebruik bij betalingen).
- `forge-prediction`: Playbook for predictions and sports data: odds, backtests, no betting (gebruik bij voorspellingen).
- `forge-rag`: Playbook for chatbots and RAG: retrieval, cited answers (gebruik bij een chatbot).
- `forge-voice`: Playbook for AI voice and phone agents: Twilio, Vapi (gebruik bij een belagent).
- `forge-web-quality`: Playbook for web speed and SEO: Core Web Vitals (gebruik bij sneller maken).
- `forge-website`: Playbook for websites, landing pages and frontend UI: responsive, SEO (gebruik bij een website).

## Forge skills (process and method) (58)

- `forge-agent-report`: Use when dispatching a Boss or reading its report.
- `forge-android-app`: Use when building an Android .apk from a web UI with Vite + Capacitor and proving it in the emulator (apk maken, telefoon app, android app bouwen, apk testen).
- `forge-audit-setup` (user-invoked only): User-invoked only: /forge-audit-setup. Audits the project and global Claude Code setup against the latest official features and writes an Adopt/Improve/Remove/Security/Parked report.
- `forge-autoresearch` (user-invoked only): User-invoked only: /forge-autoresearch. Bounded keep-or-revert experiment loop on one measured metric (speed, size, score): frozen harness, one change per round, decision log.
- `forge-bots`: Use when building a Discord, Slack or Telegram bot in code; n8n bots: forge-n8n.
- `forge-brainstorm`: Use when the approach is unclear (welke kant op, opties): one direction.
- `forge-code-review`: Use to self-review a diff or PR before commit (kritische review, testgat).
- `forge-conduct`: Use when doing any Forge work: the seven house rules every agent follows (werkwijze, hoe werk je, klaar, bewijs).
- `forge-context`: Use when context degrades (context vol, vergeet instructies) or before /compact.
- `forge-council`: Use only on a councilTrigger FULL verdict: 5 independent advisors.
- `forge-craft`: Use before calling work done: what would its user notice?
- `forge-debug`: Use for any bug, crash, failing build or slowdown before a fix (werkt niet, kapot, foutmelding, traag).
- `forge-deeplearn`: Use in an unknown repo or before a PRD or big refactor: read-only scan.
- `forge-devops`: Use for Docker, CI/CD, GitHub Actions, Terraform or deploys (deployen).
- `forge-docdrift` (user-invoked only): User-invoked only: /forge-docdrift. Fetches the external docs our skills cite (Claude Code, n8n) and flags possible claim drift; manual because it makes network calls.
- `forge-doctor` (user-invoked only): User-invoked only: /forge-doctor. Runs Forge's multi-minute self-test (every suite) plus the secret-leak scan; kept manual because one run costs minutes of CPU.
- `forge-ecc-adapter`: Use when running an ECC skill or command that hard-codes ~/.claude/skills paths (ECC skill draaien).
- `forge-glass-ui`: Use when styling a UI in Mono Glass: black and white, glassy buttons, fast, simple like Grok (glassy, zwart wit, zoals grok, dashboard, exe, apk ontwerp).
- `forge-graded-verify`: Use to grade RAG, research, scraping or prediction answers (beoordeel).
- `forge-guardian`: Use only for auto-rollback, canary or circuit breakers (zelfherstel).
- `forge-heartbeat`: Use when a multi-agent run feels stalled: finds the silent agent.
- `forge-i18n-docs`: Use when writing or fixing project docs (README, changelog) or i18n (meertalig).
- `forge-intake`: Use at the start of a /forge build (nieuwe opdracht, nieuw project).
- `forge-integration`: Use when coding an API integration (OAuth, CRM, webhooks); n8n: forge-n8n.
- `forge-long-form-writing`: Use when writing an article, blog or newsletter (schrijf een artikel).
- `forge-mcp-clients`: Use when a Boss needs an MCP server (opt-in), or when building one (MCP koppelen).
- `forge-memory`: Use when recalling earlier work or a lesson (hoe deden we X eerder).
- `forge-mindmap`: Use when a plan reads better as a mind map (nodes and edges).
- `forge-model-routing`: Use when choosing a model or effort for a task, or an agent keeps picking the wrong route (welk model, GOAT, escaleren).
- `forge-n8n`: Use when building, fixing or validating an n8n workflow.
- `forge-nightshift`: Use when asked to keep going overnight (vannacht doorwerken).
- `forge-observability`: Use for traces, metrics, logs, Sentry or incidents (monitoring, storing).
- `forge-plan-large` (user-invoked only): User-invoked only: /forge-plan-large. Plans work too big for one session (groot plan, meerdere sessies, roadmap, plan in kaart): local ticket map, frontier, fog, step briefs.
- `forge-prd`: Use before a non-trivial feature (schrijf een PRD, spec this out): PRD + tickets.
- `forge-projectbrain` (user-invoked only): User-invoked only: /forge-projectbrain. Generates a project-specific CLAUDE.md (identity, commands, hard rules, governance); manual because CLAUDE.md is always-loaded governance.
- `forge-prompt-coach`: Use on vague asks (maak het beter, doe iets): make them buildable.
- `forge-quality`: Use at router Step 1 of a build (wat vergeten we): quality lenses.
- `forge-registry`: User-invoked only: /forge-registry. Builds the opt-in, read-only registry of all Forge projects (status, last run, tickets, ports); manual because it reads other projects.
- `forge-release`: Use when cutting or rolling back a release: bump, changelog, tag, publish (nieuwe versie, release terugdraaien).
- `forge-remote-access`: Use when reaching a local Forge or app from a phone safely via Tailscale or LAN (vanaf mijn telefoon, op afstand goedkeuren, telefoon bediening, remote bridge, pairing).
- `forge-report`: Use when delivering a /forge build or fix (eindverslag, wrap up).
- `forge-research-evidence`: Use when a research result rests on sources (onderzoek met bronnen, citaten checken).
- `forge-router`: Use first on any /forge or build ask (maak, bouw, fix): team + playbook.
- `forge-scout`: Use when asked to find a tool (zoek een skill, plugin, MCP).
- `forge-scraping`: Use when building a scraper or crawler for public or permitted sites (gebruik bij scrapen).
- `forge-scribe`: Use for multi-ask, change or scrap requests.
- `forge-security-review`: Use for a security review of a diff, app or CI (is dit veilig, gelekte keys).
- `forge-skill-authoring`: Use when writing or slimming a skill (nieuwe skill, skill triggert niet).
- `forge-skill-testing`: Use to test or score a skill (skill testen): activation, rubric.
- `forge-snapshot`: Regenerates FORGE_SNAPSHOT.md to survive compaction. Use at a phase boundary.
- `forge-system`: Use when asked what Forge is or how it works end to end (hoe werkt forge, uitleg).
- `forge-team-orchestration`: Use when splitting a job over 2+ parallel Bosses or lanes (werk verdelen).
- `forge-testing`: Use when writing or fixing tests: Playwright, Vitest, flaky (test faalt soms).
- `forge-token-economy`: Use for token or cost questions (hoe vol zit je, kosten) or caveman mode.
- `forge-ui-polish`: Use when a built UI needs a final polish (oppoetsen, strakker maken, ziet er goedkoop/AI-achtig uit).
- `forge-verify`: Use after every work package (is dit echt gedaan): check the done-claim.
- `forge-windows-shell`: Use when running or writing commands on Windows (PowerShell, Git Bash); stop one PID by port (poort bezet).
- `forge-worktrees`: Use when 2+ Bosses write one repo at once (parallel bouwen, worktree).

## Roblox skills (16)

- `roblox-characters`: Use when Roblox character code handles spawn, respawn, Humanoid, animation tracks or cleanup: Player vs Character lifetime, R15 rigs (Roblox karakter, animatie, respawn).
- `roblox-datastores`: Use when a Roblox game saves player data: DataStoreService load and save, UpdateAsync, session locks, retries, BindToClose, leaderboards (Roblox opslaan, data kwijt).
- `roblox-economy-ethics`: Use when designing, pricing or reviewing Roblox Robux items, odds, rewards or retention: shop, game pass, battle pass, loot table, daily reward, streak (winkel, prijzen, kansen, pay-to-win).
- `roblox-game-audit`: Use when Roblox Luau code or a game plan needs a read-only audit with a ranked fix list: remotes, exploits, data safety, purchases, performance, scope (controleer de code, audit).
- `roblox-game-design`: Use when designing or reworking a Roblox game: core loop, tutorial/FTUE, levels, economy, retention phases, juice, grind, curation.
- `roblox-luau`: Use when scripting a Roblox experience in Luau: services, Instances, events, Script vs LocalScript, RemoteEvents across the client/server boundary (Roblox script, Luau).
- `roblox-networking`: Use when designing or hardening Roblox remotes: server authority, argument validation, rate limits, replication, streaming, prediction (Roblox remotes, multiplayer, exploit).
- `roblox-new-system`: Use when planning a new Roblox gameplay system (shop, quests, daily reward, leaderboard, codes, a Service or Controller) as a test-first work package (nieuw systeem, systeem toevoegen).
- `roblox-physics`: Use for Roblox physics and queries: assemblies, constraints, collision groups, raycasts, projectiles, knockback, network-ownership exploits (Roblox physics, botsing).
- `roblox-player-psychology`: Use when designing or reviewing player-behavior mechanics: first minute, rewards, streaks, daily rewards, pricing, RNG/pity, community.
- `roblox-publish-checklist`: Use before publishing or updating a Roblox experience to run evidence-backed release gates and a pre-release audit.
- `roblox-security`: Use when auditing or hardening Roblox code against exploits: authority, remotes, economy, purchases, and DataStore flows.
- `roblox-simulator-economy`: Use when balancing a Roblox simulator, tycoon or idle economy: cost curves, rebirths, offline earnings, big numbers, server-owned purchases (Roblox economie, prijzen).
- `roblox-studio-workflow`: Use when working inside a live Roblox Studio place through Studio MCP or Rojo: inspect first, one writer, playtest proof, placement checks (Roblox Studio, place bewerken).
- `roblox-ui`: Use when building Roblox UI in Luau or Studio: ScreenGui, layout and scaling across phone, PC and console, motion, filtered text (Roblox UI, HUD, menu).
- `roblox-vfx`: Use when making, tuning or reviewing a Roblox visual effect: particles, trail, beam, dash, hit spark, camera shake, a calm preset, flash limits (effect maken, deeltjes, te fel, flits).

## Vendored and other project skills (36)

- `audio-design`: Use when a game needs sound and music: buses, ducking, variation, adaptive music layers (game geluid, muziek).
- `brainstorming`: Use before creative work (features, behavior changes): explore intent.
- `camera-systems`: Use when a game camera follows, orbits or frames the action: smooth follow, deadzones, collision, first person, multi-target (game camera, camera schokt).
- `claude-md-improver`: Use when asked to check, update or fix CLAUDE.md files.
- `create-game-assets`: Use when a game needs a consistent asset set: art direction brief, asset manifest, style checks, engine-ready exports (game assets, sprites, modellen).
- `dispatching-parallel-agents`: Use for 2+ independent tasks with no shared state.
- `executing-plans`: Use to execute a written plan inline, no subagents.
- `finishing-a-development-branch`: Use when work is done and tests pass: integrate it.
- `frontend-design`: Distinctive visual design for new or restyled UI. Use when building UI.
- `game-ai`: Use when game NPCs need behaviour: state machines, behaviour trees, steering, pathfinding, perception (NPC AI, vijand gedrag).
- `game-feel`: Use when a game action needs juice: screen shake, hit-stop, easing, squash and stretch, knockback, layered feedback (game feel, voelt slap, juice).
- `game-ui-ux`: Use when a game HUD or menu must work on phone, PC and console: responsive layout, focus navigation, screen flow, UI-state wiring (game HUD, game menu).
- `grill-me` (user-invoked only): A relentless interview to sharpen a plan or design.
- `grilling`: Grills the user to stress-test a plan. Use on any grill trigger phrase.
- `humanizer`: Removes AI-writing tells from text (no ai stop, klinkt als AI). Use when editing text to sound human.
- `input-systems`: Use when a game maps keys, touch and gamepad to actions: action maps, rebinding, device switching, input accessibility (game besturing, controller).
- `level-design`: Use when designing or blocking out a game level: player metrics, blockout, pacing, landmarks, guidance, playtests (level ontwerp, map bouwen).
- `performance-optimization`: Use when a game drops frames or stutters: profile first, pooling, batching, allocation control, asset budgets (game lag, fps, haperen).
- `ponytail`: Use for the smallest complete change (ponytail, minder code, kleinste diff).
- `poteto-mode` (user-invoked only): User-invoked only: /poteto-mode. Lauren Tan's (poteto) working style in Forge words: goal first, steer by named principles, prototype instead of asking, evidence labels, fresh agents.
- `prototype-fast`: Use when testing whether a game mechanic is fun before building it: a throwaway prototype and a keep or kill decision (prototype, snel testen of het leuk is).
- `receiving-code-review`: Use when receiving review feedback, before acting on it: verify first.
- `requesting-code-review`: Use before merging, to check requirements are met.
- `resolving-merge-conflicts`: Use when resolving an in-progress git merge or rebase conflict.
- `save-systems`: Use when a game must save progress: what to save, atomic writes, schema versions and migrations, autosave, slots (savegame, voortgang opslaan).
- `setup-pre-commit` (user-invoked only): Set up Husky pre-commit hooks with lint-staged, Prettier, typecheck and tests. User-invoked only.
- `ship-readiness`: Use before a deploy, go-live or client handoff (live zetten, klaar voor productie).
- `subagent-driven-development`: Use to run a plan's independent tasks via subagents.
- `systematic-debugging`: Use on any bug or test failure, before fixing.
- `teach` (user-invoked only): Teach the user a new skill or concept, within this workspace.
- `test-driven-development`: Use when building a feature or bugfix, before code.
- `using-git-worktrees`: Use before feature work that needs an isolated workspace.
- `verification-before-completion`: Use before claiming done or passing: evidence first.
- `wait-what` (user-invoked only): Stop. That last message did not land: re-pitch it.
- `writing-plans`: Use when a multi-step spec exists, before touching code.
- `writing-skills`: Use to pressure-test a discipline skill with subagents the TDD way (RED/GREEN/REFACTOR).
