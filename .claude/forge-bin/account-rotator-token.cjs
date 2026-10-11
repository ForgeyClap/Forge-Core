#!/usr/bin/env node
'use strict';
/**
 * account-rotator-token.cjs — TOKEN MODE of the account rotator (owner amendment 2026-10-09; rework round 1).
 * A slot may hold a long-lived `claude setup-token` token. Claude Code reads CLAUDE_CODE_OAUTH_TOKEN before
 * ~/.claude/.credentials.json, so:
 *  - `launch` starts a NEW Claude Code session with that variable in the CHILD's environment only — it then reaches that
 *    session and every process it starts (its whole process tree), never this shell or any other session;
 *  - `env <name> --i-know` prints one line that loads the token into the CURRENT SHELL (and everything started from it);
 *    the line calls the hidden `token-for-shell`, so the token itself never appears on screen or in shell history.
 *  A running session cannot change its own environment: token mode reaches NEW sessions only.
 *
 * AR-08 binding: at `enroll-token` into a slot that holds a login, the token is bound to that account only when the
 *  usage endpoint gives matching readings for the token and the slot's own still-valid access token (reset times are
 *  per-account facts; sameAccountReading in the core); a mismatch is refused; when nothing comparable can be measured the
 *  owner must pass --confirm-same-account and the binding is recorded as 'unverified'. Re-enrolling drops the old token
 *  readings; an account reading is only ever used for a token whose binding is 'verified'.
 * M3/L: `env` and `token-for-shell` refuse inside an AI agent's tool environment (CLAUDECODE and friends) and refuse a
 *  non-terminal stdout unless --i-know is given; `token-for-shell` also refuses a terminal (it would print the token).
 *  A token passed as an argument (`--token=...`, `--token ...` or a bare word) is refused with a warning to revoke it.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const M = require('./account-rotator-measure.cjs');
const guardRedact = require('./usage-guard-redact.cjs');

const SCRIPT = path.join(__dirname, 'account-rotator.cjs');
const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
const REVOKE = 'het token staat nu in je shell-geschiedenis: trek het in en maak een nieuw met `claude setup-token` / the token is now in your shell history: revoke it and create a new one with `claude setup-token`';

function agentMarker(env) { const e = env || process.env; return AGENT_MARKERS.find((k) => e[k] !== undefined && e[k] !== '') || null; }
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function posixQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
const isTTYOf = (deps) => (deps.isTTY !== undefined ? deps.isTTY : !!process.stdout.isTTY);

// ---- enroll-token ---------------------------------------------------------------------------------------------
async function cmdEnrollToken(P, args, deps, h) {
  const pos = h.positional(args);
  if (args.some((a) => /^--token(=|$)/.test(a)) || pos.length > 1) {
    deps.err('geweigerd / refused — geef het token NOOIT als argument; gebruik stdin of FORGE_ROTATOR_ENROLL_TOKEN / never pass the token as an argument; use stdin or FORGE_ROTATOR_ENROLL_TOKEN');
    deps.err('⚠ ' + REVOKE);
    return 2;
  }
  const name = pos[0];
  if (!vault.validName(name)) { deps.err('gebruik / usage: enroll-token <naam/name> [--force] [--confirm-same-account]  (token via stdin of / or FORGE_ROTATOR_ENROLL_TOKEN)'); return 2; }
  const env = deps.env || process.env;
  let token = env.FORGE_ROTATOR_ENROLL_TOKEN || '';
  if (!token && deps.readStdin) token = await deps.readStdin();
  token = String(token || '').trim();
  if (!token) { deps.err('geen token ontvangen / no token received — pipe the `claude setup-token` output into: node account-rotator.cjs enroll-token ' + name); return 2; }
  if (!guardRedact.validateTokenShape(token)) { deps.err('geweigerd / refused — het token heeft een onverwachte vorm / the token has an unexpected shape'); return 3; }
  vault.registerSecret(token);
  const dup = vault.listSlots(P).find((s) => s.name !== name && s.token === token);
  if (dup) { deps.err('geweigerd / refused — dit token staat al bij "' + dup.name + '" / this token is already stored for "' + dup.name + '"'); return 3; }
  const existing = vault.readSlot(P, name);
  if (existing && existing.token && !args.includes('--force')) { deps.err('geweigerd / refused — "' + name + '" heeft al een token; vervangen met --force / already has a token; replace with --force'); return 3; }
  const now = deps.now();
  // the network measurements run OUTSIDE the lock; the slot is re-read and re-validated INSIDE it (AR-V04)
  let binding;
  const loginRt = existing && !existing.broken && existing.credentials ? existing.credentials.claudeAiOauth.refreshToken : null;
  if (existing && !existing.broken && existing.credentials && existing.oauthAccount) {
    const m1 = h.gateOk ? await M.measureToken(token, deps) : null;
    const at = existing.credentials.claudeAiOauth;
    const m2 = h.gateOk && m1 && m1.ok && M.expiresMs(at) > now + 60000 ? await M.measureToken(at.accessToken, deps) : null;
    const same = m1 && m1.ok && m2 && m2.ok ? core.sameAccountReading(m1, m2, { now, pctTol: 2 }) : null; // AR-V09: two windows, non-null resets
    if (same === false) { deps.err('geweigerd / refused — dit token hoort bij een ANDER account dan "' + name + '" (andere gebruikscijfers) / this token belongs to a DIFFERENT account than "' + name + '" (usage readings differ)'); return 3; }
    if (same === true) binding = { status: 'verified', method: 'usage readings match the enrolled login on two windows with reset times', at: new Date(now).toISOString() };
    else if (!args.includes('--confirm-same-account')) {
      deps.err('niet ingeschreven / not enrolled — kon niet nagaan of dit token bij "' + name + '" hoort (' + (m1 && !m1.ok && m1.kind === 'unauthorized' ? 'token niet meetbaar / token unmeasurable (401/403)' : 'geen twee vergelijkbare vensters / fewer than two comparable windows')
        + '). Zeker? Herhaal met --confirm-same-account (de koppeling wordt dan als onbevestigd bewaard) / sure? repeat with --confirm-same-account (the binding is then stored as unverified)');
      return 3;
    } else binding = { status: 'unverified', reason: m1 && !m1.ok ? (m1.kind === 'unauthorized' ? 'token unmeasurable (401/403)' : m1.error) : 'fewer than two comparable windows', at: new Date(now).toISOString() };
  } else binding = { status: 'standalone', at: new Date(now).toISOString() };
  const lock = await vault.withTxnLock(P, async () => {
    const cur = vault.readSlot(P, name);
    if (vault.listSlots(P).some((s) => s.name !== name && s.token === token)) return { code: 3, err: 'geweigerd / refused — dit token staat al bij een ander account / this token is already stored for another account' };
    if (cur && cur.token && !args.includes('--force')) return { code: 3, err: 'geweigerd / refused — "' + name + '" heeft al een token; vervangen met --force / already has a token; replace with --force' };
    const curRt = cur && !cur.broken && cur.credentials ? cur.credentials.claudeAiOauth.refreshToken : null;
    if (curRt !== loginRt) return { code: 3, err: 'niet ingeschreven / not enrolled — de login van "' + name + '" veranderde tijdens het inschrijven; probeer opnieuw / the login of "' + name + '" changed during enrolment; retry' };
    vault.writeSlot(P, Object.assign({}, cur && !cur.broken ? cur : { name }, { name, token, tokenBinding: binding, tokenEnrolledAt: new Date(now).toISOString() }));
    const saved = await vault.updateState(P, (s) => { delete s.tokenReadings[name]; }); // re-enrolling invalidates the old token readings
    return { code: 0, stateSaved: !!saved };
  }, { timeoutMs: Number.isFinite(deps.enrollLockMs) ? deps.enrollLockMs : 60000 });
  if (!lock.ok) { deps.err('bezet / busy — een accountwissel loopt; probeer zo opnieuw / an account switch is running; try again shortly'); return 1; }
  if (lock.value.code) { deps.err(lock.value.err); return lock.value.code; }
  vault.log(P, 'token ingeschreven / token enrolled for ' + name + ' (binding ' + binding.status + ')', { quiet: true });
  deps.out('token ingeschreven / token enrolled: ' + name + ' [' + core.slotMode(vault.readSlot(P, name)) + '] · koppeling/binding: ' + binding.status + ' — starten / start: launch --account ' + name + ' -- <claude args>');
  return 0;
}

// ---- launch ---------------------------------------------------------------------------------------------------
/** tokenReading(name, slot, tr, ar) — the reading that may be used for this TOKEN: its own token-measured reading, or
 *  (only while the token is unmeasurable AND its binding is 'verified') the bound account's reading. Never another
 *  account's reading. */
function tokenReading(slot, tr, ar) {
  const own = tr[slot.name];
  if (own && own.unmeasurable && slot.tokenBinding && slot.tokenBinding.status === 'verified' && ar[slot.name] && ar[slot.name].windows) {
    return Object.assign({}, ar[slot.name], { unmeasurable: own.unmeasurable });
  }
  return own;
}
/** measureTokens(slots, st, deps, now) -> {tr, ar}: fresh copies of the token readings (own setup token) and, for a
 *  VERIFIED binding whose token is unmeasurable, the bound login's reading (its own stored token — viaSlotToken). Pure
 *  apart from the network; the caller persists the result under the lock. */
async function measureTokens(slots, st, deps, now) {
  const tr = Object.assign({}, st.tokenReadings); const ar = Object.assign({}, st.readings);
  for (const s of slots) {
    const prev = tr[s.name] || {};
    if (Date.parse(prev.measuredAt) > now - M.INACTIVE_REFRESH_MS && !prev.unmeasurable) continue;
    const m = await M.measureToken(s.token, deps);
    if (m.ok) { tr[s.name] = Object.assign({}, prev, M.liveReading(m, now)); continue; }
    if (m.kind !== 'unauthorized') continue;
    tr[s.name] = Object.assign({}, prev, { unmeasurable: { at: new Date(now).toISOString(), status: m.status } });
    const oauth = s.credentials && s.credentials.claudeAiOauth;
    if (s.tokenBinding && s.tokenBinding.status === 'verified' && oauth && M.expiresMs(oauth) > now + 60000) {
      const m2 = await M.measureToken(oauth.accessToken, deps);
      if (m2.ok) ar[s.name] = Object.assign({}, ar[s.name] || {}, M.liveReading(m2, now, { viaSlotToken: true }));
    }
  }
  return { tr, ar };
}
async function chooseLaunch(P, S, deps) {
  const now = deps.now();
  const slots = vault.listSlots(P).filter((s) => !s.broken && s.token);
  if (!slots.length) return { name: null, why: 'geen token-accounts / no token accounts (enroll-token <name>)' };
  const st = vault.readState(P);
  const { tr, ar } = await measureTokens(slots, st, deps, now);
  await vault.updateState(P, (s) => { for (const x of slots) { if (tr[x.name]) s.tokenReadings[x.name] = tr[x.name]; if (ar[x.name]) s.readings[x.name] = ar[x.name]; } });
  const v = slots.map((s) => ({ name: s.name, eligible: true, reading: core.effectiveReading(tokenReading(s, tr, ar), now), lastUsedAt: (tr[s.name] || {}).lastUsedAt || null }));
  const sel = core.selectTarget({ accounts: v, activeName: null, threshold: S.threshold.value, now, lastLeft: null });
  if (sel.target && sel.tier !== 'unknown') return { name: sel.target, why: sel.tier + ' ' + core.fmtPct((sel.ranked[0] || {}).maxPct) };
  const unknown = sel.ranked.filter((r) => r.tier === 'unknown').map((r) => v.find((x) => x.name === r.name));
  if (unknown.length) { const rr = core.roundRobin(unknown, now); return { name: rr.name, why: rr.why }; }
  return { name: null, why: 'alle token-accounts zitten boven de drempel / every token account is over the threshold', soonestResetAt: sel.soonestResetAt };
}
function resolveClaudeBin(deps) {
  const env = deps.env || process.env;
  if (deps.claudeBin) return deps.claudeBin;
  if (env.FORGE_ROTATOR_CLAUDE_BIN) return env.FORGE_ROTATOR_CLAUDE_BIN;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const p = path.join(dir, 'claude' + e); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}
/** cmdArgsUnsafe(args) -> reason|null — arguments (the shim path included) that cannot be passed safely through a .cmd
 *  shim: % (cmd expands %VAR% even inside quotes), ! (delayed expansion), " (would end our quoting), a newline, a
 *  trailing backslash (escapes the closing quote), or an empty word after cmd's /s stripping. Refused, never escaped. */
function cmdArgsUnsafe(args) {
  if (args.some((a) => typeof a !== 'string')) return 'a non-string argument';
  if (args.some((a) => /[%!"\r\n\0]/.test(a))) return 'arguments with % ! " or a newline';
  if (args.some((a) => /\\$/.test(a))) return 'an argument ending in a backslash (it would escape the closing quote)';
  return null;
}
/** cmdWrapperArgv(bin, args) -> {argv} | {refused}: the cmd.exe argument vector for a .cmd/.bat shim — /d (no AutoRun),
 *  /v:off (no delayed !expansion!), /s /c with every word double-quoted; unsafe arguments are refused, never escaped. */
function cmdWrapperArgv(bin, args) {
  const bad = cmdArgsUnsafe([bin, ...args]);
  if (bad) return { refused: bad + ' cannot be passed safely through a .cmd shim — install the native claude.exe or set FORGE_ROTATOR_CLAUDE_BIN' };
  return { argv: ['/d', '/v:off', '/s', '/c', '"' + [bin, ...args].map((a) => '"' + a + '"').join(' ') + '"'] };
}
/** binUnsafe(bin) -> reason|null — a launcher that cannot be started directly: a PowerShell shim (.ps1 needs a
 *  PowerShell host — its argument re-parsing is not under our control), or a path with a newline. */
function binUnsafe(bin) {
  if (typeof bin !== 'string' || !bin.trim()) return 'no launcher path';
  if (/\.ps1$/i.test(bin)) return 'a PowerShell shim (.ps1) cannot be launched directly — point FORGE_ROTATOR_CLAUDE_BIN at claude.exe or claude.cmd';
  if (/[\r\n\0]/.test(bin)) return 'a launcher path with a newline';
  return null;
}
function spawnClaude(bin, args, env) {
  const badBin = binUnsafe(bin);
  if (badBin) return Promise.resolve({ refused: badBin });
  let cmd = bin; let argv = args; const opts = { stdio: 'inherit', env };
  if (/\.(c|m)?js$/i.test(bin)) { cmd = process.execPath; argv = [bin, ...args]; }
  else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const w = cmdWrapperArgv(bin, args);
    if (w.refused) return Promise.resolve({ refused: w.refused });
    cmd = env.ComSpec || process.env.ComSpec || 'cmd.exe';
    argv = w.argv;
    opts.windowsVerbatimArguments = true;
  }
  return new Promise((res) => {
    const child = spawn(cmd, argv, opts);
    child.on('error', () => res({ code: 127 }));
    child.on('exit', (code) => res({ code: code === null ? 1 : code }));
  });
}
async function cmdLaunch(P, S, argv, deps, h) {
  if (!h.gateOk) { deps.err('account-rotator staat uit (of instellingen onleesbaar) — eenmalig toch: --force / is off (or settings unreadable) — once anyway: --force'); return 3; }
  const flags = h.flagsOf(argv);
  const sep = argv.indexOf('--');
  const claudeArgs = sep >= 0 ? argv.slice(sep + 1) : [];
  const ai = flags.indexOf('--account');
  const want = ai >= 0 ? flags[ai + 1] : null;
  if (ai >= 0 && !vault.validName(want)) { deps.err('gebruik / usage: launch [--account <naam/name>|--auto] -- <claude args> — --account heeft een geldige accountnaam nodig / needs a valid account name'); return 2; }
  if (ai >= 0 && flags.includes('--auto')) { deps.err('gebruik / usage: kies --account <naam/name> OF --auto, niet allebei / pick --account <name> OR --auto, not both'); return 2; }
  // the account choice and its state write run under the transaction lock; the long-running session does not
  const lock = await vault.withTxnLock(P, async () => {
    let pick;
    if (want) {
      const s = vault.readSlot(P, want);
      if (!s || !s.token) return { refused: '"' + want + '" heeft geen setup-token (enroll-token ' + want + ') / has no setup token' };
      pick = { name: want, why: 'handmatig gekozen / chosen manually' };
    } else pick = await chooseLaunch(P, S, deps);
    if (pick.name) await vault.updateState(P, (s) => { s.tokenReadings[pick.name] = Object.assign({}, s.tokenReadings[pick.name] || {}, { lastUsedAt: new Date(deps.now()).toISOString() }); });
    return { pick };
  }, { timeoutMs: Number.isFinite(deps.launchLockMs) ? deps.launchLockMs : 60000 });
  if (!lock.ok) { deps.err('bezet / busy — een accountwissel loopt; probeer zo opnieuw / an account switch is running; try again shortly'); return 1; }
  if (lock.value.refused) { deps.err('geweigerd / refused — ' + lock.value.refused); return 3; }
  const pick = lock.value.pick;
  if (!pick.name) { deps.err('geen bruikbaar token-account / no usable token account — ' + pick.why + (pick.soonestResetAt ? ' · vroegste reset / soonest reset ' + pick.soonestResetAt : '')); return 3; }
  const slot = vault.readSlot(P, pick.name);
  const env = deps.env || process.env;
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (env[k]) deps.err('let op / note: ' + k + ' staat in je omgeving en kan voorrang krijgen / is set and may take precedence');
  const bin = resolveClaudeBin(deps);
  if (!bin) { deps.err('claude niet gevonden op PATH / claude not found on PATH — zet / set FORGE_ROTATOR_CLAUDE_BIN'); return 1; }
  const childEnv = Object.assign({}, env, { CLAUDE_CODE_OAUTH_TOKEN: slot.token }); // child only — never process.env
  vault.log(P, 'launch ' + pick.name + ' (' + pick.why + ')', { quiet: true });
  deps.out('start Claude Code met / starts Claude Code with ' + pick.name + ' (' + pick.why + ') — alleen deze nieuwe sessie en haar subprocessen / only this new session and its child processes');
  const r = await (deps.spawnClaude || spawnClaude)(bin, claudeArgs, childEnv);
  if (r.refused) { deps.err('geweigerd / refused — ' + r.refused); return 3; }
  return r.code;
}

// ---- env / token-for-shell --------------------------------------------------------------------------------------
function refuseInAgentOrPipe(deps, args, cmd) {
  const marker = agentMarker(deps.env || process.env);
  if (marker) return 'geweigerd in een AI-agentomgeving (' + marker + ' staat aan) — voer dit zelf uit in je eigen terminal / refused inside an AI agent\'s tool environment (' + marker + ' is set) — run it yourself in your own terminal';
  if (cmd === 'token-for-shell' && isTTYOf(deps)) return 'geweigerd — dit zou het token op je scherm zetten; gebruik de regel van `env` / refused — this would print the token on screen; use the line `env` prints';
  if (!isTTYOf(deps) && !args.includes('--i-know')) return 'geweigerd — uitvoer gaat niet naar een terminal; alleen met --i-know / refused — output is not a terminal; only with --i-know';
  return null;
}
function cmdEnv(P, args, deps, h) {
  const name = h.positional(args)[0];
  const s = name && vault.readSlot(P, name);
  if (!s || !s.token) { deps.err('gebruik / usage: env <naam/name> [--shell powershell|posix] [--i-know] — het account heeft een setup-token nodig / needs a setup token'); return 2; }
  const why = refuseInAgentOrPipe(deps, args, 'env');
  if (why) { deps.err(why); return 3; }
  const si = args.indexOf('--shell');
  const shell = si >= 0 ? args[si + 1] : (process.platform === 'win32' ? 'powershell' : 'posix');
  if (shell === 'powershell') deps.out('$env:CLAUDE_CODE_OAUTH_TOKEN = (& ' + psQuote(process.execPath) + ' ' + psQuote(SCRIPT) + ' token-for-shell ' + name + ' --i-know)');
  else if (shell === 'posix') deps.out('export CLAUDE_CODE_OAUTH_TOKEN=$(' + posixQuote(process.execPath) + ' ' + posixQuote(SCRIPT) + ' token-for-shell ' + name + ' --i-know)');
  else { deps.err('--shell moet powershell of posix zijn / must be powershell or posix'); return 2; }
  deps.err('let op / note: deze regel laadt het token in je HELE shell en alles wat je daaruit start / this line loads the token into your WHOLE shell and everything started from it');
  return 0;
}
function cmdTokenForShell(P, args, deps, h) {
  const name = h.positional(args)[0];
  const s = name && vault.readSlot(P, name);
  if (!s || !s.token) { deps.err('geen token voor / no token for ' + name); return 3; }
  const why = refuseInAgentOrPipe(deps, args, 'token-for-shell');
  if (why) { deps.err(why); return 3; }
  vault.log(P, 'token doorgegeven aan een shell / token handed to a shell for ' + name, { quiet: true });
  (deps.rawOut || ((t) => process.stdout.write(t)))(s.token);
  return 0;
}

module.exports = { AGENT_MARKERS, agentMarker, psQuote, posixQuote, cmdArgsUnsafe, cmdWrapperArgv, binUnsafe, tokenReading, measureTokens, cmdEnrollToken, chooseLaunch, resolveClaudeBin, spawnClaude, cmdLaunch, cmdEnv, cmdTokenForShell, SCRIPT };
