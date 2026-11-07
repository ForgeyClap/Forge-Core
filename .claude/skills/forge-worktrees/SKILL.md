---
name: forge-worktrees
description: "Use when 2+ Bosses write one repo at once (parallel bouwen, worktree)."
# A10 original description (listing budget): "Use when 2+ Bosses write one repo at once (parallel bouwen, worktree): isolate the work, avoid conflicts."
# W2-BUDGET original description (listing budget): "Use when 2+ Bosses write one repo at once (parallel bouwen, worktree): isolate the work."
---

# Forge playbook — Safe parallel work via git worktrees

**Do not duplicate ECC skills — defer to:** `using-git-worktrees` (detect existing isolation → native
tools → git worktree fallback, mechanics and commands). This file is the Forge-specific orchestration
wrapper: when Forge reaches for isolation, and who owns merging the result back.

## Hard rules
- **Never let two agents write concurrently to the same working tree.** If Head Chef dispatches parallel
  Bosses on the same repo, each gets its own worktree/branch — no exceptions, per the project's
  parallel-vs-serial doctrine (`CLAUDE.md` → "Parallel vs serial").
- Detect existing isolation before creating anything new (per `using-git-worktrees` Step 0) — don't nest
  worktrees or fight a harness that already manages workspace lifecycle.
- Only isolate genuinely **independent** subtasks (reference `dispatching-parallel-agents`). Dependent
  steps stay serial in the main tree — a worktree does not make a dependency parallel-safe.
- Never force-push, reset --hard, or otherwise destructively touch the integration branch without
  explicit owner approval, even when resolving a merge conflict.
- A **non-source hotspot** (event registries, sync manifests, dashboard files, doctor/config) that doesn't
  warrant a full worktree still needs the `forge-lock-guard.cjs acquire`/`release` protocol around its
  dispatch (see `forge-router` Step 4) — lock-guard and worktree isolation are complementary safeguards,
  not either/or.

## When to isolate
Two or more Bosses writing the same repo at once, a large/risky change that must stay reviewable as its own diff, or any Codex write-delegation. Not for single-agent sequential work or a trivial 1-2 file edit. Full text of these four sections: `references/isolation-and-integration.md`.

## Create & integrate
One worktree per independent Boss (`git worktree add <path> -b <branch>`), each Boss stays inside its own; the Lead merges each branch back and resolves conflicts itself.

## Lead is the integration layer
A Boss never merges its own worktree into main while other parallel work is in flight; the Lead verifies the ASSEMBLED result with a real integration check before the parallel build counts as done.

## Cleanup
After a successful merge remove the worktree; never delete a worktree/branch with unmerged, uncommitted or unreviewed work without explicit owner confirmation.
