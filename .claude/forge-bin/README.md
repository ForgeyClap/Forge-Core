# Forge command pack (project-local)

Cross-platform terminal wrappers for **this project's** Forge. They only ever run scripts that live inside this project — **no global install, no PATH changes, no admin rights, nothing outside this folder.** They require Node.js (the wrappers auto-detect it; see below).

## Windows quick start (recommended)
```
.claude\forge-bin\forge-dashboard.cmd
```
On Windows, prefer the **`.cmd`** wrappers — PowerShell often blocks `.ps1` by execution policy.

| Action | CMD (recommended) | PowerShell | Bash/Git Bash |
|---|---|---|---|
| Start dashboard | `.claude\forge-bin\forge-dashboard.cmd` | `.\.claude\forge-bin\forge-dashboard.ps1` | `bash .claude/forge-bin/forge-dashboard.sh` |
| Status | `.claude\forge-bin\forge-status.cmd` | `.\.claude\forge-bin\forge-status.ps1` | `bash .claude/forge-bin/forge-status.sh` |
| Recent runs | `.claude\forge-bin\forge-runs.cmd` | `.\.claude\forge-bin\forge-runs.ps1` | `bash .claude/forge-bin/forge-runs.sh` |
| Latest report | `.claude\forge-bin\forge-open-report.cmd` | `.\.claude\forge-bin\forge-open-report.ps1` | `bash .claude/forge-bin/forge-open-report.sh` |
| Log an event | `.claude\forge-bin\forge-log-event.cmd <run_id> <type> payload.json` — the `.cmd` form accepts ONLY a `.json` file path (cmd never parses it); inline JSON is refused (exit 2) — use `.ps1`/`.sh` for inline JSON | `.\.claude\forge-bin\forge-log-event.ps1 <run_id> <type> '<json>'` | `bash .claude/forge-bin/forge-log-event.sh <run_id> <type> '<json>'` |
| Dispatcher | `.claude\forge-bin\forge.cmd <cmd>` | `.\.claude\forge-bin\forge.ps1 <cmd>` | `bash .claude/forge-bin/forge.sh <cmd>` |

Dispatcher commands: `dashboard` / `start` · `status` · `runs` · `open-report` · `health` · `log-event <run_id> <type> <payload>` · `resume <run_id>` · `learn` · `config <list|get|set|unset|reset|explain|diff|parse>` · `sweep <enumerate|filter|transcripts|extract|aggregate|status>` · `promptcheck <promptFile|-|ask>` · `legacy-dashboard` (prints a " " message — see below).

Forge defines **no npm scripts**: the wrappers above are the whole terminal interface.

## Which dashboard starts
`dashboard` / `start` delegate to `forge-cc-launch.cjs`, which: (1) resolves the port (`CC_PORT` when it is a positive number, else `4100`) and health-checks `GET /api/health` there FIRST, with three outcomes: a real Command Center answers (its health response has the Command Center's shape) → it reports that URL and starts nothing else; something else answers that is not the Command Center (a port conflict, LAUNCH-1) → it leaves that program alone, says plainly that the Command Center only works on its own fixed port so Forge continues without the dashboard, and exits 1 without starting anything; nothing answers → it continues with the steps below; (2) otherwise looks for a Command Center **project-local** (`command-center/gateway/bin.mjs` in this project — a developer checkout) or, failing that, **central** (`~/.claude/forge/template/command-center/gateway/bin.mjs`, the installer's shared copy); (3) if the chosen copy's `dashboard/dist/index.html` is missing but it has `dashboard/package.json`, builds it itself (`npm ci` when `package-lock.json` exists, else `npm install`, then `npm run build` — real npm output, never a command printed for the user to type); (4) starts `gateway/supervisor.mjs` when present (auto-restart on crash) else `gateway/bin.mjs` directly, in the foreground, with `FORGE_CC_DEFAULT_PROJECT` set to this project's own root. If no Command Center is installed anywhere, it says so in one line and names the installer (`install.ps1` / `install.sh`) — it never invents a dashboard. The old per-project **Control Center** (`.claude/forge-dashboard/server.cjs`, ports 3737–3999) was ** ** — not merely retired, the file and its static UI no longer exist; `legacy-dashboard` now just prints that fact and points at `dashboard`. Its `log-event.cjs` stays in service, unchanged, as the per-project run-event writer. `status` / `runs` / `open-report` / `health` now run `forge-bin/forge-runinfo.cjs` (never the removed server.cjs) — `status`/`health` additionally do a real, short-timeout `GET http://127.0.0.1:4100/api/health` on the Command Center.

## Node detection (built into every wrapper)
The dispatcher (`forge.cmd` / `forge.ps1` / `forge.sh`, which the other wrappers delegate to) finds Node in this order:
1. `node` on PATH.
2. else `C:\Program Files\nodejs\node.exe` (auto-used if present).
3. else it prints: **"Node.js LTS is required for Forge. Install Node.js LTS, close and reopen your terminal, then run node -v."** and exits 1 (never silent).

### "node is not recognized" right after installing Node (e.g. via winget)
A terminal opened *before* installing Node won't see it yet. Fix:
1. **Close the terminal completely.** 2. Open a new terminal. 3. Run `node -v`.
4. If it still fails, Forge automatically tries `C:\Program Files\nodejs\node.exe`.
If Node isn't installed at all: install **Node.js LTS**, then reopen the terminal.

## PowerShell execution policy
If a `.ps1` is blocked ("running scripts is disabled on this system"), use the **`.cmd`** wrapper instead, or:
```
powershell -ExecutionPolicy Bypass -File .claude\forge-bin\forge-dashboard.ps1
```
Do **not** change the execution policy globally; do **not** run as admin. The wrappers never modify PATH or execution policy.

## Direct Node fallbacks (no wrappers)
```
node .claude/forge-bin/forge-cc-launch.cjs        # same as `forge dashboard` — finds/builds/starts the Command Center
node command-center/gateway/supervisor.mjs        # Command Center with auto-restart (when this project hosts it)
node .claude/forge-dashboard/log-event.cjs <run_id> <type> --file payload.json
```

## Tools in this folder (run directly with `node`, some also reachable via `forge <cmd>` above)
One row per non-test `.cjs` in this folder that ships to projects (148 tools; the development tree also holds two maintainer-only release tools that never leave it, so a synced project never sees them named here). Purposes of new rows are the first sentence of each file's own header comment; check the file for the full contract. **Test** says whether a same-named `<tool>.test.cjs` exists: 28 tools have **no test yet** (some may be exercised by a parent tool's test; that is not verified here). Drift check: `node .claude/forge-bin/forge-registry-gen.cjs report`.

| Tool | Test | Purpose |
|---|---|---|
| `account-rotator.cjs` (+ `account-rotator-cli.cjs`, `account-rotator-core.cjs`, `account-rotator-handoff.cjs`, `account-rotator-measure.cjs`, `account-rotator-recommend.cjs`, `account-rotator-token.cjs`, `account-rotator-txn.cjs`, `account-rotator-vault.cjs`) | account-rotator-cli: no test yet; account-rotator-core: no test yet; account-rotator-handoff: yes; account-rotator-measure: no test yet; account-rotator-recommend: no test yet; account-rotator-token: no test yet; account-rotator-txn: yes; account-rotator-vault: no test yet; account-rotator: yes | Keep Claude Code on an enrolled Claude Max account that still has room (escalation round). The helpers are its own modules, not run directly. Full description: the "Account rotator" section below. |
| `forge-a2a.cjs` | yes | A2A (Agent2Agent, Linux Foundation) CLIENT-first edge (LATER tier). |
| `forge-actiongate-position.cjs` | no test yet | The COMMAND-POSITION widening layer for forge-actiongate.cjs's command-kind gates, split out on 2026-09-24 (codex-recheck, wp-h1) to keep forge-actiongate.cjs under 500 lines. |
| `forge-actiongate.cjs` | yes | Hard-gates classifier (WAVE A / A1). |
| `forge-adopt-post-sync.cjs` | yes | Post-sync adoption + parity gate for any Forge project (`--project`): `baseline` before the sync, then compares doctor, hooks, agents and files after it (exit 0 PASS, 1 FAIL, 2 usage). |
| `forge-agui.cjs` | yes | AG-UI (Agent-User Interaction Protocol, CopilotKit) emit-bridge (LATER tier, OPTIONAL). |
| `forge-artifact.cjs` | yes | Thin, zero-dependency artifact-store helper for Forge Mission Control Phase 2 (WP5 "Vault"). |
| `forge-audit-loop.cjs` | yes | The continuous AUDIT-LOOP tool. |
| `forge-autonomy.cjs` | yes | Continue-within-mission autonomy policy (WAVE B / B3). |
| `forge-beads.cjs` | yes | Lightweight graph backlog / memory (WAVE H / PIECE H4). |
| `forge-bench.cjs` | yes | FORGEBENCH capability scoreboard (NEXT tier). |
| `forge-briefing.cjs` | yes | Nightshift MORNING BRIEFING generator (piece J5). |
| `forge-capabilities.cjs` | yes | Honest capabilities-vs-usage inventory (WAVE V9 / piece P2). |
| `forge-cc-launch.cjs` | yes | All the decision logic behind `forge dashboard`/`forge start` (also reachable via `forge dashboard`/`start` above): resolve `CC_PORT`, health-check "already running", find the Command Center project-local or central, build it on demand (`npm ci`/`install` + `npm run build`), then start `supervisor.mjs`/`bin.mjs` with `FORGE_CC_DEFAULT_PROJECT` set. Exit 0 = reachable/started; 1 = not installed anywhere, or the on-demand build failed. |
| `forge-certify.cjs` | yes | BLACK-BOX certification tool (WP4 hardening). |
| `forge-chaos.cjs` | yes | FAILURE-INJECTION harness (WP5). |
| `forge-checkpoint.cjs` | yes | Idempotency + ATOMIC checkpoint layer (WP6). |
| `forge-codemodel.cjs` | yes | Living CODEBASE MODEL (piece J4). |
| `forge-codexreview-config.cjs` | yes | The ONE effective-config reader for the independent Codex review (fresh-laptop re-audit N4 / Part V-G, "the Codex pin"). |
| `forge-coldverify.cjs` | yes | COLD verification, READ SIDE ONLY. |
| `forge-config-cli.cjs` / `forge-config-text.cjs` | forge-config-cli: no test yet; forge-config-text: no test yet | Helpers of `forge-config.cjs`, not run directly: `-cli.cjs` is the argv-parsing/dispatch/`--json`/exit-code layer, `-text.cjs` holds the nl/en wording and plain-text renderers (list/explain/diff output, `--ascii` fold for old Windows code pages). |
| `forge-config-once-store.cjs` | no test yet | The AT-MOST-ONCE PENDING/CONSUMED grant store for a `--once` approval (V09 FIFTH fix, Codex recheck 2026-09-24, out-p11 + Security Boss addendum: "a delayed reclaimer captured a newer live holder... two actual consumeOnce() calls return … |
| `forge-config-once.cjs` | yes | The one-off (`--once`) approval state machine and the cross-process file lock, split out of forge-config.cjs (CFG-07/S06/CFG-09/CFG-10) so that file stays a readable size. |
| `forge-config.cjs` | yes | The ONE resolver/validator/writer for every Forge setting: `list`, `get`, `set`, `unset`, `reset`, `explain`, `diff`, `parse` (also reachable via `forge config <cmd>` above, `--help` on each). Files: `.claude/FORGE_CONFIG.json` (project) + `~/.claude/FORGE_CONFIG.json` (global); catalogue: `config/orchestration/FORGE_CONFIG_SCHEMA.json`. Exit 0 ok · 1 not found · 2 usage/validation (nothing written) · 3 act on this (a real change, a locked key, an ambiguous `parse`). |
| `forge-configdrift.cjs` | yes | Hashes the files that determine a run's BEHAVIOUR at run start, re-hashes them at run end, and diffs the two. |
| `forge-consolidate.cjs` | yes | Honesty-safe lesson-store consolidator (WAVE E / PIECE E2). |
| `forge-contextbudget.cjs` | yes | Meters the ALWAYS-LOADED instruction surface and guards it against silent growth. |
| `forge-cost.cjs` | yes | Zero-dependency cost/token sampler for Forge Mission Control Phase 2 (WP5 "cost-logging"). |
| `forge-deeplearn.cjs` | yes | "Deep Learn Mode" for Forge Mission Control Phase 2 (WP2). |
| `forge-distill.cjs` | yes | Self-learning distill loop for Forge's per-Boss memory (forge-memory.cjs). |
| `forge-docdrift.cjs` | yes | Doc-drift detector (WP-GH-WIRE). |
| `forge-docs.cjs` | yes | Zero-dependency real office-document generator (H1). |
| `forge-doctor.cjs` | yes | Forge self-test + leak scan (Mission Control Phase 2, WP7). |
| `forge-echo.cjs` | yes | The "applied owner prefs/rules" ECHO (WAVE B / B4). |
| `forge-env-names.cjs` | yes | Secret-print's grep-family `-o`/`--only-matching` exemption used to let `grep -o 'DATABASE_URL=.*' .env` through as "the safe variant" while it still printed the matched VALUE, not just the name — the exemption was unsound and has been … |
| `forge-evals.cjs` | yes | Deterministic binary-assertion scorer for the bounded skill-refine loop (WP4). |
| `forge-evidence.cjs` | yes | Required-evidence gate (piece C2). |
| `forge-explain-error.cjs` | yes | A plain-language error explainer for BEGINNERS. |
| `forge-finalize.cjs` | yes | HET ene gezaghebbende eindverdict van een run. |
| `forge-fixtures.cjs` | yes | Real-fixtures intake gate (WAVE D / D2). |
| `forge-flaky.cjs` | yes | REPEAT-RUN nondeterminism detector. |
| `forge-fresh-repo-text.cjs` | no test yet | Pure text transforms behind `forge-fresh-repo.cjs` (rename, version and process-tag stripping inside comments and docs). No filesystem, no git. |
| `forge-fresh-repo.cjs` | yes | Maintainer tool (local-only): builds a brand-new public Forge-Core tree with one commit, no version numbers and no development-process artefacts. |
| `forge-gate-classify-worker.cjs` | no test yet | The worker_threads ENTRY POINT forge-gate-watchdog.cjs spawns (wp-v1/wp-v3). |
| `forge-gate-data.cjs` | no test yet | The INERT-DATA rule of the PreToolUse gate hook (forge-gate-hook.cjs), split out on 2026-09-24 (WP16 follow-up 2 + review-boss wp9a L1/L3) to keep both files under 500 lines. |
| `forge-gate-evidence.cjs` | yes | RUW BEWIJS PER POORT (Codex rapport-review R-01/R-05). |
| `forge-gate-hook.cjs` | yes | A `PreToolUse` hook (matcher `Bash`/`PowerShell`) that turns the 5 COMMAND hard gates (`destructive-delete`, `kill-by-name`, `git-destructive`, `opaque-exec`, `secret-print`) into a real stop — exit 2 blocks the tool call and explains why (NL+EN) instead of just advising against it. A classifier, not a proof: what it does not recognise it does not stop. Controlled by config key `gate-hook` (default ON — only the owner turns it off). **Not started by any wrapper above** — it only runs when wired into `.claude/settings.json` as a hook (see `config/orchestration/HOOKS_OPT_IN.md`). |
| `forge-gate-inspect.cjs` | no test yet | The SINGLE inspection pipeline forge-gate-hook.cjs's evaluate() used to run entirely on the main thread (wp-v3, sec-v1r-H1/L2 remediation). |
| `forge-gate-messages.cjs` | no test yet | The plain-language NL/EN wording for forge-gate-hook.cjs's block/notice text (wp-v3, split out so BOTH the main thread (forge-gate-hook.cjs) and the worker_threads Worker (forge-gate-classify-worker.cjs, via forge-gate-inspect.cjs) build … |
| `forge-gate-quotes.cjs` | no test yet | The ONE shared quote/heredoc-aware scanning pass for the PreToolUse gate hook and its classifier (root-cause rewrite, codex-recheck / wp-j1, after three straight waves each patched a SYMPTOM and regressed a SIBLING). |
| `forge-gate-scratch.cjs` | no test yet | The SCRATCH PASS-THROUGH lexer for the PreToolUse gate hook (forge-gate-hook.cjs), split out on 2026-09-24 (codex-recheck-2026-09-24, wp-f1) to keep both the hook and forge-gate-data.cjs under 500 lines. |
| `forge-gate-selfdisable.cjs` | no test yet | The `gate-hook-self-disable` detection subsystem (security wp9b M3, codex-recheck S05/V02), split out of forge-gate-hook.cjs (wp-v3, sec-v1r-H1 remediation) so BOTH the main thread (forge-gate-hook.cjs, for the watchdog-unavailable … |
| `forge-gate-watchdog.cjs` | no test yet | A HARD wall-clock guarantee that forge-gate-hook.cjs's classify() step always returns a verdict well inside Claude Code's own external hook timeout (wp-v1,,, security probe … |
| `forge-genesis.cjs` | yes | Forge GENESIS: staged, approval-gated self-authoring (PIECE J1). |
| `forge-global-drift.cjs` | yes | Maintainer tool (not shipped to projects): reports drift between the version-controlled `global-install/` copies of the global Forge pieces and the live `~/.claude`; never writes to `~/.claude`. |
| `forge-graph.cjs` | yes | Executable orchestration DAG (LATER tier). |
| `forge-harvest.cjs` | yes | READ-ONLY cross-project learning harvester (post-WAVE-E). |
| `forge-heartbeat.cjs` | yes | Stall/silence watchdog for a Forge run. |
| `forge-intake.cjs` | yes | Prompt Master intake question engine (WP-INTAKE). |
| `forge-integrate.cjs` | yes | HERMETIC INTEGRATION GATE. |
| `forge-killswitch.cjs` | yes | ONE handle that stops all autonomous execution in this project. |
| `forge-lane-watchdog.cjs` | yes | Read-only watchdog for parallel background Agent-tool lanes: flags STALLED, HUNG-TOOL, NO-WORK, LOOP, ERROR-STREAK, DISK-LOW and TMP-FLOOD from the lane transcripts (`--ids <agentIds> --once`, or `--watch 60` as a Monitor; exit 0 healthy, 1 flagged, 2 usage). |
| `forge-learn.cjs` | yes | OPT-IN, READ-ONLY, cross-project FEDERATED lesson recall (WP6, scout find #6). |
| `forge-lock-guard.cjs` | yes | Mechanical HOTSPOT WRITE-LOCK. |
| `forge-loophealth.cjs` | yes | A read-only, advisory LOOP-HEALTH check over the tool-call ledger that forge-toolhook.cjs already writes. |
| `forge-manifest.cjs` | yes | Mission-level swarm ARM/RECONCILE manifest (WAVE D / D1). |
| `forge-mcp-gate.cjs` | yes | MCP least-privilege REGISTRY + VALIDATOR + PLANNER (WAVE G1). |
| `forge-mcp-usage.cjs` | yes | Did the MCP least-privilege gate actually fire for the MCP tools that were used? |
| `forge-mcp.cjs` | yes | READ-ONLY Model Context Protocol server exposing THIS project's Forge run state (agent-ecosystem NEXT tier). |
| `forge-memory.cjs` | yes | Upgraded per-Boss memory (NEXT tier): TYPED lessons (episodic/semantic/ procedural), tag+keyword+recency top-K RECALL (so a run injects the few relevant lessons instead of a whole-file read), and MECHANICALLY-ENFORCED secret … |
| `forge-mindmap.cjs` | yes | Zero-dependency mind-map generator/writer for Forge Mission Control Phase 2 (WP4 "Mind Map"). |
| `forge-mutate.cjs` | yes | Zero-dependency MUTATION TESTING tool for Forge (WP3 Spoor A). |
| `forge-mutcheck.cjs` | yes | Test Boss mutation-CHECK helper (WAVE E / E3). |
| `forge-orchestrate.cjs` | yes | Run-driver checklist auditor (WAVE C / C5). |
| `forge-otel.cjs` | yes | Export a Forge run as OpenTelemetry GenAI spans in OTLP/HTTP-JSON (NEXT tier). |
| `forge-ownergrant.cjs` | yes | ONE verification for "did the owner really authorise this?". |
| `forge-paperclip.cjs` | yes | Forge ↔ Paperclip bridge (zero-dependency, project-local). |
| `forge-policy.cjs` | yes | Testable orchestration/security policy helpers (NEXT tier, GOAT model routing added 2026-10-06): • routeFor() — GOAT triage FALLBACK: task text + risk -> quick \| build \| deep, used when the Head Chef triage is unavailable. |
| `forge-prd.cjs` | yes | Zero-dependency PRD writer for Forge Mission Control Phase 2 (WP3 "PRD generator"). |
| `forge-prefs.cjs` | yes | Owner-profile resolver (WAVE B / PIECE B1). |
| `forge-projectbrain.cjs` | yes | Top-tier project-CLAUDE.md generator (Piece P4, RESEARCH-ENRICHED 2026-07-22, applying the V9 deep-research pass on Anthropic/community CLAUDE.md best practices, see scratchpad v9-deep-knowledge.json `claudemd_best_practices`). |
| `forge-promptcheck-ask.cjs` | no test yet | The `ask` mode of forge-promptcheck.cjs: a prompt-doctor on the RAW owner request, before Forge plans anything (split out of forge-promptcheck.cjs and completed in wp18). |
| `forge-promptcheck.cjs` | yes | Prompt Master dispatch-prompt linter (also reachable via `forge promptcheck` above). Default mode lints a dispatch/work-package prompt FILE against 7 dimensions (advisory; `--strict` makes it exit 1 below a threshold). `ask "<raw request>"` subcommand instead scores the OWNER's raw request against 5 dimensions (clarity, specificity, context, completeness, structure) in NL+EN before Forge plans anything — exit 0 CLEAR/OK · 2 usage · 3 VAGUE (ask one question first). Deterministic heuristics only, no LLM/network call. |
| `forge-proof-gate.cjs` | no test yet | ONE shared "is this claim actually proven" predicate (second Codex recheck 2026-09-24, out-p7.md). |
| `forge-quality.cjs` | yes | De Forge Quality Intelligence Layer (masterprompt 2026-08-11). |
| `forge-rebindguard-runner.cjs` | no test yet | The SEPARATE, real-Node-process half of forge-doctor.cjs::rebindingGuardBehavioral() (DOCTOR-1 fix, Lead review round 2, 2026-09-28: the behavioural layer had to be wired into runDoctor()'s real report, not just exported/callable on its … |
| `forge-recall.cjs` | yes | Utility-ranked lesson recall with a reserved GLOBAL/Lead namespace (WAVE E / PIECE E2). |
| `forge-recovery.cjs` | yes | Forge-native enforcement engine for the GLOBAL RESEARCH RECOVERY & SOLUTION-FIRST POLICY. |
| `forge-reflect.cjs` | yes | Owner-correction -> evidence-linked lesson writer (MANUAL-ONLY). |
| `forge-registry-gen.cjs` | yes |: read-only drift report + GENERATED proposals for the skill registry and the forge-bin tool table. |
| `forge-registry.cjs` | yes | GLOBAL, opt-in, READ-ONLY Forge project registry (Mission Control Phase 2, WP6). |
| `forge-reinforce.cjs` | yes | Outcome-gated lesson utility scorer (WAVE E / PIECE E2). |
| `forge-release-check.cjs` | yes | The rule that keeps private data out of the public Forge release used to live only in a gitignored scratch script that a fresh checkout could never run or re-check. |
| `forge-release-sync.cjs` | yes | Maintainer tool (not shipped to projects): the manifest-driven release copy of this development tree into the public release tree (plan / check / apply; moves orphans to a backup, never deletes). |
| `forge-repair.cjs` | yes | One-command repair ladder for beginners (also reachable via `/forge repair` above): status (Forge project? Command Center reachable? usage-guard line) → doctor (forge-doctor.cjs, full self-test) → refresh (forge-snapshot.cjs write) → one plain next-step sentence, stopping at the first step that finds or explains a problem. `--json` prints `{steps, next_step}`; `--lang nl\|en` picks the sentence's language. Never deletes, kills, or starts/stops anything — exit 0 healthy · 3 a problem found · 1 the tool itself could not run. |
| `forge-repomap.cjs` | yes | Cheap, token-light repository context map (piece H2). |
| `forge-report.cjs` | yes | Parses, validates, and ingests the structured subagent completion-report contract. |
| `forge-resume.cjs` | yes | Forge Resume — resume checkpoint + to-do CLI (zero-dependency). |
| `forge-retention.cjs` | yes | Begrensde retentie voor logs, toollogs en backups. |
| `forge-rule-promotion.cjs` | yes | Decides from run evidence whether a `warn` rule in FORGE_HARD_RULES.json may be promoted to `block` (READY / INSUFFICIENT DATA / UNEVALUATED). |
| `forge-ruleoftwo.cjs` | yes | Rule-of-Two auto-classifier (PIECE C4). |
| `forge-run-budget.cjs` | yes | The per-run COST CAP for UNATTENDED runs. |
| `forge-run-state.cjs` | yes | DURABLE RESUME projector (NEXT tier). |
| `forge-runcontract.cjs` | yes | Run-contract checker (P1 / V9-build). |
| `forge-runinfo.cjs` | yes | Project-local run info CLI: status \| runs \| open-report. |
| `forge-runwatch.cjs` | yes | COMPLETION / STALL predicate for a Forge run. |
| `forge-scout.cjs` | yes | External-capability research term-generator + persistent vetting ledger (PIECE P5). |
| `forge-scribe-classify.cjs` | no test yet | The deterministic NL+EN keyword classifier for Forge Scribe. |
| `forge-scribe-hook.cjs` | yes | `UserPromptSubmit` hook: records every owner prompt word for word through `forge-scribe.cjs` as a tracked request (R-n), prints a short receipt and the open-items digest; fail-open, no model or network call. |
| `forge-scribe-stop.cjs` | yes (in `forge-scribe-hook.test.cjs`) | `Stop` hook: blocks a stop once per captured request when an owner request of this session is still unplanned (`stop_hook_active` is honoured, fail-open). |
| `forge-scribe-store.cjs` | no test yet | Storage layer for Forge Scribe. |
| `forge-scribe.cjs` | yes | Forge Scribe core (design: audit SCRIBE-F2/F5/F6/F7/F10/F11 in .claude/forge-research/overhaul-2026-10-09/audit-scribe.txt). |
| `forge-secondbrain.cjs` | yes | Forge SECOND BRAIN: a READ-ONLY, EVIDENCE-CITED portfolio strategist across the owner's Forge projects (PIECE J3). |
| `forge-secret-scrub.cjs` | yes | ADVISORY secret/PII scanner for RUNTIME artifacts. |
| `forge-settings-merge-guards.cjs` | no test yet | Pure/near-pure helper functions extracted out of forge-settings-merge.cjs so that file stays under the project's file-size guidance while still fixing every settings-merge finding: containment/symlink guards (PROJECT-DIRECTORY- ESCAPE), … |
| `forge-settings-merge.cjs` | yes | `apply`/`check` — merges Forge's `.claude/settings.json` (every hook + `permissions.deny` rule) into an EXISTING project's own settings.json instead of leaving it for the owner to merge by hand: foreign hooks/rules/keys are kept in place (values untouched, order preserved, BOM/EOL/indent preserved) when the file can be reserialized losslessly; a file that cannot (duplicate keys, unsafe numbers) is left alone and reported; a verified-missing regular file -> created exclusively, present -> merged with a unique `.forge-bak-<ts>` backup first and re-verified right before the rename, malformed/unexpected shape or a directory-shaped target -> refused-safe (`settings.forge-recommended.json` written instead); every destination must lie inside the real project root (guards in `forge-settings-merge-guards.cjs`, codex-recheck 2026-09-24). Called by `install.sh`/`install.ps1` and by `forge-sync.cjs`'s own `syncProjectSettings()` — see `config/orchestration/HOOKS_OPT_IN.md`. |
| `forge-setup.cjs` | yes | The onboarding ENGINE behind the /setup-forge wizard. |
| `forge-shipcheck-refs.cjs` | no test yet | Reference extraction for forge-shipcheck.cjs's REFERENCE-CLOSURE check. |
| `forge-shipcheck.cjs` | yes | The ONE shipping truth, checked. |
| `forge-skill-evals.cjs` | yes | Per-skill self-improvement substrate, FOUNDATION piece (backlog item 1, YT-SWEEP-2026-07-31, 8 source videos — see .claude/forge-research/YT-SWEEP-2026-07-31.md). |
| `forge-snapshot-marker.cjs` | yes | PreCompact hook target (matchers `manual` AND `auto`, owner request 2026-07-29: a real snapshot must exist by the time context actually compacts, not just when someone remembers to ask). |
| `forge-snapshot-reinject.cjs` | yes | SessionStart hook target, matcher `compact` (owner request 2026-07-29: after a compaction, the very next turn must not have lost the mission). |
| `forge-snapshot-settings.cjs` | yes | Safe, idempotent `.claude/settings.json` MERGE helper for wiring the PreCompact (matchers manual+auto) + SessionStart(matcher:compact) snapshot hooks, without ever clobbering pre-existing hooks/keys. |
| `forge-snapshot.cjs` | yes | Context-continuity snapshot generator (owner request 2026-07-29: "bij elke 50% context een snapshot.md zodat er geen memory wordt vergeten"). |
| `forge-standing.cjs` | yes | Enforceable OWNER standing-rules resolver (WAVE B / B2, TEMPLATE/USER SPLIT added 2026-09-26, external audit N4/P1). |
| `forge-stats.cjs` | yes | Zero-dependency, READ-ONLY run-outcome statistics projector (WP2). |
| `forge-stop-obligations.cjs` | yes | Two jobs in one zero-dependency file: (1) the project Stop hook that prints an active Forge run's overdue or due-now obligations as an advisory message; (2) the shared helpers (e.g. `findActiveRun`) the hook call sites use. |
| `forge-store.cjs` | yes | Hardened, append-only flat-file store writer for Forge Mission Control Phase 2 (WP1 "Foundations"). |
| `forge-suite-pool.cjs` | no test yet | Internal helper of forge-doctor: bounded parallel runner for the doctor test suites with a private temp folder per suite. |
| `forge-swarm-resume.cjs` | yes | Mission-level swarm AUTO-RESUME (WAVE D / D1). |
| `forge-sweep.cjs` (+ `forge-sweep-core.cjs`, `forge-sweep-extract.cjs`, `forge-sweep-aggregate.cjs`) | forge-sweep: yes; forge-sweep-core: no test yet; forge-sweep-extract: no test yet; forge-sweep-aggregate: no test yet | Resumable, checkpointed YouTube **research** sweep: `enumerate`, `filter`, `transcripts`, `extract`, `aggregate`, `status` (also reachable via `forge sweep <stage>` above). Captions/metadata only via `yt-dlp` — never video/audio. Needs `yt-dlp` on PATH (`pip install yt-dlp`). The `-core`/`-extract`/`-aggregate` files are its own stage helpers (ledger/checkpoint plumbing, NVIDIA-model extraction, dedupe + report) — never run standalone. Output is `INTERNAL_USE_ONLY` research under `.claude/forge-research/`. |
| `forge-sync.cjs` | yes | Forge installer / sync — SAFE SYNC (2026-07-14 hardening WP1 + 2026-07-14 FIX ROUND). |
| `forge-testrun.cjs` | yes | Run a test command, print only a compact summary (usage reduction U-12). |
| `forge-tool-index.cjs` | yes | CROSS-RUN event search index (mining-ronde-1 §1). |
| `forge-toolhook.cjs` | yes | The tool-behaviour LEDGER: one compact line per real tool call, written by a `PostToolUse` hook, i.e. by the harness — NOT by the agent that made the call. |
| `forge-tournament.cjs` | yes | Forge best-of-N TOURNAMENT: plan N independent solution variants, score them against a transparent weighted rubric, promote the winner (PIECE J2). |
| `forge-trace.cjs` | yes | Requirements traceability projector (WAVE E / E3). |
| `forge-usage-report.cjs` | yes | Forge-usage-report: READ-ONLY usage baseline from Claude Code transcripts. |
| `forge-vault.cjs` | yes | Forge Knowledge Vault. |
| `forge-verify.cjs` | yes | The "verify-loop": after an agent (or the whole run) claims to be DONE, check whether that claim actually holds against the real events.jsonl and the ticket store. |
| `nvidia-provider.cjs` | yes | NVIDIA Build / NIM provider adapter for Forge (zero-dependency; mission 2026-07-05). |
| `usage-guard-override.cjs` | yes | DEFENSE IN DEPTH for the credits override (FOURTH Codex recheck). |
| `usage-guard-redact.cjs` | yes | The credential/redaction boundary split out of usage-guard.cjs (Codex recheck wp-f4: GUARD-TOKEN-ERROR / GUARD-TOKEN-FINGERPRINT). |
| `usage-guard-state.cjs` | yes | The exclusive state-lock primitive split out of usage-guard.cjs (Codex recheck wp-f4 V15: GUARD-STATE-RACE fail-closed fix, HARDENED across four Codex rechecks). |
| `usage-guard.cjs` | yes | Forge Usage Guard — REAL subscription usage watchdog (zero-dependency). |

## Account rotator — verder werken op een Claude-account dat nog ruimte heeft / staying on a Claude account that still has room
`account-rotator.cjs` (+ `-cli`, `-core`, `-vault`, `-txn`, `-handoff`, `-measure`, `-token`, `-recommend`) houdt je ingeschreven Claude Max-accounts in de gaten: zodra het actieve account op **een** venster (5-uurs sessie, week, of een model-weekvenster) de drempel haalt (standaard **92%**, `/forge config set account-rotator.threshold <50-99>`) zorgt het dat je verder kunt op een account dat nog ruimte heeft. De usage guard blijft de vangrug: zijn eigen pauze (98%) en reset-hervatting gelden als **alle** accounts vol zijn.
/ watches your enrolled Claude Max accounts: once the active account reaches the threshold (default **92%**) on **any** window (5-hour session, weekly, or a per-model weekly window) it keeps you on an account that still has room. usage-guard stays the safety net: its own pause (98%) and reset-based resume apply when **every** account is full.

**Twee modi / two modes (`account-rotator.mode`, standaard/default `token`)**
- **Token-modus (standaard) / token mode (default)** — de aanbevolen weg, zoals de owner besliste (2026-10-09: "wisselen via tokens"). Per account: `claude setup-token` → `node .claude/forge-bin/account-rotator.cjs enroll-token <naam>` (token via stdin of `FORGE_ROTATOR_ENROLL_TOKEN`, **nooit** als argument). De watcher (`start`) meet elk token-account met zijn eigen token en **schrijft** in token-modus **geen** login-bestanden (alleen het herstel van een eerder onderbroken bestands-swap kan dat doen): zit het huidige account op de drempel, dan legt hij de aanbeveling vast (`status`, `~/.claude/forge-accounts/handoff.json` fase `recommend`, `~/.claude/FORGE_ACCOUNT_ROTATION.json`) en wissel jij door een **nieuwe sessie** te starten: `... launch --auto -- <claude-argumenten>` (of `launch --account <naam>`). `launch` zet `CLAUDE_CODE_OAUTH_TOKEN` alleen in de omgeving van die nieuwe sessie en al haar subprocessen; een lopende sessie kan haar omgeving niet veranderen, dus die houdt haar eigen account. `... env <naam>` print één regel voor je shell (PowerShell of `--shell posix`) die het token in je **hele shell** laadt zonder dat het op je scherm of in je geschiedenis komt; `env` en `token-for-shell` weigeren in een AI-agentomgeving (`CLAUDECODE` e.a.) en zonder terminal alleen met `--i-know`. / the recommended path (: "switch via tokens"). Per account: `claude setup-token` → `enroll-token <name>` (token via stdin or `FORGE_ROTATOR_ENROLL_TOKEN`, **never** as an argument). The watcher measures every token account with its own token and **does not write** your login files in token mode (only the recovery of a previously interrupted file-mode swap can): when the current account reaches the threshold it records the recommendation (`status`, `handoff.json` phase `recommend`, the notification file) and you switch by starting a **new session**: `launch --auto -- <claude args>`. `launch` sets `CLAUDE_CODE_OAUTH_TOKEN` in that new session's environment only; a running session keeps its own account. `env <name>` prints one shell line that loads the token into your whole shell; `env`/`token-for-shell` refuse inside an AI agent's environment and need `--i-know` without a terminal.
- **Bestandsmodus (experimenteel, expliciet) / file mode (experimental, explicit)** — `/forge config set account-rotator.mode file` (of per aanroep `--mode file`): de watcher wisselt de login-bestanden van lopende sessies zelf (`enroll <naam>` per ingelogd account; `switch <naam>|--auto`). Een Codex-review toonde dat deze wissel **niet waterdicht** te maken is tegen Claude Code's eigen token-verversing: een hernoeming kan op Windows niet voorwaardelijk zijn, dus de controle "ongewijzigd sinds ik las" en de hernoeming blijven twee stappen. De wissel is daarom **best-effort: gedetecteerd en hersteld**, nooit gegarandeerd (details onder "Veiligheid"). / the watcher swaps the login files of running sessions itself (`enroll <name>` per logged-in account; `switch <name>|--auto`). A Codex review showed this swap **cannot be made race-free** against Claude Code's own token refresher: a rename cannot be made conditional on Windows, so the "unchanged since I read it" check and the rename stay two steps. The swap is therefore **best-effort: detected and repaired**, never guaranteed.
- Meet de usage-endpoint een setup-token niet (401/403), dan staat dat account eerlijk op `unmeasurable`; dan tellen: de volledige login van hetzelfde account (alleen bij een geverifieerde koppeling), daarna de laatst bekende cijfers, en als laatste een voorzichtige round-robin op de 5-uursreset. Er wordt nooit een percentage verzonnen. Een token in een slot met een login wordt alleen "verified" gekoppeld als token en login op **twee** vensters met echte resettijden dezelfde cijfers geven; anders weigert de rotator, of — als niets vergelijkbaar meetbaar is — alleen met `--confirm-same-account` (koppeling "unverified"). / unmeasurable setup tokens fall back to the account's own full login (verified binding only), then last-known readings, then a conservative 5-hour round-robin — never an invented percentage; a token is bound "verified" only when token and login agree on **two** windows with real reset times.
- `status` toont de modus, de aanbeveling en per account `credentials`/`token`/`both`, en **waarschuwt** als `CLAUDE_CODE_OAUTH_TOKEN` (of `ANTHROPIC_API_KEY`) globaal staat: die gaat vóór de bestandswissel. / `status` shows the mode, the recommendation and each account's kind, and warns when `CLAUDE_CODE_OAUTH_TOKEN` is set globally — it overrides the file swap.

**Starten en stoppen / start and stop** — `... start` (token-modus: minstens twee setup-tokens; bestandsmodus: minstens twee ingeschreven logins) · `... status` · proefdraai/dry run `... check` · `... stop` vraagt de watcher netjes te stoppen (het verzoek is gebonden aan het exacte pid + claim-nonce van die watcher; een opvolger wordt nooit gestopt of opgeruimd), alleen `... stop --force` beëindigt het proces direct (exact pid) · noodstop `... disable` / `... enable` · helemaal uit `/forge config set account-rotator uit`. / start (token mode needs two setup tokens; file mode two enrolled logins), status, `check` dry run, `stop` bound to the exact watcher record (pid + claim nonce — a successor is never touched), `stop --force` by exact pid, `disable`/`enable`, fully off via config.

**Bestandsmodus: uitkomst van een wissel / file mode: switch outcome** — `verified`: het nieuwe account is live gemeten; pas dan wordt het "actief" en krijgen sessies CONTINUE (ook bij een latere verificatie gelden drempel en uitputting: over de drempel = geen CONTINUE; een mislukte CONTINUE-schrijfactie wordt als zodanig gelogd). `unmeasurable-fallback`: de bestanden zijn gewisseld maar de meting lukte niet: geen CONTINUE, een latere ronde verifieert het; twee echte 401's op een automatische wissel, of **2 uur** zonder verificatie (ook "wacht op eerste gebruik"), zetten terug naar het vorige account en markeren het andere `needs-relogin` (`claude /login`, dan `enroll <naam> --force`); een handmatige wissel wordt nooit automatisch teruggezet maar wel na 2 uur gemarkeerd. `failed`: niet gewisseld, of onopgelost — dan staat het in `forge-accounts/txn.json`. Een eigen keuze (`switch <naam>`, `--auto`, `--force`) gaat altijd vóór een lopende verificatie; `enroll <naam> --force` na inloggen, of `switch --force` op een login die aantoonbaar bij één slot hoort, sluit een onopgeloste transactie. Mislukte pogingen wachten 2, 4, 8 … max 60 min; na 6 in 24 uur stopt de rotator met één melding. / `verified` = measured live, only then active + CONTINUE (deferred verification obeys the same threshold rules; a CONTINUE that could not be written is logged as such); `unmeasurable-fallback` = files swapped, not yet measurable; two genuine 401s or **2 hours** pending roll back + `needs-relogin` (manual switches are flagged, never rolled back); `failed` = not switched or unresolved (txn.json); an owner request always beats a pending verification; `enroll --force` / `switch --force` on a provably-owned login supersede an unresolved transaction; failed attempts back off and stop after 6 in 24 h.

**Bestandsmodus: wat er bij een wissel gebeurt / file mode: what a switch does** — (1) SAVE: `handoff.json` (zonder tokens), lopende Paperclip-agents gepauzeerd via usage-guard's eigen journal (een twijfelachtig antwoord — netwerkfout, time-out — wordt als `pause-unknown` bewaard en later tegen de echte agentstatus afgehandeld), en sessies krijgen via de usage-guard-hook een korte pauzemelding; (2) SWITCH: alleen `claudeAiOauth` in `~/.claude/.credentials.json` en alleen `oauthAccount` in `~/.claude.json` worden vervangen (BOM/regeleinden behouden), vlak vóór elke hernoeming opnieuw "ongewijzigd" gecontroleerd en direct erna teruggelezen; het profiel wordt alleen geschreven als het nog het oorsprongsaccount noemt; daarna wordt het paar geverifieerd, anders per sleutel teruggezet — alleen zolang die nog precies bevat wat de rotator schreef; (3) CONTINUE: het nieuwe account wordt live gemeten (vol? dan maximaal 3 sprongen verder, elke sprong met een eigen oordeel), agents hervat, en sessies krijgen "ga verder + verplichte checkup". Een mislukte opruimstap (pauzemelding niet verwijderd) blijft als verplichting in `handoff.json` staan en wordt bij de volgende ronde herhaald. / handoff file without tokens, Paperclip agents paused through usage-guard's own journal (an ambiguous response is kept as `pause-unknown` and reconciled against the agent's actual state), a short pause notice to sessions; only the two login keys are replaced, re-checked "unchanged" right before every rename and re-read right after it, the profile written only while it still names the origin account, then verified and otherwise rolled back per key — only while the key still holds exactly what the rotator wrote; the new account is measured live (per hop), agents resumed, sessions told to continue with a mandatory checkup; a failed cleanup step stays an obligation in handoff.json and is retried.

**Alle accounts vol / every account full** — geen wissel of aanbeveling; `handoff.json` noemt de vroegste reset; zodra een account onder de drempel zakt of zijn venster reset, gaat het vanzelf verder. / no switch or recommendation; the handoff names the soonest reset; as soon as any account is usable again the rotator continues.

**Veiligheid / safety** — tokens gaan alleen naar `api.anthropic.com`; nooit geprint, gelogd of in state/handoff/meldingsbestand; inactieve accounts worden nooit ververst (alleen hun nog geldige token, anders de laatst bekende stand, "estimated"); een meetfout is nooit "in orde" en nooit "vol" (geen actie); tegen heen-en-weer: 10 min cooldown, max 6 wissels per 24 uur (elke sprong telt, geboekt op transactie-id en nooit dubbel), 5% hysterese, nooit terug naar het net verlaten account vóór zijn reset. **Eigendom van een login wordt nooit afgeleid uit alleen het account-id in het profiel**: een vernieuwde login (Claude Code roteert refresh-tokens) wordt pas in de kluis opgenomen als het eigendom onafhankelijk vaststaat — het token is precies het opgeslagen token, of de transactie schreef het zelf (gezouten vingerafdruk in `txn.json`, zonder token), of zijn gebruikscijfers komen op twee vensters met echte resettijden overeen met een recente meting via het eigen opgeslagen token van dat slot; tot dan blijft de transactie "onopgelost", wordt niets vervangen en vertelt `status` wat jij kunt doen. Een onbekend of vreemd token wordt nooit overschreven. **Eerlijke grens (bestandsmodus):** een schrijfactie van Claude Code die in de microseconden tussen de "ongewijzigd"-controle en de hernoeming landt, wordt overschreven en is achteraf niet te zien; de sessie houdt haar tokens in het geheugen en schrijft ze bij de volgende verversing opnieuw — sluit ze eerder af, dan heeft dat account `claude /login` nodig. De kluis staat onder je gebruikersprofiel (Windows-ACL van `~/.claude`; op macOS/Linux bestanden 0600; vorige generaties in `<naam>.prev.json`); Claude's Read-tool mag de map niet lezen (`.claude/settings.json`) en een shell-commando dat er iets uit print wordt gestopt (`secret-print`-poort). / tokens only ever go to api.anthropic.com and never appear in output/log/state; inactive accounts are never refreshed; a fetch error is never "fine" and never "full"; cooldown, a 6-swaps-per-day cap counted per hop (keyed by transaction id, never twice), hysteresis; **ownership of a login is never inferred from the profile's account id alone** — a refreshed login enters the vault only once ownership is established independently (the exact stored token, the transaction's own salted fingerprint in txn.json, or usage readings matching a recent reading taken with that slot's own stored token on two windows with real reset times); until then the transaction stays unresolved and nothing is replaced; an unknown or foreign token is never overwritten. **Honest limit (file mode):** a write by Claude Code landing in the microseconds between the "unchanged" check and the rename is overwritten and cannot be seen afterwards; the session rewrites its tokens at its next refresh, and if it exits first that account needs `claude /login`. The vault is denied to the Read tool and to secret-printing shell commands.

## Notes
- `.sh` scripts expect LF endings (installed via copy, so they keep LF); `.cmd` files are pure ASCII with CRLF on purpose — a UTF-8 dash in a batch file shifts cmd's byte offsets and breaks `goto`.
- Exit codes are propagated: a failed `log-event` (bad JSON, unregistered event type) returns non-zero from every wrapper.
- Everything is project-local and isolated — these never read or start another project's dashboard.
- Version: the one source is `.claude/config/orchestration/forge-canon.json` → `version.forge` (see the project `CLAUDE.md`). Release tags such as in this file name the release in which something changed, not the current version.
