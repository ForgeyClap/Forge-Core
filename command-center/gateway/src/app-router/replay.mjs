// App router — the context handover when a conversation moves to another target (design 4.6).
//
// A Claude session lives in the profile folder it ran in, and a provider has no session at all, so on
// every target change the first turn on the new target gets the conversation's own recent messages.
// Input: the stored records (already redacted on write; redacted again here). Failed and superseded
// assistant attempts are left out. The newest messages are kept; older ones are dropped with a
// marker. Size cap: 24,000 chars for Claude Code / Codex targets; for a local model about 3 chars per
// token at a 60 % share of num_ctx, so the model never silently cuts the context.
import { redact } from '../redact.mjs';
import { LIMITS } from './contract.mjs';

export const OLDER_OMITTED_MARKER = '(oudere berichten weggelaten)';
const HEADER = 'Context: the most recent messages of this conversation so far. It continued here from another account or model, so earlier details may be missing.';
const FOOTER = 'End of the earlier messages.';
const SYSTEM_NOTE = 'You are continuing a conversation that started elsewhere. Earlier messages are included below when available. You can only answer in text: you cannot edit files or run commands.';
const CUT = ' …';
const SEP = '\n\n';

const label = (role) => (role === 'user' ? 'User: ' : 'Assistant: ');

/**
 * Char cap for a handover to a target of this kind.
 * @param {{kind?: string, numCtx?: number|null}} opts
 */
export function handoverCharCap({ kind = 'claude-account', numCtx = null } = {}) {
  if (kind !== 'provider-model') return LIMITS.HANDOVER_CLI_MAX_CHARS;
  const ctx = Number.isInteger(numCtx) && numCtx > 0 ? numCtx : LIMITS.NUM_CTX_DEFAULT;
  return Math.min(LIMITS.HANDOVER_CLI_MAX_CHARS, Math.floor(ctx * LIMITS.HANDOVER_CHARS_PER_TOKEN * LIMITS.HANDOVER_CTX_SHARE));
}

function failedAttempt(r) {
  if (r.error) return true;
  const route = r.route && typeof r.route === 'object' ? r.route : null;
  if (route && (route.retried === true || (typeof route.outcome === 'string' && route.outcome !== 'ok'))) return true;
  return typeof r.text !== 'string' || r.text.trim().length === 0;
}

/** Messages in order, failed attempts out, one kept reply per turn, same-role neighbours merged. */
function collectMessages(records, excludeTurnId) {
  const turns = Array.isArray(records) ? records.filter((r) => r && r.type === 'turn' && r.turn_id !== excludeTurnId) : [];
  const lastGoodReply = new Map();
  for (const r of turns) if (r.role === 'assistant' && !failedAttempt(r)) lastGoodReply.set(r.turn_id, r);
  const out = [];
  const seenReply = new Set();
  for (const r of turns) {
    let text = null;
    if (r.role === 'user' && typeof r.text === 'string' && r.text.trim()) text = r.text;
    if (r.role === 'assistant' && lastGoodReply.get(r.turn_id) === r && !seenReply.has(r.turn_id)) {
      seenReply.add(r.turn_id);
      text = r.text;
    }
    if (text === null) continue;
    const content = redact(text.trim());
    const prev = out[out.length - 1];
    if (prev && prev.role === r.role) prev.content += SEP + content;
    else out.push({ role: r.role, content });
  }
  return out;
}

function render(history, truncated) {
  if (history.length === 0) return '';
  const parts = [HEADER];
  if (truncated) parts.push(OLDER_OMITTED_MARKER);
  for (const m of history) parts.push(label(m.role) + m.content);
  parts.push(FOOTER);
  return parts.join(SEP);
}

/**
 * Builds the handover for the first turn on a new target.
 * @param {object[]} records  the conversation's stored records (readConversation().records shape)
 * @param {{maxTurns?: number, maxChars?: number, kind?: string, numCtx?: number|null, excludeTurnId?: string|null}} [opts]
 *   maxTurns = defaults.handover_turns (messages kept); maxChars defaults to handoverCharCap(kind, numCtx);
 *   excludeTurnId = the turn being sent now (its user text is already stored)
 * @returns {{turns: number, chars: number, truncated: boolean, history: Array<{role:'user'|'assistant', content:string}>, text: string}}
 *   `text` is the plain-text block for a Claude Code target (stdin context) or the codex fold;
 *   `history` feeds toProviderMessages(). `chars` = text.length.
 */
export function buildHandover(records, { maxTurns = LIMITS.HANDOVER_TURNS_DEFAULT, maxChars, kind = 'claude-account', numCtx = null, excludeTurnId = null } = {}) {
  const cap = Math.min(Number.isInteger(maxChars) && maxChars > 0 ? maxChars : Infinity, handoverCharCap({ kind, numCtx }));
  const all = collectMessages(records, excludeTurnId);
  const history = all.slice(-Math.max(1, maxTurns));
  return fit(history, history.length < all.length, cap);
}

/** Drops the oldest messages until the rendered block fits; cuts the newest one if it alone is too long. */
function fit(input, alreadyTruncated, cap) {
  let history = input;
  let truncated = alreadyTruncated;
  while (history.length > 1 && render(history, true).length > cap) {
    history = history.slice(1);
    truncated = true;
  }
  if (history.length === 1 && render(history, truncated).length > cap) {
    const overhead = render([{ ...history[0], content: '' }], true).length + CUT.length;
    history = [{ ...history[0], content: history[0].content.slice(0, Math.max(0, cap - overhead)) + CUT }];
    truncated = true;
  }
  const text = render(history, truncated);
  return { turns: history.length, chars: text.length, truncated, history, text };
}

/**
 * Messages for a provider chat: a system note, the alternating history, the new user message last.
 * A history that ends on a user message is merged with the new one so roles keep alternating.
 */
export function toProviderMessages(handover, userText) {
  const msgs = [{ role: 'system', content: SYSTEM_NOTE }];
  const history = handover && Array.isArray(handover.history) ? handover.history : [];
  if (handover && handover.truncated && history.length > 0) msgs[0] = { role: 'system', content: SYSTEM_NOTE + ' ' + OLDER_OMITTED_MARKER };
  for (const m of history) msgs.push({ role: m.role, content: m.content });
  const last = msgs[msgs.length - 1];
  if (last.role === 'user') last.content += SEP + userText;
  else msgs.push({ role: 'user', content: userText });
  return msgs;
}

/** Codex sends only one user message: the handover block first, the new text last. */
export function toCodexPrompt(handover, userText) {
  const text = handover && typeof handover.text === 'string' ? handover.text : '';
  return text ? text + SEP + userText : userText;
}

/** Fallback when stdin cannot carry the context: a prefix in the prompt argument, capped at 6,000 chars. */
export function toPromptPrefix(handover, userText, { maxChars = LIMITS.HANDOVER_ARG_MAX_CHARS } = {}) {
  if (!handover || !Array.isArray(handover.history) || handover.history.length === 0) return userText;
  return fit(handover.history, handover.truncated === true, maxChars).text + SEP + userText;
}
