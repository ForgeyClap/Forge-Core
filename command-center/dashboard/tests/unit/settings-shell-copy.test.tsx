/**
 * WP B6 — the new Settings page in a REAL production mount (PrototypeProvider + AppShell, gateway
 * fetch stubbed, English locale as every legacy suite runs). Two contracts the old twelve-section
 * screen was held to, carried over to the one-page screen:
 *   1. no forbidden copy (the shared FORBIDDEN_PATTERNS) in either view, Eenvoudig or Uitgebreid;
 *   2. Safety states the real write boundary: the folder of the chosen project, and the permission
 *      mode the composer will actually use for it (a never-chosen project starts at Full access,
 *      `views/chat/mode-storage.ts`), instead of the old "no permission-bypass" claim.
 * These are the checks that replace the stale cases in no-prototype-copy.test.ts and
 * composer-write-scope.test.tsx (see _scratch/b6/patches.md).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { collectRenderedText, scanForbidden } from './no-prototype-copy.test';
import AppShell from '@/components/shell/AppShell';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import { setUiMode } from '@/state/ui-mode';
import SettingsView from '@/views/settings/SettingsView';

const FAKE_PROJECT_ROW = { name: 'demo-project', path: 'C:\\Work\\demo-project', has_dashboard: false };

/** Same exact-string allowlist no-prototype-copy.test.ts applies to the real storage key names. */
const ALLOWED_EXACT_STRINGS = ['forge.prototype.appearance', 'forge.prototype.density', 'Focusable input example'];

function scanAllowlisted(text: string): string[] {
  let sanitized = text;
  for (const allowed of ALLOWED_EXACT_STRINGS) sanitized = sanitized.split(allowed).join('');
  return scanForbidden(sanitized);
}

async function flush(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('Settings, one page, in a real production mount (WP B6)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        const body = url.includes('/api/projects') ? { projects: [FAKE_PROJECT_ROW] } : {};
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setUiMode('eenvoudig');
  });

  it('shows no forbidden copy in either view', async () => {
    render(createElement(MemoryRouter, null, createElement(PrototypeProvider, null, createElement(AppShell, null, createElement(SettingsView)))));
    await flush();
    expect(screen.getByRole('navigation', { name: 'Groups' })).toBeInTheDocument();
    for (const mode of ['eenvoudig', 'uitgebreid'] as const) {
      act(() => setUiMode(mode));
      await flush();
      const found = scanAllowlisted(collectRenderedText(document.body));
      expect(found, `Settings/${mode} rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
    }
  });

  it('Safety states the real write boundary and the mode the composer will use', async () => {
    render(createElement(MemoryRouter, null, createElement(PrototypeProvider, null, createElement(AppShell, null, createElement(SettingsView)))));
    await flush(80);
    const text = collectRenderedText(document.body);
    expect(text).toMatch(/Forge only creates and changes files in the folder of the chosen project/);
    // Either a project is active (its mode is named) or the row asks to pick one first.
    // WP B3: an unchosen project now starts at 'accept-edits' (May edit), which the row shows as the selected
    // segment with only the project line, so that line is a third valid outcome.
    expect(text).toMatch(/Currently chosen in the composer: |Applies to the project |Pick a project first; this choice is per project\./);
    expect(text).not.toMatch(/no permission-bypass/i);
  });
});
