# forge-api — GraphQL

Forge-native (no upstream text). Use with `forge-api` when the contract is a GraphQL schema. The playbook's hard
rules (contract first, boundary validation, server-side auth, rate limits, honest proof) apply unchanged; this file
adds what is specific to GraphQL.

## 1. Schema first
- The SDL file (`schema.graphql`) is committed and is the source of truth. Code-first libraries are fine as long
  as the printed SDL is committed and a CI check fails when the generated schema drifts from it.
- Name types for the domain, not the tables. Use `ID` for opaque ids; never expose database keys or internal flags.
- Inputs: one `input` type per mutation (`createOrder(input: CreateOrderInput!)`); payloads return the changed
  object plus typed user errors (`{ order, errors { field code message } }`) for expected failures.
- Nullability on purpose: non-null (`!`) only where the server can always deliver it; a failing non-null field
  nulls its parent.

## 2. Evolution, not versions
- GraphQL usually has no `/v2`. Add fields freely; remove only after `@deprecated(reason: "...")` and a dated
  notice. This satisfies the Forge "explicit versioning" rule when the schema change log is kept and a
  breaking-change check (schema diff against the last release) runs in CI.

## 3. Cost and abuse limits (required)
- Maximum query depth (start at 8-10) and a complexity or cost limit per request; reject over-limit queries with
  a clear error before execution.
- Pagination on every list field (connections with `first` / `after`, a hard maximum page size).
- Rate limit per client on cost, not only on request count. Batched operations count once per operation.
- Introspection off in production for private APIs; on for public ones by choice. Prefer persisted (allow-listed)
  queries for first-party clients.

## 4. N+1 and performance
- Every resolver that loads by id goes through a per-request batching loader (DataLoader or the framework
  equivalent). A list of 50 items must not run 50 queries; prove it with a query count in a test.
- Loaders are created per request, never shared across users (cache leak).

## 5. Auth per field
- Authenticate once per request (context); authorize in the resolver or a directive for every field that exposes
  owned data. Deny by default. Hiding a field from the schema is not authorization.
- Tenant scoping happens in the data layer the loader calls, not only in the top-level query.
- Negative tests: another user's id through a nested field, a mutation without the role, an over-depth query.

## 6. Errors
- Expected failures (validation, not found, conflict) are typed payload errors. Unexpected failures go in the
  top-level `errors` array with a stable `extensions.code` and no stack trace, query text or secret.
- Mutations that can be retried take an idempotency key like REST writes.

## 7. Subscriptions
- Authenticate the socket on connect and re-check authorization per event; bound the number of subscriptions per
  client; document delivery semantics (at-most-once unless stated).

## Proof before "done"
Committed SDL + drift check, depth and cost limits with a test that hits them, a loader query-count test, auth
negative tests on nested fields, and a schema-diff check for breaking changes.
