#!/usr/bin/env node
'use strict';
/** forge-mcp-pin.test.cjs — supply-chain pin-check: the launcher classifier matrix, free-text
 *  scanning, the strict rules on the REAL shipped registry, mutation proofs (a floating "latest" tag injected into
 *  EVERY string and EVERY key of the real registry must fail), the four verified entries' flags and per-tool
 *  read/write split, and the CLI exit codes. Convention: t()-harness, "<N> passed, <M> failed", non-zero on failure.
 *  Temp files only for the CLI section, removed in finally. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const P = require('./forge-mcp-pin.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};
console.log('forge-mcp-pin tests');

// ---- 1) launcher classifier matrix ---------------------------------------------------------------------------
const SHA = (c) => c.repeat(40);
const DIG = (c) => c.repeat(64);
const CASES = [
  ['npx -y some-pkg', 'HIGH'], ['npx some-pkg', 'HIGH'], ['npx -y some-pkg@latest', 'HIGH'], ['npx -y some-pkg@next', 'HIGH'],
  ['npx -y @scope/pkg', 'HIGH'], ['npx -y @scope/pkg@1.2.3', 'SAFE'], ['npx -y some-pkg@1.2.3-beta.1', 'SAFE'],
  ['npx some-pkg@^1.2.3', 'MEDIUM'], ['npx some-pkg@~1.2.3', 'MEDIUM'], ['npx some-pkg@>=1.0.0', 'MEDIUM'], ['npx some-pkg@*', 'MEDIUM'],
  ['npx some-pkg@1.x', 'MEDIUM'], ['npx some-pkg@1.2', 'MEDIUM'], ['npx --package=some-pkg@1.2.3 some-bin', 'SAFE'],
  ['npx -p some-pkg some-bin', 'HIGH'], ['npx -c "some-bin --flag"', 'HIGH'], ['npx github:owner/repo', 'HIGH'],
  ['npx github:owner/repo#' + SHA('a'), 'SAFE'], ['npx owner/repo', 'HIGH'], ['npx https://example.com/pkg.tgz', 'HIGH'], ['npx -y', 'HIGH'],
  ['npm exec -- some-pkg@1.2.3', 'SAFE'], ['npm x some-pkg', 'HIGH'],
  ['cmd /c npx -y some-pkg@1.2.3', 'SAFE'], ['cmd /c npx -y some-pkg', 'HIGH'], ['npx.cmd -y some-pkg', 'HIGH'],
  ['bunx some-pkg', 'HIGH'], ['bunx some-pkg@1.0.0', 'SAFE'], ['bunx --bun some-pkg@1.0.0', 'SAFE'], ['bun x some-pkg@latest', 'HIGH'],
  ['pnpm dlx some-pkg', 'HIGH'], ['pnpm dlx some-pkg@2.0.0', 'SAFE'], ['pnpm --package=some-pkg@1.0.0 dlx some-bin', 'SAFE'],
  ['pnpx some-pkg@^1.0.0', 'MEDIUM'], ['pnpm dlx -c "echo hi"', 'HIGH'],
  ['yarn dlx -p some-pkg@1.0.0 some-bin', 'SAFE'], ['yarn dlx some-pkg', 'HIGH'],
  ['uvx some-tool', 'HIGH'], ['uvx some-tool==1.2.3', 'SAFE'], ['uvx some-tool@1.2.3', 'SAFE'], ['uvx some-tool@latest', 'HIGH'],
  ['uvx "some-tool>=1.0"', 'MEDIUM'], ['uvx some-tool==1.2.*', 'MEDIUM'],
  ['uvx --from git+https://github.com/o/r serena', 'HIGH'], ['uvx --from git+https://github.com/o/r@' + SHA('b') + ' serena', 'SAFE'],
  ['uvx --with extra-dep some-tool==1.0.0', 'HIGH'], ['uvx --with extra-dep==2.0 some-tool==1.0.0', 'SAFE'], ['uv tool run some-tool==1.0.0', 'SAFE'],
  ['pipx run some-app', 'HIGH'], ['pipx run some-app==1.0.0', 'SAFE'], ['pipx run --spec some-pkg==1.0.0 some-app', 'SAFE'],
  ['pipx run --spec some-pkg some-app', 'HIGH'],
  ['docker run -i --rm some/image', 'HIGH'], ['docker run -i --rm some/image:latest', 'HIGH'], ['docker run -i --rm some/image:1.2.3', 'HIGH'],
  ['docker run -i --rm -e KEY=value some/image@sha256:' + DIG('c'), 'SAFE'], ['docker run --env=KEY=value ghcr.io/o/i:1.2@sha256:' + DIG('d'), 'SAFE'],
  ['podman run -i --rm some/image', 'HIGH'], ['docker container run -i some/image@sha256:' + DIG('e'), 'SAFE'], ['docker run -i --rm localhost:5000/img', 'HIGH'],
  ['deno run --allow-net npm:some-pkg', 'HIGH'], ['deno run --allow-net npm:some-pkg@1.0.0', 'SAFE'],
  ['node server.js', 'NONE'], ['python -m server', 'NONE'], ['docker ps', 'NONE'],
];
for (const [line, want] of CASES) {
  const r = P.classifyCommandLine(line);
  t('classify ' + line.replace(/[0-9a-f]{40,64}/g, '<hash>') + ' -> ' + want, r.risk === want, 'got ' + r.risk + ': ' + r.refs.map((x) => x.reason).join('; '));
}
t('a pinned exact version carries the version it pins', P.classifyCommandLine('npx -y @scope/pkg@1.2.3').refs[0].version === '1.2.3');
t('BLOCKING is exactly HIGH + UNVERIFIED', P.BLOCKING.has('HIGH') && P.BLOCKING.has('UNVERIFIED') && !P.BLOCKING.has('MEDIUM') && !P.BLOCKING.has('SAFE'));

// ---- 2) free text --------------------------------------------------------------------------------------------
{
  const hint = "MCP host config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } — see https://github.com/upstash/context7";
  const r = P.scanText(hint);
  t('scanText finds the unversioned launcher inside an install-hint object literal (HIGH)', r.length === 1 && r[0].risk === 'HIGH' && r[0].spec === '@upstash/context7-mcp', JSON.stringify(r));
  t('scanText: a pinned line ending a sentence stays SAFE (trailing period ignored)', P.scanText('Run it with npx -y some-pkg@1.2.3.').every((x) => x.risk === 'SAFE'));
  t('scanText: "@latest" in plain prose is HIGH', P.scanText('install some-pkg@latest from the registry').some((x) => x.risk === 'HIGH'));
  t('scanText: an image ":latest" tag in prose is HIGH', P.scanText('image ghcr.io/x/y:latest').some((x) => x.risk === 'HIGH'));
  t('scanText: ordinary prose and a docs URL produce no finding', P.scanText('Read the README at https://github.com/x/y and decide.').length === 0);
  t('scanText: a container launcher in prose is classified (HIGH without digest)', P.scanText('or docker run -i --rm some/image instead').some((x) => x.risk === 'HIGH'));
  t('scanText {tags:false} ignores tags; {launchers:false} ignores launchers',
    P.scanText('some-pkg@latest', { tags: false }).length === 0 && P.scanText('npx -y some-pkg', { launchers: false }).length === 0);
}

// ---- 3) classifyEntry ----------------------------------------------------------------------------------------
{
  const base = { id: 'x', pin: '1.0.0', launch: { command: 'npx', args: ['-y', 'x-pkg@1.0.0'] } };
  const c = P.classifyEntry(base);
  t('classifyEntry: a pinned launch whose version equals pin is SAFE and not blocking', c.risk === 'SAFE' && c.blocking === false, c.reason);
  t('classifyEntry: pin that differs from the launch version is HIGH', P.classifyEntry({ ...base, pin: '1.0.1' }).risk === 'HIGH');
  t('classifyEntry: pin UNVERIFIED without launch is UNVERIFIED and blocking', (() => { const u = P.classifyEntry({ id: 'u', pin: 'UNVERIFIED', launch: null }); return u.risk === 'UNVERIFIED' && u.blocking; })());
  t('classifyEntry: a launch that is not a package launcher cannot carry a pin (HIGH)', P.classifyEntry({ id: 'n', pin: '1.0.0', launch: { command: 'node', args: ['x.js'] } }).risk === 'HIGH');
  t('classifyEntry: a malformed launch is HIGH, never ignored', P.classifyEntry({ id: 'm', pin: '1.0.0', launch: 'npx x-pkg@1.0.0' }).risk === 'HIGH');
  t('classifyEntry: no pin at all is HIGH', P.classifyEntry({ id: 'np', launch: base.launch }).risk === 'HIGH');
}

// ---- 4) the REAL shipped registry ----------------------------------------------------------------------------
const rawText = fs.readFileSync(P.REGISTRY_PATH, 'utf8');
const real = JSON.parse(rawText);
const realCheck = P.checkRegistry(real, { rawText });
t('REAL registry passes the strict pin-check (no HIGH, no floating tag, all dormant)', realCheck.ok === true, JSON.stringify(realCheck.violations));
t('REAL registry: every entry is dormant (enabled === false)', real.servers.every((s) => s.enabled === false));
t('REAL registry: every entry is SAFE or explicitly UNVERIFIED with no runnable launch',
  realCheck.entries.every((e) => e.risk === 'SAFE' || (e.risk === 'UNVERIFIED' && real.servers.find((s) => s.id === e.id).launch === null)));
t('REAL registry: no floating "latest" tag anywhere in the file text', !/[@:]latest\b/i.test(rawText));
t('REAL registry: every entry has a use_when note (a Boss can name the right server)', real.servers.every((s) => typeof s.use_when === 'string' && s.use_when.length > 20));
const byId = (id) => real.servers.find((s) => s.id === id);
const FOUR = { context7: '4.4.4', playwright: '0.0.83', 'chrome-devtools': '1.12.0', firecrawl: '3.34.1' };
for (const [id, ver] of Object.entries(FOUR)) {
  const s = byId(id);
  const e = realCheck.entries.find((x) => x.id === id);
  t(id + ': pinned to the verified exact version ' + ver + ' and SAFE', !!s && s.pin === ver && e && e.risk === 'SAFE');
  t(id + ': verification records a date and https sources', !!s && s.verification && s.verification.date === '2026-10-24' && s.verification.sources.length >= 2);
  const cap = s && s.capabilities;
  const ro = (cap && cap.read_only) || [];
  const wr = (cap && cap.write) || [];
  const all = new Set(ro.concat(wr));
  const hp = (s && s.host_policy) || {};
  t(id + ': per-tool split into read_only and write, disjoint, non-empty', Array.isArray(ro) && Array.isArray(wr) && all.size === ro.length + wr.length && all.size > 0);
  t(id + ': host_policy allow/deny name only classified tools and never overlap',
    ['allow_tools', 'deny_tools'].every((k) => Array.isArray(hp[k]) && hp[k].every((x) => all.has(x))) && hp.allow_tools.every((x) => !hp.deny_tools.includes(x)));
  t(id + ': output is marked untrusted and launch env holds only on/off switches (no secret values)',
    s.untrusted_output === true && Object.values((s.launch && s.launch.env) || {}).every((v) => /^(?:1|true)$/.test(v)));
}
{
  const pw = byId('playwright');
  const a = pw.launch.args;
  t('playwright: launch sets --isolated, --no-webmcp and --host localhost', a.includes('--isolated') && a.includes('--no-webmcp') && a[a.indexOf('--host') + 1] === 'localhost');
  t('playwright: launch never passes unrestricted file access, --no-sandbox, --caps or init scripts',
    !a.some((x) => /^--(?:allow-unrestricted-file-access|no-sandbox|caps|init-page|init-script|secrets|user-data-dir)\b/.test(x)));
  t('playwright: the RCE-equivalent code tool, page JavaScript and file upload are host-denied',
    ['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload'].every((x) => pw.host_policy.deny_tools.includes(x) && pw.capabilities.write.includes(x)));
}
{
  const cd = byId('chrome-devtools');
  const a = cd.launch.args;
  t('chrome-devtools: launch sets --isolated, --no-usage-statistics, --no-performance-crux', ['--isolated', '--no-usage-statistics', '--no-performance-crux'].every((x) => a.includes(x)));
  t('chrome-devtools: env disables update checks and usage statistics', cd.launch.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS === '1' && cd.launch.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS === '1');
  t('chrome-devtools: never attaches to a running Chrome, never accepts insecure certs, enables no off-by-default category',
    !a.some((x) => /^--(?:browser-url|ws-endpoint|accept-insecure-certs|category|experimental|memoryDebugging|user-data-dir)/.test(x)));
  t('chrome-devtools: page JavaScript and file upload are host-denied', ['evaluate_script', 'upload_file'].every((x) => cd.host_policy.deny_tools.includes(x)));
}
{
  const c7 = byId('context7');
  t('context7: stdio transport, keyless (no --api-key in launch), embedded exporter off',
    c7.launch.args.join(' ').includes('--transport stdio') && !c7.launch.args.includes('--api-key') && c7.launch.env.OTEL_SDK_DISABLED === 'true');
  t('context7: both tools are read-only (no write tool)', c7.capabilities.write.length === 0 && c7.capabilities.read_only.length === 2);
}
{
  const fc = byId('firecrawl');
  const env = fc.launch.env;
  t('firecrawl: both feedback opt-outs are set', env.FIRECRAWL_NO_SEARCH_FEEDBACK === '1' && env.FIRECRAWL_NO_ENDPOINT_FEEDBACK === '1');
  t('firecrawl: no key, cloud-service or HTTP listener switch in the shipped launch',
    !['FIRECRAWL_API_KEY', 'FIRECRAWL_API_URL', 'CLOUD_SERVICE', 'HTTP_STREAMABLE_SERVER'].some((k) => k in env));
  t('firecrawl: host allow-list is exactly scrape, search, map, parse',
    JSON.stringify(fc.host_policy.allow_tools.slice().sort()) === JSON.stringify(['firecrawl_map', 'firecrawl_parse', 'firecrawl_scrape', 'firecrawl_search']));
  const known = fc.capabilities.read_only.concat(fc.capabilities.write);
  t('firecrawl: every other classified tool is explicitly denied', known.filter((x) => !fc.host_policy.allow_tools.includes(x)).every((x) => fc.host_policy.deny_tools.includes(x)));
  t('firecrawl: parse is classified as write (it sends a local file out)', fc.capabilities.write.includes('firecrawl_parse'));
}
{
  const grants = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'mcp-grants.json'), 'utf8'));
  const risky = [];
  for (const [boss, g] of Object.entries(grants.bosses)) for (const sid of g.allow_servers) {
    const e = realCheck.entries.find((x) => x.id === sid);
    if (!e || e.risk === 'HIGH') risky.push(boss + ':' + sid);
  }
  t('REAL grants: every allow-listed server exists and none is pin-check HIGH', risky.length === 0, risky.join(','));
}

// ---- 5) mutation proofs on copies of the real registry -------------------------------------------------------
const clone = () => JSON.parse(rawText);
const failsWith = (m, rule) => { const r = P.checkRegistry(m); return r.ok === false && r.violations.some((v) => v.rule === rule); };
{
  // EVERY string value, at every depth, gets a floating tag appended — each single mutation must fail.
  const paths = [];
  (function walk(v, p) {
    if (typeof v === 'string') paths.push(p);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, p.concat(i)));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], p.concat(k)));
  })(real, []);
  const survivors = [];
  for (const p of paths) {
    const m = clone();
    let o = m;
    for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
    o[p[p.length - 1]] = o[p[p.length - 1]] + ' some-pkg@latest';
    if (!failsWith(m, 'floating-tag')) survivors.push(p.join('.'));
  }
  t('MUTATION: "@latest" injected into ANY of the ' + paths.length + ' strings of the real registry fails the check', paths.length > 200 && survivors.length === 0, survivors.slice(0, 5).join(' | '));
  // ... and into ANY key.
  const keyPaths = [];
  (function walkKeys(v, p) {
    if (Array.isArray(v)) v.forEach((x, i) => walkKeys(x, p.concat(i)));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { keyPaths.push(p.concat(k)); walkKeys(v[k], p.concat(k)); });
  })(real, []);
  const keySurvivors = [];
  for (const p of keyPaths) {
    const m = clone();
    let o = m;
    for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
    const k = p[p.length - 1];
    o[k + '@latest'] = o[k];
    delete o[k];
    if (!failsWith(m, 'floating-tag')) keySurvivors.push(p.join('.'));
  }
  t('MUTATION: "@latest" in ANY of the ' + keyPaths.length + ' keys of the real registry fails the check', keyPaths.length > 100 && keySurvivors.length === 0, keySurvivors.slice(0, 5).join(' | '));
}
{
  const set = (fn) => { const m = clone(); fn(m, (id) => m.servers.find((s) => s.id === id)); return m; };
  t('MUTATION: a docker-style ":latest" in prose fails', failsWith(set((m, s) => { s('firecrawl').notes += ' ghcr.io/firecrawl/firecrawl-mcp-server:latest'; }), 'floating-tag'));
  t('MUTATION: enabled:true fails (not-dormant)', failsWith(set((m, s) => { s('context7').enabled = true; }), 'not-dormant'));
  t('MUTATION: a missing enabled field fails (not-dormant)', failsWith(set((m, s) => { delete s('exa').enabled; }), 'not-dormant'));
  t('MUTATION: an unversioned launch fails (pin-high)', failsWith(set((m, s) => { s('context7').launch.args[1] = '@upstash/context7-mcp'; }), 'pin-high'));
  t('MUTATION: a pin that differs from the launch fails (pin-high)', failsWith(set((m, s) => { s('firecrawl').pin = '3.34.2'; }), 'pin-high'));
  t('MUTATION: a version range in the launch fails (pin-high, a range never satisfies a pin)', failsWith(set((m, s) => { s('chrome-devtools').launch.args[1] = 'chrome-devtools-mcp@^1.12.0'; }), 'pin-high'));
  t('MUTATION: a container launch with a mutable tag fails (pin-high)', failsWith(set((m, s) => { s('context7').launch = { command: 'docker', args: ['run', '-i', '--rm', 'mcp/context7:4.4.4'] }; }), 'pin-high'));
  t('MUTATION: an UNVERIFIED entry that ships a launch fails', failsWith(set((m, s) => { s('serena-lsp').launch = { command: 'uvx', args: ['serena==1.0.0'] }; }), 'unverified-with-launch'));
  t('MUTATION: an UNVERIFIED entry whose prose carries a runnable floating line fails', failsWith(set((m, s) => { s('n8n-mcp').install_hint += ' or run: npx n8n-mcp'; }), 'pin-high'));
  t('MUTATION: a missing pin fails', failsWith(set((m, s) => { delete s('github-read').pin; }), 'pin-high'));
  t('MUTATION: a verified pin without sources fails (unsourced-pin)', failsWith(set((m, s) => { s('playwright').verification.sources = []; }), 'unsourced-pin'));
  t('MUTATION: a non-https source fails (unsourced-pin)', failsWith(set((m, s) => { s('playwright').verification.sources = ['http://example.com']; }), 'unsourced-pin'));
  t('MUTATION: a duplicate server id fails', failsWith(set((m, s) => { m.servers.push(JSON.parse(JSON.stringify(s('context7')))); }), 'duplicate-id'));
  t('MUTATION baseline: the unmutated copy still passes', P.checkRegistry(clone()).ok === true);
}

// ---- 6) host config scan + CLI -------------------------------------------------------------------------------
{
  const cfg = { mcpServers: {
    floating: { command: 'npx', args: ['-y', 'some-pkg'] },
    pinned: { command: 'cmd', args: ['/c', 'npx', '-y', 'some-pkg@1.0.0'] },
    remote: { url: 'https://example.com/mcp' },
  } };
  const r = P.scanHostConfig(cfg);
  const by = (id) => r.servers.find((x) => x.id === id);
  t('scanHostConfig: unversioned HIGH, pinned (Windows wrapper) SAFE, a remote URL server NONE; ok false',
    r.ok === false && by('floating').risk === 'HIGH' && by('pinned').risk === 'SAFE' && by('remote').risk === 'NONE', JSON.stringify(r.servers.map((x) => [x.id, x.risk])));
}
const BIN = path.join(__dirname, 'forge-mcp-pin.cjs');
const run = (args) => spawnSync(process.execPath, [BIN].concat(args), { encoding: 'utf8' });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-pin-test-'));
try {
  { const r = run(['check']); t('CLI check on the real registry exits 0 and says OK', r.status === 0 && /PIN-CHECK OK/.test(r.stdout), r.stdout + r.stderr); }
  {
    const m = clone();
    m.servers[0].launch.args[1] = '@upstash/context7-mcp@latest';
    const p = path.join(TMP, 'mutated.json');
    fs.writeFileSync(p, JSON.stringify(m));
    const r = run(['check', '--registry', p]);
    t('CLI check on a mutated registry exits 3 and names the violation', r.status === 3 && /floating-tag/.test(r.stdout), r.stdout);
  }
  { const r = run(['check', '--registry', path.join(TMP, 'absent.json')]); t('CLI check on an unreadable registry exits 2', r.status === 2); }
  { const r = run(['classify', 'npx', '-y', 'some-pkg']); t('CLI classify an unversioned launcher exits 3', r.status === 3 && /HIGH/.test(r.stdout)); }
  { const r = run(['classify', 'npx', '-y', 'some-pkg@1.0.0']); t('CLI classify a pinned launcher exits 0', r.status === 0 && /SAFE/.test(r.stdout)); }
  { const r = run(['classify', 'node', 'server.js']); t('CLI classify a non-launcher exits 0 with NONE', r.status === 0 && /NONE/.test(r.stdout)); }
  {
    const p = path.join(TMP, 'host.json');
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'some-pkg'] } } }));
    const r = run(['scan-config', p, '--json']);
    t('CLI scan-config on a host file with a floating server exits 3 (JSON output)', r.status === 3 && JSON.parse(r.stdout).ok === false);
  }
  { const r = run([]); t('CLI with no command exits 2 (usage)', r.status === 2); }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true }); // lanes clean the fixtures they create
}

// ---- 7) W2-MCPPIN: REVIEW class, digest rule, boundary footer ------------------------------------------------
{
  const REVIEW_CASES = [
    ['npx ./local/server', 'REVIEW'], ['npx file:../pkg', 'REVIEW'], ['npx C:\\tools\\srv', 'REVIEW'],
    ['uvx --from ./tool tool', 'REVIEW'], ['uvx --with-editable ./x some-tool==1.0.0', 'REVIEW'], ['deno run ./server.ts', 'REVIEW'],
    ['uvx --with-editable ./x some-tool', 'HIGH'], ['npx -p ./local -p some-pkg@^1.0.0 some-bin', 'REVIEW'],
  ];
  for (const [line, want] of REVIEW_CASES) {
    const r = P.classifyCommandLine(line);
    t('REVIEW classify ' + line + ' -> ' + want, r.risk === want, 'got ' + r.risk + ': ' + r.refs.map((x) => x.reason).join('; '));
  }
  t('REVIEW is a known risk level and BLOCKS a grant', Array.isArray(P.RISKS) && P.RISKS.includes('REVIEW') && P.BLOCKING.has('REVIEW'));
  t('REVIEW ranks above MEDIUM and below HIGH', P.RISKS.indexOf('REVIEW') > P.RISKS.indexOf('MEDIUM') && P.RISKS.indexOf('REVIEW') < P.RISKS.indexOf('HIGH'));
  const e = P.classifyEntry({ id: 'lp', pin: '1.0.0', launch: { command: 'npx', args: ['./local/server'] } });
  t('classifyEntry: a local-path launch carries a REVIEW ref and is blocking (a pin cannot name a local path)',
    e.blocking === true && e.refs.some((x) => x.source === 'launch' && x.risk === 'REVIEW'), e.risk + ' ' + e.reason);
  const u = P.classifyLaunch('npx', ['./local']);
  t('a one-segment relative path (./local) is a local path (REVIEW), not a git shorthand', u.risk === 'REVIEW', u.refs.map((x) => x.reason).join('; '));

  const cfg = { mcpServers: {
    script: { command: 'node', args: ['server.js'] },
    py: { command: 'python', args: ['-m', 'srv'] },
    bin: { command: './bin/srv' },
    wrapperFloating: { command: 'bash', args: ['-c', 'npx -y some-pkg'] },
    wrapperPinned: { command: 'sh', args: ['-c', 'npx -y some-pkg@1.0.0'] },
    cmdNode: { command: 'cmd', args: ['/c', 'node', 'x.js'] },
    empty: { command: '' },
    nothing: { env: { A: '1' } },
    remote: { url: 'https://example.com/mcp' },
    pinned: { command: 'npx', args: ['-y', 'some-pkg@1.0.0'] },
  } };
  const r = P.scanHostConfig(cfg);
  const by = (id) => (r.servers.find((x) => x.id === id) || {}).risk;
  t('scanHostConfig: an unknown binary or script is REVIEW (not silently NONE)', by('script') === 'REVIEW' && by('py') === 'REVIEW' && by('bin') === 'REVIEW' && by('cmdNode') === 'REVIEW',
    JSON.stringify(r.servers.map((x) => [x.id, x.risk])));
  t('scanHostConfig: a shell wrapper is at least REVIEW and a floating launcher inside it is HIGH',
    by('wrapperPinned') === 'REVIEW' && by('wrapperFloating') === 'HIGH', by('wrapperPinned') + '/' + by('wrapperFloating'));
  t('scanHostConfig: an empty command or a server with no command and no url is REVIEW (never omitted)', by('empty') === 'REVIEW' && by('nothing') === 'REVIEW');
  t('scanHostConfig: a remote URL server stays NONE and a pinned launcher stays SAFE', by('remote') === 'NONE' && by('pinned') === 'SAFE');
  t('scanHostConfig: ok is still "no HIGH" (REVIEW is reported, not a failure of the host file)',
    P.scanHostConfig({ mcpServers: { script: cfg.mcpServers.script } }).ok === true && r.ok === false);
  t('scanHostConfig result carries the boundary text', typeof r.boundary === 'string' && r.boundary === P.BOUNDARY);

  // digest rule: a full sha256 digest is SAFE with or without a tag; a tag alone or a short digest is not.
  t('DIGEST: tag + full digest is SAFE', P.classifyImage('docker run', 'ghcr.io/o/i:1.2.3@sha256:' + DIG('a')).risk === 'SAFE');
  t('DIGEST: digest without tag is SAFE', P.classifyImage('docker run', 'o/i@sha256:' + DIG('b')).risk === 'SAFE');
  t('DIGEST: a version-looking tag alone is HIGH', P.classifyImage('docker run', 'o/i:1.2.3').risk === 'HIGH');
  t('DIGEST: a short (63-hex) digest is HIGH', P.classifyImage('docker run', 'o/i:1.2@sha256:' + 'c'.repeat(63)).risk === 'HIGH');
  t('DIGEST: a non-hex digest is HIGH', P.classifyImage('docker run', 'o/i@sha256:' + 'z'.repeat(64)).risk === 'HIGH');

  // boundary footer
  t('BOUNDARY: one line that says nothing was run and SAFE is not a full security verdict',
    typeof P.BOUNDARY === 'string' && !/\n/.test(P.BOUNDARY) && /not run|never run|no server was run/i.test(P.BOUNDARY) && /depend/i.test(P.BOUNDARY) && /not proof|signal/i.test(P.BOUNDARY), String(P.BOUNDARY));
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-pin-test7-'));
  try {
    const p = path.join(TMP2, 'host.json');
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { script: { command: 'node', args: ['server.js'] } } }));
    const s = run(['scan-config', p]);
    const lines = s.stdout.trim().split(/\r?\n/);
    t('CLI scan-config: REVIEW server printed, exit 0, last line is the boundary footer',
      s.status === 0 && /script\tREVIEW/.test(s.stdout) && lines[lines.length - 1] === P.BOUNDARY, s.status + ' ' + s.stdout);
    const c = run(['check']);
    const cl = c.stdout.trim().split(/\r?\n/);
    t('CLI check: still exits 0 with PIN-CHECK OK and ends with the boundary footer', c.status === 0 && /PIN-CHECK OK/.test(c.stdout) && cl[cl.length - 1] === P.BOUNDARY, c.stdout);
    const j = run(['scan-config', p, '--json']);
    t('CLI scan-config --json stays pure JSON (footer only in text mode)', (() => { try { return JSON.parse(j.stdout).boundary === P.BOUNDARY; } catch { return false; } })());
  } finally {
    fs.rmSync(TMP2, { recursive: true, force: true });
  }
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
