// openai-compatible adapter: one class for every provider that speaks the OpenAI HTTP dialect,
// with apiStyle 'chat-completions' (POST {base}/chat/completions) or 'responses' (POST {base}/responses).
//
// testConnection (catalogue section 5): GET {base}{modelsEndpoint} with auth. When the registry says
// testCall 'chat-1-token', or the models route answers 404, it falls back to a minimal chat
// (max 1 token for chat-completions, 16 for responses, the smallest value OpenAI accepts there) and
// only when the caller supplied a model id: Forge never guesses a billable model.

import { BaseProvider, resultFromError } from '../provider-base.mjs';
import { requestJSON, requestStream, joinURL } from '../http.mjs';
import { parseSSE } from '../stream-parse.mjs';
import { ProviderError, ERROR_CODES } from '../redact-guard.mjs';
import { buildChatCompletionsBody, buildResponsesBody } from './openai-format.mjs';
import {
  normalizeChatCompletionsStream, normalizeChatCompletionsJSON, normalizeResponsesStream, normalizeResponsesJSON,
} from './openai-stream.mjs';

const MAX_MODEL_PAGES = 20;

export class OpenAICompatibleProvider extends BaseProvider {
  // Base URL used for the OpenAI-style routes (Ollama overrides this to {root}/v1).
  chatBaseURL() {
    return this.baseURL();
  }

  async health() {
    if (!this.entry.local) return super.health();
    const started = Date.now();
    try {
      const path = this.entry.healthPath || this.entry.modelsEndpoint || '/models';
      const url = this.entry.healthPath ? joinURL(new URL(this.baseURL()).origin, path) : joinURL(this.chatBaseURL(), path);
      await requestJSON({ url, headers: await this.authHeaders(), provider: this.id, timeouts: { ...this.timeouts, connectTimeoutMs: 3000, totalTimeoutMs: 5000 }, maxRetries: 0 }).catch((err) => {
        if (err.code === ERROR_CODES.BAD_RESPONSE) return null; // reachable, body not JSON (llama.cpp /health may be text)
        throw err;
      });
      return { ok: true, state: 'reachable', network: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ...resultFromError(err, started), network: true };
    }
  }

  async listModels() {
    const e = this.entry;
    if (e.modelsMode !== 'endpoint') return super.listModels();
    const headers = await this.authHeaders();
    const models = [];
    let after = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const r = await requestJSON({ url: joinURL(this.chatBaseURL(), e.modelsEndpoint, after ? { after } : undefined), headers, provider: this.id, timeouts: this.timeouts, ...this.transport });
      const data = r.json && Array.isArray(r.json.data) ? r.json.data : (r.json && Array.isArray(r.json.models) ? r.json.models : null);
      if (!data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'models response has no data array', { provider: this.id });
      for (const m of data) {
        const id = m.id || m.name;
        if (typeof id === 'string') models.push({ id, ownedBy: m.owned_by || null, contextLength: m.context_length || m.context_window || null });
      }
      if (r.json.has_more && r.json.last_id) after = r.json.last_id; else break;
    }
    return { models, source: 'endpoint' };
  }

  async testConnection({ model } = {}) {
    const started = Date.now();
    const e = this.entry;
    if (e.testCall === 'models' && e.modelsMode === 'endpoint') {
      try {
        const { models } = await this.listModels();
        return { ok: true, state: 'connected', latencyMs: Date.now() - started, modelsCount: models.length, detail: 'models route answered' };
      } catch (err) {
        if (!(err.code === ERROR_CODES.NOT_FOUND && model)) return resultFromError(err, started);
        // models route missing: fall through to the 1-token chat with the caller's model
      }
    }
    if (!model) {
      return { ok: false, state: 'needs-model', latencyMs: null, detail: 'enter a model id to test this provider (it has no models route); the test sends one tiny chat' };
    }
    return this._chatProbe(model, started);
  }

  async _chatProbe(model, started) {
    const maxTokens = this.entry.apiStyle === 'responses' ? 16 : 1;
    let error = null;
    let done = false;
    for await (const ev of this.chat({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, options: { maxTokens } })) {
      if (ev.type === 'error') error = ev;
      if (ev.type === 'done') done = true;
    }
    if (error) return resultFromError(new ProviderError(error.code, error.message, { provider: this.id, status: error.status }), started);
    return { ok: done, state: done ? 'connected' : 'error', latencyMs: Date.now() - started, detail: 'one-token chat answered' };
  }

  async* _chat(req) {
    const e = this.entry;
    const q = e.quirks || {};
    const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
    let stream = req.stream;
    if (stream && hasTools && q.noToolsWhileStreaming) stream = false; // DashScope: tools need stream=false
    const isResponses = e.apiStyle === 'responses';
    const { body } = isResponses ? buildResponsesBody(e, req, { stream }) : buildChatCompletionsBody(e, req, { stream });
    const url = joinURL(this.chatBaseURL(), isResponses ? '/responses' : '/chat/completions');
    const headers = await this.authHeaders();
    const signal = req.options.signal;
    const timeouts = { ...this.timeouts, ...(req.options.timeouts || {}) };
    if (stream) {
      const r = await requestStream({ url, headers: { ...headers, accept: 'text/event-stream' }, body, provider: this.id, signal, timeouts, ...this.transport });
      const sse = parseSSE(r.chunks);
      yield* (isResponses ? normalizeResponsesStream(sse, { provider: this.id }) : normalizeChatCompletionsStream(sse, { provider: this.id }));
      return;
    }
    const r = await requestJSON({ url, method: 'POST', headers, body, provider: this.id, signal, timeouts, ...this.transport });
    yield* (isResponses ? normalizeResponsesJSON(r.json, { provider: this.id }) : normalizeChatCompletionsJSON(r.json, { provider: this.id }));
  }
}
