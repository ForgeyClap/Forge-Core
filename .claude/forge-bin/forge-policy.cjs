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
 *   • agentsGeneratedCheck() — WP 1.5, ENFORCED through forge-doctor `agents`: the agent .md frontmatter
 *                          is the single source of truth; .claude/config/agents/agents.generated.json is generated
 *                          from it (buildAgentsGenerated(), written by `forge-registry-gen.cjs agents --write`) and
 *                          must not drift; frontmatter rules (color, maxTurns band per class, isolation, skills that
 *                          exist and can be preloaded, no unknown field) and the legacy mirrors are checked too.
 * Everything is pure except loadRouting(), agentRoute(), routingCheck(), buildAgentsGenerated() and
 * agentsGeneratedCheck(), which only READ files under the project's .claude/ folder. Nothing in this file ever writes.
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
// WP 2.1: the default project root comes from forge-paths scriptRoot when it is there (optional require): an installed
// copy keeps exactly the old own-folder answer; a plugin copy finds the project from CLAUDE_PROJECT_DIR / the cwd and
// never the plugin's parent folder (null = no project found, the CLI then asks for --root).
let forgePaths = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.scriptRoot === 'function') forgePaths = fp; } catch { forgePaths = null; }
function defaultRoot() {
  if (!forgePaths) return path.resolve(__dirname, '..', '..'); // forge-paths fallback
  try { return forgePaths.scriptRoot(__dirname); } catch { return null; }
}
const DEFAULT_ROOT = defaultRoot();

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

// ---------------------------------------------------------------------------------------------------
// Agent frontmatter = the single source of truth for every per-agent fact (WP 1.5).
// .claude/config/agents/agents.generated.json is GENERATED from .claude/agents/*.md by
// `node .claude/forge-bin/forge-registry-gen.cjs agents --write`. agentsGeneratedCheck() (forge-doctor `agents`
// and `forge-registry-gen.cjs agents --check`) fails on drift between the two, on frontmatter that breaks the
// rules below, and on a legacy mirror (agent-tool-policy / agent-registry / agent-skill-map) that disagrees.
// Field facts: code.claude.com/docs/en/sub-agents and code.claude.com/docs/en/worktrees, both read 2026-10-24.
// ---------------------------------------------------------------------------------------------------
const AGENTS_GENERATED_REL = ['.claude', 'config', 'agents', 'agents.generated.json'];
const AGENTS_GENERATED_SCHEMA = 'forge-agents-generated/v1';
const DEV_TREE_MARKER_REL = ['.claude', 'config', 'forge-dev-tree.json'];
const REGISTRY_REL = ['.claude', 'config', 'agents', 'agent-registry.json'];
const SKILL_MAP_REL = ['.claude', 'config', 'agents', 'agent-skill-map.json'];
// The 12 permanent Bosses: the same fixed set as forge-doctor BOSS_NAMES and agent-registry.json "agents".
const PERMANENT_BOSSES = Object.freeze(['boss', 'head-chef', 'review-boss', 'test-boss', 'ui-boss', 'seo-boss', 'security-boss', 'skill-boss', 'search-boss', 'build-boss', 'integration-boss', 'docs-boss']);
// Claude Code ignores an unknown frontmatter field SILENTLY, so a typo (`maxturns`) would change nothing without
// this list. forge_class is Forge's own field (forge-adopt-post-sync reads it for project-own agents).
const AGENT_FIELDS = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'autoCompactWindow', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd', 'effort', 'isolation', 'color', 'initialPrompt', 'experimental', 'forge_class']);
const AGENT_COLORS = Object.freeze(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']);
const SKILL_PRELOAD_CAP = 32;
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const MAX_TURNS_BANDS = Object.freeze({
  'read-only-audit': Object.freeze({ min: 40, max: 120, why: 'reads and reports; review-boss and security-boss read a whole diff against the goal, so they sit near the top of the band' }),
  'exec-reviewer': Object.freeze({ min: 20, max: 100, why: 're-runs commands and reports; scribe and codex-reviewer only drive one CLI' }),
  'write-no-exec': Object.freeze({ min: 40, max: 120, why: 'plans, work packages and docs; no build loop' }),
  'full-build': Object.freeze({ min: 100, max: 250, why: 'edit, build, test and fix loops; ui-boss also runs screenshot rounds' }),
});
const ROUTE_PREFERENCE = ['quick', 'build', 'deep', 'verifier', 'triage'];
// Written into the generated file, so a reader of agents.generated.json sees WHY each value is what it is.
const AGENTS_POLICY_DOC = Object.freeze({
  derived: 'bossOrSpecialist: boss for the 12 permanent Bosses, else specialist. roleClass: from the EFFECTIVE tools (tools minus disallowedTools, plus Read/Write/Edit when memory is set; the docs do not say whether disallowedTools removes those memory grants, so they are assumed to survive): write (Write/Edit/NotebookEdit) and shell (Bash/PowerShell) = full-build, write only = write-no-exec, shell only = exec-reviewer, neither = read-only-audit, no tools line = every tool = full-build. route: the GOAT route whose spec model/effort equals the frontmatter model/effort (sonnet/low is triage for head-chef, quick otherwise).',
  maxTurns: { why: 'A runaway guard sized well above normal use, never a work budget. At the limit Claude Code returns the output marked partial (v2.1.246+) and the Lead can resume the agent. Reviewers sit lower than builders: they read and report, builders edit, build and fix.', bands: MAX_TURNS_BANDS },
  color: { allowed: AGENT_COLORS, families: 'purple = mission owner; yellow = coordination and bookkeeping; blue = code builders; pink = interface; orange = external systems and payments; cyan = data, research and docs; green = verification and tests; red = review and security gates' },
  skills: 'Preloaded at startup: the full skill content is injected, first 32 distinct names, a disable-model-invocation skill cannot be preloaded. Taken from agent-skill-map.json, keeping only skills on disk under .claude/skills that are not disable-model-invocation and carry no situational invocation note (grilling, resolving-merge-conflicts, claude-md-improver stay out). No shipped agent has the Skill tool, so a skill that is not preloaded reaches an agent only through its dispatch prompt.',
  disallowedTools: 'Added only where the tools allowlist does not already exclude a tool the class forbids. Every shipped agent has an explicit tools allowlist and no read-only agent carries memory, so none needs it today; the check fails if a forbidden tool becomes effective.',
  isolation: 'Not set on any agent (2026-10-24). Frontmatter isolation applies to EVERY dispatch, but forge-worktrees keeps single-agent sequential work in the main tree; a subagent worktree branches from the remote default branch unless the setting worktree.baseRef is "head", and never carries uncommitted work; it holds only tracked files (no node_modules); and log-event.cjs run from a worktree writes into that worktree\'s forge-runs. Use the Agent tool isolation parameter on parallel dispatches until these are resolved. When set, only "worktree" on a full-build agent is valid.',
});
const AGENTS_GENERATED_DOC = 'GENERATED from the .claude/agents/*.md frontmatter (the single source of truth for every per-agent fact) by `node .claude/forge-bin/forge-registry-gen.cjs agents --write`. Do not hand-edit: change the agent frontmatter, then regenerate. `forge-registry-gen.cjs agents --check` and forge-doctor `agents` fail on drift. The legacy mirrors agent-registry.json, agent-model-map.json, agent-skill-map.json and agent-tool-policy.json stay until a later wave removes them and are cross-checked against this file.';

function unquoteYaml(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) return t.slice(1, -1);
  return t;
}
/** parseAgentFrontmatter(text) -> {fields, keys, problems} | null. Reads the YAML subset agent files use: `key: value`,
 *  quoted values, inline lists `[a, b]`, block lists (`key:` followed by `  - item` lines) and nested blocks (kept as
 *  {nested: true}). Never throws; null when the text has no frontmatter. */
function parseAgentFrontmatter(text) {
  const m = String(text == null ? '' : text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const fields = {}; const keys = []; const problems = [];
  let open = null; // the last key with an empty value: a block list or a nested block may follow it
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && open && Array.isArray(fields[open])) { fields[open].push(unquoteYaml(item[1])); continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1]; const raw = kv[2].trim();
      if (keys.includes(key)) problems.push('duplicate key "' + key + '"'); else keys.push(key);
      if (raw === '') { fields[key] = []; open = key; continue; }
      open = null;
      fields[key] = /^\[.*\]$/.test(raw) ? raw.slice(1, -1).split(',').map(unquoteYaml).filter(Boolean) : unquoteYaml(raw);
      continue;
    }
    if (/^\s/.test(line)) { if (open && Array.isArray(fields[open]) && fields[open].length === 0) fields[open] = { nested: true }; continue; }
    problems.push('line not understood: ' + line.trim().slice(0, 60));
  }
  return { fields, keys, problems };
}
function toList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
const baseTool = (t) => String(t).replace(/\(.*$/, '').trim(); // `Bash(git push *)` is the Bash tool
/** effectiveTools(fields) -> {tools, inheritsAll}. The tools line minus disallowedTools (a specifier entry removes the
 *  whole tool), then Read/Write/Edit when `memory` is set (Claude Code enables them for the memory files; whether
 *  disallowedTools removes them is not documented, so the worst case is assumed: they survive). No tools line = '*'. */
function effectiveTools(fields) {
  const f = fields || {};
  const inheritsAll = f.tools === undefined;
  const denied = new Set(toList(f.disallowedTools).map(baseTool));
  const tools = (inheritsAll ? ['*'] : toList(f.tools)).filter((t) => !denied.has(baseTool(t)));
  if (f.memory && !tools.includes('*')) for (const t of ['Read', 'Write', 'Edit']) if (!tools.includes(t)) tools.push(t);
  return { tools, inheritsAll };
}
function roleClassOf(tools) {
  const base = tools.map(baseTool);
  const all = base.includes('*');
  const w = all || base.some((t) => WRITE_TOOLS.includes(t));
  const x = all || base.some((t) => SHELL_TOOLS.includes(t));
  return w && x ? 'full-build' : w ? 'write-no-exec' : x ? 'exec-reviewer' : 'read-only-audit';
}
function agentRouteOf(name, model, effort) {
  const hits = ROUTE_PREFERENCE.filter((r) => SPEC_ROUTES[r].model === model && SPEC_ROUTES[r].effort === effort);
  if (!hits.length) return null;
  return hasOwn(SPEC_AGENT_DEFAULTS, name) && hits.includes(SPEC_AGENT_DEFAULTS[name]) ? SPEC_AGENT_DEFAULTS[name] : hits[0];
}
/** agentRecord(name, fields) -> the generated entry for one agent (fixed key order; null = not set). */
function agentRecord(name, fields) {
  const f = fields || {};
  const eff = effectiveTools(f);
  const str = (k) => (typeof f[k] === 'string' && f[k] !== '' ? f[k] : null);
  const turns = typeof f.maxTurns === 'string' && /^\d+$/.test(f.maxTurns) ? Number(f.maxTurns) : str('maxTurns');
  return {
    name, file: '.claude/agents/' + name + '.md',
    bossOrSpecialist: PERMANENT_BOSSES.includes(name) ? 'boss' : 'specialist',
    roleClass: roleClassOf(eff.tools), route: agentRouteOf(name, str('model'), str('effort')),
    model: str('model'), effort: str('effort'),
    tools: eff.inheritsAll ? null : toList(f.tools), disallowedTools: toList(f.disallowedTools),
    maxTurns: turns, isolation: str('isolation'),
    skills: Array.isArray(f.skills) ? f.skills.slice() : toList(f.skills),
    memory: str('memory'), color: str('color'),
  };
}
function isDevTree(root) { const j = readJson(path.join(path.resolve(root || DEFAULT_ROOT), ...DEV_TREE_MARKER_REL)); return !!(j.data && j.data.dev_tree === true); }

/** buildAgentsGenerated(root) -> {data, parsed, problems}. data = the agents.generated.json object, agents sorted by
 *  file name, no timestamps (the same frontmatter always gives the same bytes). Read-only. */
function buildAgentsGenerated(root) {
  const dir = path.join(path.resolve(root || DEFAULT_ROOT), '.claude', 'agents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(); } catch { names = []; }
  const agents = []; const parsed = {}; const problems = [];
  for (const name of names) {
    let fm = null;
    try { fm = parseAgentFrontmatter(fs.readFileSync(path.join(dir, name + '.md'), 'utf8')); } catch { fm = null; }
    if (!fm) { problems.push({ kind: 'frontmatter-unparseable', agent: name, detail: '.claude/agents/' + name + '.md has no readable frontmatter' }); continue; }
    parsed[name] = fm;
    agents.push(agentRecord(name, fm.fields));
  }
  const bosses = agents.filter((a) => a.bossOrSpecialist === 'boss').length;
  const data = { schema: AGENTS_GENERATED_SCHEMA, _doc: AGENTS_GENERATED_DOC, policy: AGENTS_POLICY_DOC, counts: { agents: agents.length, bosses, specialists: agents.length - bosses }, agents };
  return { data: JSON.parse(JSON.stringify(data)), parsed, problems };
}

function skillState(root, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) return { exists: false, dmi: false };
  let text;
  try { text = fs.readFileSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8'); } catch { return { exists: false, dmi: false }; }
  const fm = parseAgentFrontmatter(text);
  return { exists: true, dmi: !!fm && String(fm.fields['disable-model-invocation']).toLowerCase() === 'true' };
}
/** The frontmatter rules for one shipped agent. v(kind, detail, agent) records a violation. */
function agentFrontmatterRules(root, name, fm, rec, v) {
  const f = fm.fields;
  for (const p of fm.problems) v('frontmatter-problem', name + '.md: ' + p, name);
  if (f.name !== name) v('name-mismatch', name + '.md declares name "' + f.name + '"', name);
  for (const k of fm.keys) if (!AGENT_FIELDS.has(k)) v('unknown-field', name + '.md has "' + k + '", which is not a subagent field — Claude Code ignores it silently', name);
  if (rec.color === null) v('color-missing', name + '.md has no color', name);
  else if (!AGENT_COLORS.includes(rec.color)) v('bad-color', name + '.md color "' + rec.color + '" is not one of ' + AGENT_COLORS.join('/'), name);
  const band = MAX_TURNS_BANDS[rec.roleClass];
  if (rec.maxTurns === null) v('maxturns-missing', name + '.md has no maxTurns', name);
  else if (typeof rec.maxTurns !== 'number' || rec.maxTurns < 1) v('maxturns-invalid', name + '.md maxTurns "' + rec.maxTurns + '" is not a positive whole number', name);
  else if (band && (rec.maxTurns < band.min || rec.maxTurns > band.max)) v('maxturns-out-of-band', name + '.md maxTurns ' + rec.maxTurns + ' is outside the ' + rec.roleClass + ' band ' + band.min + '-' + band.max, name);
  if (rec.isolation !== null && rec.isolation !== 'worktree') v('isolation-invalid', name + '.md isolation "' + rec.isolation + '" (only "worktree" exists)', name);
  else if (rec.isolation === 'worktree' && rec.roleClass !== 'full-build') v('isolation-not-allowed', name + '.md is ' + rec.roleClass + '; isolation: worktree is only for writing builders (full-build)', name);
  if (rec.route === null) v('route-unknown', name + '.md runs ' + rec.model + '/' + rec.effort + ', which is no GOAT route', name);
  if (f.skills !== undefined && !Array.isArray(f.skills)) v('skills-not-a-list', name + '.md skills must be a YAML list (`skills:` then `  - name` lines)', name);
  if (rec.skills.length > SKILL_PRELOAD_CAP) v('skills-over-cap', name + '.md preloads ' + rec.skills.length + ' skills; Claude Code preloads only the first ' + SKILL_PRELOAD_CAP, name);
  const seen = new Set();
  for (const s of rec.skills) {
    if (seen.has(s)) { v('skill-duplicate', name + '.md lists skill "' + s + '" twice', name); continue; }
    seen.add(s);
    const st = skillState(root, s);
    if (!st.exists) v('skill-missing', name + '.md preloads "' + s + '", but .claude/skills/' + s + '/SKILL.md does not exist (a fresh install must resolve it)', name);
    else if (st.dmi) v('skill-not-preloadable', name + '.md preloads "' + s + '", which sets disable-model-invocation: true — Claude Code skips it', name);
  }
}
/** The legacy mirrors must agree with the frontmatter until a later wave deletes them. An absent mirror is a note. */
function legacyCrossCheck(root, recs, v, notes) {
  const pol = readJson(path.join(root, ...TOOL_POLICY_REL)).data;
  const reg = readJson(path.join(root, ...REGISTRY_REL)).data;
  const sm = readJson(path.join(root, ...SKILL_MAP_REL)).data;
  if (!pol || !pol.agents) notes.push('legacy agent-tool-policy.json absent or unreadable: class cross-check skipped');
  if (!reg) notes.push('legacy agent-registry.json absent or unreadable: registry cross-check skipped');
  if (!sm || !sm.agents) notes.push('legacy agent-skill-map.json absent or unreadable: skill cross-check skipped');
  for (const rec of recs) {
    const pe = pol && pol.agents && hasOwn(pol.agents, rec.name) ? pol.agents[rec.name] : null;
    if (pe) {
      if (pe.class !== rec.roleClass) v('class-drift', rec.name + ': the frontmatter tools make it ' + rec.roleClass + ', agent-tool-policy.json says ' + pe.class, rec.name);
      const cls = pol.classes && hasOwn(pol.classes, pe.class) ? pol.classes[pe.class] : null;
      const eff = effectiveTools({ tools: rec.tools === null ? undefined : rec.tools, disallowedTools: rec.disallowedTools, memory: rec.memory }).tools.map(baseTool);
      const bad = (cls && Array.isArray(cls.forbidden) ? cls.forbidden : []).filter((t) => eff.includes(t) || eff.includes('*'));
      if (bad.length) v('class-forbidden-tool', rec.name + ' (' + pe.class + ') effectively holds ' + bad.join(', ') + ', which its class forbids (tools line, inherited tools or memory grant)', rec.name);
    }
    if (reg) {
      const inBoss = !!reg.agents && hasOwn(reg.agents, rec.name);
      const inSpec = !!reg.specialistAgents && hasOwn(reg.specialistAgents, rec.name);
      const placedRight = rec.bossOrSpecialist === 'boss' ? inBoss && !inSpec : inSpec && !inBoss;
      if (!placedRight) v('registry-drift', rec.name + ' is a ' + rec.bossOrSpecialist + ' but agent-registry.json lists it under ' + (inBoss && inSpec ? 'both maps' : inBoss ? '"agents"' : inSpec ? '"specialistAgents"' : 'neither map'), rec.name);
      const entry = inBoss ? reg.agents[rec.name] : inSpec ? reg.specialistAgents[rec.name] : null;
      if (entry && entry.agentFile !== rec.file) v('registry-drift', rec.name + ': agent-registry.json agentFile "' + entry.agentFile + '" != ' + rec.file, rec.name);
    }
    if (sm && sm.agents) {
      const list = Array.isArray(sm.agents[rec.name]) ? sm.agents[rec.name] : [];
      for (const s of rec.skills) if (!list.includes(s)) v('skill-not-in-map', rec.name + ' preloads "' + s + '", which agent-skill-map.json does not list for it', rec.name);
    }
  }
}
/** Compares the generated file with a fresh generation. Returns the set of agent names the file lists. */
function generatedDrift(fileData, fresh, devTree, v, notes) {
  const freshBy = new Map(fresh.agents.map((a) => [a.name, a]));
  const listed = new Set();
  for (const a of fileData.agents) {
    if (!a || typeof a.name !== 'string') { v('generated-schema', 'an entry in agents.generated.json has no name'); continue; }
    listed.add(a.name);
    const f = freshBy.get(a.name);
    if (!f) { v('drift-agent-removed', 'agents.generated.json lists ' + a.name + ', but .claude/agents/' + a.name + '.md is missing or unreadable', a.name); continue; }
    for (const k of new Set(Object.keys(f).concat(Object.keys(a)))) {
      if (JSON.stringify(a[k]) !== JSON.stringify(f[k])) v('drift-field', a.name + '.' + k + ': the generated file has ' + JSON.stringify(a[k]) + ', the frontmatter gives ' + JSON.stringify(f[k]), a.name);
    }
  }
  for (const f of fresh.agents) {
    if (listed.has(f.name)) continue;
    if (devTree) v('drift-agent-added', f.name + '.md exists but agents.generated.json does not list it', f.name);
    else notes.push('project-own agent ' + f.name + ' is not in agents.generated.json (allowed outside the development tree)');
  }
  if (JSON.stringify(fileData.policy) !== JSON.stringify(fresh.policy)) v('drift-policy', 'the policy block of agents.generated.json differs from the generator');
  if (devTree && JSON.stringify(fileData.schema) + JSON.stringify(fileData._doc) + JSON.stringify(fileData.counts) !== JSON.stringify(fresh.schema) + JSON.stringify(fresh._doc) + JSON.stringify(fresh.counts)) v('drift-header', 'schema, _doc or counts of agents.generated.json differ from the generator');
  return listed;
}
/** agentsGeneratedCheck(root) -> {ok, applicable, devTree, checked, violations:[{kind, agent?, detail}], notes}.
 *  In the development tree (.claude/config/forge-dev-tree.json) a present generated file must list exactly the agent
 *  files, and the file is REQUIRED once that tree defines the Forge agent set (FORGE_MODEL_ROUTING.json or
 *  agent-registry.json present — the same applicability signal as routingCheck; a bare fixture that only carries the
 *  marker is n/a). Elsewhere a missing file is n/a and project-own agents beyond the shipped list are only noted. */
function agentsGeneratedCheck(root) {
  root = path.resolve(root || DEFAULT_ROOT);
  const devTree = isDevTree(root);
  const file = readJson(path.join(root, ...AGENTS_GENERATED_REL));
  const violations = []; const notes = [];
  const v = (kind, detail, agent) => violations.push(Object.assign({ kind, detail }, agent ? { agent } : {}));
  const definesAgents = fs.existsSync(path.join(root, ...ROUTING_REL)) || fs.existsSync(path.join(root, ...REGISTRY_REL));
  if (!file.exists && !(devTree && definesAgents)) return { ok: true, applicable: false, devTree, checked: 0, violations, notes, reason: 'no .claude/config/agents/agents.generated.json here (' + (devTree ? 'a development-tree marker without FORGE_MODEL_ROUTING.json or agent-registry.json' : 'not the development tree') + '): nothing to compare' };
  const fileOk = file.exists && !file.error && file.data && file.data.schema === AGENTS_GENERATED_SCHEMA && Array.isArray(file.data.agents);
  if (!file.exists) v('generated-missing', '.claude/config/agents/agents.generated.json is missing: run `node .claude/forge-bin/forge-registry-gen.cjs agents --write`');
  else if (file.error) v('generated-unreadable', 'agents.generated.json ' + file.error);
  else if (!fileOk) v('generated-schema', 'agents.generated.json has no schema "' + AGENTS_GENERATED_SCHEMA + '" or no "agents" list');
  const fresh = buildAgentsGenerated(root);
  for (const p of fresh.problems) v(p.kind, p.detail, p.agent);
  const listed = fileOk ? generatedDrift(file.data, fresh.data, devTree, v, notes) : null;
  // the shipped set: every agent in the dev tree; elsewhere the agents the file lists (the 12 Bosses if it is unreadable)
  const recs = fresh.data.agents.filter((a) => devTree || (listed ? listed.has(a.name) : PERMANENT_BOSSES.includes(a.name)));
  for (const rec of recs) agentFrontmatterRules(root, rec.name, fresh.parsed[rec.name], rec, v);
  legacyCrossCheck(root, recs, v, notes);
  return { ok: violations.length === 0, applicable: true, devTree, checked: recs.length, violations, notes };
}

module.exports = {
  cascade, ruleOfTwo, mcpAllowlistCheck, toolPolicyCheck, HARD_OPUS,
  routeFor, escalate, routingCheck, loadRouting, agentRoute, settingsAntiPatterns,
  SPEC_ROUTES, SPEC_AGENT_DEFAULTS, REQUIRED_ROUTES, VALID_MODELS, VALID_EFFORTS, EFFORT_LADDER, HARD_ROUTE, QUICK_ROUTE,
  // WP 1.5 — agent frontmatter as the single source of truth + the generated agents file
  parseAgentFrontmatter, effectiveTools, roleClassOf, agentRouteOf, agentRecord, buildAgentsGenerated, agentsGeneratedCheck, isDevTree,
  AGENTS_GENERATED_REL, AGENTS_GENERATED_SCHEMA, PERMANENT_BOSSES, AGENT_FIELDS, AGENT_COLORS, SKILL_PRELOAD_CAP, MAX_TURNS_BANDS,
};

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }
function cli(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const root = argValue(args, '--root') || DEFAULT_ROOT;
  if (!root && (cmd === 'route' || cmd === 'escalate' || cmd === 'check')) { console.error('forge-policy: no project root found (no .claude, .forge or .git above the current folder) — pass --root <dir>'); return 2; }
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
