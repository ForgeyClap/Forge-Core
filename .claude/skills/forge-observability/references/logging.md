# Application logging

Adapted from ribrewguy/agent-skills application-logging (MIT, (c) 2026 Todd Orr), condensed and reworded; JVM-specific
parts dropped.

## Levels
| level | meaning |
|---|---|
| ERROR | a request or job failed and someone may need to act |
| WARN | degraded but handled: a fallback, a recovered timeout, a swallowed exception with a reason |
| INFO | one business-relevant record per unit of work, not one per step |
| DEBUG | developer detail, normally off in production |
| TRACE | per-item detail inside loops |

A handled 404 or validation failure is not an ERROR. A WARN that fires on every request is a design problem: fix it or
demote it.

## Fields
- Values go in structured fields; the message stays a stable sentence (`"order placed"`, not
  `"order 123 placed for bob"`).
- Name the event and the entity it affects (`order.id`) so a failure is actionable.
- Keep each field's type the same across all records.
- Standard fields: timestamp, level, logger, message, service name, `trace_id`, `span_id` (the last two attached by
  instrumentation, never by hand).
- Use OpenTelemetry semantic-convention names for common values: `user.id`, `http.route`, `http.request.method`,
  `http.response.status_code`, `error.type`. Dotted lowercase for domain fields.

## Never log
Credentials, tokens, API keys, session ids, cookies, `Authorization` headers, full request or response bodies, card
data, personal data beyond an opaque user id. At every level. Add a redaction step in the logger config (path-based
redact in pino, a processor in structlog) as a second line of defence, not as the only one.

## Exceptions
- Log once, at the boundary that handles the failure.
- Rethrowing layers wrap with context (cause chain) instead of logging.
- A layer that swallows an exception logs at WARN or higher with the reason and the exception object.

## Request-scoped context
- Set request id, user id (opaque) and tenant once, in middleware, and let them flow to every record (async-local
  storage in Node, contextvars in Python).
- Clear request context at the end of the request so it cannot leak into the next one.
- Background jobs get their own context with the triggering entity id as a field.

## Output shape
- No `console.log` / `print` in server code; use the project logger.
- Local development: one readable line per event. Production: JSON, one line per record, exception escaped into one
  field.
- When OpenTelemetry is present, the same log call also feeds the OTel log pipeline, so records inside a request carry
  the active trace and span id.
