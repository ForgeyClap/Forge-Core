#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-setup-inventory.test.cjs (WP-AS-INV): the read-only inventory step of forge-audit-setup.
 * A fixture project root and a fixture home are built in TMP_RUN with canary values planted where secrets live
 * (env values, MCP command/url/headers, hook arguments, .credentials.json, .env, secrets/, a malformed JSON file).
 * No canary may reach the JSON or the text output, and no forbidden file may even be opened.
 */
const nodeTest = require('node:test');
// The doctor and forge-test-tally.test.cjs read a '<n> passed, <m> failed' line (node:test's own summary reads as 0/0).
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, 'forge-setup-inventory.cjs');
const INV = require(TOOL);

// Canaries are built at runtime so no secret-shaped literal sits in this file.
const C = (tag) => 'CANARY' + '-' + tag + '-' + 'zq' + '9x'; // FAKE test value
const CANARY = {
  env: C('ENVVAL'), mcpCmd: C('MCPCMD'), mcpArg: C('MCPARG'), mcpUrlHost: C('mcphost').toLowerCase(),
  mcpHeader: C('HEADER'), mcpEnv: C('MCPENV'), hookArg: C('HOOKARG'), cred: C('CRED'), dotenv: C('DOTENV'),
  secretDir: C('SECRETDIR'), malformed: C('MALFORMED'), helper: C('HELPER'), permRule: C('PERMRULE'),
  pem: C('PEM'), rsa: C('RSA'), projMcp: C('PROJMCP'), attr: C('ATTR'), modelSet: C('MODELSET'),
  plugHook: C('PLUGHOOK'), plugHook2: C('PLUGHOOK2'), plugProj: C('PLUGPROJ'), plugMcp: C('PLUGMCP'), plugEsc: C('PLUGESC'),
  // rv-as-final-034807 finding 3: a leading NAME=value in a hook command must never reach command_basename
  assign: C('ASSIGN'), assignScript: C('ASSIGNSH'),
  // rv-as-final-034807-r2 finding 1: a quoted value with a space must not leak its tail
  q1: C('QUOTED1'), q2: C('QUOTED2'), q3: C('QUOTED3'),
  // Verify Boss break attempt: an unterminated quote in an assignment must not leak a fragment
  unterm: C('UNTERM'),
};
const ALL_CANARIES = Object.values(CANARY);

function w(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

function buildFixture() {
  const base = fs.mkdtempSync(path.join(TMP_RUN, 'fx-'));
  const root = path.join(base, 'proj');
  const home = path.join(base, 'home', '.claude');
  // ---- global layer
  w(path.join(home, 'CLAUDE.md'), '# global\n\nRead and obey:\n@MODEL_ROUTING_GLOBAL_POLICY.md\n\nsome text\n@' + path.join(home, 'ECC_GLOBAL_POLICY.md') + '\n');
  w(path.join(home, 'settings.json'), JSON.stringify({
    model: 'sonnet[1m]', effortLevel: 'medium', ultracode: true, theme: 'dark',
    includeCoAuthoredBy: true, attribution: { commit: CANARY.attr },
    modelSettings: { opus: { effortLevel: 'high', other: CANARY.modelSet }, sonnet: { other: CANARY.modelSet }, fable: 'x' },
    apiKeyHelper: 'echo ' + CANARY.helper,
    experimentalWidgets: { on: true },
    env: { API_TOKEN: CANARY.env, PLAIN_SETTING: CANARY.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, // FAKE test value
    permissions: { defaultMode: 'auto', allow: ['Bash(git status:*)', 'Read', 'mcp__srv__tool', 'Bash(echo ' + CANARY.permRule + ')'], deny: ['WebFetch(domain:x.example)'], ask: [] },
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "' + path.join(home, 'hooks', 'goat-stop-gate.cjs').replace(/\\/g, '/') + '" --flag ' + CANARY.hookArg }] }],
      PreToolUse: [
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node C:\\x\\forge-gate-hook.cjs ' + CANARY.hookArg }] },
        { matcher: 'Workflow', hooks: [{ type: 'command', command: 'mytool ' + CANARY.hookArg }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: 'X_TOKEN=' + CANARY.assign + ' mytool --go' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'env A_KEY=' + CANARY.assignScript + '.sh B=1 node run.cjs' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'X_TOKEN="' + CANARY.q1 + ' ' + CANARY.q2 + '" mytool', timeout: 7, onFailure: 'block' }] },
        { matcher: 'Glob', hooks: [{ type: 'command', command: "Y='" + CANARY.q3 + " b.sh' mytool" }] },
        { matcher: 'Grep', hooks: [{ type: 'command', command: 'FOO="unterminated ' + CANARY.unterm + ' mytool' }] },
      ],
    },
    enabledPlugins: { 'codex@openai-codex': false, 'superpowers@official': true },
    mcpServers: {
      localsrv: { command: CANARY.mcpCmd, args: [CANARY.mcpArg], env: { SECRET_X: CANARY.mcpEnv } },
      remotesrv: { type: 'http', url: 'https://' + CANARY.mcpUrlHost + '.example/mcp', headers: { Authorization: 'Bearer ' + CANARY.mcpHeader } },
      ssesrv: { type: 'sse', url: 'http://' + CANARY.mcpUrlHost + '.example/sse' },
    },
  }, null, 2));
  w(path.join(home, '.credentials.json'), JSON.stringify({ token: CANARY.cred })); // FAKE test value
  w(path.join(home, 'credentials.json'), JSON.stringify({ token: CANARY.cred }));
  w(path.join(home, 'secrets', 'k.json'), CANARY.secretDir);
  w(path.join(home, '.env'), 'X=' + CANARY.dotenv);
  w(path.join(home, 'hooks', 'goat-stop-gate.cjs'), '// ' + CANARY.hookArg);
  w(path.join(home, 'hooks', 'usage-guard.cjs'), '');
  w(path.join(home, 'hooks', 'id_rsa'), CANARY.rsa);
  w(path.join(home, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Use when testing alpha.\ndisable-model-invocation: true\n---\nbody ' + CANARY.env + '\n');
  w(path.join(home, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: "Twelve chars"\n---\n');
  w(path.join(home, 'skills', 'gamma', 'README.md'), 'no skill file');
  w(path.join(home, 'skills', 'secrets', 'SKILL.md'), '---\nname: s\ndescription: ' + CANARY.secretDir + '\n---\n');
  w(path.join(home, 'agents', 'build.md'), '---\nname: build\nmodel: opus\neffort: medium\n---\nbody\n');
  w(path.join(home, 'agents', 'plain.md'), 'no frontmatter\n');
  w(path.join(home, 'agents', 'notes.txt'), 'x');
  w(path.join(home, 'commands', 'model-route.md'), 'content ' + CANARY.env);
  w(path.join(home, 'commands', 'key.pem'), CANARY.pem);
  // ---- project layer
  w(path.join(root, 'CLAUDE.md'), 'line one\nline two\nline three\n');
  w(path.join(root, '.claude', 'settings.json'), '{ "model": "' + CANARY.malformed + '", broken'); // malformed
  // settings.local.json intentionally missing
  w(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { projsrv: { command: 'node', args: [CANARY.projMcp] } } }));
  w(path.join(root, '.env'), 'X=' + CANARY.dotenv);
  w(path.join(root, '.env.local'), 'X=' + CANARY.dotenv);
  w(path.join(root, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: abc\n---\n');
  w(path.join(root, '.claude', 'agents', 'head-chef.md'), '---\nmodel: sonnet\neffort: low\n---\n');
  w(path.join(root, '.claude', 'commands', 'forge.md'), 'x');
  // ---- plugins (the --plugins-json fixture, shaped like `claude plugin list --json`)
  const pa = path.join(home, 'plugins', 'cache', 'm', 'alpha-plug', '1.0.0');
  w(path.join(pa, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node ' + CANARY.plugHook, async: true }, { type: 'command', command: CANARY.plugHook2 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'x', args: [CANARY.plugHook] }] }],
  } }));
  const pb = path.join(home, 'plugins', 'cache', 'm', 'beta-plug', '2.0.0');
  w(path.join(pb, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'beta', hooks: './cfg/h.json' }));
  w(path.join(pb, 'cfg', 'h.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CANARY.plugHook }] }] } }));
  const pc = path.join(home, 'plugins', 'cache', 'm', 'esc-plug', '1.0.0');
  w(path.join(pc, '.claude-plugin', 'plugin.json'), JSON.stringify({ hooks: '../../../../escape.json' }));
  w(path.join(home, 'plugins', 'escape.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: CANARY.plugEsc }] }] } }));
  const pd = path.join(home, 'plugins', 'cache', 'm', 'off-plug', '1.0.0');
  w(path.join(pd, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: CANARY.plugHook }] }] } }));
  const plugins = path.join(base, 'plugins.json');
  w(plugins, JSON.stringify([
    { id: 'alpha-plug@m', version: '1.0.0', scope: 'user', enabled: true, installPath: pa, installedAt: 'now', mcpServers: { s: { command: CANARY.plugMcp } } },
    { id: 'beta-plug@m', version: '2.0.0', scope: 'project', enabled: true, installPath: pb, projectPath: 'C:\\' + CANARY.plugProj },
    { id: 'esc-plug@m', version: '1.0.0', scope: 'user', enabled: true, installPath: pc },
    { id: 'off-plug@m', version: '1.0.0', scope: 'user', enabled: false, installPath: pd },
    { id: 'nopath-plug@m', version: '3.0.0', scope: 'local', enabled: true },
  ]));
  return { root, home, plugins };
}

function noCanary(text, where) {
  for (const c of ALL_CANARIES) assert.ok(!text.includes(c), where + ' leaks canary ' + c.slice(0, 14));
  assert.ok(!/Bearer/.test(text), where + ' leaks a Bearer header');
}
function noHome(text, where) {
  const h = os.homedir();
  for (const v of [h, h.replace(/\\/g, '/'), h.replace(/\//g, '\\')]) {
    assert.ok(!text.toLowerCase().includes(v.toLowerCase()), where + ' leaks the home path');
    assert.ok(!text.toLowerCase().includes(JSON.stringify(v).slice(1, -1).toLowerCase()), where + ' leaks the escaped home path');
  }
}

const FX = buildFixture();

test('isForbiddenPath blocks credential, env, key and secrets paths and allows .env.example', () => {
  for (const p of ['.credentials.json', 'a/credentials.json', '.env', '.env.local', 'x/.env.production', 'k.pem', 'id_rsa', 'id_rsa.pub', 'secrets/x.json', 'a/secrets/b/c.md']) {
    assert.strictEqual(INV.isForbiddenPath(p), true, p);
  }
  for (const p of ['.env.example', 'settings.json', 'skills/alpha/SKILL.md', 'CLAUDE.md']) assert.strictEqual(INV.isForbiddenPath(p), false, p);
});

test('never opens a forbidden file while taking the inventory', () => {
  const opened = [];
  const orig = { readFileSync: fs.readFileSync, openSync: fs.openSync };
  fs.readFileSync = function (p, ...a) { opened.push(String(p)); return orig.readFileSync.call(fs, p, ...a); };
  fs.openSync = function (p, ...a) { opened.push(String(p)); return orig.openSync.call(fs, p, ...a); };
  try { INV.inventory({ root: FX.root, home: FX.home, claudeVersion: 'x', pluginsJson: FX.plugins }); } finally { Object.assign(fs, orig); }
  assert.ok(opened.length > 3, 'some files were read');
  for (const p of opened) {
    const b = path.basename(p);
    assert.ok(!/^\.?credentials\.json$/i.test(b) && !/^\.env/i.test(b) && !/\.pem$/i.test(b) && !/^id_rsa/i.test(b), 'opened ' + b);
    assert.ok(!/[\\/]secrets[\\/]/i.test(p), 'opened a file under secrets/');
  }
});

test('JSON inventory counts hooks, skills, agents, plugins, mcp and permissions correctly', () => {
  const inv = INV.inventory({ root: FX.root, home: FX.home, claudeVersion: '9.9.9 (Claude Code)', pluginsJson: FX.plugins });
  assert.strictEqual(inv.schema, 'forge-setup-inventory/v1');
  assert.strictEqual(inv.claude_code_version, '9.9.9 (Claude Code)');
  const g = inv.global, p = inv.project;
  assert.deepStrictEqual(g.claude_md.includes, ['MODEL_ROUTING_GLOBAL_POLICY.md', 'ECC_GLOBAL_POLICY.md']);
  assert.strictEqual(p.claude_md.exists, true);
  assert.strictEqual(p.claude_md.lines, 3);
  const s = g.settings['settings.json'];
  assert.strictEqual(s.exists, true);
  assert.ok(s.keys.includes('apiKeyHelper') && s.keys.includes('env') && s.keys.includes('hooks'));
  assert.deepStrictEqual(s.values, { model: 'sonnet[1m]', effortLevel: 'medium', ultracode: true, theme: 'dark', attribution_present: true, 'permissions.defaultMode': 'auto' });
  assert.deepStrictEqual(s.modelSettings, { opus: { effortLevel: 'high' }, sonnet: {} });
  assert.deepStrictEqual(s.hooks, {
    Stop: [{ matcher: '', command_basename: 'goat-stop-gate.cjs' }],
    PreToolUse: [{ matcher: 'Bash|PowerShell', command_basename: 'forge-gate-hook.cjs' }, { matcher: 'Workflow', command_basename: 'mytool' },
      { matcher: 'Read', command_basename: '<assignment>' }, { matcher: 'Edit', command_basename: '<assignment>' },
      { matcher: 'Write', command_basename: '<assignment>', timeout: 7, on_failure: 'block' }, { matcher: 'Glob', command_basename: '<assignment>' },
      { matcher: 'Grep', command_basename: '<assignment>' }],
  });
  assert.deepStrictEqual(s.permissions, { allow: 4, deny: 1, ask: 0, tools: ['Bash', 'Read', 'WebFetch', 'mcp__srv__tool'] });
  assert.deepStrictEqual(s.env, [
    { name: 'API_TOKEN', secret_named: true }, { name: 'PLAIN_SETTING', secret_named: false },
    { name: 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', secret_named: false },
  ]);
  assert.deepStrictEqual(s.enabledPlugins, { 'codex@openai-codex': false, 'superpowers@official': true });
  assert.deepStrictEqual(s.experimental, ['experimentalWidgets', 'env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']);
  assert.deepStrictEqual(g.mcp, [{ source: 'settings.json', name: 'localsrv', transport: 'stdio' }, { source: 'settings.json', name: 'remotesrv', transport: 'http' }, { source: 'settings.json', name: 'ssesrv', transport: 'sse' }]);
  assert.deepStrictEqual(p.mcp, [{ source: '.mcp.json', name: 'projsrv', transport: 'stdio' }]);
  assert.deepStrictEqual(g.skills, [
    { name: 'alpha', user_invoked: true, description_chars: 'Use when testing alpha.'.length },
    { name: 'beta', user_invoked: false, description_chars: 12 },
  ]);
  assert.deepStrictEqual(p.skills, [{ name: 'proj-skill', user_invoked: false, description_chars: 3 }]);
  assert.deepStrictEqual(g.agents, [{ name: 'build', model: 'opus', effort: 'medium' }, { name: 'plain', model: null, effort: null }]);
  assert.deepStrictEqual(p.agents, [{ name: 'head-chef', model: 'sonnet', effort: 'low' }]);
  assert.deepStrictEqual(g.commands, ['model-route.md']);
  assert.deepStrictEqual(p.commands, ['forge.md']);
  assert.deepStrictEqual(g.hook_scripts, ['goat-stop-gate.cjs', 'usage-guard.cjs']);
});

test('a malformed settings file yields parse_error (no content echoed) and a missing one does not crash', () => {
  const inv = INV.inventory({ root: FX.root, home: FX.home, claudeVersion: null, pluginsJson: FX.plugins });
  const bad = inv.project.settings['.claude/settings.json'];
  assert.strictEqual(bad.exists, true);
  assert.strictEqual(typeof bad.parse_error, 'string');
  assert.ok(!bad.parse_error.includes(CANARY.malformed));
  const miss = inv.project.settings['.claude/settings.local.json'];
  assert.strictEqual(miss.exists, false);
  assert.ok('parse_error' in miss);
  assert.strictEqual(inv.claude_code_version, null);
});

test('a malformed .mcp.json yields parse_error instead of a crash', () => {
  const fx = buildFixture();
  fs.writeFileSync(path.join(fx.root, '.mcp.json'), '{ nope ' + CANARY.projMcp);
  const inv = INV.inventory({ root: fx.root, home: fx.home, claudeVersion: 'x', pluginsJson: fx.plugins });
  assert.strictEqual(typeof inv.project.mcp_parse_error, 'string');
  assert.deepStrictEqual(inv.project.mcp, []);
  noCanary(JSON.stringify(inv), 'json');
});

// three canary rounds each found a new quoting form, so commandBasename fails CLOSED: a command
// that starts with an assignment is '<assignment>', a first token holding a quote, '=', '$' or a backtick is '<unparsed>',
// and a script name is taken only at a token start. This table holds every form found so far; each must keep the canary out.
test('commandBasename fails closed on every assignment and quoting form found in review', () => {
  const K = C('TABLE');
  const cases = [
    ['X_TOKEN=' + K + ' mytool', '<assignment>'],
    ['X_TOKEN="' + K + ' word" mytool', '<assignment>'],
    ["Y='" + K + " b.sh' mytool", '<assignment>'],
    ['X_TOKEN="pa\\"ss ' + K + '" mytool', '<assignment>'],
    ['X=pre"a ' + K + '" mytool', '<assignment>'],
    ['X="a b"' + K + ' mytool', '<assignment>'],
    ["X=$'a " + K + "' mytool", '<assignment>'],
    ['FOO="unterminated ' + K + ' mytool', '<assignment>'],
    ['env A_KEY=' + K + '.sh B=1 node run.cjs', '<assignment>'],
    ['set NAME=a ' + K + ' && mytool', '<assignment>'],
    ['cross-env K=' + K + ' node x.cjs', '<assignment>'],
    ['export K=' + K + '; mytool', '<assignment>'],
    ["$env:API_KEY='" + K + "'; mytool", '<assignment>'],
    ['mytool --out=' + K + '.sh', 'mytool'],
    ['"' + K + ' tool', '<unparsed>'],
    ['node "C:\\x\\forge-gate-hook.cjs" --msg "don\'t"', 'forge-gate-hook.cjs'],
    ['node C:/a/b/goat-stop-gate.cjs --flag ' + K, 'goat-stop-gate.cjs'],
    ['mytool ' + K, 'mytool'],
    ['-p' + K + ' mytool', '<unparsed>'],
    // a bash append assignment and a first token stopped only by the '=' guard
    ['X_TOKEN+=' + K + ' mytool', '<assignment>'],
    ['./tool=' + K, '<unparsed>'],
  ];
  for (const [cmd, want] of cases) {
    const got = INV.commandBasename(cmd);
    assert.ok(!got.includes(K), 'leaks the canary for ' + JSON.stringify(cmd.replace(K, '<K>')) + ': ' + JSON.stringify(got.replace(K, '<K>')));
    assert.strictEqual(got, want, 'for ' + JSON.stringify(cmd.replace(K, '<K>')));
  }
});

test('redact replaces the home path in both slash styles and every URL', () => {
  const h = os.homedir();
  const r = INV.redact('a ' + h + '\\x b ' + h.replace(/\\/g, '/') + '/y c ' + h.toUpperCase() + ' see https://e.example/p?q=1 and http://x.example');
  assert.ok(!r.toLowerCase().includes(h.toLowerCase()) && !r.toLowerCase().includes(h.replace(/\\/g, '/').toLowerCase()), r);
  assert.ok(r.includes('~'), r);
  assert.ok(!/https?:/.test(r) && (r.match(/<url>/g) || []).length === 2, r);
});

test('CLI --json and text output carry no canary, no Bearer and no home path', () => {
  const run = (extra) => spawnSync(process.execPath, [TOOL, '--root', FX.root, '--home', FX.home, '--claude-version', '1.2.3', '--plugins-json', FX.plugins, ...extra], { encoding: 'utf8', timeout: 60000 });
  const j = run(['--json']);
  assert.strictEqual(j.status, 0, j.stderr);
  const obj = JSON.parse(j.stdout);
  assert.strictEqual(obj.schema, 'forge-setup-inventory/v1');
  assert.strictEqual(obj.global.skills.length, 2);
  assert.ok(obj.root.startsWith('~'), obj.root);
  noCanary(j.stdout + j.stderr, '--json');
  noHome(j.stdout, '--json');
  const t = run([]);
  assert.strictEqual(t.status, 0, t.stderr);
  assert.match(t.stdout, /skills/i);
  assert.match(t.stdout, /1\.2\.3/);
  noCanary(t.stdout + t.stderr, 'text');
  noHome(t.stdout, 'text');
  const out = path.join(TMP_RUN, 'inv-out.json');
  const o = run(['--json', '--out', out]);
  assert.strictEqual(o.status, 0, o.stderr);
  noCanary(fs.readFileSync(out, 'utf8'), '--out');
  // rv-as-final-034807 finding 7: with --out the full JSON goes to the file only, stdout carries the short summary
  assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).schema, '--out file holds the JSON');
  assert.ok(!o.stdout.trim().startsWith('{') && /written/.test(o.stdout), '--out keeps the JSON out of stdout: ' + o.stdout.slice(0, 80));
  // rv-as-final-034807-r2 finding 3: --out into a folder that does not exist yet creates it; --help prints usage
  const nested = path.join(TMP_RUN, 'new', 'deeper', 'inv.json');
  const o2 = run(['--json', '--out', nested]);
  assert.strictEqual(o2.status, 0, o2.stderr);
  assert.ok(fs.existsSync(nested), '--out created its folder');
  const h = run(['--help']);
  assert.strictEqual(h.status, 0, h.stderr);
  assert.ok(/Usage:/.test(h.stdout), '--help prints usage');
  // craft lens cli-and-devtools help-useful: every flag explained, an example and the exit codes
  for (const flag of ['--root', '--home', '--json', '--out', '--claude-version', '--plugins-json']) assert.ok(new RegExp('^\\s+' + flag + '\\b', 'm').test(h.stdout), '--help explains ' + flag);
  assert.ok(/Example:/.test(h.stdout) && /Exit codes:/.test(h.stdout), '--help has an example and the exit codes');
});

test('CLI exits 1 on an unknown flag', () => {
  const r = spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 1);
});

test('attribution_present is false when only the deprecated includeCoAuthoredBy is set', () => {
  const fx = buildFixture();
  const f = path.join(fx.home, 'settings.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8')); delete d.attribution; fs.writeFileSync(f, JSON.stringify(d));
  const s = INV.inventory({ root: fx.root, home: fx.home, claudeVersion: 'x', pluginsJson: fx.plugins }).global.settings['settings.json'];
  assert.strictEqual(s.values.attribution_present, false);
  assert.ok(!('includeCoAuthoredBy' in s.values));
});

test('plugins_cli from --plugins-json lists only id, scope, enabled and version', () => {
  const inv = INV.inventory({ root: FX.root, home: FX.home, claudeVersion: 'x', pluginsJson: FX.plugins });
  assert.deepStrictEqual(inv.plugins_cli, { source: 'file', reason: null, plugins: [
    { id: 'alpha-plug@m', scope: 'user', enabled: true, version: '1.0.0' },
    { id: 'beta-plug@m', scope: 'project', enabled: true, version: '2.0.0' },
    { id: 'esc-plug@m', scope: 'user', enabled: true, version: '1.0.0' },
    { id: 'off-plug@m', scope: 'user', enabled: false, version: '1.0.0' },
    { id: 'nopath-plug@m', scope: 'local', enabled: true, version: '3.0.0' },
  ] });
});

test('plugins_cli is null with a reason when the plugins file is missing or not a JSON array', () => {
  const miss = INV.inventory({ root: FX.root, home: FX.home, claudeVersion: 'x', pluginsJson: path.join(TMP_RUN, 'nope.json') });
  assert.strictEqual(miss.plugins_cli.plugins, null);
  assert.strictEqual(typeof miss.plugins_cli.reason, 'string');
  assert.deepStrictEqual(miss.plugin_hooks, []);
  const bad = path.join(TMP_RUN, 'bad-plugins.json'); fs.writeFileSync(bad, '{"a":1}');
  const b = INV.inventory({ root: FX.root, home: FX.home, claudeVersion: 'x', pluginsJson: bad });
  assert.strictEqual(b.plugins_cli.plugins, null);
  assert.match(b.plugins_cli.reason, /array/);
});

test('plugin_hooks reports matcher and async per event for enabled plugins, never the command, and redacts installPath to ~', () => {
  const inv = INV.inventory({ root: FX.root, home: FX.home, claudeVersion: 'x', pluginsJson: FX.plugins });
  const by = Object.fromEntries(inv.plugin_hooks.map((p) => [p.plugin, p]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['alpha-plug@m', 'beta-plug@m', 'esc-plug@m']);
  assert.deepStrictEqual(by['alpha-plug@m'].hooks, {
    SessionStart: [{ matcher: 'startup|resume', async: true }, { matcher: 'startup|resume', async: false }],
    Stop: [{ matcher: '', async: false }],
  });
  assert.strictEqual(by['alpha-plug@m'].source, 'hooks/hooks.json');
  assert.deepStrictEqual(by['beta-plug@m'].hooks, { PreToolUse: [{ matcher: 'Bash', async: false }] });
  assert.strictEqual(by['beta-plug@m'].source, 'cfg/h.json');
  assert.deepStrictEqual(by['esc-plug@m'].hooks, {});
  assert.match(by['esc-plug@m'].error, /outside/);
  for (const p of inv.plugin_hooks) assert.ok(p.install_path.startsWith('~'), p.install_path);
  const text = JSON.stringify(inv);
  noCanary(text, 'plugin json');
  noHome(text, 'plugin json');
});

test('CLI text output names the plugin and plugin-hook counts', () => {
  const t = spawnSync(process.execPath, [TOOL, '--root', FX.root, '--home', FX.home, '--claude-version', '1', '--plugins-json', FX.plugins], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(t.status, 0, t.stderr);
  assert.match(t.stdout, /Plugins \(file\): 5 \(4 enabled\), plugin hooks: 4 in 3 plugins/);
  noCanary(t.stdout, 'text');
});
