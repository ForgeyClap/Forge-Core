/**
 * ProofCard — the struck plate (DESIGN.md §3.2 Opleverbewijs, and the veiligheidsslot
 * question / permission cards).
 *
 *   tone="ok"       Gehard stamp: "Je website is klaar", up to 3 really-tested check lines
 *   tone="waiting"  Wacht stamp: what Forge wants to do, Toestaan / Niet nu
 *   tone="failed"   Gloei stamp
 *
 * At most 3 check lines are shown (the rest belong in the full proof behind
 * "Hoe is dit gecontroleerd?"); at most 2 actions: `primary` and `secondary`, passed as
 * ready-made Buttons. `children` is for one extra block such as a <Disclosure>.
 *
 * Honesty: this card only displays what the caller proves. It never invents a check line.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

import { PROOF_MAX_CHECKS } from './guided-constants';

export type ProofTone = 'ok' | 'waiting' | 'failed';

const STAMP_ICON: Readonly<Record<ProofTone, string>> = {
  ok: 'BadgeCheck',
  waiting: 'ShieldCheck',
  failed: 'TriangleAlert',
};

export interface ProofCardProps {
  title: ReactNode;
  /** One small line under the title, e.g. "Opleverbewijs". */
  kicker?: ReactNode;
  tone?: ProofTone;
  /** Check lines; only the first three are shown. */
  checks?: readonly ReactNode[];
  /** One line of body text (the permission card's "1 bestand aanpassen: site.css"). */
  summary?: ReactNode;
  /** The main action, e.g. <Button variant="primary">Bekijk de website</Button>. */
  primary?: ReactNode;
  /** The second action, e.g. <Button variant="secondary">Hoe is dit gecontroleerd?</Button>. */
  secondary?: ReactNode;
  /** A badge next to the title, e.g. <ExampleTag/> for an example proof. */
  badge?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function ProofCard({
  title,
  kicker,
  tone = 'ok',
  checks = [],
  summary,
  primary,
  secondary,
  badge,
  className,
  children,
}: ProofCardProps) {
  const titleId = useId();
  const shown = checks.slice(0, PROOF_MAX_CHECKS);
  const classes = ['fw-proof'];
  if (className) classes.push(className);

  return (
    <section className={classes.join(' ')} data-tone={tone} aria-labelledby={titleId}>
      <header className="fw-proof__head">
        <span className="fw-proof__stamp" aria-hidden="true">
          <Icon name={STAMP_ICON[tone]} size="lg" />
        </span>
        <div className="fw-proof__heading">
          <h3 id={titleId} className="fw-proof__title">
            {title}
          </h3>
          {kicker != null ? <p className="fw-proof__kicker">{kicker}</p> : null}
        </div>
        {badge != null ? <span className="fw-proof__badge">{badge}</span> : null}
      </header>
      {summary != null ? <p className="fw-proof__summary">{summary}</p> : null}
      {shown.length > 0 ? (
        <ul className="fw-proof__checks">
          {shown.map((check, index) => (
            <li key={index}>
              <Icon name="Check" size="sm" className="fw-proof__check" />
              <span>{check}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
      {primary != null || secondary != null ? (
        <div className="fw-proof__actions">
          {primary}
          {secondary}
        </div>
      ) : null}
    </section>
  );
}
