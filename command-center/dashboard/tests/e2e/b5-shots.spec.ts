/**
 * WP B5 — screenshot loop for Klussen & bewijs (/jobs), Automatiseringen (/automations),
 * Vaardigheden & koppelingen (/skills) and Mijn projecten (/projects), in Dutch, at 1440x900 and
 * 390x844.
 *
 * Never touches a live gateway: the build under test is a scratch build served from B5_DIST by a
 * throwaway static server, and every request to the gateway origin (http://127.0.0.1:4100) is
 * answered in-process with fixtures in the real gateway shapes. Skipped when B5_DIST is not set,
 * so the default e2e suite is unaffected. Shots go to B5_SHOTS (default test-results/b5-shots).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page } from '@playwright/test';

const DIST = process.env.B5_DIST ?? '';
const SHOTS = process.env.B5_SHOTS ?? path.join('test-results', 'b5-shots');
const ROUND = process.env.B5_ROUND ?? 'r1';
const PROJECT = 'bakkerij-website';
const RUN = 'forge-2026-11-01-bakkerij';

test.skip(DIST === '' && SHOTS_ORIGIN === '', 'B5_DIST not set: this screenshot spec only runs on a scratch build');

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

type Variant = 'full' | 'empty' | 'down';

function fixtures(variant: Variant): Record<string, unknown> {
  return {
    '/api/health': { ok: true, runtime: { state: 'OK' }, gateway: { version: '0.1.0', project_root: 'C:\\Forge' } },
    '/api/projects': {
      ok: true,
      projects: [
        { name: PROJECT, path: 'C:\\Users\\iemand\\Documents\\bakkerij-website', kind: null },
        { name: 'menukaart', path: 'C:\\Users\\iemand\\Documents\\menukaart', kind: null },
      ],
      default_project_id: PROJECT,
    },
    [`/api/projects/${PROJECT}/profile`]: { ok: true, canon_version: 'v11', forge_version: 'a1b2c3d4e5', synced_at: minutesAgo(600) },
    '/api/runs':
      variant === 'empty'
        ? { ok: true, runs: [] }
        : {
            ok: true,
            runs: [
              { run_id: RUN, title: 'Website voor bakkerij De Korenaar', status: 'live', started_at: minutesAgo(42), last_work_at: minutesAgo(1), event_count: 48 },
              { run_id: 'forge-2026-10-31-contact', title: 'Contactformulier met kaartje', status: 'stalled', started_at: minutesAgo(1500), last_work_at: minutesAgo(1300) },
              { run_id: 'forge-2026-10-30-menu', title: 'Menukaart als pdf', status: 'finalized', finalized: true, started_at: minutesAgo(3000), last_work_at: minutesAgo(2900) },
              { run_id: 'forge-2026-10-28-logo', title: 'Logo in drie formaten', status: 'failed', started_at: minutesAgo(6000), last_work_at: minutesAgo(5900) },
            ],
            current_run: RUN,
          },
    '/api/pending-asks': { ok: true, pending_asks: [{ id: 'a1', conversation_id: 'c1', question_count: 1 }] },
    '/api/missions': {
      ok: true,
      wps: [
        { id: 'W1', wp_id: 'w1', note: 'Inschatting en plan', agent: 'Head Chef' },
        { id: 'W2', wp_id: 'w2', note: 'Drie pagina’s bouwen: start, broden, contact', agent: 'Build Boss' },
        { id: 'W3', wp_id: 'w3', note: 'Testen op telefoon en computer', agent: 'Test Boss' },
      ],
      tasks: [
        { agent: 'Head Chef', wp_id: 'w1', status: 'completed', task: 'plan' },
        { agent: 'Build Boss', wp_id: 'w2', status: 'running', task: 'pagina’s' },
        { agent: 'UI Boss', wp_id: 'w2', status: 'completed', task: 'opmaak' },
      ],
      verdicts: [],
    },
    '/api/proof': {
      ok: true,
      verdicts: [
        { source: 'doctor', ok: true, passed: 312, failed: 0 },
        { source: 'event', event_type: 'check_passed', check: 'Unit-tests', agent: 'Verify Boss', evidence: 'test-results/unit.txt', timestamp: minutesAgo(9) },
        { source: 'event', event_type: 'check_failed', check: 'Knop op telefoonformaat', agent: 'Test Boss', evidence: 'shots/home-390.png', timestamp: minutesAgo(3) },
      ],
      reviews: [{ review_id: 'r1', agent: 'Review Boss', verdict: null, subject: 'Opmaak en teksten' }],
      finalize_receipt: null,
    },
    '/api/discord/status': { ok: true, service: { installed: true, running: false, autostart: { setting: false, effective: false, ready: true } } },
    '/api/config': { ok: true, available: true, settings: [{ key: 'nightshift', value: true, status: 'on' }] },
    '/api/skills': {
      ok: true,
      skills: [
        { slug: 'forge-website', name: 'forge-website', description: 'Websites, landingspagina’s en frontend: responsive, vindbaar en toegankelijk.', has_skill_md: true },
        { slug: 'forge-n8n', name: 'forge-n8n', description: 'Automatiseringen in n8n met foutafhandeling en validatie.', has_skill_md: true },
        { slug: 'forge-verify', name: 'forge-verify', description: 'Controleert of een klaar-melding echt klopt met wat er is vastgelegd.', has_skill_md: true },
        { slug: 'forge-rag', name: 'forge-rag', description: null, has_skill_md: true },
        { slug: 'oude-map', name: 'oude-map', description: null, has_skill_md: false },
      ],
      skills_count: 5,
    },
    '/api/mcp': {
      ok: true,
      servers: [
        { id: 'context7', tier: 1, status: 'not-installed', purpose: 'Actuele documentatie van bibliotheken lezen' },
        { id: 'playwright', tier: 2, status: 'not-installed', purpose: 'Een browser besturen voor schermcontroles' },
        { id: 'serena-lsp', tier: 0, status: 'not-installed', purpose: 'Code lezen op deze pc' },
        { id: 'github-write', tier: 3, status: 'not-installed', credentials_needed: true, purpose: 'Wijzigingen naar GitHub schrijven' },
        { id: 'claude-flow', tier: 3, status: 'connected', purpose: 'Coördinatie en geheugen' },
        { id: 'n8n', tier: 3, status: 'connected', credentials_needed: true, purpose: 'Workflows in n8n beheren' },
      ],
      boss_grants: [
        { slug: 'integration-boss', max_tier: 3, allow_servers: ['n8n'] },
        { slug: 'test-boss', max_tier: 2, allow_servers: ['playwright'] },
      ],
      registry_present: true,
    },
    '/api/discord/browse-folder': { ok: true, path: 'C:\\Users\\iemand\\Documents', parent: 'C:\\Users\\iemand', folders: ['bakkerij-website', 'menukaart', 'Nieuwe site'], truncated: false },
  };
}

async function mockGateway(context: BrowserContext, variant: Variant): Promise<void> {
  const data = fixtures(variant);
  await context.route('http://127.0.0.1:4100/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/stream')) return route.abort();
    if (variant === 'down' && url.pathname !== '/api/health') return route.abort('connectionrefused');
    const dir = url.searchParams.get('dir');
    const body =
      url.pathname === '/api/discord/browse-folder' && dir && !dir.endsWith('Documents')
        ? { ok: true, path: dir, parent: 'C:\\Users\\iemand\\Documents', folders: [], truncated: false }
        : (data[url.pathname] ?? { ok: true });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
}

async function open(page: Page, hash: string, mode: 'eenvoudig' | 'uitgebreid', variant: Variant = 'full'): Promise<void> {
  await page.addInitScript((m) => {
    localStorage.setItem('forge.locale', 'nl');
    localStorage.setItem('forge.uiMode', m);
    localStorage.setItem('forge.onboarding.done', '1');
  }, mode);
  await mockGateway(page.context(), variant);
  await page.emulateMedia({ colorScheme: process.env.B5_SCHEME === 'dark' ? 'dark' : 'light' });
  await page.goto(`${origin}/#${hash}`);
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${ROUND}-${name}.png`), fullPage });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name}: horizontal overflow`).toBeLessThanOrEqual(0);
}

test.describe('desktop 1440x900', () => {
  test.beforeEach(async ({ page }) => page.setViewportSize({ width: 1440, height: 900 }));

  test('jobs with detail', async ({ page }) => {
    await open(page, '/jobs', 'uitgebreid');
    // Redesign: the list comes first; the proof opens from "Bekijk bewijs" (no job is pre-selected).
    await expect(page.getByRole('list', { name: 'Klussen van dit project' })).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: 'Bekijk bewijs' }).first().click();
    await expect(page.getByRole('heading', { name: 'Opleverbewijs' })).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('nav a[href$="/jobs"]')).toHaveCount(1);
    await shot(page, 'jobs-1440');
  });

  test('jobs empty and down', async ({ page }) => {
    await open(page, '/jobs', 'uitgebreid', 'empty');
    await expect(page.getByText('Nog geen klussen in dit project')).toBeVisible({ timeout: 25_000 });
    await shot(page, 'jobs-empty-1440');
  });

  test('jobs gateway down', async ({ page }) => {
    await open(page, '/jobs', 'uitgebreid', 'down');
    await expect(page.getByText(/Forge is nu niet bereikbaar|Nog geen project gekozen/).first()).toBeVisible({ timeout: 25_000 });
    await shot(page, 'jobs-down-1440');
  });

  test('automations', async ({ page }) => {
    await open(page, '/automations', 'uitgebreid');
    await expect(page.getByText(/Aan in bakkerij-website/)).toBeVisible({ timeout: 25_000 });
    await shot(page, 'automations-1440');
  });

  test('skills', async ({ page }) => {
    await open(page, '/skills', 'uitgebreid');
    await expect(page.getByText('5 vaardigheden')).toBeVisible({ timeout: 25_000 });
    await shot(page, 'skills-1440');
  });

  test('projects (Eenvoudig) with the add panel, both tabs', async ({ page }) => {
    await open(page, '/projects', 'eenvoudig');
    await expect(page.getByRole('heading', { name: 'Mijn projecten', level: 1 })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('region', { name: 'Alle projecten' })).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('nav a[href$="/jobs"]')).toHaveCount(0);
    await shot(page, 'projects-1440');
    await page.getByRole('main').getByRole('button', { name: 'Nieuw project' }).click();
    await shot(page, 'projects-add-new-1440');
    await page.getByRole('radio', { name: 'Bestaande map' }).click();
    await page.getByRole('button', { name: 'Nieuwe site' }).click();
    await page.getByRole('button', { name: 'Deze map gebruiken' }).click();
    await page.getByText('Technische details').click();
    await shot(page, 'projects-add-existing-1440');
  });
});

test.describe('phone 390x844', () => {
  test.beforeEach(async ({ page }) => page.setViewportSize({ width: 390, height: 844 }));

  test('jobs list then detail', async ({ page }) => {
    await open(page, '/jobs', 'uitgebreid');
    await expect(page.getByText('Website voor bakkerij De Korenaar')).toBeVisible({ timeout: 25_000 });
    await shot(page, 'jobs-390', true);
    await page.getByText('Website voor bakkerij De Korenaar').click();
    await expect(page.getByRole('heading', { name: 'Opleverbewijs' })).toBeVisible();
    await shot(page, 'jobs-detail-390', true);
  });

  test('automations', async ({ page }) => {
    await open(page, '/automations', 'uitgebreid');
    await expect(page.getByText(/Aan in bakkerij-website/)).toBeVisible({ timeout: 25_000 });
    await shot(page, 'automations-390', true);
  });

  test('skills', async ({ page }) => {
    await open(page, '/skills', 'uitgebreid');
    await expect(page.getByText('5 vaardigheden')).toBeVisible({ timeout: 25_000 });
    await shot(page, 'skills-390', true);
  });

  test('projects', async ({ page }) => {
    await open(page, '/projects', 'eenvoudig');
    await expect(page.getByRole('region', { name: 'Alle projecten' })).toBeVisible({ timeout: 25_000 });
    await page.getByRole('main').getByRole('button', { name: 'Nieuw project' }).click();
    await shot(page, 'projects-390', true);
  });
});
