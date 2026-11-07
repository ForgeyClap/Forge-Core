// cli-codex adapter: detection plus chat through `codex app-server` (stdio JSON-RPC).
//
// Detection (CLI commands only, ToS section 3; credential files are never opened):
//   `codex --version`       -> "codex-cli 0.156.1"
//   `codex login status`    -> exit 0 + "Logged in using ChatGPT" / "... an API key"; otherwise not signed in.
//                              Only the method is kept, never any other output text.
// Chat: start app-server, initialize, account/read (refreshToken:false). Not signed in -> one
// NOT_CONNECTED error telling the user to run `codex login` themselves. Forge never starts a login.

import path from 'node:path';
import { BaseProvider } from '../provider-base.mjs';
import { ProviderError, ERROR_CODES, redactText } from '../redact-guard.mjs';
import { resolveCli, runCli, probeEnv, firstLine } from './cli-resolve.mjs';
import { CodexAppServerClient, SANDBOX_MODES } from './codex-app-server.mjs';

const DETECT_CACHE_MS = 60_000;

export function parseCodexVersion(text) {
  const m = /codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i.exec(String(text || ''));
  return m ? m[1] : null;
}

export function parseCodexLoginStatus(code, stdout, stderr) {
  const text = String(stdout || '') + '\n' + String(stderr || '');
  if (code === 0 && /logged in using chatgpt/i.test(text)) return { loggedIn: true, method: 'chatgpt' };
  if (code === 0 && /logged in using an api key/i.test(text)) return { loggedIn: true, method: 'api-key' };
  if (/not logged in/i.test(text) || (code !== 0 && code !== null)) return { loggedIn: false, method: null };
  return null; // unreadable answer
}

export async function detectCodex({ resolver = resolveCli, run = runCli, env = process.env } = {}) {
  const resolved = await resolver('codex', { env });
  if (!resolved) {
    return { installed: false, state: 'not-installed', detail: 'codex was not found on PATH (or FORGE_CODEX_CLI_PATH)', codexHomeSet: !!env.CODEX_HOME };
  }
  const childEnv = probeEnv(env); // no OPENAI_API_KEY: report the user's own codex sign-in
  const ver = await run(resolved, ['--version'], { env: childEnv, timeoutMs: 15_000 });
  if (ver.code !== 0) {
    return { installed: true, path: resolved.path, state: 'error', detail: 'codex --version failed (exit ' + ver.code + (ver.timedOut ? ', timed out' : '') + '): ' + redactText(firstLine(ver.stderr || ver.stdout)) };
  }
  const st = await run(resolved, ['login', 'status'], { env: childEnv, timeoutMs: 15_000 });
  const login = parseCodexLoginStatus(st.code, st.stdout, st.stderr);
  let state = 'unknown-auth';
  if (login) state = login.loggedIn ? 'signed-in' : 'not-connected';
  return {
    installed: true, path: resolved.path, via: resolved.via, version: parseCodexVersion(ver.stdout), versionText: firstLine(ver.stdout),
    login, state, codexHomeSet: !!env.CODEX_HOME,
    detail: state === 'signed-in' ? 'codex reports a stored sign-in (' + login.method + '); whether the plan still allows use is only known after a real turn'
      : state === 'not-connected' ? 'codex is installed but not signed in: run `codex login` yourself'
        : 'codex login status gave no readable answer (exit ' + st.code + ')',
  };
}

export class CodexCliProvider extends BaseProvider {
  constructor(entry, opts = {}) {
    super(entry, opts);
    this._detect = opts.detect || ((o) => detectCodex(o));
    this._resolve = opts.resolve || ((o) => resolveCli('codex', o));
    this._env = opts.env || process.env;
    this._clientFactory = opts.clientFactory || ((o) => new CodexAppServerClient(o));
    this._childEnv = opts.childEnv || probeEnv; // env for app-server: allowlist without API keys
    this._cache = null;
  }

  requiresModel() { return false; }

  async detect({ fresh = false } = {}) {
    if (!fresh && this._cache && Date.now() - this._cache.at < DETECT_CACHE_MS) return this._cache.result;
    const result = await this._detect({ env: this._env });
    this._cache = { at: Date.now(), result };
    return result;
  }

  async health() {
    const d = await this.detect();
    return { ok: d.state === 'signed-in', state: d.state, network: false, detail: d.detail, version: d.version || null };
  }

  async testConnection() {
    const started = Date.now();
    const d = await this.detect({ fresh: true });
    return { ok: d.state === 'signed-in', state: d.state, latencyMs: Date.now() - started, detail: d.detail, version: d.version || null };
  }

  // Opens a client: spawn + initialize + account/read. Throws NOT_INSTALLED / NOT_CONNECTED.
  async openClient({ cwd } = {}) {
    const resolved = await this._resolve({ env: this._env });
    if (!resolved) throw new ProviderError(ERROR_CODES.NOT_INSTALLED, 'codex is not installed', { provider: this.id });
    const client = this._clientFactory({ command: resolved.command, prefixArgs: resolved.prefixArgs, args: this.entry.cliArgs || ['app-server'], env: this._childEnv(this._env), cwd });
    try {
      await client.start();
      const account = await client.readAccount();
      if (!account.loggedIn) {
        throw new ProviderError(ERROR_CODES.NOT_CONNECTED, 'Codex is not signed in: run `codex login` yourself (Forge never signs in for you)', { provider: this.id });
      }
      return { client, account };
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  // Chat = one thread, one turn. Only the LAST user message is sent: codex keeps its own thread history.
  // Safety defaults (B2 review, MEDIUM): the caller MUST name the working folder (options.cwd, an
  // absolute path) so codex never runs in the gateway's own folder, and the sandbox is explicit:
  // 'read-only' unless the caller asks for 'workspace-write'. 'danger-full-access' is refused.
  async* _chat(req) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    if (!last) throw new ProviderError(ERROR_CODES.CONFIG, 'codex chat needs a user message', { provider: this.id });
    const cwd = req.options.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '' || !path.isAbsolute(cwd)) {
      throw new ProviderError(ERROR_CODES.CONFIG, 'codex chat needs options.cwd: the absolute working folder the thread may read (and write, with sandbox workspace-write)', { provider: this.id });
    }
    const sandbox = req.options.sandbox === undefined ? 'read-only' : req.options.sandbox;
    if (!SANDBOX_MODES.has(sandbox)) {
      throw new ProviderError(ERROR_CODES.CONFIG, 'codex options.sandbox must be read-only (default) or workspace-write; danger-full-access is never used by Forge', { provider: this.id });
    }
    const { client } = await this.openClient({ cwd });
    try {
      const { threadId } = await client.startThread({ cwd, model: req.model || undefined, sandbox });
      yield* client.runTurn({ threadId, text: last.content, model: req.model || undefined, signal: req.options.signal, idleTimeoutMs: req.options.idleTimeoutMs, sandbox });
    } finally {
      await client.close();
    }
  }
}
