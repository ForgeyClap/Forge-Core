/**
 * Redesign fix round 1 (FIX-A, item 4): checkup.css used to redefine --fs-ok / --fs-warn / --fs-fail and
 * their soft variants with old v0.1 hex and rgba inside .fs-set / .fs-onb / .fs-checkup. That shadowed the
 * v1.0 tokens (brand/forge-tokens.css) on the Settings, onboarding and checkup screens, so those screens
 * kept the old palette in both themes. The status colours must come from the theme alone.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const STATUS_DECLARATION = /--fs-(ok|warn|fail|danger)(-soft)?\s*:/g;

describe('checkup.css takes its status colours from the v1.0 theme', () => {
  const css = stripComments(readFileSync(join(ROOT, 'src/components/checkup/checkup.css'), 'utf8'));

  it('declares no local --fs-ok / --fs-warn / --fs-danger (or soft) override', () => {
    expect(css.match(STATUS_DECLARATION) ?? []).toEqual([]);
  });

  it('holds no raw colour at all (hex or rgb/rgba)', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
  });

  it('still uses the status tokens, so the theme (not a fallback) colours the checkup', () => {
    expect(css).toMatch(/var\(--fs-ok\)/);
    expect(css).toMatch(/var\(--fs-danger\)/);
  });

  it('every status token it reads is defined by the v1.0 theme (the alias bridge is gone since wave 4)', () => {
    const tokens = stripComments(readFileSync(join(ROOT, 'brand/forge-tokens.css'), 'utf8'));
    const used = new Set([...css.matchAll(/var\((--fs-(?:ok|warn|fail|danger)(?:-soft)?)\)/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !new RegExp(`${name}\\s*:`).test(tokens));
    expect(missing).toEqual([]);
  });
});
