/**
 * The chat error catalogue (WP B3, plan §3.2 + §5 row B3).
 *
 * One table: an error code from the gateway (`gateway/src/error-catalogue.mjs`, same codes, see
 * `_scratch/b3/contract-permissions.md`) -> a Dutch title, one sentence and ONE button with an
 * action id. The parent decides what an action does (open the sign-in, retry the turn, ...); the
 * card never shows a terminal command and never shows raw error output in its text. Details the
 * gateway sends (already redacted there) are redacted a second time here and only appear folded
 * away under "Technische details".
 */

import type { MessageKey, MessageVars } from '@/i18n';

export const CHAT_ERROR_CODES = [
  'cli_missing',
  'logged_out',
  'rate_limited',
  'offline',
  'api_retry',
  'ollama_down',
  'model_not_pulled',
  'gateway_restarted',
  'unknown',
] as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** What the one button asks the parent to do. */
export type ChatErrorAction =
  | 'install_claude'
  | 'sign_in'
  | 'auto_resume'
  | 'retry'
  | 'stop'
  | 'start_ollama'
  | 'pull_model'
  | 'resend';

/** `info` = it is still going (a retry); `pause` = the work stands still until something happens. */
export type ChatErrorTone = 'info' | 'pause';

export interface ChatErrorPayload {
  readonly code: ChatErrorCode;
  readonly resume_at?: string | null;
  readonly model?: string | null;
  readonly attempt?: number | null;
  readonly max_attempts?: number | null;
  readonly details?: string | null;
}

interface CatalogueEntry {
  readonly action: ChatErrorAction;
  readonly tone: ChatErrorTone;
  readonly icon: string;
}

export const ERROR_CATALOGUE: Readonly<Record<ChatErrorCode, CatalogueEntry>> = {
  cli_missing: { action: 'install_claude', tone: 'pause', icon: 'Download' },
  logged_out: { action: 'sign_in', tone: 'pause', icon: 'Lock' },
  rate_limited: { action: 'auto_resume', tone: 'pause', icon: 'Hourglass' },
  offline: { action: 'retry', tone: 'pause', icon: 'Unplug' },
  api_retry: { action: 'stop', tone: 'info', icon: 'RefreshCw' },
  ollama_down: { action: 'start_ollama', tone: 'pause', icon: 'Cpu' },
  model_not_pulled: { action: 'pull_model', tone: 'pause', icon: 'Download' },
  gateway_restarted: { action: 'resend', tone: 'pause', icon: 'RotateCcw' },
  unknown: { action: 'retry', tone: 'pause', icon: 'CircleAlert' },
};

export function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === 'string' && (CHAT_ERROR_CODES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Validates whatever the gateway (or a stream event) sent. An unrecognised code becomes `unknown`. */
export function normalizeChatError(raw: unknown): ChatErrorPayload {
  const row = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    code: isChatErrorCode(row.code) ? row.code : 'unknown',
    resume_at: optionalString(row.resume_at),
    model: optionalString(row.model),
    attempt: optionalCount(row.attempt),
    max_attempts: optionalCount(row.max_attempts),
    details: optionalString(row.details),
  };
}

/* ------------------------------------------------------------------ redaction */

const DETAILS_MAX = 600;

/**
 * A second redaction pass over details the gateway already redacted: secrets, e-mail addresses
 * and the user's own folder name are removed, and the text is cut to a readable length.
 */
export function redactDetails(text: string): string {
  let out = text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[sleutel]')
    .replace(/\bbearer\s+[^\s"']+/gi, 'Bearer [weggelaten]')
    .replace(/\b(token|api[_-]?key|authorization|password|secret)(\s*[:=]\s*|\s+)("?)(?!Bearer\b|\[)[^\s"']{6,}\3/gi, '$1$2[weggelaten]')
    .replace(/\b[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)=\S+/g, (match) => `${match.split('=')[0]}=[weggelaten]`)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[e-mail]')
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1…')
    .replace(/(\/(?:home|Users)\/)[^/\s"']+/g, '$1…')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[weggelaten]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[weggelaten]');
  out = out.trim();
  return out.length > DETAILS_MAX ? `${out.slice(0, DETAILS_MAX).trimEnd()}…` : out;
}

/* ------------------------------------------------------------------ copy */

/** "14:30" in the given locale; null for a missing or unreadable time. */
export function formatClock(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locale === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

export interface ErrorCopy {
  readonly title: [MessageKey, MessageVars?];
  readonly body: [MessageKey, MessageVars?];
  readonly action: [MessageKey, MessageVars?];
  /** Only for rate_limited: the button label once automatic continuing is switched on. */
  readonly actionOn: [MessageKey, MessageVars?] | null;
}

/** The message keys (and their variables) for one error. Pure, so the test can check every code. */
export function errorCopy(error: ChatErrorPayload, locale: string): ErrorCopy {
  const code = error.code;
  const base = `chatCards.errors.${code}` as const;
  const title: [MessageKey] = [`${base}.title`];
  const action: [MessageKey] = [`${base}.action`];
  switch (code) {
    case 'rate_limited': {
      const time = formatClock(error.resume_at, locale);
      return {
        title,
        body: time ? ['chatCards.errors.rate_limited.body', { time }] : ['chatCards.errors.rate_limited.bodyNoTime'],
        action,
        actionOn: time ? ['chatCards.errors.rate_limited.actionOn', { time }] : ['chatCards.errors.rate_limited.actionOnNoTime'],
      };
    }
    case 'api_retry':
      return {
        title,
        body:
          error.attempt != null && error.max_attempts != null && error.max_attempts > 0
            ? ['chatCards.errors.api_retry.body', { attempt: error.attempt, max: error.max_attempts }]
            : ['chatCards.errors.api_retry.bodyNoCount'],
        action,
        actionOn: null,
      };
    case 'model_not_pulled':
      return {
        title,
        body: error.model ? ['chatCards.errors.model_not_pulled.body', { model: error.model }] : ['chatCards.errors.model_not_pulled.bodyNoModel'],
        action,
        actionOn: null,
      };
    default:
      return { title, body: [`${base}.body`], action, actionOn: null };
  }
}
