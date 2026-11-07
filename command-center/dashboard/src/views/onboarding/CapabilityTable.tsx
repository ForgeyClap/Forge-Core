/**
 * "Wat kan elk pad?" — the table from plan §3.2 (WP B6). Since the redesign (DESIGN.md §3.5) it sits
 * behind the "Wat kan elk pad?" disclosure on Kies and on Klaar. The chosen path's row is highlighted and named for screen readers.
 */

import { useLocale } from '@/i18n/use-locale';

import { CAPABILITY_TABLE } from './onboarding-model';
import type { Capability, PathId } from './onboarding-model';

function Cell({ value }: { readonly value: Capability }) {
  const { t } = useLocale();
  return (
    <td>
      <span className={value.yes ? 'fs-cap__yes' : 'fs-cap__no'}>
        {value.yes ? t('onboarding.table.yes') : t('onboarding.table.no')}
        {value.remark ? <small> {t(`onboarding.table.${value.remark}`)}</small> : null}
      </span>
    </td>
  );
}

export interface CapabilityTableProps {
  readonly chosen: PathId | null;
  readonly titleId?: string;
  /** Inside "Wat kan elk pad?" the disclosure already says the title; the table is named instead. */
  readonly hideTitle?: boolean;
}

export function CapabilityTable({ chosen, titleId, hideTitle = false }: CapabilityTableProps) {
  const { t } = useLocale();
  return (
    <div className="fs-cap">
      {hideTitle ? null : (
        <h3 className="fs-cap__title" id={titleId}>
          {t('onboarding.table.title')}
        </h3>
      )}
      <table
        className="fs-cap__table"
        aria-labelledby={hideTitle ? undefined : titleId}
        aria-label={hideTitle ? t('onboarding.table.title') : undefined}
      >
        <thead>
          <tr>
            <th scope="col">{t('onboarding.table.colPath')}</th>
            <th scope="col">{t('onboarding.table.colChat')}</th>
            <th scope="col">{t('onboarding.table.colFiles')}</th>
            <th scope="col">{t('onboarding.table.colTeam')}</th>
            <th scope="col">{t('onboarding.table.colOffline')}</th>
          </tr>
        </thead>
        <tbody>
          {CAPABILITY_TABLE.map((row) => (
            <tr key={row.path} className={row.path === chosen ? 'is-chosen' : undefined} data-path={row.path}>
              <th scope="row">
                {t(`onboarding.table.rows.${row.path}`)}
                {row.path === chosen ? <span className="fw-visually-hidden"> ({t('onboarding.table.chosen')})</span> : null}
              </th>
              <Cell value={row.chat} />
              <Cell value={row.files} />
              <Cell value={row.team} />
              <Cell value={row.offline} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fs-cap__note">{t('onboarding.table.note')}</p>
    </div>
  );
}
