/**
 * AccountList — the Claude accounts of the router (APP-ROUTER-DESIGN.md §3, §4.4, §6.2).
 *
 * "Hoofdaccount (je gewone Claude-login)" first, then the extra accounts. Each row: a state pill, the
 * measured usage (a percentage only when the program reported one, never a made-up 0), Testen and, for
 * an extra account, Verwijderen with a confirm that names the folder left behind (the sign-in stays
 * there; deleting it is the user's own act).
 */

import { useState } from 'react';

import { Button, Modal } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { testTarget } from '@/prototype/state/adapter/app-router';
import type { RouterConfig, RouterEntry, RouterEntryStatus, RouterWindow, TestOutcome } from '@/prototype/state/adapter/app-router';

import { STALE_MS, clock, entryPill, greyedByGate, isClaude, profileFolder, windowKey } from './app-router-model';
import { unusableNote } from './test-note';
import { useNow } from './use-now';

export interface AccountListProps {
  readonly config: RouterConfig;
  /** Ids that exist in the SAVED config: only those can be tested. */
  readonly savedIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, RouterEntryStatus>;
  readonly profilesRoot: string | null;
  /** Unsaved changes block adding (the gateway adds to the saved config). */
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (id: string) => void;
  readonly onTested: () => void;
  /** The skip notice of a step the router skips (an own API removed, off or without cost confirmation), else null. */
  readonly skipFor?: (entryId: string) => string | null;
  /** Inside a "Meer info" (DESIGN.md §6): no own frame. */
  readonly bare?: boolean;
}

function topWindow(windows: readonly RouterWindow[]): RouterWindow | null {
  const measured = windows.filter((window) => window.pct !== null);
  if (measured.length === 0) return null;
  return measured.reduce((best, window) => ((window.pct ?? 0) > (best.pct ?? 0) ? window : best));
}

function UsageLine({ status, now }: { readonly status: RouterEntryStatus | null; readonly now: number }) {
  const { t, locale } = useLocale();
  if (status === null) return null;
  const top = topWindow(status.windows);
  const measuredMs = status.measuredAt ? Date.parse(status.measuredAt) : NaN;
  const time = clock(status.measuredAt, locale);
  const stale = Number.isFinite(measuredMs) && now - measuredMs > STALE_MS;
  const resetPassed = top?.resetsAt ? Date.parse(top.resetsAt) < now : false;
  const when = time ? t(stale ? 'appRouter.accounts.measuredStale' : 'appRouter.accounts.measured', { time }) : null;
  if (top && top.pct !== null) {
    const pct = Math.max(0, Math.min(100, Math.round(top.pct)));
    const label = t('appRouter.accounts.usage', { pct, window: t(windowKey(top.type)) });
    return (
      <div className="fs-router__usage">
        <div className="fs-meter">
          <span className="fs-meter__label">
            <span>{label}</span>
            {when ? <span className="fs-meter__reset">{resetPassed ? t('appRouter.accounts.freeAgain') : when}</span> : null}
          </span>
          <span
            className="fs-meter__track"
            role="progressbar"
            aria-label={label}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ transform: `scaleX(${pct / 100})` }} data-high={pct >= 90 || undefined} />
          </span>
        </div>
      </div>
    );
  }
  if (status.windows.some((window) => window.status !== null && window.status.startsWith('allowed'))) {
    return (
      <p className="fs-router__fine">
        {t('appRouter.accounts.usageNoPct')}
        {when ? ` · ${when}` : ''}
      </p>
    );
  }
  if (status.state === 'unknown') return <p className="fs-router__fine">{t('appRouter.accounts.usageUnknown')}</p>;
  return null;
}

interface RowProps {
  readonly entry: RouterEntry;
  readonly config: RouterConfig;
  readonly status: RouterEntryStatus | null;
  readonly canTest: boolean;
  readonly profilesRoot: string | null;
  readonly readOnly: boolean;
  readonly onRemove: (entry: RouterEntry) => void;
  readonly onTested: () => void;
  readonly skip: string | null;
}

function AccountRow({ entry, config, status, canTest, profilesRoot, readOnly, onRemove, onTested, skip }: RowProps) {
  const { t, locale } = useLocale();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const now = useNow();
  const greyed = greyedByGate(config, entry);
  const pill = entryPill({ entry, status, greyed, testing, test, locale, now });
  const isMain = entry.profile === null || entry.profile === undefined;
  const folder = isMain ? null : profileFolder(profilesRoot, entry.profile ?? '');

  async function runTest() {
    setTesting(true);
    setTest(null);
    const outcome = await testTarget(entry.id);
    setTest(outcome);
    setTesting(false);
    onTested();
  }

  let note: string | null = null;
  if (test?.kind === 'too-soon') note = t('appRouter.accounts.tooSoon', { min: Math.max(1, Math.ceil((test.retryAfterS ?? 300) / 60)) });
  else if (test?.kind === 'failed') note = t('appRouter.accounts.testFailed', { reason: test.error });
  else if (test?.kind === 'refused') note = t('appRouter.accounts.refused');
  else if (test?.kind === 'unusable') note = unusableNote(test, t, locale);
  else if (skip !== null && test === null) note = t('appRouter.accounts.testBlocked');
  const testable = canTest && skip === null;

  let sub: string;
  if (isMain) sub = t('appRouter.accounts.mainSub');
  else sub = folder ? t('appRouter.accounts.extraSub', { folder }) : t('appRouter.accounts.extraSubNoFolder');

  return (
    <li className="fs-router__acct" data-target={entry.id} data-greyed={greyed || undefined} data-enabled={entry.enabled}>
      <span className="fs-router__plate" aria-hidden="true">
        {entry.label.charAt(0).toUpperCase()}
      </span>
      <span className="fs-router__acct-main">
        <span className="fs-router__acct-top">
          <b className="fs-router__acct-name">{entry.label}</b>
          <span className="fs-pill" data-tone={pill.tone}>
            <span className="fs-pill__dot" aria-hidden="true" />
            {t(pill.key, pill.vars)}
          </span>
        </span>
        <span className="fs-router__acct-sub" title={folder ?? undefined}>
          {sub}
        </span>
        {/* A skipped account says so in its pill; the checkbox that turns switching on sits above this list (consent row). */}
        <UsageLine status={status} now={now} />
        <span className="fs-router__fine" role="status">
          {note}
        </span>
      </span>
      <span className="fs-router__acct-ctl">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void runTest()}
          disabled={!testable || testing}
          aria-label={t('appRouter.accounts.testLabel', { label: entry.label })}
          title={skip ?? (canTest ? t('appRouter.accounts.testHint') : t('appRouter.accounts.testSaveFirst'))}
        >
          {t('appRouter.accounts.test')}
        </Button>
        {isMain ? null : (
          <Button
            size="sm"
            variant="quiet"
            icon="Trash2"
            disabled={readOnly}
            aria-label={t('appRouter.accounts.removeLabel', { label: entry.label })}
            onClick={() => onRemove(entry)}
          >
            {t('appRouter.accounts.remove')}
          </Button>
        )}
      </span>
    </li>
  );
}

export function AccountList({ config, savedIds, statusById, profilesRoot, readOnly, onAdd, onRemove, onTested, skipFor, bare = false }: AccountListProps) {
  const { t } = useLocale();
  const [removing, setRemoving] = useState<RouterEntry | null>(null);
  const accounts = config.entries.filter(isClaude);
  const removingFolder = removing?.profile ? profileFolder(profilesRoot, removing.profile) : null;

  return (
    <section className={bare ? 'fs-router__block fs-router__block--bare' : 'fs-router__block'} aria-labelledby="fs-router-accounts-h">
      <h4 className="fs-router__block-title" id="fs-router-accounts-h">
        {t('appRouter.accounts.heading')}
      </h4>
      <ul className="fs-router__accts">
        {accounts.map((entry) => (
          <AccountRow
            key={entry.id}
            entry={entry}
            config={config}
            status={statusById.get(entry.id) ?? null}
            canTest={savedIds.has(entry.id)}
            profilesRoot={profilesRoot}
            readOnly={readOnly}
            onRemove={setRemoving}
            onTested={onTested}
            skip={skipFor ? skipFor(entry.id) : null}
          />
        ))}
      </ul>
      <div className="fs-router__add">
        {/* owner bug 2026-11-02: never blocked by unsaved changes (choosing a mode first must not deadlock adding) */}
        <Button size="sm" variant="secondary" icon="Plus" onClick={onAdd} disabled={readOnly}>
          {t('appRouter.add.title')}
        </Button>
        <span className="fs-router__fine">{t('appRouter.accounts.testHint')}</span>
      </div>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? t('appRouter.accounts.removeTitle', { label: removing.label }) : ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('appRouter.accounts.cancel')}
            </Button>
            <Button
              variant="danger"
              icon="Trash2"
              onClick={() => {
                if (removing) onRemove(removing.id);
                setRemoving(null);
              }}
            >
              {t('appRouter.accounts.remove')}
            </Button>
          </>
        }
      >
        <p className="fs-router-dialog__note">
          {removingFolder ? t('appRouter.accounts.removeText', { folder: removingFolder }) : t('appRouter.accounts.removeTextNoFolder')}
        </p>
        <p className="fs-router__hint">{t('appRouter.accounts.removeAfter')}</p>
      </Modal>
    </section>
  );
}
