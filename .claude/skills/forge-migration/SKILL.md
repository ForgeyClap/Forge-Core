---
name: forge-migration
description: "Playbook for legacy modernization: strangler fig (gebruik bij een migratie)."
# A10 original description (listing budget): "Playbook for legacy modernization without a big-bang rewrite: strangler fig, parity (gebruik bij een migratie)."
# W2-BUDGET original description (listing budget): "Playbook for legacy modernization: strangler fig, parity (gebruik bij een migratie)."
---

# Forge playbook — Legacy modernization / migration

## When to use
- Use for: legacy modernization and migrations: characterization tests, strangler-fig slices, parity checks, reversible data moves.
- Domain framing, team roles and honesty rule: `references/overview.md`.

**Do not duplicate ECC skills — defer to:** `learn-codebase` / `forge-deeplearn` (prime the legacy system before touching it — mandatory here), `test-driven-development` + `systematic-debugging` (characterization + regression work; both ship with Forge as pinned vendored skills), `forge-worktrees` (isolate each slice), `/test-coverage`. This file is orchestration only.

## Hard rules
- **Characterization tests first.**
- **Strangler-fig, incremental cutover.**
- **Every step is reversible.**
- **Parity verified before a slice is trusted.**
- **No big-bang rewrite.**
- **Data migration is reversible and verified.**
- **Live-database schema changes use expand-and-contract.**
- **Test migrations on a realistic copy first.**

Full text of every rule: `references/hard-rules.md`.

## Team
Lead: `build-boss` with `head-chef` sequencing the slices (the phasing IS the work). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L3 for a bounded migration; **L4 (phased)** for a large legacy system — the phases are the plan.
**Serial (the spine):** deep-learn the legacy system → write characterization tests (green on legacy) → introduce the seam/facade → build the new slice → parity-verify (shadow/diff old vs new) → flag-gated cutover of that one slice → verify in production → repeat for the next slice → decommission the old path only after its replacement is parity-proven and stable.
**Parallel:** once seams exist, independent slices for *different* modules can proceed in isolated worktrees; characterization-test authoring for slice N+1 can run alongside the build of slice N. You (the Lead) are the integration layer — you never let two slices write the same seam concurrently.

## Domain gates
Legacy behavior characterized (golden/approval tests exist and pass **on the legacy code** before any change); a seam/facade routes per-slice; each migrated slice is behind a flag with a **proven** route-back; parity verified old-vs-new for the slice (shadow/diff evidence, discrepancies reconciled); no big-bang cutover; data migration reconciled (row counts + checksums match) and reversible with a backup; auth/authz + secrets preserved across the cutover; the old path retained and authoritative until parity is proven.

## Ship-readiness
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no destructive drop of the source store until the new store is verified and a backup exists.
- Approval / safety: every slice cuts over behind a flag with a proven route-back.
- Honest failure: legacy system not runnable here: report characterization + parity as designed, not executed.
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
