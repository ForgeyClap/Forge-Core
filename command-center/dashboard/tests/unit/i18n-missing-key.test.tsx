/**
 * Redesign (4B): the catalog is the only source of copy.
 *
 * The temporary in-code copy tables (xr-copy, rd-pending, rd-copy, chat-pending, files-copy, map-copy,
 * inspector-copy, shell-w4-copy and the status-word fallback) read the catalog first and silently fell back
 * to their own text when a key was missing. They are gone. A key that is not in the catalog now shows as
 * the raw key on screen, so a gap is visible instead of hidden behind a second copy of the text.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusBadge } from '@/components/primitives';
import { statusPresentation } from '@/components/primitives/status-presentation';
import { getLocale, setLocale, translate } from '@/i18n';
import type { Locale, MessageKey } from '@/i18n';
import en from '@/i18n/locales/en.json';
import nl from '@/i18n/locales/nl.json';

type Branch = Record<string, unknown>;

/** Removes one leaf from both catalogs for the length of `body`, then puts it back. */
function withoutKey(key: string, body: () => void): void {
  const parts = key.split('.');
  const leaf = parts.pop() as string;
  const saved: { node: Branch; value: unknown }[] = [];
  for (const catalog of [nl, en] as unknown as Branch[]) {
    const node = parts.reduce<Branch>((branch, part) => branch[part] as Branch, catalog);
    saved.push({ node, value: node[leaf] });
    delete node[leaf];
  }
  try {
    body();
  } finally {
    for (const { node, value } of saved) node[leaf] = value;
  }
}

let startLocale: Locale;
beforeEach(() => {
  startLocale = getLocale();
  act(() => setLocale('nl'));
});
afterEach(() => {
  cleanup();
  act(() => setLocale(startLocale));
});

describe('a key that is not in the catalog is visible', () => {
  it('translate returns the raw key in both languages', () => {
    const key = 'rd.doesNotExist.anywhere' as MessageKey;
    expect(translate('nl', key)).toBe(key);
    expect(translate('en', key)).toBe(key);
  });

  it('a deleted status word renders as its raw key, never as a stored Dutch or English word', () => {
    withoutKey('rd.statusWord.running', () => {
      expect(statusPresentation('running', 'nl').label).toBe('rd.statusWord.running');
      expect(statusPresentation('running', 'en').label).toBe('rd.statusWord.running');
      render(<StatusBadge status="running" />);
      expect(screen.getByText('rd.statusWord.running')).toBeInTheDocument();
      expect(screen.queryByText('Bezig')).toBeNull();
    });
    expect(statusPresentation('running', 'nl').label).toBe('Bezig');
  });

  it('a deleted key from a former copy table renders as its raw key', () => {
    withoutKey('rd.agents.live.chipRunning', () => {
      expect(translate('nl', 'rd.agents.live.chipRunning', { label: 'x', running: 1, count: 2 })).toBe('rd.agents.live.chipRunning');
    });
  });
});

/* ------------------------------------------------------------------------- no second copy of the text */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** A line that maps a dotted catalog key to literal text: `'rd.files.recent': 'Recent',`. */
const COPY_ENTRY = /^\s*['"][a-z][A-Za-z0-9]*\.[A-Za-z0-9_.-]+['"]\s*:\s*['"`]/;

function copyTableFindings(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => (COPY_ENTRY.test(line) ? [`${relative(SRC, file)}:${index + 1}`] : [])),
  );
}

describe('the catalog is the only copy source', () => {
  it('no source file keeps its own table of catalog keys and texts', () => {
    expect(copyTableFindings(sourceFiles(SRC))).toEqual([]);
  });

  it('the detector itself catches a copy-table line', () => {
    expect(COPY_ENTRY.test("  'rd.files.recent': 'Recent',")).toBe(true);
    expect(COPY_ENTRY.test('  "rd.palette.label": "Opdrachten",')).toBe(true);
    expect(COPY_ENTRY.test("  label: t('rd.files.recent'),")).toBe(false);
  });
});
