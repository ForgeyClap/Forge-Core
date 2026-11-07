/**
 * MultiAccountNotice — the consent before switching between several own Claude accounts (APP-ROUTER-DESIGN.md
 * §5.3, decision D6; v1.0 fix round FX-C, DESIGN.md §1 rule 2 and §6; fix round XR-SET, review R1).
 *
 * One row. Visible, in reading order: ONE plain risk line that names the risk ("Anthropic kan je toegang
 * stoppen") and the accounts it covers by name, then the checkbox. So the risk is on screen before the box can
 * be ticked, whether or not "Meer info" was opened (D6 outranks the text budget). The full warning, the three
 * sources (opened in the browser, `rel="noopener noreferrer"`), what happens while it is unticked and the date
 * the terms were checked sit behind "Meer info"; `children` adds the account list there in Eenvoudig. The row is
 * a group named after the topic and described by the risk line, for screen readers. The checkbox IS the
 * switch: ticked = `multi_account.enabled` with the moment of acknowledgement; unticked = only the first Claude
 * account is used.
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import type { TermsSource } from '@/prototype/state/adapter/app-router';

import { MoreInfo } from './MoreInfo';

/** Dutch-first names for the three vendor pages; anything else keeps the title the gateway sent. */
function sourceKey(url: string): MessageKey | null {
  if (url.includes('consumer-terms')) return 'appRouter.multi.linkTerms';
  if (url.includes('/aup')) return 'appRouter.multi.linkAup';
  if (url.includes('legal-and-compliance')) return 'appRouter.multi.linkLegal';
  return null;
}

function formatDay(iso: string | null, locale: string): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const date = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** "Hoofdaccount en Werk" / "Main and Work": the account names as one list in the reader's language. */
function listNames(names: readonly string[], locale: string): string {
  if (names.length < 2) return names.join('');
  return new Intl.ListFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { style: 'long', type: 'conjunction' }).format(names);
}

export interface MultiAccountNoticeProps {
  readonly acknowledged: boolean;
  readonly onChange: (acknowledged: boolean) => void;
  readonly sources: readonly TermsSource[];
  readonly checkedAt: string | null;
  /** The labels of the Claude accounts this consent covers. */
  readonly names: readonly string[];
  readonly disabled?: boolean;
  /** Extra content behind "Meer info" (the account list in Eenvoudig). */
  readonly children?: ReactNode;
}

/** Copy keys added in fix round XR-SET (locale patch; the cast goes once the patch is merged). */
const RISK_KEY = 'rd.settings.router.risk';
const COVERS_KEY = 'rd.settings.router.covers';

export function MultiAccountNotice({ acknowledged, onChange, sources, checkedAt, names, disabled = false, children }: MultiAccountNoticeProps) {
  const { t, locale } = useLocale();
  const riskId = useId();
  const checkId = useId();
  const [open, setOpen] = useState(false);
  const day = formatDay(checkedAt, locale);
  const covered = listNames(names, locale);
  return (
    <div
      className="fs-set__row fs-router__consent"
      role="group"
      aria-label={t('appRouter.multi.title')}
      aria-describedby={riskId}
      data-row="router-multi"
      data-acknowledged={acknowledged}
    >
      <div className="fs-set__text">
        <p className="fs-set__name fs-router__consent-risk" id={riskId}>
          <Icon name="TriangleAlert" size="sm" className="fs-router__consent-icon" />
          <span>
            {t(RISK_KEY)}
            {covered ? <span className="fs-router__consent-names">{` ${t(COVERS_KEY)} ${covered}`}</span> : null}
          </span>
        </p>
        <MoreInfo className="fs-set__more" open={open} onToggle={setOpen}>
          <div className="fs-router__consent-more">
            <p className="fs-router__multi-text">{t('appRouter.multi.warning')}</p>
            {sources.length > 0 ? (
              <p className="fs-router__multi-links">
                <span>{t('appRouter.multi.sources')}:</span>
                {sources.map((source) => {
                  const key = sourceKey(source.url);
                  return (
                    <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="fs-router__link">
                      {key ? t(key) : source.title}
                    </a>
                  );
                })}
              </p>
            ) : null}
            {!acknowledged ? <p className="fs-router__hint">{t('appRouter.multi.offHint')}</p> : null}
            {day ? <p className="fs-router__fine">{t('appRouter.multi.checkedOn', { date: day })}</p> : null}
            {children}
          </div>
        </MoreInfo>
        <label className="fs-router__check fs-router__consent-check" htmlFor={checkId}>
          <input id={checkId} type="checkbox" checked={acknowledged} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
          <span>{t('appRouter.multi.ack')}</span>
        </label>
      </div>
    </div>
  );
}
