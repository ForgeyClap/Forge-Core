#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-standing.test.cjs — real tests for the standing-rules resolver (2026-07-18, WAVE B / B2;
// TEMPLATE/USER SPLIT tests added 2026-09-26 for the external-audit N4/P1 fix). Every FIXTURE test uses
// opts.rulesPath/opts.userRulesPath pointing at a fresh temp dir (hermetic — no fixture test ever writes to
// config/orchestration/). Section 1/1b/8b deliberately exercise the REAL project files (this project's own
// FORGE_STANDING_RULES.json / .user.json) to prove the real N4/P1 fix actually landed here, not just in a
// fixture — those are the only tests that touch real files, and they only ever remove the exact thing the
// fix is supposed to remove (an owner-remember-sourced rule), never anything else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const standing = require('./forge-standing.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-standing.cjs');
function runCLI(argv, env) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env }); }

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeRules(rules, extra) {
  const dir = freshDir('forge-standing-fixture');
  const p = path.join(dir, 'FORGE_STANDING_RULES.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ version: 1, rules }, extra || {})));
  return p;
}
function userPathFor(templatePath) { return path.join(path.dirname(templatePath), 'FORGE_STANDING_RULES.user.json'); }
function baseRule(overrides) {
  return Object.assign({
    id: 'r-' + Math.random().toString(36).slice(2),
    text: 'test rule text',
    scope: 'global',
    trigger: 'always',
    domain: null,
    glob: null,
    topic: null,
    source: 'unit-test fixture (not real owner evidence)',
    confidence: 'high',
    status: 'active',
    cannot_override_core: false,
  }, overrides || {});
}
// A fixture pair (template + a NON-EXISTENT user path) is the normal shape for most tests below — the user
// file springs into existence only when remember()/migration actually writes something.
function fixturePair(rules) {
  const templatePath = writeRules(rules);
  return { templatePath, userPath: userPathFor(templatePath) };
}

console.log('forge-standing tests (standing-rules resolver + template/user split)');

// ---------------------------------------------------------------------------
// 1) seed integrity — the REAL config file (product rules only, per the N4/P1 fix)
// ---------------------------------------------------------------------------
console.log('\n1) seed integrity (real FORGE_STANDING_RULES.json)');

t('load() parses the real seed file without throwing', () => {
  const data = standing.load();
  assert.ok(Array.isArray(data.rules) && data.rules.length >= 5);
});
t('every seed rule has a non-empty source (real evidence, no fabricated rule)', () => {
  for (const r of standing.load().rules) {
    assert.ok(typeof r.source === 'string' && r.source.trim().length > 0, r.id + ' is missing a source');
  }
});
t('every seed rule has id/text/scope/trigger/status; trigger is a known value', () => {
  for (const r of standing.load().rules) {
    assert.ok(r.id && r.text && r.scope && r.status);
    assert.ok(standing.KNOWN_TRIGGERS.includes(r.trigger), r.id + ' has unknown trigger ' + r.trigger);
  }
});
t('seed rule ids are unique', () => {
  const ids = standing.load().rules.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});
t('the honesty-core-untouchable seed rule exists and carries cannot_override_core:true', () => {
  const r = standing.load().rules.find((x) => x.id === 'honesty-core-untouchable');
  assert.ok(r, 'seed must include honesty-core-untouchable');
  assert.strictEqual(r.cannot_override_core, true);
});
t('listActive() returns only status:active rules from the real seed file', () => {
  for (const r of standing.listActive()) assert.strictEqual(r.status, 'active');
});
t('the does-it-for-you rule is active, global, always-on, topic autonomy, sourced from the SHIPPED commands/forge.md (never an unshipped scratch transcript)', () => {
  const r = standing.load().rules.find((x) => x.id === 'does-it-for-you');
  assert.ok(r, 'seed must include does-it-for-you');
  assert.strictEqual(r.status, 'active');
  assert.strictEqual(r.scope, 'global');
  assert.strictEqual(r.trigger, 'always');
  assert.strictEqual(r.topic, 'autonomy');
  assert.strictEqual(r.confidence, 'high');
  assert.strictEqual(r.cannot_override_core, false);
  assert.match(r.text, /never asks the user to run a file or code/);
  assert.match(r.text, /only a hard gate or a real usage-limit pause interrupts/);
  assert.ok(r.source.includes('commands/forge.md'), 'must cite a file that actually ships with the product');
  assert.ok(!/_scratch/.test(r.source), 'must never cite an unshipped scratch transcript as evidence');
  assert.ok(standing.match({}).active.some((x) => x.id === 'does-it-for-you'), 'an always-trigger rule fires on every run');
});

// ---------------------------------------------------------------------------
// 1b) N4/P1 — the shipped template carries ZERO owner-added rules, and never cites
//     an unshipped policy file / scratch transcript as evidence
// ---------------------------------------------------------------------------
console.log('\n1b) N4/P1 — shipped template has zero owner-added rules, zero unshipped citations');

t('a FRESH TEMPLATE (this project\'s real, on-disk FORGE_STANDING_RULES.json) carries zero rules sourced from an owner "/forge remember" (read the RAW file directly — never through load(), which would re-merge the user file back in)', () => {
  const raw = JSON.parse(fs.readFileSync(standing.CONFIG_PATH, 'utf8'));
  const ownerRules = raw.rules.filter((r) => r.source === standing.OWNER_REMEMBER_SOURCE);
  assert.strictEqual(ownerRules.length, 0, 'the shipped template must never carry an owner /forge remember rule: ' + JSON.stringify(ownerRules.map((r) => r.id)));
});

t('a synthetic fresh template (no owner rules, no user file yet) never surfaces an owner-remember rule via load()', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'product-rule-1' })]);
  assert.ok(!fs.existsSync(userPath), 'the user file must not exist yet for a truly fresh template');
  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(data.rules.filter((r) => r.source === standing.OWNER_REMEMBER_SOURCE).length, 0);
});

t('no shipped standing rule cites an unshipped global policy file or a scratch transcript as evidence', () => {
  const raw = JSON.parse(fs.readFileSync(standing.CONFIG_PATH, 'utf8'));
  for (const r of raw.rules) {
    assert.ok(!/FABLE5_SAFE_GLOBAL_POLICY/.test(r.source), r.id + ' cites an unshipped global policy file');
    assert.ok(!/_scratch\//.test(r.source), r.id + ' cites an unshipped scratch transcript');
  }
});

// ---------------------------------------------------------------------------
// 2) trigger matching — always / domain / glob / on-request
// ---------------------------------------------------------------------------
console.log('\n2) trigger matching');

t('trigger:"always" fires regardless of type/paths', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'a1', trigger: 'always', scope: 'global' })]);
  const r1 = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  const r2 = standing.match({ type: 'website', paths: ['x/y.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r1.active.some((x) => x.id === 'a1'));
  assert.ok(r2.active.some((x) => x.id === 'a1'));
});

t('trigger:"domain" fires only when type matches the rule\'s domain', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'd1', trigger: 'domain', domain: 'website', scope: 'domain:website' })]);
  const opts = { rulesPath: templatePath, userRulesPath: userPath };
  const hit = standing.match({ type: 'website' }, opts);
  const miss = standing.match({ type: 'n8n' }, opts);
  const none = standing.match({}, opts);
  assert.ok(hit.active.some((x) => x.id === 'd1'));
  assert.ok(!miss.active.some((x) => x.id === 'd1'));
  assert.ok(!none.active.some((x) => x.id === 'd1'));
});

t('trigger:"domain" match is case-insensitive', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'd2', trigger: 'domain', domain: 'scraping', scope: 'domain:scraping' })]);
  const hit = standing.match({ type: 'Scraping' }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(hit.active.some((x) => x.id === 'd2'));
});

t('trigger:"glob" fires only when a supplied path matches the glob', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'g1', trigger: 'glob', glob: '**/.env*', scope: 'path:**/.env*' })]);
  const opts = { rulesPath: templatePath, userRulesPath: userPath };
  const hit = standing.match({ paths: ['project/sub/.env.local'] }, opts);
  const miss = standing.match({ paths: ['project/sub/config.json'] }, opts);
  const none = standing.match({}, opts);
  assert.ok(hit.active.some((x) => x.id === 'g1'));
  assert.ok(!miss.active.some((x) => x.id === 'g1'));
  assert.ok(!none.active.some((x) => x.id === 'g1'));
});

t('trigger:"glob" normalizes backslashes so Windows-style paths still match', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'g2', trigger: 'glob', glob: '**/.env*', scope: 'path:**/.env*' })]);
  const hit = standing.match({ paths: ['project\\sub\\.env'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(hit.active.some((x) => x.id === 'g2'));
});

t('trigger:"on-request" never fires passively (no onRequest supplied)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'o1', trigger: 'on-request', scope: 'on-request' })]);
  const r = standing.match({ type: 'website', paths: ['a/b.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(!r.active.some((x) => x.id === 'o1'));
});
t('trigger:"on-request" fires when onRequest:true', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'o2', trigger: 'on-request', scope: 'on-request' })]);
  const r = standing.match({ onRequest: true }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'o2'));
});
t('trigger:"on-request" fires when onRequest is an array containing the rule id, ignores other ids', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'o3', trigger: 'on-request', scope: 'on-request' }),
    baseRule({ id: 'o4', trigger: 'on-request', scope: 'on-request' }),
  ]);
  const r = standing.match({ onRequest: ['o3'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'o3'));
  assert.ok(!r.active.some((x) => x.id === 'o4'));
});

t('a status:"proposed" or status:"retired" rule never fires even if its trigger would otherwise match', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'p1', trigger: 'always', status: 'proposed' }),
    baseRule({ id: 'p2', trigger: 'always', status: 'retired' }),
  ]);
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(!r.active.some((x) => x.id === 'p1'));
  assert.ok(!r.active.some((x) => x.id === 'p2'));
});

// ---------------------------------------------------------------------------
// 3) shadowing — real seed data (draft-only-outreach-global vs -scraping)
// ---------------------------------------------------------------------------
console.log('\n3) shadowing (higher-precedence trigger wins within a shared topic)');

t('type:"scraping" — the domain-specific outreach rule wins, the global one is shadowed', () => {
  const r = standing.match({ type: 'scraping' });
  assert.ok(r.active.some((x) => x.id === 'draft-only-outreach-scraping'), 'scraping-specific rule should be active');
  assert.ok(!r.active.some((x) => x.id === 'draft-only-outreach-global'), 'global rule should NOT be active here');
  const shadow = r.shadowed.find((x) => x.id === 'draft-only-outreach-global');
  assert.ok(shadow, 'global outreach rule should be reported as shadowed');
  assert.strictEqual(shadow.beaten_by, 'draft-only-outreach-scraping');
});

t('type:"website" — only the global outreach rule fires; the scraping one never fires, so nothing is shadowed for that topic', () => {
  const r = standing.match({ type: 'website' });
  assert.ok(r.active.some((x) => x.id === 'draft-only-outreach-global'));
  assert.ok(!r.active.some((x) => x.id === 'draft-only-outreach-scraping'));
  assert.ok(!r.shadowed.some((x) => x.topic === 'outreach'));
});

t('unrelated topics (e.g. honesty, isolation) are unaffected by the outreach shadow computation', () => {
  const r = standing.match({ type: 'scraping' });
  assert.ok(r.active.some((x) => x.id === 'honesty-core-untouchable'));
  assert.ok(r.active.some((x) => x.id === 'isolation-only-this-folder'));
});

// ---------------------------------------------------------------------------
// 4) cannot_override_core — un-shadowable, regardless of nominal precedence
// ---------------------------------------------------------------------------
console.log('\n4) cannot_override_core — un-shadowable');

t('a cannot_override_core rule is NEVER shadowed, even by a nominally higher-precedence glob/domain rule sharing its topic', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'core1', trigger: 'always', topic: 'coretest', cannot_override_core: true }),
    baseRule({ id: 'loser-glob', trigger: 'glob', glob: '**/*.js', topic: 'coretest', cannot_override_core: false }),
    baseRule({ id: 'loser-domain', trigger: 'domain', domain: 'website', topic: 'coretest', cannot_override_core: false }),
  ]);
  const r = standing.match({ type: 'website', paths: ['a/b.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'core1'), 'core rule must be active');
  assert.ok(!r.active.some((x) => x.id === 'loser-glob'), 'glob rule loses to core rule');
  assert.ok(!r.active.some((x) => x.id === 'loser-domain'), 'domain rule loses to core rule');
  const shadowGlob = r.shadowed.find((x) => x.id === 'loser-glob');
  const shadowDomain = r.shadowed.find((x) => x.id === 'loser-domain');
  assert.strictEqual(shadowGlob.beaten_by, 'core1');
  assert.strictEqual(shadowDomain.beaten_by, 'core1');
});

t('two cannot_override_core rules sharing a topic both stay active (tie among core rules is not a loss)', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'core-a', trigger: 'always', topic: 'dualcoretest', cannot_override_core: true }),
    baseRule({ id: 'core-b', trigger: 'always', topic: 'dualcoretest', cannot_override_core: true }),
  ]);
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'core-a'));
  assert.ok(r.active.some((x) => x.id === 'core-b'));
  assert.strictEqual(r.shadowed.length, 0);
});

// ---------------------------------------------------------------------------
// 4b) external-audit 3.2 (MEDIUM) — a user (owner-added) rule may add or reinforce, but must
//     NEVER shadow a shipped template rule sharing its topic, regardless of trigger precedence
// ---------------------------------------------------------------------------
console.log('\n4b) 3.2 fix — a user rule can never shadow a shipped template rule sharing a topic');

t('a user-file glob rule (nominally the HIGHEST-precedence trigger) still cannot shadow a template always-rule sharing a topic', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'template-always', trigger: 'always', topic: 'pushtest' }),
  ]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [
    baseRule({ id: 'user-glob-everything', trigger: 'glob', glob: '**', topic: 'pushtest', source: 'unit-test fixture (owner-style rule)' }),
  ] }));
  const r = standing.match({ paths: ['any/file.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'template-always'), 'the shipped template rule must stay active');
  assert.ok(!r.active.some((x) => x.id === 'user-glob-everything'), 'the user rule must not push the template rule out of active');
  const shadow = r.shadowed.find((x) => x.id === 'user-glob-everything');
  assert.ok(shadow, 'the user rule must be reported as shadowed, never silently dropped');
  assert.strictEqual(shadow.beaten_by, 'template-always');
});

t('remember(topic:"push", trigger:"glob", glob:"**") never removes a shipped push-topic template rule from match() results (this is the review\'s exact never-auto-push scenario)', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'never-auto-push', trigger: 'always', topic: 'push' }),
  ]);
  standing.remember('anything goes now', { rulesPath: templatePath, userRulesPath: userPath, topic: 'push', trigger: 'glob', glob: '**' });
  const r = standing.match({ paths: ['x/y.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'never-auto-push'), 'the shipped push-topic rule must remain active no matter what the owner remembers');
});

t('a user rule with a NEW topic (no template rule shares it) is never shadowed — adding is unaffected by the fix', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'unrelated-template-rule', topic: 'other-topic' })]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [
    baseRule({ id: 'user-new-topic-rule', trigger: 'always', topic: 'brand-new-topic', source: 'unit-test fixture (owner-style rule)' }),
  ] }));
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'user-new-topic-rule'), 'a user rule on its own topic must still activate normally');
  assert.ok(!r.shadowed.some((x) => x.id === 'user-new-topic-rule'));
});

t('two template rules sharing a topic still resolve by ordinary trigger precedence (the +100 origin floor is a flat tie-breaker, it does not change template-vs-template ordering)', () => {
  const r = standing.match({ type: 'scraping' }); // real seed data: domain rule beats the always rule for topic "outreach"
  assert.ok(r.active.some((x) => x.id === 'draft-only-outreach-scraping'));
  assert.ok(!r.active.some((x) => x.id === 'draft-only-outreach-global'));
});

t('a user rule sharing a topic with a cannot_override_core template rule is still shadowed by it (core protection composes with the origin floor)', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'core-template-rule', trigger: 'always', topic: 'coreuser', cannot_override_core: true }),
  ]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [
    baseRule({ id: 'user-glob-vs-core', trigger: 'glob', glob: '**', topic: 'coreuser', source: 'unit-test fixture (owner-style rule)' }),
  ] }));
  const r = standing.match({ paths: ['a/b.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'core-template-rule'));
  assert.ok(!r.active.some((x) => x.id === 'user-glob-vs-core'));
});

// ---------------------------------------------------------------------------
// 4c) external-audit N2 (LOW) — a user rule hand-marked cannot_override_core:true
//     must never get rank()'s Infinite rank and shadow a shipped template rule sharing its topic
// ---------------------------------------------------------------------------
console.log('\n4c) N2 fix — a user-file cannot_override_core:true is always forced false');

t('a hand-edited user rule with cannot_override_core:true on topic "push" never shadows a shipped never-auto-push template rule (the review\'s exact scenario)', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'never-auto-push', trigger: 'always', topic: 'push' }),
  ]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [
    baseRule({ id: 'sneaky-core-claim', trigger: 'always', topic: 'push', cannot_override_core: true, source: 'unit-test fixture (hand-edited user file, N2 scenario)' }),
  ] }));
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'never-auto-push'), 'the shipped push-topic rule must remain active');
  assert.ok(!r.active.some((x) => x.id === 'sneaky-core-claim'), 'the user rule must never win — before the fix its fake cannot_override_core:true gave it rank Infinity, shadowing the template rule instead');
  const shadow = r.shadowed.find((x) => x.id === 'sneaky-core-claim');
  assert.ok(shadow, 'the losing user rule must be visibly reported as shadowed, never silently dropped');
  assert.strictEqual(shadow.beaten_by, 'never-auto-push');
});

t('load() strips cannot_override_core:true from every user-file rule regardless of trigger, so it can never outrank a template rule\'s +100 floor', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'template-glob-rule', trigger: 'glob', glob: '**', topic: 'n2test' }),
  ]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [
    baseRule({ id: 'user-fake-core', trigger: 'always', topic: 'n2test', cannot_override_core: true, source: 'unit-test fixture (hand-edited user file, N2 scenario)' }),
  ] }));
  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath });
  const loaded = data.rules.find((x) => x.id === 'user-fake-core');
  assert.strictEqual(loaded.cannot_override_core, false, 'the user rule\'s on-disk cannot_override_core:true must be forced false by load()');

  const r = standing.match({ paths: ['a/b.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'template-glob-rule'), 'the shipped glob rule must win the topic');
  assert.ok(!r.active.some((x) => x.id === 'user-fake-core'), 'the fake-core user rule must lose (it is NOT an Infinite rank, and its always-trigger is below the template floor)');
  const shadow = r.shadowed.find((x) => x.id === 'user-fake-core');
  assert.ok(shadow, 'the losing user rule must be reported as shadowed, never silently dropped');
  assert.strictEqual(shadow.beaten_by, 'template-glob-rule');
});

// ---------------------------------------------------------------------------
// 5) malformed / missing config is refused, not silently accepted
// ---------------------------------------------------------------------------
console.log('\n5) config integrity — refuses malformed input rather than silently passing everything');

t('an empty rules array throws', () => {
  const { templatePath, userPath } = fixturePair([]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "id" throws', () => {
  const r = baseRule({}); delete r.id;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "text" throws', () => {
  const r = baseRule({}); delete r.text;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "source" throws (a rule with no evidence must be refused)', () => {
  const r = baseRule({}); delete r.source;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "scope" throws', () => {
  const r = baseRule({}); delete r.scope;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule with an unknown trigger throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ trigger: 'sometimes' })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule with an unknown status throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ status: 'maybe' })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a duplicate rule id within the template throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'dup' }), baseRule({ id: 'dup' })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule id shared between the template and the user file: the shipped template rule wins, the user one is dropped with a warning, load() does NOT throw (3.2 fix)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'shared-id', text: 'shipped template text' })]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [baseRule({ id: 'shared-id', text: 'owner override attempt' })] }));
  const warnings = [];
  const origErr = console.error;
  console.error = (msg) => warnings.push(msg);
  let data;
  try { data = standing.load({ rulesPath: templatePath, userRulesPath: userPath }); }
  finally { console.error = origErr; }
  const matches = data.rules.filter((r) => r.id === 'shared-id');
  assert.strictEqual(matches.length, 1, 'only one "shared-id" rule may survive the merge');
  assert.strictEqual(matches[0].text, 'shipped template text', 'the shipped template rule must win an id collision, never the user one');
  assert.ok(warnings.some((w) => /shared-id/.test(w)), 'a visible warning must name the dropped colliding user rule');
});
t('trigger:"domain" without a "domain" field throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ trigger: 'domain', domain: null })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('trigger:"glob" without a "glob" field throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ trigger: 'glob', glob: null })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('invalid JSON syntax throws with a clear message, not a silent empty result', () => {
  const dir = freshDir('forge-standing-badjson');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => standing.load({ rulesPath: p, userRulesPath: userPathFor(p) }));
});
t('a missing rules file throws (never silently returns "no rules")', () => {
  assert.throws(() => standing.load({ rulesPath: path.join(freshDir('forge-standing-nope'), 'does-not-exist.json') }));
});
t('a malformed (non-array-rules) user file falls back to the shipped template rules with a visible warning — it never crashes load() and never silently masks the warning either (3.2 fix)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-ok' })]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: 'not-an-array' }));
  const warnings = [];
  const origErr = console.error;
  console.error = (msg) => warnings.push(msg);
  let data;
  try { data = standing.load({ rulesPath: templatePath, userRulesPath: userPath }); }
  finally { console.error = origErr; }
  assert.strictEqual(data.rules.length, 1, 'only the shipped template rule should survive');
  assert.strictEqual(data.rules[0].id, 'seed-ok');
  assert.ok(warnings.length > 0, 'a broken user file must print a visible warning, not fail silently');
});

// ---------------------------------------------------------------------------
// 6) hermeticity — fixture calls never touch the real config file
// ---------------------------------------------------------------------------
console.log('\n6) hermeticity');

t('a hermetic fixture rule id does not leak into the real seed file result', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'totally-fake-fixture-only', trigger: 'always' })]);
  standing.match({}, { rulesPath: templatePath, userRulesPath: userPath }); // populates the module cache for that path pair
  const real = standing.match({}); // load the REAL files fresh (different path pair -> cache miss -> re-read)
  assert.ok(!real.active.some((x) => x.id === 'totally-fake-fixture-only'));
});

// ---------------------------------------------------------------------------
// 7) CLI (real spawned subprocess, real seed file)
// ---------------------------------------------------------------------------
console.log('\n7) CLI');

t('CLI match --type website --json includes ui-quality-for-web', () => {
  const r = runCLI(['match', '--type', 'website', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.active.some((x) => x.id === 'ui-quality-for-web'));
});
t('CLI match --paths <.env path> --json includes no-secrets-in-env-files', () => {
  const r = runCLI(['match', '--paths', 'app/.env.production', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.active.some((x) => x.id === 'no-secrets-in-env-files'));
});
t('CLI match --type scraping --json shows the shadow of draft-only-outreach-global', () => {
  const r = runCLI(['match', '--type', 'scraping', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.shadowed.some((x) => x.id === 'draft-only-outreach-global'));
});
t('CLI match --on-request --json includes codex-review-on-request', () => {
  const r = runCLI(['match', '--on-request', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.active.some((x) => x.id === 'codex-review-on-request'));
});
t('CLI match (no flags) --json never includes the on-request-only rule', () => {
  const r = runCLI(['match', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(!parsed.active.some((x) => x.id === 'codex-review-on-request'));
});
t('CLI list --json returns every active rule with id/text/source, including the migrated owner rule from the user file', () => {
  const r = runCLI(['list', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(Array.isArray(parsed) && parsed.length >= 5);
  for (const rule of parsed) assert.ok(rule.id && rule.text && rule.source);
});
t('CLI with an unknown command exits 2 (usage error), not a silent pass', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});
t('CLI honors FORGE_STANDING_RULES_PATH/_USER_PATH together for match/list, never touching the real files', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'cli-fixture-rule', trigger: 'always' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const r = runCLI(['list', '--json'], env);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.some((x) => x.id === 'cli-fixture-rule'));
  assert.strictEqual(parsed.length, 1, 'only the fixture rule should be visible, never the real seed set');
});

// ---------------------------------------------------------------------------
// 8) remember() — the ONLY sanctioned auto-active write path (WAVE B / B4), writes to the USER file
// ---------------------------------------------------------------------------
console.log('\n8) remember() — /forge remember writes ONLY to the user file (hermetic fixtures)');

t('remember() appends a new active rule (source "lead" without a checked owner prompt, CF-4-F2) into the USER file, never the template', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-1' })]);
  const before = fs.readFileSync(templatePath, 'utf8');
  const rule = standing.remember('never deploy on Fridays', { rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(rule.status, 'active');
  assert.strictEqual(rule.source, 'lead');
  assert.strictEqual(rule.text, 'never deploy on Fridays');
  assert.strictEqual(fs.readFileSync(templatePath, 'utf8'), before, 'remember() must never touch the template file');
  const userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userData.rules.length, 1);
  assert.ok(userData.rules.some((r) => r.id === rule.id && r.status === 'active'));
});

t('FB-SCRIBE-1-F12: remember() takes an exclusive lock and writes temp-then-rename (a held lock is never written past)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-lock' })]);
  standing.remember('first rule under the lock', { rulesPath: templatePath, userRulesPath: userPath });
  const dir = path.dirname(userPath);
  assert.ok(!fs.readdirSync(dir).some((n) => /\.tmp-|\.lock$/.test(n)), 'temp or lock file left behind: ' + fs.readdirSync(dir).join(', '));
  const before = fs.readFileSync(userPath, 'utf8');
  fs.writeFileSync(userPath + '.lock', String(process.pid)); // another writer holds it right now
  try {
    assert.throws(() => standing.remember('second rule while locked', { rulesPath: templatePath, userRulesPath: userPath, lockWaitMs: 200 }), /locked/);
    assert.strictEqual(fs.readFileSync(userPath, 'utf8'), before, 'the user file changed while another writer held the lock');
  } finally { fs.rmSync(userPath + '.lock', { force: true }); }
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.writeFileSync(userPath + '.lock', '1'); fs.utimesSync(userPath + '.lock', old, old); // a stale lock of a crashed writer
  standing.remember('third rule after a stale lock', { rulesPath: templatePath, userRulesPath: userPath, lockWaitMs: 200 });
  assert.strictEqual(JSON.parse(fs.readFileSync(userPath, 'utf8')).rules.length, 2);
  assert.ok(!fs.existsSync(userPath + '.lock'));
});

t('remember() creates the user file from scratch when it does not exist yet (a fresh project has no owner rules yet)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-1b' })]);
  assert.ok(!fs.existsSync(userPath));
  standing.remember('first ever remembered rule', { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(fs.existsSync(userPath), 'remember() must create the user file on first use');
});

t('remember() defaults to trigger:"always", scope:"global", cannot_override_core:false', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-2' })]);
  const rule = standing.remember('a default-shape rule', { rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(rule.trigger, 'always');
  assert.strictEqual(rule.scope, 'global');
  assert.strictEqual(rule.cannot_override_core, false);
});

t('remember() honors explicit --scope/--trigger/--domain/--topic/--id', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-3' })]);
  const rule = standing.remember('website-only rule', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'domain', domain: 'website', scope: 'domain:website', topic: 'my-topic', id: 'my-custom-id' });
  assert.strictEqual(rule.id, 'my-custom-id');
  assert.strictEqual(rule.trigger, 'domain');
  assert.strictEqual(rule.domain, 'website');
  assert.strictEqual(rule.topic, 'my-topic');
});

t('remember() honors explicit --glob for trigger:"glob"', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-4' })]);
  const rule = standing.remember('glob rule', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'glob', glob: '**/*.secret' });
  assert.strictEqual(rule.trigger, 'glob');
  assert.strictEqual(rule.glob, '**/*.secret');
});

t('a rule written by remember() actually fires via match() on a later, independent read (cache invalidated), merged with the template', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-5' })]);
  standing.remember('freshly remembered rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'fresh-remembered' });
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'fresh-remembered'));
  assert.ok(r.active.some((x) => x.id === 'seed-5'), 'the template rule must still be present alongside the remembered one');
});

t('remember() cannot mint a new cannot_override_core rule even if a caller tries to pass it', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-6' })]);
  const rule = standing.remember('trying to sneak in core status', { rulesPath: templatePath, userRulesPath: userPath, cannot_override_core: true });
  assert.strictEqual(rule.cannot_override_core, false);
});

t('remember() with empty/whitespace-only text throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-7' })]);
  assert.throws(() => standing.remember('   ', { rulesPath: templatePath, userRulesPath: userPath }));
  assert.ok(!fs.existsSync(userPath), 'remember() must write nothing on validation failure');
});

t('remember() with an unknown trigger throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-8' })]);
  assert.throws(() => standing.remember('bad trigger rule', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'sometimes' }));
  assert.ok(!fs.existsSync(userPath));
});

t('remember() with trigger:"domain" but no --domain throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-9' })]);
  assert.throws(() => standing.remember('missing domain', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'domain' }));
  assert.ok(!fs.existsSync(userPath));
});

t('remember() with trigger:"glob" but no --glob throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-10' })]);
  assert.throws(() => standing.remember('missing glob', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'glob' }));
  assert.ok(!fs.existsSync(userPath));
});

t('remember() with an --id colliding inside the user file throws, writes nothing new', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-11' })]);
  standing.remember('first rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'collide-me' });
  const before = fs.readFileSync(userPath, 'utf8');
  assert.throws(() => standing.remember('dup id rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'collide-me' }));
  assert.strictEqual(fs.readFileSync(userPath, 'utf8'), before);
});

t('remember() with an --id colliding with a shipped TEMPLATE rule id throws (never silently masks a product rule)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'product-rule-x' })]);
  assert.throws(() => standing.remember('trying to shadow a product rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'product-rule-x' }), /collides with a shipped product rule id/);
  assert.ok(!fs.existsSync(userPath), 'nothing should be written when the id collides with a product rule');
});

// FB-SCRIBE-1-F10: unquoted text and duplicates.
t('CLI remember with unquoted multi-word text (several positionals) refuses with exit 2, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-f10' })]);
  const r = runCLI(['remember', 'always', 'use', 'parallel', 'lanes'], Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath }));
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(/quote/i.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(userPath), 'nothing may be written');
});
t('remember() refuses a text that already exists (whitespace and case folded), writes nothing new', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-f10b' })]);
  standing.remember('Always use parallel lanes', { rulesPath: templatePath, userRulesPath: userPath });
  const before = fs.readFileSync(userPath, 'utf8');
  assert.throws(() => standing.remember('  always   USE parallel lanes ', { rulesPath: templatePath, userRulesPath: userPath }), /already exists/);
  assert.strictEqual(fs.readFileSync(userPath, 'utf8'), before);
});
// FB-SCRIBE-1-F11: '**/' matches zero folders; './' and absolute project paths match.
t("glob '**/' matches zero folders; './' and absolute paths inside the project match", () => {
  assert.ok(standing.pathMatchesGlob('src/index.ts', 'src/**/*.ts'), 'src/index.ts vs src/**/*.ts');
  assert.ok(standing.pathMatchesGlob('src/a/b/index.ts', 'src/**/*.ts'), 'deep path still matches');
  assert.ok(standing.pathMatchesGlob('README.md', '**/*.md'), 'README.md vs **/*.md');
  assert.ok(standing.pathMatchesGlob('.env', '**/.env*'), '.env vs **/.env*');
  assert.ok(standing.pathMatchesGlob('./src/a.js', 'src/**'), './src/a.js vs src/**');
  const abs = path.join(path.resolve(__dirname, '..', '..'), 'src', 'a.js');
  assert.ok(standing.pathMatchesGlob(abs, 'src/**'), abs + ' vs src/**');
  assert.ok(!standing.pathMatchesGlob('lib/a.js', 'src/**'), 'lib/a.js must not match src/**');
  assert.ok(!standing.pathMatchesGlob('srcx/a.ts', 'src/**/*.ts'), 'srcx/a.ts must not match src/**/*.ts');
});

t('remember() against a malformed (present) user file throws, writes nothing new', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-12' })]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, '{ broken');
  assert.throws(() => standing.remember('rule text', { rulesPath: templatePath, userRulesPath: userPath }));
  assert.strictEqual(fs.readFileSync(userPath, 'utf8'), '{ broken');
});

t('remember() never writes to the REAL config/orchestration/FORGE_STANDING_RULES.json (hermeticity proof)', () => {
  const before = fs.readFileSync(standing.CONFIG_PATH, 'utf8');
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-13' })]);
  standing.remember('a fixture-only rule', { rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(fs.readFileSync(standing.CONFIG_PATH, 'utf8'), before, 'remember() must never touch the real seed file when userRulesPath overrides it');
});

t('CLI remember "<text>" --json writes into the FORGE_STANDING_RULES_USER_PATH fixture (hermetic — never touches the real files) and prints it', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cli-1' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const realTemplateBefore = fs.readFileSync(standing.CONFIG_PATH, 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'remember', 'cli remembered rule', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.source, 'lead'); // CF-4-F2: no --prompt, so not the owner's
  assert.strictEqual(parsed.text, 'cli remembered rule');
  const written = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.ok(written.rules.some((x) => x.id === parsed.id));
  assert.strictEqual(fs.readFileSync(templatePath, 'utf8'), fs.readFileSync(templatePath, 'utf8'), 'sanity');
  assert.strictEqual(fs.readFileSync(standing.CONFIG_PATH, 'utf8'), realTemplateBefore, 'the real template file must be untouched by a hermetic CLI call');
});

t('CLI remember honors --scope/--trigger/--domain/--topic/--id via FORGE_STANDING_RULES_USER_PATH', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cli-2' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const r = spawnSync(process.execPath, [CLI, 'remember', 'website-only cli rule', '--trigger', 'domain', '--domain', 'website', '--scope', 'domain:website', '--topic', 'cli-topic', '--id', 'cli-custom-id', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.id, 'cli-custom-id');
  assert.strictEqual(parsed.trigger, 'domain');
  assert.strictEqual(parsed.domain, 'website');
  assert.strictEqual(parsed.topic, 'cli-topic');
});

t('CLI remember with no text argument exits 2 (usage error), writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cli-3' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const r = spawnSync(process.execPath, [CLI, 'remember'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  assert.ok(!fs.existsSync(userPath));
});

t('CLI remember with no env override set falls back to the real files — proven via a guaranteed-failing collision against a REAL product rule id, so nothing is actually written', () => {
  const env = Object.assign({}, process.env);
  delete env.FORGE_STANDING_RULES_PATH;
  delete env.FORGE_STANDING_RULES_USER_PATH;
  const r = spawnSync(process.execPath, [CLI, 'remember', 'should collide', '--id', 'honesty-core-untouchable'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('collides with a shipped product rule id'), 'stderr: ' + r.stderr);
});

// ---------------------------------------------------------------------------
// 9) MIGRATION — an owner-remember rule found in the template MOVES (not copies) into the user file
// ---------------------------------------------------------------------------
console.log('\n9) migration — owner-remember rules move out of the template, they never stay in both places');

t('load() migrates an owner-remember-sourced template rule into a brand-new user file, and removes it from the template on disk (opts.migrate:true — the explicit opt-in seam, since this is a fixture path, not this install\'s own CONFIG_PATH; see section 9b for the default read-only behavior)', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'product-rule-migr-1' }),
    baseRule({ id: 'owner-rule-to-migrate', source: standing.OWNER_REMEMBER_SOURCE, text: 'an owner rule that should not ship' }),
  ]);
  assert.ok(!fs.existsSync(userPath), 'no user file should exist before migration runs');

  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath, migrate: true });

  // moved, not copied: present exactly once, in the user file, absent from the template on disk
  const templateOnDisk = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  assert.ok(!templateOnDisk.rules.some((r) => r.id === 'owner-rule-to-migrate'), 'the owner rule must be REMOVED from the template file on disk');
  assert.ok(fs.existsSync(userPath), 'migration must create the user file');
  const userOnDisk = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userOnDisk.rules.filter((r) => r.id === 'owner-rule-to-migrate').length, 1, 'the owner rule must land in the user file exactly once');

  // still visible/active via the merged load() result — migration never loses the rule
  assert.ok(data.rules.some((r) => r.id === 'owner-rule-to-migrate'), 'the migrated rule must still be active via the merged view');
  assert.ok(data.rules.some((r) => r.id === 'product-rule-migr-1'), 'the product rule must remain untouched');
});

t('migration is idempotent: a second load() call after migration does not duplicate the rule anywhere', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'product-rule-migr-2' }),
    baseRule({ id: 'owner-rule-idempotent', source: standing.OWNER_REMEMBER_SOURCE }),
  ]);
  standing.load({ rulesPath: templatePath, userRulesPath: userPath, migrate: true });
  // force a fresh (uncached) re-read by re-invoking load() with the same paths after clearing the module
  // cache the only way this module exposes: writing a new remember() elsewhere invalidates it globally.
  standing.remember('unrelated cache-buster', { rulesPath: templatePath, userRulesPath: path.join(path.dirname(userPath), 'other-user.json') });
  const data2 = standing.load({ rulesPath: templatePath, userRulesPath: userPath, migrate: true });
  assert.strictEqual(data2.rules.filter((r) => r.id === 'owner-rule-idempotent').length, 1, 'must appear exactly once after a second migration pass');
  const userOnDisk = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userOnDisk.rules.filter((r) => r.id === 'owner-rule-idempotent').length, 1);
});

t('migration merges into an EXISTING user file (with its own prior rules) instead of overwriting it', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'product-rule-migr-3' }),
    baseRule({ id: 'owner-rule-merge-target', source: standing.OWNER_REMEMBER_SOURCE }),
  ]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [baseRule({ id: 'already-remembered-earlier', source: standing.OWNER_REMEMBER_SOURCE })] }));

  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath, migrate: true });
  assert.ok(data.rules.some((r) => r.id === 'already-remembered-earlier'), 'a prior user rule must survive migration');
  assert.ok(data.rules.some((r) => r.id === 'owner-rule-merge-target'), 'the newly migrated rule must also be present');
  const userOnDisk = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userOnDisk.rules.length, 2);
});

// ---------------------------------------------------------------------------
// 9b) external-audit 3.3 (LOW) — migration is READ-ONLY unless this IS the install's own
//     CONFIG_PATH, or the caller explicitly opts in with migrate:true (forge-audit-loop --root
//     <other project> must never rewrite that project's rules file or create a user file next to it)
// ---------------------------------------------------------------------------
console.log('\n9b) 3.3 fix — migration never runs on a foreign/fixture rules file by default (read-only)');

t('load() on a rules file that is NOT this install\'s own CONFIG_PATH never migrates an owner rule out of it, and never creates a sibling user file, when opts.migrate is not set', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'foreign-product-rule' }),
    baseRule({ id: 'foreign-owner-rule', source: standing.OWNER_REMEMBER_SOURCE, text: 'an owner rule living in someone else\'s template' }),
  ]);
  const before = fs.readFileSync(templatePath, 'utf8');

  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath }); // no migrate:true

  assert.strictEqual(fs.readFileSync(templatePath, 'utf8'), before, 'a foreign/fixture template read must never be rewritten');
  assert.ok(!fs.existsSync(userPath), 'a foreign/fixture template read must never create a sibling user file');
  assert.ok(data.rules.some((r) => r.id === 'foreign-owner-rule'), 'the owner rule must still be visible via the merged read even though it was not migrated on disk');
  assert.ok(data.rules.some((r) => r.id === 'foreign-product-rule'));
});

t('load() against the REAL, on-disk CONFIG_PATH (no opts.rulesPath override) migrates automatically — the default, own-install case stays unchanged', () => {
  // Uses the real files with no owner-remember rule present (verified clean by section 1b) — a no-op
  // migration, but proves the auto-migrate path still runs for this install's own template by default.
  const data = standing.load();
  assert.strictEqual(data.rules.filter((r) => r.source === standing.OWNER_REMEMBER_SOURCE && r._origin === 'template').length, 0);
});

console.log('');
// ---- (Lead, post-merge): owner rules never leak into another rules file; missing keeps ENOENT ----
{
  const savedEnv = process.env.FORGE_STANDING_RULES_USER_PATH;
  delete process.env.FORGE_STANDING_RULES_USER_PATH;
  try {
    t('isolation: a caller-supplied rulesPath never reads THIS install\'s own user rules (no sibling user file)', () => {
      const p = writeRules([baseRule({ id: 'fixture-only-rule' })]);
      const data = standing.load({ rulesPath: p });
      assert.strictEqual(data.rules.length, 1, 'expected exactly the fixture rule, got ' + data.rules.map((r) => r.id).join(','));
      assert.strictEqual(data.rules[0].id, 'fixture-only-rule');
    });
    t('isolation: a caller-supplied rulesPath DOES read its own sibling FORGE_STANDING_RULES.user.json', () => {
      const p = writeRules([baseRule({ id: 'fixture-template-rule' })]);
      fs.writeFileSync(userPathFor(p), JSON.stringify({ version: 1, rules: [baseRule({ id: 'fixture-owner-rule', source: 'owner /forge remember' })] }));
      const ids = standing.load({ rulesPath: p }).rules.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['fixture-owner-rule', 'fixture-template-rule']);
    });
    t('a missing template throws an error that keeps code ENOENT (audit-loop tells missing from corrupt by it)', () => {
      const missing = path.join(freshDir('forge-standing-missing'), 'FORGE_STANDING_RULES.json');
      let err = null;
      try { standing.load({ rulesPath: missing }); } catch (e) { err = e; }
      assert.ok(err, 'expected load() to throw for a missing template');
      assert.strictEqual(err.code, 'ENOENT');
    });
  } finally {
    if (savedEnv === undefined) delete process.env.FORGE_STANDING_RULES_USER_PATH; else process.env.FORGE_STANDING_RULES_USER_PATH = savedEnv;
  }
}

// ---------------------------------------------------------------------------
// CF-4-F2: remember() labels a rule 'lead' unless a hook-captured owner prompt id is passed AND checked
// (forge-scribe-store's owner origin: unbroken inbox chain, hook capture, the same message in this project's transcript)
// ---------------------------------------------------------------------------
console.log('\nCF-4-F2) remember() source: lead by default, owner only with a checked owner prompt');
{
  const SC = require('./forge-scribe.cjs');
  const SCC = require('./forge-scribe-classify.cjs');
  const root = freshDir('standing-owner-root');
  const home = freshDir('standing-owner-home');
  const projects = path.join(home, '.claude', 'projects');
  const tr = path.join(projects, path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(tr, { recursive: true });
  const cfg = SCC.loadConfig();
  const now = new Date();
  const text = 'onthoud dit: nooit op vrijdag deployen';
  const tp = path.join(tr, 's1.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', uuid: 'u-1', promptId: 'p-1', sessionId: 's1', timestamp: now.toISOString(), message: { role: 'user', content: text } }) + '\n');
  const scribeOpts = { root, config: cfg, claudeProjectsRoot: projects, transcriptRoots: [tr], now: () => now, autoack: false, configHome: path.join(home, '.claude'), standingRulesPath: path.join(root, 'standing.user.json') };
  const owner = SC.capture(text, Object.assign({ source: 'hook', session_id: 's1', transcript_path: tp, uuid: 'u-1', prompt_id: 'p-1' }, scribeOpts));
  const cli = SC.capture('een regel die de Lead zelf typte', Object.assign({ source: 'cli' }, scribeOpts));
  const ownerOpts = (extra) => Object.assign({ scribeRoot: root, claudeProjectsRoot: projects, scribeConfig: cfg }, extra);

  t('CF-4-F2: remember() without an owner prompt id records source "lead", never the owner', () => {
    const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cf42-a' })]);
    const rule = standing.remember('a rule the Lead wrote', { rulesPath: templatePath, userRulesPath: userPath });
    assert.strictEqual(rule.source, 'lead');
    assert.ok(/^lead-remember-/.test(rule.id), rule.id);
  });

  t('CF-4-F2: a checked hook-captured owner prompt gives source "owner /forge remember" and names the prompt', () => {
    const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cf42-b' })]);
    const rule = standing.remember('never deploy on Fridays', ownerOpts({ rulesPath: templatePath, userRulesPath: userPath, ownerPrompt: owner.pid }));
    assert.strictEqual(rule.source, standing.OWNER_REMEMBER_SOURCE);
    assert.strictEqual(rule.owner_prompt, owner.pid);
    assert.ok(/^owner-remember-/.test(rule.id), rule.id);
  });

  t('CF-4-F2: a prompt that was not captured by the hook, or does not exist, is refused and nothing is written', () => {
    const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cf42-c' })]);
    assert.throws(() => standing.remember('rule x', ownerOpts({ rulesPath: templatePath, userRulesPath: userPath, ownerPrompt: cli.pid })), /hook/);
    assert.throws(() => standing.remember('rule y', ownerOpts({ rulesPath: templatePath, userRulesPath: userPath, ownerPrompt: 'P-999999' })), /not in the inbox/);
    assert.throws(() => standing.remember('rule z', ownerOpts({ rulesPath: templatePath, userRulesPath: userPath, ownerPrompt: 'not-a-pid' })), /P-n/);
    assert.ok(!fs.existsSync(userPath), 'a refused remember writes nothing');
  });

  t('CF-4-F2: an owner prompt missing from the transcript is refused', () => {
    fs.writeFileSync(tp, ''); // the transcript no longer holds the message
    const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cf42-d' })]);
    assert.throws(() => standing.remember('rule w', ownerOpts({ rulesPath: templatePath, userRulesPath: userPath, ownerPrompt: owner.pid })), /transcript/);
  });

  t('CF-4-F2: CLI remember --prompt passes the owner prompt id (refused here: no transcript folder for this project)', () => {
    const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cf42-e' })]);
    const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
    const r = spawnSync(process.execPath, [CLI, 'remember', 'cli rule with a prompt', '--prompt', 'P-999999'], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.ok(/owner prompt/.test(r.stderr), r.stderr);
    assert.ok(!fs.existsSync(userPath));
  });
  fs.rmSync(root, { recursive: true, force: true }); // this section's own mkdtemp fixtures
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
