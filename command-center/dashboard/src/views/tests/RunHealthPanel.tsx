/**
 * RunHealthPanel — WP-CCD (item 6): the run's own gate evidence, finalize receipt, run contract
 * and Codex-style reviews, next to the pre-existing gate board / proof ledger in `TestsView.tsx`.
 *
 * All FOUR are REAL `/api/proof` fields — read defensively throughout regardless (every sub-section
 * renders its own honest "not available yet" empty state when the field/source genuinely does not
 * exist for this run). REVIEW FIX: the exact shapes are now verified live against
 * `_scratch/wt-cc1-snap/gateway/src/proof.mjs::buildProof()` — see `graph-and-proof.ts`'s own header
 * and each parser's own doc comment for exactly what changed (`reviews` already matched; `finalize`/
 * `contract`'s top-level KEY NAMES did not — `finalize_receipt`/`run_contract` — and always read
 * "not available" on real data before this fix).
 *
 * Existing primitives/classes only — `Icon`/`Machine`/`Panel`/`EmptyState`, and this
 * view's own `.fw-tests__panel`/`.fw-tests__stat` treatment, extended with a handful of new,
 * narrowly-scoped classes in `run-health-panel.css` that reuse existing tokens only.
 */

import { useId, useState, type KeyboardEvent } from 'react';
import { Icon, IconButton, Machine, Panel } from '@/components/primitives';
import type { GatewayProofExtras } from '@/prototype/state/gateway-adapter';
import { finalizeProofLabel, type FinalizeProofInput } from '@/prototype/state/adapter/finalize-proof-label';
import { LocalTime } from '@/views/activity/LocalTime';
import './run-health-panel.css';
import { useLocale } from '@/i18n/use-locale';
import type { MessageKey, Translate } from '@/i18n';
import { proofWords } from '@/views/tests/proof-words';

type C = Translate;

/** A recorded status word ("green", "PASS_WITH_NOTES") in sentence case, never ALL CAPS. */
function sentence(word: string): string {
  const plain = word.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const VERDICT_WORD: Readonly<Record<string, MessageKey>> = {
  pass: 'rd.tests.health.reviews.pass',
  passed: 'rd.tests.health.reviews.pass',
  'pass with notes': 'rd.tests.health.reviews.passWithNotes',
  fail: 'rd.tests.health.reviews.fail',
  failed: 'rd.tests.health.reviews.fail',
  unknown: 'rd.tests.health.reviews.unknown',
};

/** A review verdict in the app locale; a verdict this list does not know keeps its own word. */
function verdictWord(verdict: string | null, t: C): string {
  const plain = (verdict ?? 'unknown').replace(/[_-]+/g, ' ').trim().toLowerCase();
  const key = VERDICT_WORD[plain];
  return key !== undefined ? t(key) : sentence(verdict ?? 'unknown');
}

function contractWord(status: 'green' | 'red' | null, t: C): string {
  if (status === 'green') return t('rd.tests.health.contract.green');
  if (status === 'red') return t('rd.tests.health.contract.red');
  return t('rd.tests.health.contract.unknown');
}

function GateEvidenceSection({ gateEvidence, t }: { gateEvidence: GatewayProofExtras['gateEvidence']; t: C }) {
  if (!gateEvidence.present) {
    return (
      <section className="fw-run-health__section">
        <h3 className="fw-run-health__label">{t('rd.tests.health.gates.title')}</h3>
        <p className="fw-run-health__empty">{t('rd.tests.health.gates.empty')}</p>
      </section>
    );
  }
  return (
    <section className="fw-run-health__section">
      <h3 className="fw-run-health__label">{t('rd.tests.health.gates.title')}</h3>
      <dl className="fw-run-health__facts">
        <div className="fw-run-health__fact">
          <dt>{t('rd.tests.health.gates.total')}</dt>
          <dd>
            <span className="fw-run-health__num">{gateEvidence.gatesTotal ?? '—'}</span>
          </dd>
        </div>
        <div className="fw-run-health__fact">
          <dt>{t('rd.tests.health.gates.failed')}</dt>
          <dd>
            <span className="fw-run-health__num">{gateEvidence.gatesFailed ?? '—'}</span>
          </dd>
        </div>
        <div className="fw-run-health__fact">
          <dt>{t('rd.tests.health.gates.allGreen')}</dt>
          <dd>
            <span className="fw-run-health__flag" data-flag={gateEvidence.allGreen === null ? 'unknown' : String(gateEvidence.allGreen)}>
              <Icon name={gateEvidence.allGreen === true ? 'CircleCheck' : gateEvidence.allGreen === false ? 'CircleX' : 'CircleDashed'} size="xs" />
              <span>
                {gateEvidence.allGreen === null
                  ? t('rd.tests.health.answer.unknown')
                  : gateEvidence.allGreen
                    ? t('rd.tests.health.answer.yes')
                    : t('rd.tests.health.answer.no')}
              </span>
            </span>
          </dd>
        </div>
        {gateEvidence.generatedAt !== null ? (
          <div className="fw-run-health__fact">
            <dt>{t('rd.tests.health.gates.generated')}</dt>
            <dd>
              <LocalTime value={gateEvidence.generatedAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      {/* REVIEW FIX (WP-CCD item 6): the real per-gate breakdown (`gate-evidence.json`'s own
          `gates[]`, readable names) — reuses `.fw-run-health__reviews`/`.fw-run-health__review`'s
          exact flex-row-card treatment (this same file's Reviews section below), never a new visual
          language: both are "an icon-ish status + a label + muted meta" row. */}
      {gateEvidence.gates.length > 0 ? (
        <ul className="fw-run-health__reviews">
          {gateEvidence.gates.map((gate, index) => (
            <li key={gate.name ?? `gate-${index}`} className="fw-run-health__review">
              <Icon name={gate.exitCode === 0 ? 'CircleCheck' : 'CircleX'} size="xs" />
              <span className="fw-run-health__review-subject fw-truncate">{gate.name ?? t('rd.tests.health.gates.unnamed')}</span>
              {gate.exitCode !== null ? <Machine muted>{t('rd.tests.health.gates.exit', { code: gate.exitCode })}</Machine> : null}
              {gate.timedOut === true ? <span className="fw-run-health__quiet">{t('rd.tests.health.gates.timedOut')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {gateEvidence.note !== null ? <p className="fw-run-health__note">{gateEvidence.note}</p> : null}
    </section>
  );
}

const PROOF_NOT_CHECKED: FinalizeProofInput = {
  available: false, pending: true, verdict: null, cause: null, reverified: null, archival: null, completionProof: null, allowlisted: null,
};

/**
 * the receipt's honest proof status — "Finalized (verified)" only when the central check re-confirmed it as
 * a completion proof; archival, stale and unconfirmed receipts say so in words (the colour only repeats the text).
 * The Info button opens the threat-model note the gateway passes ("Tamper-evident, not tamper-proof: ...").
 */
function ProofStatus({ finalize, t, locale }: { finalize: GatewayProofExtras['finalize']; t: C; locale: 'nl' | 'en' }) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const status = finalizeProofLabel(finalize.proof ?? PROOF_NOT_CHECKED);
  const words = proofWords(locale, { ...status, short: status.label });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div className="fw-run-health__proof" onKeyDown={onKeyDown}>
      <div className="fw-run-health__proof-row">
        <span className="fw-run-health__seal" data-tone={status.tone} data-proof={status.key}>
          <Icon name={status.icon} size="xs" />
          <span className="fw-run-health__seal-label">{words.label}</span>
        </span>
        {finalize.threatModel !== null ? (
          <IconButton
            icon="Info"
            label={open ? t('rd.tests.health.finalize.infoHide') : t('rd.tests.health.finalize.infoShow')}
            size="sm"
            className="fw-run-health__proof-info"
            aria-expanded={open}
            aria-controls={noteId}
            onClick={() => setOpen((v) => !v)}
          />
        ) : null}
      </div>
      <p className="fw-run-health__proof-detail">{words.detail}</p>
      {status.tone === 'warning' && finalize.proofNote !== null ? (
        <p className="fw-run-health__note">{t('rd.tests.health.finalize.checkResult', { note: finalize.proofNote })}</p>
      ) : null}
      {open && finalize.threatModel !== null ? (
        <div id={noteId} role="note" className="fw-run-health__popover">
          {finalize.threatModel}
        </div>
      ) : null}
    </div>
  );
}

function FinalizeSection({ finalize, t, locale }: { finalize: GatewayProofExtras['finalize']; t: C; locale: 'nl' | 'en' }) {
  return (
    <section className="fw-run-health__section">
      <h3 className="fw-run-health__label">{t('rd.tests.health.finalize.title')}</h3>
      {finalize.present ? <ProofStatus finalize={finalize} t={t} locale={locale} /> : null}
      {finalize.present ? (
        <dl className="fw-run-health__facts">
          {finalize.finalizedAt !== null ? (
            <div className="fw-run-health__fact">
              <dt>{t('rd.tests.health.finalize.written')}</dt>
              <dd>
                <LocalTime value={finalize.finalizedAt} />
              </dd>
            </div>
          ) : null}
          {finalize.digest !== null ? (
            <div className="fw-run-health__fact">
              <dt>{t('rd.tests.health.finalize.digest')}</dt>
              <dd>
                <Machine muted className="fw-truncate">
                  {finalize.digest}
                </Machine>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : finalize.invalidReason !== null ? (
        // RB2-M1: a receipt exists but no longer counts — say why, never that the file does not exist.
        <p className="fw-run-health__note">{t('rd.tests.health.finalize.invalid', { reason: finalize.invalidReason })}</p>
      ) : (
        <p className="fw-run-health__empty">{t('rd.tests.health.finalize.none')}</p>
      )}
    </section>
  );
}

function ContractSection({ contract, t }: { contract: GatewayProofExtras['contract']; t: C }) {
  return (
    <section className="fw-run-health__section">
      <h3 className="fw-run-health__label">{t('rd.tests.health.contract.title')}</h3>
      {contract.present ? (
        <>
          <p className="fw-run-health__contract-status" data-status={contract.status ?? 'unknown'}>
            <Icon name={contract.status === 'green' ? 'CircleCheck' : contract.status === 'red' ? 'CircleX' : 'CircleDashed'} size="xs" />
            <span>{contractWord(contract.status, t)}</span>
          </p>
          {/* REVIEW FIX (found via real screenshot verification, WP-CCD item 6): a real
              `run_contract.note` (e.g. "the central forge-runcontract.cjs was not found") was parsed
              but never rendered anywhere — a genuinely unknown status showed with no explanation of
              WHY, even when the gateway supplied a perfectly good one. */}
          {contract.note !== null ? <p className="fw-run-health__note">{contract.note}</p> : null}
          {contract.missingRules.length > 0 ? (
            // the list names the steps the run contract still misses — say so, so the red
            // list is not read as a list of errors or of steps already done.
            <p className="fw-run-health__missing-label" id="fw-run-health-missing">
              {t(contract.missingRules.length === 1 ? 'rd.tests.health.contract.missingOne' : 'rd.tests.health.contract.missingMany', {
                count: contract.missingRules.length,
              })}
            </p>
          ) : null}
          {contract.missingRules.length > 0 ? (
            <ul className="fw-run-health__missing" aria-labelledby="fw-run-health-missing">
              {contract.missingRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="fw-run-health__empty">{t('rd.tests.health.contract.empty')}</p>
      )}
    </section>
  );
}

function ReviewsSection({ reviews, t }: { reviews: GatewayProofExtras['reviews']; t: C }) {
  if (reviews.length === 0) {
    return (
      <section className="fw-run-health__section">
        <h3 className="fw-run-health__label">{t('rd.tests.health.reviews.title')}</h3>
        <p className="fw-run-health__empty">{t('rd.tests.health.reviews.empty')}</p>
      </section>
    );
  }
  return (
    <section className="fw-run-health__section">
      <h3 className="fw-run-health__label">{t('rd.tests.health.reviews.title')}</h3>
      <ul className="fw-run-health__reviews">
        {reviews.map((review) => (
          <li key={review.reviewId} className="fw-run-health__review">
            <span className="fw-run-health__review-verdict" data-verdict={review.verdict ?? 'unknown'}>
              <span>{verdictWord(review.verdict, t)}</span>
            </span>
            <span className="fw-run-health__review-subject fw-truncate">{review.subject ?? review.reviewId}</span>
            <span className="fw-run-health__quiet">{review.agent ?? t('rd.tests.health.reviews.unknownReviewer')}</span>
            {review.commitSha !== null ? <Machine muted>{review.commitSha}</Machine> : null}
            {review.completedAt !== null ? <LocalTime value={review.completedAt} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunHealthPanel({ extras, runId = null }: { extras: GatewayProofExtras; runId?: string | null }) {
  const { t, locale } = useLocale();
  return (
    <Panel
      title={t('rd.tests.health.title')}
      subtitle={runId !== null ? t('rd.tests.health.subtitleFor', { id: runId }) : t('rd.tests.health.subtitle')}
      padded={false}
      className="fw-tests__panel"
    >
      <div className="fw-run-health">
        <GateEvidenceSection gateEvidence={extras.gateEvidence} t={t} />
        <FinalizeSection finalize={extras.finalize} t={t} locale={locale} />
        <ContractSection contract={extras.contract} t={t} />
        <ReviewsSection reviews={extras.reviews} t={t} />
      </div>
    </Panel>
  );
}

export default RunHealthPanel;
