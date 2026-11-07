'use strict';
/**
 * forge-paths-migration-A.test.cjs — WP 2.1.A layout matrix for the run-lifecycle tools (group A).
 *
 * The binding design of WP 2.1 is OPT-IN per project: a project uses the new .forge/ layout only when <root>/.forge
 * exists (or FORGE_STATE_DIR is set); otherwise every tool behaves exactly as before. This file proves both halves
 * end to end on real temp projects, driving the real tools (spawned CLIs and module calls):
 *   1. FORGE project (has .forge/): log-event writes .forge/runs/<run>/events.jsonl; runcontract plan/check (+ its
 *      --log-event proof) read and write there; finalize, runinfo, stats, certify, cost, manifest, lock-guard,
 *      testrun, run-state, runwatch, otel, trace, heartbeat, swarm-resume, run-budget, evidence, loophealth,
 *      audit-loop, usage-report and registry all follow it - and NOTHING is written under .claude/forge-runs.
 *   2. LEGACY project (no .forge/): the very same commands write .claude/forge-runs exactly as before, and the runs
 *      tree they leave is the same tree (file for file) as the forge project's .forge/runs tree.
 *   3. OLDER resolver: a project with .forge/ but an old forge-paths.cjs (no stateDir) keeps the legacy paths and
 *      nothing crashes (the guarded require).
 *   4. PLUGIN copies (tools copied flat into <tmp>/plugin/scripts, run with the cwd inside a project and no
 *      CLAUDE_PROJECT_DIR/FORGE_PROJECT_ROOT): state lands in that project; run outside any project they refuse;
 *      nothing is ever written inside the plugin folder.
 * Every fixture lives in one os.mkdtemp folder that is removed at the end; the real project is only read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const CLAUDE_SRC = path.join(__dirname, '..');
const DEV_LOG_EVENT = path.join(CLAUDE_SRC, 'forge-dashboard', 'log-event.cjs');
const REAL_CANON = path.join(CLAUDE_SRC, 'config', 'orchestration', 'forge-canon.json');
const REAL_REGISTRY = path.join(CLAUDE_SRC, 'config', 'agents', 'agent-registry.json');
const REAL_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const RUN = 'forge-2026-10-24-matrix';

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : e)); }
}
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-paths-mig-A-')));
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
function cleanEnv(extra) {
  const e = { ...process.env };
  for (const k of ['CLAUDE_PROJECT_DIR', 'FORGE_STATE_DIR', 'FORGE_PROJECT_ROOT', 'FORGE_STORE_ROOT', 'FORGE_CHECKPOINT_ROOT', 'FORGE_COMPLETION_GATE']) delete e[k];
  e.FORGE_STRICT_EVENTS = '0'; // this file proves WHERE events land, not the honesty gate (log-event's own suites do that)
  return Object.assign(e, extra || {});
}
function run(script, args, opts) {
  opts = opts || {};
  return spawnSync(process.execPath, [script].concat(args || []), { cwd: opts.cwd || tmp, env: cleanEnv(opts.env), encoding: 'utf8', timeout: 120000, input: opts.input });
}
function tree(dir) {
  const out = [];
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const r = rel ? rel + '/' + e.name : e.name; out.push(r + (e.isDirectory() ? '/' : '')); if (e.isDirectory()) walk(path.join(d, e.name), r); }
  })(dir, '');
  return out.sort();
}
const readEvents = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** makeProject(name, forge, opts) -> root. An installed fixture: the writer and the copied tools sit in its own
 *  .claude, exactly like a synced project; opts.oldPaths installs an OLD forge-paths.cjs (no stateDir). */
function makeProject(name, forge, opts) {
  opts = opts || {};
  const root = mk(tmp, name);
  mk(root, '.claude', 'forge-bin'); mk(root, '.claude', 'forge-dashboard'); mk(root, '.claude', 'config', 'orchestration'); mk(root, '.claude', 'config', 'agents');
  fs.copyFileSync(REAL_CANON, path.join(root, '.claude', 'config', 'orchestration', 'forge-canon.json'));
  fs.copyFileSync(REAL_REGISTRY, path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'));
  fs.copyFileSync(DEV_LOG_EVENT, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(path.join(BIN, 'forge-runinfo.cjs'), path.join(root, '.claude', 'forge-bin', 'forge-runinfo.cjs'));
  if (opts.oldPaths) {
    // the WP 1.2 resolver shape: resolve/resolveExisting only, no stateDir/scriptRoot
    fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'forge-paths.cjs'), "'use strict';\nconst path = require('path');\n"
      + "module.exports = { resolve: (r, k) => path.join(r, '.forge', k), resolveExisting: (r, k) => path.join(r, '.claude', 'forge-' + k) };\n");
  } else {
    fs.copyFileSync(path.join(BIN, 'forge-paths.cjs'), path.join(root, '.claude', 'forge-bin', 'forge-paths.cjs'));
  }
  if (forge) mk(root, '.forge');
  mk(root, 'src');
  return root;
}
const logEvent = (root, type, payload) => run(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), [RUN, type, JSON.stringify(payload || {})], { cwd: root });

/** drive(root) -> {runsDir} after running every group-A tool against root (the same sequence for both layouts). */
function drive(root, label) {
  const env = { FORGE_PROJECT_ROOT: root };
  const steps = {};
  // 1) the event writer (fixture copy; it has no root override, it acts on its own project)
  for (const [type, payload] of [
    ['run_started', { agent: 'orchestrator', note: 'matrix ' + label }],
    ['agent_started', { agent: 'build-boss', dispatch_id: 'd-1', wp_id: 'wp1', task: 'build' }],
    ['check_passed', { agent: 'orchestrator', role: 'verifier', command: 'node -e 1', exit_code: 0, output: 'ok' }],
    ['agent_completed', { agent: 'build-boss', dispatch_id: 'd-1', wp_id: 'wp1', note: 'done' }],
    ['agent_note', { agent: 'orchestrator', note: 'forge-runinfo was used in this matrix run' }],
  ]) {
    const r = logEvent(root, type, payload);
    assert.strictEqual(r.status, 0, label + ' log-event ' + type + ' exit ' + r.status + ': ' + r.stderr);
    steps.logOut = r.stdout;
  }
  const runsDir = JSON.parse(run(path.join(BIN, 'forge-paths.cjs'), ['dir', 'runs', '--root', root, '--json']).stdout).active;
  const runDir = path.join(runsDir, RUN);
  // the agent's own run files (what /forge writes next to the events)
  fs.writeFileSync(path.join(runDir, 'final-report.md'), '# matrix\nreal content\n');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: RUN, status: 'running', started_at: '2026-10-24T00:00:00.000Z', project_type: 'cli' }) + '\n');
  fs.writeFileSync(path.join(runDir, 'shot.png'), Buffer.alloc(64, 7));
  // 2) runcontract (dev-tree copy, explicit --root): plan reads, check --log-event writes its proof via the project's writer
  steps.plan = run(path.join(BIN, 'forge-runcontract.cjs'), ['plan', '--run', RUN, '--root', root, '--rules', REAL_RULES, '--json']);
  steps.check = run(path.join(BIN, 'forge-runcontract.cjs'), ['check', '--run', RUN, '--root', root, '--rules', REAL_RULES, '--json', '--log-event']);
  // 3) finalize (module: the receipt/lock paths and a refused finalize that must not touch the other layout)
  delete require.cache[require.resolve('./forge-finalize.cjs')];
  const F = require('./forge-finalize.cjs');
  steps.receiptFile = F.receiptFileOf(root, RUN);
  steps.finalize = F.finalize(root, RUN);
  steps.finalCheck = F.check(root, RUN);
  // 4) readers and writers that take FORGE_PROJECT_ROOT / --root
  steps.stats = run(path.join(BIN, 'forge-stats.cjs'), ['--json'], { env });
  steps.certify = run(path.join(BIN, 'forge-certify.cjs'), [RUN, '--root', root, '--json']);
  const envFile = path.join(root, 'envelope.json');
  fs.writeFileSync(envFile, JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }));
  steps.cost = run(path.join(BIN, 'forge-cost.cjs'), ['capture', '--from', envFile, '--run', RUN, '--agent', 'orchestrator'], { env });
  steps.lock = run(path.join(BIN, 'forge-lock-guard.cjs'), ['acquire', 'src/a.js', '--run', RUN, '--json'], { env });
  steps.testrun = run(path.join(BIN, 'forge-testrun.cjs'), ['--', process.execPath, '-e', "console.log('1 passed, 0 failed')"], { env });
  steps.runState = run(path.join(BIN, 'forge-run-state.cjs'), [RUN, '--json'], { env });
  steps.runwatch = run(path.join(BIN, 'forge-runwatch.cjs'), [RUN, '--json'], { env });
  steps.otel = run(path.join(BIN, 'forge-otel.cjs'), [RUN], { env });
  steps.trace = run(path.join(BIN, 'forge-trace.cjs'), ['trace', '--run', RUN, '--json'], { env });
  steps.heartbeat = run(path.join(BIN, 'forge-heartbeat.cjs'), ['check', RUN, '--root', root, '--json']);
  // 5) the installed runinfo copy (its isolation guard only trusts its own project)
  steps.runinfo = run(path.join(root, '.claude', 'forge-bin', 'forge-runinfo.cjs'), ['runs'], { cwd: root });
  // 6) module APIs with an explicit root
  delete require.cache[require.resolve('./forge-manifest.cjs')];
  steps.arm = require('./forge-manifest.cjs').arm({ run_id: RUN, wps: [{ wp_id: 'wp1', agent: 'build-boss', narrowed_prompt: 'build it' }] }, { root });
  steps.lease = require('./forge-swarm-resume.cjs').claimWp({ run_id: RUN, wp_id: 'wp2', holder: 'matrix' }, { root });
  steps.budgetDir = require('./forge-run-budget.cjs').resolveRunDir(RUN, { root });
  const EV = require('./forge-evidence.cjs');
  steps.evidence = EV.check({ domain: EV.listDomains()[0], artifacts: ['shot.png'], run_id: RUN }, { root });
  steps.loophealth = require('./forge-loophealth.cjs').analyze({ root, sessionId: 'matrix-session' });
  const AL = require('./forge-audit-loop.cjs');
  steps.ledgerEntry = AL.appendLedger(root, { findings: [], note: 'matrix' });
  steps.ledger = AL.readLedger(root);
  steps.registry = require('./forge-registry.cjs').readProject(root);
  steps.trace2 = require('./forge-trace.cjs').trace({ run_id: RUN }, { root });
  steps.events = readEvents(path.join(runDir, 'events.jsonl'));
  return { runsDir, runDir, steps };
}

try {
  const forgeProj = makeProject('forge-proj', true);
  const legacyProj = makeProject('legacy-proj', false);
  const F = drive(forgeProj, 'forge');
  const L = drive(legacyProj, 'legacy');

  // ---- the forge layout ----
  t('forge layout: forge-paths answers .forge/runs and the writer used it', () => {
    assert.strictEqual(F.runsDir, path.join(forgeProj, '.forge', 'runs'));
    assert.ok(exists(path.join(F.runDir, 'events.jsonl')));
    assert.ok(/\.forge[\\/]runs[\\/]forge-2026-10-24-matrix[\\/]events\.jsonl/.test(F.steps.logOut), 'the writer names the file it wrote: ' + F.steps.logOut);
  });
  t('forge layout: NOTHING was written under .claude/forge-runs (or any other legacy state folder)', () => {
    assert.ok(!exists(path.join(forgeProj, '.claude', 'forge-runs')), 'legacy runs folder appeared');
    assert.ok(!exists(path.join(forgeProj, '.claude', 'forge-audit')), 'legacy audit folder appeared');
    const legacyState = fs.readdirSync(path.join(forgeProj, '.claude')).filter((n) => /^forge-(runs|research|scribe|tickets|index|backups|vault|artifacts|mindmaps|audit|prd)$/.test(n));
    assert.deepStrictEqual(legacyState, []);
  });
  t('forge layout: runcontract plan reads the run there (exit 0) and sees final-report.md as done', () => {
    assert.strictEqual(F.steps.plan.status, 0, F.steps.plan.stderr);
    const p = JSON.parse(F.steps.plan.stdout);
    const step = (p.sequence || p.steps || []).find((s) => s.id === 'final-report');
    assert.ok(step && step.status === 'done', 'final-report step: ' + JSON.stringify(step));
  });
  t('forge layout: runcontract check judged the run and its --log-event proof landed in .forge/runs', () => {
    assert.ok([0, 3].includes(F.steps.check.status), 'exit ' + F.steps.check.status + ' ' + F.steps.check.stderr);
    const r = JSON.parse(F.steps.check.stdout.trim().split('\n')[0]);
    assert.ok(r.logged && r.logged.ok === true, 'proof not logged: ' + JSON.stringify(r.logged));
    assert.ok(F.steps.events.some((e) => e.event_type === 'gate_evaluated'), 'no gate_evaluated in .forge/runs events');
  });
  t('forge layout: finalize names .forge/runs for its receipt and a refused finalize writes no legacy folder', () => {
    assert.strictEqual(F.steps.receiptFile, path.join(F.runDir, 'run-finalized.json'));
    assert.strictEqual(F.steps.finalize.ok, false, 'an unfinished run must not finalize');
    assert.ok(F.steps.finalCheck && F.steps.finalCheck.verdict, JSON.stringify(F.steps.finalCheck));
  });
  t('forge layout: stats wrote STATS.json in .forge/runs and scanned the run', () => {
    assert.strictEqual(F.steps.stats.status, 0, F.steps.stats.stderr);
    assert.strictEqual(JSON.parse(F.steps.stats.stdout).runs_scanned, 1);
    assert.ok(exists(path.join(F.runsDir, 'STATS.json')));
  });
  t('forge layout: certify, run-state, runwatch, otel, trace and heartbeat all read the .forge run', () => {
    const cert = JSON.parse(F.steps.certify.stdout);
    assert.strictEqual(cert.run_id, RUN);
    assert.ok(cert.event_count >= 5, 'certify did not see the events: ' + cert.reason);
    const st = JSON.parse(F.steps.runState.stdout);
    // the writer folds the slug to the registry display name ("Build Boss")
    assert.ok(st.agents['Build Boss'] && st.agents['Build Boss'].completed === true, JSON.stringify(st.agents));
    assert.strictEqual(F.steps.runwatch.status, 0, 'runwatch: ' + F.steps.runwatch.stdout);
    assert.ok(JSON.parse(F.steps.otel.stdout).resourceSpans[0].scopeSpans[0].spans.length >= 2);
    assert.ok([0, 3].includes(F.steps.trace.status), F.steps.trace.stderr);
    assert.strictEqual(F.steps.trace2.ok, true);
    assert.strictEqual(F.steps.heartbeat.status, 0, F.steps.heartbeat.stdout + F.steps.heartbeat.stderr);
  });
  t('forge layout: cost capture, lock-guard and testrun write under .forge/runs', () => {
    assert.strictEqual(F.steps.cost.status, 0, F.steps.cost.stderr);
    assert.ok(F.steps.events.some((e) => e.event_type === 'cost_sampled'));
    assert.strictEqual(F.steps.lock.status, 0, F.steps.lock.stderr);
    assert.ok(fs.readdirSync(path.join(F.runsDir, '.hotspot-locks')).some((n) => n.endsWith('.json')));
    assert.ok(fs.readdirSync(path.join(F.runsDir, '_testlogs')).some((n) => /^testrun-.*\.log$/.test(n)), F.steps.testrun.stdout);
  });
  t('forge layout: runinfo (installed copy) lists the .forge run', () => {
    assert.strictEqual(F.steps.runinfo.status, 0, F.steps.runinfo.stderr);
    assert.ok(F.steps.runinfo.stdout.includes(RUN), F.steps.runinfo.stdout);
  });
  t('forge layout: manifest, swarm lease, run-budget and evidence use the .forge run folder', () => {
    assert.strictEqual(F.steps.arm.ok, true, JSON.stringify(F.steps.arm));
    assert.strictEqual(F.steps.arm.path, path.join(F.runDir, 'manifest.json'));
    assert.strictEqual(F.steps.lease.ok, true, JSON.stringify(F.steps.lease));
    assert.ok(fs.readdirSync(path.join(F.runDir, 'wp-leases')).length === 1);
    assert.deepStrictEqual(F.steps.budgetDir, { ok: true, dir: F.runDir });
    assert.strictEqual(F.steps.evidence.artifacts_verified, true);
    assert.ok(!F.steps.evidence.artifacts_rejected, JSON.stringify(F.steps.evidence));
  });
  t('forge layout: loophealth names .forge/runs/_toollog, audit ledger lives in .forge/audit, registry finds the run', () => {
    assert.ok(/no \.forge\/runs\/_toollog folder yet/.test(F.steps.loophealth.note), F.steps.loophealth.note);
    assert.ok(exists(path.join(forgeProj, '.forge', 'audit', 'ledger.jsonl')));
    assert.strictEqual(F.steps.ledger.length, 1);
    assert.strictEqual(F.steps.registry.last_run_id, RUN);
  });

  // ---- the legacy layout: byte-for-byte the old locations ----
  t('legacy layout: the same commands write .claude/forge-runs exactly as before and no .forge appears', () => {
    assert.strictEqual(L.runsDir, path.join(legacyProj, '.claude', 'forge-runs'));
    assert.ok(exists(path.join(L.runDir, 'events.jsonl')));
    assert.ok(!exists(path.join(legacyProj, '.forge')), '.forge appeared in a legacy project (layout flip)');
    assert.ok(L.steps.logOut.includes(path.join('forge-runs', RUN, 'events.jsonl')), 'old writer message: ' + L.steps.logOut);
    assert.ok(exists(path.join(legacyProj, '.claude', 'forge-audit', 'ledger.jsonl')));
    assert.ok(/no \.claude\/forge-runs\/_toollog folder yet/.test(L.steps.loophealth.note), L.steps.loophealth.note);
    assert.strictEqual(L.steps.receiptFile, path.join(L.runDir, 'run-finalized.json'));
    assert.strictEqual(L.steps.arm.path, path.join(L.runDir, 'manifest.json'));
    assert.deepStrictEqual(L.steps.budgetDir, { ok: true, dir: L.runDir });
  });
  t('legacy layout: every tool saw the run (same verdicts as the forge project)', () => {
    for (const k of ['stats', 'cost', 'lock', 'runwatch', 'heartbeat', 'runinfo', 'plan']) assert.strictEqual(L.steps[k].status, F.steps[k].status, k);
    assert.strictEqual(JSON.parse(L.steps.stats.stdout).runs_scanned, 1);
    assert.strictEqual(L.steps.registry.last_run_id, RUN);
    assert.deepStrictEqual(L.steps.events.map((e) => e.event_type), F.steps.events.map((e) => e.event_type));
  });
  t('both layouts leave the SAME runs tree (file for file), only the root folder differs', () => {
    const norm = (list) => list.map((x) => x.replace(/^_testlogs\/testrun-.*\.log$/, '_testlogs/testrun-<ts>.log'));
    assert.deepStrictEqual(norm(tree(F.runsDir)), norm(tree(L.runsDir)));
  });

  // ---- a rule gated on a legacy state path keeps applying in the forge layout ----
  t('runcontract applies_if_exists: the scribe rule applies once .forge/scribe/ledger.jsonl exists (not switched off by opting in)', () => {
    const naOf = (root) => {
      const r = run(path.join(BIN, 'forge-runcontract.cjs'), ['check', '--run', RUN, '--root', root, '--rules', REAL_RULES, '--json']);
      return (JSON.parse(r.stdout.trim().split('\n')[0]).not_applicable || []).map((x) => x.id);
    };
    assert.ok(naOf(forgeProj).includes('owner-requests-reconciled'), 'no scribe store yet: the rule must be not-applicable');
    mk(forgeProj, '.forge', 'scribe');
    fs.writeFileSync(path.join(forgeProj, '.forge', 'scribe', 'ledger.jsonl'), '{"seq":1,"op":"open","rid":"R-1"}\n');
    assert.ok(!naOf(forgeProj).includes('owner-requests-reconciled'), 'the .forge scribe store exists: the rule must apply');
    assert.ok(naOf(legacyProj).includes('owner-requests-reconciled'), 'legacy project without a scribe store: not-applicable as before');
  });

  // ---- an older resolver (synced project with WP 1.2 forge-paths.cjs) ----
  t('older forge-paths.cjs (no stateDir): .forge/ present, yet the writer and runinfo stay legacy and never crash', () => {
    const old = makeProject('old-paths', true, { oldPaths: true });
    const r = run(path.join(old, '.claude', 'forge-dashboard', 'log-event.cjs'), [RUN, 'agent_note', JSON.stringify({ agent: 'orchestrator', note: 'old' })], { cwd: old });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(exists(path.join(old, '.claude', 'forge-runs', RUN, 'events.jsonl')), 'legacy file missing');
    assert.ok(!exists(path.join(old, '.forge', 'runs')), 'an old resolver must never route into .forge');
    const ri = run(path.join(old, '.claude', 'forge-bin', 'forge-runinfo.cjs'), ['runs'], { cwd: old });
    assert.strictEqual(ri.status, 0, ri.stderr);
    assert.ok(ri.stdout.includes(RUN), ri.stdout);
  });

  // ---- plugin copies: discovered project, never the plugin folder ----
  const plugScripts = mk(tmp, 'plugin', 'scripts');
  for (const f of ['forge-paths.cjs', 'forge-stats.cjs', 'forge-lock-guard.cjs', 'forge-run-state.cjs', 'forge-runinfo.cjs']) fs.copyFileSync(path.join(BIN, f), path.join(plugScripts, f));
  fs.copyFileSync(DEV_LOG_EVENT, path.join(plugScripts, 'log-event.cjs'));
  const plugBefore = tree(path.join(tmp, 'plugin'));
  const plugProj = makeProject('plug-proj', true);
  const P2 = 'forge-2026-10-24-plugin';
  t('plugin copies with the cwd inside a .forge project write that project\'s .forge/runs', () => {
    const cwd = path.join(plugProj, 'src');
    const le = run(path.join(plugScripts, 'log-event.cjs'), [P2, 'agent_note', JSON.stringify({ agent: 'orchestrator', note: 'from the plugin' })], { cwd });
    assert.strictEqual(le.status, 0, le.stderr);
    assert.ok(exists(path.join(plugProj, '.forge', 'runs', P2, 'events.jsonl')), 'events not in the discovered project');
    const st = run(path.join(plugScripts, 'forge-stats.cjs'), ['--json'], { cwd });
    assert.strictEqual(st.status, 0, st.stderr);
    assert.ok(exists(path.join(plugProj, '.forge', 'runs', 'STATS.json')));
    const lk = run(path.join(plugScripts, 'forge-lock-guard.cjs'), ['acquire', 'src/b.js', '--run', P2], { cwd });
    assert.strictEqual(lk.status, 0, lk.stderr);
    assert.ok(exists(path.join(plugProj, '.forge', 'runs', '.hotspot-locks')));
    const rs = run(path.join(plugScripts, 'forge-run-state.cjs'), [P2, '--json'], { cwd });
    assert.ok([0, 3].includes(rs.status), rs.stderr);
    const ri = run(path.join(plugScripts, 'forge-runinfo.cjs'), ['runs'], { cwd });
    assert.strictEqual(ri.status, 0, ri.stderr);
    assert.ok(ri.stdout.includes(P2), 'plugin runinfo did not list the discovered project run: ' + ri.stdout);
    assert.ok(!exists(path.join(plugProj, '.claude', 'forge-runs')));
  });
  t('plugin copies run from a folder outside any project refuse (or act on a real project), never the plugin folder', () => {
    const outside = mk(tmp, 'no-project-here', 'deep');
    for (const [script, args] of [['log-event.cjs', [P2, 'agent_note', '{"agent":"orchestrator","note":"x"}']], ['forge-stats.cjs', ['--json']], ['forge-runinfo.cjs', ['runs']]]) {
      const r = run(path.join(plugScripts, script), args, { cwd: outside });
      if (r.status !== 0) assert.ok(/no project root found/.test(r.stderr), script + ': ' + r.stderr);
    }
    assert.ok(!exists(path.join(tmp, 'no-project-here', 'deep', '.claude')) && !exists(path.join(tmp, '.claude')));
  });
  t('nothing was ever written inside the plugin folder', () => {
    assert.deepStrictEqual(tree(path.join(tmp, 'plugin')), plugBefore);
  });
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
