/**
 * (Forge Systeem v1.0 redesign): behaviour of the guided primitives.
 *   - WorkStrip: every state renders its own mark and a hidden state word, so status is never
 *     colour alone; the line after a finished step turns "done"; a failure shows one note + action.
 *   - Disclosure ("Meer info"): a real button with aria-expanded/aria-controls, Enter and Space
 *     toggle it, and the region is hidden (not just collapsed) while closed.
 *   - ChoiceList: radiogroup, roving tabindex, arrow keys select, describe="selected" shows only
 *     the chosen option's line.
 *   - ProofCard: never more than three check lines, at most the two actions it is given.
 *   - StatusBadge: a dot plus a word; the running dot is the only live one.
 *   - Mark: decorative unless titled; mono below 20 px.
 * CoachMark has its own file (redesign-coachmark.test.tsx).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import {
  Button,
  ChoiceList,
  Disclosure,
  Mark,
  PROOF_MAX_CHECKS,
  ProofCard,
  StatusBadge,
  WORK_STEP_STATES,
  WorkStrip,
} from '@/components/primitives';
import type { WorkStep, WorkStepState } from '@/components/primitives';

afterEach(() => cleanup());

const STATE_WORDS: Record<WorkStepState, string> = {
  done: 'klaar',
  now: 'bezig',
  todo: 'nog niet begonnen',
  waiting: 'wacht op jou',
  failed: 'mislukt',
};

function steps(states: WorkStepState[]): WorkStep[] {
  const labels = ['Plannen', 'Bouwen', 'Controleren', 'Opleveren'];
  return states.map((state, index) => ({ key: labels[index].toLowerCase(), label: labels[index], state }));
}

describe('WorkStrip', () => {
  it('renders the four steps as an ordered, labelled list with a hidden state word per step', () => {
    render(
      <WorkStrip
        label="Voortgang"
        stateLabels={STATE_WORDS}
        steps={steps(['done', 'done', 'now', 'todo'])}
        meta="2 helpers bezig"
      />,
    );
    const list = screen.getByRole('list', { name: 'Voortgang' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.textContent)).toEqual([
      'Plannen: klaar',
      'Bouwen: klaar',
      'Controleren: bezig',
      'Opleveren: nog niet begonnen',
    ]);
    expect(screen.getByText('2 helpers bezig')).toBeTruthy();
  });

  it('gives every state its own mark, so the state never rests on colour alone', () => {
    const { container } = render(
      <WorkStrip label="Voortgang" stateLabels={STATE_WORDS} steps={steps(['done', 'failed', 'waiting', 'todo'])} />,
    );
    const marks = Array.from(container.querySelectorAll('.fw-work__mark'));
    expect(marks.map((mark) => mark.getAttribute('data-state'))).toEqual(['done', 'failed', 'waiting', 'todo']);
    // done, failed and waiting carry a glyph; todo is the empty circle.
    expect(marks.map((mark) => mark.querySelector('svg') != null)).toEqual([true, true, true, false]);
  });

  it('covers every documented state', () => {
    expect([...WORK_STEP_STATES].sort()).toEqual(['done', 'failed', 'now', 'todo', 'waiting']);
  });

  it('marks the line after a finished step as done, and only that line', () => {
    const { container } = render(
      <WorkStrip label="Voortgang" stateLabels={STATE_WORDS} steps={steps(['done', 'now', 'todo', 'todo'])} />,
    );
    const lines = Array.from(container.querySelectorAll('.fw-work__line'));
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.getAttribute('data-done'))).toEqual(['true', null, null]);
  });

  it('points aria-current at the step that is happening or waiting, with the visible "wacht op jou"', () => {
    render(<WorkStrip label="Voortgang" stateLabels={STATE_WORDS} steps={steps(['done', 'waiting', 'todo', 'todo'])} />);
    const current = screen.getAllByRole('listitem').filter((item) => item.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Bouwen');
    expect(current[0].querySelector('.fw-work__waiting')?.textContent).toBe('wacht op jou');
  });

  it('a failure shows one note with one action as a status line', async () => {
    const retry = vi.fn();
    render(
      <WorkStrip
        label="Voortgang"
        stateLabels={STATE_WORDS}
        steps={steps(['done', 'failed', 'todo', 'todo'])}
        note="Bouwen is mislukt: de map is niet gevonden."
        action={<Button onClick={retry}>Opnieuw proberen</Button>}
      />,
    );
    const note = screen.getByRole('status');
    expect(note.textContent).toContain('Bouwen is mislukt');
    await userEvent.click(within(note).getByRole('button', { name: 'Opnieuw proberen' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('Disclosure ("Meer info")', () => {
  it('starts closed: aria-expanded=false and the region is hidden', () => {
    render(
      <Disclosure label="Meer info">
        <p>Forge bewaart je inlog niet.</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Meer info' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    expect(region).not.toBeNull();
    expect(region?.hidden).toBe(true);
  });

  it('opens and closes with the keyboard (Enter, then Space) and reports each change', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <Disclosure label="Meer info" openLabel="Minder info" onToggle={onToggle}>
        <p>Details</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Meer info' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.textContent).toBe('Minder info');
    expect(screen.getByText('Details')).toBeVisible();

    await user.keyboard(' ');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(onToggle.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('remembers nothing: a fresh mount is closed again', async () => {
    const user = userEvent.setup();
    const first = render(<Disclosure label="Meer info">x</Disclosure>);
    await user.click(screen.getByRole('button', { name: 'Meer info' }));
    first.unmount();
    render(<Disclosure label="Meer info">x</Disclosure>);
    expect(screen.getByRole('button', { name: 'Meer info' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ChoiceList', () => {
  const OPTIONS = [
    { value: 'claude', title: 'Claude', description: 'Je abonnement of sleutel', letter: 'C' },
    { value: 'chatgpt', title: 'ChatGPT', description: 'Via Codex, met je ChatGPT-account', letter: 'G' },
    { value: 'ollama', title: 'Gratis op deze pc', description: 'Met Ollama', icon: 'Cpu' },
    { value: 'own', title: 'Eigen sleutel of server', description: 'Een API-sleutel of je eigen adres', icon: 'KeyRound' },
  ];

  function Harness({ describe: mode }: { describe?: 'all' | 'selected' }) {
    const [value, setValue] = useState<string | null>(null);
    return <ChoiceList label="Waarmee wil je werken?" options={OPTIONS} value={value} onChange={setValue} describe={mode} />;
  }

  it('is a labelled radiogroup with one tab stop before anything is chosen', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Waarmee wil je werken?' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('arrow keys move the choice and the focus; End and Home jump to the ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    await user.click(radios[0]);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios[1]);
    await user.keyboard('{End}');
    expect(radios[3].getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowUp}{Home}');
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("describe='selected' shows only the chosen option's line", async () => {
    const user = userEvent.setup();
    render(<Harness describe="selected" />);
    expect(screen.queryByText('Met Ollama')).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Gratis op deze pc/ }));
    expect(screen.getByText('Met Ollama')).toBeTruthy();
    expect(screen.queryByText('Je abonnement of sleutel')).toBeNull();
  });

  it('third-party names get a neutral letter tile, not a logo', () => {
    const { container } = render(<Harness />);
    const tiles = Array.from(container.querySelectorAll('.fw-choice__tile'));
    expect(tiles[0].textContent).toBe('C');
    expect(tiles[1].textContent).toBe('G');
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('ProofCard', () => {
  it('shows at most three check lines and the two actions it is given', () => {
    render(
      <ProofCard
        title="Je website is klaar"
        kicker="Opleverbewijs"
        checks={['Werkt op telefoon en computer', 'Belknop getest', 'Geen fouten gevonden', 'Vierde regel']}
        primary={<Button variant="primary">Bekijk de website</Button>}
        secondary={<Button variant="secondary">Hoe is dit gecontroleerd?</Button>}
      />,
    );
    expect(PROOF_MAX_CHECKS).toBe(3);
    const card = screen.getByRole('region', { name: 'Je website is klaar' });
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
    expect(within(card).queryByText('Vierde regel')).toBeNull();
    expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Bekijk de website',
      'Hoe is dit gecontroleerd?',
    ]);
  });

  it('renders no check list at all when nothing was checked (it never invents a line)', () => {
    render(<ProofCard tone="waiting" title="Forge wil iets aanpassen" summary="1 bestand aanpassen: site.css" />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('region', { name: 'Forge wil iets aanpassen' }).getAttribute('data-tone')).toBe('waiting');
  });
});

describe('Button loading', () => {
  it('keeps its label, shows a spinner and reports aria-busy', () => {
    const { container } = render(
      <Button variant="primary" icon="Play" loading>
        Opslaan
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Opslaan' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.fw-icon--spin')).not.toBeNull();
  });
});

describe('StatusBadge (dot + word)', () => {
  it('shows a dot and the word; only running breathes', () => {
    const { container, rerender } = render(<StatusBadge status="running" />);
    expect(container.querySelector('.fw-status-badge__dot.is-live')).not.toBeNull();
    expect(screen.getByText('RUNNING').classList.contains('fw-sentence')).toBe(true);
    rerender(<StatusBadge status="completed" />);
    expect(container.querySelector('.fw-status-badge__dot')).not.toBeNull();
    expect(container.querySelector('.is-live')).toBeNull();
    expect(screen.getByText('Completed — finished and accepted.')).toBeTruthy();
  });
});

describe('Mark', () => {
  it('is decorative by default and named when titled', () => {
    const { container, rerender } = render(<Mark />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<Mark title="Forge Systeem" />);
    expect(screen.getByRole('img', { name: 'Forge Systeem' })).toBeTruthy();
  });

  it('switches to the one-colour mark below 20 px', () => {
    const { container, rerender } = render(<Mark size={16} />);
    expect(container.querySelector('svg')?.getAttribute('data-variant')).toBe('mono');
    rerender(<Mark size={24} />);
    expect(container.querySelector('svg')?.getAttribute('data-variant')).toBe('color');
    expect(container.querySelector('.fw-mark-ember')).not.toBeNull();
  });
});
