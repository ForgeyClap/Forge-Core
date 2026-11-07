/**
 * App router in the chat, the failure paths (Review Boss findings on part P4; APP-ROUTER-DESIGN.md §4.5,
 * §4.7, §5.1, §6.2 chat):
 *   HIGH   a switched route whose attempt ends down / logged_out / rate_limited / error shows a clear
 *          failure line with a link to the router settings, never an empty bubble; and the ErrorCard
 *          gets the latest `forge_error` of the LAST turn only (never a stale one from an older turn).
 *   MEDIUM `route_exhausted.code` reaches the chat state and picks the exhausted copy.
 *   MEDIUM the folded "Onderbroken antwoord van …" line comes from the `route_attempt_failed` event; a
 *          turn whose attempt 2 still runs stays pending and renders as one message.
 *   LOW    "Forge heeft het niet vanzelf opnieuw geprobeerd" is never shown when Forge DID try to fail
 *          over and nothing was left.
 *   Render rule: switched OR (reason 'first' AND capability !== 'full').
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import ollamaDownAfterSwitch from '../fixtures/app-router/conversation-ollama-down-after-switch.json';
import exhaustedOllamaDown from '../fixtures/app-router/conversation-exhausted-ollama-down.json';
import conversationRouted from '../fixtures/app-router/conversation-routed.json';

import { setLocale, translate } from '@/i18n';
import type { MessageKey, MessageVars } from '@/i18n';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import {
  parseConversationDetail,
  readChatMessageChatError,
  readChatMessageRouteExhausted,
  readChatMessageRouteTurn,
} from '@/prototype/state/gateway-chat/live-activity';
import type { ChatRouteExhausted } from '@/prototype/state/gateway-chat/live-activity';
import { parseChatRoute, readChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import type { ChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import type { ChatMessage, Conversation } from '@/prototype/types/prototype-types';
import ChatView from '@/views/chat/ChatView';
import { Message } from '@/views/chat/Message';
import { exhaustedCopy, routeNoticeCopy } from '@/views/chat/route-notice/route-copy';
import type { NoticeCopy } from '@/views/chat/route-notice/route-copy';

const ctx = { t: (key: MessageKey, vars?: MessageVars) => translate('nl', key, vars), locale: 'nl' };

/** Title, failure line, then the other lines, as the reader meets them. */
function words(copy: NoticeCopy | null): string[] {
  if (!copy) return [];
  return [copy.title, copy.failure, ...copy.lines].filter((line) => line !== null).map((line) => ctx.t(line[0], line[1]));
}

function route(overrides: Record<string, unknown>): ChatMessageRoute {
  const parsed = parseChatRoute({
    target_id: 'ollama-llama31',
    kind: 'provider-model',
    label: 'Ollama · llama3.1',
    model: 'llama3.1:8b',
    capability: 'answers-only',
    reason: 'switch-limit',
    switched: true,
    from_target_id: 'main',
    from_label: 'Hoofdaccount',
    from_window: 'five_hour',
    from_resume_at: null,
    attempt: 2,
    retried: false,
    outcome: 'down',
    handover: { turns: 2, chars: 140, truncated: false },
    ...overrides,
  });
  if (!parsed) throw new Error('route did not parse');
  return parsed;
}

function exhausted(code: ChatRouteExhausted['code'], extra: Partial<ChatRouteExhausted> = {}): ChatRouteExhausted {
  return { resumeAt: null, firstFreeLabel: null, firstFreeAt: null, code, ...extra };
}

/* ------------------------------------------------------------------ render helpers */

function state(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'light',
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
    activeConversationId: 'c1',
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
  };
}

const CHAT: ChatSendController = {
  run: { runId: null, status: null, active: false },
  canSend: true,
  disabledReason: null,
  sending: false,
  stopping: false,
  send: async () => ({ ok: true, error: null }),
  stop: async () => ({ ok: true, error: null }),
};

function show(message: ChatMessage, { position = 1, total = 1, chat = null as ChatSendController | null } = {}) {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  let tree: ReactElement = createElement(PrototypeContext.Provider, { value }, createElement(Message, { message, position, total }));
  if (chat) tree = createElement(ChatSendContext.Provider, { value: chat }, tree);
  return render(tree);
}

function detailOf(fixture: unknown) {
  return parseConversationDetail('c1', fixture as Record<string, unknown>);
}

function showChatView(messages: readonly ChatMessage[]) {
  const conversation = {
    prototype: true,
    id: 'c1',
    projectId: 'p1',
    title: 'Router',
    updatedAt: '2026-11-02T14:20:04.000Z',
    messageCount: messages.length,
    messages,
  } as unknown as Conversation;
  const value: StoreValue = {
    state: state({ data: { ...EMPTY_DATASET, conversations: [conversation] } as PrototypeState['data'] }),
    dispatch: () => undefined,
  };
  const tree: ReactElement = createElement(
    ChatSendContext.Provider,
    { value: CHAT },
    createElement(PrototypeContext.Provider, { value }, createElement(ChatView)),
  );
  return render(createElement(MemoryRouter, null, tree));
}

beforeEach(() => {
  setLocale('nl');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

/* ------------------------------------------------------------------ HIGH: failure line */

describe('HIGH: a switched attempt that fails shows a failure line, never an empty bubble', () => {
  it('Claude at its limit -> switch to Ollama -> Ollama not running: the owner case', () => {
    const detail = detailOf(ollamaDownAfterSwitch);
    const answer = detail.messages[detail.messages.length - 1];
    const { container } = show(answer, { position: 4, total: 4 });
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    expect(notice).toHaveAttribute('data-variant', 'failed');
    expect(notice).toHaveTextContent('Overgeschakeld naar Ollama · llama3.1');
    expect(notice).toHaveTextContent('Ollama draait niet op deze computer. Start Ollama of kies een ander model.');
    expect(within(notice).getByRole('link', { name: 'Router-instellingen' })).toHaveAttribute('href', '#/settings?focus=router');
    // A model that never answered does not claim it "received the last messages" or list what it can do.
    expect(notice).not.toHaveTextContent('kreeg de laatste');
    expect(notice).not.toHaveTextContent('Dit model kan alleen antwoorden');
    // No empty body bubble under the notice.
    expect(container.querySelector('.fw-chat-msg__body')).toBeNull();
  });

  it('every failed outcome has its own words (logged_out, rate_limited, error, model not downloaded, a non-Ollama provider down)', () => {
    const werk = { kind: 'claude-account', label: 'Werk', capability: 'full', target_id: 'werk' };
    expect(words(routeNoticeCopy(route({ ...werk, outcome: 'logged_out' }), ctx))).toContain('Werk is niet ingelogd. Log opnieuw in via de router-instellingen.');
    expect(words(routeNoticeCopy(route({ ...werk, outcome: 'rate_limited' }), ctx, { error: { code: 'rate_limited', resumeAt: null, model: null } }))).toContain(
      'Werk zit aan zijn limiet (weer vrij om onbekend).',
    );
    expect(words(routeNoticeCopy(route({ outcome: 'error' }), ctx))).toContain(
      'Ollama · llama3.1 kon dit niet afmaken door een fout. Probeer het opnieuw of kies een ander model.',
    );
    expect(words(routeNoticeCopy(route({ outcome: 'error' }), ctx, { error: { code: 'model_not_pulled', resumeAt: null, model: 'llama3.1:8b' } }))).toContain(
      'llama3.1:8b staat nog niet op deze computer. Download het in Ollama of kies een ander model.',
    );
    expect(
      words(routeNoticeCopy(route({ outcome: 'down', target_id: 'groq-1', label: 'Groq · llama' }), ctx, { error: { code: 'offline', resumeAt: null, model: null } })),
    ).toContain('Groq · llama reageerde niet. Probeer het later opnieuw of kies een ander model.');
    // A stopped turn is the user's own choice: no failure line.
    expect(routeNoticeCopy(route({ outcome: 'stopped' }), ctx)?.failure ?? null).toBeNull();
  });

  it('an ok switched answer keeps its plain info notice (no failure line, no settings link)', () => {
    const copy = routeNoticeCopy(route({ outcome: 'ok' }), ctx);
    expect(copy?.variant).toBe('to-model');
    expect(copy?.failure).toBeNull();
    expect(copy?.settingsLink).toBe(false);
  });
});

/* ------------------------------------------------------------------ HIGH: chatError */

describe('HIGH: chatError comes from the latest forge_error of the last turn only', () => {
  it('the last turn failed on Ollama: the ErrorCard shows ollama_down (not the earlier rate_limited of attempt 1)', () => {
    const detail = detailOf(ollamaDownAfterSwitch);
    expect(readChatMessageChatError(detail.messages[detail.messages.length - 1])).toMatchObject({ code: 'ollama_down' });
    showChatView(detail.messages);
    const card = screen.getByRole('alert');
    expect(card).toHaveAttribute('data-code', 'ollama_down');
    expect(card).toHaveTextContent('Ollama staat uit');
  });

  it('an error of an OLDER turn never shows once a newer turn answered', () => {
    const fixture = ollamaDownAfterSwitch as { turns: unknown[]; events: unknown[] };
    const detail = detailOf({
      ...fixture,
      turns: [
        ...fixture.turns,
        { type: 'turn', turn_id: 't3', request_id: 'r3', role: 'user', text: 'En nu?', created_at: '2026-11-02T14:30:00.000Z' },
        { type: 'turn', turn_id: 't3', request_id: 'r3', role: 'assistant', text: 'Klaar.', created_at: '2026-11-02T14:30:10.000Z', error: null },
      ],
    });
    for (const message of detail.messages) expect(readChatMessageChatError(message)).toBeNull();
    showChatView(detail.messages);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a last turn that ended fine shows no card even when an earlier attempt of that turn logged an error', () => {
    const detail = detailOf(conversationRouted);
    expect(readChatMessageChatError(detail.messages[detail.messages.length - 1])).toBeNull();
    const t2 = detail.messages[3];
    expect(t2.id).toBe('t2');
    expect(readChatMessageChatError(t2)).toBeNull();
  });

  it('while attempt 2 still runs, the rate_limited of attempt 1 is not shown as the current error', () => {
    const detail = detailOf({
      turns: [{ type: 'turn', turn_id: 't1', request_id: 'r1', role: 'user', text: 'hoi' }],
      events: [
        { kind: 'route_selected', turn_id: 't1', request_id: 'r1', data: { target_id: 'main', label: 'Hoofdaccount', kind: 'claude-account', capability: 'full', reason: 'sticky', attempt: 1 } },
        { kind: 'forge_error', turn_id: 't1', request_id: 'r1', data: { code: 'rate_limited' } },
        { kind: 'route_attempt_failed', turn_id: 't1', request_id: 'r1', data: { text: '', route: { target_id: 'main', label: 'Hoofdaccount', attempt: 1, retried: true, outcome: 'rate_limited' } } },
        { kind: 'route_selected', turn_id: 't1', request_id: 'r1-r2', data: { target_id: 'werk', label: 'Werk', kind: 'claude-account', capability: 'full', reason: 'switch-limit', attempt: 2 } },
      ],
    });
    expect(readChatMessageChatError(detail.messages[detail.messages.length - 1])).toBeNull();
  });

  it('in the gap before route_attempt_failed is written, attempt 2 already running hides the error of attempt 1', () => {
    // Gateway order (exec-lifecycle settleRoute): onSettled starts attempt 2 BEFORE attempt 1's record is written.
    const detail = detailOf({
      turns: [{ type: 'turn', turn_id: 't1', request_id: 'r1', role: 'user', text: 'hoi' }],
      events: [
        { kind: 'route_selected', turn_id: 't1', request_id: 'r1', data: { target_id: 'main', label: 'Hoofdaccount', kind: 'claude-account', capability: 'full', reason: 'sticky', attempt: 1 } },
        { kind: 'forge_error', turn_id: 't1', request_id: 'r1', data: { code: 'rate_limited' } },
        { kind: 'route_selected', turn_id: 't1', request_id: 'r1-r2', data: { target_id: 'werk', label: 'Werk', kind: 'claude-account', capability: 'full', reason: 'switch-limit', attempt: 2 } },
      ],
    });
    expect(readChatMessageChatError(detail.messages[detail.messages.length - 1])).toBeNull();
  });

  it('a turn the user stopped shows no error card', () => {
    const detail = detailOf({
      turns: [
        { type: 'turn', turn_id: 't1', request_id: 'r1', role: 'user', text: 'hoi' },
        { type: 'turn', turn_id: 't1', request_id: 'r1', role: 'assistant', text: 'half', error: 'stopped', stop_reason: 'stopped' },
      ],
      events: [
        { kind: 'forge_error', turn_id: 't1', request_id: 'r1', data: { code: 'api_retry' } },
        { kind: 'stopped_by_user', turn_id: 't1', request_id: 'r1', data: {} },
      ],
    });
    expect(readChatMessageChatError(detail.messages[detail.messages.length - 1])).toBeNull();
  });
});

/* ------------------------------------------------------------------ MEDIUM: exhausted code */

describe('MEDIUM: route_exhausted.code reaches the chat and picks the words', () => {
  it('the code is parsed; a missing or unknown code reads as unknown, never a guess', () => {
    const detail = detailOf(exhaustedOllamaDown);
    expect(detail.messages.map((m) => m.id)).toEqual(['t1', 't1-exhausted']);
    expect(readChatMessageRouteExhausted(detail.messages[1])?.code).toBe('ollama_down');
    const legacy = detailOf({ turns: [{ type: 'turn', turn_id: 't1', role: 'user', text: 'x' }], events: [{ kind: 'route_exhausted', turn_id: 't1', data: { resume_at: null, first_free: null } }] });
    expect(readChatMessageRouteExhausted(legacy.messages[1])?.code).toBe('unknown');
    const odd = detailOf({ turns: [{ type: 'turn', turn_id: 't1', role: 'user', text: 'x' }], events: [{ kind: 'route_exhausted', turn_id: 't1', data: { code: 'something-new' } }] });
    expect(readChatMessageRouteExhausted(odd.messages[1])?.code).toBe('unknown');
  });

  it('ollama_down: own model not running + a Start Ollama hint', () => {
    expect(words(exhaustedCopy(exhausted('ollama_down'), ctx))).toEqual([
      'Je eigen model kan nu niet antwoorden: Ollama draait niet op deze computer.',
      'Start Ollama en stuur je bericht daarna opnieuw. Of kies in de router-instellingen een ander model.',
    ]);
  });

  it('logged_out: the sign-in steps', () => {
    expect(words(exhaustedCopy(exhausted('logged_out'), ctx))).toEqual([
      'Geen account in je router is nu ingelogd, dus Forge kon dit bericht nergens heen sturen.',
      '1. Open hieronder de router-instellingen.',
      '2. Bij een account met ‘Niet ingelogd’: volg de inlogstappen opnieuw en klik op Testen.',
      '3. Stuur je bericht daarna opnieuw.',
    ]);
  });

  it('rate_limited: the earliest time again; unknown: neutral', () => {
    const limit = words(exhaustedCopy(exhausted('rate_limited', { firstFreeLabel: 'Werk', resumeAt: '2026-11-02T16:40:00.000Z' }), ctx));
    expect(limit[0]).toMatch(/^Alle accounts in je router hebben hun limiet bereikt\. Als eerste weer vrij: Werk om \d\d:\d\d\.$/);
    expect(words(exhaustedCopy(exhausted('unknown'), ctx))).toEqual([
      'Forge kon dit bericht nu aan geen enkel account of model in je router geven.',
      'Kijk in de router-instellingen wat er aan staat en probeer het daarna opnieuw.',
    ]);
  });

  it('the exhausted ollama_down notice renders with the settings link, and the ErrorCard says Ollama is off', () => {
    const detail = detailOf(exhaustedOllamaDown);
    show(detail.messages[1], { position: 2, total: 2 });
    expect(screen.getByText('Je eigen model kan nu niet antwoorden: Ollama draait niet op deze computer.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Router-instellingen' })).toHaveAttribute('href', '#/settings?focus=router');
    cleanup();
    showChatView(detail.messages);
    expect(screen.getByRole('alert')).toHaveAttribute('data-code', 'ollama_down');
  });
});

/* ------------------------------------------------------------------ MEDIUM: route_attempt_failed */

describe('MEDIUM: the folded failed attempt comes from the route_attempt_failed event', () => {
  it('a finished turn: one answer message carrying the folded attempt, its partial text inside', () => {
    const detail = detailOf(conversationRouted);
    expect(detail.messages.map((m) => m.id)).toEqual(['t1', 't1', 't2', 't2', 't3', 't3']);
    const t2 = detail.messages[3];
    expect(readChatMessageRoute(t2)).toMatchObject({ targetId: 'werk', attempt: 2 });
    expect(readChatMessageRouteTurn(t2)?.failedAttempt).toMatchObject({ text: 'Ik begin met de knop op de', route: { label: 'Hoofdaccount', outcome: 'rate_limited' } });
    const { container } = show(t2, { position: 4, total: 6 });
    expect(container.querySelectorAll('article')).toHaveLength(1);
    expect(screen.getByText('Onderbroken antwoord van Hoofdaccount (limiet)')).toBeInTheDocument();
    const details = container.querySelector('details.fw-route-folded') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent('Ik begin met de knop op de');
    expect(screen.getByText(/De knop op de startpagina is nu groter/)).toBeInTheDocument();
  });

  it('a turn with attempt 2 still running stays pending and renders one message', () => {
    const detail = detailOf({
      turns: [{ type: 'turn', turn_id: 't1', request_id: 'r1', role: 'user', text: 'Maak de knop groter.' }],
      events: [
        { kind: 'route_selected', turn_id: 't1', request_id: 'r1', data: { target_id: 'main', label: 'Hoofdaccount', kind: 'claude-account', capability: 'full', reason: 'sticky', attempt: 1 } },
        { kind: 'route_attempt_failed', turn_id: 't1', request_id: 'r1', data: { text: '', route: { target_id: 'main', label: 'Hoofdaccount', attempt: 1, retried: true, outcome: 'rate_limited' } } },
        { kind: 'route_selected', turn_id: 't1', request_id: 'r1-r2', data: { target_id: 'werk', label: 'Werk', kind: 'claude-account', capability: 'full', reason: 'switch-limit', attempt: 2 } },
        { kind: 'route_switched', turn_id: 't1', request_id: 'r1-r2', data: { target_id: 'werk', label: 'Werk', kind: 'claude-account', capability: 'full', reason: 'switch-limit', switched: true, from_label: 'Hoofdaccount', attempt: 2 } },
      ],
    });
    // Pending: the user turn plus exactly one live message; the failed attempt is NOT a reply of its own.
    expect(detail.messages.map((m) => m.id)).toEqual(['t1', 't1-live']);
    const live = detail.messages[1];
    expect(readChatMessageRoute(live)).toMatchObject({ targetId: 'werk', switched: true, attempt: 2 });
    expect(readChatMessageRouteTurn(live)?.failedAttempt?.route.label).toBe('Hoofdaccount');
    const { container } = show(live, { position: 2, total: 2 });
    expect(container.querySelectorAll('article')).toHaveLength(1);
    expect(screen.getByText('Onderbroken antwoord van Hoofdaccount (limiet)')).toBeInTheDocument();
    // An attempt that had no text yet says so instead of opening onto nothing.
    expect(container.querySelector('details.fw-route-folded')).toHaveTextContent('Dit antwoord had nog geen tekst.');
    expect(screen.getByRole('note', { name: 'Melding over wisselen' })).toHaveTextContent('Overgeschakeld naar Werk');
  });

  it('a legacy retried assistant record is folded the same way (one message per turn, no duplicate id)', () => {
    const detail = detailOf({
      turns: [
        { type: 'turn', turn_id: 't1', role: 'user', text: 'hoi' },
        { type: 'turn', turn_id: 't1', role: 'assistant', text: 'half', route: { target_id: 'main', label: 'Hoofdaccount', retried: true, outcome: 'rate_limited', attempt: 1 } },
        { type: 'turn', turn_id: 't1', role: 'assistant', text: 'heel', route: { target_id: 'werk', label: 'Werk', switched: true, reason: 'switch-limit', attempt: 2, outcome: 'ok' } },
      ],
      events: [],
    });
    expect(detail.messages.map((m) => m.id)).toEqual(['t1', 't1']);
    expect(readChatMessageRouteTurn(detail.messages[1])?.failedAttempt?.text).toBe('half');
  });
});

/* ------------------------------------------------------------------ LOW: failover tried */

describe('LOW: Forge tried to fail over but nothing was left', () => {
  const failedOver = {
    turns: [
      { type: 'turn', turn_id: 't1', request_id: 'r1', role: 'user', text: 'hoi' },
      {
        type: 'turn',
        turn_id: 't1',
        request_id: 'r1',
        role: 'assistant',
        text: '',
        error: 'not signed in',
        route: { target_id: 'werk', kind: 'claude-account', label: 'Werk', capability: 'full', reason: 'sticky', switched: false, attempt: 1, retried: false, outcome: 'logged_out' },
      },
    ],
    events: [
      { kind: 'route_exhausted', turn_id: 't1', request_id: 'r1-r2', data: { resume_at: '2026-11-02T16:40:00.000Z', first_free: { target_id: 'main', label: 'Hoofdaccount' }, code: 'rate_limited' } },
      { kind: 'execution_not_started', turn_id: 't1', request_id: 'r1-r2', data: { reason: 'router_exhausted', attempt: 2 } },
    ],
  };

  it('says Forge tried, never "did not retry by itself", and offers no continue button', () => {
    const detail = detailOf(failedOver);
    // The exhausted information joins the turn's own notice; no second notice message.
    expect(detail.messages.map((m) => m.id)).toEqual(['t1', 't1']);
    expect(readChatMessageRouteTurn(detail.messages[1])).toMatchObject({ failoverTried: true, exhausted: { code: 'rate_limited' } });
    show(detail.messages[1], { position: 2, total: 2, chat: CHAT });
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    expect(notice).toHaveTextContent('Werk is niet ingelogd. Log opnieuw in via de router-instellingen.');
    expect(notice).toHaveTextContent('Forge probeerde over te stappen, maar er was niets meer vrij.');
    expect(notice).toHaveTextContent(/Als eerste weer vrij: Hoofdaccount om \d\d:\d\d\./);
    expect(notice).not.toHaveTextContent('niet vanzelf opnieuw geprobeerd');
    expect(screen.queryByRole('button', { name: /Ga verder/ })).toBeNull();
  });

  it('without a failover attempt the "not retried" line stays (files were already touched)', () => {
    const copy = routeNoticeCopy(
      route({ kind: 'claude-account', label: 'Hoofdaccount', target_id: 'main', capability: 'full', switched: false, reason: 'sticky', attempt: 1, outcome: 'rate_limited' }),
      ctx,
    );
    expect(copy?.variant).toBe('not-retried');
    expect(words(copy)[0]).toContain('Forge heeft het niet vanzelf opnieuw geprobeerd');
  });
});

/* ------------------------------------------------------------------ render rule */

describe('render rule: switched OR (reason first AND capability not full)', () => {
  it('mode "Meteen eigen model": the first turn says which model it runs on', () => {
    const r = route({ switched: false, reason: 'first', attempt: 1, outcome: 'ok', from_target_id: null, from_label: null, handover: null });
    expect(words(routeNoticeCopy(r, ctx))).toEqual(['Dit gesprek loopt op Ollama · llama3.1: dat kan alleen antwoorden.']);
  });

  it('a first turn on a full Claude account has no notice; neither does a sticky own-model turn', () => {
    expect(routeNoticeCopy(route({ kind: 'claude-account', label: 'Hoofdaccount', capability: 'full', switched: false, reason: 'first', attempt: 1, outcome: 'ok' }), ctx)).toBeNull();
    expect(routeNoticeCopy(route({ switched: false, reason: 'sticky', attempt: 1, outcome: 'ok' }), ctx)).toBeNull();
  });

  it('first turn on an own model that is not running: the model line plus the failure line', () => {
    const r = route({ switched: false, reason: 'first', attempt: 1, outcome: 'down', from_target_id: null, from_label: null, handover: null });
    const copy = routeNoticeCopy(r, ctx, { failoverTried: true, exhausted: exhausted('ollama_down') });
    expect(copy?.variant).toBe('failed');
    expect(words(copy)).toEqual([
      'Ollama draait niet op deze computer. Start Ollama of kies een ander model.',
      'Dit gesprek loopt op Ollama · llama3.1: dat kan alleen antwoorden.',
      'Forge probeerde over te stappen, maar er was niets meer vrij.',
      'Je eigen model kan nu niet antwoorden: Ollama draait niet op deze computer.',
      'Start Ollama en stuur je bericht daarna opnieuw. Of kies in de router-instellingen een ander model.',
    ]);
  });
});
