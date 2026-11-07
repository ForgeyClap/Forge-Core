/**
 * B8-3 (B8-2 review, HIGH): `formatRelativeTime` printed English ("just now", "5 min ago", "3 hr ago",
 * "2 days ago") beside Dutch labels in the sidebar and the inspector's "Laatst actief". It now takes
 * the locale; Dutch is the default locale of the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRelativeTime } from '@/prototype/state/adapter/rows';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime — Dutch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says zojuist for 30 seconds', () => {
    expect(formatRelativeTime(ago(30 * SEC), 'nl')).toBe('zojuist');
  });

  it('says 5 min geleden for 5 minutes', () => {
    expect(formatRelativeTime(ago(5 * MIN), 'nl')).toBe('5 min geleden');
  });

  it('says 3 uur geleden for 3 hours', () => {
    expect(formatRelativeTime(ago(3 * HOUR), 'nl')).toBe('3 uur geleden');
  });

  it('says 2 dagen geleden for 2 days, and 1 dag geleden for one', () => {
    expect(formatRelativeTime(ago(2 * DAY), 'nl')).toBe('2 dagen geleden');
    expect(formatRelativeTime(ago(1 * DAY), 'nl')).toBe('1 dag geleden');
  });

  it('says 2 weken geleden for 14 days', () => {
    expect(formatRelativeTime(ago(14 * DAY), 'nl')).toBe('2 weken geleden');
  });

  it('keeps honest absence for a missing or broken timestamp', () => {
    expect(formatRelativeTime(null, 'nl')).toBe('');
    expect(formatRelativeTime('not-a-timestamp', 'nl')).toBe('');
  });

  it('still speaks English when asked for English', () => {
    expect(formatRelativeTime(ago(30 * SEC), 'en')).toBe('just now');
    expect(formatRelativeTime(ago(5 * MIN), 'en')).toBe('5 min ago');
    expect(formatRelativeTime(ago(3 * HOUR), 'en')).toBe('3 hr ago');
    expect(formatRelativeTime(ago(2 * DAY), 'en')).toBe('2 days ago');
  });
});
