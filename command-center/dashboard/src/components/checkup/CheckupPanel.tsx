/**
 * CheckupPanel — "Controleer of alles werkt" (WP B6, plan §4.6).
 *
 * One row per check with a tick, a cross, a grey "not needed for every path" mark or a question
 * mark, and at most one fix button. A fix opens a short explanation; the exact command sits under
 * "Technische details" (PRODUCT-CARD: no commands in plain sight in Eenvoudig). "Diagnose
 * kopiëren" first shows the redacted text in a dialog; only the button inside copies it.
 *
 * Used in Settings > Uitgebreid > Diagnose (with the port row) and in the onboarding wizard
 * (without it). The parent owns the controller (`useCheckup`) so the wizard can read the answer.
 */

import { useId, useMemo, useState } from 'react';

import { Button, Icon, Modal } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import type { MessageKey } from '@/i18n';

import { buildCheckRows, buildDiagnosisText, FIX_COMMANDS } from './checkup-model';
import type { CheckRow, CheckState, FixAction } from './checkup-model';
import type { CheckupController } from './use-checkup';

import './checkup.css';

export interface CheckupPanelProps {
  readonly controller: CheckupController;
  /** Uitgebreid shows the port row; Eenvoudig never shows a port (plan §4.6). */
  readonly showPort: boolean;
  /** Show the "Diagnose kopiëren" button (Settings); the wizard leaves it out. */
  readonly showDiagnose?: boolean;
  /** Extra lines for the diagnosis text (app version, view). Values are redacted too. */
  readonly diagnoseContext?: Readonly<Record<string, string>>;
  /** Called by the "Andere map kiezen" fix; without it, that fix only explains. */
  readonly onChooseFolder?: () => void;
  /** Hide the panel's own heading (the parent already shows one). */
  readonly hideHeading?: boolean;
  /** Only the rows this returns true for (onboarding Welkom shows only real pc problems). */
  readonly rowFilter?: (row: CheckRow) => boolean;
  /** Rows only: no intro, run button or "last checked" line (the parent says those things). */
  readonly bare?: boolean;
}

const STATE_ICON: Record<CheckState, string> = {
  ok: 'CircleCheck',
  fail: 'CircleX',
  optional: 'CircleDashed',
  unknown: 'CircleAlert',
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CheckupPanel({
  controller,
  showPort,
  showDiagnose = false,
  diagnoseContext = {},
  onChooseFolder,
  hideHeading = false,
  rowFilter,
  bare = false,
}: CheckupPanelProps) {
  const { t, locale } = useLocale();
  const headingId = useId();
  const [openFix, setOpenFix] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [diagnoseOpen, setDiagnoseOpen] = useState(false);
  const [diagnoseNote, setDiagnoseNote] = useState<string | null>(null);

  const { status, result, finishedAt, run } = controller;
  const allRows = useMemo(
    () => (result ? buildCheckRows(result, { showPort, locale }) : []),
    [result, showPort, locale],
  );
  const rows = useMemo(() => (rowFilter ? allRows.filter(rowFilter) : allRows), [allRows, rowFilter]);

  const describe = (row: CheckRow): string => t(`checkup.rows.${row.id}.${row.message}` as MessageKey, row.vars);

  const diagnosis = useMemo(
    () => (result ? buildDiagnosisText(result, rows, describe, { ...diagnoseContext, taal: locale }) : ''),
    // describe follows `t`, which follows the locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, rows, diagnoseContext, locale],
  );

  function handleFix(row: CheckRow, fix: FixAction) {
    if (fix === 'recheck') {
      run();
      return;
    }
    if (fix === 'chooseFolder' && onChooseFolder) {
      onChooseFolder();
      return;
    }
    setOpenFix((current) => (current === row.id ? null : row.id));
  }

  async function handleCopyCommand(command: string) {
    if (await copyText(command)) {
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand((current) => (current === command ? null : current)), 2000);
    }
  }

  async function handleCopyDiagnosis() {
    setDiagnoseNote((await copyText(diagnosis)) ? t('checkup.diagnose.copied') : t('checkup.diagnose.copyFailed'));
  }

  const running = status === 'running';
  const seconds = result?.durationMs != null ? (result.durationMs / 1000).toLocaleString(locale, { maximumFractionDigits: 1 }) : '';
  const time = finishedAt ? finishedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <section
      className={['fs-checkup', hideHeading ? 'fs-checkup--noheading' : '', bare ? 'fs-checkup--bare' : ''].filter(Boolean).join(' ')}
      aria-labelledby={hideHeading ? undefined : headingId}
      aria-busy={running}
    >
      {bare ? null : (
      <div className="fs-checkup__head">
        {hideHeading ? null : (
          <h3 id={headingId} className="fs-checkup__title">
            {t('checkup.title')}
          </h3>
        )}
        <p className="fs-checkup__intro">{t('checkup.intro')}</p>
        <div className="fs-checkup__actions">
          <Button variant={result ? 'ghost' : 'primary'} icon="RefreshCw" onClick={run} disabled={running}>
            {running ? t('checkup.running') : result ? t('checkup.run') : t('checkup.start')}
          </Button>
          {showDiagnose ? (
            <Button
              variant="quiet"
              icon="Copy"
              disabled={!result}
              onClick={() => {
                setDiagnoseNote(null);
                setDiagnoseOpen(true);
              }}
            >
              {t('checkup.diagnose.button')}
            </Button>
          ) : null}
        </div>
      </div>
      )}

      {bare ? null : (
      <div className="fs-checkup__status" role="status" aria-live="polite">
        {status === 'failed' ? <p className="fs-checkup__failed">{t('checkup.failed')}</p> : null}
        {status === 'done' && result ? (
          <p className="fs-checkup__meta">
            {t('checkup.lastChecked', { time, seconds })}
            {result.timedOut ? ` ${t('checkup.slow')}` : ''}
          </p>
        ) : null}
      </div>
      )}

      {rows.length > 0 ? (
        <ul className="fs-checkup__rows">
          {rows.map((row) => {
            const command = row.fix ? FIX_COMMANDS[row.fix] : undefined;
            const isOpen = openFix === row.id && row.fix !== null;
            return (
              <li key={row.id} className="fs-checkup__row" data-state={row.state} data-check={row.id}>
                <span className="fs-checkup__mark" aria-hidden="true">
                  <Icon name={STATE_ICON[row.state]} size="sm" />
                </span>
                <span className="fs-checkup__text">
                  <span className="fw-visually-hidden">{t(`checkup.state.${row.state}`)}: </span>
                  {describe(row)}
                </span>
                {row.fix ? (
                  <Button
                    size="sm"
                    variant={row.state === 'fail' ? 'primary' : 'ghost'}
                    aria-expanded={row.fix === 'recheck' || (row.fix === 'chooseFolder' && onChooseFolder) ? undefined : isOpen}
                    onClick={() => handleFix(row, row.fix as FixAction)}
                    disabled={running && row.fix === 'recheck'}
                  >
                    {t(`checkup.fix.${row.fix}`)}
                  </Button>
                ) : null}
                {isOpen && row.fix ? (
                  <div className="fs-checkup__help">
                    <p>{t(`checkup.help.${row.fix}`)}</p>
                    {command ? (
                      <details className="fs-checkup__details">
                        <summary>{t('checkup.details')}</summary>
                        <div className="fs-checkup__command">
                          <code aria-label={t('checkup.command')}>{command}</code>
                          <Button size="sm" variant="quiet" icon="Copy" onClick={() => void handleCopyCommand(command)}>
                            {copiedCommand === command ? t('checkup.copied') : t('checkup.copyCommand')}
                          </Button>
                        </div>
                      </details>
                    ) : null}
                    <Button size="sm" variant="ghost" icon="RefreshCw" onClick={run} disabled={running}>
                      {t('checkup.fix.recheck')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {showDiagnose ? (
        <Modal
          open={diagnoseOpen}
          onClose={() => setDiagnoseOpen(false)}
          title={t('checkup.diagnose.title')}
          description={t('checkup.diagnose.intro')}
          footer={
            <>
              <Button variant="quiet" onClick={() => setDiagnoseOpen(false)}>
                {t('checkup.close')}
              </Button>
              <Button variant="primary" icon="Copy" onClick={() => void handleCopyDiagnosis()}>
                {t('checkup.diagnose.copy')}
              </Button>
            </>
          }
        >
          <textarea
            className="fs-checkup__diagnosis"
            readOnly
            value={diagnosis}
            aria-label={t('checkup.diagnose.label')}
            rows={Math.min(16, diagnosis.split('\n').length + 1)}
          />
          {diagnoseNote ? (
            <p className="fs-checkup__meta" role="status">
              {diagnoseNote}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}
