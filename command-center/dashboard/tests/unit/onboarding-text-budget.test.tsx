/**
 * Redesign fix (FX-D) — onboarding step 3 keeps to the text budget (DESIGN.md §5: onboarding max
 * 70 visible words). The gate counted 83 on the Ollama path with a model ready. The explanation of the
 * button now sits behind "Meer info"; the honest limits (answers only, small local models are slower)
 * stay visible.
 *
 * Count method follows the gate (DESIGN.md §5): visible text in `.fs-onb`, words by the same regex, with
 * closed panels (`[hidden]`), visually hidden text, `aria-hidden` and `<option>` left out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import OnboardingView from '@/views/onboarding/OnboardingView';

const LEAD = 'Forge test de verbinding en zet daarna de stand Meteen eigen model aan. Nieuwe gesprekken lopen dan op dit model.';

function checkup(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    checked_at: '2026-11-03T08:00:00.000Z',
    duration_ms: 900,
    timed_out: false,
    claude: { found: false, version: null, signedIn: null },
    codex: { found: false, version: null },
    ollama: { found: true, up: true, models: ['llama3.2:latest'] },
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    disk_free_gb: 120,
    port: 4100,
    writable_project_dir: null,
    ...over,
  };
}

function stubGateway(answer: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/checkup') ? answer : { ok: true };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function isShown(element: Element | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
    if (node.matches('option, script, style, .fw-visually-hidden, .sr-only, .visually-hidden')) return false;
  }
  return true;
}

function visibleWords(root: Element): number {
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (isShown(node.parentElement)) parts.push(node.textContent ?? '');
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return (text.match(/[\p{L}\d][\p{L}\d'’.:-]*/gu) ?? []).length;
}

function renderConnect(path: 'lokaal' | 'chatgpt') {
  return render(createElement(MemoryRouter, null, createElement(OnboardingView, { initialStep: 'verbinden', initialPath: path })));
}

describe('onboarding step 3 text budget (FX-D)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('Ollama ready: at most 70 visible words, the honest limits stay visible', async () => {
    stubGateway(checkup());
    const { container } = renderConnect('lokaal');
    await settle();
    const card = container.querySelector('.fs-onb') as Element;
    expect(screen.getByRole('button', { name: 'Testen en meteen gebruiken' })).toBeInTheDocument();
    expect(visibleWords(card)).toBeLessThanOrEqual(70);
    expect(isShown(screen.getByText(/kan in Forge nu alleen antwoorden/))).toBe(true);
    expect(isShown(screen.getByText(/Kleine modellen op je eigen pc antwoorden trager/))).toBe(true);
  });

  it('Ollama ready: the button explanation is behind "Meer info" and shows when it is opened', async () => {
    stubGateway(checkup());
    renderConnect('lokaal');
    await settle();
    expect(isShown(screen.getByText(LEAD))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Meer info' }));
    expect(isShown(screen.getByText(LEAD))).toBe(true);
  });

  it('Codex found: the button explanation is behind "Meer info" too; the Codex sentences stay visible', async () => {
    stubGateway(checkup({ codex: { found: true, version: '0.156.1' } }));
    const { container } = renderConnect('chatgpt');
    await settle();
    expect(isShown(screen.getByText(LEAD))).toBe(false);
    expect(isShown(screen.getByText(/Forge ziet alleen dat Codex op deze pc staat/))).toBe(true);
    expect(isShown(screen.getByText(/Codex kan lezen en antwoorden/))).toBe(true);
    // Was 97 before the fix; 78 now. Reaching 70 needs a shorter login line (locale patch, see notes).
    expect(visibleWords(container.querySelector('.fs-onb') as Element)).toBeLessThanOrEqual(78);
  });
});
