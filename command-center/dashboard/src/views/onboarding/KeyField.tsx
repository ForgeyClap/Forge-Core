/**
 * KeyField — the ONE place in the dashboard where a person types an API key (WP B2 part 2,
 * plan §4.6 / §4.7). Shared by Settings › Accounts and the onboarding "API-sleutel" path.
 *
 * Where the key goes: only into the desktop app's vault through the preload bridge
 * (`window.forge.keys.set`, contract _scratch/b2/contract-keys.md). The value lives in the input
 * element itself (uncontrolled, never in React state), is read once on submit and the field is
 * cleared right after, whatever the answer. Nothing here sends it anywhere else, stores it in the
 * page or writes it to a log; afterwards only the vault's `last4` is shown. In a plain browser the
 * bridge is absent and the field is not rendered at all; the text says the app is needed.
 *
 * tests/unit/no-runtime-contact.test.ts holds this file to that: it is the only file allowed a
 * password input, and it may not reach the network, browser storage or the console.
 *
 * After a save or removal the field shows what main reports (KEY-VAULT-CONTRACT.md v1.2 §5): the
 * Dutch `apply.detail` next to the state, "Actief" only for a real `applied`, a neutral "status
 * unknown" line when main sent no state this build knows, the "Nu opnieuw verbinden" action as a
 * button when main offers it, and a status poll every ~2 s while the change is still pending.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { callVault, readKeysBridge } from '@/prototype/state/adapter/providers';
import type { ApplyAction, ApplyStateSeen, KeySource, VaultKeyStatus, VaultOutcome } from '@/prototype/state/adapter/providers';

import './key-field.css';

const MIN_LENGTH = 8;
const MAX_LENGTH = 8192;

/** Same shape rule as the vault (contract §2): printable, no whitespace inside. Never echoed. */
function looksLikeKey(value: string): boolean {
  return value.length >= MIN_LENGTH && value.length <= MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

const KNOWN_ERRORS = ['VAULT_UNAVAILABLE', 'INVALID_KEY', 'NO_KEY_PROVIDER', 'UNKNOWN_PROVIDER'] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];

function isKnownError(code: string): code is KnownError {
  return (KNOWN_ERRORS as readonly string[]).includes(code);
}

/** The fallback text per apply state, used only when main sent no `detail` of its own. */
const APPLY_KEY: Record<ApplyStateSeen, 'applied' | 'waiting' | 'restarting' | 'failed' | 'unknown'> = {
  applied: 'applied',
  'waiting-for-idle': 'waiting',
  restarting: 'restarting',
  failed: 'failed',
  unknown: 'unknown',
};

const APPLY_TONE: Record<ApplyStateSeen, 'ok' | 'pending' | 'warn'> = {
  applied: 'ok',
  'waiting-for-idle': 'pending',
  restarting: 'pending',
  failed: 'warn',
  unknown: 'pending',
};

const RECONNECT_ERRORS = ['TURN_RUNNING', 'NOTHING_PENDING'] as const;
type ReconnectError = (typeof RECONNECT_ERRORS)[number];

function isReconnectError(code: string): code is ReconnectError {
  return (RECONNECT_ERRORS as readonly string[]).includes(code);
}

/** Contract §5: poll `status(id)` about every 2 s while a change waits or the gateway restarts. */
const APPLY_POLL_MS = 2_000;

interface ApplyView {
  readonly state: ApplyStateSeen;
  readonly detail: string | null;
  readonly action: ApplyAction | null;
}

function isPending(state: ApplyStateSeen | undefined): boolean {
  return state === 'waiting-for-idle' || state === 'restarting';
}

export interface KeyFieldProps {
  readonly providerId: string;
  /** The account's display name, for the label ("API-sleutel voor OpenAI"). */
  readonly providerName: string;
  /** What the vault last reported for this account, or null when unknown. */
  readonly vaultStatus: VaultKeyStatus | null;
  /** Where the gateway found a key (vault | env), or null. */
  readonly keySource: KeySource | null;
  /** Called after every successful save or removal, so the parent can re-read the lists. */
  readonly onChanged?: (outcome: VaultOutcome) => void;
  /**
   * Show the empty field right away (onboarding, where adding a key is the step). In Settings the
   * field stays behind "Sleutel toevoegen", so a list of accounts is not a wall of empty fields.
   */
  readonly startOpen?: boolean;
}

type Message = { readonly tone: 'ok' | 'pending' | 'warn' | 'bad'; readonly text: string } | null;

export function KeyField({ providerId, providerName, vaultStatus, keySource, onChanged, startOpen = false }: KeyFieldProps) {
  const { t, locale } = useLocale();
  const inputId = useId();
  const hintId = useId();
  const messageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [saved, setSaved] = useState<VaultKeyStatus | null>(null);
  const [applyView, setApplyView] = useState<ApplyView | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectMessage, setReconnectMessage] = useState<Message>(null);

  const pendingState = isPending(applyView?.state) ? applyView?.state : undefined;
  useEffect(() => {
    const statusFn = readKeysBridge()?.status;
    if (pendingState === undefined || typeof statusFn !== 'function') return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void callVault(() => statusFn(providerId), providerId).then((outcome) => {
        // A status answer without a state this build knows keeps the last known state on screen.
        if (cancelled || !outcome.ok || outcome.apply === 'unknown') return;
        setApplyView({ state: outcome.apply, detail: outcome.applyDetail, action: outcome.applyAction });
      });
    }, APPLY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingState, providerId]);

  const keys = readKeysBridge();
  if (keys === null) {
    return (
      <div className="fs-key" data-key-state="browser">
        <p className="fs-key__note" role="note">
          <Icon name="Lock" size="sm" />
          <span>{t('accountKeys.browserOnly')}</span>
        </p>
        {keySource === 'env' ? <p className="fs-key__meta">{t('accountKeys.envKey')}</p> : null}
      </div>
    );
  }

  const current = saved ?? vaultStatus;
  const configured = current?.configured === true;
  // A key the gateway already finds in this pc's own settings is used as is; storing an own key in
  // the app is offered, not pushed (round-1 screenshot: an empty field next to a working key confused).
  const envOnly = !configured && keySource === 'env';
  const showForm = (!configured && !envOnly && startOpen) || editing;
  const showAdd = !configured && !envOnly && !startOpen && !editing;

  function clearInput() {
    if (inputRef.current) inputRef.current.value = '';
    setHasValue(false);
  }

  function viewOf(outcome: Extract<VaultOutcome, { ok: true }>): ApplyView {
    return { state: outcome.apply, detail: outcome.applyDetail, action: outcome.applyAction };
  }

  /** Main's own Dutch detail when it sent one; an unknown state never borrows a detail it cannot place. */
  function applyLine(view: ApplyView): Message {
    const text = view.state !== 'unknown' && view.detail ? view.detail : t(`accountKeys.apply.${APPLY_KEY[view.state]}`);
    return { tone: APPLY_TONE[view.state], text };
  }

  async function onReconnect() {
    if (keys === null || reconnecting) return;
    const bridge = keys;
    if (typeof bridge.reconnectNow !== 'function') return;
    setReconnecting(true);
    setReconnectMessage(null);
    const outcome = await callVault(() => bridge.reconnectNow?.() ?? Promise.resolve(null), providerId, 'reconnect');
    setReconnecting(false);
    if (outcome.ok) {
      setApplyView({ state: outcome.apply, detail: outcome.applyDetail, action: outcome.applyAction });
      return;
    }
    const fallback = isReconnectError(outcome.code) ? t(`accountKeys.reconnect.${outcome.code}`) : t('accountKeys.reconnect.generic');
    setReconnectMessage({ tone: 'warn', text: outcome.message || fallback });
    // Nothing waits any more: the button has nothing left to do.
    if (outcome.code === 'NOTHING_PENDING') setApplyView((view) => (view ? { ...view, action: null } : view));
  }

  function errorMessage(outcome: Extract<VaultOutcome, { ok: false }>): Message {
    if (outcome.message) return { tone: 'bad', text: outcome.message };
    return { tone: 'bad', text: isKnownError(outcome.code) ? t(`accountKeys.errors.${outcome.code}`) : t('accountKeys.errors.generic') };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = inputRef.current;
    if (!field || keys === null || busy) return;
    const secret = field.value.trim();
    if (!looksLikeKey(secret)) {
      clearInput();
      setMessage({ tone: 'bad', text: t('accountKeys.invalid') });
      return;
    }
    setBusy(true);
    setMessage(null);
    setApplyView(null);
    setReconnectMessage(null);
    const outcome = await callVault(() => keys.set(providerId, secret), providerId);
    clearInput();
    setBusy(false);
    if (outcome.ok) {
      setSaved(outcome.status);
      setEditing(false);
      setApplyView(viewOf(outcome));
      onChanged?.(outcome);
    } else {
      setMessage(errorMessage(outcome));
    }
  }

  async function onRemove() {
    const remove = keys?.delete;
    if (typeof remove !== 'function' || busy) return;
    setBusy(true);
    setMessage(null);
    setApplyView(null);
    setReconnectMessage(null);
    const outcome = await callVault(() => remove(providerId), providerId);
    setBusy(false);
    setConfirmRemove(false);
    if (outcome.ok) {
      setSaved(outcome.status);
      setMessage({ tone: 'ok', text: t('accountKeys.removed') });
      // "Actief" next to "Sleutel verwijderd." would read oddly; a pending restart is still said.
      if (outcome.apply !== 'applied' && outcome.apply !== 'unknown') setApplyView(viewOf(outcome));
      onChanged?.(outcome);
    } else {
      setMessage(errorMessage(outcome));
    }
  }

  const applyMessage = applyView ? applyLine(applyView) : null;
  const action = applyView?.action && typeof keys.reconnectNow === 'function' ? applyView.action : null;
  const hasStatus = message !== null || applyMessage !== null || reconnectMessage !== null;

  const updated =
    current?.updatedAt != null
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(current.updatedAt))
      : null;

  return (
    <div className="fs-key" data-key-state={configured ? 'saved' : 'empty'}>
      {configured && !editing ? (
        <div className="fs-key__saved">
          <span className="fs-key__dots">
            <Icon name="Lock" size="sm" />
            {current?.last4
              ? t('accountKeys.saved', { last4: current.last4 })
              : t('accountKeys.savedNoLast4')}
            {updated ? <small>{t('accountKeys.savedAt', { date: updated })}</small> : null}
          </span>
          <span className="fs-key__actions">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
              {t('accountKeys.replace')}
            </Button>
            {typeof keys.delete === 'function' ? (
              confirmRemove ? (
                <>
                  <Button size="sm" variant="primary" onClick={() => void onRemove()} disabled={busy}>
                    {t('accountKeys.confirmRemove')}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setConfirmRemove(false)} disabled={busy}>
                    {t('accountKeys.cancel')}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="quiet" onClick={() => setConfirmRemove(true)} disabled={busy}>
                  {t('accountKeys.remove')}
                </Button>
              )
            ) : null}
          </span>
        </div>
      ) : null}

      {envOnly && !editing ? (
        <div className="fs-key__saved">
          <span className="fs-key__dots">
            <Icon name="Lock" size="sm" />
            {t('accountKeys.envKey')}
          </span>
          <span className="fs-key__actions">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t('accountKeys.ownKey')}
            </Button>
          </span>
        </div>
      ) : null}

      {showAdd ? (
        <div>
          <Button size="sm" variant="ghost" icon="Plus" onClick={() => setEditing(true)}>
            {t('accountKeys.add')}
          </Button>
        </div>
      ) : null}

      {showForm ? (
        <form className="fs-key__form" onSubmit={(event) => void onSubmit(event)} noValidate>
          <label className="fs-key__label" htmlFor={inputId}>
            {t('accountKeys.label', { name: providerName })}
          </label>
          <div className="fs-key__row">
            <input
              ref={inputRef}
              id={inputId}
              className="fs-key__input"
              type="password"
              name={`forge-key-${providerId}`}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              inputMode="text"
              maxLength={MAX_LENGTH}
              aria-describedby={hasStatus ? `${hintId} ${messageId}` : hintId}
              aria-invalid={message?.tone === 'bad' ? true : undefined}
              onInput={(event) => setHasValue(event.currentTarget.value.trim().length > 0)}
              disabled={busy}
            />
            <Button type="submit" size="sm" variant="primary" disabled={!hasValue || busy}>
              {busy ? t('accountKeys.saving') : t('accountKeys.save')}
            </Button>
            {configured || envOnly || !startOpen ? (
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  clearInput();
                  setEditing(false);
                }}
                disabled={busy}
              >
                {t('accountKeys.cancel')}
              </Button>
            ) : null}
          </div>
          <p className="fs-key__meta" id={hintId}>
            {t('accountKeys.hint')}
          </p>
        </form>
      ) : null}

      <div className="fs-key__status" id={messageId} role="status">
        {message ? (
          <p className="fs-key__msg" data-tone={message.tone}>
            {message.text}
          </p>
        ) : null}
        {applyMessage && applyView ? (
          <p className="fs-key__msg fs-key__apply" data-tone={applyMessage.tone} data-apply-state={applyView.state}>
            {applyMessage.text}
          </p>
        ) : null}
        {reconnectMessage ? (
          <p className="fs-key__msg" data-tone={reconnectMessage.tone}>
            {reconnectMessage.text}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="fs-key__apply-action">
          <Button size="sm" variant="ghost" icon="RefreshCw" onClick={() => void onReconnect()} disabled={reconnecting}>
            {action.label ?? t('accountKeys.reconnect.label')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
