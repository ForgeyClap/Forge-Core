/**
 * mode-controls — the composer's Auto-plan / Effort / Model / Send-mode controls.
 *
 * refactor-chat-split: split out of `Composer.tsx` — this component
 * (not the STATE it displays, which stays in `Composer.tsx`; see that file's own header for why) is
 * a pure, controlled presentational unit: every choice and every setter is a prop. Pure structural
 * move: no behavior changed, no class name changed.
 *
 * feat-model-picker: the Model `MenuButton` was added alongside Effort (same component, same
 * popover, no new style language) so the composer can also pick which model the next send runs
 * with — see `Composer.tsx`'s own header for the full state-plumbing story and
 * `gateway/src/server.mjs`'s `EXEC_MODEL_VALUES` for the real allowlist this mirrors.
 */

import { SegmentedControl, Switch } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import type { ChatSendMode } from '@/prototype/state/chat-send';

import { isChatSendEffort, isChatSendMode, isChatSendModel } from './compose-args';
import { MenuButton } from './menu-button';
import type { MenuOption } from './menu-button';
import type { EffortChoice, ModelChoice } from './mode-storage';

/**
 * composer-modes-ui: the full permission-mode set Claude Code's own picker offers, widened from
 * fix-ui-clutter's original Execute|Plan pair — mirrors `ChatSendMode` exactly, same
 * SegmentedControl style.
 *
 * WP B3 rule (plan §4.4): a project's first send defaults to Accept edits ("Mag aanpassen"), never
 * Bypass. Bypass ("Volledige toegang") is offered only in Uitgebreid and only after a one-time
 * confirmation per project (`mode-storage.ts` `confirmBypass`); a stored bypass without that
 * confirmation sends as Accept edits. `Composer.tsx`'s hint paragraph states plainly when Bypass is
 * active; Plan's real limitation (no tool calls at all, so it can never ask a clarifying question)
 * gets the same always-visible treatment there.
 */
const SEND_MODE_OPTIONS: readonly { readonly value: ChatSendMode; readonly labelKey: MessageKey }[] = [
  { value: 'execute', labelKey: 'chat.modes.execute' },
  { value: 'plan', labelKey: 'chat.modes.plan' },
  { value: 'accept-edits', labelKey: 'chat.modes.acceptEdits' },
  { value: 'bypass', labelKey: 'chat.modes.fullAccess' },
];

const EFFORT_IDS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortChoice[];

const EFFORT_LABEL_KEYS: Readonly<Record<EffortChoice, MessageKey>> = {
  default: 'chat.modes.thinking.default',
  low: 'chat.modes.thinking.low',
  medium: 'chat.modes.thinking.medium',
  high: 'chat.modes.thinking.high',
  xhigh: 'chat.modes.thinking.xhigh',
  max: 'chat.modes.thinking.max',
};

/**
 * feat-model-picker: the composer's model picker — reuses `MenuButton`'s existing label+detail+
 * checkmark layout (no new style language), one option per real `ModelChoice` with a short title and
 * a one-line description underneath. "Default (recommended)" is first and omits `--model` entirely —
 * see `mode-storage.ts`'s `ModelChoice` doc comment. The trigger shows only the SHORT name
 * (`MODEL_TRIGGER_LABELS`); the fuller "(1M context)"/"(recommended)" qualifiers only ever appear
 * inside the open menu.
 *
 * "Opus (1M context)" sends `'claude-opus-5-5[1m]'` — real, non-mock CLI runs proved the
 * bracket-suffixed id is accepted `--model` INPUT (see `gateway/src/server.mjs`'s own
 * `EXEC_MODEL_VALUES` comment). "Default" omits `--model`, so the CLI uses the configured session
 * default. WP B0b: the visible copy lives in the locale files (`chat.modes.model.*`).
 */
const MODEL_OPTION_KEYS: readonly {
  readonly id: ModelChoice;
  readonly labelKey: MessageKey;
  readonly detailKey: MessageKey;
}[] = [
  { id: 'default', labelKey: 'chat.modes.model.defaultLabel', detailKey: 'chat.modes.model.defaultDetail' },
  { id: 'claude-opus-5-5[1m]', labelKey: 'chat.modes.model.opusLabel', detailKey: 'chat.modes.model.opusDetail' },
  { id: 'claude-fable-5-1', labelKey: 'chat.modes.model.fableLabel', detailKey: 'chat.modes.model.fableDetail' },
  { id: 'claude-sonnet-5-5', labelKey: 'chat.modes.model.sonnetLabel', detailKey: 'chat.modes.model.sonnetDetail' },
  { id: 'claude-haiku-4-5-20251001', labelKey: 'chat.modes.model.haikuLabel', detailKey: 'chat.modes.model.haikuDetail' },
];

// The default-state trigger text is deliberately the picker's own name ('Model'), not 'Default' — the
// Effort trigger right next to it ALREADY legitimately shows 'Default' at ITS own default choice, and
// RTL's/screen-readers' accessible-name lookup is by visible text: two sibling buttons with the same
// name would be genuinely ambiguous to a keyboard/screen-reader user. Model names are proper nouns
// and stay untranslated.
const MODEL_TRIGGER_LABELS: Readonly<Record<Exclude<ModelChoice, 'default'>, string>> = {
  'claude-opus-5-5[1m]': 'Opus',
  'claude-fable-5-1': 'Fable',
  'claude-sonnet-5-5': 'Sonnet',
  'claude-haiku-4-5-20251001': 'Haiku',
};

export interface ComposerModeControlsProps {
  readonly autoPlan: boolean;
  readonly onAutoPlanChange: (value: boolean) => void;
  readonly effortChoice: EffortChoice;
  readonly onEffortChoiceChange: (choice: EffortChoice) => void;
  readonly modelChoice: ModelChoice;
  readonly onModelChoiceChange: (choice: ModelChoice) => void;
  readonly sendMode: ChatSendMode;
  readonly onSendModeChange: (mode: ChatSendMode) => void;
  /** WP B3: "Volledige toegang" is offered only in Uitgebreid (plan §4.2). Defaults to hidden. */
  readonly showBypass?: boolean;
  /** Lead decision 2026-11-02 (plan §4.2): Denkkracht and Automatisch plannen are Uitgebreid only. Defaults to hidden. */
  readonly showEffortAndAutoPlan?: boolean;
}

/**
 * Auto-plan switch + Effort menu (both Uitgebreid only) + Model menu + Send-mode segmented control. Returns a Fragment (never a
 * wrapping element) so all three stay direct flex children of `Composer.tsx`'s own
 * `.fw-chat-composer__row`, exactly as before this split.
 */
export function ComposerModeControls({
  autoPlan,
  onAutoPlanChange,
  effortChoice,
  onEffortChoiceChange,
  modelChoice,
  onModelChoiceChange,
  sendMode,
  onSendModeChange,
  showBypass = false,
  showEffortAndAutoPlan = false,
}: ComposerModeControlsProps) {
  const { t } = useLocale();
  const sendModeOptions = SEND_MODE_OPTIONS.filter((option) => showBypass || option.value !== 'bypass').map((option) => ({ value: option.value, label: t(option.labelKey) }));
  const effortOptions: readonly MenuOption[] = EFFORT_IDS.map((id) => ({
    id,
    icon: 'Gauge',
    label: t(EFFORT_LABEL_KEYS[id]),
  }));
  const modelOptions: readonly MenuOption[] = MODEL_OPTION_KEYS.map((option) => ({
    id: option.id,
    icon: 'Cpu',
    label: t(option.labelKey),
    detail: t(option.detailKey),
  }));
  const modelTrigger = modelChoice === 'default' ? t('chat.modes.modelLabel') : MODEL_TRIGGER_LABELS[modelChoice];

  return (
    <>
      {showEffortAndAutoPlan ? (
        <>
          <Switch
            checked={autoPlan}
            onChange={onAutoPlanChange}
            label={t('chat.modes.autoPlan')}
            size="sm"
            className="fw-chat-composer__autoplan"
          />

          <MenuButton
            icon="Gauge"
            label={t('chat.modes.thinkingLabel')}
            title={t('chat.modes.thinkingLabel')}
            options={effortOptions}
            triggerLabel={t(EFFORT_LABEL_KEYS[effortChoice])}
            selectedId={effortChoice}
            footer={t('chat.modes.thinkingFooter')}
            onPick={(option) => onEffortChoiceChange(isChatSendEffort(option.id) ? option.id : 'default')}
          />
        </>
      ) : null}

      <MenuButton
        icon="Cpu"
        label={t('chat.modes.modelLabel')}
        title={t('chat.modes.modelTitle')}
        options={modelOptions}
        triggerLabel={modelTrigger}
        selectedId={modelChoice}
        footer={t('chat.modes.modelFooter')}
        onPick={(option) => onModelChoiceChange(isChatSendModel(option.id) ? option.id : 'default')}
      />

      <SegmentedControl
        options={sendModeOptions}
        value={sendMode}
        onChange={(next) => onSendModeChange(isChatSendMode(next) ? next : 'execute')}
        label={t('chat.modes.sendModeLabel')}
        size="sm"
        className="fw-chat-composer__mode"
      />
    </>
  );
}
