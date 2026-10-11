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
 * Existing primitives/classes only — `Eyebrow`/`Icon`/`Machine`/`Panel`/`EmptyState`, and this
 * view's own `.fw-tests__panel`/`.fw-tests__stat` treatment, extended with a handful of new,
 * narrowly-scoped classes in `run-health-panel.css` that reuse existing tokens only.
 */

import { useId, useState, type KeyboardEvent } from 'react';
import { Eyebrow, Icon, IconButton, Machine, Panel, Timestamp } from '@/components/primitives';
import type { GatewayProofExtras } from '@/prototype/state/gateway-adapter';
import { finalizeProofLabel, type FinalizeProofInput } from '@/prototype/state/adapter/finalize-proof-label';
import './run-health-panel.css';

function GateEvidenceSection({ gateEvidence }: { gateEvidence: GatewayProofExtras['gateEvidence'] }) {
  if (!gateEvidence.present) {
    return (
      <section className="fw-run-health__section">
        <Eyebrow>Gate evidence</Eyebrow>
        <p className="fw-run-health__empty">No gate-evidence record has been read for this run yet.</p>
      </section>
    );
  }
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Gate evidence</Eyebrow>
      <dl className="fw-run-health__facts">
        <div className="fw-run-health__fact">
          <dt>Gates run</dt>
          <dd>
            <Machine>{gateEvidence.gatesTotal ?? '—'}</Machine>
          </dd>
        </div>
        <div className="fw-run-health__fact">
          <dt>Gates failed</dt>
          <dd>
            <Machine>{gateEvidence.gatesFailed ?? '—'}</Machine>
          </dd>
        </div>
        <div className="fw-run-health__fact">
          <dt>All green</dt>
          <dd>
            <span className="fw-run-health__flag" data-flag={gateEvidence.allGreen === null ? 'unknown' : String(gateEvidence.allGreen)}>
              <Icon name={gateEvidence.allGreen === true ? 'CircleCheck' : gateEvidence.allGreen === false ? 'CircleX' : 'CircleDashed'} size="xs" />
              <Machine>{gateEvidence.allGreen === null ? 'unknown' : gateEvidence.allGreen ? 'yes' : 'no'}</Machine>
            </span>
          </dd>
        </div>
        {gateEvidence.generatedAt !== null ? (
          <div className="fw-run-health__fact">
            <dt>Generated</dt>
            <dd>
              <Timestamp value={gateEvidence.generatedAt} />
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
              <span className="fw-run-health__review-subject fw-truncate">{gate.name ?? 'unnamed gate'}</span>
              {gate.exitCode !== null ? <Machine muted>exit {gate.exitCode}</Machine> : null}
              {gate.timedOut === true ? <Machine muted>timed out</Machine> : null}
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
function ProofStatus({ finalize }: { finalize: GatewayProofExtras['finalize'] }) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const status = finalizeProofLabel(finalize.proof ?? PROOF_NOT_CHECKED);
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
          <span className="fw-run-health__seal-label">{status.label}</span>
        </span>
        {finalize.threatModel !== null ? (
          <IconButton
            icon="Info"
            label={open ? 'Hide what this receipt can prove' : 'What this receipt can prove'}
            size="sm"
            className="fw-run-health__proof-info"
            aria-expanded={open}
            aria-controls={noteId}
            onClick={() => setOpen((v) => !v)}
          />
        ) : null}
      </div>
      <p className="fw-run-health__proof-detail">{status.detail}</p>
      {status.tone === 'warning' && finalize.proofNote !== null ? (
        <p className="fw-run-health__note">Check result: {finalize.proofNote}</p>
      ) : null}
      {open && finalize.threatModel !== null ? (
        <div id={noteId} role="note" className="fw-run-health__popover">
          {finalize.threatModel}
        </div>
      ) : null}
    </div>
  );
}

function FinalizeSection({ finalize }: { finalize: GatewayProofExtras['finalize'] }) {
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Finalize receipt</Eyebrow>
      {finalize.present ? <ProofStatus finalize={finalize} /> : null}
      {finalize.present ? (
        <dl className="fw-run-health__facts">
          {finalize.finalizedAt !== null ? (
            <div className="fw-run-health__fact">
              <dt>Receipt written</dt>
              <dd>
                <Timestamp value={finalize.finalizedAt} />
              </dd>
            </div>
          ) : null}
          {finalize.digest !== null ? (
            <div className="fw-run-health__fact">
              <dt>Digest</dt>
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
        <p className="fw-run-health__note">A finalize receipt exists but no longer counts: {finalize.invalidReason}.</p>
      ) : (
        <p className="fw-run-health__empty">This run has not been finalized yet — no `run-finalized.json` receipt exists.</p>
      )}
    </section>
  );
}

function ContractSection({ contract }: { contract: GatewayProofExtras['contract'] }) {
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Run contract</Eyebrow>
      {contract.present ? (
        <>
          <p className="fw-run-health__contract-status" data-status={contract.status ?? 'unknown'}>
            <Icon name={contract.status === 'green' ? 'CircleCheck' : contract.status === 'red' ? 'CircleX' : 'CircleDashed'} size="xs" />
            <Machine>{contract.status ?? 'unknown'}</Machine>
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
              Missing steps ({contract.missingRules.length}):
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
        <p className="fw-run-health__empty">No run-contract check has been recorded for this run yet.</p>
      )}
    </section>
  );
}

function ReviewsSection({ reviews }: { reviews: GatewayProofExtras['reviews'] }) {
  if (reviews.length === 0) {
    return (
      <section className="fw-run-health__section">
        <Eyebrow>Reviews</Eyebrow>
        <p className="fw-run-health__empty">No review has been recorded for this run yet.</p>
      </section>
    );
  }
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Reviews</Eyebrow>
      <ul className="fw-run-health__reviews">
        {reviews.map((review) => (
          <li key={review.reviewId} className="fw-run-health__review">
            <span className="fw-run-health__review-verdict" data-verdict={review.verdict ?? 'unknown'}>
              <Machine>{review.verdict ?? 'unknown'}</Machine>
            </span>
            <span className="fw-run-health__review-subject fw-truncate">{review.subject ?? review.reviewId}</span>
            <Machine muted>{review.agent ?? 'unknown reviewer'}</Machine>
            {review.commitSha !== null ? <Machine muted>{review.commitSha}</Machine> : null}
            {review.completedAt !== null ? <Timestamp value={review.completedAt} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunHealthPanel({ extras, runId = null }: { extras: GatewayProofExtras; runId?: string | null }) {
  return (
    <Panel
      title="Run health"
      subtitle={
        runId !== null
          ? `Gate evidence, the finalize receipt, the run contract, and any recorded reviews for ${runId}.`
          : 'Gate evidence, the finalize receipt, the run contract, and any recorded reviews for this run.'
      }
      padded={false}
      className="fw-tests__panel"
    >
      <div className="fw-run-health">
        <GateEvidenceSection gateEvidence={extras.gateEvidence} />
        <FinalizeSection finalize={extras.finalize} />
        <ContractSection contract={extras.contract} />
        <ReviewsSection reviews={extras.reviews} />
      </div>
    </Panel>
  );
}

export default RunHealthPanel;
