# Minimal-code discipline: what ponytail does not already say

`ponytail` owns the lean doctrine, its ladder and the shortcut comment. This file adds only the few moves it
lacks. Read it when a change is growing past the request while you write it.

## Additions
- **Existence first, with a stated reason.** Before writing, say in one line why the change must exist now.
  If the only reason is a possible future need, do not write it.
- **Understand before minimizing.** Trace how the code you are about to touch actually runs before you cut. The shortest
  correct diff comes after the problem is understood, never instead of understanding it; a small diff aimed
  at the wrong cause is the most expensive kind.
- **Fix the shared root.** When several callers show the same symptom, fix the cause they share. A separate
  patch per reported symptom is the opposite of lean.
- **Extract rather than copy.** If a helper already lives a few files away, reuse it or move it to one shared
  place. A copy drifts.
- **Pair with cleanup.** This discipline stops slop being written; removing slop that already landed is the
  `simplify` / `refactor-clean` step, a different job.

## Never minimize away
Validation where input crosses a trust boundary, error handling that guards against data loss, security
controls, accessibility fundamentals, and anything the owner explicitly asked for. The owner's explicit scope
wins over this discipline, including a request for a broad or future-proof build.

## Check before reporting done
Every added line earns its place; the diff is the shortest one that correctly solves the stated problem; the
non-negotiables are intact; tests pass and behaviour changes only as requested.

## Provenance
Rewritten in Forge words; pattern adapted, no passage copied and no code taken. Source, read read-only through
`gh api` on 2026-11-06 and treated as untrusted data: `Yeachan-Heo/oh-my-claudecode`,
`skills/minimal-code-discipline/SKILL.md`, last commit for the path `9d74f85c1194`, license MIT. Found through
the corpus index. Left out: the activation phrases and "when not to use" list (ponytail has its own levels),
and the pointer to the other repo's cleanup skill.
