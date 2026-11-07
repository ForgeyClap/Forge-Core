/**
 * PairingCard — "Koppel dit venster opnieuw" (FU-STEP2, Security Boss Step 2).
 *
 * The gateway only accepts a write from a window that holds its HttpOnly session cookie. The desktop
 * app sets that cookie itself before the window loads; a plain browser gets it once from the pairing
 * link the launcher prints. When the cookie is missing or no longer valid (the link expired or was
 * used, the browser was restarted, the Command Center was restarted), Forge does nothing from this
 * window, and this card says so in one sentence with one way out:
 *   - browser: the launcher command (`forge dashboard`) with a copy button;
 *   - desktop app: restart Forge Systeem (no terminal: "Nooit een terminal nodig").
 *
 * `PairingNotice` is the self-contained piece the shell mounts once: it asks the gateway at start
 * (`checkUiSession`), listens to `@/lib/ui-session` (a refused write switches it on too) and renders
 * the card only in the `required` state. `PairingCard` is the presentational part.
 *
 * Copy: keys under `chatCards.pairing.*` (nl + en), see `pairing-copy.ts`.
 *
 * FU fix round (review medium): the notice is a slim banner in its own shell grid row under the top bar
 * (`grid-area: notice`, app-shell.css), so it pushes the page down instead of covering the conversation,
 * and it has a close button ("Sluit deze melding"); the choice is remembered for the browser session.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { Button, Icon, IconButton } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { PAIRING_LAUNCH_COMMAND, getPairingState, subscribePairing } from '@/lib/ui-session';
import { checkUiSession, isDesktopApp } from '@/prototype/state/gateway-client';

import { isPairingDismissed, pairingKey as key, rememberPairingDismissed } from './pairing-copy';
import './errors.css';

const COPIED_RESET_MS = 1_500;

export interface PairingCardProps {
  /** True inside the Forge Systeem desktop app: no command, restart the app instead. */
  readonly desktop: boolean;
  /** "Opnieuw controleren": asks the gateway again (after the user opened a new link). */
  readonly onRecheck?: () => void;
  /** A check is running: the button says so and is disabled. */
  readonly checking?: boolean;
  /** Shows the close button; called when the user closes the notice. */
  readonly onDismiss?: () => void;
}

export function PairingCard({ desktop, onRecheck, checking = false, onDismiss }: PairingCardProps) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  // On a phone the explanation starts as two lines (errors.css); this toggle shows the rest. Wider
  // screens hide the toggle and always show the whole text.
  const [fullText, setFullText] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const id = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  // "Gekopieerd" only after the clipboard accepted the text (review low, FU): no clipboard or a
  // refused write keeps the "Kopieer commando" label; the command stays on screen to copy by hand.
  const copyCommand = useCallback(() => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined || clipboard === null) return;
    let pending: Promise<void>;
    try {
      pending = clipboard.writeText(PAIRING_LAUNCH_COMMAND);
    } catch {
      return;
    }
    pending.then(
      () => setCopied(true),
      () => undefined,
    );
  }, []);

  return (
    <article
      className="fw-chat-error fw-pairing"
      data-dismissable={onDismiss ? 'true' : undefined}
      data-text={fullText ? 'full' : 'short'}
      data-code="ui_session_required" data-tone="pause" role="alert" aria-labelledby="fw-pairing-title">
      <span className="fw-chat-error__icon" aria-hidden="true">
        <Icon name="Unplug" size="sm" />
      </span>
      <div className="fw-chat-error__body">
        <h3 className="fw-chat-error__title" id="fw-pairing-title">
          {t(key('title'))}
        </h3>
        <p className="fw-chat-error__text" id="fw-pairing-text">
          {t(key(desktop ? 'bodyDesktop' : 'bodyBrowser'))}
        </p>
        <button
          type="button"
          className="fw-pairing__more"
          aria-expanded={fullText}
          aria-controls="fw-pairing-text"
          onClick={() => setFullText((open) => !open)}
        >
          {t(key(fullText ? 'less' : 'more'))}
        </button>
        {desktop ? null : (
          <div className="fw-pairing__command">
            <span className="fw-pairing__command-label" id="fw-pairing-command-label">
              {t(key('commandLabel'))}
            </span>
            <code className="fw-pairing__command-text fg-machine" aria-labelledby="fw-pairing-command-label">
              {PAIRING_LAUNCH_COMMAND}
            </code>
          </div>
        )}
        <div className="fw-chat-error__actions">
          {desktop ? null : (
            <Button variant="primary" size="sm" icon={copied ? 'Check' : 'Copy'} onClick={copyCommand}>
              {t(key(copied ? 'copied' : 'copy'))}
            </Button>
          )}
          {onRecheck ? (
            <Button variant="quiet" size="sm" icon="RefreshCw" onClick={onRecheck} disabled={checking} aria-busy={checking || undefined}>
              {t(key(checking ? 'checking' : 'recheck'))}
            </Button>
          ) : null}
        </div>
      </div>
      {onDismiss ? (
        <IconButton icon="X" size="sm" label={t(key('dismiss'))} className="fw-pairing__close" onClick={onDismiss} />
      ) : null}
    </article>
  );
}

/** Mount once in the shell: asks the gateway at start and shows the card only while pairing is required. */
export function PairingNotice() {
  const state = useSyncExternalStore(subscribePairing, getPairingState, getPairingState);
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState(isPairingDismissed);

  const dismiss = useCallback(() => {
    rememberPairingDismissed();
    setDismissed(true);
  }, []);

  const recheck = useCallback(() => {
    setChecking(true);
    void checkUiSession().finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    void checkUiSession();
  }, []);

  if (state !== 'required' || dismissed) return null;
  return (
    <div className="fw-pairing-notice">
      <PairingCard desktop={isDesktopApp()} onRecheck={recheck} checking={checking} onDismiss={dismiss} />
    </div>
  );
}
