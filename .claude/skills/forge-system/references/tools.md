<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# Forge tools (244 scripts)

Generated from: `.claude/forge-bin/`.

Every script in the folder, tests left out. Purpose = the first sentence of the file header. Run a tool with `node .claude/forge-bin/<file> --help` before you rely on it.

| file | purpose |
|---|---|
| `account-rotator-cli.cjs` | the command layer of account-rotator.cjs (argv, output, exit codes, the watcher's start/stop lifecycle, enrollment). |
| `account-rotator-core.cjs` | the PURE decision logic of the account rotator. |
| `account-rotator-flags.cjs` | the per-slot ORGANIZATION BLOCK of the account rotator (WP SA-ROTATOR-ORGBLOCK, incident 2026-11-04: `launch --account bussins` started Claude Code, which answered "Your organization has disabled Claude subscription acc… |
| `account-rotator-handoff.cjs` | the FULL handoff around an account switch (owner amendment 2026-10-09: "save everything, switch, then everything continues automatically" — same discipline as usage-guard). |
| `account-rotator-measure.cjs` | settings resolution and usage measurement for the account rotator. |
| `account-rotator-recommend.cjs` | the TOKEN-MODE tick of the account rotator (owner direction 2026-10-09: switching happens through setup tokens and a NEW session — `launch --auto`; the Claude login files are never written here). |
| `account-rotator-token.cjs` | TOKEN MODE of the account rotator (owner amendment 2026-10-09; rework round 1). |
| `account-rotator-txn.cjs` | the login-swap TRANSACTION (escalation round). |
| `account-rotator-vault.cjs` | the storage primitives of the account rotator. |
| `account-rotator.cjs` | keep Claude Code on an enrolled Claude Max account that still has room (escalation round). |
| `forge-actiongate-position.cjs` | the COMMAND-POSITION widening layer for forge-actiongate.cjs's command-kind gates, split out on 2026-09-24 (codex-recheck, wp-h1) to keep forge-actiongate.cjs under 500 lines. |
| `forge-actiongate.cjs` | hard-gates classifier (WAVE A / A1). |
| `forge-active-run.cjs` | the run pointer the harness hooks read (WP A2). |
| `forge-adopt-post-sync.cjs` | post-sync adoption + parity gate (spec .claude/forge-research/overhaul-2026-10-09/.md; owner addendum R11 2026-10-10). |
| `forge-agent-skills-sync.cjs` | keeps every agent file's `skills:` and its `Skill` tool in sync with FORGE_DEFAULT_SKILLS.json (SD-T3). |
| `forge-agent-tool-hook.cjs` | `PreToolUse` + `PostToolUse` hook, matcher "Agent" (WP A2). |
| `forge-agentlint.cjs` | (modernization 2026-10-24): a read-only linter for subagent files (.claude/agents/*.md). |
| `forge-anticipate-scope.cjs` | run scope for forge-anticipate's deliverable types (category tests A2). |
| `forge-anticipate.cjs` | the ANTICIPATION ENGINE (modernization WP I.2). |
| `forge-artifact.cjs` | thin, zero-dependency artifact-store helper for Forge Mission Control Phase 2 (WP5 "Vault"). |
| `forge-audit-loop.cjs` | the continuous AUDIT-LOOP tool. |
| `forge-autonomy.cjs` | continue-within-mission autonomy policy (WAVE B / B3). |
| `forge-beads.cjs` | lightweight graph backlog / memory (WAVE H / PIECE H4). |
| `forge-bench.cjs` | FORGEBENCH capability scoreboard (NEXT tier). |
| `forge-brain.cjs` | every project's Obsidian memory, fed into ONE central brain (owner ask R-0234). |
| `forge-briefing.cjs` | Nightshift MORNING BRIEFING generator (piece J5). |
| `forge-capabilities.cjs` | honest capabilities-vs-usage inventory (WAVE V9 / piece P2). |
| `forge-cc-launch.cjs` | (Forge: "forge dashboard works after a fresh install, with no manual steps"). |
| `forge-certify.cjs` | BLACK-BOX certification tool (WP4 hardening). |
| `forge-chaos.cjs` | FAILURE-INJECTION harness (WP5). |
| `forge-checkpoint.cjs` | idempotency + ATOMIC checkpoint layer (WP6). |
| `forge-citations.cjs` | citation ledger for Forge research runs (W2-CITATIONS). |
| `forge-claim-check.cjs` | an absolute "everything was verified" claim in a report must match the run ledger (owner standing rule P-000094: every mistake gets an automated guard). |
| `forge-claim-reports.cjs` | WHICH reports belong to a run, for forge-claim-check.cjs (review round 1 HIGH 1). |
| `forge-codemodel.cjs` | living CODEBASE MODEL (piece J4). |
| `forge-codexreview-config.cjs` | the ONE effective-config reader for the independent Codex review (fresh-laptop re-audit N4 / Part V-G, "the Codex pin"). |
| `forge-coldverify.cjs` | COLD verification, READ SIDE ONLY. |
| `forge-complexity-floor.cjs` | a request-based complexity floor for the run contract (SD-T6). |
| `forge-config-cli.cjs` | the command-line layer of forge-config.cjs: argv parsing, command dispatch, --json / --ascii output and exit codes. |
| `forge-config-once-store.cjs` | the AT-MOST-ONCE PENDING/CONSUMED grant store for a `--once` approval (V09 FIFTH fix, Codex recheck 2026-09-24, out-p11 + Security Boss addendum: "a delayed reclaimer captured a newer live holder... |
| `forge-config-once.cjs` | the one-off (`--once`) approval state machine and the cross-process file lock, split out of forge-config.cjs (CFG-07/S06/CFG-09/CFG-10) so that file stays a readable size. |
| `forge-config-scan.cjs` | (modernization 2026-10-24): a read-only scan of a project's Claude/Forge configuration for five classes of risk. |
| `forge-config-text.cjs` | the nl/en wording and the plain-text renderers for forge-config.cjs. |
| `forge-config.cjs` | the ONE resolver / validator / writer for every user-facing Forge setting. |
| `forge-configdrift.cjs` | hashes the files that determine a run's BEHAVIOUR at run start, re-hashes them at run end, and diffs the two. |
| `forge-consolidate.cjs` | honesty-safe lesson-store consolidator (WAVE E / PIECE E2). |
| `forge-contextbudget.cjs` | meters the ALWAYS-LOADED instruction surface and guards it against silent growth. |
| `forge-cost.cjs` | zero-dependency cost/token sampler for Forge Mission Control Phase 2 (WP5 "cost-logging"). |
| `forge-craft-evidence.cjs` | proof that a rendered UI was really looked at (modernization). |
| `forge-craft.cjs` | the CRAFT LENS (modernization Phase I, work package I.3). |
| `forge-deeplearn.cjs` | "Deep Learn Mode" for Forge Mission Control Phase 2 (WP2). |
| `forge-default-skills.cjs` | loader for FORGE_DEFAULT_SKILLS.json, the one source of default skills (SD-T1). |
| `forge-device-env.cjs` | read-only Android device probe (R8B-F5). |
| `forge-dispatch-fit.cjs` | does the agent I am about to dispatch have the tools the brief needs? |
| `forge-distill.cjs` | self-learning distill loop for Forge's per-Boss memory (forge-memory.cjs). |
| `forge-docdrift.cjs` | doc-drift detector (WP-GH-WIRE). |
| `forge-docs.cjs` | zero-dependency real office-document generator (H1). |
| `forge-doctor.cjs` | Forge self-test + leak scan (Mission Control Phase 2, WP7). |
| `forge-domain-deliverable.cjs` | WP I.10, a helper of forge-domain-discovery.cjs (zero dependencies, no I/O). |
| `forge-domain-discovery.cjs` | Phase I.4 "universal projects". |
| `forge-ecc-path.cjs` | forge-ecc-path.cjs: find a skill folder, wherever it is installed (W2-ECCPATH). |
| `forge-echo.cjs` | the "applied owner prefs/rules" ECHO (WAVE B / B4). |
| `forge-endreview.cjs` | the END-OF-WORK SELF-REVIEW, made mechanical (work package E.1). |
| `forge-env-names.cjs` | (independent Codex review of the integration). |
| `forge-eol-drift.cjs` | finds tracked files whose line-ending style changed against HEAD (LF <-> CRLF or mixed). |
| `forge-evals.cjs` | deterministic binary-assertion scorer for the bounded skill-refine loop (WP4). |
| `forge-evidence.cjs` | required-evidence gate (piece C2). |
| `forge-explain-error.cjs` | a plain-language error explainer for BEGINNERS. |
| `forge-export.cjs` | forge-export: generate OpenCode / Codex / Gemini files from .claude/agents + .claude/skills. |
| `forge-finalize.cjs` | HET ene gezaghebbende eindverdict van een run. |
| `forge-fixtures.cjs` | real-fixtures intake gate (WAVE D / D2). |
| `forge-flaky.cjs` | REPEAT-RUN nondeterminism detector. |
| `forge-fresh-repo-text.cjs` | the pure text transforms behind forge-fresh-repo.cjs. |
| `forge-fresh-repo.cjs` | builds a brand-new public repository tree for Forge-Core: no version numbers, one commit, plain documentation, none of the development-process artefacts. |
| `forge-gate-cannot-judge.cjs` | the CANNOT-JUDGE keyword scan of the PreToolUse gate hook (forge-gate-hook.cjs). |
| `forge-gate-classify-worker.cjs` | the worker_threads ENTRY POINT forge-gate-watchdog.cjs spawns (wp-v1/wp-v3). |
| `forge-gate-data.cjs` | the INERT-DATA rule of the PreToolUse gate hook (forge-gate-hook.cjs), split out on 2026-09-24 (WP16 follow-up 2 + review-boss wp9a L1/L3) to keep both files under 500 lines. |
| `forge-gate-evidence.cjs` | RUW BEWIJS PER POORT (Codex rapport-review R-01/R-05). |
| `forge-gate-hook.cjs` | PreToolUse hook (matcher `Bash\|PowerShell`): the SEVEN command hard gates become a real stop (WP16,; opaque-exec added in the codex-recheck-2026-09-24 remediation, wp-f1; secret-… |
| `forge-gate-inspect.cjs` | the SINGLE inspection pipeline forge-gate-hook.cjs's evaluate() used to run entirely on the main thread (wp-v3, sec-v1r-H1/L2 remediation). |
| `forge-gate-messages.cjs` | the plain-language NL/EN wording for forge-gate-hook.cjs's block/notice text (wp-v3, split out so BOTH the main thread (forge-gate-hook.cjs) and the worker_threads Worker (forge-gate-classify-worker.cjs, via forge-gate-… |
| `forge-gate-quotes.cjs` | the ONE shared quote/heredoc-aware scanning pass for the PreToolUse gate hook and its classifier (root-cause rewrite, 2026-09-24, codex-recheck / wp-j1, after three straight waves each patched a SYMPTOM and regre… |
| `forge-gate-scratch.cjs` | the SCRATCH PASS-THROUGH lexer for the PreToolUse gate hook (forge-gate-hook.cjs), split out on 2026-09-24 (codex-recheck-2026-09-24, wp-f1) to keep both the hook and forge-gate-data.cjs under 500 lines. |
| `forge-gate-selfdisable.cjs` | the `gate-hook-self-disable` detection subsystem (security wp9b M3, codex-recheck S05/V02), split out of forge-gate-hook.cjs (wp-v3, sec-v1r-H1 remediation) so BOTH the main thread (forge-gate-hook.cjs, for the watchdog… |
| `forge-gate-watchdog.cjs` | a HARD wall-clock guarantee that forge-gate-hook.cjs's classify() step always returns a verdict well inside Claude Code's own external hook timeout (wp-v1,,, security probe `_scr… |
| `forge-gate-writescope.cjs` | the optional per-task WRITE-SCOPE freeze of forge-gate-hook.cjs (package 3.3c). |
| `forge-genesis.cjs` | Forge GENESIS: staged, approval-gated self-authoring (PIECE J1). |
| `forge-global-drift.cjs` | keeps the version-controlled copy of the GLOBAL Forge pieces (global-install/ in the dev repo) honest against the live ~/.claude. |
| `forge-global-handover.cjs` | checks that the global /forge command hands control to a project's own .claude/commands/forge.md (category tests F8). |
| `forge-global-input.cjs` | finds GLOBAL keyboard/mouse input in code a tool call just wrote (category tests round 6). |
| `forge-graphify.cjs` | Forge adapter for the graphify CLI (graphifyy, a uv tool) — WP SA-P1-ADAPT, PHASE2-PLAN A9 + E. |
| `forge-harness-match.cjs` | joins a run's dispatch events to what the HARNESS recorded (WP A2, plan §5 A2, spike A2a in _scratch/spike-harness/A2a-findings.md). |
| `forge-harness-score.cjs` | (modernization 2026-10-24): a 0-10 scorecard of a project's own Forge gates, driven by a versioned rubric (.claude/config/quality/harness-rubric.json). |
| `forge-harvest.cjs` | READ-ONLY cross-project learning harvester (post-WAVE-E). |
| `forge-heartbeat.cjs` | stall/silence watchdog for a Forge run. |
| `forge-init.cjs` | modernization WP 3.1: `/forge init`, step 2 of the two-step install (step 1: add the Forge plugin, or run the central installer). |
| `forge-intake.cjs` | Prompt Master intake question engine (WP-INTAKE). |
| `forge-integrate.cjs` | HERMETIC INTEGRATION GATE. |
| `forge-intel-evals.cjs` | the INTELLIGENCE EVALS (modernization Phase I, work package I.5). |
| `forge-killswitch.cjs` | ONE handle that stops all autonomous execution in this project. |
| `forge-lane-budget.cjs` | how many parallel lanes Forge may use RIGHT NOW (owner wish P-000096). |
| `forge-lane-skills.cjs` | lane skill check (owner rules R-0070 and R-0093, generic Forge version of the lane check an owner Roblox project used). |
| `forge-lane-watchdog.cjs` | read-only watchdog for parallel background Agent-tool lanes: it notices a lane that is stuck, idle, looping or failing, and machine trouble (low disk, a flooded temp folder) that would break every lane. |
| `forge-lead-write-guard.cjs` | R8B-F2: the Lead of a /forge build writes app files itself. |
| `forge-lock-guard.cjs` | mechanical HOTSPOT WRITE-LOCK. |
| `forge-loophealth.cjs` | a read-only, advisory LOOP-HEALTH check over the tool-call ledger that forge-toolhook.cjs already writes. |
| `forge-manifest.cjs` | mission-level swarm ARM/RECONCILE manifest (WAVE D / D1). |
| `forge-mcp-gate.cjs` | MCP least-privilege REGISTRY + VALIDATOR + PLANNER (WAVE G1). |
| `forge-mcp-pin.cjs` | supply-chain PIN-CHECK for MCP server launch references. |
| `forge-mcp-usage.cjs` | did the MCP least-privilege gate actually fire for the MCP tools that were used? |
| `forge-mcp.cjs` | READ-ONLY Model Context Protocol server exposing THIS project's Forge run state (agent-ecosystem NEXT tier). |
| `forge-memory-consolidate.cjs` | zero-loss memory consolidation (modernization plan item 1.4). |
| `forge-memory.cjs` | upgraded per-Boss memory (NEXT tier): TYPED lessons (episodic/semantic/ procedural), tag+keyword+recency top-K RECALL (so a run injects the few relevant lessons instead of a whole-file read), and MECHANICALL… |
| `forge-mindmap.cjs` | zero-dependency mind-map generator/writer for Forge Mission Control Phase 2 (WP4 "Mind Map"). |
| `forge-mutate.cjs` | zero-dependency MUTATION TESTING tool for Forge (WP3 Spoor A). |
| `forge-mutcheck.cjs` | Test Boss mutation-CHECK helper (WAVE E / E3). |
| `forge-orchestrate.cjs` | run-driver checklist auditor (WAVE C / C5). |
| `forge-otel.cjs` | export a Forge run as OpenTelemetry GenAI spans in OTLP/HTTP-JSON (NEXT tier). |
| `forge-owner-queue-check.cjs` | a report may hand the owner hard gates only, never a choice. |
| `forge-owner-text-check.cjs` | owner-facing text is checked for the owner's language and for AI tells (SD-T8, default skills Task 8; design: .claude/docs/default-skills.md). |
| `forge-ownergrant.cjs` | ONE verification for "did the owner really authorise this?". |
| `forge-pack.cjs` | the generic agent-pack check (owner request R-0239: agents for every project type, not only Roblox). |
| `forge-paperclip.cjs` | Forge ↔ Paperclip bridge (zero-dependency, project-local). |
| `forge-paths.cjs` | the one resolver for every Forge runtime-state location (WP 1.2, extended in WP). |
| `forge-plan-card.cjs` | the PLAN CARD of Forge's think-with-the-user intake (modernization WP 3.2). |
| `forge-plugin-build.cjs` | modernization WP 2.2: assemble the Claude Code plugin from this development tree. |
| `forge-policy.cjs` | testable orchestration/security policy helpers (NEXT tier, GOAT model routing added 2026-10-06): • routeFor() — GOAT triage FALLBACK: task text + risk -> quick \| build \| deep, used when the Head |
| `forge-prd.cjs` | zero-dependency PRD writer for Forge Mission Control Phase 2 (WP3 "PRD generator"). |
| `forge-prefs.cjs` | owner-profile resolver (WAVE B / PIECE B1). |
| `forge-projectbrain.cjs` | top-tier project-CLAUDE.md generator (Piece P4, 2026-07-22; RESEARCH-ENRICHED 2026-07-22 — applying the V9 deep-research pass on Anthropic/community CLAUDE.md best practices, see scratchpad v9-deep-knowledge.json `claud… |
| `forge-prompt-moments.cjs` | main-session moments (SD-T7, default skills Task 7; design: .claude/docs/default-skills.md). |
| `forge-promptcheck-ask.cjs` | the `ask` mode of forge-promptcheck.cjs: a prompt-doctor on the RAW owner request, before Forge plans anything (split out of forge-promptcheck.cjs and completed in wp18). |
| `forge-promptcheck.cjs` | Prompt Master dispatch-prompt linter (WP-PROMPTCHECK). |
| `forge-proof-gate.cjs` | ONE shared "is this claim actually proven" predicate (second Codex recheck 2026-09-24, out-p7.md). |
| `forge-quality.cjs` | de Forge Quality Intelligence Layer (masterprompt 2026-08-11). |
| `forge-ramguard.cjs` | machine-load probe for the Forge lane scheduler (WP-RAMGUARD). |
| `forge-rebindguard-runner.cjs` | the SEPARATE, real-Node-process half of forge-doctor.cjs::rebindingGuardBehavioral() (DOCTOR-1 fix, Lead review round 2, 2026-09-28: the behavioural layer had to be wired into runDoctor()'s real report, not just exporte… |
| `forge-recall.cjs` | utility-ranked lesson recall with a reserved GLOBAL/Lead namespace (WAVE E / PIECE E2). |
| `forge-recovery.cjs` | Forge-native enforcement engine for the GLOBAL RESEARCH RECOVERY & SOLUTION-FIRST POLICY. |
| `forge-reflect.cjs` | owner-correction -> evidence-linked lesson writer (MANUAL-ONLY). |
| `forge-registry-gen.cjs` |: read-only drift report + GENERATED proposals for the skill registry and the forge-bin tool table. |
| `forge-registry.cjs` | GLOBAL, opt-in, READ-ONLY Forge project registry (Mission Control Phase 2, WP6). |
| `forge-reinforce.cjs` | outcome-gated lesson utility scorer (WAVE E / PIECE E2). |
| `forge-release-check.cjs` | (M1, prd-w2-discipline). |
| `forge-release-sync.cjs` | the versioned, manifest-driven release copy. |
| `forge-repair.cjs` / PRD prd-w1-plan-goal-clarity module M6: a one-command repair ladder for beginners who never want to type a command. |
| `forge-repomap.cjs` | cheap, token-light repository context map (piece H2). |
| `forge-report.cjs` | parses, validates, and ingests the structured subagent completion-report contract. |
| `forge-resume-brief.cjs` | `SessionStart` hook for startup \| resume \| clear (.7, owner request R-0069). |
| `forge-retention.cjs` | begrensde retentie voor logs, toollogs en backups. |
| `forge-review-score.cjs` | review lenses made mechanical (work package). |
| `forge-roblox-pack.cjs` | the Roblox pack check (owner 2026-11-11: "the new Forge template must also contain the Roblox agents"). |
| `forge-rollback.cjs` | ROLLBACK PER RUN (WP 3.3). |
| `forge-rotator-hook.cjs` | `StopFailure` hook for the account rotator, PATH A (work packages R.2+R.3). |
| `forge-rotator-supervisor.cjs` | PATH A of the account rotator (work packages R.2+R.3): run ONE headless Claude Code job to completion across usage limits, on ONE account. |
| `forge-routing-stats.cjs` | telemetry-free ROUTING STATISTICS from the owner's own runs (`/forge stats`, work package 3.5). |
| `forge-rule-promotion.cjs` | decides from EVIDENCE (not memory) whether a `warn` rule in FORGE_HARD_RULES.json may be promoted to `block` (BLUEPRINT.md " ", migration step M6; prepared as). |
| `forge-ruleoftwo.cjs` | Rule-of-Two auto-classifier (PIECE C4). |
| `forge-run-budget.cjs` | the per-run COST CAP for UNATTENDED runs. |
| `forge-run-file.cjs` | writes a run's own files (final-report.md, run.json, plan.md, prd.md, artifacts/…) into `.claude/forge-runs/<run_id>/` from a draft written OUTSIDE `.claude/`. |
| `forge-run-state.cjs` | DURABLE RESUME projector (NEXT tier). |
| `forge-runcontract.cjs` | run-contract checker (P1 / V9-build). |
| `forge-runinfo.cjs` | project-local run info CLI: status \| runs \| open-report. |
| `forge-runwatch.cjs` | COMPLETION / STALL predicate for a Forge run. |
| `forge-say.cjs` | WP A1: the run's Team chat channel. |
| `forge-scout.cjs` | external-capability research term-generator + persistent vetting ledger (PIECE P5). |
| `forge-scribe-classify.cjs` | the deterministic NL+EN keyword classifier for Forge Scribe. |
| `forge-scribe-hook.cjs` | the project UserPromptSubmit hook that feeds Forge Scribe (part ii, 2026-10-10; design: audit SCRIBE-F1/F5/F10 in .claude/forge-research/overhaul-2026-10-09/audit-scribe… |
| `forge-scribe-stop.cjs` | the scribe's project Stop hook (part ii, Codex R3 SC-07/SC-12 the same day). |
| `forge-scribe-store.cjs` | storage layer for Forge Scribe. |
| `forge-scribe.cjs` | Forge Scribe core (design: audit SCRIBE-F2/F5/F6/F7/F10/F11 in .claude/forge-research/overhaul-2026-10-09/audit-scribe.txt; hardened for Codex R3 SC-01..SC-12, 2026-10-… |
| `forge-secondbrain.cjs` | Forge SECOND BRAIN: a READ-ONLY, EVIDENCE-CITED portfolio strategist across the owner's Forge projects (PIECE J3). |
| `forge-secret-scrub.cjs` | ADVISORY secret/PII scanner for RUNTIME artifacts. |
| `forge-session-end.cjs` | `SessionEnd` hook, registered async (modernization plan item 1.6). |
| `forge-settings-merge-guards.cjs` | wp-f2 (out-p2.md/out-p6.md). |
| `forge-settings-merge.cjs` | WP22 ("alles standaard aan" / "Forge does it for you, never tell the user to run or merge something by hand"). |
| `forge-setup-inventory.cjs` | read-only, redacted inventory of the project and global Claude Code setup. |
| `forge-setup.cjs` | the onboarding ENGINE behind the /setup-forge wizard. |
| `forge-shipcheck-refs.cjs` | reference extraction for forge-shipcheck.cjs's REFERENCE-CLOSURE check. |
| `forge-shipcheck.cjs` | the ONE shipping truth, checked. |
| `forge-skill-analyze-cluster.cjs` | deterministic sub-topic clusters inside one category. |
| `forge-skill-analyze-dedupe.cjs` | near-duplicate groups over the skill corpus. |
| `forge-skill-analyze-features.cjs` | per-skill features of the skill-corpus analyser: risk flags (from the harvester's `ships` record + install commands in the text), a quality score with its parts, and a MinHash text fingerprint (64 x 32-bit … |
| `forge-skill-analyze-ours.cjs` | our own skill library, mapped onto the analyser's categories. |
| `forge-skill-analyze-report.cjs` | builds the summary files of the skill-corpus analyser from the analysed records: dup-groups.json, categories.json, clusters/<category>.json and ours.json. |
| `forge-skill-analyze-taxonomy.cjs` | the documented category taxonomy of the skill-corpus analyser. |
| `forge-skill-analyze.cjs` | analyse EVERY record of the harvested skill corpus. |
| `forge-skill-audit.cjs` | static threat scan of a CANDIDATE skill folder before the Scout adopt step (W2-H1B-SCOUT, 2026-11-06; skills-audit plan item 11: "the security-auditor taxonomy as Node rules"; hardened W2-SKILLAUDIT-FIX, 2026-11-07, aft… |
| `forge-skill-compliance.cjs` | (modernization 2026-10-24): for each skill a run says it loaded, does the run's own trace show the steps that skill asks for? |
| `forge-skill-delivery.cjs` | what the run contract's skill-delivered rule counts as delivered (SD-T5). |
| `forge-skill-evals.cjs` | per-skill self-improvement substrate, FOUNDATION piece (backlog item 1, YT-SWEEP-2026-07-31, 8 source videos — see .claude/forge-research/YT-SWEEP-2026-07-31.md). |
| `forge-skill-harvest-bucket.cjs` | one shared token bucket per GitHub rate-limit resource (SA-HARVEST-FAST). |
| `forge-skill-harvest-enum.cjs` | `enumerate`: collect candidate SKILL.md locations from four sources. |
| `forge-skill-harvest-fetch.cjs` | `fetch`: download each candidate SKILL.md as DATA plus what its folder ships. |
| `forge-skill-harvest-index.cjs` | `index` + `status`: build corpus.jsonl (one record per unique SKILL.md content) and coverage.json (found / fetched / failed with reason / duplicates removed, per source). |
| `forge-skill-harvest-net.cjs` | the only network layer of the skill harvester. |
| `forge-skill-harvest-parse.cjs` | pure parsers for the skill harvester. |
| `forge-skill-harvest-store.cjs` | on-disk state of the skill harvester. |
| `forge-skill-harvest-trees.cjs` | list the SKILL.md files of many repos fast and within the limits (SA-HARVEST-FAST). |
| `forge-skill-harvest.cjs` | harvest EVERY public SKILL.md, not a sample (owner HARD rule "research means ALL of it"). |
| `forge-skill-use.cjs` | SD-T11: how often each skill was really used, measured from the hook lines. |
| `forge-skilllint.cjs` | (modernization 2026-10-24): a read-only linter for SKILL.md files. |
| `forge-skillmap.cjs` | read the Lead's skill map and measure which skills a subagent really opened (category finding SK1). |
| `forge-snapshot-marker.cjs` | PreCompact hook target (matchers `manual` AND `auto`, owner request 2026-07-29: a real snapshot must exist by the time context actually compacts, not just when someone remembers to ask). |
| `forge-snapshot-reinject.cjs` | SessionStart hook target, matcher `compact` (owner request 2026-07-29: after a compaction, the very next turn must not have lost the mission). |
| `forge-snapshot-settings.cjs` | safe, idempotent `.claude/settings.json` MERGE helper for wiring the PreCompact (matchers manual+auto) + SessionStart(matcher:compact) snapshot hooks, without ever clobbering pre-existing hooks/keys. |
| `forge-snapshot.cjs` | context-continuity snapshot generator (owner request 2026-07-29: "bij elke 50% context een snapshot.md zodat er geen memory wordt vergeten"). |
| `forge-standing.cjs` | enforceable OWNER standing-rules resolver (WAVE B / B2, TEMPLATE/USER SPLIT added 2026-09-26, external audit N4/P1). |
| `forge-start.cjs` | the /forge bootstrap in ONE call (R8B-F1). |
| `forge-stats.cjs` | zero-dependency, READ-ONLY run-outcome statistics projector (WP2). |
| `forge-stop-obligations.cjs` | (audit enforcement-core T3/T8/T10 + P1 "call sites"). |
| `forge-store.cjs` | hardened, append-only flat-file store writer for Forge Mission Control Phase 2 (WP1 "Foundations"). |
| `forge-subagent-start.cjs` | `SubagentStart` hook (WP A2). |
| `forge-subagent-stop.cjs` | `SubagentStop` hook (modernization plan item 1.6). |
| `forge-suite-pool.cjs` | bounded parallel runner for the doctor's test suites (WP-SPD-C). |
| `forge-swarm-resume.cjs` | mission-level swarm AUTO-RESUME (WAVE D / D1). |
| `forge-sweep-aggregate.cjs` | the `aggregate` stage of forge-sweep.cjs. |
| `forge-sweep-core.cjs` | shared plumbing for forge-sweep.cjs. |
| `forge-sweep-extract.cjs` | the `extract` stage of forge-sweep.cjs. |
| `forge-sweep.cjs` | resumable, checkpointed YouTube research sweep. |
| `forge-sync-publish-guard.cjs` | two blockers for `forge-sync publish-template --apply` (category tests round 8). |
| `forge-sync.cjs` | Forge installer / sync — SAFE SYNC (2026-07-14 hardening WP1 + 2026-07-14 FIX ROUND). Zero-dependency |
| `forge-system-skill.cjs` | generates the single-entry `forge-system` skill (owner question R-0235): the whole Forge system as one SKILL.md plus references/*.md, built FROM THE REAL DATA, never from hand-typed lists. |
| `forge-testrun.cjs` | run a test command, print only a compact summary (usage reduction U-12). |
| `forge-text-normalize.cjs` | a tiny shared Dutch/English text normaliser (work package I.8a). |
| `forge-tool-failure.cjs` | `PostToolUseFailure` hook (modernization plan item 1.6). |
| `forge-tool-index.cjs` | CROSS-RUN event search index (mining-ronde-1 §1). |
| `forge-toolhook.cjs` | the tool-behaviour LEDGER: one compact line per real tool call, written by a `PostToolUse` hook, i.e. |
| `forge-tournament.cjs` | Forge best-of-N TOURNAMENT: plan N independent solution variants, score them against a transparent weighted rubric, promote the winner (PIECE J2). |
| `forge-trace.cjs` | requirements traceability projector (WAVE E / E3). |
| `forge-usage-report.cjs` | forge-usage-report: READ-ONLY usage baseline from Claude Code transcripts. |
| `forge-usage-source.cjs` | WHICH usage reading the lane budget may trust (SA-P1-USAGE, PHASE2-PLAN A1). |
| `forge-vault-map.cjs` | the Forge "mind map" layer of the Obsidian vault. |
| `forge-vault.cjs` | Forge Knowledge Vault. |
| `forge-verify.cjs` | the "verify-loop": after an agent (or the whole run) claims to be DONE, check whether that claim actually holds against the real events.jsonl and the ticket store. |
| `forge-wait.cjs` | wait in the FOREGROUND until a session's subagents have stopped (category finding H1). |
| `forge-watch-launch.cjs` | Forge adapter that runs a script of the global "watch" skill with a WORKING Python 3 (WP SA-P1-ADAPT, PHASE2-PLAN A10 + section E). |
| `forge-wpsize.cjs` | Head Chef's work-package size classifier. |
| `nvidia-provider.cjs` | NVIDIA Build / NIM provider adapter for Forge (zero-dependency; mission 2026-07-05). |
| `usage-guard-override.cjs` | DEFENSE IN DEPTH for the credits override (FOURTH Codex recheck). |
| `usage-guard-redact.cjs` | the credential/redaction boundary split out of usage-guard.cjs (Codex recheck wp-f4: GUARD-TOKEN-ERROR / GUARD-TOKEN-FINGERPRINT). |
| `usage-guard-state.cjs` | the exclusive state-lock primitive split out of usage-guard.cjs (Codex recheck wp-f4 V15: GUARD-STATE-RACE fail-closed fix, HARDENED across four Codex rechecks). |
| `usage-guard-status.cjs` | what `usage-guard status` may write back into FORGE_USAGE_GUARD_STATE.json (SA-P1-USAGE, PHASE2-PLAN A1). |
| `usage-guard.cjs` | Forge Usage Guard — REAL subscription usage watchdog (zero-dependency). |
