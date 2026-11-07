/**
 * Final round layout guards: two phone defects found in the screenshot loop at 390 px (jsdom has no layout,
 * so these read the stylesheet rules that fix them).
 *  - Onboarding step 4: Terug + Laat me rondkijken + Begin side by side were wider than the phone and pushed
 *    the whole card past the right edge. At <= 640 px the foot wraps and the main button takes its own row.
 *  - Chat route notice (Eenvoudig line): a long headline dropped below its icon, leaving the icon alone on a
 *    line. The headline is capped at the row minus the icon, so it wraps inside itself.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function clean(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declarations of one exact selector inside `scope` (comments stripped). */
function block(scope: string, selector: string): string | null {
  const re = new RegExp(`(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const match = clean(scope).match(re);
  return match ? match[2] : null;
}

/** The body of the first `@media (max-width: 640px)` block. */
function phoneMedia(css: string): string {
  const text = clean(css);
  const start = text.indexOf('@media (max-width: 640px)');
  if (start < 0) return '';
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth--;
    if (depth === 0) return text.slice(text.indexOf('{', start) + 1, i);
  }
  return '';
}

describe('final round layout guards', () => {
  it('onboarding: on a phone the foot wraps and the main button gets its own full row', () => {
    const phone = phoneMedia(readFileSync(join(SRC, 'views', 'onboarding', 'onboarding.css'), 'utf8'));
    expect(block(phone, '.fs-onb__foot')).toMatch(/flex-wrap:\s*wrap/);
    expect(block(phone, '.fs-onb__primary')).toMatch(/flex:\s*1 1 100%/);
  });

  it('route notice: the one-line headline is never wider than the row minus its icon', () => {
    const css = readFileSync(join(SRC, 'views', 'chat', 'route-notice', 'route-notice.css'), 'utf8');
    expect(block(css, '.fw-route-notice__headline')).toMatch(/max-inline-size:\s*calc\(100% - 16px - var\(--fs-space-2\)\)/);
  });
});
