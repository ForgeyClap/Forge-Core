// WP-AUTONOMY-GW, verify round 6. Each row marked RED was run against the code before this
// round and was auto-approved there (code 'routine'); the fix makes it wait for the owner.
//   HIGH-1   a write to a file a Forge or GOAT hook runs or takes a command from: .claude/goat-gate*.json (the
//            Stop gate runs its "command"), .claude/forge-dashboard/*.cjs (log-event.cjs), .claude/forge-bin/**,
//            .claude/hooks/**, and FORGE_CONFIG_SCHEMA.json (the default of the gate-hook switch). Code 'settings'.
//   HIGH-2   write-then-run: a test runner, build, lint or typecheck (node --test, vitest, jest via npm, eslint,
//            tsc, vite build, npm test / npm run build|lint|typecheck, npx ...) executes the project's code and
//            config. After a routine step wrote such a file (a Write/Edit, or a shell redirect or copy, also one
//            Claude Code accepted itself and the gateway only saw in the stream) it asks with code
//            'wrote_code', until the owner approves one of those cards. Kept per project folder by
//            permissions/store.mjs and passed to the classifier as `codeWritten`; one command that writes
//            and then runs is judged on its own. Runner config files (vitest, vite, jest, eslint, babel, mocha,
//            webpack) ask on every write ('auto_run').
//   MEDIUM-3 instructions a later session or another agent loads by itself: .claude/rules/**,
//            FORGE_MODEL_ROUTING.json, FORGE_SESSION_STATE.json ('settings'); AGENTS.md, GEMINI.md,
//            .cursorrules, .windsurfrules, .cursor/**, .github/copilot-instructions.md, .codex/**, .gemini/**,
//            .vscode/{mcp,tasks,launch,settings}.json ('auto_run'). Kept routine on purpose in round 6: .claude/agent-memory/**
//            and FORGE_MEMORY.md (Forge itself writes them at the end of every run). Round 7 (M4) changed that: a Write
//            of them asks; Forge's own path, forge-run-file.cjs append, is routine.
//   MEDIUM-4 credential-named files, read or written: service accounts, terraform vars and state, wp-config,
//            .htpasswd, docker/s3/vault files, database configs, production app settings, keystores, key
//            stores, certificates, gpg, databases and dumps, bare credentials/token/apikey files, known_hosts,
//            shell and REPL histories. `.env.example` stays routine. (The Read and Write rows are RED; for a few
//            names the shell forms were already caught by forge-actiongate.cjs, so those rows carry no RED.)
//   MEDIUM-5 every read or search inside .git (HEAD, FETCH_HEAD, packed-refs, logs, objects): git itself
//            (status, diff, log) stays routine.
//   LOW      writes of git-hook managers, CI workflows, Makefile, package.json, setup.py, conftest.py,
//            sitecustomize.py, postinstall.js, .pnpmfile.cjs, .yarn/plugins/**, .yarnrc ('auto_run'); `which`
//            and `type` (install paths) ask; git ls-files/ls-tree/status with a path outside the project ask;
//            a PowerShell argument that starts with a quote and goes on after it (`".e"+"nv"`, `'.e'nv`) or a
//            quote inside a quoted name (`'.en''v'`) is read differently by PowerShell: 'unjudgeable'.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyHardGate, HARD_GATE_REASONS } from '../src/permissions/hard-gate.mjs';
import * as hardGate from '../src/permissions/hard-gate.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import {
  createPermissionRequest, answerPermission, listPendingPermissions, observeStreamLine, registerPermissionRun,
  setPermissionAutonomy, _resetPermissionStoreForTests, _setFirstRunnerForTests,
} from '../src/permissions/store.mjs';
// Round 11: these suites test the write marks alone; the first-runner rule has its own tests (permissions-round11).
_setFirstRunnerForTests(false);
import { isAutonomyOn, _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';

const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round6-')));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// P: a project that is its own repository. Its .git holds no config file, so a search inside it found no
// "secret" before this round (the probe's shape). SCRIPTS: what npm test / npm run would run.
const P = path.join(BASE, 'proj');
const OUT = path.join(BASE, 'outside');
const SCRIPTS = { test: 'node --test', build: 'tsc --noEmit', lint: 'eslint .', typecheck: 'tsc --noEmit' };
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
put(path.join(P, '.git', 'FETCH_HEAD'), "abc123\tbranch 'main' of https://tok@example.invalid/x/y\n");
put(path.join(P, '.git', 'packed-refs'), '# pack-refs\n');
put(path.join(P, '.git', 'logs', 'HEAD'), '0000 abc commit: x\n');
put(path.join(P, '.git', 'objects', 'ab', 'cdef01'), 'blob');
put(path.join(P, 'package.json'), JSON.stringify({ name: 'p', scripts: SCRIPTS }));
put(path.join(P, 'node_modules', '.bin', 'vitest'));
put(path.join(P, 'node_modules', '.bin', 'vitest.cmd'));
for (const bin of ['tsc', 'eslint']) put(path.join(P, 'node_modules', '.bin', bin));
put(path.join(P, 'src', 'a.js'));
put(path.join(P, 'src', 'a.test.js'));
put(path.join(P, '.gitignore'), 'node_modules\n');
put(path.join(P, 'CLAUDE.md'), '# rules\n');
put(path.join(OUT, 'a.txt'), 'OUTSIDE\n');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const OPTS = { cwd: P, home: HOME, tmp: TMP };
const WROTE = { ...OPTS, codeWritten: true };
const sh = (command) => ['Bash', { command }];
const ps = (command) => ['PowerShell', { command }];
const write = (rel) => ['Write', { file_path: path.join(P, rel), content: 'x' }];
const edit = (rel) => ['Edit', { file_path: path.join(P, rel), old_string: 'a', new_string: 'b' }];
const read = (rel) => ['Read', { file_path: path.join(P, rel) }];
const run = ([tool, input], opts = OPTS) => classifyHardGate(tool, input, opts);

function expectHard(label, call, code, opts = OPTS) {
  test(label, () => {
    const got = run(call, opts);
    assert.equal(got.hard, true, JSON.stringify({ call, got }));
    assert.notEqual(got.code, 'routine');
    if (code) assert.equal(got.code, code, JSON.stringify({ call, got }));
  });
}
function expectRoutine(label, call, opts = OPTS) {
  test(label, () => {
    const got = run(call, opts);
    assert.equal(got.code, 'routine', JSON.stringify({ call, got }));
  });
}

// ---------------------------------------------------------------- HIGH-1: files a hook runs
for (const rel of ['.claude/goat-gate.json', '.CLAUDE/GOAT-GATE.JSON', '.claude/goat-gate-trust.json', 'sub/.claude/goat-gate.json',
  '.claude/forge-dashboard/log-event.cjs', '.claude/forge-dashboard/x.cjs', '.claude/forge-dashboard/start-forge-dashboard.bat',
  '.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json']) {
  expectHard('HIGH-1 RED Write ' + rel + ' is settings', write(rel), 'settings');
  expectHard('HIGH-1 RED Edit ' + rel + ' is settings', edit(rel), 'settings');
}
expectHard('HIGH-1 RED echo into .claude/goat-gate.json is settings', sh(`echo '{"command":"calc"}' > .claude/goat-gate.json`), 'settings');
expectHard('HIGH-1 RED printf into .claude/goat-gate.json is settings', sh(`printf '{"mode":"command","command":"calc"}' > .claude/goat-gate.json`), 'settings');
expectHard('HIGH-1 RED a heredoc into .claude/goat-gate.json is settings', sh("cat <<'EOF' > .claude/goat-gate.json\n{\"command\":\"calc\"}\nEOF"), 'settings');
expectHard('HIGH-1 RED echo into log-event.cjs is settings', sh('echo x > .claude/forge-dashboard/log-event.cjs'), 'settings');
expectHard('HIGH-1 RED PowerShell redirect into goat-gate.json is settings', ps("'x' > .claude\\goat-gate.json"), 'settings');
expectHard('HIGH-1 RED node -e writing goat-gate.json is settings', sh(`node -e "require('fs').writeFileSync('.claude/goat-gate.json','{}')"`), 'settings');
// guards: the folders were protected before this round, and data next to the dashboard stays routine
expectHard('HIGH-1 Write .claude/forge-bin/x.cjs stays settings', write('.claude/forge-bin/x.cjs'), 'settings');
expectHard('HIGH-1 Write .claude/hooks/h.cjs stays settings', write('.claude/hooks/h.cjs'), 'settings');
expectRoutine('HIGH-1 Write .claude/forge-dashboard/README.md stays routine', write('.claude/forge-dashboard/README.md'));
expectRoutine('HIGH-1 Read .claude/goat-gate.json stays routine', read('.claude/goat-gate.json'));
expectRoutine('HIGH-1 running log-event.cjs is not a write of it', sh('node --version'));

// ---------------------------------------------------------------- HIGH-2: write-then-run
const RUNNERS = [
  sh('node --test'), sh('node --test src'), sh('node --test src/a.test.js'), sh('vitest run'), sh('vitest run --config vitest.config.js'),
  sh('eslint .'), sh('tsc --noEmit'), sh('tsc --noEmit -p .'), sh('vite build'), sh('npm test'), sh('npm run test'), sh('npm run build'),
  sh('npm run lint'), sh('npm run typecheck'), sh('npx vitest run'), sh('npx tsc --noEmit'), sh('npx eslint .'),
  ps('node --test'), ps('npm test'), sh('cd ./src && node --test'),
];
for (const call of RUNNERS) {
  expectRoutine('HIGH-2 nothing written: ' + call[1].command + ' stays routine', call);
  expectHard('HIGH-2 RED after a write: ' + call[1].command + ' asks (wrote_code)', call, 'wrote_code', WROTE);
}
test('HIGH-2 RED the wrote_code reason tells the owner why it waits', () => {
  assert.equal(typeof HARD_GATE_REASONS.wrote_code, 'string');
  assert.ok(HARD_GATE_REASONS.wrote_code.length > 30);
  assert.equal(run(sh('node --test'), WROTE).reason_nl, HARD_GATE_REASONS.wrote_code);
});
expectRoutine('HIGH-2 after a write, node --version stays routine', sh('node --version'), WROTE);
expectRoutine('HIGH-2 after a write, reading and git stay routine', sh('git status && cat src/a.js'), WROTE);
expectRoutine('HIGH-2 after a write, a read-only Forge tool stays routine', sh('node .claude/forge-bin/forge-runinfo.cjs status'), WROTE);
expectHard('HIGH-2 after a write, a named hard gate keeps its own reason', sh('git push'), 'push', WROTE);
// one command that writes code and then runs it, judged without any store state
expectHard('HIGH-2 RED echo into a test file && node --test asks', sh('echo "x" > src/new.test.js && node --test'), 'wrote_code');
expectHard('HIGH-2 RED a heredoc test file then npm test asks', sh("cat <<'EOF' > src/t.test.js\nx\nEOF\nnpm test"), 'wrote_code');
expectHard('HIGH-2 RED PowerShell: npm test after a redirect into a .js file asks', ps("node --version > src\\v.js; npm test"), 'wrote_code');
expectRoutine('HIGH-2 a note written next to a test run stays routine', sh('echo done > notes.md && node --test'));
expectRoutine('HIGH-2 a runner whose own output goes to a file stays routine', sh('node --test > test-output.json'));
// runner config files ask on every write
for (const rel of ['vitest.config.js', 'vitest.config.mts', 'vite.config.ts', 'jest.config.js', 'jest.config.cjs', 'eslint.config.js', 'eslint.config.mjs',
  '.eslintrc.json', '.eslintrc', 'babel.config.js', '.babelrc', '.mocharc.yml', '.mocharc.js', 'webpack.config.js', 'packages/x/vitest.config.ts']) {
  expectHard('HIGH-2 RED Write ' + rel + ' is auto_run', write(rel), 'auto_run');
}
expectHard('HIGH-2 RED echo into vitest.config.js is auto_run', sh('echo x > vitest.config.js'), 'auto_run');
expectRoutine('HIGH-2 Write tsconfig.json stays routine (tsc runs no code from it)', write('tsconfig.json'));

test('HIGH-2 RED codeWriteTargets names what a call writes (empty for reads, runs and notes)', () => {
  const t = (call) => hardGate.codeWriteTargets(call[0], call[1], OPTS);
  assert.equal(typeof hardGate.codeWriteTargets, 'function');
  assert.ok(t(write('src/a.js')).length > 0, 'Write a .js file');
  assert.ok(t(['MultiEdit', { file_path: path.join(P, 'src', 'a.ts'), edits: [] }]).length > 0, 'MultiEdit a .ts file');
  assert.ok(t(['NotebookEdit', { notebook_path: path.join(P, 'n.ipynb') }]).length > 0, 'NotebookEdit');
  assert.ok(t(sh('echo x > src/a.js')).length > 0, 'a redirect into a .js file');
  assert.ok(t(sh('cp src/a.js src/b.js')).length > 0, 'a copy');
  assert.ok(t(sh("sed -i 's/a/b/' src/a.js")).length > 0, 'sed -i');
  assert.ok(t(ps("Set-Content src\\a.js 'x'")).length > 0, 'Set-Content');
  assert.ok(t(ps("'x' > src\\a.js")).length > 0, 'a PowerShell redirect');
  assert.ok(t(sh(`node -e "require('fs').writeFileSync('src/a.js','x')"`)).length > 0, 'inline code that writes');
  assert.ok(t(sh("bash -c 'echo x > src/a.js'")).length > 0, 'a redirect inside bash -c');
  assert.ok(t(sh('git checkout other-branch')).length > 0, 'a checkout changes the working tree');
  assert.deepEqual(t(write('notes.md')), [], 'a Markdown note runs nowhere');
  assert.deepEqual(t(write('docs/shot.png')), [], 'an image');
  assert.deepEqual(t(sh('echo x > out.log')), [], 'a log file');
  assert.deepEqual(t(sh('echo hi')), []);
  assert.deepEqual(t(sh('node --test 2>&1 | tail -20')), []);
  assert.deepEqual(t(sh('npm test > out.json')), [], 'a runner writing its own output');
  assert.deepEqual(t(sh('git status && git diff')), []);
  assert.deepEqual(t(sh('mkdir -p src/x')), [], 'a new folder holds no code');
  assert.deepEqual(t(read('src/a.js')), []);
});

// ---------------------------------------------------------------- HIGH-2: the store keeps the mark per project folder
describe('HIGH-2 store', () => {
  const PROJECT = 'round6-project';
  const SP = path.join(BASE, 'storeproj');
  const SP2 = path.join(BASE, 'storeproj2');
  for (const dir of [SP, SP2]) {
    put(path.join(dir, 'package.json'), JSON.stringify({ name: 'sp', scripts: { test: 'node --test' } }));
    put(path.join(dir, 'src', 'a.js'));
  }
  before(() => {
    fs.mkdirSync(path.join(BASE, 'conversations'), { recursive: true });
    _setConversationsDirForTests(path.join(BASE, 'conversations'));
  });
  beforeEach(() => {
    _resetPermissionStoreForTests();
    setPermissionAutonomy(isAutonomyOn);
    fs.rmSync(path.join(BASE, 'autonomy'), { recursive: true, force: true });
    fs.mkdirSync(path.join(BASE, 'autonomy'), { recursive: true });
    _setAutonomyDirForTests(path.join(BASE, 'autonomy'));
  });
  after(() => {
    setPermissionAutonomy(null);
    _setAutonomyDirForTests(null);
    _resetConversationsForTests();
    _resetPermissionStoreForTests();
  });
  const conversation = (cwd = SP) => { const id = createConversation({ project: PROJECT }).id; registerPermissionRun(id, { cwd }); return id; };
  const ask = (convId, toolName, input) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName, input });
  const card = (convId, command) => ask(convId, 'Bash', { command });
  const streamWrite = (convId, file, name = 'Write') => observeStreamLine(convId, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2), name, input: { file_path: file, content: 'x' } }] } });
  const pendingCode = (id) => { const c = listPendingPermissions().find((p) => p.id === id); return c ? c.gate.code : null; };

  test('HIGH-2 store guard: nothing written in this project, npm test is allowed at once', () => {
    const r = card(conversation(), 'npm test');
    assert.equal(r.decision && r.decision.behavior, 'allow');
  });

  test('HIGH-2 RED store: an auto-allowed Write of a test file, then node --test waits (wrote_code)', () => {
    const convId = conversation();
    const w = ask(convId, 'Write', { file_path: path.join(SP, 'src', 'evil.test.js'), content: 'x' });
    assert.equal(w.decision && w.decision.behavior, 'allow', 'the write itself is routine');
    const r = card(convId, 'node --test');
    assert.equal(r.decision, undefined, 'the run waits for the owner');
    assert.equal(pendingCode(r.id), 'wrote_code');
  });

  test('HIGH-2 RED store: a Write Claude Code accepted itself (seen only in the stream), then npm test waits', () => {
    const convId = conversation();
    streamWrite(convId, path.join(SP, 'src', 'evil.test.js'));
    const r = card(convId, 'npm test');
    assert.equal(r.decision, undefined);
    assert.equal(pendingCode(r.id), 'wrote_code');
  });

  test('HIGH-2 RED store: a subagent shell redirect seen in the stream marks the project too', () => {
    const convId = conversation();
    observeStreamLine(convId, { type: 'assistant', parent_tool_use_id: 'toolu_parent', message: { content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'echo x > src/b.test.js' } }] } });
    // while a subagent runs, a card without a placed id waits as outside_folder; the main agent's placed
    // runner shows the write mark itself
    observeStreamLine(convId, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_main_npm', name: 'Bash', input: { command: 'npm test' } }] } });
    const r = createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'toolu_main_npm' });
    assert.equal(r.decision, undefined);
    assert.equal(pendingCode(r.id), 'wrote_code');
  });

  test('HIGH-2 RED store: the owner approving the waiting run clears the mark; the next run is allowed', () => {
    const convId = conversation();
    streamWrite(convId, path.join(SP, 'src', 'b.js'));
    const first = card(convId, 'npm test');
    assert.equal(first.decision, undefined);
    assert.equal(answerPermission(first.id, 'allow').ok, true);
    const next = card(convId, 'npm test');
    assert.equal(next.decision && next.decision.behavior, 'allow', 'what the owner approved running is not new code any more');
  });

  test('HIGH-2 RED store: a write after the card was made keeps the mark when the owner approves that card', () => {
    const convId = conversation();
    streamWrite(convId, path.join(SP, 'src', 'b.js'));
    const first = card(convId, 'npm test');
    streamWrite(convId, path.join(SP, 'src', 'c.js'));
    answerPermission(first.id, 'allow');
    const next = card(convId, 'npm test');
    assert.equal(next.decision, undefined, 'c.js was written after the card the owner saw');
    assert.equal(pendingCode(next.id), 'wrote_code');
  });

  test('HIGH-2 RED store: another conversation in the same project folder waits too', () => {
    streamWrite(conversation(), path.join(SP, 'src', 'b.js'));
    const r = card(conversation(), 'node --test');
    assert.equal(r.decision, undefined);
    assert.equal(pendingCode(r.id), 'wrote_code');
  });

  test('HIGH-2 RED store: approving an unrelated card does not clear the mark', () => {
    const convId = conversation();
    streamWrite(convId, path.join(SP, 'src', 'b.js'));
    const push = card(convId, 'git push');
    answerPermission(push.id, 'allow');
    const r = card(convId, 'npm test');
    assert.equal(r.decision, undefined);
  });

  test('HIGH-2 RED store: one command that writes a test file and runs the tests waits', () => {
    const r = card(conversation(), 'echo x > src/t.test.js && node --test');
    assert.equal(r.decision, undefined);
    assert.equal(pendingCode(r.id), 'wrote_code');
  });

  test('HIGH-2 store guard: a write in another project folder does not mark this one', () => {
    streamWrite(conversation(SP2), path.join(SP2, 'src', 'b.js'));
    const r = card(conversation(SP), 'npm test');
    assert.equal(r.decision && r.decision.behavior, 'allow');
  });

  test('HIGH-2 store guard: a Markdown note does not mark the project', () => {
    const convId = conversation();
    streamWrite(convId, path.join(SP, 'NOTES.md'));
    const w = ask(convId, 'Write', { file_path: path.join(SP, 'docs', 'plan.md'), content: 'x' });
    assert.equal(w.decision && w.decision.behavior, 'allow');
    const r = card(convId, 'npm test');
    assert.equal(r.decision && r.decision.behavior, 'allow');
  });

  test('HIGH-2 store guard: test runs with nothing new written stay allowed, again and again', () => {
    const convId = conversation();
    for (const c of ['npm test', 'node --test', 'git status', 'npm test']) {
      const r = card(convId, c);
      assert.equal(r.decision && r.decision.behavior, 'allow', c);
    }
  });
});

// ---------------------------------------------------------------- MEDIUM-3: instructions loaded later
for (const rel of ['.claude/rules/x.md', '.claude/rules/sub/r.md', '.claude/FORGE_MODEL_ROUTING.json', '.claude/FORGE_SESSION_STATE.json']) {
  expectHard('MEDIUM-3 RED Write ' + rel + ' is settings', write(rel), 'settings');
}
expectHard('MEDIUM-3 RED echo into .claude/rules/x.md is settings', sh('echo x > .claude/rules/x.md'), 'settings');
expectHard('MEDIUM-3 RED echo into FORGE_MODEL_ROUTING.json is settings', sh('echo x > .claude/FORGE_MODEL_ROUTING.json'), 'settings');
for (const rel of ['AGENTS.md', 'docs/AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.cursor/rules/x.mdc', '.cursor/mcp.json',
  '.github/copilot-instructions.md', '.codex/config.toml', '.gemini/settings.json', '.gemini/GEMINI.md',
  '.vscode/mcp.json', '.vscode/tasks.json', '.vscode/launch.json', '.vscode/settings.json']) {
  expectHard('MEDIUM-3 RED Write ' + rel + ' is auto_run', write(rel), 'auto_run');
}
// found by the round-6 probe replay (not in the finding list): code that runs later by itself in the same way
for (const rel of ['.devcontainer/devcontainer.json', '.idea/workspace.xml', '.idea/runConfigurations/x.xml']) {
  expectHard('MEDIUM-3 Write ' + rel + ' is auto_run', write(rel), 'auto_run');
}
expectHard('MEDIUM-3 RED Edit AGENTS.md is auto_run', edit('AGENTS.md'), 'auto_run');
expectHard('MEDIUM-3 RED echo into .cursorrules is auto_run', sh('echo x > .cursorrules'), 'auto_run');
// Round 7 (M4) changed this decision: a Write of Forge's memory files asks ('auto_run'); Forge's own end-of-run path,
// forge-run-file.cjs append, is the routine one (permissions-round7.test.mjs)
expectHard('MEDIUM-3 Write .claude/agent-memory/head-chef/MEMORY.md asks since round 7', write('.claude/agent-memory/head-chef/MEMORY.md'), 'auto_run');
expectHard('MEDIUM-3 Write .claude/FORGE_MEMORY.md asks since round 7', write('.claude/FORGE_MEMORY.md'), 'auto_run');
expectRoutine('MEDIUM-3 Write .vscode/extensions.json stays routine', write('.vscode/extensions.json'));
expectRoutine('MEDIUM-3 Write docs/agents-overview.md stays routine', write('docs/agents-overview.md'));
expectRoutine('MEDIUM-3 Read AGENTS.md stays routine', read('AGENTS.md'));

// ---------------------------------------------------------------- MEDIUM-4: credential-named files
const CRED = ['service-account.json', 'service_account_prod.json', 'serviceAccountKey.json', 'firebase-adminsdk-ab12.json', 'prod.tfvars',
  'prod.auto.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', 'wp-config.php', '.htpasswd', '.dockercfg', '.s3cfg', '.vault_pass',
  '.m2/settings.xml', 'config/database.yml', 'appsettings.Production.json', 'application-prod.properties', 'local.settings.json',
  'keystore.properties', 'gradle.properties', 'local.properties', 'google-services.json', 'GoogleService-Info.plist', 'Secrets.plist',
  'nuget.config', 'vault.kdbx', 'putty.ppk', 'server.cer', 'server.crt', 'server.der', 'backup.gpg', 'key.asc', 'app.sqlite', 'app.sqlite3',
  'app.db', 'dump.sql', 'prod.dump', 'credentials', 'token', 'apikey', 'api_key', 'known_hosts', '.p12', '.gitconfig', 'prod.env.txt',
  '.bash_history', '.zsh_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.lesshst', '.viminfo',
  'ConsoleHost_history.txt'];
for (const name of CRED) {
  const rel = 'cred/' + name;
  expectHard('MEDIUM-4 RED Read ' + name + ' is credentials', read(rel), 'credentials');
  expectHard('MEDIUM-4 cat ' + name + ' asks', sh('cat ' + rel));
  expectHard('MEDIUM-4 Get-Content ' + name + ' asks', ps('Get-Content ' + rel.replace(/\//g, '\\')));
  expectHard('MEDIUM-4 RED Write ' + name + ' is credentials', write(rel), 'credentials');
}
for (const name of ['.env.example', 'example.env', 'src/tokens/colors.ts', 'src/token.ts', 'src/apikey.test.js', 'appsettings.json',
  'appsettings.Development.json', 'gradle/wrapper/gradle-wrapper.properties', 'docs/history.md', 'src/history.js', 'src/db.js', 'schema.prisma']) {
  expectRoutine('MEDIUM-4 guard: Read ' + name + ' stays routine', read(name));
  // round 7 (LOW): gradle-wrapper.properties names the Gradle that ./gradlew downloads and runs: a write asks (auto_run)
  if (name.endsWith('gradle-wrapper.properties')) expectHard('MEDIUM-4 Write ' + name + ' asks since round 7', write(name), 'auto_run');
  else expectRoutine('MEDIUM-4 guard: Write ' + name + ' stays routine', write(name));
}
test('MEDIUM-4 guard: a folder of design tokens is still searchable', () => {
  put(path.join(P, 'ui', 'tokens', 'colors.ts'));
  assert.equal(run(['Grep', { pattern: 'red', path: path.join(P, 'ui') }]).code, 'routine');
});

// ---------------------------------------------------------------- MEDIUM-5: reads inside .git
expectHard('MEDIUM-5 Read .git/config stays credentials', read('.git/config'), 'credentials');
for (const rel of ['.git/HEAD', '.git/FETCH_HEAD', '.git/packed-refs', '.git/logs/HEAD', '.git/objects/ab/cdef01', '.git/credentials']) {
  expectHard('MEDIUM-5 RED Read ' + rel + ' is credentials', read(rel), 'credentials');
}
expectHard('MEDIUM-5 RED Grep in .git is credentials', ['Grep', { pattern: 'url', path: path.join(P, '.git') }], 'credentials');
expectHard('MEDIUM-5 Glob **/HEAD (a .git file name) is credentials', ['Glob', { pattern: '**/HEAD' }], 'credentials');
expectRoutine('MEDIUM-5 guard: Glob **/*.js over the repository stays routine (no .js file inside .git)', ['Glob', { pattern: '**/*.js' }]);
expectRoutine('MEDIUM-5 guard: Grep with a *.js filter over the repository stays routine', ['Grep', { pattern: 'x', glob: '*.js' }]);
expectHard('MEDIUM-5 RED Glob .git/** is credentials', ['Glob', { pattern: '.git/**' }], 'credentials');
for (const c of ['cat .git/HEAD', 'cat .git/FETCH_HEAD', 'head -5 .git/logs/HEAD', 'wc -l .git/packed-refs', 'grep -r url .git', 'rg url .git',
  'grep url .git/FETCH_HEAD', 'grep -r . .git', 'ls .git', 'find .git -name HEAD', 'cat .git/objects/ab/cdef01']) {
  expectHard('MEDIUM-5 RED ' + c + ' asks', sh(c));
}
for (const c of ['Get-Content .git\\HEAD', 'Select-String url .git\\FETCH_HEAD', 'Get-ChildItem .git -Recurse | Select-String url', 'gc .git\\packed-refs']) {
  expectHard('MEDIUM-5 RED PowerShell ' + c + ' asks', ps(c));
}
for (const c of ['git status', 'git status -s', 'git log --oneline -5', 'git diff --stat', 'git rev-parse --git-dir', 'git rev-parse --show-toplevel',
  'ls', 'ls -a', 'ls src', 'cat .gitignore', 'grep -rn x src', 'cat src/a.js']) {
  expectRoutine('MEDIUM-5 guard: ' + c + ' stays routine', sh(c));
}
expectRoutine('MEDIUM-5 guard: Read .gitignore stays routine', read('.gitignore'));

// ---------------------------------------------------------------- LOW
for (const rel of ['.husky/pre-commit', '.githooks/pre-commit', 'lefthook.yml', '.pre-commit-config.yaml', '.github/workflows/ci.yml', 'Makefile',
  'package.json', 'packages/x/package.json', 'setup.py', 'conftest.py', 'tests/conftest.py', 'sitecustomize.py', 'postinstall.js',
  'scripts/postinstall.js', '.pnpmfile.cjs', '.yarn/plugins/x.cjs', '.yarnrc']) {
  expectHard('LOW RED Write ' + rel + ' is auto_run', write(rel), 'auto_run');
}
expectHard('LOW RED Edit package.json is auto_run', edit('package.json'), 'auto_run');
expectHard('LOW RED echo into Makefile is auto_run', sh('echo x > Makefile'), 'auto_run');
expectHard('LOW RED echo into .husky/pre-commit is auto_run', sh('echo x > .husky/pre-commit'), 'auto_run');
expectHard('LOW RED echo into package.json is auto_run', sh('echo x > package.json'), 'auto_run');
expectRoutine('LOW guard: Read package.json stays routine', read('package.json'));
expectRoutine('LOW guard: cat package.json stays routine', sh('cat package.json'));
expectRoutine('LOW guard: Write package-lock.json.bak stays routine', write('backup/package.json.bak'));

expectHard('LOW RED which node asks (an install path)', sh('which node'));
expectHard('LOW RED type node asks (an install path)', sh('type node'));
expectHard('LOW Get-Command node still asks', ps('Get-Command node'));

for (const c of ['git ls-files ../outside', 'git ls-files -- ../outside', 'git ls-tree HEAD ../outside', 'git ls-tree -r --full-tree HEAD',
  "git ls-files ':/'", 'git status ../outside', 'git status --ignored ../outside']) {
  expectHard('LOW RED ' + c + ' asks', sh(c));
}
for (const c of ['git ls-files', 'git ls-files src', 'git ls-files -o', 'git ls-tree HEAD src', 'git ls-tree -r HEAD', 'git status --ignored', 'git status src']) {
  expectRoutine('LOW guard: ' + c + ' stays routine', sh(c));
}

for (const c of [`Get-Content ".e"+"nv"`, `Get-Content '.\\.en''v'`, `gc '.e'nv`, `Get-Content ".e"nv`]) {
  expectHard('LOW RED PowerShell ' + c + ' is unjudgeable', ps(c), 'unjudgeable');
}
expectRoutine('LOW guard: PowerShell git log --format="%h %s" stays routine', ps('git log --format="%h %s" -5'));
expectRoutine('LOW guard: PowerShell Get-Content "src\\a.js" stays routine', ps('Get-Content "src\\a.js"'));
expectRoutine("LOW guard: PowerShell Write-Output 'done' stays routine", ps("Write-Output 'done'"));

// ---------------------------------------------------------------- the ordinary work this round must not slow down
for (const call of [write('src/a.js'), edit('src/a.js'), write('src/new/b.ts'), read('src/a.js'), read('CLAUDE.md'), sh('cat src/a.js'),
  sh('git status'), sh('git diff -- src'), sh('git log --oneline -3'), sh('node --test'), sh('npm test'), sh('vitest run'),
  ['Grep', { pattern: 'x', path: path.join(P, 'src') }], ['Glob', { pattern: 'src/**/*.js' }]]) {
  expectRoutine('guard: ordinary ' + call[0] + ' ' + (call[1].command || path.relative(P, call[1].file_path || call[1].path || call[1].pattern)) + ' stays routine', call);
}

after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
