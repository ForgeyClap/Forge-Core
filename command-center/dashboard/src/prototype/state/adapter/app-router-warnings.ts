/**
 * app-router-warnings — the `warnings` array of `GET /api/app-router` (Q5-EIGEN-API-UI).
 *
 * A chain entry that names an own API ("Eigen API") which was removed or switched off is no longer an error:
 * the gateway reads the chain as STORED and the turn router skips that step. It says so in
 *   warnings: [{path: 'entries[<i>].provider', code: 'provider_unavailable', nl, en, entry_id, provider}]
 * Missing = []. Only named fields are copied; texts are cut to a readable length.
 */

import { pickArray, pickString } from '@/prototype/state/gateway-client';

export interface RouterWarning {
  readonly path: string;
  readonly code: string;
  readonly nl: string;
  readonly en: string;
  /** The chain entry the warning is about (from `entry_id`, else from the `entries[<i>]` path). */
  readonly entryId: string;
  readonly provider: string | null;
}

const PATH_INDEX_RE = /^entries\[(\d+)\]/;

/** The config's entries index for index as sent (a non-object stays in place as {}), so `entries[<i>]` paths match. */
export function rawEntryRecords(rawConfig: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  const list = rawConfig ? rawConfig.entries : null;
  if (!Array.isArray(list)) return [];
  return list.map((item) => (typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {}));
}


/** `rawEntries` = the config's entries exactly as the gateway sent them (the path index points into those). */
export function parseRouterWarnings(data: Record<string, unknown>, rawEntries: readonly Record<string, unknown>[]): readonly RouterWarning[] {
  return pickArray(data, ['warnings']).flatMap((raw) => {
    const code = pickString(raw, ['code']);
    const path = pickString(raw, ['path']) ?? '';
    if (code === null) return [];
    const index = PATH_INDEX_RE.exec(path);
    const fromPath = index ? rawEntries[Number(index[1])] : undefined;
    const entryId = pickString(raw, ['entry_id']) ?? (fromPath ? pickString(fromPath, ['id']) : null);
    // Every warning of this kind is about one chain step; one that names none has nowhere to be shown.
    if (entryId === null) return [];
    return [
      {
        path,
        code,
        nl: (pickString(raw, ['nl']) ?? '').slice(0, 240),
        en: (pickString(raw, ['en']) ?? '').slice(0, 240),
        entryId,
        provider: pickString(raw, ['provider']),
      },
    ];
  });
}

/** After a save: keep a warning only while its entry is still there and still names the same provider. */
export function keepWarnings(
  warnings: readonly RouterWarning[],
  entries: readonly { readonly id: string; readonly provider?: string }[],
): readonly RouterWarning[] {
  return warnings.filter((warning) => entries.some((entry) => entry.id === warning.entryId && (warning.provider === null || entry.provider === warning.provider)));
}
