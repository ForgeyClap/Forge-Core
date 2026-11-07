# forge-data — ETL patterns without dbt

Forge-native (no upstream text). Use when the pipeline is plain Python / SQL / a scheduler (cron, Airflow,
Dagster, Prefect, n8n) instead of dbt. The hard rules of the playbook apply unchanged.

## 1. Land raw first, then transform
- Extract to a raw layer exactly as received (plus `_loaded_at`, `_source`, `_batch_id`); never transform in the
  extractor. A bad transform can then be re-run from raw without hitting the source again.
- Staging types, renames and dedupes; marts hold business logic. One direction only: raw → staging → mart.

## 2. Idempotent loads
- Every load can run twice with the same result. Use one of: `MERGE`/upsert on a natural or business key,
  delete-then-insert of the batch partition inside one transaction, or write to a temp table and swap.
- Never plain `INSERT` of a batch that can be retried. Prove it: run the job twice, row counts and checksums equal.

## 3. Incremental with a watermark
- Store the high watermark (max `updated_at` or source cursor) in a state table, advanced only after the load
  commits. Re-read a small overlap window (for example the last hour) to catch late-arriving rows; the upsert
  absorbs the overlap.
- Deletes at the source: soft-delete flags, a periodic full reconcile of keys, or change-data-capture. Say which.
- Keep a documented backfill path (a date range parameter) that uses the same code as the daily run.

## 4. Schema contracts and drift
- Validate each batch against an explicit schema (pydantic, pandera, JSON Schema, or SQL constraints). Unknown new
  columns: log and ignore or fail, by a written choice. Missing or retyped columns: fail the batch.
- Rows that fail validation go to a dead-letter table with the reason and batch id; the run reports the count.

## 5. Quality checks per run
- Not-null and unique on keys, accepted values on enums, referential checks between tables, row-count change
  within a band versus the previous run, and freshness (newest row younger than the SLA). A failed check stops
  downstream steps and alerts.

## 6. Operations
- Retries with backoff only around the network call, not around the whole job. Timeouts on every external call.
- One run id through logs, dead letters and the state table. Alert on failure and on "no run happened".
- Credentials from env or the scheduler's secret store; never in code, configs in git, or logs. PII masked in
  staging when marts do not need it.

## Proof before "done"
Two consecutive runs with equal counts (idempotency), a watermark that advanced, a forced bad row that landed in
the dead-letter table, and the quality checks' real output.
