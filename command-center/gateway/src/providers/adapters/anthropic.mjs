// anthropic adapter: Messages API (POST {base}/v1/messages) with the user's own API key.
//
// Hard rules (catalogue finding 2 and 3):
//   - header anthropic-version comes from the registry;
//   - auth is Authorization: Bearer by default, x-api-key when authHeaderMode is 'x-api-key' (set by the
//     entry when it has one, otherwise by the constructor option);
//   - temperature, top_p and top_k are NEVER sent: under 2026-10-21 they return 400 on every model.
//     They are removed from options AND from options.extraBody, and the removal is reported by
//     buildAnthropicBody() so a caller can tell the user.

import { BaseProvider, resultFromError } from '../provider-base.mjs';
import { requestJSON, requestStream, joinURL } from '../http.mjs';
import { parseSSE, parseEventJSON } from '../stream-parse.mjs';
import { ProviderError, ERROR_CODES } from '../redact-guard.mjs';
import { textEvent, toolCallEvent, anthropicUsage, doneEvent, assistantToolCallArgsObject } from '../events.mjs';

export const FORBIDDEN_SAMPLING_PARAMS = Object.freeze(['temperature', 'top_p', 'top_k']);
const DEFAULT_MAX_TOKENS = 1024;
const RESERVED = new Set(['model', 'messages', 'system', 'stream', 'tools', 'max_tokens', ...FORBIDDEN_SAMPLING_PARAMS]);
const MAX_MODEL_PAGES = 10;

function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  const pushUser = (block) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push(block); // consecutive tool results share one user turn
    } else {
      out.push({ role: 'user', content: [block] });
    }
  };
  for (const m of messages) {
    if (m.role === 'system') { system.push(m.content); continue; }
    if (m.role === 'tool') { pushUser({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }); continue; }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: assistantToolCallArgsObject(tc.arguments) });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system: system.length > 0 ? system.join('\n\n') : undefined, messages: out };
}

function mapToolChoice(choice) {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object' && choice.name) return { type: 'tool', name: choice.name };
  return undefined;
}

export function buildAnthropicBody(req, { stream }) {
  const o = req.options || {};
  const removed = [];
  if (o.temperature !== undefined) removed.push('temperature');
  if (o.topP !== undefined) removed.push('top_p');
  if (o.topK !== undefined) removed.push('top_k');
  const { system, messages } = toAnthropicMessages(req.messages);
  const body = { model: req.model, max_tokens: o.maxTokens || DEFAULT_MAX_TOKENS, messages, stream };
  if (system) body.system = system;
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
  }
  const tc = mapToolChoice(o.toolChoice);
  if (tc) body.tool_choice = tc;
  if (o.stop !== undefined) body.stop_sequences = Array.isArray(o.stop) ? o.stop : [o.stop];
  if (o.extraBody && typeof o.extraBody === 'object') {
    for (const [k, v] of Object.entries(o.extraBody)) {
      if (FORBIDDEN_SAMPLING_PARAMS.includes(k)) { removed.push(k); continue; }
      if (!RESERVED.has(k)) body[k] = v;
    }
  }
  for (const p of FORBIDDEN_SAMPLING_PARAMS) delete body[p]; // belt and braces
  return { body, removed: [...new Set(removed)] };
}

async function* normalizeAnthropicStream(sseEvents, { provider }) {
  const blocks = new Map(); // index -> { kind, id, name, json }
  // Raw Anthropic usage fields, merged from message_start and message_delta (the delta may repeat the
  // cumulative input/cache counts and always carries the final output_tokens).
  const usage = {};
  const mergeUsage = (u) => {
    if (!u) return;
    for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
      if (u[k] !== undefined && u[k] !== null) usage[k] = u[k];
    }
  };
  let stopReason = null;
  let model = null;
  for await (const ev of sseEvents) {
    const obj = parseEventJSON(ev.data, provider);
    const type = obj.type || ev.event;
    if (type === 'message_start') {
      const msg = obj.message || {};
      model = msg.model || null;
      mergeUsage(msg.usage);
    } else if (type === 'content_block_start') {
      const b = obj.content_block || {};
      blocks.set(obj.index, { kind: b.type, id: b.id || null, name: b.name || null, json: '' });
      if (b.type === 'text' && b.text) yield textEvent(b.text);
    } else if (type === 'content_block_delta') {
      const d = obj.delta || {};
      if (d.type === 'text_delta' && d.text) yield textEvent(d.text);
      else if (d.type === 'input_json_delta') { const b = blocks.get(obj.index); if (b) b.json += d.partial_json || ''; }
      // thinking_delta / signature_delta are not surfaced in part 1
    } else if (type === 'content_block_stop') {
      const b = blocks.get(obj.index);
      if (b && b.kind === 'tool_use') yield toolCallEvent({ id: b.id, name: b.name, rawArguments: b.json });
      blocks.delete(obj.index);
    } else if (type === 'message_delta') {
      if (obj.delta && obj.delta.stop_reason) stopReason = obj.delta.stop_reason;
      mergeUsage(obj.usage);
    } else if (type === 'message_stop') {
      yield anthropicUsage(usage);
      yield doneEvent({ stopReason, model });
      return;
    } else if (type === 'error') {
      const e = obj.error || {};
      const code = e.type === 'overloaded_error' || e.type === 'rate_limit_error' ? ERROR_CODES.RATE_LIMIT : ERROR_CODES.HTTP;
      throw new ProviderError(code, (e.type ? e.type + ': ' : '') + (e.message || 'stream error'), { provider, retryable: code === ERROR_CODES.RATE_LIMIT });
    }
    // ping and unknown events are ignored
  }
  throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'stream ended before message_stop', { provider });
}

function* normalizeAnthropicJSON(obj, { provider }) {
  if (!obj || obj.type === 'error') throw new ProviderError(ERROR_CODES.HTTP, (obj && obj.error && obj.error.message) || 'bad response', { provider });
  for (const b of obj.content || []) {
    if (b.type === 'text' && b.text) yield textEvent(b.text);
    else if (b.type === 'tool_use') yield toolCallEvent({ id: b.id, name: b.name, rawArguments: b.input });
  }
  yield anthropicUsage(obj.usage || {});
  yield doneEvent({ stopReason: obj.stop_reason || null, model: obj.model || null });
}

const AUTH_HEADER_MODES = new Set(['bearer', 'x-api-key']);

export class AnthropicProvider extends BaseProvider {
  // authHeaderMode: an entry may fix it ("Eigen API" proxies that only accept x-api-key, ANY-MODEL-PLAN 2.2 B);
  // otherwise the constructor option decides, as before (default Bearer).
  constructor(entry, opts = {}) {
    const fromEntry = entry && entry.authHeaderMode !== undefined && entry.authHeaderMode !== null;
    const mode = fromEntry ? entry.authHeaderMode : opts.authHeaderMode;
    if (mode !== undefined && !AUTH_HEADER_MODES.has(mode)) {
      throw new ProviderError(ERROR_CODES.CONFIG, 'authHeaderMode must be bearer or x-api-key', { provider: entry && entry.id });
    }
    super(entry, { ...opts, authHeaderMode: mode });
  }

  async listModels() {
    if (this.entry.modelsMode !== 'endpoint') return super.listModels(); // a fixed list: no call
    const headers = await this.authHeaders();
    const models = [];
    let afterId = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const query = { limit: 1000 };
      if (afterId) query.after_id = afterId;
      const r = await requestJSON({ url: joinURL(this.baseURL(), this.entry.modelsEndpoint, query), headers, provider: this.id, timeouts: this.timeouts, ...this.transport });
      const data = r.json && Array.isArray(r.json.data) ? r.json.data : null;
      if (!data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'models response has no data array', { provider: this.id });
      for (const m of data) if (typeof m.id === 'string') models.push({ id: m.id, label: m.display_name || null });
      if (r.json.has_more && r.json.last_id) afterId = r.json.last_id; else break;
    }
    return { models, source: 'endpoint' };
  }

  // GET /v1/models?limit=1. Without a models route (a fixed model list, or a proxy that answers 404) the test
  // is ONE message of at most 1 token to the model the caller named; Forge never guesses a billable model.
  async testConnection({ model } = {}) {
    const started = Date.now();
    if (this.entry.modelsMode === 'endpoint') {
      try {
        const r = await requestJSON({ url: joinURL(this.baseURL(), this.entry.modelsEndpoint, { limit: 1 }), headers: await this.authHeaders(), provider: this.id, timeouts: this.timeouts, ...this.transport });
        const count = r.json && Array.isArray(r.json.data) ? r.json.data.length : 0;
        return { ok: true, state: 'connected', latencyMs: Date.now() - started, modelsCount: count, detail: 'GET /v1/models?limit=1 answered' };
      } catch (err) {
        if (!(err && err.code === ERROR_CODES.NOT_FOUND && model)) return resultFromError(err, started);
      }
    }
    if (!model) {
      return { ok: false, state: 'needs-model', latencyMs: null, detail: 'enter a model id to test this provider (it has no models route); the test sends one tiny message' };
    }
    let error = null;
    let done = false;
    for await (const ev of this.chat({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, options: { maxTokens: 1 } })) {
      if (ev.type === 'error') error = ev;
      if (ev.type === 'done') done = true;
    }
    if (error) return resultFromError(new ProviderError(error.code, error.message, { provider: this.id, status: error.status }), started);
    return { ok: done, state: done ? 'connected' : 'error', latencyMs: Date.now() - started, detail: 'one-token message answered' };
  }

  async* _chat(req) {
    const { body } = buildAnthropicBody(req, { stream: req.stream });
    const url = joinURL(this.baseURL(), '/v1/messages');
    const headers = await this.authHeaders();
    const signal = req.options.signal;
    const timeouts = { ...this.timeouts, ...(req.options.timeouts || {}) };
    if (req.stream) {
      const r = await requestStream({ url, headers: { ...headers, accept: 'text/event-stream' }, body, provider: this.id, signal, timeouts, ...this.transport });
      yield* normalizeAnthropicStream(parseSSE(r.chunks), { provider: this.id });
      return;
    }
    const r = await requestJSON({ url, method: 'POST', headers, body, provider: this.id, signal, timeouts, ...this.transport });
    yield* normalizeAnthropicJSON(r.json, { provider: this.id });
  }
}
