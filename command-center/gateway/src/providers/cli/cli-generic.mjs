// cli-generic adapter (gemini-cli, grok-build-cli): detection only, `<command> --version`.
// Chat is not implemented (headless flags unverified in the catalogue). The version text is reported
// so a user can tell an unrelated program with the same name apart (bare `grok` may be a third-party
// CLI). Sign-in state is not probed: neither CLI has a verified status command.

import { BaseProvider } from '../provider-base.mjs';
import { ProviderError, ERROR_CODES, redactText } from '../redact-guard.mjs';
import { resolveCli, runCli, probeEnv, firstLine } from './cli-resolve.mjs';

export async function detectGenericCli(command, { resolver = resolveCli, run = runCli, env = process.env } = {}) {
  const resolved = await resolver(command, { env });
  if (!resolved) return { installed: false, state: 'not-installed', detail: command + ' was not found on PATH' };
  const ver = await run(resolved, ['--version'], { env: probeEnv(env), timeoutMs: 15_000 });
  if (ver.code !== 0) {
    return { installed: true, path: resolved.path, state: 'error', detail: command + ' --version failed (exit ' + ver.code + '): ' + redactText(firstLine(ver.stderr || ver.stdout)) };
  }
  return { installed: true, path: resolved.path, via: resolved.via, versionText: redactText(firstLine(ver.stdout)), state: 'installed', detail: 'installed; chat through this CLI is not implemented' };
}

export class GenericCliProvider extends BaseProvider {
  constructor(entry, opts = {}) {
    super(entry, opts);
    this._detect = opts.detect || ((o) => detectGenericCli(entry.command, o));
    this._env = opts.env || process.env;
  }

  requiresModel() { return false; }

  async health() {
    const d = await this._detect({ env: this._env });
    return { ok: false, state: d.state, network: false, detail: d.detail };
  }

  async testConnection() {
    const started = Date.now();
    const d = await this._detect({ env: this._env });
    return { ok: false, state: d.state, latencyMs: Date.now() - started, detail: d.detail, versionText: d.versionText || null };
  }

  // eslint-disable-next-line require-yield
  async* _chat() {
    throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED, this.entry.label + ': chat is not implemented (detection only)', { provider: this.id });
  }
}
