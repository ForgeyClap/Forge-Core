# forge-testing — Playwright Test

## Locators (in order of preference)
1. `getByRole('button', { name: 'Save' })` — matches what users and assistive technology see.
2. `getByLabel('Email')`, `getByPlaceholder(...)` for form fields.
3. `getByText('Order placed')` for non-interactive content.
4. `getByTestId('cart-total')` when there is no stable user-facing handle (add a `data-testid` on purpose).
5. CSS/XPath only as a last resort; never long chains tied to layout (`div > div:nth-child(3)`).

Scope locators instead of indexing: `page.getByRole('row', { name: 'Invoice 42' }).getByRole('button', { name: 'Pay' })`.

## Assertions
- Use web-first assertions that retry until the timeout: `await expect(locator).toBeVisible()`,
  `toHaveText`, `toHaveURL`, `toHaveCount`, `toBeEnabled`.
- Do not read a value once and assert on it (`expect(await locator.textContent()).toBe(...)`): that snapshot
  does not retry and is a classic flake source.
- Assert the outcome the user cares about (confirmation text, new row, URL), not only that a click happened.
- Use `expect.soft` only when collecting several independent checks on one page.

## Fixtures vs page objects
- **Fixtures** (`test.extend`) for setup and teardown that many tests share: a logged-in page, a seeded
  account, a mocked API. They give per-test isolation and clean teardown for free.
- **Page objects** for a page with many interactions reused across files; keep them thin (locators + intent
  methods like `checkout.payWithTestCard()`), and keep assertions in the test, not hidden in the page object.
- Small suites do not need page objects; do not add the abstraction before the repetition is real.

## Authentication
- Log in once in a setup project, save `storageState` to a file under a gitignored folder, and reuse it.
- One storage state per role (admin, member) when roles matter; a multi-user test uses two browser contexts.
- Test credentials come from env or CI secrets. Never commit the storage-state file: it holds live session
  cookies.
- Always keep one test that goes through the real login UI, so the reuse shortcut does not hide a broken login.

## Network and time
- `page.route()` to mock third-party APIs, simulate errors (500, timeout, offline) and slow responses.
- Wait for a specific response (`page.waitForResponse(...)`) or a UI state, not for `networkidle`, which is
  unreliable on apps with polling, analytics or websockets.
- Control time with the clock API (`page.clock`) for timers, countdowns and date-dependent UI.

## API tests
- The `request` fixture tests endpoints without a browser: status code, response schema, auth failure
  (401/403 without or with a wrong token), validation failure (4xx with the error envelope).
- Use API calls to seed state for UI tests; it is faster and less flaky than clicking through setup.

## Visual and accessibility checks
- `toHaveScreenshot()` with dynamic regions masked and fonts/animations stabilised; review baseline updates
  like code.
- An automated axe pass inside Playwright is covered in the `forge-a11y` skill (its axe-and-tools reference).

## Config essentials
- `baseURL`, `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, a `webServer` entry that starts the
  app, and `forbidOnly: !!process.env.CI` so a stray `test.only` fails CI.
- Debug a failure with the trace viewer (`npx playwright show-trace <trace.zip>`) or `--debug` / UI mode locally.
