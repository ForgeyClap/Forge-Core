/**
 * providers — the dashboard side of the provider layer (WP B2 part 2, plan §4.3 / §4.6).
 *
 * Three sources, each parsed defensively (a malformed row is dropped, never guessed):
 *   1. `GET /api/providers` — one row per account the gateway knows, with its state word, how it is
 *      paid for and whether a key is present (`key_source`: vault | env | null). Never a key value.
 *   2. `POST /api/providers/:id/test` — the cheapest real call; the answer is redacted by the gateway
 *      and scrubbed once more here before it can reach the screen.
 *   3. `window.forge.keys` — the desktop app's key vault (contract: _scratch/b2/contract-keys.md).
 *      Only status objects come back (configured, last4, updated_at, apply state); the renderer
 *      never receives a key. In a plain browser the bridge is absent and the UI says so.
 *
 * Field whitelist on purpose: the parser copies only named fields, so a key that a buggy gateway
 * might put in some other field can never travel further into the UI.
 */

import { useCallback, useEffect, useState } from 'react';

import { EXEC_TOKEN_HEADER, gwGet, gwPost, readExecToken } from '@/prototype/state/gateway-client';

/* ------------------------------------------------------------------ shapes */

/** The one status word on a card. Copy: `settingsPage.accounts.status.<word>`. */
export type ProviderStatus =
  | 'connected'
  | 'keySaved'
  | 'running'
  | 'noKey'
  | 'keyRejected'
  | 'unreachable'
  | 'noModel'
  | 'missing'
  | 'limit'
  | 'signedOut'
  | 'notConnected'
  | 'found'
  | 'unsupported'
  | 'error'
  | 'unknown';

export type ProviderTone = 'ok' | 'warn' | 'off' | 'bad';

/** Who pays, in the words of the product card. */
export type ProviderPayer = 'claudeSub' | 'chatgptSub' | 'ownSub' | 'key' | 'free';

export type KeySource = 'vault' | 'env';

export interface ProviderRow {
  readonly id: string;
  readonly label: string;
  /** subscription = the user's own sign-in in the official program; local = runs on this pc. */
  readonly kind: 'subscription' | 'key' | 'local';
  /** The raw state word from the gateway, kept for the tests and a later Uitgebreid view. */
  readonly state: string;
  readonly status: ProviderStatus;
  /** True when this account takes a key (the registry names one) and is not a sign-in account. */
  readonly takesKey: boolean;
  /** Where the gateway found a key, or null when it found none. Never the key itself. */
  readonly keySource: KeySource | null;
  readonly noticeRequired: boolean;
  readonly verifiedOn: string | null;
  /** False only when the gateway marked this row as a mock (labelled NOT-live); otherwise null. */
  readonly live: boolean | null;
  readonly detail: string | null;
}

export interface ProvidersPayload {
  /** False when the gateway has no provider list (an older gateway, or no answer). */
  readonly available: boolean;
  readonly rows: readonly ProviderRow[];
  readonly dropped: number;
}

export const EMPTY_PROVIDERS: ProvidersPayload = { available: false, rows: [], dropped: 0 };

/* ------------------------------------------------------------ redaction */

const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bnvapi-[A-Za-z0-9_-]{6,}/g,
  /\bgsk_[A-Za-z0-9]{6,}/g,
  /\bxai-[A-Za-z0-9]{6,}/g,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\bhf_[A-Za-z0-9]{6,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(bearer|x-api-key|api-key|authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&]key=)[^&\s]+/gi,
];

/** Second line of defence: the gateway already redacts; anything key-shaped left is hidden here. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[verborgen]');
  return out;
}

/* ---------------------------------------------------------------- parse */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const STATE_TO_STATUS: Readonly<Record<string, ProviderStatus>> = {
  connected: 'connected',
  'signed-in': 'connected',
  configured: 'keySaved',
  reachable: 'running',
  'not-configured': 'noKey',
  'auth-failed': 'keyRejected',
  unreachable: 'unreachable',
  'needs-model': 'noModel',
  'not-found': 'missing',
  'not-installed': 'missing',
  'rate-limited': 'limit',
  'not-connected': 'signedOut',
  'not-implemented': 'unsupported',
  error: 'error',
  'unknown-auth': 'unknown',
  installed: 'found',
};

/** contract-providers.md §2 `status_code`, used when the raw state gives no answer of its own. */
const CODE_TO_STATUS: Readonly<Record<string, ProviderStatus>> = {
  connected: 'connected',
  'not-connected': 'notConnected',
  'no-key': 'noKey',
  'not-installed': 'missing',
  error: 'error',
};

const TONE: Readonly<Record<ProviderStatus, ProviderTone>> = {
  connected: 'ok',
  keySaved: 'ok',
  running: 'ok',
  noKey: 'off',
  keyRejected: 'bad',
  unreachable: 'warn',
  noModel: 'warn',
  missing: 'off',
  limit: 'warn',
  signedOut: 'warn',
  notConnected: 'warn',
  found: 'ok',
  unsupported: 'off',
  error: 'bad',
  unknown: 'off',
};

export const PROVIDER_STATUSES = Object.keys(TONE) as readonly ProviderStatus[];

function lookup(table: Readonly<Record<string, ProviderStatus>>, word: string): ProviderStatus | null {
  return Object.prototype.hasOwnProperty.call(table, word) ? table[word] : null;
}

export function statusFromState(state: string): ProviderStatus {
  return lookup(STATE_TO_STATUS, state) ?? 'unknown';
}

/**
 * The status word from the gateway's two fields (contract-providers.md §2): `status_code` is
 * decisive for connected / no-key / not-installed; for not-connected and error the raw `state`
 * gives the nuance (signed out, unreachable, key refused, limit). Either one alone also works.
 */
export function statusFrom(code: string | null, state: string | null): ProviderStatus {
  const fromCode = code ? lookup(CODE_TO_STATUS, code) : null;
  if (fromCode === 'connected' || fromCode === 'noKey' || fromCode === 'missing') return fromCode;
  const fromState = state ? lookup(STATE_TO_STATUS, state) : null;
  if (fromCode === 'notConnected' && fromState !== null && toneOf(fromState) !== 'ok') return fromState;
  if (fromCode === 'error' && fromState !== null && toneOf(fromState) !== 'ok') return fromState;
  return fromCode ?? fromState ?? 'unknown';
}

export function toneOf(status: ProviderStatus): ProviderTone {
  return TONE[status];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function bool(record: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

/** One row, or null when it is not a usable provider row (no valid id, no label). */
export function parseProviderRow(raw: unknown): ProviderRow | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = str(record, 'id');
  if (!id || !ID_RE.test(id)) return null;
  const label = str(record, 'label', 'name');
  if (!label || label.length > 80) return null;

  const health = asRecord(record.health);
  const state = (str(record, 'state') ?? (health ? str(health, 'state') : null))?.toLowerCase() ?? null;
  const code = str(record, 'status_code')?.toLowerCase() ?? null;
  const kindRaw = str(record, 'kind');
  const subscription = kindRaw === 'subscription' || kindRaw === 'cli-detect-only' || bool(record, 'subscription') === true;
  const local = kindRaw === 'local' || bool(record, 'local') === true;
  const keyName = str(record, 'key_name', 'key_env_name', 'keyEnvName');
  const sourceRaw = str(record, 'key_source', 'keySource');
  const keySource: KeySource | null = sourceRaw === 'vault' || sourceRaw === 'env' ? sourceRaw : null;
  // `live` in the gateway row means "backed by a real probe on this pc" (a remote key account is
  // config-only, so false). Only an explicit mock is shown as NOT-live.
  const mock = bool(record, 'mock') === true || /^(mock|fixture)$/i.test(str(record, 'provenance') ?? '');
  const tos = asRecord(record.tos);
  const verifiedOn = (tos ? str(tos, 'checked_on') : null) ?? str(record, 'verified_on', 'verifiedOn');
  const detail = str(record, 'detail') ?? (health ? str(health, 'detail') : null);

  return {
    id,
    label,
    kind: subscription ? 'subscription' : local ? 'local' : 'key',
    state: state ?? code ?? 'unknown',
    status: statusFrom(code, state),
    takesKey: !subscription && keyName !== null && KEY_NAME_RE.test(keyName),
    keySource,
    noticeRequired: (tos ? bool(tos, 'required') : null) ?? bool(record, 'notice_required', 'noticeRequired') === true,
    verifiedOn: verifiedOn && /^\d{4}-\d{2}-\d{2}$/.test(verifiedOn) ? verifiedOn : null,
    live: mock ? false : null,
    detail: detail ? scrubSecrets(detail).slice(0, 240) : null,
  };
}

/** The whole list. `available` is false when the answer carries no provider list at all. */
export function parseProviders(data: Record<string, unknown>): ProvidersPayload {
  const list = data.providers;
  if (!Array.isArray(list)) return EMPTY_PROVIDERS;
  const rows: ProviderRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of list) {
    const row = parseProviderRow(raw);
    if (!row || seen.has(row.id)) {
      dropped += 1;
      continue;
    }
    seen.add(row.id);
    rows.push(row);
  }
  return { available: true, rows, dropped };
}

/** Who pays for this account. */
export function payerOf(row: Pick<ProviderRow, 'id' | 'kind'>): ProviderPayer {
  if (row.kind === 'subscription') {
    if (row.id === 'claude-code-cli') return 'claudeSub';
    if (row.id === 'codex-cli') return 'chatgptSub';
    return 'ownSub';
  }
  return row.kind === 'local' ? 'free' : 'key';
}

export type SignInProgram = 'claude' | 'codex';

/** The official sign-in program behind a subscription account, or null. */
export function signInProgram(id: string): SignInProgram | null {
  if (id === 'claude-code-cli') return 'claude';
  if (id === 'codex-cli') return 'codex';
  return null;
}

/** The exact commands of the official program. Forge only shows them; the user runs them. */
export const SIGN_IN_COMMANDS: Readonly<Record<SignInProgram, { readonly login: string; readonly logout: string }>> = {
  claude: { login: 'claude auth login', logout: 'claude auth logout' },
  codex: { login: 'codex login', logout: 'codex logout' },
};

/** Accounts shown first: the sign-in ones, Ollama, local ones that answer, and every account with a key. */
export function isPrimary(row: ProviderRow, vaultIds: ReadonlySet<string> = new Set()): boolean {
  if (signInProgram(row.id) !== null || row.id === 'ollama-local') return true;
  if (row.keySource !== null || vaultIds.has(row.id)) return true;
  return row.kind === 'local' && (row.status === 'running' || row.status === 'connected');
}

/* ---------------------------------------------------------- test result */

export interface ProviderTestResult {
  readonly ok: boolean;
  readonly status: ProviderStatus;
  readonly latencyMs: number | null;
  readonly detail: string | null;
  readonly live: boolean | null;
  /** The provider row the gateway refreshed after the test (contract-providers.md §4), or null. */
  readonly row: ProviderRow | null;
}

export function parseTestResult(data: Record<string, unknown>): ProviderTestResult {
  const nested = asRecord(data.result);
  const inner = nested ?? data;
  const stateRaw = str(inner, 'state')?.toLowerCase() ?? null;
  const codeRaw = str(inner, 'status_code')?.toLowerCase() ?? null;
  const status = statusFrom(codeRaw, stateRaw);
  const latency = inner.latencyMs ?? inner.latency_ms;
  const detail = str(inner, 'detail', 'message');
  const mock = bool(inner, 'mock') ?? bool(data, 'mock');
  // Top-level `live: true` on a test answer means a real call ran (contract §4); a mock says so.
  // contract-providers.md §4: the top-level `ok` means "the test ran"; `result.ok` says whether the
  // account works. A flat answer has only the envelope's `ok`, so there the state word decides
  // (`ok: true` with state auth-failed is a failed test).
  let ok: boolean;
  if (nested) ok = bool(nested, 'ok') === true;
  else ok = stateRaw !== null || codeRaw !== null ? toneOf(status) === 'ok' : bool(inner, 'ok') === true;
  return {
    ok,
    status,
    latencyMs: typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
    detail: detail ? scrubSecrets(detail).slice(0, 240) : null,
    live: mock === true ? false : (bool(inner, 'live') ?? bool(data, 'live')),
    row: nested && data.row !== undefined ? parseProviderRow(data.row) : null,
  };
}

/**
 * The test route is a write route (it may make the one outbound call, contract-providers.md §4), so
 * it carries the per-boot exec token like every other write call; without the meta tag the header
 * is left out and the gateway answers with its own refusal.
 */
export async function testProvider(id: string): Promise<ProviderTestResult> {
  if (!ID_RE.test(id)) return { ok: false, status: 'error', latencyMs: null, detail: null, live: null, row: null };
  const token = readExecToken();
  const headers: Record<string, string> = token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
  const result = await gwPost(`/api/providers/${encodeURIComponent(id)}/test`, {}, headers);
  if (!result.ok) {
    return { ok: false, status: 'error', latencyMs: null, detail: scrubSecrets(result.error).slice(0, 240), live: null, row: null };
  }
  return parseTestResult(result.data);
}

/* ----------------------------------------------------------------- hook */

const PROVIDERS_POLL_MS = 20_000;

export interface ProvidersState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly data: ProvidersPayload;
  readonly refresh: () => void;
}

export function useProviders(): ProvidersState {
  const [state, setState] = useState<{ resolved: boolean; error: string | null; data: ProvidersPayload }>({
    resolved: false,
    error: null,
    data: EMPTY_PROVIDERS,
  });
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/providers');
      if (cancelled) return;
      if (result.ok) setState({ resolved: true, error: null, data: parseProviders(result.data) });
      else setState((current) => ({ resolved: true, error: result.error, data: current.data }));
    }
    void tick();
    const timer = setInterval(() => void tick(), PROVIDERS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  const refresh = useCallback(() => setToken((value) => value + 1), []);
  return { loading: !state.resolved, error: state.error, data: state.data, refresh };
}

/* -------------------------------------------------- desktop key vault */

export type ApplyState = 'applied' | 'waiting-for-idle' | 'restarting' | 'failed';

/** An apply state main did not send, or sent in a shape this build does not know: never "applied". */
export type ApplyStateSeen = ApplyState | 'unknown';

/** KEY-VAULT-CONTRACT.md v1.2: the one action main offers. `label` is main's own Dutch text, or null. */
export interface ApplyAction {
  readonly id: 'reconnect-now';
  readonly label: string | null;
}

interface ApplyFields {
  readonly apply: ApplyStateSeen;
  readonly applyDetail: string | null;
  readonly applyAction: ApplyAction | null;
}

export interface VaultKeyStatus {
  readonly providerId: string;
  readonly configured: boolean;
  /** Exactly four printable characters, or null. */
  readonly last4: string | null;
  readonly updatedAt: string | null;
}

export type VaultOutcome =
  | ({ readonly ok: true; readonly status: VaultKeyStatus } & ApplyFields)
  | { readonly ok: false; readonly code: string; readonly message: string };

/** `window.forge.keys.reconnectNow()` (contract v1.2): the new apply state, or a refusal with its code. */
export type ReconnectOutcome =
  | ({ readonly ok: true } & ApplyFields)
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface VaultList {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly keys: readonly VaultKeyStatus[];
}

export interface KeysBridge {
  readonly set: (providerId: string, secret: string) => Promise<unknown>;
  readonly delete?: (providerId: string) => Promise<unknown>;
  readonly status?: (providerId: string) => Promise<unknown>;
  readonly list?: () => Promise<unknown>;
  /** Contract v1.2: restart now to apply a waiting key change; takes no argument. */
  readonly reconnectNow?: () => Promise<unknown>;
}

/** `window.forge.keys` when the desktop app exposes it, else null (plain browser). */
export function readKeysBridge(): KeysBridge | null {
  const forge = asRecord((globalThis as { forge?: unknown }).forge);
  if (!forge) return null;
  const keys = forge.keys;
  if (typeof keys !== 'object' || keys === null) return null;
  return typeof (keys as { set?: unknown }).set === 'function' ? (keys as KeysBridge) : null;
}

const LAST4_RE = /^[\x21-\x7e]{4}$/;

export function parseKeyStatus(raw: unknown): VaultKeyStatus | null {
  const record = asRecord(raw);
  if (!record) return null;
  const providerId = str(record, 'provider_id', 'providerId');
  if (!providerId || !ID_RE.test(providerId)) return null;
  const configured = bool(record, 'configured') === true;
  const last4 = str(record, 'last4');
  const updatedAt = str(record, 'updated_at', 'updatedAt');
  return {
    providerId,
    configured,
    last4: configured && last4 && LAST4_RE.test(last4) ? last4 : null,
    updatedAt: updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
  };
}

const APPLY_STATES: readonly ApplyState[] = ['applied', 'waiting-for-idle', 'restarting', 'failed'];

function isApplyState(value: string | null): value is ApplyState {
  return value !== null && (APPLY_STATES as readonly string[]).includes(value);
}

/** Main's text, scrubbed and bounded like every other text from outside the page. */
function outsideText(record: Record<string, unknown> | null, key: string, max: number): string | null {
  const value = record ? str(record, key) : null;
  return value ? scrubSecrets(value).slice(0, max) : null;
}

/**
 * `apply` from a KeyResult / ReconnectResult. A missing apply, or a state this build does not
 * know, is 'unknown' (never 'applied'): the UI then says the key is saved without claiming it is
 * active. Only the one action the contract names is kept; anything else is dropped.
 */
export function parseApply(raw: unknown): ApplyFields {
  const apply = asRecord(raw);
  const state = apply ? str(apply, 'state') : null;
  const action = apply ? asRecord(apply.action) : null;
  return {
    apply: isApplyState(state) ? state : 'unknown',
    applyDetail: outsideText(apply, 'detail', 240),
    applyAction: action && str(action, 'id') === 'reconnect-now' ? { id: 'reconnect-now', label: outsideText(action, 'label', 60) } : null,
  };
}

function refusal(record: Record<string, unknown>): { ok: false; code: string; message: string } {
  return { ok: false, code: str(record, 'code') ?? 'UNKNOWN', message: outsideText(record, 'message', 240) ?? '' };
}

export function parseVaultOutcome(raw: unknown, providerId: string): VaultOutcome {
  const record = asRecord(raw);
  if (!record) return { ok: false, code: 'BAD_ANSWER', message: '' };
  if (record.ok !== true) return refusal(record);
  const status = parseKeyStatus(record.status) ?? { providerId, configured: false, last4: null, updatedAt: null };
  return { ok: true, status, ...parseApply(record.apply) };
}

export function parseReconnectOutcome(raw: unknown): ReconnectOutcome {
  const record = asRecord(raw);
  if (!record) return { ok: false, code: 'BAD_ANSWER', message: '' };
  if (record.ok !== true) return refusal(record);
  return { ok: true, ...parseApply(record.apply) };
}

export function parseVaultList(raw: unknown): VaultList {
  const record = asRecord(raw);
  const vault = record ? asRecord(record.vault) : null;
  const reason = vault ? str(vault, 'reason') : null;
  if (!record || record.ok !== true) return { ready: false, reason, keys: [] };
  const keys = Array.isArray(record.keys)
    ? record.keys.map(parseKeyStatus).filter((key): key is VaultKeyStatus => key !== null && key.configured)
    : [];
  return { ready: vault ? str(vault, 'state') === 'ready' : true, reason, keys };
}

/**
 * Never throws. A rejected bridge call becomes `{ ok: false }` without its text (it could echo input).
 * `kind: 'reconnect'` parses a `reconnectNow()` answer instead of a KeyResult.
 */
export function callVault(call: () => Promise<unknown>, providerId: string): Promise<VaultOutcome>;
export function callVault(call: () => Promise<unknown>, providerId: string, kind: 'reconnect'): Promise<ReconnectOutcome>;
export async function callVault(
  call: () => Promise<unknown>,
  providerId: string,
  kind?: 'reconnect',
): Promise<VaultOutcome | ReconnectOutcome> {
  try {
    const raw = await call();
    return kind === 'reconnect' ? parseReconnectOutcome(raw) : parseVaultOutcome(raw, providerId);
  } catch {
    return { ok: false, code: 'BRIDGE_FAILED', message: '' };
  }
}

/** The vault's own list (desktop only); null in a browser or before the first answer. */
export function useVaultList(): { readonly list: VaultList | null; readonly refresh: () => void } {
  const [list, setList] = useState<VaultList | null>(null);
  const [token, setToken] = useState(0);
  useEffect(() => {
    const bridge = readKeysBridge();
    const listFn = bridge?.list;
    if (typeof listFn !== 'function') return undefined;
    let cancelled = false;
    listFn()
      .then((raw) => {
        if (!cancelled) setList(parseVaultList(raw));
      })
      .catch(() => {
        if (!cancelled) setList({ ready: false, reason: null, keys: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
  const refresh = useCallback(() => setToken((value) => value + 1), []);
  return { list, refresh };
}
