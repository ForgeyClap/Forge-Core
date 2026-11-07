/**
 * Final review finding 5: the Dutch copy uses plain punctuation (a full stop, a colon or a comma), not the
 * em dash. Walks every string in nl.json, so a new em dash fails here instead of in a review.
 */

import { describe, expect, it } from 'vitest';

import nl from '@/i18n/locales/nl.json';

function strings(node: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> {
  if (typeof node === 'string') out.push([path, node]);
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) strings(value, path ? `${path}.${key}` : key, out);
  }
  return out;
}

describe('nl.json punctuation (final review finding 5)', () => {
  it('no Dutch string contains an em dash', () => {
    const withDash = strings(nl, '', []).filter(([, text]) => text.includes('\u2014')).map(([path]) => path);
    expect(withDash).toEqual([]);
  });
});
