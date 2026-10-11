#!/usr/bin/env node
'use strict';
/** forge-completion-proof-codex.test.cjs — regression tests for the Codex adversarial-review findings F01..F10 on
 *  the completion-proof model. Every block names the finding
 *  and reproduces the exact shape Codex used; each FAILED on the pre-fix code.
 *   F01 legacy eligibility is authenticated by the per-project allowlist; archival records never prove completion
 *       for an enforcement-era run (plan + doctor); the 14 real receipts stay HISTORICAL.
 *   F02 the rules bytes are pinned next to the receipt; a ruleset mismatch re-judges under THOSE rules (red stays
 *       red); a missing/mismatching pinned copy on a non-allowlisted receipt is unverified-archival.
 *   F03 gate evidence is green only with readable, hash-verified output; the digest binds run id, command and
 *       output reference; older digest forms bind only allowlisted receipts.
 *   F04 a failure close never finalizes, and a receipt over one is invalid.
 *   F05 the writer stamps ingested_at; a caller timestamp survives only as claimed_ts (flagged when backdated);
 *       since-exemption and doctor enforcement cannot be dodged by backdating.
 *   F06 the doctor reports an unloadable checker as RED (strict-mode refusal is in log-event-completion-gate.test).
 *   F07 every post-enforcement unresolved completion claim stays in the doctor's checked set.
 *   F09 verifier independence resolves worker membership from assignments/dispatches; unkeyed work by the closer
 *       is unresolved attribution, never independence.
 *   F10 shipcheck refuses expanded catch-all globs, too-broad rules and broad overrides, and never ships protected
 *       paths (real or synthetic probe), independent of delivery.
 *  Codex verification review R2, class A (record: .claude/forge-research/overhaul-2026-10-09/
 *  CODEX-R2-completion-proof.md) — each block below FAILED on the code before its fix:
 *   N03b an unverified-archival / un-allowlisted, not re-verified receipt is never a completion proof, also for a
 *        run that started before the cutoff (it is "archival": not red, not done)
 *   N05  evidence output containment is judged on the RESOLVED target (junction / symlink escapes are tamper)
 *   N07  strict: a null/undefined/not-applicable/unevaluated checker verdict is unavailable; unknown steps are unmet;
 *        finalize re-checks the completion sequence and refuses a completion written over an unmet sequence
 *   N08  doctor: an UNDETERMINED receipt is red in the dev tree, an ok NOTE (status undetermined) elsewhere
 *   N09  a completion claim is sticky: work after run_completed does not drop it
 *   N10  the exported appendChainedLocked stamps run_started baselines like the CLI path
 *   N11  unresolved attribution checks every assignee field on unkeyed package/dispatch events
 *   N12  shipcheck: protected paths over the release enumeration; release placeholders exist and hold no secret
 *   the gateway's /api/proof — is tested in command-center/gateway/test/proof-acceptance.test.mjs.)
 *  Every fixture lives in its own os.mkdtemp root (copies of the real writer, contract, finalize, proof-gate,
 *  rules, agent registry and agents); the real project is only READ. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 700) : '')); }
};

const CLAUDE = path.join(__dirname, '..');
const NODE = process.execPath;
const RC = require('./forge-runcontract.cjs');
const F = require('./forge-finalize.cjs');
const D = require('./forge-doctor.cjs');
const S = require('./forge-shipcheck.cjs');
const LE = require('../forge-dashboard/log-event.cjs');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const REAL = {
  writer: path.join(CLAUDE, 'forge-dashboard', 'log-event.cjs'),
  rc: path.join(__dirname, 'forge-runcontract.cjs'),
  fin: path.join(__dirname, 'forge-finalize.cjs'),
  pg: path.join(__dirname, 'forge-proof-gate.cjs'),
  doctor: path.join(__dirname, 'forge-doctor.cjs'),
  store: path.join(__dirname, 'forge-store.cjs'),
  rules: path.join(CLAUDE, 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
  registry: path.join(CLAUDE, 'config', 'agents', 'agent-registry.json'),
  agents: path.join(CLAUDE, 'agents'),
};
const OUT_TEXT = 'suite: 3 passed, 0 failed\n';
const OUT_SHA = sha(OUT_TEXT);
const roots = [];
function makeRoot(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-f-'));
  roots.push(root);
  const cd = path.join(root, '.claude');
  for (const d of ['forge-dashboard', 'forge-bin', path.join('config', 'orchestration'), path.join('config', 'agents'), 'agents', 'forge-runs']) fs.mkdirSync(path.join(cd, d), { recursive: true });
  fs.copyFileSync(REAL.writer, path.join(cd, 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(REAL.rc, path.join(cd, 'forge-bin', 'forge-runcontract.cjs'));
  fs.copyFileSync(REAL.fin, path.join(cd, 'forge-bin', 'forge-finalize.cjs'));
  fs.copyFileSync(REAL.pg, path.join(cd, 'forge-bin', 'forge-proof-gate.cjs'));
  if (opts.rulesText === undefined) fs.copyFileSync(REAL.rules, path.join(cd, 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  else fs.writeFileSync(path.join(cd, 'config', 'orchestration', 'FORGE_HARD_RULES.json'), opts.rulesText, 'utf8');
  fs.copyFileSync(REAL.registry, path.join(cd, 'config', 'agents', 'agent-registry.json'));
  for (const f of fs.readdirSync(REAL.agents)) if (f.endsWith('.md')) fs.copyFileSync(path.join(REAL.agents, f), path.join(cd, 'agents', f));
  fs.mkdirSync(path.join(root, 'gate-output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gate-output', 'suite.txt'), OUT_TEXT);
  return root;
}
const env = Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' }); delete env.FORGE_COMPLETION_GATE;
const writerOf = (root) => path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
const runDirOf = (root, run) => path.join(root, '.claude', 'forge-runs', run);
const receiptOf = (root, run) => path.join(runDirOf(root, run), 'run-finalized.json');
const log = (root, run, type, payload, extraEnv) => spawnSync(NODE, [writerOf(root), run, type, JSON.stringify(payload || { agent: 'orchestrator' })], { encoding: 'utf8', env: Object.assign({}, env, extraEnv || {}) });
const batch = (root, run, lines, args) => spawnSync(NODE, [writerOf(root), '--batch', run].concat(args || []), { input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', encoding: 'utf8', env });
const rcCli = (root, args) => spawnSync(NODE, [path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs'), ...args, '--root', root], { encoding: 'utf8', env });
const events = (root, run) => { const f = path.join(runDirOf(root, run), 'events.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)) : []; };
const out = (r) => String(r.stdout || '') + String(r.stderr || '');
const FIN = (root) => require(path.join(root, '.claude', 'forge-bin', 'forge-finalize.cjs'));
function seedEvidence(root, run, extra) {
  fs.mkdirSync(runDirOf(root, run), { recursive: true });
  fs.writeFileSync(path.join(runDirOf(root, run), 'gate-evidence.json'), JSON.stringify({ run_id: run, gates: [Object.assign({ name: 'suite', command: 'node suite.test.cjs', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: OUT_SHA, evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }, extra || {})] }));
}
/** greenRun — the documented completion sequence through the real writer copy, up to (not including) run_completed.
 *  opts.skipProof: leave out the step-3 complete-phase proof, so a later run_completed is a claim made
 *  before the contract was proven green. */
function greenRun(root, run, opts) {
  opts = opts || {};
  const steps = [];
  steps.push(log(root, run, 'run_started', { agent: 'orchestrator' }));
  steps.push(batch(root, run, [{ event_type: 'memory_loaded', agent: 'orchestrator' }, { event_type: 'owner_prefs_loaded', agent: 'orchestrator' }, { event_type: 'research_done', agent: 'orchestrator', note: 'looked for an existing implementation first' }]));
  steps.push(rcCli(root, ['check', '--run', run, '--phase', 'preview', '--log-event']));
  steps.push(batch(root, run, [
    { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'build it' },
    { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_codex_f_1' },
    { event_type: 'zero_console_errors_noted', agent: 'Build Boss' },
    { event_type: 'check_passed', agent: 'Test Boss', task: 'suite', command: 'node suite.test.cjs', output: '3 passed', exit_code: 0 },
    { event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_codex_f_1', status: 'completed' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-1', evidence: 'node suite.test.cjs exit 0' },
    { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP-1', verdict: 'PASS', evidence: 're-ran node suite.test.cjs exit 0' },
  ]));
  for (const f of ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md']) fs.writeFileSync(path.join(root, '.claude', f), '# ' + f + ' updated by ' + run + '\n');
  fs.writeFileSync(path.join(runDirOf(root, run), 'final-report.md'), '# Final report\n\nDone, with evidence.\n');
  steps.push(batch(root, run, [{ event_type: 'memory_updated', agent: 'orchestrator', files_changed: ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md'] }, { event_type: 'report_generated', agent: 'orchestrator', note: 'final-report.md' }]));
  seedEvidence(root, run);
  if (!opts.skipProof) steps.push(rcCli(root, ['check', '--run', run, '--log-event']));
  return steps.every((s) => s.status === 0) ? null : steps.map((s) => s.status + ':' + out(s).slice(0, 200)).join(' | ');
}
function finalizeGreen(root, run) {
  const setup = greenRun(root, run);
  const done = log(root, run, 'run_completed', { agent: 'orchestrator', summary: 'done' });
  const fin = rcCli(root, ['check', '--run', run, '--log-event', '--finalize']);
  return { setup, done, fin, ok: setup === null && done.status === 0 && fin.status === 0 };
}
function allowlist(root, run, generation, shaOverride) {
  const file = path.join(root, F.LEGACY_RECEIPTS_REL);
  let j = { schema: F.LEGACY_RECEIPTS_SCHEMA, receipts: [] };
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first */ }
  j.receipts.push({ run_id: run, sha256: shaOverride || sha(fs.readFileSync(receiptOf(root, run))), generation });
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
}
const readReceipt = (root, run) => JSON.parse(fs.readFileSync(receiptOf(root, run), 'utf8'));
const writeReceipt = (root, run, r) => fs.writeFileSync(receiptOf(root, run), JSON.stringify(r, null, 2) + '\n');
/** oldLegacyRun — a run from BEFORE every cutoff: an unchained log with plain timestamps, ending on run_finalized,
 *  and a legacy-generation receipt (schema 2, pins log + ruleset only) over it. */
function oldLegacyRun(root, run, startIso) {
  const start = Date.parse(startIso);
  const lines = ['run_started', 'memory_loaded', 'agent_work_package_created', 'wp_completed', 'report_generated', 'run_completed', 'run_finalized']
    .map((type, i) => JSON.stringify({ run_id: run, event_type: type, agent: 'orchestrator', timestamp: new Date(start + i * 60000).toISOString() }));
  fs.mkdirSync(runDirOf(root, run), { recursive: true });
  const text = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(runDirOf(root, run), 'events.jsonl'), text);
  fs.writeFileSync(path.join(runDirOf(root, run), 'final-report.md'), '# old report\n');
  const buf = fs.readFileSync(path.join(runDirOf(root, run), 'events.jsonl'));
  writeReceipt(root, run, { schema: 2, run_id: run, digest: sha(buf), bytes: buf.length, events: lines.length, seq_last: null, contract: 'ok', domain: null, ruleset_sha256: 'e'.repeat(64), finalized_at: new Date(start + 7 * 60000).toISOString() });
}

try {
  console.log('Codex adversarial-review regressions F01..F10 — completion-proof model');

  // ==============================================================================================
  console.log('\nF01) legacy eligibility is authenticated; archival records never prove an enforcement-era completion');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'f01-stripped';
    const g = finalizeGreen(root, RUN);
    t('F01 setup: a green run finalizes through the real copies', g.ok, g.setup || out(g.fin));
    const full = readReceipt(root, RUN);
    const stripped = Object.assign({}, full);
    for (const k of ['evidence_digest', 'code_commit', 'independent_verification']) delete stripped[k];
    writeReceipt(root, RUN, stripped);
    const c1 = FIN(root).check(root, RUN);
    t('F01 a NEW receipt with evidence_digest/code_commit/independent_verification stripped is STALE (not an unfalsifiable HISTORICAL)', c1.verdict === 'STALE' && /allowlist/i.test(c1.reason), JSON.stringify(c1).slice(0, 300));
    t('F01 receiptState says invalid and names the allowlist', FIN(root).receiptState(root, RUN).state === 'invalid' && /FORGE_LEGACY_RECEIPTS\.user\.json/.test(FIN(root).receiptState(root, RUN).reason));
    allowlist(root, RUN, 'pre-evidence', 'f'.repeat(64));
    t('F01 an allowlist entry with the WRONG sha256 authenticates nothing (still STALE)', FIN(root).check(root, RUN).verdict === 'STALE');
    allowlist(root, RUN, 'pre-evidence');
    const c2 = FIN(root).check(root, RUN);
    t('F01 the exact bytes on the allowlist -> HISTORICAL cause legacy-receipt, reverified:false, completion_proof:false, allowlisted pre-evidence', c2.verdict === 'HISTORICAL' && c2.cause === 'legacy-receipt' && c2.reverified === false && c2.completion_proof === false && c2.allowlisted === 'pre-evidence', JSON.stringify(c2).slice(0, 300));
    // the plan: this run STARTED today (enforcement era) -> an archival record is NOT a completion proof
    const plan = RC.planFor({ run_id: RUN }, { root });
    const finStep = plan.sequence.find((s) => s.id === 'finalize');
    t('F01 plan: the finalize step is RED (archival, not a completion proof), the receipt seals nothing', finStep.status === 'red' && finStep.completion_proof === false && finStep.archival === true && /not a completion proof/i.test(finStep.detail), JSON.stringify(finStep).slice(0, 400));
    t('F01 plan: finalized.completion_proof is false and next asks for owner review instead of saying "finalized"', plan.finalized && plan.finalized.completion_proof === false && plan.next.kind === 'archival', JSON.stringify(plan.next));
    t('F01 plan text labels the receipt archival, never "Finalized:"', /Receipt \(archival, NOT a completion proof\)/.test(RC.formatPlan(plan)) && !/^Finalized:/m.test(RC.formatPlan(plan)), RC.formatPlan(plan));
    const doc = D.runContractDoctorCheck(root);
    t('F01 doctor: an archival receipt on an enforcement-era completion is RED (finalized-archival, enforced)', doc.ok === false && doc.status === 'finalized-archival' && doc.enforced === true && /archival/i.test(doc.reason) && /not a completion proof/i.test(doc.reason), JSON.stringify(doc).slice(0, 400));
  }
  {
    // a genuinely OLD run (started 2026-09-01, finalized by the legacy generation) stays valid history everywhere
    const root = makeRoot();
    const RUN = 'f01-old-legacy';
    oldLegacyRun(root, RUN, '2026-09-01T10:00:00.000Z');
    t('F01 old legacy receipt without allowlist: STALE (the shape alone authenticates nothing, also for history)', FIN(root).check(root, RUN).verdict === 'STALE');
    allowlist(root, RUN, 'pre-evidence');
    const c = FIN(root).check(root, RUN);
    t('F01 allowlisted old legacy receipt: HISTORICAL legacy-receipt', c.verdict === 'HISTORICAL' && c.cause === 'legacy-receipt', JSON.stringify(c).slice(0, 200));
    const plan = RC.planFor({ run_id: RUN }, { root });
    const finStep = plan.sequence.find((s) => s.id === 'finalize');
    t('F01 plan on a PRE-cutoff run: the archival record satisfies the step (done) and is labelled archival', finStep.status === 'done' && finStep.archival === true && /archival record of a run started before/.test(finStep.detail), JSON.stringify(finStep).slice(0, 300));
    t('F01 plan on a PRE-cutoff run: sealed, next = finalized', plan.finalized && plan.finalized.completion_proof === true && plan.next.kind === 'done');
    const doc = D.runContractDoctorCheck(root);
    t('F01 doctor on a PRE-cutoff run: ok, status finalized-archival, label says archival', doc.ok === true && doc.status === 'finalized-archival' && /archival/i.test(doc.reason), JSON.stringify(doc).slice(0, 300));
    t('F01 completionProofOf(): unknown run start is judged as enforcement era (fail-closed)', RC.completionProofOf({ verdict: 'HISTORICAL', reverified: false, cause: 'legacy-receipt' }, null).ok === false && RC.completionProofOf({ verdict: 'HISTORICAL', reverified: true, cause: 'commit' }, null).ok === true && RC.completionProofOf({ verdict: 'FINALIZED' }, null).ok === true);
  }
  {
    // the 14 real receipts of this project stay HISTORICAL (dev tree only; skipped elsewhere).
    // WP-DEVTREE-TESTS: gated on the dev-tree marker itself, not only on the receipt count — a synced
    // project can hold 14+ receipts of its own (copied run history, its own allowlist) that this table never described.
    const runsDir = path.join(CLAUDE, 'forge-runs');
    const real = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => fs.existsSync(path.join(runsDir, d, 'run-finalized.json'))) : [];
    if (!D.readDevTreeMarker(path.join(CLAUDE, '..')).valid) console.log('  SKIP F01 real-receipt table (' + real.length + ' receipts here) — not the development tree (' + D.DEV_TREE_MARKER_REL + ' absent or not dev_tree:true); the 14-receipt table describes the dev tree only');
    else if (real.length < 14) console.log('  (skip) fewer than 14 real receipts here (' + real.length + ') — the real-receipt table is only asserted in the development tree');
    else {
      const root = path.join(CLAUDE, '..');
      const table = real.map((d) => { const c = F.check(root, d); return { run: d, verdict: c.verdict, cause: c.cause || null, reverified: c.reverified === true, allowlisted: c.allowlisted || null }; });
      console.log(table.map((r) => '      ' + r.run.padEnd(44) + ' ' + r.verdict + ' ' + (r.cause || '') + ' reverified=' + r.reverified + ' allowlisted=' + r.allowlisted).join('\n'));
      t('F01 all ' + real.length + ' real receipts evaluate HISTORICAL (never fail) and every one is allowlisted', table.every((r) => r.verdict === 'HISTORICAL' && r.allowlisted), JSON.stringify(table.filter((r) => r.verdict !== 'HISTORICAL')));
      t('F01 the real allowlist carries exactly the 14 receipts, each authenticated by current bytes', F.loadLegacyReceipts(root).entries.length === real.length && real.every((d) => F.allowlistedReceipt(root, d, fs.readFileSync(path.join(runsDir, d, 'run-finalized.json')))));
    }
  }

  // ==============================================================================================
  console.log('\nF02) the rules bytes are pinned next to the receipt; a mismatch re-judges under the PINNED rules');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'f02-pinned';
    const g = finalizeGreen(root, RUN);
    t('F02 setup: green run finalized', g.ok, g.setup || out(g.fin));
    const r = readReceipt(root, RUN);
    const pinnedPath = path.join(runDirOf(root, RUN), 'ruleset-pinned.json');
    t('F02 finalize wrote ruleset-pinned.json with exactly the pinned bytes (sha256 == receipt.ruleset_sha256) and recorded the file name', fs.existsSync(pinnedPath) && sha(fs.readFileSync(pinnedPath)) === r.ruleset_sha256 && r.ruleset_pinned_file === 'ruleset-pinned.json', JSON.stringify(r).slice(0, 200));
    const rulesFile = path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
    const rules0 = fs.readFileSync(rulesFile, 'utf8');
    const edited = JSON.parse(rules0);
    edited.rules.push({ id: 'nieuw-blok', rule: 'a block rule added after finalization', trigger: 'always', check: { type: 'event-present', key: ['iets_nieuws'] }, severity: 'block', override: 'n/a', source: 'test' });
    fs.writeFileSync(rulesFile, JSON.stringify(edited, null, 2));
    const h = FIN(root).check(root, RUN);
    t('F02 rules edited: HISTORICAL cause ruleset, RE-VERIFIED under the pinned rules (reverified:true, judged_under pinned-ruleset, completion_proof)', h.verdict === 'HISTORICAL' && h.cause === 'ruleset' && h.reverified === true && h.judged_under === 'pinned-ruleset' && h.completion_proof === true && h.contract_under_pinned_ruleset.ok === true, JSON.stringify(h).slice(0, 400));
    t('F02 the current-rules outcome is still reported (red on the new rule only), never decisive', h.contract_under_current_ruleset && h.contract_under_current_ruleset.ok === false && h.contract_under_current_ruleset.missing.join(',') === 'nieuw-blok');
    t('F02 plan + doctor treat it as a completion proof', RC.planFor({ run_id: RUN }, { root }).finalized.completion_proof === true && D.runContractDoctorCheck(root).ok === true);
    // red under the PINNED rules stays red: the report the pinned `report-present` rule requires is removed
    fs.rmSync(path.join(runDirOf(root, RUN), 'final-report.md'), { force: true });
    const red = FIN(root).check(root, RUN);
    t('F02 rules edited AND the contract red under the PINNED rules -> STALE (fail), never softened to HISTORICAL', red.verdict === 'STALE' && /GEPINDE regelset/.test(red.reason) && /report-present/.test(red.reason), JSON.stringify(red).slice(0, 400));
    fs.writeFileSync(path.join(runDirOf(root, RUN), 'final-report.md'), '# Final report\n\nDone, with evidence.\n');
    t('F02 restoring the report makes it re-verified HISTORICAL again (exact, not sticky)', FIN(root).check(root, RUN).verdict === 'HISTORICAL' && FIN(root).check(root, RUN).reverified === true);
    // an EDITED receipt pin: the pinned copy no longer hashes to the pin -> unverified-archival, not "historical"
    const forged = Object.assign({}, r, { ruleset_sha256: 'd'.repeat(64) });
    writeReceipt(root, RUN, forged);
    const ua = FIN(root).check(root, RUN);
    t('F02 a hand-edited receipt pin -> HISTORICAL cause unverified-archival, reverified:false, completion_proof:false, pinned_ruleset mismatch', ua.verdict === 'HISTORICAL' && ua.cause === 'unverified-archival' && ua.reverified === false && ua.completion_proof === false && ua.pinned_ruleset === 'mismatch', JSON.stringify(ua).slice(0, 400));
    t('F02 ... and the doctor is RED for it (enforcement-era claim, archival record)', D.runContractDoctorCheck(root).ok === false && D.runContractDoctorCheck(root).status === 'finalized-archival');
    writeReceipt(root, RUN, r);
    fs.rmSync(pinnedPath, { force: true });
    const missing = FIN(root).check(root, RUN);
    t('F02 pinned copy deleted (receipt not allowlisted) -> unverified-archival (pinned_ruleset absent)', missing.verdict === 'HISTORICAL' && missing.cause === 'unverified-archival' && missing.pinned_ruleset === 'absent', JSON.stringify(missing).slice(0, 300));
    allowlist(root, RUN, 'pre-pinned-ruleset');
    const al = FIN(root).check(root, RUN);
    t('F02 the same receipt allowlisted as pre-pinned-ruleset -> HISTORICAL cause ruleset, reverified:false (the pre-F02 generation, honestly)', al.verdict === 'HISTORICAL' && al.cause === 'ruleset' && al.reverified === false && al.allowlisted === 'pre-pinned-ruleset', JSON.stringify(al).slice(0, 300));
    fs.writeFileSync(rulesFile, rules0);
    t('F02 with the exact rules bytes restored it is FINALIZED again (no pinned copy needed)', FIN(root).check(root, RUN).verdict === 'FINALIZED');
    t('F02 idempotent finalize on the archival state is refused, never a silent re-seal', (() => { fs.writeFileSync(rulesFile, JSON.stringify(edited, null, 2)); const re = FIN(root).finalize(root, RUN); fs.writeFileSync(rulesFile, rules0); return re.ok === false; })());
  }

  // ==============================================================================================
  console.log('\nF03) evidence is green only with readable, hash-verified output; the digest binds run id, command and output ref');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'f03-unexecuted';
    fs.mkdirSync(runDirOf(root, RUN), { recursive: true });
    // Codex's shape: a command that never ran, an output file that does not exist, exit_code 0
    fs.writeFileSync(path.join(runDirOf(root, RUN), 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'phantom', command: 'node never-ran.test.cjs', output_file: 'gate-output/never-written.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
    const set = RC.canonicalEvidenceDigest(root, RUN);
    t('F03 unexecuted command + nonexistent output + exit 0: allGreen:false, verified:false, unverified names the gate (digest still computable)', !!set && set.allGreen === false && set.verified === false && set.unverified.join(',') === 'phantom' && typeof set.digest === 'string', JSON.stringify(set).slice(0, 300));
    const step = RC.evaluateCompletionStep({ step: 1, id: 'gate-evidence' }, { root, runId: RUN, runDir: runDirOf(root, RUN), state: RC.runStateOf([]), events: [], artifacts: [] });
    t('F03 completion step gate-evidence is RED for it', step.status === 'red', JSON.stringify(step));
    const g = greenRun(root, RUN); // real evidence then overwritten again by the phantom manifest below
    fs.writeFileSync(path.join(runDirOf(root, RUN), 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'phantom', command: 'node never-ran.test.cjs', output_file: 'gate-output/never-written.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
    log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    const fin = FIN(root).finalize(root, RUN);
    t('F03 finalize refuses it, naming the unverified gate', g === null && fin.ok === false && /UNVERIFIED|niet leesbaar/.test(fin.reason) && (fin.unverified_gates || []).join(',') === 'phantom', JSON.stringify(fin).slice(0, 300));
    // a present output whose hash does not match is tamper: no evidence set at all
    fs.writeFileSync(path.join(root, 'gate-output', 'never-written.txt'), 'something else\n');
    t('F03 a present output with a different hash is a tampered manifest: no evidence set (null)', RC.canonicalEvidenceDigest(root, RUN) === null);
    t('F03 an output path outside the project root is no evidence (null)', (() => { fs.writeFileSync(path.join(runDirOf(root, RUN), 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'esc', command: 'x', output_file: '../outside.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] })); return RC.canonicalEvidenceDigest(root, RUN) === null; })());
  }
  {
    // the digest binds what used to be invisible to it: command, run id and output reference
    const root = makeRoot();
    const mk = (run, over) => { fs.mkdirSync(runDirOf(root, run), { recursive: true }); fs.writeFileSync(path.join(runDirOf(root, run), 'gate-evidence.json'), JSON.stringify({ run_id: run, gates: [Object.assign({ name: 'suite', command: 'node suite.test.cjs', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: OUT_SHA, evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }, over || {})] })); return RC.canonicalEvidenceDigest(root, run); };
    const base = mk('f03-a');
    const otherCmd = mk('f03-a', { command: 'echo fake' });
    t('F03 the same name/exit/hash under a DIFFERENT command is a different digest', base.digest !== otherCmd.digest);
    const base2 = mk('f03-a');
    fs.copyFileSync(path.join(root, 'gate-output', 'suite.txt'), path.join(root, 'gate-output', 'other.txt'));
    const otherOut = mk('f03-a', { output_file: 'gate-output/other.txt' });
    t('F03 the same content under a DIFFERENT output reference is a different digest', base2.digest !== otherOut.digest && otherOut.verified === true);
    const otherRun = mk('f03-b');
    t('F03 the same gates under a DIFFERENT run id are a different digest', base2.digest !== otherRun.digest);
    t('F03 the old forms of the same gates are still reproduced as legacy_digests (pre-D2, pre-F03) — bound only for allowlisted receipts', base2.legacy_digests.length === 2 && base2.legacy_digests.every((d) => /^[0-9a-f]{64}$/.test(d) && d !== base2.digest));
  }
  {
    // a LIVE run's independent review must pin the current form — an older form no longer binds (no-git root)
    const root = makeRoot({ rulesText: JSON.stringify({ version: 2, owners_allowlist: ['owner'], rules: [
      { id: 'has-start', rule: 'x', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' },
      { id: 'independent-verification', rule: 'x', trigger: 'always', check: { type: 'independent-verification' }, severity: 'block', override: 'UN-OVERRIDABLE', cannot_override: true, source: 'test' },
    ] }) });
    const draai = (run, pick) => {
      fs.mkdirSync(runDirOf(root, run), { recursive: true });
      fs.writeFileSync(path.join(runDirOf(root, run), 'gate-evidence.json'), JSON.stringify({ run_id: run, gates: [{ name: 'suite', command: 'node suite.test.cjs', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: OUT_SHA, evidence_verified: true, code: { commit: null, worktree_clean: null, stable: true, no_git: true } }] }));
      const last = () => { const e = events(root, run); return e[e.length - 1].entry_hash; };
      log(root, run, 'run_started', { agent: 'orchestrator' });
      log(root, run, 'check_passed', { agent: 'Build Boss', task: 'the work', command: 'node suite.test.cjs', output: '3 passed', exit_code: 0 });
      log(root, run, 'review_started', { agent: 'Verify Boss', review_id: 'rv-' + run, subject: 'independent review of the work in this run' });
      log(root, run, 'review_completed', { agent: 'Verify Boss', review_id: 'rv-' + run, verdict: 'PASS', summary: 'reviewed', subject_log_hash: last(), evidence_digest: pick(RC.canonicalEvidenceDigest(root, run)) });
      return RC.check({ run_id: run }, { root });
    };
    const strict = draai('f03-iv-strict', (s) => s.digest);
    t('F03 IV: a review pinned with the CURRENT evidence digest satisfies independent-verification on a live (no-git) run', strict.ok === true && strict.satisfied.includes('independent-verification'), JSON.stringify(strict.rule_details['independent-verification']).slice(0, 300));
    const legacy = draai('f03-iv-legacy', (s) => s.legacy_digests[0]);
    t('F03 IV: a review pinned with an OLDER evidence form does NOT bind a live run (missing independent-verification)', legacy.ok === false && legacy.missing.includes('independent-verification') && /veranderd/.test(legacy.rule_details['independent-verification'].reason), JSON.stringify(legacy.rule_details['independent-verification']).slice(0, 300));
    const allowed = RC.check({ run_id: 'f03-iv-legacy' }, { root, acceptLegacyEvidenceDigests: true });
    t('F03 IV: only an explicit acceptLegacyEvidenceDigests (the allowlist path in finalize) binds the older form', allowed.ok === true);
  }
  {
    // a finalized run whose raw outputs are gone (another machine): unverified-archival, never fail, never current
    const root = makeRoot();
    const RUN = 'f03-outputs-gone';
    const g = finalizeGreen(root, RUN);
    t('F03 setup: finalized', g.ok, g.setup || out(g.fin));
    fs.rmSync(path.join(root, 'gate-output', 'suite.txt'), { force: true });
    const c = FIN(root).check(root, RUN);
    t('F03 outputs unavailable after finalize: HISTORICAL cause unverified-archival (manifest matches, nothing re-verifiable), completion_proof:false', c.verdict === 'HISTORICAL' && c.cause === 'unverified-archival' && c.completion_proof === false && (c.unverified_gates || []).join(',') === 'suite', JSON.stringify(c).slice(0, 300));
    t('F03 ... so the doctor is red for this enforcement-era run', D.runContractDoctorCheck(root).ok === false);
    fs.writeFileSync(path.join(root, 'gate-output', 'suite.txt'), OUT_TEXT);
    t('F03 with the outputs back it is FINALIZED again', FIN(root).check(root, RUN).verdict === 'FINALIZED');
  }

  // ==============================================================================================
  console.log('\nF04) a failure close never finalizes; a receipt over one is invalid');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'f04-failed-close';
    const setup = greenRun(root, RUN);
    t('F04 setup: COMPLETE green evidence (report, gate evidence, proof) — the honest-close shape that used to finalize', setup === null, setup);
    const closed = log(root, RUN, 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'stopped: the last gate could not be made green' }, { FORGE_COMPLETION_GATE: 'strict' });
    t('F04 the failure close itself is written (strict included)', closed.status === 0, out(closed));
    const fin = FIN(root).finalize(root, RUN);
    t('F04 finalize REFUSES the failure close (failure_close:true), no receipt is written', fin.ok === false && fin.failure_close === true && /FAALAFSLUITING/.test(fin.reason) && !fs.existsSync(receiptOf(root, RUN)), JSON.stringify(fin).slice(0, 300));
    const cli = rcCli(root, ['check', '--run', RUN, '--log-event', '--finalize']);
    t('F04 the combined --finalize path does not exit 0 either', cli.status !== 0, out(cli));
    // a receipt hand-placed over a failure close (log made to end on run_finalized) is never accepted
    log(root, RUN, 'run_finalized', { agent: 'orchestrator', evidence: 'run-finalized.json', note: 'forged slot' });
    const buf = fs.readFileSync(path.join(runDirOf(root, RUN), 'events.jsonl'));
    const evid = RC.canonicalEvidenceDigest(root, RUN);
    writeReceipt(root, RUN, { schema: 2, run_id: RUN, digest: sha(buf), bytes: buf.length, events: events(root, RUN).length, seq_last: events(root, RUN).length, contract: 'ok', domain: null, ruleset_sha256: sha(fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'))), evidence_digest: evid.digest, code_commit: 'a'.repeat(40), independent_verification: { available: false, label_only: true }, finalized_at: new Date().toISOString() });
    const c = FIN(root).check(root, RUN);
    t('F04 a receipt over a failure close is STALE with the failure named', c.verdict === 'STALE' && /FAALAFSLUITING/.test(c.reason), JSON.stringify(c).slice(0, 300));
    t('F04 the ONE predicate: finalize uses forge-runcontract isFailureClose (no second copy)', FIN(root).isFailureCloseEvent({ status: 'failed' }) === true && FIN(root).isFailureCloseEvent({ status: 'done' }) === false && RC.isFailureClose({ outcome: 'Blocked' }) === true);
  }

  // ==============================================================================================
  console.log('\nF05) writer-controlled time: ingested_at, claimed_ts, no backdating of since-exemption or enforcement');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'f05-time';
    const r1 = log(root, RUN, 'run_started', { agent: 'orchestrator', timestamp: '2020-01-01T00:00:00.000Z', ingested_at: '1999-01-01T00:00:00.000Z' });
    const e1 = events(root, RUN)[0];
    const nowMs = Date.now();
    t('F05 the writer stamps ingested_at (within a minute of now) and sets timestamp to the same instant', r1.status === 0 && typeof e1.ingested_at === 'string' && Math.abs(Date.parse(e1.ingested_at) - nowMs) < 60000 && e1.timestamp === e1.ingested_at, JSON.stringify(e1));
    t('F05 the caller timestamp survives only as claimed_ts; a caller-supplied ingested_at is dropped', e1.claimed_ts === '2020-01-01T00:00:00.000Z' && e1.ingested_at !== '1999-01-01T00:00:00.000Z');
    const r2 = log(root, RUN, 'agent_note', { agent: 'orchestrator', note: 'x', timestamp: '2019-06-01T00:00:00.000Z' });
    const e2 = events(root, RUN)[1];
    t('F05 a claim earlier than the previous ingestion is flagged claimed_ts_backdated (verify stamp + CLI NOTE)', e2._forge_verify && e2._forge_verify.claimed_ts_backdated === true && /claimed_ts/.test(String(r2.stderr)) && /CLAIMED-TS-BACKDATED/.test(String(r2.stdout)), out(r2) + JSON.stringify(e2._forge_verify));
    const r3 = log(root, RUN, 'agent_note', { agent: 'orchestrator', note: 'y' });
    t('F05 an event without a caller timestamp carries no claimed_ts and no flag', r3.status === 0 && events(root, RUN)[2].claimed_ts === undefined && !(events(root, RUN)[2]._forge_verify && events(root, RUN)[2]._forge_verify.claimed_ts_backdated));
    t('F05 the hash chain binds ingested_at/claimed_ts (the strict reader still reads the log as valid)', require(writerOf(root)).readEventsClassified(path.join(runDirOf(root, RUN), 'events.jsonl'), { verifyChain: true, runId: RUN }).status === 'valid');
    // since-exemption cannot be dodged: a backdated run_started through the writer does NOT exempt the since rules
    const rc = RC.check({ run_id: RUN }, { root });
    t('F05 since rules are NOT exempt for a run whose run_started was backdated by the caller (ingested_at decides)', rc.historical_exempt.length === 0 && Date.parse(rc.run_started_at) > Date.parse('2026-10-09T00:00:00Z'), JSON.stringify({ exempt: rc.historical_exempt, start: rc.run_started_at }));
    // genuine history (a log written before the writer stamped ingested_at) still falls back to timestamp
    fs.mkdirSync(runDirOf(root, 'f05-history'), { recursive: true });
    fs.writeFileSync(path.join(runDirOf(root, 'f05-history'), 'events.jsonl'), JSON.stringify({ run_id: 'f05-history', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-09-01T10:00:00.000Z' }) + '\n');
    const old = RC.check({ run_id: 'f05-history' }, { root });
    t('F05 a pre-F05 log (no ingested_at) falls back to timestamp: its since rules are exempt, as before', old.historical_exempt.length > 0 && old.run_started_at === '2026-09-01T10:00:00.000Z', JSON.stringify({ exempt: old.historical_exempt.length, start: old.run_started_at }));
    t('F05 tsOf prefers ingested_at over timestamp', RC.tsOf({ ingested_at: '2026-10-10T00:00:00.000Z', timestamp: '2020-01-01T00:00:00.000Z' }) === Date.parse('2026-10-10T00:00:00.000Z') && RC.tsOf({ timestamp: '2020-01-01T00:00:00.000Z' }) === Date.parse('2020-01-01T00:00:00.000Z'));
    // batch + txn: ingested_at is a writer field outside the content digest -> an exact retry is still a no-op
    const lines = [{ event_type: 'agent_progress', agent: 'orchestrator', note: 'a', status: 'completed' }, { event_type: 'agent_progress', agent: 'orchestrator', note: 'b', status: 'completed' }];
    const b1 = batch(root, RUN, lines, ['--txn', 'txn-f05-retry-1']);
    const b2 = batch(root, RUN, lines, ['--txn', 'txn-f05-retry-1']);
    t('F05 under --txn the writer-stamped ingested_at is outside the idempotency digest: the exact retry is "already applied"', b1.status === 0 && b2.status === 0 && /already applied/.test(String(b2.stdout)) && events(root, RUN).filter((e) => e.txn_id === 'txn-f05-retry-1').length === 2, out(b1) + out(b2));
  }

  // ==============================================================================================
  console.log('\nF06) the doctor reports an unloadable run-contract checker as RED');
  // ==============================================================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-f06-doctor-'));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.copyFileSync(REAL.doctor, path.join(dir, 'bin', 'forge-doctor.cjs'));
    if (fs.existsSync(REAL.store)) fs.copyFileSync(REAL.store, path.join(dir, 'bin', 'forge-store.cjs'));
    const Dbare = require(path.join(dir, 'bin', 'forge-doctor.cjs'));
    const rc = Dbare.runContractDoctorCheck(makeRoot());
    t('F06 a doctor whose forge-runcontract.cjs sibling is missing reports run_contract ok:false, status unavailable, with the repair hint', rc.ok === false && rc.status === 'unavailable' && /forge-runcontract\.cjs/.test(rc.reason), JSON.stringify(rc));
  }

  // ==============================================================================================
  console.log('\nF07) every post-enforcement unresolved completion claim stays in the checked set');
  // ==============================================================================================
  {
    const root = makeRoot();
    const setup = greenRun(root, 'f07-older');
    log(root, 'f07-older', 'run_completed', { agent: 'orchestrator', summary: 'done, forgot to finalize' });
    t('F07 setup: an older run completed (green sequence) but never finalized', setup === null && D.runContractDoctorCheck(root).status === 'completed-not-finalized', setup);
    // a NEWER run starts: before the fix the older unfinalized claim dropped out of the checked set
    log(root, 'f07-newer', 'run_started', { agent: 'orchestrator' });
    log(root, 'f07-newer', 'agent_work_package_created', { agent: 'Build Boss', wp_id: 'WP-1', mission: 'next thing' });
    const doc = D.runContractDoctorCheck(root);
    t('F07 the newest run is in progress (never blocking by itself) ...', doc.run_id === 'f07-newer' && doc.status === 'in-progress', JSON.stringify(doc).slice(0, 200));
    t('F07 ... but the older unresolved completion claim keeps the check RED and is listed with its status', doc.ok === false && Array.isArray(doc.unresolved_claims) && doc.unresolved_claims.some((u) => u.run_id === 'f07-older' && u.status === 'completed-not-finalized'), JSON.stringify(doc.unresolved_claims));
    t('F07 the summary line names the older claim', /older unresolved completion claim/.test(D.runContractSummary(doc)) && /f07-older/.test(D.runContractSummary(doc)), D.runContractSummary(doc));
    // an honest failure close and a pre-enforcement claim are never "unresolved"
    log(root, 'f07-failed', 'run_started', { agent: 'orchestrator' });
    log(root, 'f07-failed', 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'gave up' });
    fs.mkdirSync(runDirOf(root, 'f07-history'), { recursive: true });
    fs.writeFileSync(path.join(runDirOf(root, 'f07-history'), 'events.jsonl'), [{ run_id: 'f07-history', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-09-01T10:00:00.000Z' }, { run_id: 'f07-history', event_type: 'run_completed', agent: 'orchestrator', timestamp: '2026-09-01T11:00:00.000Z' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const doc2 = D.runContractDoctorCheck(root);
    t('F07 a failure close and a pre-enforcement claim are not unresolved claims (exactly the one older run is listed)', doc2.unresolved_claims.length === 1 && doc2.unresolved_claims[0].run_id === 'f07-older', JSON.stringify(doc2.unresolved_claims));
    // resolving the older claim (finalize it) clears the check
    const fin = rcCli(root, ['check', '--run', 'f07-older', '--log-event', '--finalize']);
    const doc3 = D.runContractDoctorCheck(root);
    t('F07 once the older claim is finalized the check is green again', fin.status === 0 && doc3.ok === true && doc3.unresolved_claims.length === 0, out(fin) + JSON.stringify(doc3).slice(0, 300));
  }

  // ==============================================================================================
  console.log('\nF09) verifier independence: assignments/dispatches make workers; unkeyed work is unresolved attribution');
  // ==============================================================================================
  {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-f09-'));
    roots.push(TMP);
    fs.mkdirSync(path.join(TMP, '.claude', 'forge-runs'), { recursive: true });
    const NO_OWNER = path.join(TMP, 'no-owner-profile.json');
    let n = 0;
    const rulesFile = path.join(TMP, 'rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify({ version: 2, owners_allowlist: ['owner'], rules: [{ id: 'ver', rule: 'x', trigger: 'always', check: { type: 'closure', open: 'wp_completed', close: 'wp_verified', close_where: { verdict: ['pass', 'passed'] }, key: 'wp_id', distinct_agent: true, worker_exclude: ['route_assigned', 'escalation'] }, severity: 'warn', override: 'n/a', source: 'test' }] }));
    const run = (evs) => {
      const id = 'f09-' + (++n);
      const dir = path.join(TMP, '.claude', 'forge-runs', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'events.jsonl'), evs.map((e, i) => JSON.stringify(Object.assign({ timestamp: new Date(Date.parse('2026-10-10T10:00:00Z') + i * 1000).toISOString() }, e))).join('\n') + '\n');
      return RC.check({ run_id: id }, { root: TMP, rulesPath: rulesFile, ownerProfilePath: NO_OWNER });
    };
    const det = (r) => (r.rule_details || {}).ver || {};
    // Codex's exact scenario: Build Boss dispatched WITHOUT wp_id, orchestrator logs wp_completed, Build Boss verifies
    const codex = run([
      { event_type: 'agent_work_package_created', agent: 'orchestrator', wp_id: 'WP-1', mission: 'build it' },
      { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'toolu_f09_1', task: 'build it' },
      { event_type: 'wp_completed', agent: 'orchestrator', wp_id: 'WP-1', command: 'npm test', output: 'ok' },
      { event_type: 'wp_verified', agent: 'Build Boss', wp_id: 'WP-1', verdict: 'PASS' },
    ]);
    t('F09 a Build Boss dispatched without wp_id + orchestrator wp_completed + Build Boss wp_verified PASS does NOT satisfy distinct-agent verification', codex.warnings.includes('ver') && /unresolved attribution/.test(JSON.stringify(det(codex).rejected_closes)), JSON.stringify(det(codex)));
    // the package ASSIGNEE is a worker, even without a keyed work event of its own
    const assignee = run([
      { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'build it' },
      { event_type: 'wp_completed', agent: 'orchestrator', wp_id: 'WP-1', command: 'npm test', output: 'ok' },
      { event_type: 'wp_verified', agent: 'Build Boss', wp_id: 'WP-1', verdict: 'PASS' },
    ]);
    t('F09 the agent a package was ASSIGNED to cannot verify it (self-verification via the assignment)', assignee.warnings.includes('ver') && /self-verification/.test(JSON.stringify(det(assignee).rejected_closes)), JSON.stringify(det(assignee)));
    // a dispatch without the key, linked to the item through its dispatch_id
    const linked = run([
      { event_type: 'agent_work_package_created', agent: 'orchestrator', wp_id: 'WP-1', mission: 'build it' },
      { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'toolu_f09_2', task: 'build it' },
      { event_type: 'subagent_completed', agent: 'orchestrator', wp_id: 'WP-1', dispatch_id: 'toolu_f09_2', status: 'completed' },
      { event_type: 'wp_completed', agent: 'orchestrator', wp_id: 'WP-1', command: 'npm test', output: 'ok' },
      { event_type: 'wp_verified', agent: 'Build Boss', wp_id: 'WP-1', verdict: 'PASS' },
    ]);
    t('F09 a dispatch without wp_id is linked to the item through its dispatch_id — the dispatched agent is a worker', linked.warnings.includes('ver') && /self-verification|unresolved attribution/.test(JSON.stringify(det(linked).rejected_closes)), JSON.stringify(det(linked)));
    // the legitimate shape still passes: a verifier that only verified
    const legit = run([
      { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'build it' },
      { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_f09_3' },
      { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-1', command: 'npm test', output: 'ok' },
      { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP-1', verdict: 'PASS' },
    ]);
    t('F09 a verifier that did no work (keyed or unkeyed) still closes the package', legit.satisfied.includes('ver'), JSON.stringify(det(legit)));
    const otherItem = run([
      { event_type: 'subagent_started', agent: 'Verify Boss', wp_id: 'WP-2', dispatch_id: 'toolu_f09_4', task: 'implement WP-2' },
      { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-1', command: 'npm test', output: 'ok' },
      { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP-1', verdict: 'PASS' },
    ]);
    t('F09 work on a DIFFERENT, keyed item still does not disqualify the verifier (attribution resolved)', otherItem.satisfied.includes('ver'), JSON.stringify(det(otherItem)));
  }

  // ==============================================================================================
  console.log('\nF10) shipcheck: expanded catch-all forms, breadth, broad overrides and protected paths');
  // ==============================================================================================
  {
    const mk = (files) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-f10-')); roots.push(root); for (const [rel, body] of Object.entries(files)) { const abs = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); } return root; };
    const SYNC = ['sync', 'release', 'template'];
    const manifestOf = (rules, extra) => JSON.stringify(Object.assign({ schema: 'forge-ship-manifest/v1', rules, known_gaps: [], ref_ignore: [] }, extra || {}));
    const MREL = '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json';
    const load = (rules) => { const root = mk({ [MREL]: manifestOf(rules) }); return S.loadManifest(path.join(root, MREL)); };
    for (const g of ['**/**', '*/**', '**/*', '.claude/**/**', '.claude/*/**', '.claude/**/*', '{**,docs}/**', '**/*/**']) {
      const m = load([{ pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'x' }, { pattern: g, class: 'local-only', channels: [], reason: 'hide everything' }]);
      t('F10 the expanded catch-all form ' + JSON.stringify(g) + ' is refused as manifest_invalid', m.errors.some((e) => e.kind === 'manifest_invalid' && /catch-all/.test(e.detail)), JSON.stringify(m.errors));
    }
    t('F10 isCatchAllGlob: legitimate globs with a literal segment are NOT catch-alls', ['.claude/skills/*/**', '**/*.log', 'docs/**', '.claude/{forge-runs,agent-memory}/**', '.claude/config/**/*.user.json'].every((g) => !S.isCatchAllGlob(g)));
    // the Codex case: a local-only `**/**` that hid an undelivered helper behind "classified" is refused outright
    {
      const root = mk({ [MREL]: manifestOf([{ pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' }, { pattern: '**/**', class: 'local-only', channels: [], reason: 'everything else' }]), '.claude/forge-bin/tool.cjs': '1', '.claude/forge-bin/helper.cjs': '2' });
      const rep = S.runShipcheck(root, { files: ['.claude/forge-bin/tool.cjs', '.claude/forge-bin/helper.cjs', MREL], delivered: ['forge-bin/tool.cjs', 'config/orchestration/FORGE_SHIP_MANIFEST.json'] });
      t('F10 a local-only catch-all can no longer hide an undelivered helper: the manifest is invalid (never gappable)', rep.ok === false && rep.failures.some((f) => f.kind === 'manifest_invalid' && /catch-all/.test(f.detail)), JSON.stringify(rep.failures).slice(0, 300));
    }
    // protected paths: real file + synthetic probe, independent of delivery agreement, never gappable
    {
      const rules = [
        { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
        { pattern: '.claude/**/*.md', class: 'ship-sync', channels: SYNC, reason: 'broad docs glob — also matches agent memory' },
        { pattern: '.claude/forge-runs/**', class: 'per-project', channels: [], reason: 'runs' },
        { pattern: '.claude/config/**', class: 'ship-sync', channels: SYNC, reason: 'config' },
        { pattern: '.claude/config/{forge-owner-grant*,forge-usage-guard-override-grant.json}', class: 'per-project', channels: [], reason: 'secrets' },
        { pattern: '.claude/config/**/*.user.json', class: 'per-project', channels: [], reason: 'user state' },
      ];
      const files = { [MREL]: manifestOf(rules), '.claude/forge-bin/tool.cjs': '1', '.claude/agent-memory/head-chef/MEMORY.md': 'lessons', '.claude/docs/x.md': 'doc' };
      const root = mk(files);
      const list = Object.keys(files);
      const rep = S.runShipcheck(root, { files: list, delivered: ['forge-bin/tool.cjs', 'agent-memory/head-chef/MEMORY.md', 'docs/x.md', 'config/orchestration/FORGE_SHIP_MANIFEST.json'] });
      t('F10 a REAL protected path (agent memory) classified by a broad shipped glob is protected_path_shipped even though delivery agrees', rep.failures.some((f) => f.kind === 'protected_path_shipped' && f.path === '.claude/agent-memory/head-chef/MEMORY.md' && !f.synthetic), JSON.stringify(rep.failures).slice(0, 400));
      const rules2 = rules.slice(); rules2.splice(2, 1); // drop the per-project runs rule: a probe path (no real file) must still trip
      rules2.push({ pattern: '.claude/forge-runs/**', class: 'ship-sync', channels: SYNC, reason: 'oops, shipping run data' });
      const root2 = mk({ [MREL]: manifestOf(rules2), '.claude/forge-bin/tool.cjs': '1' });
      const rep2 = S.runShipcheck(root2, { files: ['.claude/forge-bin/tool.cjs', MREL], delivered: ['forge-bin/tool.cjs', 'config/orchestration/FORGE_SHIP_MANIFEST.json'] });
      t('F10 a SYNTHETIC probe catches a shipped glob over run data even when no such file exists today', rep2.failures.some((f) => f.kind === 'protected_path_shipped' && f.synthetic === true && /forge-runs/.test(f.path)), JSON.stringify(rep2.failures).slice(0, 400));
      const gapped = mk({ [MREL]: manifestOf(rules2, { known_gaps: [{ id: 'KG-X', kinds: ['unclassified'], paths: ['**'], owner_wp: 'WP-0', reason: 'x' }] }), '.claude/forge-bin/tool.cjs': '1' });
      const repG = S.loadManifest(path.join(gapped, MREL));
      t('F10 protected_path_shipped is never a gappable kind (a known gap naming it is refused) and is in NEVER_GAPPABLE', !S.GAPPABLE_KINDS.has('protected_path_shipped') && S.NEVER_GAPPABLE.has('protected_path_shipped') && repG.errors.length === 0);
      t('F10 .env.example is deliberately NOT protected (a project may ship its example env)', S.PROTECTED_PATHS.some((p) => (p.except || []).includes('.env.example')));
    }
    // breadth: a non-per-project rule matching more than half of a 20+ file tree is refused; per-project state may dominate
    {
      const files = {}; for (let i = 0; i < 30; i++) files['.claude/forge-bin/tool' + i + '.cjs'] = '1'; files['.claude/docs/a.md'] = 'x'; files[MREL] = manifestOf([
        { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
        { pattern: '.claude/docs/**', class: 'ship-sync', channels: SYNC, reason: 'docs' },
        { pattern: '.claude/**/*.cjs', class: 'local-only', channels: [], reason: 'suspiciously wide local-only' },
      ]);
      const root = mk(files);
      const rep = S.runShipcheck(root, { files: Object.keys(files), skipSyncDrift: true });
      t('F10 a non-per-project rule matching > 50% of the tree is refused as "rule too broad" (manifest_invalid)', rep.ok === false && rep.failures.some((f) => f.kind === 'manifest_invalid' && /too broad/.test(f.detail) && /\*\.cjs/.test(f.path)), JSON.stringify(rep.failures).slice(0, 400));
      const files2 = {}; for (let i = 0; i < 30; i++) files2['.claude/forge-runs/r' + i + '/events.jsonl'] = '{}'; files2['.claude/forge-bin/a.cjs'] = '1'; files2[MREL] = manifestOf([
        { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
        { pattern: '.claude/forge-runs/**', class: 'per-project', channels: [], reason: 'runs legitimately dominate a project' },
      ]);
      const rep2 = S.runShipcheck(mk(files2), { files: Object.keys(files2), skipSyncDrift: true });
      t('F10 a per-project rule may own most of the tree (run data) without tripping the breadth guard', !rep2.failures.some((f) => /too broad/.test(f.detail)), JSON.stringify(rep2.failures).slice(0, 300));
    }
    // broad override: a non-literal non-shipped rule demoting many paths an earlier shipped rule claimed
    {
      const files = {}; for (let i = 0; i < 8; i++) files['.claude/forge-bin/helper' + i + '.cjs'] = '1'; files['.claude/skills/s/SKILL.md'] = 'x'; files[MREL] = manifestOf([
        { pattern: MREL, class: 'per-project', channels: [], reason: 'fixture manifest' },
        { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
        { pattern: '.claude/skills/*/**', class: 'ship-sync', channels: SYNC, reason: 'skills' },
        { pattern: '.claude/forge-bin/helper*.cjs', class: 'local-only', channels: [], reason: 'quietly keep the helpers local' },
      ]);
      const root = mk(files);
      const rep = S.runShipcheck(root, { files: Object.keys(files), skipSyncDrift: true });
      t('F10 a non-literal local-only rule demoting > 5 paths an earlier shipped rule claimed is broad_override (a failure)', rep.ok === false && rep.failures.some((f) => f.kind === 'broad_override' && /helper\*/.test(f.path) && f.demoted === 8), JSON.stringify(rep.failures).slice(0, 300));
      files[MREL] = manifestOf([
        { pattern: MREL, class: 'per-project', channels: [], reason: 'fixture manifest' },
        { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
        { pattern: '.claude/skills/*/**', class: 'ship-sync', channels: SYNC, reason: 'skills' },
        { pattern: '.claude/forge-bin/helper*.cjs', class: 'local-only', channels: [], reason: 'quietly keep the helpers local' },
      ], { known_gaps: [{ id: 'KG-H', kinds: ['broad_override'], paths: ['.claude/forge-bin/helper*.cjs'], owner_wp: 'WP-9', reason: 'owner reviewed: these helpers are dev-only until WP-9 ships them' }] });
      const rep2 = S.runShipcheck(mk(files), { files: Object.keys(files), skipSyncDrift: true });
      t('F10 broad_override is gappable: with an owner WP it is a warning and the check passes', rep2.ok === true && rep2.warnings.some((w) => w.kind === 'broad_override' && w.known_gap === 'KG-H'), JSON.stringify(rep2.failures) + JSON.stringify(rep2.warnings).slice(0, 200));
    }
    // the real manifest (dev tree only) passes every new guard
    const devMarker = path.join(CLAUDE, 'config', 'forge-dev-tree.json');
    if (!fs.existsSync(devMarker)) console.log('  (skip) real-manifest assertions run in the development tree only');
    else {
      const rep = S.runShipcheck(path.join(CLAUDE, '..'), { skipSyncDrift: true });
      const newKinds = rep.failures.concat(rep.warnings).filter((f) => f.kind === 'protected_path_shipped' || f.kind === 'broad_override' || (f.kind === 'manifest_invalid' && /too broad|catch-all/.test(f.detail)));
      t('F10 the REAL ship manifest trips none of the new guards (no protected path shipped, no broad override, no catch-all/too-broad rule)', newKinds.length === 0, JSON.stringify(newKinds).slice(0, 600));
    }
  }

  // ##############################################################################################
  // class A (N07..N12). N06 lives in the gateway suite.
  // ##############################################################################################

  // ==============================================================================================
  console.log('\nN03b) an unauthenticated archival receipt is never a completion proof — also for a pre-cutoff run');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'n03b-old-unverified';
    const start = Date.parse('2026-09-01T10:00:00.000Z');
    // a genuinely OLD run (before every cutoff): unchained log with plain timestamps, ending on run_finalized
    const lines = ['run_started', 'memory_loaded', 'agent_work_package_created', 'wp_completed', 'report_generated', 'run_completed', 'run_finalized']
      .map((type, i) => JSON.stringify({ run_id: RUN, event_type: type, agent: 'orchestrator', timestamp: new Date(start + i * 60000).toISOString() }));
    fs.mkdirSync(runDirOf(root, RUN), { recursive: true });
    fs.writeFileSync(path.join(runDirOf(root, RUN), 'events.jsonl'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(runDirOf(root, RUN), 'final-report.md'), '# old report\n');
    seedEvidence(root, RUN);
    const buf = fs.readFileSync(path.join(runDirOf(root, RUN), 'events.jsonl'));
    const evid = RC.canonicalEvidenceDigest(root, RUN);
    // an evidence-bearing receipt whose rules pin no longer matches, with no pinned copy, and NOT on the allowlist
    writeReceipt(root, RUN, { schema: 2, run_id: RUN, digest: sha(buf), bytes: buf.length, events: lines.length, seq_last: null, contract: 'ok', domain: null, ruleset_sha256: 'e'.repeat(64), evidence_digest: evid.digest, code_commit: 'a'.repeat(40), independent_verification: { available: false, label_only: true }, finalized_at: new Date(start + 7 * 60000).toISOString() });
    const c = FIN(root).check(root, RUN);
    t('N03b setup: a pre-cutoff run with an un-allowlisted receipt is HISTORICAL cause unverified-archival', c.verdict === 'HISTORICAL' && c.cause === 'unverified-archival' && c.reverified === false && !c.allowlisted, JSON.stringify(c).slice(0, 300));
    t('N03b finalize check(): completion_proof false, archival true (the one authoritative value)', c.completion_proof === false && c.archival === true, JSON.stringify(c).slice(0, 300));
    const plan = RC.planFor({ run_id: RUN }, { root });
    const finStep = plan.sequence.find((s) => s.id === 'finalize');
    t('N03b plan: the finalize step is NOT done — status "archival" (not red: the run predates the cutoff), completion_proof false', finStep.status === 'archival' && finStep.completion_proof === false && /not a completion proof/i.test(finStep.detail), JSON.stringify(finStep).slice(0, 400));
    t('N03b plan: the receipt seals nothing — finalized.completion_proof false, next asks for owner review', plan.finalized && plan.finalized.completion_proof === false && plan.next.kind === 'archival' && plan.sequence.every((s) => !/sealed by the receipt/.test(s.detail)), JSON.stringify(plan.next));
    const text = RC.formatPlan(plan);
    t('N03b plan text: "Receipt (archival, NOT a completion proof)" plus the tamper-evident note', /Receipt \(archival, NOT a completion proof\)/.test(text) && /tamper-evident/i.test(text), text);
    const doc = D.runContractDoctorCheck(root);
    t('N03b doctor: not red (pre-enforcement claim), but never a completion proof — finalized-archival, completion_proof false', doc.ok === true && doc.status === 'finalized-archival' && doc.completion_proof === false && doc.acceptance.completion_proof === false && /not a completion proof/i.test(doc.reason), JSON.stringify(doc).slice(0, 400));
    t('N03b completionProofOf(): unverified-archival is never a proof, whatever the run date (allowlisted or not)', RC.completionProofOf({ verdict: 'HISTORICAL', reverified: false, cause: 'unverified-archival' }, start).ok === false && RC.completionProofOf({ verdict: 'HISTORICAL', reverified: false, cause: 'unverified-archival', allowlisted: 'pre-pinned-ruleset' }, start).ok === false);
    t('N03b the allowlist generations the checker trusts are exactly the ones forge-finalize knows (no drift between the two copies)', JSON.stringify([...RC.LEGACY_ALLOWLIST_GENERATIONS].sort()) === JSON.stringify([...F.LEGACY_GENERATIONS].sort()));
    t('N03b completionProofOf(): a non-reverified HISTORICAL without an allowlist entry is never a proof; with one it is, pre-cutoff only', RC.completionProofOf({ verdict: 'HISTORICAL', reverified: false, cause: 'ruleset' }, start).ok === false && RC.completionProofOf({ verdict: 'HISTORICAL', reverified: false, cause: 'ruleset', allowlisted: 'pre-pinned-ruleset' }, start).ok === true && RC.completionProofOf({ verdict: 'HISTORICAL', reverified: false, cause: 'ruleset', allowlisted: 'pre-pinned-ruleset' }, Date.now()).ok === false);
    // the SAME receipt on the allowlist is the authenticated archival record of an old run: done, everywhere
    allowlist(root, RUN, 'pre-pinned-ruleset');
    const c2 = FIN(root).check(root, RUN);
    const plan2 = RC.planFor({ run_id: RUN }, { root });
    const doc2 = D.runContractDoctorCheck(root);
    t('N03b the same receipt ON the allowlist (pre-pinned-ruleset) of a pre-cutoff run: done in plan, completion_proof in check() and doctor', c2.cause === 'ruleset' && c2.allowlisted === 'pre-pinned-ruleset' && c2.completion_proof === true && plan2.sequence.find((s) => s.id === 'finalize').status === 'done' && doc2.ok === true && doc2.acceptance.completion_proof === true, JSON.stringify({ c2: [c2.cause, c2.allowlisted, c2.completion_proof], doc: doc2.acceptance }).slice(0, 400));
  }

  // ==============================================================================================
  console.log('\nN05) evidence output containment is judged on the RESOLVED target (junction / symlink escapes)');
  // ==============================================================================================
  {
    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-n05-outside-'));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'suite.txt'), OUT_TEXT);
    const stepOf = (run) => RC.evaluateCompletionStep({ step: 1, id: 'gate-evidence' }, { root, runId: run, runDir: runDirOf(root, run), state: RC.runStateOf([]), events: [], artifacts: [] });
    let junction;
    try { fs.symlinkSync(outside, path.join(root, 'gate-link'), 'junction'); junction = true; } catch (e) { junction = (e && e.code) || String(e); }
    if (junction !== true) console.log('  (skip) this platform cannot create a directory junction/link here (' + junction + ') — the N05 junction case is NOT exercised');
    else {
      seedEvidence(root, 'n05-junction', { output_file: 'gate-link/suite.txt' });
      const set = RC.canonicalEvidenceDigest(root, 'n05-junction');
      t('N05 an output reached through a junction that points OUTSIDE the project root is no evidence (null), even with a matching hash', set === null, JSON.stringify(set));
      t('N05 ... so the gate-evidence completion step is red', stepOf('n05-junction').status === 'red', JSON.stringify(stepOf('n05-junction')));
      fs.symlinkSync(path.join(root, 'gate-output'), path.join(root, 'gate-alias'), 'junction');
      seedEvidence(root, 'n05-inside', { output_file: 'gate-alias/suite.txt' });
      const ok = RC.canonicalEvidenceDigest(root, 'n05-inside');
      t('N05 a junction whose target stays INSIDE the root still verifies (no false tamper)', !!ok && ok.verified === true && ok.allGreen === true, JSON.stringify(ok));
    }
    let fileLink;
    try { fs.symlinkSync(path.join(outside, 'suite.txt'), path.join(root, 'gate-output', 'linked.txt'), 'file'); fileLink = true; } catch (e) { fileLink = (e && e.code) || String(e); }
    if (fileLink !== true) console.log('  (skip) file symlinks cannot be created here (' + fileLink + ' — Windows needs Developer Mode or admin) — the N05 file-symlink case is NOT exercised; the junction case above covers the escape');
    else {
      seedEvidence(root, 'n05-filelink', { output_file: 'gate-output/linked.txt' });
      t('N05 a FILE symlink inside the root that resolves to a file outside it is no evidence (null)', RC.canonicalEvidenceDigest(root, 'n05-filelink') === null);
    }
  }

  // ==============================================================================================
  console.log('\nN07) strict: no/unevaluated checker verdict = unavailable, unknown steps unmet; finalize re-checks the sequence');
  // ==============================================================================================
  {
    const ev = () => ({ run_id: 'n07-x', event_type: 'run_completed', agent: 'orchestrator' });
    const rcWith = (g) => ({ completionGate: () => g, isFailureClose: RC.isFailureClose });
    const gate = (g, mode, e) => LE.evaluateCompletionGate(e || ev(), [], { runcontract: rcWith(g), mode });
    for (const [label, g] of [['null', null], ['undefined', undefined], ['a verdict without ok', { applicable: true, steps: [] }], ['applicable:false on a completion that is not a failure close', { applicable: false }]]) {
      const s = gate(g, 'strict');
      t('N07 a checker returning ' + label + ' under strict -> refuse (unavailable), never pass', s.decision === 'refuse' && s.unavailable === true, JSON.stringify(s));
      t('N07 ... and in warn mode it is "unavailable" (written with a NOTE), never a silent pass', gate(g, 'warn').decision === 'unavailable', JSON.stringify(gate(g, 'warn')));
    }
    t('N07 a failure close is still written under strict when the checker returns nothing (it claims no completion)', gate(null, 'strict', Object.assign(ev(), { status: 'failed' })).decision === 'unavailable');
    const futureG = { applicable: true, ok: true, steps: [{ step: 1.5, id: 'future-step', status: 'unevaluated', detail: 'this checker does not know completion step "future-step"' }], unmet: [], warnings: [] };
    const fs1 = gate(futureG, 'strict');
    t('N07 an unevaluated (unknown) step that applies is UNMET under strict -> refuse, naming it', fs1.decision === 'refuse' && /future-step/.test(fs1.lines.join(' ')), JSON.stringify(fs1));
    const fw = gate(futureG, 'warn');
    t('N07 ... warn mode passes it with a NOTE that strict would refuse', fw.decision === 'pass' && /future-step/.test(fw.lines.join(' ')) && /strict/.test(fw.lines.join(' ')), JSON.stringify(fw));
  }
  {
    // a registry with an unknown pre-completion step: completionGate({strict}) is not ok and the strict writer refuses
    const rules = JSON.parse(fs.readFileSync(REAL.rules, 'utf8'));
    rules.completion_sequence = rules.completion_sequence.map((s) => Object.assign({}, s));
    rules.completion_sequence.splice(1, 0, { step: 1.5, id: 'future-step', action: 'a step a newer registry added' });
    const root = makeRoot({ rulesText: JSON.stringify(rules) });
    const RUN = 'n07-future-step';
    const setup = greenRun(root, RUN);
    t('N07 setup: a green run under a registry with an unknown step', setup === null, setup);
    const gs = RC.completionGate({ run_id: RUN }, { root, strict: true });
    t('N07 completionGate({strict:true}): the unknown step that applies is unmet (ok:false)', gs.ok === false && gs.unmet.includes('future-step'), JSON.stringify(gs.unmet));
    t('N07 completionGate() without strict keeps the WP-5 behaviour (reported, not blocking)', RC.completionGate({ run_id: RUN }, { root }).ok === true);
    const n0 = events(root, RUN).length;
    const s = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' }, { FORGE_COMPLETION_GATE: 'strict' });
    t('N07 the strict writer refuses run_completed over the unknown step (exit 2, nothing written)', s.status === 2 && events(root, RUN).length === n0 && /future-step/.test(String(s.stderr)), out(s));
  }
  {
    // finalize re-checks the sequence: a completion written in WARN mode over an unmet sequence is refused
    const root = makeRoot();
    const RUN = 'n07-warn-close';
    const setup = greenRun(root, RUN, { skipProof: true });
    const w = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'claimed before the proof' });
    const claim = events(root, RUN).slice(-1)[0];
    const stamp = claim && claim._forge_verify && claim._forge_verify.completion_gate;
    t('N07 setup: warn mode wrote run_completed over the unmet sequence and the writer stamped it (decision warn, contract-check unmet)', setup === null && w.status === 0 && /COMPLETION GATE WARNING/.test(String(w.stderr)) && !!stamp && stamp.decision === 'warn' && (stamp.unmet || []).includes('contract-check'), JSON.stringify(claim && claim._forge_verify) + out(w));
    const fin = rcCli(root, ['check', '--run', RUN, '--log-event', '--finalize']);
    t('N07 finalize REFUSES a completion written over an unmet sequence (the proof only came after the claim)', fin.status !== 0 && !fs.existsSync(receiptOf(root, RUN)), out(fin));
    const direct = FIN(root).finalize(root, RUN);
    t('N07 finalize() names the unmet step and how to recover', direct.ok === false && /contract-check/.test(direct.reason) && /run_completed again/.test(direct.reason), JSON.stringify(direct).slice(0, 400));
    const again = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done, now after the proof' });
    const fin2 = rcCli(root, ['check', '--run', RUN, '--log-event', '--finalize']);
    t('N07 recovery: run_completed logged again after the proof -> finalize succeeds (FINALIZED)', again.status === 0 && fin2.status === 0 && FIN(root).check(root, RUN).verdict === 'FINALIZED', out(again) + out(fin2));
  }
  {
    // an UNSTAMPED completion (library append, older writer) with the proof only after it: the re-check itself refuses
    const root = makeRoot();
    const RUN = 'n07-unstamped';
    const setup = greenRun(root, RUN, { skipProof: true });
    const LEr = require(writerOf(root));
    const w = LEr.appendChainedLocked(runDirOf(root, RUN), [{ run_id: RUN, event_type: 'run_completed', agent: 'orchestrator', summary: 'library close' }]);
    const proof = rcCli(root, ['check', '--run', RUN, '--log-event']);
    const fin = FIN(root).finalize(root, RUN);
    t('N07 finalize re-checks the sequence itself: an unstamped completion whose contract proof came only AFTER the claim is refused', setup === null && w.ok === true && proof.status === 0 && fin.ok === false && /contract-check/.test(fin.reason), JSON.stringify(fin).slice(0, 400));
  }

  // ==============================================================================================
  console.log('\nN08) doctor: an UNDETERMINED receipt is red in the dev tree, an ok NOTE (status undetermined) elsewhere');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'n08-undetermined';
    const g = finalizeGreen(root, RUN);
    t('N08 setup: green run finalized', g.ok, g.setup || out(g.fin));
    const gi = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    if (gi.error || gi.status !== 0) console.log('  (skip) git init failed here (' + (gi.error ? gi.error.message : gi.stderr) + ') — N08 is NOT exercised');
    else {
      const c = FIN(root).check(root, RUN);
      t('N08 setup: a repository without commits makes the receipt UNDETERMINED (git state unknown)', c.verdict === 'UNDETERMINED', JSON.stringify(c).slice(0, 300));
      const outside = D.runContractDoctorCheck(root);
      t('N08 outside the dev tree: ok:true, status "undetermined", note:true (a synced project without git never deadlocks)', outside.ok === true && outside.status === 'undetermined' && outside.note === true, JSON.stringify(outside).slice(0, 400));
      fs.writeFileSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'), '{"dev_tree": true}\n');
      const dev = D.runContractDoctorCheck(root);
      t('N08 in the dev tree: RED (finalized-undetermined, enforced) with the git reason — an unavailable git probe is not a pass', dev.ok === false && dev.status === 'finalized-undetermined' && dev.enforced === true && /git/i.test(dev.reason), JSON.stringify(dev).slice(0, 400));
    }
  }

  // ==============================================================================================
  console.log('\nN09) a completion claim is sticky: work after run_completed does not drop it');
  // ==============================================================================================
  {
    const root = makeRoot();
    const RUN = 'n09-sticky';
    const setup = greenRun(root, RUN);
    log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    t('N09 setup: completed, not finalized -> doctor completed-not-finalized', setup === null && D.runContractDoctorCheck(root).status === 'completed-not-finalized', setup);
    const note = log(root, RUN, 'agent_note', { agent: 'orchestrator', note: 'one more thing after the claim' });
    const st = RC.runStateOf(events(root, RUN));
    t('N09 a non-audit event after run_completed keeps the claim: status completed, completion_claimed, the later event recorded', note.status === 0 && st.status === 'completed' && st.completion_claimed === true && !!st.after_completion && st.after_completion.event_type === 'agent_note', JSON.stringify(st));
    const doc = D.runContractDoctorCheck(root);
    t('N09 doctor: the unfinalized claim stays RED (never "in progress" again)', doc.ok === false && doc.status === 'completed-red' && /run-completed/.test(doc.reason), JSON.stringify(doc).slice(0, 400));
    const rcStep = RC.planFor({ run_id: RUN }, { root }).sequence.find((s) => s.id === 'run-completed');
    t('N09 plan: step 4 run-completed is red and says the claim stays open until finalized or failure-closed', rcStep.status === 'red' && /stays open/.test(rcStep.detail), JSON.stringify(rcStep));
    const fc = log(root, RUN, 'run_completed', { agent: 'orchestrator', status: 'failed', summary: 'closing it as failed' });
    const doc2 = D.runContractDoctorCheck(root);
    t('N09 an explicit failure close resolves the claim (closed-failed, ok)', fc.status === 0 && doc2.ok === true && doc2.status === 'closed-failed', JSON.stringify(doc2).slice(0, 300));
  }
  {
    const root = makeRoot();
    const RUN = 'n09-reclaim';
    greenRun(root, RUN);
    log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    log(root, RUN, 'agent_note', { agent: 'orchestrator', note: 'after the claim' });
    const proof = rcCli(root, ['check', '--run', RUN, '--log-event']);
    const again = log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done again, after re-proving' });
    const fin = rcCli(root, ['check', '--run', RUN, '--log-event', '--finalize']);
    const doc = D.runContractDoctorCheck(root);
    t('N09 a new claim after the work (proof first) + finalize resolves it (finalized, doctor green)', proof.status === 0 && again.status === 0 && fin.status === 0 && doc.ok === true && doc.status === 'finalized', out(fin) + JSON.stringify(doc).slice(0, 300));
  }
  {
    // unchanged: work after completion still makes an EARLIER independent review stale
    const root = makeRoot({ rulesText: JSON.stringify({ version: 2, owners_allowlist: ['owner'], rules: [
      { id: 'has-start', rule: 'x', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' },
      { id: 'independent-verification', rule: 'x', trigger: 'always', check: { type: 'independent-verification' }, severity: 'block', override: 'UN-OVERRIDABLE', cannot_override: true, source: 'test' },
    ] }) });
    const RUN = 'n09-iv-stale';
    fs.mkdirSync(runDirOf(root, RUN), { recursive: true });
    fs.writeFileSync(path.join(runDirOf(root, RUN), 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node suite.test.cjs', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: OUT_SHA, evidence_verified: true, code: { commit: null, worktree_clean: null, stable: true, no_git: true } }] }));
    log(root, RUN, 'run_started', { agent: 'orchestrator' });
    log(root, RUN, 'check_passed', { agent: 'Build Boss', task: 'the work', command: 'node suite.test.cjs', output: '3 passed', exit_code: 0 });
    log(root, RUN, 'review_started', { agent: 'Verify Boss', review_id: 'rv-n09', subject: 'independent review of the work in this run' });
    const last = () => { const e = events(root, RUN); return e[e.length - 1].entry_hash; };
    log(root, RUN, 'review_completed', { agent: 'Verify Boss', review_id: 'rv-n09', verdict: 'PASS', summary: 'reviewed', subject_log_hash: last(), evidence_digest: RC.canonicalEvidenceDigest(root, RUN).digest });
    const before = RC.check({ run_id: RUN }, { root });
    log(root, RUN, 'run_completed', { agent: 'orchestrator', summary: 'done' });
    log(root, RUN, 'check_passed', { agent: 'Build Boss', task: 'more work after the claim', command: 'node suite.test.cjs', output: '3 passed', exit_code: 0 });
    const after = RC.check({ run_id: RUN }, { root });
    t('N09 unchanged IV semantics: work after the completion makes the earlier review stale (independent-verification missing again)', before.satisfied.includes('independent-verification') && after.missing.includes('independent-verification'), JSON.stringify({ before: before.missing, after: after.missing }));
  }

  // ==============================================================================================
  console.log('\nN10) the exported appendChainedLocked stamps run_started baselines like the CLI path');
  // ==============================================================================================
  {
    const root = makeRoot();
    const LEr = require(writerOf(root));
    const RUN = 'n10-library';
    const forged = 'f'.repeat(64);
    const w = LEr.appendChainedLocked(runDirOf(root, RUN), [{ run_id: RUN, event_type: 'run_started', agent: 'orchestrator', file_hashes: { '.claude/FORGE_MEMORY.md': forged }, file_hashes_unavailable: 'caller says so', ingested_at: '1999-01-01T00:00:00.000Z' }]);
    const e0 = events(root, RUN)[0] || {};
    t('N10 a library run_started with a forged file_hashes baseline: replaced by the writer snapshot and flagged file_hashes_replaced', w.ok === true && !!e0.file_hashes && e0.file_hashes['.claude/FORGE_MEMORY.md'] !== forged && !!e0._forge_verify && e0._forge_verify.file_hashes_replaced === true && e0.file_hashes_unavailable === undefined, JSON.stringify(e0).slice(0, 500));
    t('N10 ... and ingested_at is writer-stamped (the caller value is dropped)', e0.ingested_at !== '1999-01-01T00:00:00.000Z' && Math.abs(Date.parse(e0.ingested_at) - Date.now()) < 60000, e0.ingested_at);
    t('N10 the library-written log is chain-valid', LEr.readEventsClassified(path.join(runDirOf(root, RUN), 'events.jsonl'), { verifyChain: true, runId: RUN }).status === 'valid');
    const ev2 = { run_id: 'n10-validated', event_type: 'run_started', agent: 'orchestrator' };
    const v = LEr.validateForWrite(ev2);
    const w2 = LEr.appendChainedLocked(runDirOf(root, 'n10-validated'), [ev2]);
    const e2 = events(root, 'n10-validated')[0] || {};
    t('N10 a run_started that already went through validateForWrite is not stamped twice or flagged', v.ok && w2.ok && !(e2._forge_verify && e2._forge_verify.file_hashes_replaced) && !!e2.file_hashes, JSON.stringify(e2).slice(0, 300));
    LEr.appendChainedLocked(runDirOf(root, RUN), [{ run_id: RUN, event_type: 'run_completed', agent: 'orchestrator', _forge_verify: { completion_gate: { decision: 'pass' } } }]);
    const e3 = events(root, RUN).slice(-1)[0] || {};
    t('N10 a caller-supplied completion_gate stamp on a library append is stripped (it is writer-owned)', e3.event_type === 'run_completed' && !(e3._forge_verify && e3._forge_verify.completion_gate), JSON.stringify(e3._forge_verify));
  }

  // ==============================================================================================
  console.log('\nN11) unresolved attribution checks every assignee field on unkeyed package/dispatch events');
  // ==============================================================================================
  {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-n11-'));
    roots.push(TMP);
    fs.mkdirSync(path.join(TMP, '.claude', 'forge-runs'), { recursive: true });
    const rulesFile = path.join(TMP, 'rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify({ version: 2, owners_allowlist: ['owner'], rules: [{ id: 'ver', rule: 'x', trigger: 'always', check: { type: 'closure', open: 'wp_completed', close: 'wp_verified', close_where: { verdict: ['pass', 'passed'] }, key: 'wp_id', distinct_agent: true, worker_exclude: ['route_assigned', 'escalation'] }, severity: 'warn', override: 'n/a', source: 'test' }] }));
    let n = 0;
    const run = (evs) => {
      const id = 'n11-' + (++n);
      const dir = path.join(TMP, '.claude', 'forge-runs', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'events.jsonl'), evs.map((e, i) => JSON.stringify(Object.assign({ timestamp: new Date(Date.parse('2026-10-10T10:00:00Z') + i * 1000).toISOString() }, e))).join('\n') + '\n');
      return RC.check({ run_id: id }, { root: TMP, rulesPath: rulesFile, ownerProfilePath: path.join(TMP, 'no-owner.json') });
    };
    const det = (r) => JSON.stringify(((r.rule_details || {}).ver || {}).rejected_closes || []);
    const shape = (extra) => [
      { event_type: 'agent_work_package_created', agent: 'orchestrator', wp_id: 'WP-1', mission: 'build it' },
      extra,
      { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-1', command: 'npm test', output: 'ok' },
      { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP-1', verdict: 'PASS' },
    ];
    for (const f of ['assigned_to', 'assignee', 'to', 'target', 'owner_agent']) {
      const r = run(shape({ event_type: 'agent_work_package_created', agent: 'orchestrator', [f]: 'Verify Boss', mission: 'implement the parser' }));
      t('N11 an UNKEYED package assigned to the later closer via `' + f + '` is unresolved attribution (independence not proven)', r.warnings.includes('ver') && /unresolved attribution/.test(det(r)), det(r));
    }
    const d = run(shape({ event_type: 'subagent_started', agent: 'orchestrator', to: 'Verify Boss', dispatch_id: 'toolu_n11_1', task: 'implement the parser' }));
    t('N11 an UNKEYED work dispatch TO the closer is unresolved attribution', d.warnings.includes('ver') && /unresolved attribution/.test(det(d)), det(d));
    const rv = run(shape({ event_type: 'subagent_started', agent: 'Verify Boss', dispatch_id: 'toolu_n11_2', role: 'review', task: 'review the work' }));
    t('N11 an unkeyed REVIEW dispatch of the verifier is not work: its close still counts', rv.satisfied.includes('ver'), det(rv));
    const other = run(shape({ event_type: 'agent_work_package_created', agent: 'orchestrator', assigned_to: 'Build Boss', mission: 'implement the parser' }));
    t('N11 an unkeyed package assigned to ANOTHER agent does not disqualify the closer', other.satisfied.includes('ver'), det(other));
  }

  // ==============================================================================================
  console.log('\nN12) shipcheck: protected paths over the RELEASE enumeration; release placeholders exist and hold no secret');
  // ==============================================================================================
  {
    const mk = (files) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-n12-')); roots.push(r); for (const [rel, body] of Object.entries(files)) { const abs = path.join(r, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); } return r; };
    const SYNC = ['sync', 'release', 'template'];
    const MREL = '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json';
    const manifest = JSON.stringify({ schema: 'forge-ship-manifest/v1', known_gaps: [{ id: 'KG-N12', kinds: ['release_unexpected'], paths: ['**'], owner_wp: 'WP-0', reason: 'a release gap that must never cover a protected path or a secret' }], ref_ignore: [], rules: [
      { pattern: MREL, class: 'per-project', channels: [], reason: 'fixture manifest' },
      { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
      { pattern: '.claude/agent-memory/**', class: 'per-project', channels: [], reason: 'agent memory' },
      { pattern: 'CLAUDE.md', class: 'per-project', channels: [], release_placeholder: true, reason: 'own copy per project' },
      { pattern: 'AGENTS.md', class: 'per-project', channels: [], release_placeholder: true, reason: 'own copy per project' },
    ] });
    const src = { [MREL]: manifest, '.claude/forge-bin/tool.cjs': '1', 'CLAUDE.md': '# project\n', 'AGENTS.md': '# agents\n' };
    const root = mk(src);
    const runRel = (relFiles, relTree) => S.runShipcheck(root, { files: Object.keys(src), skipSyncDrift: true, releaseTree: relTree, releaseFiles: relFiles });
    const cleanTree = mk({ '.claude/forge-bin/tool.cjs': '1', 'CLAUDE.md': '# generic CLAUDE.md\n', 'AGENTS.md': '# agents\n', '.claude/agent-memory/head-chef/MEMORY.md': 'lessons' });
    const rep = runRel(['.claude/forge-bin/tool.cjs', 'CLAUDE.md', 'AGENTS.md', '.claude/agent-memory/head-chef/MEMORY.md'], cleanTree);
    t('N12 a protected path tracked in the RELEASE tree is protected_path_shipped (channel release) — a known gap cannot hide it', rep.failures.some((f) => f.kind === 'protected_path_shipped' && f.path === '.claude/agent-memory/head-chef/MEMORY.md' && f.channel === 'release'), JSON.stringify(rep.failures).slice(0, 500));
    const rep2 = runRel(['.claude/forge-bin/tool.cjs', 'CLAUDE.md'], cleanTree);
    t('N12 a release_placeholder entry whose placeholder is NOT tracked in the release tree is release_placeholder_missing', rep2.failures.concat(rep2.warnings).some((f) => f.kind === 'release_placeholder_missing' && f.path === 'AGENTS.md'), JSON.stringify(rep2.failures).slice(0, 400));
    const secretValue = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0', 'K1l2M3n4O5p6Q7r8'].join(''); // assembled, so no literal secret shape sits in this file
    const dirtyTree = mk({ '.claude/forge-bin/tool.cjs': '1', 'CLAUDE.md': '# generic\nexport GH_TOKEN=' + secretValue + '\n', 'AGENTS.md': '# agents\n' });
    const rep3 = runRel(['.claude/forge-bin/tool.cjs', 'CLAUDE.md', 'AGENTS.md'], dirtyTree);
    t('N12 a release placeholder whose content matches a secret shape is release_placeholder_secret, never gappable', rep3.failures.some((f) => f.kind === 'release_placeholder_secret' && f.path === 'CLAUDE.md') && S.NEVER_GAPPABLE.has('release_placeholder_secret'), JSON.stringify(rep3.failures).slice(0, 400));
    t('N12 the matched secret itself is never echoed in the report', !JSON.stringify(rep3).includes(secretValue));
    const rep4 = runRel(['.claude/forge-bin/tool.cjs', 'CLAUDE.md', 'AGENTS.md'], cleanTree);
    t('N12 clean placeholders tracked in the release tree raise nothing', rep4.ok === true && !rep4.failures.concat(rep4.warnings).some((f) => /release_placeholder|protected_path_shipped/.test(f.kind)), JSON.stringify(rep4.failures).slice(0, 400));
  }
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
