# Ship-readiness — evidence before handoff

Each line needs real evidence (output, file, URL) or an honest not-run with the reason.

- [ ] Image builds; size and non-root user reported; base image pinned; `.dockerignore` present.
- [ ] Compose stack starts with healthy dependencies; no default passwords; `.env.example` has placeholders only.
- [ ] CI workflow ran on a branch or PR: run URL recorded, all jobs green.
- [ ] Every workflow job has explicit `permissions` and a timeout; every action pinned to a SHA.
- [ ] No secret literal in the diff (grep for key, token, password, secret and long base64-like strings).
- [ ] Deploy validated without going live: dry-run, preview URL or `terraform plan` output attached.
- [ ] Production environment protected (required reviewers or platform approval).
- [ ] Deep readiness check exists and was hit on preview or staging.
- [ ] Rollback step written: command, owner, what it restores, what it does not.
- [ ] Migrations backward-compatible for one release.
- [ ] Owner decision recorded for every live action (deploy, push, apply, DNS, secret write).
- [ ] Logs, traces and alerts in place for the new service (`forge-observability`), or marked as a follow-up.
- [ ] Rollback triggers written with real numbers before the deploy (`.claude/skills/ship-readiness/references/deploy-phases.md`).
- [ ] Stage plan and thresholds chosen (`rollout-thresholds.md`); every flag has an owner and an expiry.
- [ ] Canary report attached for each production stage (`canary-watch.md`), with a baseline or "no baseline" said.
- [ ] Terraform: the response contract is present and the applied plan file is the reviewed one.
