# OpenTelemetry — traces and metrics

Adapted from ribrewguy/agent-skills opentelemetry (MIT, (c) 2026 Todd Orr), condensed and reworded; JVM-specific parts
dropped.

## Export contract
- OTLP to a collector; standard `OTEL_*` env vars only (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
  `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`, ...). Collector auth headers come from the
  secret store, never from code.
- Required resource attributes: `service.name`, `service.version`, `deployment.environment.name`; add
  `service.namespace` when the service belongs to a larger system.
- Propagators: W3C `tracecontext` and `baggage`; add B3 only when an upstream system needs it. Never put personal data
  in baggage: it travels to every downstream service.
- Resilience: bounded batch queues, one WARN on export failure, flush on shutdown with a timeout, app healthy without a
  collector.

## Span tiers (what to instrument)
1. **Edges (auto-instrumentation):** inbound server, outbound HTTP, database, messaging, cache. Confirm they appear; do
   not hand-write them.
2. **Service and repository methods:** one span per public method, applied centrally (wrapper, decorator,
   middleware) so new methods are covered automatically.
3. **Explicit spans** only for work that does IO, can take noticeable time, or is a decision worth debugging later.
   Otherwise add an attribute or an event to the parent span.
- **Do not span** controllers that only delegate, mappers, validators, getters or small utilities. No span per loop
  item unless the item does IO; one span with an `item.count` attribute instead.
- **Names:** low-cardinality `ClassName.method` (or `module.function`) plus `code.function.name`; ids go in attributes,
  never in the name.

## Error rule
- The span where the operation failed records the exception and sets status ERROR.
- Ancestors the failure propagates through get status ERROR without recording the exception again.
- Ancestors that catch and handle it stay UNSET.
- A handled "not found" (404) is not an error span.

## Metrics
- Per service method: a call counter (`app.service.calls`, unit `{call}`) and a duration histogram
  (`app.service.duration`, seconds), both with `code.function.name` and `outcome` (`success` or `error` only).
- Turn on runtime metrics (event loop, GC, memory, CPU) for the process.
- Business metrics only when someone will ask a question that needs one.
- Instrument by meaning: counter for things that only go up, up-down counter for levels, histogram for durations and
  sizes, observable gauge for sampled values.
- Names: dotted lowercase, domain first, no backend suffixes such as `_total`, UCUM units, durations in seconds.
- Never ids, emails or free text as metric attributes: each distinct value becomes a new time series (cost and outage).

## Propagation pitfalls
- Callbacks and hand-built promise chains in Node can lose the active context: bind it explicitly where
  auto-instrumentation does not reach.
- Thread pools and executors (Python `concurrent.futures`, custom worker pools) need context-aware wrappers.
- **Messaging:** the producer injects context into message headers; the consumer extracts it, starts its span as a
  child of the extracted context, and links to it.

## Background and async work
- A background job started from a request gets its **own root span with a link** to the enqueuing span (captured at
  enqueue time), so the request's duration stays honest.

## Serverless and edge
- The process can freeze right after the handler returns: nothing may wait in a buffer. Export immediately or
  force-flush spans and logs before returning; force-flush metrics on every invocation.
- On Cloudflare Workers, prefer the platform's built-in logs and traces settings (see `forge-devops`) or an
  OTel-compatible library made for that runtime; Node SDK auto-instrumentation does not run there.

## Sampling
- Head sampling (`parentbased_traceidratio`) is cheap and keeps whole traces; tail sampling in the collector can keep
  all errors and slow traces. Changing sampling changes cost: an owner decision for production.
