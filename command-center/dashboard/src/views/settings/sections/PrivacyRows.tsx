/**
 * Privacy (WP B6): wat staat waar (the real data folder from the gateway's health report),
 * exporteren (grey with its reason: no export route exists yet) and alles wissen (asks first, then
 * erases this app's stored choices in this browser and says exactly that; conversations and jobs on
 * disk stay — the copy promises nothing more).
 */

import { useState } from 'react';

import { Button, Modal } from '@/components/primitives';
import { setLocale, DEFAULT_LOCALE } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import { DEFAULT_UI_MODE, setUiMode } from '@/state/ui-mode';

import { SettingRow } from '../SettingRow';
import { wipeLocalForgeSettings } from '../settings-model';
import type { GatewayPaths } from '../use-gateway-paths';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function WhereRow({ paths }: { readonly paths: GatewayPaths }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const dir = paths.dataDir;
  return (
    <SettingRow
      rowId="waar"
      title={t('settingsPage.rows.waar.title')}
      feel={t('settingsPage.rows.waar.feel')}
      note={dir ? <span className="fs-set__path">{t('settingsPage.rows.waar.dir', { dir })}</span> : null}
      control={
        dir ? (
          <Button
            size="sm"
            variant="ghost"
            icon="Copy"
            onClick={() => {
              void copy(dir).then((ok) => {
                setCopied(ok);
                if (ok) window.setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? t('settingsPage.rows.waar.copied') : t('settingsPage.rows.waar.copy')}
          </Button>
        ) : null
      }
    />
  );
}

export function ExportRow() {
  const { t } = useLocale();
  return (
    <SettingRow
      rowId="exporteren"
      title={t('settingsPage.rows.exporteren.title')}
      feel={t('settingsPage.rows.exporteren.feel')}
      note={<span id="fs-export-reason">{t('settingsPage.rows.exporteren.notYet')}</span>}
      control={
        <Button size="sm" variant="ghost" icon="Download" disabled aria-describedby="fs-export-reason">
          {t('settingsPage.rows.exporteren.button')}
        </Button>
      }
    />
  );
}

export function WipeRow() {
  const { t } = useLocale();
  const { dispatch } = usePrototype();
  const [confirming, setConfirming] = useState(false);

  function wipe() {
    wipeLocalForgeSettings();
    // The in-memory stores still hold the old values; put them back to their first-start state.
    dispatch({ type: 'appearance/set', appearance: 'system' });
    dispatch({ type: 'density/set', density: 'comfortable' });
    dispatch({ type: 'motion/set', reduced: false });
    setUiMode(DEFAULT_UI_MODE);
    setLocale(DEFAULT_LOCALE);
    // Those setters write their own keys again; remove them so the next start is truly fresh.
    wipeLocalForgeSettings();
    setConfirming(false);
    dispatch({
      type: 'toast/push',
      toast: { id: nextToastId(), title: t('settingsPage.rows.wissen.done'), icon: 'RotateCcw' },
    });
  }

  return (
    <>
      <SettingRow
        rowId="wissen"
        title={t('settingsPage.rows.wissen.title')}
        feel={t('settingsPage.rows.wissen.feel')}
        control={
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            {t('settingsPage.rows.wissen.button')}
          </Button>
        }
      />
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('settingsPage.rows.wissen.confirmTitle')}
        description={t('settingsPage.rows.wissen.confirmText')}
        size="sm"
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              {t('settingsPage.rows.wissen.cancel')}
            </Button>
            <Button variant="danger" onClick={wipe}>
              {t('settingsPage.rows.wissen.confirm')}
            </Button>
          </>
        }
      />
    </>
  );
}
