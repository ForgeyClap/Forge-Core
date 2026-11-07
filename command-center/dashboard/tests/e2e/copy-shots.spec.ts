/**
 * Redesign (4A): the inspector and dock tests now cover the merged Details pane (Uitgebreid only,
 * opened from the ... menu) and the usage test covers the quiet usage line above the composer. The
 * shell's top bar is `.fw-bar`. Runs on a scratch build (B3_COPY_DIST) or a dev server (FORGE_SHOTS_ORIGIN).
 *
 * WP B3-copy — screenshot loop for the mixed-language gaps: the lazy-screen fallback (both end
 * states), the zijpaneel (inspector) in Eenvoudig and Uitgebreid, the onderpaneel (dock) tabs and
 * empty states, and the usage pill against the chat helper text at 390 px.
 *
 * WHAT IS MOCKED (never a live gateway): every `/api/*` call on 127.0.0.1:4100 is answered
 * in-process by `context.route`; the dashboard build under test is served from B3_COPY_DIST by a
 * throwaway static server. The "stuck" fallback is produced by never answering the request for the
 * Home screen's code chunk; the "offline" fallback additionally refuses every gateway request.
 *
 * Fail-closed: a screenshot run (B3_COPY_DIST set or B3_REQUIRED=1) without a usable build FAILS;
 * the default e2e suite sets neither and skips this file.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page } from '@playwright/test';

const DIST = process.env.B3_COPY_DIST ?? '';
const SHOTS = process.env.B3_SHOTS ?? path.join('test-results', 'b3-copy-shots');
const ROUND = process.env.B3_ROUND ?? 'r1';
const GATEWAY = 'http://127.0.0.1:4100';
const PROJECT = 'bakkerij-website';

const REQUIRED = SHOTS_ORIGIN !== '' || DIST !== '' || process.env.B3_REQUIRED === '1';
test.skip(!REQUIRED, 'not a B3-copy screenshot run (B3_COPY_DIST and B3_REQUIRED unset)');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

let server: http.Server | undefined;
let origin = '';

test.beforeAll(async () => {
  if (SHOTS_ORIGIN !== '') {
    // Redesign 4A: a dev server on its own port (FORGE_SHOTS_ORIGIN) replaces the scratch-build server.
    origin = SHOTS_ORIGIN;
    fs.mkdirSync(SHOTS, { recursive: true });
    return;
  }
  const root = path.resolve(DIST);
  if (DIST === '' || !fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`B3-copy screenshot run without a scratch build: ${DIST || 'B3_COPY_DIST is not set'}`);
  }
  const created = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const target = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
  fs.mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  const running = server;
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function mockGateway(context: BrowserContext, usagePct = 42): Promise<void> {
  await context.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE', 'access-control-allow-headers': 'content-type,x-cc-exec-token' } });
    }
    if (p.endsWith('/stream')) return route.abort();
    if (p === '/api/health') return route.fulfill(json({ ok: true, instance_id: 'mock', runtime: { state: 'OK' }, claude: { available: true } }));
    if (p === '/api/projects') {
      return route.fulfill(
        json({
          ok: true,
          projects: [
            { name: PROJECT, path: 'C:/Users/Sanne/Documents/Forge Projecten/bakkerij-website', kind: 'unknown' },
          ],
          default_project_id: PROJECT,
        }),
      );
    }
    if (p === '/api/usage') {
      return route.fulfill(
        json({
          ok: true,
          provenance: 'REPORTED',
          level: 'normal',
          week: 18,
          updated_at: minutesAgo(2),
          guard: { available: true, session_pct: usagePct, week_pct: 18, session_reset_at: new Date(Date.now() + 95 * 60_000).toISOString() },
        }),
      );
    }
    if (p === '/api/conversations' && req.method() === 'GET') {
      return route.fulfill(json({ ok: true, conversations: [], execution: { available: true, note: null } }));
    }
    return route.fulfill(json({ ok: true }));
  });
}

interface OpenOptions {
  readonly mode?: 'eenvoudig' | 'uitgebreid';
  readonly offline?: boolean;
  /** Never answer the request for this lazy screen's chunk (e.g. 'HomeView'). */
  readonly hangChunk?: string;
  /** The 5-hour percentage the stubbed usage reading reports. */
  readonly usagePct?: number;
}

async function open(page: Page, hash: string, options: OpenOptions = {}): Promise<void> {
  await page.addInitScript((mode) => {
    localStorage.setItem('forge.locale', 'nl');
    localStorage.setItem('forge.uiMode', mode);
    localStorage.setItem('forge.onboarding.done', '1');
  }, options.mode ?? 'eenvoudig');
  if (options.offline) {
    await page.context().route(`${GATEWAY}/**`, (route) => route.abort('connectionrefused'));
  } else {
    await mockGateway(page.context(), options.usagePct);
  }
  if (options.hangChunk) {
    // A built chunk (`/assets/HomeView-<hash>.js`) or, on a dev server, the module itself (`/HomeView.tsx`).
    const pattern = new RegExp(`(/assets/${options.hangChunk}-[^/]+\\.js|/${options.hangChunk}\\.tsx)(\\?[^/]*)?$`);
    // Left unanswered on purpose: the chunk never arrives, so the Suspense fallback stays up.
    await page.route(pattern, () => undefined);
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(`${origin}/#${hash}`);
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${ROUND}-${name}.png`) });

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The visible text of a region, with log data (`data-log-*`) and machine boxes left out. */
async function copyText(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((root) => {
    const clone = root.cloneNode(true) as Element;
    clone.querySelectorAll('[data-log-text], [data-log-name], pre').forEach((node) => node.remove());
    return clone.textContent ?? '';
  });
}

const ENGLISH = /\b(the|and|with|your|nothing|selected|record|open in|loading|view|activity feed|notices|events|proof|evidence|gateway|run)\b/i;

for (const width of [1440, 390] as const) {
  const height = width === 1440 ? 900 : 844;

  test(`fallback: stuck end state after 8 s at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, '/', { hangChunk: 'HomeView' });
    await expect(page.getByText('Scherm wordt geladen…')).toBeVisible({ timeout: 15_000 });
    await shot(page, `fallback-loading-${width}`);
    await expect(page.getByText('Dit scherm laadt niet.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Opnieuw verbinden' })).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, `fallback-stuck-${width}`);
  });

  test(`fallback: offline end state at once at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, '/', { hangChunk: 'HomeView', offline: true });
    await expect(page.locator('.fw-route-fallback[data-state="offline"]')).toBeVisible({ timeout: 20_000 });
    await noHorizontalOverflow(page);
    await shot(page, `fallback-offline-${width}`);
  });

  for (const mode of ['eenvoudig', 'uitgebreid'] as const) {
    test(`details pane (${mode}) at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, '/projects', { mode });
      await expect(page.locator('.fw-bar')).toBeVisible({ timeout: 20_000 });
      const more = page.getByRole('button', { name: 'Meer opties' });
      if (mode === 'eenvoudig') {
        // Redesign: Details is a power-user view; Eenvoudig has no way to open it.
        await expect(page.getByRole('heading', { level: 1, name: 'Mijn projecten' })).toBeVisible({ timeout: 20_000 });
        await expect(more).toHaveCount(0);
        await expect(page.locator('.fw-pane')).toHaveCount(0);
        await noHorizontalOverflow(page);
        await shot(page, `details-none-eenvoudig-${width}`);
        return;
      }
      // Open a project so the pane has something to show, then open the pane from the ... menu.
      await page.getByRole('region', { name: 'Alle projecten' }).getByRole('button', { name: PROJECT, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible({ timeout: 20_000 });
      // Choosing a project can already open the pane; otherwise open it from the ... menu.
      if ((await page.locator('.fw-pane').count()) === 0) {
        await more.click();
        await page.getByRole('menuitem', { name: 'Details tonen' }).click();
      }
      const pane = page.locator('.fw-pane');
      await expect(pane).toBeVisible();
      await expect(pane.getByRole('heading', { level: 3, name: PROJECT })).toBeVisible({ timeout: 15_000 });
      const text = await copyText(page, '.fw-pane');
      expect(text).toContain('Soort');
      expect(text).toContain('Aantallen');
      await noHorizontalOverflow(page);
      await shot(page, `details-project-uitgebreid-${width}`);
    });
  }

  test(`details pane: Logboek tab and empty states at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, '/projects', { mode: 'uitgebreid' });
    await expect(page.locator('.fw-bar')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Meer opties' }).click();
    await page.getByRole('menuitem', { name: 'Details tonen' }).click();
    const pane = page.locator('.fw-pane');
    await expect(pane).toBeVisible();
    await pane.getByRole('tab', { name: 'Logboek' }).click();
    await expect(pane.getByRole('tab', { name: 'Logboek', selected: true })).toBeVisible();
    expect(await copyText(page, '.fw-pane')).not.toMatch(ENGLISH);
    await noHorizontalOverflow(page);
    await shot(page, `details-logboek-${width}`);
  });

  test(`usage line vs chat helper text at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, '/chat', { usagePct: 87 });
    const helper = page.locator('p', { hasText: 'Forge werkt alleen in de map' });
    await expect(helper.first()).toBeVisible({ timeout: 25_000 });
    // Redesign: the corner pill is gone; at 80 % or more a quiet line sits above the composer.
    const line = page.getByRole('status', { name: 'Gebruik' });
    await expect(line).toContainText('Je limiet is bijna op (87 %).', { timeout: 25_000 });
    await page.waitForTimeout(400);
    await shot(page, `usage-line-chat-${width}`);
    const a = await line.boundingBox();
    const hints = await helper.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    );
    expect(a).not.toBeNull();
    if (a) {
      for (const b of hints) {
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `usage line ${JSON.stringify(a)} overlaps helper ${JSON.stringify(b)}`).toBe(false);
      }
      expect(a.x + a.width).toBeLessThanOrEqual(width);
    }
    expect(await copyText(page, '[aria-label="Gebruik"]')).not.toMatch(/usage|session|guard|normal/i);
    await noHorizontalOverflow(page);
  });
}
