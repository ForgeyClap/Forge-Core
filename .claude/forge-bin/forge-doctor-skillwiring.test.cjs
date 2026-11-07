#!/usr/bin/env node
'use strict';
/**
 * forge-doctor-skillwiring.test.cjs — SA-P1-SKILLS (2026-11-04, PHASE2-PLAN A7 + B2 guard, rule "added = installed +
 * wired + used"). Three doctor guards, all in doctor/checks-ship.cjs:
 *   (a) a skill whose description says "Use when/before/after/during" while disable-model-invocation is true can
 *       never auto-trigger -> an issue (red in the development tree), unless it says "User-invoked only";
 *   (b) an ENABLED plugin in <claudeHome>/settings.json enabledPlugins whose installed_plugins.json installPath does
 *       not exist (or that is not installed at all) -> red with the plugin name (how claude-mem broke silently);
 *   (c) a skill folder whose frontmatter name differs from its folder name -> a warning, never red.
 * Every fixture lives in its own os.tmpdir() folder and is removed at the end. The real ~/.claude is only READ
 * (one consistency test), never written. Harness: this project's own t/tFn + trailing "N passed, M failed" tally
 * (forge-doctor runTests reads that line; node:test output has no such line and would count as 0 passed).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const S = require('./doctor/checks-ship.cjs');

let pass = 0, fail = 0;
const tFn = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skillwiring-'));
let seq = 0;
const wf = (base, rel, body) => { const p = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
/** project(skills, {dev}) — a throwaway project root with .claude/skills/<folder>/SKILL.md per entry. */
function project(skills, opts) {
  const root = path.join(TMP, 'p' + (++seq));
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  if (!opts || opts.dev !== false) wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  for (const [folder, fm] of Object.entries(skills)) wf(root, '.claude/skills/' + folder + '/SKILL.md', '---\n' + fm + '\n---\n\n# ' + folder + '\n');
  return root;
}
/** home({enabled, installed}) — a throwaway Claude home: settings.json enabledPlugins + plugins/installed_plugins.json.
 *  installed: {id: true (path exists) | false (path missing)}; an id absent from `installed` is not installed at all. */
function home(enabled, installed, opts) {
  const h = path.join(TMP, 'h' + (++seq));
  fs.mkdirSync(h, { recursive: true });
  if (!opts || opts.settings !== false) wf(h, 'settings.json', JSON.stringify({ env: { NOT_A_SECRET: 'x' }, enabledPlugins: enabled }, null, 2));
  const plugins = {};
  for (const [id, exists] of Object.entries(installed || {})) {
    const p = path.join(h, 'plugins', 'cache', id.replace(/[@]/g, '_'), '1.0.0');
    if (exists) fs.mkdirSync(p, { recursive: true });
    plugins[id] = [{ scope: 'user', installPath: p, version: '1.0.0' }];
  }
  wf(h, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins }, null, 2));
  return h;
}
const EMPTY_HOME = home({}, {});
const sfc = (root, extra) => S.skillFrontmatterCheck(root, Object.assign({ qualityModule: null, claudeHome: EMPTY_HOME }, extra || {}));
const issuesOf = (r, id) => ((r.skills.find((s) => s.skill === id) || {}).issues || []);

// ---- (a) "Use when" + disable-model-invocation: true ----
tFn('(a) RED: "Use when ..." + disable-model-invocation: true is an issue and turns skill_frontmatter red in the dev tree', () => {
  const root = project({ 'dmi-when': 'name: dmi-when\ndescription: "Does X. Use when a run feels stalled."\ndisable-model-invocation: true' });
  const r = sfc(root);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.ok(r.failing.includes('dmi-when'), JSON.stringify(r.failing));
  assert.ok(issuesOf(r, 'dmi-when').some((i) => /disable-model-invocation/.test(i) && /never auto-trigger/.test(i)), JSON.stringify(issuesOf(r, 'dmi-when')));
});
tFn('(a) RED: "Use before" and "Use after" and "Use during" trip it too (case-insensitive)', () => {
  const root = project({
    'dmi-before': 'name: dmi-before\ndescription: "Runs it. Use before shipping."\ndisable-model-invocation: true',
    'dmi-after': 'name: dmi-after\ndescription: "Runs it. use after a merge."\ndisable-model-invocation: true',
    'dmi-during': 'name: dmi-during\ndescription: "Runs it. Use during multi-agent runs."\ndisable-model-invocation: true',
  });
  const r = sfc(root);
  for (const id of ['dmi-before', 'dmi-after', 'dmi-during']) assert.ok(r.failing.includes(id), id + ' not failing: ' + JSON.stringify(r.failing));
});
tFn('(a) RED: a "Use when" in when_to_use counts as well', () => {
  const root = project({ 'dmi-wtu': 'name: dmi-wtu\ndescription: "Does X."\nwhen_to_use: "Use when Y."\ndisable-model-invocation: true' });
  assert.ok(sfc(root).failing.includes('dmi-wtu'));
});
tFn('(a) GREEN: "User-invoked only: /x" with the flag is fine', () => {
  const root = project({ 'dmi-user': 'name: dmi-user\ndescription: "User-invoked only: /dmi-user. Does X; manual because it is slow."\ndisable-model-invocation: true' });
  const r = sfc(root);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(issuesOf(r, 'dmi-user'), []);
});
tFn('(a) GREEN: "Use when" without the flag, or with disable-model-invocation: false, is fine', () => {
  const root = project({
    'auto-when': 'name: auto-when\ndescription: "Does X. Use when Y."',
    'auto-false': 'name: auto-false\ndescription: "Does X. Use when Y."\ndisable-model-invocation: false',
  });
  const r = sfc(root);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
tFn('(a) GREEN: the flag with a description that has no trigger phrase (grill-me style) is fine; "User" is not "Use "', () => {
  const root = project({ 'manual': 'name: manual\ndescription: "A relentless interview. User asks for it."\ndisable-model-invocation: true' });
  assert.strictEqual(sfc(root).ok, true);
});
tFn('(a) outside the development tree the issue is listed but never red (skill_frontmatter contract)', () => {
  const root = project({ 'dmi-when': 'name: dmi-when\ndescription: "Use when Y."\ndisable-model-invocation: true' }, { dev: false });
  const r = sfc(root);
  assert.strictEqual(r.ok, true);
  assert.ok(r.failing.includes('dmi-when'));
});

// ---- (c) frontmatter name differs from the folder name ----
tFn('(c) WARN: a name that differs from its folder is a warning, not an issue, and never red', () => {
  const root = project({ 'folder-a': 'name: other-name\ndescription: "Does X. Use when Y."' });
  const r = sfc(root);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(!r.failing.includes('folder-a'));
  const e = r.skills.find((s) => s.skill === 'folder-a');
  assert.ok(e && Array.isArray(e.warnings) && e.warnings.some((w) => /other-name/.test(w) && /folder-a/.test(w)), JSON.stringify(e));
  assert.ok(Array.isArray(r.warnings) && r.warnings.some((w) => /^folder-a: /.test(w)), JSON.stringify(r.warnings));
});
tFn('(c) a matching (or quoted matching) name gives no warning', () => {
  const root = project({ 'same': 'name: same\ndescription: "Does X."', 'quoted': 'name: "quoted"\ndescription: "Does X."' });
  const r = sfc(root);
  assert.deepStrictEqual(r.warnings, []);
});

// ---- (b) enabled plugin whose installPath is missing ----
tFn('(b) RED: an enabled plugin whose installPath is missing is named; disabled and present ones are not', () => {
  const h = home({ 'good@m': true, 'broken@m': true, 'off@m': false }, { 'good@m': true, 'broken@m': false, 'off@m': false });
  const r = S.pluginInstallCheck({ claudeHome: h });
  assert.strictEqual(r.applicable, true);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.deepStrictEqual(r.missing.map((m) => m.plugin), ['broken@m']);
  assert.ok(/broken@m/.test(r.reason) && /installPath/.test(r.reason), r.reason);
  assert.deepStrictEqual(r.enabled.slice().sort(), ['broken@m', 'good@m']);
});
tFn('(b) RED: an enabled plugin that is not in installed_plugins.json at all is named too', () => {
  const r = S.pluginInstallCheck({ claudeHome: home({ 'ghost@m': true }, {}) });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing.map((m) => m.plugin), ['ghost@m']);
  assert.ok(/not installed/.test(r.missing[0].reason), r.missing[0].reason);
});
tFn('(b) GREEN: every enabled plugin present -> ok', () => {
  const r = S.pluginInstallCheck({ claudeHome: home({ 'a@m': true, 'b@m': true }, { 'a@m': true, 'b@m': true }) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.missing, []);
});
tFn('(b) no settings.json -> not applicable, ok (nothing enabled to check)', () => {
  const r = S.pluginInstallCheck({ claudeHome: home({}, {}, { settings: false }) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applicable, false);
});
tFn('(b) the report never carries settings.json content other than plugin ids', () => {
  const r = S.pluginInstallCheck({ claudeHome: home({ 'x@m': true }, {}) });
  assert.ok(!/NOT_A_SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
});
tFn('(b) RED through skill_frontmatter in the dev tree; the plugin name is in the reason', () => {
  const root = project({ 'fine': 'name: fine\ndescription: "Does X."' });
  const r = S.skillFrontmatterCheck(root, { qualityModule: null, claudeHome: home({ 'claude-mem@thedotmack': true }, { 'claude-mem@thedotmack': false }) });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.ok(r.plugins && r.plugins.ok === false);
  assert.ok(/claude-mem@thedotmack/.test(r.reason), r.reason);
});
tFn('(b) outside the development tree a broken plugin is reported but never red', () => {
  const root = project({ 'fine': 'name: fine\ndescription: "Does X."' }, { dev: false });
  const r = S.skillFrontmatterCheck(root, { qualityModule: null, claudeHome: home({ 'x@m': true }, { 'x@m': false }) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plugins.ok, false);
});
tFn('(b) a foreign root without an explicit claudeHome never reads the real machine plugins (hermetic fixtures)', () => {
  const root = project({ 'fine': 'name: fine\ndescription: "Does X."' });
  const r = S.skillFrontmatterCheck(root, { qualityModule: null });
  assert.strictEqual(r.plugins.applicable, false, JSON.stringify(r.plugins));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

// ---- rework 2026-11-04: a switched-off plugin whose install is gone is a WARNING; the report line says what ran ----
tFn('(b) WARN: a switched-off plugin with a gone installPath is listed as disabled_stale, never red', () => {
  const h = home({ 'claude-mem@thedotmack': false, 'ok@m': true, 'offok@m': false }, { 'claude-mem@thedotmack': false, 'ok@m': true, 'offok@m': true });
  const r = S.pluginInstallCheck({ claudeHome: h });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.disabled_stale, ['claude-mem@thedotmack']);
  assert.ok(r.warnings.length === 1 && /claude-mem@thedotmack/.test(r.warnings[0]) && /installPath is gone/.test(r.warnings[0]), JSON.stringify(r.warnings));
  const root = project({ 'fine': 'name: fine\ndescription: "Does X."' });
  assert.strictEqual(S.skillFrontmatterCheck(root, { qualityModule: null, claudeHome: h }).ok, true);
});
const R = require('./doctor/report.cjs');
const STUB_CHECKS = {
  node_check: { ok: true, total: 0 }, tests: { ok: true, suites: 0, passed: 0, failed: 0, perSuite: [] },
  strict_events: { ok: true, known_accepted: 0, unknown_rejected: 0 }, dashboard_spa: { ok: true, present: [] },
  leak_scan: { ok: true, scanned: 0, source: 'stub', hits: [] },
};
const sfLine = (sf) => R.printSummary({ root: 'stub', ok: sf.ok, checks: Object.assign({}, STUB_CHECKS, { skill_frontmatter: sf }), advisory: {} }).split('\n').find((l) => /skill frontmatter/.test(l)) || '';
tFn('report: a clean skill frontmatter line says how many enabled plugins were checked and names a switched-off stale one', () => {
  const root = project({ 'fine': 'name: fine\ndescription: "Does X."' });
  const h = home({ 'claude-mem@thedotmack': false, 'a@m': true, 'b@m': true }, { 'claude-mem@thedotmack': false, 'a@m': true, 'b@m': true });
  const l = sfLine(S.skillFrontmatterCheck(root, { qualityModule: null, claudeHome: h }));
  assert.ok(/^\s*✓ skill frontmatter/.test(l), l);
  assert.ok(/2 enabled plugin\(s\) installed/.test(l), l);
  assert.ok(/WARN 1 switched-off plugin\(s\) with a missing install: claude-mem@thedotmack/.test(l), l);
});
tFn('report: an enabled plugin with a gone install prints a red skill frontmatter line that names it', () => {
  const root = project({ 'fine': 'name: fine\ndescription: "Does X."' });
  const l = sfLine(S.skillFrontmatterCheck(root, { qualityModule: null, claudeHome: home({ 'claude-mem@thedotmack': true }, { 'claude-mem@thedotmack': false }) }));
  assert.ok(/^\s*✗ skill frontmatter/.test(l), l);
  assert.ok(/claude-mem@thedotmack \(installPath missing\)/.test(l), l);
  assert.ok(!/enabled plugin\(s\) installed/.test(l), l);
});

// ---- the real tree (read-only) ----
const REAL_ROOT = path.resolve(__dirname, '..', '..');
tFn('real tree: none of the 7 A7 skills (or any other project skill) combines a trigger phrase with disable-model-invocation', () => {
  const r = S.skillFrontmatterCheck(REAL_ROOT, { qualityModule: null, claudeHome: EMPTY_HOME });
  const hits = r.skills.filter((s) => s.issues.some((i) => /never auto-trigger/.test(i))).map((s) => s.skill);
  assert.deepStrictEqual(hits, []);
  for (const id of ['forge-doctor', 'forge-docdrift', 'forge-heartbeat', 'forge-mindmap', 'forge-projectbrain', 'forge-registry', 'forge-snapshot']) {
    assert.ok(r.skills.some((s) => s.skill === id), id + ' not checked');
  }
});
tFn('real machine (read-only): pluginInstallCheck agrees with an independent read of installed_plugins.json', () => {
  const h = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const r = S.pluginInstallCheck({});
  let settings = null, installed = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(h, 'settings.json'), 'utf8')); } catch { settings = null; }
  try { installed = JSON.parse(fs.readFileSync(path.join(h, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { installed = {}; }
  const enabled = Object.entries((settings && settings.enabledPlugins) || {}).filter(([, v]) => v === true).map(([k]) => k);
  const expectMissing = enabled.filter((id) => !(installed[id] || []).some((rec) => rec && rec.installPath && fs.existsSync(rec.installPath))).sort();
  assert.deepStrictEqual(r.missing.map((m) => m.plugin).sort(), expectMissing);
  const off = Object.entries((settings && settings.enabledPlugins) || {}).filter(([, v]) => v === false).map(([k]) => k);
  const expectStale = off.filter((id) => (installed[id] || []).some((rec) => rec && rec.installPath) && !(installed[id] || []).some((rec) => rec && rec.installPath && fs.existsSync(rec.installPath))).sort();
  assert.deepStrictEqual((r.disabled_stale || []).slice().sort(), expectStale);
  console.log('  info real machine: enabled=' + enabled.length + ' missing=' + (expectMissing.join(',') || 'none') + ' switched-off-stale=' + (expectStale.join(',') || 'none'));
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort: os temp */ }
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
