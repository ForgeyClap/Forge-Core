/**
 * Tests & proof — the quality-gate board and the proof ledger.
 *
 * Two stacked sections over `state.data`, real in production and
 * fixture-labelled example data otherwise:
 *
 *   1. The gate board (state.data.gates). Each row is a disclosure that reveals
 *      its recorded console output.
 *   2. The proof ledger (state.data.proof). One line per completion claim, with
 *      the verify verdict as icon + uppercase label, never colour alone. The
 *      reason is the point of the ledger, so rejected rows open by default.
 */

import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  ExampleTag,
  Field,
  Icon,
  Machine,
  Panel,
  SegmentedControl,
  Spacer,
  StatusBadge,
  Timestamp,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayProofExtras } from '@/prototype/state/gateway-adapter';
import { isProductionMode } from '@/config/mode';
import type { ProofEntry, QualityGate } from '@/prototype/types/prototype-types';
import { RunHealthPanel } from './RunHealthPanel';
import { RecentRunsPanel } from './RecentRunsPanel';
import './tests.css';

/* ------------------------------------------------------------------ verdict */

type Verdict = ProofEntry['verdict'];
type VerdictFilter = 'all' | Verdict;

interface VerdictPresentation {
  readonly icon: string;
}

/*
 * A verdict is a third axis next to status and agent group, so it gets its own
 * presentation map. There is no verdict token trio, so the stylesheet
 * borrows the closest status treatments: completed / failed / waiting.
 * W3FX-BC: the words live in the pending copy (`rd.tests.verdict|verdictInfo|reason.<verdict>`).
 */
const VERDICT: Readonly<Record<Verdict, VerdictPresentation>> = {
  accepted: { icon: 'CircleCheck' },
  rejected: { icon: 'CircleX' },
  pending: { icon: 'CircleDashed' },
};

const VERDICT_FILTERS: readonly VerdictFilter[] = ['all', 'accepted', 'rejected', 'pending'];

function toVerdictFilter(value: string): VerdictFilter {
  return (VERDICT_FILTERS as readonly string[]).includes(value) ? (value as VerdictFilter) : 'all';
}

function VerdictMark({ verdict }: { verdict: Verdict }) {
  const { t } = useLocale();
  const presentation = VERDICT[verdict];
  const description = t(`rd.tests.verdictInfo.${verdict}`);
  return (
    <span className="fw-verdict" data-verdict={verdict} title={description}>
      <Icon name={presentation.icon} size="sm" className="fw-verdict__icon" />
      <span className="fw-verdict__label" aria-hidden="true">
        {t(`rd.tests.verdict.${verdict}`)}
      </span>
      <span className="fw-visually-hidden">{description}</span>
    </span>
  );
}

/* -------------------------------------------------------------------- utils */

function toggleId(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/* ---------------------------------------------------------------- gate row */

interface GateRowProps {
  gate: QualityGate;
  expanded: boolean;
  selected: boolean;
  /** Toggles the output and selects the gate for the inspector, in one gesture. */
  onActivate: (id: string) => void;
}

function GateRow({ gate, expanded, selected, onActivate }: GateRowProps) {
  const { t } = useLocale();
  const headId = `fw-gate-head--${gate.id}`;
  const outputId = `fw-gate-output--${gate.id}`;

  return (
    <li
      className="fw-gate fw-status"
      data-status={gate.status}
      data-selected={selected ? 'true' : undefined}
    >
      <button
        type="button"
        id={headId}
        className="fw-gate__head"
        aria-expanded={expanded}
        aria-controls={outputId}
        onClick={() => onActivate(gate.id)}
      >
        <span className="fw-gate__badge">
          <StatusBadge status={gate.status} size="sm" />
        </span>
        <span className="fw-gate__name fw-truncate">{gate.name}</span>
        <span className="fw-gate__meta">
          <span className="fw-gate__cell">
            <span className="fw-visually-hidden">{`${t('rd.tests.th.duration')} `}</span>
            {/* cc-fix-events-honesty (P2-11): '' is not measured-as-empty here — no per-check
                start/end timestamp pair exists anywhere in this gateway (see this view's own
                module header / gateway-adapter.ts's header). An em dash reads as absence; an
                empty cell reads as a rendering bug. */}
            <span className="fw-tests-num">{gate.duration.trim() !== '' ? gate.duration : '—'}</span>
          </span>
          <span className="fw-gate__cell">
            <span className="fw-visually-hidden">{`${t('rd.tests.th.lastRun')} `}</span>
            <Timestamp value={gate.lastRun} />
          </span>
          <span className="fw-gate__cell">
            <Icon name="Paperclip" size="xs" className="fw-gate__cell-icon" />
            <span className="fw-tests-num">{gate.evidenceCount}</span>
            <span className="fw-visually-hidden">{` ${t('rd.tests.th.proof')}`}</span>
          </span>
        </span>
        <Icon name="ChevronDown" size="sm" className="fw-gate__chev" />
      </button>

      <div
        className="fw-gate__output"
        id={outputId}
        role="region"
        aria-labelledby={headId}
        hidden={!expanded}
      >
        <div className="fw-gate__output-head">
          <span className="fw-tests-label">{t('rd.tests.gates.output')}</span>
          <Spacer />
          <ExampleTag
            detail="Hand-written example output. This prototype never ran a command, drove a browser or measured a duration."
          />
        </div>
        <pre className="fw-gate__pre fg-machine">{gate.output}</pre>
      </div>
    </li>
  );
}

/* --------------------------------------------------------------- proof row */

interface ProofRowProps {
  entry: ProofEntry;
  expanded: boolean;
  selected: boolean;
  onActivate: (id: string) => void;
  onSelect: (id: string) => void;
}

function ProofRow({ entry, expanded, selected, onActivate, onSelect }: ProofRowProps) {
  const { t } = useLocale();
  const detailId = `fw-proof-detail--${entry.id}`;

  return (
    <tbody
      className="fw-proof__group"
      data-verdict={entry.verdict}
      data-selected={selected ? 'true' : undefined}
    >
      <tr className="fw-proof__row" onClick={() => onSelect(entry.id)}>
        <td className="fw-proof__cell fw-proof__cell--time" data-label={t('rd.tests.ledger.th.time')}>
          <Timestamp value={entry.timestamp} />
        </td>
        <td className="fw-proof__cell fw-proof__cell--claim" data-label={t('rd.tests.ledger.th.claim')}>
          <button
            type="button"
            className="fw-proof__claim"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => onActivate(entry.id)}
          >
            <Icon name="ChevronDown" size="xs" className="fw-proof__chev" />
            <span className="fw-proof__claim-text">{entry.claim}</span>
          </button>
        </td>
        <td className="fw-proof__cell" data-label={t('rd.tests.ledger.th.agent')}>
          <span>{entry.agent}</span>
        </td>
        <td className="fw-proof__cell" data-label={t('rd.tests.ledger.th.task')}>
          {/* cc-fix-events-honesty (P2-11): no task-id source exists on this proof row yet
              (gateway-adapter.ts's toGatewayProof always sets ''); an em dash reads as absence,
              never indistinguishable from "measured as empty". */}
          <Machine muted>{entry.taskId.trim() !== '' ? entry.taskId : '—'}</Machine>
        </td>
        <td className="fw-proof__cell fw-proof__cell--command" data-label={t('rd.tests.ledger.th.command')}>
          <Machine muted>{entry.command}</Machine>
        </td>
        <td className="fw-proof__cell" data-label={t('rd.tests.ledger.th.artifact')}>
          {entry.artifact ? (
            <Machine muted>{entry.artifact}</Machine>
          ) : (
            <span className="fw-proof__none">
              <span aria-hidden="true">—</span>
              <span className="fw-visually-hidden">no artifact attached</span>
            </span>
          )}
        </td>
        <td className="fw-proof__cell fw-proof__cell--verdict" data-label={t('rd.tests.ledger.th.verdict')}>
          <VerdictMark verdict={entry.verdict} />
        </td>
      </tr>

      <tr className="fw-proof__detail-row" id={detailId} hidden={!expanded}>
        <td className="fw-proof__detail" colSpan={7}>
          <div className="fw-proof__detail-inner">
            <span className="fw-tests-label">{t(`rd.tests.reason.${entry.verdict}`)}</span>
            <p className="fw-proof__reason">{entry.reason}</p>
            <p className="fw-proof__detail-foot">
              <Machine muted>{entry.command}</Machine>
              <ExampleTag
                detail="Example ledger line. No command was executed and no verify agent produced this verdict."
              />
            </p>
          </div>
        </td>
      </tr>
    </tbody>
  );
}

/* ------------------------------------------------------------------- view */

export default function TestsView() {
  const { state, dispatch } = usePrototype();
  const { t } = useLocale();
  const gates = state.data.gates;
  const proof = state.data.proof;

  // WP-CCD (item 6): the same "newest run" convention `ActivityView.tsx` already uses —
  // `RunHealthPanel` reads a SECOND, independent `/api/proof` poll for the four net-new fields
  // `PrototypeDataset` does not carry (mirrors `useGatewayRunScanErrors`'s own precedent).
  // the Recent runs table picks which run Run health shows. A pick that is not in this
  // project's run list (after a project switch, say) falls back to the newest run.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const runs = state.data.runs;
  const healthRunId =
    pickedRunId !== null && runs.some((run) => run.id === pickedRunId) ? pickedRunId : (runs[0]?.id ?? null);
  const proofExtras = useGatewayProofExtras(state.activeProjectId, healthRunId);

  const [openGates, setOpenGates] = useState<ReadonlySet<string>>(() => new Set<string>());
  // The rejections are the reason this screen exists, so they start open.
  const [openProof, setOpenProof] = useState<ReadonlySet<string>>(
    () => new Set(proof.filter((entry) => entry.verdict === 'rejected').map((entry) => entry.id)),
  );
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const selectedGateId = state.selection.kind === 'gate' ? state.selection.id : null;
  const selectedProofId = state.selection.kind === 'proof' ? state.selection.id : null;

  const gateSummary = useMemo(() => {
    let passed = 0;
    let failed = 0;
    let blocked = 0;
    let open = 0;
    let evidence = 0;
    for (const gate of gates) {
      evidence += gate.evidenceCount;
      if (gate.status === 'completed') passed += 1;
      else if (gate.status === 'failed') failed += 1;
      else if (gate.status === 'blocked') blocked += 1;
      else open += 1;
    }
    return { passed, failed, blocked, open, evidence };
  }, [gates]);

  const verdictCounts = useMemo(() => {
    let accepted = 0;
    let rejected = 0;
    let pending = 0;
    for (const entry of proof) {
      if (entry.verdict === 'accepted') accepted += 1;
      else if (entry.verdict === 'rejected') rejected += 1;
      else pending += 1;
    }
    return { accepted, rejected, pending };
  }, [proof]);

  const proofAgents = useMemo(
    () => Array.from(new Set(proof.map((entry) => entry.agent))).sort((a, b) => a.localeCompare(b)),
    [proof],
  );

  // A verdict filter chip only appears when at least one ledger line can match
  // it — a chip that can never match is a dead control, not an honest one.
  const verdictOptions = useMemo(() => {
    const seen = new Set(proof.map((entry) => entry.verdict));
    const options: { value: VerdictFilter; label: string; icon?: string }[] = [
      { value: 'all', label: t('rd.tests.ledger.all') },
    ];
    for (const verdict of ['accepted', 'rejected', 'pending'] as const) {
      if (seen.has(verdict)) options.push({ value: verdict, label: t(`rd.tests.verdict.${verdict}`), icon: VERDICT[verdict].icon });
    }
    return options;
  }, [proof, t]);

  const proofRows = useMemo(
    () =>
      proof.filter(
        (entry) =>
          (verdictFilter === 'all' || entry.verdict === verdictFilter) &&
          (agentFilter === 'all' || entry.agent === agentFilter),
      ),
    [proof, verdictFilter, agentFilter],
  );

  const allGatesOpen = openGates.size === gates.length;
  // with nothing to expand the two buttons stay focusable (so their reason can be read)
  // but say they are unavailable, instead of looking like live controls on an empty board.
  const noGates = gates.length === 0;
  const expandUnavailable = noGates || allGatesOpen;
  const collapseUnavailable = noGates || openGates.size === 0;
  const expandReason = noGates ? t('rd.tests.expandNone') : allGatesOpen ? t('rd.tests.expandAll') : undefined;
  const collapseReason = noGates ? t('rd.tests.collapseNone') : openGates.size === 0 ? t('rd.tests.collapseAll') : undefined;
  const gateSummaryLine = [
    t('rd.tests.gates.passed', { passed: gateSummary.passed, total: gates.length }),
    gateSummary.failed > 0 ? t('rd.tests.gates.failed', { count: gateSummary.failed }) : null,
    gateSummary.blocked > 0 ? t('rd.tests.gates.blocked', { count: gateSummary.blocked }) : null,
    gateSummary.open > 0 ? t('rd.tests.gates.open', { count: gateSummary.open }) : null,
    gateSummary.evidence === 1 ? t('rd.tests.gates.proofOne') : t('rd.tests.gates.proofMany', { count: gateSummary.evidence }),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  function activateGate(id: string) {
    setOpenGates((current) => toggleId(current, id));
    dispatch({ type: 'select', selection: { kind: 'gate', id } });
  }

  function activateProof(id: string) {
    setOpenProof((current) => toggleId(current, id));
    dispatch({ type: 'select', selection: { kind: 'proof', id } });
  }

  function selectProof(id: string) {
    dispatch({ type: 'select', selection: { kind: 'proof', id } });
  }

  function clearProofFilters() {
    setVerdictFilter('all');
    setAgentFilter('all');
  }

  const filtersActive = verdictFilter !== 'all' || agentFilter !== 'all';

  return (
    <div className="fw-tests">
      <header className="fw-tests__header">
        <div className="fw-tests__title">
          <h1 className="fw-tests__h1">{t('nav.tests.label')}</h1>
          <p className="fw-tests__lede">{t('nav.tests.description')}</p>
        </div>

        <Toolbar label={t('rd.tests.toolbarLabel')} className="fw-tests__toolbar">
          <ToolbarGroup>
            <Button
              size="sm"
              icon="ChevronsUpDown"
              onClick={() => {
                if (!expandUnavailable) setOpenGates(new Set(gates.map((gate) => gate.id)));
              }}
              aria-disabled={expandUnavailable ? 'true' : undefined}
              title={expandReason}
            >
              {t('rd.tests.expand')}
            </Button>
            <Button
              size="sm"
              icon="ChevronsDownUp"
              onClick={() => {
                if (!collapseUnavailable) setOpenGates(new Set<string>());
              }}
              aria-disabled={collapseUnavailable ? 'true' : undefined}
              title={collapseReason}
            >
              {t('rd.tests.collapse')}
            </Button>
          </ToolbarGroup>
        </Toolbar>
      </header>

      <div className="fw-tests__body fw-scroll">
        {/* ------------------------------------------------------ gate board */}
        <Panel
          title={t('rd.tests.gates.title')}
          subtitle={t('rd.tests.gates.subtitle')}
          padded={false}
          className="fw-tests__panel"
        >
          <div className="fw-gates">
            {noGates ? null : (
              <p className="fw-tests__summary">{gateSummaryLine}</p>
            )}

            {noGates ? null : (
              <div className="fw-gates__legend" aria-hidden="true">
                <span>
                  <span className="fw-tests-label">{t('rd.tests.th.status')}</span>
                </span>
                <span>
                  <span className="fw-tests-label">{t('rd.tests.th.gate')}</span>
                </span>
                <span className="fw-gate__meta">
                  <span>
                    <span className="fw-tests-label">{t('rd.tests.th.duration')}</span>
                  </span>
                  <span>
                    <span className="fw-tests-label">{t('rd.tests.th.lastRun')}</span>
                  </span>
                  <span>
                    <span className="fw-tests-label">{t('rd.tests.th.proof')}</span>
                  </span>
                </span>
                <span />
              </div>
            )}

            {noGates ? (
              <p className="fw-gates__empty">{t('rd.tests.gates.empty')}</p>
            ) : null}

            <ul className="fw-gates__list">
              {gates.map((gate) => (
                <GateRow
                  key={gate.id}
                  gate={gate}
                  expanded={openGates.has(gate.id)}
                  selected={selectedGateId === gate.id}
                  onActivate={activateGate}
                />
              ))}
            </ul>
          </div>
        </Panel>

        {/* ----------------------------------------------------- recent runs */}
        <RecentRunsPanel runs={runs} tasks={state.data.tasks} selectedRunId={healthRunId} onSelect={setPickedRunId} />

        {/* ------------------------------------------------------ run health */}
        <RunHealthPanel extras={proofExtras} runId={healthRunId} />

        {/* ----------------------------------------------------- proof ledger */}
        <Panel
          title={t('rd.tests.ledger.title')}
          subtitle={t('rd.tests.ledger.subtitle', {
            count: proof.length,
            accepted: verdictCounts.accepted,
            rejected: verdictCounts.rejected,
            pending: verdictCounts.pending,
          })}
          padded={false}
          className="fw-tests__panel"
        >
          <div className="fw-proof">
            <div className="fw-proof__filters">
              <Field label={t('rd.tests.ledger.verdict')} className="fw-proof__filter">
                <SegmentedControl
                  label={t('rd.tests.ledger.verdictFilter')}
                  size="sm"
                  value={verdictFilter}
                  onChange={(value) => setVerdictFilter(toVerdictFilter(value))}
                  options={verdictOptions}
                />
              </Field>

              <Field label={t('rd.tests.ledger.agent')} htmlFor="fw-proof-agent" className="fw-proof__filter">
                <select
                  id="fw-proof-agent"
                  className="fw-proof__select"
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                >
                  <option value="all">{t('rd.tests.ledger.allAgents')}</option>
                  {proofAgents.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
              </Field>

              <Spacer />

              <p className="fw-proof__count">
                <span className="fw-tests-num">
                  {proofRows.length}/{proof.length}
                </span>{' '}
                {t('rd.tests.ledger.shown')}
                {filtersActive ? (
                  <Button size="sm" variant="quiet" icon="X" onClick={clearProofFilters}>
                    {t('rd.tests.ledger.clear')}
                  </Button>
                ) : null}
              </p>
            </div>

            {proofRows.length === 0 ? (
              <EmptyState
                icon="SearchX"
                title={t('rd.tests.ledger.noMatch')}
                detail={
                  proof.length === 0
                    ? t('rd.tests.ledger.noClaims')
                    : proof.length === 1
                      ? t('rd.tests.ledger.widenOne')
                      : t('rd.tests.ledger.widenMany', { count: proof.length })
                }
                action={
                  <Button size="sm" icon="X" onClick={clearProofFilters}>
                    {t('rd.tests.ledger.clear')}
                  </Button>
                }
              />
            ) : (
              <div className="fw-proof__scroll">
                <table className="fw-proof__table">
                  <caption className="fw-visually-hidden">
                    Proof ledger. Each row is a completion claim with the command and artifact it
                    was checked against.
                  </caption>
                  <thead className="fw-proof__thead">
                    <tr>
                      <th scope="col">{t('rd.tests.ledger.th.time')}</th>
                      <th scope="col">{t('rd.tests.ledger.th.claim')}</th>
                      <th scope="col">{t('rd.tests.ledger.th.agent')}</th>
                      <th scope="col">{t('rd.tests.ledger.th.task')}</th>
                      <th scope="col">{t('rd.tests.ledger.th.command')}</th>
                      <th scope="col">{t('rd.tests.ledger.th.artifact')}</th>
                      <th scope="col">{t('rd.tests.ledger.th.verdict')}</th>
                    </tr>
                  </thead>
                  {proofRows.map((entry) => (
                    <ProofRow
                      key={entry.id}
                      entry={entry}
                      expanded={openProof.has(entry.id)}
                      selected={selectedProofId === entry.id}
                      onActivate={activateProof}
                      onSelect={selectProof}
                    />
                  ))}
                </table>
              </div>
            )}

            <p className="fw-proof__note">
              <Icon name="Info" size="xs" className="fw-proof__note-icon" />
              {isProductionMode() ? (
                <span>{t('rd.tests.ledger.real')}</span>
              ) : (
                <span>{t('rd.tests.ledger.sample')}</span>
              )}
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
