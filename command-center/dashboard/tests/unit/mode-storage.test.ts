/**
 * mode-storage — WP B3 (plan §4.4): a project with no stored send-mode choice starts in
 * "Mag aanpassen" (`accept-edits`), never in bypass. A stored pre-B3 `bypass` is reset once to "not
 * chosen" (`migrateStoredBypass`), and a choice persisted after that migration is respected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BYPASS_MIGRATION_KEY,
  DEFAULT_SEND_MODE,
  confirmBypass,
  isBypassConfirmed,
  migrateStoredBypass,
  modeStorageKey,
  persist,
  readStoredMode,
} from '@/views/chat/mode-storage';

describe('readStoredMode (WP B3: accept-edits by default, never bypass)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults a brand-new project (never persisted a choice) to "accept-edits"', () => {
    expect(DEFAULT_SEND_MODE).toBe('accept-edits');
    expect(readStoredMode('p-new')).toBe('accept-edits');
    expect(readStoredMode('p-new')).not.toBe('bypass');
  });

  it('an empty/unknown project id still resolves to "execute" (there is no project to run in)', () => {
    expect(readStoredMode('')).toBe('execute');
  });

  it('a previously persisted "execute" or "plan" choice round-trips unchanged', () => {
    persist(modeStorageKey('p1'), 'execute');
    persist(modeStorageKey('p2'), 'plan');
    expect(readStoredMode('p1')).toBe('execute');
    expect(readStoredMode('p2')).toBe('plan');
  });

  it('an invalid stored value falls back to the default, never a crash', () => {
    localStorage.setItem(modeStorageKey('p1'), 'not-a-real-mode');
    expect(readStoredMode('p1')).toBe('accept-edits');
  });
});

describe('migrateStoredBypass (one-time)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('resets every stored bypass to "not chosen" and reports how many', () => {
    persist(modeStorageKey('a'), 'bypass');
    persist(modeStorageKey('b'), 'bypass');
    persist(modeStorageKey('c'), 'plan');
    expect(migrateStoredBypass()).toBe(2);
    expect(localStorage.getItem(modeStorageKey('a'))).toBeNull();
    expect(readStoredMode('a')).toBe('accept-edits');
    expect(readStoredMode('b')).toBe('accept-edits');
    expect(readStoredMode('c')).toBe('plan');
    expect(localStorage.getItem(BYPASS_MIGRATION_KEY)).toBe('1');
  });

  it('runs only once: a bypass chosen again afterwards survives, and no second toast is due', () => {
    expect(migrateStoredBypass()).toBe(0);
    persist(modeStorageKey('a'), 'bypass');
    expect(migrateStoredBypass()).toBe(0);
    expect(readStoredMode('a')).toBe('bypass');
  });

  it('touches no other storage keys', () => {
    localStorage.setItem('forge.locale', 'nl');
    localStorage.setItem('forge.prototype.chatEffort', 'bypass');
    migrateStoredBypass();
    expect(localStorage.getItem('forge.locale')).toBe('nl');
    expect(localStorage.getItem('forge.prototype.chatEffort')).toBe('bypass');
  });
});

describe('bypass confirmation per project', () => {
  beforeEach(() => localStorage.clear());

  it('is per project and never for an empty project id', () => {
    expect(isBypassConfirmed('a')).toBe(false);
    confirmBypass('a');
    expect(isBypassConfirmed('a')).toBe(true);
    expect(isBypassConfirmed('b')).toBe(false);
    confirmBypass('');
    expect(isBypassConfirmed('')).toBe(false);
  });
});
