// ollama adapter. The registry baseURL is the server ROOT (http://127.0.0.1:11434 or https://ollama.com).
//   chat           -> OpenAI-compatible {root}/v1/chat/completions (quirks: no tool_choice, logprobs, n)
//   chat + numCtx  -> native {root}/api/chat with options.num_ctx, because /v1 cannot carry num_ctx
//   models         -> native GET /api/tags
//   version/health -> native GET /api/version (local only; the cloud entry uses config-only health)
//   pull           -> native POST /api/pull, NDJSON progress (local only)
//   delete         -> native DELETE /api/delete (local only, needs { confirm: true })
//   show           -> native POST /api/show

import { OpenAICompatibleProvider } from './openai-compatible.mjs';
import { resultFromError } from '../provider-base.mjs';
import { requestJSON, requestStream, joinURL } from '../http.mjs';
import { parseNDJSON } from '../stream-parse.mjs';
import { ProviderError, ERROR_CODES } from '../redact-guard.mjs';
import { textEvent, toolCallEvent, usageEvent, doneEvent, assistantToolCallArgsObject } from '../events.mjs';

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PULL_IDLE_TIMEOUT_MS = 5 * 60_000; // a large layer can sit at one percentage for a while

function assertModelName(name, provider) {
  if (typeof name !== 'string' || !MODEL_NAME_RE.test(name)) {
    throw new ProviderError(ERROR_CODES.CONFIG, 'invalid Ollama model name', { provider });
  }
}

function toNativeMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content };
    const out = { role: m.role, content: m.content || '' };
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: assistantToolCallArgsObject(tc.arguments) } }));
    }
    return out;
  });
}

export class OllamaProvider extends OpenAICompatibleProvider {
  chatBaseURL() {
    return this.baseURL() + '/v1';
  }

  _nativeURL(path) {
    return joinURL(this.baseURL(), path);
  }

  _assertLocal(op) {
    if (!this.entry.local) throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED, op + ' is only available for a local Ollama server', { provider: this.id });
  }

  async version() {
    const r = await requestJSON({ url: this._nativeURL('/api/version'), headers: await this.authHeaders(), provider: this.id, timeouts: { ...this.timeouts, connectTimeoutMs: 3000, totalTimeoutMs: 5000 }, maxRetries: 0 });
    return r.json && r.json.version ? String(r.json.version) : null;
  }

  async health() {
    if (!this.entry.local) return super.health(); // cloud: configuration only
    const started = Date.now();
    try {
      const version = await this.version();
      return { ok: true, state: 'reachable', network: true, latencyMs: Date.now() - started, version };
    } catch (err) {
      const r = resultFromError(err, started);
      const detail = r.state === 'unreachable' ? 'Ollama is not running on this PC (' + r.detail + ')' : r.detail;
      return { ...r, network: true, detail };
    }
  }

  async listModels() {
    const r = await requestJSON({ url: this._nativeURL(this.entry.modelsEndpoint), headers: await this.authHeaders(), provider: this.id, timeouts: this.timeouts, ...this.transport });
    const list = r.json && Array.isArray(r.json.models) ? r.json.models : null;
    if (!list) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '/api/tags has no models array', { provider: this.id });
    const models = list.filter((m) => typeof m.name === 'string').map((m) => {
      const d = m.details || {};
      return {
        id: m.name, sizeBytes: Number.isFinite(m.size) ? m.size : null, family: d.family || null,
        parameterSize: d.parameter_size || null, quantization: d.quantization_level || null,
        contextLength: d.context_length || null, capabilities: Array.isArray(m.capabilities) ? m.capabilities : null,
      };
    });
    return { models, source: 'endpoint' };
  }

  async testConnection() {
    const started = Date.now();
    try {
      const { models } = await this.listModels();
      return { ok: true, state: 'connected', latencyMs: Date.now() - started, modelsCount: models.length, detail: models.length === 0 ? 'Ollama answered but has no models yet' : 'Ollama answered' };
    } catch (err) {
      return resultFromError(err, started);
    }
  }

  async show(model) {
    assertModelName(model, this.id);
    const r = await requestJSON({ url: this._nativeURL('/api/show'), method: 'POST', body: { model }, headers: await this.authHeaders(), provider: this.id, timeouts: this.timeouts, maxRetries: 0 });
    const j = r.json || {};
    const info = j.model_info || {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    return { model, capabilities: Array.isArray(j.capabilities) ? j.capabilities : [], details: j.details || {}, contextLength: ctxKey ? info[ctxKey] : null };
  }

  // Async iterator of { status, digest, total, completed }; throws on an { error } line.
  async* pull(model, { signal } = {}) {
    this._assertLocal('pull');
    assertModelName(model, this.id);
    const r = await requestStream({
      url: this._nativeURL('/api/pull'), body: { model, stream: true }, headers: await this.authHeaders(), provider: this.id, signal,
      timeouts: { ...this.timeouts, idleTimeoutMs: PULL_IDLE_TIMEOUT_MS }, maxRetries: 0,
    });
    let success = false;
    for await (const line of parseNDJSON(r.chunks, { provider: this.id })) {
      if (line.error) throw new ProviderError(ERROR_CODES.HTTP, 'pull failed: ' + line.error, { provider: this.id });
      const ev = { status: String(line.status || ''), digest: line.digest || null, total: Number.isFinite(line.total) ? line.total : null, completed: Number.isFinite(line.completed) ? line.completed : null };
      if (ev.status === 'success') success = true;
      yield ev;
    }
    if (!success) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'pull stream ended without success', { provider: this.id });
  }

  async delete(model, { confirm = false } = {}) {
    this._assertLocal('delete');
    assertModelName(model, this.id);
    if (confirm !== true) throw new ProviderError(ERROR_CODES.CONFIG, 'delete needs { confirm: true } (the UI must ask the user first)', { provider: this.id });
    await requestJSON({ url: this._nativeURL('/api/delete'), method: 'DELETE', body: { model }, headers: await this.authHeaders(), provider: this.id, timeouts: this.timeouts, maxRetries: 0 })
      .catch((err) => { if (err.code === ERROR_CODES.BAD_RESPONSE) return null; throw err; }); // 200 with an empty body
    return { ok: true, model };
  }

  async* _chat(req) {
    if (req.options.numCtx === undefined) { yield* super._chat(req); return; }
    yield* this._nativeChat(req);
  }

  async* _nativeChat(req) {
    const o = req.options;
    const options = { num_ctx: o.numCtx };
    if (o.temperature !== undefined) options.temperature = o.temperature;
    if (o.topP !== undefined) options.top_p = o.topP;
    if (o.seed !== undefined) options.seed = o.seed;
    if (o.stop !== undefined) options.stop = Array.isArray(o.stop) ? o.stop : [o.stop];
    if (o.maxTokens !== undefined) options.num_predict = o.maxTokens;
    const body = { model: req.model, messages: toNativeMessages(req.messages), stream: req.stream, options };
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
    }
    const headers = await this.authHeaders();
    const timeouts = { ...this.timeouts, ...(o.timeouts || {}) };
    const lines = req.stream
      ? parseNDJSON((await requestStream({ url: this._nativeURL('/api/chat'), body, headers, provider: this.id, signal: o.signal, timeouts })).chunks, { provider: this.id })
      : (async function* one(p) { yield (await p).json; })(requestJSON({ url: this._nativeURL('/api/chat'), method: 'POST', body, headers, provider: this.id, signal: o.signal, timeouts }));
    let callN = 0;
    for await (const line of lines) {
      if (!line) continue;
      if (line.error) throw new ProviderError(ERROR_CODES.HTTP, String(line.error), { provider: this.id });
      const msg = line.message || {};
      if (typeof msg.content === 'string' && msg.content) yield textEvent(msg.content);
      for (const tc of msg.tool_calls || []) {
        callN += 1;
        yield toolCallEvent({ id: tc.id || 'call_' + callN, name: tc.function && tc.function.name, rawArguments: tc.function ? tc.function.arguments : {} });
      }
      if (line.done) {
        yield usageEvent({ inputTokens: line.prompt_eval_count, outputTokens: line.eval_count });
        yield doneEvent({ stopReason: line.done_reason || 'stop', model: line.model || req.model });
        return;
      }
    }
    throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'native chat stream ended without done', { provider: this.id });
  }
}
