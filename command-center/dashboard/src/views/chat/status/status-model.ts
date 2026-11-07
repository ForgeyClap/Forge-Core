/**
 * The chat status model (WP B3, plan §4.2 "Statussen").
 *
 * Uitgebreid shows nine work states by name; Eenvoudig folds them into the four words of plan §4.2
 * and PRODUCT-CARD.md (Lead decision 2026-11-02): Bezig, Wacht op jou, Gepauzeerd, Mislukt. The nine
 * are the names the logs and the protocol use (`src/shared/protocol.ts` OperationalStatus), so the
 * advanced view and the logs agree.
 *
 * Mapping (the table below is the source of truth; `chat-status-model.test` checks every row):
 *
 *   QUEUED, STARTING, STREAMING, RETRYING        -> busy     (Bezig)
 *   WAITING_FOR_PERMISSION, WAITING              -> waiting  (Wacht op jou)
 *   INTERRUPTED                                  -> paused   (Gepauzeerd)
 *   FAILED (and FAILED_RECOVERY via the run)     -> failed   (Mislukt)
 *   COMPLETED                                    -> null     (no chip: the answer itself shows it)
 *
 * A failed run never shows the chip alone: `errorCardFor` gives the error card that sits next to it
 * (the catalogue code when known, else the "unknown" card). An unanswered permission is never a
 * failure at all: it is "Wacht op jou", and after a long wait the gateway calls it paused.
 */

import type { OperationalStatus } from '@/shared/protocol';

import type { ChatErrorPayload } from '../errors/error-catalogue';

export const PROTOCOL_STATES = [
  'QUEUED',
  'STARTING',
  'STREAMING',
  'RETRYING',
  'WAITING_FOR_PERMISSION',
  'WAITING',
  'INTERRUPTED',
  'FAILED',
  'COMPLETED',
] as const;
export type ProtocolState = (typeof PROTOCOL_STATES)[number];

export const SIMPLE_STATES = ['busy', 'waiting', 'paused', 'failed'] as const;
export type SimpleState = (typeof SIMPLE_STATES)[number];

/** null = no chip (COMPLETED). */
export const SIMPLE_FOR: Readonly<Record<ProtocolState, SimpleState | null>> = {
  QUEUED: 'busy',
  STARTING: 'busy',
  STREAMING: 'busy',
  RETRYING: 'busy',
  WAITING_FOR_PERMISSION: 'waiting',
  WAITING: 'waiting',
  INTERRUPTED: 'paused',
  FAILED: 'failed',
  COMPLETED: null,
};

/** The Eenvoudig word for a state; null for COMPLETED, which shows no chip. */
export function toSimpleState(state: ProtocolState): SimpleState | null {
  return SIMPLE_FOR[state];
}

/**
 * The error card to show for this state. A failed run ALWAYS gets one: the classified error when the
 * gateway sent it, else the "unknown" card (never a bare "Mislukt" without an explanation). In every
 * other state the error passes through as it is (rate_limited, offline, ... sit next to Gepauzeerd).
 */
export function errorCardFor(state: ProtocolState | null, error: ChatErrorPayload | null | undefined): ChatErrorPayload | null {
  if (error) return error;
  return state === 'FAILED' ? { code: 'unknown' } : null;
}

export function isProtocolState(value: unknown): value is ProtocolState {
  return typeof value === 'string' && (PROTOCOL_STATES as readonly string[]).includes(value);
}

/**
 * The run's own operational status (`src/shared/protocol.ts`, 23 values) folded onto the nine.
 * Checking, reviewing and repairing are still "working" for the user; every way a run can stand
 * still without being finished or failed (stopped, disconnected, resumable, blocked) is INTERRUPTED.
 */
export const FROM_OPERATIONAL: Readonly<Record<OperationalStatus, ProtocolState>> = {
  CREATED: 'QUEUED',
  QUEUED: 'QUEUED',
  STARTING: 'STARTING',
  RUNNING: 'STREAMING',
  STREAMING: 'STREAMING',
  VERIFYING: 'STREAMING',
  REVIEWING: 'STREAMING',
  REPAIRING: 'STREAMING',
  RECOVERING: 'STREAMING',
  RETRYING: 'RETRYING',
  WAITING_FOR_PERMISSION: 'WAITING_FOR_PERMISSION',
  WAITING: 'WAITING',
  STOPPING: 'INTERRUPTED',
  CANCELLED: 'INTERRUPTED',
  INTERRUPTED: 'INTERRUPTED',
  DISCONNECTED: 'INTERRUPTED',
  RESUMABLE: 'INTERRUPTED',
  ORPHANED: 'INTERRUPTED',
  BLOCKED: 'INTERRUPTED',
  DEGRADED: 'INTERRUPTED',
  FAILED: 'FAILED',
  FAILED_RECOVERY: 'FAILED',
  COMPLETED: 'COMPLETED',
};

/** What a chat view knows about the current turn. Every field is optional. */
export interface ChatSignals {
  readonly queued?: boolean;
  readonly starting?: boolean;
  readonly streaming?: boolean;
  /** Number of permission requests waiting for an answer. */
  readonly pendingPermissions?: number;
  /** A question to the user (ask-questions dialog) is open. */
  readonly pendingQuestion?: boolean;
  readonly error?: ChatErrorPayload | null;
  /** The user pressed stop. */
  readonly interrupted?: boolean;
  readonly completed?: boolean;
  /** The run's operational status from the live store (`chat.run.status`). */
  readonly runStatus?: OperationalStatus | null;
}

/**
 * The one protocol state for a set of signals; null when nothing has happened yet (no chip).
 * Order matters: something that needs the user wins over everything that is merely running.
 */
export function deriveProtocolState(signals: ChatSignals): ProtocolState | null {
  if ((signals.pendingPermissions ?? 0) > 0) return 'WAITING_FOR_PERMISSION';
  if (signals.pendingQuestion) return 'WAITING';
  if (signals.error) {
    if (signals.error.code === 'api_retry') return 'RETRYING';
    return signals.error.code === 'unknown' ? 'FAILED' : 'INTERRUPTED';
  }
  if (signals.interrupted) return 'INTERRUPTED';
  if (signals.runStatus) return FROM_OPERATIONAL[signals.runStatus];
  if (signals.streaming) return 'STREAMING';
  if (signals.starting) return 'STARTING';
  if (signals.queued) return 'QUEUED';
  if (signals.completed) return 'COMPLETED';
  return null;
}
