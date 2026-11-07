#!/usr/bin/env node
'use strict';
/**
 * forge-doctor-adapters.test.cjs — SA-P1B-DOCTOR. The doctor RUNS the two skill adapters cheaply and is
 * red when one of them breaks while its global skill is installed:
 *   graphify: node forge-graphify.cjs check-skill --skill-dir <home>/skills/graphify   (finds the CLI + checks the skill)
 *   watch:    node forge-watch-launch.cjs which   (resolves a working Python 3) + its resolveScript('watch.py') step
 * Every fixture lives in its own os.tmpdir() folder and is removed at the end; the runner is injected, so no test
 * spawns graphify or Python. One read-only test runs the real adapters on this machine. Harness: this project's own
 * tFn + trailing "N passed, M failed" tally (forge-doctor runTests reads that line).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let A = null, loadError = null;
try { A = require('./doctor/checks-adapters.cjs'); } catch (e) { loadError = e; }
const D = require('./forge-doctor.cjs');

let pass = 0, fail = 0, skipped = 0;
// W2-H1B-SCOUT L1: a case that needs global skills only some machines have SKIPS visibly (counted as
// skipped, never as passed). FORGE_TEST_HOME (test-only) points the real-agent cases at another home, e.g. an empty one.
const skip = (name, why) => { skipped++; console.log('  skip ' + name + ' — ' + why); };
const REAL_CLAUDE_HOME = path.join(process.env.FORGE_TEST_HOME ? path.resolve(process.env.FORGE_TEST_HOME) : os.homedir(), '.claude');
const tFn = (name, fn) => { try { if (!A) throw new Error('doctor/checks-adapters.cjs does not load: ' + (loadError && loadError.message)); fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-adapters-'));
let seq = 0;
const wf = (base, rel, body) => { const p = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
function project(opts) {
  const root = path.join(TMP, 'p' + (++seq));
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  if (!opts || opts.dev !== false) wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  return root;
}
/** home(skills) — a throwaway Claude home with ~/.claude/skills/<id>/SKILL.md per id; watch also gets scripts/watch.py unless noScript. */
function home(ids, opts) {
  const h = path.join(TMP, 'h' + (++seq));
  fs.mkdirSync(h, { recursive: true });
  for (const id of ids) wf(h, 'skills/' + id + '/SKILL.md', '---\nname: ' + id + '\ndescription: x\n---\n');
  if (ids.includes('watch') && !(opts && opts.noScript)) wf(h, 'skills/watch/scripts/watch.py', 'print("usage: watch")\n');
  return h;
}
/** runner(map) — fake spawn: map[toolBaseName] = {status, stdout, stderr, error}; records every call. */
function runner(map) {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); const r = map[path.basename(args[0])]; return r || { status: 0, stdout: 'ok\n', stderr: '' }; };
  run.calls = calls;
  return run;
}
const BIN = path.join(__dirname);

console.log('forge-doctor adapter checks (SA-P1B-DOCTOR)');
tFn('no adapter skill installed in the Claude home -> applicable:false, ok:true, nothing spawned', () => {
  const run = runner({});
  const r = A.adapterSmokeCheck(project(), { claudeHome: home([]), run, binDir: BIN });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.applicable, false); assert.strictEqual(run.calls.length, 0);
  assert.deepStrictEqual(r.adapters.map((a) => [a.id, a.applicable]), [['graphify', false], ['watch', false], ['claude-mem', false], ['agent-skill-refs', false]]);
});
tFn('both skills installed and both adapters answer exit 0 -> ok, and each adapter ran as node <tool> <args> with no shell', () => {
  const h = home(['graphify', 'watch']);
  const run = runner({});
  const r = A.adapterSmokeCheck(project(), { claudeHome: h, run, binDir: BIN });
  assert.strictEqual(r.ok, true, r.reason); assert.strictEqual(r.applicable, true);
  assert.deepStrictEqual(run.calls.map((c) => [c.cmd, path.basename(c.args[0])].concat(c.args.slice(1))), [
    [process.execPath, 'forge-graphify.cjs', 'check-skill', '--skill-dir', path.join(h, 'skills', 'graphify')],
    [process.execPath, 'forge-watch-launch.cjs', 'which'],
  ]);
  assert.ok(run.calls.every((c) => c.opts.shell === false && c.opts.timeout > 0), 'no shell, bounded');
  assert.strictEqual(run.calls[1].opts.env.WATCH_SKILL_DIR, path.join(h, 'skills', 'watch'));
});
tFn('graphify check-skill exits 1 -> RED in the development tree, the reason names graphify and its first problem line', () => {
  const run = runner({ 'forge-graphify.cjs': { status: 1, stdout: 'skill problems:\n  - .graphify_version is 0.8.49, package is 0.8.50\n', stderr: '' } });
  const r = A.adapterSmokeCheck(project(), { claudeHome: home(['graphify', 'watch']), run, binDir: BIN });
  assert.strictEqual(r.ok, false);
  assert.ok(/graphify/.test(r.reason) && /0\.8\.49/.test(r.reason) && /exit 1/.test(r.reason), r.reason);
  assert.ok(!/watch/.test(r.reason), 'the healthy watch adapter is not blamed: ' + r.reason);
});
tFn('watch: Python resolves but scripts/watch.py is missing -> RED, the reason says the script is not found', () => {
  const r = A.adapterSmokeCheck(project(), { claudeHome: home(['watch'], { noScript: true }), run: runner({}), binDir: BIN });
  assert.strictEqual(r.ok, false);
  assert.ok(/watch/.test(r.reason) && /script not found/.test(r.reason), r.reason);
});
tFn('watch: no working Python 3 (which exits 2) -> RED with the launcher\'s own message', () => {
  const run = runner({ 'forge-watch-launch.cjs': { status: 2, stdout: '', stderr: 'no working Python 3 found (python: exit 9009)\n' } });
  const r = A.adapterSmokeCheck(project(), { claudeHome: home(['watch']), run, binDir: BIN });
  assert.strictEqual(r.ok, false); assert.ok(/no working Python 3/.test(r.reason), r.reason);
});
tFn('a runner that times out (status null, ETIMEDOUT) is a FAIL with a reason, never a silent pass', () => {
  const run = runner({ 'forge-graphify.cjs': { status: null, error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' } });
  const r = A.adapterSmokeCheck(project(), { claudeHome: home(['graphify']), run, binDir: BIN });
  assert.strictEqual(r.ok, false); assert.ok(/ETIMEDOUT|timed out/.test(r.reason), r.reason);
});
tFn('skill installed but the adapter tool is missing from forge-bin -> RED (the skill can no longer be run the Forge way)', () => {
  const emptyBin = fs.mkdtempSync(path.join(TMP, 'bin-'));
  const r = A.adapterSmokeCheck(project(), { claudeHome: home(['graphify']), run: runner({}), binDir: emptyBin });
  assert.strictEqual(r.ok, false); assert.ok(/forge-graphify\.cjs/.test(r.reason) && /missing/.test(r.reason), r.reason);
});
tFn('outside the development tree a broken adapter is LABELLED (ok:true, enforced:false), never red', () => {
  const run = runner({ 'forge-graphify.cjs': { status: 1, stdout: 'skill problems:\n  - x\n', stderr: '' } });
  const r = A.adapterSmokeCheck(project({ dev: false }), { claudeHome: home(['graphify']), run, binDir: BIN });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.enforced, false); assert.ok(r.broken.includes('graphify'), JSON.stringify(r.broken));
});
/** memHome(opts) — a Claude home that enables claude-mem, with an install record and a .claude-mem settings file. */
function memHome(opts) {
  const o = opts || {};
  const base = path.join(TMP, 'm' + (++seq));
  const h = path.join(base, '.claude'); const memDir = path.join(base, '.claude-mem');
  const install = path.join(h, 'plugins', 'cache', 'thedotmack', 'claude-mem', '1.0.0');
  wf(h, 'settings.json', JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': o.enabled !== false } }));
  wf(h, 'plugins/installed_plugins.json', JSON.stringify({ plugins: { 'claude-mem@thedotmack': [{ installPath: install }] } }));
  if (o.worker !== false) wf(install, 'scripts/worker-service.cjs', '// worker\n');
  const exe = wf(base, 'bin/claude.exe', 'x');
  wf(memDir, 'settings.json', JSON.stringify({ CLAUDE_CODE_PATH: o.badPath ? path.join(base, 'gone', 'claude.exe') : exe }));
  if (o.launcherHooks) wf(install, 'hooks/hooks.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-mem', args: ['hook', 'claude-code', 'session-init'] }] }] } }));
  const launcherDir = path.join(base, 'launcher-bin');
  if (o.launcherHooks) wf(launcherDir, process.platform === 'win32' ? 'claude-mem.exe' : 'claude-mem', 'x');
  return { h, memDir, launcherDir, emptyDir: path.join(base, 'bin') };
}
tFn('claude-mem: a CLAUDE_CODE_PATH that no longer exists is RED with the path named (the 2026-11-05 breakage)', () => {
  const { h, memDir } = memHome({ badPath: true });
  const r = A.adapterSmokeCheck(project(), { claudeHome: h, claudeMemDir: memDir, run: runner({}), binDir: BIN });
  assert.strictEqual(r.ok, false); assert.ok(r.broken.includes('claude-mem'), JSON.stringify(r.broken));
  assert.match(r.reason, /CLAUDE_CODE_PATH .* does not exist/);
});
tFn('claude-mem: enabled, installed, a real CLAUDE_CODE_PATH -> applicable and ok', () => {
  const { h, memDir } = memHome({});
  const r = A.adapterSmokeCheck(project(), { claudeHome: h, claudeMemDir: memDir, run: runner({}), binDir: BIN });
  const m = r.adapters.find((a) => a.id === 'claude-mem');
  assert.strictEqual(m.applicable, true); assert.strictEqual(m.ok, true, m.reason); assert.strictEqual(r.ok, true, r.reason);
});
tFn('claude-mem: an install record without the worker script is RED; a disabled plugin is not applicable', () => {
  const a = memHome({ worker: false });
  assert.strictEqual(A.claudeMemHealth(a.h, a.memDir).ok, false);
  const b = memHome({ enabled: false, badPath: true });
  const m = A.claudeMemHealth(b.h, b.memDir);
  assert.strictEqual(m.applicable, false); assert.strictEqual(m.ok, true);
});
tFn('claude-mem: hooks that run the bare claude-mem launcher with no launcher on any PATH are RED (2026-11-05: nothing recorded since 2026-10-16)', () => {
  const m = memHome({ launcherHooks: true });
  const r = A.adapterSmokeCheck(project(), { claudeHome: m.h, claudeMemDir: m.memDir, run: runner({}), binDir: BIN, env: { PATH: m.emptyDir }, readUserPath: () => m.emptyDir });
  assert.strictEqual(r.ok, false, r.reason); assert.ok(r.broken.includes('claude-mem'), JSON.stringify(r.broken));
  assert.match(r.reason, /no claude-mem launcher is on PATH/);
});
tFn('claude-mem: launcher only on the persisted user PATH (session started before it was added) -> ok with a stale-session warning', () => {
  const m = memHome({ launcherHooks: true });
  const r = A.adapterSmokeCheck(project(), { claudeHome: m.h, claudeMemDir: m.memDir, run: runner({}), binDir: BIN, env: { PATH: m.emptyDir }, readUserPath: () => m.launcherDir });
  assert.strictEqual(r.ok, true, r.reason); assert.strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.reason, /^warn: claude-mem: .*record nothing/);
});
tFn('claude-mem: launcher on this process PATH -> ok, no warning; hooks without the bare launcher skip the PATH check', () => {
  const m = memHome({ launcherHooks: true });
  const r = A.adapterSmokeCheck(project(), { claudeHome: m.h, claudeMemDir: m.memDir, run: runner({}), binDir: BIN, env: { PATH: m.launcherDir }, readUserPath: () => '' });
  assert.strictEqual(r.ok, true, r.reason); assert.deepStrictEqual(r.warnings, []);
  const n = memHome({});
  assert.strictEqual(A.claudeMemHealth(n.h, n.memDir, { env: { PATH: n.emptyDir }, readUserPath: () => '' }).ok, true);
});
/** refsFixture(o) — a project with one agent body naming on-demand skills, and a Claude home where they live. */
function refsFixture(o) {
  const base = path.join(TMP, 'r' + (++seq));
  const root = path.join(base, 'proj'), h = path.join(base, '.claude');
  wf(root, '.claude/agents/skill-boss.md', '## Core skills\n\nRead `.claude/skills/<name>/SKILL.md` (else `~/.claude/skills/<name>/SKILL.md`; if neither exists, say so and go on without it): ' + o.names + ', forge-router (for the Step 0b rules).\n');
  wf(root, '.claude/skills/forge-router/SKILL.md', '---\nname: forge-router\n---\n');
  wf(h, 'skills/using-superpowers/SKILL.md', 'x');
  wf(h, 'skills-retired-2026-11-05/skill-builder/SKILL.md', 'x');
  return { root, h };
}
tFn('agent-skill-refs: an agent body naming a skill that now lives only in ~/.claude/skills-retired-* is RED (2026-11-05 review M2: skill-boss -> skill-builder)', () => {
  const f = refsFixture({ names: 'skill-builder, using-superpowers' });
  const r = A.agentSkillRefs(f.root, f.h);
  assert.strictEqual(r.applicable, true); assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /retired skills .*skill-boss\.md: skill-builder/);
});
tFn('agent-skill-refs: resolvable names are ok; a name found nowhere is a warning, not red', () => {
  const ok = A.agentSkillRefs(refsFixture({ names: 'using-superpowers, claude-api' }).root, refsFixture({ names: 'x' }).h);
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.warn, undefined, JSON.stringify(ok));
  const f = refsFixture({ names: 'screenshot-loop' });
  const w = A.agentSkillRefs(f.root, f.h);
  assert.strictEqual(w.ok, true); assert.match(w.warn, /not found anywhere: skill-boss\.md: screenshot-loop/);
});
tFn('agent-skill-refs: the REAL agent bodies of this repo point at no retired skill', () => {
  const r = A.agentSkillRefs(path.join(__dirname, '..', '..'), REAL_CLAUDE_HOME);
  assert.strictEqual(r.ok, true, r.reason);
});
const N5 = 'RED (round-5 N5): the REAL agent bodies name no skill that resolves nowhere (ui-boss.md named screenshot-loop)';
// the agent bodies name global skills (design-is, browser, ...) that live only in ~/.claude/skills on a machine that has them
const N5_NEEDS = ['design-is', 'browser'].filter((n) => !fs.existsSync(path.join(REAL_CLAUDE_HOME, 'skills', n, 'SKILL.md')));
if (N5_NEEDS.length) skip(N5, 'global skill(s) not installed under ' + path.join(REAL_CLAUDE_HOME, 'skills') + ': ' + N5_NEEDS.join(', '));
else tFn(N5, () => {
  const r = A.agentSkillRefs(path.join(__dirname, '..', '..'), REAL_CLAUDE_HOME);
  assert.strictEqual(r.warn, undefined, r.warn);
});
tFn('RED (round-5 N6): files-only entries are marked untimed and timingLabel prints no "(0 ms)" for them; timed adapters keep their ms', () => {
  const { h, memDir } = memHome({});
  const r = A.adapterSmokeCheck(project(), { claudeHome: home(['graphify']), claudeMemDir: memDir, run: runner({}), binDir: BIN });
  const m = A.claudeMemHealth(h, memDir);
  const refs = A.agentSkillRefs(refsFixture({ names: 'using-superpowers' }).root, h);
  for (const e of [m, refs]) { assert.strictEqual(e.timed, false, JSON.stringify(e)); assert.strictEqual(e.ms, undefined, JSON.stringify(e)); assert.strictEqual(A.timingLabel(e), ''); }
  const g = r.adapters.find((a) => a.id === 'graphify');
  assert.strictEqual(typeof g.ms, 'number'); assert.strictEqual(A.timingLabel(g), ' (' + g.ms + ' ms)');
});
tFn('wired (round-5 N6): the doctor summary prints adapter timing through timingLabel, never the raw a.ms', () => {
  const src = fs.readFileSync(path.join(__dirname, 'doctor', 'report.cjs'), 'utf8');
  assert.match(src, /require\('\.\/checks-adapters\.cjs'\)/);
  assert.match(src, /a\.id \+ ' ok' \+ timingLabel\(a\)/);
  assert.doesNotMatch(src, /' ok \(' \+ a\.ms/);
});
tFn('RED (round-5 N7): a failed registry read is reported as such, never as "no PATH has the launcher"', () => {
  const m = memHome({ launcherHooks: true });
  const r = A.claudeMemHealth(m.h, m.memDir, { env: { PATH: m.emptyDir }, readUserPath: () => ({ path: '', error: 'reg query exit 1' }) });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.doesNotMatch(r.reason, /no claude-mem launcher is on PATH/);
  assert.match(r.reason, /registry read failed \(reg query exit 1\)/);
  assert.match(r.reason, /unknown/);
  // a partial read that DOES find the launcher is still the stale-session warning
  const s = A.claudeMemHealth(m.h, m.memDir, { env: { PATH: m.emptyDir }, readUserPath: () => ({ path: m.launcherDir, error: 'HKLM read failed' }) });
  assert.strictEqual(s.ok, true); assert.match(s.warn, /record nothing/);
});
tFn('a fixture root with no explicit claudeHome never reads or runs against the real machine', () => {
  const run = runner({});
  const r = A.adapterSmokeCheck(project(), { run, binDir: BIN });
  assert.strictEqual(r.applicable, false); assert.strictEqual(run.calls.length, 0);
});
tFn('wired: skill_adapters is an ENFORCED doctor check and re-exported by forge-doctor.cjs (printSummary line: forge-doctor.test.cjs)', () => {
  assert.ok(D.DOCTOR_CHECK_ORDER.checks.includes('skill_adapters'), JSON.stringify(D.DOCTOR_CHECK_ORDER.checks));
  assert.strictEqual(D.adapterSmokeCheck, A.adapterSmokeCheck);
});
tFn('REAL machine (read-only): the adapter check runs and, when applicable, both real adapters pass', () => {
  const r = A.adapterSmokeCheck(path.resolve(__dirname, '..', '..'));
  assert.strictEqual(r.ok, true, r.reason);
  console.log('    info real adapters: ' + r.adapters.map((a) => a.id + '=' + (a.applicable ? (a.ok ? 'ok' : 'broken') : 'n/a') + A.timingLabel(a)).join(', '));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
process.exitCode = fail ? 1 : 0;
