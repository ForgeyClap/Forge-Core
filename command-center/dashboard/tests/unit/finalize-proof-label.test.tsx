/**
 * the honest finalize-proof label. A receipt file existing is not a completion proof — the panel reads the
 * central finalize acceptance (`/api/proof` → `finalize_acceptance`) and only says "Finalized (verified)" when the
 * check re-confirmed it. Archival, stale and unconfirmed receipts say so in words; the Info button shows the
 * threat-model note the gateway passes.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { finalizeProofLabel, type FinalizeProofInput } from '@/prototype/state/adapter/finalize-proof-label';
import { RunHealthPanel } from '@/views/tests/RunHealthPanel';
import {
  EMPTY_GATE_EVIDENCE,
  EMPTY_RUN_CONTRACT,
  parseFinalizeReceipt,
} from '@/prototype/state/adapter/graph-and-proof';

const base: FinalizeProofInput = {
  available: true, pending: false, verdict: null, cause: null, reverified: false, archival: false, completionProof: false, allowlisted: null,
};

describe('finalizeProofLabel — every acceptance state maps to an honest label', () => {
  it('FINALIZED + completion_proof -> Finalized (verified)', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'FINALIZED', completionProof: true });
    expect(l.label).toBe('Finalized (verified)');
    expect(l.tone).toBe('verified');
  });

  it('HISTORICAL re-verified under its own rules -> Finalized (verified)', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'HISTORICAL', cause: 'ruleset', reverified: true, completionProof: true });
    expect(l.key).toBe('verified');
  });

  it('HISTORICAL allowlisted legacy (completion proof, archival, not re-verified) -> Archival record (not re-verified)', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'HISTORICAL', cause: 'legacy-receipt', archival: true, completionProof: true, allowlisted: 'pre-evidence' });
    expect(l.label).toBe('Archival record (not re-verified)');
    expect(l.tone).toBe('archival');
    expect(l.detail).toMatch(/older finalize generation \(pre-evidence\)/);
  });

  it('HISTORICAL by ruleset, not re-run -> Archival record (not re-verified)', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'HISTORICAL', cause: 'ruleset', archival: true, completionProof: true, allowlisted: 'pre-pinned-ruleset' });
    expect(l.key).toBe('archival');
    expect(l.detail).toMatch(/rules have changed/);
  });

  it('HISTORICAL unverified-archival -> Unverified archival, warning', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'HISTORICAL', cause: 'unverified-archival', archival: true, completionProof: false });
    expect(l.label).toBe('Unverified archival');
    expect(l.tone).toBe('warning');
  });

  it('an older central tool without completion_proof on HISTORICAL is never verified', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'HISTORICAL', completionProof: null, reverified: null });
    expect(l.key).toBe('unverified-archival');
  });

  it('STALE -> Stale, warning', () => {
    const l = finalizeProofLabel({ ...base, verdict: 'STALE' });
    expect(l.label).toBe('Stale');
    expect(l.tone).toBe('warning');
  });

  it('FINALIZED that the tool says is not a completion proof is never verified', () => {
    expect(finalizeProofLabel({ ...base, verdict: 'FINALIZED', completionProof: false }).key).toBe('unconfirmed');
  });

  it('UNDETERMINED / unknown verdicts -> Proof not confirmed, warning', () => {
    expect(finalizeProofLabel({ ...base, verdict: 'UNDETERMINED' }).key).toBe('unconfirmed');
    expect(finalizeProofLabel({ ...base, verdict: 'SOMETHING_NEW' }).tone).toBe('warning');
  });

  it('check not run / could not run', () => {
    expect(finalizeProofLabel({ ...base, available: false, pending: true }).key).toBe('checking');
    const failed = finalizeProofLabel({ ...base, available: false, pending: false });
    expect(failed.key).toBe('unconfirmed');
    expect(failed.tone).toBe('warning');
  });
});

describe('parseFinalizeReceipt — reads finalize_acceptance and the threat-model note', () => {
  it('carries the acceptance fields', () => {
    const r = parseFinalizeReceipt({
      finalize_receipt: { digest: 'abc', finalized_at: '2026-09-01T11:05:00.000Z' },
      finalize_acceptance: { available: true, verdict: 'HISTORICAL', cause: 'ruleset', reverified: false, archival: true, completion_proof: true, allowlisted: 'pre-pinned-ruleset', reason: 'judged against an older ruleset', threat_model: 'Tamper-evident, not tamper-proof: test note.' },
    });
    expect(r.proof).toEqual({ available: true, pending: false, verdict: 'HISTORICAL', cause: 'ruleset', reverified: false, archival: true, completionProof: true, allowlisted: 'pre-pinned-ruleset' });
    expect(r.threatModel).toBe('Tamper-evident, not tamper-proof: test note.');
    expect(r.proofNote).toBe('judged against an older ruleset');
  });

  it('a receipt without finalize_acceptance (older gateway) reads as not checked yet', () => {
    const r = parseFinalizeReceipt({ finalize_receipt: { digest: 'abc' } });
    expect(r.proof?.available).toBe(false);
    expect(r.proof?.pending).toBe(true);
  });
});

function renderWith(payload: Record<string, unknown>) {
  const finalize = parseFinalizeReceipt(payload);
  return render(<RunHealthPanel extras={{ reviews: [], gateEvidence: EMPTY_GATE_EVIDENCE, finalize, contract: EMPTY_RUN_CONTRACT }} />);
}
const receipt = { digest: 'abc123', finalized_at: '2026-09-01T11:05:00.000Z' };

describe('RunHealthPanel — the receipt shows its honest proof status, in words', () => {
  it('a verified receipt reads "Finalized (verified)"; the date is labelled as the receipt date, not as proof', () => {
    renderWith({ finalize_receipt: receipt, finalize_acceptance: { available: true, verdict: 'FINALIZED', completion_proof: true, threat_model: 'Tamper-evident, not tamper-proof: x' } });
    expect(screen.getByText('Finalized (verified)')).toBeTruthy();
    expect(screen.getByText('Receipt written')).toBeTruthy();
    expect(screen.queryByText(/^Finalized$/)).toBeNull();
  });

  it('a stale receipt shows "Stale" with the check result, never "Finalized"', () => {
    renderWith({ finalize_receipt: receipt, finalize_acceptance: { available: true, verdict: 'STALE', reason: 'the log changed', threat_model: 'n' } });
    expect(screen.getByText('Stale')).toBeTruthy();
    expect(screen.getByText(/Check result: the log changed/)).toBeTruthy();
    expect(screen.queryByText(/Finalized \(verified\)/)).toBeNull();
    const seal = screen.getByText('Stale').closest('[data-tone]');
    expect(seal?.getAttribute('data-tone')).toBe('warning');
  });

  it('an unverified archival receipt shows "Unverified archival" in the warning style', () => {
    renderWith({ finalize_receipt: receipt, finalize_acceptance: { available: true, verdict: 'HISTORICAL', cause: 'unverified-archival', archival: true, completion_proof: false } });
    const seal = screen.getByText('Unverified archival').closest('[data-tone]');
    expect(seal?.getAttribute('data-tone')).toBe('warning');
  });

  it('the Info button toggles the threat-model note and Escape closes it', () => {
    renderWith({ finalize_receipt: receipt, finalize_acceptance: { available: true, verdict: 'FINALIZED', completion_proof: true, threat_model: 'Tamper-evident, not tamper-proof: a later edit is detected.' } });
    expect(screen.queryByRole('note')).toBeNull();
    const button = screen.getByRole('button', { name: 'What this receipt can prove' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('note').textContent).toMatch(/^Tamper-evident, not tamper-proof/);
    expect(screen.getByRole('button', { name: 'Hide what this receipt can prove' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(screen.getByRole('note'), { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
  });
});
