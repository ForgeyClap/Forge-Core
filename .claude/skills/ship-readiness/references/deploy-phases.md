# Deploy phases — fill-in template

Structure (pre-deploy, deploy, post-deploy, rollback triggers decided in advance) adapted from
anthropics/knowledge-work-plugins `engineering/skills/deploy-checklist` (Apache-2.0, (c) Anthropic; changed: rewritten in
Forge words, owner gates and evidence column added). First-hour checks adapted from addyosmani/agent-skills
`shipping-and-launch` (MIT, (c) 2025 Addy Osmani). Advisory: a box without evidence stays empty, it is never ticked
on trust. Copy this block into the run notes and fill it in.

```
DEPLOY CHECKLIST  <service or release>  <date>
Prepared by: <Boss>   Production go given by: <owner, when, where>   First-hour watcher: <who>

ROLLBACK TRIGGERS (written before anything ships; numbers from the current baseline)
- error rate above <X> %  (baseline <Y> %)
- p95 latency above <X> ms  (baseline <Y> ms)
- <critical flow, e.g. checkout or login> fails once
- any data-integrity or security finding: roll back at once
- a watched signal returns no data: hold, do not advance
Fastest undo: <flag off | redeploy artifact <id> | migration undo script, tested on <where>>
Not undone by rollback: <data written, mails sent, connected resources>

PRE-DEPLOY                                                   evidence
[ ] CI green on the exact commit being shipped               run URL
[ ] code reviewed, findings resolved or accepted             review report
[ ] no known critical bug in this release                    issue list
[ ] migrations tested, backward-compatible for one release   test output
[ ] feature flags configured, default off, off-switch tested flag + test
[ ] rollback plan and triggers above filled in               this block
[ ] secrets present in the target environment (names only)   env listing
[ ] monitoring and error tracking ready for the new code     forge-observability checklist
[ ] owner approval for this exact deploy recorded            message or event

DEPLOY
[ ] preview or staging deployed and smoke-tested             URL + output
[ ] production deployed by or on the go of the owner         deploy id
[ ] staged rollout per forge-devops rollout-thresholds.md    stage log
[ ] error rate and latency watched during each stage         canary report

POST-DEPLOY (first hour)
[ ] health route answers 200                                 status line
[ ] no new error types in error tracking                     screenshot or query
[ ] latency at baseline                                      numbers
[ ] critical user flow done by hand                          note
[ ] logs arriving and readable                               sample line (redacted)
[ ] rollback confirmed ready                                 flag test or artifact id

AFTER
[ ] changelog or release notes updated                       file
[ ] stakeholder or client note DRAFTED (owner sends)         draft path
[ ] related tickets closed                                   list
```

## Per change type, add
- **Database migration:** backup or snapshot taken and restore tested; destructive steps (drop, tighten a constraint)
  deferred to a later release; a dry-run count before any data fix (`.claude/skills/forge-observability/references/runbooks.md`).
- **Feature flag:** owner and expiry written at the flag; both states tested in CI.
- **Breaking API change:** consumers listed and told in advance (a drafted note, the owner sends); old version kept for
  one release where possible.
- **Static site or small service without flags:** the rollout section collapses to preview → production → first hour;
  say so instead of ticking stages that did not exist.

## Rules
- Triggers are set before the deploy. Thresholds invented after something broke are rationalisation.
- Production deploy, push, tag, publish and DNS are owner actions; this checklist records the go, it never gives it.
- A trigger fires: stop the rollout, report to the owner with the matching numbers, open the runbook. Rolling back is
  the owner's call unless the owner wrote a standing rule for it.
