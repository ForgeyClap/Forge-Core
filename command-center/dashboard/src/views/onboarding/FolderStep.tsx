/**
 * Projectmap step (WP B6, plan §4.7): a folder picker on the gateway's existing read-only
 * browse route (`GET /api/discord/browse-folder`, folder NAMES only), with the guardrails of plan
 * §3.2 (no drive root, no whole user folder, no Documents root, no Windows or program folders) and
 * a live "may Forge write here" check through `/api/checkup?dir=`.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useCheckup } from '@/components/checkup/use-checkup';
import { useLocale } from '@/i18n/use-locale';
import { requestBrowseFolder } from '@/prototype/state/gateway-discord-projects-dir';
import type { BrowseFolderResult } from '@/prototype/state/gateway-discord-projects-dir';

import { folderRefusal } from './onboarding-model';
import type { FolderRefusal } from './onboarding-model';

export interface FolderStepProps {
  readonly chosen: string | null;
  readonly onChoose: (path: string | null) => void;
}

function joinPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/';
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

export function FolderStep({ chosen, onChoose }: FolderStepProps) {
  const { t } = useLocale();
  const [listing, setListing] = useState<BrowseFolderResult | null>(null);
  const [documentsRoot, setDocumentsRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refusal, setRefusal] = useState<FolderRefusal | null>(null);
  const checkup = useCheckup(chosen, chosen !== null);

  // Only the answer is stored here (a callback, never a synchronous state change in an effect).
  const fetchListing = useCallback((dir?: string) => {
    void requestBrowseFolder(dir).then((result) => {
      setListing(result);
      setLoading(false);
      if (dir === undefined && result.ok && result.path) setDocumentsRoot((current) => current ?? result.path);
    });
  }, []);

  function open(dir?: string) {
    setLoading(true);
    setRefusal(null);
    fetchListing(dir);
  }

  // First listing only (loading starts true); later navigation goes through open() from the buttons.
  useEffect(() => {
    fetchListing();
  }, [fetchListing]);

  const current = listing?.ok ? listing.path : null;
  const writable = chosen !== null && checkup.status === 'done' ? checkup.result?.writableProjectDir ?? null : null;

  function chooseCurrent() {
    if (!current) return;
    const reason = folderRefusal(current, documentsRoot);
    setRefusal(reason);
    onChoose(reason === null ? current : null);
  }

  return (
    <div className="fs-folder">
      <p className="fs-onb__hint">{t('onboarding.projectmap.suggestion')}</p>
      <div className="fs-folder__bar">
        <span className="fs-folder__label">{t('onboarding.projectmap.current')}</span>
        <span className="fs-folder__path">{current ?? '—'}</span>
        <Button size="sm" variant="quiet" icon="ArrowUp" disabled={!listing?.parent || loading} onClick={() => listing?.parent && open(listing.parent)}>
          {t('onboarding.projectmap.up')}
        </Button>
        <Button size="sm" variant="primary" icon="Check" disabled={!current || loading} onClick={chooseCurrent}>
          {t('onboarding.projectmap.use')}
        </Button>
      </div>

      {refusal ? (
        <p className="fs-onb__warn" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          {t(`onboarding.projectmap.refused.${refusal}`)}
        </p>
      ) : null}

      {loading ? <p className="fs-onb__hint">{t('onboarding.projectmap.loading')}</p> : null}
      {!loading && listing && !listing.ok ? <p className="fs-onb__warn">{t('onboarding.projectmap.error')}</p> : null}
      {!loading && listing?.ok ? (
        listing.folders.length === 0 ? (
          <p className="fs-onb__hint">{t('onboarding.projectmap.empty')}</p>
        ) : (
          <ul className="fs-folder__list" aria-label={t('onboarding.projectmap.folderList')}>
            {listing.folders.map((name) => (
              <li key={name}>
                <button type="button" className="fs-folder__item" onClick={() => current && open(joinPath(current, name))}>
                  <Icon name="Folder" size="sm" />
                  <span>{name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {listing?.truncated ? <p className="fs-onb__hint">{t('onboarding.projectmap.truncated')}</p> : null}

      {chosen ? (
        <div className="fs-folder__chosen" role="status">
          <Icon name={writable === false ? 'CircleX' : 'CircleCheck'} size="sm" />
          <span className="fs-folder__chosen-text">
            <span className="fs-folder__path">{t('onboarding.projectmap.chosen', { path: chosen })}</span>
            {writable === true ? <span>{t('onboarding.projectmap.writable')}</span> : null}
            {writable === false ? <span>{t('onboarding.projectmap.notWritable')}</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
