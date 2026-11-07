/**
 * WP B3 — chat & gesprekken: the first send on a fresh project carries accept-edits (never bypass),
 * the session rail (list, search on title and full text, rename, fork), export (md + json), the
 * Dutch usage meter and the connection banner (desktop: no developer command; one retry button).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Conversation } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';
import { Composer } from '@/views/chat/Composer';
import { sendArgsFor } from '@/views/chat/compose-args';
import { DEFAULT_SEND_MODE, readStoredMode } from '@/views/chat/mode-storage';
import { SessionRail } from '@/views/chat/sessions/SessionRail';
import { UsageMeterView } from '@/views/chat/sessions/UsageMeter';
import {
  conversationToJson,
  conversationToMarkdown,
  exportFileName,
  matchesAllWords,
  normalizeTitle,
  queryWords,
  relativeActivity,
  SEARCH_CONCURRENCY,
  searchConversations,
  transcriptText,
} from '@/views/chat/sessions/session-actions';

function conv(id: string, title: string, minutesAgo: number, projectId = 'p1'): Conversation {
  return {
    id,
    projectId,
    title,
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    messageCount: 4,
    messages: [],
  } as unknown as Conversation;
}

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: 'p1',
    activeConversationId: '',
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
    ...overrides,
  } as PrototypeState;
}

function renderWith(ui: ReactElement, state: PrototypeState) {
  const dispatch = vi.fn();
  const value: StoreValue = { state, dispatch };
  return { dispatch, ...render(createElement(PrototypeContext.Provider, { value }, ui)) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('nl');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  setLocale('en');
  setUiMode('eenvoudig');
});

describe('first send on a fresh project', () => {
  // The production Composer's folder chip reads the shared gateway connection store, whose health poll
  // uses fetch. Unmocked, that poll reached the LIVE gateway on 127.0.0.1:4100; under full-suite load the
  // slow in-flight poll then swallowed the ConnectionBanner tests' first poll below (forge-2026-11-04-
  // owner-queue-5 Q5-TESTS). A unit test never touches the network: every fetch here fails fast.
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in unit tests'));
  });

  it('runs in accept-edits, never in bypass', () => {
    expect(DEFAULT_SEND_MODE).toBe('accept-edits');
    expect(readStoredMode('fresh-project')).toBe('accept-edits');
    expect(sendArgsFor('Maak een website', readStoredMode('fresh-project'), undefined)).toEqual(['Maak een website', 'accept-edits']);
  });

  it('the Composer sends the first message with accept-edits (Mag aanpassen selected, no Volledige toegang offered)', () => {
    const onSend = vi.fn(() => true);
    renderWith(
      createElement(Composer, { onSend, onStop: () => undefined, streaming: false, conversationTitle: 'Nieuw gesprek', production: true }),
      buildState({ activeProjectId: 'fresh-project' }),
    );
    // Redesign 2A: the send mode lives in the composer's "+" tray.
    fireEvent.click(screen.getByRole('button', { name: 'Toevoegen' }));
    expect(screen.getByRole('radio', { name: 'Mag aanpassen' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: 'Volledige toegang' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: /Bericht aan Forge/ }), { target: { value: 'Maak een website' } });
    fireEvent.click(screen.getByRole('button', { name: 'Versturen' }));
    expect(onSend).toHaveBeenCalledWith('Maak een website', 'accept-edits');
    expect(onSend.mock.calls.flat()).not.toContain('bypass');
  });

  it('a stored bypass is not honoured in Eenvoudig: the send runs in accept-edits', () => {
    localStorage.setItem('forge.prototype.chatSendMode.p9', 'bypass');
    const onSend = vi.fn(() => true);
    renderWith(
      createElement(Composer, { onSend, onStop: () => undefined, streaming: false, conversationTitle: 'x', production: true }),
      buildState({ activeProjectId: 'p9' }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: /Bericht aan Forge/ }), { target: { value: 'Ga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Versturen' }));
    expect(onSend).toHaveBeenCalledWith('Ga', 'accept-edits');
  });
});

describe('session-actions helpers', () => {
  it('search words match all terms, case-insensitively', () => {
    const words = queryWords('Bakkerij  MENU!');
    expect(words).toEqual(['bakkerij', 'menu']);
    expect(matchesAllWords('Het menu van de bakkerij', words)).toBe(true);
    expect(matchesAllWords('Alleen de bakkerij', words)).toBe(false);
  });

  it('reads title and every turn text from a transcript', () => {
    const text = transcriptText({ meta: { title: 'Site' }, turns: [{ role: 'user', text: 'openingstijden' }, { role: 'assistant', text: 'klaar' }] });
    expect(text).toContain('Site');
    expect(text).toContain('openingstijden');
    expect(text).toContain('klaar');
  });

  it('normalizes titles and refuses an empty one', () => {
    expect(normalizeTitle('  Mijn   site  ')).toBe('Mijn site');
    expect(normalizeTitle('   ')).toBeNull();
    expect(normalizeTitle('x'.repeat(300))?.length).toBe(120);
  });

  it('exports Markdown and JSON with the real messages', () => {
    const rows = [
      { author: 'user', body: 'Hallo', timestamp: '10:00' },
      { author: 'forge', body: 'Dag!', timestamp: '10:01' },
    ];
    const at = new Date('2026-11-02T10:00:00Z');
    const md = conversationToMarkdown('Bakkerij', rows, { you: 'Jij', forge: 'Forge', exportedOn: 'Bewaard op' }, at);
    expect(md).toMatch(/^# Bakkerij\n/);
    expect(md).toContain('## Jij · 10:00');
    expect(md).toContain('## Forge · 10:01');
    const json = JSON.parse(conversationToJson({ id: 'c1', title: 'Bakkerij', projectId: 'p1' }, rows, at));
    expect(json.format).toBe('forge-conversation/1');
    expect(json.messages).toHaveLength(2);
    expect(json.conversation).toEqual({ id: 'c1', title: 'Bakkerij', project: 'p1' });
    expect(exportFileName('Café De Korenaar!', 'md')).toBe('cafe-de-korenaar.md');
    expect(exportFileName('***', 'json')).toBe('gesprek.json');
  });

  it('relative activity never shows a raw timestamp', () => {
    const labels = {
      justNow: 'zojuist',
      minutes: (n: number) => `${n} min geleden`,
      hours: (n: number) => `${n} uur geleden`,
      days: (n: number) => `${n} dagen geleden`,
      unknown: 'onbekend',
    };
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(relativeActivity('2026-11-02T11:59:40Z', now, labels)).toBe('zojuist');
    expect(relativeActivity('2026-11-02T11:55:00Z', now, labels)).toBe('5 min geleden');
    expect(relativeActivity('2026-11-02T09:00:00Z', now, labels)).toBe('3 uur geleden');
    expect(relativeActivity('not a date', now, labels)).toBe('onbekend');
  });
});

describe('SessionRail', () => {
  const conversations = [conv('c1', 'Website bakkerij', 5), conv('c2', 'Menukaart als pdf', 120), conv('c3', 'Ander project', 1, 'p2')];

  it('lists only the active project, newest first, and opens (resumes) a conversation on click', () => {
    const { dispatch } = renderWith(
      createElement(SessionRail, { production: true }),
      buildState({ data: { ...EMPTY_DATASET, conversations } }),
    );
    const names = screen.getAllByRole('button', { name: /bakkerij|Menukaart|Ander/ }).filter((b) => b.className.includes('fw-sessions__open'));
    expect(names.map((b) => b.textContent)).toEqual([expect.stringContaining('Website bakkerij'), expect.stringContaining('Menukaart als pdf')]);
    fireEvent.click(names[1]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c2' });
  });

  it('filters on the full text from the gateway, not only the title', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/conversations/c2')) return jsonResponse({ ok: true, meta: { title: 'Menukaart als pdf' }, turns: [{ role: 'user', text: 'zet de openingstijden erop' }] });
      return jsonResponse({ ok: true, meta: { title: 'Website bakkerij' }, turns: [{ role: 'user', text: 'drie pagina’s' }] });
    });
    renderWith(createElement(SessionRail, { production: true }), buildState({ data: { ...EMPTY_DATASET, conversations } }));
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'openingstijden' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Menukaart als pdf')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Website bakkerij')).toBeNull());
  });

  it('renames through PATCH /api/conversations/:id and shows the new name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    renderWith(createElement(SessionRail, { production: true }), buildState({ data: { ...EMPTY_DATASET, conversations } }));
    fireEvent.click(screen.getByRole('button', { name: 'Naam van Website bakkerij wijzigen' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nieuwe naam' }), { target: { value: 'Bakkerij De Korenaar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await waitFor(() => expect(screen.getByText('Bakkerij De Korenaar')).toBeInTheDocument());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4100/api/conversations/c1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ title: 'Bakkerij De Korenaar' });
  });

  it('forks through POST /api/conversations/:id/fork and opens the new conversation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, id: 'c9', forked_from: 'c1' }, 201));
    const { dispatch } = renderWith(createElement(SessionRail, { production: true }), buildState({ data: { ...EMPTY_DATASET, conversations } }));
    fireEvent.click(screen.getByRole('button', { name: 'Aftakken: nieuw gesprek vanaf Website bakkerij' }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c9' }));
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:4100/api/conversations/c1/fork');
  });

  it('says plainly when the gateway does not offer fork yet (no fake success)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));
    const { dispatch } = renderWith(createElement(SessionRail, { production: true }), buildState({ data: { ...EMPTY_DATASET, conversations } }));
    fireEvent.click(screen.getByRole('button', { name: 'Aftakken: nieuw gesprek vanaf Website bakkerij' }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'toast/push', toast: expect.objectContaining({ title: 'Aftakken lukte niet' }) })),
    );
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation/activate' }));
  });

  it('honest empty states: no project, no conversations', () => {
    renderWith(createElement(SessionRail, { production: true }), buildState({ activeProjectId: '' }));
    expect(screen.getByText('Kies eerst een project; dan staan zijn gesprekken hier.')).toBeInTheDocument();
    cleanup();
    renderWith(createElement(SessionRail, { production: true }), buildState());
    expect(screen.getByText(/Nog geen gesprekken in dit project/)).toBeInTheDocument();
  });
});

describe('searchConversations (bounded full-text search)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never reads more than SEARCH_CONCURRENCY (6) transcripts at the same time', async () => {
    expect(SEARCH_CONCURRENCY).toBe(6);
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse({ ok: true, meta: { title: 'x' }, turns: [{ text: 'brood' }] });
    });
    const many = Array.from({ length: 20 }, (_, i) => conv(`cc-${i}`, `Gesprek ${i}`, i + 1));
    const result = await searchConversations(many, 'brood');
    expect(result.ids.size).toBe(20);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it('an unreadable transcript is cached briefly: a second search right after does not ask the gateway again', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'boom' }, 500));
    const list = [conv('cc-unreadable', 'Logo ontwerp', 1)];
    const first = await searchConversations(list, 'logo');
    const second = await searchConversations(list, 'logo');
    expect(first.unreadable).toBe(1);
    expect(second.unreadable).toBe(1);
    expect(second.ids.has('cc-unreadable')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('UsageMeterView', () => {
  it('shows the measured 5-hour and week percentages', () => {
    render(createElement(UsageMeterView, { reading: { state: 'measured', session: 42, week: 18, sessionResetAt: null } }));
    expect(screen.getByRole('meter', { name: '5 uur' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByRole('meter', { name: 'Week' })).toHaveAttribute('aria-valuenow', '18');
  });

  it('says honestly in Dutch when nothing was measured', () => {
    render(createElement(UsageMeterView, { reading: { state: 'unmeasured', session: null, week: null, sessionResetAt: null } }));
    expect(screen.getByText('Nog niet bekend: Forge heeft je limiet nog niet gemeten.')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
  });
});

describe('ConnectionBanner', () => {
  afterEach(() => {
    delete (globalThis as { forge?: unknown }).forge;
  });

  async function renderBanner() {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { ConnectionBanner } = await import('@/components/shell/ConnectionBanner');
    render(createElement(ConnectionBanner));
    await screen.findByText('Geen verbinding met Forge', undefined, { timeout: 3000 });
  }

  it('desktop app, Eenvoudig: Dutch title, one retry button, never the developer command', async () => {
    (globalThis as { forge?: unknown }).forge = { gatewayOrigin: () => 'http://127.0.0.1:49519' };
    await renderBanner();
    expect(screen.getByRole('button', { name: 'Opnieuw proberen' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('bin.mjs');
    expect(document.body.textContent).not.toContain('4100');
    expect(screen.queryByRole('button', { name: /Technische details/ })).toBeNull();
  });

  it('desktop app, Uitgebreid: technical details show the address, still no developer command', async () => {
    (globalThis as { forge?: unknown }).forge = { gatewayOrigin: () => 'http://127.0.0.1:49519' };
    setUiMode('uitgebreid');
    await renderBanner();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Technische details/ }));
    });
    expect(document.body.textContent).toContain('http://127.0.0.1:49519');
    expect(document.body.textContent).not.toContain('bin.mjs');
  });
});
