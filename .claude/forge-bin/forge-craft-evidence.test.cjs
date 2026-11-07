#!/usr/bin/env node
'use strict';
/**
 * forge-craft-evidence.test.cjs — tests for the screenshot evidence record and the lens guidance block.
 * Proves: the real web-ui lens guidance validates and names 3 viewports and 6 states; a complete record passes (exit 0);
 * a missing state, a missing or fake screenshot file, a path outside the project, an empty "checked" line, an n/a without
 * a reason, a file:// source, a too-narrow PNG or one image claimed for two widths each fail (exit 1); usage and
 * "cannot judge" exit 2; the template never passes unfilled; guidance mutations fail the lens schema in forge-craft.
 * Temp fixtures live in the OS temp folder and are removed at the end.
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const E = require('./forge-craft-evidence.cjs');
const C = require('./forge-craft.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(__dirname, 'forge-craft-evidence.cjs');
const CRAFT = path.join(__dirname, 'forge-craft.cjs');
const ENV = Object.assign({}, process.env); delete ENV.FORGE_STATE_DIR; delete ENV.FORGE_PROJECT_ROOT;
const run = (args, root) => spawnSync(process.execPath, [TOOL, ...args, '--root', root || ROOT], { encoding: 'utf8', windowsHide: true, env: ENV });
const clone = (v) => JSON.parse(JSON.stringify(v));
const realWeb = C.loadLens(ROOT, 'web-ui');
const tmpDirs = [];
function write(root, rel, data) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; }
/** png(width) -> the first bytes of a PNG with that width (signature + IHDR); enough for the magic-byte and width check. */
function png(width) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(900, 20); b[24] = 8; b[25] = 6;
  return b;
}
const VP = { mobile: 375, tablet: 768, desktop: 1280 };
const STATES = ['loading', 'empty', 'error', 'partial', 'success', 'permission'];
/** fixture() -> {root, rec, save}: a temp project with the real web-ui lens, real-looking screenshots and a complete record. */
function fixture(runId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-craft-ev-')); tmpDirs.push(root);
  write(root, '.claude/config/quality/lenses/web-ui.json', JSON.stringify(realWeb.lens));
  write(root, '.claude/config/quality/lenses/code.json', JSON.stringify(C.loadLens(ROOT, 'code').lens));
  const views = ['home', 'bookings'].map((v) => {
    const viewports = {}, states = {};
    for (const [id, w] of Object.entries(VP)) { const rel = 'docs/shots/' + v + '-' + id + '.png'; write(root, rel, png(w * (id === 'mobile' ? 2 : 1))); viewports[id] = { width: w, screenshots: [rel], checked: 'hero, nav and footer edges at ' + w + ' px; no sideways scroll' }; }
    for (const s of STATES) { const rel = 'docs/shots/' + v + '-state-' + s + '.jpg'; write(root, rel, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])); states[s] = { screenshots: [rel], checked: 'the ' + s + ' message, its words and the next step' }; }
    return { view: v, path: '/' + (v === 'home' ? '' : v), viewports, states };
  });
  views[0].states.permission = { na: 'the home page is public, there is no sign-in' };
  const rec = { kind: E.RECORD_KIND, version: E.RECORD_VERSION, type: 'web-ui', served_from: 'http://localhost:3000', reviewer: 'UI Boss', views };
  const file = '.claude/forge-runs/' + runId + '/craft-evidence-web-ui.json';
  const save = (r) => write(root, file, JSON.stringify(r, null, 2));
  save(rec);
  return { root, rec, save, file: path.join(root, ...file.split('/')) };
}
/** failsWith(mutate, re): a mutated copy of the complete record must fail with a problem matching re. */
function failsWith(mutate, re, setup) {
  const f = fixture('run-m');
  if (setup) setup(f.root);
  const r = clone(f.rec); mutate(r); f.save(r);
  const res = run(['check', '--run', 'run-m', '--json'], f.root);
  const j = JSON.parse(res.stdout);
  const probs = j.records.flatMap((x) => x.problems);
  ok(res.status === 1 && probs.some((p) => re.test(p)), 'exit ' + res.status + ' ' + JSON.stringify(probs).slice(0, 600));
}

console.log('forge-craft-evidence tests (guidance schema, evidence record, screenshot files, CLI contract)');

// ---- A. the real lens -------------------------------------------------------------------------------------------
t('the real web-ui lens carries valid guidance: precedence, a token plan, tells, copy rules, a11y/performance/ux rule lines', () => {
  ok(realWeb && realWeb.valid, realWeb && realWeb.problems.join('; '));
  const g = realWeb.lens.guidance;
  ok(E.guidanceProblems(g).length === 0, JSON.stringify(E.guidanceProblems(g)));
  ok(/brief/.test(g.precedence) && /wins/.test(g.precedence), 'precedence must say the brief wins');
  ok(/hex/.test(g.before_build[0]) && g.before_build.some((s) => /layout sketch/i.test(s)) && g.before_build.some((s) => /against the brief/.test(s)), 'token plan');
  const areas = new Set(g.rule_lines.map((r) => r.area));
  ok(areas.has('accessibility') && areas.has('performance') && areas.has('ux'), 'areas ' + [...areas]);
  for (const id of ['contrast', 'focus-visible', 'touch-target', 'image-dimensions', 'layout-shift', 'reduced-motion']) ok(g.rule_lines.some((r) => r.id === id), 'rule line ' + id + ' missing');
  for (const id of ['default-palette', 'hero-plus-three-cards', 'uniform-grids', 'gradient-blobs', 'random-spacing', 'vague-copy', 'no-focus-states']) ok(g.tells.some((x) => x.id === id), 'tell ' + id + ' missing');
  ok(g.copy_rules.some((c) => /80 characters/.test(c)) && g.copy_rules.some((c) => /memorable element/.test(c)) && g.copy_rules.some((c) => /empty state/i.test(c)), 'copy rules');
  ok(JSON.stringify(g.requires_evidence.viewports.map((v) => v.id)) === '["mobile","tablet","desktop"]' && JSON.stringify(g.requires_evidence.states) === JSON.stringify(STATES), 'evidence requirement');
});
t('forge-craft prints the guidance: lens text and JSON for web-ui, the short form in plan; lenses without guidance stay unchanged', () => {
  const txt = spawnSync(process.execPath, [CRAFT, 'lens', '--type', 'web-ui', '--root', ROOT], { encoding: 'utf8', env: ENV }).stdout;
  ok(/^Precedence: /m.test(txt) && /Looks-generated tells/.test(txt) && /forge-craft-evidence\.cjs check --run <run_id> --type web-ui/.test(txt), txt.slice(0, 300));
  const j = JSON.parse(spawnSync(process.execPath, [CRAFT, 'lens', '--type', 'web-ui', '--json', '--root', ROOT], { encoding: 'utf8', env: ENV }).stdout);
  ok(j.guidance && j.guidance.rule_lines.length === realWeb.lens.guidance.rule_lines.length, 'json guidance');
  const plan = spawnSync(process.execPath, [CRAFT, 'plan', '--deliverables', 'web-ui', '--root', ROOT], { encoding: 'utf8', env: ENV }).stdout;
  ok(/Looks-generated tells: default-palette/.test(plan) && !/-> instead:/.test(plan), 'plan short form');
  const code = JSON.parse(spawnSync(process.execPath, [CRAFT, 'lens', '--type', 'code', '--json', '--root', ROOT], { encoding: 'utf8', env: ENV }).stdout);
  ok(!('guidance' in code), 'a lens without guidance must not grow a guidance key');
});
t('MUTATION: bad guidance fails the lens schema in forge-craft (result field, duplicate id, wrong area, reversed range, short lists)', () => {
  const cases = [
    ['a status field', (g) => { g.status = 'CLEAN'; }, /not a guidance field/],
    ['a duplicate tell id', (g) => { g.tells[1].id = g.tells[0].id; }, /is a duplicate/],
    ['an unknown area', (g) => { g.rule_lines[0].area = 'seo'; }, /must be one of accessibility\|performance\|ux/],
    ['max below min', (g) => { g.requires_evidence.viewports[0].max_px = 300; }, /max_px below min_px/],
    ['one before_build step', (g) => { g.before_build = g.before_build.slice(0, 1); }, /2\.\.6 items/],
    ['no precedence', (g) => { delete g.precedence; }, /precedence is missing/],
    ['evidence without states', (g) => { delete g.requires_evidence.states; }, /states is missing/],
  ];
  for (const [name, mutate, re] of cases) {
    const l = clone(realWeb.lens); mutate(l.guidance);
    const v = C.validateLens(l, { type: 'web-ui' });
    ok(!v.ok && v.problems.some((p) => re.test(p)), name + ': ' + JSON.stringify(v.problems));
  }
});

// ---- B. the evidence record -------------------------------------------------------------------------------------
t('a complete record passes: check --run exits 0 and counts views, entries, n/a and verified files', () => {
  const f = fixture('run-ok');
  const r = run(['check', '--run', 'run-ok'], f.root);
  ok(r.status === 0 && /web-ui \(.*craft-evidence-web-ui\.json\): COMPLETE · 2 view\(s\), 17 entries with screenshots, 1 n\/a, 17 screenshot file\(s\) verified/.test(r.stdout), 'exit ' + r.status + ' ' + r.stdout + r.stderr);
  const j = JSON.parse(run(['check', '--file', f.file, '--json'], f.root).stdout);
  ok(j.code === 0 && j.ok && j.problems.length === 0 && j.warnings.length === 0, JSON.stringify(j).slice(0, 400));
});
t('a missing state fails (exit 1) and names the view and the state', () => failsWith((r) => { delete r.views[1].states.partial; }, /view "bookings" state "partial" is missing/));
t('a missing viewport fails, and so does a whole missing states block', () => {
  failsWith((r) => { delete r.views[0].viewports.tablet; }, /view "home" viewport "tablet" is missing/);
  failsWith((r) => { delete r.views[0].states; }, /view "home"\.states is missing/);
});
t('a referenced screenshot file that does not exist fails', () => failsWith((r) => { r.views[0].viewports.desktop.screenshots = ['docs/shots/never-taken.png']; }, /"docs\/shots\/never-taken\.png" does not exist in the project/));
t('a fake image (text saved as .png) and a non-image extension fail', () => {
  failsWith((r) => { r.views[0].states.error.screenshots = ['docs/fake.png']; }, /is not a PNG, JPEG or WebP image/, (root) => write(root, 'docs/fake.png', 'not an image at all'));
  failsWith((r) => { r.views[0].states.error.screenshots = ['docs/notes.txt']; }, /is not a \.png, \.jpg or \.webp file/, (root) => write(root, 'docs/notes.txt', 'x'));
});
t('paths outside the project fail: .., an absolute path, a drive path and a URL', () => {
  for (const p of ['../outside.png', '/etc/shot.png', 'C:/shots/a.png', 'https://example.org/a.png', 'docs//a.png']) failsWith((r) => { r.views[0].states.empty.screenshots = [p]; }, /must be a project-relative path/);
});
t('an empty or hollow "checked" line fails; an n/a without a real reason fails; n/a plus screenshots fails', () => {
  failsWith((r) => { r.views[0].viewports.mobile.checked = 'looks good'; }, /\.checked must say what was looked at/);
  failsWith((r) => { r.views[0].states.loading = { na: 'n/a' }; }, /marked n\/a without a real reason/);
  failsWith((r) => { r.views[0].states.loading.na = 'there is nothing to load here'; }, /both n\/a and filled/);
});
t('the served source must not be a file:// URL, and a viewport width must lie in the lens range', () => {
  failsWith((r) => { r.served_from = 'file:///C:/site/index.html'; }, /never a file:\/\/ URL/);
  failsWith((r) => { r.views[0].viewports.mobile.width = 1280; }, /width must be the CSS viewport width used, 320-480 px/);
});
t('a PNG narrower than its viewport fails; one image listed for two widths fails; an odd pixel ratio only warns', () => {
  failsWith((r) => { r.views[0].viewports.desktop.screenshots = ['docs/small.png']; }, /is 400 px wide, narrower than the 1280 px viewport/, (root) => write(root, 'docs/small.png', png(400)));
  failsWith((r) => { r.views[0].viewports.tablet.screenshots = r.views[0].viewports.desktop.screenshots.slice(); r.views[0].viewports.tablet.width = 1100; }, /one image cannot prove two widths/);
  const f = fixture('run-w');
  write(f.root, 'docs/odd.png', png(1000));
  const r = clone(f.rec); r.views[0].viewports.tablet.screenshots = ['docs/odd.png']; f.save(r);
  const res = run(['check', '--run', 'run-w', '--json'], f.root), j = JSON.parse(res.stdout);
  ok(res.status === 0 && j.records[0].warnings.some((w) => /no usual pixel ratio/.test(w)), 'exit ' + res.status + ' ' + res.stdout.slice(0, 400));
});
t('unknown states or fields are named (a typo never hides a missing state)', () => {
  failsWith((r) => { r.views[0].states.sucess = r.views[0].states.success; delete r.views[0].states.success; }, /state "sucess" is not one the lens asks for/);
  failsWith((r) => { r.passed = true; }, /passed is not a record field/);
  failsWith((r) => { r.views[1].view = 'home'; }, /view "home" is listed twice/);
});

// ---- C. CLI contract --------------------------------------------------------------------------------------------
t('no record in the run folder exits 1; a record for a lens without an evidence requirement exits 2', () => {
  const f = fixture('run-x');
  let r = run(['check', '--run', 'run-empty'], f.root);
  ok(r.status === 1 && /no craft-evidence-<type>\.json/.test(r.stdout), 'exit ' + r.status + ' ' + r.stdout);
  const rec = clone(f.rec); rec.type = 'code';
  write(f.root, 'rec-code.json', JSON.stringify(rec));
  r = run(['check', '--file', path.join(f.root, 'rec-code.json')], f.root);
  ok(r.status === 2 && /asks for no evidence record/.test(r.stdout), 'exit ' + r.status + ' ' + r.stdout);
  write(f.root, 'broken.json', '{ not json');
  ok(run(['check', '--file', path.join(f.root, 'broken.json')], f.root).status === 2, 'unparsable record must exit 2');
});
t('usage errors exit 2: no command, check without --run/--file, both, a bad run id, template without --type', () => {
  for (const args of [[], ['check'], ['check', '--run', 'a', '--file', 'b.json'], ['check', '--run', '../x'], ['template'], ['frobnicate'], ['check', '--run', 'a', '--type', 'Bad Type']]) {
    const r = run(args);
    ok(r.status === 2 && /usage:/.test(r.stderr), JSON.stringify(args) + ' exit ' + r.status);
  }
  ok(run(['help']).status === 0, 'help');
});
t('template is shaped by the lens (3 viewports, 6 states per view) and never passes unfilled', () => {
  const f = fixture('run-t');
  const r = run(['template', '--type', 'web-ui', '--views', 'home, menu'], f.root);
  ok(r.status === 0, 'exit ' + r.status + ' ' + r.stderr);
  const tpl = JSON.parse(r.stdout);
  ok(tpl.views.length === 2 && tpl.views[1].view === 'menu' && Object.keys(tpl.views[0].viewports).length === 3 && Object.keys(tpl.views[0].states).length === 6, r.stdout.slice(0, 300));
  write(f.root, 'tpl.json', r.stdout);
  const c = run(['check', '--file', path.join(f.root, 'tpl.json')], f.root);
  ok(c.status === 1 && /INCOMPLETE/.test(c.stdout), 'an unfilled template passed: exit ' + c.status);
  ok(run(['template', '--type', 'code'], f.root).status === 2, 'a lens without an evidence requirement has no template');
});
t('output is deterministic and in-process main() matches the CLI', () => {
  const f = fixture('run-d');
  const a = run(['check', '--run', 'run-d', '--json'], f.root).stdout, b = run(['check', '--run', 'run-d', '--json'], f.root).stdout;
  ok(a === b && a.length > 100, 'differs or empty');
  const lines = [];
  const code = E.main(['check', '--run', 'run-d', '--json'], { out: (s) => lines.push(s), err: (s) => lines.push(s), root: f.root });
  ok(code === 0 && JSON.parse(lines.join('\n')).records[0].ok === true, 'main exit ' + code);
});

// ---- D. wiring --------------------------------------------------------------------------------------------------
t('forge-website carries the finish gate and the token-plan line; its description stays within the 150-character skill-listing rule', () => {
  const txt = fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'forge-website', 'SKILL.md'), 'utf8');
  ok(/\*\*Finish gate:\*\*.*forge-craft-evidence\.cjs check --run <run_id> --type web-ui/.test(txt), 'finish gate line');
  ok(/token plan/.test(txt) && /visual direction always wins/.test(txt), 'token plan / precedence line');
  const desc = ((/^description: "(.*)"$/m.exec(txt) || [])[1] || '');
  ok(desc.length > 20 && desc.length <= 150, 'description length ' + desc.length); // D1 set the forge-* ceiling at 150
});
t('the web-ui lens checks point at the evidence record (breakpoints-read) and the tells list (not-template)', () => {
  const by = Object.fromEntries(realWeb.lens.checks.map((c) => [c.id, c]));
  ok(/forge-craft-evidence\.cjs check/.test(by['breakpoints-read'].evidence_required), 'breakpoints-read');
  ok(/tells/.test(by['not-template'].how_to_inspect) && by['token-plan'] && by['token-plan'].severity === 'block', 'not-template / token-plan');
});

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ } }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
