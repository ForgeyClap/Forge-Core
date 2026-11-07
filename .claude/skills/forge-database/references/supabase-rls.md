# forge-database — row-level security, grants and Supabase specifics

Adapted from supabase/agent-skills (`supabase/SKILL.md` core rules and the security-* rules of
`supabase-postgres-best-practices`, MIT), rewritten by Forge. Provenance: `../SKILL.md`; license: `../LICENSE`.
Who the user is (sessions, JWT, OAuth) belongs to `forge-auth`; this file is how the database enforces it.

## RLS basics
- Enable RLS on every table in a schema that clients can reach (`public` on Supabase). In private schemas use it
  as defence in depth. Whenever `anon` or `authenticated` gets a grant on a table, that table needs RLS.
- RLS on with no policy = nobody (except bypass roles) sees anything. That is the safe starting point.
- Write policies that match the real access model; do not paste one `auth.uid()` pattern everywhere.
- `TO authenticated` alone is authentication, not authorization (the BOLA/IDOR hole). Add an ownership or
  membership predicate in `USING`, for example `(select auth.uid()) = user_id`.
- `UPDATE` needs `USING` (which rows) AND `WITH CHECK` (what the row may become); without `WITH CHECK` a user can
  move a row to someone else's `user_id`. An `UPDATE` without a matching `SELECT` policy silently updates 0 rows.
- Use the `TO` clause for roles; `auth.role()` is deprecated, and anonymous sign-ins also carry `authenticated`.
- Authorize on `app_metadata` (server-set), never on `user_metadata` (the user can edit it, and it shows up in the JWT).
- JWT claims are a snapshot until the token refreshes; for sensitive checks read the current row instead.

## RLS performance
- Wrap per-request functions in a sub-select so they run once, not per row: `(select auth.uid()) = user_id`.
- Index every column a policy filters on (`user_id`, `tenant_id`, membership keys).
- Complex membership checks: a helper function in a non-exposed schema, called from the policy (see below).

## Views and SECURITY DEFINER
- Views run with the owner's rights and bypass RLS by default. On Postgres 15+ create them
  `WITH (security_invoker = true)`; on older versions revoke client access or keep the view in a private schema.
- `SECURITY DEFINER` functions run as their owner (often a role that bypasses RLS). Never add it to "fix" a
  permission error. If one is truly needed: put it in a non-exposed schema, `SET search_path = ''`, check the
  caller (`auth.uid()`) inside the body, and `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` before granting
  only what is needed (`PUBLIC` gets `EXECUTE` by default).

## Grants and keys
- Grants decide which tables the API can touch; RLS decides which rows. New tables created in SQL may need explicit
  `GRANT`s for `anon`/`authenticated`, depending on project settings. Grant the minimum.
- The `service_role` / secret key bypasses RLS: server-side only, never in a browser, mobile app or any
  `NEXT_PUBLIC_`/`VITE_`/`EXPO_PUBLIC_` variable. Clients get the publishable (or legacy anon) key.
- Deleting a user does not kill tokens already issued: sign the user out / revoke sessions first and keep JWT
  expiry short for sensitive apps.
- Storage: an upsert needs `INSERT`, `SELECT` and `UPDATE` policies on `storage.objects`; `INSERT` alone lets
  uploads work but silently breaks replacing a file.
- Pin Supabase package versions and commit the lockfile.

## Proof
A test signs in as user A and user B (or sets `request.jwt.claims` in SQL tests) and shows: A reads only A's rows,
A cannot update a row into B's ownership, anon sees nothing private, and the service key is absent from the
client bundle.
