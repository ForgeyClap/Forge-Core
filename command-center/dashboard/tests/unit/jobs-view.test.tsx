/**
 * WP B5 — Klussen & bewijs (/jobs): status mapping, detail mapping from real gateway shapes,
 * and the screen's loading / error / empty / list / detail states in Dutch, with no banned term in
 * the interface copy (log names and log text are Uitgebreid detail and are excluded, like the Team
 * screen's jargon scan does).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import {
  buildJobDetail,
  jobStatus,
  parseJobsList,
  parsePendingAskCount,
  sortJobs,
} from '@/prototype/state/adapter/jobs';
import type { JobDetail, JobsList, Loaded } from '@/prototype/state/adapter/jobs';
import { parseRunRows } from '@/prototype/state/adapter/rows';
import { JobsPanel } from '@/views/jobs/JobsView';
import { JobDetailPanel } from '@/views/jobs/JobDetail';

const BANNED = /(?<![\p{L}\d_-])(Boss|WP|receipt|triage|GOAT|worktree|run|bypass|effort|subagent|hook|MCP|token|stderr|dispatch|CLI|Doctor|gateway|evidence|work package|the|and|with|your|you|this|for|to|not)(?![\p{L}\d_-])/giu;

function copyFindings(root: Element): string[] {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[data-log-text], [data-log-name]').forEach((node) => node.remove());
  const texts: string[] = [];
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    if (value) texts.push(value);
  }
  clone.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  return texts.flatMap((text) => [...text.replace(/\b(Forge|Claude|Discord)\b/g, ' ').matchAll(BANNED)].map((m) => `${m[1]} in "${text}"`));
}

const RUNS = {
  ok: true,
  runs: [
    { run_id: 'forge-old', title: 'Menukaart als pdf', status: 'finalized', finalized: true, started_at: '2026-10-30T09:00:00Z', last_work_at: '2026-10-30T10:00:00Z' },
    { run_id: 'forge-live', title: 'Website voor bakkerij', status: 'live', started_at: '2026-11-01T09:00:00Z', last_work_at: '2026-11-01T11:00:00Z' },
    { run_id: 'forge-fail', title: null, status: 'failed', started_at: '2026-10-31T09:00:00Z' },
    { run_id: 'forge-synthetic', title: 'x', status: 'live', synthetic: true, last_work_at: '2026-11-02T09:00:00Z' },
  ],
  runs_truncated: true,
};

function loaded<T>(status: Loaded<T>['status'], value: T, error: string | null = null): Loaded<T> {
  return { status, value, error, reload: vi.fn() };
}

describe('jobStatus: the four Eenvoudig words plus the detail', () => {
  it.each([
    ['live', 'busy', 'live'],
    ['running', 'busy', 'live'],
    ['finalized', 'done', 'finalized'],
    ['completed', 'done', 'completed'],
    ['report-only', 'done', 'reportOnly'],
    ['stalled', 'paused', 'stalled'],
    ['ended_unknown', 'paused', 'endedUnknown'],
    ['failed', 'paused', 'failed'],
    ['waiting_for_owner', 'waiting', 'waiting'],
    ['something-new', 'paused', 'unknown'],
  ])('%s -> %s / %s', (raw, simple, detail) => {
    expect(jobStatus({ status: raw, finalized: false, hasFinalReport: false })).toEqual({ simple, detail });
  });

  it('a missing status with only a final report is "done, report only", never finalized', () => {
    expect(jobStatus({ status: null, finalized: null, hasFinalReport: true })).toEqual({ simple: 'done', detail: 'reportOnly' });
    expect(jobStatus({ status: null, finalized: null, hasFinalReport: false })).toEqual({ simple: 'paused', detail: 'unknown' });
  });
});

describe('list mapping', () => {
  it('sorts newest first, drops synthetic rows and keeps the truncated flag', () => {
    const list = parseJobsList(RUNS);
    expect(list.rows.map((row) => row.runId)).toEqual(['forge-live', 'forge-fail', 'forge-old']);
    expect(list.truncated).toBe(true);
    expect(sortJobs(parseRunRows({ runs: [{ run_id: '' }] }))).toEqual([]);
  });

  it('counts pending asks from the real route shape', () => {
    expect(parsePendingAskCount({ ok: true, pending_asks: [{ id: 'a' }, { id: 'b' }] })).toBe(2);
    expect(parsePendingAskCount({ ok: true })).toBe(0);
  });
});

describe('detail mapping (missions + proof)', () => {
  const mission = {
    wps: [
      { id: 'WP-B5', wp_id: 'wp-b5', note: 'Vier schermen bouwen', agent: 'UI Boss' },
      { id: 'WP-B5', wp_id: 'wp-b5', note: 'dubbel', agent: 'UI Boss' },
      { id: 'WP-X', note: 'Nog niet begonnen', agent: null },
    ],
    tasks: [
      { agent: 'UI Boss', wp_id: 'wp-b5', status: 'completed', task: 'schermen' },
      { agent: 'Test Boss', wp_id: 'wp-b5', status: 'running', task: 'tests' },
      { agent: 'Build Boss', status: 'failed', task: 'losse taak' },
    ],
    verdicts: [],
  };
  const proof = {
    verdicts: [
      { source: 'doctor', ok: true, passed: 40, failed: 0 },
      { source: 'event', event_type: 'check_passed', check: 'unit tests', agent: 'Verify Boss', evidence: 'test-results/unit.txt', timestamp: '2026-11-01T10:00:00Z' },
      { source: 'event', event_type: 'check_failed', command: 'npm run lint', role: 'verifier', evidence: { file: 'x' } },
    ],
    reviews: [{ review_id: 'r1', agent: 'Review Boss', verdict: 'PASS', subject: 'B5 schermen' }],
    finalize_receipt: { digest: 'abc', finalized_at: '2026-11-01T12:00:00Z' },
    finalize_acceptance: { available: true, verdict: 'FINALIZED', completion_proof: true },
  };

  it('joins tasks to their work package once, keeps loose tasks, and maps checks, reviews and the receipt', () => {
    const detail = buildJobDetail('forge-live', mission, proof);
    expect(detail.workPackages).toHaveLength(2);
    expect(detail.workPackages[0]).toMatchObject({ code: 'WP-B5', title: 'Vier schermen bouwen', state: 'busy', taskCount: 2 });
    expect(detail.workPackages[1]).toMatchObject({ code: 'WP-X', state: 'open', taskCount: 0 });
    expect(detail.looseTasks.map((task) => task.task)).toEqual(['losse taak']);
    expect(detail.checks[0]).toMatchObject({ kind: 'forge', passed: true, forgePassed: 40, forgeFailed: 0 });
    expect(detail.checks[1]).toMatchObject({ name: 'unit tests', passed: true, who: 'Verify Boss', pointer: 'test-results/unit.txt' });
    // A non-text proof field is not shown as a pointer (never stringified into "[object Object]").
    expect(detail.checks[2]).toMatchObject({ name: null, command: 'npm run lint', passed: false, pointer: null, who: 'verifier' });
    expect(detail.reviews[0]).toMatchObject({ verdict: 'PASS', agent: 'Review Boss' });
    expect(detail.receipt).toEqual({ present: true, finalizedAt: '2026-11-01T12:00:00Z', invalidReason: null, proofKey: 'verified' });
  });

  it('without a receipt it says so; an invalid receipt keeps its reason', () => {
    expect(buildJobDetail('r', {}, {}).receipt).toEqual({ present: false, finalizedAt: null, invalidReason: null, proofKey: null });
    expect(buildJobDetail('r', {}, { finalize_receipt: null, finalize_invalid_reason: 'log changed' }).receipt.invalidReason).toBe('log changed');
  });
});

describe('JobsPanel (Dutch)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  const list = parseJobsList(RUNS);
  const base = { projectName: 'bakkerij', pendingAsks: 0, selectedId: null, onSelect: vi.fn(), onOpenChat: vi.fn() };

  it('no project chosen', () => {
    render(createElement(JobsPanel, { ...base, projectName: '', list: loaded<JobsList>('loading', { rows: [], truncated: false }) }));
    expect(screen.getByText('Nog geen project gekozen')).toBeInTheDocument();
  });

  it('no project because Forge cannot be reached: an error, not "no project chosen"', () => {
    render(createElement(JobsPanel, { ...base, projectName: '', projectsStatus: 'error', list: loaded<JobsList>('loading', { rows: [], truncated: false }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('Forge is nu niet bereikbaar');
    expect(screen.queryByText('Nog geen project gekozen')).toBeNull();
  });

  it('loading', () => {
    render(createElement(JobsPanel, { ...base, list: loaded<JobsList>('loading', { rows: [], truncated: false }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Klussen ophalen…');
  });

  it('error when Forge cannot be reached: a retry, the raw error only under Technische details', () => {
    const state = loaded<JobsList>('error', { rows: [], truncated: false }, 'Failed to fetch');
    const { container } = render(createElement(JobsPanel, { ...base, list: state }));
    expect(screen.getByRole('alert')).toHaveTextContent('Forge is nu niet bereikbaar');
    fireEvent.click(screen.getByRole('button', { name: 'Opnieuw proberen' }));
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Technische details')).toBeInTheDocument();
    expect(copyFindings(container)).toEqual([]);
  });

  it('empty: no jobs yet, with a way to the chat', () => {
    const onOpenChat = vi.fn();
    render(createElement(JobsPanel, { ...base, onOpenChat, list: loaded<JobsList>('ready', { rows: [], truncated: false }) }));
    expect(screen.getByText('Nog geen klussen in dit project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Naar Gesprekken' }));
    expect(onOpenChat).toHaveBeenCalled();
  });

  it('list: titles, the four words, the details, the pending-question banner and the truncation note', () => {
    const onSelect = vi.fn();
    const { container } = render(createElement(JobsPanel, { ...base, onSelect, pendingAsks: 2, list: loaded('ready', list) }));
    const items = screen.getByRole('list', { name: 'Klussen van dit project' });
    expect(items.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('Website voor bakkerij')).toBeInTheDocument();
    expect(screen.getByText('Klus zonder titel')).toBeInTheDocument();
    expect(screen.getAllByText('Bezig').length).toBeGreaterThan(0);
    expect(screen.getByText('Klaar')).toBeInTheDocument();
    expect(screen.getByText('Gestopt door een fout')).toBeInTheDocument();
    expect(screen.getByText('Er wachten 2 vragen op jou in Gesprekken.')).toBeInTheDocument();
    expect(screen.getByText(/Niet alle klussen staan in deze lijst/)).toBeInTheDocument();
    // Redesign 2B: the list is full width; a pick replaces it (no "Kies links" hint any more).
    expect(screen.queryByText('Kies links een klus om te zien wat er gedaan is.')).toBeNull();
    fireEvent.click(screen.getByText('Menukaart als pdf'));
    expect(onSelect).toHaveBeenCalledWith('forge-old');
    // Every row carries its own proof link, which opens that klus at its opleverbewijs.
    const proofLinks = screen.getAllByRole('button', { name: 'Bekijk bewijs' });
    expect(proofLinks).toHaveLength(3);
    fireEvent.click(proofLinks[0]);
    expect(onSelect).toHaveBeenLastCalledWith('forge-live', 'proof');
    expect(copyFindings(container)).toEqual([]);
  });

  it('a picked klus replaces the list, with a way back', () => {
    // The detail hook polls the gateway: answer in-process so no test ever reaches a live one.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response));
    const onSelect = vi.fn();
    render(createElement(JobsPanel, { ...base, onSelect, selectedId: 'forge-old', list: loaded('ready', list) }));
    expect(screen.queryByRole('list', { name: 'Klussen van dit project' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Menukaart als pdf' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Terug naar de lijst' }));
    expect(onSelect).toHaveBeenCalledWith(null);
    vi.unstubAllGlobals();
  });

  it('embedded in the project page: no page title of its own', () => {
    render(createElement(JobsPanel, { ...base, embedded: true, list: loaded('ready', list) }));
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('list', { name: 'Klussen van dit project' })).toBeInTheDocument();
  });
});

describe('JobDetailPanel (Dutch)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  const row = parseJobsList(RUNS).rows[0];
  const detail = buildJobDetail(
    'forge-live',
    { wps: [{ id: 'WP-1', wp_id: 'wp-1', note: 'Pagina’s bouwen', agent: 'Build Boss' }], tasks: [{ agent: 'Build Boss', wp_id: 'wp-1', status: 'completed' }] },
    {
      verdicts: [{ source: 'event', event_type: 'check_failed', check: 'telefoonformaat', agent: 'Test Boss', evidence: 'shots/390.png' }],
      reviews: [{ review_id: 'r', agent: 'Review Boss', verdict: null, subject: 'opmaak' }],
    },
  );

  it('shows tasks with Dutch role names, the proof blocks and "not signed off yet"', () => {
    const { container } = render(createElement(JobDetailPanel, { row, detail: loaded<JobDetail>('ready', detail), onBack: vi.fn() }));
    expect(screen.getByRole('heading', { name: 'Website voor bakkerij' })).toBeInTheDocument();
    expect(screen.getByText('Pagina’s bouwen')).toBeInTheDocument();
    expect(screen.getAllByText(/Bouwer/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Opleverbewijs' })).toBeInTheDocument();
    expect(screen.getByText('Niet geslaagd')).toBeInTheDocument();
    expect(screen.getByText('Bewijs: shots/390.png')).toBeInTheDocument();
    expect(screen.getByText('Uitslag nog niet bekend')).toBeInTheDocument();
    expect(screen.getByText(/Nog niet afgetekend/)).toBeInTheDocument();
    expect(copyFindings(container)).toEqual([]);
  });

  it('detail error and loading are explicit', () => {
    const errorState = loaded<JobDetail>('error', detail, 'HTTP 500');
    render(createElement(JobDetailPanel, { row, detail: errorState, onBack: vi.fn() }));
    expect(screen.getByRole('alert')).toHaveTextContent('De details van deze klus konden niet worden opgehaald.');
    cleanup();
    render(createElement(JobDetailPanel, { row, detail: loaded<JobDetail>('loading', detail), onBack: vi.fn() }));
    expect(screen.getByRole('status')).toHaveTextContent('Details van deze klus ophalen…');
  });
});
