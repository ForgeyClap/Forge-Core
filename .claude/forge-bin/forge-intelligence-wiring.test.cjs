#!/usr/bin/env node
'use strict';
/**
 * forge-intelligence-wiring.test.cjs — WP 2.9c: the I.6 run-shape rules become applicable on REAL runs.
 * The I.6 rules (plan-card-recorded, anticipation-recorded, parallelism-considered, craft-review-recorded) only apply
 * when the run itself declares its shape in run.json / plan-card.json / anticipate.json (forge-runcontract.cjs "RUN
 * SHAPE"). This test replays what the tools write, in the legacy AND the .forge layout, and checks that the contract
 * turns the right rules on:
 *   A. a run that declares nothing: none of the four rules applies;
 *   B. forge-plan-card --run (real CLI) records the card with lanes.expected and the package count -> plan-scale and
 *      plan-card apply; plan-card-recorded is met, anticipation-recorded is owed;
 *   C. forge-anticipate apply (real, in-process) writes anticipate.json in THIS layout's run folder (2.9c run-dir fix),
 *      with the lanes and the derived deliverable_types (craft lens vocabulary) -> anticipation-recorded is met;
 *   D. the derived deliverable types declared in run.json turn craft-review-recorded on (owed until a review is recorded);
 *   E. a serial four-package chain turns parallelism-considered on; a decision that names the blocker meets it;
 *   F. run-dir edge cases: a missing run folder names this layout's folder; a run still in the legacy folder of a .forge
 *      project is used where it is; without forge-paths a .forge project is refused (nothing written in the wrong place).
 * Hermetic: every fixture lives in one os.mkdtemp folder (removed at the end); the real project is only read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const CLAUDE_SRC = path.join(BIN, '..');
const REAL_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const LENS_SRC = path.join(CLAUDE_SRC, 'config', 'quality', 'lenses');
const REAL_CATALOG = path.join(CLAUDE_SRC, 'config', 'intelligence', 'switch-catalog.json');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wiring-')));
const CFG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(CFG_HOME, { recursive: true });
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete process.env[k];
process.env.FORGE_CONFIG_HOME = CFG_HOME;

const RC = require('./forge-runcontract.cjs');
const A = require('./forge-anticipate.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const I6 = ['plan-card-recorded', 'anticipation-recorded', 'parallelism-considered', 'craft-review-recorded'];
const PROD = JSON.parse(fs.readFileSync(REAL_RULES, 'utf8'));
const RULES = { version: 2, owners_allowlist: ['owner'], rules: [{ id: 'has-start', rule: 'run has a start event', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' }].concat(PROD.rules.filter((r) => I6.includes(r.id))) };
const cleanEnv = () => { const e = Object.assign({}, process.env, { FORGE_CONFIG_HOME: CFG_HOME }); for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete e[k]; return e; };
let n = 0;
function mkRoot(forge) {
  const root = mk(TMP, 'p' + (++n));
  mk(root, '.claude', 'config', 'orchestration'); mk(root, '.claude', 'forge-dashboard'); mk(root, '.claude', 'config', 'agents');
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify(RULES, null, 2));
  fs.copyFileSync(path.join(CLAUDE_SRC, 'config', 'orchestration', 'forge-canon.json'), path.join(root, '.claude', 'config', 'orchestration', 'forge-canon.json'));
  fs.copyFileSync(path.join(CLAUDE_SRC, 'config', 'agents', 'agent-registry.json'), path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'));
  fs.copyFileSync(path.join(CLAUDE_SRC, 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  mk(root, '.claude', 'forge-bin'); // the writer finds the layout through forge-paths next to it (as in an install)
  for (const f of ['forge-paths.cjs', 'forge-runcontract.cjs']) fs.copyFileSync(path.join(BIN, f), path.join(root, '.claude', 'forge-bin', f));
  const ld = mk(root, '.claude', 'config', 'quality', 'lenses');
  for (const f of fs.readdirSync(LENS_SRC)) fs.copyFileSync(path.join(LENS_SRC, f), path.join(ld, f));
  if (forge) mk(root, '.forge');
  return root;
}
const runsOf = (root) => (fs.existsSync(path.join(root, '.forge')) ? path.join(root, '.forge', 'runs') : path.join(root, '.claude', 'forge-runs'));
const log = (root, run, type, payload) => spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), run, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, payload || {}))], { encoding: 'utf8', env: cleanEnv(), cwd: root });
const chk = (root, run) => RC.check({ run_id: run }, { root, ownerProfilePath: NO_PROFILE });
const applies = (c, id) => c.satisfied.includes(id) || c.missing.includes(id);
const readJ = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const PARALLEL4 = [
  { id: 'A', goal: 'write the data schema for the menu', owns: ['src/schema/'], route: 'build' },
  { id: 'B', goal: 'build the menu page', owns: ['src/menu/'], route: 'build' },
  { id: 'C', goal: 'build the order form', owns: ['src/order/'], route: 'build' },
  { id: 'D', goal: 'write the copy for every page', owns: ['src/copy/'], route: 'quick' },
];
const CHAIN4 = PARALLEL4.map((p, i) => Object.assign({}, p, { deps: i ? [PARALLEL4[i - 1].id] : [] }));
function planCard(root, run, packages, L) {
  const mission = path.join(TMP, 'mission-' + run + '-' + L + '.json');
  fs.writeFileSync(mission, JSON.stringify({ goal: 'Build a landing page for a bakery', assumptions: [], packages, risks: [], wont_do: ['no live deploy'], gates: [], proof: ['tests and screenshots'] }));
  return spawnSync(process.execPath, [path.join(BIN, 'forge-plan-card.cjs'), '--file', mission, '--run', run, '--root', root, '--mode', 'auto', '--json'], { encoding: 'utf8', env: cleanEnv(), cwd: root });
}

try {
  for (const forge of [false, true]) {
    const L = forge ? 'forge' : 'legacy';
    console.log('\n' + L + ' layout');
    const root = mkRoot(forge), RUN = 'wiring-' + L;
    let r = log(root, RUN, 'run_started', { note: 'wiring replay ' + L });
    const runDir = path.join(runsOf(root), RUN);
    t(L + ': the real writer started the run in ' + path.relative(root, runsOf(root)).split(path.sep).join('/'), r.status === 0 && fs.existsSync(path.join(runDir, 'events.jsonl')), r.stderr);
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: RUN, request: 'Build a landing page for a bakery: the menu, an order form and the copy, in four parts' }) + '\n');

    // A) nothing declared
    let c = chk(root, RUN);
    t(L + ' A: a run that declares no shape turns none of the four run-shape rules on', c.run_shape.declares_shape === false && I6.every((id) => !applies(c, id)) && c.satisfied.includes('has-start'), JSON.stringify(c.run_shape));

    // B) the plan card (real CLI)
    r = planCard(root, RUN, PARALLEL4, L);
    const card = readJ(path.join(runDir, 'plan-card.json'));
    t(L + ' B: forge-plan-card --run saved plan-card.json in this layout\'s run folder with the card hash, lanes.expected and the package count',
      r.status === 0 && !!card && /^[0-9a-f]{64}$/.test(card.cardHash) && card.lanes && card.lanes.expected === 4 && card.packages === 4 && Array.isArray(card.lanes.collisions), r.stderr + ' ' + JSON.stringify(card && { lanes: card.lanes, packages: card.packages }));
    c = chk(root, RUN);
    t(L + ' B: the card turns plan-scale and plan-card on', c.run_shape.applies['plan-scale'] === true && c.run_shape.applies['plan-card'] === true, JSON.stringify(c.run_shape));
    t(L + ' B: plan-card-recorded is met by the real card (evidence), anticipation-recorded is owed', c.satisfied.includes('plan-card-recorded') && c.rule_details['plan-card-recorded'].via === 'evidence' && c.missing.includes('anticipation-recorded'), JSON.stringify({ s: c.satisfied, m: c.missing }));
    t(L + ' B: four parallel packages are not a serial plan, and no visible type is declared yet', !applies(c, 'parallelism-considered') && !applies(c, 'craft-review-recorded'));

    // C) anticipation (real apply)
    const ap = A.applyRun(RUN, { root });
    const over = readJ(path.join(runDir, 'anticipate.json'));
    t(L + ' C: forge-anticipate apply wrote anticipate.json in THIS layout\'s run folder (2.9c run-dir fix)', ap.code === 0 && ap.wrote === true && !!over && ap.file === path.relative(root, runDir).split(path.sep).join('/') + '/anticipate.json'
      && (forge ? !fs.existsSync(path.join(root, '.claude', 'forge-runs')) : !fs.existsSync(path.join(root, '.forge'))), JSON.stringify(ap).slice(0, 400));
    t(L + ' C: the overlay is applied for this run, with the card\'s lanes (4)', !!over && over.status === 'applied' && over.run_id === RUN && over.input.lanes === 4);
    t(L + ' C: the overlay records the derived deliverable_types in the craft lens vocabulary (web-ui for a landing page), each with where it came from',
      !!over && Array.isArray(over.deliverable_types) && over.deliverable_types.includes('web-ui') && Array.isArray(over.deliverable_types_from) && over.deliverable_types.every((x) => over.deliverable_types_from.some((f) => f.type === x && typeof f.from === 'string' && f.from.length > 3)), JSON.stringify(over && over.deliverable_types_from));
    c = chk(root, RUN);
    t(L + ' C: anticipation-recorded is met by the real overlay (evidence)', c.satisfied.includes('anticipation-recorded') && c.rule_details['anticipation-recorded'].via === 'evidence', JSON.stringify(c.rule_details['anticipation-recorded']));
    t(L + ' C: the contract reads the overlay\'s lanes for plan-scale', (c.run_shape.why['plan-scale'] || []).some((w) => /anticipate\.json counted 4 parallel parts/.test(w)), JSON.stringify(c.run_shape.why));
    // the run contract reads visible types from run.json deliverable_types and anticipate.json input.type; reading the
    // overlay's deliverable_types is a one-line change in forge-runcontract.cjs readRunShape (outside this package)
    const readsOverlayTypes = c.run_shape.visible_types.includes('web-ui');
    if (!readsOverlayTypes) console.log('  note: forge-runcontract.cjs readRunShape does not read anticipate.json deliverable_types yet (it reads run.json deliverable_types and input.type); step D declares them in run.json');
    t(L + ' C: craft-review-recorded follows the visible types the contract sees (on when it reads the overlay\'s types, off otherwise)', applies(c, 'craft-review-recorded') === readsOverlayTypes);

    // D) the derived types declared in run.json (the field the contract reads today)
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: RUN, request: 'Build a landing page for a bakery: the menu, an order form and the copy, in four parts', deliverable_types: over ? over.deliverable_types : [] }) + '\n');
    c = chk(root, RUN);
    t(L + ' D: the derived types in run.json turn visible-deliverable on (web-ui visible) and craft-review-recorded is owed with the craft command', c.run_shape.applies['visible-deliverable'] === true && c.run_shape.visible_types.includes('web-ui')
      && c.missing.includes('craft-review-recorded') && /forge-craft\.cjs record --run wiring-/.test(c.rule_details['craft-review-recorded'].next_step || ''), JSON.stringify({ shape: c.run_shape, d: c.rule_details['craft-review-recorded'] }).slice(0, 700));

    // E) a serial chain of four packages
    const RUN2 = 'wiring-serial-' + L;
    log(root, RUN2, 'run_started', { note: 'serial plan ' + L });
    const run2Dir = path.join(runsOf(root), RUN2);
    fs.writeFileSync(path.join(run2Dir, 'run.json'), JSON.stringify({ run_id: RUN2, request: 'Build the schema, then the menu on it, then the order form on the menu, then the copy' }) + '\n');
    r = planCard(root, RUN2, CHAIN4, L);
    const card2 = readJ(path.join(run2Dir, 'plan-card.json'));
    t(L + ' E: a four-package chain is recorded with 1 expected lane and no collision', r.status === 0 && !!card2 && card2.lanes.expected === 1 && card2.packages === 4 && card2.lanes.collisions.length === 0, JSON.stringify(card2 && card2.lanes));
    const ap2 = A.applyRun(RUN2, { root });
    c = chk(root, RUN2);
    t(L + ' E: serial-plan applies and parallelism-considered is owed (anticipation met by the real overlay)', ap2.code === 0 && c.run_shape.applies['serial-plan'] === true && c.missing.includes('parallelism-considered') && c.satisfied.includes('anticipation-recorded'), JSON.stringify({ m: c.missing, why: c.run_shape.why }));
    log(root, RUN2, 'decision_logged', { rule: 'parallelism-considered', decision: 'serial', blocking: 'dependency chain A->B->C->D (each reads the previous output)', reason: 'each package uses the output of the previous one' });
    c = chk(root, RUN2);
    t(L + ' E: a serial decision that names the blocker meets parallelism-considered', c.satisfied.includes('parallelism-considered'), JSON.stringify(c.rule_details['parallelism-considered']));

    // F) run-dir edge cases
    const miss = A.applyRun('no-such-run', { root });
    t(L + ' F: a missing run folder is refused (exit 2) and the message names this layout\'s folder', miss.code === 2 && (forge ? /\.forge\/runs\/no-such-run does not exist/ : /\.claude\/forge-runs\/no-such-run does not exist/).test(miss.message) && !fs.existsSync(path.join(runsOf(root), 'no-such-run')), miss.message);
    t(L + ' F: a bad run id is refused before any path is built', A.applyRun('../x', { root }).code === 2);
    if (forge) {
      const legacyRun = mk(root, '.claude', 'forge-runs', 'old-run');
      fs.writeFileSync(path.join(legacyRun, 'run.json'), JSON.stringify({ run_id: 'old-run', request: 'Fix the typo on the contact page' }));
      const apOld = A.applyRun('old-run', { root });
      t('forge F: a run that still lives in the legacy folder of a .forge project is used where it is (partial migration)', apOld.code === 0 && fs.existsSync(path.join(legacyRun, 'anticipate.json')) && !fs.existsSync(path.join(root, '.forge', 'runs', 'old-run')) && apOld.file === '.claude/forge-runs/old-run/anticipate.json', JSON.stringify(apOld).slice(0, 300));
    }
  }

  // G) without forge-paths next to the tool: legacy still works, a .forge project is refused
  console.log('\nG) a half-synced install without forge-paths.cjs');
  {
    const lone = mk(TMP, 'lone-bin', '.claude', 'forge-bin');
    fs.copyFileSync(path.join(BIN, 'forge-anticipate.cjs'), path.join(lone, 'forge-anticipate.cjs'));
    const A2 = require(path.join(lone, 'forge-anticipate.cjs'));
    const fr = mkRoot(true); mk(fr, '.forge', 'runs', 'r1'); fs.writeFileSync(path.join(fr, '.forge', 'runs', 'r1', 'run.json'), JSON.stringify({ request: 'build a landing page' }));
    const refused = A2.applyRun('r1', { root: fr, catalogPath: REAL_CATALOG });
    t('G: a .forge project is refused (exit 2, forge-paths named) and nothing is written anywhere', refused.code === 2 && /forge-paths\.cjs is missing/.test(refused.message) && !fs.existsSync(path.join(fr, '.forge', 'runs', 'r1', 'anticipate.json')) && !fs.existsSync(path.join(fr, '.claude', 'forge-runs')), JSON.stringify(refused));
    const lr = mkRoot(false); mk(lr, '.claude', 'forge-runs', 'r1'); fs.writeFileSync(path.join(lr, '.claude', 'forge-runs', 'r1', 'run.json'), JSON.stringify({ request: 'Write a Python CLI that parses our server logs into a CSV report' }));
    const ok = A2.applyRun('r1', { root: lr, catalogPath: REAL_CATALOG });
    const o = readJ(path.join(lr, '.claude', 'forge-runs', 'r1', 'anticipate.json'));
    t('G: a legacy project still gets its overlay in .claude/forge-runs (degraded: forge-craft absent is said, never hidden)', ok.code === 0 && !!o && o.status === 'applied' && o.deliverable_types_from.some((f) => f.type === null && /not available/.test(f.from)), JSON.stringify(ok).slice(0, 300));
    t('G: a non-visual request records no web-ui deliverable', !!o && !o.deliverable_types.includes('web-ui'));
  }
} catch (e) {
  fail++;
  console.error('  FAIL unexpected error: ' + (e && e.stack ? e.stack : e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
