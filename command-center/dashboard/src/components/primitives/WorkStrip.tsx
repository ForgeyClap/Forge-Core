/**
 * WorkStrip — one quiet bar per piece of work (DESIGN.md §3.2): Plannen, Bouwen,
 * Controleren, Opleveren.
 *
 *   done     green check, the line after it turns green
 *   now      a breathing Pauw dot (solid under reduced motion)
 *   todo     an empty circle
 *   waiting  "Wacht op jou": a Wacht-coloured clock; the question card sits right below
 *   failed   a Gloei mark; one line under the strip says what failed, with one action
 *
 * Accessibility: an ordered list labelled by `label`; every step carries a visually hidden
 * state word (`stateLabels`, from the locale), so a screen reader hears "Bouwen: bezig".
 * Status is never colour alone: the icon shape differs per state too.
 *
 * All words come in through props (the rd.* copy keys), so the primitive holds no copy.
 */

import type { ReactNode } from 'react';
import { Icon } from './Icon';

import type { WorkStepState } from './guided-constants';

export interface WorkStep {
  key: string;
  label: string;
  state: WorkStepState;
}

export interface WorkStripProps {
  steps: readonly WorkStep[];
  /** Accessible name of the strip, e.g. "Voortgang". */
  label: string;
  /** The hidden state word per state, e.g. { done: 'klaar', now: 'bezig', ... }. */
  stateLabels: Readonly<Record<WorkStepState, string>>;
  /** Right side: the duration when done, or "2 helpers bezig". */
  meta?: ReactNode;
  /** One line under the strip, used for a failure ("Bouwen is mislukt.") */
  note?: ReactNode;
  /** One action next to the note ("Opnieuw proberen"). */
  action?: ReactNode;
  className?: string;
}

function StepMark({ state }: { state: WorkStepState }) {
  if (state === 'done') {
    return (
      <span className="fw-work__mark" data-state="done" aria-hidden="true">
        <Icon name="Check" size="xs" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="fw-work__mark" data-state="failed" aria-hidden="true">
        <Icon name="X" size="xs" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'waiting') {
    return (
      <span className="fw-work__mark" data-state="waiting" aria-hidden="true">
        <Icon name="Clock" size="xs" strokeWidth={2.25} />
      </span>
    );
  }
  return <span className="fw-work__mark" data-state={state} aria-hidden="true" />;
}

export function WorkStrip({ steps, label, stateLabels, meta, note, action, className }: WorkStripProps) {
  const classes = ['fw-work'];
  if (className) classes.push(className);
  const failed = steps.some((step) => step.state === 'failed');

  return (
    <div className={classes.join(' ')} data-failed={failed || undefined}>
      <div className="fw-work__bar">
        <ol className="fw-work__steps" aria-label={label}>
          {steps.map((step, index) => (
            <li
              key={step.key}
              className="fw-work__step"
              data-state={step.state}
              aria-current={step.state === 'now' || step.state === 'waiting' ? 'step' : undefined}
            >
              {index > 0 ? (
                <span
                  className="fw-work__line"
                  data-done={steps[index - 1].state === 'done' ? 'true' : undefined}
                  aria-hidden="true"
                />
              ) : null}
              <StepMark state={step.state} />
              <span className="fw-work__label">{step.label}</span>
              {step.state === 'waiting' ? (
                <span className="fw-work__waiting" aria-hidden="true">
                  {stateLabels.waiting}
                </span>
              ) : null}
              <span className="fw-visually-hidden">: {stateLabels[step.state]}</span>
            </li>
          ))}
        </ol>
        {meta != null ? <span className="fw-work__meta">{meta}</span> : null}
      </div>
      {note != null || action != null ? (
        <div className="fw-work__note" role={failed ? 'status' : undefined}>
          {failed ? <Icon name="CircleAlert" size="sm" className="fw-work__note-icon" /> : null}
          {note != null ? <span className="fw-work__note-text">{note}</span> : null}
          {action != null ? <span className="fw-work__note-action">{action}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
