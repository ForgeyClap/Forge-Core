#!/usr/bin/env node
'use strict';
// forge-policy.test.cjs — tests cascade / ruleOfTwo / mcpAllowlistCheck / toolPolicyCheck (2026-07-11,
// toolPolicyCheck added WP2 2026-07-14 least-privilege enforcement; routeFor / escalate / routingCheck
// added 2026-10-06 for GOAT model routing).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { cascade, ruleOfTwo, mcpAllowlistCheck, toolPolicyCheck, routeFor, escalate, routingCheck, agentRoute, loadRouting } = require('./forge-policy.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge policy tests (cascade / rule-of-two / mcp allow-list)');

t('cascade: sonnet + gate fail escalates to opus (once, GOAT quick -> build)', () => { const r = cascade('sonnet', true, false); assert.ok(r.model === 'opus' && r.escalated === true && r.route === 'build' && r.effort === 'medium'); });
t('cascade: a bare opus (build route) + gate fail goes ONE step to deep, not straight to fable', () => { const r = cascade('opus', true, false); assert.ok(r.model === 'opus' && r.effort === 'xhigh' && r.escalated === true && r.route === 'deep', JSON.stringify(r)); });
t('cascade: opus on a HARD task (deep route) + gate fail escalates ONCE to fable', () => { const r = cascade('opus', true, true); assert.ok(r.model === 'fable' && r.escalated === true && r.route === 'escalate', JSON.stringify(r)); });
t('cascade: accepts a route name (build -> deep, deep -> escalate)', () => {
  assert.strictEqual(cascade('build', true, false).route, 'deep');
  assert.strictEqual(cascade('deep', true, false).route, 'escalate');
});
t('cascade: opus + gate fail on an ALREADY-escalated task does NOT double-escalate', () => { const r = cascade('opus', true, false, true); assert.ok(r.model === 'opus' && r.escalated === false); });
t('cascade: fable + gate fail never goes past escalate', () => { const r = cascade('fable', true, false); assert.ok(r.model === 'fable' && r.escalated === false); });
t('cascade: hard task (auth/migration) starts on opus (deep route) up front', () => { const r = cascade('sonnet', false, 'auth token migration'); assert.ok(r.model === 'opus' && r.route === 'deep' && r.effort === 'xhigh'); });
t('cascade: sonnet + pass stays on sonnet', () => { const r = cascade('sonnet', false, false); assert.ok(r.model === 'sonnet' && r.escalated === false); });

t('rule-of-two: all three properties -> needsSplit', () => assert.ok(ruleOfTwo({ ingestUntrusted: true, secrets: true, externalWrite: true }).needsSplit === true));
t('rule-of-two: only two -> within bounds', () => assert.ok(ruleOfTwo({ ingestUntrusted: true, externalWrite: true }).needsSplit === false));

t('mcp allow-list: unknown server flagged, not ok', () => { const r = mcpAllowlistCheck({ good: { sha256: 'a' } }, [{ name: 'evil', sha256: 'x' }]); assert.ok(r.unknown.includes('evil') && r.ok === false); });
t('mcp allow-list: drifted (rug-pulled) hash flagged', () => { const r = mcpAllowlistCheck({ good: { sha256: 'a' } }, [{ name: 'good', sha256: 'b' }]); assert.ok(r.drift.length === 1 && r.ok === false); });
t('mcp allow-list: matching pinned server is ok', () => { const r = mcpAllowlistCheck({ good: { sha256: 'a' } }, [{ name: 'good', sha256: 'a' }]); assert.ok(r.ok === true && r.allowed.includes('good')); });

console.log('');
console.log('toolPolicyCheck (WP2 least-privilege enforcement, pure unit tests)');

const BASE_POLICY = {
  classes: {
    'read-only-audit': { tools_base: ['Read', 'Grep', 'Glob'], forbidden: ['Write', 'Edit', 'Bash'] },
    'write-no-exec': { tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'], forbidden: ['Bash'] },
    'full-build': { tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'], forbidden: [] },
  },
  agents: {
    'review-boss': { class: 'read-only-audit', tools: ['Read', 'Grep', 'Glob'] },
    'boss': { class: 'write-no-exec', tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'] },
    'build-boss': { class: 'full-build', tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] },
  },
};

t('toolPolicyCheck: exact-matching grants -> ok=true, no violations', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === true && r.driftViolations.length === 0 && r.missingPolicy.length === 0 && r.missingAgentFile.length === 0 && r.classViolations.length === 0);
});

t('toolPolicyCheck: a read-only-audit agent gaining Bash is flagged as extra + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob', 'Bash'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  assert.ok(r.driftViolations.some((v) => v.agent === 'review-boss' && v.extra.includes('Bash')));
});

t('toolPolicyCheck: a read-only-audit agent gaining Write/Edit is flagged as extra + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob', 'Write', 'Edit'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  assert.ok(r.driftViolations.some((v) => v.agent === 'review-boss' && v.extra.includes('Write') && v.extra.includes('Edit')));
});

t('toolPolicyCheck: a write-no-exec agent gaining Bash is flagged as extra + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  assert.ok(r.driftViolations.some((v) => v.agent === 'boss' && v.extra.includes('Bash')));
});

t('toolPolicyCheck: an agent-md granting a tool the policy never lists for it is flagged as extra', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.driftViolations.some((v) => v.agent === 'build-boss' && v.extra.includes('WebFetch')));
});

t('toolPolicyCheck: an agent-md granting FEWER tools than policy is also flagged (missing, exact-match required)', () => {
  const grants = { 'review-boss': ['Read', 'Grep'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.driftViolations.some((v) => v.agent === 'review-boss' && v.missing.includes('Glob')));
});

t('toolPolicyCheck: an agent-md with no policy entry is flagged missingPolicy + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'], 'rogue-agent': ['Read'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.missingPolicy.includes('rogue-agent'));
});

t('toolPolicyCheck: a policy entry with no matching agent-md is flagged missingAgentFile + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] }; // 'boss' missing
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.missingAgentFile.includes('boss'));
});

t('toolPolicyCheck: the POLICY FILE ITSELF assigning a forbidden tool to a class is caught even when the agent-md matches it exactly (defense-in-depth vs. a stale/tampered policy)', () => {
  const badPolicy = JSON.parse(JSON.stringify(BASE_POLICY));
  badPolicy.agents['review-boss'].tools = ['Read', 'Grep', 'Glob', 'Bash']; // policy itself now grants Bash to a read-only-audit agent
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob', 'Bash'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(badPolicy, grants);
  assert.ok(r.ok === false);
  assert.ok(r.classViolations.some((v) => v.agent === 'review-boss' && v.forbidden.includes('Bash')));
});

t('toolPolicyCheck: empty/undefined policy and grants never throw (vacuously ok=true, 0 agents on both sides)', () => {
  const r1 = toolPolicyCheck(undefined, undefined);
  const r2 = toolPolicyCheck({}, {});
  assert.ok(r1.ok === true && r1.missingPolicy.length === 0 && r1.missingAgentFile.length === 0);
  assert.ok(r2.ok === true);
});

console.log('');
console.log('M7 (WP2 close-out, 2026-07-14) — exact-token comparison, not loose substring/case-insensitive match');

t('toolPolicyCheck: a merged/smuggled token ("GlobBash") hiding a forbidden tool inside an allowed-looking string is flagged as extra, AND the real "Glob" still shows as missing — proves exact-token compare, not substring matching', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'GlobBash'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  const v = r.driftViolations.find((d) => d.agent === 'review-boss');
  assert.ok(v, 'review-boss must be flagged in driftViolations');
  assert.ok(v.extra.includes('GlobBash'), 'the merged token itself must appear verbatim in extra (not silently absorbed as a match for "Glob" or "Bash")');
  assert.ok(v.missing.includes('Glob'), 'the real "Glob" tool must still show as missing — the merged token does not satisfy it');
});

t('toolPolicyCheck: a case-variant token ("read" instead of "Read") is flagged as extra, AND the real "Read" still shows as missing — proves the comparison is exact-case, not case-insensitive', () => {
  const grants = { 'review-boss': ['read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  const v = r.driftViolations.find((d) => d.agent === 'review-boss');
  assert.ok(v, 'review-boss must be flagged in driftViolations');
  assert.ok(v.extra.includes('read'), 'lowercase "read" must show as extra — must not silently satisfy "Read" via case-folding');
  assert.ok(v.missing.includes('Read'), 'the real capitalized "Read" must still show as missing');
});

console.log('');
console.log('GOAT model routing (2026-10-06) — routeFor / escalate / agentRoute');

t('routeFor: a HARD keyword (auth, migration, payment, deploy, security, architecture) -> deep (opus/xhigh)', () => {
  for (const task of ['add JWT auth to the login API', 'write the users table migration', 'refund flow for payments', 'deploy to production', 'security hardening of the gateway', 'architecture for the sync layer']) {
    const r = routeFor({ task });
    assert.strictEqual(r.route, 'deep', task + ' -> ' + r.route);
    assert.ok(r.model === 'opus' && r.effort === 'xhigh' && r.risk === 'high', JSON.stringify(r));
  }
});
t('routeFor: small/typo/docs/rename work -> quick (sonnet/low)', () => {
  for (const task of ['fix a typo in the README', 'update the docs for the CLI', 'rename a variable in utils.js', 'small wording change on the button']) {
    const r = routeFor({ task });
    assert.ok(r.route === 'quick' && r.model === 'sonnet' && r.effort === 'low', task + ' -> ' + JSON.stringify(r));
  }
});
t('routeFor: an ordinary feature/bug fix -> build (opus/medium)', () => {
  const r = routeFor({ task: 'add a CSV export button to the reports page' });
  assert.ok(r.route === 'build' && r.model === 'opus' && r.effort === 'medium', JSON.stringify(r));
});
t('routeFor: risk wins over size — a "small" auth change is still deep', () => assert.strictEqual(routeFor({ task: 'small fix to the auth middleware' }).route, 'deep'));
t('routeFor: explicit risk high -> deep even for a docs task', () => assert.strictEqual(routeFor({ task: 'docs tweak', risk: 'high' }).route, 'deep'));
t('routeFor: keywords are word-boundaried ("author" is not "auth")', () => {
  assert.strictEqual(routeFor({ task: 'fix typo in the author name in README' }).route, 'quick');
  assert.strictEqual(routeFor({ task: 'authorize admin users' }).route, 'deep');
});
t('routeFor: data / database / schema / retention / PII / unclear work -> deep', () => {
  for (const task of ['change the database schema for user data retention', 'mask PII in the export', 'the scope is unclear, investigate']) {
    assert.strictEqual(routeFor({ task }).route, 'deep', task);
  }
});
t('routeFor: an empty / unclear task -> deep (anything unclear is deep)', () => { assert.strictEqual(routeFor({ task: '' }).route, 'deep'); assert.strictEqual(routeFor().route, 'deep'); });
t('routeFor: never returns escalate and never fable', () => {
  for (const task of ['', 'typo', 'feature', 'auth', 'production deploy']) { const r = routeFor({ task }); assert.ok(r.route !== 'escalate' && r.model !== 'fable', JSON.stringify(r)); }
});
t('routeFor: uses the routes table it is handed (FORGE_MODEL_ROUTING.json values win over spec)', () => {
  const r = routeFor({ task: 'add a feature', routes: { build: { model: 'sonnet', effort: 'high' } } });
  assert.ok(r.route === 'build' && r.model === 'sonnet' && r.effort === 'high', JSON.stringify(r));
});

t('escalate: process failure WITH effort control (Workflow) -> same route, effort one level up', () => {
  const q = escalate({ route: 'quick', failure: 'process', workflow: true });
  assert.ok(q.action === 'retry' && q.route === 'quick' && q.model === 'sonnet' && q.effort === 'medium' && q.step === 'more-effort', JSON.stringify(q));
  const b = escalate({ route: 'build', failure: 'process', workflow: true });
  assert.ok(b.route === 'build' && b.model === 'opus' && b.effort === 'high', JSON.stringify(b));
});
t('escalate: process failure WITHOUT effort control -> the next route (quick -> build)', () => {
  const r = escalate({ route: 'quick', failure: 'process' });
  assert.ok(r.action === 'retry' && r.route === 'build' && r.model === 'opus' && r.effort === 'medium' && r.escalated === true, JSON.stringify(r));
  assert.strictEqual(escalate({ route: 'build', failure: 'process' }).route, 'deep');
});
t('escalate: context/capability failure -> bigger model: build -> deep -> escalate (fable/high)', () => {
  const b = escalate({ route: 'build', failure: 'context' });
  assert.ok(b.route === 'deep' && b.model === 'opus' && b.effort === 'xhigh', JSON.stringify(b));
  const d = escalate({ route: 'deep', failure: 'capability' });
  assert.ok(d.route === 'escalate' && d.model === 'fable' && d.effort === 'high' && d.step === 'bigger-model', JSON.stringify(d));
});
t('escalate: never twice — an already-escalated task stops', () => {
  const r = escalate({ route: 'build', failure: 'context', escalated: true });
  assert.ok(r.ok === true && r.action === 'stop' && !r.route, JSON.stringify(r));
});
t('escalate: never past escalate', () => assert.strictEqual(escalate({ route: 'escalate', failure: 'context' }).action, 'stop'));
t('escalate: fable is reached ONLY via the escalate route', () => {
  for (const route of ['quick', 'build', 'deep']) for (const failure of ['process', 'context']) for (const workflow of [false, true]) {
    const r = escalate({ route, failure, workflow });
    if (r.model === 'fable') assert.strictEqual(r.route, 'escalate', JSON.stringify(r));
  }
});
t('escalate: invalid input -> ok:false, action invalid (never a guessed retry)', () => {
  assert.strictEqual(escalate({ route: 'build', failure: 'tired' }).action, 'invalid');
  assert.strictEqual(escalate({ route: 'triage', failure: 'process' }).action, 'invalid');
  assert.strictEqual(escalate().ok, false);
});
t('escalate: a retry names the lesson to record', () => assert.ok(/lessons file/.test(escalate({ route: 'build', failure: 'context' }).lesson)));

t('agentRoute: agent-model-map wins; an unknown agent falls back to the build route', () => {
  const routing = loadRouting(path.join(os.tmpdir(), 'forge-policy-nonexistent-root'));
  assert.strictEqual(routing.source, 'spec');
  const a = agentRoute('docs-boss', { routing, map: { agents: { 'docs-boss': { claudeTier: 'sonnet', claudeEffort: 'low' } } } });
  assert.ok(a.model === 'sonnet' && a.effort === 'low' && a.source === 'agent-model-map', JSON.stringify(a));
  const b = agentRoute('boss', { routing, map: null });
  assert.ok(b.model === 'opus' && b.effort === 'xhigh' && b.route === 'deep', JSON.stringify(b));
  const u = agentRoute('nobody', { routing, map: null });
  assert.ok(u.route === 'build' && u.model === 'opus' && u.effort === 'medium', JSON.stringify(u));
});

console.log('');
console.log('routingCheck (enforced by forge-doctor model_routing) — the real project + temp-dir drift fixtures');

const REAL_ROOT = path.resolve(__dirname, '..', '..');
t('routingCheck: the REAL project is consistent (frontmatter == agent-model-map == tool-policy, routes complete)', () => {
  const r = routingCheck(REAL_ROOT);
  assert.ok(r.applicable === true && r.ok === true && r.checked >= 19, JSON.stringify(r.violations));
});

/** fixture(mutate) — a temp copy of exactly the files routingCheck reads, from the real project. */
function fixture(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-' + label + '-'));
  fs.mkdirSync(path.join(d, '.claude', 'config', 'agents'), { recursive: true });
  fs.cpSync(path.join(REAL_ROOT, '.claude', 'agents'), path.join(d, '.claude', 'agents'), { recursive: true });
  for (const f of ['agent-model-map.json', 'agent-tool-policy.json']) fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', f), path.join(d, '.claude', 'config', 'agents', f));
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'FORGE_MODEL_ROUTING.json'), path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'));
  return d;
}
function editJson(file, fn) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); fn(j); fs.writeFileSync(file, JSON.stringify(j, null, 2)); }
function kinds(r) { return r.violations.map((v) => v.kind); }
const cleanups = [];

t('routingCheck: a clean temp copy of the real files is ok (fixture sanity)', () => {
  const d = fixture('clean'); cleanups.push(d);
  const r = routingCheck(d);
  assert.ok(r.ok === true, JSON.stringify(r.violations));
});
t('routingCheck DRIFT: frontmatter effort changed in one agent file -> effort-drift + default-route-drift, ok=false', () => {
  const d = fixture('effort'); cleanups.push(d);
  const f = path.join(d, '.claude', 'agents', 'build-boss.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^effort:.*$/m, 'effort: xhigh'));
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('effort-drift') && r.violations.some((v) => v.agent === 'build-boss'), JSON.stringify(r.violations));
});
t('routingCheck DRIFT: agent-model-map claudeTier differs from the frontmatter -> model-drift', () => {
  const d = fixture('tier'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'config', 'agents', 'agent-model-map.json'), (j) => { j.agents['docs-boss'].claudeTier = 'opus'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && r.violations.some((v) => v.kind === 'model-drift' && v.agent === 'docs-boss'), JSON.stringify(r.violations));
});
t('routingCheck DRIFT: agent-tool-policy model differs -> model-drift', () => {
  const d = fixture('policy'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'config', 'agents', 'agent-tool-policy.json'), (j) => { j.agents['review-boss'].model = 'sonnet'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && r.violations.some((v) => v.kind === 'model-drift' && v.agent === 'review-boss'), JSON.stringify(r.violations));
});
t('routingCheck: an agent defaulting to haiku (consistent in all three places) is still red (default-haiku)', () => {
  const d = fixture('haiku'); cleanups.push(d);
  const f = path.join(d, '.claude', 'agents', 'seo-boss.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^model:.*$/m, 'model: haiku'));
  editJson(path.join(d, '.claude', 'config', 'agents', 'agent-model-map.json'), (j) => { j.agents['seo-boss'].claudeTier = 'haiku'; });
  editJson(path.join(d, '.claude', 'config', 'agents', 'agent-tool-policy.json'), (j) => { j.agents['seo-boss'].model = 'haiku'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('default-haiku') && !kinds(r).includes('model-drift'), JSON.stringify(r.violations));
});
t('routingCheck: an agent with no effort line and an invalid effort value are both red', () => {
  const d = fixture('noeffort'); cleanups.push(d);
  const f = path.join(d, '.claude', 'agents', 'skill-boss.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^effort:.*\r?\n/m, ''));
  const g = path.join(d, '.claude', 'agents', 'search-boss.md');
  fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace(/^effort:.*$/m, 'effort: turbo'));
  const r = routingCheck(d);
  assert.ok(kinds(r).includes('effort-missing') && kinds(r).includes('bad-effort'), JSON.stringify(r.violations));
});
t('routingCheck: routes table incomplete / escalate not fable / fable on another route -> red', () => {
  const d = fixture('routes'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { delete j.routes.verifier; j.routes.escalate.model = 'opus'; j.routes.quick.model = 'fable'; });
  const r = routingCheck(d);
  const k = kinds(r);
  assert.ok(r.ok === false && k.includes('route-missing') && k.includes('escalate-not-fable') && k.includes('fable-outside-escalate'), JSON.stringify(r.violations));
});
// Codex rev-goat-5b8c97d-1 F4: session.lead (the router) was never validated — {fable, turbo} passed.
t('routingCheck F4: session.lead {model:"fable", effort:"turbo"} (the Codex repro) -> red: lead-bad-model + lead-bad-effort', () => {
  const d = fixture('lead-fable'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { j.session.lead.model = 'fable'; j.session.lead.effort = 'turbo'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('lead-bad-model') && kinds(r).includes('lead-bad-effort'), JSON.stringify(r.violations));
});
t('routingCheck F4: a lead on opus (valid alias, not the sonnet router) is red (lead-bad-model)', () => {
  const d = fixture('lead-opus'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { j.session.lead.model = 'opus'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('lead-bad-model') && !kinds(r).includes('lead-bad-effort'), JSON.stringify(r.violations));
});
t('routingCheck F4: a lead on a valid but non-spec effort (sonnet/high) is red (lead-spec-drift)', () => {
  const d = fixture('lead-high'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { j.session.lead.effort = 'high'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('lead-spec-drift') && !kinds(r).includes('lead-bad-model'), JSON.stringify(r.violations));
});
t('routingCheck F4: no session.lead at all is red (lead-missing), not a silent spec fallback', () => {
  const d = fixture('lead-missing'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { delete j.session; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('lead-missing'), JSON.stringify(r.violations));
});
// Codex rev-goat-5b8c97d-1 F5: agentDefaults removed + routes.deep moved to sonnet/low still passed.
t('routingCheck F5: agentDefaults removed AND routes.deep = sonnet/low (the Codex repro) -> red: agent-defaults-missing + route-spec-drift', () => {
  const d = fixture('nodefaults'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { delete j.agentDefaults; j.routes.deep = { model: 'sonnet', effort: 'low' }; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('agent-defaults-missing') && r.violations.some((v) => v.kind === 'route-spec-drift' && /"deep"/.test(v.detail)), JSON.stringify(r.violations));
});
t('routingCheck F5: every canonical route is pinned to the GOAT spec (one effort changed -> route-spec-drift for exactly that route)', () => {
  for (const [name, mut] of [['triage', { effort: 'medium' }], ['quick', { model: 'opus' }], ['build', { effort: 'high' }], ['deep', { effort: 'max' }], ['escalate', { effort: 'xhigh' }], ['verifier', { effort: 'low' }]]) {
    const d = fixture('spec-' + name); cleanups.push(d);
    editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { Object.assign(j.routes[name], mut); });
    const r = routingCheck(d);
    const drift = r.violations.filter((v) => v.kind === 'route-spec-drift');
    assert.ok(r.ok === false && drift.length === 1 && drift[0].detail.includes('"' + name + '"'), name + ': ' + JSON.stringify(r.violations));
  }
});
t('routingCheck F5: an agent with no agentDefaults entry is red (agent-default-missing) — runtime would silently use the spec fallback', () => {
  const d = fixture('default-gap'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { delete j.agentDefaults['docs-boss']; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && r.violations.some((v) => v.kind === 'agent-default-missing' && v.agent === 'docs-boss'), JSON.stringify(r.violations));
});
t('routingCheck F5: an agentDefaults entry for an agent that does not exist, or naming a non-agent route, is red', () => {
  const d = fixture('default-ghost'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { j.agentDefaults['ghost-boss'] = 'quick'; j.agentDefaults['seo-boss'] = 'router'; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && r.violations.some((v) => v.kind === 'agent-default-unknown-agent' && /ghost-boss/.test(v.detail)) && r.violations.some((v) => v.kind === 'default-route-unknown' && v.agent === 'seo-boss'), JSON.stringify(r.violations));
});
t('routingCheck F5: agentDefaults that is not an object (a list) is red, not skipped', () => {
  const d = fixture('default-list'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'), (j) => { j.agentDefaults = ['build']; });
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('agent-defaults-missing'), JSON.stringify(r.violations));
});
t('routingCheck: CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_CODE_SUBAGENT_MODEL / modelSettings effortLevel in project settings -> red', () => {
  const d = fixture('settings'); cleanups.push(d);
  fs.writeFileSync(path.join(d, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }));
  fs.writeFileSync(path.join(d, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, modelSettings: { opus: { effortLevel: 'xhigh' } } }));
  const r = routingCheck(d);
  const hits = r.violations.filter((v) => v.kind === 'settings-anti-pattern').map((v) => v.detail).join(' | ');
  assert.ok(r.ok === false && /CLAUDE_CODE_EFFORT_LEVEL/.test(hits) && /CLAUDE_CODE_SUBAGENT_MODEL/.test(hits) && /modelSettings|per-model effort/.test(hits), hits);
});
t('routingCheck: a missing agent-model-map.json (routing file present) is red, not silently skipped', () => {
  const d = fixture('nomap'); cleanups.push(d);
  fs.rmSync(path.join(d, '.claude', 'config', 'agents', 'agent-model-map.json'));
  const r = routingCheck(d);
  assert.ok(r.ok === false && kinds(r).includes('model-map-missing'), JSON.stringify(r.violations));
});
t('routingCheck: a project with neither routing file nor model map is n/a (ok, applicable:false)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-empty-')); cleanups.push(d);
  const r = routingCheck(d);
  assert.ok(r.ok === true && r.applicable === false, JSON.stringify(r));
});
t('CLI: `check --root <drifted fixture>` exits 1; `route` and `escalate` print JSON and exit 0', () => {
  const d = fixture('cli'); cleanups.push(d);
  editJson(path.join(d, '.claude', 'config', 'agents', 'agent-model-map.json'), (j) => { j.agents['boss'].claudeEffort = 'low'; });
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'forge-policy.cjs'), 'check', '--root', d], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
  assert.ok(/effort-drift/.test(bad.stdout), bad.stdout);
  const rt = spawnSync(process.execPath, [path.join(__dirname, 'forge-policy.cjs'), 'route', 'fix', 'a', 'typo'], { encoding: 'utf8' });
  assert.ok(rt.status === 0 && JSON.parse(rt.stdout).route === 'quick', rt.stdout + rt.stderr);
  const es = spawnSync(process.execPath, [path.join(__dirname, 'forge-policy.cjs'), 'escalate', 'deep', 'context'], { encoding: 'utf8' });
  assert.ok(es.status === 0 && JSON.parse(es.stdout).model === 'fable', es.stdout + es.stderr);
});
// FORGE_MODEL_ROUTING.user.json may only ADD agent defaults for project-own agents.
t('user overlay: adds a default for a project-own agent, never changes a shipped one, routes or the lead', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-user-')); cleanups.push(d);
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'FORGE_MODEL_ROUTING.json'), path.join(d, '.claude', 'FORGE_MODEL_ROUTING.json'));
  const base = loadRouting(d);
  fs.writeFileSync(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.user.json'), JSON.stringify({
    agentDefaults: { 'idea-reviewer': 'verifier', 'build-boss': 'quick', 'my-fable': 'escalate', 'bad-route': 'turbo', _note: 'x', 'Bad Name': 'quick' },
    routes: { deep: { model: 'sonnet', effort: 'low' } },
    session: { lead: { model: 'fable', effort: 'max' } },
  }));
  const r = loadRouting(d);
  assert.deepStrictEqual(r.userAdded, ['idea-reviewer']);
  assert.strictEqual(r.agentDefaults['idea-reviewer'], 'verifier');
  assert.strictEqual(r.agentDefaults['build-boss'], base.agentDefaults['build-boss'], 'a shipped default must never change');
  assert.ok(!('my-fable' in r.agentDefaults) && !('bad-route' in r.agentDefaults) && !('Bad Name' in r.agentDefaults));
  assert.deepStrictEqual(r.routes, base.routes, 'routes stay the shipped/spec values');
  assert.deepStrictEqual(r.lead, base.lead, 'the lead stays the shipped/spec value');
  const ar = agentRoute('idea-reviewer', { root: d, map: null, routing: r });
  assert.strictEqual(ar.route, 'verifier');
  assert.strictEqual(ar.model, base.routes.verifier.model);
  assert.strictEqual(ar.source, 'route-default');
  assert.strictEqual(routingCheck(d).violations.filter((v) => /route-spec-drift|lead-/.test(v.kind)).length, 0, 'the overlay can never cause a pinned-route violation');
});
t('user overlay: absent or broken -> nothing added, no throw', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-user2-')); cleanups.push(d);
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
  assert.deepStrictEqual(loadRouting(d).userAdded, []);
  fs.writeFileSync(path.join(d, '.claude', 'FORGE_MODEL_ROUTING.user.json'), '{ broken');
  assert.deepStrictEqual(loadRouting(d).userAdded, []);
});

// =====================================================================================================
// WP 1.5: the agent .md frontmatter is the single source of truth; agents.generated.json is generated
// from it and agentsGeneratedCheck() fails on drift, on broken frontmatter rules and on a disagreeing legacy mirror.
// =====================================================================================================
console.log('');
console.log('WP 1.5 — agent frontmatter as the single source of truth (parse / derive / generated-file check)');
const P = require('./forge-policy.cjs');
const REPO = path.resolve(__dirname, '..', '..');

t('parseAgentFrontmatter: comma tools, block list, inline list, quoted values and CRLF', () => {
  const fm = P.parseAgentFrontmatter('---\r\nname: x\r\ndescription: "Use when: a"\r\ntools: Read, Grep\r\nskills:\r\n  - one\r\n  - "two"\r\ndisallowedTools: [Write, Edit]\r\nmaxTurns: 40\r\n---\r\nbody\r\n');
  assert.strictEqual(fm.fields.description, 'Use when: a');
  assert.strictEqual(fm.fields.tools, 'Read, Grep');
  assert.deepStrictEqual(fm.fields.skills, ['one', 'two']);
  assert.deepStrictEqual(fm.fields.disallowedTools, ['Write', 'Edit']);
  assert.strictEqual(fm.fields.maxTurns, '40');
  assert.deepStrictEqual(fm.keys, ['name', 'description', 'tools', 'skills', 'disallowedTools', 'maxTurns']);
  assert.deepStrictEqual(fm.problems, []);
});
t('parseAgentFrontmatter: a nested block (hooks:) is {nested:true}, a missing fence is null, duplicates and stray lines are reported', () => {
  const fm = P.parseAgentFrontmatter('---\nname: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\nstray line\nname: y\n---\n');
  assert.deepStrictEqual(fm.fields.hooks, { nested: true });
  assert.ok(fm.problems.some((p) => /duplicate key "name"/.test(p)) && fm.problems.some((p) => /stray line/.test(p)), JSON.stringify(fm.problems));
  assert.strictEqual(P.parseAgentFrontmatter('no fence here'), null);
});
t('effectiveTools: memory adds Read/Write/Edit and is assumed to survive disallowedTools; no tools line = every tool', () => {
  assert.deepStrictEqual(P.effectiveTools({ tools: 'Read, Grep', memory: 'project' }).tools, ['Read', 'Grep', 'Write', 'Edit']);
  assert.deepStrictEqual(P.effectiveTools({ tools: 'Read, Grep', disallowedTools: 'Write, Edit', memory: 'project' }).tools, ['Read', 'Grep', 'Write', 'Edit']);
  assert.deepStrictEqual(P.effectiveTools({ tools: 'Read, Bash', disallowedTools: ['Bash(git push *)'] }).tools, ['Read'], 'a specifier entry removes the whole tool');
  assert.deepStrictEqual(P.effectiveTools({}), { tools: ['*'], inheritsAll: true });
});
t('roleClassOf: the write x shell matrix, * = full-build, Bash(git *) still counts as shell', () => {
  assert.strictEqual(P.roleClassOf(['Read', 'Grep']), 'read-only-audit');
  assert.strictEqual(P.roleClassOf(['Read', 'Write']), 'write-no-exec');
  assert.strictEqual(P.roleClassOf(['Read', 'Bash(git *)']), 'exec-reviewer');
  assert.strictEqual(P.roleClassOf(['Edit', 'PowerShell']), 'full-build');
  assert.strictEqual(P.roleClassOf(['*']), 'full-build');
  assert.strictEqual(P.roleClassOf(['Read', 'NotebookEdit']), 'write-no-exec');
});
t('agentRouteOf: sonnet/low is triage for head-chef and quick for scribe; opus/xhigh is deep; a non-route is null', () => {
  assert.strictEqual(P.agentRouteOf('head-chef', 'sonnet', 'low'), 'triage');
  assert.strictEqual(P.agentRouteOf('scribe', 'sonnet', 'low'), 'quick');
  assert.strictEqual(P.agentRouteOf('my-agent', 'sonnet', 'low'), 'quick');
  assert.strictEqual(P.agentRouteOf('boss', 'opus', 'xhigh'), 'deep');
  assert.strictEqual(P.agentRouteOf('x', 'fable', 'high'), null, 'escalate is never a default route');
  assert.strictEqual(P.agentRouteOf('x', 'sonnet', 'max'), null);
});
t('PERMANENT_BOSSES == forge-doctor BOSS_NAMES == agent-registry.json "agents" keys', () => {
  const D = require('./forge-doctor.cjs');
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'config', 'agents', 'agent-registry.json'), 'utf8'));
  assert.deepStrictEqual([...P.PERMANENT_BOSSES].sort(), [...D.BOSS_NAMES].sort());
  assert.deepStrictEqual([...P.PERMANENT_BOSSES].sort(), Object.keys(reg.agents).filter((k) => !k.startsWith('_')).sort());
});

// ---- REAL tree ----
const realGen = P.agentsGeneratedCheck(REPO);
const realFile = JSON.parse(fs.readFileSync(path.join(REPO, ...P.AGENTS_GENERATED_REL), 'utf8'));
/** generatedProof(root) -> {mode, own} — the real-tree proof of agents.generated.json, portable (2026-11-02: a synced
 *  project with its own agent file, 26h2's idea-reviewer.md, turned this suite red). In the development tree the file
 *  regenerates byte-identically from ALL agent files. In a synced project the file is the shipped template copy and the
 *  project may add its own agents: every LISTED agent must equal a fresh build of its file, schema/_doc/policy must equal
 *  the generator, and the unlisted agent files are returned as project-own. Throws on any mismatch. */
function generatedProof(root) {
  const text = fs.readFileSync(path.join(root, ...P.AGENTS_GENERATED_REL), 'utf8').replace(/\r\n/g, '\n');
  const file = JSON.parse(text);
  assert.deepStrictEqual(file.counts, { agents: 20, bosses: 12, specialists: 8 });
  const names = file.agents.map((a) => a.name);
  assert.deepStrictEqual(names, [...names].sort());
  const fresh = P.buildAgentsGenerated(root).data;
  if (P.isDevTree(root)) { assert.strictEqual(JSON.stringify(fresh, null, 2) + '\n', text); return { mode: 'dev', own: [] }; }
  const byName = new Map(fresh.agents.map((a) => [a.name, a]));
  for (const a of file.agents) assert.deepStrictEqual(byName.get(a.name), a, a.name + ' in agents.generated.json differs from a fresh build of .claude/agents/' + a.name + '.md');
  assert.deepStrictEqual([fresh.schema, fresh._doc, fresh.policy], [file.schema, file._doc, file.policy], 'schema, _doc or policy differ from the shipped generator');
  return { mode: 'synced', own: fresh.agents.map((a) => a.name).filter((n) => !names.includes(n)) };
}
t('real tree: agentsGeneratedCheck is applicable and IN SYNC with 0 violations (synced project: the 20 shipped agents, project-own agents only noted)', () => {
  assert.ok(realGen.applicable === true && realGen.ok === true && realGen.checked === 20, JSON.stringify(realGen.violations.slice(0, 5)));
  if (P.isDevTree(REPO)) return;
  assert.strictEqual(realGen.devTree, false);
  for (const own of generatedProof(REPO).own) assert.ok(realGen.notes.some((n) => n.includes('project-own agent ' + own + ' ')), own + ' not noted: ' + JSON.stringify(realGen.notes));
});
t('real tree: the generated file lists 20 agents (12 bosses + 8 specialists), sorted, and regenerates byte-identically (synced project: per listed agent)', () => {
  const g = generatedProof(REPO);
  assert.strictEqual(g.mode, P.isDevTree(REPO) ? 'dev' : 'synced');
  if (g.own.length) console.log('    note: project-own agent(s) beside the shipped set: ' + g.own.join(', '));
});
t('real tree: derived roleClass == agent-tool-policy class and route == FORGE_MODEL_ROUTING agentDefaults for all 20', () => {
  const pol = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'config', 'agents', 'agent-tool-policy.json'), 'utf8'));
  const routing = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'FORGE_MODEL_ROUTING.json'), 'utf8'));
  for (const a of realFile.agents) {
    assert.strictEqual(a.roleClass, pol.agents[a.name].class, a.name + ' class');
    assert.strictEqual(a.route, routing.agentDefaults[a.name], a.name + ' route');
  }
});
t('real tree: GOAT model/effort untouched — every agent equals agent-model-map claudeTier/claudeEffort and routingCheck is green', () => {
  const mm = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'config', 'agents', 'agent-model-map.json'), 'utf8'));
  for (const a of realFile.agents) assert.ok(a.model === mm.agents[a.name].claudeTier && a.effort === mm.agents[a.name].claudeEffort, a.name);
  assert.strictEqual(routingCheck(REPO).ok, true);
});
t('real tree: no agent sets isolation (dispatch-contract conflicts) and no agent needs disallowedTools', () => {
  assert.ok(realFile.agents.every((a) => a.isolation === null && a.disallowedTools.length === 0));
  assert.ok(/worktree\.baseRef/.test(realFile.policy.isolation) && /log-event\.cjs/.test(realFile.policy.isolation));
});
t('real tree: every Write-forbidding agent has an explicit tools allowlist without Write/Edit and no memory', () => {
  for (const a of realFile.agents.filter((x) => x.roleClass === 'read-only-audit' || x.roleClass === 'exec-reviewer')) {
    assert.ok(Array.isArray(a.tools) && !a.tools.includes('Write') && !a.tools.includes('Edit') && a.memory === null, a.name);
  }
});
t('real tree: maxTurns — every reviewer (read-only-audit / exec-reviewer) stays below every full-build agent', () => {
  const rev = realFile.agents.filter((a) => a.roleClass === 'read-only-audit' || a.roleClass === 'exec-reviewer').map((a) => a.maxTurns);
  const bld = realFile.agents.filter((a) => a.roleClass === 'full-build').map((a) => a.maxTurns);
  assert.ok(Math.max(...rev) < Math.min(...bld), JSON.stringify({ rev, bld }));
});
t('real tree: specialists preload nothing; Bosses preload only skills on disk, model-invocable and listed in agent-skill-map', () => {
  const sm = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'config', 'agents', 'agent-skill-map.json'), 'utf8'));
  for (const a of realFile.agents) {
    if (a.bossOrSpecialist === 'specialist') { assert.deepStrictEqual(a.skills, [], a.name); continue; }
    assert.ok(a.skills.length >= 1 && a.skills.length <= P.SKILL_PRELOAD_CAP, a.name);
    for (const s of a.skills) {
      assert.ok(sm.agents[a.name].includes(s), a.name + ' ' + s + ' not in map');
      const fm = P.parseAgentFrontmatter(fs.readFileSync(path.join(REPO, '.claude', 'skills', s, 'SKILL.md'), 'utf8'));
      assert.ok(fm && String(fm.fields['disable-model-invocation']).toLowerCase() !== 'true', s + ' is disable-model-invocation');
    }
  }
});

// ---- HERMETIC: a temp copy of the SHIPPED agents (the ones agents.generated.json lists; a synced project's own agent
// files stay out, 2026-11-02) + config/agents + the skills they preload (+ grill-me, a DMI skill). o.src = the tree to copy
// from (default this tree), so the fixture itself is tested against a synced-project-shaped source.
function agentsFixture(opts) {
  const o = opts || {};
  const src = o.src || REPO;
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-agents-')); cleanups.push(fx);
  fs.cpSync(path.join(src, '.claude', 'agents'), path.join(fx, '.claude', 'agents'), { recursive: true });
  const shipped = new Set(JSON.parse(fs.readFileSync(path.join(src, ...P.AGENTS_GENERATED_REL), 'utf8')).agents.map((a) => a.name + '.md'));
  for (const f of fs.readdirSync(path.join(fx, '.claude', 'agents'))) if (f.endsWith('.md') && !shipped.has(f)) fs.unlinkSync(path.join(fx, '.claude', 'agents', f));
  const cfg = path.join(fx, '.claude', 'config', 'agents');
  fs.mkdirSync(cfg, { recursive: true });
  for (const f of ['agent-registry.json', 'agent-model-map.json', 'agent-skill-map.json', 'agent-tool-policy.json', 'agents.generated.json']) fs.copyFileSync(path.join(src, '.claude', 'config', 'agents', f), path.join(cfg, f));
  for (const s of new Set(realFile.agents.flatMap((a) => a.skills).concat(['grill-me']))) {
    fs.mkdirSync(path.join(fx, '.claude', 'skills', s), { recursive: true });
    fs.copyFileSync(path.join(REPO, '.claude', 'skills', s, 'SKILL.md'), path.join(fx, '.claude', 'skills', s, 'SKILL.md'));
  }
  if (!o.noDevTree) fs.writeFileSync(path.join(fx, '.claude', 'config', 'forge-dev-tree.json'), JSON.stringify({ dev_tree: true }));
  return fx;
}
const agentPath = (fx, name) => path.join(fx, '.claude', 'agents', name + '.md');
function editAgent(fx, name, fn) { const p = agentPath(fx, name); const before = fs.readFileSync(p, 'utf8'); const after = fn(before); assert.notStrictEqual(after, before, 'fixture edit of ' + name + ' changed nothing'); fs.writeFileSync(p, after); }
const addLine = (line) => (text) => text.replace(/(\r?\n)---(\r?\n)/, '$1' + line + '$1---$2'); // before the CLOSING fence
function regen(fx) { fs.writeFileSync(path.join(fx, ...P.AGENTS_GENERATED_REL), JSON.stringify(P.buildAgentsGenerated(fx).data, null, 2) + '\n'); }

t('hermetic: the untouched copy is IN SYNC (0 violations, 20 checked)', () => {
  const r = P.agentsGeneratedCheck(agentsFixture());
  assert.ok(r.ok && r.applicable && r.checked === 20, JSON.stringify(r.violations.slice(0, 3)));
});
// PORTABLE: the shape of a synced project that keeps its own agent file (26h2: idea-reviewer.md, no color,
// no maxTurns) — the real-tree proof and the fixture builder must hold there, and the dev tree must stay strict.
const OWN_AGENT = '---\nname: idea-reviewer\ndescription: a project-own reviewer\ntools: Read, Grep\nmodel: sonnet\n---\nbody\n';
function syncedShape() { const s = agentsFixture({ noDevTree: true }); fs.writeFileSync(agentPath(s, 'idea-reviewer'), OWN_AGENT); return s; }
t('PORTABLE: a synced-project-shaped copy with a project-own agent passes the real-tree proof (listed agents byte-equal, the own agent named)', () => {
  const s = syncedShape();
  assert.deepStrictEqual(generatedProof(s), { mode: 'synced', own: ['idea-reviewer'] });
  const r = P.agentsGeneratedCheck(s);
  assert.ok(r.ok && r.applicable && r.devTree === false && r.checked === 20 && r.notes.some((n) => n.includes('project-own agent idea-reviewer ')), JSON.stringify(r));
});
t('PORTABLE: the same copy WITH the dev-tree marker fails the proof and the check (the development tree stays strict)', () => {
  const d = agentsFixture(); fs.writeFileSync(agentPath(d, 'idea-reviewer'), OWN_AGENT);
  assert.throws(() => generatedProof(d));
  assert.ok(kinds(P.agentsGeneratedCheck(d)).includes('drift-agent-added'));
});
t('PORTABLE: a synced-shaped proof still catches a listed agent that drifted from its file', () => {
  const s = syncedShape();
  editAgent(s, 'build-boss', (x) => x.replace(/^maxTurns: \d+/m, 'maxTurns: 199'));
  assert.throws(() => generatedProof(s), /build-boss in agents\.generated\.json differs/);
});
t('PORTABLE: agentsFixture built FROM a synced-shaped source copies only the shipped (listed) agents and is IN SYNC', () => {
  const fx = agentsFixture({ src: syncedShape() });
  assert.ok(!fs.existsSync(agentPath(fx, 'idea-reviewer')), 'the project-own agent leaked into the fixture');
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(r.ok && r.devTree === true && r.checked === 20, JSON.stringify(r.violations.slice(0, 3)));
});
t('DRIFT: maxTurns changed in the frontmatter but not regenerated -> drift-field naming build-boss.maxTurns', () => {
  const fx = agentsFixture();
  editAgent(fx, 'build-boss', (s) => s.replace(/^maxTurns: \d+/m, 'maxTurns: 199'));
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(!r.ok && r.violations.some((x) => x.kind === 'drift-field' && x.agent === 'build-boss' && /build-boss\.maxTurns/.test(x.detail)), JSON.stringify(r.violations));
});
t('DRIFT: a hand edit of the generated file is caught (the file is never the source)', () => {
  const fx = agentsFixture();
  const gp = path.join(fx, ...P.AGENTS_GENERATED_REL);
  const j = JSON.parse(fs.readFileSync(gp, 'utf8'));
  j.agents.find((a) => a.name === 'boss').color = 'red';
  fs.writeFileSync(gp, JSON.stringify(j, null, 2));
  assert.ok(P.agentsGeneratedCheck(fx).violations.some((x) => x.kind === 'drift-field' && /boss\.color/.test(x.detail)));
});
t('DRIFT: a new agent file -> drift-agent-added in the dev tree; outside it only a note (project-own agent)', () => {
  const extra = '---\nname: extra-agent\ndescription: x\ntools: Read\nmodel: sonnet\neffort: low\nmaxTurns: 40\ncolor: cyan\n---\nbody\n';
  const dev = agentsFixture();
  fs.writeFileSync(agentPath(dev, 'extra-agent'), extra);
  assert.ok(kinds(P.agentsGeneratedCheck(dev)).includes('drift-agent-added'));
  const inst = agentsFixture({ noDevTree: true });
  fs.writeFileSync(agentPath(inst, 'extra-agent'), extra);
  const r = P.agentsGeneratedCheck(inst);
  assert.ok(r.ok && r.devTree === false && r.notes.some((n) => /extra-agent/.test(n)), JSON.stringify(r));
});
t('DRIFT: a deleted agent file -> drift-agent-removed', () => {
  const fx = agentsFixture();
  fs.unlinkSync(agentPath(fx, 'verify-boss'));
  assert.ok(P.agentsGeneratedCheck(fx).violations.some((x) => x.kind === 'drift-agent-removed' && x.agent === 'verify-boss'));
});
t('generated file missing: red in the dev tree, n/a (ok) in an installed project', () => {
  const dev = agentsFixture();
  fs.unlinkSync(path.join(dev, ...P.AGENTS_GENERATED_REL));
  const r = P.agentsGeneratedCheck(dev);
  assert.ok(!r.ok && kinds(r).includes('generated-missing'));
  const inst = agentsFixture({ noDevTree: true });
  fs.unlinkSync(path.join(inst, ...P.AGENTS_GENERATED_REL));
  const r2 = P.agentsGeneratedCheck(inst);
  assert.ok(r2.ok === true && r2.applicable === false, JSON.stringify(r2));
  // a fixture that only adds the dev-tree marker (no routing file, no registry: it does not define the agent set) is
  // n/a — forge-doctor.test's ship_manifest full-doctor fixture is exactly this shape and must stay green on agents
  const bare = agentsFixture();
  fs.unlinkSync(path.join(bare, ...P.AGENTS_GENERATED_REL));
  fs.unlinkSync(path.join(bare, '.claude', 'config', 'agents', 'agent-registry.json'));
  const r3 = P.agentsGeneratedCheck(bare);
  assert.ok(r3.ok === true && r3.applicable === false && r3.devTree === true && /marker without/.test(r3.reason), JSON.stringify(r3));
});
t('generated file not JSON -> generated-unreadable, frontmatter rules still run', () => {
  const fx = agentsFixture();
  fs.writeFileSync(path.join(fx, ...P.AGENTS_GENERATED_REL), '{ broken');
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(!r.ok && kinds(r).includes('generated-unreadable') && r.checked === 20);
});
t('RULE: preloading a disable-model-invocation skill (grill-me) -> skill-not-preloadable', () => {
  const fx = agentsFixture();
  editAgent(fx, 'boss', (s) => s.replace(/(  - forge-report)(\r?\n)/, '$1$2  - grill-me$2'));
  regen(fx);
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(r.violations.some((x) => x.kind === 'skill-not-preloadable' && x.agent === 'boss') && !kinds(r).includes('skill-not-in-map'), JSON.stringify(r.violations));
});
t('RULE: a missing skill -> skill-missing + skill-not-in-map; 33 skills -> skills-over-cap', () => {
  const fx = agentsFixture();
  editAgent(fx, 'search-boss', (s) => s.replace(/(  - forge-scout)(\r?\n)/, '$1$2  - no-such-skill$2'));
  const many = Array.from({ length: 33 }, (_, i) => '  - fake-skill-' + i).join('\n');
  editAgent(fx, 'security-boss', (s) => s.replace(/  - forge-verify/, many.replace(/\n/g, s.includes('\r\n') ? '\r\n' : '\n')));
  regen(fx);
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(r.violations.some((x) => x.kind === 'skill-missing' && x.agent === 'search-boss') && r.violations.some((x) => x.kind === 'skill-not-in-map' && x.agent === 'search-boss'));
  assert.ok(r.violations.some((x) => x.kind === 'skills-over-cap' && x.agent === 'security-boss'));
});
t('RULE: skills as a scalar instead of a YAML list -> skills-not-a-list', () => {
  const fx = agentsFixture();
  editAgent(fx, 'security-boss', (s) => s.replace(/skills:\r?\n  - forge-verify/, 'skills: forge-verify'));
  regen(fx);
  assert.ok(kinds(P.agentsGeneratedCheck(fx)).includes('skills-not-a-list'));
});
t('RULE: isolation: worktree is accepted on a full-build agent and refused on a read-only one; other values refused', () => {
  const ok = agentsFixture();
  editAgent(ok, 'build-boss', addLine('isolation: worktree'));
  regen(ok);
  const r1 = P.agentsGeneratedCheck(ok);
  assert.ok(r1.ok, JSON.stringify(r1.violations));
  const bad = agentsFixture();
  editAgent(bad, 'review-boss', addLine('isolation: worktree'));
  editAgent(bad, 'ui-boss', addLine('isolation: sandbox'));
  regen(bad);
  const r2 = P.agentsGeneratedCheck(bad);
  assert.ok(r2.violations.some((x) => x.kind === 'isolation-not-allowed' && x.agent === 'review-boss') && r2.violations.some((x) => x.kind === 'isolation-invalid' && x.agent === 'ui-boss'));
});
t('RULE: bad color, missing color, an unknown field (typo maxturns) and maxTurns outside the class band', () => {
  const fx = agentsFixture();
  editAgent(fx, 'build-boss', (s) => s.replace(/^color: blue/m, 'color: teal'));
  editAgent(fx, 'ui-boss', (s) => s.replace(/^color: pink\r?\n/m, ''));
  editAgent(fx, 'docs-boss', addLine('maxturns: 5'));
  editAgent(fx, 'integration-boss', (s) => s.replace(/^maxTurns: \d+/m, 'maxTurns: 500'));
  editAgent(fx, 'scribe', (s) => s.replace(/^maxTurns: \d+/m, 'maxTurns: 10'));
  editAgent(fx, 'seo-boss', (s) => s.replace(/^maxTurns: \d+/m, 'maxTurns: many'));
  regen(fx);
  const r = P.agentsGeneratedCheck(fx);
  const has = (k, a) => r.violations.some((x) => x.kind === k && x.agent === a);
  assert.ok(has('bad-color', 'build-boss') && has('color-missing', 'ui-boss') && has('unknown-field', 'docs-boss'), JSON.stringify(r.violations));
  assert.ok(has('maxturns-out-of-band', 'integration-boss') && has('maxturns-out-of-band', 'scribe') && has('maxturns-invalid', 'seo-boss'), JSON.stringify(r.violations));
});
t('RULE: memory: project on review-boss -> its tools become write-capable -> class-drift + class-forbidden-tool (Write, Edit)', () => {
  const fx = agentsFixture();
  editAgent(fx, 'review-boss', addLine('memory: project'));
  regen(fx);
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(r.violations.some((x) => x.kind === 'class-drift' && x.agent === 'review-boss'));
  assert.ok(r.violations.some((x) => x.kind === 'class-forbidden-tool' && x.agent === 'review-boss' && /Write, Edit/.test(x.detail)), JSON.stringify(r.violations));
});
t('LEGACY: a Boss filed under specialistAgents, or a wrong agentFile -> registry-drift', () => {
  const fx = agentsFixture();
  const rp = path.join(fx, '.claude', 'config', 'agents', 'agent-registry.json');
  const reg = JSON.parse(fs.readFileSync(rp, 'utf8'));
  reg.specialistAgents['build-boss'] = reg.agents['build-boss']; delete reg.agents['build-boss'];
  reg.specialistAgents['scribe'].agentFile = '.claude/agents/notulist.md';
  fs.writeFileSync(rp, JSON.stringify(reg));
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(r.violations.some((x) => x.kind === 'registry-drift' && x.agent === 'build-boss') && r.violations.some((x) => x.kind === 'registry-drift' && x.agent === 'scribe' && /notulist/.test(x.detail)));
});
t('LEGACY: a preloaded skill agent-skill-map does not list for that agent -> skill-not-in-map', () => {
  const fx = agentsFixture();
  editAgent(fx, 'review-boss', (s) => s.replace(/(  - forge-verify)(\r?\n)/, '$1$2  - forge-debug$2'));
  regen(fx);
  const r = P.agentsGeneratedCheck(fx);
  assert.deepStrictEqual(r.violations.map((x) => x.kind + ':' + x.agent), ['skill-not-in-map:review-boss']);
});
t('LEGACY: absent mirrors are notes, never a crash; the frontmatter is still judged', () => {
  const fx = agentsFixture();
  for (const f of ['agent-registry.json', 'agent-skill-map.json', 'agent-tool-policy.json']) fs.unlinkSync(path.join(fx, '.claude', 'config', 'agents', f));
  const r = P.agentsGeneratedCheck(fx);
  assert.ok(r.ok === true && r.notes.length === 3 && r.checked === 20, JSON.stringify(r));
});
t('frontmatter-unparseable: an agent file without frontmatter is a violation and buildAgentsGenerated reports it', () => {
  const fx = agentsFixture();
  fs.writeFileSync(agentPath(fx, 'scribe'), 'no frontmatter at all\n');
  assert.ok(P.buildAgentsGenerated(fx).problems.some((p) => p.agent === 'scribe'));
  assert.ok(kinds(P.agentsGeneratedCheck(fx)).includes('frontmatter-unparseable'));
});
t('doctor: agentsCheck is red on generated drift and its ✗ line names it; green copy says "generated config in sync"', () => {
  const D = require('./forge-doctor.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-docsum-')); cleanups.push(base);
  const rep = D.runDoctor(base);
  const lineOf = (a) => D.printSummary(Object.assign({}, rep, { checks: Object.assign({}, rep.checks, { agents: a }) })).split(/\r?\n/).find((l) => / agents /.test(l)) || '';
  const green = agentsFixture();
  const g = D.agentsCheck(green);
  assert.ok(g.ok === true && g.generated.applicable === true, JSON.stringify(g.generated));
  assert.ok(/✓ agents .*generated config in sync \(20 agents\)/.test(lineOf(g)), lineOf(g));
  const red = agentsFixture();
  editAgent(red, 'test-boss', (s) => s.replace(/^color: green/m, 'color: yellow'));
  const rr = D.agentsCheck(red);
  assert.ok(rr.ok === false && rr.generated.ok === false && rr.toolPolicy.ok === true);
  assert.ok(/✗ agents .*GENERATED CONFIG DRIFT: 1 violation\(s\): drift-field \(test-boss\.color/.test(lineOf(rr)), lineOf(rr));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-plain-')); cleanups.push(plain);
  assert.strictEqual(D.agentsCheck(plain).generated.applicable, false, 'a project without the file and without the dev-tree marker is n/a');
});

for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ } }

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
