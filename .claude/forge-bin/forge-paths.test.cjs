'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const fp = require('./forge-paths.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function w(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function snapshot(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); } })(dir);
  return out.sort();
}

const NOENV = { env: {} };
const STATE_KEYS = ['runs', 'research', 'scribe', 'tickets', 'index', 'backups', 'vault', 'artifacts', 'mindmaps', 'memory', 'audit', 'prd'];
// realpath: a spawned child reports its cwd resolved (macOS /var -> /private/var), the asserts compare like with like
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-paths-')));
const bare = path.join(tmp, 'bare');           // no canon at all -> built-in defaults
const withCanon = path.join(tmp, 'canon');     // the REAL canon copied in
const legacy = path.join(tmp, 'legacy');       // real canon + legacy folders only
fs.mkdirSync(bare);
const realCanon = path.join(__dirname, '..', 'config', 'orchestration', 'forge-canon.json');
w(withCanon, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(realCanon, 'utf8'));
w(legacy, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(realCanon, 'utf8'));

try {
  // ---- the real canon ----
  t('the real forge-canon.json parses and keeps its existing paths keys', () => {
    const c = JSON.parse(fs.readFileSync(realCanon, 'utf8'));
    assert.strictEqual(c.paths.runs, '.claude/forge-runs');
    assert.strictEqual(c.paths.agent_tree, '.claude');
    assert.strictEqual(c.paths.event_writer, '.claude/forge-dashboard/log-event.cjs');
    // the public Forge-Core build strips version fields from JSON manifests (forge-fresh-repo JSON_VERSION_KEYS), so the
    // version is checked only where the canon still carries one (this development tree)
    if (c.version !== undefined) assert.strictEqual(c.version.forge, 'v11'); // bumped by WP A13 (Wave A)
  });
  t('the real canon declares state_root .forge and all twelve state keys', () => {
    const c = fp.loadCanon(withCanon);
    assert.strictEqual(c.source, 'canon');
    assert.strictEqual(c.state_root, '.forge');
    assert.deepStrictEqual(Object.keys(c.state).sort(), STATE_KEYS.slice().sort());
    assert.deepStrictEqual(Object.keys(c.state_legacy).sort(), STATE_KEYS.slice().sort());
  });
  t('the real canon matches the built-in defaults', () => {
    const c = fp.loadCanon(withCanon);
    assert.deepStrictEqual(c.state, { ...fp.DEFAULTS.state });
    assert.deepStrictEqual(c.state_legacy, { ...fp.DEFAULTS.state_legacy });
  });

  // ---- defaults ----
  t('defaults: state_root resolves to <root>/.forge', () => {
    assert.strictEqual(fp.resolve(withCanon, 'state_root', NOENV), path.join(withCanon, '.forge'));
  });
  t('defaults: every state key resolves under <root>/.forge/<key>', () => {
    for (const k of STATE_KEYS) assert.strictEqual(fp.resolve(withCanon, k, NOENV), path.join(withCanon, '.forge', k));
  });
  t('no canon file -> built-in defaults, same answers', () => {
    assert.strictEqual(fp.loadCanon(bare).source, 'default');
    assert.strictEqual(fp.resolve(bare, 'runs', NOENV), path.join(bare, '.forge', 'runs'));
  });
  t('a canon without the state keys (older install) -> defaults', () => {
    const old = path.join(tmp, 'old');
    w(old, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ version: { forge: 'v10' }, paths: { runs: '.claude/forge-runs' } }));
    assert.strictEqual(fp.loadCanon(old).source, 'default');
    assert.strictEqual(fp.resolve(old, 'vault', NOENV), path.join(old, '.forge', 'vault'));
  });
  t('a corrupt canon throws instead of silently defaulting', () => {
    const bad = path.join(tmp, 'bad');
    w(bad, '.claude/config/orchestration/forge-canon.json', '{ broken');
    assert.throws(() => fp.resolve(bad, 'runs', NOENV), /unparseable canon/);
  });
  t('listKeys = state_root + the twelve state keys', () => {
    assert.deepStrictEqual(fp.listKeys(withCanon), ['state_root', ...STATE_KEYS]);
  });
  t('a custom canon value is honoured', () => {
    const cu = path.join(tmp, 'custom');
    w(cu, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ paths: { state_root: 'var/state', state: { runs: 'r' } } }));
    assert.strictEqual(fp.resolve(cu, 'runs', NOENV), path.join(cu, 'var', 'state', 'r'));
    assert.throws(() => fp.resolve(cu, 'vault', NOENV), /unknown key/);
  });

  // ---- env override ----
  t('FORGE_STATE_DIR absolute overrides state_root', () => {
    const abs = path.join(tmp, 'elsewhere', 'state');
    assert.strictEqual(fp.resolve(withCanon, 'state_root', { env: { FORGE_STATE_DIR: abs } }), abs);
    assert.strictEqual(fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: abs } }), path.join(abs, 'runs'));
  });
  t('FORGE_STATE_DIR relative is taken relative to the project root', () => {
    assert.strictEqual(fp.resolve(withCanon, 'memory', { env: { FORGE_STATE_DIR: 'my-state' } }), path.join(withCanon, 'my-state', 'memory'));
  });
  t('FORGE_STATE_DIR empty/whitespace is ignored', () => {
    assert.strictEqual(fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: '  ' } }), path.join(withCanon, '.forge', 'runs'));
  });
  t('FORGE_STATE_DIR relative with .. is rejected', () => {
    assert.throws(() => fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: '../escape' } }), /traversal/);
  });
  t('process.env.FORGE_STATE_DIR is read when no opts.env is given', () => {
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = 'from-env';
    try { assert.strictEqual(fp.resolve(withCanon, 'index'), path.join(withCanon, 'from-env', 'index')); }
    finally { if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev; }
  });

  // ---- compat fallback ----
  t('compat: neither location exists -> legacy path, source none', () => {
    const r = fp.locate(legacy, 'runs', NOENV);
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.path, path.join(legacy, '.claude', 'forge-runs'));
  });
  t('compat: only legacy dir exists -> legacy', () => {
    for (const k of STATE_KEYS.filter((x) => x !== 'memory')) fs.mkdirSync(path.join(legacy, '.claude', 'forge-' + k), { recursive: true });
    for (const k of STATE_KEYS.filter((x) => x !== 'memory')) {
      assert.strictEqual(fp.resolveExisting(legacy, k, NOENV), path.join(legacy, '.claude', 'forge-' + k), k);
      assert.strictEqual(fp.locate(legacy, k, NOENV).source, 'legacy', k);
    }
  });
  t('compat: new dir exists -> new wins over legacy', () => {
    fs.mkdirSync(path.join(legacy, '.forge', 'runs'), { recursive: true });
    assert.strictEqual(fp.resolveExisting(legacy, 'runs', NOENV), path.join(legacy, '.forge', 'runs'));
    assert.strictEqual(fp.resolveExisting(legacy, 'vault', NOENV), path.join(legacy, '.claude', 'forge-vault'));
  });
  t('compat: a FILE at the new path does not count as the new location', () => {
    w(legacy, '.forge/tickets', 'not a dir');
    assert.strictEqual(fp.locate(legacy, 'tickets', NOENV).source, 'legacy');
  });
  t('compat memory: .claude without FORGE_* files is not a legacy hit', () => {
    assert.strictEqual(fp.locate(legacy, 'memory', NOENV).source, 'none');
  });
  t('compat memory: .claude/FORGE_MEMORY.md present -> legacy .claude', () => {
    w(legacy, '.claude/FORGE_MEMORY.md', '# memory\n');
    const r = fp.locate(legacy, 'memory', NOENV);
    assert.strictEqual(r.source, 'legacy');
    assert.strictEqual(r.path, path.join(legacy, '.claude'));
  });
  t('compat memory: .forge/memory present -> new', () => {
    fs.mkdirSync(path.join(legacy, '.forge', 'memory'), { recursive: true });
    assert.strictEqual(fp.resolveExisting(legacy, 'memory', NOENV), path.join(legacy, '.forge', 'memory'));
  });
  t('compat honours FORGE_STATE_DIR for the new side', () => {
    fs.mkdirSync(path.join(legacy, 'alt', 'scribe'), { recursive: true });
    assert.strictEqual(fp.resolveExisting(legacy, 'scribe', { env: { FORGE_STATE_DIR: 'alt' } }), path.join(legacy, 'alt', 'scribe'));
  });
  t('compat state_root: no legacy, returns the new root', () => {
    assert.strictEqual(fp.locate(bare, 'state_root', NOENV).path, path.join(bare, '.forge'));
  });

  // ---- traversal / key validation ----
  t('traversal keys are rejected', () => {
    for (const k of ['..', '../runs', 'runs/../vault', '..\\runs', 'runs\\..\\..']) assert.throws(() => fp.resolve(withCanon, k, NOENV), fp.PathError, k);
  });
  t('absolute and drive-letter keys are rejected', () => {
    for (const k of ['/etc', 'C:\\Windows', 'C:runs', '\\\\server\\share', 'c:/x']) assert.throws(() => fp.resolve(withCanon, k, NOENV), fp.PathError, k);
  });
  t('unknown or non-string keys are rejected', () => {
    for (const k of ['nope', 'agent_tree', 'event_writer', 'RUNS', '', null, undefined, 42, '__proto__', 'constructor', 'toString']) {
      assert.throws(() => fp.resolve(withCanon, k, NOENV), fp.PathError, String(k));
    }
  });
  t('a canon value with traversal / absolute / drive letter is rejected', () => {
    const cases = { trav: '../../etc', abs: '/var/x', drive: 'D:\\x', unc: '\\\\srv\\s', winTrav: 'a\\..\\..\\b' };
    for (const [name, v] of Object.entries(cases)) {
      const d = path.join(tmp, 'evil-' + name);
      w(d, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ paths: { state_root: '.forge', state: { runs: v }, state_legacy: { runs: v } } }));
      assert.throws(() => fp.resolve(d, 'runs', NOENV), fp.PathError, name);
      const d2 = path.join(tmp, 'evilroot-' + name);
      w(d2, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ paths: { state_root: v, state: { runs: 'runs' } } }));
      assert.throws(() => fp.resolve(d2, 'runs', NOENV), fp.PathError, 'root ' + name);
    }
  });
  t('FORGE_STATE_DIR drive-letter-relative trick (C:x) is rejected on every platform', () => {
    assert.throws(() => fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: 'C:x' } }), /drive-letter/);
    assert.throws(() => fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: 'C:x' } }), fp.PathError);
  });
  t('FORGE_STATE_DIR absolute with .. segments is rejected', () => {
    assert.throws(() => fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: path.join(tmp, 'a') + path.sep + '..' + path.sep + 'b' } }), /traversal/);
  });
  t('empty projectRoot is rejected', () => {
    assert.throws(() => fp.resolve('', 'runs', NOENV), fp.PathError);
  });

  // ---- separators ----
  t('Windows-style separators in canon values are normalised to the platform separator', () => {
    const ws = path.join(tmp, 'winsep');
    w(ws, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ paths: { state_root: '.\\st\\root', state: { runs: 'a\\b' }, state_legacy: { runs: '.claude\\forge-runs' } } }));
    assert.strictEqual(fp.resolve(ws, 'runs', NOENV), path.join(ws, 'st', 'root', 'a', 'b'));
    fs.mkdirSync(path.join(ws, '.claude', 'forge-runs'), { recursive: true });
    assert.strictEqual(fp.resolveExisting(ws, 'runs', NOENV), path.join(ws, '.claude', 'forge-runs'));
  });
  t('Windows-style separators in a relative FORGE_STATE_DIR', () => {
    assert.strictEqual(fp.resolve(withCanon, 'runs', { env: { FORGE_STATE_DIR: 'x\\y' } }), path.join(withCanon, 'x', 'y', 'runs'));
  });
  t('mixed separators and ./ segments resolve the same as clean ones', () => {
    assert.strictEqual(fp.assertSafeRelative('./a//b\\.\\c', 't').join('/'), 'a/b/c');
  });

  // ---- read-only contract ----
  t('resolve / resolveExisting / list never write or create anything', () => {
    const ro = path.join(tmp, 'readonly');
    w(ro, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(realCanon, 'utf8'));
    w(ro, '.claude/FORGE_MEMORY.md', 'x');
    const before = snapshot(ro);
    for (const k of fp.listKeys(ro)) { fp.resolve(ro, k, NOENV); fp.resolveExisting(ro, k, NOENV); fp.locate(ro, k, { env: { FORGE_STATE_DIR: 'elsewhere' } }); }
    assert.deepStrictEqual(snapshot(ro), before);
  });

  // ---- CLI ----
  t('CLI: resolve prints the path, unknown key exits 2, bad usage exits 2', () => {
    const out = [], err = [];
    const o = process.stdout.write, e = process.stderr.write;
    const prev = process.env.FORGE_STATE_DIR;
    delete process.env.FORGE_STATE_DIR;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    let codes;
    try {
      codes = [fp.main(['resolve', 'runs', '--root', withCanon]), fp.main(['resolve', '../x', '--root', withCanon]), fp.main(['bogus']), fp.main(['list', '--json', '--root', legacy])];
    } finally { process.stdout.write = o; process.stderr.write = e; if (prev !== undefined) process.env.FORGE_STATE_DIR = prev; }
    assert.deepStrictEqual(codes, [0, 2, 2, 0]);
    assert.strictEqual(out[0].trim(), path.join(withCanon, '.forge', 'runs'));
    assert.strictEqual(JSON.parse(out[1]).length, 13);
    assert.ok(err.join('').includes('invalid key'));
  });

  // ================= WP: project root discovery, layout, active locations, memory files =================
  const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const proj = (name, marker) => { const d = mk('pr', name); fs.mkdirSync(path.join(d, marker), { recursive: true }); return d; };
  const NOHOME = path.join(tmp, 'no-such-home');
  const R = (o) => fp.projectRootInfo({ ceiling: tmp, home: NOHOME, ...o });
  const pA = proj('a', '.claude');
  const pB = proj('b', '.git');
  const plain = mk('pr', 'plain', 'x', 'y');
  const fb = mk('pr', 'fallback');
  const deepB = mk('pr', 'b', 'src', 'deep');

  // ---- findProjectRoot ordering ----
  t('root: explicit root beats env, cwd and fallback (and is taken as given)', () => {
    const r = R({ root: plain, env: { CLAUDE_PROJECT_DIR: pA }, cwd: deepB, fallback: fb });
    assert.deepStrictEqual([r.root, r.source], [plain, 'explicit']);
  });
  t('root: env CLAUDE_PROJECT_DIR beats cwd and fallback', () => {
    const r = R({ env: { CLAUDE_PROJECT_DIR: pA }, cwd: deepB, fallback: fb });
    assert.deepStrictEqual([r.root, r.source, r.marker], [pA, 'env', '.claude']);
  });
  t('root: cwd walk-up beats fallback; nearest folder with a marker wins', () => {
    const r = R({ env: {}, cwd: deepB, fallback: fb });
    assert.deepStrictEqual([r.root, r.source, r.marker], [pB, 'cwd', '.git']);
    assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {}, cwd: path.join(pA, '.claude') }), pA);
  });
  t('root: fallback only when env and cwd give nothing; nothing at all -> null', () => {
    const r = R({ env: {}, cwd: plain, fallback: fb });
    assert.deepStrictEqual([r.root, r.source], [fb, 'fallback']);
    assert.deepStrictEqual(R({ env: {}, cwd: plain }), { root: null, source: 'none' });
    assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {}, cwd: plain }), null);
  });
  t('root: env pointing at a non-project folder is ignored (cwd decides)', () => {
    const r = R({ env: { CLAUDE_PROJECT_DIR: plain }, cwd: deepB });
    assert.deepStrictEqual([r.root, r.source], [pB, 'cwd']);
  });
  t('root: env that is relative, missing, blank or holds a NUL byte is ignored, never thrown', () => {
    for (const v of ['pr/a', path.join(tmp, 'missing-dir'), '   ', pA + '\0x', 42]) {
      const r = R({ env: { CLAUDE_PROJECT_DIR: v }, cwd: deepB });
      assert.deepStrictEqual([r.root, r.source], [pB, 'cwd'], String(v));
    }
  });
  t('root: a missing cwd never throws; the walk continues from its existing ancestors', () => {
    const r = R({ env: {}, cwd: path.join(pA, 'gone', 'deeper') });
    assert.deepStrictEqual([r.root, r.source], [pA, 'cwd']);
  });
  t('root: .git as a FILE (a git worktree) counts; a FILE named .claude or .forge does not', () => {
    const wt = mk('pr', 'wt'); fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere\n');
    assert.strictEqual(R({ env: {}, cwd: wt }).root, wt);
    const fake = mk('pr', 'fakefiles'); fs.writeFileSync(path.join(fake, '.claude'), 'x'); fs.writeFileSync(path.join(fake, '.forge'), 'x');
    assert.strictEqual(R({ env: {}, cwd: fake }).source, 'none');
  });
  t('root: a .forge folder alone marks a project', () => {
    const f = proj('forgeonly', '.forge');
    assert.deepStrictEqual([R({ env: {}, cwd: f }).root, R({ env: {}, cwd: f }).marker], [f, '.forge']);
  });
  t('root: the walk never goes above the ceiling', () => {
    const inner = mk('pr', 'a', 'pkg', 'lib');
    assert.strictEqual(R({ env: {}, cwd: inner, ceiling: path.join(pA, 'pkg') }).source, 'none');
    assert.strictEqual(R({ env: {}, cwd: inner }).root, pA);
    assert.strictEqual(R({ env: {}, cwd: plain, ceiling: pA }).source, 'none', 'cwd outside the ceiling: no walk');
  });
  t('root: excluded folders never count (env, cwd and fallback)', () => {
    assert.strictEqual(R({ env: { CLAUDE_PROJECT_DIR: pA }, cwd: plain, exclude: [pA] }).source, 'none');
    assert.strictEqual(R({ env: {}, cwd: deepB, exclude: [pB] }).source, 'none');
    assert.strictEqual(R({ env: {}, cwd: plain, fallback: fb, exclude: [path.join(tmp, 'pr')] }).source, 'none');
  });
  t('root: home rule - a home folder with only .claude (the global config) is not a project', () => {
    const home = mk('homes', 'u1'); fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.git'));
    const below = mk('homes', 'u1', 'AppData', 'Temp', 'x');
    assert.strictEqual(fp.projectRootInfo({ ceiling: tmp, home, env: {}, cwd: below }).source, 'none');
    assert.strictEqual(fp.projectRootInfo({ ceiling: tmp, home, env: { CLAUDE_PROJECT_DIR: home }, cwd: below }).source, 'none');
    assert.strictEqual(fp.projectRootInfo({ ceiling: tmp, home: null, env: {}, cwd: below }).root, home, 'home: null switches the rule off');
    const p = mk('homes', 'u1', 'Documents', 'proj'); fs.mkdirSync(path.join(p, '.claude'));
    assert.strictEqual(fp.projectRootInfo({ ceiling: tmp, home, env: {}, cwd: path.join(p) }).root, p, 'a project below home still counts');
    fs.mkdirSync(path.join(home, '.forge'));
    assert.strictEqual(fp.projectRootInfo({ ceiling: tmp, home, env: {}, cwd: below }).root, home, 'home with an explicit .forge counts');
  });
  t('root: the real process.cwd() is the default start', () => {
    const prev = process.cwd();
    try { process.chdir(deepB); assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {} }), pB); }
    finally { process.chdir(prev); }
  });

  // ---- scriptRoot: the codemod target ----
  const installed = proj('inst', '.claude');
  const instBin = mk('pr', 'inst', '.claude', 'forge-bin');
  const instDash = mk('pr', 'inst', '.claude', 'forge-dashboard');
  t('scriptRoot: an installed .claude/<folder> copy keeps today\'s answer even when env and cwd point elsewhere', () => {
    for (const dir of [instBin, instDash]) {
      const r = fp.scriptRootInfo(dir, { ceiling: tmp, home: NOHOME, env: { CLAUDE_PROJECT_DIR: pA }, cwd: deepB });
      assert.deepStrictEqual([r.root, r.source], [installed, 'script'], dir);
    }
    assert.strictEqual(fp.scriptRoot(instBin, { env: {} }), path.resolve(instBin, '..', '..'));
  });
  t('scriptRoot: explicit root wins; an empty script folder is an error', () => {
    assert.strictEqual(fp.scriptRoot(instBin, { root: pA }), pA);
    assert.throws(() => fp.scriptRoot('', {}), fp.PathError);
  });
  const plugRoot = mk('plug', 'cache', 'mkt', 'forge', '1.0.0');
  fs.mkdirSync(path.join(plugRoot, '.git')); fs.mkdirSync(path.join(plugRoot, '.claude-plugin'));
  const plugScripts = mk('plug', 'cache', 'mkt', 'forge', '1.0.0', 'scripts');
  const work = proj('work', '.claude');
  const workSrc = mk('pr', 'work', 'src');
  const insidePlugin = (p) => p !== null && path.relative(plugRoot, p).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(plugRoot, p));
  t('plugin: script folder outside the project, cwd inside the project -> the project', () => {
    const r = fp.scriptRootInfo(plugScripts, { ceiling: tmp, home: NOHOME, env: {}, cwd: workSrc });
    assert.deepStrictEqual([r.root, r.source], [work, 'cwd']);
    const e = fp.scriptRootInfo(plugScripts, { ceiling: tmp, home: NOHOME, env: { CLAUDE_PROJECT_DIR: work }, cwd: plain });
    assert.deepStrictEqual([e.root, e.source], [work, 'env']);
  });
  t('plugin: no path inside the script\'s own package is ever returned (cwd/env inside the plugin)', () => {
    for (const o of [{ env: {}, cwd: plugScripts }, { env: {}, cwd: plugRoot }, { env: { CLAUDE_PROJECT_DIR: plugRoot }, cwd: plugScripts }]) {
      const r = fp.scriptRootInfo(plugScripts, { ceiling: tmp, home: NOHOME, ...o });
      assert.ok(!insidePlugin(r.root), JSON.stringify(r));
    }
    assert.strictEqual(fp.scriptRootInfo(plugScripts, { ceiling: tmp, home: NOHOME, env: {}, cwd: plugRoot }).root, null);
    assert.strictEqual(fp.scriptRootInfo(plugScripts, { ceiling: tmp, home: NOHOME, env: {}, cwd: plugRoot, fallback: plugRoot }).root, null, 'no fallback for scripts');
  });
  t('plugin: a global copy under the home folder (~/.claude/forge-bin) is discovered, never the home folder', () => {
    const home = mk('homes', 'u2'); const gbin = mk('homes', 'u2', '.claude', 'forge-bin');
    const p = mk('homes', 'u2', 'Documents', 'p'); fs.mkdirSync(path.join(p, '.claude'));
    assert.strictEqual(fp.scriptRoot(gbin, { ceiling: tmp, home, env: {}, cwd: p }), p);
    assert.strictEqual(fp.scriptRoot(gbin, { ceiling: tmp, home, env: {}, cwd: mk('homes', 'u2', 'Downloads') }), null);
  });
  t('plugin: a plugin cache inside a git-versioned ~/.claude never yields ~/.claude (or anything in it) as the project', () => {
    const home = mk('homes', 'u3'); const gc = mk('homes', 'u3', '.claude'); fs.mkdirSync(path.join(gc, '.git'));
    const mkt = mk('homes', 'u3', '.claude', 'plugins', 'marketplaces', 'm'); fs.mkdirSync(path.join(mkt, '.git'));
    const scripts = mk('homes', 'u3', '.claude', 'plugins', 'cache', 'm', 'forge', '1.0.0', 'scripts');
    for (const cwd of [scripts, mkt, gc]) assert.strictEqual(fp.scriptRoot(scripts, { ceiling: tmp, home, env: { CLAUDE_PROJECT_DIR: gc }, cwd }), null, cwd);
    const p = mk('homes', 'u3', 'code', 'p'); fs.mkdirSync(path.join(p, '.git'));
    assert.strictEqual(fp.scriptRoot(scripts, { ceiling: tmp, home, env: {}, cwd: p }), p);
    fs.mkdirSync(path.join(mkt, '.forge'));
    assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home, env: {}, cwd: mkt }), mkt, 'an explicit .forge still counts');
  });

  // ---- layout ----
  t('layout: legacy without .forge; forge with a .forge folder; a .forge FILE stays legacy', () => {
    const l1 = proj('lay1', '.claude');
    assert.strictEqual(fp.layout(l1, NOENV), 'legacy');
    fs.writeFileSync(path.join(l1, '.forge'), 'not a dir');
    assert.strictEqual(fp.layout(l1, NOENV), 'legacy');
    const l2 = proj('lay2', '.forge');
    assert.strictEqual(fp.layout(l2, NOENV), 'forge');
  });
  t('layout: FORGE_STATE_DIR set -> forge; blank -> ignored; process.env read by default', () => {
    const l1 = proj('lay3', '.claude');
    assert.strictEqual(fp.layout(l1, { env: { FORGE_STATE_DIR: 'st' } }), 'forge');
    assert.strictEqual(fp.layout(l1, { env: { FORGE_STATE_DIR: '  ' } }), 'legacy');
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = 'st';
    try { assert.strictEqual(fp.layout(l1), 'forge'); }
    finally { if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev; }
  });
  t('layout: a custom canon state_root decides, not the literal .forge', () => {
    const cu = mk('pr', 'laycustom');
    w(cu, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ paths: { state_root: 'var/state', state: { runs: 'r' } } }));
    fs.mkdirSync(path.join(cu, '.forge'));
    assert.strictEqual(fp.layout(cu, NOENV), 'legacy');
    fs.mkdirSync(path.join(cu, 'var', 'state'), { recursive: true });
    assert.strictEqual(fp.layout(cu, NOENV), 'forge');
  });

  // ---- stateDir ----
  const legacyProj = mk('pr', 'sdlegacy');
  w(legacyProj, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(realCanon, 'utf8'));
  const forgeProj = mk('pr', 'sdforge');
  w(forgeProj, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(realCanon, 'utf8'));
  fs.mkdirSync(path.join(forgeProj, '.forge'));
  const canonLegacy = JSON.parse(fs.readFileSync(realCanon, 'utf8')).paths.state_legacy;
  t('stateDir legacy layout: every key is EXACTLY its state_legacy folder; state_root is .claude', () => {
    for (const k of STATE_KEYS) assert.strictEqual(fp.stateDir(legacyProj, k, NOENV), path.join(legacyProj, ...canonLegacy[k].split('/')), k);
    assert.strictEqual(fp.stateDir(legacyProj, 'runs', NOENV), path.join(legacyProj, '.claude', 'forge-runs'));
    assert.strictEqual(fp.stateDir(legacyProj, 'memory', NOENV), path.join(legacyProj, '.claude'));
    assert.strictEqual(fp.stateDir(legacyProj, 'state_root', NOENV), path.join(legacyProj, '.claude'));
  });
  t('stateDir legacy layout: no active path ever lies under .forge (a write cannot flip the layout)', () => {
    const dotForge = path.join(legacyProj, '.forge');
    for (const k of fp.listKeys(legacyProj)) {
      const rel = path.relative(dotForge, fp.stateDir(legacyProj, k, NOENV));
      assert.ok(rel.startsWith('..') || path.isAbsolute(rel), k);
    }
    for (const n of ['FORGE_MEMORY.md', 'LESSONS.md']) assert.ok(path.relative(dotForge, fp.memoryFile(legacyProj, n, NOENV)).startsWith('..'), n);
  });
  t('stateDir forge layout: every key is .forge/<key>; state_root is .forge', () => {
    for (const k of STATE_KEYS) assert.strictEqual(fp.stateDir(forgeProj, k, NOENV), path.join(forgeProj, '.forge', k), k);
    assert.strictEqual(fp.stateDir(forgeProj, 'state_root', NOENV), path.join(forgeProj, '.forge'));
  });
  t('stateDir with FORGE_STATE_DIR: forge layout under the override (absolute and relative)', () => {
    const abs = path.join(tmp, 'ext-state');
    assert.strictEqual(fp.stateDir(legacyProj, 'runs', { env: { FORGE_STATE_DIR: abs } }), path.join(abs, 'runs'));
    assert.strictEqual(fp.stateDir(legacyProj, 'tickets', { env: { FORGE_STATE_DIR: 'alt' } }), path.join(legacyProj, 'alt', 'tickets'));
    assert.throws(() => fp.stateDir(legacyProj, 'runs', { env: { FORGE_STATE_DIR: '../out' } }), /traversal/);
  });
  t('stateDirFor returns all three locations and the layout', () => {
    const d = fp.stateDirFor(forgeProj, 'scribe', NOENV);
    assert.deepStrictEqual(d, { key: 'scribe', layout: 'forge', active: path.join(forgeProj, '.forge', 'scribe'), forge: path.join(forgeProj, '.forge', 'scribe'), legacy: path.join(forgeProj, '.claude', 'forge-scribe') });
    const l = fp.stateDirFor(legacyProj, 'scribe', NOENV);
    assert.deepStrictEqual([l.layout, l.active], ['legacy', l.legacy]);
  });
  t('stateDir: a canon key without a legacy mapping falls back to .claude/forge-<key>', () => {
    const cu = mk('pr', 'sdcustom');
    w(cu, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ paths: { state_root: '.forge', state: { cache: 'cache' } } }));
    assert.strictEqual(fp.stateDir(cu, 'cache', NOENV), path.join(cu, '.claude', 'forge-cache'));
  });
  t('existingStateDirs: only folders that exist, active first, no duplicates', () => {
    const e = mk('pr', 'sdexist');
    assert.deepStrictEqual(fp.existingStateDirs(e, 'runs', NOENV), []);
    mk('pr', 'sdexist', '.claude', 'forge-runs');
    assert.deepStrictEqual(fp.existingStateDirs(e, 'runs', NOENV), [path.join(e, '.claude', 'forge-runs')]);
    mk('pr', 'sdexist', '.forge', 'runs');
    assert.deepStrictEqual(fp.existingStateDirs(e, 'runs', NOENV), [path.join(e, '.forge', 'runs'), path.join(e, '.claude', 'forge-runs')]);
    assert.deepStrictEqual(fp.existingStateDirs(e, 'vault', NOENV), []);
  });
  t('stateDir / stateDirFor / existingStateDirs reject traversal, absolute and unknown keys', () => {
    for (const fn of [fp.stateDir, fp.stateDirFor, fp.existingStateDirs]) {
      for (const k of ['..', '../runs', 'runs/../vault', '..\\runs', '/etc', 'C:\\Windows', 'nope', '__proto__', null]) assert.throws(() => fn(forgeProj, k, NOENV), fp.PathError, String(k));
    }
  });

  // ---- memoryFile ----
  t('memoryFile: legacy -> .claude/<name>; forge -> .forge/memory/<name>', () => {
    assert.strictEqual(fp.memoryFile(legacyProj, 'FORGE_MEMORY.md', NOENV), path.join(legacyProj, '.claude', 'FORGE_MEMORY.md'));
    assert.strictEqual(fp.memoryFile(forgeProj, 'FORGE_MEMORY.md', NOENV), path.join(forgeProj, '.forge', 'memory', 'FORGE_MEMORY.md'));
    assert.strictEqual(fp.memoryFile(forgeProj, 'FORGE_TASK_HISTORY.md', { env: { FORGE_STATE_DIR: 'alt' } }), path.join(forgeProj, 'alt', 'memory', 'FORGE_TASK_HISTORY.md'));
  });
  t('memoryFile read fallback: forge layout reads the legacy file until the new one exists', () => {
    const m = mk('pr', 'mem'); fs.mkdirSync(path.join(m, '.forge'));
    const legacyFile = path.join(m, '.claude', 'FORGE_DECISIONS.md'), newFile = path.join(m, '.forge', 'memory', 'FORGE_DECISIONS.md');
    assert.strictEqual(fp.memoryFile(m, 'FORGE_DECISIONS.md', { env: {}, read: true }), newFile, 'neither exists: read = active');
    w(m, '.claude/FORGE_DECISIONS.md', 'old');
    assert.strictEqual(fp.memoryFile(m, 'FORGE_DECISIONS.md', { env: {}, read: true }), legacyFile);
    assert.strictEqual(fp.memoryFile(m, 'FORGE_DECISIONS.md', NOENV), newFile, 'writes always go to the active file');
    w(m, '.forge/memory/FORGE_DECISIONS.md', 'new');
    assert.strictEqual(fp.memoryFile(m, 'FORGE_DECISIONS.md', { env: {}, read: true }), newFile);
    const info = fp.memoryFileFor(m, 'FORGE_DECISIONS.md', NOENV);
    assert.deepStrictEqual([info.layout, info.active, info.read, info.forge, info.legacy], ['forge', newFile, newFile, newFile, legacyFile]);
  });
  t('memoryFile legacy layout: read = active = .claude/<name>', () => {
    w(legacyProj, '.claude/FORGE_AGENT_LEDGER.md', 'x');
    const info = fp.memoryFileFor(legacyProj, 'FORGE_AGENT_LEDGER.md', NOENV);
    assert.deepStrictEqual([info.layout, info.read, info.active], ['legacy', info.legacy, info.legacy]);
  });
  t('memoryFile rejects anything that is not one plain file name', () => {
    for (const n of ['', '../x', '..', 'a/b', 'a\\b', '.hidden', 'C:x', 'x\0y', 'a..md', 'x'.repeat(129), null, 7]) assert.throws(() => fp.memoryFile(forgeProj, n, NOENV), fp.PathError, String(n));
  });

  // ---- read-only contract for the new functions ----
  t('the new functions never write or create anything (also not in a legacy project)', () => {
    const ro = mk('pr', 'ro2');
    w(ro, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(realCanon, 'utf8'));
    const before = snapshot(path.join(tmp, 'pr'));
    for (const k of fp.listKeys(ro)) { fp.stateDir(ro, k, NOENV); fp.stateDirFor(ro, k, { env: { FORGE_STATE_DIR: 'zz' } }); fp.existingStateDirs(ro, k, NOENV); }
    fp.layout(ro, NOENV); fp.memoryFile(ro, 'FORGE_MEMORY.md', { env: {}, read: true }); fp.memoryFileFor(ro, 'LESSONS.md', { env: { FORGE_STATE_DIR: 'zz' } });
    R({ env: { CLAUDE_PROJECT_DIR: ro }, cwd: path.join(ro, 'a', 'b') }); fp.scriptRootInfo(plugScripts, { ceiling: tmp, home: NOHOME, env: {}, cwd: ro });
    assert.deepStrictEqual(snapshot(path.join(tmp, 'pr')), before);
  });

  // ---- CLI (in process) ----
  const capture = (fn) => {
    const out = [], err = []; const o = process.stdout.write, e = process.stderr.write;
    process.stdout.write = (s) => { out.push(String(s)); return true; }; process.stderr.write = (s) => { err.push(String(s)); return true; };
    let code; try { code = fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
    return { code, out: out.join(''), err: err.join('') };
  };
  t('CLI root / layout / dir / memory with --root (text and --json)', () => {
    const prev = process.env.FORGE_STATE_DIR; delete process.env.FORGE_STATE_DIR;
    try {
      assert.deepStrictEqual([capture(() => fp.main(['root', '--root', legacyProj])).out.trim()], [legacyProj]);
      assert.strictEqual(capture(() => fp.main(['layout', '--root', legacyProj])).out.trim(), 'legacy');
      assert.strictEqual(capture(() => fp.main(['layout', '--root', forgeProj])).out.trim(), 'forge');
      assert.strictEqual(capture(() => fp.main(['dir', 'runs', '--root', legacyProj])).out.trim(), path.join(legacyProj, '.claude', 'forge-runs'));
      assert.strictEqual(capture(() => fp.main(['dir', 'runs', '--root', forgeProj])).out.trim(), path.join(forgeProj, '.forge', 'runs'));
      const j = JSON.parse(capture(() => fp.main(['dir', 'prd', '--root', forgeProj, '--json'])).out);
      assert.deepStrictEqual([j.root, j.layout, j.active, j.legacy], [forgeProj, 'forge', path.join(forgeProj, '.forge', 'prd'), path.join(forgeProj, '.claude', 'forge-prd')]);
      assert.strictEqual(capture(() => fp.main(['memory', 'FORGE_MEMORY.md', '--root', forgeProj])).out.trim(), path.join(forgeProj, '.forge', 'memory', 'FORGE_MEMORY.md'));
      w(forgeProj, '.claude/FORGE_SNAPSHOT.md', 'x');
      assert.strictEqual(capture(() => fp.main(['memory', 'FORGE_SNAPSHOT.md', '--read', '--root', forgeProj])).out.trim(), path.join(forgeProj, '.claude', 'FORGE_SNAPSHOT.md'));
    } finally { if (prev !== undefined) process.env.FORGE_STATE_DIR = prev; }
  });
  t('CLI errors: invalid key/name exit 2, missing key or --root value exit 2', () => {
    const codes = [['dir', '../x', '--root', legacyProj], ['memory', '../x', '--root', legacyProj], ['dir', '--root', legacyProj], ['memory'], ['root', '--root']].map((a) => capture(() => fp.main(a)));
    assert.deepStrictEqual(codes.map((c) => c.code), [2, 2, 2, 2, 2]);
    assert.ok(codes[0].err.includes('invalid key') && codes[1].err.includes('invalid memory file name'));
  });

  // ---- CLI (spawned copies: the plugin scenario and an installed fixture copy) ----
  const { spawnSync } = require('child_process');
  const cleanEnv = () => { const e = { ...process.env }; delete e.CLAUDE_PROJECT_DIR; delete e.FORGE_STATE_DIR; return e; };
  const run = (script, args, cwd, env) => spawnSync(process.execPath, [script].concat(args), { cwd, env: env || cleanEnv(), encoding: 'utf8', timeout: 30000 });
  const plugCopy = path.join(plugScripts, 'forge-paths.cjs');
  fs.copyFileSync(path.join(__dirname, 'forge-paths.cjs'), plugCopy);
  t('spawned plugin copy: cwd inside the project -> project root and its legacy runs folder', () => {
    const r = run(plugCopy, ['root', '--json'], workSrc);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual([JSON.parse(r.stdout).root, JSON.parse(r.stdout).source], [work, 'cwd']);
    const d = run(plugCopy, ['dir', 'runs'], workSrc);
    assert.deepStrictEqual([d.status, d.stdout.trim()], [0, path.join(work, '.claude', 'forge-runs')]);
    const env = cleanEnv(); env.CLAUDE_PROJECT_DIR = work;
    const e = run(plugCopy, ['root'], plugRoot, env);
    assert.deepStrictEqual([e.status, e.stdout.trim()], [0, work]);
  });
  t('spawned plugin copy: run from inside the plugin it never answers a plugin folder', () => {
    for (const cwd of [plugRoot, plugScripts]) {
      const r = run(plugCopy, ['root'], cwd);
      assert.ok(r.status === 1 || (r.status === 0 && !insidePlugin(r.stdout.trim())), cwd + ' -> ' + r.status + ' ' + r.stdout);
      if (r.status === 1) assert.ok(r.stderr.includes('no project root found'));
    }
  });
  t('spawned installed copy (<fixture>/.claude/forge-bin): its own project wins over env and cwd, as today', () => {
    const fx = proj('fixture', '.claude'); const fxBin = mk('pr', 'fixture', '.claude', 'forge-bin');
    const copy = path.join(fxBin, 'forge-paths.cjs'); fs.copyFileSync(path.join(__dirname, 'forge-paths.cjs'), copy);
    const env = cleanEnv(); env.CLAUDE_PROJECT_DIR = work;
    const r = run(copy, ['root', '--json'], workSrc, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual([JSON.parse(r.stdout).root, JSON.parse(r.stdout).source], [fx, 'script']);
    assert.strictEqual(run(copy, ['--discover', 'root'], workSrc, env).stdout.trim(), work, '--discover ignores the script location');
  });
  t('system bases (LOCALAPPDATA, APPDATA, the temp folder, a drive root) never count as a project through a stray .claude/.git', () => {
    const saved = { L: process.env.LOCALAPPDATA, A: process.env.APPDATA };
    const fakeLocal = mk('sysbase', 'Local'); fs.mkdirSync(path.join(fakeLocal, '.claude', 'forge-runs'), { recursive: true });
    const fakeRoam = mk('sysbase', 'Roaming'); fs.mkdirSync(path.join(fakeRoam, '.git'), { recursive: true });
    process.env.LOCALAPPDATA = fakeLocal; process.env.APPDATA = fakeRoam;
    try {
      const below = path.join(fakeLocal, 'Temp', 'x'); fs.mkdirSync(below, { recursive: true });
      assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {}, cwd: below }), null, 'a stray .claude in LOCALAPPDATA is not a project');
      const below2 = path.join(fakeRoam, 'y'); fs.mkdirSync(below2, { recursive: true });
      assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {}, cwd: below2 }), null, 'a stray .git in APPDATA is not a project');
      const real = path.join(fakeLocal, 'Temp', 'real'); fs.mkdirSync(path.join(real, '.claude'), { recursive: true });
      const deep = path.join(real, 'a', 'b'); fs.mkdirSync(deep, { recursive: true });
      assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {}, cwd: deep }), real, 'a real project BELOW a system base is still found first');
      fs.mkdirSync(path.join(fakeLocal, '.forge'), { recursive: true });
      assert.strictEqual(fp.findProjectRoot({ ceiling: tmp, home: NOHOME, env: {}, cwd: below }), fakeLocal, 'an explicit .forge opts the folder in');
    } finally {
      if (saved.L === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.L;
      if (saved.A === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.A;
    }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
