// Public entry point of the provider layer (WP B2 part 1). Side-effect free: nothing is loaded,
// spawned or fetched on import. The gateway calls loadRegistry() once at startup (fail loud) and
// createProvider() per Accounts card / chat. See README.md for the interface and the wiring plan.

import { loadRegistry, resolveBaseURL, RegistryError } from './registry.mjs';
import { EnvKeyProvider, MemoryKeyProvider, ChainKeyProvider } from './key-provider.mjs';
import { ProviderError, ERROR_CODES, Redactor, sharedRedactor, redactText } from './redact-guard.mjs';
import { OpenAICompatibleProvider } from './adapters/openai-compatible.mjs';
import { AnthropicProvider } from './adapters/anthropic.mjs';
import { GeminiNativeProvider } from './adapters/gemini-native.mjs';
import { OllamaProvider } from './adapters/ollama.mjs';
import { ClaudeCliProvider } from './cli/cli-claude.mjs';
import { CodexCliProvider } from './cli/cli-codex.mjs';
import { GenericCliProvider } from './cli/cli-generic.mjs';

const ADAPTERS = Object.freeze({
  'openai-compatible': OpenAICompatibleProvider,
  anthropic: AnthropicProvider,
  'gemini-native': GeminiNativeProvider,
  ollama: OllamaProvider,
  'cli-claude': ClaudeCliProvider,
  'cli-codex': CodexCliProvider,
  'cli-generic': GenericCliProvider,
});

// createProvider(idOrEntry, { keyProvider, vars, timeouts, registry, ... }) -> Provider
export function createProvider(idOrEntry, opts = {}) {
  const registry = opts.registry || loadRegistry();
  const entry = typeof idOrEntry === 'string' ? registry.get(idOrEntry) : idOrEntry;
  if (!entry) throw new ProviderError(ERROR_CODES.CONFIG, 'unknown provider id');
  const Adapter = ADAPTERS[entry.adapter];
  if (!Adapter) throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED, 'no adapter for ' + entry.adapter, { provider: entry.id });
  return new Adapter(entry, { ...opts, keyProvider: opts.keyProvider || new EnvKeyProvider() });
}

export function adapterNames() {
  return Object.keys(ADAPTERS);
}

export {
  loadRegistry, resolveBaseURL, RegistryError,
  EnvKeyProvider, MemoryKeyProvider, ChainKeyProvider,
  ProviderError, ERROR_CODES, Redactor, sharedRedactor, redactText,
  OpenAICompatibleProvider, AnthropicProvider, GeminiNativeProvider, OllamaProvider,
  ClaudeCliProvider, CodexCliProvider, GenericCliProvider,
};
