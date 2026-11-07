/**
 * ComposerProjectChip — the project chip in the composer row (DESIGN.md §2 "Composer"): it names the
 * project the next message works in, and lets the user pick another one or start a new one.
 *
 * Every choice is real: picking a project dispatches the same `project/activate` the sidebar uses, and
 * "Nieuw project…" opens the shared `NewProjectDialog` (a real `POST /api/projects`). With no projects
 * at all the chip offers only "Nieuw project…". The full write-scope sentence ("Forge works only in
 * this folder") is the chip's tooltip, so the rule stays one hover away instead of a line of chrome.
 */

import { useState } from 'react';

import { NewProjectDialog } from '@/components/shell/NewProjectDialog';
import { pollProjectInstall } from '@/components/shell/gateway-actions';
import { useLocale } from '@/i18n/use-locale';
import { nextToastId, selectActiveProject, usePrototype } from '@/prototype/state/prototype-store';
import { useGatewayConnection } from '@/prototype/state/gateway-adapter';

import { MenuButton } from './menu-button';
import type { MenuOption } from './menu-button';

const NEW_PROJECT_ID = '\u0000new-project';

export interface ComposerProjectChipProps {
  /** The write-scope sentence, shown as the chip's tooltip. */
  readonly scopeTitle: string;
  /** The connected production path. While its gateway is still connecting and no project list has
   *  arrived yet, the chip shows a quiet placeholder, not "Nieuw project…", which would read as
   *  "you have no projects" (DESIGN.md §4). The connection is read here, not in Composer,
   *  so the large Composer keeps no extra hook (React Compiler memoization). */
  readonly live?: boolean;
}

export function ComposerProjectChip({ scopeTitle, live = false }: ComposerProjectChipProps) {
  const { state, dispatch } = usePrototype();
  const connection = useGatewayConnection();
  const connecting = live && connection.status === 'CONNECTING' && state.data.projects.length === 0;
  const { t } = useLocale();
  const [dialogOpen, setDialogOpen] = useState(false);
  const active = selectActiveProject(state);

  const options: readonly MenuOption[] = [
    ...state.data.projects.map((project) => ({ id: project.id, icon: 'Folder', label: project.name })),
    { id: NEW_PROJECT_ID, icon: 'Plus', label: t('rd.chat.composer.newProject') },
  ];

  function handleCreated(id: string): void {
    setDialogOpen(false);
    dispatch({ type: 'project/activate', id });
    dispatch({
      type: 'toast/push',
      toast: { id: nextToastId(), title: t('home.toast.created'), detail: t('home.toast.installing'), icon: 'Loader' },
    });
    pollProjectInstall(id, (result) => {
      const installed = result.state === 'installed';
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: installed ? t('home.toast.installed') : t('home.toast.installFailed'),
          detail: installed
            ? t('home.toast.installedDetail', { id })
            : (result.reason ?? result.note ?? t('home.toast.installFailedDetail')),
          icon: installed ? 'CircleCheck' : 'TriangleAlert',
        },
      });
    });
  }

  return (
    <div className="fw-chat-composer__project">
      <MenuButton
        icon="Folder"
        label={t('chat.view.activeProject')}
        title={connecting ? t('shell.connection.connecting') : scopeTitle}
        heading=""
        triggerClassName="fw-chat-composer__chip"
        options={options}
        footer=""
        triggerLabel={active ? active.name : connecting ? '…' : t('rd.chat.composer.newProject')}
        selectedId={active?.id ?? ''}
        onPick={(option) => {
          if (option.id === NEW_PROJECT_ID) {
            setDialogOpen(true);
            return;
          }
          dispatch({ type: 'project/activate', id: option.id });
        }}
      />
      <NewProjectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={handleCreated} />
    </div>
  );
}
