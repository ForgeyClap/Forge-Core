/**
 * Q7-CHAT — the skip reason also reaches the chat on a NOT-STARTED path, and its copy is true for every cause.
 *
 * The gateway (command-center 50c37eb) writes `data.skipped` on `execution_not_started` too: attempt 2 (the
 * failover found an own API it had to walk past, then could not start) and attempt 1 (code 'not_started').
 * The dashboard reads it (missing => []), merges it with the route_selected / route_switched / route_exhausted
 * lists (each step once) and shows it with the existing RouteSkipLine.
 *
 * provider_unavailable covers an own API that was deleted, switched off OR refused (gateway chain-schema.mjs),
 * so the line says "niet beschikbaar: verwijderd, uitgezet of geweigerd", not only "verwijderd of uitgezet".
 *
 * The paused status strip in the dock sits on the reply column (status.css), pinned here as a rule and in
 * real browser frames by tests/e2e/q7-chat-shots.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import notStarted from '../fixtures/app-router/conversation-not-started-skips.json';
import conversationExhausted from '../fixtures/app-router/conversation-exhausted-ollama-down.json';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import en from '@/i18n/locales/en.json';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseConversationDetail, readChatMessageRouteTurn } from '@/prototype/state/gateway-chat/live-activity';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { Message } from '@/views/chat/Message';

type Rec = Record<string, unknown>;

const NOTE = 'Overgeslagen stappen in je router';
const UNAVAILABLE_NL = 'Eigen API niet beschikbaar: verwijderd, uitgezet of geweigerd';
const UNAVAILABLE_EN = 'own API not available: removed, switched off or refused';

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

function forgeOf(detail: Rec, turnId: string): ChatMessage {
  const found = parseConversationDetail('c-not-started', detail).messages.filter((m) => m.author === 'forge' && m.id.startsWith(turnId));
  if (found.length !== 1) throw new Error(`expected one forge message for ${turnId}, got ${found.length}`);
  return found[0];
}

function withEvents(extra: readonly Rec[], drop: (event: Rec) => boolean = () => false): Rec {
  const base = notStarted as Rec & { events: Rec[] };
  return { ...base, events: [...extra, ...base.events.filter((event) => !drop(event))] };
}

describe('parsing: execution_not_started carries skipped', () => {
  it('attempt 2 not started: its skipped list folds onto the answer of attempt 1', () => {
    const turn = readChatMessageRouteTurn(forgeOf(notStarted as Rec, 't1'));
    expect(turn?.failoverTried).toBe(true);
    expect(turn?.skipped.map((skip) => [skip.targetId, skip.reason])).toEqual([
      ['mijn-vllm-qwen', 'provider_unavailable'],
      ['groq-eigen', 'paid_ack_required'],
    ]);
  });

  it('attempt 1 not started: the turn gets one notice message that carries the skip, and is not "still running"', () => {
    const messages = parseConversationDetail('c-not-started', notStarted as Rec).messages;
    const t2 = messages.filter((m) => m.id.startsWith('t2'));
    expect(t2.map((m) => m.author)).toEqual(['user', 'forge']);
    expect(readChatMessageRouteTurn(t2[1])?.skipped.map((skip) => skip.targetId)).toEqual(['mijn-vllm-qwen']);
  });

  it('dedupes with the other skip sources: a step named by route_selected and execution_not_started shows once', () => {
    const first = {
      kind: 'route_selected', turn_id: 't1', request_id: 'r1',
      data: { target_id: 'main', attempt: 1, skipped: [{ target_id: 'groq-eigen', label: 'Groq eigen · llama-3.3-70b', reason: 'paid_ack_required' }] },
    };
    const detail = withEvents([first], (event) => event.kind === 'route_selected');
    const turn = readChatMessageRouteTurn(forgeOf(detail, 't1'));
    expect(turn?.skipped.map((skip) => skip.targetId)).toEqual(['groq-eigen', 'mijn-vllm-qwen']);
  });

  it('missing or junk skipped on execution_not_started reads as [] (older gateway)', () => {
    const detail = withEvents([], (event) => event.kind === 'execution_not_started' && event.turn_id === 't1');
    const plain = withEvents([{ kind: 'execution_not_started', turn_id: 't1', request_id: 'r1-r2', data: { attempt: 2, skipped: 'nope' } }], (event) => event.kind === 'execution_not_started' && event.turn_id === 't1');
    expect(readChatMessageRouteTurn(forgeOf(detail, 't1'))?.skipped ?? []).toEqual([]);
    expect(readChatMessageRouteTurn(forgeOf(plain, 't1'))?.skipped).toEqual([]);
    // The exhausted fixture's execution_not_started has no skipped: still nothing.
    const exhausted = parseConversationDetail('c-x', conversationExhausted as Rec).messages.map(readChatMessageRouteTurn).filter((t) => t !== null);
    for (const turn of exhausted) expect(turn?.skipped).toEqual([]);
  });
});

describe('the chat shows the not-started skip line, with true copy', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('under the failed answer whose failover could not start', () => {
    show(forgeOf(notStarted as Rec, 't1'));
    const line = screen.getByRole('note', { name: NOTE });
    expect(line).toHaveTextContent(`Overgeslagen: Mijn vLLM · qwen2.5-coder (${UNAVAILABLE_NL}); Groq eigen · llama-3.3-70b (kosten nog niet bevestigd)`);
  });

  it('on its own for a turn that could not start at all (no empty Forge bubble)', () => {
    const { container } = show(forgeOf(notStarted as Rec, 't2'));
    expect(screen.getByRole('note', { name: NOTE })).toHaveTextContent(`Overgeslagen: Mijn vLLM · qwen2.5-coder (${UNAVAILABLE_NL})`);
    expect(container.querySelector('.fw-chat-msg__head')).toBeNull();
  });

  it('English follows the locale', () => {
    setLocale('en');
    show(forgeOf(notStarted as Rec, 't2'));
    expect(screen.getByText(`Skipped: Mijn vLLM · qwen2.5-coder (${UNAVAILABLE_EN})`)).toBeInTheDocument();
  });

  it('the copy names all three causes of provider_unavailable (deleted, switched off, refused)', () => {
    const nlRoute = (nl as { chat: { route: { skipped: { unavailable: string } } } }).chat.route.skipped.unavailable;
    const enRoute = (en as { chat: { route: { skipped: { unavailable: string } } } }).chat.route.skipped.unavailable;
    expect(nlRoute).toBe(`{label} (${UNAVAILABLE_NL})`);
    expect(enRoute).toBe(`{label} (${UNAVAILABLE_EN})`);
  });
});

describe('the paused strip sits on the reply column', () => {
  it('a status chip in the dock is capped at the column width, like the composer', () => {
    const css = readFileSync(resolve(__dirname, '../../src/views/chat/status/status.css'), 'utf8');
    const rule = /\.fw-chat__dock\s*>\s*\.fw-chat-status\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/max-inline-size:\s*var\(--fs-column\)/);
  });
});
