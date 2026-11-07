/**
 * WP B2 part 2 — screenshot loop for Settings › Accounts (provider cards) and the onboarding
 * "API-sleutel" step, at 1440x900 and 390x844, in Dutch.
 *
 * Never touches a live gateway: the build under test is served from B2_DIST (a scratch build, not
 * dashboard/dist) by a throwaway static server on a free port, and every request to the gateway
 * origin (http://127.0.0.1:4100) is answered in-process by `context.route` with fixtures in the
 * shapes of _scratch/b2/contract-providers.md. The desktop key vault is a stub on window.forge.keys
 * (contract-keys.md shapes); no key is real. Skipped when B2_DIST is not set, so the default e2e
 * suite is unaffected. Shots go to B2_SHOTS (default: test-results/b2-shots).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { SHOTS_ORIGIN } from './live-gateway-helpers';
import type { BrowserContext, Locator, Page } from '@playwright/test';

// A visibly fake, screenshot-only value. Built from two parts so no literal in this file looks like a provider key
// (the doctor's leak scan flags any sk- string of 20+ characters, which is exactly what it should do).
const FAKE_KEY_PREFIX = 's' + 'k-proj-';

const DIST = process.env.B2_DIST ?? '';
const SHOTS = process.env.B2_SHOTS ?? path.join('test-results', 'b2-shots');
const ROUND = process.env.B2_ROUND ?? 'r1';
/** Optional: 'dark' or 'light' forces the theme (default: the app's own 'system'). */
const THEME = process.env.B2_THEME ?? '';

test.skip(DIST === '' && SHOTS_ORIGIN === '', 'B2_DIST not set: this screenshot spec only runs on a scratch build');

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

function providerRow(id: string, label: string, extra: Record<string, unknown>) {
  return { id, label, kind: 'api-key', key_name: null, key_source: null, tested: false, live: false, tos: { required: false, checked_on: '2026-11-01' }, ...extra };
}

const KEYED: [string, string, string][] = [
  ['gemini-openai', 'Google Gemini (OpenAI-compatible)', 'GEMINI_API_KEY'],
  ['xai', 'xAI (Grok API)', 'XAI_API_KEY'],
  ['mistral', 'Mistral', 'MISTRAL_API_KEY'],
  ['deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY'],
  ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY'],
  ['together', 'Together AI', 'TOGETHER_API_KEY'],
];

function fixtures(): Record<string, unknown> {
  const checkup = {
    ok: true,
    checked_at: new Date().toISOString(),
    duration_ms: 1200,
    timed_out: false,
    claude: { found: true, version: '2.1.316', signedIn: true },
    codex: { found: true, version: '0.80.0' },
    ollama: { found: true, up: true, models: ['qwen2.5:0.5b'] },
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    disk_free_gb: 190,
    port: 4100,
    writable_project_dir: null,
  };
  const providers = [
    providerRow('claude-code-cli', 'Claude Code (your own sign-in)', { kind: 'subscription', status_code: 'connected', state: 'signed-in', live: true, tos: { required: true, checked_on: '2026-11-01' } }),
    providerRow('codex-cli', 'Codex (your own sign-in)', { kind: 'subscription', status_code: 'not-connected', state: 'not-connected', live: true, tos: { required: true, checked_on: '2026-11-01' } }),
    providerRow('ollama-local', 'Ollama (this PC)', { kind: 'local', local: true, status_code: 'connected', state: 'reachable', live: true }),
    providerRow('anthropic', 'Anthropic API', { key_name: 'ANTHROPIC_API_KEY', key_source: 'vault', status_code: 'not-connected', state: 'configured' }),
    providerRow('nvidia-nim', 'NVIDIA NIM', { key_name: 'NVIDIA_API_KEY', key_source: 'env', status_code: 'error', state: 'auth-failed' }),
    providerRow('openai', 'OpenAI', { key_name: 'OPENAI_API_KEY', status_code: 'no-key', state: 'not-configured' }),
    providerRow('groq', 'Groq', { key_name: 'GROQ_API_KEY', status_code: 'no-key', state: 'not-configured' }),
    ...KEYED.map(([id, label, key]) => providerRow(id, label, { key_name: key, status_code: 'no-key', state: 'not-configured' })),
    providerRow('lmstudio', 'LM Studio', { kind: 'local', local: true, status_code: 'not-connected', state: 'unreachable' }),
    providerRow('gemini-cli', 'Gemini CLI (not recommended)', { kind: 'cli-detect-only', status_code: 'not-installed', state: 'not-installed', tos: { required: true, checked_on: '2026-11-01' } }),
  ];
  return {
    '/api/health': { ok: true, runtime: { state: 'OK' }, gateway: { version: '0.1.0', project_root: 'C:\\Forge', data_dir: 'C:\\Forge\\data' }, claudeCode: { available: true } },
    '/api/checkup': checkup,
    '/api/providers': { ok: true, providers, tos_checked_on: '2026-11-01', captured_at: new Date().toISOString() },
    '/api/models': { ok: true, roles: { lead: { model: 'sonnet', why: 'verdeelt het werk' } } },
    '/api/projects': { ok: true, projects: [], default_project_id: null },
  };
}

/** The exec token the shots page carries in its meta tag (the real gateway injects one per boot). */
const SHOT_TOKEN = 'shots-exec-token';
/** Every test call's exec-token header, so the spec can prove the write route carries it. */
const testTokens: (string | undefined)[] = [];

async function mockGateway(context: BrowserContext): Promise<void> {
  const data = fixtures();
  await context.route('http://127.0.0.1:4100/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/stream')) return route.abort();
    if (url.pathname.endsWith('/test')) {
      testTokens.push(route.request().headers()['x-cc-exec-token']);
      if (url.pathname === '/api/providers/anthropic/test') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            provider: 'anthropic',
            result: { ok: true, status_code: 'connected', state: 'connected', latency_ms: 212, detail: 'GET /models answered' },
            row: providerRow('anthropic', 'Anthropic API', { key_name: 'ANTHROPIC_API_KEY', key_source: 'vault', status_code: 'connected', state: 'connected' }),
            live: true,
          }),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result: { ok: false, status_code: 'error', state: 'auth-failed', latency_ms: 318, detail: 'HTTP 401 from integrate host' }, live: true }),
      });
    }
    const body = data[url.pathname] ?? { ok: true };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function open(page: Page, hash: string, desktop: boolean, onboardingDone = true): Promise<void> {
  await page.addInitScript(
    ({ desktopApp, done, theme, token }) => {
      document.addEventListener('DOMContentLoaded', () => {
        const meta = document.createElement('meta');
        meta.setAttribute('name', 'cc-exec-token');
        meta.setAttribute('content', token);
        document.head.appendChild(meta);
      });
      localStorage.setItem('forge.locale', 'nl');
      if (theme === 'dark' || theme === 'light') localStorage.setItem('forge.prototype.appearance', theme);
      localStorage.setItem('forge.uiMode', 'eenvoudig');
      if (done) localStorage.setItem('forge.onboarding.done', '1');
      if (desktopApp) {
        const stored: Record<string, { last4: string; updated_at: string }> = {
          anthropic: { last4: 'Q7rT', updated_at: '2026-11-01T10:00:00Z' },
        };
        // KEY-VAULT-CONTRACT.md v1.2: the unknown turn state, with the reconnect-now action.
        const waiting = {
          state: 'waiting-for-idle',
          detail: 'Sleutel wordt toegepast zodra de huidige klus klaar is',
          action: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' },
        };
        let pending = false;
        let reconnectCalls = 0;
        const status = (id: string) => ({
          provider_id: id,
          configured: id in stored,
          last4: stored[id]?.last4 ?? null,
          updated_at: stored[id]?.updated_at ?? null,
        });
        (window as unknown as { forge: unknown }).forge = {
          gatewayOrigin: () => 'http://127.0.0.1:4100',
          version: '0.1.0',
          platform: 'win32',
          keys: {
            set: async (id: string, secret: string) => {
              stored[id] = { last4: secret.slice(-4), updated_at: new Date().toISOString() };
              pending = true;
              return { ok: true, status: status(id), apply: waiting };
            },
            // First click: a klus runs (refused, keeps waiting). Second click: restarting.
            reconnectNow: async () => {
              reconnectCalls += 1;
              if (!pending) return { ok: false, code: 'NOTHING_PENDING', message: 'Er is geen sleutelwijziging om toe te passen.' };
              if (reconnectCalls === 1) {
                return { ok: false, code: 'TURN_RUNNING', message: 'Er loopt nu een klus. De sleutel wordt actief zodra die klaar is.', apply: waiting };
              }
              return { ok: true, apply: { state: 'restarting', detail: 'Even opnieuw verbinden...', action: null } };
            },
            delete: async (id: string) => {
              delete stored[id];
              return { ok: true, status: status(id), apply: { state: 'restarting', detail: null } };
            },
            status: async (id: string) => ({ ok: true, status: status(id), apply: pending ? waiting : { state: 'applied', detail: null, action: null } }),
            list: async () => ({
              ok: true,
              vault: { state: 'ready', reason: null, persistent: true },
              keys: Object.keys(stored).map(status),
              apply: { state: 'applied', detail: null },
            }),
          },
        };
      }
    },
    { desktopApp: desktop, done: onboardingDone, theme: THEME, token: SHOT_TOKEN },
  );
  await mockGateway(page.context());
  await page.goto(`${origin}/#${hash}`);
}

/** Redesign 2C: a card's actions (Testen, Inloggen, Over dit account) sit in its "Acties voor <naam>" menu. */
async function rowAction(page: Page, card: Locator, name: string): Promise<void> {
  await card.getByRole('button', { name: /^Acties voor / }).click();
  await page.getByRole('menuitem', { name }).click();
}

async function accountsInView(page: Page) {
  const group = page.locator('[data-row="accounts"]');
  await expect(group.locator('[data-provider="claude-code-cli"]')).toBeVisible();
  await group.scrollIntoViewIfNeeded();
  return group;
}

for (const viewport of [
  { width: 1440, height: 900, name: '1440' },
  { width: 390, height: 844, name: '390' },
]) {
  test(`accounts, desktop app, ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page, '/settings', true);
    const group = await accountsInView(page);
    await page.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}.png`) });
    await group.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-group.png`) });

    // Test on the NVIDIA card (refused key, redacted detail) and the Codex sign-in panel.
    await rowAction(page, group.locator('[data-provider="nvidia-nim"]'), 'Testen');
    await expect(group.locator('[data-provider="nvidia-nim"]').getByRole('status')).toContainText('Test niet gelukt');
    // A passing test on Anthropic: the status word follows the refreshed row (was "Niet verbonden").
    const anthropic = group.locator('[data-provider="anthropic"]');
    await expect(anthropic.locator('.fs-pill')).toHaveText('Niet verbonden');
    await rowAction(page, anthropic, 'Testen');
    await expect(anthropic.locator('.fs-prov__result')).toContainText('Test gelukt in 212 ms.');
    await expect(anthropic.locator('.fs-pill')).toHaveText('Verbonden');
    expect(testTokens.length).toBeGreaterThanOrEqual(2);
    expect(testTokens.every((token) => token === SHOT_TOKEN)).toBe(true);
    await anthropic.scrollIntoViewIfNeeded();
    await anthropic.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-tested.png`) });
    await rowAction(page, group.locator('[data-provider="codex-cli"]'), 'Inloggen');
    await group.locator('[data-provider="codex-cli"]').scrollIntoViewIfNeeded();
    await group.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-actions.png`) });

    // Store a (fake) key for OpenAI (under "Meer accounts") through the vault stub: only last4 remains.
    await group.locator('details.fs-prov__more > summary').click();
    const openai = group.locator('[data-provider="openai"]');
    await openai.getByRole('button', { name: 'Sleutel toevoegen' }).click();
    await openai.getByLabel('API-sleutel voor OpenAI').fill(FAKE_KEY_PREFIX + 'SCREENSHOT-ONLY-not-a-key-ab12');
    await openai.scrollIntoViewIfNeeded();
    await openai.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-keyfield.png`) });
    await openai.getByRole('button', { name: 'Opslaan' }).click();
    await expect(openai.getByText(/Sleutel opgeslagen: •••• ab12/)).toBeVisible();
    await expect(openai.getByText('Sleutel wordt toegepast zodra de huidige klus klaar is')).toBeVisible();
    await expect(openai.getByText('Actief', { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain('SCREENSHOT-ONLY');
    await openai.scrollIntoViewIfNeeded();
    await openai.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-saved.png`) });

    // "Nu opnieuw verbinden": refused while a klus runs (main's Dutch text), then restarting.
    await openai.getByRole('button', { name: 'Nu opnieuw verbinden' }).click();
    await expect(openai.getByText('Er loopt nu een klus. De sleutel wordt actief zodra die klaar is.')).toBeVisible();
    await openai.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-reconnect-refused.png`) });
    await openai.getByRole('button', { name: 'Nu opnieuw verbinden' }).click();
    await expect(openai.getByText('Even opnieuw verbinden...')).toBeVisible();
    await expect(openai.getByRole('button', { name: 'Nu opnieuw verbinden' })).toHaveCount(0);
    await openai.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-reconnecting.png`) });

    await group.locator('details.fs-prov__more').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-app-${viewport.name}-more.png`) });
  });

  test(`accounts, browser build, ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page, '/settings', false);
    const group = await accountsInView(page);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await group.screenshot({ path: path.join(SHOTS, `${ROUND}-accounts-browser-${viewport.name}-group.png`) });
  });

  test(`onboarding key step, desktop app, ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page, '/onboarding', true, false);
    await page.getByRole('button', { name: 'Verder' }).click();
    await page.getByRole('radio', { name: /API-sleutel/ }).check();
    await page.getByRole('button', { name: /^Verder/ }).click();
    await expect(page.locator('.fs-onb__title')).toHaveText('Je API-sleutel');
    await page.screenshot({ path: path.join(SHOTS, `${ROUND}-onboarding-key-${viewport.name}.png`), fullPage: true });
    await page.getByLabel('Van welke dienst is je sleutel?').selectOption('openai');
    await page.getByLabel('API-sleutel voor OpenAI').fill(FAKE_KEY_PREFIX + 'SCREENSHOT-ONLY-not-a-key-Zz90');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page.getByText(/Sleutel opgeslagen: •••• Zz90/)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `${ROUND}-onboarding-key-${viewport.name}-saved.png`), fullPage: true });
  });

  test(`onboarding key step, browser build, ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page, '/onboarding', false, false);
    await page.getByRole('button', { name: 'Verder' }).click();
    await page.getByRole('radio', { name: /API-sleutel/ }).check();
    await page.getByRole('button', { name: /^Verder/ }).click();
    await expect(page.locator('.fs-onb__title')).toHaveText('Je API-sleutel');
    await page.screenshot({ path: path.join(SHOTS, `${ROUND}-onboarding-key-browser-${viewport.name}.png`), fullPage: true });
  });
}
