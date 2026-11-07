/**
 * LiveAgentsStrip — the real "live now" view of subagent dispatch (feat-live-visibility, Gap B:
 * "no 'live now' view of the agents actually working"). Rendered above the Agents roster in
 * `AgentsView.tsx`.
 *
 * Fed entirely by `useGatewayAgentDispatches` (`GET /api/agent-dispatches`) — real `Agent`
 * tool_use dispatches this project's own conversations recorded, never the static registry the
 * roster below already shows. See that hook's own header, and `gateway/src/agent-dispatches.mjs`'s
 * header, for exactly which stored fields this reads and the honesty rule behind `running`.
 *
 * TWO DISTINCT, MANDATORY honest empty states (never one generic empty box):
 *   - no agent registry at all for this project (`agentCount === 0`)
 *   - a registry exists, but no subagent dispatch has been recorded yet (`dispatches.length === 0`)
 *
 * Existing primitives/classes only — `Eyebrow`, `Icon`, `Machine`, and the SAME `.fw-agents-chip`
 * class the roster below already uses for permission/verification chips, extended with one new
 * `data-live` attribute selector in `agents.css` (no new color, no new component).
 */

import { Icon } from '@/components/primitives';
import { dispatchGroupKey, dispatchLabel, useGatewayAgentDispatches } from '@/prototype/state/gateway-agent-dispatches';
import type { AgentDispatchRow } from '@/prototype/state/gateway-agent-dispatches';
import { useLocale } from '@/i18n/use-locale';

interface DispatchGroup {
  /** The real display label — a run-log row's own agent name (a Forge Boss), or the pre-existing
   *  chat-tool-use `subagentType` — see `dispatchGroupKey`'s own doc comment (WP-CCD, item 3). */
  readonly label: string;
  readonly count: number;
  readonly runningCount: number;
  /** WP-CCD (item 3): a real-log dispatch the gateway itself reports as stalled (an agent gone
   *  silent past the stale window) — never conflated with "running" or "finished". */
  readonly stalledCount: number;
}

function groupByDispatchIdentity(rows: readonly AgentDispatchRow[]): readonly DispatchGroup[] {
  const byKey = new Map<string, DispatchGroup>();
  for (const row of rows) {
    const key = dispatchGroupKey(row);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        label: dispatchLabel(row),
        count: 1,
        runningCount: row.running ? 1 : 0,
        stalledCount: row.stalled ? 1 : 0,
      });
    } else {
      byKey.set(key, {
        label: existing.label,
        count: existing.count + 1,
        runningCount: existing.runningCount + (row.running ? 1 : 0),
        stalledCount: existing.stalledCount + (row.stalled ? 1 : 0),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function DispatchChip({ group }: { group: DispatchGroup }) {
  const { t, n } = useLocale();
  const isRunning = group.runningCount > 0;
  // WP-CCD (item 3): stalled is a real, distinct state — never shown as "running" (it is
  // explicitly not proven alive) and never silently folded into "dispatched" (a plain finished
  // dispatch), which would hide a genuinely silent agent.
  const isStalled = !isRunning && group.stalledCount > 0;
  const liveState = isRunning ? 'running' : isStalled ? 'stalled' : 'dispatched';
  const vars = {
    label: group.label,
    running: group.runningCount,
    stalled: group.stalledCount,
    count: group.count,
  };
  const title = isRunning
    ? t('rd.agents.live.chipRunning', vars)
    : isStalled
      ? t('rd.agents.live.chipStalled', vars)
      : n(group.count, 'rd.agents.live.chipDoneOne', 'rd.agents.live.chipDoneMany', vars);
  return (
    <span className="fw-agents-chip" data-live={liveState} title={title}>
      <Icon name={isRunning ? 'Loader' : isStalled ? 'CircleAlert' : 'Clock'} size="xs" spin={isRunning} />
      <span className="fw-agents-chip__label">{group.label}</span>
      <span className="fw-agents-chip__count">{group.count}</span>
    </span>
  );
}

export interface LiveAgentsStripProps {
  /** Real registry size for the active project — `AgentsView`'s own `state.data.agents.length`,
   *  never re-derived here. Distinguishes the "no registry at all" empty state from the "registry
   *  exists, nothing dispatched yet" one. */
  readonly agentCount: number;
  /** The active project's own id — passed down rather than read from `usePrototype()` a second
   *  time, so this component stays a pure function of its props for testing. */
  readonly projectId: string;
}

export function LiveAgentsStrip({ agentCount, projectId }: LiveAgentsStripProps) {
  const { t } = useLocale();
  const dispatches = useGatewayAgentDispatches(projectId);

  /* REAL DISPATCHES ALWAYS WIN over either empty state (coordinator finding 2026-07-30, measured in a
   * real browser against a real run): the `agentCount === 0` branch used to come FIRST, so a project
   * without a Forge agent registry showed "No Forge agent registry found for this project." even while
   * `GET /api/agent-dispatches` was returning a genuine `{"subagent_type":"Explore","description":
   * "Count .md files in project directory","resolved_status":"completed"}`. That is the owner's original
   * complaint ("ik zie ook niks als agents die runnen") reproduced by the very strip meant to fix it.
   * The registry line is about the ROSTER below, not about live activity — so it is now a note
   * alongside the real dispatches rather than a gate in front of them. */
  // No registry and nothing dispatched: AgentsView's own empty state says it once, centred.
  if (dispatches.length === 0 && agentCount === 0) return null;

  if (dispatches.length === 0) {
    return (
      <div className="fw-agents__live" role="status">
        <span className="fw-agents__live-head">
          <Icon name="Activity" size="xs" />
          <span className="fw-agents__live-title">{t('rd.agents.live.title')}</span>
        </span>
        <p className="fw-agents__live-empty">{t('rd.agents.live.none')}</p>
      </div>
    );
  }

  const groups = groupByDispatchIdentity(dispatches);
  const anyRunning = groups.some((g) => g.runningCount > 0);
  const anyStalled = groups.some((g) => g.runningCount === 0 && g.stalledCount > 0);

  return (
    <div className="fw-agents__live" role="status">
      <span className="fw-agents__live-head">
        <Icon name="Activity" size="xs" />
        <span className="fw-agents__live-title">{t('rd.agents.live.title')}</span>
      </span>
      <ul className="fw-agents__live-chips">
        {groups.map((group) => (
          <li key={group.label}>
            <DispatchChip group={group} />
          </li>
        ))}
      </ul>
      <p className="fw-agents__live-note">
        {anyRunning ? t('rd.agents.live.noteRunning') : t('rd.agents.live.noteIdle')}
        {anyStalled ? t('rd.agents.live.noteStalled') : ''}
        {agentCount === 0 ? t('rd.agents.live.noteSelfDispatched') : ''}
      </p>
    </div>
  );
}

export default LiveAgentsStrip;
