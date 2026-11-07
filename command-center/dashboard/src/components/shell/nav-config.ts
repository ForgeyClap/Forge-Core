/**
 * Forge Workspace — the shell nav model.
 *
 * The table of destinations lives in its own module because two components read
 * it: Sidebar renders it, and Topbar looks the current path up in it to title
 * the view. Keeping the table in one place keeps those two honest with each
 * other.
 *
 * It is a separate file rather than a section of Sidebar.tsx for a second,
 * mechanical reason: a module that exports both a component and a constant
 * cannot be hot-reloaded by React Fast Refresh, and the linter says so. Nothing
 * in this file is a component and nothing in it reads state — it is data. The
 * labels are i18n keys resolved at read time (WP B0b).
 */

import { t } from '@/i18n';
import type { UiMode } from '@/state/ui-mode';
import { IS_DIST_BUILD } from '@/build-flags';

export interface ShellNavItem {
  readonly path: string;
  /** Translated at read time, so it always follows the current locale (see `@/i18n`). */
  readonly label: string;
  /** lucide icon name. */
  readonly icon: string;
  /** One short line, used for the rail tooltip and the topbar title attribute. */
  readonly description: string;
}

/** The nav ids, each with a `nav.<id>.label` and `nav.<id>.description` key in the locale files. */
type NavId =
  | 'home'
  | 'projects'
  | 'chat'
  | 'team'
  | 'onboarding'
  | 'mission'
  | 'agents'
  | 'tasks'
  | 'artifacts'
  | 'tests'
  | 'activity'
  | 'discord'
  | 'settings'
  | 'project'
  | 'files'
  | 'mindmap'
  | 'accounts'
  | 'theme'
  | 'jobs'
  | 'automations'
  | 'skills';

/**
 * One nav entry. `label` and `description` are getters so the table stays plain data while the
 * text follows the locale; a component that renders them calls `useLocale()` to re-render on a
 * switch.
 */
function navItem(id: NavId, path: string, icon: string): ShellNavItem {
  return {
    path,
    icon,
    get label() {
      return t(`nav.${id}.label`);
    },
    get description() {
      return t(`nav.${id}.description`);
    },
  };
}

/** The primary destinations, in the order they are worked through. */
export const PRIMARY_NAV: readonly ShellNavItem[] = [
  navItem('home', '/', 'House'),
  navItem('projects', '/projects', 'Folder'),
  navItem('chat', '/chat', 'MessagesSquare'),
  navItem('team', '/team', 'Users'),
  // WP B5: the three Uitgebreid screens of plan §4.2 that had no screen until now.
  navItem('jobs', '/jobs', 'ClipboardCheck'),
  navItem('automations', '/automations', 'Workflow'),
  // BRAND.md forbids sparkle/star icons for AI; blocks reads as "what the team can do".
  navItem('skills', '/skills', 'Blocks'),
  navItem('mission', '/mission', 'Network'),
  navItem('tasks', '/tasks', 'ListChecks'),
  navItem('artifacts', '/artifacts', 'FileStack'),
  navItem('tests', '/tests', 'FlaskConical'),
  navItem('activity', '/activity', 'Activity'),
  navItem('discord', '/discord', 'PlugZap'),
  navItem('settings', '/settings', 'Settings'),
];

/** Secondary destinations. Reachable, but not part of the daily path. */
export const SECONDARY_NAV: readonly ShellNavItem[] = [
  navItem('project', '/project', 'FolderOpen'),
  navItem('files', '/files', 'FolderTree'),
  navItem('mindmap', '/mindmap', 'Map'),
];

/**
 * Routes that never get a sidebar entry (see NAV_VISIBILITY below: 'hidden'). They stay routable and
 * stay in ALL_NAV so the topbar can still title them when opened from a link.
 */
export const HIDDEN_NAV: readonly ShellNavItem[] = [
  navItem('agents', '/agents', 'Bot'),
  // WP B5 (B7a): the account-rotation screen is not in the distributed build, so no destination either.
  // The literal flag (not isFeatureShipped('...')) so the feature name itself never reaches the dist bundle.
  ...(IS_DIST_BUILD ? [] : [navItem('accounts', '/accounts', 'Gauge')]),
  navItem('theme', '/theme', 'Palette'),
  // WP B6: the first-start wizard is a flow, not a destination; listed only so the topbar can title it.
  navItem('onboarding', '/onboarding', 'Rocket'),
];

/**
 * Redesign (1C): Leer Forge, the fourth Eenvoudig destination of DESIGN.md §2. Its words are the
 * `rd.nav.learn` and `rd.nav.learnDescription` locale keys, read at access time like the rest of the table.
 */
export const LEARN_NAV: ShellNavItem = {
  path: '/learn',
  icon: 'GraduationCap',
  get label() {
    return t('rd.nav.learn');
  },
  get description() {
    return t('rd.nav.learnDescription');
  },
};

export const ALL_NAV: readonly ShellNavItem[] = [...PRIMARY_NAV, LEARN_NAV, ...SECONDARY_NAV, ...HIDDEN_NAV];

/**
 * Where a destination shows in the sidebar (WP B4, plan §4.2 / PRODUCT-CARD.md "Eenvoudig en
 * Uitgebreid"):
 *   - 'always'   — Eenvoudig and Uitgebreid: Start (the chat home), Gesprekken, Mijn projecten,
 *                  Instellingen.
 *   - 'advanced' — Uitgebreid only: Team, Klussen & bewijs (/jobs), Automatiseringen, Vaardigheden,
 *                  Activiteit, Taken, Klusverloop (/mission), plus the existing screens the table does
 *                  not name (Controles = /tests, Opgeleverd, Discord, Projectoverzicht, Bestanden,
 *                  Mindmap), so the owner's daily view loses nothing.
 *   - 'hidden'   — never in the sidebar, the route stays reachable: /agents (the roster; the Team
 *                  screen replaces its nav entry and links to it, so the sidebar never shows two
 *                  entries called "Team"), /theme (design reference, internal) and /accounts
 *                  (account rotation).
 * WP B5 added /jobs, /automations and /skills (all 'advanced'). A path missing from this table is
 * 'advanced': visible to the owner, never to a beginner.
 */
export type NavVisibility = 'always' | 'advanced' | 'hidden';

const NAV_VISIBILITY: Readonly<Record<string, NavVisibility>> = {
  '/': 'always',
  '/chat': 'always',
  '/projects': 'always',
  '/settings': 'always',
  '/learn': 'always',
  '/team': 'advanced',
  '/jobs': 'advanced',
  '/automations': 'advanced',
  '/skills': 'advanced',
  '/tests': 'advanced',
  '/activity': 'advanced',
  '/tasks': 'advanced',
  '/mission': 'advanced',
  '/artifacts': 'advanced',
  '/discord': 'advanced',
  '/project': 'advanced',
  '/files': 'advanced',
  '/mindmap': 'advanced',
  '/agents': 'hidden',
  '/theme': 'hidden',
  '/accounts': 'hidden',
  '/onboarding': 'hidden',
};

export function navVisibility(path: string): NavVisibility {
  return NAV_VISIBILITY[path] ?? 'advanced';
}

export function isNavVisible(path: string, mode: UiMode): boolean {
  const visibility = navVisibility(path);
  if (visibility === 'always') return true;
  if (visibility === 'hidden') return false;
  return mode === 'uitgebreid';
}

/** The primary destinations the sidebar shows in `mode`. */
export function primaryNavFor(mode: UiMode): readonly ShellNavItem[] {
  return PRIMARY_NAV.filter((item) => isNavVisible(item.path, mode));
}

/** The secondary destinations the sidebar shows in `mode` (none in Eenvoudig). */
export function secondaryNavFor(mode: UiMode): readonly ShellNavItem[] {
  return SECONDARY_NAV.filter((item) => isNavVisible(item.path, mode));
}

/** The paths that sit in the sidebar foot instead of the main list (DESIGN.md §2: Leer Forge, Instellingen). */
const FOOT_PATHS: readonly string[] = ['/learn', '/settings'];

export interface SidebarSections {
  /** The top list: Start, Mijn projecten, Gesprekken. */
  readonly main: readonly ShellNavItem[];
  /** Uitgebreid only: the other screens, under a hairline. Empty in Eenvoudig. */
  readonly advanced: readonly ShellNavItem[];
  /** The foot: Leer Forge, then Instellingen. */
  readonly foot: readonly ShellNavItem[];
}

/**
 * How the redesigned sidebar groups the destinations of `mode` (DESIGN.md §2). The destination lists
 * themselves (`primaryNavFor`, `secondaryNavFor`) are unchanged; this only decides where each one sits.
 */
export function sidebarSectionsFor(mode: UiMode): SidebarSections {
  const primary = primaryNavFor(mode);
  const settings = primary.find((item) => item.path === '/settings');
  return {
    main: primary.filter((item) => navVisibility(item.path) === 'always' && !FOOT_PATHS.includes(item.path)),
    advanced: [
      ...primary.filter((item) => navVisibility(item.path) !== 'always'),
      ...secondaryNavFor(mode),
    ],
    foot: settings ? [LEARN_NAV, settings] : [LEARN_NAV],
  };
}
