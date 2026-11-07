/**
 * ProjectsDirSection — "Projects folder".
 *
 * The owner's own words: "In Discord in the Command Center we also want to set the project
 * folder too, so it automatically makes channels for us. It can do this already, but only in one
 * specific folder that is already in there. The user must be able to do this too, and the
 * handiest way is via the Command Center."
 *
 * Shown inside `DiscordView.tsx` regardless of wizard step (before AND after the bot is
 * connected) — before connecting, the choice is simply stored and picked up the next time the bot
 * starts; per this WP's own contract.
 *
 * Two independent pieces of state, on purpose, never merged into one: `useGatewayProjectsDir()`
 * (the read side, polled) and this component's own save-in-flight/save-result state (the write
 * side, one-shot per click) — mirrors `ConnectWizard.tsx`'s own separation between `service` (read,
 * from the parent) and its local `connecting`/`connectError` state.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Button, EmptyState, Field, Icon, Machine, Modal, Panel, Switch } from '@/components/primitives';
import {
  requestBrowseFolder,
  requestSetProjectsDir,
  useGatewayProjectsDir,
} from '@/prototype/state/gateway-discord-projects-dir';
import type { ProjectsDirSource } from '@/prototype/state/gateway-discord-projects-dir';
import type { Locale, Translate } from '@/i18n';
import './projects-dir.css';
import { useLocale } from '@/i18n/use-locale';
import { formatNumber } from '@/i18n/format';

type C = Translate;

/* ------------------------------------------------------------------ atoms */

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="fw-discord__row">
      <div className="fw-discord__row-text">
        <span className="fw-discord__row-label">{label}</span>
        {hint ? <span className="fw-discord__row-hint">{hint}</span> : null}
      </div>
      <div className="fw-discord__row-control">{children}</div>
    </div>
  );
}

function describeSource(source: ProjectsDirSource, t: C): string {
  if (source === 'setting') return t('rd.discord.dir.sourceSetting');
  if (source === 'default') return t('rd.discord.dir.sourceDefault');
  return t('rd.discord.notReported');
}

/** The source word itself (shown in the machine face): Dutch words for the two known values. */
function sourceValue(source: ProjectsDirSource, t: C): string {
  if (source === 'setting') return t('rd.discord.dir.sourceValueSetting');
  if (source === 'default') return t('rd.discord.dir.sourceValueDefault');
  return source ?? '—';
}

/** `truncated` (Codex run B F-04): the gateway's scan stopped at its budget before finishing the
 *  directory — `count` is then a LOWER BOUND ("at least this many"), shown as "N+" rather than a
 *  number that reads as exact when it might not be. */
function describeCount(exists: boolean, count: number | null, truncated: boolean, t: C, locale: Locale): string {
  if (!exists) return t('rd.discord.dir.notExists');
  if (count === null) return t('rd.discord.dir.unreadable');
  if (truncated) return t('rd.discord.dir.truncated', { count: formatNumber(count, locale) });
  if (count === 0) return t('rd.discord.dir.none');
  return t(count === 1 ? 'rd.discord.dir.countOne' : 'rd.discord.dir.countMany', { count: formatNumber(count, locale) });
}

/** Joins a browsed directory with a chosen subfolder name. Deliberately a forward slash — Node's
 *  path module (what the gateway resolves this with) accepts `/` as a separator on every
 *  platform, including win32, so this never has to know the server's own OS separator. */
function joinBrowsePath(base: string, name: string): string {
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${name}` : `${base}/${name}`;
}

/* ------------------------------------------------------------ folder browser */

function FolderBrowser({
  startDir,
  saving,
  onPick,
}: {
  startDir: string | null;
  saving: boolean;
  onPick: (dir: string, create: boolean) => void;
}) {
  const { t } = useLocale();
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [folders, setFolders] = useState<readonly string[]>([]);
  // Codex run B F-04: the gateway's scan can stop before finishing a very large
  // folder — this list may then not be the COMPLETE set of real subfolders.
  const [foldersTruncated, setFoldersTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [typedPath, setTypedPath] = useState('');
  const [createIfMissing, setCreateIfMissing] = useState(false);

  // Click-triggered navigation only (never called directly from the mount effect below — see
  // its own comment for why setState-before-the-first-await matters here).
  async function load(dir?: string): Promise<void> {
    setLoading(true);
    setBrowseError(null);
    const result = await requestBrowseFolder(dir);
    setLoading(false);
    if (!result.ok) {
      setBrowseError(result.error ?? t('rd.discord.dir.readError'));
      return;
    }
    setCurrent(result.path);
    setParent(result.parent);
    setFolders(result.folders);
    setFoldersTruncated(result.truncated);
  }

  useEffect(() => {
    let cancelled = false;
    // `loading` already starts `true` (initial state) — this never calls a setState setter
    // BEFORE its first `await`, unlike `load()` above, so it stays clear of
    // react-hooks/set-state-in-effect (same shape as gateway-discord.ts's own poll `tick()`).
    async function loadInitial(): Promise<void> {
      const result = await requestBrowseFolder(startDir ?? undefined);
      if (cancelled) return;
      if (!result.ok) {
        setBrowseError(result.error ?? t('rd.discord.dir.readError'));
        setLoading(false);
        return;
      }
      setCurrent(result.path);
      setParent(result.parent);
      setFolders(result.folders);
      setFoldersTruncated(result.truncated);
      setLoading(false);
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
    // Deliberately mount-only: every later navigation calls load() straight from a click handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fw-projdir__browser">
      <p className="fw-projdir__current">
        <Icon name="Folder" size="xs" />
        <Machine muted className="fw-projdir__current-path">
          {current ?? '…'}
        </Machine>
      </p>

      {browseError !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{browseError}</span>
        </p>
      ) : null}

      <div className="fw-projdir__list">
        {parent !== null ? (
          <button type="button" className="fw-projdir__item" onClick={() => void load(parent)}>
            <Icon name="ArrowUp" size="xs" />
            <span className="fw-projdir__item-name">{t('rd.discord.dir.up')}</span>
          </button>
        ) : null}
        {loading ? (
          <p className="fw-projdir__hint">{t('rd.discord.dir.reading')}</p>
        ) : folders.length === 0 ? (
          parent === null ? (
            <EmptyState compact icon="FolderSearch" title={t('rd.discord.dir.noSubfolders')} />
          ) : null
        ) : (
          folders.map((name) => (
            <button
              key={name}
              type="button"
              className="fw-projdir__item"
              onClick={() => current !== null && void load(joinBrowsePath(current, name))}
            >
              <Icon name="Folder" size="xs" />
              <span className="fw-projdir__item-name">{name}</span>
            </button>
          ))
        )}
      </div>

      {!loading && foldersTruncated ? (
        <p className="fw-projdir__hint">{t('rd.discord.dir.partial')}</p>
      ) : null}

      <div className="fw-projdir__actions">
        <Button variant="primary" disabled={saving || current === null} onClick={() => current !== null && onPick(current, false)}>
          {saving ? t('rd.discord.dir.saving') : t('rd.discord.dir.useFolder')}
        </Button>
      </div>

      <div className="fw-projdir__advanced">
        <Field
          label={t('rd.discord.dir.typed')}
          htmlFor="fw-projdir-typed-path"
          hint={t('rd.discord.dir.typedHint')}
        >
          <input
            id="fw-projdir-typed-path"
            className="fw-control fw-projdir__advanced-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typedPath}
            onChange={(event) => setTypedPath(event.target.value)}
            placeholder={current ?? t('rd.discord.dir.typedPlaceholder')}
          />
        </Field>
        <div className="fw-projdir__create-toggle">
          <Switch
            checked={createIfMissing}
            onChange={setCreateIfMissing}
            label={t('rd.discord.dir.create')}
            size="sm"
          />
        </div>
        <div className="fw-projdir__actions">
          <Button
            variant="ghost"
            disabled={saving || typedPath.trim().length === 0}
            onClick={() => onPick(typedPath.trim(), createIfMissing)}
          >
            {saving ? t('rd.discord.dir.saving') : t('rd.discord.dir.usePath')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- view */

export default function ProjectsDirSection() {
  const { data, error, loading, refresh } = useGatewayProjectsDir();
  const { t, locale } = useLocale();
  const [browserOpen, setBrowserOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  async function handlePick(dir: string, create: boolean): Promise<void> {
    if (saving || dir.length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSaveNote(null);
    const result = await requestSetProjectsDir(dir, create);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error ?? t('rd.discord.dir.saveFailed'));
      return;
    }
    setBrowserOpen(false);
    refresh();
    if (result.restarted) {
      setSaveNote(t('rd.discord.dir.restarted'));
    } else if (result.restartError !== null) {
      setSaveNote(t('rd.discord.dir.restartFailed', { error: result.restartError }));
    } else {
      setSaveNote(t('rd.discord.dir.savedLater'));
    }
  }

  function openBrowser(): void {
    setSaveError(null);
    setSaveNote(null);
    setBrowserOpen(true);
  }

  return (
    <Panel
      title={t('rd.discord.dir.title')}
      subtitle={t('rd.discord.dir.subtitle')}
    >
      {error !== null ? (
        <p className="fw-discord__transport-error" role="alert">
          <Icon name="Unplug" size="sm" />
          <span>{t('rd.discord.unreachable', { error })}</span>
        </p>
      ) : null}

      {loading ? (
        <EmptyState compact icon="Loader" title={t('rd.discord.dir.loading')} />
      ) : (
        <div className="fw-discord__rows">
          <Row label={t('rd.discord.dir.looksIn')} hint={describeCount(data.exists, data.projectCount, data.projectCountTruncated, t, locale)}>
            <Machine muted className="fw-discord__row-path">
              {data.dir || '—'}
            </Machine>
          </Row>
          <Row label={t('rd.discord.dir.source')} hint={describeSource(data.source, t)}>
            <Machine muted>{sourceValue(data.source, t)}</Machine>
          </Row>
        </div>
      )}

      {saveNote !== null ? <p className="fw-projdir__note">{saveNote}</p> : null}

      <div className="fw-projdir__actions">
        <Button variant="ghost" icon="FolderOpen" disabled={saving} onClick={openBrowser}>
          {saving ? t('rd.discord.dir.saving') : t('rd.discord.dir.change')}
        </Button>
      </div>

      <Modal
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        title={t('rd.discord.dir.modalTitle')}
        description={t('rd.discord.dir.modalDetail')}
        size="md"
        footer={
          <Button variant="ghost" disabled={saving} onClick={() => setBrowserOpen(false)}>
            {t('rd.discord.dir.cancel')}
          </Button>
        }
      >
        {/* Rendered INSIDE the modal, not the panel behind it — a save failure must stay visible
            while the picker is still open, never hidden behind the overlay (see this file's
            header for the read/write state-separation this relies on). */}
        {saveError !== null ? (
          <p className="fw-discord__alert" role="alert">
            <Icon name="TriangleAlert" size="sm" />
            <span>{saveError}</span>
          </p>
        ) : null}
        <FolderBrowser
          startDir={data.exists ? data.dir : null}
          saving={saving}
          onPick={(dir, create) => void handlePick(dir, create)}
        />
      </Modal>
    </Panel>
  );
}
