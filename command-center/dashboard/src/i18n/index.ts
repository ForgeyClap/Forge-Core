/**
 * i18n — the dashboard's string layer (WP B0b).
 *
 * Every user-facing string lives in `locales/nl.json` (the source of truth and the default
 * locale) and `locales/en.json`. Components ask for a string by its dotted key through `t()`;
 * the key type is derived from `nl.json`, so a typo or a removed key is a compile error, and
 * `en.json` is checked against the same shape at compile time (missing keys) and in the unit
 * suite (extra keys).
 *
 * No dependency: the store is a tiny module-level value with listeners, persisted in
 * localStorage, and React reads it through `useLocale()` (`use-locale.ts`). Words follow the
 * glossary in `command-center/desktop/product/PRODUCT-CARD.md`.
 */

import { countKey, formatNumber } from './format';
import en from './locales/en.json';
import nl from './locales/nl.json';

/** The message tree shape, taken from the Dutch source file. */
export type Messages = typeof nl;

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every valid dotted key, e.g. `'nav.home.label'`. */
export type MessageKey = Leaves<Messages>;

/** Values substituted into `{name}` placeholders. */
export type MessageVars = Readonly<Record<string, string | number>>;

export const LOCALES = ['nl', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'nl';
export const LOCALE_STORAGE_KEY = 'forge.locale';

// `en` must provide every key `nl` has; the assignment fails to compile when one is missing.
const english: Messages = en;
const CATALOGS: Readonly<Record<Locale, Messages>> = { nl, en: english };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function readStoredLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    // Storage can be unavailable (private mode, a sandboxed frame): fall back to the default.
    return DEFAULT_LOCALE;
  }
}

let current: Locale = readStoredLocale();
const listeners = new Set<() => void>();

function applyDocumentLang(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

applyDocumentLang(current);

export function getLocale(): Locale {
  return current;
}

/** Switches the locale, remembers it in this browser and re-renders every `useLocale()` reader. */
export function setLocale(next: Locale): void {
  if (!isLocale(next)) throw new Error(`Unknown locale: ${String(next)}`);
  if (next === current) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // Not persisted when storage is unavailable; the switch still applies to this tab.
  }
  applyDocumentLang(next);
  listeners.forEach((listener) => listener());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function lookup(catalog: Messages, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** A function that turns a key into text in one locale: `useLocale().t`, or `translate` bound to a locale. */
export type Translate = (key: MessageKey, vars?: MessageVars) => string;

/**
 * The string for `key` in `locale`. Falls back to Dutch, then to the key itself, so a gap is
 * visible on screen instead of rendering an empty label. There is no other fallback: a key that is
 * not in the catalog shows as the raw key (and `MessageKey` makes it a compile error first).
 */
export function translate(locale: Locale, key: MessageKey, vars?: MessageVars): string {
  const template = lookup(CATALOGS[locale], key) ?? lookup(CATALOGS[DEFAULT_LOCALE], key) ?? key;
  return interpolate(template, vars);
}

/** The string for `key` in the current locale. Components should read it via `useLocale()`. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(current, key, vars);
}

/**
 * The One or the Many text for a count (`one` when `count` is 1). The count is passed as `{count}`,
 * in the locale's number format.
 */
export function translateCount(locale: Locale, count: number, one: MessageKey, many: MessageKey, vars?: MessageVars): string {
  return translate(locale, countKey(count, one, many), { ...vars, count: formatNumber(count, locale) });
}
