/**
 * Settings — one page (WP B6, plan §4.6; v1.0 redesign DESIGN.md §3.4, mockups/04-instellingen-*.png).
 *
 * Header: "Instellingen" on the left and the Eenvoudig | Uitgebreid switch on the right, so the mode is
 * found where people look for it. Left: the list of groups (Algemeen, Accounts, Veiligheid, Privacy;
 * Uitgebreid adds Modellen, Gebruik, Koppelingen, Mappen, Diagnose and Over Forge under a hairline). It
 * marks the group in view (`group-in-view.ts`) and scrolls to a group on click; below 1000 px it becomes a row of tabs.
 * Uitgebreid also has Eigen API as its own group right after Accounts (DESIGN.md §3.4, fix round XR-SET): it
 * has no entry in the list, which marks Accounts while it is in view. Its list is drawn by AccountsSection
 * (it shares that section's lists) into this group's body through `OwnApiSlotContext`.
 * Rows sit grouped in one surface with hairlines: a name, at most one sub-line, the control on the
 * right, and the "Wat merk je ervan" line behind "Meer info". There is no port field anywhere in
 * Eenvoudig, and nothing that only looks like a control: what cannot work yet is grey with its reason.
 *
 * Headings: the page title is the one h1 ("Instellingen"; the bar draws no title on pages that have
 * their own, DESIGN.md §2), groups are h2, the blocks inside Accounts are h3.
 *
 * The model of the page (groups, rows, the mapping from the twelve old sections) lives in
 * `settings-model.ts`; the rows themselves in `sections/`. The old screen survives only as a
 * developer view (`LegacySettingsView.tsx`, behind `isLegacySettingsEnabled()`).
 */

import { Fragment, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { SegmentedControl } from '@/components/primitives';
import { useCheckup } from '@/components/checkup/use-checkup';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { useLocale } from '@/i18n/use-locale';
import { useUiMode } from '@/state/ui-mode';

import { isLegacySettingsEnabled, listEntryOf, listedGroups, readDesktopBridge, visibleGroups, visibleRows } from './settings-model';
import type { DesktopBridge, GroupId, RowDef } from './settings-model';
import { AccountsSection } from './sections/AccountsSection';
import { AppRouterSection, ROUTER_SECTION_ID } from './sections/app-router/AppRouterSection';
import { OwnApiSlotContext } from './sections/own-api-slot';
import { DensityRow, DesktopToggleRow, LanguageRow, MotionRow, StartCardRow, ThemeRow, TourRow, ViewModeRow } from './sections/GeneralRows';
import { FolderAccessRow, PermissionModeRow, SafetyLocksPanel } from './sections/SafetyRows';
import { ExportRow, WhereRow, WipeRow } from './sections/PrivacyRows';
import { DiagnoseRow, LimitRow, PathsRow, RolesRow, SkillsRow, SmartScreenRow, UpdatesRow, VersionRow } from './sections/AdvancedRows';
import { useGroupInView } from './group-in-view';
import { useGatewayPaths } from './use-gateway-paths';
import type { GatewayPaths } from './use-gateway-paths';

import './settings-page.css';

const LegacySettingsView = lazy(() => import('./LegacySettingsView'));

/** Groups whose content brings its own blocks (account lists, the router, the Eigen API list, the pc check). */
const OWN_LAYOUT: ReadonlySet<GroupId> = new Set(['accounts', 'eigenapi', 'diagnose']);

/** Frames the scroll-spy tries to find the router before it gives up (it mounts after its own read). */
const ROUTER_SCROLL_FRAMES = 120;

interface RowContext {
  readonly bridge: DesktopBridge | null;
  readonly checkup: CheckupController;
  readonly paths: GatewayPaths;
  readonly onShowDiagnose?: () => void;
  /** Receives the body of the Eigen API group, where AccountsSection draws that list. */
  readonly onOwnApiSlot: (node: HTMLElement | null) => void;
}

function renderRow(row: RowDef, context: RowContext): ReactNode {
  switch (row.id) {
    case 'taal':
      return <LanguageRow />;
    case 'thema':
      return <ThemeRow />;
    case 'weergave':
      return <ViewModeRow />;
    case 'rondleiding':
      // "Start hier opnieuw tonen" sits next to the tour replay; each shows only when it works.
      return (
        <>
          <TourRow />
          <StartCardRow />
        </>
      );
    case 'opstarten':
    case 'systeemvak':
      return context.bridge ? <DesktopToggleRow id={row.id} bridge={context.bridge} /> : null;
    case 'dichtheid':
      return <DensityRow />;
    case 'beweging':
      return <MotionRow />;
    case 'accounts':
      return <AccountsSection checkup={context.checkup} onShowDiagnose={context.onShowDiagnose} />;
    case 'router':
      return <AppRouterSection />;
    case 'eigenapi':
      return <div className="fs-set__ownapi" ref={context.onOwnApiSlot} />;
    case 'sloten':
      return <SafetyLocksPanel />;
    case 'modus':
      return <PermissionModeRow />;
    case 'map':
      return <FolderAccessRow />;
    case 'waar':
      return <WhereRow paths={context.paths} />;
    case 'exporteren':
      return <ExportRow />;
    case 'wissen':
      return <WipeRow />;
    case 'rollen':
      return <RolesRow />;
    case 'limiet':
      return <LimitRow />;
    case 'vaardigheden':
      return <SkillsRow />;
    case 'paden':
      return <PathsRow paths={context.paths} />;
    case 'diagnose':
      return <DiagnoseRow checkup={context.checkup} bridge={context.bridge} />;
    case 'versie':
      return <VersionRow bridge={context.bridge} />;
    case 'updates':
      return <UpdatesRow bridge={context.bridge} />;
    case 'smartscreen':
      return <SmartScreenRow />;
    default:
      return null;
  }
}

/** `#/settings?focus=router` (the chat's limit card and Leer Forge link here): scroll the router into view. */
function useFocusRouter(focus: string | null): void {
  useEffect(() => {
    if (focus !== 'router') return undefined;
    let frames = 0;
    let handle = 0;
    const tryScroll = () => {
      const node = document.getElementById(ROUTER_SECTION_ID);
      if (node) {
        node.scrollIntoView({ block: 'start' });
        return;
      }
      frames += 1;
      if (frames < ROUTER_SCROLL_FRAMES) handle = window.requestAnimationFrame(tryScroll);
    };
    handle = window.requestAnimationFrame(tryScroll);
    return () => window.cancelAnimationFrame(handle);
  }, [focus]);
}

export default function SettingsView() {
  const { t } = useLocale();
  const { mode, isAdvanced, setUiMode } = useUiMode();
  const bridge = useMemo(() => readDesktopBridge(), []);
  const checkup = useCheckup(null, true);
  const paths = useGatewayPaths();
  const { search } = useLocation();
  useFocusRouter(new URLSearchParams(search).get('focus'));

  const rows = visibleRows(isAdvanced, bridge);
  const groups = visibleGroups(isAdvanced);
  const listed = listedGroups(groups);
  const [activeGroup, setActiveGroup] = useState<GroupId | null>(null);
  const [ownApiSlot, setOwnApiSlot] = useState<HTMLElement | null>(null);
  const [pinnedGroup, setPinnedGroup] = useState<GroupId | null>(null);
  useGroupInView(groups.map((group) => group.id).join(','), setActiveGroup, pinnedGroup, setPinnedGroup);

  function scrollToGroup(id: GroupId) {
    setPinnedGroup(id);
    document.getElementById(`fs-group-${id}`)?.scrollIntoView({ block: 'start' });
    setActiveGroup(id);
  }

  const context: RowContext = {
    bridge,
    checkup,
    paths,
    // Uitgebreid has its own Diagnose group: "Controleer of alles werkt" jumps there.
    onShowDiagnose: isAdvanced ? () => window.requestAnimationFrame(() => scrollToGroup('diagnose')) : undefined,
    onOwnApiSlot: setOwnApiSlot,
  };
  const current = activeGroup !== null ? listEntryOf(activeGroup) : (listed[0]?.id ?? null);

  return (
    <div className="fs-set" role="region" aria-labelledby="fs-set-title" data-mode={mode}>
      <header className="fs-set__head">
        <h1 id="fs-set-title" className="fs-set__title">
          {t('rd.settings.title')}
        </h1>
        <SegmentedControl
          className="fs-set__mode"
          label={t('rd.settings.general.view')}
          value={mode}
          onChange={(next) => setUiMode(next === 'uitgebreid' ? 'uitgebreid' : 'eenvoudig')}
          options={[
            { value: 'eenvoudig', label: t('rd.settings.simple') },
            { value: 'uitgebreid', label: t('rd.settings.advanced') },
          ]}
        />
      </header>

      <div className="fs-set__layout">
        <nav className="fs-set__toc" aria-label={t('settingsPage.groupsLabel')}>
          {listed.map((group, index) => (
            <Fragment key={group.id}>
              {group.advanced && !listed[index - 1]?.advanced ? <hr className="fs-set__toc-sep" /> : null}
              <a
                href={`#fs-group-${group.id}`}
                className="fs-set__toc-link"
                aria-current={current === group.id ? 'true' : undefined}
                onClick={(event) => {
                  // HashRouter owns the hash: scroll instead of navigating.
                  event.preventDefault();
                  scrollToGroup(group.id);
                }}
              >
                {t(group.label)}
              </a>
            </Fragment>
          ))}
        </nav>

        <OwnApiSlotContext.Provider value={ownApiSlot}>
          <div className="fs-set__groups">
            {groups.map((group) => {
              const body = rows
                .filter((row) => row.group === group.id)
                .map((row) => <Fragment key={row.id}>{renderRow(row, context)}</Fragment>);
              const headingId = `fs-group-${group.id}-h`;
              // Accounts carries its own block headings ("Je accounts", "Als je limiet op is"); Eigen API has its own group.
              const ownHeadings = group.id === 'accounts';
              return (
                <section key={group.id} id={`fs-group-${group.id}`} className="fs-set__group" data-group={group.id} aria-labelledby={headingId}>
                  <h2 id={headingId} className={ownHeadings ? 'fw-visually-hidden' : 'fs-set__group-title'}>
                    {t(group.label)}
                  </h2>
                  {OWN_LAYOUT.has(group.id) ? <div className="fs-set__stack">{body}</div> : <div className="fs-set__rows">{body}</div>}
                </section>
              );
            })}
            {isLegacySettingsEnabled() ? (
              <Suspense fallback={null}>
                <LegacySettingsView />
              </Suspense>
            ) : null}
          </div>
        </OwnApiSlotContext.Provider>
      </div>
    </div>
  );
}
