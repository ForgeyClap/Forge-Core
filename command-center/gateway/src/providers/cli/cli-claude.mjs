// cli-claude adapter: DETECTION ONLY. Chats keep running through the existing gateway exec pipeline
// (exec-lifecycle.mjs / exec-argv.mjs / exec-cli.mjs), which already spawns the unmodified claude with
// stream-json; see handoff() and the README wiring plan.
//
// What this module does (all through the claude program itself, ToS section 3):
//   1. resolve the binary (where/which, or CC_CLAUDE_CLI_PATH);
//   2. `claude --version`;
//   3. capability probe: `claude --help`, checking the stream flags the exec pipeline relies on;
//   4. sign-in state: `claude auth status --json`, keeping ONLY loggedIn, authMethod, apiProvider and
//      subscriptionType. Email, organisation id and name are dropped on read and never stored.
// It never opens, reads, copies or stores ~/.claude/.credentials.json or any token, and never passes
// --bare (which would skip the user's own sign-in).

import { BaseProvider } from '../provider-base.mjs';
import { ProviderError, ERROR_CODES, redactText } from '../redact-guard.mjs';
import { resolveCli, runCli, probeEnv, firstLine } from './cli-resolve.mjs';

const DETECT_CACHE_MS = 60_000;
const CAPABILITY_FLAGS = Object.freeze({
  print: '--print',
  outputFormat: '--output-format',
  includePartialMessages: '--include-partial-messages',
  inputFormat: '--input-format',
  resume: '--resume',
  forkSession: '--fork-session',
  permissionPromptTool: '--permission-prompt-tool',
  forwardSubagentText: '--forward-subagent-text',
  includeHookEvents: '--include-hook-events',
  settings: '--settings',
});
const AUTH_FIELDS = ['loggedIn', 'authMethod', 'apiProvider', 'subscriptionType'];

export function parseClaudeVersion(text) {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

export function parseClaudeHelp(helpText) {
  const help = String(helpText || '');
  const caps = {};
  for (const [k, flag] of Object.entries(CAPABILITY_FLAGS)) caps[k] = help.includes(flag);
  caps.authStatusCommand = /\bauth\b/.test(help);
  return caps;
}

// Keeps only allow-listed, non-personal fields of `claude auth status --json`.
export function parseClaudeAuthStatus(stdout) {
  let j;
  try { j = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const out = {};
  for (const f of AUTH_FIELDS) {
    const v = j[f];
    if (typeof v === 'boolean' || (typeof v === 'string' && v.length <= 40)) out[f] = v;
  }
  if (typeof out.loggedIn !== 'boolean') return null;
  return out;
}

export async function detectClaude({ resolver = resolveCli, run = runCli, env = process.env } = {}) {
  const resolved = await resolver('claude', { env });
  if (!resolved) {
    return { installed: false, state: 'not-installed', detail: 'claude was not found on PATH (install Claude Code, or set CC_CLAUDE_CLI_PATH)' };
  }
  const childEnv = probeEnv(env); // no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: report the user's own sign-in
  const ver = await run(resolved, ['--version'], { env: childEnv, timeoutMs: 15_000 });
  if (ver.code !== 0) {
    return { installed: true, path: resolved.path, state: 'error', detail: 'claude --version failed (exit ' + ver.code + (ver.timedOut ? ', timed out' : '') + '): ' + redactText(firstLine(ver.stderr || ver.stdout)) };
  }
  const version = parseClaudeVersion(ver.stdout);
  const help = await run(resolved, ['--help'], { env: childEnv, timeoutMs: 15_000 });
  const capabilities = parseClaudeHelp(help.stdout || help.stderr);
  let auth = null;
  let authDetail = null;
  if (capabilities.authStatusCommand) {
    const st = await run(resolved, ['auth', 'status', '--json'], { env: childEnv, timeoutMs: 20_000 });
    auth = parseClaudeAuthStatus(st.stdout);
    if (!auth) authDetail = 'claude auth status gave no readable answer (exit ' + st.code + ')';
  } else {
    authDetail = 'this claude version has no auth status command';
  }
  let state;
  if (!auth) state = 'unknown-auth';
  else state = auth.loggedIn ? 'connected' : 'not-connected';
  const missing = ['outputFormat', 'includePartialMessages', 'resume'].filter((k) => !capabilities[k]);
  return {
    installed: true, path: resolved.path, via: resolved.via, version, versionText: firstLine(ver.stdout),
    capabilities, streamReady: missing.length === 0, missingCapabilities: missing,
    auth, state,
    detail: state === 'connected' ? 'signed in (' + (auth.authMethod || 'unknown method') + ')'
      : state === 'not-connected' ? 'claude is installed but not signed in: run `claude` and sign in yourself'
        : authDetail,
  };
}

export class ClaudeCliProvider extends BaseProvider {
  constructor(entry, opts = {}) {
    super(entry, opts);
    this._detect = opts.detect || ((o) => detectClaude(o));
    this._env = opts.env || process.env;
    this._cache = null;
  }

  async detect({ fresh = false } = {}) {
    if (!fresh && this._cache && Date.now() - this._cache.at < DETECT_CACHE_MS) return this._cache.result;
    const result = await this._detect({ env: this._env });
    this._cache = { at: Date.now(), result };
    return result;
  }

  async health() {
    const d = await this.detect();
    return { ok: d.state === 'connected', state: d.state, network: false, detail: d.detail, version: d.version || null };
  }

  async testConnection() {
    const started = Date.now();
    const d = await this.detect({ fresh: true });
    return { ok: d.state === 'connected' && d.streamReady === true, state: d.state, latencyMs: Date.now() - started, detail: d.detail, version: d.version || null, capabilities: d.capabilities || null };
  }

  // What the exec pipeline needs to start a chat. Data only; nothing is spawned here.
  handoff() {
    return {
      pipeline: 'gateway/src/exec-lifecycle.mjs (spawn) + exec-argv.mjs (argv) + exec-cli.mjs (resolve, env allowlist)',
      command: this.entry.command,
      baseArgs: [...(this.entry.cliArgs || [])],
      forbiddenArgs: [...(this.entry.forbiddenArgs || [])],
      env: 'subscription mode: ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are NOT passed (they would override the user sign-in); exec-cli.mjs filteredEnv already drops them',
      session: 'session_id from the first system/init event; --resume <id>; fork with --fork-session',
    };
  }

  requiresModel() { return false; }

  // eslint-disable-next-line require-yield
  async* _chat() {
    throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED,
      'claude chats run through the gateway exec pipeline (exec-lifecycle.mjs), not through the provider module; see handoff()',
      { provider: this.id });
  }
}
