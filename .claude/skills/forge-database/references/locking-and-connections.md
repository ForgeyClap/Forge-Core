# forge-database — locking, transactions and connections

Adapted from supabase/agent-skills (conn-*, lock-* rules, MIT), rewritten by Forge.
Provenance: `../SKILL.md`; license: `../LICENSE`.

## Connections
- Postgres connections are expensive (megabytes of RAM each). Put a pooler (PgBouncer, Supavisor, the platform's
  pooler) between the app and the database; serverless functions must always go through it.
- **Transaction mode** returns the connection after each transaction: the best default. It breaks named prepared
  statements, session `SET`, session advisory locks, `LISTEN` and temp tables across statements.
- **Session mode** keeps the connection for the client session: needed for migrations and the features above.
- Behind a transaction-mode pooler, turn off named prepared statements in the driver (check the driver docs, for
  example `prepare: false` in node `postgres`, `prepareThreshold=0` in JDBC).
- Run migrations over a direct or session-mode connection, never the transaction pooler.
- Give app roles an `idle_in_transaction_session_timeout` and a sane `statement_timeout`.

## Transactions and locks
- Keep transactions short: no network calls, file I/O or waiting for a user inside one.
- Lock rows in a consistent order (for example by primary key) to avoid deadlocks; retry on SQLSTATE `40P01`
  with backoff.
- Job queues in Postgres: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n`, so workers never wait on each other.
- "Only one of this job at a time": `pg_advisory_xact_lock`, the transaction-scoped variant, so a crash releases it.
- Who blocks whom: `pg_stat_activity` with `pg_blocking_pids(pid)`.
