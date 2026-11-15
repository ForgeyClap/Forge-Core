<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# What this skill cannot do

Generated from: `.claude/settings.json`, `.claude/config/orchestration/hard-gates.json`.

A skill is text the model reads. It carries the knowledge of Forge and one entry point into it. It **cannot enforce** anything:

- It cannot block a tool call. Blocking lives in hooks that Claude Code runs as code, outside the model.
- It cannot stop a push, a deploy or a delete. The command gates are a PreToolUse hook; the owner gates are a classifier plus the owner's decision.
- It cannot dispatch a Boss, pick a model or set effort. Agents are agent files plus the Agent tool or a Workflow `agent()` call.
- It cannot write run events, the ledger or memory, and it cannot prove a check ran. Scripts do that and leave evidence.
- It may not fire at all: a skill triggers only when its description matches, and a long skill listing can drop descriptions.
- It goes stale: it is a snapshot of the data at its last `generate`. `check` shows when it no longer matches.
- A portable copy (export) carries the knowledge only. In a project without Forge installed none of the tools, hooks or gates named here exist.

## What does enforce (in this project, today)

- 17 hook registrations in the settings file (see `references/hooks.md`).
- 8 command gates blocked by the gate hook: `kill-by-name`, `destructive-delete`, `git-destructive`, `opaque-exec`, `secret-print`, `plugin-install-command`, `settings-edit-command`, `global-input-command`.
- The run contract and the Stop hook refuse a close over a red contract.
- Tests and the doctor turn red when the code breaks.
