// WP-AUTONOMY-GW, escalation round: the READ side of the autonomy gate, fixed as a class.
// Four review rounds kept finding holes in a gate that judged a read by the NAME written in the card.
// The rule is structural now: a read is approved without the owner only when Forge can prove WHERE it
// really lands and WHAT it can reach.
//   F1  every read target is resolved to its real location (links, junctions and Windows 8.3 short names
//       are followed) before the sensitive-name check; a path part that looks like a short name (`~1`) asks.
//   F2  a wildcard in a reader argument asks unless every file it expands to is proven non-sensitive
//       (bash: expanded here, as a superset; PowerShell and the Read/Grep path inputs: always ask).
//   F3  reads are approved only inside the project folder or the OS temp folder; a search (grep -r, rg,
//       the Grep tool, Get-ChildItem | Select-String) asks when its folder can reach a sensitive file.
//       This knowingly narrows the earlier owner choice R-0203 ("a read outside the project is routine").
//   F4  writing under .claude/skills, .claude/agents or .claude/output-styles is settings-class; reading stays routine.
//   F5  more sensitive names (.envrc, prod.env, .yarnrc.yml, Chromium stores, gcloud, Windows Credential
//       Manager) and ONE shared isLoopbackHost.
// Every row was run against the pre-fix code first (RED), then against the fix (GREEN).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyHardGate } from '../src/permissions/hard-gate.mjs';
import * as allowList from '../src/permissions/allow-list.mjs';

const WIN = process.platform === 'win32';
// the real location: the classifier follows links, and on Windows the temp folder itself may be a short name
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-readclass-')));
after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
const ROOT = path.join(BASE, 'proj');
const OTHER = path.join(BASE, 'other');
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const OPTS = { cwd: ROOT, home: HOME, tmp: TMP };
const R = (p) => path.join(ROOT, p);
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

put(R('package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } }));
put(R('.env'), 'KEY=1\n');
put(R('.mcp.json'), '{}');
put(R('.claude/settings.json'), '{}');
put(R('.claude/skills/x/SKILL.md'));
put(R('.claude/agents/a.md'));
put(R('.git/HEAD'), 'ref: refs/heads/main\n');
put(R('src/a.js'));
put(R('src/b.js'));
put(R('docs/readme.md'));
put(R('conf/prod.env'), 'KEY=1\n');
put(R('clean/deep/c.js'));
put(R('mixed/.env'), 'KEY=1\n'); // a folder with a secret next to ordinary files, and no link in it
put(R('mixed/app.js'));
put(R('mixed/data.json'), '{}');
put(R('longfoldername/inner.js'));
put(path.join(OTHER, 'readme.md'));
put(path.join(OTHER, 'notes.txt'));
put(path.join(OTHER, 'src', 'x.js'));
put(path.join(HOME, '.claude.json'), '{}');
put(path.join(HOME, 'notes.txt'));
put(path.join(TMP, 't.log'));
fs.mkdirSync(R('viaLink'), { recursive: true });
let LINKS = true; // a junction needs no admin rights on Windows; a symlink may on other setups
try {
  fs.symlinkSync(OTHER, R('linkout'), WIN ? 'junction' : 'dir');
  fs.symlinkSync(R('src'), R('linkin'), WIN ? 'junction' : 'dir');
  fs.symlinkSync(OTHER, R('viaLink/out'), WIN ? 'junction' : 'dir');
} catch { LINKS = false; }

const sh = (command) => ['Bash', { command }];
const ps = (command) => ['PowerShell', { command }];
const run = ([tool, input]) => classifyHardGate(tool, input, OPTS);
const q = (p) => '"' + p + '"';
const fwd = (p) => p.replace(/\\/g, '/');

function expectHard(label, call, code) {
  test(label, () => {
    const got = run(call);
    assert.equal(got.hard, true, JSON.stringify({ call, got }));
    if (code) assert.equal(got.code, code, JSON.stringify({ call, got }));
  });
}
function expectRoutine(label, call) {
  test(label, () => {
    const got = run(call);
    assert.equal(got.code, 'routine', JSON.stringify({ call, got }));
  });
}

/** The Windows 8.3 short path of an existing file or folder; null when the volume makes none. */
function shortPath(p) {
  if (!WIN) return null;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("' + p + '") do @echo %~sI'], { windowsVerbatimArguments: true, encoding: 'utf8' }).trim();
    return out && out.toLowerCase() !== p.toLowerCase() && /~\d/.test(out) ? out : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- F1: 8.3 short names and real locations
const SHORT_HOME_JSON = shortPath(path.join(HOME, '.claude.json'));
const SHORT_MCP = shortPath(R('.mcp.json'));
const SHORT_DIR_FILE = shortPath(R('longfoldername/inner.js'));
test('F1 fixture: this volume makes 8.3 short names (otherwise the real-file rows below are skipped)', (t) => {
  if (!SHORT_HOME_JSON) t.skip('no 8.3 short names on this volume');
});
if (SHORT_HOME_JSON) {
  expectHard('F1 Read of ~/.claude.json through its 8.3 short name is a credentials card', ['Read', { file_path: SHORT_HOME_JSON }], 'credentials');
  expectHard('F1 cat of ~/.claude.json through its 8.3 short name asks', sh('cat ' + q(fwd(SHORT_HOME_JSON))));
  expectHard('F1 Get-Content of ~/.claude.json through its 8.3 short name asks', ps('Get-Content ' + SHORT_HOME_JSON));
}
if (SHORT_MCP) {
  expectHard('F1 Read of the project .mcp.json through its 8.3 short name is a credentials card', ['Read', { file_path: SHORT_MCP }], 'credentials');
  expectHard('F1 cat of the project .mcp.json through its relative 8.3 short name asks', sh('cat ' + path.basename(SHORT_MCP)));
  expectHard('F1 Grep tool on the project .mcp.json through its 8.3 short name asks', ['Grep', { pattern: 'token', path: SHORT_MCP }]);
}
if (SHORT_DIR_FILE) {
  expectHard('F1 an ordinary project file through a short folder name still asks (a short name is never proven)', sh('cat ' + q(fwd(SHORT_DIR_FILE))));
}
const SHORT_ROOT = shortPath(ROOT);
if (SHORT_ROOT && SHORT_MCP) {
  test('F1 the project folder itself may be known by a short name (a temp folder often is); a short name below it still asks', () => {
    const o = { cwd: SHORT_ROOT, home: HOME, tmp: TMP };
    assert.equal(classifyHardGate('Read', { file_path: path.join(SHORT_ROOT, 'src', 'a.js') }, o).code, 'routine');
    assert.equal(classifyHardGate('Write', { file_path: path.join(SHORT_ROOT, 'src', 'new.js'), content: 'x' }, o).code, 'routine');
    assert.equal(classifyHardGate('Read', { file_path: path.join(SHORT_ROOT, path.basename(SHORT_MCP)) }, o).code, 'credentials');
    assert.equal(classifyHardGate('Write', { file_path: path.join(SHORT_ROOT, 'src', 'NEWFIL~1.JS'), content: 'x' }, o).hard, true);
    assert.equal(classifyHardGate('Bash', { command: 'echo x > src/NEWFIL~1.JS' }, o).hard, true);
  });
}
expectHard('F1 a short name as a write target asks (redirect)', sh('echo x > docs/NOTESF~1.MD'));
expectHard('F1 a short name as a write target asks (Write)', ['Write', { file_path: R('docs/NOTESF~1.MD'), content: 'x' }]);
expectHard('F1 a path part that looks like a short name asks (shell)', sh('cat src/ABCDEF~1.JS'));
expectHard('F1 a path part that looks like a short name asks (Read)', ['Read', { file_path: R('src/ABCDEF~1.JS') }]);
expectHard('F1 a path part that looks like a short name asks (PowerShell)', ps('Get-Content src\\ABCDEF~1.JS'));
expectHard('F1 a path part that looks like a short name asks (option value)', sh('diff --from-file=src/ABCDEF~1.JS src/a.js'));

// ---------------------------------------------------------------- F2: wildcards in reader arguments
expectHard('F2 cat .en? reaches .env', sh('cat .en?'));
expectHard('F2 head *.env reaches a secret file', sh('head -5 conf/*.env'));
expectHard('F2 cat conf/* reaches prod.env', sh('cat conf/*'));
expectHard('F2 grep KEY .m* reaches .mcp.json', sh('grep KEY .m*'));
expectHard('F2 sed -n over a wildcard that reaches .env', sh("sed -n '1,3p' .e*"));
expectHard('F2 a wildcard folder that reaches .claude/settings.json', sh('cat .cl*/settings.json'));
expectHard('F2 a ** wildcard is never expanded here', sh('cat src/**/a.js'));
expectHard('F2 PowerShell Get-Content .m*', ps('Get-Content .m*'));
expectHard("F2 PowerShell Get-Content '.en?' (PowerShell expands a quoted wildcard too)", ps("Get-Content '.en?'"));
expectHard('F2 PowerShell Select-String -Path with a wildcard', ps('Select-String -Path *.json -Pattern token'));
expectHard("F2 PowerShell Get-Content with a quoted bracket wildcard", ps("Get-Content '.en[v]'"));
expectHard('F2 Read tool path with a wildcard', ['Read', { file_path: R('.en*') }]);
expectHard('F2 Grep tool path with a wildcard', ['Grep', { pattern: 'x', path: R('.clau?e') }]);
expectHard('F2 Glob tool pattern that can list the secret file', ['Glob', { pattern: '.e*' }]);
expectHard('F2 Glob tool pattern **/*.json can list .mcp.json', ['Glob', { pattern: '**/*.json' }]);
expectHard('F2 Glob tool pattern that leaves the folder', ['Glob', { pattern: '../other/**/*.md' }]);
expectRoutine('F2 a wildcard whose every expansion is an ordinary project file stays routine (cat)', sh('cat src/*.js'));
expectRoutine('F2 a wildcard whose every expansion is an ordinary project file stays routine (grep)', sh('grep -n foo src/*.js'));
expectRoutine('F2 a lister with a wildcard stays routine', sh('ls -la *.md src/*.js'));
expectRoutine('F2 wc -l over a wildcard stays routine', sh('wc -l src/*.js'));
expectHard('F2 Glob tool pattern that can list the secret file of its folder', ['Glob', { pattern: '.e*', path: R('mixed') }], 'credentials');
expectRoutine('F2 a Glob that cannot list a sensitive file stays routine', ['Glob', { pattern: '**/*.js', path: R('mixed') }]);
expectRoutine('F2 a Glob with the folder in its pattern stays routine', ['Glob', { pattern: 'clean/**/*.js' }]);
expectRoutine('F2 a regular expression is not a wildcard path', sh("grep -n 'a.*b[0-9]?' src/a.js"));
expectRoutine('F2 grep --include is a filter, not a path', sh('grep -rn TODO src --include=*.js'));

// ---------------------------------------------------------------- F3: searches and reads outside the project
expectHard('F3 Grep tool: path=.claude with glob settings*.json reads the settings file', ['Grep', { pattern: 'token', path: R('.claude'), glob: 'settings*.json' }], 'credentials');
expectHard('F3 Grep tool at the project root can reach .env', ['Grep', { pattern: 'KEY' }], 'credentials');
expectHard('F3 Grep tool outside the project', ['Grep', { pattern: 'x', path: OTHER }], 'outside_folder');
expectRoutine('F3 Grep tool in a clean subfolder stays routine', ['Grep', { pattern: 'x', path: R('src') }]);
expectHard('F3 Grep tool in a folder with a secret and no glob', ['Grep', { pattern: 'KEY', path: R('mixed') }], 'credentials');
expectHard('F3 Grep tool with a glob that can still match the secret', ['Grep', { pattern: 'KEY', path: R('mixed'), glob: '.e*' }], 'credentials');
expectHard('F3 Grep tool with a brace glob is not narrowed', ['Grep', { pattern: 'KEY', path: R('mixed'), glob: '*.{js,env}' }]);
expectRoutine('F3 Grep tool with a glob no sensitive file can match stays routine', ['Grep', { pattern: 'x', path: R('mixed'), glob: '*.js' }]);
expectHard('F3 grep -r from the project root can reach .env', sh('grep -r KEY .'), 'credentials');
expectHard('F3 grep -rn with no folder searches the working folder', sh('grep -rn KEY'));
expectHard('F3 grep -rn started at a .claude folder', sh('grep -rn token .claude'), 'credentials');
expectHard('F3 rg searches the working folder', sh('rg KEY'));
expectHard('F3 rg --files-with-matches still reads the files', sh('rg -l KEY .claude'));
expectHard('F3 diff -r of a folder that holds a secret', sh('diff -r conf clean'));
expectRoutine('F3 grep -rn in a clean subfolder stays routine', sh('grep -rn TODO src'));
expectRoutine('F3 rg in a clean subfolder stays routine', sh('rg -n TODO src clean'));
expectRoutine('F3 listing the project root stays routine (names only)', sh('ls -la'));
expectRoutine('F3 find only lists names', sh("find . -name '*.js'"));
expectHard('F3 Get-ChildItem -Recurse | Select-String reads every file', ps('Get-ChildItem -Recurse | Select-String token'));
expectHard('F3 Get-ChildItem -Recurse .claude | Select-String', ps('Get-ChildItem -Recurse .claude | Select-String token'));
expectHard('F3 Get-ChildItem -Filter settings*.json piped into Select-String', ps('Get-ChildItem -Recurse -Filter settings*.json | Select-String token'));
expectHard('F3 a lister piped into Get-Content', ps('Get-ChildItem src | Get-Content'));
expectHard('F3 a path written by echo and piped into Get-Content', ps('Write-Output ..\\other\\notes.txt | Get-Content'));
expectRoutine('F3 Get-ChildItem of a clean subfolder piped into Select-String stays routine', ps('Get-ChildItem -Recurse src | Select-String token'));
expectRoutine('F3 Get-Content piped into Select-String stays routine', ps('Get-Content src\\a.js | Select-String token'));
expectHard('F3 cat outside the project', sh('cat ' + q(fwd(path.join(OTHER, 'readme.md')))), 'outside_folder');
expectHard('F3 Read outside the project', ['Read', { file_path: path.join(OTHER, 'readme.md') }], 'outside_folder');
expectHard('F3 grep -rn outside the project (relative)', sh('grep -rn TODO ../other/src'), 'outside_folder');
expectHard('F3 Get-Content outside the project', ps('Get-Content ' + path.join(OTHER, 'notes.txt')), 'outside_folder');
expectHard('F3 ls outside the project', sh('ls ' + q(fwd(OTHER))), 'outside_folder');
expectHard('F3 LS tool outside the project', ['LS', { path: OTHER }], 'outside_folder');
expectHard('F3 wc outside the project', sh('wc -l ../other/readme.md'));
expectHard('F3 sed -n outside the project', sh("sed -n '1,5p' ../other/readme.md"));
expectHard('F3 sort / cut / tail outside the project', sh('tail -5 ../other/notes.txt | cut -c1-80 | sort'));
expectHard('F3 an option value that names a file outside the project', sh('diff --from-file=../other/readme.md src/a.js'));
expectHard('F3 the home folder', sh('cat ~/notes.txt'));
expectHard('F3 find started outside the project', sh("find ../other -name '*.md'"));
expectRoutine('F3 cat inside the OS temp folder stays routine', sh('cat ' + q(fwd(path.join(TMP, 't.log')))));
expectRoutine('F3 Read inside the OS temp folder stays routine', ['Read', { file_path: path.join(TMP, 't.log') }]);
expectRoutine('F3 Read inside the project stays routine', ['Read', { file_path: R('src/a.js') }]);
expectRoutine('F3 sed -n inside the project stays routine', sh("sed -n '1,5p' src/a.js"));
test('F3 a folder too big to check is not proven (and the same folder within the limit is)', () => {
  const big = classifyHardGate('Grep', { pattern: 'x', path: R('clean') }, { ...OPTS, reachMax: 1 });
  assert.equal(big.hard, true, JSON.stringify(big));
  assert.equal(classifyHardGate('Grep', { pattern: 'x', path: R('clean') }, OPTS).code, 'routine');
  assert.equal(classifyHardGate('Bash', { command: 'grep -rn x clean' }, { ...OPTS, reachMax: 1 }).hard, true);
});
test('F3 a secret that appears in a folder later is seen at the next check', () => {
  put(R('later/a.js'));
  assert.equal(run(sh('grep -rn x later')).code, 'routine');
  put(R('later/.env'), 'K=1\n');
  assert.equal(run(sh('grep -rn x later')).code, 'credentials');
});
if (LINKS) {
  expectHard('F3 cat through a link in the project that points outside', sh('cat linkout/readme.md'), 'outside_folder');
  expectHard('F3 Read through a link in the project that points outside', ['Read', { file_path: R('linkout/readme.md') }], 'outside_folder');
  expectHard('F3 ls of a link in the project that points outside', sh('ls linkout'), 'outside_folder');
  expectHard('F3 a search whose folder holds a link that points outside', sh('grep -rn x viaLink'));
  expectHard('F3 a wildcard that expands to a link that points outside', sh('cat viaLink/*/readme.md'));
  expectRoutine('F3 a link in the project that stays in the project is fine', sh('grep -rn x linkin'));
}

// ---------------------------------------------------------------- F4: skills, agents and output styles
expectHard('F4 Write a SKILL.md', ['Write', { file_path: R('.claude/skills/x/SKILL.md'), content: 'x' }], 'settings');
expectHard('F4 Edit an agent file', ['Edit', { file_path: R('.claude/agents/a.md'), old_string: 'a', new_string: 'b' }], 'settings');
expectHard('F4 Write a new agent file', ['Write', { file_path: R('.claude/agents/new.md'), content: 'x' }], 'settings');
expectHard('F4 Write an output style', ['Write', { file_path: R('.claude/output-styles/s.md'), content: 'x' }], 'settings');
expectHard('F4 a redirect into an agent file', sh('echo x > .claude/agents/b.md'), 'settings');
expectHard('F4 a copy onto a skill file', sh('cp docs/readme.md .claude/skills/x/SKILL.md'), 'settings');
expectRoutine('F4 reading a skill stays routine', ['Read', { file_path: R('.claude/skills/x/SKILL.md') }]);
expectRoutine('F4 cat of an agent file stays routine', sh('cat .claude/agents/a.md'));

// ---------------------------------------------------------------- F5: more sensitive names, one loopback rule
const H = (p) => path.join(HOME, p);
const F5 = [
  ['.envrc', ['Read', { file_path: R('.envrc') }]],
  ['cat .envrc', sh('cat .envrc')],
  ['prod.env', ['Read', { file_path: R('conf/prod.env') }]],
  ['cat prod.env', sh('cat conf/prod.env')],
  ['.yarnrc.yml', ['Read', { file_path: R('.yarnrc.yml') }]],
  ['Chromium Login Data', ['Read', { file_path: H('AppData/Local/Google/Chrome/User Data/Default/Login Data') }]],
  ['Chromium Cookies', ['Read', { file_path: H('AppData/Local/Google/Chrome/User Data/Default/Network/Cookies') }]],
  ['Chromium Local State', ['Read', { file_path: H('AppData/Local/Microsoft/Edge/User Data/Local State') }]],
  ['cat Chromium Login Data', sh('cat ' + q(fwd(H('AppData/Local/Google/Chrome/User Data/Default/Login Data'))))],
  ['gcloud under %APPDATA%', ['Read', { file_path: H('AppData/Roaming/gcloud/credentials.db') }]],
  ['Windows Credential Manager: Credentials', ['Read', { file_path: H('AppData/Local/Microsoft/Credentials/ABCDEF0123') }]],
  ['Windows Credential Manager: Protect', ['Read', { file_path: H('AppData/Roaming/Microsoft/Protect/S-1-5-21/key') }]],
  ['Windows Credential Manager: Vault', ['Read', { file_path: H('AppData/Local/Microsoft/Vault/x/Policy.vpol') }]],
  ['the git config of the project (can hold a token in a remote URL)', sh('cat .git/config')],
];
for (const [label, call] of F5) expectHard('F5 sensitive name: ' + label, call, 'credentials');
expectRoutine('F5 searching for the text process.env is not a read of a .env file', sh('grep -rn "process.env" src'));
expectRoutine('F5 the word cookies in a search is not the browser store', sh('grep -rn cookies src'));
expectRoutine('F5 an example env file stays readable', ['Read', { file_path: R('example.env') }]);
test('F5 the words "local state" in a commit message are not a credentials card', () => {
  assert.notEqual(run(sh('git commit -m "fix local state"')).code, 'credentials');
});
test('F5 there is ONE isLoopbackHost, exported and shared by allow-list.mjs and hard-gate.mjs', () => {
  assert.equal(typeof allowList.isLoopbackHost, 'function');
  assert.equal(allowList.isLoopbackHost('127.0.0.1'), true);
  assert.equal(allowList.isLoopbackHost('example.com'), false);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'permissions');
  const defs = ['allow-list.mjs', 'hard-gate.mjs'].map((f) => (fs.readFileSync(path.join(dir, f), 'utf8').match(/(?:function\s+isLoopbackHost\b|isLoopbackHost\s*=\s*\()/g) || []).length);
  assert.deepEqual(defs, [1, 0], 'defined once in allow-list.mjs, imported by hard-gate.mjs');
  assert.match(fs.readFileSync(path.join(dir, 'hard-gate.mjs'), 'utf8'), /import\s*\{[^}]*\bisLoopbackHost\b[^}]*\}\s*from\s*'\.\/allow-list\.mjs'/);
});

// ---------------------------------------------------------------- adversarial pass: other read-side forms
const ADVERSARIAL = [
  // case
  ['upper-case secret name (shell)', sh('cat .ENV')],
  ['upper-case secret name (Read)', ['Read', { file_path: R('.MCP.JSON') }]],
  // device and share prefixes
  ['\\\\?\\ device prefix (Read)', ['Read', { file_path: '\\\\?\\' + path.join(OTHER, 'readme.md') }]],
  ['//?/ device prefix (shell)', sh('cat ' + q('//?/' + fwd(path.join(OTHER, 'readme.md'))))],
  ['\\\\.\\ device prefix (PowerShell)', ps('Get-Content \\\\.\\' + path.join(OTHER, 'readme.md'))],
  ['a share on this computer', sh('cat //localhost/c$/Users/owner/notes.txt')],
  ['a PowerShell provider-qualified path', ps('Get-Content Microsoft.PowerShell.Core\\FileSystem::' + path.join(OTHER, 'notes.txt'))],
  ['a PowerShell provider drive', ps('Get-ChildItem Env:')],
  // variables and the home folder
  ['$HOME', sh('cat $HOME/notes.txt')],
  ['${HOME}', sh('cat "${HOME}/notes.txt"')],
  ['%USERPROFILE%', sh('cat %USERPROFILE%/notes.txt')],
  ['$env:USERPROFILE', ps('Get-Content $env:USERPROFILE\\notes.txt')],
  ['PowerShell ~', ps('Get-Content ~\\notes.txt')],
  ['a command substitution as the path', sh('cat $(ls ../other)')],
  // here-strings and input redirects
  ['a PowerShell here-string', ps("Get-Content @'\nx\n'@")],
  ['a bash here-string', sh('cat <<< "x"')],
  ['an input redirect from outside', sh('grep x < ../other/readme.md')],
  // Git Bash special files
  ['/proc/self/environ', sh('cat /proc/self/environ')],
  ['/dev/clipboard', sh('cat /dev/clipboard')],
  // NTFS alias forms
  ['a stream suffix on an outside file', sh('cat ' + q(fwd(path.join(OTHER, 'notes.txt')) + '::$DATA'))],
  // git: secret blobs and patches
  ['git show of a secret path', sh('git show HEAD:.mcp.json')],
  ['git show of an object id (may be a blob)', sh('git show 0123abcd')],
  ['git show --stat of an object id (a blob ignores --stat)', sh('git show --stat 0123abcd4567')],
  ['git cat-file -p of an object id', sh('git cat-file -p 0123abcd')],
  ['git cat-file blob', sh('git cat-file blob 0123abcd')],
  ['git diff between object ids', sh('git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD')],
  ['git grep searches every tracked file', sh('git grep -n token')],
  ['git diff --no-index reads any two files', sh('git diff --no-index src/a.js ../other/readme.md')],
  ['git blame --contents reads any file', sh('git blame --contents ../other/readme.md src/a.js')],
  ['git diff with no path prints every changed file (a tracked secret too)', sh('git diff')],
  ['git log -p with no path', sh('git log -p -3')],
  ['git show of a commit with no path', sh('git show HEAD~1')],
  ['git log -p with a wildcard pathspec', sh("git log -p -- '.m*'")],
  ['git diff with a wildcard pathspec', sh("git diff -- '*.json'")],
  ['git pathspec magic', sh("git diff -- ':(icase).MCP.JSON'")],
  ['git diff of a folder that holds a secret', sh('git diff -- conf')],
  ['git status -v prints the staged patch', sh('git status -v')],
  ['git stash list -p prints patches', sh('git stash list -p')],
  ['git remote -v prints remote URLs (can hold a token)', sh('git remote -v')],
];
for (const [label, call] of ADVERSARIAL) expectHard('adversarial: ' + label, call);

// more forms found while fixing the class
put(R('scr1/package.json'), JSON.stringify({ scripts: { test: 'type ' + fwd(path.join(OTHER, 'notes.txt')) } }));
put(R('scr2/package.json'), JSON.stringify({ scripts: { test: 'type "*.env"' } }));
put(R('scr3/package.json'), JSON.stringify({ scripts: { test: 'type notes.txt' } }));
put(R('list.txt'), 'x\n');
const MORE_HARD = [
  ['a package script that prints a file outside the project (cmd.exe `type`)', sh('cd ./scr1 && npm test')],
  ['a package script with a quoted wildcard (cmd.exe expands it)', sh('cd ./scr2 && npm test')],
  ['sort --files0-from prints the files a list names', sh('sort --files0-from=list.txt')],
  ['find -newer compares with a file outside the project', sh('find . -newer ../other/readme.md')],
  ['bash .* also matches .. (the parent folder)', sh('cat .*/readme.md')],
  ['grep -e with a file outside the project', sh('grep -e x ../other/readme.md')],
  ['grep -f with a pattern file outside the project', sh('grep -f ../other/notes.txt src/a.js')],
  ['grep -r with no folder still searches the working folder when it reads a pipe', sh('echo x | grep -r KEY')],
  ['Select-String -Path outside the project', ps('Select-String -Path ..\\other\\notes.txt -Pattern x')],
  ['Select-String with the file as the second plain word', ps('Select-String x ..\\other\\notes.txt')],
  ['Select-String with a switch before the file', ps('Select-String -Quiet ..\\other\\notes.txt -Pattern x')],
  ['Get-FileHash outside the project', ps('Get-FileHash ..\\other\\notes.txt')],
  ['Test-Path outside the project', ps('Test-Path ..\\other\\notes.txt')],
  ['test -f outside the project', sh('test -f ../other/readme.md')],
  ['stat outside the project', sh('stat ../other/readme.md')],
  ['bash type (cmd.exe would print the file)', sh('type ../other/readme.md')],
];
for (const [label, call] of MORE_HARD) expectHard('adversarial: ' + label, call);

// the fixed code attacked once more: second arguments, `--`, quoting, filters, pipelines, links
const SELF_REVIEW_HARD = [
  ['a second file argument outside the project', sh('cat src/a.js ../other/readme.md')],
  ['a file after -- outside the project', sh('cat -- ../other/readme.md')],
  ['a search after -- in a folder with a secret', sh('grep -rn KEY -- mixed')],
  ['--include does not narrow what a recursive grep may read', sh('grep -r KEY mixed --include=app.js')],
  ['a wildcard that matches the dot file (.e*)', sh('cat mixed/.e*')],
  ['a ? that can stand for the leading dot', sh('cat mixed/?env')],
  ['a wildcard after a quoted folder', sh('head -c 100 "mixed"/*')],
  ['diff of a folder that holds a secret', sh('diff mixed clean')],
  ['rg --files of a folder that holds a secret', sh('rg --files mixed')],
  ['PowerShell wildcard in a content cmdlet', ps('Get-Content mixed\\*')],
  ['PowerShell lister of a folder with a secret piped into Select-String', ps('Get-ChildItem mixed | Select-String KEY')],
  ['PowerShell -Filter does not narrow what Select-String may read', ps('Get-ChildItem mixed -Filter *.js | Select-String KEY')],
  ['PowerShell Select-String on a folder path', ps('Select-String -Pattern KEY -Path mixed')],
  ['PowerShell a path piped into a lister', ps('Write-Output ..\\other | Get-ChildItem')],
  ['PowerShell a path piped into a lister and on into Select-String', ps('Write-Output ..\\other | Get-ChildItem | Select-String x')],
  ['PowerShell an object with a Path piped into Get-Content', ps("Write-Output '{}' | ConvertFrom-Json | Get-Content")],
  ['git diff of a folder with a secret', sh('git diff -- mixed')],
  ['git diff of a range of object ids', sh('git diff 0123abcd..4567cdef -- src/a.js')],
  ['git log -L prints a patch', sh('git log -L 1,5:src/a.js')],
  ['git diff with a word before -- (a revision there, so every changed file can be printed)', sh('git diff src --')],
  ['Grep tool on a link that points outside', ['Grep', { pattern: 'x', path: R('linkout') }]],
  ['Glob tool below a folder with a link that points outside', ['Glob', { pattern: '**/*.md', path: R('viaLink') }]],
  ['LS tool through a link that points outside', ['LS', { path: R('viaLink/out') }]],
  ['NotebookRead outside the project', ['NotebookRead', { notebook_path: path.join(OTHER, 'n.ipynb') }]],
  ['a lister wildcard that matches a link pointing outside (bash)', sh('ls viaLink/*')],
  ['a lister wildcard that matches a link pointing outside (PowerShell)', ps('Get-ChildItem viaLink\\*')],
  ['a lister wildcard .* matches the parent folder', sh('ls -la .*')],
];
for (const [label, call] of SELF_REVIEW_HARD) if (LINKS || !/link/i.test(label)) expectHard('self-review: ' + label, call);

// `link/../x` names two files: Windows programs take the parent of the link, Git Bash programs (cat, grep,
// a redirect) the parent of where it points (seen on this computer: `cat link/../marker.txt` printed the
// file next to the link's TARGET). When the two differ the path is never approved, for a read or a write.
if (LINKS) {
  const PARENT_OF_LINK = [
    ['cat through the parent of a link that points outside', sh('cat linkout/../other/notes.txt')],
    ['a redirect through the parent of a link that points outside (a write outside the project)', sh('echo x > linkout/../other/evil.txt')],
    ['mkdir through the parent of a link that points outside', sh('mkdir -p linkout/../other/newdir')],
    ['ls of the parent of a link that points outside', sh('ls linkout/..')],
    ['an option value through the parent of a link', sh('diff --from-file=linkout/../other/notes.txt src/a.js')],
    // the path as typed (path.join would fold the `..` away): on Linux and macOS a tool follows the link first
    ['Write through the parent of a link', ['Write', { file_path: fwd(ROOT) + '/linkout/../other/evil.txt', content: 'x' }]],
    ['Read through the parent of a link', ['Read', { file_path: fwd(ROOT) + '/linkout/../other/notes.txt' }]],
  ];
  for (const [label, call] of PARENT_OF_LINK) expectHard('parent of a link: ' + label, call);
  expectRoutine('parent of a link: a link whose parent is the same folder either way stays routine', sh('cat linkin/../docs/readme.md'));
}
expectRoutine('parent step: an ordinary ../ inside the project stays routine', sh('cat src/../docs/readme.md'));
expectRoutine('parent step: a wildcard after a leading ../ stays routine', sh('cd ./scr3 && grep -n x ../src/*.js'));
expectHard('parent step: a ../ at or after the wildcard is never read', sh('cat src/*/../../.env'));

// grep and rg are read exactly: which word is the pattern decides whether the working folder is searched
put(R('mixed/KEY'));
const SEARCH_HARD = [
  ['an option value is not the pattern: the real pattern names an existing file, the search is the working folder', sh('cd ./mixed && grep -r -A 1 app.js')],
  ['-e gives the pattern: the working folder is searched', sh('cd ./mixed && grep -r -e KEY')],
  ['an abbreviated long option (--rec) is not understood: the working folder is assumed', sh('cd ./mixed && grep --rec KEY')],
  ['an unknown option: the working folder is assumed', sh('cd ./mixed && grep --weird KEY app.js')],
  ['grep -d recurse', sh('cd ./mixed && grep -d recurse KEY')],
  ['rg --color takes a value: the next word is not the pattern', sh('cd ./mixed && rg --color never KEY')],
  ['rg -g does not narrow what a search may read', sh("cd ./mixed && rg -g '*.js' KEY")],
  ['rg --files lists the working folder', sh('cd ./mixed && rg --files')],
  ['a pattern file outside the project, attached to -f', sh('grep -f../other/notes.txt src/a.js')],
];
for (const [label, call] of SEARCH_HARD) expectHard('search: ' + label, call);
const SEARCH_ROUTINE = [
  ['a named file in a folder with a secret', sh('cd ./mixed && grep -rn -m 1 KEY app.js')],
  ['--regexp= gives the pattern, so the one plain word is the file to search', sh('cd ./mixed && grep -r --regexp=x KEY')],
  ['grep without -r and a named file', sh('cd ./mixed && grep -n -A 2 KEY app.js data.json')],
  ['grep -rn in a clean working folder', sh('cd ./clean && grep -rn KEY')],
  ['grep -c with context digits', sh('grep -3 -c KEY src/a.js')],
  ['grep with -e and a clean folder', sh('grep -rn -e KEY -e OTHER src')],
  ['rg with a type and a clean folder', sh('rg -n -t js --max-count 3 KEY src')],
  ['a regular expression after options with values', sh("grep -rn -A 2 --include '*.js' 'a.*b[0-9]?' src")],
];
for (const [label, call] of SEARCH_ROUTINE) expectRoutine('search still routine: ' + label, call);
const SELF_REVIEW_ROUTINE = [
  ['a quoted star is a file name in bash, not a wildcard', sh('cat mixed/"*"')],
  ['several ordinary files', sh('tail -n +1 mixed/app.js mixed/data.json')],
  ['rg with flags in a clean folder', sh('rg KEY --no-ignore --hidden src')],
  ['git log -p of one ordinary file in a folder with a secret', sh('git log -p -- mixed/app.js')],
  ['a lister wildcard in a folder with a secret (its name is only shown)', sh('ls -la mixed/*')],
  ['PowerShell lister wildcard', ps('Get-ChildItem src\\*.js')],
  ['Glob tool in a clean folder', ['Glob', { pattern: '**/*', path: R('clean') }]],
  ['LS tool of the project root', ['LS', { path: ROOT }]],
];
for (const [label, call] of SELF_REVIEW_ROUTINE) expectRoutine('self-review still routine: ' + label, call);
const MORE_ROUTINE = [
  ['a package script that reads a project file', sh('cd ./scr3 && npm test')],
  ['grep --include as a separate quoted value', sh("grep -rn TODO src --include '*.js'")],
  ['grep -e with a project file', sh('grep -e KEY mixed/app.js')],
  ['grep on a pipe', sh('cat src/a.js | grep -n KEY | wc -l')],
  ['rg on a pipe reads the pipe', sh('cat src/a.js | rg -n TODO')],
  ['git log --oneline of a folder prints no file text', sh('git log --oneline -5 -- .')],
  ['test -f inside the project', sh('test -f src/a.js && echo ok')],
  ['stat and du inside the project', sh('stat src/a.js && du -sh src')],
  ['Select-String -Path inside the project', ps('Select-String -Path src\\a.js -Pattern x')],
  ['Test-Path inside the project', ps('Test-Path src\\a.js')],
];
for (const [label, call] of MORE_ROUTINE) expectRoutine('still routine: ' + label, call);
const STILL_ROUTINE = [
  ['git status', sh('git status --short')],
  ['git diff --stat', sh('git diff --stat')],
  ['git diff of named ordinary files', sh('git diff -- src/a.js src/b.js')],
  ['git diff -U2 of a clean folder', sh('git diff -U2 HEAD~1 -- src')],
  ['git log --oneline', sh('git log --oneline -5')],
  ['git log with a format', sh("git log -3 --format='%h %ci %s' -- src/a.js")],
  ['git log -p of a named ordinary file', sh('git log -p -2 -- src/a.js')],
  ['git show --stat HEAD', sh('git show --stat HEAD')],
  ['git show of an ordinary path at a revision', sh('git show HEAD:src/a.js')],
  ['git cat-file -t', sh('git cat-file -t HEAD')],
  ['git remote (names only)', sh('git remote')],
  ['git rev-parse', sh('git rev-parse --show-toplevel')],
  ['git blame of an ordinary file', sh('git blame -L 1,5 src/a.js')],
  ['cat with a heredoc into a project file', sh("cat > docs/n.md <<'EOF'\nhello\nEOF")],
  ['head and tail in a pipe', sh('cat src/a.js | head -5 | tail -2')],
  ['Select-String with a pattern and a file', ps("Select-String -Pattern 'a.*b' src\\a.js")],
  ['Get-ChildItem with a filter', ps('Get-ChildItem -Recurse -Filter *.js src | Select-Object -First 5')],
];
for (const [label, call] of STILL_ROUTINE) expectRoutine('still routine: ' + label, call);

// a clean repository inside the project: git prints the working tree, never its own .git folder
put(R('repo2/.git/config'), '[core]\n');
put(R('repo2/.git/HEAD'), 'ref: refs/heads/main\n');
put(R('repo2/a.js'));
expectRoutine('git: a plain git diff in a repository without a sensitive file stays routine', sh('cd ./repo2 && git diff'));
expectRoutine('git: git log -p in a clean repository stays routine', sh('cd ./repo2 && git log -p -3'));
expectRoutine('git: git show of a commit in a clean repository stays routine', sh('cd ./repo2 && git show HEAD~1'));
expectRoutine('git: git diff -- . in a clean repository stays routine', sh('cd ./repo2 && git diff HEAD -- .'));
expectHard('git: a recursive grep of the same folder does read .git/config', sh('cd ./repo2 && grep -rn url .'), 'credentials');
expectHard('git: a folder without a repository cannot be proven', sh('cd ./clean && git diff'));
