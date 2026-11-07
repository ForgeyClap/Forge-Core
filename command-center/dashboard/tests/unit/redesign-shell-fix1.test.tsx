/**
 * Redesign, fix round 1 (part FIX-B): shell behaviour the first review found.
 *
 *   1. A pane opened from the `?` menu takes focus (its heading), and Esc closes it and gives focus to
 *      <main> (DESIGN.md §7). Before: focus fell to <body> and Esc did nothing.
 *   2. "Zoals Windows" resolves like index.html: dark only when the system says dark, light otherwise.
 *   5. The project chip in the bar is a 32 px control (--fs-control-sm), not 30 px.
 *   6. The Details pane starts closed, even in a roomy window.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Bar from '@/components/shell/Bar';
import { SidePane } from '@/components/shell/SidePane';
import { setHelpView } from '@/components/shell/side-pane';
import { PrototypeContext, resolveTheme, systemTheme } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { createInitialState } from '@/prototype/state/shell-effects';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setLocale } from '@/i18n';
import { setUiMode } from '@/state/ui-mode';

function stubMatchMedia(matching: (query: string) => boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: matching(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  act(() => setLocale('nl'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => {
    setHelpView('closed');
    setUiMode('eenvoudig');
    setLocale('en');
  });
});

describe('the help pane takes focus and Esc gives it back (DESIGN.md §7)', () => {
  function mountShell(state: PrototypeState) {
    const dispatch = vi.fn<(action: PrototypeAction) => void>();
    const value: StoreValue = { state, dispatch };
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(
          PrototypeContext.Provider,
          { value },
          createElement(
            Fragment,
            null,
            createElement(Bar),
            createElement('main', { id: 'fw-main', tabIndex: -1 }, 'pagina'),
            createElement(SidePane),
          ),
        ),
      ),
    );
    return { dispatch };
  }

  it('? > Sneltoetsen with the keyboard: focus lands in the pane, Esc closes it, focus on #fw-main', async () => {
    const user = userEvent.setup();
    mountShell(createInitialState(EMPTY_DATASET));

    const help = screen.getByRole('button', { name: 'Hulp en uitleg' });
    act(() => help.focus());
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: 'Hulp en uitleg' });
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Sneltoetsen' }));
    await user.keyboard('{Enter}');

    const pane = screen.getByRole('complementary', { name: 'Sneltoetsen' });
    expect(document.activeElement).not.toBe(document.body);
    expect(pane.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(pane).getByRole('heading', { name: 'Sneltoetsen' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('fw-main'));
  });

  it('? > Uitleg bij deze pagina also hands focus to the pane', async () => {
    const user = userEvent.setup();
    mountShell(createInitialState(EMPTY_DATASET));
    await user.click(screen.getByRole('button', { name: 'Hulp en uitleg' }));
    await user.click(screen.getByRole('menuitem', { name: 'Uitleg bij deze pagina' }));
    const pane = screen.getByRole('complementary', { name: 'Hulp' });
    expect(pane.contains(document.activeElement)).toBe(true);
  });

  it('never pulls focus away from a real element when the pane opens', () => {
    const outside = document.createElement('button');
    outside.textContent = 'elders';
    document.body.appendChild(outside);
    try {
      mountShell(createInitialState(EMPTY_DATASET));
      act(() => outside.focus());
      act(() => setHelpView('shortcuts'));
      expect(screen.getByRole('complementary', { name: 'Sneltoetsen' })).toBeInTheDocument();
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe('Zoals Windows resolves like index.html (dark only when the system says dark)', () => {
  it('no preference -> light', () => {
    stubMatchMedia(() => false);
    expect(systemTheme()).toBe('light');
    expect(resolveTheme('system')).toBe('light');
  });

  it('matchMedia throwing -> light', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('no media queries here');
      }),
    );
    expect(resolveTheme('system')).toBe('light');
  });

  it('asks the dark query, and a dark system -> dark', () => {
    stubMatchMedia((query) => query === '(prefers-color-scheme: dark)');
    expect(resolveTheme('system')).toBe('dark');
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('an explicit choice is never overridden by the system', () => {
    stubMatchMedia(() => true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('index.html asks the same query', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain("matchMedia('(prefers-color-scheme: dark)')");
  });
});

describe('the Details pane starts closed (DESIGN.md: behind ... > Details tonen)', () => {
  it('even when every media query matches (a roomy window)', () => {
    stubMatchMedia(() => true);
    expect(createInitialState(EMPTY_DATASET).inspectorOpen).toBe(false);
  });

  it('Uitgebreid first load: no Details pane until it is asked for', () => {
    stubMatchMedia(() => true);
    act(() => setUiMode('uitgebreid'));
    const value: StoreValue = { state: createInitialState(EMPTY_DATASET), dispatch: vi.fn() };
    render(
      createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(SidePane))),
    );
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});

describe('bar chip size (DESIGN.md §7: controls at least 32 px)', () => {
  it('.fw-bar__chip uses the small control token, not a hard 30px', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/shell/bar.css'), 'utf8');
    const chip = css.match(/\.fw-bar__chip\s*\{([^}]*)\}/);
    expect(chip).not.toBeNull();
    expect(chip![1]).toMatch(/block-size:\s*var\(--fs-control-sm\)/);
    expect(chip![1]).not.toMatch(/block-size:\s*30px/);
  });
});
