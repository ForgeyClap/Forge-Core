// WP-AUTONOMY-GW, verify round 7. Each row marked RED was run against the code before this
// round and was auto-approved there (code 'routine'); the fix makes it wait for the owner. Rows without RED
// were already caught (often by forge-actiongate.cjs) or are guards for ordinary work that must stay routine.
//   HIGH H1  a file with a document extension (.txt, .md, ...) did not mark the project as holding new code, yet
//            `node --test <file>` runs any file as JavaScript (also through `npm test -- <file>`). A runner on the
//            allow-list may now only be pointed at a test file with a JavaScript or TypeScript extension (a
//            *.test.* / *.spec.* name, node's test-*, *-test, *_test or test.* names, or a file under a test,
//            tests, __tests__, spec or specs folder) or at a folder; anything else asks. M1: `node --test
//            scripts/side.js` asks. `vitest -c` takes only a vitest or vite config file (those always ask on write).
//   HIGH H2  dotenv variants and backups (.env.production.local, .env.local.bak, .env~, .env-backup, .env_backup,
//            .env.local.1, .env.a.b.c, .vercel/.env.*): read, search, hash, compare and write all ask. A search of
//            a folder that holds one asks. .env.example, .env.sample and .env.template stay routine.
//   MEDIUM M2 the "wrote code" mark is kept by the REAL location (a junction, an 8.3 short name, letter case, a
//            trailing slash all name the same folder), covers the writer's own folder and the repository the folder
//            is in (a write in P marks P/sub, a write in P/sub2 marks its sibling P/sub).
//   MEDIUM M3 more credential names, read and write: kubeconfig, *.kubeconfig, .dev.vars, AuthKey_*.p8, ngrok.yml,
//            .sentryclirc, .terraformrc, terraform.rc, .boto, .bundle/config, .composer/auth.json, auth.json,
//            pip.conf, pgpass.conf, .mylogin.cnf, .oci/config, wallet.dat, access_token, refresh_token, .tokens,
//            htpasswd, shadow.
//   MEDIUM M4 writes that ask: the scripts an MCP config starts (.mcp.json, .vscode/mcp.json, and every module they
//            require), .claude/launch.json, .claude/statusline.*, other agents' and editors' rule files (AGENT.md,
//            CODEX.md, QWEN.md, CONVENTIONS.md, .aider.conf.yml, .continue, .roo, .roorules, .kiro, .amazonq, .trae,
//            .junie, .zed, .rules, .github/prompts|chatmodes|agents, .devcontainer.json). Forge's memory and planning
//            stores (.claude/FORGE_*.md, agent-memory, forge-prd, forge-tickets, forge-vault): a Write, Edit, copy or
//            `>` asks; Forge's own end-of-run paths into FORGE_MEMORY.md, FORGE_TASK_HISTORY.md, FORGE_AGENT_LEDGER.md,
//            FORGE_DECISIONS.md or agent-memory/<boss>/MEMORY.md stay routine because they can only add text:
//            `forge-run-file.cjs append` (/forge step 12) and a `>>` append (the Bosses' lesson lines in the replay).
//   LOW      a runner's output redirected into a code file marks the project; CI, build and deploy files ask on
//            write; everything under .claude/config, forge-dashboard/config.json and FORGE_CONFIG.local.json is
//            settings; `vitest init|watch|dev`, `tail -f`, a sleep over 60 seconds and `Get-Content -Wait` ask; a
//            WebFetch to this computer asks; a write to a Windows device name (con, aux, com1, ...) asks;
//            `wc --files0-from` and `sha256sum -c` ask.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyHardGate, codeWriteTargets } from '../src/permissions/hard-gate.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import {
  createPermissionRequest, answerPermission, listPendingPermissions, observeStreamLine, registerPermissionRun,
  setPermissionAutonomy, _resetPermissionStoreForTests, _setFirstRunnerForTests,
} from '../src/permissions/store.mjs';
// Round 11: these suites test the write marks alone; the first-runner rule has its own tests (permissions-round11).
_setFirstRunnerForTests(false);
import { isAutonomyOn, _setAutonomyDirForTests } from '../src/permissions/autonomy.mjs';

const WIN = process.platform === 'win32';
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round7-')));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const link = (target, at) => fs.symlinkSync(target, at, WIN ? 'junction' : 'dir');

// P: a project that is its own repository, with the runners of the allow-list installed.
const P = path.join(BASE, 'proj');
const SCRIPTS = { test: 'node --test', build: 'tsc --noEmit', lint: 'eslint .', typecheck: 'tsc --noEmit' };
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
put(path.join(P, 'package.json'), JSON.stringify({ name: 'p', scripts: SCRIPTS }));
for (const bin of ['vitest', 'tsc', 'eslint', 'vite']) { put(path.join(P, 'node_modules', '.bin', bin)); put(path.join(P, 'node_modules', '.bin', bin + '.cmd')); }
for (const rel of ['src/a.js', 'src/a.test.js', 'test/b.test.mjs', 'scripts/side.js', 'notes.txt', 'vitest.config.js', 'cfg.log', 'list.txt', 'sums.txt']) put(path.join(P, rel));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const OPTS = { cwd: P, home: HOME, tmp: TMP };
const sh = (command) => ['Bash', { command }];
const ps = (command) => ['PowerShell', { command }];
const write = (rel, root = P) => ['Write', { file_path: path.join(root, rel), content: 'x' }];
const edit = (rel, root = P) => ['Edit', { file_path: path.join(root, rel), old_string: 'a', new_string: 'b' }];
const read = (rel, root = P) => ['Read', { file_path: path.join(root, rel) }];
const run = ([tool, input], opts = OPTS) => classifyHardGate(tool, input, opts);
const label = (call) => call[0] + ' ' + (call[1].command || call[1].url || (call[1].file_path && path.relative(BASE, call[1].file_path)) || JSON.stringify(call[1]));

function expectHard(name, call, code, opts = OPTS) {
  test(name + ': ' + label(call), () => {
    const got = run(call, opts);
    assert.equal(got.hard, true, JSON.stringify({ call, got }));
    assert.notEqual(got.code, 'routine');
    if (code) assert.equal(got.code, code, JSON.stringify({ call, got }));
  });
}
function expectRoutine(name, call, opts = OPTS) {
  test(name + ': ' + label(call), () => {
    const got = run(call, opts);
    assert.equal(got.code, 'routine', JSON.stringify({ call, got }));
  });
}

// ---------------------------------------------------------------- H1: a runner names only test files
for (const c of ['node --test src/evil.txt', 'node --test src/evil.md src/a.test.js', 'node --test notes.txt', 'node --test scripts/side.js',
  'node --test src/a.js', 'node --test src/*', 'node --test "src/*"', 'node --test "**/*.js"', 'node --test "src/*.test.*"', 'node --test *',
  'npm test -- src/evil.txt', 'npm test -- scripts/side.js', 'npm run test -- notes.txt', 'npx vitest run -c cfg.log', 'npx vitest run --config=cfg.log',
  'npx vitest run --config notes.txt', 'vitest run -c cfg.log']) {
  expectHard('H1 RED', sh(c));
}
expectHard('H1 RED', ps('node --test src\\evil.txt'));
expectHard('H1 RED', ps('node --test scripts\\side.js'));
// the test name is read inside the project: a project that itself sits under a folder named tests does not make
// every file in it a test file, and a link named like a test file is judged where it really points
const PT = path.join(BASE, 'tests', 'proj');
put(path.join(PT, 'package.json'), '{"scripts":{"test":"node --test"}}');
put(path.join(PT, 'scripts', 'side.js'));
put(path.join(PT, 'src', 'a.test.js'));
const OPTS_T = { cwd: PT, home: HOME, tmp: TMP };
const gbT = (p) => p.replace(/\\/g, '/');
expectHard('H1 a project under a tests folder', sh('node --test ' + gbT(path.join(PT, 'scripts', 'side.js'))), null, OPTS_T);
expectHard('H1 a project under a tests folder', sh('node --test "' + gbT(PT) + '/**/*.js"'), null, OPTS_T);
expectRoutine('H1 guard: a project under a tests folder', sh('node --test src/a.test.js'), OPTS_T);
expectRoutine('H1 guard: a project under a tests folder', sh('node --test ' + gbT(path.join(PT, 'src', 'a.test.js'))), OPTS_T);
let fileLink = true;
try { fs.symlinkSync(path.join(P, 'scripts', 'side.js'), path.join(P, 'src', 'linked.test.js'), 'file'); } catch { fileLink = false; } // Windows may refuse a file symlink
test('H1 a file link named like a test file is judged where it points', (t) => {
  if (!fileLink) { t.skip('this account may not create a file symlink'); return; }
  assert.equal(run(sh('node --test src/linked.test.js')).hard, true);
});
for (const c of ['node --test', 'node --test src', 'node --test src/', 'node --test .', 'node --test src/a.test.js', 'node --test test/b.test.mjs',
  'node --test "src/**/*.test.js"', 'node --test "test/**/*.mjs"', 'node --test test/', 'node --test src/a.spec.ts', 'node --test src/test-utils.js',
  'node --test --test-name-pattern=x src/a.test.js', 'npm test', 'npm test -- src/a.test.js', 'npm test -- --test-name-pattern=autonomy',
  'npx vitest run', 'npx vitest run -c vitest.config.js', 'npx vitest run src/a.test.js', 'npx vitest']) {
  expectRoutine('H1 guard', sh(c));
}
expectRoutine('H1 guard', ps('node --test src\\a.test.js'));

// ---------------------------------------------------------------- H2: dotenv variants and backups
const ENV_NAMES = ['.env.production.local', '.env.development.local', '.env.local.bak', '.env~', '.env-backup', '.env_backup', '.env.local.1',
  '.env.a.b.c', '.env.prod.old', '.vercel/.env.development.local'];
for (const name of [...ENV_NAMES, 'config/.env.production']) put(path.join(P, name), 'SECRET=DUMMY\n');
// forge-actiongate.cjs (the shell classifier hard-gate.mjs also asks) already caught these forms for the names
// that start with `.env.` or `.env-` or `.env~` (and a PowerShell redirect for every name): they carry no RED
const ACTIONGATE_BEFORE = /^(?:cat|head|grep|Get-Content|Select-String) /;
for (const name of ENV_NAMES) {
  const win = name.replace(/\//g, '\\');
  const before = (c) => c.startsWith("'x' >") || (name !== '.env_backup' && ACTIONGATE_BEFORE.test(c));
  const h2 = (call) => expectHard(before(call[1].command || '') ? 'H2' : 'H2 RED', call);
  expectHard('H2 RED', read(name), 'credentials');
  expectHard('H2 RED', write(name), 'credentials');
  expectHard('H2 RED', edit(name), 'credentials');
  expectHard('H2 RED', ['Grep', { pattern: 'SECRET', path: path.join(P, name) }], 'credentials');
  expectHard('H2 RED', ['NotebookRead', { notebook_path: path.join(P, name) }], 'credentials');
  for (const c of ['cat ' + name, 'sed -n p ' + name, 'cut -c1-80 ' + name, 'sort ' + name, 'uniq ' + name, 'diff ' + name + ' src/a.js',
    'cmp ' + name + ' src/a.js', 'sha256sum ' + name, 'head -n 3 ' + name, 'grep . ' + name, 'echo x > ' + name, 'echo x >> ' + name]) {
    h2(sh(c));
  }
  for (const c of ['Get-Content ' + win, 'Get-FileHash ' + win, 'Select-String x ' + win, "'x' > " + win]) h2(ps(c));
}
// a single-suffix name was caught before this round too; it stays caught
for (const call of [read('config/.env.production'), write('config/.env.production'), sh('sed -n p config/.env.production'), ps('Get-FileHash config\\.env.production')]) {
  expectHard('H2', call);
}
// a search of a folder must not hand out a secret file's text: P3 has no .git folder, so before this round its
// only sensitive file was invisible to the folder walk
const P3 = path.join(BASE, 'proj3');
put(path.join(P3, 'package.json'), '{"scripts":{"test":"node --test"}}');
put(path.join(P3, 'src', 'a.js'));
put(path.join(P3, '.env.production.local'), 'SECRET=DUMMY\n');
put(path.join(P3, 'ops', '.env_backup'), 'SECRET=DUMMY\n');
const OPTS3 = { cwd: P3, home: HOME, tmp: TMP };
expectHard('H2 RED a search of the project folder', ['Grep', { pattern: 'SECRET' }], 'credentials', OPTS3);
expectHard('H2 RED a search of the project folder by path', ['Grep', { pattern: 'SECRET', path: P3, output_mode: 'content' }], 'credentials', OPTS3);
expectHard('H2 RED a search filtered to *.local', ['Grep', { pattern: 'SECRET', glob: '*.local' }], 'credentials', OPTS3);
expectHard('H2 RED a search of a sub folder', ['Grep', { pattern: 'SECRET', path: path.join(P3, 'ops') }], 'credentials', OPTS3);
expectHard('H2 RED a glob that lists the file', ['Glob', { pattern: '**/*.local' }], 'credentials', OPTS3);
for (const c of ['grep -r SECRET .', 'grep -rn SECRET', 'rg SECRET', 'rg -n SECRET ops']) expectHard('H2 RED a shell search', sh(c), null, OPTS3);
expectHard('H2 RED a PowerShell search', ps('Get-ChildItem ops -Recurse | Select-String SECRET'), null, OPTS3);
expectRoutine('H2 guard: a search narrowed to .js files', ['Grep', { pattern: 'SECRET', glob: '*.js' }], OPTS3);
expectRoutine('H2 guard: a search of src', ['Grep', { pattern: 'SECRET', path: path.join(P3, 'src') }], OPTS3);
expectRoutine('H2 guard: grep -rn in src', sh('grep -rn process.env src'), OPTS3);
// the example files stay readable and writable
for (const name of ['.env.example', '.env.sample', '.env.template', '.env.local.example', 'config/.env.example']) {
  put(path.join(P, name), 'A=\n');
  expectRoutine('H2 guard', read(name));
  expectRoutine('H2 guard', write(name));
  // forge-actiongate.cjs reads `cat .env.local*` as printing a secret (outside this folder's scope), so that one asks
  if (name !== '.env.local.example') expectRoutine('H2 guard', sh('cat ' + name));
}
for (const name of ['src/env.ts', 'src/vite-env.d.ts', 'src/environment.js', 'src/dotenv.config.js', 'docs/env-vars.md']) {
  expectRoutine('H2 guard', read(name));
  expectRoutine('H2 guard', write(name));
}
expectRoutine('H2 guard: process.env in inline text', sh('grep -rn "process.env.NODE_ENV" src'));

// ---------------------------------------------------------------- M3: credential names
const M3_NAMES = ['kubeconfig', 'prod.kubeconfig', 'k8s/dev.kubeconfig', '.dev.vars', 'AuthKey_ABC123.p8', 'ngrok.yml', '.sentryclirc', '.terraformrc',
  'terraform.rc', '.boto', '.bundle/config', '.composer/auth.json', 'auth.json', 'pip.conf', 'pgpass.conf', '.mylogin.cnf', '.oci/config',
  'wallet.dat', 'access_token', 'refresh_token', '.tokens', 'htpasswd', 'shadow'];
for (const name of M3_NAMES) {
  put(path.join(P, 'm3', name), 'DUMMY\n');
  const rel = 'm3/' + name;
  expectHard('M3 RED', read(rel), 'credentials');
  expectHard('M3 RED', write(rel), 'credentials');
  expectHard('M3 RED', sh('cat ' + rel));
  expectHard('M3 RED', sh('sed -n p ' + rel));
  expectHard('M3 RED', ps('Get-Content ' + rel.replace(/\//g, '\\')));
  expectHard('M3 RED', sh('echo x > ' + rel));
}
for (const rel of ['src/auth.ts', 'src/auth.js', 'locales/en/auth.json', 'src/i18n/nl/auth.json', 'docs/kubeconfig.md', 'src/shadow.css', 'src/tokens.ts',
  'src/access_token.test.js', 'k8s/deployment.yaml']) {
  expectRoutine('M3 guard', read(rel));
  expectRoutine('M3 guard', write(rel));
}

// ---------------------------------------------------------------- M4: files that run or instruct later
for (const rel of ['AGENT.md', 'CODEX.md', 'QWEN.md', 'CONVENTIONS.md', '.aider.conf.yml', '.continue/config.json', '.continue/rules/x.md', '.roo/rules/x.md',
  '.roorules', '.kiro/steering/x.md', '.amazonq/rules/x.md', '.trae/rules/x.md', '.junie/guidelines.md', '.zed/settings.json', '.rules',
  '.github/prompts/x.prompt.md', '.github/chatmodes/x.chatmode.md', '.github/agents/x.agent.md', '.devcontainer.json', 'docs/AGENT.md']) {
  expectHard('M4 RED', write(rel), 'auto_run');
}
expectHard('M4 RED', sh('echo x > .roorules'), 'auto_run');
for (const rel of ['.claude/launch.json', '.claude/statusline.sh', '.claude/statusline.js', '.claude/statusline-command.ps1']) {
  expectHard('M4 RED', write(rel), 'settings');
}
expectHard('M4 RED', sh('echo x > .claude/launch.json'), 'settings');
// the scripts an MCP config starts, and the modules they require
const P4 = path.join(BASE, 'proj4');
put(path.join(P4, 'package.json'), '{"scripts":{"test":"node --test"}}');
put(path.join(P4, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'node', args: ['tools/mcp-server.js'] }, y: { command: 'uv', args: ['run', '--directory', 'py', 'server.py'] } } }));
put(path.join(P4, '.vscode', 'mcp.json'), JSON.stringify({ servers: { z: { type: 'stdio', command: 'node', args: ['${workspaceFolder}/scripts/vs-mcp.mjs'] } } }));
put(path.join(P4, 'tools', 'mcp-server.js'), "const lib = require('./mcp-lib');\n");
put(path.join(P4, 'tools', 'mcp-lib.js'), '//\n');
put(path.join(P4, 'scripts', 'vs-mcp.mjs'), '//\n');
put(path.join(P4, 'py', 'server.py'), '#\n');
const OPTS4 = { cwd: P4, home: HOME, tmp: TMP };
for (const rel of ['tools/mcp-server.js', 'tools/mcp-lib.js', 'scripts/vs-mcp.mjs', 'py/server.py']) {
  expectHard('M4 RED an MCP script', write(rel, P4), null, OPTS4);
  expectHard('M4 RED an MCP script', edit(rel, P4), null, OPTS4);
  expectHard('M4 RED an MCP script', sh('echo x > ' + rel), null, OPTS4);
}
for (const rel of ['tools/other.js', 'scripts/build-docs.js', 'src/a.js']) expectRoutine('M4 guard', write(rel, P4), OPTS4);
// Forge's memory and planning stores: only Forge's own append path is routine
for (const rel of ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md', '.claude/FORGE_DECISIONS.md',
  '.claude/FORGE_SNAPSHOT.md', '.claude/FORGE_PROJECT_PROFILE.md', '.claude/FORGE_SKILL_REGISTRY.md', '.claude/agent-memory/head-chef/MEMORY.md',
  '.claude/agent-memory/x/notes.md', '.claude/forge-prd/x.md', '.claude/forge-tickets/x.json', '.claude/forge-vault/Home.md']) {
  expectHard('M4 RED a Forge memory store', write(rel), 'auto_run');
  expectHard('M4 RED a Forge memory store', edit(rel), 'auto_run');
}
// a redirect that replaces them, or adds to any other file of the stores, asks
for (const c of ['echo x > .claude/FORGE_MEMORY.md', 'echo x > .claude/agent-memory/head-chef/MEMORY.md', 'echo x >| .claude/FORGE_TASK_HISTORY.md',
  'echo x >> .claude/FORGE_SNAPSHOT.md', 'echo x >> .claude/FORGE_SKILL_REGISTRY.md', 'echo x >> .claude/FORGE_PROJECT_PROFILE.md',
  'echo x >> .claude/agent-memory/x/notes.md', 'echo x >> .claude/forge-prd/x.md', 'echo x >> .claude/agent-memory/a/b/MEMORY.md']) {
  expectHard('M4 RED', sh(c));
}
for (const c of ['cp _scratch/mem.md .claude/FORGE_MEMORY.md', 'cat _scratch/mem.md | tee .claude/agent-memory/head-chef/MEMORY.md']) expectHard('M4', sh(c));
// what the Bosses really do at the end of a run (the 2026-11 replay): append one lesson line. It only adds text, so
// it stays routine for exactly the end-of-run files (FORGE_MEMORY, TASK_HISTORY, AGENT_LEDGER, DECISIONS, a lesson file)
for (const c of ['echo "- 2026-11-11 lesson" >> .claude/agent-memory/head-chef/MEMORY.md', "printf '%s\\n' '- lesson' >> .claude/agent-memory/build-boss/MEMORY.md",
  "cat >> .claude/agent-memory/ui-boss/MEMORY.md <<'EOF'\n- 2026-11-11 a lesson\nEOF", 'echo x >> .claude/FORGE_MEMORY.md', 'echo x >> .claude/FORGE_TASK_HISTORY.md',
  'echo x >> .claude/FORGE_AGENT_LEDGER.md', 'echo x >> .claude/FORGE_DECISIONS.md',
  "cd ./.claude/agent-memory/ui-boss && cat >> MEMORY.md <<'EOF'\n- a lesson\nEOF"]) {
  expectRoutine('M4 guard: the end-of-run append path', sh(c));
}
put(path.join(P, '_scratch', 'mem.md'), '## Status\n');
const RUN_FILE = 'node .claude/forge-bin/forge-run-file.cjs';
// these asked before this round (forge-run-file.cjs was not on the allow-list); now they are Forge's one routine path
for (const file of ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_DECISIONS.md', 'agent-memory/head-chef/MEMORY.md']) {
  expectRoutine('M4 NEW routine: Forge end-of-run append', sh(RUN_FILE + ' append --file ' + file + ' --from _scratch/mem.md'));
}
expectRoutine('M4 NEW routine: Forge end-of-run append from the temp folder', sh(RUN_FILE + ' append --file FORGE_MEMORY.md --from ' + path.join(TMP, 'm.md').replace(/\\/g, '/')));
for (const args of ['append --file FORGE_SKILL_REGISTRY.md --from _scratch/mem.md', 'append --file ../x.md --from _scratch/mem.md',
  'append --file FORGE_MEMORY.md --from -', 'append --file FORGE_MEMORY.md --from ../outside.md', 'append --file FORGE_MEMORY.md --from .env.production.local',
  'append --file FORGE_MEMORY.md', 'append --file agent-memory/../../x/MEMORY.md --from _scratch/mem.md', 'put --run r1 --name final-report.md --from _scratch/mem.md',
  'append --file FORGE_MEMORY.md --from _scratch/mem.md --extra x']) {
  expectHard('M4 other forge-run-file calls ask', sh(RUN_FILE + ' ' + args));
}
expectRoutine('M4 guard: research notes stay routine', write('.claude/forge-research/x.md'));
expectRoutine('M4 guard: a run event log stays routine', write('.claude/forge-dashboard/runs/x/events.jsonl'));

// ---------------------------------------------------------------- LOW
test('LOW RED a runner whose output goes into a code file writes code', () => {
  for (const c of ['npm test > src/out.js', 'node --test > src/out.cjs', 'npm run build > scripts/gen.js', 'tsc --noEmit > src/gen.ts', 'npm test 2> src/gen.js',
    'npx vitest run > src/gen.mjs']) {
    assert.ok(codeWriteTargets('Bash', { command: c }, OPTS).length > 0, c);
  }
  for (const c of ['npm test > out.json', 'node --test > test-output.json', 'node --test > out.txt', 'node --test 2>&1 | tail -20', 'npm test > /dev/null']) {
    assert.deepEqual(codeWriteTargets('Bash', { command: c }, OPTS), [], c);
  }
});
expectHard('LOW RED a runner writing a code file and running asks', sh('node --test > src/o.js'), 'wrote_code');
expectRoutine('LOW guard: a runner writing its report', sh('node --test > test-output.json'));
for (const rel of ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml', 'appveyor.yml',
  '.github/actions/x/action.yml', 'netlify.toml', 'vercel.json', 'render.yaml', 'fly.toml', 'Procfile', 'Dockerfile', 'Dockerfile.dev', 'docker-compose.yml',
  'docker-compose.override.yaml', 'compose.yaml', 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.properties', '.mvn/wrapper/maven-wrapper.properties',
  '.mvn/jvm.config', 'mvnw', '.lintstagedrc', '.lintstagedrc.json', 'lint-staged.config.js', '.releaserc', '.releaserc.json', 'release.config.js', '.nycrc',
  '.nycrc.json', 'Directory.Build.props', 'Directory.Build.targets', 'Taskfile.yml', 'justfile', 'x.code-workspace']) {
  expectHard('LOW RED', write(rel), 'auto_run');
}
for (const rel of ['.claude/config/agents/agent-tool-policy.json', '.claude/config/agents/agent-registry.json', '.claude/config/orchestration/FORGE_DEFAULT_SKILLS.json',
  '.claude/config/orchestration/mcp-grants.json', '.claude/config/packs/x.json', '.claude/forge-dashboard/config.json', '.claude/FORGE_CONFIG.local.json']) {
  expectHard('LOW RED', write(rel), 'settings');
}
expectHard('LOW RED', sh('echo x > .claude/forge-dashboard/config.json'), 'settings');
for (const c of ['npx vitest init', 'npx vitest init browser', 'npx vitest watch', 'npx vitest dev', 'vitest watch', 'tail -f src/a.js', 'tail -F src/a.js',
  'tail --follow src/a.js', 'tail -fn 5 src/a.js', 'sleep 99999', 'sleep infinity', 'sleep 2m', 'sleep 61', 'sleep 1h', 'wc --files0-from=list.txt',
  'wc --files0-from list.txt', 'sha256sum -c sums.txt', 'sha256sum --check sums.txt', 'md5sum -c sums.txt', 'du --files0-from=list.txt']) {
  expectHard('LOW RED', sh(c));
}
for (const c of ['Start-Sleep 99999', 'Start-Sleep -Seconds 99999', 'Start-Sleep -s 120', 'Start-Sleep -Milliseconds 99999999', 'sleep 99999',
  'Get-Content src\\a.js -Wait', 'gc src\\a.js -Wait', 'Get-Content -Tail 1 -Wait src\\a.js', 'Get-Content src\\a.js -wai']) {
  expectHard('LOW RED', ps(c));
}
for (const c of ['sleep 5', 'sleep 0.5', 'sleep 60', 'tail -n 5 src/a.js', 'tail -5 src/a.js', 'head -c 10 src/a.js', 'wc -l src/a.js', 'sha256sum src/a.js']) {
  expectRoutine('LOW guard', sh(c));
}
for (const c of ['Start-Sleep 2', 'Start-Sleep -Seconds 5', 'Start-Sleep -Milliseconds 500', 'Get-Content src\\a.js -Tail 5']) expectRoutine('LOW guard', ps(c));
for (const url of ['http://localhost:3000/', 'http://127.0.0.1:4100/api/health', 'http://127.0.0.1:4100/api/permissions', 'http://[::1]:4100/', 'http://0.0.0.0:4100/',
  'http://127.1/', 'http://2130706433/', 'http://127.0.0.1:9229/json']) {
  expectHard('LOW RED a WebFetch to this computer', ['WebFetch', { url, prompt: 'x' }]);
}
for (const rel of ['src/CON', 'src/nul', 'src/aux.js', 'src/COM1', 'src/lpt1.txt', 'src/prn', 'src/conin$']) {
  expectHard('LOW RED a Windows device name', write(rel));
}
for (const c of ['echo x > COM1', 'echo x > aux', 'echo x > src/prn.txt']) expectHard('LOW RED a redirect to a Windows device', sh(c));
for (const c of ['echo x > /dev/null', 'node --version > nul', 'node --version 2> NUL']) expectRoutine('LOW guard', sh(c));
expectRoutine('LOW guard', ps('node --version > $null'));

// ---------------------------------------------------------------- M2 and H1: the store keeps the mark by real location
describe('M2 store: the mark follows the real folder', () => {
  const PROJECT = 'round7-project';
  const SP = path.join(BASE, 'storeproj');
  const OTHER = path.join(BASE, 'otherproj');
  const ALIAS = path.join(BASE, 'alias');
  const LONG = path.join(BASE, 'long project folder name');
  const SUB = path.join(SP, 'sub');
  const SUB2 = path.join(SP, 'sub2');
  let SHORT = null;
  before(() => {
    for (const dir of [SP, OTHER, LONG, SUB, SUB2]) {
      put(path.join(dir, 'package.json'), JSON.stringify({ name: 'sp', scripts: { test: 'node --test' } }));
      put(path.join(dir, 'src', 'a.js'));
    }
    put(path.join(SP, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    put(path.join(OTHER, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    put(path.join(SP, 'notes.txt'), 'n\n');
    link(SP, ALIAS);
    if (WIN) {
      try {
        const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'for %I in ("' + LONG + '") do @echo %~sI'], { windowsVerbatimArguments: true, encoding: 'utf8' }).trim();
        if (out && out.toLowerCase() !== LONG.toLowerCase() && fs.existsSync(out)) SHORT = out;
      } catch { SHORT = null; }
    }
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
  const conversation = (cwd) => { const id = createConversation({ project: PROJECT }).id; registerPermissionRun(id, { cwd }); return id; };
  const ask = (convId, toolName, input, cwd) => createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName, input, ...(cwd ? { cwd } : {}) });
  const card = (convId, command, cwd) => ask(convId, 'Bash', { command }, cwd);
  const streamWrite = (convId, file) => observeStreamLine(convId, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2), name: 'Write', input: { file_path: file, content: 'x' } }] } });
  const streamBash = (convId, command) => observeStreamLine(convId, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2), name: 'Bash', input: { command } }] } });
  const allowed = (r) => Boolean(r.decision && r.decision.behavior === 'allow');
  const waits = (r, code) => {
    assert.equal(r.decision, undefined, 'the card waits for the owner');
    if (code) { const c = listPendingPermissions().find((p) => p.id === r.id); assert.equal(c && c.gate.code, code); }
  };

  test('H1 RED store: an auto-allowed Write of a .txt file, then node --test on it waits', () => {
    const c = conversation(SP);
    assert.equal(allowed(ask(c, 'Write', { file_path: path.join(SP, 'src', 'evil.txt'), content: 'x' })), true, 'the write itself is routine');
    waits(card(c, 'node --test src/evil.txt'));
  });
  test('H1 RED store: echo into a .md file, then npm test -- on it waits', () => {
    const c = conversation(SP);
    assert.equal(allowed(card(c, 'echo x > src/evil.md')), true);
    waits(card(c, 'npm test -- src/evil.md'));
  });
  test('H1 RED store: an Edit of notes.txt, then node --test notes.txt waits', () => {
    const c = conversation(SP);
    ask(c, 'Edit', { file_path: path.join(SP, 'notes.txt'), old_string: 'n', new_string: 'x' });
    waits(card(c, 'node --test notes.txt'));
  });
  test('H1 store guard: a Markdown note, then npm test is still allowed', () => {
    const c = conversation(SP);
    assert.equal(allowed(ask(c, 'Write', { file_path: path.join(SP, 'docs', 'plan.md'), content: 'x' })), true);
    assert.equal(allowed(card(c, 'npm test')), true);
  });

  test('M2 RED store: A writes in the project, B runs npm test through a junction to it', () => {
    ask(conversation(SP), 'Write', { file_path: path.join(SP, 'src', 'n.test.js'), content: 'x' });
    waits(card(conversation(ALIAS), 'npm test'), 'wrote_code');
  });
  test('M2 RED store: A writes through the junction, B runs npm test in the project', () => {
    ask(conversation(ALIAS), 'Write', { file_path: path.join(ALIAS, 'src', 'n.test.js'), content: 'x' });
    waits(card(conversation(SP), 'npm test'), 'wrote_code');
  });
  test('M2 RED store: a write seen in the stream, the card made with the junction as its folder', () => {
    const c = conversation(SP);
    streamWrite(c, path.join(SP, 'src', 'n.test.js'));
    waits(card(c, 'npm test', ALIAS), 'wrote_code');
  });
  test('M2 RED store: a relative write in the stream of a run in the junction, the card made in the project', () => {
    const c = conversation(ALIAS);
    streamWrite(c, 'src/n.test.js');
    waits(card(c, 'npm test', SP), 'wrote_code');
  });
  test('M2 RED store: an 8.3 short name of the folder is the same folder', (t) => {
    if (!SHORT) { t.skip('no 8.3 short name on this volume'); return; }
    ask(conversation(LONG), 'Write', { file_path: path.join(LONG, 'src', 'n.test.js'), content: 'x' });
    waits(card(conversation(SHORT), 'npm test'), 'wrote_code');
  });
  test('M2 RED store: a write through the 8.3 short name marks the long folder', (t) => {
    if (!SHORT) { t.skip('no 8.3 short name on this volume'); return; }
    ask(conversation(SHORT), 'Write', { file_path: path.join(SHORT, 'src', 'n.test.js'), content: 'x' });
    waits(card(conversation(LONG), 'npm test'), 'wrote_code');
  });
  test('M2 store guard: letter case and a trailing slash name the same folder', () => {
    ask(conversation(SP), 'Write', { file_path: path.join(SP, 'src', 'n.test.js'), content: 'x' });
    if (WIN) waits(card(conversation(SP.toUpperCase()), 'npm test'), 'wrote_code');
    waits(card(conversation(SP), 'npm test', SP.replace(/\\/g, '/') + '/'), 'wrote_code');
  });
  test('M2 RED store: a write in the project marks a sub-project', () => {
    ask(conversation(SP), 'Write', { file_path: path.join(SP, 'src', 'n.test.js'), content: 'x' });
    waits(card(conversation(SUB), 'node --test'), 'wrote_code');
  });
  test('M2 RED store: a write in one sub-project marks its sibling in the same repository', () => {
    ask(conversation(SUB2), 'Write', { file_path: path.join(SUB2, 'src', 'n.js'), content: 'x' });
    waits(card(conversation(SUB), 'npm test'), 'wrote_code');
  });
  test('M2 store: a write in a sub-project marks the project around it', () => {
    ask(conversation(SUB), 'Write', { file_path: path.join(SUB, 'src', 'n.test.js'), content: 'x' });
    waits(card(conversation(SP), 'npm test'), 'wrote_code');
  });
  test('M2 RED store: a card made in a sub folder of the run sees writes anywhere in the run folder', () => {
    const c = conversation(SP);
    streamWrite(c, path.join(SP, 'lib', 'x.js'));
    waits(card(c, 'npm test', SUB), 'wrote_code');
  });
  test('M2 store guard: a write in another repository does not mark this project', () => {
    ask(conversation(OTHER), 'Write', { file_path: path.join(OTHER, 'src', 'n.js'), content: 'x' });
    assert.equal(allowed(card(conversation(SP), 'npm test')), true);
  });
  test('M2 RED store: the owner approving the waiting run in the junction clears the mark for the project too', () => {
    const c = conversation(ALIAS);
    streamWrite(c, path.join(SP, 'src', 'b.js'));
    const first = card(c, 'npm test');
    waits(first, 'wrote_code');
    assert.equal(answerPermission(first.id, 'allow').ok, true);
    assert.equal(allowed(card(c, 'npm test')), true);
    assert.equal(allowed(card(conversation(SP), 'npm test')), true, 'the junction and the project are one folder');
  });
  test('LOW RED store: a runner whose output went into a code file marks the project', () => {
    const c = conversation(SP);
    streamBash(c, 'npm test > src/out.js');
    waits(card(c, 'npm test'), 'wrote_code');
  });
  test('LOW store guard: a runner writing its JSON report does not mark the project', () => {
    const c = conversation(SP);
    streamBash(c, 'npm test > test-output.json');
    assert.equal(allowed(card(c, 'npm test')), true);
  });
});

// ---------------------------------------------------------------- the ordinary work this round must not slow down
for (const call of [write('src/a.js'), edit('src/a.js'), write('src/new/b.ts'), read('src/a.js'), read('package.json'), sh('cat src/a.js'), sh('git status'),
  sh('git diff -- src'), sh('git log --oneline -3'), sh('node --test'), sh('npm test'), sh('npx vitest run'), sh('ls -la'), sh('sleep 2'),
  ['Grep', { pattern: 'x', path: path.join(P, 'src') }], ['Glob', { pattern: 'src/**/*.js' }], write('docs/notes.md'), write('README.md')]) {
  expectRoutine('guard: ordinary work', call);
}

after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
