/**
 * App router in the chat (APP-ROUTER-DESIGN.md §5.1, §6.2 chat, §7.3; part P4): every notice variant, the
 * "via …" badge, the folded failed attempt, the continue button sending its text through the real send
 * path, the exhausted notice with its settings link, and aria-live. Rendered through the real `Message`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import conversationRouted from '../fixtures/app-router/conversation-routed.json';

import { setLocale, translate } from '@/i18n';
import type { MessageKey, MessageVars } from '@/i18n';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseConversationDetail } from '@/prototype/state/gateway-chat/live-activity';
import { parseChatRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import type { ChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { Message } from '@/views/chat/Message';
import { exhaustedCopy, routeBadge, routeNoticeCopy } from '@/views/chat/route-notice/route-copy';

const ctx = { t: (key: MessageKey, vars?: MessageVars) => translate('nl', key, vars), locale: 'nl' };

function route(overrides: Record<string, unknown>): ChatMessageRoute {
  const parsed = parseChatRoute({
    target_id: 'werk',
    kind: 'claude-account',
    label: 'Werk',
    capability: 'full',
    reason: 'switch-limit',
    switched: true,
    from_target_id: 'main',
    from_label: 'Hoofdaccount',
    from_window: 'five_hour',
    from_pct: null,
    from_resume_at: null,
    attempt: 2,
    retried: false,
    outcome: 'ok',
    handover: null,
    ...overrides,
  });
  if (!parsed) throw new Error('route did not parse');
  return parsed;
}

function words(r: ChatMessageRoute): string[] {
  const copy = routeNoticeCopy(r, ctx);
  if (!copy) return [];
  return [copy.title, ...copy.lines].filter((line) => line !== null).map((line) => ctx.t(line[0], line[1]));
}

describe('route-copy: every notice variant (§5.1)', () => {
  it('limit during the turn, retried', () => {
    expect(words(route({}))).toEqual([
      'Overgeschakeld naar Werk',
      'Hoofdaccount had zijn limiet bereikt (weer vrij om onbekend). Je bericht is opnieuw verstuurd.',
    ]);
  });

  it('proactive, with and without a percentage (a missing one is never 0)', () => {
    expect(words(route({ reason: 'switch-threshold', attempt: 1, from_pct: 93 }))[1]).toBe('Hoofdaccount zat op 93% van de 5-uurslimiet.');
    expect(words(route({ reason: 'switch-threshold', attempt: 1, from_window: 'seven_day' }))[1]).toBe('Hoofdaccount zat dicht bij de weeklimiet.');
  });

  it('to an own model says what it cannot do', () => {
    const lines = words(route({ target_id: 'ollama', kind: 'provider-model', label: 'Ollama · llama3.1', capability: 'answers-only' }));
    expect(lines).toContain('Alle Claude-accounts zitten aan hun limiet (eerste weer vrij om onbekend).');
    expect(lines).toContain('Dit model kan alleen antwoorden: geen bestanden bewerken of opdrachten uitvoeren.');
  });

  it('back to an own model says the model works again, not that a limit is free, and keeps its capability line', () => {
    const lines = words(route({ reason: 'return', target_id: 'ollama', kind: 'provider-model', label: 'Ollama · llama3.1', capability: 'answers-only' }));
    expect(lines).toEqual(['Terug naar Ollama · llama3.1', 'Dat model werkt weer.', 'Dit model kan alleen antwoorden: geen bestanden bewerken of opdrachten uitvoeren.']);
    expect(lines).not.toContain('De limiet is weer vrij.');
  });

  it('back, login lost, down, handover line', () => {
    expect(words(route({ reason: 'return', label: 'Hoofdaccount' }))).toEqual(['Terug naar Hoofdaccount', 'De limiet is weer vrij.']);
    expect(words(route({ reason: 'switch-login' }))[1]).toBe('Hoofdaccount is niet (meer) ingelogd.');
    expect(words(route({ reason: 'switch-down' }))[1]).toBe('Hoofdaccount reageerde niet.');
    expect(words(route({ handover: { turns: 10, chars: 8123, truncated: false } })).at(-1)).toBe(
      'Werk kreeg de laatste 10 berichten mee; eerdere details van dit gesprek kent het niet.',
    );
  });

  it('not retried offers to continue; first turn on a model; a plain sticky turn has no notice', () => {
    const notRetried = routeNoticeCopy(route({ switched: false, reason: 'sticky', attempt: 1, outcome: 'rate_limited' }), ctx);
    expect(notRetried?.offerContinue).toBe(true);
    expect(words(route({ switched: false, reason: 'first', kind: 'provider-model', label: 'Ollama · llama3.1', capability: 'answers-only', attempt: 1 }))).toEqual([
      'Dit gesprek loopt op Ollama · llama3.1: dat kan alleen antwoorden.',
    ]);
    expect(routeNoticeCopy(route({ switched: false, reason: 'sticky', attempt: 1 }), ctx)).toBeNull();
  });

  it('exhausted: first free label and time, or "onbekend"', () => {
    const known = exhaustedCopy({ resumeAt: null, firstFreeLabel: 'Werk', firstFreeAt: '2026-11-02T16:40:00.000Z', code: 'rate_limited' }, ctx);
    expect(known.failure).not.toBeNull();
    expect(ctx.t(known.failure![0], known.failure![1])).toMatch(/^Alle accounts in je router hebben hun limiet bereikt\. Als eerste weer vrij: Werk om \d\d:\d\d\.$/);
    const unknown = exhaustedCopy({ resumeAt: null, firstFreeLabel: null, firstFreeAt: null, code: 'rate_limited' }, ctx);
    expect(unknown.lines).toEqual([]);
    expect(ctx.t(unknown.failure![0])).toBe('Alle accounts in je router hebben hun limiet bereikt. Als eerste weer vrij: onbekend.');
  });

  it('badge: an own model always carries its capability', () => {
    const [key, vars] = routeBadge(route({ label: 'Ollama · llama3.1', capability: 'answers-only' }));
    expect(ctx.t(key, vars)).toBe('via Ollama · llama3.1 (alleen antwoorden)');
  });
});

/* ------------------------------------------------------------------ rendered */

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
    activeConversationId: 'c-router',
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

function controller(send: ChatSendController['send']): ChatSendController {
  return {
    run: { runId: null, status: null, active: false },
    canSend: true,
    disabledReason: null,
    sending: false,
    stopping: false,
    send,
    stop: async () => ({ ok: true, error: null }),
  };
}

function show(message: ChatMessage, { position = 1, total = 1, chat = null as ChatSendController | null } = {}) {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  let tree: ReactElement = createElement(PrototypeContext.Provider, { value }, createElement(Message, { message, position, total }));
  if (chat) tree = createElement(ChatSendContext.Provider, { value: chat }, tree);
  return render(tree);
}

const messages = parseConversationDetail('c-router', conversationRouted as Record<string, unknown>).messages;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  setLocale('nl');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/app-router/status')
        ? { ok: true, next: { kind: 'target', entry: { id: 'werk', label: 'Werk' }, reason: 'switch-limit', switched: true } }
        : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

describe('Message with a route (rendered)', () => {
  it('a switched answer shows the polite notice above it and the badge', () => {
    show(messages[3]);
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveTextContent('Overgeschakeld naar Werk');
    expect(notice).toHaveTextContent('Je bericht is opnieuw verstuurd.');
    expect(notice).toHaveTextContent('Werk kreeg de laatste 3 berichten mee');
    expect(screen.getByText('via Werk')).toBeInTheDocument();
    expect(screen.getByText(/De knop op de startpagina is nu groter/)).toBeInTheDocument();
  });

  it('an own-model answer after a switch: the notice names the model and its limits, the badge only the provider', () => {
    const { container } = show(messages[5]);
    // Final review finding 3: the notice right above already says "Ollama · llama3.1" and "alleen antwoorden",
    // so the badge does not repeat them (DESIGN.md §3.2); the honesty words stay in the notice.
    expect(container.querySelector('.fw-route-badge')?.textContent).toBe('via Ollama');
    expect(container.querySelector('.fw-route-badge')?.getAttribute('title')).toContain('Ollama · llama3.1 (alleen antwoorden)');
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    expect(notice).toHaveTextContent('Ollama · llama3.1');
    expect(notice).toHaveTextContent('alleen antwoorden');
    expect(screen.getByText('Dit model kan alleen antwoorden: geen bestanden bewerken of opdrachten uitvoeren.')).toBeInTheDocument();
  });

  it('an own-model answer without a notice keeps the full badge with its capability words', () => {
    const sticky = parseConversationDetail('c', {
      turns: [{ type: 'turn', turn_id: 't1', role: 'assistant', text: 'Hoi', route: { target_id: 'ollama', kind: 'provider-model', label: 'Ollama · llama3.1', capability: 'answers-only', reason: 'sticky', switched: false, attempt: 1, retried: false, outcome: 'ok' } }],
      events: [],
    }).messages[0];
    const { container } = show(sticky);
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.querySelector('.fw-route-badge')?.textContent).toBe('via Ollama · llama3.1 (alleen antwoorden)');
  });

  it('the reply header puts the badge right after the name and the hover time after the spacer', () => {
    // Final review finding 2: the hidden time (opacity 0) kept its width between "Forge" and "via …".
    const { container } = show(messages[3]);
    const head = container.querySelector('.fw-chat-msg__head') as HTMLElement;
    const kids = Array.from(head.children);
    const at = (selector: string) => kids.findIndex((el) => el.matches(selector));
    expect(at('.fw-route-badge')).toBe(at('.fw-chat-msg__who') + 1);
    expect(at('.fw-chat-msg__time')).toBeGreaterThan(at('.fw-spacer'));
    expect(at('.fw-chat-msg__time')).toBeLessThan(at('.fw-chat-msg__actions'));
  });

  it('the failed first attempt is folded under its reason, not hidden', () => {
    const { container } = show(messages[3]);
    expect(screen.getByText('Onderbroken antwoord van Hoofdaccount (limiet)')).toBeInTheDocument();
    const details = container.querySelector('details.fw-route-folded') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent('Ik begin met de knop op de');
  });

  it('a sticky first answer has only the badge', () => {
    show(messages[1]);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('via Hoofdaccount')).toBeInTheDocument();
  });

  it('not retried: "Ga verder op Werk" sends the continue text through the real send path', async () => {
    const send = vi.fn(async () => ({ ok: true, error: null }));
    const notRetried = parseConversationDetail('c', {
      turns: [{ type: 'turn', turn_id: 't9', role: 'assistant', text: 'Half', route: { target_id: 'main', label: 'Hoofdaccount', reason: 'sticky', switched: false, attempt: 1, retried: false, outcome: 'rate_limited' } }],
      events: [],
    }).messages[0];
    show(notRetried, { chat: controller(send) });
    await settle();
    expect(screen.getByText(/Hoofdaccount bereikte zijn limiet halverwege/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ga verder op Werk' }));
    await settle();
    expect(send).toHaveBeenCalledWith('Ga verder waar je gebleven was.');
  });

  it('without a live send path there is no continue button (never a dead one)', () => {
    const notRetried = parseConversationDetail('c', {
      turns: [{ type: 'turn', turn_id: 't9', role: 'assistant', text: 'Half', route: { target_id: 'main', label: 'Hoofdaccount', switched: false, attempt: 1, outcome: 'rate_limited' } }],
      events: [],
    }).messages[0];
    show(notRetried);
    expect(screen.queryByRole('button', { name: /Ga verder/ })).toBeNull();
  });

  it('the exhausted notice says who is free first and links to the router settings', () => {
    const detail = parseConversationDetail('c', {
      turns: [{ type: 'turn', turn_id: 't1', role: 'user', text: 'hoi' }],
      events: [{ kind: 'route_exhausted', turn_id: 't1', data: { resume_at: null, first_free: null, code: 'rate_limited' } }],
    });
    show(detail.messages[1]);
    expect(screen.getByText('Alle accounts in je router hebben hun limiet bereikt. Als eerste weer vrij: onbekend.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Router-instellingen' })).toHaveAttribute('href', '#/settings?focus=router');
  });
});
