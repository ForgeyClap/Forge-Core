/**
 * WP B6 screenshot loop: Settings (Eenvoudig and Uitgebreid, light and dark) and every onboarding
 * step, in Dutch, at 1440x900. Every request to the gateway origin is answered here with
 * real-shaped data (the checkup answer is the one this pc gave on 2026-11-01), so the live gateway
 * is never contacted. Runs against the scratch harness (see _scratch/b6/pw.config.mjs) because the
 * /onboarding route is mounted by WP B4. Output: _scratch/b6/shots/<round>-<name>.png.
 */

import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const ROUND = process.env.SHOT_ROUND ?? 'r1';
const OUT = process.env.SETTINGS_SHOTS ?? path.resolve(process.cwd(), '..', '..', '_scratch', 'b6', 'shots');

const CHECKUP = {
  ok: true,
  checked_at: '2026-11-01T21:16:59.882Z',
  duration_ms: 1840,
  timed_out: false,
  claude: { found: true, version: '2.1.316', signedIn: true },
  codex: { found: true, version: '0.156.1' },
  ollama: { found: true, up: true, models: ['qwen2.5:0.5b'] },
  node: { version: '24.18.0' },
  git: { found: true, version: '2.54.0' },
  disk_free_gb: 202.1,
  port: 4100,
  writable_project_dir: null,
};

interface Variant {
  readonly checkup?: Record<string, unknown>;
}

async function stubGateway(page: Page, variant: Variant = {}): Promise<void> {
  const checkup = { ...CHECKUP, ...(variant.checkup ?? {}) };
  await page.route('http://127.0.0.1:4100/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    switch (url.pathname) {
      case '/api/checkup':
        return json(url.searchParams.get('dir') ? { ...checkup, writable_project_dir: true } : checkup);
      case '/api/health':
        return json({
          ok: true,
          gateway: { project_root: 'C:\\Users\\iemand\\Forge', data_dir: 'C:\\Users\\iemand\\AppData\\Roaming\\forge-systeem', port: 4100 },
          execution: { available: true, cli: 'C:\\Tools\\claude.exe' },
        });
      case '/api/projects':
        return json({ projects: [{ name: 'bakkerij-site', path: 'C:\\Users\\iemand\\Documents\\Forge Projecten\\bakkerij-site', has_dashboard: false }] });
      case '/api/models':
        return json({
          ok: true,
          roles: {
            lead: { model: 'sonnet', why: 'routes the work' },
            build: { model: 'opus', why: 'normal feature or bug fix' },
            verify: { model: 'sonnet', why: 'checks every change' },
          },
        });
      case '/api/usage':
        return json({ ok: true, guard: { available: true, session_pct: 38, week_pct: 12, session_reset_at: '2026-11-01T16:40:00.000Z', week_reset_at: '2026-11-05T09:00:00.000Z' } });
      case '/api/discord/browse-folder': {
        const dir = url.searchParams.get('dir');
        return json(
          dir
            ? { ok: true, path: dir, parent: 'C:\\Users\\iemand\\Documents', folders: ['bakkerij-site', 'offerte-tool'], truncated: false }
            : { ok: true, path: 'C:\\Users\\iemand\\Documents', parent: 'C:\\Users\\iemand', folders: ['Forge Projecten', 'Facturen', 'Foto’s 2026', 'Belasting'], truncated: false },
        );
      }
      default:
        return json({});
    }
  });
}

async function prepare(page: Page, mode: 'eenvoudig' | 'uitgebreid', theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.addInitScript(
    ([uiMode, appearance]) => {
      localStorage.setItem('forge.locale', 'nl');
      localStorage.setItem('forge.uiMode', uiMode);
      localStorage.setItem('forge.prototype.appearance', appearance);
      localStorage.setItem('forge.onboarding.done', '1');
    },
    [mode, theme] as const,
  );
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}' });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${ROUND}-${name}.png`) });
}

async function scrollTo(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
}

test.describe('settings', () => {
  test('Eenvoudig, light', async ({ page }) => {
    await stubGateway(page);
    await prepare(page, 'eenvoudig');
    await page.goto('/#/settings');
    await expect(page.locator('#fs-set-title')).toBeVisible();
    await expect(page.locator('[data-provider="claude"]')).toContainText('Verbonden');
    await settle(page);
    await shot(page, 'settings-eenvoudig-top');
    await scrollTo(page, '#fs-group-veiligheid');
    await shot(page, 'settings-eenvoudig-veiligheid');
    await scrollTo(page, '#fs-group-privacy');
    await shot(page, 'settings-eenvoudig-privacy');
    await expect(page.getByText(/poort/i)).toHaveCount(0);
  });

  test('Eenvoudig, check open with problems', async ({ page }) => {
    await stubGateway(page, {
      checkup: { claude: { found: true, version: '2.1.316', signedIn: false }, ollama: { found: true, up: false, models: [] }, git: { found: false, version: null } },
    });
    await prepare(page, 'eenvoudig');
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'Controleer of alles werkt' }).click();
    await page.getByRole('button', { name: 'Inloggen' }).first().click();
    await settle(page);
    await shot(page, 'settings-eenvoudig-check');
  });

  test('Uitgebreid, light', async ({ page }) => {
    await stubGateway(page);
    await prepare(page, 'uitgebreid');
    await page.goto('/#/settings');
    await expect(page.locator('#fs-group-diagnose')).toBeVisible();
    await settle(page);
    await shot(page, 'settings-uitgebreid-top');
    await scrollTo(page, '#fs-group-modellen');
    await shot(page, 'settings-uitgebreid-modellen');
    await scrollTo(page, '#fs-group-diagnose');
    await shot(page, 'settings-uitgebreid-diagnose');
    await page.getByRole('button', { name: 'Diagnose kopiëren' }).click();
    await settle(page);
    await shot(page, 'settings-uitgebreid-diagnose-dialog');
  });

  test('Eenvoudig, dark', async ({ page }) => {
    await stubGateway(page);
    await prepare(page, 'eenvoudig', 'dark');
    await page.goto('/#/settings');
    await expect(page.locator('[data-provider="claude"]')).toContainText('Verbonden');
    await settle(page);
    await shot(page, 'settings-eenvoudig-dark');
    await scrollTo(page, '#fs-group-veiligheid');
    await shot(page, 'settings-eenvoudig-dark-veiligheid');
  });

  test('Algemeen: theme, language, Weergave and the tour replay (redesign: no settings search)', async ({ page }) => {
    await stubGateway(page);
    await prepare(page, 'eenvoudig');
    await page.goto('/#/settings');
    await expect(page.getByRole('radiogroup', { name: 'Thema' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Taal' })).toBeVisible();
    // The old settings search left with the redesign: nothing may offer it again unnoticed.
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await settle(page);
    await shot(page, 'settings-algemeen');
    await page.getByRole('button', { name: 'Rondleiding opnieuw bekijken' }).click();
    await expect(page.locator('.fw-tour')).toBeVisible({ timeout: 15_000 });
    await settle(page);
    await shot(page, 'settings-tour-replay');
  });
});

test.describe('onboarding', () => {
  test('every step, then the tour (redesign: one route with four steps)', async ({ page }) => {
    await stubGateway(page, { checkup: { claude: { found: true, version: '2.1.316', signedIn: false } } });
    await prepare(page, 'eenvoudig');
    await page.goto('/#/onboarding');
    const steps: [string, string][] = [
      ['Alles klaar op deze pc', 'onboarding-1-welkom'],
      ['Waarmee wil je werken?', 'onboarding-2-kies'],
      ['Open Claude Code om in te loggen', 'onboarding-3-verbinden'],
      ['Klaar om te beginnen', 'onboarding-4-klaar'],
    ];
    for (const [index, [title, name]] of steps.entries()) {
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Stappen' }).getByRole('listitem')).toHaveCount(4);
      await settle(page);
      await shot(page, name);
      if (index < steps.length - 1) await page.getByRole('button', { name: /^Verder/ }).click();
    }
    // "Laat me rondkijken" starts the 3-stop tour on Start; it is offered, never forced.
    await page.getByRole('button', { name: 'Laat me rondkijken' }).click();
    const card = page.locator('.fw-tour');
    for (const stop of [1, 2, 3]) {
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText(`${stop} van 3`);
      await settle(page);
      await shot(page, `tour-stop-${stop}`);
      await card.getByRole('button', { name: stop === 3 ? /^Klaar/ : /^Volgende/ }).click();
    }
    await expect(card).toHaveCount(0);
  });
});
