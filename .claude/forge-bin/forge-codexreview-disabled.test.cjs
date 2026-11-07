#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview-disabled.test.cjs — Codex is OFF by default (owner 2026-11-01, WP A5: no Codex account,
 * the gpt-6-astra pin was refused). Proves that the SHIPPED config resolves to disabled, that the switch is
 * fail-closed, that only a strict boolean in the never-shipped user file turns it on, and that an explicit `run`
 * prints a visible notice.
 * Rework (Review Boss FAIL, same day): the default-flow proof is now the REAL /forge step-10 decision —
 * decideFlow() reading the real schema default through forge-config.cjs plus effectiveConfig()/isEnabled() on a
 * shipped-only fixture — and a mutant check inside this file proves the proof goes red when the schema default
 * is `auto` or when the shipped review.enabled is `true` (temp copies only; the real files are never written).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const CR = require(path.join(__dirname, 'forge-codexreview-config.cjs'));
const CLI = path.join(__dirname, 'forge-codexreview-config.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const SHIPPED = path.join(ROOT, '.claude', 'config', 'orchestration', 'codex-review.json');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

/** A temp project root holding a copy of the REAL shipped codex-review.json and, optionally, a user file. */
function fixtureRoot(shippedObj, userObj) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-disabled-'));
  const dir = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-review.json'), JSON.stringify(shippedObj));
  if (userObj !== undefined) fs.writeFileSync(path.join(dir, 'codex-review.user.json'), JSON.stringify(userObj));
  return root;
}
const realShipped = () => JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));

console.log('forge-codexreview-disabled tests');

t('the real shipped codex-review.json carries review.enabled === false', () => {
  assert.strictEqual(realShipped().review.enabled, false);
});

t('the shipped config alone (no user file) resolves to DISABLED via effectiveConfig() + isEnabled()', () => {
  const root = fixtureRoot(realShipped());
  try {
    const eff = CR.effectiveConfig(root);
    assert.ok(eff, 'effectiveConfig returned null');
    assert.strictEqual(CR.isEnabled(eff), false);
    assert.deepStrictEqual(eff._warnings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('fail-closed: a shipped config with no enabled key, or a non-boolean one, is DISABLED', () => {
  for (const val of [undefined, null, 'true', 1, 'yes']) {
    const s = realShipped();
    if (val === undefined) delete s.review.enabled; else s.review.enabled = val;
    const root = fixtureRoot(s);
    try { assert.strictEqual(CR.isEnabled(CR.effectiveConfig(root)), false, 'enabled=' + JSON.stringify(val)); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  assert.strictEqual(CR.isEnabled(null), false);
  assert.strictEqual(CR.isEnabled({}), false);
});

t('a user file with {"review":{"enabled":true}} turns it ON for that account only, with no warning', () => {
  const root = fixtureRoot(realShipped(), { review: { enabled: true } });
  try {
    const eff = CR.effectiveConfig(root);
    assert.strictEqual(CR.isEnabled(eff), true);
    assert.deepStrictEqual(eff._warnings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('a non-boolean user review.enabled is ignored with a warning and stays DISABLED', () => {
  const root = fixtureRoot(realShipped(), { review: { enabled: 'true' } });
  try {
    const eff = CR.effectiveConfig(root);
    assert.strictEqual(CR.isEnabled(eff), false);
    assert.ok(eff._warnings.some((w) => /review\.enabled/.test(w)), JSON.stringify(eff._warnings));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('the user file can still not loosen the sandbox while it enables Codex', () => {
  const root = fixtureRoot(realShipped(), { review: { enabled: true, sandbox: 'danger-full-access' } });
  try {
    const eff = CR.effectiveConfig(root);
    const argv = CR.buildCommand(eff, {});
    assert.strictEqual(argv[argv.indexOf('-s') + 1], 'read-only');
    assert.ok(eff._warnings.some((w) => /review\.sandbox/.test(w)), JSON.stringify(eff._warnings));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('CLI "run --dry-run --root <shipped-only fixture>" prints the disabled NOTICE on stderr and spawns nothing', () => {
  const root = fixtureRoot(realShipped());
  try {
    const r = spawnSync(process.execPath, [CLI, 'run', '--dry-run', '--json', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/NOTICE/.test(r.stderr) && /disabled by default/.test(r.stderr), 'stderr: ' + r.stderr);
    assert.strictEqual(JSON.parse(r.stdout.trim()).dry_run, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('CLI "run --dry-run" with the account switch ON prints no disabled NOTICE', () => {
  const root = fixtureRoot(realShipped(), { review: { enabled: true } });
  try {
    const r = spawnSync(process.execPath, [CLI, 'run', '--dry-run', '--json', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/disabled by default/.test(r.stderr), 'stderr: ' + r.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- the REAL /forge step-10 decision (Review Boss rework) ----
const SCHEMA = path.join(ROOT, '.claude', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json');
const realSchema = () => JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));

/** decideIn({schema, shipped, user, flags}) -> decideFlow() on a throw-away project: a copy of the given schema,
 *  the given codex-review.json (+ optional user file), an EMPTY config home (so the machine's own global
 *  FORGE_CONFIG.json never leaks in) and no project FORGE_CONFIG.json. The real readers do the work. */
function decideIn(o) {
  const root = fixtureRoot(o.shipped, o.user);
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const schemaPath = path.join(root, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(o.schema));
    const configOpts = { projectRoot: root, configHome: home, schemaPath };
    if (o.flags) configOpts.flags = o.flags;
    return CR.decideFlow({ root, configOpts, requested: o.requested === true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const notDispatched = (d, reasonRe) => {
  assert.strictEqual(d.dispatch, false, JSON.stringify(d));
  assert.strictEqual(d.state, 'NOT INVOKED');
  assert.strictEqual(d.unlock_diagnosis, false, 'no unlock diagnosis when Codex is switched off');
  assert.ok(/^FALLBACK \(non-independent\) review — Codex did not run because: /.test(d.fallback), d.fallback);
  assert.ok(reasonRe.test(d.reason), d.reason);
};

/** checkDefaultFlow(schema, shipped) throws unless the shipped default flow never dispatches codex-reviewer AND
 *  each switch alone keeps it off. This is the assertion the mutants below must turn red. */
function checkDefaultFlow(schema, shipped) {
  const d0 = decideIn({ schema, shipped });
  assert.strictEqual(d0.config_source, 'default', 'the schema default must be read for real, not a degraded fallback');
  assert.strictEqual(d0.config_value, 'off', 'schema default of codex-review');
  notDispatched(d0, /disabled by owner 2026-11-01/);
  // the config key alone: an account that turned review.enabled on still gets no Codex while the key is off
  notDispatched(decideIn({ schema, shipped, user: { review: { enabled: true } } }), /config codex-review=off/);
  // review.enabled alone: the key forced to auto (a run flag, never written) still gets no Codex
  notDispatched(decideIn({ schema, shipped, flags: { 'codex-review': 'auto' } }), /^disabled by owner 2026-11-01/);
}

t('REAL decision: shipped schema default + shipped codex-review.json -> no codex-reviewer dispatch, NOT INVOKED, ECC FALLBACK, no unlock diagnosis', () => {
  checkDefaultFlow(realSchema(), realShipped());
});

t('MUTANT: the same check goes RED when the schema default of codex-review is auto (temp copy)', () => {
  const s = realSchema();
  s.settings['codex-review'].default = 'auto';
  assert.throws(() => checkDefaultFlow(s, realShipped()), assert.AssertionError);
});

t('MUTANT: the same check goes RED when the shipped review.enabled is true (temp copy)', () => {
  const sh = realShipped();
  sh.review.enabled = true;
  assert.throws(() => checkDefaultFlow(realSchema(), sh), assert.AssertionError);
});

t('both switches on: auto dispatches (important code only); on-request only when the owner asked', () => {
  const user = { review: { enabled: true } };
  const auto = decideIn({ schema: realSchema(), shipped: realShipped(), user, flags: { 'codex-review': 'auto' } });
  assert.deepStrictEqual([auto.dispatch, auto.state, auto.scope], [true, 'PLANNED', 'important code only']);
  const notAsked = decideIn({ schema: realSchema(), shipped: realShipped(), user, flags: { 'codex-review': 'on-request' } });
  notDispatched(notAsked, /on-request and the owner did not ask/);
  const asked = decideIn({ schema: realSchema(), shipped: realShipped(), user, flags: { 'codex-review': 'on-request' }, requested: true });
  assert.strictEqual(asked.dispatch, true);
});

t('flowDecision is fail-closed: an unknown config value counts as off', () => {
  const on = { review: { enabled: true }, fallback: realShipped().fallback };
  for (const v of [undefined, null, 'on', 'AUTO', true]) notDispatched(CR.flowDecision(v, on), /config codex-review=off/);
});

t('CLI "decide --json --root <shipped-only fixture>" (empty config home) reports dispatch:false and exits 0', () => {
  const root = fixtureRoot(realShipped());
  try {
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    const env = Object.assign({}, process.env, { FORGE_CONFIG_HOME: home });
    const r = spawnSync(process.execPath, [CLI, 'decide', '--json', '--root', root], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout.trim());
    notDispatched(d, /disabled by owner 2026-11-01/);
    assert.strictEqual(d.config_value, 'off');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('a user file that tries to override a locked section gets a warning naming all three overridable fields', () => {
  const root = fixtureRoot(realShipped(), { naming: { step_label: 'x' } });
  try {
    const w = CR.effectiveConfig(root)._warnings.join(' | ');
    assert.ok(/review\.model/.test(w) && /review\.reasoning_effort/.test(w) && /review\.enabled/.test(w), w);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('docs: codex-reviewer.md names review.model, review.reasoning_effort AND review.enabled (strict boolean) as overridable', () => {
  const md = fs.readFileSync(path.join(ROOT, '.claude', 'agents', 'codex-reviewer.md'), 'utf8');
  assert.ok(/may override ONLY `review\.model`,\s*`review\.reasoning_effort` and `review\.enabled`/.test(md));
  assert.ok(/strict boolean/.test(md));
});

t('docs: codex-review.json _naming_doc and _fallback_doc carry the dated 2026-11-01 update', () => {
  const s = realShipped();
  assert.ok(/Updated 2026-11-01:.*ECC/.test(s.naming._naming_doc), 'naming');
  assert.ok(/Updated 2026-11-01:.*planned review step.*FALLBACK label/.test(s.fallback._fallback_doc), 'fallback');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
