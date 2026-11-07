// gemini-native adapter: model listing and Test only.
//
// The catalogue could not confirm generateContent / streamGenerateContent on the pages it
// read, and this lane had no way to verify them (no web access, no key). Per the work package, chat is
// therefore NOT implemented here: chat() yields one NOT_IMPLEMENTED error that points at the
// 'gemini-openai' provider, which uses the verified OpenAI-compatible endpoint with the same key.
// The key goes in the x-goog-api-key header, never in a ?key= query (a URL ends up in logs).

import { BaseProvider, resultFromError } from '../provider-base.mjs';
import { requestJSON, joinURL } from '../http.mjs';
import { ProviderError, ERROR_CODES } from '../redact-guard.mjs';

const MAX_MODEL_PAGES = 10;

export class GeminiNativeProvider extends BaseProvider {
  async listModels() {
    const headers = await this.authHeaders();
    const models = [];
    let pageToken = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const query = { pageSize: 1000 };
      if (pageToken) query.pageToken = pageToken;
      const r = await requestJSON({ url: joinURL(this.baseURL(), this.entry.modelsEndpoint, query), headers, provider: this.id, timeouts: this.timeouts, ...this.transport });
      const list = r.json && Array.isArray(r.json.models) ? r.json.models : null;
      if (!list) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'models response has no models array', { provider: this.id });
      for (const m of list) {
        if (typeof m.name !== 'string') continue;
        models.push({
          id: m.name.replace(/^models\//, ''), label: m.displayName || null, contextLength: m.inputTokenLimit || null,
          methods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
        });
      }
      if (r.json.nextPageToken) pageToken = r.json.nextPageToken; else break;
    }
    return { models, source: 'endpoint' };
  }

  async testConnection() {
    const started = Date.now();
    try {
      const r = await requestJSON({ url: joinURL(this.baseURL(), this.entry.modelsEndpoint, { pageSize: 1 }), headers: await this.authHeaders(), provider: this.id, timeouts: this.timeouts, ...this.transport });
      const count = r.json && Array.isArray(r.json.models) ? r.json.models.length : 0;
      return { ok: true, state: 'connected', latencyMs: Date.now() - started, modelsCount: count, detail: 'GET /v1beta/models answered' };
    } catch (err) {
      return resultFromError(err, started);
    }
  }

  // eslint-disable-next-line require-yield
  async* _chat() {
    throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED,
      'native Gemini chat (generateContent) is not implemented: not verified on 2026-11-01. Use the provider gemini-openai with the same key.',
      { provider: this.id });
  }
}
