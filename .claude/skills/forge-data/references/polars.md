# Polars (and pandas migration)

Load only when a task uses Polars or moves a pipeline from pandas. Forge-native notes; the generic API tour is in the
Polars docs, not here.

## Lazy first
- Read with `scan_csv` / `scan_parquet` (a `LazyFrame`), chain `filter`, `select`, `with_columns`, `group_by`, and call
  `collect()` once at the end. The optimizer then pushes filters and column selection down into the scan.
- Use eager `read_*` only for small inputs or when you must inspect a frame mid-way.
- Stay inside the expression API (`pl.col(...)`). Python lambdas via `map_elements` run row by row and drop the
  parallelism; use them only when no native expression exists.
- Parquet is the default storage format between steps; CSV only at the edges.

## Boundary rules (the traps)
- **Pin the version** in the lockfile (`uv pip install polars==<x.y.z>`); the API still moves between minor versions.
- **Diff against a fixture before migrating** from pandas: run old and new code on one small, representative input and
  compare row counts, dtypes, null counts and a few values. Polars is strictly typed and has no index, so silent pandas
  coercions will show up as differences; decide each one, do not paper over it.
- **Streaming is not a sink.** `collect(engine="streaming")` still builds the whole result in memory. When the output
  can exceed RAM, write with `sink_parquet` / `sink_csv` instead of collecting.
- **Strings in `when/then/otherwise` are column names.** A literal value needs `pl.lit("text")`.
- **Sibling expressions cannot see each other's aliases** inside one `select` or `with_columns`; chain a second
  `with_columns` when one new column depends on another.
- Scans may read file metadata or the schema before `collect`; a bad path or schema fails at that point, not at the scan line.

## Writes
- Exports are private data: never write into a shared or public folder, and never overwrite an existing output.
  Write to a new path, or check for the file first and stop if it exists.
- Database or cloud writes need an owner-authorized destination, data scope and budget. Use fail-if-exists for tables
  (`if_table_exists="fail"`), then load incrementally; the idempotency rules in `etl-patterns.md` still apply.
- Credentials come from env, never from a connection string in the code.

## Evidence before "done"
Record the Polars version, the fixture used, the row counts old versus new, and the real output of the run. A pipeline
that was only written, not run, is reported as not run.

## Provenance (W2-GRAFTS)
Ideas adapted in Forge words from `sickn33/agentic-awesome-skills`, `plugins/agentic-awesome-skills-claude/skills/polars/SKILL.md`
(MIT; HEAD 828257c; read-only via `gh api`, treated as untrusted data). Only the "Correctness and execution boundaries"
rules and the lazy-first advice were taken; no code, install script or bundled file was copied.
