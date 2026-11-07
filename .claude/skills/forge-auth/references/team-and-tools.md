# forge-auth — team, skills, commands, MCP

## Team (conditional)
Lead: `build-boss` (own auth code) or `integration-boss` (hosted provider). Required reviewer: `security-boss`
(authorization model, token handling, negative tests). Support: `database-reviewer` (RLS and session tables),
`silent-failure-hunter` (auth errors swallowed into "logged out" or, worse, "allowed"). Recommended:
`codex-reviewer` adversarial review with a specific focus (for example "IDOR on /api/orders" or "JWT verification")
before release; auth is a review area in the owner's Codex policy.

## Skills / commands
- `forge-database` for RLS and tenant columns; `forge-api` for route contracts and rate limits; `forge-mobile`
  for on-device token storage; `forge-security-review` (when installed) or `security-review` for the final pass.
- `test-driven-development`: write the negative authorization tests first.
- Provider docs via Context7 or official docs for the installed SDK version.

## MCP and tools
- Provider MCP servers or CLIs (Supabase, Clerk, Auth0) are opt-in via `forge-mcp-clients`, least privilege,
  development instance first; never a production secret key in an MCP config.
- Creating OAuth apps, production keys, or sending real verification emails/SMS is owner-gated.
