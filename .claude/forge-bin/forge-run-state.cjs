#!/usr/bin/env node
'use strict';
/**
 * forge-run-state.cjs — DURABLE RESUME projector (NEXT tier). Folds a run's events.jsonl into a
 * resume plan so a crashed/interrupted L3/L4 run restarts only the UNFINISHED work packages, not from zero.
 * Deterministic projection (no side effects). The Lead reads the plan and re-dispatches only the listed Bosses.
 *
 * IDEMPOTENCY (honest limit): "exactly-once" is really effectively-once. Before RE-running any side-effecting
 * action on resume (email/SMS/deploy/migration/PR/payment), the owning Boss MUST check an intent/receipt key
 * so replay never re-sends. This projector marks agents whose last event looks side-effecting so resume is
 * careful, but true replay fidelity depends on the run logging those receipts (see forge-core add-on).
 *
 * Usage:  node forge-run-state.cjs <run_id> [--json]
 * Exit: 0 = nothing to resume (complete) · 3 = resumable work remains · 2 = no such run.
 */
const fs = require('fs');
const path = require('path');

// WP 2.1 state paths: forge-paths.cjs decides the layout (the opt-in .forge/ folder, else the legacy .claude/forge-*
// folders exactly as before). Guarded: a missing or older forge-paths.cjs keeps the legacy paths and never crashes.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function statePath(root, key, read) {
  const legacy = path.join(root, '.claude', 'forge-' + key);
  if (!forgePaths) return legacy;
  try { return forgePaths.layout(root) !== 'forge' ? legacy : (read ? forgePaths.resolveExisting(root, key) : forgePaths.stateDir(root, key)); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return legacy; }
}
/** runDirOf(root, id) -> the run's folder: the active runs folder, or the legacy one when the run only exists there. */
function runDirOf(root, id) {
  const active = path.join(statePath(root, 'runs'), id), legacy = path.join(root, '.claude', 'forge-runs', id);
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}
const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : (forgePaths ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..'));
const SIDE_EFFECT_HINT = /(email|mail|deploy|migrat|payment|charge|refund|sms|webhook|publish|push|pr[_-]?open|outreach)/i;

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readEvents(id) { const raw = safeRead(path.join(runDirOf(PROJECT_ROOT, id), 'events.jsonl')); if (!raw) return null; const out = []; for (const l of raw.split(/\r?\n/)) { const t = l.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch {} } return out; }

function projectRunState(runId, events) {
  const agents = {};
  const touch = (k) => (agents[k] || (agents[k] = { started: false, completed: false, failed: false, events: 0, last: '', lastType: '', sideEffecting: false }));
  const gates = {};
  const unnamedGates = new Set(); // gate events with no gate name (forge-verify's brake): keyed by note, run-level
  // One unit per dispatch: one agent on one wp_id (else dispatch_id, else the agent name), so a Boss that finished
  // WP1 and was re-dispatched on WP2 is judged on WP2, and two agents on one wp never close each other's unit.
  // A start resets the unit; the last start/terminal decides.
  const units = {};
  const lastUnitOf = {};
  const lastWpUnit = {};
  const ownKey = (e, k) => (e.wp_id ? 'wp:' + e.wp_id + '|' + k : e.dispatch_id ? 'dispatch:' + e.dispatch_id : 'agent:' + k);
  const wpUnits = (wp) => Object.keys(units).filter((key) => units[key].wp_id === wp);
  // A terminal event closes its own unit when that exists, else the agent's latest started unit.
  const unitKey = (e, k) => (units[ownKey(e, k)] ? ownKey(e, k) : (lastUnitOf[k] && !(units[lastUnitOf[k]].wp_id && e.wp_id) ? lastUnitOf[k] : ownKey(e, k)));
  const unit = (key, k, wp) => (units[key] || (units[key] = { agent: k, wp_id: wp || null, started: false, completed: false, failed: false }));
  for (const e of events) {
    const t = e.event_type || '';
    const isStart = t === 'agent_started' || t === 'subagent_started';
    const isWpClose = t === 'wp_completed' || t === 'wp_failed';
    const isDone = t === 'agent_completed' || t === 'subagent_completed' || t === 'wp_completed';
    const isFail = t === 'agent_failed' || t === 'subagent_failed' || t === 'wp_failed';
    const wpUnit = !e.agent && e.wp_id && lastWpUnit[e.wp_id] && units[lastWpUnit[e.wp_id]];
    const k = e.agent || (wpUnit && wpUnit.agent) || 'system';
    const a = touch(k); a.events++; if (e.timestamp) a.last = e.timestamp; a.lastType = t;
    if (isStart || isDone || isFail) {
      // wp_completed / wp_failed close every unit of that wp, whoever logs them; agent_/subagent_ terminals close only their own unit.
      const all = isWpClose && e.wp_id ? wpUnits(e.wp_id) : [];
      const keys = isStart ? [ownKey(e, k)] : all.length ? all : [unitKey(e, k)];
      for (const key of keys) {
        const u = unit(key, k, e.wp_id);
        if (isStart) { u.started = true; u.completed = false; u.failed = false; lastUnitOf[k] = key; if (e.wp_id) lastWpUnit[e.wp_id] = key; a.started = true; }
        else if (isDone) { u.completed = true; u.failed = false; }
        else { u.failed = true; u.completed = false; }
      }
    }
    if (SIDE_EFFECT_HINT.test(t) || SIDE_EFFECT_HINT.test(String(e.task || '')) || SIDE_EFFECT_HINT.test(String(e.note || ''))) a.sideEffecting = true;
    if (t === 'quality_gate_passed' || t === 'quality_gate_blocked') {
      const state = t === 'quality_gate_passed' ? 'passed' : 'blocked';
      if (e.gate) {
        // A pass of a named gate that never blocked by that name clears the run-level (unnamed) blocks.
        if (state === 'passed' && gates[e.gate] !== 'blocked') { for (const g of unnamedGates) gates[g] = 'passed'; unnamedGates.clear(); }
        gates[e.gate] = state;
      } else {
        const g = e.note || 'gate';
        if (state === 'passed') { for (const u of unnamedGates) gates[u] = 'passed'; unnamedGates.clear(); gates[g] = 'passed'; }
        else { gates[g] = 'blocked'; unnamedGates.add(g); }
      }
    }
  }
  for (const key of Object.keys(units)) {
    const u = units[key];
    const a = touch(u.agent);
    if (u.completed) a.completed = true;
    if (u.failed) a.failed = true;
  }
  const openUnits = Object.keys(units).filter((key) => (units[key].started && !units[key].completed && !units[key].failed) || units[key].failed);
  const uniq = (xs) => Array.from(new Set(xs));
  const unfinished = uniq(openUnits.filter((key) => !units[key].failed).map((key) => units[key].agent));
  const failed = uniq(openUnits.filter((key) => units[key].failed).map((key) => units[key].agent));
  for (const k of Object.keys(agents)) { agents[k].completed = agents[k].completed && !unfinished.includes(k) && !failed.includes(k); agents[k].failed = failed.includes(k); }
  const blockedGates = Object.keys(gates).filter((g) => gates[g] === 'blocked');
  const resume = uniq([...unfinished, ...failed]);
  const resumeWps = uniq(openUnits.map((key) => units[key].wp_id).filter(Boolean));
  const sideEffectWarnings = resume.filter((k) => agents[k].sideEffecting);
  return {
    run_id: runId, agents, gates,
    unfinished, failed, blocked_gates: blockedGates,
    resume, resume_wps: resumeWps, side_effect_warnings: sideEffectWarnings,
    resumable: resume.length > 0 || blockedGates.length > 0,
    complete: resume.length === 0 && blockedGates.length === 0,
  };
}

module.exports = { projectRunState };

if (require.main === module) {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith('--'));
  const json = args.includes('--json');
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) { console.error('usage: node forge-run-state.cjs <run_id> [--json]'); process.exit(2); }
  if (!PROJECT_ROOT) { console.error('forge-run-state: no project root found (no .claude, .forge or .git above the current folder; set FORGE_PROJECT_ROOT)'); process.exit(2); }
  const events = readEvents(runId);
  if (events == null) { console.error('no such run / no events: ' + runId); process.exit(2); }
  const st = projectRunState(runId, events);
  if (json) { console.log(JSON.stringify(st, null, 2)); }
  else {
    console.log('forge run-state · ' + runId + (st.complete ? ' · COMPLETE (nothing to resume)' : ' · RESUMABLE'));
    if (st.resume.length) console.log('  re-dispatch: ' + st.resume.join(', '));
    if (st.blocked_gates.length) console.log('  blocked gates: ' + st.blocked_gates.join(', '));
    if (st.side_effect_warnings.length) console.log('  ⚠ idempotency: check receipt keys before re-running (' + st.side_effect_warnings.join(', ') + ')');
  }
  process.exit(st.resumable ? 3 : 0);
}
