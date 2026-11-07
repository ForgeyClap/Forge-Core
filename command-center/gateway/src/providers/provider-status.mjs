// Pure mapping helpers for the gateway provider routes (WP B2 part 2). No I/O, no secrets.
//
//   statusFromState()  adapter/probe state -> the five status words of the Accounts card
//   providerKind()     subscription | api-key | local | cli-detect-only
//   whoPays(), priceBand(), limitsInfo()   derived from the registry entry (the registry holds no prices)
//   loginHint()        the exact official CLI command a user runs THEMSELVES; the gateway never runs it
//
// Contract: _scratch/b2/contract-providers.md sections 2, 3 and 7.

export const STATUS_WORDS = Object.freeze({
  connected: 'verbonden',
  'not-connected': 'niet verbonden',
  'no-key': 'geen sleutel',
  'not-installed': 'niet geinstalleerd',
  error: 'fout',
});

const CONNECTED_STATES = new Set(['connected', 'signed-in', 'reachable']);
const NOT_CONNECTED_STATES = new Set(['configured', 'not-connected', 'unreachable', 'needs-model', 'installed']);
const ERROR_STATES = new Set(['auth-failed', 'rate-limited', 'not-found', 'error', 'not-implemented', 'unknown-auth']);

function word(code) {
  return { status: STATUS_WORDS[code], status_code: code };
}

// keyMissing: the provider needs a key and neither the vault nor the env has one.
export function statusFromState(state, { keyMissing = false } = {}) {
  if (keyMissing) return word('no-key');
  if (CONNECTED_STATES.has(state)) return word('connected');
  if (state === 'not-installed') return word('not-installed');
  if (state === 'not-configured') return word('not-connected'); // a template value (e.g. Azure resource) is missing
  if (NOT_CONNECTED_STATES.has(state)) return word('not-connected');
  if (ERROR_STATES.has(state)) return word('error');
  return word('error'); // an unknown state is never reported as working
}

// The existing NVIDIA probe (models.mjs) speaks its own vocabulary.
export function nvidiaProbeToState(probe) {
  const s = probe && probe.state;
  if (s === 'CONNECTED') return { state: 'connected', keyMissing: false, tested: true };
  if (s === 'NOT CONFIGURED') return { state: 'not-configured', keyMissing: true, tested: false };
  if (s === 'OFF') return { state: 'not-connected', keyMissing: false, tested: false };
  if (s === 'DISCONNECTED') return { state: 'error', keyMissing: false, tested: true };
  return { state: 'error', keyMissing: false, tested: false };
}

const CLI_SUBSCRIPTION = new Set(['cli-claude', 'cli-codex']);
const KEYED_AUTH = new Set(['bearer', 'bearer-or-x-api-key', 'api-key-header', 'x-goog-api-key']);

export function needsKey(entry) {
  return KEYED_AUTH.has(entry.authType);
}

export function providerKind(entry) {
  if (CLI_SUBSCRIPTION.has(entry.adapter)) return 'subscription';
  if (entry.adapter === 'cli-generic') return 'cli-detect-only';
  if (entry.local) return 'local';
  return 'api-key';
}

// "Wie betaalt" (product card glossary: account = waarmee je werkt en wie betaalt). The label is a Dutch
// default for non-UI callers; the dashboard renders its own t() copy keyed on `code`.
export function whoPays(entry) {
  if (entry.subscription) return { code: 'subscription', label: 'Jouw abonnement' };
  if (entry.local) return { code: 'free-local', label: 'Gratis, op deze pc' };
  if (needsKey(entry)) return { code: 'api-key', label: 'Jouw API-sleutel (betaald per gebruik)' };
  return { code: 'none', label: 'Niemand' };
}

// The registry holds no prices (catalogue section 1 has none verified), so the band is coarse and honest.
export function priceBand(entry) {
  if (entry.subscription) return 'plan-limit';
  if (entry.local) return 'free';
  if (needsKey(entry)) return 'pay-per-use';
  return 'unknown';
}

export function limitsInfo(entry) {
  if (entry.subscription) {
    return { kind: 'plan-window', known: false, note: 'counts toward your plan limit (5-hour and weekly windows); many agents at once use it faster' };
  }
  if (entry.local) return { kind: 'none', known: true, note: 'runs on this PC: no usage limit, speed depends on your hardware' };
  return { kind: 'provider-rate-limits', known: false, note: 'the provider sets rate limits and prices per model; not catalogued in Forge' };
}

// Verified on this PC 2026-11-02: `claude auth --help` lists `login` (Claude Code 2.1.316), and
// `codex login --help` exists (codex-cli 0.156.1). The gateway only RETURNS these strings.
const CLI_LOGIN = Object.freeze({
  'cli-claude': {
    command: 'claude auth login', alt_command: 'claude', status_command: 'claude auth status --json',
    note: 'Run this in a terminal and follow the steps in the Claude Code window; Forge checks the sign-in with the status command and never sees your login.',
  },
  'cli-codex': {
    command: 'codex login', alt_command: null, status_command: 'codex login status',
    note: 'Run this in a terminal; Codex opens its own sign-in. Forge never starts a login and never reads Codex credentials.',
  },
});

export function loginHint(entry) {
  const base = {
    provider: entry.id, kind: 'none', command: null, alt_command: null, status_command: null,
    runs_in: null, gateway_runs_it: false, key_env_name: entry.keyEnvName || null, docs_url: entry.docsURL || null, note: '',
  };
  const cli = CLI_LOGIN[entry.adapter];
  if (cli) return { ...base, kind: 'cli-login', ...cli, runs_in: 'terminal' };
  if (entry.adapter === 'cli-generic') {
    return { ...base, kind: 'not-supported', note: 'Signing in through this CLI is not supported: reusing its login is not allowed. Use a provider with an API key instead.' };
  }
  if (needsKey(entry)) {
    return { ...base, kind: 'api-key', note: 'Create an API key on the provider site (docs_url) and add it in Forge under Settings > Accounts.' };
  }
  if (entry.authType === 'bearer-optional') {
    return { ...base, kind: 'none', note: 'No sign-in needed; a key is only needed if you protected your local server with one.' };
  }
  return { ...base, kind: 'none', note: entry.local ? 'No sign-in needed: this runs on your own PC.' : 'No sign-in needed.' };
}
