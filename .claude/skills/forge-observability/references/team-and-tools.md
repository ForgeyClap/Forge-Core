# Team and tools

## Team
- Lead: `build-boss` for instrumentation and logger changes.
- `architect` for collector topology, sampling strategy and backend choice (L3).
- `security-boss` / `security-reviewer` for the never-log list, PII scrubbing and vendor data residency.
- `test-boss` for the in-memory exporter tests; `verify-boss` checks done-claims against real output.

## Related Forge skills
- `forge-devops` — deploys, CI, containers, Cloudflare/Vercel platform settings.
- `forge-guardian` — acting on metrics (auto-rollback, canary, circuit breakers).
- `forge-debug` — using traces and logs to find a root cause.
- `forge-agent` — tracing and evals for LLM apps.

## Packages and tools (opt-in, project-local)
- OpenTelemetry SDKs and instrumentation packages for the project's language (see `stacks.md`).
- An OpenTelemetry Collector (container) for integration tests.
- The error-tracking SDK the owner chose (Sentry or another).
Missing tools are reported as not-run; adding a dependency is a visible, project-local step.

## MCP
No vendor MCP server (Sentry, Grafana, Datadog) is enabled by this playbook. Adding one goes through
`forge-mcp-clients` (opt-in, least-privilege, read-only by default) and the owner.
