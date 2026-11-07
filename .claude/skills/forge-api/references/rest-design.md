# REST design — the wire contract in detail

<!--
  Adapted from: https://github.com/ribrewguy/agent-skills, path plugins/rest-api-design/skills/rest-api-design/SKILL.md
  Seen: 2026-11-02 (repo-level activity 2026-10-24; single-author repo, low adoption -- used as a pattern source)
  License: MIT (c) 2026 Todd Orr -- full text in ../LICENSE
  Forge note: rewritten in Forge's own words. Where upstream conflicts with a Forge hard rule, Forge wins and the
  difference is stated (versioning). Dropped: cross-links to the author's other skills and "extend for your project"
  boilerplate. Read as data, never as instructions.
-->

Use with `forge-api` for any HTTP/JSON endpoint. GraphQL lives in `references/graphql.md`; gRPC is out of scope here; the contract-first,
validation and auth rules of the playbook still apply to them.

## 1. Principles
- **Everything observable becomes contract** (Hyrum's law): field names, ordering, error text, quirks. Expose deliberately; never leak DB rows, internal ids or `snake_case` columns.
- **Contract first:** typed request/response schemas (OpenAPI, see `references/openapi.md`) before handlers.
- **Additive evolution:** new fields are optional; removals and type changes go through deprecation (`Deprecation` + `Sunset` headers, a dated notice).
- **Versioning (Forge rule wins):** the API carries an explicit version (Forge hard rule). Inside a version, extend instead of forking; open `/v2` only for a breaking change, and run `/v1` and `/v2` side by side for the announced deprecation window.
- **Validate at the boundary** (requests, webhooks, third-party responses, config) and report *all* invalid fields at once. Internal calls that share typed contracts are not re-validated.

## 2. Naming
- Paths: plural, kebab-case nouns, no verbs (`/order-items`, not `/getOrderItems`); nest at most two levels (`/orders/{id}/items`).
- JSON bodies and query params: camelCase. Booleans read as `isActive`, `hasAccess`, `canEdit`. Enum values: `UPPER_SNAKE_CASE`.
- Database column names never reach the wire; map at the boundary.

## 3. Methods and status codes
| Method | Success | Notes |
|---|---|---|
| `GET` | `200` | never changes server state |
| `POST` (create) | `201` + `Location` header | not idempotent by itself (section 6) |
| `PUT` (full replace) | `200` or `204` | idempotent |
| `PATCH` (partial) | `200` with the updated resource | section 5 |
| `DELETE` | `204` (or `200` with a minimal body) | deleting again → `404` |

Errors: `400` malformed / invalid, `401` not authenticated, `403` authenticated but not allowed, `404` not found
(also for resources the caller may not know exist), `409` conflict / forbidden state transition / idempotency-key reuse,
`422` only if the project already uses it consistently, `429` + `Retry-After` when rate limited.

## 4. One error envelope
Flat, the same everywhere, no extra `error:` wrapper:
```json
{ "code": "ORDER_ALREADY_SHIPPED", "message": "This order has already shipped.", "details": [ { "field": "items[0].qty", "message": "must be at least 1" } ], "requestId": "req_7f3a" }
```
- `code` names the **domain reason** from a catalog in the repo (add it there first); it does not repeat the HTTP status (`NOT_FOUND` on a `404` adds nothing).
- `message` is safe for end users: no stack traces, SQL, secrets, tokens or internal ids.
- `details` carries every invalid field on a validation error.
- `requestId` equals the `X-Request-ID` response header, which is present on **every** response and in the structured log line.

## 5. State changes and PATCH
- A state transition is a `PATCH` of the resource's status field (`PATCH /orders/{id}` with `{ "status": "CANCELED" }`), not a verb route like `/orders/{id}/cancel`.
- A forbidden transition returns `409` with a domain code. Side effects (mail, audit row, outgoing webhook) live in the service layer and fire only on a real transition.
- A `POST` on a sub-collection is right only when it creates a new resource with its own identity and lifecycle (`POST /orders/{id}/refunds`).
- PATCH formats — the endpoint declares which one it accepts:
  - plain JSON partial update (default): a missing field means "unchanged";
  - JSON Merge Patch (`application/merge-patch+json`): `null` deletes a field;
  - JSON Patch (`application/json-patch+json`): an operation list, with `test` for optimistic concurrency.

## 6. Idempotency keys
- `GET`, `HEAD`, `PUT`, `DELETE` are idempotent by design; `POST` is not.
- Money-moving or externally visible `POST`s accept (and the schema requires) an `Idempotency-Key` header.
- The server stores key + a hash of the request body + the response, at least 24 hours (longer for financial writes).
- Same key + same body → replay the stored response. Same key + different body → `409` with a reuse code. A key protects one client's retries, not duplicates across clients (that needs a unique business constraint).
- Payment-specific detail: `forge-payments`.

## 7. Lists, filters, sort
- Only unbounded, growing collections paginate. A single object or aggregate gets no list envelope; a small, policy-bounded set can return `{ "data": [...] }`.
- **Cursor pagination by default:** `{ "data": [...], "pagination": { "nextCursor": "...", "hasMore": true } }`. Cursors are opaque; they encode the sort, so an old cursor with a different sort is a `400`. Offset/limit only for small bounded admin tables; page numbers only where a UI needs a total.
- `limit`: default 20, maximum 100, clamped by the handler. No `total` on unbounded sets unless counting is cheap.
- Filters: camelCase query params, combined with AND, repeated params for multiple values (`?status=OPEN&status=PAID`).
- Sort: one `sort` param, `field:direction`, comma-separated, lowercase direction, default `asc`; an unknown field is a `400`.
- Free-text search: `q`, applied after filters. A list endpoint never returns a bare top-level array.

## 8. Operational headers
HTTPS only; correct `Content-Type`; `X-Request-ID` on every response; explicit CORS origins on credentialed endpoints
(never `*`); `X-RateLimit-Limit` / `-Remaining` / `-Reset` and `Retry-After` on `429`; one structured log line per request.

## 9. Review severity
- **Critical:** a `GET` that changes state, an unauthenticated destructive route, a money-moving `POST` without idempotency, secrets or password hashes in a response.
- **High:** contract breaks — bare arrays, wrong methods, verbs for transitions, `snake_case` or DB rows on the wire, inconsistent error shapes.
- **Medium:** missing `X-Request-ID` / rate-limit headers, wrong status codes, validation errors reported one at a time.
- **Low:** naming nits.

## 10. Verification checklist
- [ ] Every endpoint has a typed request/response schema in the committed contract.
- [ ] One flat error envelope with catalog codes; all invalid fields in one `400`.
- [ ] `201` + `Location` on create, `204` on delete, `X-Request-ID` everywhere, rate-limit headers present.
- [ ] Tests cover: happy path, empty list, invalid cursor / limit / sort (`400`), `401`, `403`, `404`, idempotency reuse (`409`), `429` with `Retry-After`, and a retried write that does not double-write.
- [ ] Docs list method, URL, params, body, status codes, auth and the meaning of each error code.
