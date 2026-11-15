// T3.5 tests — buildAgentsRegistry() against THIS project's real 4 config sources.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentsRegistry } from '../src/agents.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { removeDataDirIfCreatedByTests } from './.data-dir-guard.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';

// WP-CC1 (item 6) fixtures — isolated, nested under COMMAND_CENTER_DATA_DIR (a real descendant of
// PROJECT_ROOT/SYNC_SCAN_ROOTS; listRunLogDispatches()'s own anyContainmentOk() check, reached via
// buildAgentsRegistry()'s live-status merge, would reject a plain os.tmpdir() fixture — same
// reasoning as runs.test.mjs's own header comment).
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-agents');
const tempRoots = [];
function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}
function writeAgentMd(root, slug, frontmatter) {
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', ...Object.entries(frontmatter).map(([k, v]) => k + ': ' + v), '---', 'body'];
  fs.writeFileSync(path.join(dir, slug + '.md'), lines.join('\n'), 'utf8');
}
function writeRegistry(root, agents) {
  const dir = path.join(root, '.claude', 'config', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-registry.json'), JSON.stringify({ agents }), 'utf8');
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  removeDataDirIfCreatedByTests();
});

test('buildAgentsRegistry finds every registered agent-md file (12 permanent Bosses + the registered specialists) and the 12 permanent Bosses', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  assert.equal(result.ok, true);
  // the count follows agent-registry.json (agents + specialistAgents, `_` keys are notes) instead of a
  // literal, which went stale when the Roblox pack registered 12 rbx-* specialists (20 -> 32). It stays a real
  // check: the agent-md files and the registry must name exactly the same agents.
  const reg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'config', 'agents', 'agent-registry.json'), 'utf8'));
  const registered = [...Object.keys(reg.agents || {}), ...Object.keys(reg.specialistAgents || {})].filter((k) => !k.startsWith('_'));
  assert.equal(Object.keys(reg.agents || {}).length, 12, 'the registry keeps 12 permanent Bosses');
  assert.deepEqual(result.agents.map((a) => a.slug).sort(), [...new Set(registered)].sort(), 'every agent-md file is registered, and every registered agent has a file');
  assert.equal(result.total_agents, registered.length);
  assert.equal(result.permanent_boss_count, 12);
  assert.equal(result.sources.registry_present, true);
  assert.equal(result.sources.model_map_present, true);
  assert.equal(result.sources.tool_policy_present, true);
});

test('build-boss merges all 3 config sources correctly (full-build class, opus tier — GOAT build route 2026-10-06, nvidia-bulk-only)', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const buildBoss = result.agents.find((a) => a.slug === 'build-boss');
  assert.ok(buildBoss);
  assert.equal(buildBoss.name, 'build-boss');
  assert.ok(buildBoss.tools.includes('Bash'));
  assert.equal(buildBoss.class, 'full-build');
  assert.equal(buildBoss.model_tier, 'opus');
  assert.equal(buildBoss.usage_policy_bucket, 'nvidia-bulk-only');
  assert.equal(buildBoss.is_permanent_boss, true);
  assert.equal(buildBoss.role, 'Implementation / coding');
});

test('review-boss is read-only-audit and claude-wins-skip-nvidia', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const reviewBoss = result.agents.find((a) => a.slug === 'review-boss');
  assert.ok(reviewBoss);
  assert.equal(reviewBoss.class, 'read-only-audit');
  assert.ok(!reviewBoss.tools.includes('Write'));
  assert.equal(reviewBoss.usage_policy_bucket, 'claude-wins-skip-nvidia');
});

test('a non-Boss specialist agent (codex-reviewer) is correctly NOT a permanent Boss and sits in the Claude-first usage-policy list', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const codexReviewer = result.agents.find((a) => a.slug === 'codex-reviewer');
  assert.ok(codexReviewer);
  assert.equal(codexReviewer.is_permanent_boss, false);
  assert.equal(codexReviewer.role, null);
  assert.equal(codexReviewer.class, 'exec-reviewer');
  // 2026-11-13 (Forge audit CF-4-F1): every agent belongs to claudeWinsSkipNvidia or nvidiaForBulkOnly in
  // agent-model-map.json, because nvidia-provider policyFor() returns 'unclassified' (no block) for a known agent
  // in neither list. codex-reviewer is Claude-first.
  assert.equal(codexReviewer.usage_policy_bucket, 'claude-wins-skip-nvidia');
});

test('every registered agent has a usage-policy bucket (none left not-applicable, audit CF-4-F1)', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const unbucketed = result.agents.filter((a) => a.usage_policy_bucket === 'not-applicable').map((a) => a.slug);
  assert.deepEqual(unbucketed, []);
});

// cc-fix-adapter T6a — real per-agent skills[] from agent-skill-map.json, previously read by
// nothing in this gateway even though agents.mjs already reads the other 3 sibling config files.
test('build-boss carries its real CORE skill list from agent-skill-map.json', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  assert.equal(result.sources.skill_map_present, true);
  const buildBoss = result.agents.find((a) => a.slug === 'build-boss');
  assert.ok(buildBoss);
  // 2026-09-23 (external audit II-D): the map used to name four skills that exist only in the author's global
  // ~/.claude; they were remapped to the shipped Forge equivalents. This pin follows the real file.
  // two vendored public skills (mattpocock/skills, MIT) now ship with Forge and
  // are attached to build-boss; setup-pre-commit is user-invoked only (see agent-skill-map.json invocationNotes).
  // the pin went stale every time the map grew (forge-conduct,
  // forge-testing, ponytail, forge-android-app). It now follows the real file exactly, which is what this test
  // claims: the registry carries the map's list for build-boss, in order, nothing invented.
  const realMap = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'config', 'agents', 'agent-skill-map.json'), 'utf8'));
  const realList = (realMap.skillMap || realMap.agents || realMap)['build-boss'];
  assert.ok(Array.isArray(realList) && realList.length > 0, 'agent-skill-map.json must carry a build-boss list');
  assert.ok(realList.includes('forge-debug') && realList.includes('forge-code-review'), 'build-boss keeps its core skills');
  assert.deepEqual(buildBoss.skills, realList);
});

test('an agent with no entry in agent-skill-map.json gets an honest empty list, never a guess', (t) => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  // 'unmapped' is now read from the real map (the map grew past the 12 Bosses, so a fixed Boss
  // list no longer named an agent without an entry). When every agent has an entry there is nothing to test.
  const realMap = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'config', 'agents', 'agent-skill-map.json'), 'utf8'));
  const mapped = realMap.agents || {};
  const unmapped = result.agents.find((a) => !Object.prototype.hasOwnProperty.call(mapped, a.slug));
  if (!unmapped) { t.skip('every agent in this project has an agent-skill-map.json entry'); return; }
  assert.deepEqual(unmapped.skills, []);
});

// WP-CC1 (item 6) — display_name/aliases, and live status merged from the run-log dispatch view.
test('display_name comes from the registry (e.g. "Build Boss"), separate from the unchanged slug `name`', () => {
  const root = freshRoot();
  writeAgentMd(root, 'build-boss', { name: 'build-boss', description: 'x' });
  writeRegistry(root, { 'build-boss': { name: 'Build Boss', role: 'Implementation / coding' } });

  const result = buildAgentsRegistry(root);
  const bb = result.agents.find((a) => a.slug === 'build-boss');
  assert.equal(bb.name, 'build-boss', 'the existing `name` field must stay the slug, unchanged');
  assert.equal(bb.display_name, 'Build Boss');
  assert.deepEqual(bb.aliases, ['build-boss', 'Build Boss']);
});

test('an agent outside the registry (a specialist) falls back to its own slug for display_name/aliases, never a guess', () => {
  const root = freshRoot();
  writeAgentMd(root, 'codex-reviewer', { name: 'codex-reviewer', description: 'x' });
  writeRegistry(root, {});

  const result = buildAgentsRegistry(root);
  const cr = result.agents.find((a) => a.slug === 'codex-reviewer');
  assert.equal(cr.display_name, 'codex-reviewer');
  assert.deepEqual(cr.aliases, ['codex-reviewer']);
});

test('is_running/live_dispatches merge real run-log liveness when a projectName is given', () => {
  const root = freshRoot();
  writeAgentMd(root, 'build-boss', { name: 'build-boss', description: 'x' });
  writeRegistry(root, { 'build-boss': { name: 'Build Boss' } });
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-live-run', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd1', timestamp: nowIso },
  ]);

  const withName = buildAgentsRegistry(root, 'some-project-name');
  const bb = withName.agents.find((a) => a.slug === 'build-boss');
  assert.equal(bb.is_running, true);
  assert.equal(bb.running_dispatch_count, 1);
  assert.equal(bb.live_dispatches.length, 1);
  assert.equal(bb.live_dispatches[0].source, 'run-log');

  // Omitting projectName (every OTHER existing call site) keeps the static registry behavior
  // exactly as before — honest false/empty, never a guess.
  const withoutName = buildAgentsRegistry(root);
  const bb2 = withoutName.agents.find((a) => a.slug === 'build-boss');
  assert.equal(bb2.is_running, false);
  assert.deepEqual(bb2.live_dispatches, []);
});
