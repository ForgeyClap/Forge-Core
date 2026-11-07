# OpenAPI — the contract file as source of truth

Forge-native reference (no third-party text). Use with `forge-api` and `references/rest-design.md`.

## 1. What "contract first" means in practice
1. Write or update the OpenAPI document **before** the handler. Default: OpenAPI **3.1** (JSON Schema 2020-12 compatible); stay on 3.0.x only if the project's tooling requires it, and say so.
2. Commit it at a stable path in the built project (for example `openapi.yaml` at the service root or under `docs/`), one file per service, or split with `$ref` into `components/` files.
3. The implementation is checked against it in CI (section 5). A handler that answers outside the contract is a bug, not a feature.

Code-first generation (types or decorators that emit the spec) is acceptable when the project already works that way, as
long as the emitted spec is committed and diffed in review. Either way exactly one source of truth exists.

## 2. Minimum content per operation
- `operationId` (stable, camelCase; client generators use it), `summary`, `tags`.
- Every parameter (path, query, header) with a schema, `required` and constraints (`minimum`, `maxLength`, `enum`, `pattern`).
- `requestBody` with `required: true` where applicable and the declared media type (including `application/merge-patch+json` when a PATCH uses it).
- **Every** response the handler can produce: the success code plus `400`, `401`, `403`, `404`, `409`, `429` as relevant, each pointing to the shared error schema.
- `security` on the operation (or globally, with an explicit empty `security: []` only on genuinely public routes).
- Response headers that are part of the contract: `Location`, `X-Request-ID`, `Retry-After`, `X-RateLimit-*`, `Idempotency-Key` as a request header where required.
- At least one realistic `example` per request and success response (no real personal data, no real keys).

## 3. Shared components
```yaml
components:
  schemas:
    Error:
      type: object
      required: [code, message, requestId]
      properties:
        code: { type: string, description: "Domain error code from the catalog" }
        message: { type: string }
        details:
          type: array
          items:
            type: object
            required: [field, message]
            properties: { field: { type: string }, message: { type: string } }
        requestId: { type: string }
    PageInfo:
      type: object
      required: [hasMore]
      properties: { nextCursor: { type: [string, "null"] }, hasMore: { type: boolean } }
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
```
- Reuse `Error` and `PageInfo` everywhere; a list response is `{ data: [...], pagination: PageInfo }`.
- Separate input and output schemas (`OrderCreate`, `OrderUpdate`, `Order`) so server-owned fields (`id`, `createdAt`) are `readOnly` and never accepted from clients.
- Variants use `oneOf` + `discriminator`; set `additionalProperties: false` on request bodies so unknown fields are rejected, not silently ignored.
- Ids are opaque strings in the contract, even if the database uses integers.

## 4. Versioning and change control
- `info.version` follows the API version; the server URL or path carries the major version.
- Additive change (new optional field, new endpoint, new enum value only when clients were told to tolerate unknowns): same major version.
- Breaking change (removed/renamed field, new required input, narrowed type, changed status code): new major version, `deprecated: true` on the old operation, `Deprecation` / `Sunset` headers, and a dated notice.
- Run a breaking-change diff between the base branch spec and the PR spec in review (any OpenAPI diff tool the project already has; adding one is an opt-in dependency, see `references/team-and-tools.md`).

## 5. Proving the contract (what counts as evidence)
- **Lint:** the spec parses and passes the project's OpenAPI linter (or at minimum a schema-validation parse) with zero errors.
- **Request validation:** the server validates incoming requests against the spec or against types generated from it (for example a Zod/Ajv/Pydantic layer), and a test proves an invalid body returns the `400` envelope.
- **Response validation in tests:** contract tests assert that real responses (happy path, auth failure, validation failure) match the declared schemas.
- **Drift check:** a test or CI step fails when a route exists in code but not in the spec, or the reverse.
- Report which of these actually ran. "Spec written" is not "contract-compliant".

## 6. Docs and clients
- Generated reference docs and typed clients come **from** the spec; never hand-edit generated files.
- Docs are published only after the owner approves anything public-facing; internal docs can be served locally.
- Webhooks the API sends are described too (OpenAPI 3.1 `webhooks`), with their signature scheme and retry policy.

## 7. Common mistakes
- Spec written after the code and never checked again (drift).
- Only the `200` response documented; errors left undocumented.
- One schema for create, update and read, so clients can set `id` or `createdAt`.
- `additionalProperties` left open on inputs, so typos are silently accepted.
- Real tokens, emails or customer data in examples.
