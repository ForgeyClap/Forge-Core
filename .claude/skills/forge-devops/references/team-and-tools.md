# Team and tools

## Team
- Lead: `build-boss` for Dockerfiles, workflows and deploy scripts.
- `architect` for environment layout, rollout strategy and IaC structure (L3).
- `security-boss` / `security-reviewer` for CI permissions, secrets handling, supply-chain pinning and IaC exposure.
- `verify-boss` checks every done-claim against real output (build log, run URL, plan output).
- `docs-boss` writes the runbook (deploy, rollback, secrets rotation) when the owner wants one.

## Related Forge skills
- `forge-observability` — logs, traces, metrics, error tracking for what you deploy.
- `forge-guardian` — auto-rollback, canary and circuit-breaker design.
- `forge-migration` — schema and legacy migrations that ride on the pipeline.
- `ship-readiness` — advisory pre-deploy checklist.
- `forge-worktrees` — when several agents edit one repo.

## Tools (opt-in, project-local)
- Docker / Docker Compose, BuildKit (`docker buildx`).
- actionlint for workflow linting; Dependabot config for action and image updates.
- Wrangler, Vercel CLI: as pinned dev dependencies in the project, never a global install without the owner.
- Terraform, tflint, checkov or tfsec.
Missing tools are reported as not-run; installing one is a visible step, project-local by default.

## MCP
No vendor MCP server (Cloudflare, Vercel, cloud providers) is enabled by this playbook. Adding one goes through
`forge-mcp-clients` (opt-in, least-privilege) and the owner.
