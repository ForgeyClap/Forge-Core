# Canary watch — read-only post-deploy checklist

Idea adapted from the ECC catalog skill `canary-watch` (pinned catalog `e2b8a51`, MIT, (c) 2026 Affaan Mustafa), in
Forge words. Its notification hooks, webhook alerts, log file in the home folder and the "run as a hook on push" idea
are **not** taken: Forge does not install hooks for this, and an alert to a chat channel is outbound.

## What it is (and is not)
- A **read-only** check of a URL the owner just deployed (or a preview): GET requests and a headless browser page load.
  No form submits, no logins with real accounts, no writes, no load test.
- It **reports**; it never rolls back, scales or redeploys. A red result goes to the Lead and the owner with the
  matching row of `rollout-thresholds.md`; automatic rollback is a `forge-guardian` design and owner-gated.
- Bounded: one quick pass by default; a sustained watch has a written interval (for example every 5 minutes) and an end
  time (for example 2 hours). Never an open-ended loop.

## Before the deploy: record a baseline
Run the same pass on the current production (or the previous preview) and keep the numbers. Without a baseline every
"delta" is a guess: report the absolute values and say there was no baseline.

## The checks
| # | check | critical (report at once) | warning (in the report) |
|---|---|---|---|
| 1 | HTTP status of the main pages and the health route | not 200 (or the expected redirect) | slower than 2x baseline |
| 2 | console errors on page load (headless browser) | more than a handful of **new** errors | new warnings |
| 3 | network failures during load | any 5xx from the app's own API | new third-party requests (was a script added?) |
| 4 | static assets (JS, CSS, images, fonts) | any 4xx or 5xx | content type changed unexpectedly |
| 5 | key content present (h1, navigation, footer, primary call to action) | missing | moved or changed text |
| 6 | critical API endpoints | 5xx or over the agreed response time | 2x baseline response time |
| 7 | streaming endpoints (SSE, websockets) | cannot connect, or drops before the first heartbeat | first heartbeat slower than 2x baseline |
| 8 | page speed (LCP, CLS, INP) against baseline | LCP over 4 s | LCP more than 0.5 s worse, CLS over 0.1 |
Plus the server side the browser cannot see: logs flowing, no new error types in error tracking
(`forge-observability`).

## How to run it on Windows + Node
- Use what the project already has: a Playwright spec, a small Node script in `_scratch/` using built-in `fetch`, or
  `curl.exe -I` for a status line. Do not install a global tool for this.
- A browser or helper process you start is stopped by its **exact PID** from your own spawn result, never by image name.
- Put no credentials on the command line or in the script; a protected preview that needs a token is an owner step.

## Report shape
```
CANARY REPORT  <url>  <date time>  pass <n> of <m>
Status: HEALTHY | WARNING | CRITICAL
| check | result | baseline | delta |
...
Not run: <check> because <reason>
Matching threshold row: <advance | hold | roll back> (rollout-thresholds.md)
```
Quote the real numbers. "Looks fine" without the table is not a canary result.
