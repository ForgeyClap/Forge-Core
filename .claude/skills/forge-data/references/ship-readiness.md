# forge-data — ship-readiness (full text)

## Ship-readiness
Idempotent rerun demonstrated (evidence: two consecutive runs, identical row counts / no dupes on the unique key); dq-test run output attached (green, with the actual counts); freshness check shown; lineage doc/DAG present; `profiles.yml`/connection has **no** committed secret and reads from env; PII handling (mask/hash/scope) documented; backfill scope stated and bounded. The `ship-readiness` checklist is advisory; optionally run `codex-reviewer` (Codex) on the load/merge + transformation SQL for high-value pipelines — recommended, not a blocker. If the pipeline was only scaffolded and **not run** against a real/DuckDB target, say so plainly — do not claim idempotency or green tests that were never executed.
