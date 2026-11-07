/**
 * Q6-UI task 2 — the conversation says which router steps were skipped for a reply, and why (contract C1).
 *
 * The gateway writes `data.skipped` ({target_id, label, provider, reason}) on route_selected / route_switched,
 * and on route_exhausted when the chain ran out after skips. The dashboard folds every attempt's list onto
 * that turn's answer (each step once) and shows ONE calm line: "Overgeslagen: <label> (<why>)".
 * Missing `skipped` (an older gateway, the stored turn record) reads as [] and shows nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import conversationRouted from '../fixtures/app-router/conversation-routed.json';
import conversationExhausted from '../fixtures/app-router/conversation-exhausted-ollama-down.json';

import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseConversationDetail, readChatMessageRouteExhausted, readChatMessageRouteTurn } from '@/prototype/state/gateway-chat/live-activity';
import { parseChatRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import { mergeRouteSkips, parseRouteSkips } from '@/prototype/state/gateway-chat/route-skips';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { Message } from '@/views/chat/Message';

type Rec = Record<string, unknown>;

const GONE = { target_id: 'mijn-vllm', label: 'Mijn vLLM', provider: 'custom-mijn-vllm', reason: 'provider_unavailable' };
const UNPAID = { target_id: 'groq-eigen', label: 'Groq eigen', provider: 'custom-groq', reason: 'paid_ack_required' };

// No em dash in Dutch copy (nl-copy-punctuation.test.ts): the reason sits in parentheses.
const LINE_NL = 'Overgeslagen: Mijn vLLM (Eigen API niet beschikbaar: verwijderd, uitgezet of geweigerd)';
const LINE_BOTH_NL = 'Overgeslagen: Mijn vLLM (Eigen API niet beschikbaar: verwijderd, uitgezet of geweigerd); Groq eigen (kosten nog niet bevestigd)';

/** conversation-routed.json with `skipped` written onto the events of one turn (the fixtures say []). */
function withSkips(turnId: string, byRequest: Record<string, readonly unknown[]>): Rec {
  const base = conversationRouted as Rec & { events: Rec[] };
  return {
    ...base,
    events: base.events.map((event) => {
      const requestId = String(event.request_id);
      if (event.turn_id !== turnId || !(requestId in byRequest) || event.kind !== 'route_selected') return event;
      return { ...event, data: { ...(event.data as Rec), skipped: byRequest[requestId] } };
    }),
  };
}

function answerOf(detail: Rec, turnId: string): ChatMessage {
  const message = parseConversationDetail('c-router', detail).messages.find((item) => item.id === turnId && item.author === 'forge');
  if (!message) throw new Error(`no answer for ${turnId}`);
  return message;
}

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

function show(message: ChatMessage) {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(Message, { message, position: 1, total: 1 })));
}

describe('parsing data.skipped', () => {
  it('missing or not an array reads as []; junk items are dropped; an unknown reason keeps the step', () => {
    expect(parseRouteSkips(null)).toEqual([]);
    expect(parseRouteSkips({})).toEqual([]);
    expect(parseRouteSkips({ skipped: 'x' })).toEqual([]);
    expect(parseRouteSkips({ skipped: [GONE, null, 'junk', { label: 'no id' }, { target_id: 'z', reason: 'new_reason' }] })).toEqual([
      { targetId: 'mijn-vllm', label: 'Mijn vLLM', provider: 'custom-mijn-vllm', reason: 'provider_unavailable' },
      { targetId: 'z', label: 'z', provider: null, reason: 'unknown' },
    ]);
  });

  it('a route record (a live route event) carries its skipped list; the stored turn record has none', () => {
    expect(parseChatRoute({ target_id: 'main', label: 'Hoofdaccount', skipped: [UNPAID] })?.skipped).toEqual([
      { targetId: 'groq-eigen', label: 'Groq eigen', provider: 'custom-groq', reason: 'paid_ack_required' },
    ]);
    expect(parseChatRoute({ target_id: 'main' })?.skipped).toEqual([]);
  });

  it('several attempts merge into one list, each step once, in the order met', () => {
    const a = parseRouteSkips({ skipped: [GONE] });
    const b = parseRouteSkips({ skipped: [GONE, UNPAID] });
    expect(mergeRouteSkips([a, b]).map((skip) => skip.targetId)).toEqual(['mijn-vllm', 'groq-eigen']);
  });

  it('the fixtures mirror the contract: every route_selected says skipped: [] and nothing shows', () => {
    const events = (conversationRouted as { events: Rec[] }).events.filter((event) => event.kind === 'route_selected');
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect((event.data as Rec).skipped).toEqual([]);
    expect(readChatMessageRouteTurn(answerOf(conversationRouted as Rec, 't3'))).toBeNull();
  });

  it('both attempts of a failover turn fold onto its one answer', () => {
    const turn = readChatMessageRouteTurn(answerOf(withSkips('t2', { r2: [GONE], 'r2-r2': [GONE, UNPAID] }), 't2'));
    expect(turn?.skipped.map((skip) => skip.targetId)).toEqual(['mijn-vllm', 'groq-eigen']);
  });

  it('chain exhausted after a skip: route_exhausted carries it to the notice', () => {
    const base = conversationExhausted as Rec & { events: Rec[] };
    const detail = {
      ...base,
      events: base.events.map((event) => (event.kind === 'route_exhausted' ? { ...event, data: { ...(event.data as Rec), skipped: [GONE] } } : event)),
    };
    const notice = parseConversationDetail('c-exhausted-ollama', detail).messages.map(readChatMessageRouteExhausted).find((item) => item !== null);
    expect(notice?.skipped?.map((skip) => skip.reason)).toEqual(['provider_unavailable']);
  });
});

describe('the reply shows one calm skip line', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('a plain first-choice reply (no route notice) still says which step was skipped', () => {
    show(answerOf(withSkips('t3', { r3: [GONE] }), 't3'));
    const line = screen.getByRole('note', { name: 'Overgeslagen stappen in je router' });
    expect(line).toHaveTextContent(LINE_NL);
    expect(line).toHaveClass('fw-route-skip');
  });

  it('two reasons on one line, under the switch notice', () => {
    show(answerOf(withSkips('t2', { 'r2-r2': [GONE, UNPAID] }), 't2'));
    expect(screen.getByText(LINE_BOTH_NL)).toBeInTheDocument();
    expect(screen.getAllByRole('note', { name: 'Overgeslagen stappen in je router' })).toHaveLength(1);
  });

  it('nothing skipped: no skip line', () => {
    show(answerOf(conversationRouted as Rec, 't2'));
    expect(screen.queryByRole('note', { name: 'Overgeslagen stappen in je router' })).toBeNull();
  });

  it('the exhausted notice carries the line too, and English follows the locale', () => {
    setLocale('en');
    const base = conversationExhausted as Rec & { events: Rec[] };
    const detail = {
      ...base,
      events: base.events.map((event) => (event.kind === 'route_exhausted' ? { ...event, data: { ...(event.data as Rec), skipped: [UNPAID] } } : event)),
    };
    const notice = parseConversationDetail('c-exhausted-ollama', detail).messages.find((item) => readChatMessageRouteExhausted(item) !== null);
    if (!notice) throw new Error('no exhausted notice');
    show(notice);
    expect(screen.getByText('Skipped: Groq eigen (costs not confirmed yet)')).toBeInTheDocument();
  });
});
