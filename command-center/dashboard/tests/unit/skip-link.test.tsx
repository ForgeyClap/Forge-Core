/**
 * (defect 1, high): "Skip to content" used to follow `href="#fw-main"`. Under the HashRouter
 * that hash is read as the route `/fw-main`, an unknown path, so the app redirected to Home. The
 * link must keep the current route and move focus to the main landmark instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import AppShell from '@/components/shell/AppShell';
import { skipToMain } from '@/components/shell/skip-link';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';

function WhereAmI() {
  const location = useLocation();
  return createElement('p', { 'data-testid': 'path' }, location.pathname);
}

describe('skipToMain (unit)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('prevents the hash navigation and focuses the main landmark', () => {
    document.body.innerHTML = '<a id="skip" href="#fw-main">Skip</a><main id="fw-main">content</main>';
    const preventDefault = vi.fn();
    skipToMain({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const main = document.getElementById('fw-main');
    expect(document.activeElement).toBe(main);
    // Focusable by script only, never a Tab stop of its own.
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('still prevents navigation when there is no main landmark (never throws)', () => {
    const preventDefault = vi.fn();
    expect(() => skipToMain({ preventDefault })).not.toThrow();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('AppShell skip link (rendered)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the route and moves focus to <main> on click (Enter on a link fires click)', () => {
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/tests'] },
        createElement(PrototypeProvider, null, createElement(AppShell, null, createElement(WhereAmI))),
      ),
    );
    const link = screen.getByText('Skip to content');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // the default hash navigation was cancelled
    expect(screen.getByTestId('path').textContent).toBe('/tests');
    expect(document.activeElement?.id).toBe('fw-main');
  });
});
