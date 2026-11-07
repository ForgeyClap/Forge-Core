'use strict';
/**
 * doctor/checks-agents.cjs — one module of forge-doctor.cjs (WP A11 part 2): agents (Boss files, frontmatter, injection, tool policy), model_routing, chain (event hash chains).
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { claudeDir, policy, runsDirOf } = require('./context.cjs');

// 6) agents check — the 12 Boss agent-files exist with valid frontmatter, AND no agent
// body carries an injection/supply-chain pattern (agent bodies become system prompts — same spirit as
// the leak scan: a `curl … | bash`, an inert context-manager plumbing block, etc. must never ship).
const BOSS_NAMES = ['boss', 'head-chef', 'review-boss', 'test-boss', 'ui-boss', 'seo-boss', 'security-boss', 'skill-boss', 'search-boss', 'build-boss', 'integration-boss', 'docs-boss'];
const AGENT_INJECTION_PATTERNS = [
  { name: 'curl-pipe-bash', re: /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i },
  { name: 'wget-pipe-sh', re: /\bwget\b[^\n]*\|\s*(ba)?sh\b/i },
  { name: 'ignore-previous-instructions', re: /ignore\s+(all\s+)?previous\s+instructions/i },
  { name: 'context-manager-plumbing', re: /Communication Protocol|context-manager/i },
];
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  // WP 1.9: keys may carry hyphens and digits. Claude Code's skill switches are hyphenated
  // (disable-model-invocation, user-invocable); the old ^([A-Za-z_]+): skipped those lines, so a broken value
  // there was invisible to every check. Indented lines (block/continuation text) still never match.
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim(); }
  return fm;
}
// Splits a frontmatter `tools:` value ("Read, Write, Edit, Grep, Glob") into a clean array. Pure helper,
// tolerant of a missing/empty/non-string input (returns []) so a bad-frontmatter agent-md never crashes
// the tool-policy comparison below — it just shows up with an empty grant set (which will legitimately
// mismatch the policy and get flagged).
function parseToolsList(toolsStr) {
  if (typeof toolsStr !== 'string' || !toolsStr.trim()) return [];
  return toolsStr.split(',').map((s) => s.trim()).filter(Boolean);
}
function loadToolPolicy(root) {
  const file = path.join(claudeDir(root), 'config', 'agents', 'agent-tool-policy.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
/** loadToolPolicyOverlay(root) -> {present, data, error} —: .claude/config/agents/
 *  agent-tool-policy.user.json, the project's OWN never-synced overlay (forge-sync never ships or touches *.user.json).
 *  Absent is the normal state. Present-but-broken is reported, never silently ignored. */
function loadToolPolicyOverlay(root) {
  const file = path.join(claudeDir(root), 'config', 'agents', 'agent-tool-policy.user.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { present: false, data: null, error: null } : { present: true, data: null, error: 'unreadable (' + ((e && e.code) || (e && e.message)) + ')' }; }
  try { return { present: true, data: JSON.parse(raw.replace(/^﻿/, '')), error: null }; }
  catch (e) { return { present: true, data: null, error: 'not valid JSON (' + String(e.message).split('\n')[0].slice(0, 120) + ')' }; }
}
const TOOL_POLICY_OVERLAY_KEYS = new Set(['agents', '_doc', '_note']);
/** mergeToolPolicyOverlay(base, overlay) -> {policy, added[], problems[]} —. The overlay may only
 *  ADD project-own agents (e.g. 26H2's idea-reviewer), each with an EXISTING shipped class and a tools list that
 *  class allows. It can never redefine a shipped agent, add or change a class, or set any other key — every such
 *  attempt is a problem (the agents check then fails, visibly) and is not merged. Pure; the shipped policy object
 *  is never mutated (a merged copy is returned). */
function mergeToolPolicyOverlay(base, overlay) {
  const problems = [], added = [];
  if (!base || typeof base !== 'object' || overlay == null) return { policy: base, added, problems };
  if (typeof overlay !== 'object' || Array.isArray(overlay)) return { policy: base, added, problems: ['agent-tool-policy.user.json must be a JSON object'] };
  for (const k of Object.keys(overlay)) if (!TOOL_POLICY_OVERLAY_KEYS.has(k)) problems.push('agent-tool-policy.user.json: key "' + k + '" is not allowed — an overlay may only ADD agents; classes and every other field stay template-owned');
  const agents = overlay.agents;
  if (agents === undefined) return { policy: base, added, problems };
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return { policy: base, added, problems: problems.concat(['agent-tool-policy.user.json: "agents" must be an object']) };
  const classes = base.classes && typeof base.classes === 'object' ? base.classes : {};
  const shipped = base.agents && typeof base.agents === 'object' ? base.agents : {};
  const merged = Object.assign({}, shipped);
  for (const [name, entry] of Object.entries(agents)) {
    if (Object.prototype.hasOwnProperty.call(shipped, name)) { problems.push('agent "' + name + '" is defined by the shipped policy — an overlay can never redefine (or loosen) a shipped agent'); continue; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { problems.push('agent name "' + name + '" is not a plain agent file name'); continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { problems.push('agent "' + name + '" must be an object with a "class" and a "tools" list'); continue; }
    if (typeof entry.class !== 'string' || !Object.prototype.hasOwnProperty.call(classes, entry.class)) { problems.push('agent "' + name + '": class "' + entry.class + '" does not exist in the shipped policy — an overlay can only use an existing class, never create one'); continue; }
    if (!Array.isArray(entry.tools) || !entry.tools.length || entry.tools.some((x) => typeof x !== 'string' || !x.trim())) { problems.push('agent "' + name + '" needs a non-empty "tools" list of tool names'); continue; }
    const forbidden = Array.isArray(classes[entry.class].forbidden) ? classes[entry.class].forbidden : [];
    const bad = entry.tools.filter((x) => forbidden.includes(x.trim()));
    if (bad.length) { problems.push('agent "' + name + '" asks for ' + bad.join(', ') + ', which its class "' + entry.class + '" forbids'); continue; }
    merged[name] = JSON.parse(JSON.stringify(entry));
    added.push(name);
  }
  return { policy: Object.assign({}, base, { agents: merged }), added, problems };
}
/** memoryAllowedForClass(policyFile, agentName) -> true/false/null — N5 (2026-09-26 laptop re-audit):
 *  Claude Code grants Write+Edit to ANY agent whose frontmatter carries `memory: project`, regardless of its
 *  `tools:` line — so a class whose policy forbids Write (read-only-audit, exec-reviewer) must never carry
 *  `memory: project` in its agent-md, and every OTHER class must carry it (memory is how these roles persist
 *  their own notes between runs). Derived straight from agent-tool-policy.json's `classes[...].forbidden`
 *  list, never hardcoded here, so a future class stays correct without touching this file. Returns null
 *  (unresolvable) when the policy file or this agent's class entry cannot be read — callers fall back to the
 *  OLDER, stricter "memory is always required" behavior in that case rather than silently skipping the check. */
function memoryAllowedForClass(policyFile, agentName) {
  const cls = policyFile && policyFile.agents && policyFile.agents[agentName] && policyFile.agents[agentName].class;
  const forbidden = cls && policyFile.classes && policyFile.classes[cls] && Array.isArray(policyFile.classes[cls].forbidden)
    ? policyFile.classes[cls].forbidden : null;
  return forbidden ? !forbidden.includes('Write') : null;
}
// Claude Code only loads a project agent whose frontmatter `model` is one of its aliases. On 2026-09-27 the
// two agents that carried the full id "claude-opus-5-5" (verify-boss, codex-reviewer) were silently absent from the
// session's agent list while all 17 alias agents loaded — so every install shipped two agents nobody could dispatch.
const LOADABLE_AGENT_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
function agentsCheck(root) {
  const dir = path.join(claudeDir(root), 'agents');
  const missing = [], badFrontmatter = [], injection = [];
  // loaded once, up front, and reused below for the least-privilege tool-grant comparison too.
  // merged with the project's add-only agent-tool-policy.user.json overlay (never synced).
  const shippedToolPolicy = loadToolPolicy(root);
  const overlayFile = loadToolPolicyOverlay(root);
  const overlay = shippedToolPolicy ? mergeToolPolicyOverlay(shippedToolPolicy, overlayFile.data) : { policy: null, added: [], problems: [] };
  if (overlayFile.error) overlay.problems.push('agent-tool-policy.user.json is ' + overlayFile.error);
  const toolPolicyFileForAgents = overlay.policy;
  for (const name of BOSS_NAMES) {
    const file = path.join(dir, name + '.md');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { missing.push(name); continue; }
    const fm = parseFrontmatter(text);
    const memoryAllowed = memoryAllowedForClass(toolPolicyFileForAgents, name);
    // memoryAllowed === null: class unresolvable (policy missing/broken) -> fall back to requiring memory,
    // the earlier behavior, rather than silently accepting either shape.
    const memoryOk = memoryAllowed === false ? !(fm && fm.memory) : Boolean(fm && fm.memory === 'project');
    if (!fm || fm.name !== name || !fm.description || !fm.tools || !fm.model || !memoryOk) badFrontmatter.push(name);
  }
  // injection-lint EVERY agent file present (Bosses + specialists + codex-reviewer), and collect each
  // one's REAL granted tools (keyed by filename, not the frontmatter's own `name:` field, so a bad/mismatched
  // frontmatter still gets compared against the policy rather than silently skipped).
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }
  const grants = {};
  const unloadableModel = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const p of AGENT_INJECTION_PATTERNS) { if (p.re.test(text)) injection.push({ file: 'agents/' + f, pattern: p.name }); }
    const base = f.replace(/\.md$/, '');
    const fm = parseFrontmatter(text);
    grants[base] = parseToolsList(fm && fm.tools);
    if (fm && fm.model && !LOADABLE_AGENT_MODELS.has(String(fm.model).trim().toLowerCase())) unloadableModel.push({ file: 'agents/' + f, agent: base, model: String(fm.model).trim() });
  }
  // mechanical least-privilege enforcement: compare every agent-md's ACTUAL frontmatter
  // tools against the pinned .claude/config/agents/agent-tool-policy.json source of truth. A missing/
  // unparseable policy file is itself a failure (never a silent pass — same "no evidence" discipline as
  // the other checks in this file), not just a skipped sub-check.
  const toolPolicyFile = toolPolicyFileForAgents;
  let toolPolicy;
  if (!policy) {
    toolPolicy = { ok: false, reason: 'forge-policy.cjs module not available (toolPolicyCheck unavailable)', missingPolicy: [], missingAgentFile: [], classViolations: [], driftViolations: [] };
  } else if (!toolPolicyFile) {
    toolPolicy = { ok: false, reason: 'agent-tool-policy.json missing or unparseable at .claude/config/agents/agent-tool-policy.json', missingPolicy: [], missingAgentFile: [], classViolations: [], driftViolations: [] };
  } else {
    toolPolicy = policy.toolPolicyCheck(toolPolicyFile, grants);
  }
  // a rejected overlay entry fails the check visibly; accepted project agents are named on the result.
  if (overlay.problems.length || overlay.added.length) {
    toolPolicy = Object.assign({}, toolPolicy, { overlayAdded: overlay.added }, overlay.problems.length ? { ok: false, overlayProblems: overlay.problems } : {});
  }
  // WP 1.5: the agent frontmatter is the single source of truth; config/agents/agents.generated.json is
  // generated from it and must not drift (forge-policy.cjs agentsGeneratedCheck: drift, frontmatter rules, legacy
  // mirrors). n/a when the file is absent outside a development tree that defines the agent set, and when
  // forge-policy.cjs predates it.
  let generated;
  if (!policy || typeof policy.agentsGeneratedCheck !== 'function') generated = { ok: true, applicable: false, checked: 0, violations: [], notes: [], reason: 'forge-policy.cjs agentsGeneratedCheck not available' };
  else { try { generated = policy.agentsGeneratedCheck(root); } catch (e) { generated = { ok: false, applicable: true, checked: 0, violations: [], notes: [], reason: 'agentsGeneratedCheck threw: ' + e.message }; } }
  return {
    ok: missing.length === 0 && badFrontmatter.length === 0 && injection.length === 0 && toolPolicy.ok === true
      && !unloadableModel.some((u) => toolPolicyFileForAgents && toolPolicyFileForAgents.agents && toolPolicyFileForAgents.agents[u.agent])
      && generated.ok === true,
    expected: BOSS_NAMES.length,
    found: files.length,
    missing,
    badFrontmatter,
    injection,
    toolPolicy,
    unloadableModel,
    generated,
  };
}

/** modelRoutingCheck(root) — GOAT model routing, ENFORCED. Delegates to forge-policy.cjs's
 *  routingCheck(): every agent's frontmatter model/effort == agent-model-map claudeTier/claudeEffort ==
 *  agent-tool-policy model, valid aliases/efforts, a complete routes table with escalate == fable, no default
 *  haiku/fable, and no CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_CODE_SUBAGENT_MODEL / modelSettings effort override in
 *  the project settings. A project with neither .claude/FORGE_MODEL_ROUTING.json nor agent-model-map.json has
 *  no Forge routing to check (applicable:false, ok:true — said so on its summary line, never a silent pass).
 *  A missing forge-policy.cjs in a project that DOES carry routing files fails the check (ok:false, reason),
 *  the same honest-degrade posture agentsCheck takes for the tool-policy sub-check. Recoverable through
 *  FORGE_HARD_RULES.json doctor_check_overrides (check id 'model_routing') like the other enforced checks. */
function modelRoutingCheck(root) {
  const hasRouting = fs.existsSync(path.join(claudeDir(root), 'FORGE_MODEL_ROUTING.json'))
    || fs.existsSync(path.join(claudeDir(root), 'config', 'agents', 'agent-model-map.json'));
  if (!policy || typeof policy.routingCheck !== 'function') {
    return hasRouting
      ? { ok: false, applicable: true, checked: 0, violations: [], notes: [], reason: 'forge-policy.cjs routingCheck not available — the model-routing files cannot be checked' }
      : { ok: true, applicable: false, checked: 0, violations: [], notes: [], reason: 'no Forge model-routing files and no forge-policy.cjs — nothing to check' };
  }
  try { return policy.routingCheck(root); }
  catch (e) { return { ok: false, applicable: true, checked: 0, violations: [], notes: [], reason: 'routingCheck threw: ' + e.message }; }
}

// Tamper-evident chain check: walk each run's events.jsonl hash-chain (log-event.cjs writes
// entry_hash = sha256(canonical(event)+prev_hash)). LEGACY runs with no entry_hash anywhere are skipped
// (not broken). A chained run is BROKEN if an event's self-hash mismatches (edited) or its prev_hash links
// nowhere (truncation/removal). Tolerant of concurrent forks: prev_hash may reference ANY prior entry_hash.
//
// Fix (HIGH bug): a MIXED run — a legacy prefix with no entry_hash, followed later by REAL
// chained events once log-event.cjs's hash chain was adopted mid-run — used to be misclassified. The old
// gate (`evs.some(e=>e.entry_hash)`) only decided "skip or not"; once ANY event had a hash, validation
// walked the WHOLE array from index 0, so the legacy prefix's hash-less events were reported as "missing
// hash fields" — indistinguishable from a genuine tamper (cry-wolf). Fix: find the FIRST index that
// carries an entry_hash and validate ONLY from there onward (mirrored in forge-certify.cjs's verifyChain
// and in log-event.cjs's own prev_hash lookup, which now searches backward for the nearest prior chained
// event instead of assuming the file's last line is always it). Earlier legacy events are skipped, not
// counted as broken; a genuine tamper anywhere in the chained section is still caught exactly as before.
//
// Fix (MEDIUM bug): a single blank/whitespace-only line inside events.jsonl (JSON.parse('')
// throws) used to make the ENTIRE run "unparseable" here, while forge-certify's readEventsJsonl already
// tolerated it — two honesty gates disagreeing on identical bytes. Blank lines are now skipped the same
// way certify does; a genuinely malformed NON-blank line still fails this check exactly as before.
//
// Fix (HIGH bug, 2nd fix round): a line that IS valid JSON but NOT a plain object (a bare
// number, array, string, `null`, or boolean — e.g. `123`, `[1,2,3]`, `"x"`) used to be accepted here via
// `out.push(JSON.parse(s))` with no type check at all, silently treated as a real "event". forge-certify's
// readEventsJsonl has ALWAYS counted exactly this shape as malformed (`if (v && typeof v==='object' &&
// !Array.isArray(v)) events.push(v); else malformed++`), so the two honesty gates gave OPPOSITE verdicts on
// identical bytes: doctor's chainCheck (via the old findIndex-for-first-entry_hash logic) would just skip
// past the non-object "event" (it has no `.entry_hash` property) and validate the real chained events that
// follow as ok:true, while certify counted the same line as malformed and returned NOT CERTIFIED. Fix:
// mirror certify's exact condition — a valid-JSON-but-non-plain-object line now THROWS here too, so the
// caller (chainCheck) reports the whole run as unparseable, exactly matching certify's malformed-line
// verdict on the same bytes. A genuine blank line remains benign/skipped (unchanged).
function chainCanon(ev) { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); }
function parseEventsJsonlLenient(raw) {
  // Skips blank/whitespace-only lines (never malformed); a genuinely malformed non-blank line — including a
  // syntactically-valid-JSON line that is NOT a plain object — throws so the caller can report the whole
  // run as unparseable — same all-or-nothing behavior as before this fix, just no longer confused by a
  // benign blank line, and no longer accepting a non-object primitive as a fake "event".
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const v = JSON.parse(s);
    if (!(v && typeof v === 'object' && !Array.isArray(v))) {
      throw new Error('events.jsonl line is valid JSON but not a plain object (mirrors forge-certify.cjs readEventsJsonl): ' + s.slice(0, 80));
    }
    out.push(v);
  }
  return out;
}
function chainCheck(root) {
  const runsDir = runsDirOf(root);
  let runIds = [];
  try { runIds = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { ok: true, checked: 0, chained: 0, broken: [], note: 'no forge-runs' }; }
  let chained = 0; const broken = [];
  for (const id of runIds) {
    let raw; try { raw = fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8'); } catch { continue; }
    if (!raw || !raw.trim()) continue;
    let evs; try { evs = parseEventsJsonlLenient(raw); } catch { broken.push({ run: id, reason: 'unparseable events.jsonl' }); continue; }
    const startIdx = evs.findIndex((e) => e && e.entry_hash);
    if (startIdx === -1) continue; // legacy / fully unchained run — skip, not broken
    chained++;
    const seen = new Set(['genesis:' + id]); let ok = true, reason = '';
    for (let i = startIdx; i < evs.length; i++) {
      const e = evs[i];
      if (!e.entry_hash || !e.prev_hash) { ok = false; reason = 'event ' + i + ' missing hash fields'; break; }
      if (crypto.createHash('sha256').update(chainCanon(e) + e.prev_hash).digest('hex') !== e.entry_hash) { ok = false; reason = 'event ' + i + ' self-hash mismatch (edited?)'; break; }
      if (!seen.has(e.prev_hash)) { ok = false; reason = 'event ' + i + ' prev_hash links nowhere (truncation/removal?)'; break; }
      seen.add(e.entry_hash);
    }
    if (!ok) broken.push({ run: id, reason });
  }
  return { ok: broken.length === 0, checked: runIds.length, chained, broken };
}

module.exports = {
  BOSS_NAMES, AGENT_INJECTION_PATTERNS, parseFrontmatter, parseToolsList, loadToolPolicy, loadToolPolicyOverlay,
  TOOL_POLICY_OVERLAY_KEYS, mergeToolPolicyOverlay, memoryAllowedForClass, LOADABLE_AGENT_MODELS, agentsCheck,
  modelRoutingCheck, chainCanon, parseEventsJsonlLenient, chainCheck,
};
