/**
 * AddAccountDialog — name → steps → command (APP-ROUTER-DESIGN.md §3.3).
 *
 * Forge never signs in for you and never sees a password or a sign-in: the dialog asks only for a name,
 * the gateway makes an empty folder for that account, and the steps show the one line that starts the
 * official Claude program with that folder. "Testen" then runs one tiny probe turn in that folder.
 */

import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Button, Modal } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { createProfile, testTarget } from '@/prototype/state/adapter/app-router';
import type { ProfileOutcome, RouterConfig, TestOutcome } from '@/prototype/state/adapter/app-router';

import { CopyCommand } from '../SignInPanel';
import { entryPill } from './app-router-model';
import { unusableNote } from './test-note';
import { useNow } from './use-now';

export interface AddAccountDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The server's config after the account was added (it wins over the shown one). */
  readonly onCreated: (config: RouterConfig) => void;
}

type Created = Extract<ProfileOutcome, { kind: 'created' }>;

export function AddAccountDialog({ open, onClose, onCreated }: AddAccountDialogProps) {
  const { t, locale } = useLocale();
  const nameId = useId();
  const hintId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const now = useNow();

  function close() {
    setName('');
    setError(null);
    setCreated(null);
    setTest(null);
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const label = name.trim();
    if (label.length < 1 || label.length > 40) {
      setError(t('appRouter.add.invalidName'));
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await createProfile(label);
    setBusy(false);
    if (outcome.kind === 'created') {
      setCreated(outcome);
      onCreated(outcome.config);
    } else if (outcome.kind === 'exists') setError(t('appRouter.add.exists'));
    else if (outcome.kind === 'invalid') setError(t('appRouter.add.invalidName'));
    else if (outcome.kind === 'refused') setError(t('appRouter.accounts.refused'));
    else setError(t('appRouter.add.failed', { reason: outcome.error }));
  }

  async function runTest() {
    if (!created) return;
    setTesting(true);
    setTest(null);
    setTest(await testTarget(created.entry.id));
    setTesting(false);
  }

  let testLine: string | null = null;
  if (created && (testing || test)) {
    if (test?.kind === 'too-soon') testLine = t('appRouter.accounts.tooSoon', { min: Math.max(1, Math.ceil((test.retryAfterS ?? 300) / 60)) });
    else if (test?.kind === 'failed' || test?.kind === 'refused') testLine = t('appRouter.accounts.testFailed', { reason: test.error });
    else if (test?.kind === 'unusable') testLine = unusableNote(test, t, locale);
    else {
      const pill = entryPill({ entry: created.entry, status: null, greyed: false, testing, test, locale, now });
      testLine = t(pill.key, pill.vars);
    }
  }

  const footer = created ? (
    <>
      <Button variant="ghost" icon="RefreshCw" onClick={() => void runTest()} disabled={testing}>
        {t('appRouter.accounts.test')}
      </Button>
      <Button variant="primary" onClick={close}>
        {t('appRouter.add.done')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={close}>
        {t('appRouter.accounts.cancel')}
      </Button>
      <Button variant="primary" type="submit" form={`${nameId}-form`} disabled={busy}>
        {busy ? t('appRouter.add.creating') : t('appRouter.add.create')}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={close} title={t('appRouter.add.title')} footer={footer} size="md" className="fs-router-dialog">
      {created ? (
        <div className="fs-router-dialog__steps">
          <ol className="fs-router-dialog__list">
            <li>{t('appRouter.add.step1')}</li>
            <li>
              {t('appRouter.add.step2')}
              <CopyCommand command={created.login.powershell} />
            </li>
            <li>{t('appRouter.add.step3')}</li>
            <li>{t('appRouter.add.step4')}</li>
          </ol>
          <details className="fs-router-dialog__other">
            <summary>{t('appRouter.add.otherShells')}</summary>
            {created.login.cmd ? (
              <>
                <p>{t('appRouter.add.cmdLabel')}</p>
                <CopyCommand command={created.login.cmd} />
              </>
            ) : null}
            {created.login.posix ? (
              <>
                <p>{t('appRouter.add.posixLabel')}</p>
                <CopyCommand command={created.login.posix} />
              </>
            ) : null}
          </details>
          <p className="fs-router-dialog__note">{t('appRouter.add.note')}</p>
          {created.dirDisplay ? <p className="fs-router__fine">{t('appRouter.add.folderAt', { folder: created.dirDisplay })}</p> : null}
          <p className="fs-router__hint">{t('appRouter.accounts.testHint')}</p>
          <p className="fs-router-dialog__result" role="status" data-tested={test?.kind === 'done' ? test.state : undefined}>
            {testLine}
          </p>
        </div>
      ) : (
        <form id={`${nameId}-form`} className="fs-router-dialog__form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="fs-router__label" htmlFor={nameId}>
            {t('appRouter.add.nameLabel')}
          </label>
          <input
            id={nameId}
            className="fs-router__input fs-router__input--wide"
            value={name}
            maxLength={40}
            autoComplete="off"
            placeholder={t('appRouter.add.namePlaceholder')}
            aria-describedby={hintId}
            aria-invalid={error !== null || undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="fs-router__hint" id={hintId}>
            {t('appRouter.add.nameHint')}
          </p>
          {error ? (
            <p className="fs-router__error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
