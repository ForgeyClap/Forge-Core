// Minimal client for `codex app-server` over stdio. Wire format (checked against the JSON Schema that
// codex-cli 0.156.1 generates with `codex app-server generate-json-schema`): JSON-RPC 2.0 messages
// WITHOUT the "jsonrpc" field, one JSON object per line.
//
//   client -> server requests : initialize, account/read, thread/start, turn/start, turn/interrupt
//   client -> server notify   : initialized
//   server -> client notify   : item/agentMessage/delta, thread/tokenUsage/updated, turn/completed, error, ...
//   server -> client requests : item/commandExecution/requestApproval, item/fileChange/requestApproval,
//                               item/permissions/requestApproval, item/tool/requestUserInput,
//                               mcpServer/elicitation/request (+ legacy execCommandApproval, applyPatchApproval)
//
// ToS rules: this client never calls account/login/start (the user signs in with `codex login`
// themselves), answers account/chatgptAuthTokens/refresh with an error (Forge never handles tokens),
// and reads account state with refreshToken:false. clientInfo.name is the truthful "forge-systeem".
// Approvals are surfaced as { type: 'approval' } events with accept()/decline(); nothing is approved
// automatically. While an approval is pending the turn's idle timer is paused (an unanswered request
// means "paused", never "failed").

import { spawn } from 'node:child_process';
import { ProviderError, ERROR_CODES, redactText } from '../redact-guard.mjs';
import { textEvent, usageEvent, doneEvent } from '../events.mjs';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval',
]);
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const STDERR_KEEP_CHARS = 4000;
// ThreadStartParams.sandbox (SandboxMode) values Forge allows; 'danger-full-access' exists in the enum
// and is deliberately absent here. TurnStartParams.sandboxPolicy.type uses the camelCase spelling.
export const SANDBOX_MODES = new Set(['read-only', 'workspace-write']);
export const SANDBOX_POLICY_TYPE = Object.freeze({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite' });

// Response bodies per approval method for a plain allow / deny. Methods without a safe "allow" shape
// in part 1 only support decline.
function approvalResult(method, allow) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'accept' : 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? 'approved' : 'denied' };
    case 'mcpServer/elicitation/request':
      return allow ? null : { action: 'decline' };
    case 'item/permissions/requestApproval':
      return allow ? null : { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput':
      return allow ? null : { answers: {} };
    default:
      return null;
  }
}

export class CodexAppServerClient {
  constructor({ command, args = ['app-server'], prefixArgs = [], env, cwd, clientInfo = { name: 'forge-systeem', title: 'Forge Systeem', version: '0.1.0' }, requestTimeoutMs = 30_000, spawnImpl = spawn } = {}) {
    this._command = command;
    this._args = [...prefixArgs, ...args];
    this._env = env;
    this._cwd = cwd;
    this._clientInfo = clientInfo;
    this._requestTimeoutMs = requestTimeoutMs;
    this._spawn = spawnImpl;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer, method }
    this._listeners = new Set();
    this._buf = '';
    this._stderr = '';
    this._closed = false;
    this.child = null;
    this.initializeResult = null;
  }

  async start() {
    if (this.child) throw new ProviderError(ERROR_CODES.PROTOCOL, 'app-server already started');
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(this._command, this._args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._env, cwd: this._cwd });
      } catch (err) {
        reject(new ProviderError(ERROR_CODES.NOT_INSTALLED, 'could not start codex app-server (' + (err.code || 'error') + ')'));
        return;
      }
      this.child = child;
      child.once('spawn', resolve);
      child.once('error', (err) => {
        this._closed = true;
        reject(new ProviderError(ERROR_CODES.NOT_INSTALLED, 'could not start codex app-server (' + (err.code || 'error') + ')'));
        this._failAll(new ProviderError(ERROR_CODES.PROTOCOL, 'app-server process error (' + (err.code || 'error') + ')'));
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { if (this._stderr.length < STDERR_KEEP_CHARS) this._stderr += chunk; });
      child.on('exit', (code, signal) => {
        this._closed = true;
        this._failAll(new ProviderError(ERROR_CODES.PROTOCOL, 'app-server exited (code ' + code + (signal ? ', ' + signal : '') + ')' + (this._stderr ? ': ' + redactText(this._stderr.trim()).slice(0, 300) : '')));
        this._emit({ kind: 'exit', code, signal });
      });
      child.stdin.on('error', () => { /* EPIPE after exit is reported through the exit handler */ });
    });
    this.initializeResult = await this.request('initialize', { clientInfo: this._clientInfo });
    this.notify('initialized');
    return this.initializeResult;
  }

  stderrText() { return redactText(this._stderr); }

  _send(obj) {
    if (this._closed || !this.child) throw new ProviderError(ERROR_CODES.PROTOCOL, 'app-server is not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeoutMs = this._requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new ProviderError(ERROR_CODES.TIMEOUT, 'app-server did not answer ' + method + ' within ' + timeoutMs + ' ms'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      try { this._send(params === undefined ? { id, method } : { id, method, params }); }
      catch (err) { clearTimeout(timer); this._pending.delete(id); reject(err); }
    });
  }

  notify(method, params) {
    this._send(params === undefined ? { method } : { method, params });
  }

  respond(id, result) { this._send({ id, result }); }

  respondError(id, code, message) { this._send({ id, error: { code, message } }); }

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(msg) { for (const fn of [...this._listeners]) { try { fn(msg); } catch { /* a listener bug must not break the reader */ } } }

  _failAll(err) {
    for (const [id, p] of this._pending) { clearTimeout(p.timer); p.reject(err); this._pending.delete(id); }
  }

  _onData(chunk) {
    this._buf += chunk;
    if (this._buf.length > MAX_LINE_CHARS) { this._buf = ''; this._emit({ kind: 'protocol-error', message: 'line too long' }); return; }
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this._emit({ kind: 'protocol-error', message: 'non-JSON line from app-server' }); continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && msg.method === undefined) { // response to one of our requests
      const p = this._pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new ProviderError(ERROR_CODES.PROTOCOL, p.method + ' failed: ' + (msg.error.message || 'error') + ' (code ' + msg.error.code + ')'));
      else p.resolve(msg.result);
      return;
    }
    if (hasId && msg.method) { // server -> client request
      if (APPROVAL_METHODS.has(msg.method)) { this._emit({ kind: 'server-request', id: msg.id, method: msg.method, params: msg.params || {} }); return; }
      // Anything else (token refresh, attestation, dynamic tool calls) is refused: Forge handles no tokens.
      try { this.respondError(msg.id, -32601, 'not supported by Forge Systeem'); } catch { /* process gone */ }
      return;
    }
    if (msg.method) this._emit({ kind: 'notification', method: msg.method, params: msg.params || {} });
  }

  // Sign-in state with refreshToken:false. Personal fields (email) are dropped.
  async readAccount() {
    const r = await this.request('account/read', { refreshToken: false });
    const acc = r && r.account ? r.account : null;
    return { loggedIn: !!acc, accountType: acc ? acc.type || null : null, planType: acc && acc.planType ? acc.planType : null, requiresOpenaiAuth: !!(r && r.requiresOpenaiAuth) };
  }

  // Starts a thread with an EXPLICIT sandbox: the user's own ~/.codex config never decides it. The
  // sandbox value is the 0.156.1 `SandboxMode` enum of ThreadStartParams; 'danger-full-access' is
  // refused here, whatever the caller asks.
  async startThread({ cwd, model, approvalPolicy = 'on-request', ephemeral = true, sandbox = 'read-only' } = {}) {
    if (!SANDBOX_MODES.has(sandbox)) {
      throw new ProviderError(ERROR_CODES.CONFIG, 'codex sandbox must be read-only or workspace-write (got ' + String(sandbox) + ')');
    }
    const params = { approvalPolicy, ephemeral, sandbox };
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    const r = await this.request('thread/start', params);
    const threadId = r && r.thread && r.thread.id;
    if (!threadId) throw new ProviderError(ERROR_CODES.PROTOCOL, 'thread/start returned no thread id');
    return { threadId, model: r.model || null, sandbox };
  }

  // Runs one turn; yields normalised events and { type: 'approval' } events. The turn repeats the
  // sandbox as TurnStartParams.sandboxPolicy ({ type: readOnly | workspaceWrite }, only `type` is
  // required by the 0.156.1 schema) so a thread-level default can never be widened per turn.
  async* runTurn({ threadId, text, model, idleTimeoutMs = 120_000, signal, sandbox = 'read-only' } = {}) {
    if (!SANDBOX_MODES.has(sandbox)) {
      throw new ProviderError(ERROR_CODES.CONFIG, 'codex sandbox must be read-only or workspace-write (got ' + String(sandbox) + ')');
    }
    const queue = [];
    let wake = null;
    const push = (m) => { queue.push(m); if (wake) { wake(); wake = null; } };
    const unsubscribe = this.subscribe(push);
    let turnId = null;
    let pendingApprovals = 0;
    let lastUsage = null;
    const onAbort = () => push({ kind: 'abort' });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const params = { threadId, input: [{ type: 'text', text }], sandboxPolicy: { type: SANDBOX_POLICY_TYPE[sandbox] } };
      if (model) params.model = model;
      const started = await this.request('turn/start', params);
      turnId = started && started.turn ? started.turn.id : null;
      for (;;) {
        if (queue.length === 0) {
          let idleTimer = null;
          const timedOut = await new Promise((resolve) => {
            wake = () => resolve(false);
            if (pendingApprovals === 0) idleTimer = setTimeout(() => resolve(true), idleTimeoutMs);
          });
          clearTimeout(idleTimer);
          wake = null;
          if (timedOut && queue.length === 0) {
            try { await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }); } catch { /* best effort */ }
            throw new ProviderError(ERROR_CODES.TIMEOUT, 'codex turn idle for ' + idleTimeoutMs + ' ms; interrupted');
          }
          continue;
        }
        const m = queue.shift();
        if (m.kind === 'abort') {
          try { await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }); } catch { /* best effort */ }
          throw new ProviderError(ERROR_CODES.ABORTED, 'turn aborted');
        }
        if (m.kind === 'exit') throw new ProviderError(ERROR_CODES.PROTOCOL, 'app-server exited during the turn' + (this._stderr ? ': ' + this.stderrText().trim().slice(0, 300) : ''));
        if (m.kind === 'server-request') {
          if (m.params.threadId && m.params.threadId !== threadId) continue;
          pendingApprovals += 1;
          let answered = false;
          const answer = (result) => {
            if (answered) throw new ProviderError(ERROR_CODES.PROTOCOL, 'approval already answered');
            answered = true; pendingApprovals -= 1; this.respond(m.id, result); push({ kind: 'tick' });
          };
          yield {
            type: 'approval', requestId: m.id, method: m.method, itemId: m.params.itemId || null, turnId: m.params.turnId || turnId,
            command: typeof m.params.command === 'string' ? m.params.command : null, reason: typeof m.params.reason === 'string' ? m.params.reason : null,
            accept: () => { const r = approvalResult(m.method, true); if (!r) throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED, 'accept is not supported for ' + m.method + ' yet'); answer(r); },
            decline: () => answer(approvalResult(m.method, false) || {}),
          };
          continue;
        }
        if (m.kind !== 'notification') continue;
        const p = m.params;
        if (p.threadId && p.threadId !== threadId) continue;
        if (m.method === 'item/agentMessage/delta' && typeof p.delta === 'string' && p.delta) yield textEvent(p.delta);
        else if (m.method === 'thread/tokenUsage/updated' && p.tokenUsage && p.tokenUsage.last) lastUsage = p.tokenUsage.last;
        else if (m.method === 'error' && p.willRetry === false) throw new ProviderError(ERROR_CODES.HTTP, (p.error && p.error.message) || 'codex reported an error');
        else if (m.method === 'turn/completed') {
          const turn = p.turn || {};
          if (lastUsage) yield usageEvent({ inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens, totalTokens: lastUsage.totalTokens, cachedInputTokens: lastUsage.cachedInputTokens });
          if (turn.status === 'failed') throw new ProviderError(ERROR_CODES.HTTP, (turn.error && turn.error.message) || 'codex turn failed');
          yield doneEvent({ stopReason: turn.status || 'completed', model: model || null });
          return;
        }
      }
    } finally {
      unsubscribe();
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // Ends the process we started. EOF on stdin is the primary shutdown (codex-cli 0.156.1 exits 0 on it,
  // measured live); after the grace period our OWN child is killed by its exact handle. On Windows the
  // npm launcher (codex.js) does not forward a kill to the native binary, so the pipes are destroyed as
  // well: the native process shares them and exits on the broken pipe.
  async close({ graceMs = 2000 } = {}) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) { this._closed = true; return; }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        for (const s of [child.stdin, child.stdout, child.stderr]) { try { s.destroy(); } catch { /* ignore */ } }
        resolve();
      }, graceMs);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.stdin.end(); } catch { /* ignore */ }
    });
    this._closed = true;
  }
}
