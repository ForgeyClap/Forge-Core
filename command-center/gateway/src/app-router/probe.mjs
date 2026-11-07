// App router P2 — the user-clicked Test of one chain entry (design 3.3 step 3, 5.2 rule 6, 6.1).
//
//   runTargetProbe(entry, { timeoutMs?, defaultThresholdPct? })
//     -> Promise<{ ok, state, reading|null, detail, outcome, code|null, recorded: true }>   (never rejects)
//
// claude-account: ONE tiny real turn (exec-argv.mjs PROBE_ARGS: `-p .` on haiku, one model turn, no
//   session file, no MCP server) under the account's profile folder, in a private temp folder that is
//   removed afterwards, with stdin closed and a 60 s cap (the exact PID this module spawned is killed,
//   tree included). The usage reading comes from the probe's own rate_limit_event lines. A lost login
//   marks the account needs-login; a limit records the limit hit.
// provider-model: the provider's existing testConnection() plus "is the model in listModels()", with
//   the ENTRY's own vars (review finding 12: the same server a turn will talk to).
// codex-account: the existing codex detection (signed in or not).
//
// One writer per fact: this module stores what the probe proved (reading, limit hit, needs-login,
// down) and says so with recorded:true, so the route does not store it again; the route writes the
// one router_test line per click (also for a click whose probe timed out or threw).
// The 1-per-5-minutes limit and the decision WHO may start a test (the dashboard session, never the
// agent token) belong to the route (P3). This module never reads a login file and never stores one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { buildProbeSpawnSpec } from '../exec-argv.mjs';
import { execSpawnEnv, withClaudeProfileEnv } from '../exec-cli.mjs';
import { killChildTree } from '../exec-lifecycle.mjs';
import { classifyStreamLine, classifyErrorText, classifyExit } from '../error-catalogue.mjs';
import { profileDir } from './profiles.mjs';
import { recordReading, recordLimitHit, markNeedsLogin, markDown, readReadings, targetState } from './usage-readings.mjs';
import { createRouterProvider } from './provider-turn.mjs';
import { mergeReadings } from './turn-router.mjs';
import { ENTRY_KINDS, LIMITS } from './contract.mjs';

export const PROBE_TIMEOUT_MS = 60_000;
const MAX_LINES = 200;
const TEXT_CAP = 4000;

let probeSpecOverride = null;
/** Test seam: replaces buildProbeSpawnSpec (fn() -> { cmd, args }); null restores it. */
export function _setProbeSpawnSpecForTests(fn) { probeSpecOverride = typeof fn === 'function' ? fn : null; }

// Spawns the probe child and collects its output. Resolves once; never rejects.
function runProbeChild(spec, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const out = { exitCode: null, spawnError: null, timedOut: false, lines: [], unparsed: '', stderr: '' };
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(out); } };
    let child;
    try {
      child = spawn(spec.cmd, spec.args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (err) {
      out.spawnError = err && err.message ? err.message : String(err);
      done();
      return;
    }
    // stdin is closed at once (spike S2: an open, silent stdin costs a 3 s wait). An EPIPE from a child
    // that already exited is recorded in the result instead of crashing the gateway.
    child.stdin.on('error', (err) => { out.stdinError = (err && err.code) || 'error'; });
    child.stdin.end();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim() || out.lines.length >= MAX_LINES) return;
      try {
        out.lines.push(JSON.parse(line));
      } catch {
        if (out.unparsed.length < TEXT_CAP) out.unparsed += line.slice(0, TEXT_CAP - out.unparsed.length) + '\n';
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { if (out.stderr.length < TEXT_CAP) out.stderr += c.slice(0, TEXT_CAP - out.stderr.length); });
    const timer = setTimeout(() => { out.timedOut = true; killChildTree(child); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (err) => { clearTimeout(timer); out.spawnError = err && err.message ? err.message : String(err); done(); });
    child.on('close', (code) => { clearTimeout(timer); out.exitCode = code; done(); });
  });
}

/** The outcome of a finished probe child. Pure; exported for tests. */
export function probeOutcome(run) {
  if (run.timedOut) return { outcome: 'error', detail: 'timeout' };
  if (run.spawnError) return { outcome: 'error', detail: classifyExit({ spawnError: run.spawnError }).code };
  let streamError = null;
  let result = null;
  for (const line of run.lines) {
    const e = classifyStreamLine(line);
    if (e && e.code !== 'api_retry') streamError = e;
    if (line && line.type === 'result') result = line;
  }
  if (run.exitCode === 0 && !(result && result.is_error === true)) return { outcome: 'ok', detail: 'ok' };
  let code = streamError ? streamError.code : null;
  if (!code) {
    const fromExit = classifyExit({ exitCode: run.exitCode, stderr: run.stderr });
    if (fromExit && fromExit.code !== 'unknown') code = fromExit.code;
  }
  if (!code && run.unparsed) {
    const fromText = classifyErrorText(run.unparsed);
    if (fromText.code !== 'unknown') code = fromText.code;
  }
  if (code === 'rate_limited') return { outcome: 'rate_limited', detail: 'rate_limited', resumeAt: (streamError && streamError.resume_at) || null };
  if (code === 'logged_out') return { outcome: 'logged_out', detail: 'logged_out' };
  return { outcome: 'error', detail: code || 'error' };
}

async function probeClaude(entry, { timeoutMs }) {
  let claudeConfigDir = null;
  if (typeof entry.profile === 'string') {
    const pd = profileDir(entry.profile, { mustExist: true });
    if (!pd.ok) {
      markNeedsLogin(entry.id);
      return { outcome: 'logged_out', detail: 'profile_' + pd.code };
    }
    claudeConfigDir = pd.dir;
  }
  const spec = (probeSpecOverride || buildProbeSpawnSpec)();
  if (!spec || !spec.cmd) return { outcome: 'error', detail: 'cli_missing' };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-router-probe-'));
  let run;
  try {
    const base = execSpawnEnv({});
    const env = claudeConfigDir ? withClaudeProfileEnv(base, claudeConfigDir) : base;
    run = await runProbeChild(spec, { cwd, env, timeoutMs });
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* an empty temp folder this module created; a leftover is harmless and the OS cleans temp */
    }
  }
  const r = probeOutcome(run);
  const reading = mergeReadings(run.lines.filter((l) => l && l.type === 'rate_limit_event'));
  if (reading) recordReading(entry.id, reading, { source: 'test' });
  else if (r.outcome === 'ok') recordReading(entry.id, { status: 'allowed', windows: [] }, { source: 'test' }); // it answered: clears a lost-login mark
  if (r.outcome === 'logged_out') markNeedsLogin(entry.id);
  if (r.outcome === 'rate_limited') {
    const rejected = reading ? reading.windows.find((w) => w.status === 'rejected') : null;
    recordLimitHit(entry.id, { resets_at: r.resumeAt || (rejected && rejected.resets_at) || null, window: rejected ? rejected.type : null });
  }
  return { ...r, reading };
}

function modelListed(ids, model) {
  if (!model) return true;
  return ids.includes(model) || ids.includes(model + ':latest') || (model.endsWith(':latest') && ids.includes(model.slice(0, -':latest'.length)));
}

// The error-catalogue code of a down provider, so the route can show the matching card state.
function downCode(detail, isOllama) {
  if (detail === 'ollama_down' || detail === 'model_not_pulled') return detail;
  return !isOllama && detail === 'unreachable' ? 'offline' : null;
}

async function probeProvider(entry) {
  let provider;
  try {
    provider = createRouterProvider(entry);
  } catch {
    return { outcome: 'error', detail: 'unknown_provider' };
  }
  const isOllama = entry.kind === 'provider-model' && typeof entry.provider === 'string' && entry.provider.startsWith('ollama');
  let test;
  try {
    test = await provider.testConnection();
  } catch (err) {
    test = { ok: false, state: err && err.code === 'NETWORK' ? 'unreachable' : 'error' };
  }
  if (!test || test.ok !== true) {
    const state = test && test.state;
    if (state === 'unreachable' || state === 'not-installed') {
      markDown(entry.id);
      const detail = isOllama ? 'ollama_down' : state;
      return { outcome: 'down', detail, code: downCode(detail, isOllama) };
    }
    if (state === 'not-connected') {
      markDown(entry.id);
      return { outcome: 'logged_out', detail: 'not_connected' };
    }
    return { outcome: 'error', detail: typeof state === 'string' ? state.replace(/-/g, '_') : 'error' };
  }
  if (entry.kind === 'provider-model' && entry.model) {
    let list = null;
    try {
      list = await provider.listModels();
    } catch {
      list = null; // a server that answers the test but not the list: the model check is skipped, not failed
    }
    const ids = list && Array.isArray(list.models) ? list.models.map((m) => m && m.id).filter((id) => typeof id === 'string') : null;
    if (ids && !modelListed(ids, entry.model)) {
      markDown(entry.id);
      const detail = isOllama ? 'model_not_pulled' : 'model_not_listed';
      return { outcome: 'down', detail, code: downCode(detail, isOllama) };
    }
  }
  return { outcome: 'ok', detail: 'ok' };
}

/**
 * Tests one chain entry and stores what it proved. Never rejects. `recorded: true` tells the caller the
 * usage store is already up to date (nothing to store again); the caller logs router_test.
 * @param {object} entry  a router entry
 * @param {{timeoutMs?: number, defaultThresholdPct?: number}} [opts]
 */
export async function runTargetProbe(entry, { timeoutMs = PROBE_TIMEOUT_MS, defaultThresholdPct = LIMITS.THRESHOLD_DEFAULT } = {}) {
  if (!entry || typeof entry !== 'object' || !ENTRY_KINDS.includes(entry.kind)) {
    return { ok: false, state: 'unknown', reading: null, detail: 'bad_entry', outcome: 'error', code: null, recorded: true };
  }
  let r;
  try {
    r = entry.kind === 'claude-account' ? await probeClaude(entry, { timeoutMs }) : await probeProvider(entry);
  } catch {
    r = { outcome: 'error', detail: 'probe_failed' };
  }
  const st = targetState(entry, readReadings()[entry.id] || null, { defaultThresholdPct });
  return { ok: r.outcome === 'ok', state: st.state, reading: r.reading || null, detail: r.detail, outcome: r.outcome, code: r.code || null, recorded: true };
}
