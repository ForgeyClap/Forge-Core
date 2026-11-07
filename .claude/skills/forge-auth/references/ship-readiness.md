# forge-auth — ship-readiness evidence

Before handoff, each line has evidence (test name, command output or file path), or says plainly "not done".

- [ ] Negative tests pass: unauthenticated, wrong user, wrong tenant, expired token, tampered token, wrong role.
- [ ] Every Server Action / API route / job that mutates data checks identity and permission itself (list them).
- [ ] Passwords hashed with Argon2id/scrypt/bcrypt (library + parameters named); no password or token in logs.
- [ ] Cookies `HttpOnly`, `Secure`, `SameSite`; no tokens in `localStorage`; CSRF protection on cookie-auth mutations.
- [ ] JWT verification pins the algorithm and checks `iss`/`aud`/`exp`; no decode-only trust decisions.
- [ ] OAuth: PKCE + `state` (+ `nonce`), exact redirect URIs per environment, no open redirect after login.
- [ ] Rate limits on login, sign-up, reset, OTP/MFA; generic error messages (no account enumeration).
- [ ] Reset tokens single-use, short-lived, hashed; sessions revoked after reset and on logout.
- [ ] Webhooks from the auth provider verify signatures on the raw body and are idempotent.
- [ ] No secret key in the client bundle (grep of the build output) and `.env.example` holds placeholders only.
- [ ] `security-boss` review done; Codex adversarial review done or explicitly marked "not run".
