/**
 * OwnModelRow — "Je eigen model" as one row (v1.0 fix round FX-C, DESIGN.md §1 rule 2, §3.4, §5): the name and
 * the current choice ("Ollama · llama3.1"), with the full picker (where it runs, the model, Testen, its status
 * and what it can do) behind "Meer info". When the mode needs an own model that is not chosen yet, or the chosen
 * one has a problem the save would refuse, the panel opens by itself so the fix is on screen. When the service
 * it runs on is not reachable, the row says so in one word (DESIGN.md §1 rule 4), the same word as Je accounts.
 */

import type { ReactNode } from 'react';

import { useLocale } from '@/i18n/use-locale';

import { MoreInfo } from './MoreInfo';
import { useOpensOnProblem } from './use-opens-on-problem';

export interface OwnModelRowProps {
  /** The label of the own model the router uses now, or null when none is chosen. */
  readonly current: string | null;
  /** True while a check on the own model fails: the panel opens by itself. */
  readonly problem: boolean;
  /** The state of the service it runs on, only when that is not fine (null = nothing to say). */
  readonly status?: { readonly tone: 'warn' | 'off' | 'bad'; readonly word: string } | null;
  /** The picker. */
  readonly children: ReactNode;
}

export function OwnModelRow({ current, problem, status = null, children }: OwnModelRowProps) {
  const { t } = useLocale();
  const [open, setOpen] = useOpensOnProblem(problem);
  return (
    <div className="fs-set__row fs-router__own" data-row="router-own">
      <div className="fs-set__text">
        <span className="fs-set__name">{t('appRouter.fallback.heading')}</span>
        <MoreInfo className="fs-set__more" open={open} onToggle={setOpen}>
          {children}
        </MoreInfo>
        <span className="fs-set__note">{current ?? t('appRouter.fallback.choose')}</span>
      </div>
      {status ? (
        <div className="fs-set__ctl">
          <span className="fs-pill" data-tone={status.tone}>
            <span className="fs-pill__dot" aria-hidden="true" />
            {status.word}
          </span>
        </div>
      ) : null}
    </div>
  );
}
