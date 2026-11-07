# forge-testing — Test data and CI

## Test data
- **Factories over fixtures files.** A small builder (`makeUser({ role: 'admin' })`) with sensible defaults
  and overrides keeps tests readable and avoids one giant shared seed file.
- **Unique per test.** Generate unique emails, names and ids (a counter or random suffix) so parallel tests
  never collide on unique constraints.
- **Seed through the API or DB directly,** not through the UI, except in the one test that covers that UI.
- **Clean up or isolate:** transaction rollback, a fresh schema per worker, or delete what the test created.
  Never rely on manual cleanup.
- **Synthetic data only.** No production dumps, no real names/emails/addresses/IBANs; use obviously fake
  values (example.com, test card numbers from the provider's docs).
- **Deterministic:** fixed seeds for random generators, fixed dates via a fake clock.

## Environments
- Tests run against local, a container or a dedicated test/staging environment, never against production.
- Third-party services run in their sandbox/test mode or are mocked; webhooks are simulated locally.
- Secrets come from env / CI secrets; a missing secret makes the test skip with a clear message, not fail
  with a confusing error, and the skip is reported.

## CI setup
- Install exact dependencies (`npm ci`), cache the package manager and Playwright browsers.
- Run fast suites first (lint, typecheck, unit), then integration, then e2e.
- Parallelise: Playwright `workers` per machine and `--shard=i/n` across machines; merge the reports.
- Keep artefacts on failure: Playwright HTML report, traces, screenshots (stored as CI artefacts, not committed).
- `forbidOnly` in CI; fail on a stray `.only`.
- Track flaky results separately (a test that passed on retry is reported as flaky, not as passed).

## What to report
The exact commands, runner versions, the counts (passed / failed / skipped / flaky), the shard layout when
used, and any quarantined or skipped suites with the reason.
