/**
 * WP B4 — screenshot loop for the Team screen (/team, Uitgebreid) and the team strip in the chat
 * (Eenvoudig). Runs in Dutch.
 *
 * Never touches a live gateway: the dashboard build under test is served from a folder given in
 * B4_DIST (a scratch build, not dashboard/dist) by a throwaway static server on a free port, and
 * every request to the hardcoded gateway origin (http://127.0.0.1:4100) is answered in-process by
 * `context.route` with fixtures in the real gateway shapes. Skipped when B4_DIST is not set, so the
 * default e2e suite is unaffected. Shots go to B4_SHOTS (default: test-results/b4-shots).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page } from '@playwright/test';

const DIST = process.env.B4_DIST ?? '';
const SHOTS = process.env.B4_SHOTS ?? path.join('test-results', 'b4-shots');
const ROUND = process.env.B4_ROUND ?? 'r1';
const PROJECT = 'bakkerij-website';
const RUN = 'forge-2026-11-01-bakkerij';

test.skip(DIST === '' && SHOTS_ORIGIN === '', 'B4_DIST not set: this screenshot spec only runs on a scratch build');

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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function fixtures(): Record<string, unknown> {
  return {
    '/api/health': { ok: true, runtime: { state: 'OK' }, gateway: { version: '0.1.0' } },
    '/api/projects': { ok: true, projects: [{ name: PROJECT, path: 'C:/Projecten/bakkerij-website', kind: 'website' }], default_project_id: PROJECT },
    '/api/runs': {
      ok: true,
      runs: [
        { run_id: RUN, title: 'Website voor bakkerij De Korenaar', status: 'running', started_at: minutesAgo(42), last_work_at: minutesAgo(1), event_count: 48 },
        { run_id: 'forge-2026-10-30-menu', title: 'Menukaart als pdf', status: 'finalized', started_at: '2026-10-30T09:00:00Z', event_count: 31 },
      ],
      current_run: RUN,
    },
    '/api/active-runs': {
      ok: true,
      active_runs: [{ project: PROJECT, run_id: RUN, title: 'Website voor bakkerij De Korenaar', open_dispatches: 3, working_agents: [] }],
    },
    '/api/agent-dispatches': {
      ok: true,
      dispatches: [
        { source: 'run-log', run_id: RUN, agent: 'Head Chef', agent_slug: 'head-chef', wp_id: 'W1', running: false, completed_at: minutesAgo(38) },
        { source: 'run-log', run_id: RUN, agent: 'Build Boss', agent_slug: 'build-boss', wp_id: 'W2', running: true, completed_at: null },
        { source: 'run-log', run_id: RUN, agent: 'UI Boss', agent_slug: 'ui-boss', wp_id: 'W2', running: true, completed_at: null },
        { source: 'run-log', run_id: RUN, agent: 'Test Boss', agent_slug: 'test-boss', wp_id: 'W3', running: false, stalled: true, completed_at: null },
      ],
    },
    teamChat: {
      ok: true,
      exists: true,
      lines: [
        { ts: minutesAgo(41), from: 'lead', to: 'Build Boss', wp_id: 'W2', kind: 'decision', text: 'Drie pagina\u2019s: start met openingstijden, broden, contact met kaartje. Geen webshop in deze klus.', via: 'direct' },
        { ts: minutesAgo(38), from: 'Head Chef', to: 'lead', wp_id: 'W1', kind: 'message', text: 'Inschatting: 4 stappen, 3 helpers, ongeveer 35 minuten.', via: 'lead' },
        { ts: minutesAgo(30), from: 'Head Chef', to: 'Build Boss', wp_id: 'W2', kind: 'handoff', text: '[Head Chef -> Build Boss] plan staat, bouw de drie pagina\u2019s | wp=W2 | run=' + RUN, via: 'lead' },
        { ts: minutesAgo(12), from: 'UI Boss', to: 'Build Boss', wp_id: 'W2', kind: 'question', text: 'Gebruiken we de foto van de etalage als kop op de startpagina, of het logo?', via: 'direct' },
        { ts: minutesAgo(6), from: 'Build Boss', to: 'UI Boss', wp_id: 'W2', kind: 'message', text: 'De etalagefoto; het logo staat al in de kop. Contactpagina is klaar.', via: 'direct' },
        { ts: minutesAgo(2), from: 'Test Boss', to: 'Build Boss', wp_id: 'W3', kind: 'blocker', text: 'Op telefoonformaat valt de knop \u201cRoute plannen\u201d buiten beeld. Ik wacht tot dat is opgelost.', via: 'direct' },
      ],
      total: 6,
      malformed: 0,
      truncated: false,
    },
  };
}

async function mockGateway(context: BrowserContext): Promise<void> {
  const data = fixtures();
  await context.route('http://127.0.0.1:4100/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/events/stream' || url.pathname.endsWith('/stream')) return route.abort();
    const body = /^\/api\/runs\/[^/]+\/team-chat$/.test(url.pathname) ? data.teamChat : data[url.pathname] ?? { ok: true };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
}

async function open(page: Page, hash: string, mode: 'eenvoudig' | 'uitgebreid'): Promise<void> {
  await page.addInitScript((m) => {
    localStorage.setItem('forge.locale', 'nl');
    localStorage.setItem('forge.uiMode', m);
    // A finished first start (WP B6): the shots are of the daily screens, not the first-start wizard.
    localStorage.setItem('forge.onboarding.done', '1');
  }, mode);
  await mockGateway(page.context());
  // The app follows the system theme by default; B4_SCHEME=dark captures the dark theme.
  await page.emulateMedia({ colorScheme: process.env.B4_SCHEME === 'dark' ? 'dark' : 'light' });
  await page.goto(`${origin}/#${hash}`);
}

test('Team screen (Uitgebreid), 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/team', 'uitgebreid');
  await expect(page.getByText('Vastgepind')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('.fw-team-role')).toHaveCount(12);
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-team-1440.png`) });
  await page.locator('.fw-team').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-team-1440-scrolled.png`) });
});

test('Team screen (Eenvoudig, opened by link), 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/team', 'eenvoudig');
  await expect(page.getByText('Vastgepind')).toBeVisible({ timeout: 25_000 });
  // Eenvoudig: the sidebar has no Team entry, the route itself still opens.
  await expect(page.locator('nav a[href$="/team"]')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-team-eenvoudig-1440.png`) });
});

test('Team screen (Uitgebreid), phone 390x844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/team', 'uitgebreid');
  await expect(page.getByText('Vastgepind')).toBeVisible({ timeout: 25_000 });
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-team-390.png`), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('work strip in the chat (Eenvoudig): four steps and the helpers that are busy, 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/chat', 'eenvoudig');
  // Redesign: Eenvoudig shows the quiet work strip (Plannen, Bouwen, Controleren, Opleveren), not the team's chat.
  const steps = page.getByRole('list', { name: 'Voortgang' });
  await expect(steps).toBeVisible({ timeout: 25_000 });
  await expect(steps.getByRole('listitem')).toHaveCount(4);
  await expect(steps).toContainText('Bouwen');
  await expect(page.getByText('2 helpers bezig')).toBeVisible();
  await expect(page.getByRole('button', { name: /Overleg van het team tonen/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-work-strip-1440.png`) });
});

test('team strip in the chat (Uitgebreid), closed and open, 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/chat', 'uitgebreid');
  const bar = page.getByRole('button', { name: /Overleg van het team tonen/ });
  await expect(bar).toBeVisible({ timeout: 25_000 });
  await expect(bar).toContainText('Bouwer en Ontwerper zijn bezig.');
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-strip-closed-1440.png`) });
  await bar.click();
  await expect(page.getByText('Laatste berichten van het team')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-strip-open-1440.png`) });
  await page.locator('.fw-team-strip').screenshot({ path: path.join(SHOTS, `${ROUND}-strip-open-detail.png`) });
});
