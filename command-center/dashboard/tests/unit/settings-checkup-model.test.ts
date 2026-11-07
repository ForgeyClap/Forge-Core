/**
 * WP B6 — the pure rules behind "Controleer of alles werkt" and the account cards: parsing the
 * checkup answer, one row per check with one fix, no port row in Eenvoudig, the redaction of the
 * diagnosis text, and the one status word per account.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCheckRows,
  buildDiagnosisText,
  formatGb,
  parseCheckup,
  redactDiagnosis,
} from '@/components/checkup/checkup-model';
import type { CheckupResult } from '@/components/checkup/checkup-model';
import { buildAccountCards } from '@/views/settings/sections/accounts-model';
import { EMPTY_GATEWAY_MODELS } from '@/prototype/state/gateway-capabilities';
import { listEntryOf, listedGroups, matchesQuery, visibleGroups, visibleRows, wipeLocalForgeSettings } from '@/views/settings/settings-model';

const FULL = {
  ok: true,
  checked_at: '2026-11-01T21:16:59.882Z',
  duration_ms: 1840,
  timed_out: false,
  claude: { found: true, version: '2.1.316', signedIn: true },
  codex: { found: true, version: '0.156.1' },
  ollama: { found: true, up: true, models: ['qwen2.5:0.5b'] },
  node: { version: '24.18.0' },
  git: { found: true, version: '2.54.0' },
  disk_free_gb: 202.1,
  port: 4100,
  writable_project_dir: true,
};

function parsed(overrides: Record<string, unknown> = {}): CheckupResult {
  return parseCheckup({ ...FULL, ...overrides });
}

describe('parseCheckup', () => {
  it('maps the route 1:1', () => {
    const result = parsed();
    expect(result.claude).toEqual({ found: true, version: '2.1.316', signedIn: true });
    expect(result.ollama.models).toEqual(['qwen2.5:0.5b']);
    expect(result.diskFreeGb).toBe(202.1);
    expect(result.port).toBe(4100);
  });

  it('turns a missing answer into not-found / unknown, never a yes', () => {
    const result = parseCheckup({ ok: true });
    expect(result.claude).toEqual({ found: false, version: null, signedIn: null });
    expect(result.ollama).toEqual({ found: false, up: false, models: [] });
    expect(result.diskFreeGb).toBeNull();
    expect(result.writableProjectDir).toBeNull();
  });
});

describe('buildCheckRows', () => {
  it('has one row per check, the port only when asked (Uitgebreid)', () => {
    const simple = buildCheckRows(parsed(), { showPort: false, locale: 'nl' }).map((row) => row.id);
    expect(simple).toEqual(['claude', 'signedIn', 'codex', 'ollama', 'node', 'git', 'disk', 'folder']);
    const advanced = buildCheckRows(parsed(), { showPort: true, locale: 'nl' }).map((row) => row.id);
    expect(advanced).toContain('port');
  });

  it('gives a failing check exactly one fix', () => {
    const rows = buildCheckRows(
      parsed({ claude: { found: true, version: '2.1.316', signedIn: false }, ollama: { found: true, up: false, models: [] }, disk_free_gb: 2.5, writable_project_dir: false }),
      { showPort: false, locale: 'nl' },
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.signedIn).toMatchObject({ state: 'fail', fix: 'login' });
    expect(byId.ollama).toMatchObject({ state: 'fail', fix: 'startOllama', message: 'stopped' });
    expect(byId.disk).toMatchObject({ state: 'fail', fix: 'freeDisk', vars: { gb: '2,5' } });
    expect(byId.folder).toMatchObject({ state: 'fail', fix: 'chooseFolder' });
  });

  it('marks tools that only one path needs as optional, not failed', () => {
    const rows = buildCheckRows(
      parsed({ codex: { found: false, version: null }, ollama: { found: false, up: false, models: [] }, git: { found: false, version: null } }),
      { showPort: false, locale: 'nl' },
    );
    for (const id of ['codex', 'ollama', 'git']) expect(rows.find((row) => row.id === id)?.state).toBe('optional');
  });

  it('shows Claude Code missing with an install fix and no sign-in row', () => {
    const rows = buildCheckRows(parsed({ claude: { found: false, version: null, signedIn: null } }), { showPort: false, locale: 'nl' });
    expect(rows[0]).toMatchObject({ id: 'claude', state: 'fail', fix: 'installClaude' });
    expect(rows.some((row) => row.id === 'signedIn')).toBe(false);
  });

  it('formats free space in the reader’s locale', () => {
    expect(formatGb(202.14, 'nl')).toBe('202,1');
    expect(formatGb(202.14, 'en')).toBe('202.1');
  });
});

describe('diagnosis text', () => {
  it('removes user names in paths, e-mail addresses and key-shaped strings', () => {
    const text = redactDiagnosis('map C:\\Users\\YOU\\Documents en /home/anna/x, mail a.b@example.com, sk-ant-abcdefgh12345678');
    expect(text).not.toMatch(/Faitz|anna|a\.b@example\.com|sk-ant-abcdefgh/);
    expect(text).toContain('C:\\Users\\<gebruiker>\\Documents');
    expect(text).toContain('<e-mailadres>');
    expect(text).toContain('<sleutel weggehaald>');
  });

  it('builds a short redacted report from the rows', () => {
    const result = parsed();
    const rows = buildCheckRows(result, { showPort: true, locale: 'nl' });
    const text = buildDiagnosisText(result, rows, (row) => `${row.id}`, { pad: 'C:\\Users\\YOU\\x' });
    expect(text).toContain('[ok] claude');
    expect(text).toContain('pad: C:\\Users\\<gebruiker>\\x');
    expect(text).not.toContain('Faitz');
  });
});

describe('account cards', () => {
  it('says Controleren… while the checkup runs, never a guess', () => {
    const cards = buildAccountCards({ checkup: null, checkupRunning: true, claudeAvailable: null, models: null });
    expect(cards.map((card) => card.status)).toEqual(['checking', 'checking', 'checking']);
  });

  it('derives one word per account from the checkup', () => {
    const cards = buildAccountCards({ checkup: parsed(), checkupRunning: false, claudeAvailable: true, models: EMPTY_GATEWAY_MODELS });
    expect(Object.fromEntries(cards.map((card) => [card.id, card.status]))).toEqual({
      claude: 'connected',
      chatgpt: 'found',
      ollama: 'running',
    });
    expect(cards.find((card) => card.id === 'ollama')?.modelCount).toBe(1);
  });

  it('separates signed out, missing and stopped', () => {
    const cards = buildAccountCards({
      checkup: parsed({ claude: { found: true, version: null, signedIn: false }, codex: { found: false }, ollama: { found: true, up: false, models: [] } }),
      checkupRunning: false,
      claudeAvailable: true,
      models: null,
    });
    expect(cards.map((card) => card.status)).toEqual(['signedOut', 'missing', 'stopped']);
  });

  it('adds the NVIDIA card only when the gateway reports a probe for it', () => {
    const models = { ...EMPTY_GATEWAY_MODELS, nvidia: { state: 'OK', models: 12, ms: 300, baseUrl: null, ageMs: 0, note: null } };
    const cards = buildAccountCards({ checkup: parsed(), checkupRunning: false, claudeAvailable: true, models });
    expect(cards.at(-1)).toMatchObject({ id: 'nvidia', status: 'connected' });
  });
});

describe('settings model', () => {
  it('Eenvoudig has exactly the four groups; Uitgebreid adds six to the list, plus Eigen API as its own group', () => {
    expect(visibleGroups(false).map((group) => group.id)).toEqual(['algemeen', 'accounts', 'veiligheid', 'privacy']);
    expect(listedGroups(visibleGroups(true))).toHaveLength(10);
    // Fix round XR-SET (DESIGN.md §3.4): Eigen API is its own group right after Accounts, without a list entry.
    expect(visibleGroups(true).map((group) => group.id).slice(0, 3)).toEqual(['algemeen', 'accounts', 'eigenapi']);
    expect(listedGroups(visibleGroups(true)).some((group) => group.id === 'eigenapi')).toBe(false);
    expect(listEntryOf('eigenapi')).toBe('accounts');
    expect(listEntryOf('privacy')).toBe('privacy');
  });

  it('drops the desktop-only rows when the app does not offer them', () => {
    expect(visibleRows(false, null).some((row) => row.id === 'opstarten' || row.id === 'systeemvak')).toBe(false);
    const bridge = {
      autostart: { get: async () => false, set: async (on: boolean) => on },
      tray: { get: async () => true, set: async (on: boolean) => on },
    };
    const ids = visibleRows(false, bridge).map((row) => row.id);
    expect(ids).toContain('opstarten');
    expect(ids).toContain('systeemvak');
  });

  it('search ignores case and accents', () => {
    expect(matchesQuery(['Privé chatten'], 'prive')).toBe(true);
    expect(matchesQuery(['Thema'], 'THEM')).toBe(true);
    expect(matchesQuery(['Thema'], 'taal')).toBe(false);
    expect(matchesQuery(['Thema'], '   ')).toBe(true);
  });

  it('wipes only forge.* keys', () => {
    localStorage.setItem('forge.locale', 'en');
    localStorage.setItem('forge.uiMode', 'uitgebreid');
    localStorage.setItem('someone-else', 'keep');
    const removed = wipeLocalForgeSettings();
    expect(removed).toEqual(expect.arrayContaining(['forge.locale', 'forge.uiMode']));
    expect(localStorage.getItem('someone-else')).toBe('keep');
    localStorage.removeItem('someone-else');
    localStorage.setItem('forge.locale', 'en');
  });
});
