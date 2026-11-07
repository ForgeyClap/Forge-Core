/**
 * side-pane — what the shell's one side pane shows (DESIGN.md §2, redesign 1C).
 *
 * Two owners share the pane:
 *   - "Details" (Uitgebreid only): today's Inspector and Dock in one pane. Its open state stays the
 *     existing `inspectorOpen` in the prototype store, so the store shape and its ~50 test fixtures do
 *     not change.
 *   - "Hulp": the `?` lesson for the current page, or the shortcut list. Kept here, outside the store.
 *     Opening help closes Details and the other way round (the shell does that), so the pane never
 *     stacks two things.
 *
 * Slot API for part 2D: `registerHelpLesson(render)` gives the pane the lesson for a route. Until 2D
 * registers one, the pane shows one line and a link to Leer Forge, never an invented lesson.
 */

import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

export type HelpView = 'closed' | 'lesson' | 'shortcuts';

let view: HelpView = 'closed';
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function getHelpView(): HelpView {
  return view;
}

export function setHelpView(next: HelpView): void {
  if (next === view) return;
  view = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHelpView(): HelpView {
  return useSyncExternalStore(subscribe, getHelpView, getHelpView);
}

/** Renders the lesson for a route path, or null when that route has none. */
export type HelpLessonRenderer = (path: string) => ReactNode;

let lessonRenderer: HelpLessonRenderer | null = null;

/** Part 2D registers the per-route lesson here. Returns an unregister function. */
export function registerHelpLesson(render: HelpLessonRenderer): () => void {
  lessonRenderer = render;
  emit();
  return () => {
    if (lessonRenderer === render) {
      lessonRenderer = null;
      emit();
    }
  };
}

export function getHelpLessonRenderer(): HelpLessonRenderer | null {
  return lessonRenderer;
}

export function useHelpLessonRenderer(): HelpLessonRenderer | null {
  return useSyncExternalStore(subscribe, getHelpLessonRenderer, getHelpLessonRenderer);
}
