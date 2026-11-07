/**
 * POL-C guard: the screenshot gallery must show what a beginner
 * sees. tests/e2e/screenshots.spec.ts captured every desktop shot in Uitgebreid while the app opens in
 * Eenvoudig, so the gallery was misleading. This test reads the capture spec and fails when its
 * fallback mode differs from the app default (DEFAULT_UI_MODE in src/state/ui-mode.ts), or when a shot
 * name literal claims `-uitgebreid` without the Uitgebreid mode being asked for in the same test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_UI_MODE } from '@/state/ui-mode';

const SPEC = path.resolve(__dirname, '..', 'e2e', 'screenshots.spec.ts');

/** The mode the capture spec falls back to when a shot does not ask for one (`mode ?? <x>` in open()). */
function captureFallbackMode(source: string): string | null {
  const fallback = /mode\s*\?\?\s*('([a-z]+)'|([A-Za-z_$][\w$]*))/.exec(source);
  if (!fallback) return null;
  if (fallback[2]) return fallback[2];
  const name = fallback[3];
  const constant = new RegExp(`const\\s+${name}\\b[^=]*=\\s*'([a-z]+)'`).exec(source);
  return constant ? constant[1] : null;
}

describe('screenshots.spec.ts capture mode', () => {
  const source = readFileSync(SPEC, 'utf8');

  it('falls back to the app default mode, the one a beginner sees', () => {
    expect(DEFAULT_UI_MODE).toBe('eenvoudig');
    expect(captureFallbackMode(source)).toBe(DEFAULT_UI_MODE);
  });

  it('only names a shot -uitgebreid where the test asks for Uitgebreid', () => {
    // Every test(...) body that names a -uitgebreid shot must request mode 'uitgebreid'.
    const bodies = source.split(/\n\s*test\(/).slice(1);
    for (const body of bodies) {
      const namesAdvanced = /-uitgebreid|ADVANCED_SUFFIX\}/.test(body.replace(/const ADVANCED_SUFFIX[^\n]*/, ''));
      if (namesAdvanced) expect(body, body.slice(0, 80)).toMatch(/mode:\s*'uitgebreid'/);
    }
  });

  it('reads the fallback correctly from a literal and from a constant (parser self-check)', () => {
    expect(captureFallbackMode("[theme, options.mode ?? 'uitgebreid', x]")).toBe('uitgebreid');
    expect(captureFallbackMode("const M: X = 'eenvoudig';\n options.mode ?? M")).toBe('eenvoudig');
    expect(captureFallbackMode('no fallback here')).toBeNull();
  });
});
