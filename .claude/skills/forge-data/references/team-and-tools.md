# forge-data — team, skills, commands, MCP

## Team
Lead: `build-boss` (or `integration-boss` when the pipeline wires external sources). Specialists: `data-scientist` (data profiling, distribution/anomaly checks, dq-test design), `database-reviewer` (SQL correctness, schema, transaction/merge semantics, index/partition strategy), `python-reviewer` (only if orchestration is Python — Airflow/Dagster/custom loaders), `silent-failure-hunter` (partial loads and empty results that look like clean success — the signature failure of this domain). Optional advisor: `security-boss` / `security-reviewer` for the PII-classification + masking review (recommended whenever real personal data is in scope).

## Skills / commands / MCP
`systematic-debugging` and `/test-coverage` are always in scope. **Opt-in deps (honest):** dbt, a live warehouse (Snowflake/BigQuery/Redshift/Postgres), and an orchestrator (Airflow/Dagster) are **owner-provided** — Forge can scaffold models, write transforms, and design tests, but *running* them and proving idempotency needs that environment (or a local **DuckDB**/Postgres for a runnable, credential-free proof). Use Context7 / vendor docs for exact dbt + warehouse SQL dialect behavior. A warehouse/DB MCP may be available via `ToolSearch` — use it read-first. `claude-api` only if an LLM step is embedded in the pipeline.
