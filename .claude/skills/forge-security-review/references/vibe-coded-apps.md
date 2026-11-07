# forge-security-review — Vibe-coded app checklist

For apps built fast with an AI assistant (including Forge's own builds): the mistakes assistants make again
and again. Adapted in Forge words from raroque/vibe-security-skill (MIT, Copyright (c) 2025 Chris Raroque;
pinned SHA and exclusions in the provenance block of `../SKILL.md`). SA-W1-A2, 2026-11-05.

**Core rule: never trust the client.** Every price, user id, role, subscription status, feature flag and
rate-limit counter is checked or enforced on the server. If it only exists in the browser, the mobile
bundle or the request body, the attacker controls it.

Walk the sections that match the stack; skip the ones the project does not use and say so. Put any
CRITICAL (exposed secret, table without access control, auth bypass) at the **top** of the report.

## 1. Secrets in the frontend
- Client prefixes are baked into the public bundle at build time: `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`,
  `REACT_APP_`, plus `react-native-config` values. Flag any such variable whose name says secret, private,
  service, key or token.
- Fine on the client: Stripe publishable key, Supabase anon key, Firebase client config, public analytics id.
- Never on the client: Supabase `service_role` key, Stripe secret key, database URLs, any third-party secret
  key (including LLM provider keys), JWT signing secrets, OAuth client secrets.
- `.env*` gitignored **before** the first commit; `.env.example` holds names only. A tracked `.env`
  (`git ls-files` shows it) or a key in history counts as leaked: the owner rotates it.
- Search shapes, not values: `sk_live_`, `sk_test_`, `AKIA`, `ghp_`, `glpat-`, `xoxb-`, and database URLs that
  carry a password before the host (a `postgres://` URL with a name, a colon, a secret and then `@host`).

## 2. Database access control (the most common critical)
- **Supabase:** row-level security enabled on **every** exposed table, including junction, audit and metadata
  tables. Flag `USING (true)` or `USING (auth.uid() IS NOT NULL)` on select, update or delete (any signed-in
  user sees every row). Insert and update policies need `WITH CHECK` so a user cannot reassign ownership.
  Users updating their own `profiles` row must not be able to set `is_admin`, `credits` or `plan` (column
  grants or a private table). `SECURITY DEFINER` functions bypass RLS: keep them out of `public`, set an empty
  `search_path`, validate inputs. Storage buckets need their own policies scoped to the user's folder.
- **Firebase:** never `allow read, write: if true` or `if request.auth != null` alone; check
  `request.auth.uid` against the owner, limit which fields an update may change, and remember that
  sub-collections are **not** covered by the parent's rules. Storage rules check content type, size and path.
- **Convex:** every public query and mutation checks the identity and the ownership of the record; internal
  helpers use the internal variants so they are not callable from outside.

## 3. Missing auth on endpoints
- Every API route, Server Action and webhook handler is a **public endpoint** callable with a plain HTTP
  request, whatever the UI does. Each one starts with: input validation (schema), authentication,
  authorisation (does this user own this record), in that order.
- Next.js middleware is a convenience layer, not the only wall: check auth again in the handler or data
  layer (a known middleware bypass, CVE-2025-29927, made middleware-only auth fail).
- JWT: verify, never only decode; reject `alg: none`; check issuer, audience and expiry.
- Do not pass whole database rows to client components; select the fields the page needs. Mark server-only
  data modules (`import 'server-only'`) so they cannot be bundled.
- Tokens live in `HttpOnly`, `Secure`, `SameSite=Lax` cookies, not in `localStorage`.

## 4. Open and abusable endpoints
- Rate limits on login, signup, password reset, OTP and magic links; on every LLM call; on email and SMS
  sending (spam relay); on uploads and file processing.
- Counters must live where users cannot reset them (not in a public table); per IP **and** per user; a
  shared store when more than one instance serves traffic.
- Hard spend caps at every paid API provider plus per-user quotas in the app (owner sets the provider caps).

## 5. Payments
- The price comes from the server (a stored price id), never from the request body.
- Webhook signatures verified on the **raw** body (parse after verifying); see `forge-payments`.
- Subscription status checked on the server on every protected request, from data kept in sync by webhooks,
  not from a flag set at login.
- Checkout metadata (user id, plan) is set by the server when the session is created.

## 6. LLM features
Provider keys server-side only; per-user usage caps; user text in its own message role, never pasted into the
system prompt; model output sanitised before rendering and validated before any tool call. Detail:
`hardening-tiers.md` → "LLM and agent features".

## 7. Mobile (React Native / Expo)
Everything in the JS bundle is extractable: secret calls go through your own backend. Tokens in the secure
store (`expo-secure-store`, keychain), not `AsyncStorage`. Deep-link parameters are untrusted: validate them,
never carry tokens in them, never run a destructive action straight from a link. Biometric unlock must sign a
server challenge with a hardware-backed key; a local true/false can be hooked.

## 8. Deployment settings
Debug mode and public source maps off in production; `/.git/` not served; preview deployments use test keys,
never production keys; security headers set; CORS limited to your own origins (never `*` with credentials).
A secret scanner such as gitleaks is used only when it is already installed in the project; installing one
is an owner decision (`secrets-and-deps.md`).

## 9. Data access
Parameterised queries; a request body is never passed straight as an ORM filter or as update data (operator
injection, mass assignment: pick the allowed fields); no raw-unsafe query helpers with input.

## Report shape
Use `severity-and-writeup.md`. Per finding: file and line, the vulnerability, what an attacker can do in
concrete terms, and the fix as a short before / after. Skip clean areas in one line each and end with a
prioritised summary (rotate exposed keys first).
