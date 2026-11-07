# forge-a11y — axe and other tools

Use what the project already has installed. Adding a dev dependency (`@axe-core/playwright`, `@axe-core/cli`)
is a normal project change; say so in the work report. Never install tools globally for the owner.

## axe inside Playwright (preferred: it becomes a regression test)
```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('home page has no critical a11y violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('#third-party-chat') // only with a written reason
    .analyze();
  const blocking = results.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''));
  expect(blocking, JSON.stringify(blocking.map(v => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([]);
});
```
- Run it per state too: open the modal, show the validation errors, expand the menu, then analyse.
- `.include('<selector>')` to scope a component test.
- Keep the full `results.violations` as an artefact when it fails; the message shows rule id and node count.

## axe CLI (quick scan of a running site)
`npx @axe-core/cli http://localhost:3000 --tags wcag2a,wcag2aa,wcag22aa` scans one URL in a headless browser.
Run it only against local or owned sites, and only when the package is already a project dependency or the
owner agreed to fetch it. Check the flag names against `--help` of the installed version before relying on them.

## Browser extensions and built-ins
- axe DevTools or Accessibility Insights for manual inspection with highlighted nodes.
- Chrome DevTools: Accessibility pane (computed name and role), Lighthouse a11y category, the contrast picker,
  and "Emulate vision deficiencies" / "prefers-reduced-motion".

## Reading results honestly
- `violations` are failures; `incomplete` needs a human decision (often contrast on images or gradients);
  `passes` do not prove the criterion is met for users.
- Lighthouse's a11y score is a subset of axe rules weighted into a number; never quote it as conformance.
- Automated rules cannot judge alt-text quality, focus order logic, meaningful link text in context, or
  whether a screen reader announcement makes sense.
