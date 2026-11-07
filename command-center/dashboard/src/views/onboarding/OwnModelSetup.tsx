/**
 * OwnModelSetup — "Geen Claude?" (ANY-MODEL-PLAN.md §7): the last part of the connect step for a
 * person without Claude. Pick the model (Ollama, a key service, an own API) or keep Codex, then ONE
 * button: Forge tests the connection through the existing test route and, only when the test passes,
 * saves the router in the stand "Meteen eigen model" (APP-ROUTER-DESIGN.md mode model-first).
 *
 * Honest copy, always visible: in Forge this model can only answer for now (jobs with files and the
 * team come in a later phase); Codex can read and answer but not edit files or run commands (the chat
 * notice sentence, word for word); small local models answer slower and less well than Claude; for
 * Codex Forge only sees that it is installed. A failed test never touches the router; a router refusal is
 * shown in the gateway's own words, never as success.
 */

import { useId, useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { parseRouterGet, saveRouterConfig, useProviderModels } from '@/prototype/state/adapter/app-router';
import type { RouterConfig } from '@/prototype/state/adapter/app-router';
import { testProvider } from '@/prototype/state/adapter/providers';
import type { ProviderTestResult } from '@/prototype/state/adapter/providers';
import { gwGet } from '@/prototype/state/gateway-client';

import { applyModelFirst, chosenLabel } from './own-model-model';
import type { OwnModelTarget } from './own-model-model';

import './own-model.css';

export type OwnModelSource =
  | { readonly kind: 'codex' }
  | {
      readonly kind: 'provider';
      readonly providerId: string;
      readonly providerName: string;
      /** The model ids that are known; null or empty = unknown (a free text field is offered). */
      readonly models: readonly string[] | null;
      /** Runs on this computer (Ollama, a local server): the "slower and less well" line is shown. */
      readonly local: boolean;
      readonly paid: boolean;
      readonly notice: boolean;
    };

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'testing' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'done'; readonly label: string }
  | { readonly kind: 'problem'; readonly text: string };

const CODEX_TEST_ID = 'codex-cli';

/** Codex is a sign-in program: "installed/found" is all the test can see (the copy says so). */
function testPassed(source: OwnModelSource, result: ProviderTestResult): boolean {
  if (result.ok) return true;
  return source.kind === 'codex' && (result.status === 'found' || result.status === 'connected');
}

async function readRouter(): Promise<{ config: RouterConfig } | { error: 'problems' | 'failed'; reason: string }> {
  const answer = await gwGet('/api/app-router');
  if (!answer.ok) return { error: 'failed', reason: answer.error };
  const parsed = parseRouterGet(answer.data);
  if (parsed === null) return { error: 'failed', reason: 'no router settings in the answer' };
  if (parsed.problems > 0) return { error: 'problems', reason: '' };
  return { config: parsed.config };
}

export interface OwnModelSetupProps {
  readonly source: OwnModelSource;
  /** Called after each test (a key service lists its models only after a test). */
  readonly onTested?: () => void;
  /**
   * Show the line that explains the button (test, then switch the stand). The onboarding connect step
   * passes false and puts that line under its own "Meer info" (DESIGN.md §5: max 70 words). The honest
   * limits below stay visible either way.
   */
  readonly showLead?: boolean;
}

export function OwnModelSetup({ source, onTested, showLead = true }: OwnModelSetupProps) {
  const { t, locale } = useLocale();
  const titleId = useId();
  const modelId = useId();
  const known = source.kind === 'provider' && source.models !== null && source.models.length > 0 ? source.models : null;
  const [model, setModel] = useState<string>(() => (known ? known[0] : ''));
  const [paidAck, setPaidAck] = useState(false);
  const [noticeAck, setNoticeAck] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'testing' || phase.kind === 'saving';
  const chosenModel = known && !known.includes(model) ? known[0] : model;
  const needsPaid = source.kind === 'provider' && source.paid;
  const needsNotice = source.kind === 'provider' && source.notice;
  const ready = (source.kind === 'codex' || chosenModel.trim() !== '') && (!needsPaid || paidAck) && (!needsNotice || noticeAck);

  async function save(target: OwnModelTarget) {
    setPhase({ kind: 'saving' });
    let read = await readRouter();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if ('error' in read) {
        setPhase({ kind: 'problem', text: read.error === 'problems' ? t('onboarding.ownModel.problems') : t('onboarding.ownModel.failed', { reason: read.reason }) });
        return;
      }
      const next = applyModelFirst(read.config, target);
      const outcome = await saveRouterConfig(next);
      if (outcome.kind === 'saved') {
        setPhase({ kind: 'done', label: chosenLabel(outcome.config) ?? t('onboarding.ownModel.codexLabel') });
        return;
      }
      if (outcome.kind === 'stale' && attempt === 0) {
        // The router changed meanwhile: apply the choice once more on the server's copy.
        read = outcome.config ? { config: outcome.config } : await readRouter();
        continue;
      }
      if (outcome.kind === 'invalid') {
        const first = outcome.errors[0];
        const reason = first ? (locale === 'en' ? first.en : first.nl) || first.code : '';
        setPhase({ kind: 'problem', text: t('onboarding.ownModel.failed', { reason }) });
      } else if (outcome.kind === 'refused') setPhase({ kind: 'problem', text: t('onboarding.ownModel.refused') });
      else if (outcome.kind === 'too-many') setPhase({ kind: 'problem', text: t('onboarding.ownModel.tooMany') });
      else setPhase({ kind: 'problem', text: t('onboarding.ownModel.failed', { reason: outcome.kind === 'failed' ? outcome.error : outcome.kind }) });
      return;
    }
  }

  async function run() {
    if (busy) return;
    if (!ready) {
      setPhase({ kind: 'problem', text: t('onboarding.ownModel.pickModel') });
      return;
    }
    setPhase({ kind: 'testing' });
    const result = await testProvider(source.kind === 'codex' ? CODEX_TEST_ID : source.providerId);
    onTested?.();
    if (!testPassed(source, result)) {
      setPhase({ kind: 'problem', text: t('onboarding.ownModel.testFail', { status: t(`settingsPage.accounts.status.${result.status}`) }) });
      return;
    }
    await save(
      source.kind === 'codex'
        ? { kind: 'codex' }
        : { kind: 'provider', provider: source.providerId, providerName: source.providerName, model: chosenModel.trim(), paidAck, noticeAck },
    );
  }

  let status: { tone: 'ok' | 'bad' | 'busy'; text: string } | null = null;
  if (phase.kind === 'testing') status = { tone: 'busy', text: t('onboarding.ownModel.testing') };
  else if (phase.kind === 'saving') status = { tone: 'busy', text: t('onboarding.ownModel.saving') };
  else if (phase.kind === 'done') status = { tone: 'ok', text: t('onboarding.ownModel.done', { label: phase.label }) };
  else if (phase.kind === 'problem') status = { tone: 'bad', text: phase.text };

  return (
    <section className="fs-own" aria-labelledby={titleId} data-phase={phase.kind}>
      <h2 className="fs-own__title" id={titleId}>
        {t('onboarding.ownModel.heading')}
      </h2>
      {showLead ? <p className="fs-own__lead">{t('onboarding.ownModel.lead')}</p> : null}

      {source.kind === 'provider' ? (
        <div className="fs-own__field">
          <label className="fs-own__label" htmlFor={modelId}>
            {known ? t('onboarding.ownModel.modelLabel') : t('onboarding.ownModel.manualLabel')}
          </label>
          {known ? (
            <select id={modelId} className="fs-own__control" value={chosenModel} disabled={busy} onChange={(event) => setModel(event.target.value)}>
              {known.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                id={modelId}
                className="fs-own__control fs-own__control--mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                value={model}
                disabled={busy}
                aria-describedby={`${modelId}-hint`}
                onChange={(event) => setModel(event.target.value)}
              />
              <p className="fs-own__hint" id={`${modelId}-hint`}>
                {t('onboarding.ownModel.manualHint')}
              </p>
            </>
          )}
        </div>
      ) : null}

      {needsPaid ? (
        <label className="fs-own__check">
          <input type="checkbox" checked={paidAck} disabled={busy} onChange={(event) => setPaidAck(event.target.checked)} />
          <span>{t('appRouter.fallback.paidAck')}</span>
        </label>
      ) : null}
      {needsNotice ? (
        <label className="fs-own__check">
          <input type="checkbox" checked={noticeAck} disabled={busy} onChange={(event) => setNoticeAck(event.target.checked)} />
          <span>{t('appRouter.fallback.noticeAck')}</span>
        </label>
      ) : null}

      <ul className="fs-own__facts">
        {/* Codex: the one sentence about what it can do in Forge now, the same as the chat notice. */}
        {source.kind === 'codex' ? <li>{t('onboarding.codexCan')}</li> : <li>{t('onboarding.ownModel.answersOnly')}</li>}
        {source.kind === 'codex' ? <li>{t('onboarding.ownModel.codexNote')}</li> : null}
        {source.kind === 'provider' && source.local ? <li>{t('onboarding.ownModel.localSlow')}</li> : null}
      </ul>

      <div className="fs-own__act">
        <Button variant="primary" size="sm" icon={phase.kind === 'done' ? 'Check' : 'Play'} onClick={() => void run()} disabled={busy}>
          {t('onboarding.ownModel.use')}
        </Button>
        <p className="fs-own__status" role="status" data-tone={status?.tone}>
          {status?.tone === 'ok' ? <Icon name="CircleCheck" size="sm" /> : null}
          {status?.tone === 'bad' ? <Icon name="TriangleAlert" size="sm" /> : null}
          <span>{status?.text ?? ''}</span>
        </p>
      </div>
    </section>
  );
}

/** For a key service or an own API: the model list comes from GET /api/models (and grows after a test). */
export function ListedModelSetup(props: Omit<Extract<OwnModelSource, { kind: 'provider' }>, 'kind' | 'models'> & { readonly fixedModels?: readonly string[] }) {
  const listing = useProviderModels();
  const { fixedModels, ...rest } = props;
  const found = listing.list?.find((item) => item.id === props.providerId);
  const models = fixedModels && fixedModels.length > 0 ? fixedModels : found && found.source !== 'not-fetched' ? found.models : null;
  return <OwnModelSetup source={{ kind: 'provider', ...rest, models }} onTested={listing.refresh} />;
}

