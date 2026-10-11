// feat-agent-model-edit: unit tests for agents-write.mjs's patchAgentModel() against a fully
// TEMPORARY project fixture — never the real project's own .claude/config/agents/agent-model-map.json.
// The fixture mirrors the REAL file's hand-formatted, one-agent-per-line shape (verified by reading
// the real file before writing agents-write.mjs) so the line-level regex path this module depends
// on is exercised exactly as it runs in production.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  patchAgentModel,
  _setAuditLogFileForTests,
  _resetAuditLogFileForTests,
} from '../src/agents-write.mjs';

const FIXTURE_TEXT = [
  '{',
  '  "_doc": "test fixture — mirrors the real hand-formatted one-line-per-agent shape",',
  '  "agents": {',
  '    "boss":       { "claudeTier": "opus",   "claudeEffort": "high", "nvidia": "default", "premium": "opus",   "why": "orchestration", "prohibited": ["vision-only"] },',
  '    "build-boss": { "claudeTier": "sonnet", "nvidia": "coding",  "premium": "opus",   "why": "implementation", "prohibited": ["non-coding"] },',
  '    "docs-boss":  { "claudeTier": "haiku",  "nvidia": "fast",    "premium": "sonnet", "why": "cheap docs work", "prohibited": [] }',
  '  },',
  '  "validation": "test-only marker field"',
  '}',
  '',
].join('\n');

let tempRoot;
let auditLogFile;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-agentwrite-test-'));
  const configDir = path.join(tempRoot, '.claude', 'config', 'agents');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agent-model-map.json'), FIXTURE_TEXT, 'utf8');
  auditLogFile = path.join(tempRoot, 'audit.jsonl');
  _setAuditLogFileForTests(auditLogFile);
});

after(() => {
  _resetAuditLogFileForTests();
});

function modelMapPath(root) {
  return path.join(root, '.claude', 'config', 'agents', 'agent-model-map.json');
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

test('a valid claudeTier change actually persists and is re-readable from disk', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'test-project', slug: 'build-boss', patch: { claudeTier: 'opus' } });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.model_tier, 'opus');
  assert.equal(result.body.claude_effort, null); // build-boss never had claudeEffort set

  const onDisk = JSON.parse(fs.readFileSync(modelMapPath(tempRoot), 'utf8'));
  assert.equal(onDisk.agents['build-boss'].claudeTier, 'opus');
  cleanup(tempRoot);
});

test('other fields of the patched agent — and every other agent — stay byte-identical', () => {
  const before2 = fs.readFileSync(modelMapPath(tempRoot), 'utf8');
  patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'build-boss', patch: { claudeTier: 'opus' } });
  const afterText = fs.readFileSync(modelMapPath(tempRoot), 'utf8');

  const beforeLines = before2.split('\n');
  const afterLines = afterText.split('\n');
  assert.equal(afterLines.length, beforeLines.length, 'line count must be unchanged');

  let changedLineCount = 0;
  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) changedLineCount += 1;
  }
  assert.equal(changedLineCount, 1, 'exactly one line may differ');

  // The changed line differs ONLY inside the claudeTier value — same prefix/suffix around it.
  const changedIndex = beforeLines.findIndex((l, i) => l !== afterLines[i]);
  assert.equal(beforeLines[changedIndex].replace('"sonnet"', '"opus"'), afterLines[changedIndex]);

  // The other two agents' lines are present, unchanged, verbatim.
  assert.ok(afterLines.some((l) => l.includes('"boss"') && l.includes('"claudeEffort": "high"')));
  assert.ok(afterLines.some((l) => l.includes('"docs-boss"') && l.includes('"claudeTier": "haiku"')));
  cleanup(tempRoot);
});

test('a backup of the ORIGINAL bytes is created before the write', () => {
  const original = fs.readFileSync(modelMapPath(tempRoot), 'utf8');
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'docs-boss', patch: { claudeTier: 'sonnet' } });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.body.backup_path), 'backup file must exist');
  assert.ok(result.body.backup_path.includes(path.join('.claude', 'forge-backups')));
  const backupText = fs.readFileSync(result.body.backup_path, 'utf8');
  assert.equal(backupText, original, 'backup must hold the pre-write bytes exactly');
  cleanup(tempRoot);
});

test('an audit trail line is appended with agent + old + new value', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'demo-project', slug: 'build-boss', patch: { claudeTier: 'opus' } });
  assert.equal(result.body.audit_logged, true);
  const lines = fs.readFileSync(auditLogFile, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.event_type, 'file_changed');
  assert.equal(entry.agent, 'build-boss');
  assert.equal(entry.project, 'demo-project');
  assert.deepEqual(entry.changes.claudeTier, { old: 'sonnet', new: 'opus' });
  cleanup(tempRoot);
});

test('an unknown agent slug is rejected with 404 and nothing is written', () => {
  const before2 = fs.readFileSync(modelMapPath(tempRoot), 'utf8');
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'nonexistent-boss', patch: { claudeTier: 'opus' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.match(result.body.error, /unknown agent slug/);
  assert.equal(fs.readFileSync(modelMapPath(tempRoot), 'utf8'), before2);
  cleanup(tempRoot);
});

test('an invalid value (not a real value anywhere in the file) is rejected with 400, nothing written', () => {
  const before2 = fs.readFileSync(modelMapPath(tempRoot), 'utf8');
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'build-boss', patch: { claudeTier: 'gpt-mega-9000' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /must be one of the real values/);
  assert.equal(fs.readFileSync(modelMapPath(tempRoot), 'utf8'), before2);
  cleanup(tempRoot);
});

test('requesting a field that is not currently set for this agent (claudeEffort on docs-boss) is rejected with 400', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'docs-boss', patch: { claudeEffort: 'high' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /not currently set/);
  cleanup(tempRoot);
});

test('an unknown field in the patch is rejected with 400', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'boss', patch: { nvidia: 'reasoning' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /unknown field/);
  cleanup(tempRoot);
});

test('an empty patch object is rejected with 400', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'boss', patch: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /at least one of/);
  cleanup(tempRoot);
});

test('SECURITY: a slug with path-traversal characters is rejected before any file is touched', () => {
  const before2 = fs.readFileSync(modelMapPath(tempRoot), 'utf8');
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: '../../evil', patch: { claudeTier: 'opus' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /invalid agent slug/);
  assert.equal(fs.readFileSync(modelMapPath(tempRoot), 'utf8'), before2);
  assert.equal(fs.existsSync(path.join(tempRoot, 'evil')), false);
  cleanup(tempRoot);
});

test('setting the same value again is a real 200 no-op, honestly reported (old === new)', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'boss', patch: { claudeTier: 'opus' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.body.changed.claudeTier, { old: 'opus', new: 'opus' });
  cleanup(tempRoot);
});

test('both claudeTier and claudeEffort can be changed together in one call', () => {
  const result = patchAgentModel({ projectPath: tempRoot, projectName: 'p', slug: 'boss', patch: { claudeTier: 'sonnet', claudeEffort: 'high' } });
  assert.equal(result.ok, true);
  assert.equal(result.body.model_tier, 'sonnet');
  assert.equal(result.body.claude_effort, 'high');
  const onDisk = JSON.parse(fs.readFileSync(modelMapPath(tempRoot), 'utf8'));
  assert.equal(onDisk.agents.boss.claudeTier, 'sonnet');
  assert.equal(onDisk.agents.boss.nvidia, 'default'); // untouched sibling field
  cleanup(tempRoot);
});

test('a missing agent-model-map.json is reported as a real 404, not a crash', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-agentwrite-empty-'));
  const result = patchAgentModel({ projectPath: emptyRoot, projectName: 'p', slug: 'boss', patch: { claudeTier: 'opus' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  cleanup(emptyRoot);
});

// GOAT model routing (fixer 2026-10-06): in a project with .claude/FORGE_MODEL_ROUTING.json the dashboard
// editor must not drift agent-model-map.json away from the agent frontmatter / agent-tool-policy.json —
// forge-doctor's ENFORCED model_routing check would turn red. A real change is refused (409), a no-op is
// still fine, and the project's own routing check stays green afterwards.
const GOAT_ROUTES = {
  router: { model: 'sonnet', effort: 'medium' }, triage: { model: 'sonnet', effort: 'low' },
  quick: { model: 'sonnet', effort: 'low' }, build: { model: 'opus', effort: 'medium' },
  deep: { model: 'opus', effort: 'xhigh' }, escalate: { model: 'fable', effort: 'high' },
  verifier: { model: 'sonnet', effort: 'medium' },
};
const GOAT_AGENTS = { boss: ['deep', 'opus', 'xhigh'], 'build-boss': ['build', 'opus', 'medium'], 'docs-boss': ['quick', 'sonnet', 'low'] };

function writeGoatProject(root) {
  const claude = path.join(root, '.claude');
  fs.mkdirSync(path.join(claude, 'config', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  const agentDefaults = Object.fromEntries(Object.entries(GOAT_AGENTS).map(([a, [route]]) => [a, route]));
  // A complete GOAT project carries session.lead (the router) — routingCheck validates it since Codex F4.
  const session = { lead: { route: 'router', model: 'sonnet', effort: 'medium' } };
  fs.writeFileSync(path.join(claude, 'FORGE_MODEL_ROUTING.json'), JSON.stringify({ session, routes: GOAT_ROUTES, agentDefaults }, null, 2));
  const mapLines = Object.entries(GOAT_AGENTS).map(([a, [, m, e]], i, arr) => '    "' + a + '": { "claudeTier": "' + m + '", "claudeEffort": "' + e + '", "nvidia": "default" }' + (i < arr.length - 1 ? ',' : ''));
  fs.writeFileSync(path.join(claude, 'config', 'agents', 'agent-model-map.json'), ['{', '  "agents": {', ...mapLines, '  }', '}', ''].join('\n'));
  const policyAgents = Object.fromEntries(Object.entries(GOAT_AGENTS).map(([a, [, m]]) => [a, { class: 'x', tools: ['Read'], model: m }]));
  fs.writeFileSync(path.join(claude, 'config', 'agents', 'agent-tool-policy.json'), JSON.stringify({ agents: policyAgents }, null, 2));
  for (const [a, [, m, e]] of Object.entries(GOAT_AGENTS)) {
    fs.writeFileSync(path.join(claude, 'agents', a + '.md'), '---\nname: ' + a + '\ntools: Read\nmodel: ' + m + '\neffort: ' + e + '\n---\n\nbody\n');
  }
}

const POLICY_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude', 'forge-bin', 'forge-policy.cjs');
function policyCheckExit(root) {
  return spawnSync(process.execPath, [POLICY_SCRIPT, 'check', '--root', root], { encoding: 'utf8' });
}
const policyCheckAvailable = fs.existsSync(POLICY_SCRIPT) && /routingCheck/.test(fs.readFileSync(POLICY_SCRIPT, 'utf8'));

test('GOAT project: a real model/effort change is refused (409), nothing is written, and the routing check stays green', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-agentwrite-goat-'));
  t.after(() => cleanup(root));
  writeGoatProject(root);
  const before = fs.readFileSync(modelMapPath(root), 'utf8');
  for (const patch of [{ claudeTier: 'sonnet' }, { claudeEffort: 'low' }, { claudeTier: 'opus', claudeEffort: 'xhigh' }]) {
    const result = patchAgentModel({ projectPath: root, projectName: 'p', slug: 'build-boss', patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.status, 409);
    assert.match(result.body.error, /GOAT model routing/);
  }
  assert.equal(fs.readFileSync(modelMapPath(root), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'forge-backups')), false);
  if (!policyCheckAvailable) { t.diagnostic('forge-policy.cjs check not found next to this command-center — routing-check half skipped'); return; }
  const r = policyCheckExit(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('GOAT project: a no-op PATCH (current values) is still accepted and keeps the routing check green', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-agentwrite-goat-noop-'));
  t.after(() => cleanup(root));
  writeGoatProject(root);
  const result = patchAgentModel({ projectPath: root, projectName: 'p', slug: 'build-boss', patch: { claudeTier: 'opus', claudeEffort: 'medium' } });
  assert.equal(result.ok, true);
  assert.equal(result.body.model_tier, 'opus');
  if (!policyCheckAvailable) return;
  const r = policyCheckExit(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
