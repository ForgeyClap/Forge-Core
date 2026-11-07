// App router (Forge-router) — shared enums, limits and record shapes.
// Design contract: docs/forge-systeem/APP-ROUTER-DESIGN.md (parent repo), sections 1, 2, 4 and 5.
//
// The switching numbers (threshold 92 %, range 50-99, cooldown 10 min, at most 6 proactive switches
// per conversation per 24 h, 15-minute staleness) are the CLI account rotator's, re-implemented here
// (provenance PATTERN_ADAPTED, design D2). Nothing in this folder reads a login file, a vault or a
// token: the router only picks which official Claude Code profile folder a turn runs with.

export const ROUTER_VERSION = 1;

/** @typedef {'off'|'claude-accounts'|'claude-then-model'|'model-first'} RouterMode */
export const MODES = Object.freeze(['off', 'claude-accounts', 'claude-then-model', 'model-first']);

/** @typedef {'claude-account'|'codex-account'|'provider-model'} EntryKind */
export const ENTRY_KINDS = Object.freeze(['claude-account', 'codex-account', 'provider-model']);

export const STRATEGIES = Object.freeze(['in-order', 'spread']);
export const RETURN_POLICIES = Object.freeze(['new-conversation', 'asap']);

/** @typedef {'first'|'sticky'|'switch-threshold'|'switch-limit'|'switch-login'|'switch-down'|'return'} RouteReason */
export const REASONS = Object.freeze(['first', 'sticky', 'switch-threshold', 'switch-limit', 'switch-login', 'switch-down', 'return']);

/** @typedef {'ready'|'near-limit'|'exhausted'|'needs-login'|'down'|'unknown'} TargetStateName */
export const STATES = Object.freeze(['ready', 'near-limit', 'exhausted', 'needs-login', 'down', 'unknown']);

/** @typedef {'ok'|'rate_limited'|'logged_out'|'down'|'error'|'stopped'} RouteOutcome */
export const OUTCOMES = Object.freeze(['ok', 'rate_limited', 'logged_out', 'down', 'error', 'stopped']);

/** Failover reasons a caller passes to selectTarget({ failover }) after a failed attempt 1. */
export const FAILOVERS = Object.freeze(['rate_limited', 'logged_out', 'down']);

/** @typedef {'full'|'answers-only'|'read-answer'} Capability */
export const CAPABILITY_BY_KIND = Object.freeze({
  'claude-account': 'full',
  'provider-model': 'answers-only',
  'codex-account': 'read-answer',
});

export const LIMITS = Object.freeze({
  THRESHOLD_DEFAULT: 92,
  THRESHOLD_MIN: 50,
  THRESHOLD_MAX: 99,
  COOLDOWN_DEFAULT: 10,
  COOLDOWN_MIN: 1,
  COOLDOWN_MAX: 240,
  HANDOVER_TURNS_DEFAULT: 12,
  HANDOVER_TURNS_MIN: 2,
  HANDOVER_TURNS_MAX: 40,
  MAX_ENTRIES: 12,
  MAX_CLAUDE: 8,
  MAX_CODEX: 1,
  MAX_PROACTIVE_SWITCHES_24H: 6,
  NUM_CTX_MIN: 2048,
  NUM_CTX_MAX: 131072,
  NUM_CTX_DEFAULT: 8192,
  LABEL_MAX: 40,
  ID_MAX: 32,
  MODEL_MAX: 200,
  /** A usage reading older than this is shown as stale and counts as unknown. */
  STALE_MS: 15 * 60_000,
  /** A limit hit without a reset time keeps the entry exhausted this long. */
  UNKNOWN_RESET_HOLD_MS: 60 * 60_000,
  /** A provider that was down is skipped this long. */
  DOWN_HOLD_MS: 2 * 60_000,
  /** Handover size cap for Claude Code and Codex targets. */
  HANDOVER_CLI_MAX_CHARS: 24_000,
  /** Fallback when the handover cannot go through stdin: prefix in the prompt argument. */
  HANDOVER_ARG_MAX_CHARS: 6_000,
  /** Ollama sizing: about 3 chars per token, 60 % of the context window. */
  HANDOVER_CHARS_PER_TOKEN: 3,
  HANDOVER_CTX_SHARE: 0.6,
  /** router-events.jsonl cap; one .1 rotation. */
  LOG_MAX_BYTES: 2 * 1024 * 1024,
  /** User-clicked Test probes: at most one per target in this window (enforced by the route). */
  TEST_INTERVAL_MS: 5 * 60_000,
});

/** Ids and profile slugs: lower case, digits, dashes; first char a letter or digit; at most 32. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * Windows device names: never usable as a folder name, so never an id or a profile slug. COM0 and LPT0
 * are reserved too (Windows documents them as reserved; superscript digits cannot occur in an id).
 */
export const WINDOWS_DEVICE_NAMES = Object.freeze([
  'con', 'prn', 'aux', 'nul',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
export const MAIN_ID = 'main';

/** Usage window names for notices and pills (design 5.1). Unknown types read as "limiet". */
export const WINDOW_LABELS = Object.freeze({
  five_hour: Object.freeze({ nl: '5-uurslimiet', en: '5-hour limit' }),
  seven_day: Object.freeze({ nl: 'weeklimiet', en: 'weekly limit' }),
  seven_day_opus: Object.freeze({ nl: 'weeklimiet voor Opus', en: 'weekly limit for Opus' }),
  seven_day_sonnet: Object.freeze({ nl: 'weeklimiet voor Sonnet', en: 'weekly limit for Sonnet' }),
});
export const WINDOW_LABEL_OTHER = Object.freeze({ nl: 'limiet', en: 'limit' });
export function windowLabel(type) {
  return Object.prototype.hasOwnProperty.call(WINDOW_LABELS, type) ? WINDOW_LABELS[type] : WINDOW_LABEL_OTHER;
}

/** Terms check date (design 5.3); updated after the owner reads the 2026-11-12 usage policy (Q1). */
export const ROUTER_TERMS_CHECKED_AT = '2026-11-02';
export const ROUTER_TERMS_SOURCES = Object.freeze([
  Object.freeze({ title: 'Anthropic Consumer Terms', url: 'https://www.anthropic.com/legal/consumer-terms' }),
  Object.freeze({ title: 'Anthropic Usage Policy', url: 'https://www.anthropic.com/legal/aup' }),
  Object.freeze({ title: 'Claude Code legal and compliance', url: 'https://code.claude.com/docs/en/legal-and-compliance' }),
]);

/**
 * One chain entry as stored in router.json (design 2.2).
 * @typedef {object} RouterEntry
 * @property {string} id
 * @property {EntryKind} kind
 * @property {string} label
 * @property {boolean} enabled
 * @property {string|null} [profile]        claude-account / codex-account
 * @property {number|null} [threshold_pct]
 * @property {string} [provider]            provider-model: registry id
 * @property {string} [model]               provider-model
 * @property {number|null} [num_ctx]        provider-model
 * @property {Record<string,string>} [vars] provider-model
 * @property {boolean} [paid_ack]           provider-model
 * @property {boolean} [notice_ack]         provider-model
 */

/**
 * @typedef {object} UsageWindow
 * @property {string} type           five_hour | seven_day | seven_day_opus | ... | other
 * @property {number|null} pct       0-100, one decimal; null when the CLI did not report a number
 * @property {string|null} resets_at ISO
 * @property {string|null} status    allowed | allowed_warning | rejected | ...
 */

/**
 * Per-target usage record in usage.json (design 4.4). Numbers, window types and timestamps only.
 * @typedef {object} UsageRecord
 * @property {string|null} measured_at
 * @property {'turn'|'test'|null} source
 * @property {UsageWindow[]} windows
 * @property {{at:string, resets_at:string|null, window:string|null}|null} limit_hit
 * @property {string|null} needs_login_at
 * @property {string|null} down_at
 * @property {string|null} last_used_at
 */

/**
 * selectTarget() result (design 4.2).
 * @typedef {{kind:'off'}
 *   | {kind:'target', entry:RouterEntry, reason:RouteReason, switched:boolean, proactive:boolean,
 *      capability:Capability, state:TargetStateName,
 *      from:null|{target_id:string, label:string, kind:EntryKind, window:string|null, pct:number|null, resume_at:string|null}}
 *   | {kind:'exhausted', resume_at:string|null, first_free:null|{target_id:string, label:string}}} RouteDecision
 */
