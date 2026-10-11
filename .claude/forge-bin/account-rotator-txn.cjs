#!/usr/bin/env node
'use strict';
/**
 * account-rotator-txn.cjs — the login-swap TRANSACTION (escalation round).
 * Always called under the vault's transaction lock (account-rotator-vault.cjs withTxnLock). FILE MODE ONLY
 * (account-rotator.mode = file, experimental): the default token mode never calls swapLogin.
 *
 *  AR-01  txn.json (token-free: phase, from/to names, file generations, temp names, salted token fingerprints) is
 *         written BEFORE the first rename and advanced after each one: prepared -> creds-written -> profile-written ->
 *         done (outcome) | unresolved. reconcile() runs at the start of every entry point.
 *  AR-V01 ownership is never inferred from the profile uuid. classifyLive() recognises a login-file token only when it
 *         is EXACTLY a slot's stored token or carries the fingerprint THIS transaction recorded (HMAC with the vault's
 *         private salt — txn.json holds no token). Anything else is 'unknown' or 'foreign': no replacement, no capture,
 *         the transaction stays UNRESOLVED until ownership is established independently (repairUnresolved: an identity
 *         check when wired, or usage readings matching the slot's own earlier reading on two windows with non-null
 *         reset times — core.sameAccountReading) or the owner supersedes it (`enroll <name> --force`).
 *  AR-V02 every profile write first checks that the profile still names the transaction's origin account; a profile
 *         that names anyone else is never overwritten (-> unresolved, nothing destructive).
 *  AR-V03 the "unchanged" check and the rename are two steps (a rename cannot be made conditional on Windows): the window
 *         is minimised (check immediately before, re-read immediately after every rename) and what lands in it is
 *         DETECTED AND REPAIRED afterwards, never prevented. A post-write re-read that shows foreign content stops the
 *         swap and goes to classification. Best-effort — never a guaranteed conditional write, never claimed to be.
 *  AR-04  a slot is overwritten only after corroboratedCapture(): two settled identical reads, token shape, the uuid of
 *         THAT slot, no token owned by another slot, independent ownership proof, <name>.prev.json kept.
 *  AR-V10 a committed swap carries `accounted:false` until the state file recorded it (markAccounted) — accounting is
 *         keyed by transaction id and survives a crash between the commit and the state write.
 *  M2     preflight() runs every deterministic precondition before the handoff pauses anything.
 */
const crypto = require('crypto');
const fs = require('fs');
const vault = require('./account-rotator-vault.cjs');
const core = require('./account-rotator-core.cjs');

const OPEN = new Set(['prepared', 'creds-written', 'profile-written', 'unresolved']);
const COMMITTED = new Set(['committed', 'rolled-forward', 'recovered-forward']);
const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER_HINT = 'fix: log in to the account you want (`claude /login`), then `enroll <name> --force` — that closes the transaction';

// ---- transaction record ----------------------------------------------------------------------------------------
function readTxn(P) { return vault.readJsonFile(P.txn); }
function writeTxn(P, t) { vault.ensureVault(P); vault.atomicWrite(P.txn, vault.scrub(JSON.stringify(Object.assign({}, t, { updatedAt: iso() }), null, 2)) + '\n'); }
function txnOpen(t) { return !!(t && OPEN.has(t.phase)); }
function finishTxn(P, t, outcome) {
  t.phase = 'done'; t.outcome = outcome; t.closedAt = iso();
  if (COMMITTED.has(outcome)) t.accounted = false; // AR-V10: the durable accounting obligation
  writeTxn(P, t);
}
/** markAccounted(P, id) — the state file now holds this transaction's swap entry. */
function markAccounted(P, id) {
  const t = readTxn(P);
  if (!t || t.id !== id) return false;
  t.accounted = true; writeTxn(P, t);
  return true;
}
/** unaccounted(P) -> the committed transaction whose swap is not yet in the state file, or null. */
function unaccounted(P) {
  const t = readTxn(P);
  return t && t.phase === 'done' && COMMITTED.has(t.outcome) && t.accounted === false ? t : null;
}
/** proofOf(P, t) -> the fingerprint proof for classifyLive (see core). */
function proofOf(P, t) { return { from: t && t.fp ? t.fp.from : null, to: t && t.fp ? t.fp.to : null, fpOf: (rt) => vault.tokenFp(P, rt) }; }
/** supersede(P, why) — an owner action (enroll / forced switch on a consistent login) closes an open or unresolved
 *  transaction without touching the login files. Returns the closed record or null. */
function supersede(P, why) {
  const t = readTxn(P);
  if (!txnOpen(t)) return null;
  t.phase = 'done'; t.outcome = 'superseded'; t.reason = why; t.closedAt = iso(); writeTxn(P, t);
  return t;
}

// ---- corroborated capture (AR-04 / AR-V01) -----------------------------------------------------------------------
async function readStablePair(P, o) {
  const settle = o && Number.isFinite(o.settleMs) ? o.settleMs : 3000;
  const a = vault.readLive(P);
  if (!a.ok) return { ok: false, reason: a.reason };
  const ga = [vault.generation(P.creds), vault.generation(P.profile)].join('|');
  if (settle > 0) await sleep(settle);
  const b = vault.readLive(P);
  const gb = [vault.generation(P.creds), vault.generation(P.profile)].join('|');
  if (!b.ok || a.credsRaw !== b.credsRaw || a.profileRaw !== b.profileRaw || ga !== gb) return { ok: false, reason: 'the login files changed while being read (not settled)' };
  if (settle > 0) {
    for (const f of [P.creds, P.profile]) { try { if (Date.now() - fs.statSync(f).mtimeMs < settle) return { ok: false, reason: 'the login files were modified moments ago (not settled)' }; } catch { return { ok: false, reason: 'unreadable' }; } }
  }
  return { ok: true, live: b };
}
/** ownershipProof(P, slot, oauth, o) -> {ok, how, reading?} | {ok:false, reason, refused?}. Establishes that the login
 *  `oauth` (from the live file) belongs to `slot` INDEPENDENTLY of the profile uuid: (1) the token is exactly the slot's
 *  stored one; (2) o.identify(accessToken) names the slot's accountUuid (a different uuid refuses; null/throw proves
 *  nothing); (3) o.measure(accessToken) gives usage readings that match the slot's own earlier reading — one measured
 *  with the slot's OWN stored token (viaSlotToken) and younger than CORROBORATE_MAX_AGE_MS — on two windows with
 *  non-null reset times (core.sameAccountReading). A missing or failed check never authorises anything. */
async function ownershipProof(P, slot, oauth, o) {
  const stored = slot && slot.credentials && slot.credentials.claudeAiOauth;
  if (stored && stored.refreshToken === oauth.refreshToken) return { ok: true, how: 'stored-token' };
  if (typeof o.identify === 'function') {
    let id = null;
    try { id = await o.identify(oauth.accessToken); } catch { id = null; }
    if (id && typeof id.accountUuid === 'string' && id.accountUuid) {
      if (id.accountUuid === slot.oauthAccount.accountUuid) return { ok: true, how: 'identity' };
      return { ok: false, refused: true, reason: 'the live token belongs to a different account (identity check) — not captured' };
    }
  }
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const prior = o.readings && o.readings[slot.name];
  const priorMs = prior ? Date.parse(prior.measuredAt) : NaN;
  if (!prior || !prior.viaSlotToken || !Number.isFinite(priorMs) || now - priorMs > core.CORROBORATE_MAX_AGE_MS) {
    return { ok: false, reason: 'no independent proof of ownership (no recent usage reading taken with this account\'s own stored token, no identity check)' };
  }
  if (typeof o.measure !== 'function') return { ok: false, reason: 'no independent proof of ownership (nothing can measure the new login here)' };
  const m = await o.measure(oauth.accessToken);
  if (!m || !m.ok) return { ok: false, reason: 'the new login could not be measured (' + ((m && m.error) || 'unmeasured') + ') — ownership not established' };
  const same = core.sameAccountReading(m, prior, { now, pctTol: Number.isFinite(o.pctTol) ? o.pctTol : 5 });
  if (same === true) return { ok: true, how: 'usage-readings', reading: m };
  if (same === false) return { ok: false, refused: true, reason: 'the new login\'s usage readings do not match this account (different reset times) — not captured' };
  return { ok: false, reason: 'the usage readings are inconclusive (fewer than two comparable windows) — ownership not established' };
}
/** corroboratedCapture(P, slot, o) -> {captured, unchanged?, reason, reading?, how?}. o.settleMs (default 3000),
 *  o.identify, o.measure, o.readings, o.now (ownership proof — see ownershipProof). */
async function corroboratedCapture(P, slot, o) {
  const opts = o || {};
  const pair = await readStablePair(P, opts);
  if (!pair.ok) return { captured: false, reason: pair.reason };
  const live = pair.live;
  if (!vault.loginShapeOk(live.creds.claudeAiOauth)) return { captured: false, reason: 'the live login fails the token shape check — never captured' };
  const m = vault.matchActive(live, vault.listSlots(P));
  if (!m.slot || m.slot.name !== slot.name) return { captured: false, reason: 'the live login is not this slot\'s account (' + (m.reason || (m.slot && m.slot.name) || 'other') + ')' };
  if (m.inSync && vault.sameJson(m.slot.oauthAccount, live.profile.oauthAccount)) return { captured: false, unchanged: true, reason: 'already in sync' };
  const proof = await ownershipProof(P, m.slot, live.creds.claudeAiOauth, opts);
  if (!proof.ok) return { captured: false, reason: proof.reason, refused: !!proof.refused };
  vault.writeSlot(P, Object.assign({}, m.slot, { credentials: { claudeAiOauth: live.creds.claudeAiOauth }, oauthAccount: live.profile.oauthAccount }), { keepPrev: true });
  return { captured: true, reason: null, how: proof.how, reading: proof.reading || null };
}

// ---- preflight -------------------------------------------------------------------------------------------
/** preflight(P, targetName, o) -> {ok, live, from, target} | {ok:false, reason}. Pauses nothing, swaps nothing. */
async function preflight(P, targetName, o) {
  const opts = o || {};
  const fail = (reason) => ({ ok: false, reason });
  let live = vault.readLive(P);
  if (!live.ok) return fail(live.reason);
  let slots = vault.listSlots(P);
  const m = vault.matchActive(live, slots);
  if (!m.slot) {
    return fail(m.reason === 'not-enrolled' ? 'active login is not enrolled — enroll it first (nothing was changed)'
      : m.reason === 'inconsistent' ? 'the login file and the profile disagree about the active account — refusing (nothing was changed)'
        : 'cannot identify the active login (' + m.reason + ') — refusing (nothing was changed)');
  }
  const target = slots.find((s) => s.name === targetName);
  if (!target || target.broken || !target.credentials || !vault.loginShapeOk(target.credentials.claudeAiOauth) || !target.oauthAccount || !target.oauthAccount.accountUuid) {
    return fail('target slot has no usable login (enroll it with `enroll` while logged in to it)');
  }
  if (target.name === m.slot.name || target.oauthAccount.accountUuid === live.profile.oauthAccount.accountUuid) return fail('target is already the active account');
  const flag = opts.slotFlags && opts.slotFlags[target.name];
  if (flag && flag.needsRelogin && !opts.allowNeedsRelogin) return fail('target "' + target.name + '" needs a new login (claude /login, then enroll ' + target.name + ' --force)');
  if (!m.inSync || !vault.sameJson(m.slot.oauthAccount, live.profile.oauthAccount)) {
    const c = await corroboratedCapture(P, m.slot, opts);
    if (!c.captured && !c.unchanged) return fail('the active login changed since it was saved and could not be corroborated (' + c.reason + ') — no switch');
    live = vault.readLive(P);
    slots = vault.listSlots(P);
    const m2 = live.ok ? vault.matchActive(live, slots) : {};
    if (!m2.slot || !m2.inSync) return fail('the active login is not in sync with its slot after capture — no switch');
  }
  if (opts.hooks && opts.hooks.backupUnwritable) return fail('the pre-switch backup could not be written — no switch');
  try {
    vault.ensureVault(P);
    vault.atomicWrite(P.backup, JSON.stringify({ claudeAiOauth: live.creds.claudeAiOauth, account: m.slot.name, savedAt: iso() }, null, 2) + '\n');
  } catch { return fail('the pre-switch backup could not be written — no switch'); }
  return { ok: true, live, from: slots.find((s) => s.name === m.slot.name), target };
}

// ---- the swap -------------------------------------------------------------------------------------------------
/** writeKey(file, key, value, expectRaw) -> true when the re-read right after the rename shows exactly our bytes;
 *  false when foreign content landed right after it (AR-V03: detected, not prevented). Throws ECHANGED when the file
 *  changed before the rename. */
function writeKey(file, key, value, expectRaw, extra) {
  const obj = vault.parseText(expectRaw);
  obj[key] = value;
  const text = vault.serialize(obj, vault.detectStyle(expectRaw));
  vault.atomicWrite(file, text, Object.assign({ mode: vault.fileMode(file), beforeRename: () => vault.readRaw(file) === expectRaw }, extra || {}));
  return vault.readRaw(file) === text;
}
const foreignErr = (what) => Object.assign(new Error(what), { code: 'EFOREIGN' });
/** swapLogin(P, pf, o) -> {ok, outcome:'committed'|'rolled-back'|'aborted-unchanged'|'unresolved', rolledBack, unresolved,
 *  rolledForward, txnId, reason, notes}. pf = preflight() result. o.hooks: beforeCredsWrite/afterCredsWrite/
 *  afterProfileWrite/renameImpl (test seams; a hook may exit the process to simulate a crash between the renames). */
function swapLogin(P, pf, o) {
  const hooks = (o && o.hooks) || {};
  const { live, from, target } = pf;
  const want = target.credentials.claudeAiOauth;
  const t = { version: 2, id: crypto.randomUUID(), phase: 'prepared', from: from.name, to: target.name, pid: process.pid, startedAt: iso(),
    gen: { credsBefore: vault.generation(P.creds), profileBefore: vault.generation(P.profile) }, temps: {},
    fp: { from: vault.tokenFp(P, live.creds.claudeAiOauth.refreshToken), to: vault.tokenFp(P, want.refreshToken) } };
  writeTxn(P, t); // AR-01: on disk BEFORE the first rename
  const written = { creds: false, profile: false, bom: false };
  try {
    if (hooks.beforeCredsWrite) hooks.beforeCredsWrite();
    let ours;
    try {
      ours = writeKey(P.creds, 'claudeAiOauth', want, live.credsRaw, { renameImpl: hooks.renameImpl, onTemp: (n) => { t.temps.creds = n; writeTxn(P, t); } });
    } catch (e) {
      if (e.code !== 'ECHANGED') throw e;
      finishTxn(P, t, 'aborted-unchanged');
      return { ok: false, rolledBack: true, outcome: 'aborted-unchanged', txnId: t.id, reason: 'the login file changed before the swap (Claude Code refreshed it) — nothing was changed; the next tick retries' };
    }
    written.creds = true; t.phase = 'creds-written'; t.gen.credsAfter = vault.generation(P.creds); writeTxn(P, t);
    if (!ours) return settleSwap(P, t, pf, written, 'the login file changed right after our write (a newer login appeared) — swap stopped');
    if (hooks.afterCredsWrite) hooks.afterCredsWrite();
    for (let attempt = 0; attempt < 3 && !written.profile; attempt++) {
      const raw = vault.readRaw(P.profile);
      if (raw === null) throw new Error('profile unreadable');
      const obj = vault.parseText(raw);
      const curUuid = obj && obj.oauthAccount && obj.oauthAccount.accountUuid;
      if (curUuid !== from.oauthAccount.accountUuid) throw foreignErr('the profile names another account than the origin — not overwritten'); // AR-V02
      try {
        ours = writeKey(P.profile, 'oauthAccount', target.oauthAccount, raw, { onTemp: (n) => { t.temps.profile = n; writeTxn(P, t); } });
        written.profile = true; written.bom = vault.detectStyle(raw).bom;
      } catch (e) { if (e.code !== 'ECHANGED') throw e; }
    }
    if (!written.profile) throw new Error('profile kept changing');
    t.phase = 'profile-written'; t.gen.profileAfter = vault.generation(P.profile); writeTxn(P, t);
    if (!ours) return settleSwap(P, t, pf, written, 'the profile changed right after our write — swap stopped');
    if (hooks.afterProfileWrite) hooks.afterProfileWrite();
    const v = vault.readLive(P);
    const credsOk = v.ok && vault.sameJson(v.creds.claudeAiOauth, want) && Object.keys(live.creds).every((k) => k === 'claudeAiOauth' || vault.sameJson(v.creds[k], live.creds[k]));
    const profOk = v.ok && vault.sameJson(v.profile.oauthAccount, target.oauthAccount) && (v.profileRaw.charCodeAt(0) === 0xfeff) === written.bom;
    if (credsOk && profOk) {
      finishTxn(P, t, 'committed');
      return { ok: true, outcome: 'committed', txnId: t.id, from: from.name, to: target.name, credsGen: vault.generation(P.creds) };
    }
    return settleSwap(P, t, pf, written, credsOk ? 'verification failed: the profile does not hold the target account after the write'
      : 'verification failed: the login file does not hold the target login after the write');
  } catch (e) {
    return settleSwap(P, t, pf, written, e && e.code === 'EFOREIGN' ? e.message : 'write failed during the swap');
  }
}
/** settleSwap — after anything other than a clean commit: restore each key we wrote while it still holds EXACTLY what we
 *  wrote (never a byte we did not write), then classify the pair deterministically (AR-V01) and record the outcome. */
function settleSwap(P, t, pf, written, reason) {
  const { live, from, target } = pf;
  const notes = [];
  let credsChanged = false;
  try {
    if (written.creds) {
      const raw = vault.readRaw(P.creds);
      const cur = raw === null ? null : (() => { try { return vault.parseText(raw); } catch { return null; } })();
      if (cur && vault.sameJson(cur.claudeAiOauth, target.credentials.claudeAiOauth)) writeKey(P.creds, 'claudeAiOauth', live.creds.claudeAiOauth, raw);
      else { credsChanged = true; notes.push('login file no longer holds what we wrote (a newer login appeared) — not overwritten'); }
    }
    // a login we did not write means someone else is using these files right now: the profile is left alone too
    if (written.profile && credsChanged) notes.push('profile left untouched because the login file changed');
    if (written.profile && !credsChanged) {
      const raw = vault.readRaw(P.profile);
      const cur = raw === null ? null : (() => { try { return vault.parseText(raw); } catch { return null; } })();
      if (cur && vault.sameJson(cur.oauthAccount, target.oauthAccount)) writeKey(P.profile, 'oauthAccount', live.profile.oauthAccount, raw);
      else notes.push('profile no longer holds what we wrote — not overwritten');
    }
  } catch { notes.push('a rollback write failed'); }
  const now = vault.readLive(P);
  const proof = proofOf(P, t);
  let cls = now.ok ? core.classifyPair(now, from, target, vault.listSlots(P), proof) : 'none';
  if (cls === 'split-creds-to' || cls === 'split-creds-from') cls = resolveSplit(P, from, target, cls, proof).cls;
  if (cls === 'from') {
    finishTxn(P, t, 'rolled-back');
    return { ok: false, rolledBack: true, outcome: 'rolled-back', txnId: t.id, reason, notes };
  }
  if (cls === 'to') {
    finishTxn(P, t, 'rolled-forward');
    return { ok: true, rolledForward: true, outcome: 'committed', txnId: t.id, from: from.name, to: target.name, credsGen: vault.generation(P.creds),
      reason: reason + ' — both files hold the target login: kept', notes };
  }
  t.phase = 'unresolved'; t.reason = reason; t.notes = notes; t.cls = cls; writeTxn(P, t);
  return { ok: false, rolledBack: false, unresolved: true, outcome: 'unresolved', txnId: t.id, notes, cls,
    reason: reason + ' — NOT rolled back: the login files hold ' + describe(cls) + '; recorded in txn.json for reconcile/repair' };
}
function describe(cls) {
  return cls === 'unknown' ? 'a refresh token no slot and no transaction knows (ownership not established)'
    : cls === 'foreign' ? 'a third account' : cls === 'none' ? 'nothing readable' : 'an inconsistent pair (' + cls + ')';
}
/** resolveSplit(P, from, to, cls, proof) -> {cls} — the deterministic half-done states: the key that holds the
 *  TARGET's login (ours by proof) goes back to the origin's stored login, while it still holds exactly that. */
function resolveSplit(P, from, to, cls, proof) {
  const live = vault.readLive(P);
  if (!live.ok) return { cls: 'none' };
  try {
    if (cls === 'split-creds-to') writeKey(P.creds, 'claudeAiOauth', from.credentials.claudeAiOauth, live.credsRaw);
    if (cls === 'split-creds-from') writeKey(P.profile, 'oauthAccount', from.oauthAccount, live.profileRaw);
  } catch { /* judged by the re-read below */ }
  const after = vault.readLive(P);
  return { cls: after.ok ? core.classifyPair(after, from, to, vault.listSlots(P), proof) : 'none' };
}

// ---- reconcile (AR-01 / AR-V01) ----------------------------------------------------------------------------------
/** reconcile(P) -> {action:'none'|'forward'|'back'|'unresolved', txn, cls, removed}. Under the txn lock only. Writes a
 *  login file ONLY in the deterministic split states; an unknown or foreign token is never replaced. */
function reconcile(P) {
  const removed = vault.sweepTemps(P);
  const t = readTxn(P);
  if (!txnOpen(t)) return { action: 'none', removed };
  const from = vault.readSlot(P, t.from); const to = vault.readSlot(P, t.to);
  const unresolved = (why, cls) => { t.phase = 'unresolved'; t.reason = why; t.cls = cls || null; writeTxn(P, t); return { action: 'unresolved', txn: t, reason: why, cls: cls || null, removed }; };
  if (!from || !to || from.broken || to.broken) return unresolved('a vault slot of the transaction is missing — ' + OWNER_HINT, 'slot-missing');
  const live = vault.readLive(P);
  const proof = proofOf(P, t);
  let cls = live.ok ? core.classifyPair(live, from, to, vault.listSlots(P), proof) : 'none';
  if (cls === 'to') { finishTxn(P, t, 'recovered-forward'); return { action: 'forward', txn: t, removed }; }
  if (cls === 'from') { finishTxn(P, t, 'recovered-back'); return { action: 'back', txn: t, removed }; }
  if (cls === 'split-creds-to' || cls === 'split-creds-from') {
    cls = resolveSplit(P, from, to, cls, proof).cls;
    if (cls === 'from') { finishTxn(P, t, 'recovered-back'); return { action: 'back', txn: t, rolledBack: true, removed }; }
    return unresolved('rolling the half-done swap back to the origin login failed — ' + OWNER_HINT, cls);
  }
  if (cls === 'unknown') return unresolved('the login file holds a refresh token no slot and no transaction knows — ownership is not established, nothing was replaced; the next round tries to establish it from usage readings, otherwise ' + OWNER_HINT, cls);
  return unresolved('the login files hold a third account or are unreadable — nothing destructive was done; ' + OWNER_HINT, cls);
}
/** repairUnresolved(P, o) -> {action:'none'|'repaired'|'unresolved', slot?, reading?, then?}. Under the txn lock, after
 *  reconcile() left an UNKNOWN token: establishes ownership independently (o.identify, or o.measure + o.readings — the
 *  slot readings measured with their own stored tokens) for exactly ONE of the two slots, captures the newer login into
 *  that slot (previous generation kept) and re-runs reconcile. Two matches, no match or no proof -> still unresolved. */
async function repairUnresolved(P, o) {
  const opts = o || {};
  const t = readTxn(P);
  if (!t || t.phase !== 'unresolved') return { action: 'none' };
  const from = vault.readSlot(P, t.from); const to = vault.readSlot(P, t.to);
  if (!from || !to || from.broken || to.broken) return { action: 'unresolved', reason: t.reason };
  const live = vault.readLive(P);
  if (!live.ok) return { action: 'unresolved', reason: live.reason };
  const det = core.classifyLive(live, from, to, vault.listSlots(P), proofOf(P, t));
  if (det.pair !== 'unknown') { const rec = reconcile(P); return rec.action === 'unresolved' ? { action: 'unresolved', reason: rec.reason } : { action: 'repaired', then: rec }; }
  if (!vault.loginShapeOk(live.creds.claudeAiOauth)) return { action: 'unresolved', reason: 'the live login fails the token shape check' };
  const matches = []; const reasons = [];
  for (const slot of [from, to]) {
    const proof = await ownershipProof(P, slot, live.creds.claudeAiOauth, Object.assign({}, opts, { identify: opts.identify }));
    if (proof.ok && proof.how !== 'stored-token') matches.push({ slot, proof }); else reasons.push(slot.name + ': ' + proof.reason);
  }
  if (matches.length !== 1) {
    const why = matches.length ? 'the new login matched BOTH accounts — inconclusive' : reasons.join('; ');
    t.repair = { at: iso(), result: why }; writeTxn(P, t);
    return { action: 'unresolved', reason: why };
  }
  const { slot, proof } = matches[0];
  vault.writeSlot(P, Object.assign({}, slot, { credentials: { claudeAiOauth: live.creds.claudeAiOauth } }), { keepPrev: true });
  const rec = reconcile(P);
  return { action: rec.action === 'unresolved' ? 'unresolved' : 'repaired', slot: slot.name, how: proof.how, reading: proof.reading || null, then: rec, reason: rec.reason };
}

module.exports = { OPEN, COMMITTED, OWNER_HINT, readTxn, writeTxn, txnOpen, finishTxn, markAccounted, unaccounted, proofOf, supersede,
  readStablePair, ownershipProof, corroboratedCapture, preflight, writeKey, swapLogin, settleSwap, rollbackSwap: settleSwap, resolveSplit, reconcile, repairUnresolved };
