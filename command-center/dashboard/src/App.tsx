/**
 * Forge Workspace — routing.
 *
 * HashRouter, deliberately. A built prototype has to open by double-clicking
 * dist/index.html from any folder, on any machine, with no server rewriting
 * paths. That rules out BrowserRouter.
 *
 * Every route renders inside <AppShell>, which owns the chrome: sidebar, bar,
 * side pane, command palette and toasts. A view only ever renders its own
 * content area.
 *
 * WP11 — every view is `React.lazy` + `import()`, one chunk per route. This is
 * a build-level change only: the single ~506 kB entry chunk (Vite's own >500 kB
 * warning) previously shipped every view's code and CSS up front regardless of
 * which route was actually visited. Splitting it means the FIRST paint of any
 * one route now only pays for that route's own chunk, not all thirteen. Vite's
 * async-chunk CSS handling loads a dynamic chunk's stylesheet before the chunk
 * resolves, so this changes network/parse timing only — never a rendered pixel
 * (see mission/visual-review/WP11-a11y-perf-report.md for the before/after
 * screenshot proof). The Suspense fallback reuses the design system's existing
 * EmptyState primitive (compact) rather than inventing a new loading look — the
 * app had no prior Suspense boundary to preserve, and on the same-origin local
 * gateway a chunk fetch resolves before a human eye or a settled screenshot
 * would ever catch it rendered.
 */

import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import AppShell from '@/components/shell/AppShell';
import { FirstRunRedirect } from '@/views/onboarding/FirstRunRedirect';
import { RouteFallback } from '@/components/shell/RouteFallback';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import { IS_DIST_BUILD } from '@/build-flags';

// WP B5: the account-rotation screen is development-only; the distributed build never loads it
// (src/build-flags.ts, scripts/dist-strip.mjs). The literal flag lets Rollup drop the import.
const AccountRotationView = IS_DIST_BUILD ? null : lazy(() => import('@/views/accounts/AccountRotationView'));
const ActivityView = lazy(() => import('@/views/activity/ActivityView'));
const AgentsView = lazy(() => import('@/views/agents/AgentsView'));
const AutomationsView = lazy(() => import('@/views/automations/AutomationsView'));
const ArtifactsView = lazy(() => import('@/views/artifacts/ArtifactsView'));
const ChatView = lazy(() => import('@/views/chat/ChatView'));
const DiscordView = lazy(() => import('@/views/discord/DiscordView'));
const FilesView = lazy(() => import('@/views/files/FilesView'));
const HomeView = lazy(() => import('@/views/home/HomeView'));
const JobsView = lazy(() => import('@/views/jobs/JobsView'));
// Redesign 1C: Leer Forge (DESIGN.md §3.6). A stub until part 2D fills it.
const LearnView = lazy(() => import('@/views/learn/LearnView'));
const MindMapView = lazy(() => import('@/views/mindmap/MindMapView'));
const MissionControlView = lazy(() => import('@/views/mission/MissionControlView'));
const ProjectOverviewView = lazy(() => import('@/views/projects/ProjectOverviewView'));
const OnboardingView = lazy(() => import('@/views/onboarding/OnboardingView'));
const ProjectsView = lazy(() => import('@/views/projects/ProjectsView'));
const SettingsView = lazy(() => import('@/views/settings/SettingsView'));
const SkillsView = lazy(() => import('@/views/skills/SkillsView'));
const TasksView = lazy(() => import('@/views/tasks/TasksView'));
const TeamView = lazy(() => import('@/views/team/TeamView'));
const TestsView = lazy(() => import('@/views/tests/TestsView'));
const ThemeShowcaseView = lazy(() => import('@/views/theme/ThemeShowcaseView'));

// WP B3-copy: the Suspense fallback is `RouteFallback` (Dutch via t(), an honest end state after
// 8 s and an immediate one when the gateway link is down) instead of the old "Loading view…" line.

export default function App() {
  return (
    <PrototypeProvider>
      <HashRouter>
        <AppShell>
          {/* WP B6: sends a first start without a working Claude Code to /onboarding (never when the gateway is silent). */}
          <FirstRunRedirect />
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomeView />} />
              <Route path="/projects" element={<ProjectsView />} />
              <Route path="/project" element={<ProjectOverviewView />} />
              <Route path="/chat" element={<ChatView />} />
              <Route path="/mission" element={<MissionControlView />} />
              <Route path="/agents" element={<AgentsView />} />
              <Route path="/team" element={<TeamView />} />
              <Route path="/jobs" element={<JobsView />} />
              <Route path="/automations" element={<AutomationsView />} />
              <Route path="/skills" element={<SkillsView />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/files" element={<FilesView />} />
              <Route path="/mindmap" element={<MindMapView />} />
              {AccountRotationView && <Route path="/accounts" element={<AccountRotationView />} />}
              <Route path="/artifacts" element={<ArtifactsView />} />
              <Route path="/tests" element={<TestsView />} />
              <Route path="/activity" element={<ActivityView />} />
              <Route path="/discord" element={<DiscordView />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="/learn" element={<LearnView />} />
              <Route path="/onboarding" element={<OnboardingView />} />
              <Route path="/theme" element={<ThemeShowcaseView />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AppShell>
      </HashRouter>
    </PrototypeProvider>
  );
}
