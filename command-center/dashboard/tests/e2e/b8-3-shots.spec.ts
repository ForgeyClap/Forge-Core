/**
 * WP B8-3 — the screenshot loop for the B8-2 review fixes: the Dutch start screen (HomeView), the
 * project overview, the chat at the default first-launch window (1280x840: the transcript must not be
 * squeezed by a docked inspector), the inspector's empty values and path, and the inspector not
 * re-appearing as an overlay after a resize.
 *
 * WHAT IS MOCKED (never a live gateway): the app runs in desktop mode with its gateway on a port
 * nothing listens on (127.0.0.1:49519), and every request to it is answered in-process by
 * `context.route`. The build under test is served from B83_DIST by a throwaway static server.
 *
 * Fail-closed: B83_DIST set (or B83_REQUIRED=1) without a usable build FAILS; the default e2e suite
 * sets neither and skips this file.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page } from '@playwright/test';

const DIST = process.env.B83_DIST ?? '';
const SHOTS = process.env.B83_SHOTS ?? path.join('test-results', 'b8-3-shots');
const ROUND = process.env.B83_ROUND ?? 'r1';
const SCHEME = process.env.B83_SCHEME === 'dark' ? 'dark' : 'light';
const GATEWAY = 'http://127.0.0.1:49519';
const PROJECT = 'bakkerij-website';
const RUN = 'forge-2026-11-02-bakkerij';

const REQUIRED = SHOTS_ORIGIN !== '' || DIST !== '' || process.env.B83_REQUIRED === '1';
test.skip(!REQUIRED, 'not a B8-3 screenshot run (B83_DIST and B83_REQUIRED unset)');

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
    throw new Error(`B8-3 screenshot run without a scratch build: ${DIST || 'B83_DIST is not set'}`);
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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Turn {
  readonly type: 'turn';
  readonly turn_id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly created_at: string;
}

function conversations() {
  const reply = [
    'Klaar. De drie pagina\u2019s staan in de map **site/**.',
    '',
    '- **Start**: openingstijden, de etalagefoto en een knop naar de broden.',
    '- **Broden**: de vaste broden met prijs, en de taart van de week.',
    '- **Contact**: adres, telefoon en een kaartje met de route.',
    '',
    'Op telefoonformaat staan de openingstijden bovenaan, zodat een klant ze meteen ziet.',
  ].join('\n');
  const one: Turn[] = [
    { type: 'turn', turn_id: 't1', role: 'user', text: 'Maak een website met drie pagina\u2019s: start, broden en contact.', created_at: minutesAgo(40) },
    { type: 'turn', turn_id: 't1', role: 'assistant', text: reply, created_at: minutesAgo(38) },
  ];
  return [
    { id: 'c-site', project: PROJECT, title: 'Website voor bakkerij De Korenaar', updated_at: minutesAgo(6), turns: one },
    { id: 'c-menu', project: PROJECT, title: 'Menukaart als pdf', updated_at: minutesAgo(60 * 26), turns: [one[0]] },
  ];
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) };
}

async function mockGateway(context: BrowserContext): Promise<void> {
  const convs = conversations();
  await context.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE', 'access-control-allow-headers': 'content-type,x-cc-exec-token' } });
    }
    if (p.endsWith('/stream')) return route.abort();
    if (req.method() !== 'GET') return route.fulfill(json({ ok: false, error: 'not in this mock' }, 409));
    if (p === '/api/health') return route.fulfill(json({ ok: true, instance_id: 'mock', runtime: { state: 'OK' }, claude: { available: true } }));
    if (p === '/api/projects') {
      return route.fulfill(
        json({
          ok: true,
          projects: [
            { name: PROJECT, path: 'C:\\Users\\Sanne\\Documents\\Forge Projecten\\68 bakkerij website De Korenaar', kind: 'website' },
            { name: 'kapsalon-boekingen', path: 'C:\\Users\\Sanne\\Documents\\Forge Projecten\\kapsalon-boekingen', kind: 'automation' },
            { name: 'nieuw-project', path: 'C:\\Users\\Sanne\\Documents\\Forge Projecten\\nieuw-project', kind: 'unknown' },
          ],
          default_project_id: PROJECT,
        }),
      );
    }
    if (p === '/api/usage') {
      return route.fulfill(json({ ok: true, provenance: 'REPORTED', level: 'normal', week: 18, updated_at: minutesAgo(2), guard: { available: true, session_pct: 42, week_pct: 18, session_reset_at: new Date(Date.now() + 95 * 60_000).toISOString() } }));
    }
    if (p === '/api/runs') {
      return route.fulfill(json({ ok: true, runs: [{ run_id: RUN, title: 'Website voor bakkerij De Korenaar', status: 'running', started_at: minutesAgo(42), last_work_at: minutesAgo(1), event_count: 48 }], current_run: RUN }));
    }
    if (p === '/api/active-runs') {
      return route.fulfill(json({ ok: true, active_runs: [{ project: PROJECT, run_id: RUN, title: 'Website voor bakkerij De Korenaar', open_dispatches: 1, working_agents: [] }] }));
    }
    if (p === '/api/agent-dispatches') {
      return route.fulfill(
        json({
          ok: true,
          dispatches: [
            { source: 'run-log', run_id: RUN, agent: 'Head Chef', agent_slug: 'head-chef', wp_id: 'W1', running: false, completed_at: minutesAgo(38) },
            { source: 'run-log', run_id: RUN, agent: 'Build Boss', agent_slug: 'build-boss', wp_id: 'W2', running: true, completed_at: null },
            { source: 'run-log', run_id: RUN, agent: 'UI Boss', agent_slug: 'ui-boss', wp_id: 'W2', running: true, completed_at: null },
          ],
        }),
      );
    }
    if (/^\/api\/runs\/[^/]+\/team-chat$/.test(p)) return route.fulfill(json({ ok: true, exists: true, lines: [], total: 0, malformed: 0, truncated: false }));
    if (p === '/api/conversations') {
      const project = url.searchParams.get('project');
      const list = convs
        .filter((c) => project === null || c.project === project)
        .map((c) => ({ id: c.id, title: c.title, project: c.project, updated_at: c.updated_at, turn_count: c.turns.length }));
      return route.fulfill(json({ ok: true, conversations: list, execution: { available: true, note: null } }));
    }
    const item = /^\/api\/conversations\/([^/]+)$/.exec(p);
    if (item) {
      const conv = convs.find((c) => c.id === decodeURIComponent(item[1]));
      if (!conv) return route.fulfill(json({ ok: false, error: 'conversation not found' }, 404));
      return route.fulfill(json({ ok: true, id: conv.id, meta: { title: conv.title, project: conv.project, forked_from: null }, turns: conv.turns, events: [], turn_count: conv.turns.length, updated_at: conv.updated_at, session_id: 'mock-sess-1' }));
    }
    return route.fulfill(json({ ok: true }));
  });
}

async function open(page: Page, hash: string, mode: 'eenvoudig' | 'uitgebreid' = 'eenvoudig'): Promise<void> {
  await page.addInitScript(
    ([m, gatewayOrigin]) => {
      localStorage.setItem('forge.locale', 'nl');
      localStorage.setItem('forge.uiMode', m);
      localStorage.setItem('forge.onboarding.done', '1');
      Object.defineProperty(window, 'forge', {
        value: Object.freeze({ gatewayOrigin: () => gatewayOrigin, version: '0.1.0', platform: 'win32' }),
      });
    },
    [mode, GATEWAY] as const,
  );
  await mockGateway(page.context());
  await page.emulateMedia({ colorScheme: SCHEME, reducedMotion: 'reduce' });
  await page.goto(`${origin}/#${hash}`);
  await expect(page.locator('.fw-bar')).toBeVisible({ timeout: 20_000 });
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${ROUND}-${SCHEME}-${name}.png`) });

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** English words that must not appear in the Dutch start screen copy (project names excluded). */
const ENGLISH = /\b(projects|workspace|Continue|Recent projects|Recent conversations|Open chat|Open mission|messages|ago|just now|RUNNING|Good to see|Resume|agents)\b/;

const VIEWPORTS = [
  { name: '1280x840', width: 1264, height: 801 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '960x700', width: 960, height: 700 },
  { name: '390x844', width: 390, height: 844 },
] as const;

for (const vp of VIEWPORTS) {
  test(`start screen in Dutch at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await open(page, '/');
    // Redesign: Start is one question and the composer; the recent conversations live in the sidebar.
    await expect(page.getByRole('heading', { level: 1, name: 'Wat wil je maken?' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('textbox', { name: 'Bericht aan Forge' })).toBeVisible({ timeout: 15_000 });
    const text = await page.locator('.fw-start').evaluate((root) => {
      const clone = root.cloneNode(true) as Element;
      // Project names and the folder path are the owner's own words, not app copy.
      clone.querySelectorAll('.fw-chat-composer__path, [class*="project"], [class*="path"]').forEach((n) => n.remove());
      return clone.textContent ?? '';
    });
    expect(text).not.toMatch(ENGLISH);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await noHorizontalOverflow(page);
    await shot(page, `start-${vp.name}`);
    // Only one container scrolls the start screen.
    const scrollers = await page.evaluate(() =>
      [...document.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1 && el.closest('#fw-main') !== null;
      }).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`),
    );
    expect(scrollers.length, scrollers.join(' | ')).toBeLessThanOrEqual(1);
  });

  test(`chat at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await open(page, '/chat');
    await expect(page.getByRole('heading', { level: 1, name: 'Website voor bakkerij De Korenaar' })).toBeVisible({ timeout: 15_000 });
    await page.getByText('Op telefoonformaat staan').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    await noHorizontalOverflow(page);
    await shot(page, `chat-${vp.name}`);
    if (vp.width >= 1100) {
      const box = await page.locator('.fw-chat__body').boundingBox();
      expect(box).not.toBeNull();
      // The transcript keeps a readable floor at a desktop window (the review measured ~90 px at
      // the default 1280x840 window).
      expect(box!.height).toBeGreaterThanOrEqual(vp.height * 0.29);
    }
  });
}

test('default window: the details pane starts closed, the chat column is readable', async ({ page }) => {
  await page.setViewportSize({ width: 1264, height: 801 });
  await open(page, '/chat');
  await expect(page.getByRole('heading', { level: 1, name: 'Website voor bakkerij De Korenaar' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.fw-shell')).toHaveAttribute('data-pane', 'closed');
  const chat = await page.locator('.fw-chat').boundingBox();
  expect(chat!.width).toBeGreaterThanOrEqual(600);
});

test('details pane at 1440: empty values are words, the path wraps between folders', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/project', 'uitgebreid');
  await expect(page.getByRole('heading', { level: 1, name: 'bakkerij-website' })).toBeVisible({ timeout: 15_000 });
  // Redesign: the details pane opens from the ... menu (Uitgebreid), not from an always-visible button.
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('menuitem', { name: 'Details tonen' }).click();
  const inspector = page.locator('.fw-pane');
  await expect(inspector).toBeVisible();
  await shot(page, 'details-pane-1440');
  const values = await inspector.locator('.fw-inspector__field-value').allTextContents();
  for (const v of values) expect(v.trim()).not.toBe('—');
  for (const v of values) expect(v.trim()).not.toBe('');
});

test('a resize into overlay mode closes the details pane instead of covering the view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/settings', 'uitgebreid');
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('menuitem', { name: 'Details tonen' }).click();
  await expect(page.locator('.fw-shell')).toHaveAttribute('data-pane', 'open');
  await page.setViewportSize({ width: 960, height: 700 });
  await expect(page.locator('.fw-shell')).toHaveAttribute('data-pane', 'closed');
  await shot(page, 'after-resize-960');
});

test('project overview in Dutch at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/project');
  await expect(page.getByRole('heading', { level: 1, name: 'bakkerij-website' })).toBeVisible({ timeout: 15_000 });
  await noHorizontalOverflow(page);
  await shot(page, 'project-1440');
});

test('team strip at 1440 in Uitgebreid shows stamps with full names', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/chat', 'uitgebreid');
  const stamps = page.locator('.fw-team-strip .fw-team-stamp');
  await expect(stamps.first()).toBeVisible({ timeout: 15_000 });
  await expect(stamps.first()).toHaveAttribute('title', /.{4,}/);
  await shot(page, 'team-uitgebreid-1440');
});
