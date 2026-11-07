# forge-database — Drizzle ORM

Forge-native, with the generate/migrate/push split from affaan-m/ecc `database-migrations` (MIT). No vetted
Drizzle-team skill was found (research round 2); confirm details in the official Drizzle docs for the
installed `drizzle-orm` / `drizzle-kit` version.

## Workflow
| Step | Command | Where |
|---|---|---|
| Generate SQL migration files from the TypeScript schema | `drizzle-kit generate` | local |
| Write an empty migration for hand-written SQL | `drizzle-kit generate --custom --name <name>` | local |
| Apply migrations | `drizzle-kit migrate` (or `migrate()` from `drizzle-orm/<driver>/migrator` at deploy time) | CI/CD; production behind the owner gate |
| Sync schema without migration files | `drizzle-kit push` | throwaway local database only |
| Check migration files for conflicts | `drizzle-kit check` | local / CI |

## Rules
- Shared, staging and production databases only ever get migration files from `generate`; never `push`.
- `generate` asks whether a changed column was renamed or is new: answer carefully. A wrong "create" answer
  produces drop + add and loses the data. Read the generated SQL every time.
- Commit the `drizzle/` (or configured `out`) folder including `meta/_journal.json`; never edit an applied
  migration, add a new one.
- Hand-write what the generator cannot express (concurrent indexes, `NOT VALID` constraints, RLS policies,
  backfills) in a custom migration. Check whether your migrator runs files in a transaction before using
  `CONCURRENTLY`; if it does, run that statement separately.
- `drizzle.config.ts` reads the connection string from env; no literal credentials.
- Use the query builder or `sql` template tag (parameters are bound); never concatenate user input into `sql.raw`.
- Relations (`relations()` / the relational query API) do not create foreign keys: declare `.references()` and
  index those columns yourself.
