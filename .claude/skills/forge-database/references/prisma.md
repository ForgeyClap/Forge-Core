# forge-database — Prisma

Adapted from prisma/skills `prisma-cli` (SKILL.md, references/agent-safety.md, migrate-diff.md, migrate-resolve.md;
MIT) and affaan-m/ecc `database-migrations` (MIT), rewritten by Forge. Provenance: `../SKILL.md`; license: `../LICENSE`.
Commands below are for the developer's local database unless the owner gate says otherwise.

## Version first
Read `package.json` for the installed `prisma` / `@prisma/client` version and use the project's own CLI
(`npx prisma` resolves the local one), never a floating `prisma@latest`. Prisma 7 moved configuration into
`prisma.config.ts` and expects a driver adapter; Prisma 6 and older differ. Check the docs for that exact version.

## Workflow
| Step | Command | Where |
|---|---|---|
| Create + apply a migration from schema changes | `prisma migrate dev --name <name>` | local dev only |
| Write a migration without applying it (custom SQL) | `prisma migrate dev --create-only --name <name>` | local dev |
| Apply pending migrations | `prisma migrate deploy` | CI/CD, staging, production (owner gate for production) |
| See migration state | `prisma migrate status` | anywhere (read-only) |
| Regenerate the client | `prisma generate` | after any schema change |

- Use `--create-only` for what Prisma cannot express: `CREATE INDEX CONCURRENTLY`, `NOT VALID`/`VALIDATE`,
  RLS policies, triggers, batched backfills. Read and edit the SQL before applying.
- Read every generated migration: a renamed field in the schema becomes `DROP COLUMN` + `ADD COLUMN` (data loss)
  unless you rewrite it as a rename or an expand/contract sequence.
- `db push` syncs the schema without a migration file: prototyping on a throwaway database only.

## Drift, baselining and failed migrations
- `prisma migrate diff --from-... --to-... --script` shows the SQL between two states (database, migrations
  folder, schema file); use it to see drift before deciding anything.
- Baselining an existing database: generate the initial migration, then
  `prisma migrate resolve --applied <migration_name>` so Prisma records it without running it.
- A failed `migrate deploy`: fix the cause, then `prisma migrate resolve --rolled-back <migration_name>` and
  deploy again. `resolve` only edits Prisma's bookkeeping table: it does not undo partial changes, so inspect the
  database state first.

## Destructive commands (owner gate)
`prisma migrate reset`, `prisma db push --force-reset` and `prisma db push --accept-data-loss` can delete data.
Recent Prisma versions block them for AI agents until the user consents. Forge rule: explain exactly what will be
lost, ask the owner right before running it, and run only after that answer. Never fabricate or reuse consent,
never set the consent variable yourself without the owner's exact words, and never run these against production.

## Not carried over
Cloud setup (`prisma init --db`, `prisma dev --detach`) and starting the Prisma MCP server are out of scope for this
playbook; they create remote or background resources and need their own owner approval.
