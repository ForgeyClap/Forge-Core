// Request builders for the openai-compatible adapter (chat-completions and responses) plus the
// per-provider quirks table taken from the registry (entry.quirks):
//   dropParams           remove these body fields (Ollama: tool_choice, logprobs, n; Cohere: store, ...)
//   forceN1              n is always 1 (Groq, Cerebras, SambaNova)
//   dropMessageName      strip messages[].name (Groq 400s on it)
//   temperatureFloor     a lower temperature is raised to this value (Groq: 0 -> 1e-8)
//   renameParams         { from: to } (Mistral: seed -> random_seed)
//   streamUsageOption    send stream_options.include_usage on streamed chat-completions
//   noToolsWhileStreaming  a request with tools is sent without streaming (DashScope)
//   maxTokensParam       max_tokens (default) or max_completion_tokens
//   storeFalse           responses API: store:false so the provider keeps no copy (OpenAI)
// Every applied quirk is reported in `applied` so a test (and a debug view) can see what changed.

import { assistantToolCallArgsString } from '../events.mjs';

const RESERVED = new Set(['model', 'messages', 'input', 'stream', 'tools']);

function mapToolChoiceChat(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (typeof choice === 'object' && choice.name) return { type: 'function', function: { name: choice.name } };
  return undefined;
}

function mapToolChoiceResponses(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (typeof choice === 'object' && choice.name) return { type: 'function', name: choice.name };
  return undefined;
}

export function toChatMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    const out = { role: m.role, content: typeof m.content === 'string' ? m.content : null };
    if (m.name) out.name = m.name;
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: assistantToolCallArgsString(tc.arguments) } }));
      if (out.content === '') out.content = null;
    }
    return out;
  });
}

export function toResponsesInput(messages) {
  const instructions = [];
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') { instructions.push(m.content); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content }); continue; }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.toolCalls) input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: assistantToolCallArgsString(tc.arguments) });
      continue;
    }
    input.push({ role: m.role, content: m.content });
  }
  return { instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined, input };
}

function applyCommonOptions(body, o, { chat }) {
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.topP !== undefined) body.top_p = o.topP;
  if (chat) {
    if (o.stop !== undefined) body.stop = o.stop;
    if (o.seed !== undefined) body.seed = o.seed;
    if (o.n !== undefined) body.n = o.n;
    if (o.logprobs !== undefined) body.logprobs = o.logprobs;
    if (o.responseFormat !== undefined) body.response_format = o.responseFormat;
  }
  if (o.parallelToolCalls !== undefined) body.parallel_tool_calls = o.parallelToolCalls;
  if (o.extraBody && typeof o.extraBody === 'object') {
    for (const [k, v] of Object.entries(o.extraBody)) if (!RESERVED.has(k)) body[k] = v;
  }
}

export function applyQuirks(body, quirks = {}, applied = []) {
  if (quirks.temperatureFloor !== undefined && typeof body.temperature === 'number' && body.temperature < quirks.temperatureFloor) {
    body.temperature = quirks.temperatureFloor;
    applied.push('temperatureFloor');
  }
  if (quirks.forceN1 && body.n !== undefined && body.n !== 1) { body.n = 1; applied.push('forceN1'); }
  if (quirks.dropMessageName && Array.isArray(body.messages)) {
    let dropped = false;
    body.messages = body.messages.map((m) => { if (m.name === undefined) return m; dropped = true; const { name, ...rest } = m; return rest; });
    if (dropped) applied.push('dropMessageName');
  }
  for (const [from, to] of Object.entries(quirks.renameParams || {})) {
    if (body[from] !== undefined) { body[to] = body[from]; delete body[from]; applied.push('rename:' + from + '->' + to); }
  }
  for (const p of quirks.dropParams || []) {
    if (body[p] !== undefined) { delete body[p]; applied.push('drop:' + p); }
  }
  return { body, applied };
}

export function buildChatCompletionsBody(entry, req, { stream }) {
  const q = entry.quirks || {};
  const o = req.options || {};
  const body = { model: req.model, messages: toChatMessages(req.messages), stream };
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
  }
  if (o.maxTokens !== undefined) body[q.maxTokensParam || 'max_tokens'] = o.maxTokens;
  const tc = mapToolChoiceChat(o.toolChoice);
  if (tc !== undefined) body.tool_choice = tc;
  applyCommonOptions(body, o, { chat: true });
  if (stream && q.streamUsageOption) body.stream_options = { include_usage: true };
  return applyQuirks(body, q, []);
}

export function buildResponsesBody(entry, req, { stream }) {
  const q = entry.quirks || {};
  const o = req.options || {};
  const { instructions, input } = toResponsesInput(req.messages);
  const body = { model: req.model, input, stream };
  if (instructions) body.instructions = instructions;
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } }));
  }
  if (o.maxTokens !== undefined) body.max_output_tokens = o.maxTokens;
  const tc = mapToolChoiceResponses(o.toolChoice);
  if (tc !== undefined) body.tool_choice = tc;
  applyCommonOptions(body, o, { chat: false });
  const applied = [];
  if (q.storeFalse && body.store === undefined) { body.store = false; applied.push('storeFalse'); }
  return applyQuirks(body, q, applied);
}
