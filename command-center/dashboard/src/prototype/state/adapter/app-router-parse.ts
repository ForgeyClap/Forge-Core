/**
 * app-router-parse — the shapes and strict parsers of the app router slice (split out of `app-router.ts`, Q6-UI;
 * the design notes stay in that file's header). Import from `./app-router`, which re-exports everything here.
 */

import { pickArray, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';

import { parseRouterWarnings, rawEntryRecords } from './app-router-warnings';
import type { RouterWarning } from './app-router-warnings';

export type { RouterWarning } from './app-router-warnings';

/* ------------------------------------------------------------------ shapes */

export const ROUTER_MODES = ['off', 'claude-accounts', 'claude-then-model', 'model-first'] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];
export type RouterEntryKind = 'claude-account' | 'codex-account' | 'provider-model';
export type RouterStrategy = 'in-order' | 'spread';
export type RouterReturn = 'new-conversation' | 'asap';
export type RouterCapability = 'full' | 'answers-only' | 'read-answer';
export type RouterEntryState = 'exhausted' | 'needs-login' | 'down' | 'near-limit' | 'ready' | 'unknown';

/** One chain entry in its exact wire shape (snake_case), so a save round-trips byte-for-byte. */
export interface RouterEntry {
  readonly id: string;
  readonly kind: RouterEntryKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly profile?: string | null;
  readonly threshold_pct?: number | null;
  readonly provider?: string;
  readonly model?: string;
  readonly num_ctx?: number | null;
  readonly vars?: Readonly<Record<string, string>>;
  readonly paid_ack?: boolean;
  readonly notice_ack?: boolean;
}

export interface RouterDefaults {
  readonly threshold_pct: number;
  readonly cooldown_min: number;
  readonly strategy: RouterStrategy;
  readonly return: RouterReturn;
  readonly handover_turns: number;
}

export interface RouterConfig {
  readonly version: 1;
  readonly revision: number;
  readonly mode: RouterMode;
  readonly multi_account: { readonly enabled: boolean; readonly acknowledged_at: string | null };
  readonly defaults: RouterDefaults;
  readonly entries: readonly RouterEntry[];
  readonly updated_at: string | null;
}

export interface TermsSource {
  readonly title: string;
  readonly url: string;
}

export interface RouterGet {
  /** 'DEFAULT' | 'STORED' | 'UNREADABLE' (the file could not be read; defaults are shown). */
  readonly provenance: string | null;
  readonly config: RouterConfig;
  readonly termsCheckedAt: string | null;
  readonly termsSources: readonly TermsSource[];
  readonly profilesRootDisplay: string | null;
  /** Entries or fields this build could not read. More than 0 means: show, never save. */
  readonly problems: number;
  /** Chain steps the router skips (an own API that was removed or switched off). Missing in the answer = []. */
  readonly warnings: readonly RouterWarning[];
}

export interface RouterWindow {
  readonly type: string;
  /** Null when the program reported no percentage. Never 0 for "unknown". */
  readonly pct: number | null;
  readonly resetsAt: string | null;
  readonly status: string | null;
}

export interface RouterEntryStatus {
  readonly id: string;
  readonly label: string | null;
  readonly enabled: boolean | null;
  readonly eligible: boolean | null;
  readonly ineligibleReason: string | null;
  readonly state: RouterEntryState;
  readonly maxPct: number | null;
  readonly windows: readonly RouterWindow[];
  readonly measuredAt: string | null;
  readonly source: 'turn' | 'test' | null;
  readonly resumeAt: string | null;
  readonly capability: RouterCapability | null;
}

export type RouterNext =
  | { readonly kind: 'target'; readonly id: string | null; readonly label: string | null; readonly reason: string | null; readonly switched: boolean }
  | { readonly kind: 'exhausted'; readonly resumeAt: string | null; readonly firstFreeLabel: string | null; readonly firstFreeAt: string | null };

export interface RouterStatus {
  readonly mode: RouterMode | null;
  readonly entries: readonly RouterEntryStatus[];
  readonly next: RouterNext | null;
  readonly lastSwitch: { readonly from: string | null; readonly to: string | null; readonly reason: string | null; readonly at: string | null } | null;
  readonly capturedAt: string | null;
}

export interface RouterFieldError {
  readonly path: string;
  readonly code: string;
  readonly nl: string;
  readonly en: string;
}

const ENTRY_STATES: readonly RouterEntryState[] = ['exhausted', 'needs-login', 'down', 'near-limit', 'ready', 'unknown'];
const CAPABILITIES: readonly RouterCapability[] = ['full', 'answers-only', 'read-answer'];
/** A chain entry id as the gateway allows it. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/* ----------------------------------------------------------------- parsing */

function isMode(value: unknown): value is RouterMode {
  return typeof value === 'string' && (ROUTER_MODES as readonly string[]).includes(value);
}

function nullableInt(record: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function stringVars(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    out[key] = item;
  }
  return out;
}

/** One entry, or null when it is not one this build can round-trip safely. */
export function parseRouterEntry(raw: Record<string, unknown>): RouterEntry | null {
  const id = pickString(raw, ['id']);
  const kind = pickString(raw, ['kind']);
  const label = pickString(raw, ['label']);
  const enabled = pickBool(raw, ['enabled']);
  if (id === null || !ID_RE.test(id) || label === null || enabled === null) return null;
  const threshold = nullableInt(raw, 'threshold_pct');
  const base = { id, label, enabled, ...(threshold !== undefined ? { threshold_pct: threshold } : {}) };
  if (kind === 'claude-account' || kind === 'codex-account') {
    const profile = raw.profile === null || raw.profile === undefined ? null : pickString(raw, ['profile']);
    if (raw.profile !== null && raw.profile !== undefined && profile === null) return null;
    return { ...base, kind, profile };
  }
  if (kind === 'provider-model') {
    const provider = pickString(raw, ['provider']);
    const model = pickString(raw, ['model']);
    if (provider === null || model === null) return null;
    const numCtx = nullableInt(raw, 'num_ctx');
    const vars = raw.vars === undefined ? {} : stringVars(raw.vars);
    if (vars === null) return null;
    return {
      ...base,
      kind,
      provider,
      model,
      num_ctx: numCtx ?? null,
      vars,
      paid_ack: pickBool(raw, ['paid_ack']) ?? false,
      notice_ack: pickBool(raw, ['notice_ack']) ?? false,
    };
  }
  return null;
}

/** The config, or null when its frame (version, mode, defaults) is not readable at all. */
export function parseRouterConfig(raw: Record<string, unknown> | null): { config: RouterConfig; problems: number } | null {
  if (raw === null || pickNumber(raw, ['version']) !== 1) return null;
  const mode = raw.mode;
  const revision = pickNumber(raw, ['revision']);
  const defaults = pickRecord(raw, ['defaults']);
  const multi = pickRecord(raw, ['multi_account']);
  if (!isMode(mode) || revision === null || defaults === null) return null;
  const strategy = pickString(defaults, ['strategy']);
  const ret = pickString(defaults, ['return']);
  let problems = 0;
  const entries: RouterEntry[] = [];
  for (const item of pickArray(raw, ['entries'])) {
    const entry = parseRouterEntry(item);
    if (entry === null) problems += 1;
    else entries.push(entry);
  }
  if (Array.isArray(raw.entries) && raw.entries.length !== pickArray(raw, ['entries']).length) problems += 1;
  return {
    problems,
    config: {
      version: 1,
      revision,
      mode,
      multi_account: {
        enabled: (multi && pickBool(multi, ['enabled'])) ?? false,
        acknowledged_at: multi ? pickString(multi, ['acknowledged_at']) : null,
      },
      defaults: {
        threshold_pct: pickNumber(defaults, ['threshold_pct']) ?? 92,
        cooldown_min: pickNumber(defaults, ['cooldown_min']) ?? 10,
        strategy: strategy === 'spread' ? 'spread' : 'in-order',
        return: ret === 'asap' ? 'asap' : 'new-conversation',
        handover_turns: pickNumber(defaults, ['handover_turns']) ?? 12,
      },
      entries,
      updated_at: pickString(raw, ['updated_at']),
    },
  };
}

/** `GET /api/app-router`. Null when the answer carries no readable config (an older gateway). */
export function parseRouterGet(data: Record<string, unknown>): RouterGet | null {
  const rawConfig = pickRecord(data, ['config']);
  const parsed = parseRouterConfig(rawConfig);
  if (parsed === null) return null;
  const terms = pickRecord(data, ['terms']);
  const sources: TermsSource[] = [];
  for (const source of terms ? pickArray(terms, ['sources']) : []) {
    const title = pickString(source, ['title']);
    const url = pickString(source, ['url']);
    // Only plain https links to the vendor pages are rendered as links.
    if (title !== null && url !== null && /^https:\/\/[a-z0-9.-]+\//i.test(url)) sources.push({ title, url });
  }
  return {
    provenance: pickString(data, ['provenance']),
    config: parsed.config,
    termsCheckedAt: terms ? pickString(terms, ['checked_at']) : null,
    termsSources: sources,
    profilesRootDisplay: pickString(data, ['profiles_root_display']),
    problems: parsed.problems,
    warnings: parseRouterWarnings(data, rawEntryRecords(rawConfig)),
  };
}

export function parseWindow(raw: Record<string, unknown>): RouterWindow {
  return {
    type: pickString(raw, ['type']) ?? 'other',
    pct: pickNumber(raw, ['pct']),
    resetsAt: pickString(raw, ['resets_at']),
    status: pickString(raw, ['status']),
  };
}

function parseNext(raw: Record<string, unknown> | null): RouterNext | null {
  if (raw === null) return null;
  const kind = pickString(raw, ['kind']);
  if (kind === 'exhausted') {
    const free = pickRecord(raw, ['first_free']);
    return {
      kind: 'exhausted',
      resumeAt: pickString(raw, ['resume_at']),
      firstFreeLabel: free ? pickString(free, ['label']) : pickString(raw, ['first_free']),
      firstFreeAt: free ? pickString(free, ['resume_at']) : null,
    };
  }
  if (kind === 'target') {
    const entry = pickRecord(raw, ['entry']);
    return {
      kind: 'target',
      id: entry ? pickString(entry, ['id']) : pickString(raw, ['entry']),
      label: entry ? pickString(entry, ['label']) : null,
      reason: pickString(raw, ['reason']),
      switched: pickBool(raw, ['switched']) ?? false,
    };
  }
  return null;
}

/** `GET /api/app-router/status`. */
export function parseRouterStatus(data: Record<string, unknown>): RouterStatus {
  const entries: RouterEntryStatus[] = [];
  for (const raw of pickArray(data, ['entries'])) {
    const id = pickString(raw, ['id']);
    if (id === null) continue;
    const state = pickString(raw, ['state']);
    const capability = pickString(raw, ['capability']);
    const source = pickString(raw, ['source']);
    entries.push({
      id,
      label: pickString(raw, ['label']),
      enabled: pickBool(raw, ['enabled']),
      eligible: pickBool(raw, ['eligible']),
      ineligibleReason: pickString(raw, ['ineligible_reason']),
      state: ENTRY_STATES.includes(state as RouterEntryState) ? (state as RouterEntryState) : 'unknown',
      maxPct: pickNumber(raw, ['max_pct']),
      windows: pickArray(raw, ['windows']).map(parseWindow),
      measuredAt: pickString(raw, ['measured_at']),
      source: source === 'turn' || source === 'test' ? source : null,
      resumeAt: pickString(raw, ['resume_at']),
      capability: CAPABILITIES.includes(capability as RouterCapability) ? (capability as RouterCapability) : null,
    });
  }
  const sw = pickRecord(data, ['last_switch']);
  const mode = data.mode;
  return {
    mode: isMode(mode) ? mode : null,
    entries,
    next: parseNext(pickRecord(data, ['next'])),
    lastSwitch: sw
      ? { from: pickString(sw, ['from']), to: pickString(sw, ['to']), reason: pickString(sw, ['reason']), at: pickString(sw, ['at']) }
      : null,
    capturedAt: pickString(data, ['captured_at']),
  };
}

export function parseFieldErrors(data: Record<string, unknown>): readonly RouterFieldError[] {
  return pickArray(data, ['errors']).map((raw) => ({
    path: pickString(raw, ['path']) ?? '',
    code: pickString(raw, ['code']) ?? 'invalid',
    nl: pickString(raw, ['nl']) ?? '',
    en: pickString(raw, ['en']) ?? '',
  }));
}
