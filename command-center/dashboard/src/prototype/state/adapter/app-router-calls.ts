/**
 * app-router-calls — the app router's POST calls and the one-off status read (split out of `app-router.ts`,
 * Q6-UI). Every call keeps the HTTP status AND the body. Import from `./app-router`.
 *   POST /api/app-router                    {ok, config, warnings} (C3: warnings of the just-stored config)
 *   POST /api/app-router/profiles           a new profile folder + chain entry
 *   POST /api/app-router/targets/:id/test   one probe; 409 entry_unusable for a step the router skips (C2)
 */

import { isPairingRequired, setPairingState } from '@/lib/ui-session';
import { EXEC_TOKEN_HEADER, gatewayUrl, gwGet, pickArray, pickNumber, pickRecord, pickString, readExecToken, writeCredentials } from '@/prototype/state/gateway-client';

import { ID_RE, parseFieldErrors, parseRouterConfig, parseRouterEntry, parseRouterStatus, parseWindow } from './app-router-parse';
import type { RouterConfig, RouterEntry, RouterFieldError, RouterStatus, RouterWindow } from './app-router-parse';
import { parseRouterWarnings, rawEntryRecords } from './app-router-warnings';
import type { RouterWarning } from './app-router-warnings';
import { signalRouterChanged } from './router-refresh';

/* --------------------------------------------------------------- transport */

interface RawAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** A transport failure (no answer at all), else null. */
  readonly networkError: string | null;
}

/** One call that keeps the HTTP status AND the body (the shared helpers drop both on an error). */
async function call(method: 'POST', path: string, body: unknown): Promise<RawAnswer> {
  const token = readExecToken();
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), {
      method,
      headers: { 'content-type': 'application/json', ...(token !== null ? { [EXEC_TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(body),
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
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { status: res.status, body: record, networkError: null };
}

function errorText(answer: RawAnswer): string {
  return answer.networkError ?? pickString(answer.body, ['error']) ?? `HTTP ${answer.status}`;
}

export type SaveOutcome =
  /** `warnings`: the gateway's warnings for the just-stored config (C3); null = this gateway did not send them. */
  | { readonly kind: 'saved'; readonly config: RouterConfig; readonly warnings: readonly RouterWarning[] | null }
  | { readonly kind: 'invalid'; readonly errors: readonly RouterFieldError[] }
  | { readonly kind: 'stale'; readonly config: RouterConfig | null }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'too-many' }
  | { readonly kind: 'failed'; readonly error: string };

export async function saveRouterConfig(config: RouterConfig): Promise<SaveOutcome> {
  const answer = await call('POST', '/api/app-router', config);
  if (answer.status === 200) {
    const rawConfig = pickRecord(answer.body, ['config']);
    const parsed = parseRouterConfig(rawConfig);
    if (parsed === null) return { kind: 'failed', error: 'no config in the answer' };
    const warnings = Array.isArray(answer.body.warnings) ? parseRouterWarnings(answer.body, rawEntryRecords(rawConfig)) : null;
    return { kind: 'saved', config: parsed.config, warnings };
  }
  if (answer.status === 400) return { kind: 'invalid', errors: parseFieldErrors(answer.body) };
  if (answer.status === 409) return { kind: 'stale', config: parseRouterConfig(pickRecord(answer.body, ['config']))?.config ?? null };
  if (answer.status === 403) return { kind: 'refused', error: errorText(answer) };
  if (answer.status === 429) return { kind: 'too-many' };
  return { kind: 'failed', error: errorText(answer) };
}

export interface LoginCommands {
  readonly powershell: string;
  readonly cmd: string;
  readonly posix: string;
}

export type ProfileOutcome =
  | { readonly kind: 'created'; readonly entry: RouterEntry; readonly config: RouterConfig; readonly login: LoginCommands; readonly dirDisplay: string | null }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'exists'; readonly error: string }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'failed'; readonly error: string };

export async function createProfile(label: string): Promise<ProfileOutcome> {
  const answer = await call('POST', '/api/app-router/profiles', { label });
  if (answer.status === 201 || answer.status === 200) {
    const entryRaw = pickRecord(answer.body, ['entry']);
    const entry = entryRaw ? parseRouterEntry(entryRaw) : null;
    const parsed = parseRouterConfig(pickRecord(answer.body, ['config']));
    const login = pickRecord(answer.body, ['login']);
    const powershell = login ? pickString(login, ['powershell']) : null;
    if (entry === null || parsed === null || login === null || powershell === null) return { kind: 'failed', error: 'incomplete answer' };
    return {
      kind: 'created',
      entry,
      config: parsed.config,
      login: { powershell, cmd: pickString(login, ['cmd']) ?? '', posix: pickString(login, ['posix']) ?? '' },
      dirDisplay: pickString(answer.body, ['dir_display']),
    };
  }
  if (answer.status === 400) return { kind: 'invalid', error: errorText(answer) };
  if (answer.status === 409) return { kind: 'exists', error: errorText(answer) };
  if (answer.status === 403) return { kind: 'refused', error: errorText(answer) };
  return { kind: 'failed', error: errorText(answer) };
}

export type TestOutcome =
  | { readonly kind: 'done'; readonly state: string; readonly windows: readonly RouterWindow[]; readonly detail: string | null; readonly at: string }
  | { readonly kind: 'too-soon'; readonly retryAfterS: number | null }
  /** 409 entry_unusable (C2): the router skips this step, so nothing was probed. `nl`/`en` = the gateway's words. */
  | { readonly kind: 'unusable'; readonly reason: string; readonly nl: string; readonly en: string }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'failed'; readonly error: string };

export async function testTarget(id: string, now: () => Date = () => new Date()): Promise<TestOutcome> {
  if (!ID_RE.test(id)) return { kind: 'failed', error: 'bad id' };
  const answer = await call('POST', `/api/app-router/targets/${encodeURIComponent(id)}/test`, {});
  if (answer.status === 200) {
    const reading = pickRecord(answer.body, ['reading']);
    return {
      kind: 'done',
      state: pickString(answer.body, ['state']) ?? 'unknown',
      windows: reading ? pickArray(reading, ['windows']).map(parseWindow) : [],
      detail: pickString(answer.body, ['detail']),
      at: now().toISOString(),
    };
  }
  if (answer.status === 429) return { kind: 'too-soon', retryAfterS: pickNumber(answer.body, ['retry_after_s']) };
  if (answer.status === 409 && pickString(answer.body, ['error']) === 'entry_unusable') {
    // The gateway knows this step is skipped: the router chain (and the Eigen API section's "in use" state)
    // may read differently than what this page loaded, so both re-read (Q6-SHOTS note 3).
    signalRouterChanged();
    return {
      kind: 'unusable',
      reason: pickString(answer.body, ['reason']) ?? 'unknown',
      nl: (pickString(answer.body, ['nl']) ?? '').slice(0, 240),
      en: (pickString(answer.body, ['en']) ?? '').slice(0, 240),
    };
  }
  if (answer.status === 403) return { kind: 'refused', error: errorText(answer) };
  return { kind: 'failed', error: errorText(answer) };
}

/** `GET /api/app-router/status?conversation=<id>` once (the chat's "continue on …" button). */
export async function readRouterStatus(conversationId: string | null = null): Promise<RouterStatus | null> {
  const query = conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : '';
  const result = await gwGet(`/api/app-router/status${query}`);
  return result.ok ? parseRouterStatus(result.data) : null;
}
