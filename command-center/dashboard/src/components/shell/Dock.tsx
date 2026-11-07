/**
 * Dock — the collapsible bottom panel.
 *
 * Six panels over the same example dataset: Activity, Terminal, Tests, Events,
 * Proof, Notices. Collapsed it is a rail (34px); open it is 260px tall and its
 * body scrolls inside itself.
 *
 * The Terminal panel is a recorded transcript, not a terminal. It carries an
 * <ExampleTag/> in its own header and its prompt line is visibly inert: there
 * is no input, nothing is parsed and nothing is executed. That is the whole
 * point of the panel — it shows what recorded output would look like.
 *
 * WP B3-copy: every visible word comes from the locale (`dock.*` in nl.json/en.json); each panel
 * has a plain Dutch empty state. English names from the logs (event kinds, `events.jsonl`, raw
 * agent names, proof commands) only render in Uitgebreid, inside `data-log-name` spans, per
 * PRODUCT-CARD.md; Eenvoudig shows the Dutch role names instead.
 */

import { useState } from 'react';
import {
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  IconButton,
  Machine,
  Spacer,
  StatusBadge,
  TabPanel,
  Tabs,
  statusPresentation,
} from '@/components/primitives';
import { isProductionMode } from '@/config/mode';
import { useLocale } from '@/i18n/use-locale';
import { getLocale, t as translateNow } from '@/i18n';
import type { MessageKey, MessageVars } from '@/i18n';
import { useUiMode } from '@/state/ui-mode';
import { roleFromName } from '@/views/team/team-data';
import { senderName } from '@/views/team/team-ui';
// fix-cert-fixtures: imported directly from the
// small presentation-copy module, NOT from '@/prototype/data' (the gate) —
// that barrel's own top-level import of the full fixture dataset would
// otherwise reach this unconditionally-rendered component. See
// `prototype/data/claude-code.ts`'s header and `tests/unit/fixture-import-
// graph.test.ts`.
import { CLAUDE_CODE_LINK_BY_STATE } from '@/prototype/data/claude-code';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { DockTab, PrototypeState } from '@/prototype/state/prototype-store';
// WP7b: the real gateway connection, not the intentionally-unused bridge one —
// see `gateway-adapter.ts`'s header. Same `ConnectionState` shape.
import { useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import { dedupeLatestByKey } from '@/prototype/state/adapter/shared';
import type { ConnectionState } from '@/prototype/state/bridge-client';
import type { GatewayConnectionState } from '@/prototype/state/adapter/connection';
import type { ActivityEvent, ProofEntry, QualityGate, StatusKey } from '@/prototype/types/prototype-types';
import './dock.css';

const TAB_VALUES: readonly DockTab[] = ['activity', 'terminal', 'tests', 'events', 'proof', 'notices'];

const VERDICT_STATUS: Readonly<Record<ProofEntry['verdict'], StatusKey>> = {
  accepted: 'completed',
  rejected: 'failed',
  pending: 'verify',
};

type TFn = (key: MessageKey, vars?: MessageVars) => string;

/** A helper's name: the Dutch role name in Eenvoudig, the raw log name in Uitgebreid (PRODUCT-CARD "Rolnamen"). */
function helperName(t: TFn, raw: string | null | undefined, advanced: boolean): string {
  if (advanced && raw) return raw;
  return senderName(t, roleFromName(raw), raw ?? null, advanced);
}

/** The Dutch status word + sentence for a badge (nl only; English keeps the primitive's own copy). */
function statusText(status: StatusKey): { label?: string; description?: string } {
  if (getLocale() !== 'nl') return {};
  return { label: translateNow(`inspector.status.${status}`), description: translateNow(`inspector.statusDetail.${status}`) };
}

/** The primitive StatusDot's exact markup, with the Dutch sentence (StatusDot itself has no label prop). */
function DockStatusDot({ status }: { status: StatusKey }) {
  const presentation = statusPresentation(status);
  const sentence = statusText(status).description ?? presentation.description;
  return (
    <span className="fw-status fw-status-dot" data-status={status} role="img" aria-label={sentence} title={sentence}>
      <Icon name={presentation.icon} size="xs" spin={presentation.animated} className="fw-status-dot__icon" />
    </span>
  );
}

/** The quiet empty state every dock panel shows when it has nothing to list. */
function DockEmpty({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return <EmptyState icon={icon} title={title} detail={detail} compact className="fw-dock__empty" />;
}

function toDockTab(value: string): DockTab {
  return TAB_VALUES.includes(value as DockTab) ? (value as DockTab) : 'activity';
}

/** "2026-07-24 15:47:12" -> "15:47:12". Falls back to the whole string. */
function clockOf(timestamp: string): string {
  const parts = timestamp.split(' ');
  return parts.length > 1 ? parts[1] : timestamp;
}

/* --------------------------------------------------------------- activity */

function ActivityPanel({
  events,
  onSelect,
  t,
  advanced,
}: {
  events: readonly ActivityEvent[];
  onSelect: (id: string) => void;
  t: TFn;
  advanced: boolean;
}) {
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>{t('dock.activity.eyebrow')}</Eyebrow>
        <Machine muted>{t('dock.activity.count', { count: events.length })}</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">{t('dock.activity.note')}</span>
      </div>
      {events.length === 0 ? (
        <DockEmpty icon="Activity" title={t('dock.activity.emptyTitle')} detail={t('dock.activity.emptyDetail')} />
      ) : null}
      <div className="fw-dock__rows fw-scroll">
        {events.map((event) => (
          <button
            key={event.id}
            type="button"
            className="fw-dock__event fw-status"
            data-status={event.status}
            onClick={() => onSelect(event.id)}
          >
            <Machine muted className="fw-dock__time">
              {clockOf(event.timestamp)}
            </Machine>
            <DockStatusDot status={event.status} />
            <Machine muted className="fw-dock__agent fw-truncate">
              {event.agent ? helperName(t, event.agent, advanced) : t('dock.activity.system')}
            </Machine>
            <span className="fw-dock__message fw-truncate" data-log-text="">
              {event.message}
            </span>
            {advanced ? (
              <Machine muted className="fw-dock__kind" data-log-name="">
                {event.kind}
              </Machine>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- terminal */

function TerminalPanel({
  gates,
  selectedId,
  onSelectGate,
  t,
}: {
  gates: readonly QualityGate[];
  selectedId: string;
  onSelectGate: (id: string) => void;
  t: TFn;
}) {
  const gate = gates.find((candidate) => candidate.id === selectedId) ?? gates[0];
  const lines = gate ? gate.output.split('\n') : [];

  if (gates.length === 0) {
    return (
      <div className="fw-dock__panel">
        <DockEmpty icon="SquareTerminal" title={t('dock.terminal.emptyTitle')} detail={t('dock.terminal.emptyDetail')} />
      </div>
    );
  }

  return (
    <div className="fw-dock__panel fw-dock__terminal">
      <div className="fw-dock__transcripts fw-scroll" aria-label={t('dock.terminal.listLabel')}>
        <span className="fw-dock__transcripts-label fg-eyebrow">{t('dock.terminal.list')}</span>
        {gates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={candidate.id === gate?.id ? 'fw-dock__transcript is-selected' : 'fw-dock__transcript'}
            aria-pressed={candidate.id === gate?.id}
            onClick={() => onSelectGate(candidate.id)}
          >
            <StatusBadge status={candidate.status} size="sm" iconOnly {...statusText(candidate.status)} />
            <span className="fw-truncate" data-log-text="">
              {candidate.name}
            </span>
          </button>
        ))}
      </div>

      <div className="fw-dock__terminal-main">
        <div className="fw-dock__panel-head">
          <Eyebrow>{t('dock.terminal.eyebrow')}</Eyebrow>
          {gate ? <Machine muted>{gate.lastRun}</Machine> : null}
          <Spacer />
          <ExampleTag detail={t('dock.terminal.exampleNote')} />
        </div>

        <pre className="fw-dock__log fw-scroll fg-machine" tabIndex={0} data-log-text="">
          {lines.map((line, index) => (
            <span
              key={`${index}-${line}`}
              className="fw-dock__log-line"
              data-line={line.startsWith('$ ') ? 'command' : undefined}
            >
              {line === '' ? ' ' : line}
              {'\n'}
            </span>
          ))}
        </pre>

        <p className="fw-dock__prompt">
          <span className="fg-machine fw-dock__prompt-mark" aria-hidden="true">
            $
          </span>
          <Icon name="Lock" size="xs" className="fw-dock__prompt-icon" />
          <span className="fw-dock__prompt-text">
            {isProductionMode() ? t('dock.terminal.noInputLive') : t('dock.terminal.noInputExample')}
          </span>
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tests */

function TestsPanel({
  gates,
  onSelect,
  t,
}: {
  gates: readonly QualityGate[];
  onSelect: (id: string) => void;
  t: TFn;
}) {
  const green = gates.filter((gate) => gate.status === 'completed').length;
  const open = gates.length - green;
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>{t('dock.tests.eyebrow')}</Eyebrow>
        <Machine muted>{t('dock.tests.count', { done: green, open })}</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">{t('dock.tests.note')}</span>
      </div>
      {gates.length === 0 ? (
        <DockEmpty icon="ShieldCheck" title={t('dock.tests.emptyTitle')} detail={t('dock.tests.emptyDetail')} />
      ) : null}
      <div className="fw-dock__rows fw-scroll">
        {gates.map((gate) => (
          <button
            key={gate.id}
            type="button"
            className="fw-dock__gate fw-status"
            data-status={gate.status}
            onClick={() => onSelect(gate.id)}
          >
            <StatusBadge status={gate.status} size="sm" {...statusText(gate.status)} />
            <span className="fw-dock__gate-name fw-truncate" data-log-text="">
              {gate.name}
            </span>
            <Machine muted className="fw-dock__gate-duration">
              {gate.duration}
            </Machine>
            <Machine muted className="fw-dock__gate-run">
              {gate.lastRun}
            </Machine>
            <Machine muted className="fw-dock__gate-evidence">
              {t('dock.tests.items', { count: gate.evidenceCount })}
            </Machine>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- events */

function EventsPanel({ events, t, advanced }: { events: readonly ActivityEvent[]; t: TFn; advanced: boolean }) {
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>{t('dock.events.eyebrow')}</Eyebrow>
        {advanced ? (
          <Machine muted data-log-name="">
            {isProductionMode() ? 'events.jsonl' : 'events.jsonl · example'}
          </Machine>
        ) : null}
        <Spacer />
        <span className="fw-dock__panel-note">{t('dock.events.note')}</span>
      </div>
      {events.length === 0 ? (
        <DockEmpty icon="ScrollText" title={t('dock.events.emptyTitle')} detail={t('dock.events.emptyDetail')} />
      ) : null}
      <div className="fw-dock__stream fw-scroll" tabIndex={0}>
        <div className="fw-dock__stream-inner">
          {events.map((event) => (
            <div key={event.id} className="fw-dock__stream-row fw-status" data-status={event.status}>
              <Machine muted>{event.timestamp}</Machine>
              {advanced ? <Machine data-log-name="">{event.kind}</Machine> : null}
              <Machine muted>{event.agent ? helperName(t, event.agent, advanced) : '—'}</Machine>
              <Machine className="fw-dock__stream-status">{statusText(event.status).label ?? statusPresentation(event.status).label}</Machine>
              <Machine muted className="fw-dock__stream-message" data-log-text="">
                {event.message}
              </Machine>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ proof */

function ProofPanel({
  entries,
  onSelect,
  t,
  advanced,
}: {
  entries: readonly ProofEntry[];
  onSelect: (id: string) => void;
  t: TFn;
  advanced: boolean;
}) {
  const accepted = entries.filter((entry) => entry.verdict === 'accepted').length;
  const rejected = entries.filter((entry) => entry.verdict === 'rejected').length;
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>{t('dock.proof.eyebrow')}</Eyebrow>
        <Machine muted>{t('dock.proof.count', { accepted, rejected })}</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">{t('dock.proof.note')}</span>
      </div>
      {entries.length === 0 ? (
        <DockEmpty icon="ReceiptText" title={t('dock.proof.emptyTitle')} detail={t('dock.proof.emptyDetail')} />
      ) : null}
      <div className="fw-dock__rows fw-scroll">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="fw-dock__proof fw-status"
            data-status={VERDICT_STATUS[entry.verdict]}
            onClick={() => onSelect(entry.id)}
          >
            <StatusBadge status={VERDICT_STATUS[entry.verdict]} size="sm" {...statusText(VERDICT_STATUS[entry.verdict])} />
            <span className="fw-dock__proof-claim fw-truncate" data-log-text="">
              {entry.claim}
            </span>
            {advanced ? (
              <Machine muted className="fw-dock__proof-command fw-truncate" data-log-name="">
                {entry.command}
              </Machine>
            ) : null}
            <Machine muted className="fw-dock__proof-agent fw-truncate">
              {helperName(t, entry.agent, advanced)}
            </Machine>
            {advanced ? (
              <Machine muted className="fw-dock__proof-task" data-log-name="">
                {entry.taskId}
              </Machine>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- notices */

interface Notice {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly example?: boolean;
}

/** The bridge connection projected onto a notice icon/title/detail, in production. */
function connectionNoticeIcon(status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTED':
      return 'Cable';
    case 'CONNECTING':
      return 'Loader';
    case 'DEGRADED':
      return 'RefreshCw';
    case 'DISCONNECTED':
      return 'Unplug';
  }
}

function connectionNoticeTitle(t: TFn, status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTED':
      return t('dock.notices.connected');
    case 'CONNECTING':
      return t('dock.notices.connecting');
    case 'DEGRADED':
      return t('dock.notices.reconnecting');
    case 'DISCONNECTED':
      return t('dock.notices.disconnected');
  }
}

function connectionNoticeDetail(t: TFn, connection: GatewayConnectionState, advanced: boolean): string {
  switch (connection.status) {
    case 'CONNECTED':
      return t('dock.notices.connectedDetail', { endpoint: connection.endpoint });
    case 'DISCONNECTED':
      // WP B3-ui: no developer command in the desktop app (startCommand null there). WP B3-copy: and
      // never in Eenvoudig either; Uitgebreid in the browser still names the start command.
      if (connection.startCommand === null || !advanced) return t('dock.notices.disconnectedDetail');
      return t('dock.notices.disconnectedStart', { command: connection.startCommand });
    default:
      return t('dock.notices.connectingDetail', { endpoint: connection.endpoint });
  }
}

/**
 * The standing facts about this session. In PRODUCTION they describe the real
 * bridge link and the real records folded from its event log; in FIXTURES they
 * describe the example dataset, unchanged, so the showcase and tests still read
 * the same copy.
 */
/** WP-CCD (item 9): a claim's real identity for "was this specific check later resolved" —
 *  `agent`+`command` mirrors the same identity the adapter's own `dedupeLatestVerdictRows` uses for
 *  the raw `/api/proof` shape this `ProofEntry` was itself built from. */
function proofClaimIdentity(entry: ProofEntry): string {
  return `${entry.agent}::${entry.command}`;
}

/** WP-CCD (item 9): a bounded, readable "N of these, then +M more" join — the SAME cap style this
 *  notice's own list can otherwise grow past a sensible glance-length on a run with many rejections. */
const REJECTED_CLAIMS_SHOWN = 4;

function joinRejectedClaims(t: TFn, entries: readonly ProofEntry[]): string {
  const shown = entries.slice(0, REJECTED_CLAIMS_SHOWN).map((entry) => entry.claim);
  const remaining = entries.length - shown.length;
  return remaining > 0 ? t('dock.notices.proofMore', { shown: shown.join('; '), count: remaining }) : shown.join('; ');
}

function buildNotices(
  state: PrototypeState,
  connection: GatewayConnectionState,
  t: TFn,
  advanced: boolean,
): readonly Notice[] {
  const production = isProductionMode();
  const openGates = state.data.gates.filter((gate) => gate.status !== 'completed');
  // WP-CCD (item 9): the LATEST claim per real identity (agent+command) — a claim that was
  // rejected once and later accepted for the SAME check no longer counts as an open failure here,
  // matching the "real, readable open failures" this notice is meant to show (never "any rejection
  // ever", the same "latest result wins" rule `dedupeLatestVerdictRows` already applies to gates).
  const rejected = dedupeLatestByKey(state.data.proof, proofClaimIdentity).filter((entry) => entry.verdict === 'rejected');
  const blockedTasks = state.data.tasks.filter((task) => task.status === 'blocked');
  const counts = t('dock.notices.counts', {
    projects: state.data.projects.length,
    helpers: state.data.agents.length,
    tasks: state.data.tasks.length,
    events: state.data.events.length,
  });

  const linkNotice: Notice = production
    ? {
        id: 'notice-link',
        icon: connectionNoticeIcon(connection.status),
        title: t('dock.notices.linkTitle', { state: connectionNoticeTitle(t, connection.status) }),
        detail: connectionNoticeDetail(t, connection, advanced),
      }
    : ((): Notice => {
        const link = CLAUDE_CODE_LINK_BY_STATE[state.claudeCodeState];
        return {
          id: 'notice-link',
          icon: 'Unplug',
          title: t('dock.notices.claudeLinkTitle', { state: link.title }),
          detail: `${link.detail} ${link.hint}`,
        };
      })();

  return [
    linkNotice,
    {
      id: 'notice-data',
      icon: production ? 'Database' : 'FlaskConical',
      title: production ? t('dock.notices.dataLiveTitle') : t('dock.notices.dataExampleTitle'),
      detail: production
        // "gateway", not "bridge": in production these records come from the gateway's event log
        // on 127.0.0.1:4100. The bridge is the never-connected original backend — naming it here
        // pointed the reader at the wrong component for data they are looking at right now.
        ? t('dock.notices.dataLiveDetail', { counts })
        : t('dock.notices.dataExampleDetail', { counts }),
      example: !production,
    },
    {
      id: 'notice-gates',
      icon: 'ShieldCheck',
      title: t('dock.notices.gatesTitle', { count: openGates.length }),
      detail:
        openGates.length === 0
          ? production
            ? t('dock.notices.gatesNoneLive')
            : t('dock.notices.gatesNoneExample')
          : t('dock.notices.gatesSome', { names: openGates.map((gate) => gate.name).join(', ') }),
      example: !production,
    },
    {
      id: 'notice-proof',
      icon: 'CircleAlert',
      title: t('dock.notices.proofTitle', { count: rejected.length }),
      detail:
        rejected.length === 0
          ? production
            ? t('dock.notices.proofNoneLive')
            : t('dock.notices.proofNoneExample')
          // WP-CCD (item 9): real, readable claim text (`entry.claim`, e.g. "Build Boss ran npm
          // test") — a real gateway `ProofEntry.taskId` is always '' (no task-id source exists on
          // this row yet), which is what turned this into "— , , ," for every real workspace.
          : t('dock.notices.proofSome', { claims: joinRejectedClaims(t, rejected) }),
      example: !production,
    },
    {
      id: 'notice-blocked',
      icon: 'Lock',
      title: t('dock.notices.blockedTitle', { count: blockedTasks.length }),
      detail:
        blockedTasks.length === 0
          ? production
            ? t('dock.notices.blockedNoneLive')
            : t('dock.notices.blockedNoneExample')
          : t('dock.notices.blockedSome', { ids: blockedTasks.map((task) => task.id).join(', ') }),
      example: !production,
    },
  ];
}

function NoticesPanel({ notices, t, exampleNote }: { notices: readonly Notice[]; t: TFn; exampleNote: string }) {
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>{t('dock.notices.eyebrow')}</Eyebrow>
        <Machine muted>{t('dock.notices.count', { count: notices.length })}</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">{t('dock.notices.note')}</span>
      </div>
      <div className="fw-dock__notices fw-scroll">
        {notices.map((notice) => (
          <article key={notice.id} className="fw-dock__notice">
            <Icon name={notice.icon} size="sm" className="fw-dock__notice-icon" />
            <div className="fw-dock__notice-text">
              <p className="fw-dock__notice-title">
                {notice.title}
                {notice.example ? <ExampleTag detail={exampleNote} /> : null}
              </p>
              <p className="fw-dock__notice-detail">{notice.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- component */

export interface DockProps {
  /**
   * Redesign 1C: inside the Uitgebreid "Details" pane. The dock is always open there (no collapse
   * button) and shows Activiteit, Controles and Opleverbewijs first; Terminal, Gebeurtenissen and
   * Meldingen sit behind "Meer" (DESIGN.md §2). Every tab stays reachable.
   */
  readonly embedded?: boolean;
  /** The "Meer" label (the shell passes its own copy until the rd.* keys land). */
  readonly moreLabel?: string;
}

const PRIMARY_EMBEDDED_TABS: readonly DockTab[] = ['activity', 'tests', 'proof'];

export function Dock({ embedded = false, moreLabel = 'Meer' }: DockProps = {}) {
  const { state, dispatch } = usePrototype();
  const connection = useConnection();
  const { t } = useLocale();
  const { isAdvanced: advanced } = useUiMode();
  const exampleNote = t('dock.exampleNote');
  const [transcriptId, setTranscriptId] = useState<string>(() => state.data.gates[0]?.id ?? '');
  const [showMore, setShowMore] = useState(false);

  const open = embedded || state.dockOpen;
  const tab = state.dockTab;

  const allItems = [
    { value: 'activity', label: t('dock.tab.activity'), count: state.data.events.length },
    { value: 'terminal', label: t('dock.tab.terminal') },
    { value: 'tests', label: t('dock.tab.tests'), count: state.data.gates.length },
    { value: 'events', label: t('dock.tab.events'), count: state.data.events.length },
    { value: 'proof', label: t('dock.tab.proof'), count: state.data.proof.length },
    { value: 'notices', label: t('dock.tab.notices') },
  ];
  // Embedded: the three everyday tabs first, the rest only after "Meer" (or when one of them is open).
  const moreOpen = showMore || !PRIMARY_EMBEDDED_TABS.includes(tab);
  const items = embedded
    ? [
        ...PRIMARY_EMBEDDED_TABS.map((value) => allItems.find((item) => item.value === value)!),
        ...(moreOpen ? allItems.filter((item) => !PRIMARY_EMBEDDED_TABS.includes(item.value as DockTab)) : []),
      ]
    : allItems;

  return (
    <section
      className="fw-dock"
      data-open={open ? 'true' : 'false'}
      data-embedded={embedded ? 'true' : undefined}
      aria-label={t('dock.region')}
    >
      <div className="fw-dock__rail">
        <div className="fw-dock__rail-tabs">
          <Tabs
            items={items}
            value={tab}
            onChange={(value) => dispatch({ type: 'dock/tab', tab: toDockTab(value) })}
            ariaLabel={t('dock.tabsLabel')}
            idPrefix="fw-dock"
            size="sm"
          />
        </div>
        {embedded && !moreOpen ? (
          <button type="button" className="fw-dock__more" aria-expanded={false} onClick={() => setShowMore(true)}>
            {moreLabel}
          </button>
        ) : null}
        <Spacer />
        <ExampleTag detail={exampleNote} />
        {embedded ? null : (
          <IconButton
            icon={open ? 'PanelBottomClose' : 'PanelBottomOpen'}
            label={open ? t('dock.collapse') : t('dock.expand')}
            size="sm"
            onClick={() => dispatch({ type: 'dock/toggle' })}
          />
        )}
      </div>

      {open ? (
        <TabPanel idPrefix="fw-dock" value={tab} active className="fw-dock__body">
          {tab === 'activity' ? (
            <ActivityPanel
              events={state.data.events}
              onSelect={(id) => dispatch({ type: 'select', selection: { kind: 'event', id } })}
              t={t}
              advanced={advanced}
            />
          ) : null}
          {tab === 'terminal' ? (
            <TerminalPanel gates={state.data.gates} selectedId={transcriptId} onSelectGate={setTranscriptId} t={t} />
          ) : null}
          {tab === 'tests' ? (
            <TestsPanel
              gates={state.data.gates}
              onSelect={(id) => dispatch({ type: 'select', selection: { kind: 'gate', id } })}
              t={t}
            />
          ) : null}
          {tab === 'events' ? <EventsPanel events={state.data.events} t={t} advanced={advanced} /> : null}
          {tab === 'proof' ? (
            <ProofPanel
              entries={state.data.proof}
              onSelect={(id) => dispatch({ type: 'select', selection: { kind: 'proof', id } })}
              t={t}
              advanced={advanced}
            />
          ) : null}
          {tab === 'notices' ? (
            <NoticesPanel notices={buildNotices(state, connection, t, advanced)} t={t} exampleNote={exampleNote} />
          ) : null}
        </TabPanel>
      ) : null}
    </section>
  );
}

export default Dock;
