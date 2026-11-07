---
name: forge-verify
description: "Use after every work package (is dit echt gedaan): check the done-claim."
# W2-BUDGET original description (listing budget): "Use after every work package (is dit echt gedaan, verify the claim): check a done-claim against events."
---

# forge-verify — the verify-loop

**Self-improvement substrate (wp-skill-evals):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction (an owner fix, a false assumption caught, a preference stated), append it to
`learnings.md` with a date and real evidence — never invent a lesson that didn't happen.

Closes the honesty gap between "an agent said it's done" and "the recorded events actually show it's
done." Never trusts a completion claim on its own.

## When to use (MANDATORY)

- **After each agent/work-package completes** in a `/forge` run — before the Lead treats that agent's
  output as final.
- **At the end of the run**, before writing the final report — a last honest check across every agent
  and every ticket the run touched.
- Whenever the owner asks "did that agent actually finish?" or "check the tickets are really closed."

## How to run

```
node .claude/forge-bin/forge-verify.cjs <run_id>                      # report only, exit 0/1
node .claude/forge-bin/forge-verify.cjs <run_id> --enforce            # report + send mismatches back
node .claude/forge-bin/forge-verify.cjs <run_id> --json               # full machine-readable result
node .claude/forge-bin/forge-verify.cjs <run_id> --root <projectRoot> # target a different project root
```

Exit code: 0 when there are no mismatches and no open tickets for the run; 1 otherwise — safe to gate a
hook/CI step on it.

## What it checks

Reconstructs per-agent task state from `<run>/events.jsonl` using forge-verify.cjs's own `BACKBONE` +
`taskStatus()` — the sole, canonical classification (this used to also mirror the retired
per-project Control Center's `forge-dashboard/app.js`, which was removed along with the rest of that
dashboard): structural milestone events (`run_started`,
`agent_completed`, `lead_review_completed`, …) are never counted as a "task"; every other event
attributed to an agent is a task, and a task is "done" only when its status genuinely resolves to done.
An agent "claims completed" once it has logged `agent_completed` or `subagent_completed`. A **mismatch**
is an agent that claims completed while some of its own tasks are still open, running, or failed.

It also checks the ticket store (`forge-bin/forge-store.cjs`, `forge-tickets/`): any ticket whose
`run_id` matches this run and whose `status` isn't `done` is reported **open**.

## What `--enforce` does

For every mismatch, logs three already-registered events (no invented event_type names — see
`forge-dashboard/log-event.cjs` `KNOWN_EVENT_TYPES`):
`lead_review_completed` (the review finding) → `rework_task_created` (what's wrong + the required fix) →
`rework_assigned` (back to the same agent).

For every open ticket belonging to the run: re-stores it with `status: 'open'` **unchanged** plus a note,
and logs `ticket_updated`.

The task is now visibly back with the agent. **The Lead must re-dispatch that agent** with the open
items listed in the rework event before treating the work as done again.

## Claim mode — grade ONE done-claim

The run check above asks "do the events agree with the claim". Claim mode asks the harder question: does
the artifact itself prove it? Verify Boss uses it per work package.

```
node .claude/forge-bin/forge-verify.cjs --claim <packet.json|-> --strip          # what you may read
node .claude/forge-bin/forge-verify.cjs --claim <packet.json|-> [--runner <out.txt>] [--json]
```

1. **Read only the stripped packet.** `--strip` keeps the artifact, the acceptance criteria, the runner
   output and the claimed test names, and names every dropped field. The builder's story is not evidence.
2. **Try to break it before you judge.** Name one property the result implies and look for a small
   counterexample (an empty input, a boundary, the other platform). Record it as `judgement.break_attempt`.
3. **Judge every criterion** (`met` with evidence, `unmet`, or `unknown`), or abstain with a reason.

| Verdict | Gate (`wp_verified.verdict`) | Exit | Counts as pass |
|---|---|---|---|
| PROVEN | PASS | 0 | yes |
| NOT-PROVEN | FAIL (one escalation follows) | 1 | no |
| PARTLY-PROVEN | NEEDS_MORE_EVIDENCE | 2 | no |
| NO-CONFIDENT-RESULT | NEEDS_OWNER | 2 | no |

Abstaining is allowed and is not a failure: it neither closes the work package nor triggers an
escalation. NOT-PROVEN comes automatically when the runner reports a failure, a claimed test never ran
(absent from the runner output), a done-claim hedges ("should work", "probably", "zou moeten werken",
"waarschijnlijk"), a criterion is unmet, or your break attempt found a counterexample. Packet and
judgement shapes, runner formats and an example: `references/claim-verdict.md`.

Claims that code "is wired" or "runs at X": see `references/reachability.md`.

## Honesty rule

`forge-verify` **never marks anything done**. It only reopens or flags — closing a task or ticket is
always a real agent/human action, verified again by the next `forge-verify` pass. The dashboard shows
the exact same mismatch (⚠) using the same `taskStatus()` logic, so the tool and the dashboard never
disagree about what "done" means.
