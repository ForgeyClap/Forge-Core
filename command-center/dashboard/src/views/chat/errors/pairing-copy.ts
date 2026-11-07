/**
 * The locale keys of the pairing card (FU-STEP2). They live under `chatCards.pairing.*` in
 * `nl.json` / `en.json` and reach those files through the lane's LEAD-PATCH json (the locale files
 * belong to another lane). They are typed through `string` on purpose, so this compiles before that
 * merge; until it lands `t()` shows the key itself (its documented fallback), never an empty label.
 */

import type { MessageKey } from '@/i18n';

export const PAIRING_COPY_KEYS = {
  title: 'chatCards.pairing.title',
  bodyBrowser: 'chatCards.pairing.bodyBrowser',
  bodyDesktop: 'chatCards.pairing.bodyDesktop',
  commandLabel: 'chatCards.pairing.commandLabel',
  copy: 'chatCards.pairing.copy',
  copied: 'chatCards.pairing.copied',
  recheck: 'chatCards.pairing.recheck',
  checking: 'chatCards.pairing.checking',
  dismiss: 'chatCards.pairing.dismiss',
  more: 'chatCards.pairing.more',
  less: 'chatCards.pairing.less',
} as const satisfies Readonly<Record<string, string>>;

export type PairingCopyName = keyof typeof PAIRING_COPY_KEYS;

/** The MessageKey for one piece of the card's copy. */
export function pairingKey(name: PairingCopyName): MessageKey {
  const key: string = PAIRING_COPY_KEYS[name];
  return key as MessageKey;
}

/** sessionStorage key: the user closed the pairing notice in this browser session (FU fix round). */
export const PAIRING_DISMISS_KEY = 'forge.pairing.dismissed';

/** True when the notice was closed earlier in this session. Storage that is unavailable reads as "not closed". */
export function isPairingDismissed(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(PAIRING_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the dismissal for this session; without storage it only holds until the next mount. */
export function rememberPairingDismissed(): void {
  try {
    globalThis.sessionStorage?.setItem(PAIRING_DISMISS_KEY, '1');
  } catch {
    // Not remembered when storage is unavailable; the notice is still closed now.
  }
}
