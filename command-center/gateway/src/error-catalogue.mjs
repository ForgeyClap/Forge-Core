// Forge Command Center gateway — chat error catalogue (WP B3).
//
// Classifies a failure of a chat turn into exactly ONE stable code the dashboard turns into a
// Dutch error card (title, one sentence, one button). The codes are the contract in
// _scratch/b3/contract-permissions.md section 3 and are shared with the UI's own catalogue
// (dashboard/src/views/chat/errors/error-catalogue.ts):
//
//   cli_missing · logged_out · rate_limited · offline · api_retry · ollama_down ·
//   model_not_pulled · gateway_restarted · unknown
//
// Inputs it understands (every shape below was taken from a real recorded line; see
// test/fixtures/stream-json/ for the recorded fixtures and test/error-catalogue.test.mjs):
//   - a parsed stream-json line: `system/api_retry`, `rate_limit_event` with status "rejected",
//     a `result` line with is_error:true (its `result` text and `api_error_status`);
//   - free text: a spawn error message, the child's stderr, or a startExecution() refusal reason.
//
// Honesty rules: the classifier never invents a reset time (resume_at is set only when the CLI
// reported one), `details` is always passed through redact() before it leaves this module, and a
// text it does not recognise is `unknown`, never a guess at a closer code.

import { redact } from './redact.mjs';

export const ERROR_CODES = Object.freeze([
  'cli_missing',
  'logged_out',
  'rate_limited',
  'offline',
  'api_retry',
  'ollama_down',
  'model_not_pulled',
  'gateway_restarted',
  'unknown',
]);

const DETAILS_CAP = 600;

// Ordered: the first matching rule wins. Ollama rules come before the generic offline rule,
// because a refused connection to port 11434 is "Ollama is not running", not "no internet".
const TEXT_RULES = [
  {
    code: 'cli_missing',
    res: [
      /spawn\s+\S*claude(?:\.exe|\.cmd)?\s+ENOENT/i,
      /'claude' is not recognized as an internal or external command/i,
      /claude(?:\.exe)?: (?:command )?not found/i,
      /command not found: claude/i,
      /claude CLI path could not be resolved/i,
      /claude CLI (?:is )?not (?:found|installed)/i,
    ],
  },
  {
    code: 'model_not_pulled',
    res: [
      /model ["'`]?([A-Za-z0-9._:/-]+)["'`]? not found,? try pulling it first/i,
      /pull model manifest: file does not exist/i,
    ],
  },
  {
    code: 'ollama_down',
    res: [
      /ECONNREFUSED\s+(?:127\.0\.0\.1|::1|\[::1\]|localhost):11434/i,
      /(?:127\.0\.0\.1|localhost):11434.{0,80}(?:refused|ECONNREFUSED|unreachable)/i,
      /ollama (?:is not running|server is not running|not running)/i,
    ],
  },
  {
    code: 'logged_out',
    res: [
      /Invalid API key/i,
      /Please run \/login/i,
      /Not logged in/i,
      /OAuth token (?:has )?expired/i,
      /authentication_error/i,
      /\b401\b.{0,40}(?:unauthori[sz]ed|authentication)/i,
      /API Error: 401/i,
    ],
  },
  {
    code: 'rate_limited',
    res: [
      /usage limit reached/i,
      /(?:5|five)[- ]hour limit reached/i,
      /weekly limit reached/i,
      /You'?ve hit your (?:usage )?limit/i,
      /rate_limit_error/i,
      /API Error: 429/i,
    ],
  },
  {
    code: 'offline',
    res: [
      /getaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)/i,
      /\bENOTFOUND\b/,
      /\bEAI_AGAIN\b/,
      /\bENETUNREACH\b/,
      /\bECONNRESET\b/,
      /\bETIMEDOUT\b/,
      /\bECONNREFUSED\b/,
      /Unable to connect to API/i,
      /fetch failed/i,
      /Connection error/i,
      /network (?:is )?unreachable/i,
    ],
  },
];

// "Claude AI usage limit reached|1785355200" — the older CLI shape carries the reset epoch
// (seconds) after a pipe. Newer CLIs report resets on the rate_limit_event line instead.
const LEGACY_LIMIT_EPOCH_RE = /usage limit reached\|(\d{9,11})/i;
const MODEL_NAME_RE = /model ["'`]?([A-Za-z0-9._:/-]+)["'`]? not found/i;

function capDetails(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const clean = redact(text).trim();
  if (clean.length === 0) return null;
  return clean.length > DETAILS_CAP ? clean.slice(0, DETAILS_CAP) : clean;
}

function epochSecondsToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function payload(code, extra) {
  return {
    code,
    resume_at: null,
    model: null,
    attempt: null,
    max_attempts: null,
    details: null,
    ...extra,
  };
}

/**
 * Classifies free text (stderr, a spawn error message, a refusal reason, a result text).
 * Returns a ChatErrorPayload; `unknown` when nothing matches. Never throws.
 */
export function classifyErrorText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return payload('unknown', { details: null });
  for (const rule of TEXT_RULES) {
    if (!rule.res.some((re) => re.test(text))) continue;
    const extra = { details: capDetails(text) };
    if (rule.code === 'model_not_pulled') {
      const m = text.match(MODEL_NAME_RE);
      extra.model = m ? m[1] : null;
    }
    if (rule.code === 'rate_limited') {
      const m = text.match(LEGACY_LIMIT_EPOCH_RE);
      extra.resume_at = m ? epochSecondsToIso(m[1]) : null;
    }
    return payload(rule.code, extra);
  }
  return payload('unknown', { details: capDetails(text) });
}

/**
 * Classifies one parsed stream-json line. Returns a ChatErrorPayload, or null when the line is not
 * an error at all (the common case: almost every line is not). Never throws.
 */
export function classifyStreamLine(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  if (parsed.type === 'system' && parsed.subtype === 'api_retry') {
    const attempt = Number.isInteger(parsed.attempt) ? parsed.attempt : null;
    const max = Number.isInteger(parsed.max_retries) ? parsed.max_retries : null;
    const reason = [parsed.error_status, parsed.error].filter((v) => v !== undefined && v !== null).join(' ');
    return payload('api_retry', { attempt, max_attempts: max, details: capDetails(reason) });
  }

  if (parsed.type === 'rate_limit_event') {
    const info = parsed.rate_limit_info && typeof parsed.rate_limit_info === 'object' ? parsed.rate_limit_info : null;
    if (!info || info.status !== 'rejected') return null; // "allowed" / "allowed_warning" are not errors
    const kind = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown';
    return payload('rate_limited', { resume_at: epochSecondsToIso(info.resetsAt), details: capDetails('rate limit: ' + kind) });
  }

  if (parsed.type === 'result' && parsed.is_error === true) {
    const text = typeof parsed.result === 'string' ? parsed.result : '';
    const status = Number(parsed.api_error_status);
    if (status === 401) return payload('logged_out', { details: capDetails(text) });
    if (status === 429) {
      const classified = classifyErrorText(text);
      return payload('rate_limited', { resume_at: classified.code === 'rate_limited' ? classified.resume_at : null, details: capDetails(text) });
    }
    return classifyErrorText(text);
  }

  return null;
}

/**
 * Classifies the end of an execution that produced no result line of its own: the exit code plus
 * the (already captured) stderr text. Returns null for a clean exit (code 0, nothing on stderr).
 */
export function classifyExit({ exitCode, stderr, spawnError } = {}) {
  if (typeof spawnError === 'string' && spawnError.length > 0) {
    const fromSpawn = classifyErrorText(spawnError);
    if (fromSpawn.code !== 'unknown') return fromSpawn;
    if (/\bENOENT\b/.test(spawnError)) return payload('cli_missing', { details: capDetails(spawnError) });
    return fromSpawn;
  }
  if (exitCode === 0) return null;
  if (typeof stderr === 'string' && stderr.trim().length > 0) return classifyErrorText(stderr);
  if (exitCode === null || exitCode === undefined) return null;
  return payload('unknown', { details: 'exit code ' + exitCode });
}

/** A turn that a gateway drain interrupted mid-answer (exec-lifecycle `interrupted` event). */
export function gatewayRestartedError(reason) {
  return payload('gateway_restarted', { details: capDetails(typeof reason === 'string' ? reason : 'gateway drain') });
}

/** The `{type:"forge_error", ...}` record the stream parser emits for one classified error. */
export function toForgeErrorEvent(errorPayload, source) {
  if (!errorPayload || !ERROR_CODES.includes(errorPayload.code)) return null;
  return { type: 'forge_error', source: typeof source === 'string' ? source : 'stream', ...errorPayload };
}
