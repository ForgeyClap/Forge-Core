/**
 * learn-model — the four Leer Forge lessons and the progress writer (DESIGN.md §3.6, redesign 2D).
 *
 * Progress lives in `localStorage forge.learn` as `{ "done": ["<lesson id>", ...] }`, the contract the
 * sidebar's "2/4" reads (`components/shell/learn-progress.ts`). Only the four known ids are written,
 * each once. After every write the same-tab event fires, so the sidebar count follows at once.
 * Storage that cannot be read or written means "nothing done" and never blocks a lesson.
 */

import type { MessageKey } from '@/i18n';
import { LEARN_LESSON_IDS, LEARN_PROGRESS_EVENT, LEARN_STORAGE_KEY } from '@/components/shell/learn-progress';

export type LessonId = (typeof LEARN_LESSON_IDS)[number];

/** What "Probeer het" does. Every action is a real screen or a real dialog, never a fake one. */
export type LessonAction =
  /** Start, with an example request in the composer. */
  | 'start-with-example'
  /** The real "Nieuw project" dialog (POST /api/projects). */
  | 'new-project'
  /** Klussen & bewijs: the real list of runs with their proof (it shows its own empty state). */
  | 'proof-list'
  /** Instellingen, scrolled to the Forge-router ("Als je limiet op is"). */
  | 'router-settings';

export interface Lesson {
  readonly id: LessonId;
  /** Locale group under `rd.learn.lessons.<key>`. */
  readonly key: 'first' | 'project' | 'proof' | 'limit';
  readonly minutes: number;
  readonly action: LessonAction;
}

export const LESSONS: readonly Lesson[] = [
  { id: 'first-question', key: 'first', minutes: 1, action: 'start-with-example' },
  { id: 'start-project', key: 'project', minutes: 2, action: 'new-project' },
  { id: 'read-proof', key: 'proof', minutes: 1, action: 'proof-list' },
  { id: 'limit', key: 'limit', minutes: 1, action: 'router-settings' },
];

export function lessonTitleKey(lesson: Lesson): MessageKey {
  return `rd.learn.lessons.${lesson.key}.title` as MessageKey;
}

export function lessonStepKeys(lesson: Lesson): readonly MessageKey[] {
  return (['s1', 's2', 's3'] as const).map((step) => `rd.learn.lessons.${lesson.key}.${step}` as MessageKey);
}

export function lessonById(id: string | null | undefined): Lesson | undefined {
  return LESSONS.find((lesson) => lesson.id === id);
}

/** `?lesson=` on /learn: a lesson id (`limit`, `read-proof`) or its short key (`proof`). Anything else: none. */
export function lessonFromQuery(value: string | null | undefined): Lesson | undefined {
  if (!value) return undefined;
  return LESSONS.find((lesson) => lesson.id === value || lesson.key === value);
}

/** The route the `?` side pane shows a lesson for (DESIGN.md §3.6: "the matching lesson"). */
export function lessonForPath(path: string): Lesson | undefined {
  if (path === '/' || path === '/chat') return lessonById('first-question');
  if (path === '/projects' || path === '/project') return lessonById('start-project');
  if (path === '/artifacts' || path === '/jobs') return lessonById('read-proof');
  if (path === '/settings' || path === '/accounts') return lessonById('limit');
  return undefined;
}

/** The done lesson ids, in lesson order. Unknown or repeated ids are dropped. */
export function readDone(): readonly LessonId[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(LEARN_STORAGE_KEY) ?? null;
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = parsed !== null && typeof parsed === 'object' ? (parsed as { done?: unknown }).done : undefined;
  if (!Array.isArray(list)) return [];
  const stored = new Set(list.filter((entry): entry is string => typeof entry === 'string'));
  return LEARN_LESSON_IDS.filter((id) => stored.has(id));
}

function writeDone(done: readonly LessonId[]): void {
  try {
    globalThis.localStorage?.setItem(LEARN_STORAGE_KEY, JSON.stringify({ done }));
  } catch {
    /* Not remembered when storage is unavailable; the lesson itself still works. */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LEARN_PROGRESS_EVENT));
}

/** Marks one lesson done (idempotent) and returns the new list. */
export function markLessonDone(id: LessonId): readonly LessonId[] {
  const current = readDone();
  if (current.includes(id)) return current;
  const next = LEARN_LESSON_IDS.filter((known) => known === id || current.includes(known));
  writeDone(next);
  return next;
}

/** The lesson to open first: the first one not done yet, or the first lesson when all are done. */
export function firstOpenLesson(done: readonly LessonId[]): Lesson {
  return LESSONS.find((lesson) => !done.includes(lesson.id)) ?? LESSONS[0];
}
