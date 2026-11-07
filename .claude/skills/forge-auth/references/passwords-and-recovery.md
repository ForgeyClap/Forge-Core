# forge-auth — passwords, recovery, verification, MFA

Password-security and rate-limit patterns adapted from wshobson/agents `auth-implementation-patterns` (MIT),
extended by Forge from NIST SP 800-63B (rev. 4) and the OWASP Password Storage, Forgot Password and
Authentication cheat sheets. Provenance: `../SKILL.md`; license: `../LICENSE`.

## Storage
- Argon2id is the first choice (OWASP baseline: 19 MiB memory, 2 iterations, 1 lane, or stronger). scrypt is fine;
  bcrypt with cost >= 10 is acceptable for existing systems (it only uses the first 72 bytes of input).
- Use the library's verify function (constant-time compare); rehash on login when parameters are raised.
- Never log, email or return a password; never store it encrypted "so support can read it".

## Policy (NIST SP 800-63B rev. 4)
- Minimum length: 15 characters when the password is the only factor, 8 when it is part of MFA. Allow at least
  64 characters and all printable characters including spaces and Unicode.
- No composition rules (one capital, one symbol) and no forced periodic changes; force a change only after
  evidence of compromise.
- Reject passwords found in breach lists or common-password lists, and context words (app name, username).

## Reset ("forgot password")
- Same response and similar timing whether or not the account exists.
- Token: cryptographically random, single-use, short-lived (about 15–60 minutes), stored hashed, tied to the user.
- Build the reset link from a configured base URL, never from the request's `Host` header (host-header poisoning).
- After a successful reset: invalidate the token, revoke existing sessions, notify the user by email.
- Do not log the user in automatically on a link click without at least re-confirming in the reset form.

## Email verification and change
- Verify before granting anything that depends on owning the address (account linking, invites, domain-based SSO).
- Email change: confirm through the old address (or re-authenticate) and verify the new one before switching.

## Brute force and enumeration
- Rate-limit by account and by IP/network on login, sign-up, reset, OTP and MFA endpoints; add progressive delay
  or a challenge rather than hard lockouts that let attackers lock out real users.
- Generic error text: "Invalid email or password".
- Behind a proxy, read the client IP only from headers your own proxy sets (configure the trusted proxy); a
  client can forge `X-Forwarded-For`.

## MFA and passkeys
- Prefer passkeys/WebAuthn (phishing-resistant), then TOTP; SMS is the weakest option.
- Recovery codes: shown once, stored hashed, single-use.
- Changing or removing a factor requires recent re-authentication and triggers a notification.
