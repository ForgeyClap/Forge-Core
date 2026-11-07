/**
 * SettingRow — one row of the Settings page (WP B6, v1.0 redesign DESIGN.md §3.4): the name, at most one
 * sub-line (`note`: a current value, or the reason why something is grey), and the control on the right.
 * The "Wat merk je ervan" line sits behind "Meer info" (DESIGN.md §6); it stays in the page (hidden
 * until opened) and keeps a screen-reader prefix so it is read as an explanation, not a second label.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';

import { Disclosure } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

export interface SettingRowProps {
  readonly title: string;
  /** The "Wat merk je ervan" line, behind "Meer info". A row that explains itself passes none. */
  readonly feel?: ReactNode;
  readonly control?: ReactNode;
  readonly note?: ReactNode;
  /** Gives the row a stable hook for tests and screenshots. */
  readonly rowId: string;
  /** An optional state word for the row (`data-state`), for example whether a reading is current. */
  readonly state?: string;
  /** Lets the control point at the row title for its accessible name. */
  readonly children?: (ids: { titleId: string; feelId: string }) => ReactNode;
}

export function SettingRow({ title, feel, control, note, rowId, state, children }: SettingRowProps) {
  const { t } = useLocale();
  const titleId = useId();
  const feelId = useId();
  const renderedControl = children ? children({ titleId, feelId }) : control;
  return (
    <div className="fs-set__row" data-row={rowId} data-state={state}>
      <div className="fs-set__text">
        <span className="fs-set__name" id={titleId}>
          {title}
        </span>
        {note ? <span className="fs-set__note">{note}</span> : null}
        {feel ? (
          <Disclosure className="fs-set__more" label={t('rd.settings.moreInfo')} openLabel={t('rd.settings.lessInfo')}>
            <span className="fs-set__feel" id={feelId}>
              <span className="fw-visually-hidden">{t('settingsPage.feelPrefix')}</span>
              {feel}
            </span>
          </Disclosure>
        ) : null}
      </div>
      {renderedControl ? <div className="fs-set__ctl">{renderedControl}</div> : null}
    </div>
  );
}
