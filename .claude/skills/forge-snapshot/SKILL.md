---
name: forge-snapshot
description: "Regenerates FORGE_SNAPSHOT.md to survive compaction. Use at a phase boundary."
# W2-BUDGET original description (listing budget): "Regenerates FORGE_SNAPSHOT.md from real project sources so the mission survives compaction. Use at a phase boundary or on /forge snapshot; hooks also trigger it."
---

# Forge playbook — Snapshot (context-continuity snapshot system)

**Self-improvement substrate (wp-skill-evals):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction (an owner fix, a false assumption caught, a preference stated), append it to
`learnings.md` with a date and real evidence — never invent a lesson that didn't happen.

**Owner request:** "bij elke 50% context een snapshot.md zodat er geen memory wordt vergeten…
en dan een uitgebreid rapport zodat de agents nog weten wat we maken — dit geldt ook voor globaal." There is
**no context-percentage available to a hook** (a closed Claude Code feature request — the only percentage
lives in the separate statusline channel, `context_window.used_percentage`, which no hook can read). This
system never fabricates or estimates one. Instead it fires on the real, honest signals: a **PreCompact**
hook (the genuine "context is about to be compacted" event), a phase boundary, or an explicit manual call.

## What it does

`node .claude/forge-bin/forge-snapshot.cjs write [--run <id>] [--reason ...]` regenerates `.claude/FORGE_SNAPSHOT.md` (ten fixed sections, every claim with an evidence pointer) from real project sources; `check [--max-age-hours N]` is a read-only staleness probe. A **PreCompact** hook (`forge-snapshot-marker.cjs`) writes a due-marker and a fresh snapshot; a **SessionStart** `compact` hook (`forge-snapshot-reinject.cjs`) re-injects Mission + Current state + Next actions. Both never block and never print a secret. The four tools, the sources read, the hook wiring and the settings merge helper in full: `references/internals.md`.

## Anti-drift (the core design decision)

- **Section 3 ("Current state") is ALWAYS re-derived fresh from source-of-truth** on every regeneration —
  never patched forward from a previous snapshot. Changing `events.jsonl` or `TODO_GRAPH.md` between two
  `write()` calls changes the output; nothing is ever carried over except what section-1 explicitly
  preserves.
- **Section 1 ("Mission") is the one deliberate exception — preserved VERBATIM** across regenerations. It is
  read from an existing `<!-- MISSION:BEGIN -->...<!-- MISSION:END -->` marker if the current
  `FORGE_SNAPSHOT.md` already has one; else migrated verbatim from a pre-existing hand-written snapshot's own
  first `## ` section (a one-time migration path so a hand-authored stopgap's mission survives the switch to
  this tool); else derived from `FORGE_MEMORY.md`'s latest status heading; else an honest, clearly-marked
  TODO for a human/agent to fill in — never guessed prose.

## Size discipline

Target <= ~2000 tokens of prose (chars/4 heuristic — approximate, not a real tokenizer, and reported honestly
as `approxTokens` rather than presented as exact). Long things are **paths**, never inlined. Every generated
section (2..9 — Mission is exempt) that would exceed its own character budget is cut with an explicit
`"(truncated — see <path>)"` marker rather than growing unbounded.

## Honesty

Every generated claim carries a real evidence pointer (a relative path, optionally with an event type/heading)
or is explicitly marked in the Honesty footer's "unknown/missing" list — never a bare, unattributed assertion.
**No context-window percentage is ever fabricated or estimated anywhere in this system.**

## Wiring
Opt-in, already applied 2026-07-29 (project-local and global hooks; live record in `HOOKS_OPT_IN.md`). Details: `references/internals.md`.

## When to use

- Automatically: the wired PreCompact/SessionStart(compact) hooks fire on a real compaction.
- Manually: `/forge snapshot` (phase boundary, or whenever the owner wants a fresh, evidenced snapshot without
  waiting for a compaction) -> `node .claude/forge-bin/forge-snapshot.cjs write --reason phase`.
- Suggest `/compact` with a short focus note at a logical boundary (a phase just finished, or before an unrelated task) — around 60% context use — never in the middle of a task.
- `node .claude/forge-bin/forge-snapshot.cjs check --max-age-hours 24` to probe staleness (e.g. from a doctor
  pass or before a long unattended run).

Never hand-edit sections 2-10 of `.claude/FORGE_SNAPSHOT.md`; edit only the text between the MISSION markers to change the Mission. One agent, no team: any Boss can call `write --reason phase` at a natural checkpoint. Tools, fan-out and ship-readiness in full: `references/internals.md`.
