/**
 * settings-model — the shape of the Settings page (WP B6; v1.0 redesign, DESIGN.md §3.4).
 *
 * One page, grouped. Eenvoudig shows four groups: Algemeen, Accounts, Veiligheid, Privacy. Uitgebreid
 * adds Modellen, Gebruik, Koppelingen, Mappen, Diagnose and Over Forge (under a hairline in the list),
 * plus two extra rows in Algemeen (Dichtheid, Minder beweging) and Eigen API as its own group right after
 * Accounts (DESIGN.md §3.4; no entry of its own in the list, which marks Accounts while it is in view). Every row has a name, at most one
 * sub-line, the control on the right, and its "Wat merk je ervan" line behind "Meer info".
 *
 * Where the twelve sections of the old screen went (also in _scratch/b6/mapping.md):
 *
 * | old section (wired)          | new place                                                   |
 * |------------------------------|-------------------------------------------------------------|
 * | appearance (yes)             | Algemeen > Thema; Uitgebreid: Algemeen > Dichtheid, Minder beweging |
 * | layout (yes)                 | dropped: the Details pane lives in the shell's own menu; per-view layouts live in those views |
 * | chat (yes, but nothing read it) | dropped: the eleven stored "preferences" were read by no other screen (the old file's own note) |
 * | connection (yes)             | Accounts > Claude row (status from the live provider list or the checkup) |
 * | models (yes, labels only)    | dropped: label switches only; real routing moved to Modellen |
 * | capabilities (yes)           | Uitgebreid: Modellen (GET /api/models) and Koppelingen (tools, connections, capabilities counts) |
 * | forge (yes, read + write)    | not rebuilt yet: still in the developer view (see LegacySettingsView) |
 * | agents (no)                  | removed (wired:false); the roster lives in Team |
 * | skills (no)                  | removed (wired:false, inert switches) |
 * | permissions (no)             | removed (wired:false); replaced by Veiligheid (real per-project choice) |
 * | privacy (yes)                | Privacy (wat staat waar, exporteren, alles wissen) |
 * | shortcuts (no)               | removed (wired:false, a list that described keys that were not bound) |
 */

import type { MessageKey } from '@/i18n';

export type GroupId =
  | 'algemeen'
  | 'accounts'
  | 'eigenapi'
  | 'veiligheid'
  | 'privacy'
  | 'modellen'
  | 'gebruik'
  | 'vaardigheden'
  | 'paden'
  | 'diagnose'
  | 'over';

export type RowId =
  | 'taal'
  | 'thema'
  | 'weergave'
  | 'rondleiding'
  | 'opstarten'
  | 'systeemvak'
  | 'dichtheid'
  | 'beweging'
  | 'accounts'
  | 'router'
  | 'eigenapi'
  | 'sloten'
  | 'modus'
  | 'map'
  | 'waar'
  | 'exporteren'
  | 'wissen'
  | 'rollen'
  | 'limiet'
  | 'vaardigheden'
  | 'paden'
  | 'diagnose'
  | 'versie'
  | 'updates'
  | 'smartscreen';

export interface RowDef {
  readonly id: RowId;
  readonly group: GroupId;
  /** Only rendered in Uitgebreid. */
  readonly advanced: boolean;
  /** Only rendered when the desktop app exposes the control (window.forge). */
  readonly needsDesktop?: 'autostart' | 'tray';
}

export interface GroupDef {
  readonly id: GroupId;
  readonly advanced: boolean;
  /** The short name in the section list and above the group (rd.settings.sections.*). */
  readonly label: MessageKey;
  /** A group that belongs to another one: no entry of its own in the section list, which marks the parent. */
  readonly parent?: GroupId;
}

export const GROUPS: readonly GroupDef[] = [
  { id: 'algemeen', advanced: false, label: 'rd.settings.sections.general' },
  { id: 'accounts', advanced: false, label: 'rd.settings.sections.accounts' },
  { id: 'eigenapi', advanced: true, label: 'rd.settings.ownApi.title', parent: 'accounts' },
  { id: 'veiligheid', advanced: false, label: 'rd.settings.sections.safety' },
  { id: 'privacy', advanced: false, label: 'rd.settings.sections.privacy' },
  { id: 'modellen', advanced: true, label: 'rd.settings.sections.models' },
  { id: 'gebruik', advanced: true, label: 'rd.settings.sections.usage' },
  { id: 'vaardigheden', advanced: true, label: 'rd.settings.sections.links' },
  { id: 'paden', advanced: true, label: 'rd.settings.sections.folders' },
  { id: 'diagnose', advanced: true, label: 'rd.settings.sections.diagnose' },
  { id: 'over', advanced: true, label: 'rd.settings.sections.about' },
];

// DESIGN.md §3.4 Algemeen: Thema, Taal, Weergave, Rondleiding opnieuw bekijken; Uitgebreid adds Dichtheid.
export const ROWS: readonly RowDef[] = [
  { id: 'thema', group: 'algemeen', advanced: false },
  { id: 'taal', group: 'algemeen', advanced: false },
  { id: 'weergave', group: 'algemeen', advanced: false },
  { id: 'rondleiding', group: 'algemeen', advanced: false },
  { id: 'opstarten', group: 'algemeen', advanced: false, needsDesktop: 'autostart' },
  { id: 'systeemvak', group: 'algemeen', advanced: false, needsDesktop: 'tray' },
  { id: 'dichtheid', group: 'algemeen', advanced: true },
  { id: 'beweging', group: 'algemeen', advanced: true },
  { id: 'accounts', group: 'accounts', advanced: false },
  // App router (APP-ROUTER-DESIGN.md §6.2): Eenvoudig, so visible to everyone, right after the accounts.
  { id: 'router', group: 'accounts', advanced: false },
  { id: 'eigenapi', group: 'eigenapi', advanced: true },
  { id: 'sloten', group: 'veiligheid', advanced: false },
  { id: 'modus', group: 'veiligheid', advanced: false },
  { id: 'map', group: 'veiligheid', advanced: false },
  { id: 'waar', group: 'privacy', advanced: false },
  { id: 'exporteren', group: 'privacy', advanced: false },
  { id: 'wissen', group: 'privacy', advanced: false },
  { id: 'rollen', group: 'modellen', advanced: true },
  { id: 'limiet', group: 'gebruik', advanced: true },
  { id: 'vaardigheden', group: 'vaardigheden', advanced: true },
  { id: 'paden', group: 'paden', advanced: true },
  { id: 'diagnose', group: 'diagnose', advanced: true },
  { id: 'versie', group: 'over', advanced: true },
  { id: 'updates', group: 'over', advanced: true },
  { id: 'smartscreen', group: 'over', advanced: true },
];

/**
 * Case- and accent-insensitive "contains"; an empty query matches everything. The page itself has no
 * search field since the v1.0 redesign (the group list replaces it); this tested helper stays in the
 * model (settings-checkup-model.test.ts) until a later search uses it or removes it.
 */
export function matchesQuery(haystack: readonly string[], query: string): boolean {
  const needle = normalize(query.trim());
  if (needle === '') return true;
  return haystack.some((text) => normalize(text).includes(needle));
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** The desktop bridge (desktop/src/preload/preload.cjs). Only optional functions are probed. */
export interface DesktopBridge {
  readonly version?: string;
  readonly autostart?: { readonly get: () => Promise<boolean>; readonly set: (on: boolean) => Promise<boolean> };
  readonly tray?: { readonly get: () => Promise<boolean>; readonly set: (on: boolean) => Promise<boolean> };
}

export function readDesktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { forge?: unknown }).forge;
  return typeof candidate === 'object' && candidate !== null ? (candidate as DesktopBridge) : null;
}

function hasToggle(value: unknown): boolean {
  const record = value as { get?: unknown; set?: unknown } | undefined;
  return typeof record?.get === 'function' && typeof record?.set === 'function';
}

/** Rows visible in this mode, with the desktop-only rows dropped when the bridge lacks them. */
export function visibleRows(advanced: boolean, bridge: DesktopBridge | null): readonly RowDef[] {
  return ROWS.filter((row) => {
    if (row.advanced && !advanced) return false;
    if (row.needsDesktop === 'autostart') return hasToggle(bridge?.autostart);
    if (row.needsDesktop === 'tray') return hasToggle(bridge?.tray);
    return true;
  });
}

export function visibleGroups(advanced: boolean): readonly GroupDef[] {
  return GROUPS.filter((group) => advanced || !group.advanced);
}

/** The entries of the section list: every group without a parent. */
export function listedGroups(groups: readonly GroupDef[]): readonly GroupDef[] {
  return groups.filter((group) => group.parent === undefined);
}

/** The list entry that stands for a group: the group itself, or its parent. */
export function listEntryOf(id: GroupId): GroupId {
  return GROUPS.find((group) => group.id === id)?.parent ?? id;
}

/* ------------------------------------------------------------ legacy view */

export const LEGACY_FLAG_KEY = 'forge.settings.legacy';

/** The old twelve-section screen, for developers only: a dev build plus an explicit flag. */
export function isLegacySettingsEnabled(): boolean {
  // Same dev-build probe as primitives/Icon.tsx (this tsconfig carries no vite/client types).
  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (!isDev) return false;
  try {
    return globalThis.localStorage?.getItem(LEGACY_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- wipe local */

/**
 * "Alles wissen", honest scope: every `forge.*` key this app keeps in this browser's storage
 * (language, view, theme, density, composer choices, onboarding flag). Conversations and jobs live
 * in the data folder on disk and are untouched; the row's copy says so. Returns the keys removed.
 */
export function wipeLocalForgeSettings(storage: Storage | undefined = globalThis.localStorage): readonly string[] {
  if (!storage) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith('forge.')) keys.push(key);
  }
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      /* A key that cannot be removed stays; the caller reloads the stores either way. */
    }
  }
  return keys;
}

/** The date the provider terms were last checked (plan §3.2, ToS notice). Update with the check. */
export const TOS_CHECKED_AT = '2026-11-01';
