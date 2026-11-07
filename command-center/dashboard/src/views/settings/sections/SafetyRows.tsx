/**
 * Veiligheid (WP B6): the fixed safety locks, "Wat mag Forge doen" for the chosen project and the
 * folder Forge works in.
 *
 * - The locks row carries the fixed text from plan §4.6 behind "Meer info". Its status comes from a
 *   live probe only, and that probe does not exist in the app yet, so the row says "Nog niet getest"
 *   and the test button is grey with its reason. No green tick is drawn from configuration text.
 * - "Mag aanpassen / Alleen plannen" writes the composer's own per-project choice
 *   (`views/chat/mode-storage.ts`), so the next conversation in that project starts with it. A
 *   different current choice (Eerst vragen, Volledige toegang) is named, not hidden.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, SegmentedControl } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { selectActiveProject, usePrototype } from '@/prototype/state/prototype-store';
import type { ChatSendMode } from '@/prototype/state/chat-send';
import { modeStorageKey, persist, readStoredMode } from '@/views/chat/mode-storage';

import { SettingRow } from '../SettingRow';

export function SafetyLocksPanel() {
  const { t } = useLocale();
  return (
    <SettingRow
      rowId="sloten"
      title={t('settingsPage.rows.sloten.title')}
      note={
        <span className="fs-pill" data-tone="off">
          <span className="fs-pill__dot" aria-hidden="true" />
          {t('settingsPage.rows.sloten.notTested')}
        </span>
      }
      feel={
        <>
          {t('settingsPage.rows.sloten.text')} <span id="fs-locks-later">{t('settingsPage.rows.sloten.testLater')}</span>
        </>
      }
      control={
        <Button size="sm" variant="secondary" disabled aria-describedby="fs-locks-later">
          {t('settingsPage.rows.sloten.testNow')}
        </Button>
      }
    />
  );
}

const SIMPLE_MODES: readonly ChatSendMode[] = ['accept-edits', 'plan'];

export function PermissionModeRow() {
  const { t } = useLocale();
  const { state } = usePrototype();
  const projectId = state.activeProjectId;
  const project = selectActiveProject(state);
  const [mode, setMode] = useState<ChatSendMode>(() => readStoredMode(projectId));
  const [forProject, setForProject] = useState(projectId);
  // Re-read when the chosen project changes (render-time reset, no effect needed).
  if (forProject !== projectId) {
    setForProject(projectId);
    setMode(readStoredMode(projectId));
  }

  const hasProject = projectId !== '';
  const isSimple = SIMPLE_MODES.includes(mode);
  const currentName = mode === 'execute' ? t('settingsPage.rows.modus.execute') : t('settingsPage.rows.modus.bypass');

  let note: string;
  if (!hasProject) note = t('settingsPage.rows.modus.noProject');
  else if (!isSimple) note = `${t('settingsPage.rows.modus.current', { mode: currentName })} ${t('settingsPage.rows.modus.project', { name: project?.name ?? projectId })}`;
  else note = t('settingsPage.rows.modus.project', { name: project?.name ?? projectId });

  return (
    <SettingRow
      rowId="modus"
      title={t('settingsPage.rows.modus.title')}
      feel={t('settingsPage.rows.modus.feel')}
      note={note}
      control={
        hasProject ? (
          <SegmentedControl
            label={t('settingsPage.rows.modus.title')}
            size="sm"
            value={isSimple ? mode : ''}
            onChange={(next) => {
              const chosen = next === 'plan' ? 'plan' : 'accept-edits';
              persist(modeStorageKey(projectId), chosen);
              setMode(readStoredMode(projectId));
            }}
            options={[
              { value: 'accept-edits', label: t('settingsPage.rows.modus.edit') },
              { value: 'plan', label: t('settingsPage.rows.modus.plan') },
            ]}
          />
        ) : null
      }
    />
  );
}

export function FolderAccessRow() {
  const { t } = useLocale();
  const { state } = usePrototype();
  const navigate = useNavigate();
  const project = selectActiveProject(state);
  return (
    <SettingRow
      rowId="map"
      title={t('settingsPage.rows.map.title')}
      feel={t('settingsPage.rows.map.feel')}
      note={project ? <span className="fs-set__path">{project.path}</span> : t('settingsPage.rows.map.none')}
      control={
        <Button size="sm" variant="secondary" onClick={() => navigate('/projects')}>
          {t('settingsPage.rows.map.choose')}
        </Button>
      }
    />
  );
}
