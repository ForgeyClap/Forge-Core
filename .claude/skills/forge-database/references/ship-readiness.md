# forge-database — ship-readiness evidence

Before handoff, each line has evidence (command output, test name, or file path), or says plainly "not done".

- [ ] All migrations apply cleanly on an empty database (`migrate deploy` / `drizzle-kit migrate` output).
- [ ] Migrations were run on a realistic copy; duration and any lock waits noted for each risky step.
- [ ] Every destructive or production step has the owner's approval recorded, a backup timestamp and a rollback plan.
- [ ] Generated SQL was read; no accidental drop + add for a rename.
- [ ] Foreign-key columns indexed; hot queries checked with `EXPLAIN (ANALYZE, BUFFERS)`.
- [ ] RLS enabled on every client-reachable table; negative tests (user A vs user B, anon) pass.
- [ ] No `service_role`/secret key or connection string in the repo or the client bundle; `.env.example` has placeholders.
- [ ] Pooling mode matches the driver settings (prepared statements off behind a transaction pooler).
- [ ] Seed/demo data is separate from production data and is not shipped.
