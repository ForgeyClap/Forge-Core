<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# Forge slash commands

Generated from: `.claude/commands/`.

## /commit (user-invoked only)

- description: Create a git commit

## /forge

- description: Forge — project-aware, memory-aware orchestrator. Classify a task, read project memory, build a task-sized agent team, execute in this folder, log real events, update memory + agent ledger, optionally Codex-review, deliver an honest report. Project isolation always on.
- arguments: `[task | config [list|get <key>|set <key> <value>|unset <key>|reset|explain <key>] | dashboard | start | use | init [plan|apply|check] | status | runs | open-report | repair | resume <run_id> | learn | remember <text> | snapshot | killswitch | rollback | paperclip <goal>]`

Sub-commands (from the command file, section B):

- `dashboard` / `start` — Command Center on `http://127.0.0.1:4100` only; health-check first, never fake a start; `start` then begins a run.
- `config` — run `node .claude/forge-bin/forge-config.cjs list|get|set|unset|reset|explain` yourself (phrases via `parse "<sentence>"`); repeat its OK line.
- `help me ask` — show `.claude/skills/forge-prompt-coach/references/HOW-TO-ASK.md`. `interview` — the full one-question-at-a-time intake.
- `use` — load memory/profile, install Forge into a bare folder yourself, start the dashboard, continue the task.
- `status` / `runs` / `open-report` — `node .claude/forge-bin/forge-runinfo.cjs …`. `repair` — `node .claude/forge-bin/forge-repair.cjs --json` yourself, act on `next_step`.
- `stats [--json] [--since <date>] [--runs <n>] [--trend <n>]` — `node .claude/forge-bin/forge-runinfo.cjs stats [args]` (read-only routing statistics of this project's own runs).
- `init [plan|apply|check]` — set this project up for Forge (install step 2): run `node .claude/forge-bin/forge-init.cjs plan`, then `forge-init.cjs apply --yes` yourself and relay its summary (memory files, settings.json deny rules + hooks, CLAUDE.md pointer block; only this folder; `--layout forge` only when the owner asks). `check`: exit 0 = set up, hooks too.
- `remember <text>` — `node .claude/forge-bin/forge-standing.cjs remember "<text>"` (the ONLY path to a new active standing rule). `snapshot` — `node .claude/forge-bin/forge-snapshot.cjs write --reason phase`.
- `propose-skill` / `approve-skill` — `forge-genesis.cjs` (staged only; owner token to approve).
- `tournament` / `secondbrain` / `codemodel` / `briefing <run_id>` — read `.claude/docs/forge-reference/tournament-secondbrain-codemodel-briefing.md` first.
- `resume <run_id>` — read `.claude/docs/forge-reference/resume.md` first. `learn` — read `.claude/docs/forge-reference/learn-harvest.md` first.
- `killswitch`/"noodstop", `rollback` — never a task or new run: see `forge-cmd-subcommands.md`; run only status/list/dry runs; `--confirm`/`--yes` is owner-only.
- `paperclip` — OPT-IN only, never started by plain `gebruik forge`; read `.claude/docs/forge-reference/paperclip.md` first.

## /revise-claude-md

- description: Update CLAUDE.md with learnings from this session
