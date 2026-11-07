/**
 * accounts-model — which account cards Settings > Accounts shows and the one status word on each
 * (WP B6, plan §4.6). Pure, so every status rule is unit-tested.
 *
 * Sources, all real: the gateway's live health (`claudeCode.available`), the checkup
 * (`/api/checkup`: Claude sign-in, Codex, Ollama) and `GET /api/models` (the NVIDIA probe). While
 * the checkup has not answered yet, a card says "Controleren…", never a guess.
 */

import type { CheckupResult } from '@/components/checkup/checkup-model';
import type { GatewayModels } from '@/prototype/state/gateway-capabilities';

export type ProviderId = 'claude' | 'chatgpt' | 'ollama' | 'nvidia';

export type AccountStatus =
  | 'connected'
  | 'signedOut'
  | 'found'
  | 'missing'
  | 'running'
  | 'stopped'
  | 'unknown'
  | 'checking'
  | 'notConnected';

export type StatusTone = 'ok' | 'off' | 'warn' | 'busy';

export interface AccountCard {
  readonly id: ProviderId;
  readonly initial: string;
  readonly status: AccountStatus;
  readonly tone: StatusTone;
  /** Ollama only: how many models are on this pc. */
  readonly modelCount: number | null;
}

export interface AccountInputs {
  readonly checkup: CheckupResult | null;
  readonly checkupRunning: boolean;
  /** `claudeCode.available` from the live health; null before the first answer. */
  readonly claudeAvailable: boolean | null;
  readonly models: GatewayModels | null;
}

const TONE: Record<AccountStatus, StatusTone> = {
  connected: 'ok',
  running: 'ok',
  found: 'ok',
  signedOut: 'warn',
  stopped: 'warn',
  missing: 'off',
  notConnected: 'off',
  unknown: 'off',
  checking: 'busy',
};

function card(id: ProviderId, initial: string, status: AccountStatus, modelCount: number | null = null): AccountCard {
  return { id, initial, status, tone: TONE[status], modelCount };
}

function claudeStatus({ checkup, checkupRunning, claudeAvailable }: AccountInputs): AccountStatus {
  if (checkup) {
    if (!checkup.claude.found) return 'missing';
    if (checkup.claude.signedIn === true) return 'connected';
    if (checkup.claude.signedIn === false) return 'signedOut';
    return 'found';
  }
  if (checkupRunning) return 'checking';
  if (claudeAvailable === false) return 'missing';
  return claudeAvailable === true ? 'found' : 'unknown';
}

const NVIDIA_OK = new Set(['ok', 'up', 'connected', 'reachable', 'live']);

/** The cards in display order. NVIDIA only appears when the gateway reports a probe for it. */
export function buildAccountCards(inputs: AccountInputs): readonly AccountCard[] {
  const { checkup, checkupRunning, models } = inputs;
  const cards: AccountCard[] = [card('claude', 'C', claudeStatus(inputs))];

  if (checkup) cards.push(card('chatgpt', 'G', checkup.codex.found ? 'found' : 'missing'));
  else cards.push(card('chatgpt', 'G', checkupRunning ? 'checking' : 'unknown'));

  if (checkup) {
    const status: AccountStatus = checkup.ollama.up ? 'running' : checkup.ollama.found ? 'stopped' : 'missing';
    cards.push(card('ollama', 'O', status, checkup.ollama.up ? checkup.ollama.models.length : null));
  } else {
    cards.push(card('ollama', 'O', checkupRunning ? 'checking' : 'unknown'));
  }

  const nvidia = models?.nvidia ?? null;
  if (nvidia !== null) {
    const state = (nvidia.state ?? '').toLowerCase();
    cards.push(card('nvidia', 'N', NVIDIA_OK.has(state) ? 'connected' : 'notConnected'));
  }
  return cards;
}

/** The date the provider terms were last checked, written out ("1 november 2026"). */
export function formatTermsDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${iso}T12:00:00`));
}
