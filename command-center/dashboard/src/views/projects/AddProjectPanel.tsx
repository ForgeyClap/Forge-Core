/**
 * Project toevoegen (WP B5, plan §3.2 / row B5).
 *
 * Two honest routes, both on routes that already exist:
 *   - Nieuw project: `POST /api/projects` (gateway-actions.ts `requestNewProject`) scaffolds a folder
 *     in the Forge projects root and starts the Forge installer from the core Forge runs from; the
 *     outcome is polled from `GET /api/projects/install-status` until it is known.
 *   - Bestaande map: the onboarding folder picker (read-only browse route) with the plan §3.2
 *     guardrails (no drive root, home, Documents root, Windows or program folders). The gateway has
 *     no route that registers an existing folder, so the screen says so ("nog niet gekoppeld") and
 *     shows the exact install command under "Technische details" instead of pretending.
 */

import { useEffect, useState } from 'react';

import { Button, Icon, SegmentedControl } from '@/components/primitives';
import { requestInstallStatus, requestNewProject } from '@/components/shell/gateway-actions';
import type { InstallStatusResult } from '@/components/shell/gateway-actions';
import { useLocale } from '@/i18n/use-locale';
import { FolderStep } from '@/views/onboarding/FolderStep';

import { installCommand, isListedFolder, useForgeRoot } from './project-extras';

const INSTALL_POLL_MS = 3000;
const INSTALL_POLL_LIMIT = 200; // about ten minutes, above the installer's own eight-minute budget

export interface AddProjectPanelProps {
  readonly projectPaths: readonly string[];
  readonly onClose: () => void;
}

type Tab = 'new' | 'existing';

function NewProject() {
  const { t } = useLocale();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallStatusResult | null>(null);

  useEffect(() => {
    if (created === null) return undefined;
    const target = created;
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      const status = await requestInstallStatus(target);
      if (cancelled) return;
      setInstall(status);
      polls += 1;
      if (status.state === 'installing' && polls < INSTALL_POLL_LIMIT) timer = setTimeout(() => void poll(), INSTALL_POLL_MS);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [created]);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    setInstall(null);
    const result = await requestNewProject(name);
    setBusy(false);
    if (result.ok && result.id !== null) setCreated(result.id);
    else setError(result.error ?? '');
  }

  return (
    <form
      className="fw-addproj__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && name.trim() !== '') void create();
      }}
    >
      <p className="fw-addproj__lead">{t('projectsPage.add.newLead')}</p>
      <label className="fw-addproj__field">
        <span>{t('projectsPage.add.nameLabel')}</span>
        <input
          type="text"
          value={name}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('projectsPage.add.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <span className="fw-addproj__hint">{t('projectsPage.add.nameRule')}</span>
      </label>
      <div>
        <Button type="submit" variant="primary" size="sm" icon="Plus" disabled={busy || name.trim() === ''}>
          {busy ? t('projectsPage.add.creating') : t('projectsPage.add.create')}
        </Button>
      </div>
      {error !== null ? (
        <p className="fw-addproj__msg" data-tone="warning" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>
            {t('projectsPage.add.createError', { reason: '' })}
            <span data-log-text>{error}</span>
          </span>
        </p>
      ) : null}
      {created !== null && install !== null ? (
        <p className="fw-addproj__msg" data-tone={install.state === 'installed' ? 'ok' : install.state === 'failed' ? 'warning' : 'busy'} role="status">
          <Icon name={install.state === 'installed' ? 'CircleCheck' : install.state === 'failed' ? 'CircleX' : install.state === 'installing' ? 'Loader' : 'CircleDashed'} size="sm" />
          <span>
            {install.state === 'failed'
              ? t('projectsPage.add.install.failed', { reason: install.reason ?? '—' })
              : t(`projectsPage.add.install.${install.state}`, { name: created })}
          </span>
        </p>
      ) : null}
    </form>
  );
}

function ExistingFolder({ projectPaths }: { readonly projectPaths: readonly string[] }) {
  const { t } = useLocale();
  const [chosen, setChosen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const forgeRoot = useForgeRoot();
  const listed = chosen !== null && isListedFolder(chosen, projectPaths);
  const command = chosen !== null && forgeRoot !== null ? installCommand(forgeRoot, chosen) : null;

  return (
    <div className="fw-addproj__form">
      <p className="fw-addproj__lead">{t('projectsPage.add.existingLead')}</p>
      <FolderStep chosen={chosen} onChoose={(path) => { setChosen(path); setCopied(false); }} />
      {chosen !== null && listed ? (
        <p className="fw-addproj__msg" data-tone="ok" role="status">
          <Icon name="CircleCheck" size="sm" />
          <span>{t('projectsPage.add.alreadyListed')}</span>
        </p>
      ) : null}
      {chosen !== null && !listed ? (
        <div className="fw-addproj__notwired" role="status">
          <p className="fw-addproj__msg" data-tone="warning">
            <Icon name="Unplug" size="sm" />
            <span>{t('projectsPage.add.notWired')}</span>
          </p>
          <details className="fw-addproj__details">
            <summary>{t('projectsPage.add.details')}</summary>
            <p>{t('projectsPage.add.commandLead')}</p>
            {command !== null ? (
              <div className="fw-addproj__command">
                <code data-log-text>{command}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={copied ? 'Check' : 'Copy'}
                  onClick={() => {
                    void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false));
                  }}
                >
                  {copied ? t('projectsPage.add.copied') : t('projectsPage.add.copy')}
                </Button>
              </div>
            ) : (
              <p>{t('projectsPage.add.commandUnknown')}</p>
            )}
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function AddProjectPanel({ projectPaths, onClose }: AddProjectPanelProps) {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>('new');
  return (
    <section className="fw-addproj" aria-labelledby="fw-addproj-title">
      <header className="fw-addproj__head">
        <h2 id="fw-addproj-title">{t('projectsPage.add.title')}</h2>
        <Button variant="quiet" size="sm" icon="X" onClick={onClose}>
          {t('projectsPage.add.close')}
        </Button>
      </header>
      <SegmentedControl
        label={t('projectsPage.add.choiceLabel')}
        size="sm"
        options={[
          { value: 'new', label: t('projectsPage.add.newTab'), icon: 'Plus' },
          { value: 'existing', label: t('projectsPage.add.existingTab'), icon: 'FolderOpen' },
        ]}
        value={tab}
        onChange={(value) => setTab(value === 'existing' ? 'existing' : 'new')}
      />
      {tab === 'new' ? <NewProject /> : <ExistingFolder projectPaths={projectPaths} />}
    </section>
  );
}
