/**
 * message-parts — the constants and small pure helpers `Message.tsx` uses (moved out so that file stays
 * under 500 lines; Q7-CHAT). No behaviour of their own beyond what each doc comment says.
 */

import type { MessageKey } from '@/i18n';
import type { Attachment } from '@/prototype/types/prototype-types';
import type { ChatSendEffort, ChatSendMode } from '@/prototype/state/chat-send';
import type { ChatFileEdit } from '@/prototype/state/gateway-chat';

export const ATTACHMENT_ICON: Readonly<Record<Attachment['kind'], string>> = {
  image: 'Image',
  markdown: 'FileText',
  code: 'FileCode',
  log: 'ScrollText',
  archive: 'FileArchive',
};

export const FOOTER_DETAIL =
  'Example response. The model and skill labels are display strings — nothing was generated and no session was contacted.';

/**
 * feat-model-picker CORRECTION: a real, CLI-verified `--model` value can carry a
 * trailing context-window annotation (e.g. `claude-opus-5[1m]`) that the CLI's own `modelUsage`
 * report always strips back to its plain `canonicalModel` (`exec-stream-parse.mjs`'s
 * `extractResultUsage` already prefers `canonicalModel` over the raw, possibly-bracketed key — see
 * that function's own doc comment). Comparing the raw REQUESTED string against the canonical
 * ACTUALLY-RAN string without normalizing this would flag a genuine, fully-honored request (Opus
 * 1M asked for, Opus 1M ran) as a false "mismatch" on every single send, purely because of this
 * cosmetic naming difference — never for a real difference in what ran. Used ONLY to decide
 * whether a mismatch is real; the chip still DISPLAYS the raw, unaltered `requestedModel` text.
 */
export function stripContextWindowSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

/**
 * fix-stream-insights (checkup #6): a genuine added/removed diff is only possible for an Edit
 * (both `oldString`/`newString` are real) — a Write has no "before" state to diff against (it
 * replaces the whole file), so it never gets a fabricated diff, only its file path below. No line-
 * level diff algorithm is run: this is an honest presentation of the two real strings the CLI
 * itself reported (what it replaced, what it replaced it with), not a computed diff.
 */
export function buildEditDiffText(edit: ChatFileEdit): string | null {
  if (edit.oldString === null || edit.newString === null) return null;
  const removed = edit.oldString.split('\n').map((line) => `- ${line}`);
  const added = edit.newString.split('\n').map((line) => `+ ${line}`);
  return [...removed, ...added].join('\n');
}

/**
 * composer-modes-ui: a mode chip for every non-default mode the turn genuinely ran in — 'execute'
 * (the default) has no entry and therefore never shows a chip, exactly like before this feature
 * widened the mode set from Execute|Plan. Only ever read from `readChatMessageMode`'s own real,
 * gateway-carried value; never guessed from the composer's current selection (which only
 * describes the NEXT send, not a past one).
 */
export const MODE_CHIP_TEXT: Readonly<Partial<Record<ChatSendMode, MessageKey>>> = {
  plan: 'chat.message.chipPlan',
  'accept-edits': 'chat.message.chipAcceptEdits',
  bypass: 'chat.message.chipBypass',
};

export const MODE_CHIP_TITLE: Readonly<Partial<Record<ChatSendMode, MessageKey>>> = {
  plan: 'chat.message.chipPlanTitle',
  'accept-edits': 'chat.message.chipAcceptEditsTitle',
  bypass: 'chat.message.chipBypassTitle',
};

/** composer-modes-ui: the effort chip's own display text, uppercased for the same chip style as
 *  the mode chips. Only ever read from `readChatMessageEffort`'s own real, gateway-carried value. */
export const EFFORT_CHIP_TEXT: Readonly<Record<ChatSendEffort, MessageKey>> = {
  low: 'chat.message.effortLow',
  medium: 'chat.message.effortMedium',
  high: 'chat.message.effortHigh',
  xhigh: 'chat.message.effortXhigh',
  max: 'chat.message.effortMax',
};

const NL_TIME = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** WP B3: in Dutch a recorded ISO moment reads as "2 nov, 10:15"; anything else stays as it is. */
export function displayTime(value: string, locale: string): string {
  if (locale !== 'nl' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? NL_TIME.format(new Date(ms)) : value;
}
