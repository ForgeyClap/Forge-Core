/**
 * PlanCard — the proposal shown before the team starts a job (WP B3, plan §3.2).
 *
 * Steps with the role that does each one (PRODUCT-CARD.md role names), who helps, and an estimate
 * band: minutes, and the share of the limit when earlier jobs give a basis ("nog onbekend"
 * otherwise). Three buttons: Start · Aanpassen · Niet nu. Nothing starts without the click.
 */

import { useId } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { ROLE_STAMPS, roleFromName } from '@/views/team/team-data';
import type { RoleSlug } from '@/views/team/team-data';

import { estimatePlan } from './plan-estimate';
import type { TeamPlan } from './plan-estimate';
import './plan-card.css';

export interface PlanCardProps {
  readonly plan: TeamPlan;
  readonly onStart: () => void;
  readonly onAdjust: () => void;
  readonly onLater: () => void;
  /** While the start is being sent. */
  readonly starting?: boolean;
}

export function PlanCard({ plan, onStart, onAdjust, onLater, starting = false }: PlanCardProps) {
  const { t } = useLocale();
  const titleId = useId();
  const estimate = estimatePlan(plan);
  const roleName = (role: RoleSlug | null) => (role === null ? t('team.someone') : t(`team.roles.${role}`));
  const roles: (RoleSlug | null)[] = [];
  for (const step of plan.steps) {
    const role = roleFromName(step.role);
    if (!roles.includes(role)) roles.push(role);
  }

  return (
    <article className="fw-plan" aria-labelledby={titleId} data-route={plan.route}>
      <p className="fw-plan__eyebrow">{t('chatCards.plan.eyebrow')}</p>
      <h3 className="fw-plan__title" id={titleId} data-log-text="">
        {plan.title}
      </h3>

      <p className="fw-plan__facts">
        <span>{estimate.steps === 1 ? t('chatCards.plan.stepsOne') : t('chatCards.plan.stepsMany', { count: estimate.steps })}</span>
        <span aria-hidden="true">·</span>
        <span>{estimate.helpers === 1 ? t('chatCards.plan.helpersOne') : t('chatCards.plan.helpersMany', { count: estimate.helpers })}</span>
      </p>

      <ol className="fw-plan__steps" aria-label={t('chatCards.plan.listLabel')}>
        {plan.steps.map((step, index) => {
          const role = roleFromName(step.role);
          return (
            <li key={`${index}-${step.title}`} className="fw-plan__step">
              <span className="fw-plan__num" aria-hidden="true">
                {index + 1}
              </span>
              <span className="fw-plan__step-title" data-log-text="">
                {step.title}
              </span>
              <span className="fw-plan__step-role">{t('chatCards.plan.stepBy', { role: roleName(role) })}</span>
            </li>
          );
        })}
      </ol>

      <div className="fw-plan__grid">
        <section className="fw-plan__block" aria-label={t('chatCards.plan.rolesLabel')}>
          <h4 className="fw-plan__label">{t('chatCards.plan.rolesLabel')}</h4>
          <ul className="fw-plan__roles">
            {roles.map((role) => (
              <li key={role ?? 'someone'} className="fw-plan__role">
                <span className="fw-plan__stamp" aria-hidden="true">
                  {role === null ? '··' : ROLE_STAMPS[role]}
                </span>
                {roleName(role)}
              </li>
            ))}
          </ul>
        </section>
        <section className="fw-plan__block" aria-label={t('chatCards.plan.estimateLabel')}>
          <h4 className="fw-plan__label">{t('chatCards.plan.estimateLabel')}</h4>
          <p className="fw-plan__estimate">
            <Icon name="Timer" size="xs" />
            <span>{t('chatCards.plan.minutes', { low: estimate.minutes[0], high: estimate.minutes[1] })}</span>
          </p>
          <p className="fw-plan__estimate" data-known={estimate.limitPct !== null}>
            <Icon name="Gauge" size="xs" />
            <span>
              {estimate.limitPct
                ? t('chatCards.plan.limit', { low: estimate.limitPct[0], high: estimate.limitPct[1] })
                : t('chatCards.plan.limitUnknown')}
            </span>
          </p>
          {estimate.limitPct === null ? <p className="fw-plan__why">{t('chatCards.plan.limitUnknownWhy')}</p> : null}
        </section>
      </div>

      <p className="fw-plan__note">{t('chatCards.plan.estimateNote')}</p>

      <div className="fw-plan__actions">
        <Button variant="primary" icon="Play" disabled={starting} onClick={onStart}>
          {t('chatCards.plan.start')}
        </Button>
        <Button variant="ghost" icon="Pencil" disabled={starting} onClick={onAdjust}>
          {t('chatCards.plan.adjust')}
        </Button>
        <Button variant="quiet" disabled={starting} onClick={onLater}>
          {t('chatCards.plan.later')}
        </Button>
      </div>
    </article>
  );
}
