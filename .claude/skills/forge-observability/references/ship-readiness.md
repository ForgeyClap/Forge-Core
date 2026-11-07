# Ship-readiness — evidence before handoff

Each line needs real evidence (test output, file, link, screenshot) or an honest not-run with the reason.

- [ ] Resource attributes set: `service.name`, `service.version`, `deployment.environment.name`.
- [ ] Exporter configured only via `OTEL_*` env vars; `.env.example` lists them with placeholders.
- [ ] In-memory exporter tests pass (trace shape, propagation, log correlation, error rule, metric attributes).
- [ ] App starts and serves with the collector unreachable.
- [ ] Denylist grep clean; logger redaction configured; error-tracking scrubbing on, send-default-PII off.
- [ ] One exception record per failure (no duplicate logging across layers).
- [ ] Background jobs and queue consumers carry context (link or extracted parent).
- [ ] Error tracking tagged with release and environment; test event seen (or not-run with reason).
- [ ] Sampling and retention choices written down and approved by the owner when they cost money.
- [ ] Alerts (if any) point at a runbook and were triggered once on a non-production target.
- [ ] Runbook exists for the service: metadata (last verified, owner), quick checklist, nine sections, a prerequisite /
      expected / if-fails line per command, dry-run counts before destructive steps (`runbooks.md`).
