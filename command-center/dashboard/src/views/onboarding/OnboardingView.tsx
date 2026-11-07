/**
 * Onboarding — the first start (DESIGN.md §3.5, mockup 05-onboarding; was WP B6).
 *
 * Four steps, centred, 560 px wide, with no sidebar:
 *   1. Welkom (`detectie`): the pc check runs silently. "Alles klaar op deze pc" and Verder; only a real
 *      problem (low disk, a folder Forge may not write in) gets a row with one fix button.
 *   2. Kies (`pad`): "Waarmee wil je werken?" with four choices. The yes/no table sits behind
 *      "Wat kan elk pad?". Skipping is allowed from here.
 *   3. Verbinden: per path one instruction, a command box, Opnieuw controleren, the honest limit line.
 *   4. Klaar: "Je werkt in: <map>" with Andere map, Begin, and "Laat me rondkijken" (the 3-stop tour).
 *
 * What this screen does NOT do: it never starts a sign-in itself or reads one (it shows the exact
 * command of the official program and checks again, also on its own every 15 s). The API-key path
 * stores the key only through the desktop vault (KeyStep → KeyField); in a browser it says the app is
 * needed. Route: /onboarding; the wizard covers the shell's chrome with its own layer and makes it inert.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, ChoiceList, Disclosure, Icon, Mark } from '@/components/primitives';
import type { ChoiceOption } from '@/components/primitives';
import { CheckupPanel } from '@/components/checkup/CheckupPanel';
import { buildCheckRows, FIX_COMMANDS } from '@/components/checkup/checkup-model';
import { useCheckup } from '@/components/checkup/use-checkup';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { requestTourStart } from '@/components/tour/tour-state';
import { useLocale } from '@/i18n/use-locale';

import { CapabilityTable } from './CapabilityTable';
import { FolderStep } from './FolderStep';
import { KeyStep } from './KeyStep';
import { OwnModelSetup } from './OwnModelSetup';
import {
  canContinueStep,
  choiceForPath,
  isPcProblem,
  markOnboardingDone,
  nextStep,
  normaliseStep,
  pathForChoice,
  previousStep,
  readChosenFolder,
  STEPS,
  suggestPath,
} from './onboarding-model';
import type { ChoiceId, LegacyStepId, PathId, StepId } from './onboarding-model';

import './onboarding.css';

const CLAUDE_RECHECK_MS = 15_000;

/** The shell regions the wizard covers; they are made inert so Tab never walks behind the wizard. */
const CHROME_SELECTORS = ['.fw-shell__sidebar', '.fw-shell__bar', '.fw-shell__pane', '.fw-shell__skip'];

function useInertChrome(): void {
  useEffect(() => {
    const nodes = CHROME_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)));
    const changed = nodes.filter((node) => !node.hasAttribute('inert'));
    changed.forEach((node) => node.setAttribute('inert', ''));
    return () => changed.forEach((node) => node.removeAttribute('inert'));
  }, []);
}

function CommandBox({ command }: { readonly command: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="fs-onb__command">
      <code aria-label={t('checkup.command')}>{command}</code>
      <Button
        size="sm"
        variant="secondary"
        icon={copied ? 'Check' : 'Copy'}
        onClick={() => {
          void navigator.clipboard
            .writeText(command)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? t('checkup.copied') : t('rd.onboarding.connect.copy')}
      </Button>
    </div>
  );
}

function RecheckButton({ checkup }: { readonly checkup: CheckupController }) {
  const { t } = useLocale();
  const running = checkup.status === 'running';
  return (
    <Button variant="secondary" icon="RefreshCw" onClick={checkup.run} disabled={running} loading={running}>
      {running ? t('onboarding.verbinden.checking') : t('rd.onboarding.connect.recheck')}
    </Button>
  );
}

interface ConnectStepProps {
  readonly path: PathId;
  readonly checkup: CheckupController;
  /** The key step switches "API-sleutel" / "Eigen API" (the path follows); Eigen API reports a saved entry. */
  readonly onPathChange: (path: PathId) => void;
  readonly onOwnApiReady: (ready: boolean) => void;
}

function ConnectStep({ path, checkup, onPathChange, onOwnApiReady }: ConnectStepProps) {
  const { t } = useLocale();
  const result = checkup.result;

  // Signing in happens in Claude Code itself; while this step waits for it, Forge checks again on
  // its own every 15 s (plan §3.2: "app pollt de loginstatus en gaat vanzelf verder").
  const waitingForClaude = path === 'claude' && !(result?.claude.found && result.claude.signedIn === true) && result?.claude.found !== false;
  const rerun = checkup.run;
  const checking = checkup.status === 'running';
  useEffect(() => {
    if (!waitingForClaude || checking) return undefined;
    const timer = window.setTimeout(rerun, CLAUDE_RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [waitingForClaude, checking, rerun]);

  if (path === 'sleutel' || path === 'eigen') {
    return <KeyStep ownApi={path === 'eigen'} onOwnApiChange={(open) => onPathChange(open ? 'eigen' : 'sleutel')} onOwnApiReady={onOwnApiReady} />;
  }

  let body;
  let setup = null;
  let more: string[] = [t('onboarding.privacyHintConnect')];
  let limit: string | null = null;
  // Once the path is ready there is nothing to check again, so the button goes away.
  let ready = false;
  if (path === 'claude') {
    if (result?.claude.found && result.claude.signedIn === true) {
      ready = true;
      body = (
        <p className="fs-onb__ok">
          <Icon name="CircleCheck" size="sm" />
          {t('onboarding.verbinden.claudeReady')}
        </p>
      );
    } else if (result && !result.claude.found) {
      body = (
        <>
          <p>{t('onboarding.verbinden.claudeMissing')}</p>
          <CommandBox command={FIX_COMMANDS.installClaude ?? ''} />
        </>
      );
    } else {
      body = (
        <>
          <p>{t('onboarding.verbinden.claudeLogin')}</p>
          <CommandBox command={FIX_COMMANDS.login ?? ''} />
          {result?.claude.signedIn === null ? <p className="fs-onb__hint">{t('onboarding.verbinden.claudeUnknown')}</p> : null}
          <p className="fs-onb__hint" role="status">
            {t('onboarding.verbinden.claudeAuto')}
          </p>
        </>
      );
      more = [t('onboarding.verbinden.claudeAfter'), ...more];
    }
  } else if (path === 'chatgpt') {
    // One honest sentence about what Codex can do in Forge now (the chat notice, word for word). Once
    // Codex is found, OwnModelSetup says the same sentence, so it is not repeated here.
    if (!result?.codex.found) limit = t('onboarding.codexCan');
    body =
      result && !result.codex.found ? (
        <>
          <p>{t('onboarding.verbinden.chatgptMissing')}</p>
          <CommandBox command={FIX_COMMANDS.installCodex ?? ''} />
        </>
      ) : (
        <>
          <p>{t('onboarding.verbinden.chatgptLogin')}</p>
          <CommandBox command="codex login" />
        </>
      );
    more = [t('onboarding.verbinden.chatgptUnknown'), ...more];
    // once Codex is on this pc, test it and switch to "Meteen eigen model" in one step.
    if (result?.codex.found) setup = <OwnModelSetup source={{ kind: 'codex' }} showLead={false} />;
  } else if (result?.ollama.up && result.ollama.models.length > 0) {
    ready = true;
    body = (
      <p className="fs-onb__ok">
        <Icon name="CircleCheck" size="sm" />
        {t('onboarding.verbinden.lokaalReady', { models: result.ollama.models.join(', ') })}
      </p>
    );
    // OwnModelSetup says the honest limit itself ("kan in Forge nu alleen antwoorden").
    setup = (
      <OwnModelSetup
        source={{ kind: 'provider', providerId: 'ollama-local', providerName: 'Ollama', models: result.ollama.models, local: true, paid: false, notice: false }}
        showLead={false}
      />
    );
  } else {
    limit = t('onboarding.ownModel.answersOnly');
    if (result?.ollama.up) {
      body = (
        <>
          <p>{t('onboarding.verbinden.lokaalNoModels')}</p>
          <CommandBox command="ollama pull llama3.2" />
        </>
      );
    } else if (result?.ollama.found) {
      body = (
        <>
          <p>{t('onboarding.verbinden.lokaalStopped')}</p>
          <CommandBox command={FIX_COMMANDS.startOllama ?? ''} />
        </>
      );
    } else {
      body = (
        <>
          <p>{t('onboarding.verbinden.lokaalMissing')}</p>
          <CommandBox command={FIX_COMMANDS.installOllama ?? ''} />
        </>
      );
    }
  }

  // Text budget (DESIGN.md §5, max 70 words): what the button does goes under "Meer info"; the honest
  // limits stay in view.
  if (setup) more = [t('onboarding.ownModel.lead'), ...more];

  return (
    <div className="fs-onb__connect">
      {body}
      {ready ? null : (
        <div className="fs-onb__connect-row">
          <RecheckButton checkup={checkup} />
        </div>
      )}
      {limit ? (
        <p className="fs-onb__note">
          <Icon name="Info" size="sm" />
          <span>{limit}</span>
        </p>
      ) : null}
      {setup}
      <Disclosure label={t('rd.states.errorDetails')} className="fs-onb__more">
        {more.map((line) => (
          <p key={line} className="fs-onb__hint">
            {line}
          </p>
        ))}
      </Disclosure>
    </div>
  );
}

const TITLE_SUFFIX: Record<PathId, 'Claude' | 'Chatgpt' | 'Lokaal' | 'Sleutel' | 'Eigen'> = {
  claude: 'Claude',
  chatgpt: 'Chatgpt',
  lokaal: 'Lokaal',
  sleutel: 'Sleutel',
  eigen: 'Eigen',
};

const CHOICE_LOOK: Record<ChoiceId, { readonly key: 'claude' | 'chatgpt' | 'free' | 'own'; readonly letter?: string; readonly icon?: string }> = {
  claude: { key: 'claude', letter: 'C' },
  chatgpt: { key: 'chatgpt', letter: 'G' },
  lokaal: { key: 'free', icon: 'Cpu' },
  'eigen-sleutel': { key: 'own', icon: 'KeyRound' },
};

function WelcomeStep({ checkup }: { readonly checkup: CheckupController }) {
  const { t, locale } = useLocale();
  if (checkup.status === 'failed') {
    return (
      <div className="fs-onb__stack">
        <p className="fs-onb__warn" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          {t('checkup.failed')}
        </p>
        <div>
          <RecheckButton checkup={checkup} />
        </div>
      </div>
    );
  }
  if (checkup.status !== 'done' || !checkup.result) {
    return (
      <p className="fs-onb__hint fs-onb__checking" role="status">
        <Icon name="Loader" size="sm" spin />
        {t('onboarding.verbinden.checking')}
      </p>
    );
  }
  const problems = buildCheckRows(checkup.result, { showPort: false, locale }).filter(isPcProblem);
  return (
    <div className="fs-onb__stack">
      {/* No problem: the title already says "Alles klaar op deze pc", so nothing repeats it here. */}
      {problems.length > 0 ? <CheckupPanel controller={checkup} showPort={false} hideHeading bare rowFilter={isPcProblem} /> : null}
      <Disclosure label={t('rd.states.errorDetails')} className="fs-onb__more">
        <CheckupPanel controller={checkup} showPort={false} hideHeading />
      </Disclosure>
    </div>
  );
}

export interface OnboardingViewProps {
  /** Start at a given step (screenshots and tests). 'projectmap' opens Klaar with the folder picker. */
  readonly initialStep?: LegacyStepId;
  readonly initialPath?: PathId | null;
}

export default function OnboardingView({ initialStep = 'detectie', initialPath = null }: OnboardingViewProps) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const titleId = useId();
  const checkup = useCheckup(null, true);
  const [step, setStep] = useState<StepId>(() => normaliseStep(initialStep));
  const [picked, setPicked] = useState<PathId | null>(initialPath);
  const [ownApiReady, setOwnApiReady] = useState(false);
  const [folder, setFolder] = useState<string | null>(() => readChosenFolder());
  const [folderOpen, setFolderOpen] = useState(initialStep === 'projectmap');
  const cardRef = useRef<HTMLElement>(null);
  useInertChrome();

  // A new step starts at the top, with focus on its title, so a screen reader hears where it is.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    cardRef.current?.parentElement?.scrollTo?.({ top: 0 });
    document.getElementById(titleId)?.focus();
  }, [step, titleId]);

  const path = picked ?? suggestPath(checkup.result);
  const stepIndex = STEPS.indexOf(step);
  const suffix = path ? TITLE_SUFFIX[path] : 'Claude';

  function finish(to: string, tour = false) {
    markOnboardingDone(path, folder);
    navigate(to);
    if (tour) requestTourStart();
  }

  function skip() {
    markOnboardingDone(null, folder);
    navigate('/');
  }

  let title: string;
  let lead: string | null = null;
  let body;
  switch (step) {
    case 'detectie': {
      const done = checkup.status === 'done' && checkup.result !== null;
      const problems = done && checkup.result ? buildCheckRows(checkup.result, { showPort: false, locale }).some(isPcProblem) : false;
      title = done && !problems ? t('rd.onboarding.welcome.title') : t('onboarding.detectie.title');
      lead = done && !problems ? t('rd.onboarding.welcome.lead') : t('onboarding.detectie.lead');
      body = <WelcomeStep checkup={checkup} />;
      break;
    }
    case 'pad': {
      title = t('rd.onboarding.choose.title');
      lead = t('rd.onboarding.choose.lead');
      const options: ChoiceOption[] = (Object.keys(CHOICE_LOOK) as ChoiceId[]).map((id) => {
        const look = CHOICE_LOOK[id];
        return {
          value: id,
          title: t(`rd.onboarding.choose.${look.key}`),
          description: t(`rd.onboarding.choose.${look.key}Hint`),
          letter: look.letter,
          icon: look.icon,
        };
      });
      body = (
        <div className="fs-onb__stack">
          <ChoiceList
            options={options}
            value={choiceForPath(path)}
            onChange={(value) => setPicked(pathForChoice(value as ChoiceId, picked))}
            label={t('onboarding.pad.legend')}
          />
          <p className="fs-onb__note">
            <Icon name="Info" size="sm" />
            <span>{t('rd.onboarding.choose.info')}</span>
          </p>
          <Disclosure label={t('rd.onboarding.choose.compare')} className="fs-onb__more">
            <CapabilityTable chosen={path} hideTitle />
          </Disclosure>
        </div>
      );
      break;
    }
    case 'verbinden': {
      title = t(`onboarding.verbinden.title${suffix}`);
      body = path ? <ConnectStep path={path} checkup={checkup} onPathChange={setPicked} onOwnApiReady={setOwnApiReady} /> : null;
      break;
    }
    default: {
      title = t('rd.onboarding.ready.title');
      lead = t(`onboarding.klaar.lead${suffix}`);
      body = (
        <div className="fs-onb__stack">
          <div className="fs-onb__folder">
            <Icon name="Folder" size="sm" />
            <span className="fs-onb__folder-text">
              {folder ? t('rd.onboarding.ready.folder', { folder }) : t('onboarding.klaar.noFolder')}
            </span>
            <Button size="sm" variant="quiet" aria-expanded={folderOpen} onClick={() => setFolderOpen((open) => !open)}>
              {folder ? t('rd.onboarding.ready.otherFolder') : t('rd.chat.composer.pickFolder')}
            </Button>
          </div>
          {folderOpen ? <FolderStep chosen={folder} onChoose={setFolder} /> : null}
          {path !== 'claude' ? (
            <div>
              <Button size="sm" variant="secondary" icon="Plus" onClick={() => finish('/settings')}>
                {t('onboarding.klaar.addClaude')}
              </Button>
            </div>
          ) : null}
          <Disclosure label={t('rd.onboarding.choose.compare')} className="fs-onb__more">
            <CapabilityTable chosen={path} hideTitle />
          </Disclosure>
        </div>
      );
    }
  }

  const canContinue = canContinueStep(step, checkup.status, path, ownApiReady);

  return (
    <div className="fs-onb">
      <section ref={cardRef} className="fs-onb__card" aria-labelledby={titleId} data-step={step}>
        <div className="fs-onb__top">
          <span className="fs-onb__lockup">
            <Mark size={28} />
            <b>Forge</b>
            <span>Systeem</span>
          </span>
          <div className="fs-onb__progress">
            <ol className="fs-onb__steps" aria-label={t('onboarding.stepsLabel')}>
              {STEPS.map((id, index) => (
                <li
                  key={id}
                  className={index < stepIndex ? 'is-done' : index === stepIndex ? 'is-on' : undefined}
                  aria-current={id === step ? 'step' : undefined}
                >
                  <span className="fw-visually-hidden">{t(`rd.onboarding.steps.${STEP_LABEL[id]}`)}</span>
                </li>
              ))}
            </ol>
            <span className="fs-onb__stepof" aria-hidden="true">
              {t('rd.onboarding.step', { n: stepIndex + 1, total: STEPS.length })}
            </span>
          </div>
        </div>

        <header className="fs-onb__head">
          <h1 id={titleId} className="fs-onb__title" tabIndex={-1}>
            {title}
          </h1>
          {lead ? <p className="fs-onb__lead">{lead}</p> : null}
        </header>

        <div className="fs-onb__content">{body}</div>

        <div className="fs-onb__foot">
          {stepIndex > 0 ? (
            <Button variant="quiet" icon="ArrowLeft" onClick={() => setStep(previousStep(step))}>
              {t('rd.onboarding.back')}
            </Button>
          ) : null}
          <span className="fs-onb__spacer" />
          {step === 'pad' || step === 'verbinden' ? (
            <Button variant="quiet" onClick={skip}>
              {t('rd.onboarding.skip')}
            </Button>
          ) : null}
          {step === 'klaar' ? (
            <>
              <Button variant="quiet" onClick={() => finish('/', true)}>
                {t('rd.onboarding.ready.look')}
              </Button>
              <Button variant="primary" className="fs-onb__primary" onClick={() => finish('/')}>
                {t('rd.onboarding.ready.begin')}
              </Button>
            </>
          ) : (
            <Button variant="primary" className="fs-onb__primary" disabled={!canContinue} onClick={() => setStep(nextStep(step))}>
              {t('rd.onboarding.next')}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

const STEP_LABEL: Record<StepId, 'welcome' | 'choose' | 'connect' | 'ready'> = {
  detectie: 'welcome',
  pad: 'choose',
  verbinden: 'connect',
  klaar: 'ready',
};
