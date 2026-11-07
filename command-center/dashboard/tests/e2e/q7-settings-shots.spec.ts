/**
 * Q7-SETTINGS — real-browser evidence for the Settings fixes, in Dutch, light and dark, at 360, 768 and 1280 px.
 *
 *   settings-pill     "Je eigen model" for a step the router skips (paid_ack_required): no green "Klaar voor
 *                     gebruik" next to "Testen kan nu niet"; the pill asks for the cost confirmation.
 *   settings-refresh  Testen answers 409 and fires the refresh signal; the re-read now says "paid, not confirmed":
 *                     the cost checkbox appears at once (not after the 20 s provider poll) and the 409 note is
 *                     replaced by the skip note.
 *   settings-gone     the own API is gone (provider_unavailable): the pill says "Niet beschikbaar", the note names all
 *                     three causes (verwijderd, uitgezet of geweigerd) (Q7-FINISH).
 *   settings-spy      scrolled to "Als je limiet op is": the group list marks Accounts, not Algemeen.
 *
 * Never touches a live gateway: every request to 127.0.0.1:4100 / localhost:4100 is answered in-process by
 * `context.route`, web sockets are closed. The page comes from a dev server on its own port (FORGE_SHOTS_ORIGIN).
 * Skipped unless FORGE_SHOTS_ORIGIN is set. Output: Q7_SHOTS (default test-results/q7-shots),
 * `<round>-<case>-<width>-<theme>.png`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page, Route } from '@playwright/test';

const SHOTS = process.env.Q7_SHOTS ?? path.join('test-results', 'q7-shots');
const ROUND = process.env.Q7_ROUND ?? 'r1';
const WIDTHS = [360, 768, 1280] as const;
const THEMES = ['light', 'dark'] as const;

test.skip(SHOTS_ORIGIN === '', 'FORGE_SHOTS_ORIGIN not set: this capture spec needs a dev server on its own port');

type Rec = Record<string, unknown>;

const FIXTURES = path.resolve(process.cwd(), 'tests', 'fixtures', 'app-router');
const fixture = (name: string): Rec => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Rec;

const POST = fixture('post-200.json');
const UNAVAILABLE = fixture('test-409-unusable.json');
const PAID_WARNING = (POST.warnings as Rec[])[0];
const STEP = 'mijn-vllm-qwen';
const PROVIDER = 'custom-mijn-vllm';

const PAID_ROW = { id: PROVIDER, label: 'Mijn vLLM', kind: 'key', key_source: 'vault', state: 'connected' };
const MODELS = { ok: true, providers: { pending: false, list: [{ id: PROVIDER, label: 'Mijn vLLM', status_code: 'ok', models: [{ id: 'qwen2.5-coder:32b' }], models_source: 'live' }] } };

/** What the gateway says: `paid` = the own API now costs per use and the step has no cost confirmation. */
interface World {
  paid: boolean;
  gone?: boolean;
}

const GONE_WARNING = {
  path: 'entries[1]', code: 'provider_unavailable', entry_id: STEP, provider: PROVIDER,
  nl: 'Deze eigen API is verwijderd, uitgezet of geweigerd.', en: 'This own API was removed, switched off or refused.',
};

function statusBody(world: World): Rec {
  const row = (id: string, kind: string, label: string, reason: string | null) => ({
    id, kind, label, enabled: true, eligible: reason === null, ineligible_reason: reason, state: 'ready', max_pct: 12,
    windows: [], measured_at: new Date(Date.now() - 60_000).toISOString(), source: 'test', resume_at: null, capability: kind === 'claude-account' ? 'full' : 'read-answer',
  });
  return {
    ok: true,
    mode: 'claude-then-model',
    entries: [row('main', 'claude-account', 'Hoofdaccount', null), row(STEP, 'provider-model', 'Mijn vLLM · qwen', world.gone ? 'provider_unavailable' : world.paid ? 'paid_ack_required' : null)],
    next: null,
    captured_at: new Date().toISOString(),
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function stub(context: BrowserContext, world: World, onTest?: () => void): Promise<void> {
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.route(/^https?:\/\/(127\.0\.0\.1|localhost):4100\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE', 'access-control-allow-headers': 'content-type' },
      });
    }
    if (p.endsWith('/stream')) return route.abort();
    if (p === '/api/ui-session') return json(route, { ok: true, paired: true });
    if (p === '/api/health') return json(route, { ok: true, instance_id: 'stub', runtime: { state: 'OK' }, claude: { available: true }, execution: { available: true } });
    if (p === '/api/projects') return json(route, { ok: true, projects: [], default_project_id: null });
    if (p === '/api/conversations') return json(route, { ok: true, conversations: [], execution: { available: true, note: null } });
    if (p === '/api/app-router') {
      return json(route, { ok: true, provenance: 'STORED', config: POST.config, warnings: world.gone ? [GONE_WARNING] : world.paid ? [PAID_WARNING] : [], terms: { checked_at: '2026-11-02', sources: [] }, profiles_root_display: '~\\.forge-router\\profiles' });
    }
    if (p === '/api/app-router/status') return json(route, statusBody(world));
    if (/^\/api\/app-router\/targets\/[^/]+\/test$/.test(p)) {
      onTest?.();
      return json(route, { ...UNAVAILABLE, reason: 'paid_ack_required' }, 409);
    }
    if (p === '/api/providers/custom') return json(route, { ok: true, revision: 3, providers: [] });
    if (p === '/api/providers') return json(route, { ok: true, providers: world.paid ? [PAID_ROW] : [{ ...PAID_ROW, kind: 'local', key_source: null }] });
    if (p === '/api/models') return json(route, MODELS);
    if (p === '/api/usage') return json(route, { ok: true, provenance: 'REPORTED', level: 'normal', guard: { available: true, session_pct: 42, week_pct: 18 } });
    return json(route, { ok: true });
  });
}

async function prepare(page: Page, theme: (typeof THEMES)[number], width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript((appearance) => {
    localStorage.setItem('forge.locale', 'nl');
    localStorage.setItem('forge.uiMode', 'eenvoudig');
    localStorage.setItem('forge.prototype.appearance', appearance);
    localStorage.setItem('forge.onboarding.done', '1');
  }, theme);
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}' });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-${name}.png`) });
}

async function noOverflow(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function openOwnModel(page: Page): Promise<void> {
  await page.goto(`${SHOTS_ORIGIN}/#/settings?focus=router`);
  const own = page.locator('[data-row="router-own"]');
  // A step with a problem (a skip) opens its own "Meer info" by itself; open it only when it is still closed.
  const less = own.getByRole('button', { name: 'Minder info' });
  const more = own.getByRole('button', { name: 'Meer info' });
  await expect(less.or(more)).toBeVisible();
  await page.waitForTimeout(300);
  if (await more.isVisible()) await more.click();
  await expect(less).toBeVisible();
}

const BLOCKED = 'Testen kan nu niet: de router slaat deze stap over.';
const PAID_PILL = 'Bevestig dat dit model per gebruik kost.';

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`settings pill of a skipped step ${width} ${theme}`, async ({ page, context }) => {
      await stub(context, { paid: true });
      await prepare(page, theme, width);
      await openOwnModel(page);
      const block = page.locator('[data-block="fallback"]');
      await expect(block.getByText(BLOCKED)).toBeVisible();
      await expect(block.locator('.fs-pill', { hasText: PAID_PILL })).toBeVisible();
      await expect(block.getByText('Klaar voor gebruik')).toHaveCount(0);
      await settle(page);
      await block.locator('.fs-router__status').evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `settings-pill-${width}-${theme}`);
      await noOverflow(page, width);
    });

    test(`settings refresh after a 409 ${width} ${theme}`, async ({ page, context }) => {
      const world: World = { paid: false };
      await stub(context, world, () => {
        world.paid = true;
      });
      await prepare(page, theme, width);
      await openOwnModel(page);
      const block = page.locator('[data-block="fallback"]');
      const ack = block.getByRole('checkbox', { name: /per gebruik kost via mijn eigen sleutel/ });
      await expect(ack).toHaveCount(0);
      await block.getByRole('button', { name: 'Testen' }).click();
      // Well inside the 20 s provider poll: the signal brought it.
      await expect(ack).toBeVisible({ timeout: 4_000 });
      await expect(block.getByText(BLOCKED)).toBeVisible({ timeout: 4_000 });
      await expect(block.getByText(String(UNAVAILABLE.nl))).toHaveCount(0);
      await expect(block.getByText('Klaar voor gebruik')).toHaveCount(0);
      await settle(page);
      await ack.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `settings-refresh-${width}-${theme}`);
      await noOverflow(page, width);
    });

    test(`settings pill of a gone own API ${width} ${theme}`, async ({ page, context }) => {
      await stub(context, { paid: false, gone: true });
      await prepare(page, theme, width);
      await openOwnModel(page);
      const block = page.locator('[data-block="fallback"]');
      await expect(block.locator('.fs-pill', { hasText: 'Niet beschikbaar' })).toBeVisible();
      await expect(page.getByText(/verwijderd, uitgezet of geweigerd/).first()).toBeVisible();
      await expect(page.getByText(/verwijderd of staat uit/)).toHaveCount(0);
      await settle(page);
      await block.locator('.fs-router__status').evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `settings-gone-${width}-${theme}`);
      await noOverflow(page, width);
    });

    test(`settings scroll-spy marks the group in view ${width} ${theme}`, async ({ page, context }) => {
      await stub(context, { paid: false });
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/settings`);
      const toc = page.getByRole('navigation', { name: 'Groepen' });
      await expect(toc.getByRole('link', { name: 'Algemeen' })).toHaveAttribute('aria-current', 'true');
      const mode = page.getByRole('combobox', { name: 'Wat doet Forge dan?' });
      await mode.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await expect(toc.getByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'true');
      await settle(page);
      await shot(page, `settings-spy-${width}-${theme}`);
      await noOverflow(page, width);
    });
  }
}
