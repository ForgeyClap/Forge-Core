/**
 * Redesign 2D — the 3-stop tour host (DESIGN.md §3.1 "Guided tour").
 *
 *  - it registers with the shell, so "Rondleiding opnieuw" can appear under `?`;
 *  - it shows only when onboarding left a request or a replay is asked for (never forced);
 *  - Escape = Overslaan; focus sits in the card and Tab stays inside it;
 *  - a finished or skipped tour is never shown again on its own, but a replay shows it again.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { setLocale } from '@/i18n';
import { hasTourReplayListener, requestTourReplay } from '@/components/shell/shell-events';
import { TourHost } from '@/components/tour/Tour';
import { markTourSeen, readTourMemory, requestTourStart, TOUR_STORAGE_KEY } from '@/components/tour/tour-state';

/** The three anchors the shell and the composer carry, with a real size so the card points at them. */
function Anchors() {
  return createElement(
    'div',
    null,
    createElement('textarea', { 'data-tour': 'composer', 'aria-label': 'Bericht' }),
    createElement('a', { 'data-tour': 'projects', href: '#/projects' }, 'Mijn projecten'),
    createElement('button', { 'data-tour': 'help', type: 'button' }, '?'),
  );
}

function renderHost(path = '/') {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(TourHost),
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/', element: createElement(Anchors) }),
        createElement(Route, { path: '/settings', element: createElement('p', null, 'SETTINGS') }),
      ),
    ),
  );
}

async function frames(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const realRect = HTMLElement.prototype.getBoundingClientRect;

describe('tour host (redesign 2D)', () => {
  beforeEach(() => {
    setLocale('nl');
    localStorage.removeItem(TOUR_STORAGE_KEY);
    // jsdom has no layout: give every element a visible box so anchors count as present.
    HTMLElement.prototype.getBoundingClientRect = function rect() {
      return { top: 100, left: 300, width: 200, height: 40, right: 500, bottom: 140, x: 300, y: 100, toJSON: () => ({}) } as DOMRect;
    };
  });

  afterEach(() => {
    cleanup();
    HTMLElement.prototype.getBoundingClientRect = realRect;
    localStorage.removeItem(TOUR_STORAGE_KEY);
    setLocale('en');
  });

  it('registers with the shell while mounted (that is what shows "Rondleiding opnieuw")', () => {
    expect(hasTourReplayListener()).toBe(false);
    const { unmount } = renderHost();
    expect(hasTourReplayListener()).toBe(true);
    unmount();
    expect(hasTourReplayListener()).toBe(false);
  });

  it('is never shown on its own without a request', async () => {
    renderHost();
    await frames();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows stop 1 when onboarding asked for it, with focus in the card and Tab kept inside', async () => {
    localStorage.setItem(TOUR_STORAGE_KEY, 'pending');
    renderHost();
    await frames();
    const card = screen.getByRole('dialog', { name: 'Typ hier wat je wilt' });
    expect(card).toHaveTextContent('1 van 3');
    expect(card.contains(document.activeElement)).toBe(true);
    const skip = screen.getByRole('button', { name: 'Overslaan' });
    const next = screen.getByRole('button', { name: 'Volgende' });
    next.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(skip);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(next);
  });

  it('Escape skips: the tour closes, is stored as seen, and never comes back on its own', async () => {
    localStorage.setItem(TOUR_STORAGE_KEY, 'pending');
    const first = renderHost();
    await frames();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await frames(10);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readTourMemory()).toBe('seen');
    first.unmount();

    renderHost();
    await frames();
    expect(screen.queryByRole('dialog')).toBeNull();

    // ...unless it is replayed (? > Rondleiding opnieuw, Instellingen > Algemeen).
    act(() => requestTourReplay());
    await frames();
    expect(screen.getByRole('dialog', { name: 'Typ hier wat je wilt' })).toBeInTheDocument();
  });

  it('walks the three stops and stores "seen" after Klaar', async () => {
    renderHost();
    act(() => requestTourStart());
    await frames();
    expect(screen.getByRole('dialog')).toHaveTextContent('1 van 3');
    fireEvent.click(screen.getByRole('button', { name: 'Volgende' }));
    await frames();
    expect(screen.getByRole('dialog', { name: 'Hier staat al je werk' })).toHaveTextContent('2 van 3');
    fireEvent.click(screen.getByRole('button', { name: 'Volgende' }));
    await frames();
    expect(screen.getByRole('dialog', { name: 'Hulp nodig? Kijk hier' })).toHaveTextContent('3 van 3');
    fireEvent.click(screen.getByRole('button', { name: 'Klaar' }));
    await frames(10);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readTourMemory()).toBe('seen');
  });

  it('a replay from another page goes to Start first, where the composer is', async () => {
    markTourSeen();
    renderHost('/settings');
    expect(screen.getByText('SETTINGS')).toBeInTheDocument();
    act(() => requestTourReplay());
    await frames();
    expect(screen.queryByText('SETTINGS')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Typ hier wat je wilt' })).toBeInTheDocument();
  });
});
