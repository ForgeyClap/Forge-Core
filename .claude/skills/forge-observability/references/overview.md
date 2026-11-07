# Overview — Observability

Observability is how the people who run a system find out what it did and why, without attaching a debugger to
production. Three signals carry it: **traces** (the path of one request through the system), **metrics** (counts and
distributions over time, for alerts and trends) and **logs** (discrete events with context). Error tracking (Sentry and
similar) groups exceptions with their context and release.

Who reads it:
- **On-call** during an incident: needs one trace id to jump from an alert to the failing span to the log lines.
- **The owner** wants to know whether the service is healthy and what it costs to keep this data.
- **A security or privacy reviewer** checks that no secret or personal data ends up in a third-party backend.
- **A maintainer** adds a feature and must know which spans, metrics and fields to add, by convention.

Professional bar: vendor-neutral (OTLP plus a collector), telemetry that never takes the app down, no secrets or
personal data in any signal, consistent names (OpenTelemetry semantic conventions), and tests that prove the shape.
