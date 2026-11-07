# forge-database — team, skills, commands, MCP

## Team (conditional)
Lead: `build-boss` (schema, migrations, queries). Support: `database-reviewer` (reads every migration and new
hot query), `security-boss` (RLS, grants, `SECURITY DEFINER`, service keys), `silent-failure-hunter` (swallowed
DB errors, retries that hide data loss). Optional: `codex-reviewer` for production migrations, deletion/retention
logic and tenant isolation (these are review areas in the owner's Codex policy).

## Skills / commands
- `forge-auth` for identity and permissions; `forge-payments` for money columns and ledgers; `forge-data` for
  pipelines; `forge-migration` for whole-system moves; `forge-debug` for a slow or failing query (reproduce first).
- `test-driven-development`: write the RLS negative test and the migration test before the policy or the migration.
- Vendor docs (Context7 or official docs) for exact ORM and Postgres version behaviour.

## MCP and tools
- Database MCP servers (Supabase, Postgres, Prisma) are opt-in through `forge-mcp-clients`: read-only role
  first, never a production connection string without owner approval, never a service key in an MCP config file.
- No install steps from upstream skills are carried over; tools the project already has are used as-is.
