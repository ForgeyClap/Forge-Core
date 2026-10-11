#!/usr/bin/env node
'use strict';
/**
 * forge-policy.cjs — testable orchestration/security policy helpers (2026-07-11, NEXT tier; GOAT model
 * routing added 2026-10-06):
 *   • routeFor()         — GOAT triage FALLBACK: task text + risk -> quick | build | deep, used when the Head
 *                          Chef triage is unavailable. Risky or unclear work is 'deep'; 'escalate' is never
 *                          chosen up front.
 *   • escalate()         — the GOAT one-step ladder after a failed Verify Boss check: a PROCESS failure (a
 *                          skipped file, tests not run) gets MORE EFFORT first; a CONTEXT/capability failure
 *                          gets a BIGGER MODEL (build -> deep -> escalate). At most one escalation per task,
 *                          never past 'escalate', and fable only ever via 'escalate'.
 *   • cascade()          — DEPRECATED (no production callers): the older Sonnet->Opus cascade, kept as a thin
 *                          wrapper over escalate() for old callers. It takes a route name or a model; a bare
 *                          'opus' means build (opus/medium) unless the task is hard (then deep), so a failed
 *                          build goes build -> deep, never straight to fable. New code calls escalate().
 *   • ruleOfTwo()        — Meta's "Rule of Two": an agent step should not simultaneously (1) ingest untrusted
 *                          content, (2) touch secrets/sensitive systems, AND (3) write/communicate externally.
 *                          All three at once → split the work package across Bosses.
 *   • mcpAllowlistCheck()— detect unknown or drifted (rug-pulled) MCP servers vs a pinned allow-list.
 *   • toolPolicyCheck()  — least-privilege tool grants per agent (forge-doctor agentsCheck).
 *   • routingCheck()     — ENFORCED by forge-doctor (model_routing): for every agent in agent-tool-policy.json,
 *                          frontmatter model == agent-model-map claudeTier == tool-policy model and frontmatter
 *                          effort == claudeEffort; valid aliases/efforts; the routes table is complete, escalate ==
 *                          fable, and every route equals the GOAT spec value (SPEC_ROUTES); session.lead is the
 *                          sonnet/medium router; agentDefaults exists, names every agent (and only real agents) and
 *                          each agent runs its default route's model/effort; no agent defaults to haiku or fable;
 *                          and the project settings do not set CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_CODE_SUBAGENT_MODEL /
 *                          modelSettings effort. (Lead + spec pinning + agentDefaults: Codex rev-goat-5b8c97d-1 F4/F5.)
 * Everything is pure except loadRouting(), agentRoute() and routingCheck(), which only READ files under the
 * project's .claude/ folder. Nothing in this file ever writes.
 *
 * CLI: node forge-policy.cjs route "<task>" [--risk low|medium|high]
 *      node forge-policy.cjs escalate <route> <process|context> [--escalated] [--workflow]
 *      node forge-policy.cjs check [--json] [--root <dir>]     (exit 1 when the routing check is red)
 *      node forge-policy.cjs                                   (no arguments: worked examples)
 */
const fs = require('fs');
const path = require('path');

// Kept for backward compatibility (exported); routeFor() uses HARD_ROUTE, which adds architecture.
const HARD_OPUS = /auth|jwt|hmac|credential|secret|migrat|delete|payment|charge|refund|deploy|production|security|final[_-]?verdict/i;

// ---------------------------------------------------------------------------------------------------
// GOAT model routing (spec: Model Routing Playbook by @donimas). The values
// below are the SPEC constants: the fallback when .claude/FORGE_MODEL_ROUTING.json is missing or broken.
// ---------------------------------------------------------------------------------------------------
const SPEC_ROUTES = Object.freeze({
  router:   Object.freeze({ model: 'sonnet', effort: 'medium' }),
  triage:   Object.freeze({ model: 'sonnet', effort: 'low' }),
  quick:    Object.freeze({ model: 'sonnet', effort: 'low' }),
  build:    Object.freeze({ model: 'opus',   effort: 'medium' }),
  deep:     Object.freeze({ model: 'opus',   effort: 'xhigh' }),
  escalate: Object.freeze({ model: 'fable',  effort: 'high' }),
  verifier: Object.freeze({ model: 'sonnet', effort: 'medium' }),
});
const REQUIRED_ROUTES = ['triage', 'quick', 'build', 'deep', 'escalate', 'verifier'];
const SPEC_AGENT_DEFAULTS = Object.freeze({
  'head-chef': 'triage',
  'verify-boss': 'verifier', 'test-boss': 'verifier', 'codex-reviewer': 'verifier',
  'docs-boss': 'quick', 'skill-boss': 'quick', 'search-boss': 'quick', 'seo-boss': 'quick',
  'scribe': 'quick', // specialist, not a 13th Boss
  'build-boss': 'build', 'ui-boss': 'build', 'integration-boss': 'build', 'data-scientist': 'build',
  'electron-pro': 'build', 'mcp-developer': 'build', 'ml-engineer': 'build',
  'boss': 'deep', 'review-boss': 'deep', 'security-boss': 'deep', 'payment-integration': 'deep',
});
const VALID_MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
// One step up for each failure kind. A process failure without effort control (no Workflow) takes the next
// route, which is the next effort level up the same way (quick->build, build->deep); deep is already at
// xhigh, so its only step left is the bigger model.
const PROCESS_NEXT = Object.freeze({ quick: 'build', build: 'deep', deep: 'escalate' });
const CONTEXT_NEXT = Object.freeze({ quick: 'build', build: 'deep', deep: 'escalate' });
const FORBIDDEN_ENV = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

// HARD = risk wins over size: architecture, migrations, auth, payments, data, production, security, unclear.
// Word-boundaried (fixer 2026-10-06): "author" is not "auth"; data/database/schema/retention/PII are deep.
const HARD_ROUTE = /\b(auth|authn|authz|authenticat\w*|authori[sz]\w*|oauth|login|jwt|hmac|credentials?|secrets?|migrat\w*|delet\w*|payments?|charges?|refunds?|billing|deploy\w*|production|security|architect\w*|data|database|db|schemas?|retention|pii|gdpr|privacy|unclear|ambiguous)\b/i;
const QUICK_ROUTE = /\b(typo|typos|small|tiny|trivial|docs?|readme|rename|renames|comment|comments|spelling|wording|one[- ]line|changelog)\b/i;

function routeValues(routes, name) {
  const r = routes && routes[name];
  const spec = SPEC_ROUTES[name] || {};
  return {
    model: r && typeof r.model === 'string' ? r.model : spec.model,
    effort: r && typeof r.effort === 'string' ? r.effort : spec.effort,
  };
}

/** routeFor({task, risk, routes}) -> {route, model, effort, risk, reason, source:'fallback-rules'}.
 *  Deterministic stand-in for the Head Chef triage. risk 'high', a HARD keyword, or an empty/unclear task
 *  -> deep; a small/typo/docs/rename task -> quick; everything else -> build. Never returns 'escalate'. */
function routeFor(opts) {
  const o = opts || {};
  const task = typeof o.task === 'string' ? o.task.trim() : '';
  const risk = typeof o.risk === 'string' ? o.risk.toLowerCase() : null;
  let route, why, outRisk;
  if (risk === 'high') { route = 'deep'; outRisk = 'high'; why = 'risk high -> deep'; }
  else if (!task) { route = 'deep'; outRisk = 'high'; why = 'no task text — unclear work goes to deep'; }
  else if (HARD_ROUTE.test(task)) { route = 'deep'; outRisk = 'high'; why = 'hard keyword "' + task.match(HARD_ROUTE)[0] + '" -> deep (risk wins over size)'; }
  else if (QUICK_ROUTE.test(task)) { route = 'quick'; outRisk = risk || 'low'; why = 'small/docs/typo/rename keyword "' + task.match(QUICK_ROUTE)[0] + '" -> quick'; }
  else { route = 'build'; outRisk = risk || 'medium'; why = 'a normal feature or fix -> build'; }
  const v = routeValues(o.routes, route);
  return { route, model: v.model, effort: v.effort, risk: outRisk, reason: why, source: 'fallback-rules' };
}

/** escalate({route, failure, escalated, workflow, routes}) — the ONE escalation after a failed check.
 *  failure: 'process' (skipped a file / did not run the tests) | 'context' (also 'capability': failed with
 *  the full context). workflow: true when effort can be set per dispatch (Workflow agent({effort})).
 *  Returns {ok, action:'retry'|'stop'|'invalid', ...}. 'stop' = report honestly to the owner. */
function escalate(opts) {
  const o = opts || {};
  const route = String(o.route || '').toLowerCase();
  let failure = String(o.failure || '').toLowerCase();
  if (failure === 'capability') failure = 'context';
  if (!['process', 'context'].includes(failure)) return { ok: false, action: 'invalid', reason: 'failure must be process or context (got "' + (o.failure || '') + '")' };
  if (route === 'escalate') return { ok: true, action: 'stop', from: route, reason: 'already on the top route (escalate) — never past it; report honestly to the owner' };
  if (!PROCESS_NEXT[route]) return { ok: false, action: 'invalid', reason: 'route must be quick, build or deep (got "' + (o.route || '') + '")' };
  if (o.escalated) return { ok: true, action: 'stop', from: route, reason: 'this task was already escalated once — a second FAIL stops; report honestly to the owner with the evidence' };
  const cur = routeValues(o.routes, route);
  const lesson = 'append ONE line to the lessons file: <YYYY-MM-DD> <task pattern> -> <route that worked>';
  if (failure === 'process' && o.workflow) {
    const i = EFFORT_LADDER.indexOf(cur.effort);
    if (i >= 0 && i < EFFORT_LADDER.length - 1) {
      return { ok: true, action: 'retry', from: route, route, model: cur.model, effort: EFFORT_LADDER[i + 1], step: 'more-effort', escalated: true, reason: 'process failure -> same route, effort ' + cur.effort + ' -> ' + EFFORT_LADDER[i + 1] + ' (Workflow agent({effort}))', lesson };
    }
  }
  const next = failure === 'process' ? PROCESS_NEXT[route] : CONTEXT_NEXT[route];
  const v = routeValues(o.routes, next);
  const step = v.model !== cur.model ? 'bigger-model' : 'more-effort';
  return { ok: true, action: 'retry', from: route, route: next, model: v.model, effort: v.effort, step, escalated: true, reason: failure + ' failure -> ' + route + ' to ' + next + ' (' + v.model + '/' + v.effort + ')', lesson };
}

// DEPRECATED verifier-driven cascade (no production callers; use escalate()). A thin wrapper over the GOAT
// ladder. current: a route name ('quick' | 'build' | 'deep' | 'escalate') or the model the work package ran
// on ('sonnet' = quick, 'opus' = build — or deep when the task is hard —, 'fable' = escalate) · gateFailed:
// did the check fail · hardTask: a hint string or boolean (hard work starts on deep = opus/xhigh) ·
// escalated: was this task already escalated.
const CASCADE_ROUTES = ['quick', 'build', 'deep', 'escalate'];
function cascade(current, gateFailed, hardTask, escalated) {
  const cur = String(current || '').toLowerCase();
  const hard = typeof hardTask === 'string' ? HARD_ROUTE.test(hardTask) : !!hardTask;
  if (hard && !['opus', 'fable', 'deep', 'escalate'].includes(cur)) {
    return { model: 'opus', effort: SPEC_ROUTES.deep.effort, route: 'deep', escalated: false, reason: 'hard task -> deep route (opus/xhigh) up front' };
  }
  if (!gateFailed) return { model: current, escalated: false, reason: 'passed / first attempt — stay on ' + current };
  const routeOf = CASCADE_ROUTES.includes(cur) ? cur : { sonnet: 'quick', opus: hard ? 'deep' : 'build', fable: 'escalate' }[cur];
  if (!routeOf) return { model: current, escalated: false, reason: 'unknown model "' + current + '" — no escalation' };
  const e = escalate({ route: routeOf, failure: 'context', escalated: !!escalated });
  if (e.action !== 'retry') return { model: current, escalated: false, reason: e.reason };
  return { model: e.model, effort: e.effort, route: e.route, escalated: true, reason: 'gate failed -> ' + e.reason + ' (once)' };
}

// Rule of Two: flags = { ingestUntrusted, secrets, externalWrite } (booleans). >2 true → must split.
function ruleOfTwo(flags) {
  flags = flags || {};
  const props = ['ingestUntrusted', 'secrets', 'externalWrite'].filter((k) => !!flags[k]);
  const needsSplit = props.length > 2;
  return { count: props.length, held: props, needsSplit, guidance: needsSplit ? 'split this work package across Bosses so no single step holds all three' : 'within Rule-of-Two — ok' };
}

// MCP allow-list drift check. allowlist: { name: { version, sha256 } }. servers: [{ name, version, sha256 }].
// unknown = server not in the allow-list; drift = present but description hash changed (possible rug-pull).
function mcpAllowlistCheck(allowlist, servers) {
  allowlist = allowlist || {}; servers = servers || [];
  const unknown = [], drift = [], ok = [];
  for (const s of servers) {
    const a = allowlist[s.name];
    if (!a) { unknown.push(s.name); continue; }
    if ((a.sha256 && s.sha256 && a.sha256 !== s.sha256) || (a.version && s.version && a.version !== s.version)) drift.push({ name: s.name, expected: a.sha256 || a.version, got: s.sha256 || s.version });
    else ok.push(s.name);
  }
  return { ok: unknown.length === 0 && drift.length === 0, allowed: ok, unknown, drift };
}

// toolPolicyCheck() — WP2: mechanical least-privilege enforcement for agent tool grants.
// Pure, no I/O — forge-doctor.cjs's agentsCheck() does the file reads (agent-tool-policy.json + every
// agent-md's frontmatter `tools:` line) and calls this with plain data. Fails on ANY drift:
//   • an agent-md exists with no matching policy.agents entry (missingPolicy)
//   • a policy.agents entry exists with no matching agent-md file present (missingAgentFile)
//   • the policy ITSELF assigns an agent a tool forbidden by that agent's own class (classViolations) —
//     catches someone "hardening via drift" by editing the policy file to grant a forbidden tool rather
//     than editing the agent-md (defense-in-depth against the policy file itself going stale/wrong)
//   • an agent-md's REAL granted tools differ (extra OR missing) from the exact list policy.agents[name]
//     specifies (driftViolations) — this is the core check: e.g. review-boss (read-only-audit) gaining
//     `Bash`/`Write`/`Edit` in its frontmatter shows up here as `extra`.
// policy: { classes: {name: {forbidden:[...]}}, agents: {name: {class, tools:[...]}} }
// grants: { agentName: [tool, tool, ...] } — already-split tool arrays per present agent-md file.
function toolPolicyCheck(policy, grants) {
  policy = policy || {}; grants = grants || {};
  const classes = policy.classes || {};
  const policyAgents = policy.agents || {};
  const policyNames = Object.keys(policyAgents);
  const grantNames = Object.keys(grants);

  const missingPolicy = grantNames.filter((n) => !policyAgents[n]);
  const missingAgentFile = policyNames.filter((n) => !grants[n]);

  const classViolations = [];
  const driftViolations = [];
  for (const name of policyNames) {
    const entry = policyAgents[name] || {};
    const cls = classes[entry.class];
    const allowed = new Set((entry.tools || []).map((s) => String(s).trim()));
    if (cls && Array.isArray(cls.forbidden)) {
      const badInPolicy = [...allowed].filter((t) => cls.forbidden.includes(t));
      if (badInPolicy.length) classViolations.push({ agent: name, class: entry.class, forbidden: badInPolicy });
    }
    if (!grants[name]) continue; // already reported in missingAgentFile
    const got = new Set((grants[name] || []).map((s) => String(s).trim()));
    const extra = [...got].filter((t) => !allowed.has(t));
    const missingTools = [...allowed].filter((t) => !got.has(t));
    if (extra.length || missingTools.length) driftViolations.push({ agent: name, class: entry.class, extra, missing: missingTools });
  }

  const ok = missingPolicy.length === 0 && missingAgentFile.length === 0 && classViolations.length === 0 && driftViolations.length === 0;
  return { ok, missingPolicy, missingAgentFile, classViolations, driftViolations };
}

// ---------------------------------------------------------------------------------------------------
// Read-only file helpers (GOAT routing)
// ---------------------------------------------------------------------------------------------------
const ROUTING_REL = ['.claude', 'FORGE_MODEL_ROUTING.json'];
const ROUTING_USER_REL = ['.claude', 'FORGE_MODEL_ROUTING.user.json']; // never synced; may only ADD agent defaults
const MODEL_MAP_REL = ['.claude', 'config', 'agents', 'agent-model-map.json'];
const TOOL_POLICY_REL = ['.claude', 'config', 'agents', 'agent-tool-policy.json'];
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/** hasOwn(obj, key) — own-property test, so "constructor"/"__proto__" never count as a route or an agent. */
function hasOwn(obj, key) { return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key); }

/** readJson(file) -> {exists, data, error}. Never throws. */
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { exists: e.code !== 'ENOENT', data: null, error: e.code === 'ENOENT' ? null : 'could not be read (' + (e.code || e.message) + ')' }; }
  try { return { exists: true, data: JSON.parse(raw.replace(/^﻿/, '')), error: null }; } catch (e) { return { exists: true, data: null, error: 'is not valid JSON (' + e.message.split('\n')[0].slice(0, 120) + ')' }; }
}
function frontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return fm;
}

/** loadRouting(root) -> {routes, lead, agentDefaults, source:'file'|'spec', error}. Routes from
 *  .claude/FORGE_MODEL_ROUTING.json, each missing route/field filled from the spec constants. */
function loadRouting(root) {
  const r = readJson(path.join(root || DEFAULT_ROOT, ...ROUTING_REL));
  const d = r.data && typeof r.data === 'object' ? r.data : null;
  const fileRoutes = d && d.routes && typeof d.routes === 'object' ? d.routes : {};
  const routes = {};
  for (const name of Object.keys(SPEC_ROUTES)) routes[name] = routeValues(fileRoutes, name);
  const lead = d && d.session && d.session.lead && typeof d.session.lead.model === 'string'
    ? { model: d.session.lead.model, effort: d.session.lead.effort || SPEC_ROUTES.router.effort } : Object.assign({}, SPEC_ROUTES.router);
  routes.router = lead;
  const agentDefaults = Object.assign({}, SPEC_AGENT_DEFAULTS, d && d.agentDefaults && typeof d.agentDefaults === 'object' ? d.agentDefaults : {});
  delete agentDefaults._note;
  const userAdded = addUserAgentDefaults(root, agentDefaults);
  return { routes, lead, agentDefaults, userAdded, source: d && d.routes ? 'file' : 'spec', error: r.error || (r.exists ? null : 'FORGE_MODEL_ROUTING.json not found — spec defaults used') };
}

/** addUserAgentDefaults(root, agentDefaults) -> [added agent names].: the never-synced overlay
 *  .claude/FORGE_MODEL_ROUTING.user.json may only ADD a default route for a project-own agent. It never changes a
 *  shipped entry, never touches routes or session.lead (those stay pinned to the GOAT spec), and only accepts a
 *  non-escalate route name (fable is never a default). A missing or broken overlay adds nothing. Mutates agentDefaults. */
function addUserAgentDefaults(root, agentDefaults) {
  const u = readJson(path.join(root || DEFAULT_ROOT, ...ROUTING_USER_REL)).data;
  const extra = u && u.agentDefaults && typeof u.agentDefaults === 'object' && !Array.isArray(u.agentDefaults) ? u.agentDefaults : {};
  const added = [];
  for (const name of Object.keys(extra)) {
    if (name.startsWith('_') || hasOwn(agentDefaults, name) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
    if (!REQUIRED_ROUTES.includes(extra[name]) || extra[name] === 'escalate') continue;
    agentDefaults[name] = extra[name];
    added.push(name);
  }
  return added;
}

/** agentRoute(agent, {root, map, routing}) -> {agent, model, effort, route, source}. The agent's DEFAULT
 *  model/effort: agent-model-map claudeTier/claudeEffort first, else its default route from the routing
 *  file / spec. Unknown agent -> the 'build' route (the plain-rules default). */
function agentRoute(agent, opts) {
  const o = opts || {};
  const routing = o.routing || loadRouting(o.root);
  const map = o.map !== undefined ? o.map : readJson(path.join(o.root || DEFAULT_ROOT, ...MODEL_MAP_REL)).data;
  const entry = map && map.agents && map.agents[agent];
  const route = routing.agentDefaults[agent] || 'build';
  const rv = routing.routes[route] || routeValues(null, route);
  if (entry && typeof entry.claudeTier === 'string') {
    return { agent, model: entry.claudeTier, effort: typeof entry.claudeEffort === 'string' ? entry.claudeEffort : rv.effort, route, source: 'agent-model-map' };
  }
  return { agent, model: rv.model, effort: rv.effort, route, source: routing.agentDefaults[agent] ? 'route-default' : 'unknown-agent->build' };
}

/** settingsAntiPatterns(root) -> [{file, key, detail}]. The project settings must never flatten per-agent
 *  routing: env CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_CODE_SUBAGENT_MODEL, or modelSettings.*.effortLevel. */
function settingsAntiPatterns(root) {
  const out = [];
  for (const rel of ['settings.json', 'settings.local.json']) {
    const r = readJson(path.join(root, '.claude', rel));
    if (!r.data || typeof r.data !== 'object') continue; // absent or unparseable: bypass-mode already reports an unparseable file
    const env = r.data.env && typeof r.data.env === 'object' ? r.data.env : {};
    for (const k of FORBIDDEN_ENV) {
      if (Object.prototype.hasOwnProperty.call(env, k)) out.push({ file: '.claude/' + rel, key: 'env.' + k, detail: 'env.' + k + ' overrides every per-agent ' + (k.endsWith('MODEL') ? 'model' : 'effort') + ' — remove it' });
    }
    const ms = r.data.modelSettings;
    if (ms && typeof ms === 'object') {
      for (const [m, v] of Object.entries(ms)) {
        if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'effortLevel')) out.push({ file: '.claude/' + rel, key: 'modelSettings.' + m + '.effortLevel', detail: 'a per-model effort override fights per-agent effort — remove it' });
      }
    }
  }
  return out;
}

/** routingCheck(root) -> {ok, applicable, checked, violations:[{kind, agent?, detail}], notes, routes}.
 *  Applicable when the project has FORGE_MODEL_ROUTING.json or agent-model-map.json (a project without
 *  Forge agents has nothing to route). Once applicable, every rule below is a hard violation. */
function routingCheck(root) {
  root = path.resolve(root || DEFAULT_ROOT);
  const routingFile = readJson(path.join(root, ...ROUTING_REL));
  const mapFile = readJson(path.join(root, ...MODEL_MAP_REL));
  if (!routingFile.exists && !mapFile.exists) {
    return { ok: true, applicable: false, checked: 0, violations: [], notes: [], reason: 'no .claude/FORGE_MODEL_ROUTING.json and no agent-model-map.json — no Forge model routing to check' };
  }
  const violations = [];
  const notes = [];
  const v = (kind, detail, agent) => violations.push(Object.assign({ kind, detail }, agent ? { agent } : {}));
  const policyFile = readJson(path.join(root, ...TOOL_POLICY_REL));

  // 1. the routes table
  const data = routingFile.data && typeof routingFile.data === 'object' && !Array.isArray(routingFile.data) ? routingFile.data : null;
  const routes = data && data.routes && typeof data.routes === 'object' && !Array.isArray(data.routes) ? data.routes : null;
  if (!routingFile.exists) v('routing-file-missing', '.claude/FORGE_MODEL_ROUTING.json is missing');
  else if (routingFile.error) v('routing-file-unreadable', '.claude/FORGE_MODEL_ROUTING.json ' + routingFile.error);
  else if (!routes) v('routes-missing', 'FORGE_MODEL_ROUTING.json has no "routes" table');
  if (routes) {
    for (const name of REQUIRED_ROUTES) {
      const r = hasOwn(routes, name) ? routes[name] : null;
      if (!r || typeof r !== 'object') { v('route-missing', 'route "' + name + '" is missing from the routes table'); continue; }
      if (!VALID_MODELS.has(r.model) || r.model === 'inherit') v('route-bad-model', 'route "' + name + '" model "' + r.model + '" is not sonnet/opus/haiku/fable');
      if (!VALID_EFFORTS.has(r.effort)) v('route-bad-effort', 'route "' + name + '" effort "' + r.effort + '" is not low/medium/high/xhigh/max');
      if (r.model === 'haiku') v('route-haiku', 'route "' + name + '" uses haiku — no GOAT route uses haiku');
      if (name !== 'escalate' && r.model === 'fable') v('fable-outside-escalate', 'route "' + name + '" uses fable — fable is only the escalate step');
      // Codex rev-goat-5b8c97d-1 F5: the canonical table is pinned to the GOAT spec; a route that is
      // internally valid but not the spec value (deep on sonnet/low) used to pass.
      const spec = SPEC_ROUTES[name];
      if (r.model !== spec.model || r.effort !== spec.effort) v('route-spec-drift', 'route "' + name + '" is ' + r.model + '/' + r.effort + ' but the GOAT spec pins it to ' + spec.model + '/' + spec.effort);
    }
    if (routes.escalate && routes.escalate.model !== 'fable') v('escalate-not-fable', 'route "escalate" must be fable (got "' + routes.escalate.model + '")');
  }
  // 1b. session.lead — the router (Codex rev-goat-5b8c97d-1 F4, 2026-10-06: never validated, so {fable, turbo} passed
  //     although loadRouting() hands it to every consumer, Paperclip included). The Lead is sonnet/medium.
  if (data) {
    const lead = data.session && typeof data.session === 'object' ? data.session.lead : undefined;
    if (!lead || typeof lead !== 'object' || Array.isArray(lead)) v('lead-missing', 'FORGE_MODEL_ROUTING.json has no session.lead (the router: ' + SPEC_ROUTES.router.model + '/' + SPEC_ROUTES.router.effort + ')');
    else {
      if (lead.model !== SPEC_ROUTES.router.model) v('lead-bad-model', 'session.lead model "' + lead.model + '" is not ' + SPEC_ROUTES.router.model + ' — the Lead is the GOAT router (never opus/fable/haiku)');
      if (!VALID_EFFORTS.has(lead.effort)) v('lead-bad-effort', 'session.lead effort "' + lead.effort + '" is not low/medium/high/xhigh/max');
      else if (lead.effort !== SPEC_ROUTES.router.effort) v('lead-spec-drift', 'session.lead effort "' + lead.effort + '" but the GOAT spec pins the router to ' + SPEC_ROUTES.router.effort);
    }
  }
  // 1c. agentDefaults must exist: without it loadRouting() silently substitutes SPEC_AGENT_DEFAULTS, so the
  //     per-agent route checks below would validate nothing while the runtime still routes.
  const agentDefaultsRaw = data ? data.agentDefaults : undefined;
  const agentDefaultsOk = !!agentDefaultsRaw && typeof agentDefaultsRaw === 'object' && !Array.isArray(agentDefaultsRaw);
  if (data && !agentDefaultsOk) v('agent-defaults-missing', 'FORGE_MODEL_ROUTING.json has no "agentDefaults" object — every agent needs its default route declared');
  const agentDefaults = agentDefaultsOk ? agentDefaultsRaw : {};

  // 2. per agent: frontmatter == agent-model-map == agent-tool-policy
  if (!mapFile.exists) v('model-map-missing', '.claude/config/agents/agent-model-map.json is missing');
  else if (mapFile.error) v('model-map-unreadable', 'agent-model-map.json ' + mapFile.error);
  if (!policyFile.data || !policyFile.data.agents) v('tool-policy-missing', 'agent-tool-policy.json missing or unparseable — cannot list the agents to check');
  const mapAgents = mapFile.data && mapFile.data.agents && typeof mapFile.data.agents === 'object' ? mapFile.data.agents : {};
  const policyAgents = policyFile.data && policyFile.data.agents && typeof policyFile.data.agents === 'object' ? policyFile.data.agents : {};
  let checked = 0;
  for (const agent of Object.keys(policyAgents)) {
    checked++;
    let fm = null;
    try { fm = frontmatter(fs.readFileSync(path.join(root, '.claude', 'agents', agent + '.md'), 'utf8')); } catch { fm = null; }
    if (!fm) { v('agent-file-missing', '.claude/agents/' + agent + '.md missing or without frontmatter', agent); continue; }
    const fmModel = fm.model || null;
    const fmEffort = fm.effort || null;
    const entry = mapAgents[agent];
    const tier = entry && typeof entry.claudeTier === 'string' ? entry.claudeTier : null;
    const cEffort = entry && typeof entry.claudeEffort === 'string' ? entry.claudeEffort : null;
    const polModel = typeof policyAgents[agent].model === 'string' ? policyAgents[agent].model : null;
    if (!entry && mapFile.data) v('model-map-entry-missing', 'agent-model-map.json has no entry for ' + agent, agent);
    if (!fmEffort) v('effort-missing', agent + '.md has no effort: line', agent);
    if (fmModel && !VALID_MODELS.has(fmModel)) v('bad-model', agent + '.md model "' + fmModel + '" is not a model alias (sonnet/opus/haiku/fable/inherit)', agent);
    if (fmEffort && !VALID_EFFORTS.has(fmEffort) && !/^\d+$/.test(fmEffort)) v('bad-effort', agent + '.md effort "' + fmEffort + '" is not low/medium/high/xhigh/max', agent);
    if (entry && fmModel !== tier) v('model-drift', agent + ': frontmatter model "' + fmModel + '" != agent-model-map claudeTier "' + tier + '"', agent);
    if (fmModel !== polModel) v('model-drift', agent + ': frontmatter model "' + fmModel + '" != agent-tool-policy model "' + polModel + '"', agent);
    if (entry && fmEffort !== cEffort) v('effort-drift', agent + ': frontmatter effort "' + fmEffort + '" != agent-model-map claudeEffort "' + cEffort + '"', agent);
    for (const m of new Set([fmModel, tier, polModel])) {
      if (m === 'haiku') v('default-haiku', agent + ' defaults to haiku — no GOAT route uses haiku', agent);
      if (m === 'fable') v('default-fable', agent + ' defaults to fable — fable is only the escalate step after a failed check', agent);
    }
    const defRoute = hasOwn(agentDefaults, agent) ? agentDefaults[agent] : undefined;
    if (agentDefaultsOk && defRoute === undefined) v('agent-default-missing', agent + ' has no agentDefaults entry in FORGE_MODEL_ROUTING.json (the runtime would silently use the spec fallback)', agent);
    if (defRoute !== undefined && routes && REQUIRED_ROUTES.includes(defRoute) && routes[defRoute] && typeof routes[defRoute] === 'object') {
      const rv = routes[defRoute];
      if (rv.model !== fmModel || rv.effort !== fmEffort) v('default-route-drift', agent + ' default route "' + defRoute + '" is ' + rv.model + '/' + rv.effort + ' but the agent runs ' + fmModel + '/' + fmEffort, agent);
    } else if (defRoute !== undefined && routes) {
      v('default-route-unknown', agent + ' default route "' + defRoute + '" is not a route in the routes table (' + REQUIRED_ROUTES.join('/') + ')', agent);
    }
  }
  // agentDefaults naming an agent that does not exist (a typo or a removed agent) is drift too.
  if (agentDefaultsOk && policyFile.data && policyFile.data.agents) {
    for (const name of Object.keys(agentDefaults)) {
      if (name.startsWith('_')) continue; // _note and other documentation keys
      if (!hasOwn(policyAgents, name)) v('agent-default-unknown-agent', 'agentDefaults names "' + name + '" but agent-tool-policy.json has no such agent');
    }
  }

  // 3. settings anti-patterns (project settings only — never the user's global settings)
  for (const s of settingsAntiPatterns(root)) v('settings-anti-pattern', s.file + ': ' + s.detail);
  for (const k of FORBIDDEN_ENV) {
    if (process.env[k] !== undefined) notes.push(k + ' is set in this process environment — it overrides every per-agent ' + (k.endsWith('MODEL') ? 'model' : 'effort') + '; unset it (not a project-file finding)');
  }
  return { ok: violations.length === 0, applicable: true, checked, violations, notes, routes: routes || null };
}

module.exports = {
  cascade, ruleOfTwo, mcpAllowlistCheck, toolPolicyCheck, HARD_OPUS,
  routeFor, escalate, routingCheck, loadRouting, agentRoute, settingsAntiPatterns,
  SPEC_ROUTES, SPEC_AGENT_DEFAULTS, REQUIRED_ROUTES, VALID_MODELS, VALID_EFFORTS, EFFORT_LADDER, HARD_ROUTE, QUICK_ROUTE,
};

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }
function cli(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const root = argValue(args, '--root') || DEFAULT_ROOT;
  if (cmd === 'route') {
    const task = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--risk' && all[i - 1] !== '--root').join(' ');
    console.log(JSON.stringify(routeFor({ task, risk: argValue(args, '--risk'), routes: loadRouting(root).routes }), null, 2));
    return 0;
  }
  if (cmd === 'escalate') {
    const r = escalate({ route: args[1], failure: args[2], escalated: args.includes('--escalated'), workflow: args.includes('--workflow'), routes: loadRouting(root).routes });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 2;
  }
  if (cmd === 'check') {
    const r = routingCheck(root);
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log('GOAT model routing check — ' + (r.applicable === false ? 'n/a (' + r.reason + ')' : (r.ok ? 'OK' : 'RED') + ' · ' + r.checked + ' agent(s) checked'));
      for (const x of r.violations) console.log('  ✗ ' + x.kind + ': ' + x.detail);
      for (const n of r.notes || []) console.log('  ℹ ' + n);
    }
    return r.ok ? 0 : 1;
  }
  if (cmd && cmd !== '--help' && cmd !== '-h') { console.error('unknown command "' + cmd + '" — use route | escalate | check'); return 2; }
  console.log('forge-policy — route / escalate / check (GOAT model routing) + cascade / ruleOfTwo / mcpAllowlistCheck / toolPolicyCheck.');
  console.log('example route("fix a typo in the README"):', JSON.stringify(routeFor({ task: 'fix a typo in the README' })));
  console.log('example escalate(build, context):', JSON.stringify(escalate({ route: 'build', failure: 'context' })));
  console.log('example ruleOfTwo(all three):', JSON.stringify(ruleOfTwo({ ingestUntrusted: true, secrets: true, externalWrite: true })));
  return 0;
}

if (require.main === module) process.exit(cli(process.argv));
