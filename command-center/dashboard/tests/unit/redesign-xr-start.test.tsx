/**
 * Redesign fix round XR-START (UI Boss), F5: "Bekijk een opleverbewijs" on Start ticks only when a real
 * opleverbewijs was actually on screen in a klus's detail (JobDetail.tsx calls `markStartProofSeen()`).
 *
 * "Real" = the klus has a finalize receipt, a recorded check or a review. The proof section with only its
 * empty lines ("nog niet afgetekend", "geen controles") is not a proof. "On screen" = the proof section
 * entered the viewport (IntersectionObserver); a browser without one never ticks it by guess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { buildJobDetail, parseJobsList } from '@/prototype/state/adapter/jobs';
import type { JobDetail, Loaded } from '@/prototype/state/adapter/jobs';
import { JobDetailPanel } from '@/views/jobs/JobDetail';
import { START_STORAGE_KEY, readStartStored } from '@/views/home/start-checklist';

const ROW = parseJobsList({ ok: true, runs: [{ run_id: 'forge-live', title: 'Website voor bakkerij', status: 'live', started_at: '2026-11-01T09:00:00Z' }] }).rows[0];

const MISSION = { wps: [{ id: 'WP-1', wp_id: 'wp-1', note: 'Pagina’s bouwen', agent: 'Build Boss' }], tasks: [] };

const WITH_CHECK = buildJobDetail('forge-live', MISSION, {
  verdicts: [{ source: 'event', event_type: 'check_passed', check: 'telefoonformaat', agent: 'Test Boss', evidence: 'shots/390.png' }],
});
const WITH_RECEIPT = buildJobDetail('forge-live', MISSION, {
  finalize_receipt: { digest: 'abc', finalized_at: '2026-11-01T12:00:00Z' },
  finalize_acceptance: { available: true, verdict: 'FINALIZED', completion_proof: true },
});
const WITH_REVIEW = buildJobDetail('forge-live', MISSION, { reviews: [{ review_id: 'r', agent: 'Review Boss', verdict: 'PASS', subject: 'opmaak' }] });
const NO_PROOF = buildJobDetail('forge-live', MISSION, {});

function loaded(status: Loaded<JobDetail>['status'], value: JobDetail): Loaded<JobDetail> {
  return { status, value, error: status === 'error' ? 'HTTP 500' : null, reload: vi.fn() };
}

/** A hand-driven IntersectionObserver: the test decides when the observed section enters the viewport. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  fire(isIntersecting: boolean) {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }) as unknown as IntersectionObserverEntry);
    if (entries.length > 0) this.callback(entries, this as unknown as IntersectionObserver);
  }
}

function scrollProofIntoView(isIntersecting = true) {
  act(() => {
    FakeObserver.all.filter((observer) => !observer.disconnected).forEach((observer) => observer.fire(isIntersecting));
  });
}

function show(detail: Loaded<JobDetail>) {
  return render(createElement(JobDetailPanel, { row: ROW, detail, onBack: vi.fn() }));
}

beforeEach(() => {
  localStorage.clear();
  setLocale('nl');
  FakeObserver.all = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('F5: a real opleverbewijs on screen ticks "Bekijk een opleverbewijs"', () => {
  it.each([
    ['a recorded check', WITH_CHECK],
    ['a finalize receipt', WITH_RECEIPT],
    ['a review', WITH_REVIEW],
  ])('ticks once the proof with %s scrolls into view, not before', (_label, detail) => {
    show(loaded('ready', detail));
    expect(readStartStored().proofSeen).toBe(false);
    scrollProofIntoView(false);
    expect(readStartStored().proofSeen).toBe(false);
    scrollProofIntoView(true);
    expect(readStartStored().proofSeen).toBe(true);
    expect(JSON.parse(localStorage.getItem(START_STORAGE_KEY) ?? '{}')).toMatchObject({ proofSeen: true });
  });

  it('the observed element is the proof section itself', () => {
    const { container } = show(loaded('ready', WITH_CHECK));
    const section = container.querySelector('.fw-jobs__proof');
    expect(section).not.toBeNull();
    expect(FakeObserver.all.some((observer) => observer.targets.has(section as Element))).toBe(true);
  });
});

describe('F5: no tick without a real proof on screen', () => {
  it('a klus with no receipt, no checks and no reviews never ticks, even in view', () => {
    show(loaded('ready', NO_PROOF));
    scrollProofIntoView(true);
    expect(readStartStored().proofSeen).toBe(false);
  });

  it('while the detail is loading or failed, nothing ticks', () => {
    show(loaded('loading', WITH_CHECK));
    scrollProofIntoView(true);
    expect(readStartStored().proofSeen).toBe(false);
    cleanup();
    show(loaded('error', WITH_CHECK));
    scrollProofIntoView(true);
    expect(readStartStored().proofSeen).toBe(false);
  });

  it('without an IntersectionObserver it cannot tell, so it does not tick (no guess)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    show(loaded('ready', WITH_CHECK));
    expect(readStartStored().proofSeen).toBe(false);
  });

  it('leaving the klus before the proof came into view stops watching', () => {
    const { unmount } = show(loaded('ready', WITH_CHECK));
    unmount();
    scrollProofIntoView(true);
    expect(readStartStored().proofSeen).toBe(false);
  });
});
