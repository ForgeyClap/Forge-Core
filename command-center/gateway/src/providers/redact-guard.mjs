// Redaction guard for the provider layer. Every error message, log line and event text that can leave
// this module passes through a Redactor first.
//
// Two layers:
//   1. EXACT values: every key the KeyProvider handed out during this process is registered here
//      (rememberSecret) and replaced wherever it appears, whatever its shape. This catches keys of
//      providers whose format no pattern knows.
//   2. SHAPES: well-known key prefixes and auth header / query forms, as a second net for a key that
//      was never registered (for example one echoed back by a misbehaving server).
//
// Never logs, never throws, never reports what it removed beyond the placeholder name.

const MIN_EXACT_SECRET_LENGTH = 8; // shorter values would redact ordinary words

const SHAPES = [
  { name: 'ANTHROPIC_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: 'SK_KEY', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'NVIDIA_KEY', re: /\bnvapi-[A-Za-z0-9_-]{10,}/g },
  { name: 'GROQ_KEY', re: /\bgsk_[A-Za-z0-9]{10,}/g },
  { name: 'XAI_KEY', re: /\bxai-[A-Za-z0-9]{10,}/g },
  { name: 'GOOGLE_KEY', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'HF_TOKEN', re: /\bhf_[A-Za-z0-9]{10,}/g },
  { name: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{10,}/g },
  { name: 'AWS_ACCESS_KEY_ID', re: /\bAKIA[A-Z0-9]{12,}/g },
  { name: 'BEDROCK_KEY', re: /\bABSK[A-Za-z0-9+/=]{20,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Header forms: keep the header name so a reader still knows which header failed.
  { name: 'AUTH_HEADER', re: /\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',;]+/gi, keep: 1 },
  { name: 'API_KEY_HEADER', re: /\b((?:x-api-key|api-key|x-goog-api-key)\s*[:=]\s*)[^\s"',;]+/gi, keep: 1 },
  { name: 'BEARER', re: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, keep: 1 },
  { name: 'QUERY_KEY', re: /([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"'#]+/gi, keep: 1 },
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  constructor() {
    this._exact = new Map(); // secret value -> label
    this._exactRe = null;
  }

  // Registers a secret value (never logged). Label is a NAME such as the env var name, never a value.
  rememberSecret(value, label = 'SECRET') {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_EXACT_SECRET_LENGTH) return;
    if (!this._exact.has(trimmed)) {
      this._exact.set(trimmed, String(label).replace(/[^A-Z0-9_]/gi, '_').slice(0, 64) || 'SECRET');
      this._exactRe = null;
    }
  }

  _exactPattern() {
    if (this._exact.size === 0) return null;
    if (!this._exactRe) {
      // Longest first so a secret that contains another one is replaced as a whole.
      const values = [...this._exact.keys()].sort((a, b) => b.length - a.length);
      this._exactRe = new RegExp(values.map(escapeRegExp).join('|'), 'g');
    }
    return this._exactRe;
  }

  redact(value) {
    if (typeof value !== 'string' || value.length === 0) return value;
    let out = value;
    const exact = this._exactPattern();
    if (exact) out = out.replace(exact, (m) => '[REDACTED:' + (this._exact.get(m) || 'SECRET') + ']');
    for (const shape of SHAPES) {
      out = out.replace(shape.re, (...args) => (shape.keep ? args[1] : '') + '[REDACTED:' + shape.name + ']');
    }
    return out;
  }

  // Structure-preserving deep redaction for event payloads and error details.
  redactDeep(value, depth = 0) {
    if (depth > 20) return '[TRUNCATED]';
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v, depth + 1));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactDeep(v, depth + 1);
      return out;
    }
    return value;
  }
}

// One process-wide redactor: every KeyProvider registers what it hands out here, so a key read for
// provider A is also scrubbed from an error raised by provider B.
export const sharedRedactor = new Redactor();

export function redactText(value) {
  return sharedRedactor.redact(value);
}

// Error type for every failure this layer reports. The message is redacted at construction time, so
// no code path can create a ProviderError that still carries a key.
export class ProviderError extends Error {
  constructor(code, message, { provider = null, status = null, retryable = false, cause = null } = {}) {
    super(redactText(String(message || code)));
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.causeCode = cause.code || null; // keep the code only: a cause message may hold a URL with a key
  }

  toJSON() {
    return { code: this.code, message: this.message, provider: this.provider, status: this.status, retryable: this.retryable };
  }
}

export const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED', // key or template variable missing
  CONFIG: 'CONFIG', // bad registry entry or option
  AUTH: 'AUTH', // 401/403
  NOT_FOUND: 'NOT_FOUND', // 404 (route or model)
  RATE_LIMIT: 'RATE_LIMIT', // 429
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK', // refused, reset, DNS
  HTTP: 'HTTP', // other non-2xx
  BAD_RESPONSE: 'BAD_RESPONSE', // unparseable body or stream
  ABORTED: 'ABORTED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NOT_INSTALLED: 'NOT_INSTALLED',
  NOT_CONNECTED: 'NOT_CONNECTED', // CLI installed but not signed in
  PROTOCOL: 'PROTOCOL', // JSON-RPC level error from a CLI app-server
});

// Turns anything thrown into a redacted, normalised error event.
export function toErrorEvent(err, provider = null) {
  if (err instanceof ProviderError) {
    return { type: 'error', code: err.code, message: err.message, status: err.status, retryable: err.retryable, provider: err.provider || provider };
  }
  const message = err && err.message ? err.message : String(err);
  return { type: 'error', code: ERROR_CODES.HTTP, message: redactText(message), status: null, retryable: false, provider };
}
