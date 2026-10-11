// GET /api/account-rotation source — account-wide,
// no `?project=`, read-only.
//
// Surfaces the account rotator's RECOMMENDATION (`.claude/forge-bin/account-rotator*.cjs`) for the
// dashboard. Exactly two token-free files are read, both written by the rotator itself:
//   - <home>/FORGE_ACCOUNT_ROTATION.json   the rotator's own dashboard notification (accounts, readings,
//                                          threshold, active, recommendation, lastSwitch);
//   - <home>/forge-accounts/handoff.json   only used when its `phase` is 'recommend' (token mode).
// <home> is FORGE_ACCOUNT_ROTATOR_HOME (the rotator's own env seam, account-rotator-vault.cjs paths()),
// else ~/.claude. NOTHING else under forge-accounts/ is ever opened: not the vault slot files
// (<name>.json / <name>.prev.json, which hold logins), not state.json, txn.json, .fp-salt or any
// credentials file. Both files are designed token-free, but the response is still built from an
// explicit ALLOWLIST of fields (labels, percentages, timestamps, statuses) — an unexpected field in
// either file is dropped, never forwarded — and every string is redacted on top.
//
// HONESTY: a missing notification file is 'NOT SET UP' ("rotator not set up"), an unparsable one is
// 'UNREADABLE'; a percentage is only ever the rotator's own number (null stays null — never 0), and
// each account carries the rotator's own status ('live' | 'estimated' | 'unknown' | 'unmeasurable').
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redact } from './redact.mjs';

export const ROTATOR_HOME_ENV = 'FORGE_ACCOUNT_ROTATOR_HOME';
export const DEFAULT_THRESHOLD = 92; // account-rotator-measure.cjs DEFAULTS.threshold
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 32;
const MAX_WINDOWS = 12;
const MAX_TEXT = 300;
const STATUSES = new Set(['live', 'estimated', 'unknown', 'unmeasurable']);

/** The rotator home, resolved on every call (so a test can point the env var at a temp folder). */
export function rotatorHome() {
  const fromEnv = process.env[ROTATOR_HOME_ENV];
  return path.resolve(fromEnv && fromEnv.trim() ? fromEnv : path.join(os.homedir(), '.claude'));
}

function readJsonCapped(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return { state: 'absent' }; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return { state: 'unreadable' };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? { state: 'ok', value: v } : { state: 'unreadable' };
  } catch { return { state: 'unreadable' }; }
}

const str = (v) => (typeof v === 'string' && v.length ? redact(v.length > MAX_TEXT ? v.slice(0, MAX_TEXT - 1) + '…' : v) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

function pickWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return { label: str(w.label) ?? 'window', pct: num(w.pct), resets_at: iso(w.resetsAt ?? w.resets_at) };
}

function pickAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const name = str(a.name);
  if (!name) return null;
  const windows = (Array.isArray(a.windows) ? a.windows : []).slice(0, MAX_WINDOWS).map(pickWindow).filter(Boolean);
  return {
    name,
    mode: str(a.mode),
    status: STATUSES.has(a.status) ? a.status : 'unknown',
    max_pct: num(a.maxPct),
    usable: bool(a.usable),
    needs_relogin: a.needsRelogin === true,
    measured_at: iso(a.measuredAt),
    windows,
  };
}

function pickTrigger(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_WINDOWS)
    .map((t) => (t && typeof t === 'object' ? { label: str(t.label) ?? 'window', pct: num(t.pct) } : null)).filter(Boolean);
}

function pickRecommendation(r) {
  if (!r || typeof r !== 'object') return null;
  const to = str(r.name ?? r.to);
  if (!to) return null;
  return { to, from: str(r.from), tier: str(r.tier), why: str(r.why), at: iso(r.at), trigger: pickTrigger(r.trigger) };
}

function pickSwitch(s) {
  if (!s || typeof s !== 'object') return null;
  return { from: str(s.from), to: str(s.to), at: iso(s.at), reason: str(s.reason), outcome: str(s.outcome) };
}

/** buildAccountRotation() -> the read-only, token-free rotator view. Never throws. */
export function buildAccountRotation() {
  const home = rotatorHome();
  const captured = new Date().toISOString();
  const notify = readJsonCapped(path.join(home, 'FORGE_ACCOUNT_ROTATION.json'));
  const hand = readJsonCapped(path.join(home, 'forge-accounts', 'handoff.json'));
  const handoffRec = hand.state === 'ok' && hand.value.phase === 'recommend'
    ? {
        to: str(hand.value.to), from: str(hand.value.from), reason: str(hand.value.reason), kind: str(hand.value.kind),
        at: iso(hand.value.at ?? hand.value.updatedAt), trigger: pickTrigger(hand.value.trigger),
      }
    : null;

  if (notify.state !== 'ok') {
    return {
      ok: true,
      provenance: notify.state === 'absent' ? 'NOT SET UP' : 'UNREADABLE',
      note: notify.state === 'absent' ? 'rotator not set up' : 'the rotator file is present but could not be read',
      threshold: DEFAULT_THRESHOLD, threshold_source: 'default',
      mode: null, active: null, updated_at: null, notice: null, disabled: null,
      // The handoff file is only a stand-in while the notification file does not exist at all. An UNREADABLE
      // notification file means the rotator HAS written one, so a handoff left behind must not stand in for it.
      recommendation: null, handoff_recommendation: notify.state === 'absent' && handoffRec && handoffRec.to ? handoffRec : null,
      last_switch: null, accounts: [], captured_at: captured,
    };
  }
  const n = notify.value;
  const threshold = num(n.threshold);
  const recommendation = pickRecommendation(n.recommendation);
  return {
    ok: true,
    provenance: 'REPORTED',
    note: null,
    threshold: threshold ?? DEFAULT_THRESHOLD,
    threshold_source: threshold !== null ? 'rotator' : 'default',
    mode: str(n.mode),
    active: str(n.active),
    updated_at: iso(n.updatedAt),
    notice: str(n.notice),
    disabled: bool(n.disabled),
    last_result: n.lastResult && typeof n.lastResult === 'object'
      ? { action: str(n.lastResult.action), reason: str(n.lastResult.reason), at: iso(n.lastResult.at) } : null,
    recommendation,
    // AUTHORITATIVE: when the notification file is readable it IS the rotator's current state. A recommendation
    // the rotator has cleared stays cleared even if an old handoff.json (phase 'recommend') is still on disk.
    handoff_recommendation: null,
    last_switch: pickSwitch(n.lastSwitch),
    accounts: (Array.isArray(n.accounts) ? n.accounts : []).slice(0, MAX_ACCOUNTS).map(pickAccount).filter(Boolean),
    captured_at: captured,
  };
}
