# Error tracking with Sentry (Forge-written)

No Sentry agent skill was vetted in the 2026-11-02 research, so this section is Forge's own guidance. Check the current
Sentry docs for the exact SDK package and option names of the project's language and version before writing code; do
not guess them.

## Setup rules
- **Owner first:** creating the Sentry organisation or project, choosing the plan and region (EU data residency for EU
  users) and inviting people are owner decisions.
- **DSN from env:** read the DSN from an environment variable (server) or the build-time public env of the framework
  (browser). A browser DSN is public by design; it is still not committed as a literal in shared code, so environments
  can differ. Auth tokens for source-map or release uploads are CI secrets, never in the repo or the client bundle.
- **Tag every event** with `release` (the same version string as `service.version`) and `environment` (the same value
  as `deployment.environment.name`), so errors line up with traces and deploys.
- **Personal data off by default:** keep the SDK's send-default-PII option off; scrub request bodies, cookies, headers
  and query strings in a before-send hook; attach only an opaque user id. Apply the never-log list from `logging.md`.
- **Sample deliberately:** errors usually at 100 %, performance traces at a low rate; session replay only with an
  explicit owner and privacy decision (masking on, consent where required).
- **Initialise early** (before other imports where the SDK requires it) and flush before a serverless handler returns.

## Living next to OpenTelemetry
- Pick one source of truth for traces. Either use OpenTelemetry for traces and let Sentry receive errors (and, if
  wanted, traces through the collector or Sentry's OTLP support), or use the Sentry SDK's tracing; do not run two
  competing tracers that both patch the same libraries.
- Put the active trace id on Sentry events (most current SDKs do this when they share the OTel context), so an error
  links to its trace.

## Exceptions and noise
- Report an exception once, at the handling boundary, like logging. Expected outcomes (validation errors, 404s) are not
  sent as errors.
- Group noisy third-party errors with fingerprints or ignore rules, instead of turning error tracking off.

## Source maps and releases
- Upload source maps from CI after the build, with a scoped auth token stored as a CI secret; delete or do not serve
  public source maps if the owner does not want the code readable. The upload is an outbound action on a paid service:
  part of the owner-approved deploy, not something an agent runs on its own.

## Verify
- Trigger a test error in a local or preview environment and confirm it arrives with release, environment and no
  personal data; attach the event link or a screenshot. If no Sentry project exists yet, mark this not-run.
