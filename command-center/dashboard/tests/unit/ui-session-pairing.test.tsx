/**
 * FU-STEP2 (Security Boss Step 2): the window authenticates with an HttpOnly session cookie that is
 * delivered out of band, never read from the page. These tests cover the dashboard side:
 *   - every write helper sends the cookie: `same-origin` by default, `credentials: 'include'` only on
 *     the Vite dev page (another origin the gateway trusts with credentials);
 *   - a write refused with `ui_session_required` switches the pairing state on;
 *   - `checkUiSession()` asks `GET /api/ui-session` with the cookie and records the answer, and keeps
 *     quiet when the gateway cannot answer;
 *   - the pairing card: hidden unless pairing is required; the browser variant shows the launcher
 *     command with a copy button, the desktop variant shows no command at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { translate } from '@/i18n';
import {
  PAIRING_LAUNCH_COMMAND,
  UI_SESSION_PATH,
  _resetPairingStateForTests,
  getPairingState,
  isPairingRequired,
  setPairingState,
} from '@/lib/ui-session';
import { checkUiSession, gwDelete, gwGet, gwPatch, gwPost, writeCredentials } from '@/prototype/state/gateway-client';
import { PairingCard, PairingNotice } from '@/views/chat/errors/PairingCard';
import { pairingKey } from '@/views/chat/errors/pairing-copy';
import type { PairingCopyName } from '@/views/chat/errors/pairing-copy';

type FetchInit = RequestInit | undefined;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string, init: FetchInit) => Response | Promise<Response>) {
  const calls: { url: string; init: FetchInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const REFUSAL = { ok: false, error: 'missing or invalid session cookie or execution token', code: 'ui_session_required' };

beforeEach(() => {
  _resetPairingStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { forge?: unknown }).forge;
});

describe('write helpers send the session cookie', () => {
  it('writeCredentials: include only on the Vite dev page origins the gateway trusts, same-origin everywhere else', () => {
    expect(writeCredentials('http://127.0.0.1:5173')).toBe('include');
    expect(writeCredentials('http://localhost:5173')).toBe('include');
    for (const other of ['http://127.0.0.1:4100', 'http://127.0.0.1:49519', 'https://evil.example', 'null', undefined]) {
      expect(writeCredentials(other)).toBe('same-origin');
    }
  });

  it('on the Vite dev page gwPost, gwPatch and gwDelete send credentials: include; gwGet stays unchanged', async () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5173' });
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    await gwPost('/api/conversations', { project: 'p' });
    await gwPatch('/api/conversations/c-1', { title: 't' });
    await gwDelete('/api/conversations/c-1');
    await gwGet('/api/health');
    expect(calls.map((c) => c.init?.credentials)).toEqual(['include', 'include', 'include', undefined]);
  });

  it('on any other page the writes keep the same-origin default (a cross-origin mock with ACAO * keeps working)', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    await gwPost('/api/conversations', { project: 'p' });
    expect(calls[0].init?.credentials).toBe('same-origin');
  });

  it('a write refused with ui_session_required switches the pairing state on; other refusals do not', async () => {
    stubFetch(() => jsonResponse(403, { ok: false, error: 'this route only accepts the dashboard token', code: 'agent_token_refused' }));
    const other = await gwPost('/api/config', {});
    expect(other).toEqual({ ok: false, error: 'this route only accepts the dashboard token' });
    expect(getPairingState()).toBe('unknown');

    stubFetch(() => jsonResponse(403, REFUSAL));
    const refused = await gwDelete('/api/conversations/c-1');
    expect(refused).toEqual({ ok: false, error: REFUSAL.error });
    expect(getPairingState()).toBe('required');
  });

  it('isPairingRequired only matches a 403 with that exact code', () => {
    expect(isPairingRequired(403, REFUSAL)).toBe(true);
    expect(isPairingRequired(401, REFUSAL)).toBe(false);
    expect(isPairingRequired(403, { code: 'ui_session' })).toBe(false);
    expect(isPairingRequired(403, null)).toBe(false);
    expect(isPairingRequired(403, [REFUSAL])).toBe(false);
  });
});

describe('checkUiSession', () => {
  it('asks GET /api/ui-session with the cookie and records paired / required', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });
    const calls = stubFetch(() => jsonResponse(200, { ok: true, paired: false }));
    await expect(checkUiSession()).resolves.toBe('required');
    expect(calls[0].url.endsWith(UI_SESSION_PATH)).toBe(true);
    expect(calls[0].init).toEqual({ method: 'GET', credentials: 'include' });

    stubFetch(() => jsonResponse(200, { ok: true, paired: true }));
    await expect(checkUiSession()).resolves.toBe('paired');
  });

  it('keeps the state when the gateway cannot answer (offline, older gateway, odd body)', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(checkUiSession()).resolves.toBe('unknown');
    stubFetch(() => jsonResponse(404, { ok: false, error: 'not found' }));
    await expect(checkUiSession()).resolves.toBe('unknown');
    stubFetch(() => jsonResponse(200, { ok: true }));
    await expect(checkUiSession()).resolves.toBe('unknown');
    stubFetch(() => new Response('not json', { status: 200 }));
    await expect(checkUiSession()).resolves.toBe('unknown');
  });
});

describe('PairingCard', () => {
  const copy = (name: PairingCopyName) => translate('en', pairingKey(name));

  it('browser: title, the launcher command and a copy button that copies exactly that command', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<PairingCard desktop={false} />);
    const card = screen.getByRole('alert');
    expect(card).toHaveAttribute('data-code', 'ui_session_required');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(copy('title'));
    expect(screen.getByText(PAIRING_LAUNCH_COMMAND).tagName).toBe('CODE');
    fireEvent.click(screen.getByRole('button', { name: copy('copy') }));
    expect(writeText).toHaveBeenCalledWith('forge dashboard');
    // "Copied" only once the clipboard accepted the text (FU, review low).
    expect(await screen.findByRole('button', { name: copy('copied') })).toBeInTheDocument();
  });

  it('desktop: no command and no copy button (the app never needs a terminal)', () => {
    render(<PairingCard desktop />);
    expect(screen.queryByText(PAIRING_LAUNCH_COMMAND)).toBeNull();
    expect(screen.queryByRole('button', { name: copy('copy') })).toBeNull();
    expect(screen.getByText(copy('bodyDesktop'))).toBeInTheDocument();
  });

  it('the re-check button calls back and is disabled while a check runs', () => {
    const onRecheck = vi.fn();
    const { rerender } = render(<PairingCard desktop={false} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByRole('button', { name: copy('recheck') }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    rerender(<PairingCard desktop={false} onRecheck={onRecheck} checking />);
    expect(screen.getByRole('button', { name: copy('checking') })).toBeDisabled();
  });
});

describe('PairingNotice', () => {
  it('renders nothing while paired or unknown, the card once the gateway says required, and hides again after a re-check', async () => {
    let paired = true;
    stubFetch(() => jsonResponse(200, { ok: true, paired }));
    const { container } = render(<PairingNotice />);
    await waitFor(() => expect(getPairingState()).toBe('paired'));
    expect(container).toBeEmptyDOMElement();

    act(() => setPairingState('required'));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    paired = true;
    fireEvent.click(screen.getByRole('button', { name: translate('en', pairingKey('recheck')) }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('inside the desktop app the card shows the desktop text', async () => {
    (globalThis as { forge?: unknown }).forge = { gatewayOrigin: () => 'http://127.0.0.1:4555' };
    const calls = stubFetch(() => jsonResponse(200, { ok: true, paired: false }));
    render(<PairingNotice />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(calls[0].url).toBe('http://127.0.0.1:4555' + UI_SESSION_PATH);
    expect(screen.queryByText(PAIRING_LAUNCH_COMMAND)).toBeNull();
  });
});
