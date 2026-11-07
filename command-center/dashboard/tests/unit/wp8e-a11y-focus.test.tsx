/**
 * dashboard accessibility defects D1-D5 from ui-verify-3
 * (.claude/forge-research/overhaul-2026-10-09/ui-verify-3/results.json).
 *
 * D1/D2 (WCAG 2.4.7): a component rule's own `box-shadow` tied with — and, loading later, beat —
 *   the global `:focus-visible` ring, so the element showed no focus. jsdom has no cascade or
 *   `:focus-visible`, so these assert the stylesheet itself: a `:focus-visible` rule exists for the
 *   exact selector, it composes the SAME ring token with the element's existing elevation token,
 *   and it comes AFTER (or out-specifies) the rule that used to win.
 * D3 (WCAG 2.4.11): the sidebar scroller reserves the usage pill's footprint as scroll-padding, so
 *   focus-scrolling keeps a focused control clear of the fixed pill (main already did).
 * D4: Escape closing the account menu returns focus to its trigger.
 * D5: Tab moving focus out of the account menu closes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Bar from '@/components/shell/Bar';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';

const SRC = resolve(__dirname, '../../src');
const css = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
  readonly index: number;
}

/** Top-level rules only (media blocks are skipped as a whole) — enough for these flat sheets. */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const head = m[1].trim();
    if (head.startsWith('@')) continue;
    out.push({ selectors: head.split(',').map((s) => s.trim()), body: m[2], index: m.index });
  }
  return out;
}

function findRule(text: string, selector: string): Rule | undefined {
  return rules(text).find((r) => r.selectors.includes(selector));
}

function boxShadow(rule: Rule | undefined): string {
  const m = rule?.body.match(/box-shadow:\s*([^;]+);/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

describe('D1 — Mission Control graph node keeps a visible focus ring', () => {
  const sheet = css('views/mission/mission.css');

  it('has a :focus-visible rule composing the ring token with the node elevation', () => {
    const focus = findRule(sheet, '.fw-graph-node:focus-visible');
    expect(focus, '.fw-graph-node:focus-visible rule').toBeDefined();
    expect(boxShadow(focus)).toBe('var(--fs-focus), var(--fs-shadow-1)');
  });

  it('the focus rule follows both shadow rules it ties with (cascade order)', () => {
    const focus = findRule(sheet, '.fw-graph-node:focus-visible');
    const base = findRule(sheet, '.fw-graph-node');
    const selected = findRule(sheet, '.fw-graph-node.is-selected');
    expect(focus && base && selected).toBeTruthy();
    expect(focus!.index).toBeGreaterThan(base!.index);
    expect(focus!.index).toBeGreaterThan(selected!.index);
  });

  it('a selected node keeps its larger elevation under the ring', () => {
    const selFocus = findRule(sheet, '.fw-graph-node.is-selected:focus-visible');
    expect(boxShadow(selFocus)).toBe('var(--fs-focus), var(--fs-shadow-2)');
  });
});

describe('D2 — selected mind-map chip keeps a visible focus ring', () => {
  const sheet = css('views/mindmap/mindmap.css');

  it('has a current-chip :focus-visible rule after the current-chip rule', () => {
    const current = findRule(sheet, ".fw-mm-list__item[aria-current='true']");
    const focus = findRule(sheet, ".fw-mm-list__item[aria-current='true']:focus-visible");
    expect(current).toBeDefined();
    expect(focus, 'current-chip :focus-visible rule').toBeDefined();
    expect(focus!.index).toBeGreaterThan(current!.index);
    expect(boxShadow(focus)).toBe('var(--fs-focus), var(--fs-shadow-1)');
  });
});

describe('D3 — nothing floats over the sidebar or main any more (redesign 1C)', () => {
  // The corner usage pill, which needed a measured scroll reserve, left the chrome: the usage line now
  // sits in the composer's own flow. No shell rule may still reserve space for it.
  it('the shell grid and the sidebar keep no usage-pill reserve', () => {
    for (const sheet of [css('components/shell/app-shell.css'), css('components/shell/sidebar.css')]) {
      expect(sheet).not.toMatch(/--fw-acct-usage/);
    }
  });
});

describe('D4/D5 — bar menu focus management (the ? menu, redesign 1C)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderBar() {
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/tests'] },
        createElement(
          PrototypeProvider,
          null,
          createElement('div', null, createElement(Bar), createElement('button', { type: 'button' }, 'Outside')),
        ),
      ),
    );
    const trigger = screen.getByRole('button', { name: 'Help' });
    act(() => {
      trigger.focus();
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('menu', { name: 'Help' });
    return { trigger, dialog };
  }

  it('opens with focus inside the menu', () => {
    const { trigger, dialog } = renderBar();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('D4: Escape closes the menu and returns focus to the trigger', () => {
    const { trigger } = renderBar();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Help' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('D5: focus leaving the menu (Tab out) closes it without stealing focus back', () => {
    const { trigger } = renderBar();
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => {
      outside.focus();
    });
    expect(screen.queryByRole('menu', { name: 'Help' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(outside);
  });

  it('WP-8f: clicking the trigger while open closes it and it stays closed', () => {
    const { trigger } = renderBar();
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu', { name: 'Help' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('D5: moving focus between controls INSIDE the menu keeps it open', () => {
    const { dialog } = renderBar();
    const inner = dialog.querySelectorAll<HTMLElement>('button');
    expect(inner.length).toBeGreaterThan(1);
    act(() => {
      inner[inner.length - 1].focus();
    });
    expect(screen.getByRole('menu', { name: 'Help' })).toBeTruthy();
  });
});
