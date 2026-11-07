/**
 * Activity — the run timeline.
 *
 * Reads `state.data.events`, newest first, grouped by run with a sticky run
 * header and tied together by a spine down the left. Each row carries the four
 * things that make a log readable: when, who, what state, and one sentence of
 * what happened. The paragraph behind it opens on demand.
 *
 * Calm on purpose: nothing animates per row, the running badge does not spin
 * here, and filtering is a plain array pass memoised on its inputs. A log is
 * history — it should sit still while it is read.
 *
 * In production this feed is real and SSE-tailed (`/api/events/stream`); in
 * fixtures it is local example data and never updates.
 *
 * XR-COPY1: every visible word comes from `xr-copy.ts` (Dutch first; English keeps the old wording),
 * dates use the app locale (`LocalTime`), and the empty state only talks about filters when one is set.
 */

import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  ExampleTag,
  Field,
  Icon,
  IconButton,
  Machine,
  StatusBadge,
  Switch,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayEvents, useGatewayEventsMeta, useGatewayRunScanErrors, useGatewayRunsTruncated } from '@/prototype/state/gateway-adapter';
import { toGatewayActivityEvent } from '@/prototype/state/adapter/mappers';
import { isProductionMode } from '@/config/mode';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import type { ActivityEvent, EventKind, StatusKey } from '@/prototype/types/prototype-types';
import { RecoveryPanel } from './RecoveryPanel';
import { LocalTime } from './LocalTime';
import { runProofSummary } from '@/views/tests/run-proof-summary';
import './activity.css';
import type { MessageKey, Translate } from '@/i18n';
import { proofWords } from '@/views/tests/proof-words';

/** WP-CCD (item 5): `null` means "the default run" (today's pre-existing behaviour — the current/
 *  newest run this project has) — a real, picked run id switches the whole timeline to it. */
const CURRENT_RUN_OPTION = '';

/* ------------------------------------------------------------- event kinds */

interface KindPresentation {
  readonly icon: string;
  readonly label: MessageKey;
}

/** The glyph that opens each row. Icon plus an accessible name, never a colour. */
const KIND: Readonly<Record<EventKind, KindPresentation>> = {
  mission: { icon: 'Flag', label: 'rd.activity.kinds.mission' },
  'work-package': { icon: 'Package', label: 'rd.activity.kinds.workPackage' },
  agent: { icon: 'Bot', label: 'rd.activity.kinds.agent' },
  task: { icon: 'ListChecks', label: 'rd.activity.kinds.task' },
  artifact: { icon: 'FileText', label: 'rd.activity.kinds.artifact' },
  test: { icon: 'FlaskConical', label: 'rd.activity.kinds.test' },
  verify: { icon: 'ShieldCheck', label: 'rd.activity.kinds.verify' },
  review: { icon: 'Gavel', label: 'rd.activity.kinds.review' },
  system: { icon: 'Cpu', label: 'rd.activity.kinds.system' },
};

/** The status words of the filter and its chip, in the app locale (the badge is a shared primitive). */
const STATUS_WORD: Readonly<Record<StatusKey, MessageKey>> = {
  running: 'rd.activity.statuses.running',
  completed: 'rd.activity.statuses.completed',
  waiting: 'rd.activity.statuses.waiting',
  verify: 'rd.activity.statuses.verify',
  review: 'rd.activity.statuses.review',
  failed: 'rd.activity.statuses.failed',
  blocked: 'rd.activity.statuses.blocked',
  idle: 'rd.activity.statuses.idle',
};

const EVENT_KINDS: readonly EventKind[] = [
  'mission',
  'work-package',
  'agent',
  'task',
  'artifact',
  'test',
  'verify',
  'review',
  'system',
];

/** Events with no agent are the runtime talking. Selects need a stable value. */
const NO_AGENT = '__system__';

function agentKey(agent: string | null): string {
  return agent ?? NO_AGENT;
}

function agentLabel(agent: string | null, t: Translate): string {
  return agent ?? t('rd.activity.system');
}

function toggleId(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** One line of the "filtering on" summary above the timeline. */
interface ActiveFilter {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly clear: () => void;
}

/* ------------------------------------------------------------------ a row */

interface EventRowProps {
  event: ActivityEvent;
  t: Translate;
  /** Shown when the list is flat, hidden when the run header already says it. */
  showRun: boolean;
  expanded: boolean;
  selected: boolean;
  onActivate: (id: string) => void;
}

function EventRow({ event, t, showRun, expanded, selected, onActivate }: EventRowProps) {
  const kind = KIND[event.kind];
  const kindLabel = t(kind.label);
  const detailId = `fw-event-detail--${event.id}`;
  const headId = `fw-event-head--${event.id}`;

  return (
    <li
      className="fw-event fw-status"
      data-status={event.status}
      data-selected={selected ? 'true' : undefined}
    >
      <span className="fw-event__node" title={kindLabel}>
        <Icon name={kind.icon} size="sm" />
        <span className="fw-visually-hidden">{kindLabel}</span>
      </span>

      <button
        type="button"
        id={headId}
        className="fw-event__head"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => onActivate(event.id)}
      >
        <span className="fw-event__stamp">
          <LocalTime value={event.timestamp} className="fw-event__time" />
          {showRun ? (
            <Machine muted className="fw-event__run">
              {event.runId}
            </Machine>
          ) : null}
        </span>
        <span className="fw-event__agent fw-truncate">{agentLabel(event.agent, t)}</span>
        <span className="fw-event__status">
          {/* WP-8d: a work package that was created but has not started is planned, not idle. */}
          {event.kind === 'work-package' && event.status === 'idle' ? (
            <StatusBadge
              status="idle"
              size="sm"
              label={t('rd.activity.planned')}
              description={t('rd.activity.plannedDetail')}
            />
          ) : (
            <StatusBadge status={event.status} size="sm" />
          )}
        </span>
        <span className="fw-event__message">{event.message}</span>
        <Icon name="ChevronDown" size="sm" className="fw-event__chev" />
      </button>

      <div
        className="fw-event__detail"
        id={detailId}
        role="region"
        aria-labelledby={headId}
        hidden={!expanded}
      >
        <p className="fw-event__detail-text">{event.detail}</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ view */

export default function ActivityView() {
  const { state, dispatch } = usePrototype();
  const { t, n, locale } = useLocale();
  const runs = state.data.runs;

  // cc-fix-events-honesty (P1-1): the same "newest run" convention
  // `useGatewayDataset` itself uses — `state.data.events` is only ever
  // populated for this one run, so its truncated/malformed-line honesty
  // belongs to this run specifically, not to Activity as a whole.
  const currentRunId = runs[0]?.id ?? null;

  // WP-CCD (item 5): "a way to pick another run" — `''` (CURRENT_RUN_OPTION) stays the honest
  // pre-existing default (the current/newest run, `state.data.events`); picking a real run id
  // switches the WHOLE timeline (and the truncated/malformed-line honesty line below) to it via a
  // second, independent `/api/events` poll — the same "second independent poll for a concept
  // outside `PrototypeDataset`" tradeoff `useGatewayEventsMeta` itself already documents.
  // the pick belongs to the project it was made in. After a project switch
  // the timeline shows that project's current run again, instead of asking the new project for a run
  // id it does not have (an empty timeline).
  const [pick, setPick] = useState<{ readonly projectId: typeof state.activeProjectId; readonly runId: string }>({
    projectId: state.activeProjectId,
    runId: CURRENT_RUN_OPTION,
  });
  const pickedRunId = pick.projectId === state.activeProjectId ? pick.runId : CURRENT_RUN_OPTION;
  const setPickedRunId = (runId: string) => setPick({ projectId: state.activeProjectId, runId });
  const effectiveRunId = pickedRunId === CURRENT_RUN_OPTION ? currentRunId : pickedRunId;
  const pickedEvents = useGatewayEvents(state.activeProjectId, pickedRunId === CURRENT_RUN_OPTION ? null : pickedRunId);
  const events = useMemo(
    () =>
      pickedRunId === CURRENT_RUN_OPTION
        ? state.data.events
        : pickedEvents.events.map((row, i) => toGatewayActivityEvent(row, pickedRunId, i)),
    [pickedRunId, state.data.events, pickedEvents.events],
  );

  const eventsMeta = useGatewayEventsMeta(state.activeProjectId, effectiveRunId);
  // cc-fix-dash-latency (#3): `runs.mjs`'s honest `event_scan_error` signal, keyed by run — unlike
  // `eventsMeta` above (scoped to the one run `/api/events` is polled for), this covers every run
  // this project has, so a group header can show it regardless of which run is "current".
  const eventScanErrors = useGatewayRunScanErrors(state.activeProjectId);
  // WP-RB-CC (review finding L-1): `runs_truncated` — true once this project has more run
  // directories than the gateway's own per-request scan bound, meaning the "Run" picker below does
  // not list every run this project has. See useGatewayRunsTruncated's own doc comment.
  const runsTruncated = useGatewayRunsTruncated(state.activeProjectId);

  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [groupByRun, setGroupByRun] = useState(true);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  const selectedId = state.selection.kind === 'event' ? state.selection.id : null;

  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const event of events) seen.set(agentKey(event.agent), agentLabel(event.agent, t));
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [events, t]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      if (agentFilter !== 'all' && agentKey(event.agent) !== agentFilter) return false;
      if (statusFilter !== 'all' && event.status !== statusFilter) return false;
      if (kindFilter !== 'all' && event.kind !== kindFilter) return false;
      if (needle === '') return true;
      return (
        event.message.toLowerCase().includes(needle) || event.detail.toLowerCase().includes(needle)
      );
    });
  }, [events, agentFilter, statusFilter, kindFilter, query]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byRun = new Map<string, ActivityEvent[]>();
    for (const event of filtered) {
      const bucket = byRun.get(event.runId);
      if (bucket) {
        bucket.push(event);
      } else {
        byRun.set(event.runId, [event]);
        order.push(event.runId);
      }
    }
    return order.map((runId) => {
      const run = runs.find((candidate) => candidate.id === runId);
      return {
        runId,
        // recertify follow-up (Lead): this fallback fires for an ORPHAN event — one whose runId is
        // not in `runs`. It used to read "This run is not part of the example dataset.", which is
        // both a forbidden word and, in production, simply untrue: the event is real, the run
        // record just isn't loaded. Practically unreachable today (every event carries the current
        // runId and every runRow is mapped), but it sits in production-rendering code where the
        // empty-state render test structurally cannot see it — so it says something true instead of
        // waiting to become a visible lie.
        goal: run?.goal ?? t('rd.activity.noRunRecord'),
        status: run?.status ?? 'waiting',
        startedAt: run?.startedAt ?? '—',
        duration: run?.duration ?? '—',
        events: byRun.get(runId) ?? [],
      };
    });
  }, [filtered, runs, t]);

  function activateEvent(id: string) {
    setOpenIds((current) => toggleId(current, id));
    dispatch({ type: 'select', selection: { kind: 'event', id } });
  }

  function clearAll() {
    setAgentFilter('all');
    setStatusFilter('all');
    setKindFilter('all');
    setQuery('');
  }

  const activeFilters: ActiveFilter[] = [];
  if (agentFilter !== 'all') {
    activeFilters.push({
      id: 'agent',
      label: t('rd.activity.agent'),
      value: agentOptions.find((option) => option.value === agentFilter)?.label ?? agentFilter,
      clear: () => setAgentFilter('all'),
    });
  }
  if (statusFilter !== 'all') {
    activeFilters.push({
      id: 'status',
      label: t('rd.activity.statusLabel'),
      value: t(STATUS_WORD[statusFilter as StatusKey]),
      clear: () => setStatusFilter('all'),
    });
  }
  if (kindFilter !== 'all') {
    activeFilters.push({
      id: 'kind',
      label: t('rd.activity.kindLabel'),
      value: t(KIND[kindFilter as EventKind].label),
      clear: () => setKindFilter('all'),
    });
  }
  if (query.trim() !== '') {
    activeFilters.push({
      id: 'query',
      label: t('rd.activity.search'),
      value: query.trim(),
      clear: () => setQuery(''),
    });
  }

  const filterSet = activeFilters.length > 0;
  const countWord = (count: number) => (count === 1 ? t('rd.activity.countWordOne') : t('rd.activity.countWordMany'));

  return (
    <div className="fw-activity">
      <header className="fw-activity__header">
        <div className="fw-activity__title">
          <h1 className="fw-activity__h1">{t('nav.activity.label')}</h1>
          <p className="fw-activity__lede">{t('nav.activity.description')}</p>
        </div>

        <Toolbar label={t('rd.activity.toolbar')} className="fw-activity__toolbar">
          <ToolbarGroup>
            <span className="fw-activity__count">
              <span className="fw-activity-num">
                {filtered.length}/{events.length}
              </span>{' '}
              {countWord(events.length)}
            </span>
          </ToolbarGroup>
          <ToolbarGroup divided>
            <Switch
              checked={groupByRun}
              onChange={setGroupByRun}
              label={t('rd.activity.groupByRun')}
              size="sm"
            />
          </ToolbarGroup>
        </Toolbar>
      </header>

      <div className="fw-activity__filters">
        {/* WP-CCD (item 5): a real way to pick another run — every run this project has, newest
            first (the same order `state.data.runs` already sorts in), never just the current one.
            WP-RB-CC (L-1): `hint` shows a plain note when the gateway's own scan is cut off — this
            list is then honestly missing its oldest runs, not necessarily complete. */}
        <Field
          label={t('rd.activity.run')}
          htmlFor="fw-activity-run"
          className="fw-activity__filter"
          hint={runsTruncated ? t('rd.activity.runsTruncated') : undefined}
        >
          <select
            id="fw-activity-run"
            className="fw-activity__select"
            value={pickedRunId}
            onChange={(event) => setPickedRunId(event.target.value)}
          >
            <option value={CURRENT_RUN_OPTION}>
              {t('rd.activity.currentRun')}
              {currentRunId !== null ? ` (${currentRunId})` : ''}
            </option>
            {/* WP-8d: each run carries its proof label in short form, so an archival or stale
                receipt shows up here too — the words come from the shared finalize-proof mapping. */}
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id} · {proofWords(locale, runProofSummary(run)).short}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('rd.activity.search')} htmlFor="fw-activity-search" className="fw-activity__filter fw-activity__filter--search">
          <span className="fw-activity__search">
            <Icon name="Search" size="sm" className="fw-activity__search-icon" />
            <input
              id="fw-activity-search"
              type="search"
              className="fw-activity__input"
              placeholder={t('rd.activity.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
        </Field>

        <Field label={t('rd.activity.agent')} htmlFor="fw-activity-agent" className="fw-activity__filter">
          <select
            id="fw-activity-agent"
            className="fw-activity__select"
            value={agentFilter}
            onChange={(event) => setAgentFilter(event.target.value)}
          >
            <option value="all">{t('rd.activity.allAgents')}</option>
            {agentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('rd.activity.statusLabel')} htmlFor="fw-activity-status" className="fw-activity__filter">
          <select
            id="fw-activity-status"
            className="fw-activity__select"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">{t('rd.activity.allStatuses')}</option>
            {STATUS_KEYS.map((status) => (
              <option key={status} value={status}>
                {t(STATUS_WORD[status])}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('rd.activity.kindLabel')} htmlFor="fw-activity-kind" className="fw-activity__filter">
          <select
            id="fw-activity-kind"
            className="fw-activity__select"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="all">{t('rd.activity.allKinds')}</option>
            {EVENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(KIND[kind].label)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {filterSet ? (
        <div className="fw-activity__active" role="status">
          <span className="fw-activity__active-label fw-activity-label">{t('rd.activity.filteringOn')}</span>
          <ul className="fw-activity__chips">
            {activeFilters.map((filter) => (
              <li key={filter.id} className="fw-activity__chip">
                <span className="fw-activity__chip-label fw-activity-label">{filter.label}</span>
                <span className="fw-activity__chip-value fw-truncate">{filter.value}</span>
                <IconButton
                  icon="X"
                  size="sm"
                  label={t('rd.activity.clearFilter', { name: filter.label.toLowerCase() })}
                  onClick={filter.clear}
                />
              </li>
            ))}
          </ul>
          <Button size="sm" variant="quiet" icon="ListX" onClick={clearAll}>
            {t('rd.activity.clearAll')}
          </Button>
        </div>
      ) : null}

      {/* A scrolling region must be reachable by keyboard even when nothing inside it is (axe
          scrollable-region-focusable: the honest empty state has no button). */}
      <div className="fw-activity__body fw-scroll" tabIndex={0} role="region" aria-label={t('rd.activity.bodyLabel')}>
        {filtered.length === 0 ? (
          // XR-COPY1: with nothing recorded the honest message is "nothing yet", not a filter problem,
          // and the clear button only shows when there is a filter to clear.
          <EmptyState
            icon={events.length === 0 ? 'Inbox' : 'SearchX'}
            title={events.length === 0 ? t('rd.activity.empty.none') : t('rd.activity.empty.filtered')}
            detail={
              events.length === 0
                ? undefined
                : n(events.length, 'rd.activity.empty.widenOne', 'rd.activity.empty.widenMany')
            }
            action={
              filterSet ? (
                <Button size="sm" icon="ListX" onClick={clearAll}>
                  {t('rd.activity.empty.clearAll')}
                </Button>
              ) : undefined
            }
          />
        ) : groupByRun ? (
          groups.map((group) => (
            <section
              key={group.runId}
              className="fw-run"
              aria-labelledby={`fw-run-head--${group.runId}`}
            >
              <header className="fw-run__head">
                <h2 id={`fw-run-head--${group.runId}`} className="fw-run__id">
                  <Machine>{group.runId}</Machine>
                </h2>
                <StatusBadge status={group.status} size="sm" />
                <p className="fw-run__goal fw-truncate">{group.goal}</p>
                <p className="fw-run__meta">
                  <LocalTime value={group.startedAt} />
                  <span className="fw-run__meta-sep" aria-hidden="true">
                    ·
                  </span>
                  {/* XR-COPY1: no duration recorded means no segment, not an empty "· ·" gap. */}
                  {group.duration.trim() !== '' && group.duration !== '—' ? (
                    <>
                      <span className="fw-activity-num">{group.duration}</span>
                      <span className="fw-run__meta-sep" aria-hidden="true">
                        ·
                      </span>
                    </>
                  ) : null}
                  <span className="fw-activity-num">{group.events.length}</span>
                  <span className="fw-run__meta-word"> {countWord(group.events.length)}</span>
                </p>
                {group.runId === currentRunId && (eventsMeta.truncated || eventsMeta.malformedLines > 0) ? (
                  <p className="fw-run__meta">
                    {eventsMeta.truncated ? (
                      <span className="fw-run__meta-word">
                        {/* cc-fix-dash-latency: "earlier events were not loaded" was only accurate
                            for the original byte-cap cause — truncation can now ALSO come from the
                            per-run in-memory line cap (`events.mjs`'s `MAX_LINE_RECORDS_PER_ENTRY`),
                            which drops lines that WERE already loaded once, not lines that were
                            never read. "no longer available" is honest for both causes. */}
                        {t('rd.activity.truncated')}
                      </span>
                    ) : null}
                    {eventsMeta.truncated && eventsMeta.malformedLines > 0 ? (
                      <span className="fw-run__meta-sep" aria-hidden="true">
                        ·
                      </span>
                    ) : null}
                    {eventsMeta.malformedLines > 0 ? (
                      <>
                        <span className="fw-activity-num">{eventsMeta.malformedLines}</span>
                        <span className="fw-run__meta-word">
                          {' '}
                          {eventsMeta.malformedLines === 1 ? t('rd.activity.unreadableOne') : t('rd.activity.unreadableMany')}
                        </span>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {eventScanErrors.get(group.runId) ? (
                  <p className="fw-run__meta">
                    <span className="fw-run__meta-word" title={eventScanErrors.get(group.runId) ?? undefined}>
                      {t('rd.activity.scanError')}
                    </span>
                  </p>
                ) : null}
              </header>

              <ol className="fw-activity__list">
                {group.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    t={t}
                    showRun={false}
                    expanded={openIds.has(event.id)}
                    selected={selectedId === event.id}
                    onActivate={activateEvent}
                  />
                ))}
              </ol>
            </section>
          ))
        ) : (
          <ol className="fw-activity__list fw-activity__list--flat">
            {filtered.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                t={t}
                showRun
                expanded={openIds.has(event.id)}
                selected={selectedId === event.id}
                onActivate={activateEvent}
              />
            ))}
          </ol>
        )}

        <RecoveryPanel projectName={state.activeProjectId} />

        <p className="fw-activity__note">
          {isProductionMode() ? (
            <span>{t('rd.activity.feedLive')}</span>
          ) : (
            <>
              <ExampleTag detail={t('rd.activity.sampleDetail')} />
              <span>{t('rd.activity.feedSample')}</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
