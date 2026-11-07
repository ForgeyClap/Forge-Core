/**
 * Redesign 2D — Leer Forge (DESIGN.md §3.6).
 *
 *  - four lessons, each with at most three steps;
 *  - progress persists in `localStorage forge.learn` (the contract the sidebar's "2/4" reads), survives a
 *    remount, and only ever holds the four known ids;
 *  - "Probeer het" does the real thing: Start with an example in the composer, the real Nieuw project
 *    dialog (POST /api/projects), Klussen & bewijs, Instellingen at the router;
 *  - the `?` side pane gets the matching lesson per page, and nothing on a page without one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { setLocale } from '@/i18n';
import { LEARN_STORAGE_KEY, readLearnProgress } from '@/components/shell/learn-progress';
import { getHelpLessonRenderer } from '@/components/shell/side-pane';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import LearnView from '@/views/learn/LearnView';
import { HelpLessons } from '@/views/learn/HelpLessons';
import { LESSONS, lessonForPath, markLessonDone, readDone } from '@/views/learn/learn-model';

function Where() {
  const location = useLocation();
  return createElement('output', { 'data-testid': 'where' }, `${location.pathname}${location.search}`);
}

function Composer() {
  return createElement(
    'div',
    { 'data-tour': 'composer', 'data-variant': 'start' },
    createElement('textarea', { 'aria-label': 'Bericht aan Forge', defaultValue: '' }),
  );
}

/** The chat composer: same `data-tour`, other variant (the real Composer marks both). */
function ChatComposer() {
  return createElement(
    'div',
    { 'data-tour': 'composer', 'data-variant': 'chat' },
    createElement('textarea', { 'aria-label': 'Bericht in gesprek', defaultValue: '' }),
  );
}

/** Start is a lazy route in the app: its composer appears a few frames after the navigation. */
function LazyStart() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 30);
    return () => clearTimeout(timer);
  }, []);
  return shown ? createElement(Composer) : createElement('p', null, 'LADEN');
}

/** /chat with the `?` pane open on its lesson (what the shell renders through the registered renderer). */
function ChatWithPane() {
  const renderLesson = getHelpLessonRenderer();
  return createElement('div', null, createElement(ChatComposer), renderLesson?.('/chat') ?? null);
}

function renderAt(element: ReactNode, path = '/learn') {
  return render(
    createElement(
      PrototypeProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Where),
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/learn', element }),
          createElement(Route, { path: '/', element: createElement(Composer) }),
          createElement(Route, { path: '*', element: createElement('p', null, 'ELDERS') }),
        ),
      ),
    ),
  );
}

async function settle(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('Leer Forge (redesign 2D)', () => {
  beforeEach(() => {
    setLocale('nl');
    localStorage.removeItem(LEARN_STORAGE_KEY);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.removeItem(LEARN_STORAGE_KEY);
    setLocale('en');
  });

  it('shows four lessons, the first open one selected, at most three steps each', () => {
    renderAt(createElement(LearnView));
    expect(screen.getByRole('heading', { level: 1, name: 'Leer Forge' })).toBeInTheDocument();
    const items = screen.getAllByRole('button', { name: /min$/ });
    expect(items.map((item) => item.textContent)).toEqual([
      '1Je eerste vraag1 min',
      '2Een project starten2 min',
      '3Opleverbewijs lezen1 min',
      '4Als je limiet op is1 min',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('heading', { level: 2, name: 'Je eerste vraag' })).toBeInTheDocument();
    expect(LESSONS).toHaveLength(4);
    expect(document.querySelectorAll('.fs-lesson__steps li').length).toBeLessThanOrEqual(3);
    expect(screen.getByText('0 van 4 klaar')).toBeInTheDocument();
  });

  it('"Volgende les" marks the lesson done, moves on, and the progress survives a remount', () => {
    const first = renderAt(createElement(LearnView));
    fireEvent.click(screen.getByRole('button', { name: 'Volgende les' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Een project starten' })).toBeInTheDocument();
    expect(screen.getByText('1 van 4 klaar')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(LEARN_STORAGE_KEY) ?? '{}')).toEqual({ done: ['first-question'] });
    expect(readLearnProgress()).toEqual({ done: 1, total: 4 });
    first.unmount();

    renderAt(createElement(LearnView));
    expect(screen.getByText('1 van 4 klaar')).toBeInTheDocument();
    // The next open lesson is selected, and the done one carries its check (and says so).
    expect(screen.getByRole('button', { name: /Een project starten/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /Je eerste vraag, Klaar/ })).toBeInTheDocument();
  });

  it('the last lesson says Klaar, and junk in storage never counts', () => {
    localStorage.setItem(LEARN_STORAGE_KEY, JSON.stringify({ done: ['first-question', 'nope', 'first-question', 5] }));
    expect(readDone()).toEqual(['first-question']);
    markLessonDone('limit');
    markLessonDone('limit');
    expect(readDone()).toEqual(['first-question', 'limit']);
    renderAt(createElement(LearnView));
    fireEvent.click(screen.getByRole('button', { name: /Als je limiet op is/ }));
    expect(screen.getByRole('button', { name: 'Klaar' })).toBeInTheDocument();
  });

  it('Probeer het (lesson 1) opens Start with an example in the real composer, not sent', async () => {
    renderAt(createElement(LearnView));
    fireEvent.click(screen.getByRole('button', { name: 'Probeer het' }));
    await settle();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
    expect(screen.getByRole('textbox', { name: 'Bericht aan Forge' })).toHaveValue(
      'Maak een simpele website voor mijn kapsalon, met openingstijden en een belknop.',
    );
    expect(readDone()).toContain('first-question');
  });

  it('Probeer het (lesson 2) opens the real Nieuw project dialog, which posts to /api/projects', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ ok: true, project: { id: 'kapsalon', name: 'Kapsalon' } }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
    renderAt(createElement(LearnView));
    fireEvent.click(screen.getByRole('button', { name: /Een project starten/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Probeer het' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    fireEvent.change(dialog.querySelector('input') as HTMLInputElement, { target: { value: 'Kapsalon' } });
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    await settle();
    expect(fetchSpy.mock.calls.some(([url, init]) => String(url).includes('/api/projects') && init?.method === 'POST')).toBe(true);
    expect(readDone()).toContain('start-project');
  });

  it.each([
    ['Opleverbewijs lezen', '/jobs'],
    ['Als je limiet op is', '/settings?focus=router'],
  ])('Probeer het for "%s" goes to the real screen %s', (title, target) => {
    renderAt(createElement(LearnView));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }));
    fireEvent.click(screen.getByRole('button', { name: 'Probeer het' }));
    expect(screen.getByTestId('where')).toHaveTextContent(target);
  });

  it('F3: Probeer het from the ? pane on /chat puts the example in the Start composer, not the closing chat one', async () => {
    const pane = render(createElement(HelpLessons));
    render(
      createElement(
        PrototypeProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/chat'] },
          createElement(Where),
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/chat', element: createElement(ChatWithPane) }),
            createElement(Route, { path: '/', element: createElement(LazyStart) }),
          ),
        ),
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Bericht in gesprek' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Probeer het' }));
    // Two waits: React flushes the lazy Start render when the first act() ends; the second lets the
    // composer search (one try per frame) find it.
    await settle(60);
    await settle(120);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
    expect(screen.getByRole('textbox', { name: 'Bericht aan Forge' })).toHaveValue(
      'Maak een simpele website voor mijn kapsalon, met openingstijden en een belknop.',
    );
    pane.unmount();
  });

  it('F4: /learn?lesson=limit opens lesson 4 (the router link "Hoe werkt dit?"), even with nothing done', () => {
    renderAt(createElement(LearnView), '/learn?lesson=limit');
    expect(screen.getByRole('heading', { level: 2, name: 'Als je limiet op is' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Als je limiet op is/ })).toHaveAttribute('aria-current', 'step');
  });

  it('F4: an unknown ?lesson= falls back to the first open lesson', () => {
    renderAt(createElement(LearnView), '/learn?lesson=nope');
    expect(screen.getByRole('heading', { level: 2, name: 'Je eerste vraag' })).toBeInTheDocument();
  });

  it('L8: the lesson 2 illustration does not say "Nieuw project" twice', () => {
    renderAt(createElement(LearnView));
    fireEvent.click(screen.getByRole('button', { name: /Een project starten/ }));
    const art = document.querySelector('.fs-learn-art--project') as HTMLElement;
    expect(art).not.toBeNull();
    const count = (art.textContent ?? '').split('Nieuw project').length - 1;
    expect(count).toBe(1);
  });

  it('the ? side pane gets the matching lesson per page, and nothing on a page without one', () => {
    expect(lessonForPath('/')?.id).toBe('first-question');
    expect(lessonForPath('/projects')?.id).toBe('start-project');
    expect(lessonForPath('/settings')?.id).toBe('limit');
    expect(lessonForPath('/mindmap')).toBeUndefined();

    const { unmount } = renderAt(createElement(HelpLessons));
    const renderLesson = getHelpLessonRenderer();
    expect(renderLesson).not.toBeNull();
    expect(renderLesson?.('/mindmap')).toBeNull();
    expect(renderLesson?.('/settings')).not.toBeNull();
    unmount();
    expect(getHelpLessonRenderer()).toBeNull();
  });
});
