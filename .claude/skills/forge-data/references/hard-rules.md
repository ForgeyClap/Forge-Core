# forge-data — hard rules (full text)

## Hard rules
- **Schema contracts at every boundary.** Source and model outputs declare an explicit, enforced schema (dbt model `contracts: enforced`, or an explicit column/type check on load). A schema-drift upstream fails the run **loudly** — never silently coerces or drops columns.
- **Idempotent + incremental.** A rerun produces the same result — no duplicated rows. Incremental loads use a stable unique key (`merge`/`upsert`) and a watermark/high-water-mark with a look-back window to handle late-arriving data; `append`-only without a dedupe key is banned. Backfills are explicit, bounded, and stated (date range / partition), never an unbounded full-table rewrite by accident.
- **Data-quality tests are part of "done".** Not-null / unique / accepted-values / referential (`relationships`) tests on key columns, plus a freshness check and a row-count/volume sanity check. A pipeline with zero tests is not shippable.
- **Lineage is documented.** The DAG / column-level lineage is generated or written down (dbt docs / a lineage diagram). No orphan models, no undocumented hop that only lives in someone's head.
- **No PII leakage.** PII is classified up front; masked, hashed, or tokenized where it lands; never written to logs, never committed to the repo, and access-scoped in the warehouse. Minimize what you collect and keep.
- **Dead-letter for validation failures.** Records that fail validation go to a dead-letter table or file with the original data, the error, and a timestamp — never silently dropped.
- **Reproducible runs.** Warehouse/profile credentials in env (never in `profiles.yml` or committed), dependencies pinned, SQL/seeds versioned in git, transformations deterministic (no `now()`-driven nondeterminism baked into stored results without a reason). The same code + same input → the same table.
