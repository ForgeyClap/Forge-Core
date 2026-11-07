/**
 * WP B3 — Chat & gesprekken: Playwright flows + screenshot loop, in Dutch, against a MOCKED gateway.
 *
 * Covers the plan row B3 flows 1 (new chat in a folder; first send carries accept-edits), 2 (follow-up
 * in the same conversation), 3 (fork), 6 (model switch), 7 (effort/mode switch mid-conversation),
 * 8 (rename + full-text search) and 10 (usage meter), plus the desktop gateway-origin fix and the
 * connection banner.
 *
 * WHAT IS MOCKED (never a live gateway): every `/api/*` call is answered in-process by `context.route`
 * with an in-memory store in the real gateway shapes (projects, conversation list/detail/create,
 * messages, PATCH rename, POST fork, usage). A send gets an immediate canned assistant turn; no
 * Claude Code process runs. SSE streams are aborted (the app falls back to polling). The dashboard
 * build under test is served from B3_DIST (a scratch build) by a throwaway static server. The
 * desktop cases inject `window.forge.gatewayOrigin()` returning a NON-4100 port and mock that port
 * only, so they prove the app follows the desktop origin.
 *
 * Fail-closed (WP B3-ui fix round): a screenshot run never passes without screenshots. When the run
 * asks for them (B3_DIST set, or B3_REQUIRED=1, which `_scratch/b3/ui/pw.shots.config.mjs` sets) and
 * the build is missing or empty, every test FAILS. Only the default e2e suite, which sets neither,
 * skips this file (it needs a scratch build that suite does not make).
 *
 * The offline cases are deterministic: every gateway request is aborted by a route installed BEFORE
 * the page loads; the test waits for that first /api/health request to fail, then for the banner.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page, Request } from '@playwright/test';

const DIST = process.env.B3_DIST ?? '';
const SHOTS = process.env.B3_SHOTS ?? path.join('test-results', 'b3-shots');
const ROUND = process.env.B3_ROUND ?? 'r1';
const BROWSER_ORIGIN = 'http://127.0.0.1:4100';
const DESKTOP_ORIGIN = 'http://127.0.0.1:49519';
const PROJECT = 'bakkerij-website';
const FRESH = 'nieuw-project';

const REQUIRED = SHOTS_ORIGIN !== '' || DIST !== '' || process.env.B3_REQUIRED === '1';

test.skip(!REQUIRED, 'not a B3 chat screenshot run (B3_DIST and B3_REQUIRED unset)');

/** Why the scratch build cannot be used, or null when it can. */
function distProblem(dist: string): string | null {
  if (dist === '') return 'B3_DIST is not set';
  const root = path.resolve(dist);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return `B3_DIST ${root} does not exist`;
  if (!fs.existsSync(path.join(root, 'index.html'))) return `B3_DIST ${root} has no index.html (empty or not built)`;
  return null;
}

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
  const problem = distProblem(DIST);
  if (problem !== null) throw new Error(`B3 chat screenshot run without a scratch build: ${problem}`);
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

interface Turn {
  readonly type: 'turn';
  readonly turn_id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly created_at: string;
  readonly mode?: string;
  readonly model?: string | null;
  readonly effort?: string | null;
}

interface MockConversation {
  id: string;
  project: string;
  title: string;
  updated_at: string;
  turns: Turn[];
  forked_from?: string;
}

interface MockGateway {
  readonly conversations: Map<string, MockConversation>;
  readonly sends: { readonly conversation: string; readonly body: Record<string, unknown> }[];
  readonly requests: string[];
  usage: Record<string, unknown>;
}

function seed(): MockGateway {
  const conversations = new Map<string, MockConversation>();
  const add = (c: MockConversation) => conversations.set(c.id, c);
  add({
    id: 'c-site',
    project: PROJECT,
    title: 'Website voor bakkerij De Korenaar',
    updated_at: minutesAgo(6),
    turns: [
      { type: 'turn', turn_id: 't1', role: 'user', text: 'Maak een website met drie pagina\u2019s: start, broden en contact.', created_at: minutesAgo(40) },
      { type: 'turn', turn_id: 't1', role: 'assistant', text: 'Klaar. De drie pagina\u2019s staan in de map **site/**. Op de startpagina staan de openingstijden.', created_at: minutesAgo(38) },
    ],
  });
  add({
    id: 'c-menu',
    project: PROJECT,
    title: 'Menukaart als pdf',
    updated_at: minutesAgo(60 * 26),
    turns: [
      { type: 'turn', turn_id: 't1', role: 'user', text: 'Zet de menukaart om naar een pdf met het logo bovenaan.', created_at: minutesAgo(60 * 27) },
      { type: 'turn', turn_id: 't1', role: 'assistant', text: 'De pdf staat in **menukaart.pdf**; het logo staat bovenaan en de prijzen zijn rechts uitgelijnd.', created_at: minutesAgo(60 * 26) },
    ],
  });
  add({
    id: 'c-foto',
    project: PROJECT,
    title: 'Foto\u2019s verkleinen',
    updated_at: minutesAgo(60 * 24 * 3),
    turns: [
      { type: 'turn', turn_id: 't1', role: 'user', text: 'Maak alle foto\u2019s kleiner dan 300 kB.', created_at: minutesAgo(60 * 24 * 3) },
    ],
  });
  return {
    conversations,
    sends: [],
    requests: [],
    usage: {
      ok: true,
      provenance: 'REPORTED',
      level: 'normal',
      week: 18,
      updated_at: minutesAgo(2),
      guard: { available: true, session_pct: 42, week_pct: 18, session_reset_at: new Date(Date.now() + 95 * 60_000).toISOString() },
    },
  };
}

function summary(c: MockConversation) {
  return { id: c.id, title: c.title, project: c.project, updated_at: c.updated_at, turn_count: c.turns.length };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) };
}

async function mockGateway(context: BrowserContext, gw: MockGateway, gatewayOrigin: string): Promise<void> {
  let next = 1;
  await context.route(`${gatewayOrigin}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    gw.requests.push(`${method} ${gatewayOrigin}${p}`);
    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE',
          'access-control-allow-headers': 'content-type,x-cc-exec-token',
        },
      });
    }
    if (p.endsWith('/stream')) return route.abort();
    if (p === '/api/health') return route.fulfill(json({ ok: true, instance_id: 'mock', runtime: { state: 'OK' }, claude: { available: true } }));
    if (p === '/api/projects') {
      return route.fulfill(
        json({
          ok: true,
          projects: [
            { name: PROJECT, path: 'C:/Users/Sanne/Documents/Forge Projecten/bakkerij-website', kind: 'website' },
            { name: FRESH, path: 'C:/Users/Sanne/Documents/Forge Projecten/nieuw-project', kind: 'unknown' },
          ],
          default_project_id: PROJECT,
        }),
      );
    }
    if (p === '/api/usage') return route.fulfill(json(gw.usage));
    if (p === '/api/conversations' && method === 'GET') {
      const project = url.searchParams.get('project');
      const list = [...gw.conversations.values()].filter((c) => project === null || c.project === project).map(summary);
      return route.fulfill(json({ ok: true, conversations: list, execution: { available: true, note: null } }));
    }
    if (p === '/api/conversations' && method === 'POST') {
      const body = req.postDataJSON() as { project: string };
      const id = `c-new-${next++}`;
      gw.conversations.set(id, { id, project: body.project, title: 'Nieuw gesprek', updated_at: new Date().toISOString(), turns: [] });
      return route.fulfill(json({ ok: true, conversation: { id, project: body.project, title: null } }, 201));
    }
    const item = /^\/api\/conversations\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (item) {
      const conv = gw.conversations.get(decodeURIComponent(item[1]));
      if (!conv) return route.fulfill(json({ ok: false, error: 'conversation not found' }, 404));
      const sub = item[2] ?? '';
      if (sub === '' && method === 'GET') {
        return route.fulfill(json({ ok: true, id: conv.id, meta: { title: conv.title, project: conv.project, forked_from: conv.forked_from ?? null }, turns: conv.turns, events: [], turn_count: conv.turns.length, updated_at: conv.updated_at, session_id: 'mock-sess-1' }));
      }
      if (sub === '' && method === 'PATCH') {
        const body = req.postDataJSON() as { title: string };
        conv.title = body.title;
        conv.updated_at = new Date().toISOString();
        return route.fulfill(json({ ok: true, id: conv.id, title: conv.title }));
      }
      if (sub === '/fork' && method === 'POST') {
        const id = `c-fork-${next++}`;
        gw.conversations.set(id, { id, project: conv.project, title: `Fork: ${conv.title}`, updated_at: new Date().toISOString(), turns: [], forked_from: conv.id });
        return route.fulfill(json({ ok: true, id, project: conv.project, forked_from: conv.id, session_fork_pending: true }, 201));
      }
      if (sub === '/messages' && method === 'POST') {
        const body = req.postDataJSON() as Record<string, unknown>;
        gw.sends.push({ conversation: conv.id, body });
        const turnId = `t-${next++}`;
        const now = new Date().toISOString();
        const text = String(body.text ?? '');
        conv.turns.push({ type: 'turn', turn_id: turnId, role: 'user', text, created_at: now, mode: String(body.mode ?? 'execute'), model: (body.model as string) ?? null, effort: (body.effort as string) ?? null });
        conv.turns.push({ type: 'turn', turn_id: turnId, role: 'assistant', text: conv.turns.length > 2 ? 'Ik weet nog wat we eerder deden: de drie pagina\u2019s staan er. De openingstijden staan nu ook in de voettekst.' : 'Ik heb een map **site/** gemaakt met een startpagina.', created_at: now });
        if (conv.title === 'Nieuw gesprek') conv.title = text.slice(0, 40);
        conv.updated_at = now;
        return route.fulfill(json({ ok: true, execution_started: true, turn_id: turnId, request_id: `r-${turnId}` }, 202));
      }
    }
    return route.fulfill(json({ ok: true }));
  });
}

interface OpenOptions {
  readonly mode?: 'eenvoudig' | 'uitgebreid';
  readonly desktop?: boolean;
  readonly gateway?: MockGateway;
  readonly offline?: boolean;
  readonly extraStorage?: Record<string, string>;
}

async function open(page: Page, hash: string, options: OpenOptions = {}): Promise<MockGateway> {
  const gw = options.gateway ?? seed();
  await page.addInitScript(
    ([mode, desktop, desktopOrigin, extra]) => {
      localStorage.setItem('forge.locale', 'nl');
      localStorage.setItem('forge.uiMode', mode as string);
      localStorage.setItem('forge.onboarding.done', '1');
      for (const [k, v] of Object.entries(extra as Record<string, string>)) localStorage.setItem(k, v);
      if (desktop) {
        Object.defineProperty(window, 'forge', {
          value: Object.freeze({ gatewayOrigin: () => desktopOrigin, version: '0.1.0', platform: 'win32' }),
        });
      }
    },
    [options.mode ?? 'eenvoudig', options.desktop === true, DESKTOP_ORIGIN, options.extraStorage ?? {}] as const,
  );
  // Fail closed: in the desktop case the page must never call the browser build's fixed origin, which on a
  // developer machine is their own live gateway. The request is aborted in the browser (the test below
  // still sees the attempt through `page.on('request')`), so it can never leave the machine.
  if (options.desktop === true) await page.context().route(`${BROWSER_ORIGIN}/**`, (route) => route.abort('blockedbyclient'));
  if (options.offline) {
    await page.context().route(`${options.desktop ? DESKTOP_ORIGIN : BROWSER_ORIGIN}/**`, (route) => route.abort('connectionrefused'));
  } else {
    await mockGateway(page.context(), gw, options.desktop ? DESKTOP_ORIGIN : BROWSER_ORIGIN);
  }
  await page.emulateMedia({ colorScheme: process.env.B3_SCHEME === 'dark' ? 'dark' : 'light' });
  // Offline: the abort route above is in place before the page loads; wait for the first health
  // poll to really fail, so the banner wait after it is short and deterministic.
  const healthFailed = options.offline
    ? page.waitForEvent('requestfailed', { predicate: (req) => new URL(req.url()).pathname === '/api/health', timeout: 15_000 })
    : null;
  await page.goto(`${origin}/#${hash}`);
  if (healthFailed !== null) await healthFailed;
  return gw;
}

/** The disconnected banner is docked below the top bar: it covers no top-bar control and no page content. */
async function expectBannerDocked(page: Page): Promise<void> {
  const banner = page.locator('.fw-conn');
  await expect(banner).toHaveAttribute('data-docked', 'true');
  const box = await banner.boundingBox();
  const topbar = await page.locator('.fw-bar').boundingBox();
  const first = await page.locator('#fw-main > *').first().boundingBox();
  expect(box).not.toBeNull();
  expect(topbar).not.toBeNull();
  expect(first).not.toBeNull();
  if (box && topbar && first) {
    // 1 px of slack: the bar's height is fractional (55.3 px measured at 960 wide); a real overlap is far larger.
    expect(box.y).toBeGreaterThanOrEqual(topbar.y + topbar.height - 1);
    expect(first.y).toBeGreaterThanOrEqual(box.y + box.height);
  }
}

const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `${ROUND}-${name}.png`), fullPage });

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The "Gesprekken" list inside the chat (its rail); the sidebar's recent list is a navigation, not this. */
function sessionsRail(page: Page) {
  return page.getByRole('complementary', { name: 'Gesprekken' });
}

/** The composer's "Toevoegen" tray holds the model, thinking and permission controls. */
async function openComposerTray(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Toevoegen', expanded: false });
  if ((await toggle.count()) > 0) await toggle.click();
  await expect(page.getByRole('button', { name: 'Toevoegen', expanded: true })).toBeVisible();
}

async function openConversation(page: Page, title: string): Promise<void> {
  const rail = sessionsRail(page);
  // Wait until the chat has loaded (the composer or the rail), then open the rail if it is closed.
  await expect(page.getByRole('textbox', { name: /Bericht aan Forge/ }).or(rail).first()).toBeVisible({ timeout: 25_000 });
  const recent = page.getByRole('navigation', { name: 'Recente gesprekken' }).getByRole('link', { name: new RegExp(title) });
  if (await rail.isVisible()) {
    await rail.getByRole('button', { name: new RegExp(title) }).first().click();
  } else if ((await page.getByRole('button', { name: 'Gesprekken tonen' }).count()) > 0) {
    // Uitgebreid with the chat's own list folded away.
    await page.getByRole('button', { name: 'Gesprekken tonen' }).click();
    await rail.getByRole('button', { name: new RegExp(title) }).first().click();
  } else {
    // Eenvoudig: the sidebar's recent list is the only list of conversations.
    await expect(recent).toBeVisible({ timeout: 15_000 });
    await recent.click();
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
}

/* ------------------------------------------------------------------------------------------------ */

test('page title is Forge Systeem', async ({ page }) => {
  await open(page, '/chat');
  await expect(page).toHaveTitle('Forge Systeem');
});

test('flow 1: new chat in a fresh project folder; the first send carries accept-edits, never bypass (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = await open(page, '/chat');
  // Pick the fresh project on "Mijn projecten", then go back to the chat.
  await page.getByRole('link', { name: 'Mijn projecten' }).click();
  await page.getByRole('region', { name: 'Alle projecten' }).getByRole('button', { name: FRESH, exact: true }).click();
  // A new conversation in the fresh project (the open chat belongs to the other project).
  await page.getByRole('button', { name: 'Nieuw gesprek' }).first().click();
  await expect(page.getByRole('textbox', { name: /Bericht aan Forge/ })).toBeVisible({ timeout: 25_000 });
  await openComposerTray(page);
  await expect(page.getByRole('radio', { name: 'Volledige toegang' })).toHaveCount(0);
  const accept = page.getByRole('radio', { name: 'Mag aanpassen' });
  if ((await accept.count()) > 0) await expect(accept).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'flow1-new-chat-1440');
  await page.getByRole('textbox', { name: /Bericht aan Forge/ }).fill('Maak een eenvoudige website voor mijn bakkerij');
  await page.getByRole('button', { name: 'Versturen' }).click();
  await expect.poll(() => gw.sends.length).toBe(1);
  expect(gw.sends[0].body.mode).toBe('accept-edits');
  expect(JSON.stringify(gw.sends[0].body)).not.toContain('bypass');
  await expect(page.locator('.fw-chat-thread__list').getByText('Ik heb een map')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'flow1-after-send-1440');
});

test('flows 2, 6, 7: follow-up in the same conversation with a model and mode switch mid-conversation (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = await open(page, '/chat', { mode: 'uitgebreid' });
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  // Flow 6: switch the model by click.
  await openComposerTray(page);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Sonnet/ }).click();
  // Flow 7: thinking (effort) and mode mid-conversation.
  await page.getByRole('button', { name: 'Standaard', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Hoog/ }).click();
  await page.getByRole('radio', { name: 'Alleen plannen' }).click();
  await page.getByRole('radio', { name: 'Mag aanpassen' }).click();
  await shot(page, 'flow2-followup-before-1440');
  // Flow 2: the follow-up goes into the SAME conversation (gateway resumes the session).
  await page.getByRole('textbox', { name: /Bericht aan Forge/ }).fill('Zet de openingstijden ook in de voettekst');
  await page.getByRole('button', { name: 'Versturen' }).click();
  await expect.poll(() => gw.sends.length).toBe(1);
  expect(gw.sends[0].conversation).toBe('c-site');
  expect(gw.sends[0].body).toMatchObject({ mode: 'accept-edits', effort: 'high', model: 'claude-sonnet-5-5' });
  await expect(page.locator('.fw-chat-thread__list').getByText('Ik weet nog wat we eerder deden')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'flow2-followup-after-1440');
});

test('flow 3: fork a conversation from the rail (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = await open(page, '/chat', { mode: 'uitgebreid' });
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  await page.getByRole('button', { name: 'Aftakken: nieuw gesprek vanaf Website voor bakkerij De Korenaar' }).click();
  await expect(page.getByText('Nieuw gesprek gemaakt')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Fork: Website voor bakkerij/, { timeout: 15_000 });
  expect(gw.requests).toContain(`POST ${BROWSER_ORIGIN}/api/conversations/c-site/fork`);
  await shot(page, 'flow3-fork-1440');
});

test('flow 8: rename and full-text search in the rail (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = await open(page, '/chat', { mode: 'uitgebreid' });
  await openConversation(page, 'Menukaart als pdf');
  const rail = sessionsRail(page);
  await rail.getByRole('button', { name: 'Naam van Menukaart als pdf wijzigen' }).click();
  await rail.getByRole('textbox', { name: 'Nieuwe naam' }).fill('Menukaart voorjaar');
  await shot(page, 'flow8-rename-field-1440');
  await rail.getByRole('button', { name: 'Opslaan' }).click();
  await expect(rail.getByText('Menukaart voorjaar')).toBeVisible();
  expect(gw.conversations.get('c-menu')?.title).toBe('Menukaart voorjaar');
  // Full text: "logo" only appears inside the menu conversation's turns, not in any title.
  await rail.getByRole('searchbox').fill('logo bovenaan');
  await rail.getByRole('searchbox').press('Enter');
  await expect(rail.getByRole('listitem')).toHaveCount(1, { timeout: 10_000 });
  await expect(rail.getByText('Menukaart voorjaar')).toBeVisible();
  await shot(page, 'flow8-search-1440');
});

/** Redesign: the usage meter left the chat rail. A quiet line above the composer appears only at 80 % of a
 *  CURRENT limit or more (DESIGN.md section 2); the full reading lives in Instellingen. */
function usageAt(session: number, week: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    provenance: 'REPORTED',
    level: 'normal',
    week,
    updated_at: minutesAgo(2),
    guard: { available: true, session_pct: session, week_pct: week, session_reset_at: new Date(Date.now() + 95 * 60_000).toISOString(), ...extra },
  };
}

test('flow 10: below 80 % the chat shows no usage line (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/chat');
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  await expect(page.getByRole('textbox', { name: /Bericht aan Forge/ })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole('status', { name: 'Gebruik' })).toHaveCount(0);
});

test('flow 10b: at 87 % of the 5 hours a quiet line says the limit is near (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = seed();
  gw.usage = usageAt(87, 18);
  await open(page, '/chat', { gateway: gw });
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  const line = page.getByRole('status', { name: 'Gebruik' });
  await expect(line).toContainText('Je limiet is bijna op (87 %).', { timeout: 25_000 });
  await line.screenshot({ path: path.join(SHOTS, `${ROUND}-flow10b-usage-line.png`) });
  await shot(page, 'flow10b-usage-line-1440');
});

test('flow 10c: a stale watcher never raises the usage line (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = seed();
  gw.usage = usageAt(95, 18, { watcher: 'stale' });
  await open(page, '/chat', { gateway: gw });
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  await expect(page.getByRole('textbox', { name: /Bericht aan Forge/ })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole('status', { name: 'Gebruik' })).toHaveCount(0);
});

test('flow 10d: without a measurement the chat shows no usage line and no invented number (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gw = seed();
  gw.usage = { ok: true, provenance: 'NOT CONFIGURED', guard: { available: false } };
  await open(page, '/chat', { gateway: gw });
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  await page.waitForTimeout(800);
  await expect(page.getByRole('status', { name: 'Gebruik' })).toHaveCount(0);
});

test('Eenvoudig composer: no Denkkracht and no Automatisch plannen (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/chat');
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  await openComposerTray(page);
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Standaard', exact: true })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Automatisch plannen' })).toHaveCount(0);
  await page.locator('.fw-chat-composer').screenshot({ path: path.join(SHOTS, `${ROUND}-composer-eenvoudig-1440.png`) });
});

test('desktop app: every gateway call goes to window.forge.gatewayOrigin(), never to 4100 (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const foreign: string[] = [];
  page.on('request', (req: Request) => {
    if (req.url().startsWith(BROWSER_ORIGIN)) foreign.push(req.url());
  });
  const gw = await open(page, '/chat', { desktop: true });
  await openConversation(page, 'Website voor bakkerij De Korenaar');
  await openComposerTray(page);
  await expect(page.getByRole('radio', { name: 'Mag aanpassen' })).toBeVisible();
  expect(gw.requests.some((r) => r.includes(`${DESKTOP_ORIGIN}/api/projects`))).toBe(true);
  expect(foreign).toEqual([]);
  await shot(page, 'desktop-chat-1440');
});

test('chat at phone size, rail as a drawer (390)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/chat', { mode: 'uitgebreid' });
  await expect(page.getByRole('textbox', { name: /Bericht aan Forge/ })).toBeVisible({ timeout: 25_000 });
  await shot(page, 'chat-390');
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Gesprekken tonen' }).click();
  await expect(sessionsRail(page)).toBeVisible();
  // The drawer fades in; capture it once it is fully opaque.
  await expect(page.locator('.fw-chat-frame__rail')).toHaveCSS('opacity', '1');
  await shot(page, 'rail-drawer-390');
  await noHorizontalOverflow(page);
});

test('connection banner, desktop app, Eenvoudig: Dutch, one retry button, no developer command (1440 + 390, Settings)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/settings', { desktop: true, offline: true });
  const banner = page.locator('.fw-conn');
  await expect(banner).toContainText('Geen verbinding met Forge');
  await expect(banner.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
  await expect(banner).not.toContainText('bin.mjs');
  await expect(banner).not.toContainText(/vanzelf|automatisch/i);
  await expect(banner).toContainText('Sluit Forge Systeem af en open het opnieuw.');
  await expectBannerDocked(page);
  await shot(page, 'banner-settings-1440');
});

test('connection banner, desktop app, minimum desktop width (960, Settings)', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 700 });
  await open(page, '/settings', { desktop: true, offline: true });
  const banner = page.locator('.fw-conn');
  await expect(banner).toContainText('Geen verbinding met Forge');
  await expect(banner).not.toContainText('bin.mjs');
  await expectBannerDocked(page);
  await shot(page, 'banner-settings-960');
  await noHorizontalOverflow(page);
});

test('connection banner, desktop app, chat at 960: top bar and composer stay free', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 700 });
  await open(page, '/chat', { desktop: true, offline: true });
  await expect(page.locator('.fw-conn')).toContainText('Geen verbinding met Forge');
  await expectBannerDocked(page);
  await shot(page, 'banner-chat-960');
  await noHorizontalOverflow(page);
});

test('connection banner, desktop app, phone size (390, fresh load)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/settings', { desktop: true, offline: true });
  const banner = page.locator('.fw-conn');
  await expect(banner).toContainText('Geen verbinding met Forge');
  await expect(banner.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
  await expectBannerDocked(page);
  await shot(page, 'banner-settings-390');
  await noHorizontalOverflow(page);
});

test('connection banner, browser build, Uitgebreid: technical details on request (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/chat', { offline: true, mode: 'uitgebreid' });
  const banner = page.locator('.fw-conn');
  await expect(banner).toContainText('Geen verbinding met Forge');
  await banner.getByRole('button', { name: /Technische details/ }).click();
  await expect(banner).toContainText('node command-center/gateway/bin.mjs');
  await shot(page, 'banner-details-uitgebreid-1440');
});
