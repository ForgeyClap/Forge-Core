/**
 * Forge Command Center — the gateway's HTTP/SSE primitives.
 *
 * WP7b (`gateway-adapter.ts` / `gateway-chat.ts` build on this). No React here —
 * this file is pure transport: a fetch/EventSource wrapper plus the small,
 * defensive JSON-extraction helpers this codebase already uses in
 * `store-adapter.ts` / `graph-builder.ts` / `live-store.ts` (each file keeps its
 * own tiny copy rather than sharing one utility module — the existing
 * convention this file follows).
 *
 * TRANSPORT CHOICE (see `gateway-adapter.ts`'s header for the full 3-line
 * justification): REST polling + Server-Sent Events, never the bridge's 39-op
 * WebSocket protocol. `GATEWAY_ORIGIN` is a hardcoded loopback literal — the
 * same convention `bridge-client.ts` documents for "the one legitimate place
 * the frontend reaches its own loopback backend": reach the network only via
 * `globalThis.fetch` / `globalThis.EventSource`, never the bare identifier
 * (the repo's `no-restricted-globals`/`no-restricted-syntax` ESLint rules and
 * `tests/unit/no-runtime-contact.test.ts`'s loopback-host scan both already
 * accept this exact shape with zero rule changes — verified against the gateway's
 * own :4100 port, which is a different port than the bridge's :4517 but the same
 * loopback host).
 */

import { UI_SESSION_PATH, getPairingState, isPairingRequired, setPairingState } from '@/lib/ui-session';
import type { PairingState } from '@/lib/ui-session';

/**
 * The browser build's gateway origin. Literal and loopback-only, on purpose — see header. Kept as
 * the FALLBACK constant: the desktop app runs its gateway on whatever free loopback port it found,
 * so production code resolves the origin through `gatewayOrigin()` below, never this literal.
 */
export const GATEWAY_ORIGIN = 'http://127.0.0.1:4100';

/** A loopback http origin with an explicit port, nothing else (no path, no credentials, no https). */
const LOOPBACK_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;

/** True when `value` is `http://127.0.0.1:<port>` or `http://localhost:<port>` with 1 <= port <= 65535. */
export function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = LOOPBACK_ORIGIN_RE.exec(value);
  if (match === null) return false;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

interface ForgeDesktopBridge {
  readonly gatewayOrigin?: unknown;
}

/** The desktop preload's `window.forge`, or null in a plain browser (and in any non-function shape). */
function desktopBridge(): ForgeDesktopBridge | null {
  const candidate = (globalThis as { forge?: unknown }).forge;
  return typeof candidate === 'object' && candidate !== null ? (candidate as ForgeDesktopBridge) : null;
}

/** True when the page runs inside the Forge Systeem desktop app (its preload exposes `window.forge`). */
export function isDesktopApp(): boolean {
  const bridge = desktopBridge();
  return bridge !== null && typeof bridge.gatewayOrigin === 'function';
}

/**
 * The origin every gateway call goes to. In the desktop app this is the port the app's own gateway
 * listens on (`window.forge.gatewayOrigin()`, validated as a loopback origin again here); anything
 * else (a plain browser, an empty or non-loopback value, a throwing bridge) falls back to the
 * browser build's `GATEWAY_ORIGIN`. Read per call, never cached, so a test can swap `window.forge`.
 */
export function gatewayOrigin(): string {
  const bridge = desktopBridge();
  if (bridge === null || typeof bridge.gatewayOrigin !== 'function') return GATEWAY_ORIGIN;
  try {
    const value: unknown = (bridge.gatewayOrigin as () => unknown)();
    return isLoopbackOrigin(value) ? value : GATEWAY_ORIGIN;
  } catch {
    return GATEWAY_ORIGIN;
  }
}

/**
 * fix-sec-round #1 (HIGH): the header name for the gateway's per-boot exec token — MUST stay in
 * sync with `gateway/src/security.mjs`'s own `EXEC_TOKEN_HEADER` literal (two separate builds/
 * packages, so this is a hardcoded mirror, not a shared import — the same convention this file
 * already uses for `GATEWAY_ORIGIN` itself).
 */
export const EXEC_TOKEN_HEADER = 'x-cc-exec-token';

export const EXEC_TOKEN_META_NAME = 'cc-exec-token';

/**
 * Reads a `<meta name="cc-exec-token">` tag from the page. LEGACY since FU-STEP2 (Security Boss
 * Step 2): the gateway no longer puts any token into its served HTML, so against a current gateway
 * this returns `null` and callers simply send no header. The window authenticates with an HttpOnly
 * session cookie instead (delivered by the desktop app, or by the launcher's one-time pairing link;
 * see `@/lib/ui-session`), which page script can never read and the write helpers below send with
 * `credentials: 'include'`. Kept so the many existing call sites stay unchanged.
 */
export function readExecToken(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector(`meta[name="${EXEC_TOKEN_META_NAME}"]`);
  const content = meta ? meta.getAttribute('content') : null;
  return content !== null && content.trim().length > 0 ? content : null;
}

/** The real command that starts the gateway, shown in the honest DISCONNECTED state. */
export const GATEWAY_START_COMMAND = 'node command-center/gateway/bin.mjs';

/** An absolute gateway URL for `path` (which starts with `/`), on the resolved origin. */
export function gatewayUrl(path: string): string {
  return `${gatewayOrigin()}${path}`;
}

export interface GatewayOk {
  readonly ok: true;
  readonly data: Record<string, unknown>;
}

export interface GatewayFail {
  readonly ok: false;
  readonly error: string;
}

export type GatewayResult = GatewayOk | GatewayFail;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * FU-STEP2: every write must carry the session cookie. A page on the gateway's own origin (the
 * desktop app, a browser on the gateway page) sends it with the default `same-origin`. The Vite dev
 * server is ANOTHER origin, so there the cookie only travels with `include`. The gateway answers
 * exactly these origins with Access-Control-Allow-Credentials, but ONLY when it was started with its
 * dev switch `FORGE_DEV_ORIGINS=1` (gateway/src/security.mjs DEV_ORIGINS / devOriginsEnabled, a
 * hardcoded mirror like GATEWAY_ORIGIN above); without the switch the gateway refuses the dev page,
 * which is the safe default for every desktop and launcher gateway. Every other cross-origin page
 * keeps the default, so it never sends the cookie anywhere and a mock that answers
 * `Access-Control-Allow-Origin: *` keeps working. Reads stay without it: no GET route needs the cookie
 * (except `checkUiSession`).
 */
export const COOKIE_DEV_PAGE_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** `include` on the Vite dev page, `same-origin` (the fetch default) everywhere else. */
export function writeCredentials(pageOrigin: string | undefined = globalThis.location?.origin): RequestCredentials {
  return pageOrigin !== undefined && COOKIE_DEV_PAGE_ORIGINS.includes(pageOrigin) ? 'include' : 'same-origin';
}

/** A refused write that says "this window is not paired" switches the pairing card on. */
function notePairingRefusal(status: number, body: unknown): void {
  if (isPairingRequired(status, body)) setPairingState('required');
}

/**
 * Asks the gateway whether THIS window holds the session cookie (`GET /api/ui-session`, with the
 * cookie) and records the answer in `@/lib/ui-session`. Never throws. When the gateway cannot answer
 * (offline, an older gateway without the route, a body without `paired`) the state is left as it
 * was, so no pairing card appears for a problem the connection UI already shows.
 */
export async function checkUiSession(): Promise<PairingState> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(UI_SESSION_PATH), { method: 'GET', credentials: writeCredentials() });
  } catch {
    return getPairingState();
  }
  if (!res.ok) return getPairingState();
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return getPairingState();
  }
  const paired = asRecord(body)?.paired;
  if (paired === true) setPairingState('paired');
  else if (paired === false) setPairingState('required');
  return getPairingState();
}

/**
 * GET one gateway route. Never throws — every failure is a typed `{ok:false}`.
 *
 * on a non-OK response, the real JSON body's own `error` string (when present) is now
 * surfaced verbatim — same fallback shape `gwPost` below already uses (a generic `HTTP <status>`
 * only when the body carries no usable `error` field). Every existing GET-failure fixture in this
 * codebase's own tests uses an EMPTY body (`{}`), so this is purely additive: nothing that
 * currently asserts the generic `HTTP <status>` string changes, while a route that DOES return a
 * real, plain-language reason (e.g. the folder-picker's `GET /api/discord/browse-folder`) is no
 * longer flattened to a meaningless status code.
 */
export async function gwGet(path: string): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), { method: 'GET' });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body is handled below by the !res.ok / empty-record fallback.
  }
  if (!res.ok) {
    const record = asRecord(body) ?? {};
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: asRecord(body) ?? {} };
}

/**
 * POST one gateway route with a JSON body. Never throws.
 *
 * `extraHeaders` (fix-sec-round #1): additive, optional headers — e.g. the exec token a real
 * write route may require. Omitted by every pre-existing call site, so this stays byte-identical
 * to before for every route that does not need it.
 */
export async function gwPost(
  path: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      credentials: writeCredentials(),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Handled by the !res.ok fallback below.
  }
  const record = asRecord(parsed) ?? {};
  if (!res.ok) {
    notePairingRefusal(res.status, parsed);
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: record };
}

/**
 * PATCH one gateway route with a JSON body. Never throws. Mirrors `gwPost`'s own shape exactly
 * (same extraHeaders convention for the exec token a real write route requires) — added for
 * feat-agent-model-edit's `PATCH /api/agents/:slug/model`, the first PATCH route this gateway has.
 */
export async function gwPatch(
  path: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      credentials: writeCredentials(),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Handled by the !res.ok fallback below.
  }
  const record = asRecord(parsed) ?? {};
  if (!res.ok) {
    notePairingRefusal(res.status, parsed);
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: record };
}

/**
 * DELETE one gateway route. Never throws — every failure is a typed `{ok:false}`.
 *
 * `extraHeaders` (feat-delete-conversation): additive, optional headers — the real write route
 * this drives (`DELETE /api/conversations/:id`) requires the same per-boot exec token every other
 * real write route needs (see `gwPost`'s own doc comment for the identical convention).
 */
export async function gwDelete(
  path: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), { method: 'DELETE', headers: { ...extraHeaders }, credentials: writeCredentials() });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Handled by the !res.ok fallback below.
  }
  const record = asRecord(parsed) ?? {};
  if (!res.ok) {
    notePairingRefusal(res.status, parsed);
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: record };
}

/**
 * Opens a real EventSource to one gateway SSE route. Referenced through
 * `globalThis.EventSource` (a MemberExpression, not the banned bare
 * `new EventSource(...)` — mirrors `bridge-client.ts`'s own `globalThis.WebSocket`
 * convention) so the offline-only ESLint guard stays meaningful everywhere else.
 */
export function gwEventSource(path: string): EventSource {
  return new globalThis.EventSource(gatewayUrl(path));
}

/* ========================================================================== */
/*  Defensive extraction — mirrors the pattern already used throughout this   */
/*  codebase (store-adapter.ts, graph-builder.ts, live-store.ts, UsageBar.tsx) */
/* ========================================================================== */

export function pickRecord(payload: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = asRecord(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

export function pickString(payload: unknown, keys: readonly string[]): string | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

export function pickNumber(payload: unknown, keys: readonly string[]): number | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function pickBool(payload: unknown, keys: readonly string[]): boolean | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

export function pickArray(payload: unknown, keys: readonly string[]): readonly Record<string, unknown>[] {
  const obj = asRecord(payload);
  if (obj === null) return [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  return [];
}

/** Like `pickArray`, but for an array of plain strings (e.g. a task's `notes`). */
export function pickStringArray(payload: unknown, keys: readonly string[]): readonly string[] {
  const obj = asRecord(payload);
  if (obj === null) return [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

export { asRecord };
