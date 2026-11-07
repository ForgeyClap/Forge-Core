# Rollout thresholds, error budget and feature flags

Adapted in Forge words from addyosmani/agent-skills `shipping-and-launch` and `ci-cd-and-automation` (MIT, (c) 2025
Addy Osmani). The numbers are starting defaults, not laws: write the project's own numbers into the rollback triggers
(`ship-readiness` → "Deploy phases") **before** the deploy starts. Every step that sends traffic to production is an
owner decision; an agent prepares the plan, watches, and reports.

## One rollout path
1. `ship-readiness` pre-deploy: checklist green, rollback triggers written with real numbers.
2. This file: the stage plan, the thresholds per stage, the error-budget gate, the flag plan.
3. `canary-watch.md`: the read-only watch after each stage.
4. `.claude/skills/forge-observability/references/runbooks.md`: when a trigger fires, the runbook and the SEV table take over.

## Stage plan (each arrow is an owner go/no-go)
1. Staging or preview: full suite plus a manual smoke test of the critical flows.
2. Production with the flag **off**: deploy health check green, no new error types.
3. Flag on for the team only: use it for real, one monitoring window (often a day).
4. Canary: flag on for a small share (about 5 %), compare canary against baseline over a window of a day or two.
5. Gradual: about 25 %, 50 %, 100 %, the same watch at every step; going back one step is always allowed.
6. Full: watch for a week, then clean up the flag.
A static site or a tiny service without flags collapses this to: preview → production → first-hour checks. Say which
path the project uses; do not pretend a stage ran.

## Decision thresholds per stage
| signal | advance | hold and investigate | roll back |
|---|---|---|---|
| error rate | within 10 % of baseline | 10 % to 100 % above baseline | more than 2x baseline |
| p95 latency | within 20 % of baseline | 20 % to 50 % above | more than 50 % above |
| client-side errors | no new error types | new errors in under 0.1 % of sessions | new errors in over 0.1 % of sessions |
| business signal (sign-ups, checkouts) | flat or better | drop under 5 % (may be noise) | drop over 5 % |
| error-budget burn | at or below the normal pace | faster than normal (hold, even when the other rows are green) | budget gone |

Roll back at once, without waiting for the table, on: corrupted or lost data, a security hole, or a spike of real user
reports. A signal that returns **no data** is a hold, never an advance (a renamed metric looks like a perfect canary).

## Error-budget release gate
The error budget is the share of requests (or minutes) the service objective allows to fail. Use it as the gate, not a
debate:
| budget left | what may ship |
|---|---|
| more than 20 % | normal pace, close watch |
| 0 % to 20 % | slow rollouts only, no high-risk change |
| exhausted | feature freeze; only reliability work ships |
| reset | normal pace again, with the fix that recovered it baked in |
No objective defined yet: write that down as a gap and use the thresholds table alone. Never invent an objective number
to make the gate look filled.

## Feature-flag lifecycle
1. Deploy with the flag off (code in production, inactive).
2. On for the team, then a canary share, then gradual steps, watching at each one.
3. Remove the flag and the dead code path soon after full rollout (aim for about two weeks).
Rules: every flag has an **owner and an expiry date** written where the flag is defined; no nested flags (combinations
explode); CI tests both states, on and off; turning a flag off is the fastest rollback, so the off-switch is tested
before the canary starts. A flag platform account or a paid plan is an owner decision.

## Rollback plan (written before the rollout)
- Triggers: the numbers from the table, filled in.
- Steps, fastest first: flag off (about a minute) → redeploy the previous artifact (minutes) → database undo (longest,
  only with a tested script). The redeploy uses the artifact that already ran, not a fresh build.
- What it does **not** restore: data written by the new version, sent mails or messages, connected resources.
- Verify after rollback: health check, error rate back at baseline, the critical flow by hand.
- Who decides and who runs it: the owner decides; the Lead prepares the exact command. A revert commit or a redeploy is
  a push or deploy and stays owner-gated.

## Rationalisations to reject
| claim | reality |
|---|---|
| "It worked on staging" | production has other data, traffic and edge cases; watch after deploy |
| "This change is too small for a flag" | every change benefits from an off-switch |
| "The error rate looks fine, keep going" | check the burn rate; faster than normal is a hold |
| "Rolling back looks bad" | shipping something broken looks worse |
| "Friday afternoon, ship it" | nobody watches the first hour; wait |
