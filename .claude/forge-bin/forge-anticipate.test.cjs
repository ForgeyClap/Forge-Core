#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-anticipate.cjs (modernization WP I.2). A temp project root (FORGE_PROJECT_ROOT), a temp
 *  config home (FORGE_CONFIG_HOME) and a temp home for global skills (FORGE_ANTICIPATE_HOME) keep this repo's runs and the
 *  owner's FORGE_CONFIG.json out of reach; settings are changed only through the real forge-config.cjs CLI.
 *  Sections: catalog validity and verifiable mechanisms · classification conservatism (the classifier cross-check, every
 *  gated entry detectable, catalog mutants) · NL/EN triggers · never-enables-gated · respected owner choices · kill switch ·
 *  apply/revert round trip · determinism · garbage input · one-line announcement · metric (read-only) · explain ·
 *  plan-card contract · REAL-DATA REPLAY of the twelve owner switch requests (intelligence-evidence.md section 1; the
 *  table is written to $ANTICIPATE_REPLAY_OUT when set) · tool mutants (each must flip a guarded outcome). Exit 0 = pass. */
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-anticipate-test-'));
const CFG_HOME = path.join(TMP, 'cfg-home'), AHOME = path.join(TMP, 'ahome'), EMPTY_HOME = path.join(TMP, 'empty-home');
for (const d of [CFG_HOME, path.join(AHOME, '.claude', 'skills', 'watch'), EMPTY_HOME]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(AHOME, '.claude', 'skills', 'watch', 'SKILL.md'), '---\nname: watch\n---\n');
function makeProject(name, run) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), "require('fs').appendFileSync(require('path').join(__dirname, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  if (run) { fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'run-1'), { recursive: true }); fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'run-1', 'run.json'), JSON.stringify(run)); }
  return root;
}
const PROJ = makeProject('proj');
process.env.FORGE_PROJECT_ROOT = PROJ; process.env.FORGE_CONFIG_HOME = CFG_HOME; process.env.FORGE_ANTICIPATE_HOME = AHOME;
const CLI = path.join(__dirname, 'forge-anticipate.cjs');
const A = require('./forge-anticipate.cjs');
const gate = require('./forge-actiongate.cjs');
const CAT = A.loadCatalog();
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8'));
const byId = Object.fromEntries(CAT.entries.map((e) => [e.id, e]));
const GATED = CAT.entries.filter((e) => e.class !== 'SAFE').map((e) => e.id), SAFE = CAT.entries.filter((e) => e.class === 'SAFE').map((e) => e.id);
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };
const run = (args, o) => spawnSync(process.execPath, [(o && o.cli) || CLI].concat(args), { encoding: 'utf8', timeout: 60000,
  env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: (o && o.root) || PROJ, FORGE_CONFIG_HOME: CFG_HOME, FORGE_ANTICIPATE_HOME: (o && o.home) || AHOME }) });
const planJ = (text, extra, o) => { const r = run(['plan', '--text', text, '--json'].concat(extra || []), o); let j = null; try { j = JSON.parse(r.stdout); } catch { /* asserted below */ } return { r, j }; };
const cfgSet = (root, key, val) => spawnSync(process.execPath, [path.join(__dirname, 'forge-config.cjs'), 'set', key, val], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root, FORGE_CONFIG_HOME: CFG_HOME }) });
const ids = (xs) => (xs || []).map((x) => x.id);
const writeTmp = (name, data) => { const p = path.join(TMP, name); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); return p; };
function treeHash(dir, skip) {
  const h = crypto.createHash('sha256');
  (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (skip && skip(p)) continue; const st = fs.statSync(p); if (st.isDirectory()) walk(p); else h.update(path.relative(dir, p) + ':' + fs.readFileSync(p).toString('base64')); } })(dir);
  return h.digest('hex');
}
console.log('forge-anticipate tests (hermetic tmp=' + TMP + ')');

// ---- 1) catalog validity: every entry names a mechanism that really exists ----
console.log('1) catalog + mechanisms');
const V = A.validateCatalog(CAT, {});
t('the real catalog validates (' + V.counts.entries + ' entries: ' + V.counts.SAFE + ' SAFE, ' + V.counts['OWNER-GATED'] + ' OWNER-GATED)', V.ok, V.problems.join(' | '));
t('only machine-local refs may be notes (global skills/tools, owner overlay, local-only docs)', V.warnings.every((w) => /not installed on this machine|owner overlay|local-only/.test(w)), V.warnings.join(' | '));
t('validate CLI exits 0 on the real catalog', run(['validate']).status === 0);

// ---- 1b) portability: a synced project carries ITS OWN FORGE_STANDING_RULES.user.json, so the shipped catalog
// may not depend on the development tree's owner overlay. standing-rule refs are judged against the SHIPPED rules only;
// owner-rule refs (the maintainer's overlay, cited as evidence) are strict in the development tree and a note elsewhere.
console.log('1b) portability: standing-rule / owner-rule refs in synced-project-shaped installs');
const SHIPPED_RULE_IDS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), 'utf8')).rules.map((r) => r.id);
const refsOf = (type) => CAT.entries.flatMap((e) => (e.evidence_ref || []).concat(e.verify || [])).filter((r) => r && r.type === type);
const OWNER_REFS = refsOf('owner-rule'), STANDING_REFS = refsOf('standing-rule');
function rulesInstall(name, o) {
  const root = path.join(TMP, name), orch = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(orch, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), path.join(orch, 'FORGE_STANDING_RULES.json'));
  if (o.overlay) fs.writeFileSync(path.join(orch, 'FORGE_STANDING_RULES.user.json'), JSON.stringify({ rules: o.overlay.map((id) => ({ id, rule: 'fixture' })) }));
  if (o.devTree) fs.writeFileSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'), JSON.stringify({ dev_tree: true }));
  return A.verifyContext({ installRoot: root });
}
const verdicts = (refs, ctx) => refs.map((r) => A.verifyRef(r, ctx));
t('the catalog cites the maintainer overlay only through owner-rule refs (' + OWNER_REFS.length + '); every standing-rule ref (' + STANDING_REFS.length + ') names a SHIPPED rule',
  OWNER_REFS.length >= 1 && STANDING_REFS.length >= 1 && STANDING_REFS.every((r) => SHIPPED_RULE_IDS.includes(r.target)) && OWNER_REFS.every((r) => !SHIPPED_RULE_IDS.includes(r.target)),
  STANDING_REFS.filter((r) => !SHIPPED_RULE_IDS.includes(r.target)).map((r) => r.target).join(', '));
const syncedOwn = rulesInstall('synced-own-overlay', { overlay: ['their-own-rule-a', 'their-own-rule-b'] });
const vOwn = verdicts(OWNER_REFS, syncedOwn);
t('synced shape (its own overlay, no dev marker): every owner-rule ref is a note naming the owner overlay, never a problem', syncedOwn.devTree === false && vOwn.every((v) => !v.ok && !v.problem && /owner overlay/.test(v.warn || '')), JSON.stringify(vOwn.filter((v) => v.problem)));
t('synced shape: every standing-rule ref opens against the shipped rules', verdicts(STANDING_REFS, syncedOwn).every((v) => v.ok));
t('synced shape without any overlay: the same notes (nothing depends on whether an overlay exists)', verdicts(OWNER_REFS, rulesInstall('synced-no-overlay', {})).every((v) => !v.ok && !v.problem && /owner overlay/.test(v.warn || '')));
const devLacking = rulesInstall('dev-lacking', { overlay: ['some-other-rule'], devTree: true });
t('development-tree shape whose overlay lacks the rules: every owner-rule ref is a PROBLEM (the dev tree stays strict)', devLacking.devTree === true && verdicts(OWNER_REFS, devLacking).every((v) => !v.ok && /not in this development tree/.test(v.problem || '')));
// W2-FRESHCLONE: a fresh clone of the development tree carries the dev marker but never the owner overlay
// (gitignored, user-local). An ABSENT overlay is a visible note naming the missing file, never a problem and never ok.
const devFresh = rulesInstall('dev-fresh-clone', { devTree: true }), vFresh = verdicts(OWNER_REFS, devFresh);
t('development-tree shape WITHOUT an overlay file (fresh clone): every owner-rule ref is a visible note naming the absent FORGE_STANDING_RULES.user.json, not a problem',
  devFresh.devTree === true && vFresh.length >= 1 && vFresh.every((v) => !v.ok && !v.problem && /FORGE_STANDING_RULES\.user\.json is absent/.test(v.warn || '') && /owner overlay/.test(v.warn || '')), JSON.stringify(vFresh.slice(0, 2)));
t('development-tree shape whose overlay holds the rules: every owner-rule ref opens', verdicts(OWNER_REFS, rulesInstall('dev-holding', { overlay: OWNER_REFS.map((r) => r.target), devTree: true })).every((v) => v.ok));
t('a standing-rule ref to a rule only an overlay holds is a problem in a synced AND a dev shape (validate only against rules that ship)',
  [syncedOwn, devLacking].every((c) => /shipped FORGE_STANDING_RULES/.test(A.verifyRef({ type: 'standing-rule', target: 'their-own-rule-a' }, c).problem || '')));
t('an owner-rule ref naming a shipped rule is refused (cite it as a standing-rule ref)', /cite it as a standing-rule ref/.test(A.verifyRef({ type: 'owner-rule', target: SHIPPED_RULE_IDS[0] }, syncedOwn).problem || ''));
const ownerInVerify = JSON.parse(JSON.stringify(CAT)); ownerInVerify.entries[0].verify.push({ type: 'owner-rule', target: OWNER_REFS[0] && OWNER_REFS[0].target });
t('an owner-rule ref used as a verify mechanism is refused (the overlay never ships, so it cannot gate an entry)', A.validateCatalog(ownerInVerify, {}).problems.some((p) => p.includes('owner-rule ref is evidence only')));
const ctx = A.verifyContext({});
let strict = 0, strictBad = [];
for (const e of CAT.entries) for (const ref of e.verify) { const v = A.verifyRef(ref, ctx); if (!['global-skill', 'global-file'].includes(ref.type)) { strict++; if (!v.ok) strictBad.push(e.id + ':' + ref.type); } }
t('every in-repo mechanism opens (' + strict + ' schema keys, skill folders, tool files, hard rules, gates, locked ids)', !strictBad.length, strictBad.join(', '));
let execBad = [];
const REPO = path.resolve(__dirname, '..', '..');
for (const e of CAT.entries) for (const ref of e.verify) if (ref.exec) { const r = spawnSync(process.execPath, [path.join(REPO, ref.target)].concat(ref.exec), { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: REPO }) }); if (r.status !== 0) execBad.push(e.id + ' (' + ref.exec.join(' ') + ' -> ' + r.status + ')'); }
t('every tool with an exec probe really runs (exit 0)', !execBad.length, execBad.join(', '));
t('each config-key entry reads a key that exists in the schema', CAT.entries.filter((e) => e.kind === 'config-key').every((e) => SCHEMA.settings[e.config_key]));
const AK = SCHEMA.settings.anticipate;
t('schema key anticipate: bool, default on, project scope, core group, nl+en text and off_means', AK && AK.type === 'bool' && AK.default === true && AK.scope === 'project' && AK.group === 'core' && AK.desc.nl && AK.desc.en && AK.off_means.nl && AK.off_means.en);
const evRows = new Set(CAT.entries.filter((e) => e.evidence_row).map((e) => e.evidence_row));
t('the owner requests #1-#11 each have a catalog entry (#12 is the engine itself)', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((n) => evRows.has(n)));

// ---- 2) classification conservatism ----
console.log('2) conservatism');
const classifierHits = CAT.entries.filter((e) => e.class === 'SAFE').filter((e) => gate.classify(e.how_to_enable, { projectRoot: path.join(__dirname, '..', '..') }).gate);
t('the hard-gate classifier (forge-actiongate classify) flags NO SAFE entry', !classifierHits.length, ids(classifierHits).join(', '));
const undetectable = GATED.filter((id) => !A.riskSignals(byId[id], SCHEMA).length);
t('every OWNER-GATED entry carries an independent risk signal, so flipping it to SAFE is caught', !undetectable.length, undetectable.join(', '));
const reasonsOk = CAT.entries.every((e) => (e.class === 'SAFE') === (e.class_reason.length === 1 && e.class_reason[0] === 'none'));
t('SAFE <=> class_reason ["none"]; every cost/outbound/credentials/destructive/production entry is OWNER-GATED', reasonsOk);
const flaggedKeys = Object.keys(SCHEMA.settings).filter((k) => (SCHEMA.settings[k].flags || []).length);
t('no SAFE entry points at a config key with a disclosure flag (' + flaggedKeys.join(' ') + ')', CAT.entries.every((e) => e.class !== 'SAFE' || !flaggedKeys.includes(e.config_key)));
const missed = [];
for (const id of GATED) {
  const mut = JSON.parse(JSON.stringify(CAT)); const m = mut.entries.find((e) => e.id === id); m.class = 'SAFE'; m.class_reason = ['none']; m.reversible = true;
  const r = A.validateCatalog(mut, {}); if (r.ok || !r.problems.some((p) => p.includes('entry ' + id + ': SAFE but'))) missed.push(id);
}
t('catalog mutants: each of the ' + GATED.length + ' gated entries flipped to SAFE is refused', !missed.length, missed.join(', '));
const viaClassifier = ['git-push', 'release-publish', 'outreach-send', 'deploy'];
const cv = viaClassifier.filter((id) => { const mut = JSON.parse(JSON.stringify(CAT)); Object.assign(mut.entries.find((e) => e.id === id), { class: 'SAFE', class_reason: ['none'], reversible: true });
  return run(['validate', '--json', '--catalog', writeTmp('mut-' + id + '.json', mut)]).status === 3 && A.validateCatalog(mut, {}).problems.some((p) => p.includes('forge-actiongate')); });
t('the classifier cross-check itself names forge-actiongate for ' + viaClassifier.join(', ') + ' (CLI exit 3)', cv.length === viaClassifier.length, cv.join(','));
const sneaky = JSON.parse(JSON.stringify(CAT)); sneaky.entries.find((e) => e.id === 'plan-card').how_to_enable = 'git push origin main after the card is rendered';
t('a SAFE entry whose mechanism grows a push is refused', !A.validateCatalog(sneaky, {}).ok);
const badShapes = [
  [{ version: 2, entries: [] }, 'catalog'], [Object.assign({}, CAT, { entries: [Object.assign({}, CAT.entries[0], { kind: 'magic' })] }), 'kind'],
  [Object.assign({}, CAT, { entries: [CAT.entries[0], CAT.entries[0]] }), 'twice'],
  [Object.assign({}, CAT, { entries: [Object.assign({}, CAT.entries[1], { triggers: [{ keywords: { en: ['x'] } }] })] }), 'keywords'],
  [Object.assign({}, CAT, { entries: [Object.assign({}, CAT.entries[1], { triggers: [{ moon: true }] })] }), 'unknown trigger'],
  [Object.assign({}, CAT, { entries: [Object.assign({}, CAT.entries[1], { verify: [{ type: 'file', target: '.claude/forge-bin/nope.cjs' }] })] }), 'does not exist'],
  [Object.assign({}, CAT, { entries: [Object.assign({}, CAT.entries[1], { class: 'SAFE', class_reason: ['cost'] })] }), 'class_reason'],
];
t('malformed catalogs are refused with a named problem', badShapes.every(([c, word]) => { const r = A.validateCatalog(c, {}); return !r.ok && r.problems.some((p) => p.includes(word)); }));

// ---- 3) triggers: NL and EN ----
console.log('3) NL + EN triggers');
const same = (a, b) => JSON.stringify(ids(a).sort()) === JSON.stringify(ids(b).sort());
const lpNl = planJ('maak een landingspagina voor een bakkerij').j, lpEn = planJ('build a landing page for a bakery').j;
t('landing page NL and EN match the same entries', lpNl && lpEn && same(lpNl.matched, lpEn.matched), lpNl && lpEn ? ids(lpNl.matched) + ' vs ' + ids(lpEn.matched) : '');
const pairs = [['forge-debug', 'de export werkt niet en geeft een foutmelding', 'the export does not work and throws an error'],
  ['watch-video', 'bekijk deze youtube video', 'watch this youtube video'], ['release-publish', 'vergeet niet om de nieuwe versie te releasen', "don't forget to release the new version"],
  ['deep-research', 'onderzoek grondig met bronnen welke database past', 'do thorough research with sources on which database fits'],
  ['codex-adversarial-review', 'pas de login en de wachtwoord-reset aan', 'change the login and the password reset'],
  ['proactive-status', 'werk vannacht de hele backlog af', 'work through the whole backlog overnight']];
for (const [id, nl, en] of pairs) { const a = planJ(nl).j, b = planJ(en).j; t(id + ' triggers in NL and EN (' + (a && a.lang) + '/' + (b && b.lang) + ')', a && b && ids(a.matched).includes(id) && ids(b.matched).includes(id) && a.lang === 'nl' && b.lang === 'en'); }
t('one lane does not arm the lane watchdog; two lanes do', !ids(planJ('fix the typo in the readme').j.matched).includes('lane-watchdog') && ids(planJ('fix the typo in the readme', ['--lanes', '2']).j.matched).includes('lane-watchdog'));
t('lanes are read from the text ("6 onafhankelijke delen" -> 6; "three modules" -> 3)', A.parseLanes('bouw het in 6 onafhankelijke delen') === 6 && A.parseLanes('split it into three modules') === 3 && A.parseLanes('fix one bug') === 1);
t('an auth-only change is not mistaken for a web page (no screenshot loop)', !ids(planJ('change the JWT auth middleware').j.matched).includes('screenshot-loop'));

// ---- 4) never enables a gated entry ----
console.log('4) never enables gated');
const SINK = 'Build a SaaS landing page and dashboard in 6 parallel parts, fix the login crash, do thorough research with sources, watch this youtube video, ' +
  'git push to origin, release the new version, deploy to production on vercel, send the email to the client, clean up old logs, use fable effort high, ' +
  'switch accounts at the usage limit, keep working overnight unattended with paperclip, parse the invoice csv, review the pull request';
const sink = planJ(SINK).j;
const useIds = sink ? sink.skills_to_use.concat(ids(sink.checks_to_run), ids(sink.tools_to_run), ids(sink.safe_to_enable)) : [];
t('kitchen sink: no OWNER-GATED id in safe_to_enable, skills, checks or tools', sink && GATED.every((id) => !useIds.includes(id)), useIds.filter((x) => GATED.includes(x)).join(','));
t('kitchen sink: the gated triggers land in the owner queue or are already allowed by a setting', sink && ['git-push', 'release-publish', 'deploy', 'outreach-send', 'cleanup-auto', 'model-upgrade', 'account-rotator', 'paperclip', 'codex-adversarial-review'].every((id) => ids(sink.gated_queue).includes(id)) && ids(sink.already_on).includes('usage-guard'));
t('plan only plans: planned_only true and the project gained no settings file', sink && sink.planned_only === true && !fs.existsSync(path.join(PROJ, '.claude', 'FORGE_CONFIG.json')) && !fs.existsSync(path.join(CFG_HOME, 'FORGE_CONFIG.json')));
t('the switches section mirrors the buckets', sink && same(sink.switches.auto_enabled, sink.safe_to_enable) && same(sink.switches.waits_for_owner, sink.gated_queue));

// ---- 5) owner choices are respected; 6) kill switch ----
console.log('5) respected owner choices + 6) kill switch');
const P2 = makeProject('proj-off'); cfgSet(P2, 'ui-quality', 'off');
const off = planJ('maak een landingspagina voor een bakkerij', [], { root: P2 }).j;
t('ui-quality turned off by the owner: ui-quality and the screenshot loop are respected, not re-enabled', off && ['ui-quality', 'screenshot-loop'].every((id) => ids(off.respected_off).includes(id)) && !ids(off.safe_to_enable).includes('screenshot-loop') && !ids(off.already_on).includes('ui-quality'));
const P3 = makeProject('proj-kill', { request: 'maak een landingspagina in 3 delen' }); const ks = cfgSet(P3, 'anticipate', 'off');
const kill = planJ(SINK, [], { root: P3 }).j;
t('config anticipate off (set through forge-config): plan is disabled, nothing matched, the line says so', ks.status === 0 && kill && kill.enabled === false && !kill.matched.length && /anticipate/.test(kill.announcement));
const ka = run(['apply', '--run', 'run-1', '--json'], { root: P3 });
t('kill switch: apply writes nothing', ka.status === 0 && !fs.existsSync(path.join(P3, '.claude', 'forge-runs', 'run-1', 'anticipate.json')));
const PD = makeProject('proj-damaged'); fs.mkdirSync(path.join(PD, '.claude'), { recursive: true }); fs.writeFileSync(path.join(PD, '.claude', 'FORGE_CONFIG.json'), '{damaged');
const dmg = planJ('maak een landingspagina in 3 delen', [], { root: PD });
t('a damaged FORGE_CONFIG.json: plan still exits 0, config-driven entries are skipped (never claimed on), the file is untouched',
  dmg.r.status === 0 && dmg.j && dmg.j.ok && ['ui-quality', 'git-checkpoint'].every((id) => ids(dmg.j.skipped).includes(id) && !ids(dmg.j.already_on).includes(id)) && fs.readFileSync(path.join(PD, '.claude', 'FORGE_CONFIG.json'), 'utf8') === '{damaged');
const flagCat = JSON.parse(JSON.stringify(CAT));
flagCat.entries.push({ id: 'test-off-key', kind: 'config-key', label: { en: 'test key', nl: 'testsleutel' }, how_to_enable: 'node .claude/forge-bin/forge-config.cjs set ecc-full-test on', scope: 'project', reversible: true, revert: 'set it off',
  class: 'SAFE', class_reason: ['none'], triggers: [{ keywords: { en: ['zebra'], nl: ['zebra'] } }], announce: { en: 'x', nl: 'x' }, evidence: 'test', default_state: 'config', config_key: 'ecc-full-test', on_values: [true], verify: [{ type: 'schema-key', target: 'ecc-full-test' }] });
const fl = A.plan('zebra', { catalog: flagCat }), fli = fl.safe_to_enable.find((x) => x.id === 'test-off-key');
t('a SAFE config key that is off by default is planned as a per-run --flag, never written', fli && fli.scope === 'run' && fli.config_flag && fli.config_flag['ecc-full-test'] === true && /never written/.test(fli.how_to_enable));
const PF = makeProject('proj-flag', { request: 'zebra' }); const fa = A.applyRun('run-1', { root: PF, catalog: flagCat });
t('apply records that per-run flag in config_flags and still writes no settings file', fa.code === 0 && fa.overlay.config_flags['ecc-full-test'] === true && !fs.existsSync(path.join(PF, '.claude', 'FORGE_CONFIG.json')));

// ---- 7) apply / revert round trip ----
console.log('7) apply/revert');
const P4 = makeProject('proj-apply', { request: 'maak een landingspagina voor een bakkerij met een lange run' });
fs.writeFileSync(path.join(P4, '.claude', 'forge-runs', 'run-1', 'plan-card.json'), JSON.stringify({ lanes: { expected: 3 } }));
const RUN = path.join(P4, '.claude', 'forge-runs', 'run-1'), OVER = path.join(RUN, 'anticipate.json'), CALLS = path.join(P4, '.claude', 'forge-dashboard', 'calls.jsonl');
const skip = (p) => p === OVER || p === CALLS;
const before = treeHash(P4, skip), cfgBefore = treeHash(CFG_HOME);
const ap = run(['apply', '--run', 'run-1', '--json'], { root: P4 }); let o1 = null; try { o1 = JSON.parse(fs.readFileSync(OVER, 'utf8')); } catch { /* asserted */ }
t('apply exits 0 and writes the run overlay with status applied', ap.status === 0 && o1 && o1.status === 'applied', ap.stderr);
t('apply took the text from run.json and the lanes (3) from plan-card.json', o1 && o1.input.lanes === 3 && ids(o1.applied).includes('lane-watchdog') && ids(o1.applied).includes('screenshot-loop'));
t('only SAFE run/session entries are active; gated ones only wait', o1 && o1.active.every((id) => byId[id].class === 'SAFE' && ['run', 'session'].includes(byId[id].scope)) && o1.waits_for_owner.every((w) => GATED.includes(w.id)));
t('lead actions carry the run id', o1 && o1.applied.find((a) => a.id === 'proactive-status').lead_action.includes('check run-1'));
t('nothing outside the overlay changed (project tree and config home hashes equal, no FORGE_CONFIG.json)', o1 && treeHash(P4, skip) === before && treeHash(CFG_HOME) === cfgBefore && !fs.existsSync(path.join(P4, '.claude', 'FORGE_CONFIG.json')));
const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
t('apply logs ONE agent_note through log-event.cjs', calls.length === 1 && calls[0][0] === 'run-1' && calls[0][1] === 'agent_note');
const rv = run(['revert', '--run', 'run-1'], { root: P4 }); const o2 = JSON.parse(fs.readFileSync(OVER, 'utf8'));
t('revert: status reverted, active [], the reverted list equals what was active', rv.status === 0 && o2.status === 'reverted' && !o2.active.length && JSON.stringify(o2.reverted) === JSON.stringify(o1.active));
t('revert twice is a calm no-op', /already reverted/.test(run(['revert', '--run', 'run-1'], { root: P4 }).stdout));
const ap2 = run(['apply', '--run', 'run-1', '--text', 'build a landing page', '--json'], { root: P4 });
t('apply again after revert: applied once more (round trip), still nothing else touched', ap2.status === 0 && JSON.parse(fs.readFileSync(OVER, 'utf8')).status === 'applied' && treeHash(P4, skip) === before);
t('apply refuses a missing run folder and a bad run id (exit 2, nothing written)', run(['apply', '--run', 'nope'], { root: P4 }).status === 2 && run(['apply', '--run', '../x'], { root: P4 }).status === 2 && !fs.existsSync(path.join(P4, '.claude', 'forge-runs', 'nope')));
t('revert with no overlay is a no-op (exit 0)', (() => { const P5 = makeProject('proj-norev', { request: 'x' }); return run(['revert', '--run', 'run-1'], { root: P5 }).status === 0; })());

// ---- 8) determinism; 9) garbage input ----
console.log('8) determinism + 9) garbage');
const d1 = run(['plan', '--text', SINK, '--json']).stdout, d2 = run(['plan', '--text', SINK, '--json']).stdout;
t('the same task gives byte-identical plan output', d1 && d1 === d2);
const e1 = run(['plan']); t('plan without --text: exit 0, one stderr line, no stdout', e1.status === 0 && e1.stderr.trim().split('\n').length === 1 && !e1.stdout.trim());
const e2 = run(['plan', '--json', '--wat']); let e2j = null; try { e2j = JSON.parse(e2.stdout); } catch { /* asserted */ }
t('plan with an unknown flag: exit 0, {"ok":false} with empty switches', e2.status === 0 && e2j && e2j.ok === false && Array.isArray(e2j.switches.auto_enabled));
const e3 = run(['plan', '--text', 'x', '--json', '--catalog', writeTmp('broken.json', '{not json')]);
t('a broken catalog: plan stays exit 0 and changes nothing', e3.status === 0 && JSON.parse(e3.stdout).ok === false && e3.stderr.trim().split('\n').length === 1);
const big = 'build '.repeat(200000) + '\u0000\u0007 ;;; $(x) `y` ' + 'landing page';
const tb = Date.now(); const bigRes = A.plan(big, {}); t('a 1.2 MB task with control characters is capped and planned fast (' + (Date.now() - tb) + ' ms)', bigRes.ok && Date.now() - tb < 15000);
t('a 19 kB task on the command line still plans', planJ('x'.repeat(19000) + ' landing page').j.ok === true);
t('--lanes garbage is ignored, not trusted', planJ('fix it', ['--lanes', 'abc']).j.signals.lanes === 1 && planJ('fix it', ['--lanes', '999']).j.signals.lanes === 12);
t('usage errors: unknown sub-command 2, explain unknown id 1, validate on garbage 3, metric bad --since 2',
  run(['dance']).status === 2 && run(['explain', 'nope']).status === 1 && run(['validate', '--catalog', writeTmp('g.json', '[1,2]')]).status === 3 && run(['metric', '--since', 'yesterdayish']).status === 2);

// ---- 9b) WP I.10: a bare "look up" is a feature, not research; training data and history call for real-file tests ----
console.log('9b) I.10 research false friend + real data for models');
{
  const P = (text) => planJ(text).j || { signals: { flags: {} }, matched: [] };
  const research = (text) => !!P(text).signals.flags.research;
  const fixtures = (text) => ids(P(text).matched).includes('real-fixtures');
  t('9b false friend: "Build an MCP server that lets Claude look up orders ..." fires no research signal', !research('Build an MCP server that lets Claude look up orders in our shop by order number, read-only, for the support team.'));
  t('9b false friend: "users can look up their order status" and "a look-up table for postcodes" fire no research signal', !research('Add a page where users can look up their order status') && !research('Build a look-up table for postcodes'));
  t('9b research forms still fire: "look up how other gyms price memberships", "look into the options", "zoek op hoe dat werkt"', research('Look up how other gyms price memberships and compare them') && research('Look into the options for hosting') && research('Zoek op hoe dat werkt bij andere bakkerijen'));
  t('9b a model trained on check-in history plans real-file tests (training data, history)', fixtures('Train a model that predicts which gym members will cancel next month from their check-in history') && fixtures('Fit a forecast on the historical data of our shop') && fixtures('Maak een model op de trainingsdata van vorig jaar'));
  t('9b false friend: "A history website for our local museum" plans no real-file tests', !fixtures('A history website for our local museum'));
  t('9b false friend: "Add an order history page to our webshop" and "show sample screens to the client" plan no real-file tests', !fixtures('Add an order history page to our webshop') && !fixtures('Show sample screens to the client'));
}

// ---- 10) the one-line announcement ----
console.log('10) announcement');
const TEXTS = [['nl', 'maak een landingspagina voor een bakkerij'], ['en', 'build a landing page for a bakery'], ['en', SINK], ['nl', 'fix de typfout'], ['en', 'git push to origin please'], ['nl', 'Bouw de module in 6 onafhankelijke delen en push het naar GitHub']];
for (const [lang, text] of TEXTS) {
  const j = planJ(text).j, a = j ? j.announcement : '';
  const cut = a.search(/Waits for you|Wacht op jou/), head = cut === -1 ? a : a.slice(0, cut);
  const gatedLabels = j ? j.gated_queue.map((g) => g.label) : [];
  t('[' + lang + '] one line, <= ' + A.MAX_LINE + ' chars (' + a.length + '), right language, gated items only after "waits": ' + a.slice(0, 60),
    a && a.length <= A.MAX_LINE && !/[\r\n]/.test(a) && (lang === 'nl' ? /^(Forge gebruikt|Niets extra|Forge heeft)/.test(a) : /^(Forge uses|Nothing extra|Forge needs)/.test(a)) && gatedLabels.every((l) => !head.includes(l + ',') && !head.includes(l + ' ') && !head.endsWith(l + '.')));
}

// ---- 11) metric (read-only); 12) explain ----
console.log('11) metric + 12) explain');
const P6 = makeProject('proj-metric');
const m0 = JSON.parse(run(['metric', '--json'], { root: P6 }).stdout);
t('no ledger: "metric not yet available" and how to get there (I.8c tags new prompts, retag back-fills older ones)', m0.available === false && m0.message === A.NOT_YET && /retag --toggle-correction --apply/.test(A.NOT_YET) && !/3\.8/.test(A.NOT_YET));
fs.mkdirSync(path.join(P6, '.claude', 'forge-scribe'), { recursive: true });
const LEDGER = path.join(P6, '.claude', 'forge-scribe', 'ledger.jsonl');
fs.writeFileSync(LEDGER, [{ op: 'open', rid: 'R-1', class: 'new', run_id: 'A', ts: '2026-10-20T10:00:00Z' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
const m1 = JSON.parse(run(['metric', '--json'], { root: P6 }).stdout);
t('today\'s unmarked ledger shape: not available yet (no guessing from free text)', m1.available === false && /no judged owner record yet/.test(m1.message));
fs.writeFileSync(LEDGER, [
  { op: 'open', rid: 'R-1', class: 'toggle-correction', run_id: 'A', ts: '2026-10-20T10:00:00Z' }, { op: 'classify', rid: 'R-1', class: 'toggle-correction', run_id: 'A', ts: '2026-10-20T10:01:00Z' },
  { op: 'open', rid: 'R-2', tags: ['toggle-correction'], run_id: 'A', ts: '2026-10-21T10:00:00Z' }, { op: 'open', rid: 'R-3', tags: ['toggle-correction'], run_id: 'B', ts: '2026-10-01T10:00:00Z' },
  { op: 'open', rid: 'R-4', tags: [], class: 'new', run_id: 'B', ts: '2026-10-22T10:00:00Z' }].map((x) => JSON.stringify(x)).join('\n') + '\n{broken line\n');
const lh = treeHash(path.dirname(LEDGER));
const m2 = JSON.parse(run(['metric', '--json'], { root: P6 }).stdout), m3 = JSON.parse(run(['metric', '--since', '2026-10-10', '--json'], { root: P6 }).stdout);
t('marked corrections are counted once per request and per mission (A 2, B 1), a broken line is tolerated', m2.available && m2.total === 3 && m2.per_mission.A === 2 && m2.per_mission.B === 1 && m2.malformed === 1);
t('--since filters by date (B\'s older correction drops out)', m3.total === 2 && !m3.per_mission.B);
t('metric never writes the ledger', treeHash(path.dirname(LEDGER)) === lh);
const P7 = makeProject('proj-metric-retag'); fs.mkdirSync(path.join(P7, '.claude', 'forge-scribe'), { recursive: true });
fs.writeFileSync(path.join(P7, '.claude', 'forge-scribe', 'ledger.jsonl'), [{ op: 'tag', rid: 'R-7', by: 'scribe', tags: ['toggle-correction'], run_id: 'C', ts: '2026-10-24T09:00:00Z', item_ts: '2026-09-01T10:00:00Z' },
  { op: 'tag', rid: 'R-8', by: 'scribe', tags: ['toggle-correction'], run_id: 'C', ts: '2026-10-24T09:00:00Z', item_ts: '2026-10-20T10:00:00Z' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
const m7 = JSON.parse(run(['metric', '--since', '2026-10-10', '--json'], { root: P7 }).stdout);
t('--since dates a back-filled tag op by its item (item_ts), not by the day of the back-fill', m7.available && m7.total === 1 && m7.per_mission.C === 1, JSON.stringify(m7));
const ex = run(['explain', 'lane-watchdog']);
t('explain shows the mechanism, class, scope, undo and live state', ex.status === 0 && ex.stdout.includes(byId['lane-watchdog'].how_to_enable) && /SAFE/.test(ex.stdout) && /state now: off/.test(ex.stdout));
// WP A5 (no Codex account): the codex-review schema default is `off`, so the live state reads off.
t('explain --json carries the entry and its live state', JSON.parse(run(['explain', 'codex-review', '--json']).stdout).live_state.state === 'off');

// ---- 13) plan-card contract ----
console.log('13) plan-card contract');
const pc = require('./forge-plan-card.cjs');
const mission = { goal: 'Add a contact page to the demo site', assumptions: [], question: null, packages: [{ id: 'A', goal: 'Build the page', owns: ['src/contact.js'], route: 'build' }],
  risks: [], wont_do: ['No email sending'], gates: [], proof: ['a screenshot'], switches: lpEn.switches };
const card = pc.buildCard(mission, { root: PROJ, mode: 'auto' });
t('plan --json `switches` has the documented fields', ['v', 'announcement', 'auto_enabled', 'waits_for_owner', 'already_on', 'respected_off'].every((k) => k in lpEn.switches));
t('a mission carrying `switches` still renders a card (today: a visible unknown-key warning, never an error)', card.ok && (card.warnings.some((w) => w.includes('switches')) || card.markdown.includes(lpEn.switches.announcement)));

// ---- 14) REAL-DATA REPLAY: the twelve owner switch requests ----
console.log('14) replay of the owner\'s twelve switch requests');
const SC = [
  { row: 1, sw: 'parallel lanes, no asking', cls: 'ALREADY-DEFAULT', text: 'Bouw de nieuwe importmodule in 6 onafhankelijke delen: parser, API, UI, tests, docs en datamodel', lanes: 6, on: ['parallel-lanes'], safe: ['lane-watchdog'], unenforced: ['parallel-lanes'] },
  { row: 2, sw: 'stop asking "moet ik verder?"', cls: 'ALREADY-DEFAULT', text: 'Werk de hele backlog af, fase na fase, en push het daarna naar GitHub', on: ['autonomy-continue', 'start-gate-off'], unenforced: ['autonomy-continue', 'start-gate-off'], gated: ['git-push'] },
  { row: 3, sw: 'everything on by default, usage guard 98 %', cls: 'SAFE (local) / credential guard not auto', text: 'Start een lange bouwrun: werk de hele backlog af met 4 lanes', on: ['usage-guard', 'autonomy-continue', 'git-checkpoint'], notSafe: ['usage-guard'] },
  // WP A5: Codex is off by default (no account), so a JWT/auth change no longer turns codex-review on.
  { row: 4, sw: 'Codex review', cls: 'OWNER-GATED', text: 'Pas de JWT-login en de sessie-auth middleware aan', gated: ['codex-adversarial-review'] },
  { row: 5, sw: 'watchdog with more than one lane', cls: 'SAFE', text: 'Build the checkout page, the admin panel and the API in parallel', lanes: 3, safe: ['lane-watchdog'] },
  { row: 6, sw: 'release newer updates', cls: 'OWNER-GATED', text: 'vergeet niet om de nieuwere updates te releasen', gated: ['release-publish'] },
  { row: 7, sw: 'deep-research workflow', cls: 'SAFE', text: 'onderzoek grondig welke vector database het beste past bij onze RAG-bot, met bronnen', safe: ['deep-research'], skills: ['deep-research'] },
  { row: 8, sw: 'proactive status', cls: 'SAFE', text: 'long run: finish the whole backlog with several lanes', lanes: 4, safe: ['proactive-status'] },
  { row: 9, sw: 'account rotator', cls: 'OWNER-GATED', text: 'als mijn account de usage limit raakt, wissel automatisch naar een ander account', gated: ['account-rotator'] },
  { row: 10, sw: 'model/effort per phase', cls: 'OWNER-GATED (costs usage)', text: 'planning met fable 5.1 effort:high, taken uitvoeren met opus 5.5 effort:high', gated: ['model-upgrade'] },
  { row: 11, sw: '/watch for video platforms', cls: 'SAFE', text: 'bekijk deze YouTube-video en vat de stappen samen: https://www.youtube.com/watch?v=abc123', safe: ['watch-video'] },
  { row: 12, sw: 'meta: stop making me say "zet dit aan"', cls: 'META (the engine)', text: 'maak een landingspagina voor een bakkerij in Utrecht', safe: ['craft-lens', 'screenshot-loop', 'frontend-design'], on: ['ui-quality'], noGated: true },
];
const rows = [];
for (const s of SC) {
  const j = planJ(s.text, s.lanes ? ['--lanes', String(s.lanes)] : []).j;
  const has = (list, want) => (want || []).every((id) => ids(j[list]).includes(id));
  const unenf = (s.unenforced || []).every((id) => { const x = j.already_on.find((a) => a.id === id); return x && x.enforced === false; });
  const ok = !!j && has('safe_to_enable', s.safe) && has('already_on', s.on) && has('gated_queue', s.gated) && unenf
    && (s.notSafe || []).every((id) => !ids(j.safe_to_enable).includes(id)) && (s.skills || []).every((k) => j.skills_to_use.includes(k))
    && GATED.every((id) => !ids(j.safe_to_enable).includes(id)) && (!s.noGated || !j.gated_queue.length) && j.announcement.length <= A.MAX_LINE;
  t('replay #' + s.row + ' ' + s.sw, ok, j ? 'safe=' + ids(j.safe_to_enable) + ' on=' + ids(j.already_on) + ' gated=' + ids(j.gated_queue) : 'no json');
  rows.push({ s, j, ok });
}
const r11 = planJ(SC[10].text, [], { home: EMPTY_HOME }).j;
t('replay #11 on a machine without the watch skill: skipped with a reason, never claimed', r11 && ids(r11.skipped).includes('watch-video') && !ids(r11.safe_to_enable).includes('watch-video'));
t('replay #5 negative control: one lane, no watchdog', !ids(planJ('Build the checkout page').j.matched).includes('lane-watchdog'));
if (process.env.ANTICIPATE_REPLAY_OUT) {
  const fmtL = (xs, f) => (xs || []).map(f || ((x) => x.id)).join(', ') || '-';
  const out = ['Anticipation replay (WP I.2, ' + 'generated by forge-anticipate.test.cjs from the owner\'s twelve switch requests in docs/audit/intelligence-evidence.md section 1)', '',
    '| # | Owner switch | Evidence class | Task context replayed | Auto (SAFE) | Already on | Waits for owner | Verdict |', '|---|---|---|---|---|---|---|---|'];
  for (const { s, j, ok } of rows) out.push('| ' + [s.row, s.sw, s.cls, s.text.replace(/\|/g, '/') + (s.lanes ? ' (lanes ' + s.lanes + ')' : ''), fmtL(j.safe_to_enable),
    fmtL(j.already_on, (x) => x.id + (x.gated ? ' [gated, allowed by setting]' : '') + (x.enforced === false ? ' [FLAG: not enforced]' : '')), fmtL(j.gated_queue), ok ? 'PASS' : 'FAIL'].join(' | ') + ' |');
  out.push('', 'One-line notes:'); for (const { s, j } of rows) out.push('#' + s.row + ': ' + j.announcement);
  fs.mkdirSync(path.dirname(process.env.ANTICIPATE_REPLAY_OUT), { recursive: true }); fs.writeFileSync(process.env.ANTICIPATE_REPLAY_OUT, out.join('\n') + '\n');
  console.log('  (replay table written to ' + process.env.ANTICIPATE_REPLAY_OUT + ')');
}

// ---- 16) WP I.8b: the Dutch security trap, plural/compound matching, signal fixes, each with a negative control ----
console.log('16) I.8b lexicon: security trap, negative controls, signal fixes');
const P = (text, extra) => A.plan(text, Object.assign({}, extra || {}));
const flag = (text, sig) => P(text).signals.flags[sig];
const SECURITY = [['nl', 'Pas de inlogflow aan zodat wachtwoorden en sessies veiliger zijn'], ['nl', 'Pas de inlogflow aan zodat wachtwoorden opnieuw gehasht worden met argon2 en sessies na 30 minuten verlopen.'],
  ['nl', 'rollen en rechten voor de beheerder'], ['nl', 'betaling via checkout met iDEAL'], ['nl', 'zet de tokens in de API achter een sleutel'],
  ['en', 'Build an internal admin dashboard with role-based access'], ['en', 'store the access tokens in the API encrypted'], ['en', 'Set up checkout with iDEAL for the shop'], ['en', 'make the login sessions expire after 30 minutes']];
for (const [lang, text] of SECURITY) {
  const j = P(text), useIds = j.skills_to_use.concat(ids(j.checks_to_run), ids(j.tools_to_run), ids(j.safe_to_enable));
  t('[' + lang + '] security trap "' + text.slice(0, 48) + '": adversarial review QUEUED (owner-gated), code review planned SAFE, ' + lang + ' line <= 200',
    !!j.signals.flags.security && ids(j.gated_queue).includes('codex-adversarial-review') && ids(j.safe_to_enable).includes('forge-code-review') && GATED.every((id) => !useIds.includes(id)) && j.lang === lang && j.announcement.length <= A.MAX_LINE,
    'flag=' + j.signals.flags.security + ' gated=' + ids(j.gated_queue) + ' safe=' + ids(j.safe_to_enable) + ' lang=' + j.lang);
}
const EACH = ['wachtwoorden', 'sessies', 'de inlogflow', 'het beheerderswachtwoord', 'de gebruikersrollen', 'tweestapsverificatie aanzetten', 'maak het formulier AVG-proof', 'de betalingen', 'role based access control', 'the password hashing'];
const missEach = EACH.filter((x) => !flag(x, 'security'));
t('each Dutch form hits on its own through the normaliser (plural, compound head/modifier, phrase): ' + EACH.length + ' forms', !missEach.length, missEach.join(' | '));
const NEG = ['plan een trainingssessie voor het team', 'maak een rollenspel voor de klas', 'doe een git checkout van main en fix de typo', 'build a booking page for coaching sessions', 'zet de afbeelding recht', 'link the open source code in the footer'];
const falseHits = NEG.filter((x) => flag(x, 'security'));
t('negative controls stay quiet: trainingssessie, rollenspel, git checkout, coaching sessions, "recht" (not "rechten"), "source" (not a security word)', !falseHits.length, falseHits.join(' | '));
const knop = P('wachtwoord-reset knop kleur aanpassen');
t('"wachtwoord-reset knop kleur aanpassen" is security-adjacent AND a UI change, announced in Dutch', !!knop.signals.flags.security && !!knop.signals.flags.web_ui && knop.lang === 'nl' && ids(knop.gated_queue).includes('codex-adversarial-review'), knop.announcement);
t('match direction: a keyword hits its plural and compounds by marker, never a shorter word',
  A.kwMatch('de wachtwoorden', 'wachtwoord') && A.kwMatch('de inlogflow', 'inlog-') && A.kwMatch('beheerderswachtwoord', '-wachtwoord-') && A.kwMatch('it parses logs', 'parse')
  && !A.kwMatch('het recht op inzage', 'rechten') && !A.kwMatch('een rollenspel', 'rollen') && !A.kwMatch('de trainingssessie', 'sessie') && !A.kwMatch('the source code', 'sources') && !A.kwMatch('inlogflow', 'inlog'));
t('no -er/-ed forms: a 2D platformer is not a "platform" (no PRD), a merger is not a "merge"; parsing still is "parse"',
  !A.kwMatch('a 2D platformer in Godot', 'platform') && !A.kwMatch('the company merger', 'merge') && A.kwMatch('fix the parsing', 'parse') && !ids(P('Make a 2D platformer in Godot with three levels, a double jump, collectible coins and a save system.').matched).includes('forge-prd'));
const dental = P('Build a website for a small dental clinic: treatments, the team, opening hours and an online appointment request form.');
t('"opening hours" is content, not a long run (no long-run status); "takes hours" and "overnight" still are; "within 24 hours" is not',
  !dental.signals.flags.long_running && !ids(dental.matched).includes('proactive-status') && !!flag('this migration takes hours, keep going overnight', 'long_running') && !flag('reply within 24 hours', 'long_running'));
const vid = (x) => ids(P(x).matched).includes('watch-video');
t('watch-video: only a video to study (URL, "deze video", research on TikTok/YouTube); course video\'s and embedded YouTube videos are content',
  vid('bekijk deze video: https://youtu.be/abc123') && vid('summarize the video at https://www.youtube.com/watch?v=x1') && vid('onderzoek wat er op TikTok over dit onderwerp wordt gezegd')
  && !vid('Bouw een e-learningsite voor onze fotografiecursus met modules, video\'s, korte quizzen en een certificaat aan het eind.') && !vid('embed our YouTube videos on the homepage'));
const ui = (x) => !!flag(x, 'web_ui');
// real-data replay (owner missions in .claude/forge-runs, paraphrased): a scout loop that searches YouTube/TikTok must still
// watch (evidence #11, "heb je ook TikTok/YouTube ... bekeken met /watch?"); "components" of GitHub repos is no web UI
t('owner replay: a scout loop that searches YouTube/TikTok watches; an embed check does not; GitHub repo "components" are not a UI',
  vid('een scout-loop: agents zoeken overal (GitHub/Reddit/YouTube/TikTok) naar verbeteringen') && vid('heb je ook TikTok en YouTube bekeken met /watch?') && !vid('check that the YouTube embed loads on mobile')
  && !ui('bekijk de files, components en ideeen van relevante github repos') && ui('build a React component library for the dashboard'));
t('web_ui: browser game, Expo / mobile app, an app people use; not a backend app or a version bump',
  ui('Make a simple drawing game for kids in the browser with an undo button') && ui('Bouw een mobiele app met Expo om gewoontes bij te houden') && ui('Build a recipe app where people can save recipes')
  && !ui('Build a Flask app that parses CSV files and returns JSON') && !ui('update the app version number'));
const fx = (x) => ids(P(x).matched).includes('real-fixtures');
t('real-file tests: parses / parser / parsen / access logs trigger; a readme typo does not', fx('a tool that parses our nginx access logs') && fx('fix the parser') && fx('de bankafschriften parsen') && !fx('fix the typo in the readme'));
const synt = (mut) => { const c = JSON.parse(JSON.stringify(CAT)); mut(c); return A.validateCatalog(c, {}); };
const sx = [[(c) => c.signals.security.keywords.nl.push('-app'), /compound marker/], [(c) => { c.signals.security.exclude = { en: ['git checkout'] }; }, /exclude needs/],
  [(c) => { c.signals.web_ui.together = [{ a: { en: ['app'], nl: ['app'] } }]; }, /together must be/], [(c) => c.entries.find((e) => e.id === 'git-push').triggers[0].keywords.en.push('***'), /holds no word/]];
t('validate refuses a short compound marker, a one-language exclude, a half pair and an empty keyword', sx.every(([m, re]) => { const r = synt(m); return !r.ok && r.problems.some((p) => re.test(p)); }));

// ---- 15) tool mutants: each must flip a guarded outcome ----
console.log('15) tool mutants');
{
  const src = fs.readFileSync(CLI, 'utf8'), lines = src.replace(/\n$/, '').split('\n').length;
  t('m0 the tool stays under 500 lines (' + lines + ') with each mutation marker on ONE line', lines < 500 && ['ANTICIPATE-CLASSIFIER-CALL', 'ANTICIPATE-LEXICON', 'ANTICIPATE-GATED-TEST', 'ANTICIPATE-KILLSWITCH', 'ANTICIPATE-BIN-DIR'].every((m) => src.split(m).length === 2));
  const mutant = (name, pairs) => { let body = src.replace('const BIN_DIR = __dirname;', 'const BIN_DIR = ' + JSON.stringify(__dirname) + ';'); let n = 0;
    for (const [f, r] of pairs) { n += body.split(f).length - 1; body = body.split(f).join(r); } const p = path.join(TMP, 'mutant-' + name + '.cjs'); fs.writeFileSync(p, body); return { n, cli: p, want: pairs.length }; };
  const flipped = JSON.parse(JSON.stringify(CAT)); Object.assign(flipped.entries.find((e) => e.id === 'git-push'), { class: 'SAFE', class_reason: ['none'], reversible: true });
  const fp = writeTmp('flip-git-push.json', flipped);
  const noCls = "return req('forge-actiongate.cjs').classify(String(text), { projectRoot: INSTALL_ROOT }); }", noLex = 'for (const [reason, re] of RISK_WORDS) {';
  const m1 = mutant('no-classifier', [[noCls, "return { gate: false }; }"]]);
  const v1 = JSON.parse(run(['validate', '--json', '--catalog', fp], { cli: m1.cli }).stdout || '{}');
  t('m1 classifier call stubbed -> git-push flipped to SAFE no longer names forge-actiongate (the lexicon still refuses it)', m1.n === 1 && v1.ok === false && !v1.problems.some((p) => p.includes('forge-actiongate')) && A.validateCatalog(flipped, {}).problems.some((p) => p.includes('forge-actiongate')));
  const m2 = mutant('no-cross-check', [[noCls, "return { gate: false }; }"], [noLex, 'for (const [reason, re] of []) {']]);
  t('m2 classifier AND lexicon disabled -> the flipped git-push passes validate (mutant killed: real tool exits 3)', m2.n === 2 && run(['validate', '--catalog', fp], { cli: m2.cli }).status === 0 && run(['validate', '--catalog', fp]).status === 3);
  const m3 = mutant('gated-leak', [["gated = e.class !== 'SAFE'; // ANTICIPATE-GATED-TEST", 'gated = false;']]);
  const g3 = planJ(SC[3].text, [], { cli: m3.cli }).j;
  t('m3 the gated test removed -> the Codex adversarial review leaks into safe_to_enable (mutant killed)', m3.n === 1 && g3 && ids(g3.safe_to_enable).includes('codex-adversarial-review') && !ids(planJ(SC[3].text).j.safe_to_enable).includes('codex-adversarial-review'));
  const m4 = mutant('no-killswitch', [["enabled: read('anticipate', true).value !== false", 'enabled: true']]);
  const k4 = planJ(SINK, [], { root: P3, cli: m4.cli }).j;
  t('m4 the kill switch ignored -> plans despite anticipate=off (mutant killed)', m4.n === 1 && k4 && k4.enabled === true && k4.matched.length > 0 && kill.enabled === false);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort: the OS cleans its temp folder */ }
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
