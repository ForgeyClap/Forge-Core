# forge-payments — team, skills, commands, MCP

## Team (conditional)
Lead: `integration-boss` (or `build-boss` if payments are one slice of a larger app). Payment work: **`payment-integration`** specialist. Support: `silent-failure-hunter` (dropped webhooks / swallowed gateway errors look like clean success), `typescript-reviewer` / `python-reviewer` (charge + webhook code), `database-reviewer` (idempotency table, transaction-state audit trail). Optional advisors: `security-reviewer`, `codex-reviewer` (recommended for the charge + webhook paths — payments is a Codex-on-risk trigger).
