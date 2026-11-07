# forge-testing — Vitest and Jest

## Choose the runner
- Vite, ESM-first or TypeScript projects without Jest: **Vitest** (Jest-compatible API, fast watch mode).
- An existing Jest setup: stay on **Jest**; do not migrate runners as a side quest.
- Zero-dependency Node tooling: `node --test` with `node:assert/strict`.
Use the project's installed runner and its own script (`npm test`), never a global or `npx`-downloaded one.

## Test structure
- Arrange, Act, Assert; one behaviour per test; the name says the behaviour
  (`returns 0 when the cart is empty`, not `test calc 2`).
- Table-driven cases (`it.each` / `test.each`) for many inputs to one function: boundaries, empty, null,
  very large, unicode, negative numbers.
- Test the public surface of a module, not private helpers; refactors should not break tests.

## Mocks, spies and fakes
- Mock what you do not own and what is slow or non-deterministic: network, clock, randomness, file system
  where needed. Prefer a small fake (in-memory repository) over deep mock chains.
- `vi.fn()` / `jest.fn()` to assert a collaborator was called with the right arguments, only when that call
  IS the behaviour (an email was queued, an event emitted).
- Reset between tests (`restoreMocks` / `clearMocks` in config, or `afterEach(vi.restoreAllMocks)`), so one
  test's mock never leaks into the next.
- Module mocks (`vi.mock` / `jest.mock`) are hoisted: keep them at the top of the file and obvious.

## Time and async
- Fake timers (`vi.useFakeTimers()` / `jest.useFakeTimers()`) for debounce, retry and expiry logic; advance
  them explicitly; restore real timers after.
- Always `await` the promise under test, or return it; an un-awaited assertion passes silently.
- Test rejected paths with `await expect(fn()).rejects.toThrow(...)`.

## Snapshots
- Only for stable, reviewable output (a serialised config, a small rendered fragment). Large snapshots get
  rubber-stamped on update and stop protecting anything. Prefer explicit assertions.

## Integration tests
- Run against a real test database (container or a throwaway local instance) with migrations applied;
  wrap each test in a transaction that rolls back, or truncate between tests.
- Start the HTTP app in-process and call it (supertest or `fetch` to an ephemeral port).

## Component tests (UI)
- Testing Library queries by role and label, the same as Playwright locators; `user-event` for interactions.
- Assert what the user sees after an interaction, including loading, empty and error states.

## Coverage
- Turn it on in CI when the project tracks it (`--coverage`); look at uncovered branches in changed files, not
  only the headline percentage.
