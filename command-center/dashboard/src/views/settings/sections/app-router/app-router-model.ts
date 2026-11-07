/**
 * app-router-model — pure helpers for the Forge router settings (APP-ROUTER-DESIGN.md §1, §2.4, §2.5, §6.2).
 *
 * - `presetOrder`: choosing a mode re-sorts the entries into that mode's preset order (§1).
 * - `effectiveIds`: a mirror of the server's `effectiveChain` for the grey "switching is off" rows (§2.5).
 * - `validateDraft`: a MIRROR of the server validation for instant feedback; the server stays authoritative
 *   (a 400 answer still wins, field by field).
 * - `entryPill`: the state word and tone of one entry (§6.2 states).
 * No React, no network: everything here is table-tested.
 */

import type { MessageKey, MessageVars } from '@/i18n';
import type { ProviderRow } from '@/prototype/state/adapter/providers';
import type {
  RouterConfig,
  RouterEntry,
  RouterEntryStatus,
  RouterMode,
  TestOutcome,
} from '@/prototype/state/adapter/app-router';

export const THRESHOLD_MIN = 50;
export const THRESHOLD_MAX = 99;
export const COOLDOWN_RANGE = [1, 240] as const;
export const HANDOVER_RANGE = [2, 40] as const;
export const NUM_CTX_RANGE = [2048, 131072] as const;
export const MAX_ENTRIES = 12;
export const MAX_CLAUDE = 8;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const isClaude = (entry: RouterEntry): boolean => entry.kind === 'claude-account';
export const isFallback = (entry: RouterEntry): boolean => entry.kind === 'provider-model' || entry.kind === 'codex-account';

/** 0 = first. Claude first for a and b, own models first for c (§1). */
function rank(entry: RouterEntry, mode: RouterMode): number {
  if (mode === 'model-first') return entry.kind === 'provider-model' ? 0 : entry.kind === 'codex-account' ? 1 : 2;
  return entry.kind === 'claude-account' ? 0 : entry.kind === 'codex-account' ? 1 : 2;
}

/** Stable re-sort into the mode's preset order; the order within one kind is kept. */
export function presetOrder(entries: readonly RouterEntry[], mode: RouterMode): readonly RouterEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry, mode) - rank(b.entry, mode) || a.index - b.index)
    .map((item) => item.entry);
}

/** The ids the router may use, in order (server: `effectiveChain`). */
export function effectiveIds(config: RouterConfig): readonly string[] {
  if (config.mode === 'off') return [];
  let enabled = config.entries.filter((entry) => entry.enabled);
  if (config.mode === 'claude-accounts') enabled = enabled.filter(isClaude);
  if (!config.multi_account.enabled) {
    const firstClaude = enabled.find(isClaude);
    enabled = enabled.filter((entry) => !isClaude(entry) || entry === firstClaude);
  }
  return enabled.map((entry) => entry.id);
}

/** True when an enabled Claude account is skipped only because switching between accounts is off. */
export function greyedByGate(config: RouterConfig, entry: RouterEntry): boolean {
  if (!isClaude(entry) || !entry.enabled || config.mode === 'off' || config.multi_account.enabled) return false;
  return !effectiveIds(config).includes(entry.id);
}

export interface DraftIssue {
  /** Same path style as the server: `mode`, `entries[2].threshold_pct`, `defaults.cooldown_min`. */
  readonly path: string;
  readonly key: MessageKey;
  readonly vars?: MessageVars;
}

function inRange(value: number | null | undefined, [min, max]: readonly [number, number]): boolean {
  return value === null || value === undefined || (Number.isInteger(value) && value >= min && value <= max);
}

export interface ProviderFacts {
  /** True when the provider is paid per use with the user's own key. */
  readonly paid: boolean;
  /** True for a remote service with a terms notice (for example Ollama Cloud). */
  readonly notice: boolean;
}

/** Client-side mirror of §2.4 (the subset a user can break from this screen). */
export function validateDraft(config: RouterConfig, facts: (provider: string) => ProviderFacts): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];
  const enabled = config.entries.filter((entry) => entry.enabled);
  const claude = enabled.filter(isClaude);
  const fallbacks = enabled.filter(isFallback);
  if (config.entries.length > MAX_ENTRIES) issues.push({ path: 'entries', key: 'appRouter.issues.tooMany', vars: { max: MAX_ENTRIES } });
  if (config.entries.filter(isClaude).length > MAX_CLAUDE) issues.push({ path: 'entries', key: 'appRouter.issues.tooManyClaude', vars: { max: MAX_CLAUDE } });
  if (config.mode === 'claude-accounts') {
    if (!config.multi_account.enabled) issues.push({ path: 'multi_account', key: 'appRouter.issues.ackNeeded' });
    if (claude.length < 2) issues.push({ path: 'mode', key: 'appRouter.issues.needsTwo' });
  }
  if (config.mode === 'claude-then-model') {
    if (claude.length === 0) issues.push({ path: 'mode', key: 'appRouter.issues.needsClaude' });
    if (fallbacks.length === 0) issues.push({ path: 'fallback', key: 'appRouter.issues.fallbackMissing' });
  }
  if (config.mode === 'model-first') {
    if (fallbacks.length === 0) issues.push({ path: 'fallback', key: 'appRouter.issues.fallbackMissing' });
    else if (enabled.length > 0 && !isFallback(enabled[0])) issues.push({ path: 'mode', key: 'appRouter.issues.modelFirstOrder' });
  }
  config.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (entry.label.trim().length === 0 || entry.label.length > 40) issues.push({ path: `${at}.label`, key: 'appRouter.issues.label' });
    if (!inRange(entry.threshold_pct, [THRESHOLD_MIN, THRESHOLD_MAX])) {
      issues.push({ path: `${at}.threshold_pct`, key: 'appRouter.issues.threshold', vars: { min: THRESHOLD_MIN, max: THRESHOLD_MAX } });
    }
    if (entry.kind === 'provider-model' && entry.provider) {
      if (!inRange(entry.num_ctx, NUM_CTX_RANGE)) issues.push({ path: `${at}.num_ctx`, key: 'appRouter.issues.numCtx', vars: { min: NUM_CTX_RANGE[0], max: NUM_CTX_RANGE[1] } });
      const port = entry.vars?.port;
      if (port !== undefined && !/^[0-9]{2,5}$/.test(port)) issues.push({ path: `${at}.vars`, key: 'appRouter.issues.port' });
      const fact = facts(entry.provider);
      if (entry.enabled && fact.paid && entry.paid_ack !== true) issues.push({ path: `${at}.paid_ack`, key: 'appRouter.issues.paidAck' });
      if (entry.enabled && fact.notice && entry.notice_ack !== true) issues.push({ path: `${at}.notice_ack`, key: 'appRouter.issues.noticeAck' });
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(entry.model ?? '')) issues.push({ path: `${at}.model`, key: 'appRouter.issues.model' });
    }
  });
  if (!inRange(config.defaults.cooldown_min, COOLDOWN_RANGE)) {
    issues.push({ path: 'defaults.cooldown_min', key: 'appRouter.issues.range', vars: { min: COOLDOWN_RANGE[0], max: COOLDOWN_RANGE[1] } });
  }
  if (!inRange(config.defaults.handover_turns, HANDOVER_RANGE)) {
    issues.push({ path: 'defaults.handover_turns', key: 'appRouter.issues.range', vars: { min: HANDOVER_RANGE[0], max: HANDOVER_RANGE[1] } });
  }
  return issues;
}

/** `entries.2.x` and `entries[2].x` mean the same field. */
export function normalizePath(path: string): string {
  return path.replace(/\.(\d+)(?=\.|$)/g, '[$1]');
}

/** The mode change of §1: re-sort, and add the multi-account requirement only where the mode needs it. */
export function withMode(config: RouterConfig, mode: RouterMode): RouterConfig {
  return { ...config, mode, entries: mode === 'off' ? config.entries : presetOrder(config.entries, mode) };
}

export function moveEntry(entries: readonly RouterEntry[], index: number, delta: -1 | 1): readonly RouterEntry[] {
  const target = index + delta;
  if (index < 0 || target < 0 || index >= entries.length || target >= entries.length) return entries;
  const next = [...entries];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function replaceEntry(config: RouterConfig, id: string, patch: Partial<RouterEntry>): RouterConfig {
  return { ...config, entries: config.entries.map((entry) => (entry.id === id ? ({ ...entry, ...patch } as RouterEntry) : entry)) };
}

/** A free chain id from a provider + model ("ollama-local" + "llama3.1:8b" -> "ollama-local-llama3-1-8b"). */
export function fallbackEntryId(provider: string, model: string, taken: ReadonlySet<string>): string {
  const base =
    `${provider}-${model}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'model';
  const safe = /^[a-z0-9]/.test(base) && !/^(main|con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base) ? base : `m-${base}`.slice(0, 28);
  if (!taken.has(safe)) return safe;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${safe}-${n}`;
    if (!taken.has(candidate) && ID_RE.test(candidate)) return candidate;
  }
  return `${safe.slice(0, 20)}-${taken.size}`;
}

/** "Ollama · llama3.1:8b", at most 40 characters (the schema limit). */
export function fallbackLabel(providerName: string, model: string): string {
  const label = `${providerName} · ${model}`;
  return label.length <= 40 ? label : `${label.slice(0, 39)}…`;
}

/* ------------------------------------------------------------- state pills */

export type PillTone = 'ok' | 'warn' | 'bad' | 'off' | 'busy';

export interface Pill {
  readonly tone: PillTone;
  readonly key: MessageKey;
  readonly vars?: MessageVars;
}

export function clock(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locale === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

export const STALE_MS = 15 * 60_000;

export interface PillInput {
  readonly entry: RouterEntry;
  readonly status: RouterEntryStatus | null;
  readonly greyed: boolean;
  readonly testing: boolean;
  readonly test: TestOutcome | null;
  readonly locale: string;
  readonly now: number;
}

/** The reasons for which the router skips a step that is switched on (gateway routes/app-router.mjs statusRow). */
export const SKIP_REASONS: ReadonlySet<string> = new Set(['paid_ack_required', 'provider_unavailable']);

/**
 * The pill of a step the router skips, else null: a missing cost confirmation asks for it, a gone own API says
 * "Niet beschikbaar" (Q7-FINISH: a short pill; the full reason sits in the step's note and the chat skip line).
 */
export function skipPill(_entry: RouterEntry, reason: string | null): Pill | null {
  if (reason === 'paid_ack_required') return { tone: 'warn', key: 'appRouter.issues.paidAck' };
  if (reason === 'provider_unavailable') return { tone: 'warn', key: 'appRouter.state.unavailable' };
  return null;
}

/** The one state word of an entry (§6.2). A test the user just ran wins over everything but "testing". */
export function entryPill({ entry, status, greyed, testing, test, locale, now }: PillInput): Pill {
  if (testing) return { tone: 'busy', key: 'appRouter.state.testing' };
  // A test the user just ran wins: its answer is the newest fact (the gate reason stays visible below).
  if (test?.kind === 'done') {
    const state = test.state;
    if (state === 'logged_out' || state === 'needs-login') return { tone: 'bad', key: 'appRouter.state.loggedOut' };
    if (state === 'model_not_pulled') return { tone: 'bad', key: 'appRouter.state.notPulled' };
    if (state === 'ollama_down' || state === 'offline' || state === 'down') return { tone: 'bad', key: 'appRouter.state.down' };
    if (state === 'rate_limited' || state === 'exhausted') return { tone: 'warn', key: 'appRouter.state.limitNoTime' };
    if (state === 'error') return { tone: 'bad', key: 'appRouter.state.testFailed' };
    const time = clock(test.at, locale) ?? '';
    return { tone: 'ok', key: entry.kind === 'provider-model' ? 'appRouter.state.answers' : 'appRouter.state.signedIn', vars: { time } };
  }
  if (!entry.enabled) return { tone: 'off', key: 'appRouter.state.disabled' };
  if (greyed) return { tone: 'off', key: 'appRouter.state.gated' };
  // Q7: a step the router skips is never "ready", whatever its last reading said (the status row's reason wins).
  const skipped = skipPill(entry, status?.ineligibleReason ?? null);
  if (skipped) return skipped;
  const state = status?.state ?? 'unknown';
  if (state === 'exhausted') {
    const time = clock(status?.resumeAt, locale);
    return time ? { tone: 'warn', key: 'appRouter.state.limit', vars: { time } } : { tone: 'warn', key: 'appRouter.state.limitNoTime' };
  }
  if (state === 'needs-login') return { tone: 'bad', key: 'appRouter.state.loggedOut' };
  if (state === 'down') return { tone: 'bad', key: entry.provider === 'ollama-local' ? 'appRouter.state.ollamaDown' : 'appRouter.state.down' };
  if (state === 'near-limit') return { tone: 'warn', key: 'appRouter.state.nearLimit', vars: { pct: status?.maxPct ?? '?' } };
  const measured = status?.measuredAt ? Date.parse(status.measuredAt) : NaN;
  const stale = Number.isFinite(measured) && now - measured > STALE_MS;
  if (state === 'ready' && !stale) return { tone: 'ok', key: 'appRouter.state.ready' };
  // Unknown: an extra profile that was never measured is honestly "not tested yet".
  if (!Number.isFinite(measured) && entry.kind === 'claude-account' && entry.profile) return { tone: 'off', key: 'appRouter.state.untested' };
  return { tone: 'off', key: 'appRouter.state.unknown' };
}

export const WINDOW_KEYS: Readonly<Record<string, MessageKey>> = {
  five_hour: 'appRouter.window.five_hour',
  seven_day: 'appRouter.window.seven_day',
  seven_day_opus: 'appRouter.window.seven_day_opus',
  seven_day_sonnet: 'appRouter.window.seven_day_sonnet',
};

export function windowKey(type: string | null | undefined): MessageKey {
  return (type && WINDOW_KEYS[type]) || 'appRouter.window.other';
}

/** "~\.forge-router\profiles" + "werk" with the separator the root already uses. */
export function profileFolder(root: string | null, profile: string): string | null {
  if (!root) return null;
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${profile}`;
}

/* ------------------------------------------------------- modes and fallbacks */

export const OLLAMA_LOCAL = 'ollama-local';

/** The services a fallback may use: never a sign-in program (those are `cli-*` on the gateway). */
export function fallbackProviders(rows: readonly ProviderRow[] | null): readonly ProviderRow[] {
  const usable = (rows ?? []).filter(
    (row) =>
      row.kind !== 'subscription' &&
      (row.id === OLLAMA_LOCAL || (row.kind === 'local' && (row.status === 'running' || row.status === 'connected')) || (row.kind === 'key' && row.keySource !== null)),
  );
  return [...usable].sort((a, b) => (a.id === OLLAMA_LOCAL ? -1 : b.id === OLLAMA_LOCAL ? 1 : 0));
}

/** The first enabled fallback in the stored order (what Eenvoudig shows and edits). */
export function currentFallback(config: RouterConfig): RouterEntry | null {
  return config.entries.find((entry) => isFallback(entry) && entry.enabled) ?? config.entries.find(isFallback) ?? null;
}

