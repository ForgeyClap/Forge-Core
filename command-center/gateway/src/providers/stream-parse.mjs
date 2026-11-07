// Stream parsers shared by the adapters.
//
// SSEParser follows the WHATWG event-stream rules that matter for LLM providers:
//   - lines end in \n, \r\n or \r, also when the \r and \n arrive in different chunks;
//   - a line starting with ':' is a comment (OpenRouter sends ': OPENROUTER PROCESSING') and is ignored;
//   - "field: value" strips ONE leading space; several data lines join with \n;
//   - a blank line dispatches the event; a stream that ends without a final blank line still flushes
//     its last event in end();
//   - a leading byte-order mark is dropped.
// The caller decides what "data: [DONE]" means; the parser just reports it as data.
//
// parseNDJSON reads newline-delimited JSON (Ollama native /api/pull, /api/chat).

import { ProviderError, ERROR_CODES, redactText } from './redact-guard.mjs';

const MAX_LINE_CHARS = 4 * 1024 * 1024; // one unterminated line larger than this is a broken stream

export class SSEParser {
  constructor() {
    this._buf = '';
    this._data = [];
    this._event = '';
    this._id = null;
    this._started = false;
    this.commentCount = 0;
  }

  push(text) {
    if (!this._started) {
      this._started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this._buf += text;
    // A trailing \r may be the first half of \r\n: keep it for the next push.
    let holdCR = false;
    if (this._buf.endsWith('\r')) { holdCR = true; this._buf = this._buf.slice(0, -1); }
    const lines = this._buf.split(/\r\n|\r|\n/);
    this._buf = lines.pop() + (holdCR ? '\r' : '');
    if (this._buf.length > MAX_LINE_CHARS) {
      throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'event-stream line longer than ' + MAX_LINE_CHARS + ' characters');
    }
    const out = [];
    for (const line of lines) this._line(line, out);
    return out;
  }

  end() {
    const out = [];
    if (this._buf.length > 0) {
      const rest = this._buf.replace(/\r$/, '');
      this._buf = '';
      if (rest) this._line(rest, out);
    }
    this._line('', out); // flush an event that had no closing blank line
    return out;
  }

  _line(line, out) {
    if (line === '') {
      if (this._data.length > 0) out.push({ event: this._event || 'message', data: this._data.join('\n'), id: this._id });
      this._data = [];
      this._event = '';
      return;
    }
    if (line.startsWith(':')) { this.commentCount += 1; return; }
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this._data.push(value);
    else if (field === 'event') this._event = value;
    else if (field === 'id' && !value.includes('\0')) this._id = value;
    // 'retry' and unknown fields are ignored
  }
}

export async function* parseSSE(chunks) {
  const parser = new SSEParser();
  for await (const chunk of chunks) {
    for (const ev of parser.push(chunk)) yield ev;
  }
  for (const ev of parser.end()) yield ev;
}

export async function* parseNDJSON(chunks, { provider = null } = {}) {
  let buf = '';
  const parseLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try { return JSON.parse(trimmed); }
    catch {
      throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'invalid JSON line in stream: ' + redactText(trimmed).slice(0, 120), { provider });
    }
  };
  for await (const chunk of chunks) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const v = parseLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (v !== undefined) yield v;
    }
    if (buf.length > MAX_LINE_CHARS) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'NDJSON line too long', { provider });
  }
  const last = parseLine(buf);
  if (last !== undefined) yield last;
}

// Parses an SSE data payload as JSON; a bad payload is a BAD_RESPONSE with a short redacted excerpt.
export function parseEventJSON(data, provider = null) {
  try { return JSON.parse(data); }
  catch {
    throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'invalid JSON in event stream: ' + redactText(String(data)).slice(0, 120), { provider });
  }
}
