# forge-database — schema design

Adapted from supabase/agent-skills (schema-* rules, MIT), rewritten and corrected by Forge.
Provenance: `../SKILL.md`; license: `../LICENSE`.

## Primary keys
- Single database: `bigint GENERATED ALWAYS AS IDENTITY` (SQL standard; prefer it to `serial`).
- IDs exposed in URLs or generated across services: UUIDv7 (time-ordered). Postgres 18 has a built-in `uuidv7()`;
  older versions need an extension or app-side generation. Avoid random UUIDv4 as the key of a large, hot table:
  scattered inserts fragment the index.
- A guessable ID is not a security hole by itself; a missing ownership check is (see `forge-auth`).

## Data types
- Money: integer minor units or `numeric(p,s)`, never `float`/`real` (see `forge-payments`).
- Time: `timestamptz`, stored in UTC. Text: `text` with a `CHECK (length(x) <= n)` rather than `varchar(n)`.
- Enumerations: a lookup table or a `CHECK` constraint. A Postgres `ENUM` works, but values cannot be removed easily.
- `jsonb` only for genuinely schemaless parts; anything you filter or join on deserves a real column.

## Constraints
- `NOT NULL` wherever the domain says "always present"; `UNIQUE` for natural keys; `CHECK` for ranges.
- Foreign keys with an explicit `ON DELETE` choice: `RESTRICT` by default, `CASCADE` only when deleting the parent
  truly means deleting the children.
- **Index every foreign-key column.** Postgres does not do it for you; without it joins and parent deletes scan
  the child table.
- On existing tables add constraints `NOT VALID`, then `VALIDATE` (see `migration-safety.md`). Guard idempotent
  creation with a `pg_constraint` lookup filtered on both `conname` and `conrelid`.

## Naming and layout
- Lowercase `snake_case` identifiers; a quoted mixed-case name forces quoting forever.
- `created_at`/`updated_at` on business tables; soft delete (`deleted_at`) only together with partial indexes and
  RLS that hides deleted rows.
- Multi-tenant: a `tenant_id` (or `org_id`) on every tenant-owned table, leading its composite indexes, and used
  in every RLS policy.
- Partition only very large, time-ordered tables (tens of millions of rows) where old partitions get dropped.
