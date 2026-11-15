// CF-5-F4: every REAL dashboard/phone turn asks forge-run-budget.cjs for its per-run dollar cap (wrapper "gateway") and
// carries `--max-budget-usd <n>`, with one plain budget line for the log. A cap that cannot be read never blocks the
// turn: no flag, and the line says why. No real `claude` CLI runs here: the help text is injected and the budget script
// is a tiny fixture in a temp folder (the real script is used only when the Forge tree is present next to this repo).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpawnSpec,
  resolveRunBudget,
  RUN_BUDGET_SCRIPT,
  _setRunBudgetScriptForTests,
  _setAskMcpConfigDirForTests,
} from '../src/exec-argv.mjs';
import { _setClaudeCliHelpTextForTests, _resetClaudeCliHelpForTests } from '../src/exec-cli.mjs';

const HELP_WITH_BUDGET = '  -p, --print   Print response and exit\n  --max-budget-usd <amount>   Maximum dollar amount to spend on API calls\n';
const HELP_WITHOUT_BUDGET = '  -p, --print   Print response and exit\n';

let dir;
let saved;
function script(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

before(() => {
  saved = { mock: process.env.CC_EXEC_MOCK, cli: process.env.CC_CLAUDE_CLI_PATH };
  delete process.env.CC_EXEC_MOCK;
  process.env.CC_CLAUDE_CLI_PATH = process.execPath;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-run-budget-'));
  _setAskMcpConfigDirForTests(dir);
});
beforeEach(() => { _setClaudeCliHelpTextForTests(HELP_WITH_BUDGET); _setRunBudgetScriptForTests(null); });
after(() => {
  _setRunBudgetScriptForTests(null);
  _setAskMcpConfigDirForTests(null);
  _resetClaudeCliHelpForTests();
  if (saved.mock === undefined) delete process.env.CC_EXEC_MOCK; else process.env.CC_EXEC_MOCK = saved.mock;
  if (saved.cli === undefined) delete process.env.CC_CLAUDE_CLI_PATH; else process.env.CC_CLAUDE_CLI_PATH = saved.cli;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cap is asked for wrapper "gateway" and lands at the END of the argv, with a budget line', () => {
  const argsFile = path.join(dir, 'argv.json');
  _setRunBudgetScriptForTests(script('cap-ok.cjs',
    "require('fs').writeFileSync(" + JSON.stringify(argsFile) + ", JSON.stringify(process.argv.slice(2)));"
    + "process.stderr.write('forge-run-budget: cap $3.5 (source config.wrappers.gateway)\\n'); process.stdout.write('3.5\\n');"));
  const b = resolveRunBudget();
  assert.deepEqual(b.args, ['--max-budget-usd', '3.5']);
  assert.match(b.line, /capped at \$3\.5/);
  assert.match(b.line, /config\.wrappers\.gateway/);
  const called = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepEqual(called.slice(0, 3), ['cap', '--wrapper', 'gateway']);
  assert.ok(called.includes('--root'));
  const spec = buildSpawnSpec('hello', 'default', null, null, null);
  assert.deepEqual(spec.args.slice(-2), ['--max-budget-usd', '3.5']);
  assert.deepEqual(spec.args.slice(0, 5), ['-p', 'hello', '--output-format', 'stream-json', '--verbose']);
  const withAsk = buildSpawnSpec('hello', 'default', null, null, { convId: 'c1', turnId: 't1', requestId: 'r1' });
  assert.deepEqual(withAsk.args.slice(-2), ['--max-budget-usd', '3.5']);
  assert.ok(withAsk.args.indexOf('--max-budget-usd') > withAsk.args.indexOf('--strict-mcp-config'));
});

test('a cap that cannot be resolved never blocks the turn: no flag, and the line says why', () => {
  _setRunBudgetScriptForTests(script('cap-fail.cjs', "process.stderr.write('forge-run-budget: could not resolve a usable cap\\n'); process.exit(1);"));
  let b = resolveRunBudget();
  assert.deepEqual(b.args, []);
  assert.match(b.line, /NOT capped/);
  assert.match(b.line, /could not resolve a usable cap/);
  const spec = buildSpawnSpec('hello', 'default', null, null, null);
  assert.ok(!spec.args.includes('--max-budget-usd'));

  _setRunBudgetScriptForTests(script('cap-junk.cjs', "process.stdout.write('lots\\n');"));
  b = resolveRunBudget();
  assert.deepEqual(b.args, []);
  assert.match(b.line, /NOT capped/);

  _setRunBudgetScriptForTests(path.join(dir, 'missing-script.cjs'));
  b = resolveRunBudget();
  assert.deepEqual(b.args, []);
  assert.match(b.line, /NOT capped/);
});

test('an older CLI that does not document --max-budget-usd is never handed it (and the script is not even run)', () => {
  _setClaudeCliHelpTextForTests(HELP_WITHOUT_BUDGET);
  const ran = path.join(dir, 'ran.txt');
  _setRunBudgetScriptForTests(script('cap-spy.cjs', "require('fs').writeFileSync(" + JSON.stringify(ran) + ", 'x'); process.stdout.write('3\\n');"));
  const b = resolveRunBudget();
  assert.deepEqual(b.args, []);
  assert.match(b.line, /NOT capped/);
  assert.equal(fs.existsSync(ran), false);
});

test('mock mode never asks for a cap', () => {
  process.env.CC_EXEC_MOCK = '1';
  try {
    const spec = buildSpawnSpec('hello', 'default', null, null, null);
    assert.ok(!spec.args.includes('--max-budget-usd'));
  } finally { delete process.env.CC_EXEC_MOCK; }
});

test('the real forge-run-budget.cjs (when the Forge tree is next to this repo) yields a positive cap', { skip: !fs.existsSync(RUN_BUDGET_SCRIPT) && 'no Forge tree next to this checkout' }, () => {
  const b = resolveRunBudget();
  assert.equal(b.args[0], '--max-budget-usd');
  assert.ok(Number(b.args[1]) > 0, 'cap must be a positive number, got ' + b.args[1]);
});
