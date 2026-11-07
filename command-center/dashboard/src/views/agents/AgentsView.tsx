/**
 * Agents view — this project's agent roster.
 *
 * Four views: three persisted layouts (compact list / grid / grouped by
 * function, `state.agentLayout`) plus a fourth, local-only "Nodes" mode
 * (`AgentsGraph.tsx`) that draws the same filtered roster as a pan/zoomable
 * reporting-line graph. A status filter row bound to `state.agentFilter` with
 * live counts applies to all four.
 *
 * `state.data.agents` is real in production (this project's own registry, read
 * through the gateway) and fixture-labelled example data otherwise — the view
 * itself cannot tell which.
 *
 * Group identity is carried by a distinct lucide glyph and a sentence-case
 * name per group — never by hue (one accent, of the redesign).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Button,
  EmptyState,
  ExampleTag,
  Icon,
  Machine,
  Meter,
  SegmentedControl,
  StatusBadge,
  Toolbar,
  statusPresentation,
} from '@/components/primitives';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import type {
  Agent,
  AgentGroup,
  AgentLayout,
  EffortTier,
  PermissionLevel,
  StatusKey,
} from '@/prototype/types/prototype-types';
import { nextToastId, selectFilteredAgents, usePrototype } from '@/prototype/state/prototype-store';
import { gwGet } from '@/prototype/state/gateway-client';
import { parseAgentRows, type AgentRow } from '@/prototype/state/adapter/rows';
import { patchAgentModel, type AgentModelField } from '@/prototype/state/adapter/agent-model';
import { GROUPS, GROUP_BY_KEY } from './agent-groups';
import { AgentsGraph } from './AgentsGraph';
import { AgentModelPicker } from './agent-model-picker';
import { LiveAgentsStrip } from './LiveAgentsStrip';
import './agents.css';
import { useLocale } from '@/i18n/use-locale';
import type { MessageKey } from '@/i18n';

/* ------------------------------------------------------------------ tables */

type AgentFilter = StatusKey | 'all';

interface FilterDef {
  readonly value: AgentFilter;
  readonly label: MessageKey;
  readonly icon: string;
}

/**
 * `active` is the running status under a friendlier name. `failed` is included
 * so a failed agent stays reachable from the filter row rather than only from
 * ALL — the example roster has one.
 */
const FILTERS: readonly FilterDef[] = [
  { value: 'all', label: 'rd.agents.filter.all', icon: 'Users' },
  { value: 'running', label: 'rd.agents.filter.running', icon: statusPresentation('running').icon },
  { value: 'waiting', label: 'rd.agents.filter.waiting', icon: statusPresentation('waiting').icon },
  { value: 'verify', label: 'rd.agents.filter.verify', icon: statusPresentation('verify').icon },
  { value: 'review', label: 'rd.agents.filter.review', icon: statusPresentation('review').icon },
  { value: 'blocked', label: 'rd.agents.filter.blocked', icon: statusPresentation('blocked').icon },
  { value: 'failed', label: 'rd.agents.filter.failed', icon: statusPresentation('failed').icon },
  { value: 'completed', label: 'rd.agents.filter.completed', icon: statusPresentation('completed').icon },
];

const LAYOUTS: readonly { value: AgentLayout; label: MessageKey; icon: string }[] = [
  { value: 'list', label: 'rd.agents.layout.list', icon: 'Rows3' },
  { value: 'grid', label: 'rd.agents.layout.grid', icon: 'LayoutGrid' },
  { value: 'grouped', label: 'rd.agents.layout.grouped', icon: 'Group' },
];

/**
 * A local, view-only fourth mode layered on top of the persisted `AgentLayout`
 * (list/grid/grouped, `state.agentLayout`, owned by the shared prototype
 * store). "Nodes" is deliberately NOT added to that shared union — this view's
 * write scope is this directory only, and the shared reducer/type already has
 * other consumers (`SettingsView.tsx`'s own default-layout control). Selecting
 * "Nodes" flips local `nodesActive` state without touching the persisted
 * layout at all, so switching back to List/Grid/Grouped restores exactly what
 * was there before.
 */
type AgentViewMode = AgentLayout | 'nodes';

const VIEW_MODES: readonly { value: AgentViewMode; label: MessageKey; icon: string }[] = [
  ...LAYOUTS,
  { value: 'nodes', label: 'rd.agents.layout.nodes', icon: 'Network' },
];

const PERMISSION_ICON: Readonly<Record<PermissionLevel, string>> = {
  'read-only': 'Eye',
  standard: 'Shield',
  elevated: 'ShieldPlus',
  lead: 'ShieldCheck',
};

/**
 * fix-cert-rest (item 2): keyed on `NonNullable<Agent['verification']>` — `null` (no verification
 * evidence exists for this agent in this run) is handled separately by `VerificationChip` below,
 * rendered as absent, never as a claim about the agent's role. `'not-required'` stays a real,
 * renderable state: fixture/example data may still genuinely assert it for a role.
 */
const VERIFICATION_ICON: Readonly<Record<NonNullable<Agent['verification']>, string>> = {
  verified: 'BadgeCheck',
  pending: 'Hourglass',
  rejected: 'Ban',
  'not-required': 'Minus',
};


const EFFORT_ORDER: readonly EffortTier[] = ['low', 'medium', 'high', 'max'];

function isAgentLayout(value: string): value is AgentLayout {
  return value === 'list' || value === 'grid' || value === 'grouped';
}

/* --------------------------------------------------------- model editing */

/**
 * feat-agent-model-edit: the raw, per-agent `AgentRow` (real `claudeTier`/`claudeEffort` strings —
 * `Agent.effort`, the mapped `EffortTier`, is lossy for this: `toEffortTier` in mappers.ts folds
 * an unrecognised raw value like `'xhigh'` down to `'medium'`) plus the real allowed values for
 * each field, derived the SAME way `agents-write.mjs` derives them server-side: the distinct set
 * of values that genuinely already exist across every agent in the roster. Never hardcoded here —
 * see this module's own header comment on `deriveAllowedValues` for the identical server-side rule
 * this mirrors.
 */
interface AgentModelState {
  /**
   * WHICH project these rows were read for (MEDIUM finding, independent Codex review of dc8e30c,
   * 2026-07-30). Rows are keyed by agent slug alone, and the same slug exists in every Forge
   * project — so without this tag, switching projects kept showing (and offering to edit) the
   * PREVIOUS project's on-disk tier/effort until the new fetch resolved, and kept showing it
   * indefinitely if that fetch failed (the effect deliberately never blanks the roster on a
   * transient error). A wrong pick was already refused server-side by the new project's own
   * allowlist, so nothing incorrect was ever written — but the screen claimed a value that did not
   * belong to the project in view, which is the same class of dishonesty this run has been removing
   * everywhere else. Reading a row now requires the project to match.
   */
  readonly projectId: string;
  readonly rows: ReadonlyMap<string, AgentRow>;
  readonly allowedTiers: readonly string[];
  readonly allowedEfforts: readonly string[];
}

const EMPTY_MODEL_STATE: AgentModelState = { projectId: '', rows: new Map(), allowedTiers: [], allowedEfforts: [] };

function buildModelState(projectId: string, agentRows: readonly AgentRow[]): AgentModelState {
  const rows = new Map(agentRows.map((row) => [row.slug, row] as const));
  const tiers = new Set<string>();
  const efforts = new Set<string>();
  for (const row of agentRows) {
    if (row.modelTier !== null) tiers.add(row.modelTier);
    if (row.claudeEffort !== null) efforts.add(row.claudeEffort);
  }
  return { projectId, rows, allowedTiers: [...tiers].sort(), allowedEfforts: [...efforts].sort() };
}

/* --------------------------------------------------------------- fragments */

function PermissionChip({ level }: { level: PermissionLevel }) {
  const { t } = useLocale();
  // "Verhoogd"/"Alle rechten", never the mode word Uitgebreid or the group name Leiding (gate).
  const label = t(`rd.agents.access.${level}`);
  return (
    <span className="fw-agents-chip" data-permission={level} title={t('rd.agents.accessTitle', { level: label })}>
      <Icon name={PERMISSION_ICON[level]} size="xs" />
      <span className="fw-agents-chip__label">{label}</span>
    </span>
  );
}

function VerificationChip({ state: verification }: { state: Agent['verification'] }) {
  const { t } = useLocale();
  // fix-cert-rest (item 2): `null` means no verification evidence exists for this agent in this run.
  // It renders as an absent dash, never as 'not-required', which is a claim about the role.
  const label = verification === null ? t('rd.agents.verification.unknown') : t(`rd.agents.verification.${verification}`);
  const detail =
    verification === null ? t('rd.agents.verification.unknownDetail') : t(`rd.agents.verification.${verification}Detail`);
  return (
    <span className="fw-agents-chip" data-verification={verification ?? 'unknown'} title={detail}>
      <Icon name={verification === null ? 'Minus' : VERIFICATION_ICON[verification]} size="xs" />
      <span className="fw-agents-chip__label">{label}</span>
      <span className="fw-visually-hidden">{detail}</span>
    </span>
  );
}

function EffortMark({ effort }: { effort: EffortTier }) {
  const { t } = useLocale();
  const level = EFFORT_ORDER.indexOf(effort) + 1;
  const word = t(`rd.agents.effort.${effort}`);
  return (
    <span className="fw-agents-effort" title={t('rd.agents.effortTitle', { level: word })}>
      <span className="fw-agents-effort__bars" aria-hidden="true">
        {EFFORT_ORDER.map((tier, index) => (
          <span
            key={tier}
            className={index < level ? 'fw-agents-effort__bar is-on' : 'fw-agents-effort__bar'}
          />
        ))}
      </span>
      <span className="fw-agents-effort__word">{word}</span>
    </span>
  );
}

function SkillChips({ skills }: { skills: readonly string[] }) {
  const { t } = useLocale();
  if (skills.length === 0) {
    return <p className="fw-agents-skills__none">{t('rd.agents.noSkills')}</p>;
  }
  return (
    <ul className="fw-agents-skills" aria-label={t('rd.agents.skillsList')}>
      {skills.map((skill) => (
        <li key={skill} className="fw-agents-chip fw-agents-chip--skill">
          <Machine>{skill}</Machine>
        </li>
      ))}
    </ul>
  );
}

function ModelLine({ icon, label, value, plain = false }: { icon: string; label: string; value: string; plain?: boolean }) {
  return (
    <div className="fw-agents-model">
      <dt className="fw-agents-model__key">
        <Icon name={icon} size="xs" />
        <span className="fw-agents-model__label">{label}</span>
      </dt>
      <dd className="fw-agents-model__val">
        {plain ? <span className="fw-agents-model__plain">{value}</span> : <Machine muted>{value}</Machine>}
      </dd>
    </div>
  );
}

/**
 * The mapped `Agent.effort` is lossy (`toEffortTier` turns `xhigh` and a missing value into
 * `medium`), so it is only shown for example data, whose tier is its own. A real agent shows the raw
 * `claudeEffort` from disk once it is read, and nothing while it is not.
 */
function showsMappedEffort(agent: Agent, modelRow: AgentRow | undefined): boolean {
  return modelRow === undefined && (agent as { prototype?: unknown }).prototype === true;
}

/**
 * feat-agent-model-edit: the editable twin of `ModelLine` above — same `dt`/`dd` shape, but the
 * value is a real `AgentModelPicker` rather than static text. Only ever rendered once a real
 * `modelRow` exists for this agent (see `AgentCard`/`AgentRow` below), so `value` here is always the
 * genuine current on-disk string, never a guess.
 */
function ModelEditLine({
  icon,
  label,
  field,
  slug,
  value,
  options,
  pendingModelKey,
  onModelPick,
}: {
  icon: string;
  label: string;
  field: AgentModelField;
  slug: string;
  value: string;
  options: readonly string[];
  pendingModelKey: string | null;
  onModelPick: (slug: string, field: AgentModelField, value: string) => void;
}) {
  const key = `${slug}:${field}`;
  return (
    <div className="fw-agents-model">
      <dt className="fw-agents-model__key">
        <Icon name={icon} size="xs" />
        <span className="fw-agents-model__label">{label}</span>
      </dt>
      {/* fix-modelpick-clip (2026-07-30, owner: "als ik op agents de model wil veranderen dan zie
          ik niks!"): the base __val cell truncates its text with overflow:hidden — but this editable
          variant hosts the picker, whose absolutely-positioned panel is a CHILD of the cell and was
          therefore clipped to the cell's 26px (measured live: panel top 573 below cell bottom 569 →
          100% invisible while present in the DOM with 4 options; jsdom-based tests could not see
          this). The --editor modifier lifts the clip; the trigger truncates its own label already. */}
      <dd className="fw-agents-model__val fw-agents-model__val--editor">
        <AgentModelPicker
          label={label}
          icon={icon}
          value={value}
          options={options}
          pending={pendingModelKey === key}
          onPick={(next) => onModelPick(slug, field, next)}
        />
      </dd>
    </div>
  );
}

interface EntryProps {
  agent: Agent;
  /** Drawn inside a Per groep band: the band already names the group. */
  inBand?: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  /** feat-agent-model-edit: `undefined` when the raw roster fetch has not resolved yet (or failed) —
   *  every consumer falls back to the existing read-only display in that case. */
  modelRow?: AgentRow;
  allowedTiers: readonly string[];
  allowedEfforts: readonly string[];
  /** `"<slug>:<field>"` of the one edit currently in flight, or `null`. */
  pendingModelKey: string | null;
  onModelPick: (slug: string, field: AgentModelField, value: string) => void;
}

/* ------------------------------------------------------------------- card */

function AgentCard({ agent, inBand = false, selected, onSelect, modelRow, allowedTiers, allowedEfforts, pendingModelKey, onModelPick }: EntryProps) {
  const { t } = useLocale();
  const group = GROUP_BY_KEY[agent.group];

  return (
    <li
      className={
        selected
          ? 'fw-agents-card fw-status fw-agents-group is-selected'
          : 'fw-agents-card fw-status fw-agents-group'
      }
      data-status={agent.status}
      data-group={agent.group}
      data-agent-id={agent.id}
    >
      <div className="fw-agents-card__top">
        <Avatar name={agent.name} group={agent.group} size="sm" decorative />
        <div className="fw-agents-card__ident">
          <button
            type="button"
            className="fw-agents-card__hit"
            aria-pressed={selected}
            onClick={() => onSelect(agent.id)}
          >
            {agent.name}
          </button>
          <Machine muted className="fw-agents-card__id">
            {agent.id}
          </Machine>
        </div>
        <StatusBadge status={agent.status} size="sm" />
      </div>

      <div className="fw-agents-card__group">
        {inBand ? null : (
          <>
            <span className="fw-agents-card__glyph">
              <Icon name={group.glyph} size="xs" />
            </span>
            <span className="fw-agents-card__group-name">{t(`rd.agents.group.${group.key}`)}</span>
            <span className="fw-agents-card__divider" aria-hidden="true" />
          </>
        )}
        <PermissionChip level={agent.permission} />
      </div>

      <p className="fw-agents-card__role">{agent.role}</p>

      {/* Calm card: a "nothing" line (no task, no skills) is left out instead of drawn (wave-3 gate). */}
      {agent.currentTask ? (
        <div className="fw-agents-card__task">
          <span className="fw-agents-card__label">{t('rd.agents.currentTask')}</span>
          <p className="fw-agents-card__task-text">{agent.currentTask}</p>
        </div>
      ) : null}

      {agent.status === 'running' ? (
        <Meter value={agent.progress} tone="accent" showValue />
      ) : null}

      <dl className="fw-agents-card__models">
        {modelRow !== undefined ? (
          <ModelEditLine
            icon="Cpu"
            label={t('rd.agents.model.runtime')}
            field="claudeTier"
            slug={modelRow.slug}
            value={modelRow.modelTier ?? agent.runtimeModel}
            options={allowedTiers}
            pendingModelKey={pendingModelKey}
            onModelPick={onModelPick}
          />
        ) : (
          <ModelLine icon="Cpu" label={t('rd.agents.model.runtime')} value={agent.runtimeModel} />
        )}
        {agent.toolModel ? <ModelLine icon="Boxes" label={t('rd.agents.model.tool')} value={agent.toolModel} /> : null}
        {modelRow !== undefined && modelRow.claudeEffort !== null ? (
          <ModelEditLine
            icon="Gauge"
            label={t('rd.agents.model.effort')}
            field="claudeEffort"
            slug={modelRow.slug}
            value={modelRow.claudeEffort}
            options={allowedEfforts}
            pendingModelKey={pendingModelKey}
            onModelPick={onModelPick}
          />
        ) : modelRow !== undefined ? (
          <ModelLine icon="Gauge" label={t('rd.agents.model.effort')} value={t('rd.agents.model.unset')} plain />
        ) : null}
      </dl>

      {agent.skills.length > 0 ? (
        <div className="fw-agents-card__skills">
          <span className="fw-agents-card__label">{t('rd.agents.skills')}</span>
          <SkillChips skills={agent.skills} />
        </div>
      ) : null}

      <div className="fw-agents-card__foot">
        {showsMappedEffort(agent, modelRow) ? <EffortMark effort={agent.effort} /> : null}
        <VerificationChip state={agent.verification} />
        {agent.lastActivity ? (
          <span className="fw-agents-card__activity">
            <Icon name="Clock" size="xs" />
            <span className="fw-agents-card__when">{agent.lastActivity}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------- row */

function AgentRow({ agent, selected, onSelect, modelRow, allowedTiers, allowedEfforts, pendingModelKey, onModelPick }: EntryProps) {
  const { t } = useLocale();
  const group = GROUP_BY_KEY[agent.group];
  const groupTitle = t('rd.agents.groupTitle', { group: t(`rd.agents.group.${group.key}`) });

  return (
    <li
      className={
        selected
          ? 'fw-agents-row fw-status fw-agents-group is-selected'
          : 'fw-agents-row fw-status fw-agents-group'
      }
      data-status={agent.status}
      data-group={agent.group}
      data-agent-id={agent.id}
    >
      <span className="fw-agents-row__glyph" title={groupTitle}>
        <Icon name={group.glyph} size="sm" />
        <span className="fw-visually-hidden">{groupTitle}</span>
      </span>

      <div className="fw-agents-row__body">
        <div className="fw-agents-row__line">
          <button
            type="button"
            className="fw-agents-row__hit"
            aria-pressed={selected}
            onClick={() => onSelect(agent.id)}
          >
            {agent.name}
          </button>
          <Machine muted className="fw-agents-row__id">
            {agent.id}
          </Machine>
          <StatusBadge status={agent.status} size="sm" />
          <PermissionChip level={agent.permission} />
          {showsMappedEffort(agent, modelRow) ? <EffortMark effort={agent.effort} /> : null}
          <VerificationChip state={agent.verification} />
        </div>

        <p className="fw-agents-row__role">{agent.role}</p>

        <p className={agent.currentTask ? 'fw-agents-row__task' : 'fw-agents-row__task is-none'}>
          <Icon name="CornerDownRight" size="xs" />
          {agent.currentTask ?? t('rd.agents.noTask')}
        </p>

        <div className="fw-agents-row__meta">
          <span className="fw-agents-row__meta-item">
            {modelRow !== undefined ? (
              <AgentModelPicker
                label={t('rd.agents.model.runtime')}
                icon="Cpu"
                value={modelRow.modelTier ?? agent.runtimeModel}
                options={allowedTiers}
                pending={pendingModelKey === `${modelRow.slug}:claudeTier`}
                onPick={(value) => onModelPick(modelRow.slug, 'claudeTier', value)}
              />
            ) : (
              <>
                <Icon name="Cpu" size="xs" />
                <Machine muted>{agent.runtimeModel}</Machine>
              </>
            )}
          </span>
          {agent.toolModel ? (
            <span className="fw-agents-row__meta-item">
              <Icon name="Boxes" size="xs" />
              <Machine muted>{agent.toolModel}</Machine>
            </span>
          ) : null}
          {modelRow !== undefined && modelRow.claudeEffort !== null ? (
            <span className="fw-agents-row__meta-item">
              <AgentModelPicker
                label={t('rd.agents.model.effort')}
                icon="Gauge"
                value={modelRow.claudeEffort}
                options={allowedEfforts}
                pending={pendingModelKey === `${modelRow.slug}:claudeEffort`}
                onPick={(value) => onModelPick(modelRow.slug, 'claudeEffort', value)}
              />
            </span>
          ) : modelRow !== undefined ? (
            <span className="fw-agents-row__meta-item">
              <Icon name="Gauge" size="xs" />
              <span className="fw-agents-row__unset">
                {t('rd.agents.model.effort')}: {t('rd.agents.model.unset')}
              </span>
            </span>
          ) : null}
          {agent.lastActivity ? (
            <span className="fw-agents-row__meta-item">
              <Icon name="Clock" size="xs" />
              <span className="fw-agents-row__when">{agent.lastActivity}</span>
            </span>
          ) : null}
          <SkillChips skills={agent.skills} />
        </div>
      </div>

      <div className="fw-agents-row__progress">
        {agent.status === 'running' ? (
          <Meter value={agent.progress} tone="accent" showValue />
        ) : (
          <span className="fw-agents-row__progress-idle" aria-hidden="true" />
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------- view */

export default function AgentsView() {
  const { t } = useLocale();
  const { state, dispatch } = usePrototype();
  const agents = state.data.agents;
  const visible = selectFilteredAgents(state);
  const layout = state.agentLayout;
  const selectedId = state.selection.kind === 'agent' ? state.selection.id : null;

  // Local-only: see `AgentViewMode`'s doc comment above. Not persisted, not
  // dispatched to the shared store — a pure UI toggle scoped to this view.
  const [nodesActive, setNodesActive] = useState(false);
  const viewMode: AgentViewMode = nodesActive ? 'nodes' : layout;

  // feat-agent-model-edit: an INDEPENDENT, view-local fetch of the raw `/api/agents` roster —
  // deliberately not sharing `useGatewayProjectAgents` (the shared 2.5s-poll hook `useGatewayDataset`
  // already calls to build `state.data.agents`), since that hook only ever exposes `Agent.effort`,
  // the LOSSY mapped `EffortTier` (`toEffortTier` in mappers.ts folds an unrecognised raw value like
  // `'xhigh'` down to `'medium'`) — editing needs the real raw string. This also gives a real,
  // on-demand "read again from the gateway" step right after a successful PATCH (see
  // `refreshModelRows`/`handleModelPick` below), rather than waiting on the shared hook's own poll
  // interval.
  const [modelState, setModelState] = useState<AgentModelState>(EMPTY_MODEL_STATE);
  const [pendingModelKey, setPendingModelKey] = useState<string | null>(null);
  // Bumped after a successful PATCH to trigger a fresh re-fetch below — mirrors the shape every
  // other polling hook in this codebase uses (an inline async fetch declared INSIDE the effect,
  // never an outer memoized function called FROM the effect), so a real re-read never overlaps a
  // stale in-flight one and never fires synchronously from the effect body itself.
  const [modelRefreshTick, setModelRefreshTick] = useState(0);
  // Alleen rijen van het ACTIEVE project mogen de picker voeden (zie AgentModelState.projectId).
  const modelRowsForProject = modelState.projectId === state.activeProjectId ? modelState.rows : EMPTY_MODEL_STATE.rows;
  const allowedTiersForProject = modelState.projectId === state.activeProjectId ? modelState.allowedTiers : EMPTY_MODEL_STATE.allowedTiers;
  const allowedEffortsForProject = modelState.projectId === state.activeProjectId ? modelState.allowedEfforts : EMPTY_MODEL_STATE.allowedEfforts;

  useEffect(() => {
    if (state.activeProjectId === '') return undefined;
    let cancelled = false;
    async function load(): Promise<void> {
      const result = await gwGet(`/api/agents?project=${encodeURIComponent(state.activeProjectId)}`);
      if (cancelled || !result.ok) return; // keep whatever was last known — never blank the roster on a transient failure
      setModelState(buildModelState(state.activeProjectId, parseAgentRows(result.data)));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [state.activeProjectId, modelRefreshTick]);

  async function handleModelPick(slug: string, field: AgentModelField, value: string): Promise<void> {
    const key = `${slug}:${field}`;
    setPendingModelKey(key);
    const result = await patchAgentModel(state.activeProjectId, slug, field, value);
    setPendingModelKey(null);
    if (!result.ok) {
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: t('rd.agents.model.failed'),
          detail: result.error ?? t('rd.agents.model.failedDetail'),
          icon: 'TriangleAlert',
        },
      });
      return; // the old value is still on screen — nothing was ever set optimistically
    }
    // Honesty rule (work package): show the value read FRESH from the gateway/disk after success,
    // never the merely-requested one — a real re-fetch (the effect above), not the PATCH response
    // trusted blindly.
    setModelRefreshTick((tick) => tick + 1);
  }

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: agents.length };
    for (const key of STATUS_KEYS) {
      map[key] = agents.filter((agent) => agent.status === key).length;
    }
    return map;
  }, [agents]);

  const banded = useMemo(() => {
    const map = new Map<AgentGroup, Agent[]>();
    for (const group of GROUPS) map.set(group.key, []);
    for (const agent of visible) map.get(agent.group)?.push(agent);
    return map;
  }, [visible]);

  function select(id: string) {
    dispatch({ type: 'select', selection: { kind: 'agent', id } });
  }

  const cards = (list: readonly Agent[], inBand = false) => (
    <ul className="fw-agents-grid">
      {list.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          inBand={inBand}
          selected={agent.id === selectedId}
          onSelect={select}
          modelRow={modelRowsForProject.get(agent.id)}
          allowedTiers={allowedTiersForProject}
          allowedEfforts={allowedEffortsForProject}
          pendingModelKey={pendingModelKey}
          onModelPick={(slug, field, value) => void handleModelPick(slug, field, value)}
        />
      ))}
    </ul>
  );

  // A roster with nobody in it at all: one honest line. The filter reset would do nothing here.
  const noRoster = agents.length === 0;

  const empty = noRoster ? (
    <EmptyState icon="Users" title={t('rd.agents.live.noRegistry')} />
  ) : (
    <EmptyState
      icon="UserRoundSearch"
      title={t('rd.agents.empty.title')}
      detail={t('rd.agents.empty.detail')}
      action={
        <Button size="sm" icon="RotateCcw" onClick={() => dispatch({ type: 'agents/filter', filter: 'all' })}>
          {t('rd.agents.empty.action')}
        </Button>
      }
    />
  );

  return (
    <div className="fw-agents">
      <header className="fw-agents__head">
        <div className="fw-agents__heading">
          <h1 className="fw-agents__title">{t('rd.agents.title')}</h1>
          <p className="fw-agents__subtitle">
            {t('rd.agents.subtitle')} <ExampleTag />
          </p>
        </div>

        {noRoster ? null : (
          <Toolbar label={t('rd.agents.toolbar')} className="fw-agents__toolbar">
          <SegmentedControl
            className="fw-agents__layout"
            label={t('rd.agents.layoutLabel')}
            size="sm"
            value={viewMode}
            options={VIEW_MODES.map((option) => ({
              value: option.value,
              label: t(option.label),
              icon: option.icon,
            }))}
            onChange={(value) => {
              if (value === 'nodes') {
                setNodesActive(true);
                return;
              }
              if (isAgentLayout(value)) {
                setNodesActive(false);
                dispatch({ type: 'agents/layout', layout: value });
              }
            }}
          />
          </Toolbar>
        )}
      </header>

      <LiveAgentsStrip agentCount={agents.length} projectId={state.activeProjectId} />

      {noRoster ? null : (
      <div className="fw-agents__filters" role="group" aria-label={t('rd.agents.filters')}>
        {FILTERS.map((filter) => {
          const active = state.agentFilter === filter.value;
          const count = counts[filter.value] ?? 0;
          // Calm row: a status nobody is in right now is left out. "All" and the chosen one always show.
          if (!active && filter.value !== 'all' && count === 0) return null;
          return (
            <Button
              key={filter.value}
              size="sm"
              variant={active ? 'ghost' : 'quiet'}
              icon={filter.icon}
              aria-pressed={active}
              className={active ? 'fw-agents__filter is-active' : 'fw-agents__filter'}
              onClick={() => dispatch({ type: 'agents/filter', filter: filter.value })}
            >
              <span className="fw-agents__filter-label">{t(filter.label)}</span>
              <span className="fw-agents__filter-count">{count}</span>
            </Button>
          );
        })}
      </div>
      )}

      <div className="fw-agents__body fw-scroll">
        {visible.length === 0 ? (
          empty
        ) : viewMode === 'nodes' ? (
          <AgentsGraph agents={visible} selectedId={selectedId} onSelect={select} />
        ) : layout === 'list' ? (
          <ul className="fw-agents-list">
            {visible.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedId}
                onSelect={select}
                modelRow={modelRowsForProject.get(agent.id)}
                allowedTiers={allowedTiersForProject}
                allowedEfforts={allowedEffortsForProject}
                pendingModelKey={pendingModelKey}
                onModelPick={(slug, field, value) => void handleModelPick(slug, field, value)}
              />
            ))}
          </ul>
        ) : layout === 'grid' ? (
          cards(visible)
        ) : (
          <div className="fw-agents__bands">
            {GROUPS.map((group) => {
              const list = banded.get(group.key) ?? [];
              // Calm page: a group with no helper in this roster at all is not drawn.
              if (!agents.some((agent) => agent.group === group.key)) return null;
              return (
                <section
                  key={group.key}
                  className="fw-agents__band fw-agents-group"
                  data-group={group.key}
                  aria-labelledby={`agents-band-${group.key}`}
                >
                  <header className="fw-agents__band-head">
                    <span className="fw-agents__band-glyph">
                      <Icon name={group.glyph} size="sm" />
                    </span>
                    <h2 id={`agents-band-${group.key}`} className="fw-agents__band-title">
                      {t(`rd.agents.group.${group.key}`)}
                    </h2>
                    <span className="fw-agents__band-count">{list.length}</span>
                    <p className="fw-agents__band-note">{t(`rd.agents.groupNote.${group.key}`)}</p>
                  </header>
                  {list.length === 0 ? (
                    <p className="fw-agents__band-empty">{t('rd.agents.bandEmpty')}</p>
                  ) : (
                    cards(list, true)
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
