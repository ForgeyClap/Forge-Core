/**
 * custom-api-model — the pure rules of the "Eigen API" form (ANY-MODEL-PLAN.md §2.2 E, §2.4,
 * Lead decisions D1 and D6). A mirror for instant feedback only: the gateway's custom-rules stay
 * authoritative and its `{path, code, nl, en}` answers are shown as they come.
 *
 * Network table (§2.4, D1): https to any host; http only to this computer (loopback) or, with a
 * visible warning, to a private address or a home-network name; plain http to a public host is
 * refused; all of 169.254.0.0/16, the cloud metadata hosts and well-known non-web ports are refused
 * always. The same table as the gateway's custom-rules.mjs, kept identical by a parity test.
 */

import { scrubSecrets } from '@/prototype/state/adapter/providers';
import { CUSTOM_ID_RE, MODEL_ID_RE } from '@/prototype/state/adapter/providers-custom';
import type { CustomAuth, CustomDefinition, CustomFormat, CustomProviderEntry } from '@/prototype/state/adapter/providers-custom';

/* ------------------------------------------------------------------ draft */

/** How the key travels. `auto` = the format's usual way (bearer for OpenAI style, x-api-key for Anthropic). */
export type DraftAuth = 'auto' | 'bearer' | 'x-api-key' | 'api-key-header' | 'custom';

export interface CustomDraft {
  readonly label: string;
  readonly format: CustomFormat;
  readonly baseURL: string;
  readonly noKey: boolean;
  readonly authType: DraftAuth;
  readonly header: string;
  readonly prefix: string;
  readonly modelsMode: 'endpoint' | 'manual';
  /** One model id per line. */
  readonly manualIds: string;
  /** Digits as typed; empty = not set. */
  readonly contextLength: string;
  readonly enabled: boolean;
}

export function emptyDraft(): CustomDraft {
  return {
    label: '',
    format: 'openai-chat',
    baseURL: '',
    noKey: false,
    authType: 'auto',
    header: '',
    prefix: '',
    modelsMode: 'endpoint',
    manualIds: '',
    contextLength: '',
    enabled: true,
  };
}

export function defaultAuthFor(format: CustomFormat): 'bearer' | 'x-api-key' {
  return format === 'anthropic' ? 'x-api-key' : 'bearer';
}

export function draftFromEntry(entry: CustomProviderEntry): CustomDraft {
  const auth = entry.auth;
  return {
    label: entry.label,
    format: entry.format,
    baseURL: entry.baseURL,
    noKey: auth.type === 'none',
    authType: auth.type === 'none' ? 'auto' : auth.type === defaultAuthFor(entry.format) ? 'auto' : auth.type,
    header: auth.type === 'custom' ? auth.header : '',
    prefix: auth.type === 'custom' ? auth.prefix : '',
    modelsMode: entry.models.mode,
    manualIds: entry.models.mode === 'manual' ? entry.models.ids.join('\n') : '',
    contextLength: entry.contextLength !== null ? String(entry.contextLength) : '',
    enabled: entry.enabled,
  };
}

/* ------------------------------------------------------------- the address */

export type UrlErrorCode = 'bad_url' | 'https_required' | 'blocked_host' | 'blocked_port';

export type UrlVerdict =
  | { readonly kind: 'empty' }
  | { readonly kind: 'https' }
  | { readonly kind: 'local' }
  | { readonly kind: 'lan' }
  | { readonly kind: 'error'; readonly code: UrlErrorCode };

/*
 * The address table below is a line-for-line mirror of the gateway's `checkCustomURL`
 * (gateway/src/providers/custom-rules.mjs). tests/unit/custom-api-url-parity.test.ts runs both over one
 * table and fails on any difference, so the form never says "allowed" where Opslaan is refused.
 */
const URL_MAX = 300;
const BLOCKED_PORTS = new Set([0, 7, 9, 19, 25, 110, 143, 465, 587]);
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);
// eslint-disable-next-line no-control-regex
const URL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const URL_FORBIDDEN_RE = /[\s{}@#?\\]/;
const HOST_CHARS_RE = /^[a-z0-9._-]+$/;

type HostClass = 'blocked' | 'loopback' | 'lan' | 'public' | 'invalid';

function parseIPv4(host: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Eight 16-bit words, or null. The URL parser has already rewritten any dotted tail to hex. */
function parseIPv6(host: string): readonly number[] | null {
  if (!host.startsWith('[') || !host.endsWith(']')) return null;
  const body = host.slice(1, -1);
  if (!/^[0-9a-f:]+$/.test(body)) return null;
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const read = (part: string): number[] => (part === '' ? [] : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...new Array<number>(Math.max(0, fill)).fill(0), ...tail];
  return words.length === 8 && words.every((word) => Number.isInteger(word)) ? words : null;
}

function classifyIPv4([a, b, c, d]: readonly number[]): HostClass {
  if (a === 0 || a >= 224) return 'blocked'; // "this network", multicast, reserved, broadcast
  if (a === 169 && b === 254) return 'blocked'; // all of link-local: home of the cloud metadata services
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'blocked';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
  return 'public';
}

function classifyIPv6(w: readonly number[]): HostClass {
  const zeros = (from: number, to: number): boolean => w.slice(from, to).every((x) => x === 0);
  const v4 = (): readonly number[] => [w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255];
  if (zeros(0, 8)) return 'blocked';
  if (zeros(0, 7) && w[7] === 1) return 'loopback';
  if (zeros(0, 5) && w[5] === 0xffff) return classifyIPv4(v4()); // IPv4-mapped
  if (zeros(0, 6)) return classifyIPv4(v4()); // IPv4-compatible: judged as the IPv4 inside
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return classifyIPv4(v4()); // NAT64 well-known prefix
  if (w[0] === 0xfd00 && w[1] === 0x0ec2 && zeros(2, 7) && w[7] === 0x254) return 'blocked'; // AWS metadata over IPv6
  if ((w[0] & 0xff00) === 0xff00) return 'blocked'; // multicast
  if ((w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80) return 'lan'; // unique local, link-local
  return 'public';
}

/** Only the bare name localhost is this computer; a name under .localhost counts as a home-network name. */
function classifyName(host: string): HostClass {
  if (BLOCKED_HOSTS.has(host)) return 'blocked';
  if (host === 'localhost') return 'loopback';
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.localhost')) return 'lan';
  return 'public';
}

function classifyHost(host: string): HostClass {
  const v4 = parseIPv4(host);
  if (v4) return classifyIPv4(v4);
  if (host.startsWith('[')) {
    const v6 = parseIPv6(host);
    return v6 ? classifyIPv6(v6) : 'invalid';
  }
  if (!HOST_CHARS_RE.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return 'invalid';
  return classifyName(host);
}

export function classifyBaseUrl(raw: string): UrlVerdict {
  const value = raw.trim();
  if (value === '') return { kind: 'empty' };
  const bad = (code: UrlErrorCode): UrlVerdict => ({ kind: 'error', code });
  if (value.length > URL_MAX || URL_FORBIDDEN_RE.test(value) || URL_CONTROL_RE.test(value) || !/^https?:\/\/[^/]/i.test(value)) return bad('bad_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad('bad_url');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return bad('bad_url');
  }
  const kind = classifyHost(url.hostname);
  if (kind === 'invalid') return bad('bad_url');
  if (kind === 'blocked') return bad('blocked_host');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (BLOCKED_PORTS.has(port)) return bad('blocked_port');
  if (url.protocol === 'https:') return { kind: 'https' };
  if (kind === 'loopback') return { kind: 'local' };
  if (kind === 'lan') return { kind: 'lan' };
  return bad('https_required');
}

/** A soft hint about the path the chosen format expects; never blocks saving. */
export function urlHint(format: CustomFormat, raw: string): 'openaiV1' | 'anthropicNoV1' | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (format === 'anthropic') return /\/v1$/.test(path) ? 'anthropicNoV1' : null;
  return /\/v\d+[a-z]*(\/|$)/.test(`${path}/`) ? null : 'openaiV1';
}

/* ------------------------------------------------------------- validation */

export type DraftField = 'label' | 'baseURL' | 'header' | 'prefix' | 'models' | 'contextLength';
export type DraftCode =
  | 'required'
  | 'tooLong'
  | 'control'
  | 'secretLike'
  | UrlErrorCode
  | 'badHeader'
  | 'reservedHeader'
  | 'badModel'
  | 'tooManyModels'
  | 'outOfRange';

export interface DraftIssue {
  readonly field: DraftField;
  readonly code: DraftCode;
}

export const LABEL_MAX = 40;
export const PREFIX_MAX = 32;
export const MAX_MODELS = 50;
export const CONTEXT_RANGE = [1024, 10_000_000] as const;
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Header names that have their own choice, or that no key may travel in. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'proxy-authorization',
  'cookie',
  'host',
  'content-type',
  'content-length',
]);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function looksSecret(value: string): boolean {
  return scrubSecrets(value) !== value;
}

export function parseManualIds(textValue: string): { readonly ids: readonly string[]; readonly bad: readonly string[] } {
  const ids: string[] = [];
  const bad: string[] = [];
  for (const line of textValue.split(/\r?\n/)) {
    const id = line.trim();
    if (id === '') continue;
    if (!MODEL_ID_RE.test(id)) bad.push(id);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, bad };
}

export function usesCustomHeader(draft: CustomDraft): boolean {
  return !draft.noKey && draft.authType === 'custom';
}

export function validateDraft(draft: CustomDraft): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];
  const label = draft.label.trim();
  if (label === '') issues.push({ field: 'label', code: 'required' });
  else if (label.length > LABEL_MAX) issues.push({ field: 'label', code: 'tooLong' });
  else if (CONTROL_RE.test(label)) issues.push({ field: 'label', code: 'control' });
  else if (looksSecret(label)) issues.push({ field: 'label', code: 'secretLike' });

  // A key pasted into the address is named first: that message tells the person what to do instead.
  const verdict = classifyBaseUrl(draft.baseURL);
  if (verdict.kind === 'empty') issues.push({ field: 'baseURL', code: 'required' });
  else if (looksSecret(draft.baseURL)) issues.push({ field: 'baseURL', code: 'secretLike' });
  else if (verdict.kind === 'error') issues.push({ field: 'baseURL', code: verdict.code });

  if (usesCustomHeader(draft)) {
    const header = draft.header.trim();
    if (header === '') issues.push({ field: 'header', code: 'required' });
    else if (!HEADER_NAME_RE.test(header)) issues.push({ field: 'header', code: 'badHeader' });
    else if (RESERVED_HEADERS.has(header.toLowerCase())) issues.push({ field: 'header', code: 'reservedHeader' });
    if (draft.prefix.length > PREFIX_MAX) issues.push({ field: 'prefix', code: 'tooLong' });
    else if (CONTROL_RE.test(draft.prefix)) issues.push({ field: 'prefix', code: 'control' });
    else if (looksSecret(draft.prefix)) issues.push({ field: 'prefix', code: 'secretLike' });
  }

  if (draft.modelsMode === 'manual') {
    const { ids, bad } = parseManualIds(draft.manualIds);
    if (bad.length > 0) issues.push({ field: 'models', code: 'badModel' });
    else if (ids.length === 0) issues.push({ field: 'models', code: 'required' });
    else if (ids.length > MAX_MODELS) issues.push({ field: 'models', code: 'tooManyModels' });
    else if (ids.some(looksSecret)) issues.push({ field: 'models', code: 'secretLike' });
  }

  const context = draft.contextLength.trim();
  if (context !== '') {
    const n = Number(context);
    if (!/^\d+$/.test(context) || n < CONTEXT_RANGE[0] || n > CONTEXT_RANGE[1]) issues.push({ field: 'contextLength', code: 'outOfRange' });
  }
  return issues;
}

/* --------------------------------------------------------------- wire shape */

function authOf(draft: CustomDraft): CustomAuth {
  if (draft.noKey) return { type: 'none' };
  if (draft.authType === 'custom') return { type: 'custom', header: draft.header.trim(), prefix: draft.prefix };
  return { type: draft.authType === 'auto' ? defaultAuthFor(draft.format) : draft.authType };
}

export function toDefinition(draft: CustomDraft): CustomDefinition {
  const context = draft.contextLength.trim();
  return {
    label: draft.label.trim(),
    format: draft.format,
    baseURL: draft.baseURL.trim(),
    auth: authOf(draft),
    models: draft.modelsMode === 'manual' ? { mode: 'manual', ids: parseManualIds(draft.manualIds).ids } : { mode: 'endpoint' },
    extraHeaders: {},
    contextLength: context === '' ? null : Number(context),
    enabled: draft.enabled,
  };
}

/** §2.2 C: the key name the gateway reads for `custom-<slug>` (dev tree without the app: an env var, D2). */
export function envNameFor(id: string): string | null {
  if (!CUSTOM_ID_RE.test(id)) return null;
  return `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** The host (and port) to show in a list row, without the path. */
export function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}
