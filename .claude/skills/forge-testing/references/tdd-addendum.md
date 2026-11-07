# forge-testing — TDD addendum (seams, tautological tests, vertical slices)

Read beside the vendored `test-driven-development` skill (pinned upstream copy, kept verbatim; this file
never changes it). That skill owns the red-green discipline and its `writing-good-tests.md` already says
"derive the expected value by hand, never with the code under test". This addendum adds three rules it
does not spell out.

## 1. Agree the seams before writing tests
A **seam** is the public boundary where you observe behaviour without reaching inside: an exported
function, an HTTP route, a CLI command, a rendered page, a webhook handler. Tests live at seams, never
against internals.
- Before the first test, write down the seams you will test, each with one line: what it catches and what
  it misses.
- In Forge the seams are part of the work package: Head Chef names them, or the Boss lists them in its
  first message to the Lead. Ask the owner only when the choice materially changes the result (for example
  "test the payment flow end to end or only the price calculation?"); otherwise pick the critical paths and
  complex logic, state the choice in one line and continue.
- No test is written at a seam nobody agreed to: effort goes to the paths that matter, not to every edge
  case.
- For a bug fix, the seam must replay the real bug pattern at the call site (see `forge-debug`, loop step
  7). No correct seam is itself a finding to report.

## 2. No tautological tests
A tautological test passes by construction because the assertion recomputes the expected value the way the
code does, so it can never disagree with the code:
- `assert.strictEqual(add(a, b), a + b)` — the test re-implements `add`.
- a snapshot or fixture produced by running the code under test and pasting its output as "expected";
- a constant asserted equal to itself, or a mock asserted to return what the test told it to return.

Expected values come from an **independent source of truth**: a known-good literal, a worked example done
by hand, the spec, a value the owner gave. Quick check: mutate the code (wrong constant, wrong branch, empty
return); if no test turns red, the tests are tautological or missing.

Also avoid **implementation-coupled** tests: mocking internal collaborators, testing private functions, or
verifying through a side channel (reading the database directly instead of using the interface). The tell:
the test breaks on a refactor while the behaviour did not change.

## 3. Vertical slices, not horizontal
Do not write all tests first and then all code. A batch of tests written up front verifies imagined
behaviour and fixes the test structure before you understand the problem. Work in **vertical slices**:
one seam, one failing test, the minimal code to pass it, repeat. Each test is a tracer bullet that uses
what the previous cycle taught you.
- Red before green, one slice at a time, no speculative features.
- Refactoring is not part of the red-green cycle; it happens after green, in the self-review or the
  `forge-code-review` pass, with the tests staying green.

## Report line
State in the handoff: the agreed seams, which tests were seen RED first, and that the expected values come
from an independent source (name it for non-obvious ones).
