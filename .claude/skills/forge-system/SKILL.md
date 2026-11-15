---
name: forge-system
description: "Use when asked what Forge is or how it works end to end (hoe werkt forge, uitleg)."
---
<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->

# Forge system: the whole map in one skill

Forge is a multi-agent build system on top of Claude Code: a Lead routes work to fixed Bosses, every package is verified, and a run closes only through its run contract. This skill is the table of contents; the lists live in `references/`, generated from the real config.

**A skill cannot enforce anything.** It carries the knowledge and the entry point. The hooks, gates, scripts and agents that make the rules hold are code. Detail: `references/limits.md`.

## When to use
- Someone asks what Forge is, how a run works, which Boss does what, what stops a push, what a setting does, or how to resume.
- A fresh agent in a Forge project needs the map before it acts.
- Not for: starting a build (`forge-router` and the /forge command), a domain playbook (see `references/skills.md`), the house rules every agent follows (`forge-conduct`).

## Operating rules

1. **Run contract.** A run starts with `node .claude/forge-bin/forge-start.cjs --text "<request>"` and closes only through `node .claude/forge-bin/forge-runcontract.cjs plan --run <run_id>` up to `check --finalize`. Never claim done over a red contract. See `references/workflows.md`.
2. **GOAT routes.** Head Chef triages every package to a route: triage sonnet/low · quick sonnet/low · build opus/medium · deep opus/xhigh · escalate fable/high · verifier sonnet/medium. One escalation on a failed check, never more. See `references/routes.md`.
3. **Bosses.** Work goes to the 12 permanent Bosses (Boss, Head Chef, Review Boss, Test Boss, UI Boss, SEO Boss, Security Boss, Skill Boss, Search Boss, Build Boss, Integration Boss, Docs Boss); specialists only for their domain. Never invent agent names. See `references/agents.md`.
4. **Lanes.** Independent parts run in parallel, as many as `node .claude/forge-bin/forge-lane-budget.cjs` allows. One writer per file: each writer gets its own worktree and branch; the Lead merges.
5. **Gates.** 8 command gates are blocked by a hook; 13 more wait for the owner (push, deploy, spend, credentials, outbound, production). See `references/gates.md`.
6. **Scribe.** Every owner instruction is captured verbatim with `node .claude/forge-bin/forge-scribe.cjs capture`; `node .claude/forge-bin/forge-scribe.cjs gate` runs before completion.
7. **Memory.** Read the project profile, memory and task history under `.claude/` before a task; append after it with evidence only. Each agent keeps lessons in its own folder under `.claude/agent-memory/`.
8. **Owner queue.** A report hands the owner hard gates only, in one batched list at the end, never a choice the Lead can make (`node .claude/forge-bin/forge-owner-queue-check.cjs`).
9. **Resume.** `/forge resume <run_id>` reconciles the run from its events and re-dispatches only unfinished packages. See `references/workflows.md`.
10. **Evidence.** Every claim needs a real run of the check; Verify Boss passes or fails each package and never edits.

## Map

| file | what is in it |
|---|---|
| `references/agents.md` | 12 Bosses and 54 specialists: role, route, model, preloaded skills |
| `references/skills.md` | all 133 project skills with their description, grouped |
| `references/commands.md` | 3 slash commands and the /forge sub-commands |
| `references/hooks.md` | 17 hook registrations and what each script does |
| `references/gates.md` | 21 hard gates: which a hook blocks, which the owner decides |
| `references/config.md` | 58 settings with type, default and meaning |
| `references/routes.md` | GOAT routes, default route per agent, escalation |
| `references/tools.md` | 244 scripts in forge-bin with their purpose |
| `references/workflows.md` | how a run goes, the run checklist, workflow scripts, resume |
| `references/limits.md` | what a skill cannot enforce, and what does |

## Keeping it true

- Regenerate after a config change: `node .claude/forge-bin/forge-system-skill.cjs generate`. Never edit these files by hand.
- `node .claude/forge-bin/forge-system-skill.cjs check` exits 1 when a file is stale, a path reference is dead or a secret pattern appears.
- Portable copy for another project or the user skills folder: `node .claude/forge-bin/forge-system-skill.cjs export --out <dir>` (SKILL.md and references only).
