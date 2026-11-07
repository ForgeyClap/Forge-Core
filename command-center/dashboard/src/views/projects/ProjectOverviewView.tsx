/**
 * The project page (DESIGN.md §3.3) for `state.activeProjectId`.
 *
 * A way back to Mijn projecten, the project's name with its status word and at most one helper line,
 * one primary action ("Nieuw gesprek"), then tabs:
 * - Eenvoudig: Gesprekken, Opgeleverd, Bestanden;
 * - Uitgebreid adds Klussen & bewijs (the real runs with a proof link per row), Taken and Plankaart.
 *
 * Gesprekken and Opgeleverd are real lists from the store. Bestanden, Taken and Plankaart point to the
 * screen that owns them (one line and one button) instead of duplicating it, so there is one place to
 * keep honest. Klussen & bewijs embeds the same panel as /jobs.
 */

import '../jobs/xpage.css';
import './project-overview.css';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Icon, Machine, TabPanel, Tabs } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import type { MessageKey } from '@/i18n';
import { selectActiveProject, selectProjectConversations, usePrototype } from '@/prototype/state/prototype-store';
import type { ArtifactKind } from '@/prototype/types/prototype-types';
import { useUiMode } from '@/state/ui-mode';
import { JobsView } from '@/views/jobs/JobsView';
import { relativeWhen } from '@/views/jobs/when';

import { ProjectStatusWord } from './project-status';

/** How many delivered items the tab lists before "Alles bekijken". */
const DELIVERED_LIMIT = 8;

const ARTIFACT_ICON: Readonly<Record<ArtifactKind, string>> = {
  screenshot: 'Image',
  report: 'FileText',
  diagram: 'Workflow',
  markdown: 'FileText',
  log: 'ScrollText',
  receipt: 'ReceiptText',
  proof: 'ShieldCheck',
};

type TabValue = 'chats' | 'delivered' | 'files' | 'jobs' | 'tasks' | 'map';

interface Signpost {
  readonly lead: MessageKey;
  readonly action: MessageKey | MessageKey;
  readonly route: string;
  readonly icon: string;
}

const SIGNPOSTS: Readonly<Partial<Record<TabValue, Signpost>>> = {
  files: { lead: 'nav.files.description', action: 'projectOverview.section.files.action', route: '/files', icon: 'FolderTree' },
  tasks: { lead: 'nav.tasks.description', action: 'projectOverview.section.tasks.action', route: '/tasks', icon: 'ListChecks' },
  map: { lead: 'nav.mindmap.description', action: 'rd.projects.mapAction', route: '/mindmap', icon: 'Map' },
};

export default function ProjectOverviewView() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const { t, locale } = useLocale();
  const { isAdvanced } = useUiMode();
  const [chosen, setChosen] = useState<TabValue>('chats');

  const project = selectActiveProject(state);

  if (!project) {
    return (
      <div className="fw-xpage fw-project">
        <div className="fw-xpage__body">
          <div className="fw-xpage__empty">
            <p>{t('projectOverview.noActiveTitle')}</p>
            <Button variant="secondary" icon="Folder" onClick={() => navigate('/projects')}>
              {t('projectOverview.openBrowser')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const tabs: { value: TabValue; label: string }[] = [
    { value: 'chats', label: t('rd.projects.tabs.chats') },
    { value: 'delivered', label: t('rd.projects.tabs.delivered') },
    { value: 'files', label: t('rd.projects.tabs.files') },
  ];
  if (isAdvanced) {
    tabs.push(
      { value: 'jobs', label: t('rd.projects.tabs.jobs') },
      { value: 'tasks', label: t('rd.projects.tabs.tasks') },
      { value: 'map', label: t('rd.projects.tabs.map') },
    );
  }
  // A Uitgebreid-only tab that was open when the mode switched back falls back to Gesprekken.
  const tab: TabValue = tabs.some((item) => item.value === chosen) ? chosen : 'chats';

  const conversations = selectProjectConversations(state, project.id);
  const artifacts = state.data.artifacts;
  const description = project.description.trim();
  const signpost = SIGNPOSTS[tab];

  function startChat(): void {
    if (project) dispatch({ type: 'project/activate', id: project.id });
    navigate('/');
  }

  return (
    <div className="fw-xpage fw-project">
      <header className="fw-xpage__header fw-project__header">
        <button type="button" className="fw-xpage__crumb" onClick={() => navigate('/projects')}>
          <Icon name="ArrowLeft" size="xs" />
          {t('rd.projects.title')}
        </button>
        <div className="fw-project__head-row">
          <div className="fw-xpage__title">
            <div className="fw-project__title-row">
              <h1>{project.name}</h1>
              <ProjectStatusWord status={project.status} />
            </div>
            {description !== '' ? <p className="fw-project__description">{description}</p> : null}
            {isAdvanced ? (
              <Machine muted className="fw-project__path fw-truncate" title={t('projectOverview.localPath')}>
                {project.path}
              </Machine>
            ) : null}
          </div>
          <Button variant="primary" icon="MessageSquarePlus" onClick={startChat}>
            {t('rd.nav.newChat')}
          </Button>
        </div>
        <Tabs
          items={tabs}
          value={tab}
          onChange={(value) => setChosen(value as TabValue)}
          ariaLabel={t('projectOverview.sectionsLabel')}
          idPrefix="fw-project"
          className="fw-project__tabs"
        />
      </header>

      <div className="fw-xpage__body">
        <TabPanel idPrefix="fw-project" value="chats" active={tab === 'chats'} className="fw-project__panel">
          {conversations.length === 0 ? (
            <div className="fw-xpage__empty">
              <p>{t('rd.projects.chatsEmpty')}</p>
              <Button variant="secondary" icon="MessageSquarePlus" onClick={startChat}>
                {t('rd.nav.newChat')}
              </Button>
            </div>
          ) : (
            <ul className="fw-xlist">
              {conversations.map((conversation) => {
                const when = relativeWhen(conversation.updatedAt, locale);
                return (
                  <li key={conversation.id}>
                    <div className="fw-xrow">
                      <button
                        type="button"
                        className="fw-xrow__main"
                        onClick={() => {
                          dispatch({ type: 'conversation/activate', id: conversation.id });
                          navigate('/chat');
                        }}
                      >
                        <span className="fw-xtile" aria-hidden="true">
                          <Icon name="MessageSquare" size="sm" />
                        </span>
                        <span className="fw-xrow__text">
                          <span className="fw-xrow__name">
                            <span className="fw-xrow__name-text">{conversation.title}</span>
                          </span>
                          <span className="fw-xrow__sub">
                            {conversation.messageCount === 1
                              ? t('projectOverview.messageOne')
                              : t('projectOverview.messages', { count: conversation.messageCount })}
                          </span>
                        </span>
                      </button>
                      <span className="fw-xrow__when" title={conversation.updatedAt}>
                        {when !== '' ? when : conversation.updatedAt}
                      </span>
                      <Icon name="ChevronRight" size="sm" className="fw-xrow__chev" />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </TabPanel>

        <TabPanel idPrefix="fw-project" value="delivered" active={tab === 'delivered'} className="fw-project__panel">
          {artifacts.length === 0 ? (
            <div className="fw-xpage__empty">
              <p>{t('rd.projects.deliveredEmpty')}</p>
            </div>
          ) : (
            <>
              <ul className="fw-xlist">
                {artifacts.slice(0, DELIVERED_LIMIT).map((artifact) => {
                  const when = relativeWhen(artifact.createdAt, locale);
                  return (
                    <li key={artifact.id}>
                      <div className="fw-xrow">
                        <button
                          type="button"
                          className="fw-xrow__main"
                          onClick={() => {
                            dispatch({ type: 'select', selection: { kind: 'artifact', id: artifact.id } });
                            navigate('/artifacts');
                          }}
                        >
                          <span className="fw-xtile" aria-hidden="true">
                            <Icon name={ARTIFACT_ICON[artifact.kind] ?? 'File'} size="sm" />
                          </span>
                          <span className="fw-xrow__text">
                            <span className="fw-xrow__name">
                              <span className="fw-xrow__name-text">{artifact.name}</span>
                            </span>
                            <span className="fw-xrow__sub">{t(`rd.delivered.kind.${artifact.kind}` as MessageKey)}</span>
                          </span>
                        </button>
                        <span className="fw-xrow__when">{when !== '' ? when : artifact.createdAt}</span>
                        <Icon name="ChevronRight" size="sm" className="fw-xrow__chev" />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {artifacts.length > DELIVERED_LIMIT ? (
                <div className="fw-project__more">
                  <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/artifacts')}>
                    {t('rd.projects.deliveredAll')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </TabPanel>

        {tab === 'jobs' ? (
          <TabPanel idPrefix="fw-project" value="jobs" active className="fw-project__panel">
            <JobsView embedded />
          </TabPanel>
        ) : null}

        {signpost !== undefined ? (
          <TabPanel idPrefix="fw-project" value={tab} active className="fw-project__panel">
            <div className="fw-xpage__empty">
              <p>{t(signpost.lead)}</p>
              <Button
                variant="secondary"
                icon={signpost.icon}
                onClick={() => navigate(signpost.route)}
              >
                {signpost.action.startsWith('rd.') ? t(signpost.action as MessageKey) : t(signpost.action as MessageKey)}
              </Button>
            </div>
          </TabPanel>
        ) : null}
      </div>
    </div>
  );
}
