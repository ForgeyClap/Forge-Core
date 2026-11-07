# Stack notes (Forge-written)

Package names below are the common choices at the time of writing; confirm current names and versions in the official
OpenTelemetry docs before adding them, and add them as project dependencies (no global installs).

## Node / TypeScript
- SDK: the OpenTelemetry Node SDK with the auto-instrumentations bundle, started before the app code loads (a separate
  instrumentation file loaded first, or the runtime's preload flag).
- Logger: pino (or the project's existing structured logger) with redaction paths for secrets, plus the OTel pino
  instrumentation so records carry trace and span ids and reach the OTel log pipeline.
- Context: async-local storage carries request context; wrap manual callback code with the context API where
  auto-instrumentation does not reach.
- Next.js and similar frameworks have their own instrumentation hook: use it instead of hand-wiring.

## Python
- SDK: opentelemetry-sdk with the OTLP exporter and the instrumentation packages for the frameworks in use (FastAPI,
  Django, Flask, requests, httpx, SQLAlchemy), or the distro's auto-instrumentation launcher.
- Logger: the standard logging module or structlog, JSON in production, with the OTel logging integration so records
  carry trace and span ids. contextvars for request context.
- Worker pools and Celery-style queues need explicit propagation through task headers.

## Edge and serverless
- Short-lived handlers: flush before returning (see `opentelemetry.md`).
- Cloudflare Workers: platform logs and traces settings, structured JSON logs; Node SDK auto-instrumentation does not
  apply there.
- Vercel: use the framework's instrumentation hook and export to a collector or the vendor integration the owner chose.
