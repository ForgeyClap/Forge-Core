/**
 * (defects 6, 8, 10): the smaller Command Center fixes from the live verification.
 *   - timestamps read as local date + time, the ISO string stays in the tooltip;
 *   - a created-but-not-started work package reads PLANNED, not IDLE;
 *   - the cold-start conversation pick is not a selection, so the inspector does not show an old
 *     conversation on every page; a picked conversation's Markdown is rendered, not shown raw;
 *   - the run contract's red list is labelled "Missing steps".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { StatusBadge, Timestamp, formatTimestamp } from '@/components/primitives';
import { buildConversationDetail } from '@/components/shell/inspector-conversation-panel';
import { MarkdownProse } from '@/components/shell/inspector-shared';
import { reducer, type PrototypeState } from '@/prototype/state/prototype-store';
import { EMPTY_FINALIZE_RECEIPT, EMPTY_GATE_EVIDENCE } from '@/prototype/state/adapter/graph-and-proof';
import { RunHealthPanel } from '@/views/tests/RunHealthPanel';

afterEach(() => cleanup());

describe('formatTimestamp / <Timestamp>', () => {
  it('turns an ISO date-time into a short local date and time', () => {
    const { text, iso } = formatTimestamp('2026-10-09T20:35:52.124Z');
    expect(iso).toBe('2026-10-09T20:35:52.124Z');
    expect(text).toMatch(/^\d{1,2} Oct 2026, \d{2}:\d{2}$/);
  });

  it('leaves anything that is not an ISO date-time untouched', () => {
    expect(formatTimestamp('2h ago')).toEqual({ text: '2h ago', iso: null });
    expect(formatTimestamp('—')).toEqual({ text: '—', iso: null });
    expect(formatTimestamp(null)).toEqual({ text: '', iso: null });
  });

  it('renders <time> with the ISO string as dateTime and tooltip', () => {
    render(<Timestamp value="2026-10-09T20:35:52.124Z" />);
    const time = document.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-10-09T20:35:52.124Z');
    expect(time?.getAttribute('title')).toBe('2026-10-09T20:35:52.124Z');
    expect(time?.className).toContain('fw-timestamp');
  });
});

describe('StatusBadge label override', () => {
  it('can say PLANNED for an idle work package, with its own accessible sentence', () => {
    render(<StatusBadge status="idle" size="sm" label="PLANNED" description="Planned — created, not started yet." />);
    expect(screen.getByText('PLANNED')).toBeTruthy();
    expect(screen.getByText('Planned — created, not started yet.')).toBeTruthy();
    expect(screen.queryByText('IDLE')).toBeNull();
  });
});

describe('conversation selection', () => {
  const base = {
    activeConversationId: '',
    selection: { kind: 'none' },
  } as unknown as PrototypeState;

  it('a cold-start restore sets the active thread but selects nothing', () => {
    const next = reducer(base, { type: 'conversation/restore', id: 'c-1' });
    expect(next.activeConversationId).toBe('c-1');
    expect(next.selection).toEqual({ kind: 'none' });
  });

  it('an explicit activate still selects the conversation', () => {
    const next = reducer(base, { type: 'conversation/activate', id: 'c-1' });
    expect(next.selection).toEqual({ kind: 'conversation', id: 'c-1' });
  });

  it('renders the last message as Markdown, never as raw ** markers', () => {
    const state = {
      data: {
        projects: [],
        conversations: [
          {
            id: 'c-1',
            projectId: 'p',
            title: 'test',
            messageCount: 1,
            updatedAt: '2026-07-29T18:22:26.596Z',
            messages: [
              { id: 'm1', author: 'assistant', model: null, timestamp: '2026-07-29T12:29:10.244Z', body: '1. **Run the tests** — see [docs](https://example.com)\n2. `npm test`' },
            ],
          },
        ],
      },
    } as unknown as PrototypeState;
    const detail = buildConversationDetail(state, { kind: 'conversation', id: 'c-1' }, true);
    render(<>{detail?.body}</>);
    const strong = screen.getByText('Run the tests');
    expect(strong.tagName).toBe('STRONG');
    expect(document.body.textContent).not.toContain('**');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('inspector Markdown prose', () => {
  it('renders a project description with **bold** as <strong>, never the raw markers', () => {
    render(<MarkdownProse text="Develop the universal **hybrid** Forge system" idPrefix="t" />);
    expect(screen.getByText('hybrid').tagName).toBe('STRONG');
    expect(document.body.textContent).not.toContain('**');
  });
});

describe('Run contract — the red list is labelled', () => {
  it('says "Missing steps" above the list of rules the run still misses', () => {
    render(
      <RunHealthPanel
        extras={{
          reviews: [],
          gateEvidence: EMPTY_GATE_EVIDENCE,
          finalize: EMPTY_FINALIZE_RECEIPT,
          contract: { present: true, status: 'red', note: null, missingRules: ['memory-read', 'report-present'] } as never,
        }}
        runId="forge-x"
      />,
    );
    expect(screen.getByText('Missing steps (2):')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Missing steps (2):' })).toBeTruthy();
    expect(screen.getByText(/recorded reviews for forge-x\./)).toBeTruthy();
  });
});
