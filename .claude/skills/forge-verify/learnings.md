# forge-verify — learnings

Append-only log of real corrections/preferences learned from actual runs. Read this file before
applying `forge-verify`; add one dated entry (with evidence) after a run that produced a genuine
correction. Never invent an entry — an unsupported "lesson" is worse than no lesson.

- **2026-07-31:** `forge-verify.cjs` gained `checkAcceptanceCoverage()` (spec-drift / acceptance-
  coverage detection, backlog item 7 from the GSD (get-shit-done-cc) mining pass) — closing a real gap
  this skill previously missed: a planner silently dropping a PRD acceptance criterion produced no
  mismatch at all under the old events/tickets-only check, because the criterion was never wired to a
  task in the first place. Each PRD criterion is now classified covered/dropped/changed; a `dropped`
  criterion with no explicit owner decision is now a verify failure. Evidence:
  `.claude/forge-bin/forge-verify.cjs` header comment "BACKLOG ITEM 7 / spec-drift (2026-07-31...)" and
  the maintainer research note MINING-RONDE-1-2026-07-31 (local research folder, not shipped). Lesson: "the events say it's done" and "the
  spec's own requirements are still fully covered" are two different checks — verify both.

- **2026-10-24 (claim verdict):** replaying the new runner-output parser on REAL output found two
  defects the hand-written fixtures missed: (1) this repo's own line `  ok  7d-setup: ...` was read as TAP
  test 7 named `d-setup: ...` (a loose `ok \d+` regex), which would have turned a real test into a false
  "absent test"; (2) a bare "likely" in evidence quoting a tool diagnosis ("backfill likely missed") was
  flagged as a hedge (2 of 1432 real done-events). Both fixed with a regression test each. Lesson: run a
  claim detector over the project's real runner output and real events before trusting it.
