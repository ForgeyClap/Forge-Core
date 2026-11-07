# forge-database — Postgres query performance

Adapted from supabase/agent-skills `supabase-postgres-best-practices` (query-*, data-*, monitor-* rules, MIT),
rewritten by Forge. Provenance: `../SKILL.md`; license: `../LICENSE`.

## Measure first
- `EXPLAIN (ANALYZE, BUFFERS) <query>` on realistic data. Look for `Seq Scan` on large tables, a large
  `Rows Removed by Filter`, estimated and actual row counts far apart (run `ANALYZE`), and sorts spilling to disk.
  `ANALYZE` executes the query: wrap writes in `BEGIN; ... ROLLBACK;` and never run it on production without the owner gate.
- `pg_stat_statements` ranks queries by `total_exec_time` and `mean_exec_time`; fix the top of that list, not the
  query you guessed.
- Stale statistics and bloat: check that autovacuum keeps up (`pg_stat_user_tables.n_dead_tup`, `last_autoanalyze`).

## Indexes
- **Missing index:** columns in the `WHERE`, `JOIN ... ON` and `ORDER BY` of hot queries.
- **Composite:** equality columns first, then the range or sort column. `(tenant_id, created_at)` serves
  `WHERE tenant_id = $1 ORDER BY created_at DESC`; the reverse order does not.
- **Covering:** `INCLUDE (col)` lets an index-only scan return extra columns without touching the table.
- **Partial:** `WHERE deleted_at IS NULL` or `WHERE status = 'pending'` when queries always filter that way;
  smaller and faster.
- **Types:** B-tree by default; GIN for `jsonb` containment, arrays and full-text (`tsvector`); GiST/SP-GiST for
  ranges and geometry; BRIN for huge append-only, time-ordered tables; HNSW or IVFFlat (pgvector) for embeddings.
- Every index slows writes and costs storage: drop unused ones (`pg_stat_user_indexes.idx_scan = 0` over a long window).

## Access patterns
- **N+1:** one query per row inside a loop. Batch with `WHERE id = ANY($1)`, a join, or the ORM's
  `include`/`with`, and read the generated SQL.
- **Pagination:** keyset (`WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50`) instead
  of a large `OFFSET`, which reads and throws away every skipped row.
- **Batch inserts:** a multi-row `INSERT` or `COPY` instead of one round trip per row.
- **Upsert:** `INSERT ... ON CONFLICT (key) DO UPDATE` instead of a select-then-insert race.
- Select only the columns you need; avoid `SELECT *` on wide tables.

## JSONB and search
- Index `jsonb` with GIN (`jsonb_path_ops` when you only use `@>`); promote hot keys to real columns.
- Full-text: a generated `tsvector` column with a GIN index; `websearch_to_tsquery` for user input.
