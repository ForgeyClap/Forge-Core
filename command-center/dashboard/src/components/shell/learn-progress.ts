/**
 * learn-progress — how many Leer Forge lessons are done, for the "2/4" beside the sidebar entry
 * (DESIGN.md §3.6). Read-only: Leer Forge itself (part 2D) writes the progress.
 *
 * Storage contract (`localStorage forge.learn`): `{ "done": ["<lesson id>", ...] }`. Only the four known
 * lesson ids count, each once, so junk or an old format can never show "5/4". Unreadable storage reads
 * as nothing done, never as a guess.
 */

import { useSyncExternalStore } from 'react';

export const LEARN_STORAGE_KEY = 'forge.learn';

/** The four lessons of DESIGN.md §3.6, in order. Part 2D uses the same ids. */
export const LEARN_LESSON_IDS = ['first-question', 'start-project', 'read-proof', 'limit'] as const;

export interface LearnProgress {
  readonly done: number;
  readonly total: number;
}

export function readLearnProgress(): LearnProgress {
  const total = LEARN_LESSON_IDS.length;
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(LEARN_STORAGE_KEY) ?? null;
  } catch {
    return { done: 0, total };
  }
  if (raw === null) return { done: 0, total };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { done: 0, total };
  }
  const list = parsed !== null && typeof parsed === 'object' ? (parsed as { done?: unknown }).done : undefined;
  if (!Array.isArray(list)) return { done: 0, total };
  const known = new Set<string>(LEARN_LESSON_IDS);
  const done = new Set(list.filter((id): id is string => typeof id === 'string' && known.has(id)));
  return { done: done.size, total };
}

/** Same-tab writers call this after saving, so the sidebar count follows at once. */
export const LEARN_PROGRESS_EVENT = 'forge:learn-progress';

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LEARN_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(LEARN_PROGRESS_EVENT, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(LEARN_PROGRESS_EVENT, listener);
  };
}

function snapshot(): string {
  const { done, total } = readLearnProgress();
  return `${done}/${total}`;
}

/** "done/total", re-read when another tab or Leer Forge changes the progress. */
export function useLearnProgressLabel(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
