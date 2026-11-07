/**
 * session-actions — the gateway calls and pure helpers behind the chat's session rail (WP B3).
 *
 * Resume needs no call of its own: opening a conversation and sending in it makes the gateway pass
 * `--resume <stored session id>` (gateway `sessions/argv-session.mjs`). Fork asks the gateway for a
 * NEW conversation whose first turn runs with `--resume <id> --fork-session`
 * (`POST /api/conversations/:id/fork`, gateway `forkConversation`). Rename is
 * `PATCH /api/conversations/:id {title}`. Both routes are registered by the gateway lane (WP A11);
 * on a gateway build without them the call fails with an honest Dutch reason, never a fake success.
 *
 * Full-text search reads the real transcripts (`GET /api/conversations/:id`) of the listed
 * conversations, bounded, and matches every word of the query against title + every turn's text.
 */

import {
  EXEC_TOKEN_HEADER,
  asRecord,
  gwGet,
  gwPatch,
  gwPost,
  pickArray,
  pickRecord,
  pickString,
  readExecToken,
} from '@/prototype/state/gateway-client';
import type { Conversation } from '@/prototype/types/prototype-types';

function execHeaders(): Record<string, string> {
  const token = readExecToken();
  return token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
}

export interface SessionActionResult {
  readonly ok: boolean;
  /** The new conversation's id (fork only). */
  readonly id: string | null;
  /** 'missing-route' when this gateway build does not offer the route yet; otherwise the real error. */
  readonly error: string | null;
}

function routeMissing(error: string): boolean {
  return /^HTTP (404|405)$/.test(error) || /not found|unknown route|method not allowed/i.test(error);
}

const TITLE_MAX = 120;

/** Trims, collapses whitespace and caps a title; returns null when nothing usable is left. */
export function normalizeTitle(raw: string): string | null {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX).trimEnd() : clean;
}

export async function renameConversation(id: string, rawTitle: string): Promise<SessionActionResult> {
  const title = normalizeTitle(rawTitle);
  if (title === null) return { ok: false, id: null, error: 'empty-title' };
  const result = await gwPatch(`/api/conversations/${encodeURIComponent(id)}`, { title }, execHeaders());
  if (!result.ok) return { ok: false, id: null, error: routeMissing(result.error) ? 'missing-route' : result.error };
  return { ok: true, id, error: null };
}

export async function forkConversation(id: string): Promise<SessionActionResult> {
  const result = await gwPost(`/api/conversations/${encodeURIComponent(id)}/fork`, {}, execHeaders());
  if (!result.ok) return { ok: false, id: null, error: routeMissing(result.error) ? 'missing-route' : result.error };
  const nested = pickRecord(result.data, ['conversation']);
  const newId = pickString(nested ?? result.data, ['id']);
  if (newId === null) return { ok: false, id: null, error: 'no-id' };
  return { ok: true, id: newId, error: null };
}

/* ------------------------------------------------------------------ search */

/** Lower-cased words of a query (diacritics kept, punctuation dropped). */
export function queryWords(query: string): readonly string[] {
  return query
    .toLocaleLowerCase('nl')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** True when every word of the query occurs somewhere in the text. */
export function matchesAllWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = text.toLocaleLowerCase('nl');
  return words.every((word) => haystack.includes(word));
}

/** The text of every turn (user and assistant) of one `GET /api/conversations/:id` answer. */
export function transcriptText(data: Record<string, unknown>): string {
  const meta = asRecord(data.meta);
  const title = meta !== null ? pickString(meta, ['title']) ?? '' : '';
  const turns = pickArray(data, ['turns']).map((turn) => pickString(turn, ['text']) ?? '');
  return [title, ...turns].join('\n');
}

/** The most transcripts one search reads, so a long history never floods the gateway. */
export const SEARCH_LIMIT = 60;

export interface FullTextSearchResult {
  readonly ids: ReadonlySet<string>;
  /** Conversations whose transcript could not be read (searched on title only). */
  readonly unreadable: number;
  /** True when more conversations exist than SEARCH_LIMIT; the oldest were not searched. */
  readonly truncated: boolean;
}

/** The most transcripts read at the same time, so one search never floods the gateway. */
export const SEARCH_CONCURRENCY = 6;

/** How long a transcript that could not be read is not asked for again (a retyped query, Enter twice). */
const UNREADABLE_TTL_MS = 30_000;

const transcriptCache = new Map<string, { readonly updatedAt: string; readonly text: string }>();
const unreadableCache = new Map<string, { readonly updatedAt: string; readonly until: number }>();

/** Runs `task` over `items` with at most `limit` running at once (order of completion is free). */
async function runBounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/** The transcript text of one conversation, or null when it cannot be read (cached either way). */
async function readTranscript(conversation: Conversation): Promise<string | null> {
  const cached = transcriptCache.get(conversation.id);
  if (cached && cached.updatedAt === conversation.updatedAt) return cached.text;
  const failed = unreadableCache.get(conversation.id);
  if (failed && failed.updatedAt === conversation.updatedAt && failed.until > Date.now()) return null;
  const result = await gwGet(`/api/conversations/${encodeURIComponent(conversation.id)}`);
  if (!result.ok) {
    unreadableCache.set(conversation.id, { updatedAt: conversation.updatedAt, until: Date.now() + UNREADABLE_TTL_MS });
    return null;
  }
  unreadableCache.delete(conversation.id);
  const text = transcriptText(result.data);
  transcriptCache.set(conversation.id, { updatedAt: conversation.updatedAt, text });
  return text;
}

export async function searchConversations(
  conversations: readonly Conversation[],
  query: string,
): Promise<FullTextSearchResult> {
  const words = queryWords(query);
  const ids = new Set<string>();
  if (words.length === 0) return { ids: new Set(conversations.map((c) => c.id)), unreadable: 0, truncated: false };
  const scoped = conversations.slice(0, SEARCH_LIMIT);
  let unreadable = 0;
  await runBounded(scoped, SEARCH_CONCURRENCY, async (conversation) => {
    const transcript = await readTranscript(conversation);
    if (transcript === null) unreadable += 1;
    const text = transcript ?? conversation.title;
    if (matchesAllWords(`${conversation.title}\n${text}`, words)) ids.add(conversation.id);
  });
  return { ids, unreadable, truncated: conversations.length > SEARCH_LIMIT };
}

/* ------------------------------------------------------------------ export */

export interface ExportMessage {
  readonly author: string;
  readonly body: string;
  readonly timestamp: string;
}

export interface ExportLabels {
  readonly you: string;
  readonly forge: string;
  readonly exportedOn: string;
}

/** A readable Markdown transcript: title, export line, then one section per message. */
export function conversationToMarkdown(
  title: string,
  messages: readonly ExportMessage[],
  labels: ExportLabels,
  exportedAt: Date,
): string {
  const lines = [`# ${title}`, '', `_${labels.exportedOn} ${exportedAt.toISOString()}_`, ''];
  for (const message of messages) {
    const who = message.author === 'user' ? labels.you : labels.forge;
    lines.push(`## ${who}${message.timestamp ? ` · ${message.timestamp}` : ''}`, '', message.body.trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** A stable JSON export: format marker, conversation identity and the messages as shown. */
export function conversationToJson(
  conversation: { readonly id: string; readonly title: string; readonly projectId: string },
  messages: readonly ExportMessage[],
  exportedAt: Date,
): string {
  return `${JSON.stringify(
    {
      format: 'forge-conversation/1',
      exported_at: exportedAt.toISOString(),
      conversation: { id: conversation.id, title: conversation.title, project: conversation.projectId },
      messages: messages.map((m) => ({ author: m.author, timestamp: m.timestamp, body: m.body })),
    },
    null,
    2,
  )}\n`;
}

/** A file-name-safe slug of the title (falls back to "gesprek"). */
export function exportFileName(title: string, extension: 'md' | 'json'): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'gesprek'}.${extension}`;
}

/** Starts a real browser download of `text` (no network, a local Blob URL). */
export function downloadText(fileName: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** "zojuist", "5 min geleden", "3 uur geleden", "2 dagen geleden" or the date — never a raw ISO. */
export function relativeActivity(iso: string, now: number, labels: {
  readonly justNow: string;
  readonly minutes: (n: number) => string;
  readonly hours: (n: number) => string;
  readonly days: (n: number) => string;
  readonly unknown: string;
}): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return labels.unknown;
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return labels.justNow;
  if (diff < 60 * minute) return labels.minutes(Math.floor(diff / minute));
  if (diff < 24 * 60 * minute) return labels.hours(Math.floor(diff / (60 * minute)));
  if (diff < 7 * 24 * 60 * minute) return labels.days(Math.floor(diff / (24 * 60 * minute)));
  return new Date(at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

const NL_MOMENT = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** In Dutch a recorded ISO moment reads "2 nov, 10:15"; other locales and non-ISO text stay as they are. */
export function formatMoment(value: string, locale: string): string {
  if (locale !== 'nl' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? NL_MOMENT.format(new Date(ms)) : value;
}
