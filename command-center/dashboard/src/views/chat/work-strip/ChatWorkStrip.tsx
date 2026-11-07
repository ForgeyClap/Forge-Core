/**
 * ChatWorkStrip — the work strip above the composer (DESIGN.md §3.2): Plannen, Bouwen, Controleren,
 * Opleveren, built ONLY from the live klus's real helper dispatches (`GET /api/agent-dispatches`, the
 * same source as the Team strip). Nothing renders while the project has no live klus.
 *
 * How a step's state is read (never guessed from time):
 *   - every helper role belongs to one step (`PHASE_ROLES`); a role the klus never dispatched does not
 *     count for its step;
 *   - a step with a running helper is "now"; with only finished helpers it is "done";
 *   - a step whose helpers are dispatched but not running yet, or that has no helpers at all, is "todo"
 *     (an empty circle). It never shows "Wacht op jou": that word is reserved for a real question or
 *     permission card, which the chat shows on its own.
 * The right side says "N helpers bezig" from the real number of running helpers.
 */

import { WorkStrip } from '@/components/primitives';
import type { WorkStep } from '@/components/primitives/WorkStrip';
import type { WorkStepState } from '@/components/primitives/guided-constants';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayActiveRuns } from '@/prototype/state/adapter/polling-hooks';
import { roleStatuses, useTeamDispatches } from '@/views/team/team-data';
import type { RoleSlug, RoleStatus } from '@/views/team/team-data';

import './work-strip.css';

type PhaseId = 'plan' | 'build' | 'check' | 'deliver';

/** Which helper role belongs to which step of the strip. */
export const PHASE_ROLES: Readonly<Record<PhaseId, readonly RoleSlug[]>> = {
  plan: ['lead', 'head-chef', 'search-boss', 'skill-boss'],
  build: ['build-boss', 'ui-boss', 'integration-boss', 'seo-boss'],
  check: ['test-boss', 'verify-boss', 'review-boss', 'security-boss'],
  deliver: ['docs-boss', 'scribe'],
};

const PHASES: readonly { readonly id: PhaseId; readonly labelKey: MessageKey }[] = [
  { id: 'plan', labelKey: 'rd.chat.strip.plan' },
  { id: 'build', labelKey: 'rd.chat.strip.build' },
  { id: 'check', labelKey: 'rd.chat.strip.check' },
  { id: 'deliver', labelKey: 'rd.chat.strip.deliver' },
];

/** The state of one step from the real statuses of its roles. */
export function phaseState(statuses: ReadonlyMap<RoleSlug, RoleStatus>, roles: readonly RoleSlug[]): WorkStepState {
  const own = roles.map((role) => statuses.get(role) ?? 'idle').filter((status) => status !== 'idle');
  if (own.includes('busy')) return 'now';
  if (own.length > 0 && own.every((status) => status === 'done')) return 'done';
  return 'todo';
}

/** How many helpers really run right now. */
export function busyCount(statuses: ReadonlyMap<RoleSlug, RoleStatus>): number {
  let n = 0;
  statuses.forEach((status) => {
    if (status === 'busy') n += 1;
  });
  return n;
}

export interface ChatWorkStripViewProps {
  readonly statuses: ReadonlyMap<RoleSlug, RoleStatus>;
}

export function ChatWorkStripView({ statuses }: ChatWorkStripViewProps) {
  const { t } = useLocale();
  const steps: readonly WorkStep[] = PHASES.map((phase) => ({
    key: phase.id,
    label: t(phase.labelKey),
    state: phaseState(statuses, PHASE_ROLES[phase.id]),
  }));
  const busy = busyCount(statuses);
  return (
    <WorkStrip
      className="fw-chat-work"
      steps={steps}
      // Locale patch keys (rd.chat.strip.label / .todo), added by the merge.
      label={t('rd.chat.strip.label')}
      stateLabels={{
        done: t('rd.chat.strip.done'),
        now: t('rd.chat.strip.now'),
        todo: t('rd.chat.strip.todo'),
        waiting: t('rd.chat.strip.waiting'),
        failed: t('rd.chat.strip.failed'),
      }}
      meta={busy > 0 ? t('rd.chat.strip.helpers', { n: busy }) : undefined}
    />
  );
}

/** Container: the live klus of `projectName`, or nothing. */
export function ChatWorkStrip({ projectName }: { readonly projectName: string }) {
  const active = useGatewayActiveRuns();
  const row = projectName === '' ? undefined : active.rows.find((r) => r.project === projectName && r.runId !== '');
  const runId = row ? row.runId : null;
  const dispatches = useTeamDispatches(runId === null ? '' : projectName);
  if (runId === null) return null;
  return <ChatWorkStripView statuses={roleStatuses(dispatches, runId)} />;
}

export default ChatWorkStrip;
