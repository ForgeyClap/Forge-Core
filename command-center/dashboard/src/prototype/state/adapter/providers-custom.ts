/**
 * providers-custom — the dashboard side of "Eigen API" (ANY-MODEL-PLAN.md §2.2 A + D).
 *
 * The gateway keeps the user's own API entries in its overlay store and is the only writer. This
 * adapter talks to those routes through gatewayUrl (loopback only), never to the API itself:
 *   GET    /api/providers/custom          {ok, revision, providers:[entry]}
 *   POST   /api/providers/custom          {revision, provider} -> 201 {ok, revision, provider}
 *   PATCH  /api/providers/custom/:id      {revision, provider} -> 200 {ok, revision, provider}
 *   DELETE /api/providers/custom/:id      -> 200 {ok, revision, router_entries}
 * `router_entries` (DELETE, and PATCH that switches an entry off) = the router chain entry ids that still name it;
 * the router skips those steps. Read as null when the answer has none (an older gateway).
 * Errors: 400 {errors:[{path,code,nl,en}]}, 409 {error: stale_revision | duplicate_id, revision},
 * 403 (window not paired), 404 (a gateway without these routes), 429.
 *
 * A definition never carries a key: the shape has no field for one, the parser copies only named
 * fields, and a definition with a key-shaped value is refused here before anything is sent. The key
 * itself goes only to the desktop vault (KeyField), keyed by the entry id.
 */

import { useCallback, useEffect, useState } from 'react';

import { isPairingRequired, setPairingState } from '@/lib/ui-session';
import { EXEC_TOKEN_HEADER, gatewayUrl, gwGet, readExecToken, writeCredentials } from '@/prototype/state/gateway-client';

import { scrubSecrets } from './providers';
import { signalRouterChanged } from './router-refresh';

/* ------------------------------------------------------------------ shapes */

export const CUSTOM_FORMATS = ['openai-chat', 'openai-responses', 'anthropic'] as const;
export type CustomFormat = (typeof CUSTOM_FORMATS)[number];

export const CUSTOM_AUTH_TYPES = ['none', 'bearer', 'x-api-key', 'api-key-header', 'custom'] as const;
export type CustomAuthType = (typeof CUSTOM_AUTH_TYPES)[number];

export type CustomAuth =
  | { readonly type: Exclude<CustomAuthType, 'custom'> }
  | { readonly type: 'custom'; readonly header: string; readonly prefix: string };

export type CustomModels = { readonly mode: 'endpoint' } | { readonly mode: 'manual'; readonly ids: readonly string[] };

/** What the form sends (§2.2 A without id and timestamps). */
export interface CustomDefinition {
  readonly label: string;
  readonly format: CustomFormat;
  readonly baseURL: string;
  readonly auth: CustomAuth;
  readonly models: CustomModels;
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly contextLength: number | null;
  readonly enabled: boolean;
}

export interface CustomProviderEntry extends CustomDefinition {
  readonly id: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface CustomFieldError {
  readonly path: string;
  readonly code: string;
  readonly nl: string;
  readonly en: string;
}

export interface CustomList {
  /** False when the answer is not this list (an older gateway, no answer, no revision). */
  readonly available: boolean;
  readonly revision: number;
  readonly entries: readonly CustomProviderEntry[];
  readonly dropped: number;
}

export const CUSTOM_ID_RE = /^custom-[a-z0-9][a-z0-9-]{0,40}$/;
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const MAX_MODELS = 50;

/* ---------------------------------------------------------------- parse */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isFormat(value: unknown): value is CustomFormat {
  return typeof value === 'string' && (CUSTOM_FORMATS as readonly string[]).includes(value);
}

function parseAuth(raw: unknown): CustomAuth | null {
  const record = asRecord(raw);
  const type = record ? record.type : null;
  if (type === 'custom' && record) {
    const header = text(record, 'header');
    if (!header || !HEADER_NAME_RE.test(header)) return null;
    const prefix = typeof record.prefix === 'string' ? record.prefix.slice(0, 32) : '';
    return { type: 'custom', header, prefix };
  }
  if (type === 'none' || type === 'bearer' || type === 'x-api-key' || type === 'api-key-header') return { type };
  return null;
}

function parseModels(raw: unknown): CustomModels | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.mode === 'endpoint') return { mode: 'endpoint' };
  if (record.mode !== 'manual' || !Array.isArray(record.ids)) return null;
  const ids = record.ids.filter((id): id is string => typeof id === 'string' && MODEL_ID_RE.test(id)).slice(0, MAX_MODELS);
  return { mode: 'manual', ids };
}

function parseHeaders(raw: unknown): Record<string, string> {
  const record = asRecord(raw);
  const out: Record<string, string> = {};
  if (!record) return out;
  for (const [name, value] of Object.entries(record)) {
    if (HEADER_NAME_RE.test(name) && typeof value === 'string') out[name] = value.slice(0, 200);
  }
  return out;
}

function isoOrNull(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record, key);
    if (value && !Number.isNaN(Date.parse(value))) return value;
  }
  return null;
}

/** One entry, copied field by field; null when it is not a usable "Eigen API" entry. */
export function parseCustomEntry(raw: unknown): CustomProviderEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = text(record, 'id');
  const label = text(record, 'label');
  const baseURL = text(record, 'baseURL') ?? text(record, 'base_url');
  if (!id || !CUSTOM_ID_RE.test(id) || !label || label.length > 40 || !baseURL || !isFormat(record.format)) return null;
  const auth = parseAuth(record.auth);
  const models = parseModels(record.models);
  if (!auth || !models) return null;
  const context = record.contextLength ?? record.context_length;
  return {
    id,
    label,
    format: record.format,
    baseURL,
    auth,
    models,
    extraHeaders: parseHeaders(record.extraHeaders ?? record.extra_headers),
    contextLength: typeof context === 'number' && Number.isInteger(context) && context > 0 ? context : null,
    enabled: record.enabled !== false,
    createdAt: isoOrNull(record, 'created_at', 'createdAt'),
    updatedAt: isoOrNull(record, 'updated_at', 'updatedAt'),
  };
}

export const EMPTY_CUSTOM_LIST: CustomList = { available: false, revision: 0, entries: [], dropped: 0 };

export function parseCustomList(data: Record<string, unknown>): CustomList {
  const revision = data.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || !Array.isArray(data.providers)) return EMPTY_CUSTOM_LIST;
  const entries: CustomProviderEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of data.providers) {
    const entry = parseCustomEntry(raw);
    if (!entry || seen.has(entry.id)) {
      dropped += 1;
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { available: true, revision, entries, dropped };
}

function parseErrors(body: Record<string, unknown>): readonly CustomFieldError[] {
  const list = Array.isArray(body.errors) ? body.errors : [];
  return list.flatMap((raw) => {
    const record = asRecord(raw);
    if (!record) return [];
    return [
      {
        path: typeof record.path === 'string' ? record.path : '',
        code: typeof record.code === 'string' ? record.code : 'invalid',
        nl: typeof record.nl === 'string' ? scrubSecrets(record.nl).slice(0, 240) : '',
        en: typeof record.en === 'string' ? scrubSecrets(record.en).slice(0, 240) : '',
      },
    ];
  });
}

/** True when any string in the definition looks like a key (it would be refused by the gateway too). */
export function carriesSecret(def: CustomDefinition): boolean {
  const values: string[] = [def.label, def.baseURL, ...Object.keys(def.extraHeaders), ...Object.values(def.extraHeaders)];
  if (def.auth.type === 'custom') values.push(def.auth.header, def.auth.prefix);
  if (def.models.mode === 'manual') values.push(...def.models.ids);
  return values.some((value) => scrubSecrets(value) !== value);
}

/* --------------------------------------------------------------- transport */

interface RawAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly networkError: string | null;
}

async function call(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<RawAnswer> {
  const token = readExecToken();
  const headers: Record<string, string> = { ...(token !== null ? { [EXEC_TOKEN_HEADER]: token } : {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: writeCredentials(),
    });
  } catch (err) {
    return { status: 0, body: {}, networkError: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* A body that is not JSON reads as {} below. */
  }
  if (isPairingRequired(res.status, parsed)) setPairingState('required');
  return { status: res.status, body: asRecord(parsed) ?? {}, networkError: null };
}

function errorText(answer: RawAnswer): string {
  const error = answer.networkError ?? (typeof answer.body.error === 'string' ? answer.body.error : `HTTP ${answer.status}`);
  return scrubSecrets(error).slice(0, 240);
}

export type CustomSaveOutcome =
  | { readonly kind: 'saved'; readonly entry: CustomProviderEntry; readonly revision: number; readonly routerEntries: readonly string[] | null }
  | { readonly kind: 'invalid'; readonly errors: readonly CustomFieldError[] }
  | { readonly kind: 'stale'; readonly revision: number | null }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-many' }
  | { readonly kind: 'failed'; readonly error: string };

function revisionOf(body: Record<string, unknown>): number | null {
  const value = body.revision;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

const ROUTER_ENTRY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The router chain entry ids in the answer, or null when it carries none. */
function routerEntriesOf(body: Record<string, unknown>): readonly string[] | null {
  const list = body.router_entries;
  if (!Array.isArray(list)) return null;
  return list.filter((id): id is string => typeof id === 'string' && ROUTER_ENTRY_RE.test(id)).slice(0, 50);
}

function common(answer: RawAnswer): CustomSaveOutcome {
  if (answer.networkError !== null) return { kind: 'failed', error: errorText(answer) };
  if (answer.status === 400) return { kind: 'invalid', errors: parseErrors(answer.body) };
  if (answer.status === 409) {
    return answer.body.error === 'duplicate_id' ? { kind: 'duplicate' } : { kind: 'stale', revision: revisionOf(answer.body) };
  }
  if (answer.status === 403) return { kind: 'refused', error: errorText(answer) };
  if (answer.status === 404 || answer.status === 405) return { kind: 'missing' };
  if (answer.status === 429) return { kind: 'too-many' };
  return { kind: 'failed', error: errorText(answer) };
}

function saved(answer: RawAnswer): CustomSaveOutcome {
  if (answer.status === 200 || answer.status === 201) {
    const entry = parseCustomEntry(answer.body.provider);
    const revision = revisionOf(answer.body);
    return entry && revision !== null
      ? { kind: 'saved', entry, revision, routerEntries: routerEntriesOf(answer.body) }
      : { kind: 'failed', error: 'incomplete answer' };
  }
  return common(answer);
}

/** A stored change can change which router steps are skipped: tell the router views to read again (Q6-UI). */
function announce<T extends { readonly kind: string }>(outcome: T): T {
  if (outcome.kind === 'saved' || outcome.kind === 'deleted') signalRouterChanged();
  return outcome;
}

export async function createCustomProvider(def: CustomDefinition, revision: number): Promise<CustomSaveOutcome> {
  if (carriesSecret(def)) return { kind: 'failed', error: 'secret_like_value' };
  return announce(saved(await call('POST', '/api/providers/custom', { revision, provider: def })));
}

export async function updateCustomProvider(id: string, def: CustomDefinition, revision: number): Promise<CustomSaveOutcome> {
  if (!CUSTOM_ID_RE.test(id)) return { kind: 'failed', error: 'bad id' };
  if (carriesSecret(def)) return { kind: 'failed', error: 'secret_like_value' };
  return announce(saved(await call('PATCH', `/api/providers/custom/${encodeURIComponent(id)}`, { revision, provider: def })));
}

export type CustomDeleteOutcome =
  | { readonly kind: 'deleted'; readonly revision: number | null; readonly routerEntries: readonly string[] | null }
  | Exclude<CustomSaveOutcome, { kind: 'saved' }>;

export async function deleteCustomProvider(id: string): Promise<CustomDeleteOutcome> {
  if (!CUSTOM_ID_RE.test(id)) return { kind: 'failed', error: 'bad id' };
  const answer = await call('DELETE', `/api/providers/custom/${encodeURIComponent(id)}`);
  if (answer.status === 200 || answer.status === 204) return announce<CustomDeleteOutcome>({ kind: 'deleted', revision: revisionOf(answer.body), routerEntries: routerEntriesOf(answer.body) });
  return common(answer) as Exclude<CustomSaveOutcome, { kind: 'saved' }>;
}

/* ----------------------------------------------------------------- hook */

export type CustomLoad = 'loading' | 'ready' | 'missing' | 'error';

export interface CustomProvidersState {
  readonly load: CustomLoad;
  readonly list: CustomList;
  readonly error: string | null;
  readonly reload: () => void;
}

/** The user's own API entries, read on mount and on `reload`. `missing` = this gateway has no such list. */
export function useCustomProviders(): CustomProvidersState {
  const [state, setState] = useState<{ load: CustomLoad; list: CustomList; error: string | null }>({
    load: 'loading',
    list: EMPTY_CUSTOM_LIST,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void gwGet('/api/providers/custom').then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        const missing = /HTTP 40[45]|not.?found|unknown route/i.test(result.error);
        setState((prev) => ({ load: missing ? 'missing' : 'error', list: prev.list, error: scrubSecrets(result.error).slice(0, 240) }));
        return;
      }
      const list = parseCustomList(result.data);
      setState({ load: list.available ? 'ready' : 'missing', list, error: null });
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
