#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-intelligence.test.cjs — I.6 (Forge Intelligence): the four run-shape rules
 * (plan-card-recorded, anticipation-recorded, parallelism-considered, craft-review-recorded) and the craft
 * `record` / `check` commands. Hermetic: every fixture lives in one os.mkdtemp folder (removed at the end); the real
 * project is only read (the production FORGE_HARD_RULES.json, the lenses, the real tools).
 *   A. opt-in by run shape: a run that declares no shape is judged EXACTLY like the registry without these rules
 *   B-E. each rule: shape absent -> not applicable; shape + no evidence -> red with its NL+EN message; evidence ->
 *        green; the recorded exception -> green and listed in `exceptions`; a bad exception -> still red
 *   F. craft record validation: every refusal mode writes nothing; source MUTATIONS prove the tests bite
 *   G. plan wiring: `plan` names the next command; the check CLI prints next/NL lines
 *   H. replay of the real flow (plan card -> anticipate apply -> serial reason -> craft record -> finalize) in the
 *      legacy AND the .forge layout, with the real writer, tools and finalize: finalize is refused at every stage
 *      and FINALIZED only at the end.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const CLAUDE_SRC = path.join(BIN, '..');
const REAL_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const LENS_SRC = path.join(CLAUDE_SRC, 'config', 'quality', 'lenses');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-i6-')));
const CFG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(CFG_HOME, { recursive: true });
// hermetic owner settings for every in-process tool (forge-config reads FORGE_CONFIG_HOME); no foreign project root
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete process.env[k];
process.env.FORGE_CONFIG_HOME = CFG_HOME;

const RC = require('./forge-runcontract.cjs');
const C = require('./forge-craft.cjs');
const PC = require('./forge-plan-card.cjs');
const A = require('./forge-anticipate.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const I6_IDS = ['plan-card-recorded', 'anticipation-recorded', 'parallelism-considered', 'craft-review-recorded'];
const PROD = JSON.parse(fs.readFileSync(REAL_RULES, 'utf8'));
const ev = (o) => JSON.stringify(o);
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
let rootN = 0;

/** mkRoot({forge, rules}) -> a project root with the production rules (or `rules`) and the real lenses. */
function mkRoot(opts) {
  opts = opts || {};
  const root = mk(TMP, 'p' + (++rootN));
  mk(root, '.claude', 'config', 'orchestration');
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), opts.rules ? JSON.stringify(opts.rules, null, 2) : fs.readFileSync(REAL_RULES));
  const ld = mk(root, '.claude', 'config', 'quality', 'lenses');
  for (const f of fs.readdirSync(LENS_SRC)) fs.copyFileSync(path.join(LENS_SRC, f), path.join(ld, f));
  if (opts.forge) mk(root, '.forge');
  return root;
}
const runDirIn = (root, id) => (fs.existsSync(path.join(root, '.forge')) ? path.join(root, '.forge', 'runs', id) : path.join(root, '.claude', 'forge-runs', id));
/** writeRun(root, id, events, files) — raw event lines (no writer) + run-folder files (objects are JSON-encoded). */
function writeRun(root, id, events, files) {
  const dir = mk(runDirIn(root, id));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => (typeof e === 'string' ? e : ev(e))).join('\n') + '\n');
  for (const [n, v] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, n), typeof v === 'string' ? v : JSON.stringify(v));
  return dir;
}
const chk = (root, id, extra) => RC.check(Object.assign({ run_id: id }, extra || {}), { root, ownerProfilePath: NO_PROFILE });
const BASE_EVENTS = [
  { event_type: 'run_started', agent: 'orchestrator' },
  { event_type: 'memory_loaded', agent: 'orchestrator' },
  { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
  { event_type: 'research_done', agent: 'orchestrator', note: 'searched existing implementations first' },
];
const decision = (rule, extra) => Object.assign({ event_type: 'decision_logged', agent: 'orchestrator', rule, decision: 'not-applicable', reason: 'a single static file, a plan card adds nothing here' }, extra || {});

/** a real plan card (forge-plan-card buildCard), saved the way `--run` saves it (minus card/saved). */
function planCardJson(root, packages) {
  const mission = { goal: 'Build a landing page for a bakery', assumptions: [], packages, risks: [], wont_do: ['no live deploy'], gates: [], proof: ['tests and screenshots'] };
  const res = PC.buildCard(mission, { mode: 'auto', root });
  if (!res.ok) throw new Error('mission invalid: ' + res.problems.join('; '));
  const { card, saved, ...json } = res.json; // eslint-disable-line no-unused-vars
  return json;
}
const CHAIN4 = [
  { id: 'A', goal: 'write the data schema', owns: ['src/schema/'], route: 'build' },
  { id: 'B', goal: 'build the menu page on the schema', owns: ['src/menu/'], route: 'build', deps: ['A'] },
  { id: 'C', goal: 'build the order form on the menu', owns: ['src/order/'], route: 'build', deps: ['B'] },
  { id: 'D', goal: 'write the copy for every page', owns: ['src/copy/'], route: 'quick', deps: ['C'] },
];
const PARALLEL4 = CHAIN4.map((p) => Object.assign({}, p, { deps: [] }));
const COLLIDE4 = PARALLEL4.map((p, i) => Object.assign({}, p, { owns: i < 2 ? ['src/shared/'] : p.owns }));

/** the filled craft form for `type` (all CLEAN with evidence); tweak(form, checkById) adjusts it. */
function templateFor(root, type) {
  const lines = [];
  const code = C.main(['review-template', '--type', type, '--json', '--root', root], { out: (s) => lines.push(s), err: () => {} });
  if (code !== 0) throw new Error('review-template exit ' + code);
  return JSON.parse(lines.join('\n'));
}
function fillForm(root, type, tweak) {
  const f = templateFor(root, type);
  f.deliverable = 'Bakery landing page (site/index.html)'; f.where = ['site/index.html', 'artifacts/']; f.reviewer = 'Review Boss';
  for (const l of f.lenses) {
    for (const q of l.first_ten_seconds) q.answer = 'Saw the hero, the menu and the order button within ten seconds.';
    for (const s of l.stakeholders) {
      s.notice_in_10_seconds = 'The order button is visible above the fold at 390px.';
      s.notice_on_closer_inspection = 'Every footer link resolves to a real page.';
      for (const c of s.checks) { c.mark = 'CLEAN'; c.evidence = 'artifacts/home-390.png read, plus 768 and 1440 px'; c.finding = 'nothing a ' + s.id + ' would notice'; }
    }
  }
  const byId = (id) => f.lenses.flatMap((l) => l.stakeholders.flatMap((s) => s.checks)).find((c) => c.id === id);
  if (tweak) tweak(f, byId);
  return f;
}
const lensOf = (type) => JSON.parse(fs.readFileSync(path.join(LENS_SRC, type + '.json'), 'utf8'));
const WEB = lensOf('web-ui');
const BLOCK_IDS = WEB.checks.filter((c) => c.severity === 'block').map((c) => c.id);
const WARN_IDS = WEB.checks.filter((c) => c.severity === 'warn').map((c) => c.id);

console.log('forge-runcontract I.6 tests (run-shape rules + craft record; hermetic root=' + TMP + ')');

try {
  // ================================================================================================
  console.log('\nA) the registry, and opt-in by run shape (no shape = judged exactly as before)');
  // ================================================================================================
  {
    const meta = RC.loadRulesMeta(REAL_RULES);
    const byId = Object.fromEntries(meta.data.rules.map((r) => [r.id, r]));
    t('the four I.6 rules load with this checker, nothing degraded', I6_IDS.every((id) => byId[id]) && !meta.unknownTriggers.length && !meta.unknownCheckTypes.length);
    t('each is a BLOCK run-evidence rule with a run-shape trigger, overridable by the owner, with message {en,nl} and next_step',
      I6_IDS.every((id) => { const r = byId[id]; return r.severity === 'block' && r.check.type === 'run-evidence' && /^run-shape:/.test(r.trigger) && r.cannot_override === undefined && r.since === undefined
        && r.message && r.message.en.length > 60 && r.message.nl.length > 60 && typeof r.next_step === 'string'; }));
    t('phases: plan card + anticipation are due at preview, parallelism while working, craft before done',
      byId['plan-card-recorded'].phase === 'preview' && byId['anticipation-recorded'].phase === 'preview' && byId['parallelism-considered'].phase === 'wp' && byId['craft-review-recorded'].phase === 'complete');
    t('every exception uses the registered decision_logged event; parallelism needs a named blocker', I6_IDS.every((id) => byId[id].check.exception.event === 'decision_logged') && JSON.stringify(byId['parallelism-considered'].check.exception.require) === '["blocking"]');
    t('the lifecycle table has the intelligence-shape row naming exactly these rules', PROD.lifecycle.some((row) => row.id === 'intelligence-shape' && JSON.stringify(row.rule_ids.slice().sort()) === JSON.stringify(I6_IDS.slice().sort())));
    t('a run-shape trigger with an unknown shape degrades like any unknown trigger (reported, not crashed)', RC.isValidTrigger('run-shape:plan-card') && !RC.isValidTrigger('run-shape:moon') && RC.isWellFormedTrigger('run-shape:moon'));
    t('ruleApplies without a shape (an older caller) never applies a run-shape rule', RC.ruleApplies(byId['plan-card-recorded'], null, 'L4') === false);
  }
  {
    // the same fixtures judged by the production registry and by the registry WITHOUT the I.6 rules
    const without = JSON.parse(JSON.stringify(PROD));
    without.rules = without.rules.filter((r) => !I6_IDS.includes(r.id));
    const rootA = mkRoot(), rootB = mkRoot({ rules: without });
    const fixtures = {
      'no-runjson': [BASE_EVENTS.concat([{ event_type: 'prd_generated', agent: 'orchestrator' }, { event_type: 'agent_started', agent: 'Build Boss' }, { event_type: 'check_passed', agent: 'Test Boss', task: 'suite' }]), { 'final-report.md': '# r\n' }],
      'legacy-runjson': [BASE_EVENTS, { 'run.json': { run_id: 'x', domain: 'website', complexity: 'L3', status: 'running', mission: 'build a site' } }],
      'below-thresholds': [BASE_EVENTS, { 'run.json': { work_packages: 2, lanes: { expected: 1 }, deliverable_types: ['code', 'api-and-integration'] } }],
      'ten-wps-in-events': [BASE_EVENTS.concat(Array.from({ length: 10 }, (_, i) => ({ event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP' + i }))), {}],
      'stale-overlay-1-lane': [BASE_EVENTS, { 'anticipate.json': { v: 1, run_id: 'stale-overlay-1-lane', status: 'applied', input: { lanes: 1 } } }],
    };
    const pick = (r) => JSON.stringify({ ok: r.ok, satisfied: r.satisfied, missing: r.missing, warnings: r.warnings, overridden: r.overridden, rule_details: r.rule_details, unevaluated: r.unevaluated,
      historical_exempt: r.historical_exempt, not_applicable: r.not_applicable, phase_deferred: r.phase_deferred, complexity: r.complexity });
    for (const [id, [evs, files]] of Object.entries(fixtures)) {
      writeRun(rootA, id, evs, files); writeRun(rootB, id, evs, files);
      for (const phase of [undefined, 'preview', 'wp']) {
        const a = chk(rootA, id, { phase }), b = chk(rootB, id, { phase });
        t('no shape [' + id + (phase ? ', phase ' + phase : '') + ']: identical to the registry without the I.6 rules', pick(a) === pick(b), pick(a) + ' vs ' + pick(b));
      }
      const r = chk(rootA, id);
      t('no shape [' + id + ']: run_shape says nothing is declared and no exception is listed', r.run_shape.declares_shape === false && r.exceptions.length === 0 && I6_IDS.every((x) => !r.satisfied.includes(x) && !r.missing.includes(x)));
    }
    const thr = mkRoot();
    const shapeOf = (id, files) => { writeRun(thr, id, BASE_EVENTS, files); return chk(thr, id).run_shape.applies; };
    t('boundary: 2 work packages is no plan-scale, 3 is', shapeOf('wp2', { 'run.json': { work_packages: 2 } })['plan-scale'] === false && shapeOf('wp3', { 'run.json': { work_packages: ['a', 'b', 'c'] } })['plan-scale'] === true);
    t('boundary: 1 expected lane is no plan-scale, 2 is (lanes.expected, lanes_expected or a number)', shapeOf('l1', { 'run.json': { lanes: { expected: 1 } } })['plan-scale'] === false
      && shapeOf('l2a', { 'run.json': { lanes: { expected: 2 } } })['plan-scale'] && shapeOf('l2b', { 'run.json': { lanes_expected: '2' } })['plan-scale'] && shapeOf('l2c', { 'run.json': { lanes: 3 } })['plan-scale']);
    t('a visible type declared as "a, b" text counts; a non-visible type does not', shapeOf('vis', { 'run.json': { deliverable_types: 'Copy And Content, code' } })['visible-deliverable'] === true && shapeOf('novis', { 'run.json': { deliverable_types: ['code'] } })['visible-deliverable'] === false);
    t('the domain never implies a deliverable (domain website, no deliverable_types -> no craft shape)', shapeOf('dom', { 'run.json': { domain: 'website' } })['visible-deliverable'] === false);
  }

  // ================================================================================================
  console.log('\nB) plan-card-recorded');
  // ================================================================================================
  {
    const root = mkRoot();
    writeRun(root, 'pc-red', BASE_EVENTS, { 'run.json': { work_packages: 4 } });
    const r = chk(root, 'pc-red');
    const d = r.rule_details['plan-card-recorded'] || {};
    t('shape + no card: plan-card-recorded is MISSING (block) and the contract is NOT DONE', r.ok === false && r.missing.includes('plan-card-recorded'));
    t('... the reason names the folder and why the rule applies', /no plan card in \.claude\/forge-runs\/pc-red \(plan-card\.json\)/.test(d.reason) && /run\.json declares 4 work packages/.test(d.reason), d.reason);
    t('... the EN message gives the exact command with the run id and the exception path', /forge-plan-card\.cjs --file <mission\.json> --run pc-red/.test(d.message.en) && /log-event\.cjs pc-red decision_logged/.test(d.message.en) && /"not-applicable"/.test(d.message.en), d.message && d.message.en);
    t('... the NL message says the same in Dutch', /Schrijf de plankaart/.test(d.message.nl) && /--run pc-red/.test(d.message.nl));
    t('... next_step is the one command, run id filled in', d.next_step === 'node .claude/forge-bin/forge-plan-card.cjs --file <mission.json> --run pc-red', d.next_step);
    for (const [label, files] of [['lanes.expected 2', { 'run.json': { lanes: { expected: 2 } } }], ['anticipation counted 3 parts', { 'anticipate.json': { v: 1, run_id: 'x', status: 'applied', input: { lanes: 3 } } }]]) {
      const id = 'pc-' + label.replace(/\W+/g, '-');
      writeRun(root, id, BASE_EVENTS, files);
      t('shape via ' + label + ' -> the rule applies (missing without a card)', chk(root, id).missing.includes('plan-card-recorded'));
    }
    writeRun(root, 'pc-green', BASE_EVENTS, { 'run.json': { work_packages: 4 }, 'plan-card.json': planCardJson(root, PARALLEL4), 'anticipate.json': { v: 1, run_id: 'pc-green', status: 'applied', active: [], input: {} } });
    const g = chk(root, 'pc-green');
    t('a real plan card (forge-plan-card buildCard) satisfies it (via evidence)', g.satisfied.includes('plan-card-recorded') && g.rule_details['plan-card-recorded'].via === 'evidence' && /plan card [0-9a-f]{12} is recorded/.test(g.rule_details['plan-card-recorded'].reason), JSON.stringify(g.rule_details['plan-card-recorded']));
    writeRun(root, 'pc-garbage', BASE_EVENTS, { 'run.json': { work_packages: 4 }, 'plan-card.json': '{not json' });
    t('an unreadable plan-card.json does not count (reason says unreadable)', /unreadable \(not valid JSON\)/.test(chk(root, 'pc-garbage').rule_details['plan-card-recorded'].reason));
    writeRun(root, 'pc-nohash', BASE_EVENTS, { 'run.json': { work_packages: 4 }, 'plan-card.json': { ok: true, lanes: { expected: 2 } } });
    t('a plan-card.json without a card hash does not count (not written by forge-plan-card --run)', /carries no card hash/.test(chk(root, 'pc-nohash').rule_details['plan-card-recorded'].reason));
    writeRun(root, 'pc-exc', BASE_EVENTS.concat([decision('plan-card-recorded')]), { 'run.json': { work_packages: 4 } });
    const e = chk(root, 'pc-exc');
    t('the recorded exception satisfies it, says via exception and is listed in result.exceptions', e.satisfied.includes('plan-card-recorded') && e.rule_details['plan-card-recorded'].via === 'exception'
      && e.exceptions.some((x) => x.id === 'plan-card-recorded' && x.by === 'orchestrator' && /single static file/.test(x.reason)), JSON.stringify(e.exceptions));
    const bad = [
      ['a reason that is too short', decision('plan-card-recorded', { reason: 'no need' }), /not accepted: reason must say why/],
      ['a reason that is only the rule id', decision('plan-card-recorded', { reason: 'plan-card-recorded' }), /not accepted: reason must say why/],
      ['the wrong decision', decision('plan-card-recorded', { decision: 'skip' }), /not accepted: decision must be not-applicable/],
      ['a near-miss rule id', decision('plan-card-recorde'), /no plan card/],
      ['an agent_note that only mentions it', { event_type: 'agent_note', agent: 'orchestrator', note: 'override:plan-card-recorded not-applicable — trivial' }, /no plan card/],
      ['a decision the writer disproved', Object.assign(decision('plan-card-recorded'), { _forge_verify: { proof_verified: false } }), /writer disproved it/],
    ];
    bad.forEach(([label, event, re], i) => {
      writeRun(root, 'pc-bad' + i, BASE_EVENTS.concat([event]), { 'run.json': { work_packages: 4 } });
      const b = chk(root, 'pc-bad' + i);
      t('a bad exception (' + label + ') leaves it MISSING and says why', b.missing.includes('plan-card-recorded') && re.test(b.rule_details['plan-card-recorded'].reason) && !b.exceptions.length, b.rule_details['plan-card-recorded'].reason);
    });
    writeRun(root, 'pc-owner', BASE_EVENTS.concat([{ event_type: 'owner_override', rule: 'plan-card-recorded', reason: 'owner reviewed: tiny hotfix, no card wanted', by: 'owner' }]), { 'run.json': { work_packages: 4 } });
    const o = chk(root, 'pc-owner');
    t('a valid owner_override clears it (owner path) and is reported as overridden', o.overridden.some((x) => x.id === 'plan-card-recorded') && !o.missing.includes('plan-card-recorded'));
    writeRun(root, 'pc-notowner', BASE_EVENTS.concat([{ event_type: 'owner_override', rule: 'plan-card-recorded', reason: 'build boss says it is fine', by: 'build-boss' }]), { 'run.json': { work_packages: 4 } });
    t('an owner_override by a non-owner does not', chk(root, 'pc-notowner').missing.includes('plan-card-recorded'));
  }

  // ================================================================================================
  console.log('\nC) anticipation-recorded');
  // ================================================================================================
  {
    const root = mkRoot();
    const card = planCardJson(root, PARALLEL4);
    writeRun(root, 'an-red', BASE_EVENTS, { 'plan-card.json': card });
    const r = chk(root, 'an-red');
    const d = r.rule_details['anticipation-recorded'] || {};
    t('a plan card without anticipate.json: anticipation-recorded is MISSING', r.missing.includes('anticipation-recorded') && /this run has a plan card but no anticipate\.json in \.claude\/forge-runs\/an-red/.test(d.reason), d.reason);
    t('... message: the apply command for this run + the "anticipate off" exception, in EN and NL', /forge-anticipate\.cjs apply --run an-red/.test(d.message.en) && /anticipate off/.test(d.message.en) && /anticipatie uit/.test(d.message.nl));
    t('... and plan-card-recorded is satisfied by the same card (4 packages = plan-scale)', r.satisfied.includes('plan-card-recorded'));
    for (const status of ['applied', 'reverted']) {
      writeRun(root, 'an-' + status, BASE_EVENTS, { 'plan-card.json': card, 'anticipate.json': { v: 1, tool: 'forge-anticipate.cjs', run_id: 'an-' + status, status, active: status === 'applied' ? ['craft-lens'] : [], waits_for_owner: [] } });
      t('anticipate.json status ' + status + ' for this run satisfies it', chk(root, 'an-' + status).satisfied.includes('anticipation-recorded'));
    }
    const cases = [
      ['a non-final status', { v: 1, run_id: 'an-c0', status: 'planned' }, /status "planned" \(applied or reverted is needed\)/],
      ['an overlay of another run', { v: 1, run_id: 'some-other-run', status: 'applied' }, /belongs to run "some-other-run"/],
      ['an unreadable overlay', '[1,2]', /unreadable \(not a JSON object\)/],
    ];
    cases.forEach(([label, overlay, re], i) => {
      writeRun(root, 'an-c' + i, BASE_EVENTS, { 'plan-card.json': card, 'anticipate.json': overlay });
      const c = chk(root, 'an-c' + i);
      t(label + ' does not count', c.missing.includes('anticipation-recorded') && re.test(c.rule_details['anticipation-recorded'].reason), c.rule_details['anticipation-recorded'].reason);
    });
    writeRun(root, 'an-off', BASE_EVENTS.concat([decision('anticipation-recorded', { reason: 'anticipate off: the owner set anticipate=false for this project' })]), { 'plan-card.json': card });
    const off = chk(root, 'an-off');
    t('the "anticipate off" exception satisfies it, visibly', off.satisfied.includes('anticipation-recorded') && off.exceptions.some((x) => x.id === 'anticipation-recorded' && /anticipate off/.test(x.reason)));
    // the forge layout: the overlay is read from .forge/runs/<id>
    const froot = mkRoot({ forge: true });
    writeRun(froot, 'an-forge', BASE_EVENTS, { 'plan-card.json': card, 'anticipate.json': { v: 1, run_id: 'an-forge', status: 'applied' } });
    const fr = chk(froot, 'an-forge');
    t('forge layout: the plan card and overlay in .forge/runs/<id> are read (both rules met)', fr.satisfied.includes('anticipation-recorded') && fr.satisfied.includes('plan-card-recorded') && fs.existsSync(path.join(froot, '.forge', 'runs', 'an-forge', 'anticipate.json')));
  }

  // ================================================================================================
  console.log('\nD) parallelism-considered');
  // ================================================================================================
  {
    const root = mkRoot();
    const chain = planCardJson(root, CHAIN4), par = planCardJson(root, PARALLEL4), col = planCardJson(root, COLLIDE4);
    t('fixture: the 4-package chain has 1 expected lane and no collision; the parallel plan has 4; the colliding plan names its shared file',
      chain.lanes.expected === 1 && chain.lanes.collisions.length === 0 && par.lanes.expected === 4 && col.lanes.collisions.length === 1);
    const anOk = (id) => ({ v: 1, run_id: id, status: 'applied' });
    writeRun(root, 'par-red', BASE_EVENTS, { 'plan-card.json': chain, 'anticipate.json': anOk('par-red') });
    const r = chk(root, 'par-red');
    const d = r.rule_details['parallelism-considered'] || {};
    t('4 disjoint packages in 1 lane, no reason: parallelism-considered is MISSING', r.missing.includes('parallelism-considered') && /4 packages with no file shared inside a wave, yet the run has 1 expected lane \(plan-card\.json\)/.test(d.reason), d.reason);
    t('... message: run them in parallel or name the blocker, EN + NL, with the decision_logged command', /"blocking"/.test(d.message.en) && /parallel lanes/.test(d.message.en) && /parallelle lanes/.test(d.message.nl) && /log-event\.cjs par-red decision_logged/.test(d.next_step));
    writeRun(root, 'par-runjson', BASE_EVENTS, { 'plan-card.json': par, 'anticipate.json': anOk('par-runjson'), 'run.json': { lanes: { expected: 1 } } });
    t('a parallel plan that the run declares as 1 lane (run.json) also owes the reason', /\(run\.json\)/.test((chk(root, 'par-runjson').rule_details['parallelism-considered'] || {}).reason || ''));
    writeRun(root, 'par-parallel', BASE_EVENTS, { 'plan-card.json': par, 'anticipate.json': anOk('par-parallel') });
    writeRun(root, 'par-collide', BASE_EVENTS, { 'plan-card.json': col, 'anticipate.json': anOk('par-collide'), 'run.json': { lanes: { expected: 1 } } });
    writeRun(root, 'par-three', BASE_EVENTS, { 'plan-card.json': planCardJson(root, CHAIN4.slice(0, 3)), 'anticipate.json': anOk('par-three') });
    for (const id of ['par-parallel', 'par-collide', 'par-three']) {
      const x = chk(root, id);
      t('not applicable [' + id + ']: 4 lanes, or a named shared file, or fewer than 4 packages', !x.missing.includes('parallelism-considered') && !x.satisfied.includes('parallelism-considered') && x.run_shape.applies['serial-plan'] === false);
    }
    writeRun(root, 'par-noblock', BASE_EVENTS.concat([decision('parallelism-considered', { decision: 'serial', reason: 'each package uses the output of the previous one' })]), { 'plan-card.json': chain, 'anticipate.json': anOk('par-noblock') });
    t('a serial decision that names no blocker does not count (and says so)', /"blocking" must name the file, lock or dependency/.test(chk(root, 'par-noblock').rule_details['parallelism-considered'].reason));
    writeRun(root, 'par-ok', BASE_EVENTS.concat([decision('parallelism-considered', { decision: 'serial', blocking: 'dependency chain A->B->C->D (each reads the previous output)', reason: 'each package uses the output of the previous one' })]), { 'plan-card.json': chain, 'anticipate.json': anOk('par-ok') });
    const ok = chk(root, 'par-ok');
    t('a serial decision naming the blocker satisfies it (via reason, the blocker in the details)', ok.satisfied.includes('parallelism-considered') && ok.rule_details['parallelism-considered'].via === 'reason' && /blocking: dependency chain/.test(ok.rule_details['parallelism-considered'].reason) && !ok.exceptions.some((x) => x.id === 'parallelism-considered'));
    writeRun(root, 'par-na', BASE_EVENTS.concat([decision('parallelism-considered', { blocking: 'usage-limit (80 percent reached)', reason: 'usage guard reached 80 percent, no new lanes' })]), { 'plan-card.json': chain, 'anticipate.json': anOk('par-na') });
    t('not-applicable with a blocker is the exception path (listed in exceptions)', chk(root, 'par-na').exceptions.some((x) => x.id === 'parallelism-considered'));
  }

  // ================================================================================================
  console.log('\nE) craft-review-recorded');
  // ================================================================================================
  {
    const root = mkRoot();
    const runDecl = { deliverable_types: ['web-ui'] };
    writeRun(root, 'cr-red', BASE_EVENTS, { 'run.json': runDecl });
    const r = chk(root, 'cr-red');
    const d = r.rule_details['craft-review-recorded'] || {};
    t('a declared web-ui deliverable without a recorded review: craft-review-recorded is MISSING', r.missing.includes('craft-review-recorded') && /web-ui: no craft review recorded \(craft-review-web-ui\.json in \.claude\/forge-runs\/cr-red\)/.test(d.reason), d.reason);
    t('... message: review-template, fill with evidence, record — for this run and type, EN + NL', /review-template --type web-ui --json/.test(d.message.en) && /record --run cr-red --type web-ui --file review\.json/.test(d.message.en) && /door de ogen van elke belanghebbende/.test(d.message.nl));
    writeRun(root, 'cr-two', BASE_EVENTS, { 'run.json': { deliverable_types: 'web-ui, copy-and-content' } });
    t('two declared visible types: both are listed as open', (chk(root, 'cr-two').rule_details['craft-review-recorded'].types || []).map((x) => x.type).join() === 'web-ui,copy-and-content');
    writeRun(root, 'cr-antype', BASE_EVENTS, { 'anticipate.json': { v: 1, run_id: 'cr-antype', status: 'applied', input: { type: 'game-and-interactive', lanes: 1 } } });
    t('the anticipation overlay\'s deliverable type also declares the shape', chk(root, 'cr-antype').missing.includes('craft-review-recorded'));
    writeRun(root, 'cr-green', BASE_EVENTS, { 'run.json': runDecl });
    const rec = C.recordReview({ root, runId: 'cr-green', type: 'web-ui', form: fillForm(root, 'web-ui'), log: false });
    t('a valid filled review is recorded (code 0)', rec.code === 0 && rec.ok && fs.existsSync(path.join(runDirIn(root, 'cr-green'), 'craft-review-web-ui.json')), JSON.stringify(rec.problems));
    const g = chk(root, 'cr-green');
    t('... and satisfies the rule (via evidence)', g.satisfied.includes('craft-review-recorded') && g.rule_details['craft-review-recorded'].via === 'evidence', JSON.stringify(g.rule_details['craft-review-recorded']));
    // an accepted weakness on a BLOCK check stays unresolved; a fix resolves it
    writeRun(root, 'cr-weak', BASE_EVENTS, { 'run.json': runDecl });
    const weakForm = fillForm(root, 'web-ui', (f, c) => { Object.assign(c('contrast'), { mark: 'DEFECT', finding: 'grey text on beige fails contrast', fix_or_weakness: { weakness: 'the brand grey stays as it is', reason: 'the client brand guide fixes this grey' } }); });
    t('a review with a block DEFECT + accepted weakness is RECORDED (code 0) and reports it unresolved', (() => { const x = C.recordReview({ root, runId: 'cr-weak', type: 'web-ui', form: weakForm, log: false }); return x.code === 0 && x.unresolved_block_defects.join() === 'contrast'; })());
    const w = chk(root, 'cr-weak');
    t('... the rule stays MISSING and names the unresolved block DEFECT', w.missing.includes('craft-review-recorded') && /web-ui: 1 unresolved block DEFECT\(s\): contrast/.test(w.rule_details['craft-review-recorded'].reason), w.rule_details['craft-review-recorded'].reason);
    const fixForm = fillForm(root, 'web-ui', (f, c) => { Object.assign(c('contrast'), { mark: 'DEFECT', finding: 'grey text on beige fails contrast', fix_or_weakness: { fix: 'text colour darkened to #3d3a35', evidence: 'artifacts/contrast-after.png, ratio 7.2:1' } }); });
    C.recordReview({ root, runId: 'cr-weak', type: 'web-ui', form: fixForm, log: false });
    t('... recorded again with the fix (+ evidence): the rule is met', chk(root, 'cr-weak').satisfied.includes('craft-review-recorded'));
    // tampering and copying are caught at check time
    const recFile = path.join(runDirIn(root, 'cr-green'), 'craft-review-web-ui.json');
    const original = fs.readFileSync(recFile, 'utf8');
    const tampered = JSON.parse(original);
    tampered.review.lenses[0].stakeholders[0].checks[0].mark = 'N/A';
    fs.writeFileSync(recFile, JSON.stringify(tampered));
    t('a record edited after recording does not count ("edited after it was recorded")', /edited after it was recorded/.test(chk(root, 'cr-green').rule_details['craft-review-recorded'].reason));
    fs.writeFileSync(recFile, original);
    writeRun(root, 'cr-copy', BASE_EVENTS, { 'run.json': runDecl, 'craft-review-web-ui.json': original });
    t('a record copied from another run does not count', /belongs to run "cr-green"/.test(chk(root, 'cr-copy').rule_details['craft-review-recorded'].reason));
    // the exception path, per type
    writeRun(root, 'cr-exc', BASE_EVENTS.concat([decision('craft-review-recorded', { deliverable_type: 'web-ui', reason: 'web-ui was declared by mistake, the run ships a CLI only' })]), { 'run.json': runDecl });
    t('an exception for the declared type satisfies it, visibly, with the type', chk(root, 'cr-exc').exceptions.some((x) => x.id === 'craft-review-recorded' && x.deliverable_type === 'web-ui'));
    writeRun(root, 'cr-exc-other', BASE_EVENTS.concat([decision('craft-review-recorded', { deliverable_type: 'copy-and-content', reason: 'copy was declared by mistake in this run' })]), { 'run.json': runDecl });
    t('an exception for ANOTHER type does not cover web-ui', chk(root, 'cr-exc-other').missing.includes('craft-review-recorded'));
    writeRun(root, 'cr-exc-vs-review', BASE_EVENTS.concat([decision('craft-review-recorded', { reason: 'we decided the review is not needed after all' })]), { 'run.json': runDecl });
    C.recordReview({ root, runId: 'cr-exc-vs-review', type: 'web-ui', form: weakForm, log: false });
    t('an exception never replaces a recorded review with an unresolved block DEFECT', chk(root, 'cr-exc-vs-review').missing.includes('craft-review-recorded'));
    writeRun(root, 'cr-mixed', BASE_EVENTS.concat([decision('craft-review-recorded', { deliverable_type: 'copy-and-content', reason: 'the copy is the client\'s own text, unchanged' })]), { 'run.json': { deliverable_types: ['web-ui', 'copy-and-content'] } });
    C.recordReview({ root, runId: 'cr-mixed', type: 'web-ui', form: fillForm(root, 'web-ui'), log: false });
    const mixed = chk(root, 'cr-mixed');
    t('one type reviewed, one excepted: met, via evidence+exception', mixed.satisfied.includes('craft-review-recorded') && mixed.rule_details['craft-review-recorded'].via === 'evidence+exception');
    // the lens changes after recording: judged against the recorded form, with a note
    const lroot = mkRoot();
    writeRun(lroot, 'cr-lens', BASE_EVENTS, { 'run.json': runDecl });
    C.recordReview({ root: lroot, runId: 'cr-lens', type: 'web-ui', form: fillForm(lroot, 'web-ui'), log: false });
    const lf = path.join(lroot, '.claude', 'config', 'quality', 'lenses', 'web-ui.json');
    const lens = JSON.parse(fs.readFileSync(lf, 'utf8')); lens.covers = lens.covers + ' (edited later)'; fs.writeFileSync(lf, JSON.stringify(lens, null, 2));
    const cr = C.checkRecorded({ root: lroot, runId: 'cr-lens', type: 'web-ui' });
    t('a lens edited after recording: the record stays valid, judged against the recorded form, with a note', cr.valid && cr.notes.some((n) => /lens changed since this review was recorded/.test(n)) && chk(lroot, 'cr-lens').satisfied.includes('craft-review-recorded'), JSON.stringify(cr));
    // fail-closed when forge-craft.cjs is not next to the checker
    const iso = mk(TMP, 'iso-checker', '.claude');
    mk(iso, 'forge-bin'); mk(iso, 'forge-dashboard');
    fs.copyFileSync(path.join(BIN, 'forge-runcontract.cjs'), path.join(iso, 'forge-bin', 'forge-runcontract.cjs'));
    fs.copyFileSync(path.join(CLAUDE_SRC, 'forge-dashboard', 'log-event.cjs'), path.join(iso, 'forge-dashboard', 'log-event.cjs'));
    const RCiso = require(path.join(iso, 'forge-bin', 'forge-runcontract.cjs'));
    const isoRes = RCiso.check({ run_id: 'cr-red' }, { root, ownerProfilePath: NO_PROFILE });
    t('without forge-craft.cjs next to the checker the craft rule fails CLOSED and says why', isoRes.missing.includes('craft-review-recorded') && /forge-craft\.cjs \(checkRecorded\) is not available/.test(isoRes.rule_details['craft-review-recorded'].reason));
  }

  // ================================================================================================
  console.log('\nF) craft record: every refusal writes nothing; mutations prove the tests bite');
  // ================================================================================================
  {
    const root = mkRoot();
    writeRun(root, 'rec', BASE_EVENTS, { 'run.json': { deliverable_types: ['web-ui'] } });
    const recPath = path.join(runDirIn(root, 'rec'), 'craft-review-web-ui.json');
    const refuse = (label, form, re, type) => {
      const r = C.recordReview({ root, runId: 'rec', type: type || 'web-ui', form, log: false });
      t('refused: ' + label, r.code === 3 && r.ok === false && r.problems.some((p) => re.test(p)) && !fs.existsSync(recPath), JSON.stringify(r.problems).slice(0, 500));
    };
    const empty = templateFor(root, 'web-ui');
    refuse('the unfilled template (an empty review)', empty, /no mark — an empty review is never accepted/);
    refuse('the unfilled template also lacks deliverable / where / reviewer', empty, /deliverable is empty/);
    refuse('a block check marked NOT_INSPECTED', fillForm(root, 'web-ui', (f, c) => Object.assign(c(BLOCK_IDS[0]), { mark: 'NOT_INSPECTED', finding: 'no browser was available in this session' })), /NOT_INSPECTED is not accepted on a block check/);
    refuse('CLEAN without evidence', fillForm(root, 'web-ui', (f, c) => Object.assign(c(BLOCK_IDS[1]), { evidence: null })), /CLEAN needs the evidence this check names/);
    refuse('N/A without a reason', fillForm(root, 'web-ui', (f, c) => Object.assign(c('forms-feedback'), { mark: 'N/A', finding: '' })), /N\/A needs the reason/);
    refuse('DEFECT without fix_or_weakness', fillForm(root, 'web-ui', (f, c) => Object.assign(c('no-overflow'), { mark: 'DEFECT', finding: 'the menu overflows at 390px', fix_or_weakness: null })), /DEFECT needs "fix_or_weakness"/);
    refuse('DEFECT with a weakness but no reason', fillForm(root, 'web-ui', (f, c) => Object.assign(c('no-overflow'), { mark: 'DEFECT', finding: 'the menu overflows at 390px', fix_or_weakness: { weakness: 'menu overflows on small phones' } })), /DEFECT needs "fix_or_weakness"/);
    refuse('DEFECT with a fix but no evidence', fillForm(root, 'web-ui', (f, c) => Object.assign(c('no-overflow'), { mark: 'DEFECT', finding: 'the menu overflows at 390px', fix_or_weakness: { fix: 'wrapped the menu items' } })), /DEFECT needs "fix_or_weakness"/);
    refuse('DEFECT without a finding', fillForm(root, 'web-ui', (f, c) => Object.assign(c('no-overflow'), { mark: 'DEFECT', finding: null, fix_or_weakness: { fix: 'wrapped the menu items', evidence: 'artifacts/menu-390.png' } })), /DEFECT needs a finding/);
    refuse('a stakeholder left out', fillForm(root, 'web-ui', (f) => { f.lenses[0].stakeholders = f.lenses[0].stakeholders.filter((s) => s.id !== 'assistive-user'); }), /stakeholder assistive-user .* is missing: every stakeholder must be covered/);
    refuse('a stakeholder without the first-ten-seconds note', fillForm(root, 'web-ui', (f) => { f.lenses[0].stakeholders[0].notice_in_10_seconds = null; }), /write what they would notice in the first ten seconds/);
    refuse('a check left out', fillForm(root, 'web-ui', (f) => { f.lenses[0].stakeholders[0].checks.pop(); }), /is missing from the form/);
    refuse('a check that is not in the lens', fillForm(root, 'web-ui', (f) => { f.lenses[0].stakeholders[0].checks.push({ id: 'made-up-check', mark: 'CLEAN', evidence: 'artifacts/x.png read' }); }), /"made-up-check" is not a visitor check/);
    refuse('a form filled against another lens version', fillForm(root, 'web-ui', (f) => { f.lenses[0].sha256 = 'b'.repeat(64); }), /another version of the web-ui lens/);
    refuse('a file that is not the review form', fillForm(root, 'web-ui', (f) => { f.kind = 'something-else'; }), /kind must be "forge-craft-review"/);
    refuse('every block check N/A (nothing inspected)', fillForm(root, 'web-ui', (f, c) => { for (const id of BLOCK_IDS) Object.assign(c(id), { mark: 'N/A', finding: 'not applicable for this static text page' }); }), /no block check was inspected/);
    refuse('a mark outside the four marks', fillForm(root, 'web-ui', (f, c) => Object.assign(c(BLOCK_IDS[2]), { mark: 'PASS' })), /mark "PASS" is not one of/);
    refuse('an empty first-ten-seconds answer', fillForm(root, 'web-ui', (f) => { f.lenses[0].first_ten_seconds[0].answer = ''; }), /first ten seconds: no answer/);
    refuse('a JSON array instead of the form', [], /must be one JSON object/);
    const usage = [
      ['a type without a lens', { type: 'podcast' }, /no lens for "podcast"/],
      ['a run folder that does not exist', { runId: 'no-such-run' }, /does not exist: start the run first/],
      ['a run id with a path in it', { runId: '../escape' }, /may only hold/],
    ];
    for (const [label, o, re] of usage) {
      const r = C.recordReview(Object.assign({ root, runId: 'rec', type: 'web-ui', form: fillForm(root, 'web-ui'), log: false }, o));
      t('usage error (code 2): ' + label, r.code === 2 && r.problems.some((p) => re.test(p)), JSON.stringify(r));
    }
    const warnNi = C.recordReview({ root, runId: 'rec', type: 'web-ui', form: fillForm(root, 'web-ui', (f, c) => Object.assign(c(WARN_IDS[0]), { mark: 'NOT_INSPECTED', finding: 'no designer reference available' })), log: false });
    t('a WARN check may stay NOT_INSPECTED with a reason (recorded)', warnNi.code === 0 && warnNi.summary.not_inspected.join() === WARN_IDS[0]);
    const first = fs.readFileSync(recPath, 'utf8');
    C.recordReview({ root, runId: 'rec', type: 'web-ui', form: fillForm(root, 'web-ui', (f, c) => Object.assign(c(WARN_IDS[0]), { mark: 'NOT_INSPECTED', finding: 'no designer reference available' })), log: false });
    t('recording is deterministic (the same form twice -> byte-identical record, no clock)', fs.readFileSync(recPath, 'utf8') === first);
    const stored = JSON.parse(first);
    t('the record carries kind, run, type, the lens sha and a record hash; the tool set no mark of its own', stored.kind === C.RECORD_KIND && stored.run_id === 'rec' && stored.type === 'web-ui' && /^[0-9a-f]{64}$/.test(stored.lens.sha256) && /^[0-9a-f]{64}$/.test(stored.record_sha256)
      && stored.review.lenses[0].stakeholders.flatMap((s) => s.checks).every((c) => ['CLEAN', 'NOT_INSPECTED'].includes(c.mark)));

    // CLI: record / check (spawned, like a Boss runs it)
    const TOOL = path.join(BIN, 'forge-craft.cjs');
    const cli = (args, input) => spawnSync(process.execPath, [TOOL].concat(args, ['--root', root]), { encoding: 'utf8', windowsHide: true, input, env: Object.assign({}, process.env) });
    const formFile = path.join(TMP, 'form-ok.json'); fs.writeFileSync(formFile, JSON.stringify(fillForm(root, 'web-ui')));
    const badFile = path.join(TMP, 'form-bad.json'); fs.writeFileSync(badFile, JSON.stringify(empty));
    writeRun(root, 'cli', BASE_EVENTS, { 'run.json': { deliverable_types: ['web-ui'] } });
    let x = cli(['record', '--run', 'cli', '--type', 'web-ui', '--file', badFile]);
    t('CLI record on an empty review: exit 3, "NOT recorded (nothing was written)"', x.status === 3 && /NOT recorded \(nothing was written\)/.test(x.stderr) && !fs.existsSync(path.join(runDirIn(root, 'cli'), 'craft-review-web-ui.json')), x.stderr.slice(0, 300));
    x = cli(['check', '--run', 'cli']);
    t('CLI check with nothing recorded: exit 3', x.status === 3 && /No craft review recorded/.test(x.stdout));
    x = cli(['record', '--run', 'cli', '--type', 'web-ui', '--file', '-'], fs.readFileSync(formFile, 'utf8'));
    t('CLI record from stdin: exit 0, says no unresolved block DEFECT (a missing writer is only a warning)', x.status === 0 && /Craft review recorded: web-ui for run cli/.test(x.stdout) && /Unresolved block DEFECT: none/.test(x.stdout) && /log-event\.cjs not found/.test(x.stderr), x.stdout + x.stderr);
    x = cli(['check', '--run', 'cli', '--json']);
    t('CLI check after a clean record: exit 0, done:true', x.status === 0 && JSON.parse(x.stdout).done === true);
    t('CLI record/check usage errors exit 2', cli(['record', '--run', 'cli']).status === 2 && cli(['check']).status === 2);
    t('no record/check output says PASS', !/\bPASS(ED)?\b/.test(x.stdout + cli(['check', '--run', 'cli']).stdout));

    // MUTATIONS: compile forge-craft.cjs with one guard weakened; the weakened copy must ACCEPT what the real one refuses
    const SRC = fs.readFileSync(path.join(BIN, 'forge-craft.cjs'), 'utf8');
    const mutant = (marker, transform) => {
      const lines = SRC.split('\n');
      const i = lines.findIndex((l) => l.includes('// ' + marker));
      if (i < 0) throw new Error('marker ' + marker + ' not found in forge-craft.cjs');
      lines[i] = transform(lines[i]);
      if (lines[0].startsWith('#!')) lines[0] = '//';
      const file = path.join(BIN, 'forge-craft.cjs');
      const m = new Module(file, module);
      m.filename = file; m.paths = Module._nodeModulePaths(BIN);
      m._compile(lines.join('\n'), file);
      return m.exports;
    };
    const entry = (mod) => { const L = mod.loadLens(root, 'web-ui'); return { lens: L.lens, sha256: L.sha256 }; };
    const niForm = fillForm(root, 'web-ui', (f, c) => Object.assign(c(BLOCK_IDS[0]), { mark: 'NOT_INSPECTED', finding: 'no browser was available in this session' }));
    const allNa = fillForm(root, 'web-ui', (f, c) => { for (const id of BLOCK_IDS) Object.assign(c(id), { mark: 'N/A', finding: 'not applicable for this static text page' }); });
    const muts = [
      ['CRAFT-RECORD-NOT-INSPECTED-BLOCK', () => '', niForm, 'accepting NOT_INSPECTED on a block check'],
      ['CRAFT-RECORD-VERDICT', (l) => l.replace('ok: P.length === 0', 'ok: true'), empty, 'accepting an empty review'],
      ['CRAFT-RECORD-EMPTY-GUARD', () => '', allNa, 'accepting a review that inspected no block check'],
    ];
    for (const [marker, transform, form, label] of muts) {
      const M = mutant(marker, transform);
      const real = C.validateReview(form, entry(C)), weak = M.validateReview(form, entry(M));
      t('MUTATION ' + marker + ' (' + label + '): the real validator refuses, the mutant accepts — so the refusal test above would FAIL on the mutant', real.ok === false && weak.ok === true, JSON.stringify(weak.problems).slice(0, 300));
    }
    const MU = mutant('CRAFT-UNRESOLVED-BLOCK', (l) => l.replace("=== 'fix'", "!== 'never'"));
    const weakSection = fillForm(root, 'web-ui', (f, c) => Object.assign(c('contrast'), { mark: 'DEFECT', finding: 'grey text on beige fails contrast', fix_or_weakness: { weakness: 'the brand grey stays', reason: 'client brand guide fixes it' } })).lenses[0];
    t('MUTATION CRAFT-UNRESOLVED-BLOCK (an accepted weakness counted as fixed): the real summary keeps it unresolved, the mutant drops it — the unresolved-DEFECT rule test would FAIL on the mutant',
      C.summarizeReview(weakSection, WEB).block_defects_unresolved.join() === 'contrast' && MU.summarizeReview(weakSection, WEB).block_defects_unresolved.length === 0);
  }

  // ================================================================================================
  console.log('\nG) plan wiring: the Lead is told the next command; the check CLI prints next + NL');
  // ================================================================================================
  {
    const root = mkRoot();
    writeRun(root, 'plan-1', BASE_EVENTS, { 'run.json': { work_packages: 4, deliverable_types: ['web-ui'] } });
    let p = RC.planFor({ run_id: 'plan-1' }, { root, ownerProfilePath: NO_PROFILE });
    const ob = p.obligations.find((o) => o.id === 'plan-card-recorded');
    // research_done is work, so the run is "working" and a preview obligation is already overdue (due by now either way)
    t('plan: plan-card-recorded is a blocking obligation due by now (preview, overdue once work started), with the plan-card command as "how"', !!ob && ob.severity === 'block' && ['due-now', 'overdue'].includes(ob.due) && ob.how === 'node .claude/forge-bin/forge-plan-card.cjs --file <mission.json> --run plan-1', JSON.stringify(ob));
    t('plan: the craft review is listed as not yet due (complete phase)', p.obligations.some((o) => o.id === 'craft-review-recorded' && o.due === 'later'));
    t('plan: "Next" names the plan-card command', /^plan-card-recorded: node \.claude\/forge-bin\/forge-plan-card\.cjs/.test(p.next.text), p.next.text);
    t('plan text: the obligation line carries the command', /✗ \[block\/preview\] plan-card-recorded — (due-now|overdue) — node \.claude\/forge-bin\/forge-plan-card\.cjs/.test(RC.formatPlan(p)), RC.formatPlan(p));
    fs.writeFileSync(path.join(runDirIn(root, 'plan-1'), 'plan-card.json'), JSON.stringify(planCardJson(root, PARALLEL4)));
    p = RC.planFor({ run_id: 'plan-1' }, { root, ownerProfilePath: NO_PROFILE });
    t('plan: once the card exists, the next obligation is the anticipation command', /^anticipation-recorded: node \.claude\/forge-bin\/forge-anticipate\.cjs apply --run plan-1/.test(p.next.text), p.next.text);
    const out = spawnSync(process.execPath, [path.join(BIN, 'forge-runcontract.cjs'), 'check', '--run', 'plan-1', '--root', root], { encoding: 'utf8', windowsHide: true });
    t('check CLI text: MISSING anticipation-recorded with its reason, a next: line and an NL: line; exit 3', out.status === 3 && /✗ MISSING anticipation-recorded/.test(out.stdout) && /↳ next: Run the anticipation engine for this run: node \.claude\/forge-bin\/forge-anticipate\.cjs apply --run plan-1/.test(out.stdout) && /↳ NL: Laat de anticipatie-engine/.test(out.stdout), out.stdout.slice(0, 1500));
    writeRun(root, 'plan-exc', BASE_EVENTS.concat([decision('plan-card-recorded')]), { 'run.json': { work_packages: 4 } });
    const o2 = spawnSync(process.execPath, [path.join(BIN, 'forge-runcontract.cjs'), 'check', '--run', 'plan-exc', '--root', root], { encoding: 'utf8', windowsHide: true });
    t('check CLI text: a recorded exception is printed (visible, not a plain pass)', /· exception \(recorded, visible\): plan-card-recorded — "a single static file/.test(o2.stdout), o2.stdout.slice(0, 1200));
    const pe = RC.planFor({ run_id: 'plan-exc' }, { root, ownerProfilePath: NO_PROFILE });
    t('plan: the contract summary lists the excepted rule, and the text says so', JSON.stringify(pe.contract.exceptions) === '["plan-card-recorded"]' && /Met by a recorded exception \(visible, not a plain pass\): plan-card-recorded/.test(RC.formatPlan(pe)));
  }

  // ================================================================================================
  console.log('\nH) replay of the real flow, legacy AND .forge layout: finalize refused at every stage, FINALIZED only at the end');
  // ================================================================================================
  const RUN = 'forge-2026-10-24-i6-replay';
  const OUT_TEXT = 'suite: 3 passed, 0 failed\n';
  const OUT_SHA = crypto.createHash('sha256').update(OUT_TEXT).digest('hex');
  const minimalRules = { version: 2, owners_allowlist: ['owner'], rules: [{ id: 'has-start', rule: 'run has a start event', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' }].concat(PROD.rules.filter((r) => I6_IDS.includes(r.id))) };
  const cleanEnv = () => { const e = Object.assign({}, process.env, { FORGE_CONFIG_HOME: CFG_HOME }); for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete e[k]; return e; };
  function replayRoot(forge) {
    const root = mkRoot({ forge, rules: minimalRules });
    mk(root, '.claude', 'forge-dashboard'); mk(root, '.claude', 'forge-bin'); mk(root, '.claude', 'config', 'agents');
    fs.copyFileSync(path.join(CLAUDE_SRC, 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
    for (const f of ['forge-runcontract.cjs', 'forge-finalize.cjs', 'forge-paths.cjs', 'forge-craft.cjs']) fs.copyFileSync(path.join(BIN, f), path.join(root, '.claude', 'forge-bin', f));
    fs.copyFileSync(path.join(CLAUDE_SRC, 'config', 'orchestration', 'forge-canon.json'), path.join(root, '.claude', 'config', 'orchestration', 'forge-canon.json'));
    fs.copyFileSync(path.join(CLAUDE_SRC, 'config', 'agents', 'agent-registry.json'), path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'));
    mk(root, 'gate-output'); fs.writeFileSync(path.join(root, 'gate-output', 'suite.txt'), OUT_TEXT);
    return root;
  }
  function replay(forge) {
    const L = forge ? 'forge' : 'legacy';
    const root = replayRoot(forge);
    const log = (type, payload) => spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), RUN, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, payload || {}))], { encoding: 'utf8', env: cleanEnv(), cwd: root });
    delete require.cache[require.resolve('./forge-finalize.cjs')];
    const F = require('./forge-finalize.cjs');
    const stage = (label, expectMissing) => {
      const rc = log('run_completed', { command: 'stage ' + label, output: 'stage ' + label, note: 'completion claimed at stage ' + label });
      const fin = F.finalize(root, RUN);
      const c = chk(root, RUN);
      const open = c.missing.slice().sort().join();
      // causal: finalize refuses through its contract-red path, and the contract's ONLY red rules are the expected I.6 ones
      // (has-start is met). forge-finalize's refusal text is generic ("niet groen (exit 3)"); check/plan name the rules.
      t(L + ' stage ' + label + ': finalize REFUSED by the red contract, whose only missing rules are ' + (expectMissing.join(', ') || '-'), rc.status === 0 && fin.ok === false && open === expectMissing.slice().sort().join()
        && /niet groen \(exit 3\)/.test(String(fin.reason)) && c.satisfied.includes('has-start'), JSON.stringify({ rc: rc.status, fin: fin.ok, reason: String(fin.reason).slice(0, 300), missing: c.missing }));
      return c;
    };
    let r = log('run_started', { note: 'I.6 replay ' + L });
    const runDir = runDirIn(root, RUN);
    t(L + ': the real writer started the run in the ' + (forge ? '.forge/runs' : '.claude/forge-runs') + ' folder', r.status === 0 && fs.existsSync(path.join(runDir, 'events.jsonl')) && (forge ? !fs.existsSync(path.join(root, '.claude', 'forge-runs')) : !fs.existsSync(path.join(root, '.forge'))), r.stderr);
    fs.writeFileSync(path.join(runDir, 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: OUT_SHA, evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: RUN, request: 'build a landing page for a bakery in 4 parts', deliverable_types: ['web-ui'], work_packages: 4 }) + '\n');
    stage('0 (shape declared, nothing recorded)', ['plan-card-recorded', 'craft-review-recorded']);

    // 1) the plan card, by the real CLI with --run
    const mission = path.join(TMP, 'mission-' + L + '.json');
    fs.writeFileSync(mission, JSON.stringify({ goal: 'Build a landing page for a bakery', assumptions: [], packages: CHAIN4, risks: [], wont_do: ['no live deploy'], gates: [], proof: ['tests and screenshots'] }));
    r = spawnSync(process.execPath, [path.join(BIN, 'forge-plan-card.cjs'), '--file', mission, '--run', RUN, '--root', root, '--mode', 'auto', '--json'], { encoding: 'utf8', env: cleanEnv(), cwd: root });
    const pcJson = (() => { try { return JSON.parse(r.stdout); } catch { return {}; } })();
    t(L + ' 1: forge-plan-card --run saved plan-card.json in this layout\'s run folder (and logged it)', r.status === 0 && fs.existsSync(path.join(runDir, 'plan-card.json')) && pcJson.saved && !pcJson.warnings.some((w) => /log-event warning/.test(w)), r.stderr + JSON.stringify(pcJson.warnings));
    let c = stage('1 (plan card)', ['anticipation-recorded', 'parallelism-considered', 'craft-review-recorded']);
    t(L + ' 1: plan-card-recorded is met by the real card', c.satisfied.includes('plan-card-recorded') && c.rule_details['plan-card-recorded'].via === 'evidence');

    // 2) the anticipation engine (real apply); the .forge layout gap is recorded as the documented exception
    const ap = A.applyRun(RUN, { root });
    const gapUsed = !(ap.code === 0 && ap.wrote); // 2.9c: forge-anticipate writes in the .forge layout too, so the gap branch is not used any more
    if (!gapUsed) {
      t(L + ' 2: forge-anticipate apply wrote anticipate.json (status applied) in the run folder', fs.existsSync(path.join(runDir, 'anticipate.json')) && JSON.parse(fs.readFileSync(path.join(runDir, 'anticipate.json'), 'utf8')).status === 'applied', JSON.stringify(ap).slice(0, 300));
      if (forge) console.log('  note: forge-anticipate.cjs now writes in the .forge layout — the gap branch below is no longer used');
    } else {
      t(L + ' 2: KNOWN GAP (not owned): forge-anticipate apply cannot write in the .forge layout (it only knows .claude/forge-runs)', forge && ap.code === 2 && /\.claude\/forge-runs\/.+ does not exist/.test(ap.message), JSON.stringify(ap));
      r = log('decision_logged', { rule: 'anticipation-recorded', decision: 'not-applicable', reason: 'anticipate cannot write in the .forge layout yet: forge-anticipate.cjs apply only writes .claude/forge-runs' });
      t(L + ' 2: the gap is recorded as the documented exception (decision_logged via the writer)', r.status === 0, r.stderr);
    }
    c = stage('2 (anticipation)', ['parallelism-considered', 'craft-review-recorded']);
    t(L + ' 2: anticipation-recorded is met ' + (gapUsed ? 'by the visible exception' : 'by the real overlay'), c.satisfied.includes('anticipation-recorded') && (gapUsed ? c.exceptions.some((x) => x.id === 'anticipation-recorded') : c.rule_details['anticipation-recorded'].via === 'evidence'));

    // 3) the serial plan names its blocker (a first decision without the blocker does not count)
    log('decision_logged', { rule: 'parallelism-considered', decision: 'serial', reason: 'each package uses the output of the previous one' });
    c = chk(root, RUN);
    t(L + ' 3: a serial decision without "blocking" is not accepted (still red, says why)', c.missing.includes('parallelism-considered') && /"blocking" must name/.test(c.rule_details['parallelism-considered'].reason));
    log('decision_logged', { rule: 'parallelism-considered', decision: 'serial', blocking: 'dependency chain A->B->C->D (each reads the previous output)', reason: 'each package uses the output of the previous one' });
    stage('3 (serial reason)', ['craft-review-recorded']);

    // 4) the craft review, by the real CLI: an invalid form is refused, an unresolved block DEFECT keeps it red, the fix turns it green
    const craft = (file) => spawnSync(process.execPath, [path.join(BIN, 'forge-craft.cjs'), 'record', '--run', RUN, '--type', 'web-ui', '--file', file, '--root', root], { encoding: 'utf8', env: cleanEnv(), cwd: root });
    const ff = (name, form) => { const p = path.join(TMP, name + '-' + L + '.json'); fs.writeFileSync(p, JSON.stringify(form)); return p; };
    r = craft(ff('ni', fillForm(root, 'web-ui', (f, cc) => Object.assign(cc(BLOCK_IDS[0]), { mark: 'NOT_INSPECTED', finding: 'no browser was available in this session' }))));
    t(L + ' 4a: craft record refuses a block check left NOT_INSPECTED (exit 3, nothing written)', r.status === 3 && !fs.existsSync(path.join(runDir, 'craft-review-web-ui.json')), r.stderr.slice(0, 300));
    r = craft(ff('weak', fillForm(root, 'web-ui', (f, cc) => Object.assign(cc('contrast'), { mark: 'DEFECT', finding: 'grey text on beige fails contrast', fix_or_weakness: { weakness: 'the brand grey stays as it is', reason: 'the client brand guide fixes this grey' } }))));
    t(L + ' 4b: a review with an unresolved block DEFECT is recorded and logged (exit 0) and says so', r.status === 0 && /Unresolved block DEFECT: contrast/.test(r.stdout) && !/warning/.test(r.stderr), r.stdout + r.stderr);
    c = stage('4b (unresolved block DEFECT)', ['craft-review-recorded']);
    t(L + ' 4b: the contract names the unresolved DEFECT', /unresolved block DEFECT\(s\): contrast/.test(c.rule_details['craft-review-recorded'].reason));
    r = craft(ff('fixed', fillForm(root, 'web-ui', (f, cc) => Object.assign(cc('contrast'), { mark: 'DEFECT', finding: 'grey text on beige fails contrast', fix_or_weakness: { fix: 'text colour darkened to #3d3a35', evidence: 'artifacts/contrast-after.png, ratio 7.2:1' } }))));
    t(L + ' 4c: the review recorded again with the fix (exit 0, no unresolved block DEFECT)', r.status === 0 && /Unresolved block DEFECT: none/.test(r.stdout), r.stdout + r.stderr);

    // 5) the end: finalize turns green
    r = log('run_completed', { command: 'stage end', output: 'all I.6 evidence recorded', note: 'completion claimed at the end' });
    const fin = F.finalize(root, RUN);
    t(L + ' 5: finalize is FINALIZED only now, at the end of the flow', r.status === 0 && fin.ok === true && fin.verdict === 'finalized', JSON.stringify(fin).slice(0, 400));
    t(L + ' 5: check() confirms FINALIZED and the receipt sits in this layout\'s run folder', F.check(root, RUN).verdict === 'FINALIZED' && fs.existsSync(path.join(runDir, 'run-finalized.json')));
    const final = chk(root, RUN);
    t(L + ' 5: every I.6 rule is met' + (gapUsed ? ' (anticipation by the visible exception)' : ''), final.ok && I6_IDS.every((id) => final.satisfied.includes(id)));
    const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    t(L + ' 5: the tools each logged their one agent_note through the writer (plan card, ' + (gapUsed ? '' : 'anticipation, ') + 'craft records)',
      events.some((e) => e.event_type === 'agent_note' && /^plan card /.test(e.note)) && (gapUsed || events.some((e) => e.event_type === 'agent_note' && /^anticipation applied/.test(e.note)))
      && events.filter((e) => e.event_type === 'agent_note' && /^craft review recorded: web-ui/.test(e.note)).length === 2);
    const cli = spawnSync(process.execPath, [path.join(BIN, 'forge-runcontract.cjs'), 'check', '--run', RUN, '--root', root, '--finalize'], { encoding: 'utf8', env: cleanEnv() });
    t(L + ' 5: the CLI completion path (check --finalize) agrees: exit 0, CONTRACT OK, FINALIZED', cli.status === 0 && /CONTRACT OK/.test(cli.stdout) && /FINALIZED @/.test(cli.stdout), cli.stdout + cli.stderr);
  }
  replay(false);
  replay(true);
} catch (e) {
  fail++;
  console.error('  FAIL unexpected error: ' + (e && e.stack ? e.stack : e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
