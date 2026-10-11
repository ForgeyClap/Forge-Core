/**
 * dark-theme small-text contrast, defects D6 + D7.
 *
 * ui-verify-3 measured the dark `--forge-color-text-faint` (#5A6672) at 2.46-3.58:1 and
 * `--forge-color-text-muted` (#7C8894) at 3.99-4.49:1 on the dark surfaces they are rendered on,
 * at 11-13 px. WCAG 1.4.3 needs 4.5:1 for text that size. This test computes the WCAG ratio for
 * every (token, surface) pair from that audit and fails if any drops below 4.5:1.
 *
 * Both definitions of the dark values are checked, and must agree: the source `brand/tokens.json`
 * and the stylesheet the app actually imports, `brand/forge-tokens.css`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BRAND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'brand');

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Dark surfaces each token is rendered on (ui-verify-3 before-wp8e/results.json contrastPairs). */
const SURFACES: Record<string, string> = {
  'selected row (#262A2E composite)': '#262A2E',
  'surface-3 / raised': '#1B2127',
  'surface-2': '#151A1F',
  'surface-1': '#101418',
  bg: '#0B0E11',
  canvas: '#06080A',
  sunken: '#000000',
};

const TOKENS = ['text-faint', 'text-muted'] as const;

function darkFromCss(name: string): string {
  const css = readFileSync(join(BRAND, 'forge-tokens.css'), 'utf8');
  const start = css.indexOf(':root, [data-theme="dark"] {');
  expect(start, 'dark block missing in forge-tokens.css').toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('}', start));
  const match = block.match(new RegExp(`--forge-color-${name}:\\s*(#[0-9A-Fa-f]{6});`));
  expect(match, `--forge-color-${name} missing in the dark block`).not.toBeNull();
  return (match as RegExpMatchArray)[1].toUpperCase();
}

function darkFromJson(name: string): string {
  const source = JSON.parse(readFileSync(join(BRAND, 'tokens.json'), 'utf8'));
  let value: string = source.modes.dark.color[name];
  const alias = /^\{palette\.([a-z]+)\.([0-9]+)\}$/.exec(value);
  if (alias) value = source.palette[alias[1]][alias[2]];
  return value.toUpperCase();
}

describe('dark theme small text reaches WCAG AA 4.5:1 (D6, D7)', () => {
  it('finds both token sources', () => {
    expect(existsSync(join(BRAND, 'forge-tokens.css'))).toBe(true);
    expect(existsSync(join(BRAND, 'tokens.json'))).toBe(true);
  });

  for (const token of TOKENS) {
    it(`${token}: tokens.json and forge-tokens.css define the same dark value`, () => {
      expect(darkFromCss(token)).toBe(darkFromJson(token));
    });

    for (const [surface, bg] of Object.entries(SURFACES)) {
      it(`${token} on ${surface} ${bg} >= 4.5:1`, () => {
        const fg = darkFromCss(token);
        const ratio = contrast(fg, bg);
        expect(ratio, `${token} ${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
