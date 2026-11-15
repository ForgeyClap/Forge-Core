#!/usr/bin/env node
'use strict';
/**
 * forge-complexity-floor.cjs — a request-based complexity floor for the run contract (SD-T6).
 *
 *   requestFloor(events, runDir) -> {level: 1|2, reasons: string[]}
 *
 * resolveComplexity (forge-runcontract.cjs) measured only dispatches and the Lead's own declaration, so a Lead that built
 * everything itself stayed L1 and every L2+ rule (skill-delivered, run-shape-declared, end-self-review) was switched off
 * (logic; category tests: restaurant-v2 and android-v3 closed L1 CONTRACT OK). The floor reads
 * what the REQUEST asked for. It is L2 when any of these holds:
 *   - anticipate.json (not reverted) declares 2+ deliverable types or 2+ lanes;
 *   - plan-card.json names 2+ work packages;
 *   - LEAD_ONLY_MIN_FILES+ distinct app files (outside .claude/, .forge/, _scratch/) were written and the run logged
 *     no builder dispatch (review and verify dispatches do not count: in both replayed runs the only dispatches were
 *     reviewers). The files come from the run's file_changed events OR, when it names more, from the Lead's own writes
 *     in the harness tool log (R8B-F4, round 8b: the android-v9 Lead logged 3 events and no file_changed, wrote 11 app
 *     files itself, and its contract derived L1). See toollogLeadWrites.
 * The floor can only RAISE the level (resolveComplexity takes the max). Total: junk input gives L1, never a throw.
 * Zero dependencies. Reads only; the tool log is found beside the run folder (<runs>/_toollog, the runs folder that
 * forge-paths gave the caller), so no root is needed.
 */
const fs = require('fs');
const path = require('path');

/** At or above this many distinct app files written without a builder, a run is not a quick fix (quick = 1-2 files). */
const LEAD_ONLY_MIN_FILES = 3;
const DISPATCH_TYPES = new Set(['agent_started', 'subagent_started', 'custom_subagent_created']);
const FILE_EVENT_TYPES = new Set(['file_changed']);
const FILE_FIELDS = ['file', 'files', 'path', 'paths', 'files_changed'];
const REVIEW_RE = /verif|review|codex|audit|security-boss/i;
/** forge-toolhook's ledger: <runs>/_toollog/<session>.jsonl plus rotated generations <session>.N.jsonl. */
const TOOLLOG_DIR = '_toollog';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_TOOLLOG_BYTES = 16 * 1024 * 1024; // forge-toolhook rotates at 4 MB; a bigger file is not its output
const MTIME_SLACK_MS = 60 * 1000;
/** An open run owns writes up to 6 h after its last event (the same bound as forge-claim-reports OPEN_SLACK_MS), so an
 *  abandoned run does not claim every later write. */
const OPEN_SLACK_MS = 6 * 3600e3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : []);

function readJson(dir, name) {
  if (typeof dir !== 'string' || !dir) return null;
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '')); return isObj(j) ? j : null; } catch { return null; }
}

/** normalizeFile('C:\\p\\.\\src\\a.js') -> 'c:/p/src/a.js'; '' when unusable. */
function normalizeFile(f) {
  if (typeof f !== 'string' || !f.trim()) return '';
  return f.trim().replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}
const isAppFile = (f) => !!f && !/(^|\/)(\.claude|\.forge|_scratch)(\/|$)/.test(f);
const tsOf = (e) => { const n = Date.parse(isObj(e) ? (e.timestamp || e.ts || e.ingested_at) : undefined); return Number.isFinite(n) ? n : null; };

/** runWindow(events) -> {from, to, runId} | null: the first run_started to the last run_completed; an open run ends
 *  OPEN_SLACK_MS after its last dated event (a live run's later writes do not exist yet). No dated run_started = none. */
function runWindow(events) {
  const start = events.find((e) => isObj(e) && e.event_type === 'run_started');
  const from = tsOf(start);
  if (from === null) return null;
  const end = tsOf(events.filter((e) => isObj(e) && e.event_type === 'run_completed').pop());
  const last = events.reduce((m, e) => { const n = tsOf(e); return n !== null && n > m ? n : m; }, from);
  return { from, to: end === null ? last + OPEN_SLACK_MS : end, runId: typeof start.run_id === 'string' && start.run_id ? start.run_id : null };
}

/** The parsed lines of every *.jsonl in dir that can hold a line of the window (links and oversized files skipped). */
function readLogLines(dir, from) {
  const out = [];
  let st; try { st = fs.lstatSync(dir); } catch { return out; }
  if (!st.isDirectory()) return out;
  let names; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let fst; try { fst = fs.lstatSync(file); } catch { continue; }
    // A line's ts is taken before the line is appended, so a file last written before the run started holds none of it.
    if (!fst.isFile() || fst.size > MAX_TOOLLOG_BYTES || fst.mtimeMs + MTIME_SLACK_MS < from) continue;
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      try { const r = JSON.parse(line); if (isObj(r)) out.push(r); } catch { /* a damaged or empty line is skipped */ }
    }
  }
  return out;
}

/** toollogLeadWrites(runDir, events) -> the sorted distinct app files the Lead itself wrote during the run, from the
 *  harness tool log beside the run folder. A line counts when its tool is Write|Edit|MultiEdit|NotebookEdit, ok is not
 *  false, target_kind is path, agent_id is null (the Lead, not a subagent), it names a real session (forge-toolhook files
 *  a payload without one under unknown-session; the dev tree's only such write lines came from tests), ts lies in the
 *  run window, it is not tagged with another run, and the target is project-relative (forge-toolhook stores a path
 *  inside the project relative and one outside it absolute), has no '..' and lies outside .claude/, .forge/, _scratch/.
 *  shortcut: every Lead session's writes in the window count, so a second Lead session writing in the same project at
 *  the same time is counted too (tool log lines name no run unless FORGE_RUN_ID was set); upgrade by keeping only the
 *  run's own session once run_started records it. */
function toollogLeadWrites(runDir, events) {
  if (typeof runDir !== 'string' || !runDir) return [];
  const win = runWindow(asList(events));
  if (!win) return [];
  const runId = win.runId || path.basename(path.resolve(runDir));
  const files = new Set();
  for (const r of readLogLines(path.join(path.dirname(path.resolve(runDir)), TOOLLOG_DIR), win.from)) {
    if (!WRITE_TOOLS.has(r.tool) || r.ok === false || r.target_kind !== 'path' || r.agent_id != null) continue;
    if (typeof r.session !== 'string' || !r.session || r.session === 'unknown-session') continue; // no real session: synthetic
    if (typeof r.run === 'string' && r.run && r.run !== runId) continue;
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at) || at < win.from || at > win.to) continue;
    const f = normalizeFile(r.target);
    if (f && !/^([a-z]:|\/)/.test(f) && !/(^|\/)\.\.(\/|$)/.test(f) && isAppFile(f)) files.add(f);
  }
  return Array.from(files).sort();
}

function filesOf(e) {
  const out = [];
  for (const src of [e, isObj(e.payload) ? e.payload : null, isObj(e.details) ? e.details : null]) {
    if (!src) continue;
    for (const k of FILE_FIELDS) for (const v of (Array.isArray(src[k]) ? src[k] : [src[k]])) { const f = normalizeFile(v); if (f) out.push(f); }
  }
  return out;
}

/** Writer Bosses and the GOAT worker routes (FB-CONTRACT-2-F2): only these count as a build dispatch. Head Chef triage,
 *  Scribe, Docs/Search/SEO/Skill Boss and reviewers do not, so a Lead that triaged and then built alone stays L2. */
const WRITERS = new Set(['build-boss', 'ui-boss', 'integration-boss', 'data-scientist', 'electron-pro', 'mcp-developer',
  'ml-engineer', 'payment-integration', 'boss', 'quick', 'build', 'deep', 'escalate', 'general-purpose',
  'rbx-luau-engineer', 'rbx-ui-engineer', 'rbx-world-builder', 'rbx-vfx-audio', 'rbx-blender-artist', 'rbx-integrator']);
/** log-event records the registry display name ('Roblox VFX and Audio'): map each display name to its slug. */
let displaySlugs = null;
function slugOfDisplayName(name) {
  if (!displaySlugs) {
    displaySlugs = new Map();
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), 'utf8').replace(/^﻿/, ''));
      for (const group of [reg.agents, reg.specialistAgents]) {
        if (isObj(group)) for (const [slug, row] of Object.entries(group)) if (isObj(row) && typeof row.name === 'string') displaySlugs.set(row.name.trim().toLowerCase(), slug);
      }
    } catch { /* no registry next to this copy: the slug and whole-name checks below still apply */ }
  }
  return displaySlugs.get(name) || '';
}
function isBuildDispatch(e) {
  const fields = [e.agent, e.agent_type, e.subagent_type, e.role, e.route].filter((v) => typeof v === 'string');
  if (REVIEW_RE.test(fields.join(' '))) return false;
  return fields.some((v) => {
    const low = v.trim().toLowerCase();
    // The whole name ('Data Scientist' -> data-scientist), its registry slug, then each token ('Build Boss · part A').
    if (WRITERS.has(low.replace(/\s+/g, '-')) || WRITERS.has(slugOfDisplayName(low))) return true;
    return low.replace(/\s+boss\b/g, '-boss').split(/[^a-z0-9-]+/).some((tok) => WRITERS.has(tok));
  });
}

function leadOnlyBuild(events, runDir) {
  const files = new Set();
  let builders = 0;
  for (const e of events) {
    if (!isObj(e) || typeof e.event_type !== 'string') continue;
    const type = e.event_type.toLowerCase();
    if (DISPATCH_TYPES.has(type) && isBuildDispatch(e)) builders++;
    else if (FILE_EVENT_TYPES.has(type)) for (const f of filesOf(e)) if (isAppFile(f)) files.add(f);
  }
  if (builders) return null;
  // The larger count, not the union: an event may name a file absolute where the tool log has it relative.
  const logged = toollogLeadWrites(runDir, events).length;
  if (logged > files.size && logged >= LEAD_ONLY_MIN_FILES) return logged + ' app files written by the Lead itself with no build dispatch logged (harness tool log)';
  if (files.size < LEAD_ONLY_MIN_FILES) return null;
  return files.size + ' app files written with no build dispatch (only the Lead or reviewers worked)';
}

function count(v) { return Array.isArray(v) ? v.length : (Number.isInteger(v) && v > 0 ? v : 0); }

function requestFloor(events, runDir) {
  const reasons = [];
  const ant = readJson(runDir, 'anticipate.json');
  if (ant && ant.status !== 'reverted') {
    const types = asList(ant.deliverable_types).filter((x) => typeof x === 'string' && x);
    if (new Set(types).size >= 2) reasons.push('anticipate.json declares ' + new Set(types).size + ' deliverable types (' + Array.from(new Set(types)).join(', ') + ')');
    const lanes = count(isObj(ant.input) ? ant.input.lanes : undefined);
    if (lanes >= 2) reasons.push('anticipate.json declares ' + lanes + ' lanes');
  }
  const card = readJson(runDir, 'plan-card.json');
  if (card && count(card.packages) >= 2) reasons.push('the plan card names ' + count(card.packages) + ' work packages');
  const lead = leadOnlyBuild(asList(events), runDir);
  if (lead) reasons.push(lead);
  return { level: reasons.length ? 2 : 1, reasons };
}

module.exports = { requestFloor, toollogLeadWrites, LEAD_ONLY_MIN_FILES };
