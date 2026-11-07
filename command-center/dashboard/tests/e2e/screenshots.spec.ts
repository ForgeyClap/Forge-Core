/**
 * The screenshot deliverables.
 *
 * Real captures of the running prototype, written to artifacts/screenshots/ (or SHOTS_OUT).
 * Run: npm run shots      (then: node scripts/build-gallery.cjs)
 *
 * WP7b: `open()` waits on `'domcontentloaded'`, not `'networkidle'` - the
 * gateway integration holds a genuinely long-lived `EventSource` open while a
 * run/conversation is selected, which `networkidle` never resolves against.
 * The explicit `#root` non-empty check plus `settle()`'s own wait already
 * guarantee the capture happens after real content has rendered.
 *
 * Redesign (4A): these are CAPTURE specs (no pixel baselines exist in the repo). They now cover
 * the redesigned screens and states: Start, Mijn projecten, a chat, Leer Forge, the 3-stop tour, the `?`
 * menu, the narrow-window drawer and Instellingen, in light and dark. With `FORGE_SHOTS_ORIGIN` set (a
 * dev server on its own port) the gateway is stubbed in the browser (`stubGateway`), so nothing reaches
 * a real gateway. Without it the spec runs against the real gateway on `baseURL`, as before.
 *
 * MODE (POL-C): every shot is taken in the mode a beginner actually sees,
 * the app default Eenvoudig (`DEFAULT_UI_MODE` in src/state/ui-mode.ts), unless it is part of the
 * separate Uitgebreid pass; those files carry a `-uitgebreid` suffix. Two guards keep it that way:
 * tests/unit/screenshots-spec-mode.test.ts (the default here equals the app default) and `shot()` below
 * (a file name says `-uitgebreid` exactly when the page really runs in Uitgebreid).
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { SHOTS_ORIGIN, STUB_GATEWAY_ORIGIN, stubGateway } from './live-gateway-helpers';

type CaptureMode = 'eenvoudig' | 'uitgebreid';

/** Must equal DEFAULT_UI_MODE in src/state/ui-mode.ts (tests/unit/screenshots-spec-mode.test.ts). */
const CAPTURE_DEFAULT_MODE: CaptureMode = 'eenvoudig';
const ADVANCED_SUFFIX = '-uitgebreid';

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
/** The narrowest phone width the layout promises (POL-B F4: the Uitgebreid composer must wrap here). */
const NARROW = { width: 360, height: 780 };
const OUT = process.env.SHOTS_OUT ?? 'artifacts/screenshots';

/** Freeze the interface so a capture is byte-stable between runs. */
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      /* the streaming caret and any status pulse must not blink mid-capture */
      .fw-caret, .fw-pulse { opacity: 1 !important; animation: none !important; }
    `,
  });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(350);
}

interface OpenOptions {
  readonly mode?: CaptureMode;
  readonly storage?: Record<string, string>;
  /** Extra gateway routes, registered after the stub so they answer first (Playwright runs the newest route first). */
  readonly beforeGoto?: (page: Page) => Promise<void>;
}

async function open(page: Page, route: string, theme: 'dark' | 'light', options: OpenOptions = {}): Promise<void> {
  if (SHOTS_ORIGIN !== '') await stubGateway(page.context());
  if (options.beforeGoto) await options.beforeGoto(page);
  await page.addInitScript(
    ([appearance, mode, extra]) => {
      localStorage.setItem('forge.prototype.appearance', appearance as string);
      localStorage.setItem('forge.locale', 'nl');
      localStorage.setItem('forge.uiMode', mode as string);
      localStorage.setItem('forge.onboarding.done', '1');
      for (const [key, value] of Object.entries(extra as Record<string, string>)) localStorage.setItem(key, value);
    },
    [theme, options.mode ?? CAPTURE_DEFAULT_MODE, options.storage ?? {}] as const,
  );
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${SHOTS_ORIGIN}/#${route}`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#root')).not.toBeEmpty();
  // On a narrow window the sidebar is a drawer: present in the page, shown only once opened.
  await expect(page.locator('.fw-side')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.fw-route-fallback')).toHaveCount(0, { timeout: 20_000 });
  await settle(page);
}

/**
 * Saves the shot, after checking that its name tells the truth about the mode: `-uitgebreid` exactly
 * when the page runs in Uitgebreid, so a gallery can never again pass Uitgebreid off as what a
 * beginner sees.
 */
async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  const mode = await page.evaluate(() => localStorage.getItem('forge.uiMode'));
  expect(name.endsWith(ADVANCED_SUFFIX), `shot "${name}" was taken in mode "${mode}"`).toBe(mode === 'uitgebreid');
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

/* --------------------------------------- desktop, both themes, Eenvoudig (what a beginner sees) */

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ viewport: DESKTOP });

    // The Eenvoudig destinations (DESIGN.md §2): Start, Mijn projecten, a chat, Leer Forge, Instellingen.
    const desktopShots: [string, string, string][] = [
      ['01', '/', 'start-desktop'],
      ['02', '/projects', 'projects-desktop'],
      ['03', '/chat', 'chat-desktop'],
      ['09', '/learn', 'leer-forge-desktop'],
      ['10', '/settings', 'settings-desktop'],
    ];

    for (const [n, route, name] of desktopShots) {
      test(`${n} ${name}`, async ({ page }) => {
        await open(page, route, theme);
        await shot(page, `${n}-${theme}-${name}`);
      });
    }

    test('11 settings, accounts section', async ({ page }) => {
      await open(page, '/settings', theme);
      await page.locator('#fs-group-accounts').evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await settle(page);
      await shot(page, `11-${theme}-settings-accounts`);
    });

    test('12 Leer Forge, second lesson open', async ({ page }) => {
      await open(page, '/learn', theme);
      await page.locator('.fs-learn__item').nth(1).click();
      await expect(page.locator('.fs-learn__item').nth(1)).toHaveAttribute('aria-current', 'step');
      await settle(page);
      await shot(page, `12-${theme}-leer-forge-lesson-2`);
    });

    test('13 the ? menu and the lesson pane', async ({ page }) => {
      await open(page, '/', theme);
      await page.getByRole('button', { name: 'Hulp en uitleg' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await shot(page, `13-${theme}-help-menu`);
      await page.getByRole('menuitem').first().click();
      await expect(page.locator('.fw-pane')).toBeVisible();
      await settle(page);
      await shot(page, `14-${theme}-lesson-pane`);
    });

    test('15 the 3-stop tour', async ({ page }) => {
      await open(page, '/', theme, { storage: { 'forge.tour': 'pending' } });
      const card = page.locator('.fw-tour');
      for (const stop of [1, 2, 3]) {
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card).toContainText(`${stop} van 3`);
        await settle(page);
        await shot(page, `15-${theme}-tour-stop-${stop}`);
        await card.getByRole('button', { name: stop === 3 ? /^Klaar/ : /^Volgende/ }).click();
      }
      await expect(card).toHaveCount(0);
    });

    test('16 onboarding, the four steps', async ({ page }) => {
      test.skip(SHOTS_ORIGIN === '', 'the checkup answer is stubbed; only with FORGE_SHOTS_ORIGIN');
      await open(page, '/onboarding', theme, {
        beforeGoto: async (p) => {
          await p.context().route(`${STUB_GATEWAY_ORIGIN}/api/checkup**`, (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              headers: { 'access-control-allow-origin': '*' },
              body: JSON.stringify({
                ok: true,
                checked_at: '2026-11-04T09:00:00.000Z',
                duration_ms: 1800,
                timed_out: false,
                claude: { found: true, version: '2.1.316', signedIn: false },
                codex: { found: true, version: '0.156.1' },
                ollama: { found: false, up: false, models: [] },
                node: { version: '24.18.0' },
                git: { found: true, version: '2.54.0' },
                disk_free_gb: 202.1,
                port: 4100,
                writable_project_dir: null,
              }),
            }),
          );
        },
      });
      const titles = ['Alles klaar op deze pc', 'Waarmee wil je werken?', 'Open Claude Code om in te loggen', 'Klaar om te beginnen'];
      for (const [index, title] of titles.entries()) {
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });
        await settle(page);
        await shot(page, `16-${theme}-onboarding-step-${index + 1}`);
        if (index < titles.length - 1) await page.getByRole('button', { name: /^Verder/ }).click();
      }
    });

    test('17 Start while the gateway is still connecting', async ({ page }) => {
      test.skip(SHOTS_ORIGIN === '', 'the connecting state needs the stubbed gateway (FORGE_SHOTS_ORIGIN)');
      await open(page, '/', theme, {
        // The health check never answers, so the connection stays CONNECTING (POL-B F5 placeholders).
        beforeGoto: async (p) => {
          await p.context().route(`${STUB_GATEWAY_ORIGIN}/api/health**`, () => new Promise<void>(() => {}));
        },
      });
      await expect(page.locator('[data-step-pending]').first()).toBeVisible({ timeout: 15_000 });
      await shot(page, `17-${theme}-start-connecting-desktop`);
      await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    });
  });
}

/* ------------------------------------------ desktop, both themes, the separate Uitgebreid pass */

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme, Uitgebreid`, () => {
    test.use({ viewport: DESKTOP });

    const advancedShots: [string, string, string][] = [
      ['01', '/', 'start-desktop'],
      ['02', '/projects', 'projects-desktop'],
      ['03', '/chat', 'chat-desktop'],
      ['04', '/project', 'project-overview-desktop'],
      ['05', '/mission', 'overview-desktop'],
      ['06', '/agents', 'agents-desktop'],
      ['07', '/tasks', 'tasks-desktop'],
      ['08', '/tests', 'checks-and-proof-desktop'],
      ['09', '/learn', 'leer-forge-desktop'],
      ['10', '/settings', 'settings-desktop'],
    ];

    for (const [n, route, name] of advancedShots) {
      test(`${n} ${name} (Uitgebreid)`, async ({ page }) => {
        await open(page, route, theme, { mode: 'uitgebreid' });
        await shot(page, `${n}-${theme}-${name}${ADVANCED_SUFFIX}`);
      });
    }

    test('18 the Uitgebreid sidebar scrolled to its last entries', async ({ page }) => {
      await open(page, '/', theme, { mode: 'uitgebreid' });
      const last = page.locator('.fw-side').getByText('Bestanden & wijzigingen');
      await last.scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, `18-${theme}-sidebar-end-desktop${ADVANCED_SUFFIX}`);
    });
  });
}

/* --------------------------------------------------------------- mobile, both themes */

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme, mobile`, () => {
    test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

    test(`20 chat mobile (${theme})`, async ({ page }) => {
      await open(page, '/chat', theme);
      await shot(page, `20-${theme}-chat-mobile`);
    });

    test(`21 start with the drawer open (${theme})`, async ({ page }) => {
      await open(page, '/', theme);
      await page.locator('.fw-bar__drawer').click();
      await expect(page.locator('.fw-side')).toBeVisible();
      await settle(page);
      await shot(page, `21-${theme}-drawer-mobile`);
    });

    test(`22 Leer Forge mobile (${theme})`, async ({ page }) => {
      await open(page, '/learn', theme);
      await shot(page, `22-${theme}-leer-forge-mobile`);
    });

    test(`23 tour mobile (${theme})`, async ({ page }) => {
      await open(page, '/', theme, { storage: { 'forge.tour': 'pending' } });
      await expect(page.locator('.fw-tour')).toBeVisible({ timeout: 15_000 });
      await settle(page);
      await shot(page, `23-${theme}-tour-mobile`);
    });
  });

  test.describe(`${theme} theme, 360 px, Uitgebreid`, () => {
    test.use({ viewport: NARROW, isMobile: true, hasTouch: true });

    // POL-B F4: the Uitgebreid composer (scope line, key hint, chips) must wrap, not clip, at 360 px.
    test(`24 Start at 360 px, Uitgebreid (${theme})`, async ({ page }) => {
      await open(page, '/', theme, { mode: 'uitgebreid' });
      await shot(page, `24-${theme}-start-360-mobile${ADVANCED_SUFFIX}`);
    });

    test(`25 chat at 360 px, Uitgebreid (${theme})`, async ({ page }) => {
      await open(page, '/chat', theme, { mode: 'uitgebreid' });
      await shot(page, `25-${theme}-chat-360-mobile${ADVANCED_SUFFIX}`);
    });
  });
}

/* ------------------------------------------------------------- showcase */

test.describe('theme showcase', () => {
  test.use({ viewport: DESKTOP });

  test('30 theme showcase dark', async ({ page }) => {
    await open(page, '/theme', 'dark');
    await shot(page, '30-dark-theme-showcase', true);
  });

  test('31 theme showcase light', async ({ page }) => {
    await open(page, '/theme', 'light');
    await shot(page, '31-light-theme-showcase', true);
  });
});
