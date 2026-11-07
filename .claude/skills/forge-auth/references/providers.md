# forge-auth — Clerk, Auth.js (NextAuth), Better Auth

Pattern adapted from (ideas only, rewritten in Forge's words, no text copied): clerk/skills (`clerk-nextjs-patterns`,
`clerk-webhooks`, `clerk-orgs`, commit b0d994e, no repo-level license detected) and better-auth/skills
(`better-auth/best-practices`, commit 20c9e88, no license). Always confirm against the provider's current docs for
the installed SDK version; these SDKs change their recommended patterns between majors.

## Common to every provider
- The provider proves identity; your app still authorizes every action and every record (see `rbac-and-tenancy.md`).
- Keep the provider's secret key and webhook signing secret in server env only; the publishable key is the only
  one the client sees.
- Pin the SDK version and read its upgrade guide before bumping a major.

## Clerk
- Protect each page, route handler and Server Function/Server Action itself (read `auth()` on the server and
  reject or redirect when there is no user); do not rely on middleware alone. In Next.js `auth()` is async:
  a missing `await` gives an undefined user, which can look like "signed out" or, worse, skip a check.
- Organisations: read the active org from the server-side auth object and gate with role/permission checks; scope
  every write by that org ID.
- Webhooks are for syncing data and side effects, not for a synchronous flow right after sign-up (they are
  eventually consistent). Verify every delivery with the SDK's webhook verifier on the raw body, keep the webhook
  route reachable without a user session (the signature is its auth), dedupe on the delivery ID header, return
  2xx quickly and queue slow work. Handle `updated` and `deleted` events, not only `created`.
- Do not cache per-user auth reads in shared caches; read the user ID outside a cache boundary and pass it in.

## Auth.js (NextAuth)
- Set a strong `AUTH_SECRET` from env; configure trusted host/URL explicitly in production.
- Choose the session strategy deliberately: database sessions are revocable; JWT sessions are not until expiry.
- Check the session in every Server Action and route handler; middleware-only protection is not enough.
- Be careful with automatic account linking by email between providers (see `oauth-oidc.md`).

## Better Auth
- Secret: long random value from env (at least 32 characters); never committed.
- Keep the built-in CSRF and origin checks on; when a frontend on another origin fails, add it to the trusted
  origins list instead of disabling the check.
- Cross-subdomain cookies widen exposure; enable only when required.
- Behind a proxy, configure which IP header to trust, or rate limiting and audit logs see the proxy's IP (or a
  forged header).
- Session cookie caching: changing the cache version invalidates all cached sessions (useful after an incident);
  custom session fields are not cached and are fetched again.
- After adding a plugin, regenerate/migrate the auth schema through the normal reviewed migration flow
  (`forge-database`), not by pushing directly to a shared database.
