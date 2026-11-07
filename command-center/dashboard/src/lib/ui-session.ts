/**
 * ui-session — is this window paired with the gateway? (FU-STEP2, Security Boss Step 2.)
 *
 * The dashboard no longer reads a token from its own HTML. The gateway accepts a write only with an
 * HttpOnly session cookie that is delivered out of band: the desktop app sets it before the window
 * loads; a plain browser gets it once from the pairing link the launcher prints
 * (`forge dashboard`). Page script can never read that cookie, so the window learns its state from
 * the gateway: `GET /api/ui-session` (`checkUiSession()` in gateway-client.ts) and any write that is
 * refused with code `ui_session_required` (gateway-client.ts reports it here).
 *
 * A tiny module-level store (same shape as the i18n store): no React, no fetch, so gateway-client.ts
 * can import it without an import cycle. `PairingNotice` (views/chat/errors) reads it.
 *
 * States: `unknown` (not asked yet, or the gateway could not answer: no card, the connection UI
 * covers that), `paired`, `required` (show "Koppel dit venster opnieuw").
 */

export type PairingState = 'unknown' | 'paired' | 'required';

/** The 403 `code` the gateway answers on a dashboard write without a valid session cookie. */
export const UI_SESSION_REQUIRED_CODE = 'ui_session_required';

/** The gateway route that answers `{ ok: true, paired: boolean }` for the caller's own cookie. */
export const UI_SESSION_PATH = '/api/ui-session';

/** The launcher command a plain browser needs for a new pairing link. A command, not copy: never translated. */
export const PAIRING_LAUNCH_COMMAND = 'forge dashboard';

let state: PairingState = 'unknown';
const listeners = new Set<() => void>();

export function getPairingState(): PairingState {
  return state;
}

/** Sets the state and notifies every subscriber when it changed. */
export function setPairingState(next: PairingState): void {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribePairing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True for the gateway's "this window is not paired" refusal: HTTP 403 with code `ui_session_required`. */
export function isPairingRequired(status: number, body: unknown): boolean {
  if (status !== 403 || typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return (body as Record<string, unknown>).code === UI_SESSION_REQUIRED_CODE;
}

/** Test-only: back to `unknown`, listeners kept. */
export function _resetPairingStateForTests(): void {
  state = 'unknown';
}
