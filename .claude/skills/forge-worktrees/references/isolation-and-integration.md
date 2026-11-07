# forge-worktrees — when to isolate, create & integrate, cleanup (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps the hard rules and a one-paragraph summary per section; this file keeps the complete original wording.

## When to isolate
- Head Chef is running two or more Bosses concurrently against the same repo (e.g. Build Boss + UI Boss
  on different modules of the same app in the same run).
- A large/risky change (major refactor, dependency upgrade) that should stay reviewable as its own diff
  before merging into the main line.
- Codex write-delegation (`/codex:rescue` or any `--write` task) — per `CODEX_GLOBAL_POLICY.md` (an owner-level policy in `~/.claude` when present; on an install without it, the defaults stated in this skill apply — read-only, never a blocker), Codex
  runs on a **separate worktree/branch**, never concurrently with Claude in the same tree.

Do NOT isolate: single-agent sequential work, trivial 1-2 file edits, or tasks with no real parallelism
(isolation overhead without benefit).

## Create & integrate
1. **Create.** Detect existing isolation first; otherwise create a worktree per independent Boss/agent
   (`git worktree add <path> -b <branch>`), scoped to that Boss's exact work package.
2. **Dispatch.** Each Boss works only inside its own worktree, on files relevant to its own package —
   commits stay scoped, no unrelated files bundled in.
3. **Integrate.** The Lead (Head Chef, or whichever Boss owns the integration for that run) merges each
   worktree's branch back into the target branch, resolving any conflicts itself rather than leaving them
   for the next agent.

## Lead is the integration layer
Per the project's standing rule, the agent coordinating parallel work is the one responsible for merging
it back cleanly — an individual Boss does not merge its own worktree into main unilaterally when other
parallel work is still in flight. The Lead verifies the assembled result (a real integration check, not
just "each worktree's own tests passed") before treating the parallel build as done.

## Cleanup
After a successful merge: remove the worktree (`git worktree remove <path>`) and delete the now-merged
branch if the project's convention is to prune merged branches. Never delete a worktree/branch that still
has unmerged, uncommitted, or unreviewed work without explicit owner confirmation.
