/**
 * WP B3 — the status model: nine work states (Uitgebreid, by name) mapped onto four Eenvoudig
 * words (Bezig · Wacht op jou · Gepauzeerd · Mislukt; plan §4.2, PRODUCT-CARD.md, Lead decision
 * 2026-11-02), COMPLETED without a chip, the signal -> state rules, the chip, and the error card a
 * failed run always shows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ErrorCard } from '@/views/chat/errors/ErrorCard';

import { setLocale, translate } from '@/i18n';
import { ChatStatusChip } from '@/views/chat/status/ChatStatus';
import {
  FROM_OPERATIONAL,
  PROTOCOL_STATES,
  SIMPLE_FOR,
  SIMPLE_STATES,
  deriveProtocolState,
  errorCardFor,
  toSimpleState,
} from '@/views/chat/status/status-model';

describe('status model', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  it('has exactly nine detailed states and four simple ones', () => {
    expect(PROTOCOL_STATES).toHaveLength(9);
    expect(SIMPLE_STATES).toEqual(['busy', 'waiting', 'paused', 'failed']);
    expect(SIMPLE_STATES.map((state) => translate('nl', `chatCards.status.simple.${state}`))).toEqual([
      'Bezig',
      'Wacht op jou',
      'Gepauzeerd',
      'Mislukt',
    ]);
    expect(SIMPLE_STATES.map((state) => translate('en', `chatCards.status.simple.${state}`))).toEqual([
      'Working',
      'Waiting for you',
      'Paused',
      'Failed',
    ]);
  });

  it('maps every detailed state (the table in the code, row by row)', () => {
    expect(SIMPLE_FOR).toEqual({
      QUEUED: 'busy',
      STARTING: 'busy',
      STREAMING: 'busy',
      RETRYING: 'busy',
      WAITING_FOR_PERMISSION: 'waiting',
      WAITING: 'waiting',
      INTERRUPTED: 'paused',
      FAILED: 'failed',
      COMPLETED: null,
    });
    // Every simple state is reached; only COMPLETED has none (no chip). Every detailed state has a
    // Dutch and English description for Uitgebreid.
    expect(new Set(PROTOCOL_STATES.map(toSimpleState))).toEqual(new Set([...SIMPLE_STATES, null]));
    for (const state of PROTOCOL_STATES) {
      expect(translate('nl', `chatCards.status.detail.${state}`)).not.toContain('chatCards');
      expect(translate('en', `chatCards.status.detail.${state}`)).not.toContain('chatCards');
    }
  });

  it('derives the state from signals; something that needs the user wins', () => {
    expect(deriveProtocolState({})).toBeNull();
    expect(deriveProtocolState({ streaming: true, pendingPermissions: 2 })).toBe('WAITING_FOR_PERMISSION');
    expect(deriveProtocolState({ streaming: true, pendingQuestion: true })).toBe('WAITING');
    expect(deriveProtocolState({ streaming: true, error: { code: 'api_retry' } })).toBe('RETRYING');
    expect(deriveProtocolState({ error: { code: 'rate_limited' } })).toBe('INTERRUPTED');
    expect(deriveProtocolState({ error: { code: 'unknown' } })).toBe('FAILED');
    expect(deriveProtocolState({ interrupted: true })).toBe('INTERRUPTED');
    expect(deriveProtocolState({ streaming: true })).toBe('STREAMING');
    expect(deriveProtocolState({ starting: true })).toBe('STARTING');
    expect(deriveProtocolState({ queued: true })).toBe('QUEUED');
    expect(deriveProtocolState({ completed: true })).toBe('COMPLETED');
  });

  it('folds every operational run status onto the nine, and the run status yields to user-facing signals', () => {
    expect(Object.keys(FROM_OPERATIONAL)).toHaveLength(23);
    expect(new Set(Object.values(FROM_OPERATIONAL))).toEqual(new Set(PROTOCOL_STATES));
    expect(deriveProtocolState({ runStatus: 'VERIFYING' })).toBe('STREAMING');
    expect(deriveProtocolState({ runStatus: 'RESUMABLE' })).toBe('INTERRUPTED');
    expect(deriveProtocolState({ runStatus: 'FAILED_RECOVERY' })).toBe('FAILED');
    expect(deriveProtocolState({ runStatus: 'RUNNING', pendingPermissions: 1 })).toBe('WAITING_FOR_PERMISSION');
  });

  it('an unanswered permission is "Wacht op jou", never failed', () => {
    const state = deriveProtocolState({ pendingPermissions: 1 });
    expect(state).not.toBe('FAILED');
    expect(toSimpleState(state!)).toBe('waiting');
  });

  it('a failed run always has an error card: the catalogue code when known, else the unknown card', () => {
    expect(errorCardFor('FAILED', null)).toEqual({ code: 'unknown' });
    expect(errorCardFor(deriveProtocolState({ runStatus: 'FAILED_RECOVERY' }), null)).toEqual({ code: 'unknown' });
    expect(errorCardFor('FAILED', { code: 'logged_out' })).toEqual({ code: 'logged_out' });
    // Not failed: the error passes through unchanged, and no error means no card.
    expect(errorCardFor('INTERRUPTED', { code: 'rate_limited' })).toEqual({ code: 'rate_limited' });
    expect(errorCardFor('INTERRUPTED', null)).toBeNull();
    expect(errorCardFor('COMPLETED', null)).toBeNull();
    expect(errorCardFor(null, undefined)).toBeNull();
    render(<ErrorCard error={errorCardFor('FAILED', null)!} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-code', 'unknown');
  });

  it('chip: Mislukt for a failed run; nothing for a finished one', () => {
    const { rerender, container } = render(<ChatStatusChip state="FAILED" mode="eenvoudig" />);
    expect(screen.getByRole('status', { name: 'Status van dit gesprek' })).toHaveTextContent('Mislukt');
    rerender(<ChatStatusChip state="INTERRUPTED" mode="eenvoudig" />);
    expect(screen.getByRole('status', { name: 'Status van dit gesprek' })).toHaveTextContent('Gepauzeerd');
    rerender(<ChatStatusChip state="COMPLETED" mode="eenvoudig" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ChatStatusChip state="COMPLETED" mode="uitgebreid" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('chip: one word in Eenvoudig; Dutch detail plus the log name in Uitgebreid; nothing for null', () => {
    const { rerender, container } = render(<ChatStatusChip state="WAITING_FOR_PERMISSION" mode="eenvoudig" />);
    expect(screen.getByRole('status', { name: 'Status van dit gesprek' })).toHaveTextContent('Wacht op jou');
    expect(screen.queryByText('WAITING_FOR_PERMISSION')).toBeNull();
    rerender(<ChatStatusChip state="WAITING_FOR_PERMISSION" mode="uitgebreid" />);
    expect(screen.getByText('Wacht op je toestemming')).toBeInTheDocument();
    expect(screen.getByText('WAITING_FOR_PERMISSION')).toHaveAttribute('data-log-name');
    rerender(<ChatStatusChip state={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
