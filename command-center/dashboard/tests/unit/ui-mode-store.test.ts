/**
 * WP B4 — the Eenvoudig/Uitgebreid store and the sidebar visibility table (plan §4.2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

async function freshStore() {
  vi.resetModules();
  return import('@/state/ui-mode');
}

describe('ui-mode store', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to eenvoudig when nothing is stored', async () => {
    const store = await freshStore();
    expect(store.getUiMode()).toBe('eenvoudig');
    expect(store.DEFAULT_UI_MODE).toBe('eenvoudig');
  });

  it('honours and persists a stored choice under forge.uiMode', async () => {
    localStorage.setItem('forge.uiMode', 'uitgebreid');
    const store = await freshStore();
    expect(store.getUiMode()).toBe('uitgebreid');
    store.setUiMode('eenvoudig');
    expect(localStorage.getItem('forge.uiMode')).toBe('eenvoudig');
    const again = await freshStore();
    expect(again.getUiMode()).toBe('eenvoudig');
  });

  it('falls back to eenvoudig for an unknown stored value and refuses an unknown mode', async () => {
    localStorage.setItem('forge.uiMode', 'expert');
    const store = await freshStore();
    expect(store.getUiMode()).toBe('eenvoudig');
    expect(() => store.setUiMode('expert' as never)).toThrow(/Unknown UI mode/);
  });

  it('notifies listeners and re-renders useUiMode readers', async () => {
    const store = await freshStore();
    const listener = vi.fn();
    const off = store.subscribeUiMode(listener);
    const { result } = renderHook(() => store.useUiMode());
    expect(result.current.mode).toBe('eenvoudig');
    expect(result.current.isAdvanced).toBe(false);
    act(() => store.setUiMode('uitgebreid'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe('uitgebreid');
    expect(result.current.isAdvanced).toBe(true);
    // Setting the same mode again is a no-op.
    act(() => store.setUiMode('uitgebreid'));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('sidebar visibility per mode (nav-config)', () => {
  it('Eenvoudig shows exactly Start, Gesprekken, Mijn projecten and Instellingen', async () => {
    const nav = await import('@/components/shell/nav-config');
    const primary = nav.primaryNavFor('eenvoudig').map((item) => item.path);
    expect(primary).toEqual(['/', '/projects', '/chat', '/settings']);
    expect(nav.secondaryNavFor('eenvoudig')).toEqual([]);
  });

  it('Uitgebreid adds Team, Klussen & bewijs, Activiteit, Taken and Overzicht', async () => {
    const nav = await import('@/components/shell/nav-config');
    const all = [...nav.primaryNavFor('uitgebreid'), ...nav.secondaryNavFor('uitgebreid')].map((item) => item.path);
    for (const path of ['/', '/projects', '/chat', '/settings', '/team', '/tests', '/activity', '/tasks', '/mission']) {
      expect(all).toContain(path);
    }
  });

  it('never shows the design reference or account rotation, in either mode', async () => {
    const nav = await import('@/components/shell/nav-config');
    for (const mode of ['eenvoudig', 'uitgebreid'] as const) {
      const all = [...nav.primaryNavFor(mode), ...nav.secondaryNavFor(mode)].map((item) => item.path);
      expect(all).not.toContain('/theme');
      expect(all).not.toContain('/accounts');
    }
  });

  it('shows one entry called Team in Uitgebreid: the new screen, not the old roster', async () => {
    const nav = await import('@/components/shell/nav-config');
    const { setLocale } = await import('@/i18n');
    setLocale('nl');
    const items = [...nav.primaryNavFor('uitgebreid'), ...nav.secondaryNavFor('uitgebreid')];
    const teams = items.filter((item) => item.label === 'Team');
    expect(teams.map((item) => item.path)).toEqual(['/team']);
    // The routes stay reachable; only the sidebar entry is hidden.
    expect(nav.ALL_NAV.some((item) => item.path === '/agents')).toBe(true);
    expect(nav.navVisibility('/agents')).toBe('hidden');
  });

  it('the lists the sidebar renders today never carry a hidden route', async () => {
    const nav = await import('@/components/shell/nav-config');
    const rendered = [...nav.PRIMARY_NAV, ...nav.SECONDARY_NAV].map((item) => item.path);
    for (const hidden of ['/agents', '/theme', '/accounts', '/onboarding']) expect(rendered).not.toContain(hidden);
    expect(nav.HIDDEN_NAV.map((item) => item.path)).toEqual(['/agents', '/accounts', '/theme', '/onboarding']);
  });

  it('an unknown path defaults to Uitgebreid only', async () => {
    const nav = await import('@/components/shell/nav-config');
    expect(nav.isNavVisible('/something-new', 'eenvoudig')).toBe(false);
    expect(nav.isNavVisible('/something-new', 'uitgebreid')).toBe(true);
  });
});
