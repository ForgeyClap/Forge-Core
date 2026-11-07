// Normalisers from OpenAI-style responses (streamed and buffered) to the events in events.mjs.

import { parseEventJSON } from '../stream-parse.mjs';
import { textEvent, toolCallEvent, usageEvent, doneEvent } from '../events.mjs';
import { ProviderError, ERROR_CODES } from '../redact-guard.mjs';

function chatUsage(u) {
  if (!u) return null;
  return usageEvent({
    inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens,
    cachedInputTokens: u.prompt_tokens_details ? u.prompt_tokens_details.cached_tokens : undefined,
  });
}

function responsesUsage(u) {
  if (!u) return null;
  return usageEvent({
    inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens,
    cachedInputTokens: u.input_tokens_details ? u.input_tokens_details.cached_tokens : undefined,
  });
}

function streamError(obj, provider) {
  const e = obj.error || obj;
  const message = typeof e === 'string' ? e : (e && e.message) || 'provider reported an error in the stream';
  const status = e && Number.isInteger(e.code) ? e.code : null;
  return new ProviderError(status === 429 ? ERROR_CODES.RATE_LIMIT : ERROR_CODES.HTTP, message, { provider, status });
}

// chat-completions SSE -> events
export async function* normalizeChatCompletionsStream(sseEvents, { provider }) {
  const calls = new Map(); // index -> { id, name, args }
  let finishReason = null;
  let model = null;
  let usage = null;
  let sawDone = false;
  for await (const ev of sseEvents) {
    if (ev.data === '[DONE]') { sawDone = true; break; }
    const obj = parseEventJSON(ev.data, provider);
    if (obj && obj.error) throw streamError(obj, provider);
    if (obj.model) model = obj.model;
    if (obj.usage) usage = chatUsage(obj.usage);
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) yield textEvent(delta.content);
    for (const tc of delta.tool_calls || []) {
      const idx = Number.isInteger(tc.index) ? tc.index : calls.size;
      const cur = calls.get(idx) || { id: null, name: null, args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function && tc.function.name) cur.name = (cur.name || '') + tc.function.name;
      if (tc.function && typeof tc.function.arguments === 'string') cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!sawDone && !finishReason) {
    throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'stream ended before the model finished', { provider });
  }
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) yield toolCallEvent({ id: c.id, name: c.name, rawArguments: c.args });
  if (usage) yield usage;
  yield doneEvent({ stopReason: finishReason, model });
}

// buffered chat-completions JSON -> events
export function* normalizeChatCompletionsJSON(obj, { provider }) {
  if (!obj || obj.error) throw streamError(obj || {}, provider);
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (!choice) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'response has no choices', { provider });
  const msg = choice.message || {};
  if (typeof msg.content === 'string' && msg.content.length > 0) yield textEvent(msg.content);
  for (const tc of msg.tool_calls || []) {
    yield toolCallEvent({ id: tc.id, name: tc.function && tc.function.name, rawArguments: tc.function ? tc.function.arguments : '' });
  }
  const u = chatUsage(obj.usage);
  if (u) yield u;
  yield doneEvent({ stopReason: choice.finish_reason || null, model: obj.model || null });
}

// responses SSE -> events
export async function* normalizeResponsesStream(sseEvents, { provider }) {
  const pending = new Map(); // item id -> { callId, name, args }
  let completed = false;
  for await (const ev of sseEvents) {
    if (ev.data === '[DONE]') break;
    const obj = parseEventJSON(ev.data, provider);
    const type = obj.type || ev.event;
    switch (type) {
      case 'response.output_text.delta':
        if (typeof obj.delta === 'string' && obj.delta) yield textEvent(obj.delta);
        break;
      case 'response.output_item.added':
        if (obj.item && obj.item.type === 'function_call') {
          pending.set(obj.item.id, { callId: obj.item.call_id, name: obj.item.name, args: obj.item.arguments || '' });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const cur = pending.get(obj.item_id);
        if (cur && typeof obj.delta === 'string') cur.args += obj.delta;
        break;
      }
      case 'response.output_item.done':
        if (obj.item && obj.item.type === 'function_call') {
          const cur = pending.get(obj.item.id) || {};
          pending.delete(obj.item.id);
          const raw = typeof obj.item.arguments === 'string' && obj.item.arguments ? obj.item.arguments : cur.args || '';
          yield toolCallEvent({ id: obj.item.call_id || cur.callId, name: obj.item.name || cur.name, rawArguments: raw });
        }
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const r = obj.response || {};
        const u = responsesUsage(r.usage);
        if (u) yield u;
        const reason = type === 'response.incomplete'
          ? 'incomplete' + (r.incomplete_details && r.incomplete_details.reason ? ':' + r.incomplete_details.reason : '')
          : (r.status || 'completed');
        yield doneEvent({ stopReason: reason, model: r.model || null });
        completed = true;
        break;
      }
      case 'response.failed':
        throw streamError((obj.response && obj.response.error) ? { error: obj.response.error } : obj, provider);
      case 'error':
        throw streamError(obj, provider);
      default:
        break; // created, in_progress, content_part.*, reasoning.* ... not surfaced
    }
    if (completed) return;
  }
  if (!completed) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'stream ended without response.completed', { provider });
}

// buffered responses JSON -> events
export function* normalizeResponsesJSON(obj, { provider }) {
  if (!obj || obj.error) throw streamError(obj || {}, provider);
  for (const item of obj.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) if (part.type === 'output_text' && part.text) yield textEvent(part.text);
    } else if (item.type === 'function_call') {
      yield toolCallEvent({ id: item.call_id, name: item.name, rawArguments: item.arguments });
    }
  }
  const u = responsesUsage(obj.usage);
  if (u) yield u;
  yield doneEvent({ stopReason: obj.status || null, model: obj.model || null });
}
