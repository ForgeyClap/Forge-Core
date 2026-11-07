/**
 * live-gateway-helpers — shared setup for the composer/conversation e2e specs
 * (test-e2e-composer).
 *
 * These specs exercise real, previously-unit-tested-only production behaviour: the message queue,
 * `@`-file mentions over `GET /api/files`, `/`-slash commands, mode/effort persistence, and
 * conversation deletion. They assume nothing about whether the gateway they run against has a real
 * or a mocked (`CC_EXEC_MOCK=1`) exec bridge — every helper here only ever drives the real,
 * documented HTTP/UI contract (`POST /api/conversations`, `DELETE /api/conversations/:id`,
 * `GET /api/conversations`, the Sidebar's real "New chat" action, the real project search) that
 * behaves identically either way. See `playwright.config.ts`'s own header for the opt-in flag that
 * lets these run against an already-live gateway instead of a freshly-spawned one.
 *
 * SANDBOX PROJECT: every spec here runs against a small, disposable Forge self-test project
 * (`SANDBOX_PROJECT`). C1 fix (2026-09-26 laptop re-audit): this used to assume the project
 * already existed on disk — true only on the machine that happened to have created it by hand once,
 * false on any fresh checkout/laptop/CI runner, which failed loudly with "sandbox project
 * 'selftest-full' did not appear in the sidebar project search" (13 fails, all the same cause).
 * `ensureSandboxProject` below now creates it itself, through the real, already-reviewed
 * `POST /api/projects` route (the exact route the app's own "New project" button drives) — never a
 * placeholder or a fixture written straight to disk, so this suite still only ever exercises real,
 * documented HTTP/UI contracts. Because the gateway scans the SAME real `Documents/` tree regardless
 * of which config spawned it (see `gateway/src/paths.mjs`), that project can carry OTHER real
 * conversations at any time (its own past runs, or a concurrently working agent) — every helper below
 * therefore only ever creates/reads/deletes conversations by the EXACT id it itself just created, never
 * "the only conversation in this project" or "whatever is currently displayed", which a background
 * reconciliation effect (`PrototypeProvider.tsx`'s own conversation-activation effect) can otherwise
 * swap out from under a test the instant this test's own id is gone.
 */

import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** A small, disposable Forge self-test project already present on this machine — never a project
 *  with real client work. */
export const SANDBOX_PROJECT = 'selftest-full';

/** The gateway origin `playwright.config.ts` started (it exports it to every worker). */
export const E2E_ORIGIN = process.env.FORGE_E2E_ORIGIN ?? 'http://127.0.0.1:4100';

/**
 * FU-STEP2 P3: pairs this browser context with the spawned gateway through the REAL path the desktop
 * app and the launcher's pairing link use: the HttpOnly `forge_ui` session cookie. The gateway no
 * longer serves a `cc-exec-token` meta tag, so there is no token to read from the HTML any more.
 * `page.request.*` shares the context cookie jar, so the helpers below send no auth header at all.
 * Call before the first page load, so the dashboard's own `GET /api/ui-session` check at mount
 * already sees a paired browser (an unpaired one shows the pairing card instead).
 * Fails loudly when `playwright.config.ts` did not mint a secret (never a silent unpaired run).
 */
/** The port the browser build of the dashboard always calls (`GATEWAY_ORIGIN` in gateway-client.ts). */
const BROWSER_BUILD_ORIGIN = 'http://127.0.0.1:4100';
const preparedPages = new WeakSet<Page>();
/** Requests to the browser build's fixed gateway origin (127.0.0.1:4100) that `prepareLivePage` blocked. */
const blockedOwnerGatewayRequests = new WeakMap<Page, string[]>();

/**
 * Every URL on 127.0.0.1:4100 the page tried to open while it was prepared for a gateway on its OWN
 * port (see `prepareLivePage`). Always `[]` in a clean run: assert it in an `afterEach`.
 */
export function blockedOwnerGatewayUrls(page: Page): readonly string[] {
  return blockedOwnerGatewayRequests.get(page) ?? [];
}

/**
 * Prepares a page for the live-gateway specs, once per page, before its first load:
 * 1. pairs it (`pairContext`);
 * 2. keeps the UI in English when the test did not choose a language itself: these specs were
 *    written against the English labels ("New chat", "Delete conversation"), while the app's default
 *    is now Dutch. Only written when `forge.locale` is still unset, so a test's own choice survives
 *    a reload;
 *    likewise the UI mode starts in Uitgebreid (`forge.uiMode`): since WP B3/B4 (plan §4.2) Bypass,
 *    Denkkracht (effort) and Automatisch plannen are shown only there, and these specs drive exactly
 *    those controls. Eenvoudig hiding them is intended product behaviour, not something to test around;
 * 3. when the gateway runs off 4100 (`FORGE_E2E_GATEWAY_PORT`), exposes `window.forge.gatewayOrigin()`
 *    with that origin. The browser build always calls 4100, which on a developer machine is the
 *    developer's OWN gateway; without this every call would go there (and be refused as foreign). The
 *    bridge is exactly what the desktop app's preload provides for a gateway on its own port, so an
 *    off-4100 run exercises the desktop code path for the gateway origin. On 4100 nothing is injected.
 */
export async function prepareLivePage(page: Page): Promise<void> {
  await pairContext(page);
  if (preparedPages.has(page)) return;
  preparedPages.add(page);
  await page.addInitScript(() => {
    try {
      if (globalThis.localStorage.getItem('forge.locale') === null) globalThis.localStorage.setItem('forge.locale', 'en');
      if (globalThis.localStorage.getItem('forge.uiMode') === null) globalThis.localStorage.setItem('forge.uiMode', 'uitgebreid');
    } catch {
      /* storage unavailable on about:blank: nothing to keep */
    }
  });
  if (E2E_ORIGIN !== BROWSER_BUILD_ORIGIN) {
    // Fail closed (redesign finishing round): port 4100 is the developer's OWN, live gateway. A page that is
    // prepared for a gateway on another port must never reach it, not even by mistake: every request is
    // recorded and aborted in the browser, before it leaves the machine.
    const blocked: string[] = [];
    blockedOwnerGatewayRequests.set(page, blocked);
    await page.route(`${BROWSER_BUILD_ORIGIN}/**`, (route) => {
      blocked.push(`${route.request().method()} ${route.request().url()}`);
      return route.abort('blockedbyclient');
    });
    await page.addInitScript((origin: string) => {
      Object.defineProperty(globalThis, 'forge', { value: Object.freeze({ gatewayOrigin: () => origin }), configurable: true });
    }, E2E_ORIGIN);
  }
}

export async function pairContext(page: Page): Promise<void> {
  const secret = process.env.FORGE_E2E_UI_SESSION ?? '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error('FORGE_E2E_UI_SESSION is missing: playwright.config.ts should mint it; cannot pair the browser.');
  }
  await page.context().addCookies([
    { name: 'forge_ui', value: secret, url: E2E_ORIGIN, httpOnly: true, sameSite: 'Strict' },
  ]);
}

/**
 * C1 fix: creates `projectName` through the real `POST /api/projects` route when it does
 * not already exist — the same route/mechanism the app's own "New project" button drives (see
 * `gateway/src/projects-create.mjs`). Idempotent: a 409 ("already exists") is the expected, correct
 * outcome on a repeat run or a shared machine that already has this project, and is treated as
 * success, never an error. The route's own scaffold (`.claude/forge-dashboard` marker + CLAUDE.md)
 * happens synchronously before the response — the detached, multi-minute real installer that may
 * run afterwards is never awaited here, since the specs in this suite only need the project to be
 * DISCOVERABLE in the sidebar search, not fully installed.
 */
export async function ensureSandboxProject(page: Page, projectName: string = SANDBOX_PROJECT): Promise<void> {
  await pairContext(page);
  const response = await page.request.post('/api/projects', { data: { name: projectName } });
  if (response.status() === 201 || response.status() === 409) return;
  throw new Error(`could not ensure the sandbox project "${projectName}" exists: HTTP ${response.status()} ${await response.text()}`);
}

/**
 * Opens `projectName` through the REAL sidebar search + project row — the same path a person takes,
 * never a direct state injection. Navigates home first so the search field is always reachable
 * regardless of which route the page was previously on. C1 fix: ensures the project exists
 * first (see `ensureSandboxProject`'s own header) rather than assuming it was created by hand once
 * on one specific machine — the "did not appear" failure this used to hit on every OTHER machine.
 */
export async function openSandboxProject(page: Page, projectName: string = SANDBOX_PROJECT): Promise<void> {
  await prepareLivePage(page);
  await page.goto('/#/');
  await page.waitForLoadState('domcontentloaded');
  await ensureSandboxProject(page, projectName);
  // Redesign: the sidebar no longer has a project search. A project is opened from "My projects",
  // the page the sidebar's "My projects" link leads to; its own search field narrows a long list.
  await page.goto('/#/projects');
  const search = page.getByRole('searchbox').first();
  if ((await search.count()) > 0) await search.fill(projectName);
  // Mijn projecten lists one row per project inside the region named after `projects.all` (English here,
  // because `prepareLivePage` pins `forge.locale` to en for these specs).
  const row = page.getByRole('region', { name: 'All projects' }).getByRole('button', { name: projectName, exact: true });
  await expect(row, `sandbox project "${projectName}" did not appear on the My projects page`).toBeVisible({
    timeout: 10_000,
  });
  await row.click();
  // The click leaves Mijn projecten (its search box goes with it), so there is no filter to clear. Waiting for
  // the list to go keeps the next `page.goto` from racing the project switch.
  await expect(page).not.toHaveURL(/#\/projects$/, { timeout: 10_000 });
}

/**
 * Redesign: the send mode, Model, and (Uitgebreid) Effort and Auto-plan no longer sit on the composer's
 * row. They live in the tray that the "+" button (accessible name "Add") opens, so every spec that
 * drives them opens it first, exactly like a person does. Idempotent: an already open tray stays open.
 * Returns the tray, so a caller can scope its locators to it.
 */
export async function openComposerTray(page: Page): Promise<Locator> {
  const add = page.locator('.fw-chat-composer__add').last();
  await expect(add, 'the composer "+" (Add) button is missing').toBeVisible({ timeout: 15_000 });
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  await expect(add).toHaveAttribute('aria-expanded', 'true');
  const tray = page.locator('.fw-chat-composer__tray').last();
  await expect(tray).toBeVisible();
  return tray;
}

/**
 * Drives the sidebar's real "New chat" button (`requestNewConversation` → real
 * `POST /api/conversations`), then FORCES the chat panel onto that exact conversation and returns its
 * real id. Two real, observed (not hypothetical) findings from this suite's own dry run shaped this:
 *
 *   1. The id is read straight from the POST response body, never the header's
 *      `title={conversation.id}` attribute — the header can already be showing something else by the
 *      time this function's own click resolves (see point 2).
 *   2. A `PrototypeProvider.tsx` reconciliation effect activates `data.conversations[0]` the instant
 *      the current `activeConversationId` is not (yet) present in `data.conversations` — and a
 *      brand-new, still-empty conversation genuinely is absent from that list until the client's own
 *      ~4s conversations poll (`gateway-chat.ts`'s `CONVERSATIONS_POLL_MS`) catches up. Once the
 *      effect reassigns away, it does NOT reassign back on its own once the new conversation finally
 *      appears — its guard only re-checks the CURRENT active id, which by then is already "known".
 *      Measured directly against the live gateway: the header stayed on a different, pre-existing
 *      conversation for 12+ seconds straight after "New chat", even though this function's own
 *      conversation had already appeared as a real row in the sidebar after ~4.5s. Explicitly waiting
 *      for that row and clicking it forces a fresh, deterministic `conversation/activate` dispatch —
 *      confirmed to make the header settle on the real id every time in this suite's own dry run.
 *
 * This is a genuine app-level UX gap worth a Build Boss follow-up (a fresh empty conversation's own
 * header can silently point at a stale one for several seconds) — noted in this WP's own report, not
 * silently patched here; this helper only makes THIS suite's assertions target the right conversation.
 */
export async function startNewChat(page: Page): Promise<string> {
  const newChatButton = page.getByRole('button', { name: 'New chat', exact: true }).first();
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/conversations'),
      { timeout: 15_000 },
    ),
    newChatButton.click(),
  ]);
  expect(response.ok(), `POST /api/conversations failed: HTTP ${response.status()}`).toBe(true);
  const body = (await response.json()) as { conversation?: { id?: string } };
  const id = body.conversation?.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('POST /api/conversations did not return a real conversation id.');
  }

  await forceActivateConversation(page, id);
  return id;
}

/**
 * Waits for `id`'s real sidebar row to appear (proving `data.conversations` has caught up — see
 * `startNewChat`'s own header for why that wait cannot be skipped) and clicks it, forcing a fresh,
 * known-good `conversation/activate` dispatch. Used both by `startNewChat` and by any spec whose OWN
 * "New chat"/Send action can lose the reconciliation race — e.g. the message-queue spec found this
 * SAME race also hits the implicit create-on-send path (`gateway-chat.ts`), not just the empty "New
 * chat" button: with a busy shared gateway, a completely unrelated conversation elsewhere on the
 * machine can become `data.conversations[0]` at just the wrong moment and steal activation before
 * this test's own conversation is recognised. Failing this wait loudly (never silently) is
 * deliberate: proceeding while the WRONG conversation is displayed risks a test action (a queued
 * message, a delete) landing on somebody else's real, unrelated conversation instead.
 */
export async function forceActivateConversation(page: Page, id: string): Promise<void> {
  // Redesign: no row carries the conversation id any more (the sidebar shows only the five most
  // recent titles, and the chat's own list shows titles). The helper therefore gives THIS conversation a
  // unique title through the real PATCH route, then selects it in the chat's list (Uitgebreid, which
  // `prepareLivePage` sets) by that exact title: still by the id this test created, never "the first one".
  const title = `e2e-${id}`;
  await pairContext(page);
  const renamed = await page.request.patch(`/api/conversations/${encodeURIComponent(id)}`, { data: { title } });
  expect(renamed.ok(), `PATCH /api/conversations/${id} failed: HTTP ${renamed.status()}`).toBe(true);
  const list = page.getByRole('complementary', { name: 'Conversations' });
  const row = list.getByRole('button', { name: new RegExp(title) }).first();
  await expect(row, `conversation ${id} never appeared as a real row in the chat's list`).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    page.getByRole('heading', { level: 1, name: title }),
    `the chat header did not settle on conversation ${id} after selecting it`,
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * One real, unauthenticated `GET /api/conversations/:id` read — true (200) or false (404) for the
 * EXACT id, never a guess derived from the collection route. `GET /api/conversations` (no id) proved
 * unsuitable for this: it ignores its own `project` query param entirely and appears bounded to a
 * small "most recent across the whole workspace" window, which a busy shared gateway (concurrent
 * agents, concurrent test workers) can push a just-created id out of within milliseconds — a real,
 * observed flake in this suite's own dry run, not a hypothetical one. The single-item route has no
 * such window: it is a direct existence check for the one id this helper is asked about.
 */
export async function conversationExists(page: Page, id: string): Promise<boolean> {
  const response = await page.request.get(`/api/conversations/${encodeURIComponent(id)}`);
  if (response.status() === 404) return false;
  expect(response.ok(), `GET /api/conversations/${id} failed unexpectedly: HTTP ${response.status()}`).toBe(true);
  return true;
}

/**
 * Deletes a conversation by its EXACT id via the real `DELETE /api/conversations/:id` route — used
 * both as the object under test (the delete spec) and as best-effort cleanup after every other spec
 * that creates one. Never throws on an already-deleted id (idempotent from the caller's perspective);
 * every other non-2xx status still surfaces as a thrown error so a real cleanup failure is never
 * silently swallowed.
 */
export async function deleteConversation(page: Page, id: string): Promise<{ readonly ok: boolean; readonly status: number }> {
  await pairContext(page);
  const response = await page.request.delete(`/api/conversations/${encodeURIComponent(id)}`);
  return { ok: response.ok(), status: response.status() };
}

/** Best-effort cleanup for an `afterEach` — swallows a failure (conversation already gone, or the
 *  test never got far enough to create one) rather than masking the real test failure with a cleanup
 *  error, but never silently ignores an id that really should have been deleted and was not; the
 *  caller is expected to still assert deletion explicitly inside the test itself where that matters. */
export async function cleanupConversation(page: Page, id: string | null): Promise<void> {
  if (id === null) return;
  try {
    await deleteConversation(page, id);
  } catch {
    /* best-effort only — the test's own assertions are the real proof, this is just tidy-up */
  }
}

/* ------------------------------------------------------------------------------------------------
 * (redesign 4A): helpers for the capture and accessibility specs that run against a dev
 * server on their own port with the gateway STUBBED in the browser. Nothing here touches a real
 * gateway: every request the page makes to the gateway origin (127.0.0.1:4100) is answered in
 * process by `context.route`, never sent.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The origin a capture/a11y spec opens. `FORGE_SHOTS_ORIGIN` (for example `http://127.0.0.1:5473`, a
 * vite dev server) lets a spec skip its own scratch-build static server. Empty when unset.
 */
export const SHOTS_ORIGIN = (process.env.FORGE_SHOTS_ORIGIN ?? '').replace(/\/+$/, '');

/** The gateway origin the browser build always calls (`GATEWAY_ORIGIN` in gateway-client.ts). */
export const STUB_GATEWAY_ORIGIN = 'http://127.0.0.1:4100';

export const STUB_PROJECT = 'bakkerij-website';

const stubMinutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

function stubJson(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) };
}

export interface GatewayStubOptions {
  /** Refuse every gateway request (the offline state). */
  readonly offline?: boolean;
  /** No conversations: the empty Start / sidebar state. */
  readonly empty?: boolean;
}

export interface GatewayStub {
  /** Every `METHOD /path` the page asked the gateway for. */
  readonly requests: string[];
}

/**
 * Answers the gateway on 127.0.0.1:4100 in the browser context with two projects and three
 * conversations (the shapes `gateway-client.ts` reads). Unknown routes answer `{ok:true}`; the
 * event stream is aborted, as in the other capture specs.
 */
export async function stubGateway(context: BrowserContext, options: GatewayStubOptions = {}): Promise<GatewayStub> {
  const requests: string[] = [];
  if (options.offline) {
    await context.route(`${STUB_GATEWAY_ORIGIN}/**`, (route) => route.abort('connectionrefused'));
    return { requests };
  }
  const turn = (id: string, role: 'user' | 'assistant', text: string, ago: number) => ({
    type: 'turn',
    turn_id: id,
    role,
    text,
    created_at: stubMinutesAgo(ago),
  });
  const conversations = options.empty
    ? []
    : [
        {
          id: 'c-site',
          project: STUB_PROJECT,
          title: 'Website voor bakkerij De Korenaar',
          updated_at: stubMinutesAgo(6),
          turns: [
            turn('t1', 'user', 'Maak een website met drie pagina\u2019s: start, broden en contact.', 40),
            turn('t1', 'assistant', 'Klaar. De drie pagina\u2019s staan in de map **site/**.', 38),
          ],
        },
        {
          id: 'c-menu',
          project: STUB_PROJECT,
          title: 'Menukaart als pdf',
          updated_at: stubMinutesAgo(60 * 26),
          turns: [turn('t1', 'user', 'Zet de menukaart om naar een pdf.', 60 * 27)],
        },
        {
          id: 'c-foto',
          project: 'nieuw-project',
          title: 'Foto\u2019s verkleinen',
          updated_at: stubMinutesAgo(60 * 24 * 3),
          turns: [turn('t1', 'user', 'Maak alle foto\u2019s kleiner dan 300 kB.', 60 * 24 * 3)],
        },
      ];
  await context.route(`${STUB_GATEWAY_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    requests.push(`${method} ${p}`);
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
    if (p === '/api/health') return route.fulfill(stubJson({ ok: true, instance_id: 'stub', runtime: { state: 'OK' }, claude: { available: true } }));
    if (p === '/api/projects') {
      return route.fulfill(
        stubJson({
          ok: true,
          projects: [
            { name: STUB_PROJECT, path: 'C:/Users/Sanne/Documents/Forge Projecten/bakkerij-website', kind: 'website' },
            { name: 'nieuw-project', path: 'C:/Users/Sanne/Documents/Forge Projecten/nieuw-project', kind: 'unknown' },
          ],
          default_project_id: STUB_PROJECT,
        }),
      );
    }
    if (p === '/api/usage') {
      return route.fulfill(
        stubJson({
          ok: true,
          provenance: 'REPORTED',
          level: 'normal',
          week: 18,
          updated_at: stubMinutesAgo(2),
          guard: { available: true, session_pct: 42, week_pct: 18, session_reset_at: new Date(Date.now() + 95 * 60_000).toISOString() },
        }),
      );
    }
    if (p === '/api/conversations' && method === 'GET') {
      const project = url.searchParams.get('project');
      const list = conversations
        .filter((c) => project === null || c.project === project)
        .map((c) => ({ id: c.id, title: c.title, project: c.project, updated_at: c.updated_at, turn_count: c.turns.length }));
      return route.fulfill(stubJson({ ok: true, conversations: list, execution: { available: true, note: null } }));
    }
    if (p === '/api/conversations' && method === 'POST') {
      const body = req.postDataJSON() as { project?: string };
      const created = { id: `c-new-${conversations.length + 1}`, project: body.project ?? STUB_PROJECT, title: 'New conversation', updated_at: new Date().toISOString(), turns: [] as ReturnType<typeof turn>[] };
      conversations.unshift(created);
      return route.fulfill(stubJson({ ok: true, conversation: { id: created.id, project: created.project, title: null } }, 201));
    }
    const item = /^\/api\/conversations\/([^/]+)$/.exec(p);
    if (item && method === 'PATCH') {
      const conv = conversations.find((c) => c.id === decodeURIComponent(item[1]));
      if (!conv) return route.fulfill(stubJson({ ok: false, error: 'conversation not found' }, 404));
      conv.title = (req.postDataJSON() as { title: string }).title;
      return route.fulfill(stubJson({ ok: true, id: conv.id, title: conv.title }));
    }
    if (item && method === 'GET') {
      const conv = conversations.find((c) => c.id === decodeURIComponent(item[1]));
      if (!conv) return route.fulfill(stubJson({ ok: false, error: 'conversation not found' }, 404));
      return route.fulfill(
        stubJson({
          ok: true,
          id: conv.id,
          meta: { title: conv.title, project: conv.project, forked_from: null },
          turns: conv.turns,
          events: [],
          turn_count: conv.turns.length,
          updated_at: conv.updated_at,
          session_id: 'stub-sess-1',
        }),
      );
    }
    return route.fulfill(stubJson({ ok: true }));
  });
  return { requests };
}
