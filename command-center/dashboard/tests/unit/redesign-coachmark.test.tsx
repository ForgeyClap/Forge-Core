/**
 * CoachMark, one stop of the guided tour (DESIGN.md §3.1).
 * Focus moves to the card, Tab and Shift+Tab stay inside it, Escape means Overslaan, and
 * focus returns to where it was when the tour closes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { CoachMark } from '@/components/primitives';

afterEach(() => cleanup());

function Tour({ onSkip = () => {}, onNext = () => {} }: { onSkip?: () => void; onNext?: () => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Rondleiding starten
      </button>
      <textarea ref={setAnchor} aria-label="Bericht" />
      <a href="#elders">Elders</a>
      <CoachMark
        open={open}
        anchor={anchor}
        stepLabel="Rondleiding 1 van 3"
        step={0}
        total={3}
        title="Typ hier wat je wilt"
        body="Gewone taal is genoeg."
        nextLabel="Volgende"
        skipLabel="Overslaan"
        onNext={onNext}
        onSkip={() => {
          onSkip();
          setOpen(false);
        }}
      />
    </div>
  );
}

describe('CoachMark', () => {
  it('opens as a labelled, described modal dialog and moves focus to the card', async () => {
    const user = userEvent.setup();
    render(<Tour />);
    await user.click(screen.getByRole('button', { name: 'Rondleiding starten' }));
    const dialog = screen.getByRole('dialog', { name: 'Typ hier wat je wilt' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Gewone taal is genoeg.',
    );
    expect(document.activeElement).toBe(dialog);
  });

  it('traps Tab and Shift+Tab inside the card', async () => {
    const user = userEvent.setup();
    render(<Tour />);
    await user.click(screen.getByRole('button', { name: 'Rondleiding starten' }));
    const skip = screen.getByRole('button', { name: 'Overslaan' });
    const next = screen.getByRole('button', { name: 'Volgende' });

    await user.tab();
    expect(document.activeElement).toBe(skip);
    await user.tab();
    expect(document.activeElement).toBe(next);
    await user.tab();
    expect(document.activeElement).toBe(skip);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(next);
    for (let i = 0; i < 6; i += 1) await user.tab();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('Escape means Overslaan, closes the stop and returns focus to the opener', async () => {
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<Tour onSkip={onSkip} />);
    const opener = screen.getByRole('button', { name: 'Rondleiding starten' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Volgende calls onNext and leaves skipping to Overslaan', async () => {
    const onNext = vi.fn();
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<Tour onNext={onNext} onSkip={onSkip} />);
    await user.click(screen.getByRole('button', { name: 'Rondleiding starten' }));
    await user.click(screen.getByRole('button', { name: 'Volgende' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(<Tour />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.fw-coach-layer')).toBeNull();
  });
});
