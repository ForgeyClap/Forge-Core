/**
 * ErrorCard — one chat error as a Dutch card: a title, one sentence and one button (WP B3).
 *
 * The copy comes from `error-catalogue.ts`. Redacted details sit folded away under "Technische
 * details"; they are never part of the card text. `rate_limited` has a toggle button: once on, the
 * label says when Forge continues by itself (the parent schedules the actual resume).
 */

import { useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

import { ERROR_CATALOGUE, errorCopy, redactDetails } from './error-catalogue';
import type { ChatErrorAction, ChatErrorPayload } from './error-catalogue';
import './errors.css';

export interface ErrorCardProps {
  readonly error: ChatErrorPayload;
  /** The one button. For `auto_resume` the second argument says whether it was switched on. */
  readonly onAction?: (action: ChatErrorAction, on?: boolean) => void;
  /** rate_limited only: start with automatic continuing switched on. */
  readonly autoResume?: boolean;
}

export function ErrorCard({ error, onAction, autoResume = false }: ErrorCardProps) {
  const { t, locale } = useLocale();
  const [resumeOn, setResumeOn] = useState(autoResume);
  const entry = ERROR_CATALOGUE[error.code];
  const copy = errorCopy(error, locale);
  const details = error.details ? redactDetails(error.details) : '';
  const isToggle = entry.action === 'auto_resume';
  const label = isToggle && resumeOn && copy.actionOn ? t(...copy.actionOn) : t(...copy.action);

  const press = () => {
    if (isToggle) {
      const next = !resumeOn;
      setResumeOn(next);
      onAction?.(entry.action, next);
      return;
    }
    onAction?.(entry.action);
  };

  return (
    <article
      className="fw-chat-error"
      data-code={error.code}
      data-tone={entry.tone}
      role={entry.tone === 'info' ? 'status' : 'alert'}
      aria-labelledby={`fw-chat-error-${error.code}`}
    >
      <span className="fw-chat-error__icon" aria-hidden="true">
        <Icon name={entry.icon} size="sm" />
      </span>
      <div className="fw-chat-error__body">
        <h3 className="fw-chat-error__title" id={`fw-chat-error-${error.code}`}>
          {t(...copy.title)}
        </h3>
        <p className="fw-chat-error__text">{t(...copy.body)}</p>
        <div className="fw-chat-error__actions">
          <Button
            variant={entry.tone === 'info' ? 'quiet' : isToggle && resumeOn ? 'ghost' : 'primary'}
            size="sm"
            icon={isToggle && resumeOn ? 'Check' : undefined}
            aria-pressed={isToggle ? resumeOn : undefined}
            onClick={press}
          >
            {label}
          </Button>
        </div>
        {error.code === 'unknown' || details !== '' ? (
          <details className="fw-chat-error__tech">
            <summary>{t('chatCards.errors.technical')}</summary>
            {details !== '' ? (
              <>
                <pre className="fw-chat-error__pre fg-machine" data-log-text="">
                  {details}
                </pre>
                <p className="fw-chat-error__note">{t('chatCards.errors.redactedNote')}</p>
              </>
            ) : (
              <p className="fw-chat-error__note">{t('chatCards.errors.noDetails')}</p>
            )}
          </details>
        ) : null}
      </div>
    </article>
  );
}
