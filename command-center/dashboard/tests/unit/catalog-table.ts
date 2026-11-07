/**
 * Test helper (not a suite): one or more catalog subtrees as a flat `{ nl, en }` table of dotted keys, so the
 * copy-quality checks that used to run on the temporary copy tables now run on the catalog itself.
 */

import en from '@/i18n/locales/en.json';
import nl from '@/i18n/locales/nl.json';

export interface CatalogTable {
  readonly nl: Readonly<Record<string, string>>;
  readonly en: Readonly<Record<string, string>>;
}

function flatten(tree: unknown, prefix: string, out: Record<string, string>): Record<string, string> {
  if (typeof tree === 'string') {
    out[prefix] = tree;
    return out;
  }
  if (tree !== null && typeof tree === 'object') {
    for (const [key, value] of Object.entries(tree as Record<string, unknown>)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const FLAT = { nl: flatten(nl, '', {}), en: flatten(en, '', {}) };

/** Every key under one of `prefixes` (a prefix matches itself and everything below it). */
export function catalogTable(...prefixes: readonly string[]): CatalogTable {
  const pick = (all: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(all).filter(([key]) => prefixes.some((p) => key === p || key.startsWith(`${p}.`))));
  const table = { nl: pick(FLAT.nl), en: pick(FLAT.en) };
  if (Object.keys(table.nl).length === 0) throw new Error(`no catalog keys under ${prefixes.join(', ')}`);
  return table;
}
