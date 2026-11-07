/**
 * Redesign, part 3D: the theme showcase (/theme) shows the v1.0 tokens. Every --fs-* name it
 * draws exists in brand/forge-tokens.css, it names no old --forge-* token, holds no raw colour and no
 * ALL-CAPS label, and mono stays on machine text.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import ThemeShowcaseView from '@/views/theme/ThemeShowcaseView';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { StoreValue } from '@/prototype/state/prototype-store';
import { createInitialState } from '@/prototype/state/shell-effects';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const VIEW = read('src/views/theme/ThemeShowcaseView.tsx');
const CSS = read('src/views/theme/theme-showcase.css');
const TOKENS = read('brand/forge-tokens.css');

afterEach(() => cleanup());

function mount() {
  const dispatch = vi.fn();
  const value: StoreValue = { state: createInitialState(EMPTY_DATASET), dispatch };
  render(createElement(PrototypeContext.Provider, { value }, createElement(ThemeShowcaseView)));
  return { dispatch };
}

describe('theme showcase shows the v1.0 tokens', () => {
  it('every --fs-* name it uses is defined in forge-tokens.css', () => {
    const used = new Set<string>();
    for (const text of [VIEW, CSS]) {
      for (const match of text.matchAll(/--fs-[a-z0-9-]*[a-z0-9]/g)) used.add(match[0]);
    }
    // Names built at runtime from a list (`--fs-space-${step}`, `--fs-radius-${radius}`).
    for (const step of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) used.add(`--fs-space-${step}`);
    for (const radius of ['xs', 'sm', 'md', 'lg', 'pill', 'struck']) used.add(`--fs-radius-${radius}`);
    for (const prefix of ['--fs-space', '--fs-radius']) used.delete(prefix);
    const missing = [...used].filter((name) => !TOKENS.includes(`${name}:`));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });

  it('names no old --forge-* token, holds no raw colour, no caps and no transition: all', () => {
    for (const text of [VIEW, CSS]) {
      expect(text).not.toMatch(/--forge-/);
      expect(text).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
      expect(text).not.toMatch(/rgb\(/);
      expect(text).not.toMatch(/text-transform:\s*uppercase/);
      expect(text).not.toMatch(/transition:\s*all/);
    }
    expect(VIEW).not.toMatch(/Eyebrow|Machine/);
  });

  it('renders one h1, plain sections and the brand swatch names; the theme switch dispatches', () => {
    const { dispatch } = mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const name of ['Mark', 'Colour', 'Type', 'Space, radius and depth', 'Controls and status', 'Motion']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    for (const swatch of ['Mist', 'Pauw', 'Smeedzwart', 'Gloei']) expect(screen.getByText(swatch)).toBeInTheDocument();
    screen.getByRole('radio', { name: 'Dark' }).click();
    expect(dispatch).toHaveBeenCalledWith({ type: 'appearance/set', appearance: 'dark' });
  });

  it('no visible label is written in capitals', () => {
    mount();
    const words = (document.body.textContent ?? '').match(/\b[A-Z]{4,}\b/g) ?? [];
    expect(words).toEqual([]);
  });
});

/** The CSS block for one selector at the start of a line (first match), or '' when it is absent. */
function rule(css: string, selector: string): string {
  const text = css.replace(/\r\n/g, '\n');
  const start = text.indexOf(`\n${selector} {`);
  return start < 0 ? '' : text.slice(start, text.indexOf('}', start));
}

describe('W3FX-D: the /theme header matches the other Uitgebreid routes (Activiteit, Controles)', () => {
  const ACTIVITY = read('src/views/activity/activity.css');

  it('the page is not a centred column: header and sections start at the route gutter, left-aligned', () => {
    const { container } = render(
      createElement(PrototypeContext.Provider, { value: { state: createInitialState(EMPTY_DATASET), dispatch: vi.fn() } }, createElement(ThemeShowcaseView)),
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.querySelector(':scope > header h1')).not.toBeNull();
    expect(root.querySelectorAll(':scope > section').length).toBeGreaterThan(5);
    expect(rule(CSS, '.fs-theme')).not.toContain('margin: 0 auto');
    expect(rule(CSS, '.fs-theme__section')).toContain('margin-inline: var(--fw-gutter);');
  });

  it('header frame, title and lede use the same values as the route headers', () => {
    const head = rule(CSS, '.fs-theme__head');
    expect(head).toContain('padding: var(--fw-gutter);');
    expect(head).toContain('padding-block-end: var(--fw-gutter-tight);');
    for (const decl of ['font-size: calc(var(--fs-text-13) * 2);', 'font-weight: 400;', 'font-stretch: 92%;']) {
      expect(rule(ACTIVITY, '.fw-activity__h1')).toContain(decl);
      expect(rule(CSS, '.fs-theme__title')).toContain(decl);
    }
    for (const decl of ['font-size: var(--fs-text-14);', 'color: var(--fs-ink-3);']) {
      expect(rule(ACTIVITY, '.fw-activity__lede')).toContain(decl);
      expect(rule(CSS, '.fs-theme__lede')).toContain(decl);
    }
  });
});
