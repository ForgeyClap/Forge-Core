#!/usr/bin/env node
'use strict';
/** forge-ci-config.test.cjs — modernization WP 3.7. Zero-dependency checks of Forge's own CI configuration:
 *    - the root package.json: `npm test` is the doctor, no dependencies, no lifecycle scripts (supply chain), private;
 *    - .github/workflows/ci.yml: read-only permissions, actions pinned to a full commit SHA with a version comment,
 *      ubuntu + windows matrix, `npm test`, no secrets, no publish/deploy, a timeout, cancel-in-progress;
 *    - evals/plugin/: the `claude plugin eval` smoke suite parses against the case format of Claude Code 2.1.310
 *      (prompt.md frontmatter keys, grader types and fields) and uses only free graders (no model judge).
 *  The checks are pure functions over text. They run against the REAL files only in Forge's own tree (package.json
 *  named "forge" whose test script is the doctor); in any other project (this file ships into synced projects,
 *  which have their own package.json) those parts are SKIPPED out loud. The mutation tests below always run, on
 *  built-in fixtures, so the suite is never vacuous: each check is proven to catch the mistake it exists for. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCTOR_REL = '.claude/forge-bin/forge-doctor.cjs';
const DOCTOR_CMD = 'node ' + DOCTOR_REL + ' --root .';

let pass = 0, fail = 0, skipped = 0;
const t = (name, cond, why) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (why ? ' — ' + why : '')); } };
const skip = (name, reason) => { skipped++; console.log('  SKIP ' + name + ' — ' + reason); };

// ---------------------------------------------------------------- package.json
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall',
  'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepublishOnly', 'prepack', 'postpack', 'publish',
  'postpublish', 'preversion', 'version', 'postversion', 'dependencies', 'preshrinkwrap', 'shrinkwrap', 'postshrinkwrap']);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies'];

/** checkPackage(pkg) -> string[] problems (empty = ok). */
function checkPackage(pkg) {
  const p = [];
  if (!pkg || typeof pkg !== 'object') return ['package.json is not a JSON object'];
  const scripts = pkg.scripts || {};
  if (pkg.private !== true) p.push('private must be true (nothing is published from this tree)');
  if (pkg.publishConfig !== undefined) p.push('publishConfig present (no registry/publish config)');
  for (const f of DEP_FIELDS) if (pkg[f] !== undefined && Object.keys(pkg[f] || {}).length) p.push(f + ' present (zero dependencies)');
  for (const k of Object.keys(scripts)) {
    if (LIFECYCLE.has(k)) p.push('lifecycle script "' + k + '"');
    else if (/^(pre|post)/.test(k)) p.push('pre/post hook script "' + k + '"');
  }
  if (scripts.test !== DOCTOR_CMD) p.push('scripts.test must be exactly "' + DOCTOR_CMD + '", got ' + JSON.stringify(scripts.test));
  if (scripts.doctor !== DOCTOR_CMD) p.push('scripts.doctor must be the doctor');
  if (scripts['test:json'] !== DOCTOR_CMD + ' --json') p.push('scripts["test:json"] must be the doctor with --json');
  const vp = String(scripts['verify:plugin'] || '');
  if (!/forge-plugin-build\.cjs/.test(vp) || !/claude plugin validate dist\/forge-plugin/.test(vp)) p.push('scripts["verify:plugin"] must build and then validate dist/forge-plugin');
  const node = pkg.engines && pkg.engines.node;
  if (node !== '>=18') p.push('engines.node must be ">=18", got ' + JSON.stringify(node));
  return p;
}

// ---------------------------------------------------------------- ci.yml (line based, zero deps)
const SHA_USES = /^\s*-?\s*uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\s+#\s*v\d+(\.\d+){0,2}\s*$/;

/** checkCi(text) -> string[] problems. A deliberately small, line-based reading of the workflow. */
function checkCi(text) {
  const p = [];
  const lines = String(text).split(/\r?\n/);
  const code = lines.map((l) => l.replace(/(^|\s)#.*$/, '')); // comments stripped (a `#` after a space)
  const joined = code.join('\n');
  // permissions: a top-level block with exactly `contents: read`, and no write grant anywhere
  const permIdx = code.findIndex((l) => /^permissions:\s*$/.test(l));
  if (permIdx < 0) p.push('no top-level `permissions:` block');
  else {
    const body = [];
    for (let i = permIdx + 1; i < code.length && /^\s+\S/.test(code[i]); i++) body.push(code[i].trim());
    if (body.length !== 1 || body[0] !== 'contents: read') p.push('top-level permissions must be exactly `contents: read`, got: ' + body.join(', '));
  }
  if (/:\s*write\b|write-all/.test(joined)) p.push('a write permission is granted');
  // every action pinned to a full commit SHA with a version comment
  const uses = lines.filter((l) => /^\s*-?\s*uses:/.test(l));
  if (!uses.length) p.push('no `uses:` steps (checkout/setup-node expected)');
  for (const u of uses) if (!SHA_USES.test(u)) p.push('action not pinned to a 40-hex commit SHA with a `# vX.Y.Z` comment: ' + u.trim());
  for (const a of ['actions/checkout', 'actions/setup-node']) if (!uses.some((u) => u.includes(a + '@'))) p.push(a + ' is not used');
  // matrix: both operating systems
  const os = /os:\s*\[([^\]]*)\]/.exec(joined);
  const osList = os ? os[1].split(',').map((s) => s.trim()) : [];
  for (const o of ['ubuntu-latest', 'windows-latest']) if (!osList.includes(o)) p.push('matrix.os lacks ' + o);
  if (!/node-version:\s*'?20'?\s*$/m.test(joined)) p.push('setup-node must use Node 20');
  // no secrets, no publish, no deploy
  if (/secrets\.|GITHUB_TOKEN|\bsecrets\b/.test(joined)) p.push('a secrets reference');
  if (/npm\s+publish|\bdeploy\b|gh\s+release|git\s+push/i.test(joined)) p.push('a publish/deploy/push step');
  // the test step is the doctor via npm test, and node --version is printed
  if (!/^\s*(-\s+)?run:\s*npm test\s*$/m.test(joined)) p.push('no `run: npm test` step');
  if (!/^\s*(-\s+)?run:\s*node --version\s*$/m.test(joined)) p.push('no `run: node --version` step');
  if (!/^\s*timeout-minutes:\s*\d+\s*$/m.test(joined)) p.push('no job timeout-minutes');
  if (!/cancel-in-progress:\s*true/.test(joined)) p.push('concurrency cancel-in-progress is not true');
  // triggers: push + pull_request on main only
  for (const ev of ['push', 'pull_request']) {
    const re = new RegExp('^  ' + ev + ':\\s*\\n\\s+branches:\\s*\\[main\\]\\s*$', 'm');
    if (!re.test(joined)) p.push(ev + ' must trigger on branches [main] only');
  }
  // the artifact upload happens on failure only
  const up = lines.findIndex((l) => /actions\/upload-artifact@/.test(l));
  if (up >= 0 && !lines.slice(Math.max(0, up - 3), up).some((l) => /if:\s*failure\(\)/.test(l))) p.push('upload-artifact must run on failure() only');
  return p;
}

// ---------------------------------------------------------------- evals/plugin (claude plugin eval case format)
// Facts read from Claude Code 2.1.310 (`claude plugin eval --help`, `eval init --bare`, and the case schema the CLI
// enforces): prompt.md frontmatter keys split into case keys and execution keys; grader .md frontmatter needs `type`.
const CASE_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome'];
const EXEC_KEYS = ['model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'disallowed_tools', 'artifact_publish', 'growthbook_overrides', 'append_system_prompt', 'env'];
const GRADER_FIELDS = {
  regex: { required: ['pattern'], allowed: ['type', 'target', 'pattern', 'flags', 'match', 'weight', 'arm'] },
  tool_used: { required: ['tool'], allowed: ['type', 'tool', 'input_match', 'min', 'max', 'weight', 'arm'] },
  tool_order: { required: ['before', 'after'], allowed: ['type', 'before', 'after', 'weight', 'arm'] },
  file_exists: { required: ['path'], allowed: ['type', 'path', 'exists', 'weight', 'arm'] },
};
const PAID_GRADERS = ['llm', 'baseline'];
const TARGETS = ['trace', 'last_message', 'files', 'mock_calls'];

/** parseFrontmatter(text) -> {fm, body} | {error}. Tiny YAML subset: `key: value`, quoted strings, [a, b], numbers. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { error: 'no frontmatter' };
  const fm = {};
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) return { error: 'unparsable frontmatter line: ' + raw };
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/.test(v)) v = JSON.parse(v);
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    fm[kv[1]] = v;
  }
  return { fm, body: m[2].trim() };
}

/** checkGrader(name, text) -> string[] problems. */
function checkGrader(name, text) {
  const pr = parseFrontmatter(text);
  if (pr.error) return [name + ': ' + pr.error];
  const { fm, body } = pr;
  const p = [];
  if (PAID_GRADERS.includes(fm.type)) return [name + ': grader type "' + fm.type + '" calls a judge model (this suite uses free graders only)'];
  const spec = GRADER_FIELDS[fm.type];
  if (!spec) return [name + ': unknown grader type ' + JSON.stringify(fm.type)];
  const g = Object.assign({}, fm);
  if (fm.type === 'regex' && g.pattern === undefined && body) g.pattern = body; // the CLI maps the body to `pattern`
  for (const k of Object.keys(fm)) if (!spec.allowed.includes(k)) p.push(name + ': field "' + k + '" is not allowed for ' + fm.type);
  for (const k of spec.required) if (g[k] === undefined || g[k] === '') p.push(name + ': missing ' + k);
  if (/TODO/.test(text)) p.push(name + ': still the blank init template (TODO)');
  if (g.arm !== undefined && !['with-only', 'both'].includes(g.arm)) p.push(name + ': arm must be with-only or both');
  if (fm.type === 'regex') {
    if (g.target !== undefined && !TARGETS.includes(g.target)) p.push(name + ': target must be one of ' + TARGETS.join('|'));
    const flags = g.flags === undefined ? '' : String(g.flags);
    if (!/^[dgimsuvy]*$/.test(flags)) p.push(name + ': flags must be JS RegExp flags');
    try { new RegExp(String(g.pattern), flags); } catch (e) { p.push(name + ': pattern does not compile: ' + e.message); }
    if (g.match !== undefined && !/^(contains|not_contains|count:\d+)$/.test(String(g.match))) p.push(name + ': match must be contains | not_contains | count:N');
  }
  if (fm.type === 'tool_used') for (const k of ['min', 'max']) if (g[k] !== undefined && !(Number.isInteger(g[k]) && g[k] >= 0)) p.push(name + ': ' + k + ' must be a non-negative integer');
  return p;
}

/** checkPrompt(name, text) -> string[] problems. */
function checkPrompt(name, text) {
  const pr = parseFrontmatter(text);
  if (pr.error) return [name + ': ' + pr.error];
  const p = [];
  for (const k of Object.keys(pr.fm)) if (!CASE_KEYS.includes(k) && !EXEC_KEYS.includes(k)) p.push(name + ': unknown frontmatter key "' + k + '"');
  if (!pr.body) p.push(name + ': empty prompt');
  if (/TODO/.test(text)) p.push(name + ': still the blank init template (TODO)');
  const runs = pr.fm.runs;
  if (runs !== 1) p.push(name + ': runs must be 1 (a smoke case; every run is a full claude child on the owner\'s quota)');
  if (!(Number.isInteger(pr.fm.max_turns) && pr.fm.max_turns >= 1 && pr.fm.max_turns <= 10)) p.push(name + ': max_turns must be set, 1..10');
  return p;
}

/** checkSuite(dir) -> {cases, problems}. Reads only; every case folder holds prompt.md + graders/*.md. */
function checkSuite(dir) {
  const problems = [];
  const cases = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'results').map((d) => d.name).sort();
  for (const c of cases) {
    const promptPath = path.join(dir, c, 'prompt.md');
    if (!fs.existsSync(promptPath)) { problems.push(c + ': no prompt.md'); continue; }
    problems.push(...checkPrompt(c + '/prompt.md', fs.readFileSync(promptPath, 'utf8')));
    const gdir = path.join(dir, c, 'graders');
    const graders = fs.existsSync(gdir) ? fs.readdirSync(gdir).filter((f) => f.endsWith('.md')) : [];
    if (!graders.length) problems.push(c + ': no graders/*.md');
    for (const g of graders) problems.push(...checkGrader(c + '/graders/' + g, fs.readFileSync(path.join(gdir, g), 'utf8')));
  }
  return { cases, problems };
}

// ---------------------------------------------------------------- fixtures for the mutation tests (always run)
const GOOD_PKG = { name: 'forge', private: true, engines: { node: '>=18' }, scripts: { test: DOCTOR_CMD, 'test:json': DOCTOR_CMD + ' --json', doctor: DOCTOR_CMD, 'verify:plugin': 'node .claude/forge-bin/forge-plugin-build.cjs && claude plugin validate dist/forge-plugin' } };
const SHA = 'a'.repeat(40);
const GOOD_CI = ['name: ci', 'on:', '  push:', '    branches: [main]', '  pull_request:', '    branches: [main]', 'permissions:', '  contents: read',
  'concurrency:', '  group: ci-${{ github.ref }}', '  cancel-in-progress: true', 'jobs:', '  doctor:', '    runs-on: ${{ matrix.os }}', '    timeout-minutes: 30',
  '    strategy:', '      matrix:', '        os: [ubuntu-latest, windows-latest]', '    steps:',
  '      - uses: actions/checkout@' + SHA + ' # v7.0.1', '      - uses: actions/setup-node@' + SHA + ' # v7.1.0', '        with:', "          node-version: '20'",
  '      - run: node --version', '      - run: npm test', '      - name: up', '        if: failure()', '        uses: actions/upload-artifact@' + SHA + ' # v7.0.2'].join('\n');
const GOOD_PROMPT = '---\ndescription: d\nruns: 1\nmax_turns: 3\n---\n\nSay hi.\n';
const GOOD_GRADER = "---\ntype: regex\ntarget: last_message\npattern: 'hi'\nmatch: contains\n---\n";

const has = (problems, re) => problems.some((x) => re.test(x));

console.log('forge-ci-config — mutation tests on built-in fixtures');
t('fixture package.json is clean', checkPackage(GOOD_PKG).length === 0, checkPackage(GOOD_PKG).join('; '));
t('fixture ci.yml is clean', checkCi(GOOD_CI).length === 0, checkCi(GOOD_CI).join('; '));
const mutPkg = (fn) => { const p = JSON.parse(JSON.stringify(GOOD_PKG)); fn(p); return checkPackage(p); };
t('mutation: a postinstall script is caught', has(mutPkg((p) => { p.scripts.postinstall = 'node x.js'; }), /lifecycle script "postinstall"/));
t('mutation: a prepare script is caught', has(mutPkg((p) => { p.scripts.prepare = 'x'; }), /lifecycle script "prepare"/));
t('mutation: a pretest hook is caught', has(mutPkg((p) => { p.scripts.pretest = 'x'; }), /pre\/post hook script "pretest"/));
t('mutation: a dependency is caught', has(mutPkg((p) => { p.dependencies = { leftpad: '1.0.0' }; }), /dependencies present/));
t('mutation: a devDependency is caught', has(mutPkg((p) => { p.devDependencies = { x: '1' }; }), /devDependencies present/));
t('mutation: publishConfig is caught', has(mutPkg((p) => { p.publishConfig = { registry: 'https://example.invalid' }; }), /publishConfig/));
t('mutation: private false is caught', has(mutPkg((p) => { p.private = false; }), /private must be true/));
t('mutation: npm test that is not the doctor is caught', has(mutPkg((p) => { p.scripts.test = 'echo ok'; }), /scripts\.test must be exactly/));
t('mutation: an engines.node change is caught', has(mutPkg((p) => { p.engines.node = '>=16'; }), /engines\.node/));
const mutCi = (from, to) => checkCi(GOOD_CI.replace(from, to));
t('mutation: a tag-pinned action is caught', has(mutCi('actions/checkout@' + SHA + ' # v7.0.1', 'actions/checkout@v7'), /not pinned/));
t('mutation: a SHA without version comment is caught', has(mutCi('actions/setup-node@' + SHA + ' # v7.1.0', 'actions/setup-node@' + SHA), /not pinned/));
t('mutation: contents: write is caught', has(mutCi('  contents: read', '  contents: write'), /write permission|exactly `contents: read`/));
t('mutation: an extra permission is caught', has(mutCi('  contents: read', '  contents: read\n  id-token: write'), /write permission/));
t('mutation: a missing windows runner is caught', has(mutCi('[ubuntu-latest, windows-latest]', '[ubuntu-latest]'), /lacks windows-latest/));
t('mutation: a secrets reference is caught', has(mutCi('      - run: npm test', '      - run: npm test\n        env:\n          T: ${{ secrets.NPM_TOKEN }}'), /secrets reference/));
t('mutation: an npm publish step is caught', has(mutCi('      - run: npm test', '      - run: npm test\n      - run: npm publish'), /publish/));
t('mutation: a missing npm test step is caught', has(mutCi('      - run: npm test', '      - run: node x.cjs'), /no `run: npm test`/));
t('mutation: a missing timeout is caught', has(mutCi('    timeout-minutes: 30\n', ''), /timeout-minutes/));
t('mutation: an unconditional artifact upload is caught', has(mutCi('        if: failure()\n', ''), /failure\(\) only/));
t('mutation: a pull_request on every branch is caught', has(mutCi('  pull_request:\n    branches: [main]', '  pull_request:'), /pull_request must trigger/));
t('fixture eval prompt and grader are clean', checkPrompt('p', GOOD_PROMPT).length === 0 && checkGrader('g', GOOD_GRADER).length === 0, checkPrompt('p', GOOD_PROMPT).concat(checkGrader('g', GOOD_GRADER)).join('; '));
t('mutation: an llm (paid judge) grader is caught', has(checkGrader('g', '---\ntype: llm\n---\nIt said hi.'), /judge model/));
t('mutation: an unknown grader type is caught', has(checkGrader('g', '---\ntype: contains\n---\nx'), /unknown grader type/));
t('mutation: a regex grader field the CLI rejects is caught', has(checkGrader('g', GOOD_GRADER.replace('match: contains', 'mode: contains')), /field "mode" is not allowed/));
t('mutation: a regex that does not compile is caught', has(checkGrader('g', GOOD_GRADER.replace("'hi'", "'(hi'")), /does not compile/));
t('mutation: the blank init template is caught', has(checkGrader('g', '---\ntype: regex\n---\nTODO: describe'), /blank init template/));
t('mutation: an unknown prompt frontmatter key is caught', has(checkPrompt('p', GOOD_PROMPT.replace('runs: 1', 'runs: 1\nturns: 3')), /unknown frontmatter key "turns"/));
t('mutation: runs 3 (triple quota) is caught', has(checkPrompt('p', GOOD_PROMPT.replace('runs: 1', 'runs: 3')), /runs must be 1/));

// ---------------------------------------------------------------- the real files, in Forge's own tree only
console.log('forge-ci-config — the real files');
let realPkg = null;
try { realPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { realPkg = null; }
const isForgeTree = !!(realPkg && realPkg.name === 'forge' && realPkg.scripts && /forge-doctor\.cjs/.test(String(realPkg.scripts.test || '')));
if (!isForgeTree) {
  skip('package.json / ci.yml / evals/plugin (real files)', 'not Forge\'s own tree (no package.json named "forge" whose test script is the doctor) — a project\'s own CI is its own');
} else {
  const pp = checkPackage(realPkg);
  t('package.json: no lifecycle scripts, no dependencies, npm test is the doctor', pp.length === 0, pp.join('; '));
  t('package.json: the doctor it runs exists', fs.existsSync(path.join(ROOT, ...DOCTOR_REL.split('/'))));
  const ciPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  if (!fs.existsSync(ciPath)) t('ci.yml exists beside package.json', false, 'missing .github/workflows/ci.yml');
  else {
    const cp = checkCi(fs.readFileSync(ciPath, 'utf8'));
    t('ci.yml: read-only, SHA-pinned, ubuntu+windows, npm test, no secrets/publish, timeout, cancel-in-progress', cp.length === 0, cp.join('; '));
  }
  const suite = path.join(ROOT, 'evals', 'plugin');
  if (!fs.existsSync(suite)) skip('evals/plugin suite', 'no evals/plugin folder in this copy (the suite is a development-tree file)');
  else {
    const s = checkSuite(suite);
    t('evals/plugin: exactly 5 cases', s.cases.length === 5, s.cases.join(', '));
    t('evals/plugin: every case parses against the claude plugin eval format, free graders only', s.problems.length === 0, s.problems.join('; '));
  }
}

console.log(pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exitCode = fail ? 1 : 0;

module.exports = { checkPackage, checkCi, checkSuite, checkGrader, checkPrompt, parseFrontmatter };
