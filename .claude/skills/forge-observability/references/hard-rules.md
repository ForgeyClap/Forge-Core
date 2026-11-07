# Hard rules — full text

1. **Vendor-neutral export.** Traces, metrics and logs leave the app over OTLP (HTTP/protobuf by default, gRPC if the
   project chose it) to a collector. Configuration comes only from the standard `OTEL_*` environment variables
   (endpoint, headers, sampler, resource attributes). App code does not import a backend vendor's exporter and does not
   hard-code endpoints or samplers. The collector decides where data goes. Exception: an error-tracking SDK such as
   Sentry may run in-process (see `sentry.md`).
2. **Telemetry never breaks the app.** With no collector reachable the app starts and serves normally. Batch processors
   use bounded queues; an export failure is logged once at WARN, not per batch; on shutdown the SDK flushes with a
   bounded timeout.
3. **Never log or attach secrets or personal data.** Credentials, tokens, API keys, session ids, cookies,
   `Authorization` headers, full request or response bodies, card data and personal data beyond an opaque user id never
   appear in logs, span attributes, span events, metric attributes or error-tracking context. The rule holds at every
   level, including DEBUG (debug is often switched on during an incident). A new field whose name contains password,
   token, secret, authorization, cookie or key is a review failure regardless of its value.
4. **Structured fields, stable messages.** The message is a stable sentence; values travel as typed fields with
   consistent types across records. One event per record; stack traces go in the exception field.
5. **Exception recorded once.** The boundary that handles a failure (HTTP error handler, job runner) logs it and the
   span where it failed records it. Layers that rethrow wrap it with context instead of logging. A layer that swallows
   an exception logs at WARN or higher with the reason and the exception.
6. **Context crosses every boundary.** W3C `tracecontext` and `baggage` propagation on outbound HTTP, message headers on
   queues, a link on background jobs. A broken hop is a critical finding. Logs inside a span carry `trace_id` and
   `span_id`, attached by instrumentation, never copied by hand.
7. **Low-cardinality names and metric attributes.** Span names like `OrderService.place`, ids in attributes. Metric
   attributes are small fixed sets (`outcome`, `http.route`, `code.function.name`); ids, emails and free text never.
8. **Every alert points at a runbook section; every runbook command carries a prerequisite, the expected output and an
   "if this fails" line.** Shape, SEV table and roles: `runbooks.md`.
9. **Count before you destroy.** Any destructive or mass-changing incident step runs its read-only count with the same
   filter first, compares it with the safe range written in the runbook, and waits for the owner's yes.
10. **Incident updates are drafted, not sent.** The communicator drafts; posting outside the run notes (clients, status
   page, chat, mail) is the owner's step. No secrets, customer names or raw stack traces in an update.
