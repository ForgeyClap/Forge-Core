/**
 * Mission Control — the left-to-right multi-agent workflow graph.
 *
 * Reads the active mission graph out of `state.data.graph` and draws it: one
 * spine (request → boss → head chef → verification → review → fix loop →
 * output) with parallel lanes banded between them, and the repair-and-retest
 * loop routed underneath so the return path is impossible to miss.
 *
 * With no run selected `state.data.graph` is genuinely empty (production) or the
 * fixture's own example graph (fixtures) — either way this view shows an honest
 * "no mission running" state rather than a zeroed-out header over an empty
 * canvas.
 */

import { useCallback, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Button,
  EmptyState,
  IconButton,
  KeyHint,
  Machine,
  StatusBadge,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useGatewayApprovals } from '@/prototype/state/gateway-recovery';
import { chatRunStatusToStatusKey, useGatewayChatRuns } from '@/prototype/state/gateway-adapter';
import { ApprovalsMeta } from './ApprovalsMeta';
import { GraphCanvas } from './GraphCanvas';
import { formatStartedAt } from './mission-format';
import { useGraphLayout, useGraphViewport } from './useGraphViewport';
import './mission.css';

export default function MissionControlView() {
  const { t, locale } = useLocale();
  const { state, dispatch } = usePrototype();
  const graph = state.data.graph;

  const layout = useGraphLayout(graph);
  const view = useGraphViewport(layout.width, layout.height);

  const run = useMemo(
    () => state.data.runs.find((candidate) => candidate.id === graph.runId),
    [state.data.runs, graph.runId],
  );

  // Real gate evaluations for this run — see the module header above. Called
  // unconditionally (Rules of Hooks) even on the "no mission running" branch;
  // `graph.runId` is '' there, which the hook treats the same as no run.
  const approvals = useGatewayApprovals(state.activeProjectId, graph.runId !== '' ? graph.runId : null);

  // feat-chatruns-tabs: real dashboard-CHAT activity for the active project — mounted directly
  // (Rules of Hooks: unconditionally, like `approvals` above), independent of `state.data.graph`
  // (a chat execution never joins a Forge mission graph). `latestChatRun` is real newest-first data
  // straight from the gateway (`useGatewayChatRuns` sorts newest-first) — only ever used below to
  // replace the plain "No mission running" copy with an honest "here's the real activity that DID
  // happen" state, never to fabricate a mission graph node.
  const chatRuns = useGatewayChatRuns(state.activeProjectId);
  const latestChatRun = chatRuns[0] ?? null;

  /**
   * Progress, keyed by the agent name the graph nodes carry — a real completed/total ratio in
   * production (`buildAgentProgressMap`, `gateway-adapter.ts`), the fixture's own example value
   * otherwise. cc-finish fix-cert-fabrication: this comment used to say "Example progress"
   * unconditionally, which was only ever true on the fixture path — the value is real whenever a
   * real run is executing.
   */
  const progressByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const agent of state.data.agents) {
      if (agent.status === 'running') map.set(agent.name, agent.progress);
    }
    return map;
  }, [state.data.agents]);

  const selectedId = state.selection.kind === 'graph-node' ? state.selection.id : null;

  const onSelect = useCallback(
    (id: string) => dispatch({ type: 'select', selection: { kind: 'graph-node', id } }),
    [dispatch],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || !selectedId) return;
      event.preventDefault();
      dispatch({ type: 'select', selection: { kind: 'none' } });
    },
    [dispatch, selectedId],
  );

  // Singular for one ("1 lijn"), plural otherwise; a part with none of them is left out.
  const countParts = [
    t(graph.nodes.length === 1 ? 'rd.mission.stepsOne' : 'rd.mission.stepsMany', { n: graph.nodes.length }),
    graph.lanes.length > 0 ? t(graph.lanes.length === 1 ? 'rd.mission.lanesOne' : 'rd.mission.lanesMany', { n: graph.lanes.length }) : null,
    graph.edges.length > 0 ? t(graph.edges.length === 1 ? 'rd.mission.edgesOne' : 'rd.mission.edgesMany', { n: graph.edges.length }) : null,
  ];
  const counts = countParts.filter((part): part is string => part !== null).join(' · ');

  // WP-CCD (Lead correction): the StatusBadge alone already renders 'stalled' as a
  // visible warning (blocked) and 'ended_unknown' quietly (idle) — see `toRunStatusKey`'s own doc
  // comment in `rows.ts` — but neither badge text says WHY on its own. `Run.rawStatus` carries the
  // real literal string verbatim; this is the one small, readable explanation, reusing the exact
  // `.fw-mission__meta-item`/`Machine` pattern this header already repeats four times, never a new
  // visual language.
  const runNote =
    run?.rawStatus === 'stalled'
      ? t('rd.mission.stalled')
      : run?.rawStatus === 'ended_unknown'
        ? t('rd.mission.endedUnknown')
        : null;

  // No active Forge mission: the graph is genuinely empty (production) or unresolved (a stale
  // runId). feat-chatruns-tabs: when the owner's most recent real activity on this project came
  // from a dashboard CHAT session instead (no `/forge` mission at all), that is shown honestly here
  // — real title/status/timing, clearly labelled as chat activity, never presented as a multi-agent
  // mission. With no chat activity either, the plain "no mission" empty state is unchanged.
  if (!run || graph.nodes.length === 0) {
    if (latestChatRun !== null) {
      const chatStatus = chatRunStatusToStatusKey(latestChatRun.status);
      const chatStarted = formatStartedAt(locale, latestChatRun.startedAt);
      return (
        <div className="fw-mission">
          <header className="fw-mission__header fw-mission__header--page">
            <div className="fw-mission__ident">
              <h1 className="fw-mission__title">{latestChatRun.title ?? t('rd.mission.chatTitle')}</h1>
              <p className="fw-mission__subtitle">{t('rd.mission.subtitle')}</p>
              <div className="fw-mission__meta">
                <StatusBadge status={chatStatus} size="sm" />
                <span className="fw-mission__meta-item">
                  <span className="fw-mission__meta-key">{t('rd.mission.chatRun')}</span>
                  <Machine>{latestChatRun.runId}</Machine>
                </span>
                {chatStarted !== null ? (
                  <span className="fw-mission__meta-item fw-mission__meta-item--wide">
                    <span className="fw-mission__meta-key">{t('rd.mission.started')}</span>
                    <time className="fw-mission__value" dateTime={latestChatRun.startedAt ?? undefined}>
                      {chatStarted}
                    </time>
                  </span>
                ) : null}
              </div>
            </div>
          </header>
          <EmptyState
            icon="MessagesSquare"
            title={t('rd.mission.chatEmpty')}
            detail={t('rd.mission.chatDetail')}
          />
        </div>
      );
    }
    return (
      <div className="fw-mission">
        <header className="fw-mission__header fw-mission__header--page">
          <div className="fw-mission__ident">
            <h1 className="fw-mission__title">{t('rd.mission.noneTitle')}</h1>
            <p className="fw-mission__subtitle">{t('rd.mission.subtitle')}</p>
          </div>
        </header>
        <EmptyState
          icon="Workflow"
          title={t('rd.mission.noneEmpty')}
          detail={t('rd.mission.noneDetail')}
        />
      </div>
    );
  }

  const started = formatStartedAt(locale, run.startedAt);

  return (
    <div className="fw-mission" onKeyDown={onKeyDown}>
      <header className="fw-mission__header">
        <div className="fw-mission__ident">
          <h1 className="fw-mission__title fw-mission__title--clamped" title={run.goal}>{run.goal}</h1>
          <div className="fw-mission__meta">
            <StatusBadge status={run.status} size="sm" />
            {runNote !== null ? (
              <span className="fw-mission__meta-item fw-mission__meta-item--wide">
                <span className="fw-mission__note">{runNote}</span>
              </span>
            ) : null}
            <span className="fw-mission__meta-item">
              <span className="fw-mission__meta-key">{t('rd.mission.run')}</span>
              <Machine>{graph.runId}</Machine>
            </span>
            {run.duration && run.duration !== '—' ? (
              <span className="fw-mission__meta-item">
                <span className="fw-mission__meta-key">{t('rd.mission.elapsed')}</span>
                <span className="fw-mission__value">{run.duration}</span>
              </span>
            ) : null}
            {started !== null ? (
              <span className="fw-mission__meta-item fw-mission__meta-item--wide">
                <span className="fw-mission__meta-key">{t('rd.mission.started')}</span>
                <time className="fw-mission__value" dateTime={run.startedAt}>
                  {started}
                </time>
              </span>
            ) : null}
            <span className="fw-mission__meta-item fw-mission__meta-item--wide">
              <span className="fw-mission__meta-key">{t('rd.mission.graph')}</span>
              <span className="fw-mission__value">{counts}</span>
            </span>
          </div>

          <ApprovalsMeta approvals={approvals} />
        </div>

        <Toolbar label={t('rd.mission.controls')} className="fw-mission__controls">
          <ToolbarGroup>
            <IconButton
              icon="Minus"
              label={t('rd.mission.zoomOut')}
              size="sm"
              disabled={view.atMinZoom}
              onClick={view.zoomOut}
            />
            <span className="fw-mission__zoom" aria-live="polite">
              {view.zoomPercent}%
            </span>
            <IconButton icon="Plus" label={t('rd.mission.zoomIn')} size="sm" disabled={view.atMaxZoom} onClick={view.zoomIn} />
          </ToolbarGroup>

          <ToolbarGroup divided>
            <Button size="sm" icon="Maximize" onClick={view.fit}>
              {t('rd.mission.fit')}
            </Button>
          </ToolbarGroup>

          <ToolbarGroup divided className="fw-mission__controls-hint">
            <KeyHint keys={['0']} />
            <span className="fw-mission__hint-text">{t('rd.mission.hintFit')}</span>
            <KeyHint keys={['+', '−']} />
            <span className="fw-mission__hint-text">{t('rd.mission.hintZoom')}</span>
            <KeyHint keys={['↑', '↓', '←', '→']} />
            <span className="fw-mission__hint-text">{t('rd.mission.hintPan')}</span>
          </ToolbarGroup>
        </Toolbar>
      </header>

      <GraphCanvas
        graph={graph}
        layout={layout}
        view={view}
        selectedId={selectedId}
        progressByAgent={progressByAgent}
        onSelect={onSelect}
      />
    </div>
  );
}
