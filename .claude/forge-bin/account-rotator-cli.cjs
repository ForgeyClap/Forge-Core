#!/usr/bin/env node
'use strict';
/**
 * account-rotator-cli.cjs — the command layer of account-rotator.cjs (argv, output, exit codes, the watcher's
 * start/stop lifecycle, enrollment). Token mode lives in account-rotator-token.cjs. Not run directly:
 * `node .claude/forge-bin/account-rotator.cjs <cmd>`. main(argv, deps) is exported so every command is testable
 * in-process with injected fetch/clock/output. Exit codes: 0 ok · 1 error · 2 usage · 3 refused / act on this.
 *
 * STOP (M4 / AR-V11): `stop` writes a stop-request file bound to the watcher's exact pid-file record (pid + claim nonce);
 * the watcher honours only a request addressed to itself, checks it every second, and `stop` afterwards removes only a
 * pid file / stop file that still carries that same record — never a successor watcher's. It waits (up to a minute)
 * while a switch is in its saving/switching phase and refuses after that; only `stop --force` kills — the exact recorded
 * pid, after usage-guard's ownsPid proved it is this script's watcher — and the next start reconciles whatever was
 * interrupted.
 * MODE: `switch` (the file swap) runs only in file mode (`--mode file` or account-rotator.mode = file); the default token
 * mode switches through `launch --auto` (a new session).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const R = require('./account-rotator.cjs');
const tok = require('./account-rotator-token.cjs');

const SCRIPT = path.join(__dirname, 'account-rotator.cjs');
const OFF_CMD = 'Uit / off: /forge config set account-rotator uit';
const VALUE_FLAGS = ['--account', '--shell', '--interval', '--threshold', '--cooldown-min', '--mode', '--start-nonce'];
const LAUNCH_HINT = 'node .claude/forge-bin/account-rotator.cjs launch --auto -- <claude args>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guardOf(deps) { return deps.guard || require('./usage-guard.cjs'); }
function flagsOf(argv) { const i = argv.indexOf('--'); return i >= 0 ? argv.slice(0, i) : argv.slice(); }
function positional(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--') break;
    if (list[i].startsWith('--')) { if (VALUE_FLAGS.includes(list[i])) i++; continue; }
    out.push(list[i]);
  }
  return out;
}
function fileEligibleCount(P) { return vault.listSlots(P).filter(R.fileEligible).length; }
function tokenCount(P) { return vault.listSlots(P).filter((s) => !s.broken && s.token).length; }
/** readStopRequest(P) -> the parsed stop-request record or null. matchesStop(req, rec, myPid) -> the request is addressed
 *  to exactly this watcher record (pid AND claim nonce; a legacy record without a nonce accepts a request without one). */
function readStopRequest(P) { try { const j = JSON.parse(fs.readFileSync(P.stop, 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; } }
function matchesStop(req, rec, myPid) {
  if (!req || Number(req.targetPid) !== Number(myPid)) return false;
  return (rec && rec.nonce ? req.nonce === rec.nonce : !req.nonce);
}
const sameRecord = (a, b) => !!(a && b && a.pid && a.pid === b.pid && (a.startedAt || null) === (b.startedAt || null) && (a.nonce || null) === (b.nonce || null));

// ---- environment that overrides the file swap ------------------------------------------------------------------
function envOverrides(deps) {
  const env = deps.env || process.env;
  const found = [];
  if (env.CLAUDE_CODE_OAUTH_TOKEN) found.push('CLAUDE_CODE_OAUTH_TOKEN (in deze omgeving / in this environment)');
  const userHas = deps.userEnvHas || ((k) => {
    if (process.platform !== 'win32') return false;
    try { execSync('reg query HKCU\\Environment /v ' + k, { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
  });
  if (userHas('CLAUDE_CODE_OAUTH_TOKEN')) found.push('CLAUDE_CODE_OAUTH_TOKEN (Windows gebruikersomgeving / user environment)');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (env[k]) found.push(k + ' (kan voorrang krijgen / may take precedence)');
  return found;
}

// ---- rendering ----------------------------------------------------------------------------------------------
function windowsText(r) {
  if (!r.windows.length) return r.status === 'unmeasurable' ? 'niet meetbaar met dit token (401/403) / unmeasurable with this token' : 'nog nooit gemeten / never measured';
  return r.windows.map((w) => w.label + ' ' + core.fmtPct(w.pct) + (w.resetPassed ? ' (reset voorbij / reset passed)' : w.resetsAt ? ' (reset ' + w.resetsAt + ')' : '')).join(' · ');
}
function accountLines(P, T, now, activeName) {
  const st = vault.readState(P);
  const slots = vault.listSlots(P);
  if (!slots.length) return ['(geen accounts ingeschreven / no accounts enrolled — run: enroll <name>)'];
  return slots.map((s) => {
    if (s.broken) return '  ' + s.name + '  [onleesbaar / unreadable slot]';
    const mode = core.slotMode(s);
    const rec = mode === 'token' ? tok.tokenReading(s, st.tokenReadings, st.readings) : st.readings[s.name];
    const r = core.effectiveReading(rec, now);
    const j = core.judge(r, T);
    const verdict = j.usable === true ? 'bruikbaar/usable' : j.usable === false ? 'vol/full' : 'onbekend/unknown';
    const email = s.oauthAccount ? core.maskEmail(s.oauthAccount.emailAddress) : '(alleen token / token only)';
    const flags = [];
    if (st.slotFlags[s.name] && st.slotFlags[s.name].needsRelogin) flags.push('NIEUWE LOGIN NODIG / NEEDS RELOGIN');
    if (s.token) flags.push('token-binding ' + ((s.tokenBinding && s.tokenBinding.status) || 'onbekend/unknown'));
    const tr = st.tokenReadings[s.name];
    if (tr && tr.lastUsedAt) flags.push('laatst gelanceerd/last launched ' + tr.lastUsedAt);
    return (s.name === activeName ? '* ' : '  ') + s.name + '  [' + mode + ']  ' + email + '  ' + windowsText(r) + '  · ' + r.status + ' · ' + verdict + (flags.length ? ' · ' + flags.join(' · ') : '');
  });
}
function activeNameOf(P) { const l = vault.readLive(P); if (!l.ok) return null; const m = vault.matchActive(l, vault.listSlots(P)); return m.slot ? m.slot.name : null; }
function watcherLine(P, deps) {
  const g = guardOf(deps);
  const rec = g.readPidRecordFrom(P.pid);
  if (!rec.pid) return 'watcher: niet actief / not running';
  const own = (deps.ownsPid || g.ownsPid)(rec.pid, rec);
  return own.ok ? 'watcher: ACTIEF / RUNNING (pid ' + rec.pid + ')' : 'watcher: niet actief / not running (pid-bestand / pid file: ' + own.reason + ')';
}

// ---- enrollment ----------------------------------------------------------------------------------------------
async function cmdEnroll(P, args, deps) {
  const name = positional(args)[0];
  if (!vault.validName(name)) { deps.err('gebruik / usage: enroll <naam/name> (letters, cijfers, - en _; max 32) [--force]'); return 2; }
  const lock = await vault.withTxnLock(P, async () => {
    const live = vault.readLive(P);
    if (!live.ok) return { code: 3, err: 'niet ingeschreven / not enrolled — ' + live.reason + '. Log eerst in / log in first: claude /login' };
    if (!vault.loginShapeOk(live.creds.claudeAiOauth)) return { code: 3, err: 'niet ingeschreven / not enrolled — de login heeft een onverwachte vorm / the login has an unexpected shape' };
    const acct = live.profile.oauthAccount;
    if (!acct || typeof acct.accountUuid !== 'string' || !acct.accountUuid) return { code: 3, err: 'niet ingeschreven / not enrolled — geen oauthAccount in ~/.claude.json / no oauthAccount in ~/.claude.json' };
    const slots = vault.listSlots(P);
    const dup = slots.find((s) => s.name !== name && s.oauthAccount && s.oauthAccount.accountUuid === acct.accountUuid);
    if (dup) return { code: 3, err: 'geweigerd / refused — dit account is al ingeschreven als "' + dup.name + '" / this account is already enrolled as "' + dup.name + '"' };
    const existing = vault.readSlot(P, name);
    if (existing && existing.credentials && !args.includes('--force')) return { code: 3, err: 'geweigerd / refused — "' + name + '" bestaat al; overschrijven met --force / already exists; overwrite with --force' };
    const sameAccount = existing && existing.oauthAccount && existing.oauthAccount.accountUuid === acct.accountUuid;
    vault.writeSlot(P, Object.assign({}, existing && !existing.broken ? existing : {}, { name, credentials: { claudeAiOauth: live.creds.claudeAiOauth }, oauthAccount: acct, enrolledAt: new Date(deps.now()).toISOString() },
      sameAccount ? {} : { token: existing && !existing.broken ? existing.token : null, tokenBinding: existing && existing.token ? { status: 'unverified', reason: 'login re-enrolled for a different account', at: new Date(deps.now()).toISOString() } : null }), { keepPrev: true });
    await vault.updateState(P, (s) => { if (s.slotFlags[name]) delete s.slotFlags[name]; if (!sameAccount) delete s.readings[name]; if (s.pendingVerify) s.pendingVerify = null; });
    // AR-V07: the owner logged in and enrolled — the live files are now consistent with THIS slot, which supersedes an
    // open/unresolved transaction (also one that only knew two other slots)
    const sup = require('./account-rotator-txn.cjs').supersede(P, 'superseded by enroll ' + name + ' (owner logged in)');
    return { code: 0, acct, superseded: sup ? sup.from + ' -> ' + sup.to : null };
  }, { timeoutMs: 60000 });
  if (!lock.ok) { deps.err('bezet / busy — een accountwissel loopt; probeer zo opnieuw / an account switch is running; try again shortly'); return 1; }
  if (lock.value.code) { deps.err(lock.value.err); return lock.value.code; }
  vault.log(P, 'ingeschreven / enrolled ' + name + (lock.value.superseded ? ' — onopgeloste wissel ' + lock.value.superseded + ' gesloten / unresolved swap closed' : ''), { quiet: true });
  if (lock.value.superseded) deps.out('onopgeloste wissel gesloten / unresolved swap closed: ' + lock.value.superseded);
  const n = fileEligibleCount(P);
  deps.out('ingeschreven / enrolled: ' + name + ' (' + core.maskEmail(lock.value.acct.emailAddress) + ') — ' + n + ' login(s) in de kluis / in the vault');
  if (n < 2) deps.out('volgende / next: claude /login met het volgende account, dan / with the next account, then: enroll <naam/name>');
  return 0;
}

// ---- watcher lifecycle -------------------------------------------------------------------------------------------
/** scrubStderr() — everything this process writes to stderr (which `start` redirects into rotator.log) passes the
 *  vault's secret scrub first. Idempotent. */
function scrubStderr() {
  if (process.stderr.__rotatorScrubbed) return;
  const rawErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => rawErr(vault.scrub(String(chunk)), ...rest);
  process.stderr.__rotatorScrubbed = true;
}
function readSwitchNow(deps, flags) {
  const C = R.loadConfig({ configModule: deps.configModule, configOpts: deps.configOpts });
  const S = R.resolveSettings(flags || [], C.cfg);
  return { on: !C.unreadable && S.enabled.value, unreadable: C.unreadable, S };
}
function disclosure(C) {
  const d = C.disclosure && typeof C.disclosure.nl === 'string' ? C.disclosure : R.DISCLOSURE_FALLBACK;
  return [d.nl, d.en, OFF_CMD];
}
async function cmdWatch(P, S, C, argv, deps) {
  const flags = flagsOf(argv);
  const dryRun = flags.includes('--dry-run');
  let Snow = S;
  const runTick = () => R.tick({ P, S: Snow, deps, dryRun });
  if (!S.enabled.value || C.unreadable) { deps.err('account-rotator staat uit of instellingen onleesbaar / is off or settings unreadable'); return 3; }
  if (flags.includes('--once')) {
    const r = await runTick();
    deps.out('resultaat / result: ' + r.action + (r.reason ? ' (' + r.reason + ')' : '') + (r.to ? ' -> ' + r.to : ''));
    return 0;
  }
  const g = guardOf(deps);
  const nonce = (() => { const i = flags.indexOf('--start-nonce'); return i >= 0 ? flags[i + 1] : undefined; })();
  const claim = g.claimWatcherSlot({ pidFile: P.pid, script: SCRIPT, nonce });
  if (!claim.ok) { deps.err(claim.reason); return 1; }
  const log = (m) => vault.log(P, m, { quiet: true });
  scrubStderr();
  process.on('uncaughtException', (e) => { log('WATCHER uncaught exception: ' + ((e && e.message) || e)); try { g.releaseWatcherSlot({ pidFile: P.pid }); } catch { /* best effort */ } process.exit(1); });
  process.on('unhandledRejection', (e) => log('WATCHER unhandled rejection (loop kept alive): ' + ((e && e.message) || e)));
  log('account-rotator watch gestart / started — ' + R.settingsLine(S));
  for (const l of disclosure(C)) log(l);
  for (const w of S.warnings) log('note: ' + w);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('exit', () => { try { g.releaseWatcherSlot({ pidFile: P.pid }); } catch { /* best effort */ } });
  const owns = () => { const rec = g.readPidRecordFrom(P.pid); return rec.pid === process.pid && (!nonce || !rec.nonce || rec.nonce === nonce); };
  let ignoredStop = null;
  const stopRequested = () => { // AR-V11: only a request addressed to THIS watcher (pid + claim nonce) counts
    const req = readStopRequest(P);
    if (!req) return false;
    if (matchesStop(req, { nonce }, process.pid)) return true;
    const key = String(req.targetPid) + ':' + String(req.nonce);
    if (ignoredStop !== key) { ignoredStop = key; log('stopverzoek voor een andere watcher (pid ' + req.targetPid + ') genegeerd / stop request addressed to another watcher ignored'); }
    return false;
  };
  while (!stopping) {
    if (stopRequested()) { log('stopverzoek ontvangen — watcher stopt netjes / stop requested — watcher stops cleanly'); try { fs.unlinkSync(P.stop); } catch { /* gone */ } break; }
    if (!owns()) { log('SLOT VERLOREN / SLOT LOST — deze watcher stopt / this watcher stops'); return 1; }
    const sw = readSwitchNow(deps, flags); // the mode (and the switch) are re-read every round: a file swap only ever runs while file mode is set NOW
    if (!sw.on) { log(sw.unreadable ? 'instellingen onleesbaar — watcher stopt / settings unreadable — watcher stops' : 'account-rotator staat nu UIT — watcher stopt / switched OFF — watcher stops'); break; }
    if (sw.S.mode.value !== Snow.mode.value) log('modus gewijzigd / mode changed: ' + Snow.mode.value + ' -> ' + sw.S.mode.value);
    Snow = sw.S;
    if (vault.readState(P).disabled) { log('kill-switch (disable) staat aan — watcher stopt / kill switch is on — watcher stops'); break; }
    try { await runTick(); } catch (e) { log('TICK FAILED (watcher blijft leven / stays alive): ' + ((e && e.message) || e)); }
    for (let waited = 0; waited < S.interval.value * 1000 && !stopping && !stopRequested(); waited += 1000) await sleep(1000);
  }
  try { g.releaseWatcherSlot({ pidFile: P.pid }); } catch { /* best effort */ }
  return 0;
}
function cmdStart(P, S, C, argv, deps) {
  if (!S.enabled.value) { deps.out('account-rotator staat UIT in je instellingen (aan: /forge config set account-rotator aan) / is OFF in your settings'); return 3; }
  if (C.unreadable) { deps.out('instellingen onleesbaar — account-rotator start niet / settings unreadable — not started' + (C.note ? ' (' + C.note + ')' : '')); return 3; }
  if (vault.readState(P).disabled) { deps.out('kill-switch staat aan — eerst: enable / kill switch is on — first: enable'); return 3; }
  if (S.mode.value === 'file') {
    const n = fileEligibleCount(P);
    if (n < 2) { deps.out('niet gestart / not started — bestandsmodus heeft minstens twee ingeschreven logins nodig (nu ' + n + '); zie / file mode needs at least two enrolled logins (now ' + n + '); see: enroll <name>'); return 3; }
    if (!fs.existsSync(P.creds)) { deps.out('niet gestart / not started — geen ~/.claude/.credentials.json op deze computer / no login file on this machine'); return 3; }
    deps.out('LET OP / NOTE: bestandsmodus is experimenteel — de wissel van login-bestanden is best-effort (gedetecteerd en hersteld, nooit atomair) / file mode is experimental — the login-file swap is best-effort (detected and repaired, never atomic)');
  } else {
    const n = tokenCount(P);
    if (n < 2) { deps.out('niet gestart / not started — token-modus heeft minstens twee setup-tokens nodig (nu ' + n + '): per account `claude setup-token` -> `enroll-token <naam>`; de experimentele bestandswissel: /forge config set account-rotator.mode file / token mode needs at least two setup tokens (now ' + n + ')'); return 3; }
  }
  const g = guardOf(deps);
  const rec = g.readPidRecordFrom(P.pid);
  if (rec.pid && (deps.ownsPid || g.ownsPid)(rec.pid, rec).ok) { deps.out('account-rotator draait al / already running (pid ' + rec.pid + ')'); return 0; }
  vault.ensureVault(P);
  try { fs.unlinkSync(P.stop); } catch { /* no stale stop request */ }
  const nonce = crypto.randomUUID();
  const fwd = [];
  for (const k of Object.keys(R.DEFAULTS).concat(Object.keys(R.ENUMS))) if (S[k].source === 'vlag') fwd.push('--' + k, String(S[k].value));
  const logFd = fs.openSync(P.log, 'a', 0o600);
  const child = spawn(process.execPath, [SCRIPT, 'watch', ...fwd, '--start-nonce', nonce], { detached: true, stdio: ['ignore', 'ignore', logFd], windowsHide: true, env: deps.env || process.env });
  child.unref();
  try { fs.closeSync(logFd); } catch { /* best effort */ }
  const env = deps.env || process.env;
  const timeoutMs = Number(env.FORGE_ACCOUNT_ROTATOR_CLAIM_TIMEOUT_MS) > 0 ? Number(env.FORGE_ACCOUNT_ROTATOR_CLAIM_TIMEOUT_MS) : 10000;
  const hs = g.awaitChildClaim({ pidFile: P.pid, childPid: child.pid, timeoutMs, nonce });
  if (!hs.ok) {
    try { child.kill(); } catch { /* our own child handle — exact pid, never by name */ }
    deps.err('account-rotator NIET gestart / NOT started — ' + hs.reason + ' (log: ' + P.log + ')');
    return 1;
  }
  deps.out('account-rotator gestart / started (pid ' + child.pid + ') — ' + R.settingsLine(S) + ' · log: ' + P.log);
  for (const l of disclosure(C)) deps.out(l);
  return 0;
}
async function cmdStop(P, argv, deps) {
  const force = flagsOf(argv).includes('--force');
  const g = guardOf(deps);
  const rec = g.readPidRecordFrom(P.pid);
  if (!rec.pid) { deps.out('account-rotator draait niet / not running (geen pid-bestand / no pid file)'); return 0; }
  const own = (deps.ownsPid || g.ownsPid)(rec.pid, rec);
  if (!own.ok) {
    if (own.code === 'unverifiable') { deps.out('NIET gestopt / NOT stopped — ' + own.reason + '; pid-bestand blijft / pid file kept'); return 1; }
    try { fs.unlinkSync(P.pid); } catch { /* gone */ }
    deps.out('account-rotator draait niet / not running — oud pid-bestand opgeruimd / stale pid file removed (' + own.reason + ')');
    return 0;
  }
  const switching = () => { const h = vault.readHandoffFile(P); return !!(h && (h.phase === 'saving' || h.phase === 'switching') && Date.now() - Date.parse(h.updatedAt || h.at) < 10 * 60e3); };
  const busyWait = Number.isFinite(deps.stopBusyWaitMs) ? deps.stopBusyWaitMs : 60000;
  for (let w = 0; switching() && !force && w < busyWait; w += 500) await sleep(500);
  if (switching() && !force) { deps.out('NIET gestopt / NOT stopped — er loopt een accountwissel; probeer zo opnieuw (of --force) / an account switch is in progress; try again shortly (or --force)'); return 3; }
  const dead = () => !vault.pidAlive(rec.pid);
  // AR-V11: only the EXACT record we judged (pid + startedAt + nonce) is ever removed — a successor watcher's never
  const removePidIfSame = () => { if (sameRecord(g.readPidRecordFrom(P.pid), rec)) { try { fs.unlinkSync(P.pid); return true; } catch { /* released */ } } return false; };
  const removeStopIfOurs = () => { const req = readStopRequest(P); if (req && req.by === process.pid && matchesStop(req, rec, rec.pid)) { try { fs.unlinkSync(P.stop); } catch { /* consumed */ } } };
  if (force) {
    try {
      if (process.platform === 'win32') execSync('taskkill /PID ' + Number(rec.pid) + ' /F', { stdio: 'ignore', windowsHide: true });
      else process.kill(rec.pid, 'SIGKILL');
    } catch { /* judged by liveness below */ }
    for (let w = 0; !dead() && w < 3000; w += 100) await sleep(100);
    if (!dead()) { deps.out('NIET gestopt / NOT stopped — pid ' + rec.pid + ' leeft nog / is still alive'); return 1; }
    removePidIfSame();
    deps.out('account-rotator hard gestopt / force-stopped (pid ' + rec.pid + ') — de volgende start ruimt een onderbroken wissel op / the next start reconciles an interrupted switch');
    return 0;
  }
  vault.ensureVault(P);
  fs.writeFileSync(P.stop, JSON.stringify({ requestedAt: new Date().toISOString(), by: process.pid, targetPid: rec.pid, nonce: rec.nonce || null, startedAt: rec.startedAt || null }) + '\n');
  const stopWait = Number.isFinite(deps.stopTimeoutMs) ? deps.stopTimeoutMs : 45000;
  for (let w = 0; !dead() && w < stopWait; w += 250) await sleep(250);
  if (!dead()) { deps.out('stopverzoek staat klaar; de watcher stopt na zijn huidige ronde (direct: stop --force) / stop requested; the watcher stops after its current round (now: stop --force)'); return 1; }
  removePidIfSame();
  removeStopIfOurs();
  deps.out('account-rotator gestopt / stopped (pid ' + rec.pid + ')');
  return 0;
}

// ---- main -------------------------------------------------------------------------------------------------------
const HELP = 'account-rotator: enroll <name> | enroll-token <name> [--confirm-same-account] | list | status | check | launch [--account <name>|--auto] -- <claude args> (the default way to switch: a NEW session) | switch <name>|--auto [--force] (file mode only: --mode file or /forge config set account-rotator.mode file — experimental) | watch [--once] [--dry-run] | start | stop [--force] | env <name> [--shell powershell|posix] [--i-know] | remove <name> | disable | enable';
async function main(argv, depsIn) {
  const deps = Object.assign({ now: () => Date.now(), out: (s) => console.log(vault.scrub(s)), err: (s) => console.error(vault.scrub(s)) }, depsIn || {});
  if (!deps.readStdin && !process.stdin.isTTY) {
    deps.readStdin = () => new Promise((res) => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => res(d)); process.stdin.on('error', () => res('')); });
  }
  const P = deps.P || vault.paths(deps.env);
  const cmd = argv[0] || 'status';
  const args = argv.slice(1);
  const flags = flagsOf(argv);
  const C = R.loadConfig({ configModule: deps.configModule, configOpts: deps.configOpts });
  const S = R.resolveSettings(flags, C.cfg);
  const gateOk = (S.enabled.value && !C.unreadable) || flags.includes('--force');
  const H = { positional, flagsOf, gateOk };
  const now = deps.now();
  switch (cmd) {
    case 'enroll': return cmdEnroll(P, args, deps);
    case 'enroll-token': return tok.cmdEnrollToken(P, args, deps, H);
    case 'list': {
      deps.out('accounts (drempel / threshold ' + S.threshold.value + '%):');
      for (const l of accountLines(P, S.threshold.value, now, activeNameOf(P))) deps.out(l);
      return 0;
    }
    case 'status': case 'check': {
      deps.out('instellingen / settings: ' + R.settingsLine(S));
      for (const n of [C.note, ...S.warnings].filter(Boolean)) deps.out('note: ' + n);
      deps.out(watcherLine(P, deps));
      for (const w of envOverrides(deps)) deps.out('⚠ ' + w + ' — elke NIEUWE Claude Code-sessie gebruikt dat en negeert de bestandswissel / every NEW Claude Code session uses that and ignores the file swap');
      if (!gateOk) deps.out('account-rotator staat uit — alleen laatst bekende cijfers, geen meting / is off — last-known numbers only, no measurement');
      // reconcile + a dry decision, under the transaction lock (status is an entry point too)
      const r = gateOk ? await R.tick({ P, S, deps, dryRun: true, lockTimeoutMs: Number.isFinite(deps.statusLockMs) ? deps.statusLockMs : 5000 }) : null;
      const st = vault.readState(P);
      if (st.disabled) deps.out('kill-switch: AAN / ON (enable om te hervatten / to resume)');
      for (const l of accountLines(P, S.threshold.value, now, activeNameOf(P))) deps.out(l);
      if (r) deps.out((cmd === 'check' ? 'zou nu / would now: ' : 'beslissing nu / decision now: ') + r.action + (r.reason ? ' (' + r.reason + ')' : '') + (r.error ? ' — ' + r.error : '') + (r.detail ? ' — ' + r.detail : '') + (r.to ? ' -> ' + r.to + ' [' + r.tier + ']' : '') + (r.soonestResetAt ? ' · vroegste reset / soonest reset ' + r.soonestResetAt : ''));
      if (st.recommendation && st.recommendation.name) deps.out('aanbeveling / recommendation: start de volgende sessie met / start the next session with ' + st.recommendation.name + ' (' + (st.recommendation.why || '') + ') — ' + LAUNCH_HINT);
      if (st.pendingVerify) deps.out('wacht op verificatie / awaiting verification: ' + st.pendingVerify.from + ' -> ' + st.pendingVerify.to + ' (401s: ' + (st.pendingVerify.failures || 0) + '/2)');
      if (st.lastSwitch) deps.out('laatste wissel / last switch: ' + st.lastSwitch.from + ' -> ' + st.lastSwitch.to + ' (' + st.lastSwitch.reason + ', ' + (st.lastSwitch.outcome || '?') + ', ' + st.lastSwitch.at + ')');
      const h = vault.readHandoffFile(P);
      if (h && h.phase) deps.out('handoff: ' + h.phase + (h.from ? ' ' + h.from + ' -> ' + (h.committedTo || h.to || '?') : '') + ' (' + (h.updatedAt || h.at) + ')');
      return cmd === 'check' && !gateOk ? 3 : 0;
    }
    case 'switch': {
      if (!gateOk) { deps.err('account-rotator staat uit — eenmalig toch: --force / is off — once anyway: --force'); return 3; }
      if (S.mode.value !== 'file') {
        deps.err('geweigerd / refused — `switch` wisselt de login-BESTANDEN en werkt alleen in de experimentele bestandsmodus (`--mode file` of /forge config set account-rotator.mode file). Standaard wissel je via een nieuwe sessie: ' + LAUNCH_HINT
          + ' / `switch` swaps the login FILES and runs only in the experimental file mode (`--mode file` or /forge config set account-rotator.mode file); the default way to switch is a new session: ' + LAUNCH_HINT);
        return 3;
      }
      const target = positional(args)[0];
      if (!target && !flags.includes('--auto')) { deps.err('gebruik / usage: switch <naam/name> | switch --auto [--force]'); return 2; }
      const r = await R.tick({ P, S, deps, manual: target ? { target } : { auto: true }, force: flags.includes('--force') });
      deps.out('resultaat / result: ' + r.action + (r.outcome ? ' [' + r.outcome + ']' : '') + (r.committedTo ? ' -> ' + r.committedTo : '') + (r.reason ? ' (' + r.reason + ')' : '') + (r.detail ? ' — ' + r.detail : ''));
      return r.action === 'switched' ? 0 : ['refused', 'wait'].includes(r.action) || r.reason === 'disabled' || r.reason === 'preflight-failed' ? 3 : 1;
    }
    case 'watch': return cmdWatch(P, S, C, argv, deps);
    case 'start': return cmdStart(P, S, C, argv, deps);
    case 'stop': return cmdStop(P, argv, deps);
    case 'launch': return tok.cmdLaunch(P, S, argv, deps, H);
    case 'env': return tok.cmdEnv(P, args, deps, H);
    case 'token-for-shell': return tok.cmdTokenForShell(P, args, deps, H);
    case 'remove': {
      const name = positional(args)[0];
      if (!vault.validName(name) || !vault.readSlot(P, name)) { deps.err('onbekend account / unknown account: ' + name); return 2; }
      // AR-V04: eligibility (still present? active?) is judged INSIDE the lock, right before the removal
      const lock = await vault.withTxnLock(P, async () => {
        if (!vault.readSlot(P, name)) return { code: 2, err: 'onbekend account / unknown account: ' + name };
        if (activeNameOf(P) === name && !flags.includes('--force')) return { code: 3, err: 'geweigerd / refused — "' + name + '" is het actieve account; --force om toch te verwijderen / is the active account; --force to remove anyway' };
        vault.removeSlot(P, name);
        await vault.updateState(P, (s) => { delete s.readings[name]; delete s.tokenReadings[name]; delete s.slotFlags[name]; if (s.recommendation && s.recommendation.name === name) s.recommendation = null; });
        return { code: 0 };
      }, { timeoutMs: 60000 });
      if (!lock.ok) { deps.err('bezet / busy — probeer zo opnieuw / try again shortly'); return 1; }
      if (lock.value.code) { deps.err(lock.value.err); return lock.value.code; }
      vault.log(P, 'verwijderd / removed ' + name, { quiet: true });
      deps.out('verwijderd uit de kluis / removed from the vault: ' + name);
      return 0;
    }
    case 'disable': case 'enable': {
      const on = cmd === 'disable';
      const s = await vault.updateState(P, (st) => { st.disabled = on; });
      if (!s) { deps.err('state.json is bezet / is locked — probeer opnieuw / try again'); return 1; }
      vault.log(P, 'kill-switch ' + (on ? 'AAN/ON' : 'UIT/OFF'), { quiet: true });
      deps.out(on ? 'account-rotator UITGESCHAKELD (kill-switch) — een draaiende watcher stopt bij zijn volgende ronde; handmatig wisselen alleen nog met --force / DISABLED — a running watcher stops on its next round; manual switch only with --force' : 'account-rotator weer ingeschakeld / enabled again (start: start)');
      return 0;
    }
    case 'help': case '--help': deps.out(HELP); return 0;
    default: deps.err('onbekend commando / unknown command: ' + cmd + '\n' + HELP); return 2;
  }
}

module.exports = { main, envOverrides, accountLines, positional, scrubStderr, SCRIPT, LAUNCH_HINT, readStopRequest, matchesStop, sameRecord, chooseLaunch: tok.chooseLaunch, resolveClaudeBin: tok.resolveClaudeBin, spawnClaude: tok.spawnClaude };
