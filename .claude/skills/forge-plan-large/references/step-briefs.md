# Blueprint: step briefs, review gate, mutation protocol

Read this when the map is clear (no open tickets, no fog) and you write `docs/plans/<slug>/BLUEPRINT.md`.

## BLUEPRINT.md header

```markdown
# Blueprint: <effort name>
Source map: MAP.md (clear on <YYYY-MM-DD>) · Steps: <n> · Waves: <n>
Invariants (checked after every step):
- <for example: the full test suite exits 0>
- <for example: no file under src/core imports src/plugins>

| Step | Title | Wave | Depends on | Route | Owner |
|---|---|---|---|---|---|
| S1 | Plugin interface | 1 | none | deep (opus/xhigh) | Build Boss |
| S2 | Anthropic plugin | 2 | S1 | build (opus/medium) | Build Boss |
| S3 | OpenAI plugin | 2 | S1 | build (opus/medium) | Build Boss |
| S4 | Remove old provider code | 3 | S2, S3 | build (opus/medium) | Build Boss |
```

## Step brief (one per step, self-contained)

```markdown
## S<n>: <title>
Status: planned | running | done | skipped | abandoned
Wave: <n> · Depends on: <steps or none> · Route: <route> (<model>/<effort>) · Owner: <Boss>

### Context brief
<everything a fresh agent needs: the goal of the whole effort in one line, the decisions from the map that matter here
(linked), the current state of the code it touches, and the names of files and functions involved. No "as discussed".>

### Owned files
- <path> — <purpose>
Read only: <paths>

### Tasks
1. <concrete action>
2. <concrete action>

### Verification
- `<exact command>` — expected: <result>

### Exit criteria
- [ ] <observable outcome>
- [ ] every invariant still holds

### Rollback
<how to undo this step without touching others, for example: revert the step's commit; the old path stays until S4>
```

Size: one work package each (one Boss, one review). 3 to 12 steps is the normal range. Fewer than 3 means you did not need a
blueprint; more than 12 means the steps are too small, or the effort should be split into two maps.

## Parallel steps
Two steps may share a wave only when:
- their owned file sets are disjoint, and
- neither reads an output the other produces (a file, a type, a migration, a generated index).

A shared file goes to one earlier step (often a small contract step), or to the integrator. Card and wave rules:
`forge-team-orchestration`.

## Adversarial review checklist (Review Boss, deep route, read-only)
The reviewer tries to break the plan, not to approve it. A critical finding blocks the first step.
1. **Coverage:** does every decision in the map's Decisions so far land in some step? Is anything in the destination left
   unbuilt?
2. **Cold start:** could a fresh agent run each step from its brief alone? Mark every hidden reference ("the approach above",
   "as decided").
3. **Dependencies:** does every edge reflect a real consumed output? Are there cycles, or habit edges that cost parallelism?
4. **Shared files:** does any file appear under owned files in two steps of one wave?
5. **Verification:** does every step have a command that a verifier can re-run, plus exit criteria that are observable?
6. **Rollback:** can each step be undone alone? Is any step destructive, or a migration without a reverse?
7. **Routes:** is risky work (auth, payments, data, migrations, production) on the deep route, and nothing on Fable up front?
8. **Gates:** does any step need push, deploy, spend, credentials, outbound or production? If so, mark it owner-gated and put it
   last.
9. **Invariants:** are they checkable by a command, and do they hold at every step boundary (not only at the end)?

## Anti-patterns (Forge-native list)
- **Big bang:** one step that changes everything, so nothing can merge or roll back alone.
- **Plan as diary:** briefs that say "continue the work" instead of naming files and commands.
- **Phantom parallelism:** steps marked parallel that edit the same file or registry.
- **Test at the end:** verification only in the last step, so early steps are merged unproven.
- **Gate in the middle:** an owner-gated step early in the chain that idles every later step.
- **Decision smuggling:** a step that quietly makes a choice the map never decided. Send it back to the map as a ticket.
- **Orphan cleanup:** old code stays because no step owns its removal.

## Mutation protocol
Plans change. Every change is one dated line under MAP.md → Plan changes, and the step's own `Status` reflects it.

| Mutation | When | Rule |
|---|---|---|
| split | A step turns out to be two packages | Keep the id for the first part, add `S<n>b`, update dependents' `Depends on`. |
| insert | Missing work found | New id at the end of the numbering, placed in the right wave; re-check shared files in that wave. |
| skip | The step is no longer needed | `Status: skipped` with the reason; dependents are re-checked. |
| reorder | A dependency was wrong | Change waves and `Depends on`, never ids; re-run checklist items 3 and 4. |
| abandon | The approach failed | `Status: abandoned`, the step stays visible, a new step or a new map ticket records the replacement. |

After any mutation that touches waves or shared files, run the review checklist items 3, 4 and 8 again before the next wave
starts.
