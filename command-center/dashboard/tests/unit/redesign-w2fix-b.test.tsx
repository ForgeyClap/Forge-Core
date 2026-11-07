/**
 * Redesign, fix round, part FX-B (Projects + shell polish).
 *
 * L3  project status tones: `waiting` is the amber Wacht tone. `blocked` (a stalled run) keeps a visible
 *     warning tone with "Staat vast" (XR-COPY1 R2): nobody paused it, so "Gepauzeerd" is not used.
 * L4  "Gemaakt door" on a delivered item names the helper's role (roleFromName), like JobDetail, instead of
 *     printing the raw log name in mono.
 * L7  Mijn projecten carries its own copy of the folder-picker styles; it no longer imports onboarding.css.
 * S1  the "Wacht op jou" chip in the bar is plain body text, not the mono <Machine> face (DESIGN §2).
 * S2  a Recent row keeps room for its delete icon while the icon shows, so the title ellipsizes before it.
 * S3  the text-free shell-copy bridge is gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { getLocale, setLocale, translate } from '@/i18n';
import type { Locale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Artifact } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';
import { WaitingChip } from '@/components/shell/WaitingChip';
import ArtifactsView from '@/views/artifacts/ArtifactsView';
import { ProjectStatusWord } from '@/views/projects/project-status';

const SRC = resolve(__dirname, '../../src');

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: 'demo-project',
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
  };
}

let startLocale: Locale;

beforeEach(() => {
  startLocale = getLocale();
  act(() => setLocale('nl'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => setLocale(startLocale));
  act(() => setUiMode('eenvoudig'));
});

describe('L3 project status tones', () => {
  it('waiting gets the amber Wacht tone and its word', () => {
    const { container } = render(createElement(ProjectStatusWord, { status: 'waiting' }));
    const badge = container.querySelector('.fw-xstatus');
    expect(badge?.getAttribute('data-status')).toBe('waiting');
    expect(badge?.textContent).toBe(translate('nl', 'rd.projects.status.waiting'));
  });

  it('blocked keeps a warning tone and says Staat vast, never the calm Gepauzeerd (R2)', () => {
    act(() => setLocale('nl'));
    const { container } = render(createElement(ProjectStatusWord, { status: 'blocked' }));
    const badge = container.querySelector('.fw-xstatus');
    expect(badge?.getAttribute('data-status')).toBe('stuck');
    expect(badge?.textContent).toBe(translate('nl', 'rd.projects.status.blocked'));
    expect(badge?.textContent).toBe('Staat vast');
    expect(badge?.textContent).not.toBe('Gepauzeerd');
  });

  it('paints the stuck tone with the warning colour, not the grey paused one (R2)', () => {
    const css = readFileSync(resolve(__dirname, '../../src/views/projects/project-status.css'), 'utf8');
    const rule = /\.fw-xstatus\[data-status='stuck'\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/var\(--fs-warn\)/);
    const source = readFileSync(resolve(__dirname, '../../src/views/projects/project-status.tsx'), 'utf8');
    expect(source).toMatch(/import '\.\/project-status\.css'/);
    expect(source).not.toMatch(/rd\.projects\.status\.paused/);
  });

  it('idle still shows no word at all', () => {
    const { container } = render(createElement(ProjectStatusWord, { status: 'idle' }));
    expect(container.querySelector('.fw-xstatus')).toBeNull();
  });
});

function artifact(producedBy: string): Artifact {
  return {
    id: 'a-1',
    name: 'verslag.md',
    kind: 'report',
    producedBy,
    taskId: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    size: '4.1 KB',
    preview: 'Samenvatting.',
    prototype: true,
  } as Artifact;
}

function renderPreview(item: Artifact) {
  const state = buildState({ data: { ...EMPTY_DATASET, artifacts: [item] }, selection: { kind: 'artifact', id: item.id } });
  const value: StoreValue = { state, dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(ArtifactsView)));
}

function madeByCell(container: HTMLElement): HTMLElement {
  const label = translate('nl', 'rd.delivered.by' as never);
  const row = Array.from(container.querySelectorAll('.fw-artifacts__meta-row')).find(
    (el) => el.querySelector('dt')?.textContent === label,
  );
  const dd = row?.querySelector('dd');
  if (!dd) throw new Error('no "Gemaakt door" row');
  return dd as HTMLElement;
}

describe('L4 "Gemaakt door" names the helper role', () => {
  it('a known helper shows its role word in plain text, not the raw log name in mono (Eenvoudig)', () => {
    const { container } = renderPreview(artifact('Build Boss'));
    const dd = madeByCell(container);
    expect(dd.textContent).toBe(translate('nl', 'team.roles.build-boss'));
    expect(dd.querySelector('.fg-machine')).toBeNull();
  });

  it('Uitgebreid adds the log name after the role word, marked as log data', () => {
    act(() => setUiMode('uitgebreid'));
    const { container } = renderPreview(artifact('build-boss'));
    const dd = madeByCell(container);
    expect(dd.textContent).toContain(translate('nl', 'team.roles.build-boss'));
    expect(dd.querySelector('[data-log-name]')?.textContent).toContain('build-boss');
  });

  it('a chat run says a conversation made it, not the chat-run id', () => {
    const { container } = renderPreview(artifact('chat-c-abc123-t-xyz789'));
    const dd = madeByCell(container);
    expect(dd.textContent).not.toContain('chat-c-abc123');
    expect(dd.textContent).toBe('Een gesprek');
  });

  it('an unknown name stays visible as recorded (log data), never hidden', () => {
    const { container } = renderPreview(artifact('nachtelijke-job'));
    const dd = madeByCell(container);
    expect(dd.textContent).toBe('nachtelijke-job');
    expect(dd.querySelector('[data-log-name]')).not.toBeNull();
  });
});

describe('L7 Mijn projecten owns its folder-picker styles', () => {
  const view = readFileSync(resolve(SRC, 'views/projects/ProjectsView.tsx'), 'utf8');
  const css = readFileSync(resolve(SRC, 'views/projects/projects.css'), 'utf8');

  it('ProjectsView no longer imports onboarding.css', () => {
    expect(view).not.toMatch(/onboarding\/onboarding\.css/);
  });

  it('projects.css styles the folder picker inside the add panel', () => {
    for (const cls of ['fs-folder', 'fs-folder__bar', 'fs-folder__path', 'fs-folder__list', 'fs-folder__item', 'fs-onb__hint', 'fs-onb__warn']) {
      expect(css, cls).toMatch(new RegExp(`\\.fw-addproj \\.${cls}\\b`));
    }
  });
});

describe('S1 the Wacht op jou chip is plain text', () => {
  it('the label is not wrapped in the mono Machine face', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          pending_asks: [{ id: 'ask-1', conversation_id: 'c-1', conversation_first_message: 'Welke kleur?', turn_id: 't-1', question_count: 1 }],
        }),
      }) as Response),
    );
    const value: StoreValue = { state: buildState(), dispatch: () => undefined };
    const { container } = render(
      createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(WaitingChip))),
    );
    await waitFor(() => expect(container.querySelector('.fw-waiting')).not.toBeNull());
    const chip = container.querySelector('.fw-waiting') as HTMLElement;
    expect(chip.textContent).toContain(translate('nl', 'shell.waiting.label'));
    expect(chip.querySelector('.fg-machine')).toBeNull();
    expect(chip.querySelector('.fw-machine')).toBeNull();
  });
});

describe('S2 a Recent row keeps room for its delete icon', () => {
  const css = readFileSync(resolve(SRC, 'components/shell/sidebar.css'), 'utf8');

  it('the link reserves end padding while the icon shows (hover and keyboard focus)', () => {
    expect(css).toMatch(/\.fw-side__crow:hover \.fw-side__clink/);
    expect(css).toMatch(/\.fw-side__crow:focus-within \.fw-side__clink/);
    const rule = css.match(/\.fw-side__crow:focus-within \.fw-side__clink\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/padding-inline-end:/);
  });

  it('the link itself can shrink so its title ellipsizes', () => {
    const rule = css.match(/\n\.fw-side__clink\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/min-inline-size:\s*0/);
  });
});

describe('S3 the unused shell-copy bridge is deleted', () => {
  it('src/components/shell/shell-copy.ts no longer exists', () => {
    expect(existsSync(resolve(SRC, 'components/shell/shell-copy.ts'))).toBe(false);
  });
});
