/**
 * Redesign fix round, part FX-A: Gesprek. Each test locks one review finding.
 *
 *   F2   The route badge never cuts its honesty suffix: the capability words sit in their own `flex: none`
 *        span outside the element that shortens with an ellipsis (CSS read + DOM shape).
 *   F8   The thread start of a real conversation no longer names an engine ("Claude Code") that the
 *        router may not be using.
 *   F11  In Eenvoudig a route notice is one line (icon, headline with the full capability suffix,
 *        "Meer info"); the rest opens in place. Uitgebreid keeps the full card.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { setUiMode } from '@/state/ui-mode';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseChatRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import type { ChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import { MessageList } from '@/views/chat/MessageList';
import { RouteBadge, RouteNotice } from '@/views/chat/route-notice/RouteNotice';

vi.mock('@/config/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/mode')>()),
  isProductionMode: () => true,
}));

const CSS_PATH = join(__dirname, '..', '..', 'src', 'views', 'chat', 'route-notice', 'route-notice.css');

function state(): PrototypeState {
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
  };
}

function withStore(element: ReturnType<typeof createElement>) {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  return render(createElement(PrototypeContext.Provider, { value }, element));
}

function route(overrides: Record<string, unknown>): ChatMessageRoute {
  const parsed = parseChatRoute({
    target_id: 'ollama-local',
    kind: 'provider-model',
    label: 'Ollama · qwen2.5-coder:32b',
    capability: 'answers-only',
    reason: 'switch-limit',
    switched: true,
    from_target_id: 'main',
    from_label: 'Hoofdaccount',
    from_window: 'five_hour',
    from_pct: null,
    from_resume_at: null,
    attempt: 1,
    retried: false,
    outcome: 'ok',
    handover: null,
    ...overrides,
  });
  if (!parsed) throw new Error('route did not parse');
  return parsed;
}

/** The declarations of one exact selector in the stylesheet (comments stripped). */
function block(css: string, selector: string): string | null {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const match = clean.match(re);
  return match ? match[2] : null;
}

beforeEach(() => {
  setLocale('nl');
  setUiMode('eenvoudig');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('F2: the badge keeps "(alleen antwoorden)" whole', () => {
  it('CSS: only the label shortens; the capability span is flex: none and never ellipsed', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const badge = block(css, '.fw-route-badge');
    const label = block(css, '.fw-route-badge__label');
    const cap = block(css, '.fw-route-badge__cap');
    expect(badge).not.toBeNull();
    expect(badge).not.toMatch(/text-overflow/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    expect(label).toMatch(/min-inline-size:\s*0|min-width:\s*0/);
    expect(cap).toMatch(/flex:\s*none/);
    expect(cap).not.toMatch(/text-overflow/);
    // No rule that shortens every child span (that would hit the suffix too).
    expect(block(css, '.fw-route-badge > span')).toBeNull();
  });

  it('DOM: the suffix is its own span, outside the shortening label', () => {
    const { container } = withStore(createElement(RouteBadge, { route: route({ switched: false, reason: 'sticky' }) }));
    const badge = container.querySelector('.fw-route-badge') as HTMLElement;
    const label = badge.querySelector('.fw-route-badge__label') as HTMLElement;
    const cap = badge.querySelector('.fw-route-badge__cap') as HTMLElement;
    expect(label.textContent).toBe('via Ollama · qwen2.5-coder:32b');
    expect(cap.textContent?.trim()).toBe('(alleen antwoorden)');
    expect(label.contains(cap)).toBe(false);
    expect(badge.textContent).toBe('via Ollama · qwen2.5-coder:32b (alleen antwoorden)');
  });

  it('a full account has no suffix span', () => {
    const { container } = withStore(createElement(RouteBadge, { route: route({ kind: 'claude-account', label: 'Werk', capability: 'full' }) }));
    expect(container.querySelector('.fw-route-badge__cap')).toBeNull();
    expect(container.querySelector('.fw-route-badge__label')?.textContent).toBe('via Werk');
  });
});

describe('F8: the thread start names no engine', () => {
  it('a real conversation does not say "Claude Code"', () => {
    const { container } = withStore(createElement(MessageList, { messages: [], streamingId: null, conversationTitle: 'Test' }));
    const start = container.querySelector('.fw-chat-thread__start') as HTMLElement;
    expect(start).not.toBeNull();
    expect(start.textContent).not.toMatch(/Claude/);
  });
});

describe('thread keys: a user turn and its answer share the gateway turn_id', () => {
  it('renders both without a duplicate React key', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { prototype: true as const, body: 'x', timestamp: '2026-11-02T14:40:00.000Z' };
    const messages = [
      { ...base, id: 't1', author: 'user' as const, body: 'Vraag' },
      { ...base, id: 't1', author: 'forge' as const, body: 'Antwoord' },
    ];
    const { container } = withStore(createElement(MessageList, { messages, streamingId: null, conversationTitle: 'Test' }));
    expect(container.querySelectorAll('.fw-chat-thread__item')).toHaveLength(2);
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });
});

describe('F11: one-line route notice in Eenvoudig', () => {
  it('shows one line with the full suffix and "Meer info"; the reason opens in place', () => {
    withStore(createElement(RouteNotice, { route: route({}), isLast: true }));
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    expect(notice).toHaveAttribute('data-layout', 'line');
    const headline = notice.querySelector('.fw-route-notice__headline') as HTMLElement;
    expect(headline.textContent).toContain('Overgeschakeld naar Ollama · qwen2.5-coder:32b');
    const cap = notice.querySelector('.fw-route-notice__cap') as HTMLElement;
    expect(cap.textContent?.trim()).toBe('(alleen antwoorden)');
    const more = screen.getByRole('button', { name: 'Meer info' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    const reason = screen.getByText(/Dit model kan alleen antwoorden/);
    expect(reason.closest('[hidden]')).not.toBeNull();
    fireEvent.click(more);
    expect(reason.closest('[hidden]')).toBeNull();
  });

  it('CSS: the one-line suffix never shrinks', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    expect(block(css, '.fw-route-notice__cap')).toMatch(/flex:\s*none/);
  });

  it('Uitgebreid keeps the full card (every line visible, no "Meer info")', () => {
    setUiMode('uitgebreid');
    withStore(createElement(RouteNotice, { route: route({}), isLast: true }));
    const notice = screen.getByRole('note', { name: 'Melding over wisselen' });
    expect(notice).toHaveAttribute('data-layout', 'card');
    expect(screen.queryByRole('button', { name: 'Meer info' })).toBeNull();
    expect(screen.getByText(/Dit model kan alleen antwoorden/).closest('[hidden]')).toBeNull();
  });
});
