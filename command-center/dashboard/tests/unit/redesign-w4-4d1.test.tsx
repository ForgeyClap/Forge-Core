/**
 * Redesign, part 4D-1 (UI Boss): the axe WCAG findings of the XR gate on Gesprek, Instellingen › Uitgebreid
 * and Mijn projecten, plus the English-only question box (X1).
 *   1. aria-required-attr: a limit value that is not known is plain text, never a `meter` without a value.
 *   2. listitem / aria-allowed-role: the thread keeps its list semantics; `role="log"` sits on a wrapper.
 *   3. scrollable-region-focusable: a code block can take keyboard focus and has a name.
 *   4. landmark-unique: a route notice is a note inside the conversation, not a repeated landmark.
 *   5. label-content-name-mismatch: a project row's name is its visible text (no aria-label replacing it, and the
 *      decorative letter tile adds no text node).
 *   6. X1: the question box speaks Dutch in nl and keeps its English in en.
 * The browser proof (axe on the real app, light and dark) lives in _scratch/redesign/w4/4D-1/axe.mjs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import conversationRouted from '../fixtures/app-router/conversation-routed.json';

import { setLocale, translate } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseConversationDetail } from '@/prototype/state/gateway-chat/live-activity';
import type { PendingAsk } from '@/prototype/state/gateway-chat/ask-questions';
import type { ChatMessage, Project } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';
import { AskQuestionsDialog } from '@/views/chat/AskQuestionsDialog';
import { Message } from '@/views/chat/Message';
import { MessageList } from '@/views/chat/MessageList';
import { renderMarkdown } from '@/views/chat/markdown';
import ProjectsView from '@/views/projects/ProjectsView';
import { LimitRow } from '@/views/settings/sections/AdvancedRows';

const nl = (key: string, vars?: Record<string, string | number>) => translate('nl', key as MessageKey, vars);

function state(overrides: Partial<PrototypeState> = {}): PrototypeState {
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
    ...overrides,
  } as PrototypeState;
}

function withStore(child: ReactElement, s: PrototypeState = state()) {
  const value: StoreValue = { state: s, dispatch: vi.fn() };
  return createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, child));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function stubFetch(usageGuard: Record<string, unknown> | null = null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/usage') && usageGuard ? { ok: true, provenance: 'guard', guard: { available: true, mode: 'ok', ...usageGuard } } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeEach(() => {
  setLocale('nl');
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

/* ------------------------------------------------------- 1 limit meters */

describe('1 Instellingen › Limiet: no meter without a value', () => {
  it('unknown values are plain text, never role="meter"', async () => {
    const { container } = render(createElement(LimitRow));
    await settle();
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    const five = container.querySelector('[data-meter="five"]') as HTMLElement;
    expect(within(five).getByText(nl('settingsPage.rows.limiet.unknown'))).toBeInTheDocument();
  });

  it('a known value is a meter with now, min and max; the unknown one next to it is not', async () => {
    stubFetch({ watcher: 'running', session_pct: 34, week_pct: null, session_reset_at: inHours(2) });
    render(createElement(LimitRow));
    await settle();
    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(1);
    expect(meters[0]).toHaveAccessibleName(nl('settingsPage.rows.limiet.five'));
    expect(meters[0]).toHaveAttribute('aria-valuenow', '34');
    expect(meters[0]).toHaveAttribute('aria-valuemin', '0');
    expect(meters[0]).toHaveAttribute('aria-valuemax', '100');
  });

  it('both known: two meters, every one with a value', async () => {
    stubFetch({ watcher: 'running', session_pct: 34, week_pct: 61, session_reset_at: inHours(2) });
    render(createElement(LimitRow));
    await settle();
    const meters = screen.getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['34', '61']);
  });
});

/* ------------------------------------------------------- 2 thread list */

const routedMessages = parseConversationDetail('c-router', conversationRouted as Record<string, unknown>).messages;

describe('2 Gesprek: the thread keeps list semantics inside the log', () => {
  it('role="log" is not on the list; every list item sits in a real list', () => {
    const { container } = render(withStore(createElement(MessageList, { messages: routedMessages, streamingId: null, conversationTitle: 'Proef' })));
    const log = screen.getByRole('log', { name: nl('chat.thread.label', { title: 'Proef' }) });
    expect(log.tagName).not.toBe('OL');
    expect(log.tagName).not.toBe('UL');
    expect(log).toHaveAttribute('aria-live', 'polite');
    const list = within(log).getByRole('list');
    expect(list.tagName).toBe('OL');
    const items = container.querySelectorAll('li');
    expect(items.length).toBeGreaterThan(1);
    for (const li of items) expect(['OL', 'UL']).toContain(li.parentElement?.tagName);
    for (const li of items) expect(li.parentElement?.getAttribute('role') ?? null).toBeNull();
  });

  it('arrow keys still move between turns inside the log', () => {
    render(withStore(createElement(MessageList, { messages: routedMessages, streamingId: null, conversationTitle: 'Proef' })));
    const turns = document.querySelectorAll<HTMLElement>('[data-chat-message]');
    expect(turns.length).toBeGreaterThan(1);
    turns[0].focus();
    fireEvent.keyDown(turns[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(turns[1]);
  });
});

/* ------------------------------------------------------- 3 code block */

describe('3 a code block can take keyboard focus and has a name', () => {
  it('the scrolling <pre> has tabIndex 0 and the Dutch code-block name', () => {
    const { container } = render(createElement('div', null, renderMarkdown('```bash\nnpm run build\n```')));
    const pre = container.querySelector('pre') as HTMLElement;
    expect(pre).toHaveAttribute('tabindex', '0');
    expect(pre).toHaveAccessibleName(nl('chat.message.codeBlock', { lang: 'bash' }));
    // A name on a <pre> needs a role that allows one; group is not a landmark, so it never repeats a landmark.
    expect(pre).toHaveAttribute('role', 'group');
  });

  it('the copy button speaks Dutch too', () => {
    render(createElement('div', null, renderMarkdown('```bash\nnpm run build\n```')));
    expect(screen.queryByRole('button', { name: /Copy the/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Code kopiëren (bash)' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------- 4 route notice */

describe('4 Gesprek: a route notice is not a landmark', () => {
  it('a switched answer shows its notice as a note, so two of them never repeat a landmark name', () => {
    render(withStore(createElement(Message, { message: routedMessages[3] as ChatMessage, position: 1, total: 1 })));
    expect(screen.queryByRole('complementary')).toBeNull();
    const notice = screen.getByRole('note', { name: nl('chat.route.noticeLabel') });
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveTextContent('Overgeschakeld naar Werk');
  });
});

/* ------------------------------------------------------- 5 project rows */

const PROJECT = {
  ...(EMPTY_DATASET.projects[0] ?? {}),
  id: 'bakkerij',
  name: 'bakkerij',
  description: 'Website voor de bakker',
  type: 'website',
  status: 'idle',
  lastActivity: '4 min ago',
  path: 'C:\\Users\\iemand\\Documents\\bakkerij',
  templateVersion: '',
  pinned: false,
  conversationCount: 2,
  missionCount: 1,
  taskCount: null,
  agentCount: 3,
  skills: [],
  health: { score: null },
} as unknown as Project;

/** Mirrors axe's label-content-name-mismatch: the visible words must appear, in order, inside the name. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}
function visibleText(el: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('.fw-visually-hidden')) continue;
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ');
}
function contiguous(hay: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i += 1) if (needle.every((w, j) => hay[i + j] === w)) return true;
  return false;
}

describe('5 Mijn projecten: a row is named by what it shows', () => {
  function renderProjects(projects: readonly Project[], pinned: readonly string[] = []) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response));
    const s = state({ data: { ...EMPTY_DATASET, projects }, activeProjectId: 'bakkerij', activeConversationId: '', pinnedProjectIds: pinned });
    return render(withStore(createElement(ProjectsView), s));
  }

  it('no aria-label replaces the visible text; the name starts with the project name and holds the description', async () => {
    const { container } = renderProjects([PROJECT]);
    await settle();
    const button = container.querySelector('.fw-projects__open') as HTMLButtonElement;
    expect(button).not.toHaveAttribute('aria-label');
    expect(button).toHaveAccessibleName(/^bakkerij Website voor de bakker/);
    expect(contiguous(tokens(computedName(button)), tokens(visibleText(button)))).toBe(true);
  });

  it('the decorative letter tile adds no text node to the button', async () => {
    const { container } = renderProjects([PROJECT]);
    await settle();
    const tile = container.querySelector('.fw-projects__open .fw-xtile') as HTMLElement;
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile.textContent).toBe('');
    expect(tile).toHaveAttribute('data-letter', 'B');
  });

  it('a pinned row: the visible words stay one run inside the name, "Vastgepind" comes after them', async () => {
    const { container } = renderProjects([{ ...PROJECT, pinned: true } as Project]);
    await settle();
    const button = container.querySelector('.fw-projects__open') as HTMLButtonElement;
    const name = computedName(button);
    expect(name).toMatch(/Vastgepind$/);
    expect(contiguous(tokens(name), tokens(visibleText(button)))).toBe(true);
  });
});

function computedName(el: HTMLElement): string {
  // The accessible name from content: text nodes outside aria-hidden subtrees (what jsdom + dom-testing-library use).
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------- 6 question box */

const ASK: PendingAsk = {
  id: 'ask-nl-1',
  questions: [
    { header: 'Kleur', question: 'Welke kleur past bij de salon?', options: ['Warm eiken', 'Zand'], multiSelect: false, recommended: 'Warm eiken' },
    { header: null, question: 'Welke pagina’s wil je?', options: ['Prijzen', 'Team'], multiSelect: true, recommended: null },
  ],
};

const ENGLISH = [
  'Forge is asking', 'Review your answers', 'Select all that apply', 'Previous', 'Back', 'Send answers', 'Dismiss',
  'Question 1', 'Recommended', 'Something else', 'Skip', 'No preference', 'running Claude Code session', 'gateway',
];
function englishIn(root: Element): string[] {
  const text = [root.textContent ?? '', ...[...root.querySelectorAll('[placeholder],[aria-label]')].map((el) => `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`)].join(' ');
  return ENGLISH.filter((word) => text.includes(word));
}

describe('6 X1: the question box speaks Dutch', () => {
  it('a question step: title, wait line, pager, hint, recommendation, free text, skip and the footer are Dutch', () => {
    render(createElement(AskQuestionsDialog, { pending: ASK, submitting: false, onSubmit: vi.fn(async () => ({ ok: true, error: null })) }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Forge vraagt iets' })).toBeInTheDocument();
    expect(within(dialog).getByText('Vraag 1 van 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Aanbevolen')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('Iets anders…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Vorige' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Overslaan, geen voorkeur' })).toBeInTheDocument();
    expect(englishIn(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volgende' }));
    expect(within(dialog).getByText('Kies alles wat past.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Antwoorden nakijken/ })).toBeInTheDocument();
    expect(englishIn(dialog)).toEqual([]);
  });

  it('skip and review: the skipped answer is sent in the words the owner saw, and the review screen is Dutch', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, error: null }));
    render(createElement(AskQuestionsDialog, { pending: ASK, submitting: false, onSubmit }));
    fireEvent.click(screen.getByRole('button', { name: 'Overslaan, geen voorkeur' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prijzen' }));
    fireEvent.click(screen.getByRole('button', { name: /Antwoorden nakijken/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Je antwoorden')).toBeInTheDocument();
    expect(within(dialog).getByText('Geen voorkeur')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Terug' })).toBeInTheDocument();
    expect(englishIn(dialog)).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Antwoorden versturen' }));
    });
    expect(onSubmit).toHaveBeenCalledWith(['Geen voorkeur', 'Prijzen']);
    // A failed save without its own error text says so in Dutch.
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Je antwoord kon niet worden opgeslagen.');
  });

  it('the abandoned notice is Dutch, names the reason and closes with "Begrepen"', () => {
    const onDismiss = vi.fn();
    render(createElement(AskQuestionsDialog, { pending: null, submitting: false, onSubmit: vi.fn(), abandoned: { id: 'a', reason: 'execution_stopped' }, onDismissAbandoned: onDismiss }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Forge vraagt iets' })).toBeInTheDocument();
    expect(within(dialog).getByText('Deze vraag wacht niet meer op een antwoord.')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('de klus is gestopt');
    expect(englishIn(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Begrepen' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('en keeps the English words', () => {
    setLocale('en');
    render(createElement(AskQuestionsDialog, { pending: ASK, submitting: false, onSubmit: vi.fn(async () => ({ ok: true, error: null })) }));
    expect(screen.getByRole('heading', { name: 'Forge is asking' })).toBeInTheDocument();
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument();
  });
});
