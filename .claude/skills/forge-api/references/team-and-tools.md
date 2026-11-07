# forge-api — team, skills, commands, MCP

## Team (conditional)
Lead: `architect` (owns the contract + resource model). Implementation: **`integration-boss`** (service wiring, external calls, retries/timeouts) or **`build-boss`** (in-app API tier). Security: **`security-boss`** / `security-reviewer` (authN/authZ, token handling, tenant isolation — required review for anything with auth). Data: `database-reviewer` (schema, migrations, the idempotency store). Tests: **`test-boss`** (contract + integration tests). Support: `silent-failure-hunter` (an endpoint that returns `200` on a partial failure), `python-reviewer` / `typescript-reviewer`. Docs: `docs-boss` (reference generated from the spec). Optional advisor: `codex-reviewer` (Codex on the auth + validation + idempotency paths).

## Skills / commands / MCP
Framework + spec docs via Context7 / vendor docs for exact routing, middleware, and validation APIs; `/test-coverage` for the test gate. Defer money endpoints to `forge-payments`, external-service wiring to `forge-integration`. **Opt-in dependency:** automated contract-conformance tooling is stack-specific — e.g. Schemathesis / Dredd (spec-driven fuzzing), Pact (consumer-driven contracts), or `supertest`/`pytest` for handwritten contract tests. Forge writes the tests; *running* them needs that runtime installed — mark it opt-in and report whether it actually ran.
