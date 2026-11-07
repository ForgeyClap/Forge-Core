# forge-database — migration safety (Postgres first)

Adapted from affaan-m/ecc `skills/database-migrations` (MIT) and supabase/agent-skills `schema-constraints` (MIT),
rewritten and extended by Forge. Provenance and licenses: the comment block in `../SKILL.md` and `../LICENSE`.

## Principles
1. Every schema change is a migration file under version control; production is never edited by hand.
2. Production migrations go forward only. A "rollback" is a new forward migration you have written in advance.
3. DDL and DML are separate migrations: a backfill must never hold a schema lock.
4. Test on a copy with production-like row counts. A change that takes 5 ms on 100 rows can lock 10M rows for minutes.
5. Once a migration has run anywhere shared, it is immutable; edits cause drift between environments.

## Owner gate (Forge)
Before any of these, stop and get explicit owner approval given right before the action, a verified backup
(restore tested, or at least listed with its timestamp), and a written rollback plan:
- dropping a table, column, schema, or an index a constraint depends on;
- `prisma migrate reset`, `prisma db push --force-reset`, `prisma db push --accept-data-loss`;
- `drizzle-kit push` against anything but a throwaway local database;
- a column type change that rewrites the table, a `TRUNCATE`, an unbounded `UPDATE`/`DELETE`;
- any migration run against production or a shared staging database.

Never invent consent, reuse an earlier unrelated "yes", or hide the agent from a tool's own safety check.

## Checklist per migration
- [ ] Up and down written, or marked irreversible with the reason.
- [ ] `SET lock_timeout = '5s';` (or the team's value) at the top, so a blocked DDL fails fast instead of queueing every query behind it.
- [ ] New columns are nullable or have a constant default.
- [ ] Indexes on existing tables use `CREATE INDEX CONCURRENTLY` (own migration, outside a transaction).
- [ ] Constraints on existing tables use `NOT VALID` plus a separate `VALIDATE CONSTRAINT`.
- [ ] No backfill inside the schema migration.
- [ ] Ran on a fresh database and on a realistic copy; duration and locks noted.
- [ ] Rollback plan written down.

## Postgres patterns
**Add a column.** Nullable: metadata-only. Constant default (PG 11+): metadata-only. Volatile default
(`now()`, `gen_random_uuid()`) or `NOT NULL` without default: full rewrite under an exclusive lock.

**Make a column NOT NULL on a big table.**
```sql
ALTER TABLE orders ADD CONSTRAINT orders_status_nn CHECK (status IS NOT NULL) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_nn;  -- weaker lock; scans without blocking writes
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;       -- PG 12+ skips the scan thanks to the valid check
ALTER TABLE orders DROP CONSTRAINT orders_status_nn;
```

**Foreign keys and checks on existing data.** `ADD CONSTRAINT ... NOT VALID` (new rows are checked at once), then
`VALIDATE CONSTRAINT` in a later step. Index the referencing column (see `schema-design.md`).

**Idempotent constraint creation.** Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. Guard with a `DO` block that
looks the constraint up in `pg_constraint` by `conname` AND `conrelid = 'schema.table'::regclass` (constraint
names are only unique per table, so a name-only check can match the wrong table).

**Index without downtime.** `CREATE INDEX CONCURRENTLY idx ON t (col);` cannot run in a transaction block: give
it its own migration and confirm the tool does not wrap it in one. A failed concurrent build leaves an
`INVALID` index: `DROP INDEX CONCURRENTLY` it and retry.

**Rename a column.** Never in place on a live app. Add the new column → app writes both → backfill → app reads
the new one → stop writing the old one → drop it in a later release.

**Drop a column.** Remove every code reference and deploy first; drop in a later migration.

**Large backfill.** Batches of about 1k–10k rows, each its own transaction, keyed by primary-key range or
`FOR UPDATE SKIP LOCKED`, with a short pause between batches and progress logged; idempotent so it can resume.

## Expand / contract timeline (example)
- Release 1 (expand): add nullable `new_status`; the app writes both columns.
- Job: backfill old rows in batches; verify the counts match.
- Release 2 (migrate): the app reads `new_status` and still writes both.
- Release 3 (contract): the app stops using `status`; a later migration drops it.

## Anti-patterns
| Anti-pattern | Why it fails | Instead |
|---|---|---|
| Manual SQL in production | No audit trail, not repeatable | Migration file |
| Editing a deployed migration | Environments drift | New migration |
| `NOT NULL` without default | Rewrite plus exclusive lock | Nullable → backfill → check → set not null |
| Inline index on a big table | Blocks writes for the whole build | `CONCURRENTLY` |
| Schema and data in one migration | Long transaction, hard rollback | Split them |
| Dropping before removing code | App errors on the missing column | Code first, drop later |
| Migration without `lock_timeout` | Waits behind a long query and blocks everyone | Fail fast, retry |
