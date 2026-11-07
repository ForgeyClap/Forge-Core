// WP B3 (plan 4.4): exec-argv.mjs adds `--permission-prompt-tool mcp__forge-ask__permission_prompt`
// next to the per-turn forge-ask MCP config, so a tool call that needs permission in -p mode reaches
// the user instead of being denied.
//
// GROUND TRUTH (measured 2026-11-02 on this machine, claude CLI 2.1.316): `claude --help` names the
// flag only inside the description of --permission-prompts; HELP_2_1_316 below is copied from that
// real output. The help-based detection (substring) still finds it there.
// No real `claude` is invoked: help text is injected and the CLI path is pinned to node.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpawnSpec,
  resolvePermissionPromptArgs,
  PERMISSION_PROMPT_TOOL_REF,
  _buildRealArgsForTests,
  _setAskMcpConfigDirForTests,
} from '../src/exec-argv.mjs';
import { _setClaudeCliHelpTextForTests, _resetClaudeCliHelpForTests } from '../src/exec-cli.mjs';

const HELP_2_1_316 = [
  '  --permission-mode <mode>              Permission mode to use for the session',
  '                                        (choices: "acceptEdits", "auto",',
  '                                        "bypassPermissions", "manual",',
  '                                        "dontAsk", "plan")',
  '  --permission-prompts <target>         Who answers permission prompts with',
  '                                        --print: "host" (the SDK host or',
  '                                        --permission-prompt-tool) or "none"',
  '      --forward-subagent-text          Forward subagent text',
  '      --include-hook-events            Include all hook lifecycle events',
].join('\n');
const HELP_OLD = '  -p, --print                          Print response and exit';

const ASK = { convId: 'c-1', turnId: 't-1', requestId: 'r-1' };
let tempDir;
const saved = {};

before(() => {
  for (const k of ['CC_EXEC_MOCK', 'CC_CLAUDE_CLI_PATH', 'CC_EXEC_PERMISSION_PROMPT', 'CC_EXEC_STREAM_VISIBILITY']) saved[k] = process.env[k];
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_STREAM_VISIBILITY;
  process.env.CC_CLAUDE_CLI_PATH = process.execPath;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-argv-'));
  _setAskMcpConfigDirForTests(tempDir);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetClaudeCliHelpForTests();
  _setAskMcpConfigDirForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  delete process.env.CC_EXEC_PERMISSION_PROMPT;
  _setClaudeCliHelpTextForTests(HELP_2_1_316);
});

test('the tool ref addresses the forge-ask server\'s permission_prompt tool', () => {
  assert.equal(PERMISSION_PROMPT_TOOL_REF, 'mcp__forge-ask__permission_prompt');
});

test('accept-edits + ask config: the flag sits right after --strict-mcp-config, before the visibility flags', () => {
  const spec = buildSpawnSpec('hello', 'accept-edits', undefined, undefined, ASK);
  const strict = spec.args.indexOf('--strict-mcp-config');
  assert.deepEqual(spec.args.slice(strict + 1, strict + 3), ['--permission-prompt-tool', 'mcp__forge-ask__permission_prompt']);
  assert.ok(spec.args.indexOf('--forward-subagent-text') > strict + 2);
  assert.deepEqual(spec.args.slice(0, 7), ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
});

test('bypass (trusted project) and execute also get the prompt tool; plan mode never does', () => {
  assert.ok(buildSpawnSpec('hello', 'bypass', undefined, undefined, ASK).args.includes('--permission-prompt-tool'));
  assert.ok(buildSpawnSpec('hello', 'execute', undefined, undefined, ASK).args.includes('--permission-prompt-tool'));
  assert.equal(buildSpawnSpec('hello', 'plan', undefined, undefined, ASK).args.includes('--permission-prompt-tool'), false);
});

test('without the ask config (no conversation) there is no tool to name, so no flag', () => {
  assert.equal(buildSpawnSpec('hello', 'accept-edits', undefined, undefined).args.includes('--permission-prompt-tool'), false);
});

test('an older CLI that does not document the flag never receives it (it would exit with a usage error)', () => {
  _setClaudeCliHelpTextForTests(HELP_OLD);
  assert.deepEqual(resolvePermissionPromptArgs('accept-edits'), []);
  _setClaudeCliHelpTextForTests(null); // help unreadable
  assert.deepEqual(resolvePermissionPromptArgs('accept-edits'), []);
});

test('CC_EXEC_PERMISSION_PROMPT: on forces it, off removes it, anything else = auto', () => {
  _setClaudeCliHelpTextForTests(HELP_OLD);
  process.env.CC_EXEC_PERMISSION_PROMPT = 'on';
  assert.deepEqual(resolvePermissionPromptArgs('accept-edits'), ['--permission-prompt-tool', 'mcp__forge-ask__permission_prompt']);
  assert.deepEqual(resolvePermissionPromptArgs('plan'), [], 'plan stays without it even when forced on');
  _setClaudeCliHelpTextForTests(HELP_2_1_316);
  process.env.CC_EXEC_PERMISSION_PROMPT = 'off';
  assert.deepEqual(resolvePermissionPromptArgs('accept-edits'), []);
  process.env.CC_EXEC_PERMISSION_PROMPT = 'banana';
  assert.equal(resolvePermissionPromptArgs('accept-edits').length, 2);
});

test('REGRESSION: the base argv builder itself is unchanged (mode mapping, no prompt flag inside it)', () => {
  assert.deepEqual(_buildRealArgsForTests('hello', 'accept-edits'), ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(_buildRealArgsForTests('hello', 'bypass'), ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']);
});

test('REGRESSION: still never an --allowed-tools/--disallowedTools flag next to the MCP config', () => {
  const spec = buildSpawnSpec('hello', 'accept-edits', undefined, undefined, ASK);
  assert.ok(!spec.args.some((a) => typeof a === 'string' && /allow.?tool/i.test(a)));
});
