#!/usr/bin/env node
'use strict';
/** log-event-completion-gate.test.cjs —.
 *
 *  The completion choke point and the one completion recipe, proven against COPIES of the real writer, run
 *  contract and finalize module in throwaway project roots:
 *   (1) a run that follows the completion sequence passes the run_completed gate silently, also under strict,
 *       and finalizes; `plan` then shows all five steps done;
 *   (2) run_completed without the sequence is WARNED by default (written, exit 0) and REFUSED under
 *       FORGE_COMPLETION_GATE=strict (exit 2, nothing written) — single event and batch alike;
 *   (3) fail-safe: an unloadable checker, a corrupt rules file or a log the strict reader cannot judge gives a
 *       NOTE and the event is still written, even under strict;
 *   (4) an honest failure close is not gated; a run with no events is;
 *   (5) the batch path judges run_completed with the batch lines before it;
 *   (6) replay of the four historical skip patterns (no gate_evaluated, no memory update, a work package never
 *       closed, finalize skipped) shows each one would have been caught at completion time;
 *   (7) `plan` on a fixture run (phase-aware, <= 40 lines, JSON, cheap) and on a read-only copy of the real
 *       finalized (receipt read through finalize, cause + reverified).
 *  Every fixture lives in its own os.mkdtemp root, removed at the end; the real project is only READ. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); }
};

const CLAUDE = path.join(__dirname, '..');
const NODE = process.execPath;
const REAL = {
  writer: path.join(CLAUDE, 'forge-dashboard', 'log-event.cjs'),
  rc: path.join(__dirname, 'forge-runcontract.cjs'),
  fin: path.join(__dirname, 'forge-finalize.cjs'),
  pg: path.join(__dirname, 'forge-proof-gate.cjs'),
  rules: path.join(CLAUDE, 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
  // the per-project legacy-receipt allowlist travels with a copy of the real run folders
  legacy: path.join(CLAUDE, 'config', 'orchestration', 'FORGE_LEGACY_RECEIPTS.user.json'),
  registry: path.join(CLAUDE, 'config', 'agents', 'agent-registry.json'),
  agents: path.join(CLAUDE, 'agents'),
};
// a gate is green only when its raw output is readable and hash-verified — fixtures carry it
const OUT_TEXT = 'suite: 3 passed, 0 failed\n';
const OUT_SHA = crypto.createHash('sha256').update(OUT_TEXT).digest('hex');
const RC = require('./forge-runcontract.cjs');
const D = require('./forge-doctor.cjs');
const GOAT = 'forge-2026-10-06-model-routing-goat';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const roots = [];
/** makeRoot(opts) — a temp project holding copies of the real writer, run contract, finalize and proof-gate
 *  modules (opts.runcontract:false leaves the contract + finalize out), the production rules (or
 *  opts.rulesText), the agent registry and the agent files. */
function makeRoot(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wp5-gate-'));
  roots.push(root);
  const cd = path.join(root, '.claude');
  for (const d of ['forge-dashboard', 'forge-bin', path.join('config', 'orchestration'), path.join('config', 'agents'), 'agents', 'forge-runs']) fs.mkdirSync(path.join(cd, d), { recursive: true });
  fs.copyFileSync(REAL.writer, path.join(cd, 'forge-dashboard', 'log-event.cjs'));
  if (opts.runcontract !== false) {
    fs.copyFileSync(REAL.rc, path.join(cd, 'forge-bin', 'forge-runcontract.cjs'));
    fs.copyFileSync(REAL.fin, path.join(cd, 'forge-bin', 'forge-finalize.cjs'));
    fs.copyFileSync(REAL.pg, path.join(cd, 'forge-bin', 'forge-proof-gate.cjs'));
  }
  const rulesDest = path.join(cd, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  if (opts.rulesText === undefined) fs.copyFileSync(REAL.rules, rulesDest);
  else if (opts.rulesText !== null) fs.writeFileSync(rulesDest, opts.rulesText, 'utf8');
  if (fs.existsSync(REAL.legacy)) fs.copyFileSync(REAL.legacy, path.join(cd, 'config', 'orchestration', 'FORGE_LEGACY_RECEIPTS.user.json'));
  fs.copyFileSync(REAL.registry, path.join(cd, 'config', 'agents', 'agent-registry.json'));
  for (const f of fs.readdirSync(REAL.agents)) if (f.endsWith('.md')) fs.copyFileSync(path.join(REAL.agents, f), path.join(cd, 'agents', f));
  return root;
}
function envWith(extra) {
  const e = Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' });
  delete e.FORGE_COMPLETION_GATE;
  return Object.assign(e, extra || {});
}
const STRICT = { FORGE_COMPLETION_GATE: 'strict' };
const writerOf = (root) => path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
function log(root, runId, type, payload, extraEnv) {
  return spawnSync(NODE, [writerOf(root), runId, type, JSON.stringify(payload || { agent: 'orchestrator' })], { encoding: 'utf8', env: envWith(extraEnv) });
}
function batch(root, runId, lines, extraEnv) {
  return spawnSync(NODE, [writerOf(root), '--batch', runId], { input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', encoding: 'utf8', env: envWith(extraEnv) });
}
function rcCli(root, args) {
  return spawnSync(NODE, [path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs'), ...args, '--root', root], { encoding: 'utf8', env: envWith() });
}
function events(root, runId) {
  const f = path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const out = (r) => String(r.stdout || '') + String(r.stderr || '');
const runDirOf = (root, runId) => path.join(root, '.claude', 'forge-runs', runId);

/** seedEvidence — a minimal, valid, all-green gate-evidence.json (the same shape forge-finalize.test.cjs uses). */
function seedEvidence(root, runId, exitCode) {
  fs.mkdirSync(runDirOf(root, runId), { recursive: true });
  fs.mkdirSync(path.join(root, 'gate-output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gate-output', 'suite.txt'), OUT_TEXT);
  fs.writeFileSync(path.join(runDirOf(root, runId), 'gate-evidence.json'), JSON.stringify({ run_id: runId, gates: [{ name: 'suite', command: 'node suite.test.cjs', output_file: 'gate-output/suite.txt', exit_code: exitCode === undefined ? 0 : exitCode, output_sha256: OUT_SHA, evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
}

/** buildRun(root, runId, o) — a real L1 run through the writer copy, following the documented order. Options
 *  turn single steps off to reproduce the historical skip patterns: skipMemory, openWp, skipReport, skipEvidence,
 *  skipProof (no complete-phase `check --log-event`). Returns {problems:[...]} for setup failures. */
function buildRun(root, runId, o) {
  o = o || {};
  const problems = [];
  const must = (r, what) => { if (r.status !== 0) problems.push(what + ' exit ' + r.status + ': ' + out(r).slice(0, 300)); };
  must(log(root, runId, 'run_started', { agent: 'orchestrator', note: 'wp5 fixture' }), 'run_started');
  must(batch(root, runId, [
    { event_type: 'memory_loaded', agent: 'orchestrator' },
    { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
    { event_type: 'research_done', agent: 'orchestrator', note: 'searched for an existing implementation first' },
  ]), 'preview batch');
  must(rcCli(root, ['check', '--run', runId, '--phase', 'preview', '--log-event']), 'preview check');
  const work = [
    { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'build the thing' },
    { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_wp5_fixture_1' },
    { event_type: 'zero_console_errors_noted', agent: 'Build Boss' },
    { event_type: 'check_passed', agent: 'Test Boss', task: 'suite', command: 'node suite.test.cjs', output: '3 passed, 0 failed', exit_code: 0 },
    { event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_wp5_fixture_1', status: 'completed' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-1', evidence: 'node suite.test.cjs exit 0 (3 passed)' },
    { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP-1', verdict: 'PASS', evidence: 're-ran node suite.test.cjs: exit 0' },
  ];
  if (o.openWp) work.splice(1, 0, { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-2', mission: 'a second package that is never closed' });
  must(batch(root, runId, work), 'work batch');
  if (!o.skipMemory) {
    for (const f of ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md']) fs.writeFileSync(path.join(root, '.claude', f), '# ' + f + ' — updated by ' + runId + '\n');
    must(log(root, runId, 'memory_updated', { agent: 'orchestrator', files_changed: ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md'] }), 'memory_updated');
  }
  if (!o.skipReport) {
    fs.writeFileSync(path.join(runDirOf(root, runId), 'final-report.md'), '# Final report\n\nWhat changed, what ran, what was not done.\n');
    must(log(root, runId, 'report_generated', { agent: 'orchestrator', note: 'final-report.md written' }), 'report_generated');
  }
  if (!o.skipEvidence) seedEvidence(root, runId);
  if (!o.skipProof) {
    const c = rcCli(root, ['check', '--run', runId, '--log-event']);
    if (!o.expectRedContract) must(c, 'complete check');
  }
  return { problems };
}

try {
  console.log('log-event completion gate + forge-runcontract plan tests (WP-5)');

  // ==============================================================================================
  console.log('\n1) a run that follows the completion sequence passes the gate and finalizes');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'wp5-green';
    const b = buildRun(root, RUN);
    t('setup: the green fixture was built through the real writer and checker copies', b.problems.length === 0, b.problems.join(' | '));
    const before = events(root, RUN).length;
    const r = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'green fixture done' });
    t('run_completed after steps 1-3: exit 0, written, and the gate prints no warning', r.status === 0 && events(root, RUN).length === before + 1 && !/COMPLETION GATE/.test(String(r.stderr || '')), out(r));
    const fin = rcCli(root, ['check', '--run', RUN, '--log-event', '--finalize']);
    t('step 5 (check --log-event --finalize) finalizes the run (exit 0, FINALIZED)', fin.status === 0 && /FINALIZED/.test(out(fin)), out(fin));
    const plan = RC.planFor({ run_id: RUN }, { root });
    t('plan: all five completion steps are done and the next step says so', plan.sequence.length === 5 && plan.sequence.every((s) => s.status === 'done') && plan.next.kind === 'done', JSON.stringify(plan.sequence.map((s) => s.id + ':' + s.status)) + ' ' + JSON.stringify(plan.next));
    t('plan: the receipt is read through finalize (FINALIZED, current)', plan.finalized && plan.finalized.verdict === 'FINALIZED', JSON.stringify(plan.finalized));
    const doc = D.runContractDoctorCheck(root);
    t('doctor run_contract: the newest run is finalized and current — ok, enforced check green', doc.ok === true && doc.run_id === RUN && doc.status === 'finalized', JSON.stringify(doc).slice(0, 400));
  }
  {
    const root = makeRoot();
    const RUN = 'wp5-green-strict';
    const b = buildRun(root, RUN);
    t('setup: second green fixture built', b.problems.length === 0, b.problems.join(' | '));
    const r = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' }, STRICT);
    t('strict mode never refuses a run that met the sequence (exit 0, written)', r.status === 0 && events(root, RUN).some((e) => e.event_type === 'run_completed'), out(r));
  }

  // ==============================================================================================
  console.log('\n2) run_completed without the sequence: WARN by default, REFUSED under strict');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'wp5-nogate';
    const b = buildRun(root, RUN, { skipProof: true });
    t('setup: a run with everything except the step-3 proof', b.problems.length === 0, b.problems.join(' | '));
    const n0 = events(root, RUN).length;
    const strict = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'claimed done' }, STRICT);
    t('strict: exit 2 and NOTHING written', strict.status === 2 && events(root, RUN).length === n0, out(strict));
    t('strict: stderr says REFUSED and names step 3 contract-check with its exact command', /COMPLETION GATE REFUSED/.test(String(strict.stderr)) && /step 3 contract-check/.test(String(strict.stderr)) && /forge-runcontract\.cjs check --run wp5-nogate --log-event/.test(String(strict.stderr)), String(strict.stderr));
    const warn = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'claimed done' });
    t('default (warn): exit 0 and the event IS written', warn.status === 0 && events(root, RUN).length === n0 + 1 && events(root, RUN)[n0].event_type === 'run_completed', out(warn));
    t('default (warn): stderr carries the warning, the unmet step and the plan pointer', /COMPLETION GATE WARNING/.test(String(warn.stderr)) && /step 3 contract-check/.test(String(warn.stderr)) && /plan --run wp5-nogate/.test(String(warn.stderr)) && /strict this event would be refused/.test(String(warn.stderr)), String(warn.stderr));
  }
  {
    const root = makeRoot();
    const RUN = 'wp5-red';
    const b = buildRun(root, RUN, { skipReport: true, skipEvidence: true, expectRedContract: true });
    t('setup: a run with no report and no gate evidence', b.problems.length === 0, b.problems.join(' | '));
    const g = RC.completionGate({ run_id: RUN }, { root });
    t('completionGate(): not ok; gate-evidence and final-report pending, contract-check red (report-present missing)',
      g.ok === false && g.unmet.includes('gate-evidence') && g.unmet.includes('final-report') && g.steps.find((s) => s.id === 'contract-check').status === 'red' && g.contract.missing.includes('report-present'), JSON.stringify(g.steps.map((s) => s.id + ':' + s.status)) + ' ' + JSON.stringify(g.contract && g.contract.missing));
    t('completionGate(): judges only the steps BEFORE run-completed (the finalize receipt is not part of the gate)', g.steps.map((s) => s.id).join(',') === 'gate-evidence,final-report,contract-check', g.steps.map((s) => s.id).join(','));
  }
  {
    const root = makeRoot();
    const RUN = 'wp5-red-evidence';
    const b = buildRun(root, RUN, { skipEvidence: true });
    seedEvidence(root, RUN, 1);
    t('setup: a run whose gate evidence has a failing gate', b.problems.length === 0, b.problems.join(' | '));
    const g = RC.completionGate({ run_id: RUN }, { root });
    const ev = g.steps.find((s) => s.id === 'gate-evidence');
    t('a failing gate in gate-evidence.json is red (finalize would refuse it too)', g.ok === false && ev.status === 'red' && /failing gate/.test(ev.detail), JSON.stringify(ev));
  }

  // ==============================================================================================
  console.log('\n3) tool failure: warn mode writes with a NOTE; STRICT refuses an unevaluable completion (F06)');
  // ==============================================================================================
  // "the gate could not run" must never read as "the gate passed"
  // under strict. Default warn mode stays fail-open with a loud NOTE; an honest failure close is written in both.
  {
    const root = makeRoot({ runcontract: false });
    const RUN = 'wp5-nochecker';
    log(root, RUN, 'run_started', { agent: 'orchestrator' });
    const n0 = events(root, RUN).length;
    const r = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'x' }, STRICT);
    t('F06 checker missing (no forge-runcontract.cjs): STRICT refuses (exit 2, nothing written) and says the gate could not be evaluated', r.status === 2 && events(root, RUN).length === n0 && /COMPLETION GATE REFUSED/.test(String(r.stderr)) && /could not be evaluated/.test(String(r.stderr)), out(r));
    const fc = log(root, RUN, 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'gave up' }, STRICT);
    t('F06 checker missing + STRICT: an honest FAILURE close is still written (it claims nothing)', fc.status === 0 && events(root, RUN).some((e) => e.event_type === 'run_completed' && e.status === 'failed') && /completion gate unavailable/.test(String(fc.stderr)), out(fc));
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'x' });
    t('checker missing, default warn mode: written (exit 0) with a NOTE that names strict as the refusing mode', w.status === 0 && /completion gate unavailable/.test(String(w.stderr)) && /strict/.test(String(w.stderr)), out(w));
  }
  {
    const root = makeRoot();
    const RUN = 'wp5-badrules';
    log(root, RUN, 'run_started', { agent: 'orchestrator' });
    fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), '{ not json', 'utf8');
    const n0 = events(root, RUN).length;
    const r = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'x' }, STRICT);
    t('F06 corrupt rules file (the checker cannot evaluate): STRICT refuses, naming the run and the reason', r.status === 2 && events(root, RUN).length === n0 && /could not judge run wp5-badrules/.test(String(r.stderr)), out(r));
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'x' });
    t('corrupt rules file, warn mode: still writes with a NOTE', w.status === 0 && events(root, RUN).some((e) => e.event_type === 'run_completed') && /could not judge run wp5-badrules/.test(String(w.stderr)), out(w));
  }
  {
    const root = makeRoot();
    const RUN = 'wp5-mixedlog';
    log(root, RUN, 'run_started', { agent: 'orchestrator' });
    // an unchained legacy line AFTER a chained one: appendable through the writer lens, unreadable to the strict reader
    fs.appendFileSync(path.join(runDirOf(root, RUN), 'events.jsonl'), JSON.stringify({ run_id: RUN, event_type: 'agent_note', agent: 'orchestrator', note: 'legacy line' }) + '\n');
    const r = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'x' }, STRICT);
    t('F06 a log the strict reader cannot judge: STRICT refuses with the reason', r.status === 2 && /could not judge/.test(String(r.stderr)), out(r));
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'x' });
    t('... and warn mode writes it with a NOTE naming the reason', w.status === 0 && events(root, RUN).some((e) => e.event_type === 'run_completed') && /could not judge/.test(String(w.stderr)), out(w));
  }
  {
    // in-process unit: the gate helper itself never throws; a throwing/missing checker is 'unavailable' in warn
    // mode and 'refuse' (flagged unavailable) in strict mode — except for an honest failure close
    const LE = require('../forge-dashboard/log-event.cjs');
    const boom = { completionGate: () => { throw new Error('boom'); }, isFailureClose: RC.isFailureClose };
    const res = LE.evaluateCompletionGate({ run_id: 'x', event_type: 'run_completed' }, [], { runcontract: boom, mode: 'strict' });
    t('F06 evaluateCompletionGate(): a throwing checker under strict -> decision refuse (unavailable:true), reason on the line', res.decision === 'refuse' && res.unavailable === true && /boom/.test(res.lines.join(' ')), JSON.stringify(res));
    const warn = LE.evaluateCompletionGate({ run_id: 'x', event_type: 'run_completed' }, [], { runcontract: boom, mode: 'warn' });
    t('evaluateCompletionGate(): a throwing checker in warn mode -> unavailable (written, NOTE)', warn.decision === 'unavailable' && /boom/.test(warn.lines.join(' ')), JSON.stringify(warn));
    const fcl = LE.evaluateCompletionGate({ run_id: 'x', event_type: 'run_completed', status: 'failed' }, [], { runcontract: boom, mode: 'strict' });
    t('F06 evaluateCompletionGate(): a failure close under strict with a broken checker -> unavailable, never refused', fcl.decision === 'unavailable', JSON.stringify(fcl));
    const skip = LE.evaluateCompletionGate({ run_id: 'x', event_type: 'agent_note' }, [], { runcontract: boom, mode: 'strict' });
    t('evaluateCompletionGate(): every other event type is skipped (no checker call, no output)', skip.decision === 'skip' && skip.lines.length === 0);
    const none = LE.evaluateCompletionGate({ run_id: 'x', event_type: 'run_completed' }, [], { runcontract: null, mode: 'strict' });
    t('F06 evaluateCompletionGate(): no checker module under strict -> refuse', none.decision === 'refuse' && none.unavailable === true);
    const noneWarn = LE.evaluateCompletionGate({ run_id: 'x', event_type: 'run_completed' }, [], { runcontract: null, mode: 'warn' });
    t('evaluateCompletionGate(): no checker module in warn mode -> unavailable', noneWarn.decision === 'unavailable');
    t('F06 the failure-close MIRROR equals forge-runcontract\'s one definition byte for byte (fields + regex)', LE.FAILURE_CLOSE_RE_MIRROR.source === RC.FAILURE_CLOSE_RE.source && LE.FAILURE_CLOSE_RE_MIRROR.flags === RC.FAILURE_CLOSE_RE.flags && JSON.stringify(LE.FAILURE_CLOSE_FIELDS_MIRROR) === JSON.stringify(RC.FAILURE_CLOSE_FIELDS));
    t('completionGateMode(): strict only for FORGE_COMPLETION_GATE=strict, warn otherwise', LE.COMPLETION_GATE_ENV === 'FORGE_COMPLETION_GATE' && typeof LE.completionGateMode() === 'string');
  }

  // ==============================================================================================
  console.log('\n4) honest failure close and the empty run');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'wp5-failed';
    log(root, RUN, 'run_started', { agent: 'orchestrator' });
    log(root, RUN, 'agent_note', { agent: 'orchestrator', note: 'the approach did not work' });
    const r = log(root, RUN, 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'stopped: the approach failed' }, STRICT);
    t('a failure close (status failed) is not gated: strict writes it with a NOTE', r.status === 0 && /honest failure close/.test(String(r.stderr)) && events(root, RUN).some((e) => e.event_type === 'run_completed'), out(r));
    const plan = RC.planFor({ run_id: RUN }, { root });
    t('plan: a failure-closed run is closed-failed, finalize is n/a, next says nothing to finalize', plan.state.status === 'closed-failed' && plan.sequence.find((s) => s.id === 'finalize').status === 'n/a' && plan.next.kind === 'closed', JSON.stringify(plan.state) + JSON.stringify(plan.next));
    const fin = rcCli(root, ['check', '--run', RUN, '--log-event', '--finalize']);
    t('... and finalize still refuses it (a failure close can never become a finalized run)', fin.status !== 0, out(fin));
  }
  {
    const root = makeRoot();
    const RUN = 'wp5-empty';
    const s = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done?' }, STRICT);
    t('run_completed as the very first event: refused under strict (a computed verdict, not a tool failure)', s.status === 2 && events(root, RUN).length === 0 && /no events before run_completed/.test(String(s.stderr)), out(s));
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done?' });
    t('... and warned + written by default', w.status === 0 && events(root, RUN).length === 1 && /COMPLETION GATE WARNING/.test(String(w.stderr)), out(w));
  }

  // ==============================================================================================
  console.log('\n5) batch mode judges run_completed with the batch lines before it');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'wp5-batch';
    const b = buildRun(root, RUN, { skipProof: true });
    t('setup: a run without the step-3 proof', b.problems.length === 0, b.problems.join(' | '));
    const n0 = events(root, RUN).length;
    const refused = batch(root, RUN, [{ event_type: 'agent_note', agent: 'orchestrator', note: 'wrapping up' }, { event_type: 'run_completed', agent: 'orchestrator', summary: 'done' }], STRICT);
    t('strict batch with an unmet sequence: refused as a whole, 0 written', refused.status === 2 && events(root, RUN).length === n0 && /batch REFUSED as a whole/.test(String(refused.stderr)), out(refused));
    // the contract is green, so a proof line in the SAME batch before run_completed must be seen by the gate
    const g0 = RC.completionGate({ run_id: RUN }, { root });
    t('setup: the contract itself is green; only the proof is missing', g0.contract.ok === true && g0.unmet.join(',') === 'contract-check', JSON.stringify(g0.unmet) + JSON.stringify(g0.contract.missing));
    const ok = batch(root, RUN, [{ event_type: 'gate_evaluated', agent: 'orchestrator', ok: true, note: 'run contract PASSED (batch fixture)' }, { event_type: 'run_completed', agent: 'orchestrator', summary: 'done' }], STRICT);
    t('strict batch [proof, run_completed]: the gate sees the pending proof line and accepts (exit 0, 2 written)', ok.status === 0 && events(root, RUN).length === n0 + 2, out(ok));
  }

  // ==============================================================================================
  console.log('\n6) replay: the four historical skip patterns would have been caught');
  // ==============================================================================================
  {
    // (a) no gate_evaluated before run_completed — ended on run_completed with no gate
    const root = makeRoot();
    const RUN = 'replay-no-gate';
    buildRun(root, RUN, { skipProof: true });
    const n0 = events(root, RUN).length;
    const s = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'release done' }, STRICT);
    t('replay (a) no gate_evaluated: caught — strict refuses (exit 2), the missing step-3 proof is named', s.status === 2 && events(root, RUN).length === n0 && /contract-check/.test(String(s.stderr)), out(s));
  }
  {
    // (b) no memory_updated — 36 of 42 completed runs never updated memory
    const root = makeRoot();
    const RUN = 'replay-no-memory';
    const b = buildRun(root, RUN, { skipMemory: true });
    t('setup (b): built without any memory update', b.problems.length === 0, b.problems.join(' | '));
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    t('replay (b) no memory update: caught at completion — memory-files-touched is named on stderr (warn rule, so written)', w.status === 0 && /memory-files-touched/.test(String(w.stderr)), out(w));
  }
  {
    // (c) a work package that was never closed — 24 of 42 completed runs had open packages
    const root = makeRoot();
    const RUN = 'replay-open-wp';
    const b = buildRun(root, RUN, { openWp: true });
    t('setup (c): built with WP-2 declared and never closed', b.problems.length === 0, b.problems.join(' | '));
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    t('replay (c) open work package: caught at completion — wp-closure is named on stderr', w.status === 0 && /wp-closure/.test(String(w.stderr)), out(w));
    const g = RC.planFor({ run_id: RUN }, { root });
    const wc = g.obligations.find((o) => o.id === 'wp-closure');
    t('replay (c): plan names the open package by its wp_id', !!wc && /WP-2/.test(String(wc.reason) + String(wc.how)), JSON.stringify(wc));
  }
  {
    // (d) finalize skipped — 28 of 42 completed runs have no run-finalized.json
    const root = makeRoot();
    const RUN = 'replay-no-finalize';
    const b = buildRun(root, RUN);
    log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    t('setup (d): a completed run that was never finalized', b.problems.length === 0 && !fs.existsSync(path.join(runDirOf(root, RUN), 'run-finalized.json')), b.problems.join(' | '));
    const plan = RC.planFor({ run_id: RUN }, { root });
    const f = plan.sequence.find((s) => s.id === 'finalize');
    t('replay (d) finalize skipped: plan marks step 5 pending with the exact --finalize command as the next step', f.status === 'pending' && /--finalize/.test(String(f.command)) && plan.next.id === 'finalize', JSON.stringify(f) + JSON.stringify(plan.next));
    const doc = D.runContractDoctorCheck(root);
    t('replay (d): the enforced doctor run_contract check is RED for it (completed-not-finalized)', doc.ok === false && doc.status === 'completed-not-finalized' && /--finalize/.test(String(doc.reason)), JSON.stringify(doc).slice(0, 400));
  }

  // ==============================================================================================
  console.log('\n7) plan: phase-aware, short, machine-readable, cheap');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'wp5-plan-working';
    log(root, RUN, 'run_started', { agent: 'orchestrator' });
    batch(root, RUN, [
      { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'build' },
      { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_wp5_plan_1' },
    ]);
    const plan = RC.planFor({ run_id: RUN }, { root });
    t('plan: a run with work and no completion is "working" in phase wp', plan.state.status === 'working' && plan.state.phase === 'wp', JSON.stringify(plan.state));
    const mem = plan.obligations.find((o) => o.id === 'memory-read');
    const rep = plan.obligations.find((o) => o.id === 'report-present');
    t('plan: a preview obligation is overdue, a complete-phase one is not due yet', mem && mem.due === 'overdue' && rep && rep.due === 'later', JSON.stringify({ mem, rep }));
    t('plan: the next step is the first overdue blocking obligation', plan.next.kind === 'obligation' && plan.next.id === 'memory-read', JSON.stringify(plan.next));
    t('plan: computed in-process in well under 1 s', plan.ms < 1000, plan.ms + ' ms');
    const cli = rcCli(root, ['plan', '--run', RUN]);
    const lines = String(cli.stdout || '').trim().split(/\r?\n/);
    t('plan CLI: exit 0, at most 40 lines, names every completion step', cli.status === 0 && lines.length <= RC.PLAN_MAX_LINES && ['gate-evidence', 'final-report', 'contract-check', 'run-completed', 'finalize'].every((id) => lines.some((l) => l.includes('] ' + id))), out(cli));
    const js = rcCli(root, ['plan', '--run', RUN, '--json']);
    let parsed = null; try { parsed = JSON.parse(js.stdout); } catch { parsed = null; }
    t('plan --json: one parseable object with state, obligations, the 5-step sequence (each with a status) and next', js.status === 0 && parsed && parsed.state && Array.isArray(parsed.obligations) && Array.isArray(parsed.sequence) && parsed.sequence.length === 5 && parsed.sequence.every((s) => typeof s.status === 'string') && parsed.next, String(js.stdout).slice(0, 300));
    const bad = rcCli(root, ['plan', '--run', 'no-such-run']);
    t('plan on an unknown run: exit 2 (usage/config error)', bad.status === 2, out(bad));
    const noRun = rcCli(root, ['plan']);
    t('plan without --run: exit 2', noRun.status === 2, out(noRun));
  }
  {
    // the step list comes from the registry; an older registry falls back to the built-in default, an unknown step is reported
    const rules = JSON.parse(fs.readFileSync(REAL.rules, 'utf8'));
    t('completionSequenceOf(): the production registry provides the sequence, in step order', RC.completionSequenceOf(rules).source === 'registry' && RC.completionSequenceOf(rules).steps.map((s) => s.id).join(',') === 'gate-evidence,final-report,contract-check,run-completed,finalize');
    t('completionSequenceOf(): no completion_sequence -> the built-in default, said out loud', (() => { const r = RC.completionSequenceOf({ rules: [] }); return r.source === 'built-in' && r.steps.length === 5 && /built-in/.test(r.note); })());
    const ev = RC.evaluateCompletionStep({ step: 9, id: 'future-step' }, { runId: 'x', state: RC.runStateOf([]) });
    t('evaluateCompletionStep(): an unknown step id is "unevaluated" — never met, never blocking', ev.status === 'unevaluated', JSON.stringify(ev));
    const withFuture = Object.assign({}, rules, { completion_sequence: rules.completion_sequence.concat([]).map((s) => Object.assign({}, s)) });
    withFuture.completion_sequence.splice(1, 0, { step: 1.5, id: 'future-step', action: 'a step a newer registry added' });
    const root = makeRoot({ rulesText: JSON.stringify(withFuture) });
    const RUN = 'wp5-future-step';
    const b = buildRun(root, RUN);
    const g = RC.completionGate({ run_id: RUN }, { root });
    t('completionGate(): an unknown pre-completion step from a newer registry does not block a run that met the known steps', b.problems.length === 0 && g.ok === true && g.steps.some((s) => s.id === 'future-step' && s.status === 'unevaluated'), JSON.stringify(g.steps.map((s) => s.id + ':' + s.status)) + b.problems.join(' | '));
    t('isFailureClose(): failed/aborted close honestly; done/completed do not', RC.isFailureClose({ status: 'failed' }) && RC.isFailureClose({ outcome: 'Aborted' }) && !RC.isFailureClose({ status: 'done' }) && !RC.isFailureClose({ status: 'completed' }) && !RC.isFailureClose({ summary: 'tests failed earlier, fixed now' }));
  }

  // ==============================================================================================
  console.log('\n8) plan on a read-only copy of the real finalized goat run');
  // ==============================================================================================
  {
    const src = path.join(CLAUDE, 'forge-runs', GOAT);
    if (!fs.existsSync(path.join(src, 'events.jsonl'))) {
      console.log('  (skip) ' + GOAT + ' is not present in this tree — nothing to copy');
    } else {
      const fp = () => ['events.jsonl', 'run-finalized.json', 'gate-evidence.json'].map((f) => { try { return sha(fs.readFileSync(path.join(src, f))); } catch { return 'absent'; } }).join(':');
      const before = fp();
      const root = makeRoot();
      fs.cpSync(src, path.join(root, '.claude', 'forge-runs', GOAT), { recursive: true });
      const plan = RC.planFor({ run_id: GOAT }, { root });
      const f = plan.sequence.find((s) => s.id === 'finalize');
      t('goat copy: completed, every step done (the receipt seals steps 1-4)', plan.state.status === 'completed' && plan.sequence.every((s) => s.status === 'done'), JSON.stringify(plan.sequence.map((s) => s.id + ':' + s.status)));
      t('goat copy: finalize is read through the receipt — HISTORICAL, with its cause and reverified carried', f.verdict === 'HISTORICAL' && typeof f.cause === 'string' && typeof f.reverified === 'boolean', JSON.stringify(f));
      t('goat copy: a HISTORICAL record that was not re-verified is never called re-verified', f.reverified === true || (/not re-verified/.test(f.detail) && !/,\s*re-verified/.test(f.detail)), f.detail);
      t('goat copy: the next step is "finalized" (no work is asked of a sealed run)', plan.next.kind === 'done' && /finalized/.test(plan.next.text), JSON.stringify(plan.next));
      t('goat copy: a live re-check that is red today is shown as informational only', plan.obligations.every((o) => o.due === 'informational'), JSON.stringify(plan.obligations.map((o) => o.id + ':' + o.due)));
      const text = RC.formatPlan(plan);
      t('goat copy: the text plan fits in 40 lines and says how the record stands', text.split('\n').length <= RC.PLAN_MAX_LINES && /Finalized: HISTORICAL/.test(text), text);
      t('goat copy: the real run folder was only read (events, receipt and evidence bytes unchanged)', fp() === before, before + ' vs ' + fp());
    }
  }

  // ==============================================================================================
  console.log('\n9) Codex R3 SC-04: the LIBRARY append path judges owner_requests_reconciled too');
  // ==============================================================================================
  try {
    const root = makeRoot();
    const cd = path.join(root, '.claude');
    for (const f of fs.readdirSync(__dirname).filter((n) => /^forge-scribe(?:-[a-z]+)?\.cjs$/.test(n) || n === 'forge-store.cjs' || n === 'forge-secret-scrub.cjs')) fs.copyFileSync(path.join(__dirname, f), path.join(cd, 'forge-bin', f));
    fs.copyFileSync(path.join(CLAUDE, 'config', 'orchestration', 'FORGE_SCRIBE.json'), path.join(cd, 'config', 'orchestration', 'FORGE_SCRIBE.json'));
    const RUN = 'wp-sc04';
    const st = log(root, RUN, 'run_started', { agent: 'orchestrator' });
    const SCR = require(path.join(cd, 'forge-bin', 'forge-scribe.cjs'));
    SCR.capture('Voeg een contactformulier toe', { root, source: 'cli' });
    const LE = require(path.join(cd, 'forge-dashboard', 'log-event.cjs'));
    const runDir = path.join(cd, 'forge-runs', RUN);
    const n0 = events(root, RUN).length;
    const plain = LE.appendChainedLocked(runDir, [{ run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator' }]);
    t('SC-04a: a library append of owner_requests_reconciled while R-0001 is open is REFUSED and writes nothing', st.status === 0 && plain.ok === false && /OWNER REQUESTS NOT RECONCILED/.test(plain.message || '') && events(root, RUN).length === n0, JSON.stringify(plain).slice(0, 300));
    const validated = { run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator' };
    const v = LE.validateForWrite(validated);
    const w2 = LE.appendChainedLocked(runDir, [validated]);
    t('SC-04b: passing validateForWrite() first does not skip the scribe gate (the library path is not a bypass)', v.ok === true && w2.ok === false && events(root, RUN).length === n0, JSON.stringify(w2).slice(0, 300));
    const forged = { run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator' };
    LE.stampScribeReconciliation(forged, { stamp: { decision: 'pass', final: true, forged: true } });
    const w3 = LE.appendChainedLocked(runDir, [forged]);
    t('SC-04c: a caller-applied pass stamp (via the exported stamper) is re-judged and refused', w3.ok === false && events(root, RUN).length === n0, JSON.stringify(w3).slice(0, 300));
    const w4 = LE.appendChainedLocked(runDir, [{ run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator', final: false }]);
    t('SC-04d: a progress-only reconciliation is judged on the library path too (refused while R-0001 is open)', w4.ok === false, JSON.stringify(w4).slice(0, 300));
    SCR.transition('R-0001', 'defer', { reason: 'next phase' }, { root }); // an agent proposal: the progress gate treats it as handled
    const w5 = LE.appendChainedLocked(runDir, [{ run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator', final: false }]);
    const last = events(root, RUN).slice(-1)[0];
    t('SC-04e: once the progress gate is OK the library append is written WITH the writer\'s own stamp and binding', w5.ok === true && last.event_type === 'owner_requests_reconciled' && last._forge_verify && last._forge_verify.scribe_gate.decision === 'pass' && last._forge_verify.scribe_gate.final === false && Number.isInteger(last._forge_verify.scribe_gate.ledger_bytes), JSON.stringify(last && last._forge_verify));

    // Codex R5 SV-04: no verdict is ever reused by object identity — the SAME object appended again is judged again
    const reused = { run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator', final: false };
    const w6 = LE.appendChainedLocked(runDir, [reused]);              // progress gate OK (R-0001 only proposed): written
    const n6 = events(root, RUN).length;
    reused.final = true;                                              // ... then its progress stamp is forged to a final pass
    if (reused._forge_verify && reused._forge_verify.scribe_gate) reused._forge_verify.scribe_gate.final = true;
    const w7 = LE.appendChainedLocked(runDir, [reused]);
    const finals = events(root, RUN).filter((e) => e.event_type === 'owner_requests_reconciled' && e._forge_verify && e._forge_verify.scribe_gate && e._forge_verify.scribe_gate.final === true);
    t('SV-04a: the same object, its stamp forged to final, is RE-JUDGED against the final gate (R-0001 only proposed for deferral) and refused — nothing written, no final pass in the log', w6.ok === true && w7.ok === false && events(root, RUN).length === n6 && finals.length === 0, JSON.stringify({ w6: w6.ok, w7: w7.ok, n: events(root, RUN).length, n6, finals: finals.length }));
    const again = { run_id: RUN, event_type: 'owner_requests_reconciled', agent: 'orchestrator', final: false };
    const w8 = LE.appendChainedLocked(runDir, [again]);                // judged OK and written once
    const n8 = events(root, RUN).length;
    SCR.capture('Voeg ook een kaart toe', { root, source: 'cli' });    // the gate turns red (a new open request)
    const w9 = LE.appendChainedLocked(runDir, [again]);
    t('SV-04b: the same (unchanged) object appended again after the gate turned red is re-judged and refused', w8.ok === true && w9.ok === false && /OWNER REQUESTS NOT RECONCILED/.test(w9.message || '') && events(root, RUN).length === n8, JSON.stringify({ w8: w8.ok, w9: w9.ok, m: String(w9.message || '').slice(0, 160) }));
    t('SV-04c: a refused re-append keeps no earlier pass stamp on the object', !(again._forge_verify && again._forge_verify.scribe_gate), JSON.stringify(again._forge_verify || null));
  } catch (e) { t('SC-04 section ran without throwing', false, e && e.stack); }
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
