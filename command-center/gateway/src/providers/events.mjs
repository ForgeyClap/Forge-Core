// Normalised chat request and event shapes shared by every adapter.
//
// Request (Provider.chat):
//   { model: string, messages: Message[], stream?: boolean (default true), tools?: Tool[],
//     options?: { maxTokens, temperature, topP, stop, seed, n, toolChoice, responseFormat, logprobs,
//                 parallelToolCalls, numCtx (Ollama), extraBody, timeouts, signal,
//                 cwd (cli-codex, REQUIRED there: absolute working folder of the codex thread),
//                 sandbox (cli-codex: 'read-only' default | 'workspace-write'; never 'danger-full-access'),
//                 idleTimeoutMs (cli-codex: silence allowed inside one turn, default 120 s) } }
//   timeouts = { connectTimeoutMs, firstByteTimeoutMs, totalTimeoutMs, idleTimeoutMs } (http.mjs DEFAULTS)
//   Message = { role: 'system'|'user'|'assistant'|'tool', content: string, name?: string,
//               toolCalls?: [{ id, name, arguments: object|string }], toolCallId?: string }
//   Tool    = { name, description?, parameters?: JSON Schema object }
//   toolChoice = 'auto' | 'none' | 'required' | { name }
//
// Events (async iterator):
//   { type: 'text', text }
//   { type: 'tool_call', id, name, arguments: object|null, rawArguments: string }
//   { type: 'usage', inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteTokens }
//       inputTokens      = ALL input tokens of the request, INCLUDING cache reads and cache writes
//                          (OpenAI prompt_tokens / input_tokens already count cached tokens; Anthropic
//                          input_tokens excludes them, so the adapter adds cache_read_input_tokens and
//                          cache_creation_input_tokens);
//       cachedInputTokens = the part of inputTokens served from a prompt cache (cheaper), or null;
//       cacheWriteTokens  = the part of inputTokens written to a prompt cache (Anthropic bills these at a
//                          premium; OpenAI does not report them), or null;
//       totalTokens       = inputTokens + outputTokens unless the provider gives its own total.
//   { type: 'done', stopReason, model }
//   { type: 'error', code, message, status, retryable, provider }
//   { type: 'approval', ... }   (cli-codex only: a server-side approval request, see codex-app-server.mjs)
// A successful stream ends with exactly one 'done'; a failed one ends with exactly one 'error'.

import { ProviderError, ERROR_CODES } from './redact-guard.mjs';

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_RE = /^[^\s\u0000-\u001f]{1,200}$/;

export function textEvent(text) {
  return { type: 'text', text };
}

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return { arguments: raw, rawArguments: JSON.stringify(raw) };
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return { arguments: {}, rawArguments: text };
  try {
    const v = JSON.parse(text);
    return { arguments: v && typeof v === 'object' ? v : null, rawArguments: text };
  } catch {
    return { arguments: null, rawArguments: text }; // caller still sees the raw text
  }
}

export function toolCallEvent({ id, name, rawArguments }) {
  const parsed = parseToolArguments(rawArguments);
  return { type: 'tool_call', id: id || null, name: name || null, arguments: parsed.arguments, rawArguments: parsed.rawArguments };
}

function num(v) {
  return Number.isFinite(v) ? v : null;
}

export function usageEvent({ inputTokens = null, outputTokens = null, totalTokens = null, cachedInputTokens = null, cacheWriteTokens = null } = {}) {
  const input = num(inputTokens);
  const output = num(outputTokens);
  let total = num(totalTokens);
  if (total === null && input !== null && output !== null) total = input + output;
  return { type: 'usage', inputTokens: input, outputTokens: output, totalTokens: total, cachedInputTokens: num(cachedInputTokens), cacheWriteTokens: num(cacheWriteTokens) };
}

// Anthropic reports uncached, cache-read and cache-written input separately; the normalised inputTokens
// is their sum, so cost accounting compares like with like across adapters.
export function anthropicUsage(u) {
  if (!u) return null;
  const uncached = num(u.input_tokens);
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  const input = uncached === null && read === null && write === null ? null : (uncached || 0) + (read || 0) + (write || 0);
  return usageEvent({ inputTokens: input, outputTokens: u.output_tokens, cachedInputTokens: read, cacheWriteTokens: write });
}

export function doneEvent({ stopReason = null, model = null } = {}) {
  return { type: 'done', stopReason, model };
}

// Validates a chat request up front so an adapter never sends a malformed body.
export function validateChatRequest(req, { provider = null, requireModel = true } = {}) {
  const bad = (m) => new ProviderError(ERROR_CODES.CONFIG, 'invalid chat request: ' + m, { provider });
  if (!req || typeof req !== 'object') throw bad('request must be an object');
  if (requireModel && (typeof req.model !== 'string' || !MODEL_RE.test(req.model))) throw bad('model must be a non-empty id without spaces');
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw bad('messages must be a non-empty array');
  req.messages.forEach((m, i) => {
    if (!m || !ROLES.has(m.role)) throw bad('messages[' + i + '].role must be system|user|assistant|tool');
    if (typeof m.content !== 'string' && !(m.role === 'assistant' && Array.isArray(m.toolCalls))) throw bad('messages[' + i + '].content must be a string');
    if (m.role === 'tool' && typeof m.toolCallId !== 'string') throw bad('messages[' + i + '] (tool) needs toolCallId');
  });
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) throw bad('tools must be an array');
    req.tools.forEach((t, i) => {
      if (!t || !TOOL_NAME_RE.test(t.name || '')) throw bad('tools[' + i + '].name must match ' + TOOL_NAME_RE);
      if (t.parameters !== undefined && (typeof t.parameters !== 'object' || t.parameters === null)) throw bad('tools[' + i + '].parameters must be an object');
    });
  }
  const o = req.options || {};
  if (o.maxTokens !== undefined && !(Number.isInteger(o.maxTokens) && o.maxTokens > 0)) throw bad('options.maxTokens must be a positive integer');
  if (o.numCtx !== undefined && !(Number.isInteger(o.numCtx) && o.numCtx >= 256)) throw bad('options.numCtx must be an integer >= 256');
  return { ...req, stream: req.stream !== false, options: o };
}

export function assistantToolCallArgsString(args) {
  return typeof args === 'string' ? args : JSON.stringify(args || {});
}

export function assistantToolCallArgsObject(args) {
  if (args && typeof args === 'object') return args;
  const parsed = parseToolArguments(args);
  return parsed.arguments || {};
}
