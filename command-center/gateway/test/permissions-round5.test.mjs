// WP-AUTONOMY-GW, Security Boss round 5. Each row marked RED was run against the code before
// this round and was auto-approved there (code 'routine'); the fix makes it wait for the owner.
//   1 (HIGH)   Get-Command printed script text (Definition, ScriptContents) of any file, also outside the
//              project, through `| Format-List *` or `| Select-Object Definition`. It asks now. (Split-Path
//              and Join-Path -Resolve list names on disk; checked in the same audit: the block list already
//              asks for a path outside the project, kept here as guards.)
//   2 (MEDIUM) `git show REV:path` prints one file of the repository. git reads `./` and `../` from the
//              working folder and any other path from the top of the repository, so `HEAD:../x`, or any
//              `HEAD:x` when the repository top is above the project, printed a file outside the project
//              (also with --stat, -s, --name-only: a blob ignores them). A blob path with a `..` part or an
//              absolute or drive path, or a repository whose top is not inside the project, asks.
//   3          Get-Process objects carry the window title, the program path and (PowerShell 7) the full
//              command line of every process, which can hold a token; Windows PowerShell 5.1 also has
//              -ComputerName. Only the default table is routine now: nothing piped after it, only names,
//              -Name, -Id and -ErrorAction.
//   4 (LOW)    writes of prod.env, *.key files are credentials; writing CLAUDE.md / CLAUDE.local.md in the
//              project is settings (it changes what every later session is told); the dead
//              `git worktree list` text is gone (it still asks); the reach cache lives 2 s, not 10 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyHardGate } from '../src/permissions/hard-gate.mjs';

const WIN = process.platform === 'win32';
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round5-')));
after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// OWN: a project that is its own repository. OUTER/proj: a project inside a bigger repository.
const OWN = path.join(BASE, 'own');
const OUTER = path.join(BASE, 'outer');
const NESTED = path.join(OUTER, 'proj');
const OUTSIDE = path.join(BASE, 'outside');
put(path.join(OWN, '.git', 'HEAD'), 'ref: refs/heads/main\n');
put(path.join(OWN, 'package.json'), '{"name":"x","version":"1.0.0"}');
put(path.join(OWN, 'src', 'a.js'));
put(path.join(OWN, 'sub', 'b.js'));
put(path.join(OWN, 'CLAUDE.md'), '# rules\n');
put(path.join(OUTER, '.git', 'HEAD'), 'ref: refs/heads/main\n');
put(path.join(OUTER, 'other.txt'), 'OUTSIDE\n');
put(path.join(NESTED, 'a.txt'));
put(path.join(OUTSIDE, 'a.txt'), 'one\n');
put(path.join(OUTSIDE, 'b.txt'), 'two\n');
put(path.join(OUTSIDE, 'tool.ps1'), 'Write-Output secret-logic\n');
put(path.join(HOME, 'x'));
fs.mkdirSync(TMP, { recursive: true });

const OPTS = { cwd: OWN, home: HOME, tmp: TMP };
const IN_OUTER = { cwd: NESTED, home: HOME, tmp: TMP };
const sh = (command) => ['Bash', { command }];
const ps = (command) => ['PowerShell', { command }];
const run = ([tool, input], opts = OPTS) => classifyHardGate(tool, input, opts);
const O = (p) => path.join(OWN, p);

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

// ---------------------------------------------------------------- 1: Get-Command (and -Resolve)
expectHard('1 RED Get-Command of a script outside the project | Format-List * (prints its text)', ps('Get-Command ' + path.join(OUTSIDE, 'tool.ps1') + ' | Format-List *'));
expectHard('1 RED gcm prompt | Select-Object Definition (prints a profile function)', ps('gcm prompt | Select-Object Definition'));
expectHard('1 RED Get-Command alone asks too', ps('Get-Command node'));
// guards, not RED: the block list already judges a Split-Path / Join-Path argument outside the project as outside_folder
expectHard('1 Split-Path -Resolve outside the project asks', ps('Split-Path -Path ' + path.join(OUTSIDE, '*') + ' -Leaf -Resolve'), 'outside_folder');
expectHard('1 Join-Path -Resolve outside the project asks', ps('Join-Path ' + OUTSIDE + ' * -Resolve'), 'outside_folder');
expectRoutine('1 Split-Path on text stays routine', ps('Split-Path -Leaf src\\a.js'));
expectRoutine('1 Join-Path on text stays routine', ps('Join-Path src a.js'));

// ---------------------------------------------------------------- 2: git show REV:path
expectHard('2 RED git show HEAD:../x in a project inside a bigger repository', sh('git show HEAD:../other.txt'), null, IN_OUTER);
expectHard('2 RED git show HEAD:x when the repository top is above the project', sh('git show HEAD:other.txt'), null, IN_OUTER);
expectHard('2 RED git show --stat HEAD:../x (a blob ignores --stat)', sh('git show --stat HEAD:../other.txt'), null, IN_OUTER);
expectHard('2 RED git show -s HEAD:../x', sh('git show -s HEAD:../other.txt'), null, IN_OUTER);
expectHard('2 RED git show --name-only HEAD:../x', sh('git show --name-only HEAD:../other.txt'), null, IN_OUTER);
expectHard('2 RED git show :../x (the index)', sh('git show :../other.txt'), null, IN_OUTER);
expectHard('2 RED PowerShell git show HEAD:..\\x', ps('git show HEAD:..\\other.txt'), null, IN_OUTER);
expectHard('2 RED git show HEAD:../x in the project\'s own repository', sh('git show HEAD:../outside/a.txt'));
expectHard('2 RED git -C sub show HEAD:../../x', sh('git -C sub show HEAD:../../outside/a.txt'));
expectHard('2 RED git show HEAD:src/../../x', sh('git show HEAD:src/../../outside/a.txt'));
expectHard('2 RED git show HEAD and a blob with ..', sh('git show HEAD HEAD:../outside/a.txt'));
if (WIN) {
  // git diff of two paths outside the working tree is an implied --no-index: it prints both files
  expectHard('2 RED PowerShell git diff of two drive paths outside the project', ps('git diff ' + path.join(OUTSIDE, 'a.txt') + ' ' + path.join(OUTSIDE, 'b.txt')));
}
expectRoutine('2 git show HEAD:src/a.js in the project\'s own repository stays routine', sh('git show HEAD:src/a.js'));
expectRoutine('2 git show HEAD:./src/a.js stays routine', sh('git show HEAD:./src/a.js'));
expectRoutine('2 git show --stat HEAD stays routine', sh('git show --stat HEAD'));
expectRoutine('2 git log --oneline in a project inside a bigger repository stays routine', sh('git log --oneline -5'), IN_OUTER);

// ---------------------------------------------------------------- 3: Get-Process
expectHard('3 RED Get-Process | Select-Object CommandLine (PowerShell 7: every command line)', ps('Get-Process | Select-Object CommandLine'));
expectHard('3 RED Get-Process | Format-List * (path, window title, command line)', ps('Get-Process | Format-List *'));
expectHard('3 RED Get-Process node | ConvertTo-Json', ps('Get-Process node | ConvertTo-Json'));
expectHard('3 RED ps | fl *', ps('ps | fl *'));
expectHard('3 RED Get-Process -ComputerName (Windows PowerShell: another computer)', ps('Get-Process -ComputerName srv01'));
expectHard('3 RED Get-Process -Module', ps('Get-Process node -Module'));
expectHard('3 RED Get-Process -IncludeUserName', ps('Get-Process -IncludeUserName'));
expectRoutine('3 Get-Process alone stays routine', ps('Get-Process'));
expectRoutine('3 Get-Process by name stays routine', ps('Get-Process node'));
expectRoutine('3 Get-Process -Name -ErrorAction stays routine', ps('Get-Process -Name node -ErrorAction SilentlyContinue'));
expectRoutine('3 Get-Process -Id stays routine', ps('Get-Process -Id 1234'));
expectRoutine('3 ps node stays routine', ps('ps node'));

// ---------------------------------------------------------------- 4: low findings
expectHard('4 RED Write prod.env is credentials', ['Write', { file_path: O('conf/prod.env'), content: 'K=1' }], 'credentials');
expectHard('4 RED Edit local.env is credentials', ['Edit', { file_path: O('local.env'), old_string: 'a', new_string: 'b' }], 'credentials');
expectHard('4 RED Write a .key file is credentials', ['Write', { file_path: O('certs/server.key'), content: 'k' }], 'credentials');
expectHard('4 Write a .pem file is credentials', ['Write', { file_path: O('certs/server.pem'), content: 'k' }], 'credentials');
expectHard('4 RED a redirect into prod.env asks', sh('echo K=1 > prod.env'));
expectHard('4 RED a redirect into tls.key asks', sh('echo k > tls.key'));
expectRoutine('4 Write .env.example stays routine', ['Write', { file_path: O('.env.example'), content: 'K=' }]);
expectRoutine('4 Write example.env stays routine', ['Write', { file_path: O('config/example.env'), content: 'K=' }]);
expectRoutine('4 Write state.key.js stays routine', ['Write', { file_path: O('src/state.key.js'), content: 'x' }]);

expectHard('4 pin: git worktree list still asks (the dead case is removed, not revived)', sh('git worktree list'));

expectHard('4 RED Write CLAUDE.md is settings', ['Write', { file_path: O('CLAUDE.md'), content: 'x' }], 'settings');
expectHard('4 RED Edit a nested CLAUDE.md is settings', ['Edit', { file_path: O('docs/CLAUDE.md'), old_string: 'a', new_string: 'b' }], 'settings');
expectHard('4 RED Write CLAUDE.local.md is settings', ['Write', { file_path: O('CLAUDE.local.md'), content: 'x' }], 'settings');
expectHard('4 RED Write .claude/CLAUDE.md is settings', ['Write', { file_path: O('.claude/CLAUDE.md'), content: 'x' }], 'settings');
expectHard('4 RED a redirect onto CLAUDE.md is settings', sh('echo x >> CLAUDE.md'), 'settings');
expectHard('4 RED Write claude.md in another letter case is settings', ['Write', { file_path: O('Claude.MD'), content: 'x' }], 'settings');
expectRoutine('4 Read CLAUDE.md stays routine', ['Read', { file_path: O('CLAUDE.md') }]);
expectRoutine('4 cat CLAUDE.md stays routine', sh('cat CLAUDE.md'));
expectRoutine('4 sed -n of CLAUDE.md stays routine', sh("sed -n '1,5p' CLAUDE.md"));
expectRoutine('4 a file in a folder named claude-md stays routine', ['Write', { file_path: O('docs/claude-md/README.md'), content: 'x' }]);

test('4 RED a secret added to a big folder is seen within 2 s (the reach cache lives 2 s, not 10 s)', async () => {
  const big = O('big');
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(big, 'f' + i + '.txt'), '');
  const grep = ['Grep', { pattern: 'TODO', path: big }];
  assert.equal(run(grep).code, 'routine', 'the big folder holds no secret yet');
  fs.writeFileSync(path.join(big, '.env'), 'K=1\n');
  await sleep(2300);
  assert.equal(run(grep).code, 'credentials', 'after 2.3 s the new .env is seen');
});
