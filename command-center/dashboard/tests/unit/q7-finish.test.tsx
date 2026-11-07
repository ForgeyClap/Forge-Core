/**
 * Q7-FINISH — the four visible notes the Q7 Review Boss left.
 *
 *   1. A turn that never started (execution_not_started attempt 1, code 'not_started') says so in one calm line
 *      ("Forge kon dit bericht niet starten …") with the skip line, and offers "Opnieuw proberen" when there is a
 *      real retry path. It also shows when the gateway named no skipped step at all (before: nothing rendered).
 *   2. The Settings copy for provider_unavailable is true for all three causes (verwijderd, uitgezet of geweigerd).
 *   3. The pill of a step whose own API is gone is short ("Niet beschikbaar"); the long reason lives in the notes.
 *   4. A failed answer with an empty body has no bare "Forge · via … · time · copy · regenerate" header: the
 *      notice carries the retry ("Opnieuw proberen") next to "Router-instellingen" instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import notStarted from '../fixtures/app-router/conversation-not-started-skips.json';
import post200 from '../fixtures/app-router/post-200.json';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import en from '@/i18n/locales/en.json';
import { parseRouterGet } from '@/prototype/state/adapter/app-router';
import type { RouterConfig, RouterEntryStatus } from '@/prototype/state/adapter/app-router';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseConversationDetail, readChatMessageRouteTurn } from '@/prototype/state/gateway-chat/live-activity';
import type { ChatSendOutcome } from '@/prototype/state/chat-send';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { Message } from '@/views/chat/Message';
import { entryPill, skipPill } from '@/views/settings/sections/app-router/app-router-model';

type Rec = Record<string, unknown>;

const NOT_STARTED_NL = 'Forge kon dit bericht niet starten. Probeer het opnieuw of kijk in de router-instellingen.';
const NOT_STARTED_EN = 'Forge could not start this message. Try again or check the router settings.';
const RETRY_NL = 'Opnieuw proberen';
const SKIP_NOTE = 'Overgeslagen stappen in je router';

function state(): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'system',
    resolvedTheme: 'light',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
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
  };
}

const OK: ChatSendOutcome = { ok: true, error: null } as unknown as ChatSendOutcome;

function show(message: ChatMessage, regenerate: (() => Promise<ChatSendOutcome>) | null = null) {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(Message, { message, position: 1, total: 1, regenerate })));
}

function forgeOf(detail: Rec, turnId: string): ChatMessage {
  const found = parseConversationDetail('c-not-started', detail).messages.filter((m) => m.author === 'forge' && m.id.startsWith(turnId));
  if (found.length !== 1) throw new Error(`expected one forge message for ${turnId}, got ${found.length}`);
  return found[0];
}

/** The fixture with turn t2's execution_not_started carrying no skipped list (an older gateway). */
function withoutSkips(): Rec {
  const base = notStarted as Rec & { events: Rec[] };
  const events = base.events.map((event) =>
    event.kind === 'execution_not_started' && event.turn_id === 't2' ? { ...event, data: { reason: 'the turn could not start', code: 'not_started' } } : event,
  );
  return { ...base, events };
}

describe('1: a turn that never started says so', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('parsing marks attempt 1 not started, not the failover attempt 2', () => {
    expect(readChatMessageRouteTurn(forgeOf(notStarted as Rec, 't2'))?.notStarted).toBe(true);
    expect(readChatMessageRouteTurn(forgeOf(notStarted as Rec, 't1'))?.notStarted ?? false).toBe(false);
  });

  it('shows the plain line with the skip line, and no Forge header', () => {
    const { container } = show(forgeOf(notStarted as Rec, 't2'));
    expect(screen.getByText(NOT_STARTED_NL)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: SKIP_NOTE })).toBeInTheDocument();
    expect(container.querySelector('.fw-chat-msg__head')).toBeNull();
    expect(screen.getByRole('link', { name: 'Router-instellingen' })).toBeInTheDocument();
  });

  it('offers "Opnieuw proberen" only with a real retry path, and it re-sends', () => {
    const regenerate = vi.fn(() => Promise.resolve(OK));
    show(forgeOf(notStarted as Rec, 't2'), regenerate);
    fireEvent.click(screen.getByRole('button', { name: RETRY_NL }));
    expect(regenerate).toHaveBeenCalledTimes(1);
    cleanup();
    show(forgeOf(notStarted as Rec, 't2'));
    expect(screen.queryByRole('button', { name: RETRY_NL })).toBeNull();
  });

  it('still shows the line when the gateway named no skipped step', () => {
    show(forgeOf(withoutSkips(), 't2'));
    expect(screen.getByText(NOT_STARTED_NL)).toBeInTheDocument();
    expect(screen.queryByRole('note', { name: SKIP_NOTE })).toBeNull();
  });

  it('English follows the locale', () => {
    setLocale('en');
    show(forgeOf(notStarted as Rec, 't2'));
    expect(screen.getByText(NOT_STARTED_EN)).toBeInTheDocument();
  });
});

describe('2: the Settings copy is true for every cause', () => {
  const chainOf = (bundle: unknown) => (bundle as { appRouter: { chain: { unavailable: string; unavailableIn: string } } }).appRouter.chain;

  it('Dutch names removed, switched off and refused, like the chat', () => {
    expect(chainOf(nl).unavailable).toContain('verwijderd, uitgezet of geweigerd');
    expect(chainOf(nl).unavailableIn).toContain('verwijderd, uitgezet of geweigerd');
    expect(chainOf(nl).unavailable).not.toContain('verwijderd of staat uit');
  });

  it('English names removed, switched off and refused, like the chat', () => {
    expect(chainOf(en).unavailable).toContain('removed, switched off or refused');
    expect(chainOf(en).unavailableIn).toContain('removed, switched off or refused');
  });
});

describe('3: the pill of a gone own API is short', () => {
  const config = (parseRouterGet({ ok: true, provenance: 'STORED', config: (post200 as Rec).config, warnings: [], terms: { checked_at: null, sources: [] }, profiles_root_display: null }) as { config: RouterConfig }).config;
  const step = config.entries[1];

  it('skipPill gives its own short label, not the chat sentence', () => {
    const pill = skipPill(step, 'provider_unavailable');
    expect(pill?.key).toBe('appRouter.state.unavailable');
    expect(pill?.tone).toBe('warn');
    expect((nl as { appRouter: { state: { unavailable: string } } }).appRouter.state.unavailable).toBe('Niet beschikbaar');
    expect((en as { appRouter: { state: { unavailable: string } } }).appRouter.state.unavailable).toBe('Not available');
  });

  it('entryPill follows it', () => {
    const status = { id: step.id, label: step.label, enabled: true, eligible: false, ineligibleReason: 'provider_unavailable', state: 'ready', maxPct: null, windows: [], measuredAt: null, source: 'test', resumeAt: null, capability: 'read-answer' } as RouterEntryStatus;
    const pill = entryPill({ entry: step, status, greyed: false, testing: false, test: null, locale: 'nl', now: Date.now() });
    expect(pill.key).toBe('appRouter.state.unavailable');
  });
});

describe('4: a failed answer with an empty body has no bare header', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('no header, no copy button; the notice still says what happened', () => {
    const { container } = show(forgeOf(notStarted as Rec, 't1'));
    expect(container.querySelector('.fw-chat-msg__head')).toBeNull();
    expect(screen.queryByRole('button', { name: /Kopi/ })).toBeNull();
    expect(screen.getByRole('note', { name: 'Melding over wisselen' })).toBeInTheDocument();
  });

  it('the retry sits in the notice when there is a real retry path', () => {
    const regenerate = vi.fn(() => Promise.resolve(OK));
    show(forgeOf(notStarted as Rec, 't1'), regenerate);
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    fireEvent.click(notice.querySelector('button.fw-button') as HTMLButtonElement);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: RETRY_NL })).toBeInTheDocument();
  });

  it('a failed answer WITH text keeps its header', () => {
    const base = notStarted as Rec & { turns: Rec[] };
    const turns = base.turns.map((turn) => (turn.role === 'assistant' ? { ...turn, text: 'Half antwoord.' } : turn));
    const { container } = show(forgeOf({ ...base, turns }, 't1'));
    expect(container.querySelector('.fw-chat-msg__head')).not.toBeNull();
  });
});
