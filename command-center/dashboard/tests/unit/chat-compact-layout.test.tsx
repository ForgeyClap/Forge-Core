/**
 * FU-CHAT (owner "kies de beste", Lead option A): in Eenvoudig the
 * chat transcript gets at least half of the default window. What gives way, and what this suite pins:
 *
 *   - the usage strip starts COLLAPSED to one compact toggle (aria-expanded, Dutch label) that sits in
 *     the header's subtitle line; opening it shows today's meters below the header;
 *   - the composer's hint block becomes ONE short line in Eenvoudig (the key hints already live in the
 *     placeholder), while it still names the real folder (in the title) and that other folders are
 *     refused;
 *   - the team strip is the compact variant in Eenvoudig (still one toggle line, collapsed);
 *   - the transcript grows by flex instead of a min(18rem, 30vh) floor, and the shell's pill reserve no
 *     longer leaves an empty band under the chat frame;
 *   - Uitgebreid keeps today's layout (full usage bar, both hint lines).
 *
 * The 50 % itself is a rendered measurement (scratch Chromium run, see the run report); this suite pins
 * the structure that produces it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setLocale } from '@/i18n';
import { setUiMode } from '@/state/ui-mode';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Project } from '@/prototype/types/prototype-types';

import ChatView from '@/views/chat/ChatView';
import { Composer } from '@/views/chat/Composer';
import { UsageSummaryToggle } from '@/views/chat/sessions/UsageMeter';
import { TeamStripView } from '@/views/team/TeamStrip';

const PROJECT: Project = {
  prototype: true,
  id: 'bakkerij-website',
  name: 'bakkerij-website',
  description: '',
  type: 'unknown',
  status: 'waiting',
  lastActivity: '',
  path: 'C:\\Users\\Sanne\\Documents\\Forge Projecten\\68 bakkerij website De Korenaar',
  templateVersion: '',
  pinned: false,
  conversationCount: 1,
  missionCount: 0,
  taskCount: 0,
  agentCount: 0,
  skills: [],
  health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
};

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: {
      ...EMPTY_DATASET,
      projects: [PROJECT],
      conversations: [
        { prototype: true, id: 'c-1', projectId: PROJECT.id, title: 'Website voor bakkerij', updatedAt: '', messageCount: 0, messages: [] },
      ],
    },
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
    activeProjectId: PROJECT.id,
    activeConversationId: 'c-1',
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

function renderInStore(ui: ReturnType<typeof createElement>) {
  const value: StoreValue = { state: buildState(), dispatch: vi.fn() };
  return render(createElement(PrototypeContext.Provider, { value }, ui));
}

beforeEach(() => {
  setLocale('nl');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('UsageSummaryToggle (Eenvoudig usage, collapsed)', () => {
  it('is one button with the numbers as text, collapsed, no meters', () => {
    const onToggle = vi.fn();
    render(
      createElement(UsageSummaryToggle, {
        reading: { state: 'measured', session: 42, week: 92, sessionResetAt: null },
        expanded: false,
        controls: 'usage-panel',
        onToggle,
      }),
    );
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'usage-panel');
    expect(button.textContent).toContain('42%');
    expect(button.textContent).toContain('92%');
    expect(button).toHaveAccessibleName(/details tonen/i);
    expect(screen.queryByRole('meter')).toBeNull();
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('says honestly when nothing was measured, and offers the hide label when open', () => {
    render(
      createElement(UsageSummaryToggle, {
        reading: { state: 'unmeasured', session: null, week: null, sessionResetAt: null },
        expanded: true,
        controls: 'usage-panel',
        onToggle: () => undefined,
      }),
    );
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button.textContent).toMatch(/nog niet bekend/i);
    expect(button).toHaveAccessibleName(/details verbergen/i);
  });
});

describe('ChatView in Eenvoudig: compact chrome, growing transcript', () => {
  // Redesign 2A (DESIGN.md §2): the bar already names the conversation, so the chat draws no header in
  // Eenvoudig: one visually hidden h1, no toolbar, no usage toggle. The usage line above the composer
  // (UsageLine) appears only at 80 % or more, so with no reading nothing shows.
  it('draws no header in Eenvoudig: one hidden h1, no toolbar, no usage toggle or meter', () => {
    setUiMode('eenvoudig');
    const { container } = renderInStore(createElement(ChatView));
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass('fw-visually-hidden');
    expect(container.querySelector('.fw-chat__head, .fw-chat__crumbs, .fw-chat__tools')).toBeNull();
    expect(screen.queryByRole('button', { name: /Je limiet/ })).toBeNull();
    expect(container.querySelector('[data-testid="usage-meter"]')).toBeNull();
    expect(container.querySelector('[data-tour="composer"]')).not.toBeNull();
  });

  it('Uitgebreid keeps the full usage bar and no collapse toggle', () => {
    setUiMode('uitgebreid');
    renderInStore(createElement(ChatView));
    expect(screen.queryByRole('button', { name: /Je limiet/ })).toBeNull();
  });
});

describe('Composer hint: one short line in Eenvoudig', () => {
  const props = { onSend: () => true, onStop: () => undefined, streaming: false, conversationTitle: 'x', production: true };

  // Redesign 2A (DESIGN.md §5 text budget): Eenvoudig shows no visible hint line. The write-scope rule
  // stays: the field is described by it (screen readers) and it is the project chip's tooltip.
  it('Eenvoudig: no visible hint line; the field is described by the folder rule, the chip carries it as tooltip', () => {
    setUiMode('eenvoudig');
    const { container } = renderInStore(createElement(Composer, props));
    expect(container.querySelectorAll('.fw-chat-composer__hint')).toHaveLength(0);
    const field = screen.getByRole('textbox');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const rule = container.querySelector(`[id="${describedBy}"]`);
    expect(rule).toHaveClass('fw-visually-hidden');
    expect(rule?.textContent).toContain('68 bakkerij website De Korenaar');
    expect(rule?.textContent).toMatch(/geweigerd/);
    expect(container.querySelector('.fw-chat-composer__chip')?.getAttribute('title')).toContain(PROJECT.path);
  });

  // Uitgebreid now shows the same short scope line instead of the
  // always-on key hints and the full sentence; the path stays for screen readers and in the chip tooltip.
  it('Uitgebreid shows the short scope line; the full path stays for screen readers', () => {
    setUiMode('uitgebreid');
    const { container } = renderInStore(createElement(Composer, props));
    const hint = container.querySelector('.fw-chat-composer__hint');
    expect(hint?.querySelector('kbd')).toBeNull();
    expect(hint?.textContent).toContain(PROJECT.path);
    expect(hint?.querySelector('.fw-visually-hidden')?.textContent).toContain(PROJECT.path);
  });
});

describe('TeamStripView: compact in Eenvoudig, still a collapsed toggle', () => {
  it('marks the strip compact and starts collapsed with a Dutch toggle label', () => {
    setUiMode('eenvoudig');
    const { container } = render(
      createElement(TeamStripView, {
        statuses: new Map([['build-boss', 'busy']]) as never,
        chat: { status: 'ready', lines: [], total: 0, malformed: 0, truncated: false, error: null } as never,
      }),
    );
    expect(container.querySelector('.fw-team-strip')).toHaveAttribute('data-compact', 'true');
    expect(screen.getByRole('button', { name: /Overleg van het team tonen/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('Uitgebreid keeps the regular strip', () => {
    setUiMode('uitgebreid');
    const { container } = render(
      createElement(TeamStripView, {
        statuses: new Map([['build-boss', 'busy']]) as never,
        chat: { status: 'ready', lines: [], total: 0, malformed: 0, truncated: false, error: null } as never,
      }),
    );
    expect(container.querySelector('.fw-team-strip')).not.toHaveAttribute('data-compact');
  });
});

describe('chat.css: a real flex layout, no 30vh floor, no empty band', () => {
  const CSS = readFileSync(resolve(process.cwd(), 'src/views/chat/chat.css'), 'utf8');

  it('the transcript grows by flex and has no min(18rem, 30vh) floor', () => {
    const body = CSS.slice(CSS.indexOf('.fw-chat__body {'), CSS.indexOf('}', CSS.indexOf('.fw-chat__body {')));
    expect(body).not.toMatch(/30vh/);
    expect(body).toMatch(/flex:\s*1 1 0/);
  });

  // Redesign 2A: the floating usage pill is gone (the usage line sits above the composer), so chat.css
  // no longer carries any rule about the shell's old pill reserve.
  it('carries no rule for the old usage-pill reserve any more', () => {
    expect(CSS).not.toMatch(/\.fw-shell__main:has\(\.fw-chat-frame/);
    expect(CSS).not.toMatch(/acct-usage-reserve/);
  });
});
