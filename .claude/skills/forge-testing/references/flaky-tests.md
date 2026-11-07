# forge-testing — Flaky tests

A flaky test passes and fails on the same code. Treat it as a real bug: either the test, the product or the
environment has a race. Classify before you fix: a timing fix applied to a data problem makes the test
slower and still flaky.

## Reproduce first
- Repeat the single test many times: `npx playwright test <file> -g "<name>" --repeat-each=20`, or a loop
  around the unit runner. Add `--workers=1` vs the default to see if parallelism matters. A PowerShell loop
  for any runner:
  ```powershell
  $fails = 0; 1..20 | ForEach-Object { npx vitest run path/to/x.test.ts *> $null; if ($LASTEXITCODE -ne 0) { $fails++ } }; "failed $fails/20"
  ```
- It must fail at least once in the repeat run before you trust any fix; record the rate (for example
  "3/20").
- Run it in the full suite and alone: passing alone but failing in the suite points to shared state or order.
- Collect a trace (Playwright `trace: 'on'` while hunting) and read it step by step: what the page showed when
  the action or assertion ran.

## Classify it (seven categories)
| Category | Signal | Root cause | Fix direction |
|---|---|---|---|
| Timing | timeouts, passes on retry, worse in CI | race, animation, an un-awaited async step | wait for a condition, never for time |
| Data dependency | fails beside other tests, passes alone | shared DB rows, files or cache; missing cleanup | per-test data, cleanup in the fixture |
| Environment | fails on one runner, follows load | CPU/memory pressure, slow network, missing tool | mock externals, give the job resources, pin versions |
| Order dependency | fails with sharding, `fullyParallel` or a shuffled order | uses another test's side effect | self-contained setup |
| Time sensitivity | fails at midnight, month end, one hour | real clock, date boundary, time zone | fake clock, fixed `timezoneId`/`TZ`, relative comparisons |
| Visual rendering | screenshot diff flickers by a few pixels | fonts, antialiasing, an animation frame | mask dynamic regions, disable animations, a small agreed threshold |
| External service | follows a third party's status | a real HTTP call in a test | mock the API at the boundary |

## Decision tree
```
Flaky test
├─ Passes when run alone?
│  ├─ yes → does another test create or change data it needs?  yes → ORDER DEPENDENCY
│  │                                                           no  → shares a DB/file/cache → DATA DEPENDENCY
│  └─ no  → continue
├─ Fails more often in CI than locally?
│  ├─ timeouts → TIMING (CI is slower)
│  ├─ connection errors → ENVIRONMENT (network or a service)
│  └─ out of memory / disk → ENVIRONMENT (resources)
├─ Fails at particular times or dates? → TIME SENSITIVITY
├─ Compares screenshots? → VISUAL RENDERING
├─ Calls a real external API? → EXTERNAL SERVICE
└─ none of the above → TIMING (default): find the async step that is not awaited
```
Before blaming the test in CI, check the environment once: is the backend health endpoint answering, did
the runner run out of memory? An environment failure is labelled as one in the report, not counted as a
test bug, and not "fixed" in the test.

## Common causes and fixes
| Symptom | Likely cause | Fix |
|---|---|---|
| Element not found / detached | acted before render or re-render | web-first assertion on the target state before acting; avoid stale element handles |
| Assertion sees old value | one-shot read instead of retrying assertion | `await expect(locator).toHaveText(...)` |
| Fails only in CI | slower machine, different viewport, timezone, locale, fonts | set viewport, `timezoneId`, `locale` explicitly; wait on conditions, not time |
| Fails only in the full suite | shared data, leaked mocks, global state, port clash | per-test data, reset mocks, unique ids, ephemeral ports |
| Random order failures | test depends on a previous test | make each test self-contained; never rely on order |
| Timeouts on network | waiting for `networkidle` or a real third-party API | wait for the specific response or UI state; mock third parties |
| Date-related failures near midnight/month end | real clock | fake clock / fixed date |
| Animation interference | clicking a moving element | wait for the stable state; reduce motion in the test config |
| 401 / 404 / 409 mid-test | expired token, a deleted seed row, a reused unique value | fresh token in the fixture, seed per test, unique ids per run |

## What not to do
- Do not add `waitForTimeout`/sleeps; they slow the suite and only hide the race.
- Do not raise retries as the fix; retries are a reporting aid (they surface "flaky" in the report), not a cure.
- Do not delete or weaken the assertion to make it pass.
- `test.skip('flaky, fix later')` without a tracked item is dead code: quarantine it properly or delete it.

## Intent fidelity (a repair must not change WHAT is verified)
After any repair, check the test still proves the same user intent. It does NOT when the target element's
kind changed (a button became a link), its ARIA role changed, the form now posts to another endpoint, or
the assertion now checks a weaker or different outcome. Such a change is rolled back: the repair fixed how
the test finds things, not what it proves. No automatic repair is applied without a person or Review Boss
reading the diff.

## Prove stability before release
After the fix: `npx playwright test <file> --repeat-each=50` (or the 50-run loop above) and require 50/50
passes, then one run inside the full suite. Report the before and after rates ("3/20 failed → 0/50").

## Quarantine
When a fix cannot land now, quarantine instead of skipping:
1. **Tag** the test (`@quarantine` tag or `test.fixme`) and exclude it from the blocking job. In Playwright,
   one project greps it out (`grep: /^(?!.*@quarantine)/` style) and a separate non-blocking project runs
   only the tagged tests, so they keep running and keep producing data.
2. **Track** it: a tracked item (an issue, a line in the run's owner queue or `FORGE_TASK_HISTORY.md`) with
   the date, the category, the reproduction rate, the trace and a named owner. No anonymous quarantines.
3. **Diagnose and fix** by category (above), prove 50/50, then **release**: remove the tag and note the fix.

Hygiene:
- **Maximum age 14 days.** After that, fix it or delete it; a permanent quarantine is a hidden gap.
- **Review the list weekly** (or at each run's close); aging entries are escalated to the Lead.
- **More than 5% of the suite in quarantine** is a process problem (test design, environment, data
  strategy), not a list of single fixes. Say so in the report.
- A quarantined test is a known gap: it is listed in every report until released, never silently skipped.
