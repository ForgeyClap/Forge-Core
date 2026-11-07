# forge-security-review — OWASP Top 10 checklist

Headings use the OWASP Top 10 (2021) names; the questions are Forge's own. Answer each with file:line evidence
or "not applicable because ...".

**Mapping to OWASP Top 10:2025** (the newer list covers the same ground): A01 Broken Access Control (now also
SSRF, our A10) · A02 Security Misconfiguration (our A05) · A03 Software Supply Chain Failures (our A06 + A08 and
`references/supply-chain.md`) · A04 Cryptographic Failures (our A02) · A05 Injection (our A03) · A06 Insecure Design (our
A04) · A07 Authentication Failures (our A07) · A08 Software or Data Integrity Failures (our A08) · A09 Logging and
Alerting Failures (our A09) · A10 Mishandling of Exceptional Conditions (section near the end). Use the 2025 ids
in the report when the owner or a client asks for the current list.

## A01 Broken access control
- Is every protected route/handler checked server-side, deny-by-default? Is there a negative test (other
  user's id, no token, wrong role)?
- Object-level checks: can user A read or change user B's record by changing an id (IDOR)?
- Are admin functions, file downloads and exports behind the same checks? CORS limited to known origins?

## A02 Cryptographic failures
- Passwords hashed with a slow, salted algorithm (argon2, bcrypt, scrypt), never plain, MD5 or SHA-1.
- TLS for all traffic; secure, httpOnly, sameSite cookies; no sensitive data in URLs.
- No home-made crypto; keys from env or a secret manager, not in code.

## A03 Injection
- SQL/NoSQL: parameterised queries or the ORM's bound parameters; no string-built queries with input.
- Shell: no `exec`/`system` with input; use argument arrays without a shell.
- HTML: output encoded by the framework; any `dangerouslySetInnerHTML`/`v-html`/`innerHTML` sanitised.
- Paths: user input never joined into a file path without normalising and checking it stays inside a root.

## A04 Insecure design
- Rate limits on login, sign-up, password reset, OTP and expensive endpoints.
- Business-rule abuse: negative quantities, replayed coupons, skipped steps in a multi-step flow.
- Idempotency on payment and order creation.

## A05 Security misconfiguration
- Debug mode, stack traces and default credentials off in production.
- Security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors) where it is a web app.
- Error messages do not leak internals, tokens, hashes or ids.

## A06 Vulnerable and outdated components
- See `secrets-and-deps.md`: audit output, lockfile committed, no abandoned packages on critical paths.

## A07 Identification and authentication failures
- Session rotation on login, logout invalidates the session, sensible expiry.
- Password reset tokens single-use, short-lived, not guessable; no user enumeration in messages.
- Tokens stored server-side or in httpOnly cookies, not in localStorage, for browser apps.

## A08 Software and data integrity failures
- Webhooks verify signatures and reject replays (timestamp window, event id dedupe).
- No deserialisation of untrusted data into objects with behaviour; CI pipeline does not run untrusted code
  with secrets.

## A09 Security logging and monitoring failures
- Auth failures, permission denials and payment events are logged with enough context, without secrets or
  full personal data.

## A10 Server-side request forgery
- Any server fetch of a user-supplied URL: allow-list hosts, block internal ranges and cloud metadata
  addresses, no blind redirects.

## 2025-A10 Mishandling of exceptional conditions
- Does every error path fail closed (deny, roll back, stop) instead of continuing with half-checked state?
- Are exceptions handled where they can be, never swallowed, and never shown to users with stack traces, queries
  or secrets? Are timeouts, resource limits and partial failures handled on purpose?

## Also check for LLM / agent features
- Prompt injection from user content or fetched pages cannot trigger tools with side effects without a check.
- Model output is treated as untrusted input before it reaches SQL, shell, HTML or file paths.
