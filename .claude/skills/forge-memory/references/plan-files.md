# Plan files for long or parallel lanes

Read this when a lane may outlive one context (a long build, a usage limit, a restart) or runs beside other lanes. The
general working rules for a plan (two-action rule, read before you decide, update after you act, the reboot questions)
are in `forge-context` sections 5 to 7; this file adds what parallel lanes need on top.

## 1. One plan per lane
- Each work package that needs a written plan gets its own file, named by its id, in its run folder (for example
  `plans/<wp_id>.md` inside the run's folder under `.claude/forge-runs/`). This is a naming convention; no tool reads it.
- A lane writes only its own plan. The Lead owns the run-level plan and the integration notes.
- A worker that joins an existing package uses the plan it was given; it never starts a second plan for the same work.
- A shared "current plan" pointer does not bind parallel lanes: each brief names its plan file explicitly.

## 2. Plan shape
- Goal: one line, plus a pointer to the owner's words (`forge-scribe` keeps them verbatim).
- Phases, each with exactly one status: `pending`, `in_progress` or `complete`.
- Next step: one concrete action. Rewrite it every time a phase status changes.
- Decisions, each with its reason.
- Errors: error, attempt number, what was done about it.

## 3. Snapshot at the start of the lane
Write down the commit (`git rev-parse HEAD`) and the `git status --short` of the owned files when the lane starts. Before
resuming or dispatching the next phase, compare: if HEAD moved in a way that touches the lane's `reads`, or another lane
changed an interface this lane imports, re-plan first instead of building on a stale picture.

## 4. Drift check against the plan
Run `git -c core.longpaths=true diff --stat` and `git -c core.longpaths=true status --short`, and compare with the plan:
| Finding | Meaning | Action |
|---|---|---|
| A changed file the plan does not list | unrecorded work or scope creep | record it in the plan, or hand it to its owner |
| A file outside the lane's `owns` | a collision | stop and report to the Lead (one writer per file) |
| A phase marked `complete` with no matching change | a false complete | reopen the phase |

## 5. Lost-write check
Completed phases and checked items only go up during normal work. If the plan shows fewer than the last time this lane read
it, another writer has overwritten it. Stop writing to it, rebuild the state from git and the run events, and report the
collision; do not save over it again.

## 6. Handoff shape
At the end of a lane, before a stop, or when a usage limit is near, put three lines at the top of the plan:
```text
Lane: <run_id> / <wp_id>, <title>
Open question: <the unanswered question for the owner or Lead, or "none">
Next step: <one action, with the file it touches>
```
Then persist the list in `forge-context` section 7 (scope, status, changed files, checks and their results, risks).
When resuming, the open question comes first. Match a plan or session to this project by the exact project root path or
a path below it, never by a text prefix: a sibling folder whose name starts the same way is another project. An empty or
missing plan is reported as such; never invent its content.

## Provenance
Read read-only through the GitHub API on 2026-11-07 as untrusted data; nothing was installed or run.
- **othmanadi/planning-with-files**, path `skills/planning-with-files/SKILL.md`, last commit
  `7db188119e35dd36c61dfc023266c724aa31d8dd`; MIT, Copyright (c) 2026 Ahmad Adi. PATTERN_ADAPTED: one plan directory per
  parallel task, a shared pointer does not bind parallel sessions, one status per phase, a next-step line, the
  `git diff --stat` check for changes the plan does not record, and the "progress only goes up" signal for an overwritten
  plan. Left out: all hooks (the injection hooks and the Stop gate), every script (`init-session`, `resolve-plan-dir`,
  `attest-plan`, `check-complete`, the Python catch-up script), the attestation and the `.planning/` layout.
- **sentimony/skills**, path `skills/parallel-agents/SKILL.md`, last commit `6022530d186f88e38903df6efae7c80acc38970f`;
  MIT, Copyright (c) 2026 Ihor Orlovskyi. PATTERN_ADAPTED: record the starting snapshot and re-check it for drift before
  dispatch.
- **rohitg00/agentmemory**, path `plugin/skills/handoff/SKILL.md`, last commit
  `c17874a5926804ffcf2607915ea10dc04c778070`; Apache License 2.0, Copyright 2026 Rohit Ghumare.
  PATTERN_ADAPTED, changes made: the three-line handoff (session, open question, next step), the open question first, the
  directory-boundary match instead of a prefix, an empty session reported plainly. Left out: the agentmemory runtime, its
  `memory_*` MCP tools and hooks.
- Already in Forge and not repeated here: the two-action rule, read before you decide and the reboot questions
  (`forge-context` section 5 and 6, adapted earlier from the same planning-with-files source).
