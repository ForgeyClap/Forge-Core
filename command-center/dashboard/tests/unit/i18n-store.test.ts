/**
 * WP B0b — the i18n store and the two locale files.
 *
 * Proves: Dutch is the default, a stored choice is honoured and persisted, an unknown stored value
 * falls back to Dutch, `{name}` placeholders are filled, and `nl.json` / `en.json` carry exactly the
 * same keys with the same placeholders (so a switch never shows a raw key or drops a value).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/locales/en.json';
import nl from '@/i18n/locales/nl.json';

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = `${prefix}${key}`;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, `${path}.`)) out.set(k, v);
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

async function freshStore() {
  vi.resetModules();
  return import('@/i18n');
}

describe('locale files', () => {
  const nlKeys = flatten(nl as Tree);
  const enKeys = flatten(en as Tree);

  it('nl.json and en.json have exactly the same keys', () => {
    expect([...enKeys.keys()].sort()).toEqual([...nlKeys.keys()].sort());
    expect(nlKeys.size).toBeGreaterThan(100);
  });

  it('every key uses the same placeholders in both languages', () => {
    for (const [key, text] of nlKeys) {
      expect({ key, vars: placeholders(enKeys.get(key) ?? '') }).toEqual({ key, vars: placeholders(text) });
    }
  });

  it('no value is empty', () => {
    for (const [key, text] of [...nlKeys, ...enKeys]) expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false });
  });
});

describe('locale store', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to Dutch when nothing is stored, and sets <html lang>', async () => {
    const i18n = await freshStore();
    expect(i18n.getLocale()).toBe('nl');
    expect(document.documentElement.lang).toBe('nl');
    expect(i18n.t('nav.settings.label')).toBe('Instellingen');
  });

  it('honours a stored choice', async () => {
    localStorage.setItem('forge.locale', 'en');
    const i18n = await freshStore();
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('nav.settings.label')).toBe('Settings');
  });

  it('falls back to Dutch for an unknown stored value', async () => {
    localStorage.setItem('forge.locale', 'fr');
    const i18n = await freshStore();
    expect(i18n.getLocale()).toBe('nl');
  });

  it('setLocale persists, updates <html lang> and notifies subscribers once per real change', async () => {
    const i18n = await freshStore();
    const listener = vi.fn();
    const unsubscribe = i18n.subscribeLocale(listener);

    i18n.setLocale('en');
    i18n.setLocale('en');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('forge.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(i18n.t('chat.composer.send')).toBe('Send');

    unsubscribe();
    i18n.setLocale('nl');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(i18n.t('chat.composer.send')).toBe('Versturen');
  });

  it('rejects an unknown locale instead of silently switching', async () => {
    const i18n = await freshStore();
    expect(() => i18n.setLocale('fr' as never)).toThrow(/Unknown locale/);
    expect(i18n.getLocale()).toBe('nl');
  });

  it('fills placeholders and leaves an unsupplied one visible', async () => {
    const i18n = await freshStore();
    expect(i18n.t('chat.composer.fieldLabel', { title: 'Mijn site' })).toBe('Bericht aan Forge in Mijn site');
    expect(i18n.t('chat.composer.fieldLabel')).toBe('Bericht aan Forge in {title}');
    expect(i18n.translate('en', 'shell.connection.nextAttempt', { seconds: 3 })).toBe('next attempt in 3s');
  });

  it('nav labels follow the locale at read time', async () => {
    const i18n = await freshStore();
    const { PRIMARY_NAV } = await import('@/components/shell/nav-config');
    const settings = PRIMARY_NAV.find((item) => item.path === '/settings');
    expect(settings?.label).toBe('Instellingen');
    i18n.setLocale('en');
    expect(settings?.label).toBe('Settings');
  });
});
