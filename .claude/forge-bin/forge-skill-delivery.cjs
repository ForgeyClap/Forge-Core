#!/usr/bin/env node
'use strict';
/**
 * forge-skill-delivery.cjs — what the run contract's skill-delivered rule counts as delivered (SD-T5).
 *
 *   deliveredFor(agentType, startLines, stopLines) -> Set<string>  preloaded (SubagentStart skills_preloaded)
 *                                                                  ∪ opened (SubagentStop skills_opened, transcript
 *                                                                  scanned), lowercased
 *   assignedFor(agentType, unionMap, data)         -> string[]     the run's skill map ∪ the role baseline
 *   measured(startLines, stopLines)                -> boolean      a hook line recorded a preload or a scanned transcript
 *   judgeDelivery({map, startLines, stopLines, data, known, executorTypes}) -> detail for skill-delivered
 *
 * A preload is in the agent's context from its first turn and never shows up as an open, so counting opens alone failed
 * a correctly preloaded agent. The role baseline (FORGE_DEFAULT_SKILLS.json via forge-default-skills.cjs) is an
 * assignment: an executor type with a baseline is never "unassigned". Baseline skills are REQUIRED only for an agent
 * type whose SubagentStart lines record skills_preloaded (the hook that measures preloads); on an older hook they are
 * listed as baseline_unmeasured, never failed. Skills that do not exist in the root are never required.
 * Every function is total: junk input gives an empty answer, never a throw. Zero dependencies.
 */
const DS = require('./forge-default-skills.cjs');

const MAX_DETAIL_ITEMS = 20;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : []);
const lower = (list) => asList(list).filter((s) => typeof s === 'string' && s).map((s) => s.toLowerCase());

/** keyOf("forge:Build Boss") -> "build-boss"; '' when unusable. */
function keyOf(agentType) {
  if (typeof agentType !== 'string') return '';
  return DS.normalizeAgent(agentType.slice(agentType.lastIndexOf(':') + 1)).replace(/-+/g, '-');
}
const linesOf = (lines, key) => asList(lines).filter((l) => isObj(l) && key && keyOf(l.agent_type) === key);

function deliveredFor(agentType, startLines, stopLines) {
  const key = keyOf(agentType);
  const out = new Set();
  for (const l of linesOf(startLines, key)) for (const s of lower(l.skills_preloaded)) out.add(s);
  for (const l of linesOf(stopLines, key)) if (l.transcript_scanned === true) for (const s of lower(l.skills_opened)) out.add(s);
  return out;
}

function assignedFor(agentType, unionMap, data) {
  const key = keyOf(agentType);
  const out = [];
  const add = (list) => { for (const s of asList(list)) if (typeof s === 'string' && s && !out.includes(s)) out.push(s); };
  if (isObj(unionMap)) add(unionMap[key]);
  if (isObj(data)) add(DS.baselineFor(key, data));
  return out;
}

function measured(startLines, stopLines) {
  return asList(stopLines).some((l) => isObj(l) && typeof l.transcript_scanned === 'boolean')
    || asList(startLines).some((l) => isObj(l) && Array.isArray(l.skills_preloaded));
}

/** judgeDelivery(opts) -> {measured, agents, delivered, missing:[{agent, skills}], not_dispatched, not_scanned,
 *  unassigned, baseline_unmeasured}. `map` is the run's normalised union map, `known` the skill names of the root,
 *  `executorTypes` the types that fail as unassigned when nothing is assigned to them. */
function judgeDelivery(opts) {
  const o = isObj(opts) ? opts : {};
  const map = isObj(o.map) ? o.map : {};
  const data = isObj(o.data) ? o.data : null;
  const known = o.known instanceof Set ? o.known : null;
  const exec = o.executorTypes instanceof Set ? o.executorTypes : new Set();
  const starts = asList(o.startLines);
  const stops = asList(o.stopLines);
  const exists = (s) => !known || known.has(s);
  const baseline = (k) => (data ? DS.baselineFor(k, data).filter(exists) : []);
  const dispatched = [];
  for (const l of stops.concat(starts)) { const k = isObj(l) ? keyOf(l.agent_type) : ''; if (k && !dispatched.includes(k)) dispatched.push(k); }
  const agents = Object.keys(map).concat(dispatched.filter((k) => !map[k] && baseline(k).length));
  const sd = { measured: measured(starts, stops), agents, delivered: [], missing: [], not_dispatched: [], not_scanned: [], unassigned: [], baseline_unmeasured: [] };
  for (const k of dispatched) if (exec.has(k) && !asList(map[k]).length && !baseline(k).length && !sd.unassigned.includes(k)) sd.unassigned.push(k);
  for (const a of agents) {
    const ownStops = linesOf(stops, a);
    const ownStarts = linesOf(starts, a);
    if (!ownStops.length && !ownStarts.length) { sd.not_dispatched.push(a); continue; }
    const preloadMeasured = ownStarts.some((l) => Array.isArray(l.skills_preloaded));
    const base = baseline(a);
    if (base.length && !preloadMeasured) sd.baseline_unmeasured.push(a);
    const required = assignedFor(a, map, null).concat(preloadMeasured ? base.filter((s) => !asList(map[a]).includes(s)) : []);
    if (!required.length) continue;
    const got = deliveredFor(a, ownStarts, ownStops);
    const lacking = required.filter((s) => !got.has(s.toLowerCase()));
    if (!lacking.length) { sd.delivered.push(a); continue; }
    if (!ownStops.some((l) => l.transcript_scanned === true)) { sd.not_scanned.push(a); continue; }
    sd.missing.push({ agent: a, skills: lacking.slice(0, MAX_DETAIL_ITEMS) });
  }
  return sd;
}

module.exports = { deliveredFor, assignedFor, measured, judgeDelivery, keyOf };
