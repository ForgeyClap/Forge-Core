# forge-api — domain overview

This is an **auth + data-boundary domain.** The contract (OpenAPI / JSON Schema / GraphQL SDL / gRPC proto) is the source of truth and comes **first**; the implementation is validated against it. `architect` owns the contract, `integration-boss` / `build-boss` implement, `security-boss` reviews auth/authz (a genuine high-risk trigger), `test-boss` owns the contract tests. Never claim "auth enforced" or "contract-compliant" without a negative test that proves it.
