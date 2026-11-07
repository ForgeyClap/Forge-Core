// WP B3-sec-impl, Lead allow-list for "Altijd toestaan in dit gesprek", hardened after the
// independent sign-off (Review Boss FAIL + Security Boss PASS_WITH_NOTES on commit efc45be):
// A session key exists ONLY for tools whose whole effect the key captures: WebSearch, WebFetch by
// ORIGIN (host:port, never a Forge gateway origin on this machine) and the gateway's own forge-ask
// tool. Everything else is never remembered: shells, Claude Code's Monitor tool (runs a shell command),
// the edit tools, the READ tools (Read/Glob/Grep/LS: Claude Code reads in-folder files without asking,
// so an in-folder read card exists only because that file was gated on purpose, and a key by tool name
// let one grant cover every other gated file: the sign-off HIGH) and any unknown tool.
// RED on efc45be: two different in-folder Reads shared 'Read []'; [::ffff:127.0.0.1] on the gateway
// port got a key; a loopback URL on the default port 4100 got a key after a port fallback;
// 'mcp__forge-ask__x__run_command' got a key; gateway-self cards said "iets ophalen van internet".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { sessionRuleKey, classifyPermission } from '../src/permissions/rules.mjs';
import { getGatewayPort, DEFAULT_GATEWAY_PORT, setGatewayPort, configuredGatewayPort } from '../src/runtime-state.mjs';

const CWD = path.join(os.tmpdir(), 'forge-perm-allowlist');
const inFolder = path.join(CWD, 'src', 'index.html');
const OUTSIDE = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';

test('ALLOW-LIST: Monitor (a shell-running tool that is not Bash/PowerShell) is never remembered', () => {
  assert.equal(sessionRuleKey('Monitor', { command: 'npm run dev', description: 'dev server' }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Monitor', { command: 'ls' }, { cwd: CWD }), null);
});

test('ALLOW-LIST: an unknown tool name is never remembered, even with no input', () => {
  assert.equal(sessionRuleKey('SomeFutureTool', {}, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Task', { prompt: 'x' }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('mcp__other__run', { command: 'ls' }, { cwd: CWD }), null);
});

test('ALLOW-LIST: edit tools are never remembered, not even inside the project folder', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(sessionRuleKey(tool, { file_path: inFolder, notebook_path: inFolder }, { cwd: CWD }), null, tool);
  }
});

test('ALLOW-LIST (sign-off HIGH): read tools are never remembered: two different in-folder files never share a key', () => {
  const a = sessionRuleKey('Read', { file_path: path.join(CWD, '.env') }, { cwd: CWD });
  const b = sessionRuleKey('Read', { file_path: path.join(CWD, 'secrets', 'prod.pem') }, { cwd: CWD });
  assert.equal(a, null, 'a gated in-folder Read gets no key');
  assert.equal(b, null);
  assert.equal(sessionRuleKey('Read', { file_path: inFolder }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('LS', { path: CWD }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Grep', { pattern: 'TODO' }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Glob', { pattern: '**/*.ts' }, { cwd: CWD }), null);
  // outside, relative-up and no-folder shapes stay null too
  assert.equal(sessionRuleKey('Read', { file_path: OUTSIDE }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Glob', { pattern: '*.pem', path: path.dirname(OUTSIDE) }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Grep', { pattern: 'BEGIN', path: path.join(CWD, '..', 'other') }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Read', { file_path: '../secret.txt' }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('Read', { file_path: 'a.ts' }), null, 'no known folder');
});

test('ALLOW-LIST: WebSearch and the gateway\'s own forge-ask tool keep a key; look-alike MCP names do not', () => {
  assert.equal(sessionRuleKey('WebSearch', { query: 'electron safeStorage' }, { cwd: CWD }), 'WebSearch [network]');
  assert.equal(sessionRuleKey('mcp__forge-ask__ask_owner', { question: 'x' }, { cwd: CWD }), 'mcp__forge-ask__ask_owner []');
  assert.equal(sessionRuleKey('mcp__forge-ask__x__run_command', { command: 'ls' }, { cwd: CWD }), null, 'a tool of another server named forge-ask__x');
  assert.equal(sessionRuleKey('mcp__forge-ask__permission_prompt', {}, { cwd: CWD }), null, 'the prompt tool itself is never prompted, so never keyed');
  assert.equal(sessionRuleKey('mcp__forge-askx__ask_owner', {}, { cwd: CWD }), null);
});

test('ALLOW-LIST: WebFetch is keyed by ORIGIN (host:port), so a dev server never covers another port', () => {
  const a = sessionRuleKey('WebFetch', { url: 'http://127.0.0.1:3000/' }, { cwd: CWD });
  const b = sessionRuleKey('WebFetch', { url: 'http://127.0.0.1:3001/' }, { cwd: CWD });
  assert.equal(a, 'WebFetch:127.0.0.1:3000 [network]');
  assert.notEqual(a, b);
  assert.equal(sessionRuleKey('WebFetch', { url: 'https://example.com/docs' }, { cwd: CWD }), 'WebFetch:example.com:443 [network]');
});

test('ALLOW-LIST: origin normalisation: default port, upper-case host and userinfo all map to the same key', () => {
  const plain = sessionRuleKey('WebFetch', { url: 'https://example.com/a' }, { cwd: CWD });
  assert.equal(sessionRuleKey('WebFetch', { url: 'https://example.com:443/b' }, { cwd: CWD }), plain, 'explicit default port');
  assert.equal(sessionRuleKey('WebFetch', { url: 'https://Example.COM/c' }, { cwd: CWD }), plain, 'upper-case host');
  assert.equal(sessionRuleKey('WebFetch', { url: 'https://evil@example.com/d' }, { cwd: CWD }), plain, 'userinfo cannot change the host');
  assert.notEqual(sessionRuleKey('WebFetch', { url: 'http://example.com/e' }, { cwd: CWD }), plain, 'http and https are different origins');
  assert.equal(sessionRuleKey('WebFetch', { url: 'https://example.com:8443/f' }, { cwd: CWD }), 'WebFetch:example.com:8443 [network]');
});

test('ALLOW-LIST: the URL parser pins the loopback spellings this rule relies on', () => {
  for (const spelled of ['127.1', '127.0.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.0.0.1.']) {
    assert.equal(new URL('http://' + spelled + ':4100/').hostname, '127.0.0.1', spelled);
  }
  assert.equal(new URL('http://[0:0:0:0:0:0:0:1]:4100/').hostname, '[::1]');
  assert.equal(new URL('http://[::ffff:127.0.0.1]:4100/').hostname, '[::ffff:7f00:1]', 'the IPv4-mapped form keeps its own spelling');
  assert.equal(new URL('http://evil@127.0.0.1:4100/').hostname, '127.0.0.1');
});

test('ALLOW-LIST: no gateway origin on this machine is ever remembered: live port, default 4100, every loopback spelling', () => {
  const live = String(getGatewayPort());
  const ports = new Set([live, String(DEFAULT_GATEWAY_PORT)]);
  for (const port of ports) {
    for (const host of ['127.0.0.1', 'localhost', 'localhost.', '127.1', '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', '2130706433', '0x7f000001', 'LOCALHOST', '0.0.0.0', '[::]']) {
      assert.equal(sessionRuleKey('WebFetch', { url: 'http://' + host + ':' + port + '/' }, { cwd: CWD }), null, host + ':' + port);
    }
    assert.equal(sessionRuleKey('WebFetch', { url: 'http://evil@127.0.0.1:' + port + '/' }, { cwd: CWD }), null, 'userinfo on the gateway port');
  }
  // A loopback URL that names the gateway API is never remembered either, whatever the port.
  assert.equal(sessionRuleKey('WebFetch', { url: 'http://127.0.0.1:3000/api/permissions/pending' }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:9999/api/ask' }, { cwd: CWD }), null);
  // Non-http schemes are never remembered.
  assert.equal(sessionRuleKey('WebFetch', { url: 'file:///C:/Windows/win.ini' }, { cwd: CWD }), null);
  // A loopback dev server on a non-gateway port with a plain path still gets its own origin key.
  assert.equal(sessionRuleKey('WebFetch', { url: 'http://[::ffff:127.0.0.1]:3000/' }, { cwd: CWD }), 'WebFetch:[::ffff:7f00:1]:3000 [network]');
});

test('ALLOW-LIST: after a port fallback the default 4100 stays a gateway port (another Forge gateway may own it)', () => {
  const before = getGatewayPort();
  try {
    setGatewayPort(4123);
    assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:4123/' }, { cwd: CWD }), null, 'the live port');
    assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:4100/' }, { cwd: CWD }), null, 'the default port');
    assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:4124/' }, { cwd: CWD }), 'WebFetch:localhost:4124 [network]', 'a neighbour port is a plain dev origin');
  } finally {
    setGatewayPort(before);
  }
});

test('ALLOW-LIST: shell tools stay unrememberable (regression guard for the empty shell allow-list)', () => {
  assert.equal(sessionRuleKey('Bash', { command: 'ls' }, { cwd: CWD }), null);
  assert.equal(sessionRuleKey('PowerShell', { command: 'Get-ChildItem' }, { cwd: CWD }), null);
});

// Security Boss decision 1b, second half: a call that reaches THIS machine's Forge gateway is labelled
// honestly on the card, in the place where the user decides.
test('CARD COPY: a shell or WebFetch call that names the gateway says "Bedient Forge zelf", a plain fetch does not', () => {
  const port = String(getGatewayPort());
  const curl = classifyPermission('Bash', { command: 'curl http://127.0.0.1:' + port + '/' }, { cwd: CWD });
  assert.equal(curl.summary_nl, 'Bedient Forge zelf: de Forge-gateway op deze computer aanspreken (curl)');
  assert.deepEqual(curl.categories, ['network', 'exec']);
  const post = classifyPermission('Bash', { command: 'curl -X POST -H "x-cc-exec-token: abc" http://localhost:' + port + '/api/permissions/p1/answer' }, { cwd: CWD });
  assert.match(post.summary_nl, /^Bedient Forge zelf: /);
  const header = classifyPermission('PowerShell', { command: 'Invoke-RestMethod -Headers @{ "x-cc-exec-token" = $t } http://x' }, { cwd: CWD });
  assert.match(header.summary_nl, /^Bedient Forge zelf: /, 'the token header alone names the gateway');
  // Copy is decided by the PORT only: a dev app on another port may have its own /api/config. The key
  // rule (webFetchKey) still refuses a key for a gateway API path on any loopback port.
  const devApi = classifyPermission('Bash', { command: 'curl http://127.0.0.1:3000/api/ask' }, { cwd: CWD });
  assert.equal(devApi.summary_nl, 'Iets ophalen van internet (curl)', 'an API path on a non-gateway port keeps the ordinary copy');
  assert.equal(classifyPermission('WebFetch', { url: 'http://localhost:3000/api/config' }, { cwd: CWD }).summary_nl, 'Een webpagina openen: localhost');
  assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:3000/api/config' }, { cwd: CWD }), null, 'but it is still never remembered');
  const fetchSelf = classifyPermission('WebFetch', { url: 'http://localhost:' + port + '/' }, { cwd: CWD });
  assert.match(fetchSelf.summary_nl, /^Bedient Forge zelf: /);
  assert.deepEqual(fetchSelf.categories, ['network']);
  // plain ones keep the ordinary copy
  assert.equal(classifyPermission('Bash', { command: 'curl https://api.test/x' }, { cwd: CWD }).summary_nl, 'Iets ophalen van internet (curl)');
  assert.equal(classifyPermission('WebFetch', { url: 'http://127.0.0.1:3000/' }, { cwd: CWD }).summary_nl, 'Een webpagina openen: 127.0.0.1');
  assert.equal(classifyPermission('Bash', { command: 'ls' }, { cwd: CWD }).summary_nl, 'Een opdracht uitvoeren: ls');
});

test('ALLOW-LIST: a PINNED gateway port (CC_PORT) is a gateway port too, even when the live port differs', () => {
  const before = process.env.CC_PORT;
  try {
    process.env.CC_PORT = '4555';
    assert.equal(configuredGatewayPort(), 4555, 'precondition: the pin is read from the environment');
    assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:4555/' }, { cwd: CWD }), null);
    assert.match(classifyPermission('WebFetch', { url: 'http://127.0.0.1:4555/' }, { cwd: CWD }).summary_nl, /^Bedient Forge zelf: /);
  } finally {
    if (before === undefined) delete process.env.CC_PORT; else process.env.CC_PORT = before;
  }
  assert.equal(sessionRuleKey('WebFetch', { url: 'http://localhost:4555/' }, { cwd: CWD }), 'WebFetch:localhost:4555 [network]', 'without the pin it is a plain dev origin again');
});
