# forge-auth — hard rules and review checklist (full text)

Best-practice and pitfall lists adapted from wshobson/agents `auth-implementation-patterns` (MIT), extended by
Forge. Provenance: `../SKILL.md`; license: `../LICENSE`.

## Hard rules
- **Server-side, deny-by-default.** Every protected route, API handler, Server Action / server function,
  GraphQL resolver, background job and database query enforces identity and permission itself. New routes start
  protected; making one public is a deliberate, reviewed act. Middleware is a convenience layer, not the only
  guard (a middleware bypass then exposes everything).
- **No home-made crypto.** Use the framework's or provider's session, JWT and hashing libraries.
- **Password storage.** Argon2id (or scrypt/bcrypt with current parameters), unique salt per hash (the library
  does this), never MD5/SHA-x alone, never encryption. Details: `passwords-and-recovery.md`.
- **Tokens and sessions.** Access tokens live minutes (about 5–30), not days. Browser sessions in
  `HttpOnly; Secure; SameSite=Lax` (or `Strict`) cookies; never put tokens in `localStorage`/`sessionStorage`
  (one XSS steals them). Rotate the session ID on login and privilege change. Server-side revocation exists.
- **JWT verification.** Fixed algorithm allow-list (never take `alg` from the token, reject `none`), verify the
  signature with a key from a trusted, configured source, then `iss`, `aud`, `exp`/`nbf`. Details: `sessions-and-jwt.md`.
- **OAuth/OIDC.** Authorization code flow with PKCE (S256) for every client, `state` bound to the user's session,
  `nonce` for OIDC, exact redirect-URI matching. No implicit flow, no password grant. Details: `oauth-oidc.md`.
- **Object-level authorization.** Every lookup by ID also filters by owner or tenant (or RLS does). A valid login
  is not permission to read someone else's record.
- **Secrets.** Signing keys, client secrets and service keys come from env or a secret manager; never shipped to the
  client (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_` prefixes are public), never logged.

## Best practices
1. Encrypt all traffic (HTTPS everywhere, HSTS).
2. Rate-limit and monitor login, sign-up, reset, MFA and token endpoints.
3. Protect cookie-based sessions against CSRF (`SameSite` plus a token or strict `Origin` check for unsafe methods).
4. Validate all auth input (email format, password length) at the boundary.
5. Rotate signing keys and session secrets on a schedule and after any suspected leak; support two keys during rotation.
6. Log security events (login success/failure, password change, MFA change, role change) without secrets.
7. Offer MFA; prefer passkeys/WebAuthn or TOTP over SMS.

## Pitfalls to catch in review
- Weak or no password policy; or the opposite, composition rules and forced rotation (both hurt).
- JWT in `localStorage`; tokens that never expire; refresh tokens that are never rotated.
- Authorization only in the UI or only in middleware.
- Insecure reset: guessable or long-lived tokens, reset links that still work after use, account enumeration.
- No rate limiting on auth endpoints (brute force, credential stuffing).
- Trusting client-sent data: `userId`, `role`, `tenantId` or `isAdmin` in the request body or an unsigned cookie.
- Authorizing on user-editable profile metadata.
- Open redirects after login (`?next=https://evil.example`): allow-list relative paths only.
