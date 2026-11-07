/**
 * Redesign (part 4A) - automated accessibility check with axe-core on every main route.
 *
 * What it does: opens each main route in the light and the dark theme, with the gateway STUBBED in the
 * browser (`stubGateway`: every request to 127.0.0.1:4100 is answered in process, never sent), runs
 * `@axe-core/playwright` and FAILS on any WCAG 2.x A or AA violation (tags wcag2a, wcag2aa, wcag21a,
 * wcag21aa, wcag22aa). Best-practice rules are collected and printed as an attachment per page but never
 * fail the test, so a style opinion cannot turn the suite red.
 * It also checks the states that only exist after a click: the tour card, the `?` menu and an open lesson.
 *
 * Where it runs: against the origin in `FORGE_SHOTS_ORIGIN` (a vite dev server on its own port, for
 * example `http://127.0.0.1:5473`). Without it the spec is skipped, so the default suite (which serves the
 * built `dist` through the real gateway) never runs it by accident. It never builds into `dist` and never
 * contacts a gateway.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { SHOTS_ORIGIN, stubGateway } from './live-gateway-helpers';

test.skip(SHOTS_ORIGIN === '', 'FORGE_SHOTS_ORIGIN not set: the axe spec only runs against a dev server with a stubbed gateway');

/** Every route of the app a person can reach (App.tsx). The dev-only /theme showcase and the
 *  distribution-stripped /accounts screen are left out on purpose. */
export const MAIN_ROUTES = [
  '/',
  '/projects',
  '/project',
  '/chat',
  '/mission',
  '/agents',
  '/team',
  '/jobs',
  '/automations',
  '/skills',
  '/tasks',
  '/files',
  '/mindmap',
  '/artifacts',
  '/tests',
  '/activity',
  '/discord',
  '/settings',
  '/learn',
  '/onboarding',
] as const;

const BLOCKING_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Theme = 'light' | 'dark';

async function openRoute(page: Page, route: string, theme: Theme, extra: Record<string, string> = {}): Promise<void> {
  await stubGateway(page.context());
  await page.addInitScript(
    ([appearance, storage]) => {
      localStorage.setItem('forge.locale', 'nl');
      localStorage.setItem('forge.uiMode', 'uitgebreid');
      localStorage.setItem('forge.onboarding.done', '1');
      localStorage.setItem('forge.prototype.appearance', appearance as string);
      for (const [key, value] of Object.entries(storage as Record<string, string>)) localStorage.setItem(key, value);
    },
    [theme, extra] as const,
  );
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${SHOTS_ORIGIN}/#${route}`);
  await expect(page.locator('#root')).not.toBeEmpty();
  // The shell and the lazily loaded screen are both on screen before axe looks.
  await expect(page.locator('.fw-side')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main, [role="main"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.fw-route-fallback')).toHaveCount(0, { timeout: 20_000 });
  await page.evaluate(() => document.fonts?.ready);
  // Let the stubbed first reads land so the screen shows its settled state.
  await page.waitForTimeout(500);
}

function describeViolations(violations: { id: string; impact?: string | null; help: string; nodes: { target: unknown; failureSummary?: string }[] }[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `    - ${JSON.stringify(n.target)}\n      ${(n.failureSummary ?? '').replace(/\n\s*/g, ' | ')}`)
        .join('\n');
      return `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})\n${nodes}`;
    })
    .join('\n');
}

async function checkPage(page: Page, label: string): Promise<void> {
  const blocking = await new AxeBuilder({ page }).withTags(BLOCKING_TAGS).analyze();
  const all = await new AxeBuilder({ page }).withTags(['best-practice']).analyze();
  const advisory = all.violations.filter((v) => !blocking.violations.some((b) => b.id === v.id));
  if (advisory.length > 0) {
    await test.info().attach(`best-practice-${label}`, {
      body: `Reported, not failing:\n${describeViolations(advisory)}`,
      contentType: 'text/plain',
    });
  }
  expect(blocking.violations, `WCAG A/AA violations on ${label}:\n${describeViolations(blocking.violations)}`).toEqual([]);
}

test.describe('axe: every main route', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const theme of ['light', 'dark'] as const) {
    for (const route of MAIN_ROUTES) {
      test(`${theme} ${route}`, async ({ page }) => {
        await openRoute(page, route, theme);
        await checkPage(page, `${theme}${route === '/' ? '-start' : route.replace(/\//g, '-')}`);
      });
    }
  }
});

test.describe('axe: states that need a click', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} the tour card (stop 1 of 3)`, async ({ page }) => {
      await openRoute(page, '/', theme, { 'forge.tour': 'pending' });
      await expect(page.locator('.fw-tour')).toBeVisible({ timeout: 15_000 });
      await checkPage(page, `${theme}-tour`);
    });

    test(`${theme} the help menu under the ? button`, async ({ page }) => {
      await openRoute(page, '/', theme);
      await page.getByRole('button', { name: /hulp/i }).first().click();
      await expect(page.getByRole('menu').first()).toBeVisible();
      await checkPage(page, `${theme}-help-menu`);
    });

    test(`${theme} the lesson pane opened from the ? menu`, async ({ page }) => {
      await openRoute(page, '/', theme);
      await page.getByRole('button', { name: /hulp/i }).first().click();
      await page.getByRole('menuitem').first().click();
      await expect(page.locator('.fw-pane').first()).toBeVisible({ timeout: 10_000 });
      await checkPage(page, `${theme}-lesson-pane`);
    });
  }
});

test.describe('wave 4 fix round: dialogs and the palette', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} the command palette search field shows the standard focus ring`, async ({ page }) => {
      await openRoute(page, '/', theme);
      await page.keyboard.press('Control+k');
      const input = page.locator('.fw-palette__input');
      await expect(input).toBeFocused();
      const ring = await input.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--fs-accent)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return { accent, shadow: getComputedStyle(node).boxShadow };
      });
      expect(ring.shadow, 'the focused palette field must draw the --fs-focus ring').toContain(ring.accent);
    });

    test(`${theme} an open dialog adds no second banner landmark`, async ({ page }) => {
      await openRoute(page, '/', theme);
      const row = page.locator('.fw-side__crow').first();
      await row.hover();
      await row.locator('.fw-side__row-action').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      const result = await new AxeBuilder({ page }).withRules(['landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo', 'landmark-unique']).analyze();
      expect(result.violations, describeViolations(result.violations)).toEqual([]);
    });
  }
});

test.describe('axe: narrow window (the drawer)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} start with the drawer open at 390`, async ({ page }) => {
      await stubGateway(page.context());
      await page.addInitScript((appearance) => {
        localStorage.setItem('forge.locale', 'nl');
        localStorage.setItem('forge.onboarding.done', '1');
        localStorage.setItem('forge.prototype.appearance', appearance as string);
      }, theme);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`${SHOTS_ORIGIN}/#/`);
      await page.locator('.fw-bar__drawer').click();
      await expect(page.locator('.fw-side')).toBeVisible();
      await page.waitForTimeout(400);
      await checkPage(page, `${theme}-drawer-390`);
    });
  }
});
