/**
 * WP B3 (cards) — screenshot loop for the new chat cards: permission (single + team group), the
 * status chip in both modes, the plan card, every error card and the shortcut overlay. Dutch.
 *
 * Never touches a gateway: the page under test is a story-like harness build given in CARDS_DIST
 * (built from _scratch/b3/cards/harness with fixture props, zero network calls), served by a
 * throwaway static server on a free port. Shots go to CARDS_SHOTS (default
 * test-results/cards-shots), prefixed with CARDS_ROUND (...).
 *
 * A screenshot run never passes without screenshots: when the run asks for them (CARDS_DIST set, or
 * CARDS_REQUIRED=1, which the scratch config `_scratch/b3/cards/pw.shots.config.mjs` sets) and the
 * build is missing or empty, every test FAILS. Only the default e2e suite, which sets neither, skips
 * this file (it needs a harness build that suite does not make).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DIST = process.env.CARDS_DIST ?? '';
const SHOTS = process.env.CARDS_SHOTS ?? path.join('test-results', 'cards-shots');
const ROUND = process.env.CARDS_ROUND ?? 'r1';

const REQUIRED = DIST !== '' || process.env.CARDS_REQUIRED === '1';

test.skip(!REQUIRED, 'not a cards screenshot run (CARDS_DIST and CARDS_REQUIRED unset)');

/** Why the harness build cannot be used, or null when it can. */
function distProblem(dist: string): string | null {
  if (dist === '') return 'CARDS_DIST is not set';
  const root = path.resolve(dist);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return `CARDS_DIST ${root} does not exist`;
  if (!fs.existsSync(path.join(root, 'index.html'))) return `CARDS_DIST ${root} has no index.html (empty or not built)`;
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

let server: http.Server;
let origin = '';

test.beforeAll(async () => {
  const problem = distProblem(DIST);
  if (problem !== null) throw new Error(`cards screenshot run without a harness build: ${problem}`);
  const root = path.resolve(DIST);
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const target = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fs.mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const SECTIONS = ['perm-single', 'perm-chain', 'perm-group', 'status', 'failed', 'plan', 'errors'] as const;

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('forge.locale', 'nl');
    localStorage.setItem('forge.onboarding.done', '1');
  });
  // Fail closed: an outside request is recorded AND aborted in the browser, so a wrong CARDS_DIST (for
  // example the app build, which reads the gateway) can never reach a live gateway on 127.0.0.1:4100.
  const requests: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    requests.push(url);
    return route.abort('blockedbyclient');
  });
  await page.goto(`${origin}/?${query}`);
  await page.waitForSelector('main');
  expect(requests, 'the harness makes no outside requests').toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const section of SECTIONS) {
      test(`${section}`, async ({ page }) => {
        await open(page, `only=${section}`);
        // Open the technical details on the single card, to check the folded raw command too.
        if (section === 'perm-single') await page.locator('details summary').first().click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'no horizontal overflow').toBeLessThanOrEqual(0);
        await page.screenshot({ path: path.join(SHOTS, `${ROUND}-${viewport.name}-${section}.png`), fullPage: true });
      });
    }

    test('shortcut overlay (Ctrl+/)', async ({ page }) => {
      await open(page, 'only=none&overlay=1');
      await expect(page.getByRole('dialog', { name: 'Sneltoetsen' })).toBeVisible();
      // Let the dialog's entrance transition finish, or the shot catches it half faded in.
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, `${ROUND}-${viewport.name}-shortcuts.png`) });
    });

    test('light theme: permission group and plan card', async ({ page }) => {
      await open(page, 'only=perm-group&theme=light');
      await page.screenshot({ path: path.join(SHOTS, `${ROUND}-${viewport.name}-light-perm-group.png`), fullPage: true });
    });
  });
}
