# Verification — proving telemetry works

Adapted in part from the verification steps of ribrewguy/agent-skills opentelemetry and application-logging (MIT,
(c) 2026 Todd Orr), reworded.

## Component tests (always)
Use the SDK's in-memory span, log and metric exporters in a test and assert:
- the inbound server span exists and has the service-level child spans in order;
- an outbound call carries the same trace id (propagation works);
- log records emitted inside the request carry the active span's trace and span id;
- the service metrics carry `code.function.name` and `outcome` and nothing high-cardinality;
- a failing operation follows the error rule (failing span ERROR with the exception, propagating ancestors ERROR
  without it, handling ancestors UNSET).

## Startup without a collector (always)
Start the app with the OTLP endpoint pointing at an unreachable address: it must start, serve a request and log at most
one export warning.

## Leak checks (always)
- Read-only grep over logging calls and attribute setters for denylisted words (password, token, secret,
  authorization, cookie, api key) and for whole-object dumps of requests or users; review every hit.
- Run the test suite and scan its captured output for the same words and for test fixtures' fake secrets.

## Integration test (when a container runtime is available)
One test against a real collector in a container, configured only through `OTEL_*` env vars, asserting that spans,
logs and metrics all arrive and that a log record shares a trace id with a span. Review any compose or collector config
before using it; it is test-only, not a gate. No container runtime: report not-run.

## Backend check (owner-approved environment only)
For a real backend (Grafana, Honeycomb, Datadog, Sentry, ...): one request in a preview or staging environment, then a
link or screenshot showing the trace and its log lines. Never claim this ran without that evidence.
