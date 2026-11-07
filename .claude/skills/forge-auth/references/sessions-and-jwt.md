# forge-auth — sessions, JWT, cookies, CSRF

Session-vs-token trade-offs adapted from wshobson/agents `auth-implementation-patterns` (MIT); the verification,
cookie and rotation rules are Forge-native, based on RFC 8725 (JWT Best Current Practices) and the OWASP Session
Management and CSRF cheat sheets. Provenance: `../SKILL.md`; license: `../LICENSE`.

## Choosing
| | Server sessions (opaque ID in a cookie) | Self-contained tokens (JWT) |
|---|---|---|
| Revocation | Instant (delete the row/key) | Hard until expiry; needs a denylist or short life |
| Best for | Browser apps with one backend | Service-to-service, mobile/API clients, edge verification |
| State | Session store (DB/Redis) | Stateless verify; refresh tokens still need state |

Default for a web app: server sessions in a cookie (or the provider's cookie session). Use JWTs where a
stateless check genuinely helps, and pair them with short expiry plus refresh tokens.

## Cookies
- `HttpOnly` (no JS access), `Secure` (HTTPS only), `SameSite=Lax` by default (`Strict` for admin areas),
  `Path=/`, and the `__Host-` name prefix when no subdomain sharing is needed.
- Sharing cookies across subdomains widens the blast radius: any subdomain (including user-content hosts) can
  read or overwrite them. Avoid unless required.
- Idle timeout and absolute timeout; re-authenticate for sensitive actions (email/password change, payout details).

## CSRF
Cookie-authenticated, state-changing requests need protection: `SameSite` cookies plus a CSRF token
(synchronizer or signed double-submit) or a strict `Origin`/`Sec-Fetch-Site` check. Never disable a framework's
built-in CSRF or origin checks to "make it work"; fix the configured trusted origins instead. GET must never change state.

## JWT verification (RFC 8725)
- Pass an explicit algorithm allow-list to the verify call (for example `['RS256']` or `['ES256']`); never trust
  the token's `alg` header; reject `none`; never verify an asymmetric token with a symmetric secret.
- Fetch keys from a configured JWKS URL and select by `kid`; never follow `jku`/`x5u` URLs found in the token.
- Validate `iss`, `aud`, `exp`, `nbf` (small clock skew allowance), and the token type if you issue several kinds.
- Keep claims small and non-secret (JWTs are only signed, not encrypted); never put passwords or PII in them.
- HS256 secrets: at least 256 bits of randomness from a secret manager. Prefer asymmetric keys when other
  services verify tokens.
- `decode()` is not `verify()`: grep for decode-only calls on any trust decision.

## Refresh tokens
- Opaque, random, stored hashed server-side, bound to user + device/session, with an absolute lifetime.
- Rotate on every use; if an old (already used) refresh token shows up again, revoke the whole token family
  (reuse detection = likely theft).
- Browsers: refresh token in an `HttpOnly` cookie scoped to the refresh path; mobile: the OS secure store.

## Logout and revocation
- Logout deletes the server session / refresh token, not just the client cookie.
- Password change, MFA change, role downgrade and account deletion revoke other sessions.
- Access JWTs stay valid until expiry after revocation: keep them short, or check a session ID / version claim
  against the store for sensitive operations.
