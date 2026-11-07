/**
 * Tasks view — the mission's work, seen four ways.
 *
 * Layouts are driven by `state.taskLayout`:
 *   kanban         the eight board columns, horizontally scrolling
 *   table          every task field as a sortable column
 *   work-packages  one panel per work package, tasks nested inside
 *   phases         the six phases as a vertical rhythm
 *
 * A card's column is always read through `selectTaskColumn`, so every layout
 * agrees about where a task sits.
 *
 * The board is READ-ONLY over the real run state: there is no drag-and-drop and
 * no move control. A local drag/move used to write a client-only column override
 * that silently contradicted the real run — removed rather than kept as a lie.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  Button,
  EmptyState,
  ExampleTag,
  Icon,
  Machine,
  Meter,
  Panel,
  SegmentedControl,
  StatusBadge,
  Toolbar,
} from '@/components/primitives';
import { TASK_COLUMNS } from '@/prototype/types/prototype-types';
import type {
  Task,
  TaskColumn,
  TaskLayout,
  TaskPhase,
  WorkPackage,
} from '@/prototype/types/prototype-types';
import { selectTaskColumn, usePrototype } from '@/prototype/state/prototype-store';
import { useLocale } from '@/i18n/use-locale';
import './tasks.css';

/* ------------------------------------------------------------------ tables */

// W3FX-BC: every label and note below lives in the pending copy (`rd.tasks.view|column|phase|phaseNote.*`,
// Dutch first); this file keeps only the icons.
const LAYOUTS: readonly { value: TaskLayout; icon: string }[] = [
  { value: 'kanban', icon: 'Columns3' },
  { value: 'table', icon: 'Table' },
  { value: 'work-packages', icon: 'Layers' },
  { value: 'phases', icon: 'ListChecks' },
];

const COLUMN_META: Readonly<Record<TaskColumn, { icon: string }>> = {
  backlog: { icon: 'Inbox' },
  planned: { icon: 'CalendarClock' },
  running: { icon: 'Loader' },
  'self-review': { icon: 'Eye' },
  verify: { icon: 'SearchCheck' },
  review: { icon: 'ClipboardCheck' },
  blocked: { icon: 'Lock' },
  completed: { icon: 'Check' },
};

const PHASES: readonly TaskPhase[] = ['intake', 'plan', 'build', 'verify', 'review', 'handoff'];

const PHASE_META: Readonly<Record<TaskPhase, { icon: string }>> = {
  intake: { icon: 'Inbox' },
  plan: { icon: 'Map' },
  build: { icon: 'Hammer' },
  verify: { icon: 'SearchCheck' },
  review: { icon: 'Gavel' },
  handoff: { icon: 'PackageCheck' },
};

type SortKey =
  | 'id'
  | 'title'
  | 'status'
  | 'column'
  | 'phase'
  | 'agent'
  | 'wp'
  | 'progress'
  | 'proof'
  | 'repairs'
  | 'deps'
  | 'created'
  | 'updated'
  | 'detail';

interface TableColumnDef {
  readonly key: SortKey;
}

/** The heading of each column is `rd.tasks.th.<key>` in the pending copy. */
const TABLE_COLUMNS: readonly TableColumnDef[] = [
  { key: 'id' },
  { key: 'title' },
  { key: 'status' },
  { key: 'column' },
  { key: 'phase' },
  { key: 'agent' },
  { key: 'wp' },
  { key: 'progress' },
  { key: 'proof' },
  { key: 'repairs' },
  { key: 'deps' },
  { key: 'created' },
  { key: 'updated' },
  { key: 'detail' },
];

const SORT_KEYS: ReadonlySet<string> = new Set(TABLE_COLUMNS.map((column) => column.key));

function isSortKey(value: string): value is SortKey {
  return SORT_KEYS.has(value);
}

function isTaskLayout(value: string): value is TaskLayout {
  return (
    value === 'kanban' || value === 'table' || value === 'work-packages' || value === 'phases'
  );
}

/** `wp-1` reads as `WP1` on a card. The full title stays on the work-package panel. */
function shortWorkPackage(id: string): string {
  return id.replace(/-/g, '').toUpperCase();
}

/* --------------------------------------------------------------------- row */

// fix-run-visibility item 3 (silent disappearance): `Row.column` is typed as `TaskColumn`, but a
// real task can arrive with a `column` value the compiler never sees at runtime (any of this
// codebase's several `record as unknown as Task` construction sites — see mappers.ts/chat-runs.ts —
// bypasses the type check on purpose to build a `Task` from an untyped gateway payload). Before this
// fix, `byColumn`'s `map.get(row.column)?.push(row)` silently dropped such a task: `map` only ever
// has the eight real `TASK_COLUMNS` keys, so an unrecognized column meant `.get()` returned
// `undefined` and the optional-chained `.push` quietly did nothing — the task still counted in the
// header's "N tasks" subtitle but never rendered anywhere on the board. Catching it HERE (in `rows`,
// the one place every layout ultimately reads `row.column` from) means every consumer — kanban,
// table, work-packages, phases — is fixed at once, and the sum of every column's list length can
// never again drift from `rows.length`.
const KNOWN_TASK_COLUMNS: ReadonlySet<TaskColumn> = new Set(TASK_COLUMNS);

// 'backlog' is the safest catch bucket: unlike 'blocked' or 'completed' it asserts nothing false
// about the task's real progress — it is simply "not yet placed", which is the honest truth here.
const FALLBACK_TASK_COLUMN: TaskColumn = 'backlog';

function isKnownTaskColumn(column: TaskColumn): boolean {
  return KNOWN_TASK_COLUMNS.has(column);
}

interface Row {
  readonly task: Task;
  readonly agentName: string;
  readonly wpLabel: string;
  /** Always one of the eight real `TASK_COLUMNS` — redirected to `FALLBACK_TASK_COLUMN` below when
   *  the task's own real column was not recognized, so every map keyed by `TASK_COLUMNS` can trust
   *  this field without a defensive `?? []` at every call site. */
  readonly column: TaskColumn;
  /** True when `column` above is a redirect, not the task's real value — see `rawColumn`. */
  readonly columnIsFallback: boolean;
  /** The task's own real column value, always as a string — even when it was not one of the eight
   *  known columns (a plain `TaskColumn` cast could not hold that at the type level, but the actual
   *  runtime string is worth showing honestly rather than discarding). */
  readonly rawColumn: string;
}

function sortValue(row: Row, key: SortKey): string | number {
  switch (key) {
    case 'id':
      return row.task.id;
    case 'title':
      return row.task.title.toLowerCase();
    case 'status':
      return row.task.status;
    case 'column':
      return TASK_COLUMNS.indexOf(row.column);
    case 'phase':
      return PHASES.indexOf(row.task.phase);
    case 'agent':
      return row.agentName.toLowerCase();
    case 'wp':
      return row.wpLabel;
    case 'progress':
      return row.task.progress;
    case 'proof':
      return row.task.proofCount;
    case 'repairs':
      return row.task.repairAttempts;
    case 'deps':
      return row.task.dependencies.join(' ');
    case 'created':
      return row.task.createdAt;
    case 'updated':
      return row.task.updatedAt;
    case 'detail':
      return row.task.detail.toLowerCase();
    default:
      return row.task.id;
  }
}

/* --------------------------------------------------------------- fragments */

function TaskStats({ task }: { task: Task }) {
  const { t } = useLocale();
  if (task.proofCount === 0 && task.repairAttempts === 0) return null;
  return (
    <span className="fw-tasks-stats">
      {task.proofCount > 0 ? (
        <span className="fw-tasks-stat" title={`${task.proofCount} proof entries attached`}>
          <Icon name="FileCheck" size="xs" />
          <span className="fw-tasks-num">{task.proofCount}</span>
          <span className="fw-tasks-stat__word">{t('rd.tasks.stat.proof')}</span>
        </span>
      ) : null}
      {task.repairAttempts > 0 ? (
        <span
          className="fw-tasks-stat is-repair"
          title={`${task.repairAttempts} repair attempts opened by the verify loop`}
        >
          <Icon name="Wrench" size="xs" />
          <span className="fw-tasks-num">{task.repairAttempts}</span>
          <span className="fw-tasks-stat__word">{t('rd.tasks.stat.repairs')}</span>
        </span>
      ) : null}
    </span>
  );
}

// fix-run-visibility item 3: the one visible, honest notice for a task caught by the
// `FALLBACK_TASK_COLUMN` redirect above — renders nothing for every ordinary task (`columnIsFallback`
// is the overwhelmingly common `false` case), so this never adds noise to a normal board.
function ColumnFallbackFlag({ row }: { row: Row }) {
  if (!row.columnIsFallback) return null;
  return (
    <span
      className="fw-tasks-stat is-unknown-column"
      title={`Unrecognized task column "${row.rawColumn}" — shown here under Backlog so it is never lost.`}
    >
      <Icon name="CircleAlert" size="xs" />
      <span className="fw-tasks-stat__word">Unknown column</span>
    </span>
  );
}

// WP-CCD (item 2): the run's own verdict text (e.g. "PASS-WITH-NOTES") — reuses the existing
// `.fw-tasks-stat` chip language exactly (no new colour/shape), renders nothing for the majority of
// tasks that carry no verdict yet.
function VerdictChip({ task }: { task: Task }) {
  if (!task.verdict) return null;
  return (
    <span className="fw-tasks-stat" title={`Verdict: ${task.verdict}`}>
      <Icon name="Gavel" size="xs" />
      <Machine>{task.verdict}</Machine>
    </span>
  );
}

// WP-CCD (item 2): `'stalled'`/`'ended_unknown'` are real states this run reported that the closed
// `StatusKey` union has no room for (see `Task.rawStatus`'s own doc comment) — without this, both
// silently rendered as the generic idle/backlog bucket, indistinguishable from a task that simply
// never started. Reuses `.is-unknown-column`'s exact dashed/secondary treatment (`is-stalled`,
// `tasks.css`) — the same "this needs a second look" language, never a new colour.
function StalledFlag({ task }: { task: Task }) {
  if (task.rawStatus !== 'stalled' && task.rawStatus !== 'ended_unknown') return null;
  const stalled = task.rawStatus === 'stalled';
  return (
    <span
      className="fw-tasks-stat is-stalled"
      title={
        stalled
          ? 'The agent assigned to this task has gone silent past the stale window — not proven finished, not proven still running.'
          : 'The run ended before this task reported a real outcome — shown honestly, never as completed or idle.'
      }
    >
      <Icon name="CircleAlert" size="xs" />
      <span className="fw-tasks-stat__word">{stalled ? 'Stalled' : 'Ended unknown'}</span>
    </span>
  );
}

interface EntryProps {
  row: Row;
  selected: boolean;
  onSelect: (id: string) => void;
}

function TaskCard({ row, selected, onSelect }: EntryProps) {
  const { task } = row;
  const classes = ['fw-tasks-card', 'fw-status'];
  if (selected) classes.push('is-selected');

  return (
    <li className={classes.join(' ')} data-status={task.status}>
      <div className="fw-tasks-card__top">
        <Machine muted className="fw-tasks-card__id">
          {task.id}
        </Machine>
        <StatusBadge status={task.status} size="sm" />
      </div>

      <button
        type="button"
        className="fw-tasks-card__hit"
        aria-pressed={selected}
        onClick={() => onSelect(task.id)}
        title={task.detail}
      >
        {task.title}
      </button>

      <div className="fw-tasks-card__meta">
        <span className="fw-tasks-card__meta-item">
          <Icon name="UserRound" size="xs" />
          <span className="fw-tasks-quiet">{row.agentName}</span>
        </span>
        <span className="fw-tasks-card__meta-item">
          <Icon name="Layers" size="xs" />
          <span className="fw-tasks-quiet">{row.wpLabel}</span>
        </span>
      </div>

      <Meter
        value={task.progress}
        tone={task.status === 'running' ? 'accent' : 'default'}
        showValue
      />

      <div className="fw-tasks-card__foot">
        <TaskStats task={task} />
        <VerdictChip task={task} />
        <StalledFlag task={task} />
        <ColumnFallbackFlag row={row} />
      </div>
    </li>
  );
}

interface RowProps {
  row: Row;
  selected: boolean;
  onSelect: (id: string) => void;
}

function TaskRow({ row, selected, onSelect }: RowProps) {
  const { t } = useLocale();
  const { task } = row;
  return (
    <li
      className={selected ? 'fw-tasks-row fw-status is-selected' : 'fw-tasks-row fw-status'}
      data-status={task.status}
    >
      <Machine muted className="fw-tasks-row__id">
        {task.id}
      </Machine>

      <button
        type="button"
        className="fw-tasks-row__hit"
        aria-pressed={selected}
        onClick={() => onSelect(task.id)}
        title={task.detail}
      >
        {task.title}
      </button>

      <StatusBadge status={task.status} size="sm" />

      <span className="fw-tasks-row__column">
        <Icon name={COLUMN_META[row.column].icon} size="xs" />
        <span className="fw-tasks-quiet">{t(`rd.tasks.column.${row.column}`)}</span>
      </span>

      <span className="fw-tasks-row__agent">
        <Icon name="UserRound" size="xs" />
        <span className="fw-tasks-quiet">{row.agentName}</span>
      </span>

      <span className="fw-tasks-row__meter">
        <Meter
          value={task.progress}
          tone={task.status === 'running' ? 'accent' : 'default'}
          showValue
        />
      </span>

      <TaskStats task={task} />
      <VerdictChip task={task} />
      <StalledFlag task={task} />
      <ColumnFallbackFlag row={row} />
    </li>
  );
}

/* -------------------------------------------------------------------- view */

export default function TasksView() {
  const { state, dispatch } = usePrototype();
  const { t } = useLocale();
  const layout = state.taskLayout;

  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const selectedId = state.selection.kind === 'task' ? state.selection.id : null;

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of state.data.agents) map.set(agent.id, agent.name);
    return map;
  }, [state.data.agents]);

  const rows = useMemo<Row[]>(
    () =>
      state.data.tasks.map((task) => {
        const realColumn = selectTaskColumn(state, task);
        const knownColumn = isKnownTaskColumn(realColumn);
        return {
          task,
          agentName: agentNames.get(task.agentId) ?? task.agentId,
          wpLabel: shortWorkPackage(task.workPackageId),
          column: knownColumn ? realColumn : FALLBACK_TASK_COLUMN,
          columnIsFallback: !knownColumn,
          rawColumn: String(realColumn),
        };
      }),
    [state, agentNames],
  );

  const rowById = useMemo(() => {
    const map = new Map<string, Row>();
    for (const row of rows) map.set(row.task.id, row);
    return map;
  }, [rows]);

  const byColumn = useMemo(() => {
    const map = new Map<TaskColumn, Row[]>();
    for (const column of TASK_COLUMNS) map.set(column, []);
    // `row.column` is guaranteed to be one of the eight keys already set above (the fallback
    // redirect happened when `rows` was built) — this `?.` stays only as ordinary defensive style,
    // never as the silent-drop path it used to be.
    for (const row of rows) map.get(row.column)?.push(row);
    return map;
  }, [rows]);

  // fix-run-visibility item 2 (owner screenshot: the Tasks tab said "2 tasks" but every VISIBLE
  // column read "Nothing in this column") — the first column (in board order) that actually holds a
  // task, or null when the board is genuinely empty. A primitive (a `TaskColumn` string, not the
  // `byColumn` Map/`rows` array themselves) is what the scroll effect below depends on, on purpose —
  // see that effect's own comment for why.
  const firstNonEmptyColumn = useMemo<TaskColumn | null>(() => {
    for (const column of TASK_COLUMNS) {
      if ((byColumn.get(column)?.length ?? 0) > 0) return column;
    }
    return null;
  }, [byColumn]);

  const columnSectionRefs = useRef(new Map<TaskColumn, HTMLElement>());
  function registerColumnSection(column: TaskColumn) {
    return (node: HTMLElement | null) => {
      if (node) columnSectionRefs.current.set(column, node);
      else columnSectionRefs.current.delete(column);
    };
  }

  // Of the three mechanisms this WP named (auto-scroll / collapse-empty-columns-to-a-strip / a text
  // banner), auto-scroll-to-the-first-non-empty-column is the smallest honest fix: it needs no CSS
  // change (this view's frozen `tasks.css` layout — fixed-width columns inside a horizontally-
  // scrolling `.fw-tasks-board` — stays exactly as designed), and it mirrors an ALREADY-established
  // pattern one file over (`CommandPalette.tsx`'s own `options?.[active]?.scrollIntoView({ block:
  // 'nearest' })` effect for keeping the active option in view while arrowing through a long list).
  // Depending on `firstNonEmptyColumn` (a primitive string, not `byColumn`/`rows` themselves) is what
  // keeps this SAFE for a live dashboard: a routine poll tick that returns the identical task set
  // produces a new `rows` array/`byColumn` Map every time (this view's `state` is the whole,
  // immutably-replaced prototype store), but the SAME string for `firstNonEmptyColumn` — so this
  // effect only re-fires, and only re-scrolls, when which column holds the first real task actually
  // changes, never on every poll. It never fires outside the kanban layout (the other three layouts
  // do not have this scroll problem at all — they stack vertically, already showing everything).
  useEffect(() => {
    if (layout !== 'kanban' || firstNonEmptyColumn === null) return;
    columnSectionRefs.current.get(firstNonEmptyColumn)?.scrollIntoView({ inline: 'start', block: 'nearest' });
  }, [layout, firstNonEmptyColumn]);

  const byPhase = useMemo(() => {
    const map = new Map<TaskPhase, Row[]>();
    for (const phase of PHASES) map.set(phase, []);
    for (const row of rows) map.get(row.task.phase)?.push(row);
    return map;
  }, [rows]);

  const sortedRows = useMemo(() => {
    const list = [...rows];
    list.sort((a, b) => {
      const left = sortValue(a, sortKey);
      const right = sortValue(b, sortKey);
      let result =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      if (result === 0) result = a.task.id.localeCompare(b.task.id);
      return sortDir === 'asc' ? result : -result;
    });
    return list;
  }, [rows, sortKey, sortDir]);

  function select(id: string) {
    dispatch({ type: 'select', selection: { kind: 'task', id } });
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    setSortDir('asc');
  }

  function handleSortSelect(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (isSortKey(value)) setSortKey(value);
  }

  function workPackageRows(pkg: WorkPackage): Row[] {
    return pkg.taskIds.flatMap((id) => {
      const row = rowById.get(id);
      return row ? [row] : [];
    });
  }

  const cardProps = (row: Row) => ({
    row,
    selected: row.task.id === selectedId,
    onSelect: select,
  });

  const rowProps = (row: Row) => ({
    row,
    selected: row.task.id === selectedId,
    onSelect: select,
  });

  return (
    <div className="fw-tasks">
      <header className="fw-tasks__head">
        <div className="fw-tasks__heading">
          <h1 className="fw-tasks__title">{t('nav.tasks.label')}</h1>
          <p className="fw-tasks__subtitle">
            {state.data.tasks.length === 1
              ? t('rd.tasks.tasksOne')
              : t('rd.tasks.tasksMany', { count: state.data.tasks.length })}
            {' · '}
            {state.data.workPackages.length === 1
              ? t('rd.tasks.packagesOne')
              : t('rd.tasks.packagesMany', { count: state.data.workPackages.length })}{' '}
            <ExampleTag />
          </p>
        </div>

        <Toolbar label={t('rd.tasks.toolbarLabel')} className="fw-tasks__toolbar">
          <SegmentedControl
            className="fw-tasks__layout"
            label={t('rd.tasks.viewLabel')}
            size="sm"
            value={layout}
            options={LAYOUTS.map((option) => ({
              value: option.value,
              label: t(`rd.tasks.view.${option.value}`),
              icon: option.icon,
            }))}
            onChange={(value) => {
              if (isTaskLayout(value)) dispatch({ type: 'tasks/layout', layout: value });
            }}
          />
        </Toolbar>
      </header>

      {layout === 'kanban' && rows.length > 0 ? (
        <p className="fw-tasks__note">
          <Icon name="Info" size="xs" />
          {t('rd.tasks.note')}
        </p>
      ) : null}

      <div className="fw-tasks__body fw-scroll">
        {rows.length === 0 ? (
          <EmptyState
            icon="Inbox"
            title={t('rd.tasks.empty.title')}
            detail={t('rd.tasks.empty.detail')}
          />
        ) : layout === 'kanban' ? (
          <div className="fw-tasks-board" aria-label={t('rd.tasks.board')}>
            {TASK_COLUMNS.map((column) => {
              const list = byColumn.get(column) ?? [];
              const meta = COLUMN_META[column];
              const columnLabel = t(`rd.tasks.column.${column}`);
              return (
                <section
                  key={column}
                  ref={registerColumnSection(column)}
                  className="fw-tasks-board__col"
                  aria-label={t('rd.tasks.columnLabel', { column: columnLabel, count: list.length })}
                >
                  <header className="fw-tasks-board__head">
                    <Icon name={meta.icon} size="sm" />
                    <h2 className="fw-tasks-board__title">{columnLabel}</h2>
                    <span className="fw-tasks-board__count fw-tasks-num">{list.length}</span>
                  </header>

                  <ul className="fw-tasks-board__cards fw-scroll">
                    {list.map((row) => (
                      <TaskCard key={row.task.id} {...cardProps(row)} />
                    ))}
                    {list.length === 0 ? (
                      <li className="fw-tasks-board__empty">{t('rd.tasks.columnEmpty')}</li>
                    ) : null}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : layout === 'table' ? (
          <div className="fw-tasks-table-shell">
            <div className="fw-tasks-table__mobile-sort">
              <label className="fw-tasks-table__sort-label" htmlFor="fw-tasks-sort">
                {t('rd.tasks.sortBy')}
              </label>
              <select
                id="fw-tasks-sort"
                className="fw-tasks-table__select"
                value={sortKey}
                onChange={handleSortSelect}
              >
                {TABLE_COLUMNS.map((column) => (
                  <option key={column.key} value={column.key}>
                    {t(`rd.tasks.th.${column.key}`)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                icon={sortDir === 'asc' ? 'ArrowUp' : 'ArrowDown'}
                onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
              >
                {sortDir === 'asc' ? t('rd.tasks.ascending') : t('rd.tasks.descending')}
              </Button>
            </div>

            <div className="fw-tasks-table-wrap">
              <table className="fw-tasks-table">
                <caption className="fw-visually-hidden">
                  Every task on this board, one row per task.
                </caption>
                <thead>
                  <tr>
                    {TABLE_COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={
                          sortKey === column.key
                            ? sortDir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button
                          type="button"
                          className="fw-tasks-table__sort"
                          onClick={() => toggleSort(column.key)}
                        >
                          <span>{t(`rd.tasks.th.${column.key}`)}</span>
                          <Icon
                            name={
                              sortKey === column.key
                                ? sortDir === 'asc'
                                  ? 'ArrowUp'
                                  : 'ArrowDown'
                                : 'ChevronsUpDown'
                            }
                            size="xs"
                          />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const { task } = row;
                    const selected = task.id === selectedId;
                    return (
                      <tr key={task.id} className={selected ? 'is-selected' : undefined}>
                        <td data-label={t('rd.tasks.th.id')}>
                          <Machine muted>{task.id}</Machine>
                        </td>
                        <td data-label={t('rd.tasks.th.title')}>
                          <button
                            type="button"
                            className="fw-tasks-table__hit"
                            aria-pressed={selected}
                            onClick={() => select(task.id)}
                          >
                            {task.title}
                          </button>
                          <VerdictChip task={task} />
                        </td>
                        <td data-label={t('rd.tasks.th.status')}>
                          <StatusBadge status={task.status} size="sm" />
                          <StalledFlag task={task} />
                        </td>
                        <td data-label={t('rd.tasks.th.column')}>
                          <span className="fw-tasks-quiet">{t(`rd.tasks.column.${row.column}`)}</span>
                          <ColumnFallbackFlag row={row} />
                        </td>
                        <td data-label={t('rd.tasks.th.phase')}>
                          <span className="fw-tasks-quiet">{t(`rd.tasks.phase.${task.phase}`)}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.agent')}>
                          <span className="fw-tasks-quiet">{row.agentName}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.wp')}>
                          <span className="fw-tasks-quiet">{row.wpLabel}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.progress')}>
                          <Meter
                            value={task.progress}
                            tone={task.status === 'running' ? 'accent' : 'default'}
                            showValue
                          />
                        </td>
                        <td data-label={t('rd.tasks.th.proof')} className="fw-tasks-table__num">
                          <span className="fw-tasks-quiet fw-tasks-num">{task.proofCount}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.repairs')} className="fw-tasks-table__num">
                          <span className="fw-tasks-quiet fw-tasks-num">{task.repairAttempts}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.deps')}>
                          <Machine muted>
                            {task.dependencies.length > 0 ? task.dependencies.join(', ') : '—'}
                          </Machine>
                        </td>
                        <td data-label={t('rd.tasks.th.created')}>
                          <span className="fw-tasks-quiet fw-tasks-num">{task.createdAt}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.updated')}>
                          <span className="fw-tasks-quiet fw-tasks-num">{task.updatedAt}</span>
                        </td>
                        <td data-label={t('rd.tasks.th.detail')} className="fw-tasks-table__detail">
                          <span title={task.detail}>{task.detail}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : layout === 'work-packages' ? (
          <div className="fw-tasks-wps">
            {state.data.workPackages.map((pkg) => {
              const list = workPackageRows(pkg);
              const owner = agentNames.get(pkg.ownerAgentId) ?? pkg.ownerAgentId;
              return (
                <Panel
                  key={pkg.id}
                  className="fw-tasks-wp"
                  title={pkg.title}
                  subtitle={pkg.goal}
                  actions={<StatusBadge status={pkg.status} size="sm" />}
                >
                  <div className="fw-tasks-wp__facts">
                    <span className="fw-tasks-wp__fact">
                      <span className="fw-tasks-label">{t('rd.tasks.pkg.owner')}</span>
                      <span>{owner}</span>
                    </span>
                    <span className="fw-tasks-wp__fact">
                      <span className="fw-tasks-label">{t('rd.tasks.pkg.phase')}</span>
                      <span>{t(`rd.tasks.phase.${pkg.phase}`)}</span>
                    </span>
                    <span className="fw-tasks-wp__fact">
                      <span className="fw-tasks-label">{t('rd.tasks.pkg.tasks')}</span>
                      <span className="fw-tasks-num">{list.length}</span>
                    </span>
                    <span className="fw-tasks-wp__fact">
                      <span className="fw-tasks-label">{t('rd.tasks.pkg.id')}</span>
                      <Machine muted>{pkg.id}</Machine>
                    </span>
                  </div>

                  <section className="fw-tasks-wp__section">
                    <header className="fw-tasks-wp__section-head">
                      <span className="fw-tasks-label">{t('rd.tasks.pkg.acceptance')}</span>
                      <ExampleTag detail="Example acceptance criteria. Nothing was evaluated — the marks follow the work package's example status." />
                    </header>
                    <ul className="fw-tasks-wp__acceptance">
                      {pkg.acceptance.map((line) => (
                        <li key={line} className="fw-tasks-wp__criterion">
                          <Icon
                            name={pkg.status === 'completed' ? 'CircleCheck' : 'Circle'}
                            size="xs"
                          />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className="fw-tasks-wp__section">
                    <header className="fw-tasks-wp__section-head">
                      <span className="fw-tasks-label">{t('rd.tasks.pkg.tasks')}</span>
                    </header>
                    {list.length === 0 ? (
                      <p className="fw-tasks-empty-line">{t('rd.tasks.pkg.noTasks')}</p>
                    ) : (
                      <ul className="fw-tasks-rows">
                        {list.map((row) => (
                          <TaskRow key={row.task.id} {...rowProps(row)} />
                        ))}
                      </ul>
                    )}
                  </section>
                </Panel>
              );
            })}
          </div>
        ) : (
          <div className="fw-tasks-phases">
            {PHASES.map((phase) => {
              const list = byPhase.get(phase) ?? [];
              const meta = PHASE_META[phase];
              return (
                <section
                  key={phase}
                  className="fw-tasks-phase"
                  aria-labelledby={`tasks-phase-${phase}`}
                >
                  <header className="fw-tasks-phase__head">
                    <span className="fw-tasks-phase__glyph">
                      <Icon name={meta.icon} size="sm" />
                    </span>
                    <h2 id={`tasks-phase-${phase}`} className="fw-tasks-phase__title">
                      {t(`rd.tasks.phase.${phase}`)}
                    </h2>
                    <span className="fw-tasks-phase__count fw-tasks-num">{list.length}</span>
                    <p className="fw-tasks-phase__note">{t(`rd.tasks.phaseNote.${phase}`)}</p>
                  </header>
                  {list.length === 0 ? (
                    <p className="fw-tasks-empty-line">{t('rd.tasks.phaseEmpty')}</p>
                  ) : (
                    <ul className="fw-tasks-rows">
                      {list.map((row) => (
                        <TaskRow key={row.task.id} {...rowProps(row)} />
                      ))}
                    </ul>
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
