---
name: forge-data
description: "Playbook for data pipelines: ETL/ELT, dbt (gebruik bij een datapijplijn)."
# A10 original description (listing budget): "Playbook for data pipelines: ETL/ELT, dbt, warehouses, incremental loads, data quality (gebruik bij een datapijplijn)."
# W2-BUDGET original description (listing budget): "Playbook for data pipelines: ETL/ELT, dbt, data quality (gebruik bij een datapijplijn)."
---

# Forge playbook — Data engineering / ETL / dbt

## When to use
- Use for: data engineering, ETL and dbt pipelines that must be trustworthy and repeatable.

**Do not duplicate ECC skills — defer to:** `systematic-debugging` (pipeline failures), `/test-coverage` (transform test coverage), `learn-codebase` / `forge-deeplearn` (prime an existing warehouse before touching it). This file is orchestration only.

A data pipeline's job is to be **trustworthy and repeatable**, not just to "run once". The failure mode here is silent: a load that half-succeeds, a duplicate on retry, or a schema change upstream that quietly corrupts a downstream mart while every job still shows green. Treat the warehouse as the product.

## Hard rules
- **Schema contracts at every boundary.**
- **Idempotent + incremental.**
- **Data-quality tests are part of "done".**
- **Lineage is documented.**
- **No PII leakage.**
- **Dead-letter for validation failures.**
- **Reproducible runs.**

Full text of every rule: `references/hard-rules.md`.

## Team
Lead: `build-boss` (or `integration-boss` when the pipeline wires external sources). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

**dbt projects:** read `references/dbt.md` before touching models — read-before-write, DRY layering, `dbt show` validation, unit tests vs data tests, house-style docs one folder per pass, and failed-run triage (infrastructure / code / data). Never edit a failing test green without knowing why it fails.

**Plain Python / SQL / scheduler pipelines (no dbt):** read `references/etl-patterns.md` — raw-first layering, idempotent loads, watermarks and backfills, schema drift and dead letters, per-run quality checks.

## Fan-out & flow
L2 for a single source→mart pipeline; L3 for a multi-source warehouse with several transformation layers.
**Parallel:** independent source extractors ∥ independent staging models ∥ dq-test authoring (once the target schema/contract is fixed).
**Serial:** source contract → extract/load (idempotent + incremental) → staging (typed, deduped) → transform/marts → data-quality tests → lineage/docs → freshness/monitoring. The contract is fixed **before** anyone parallelizes, so slices can't disagree on shape.

## Domain gates
Schema contracts declared + enforced at each boundary; a rerun proven to produce no duplicates (idempotency evidence); incremental key + watermark in place; dq tests (not-null/unique/accepted-values/relationships) pass with real output; freshness + volume/row-count check present; lineage/DAG documented with no orphan models; PII classified, masked/scoped, and absent from logs and git; run reproducible with pinned deps + versioned SQL + env-only credentials; raw / staging / mart layers separated.

## Ship-readiness
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: warehouse/profile credentials in env, never in `profiles.yml` or git.
- Approval / safety: PII classified, masked/hashed/scoped and absent from logs and git; `security-boss` review recommended whenever real personal data is in scope.
- Honest failure: scaffolded but not run against a real or DuckDB target: say so; never claim idempotency or green tests that were not executed.
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
- `references/etl-patterns.md` — ETL without dbt: idempotent loads, watermarks, drift, dead letters (Forge-native).
- `references/polars.md` — Polars or a pandas migration: lazy-first, version pin, sinks, write safety (adapted from sickn33/agentic-awesome-skills, MIT).
- `references/dbt.md` — dbt practice (adapted from dbt-labs/dbt-agent-skills, Apache-2.0; notice in `LICENSE.txt`).
