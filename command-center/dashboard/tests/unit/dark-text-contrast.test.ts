/**
 * Text and control contrast for the v1.0 palette (redesign 2026-11-03), light and dark.
 *
 * Started as (dark small-text contrast, defects D6 + D7) on the old dark surface list. The redesign
 * replaced every surface, so this now checks the same pairs as docs/forge-systeem/redesign/tools/contrast.mjs,
 * read from the stylesheet the app actually imports (brand/forge-tokens.css), plus the two pairs the old test
 * existed for: caption text (the old text-muted / text-faint, now --fs-ink-3) on the selected row (accent-soft).
 * WCAG 2.x: 4.5:1 for text, 3:1 for non-text (focus ring, field edge, status icon).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'brand', 'forge-tokens.css'), 'utf8')
  .replace(/\r\n/g, '\n');

function theme(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {\n`);
  expect(start, `block "${selector}" missing`).toBeGreaterThan(-1);
  const body = CSS.slice(start, CSS.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--(fs-[\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

type Pair = [fg: string, bg: string, min: number, what: string];
const BG = ['fs-bg', 'fs-bg-side', 'fs-surface', 'fs-surface-2', 'fs-sunken'];
const PAIRS: Pair[] = [];
for (const fg of ['fs-ink', 'fs-ink-2', 'fs-ink-3']) for (const bg of BG) PAIRS.push([fg, bg, 4.5, 'text']);
for (const bg of ['fs-bg', 'fs-surface', 'fs-bg-side', 'fs-accent-soft']) PAIRS.push(['fs-accent-text', bg, 4.5, 'link']);
for (const bg of ['fs-accent', 'fs-accent-hover', 'fs-accent-active']) PAIRS.push(['fs-ink-on-accent', bg, 4.5, 'primary label']);
for (const fg of ['fs-ink', 'fs-ink-2', 'fs-ink-3']) PAIRS.push([fg, 'fs-accent-soft', 4.5, 'text on selected row']);
for (const s of ['ok', 'warn', 'danger', 'info']) {
  PAIRS.push([`fs-${s}`, `fs-${s}-soft`, 4.5, `${s} badge text`]);
  PAIRS.push([`fs-${s}`, 'fs-surface', 4.5, `${s} text on surface`]);
  PAIRS.push([`fs-${s}`, 'fs-bg', 3, `${s} icon (1.4.11)`]);
}
for (const bg of ['fs-bg', 'fs-surface', 'fs-bg-side']) PAIRS.push(['fs-accent', bg, 3, 'focus ring (1.4.11)']);
for (const bg of ['fs-surface', 'fs-bg']) PAIRS.push(['fs-line-strong', bg, 3, 'field edge (1.4.11)']);

const THEMES = { light: ':root, [data-theme="light"]', dark: '[data-theme="dark"]' };

describe('v1.0 palette contrast (WCAG 2.x), light and dark', () => {
  for (const [name, selector] of Object.entries(THEMES)) {
    for (const [fg, bg, min, what] of PAIRS) {
      it(`${name}: ${fg} on ${bg} >= ${min}:1 (${what})`, () => {
        const t = theme(selector);
        expect(t[fg], `${fg} missing in ${name}`).toMatch(/^#/);
        expect(t[bg], `${bg} missing in ${name}`).toMatch(/^#/);
        const r = ratio(t[fg], t[bg]);
        expect(r, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
