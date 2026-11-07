# forge-database — SQLite

Forge-native (no vetted upstream skill found, research round 2); based on the official SQLite
documentation. Typical uses: desktop apps (`forge-electron`), local-first tools, tests, small single-server sites.

## Connection setup (per connection, every time)
- `PRAGMA journal_mode = WAL;` readers no longer block the writer (persisted in the file once set).
- `PRAGMA foreign_keys = ON;` foreign keys are OFF by default, per connection.
- `PRAGMA busy_timeout = 5000;` wait instead of failing at once with `SQLITE_BUSY`.
- `PRAGMA synchronous = NORMAL;` is a safe, faster pairing with WAL for most apps.

## Concurrency
- One writer at a time. Keep write transactions short; use `BEGIN IMMEDIATE` for read-then-write transactions so
  they take the write lock up front instead of failing halfway.
- Do not put the database file on a network share; locking is unreliable there.

## Schema and migrations
- Consider `STRICT` tables so types are enforced; otherwise SQLite accepts any value in any column.
- `ALTER TABLE` is limited (add/rename/drop column with restrictions). Other changes need the documented rebuild:
  create the new table, copy rows, drop the old one, rename, recreate indexes and triggers, all in one
  transaction with foreign keys temporarily off and `PRAGMA foreign_key_check` afterwards.
- Track the schema version in `PRAGMA user_version` (or a migrations table) and run pending migrations on start-up.
- Use an ORM's migration tool (Drizzle, Prisma) the same way as for Postgres: generated files, reviewed, committed.

## Backups and data safety
- Never copy the `.db` file while the app has it open in WAL mode (the `-wal` file holds recent commits).
  Use the online backup API or `VACUUM INTO 'backup.db'`.
- In a desktop app, keep the database in the per-user app-data folder, not next to the executable.
- No test or demo rows in a shipped database file.
