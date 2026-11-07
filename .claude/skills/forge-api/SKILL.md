---
name: forge-api
description: "Playbook for APIs: REST, GraphQL, OpenAPI (gebruik bij een API)."
# A10 original description (listing budget; auth, versioning and rate limits stay in the body): "Playbook for contract-first APIs: REST, GraphQL, OpenAPI, auth, versioning, rate limits (gebruik bij een API bouwen)."
# W2-BUDGET original description (listing budget): "Playbook for contract-first APIs: REST, GraphQL, OpenAPI (gebruik bij een API bouwen)."
---

# Forge playbook — Contract-first API

## When to use
- Use for: contract-first APIs (OpenAPI / JSON Schema / GraphQL SDL / gRPC): boundary validation, auth, versioning, idempotency, rate limits.
- Domain framing, team roles and honesty rule: `references/overview.md`.

**Do not duplicate ECC skills — defer to:** `forge-integration` (when the API mainly wires external services / webhooks), `forge-payments` (any money/charge/gateway-webhook endpoint), `forge-fullstack` (when the API is one tier of a full app). This file is orchestration only.

## Hard rules (non-negotiable)
- **Contract first, single source of truth.** Define the API contract (OpenAPI 3.x, JSON Schema, GraphQL SDL, or a gRPC `.proto`) BEFORE implementing handlers.
- **Input validation at every boundary.** Validate every request — body, path params, query, headers — against the schema.
- **Auth on every protected route, server-side, deny-by-default.**
- **Explicit versioning.** The API is versioned (path `/v1`, header, or media type).
- **Idempotency on unsafe retryable writes.**
- **Rate limits + quotas.** Per-client / per-key rate limiting with `429` + `Retry-After`; abuse and runaway clients are bounded.

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `architect` (owns the contract + resource model). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

**Design references (read before writing the contract):** `references/rest-design.md` — wire rules: one flat error envelope with domain codes, PATCH for state transitions, cursor pagination, `Idempotency-Key` semantics, status codes, review severity; `references/openapi.md` — what the committed OpenAPI 3.1 file must contain and how to prove the code matches it. For a GraphQL contract: `references/graphql.md` — SDL first, depth/cost limits, DataLoader against N+1, auth per field, typed errors.

## Fan-out & flow
L2 for a single-resource service; L3 for multi-resource + auth + versioning + rate limiting.
**Serial:** contract (OpenAPI/schema) → boundary validation → auth/authz middleware → resource handlers → idempotency + rate-limit + pagination → contract tests.
**Parallel (independent once the contract + auth middleware are fixed):** individual resource endpoints ∥ the contract-test suite ∥ generated API reference docs.

## Domain gates
- A committed contract file exists and is the source of truth; the implementation validates against it (drift is caught).
- Every request is validated against the schema at the boundary; invalid input returns a clear `4xx` with a consistent error envelope.
- Auth is enforced server-side on every protected route, deny-by-default; a negative (unauthenticated / wrong-scope) test proves rejection.
- Explicit versioning present; no breaking change inside a shipped version.
- Idempotency on unsafe retryable writes; safe methods are genuinely idempotent.
- Rate limiting returns `429` + `Retry-After`; list endpoints paginate; no secrets in responses or logs.
- Contract tests cover the happy path AND auth-failure AND validation-failure — not just `200`.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: anything with auth gets a `security-boss` / `security-reviewer` review (a genuine high-risk trigger).
- Approval / safety: secrets in env; never in responses, error bodies or logs.
- Honest failure: never claim "auth enforced" or "contract-compliant" without a negative test that proves it.
- Honest failure: contract tooling is opt-in; report whether the contract tests actually ran.
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
- `references/rest-design.md` — REST wire contract in detail (adapted from ribrewguy/agent-skills, MIT; notice in `LICENSE`).
- `references/openapi.md` — OpenAPI contract file, shared components, change control, contract proof (Forge-native).
- `references/graphql.md` — GraphQL schema-first rules, limits, N+1, auth per field (Forge-native).
