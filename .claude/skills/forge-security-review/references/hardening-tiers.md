# forge-security-review — Always / Ask first / Never, and the hardening rules

Adapted in Forge words from addyosmani/agent-skills `skills/security-and-hardening/SKILL.md` (MIT,
Copyright (c) 2025 Addy Osmani; pinned SHA and exclusions in the provenance block of `../SKILL.md`).
Use it both when reviewing and when a Boss is writing security-relevant code (SA-W1-A2).

## The three tiers
**Always (no exceptions)**
- Validate every external input at the boundary with a runtime schema (zod, joi, ajv); TypeScript types
  vanish at runtime and prove nothing about a request.
- Parameterise every query; encode output through the framework's escaping.
- HTTPS for every external call; passwords hashed with argon2, scrypt or bcrypt (12+ rounds).
- Security headers on every response (CSP from `default-src 'self'`, HSTS, frame and content-type options).
- Session cookies `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`, with a bounded lifetime.
- Run the project's own package audit against the committed lockfile before a release.

**Ask first (in Forge: the Lead decides, the owner when a hard gate is touched)**
- A new or changed login, session or permission flow (`forge-auth`).
- Storing a new kind of sensitive data (personal data, payment data, health data).
- A new external integration, a CORS change, a new file upload handler.
- Changing rate limits, or granting a higher role or permission.
Anything that also needs credentials, spend, outbound messages, deploy or production stays an owner-only
hard gate; a review never approves it.

**Never**
- Commit secrets; log passwords, tokens, cookies or full card/IBAN numbers.
- Trust client-side validation, prices, roles or flags as a security boundary.
- Disable security headers "for now"; use `eval` or `innerHTML` with input.
- Keep auth tokens in `localStorage` / `AsyncStorage`; show stack traces or internal errors to users.

## LLM and agent features
- **Model output is untrusted input** (OWASP LLM Top 10, LLM05): never into `eval`, SQL, a shell,
  `innerHTML` or a file path; parse against a schema, then encode.
- **The system prompt is not a security boundary** (LLM01): text in the context (a user message, a fetched
  page, a PDF, a repo file) can carry instructions. Enforce permissions in code.
- Keep secrets, other tenants' data and the full system prompt out of the context (LLM02, LLM07). Scope tool
  permissions, validate every tool argument, confirm destructive tool actions (LLM06). Cap tokens, request
  rate and recursion depth per user (LLM10). Partition RAG indexes per tenant and validate documents before
  indexing (LLM08).

## Destructive operations on derived paths
A delete, move or overwrite is only as safe as the value that names its target. Before the call require all
three: the resolved target (symlinks and `..` resolved, `path.resolve` + `fs.realpathSync` on Windows too)
sits under an **allowlisted root**; it is at least **one level below** that root; and there is **ownership
evidence read before the operation** (a marker the tool itself created, a run id it owns). On refusal, log the
rejected target and stop; never fall back to a broader default path. A shape check (looks like a temp
folder) proves form, not permission. In Forge this is the same rule the gate hook and the safe cleanup tool
follow: no recursive deletes outside scratch, no kill by process name.

## Dependencies and install scripts
1. Find the one installation boundary (the folder with the lockfile) and the package manager; competing
   lockfiles in one boundary are a finding.
2. Dependency install scripts (`preinstall`, `postinstall`, `prepare`) run code on install. A new dependency
   with install scripts needs a reason; prefer installing with scripts disabled and approving the minimum.
   Never blanket-approve.
3. Triage audit findings by **reachability** (runtime, build, test, deploy path) and fix availability. Never
   apply a forced fix (`npm audit fix --force`) automatically; read the changelog and test each upgrade.
   Write down every deferral with a reason and a review date.
4. An audit only knows published advisories. A brand-new malicious or typosquatted package passes it: review
   new dependencies and lockfile diffs for owner, age, maintenance and the transitive graph.

## Privacy and retention
- Classify each new field: not personal, personal, sensitive. Data you cannot find you cannot delete.
- Collect against a stated purpose only; "might be useful later" is future breach scope.
- Every personal-data store has a retention period and a deletion path that also reaches backups, caches,
  search indexes and analytics copies. "Delete my account" that only flips a flag is a finding.
- Export, correction and deletion (GDPR / AVG) are schema and code, not paperwork.
- Sending personal data to an analytics, ad or LLM vendor is sharing: it needs consent and a processing
  agreement. Region is configuration, not a hard-coded assumption.

## Rationalizations (add to the list in `../SKILL.md`)
"It is just LLM text", "the audit passed so the package is safe", "collect it now, we may need it",
"we will handle deletion by hand", "it is just a prototype". Each one is a reason to look closer.
