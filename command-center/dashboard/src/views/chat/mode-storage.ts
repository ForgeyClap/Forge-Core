/**
 * mode-storage — persisted send-mode/effort/auto-plan choices for the composer.
 *
 * refactor-chat-split: split out of `Composer.tsx` — a plain function
 * export sitting alongside a component export in the same file trips
 * `react-refresh/only-export-components` (mirrors this directory's own `compose-args.ts` precedent
 * for the exact same warning class). Pure structural move: no behavior changed, no storage key
 * changed.
 */

import type { ChatSendEffort } from '@/prototype/state/chat-send';
import type { ChatSendMode } from '@/prototype/state/chat-send';
import type { ChatSendModel } from '@/prototype/state/chat-send';

import { isChatSendEffort, isChatSendMode, isChatSendModel } from './compose-args';

/** `'default'` stands for "omit the field" — the one choice that is not itself a `ChatSendEffort`. */
export type EffortChoice = 'default' | ChatSendEffort;

/** feat-model-picker: `'default'` stands for "omit --model" (the CLI's own current default) — the
 *  one choice that is not itself a `ChatSendModel`. Mirrors `EffortChoice`'s own shape exactly. */
export type ModelChoice = 'default' | ChatSendModel;

/**
 * composer-modes-ui: the effort/auto-plan choices persist per browser (not per project or
 * conversation — a simple, honest global "how I like to send messages" preference), mirroring
 * `prototype-store.ts`'s own `forge.prototype.*` localStorage convention exactly (same
 * try/catch-and-fall-back-to-a-safe-default read, same tolerant-write `persist` helper).
 *
 * fix-sec-round #2 (MEDIUM): the send-MODE choice does NOT stay global — a sticky "bypass" choice
 * silently carried over from one project into a completely different one (browser-wide, never
 * expiring) is a real footgun: the next message in an unrelated project would run with
 * `--permission-mode bypassPermissions` with no further confirmation. The mode is therefore keyed
 * per project id; an unknown/empty project id (no real project to run anything in at all) never
 * reads (or writes) any stored value and always resolves to `'execute'`.
 *
 * WP B3 (plan §4.4): a project that has never had a choice persisted for it yet — its
 * FIRST ever send — resolves to `'accept-edits'` ("Mag aanpassen"): Forge may edit files in the
 * project folder, and every other action goes through the permission prompt. It is NEVER `'bypass'`
 * by default any more (the old feat-forge-preamble default). `migrateStoredBypass()` below turns a
 * previously stored `'bypass'` back into "not chosen" once, and the chat tells the user so. A choice
 * persisted after that migration (Volledige toegang, only reachable in Uitgebreid with a per-project
 * confirmation) is respected.
 */
const MODE_STORAGE_PREFIX = 'forge.prototype.chatSendMode';
export const EFFORT_STORAGE_KEY = 'forge.prototype.chatEffort';
export const AUTO_PLAN_STORAGE_KEY = 'forge.prototype.chatAutoPlan';
// feat-model-picker: unlike effort (global, see the doc comment above), the model choice persists
// PER PROJECT — same rationale fix-sec-round #2 already established for `mode`: a browser-wide
// sticky pick that silently carried into an unrelated project would be a real footgun (spending a
// heavier/pricier model in a project the user never chose it for), so it is keyed per project id
// exactly like `MODE_STORAGE_PREFIX` above, with the same "unknown/empty project id never reads or
// writes" fallback to `'default'`.
const MODEL_STORAGE_PREFIX = 'forge.prototype.chatSendModel';

export function modeStorageKey(projectId: string): string {
  return `${MODE_STORAGE_PREFIX}.${projectId}`;
}

/** The mode a project starts in when nothing is stored for it: "Mag aanpassen" (never bypass). */
export const DEFAULT_SEND_MODE: ChatSendMode = 'accept-edits';

export function readStoredMode(projectId: string): ChatSendMode {
  if (projectId === '') return 'execute';
  try {
    const raw = localStorage.getItem(modeStorageKey(projectId));
    return raw !== null && isChatSendMode(raw) ? raw : DEFAULT_SEND_MODE;
  } catch {
    return DEFAULT_SEND_MODE;
  }
}

/** Set once the one-time bypass migration below has run in this browser profile. */
export const BYPASS_MIGRATION_KEY = 'forge.prototype.chatSendMode.bypassMigrated';

/**
 * One-time migration (plan §4.4): every stored per-project `'bypass'` choice from before WP B3 is
 * removed, so that project falls back to "not chosen" (= `DEFAULT_SEND_MODE`). Runs at most once per
 * browser profile (marker key), so a bypass the user deliberately turns on again later survives.
 * Returns how many projects were reset; the caller shows the toast when it is above zero.
 */
export function migrateStoredBypass(): number {
  try {
    if (localStorage.getItem(BYPASS_MIGRATION_KEY) === '1') return 0;
    const prefix = `${MODE_STORAGE_PREFIX}.`;
    const reset: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && key.startsWith(prefix) && key !== BYPASS_MIGRATION_KEY && localStorage.getItem(key) === 'bypass') {
        reset.push(key);
      }
    }
    reset.forEach((key) => localStorage.removeItem(key));
    localStorage.setItem(BYPASS_MIGRATION_KEY, '1');
    return reset.length;
  } catch {
    return 0;
  }
}

const BYPASS_CONFIRM_PREFIX = 'forge.prototype.bypassConfirmed';

/** True once the user confirmed "Volledige toegang" for this project (Uitgebreid, per project). */
export function isBypassConfirmed(projectId: string): boolean {
  if (projectId === '') return false;
  try {
    return localStorage.getItem(`${BYPASS_CONFIRM_PREFIX}.${projectId}`) === '1';
  } catch {
    return false;
  }
}

export function confirmBypass(projectId: string): void {
  if (projectId === '') return;
  persist(`${BYPASS_CONFIRM_PREFIX}.${projectId}`, '1');
}

export function modelStorageKey(projectId: string): string {
  return `${MODEL_STORAGE_PREFIX}.${projectId}`;
}

export function readStoredModel(projectId: string): ModelChoice {
  if (projectId === '') return 'default';
  try {
    const raw = localStorage.getItem(modelStorageKey(projectId));
    return raw !== null && isChatSendModel(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function readStoredEffort(): EffortChoice {
  try {
    const raw = localStorage.getItem(EFFORT_STORAGE_KEY);
    return raw !== null && isChatSendEffort(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function readStoredAutoPlan(): boolean {
  try {
    return localStorage.getItem(AUTO_PLAN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode or storage disabled — the choice simply does not persist across reloads. */
  }
}
