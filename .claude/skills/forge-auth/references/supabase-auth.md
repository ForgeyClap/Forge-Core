# forge-auth — Supabase Auth

Rules adapted from supabase/agent-skills `supabase/SKILL.md` (MIT), rewritten by Forge; no CLI, curl or MCP steps
carried over. Provenance: `../SKILL.md`; license: `../LICENSE`. Policy syntax, grants, views and `SECURITY DEFINER`
live in the `forge-database` skill (its Supabase RLS reference).

## Keys and clients
- Browser and mobile get only the publishable (or legacy anon) key. The `service_role`/secret key bypasses RLS:
  server-only, never in a `NEXT_PUBLIC_`/`VITE_`/`EXPO_PUBLIC_` variable, never in an edge function's response.
- Server code that acts for a user uses a client created with that user's session, so RLS applies; reserve the
  service-role client for trusted admin jobs.

## Trusting the session on the server
- On the server, do not trust a session object read straight from cookies for authorization decisions; validate
  the user's JWT with the auth server or verify its signature (check the current Supabase docs for the
  recommended call in your `@supabase/ssr` / `supabase-js` version).
- Use the official SSR helper for cookie handling in Next.js/SvelteKit/etc. so tokens refresh correctly.

## Claims and metadata
- Authorize on `app_metadata` (only the server can set it), never on `user_metadata` (the user can edit it and it
  appears in the JWT).
- JWT claims stay as they were until the token refreshes: after a role change, either revoke sessions or read the
  role from a table inside the policy.

## Sessions and deletion
- Deleting a user does not invalidate access tokens already issued; sign the user out (revoke sessions) first,
  keep JWT expiry short for sensitive apps, and for sensitive operations check that the session still exists.
- Anonymous sign-ins get the `authenticated` role too: policies must check `auth.uid()` ownership or an
  `is_anonymous` claim, not just the role.

## Proof
Negative tests with two real test users (A, B) and anon: A cannot read or update B's rows, anon gets nothing
private, changing `user_metadata` does not grant access, and the built client bundle contains no secret key.
