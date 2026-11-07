/**
 * health-format — turns the bot's own health report (what GET /api/discord/status passes through as
 * `health`) into short readable text, one value per row (Command Center audit finding 31).
 * Nested values used to be printed as raw JSON: `{"COMPLETED":29,"CANCELLED":2}`, or a 14-item
 * project list as one long line of braces.
 *
 * Nothing is hidden or invented: every key still gets its own row, a key this module does not know
 * gets a plain humanized label, and a value it cannot describe more simply falls back to a count,
 * never to a guess.
 *
 * XR-COPY1: every function takes the app locale (default 'en', the wording the unit suite pins); the
 * Dutch words come from `xr-copy.ts`.
 */

import type { Locale, MessageKey } from '@/i18n';
import { translate } from '@/i18n';
import { formatLocalDateTime } from '@/i18n/format';



function say(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(locale, key, vars);
}

const MAX_LISTED = 5;
const MAX_FIELDS = 8;
/** Anything below this is a count or a duration, not an epoch-milliseconds timestamp (about 1973). */
const EPOCH_MS_MIN = 1e11;

/** Friendly labels for the fields the bot's health server reports today (discord/src/health-server.js). */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'live', 'phase', 'pid', 'startedAt', 'uptimeSec', 'transport', 'connected', 'busy', 'activeRuns', 'queueDepth',
  'runner', 'guildId', 'loginError', 'botUsername', 'applicationId', 'guilds', 'inviteUrl', 'projects', 'ts',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** camelCase or snake_case -> "Sentence case", for a key without a known label. */
export function healthKeyLabel(key: string, locale: Locale = 'en'): string {
  if (KNOWN_FIELDS.has(key)) return say(locale, `rd.discord.health.field.${key}` as MessageKey);
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  // A unit word is dropped when formatHealthValue() already renders the value with its own unit.
  const withoutUnit = isSecondsKey(key) ? words.replace(/ (sec|secs|seconds)$/, '') : words;
  if (withoutUnit === '') return key;
  return withoutUnit.charAt(0).toUpperCase() + withoutUnit.slice(1);
}

/** Whole seconds -> "45 s", "12 min", "3 h 5 min", "2 d 4 h" (Dutch: "3 u 5 min", "2 d 4 u"). */
export function formatSeconds(totalSeconds: number, locale: Locale = 'en'): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const h = locale === 'en' ? 'h' : 'u';
  if (days > 0) return hours > 0 ? `${days} d ${hours} ${h}` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} ${h} ${minutes} min` : `${hours} ${h}`;
  if (minutes > 0) return `${minutes} min`;
  return `${s} s`;
}

function looksLikeTimestampKey(key: string): boolean {
  return key === 'ts' || /(At|_at)$/.test(key);
}

function isSecondsKey(key: string): boolean {
  return /(Sec|Secs|Seconds|_sec|_secs|_seconds)$/.test(key);
}

function formatScalar(key: string, value: unknown, locale: Locale): string | null {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? say(locale, 'rd.discord.health.value.yes') : say(locale, 'rd.discord.health.value.no');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (looksLikeTimestampKey(key) && value > EPOCH_MS_MIN) return formatLocalDateTime(value, locale) ?? String(value);
    if (isSecondsKey(key) && value >= 0) return formatSeconds(value, locale);
    return String(value);
  }
  if (typeof value === 'string') return value === '' ? '—' : value;
  return null;
}

function labelOf(item: unknown): string | null {
  if (typeof item === 'string') return item === '' ? null : item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (isRecord(item)) {
    for (const key of ['name', 'projectId', 'label', 'title', 'id']) {
      const v = item[key];
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
  }
  return null;
}

function itemCount(count: number, locale: Locale): string {
  return say(locale, count === 1 ? 'rd.discord.health.value.itemsOne' : 'rd.discord.health.value.itemsMany', { count });
}

function formatList(items: readonly unknown[], locale: Locale): string {
  if (items.length === 0) return say(locale, 'rd.discord.health.value.none');
  const labels = items.map(labelOf);
  if (labels.every((label): label is string => label !== null)) {
    if (labels.length <= MAX_LISTED) return labels.join(', ');
    return say(locale, 'rd.discord.health.value.listMore', {
      total: labels.length,
      list: labels.slice(0, MAX_LISTED).join(', '),
      count: labels.length - MAX_LISTED,
    });
  }
  return itemCount(items.length, locale);
}

function formatObject(obj: Record<string, unknown>, locale: Locale): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return say(locale, 'rd.discord.health.value.none');
  const parts = entries.map(([key, value]) => {
    const scalar = formatScalar(key, value, locale);
    if (scalar !== null) return `${key}: ${scalar}`;
    if (Array.isArray(value)) return `${key}: ${itemCount(value.length, locale)}`;
    const fields = Object.keys(isRecord(value) ? value : {}).length;
    return `${key}: ${say(locale, fields === 1 ? 'rd.discord.health.value.fieldsOne' : 'rd.discord.health.value.fieldsMany', { count: fields })}`;
  });
  const shown = parts.slice(0, MAX_FIELDS).join(' · ');
  return parts.length > MAX_FIELDS
    ? say(locale, 'rd.discord.health.value.objectMore', { shown, count: parts.length - MAX_FIELDS })
    : shown;
}

/** One health value -> one short readable line. */
export function formatHealthValue(key: string, value: unknown, locale: Locale = 'en'): string {
  const scalar = formatScalar(key, value, locale);
  if (scalar !== null) return scalar;
  if (Array.isArray(value)) return formatList(value, locale);
  if (isRecord(value)) return formatObject(value, locale);
  return String(value);
}
