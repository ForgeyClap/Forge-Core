# forge-snapshot — what it does, wiring, tools, fan-out, ship-readiness (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps the trigger rules, anti-drift, size, honesty and when to use; this file keeps the complete original wording.

1. **`forge-bin/forge-snapshot.cjs`** — the generator. `write([--run <id>] [--reason ...])` regenerates
   `.claude/FORGE_SNAPSHOT.md` from real sources: `FORGE_MEMORY.md`'s latest status block, `FORGE_TASK_HISTORY.md`'s
   latest entry, `tasks/WORK_PACKAGES.md`'s latest mission block, `FORGE_DECISIONS.md`'s most recent rows, the
   newest run's `events.jsonl` (done/in-progress buckets, each with a real evidence pointer), `command-center/mission/TODO_GRAPH.md`
   or `WORK_PACKAGES.md`'s WP-ID/Status lines (open items), `git log`/branch/dirty state, `FORGE_VERSION.json`,
   and the newest `forge-runs/*/doctor.json`. Ten fixed sections: Mission · Why · Current state · Key decisions
   · Active constraints · Key file paths · Known gaps/limitations · Next actions · Evidence pointers · Honesty
   footer. `check([--max-age-hours N])` is a read-only staleness probe (for the doctor or a manual check).
2. **`forge-bin/forge-snapshot-marker.cjs`** — the **PreCompact** hook target (matchers `manual`+`auto`).
   Writes `.claude/.forge-snapshot-due.json` and immediately calls `forge-snapshot.cjs`'s `write()` so a real
   skeleton exists even if the session ends before the next step runs. Never blocks compaction (always exits
   0), never prints anything to stdout, never prints a secret.
3. **`forge-bin/forge-snapshot-reinject.cjs`** — the **SessionStart** hook target, matcher `compact`. If the
   due-marker exists, prints a short (<= ~600 tokens) block — Mission + Current state + Next actions + an
   explicit instruction to refresh sections 3-9 — to **stdout**, which Claude Code re-injects directly into
   context (the one official re-injection point this whole system relies on). Then deletes the marker. No
   marker -> prints nothing, exits 0.
4. **`forge-bin/forge-snapshot-settings.cjs`** — the one-time, idempotent `.claude/settings.json` MERGE
   helper used to wire the two hooks above without ever clobbering pre-existing hooks/keys (`apply --target
   <path> --marker-command "<cmd>" --reinject-command "<cmd>" [--backup]`).

## Wiring (opt-in, already applied 2026-07-29 — see `HOOKS_OPT_IN.md` for the live record)

- **Project-local** `.claude/settings.json`: PreCompact (matchers `manual`+`auto`) -> `forge-snapshot-marker.cjs`;
  SessionStart (matcher `compact`) -> `forge-snapshot-reinject.cjs`.
- **Global** `~/.claude/settings.json`: the same two events, appended alongside the 2 pre-existing global
  hooks (hotspot-lock, secret-scrub) and every other pre-existing entry — proven preserved byte-for-byte by
  `forge-snapshot-settings.test.cjs`'s load-bearing safety suite. The global hook commands point at the
  GLOBAL minimal mirror (`~/.claude/forge-bin/forge-snapshot-{marker,reinject}.cjs`), which resolves the
  target project's root from `CLAUDE_PROJECT_DIR` (or cwd) and dynamically requires **that project's own**
  `.claude/forge-bin/forge-snapshot.cjs` — a project with no Forge install degrades silently (no output, exit
  0).

## Skills / commands

`forge-bin/forge-snapshot.cjs` (`write`/`check`), `forge-bin/forge-snapshot-marker.cjs` (PreCompact target),
`forge-bin/forge-snapshot-reinject.cjs` (SessionStart target), `forge-bin/forge-snapshot-settings.cjs`
(settings.json merge helper), `.claude/FORGE_SNAPSHOT.md` (the generated artifact — never hand-edit sections
2-10; edit only the text between the MISSION markers to change the Mission), `.claude/.forge-snapshot-due.json`
(transient marker, deleted on consumption).

## Fan-out & flow

**1 agent, no team.** This is a deterministic, zero-dependency CLI + two small hook targets — not a
multi-agent task. Any Boss doing build/fix work can call `write --reason phase` directly at a natural
checkpoint.

## Ship-readiness (unique)

Never fabricates a context percentage; never blocks compaction/session-start (both hook targets always exit
0); never prints a secret (FORGE_SNAPSHOT.md only ever holds paths/pointers/short evidenced text, never raw
file bodies or credentials); the settings.json merge is proven idempotent and non-destructive by a dedicated
test suite before being applied to the real global config; degrades silently in a project with no Forge
install.
