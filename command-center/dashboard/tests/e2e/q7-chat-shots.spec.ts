/**
 * Q7-SHOTS — real-browser evidence for Q7-CHAT, in Dutch, light and dark, at 360, 768 and 1280 px wide.
 *
 *   chat-not-started  conversation-not-started-skips.json: turn 1 failed and its failover could not start
 *                     (`execution_not_started` attempt 2 carries `skipped`), turn 2 could not start at all
 *                     (attempt 1, code 'not_started'). Both show "Overgeslagen: …" with the new copy; turn 2 also
 *                     says "Forge kon dit bericht niet starten …" and turn 1 has no bare empty header (Q7-FINISH).
 *   chat-paused       the exhausted conversation: the dashed "Gepauzeerd" strip above the composer must sit on
 *                     the reply column (the composer's x range), not across the whole main area.
 *
 * Never touches a live gateway: every request to 127.0.0.1:4100 / localhost:4100 is answered in-process by
 * `context.route`, web sockets are closed. The page itself comes from a dev server on its own port
 * (FORGE_SHOTS_ORIGIN). Skipped unless FORGE_SHOTS_ORIGIN is set, so the default e2e suite is unaffected.
 * Output: Q7_SHOTS (default: test-results/q7-shots), names `<round>-<case>-<width>-<theme>.png`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page, Route } from '@playwright/test';

const SHOTS = process.env.Q7_SHOTS ?? path.join('test-results', 'q7-shots');
const ROUND = process.env.Q7_ROUND ?? 'r1';
const PROJECT = 'bakkerij-website';
const WIDTHS = [360, 768, 1280] as const;
const THEMES = ['light', 'dark'] as const;
const UNAVAILABLE = 'Eigen API niet beschikbaar: verwijderd, uitgezet of geweigerd';
const NOT_STARTED = 'Forge kon dit bericht niet starten. Probeer het opnieuw of kijk in de router-instellingen.';

test.skip(SHOTS_ORIGIN === '', 'FORGE_SHOTS_ORIGIN not set: this capture spec needs a dev server on its own port');

type Rec = Record<string, unknown>;

const FIXTURES = path.resolve(process.cwd(), 'tests', 'fixtures', 'app-router');
const fixture = (name: string): Rec => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Rec;

const GONE = { target_id: 'mijn-vllm-qwen', label: 'Mijn vLLM · qwen2.5-coder', provider: 'custom-mijn-vllm', reason: 'provider_unavailable' };

function exhaustedConversation(): Rec {
  const base = fixture('conversation-exhausted-ollama-down.json');
  const events = (base.events as Rec[]).map((event) =>
    event.kind === 'route_exhausted' ? { ...event, data: { ...(event.data as Rec), skipped: [GONE] } } : event,
  );
  return { ...base, id: 'c-exhausted', events };
}

const CONVERSATIONS: Record<string, { readonly title: string; readonly body: Rec; readonly updated: string }> = {
  'c-not-started': { title: 'Knop op de startpagina', body: { ...fixture('conversation-not-started-skips.json'), id: 'c-not-started' }, updated: '2026-11-04T10:05:00.000Z' },
  'c-exhausted': { title: 'Klantmails samenvatten', body: exhaustedConversation(), updated: '2026-11-02T15:02:01.000Z' },
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function stub(context: BrowserContext): Promise<void> {
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
    if (p === '/api/projects') {
      return json(route, { ok: true, projects: [{ name: PROJECT, path: 'C:/Users/Sanne/Documents/Forge Projecten/bakkerij-website', kind: 'website' }], default_project_id: PROJECT });
    }
    if (p === '/api/conversations' && method === 'GET') {
      const list = Object.entries(CONVERSATIONS).map(([id, c]) => ({ id, title: c.title, project: PROJECT, updated_at: c.updated, turn_count: (c.body.turns as unknown[]).length }));
      return json(route, { ok: true, conversations: list, execution: { available: true, note: null } });
    }
    const item = /^\/api\/conversations\/([^/]+)$/.exec(p);
    if (item && method === 'GET') {
      const c = CONVERSATIONS[decodeURIComponent(item[1])];
      if (!c) return json(route, { ok: false, error: 'conversation not found' }, 404);
      const turns = c.body.turns as unknown[];
      return json(route, { ...c.body, meta: { title: c.title, project: PROJECT, forked_from: null }, turn_count: turns.length, updated_at: c.updated, session_id: 'stub-sess' });
    }
    if (p === '/api/app-router/status') return json(route, { mode: 'claude-then-model', entries: [], next: null, captured_at: '2026-11-04T14:00:00.000Z' });
    if (p === '/api/providers') return json(route, { ok: true, providers: [] });
    if (p === '/api/models') return json(route, { ok: true, providers: { pending: false, list: [] } });
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

async function openConversation(page: Page, title: string): Promise<void> {
  const recent = page.getByRole('navigation', { name: 'Recente gesprekken' }).getByRole('link', { name: new RegExp(title) });
  if (!(await recent.isVisible())) {
    const menu = page.getByRole('button', { name: /menu/i }).first();
    if (await menu.isVisible()) await menu.click();
  }
  await recent.click();
}

/** Every status chip in the dock sits inside the composer's column (x range), with 1 px tolerance. */
async function chipOnColumn(page: Page): Promise<void> {
  const chips = page.locator('.fw-chat__dock > .fw-chat-status');
  const composer = await page.locator('.fw-chat__dock > .fw-chat-composer').boundingBox();
  expect(composer).not.toBeNull();
  for (const chip of await chips.all()) {
    const box = await chip.boundingBox();
    if (!box || !composer) continue;
    expect(box.x).toBeGreaterThanOrEqual(composer.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(composer.x + composer.width + 1);
  }
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`chat not-started skip lines ${width} ${theme}`, async ({ page, context }) => {
      await stub(context);
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/`);
      await openConversation(page, 'Knop op de startpagina');
      const lines = page.locator('.fw-route-skip');
      await expect(lines).toHaveCount(2);
      await expect(lines.first()).toContainText(UNAVAILABLE);
      await expect(lines.first()).toContainText('Groq eigen');
      await expect(lines.nth(1)).toContainText(UNAVAILABLE);
      // Q7-FINISH: the turn that never started says so; the failed empty answer has no bare header.
      await expect(page.getByText(NOT_STARTED)).toHaveCount(1);
      await expect(page.locator('.fw-chat-msg--forge .fw-chat-msg__head')).toHaveCount(0);
      await settle(page);
      await lines.first().evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `chat-not-started-top-${width}-${theme}`);
      await lines.nth(1).evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `chat-not-started-${width}-${theme}`);
      await chipOnColumn(page);
      await noOverflow(page, width);
    });

    test(`chat paused strip on the column ${width} ${theme}`, async ({ page, context }) => {
      await stub(context);
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/`);
      await openConversation(page, 'Klantmails samenvatten');
      const chip = page.locator('.fw-chat__dock > .fw-chat-status');
      await expect(chip).toHaveCount(1);
      await expect(chip).toContainText('Gepauzeerd');
      await settle(page);
      await shot(page, `chat-paused-${width}-${theme}`);
      await chipOnColumn(page);
      await noOverflow(page, width);
    });
  }
}
