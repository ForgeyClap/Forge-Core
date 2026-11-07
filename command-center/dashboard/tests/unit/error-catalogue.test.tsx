/**
 * WP B3 — the chat error catalogue: every recorded fixture under tests/fixtures/chat-errors renders
 * its Dutch card (title, one sentence, ONE button), raw error output never reaches the card text,
 * and what sits under "Technische details" is redacted.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale, translate } from '@/i18n';
import { ErrorCard } from '@/views/chat/errors/ErrorCard';
import { CHAT_ERROR_CODES, ERROR_CATALOGUE, formatClock, normalizeChatError, redactDetails } from '@/views/chat/errors/error-catalogue';

const DIR = path.resolve(process.cwd(), 'tests/fixtures/chat-errors');
const FIXTURES = fs
  .readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, data: JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as Record<string, unknown> }));

describe('chat error catalogue', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  it('has a fixture for every code, and every code has a title, a sentence and a button in both languages', () => {
    const covered = new Set(FIXTURES.map((fixture) => normalizeChatError(fixture.data).code));
    for (const code of CHAT_ERROR_CODES) {
      expect(covered.has(code), `fixture for ${code}`).toBe(true);
      for (const locale of ['nl', 'en'] as const) {
        for (const part of ['title', 'body', 'action'] as const) {
          const key = `chatCards.errors.${code}.${part}` as const;
          expect(translate(locale, key)).not.toBe(key);
        }
      }
      expect(ERROR_CATALOGUE[code].action).toBeTruthy();
    }
  });

  it.each(FIXTURES)('fixture $name renders its Dutch card with one button and no raw output in the text', ({ data }) => {
    const onAction = vi.fn();
    const error = normalizeChatError(data);
    const { container } = render(<ErrorCard error={error} onAction={onAction} />);
    expect(screen.getByRole('heading', { name: String(data.expect_title) })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(String(data.expect_action));

    // The card text (everything outside the folded details) never contains the raw details.
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('details').forEach((node) => node.remove());
    const raw = typeof data.details === 'string' ? data.details : '';
    if (raw !== '') expect(clone.textContent).not.toContain(raw.slice(0, 24));
    expect(clone.textContent).not.toMatch(/ENOENT|ECONNREFUSED|stderr|is_error/);

    // What is folded away is redacted: no key, no e-mail, no user folder name.
    const pre = container.querySelector('pre');
    if (pre) {
      expect(pre.textContent).not.toMatch(/sk-ant|iemand@example\.com|\\Users\\iemand|abcdef1234567890abcdef/);
    }
    fireEvent.click(buttons[0]);
    const expected: unknown[] = error.code === 'rate_limited' ? [ERROR_CATALOGUE[error.code].action, true] : [ERROR_CATALOGUE[error.code].action];
    expect(onAction.mock.calls[0]).toEqual(expected);
  });

  it('rate_limited names the resume time and the button switches to "gaat vanzelf verder"', () => {
    const error = normalizeChatError({ code: 'rate_limited', resume_at: '2026-11-02T14:30:00Z' });
    const time = formatClock('2026-11-02T14:30:00Z', 'nl') as string;
    render(<ErrorCard error={error} />);
    expect(screen.getByText(`Om ${time} kun je weer verder. Forge kan dan vanzelf verdergaan met deze klus.`)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Automatisch verdergaan' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: `Gaat om ${time} vanzelf verder` })).toHaveAttribute('aria-pressed', 'true');
  });

  it('without a resume time, a model name or a retry count the copy still reads well', () => {
    render(<ErrorCard error={normalizeChatError({ code: 'rate_limited' })} />);
    expect(screen.getByText(/^Over een tijdje kun je weer verder/)).toBeInTheDocument();
    cleanup();
    render(<ErrorCard error={normalizeChatError({ code: 'model_not_pulled' })} />);
    expect(screen.getByText(/^Het gekozen model moet eerst gedownload worden/)).toBeInTheDocument();
    cleanup();
    render(<ErrorCard error={normalizeChatError({ code: 'api_retry', attempt: 2, max_attempts: 10 })} />);
    expect(screen.getByText(/poging 2 van 10/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('normalize: unknown codes and junk become `unknown`, bad numbers are dropped', () => {
    expect(normalizeChatError(null).code).toBe('unknown');
    expect(normalizeChatError({ code: 'disk_on_fire' }).code).toBe('unknown');
    expect(normalizeChatError({ code: 'api_retry', attempt: -1, max_attempts: 'x' })).toMatchObject({ attempt: null, max_attempts: null });
  });

  it('redaction removes keys, bearer values, e-mail, the user folder and long secrets, and caps the length', () => {
    const out = redactDetails(
      'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijk Authorization: Bearer abcdef1234567890 at C:\\Users\\iemand\\x and /home/iemand/y mail a.b@c.nl ' +
        'a'.repeat(50),
    );
    expect(out).not.toMatch(/sk-ant|abcdef1234567890|iemand|a\.b@c\.nl|a{50}/);
    expect(redactDetails('x'.repeat(5000)).length).toBeLessThanOrEqual(601);
  });
});
