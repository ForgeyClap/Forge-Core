/**
 * Q6-SHOTS — real-browser evidence for the Q6 skip lines, in Dutch, light and dark, at 360, 768 and
 * 1280 px wide.
 *
 *   chat-skip       a routed conversation: "Overgeslagen: …" under a reply WITHOUT a route notice (turn 1) and
 *                   under a reply WITH one (turn 3, the switch to Ollama), two reasons on one line.
 *   chat-exhausted  "nothing could take this turn" followed by the steps that were skipped before that.
 *   settings-skip   Instellingen › router, "Je eigen model" opened: the Eigen API step has a
 *                   provider_unavailable warning, so "Testen" is off and its reason is on screen.
 *   settings-409    the same step without a warning, Testen pressed: the gateway's 409 entry_unusable words.
 *
 * Never touches a live gateway: every request to 127.0.0.1:4100 / localhost:4100 is answered in-process by
 * `context.route` (fixtures in the gateway's shapes, texts from gateway/src/app-router/chain-schema.mjs), web
 * sockets are closed. The page itself comes from a dev server on its own port (FORGE_SHOTS_ORIGIN, as in the other
 * capture specs). Skipped unless FORGE_SHOTS_ORIGIN is set, so the default e2e suite is unaffected.
 * Output: Q6_SHOTS (default: test-results/q6-shots), names `<round>-<case>-<width>-<theme>.png`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Page, Route } from '@playwright/test';

const SHOTS = process.env.Q6_SHOTS ?? path.join('test-results', 'q6-shots');
const ROUND = process.env.Q6_ROUND ?? 'r1';
const PROJECT = 'bakkerij-website';
const WIDTHS = [360, 768, 1280] as const;
const THEMES = ['light', 'dark'] as const;

test.skip(SHOTS_ORIGIN === '', 'FORGE_SHOTS_ORIGIN not set: this capture spec needs a dev server on its own port');

type Rec = Record<string, unknown>;

const FIXTURES = path.resolve(process.cwd(), 'tests', 'fixtures', 'app-router');
const fixture = (name: string): Rec => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Rec;

/* The gateway's own warning / 409 words (chain-schema.mjs WARNINGS, unusableEntryText()). */
const UNAVAILABLE = fixture('test-409-unusable.json');

const GONE = { target_id: 'mijn-vllm-qwen', label: 'Mijn vLLM · qwen2.5-coder', provider: 'custom-mijn-vllm', reason: 'provider_unavailable' };
const UNPAID = { target_id: 'groq-eigen', label: 'Groq eigen · llama-3.3-70b', provider: 'custom-groq', reason: 'paid_ack_required' };

/** conversation-routed.json with skips: turn 1 (no notice of its own) and turn 3 (the switch to Ollama). */
function skipConversation(): Rec {
  const base = fixture('conversation-routed.json');
  const events = (base.events as Rec[]).map((event) =>
    event.kind === 'route_selected' && event.request_id === 'r3' ? { ...event, data: { ...(event.data as Rec), skipped: [GONE, UNPAID] } } : event,
  );
  const first = { kind: 'route_selected', turn_id: 't1', request_id: 'r1', data: { target_id: 'main', label: 'Hoofdaccount', kind: 'claude-account', capability: 'full', reason: 'first', attempt: 1, skipped: [GONE] } };
  return { ...base, id: 'c-skip', events: [first, ...events] };
}

/** conversation-exhausted-ollama-down.json with the steps skipped before the router ran out. */
function exhaustedConversation(): Rec {
  const base = fixture('conversation-exhausted-ollama-down.json');
  const events = (base.events as Rec[]).map((event) =>
    event.kind === 'route_exhausted' ? { ...event, data: { ...(event.data as Rec), skipped: [GONE, UNPAID] } } : event,
  );
  return { ...base, id: 'c-exhausted', events };
}

const CONVERSATIONS: Record<string, { readonly title: string; readonly body: Rec; readonly updated: string }> = {
  'c-skip': { title: 'Knop op de startpagina', body: skipConversation(), updated: '2026-11-02T14:20:20.000Z' },
  'c-exhausted': { title: 'Klantmails samenvatten', body: exhaustedConversation(), updated: '2026-11-02T15:02:01.000Z' },
};

/** The router chain of the Settings cases: the main account, then an own-API model whose API was deleted. */
function routerGet(withWarning: boolean): Rec {
  const post = fixture('post-200.json');
  const config = post.config as Rec;
  const warnings = withWarning
    ? [{ path: 'entries[1].provider', code: 'provider_unavailable', nl: UNAVAILABLE.nl, en: UNAVAILABLE.en, entry_id: 'mijn-vllm-qwen', provider: 'custom-mijn-vllm' }]
    : [];
  return { ok: true, provenance: 'STORED', config, warnings, terms: { checked_at: '2026-11-02', sources: [] }, profiles_root_display: '~\\.forge-router\\profiles' };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function stub(context: BrowserContext, opts: { readonly routerWarning?: boolean } = {}): Promise<void> {
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.route(/^https?:\/\/(127\.0\.0\.1|localhost):4100\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
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
    if (p === '/api/app-router') return json(route, routerGet(opts.routerWarning ?? true));
    if (p === '/api/app-router/status') return json(route, { mode: 'claude-then-model', entries: [], next: null, captured_at: '2026-11-04T14:00:00.000Z' });
    if (/^\/api\/app-router\/targets\/[^/]+\/test$/.test(p)) return json(route, UNAVAILABLE, 409);
    if (p === '/api/providers/custom') return json(route, { ok: true, revision: 3, providers: [] });
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

/** No horizontal page overflow at this width. */
async function noOverflow(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

/** Opens a conversation from the sidebar's recent list (the drawer on a phone). */
async function openConversation(page: Page, title: string): Promise<void> {
  const recent = page.getByRole('navigation', { name: 'Recente gesprekken' }).getByRole('link', { name: new RegExp(title) });
  if (!(await recent.isVisible())) {
    const menu = page.getByRole('button', { name: /menu/i }).first();
    if (await menu.isVisible()) await menu.click();
  }
  await recent.click();
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`chat skip line ${width} ${theme}`, async ({ page, context }) => {
      await stub(context);
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/`);
      await openConversation(page, 'Knop op de startpagina');
      const lines = page.locator('.fw-route-skip');
      await expect(lines).toHaveCount(2);
      await expect(lines.nth(1)).toContainText('Groq eigen');
      await settle(page);
      await lines.first().evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await shot(page, `chat-skip-top-${width}-${theme}`);
      await lines.nth(1).evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `chat-skip-${width}-${theme}`);
      await noOverflow(page, width);
    });

    test(`chat exhausted after skip ${width} ${theme}`, async ({ page, context }) => {
      await stub(context);
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/`);
      await openConversation(page, 'Klantmails samenvatten');
      const line = page.locator('.fw-route-skip');
      await expect(line).toHaveCount(1);
      await settle(page);
      await line.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `chat-exhausted-${width}-${theme}`);
      await noOverflow(page, width);
    });

    test(`settings Testen off for a skipped step ${width} ${theme}`, async ({ page, context }) => {
      await stub(context, { routerWarning: true });
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/settings?focus=router`);
      const own = page.locator('[data-row="router-own"]');
      await own.getByRole('button', { name: 'Meer info' }).click();
      const testen = page.locator('.fs-router__pick-ctl button');
      await expect(testen).toBeDisabled();
      const reason = page.getByText('Testen kan nu niet: de router slaat deze stap over.');
      await expect(reason).toBeVisible();
      await settle(page);
      await testen.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `settings-skip-${width}-${theme}`);
      // The top of the router block: the mode row above the own-model row (and its select) inside the card.
      const modeSelect = page.getByRole('combobox', { name: 'Wat doet Forge dan?' });
      await modeSelect.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `settings-mode-${width}-${theme}`);
      const card = await page.locator('[data-row="router-own"]').boundingBox();
      const select = await modeSelect.boundingBox();
      if (card && select) expect(select.x + select.width).toBeLessThanOrEqual(card.x + card.width + 1);
      await noOverflow(page, width);
    });

    test(`settings Testen 409 entry_unusable ${width} ${theme}`, async ({ page, context }) => {
      await stub(context, { routerWarning: false });
      await prepare(page, theme, width);
      await page.goto(`${SHOTS_ORIGIN}/#/settings?focus=router`);
      const own = page.locator('[data-row="router-own"]');
      await own.getByRole('button', { name: 'Meer info' }).click();
      const testen = page.locator('.fs-router__pick-ctl button');
      await expect(testen).toBeEnabled();
      await testen.click();
      await expect(page.getByText(String(UNAVAILABLE.nl))).toBeVisible();
      await settle(page);
      await testen.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, `settings-409-${width}-${theme}`);
      await noOverflow(page, width);
    });
  }
}
