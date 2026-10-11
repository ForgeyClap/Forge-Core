#!/usr/bin/env node
'use strict';
/** Hermetic tests for FORGE_HARD_RULES.json version 2 and the forge-runcontract.cjs V2 extensions
 *  (part A): the closure / sequence / reaction / file-touched
 *  check types (pass, fail and edge cases each), the `since` (historical_exempt) and `phase` (phase_deferred)
 *  rule fields, the production registry's new sections (lifecycle, completion_sequence, steps, orchestration
 *  enforcement labels), the steps <-> run-checklist.json mirror, and the event-registration discipline.
 *  Every fixture lives in its own os.mkdtemp root; the real project is only READ (its rules file, the writer's
 *  registry source and run-checklist.json). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')); }
};

const PROD_RULES = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const CHECKLIST = path.join(__dirname, '..', 'config', 'orchestration', 'run-checklist.json');
const WRITER = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const PROD = JSON.parse(fs.readFileSync(PROD_RULES, 'utf8'));
const SINCE = '2026-10-09';
const NO_OWNER_PROFILE = path.join(os.tmpdir(), 'forge-rc-v2-no-owner-profile-' + process.pid + '.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runcontract-v2-'));
fs.mkdirSync(path.join(TMP, '.claude', 'config', 'orchestration'), { recursive: true });
fs.copyFileSync(PROD_RULES, path.join(TMP, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
console.log('forge-runcontract V2 tests (hermetic root=' + TMP + ')');

/** writeRun(root, id, events, opts) — events get `timestamp`s from opts.start (one second apart) unless
 *  opts.noTimestamps; opts.files are extra files in the run folder. Unchained lines (legacy shape). */
function writeRun(root, runId, events, opts) {
  opts = opts || {};
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.parse(opts.start || '2026-10-10T10:00:00Z');
  const lines = events.map((e, i) => JSON.stringify(opts.noTimestamps ? e : Object.assign({ timestamp: new Date(base + i * 1000).toISOString() }, e)));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  for (const name of Object.keys(opts.files || {})) fs.writeFileSync(path.join(dir, name), opts.files[name], 'utf8');
  return dir;
}
let fxN = 0;
/** rulesFile(rules) — a synthetic rules file in TMP holding exactly these rules. */
function rulesFile(rules, extra) {
  const p = path.join(TMP, 'rules-' + (++fxN) + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ version: 2, owners_allowlist: ['owner'], rules }, extra || {})), 'utf8');
  return p;
}
const R = (id, check, more) => Object.assign({ id, rule: 'fixture rule ' + id, trigger: 'always', check, severity: 'warn', override: 'owner_override rule:' + id, source: 'test fixture' }, more || {});
/** run(rule(s), events, opts) — check one synthetic rule set against one fresh run; returns the result. */
function run(rules, events, opts) {
  opts = opts || {};
  const id = 'fx-' + (++fxN);
  writeRun(TMP, id, events, opts);
  return RC.check(Object.assign({ run_id: id }, opts.params || {}), Object.assign({ root: TMP, rulesPath: rulesFile(Array.isArray(rules) ? rules : [rules]), ownerProfilePath: NO_OWNER_PROFILE }, opts.checkOpts || {}));
}
const det = (res, id) => (res.rule_details || {})[id] || {};
const ownerOv = (extra) => Object.assign({ event_type: 'owner_override', by: 'owner', reason: 'owner reviewed this explicitly and accepts it for a real reason' }, extra);

// ================================================================================================
console.log('\n1) closure');
// ================================================================================================
const WPC = R('wpc', { type: 'closure', open: 'agent_work_package_created', close: ['wp_completed', 'wp_failed'], key: 'wp_id', skip_rule: 'manifest-complete' });
{
  const r = run(WPC, [
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' },
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP2' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'x', output: 'ok' },
    { event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'WP2' },
  ]);
  t('closure PASS: every wp_id closed by a later wp_completed/wp_failed', r.satisfied.includes('wpc') && det(r, 'wpc').matched === 2, JSON.stringify(det(r, 'wpc')));
}
{
  const r = run(WPC, [
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' },
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP2' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'x', output: 'ok' },
  ]);
  t('closure FAIL: an unclosed wp_id is a warning that names the package', r.warnings.includes('wpc') && det(r, 'wpc').unclosed_count === 1 && /WP2/.test(det(r, 'wpc').reason), JSON.stringify(det(r, 'wpc')));
  t('closure FAIL at severity warn never flips ok', r.ok === true && !r.missing.includes('wpc'));
}
{
  const r = run(WPC, [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'x', output: 'ok' },
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' },
  ]);
  t('closure edge: a close BEFORE its open does not count (order matters)', r.warnings.includes('wpc'), JSON.stringify(det(r, 'wpc')));
}
{
  const r = run(WPC, [
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' },
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'x', output: 'ok' },
  ]);
  t('closure edge: one close answers ONE open (1:1, a duplicate open stays open)', r.warnings.includes('wpc') && det(r, 'wpc').unclosed_count === 1);
}
{
  const r = run(WPC, [
    { event_type: 'agent_work_package_created', agent: 'lead', title: 'WP1 without an id' },
    { event_type: 'wp_completed', agent: 'Build Boss', command: 'x', output: 'ok' },
  ]);
  t('closure edge: a package without wp_id cannot be proven closed (unkeyed, never matched by order)', r.warnings.includes('wpc') && det(r, 'wpc').unkeyed === 1);
}
{
  const r = run(WPC, [
    { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'x', output: 'ok', _forge_verify: { proof_verified: false } },
  ]);
  t('closure edge: a DISPROVEN wp_completed (content oracle proof_verified:false) closes nothing', r.warnings.includes('wpc'));
}
{
  const r = run(WPC, [{ event_type: 'run_started', agent: 'orchestrator' }]);
  t('closure edge: nothing opened = vacuously satisfied, and the detail says so', r.satisfied.includes('wpc') && det(r, 'wpc').vacuous === true);
}
{
  const base = [{ event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP7' }];
  const ok = run(WPC, base.concat([ownerOv({ rule: 'manifest-complete', wp_id: 'WP7' })]));
  t('closure skip_rule: an owner_override {rule:manifest-complete, wp_id} closes exactly that package', ok.satisfied.includes('wpc') && det(ok, 'wpc').owner_skipped === 1);
  const wrongBy = run(WPC, base.concat([ownerOv({ rule: 'manifest-complete', wp_id: 'WP7', by: 'worker-3' })]));
  t('closure skip_rule: the same skip by a non-owner `by` closes nothing', wrongBy.warnings.includes('wpc'));
  const otherWp = run(WPC, base.concat([ownerOv({ rule: 'manifest-complete', wp_id: 'WP8' })]));
  t('closure skip_rule: a skip for ANOTHER wp_id closes nothing', otherWp.warnings.includes('wpc'));
  const bare = run(WPC, base.concat([ownerOv({ rule: 'manifest-complete', wp_id: 'WP7', reason: 'manifest-complete' })]));
  t('closure skip_rule: a bare-token reason is refused (same provenance as every override)', bare.warnings.includes('wpc'));
}
// subagent closure: priority key list dispatch_id -> wp_id -> agent
const SUB = R('sub', { type: 'closure', open: ['subagent_started', 'agent_started'], close: ['subagent_completed', 'subagent_failed', 'agent_completed', 'agent_failed'], key: ['dispatch_id', 'wp_id', 'agent'] });
{
  const r = run(SUB, [
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'toolu_1' },
    { event_type: 'subagent_started', agent: 'Test Boss', dispatch_id: 'toolu_2' },
    { event_type: 'subagent_completed', agent: 'build-boss' }, // no dispatch_id: paired on agent (normalized)
    { event_type: 'subagent_failed', agent: 'Test Boss', dispatch_id: 'toolu_2' },
  ]);
  t('closure key priority: dispatch_id when both carry it, else agent name (build-boss == Build Boss)', r.satisfied.includes('sub'), JSON.stringify(det(r, 'sub')));
}
{
  const r = run(SUB, [
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'toolu_1' },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'toolu_OTHER' },
  ]);
  t('closure key priority: a DIFFERENT dispatch_id never falls through to the agent name', r.warnings.includes('sub'));
}
// distinct_agent: no self-verification
const VER = R('ver', { type: 'closure', open: 'wp_completed', close: 'wp_verified', close_where: { verdict: ['pass', 'passed'] }, key: 'wp_id', distinct_agent: true, worker_exclude: ['route_assigned', 'escalation'] });
{
  const done = { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'npm test', output: 'ok' };
  const good = run(VER, [done, { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' }]);
  t('distinct_agent PASS: a non-worker wp_verified PASS closes the package', good.satisfied.includes('ver'), JSON.stringify(det(good, 'ver')));
  const self = run(VER, [done, { event_type: 'wp_verified', agent: 'build-boss', wp_id: 'WP1', verdict: 'PASS' }]);
  t('distinct_agent FAIL: the worker verifying its own package is rejected as self-verification', self.warnings.includes('ver') && /self-verification/.test(JSON.stringify(det(self, 'ver').rejected_closes)), JSON.stringify(det(self, 'ver')));
  const helper = run(VER, [
    { event_type: 'subagent_started', agent: 'Verify Boss', dispatch_id: 'toolu_9', wp_id: 'WP1', task: 'implement the fix' },
    done,
    { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' },
  ]);
  t('distinct_agent FAIL: an agent dispatched to WORK on the same wp_id cannot verify it', helper.warnings.includes('ver'));
  const otherWp = run(VER, [
    { event_type: 'subagent_started', agent: 'Verify Boss', dispatch_id: 'toolu_9', wp_id: 'WP2', task: 'implement WP2' },
    done,
    { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' },
  ]);
  t('distinct_agent edge: work on a DIFFERENT package does not disqualify the verifier', otherWp.satisfied.includes('ver'));
  const failVerdict = run(VER, [done, { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'FAIL' }]);
  t('close_where: a FAIL verdict does not close the package', failVerdict.warnings.includes('ver'));
  const anon = run(VER, [done, { event_type: 'wp_verified', wp_id: 'WP1', verdict: 'PASS' }]);
  t('distinct_agent edge: an unattributed wp_verified proves no second party', anon.warnings.includes('ver'));
  const routed = run(VER, [
    { event_type: 'route_assigned', agent: 'Verify Boss', wp_id: 'WP1', route: 'build' },
    done,
    { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' },
  ]);
  t('worker_exclude: bookkeeping (route_assigned) by the verifier does not make it a worker', routed.satisfied.includes('ver'));
}

// ================================================================================================
console.log('\n2) sequence');
// ================================================================================================
const SEQ = R('seq', { type: 'sequence', before: ['run_started', ['memory_loaded', 'project_scanned'], 'owner_prefs_loaded', { event: 'gate_evaluated', where: { phase: 'preview' } }], after: ['agent_work_package_created', 'subagent_started'] });
const pre = [
  { event_type: 'run_started', agent: 'orchestrator' },
  { event_type: 'project_scanned', agent: 'orchestrator' },
  { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
  { event_type: 'gate_evaluated', agent: 'orchestrator', ok: false, phase: 'preview', note: 'preview check' },
];
{
  const r = run(SEQ, pre.concat([{ event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' }]));
  t('sequence PASS: every item (any-of and {event,where} included) precedes the first work event', r.satisfied.includes('seq'), JSON.stringify(det(r, 'seq')));
}
{
  const r = run(SEQ, [pre[0], { event_type: 'agent_work_package_created', agent: 'lead', wp_id: 'WP1' }].concat(pre.slice(1)));
  t('sequence FAIL: preconditions logged AFTER the first work event do not count', r.warnings.includes('seq') && det(r, 'seq').missing_before.length === 3, JSON.stringify(det(r, 'seq')));
}
{
  const r = run(SEQ, pre.slice(0, 3).concat([{ event_type: 'gate_evaluated', agent: 'orchestrator', ok: true, note: 'a full check' }, { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'x' }]));
  t('sequence edge: a gate_evaluated WITHOUT phase preview does not satisfy the {event, where} item', r.warnings.includes('seq') && /gate_evaluated/.test(det(r, 'seq').missing_before.join(' ')));
}
{
  const r = run(SEQ, [{ event_type: 'run_started', agent: 'orchestrator' }]);
  t('sequence edge: no after-event yet = nothing to order (vacuous)', r.satisfied.includes('seq') && det(r, 'seq').vacuous === true);
}
{
  const r = run(R('seq1', { type: 'sequence', before: 'wp_completed', after: 'wp_verified' }), [
    { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP1', command: 'x', output: 'ok' },
  ]);
  t('sequence edge: the single-string `before` form works (A must precede B)', r.warnings.includes('seq1'));
}

// ================================================================================================
console.log('\n3) reaction');
// ================================================================================================
const ESC = R('esc', { type: 'reaction', on: 'wp_verified', on_where: { verdict: ['fail', 'failed'] }, require: 'escalation', key: 'wp_id', count: 'exactly-one', forbid_unprompted: true });
const failEv = (wp) => ({ event_type: 'wp_verified', agent: 'Verify Boss', wp_id: wp, verdict: 'FAIL' });
const escEv = (wp) => ({ event_type: 'escalation', agent: 'Head Chef', wp_id: wp, from: 'build', to: 'deep', reason: 'capability' });
{
  const r = run(ESC, [failEv('WP1'), escEv('WP1'), { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' }]);
  t('reaction exactly-one PASS: one FAIL, one escalation, then a re-verify', r.satisfied.includes('esc'), JSON.stringify(det(r, 'esc')));
}
{
  const r = run(ESC, [failEv('WP1'), { event_type: 'wp_failed', agent: 'Head Chef', wp_id: 'WP1' }]);
  t('reaction exactly-one FAIL: a FAIL with no escalation', r.warnings.includes('esc') && /no escalation/.test(det(r, 'esc').reason));
}
{
  const r = run(ESC, [failEv('WP1'), escEv('WP1'), failEv('WP1'), escEv('WP1')]);
  t('reaction exactly-one FAIL: a second escalation for the same package breaks the GOAT one-retry cap', r.warnings.includes('esc') && /exactly one is allowed/.test(det(r, 'esc').reason), JSON.stringify(det(r, 'esc')));
}
{
  const r = run(ESC, [failEv('WP1'), escEv('WP1'), failEv('WP1'), { event_type: 'wp_failed', agent: 'Head Chef', wp_id: 'WP1' }]);
  t('reaction exactly-one PASS: second FAIL ends in wp_failed without a second escalation', r.satisfied.includes('esc'));
}
{
  const r = run(ESC, [escEv('WP1'), { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' }]);
  t('reaction forbid_unprompted FAIL: an escalation with no earlier FAIL (escalate chosen up front)', r.warnings.includes('esc') && /up front/.test(det(r, 'esc').reason));
}
{
  const r = run(ESC, [failEv('WP1'), escEv('WP2')]);
  t('reaction key: an escalation for ANOTHER package answers nothing (and is itself unprompted)', r.warnings.includes('esc') && det(r, 'esc').violations_count === 2, JSON.stringify(det(r, 'esc')));
}
{
  const r = run(ESC, [{ event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS' }]);
  t('reaction edge: no FAIL at all = vacuous', r.satisfied.includes('esc') && det(r, 'esc').vacuous === true);
}
const PAUSE = R('pause', { type: 'reaction', on: 'run_paused', require: 'run_resumed' });
{
  t('reaction at-least-one PASS: pause, pause, resume (one resume answers both)', run(PAUSE, [{ event_type: 'run_paused', reason: 'usage-limit' }, { event_type: 'run_paused', reason: 'usage-limit' }, { event_type: 'run_resumed' }]).satisfied.includes('pause'));
  t('reaction at-least-one FAIL: a pause with no later resume', run(PAUSE, [{ event_type: 'run_resumed' }, { event_type: 'run_paused', reason: 'usage-limit' }]).warnings.includes('pause'));
}
const GATE = R('gate', { type: 'reaction', on: 'gate_blocked', require: ['owner_override', 'decision_logged'], key: 'gate' });
{
  const blk = { event_type: 'gate_blocked', agent: 'orchestrator', gate: 'recursive-delete', command_digest: 'abc' };
  t('reaction PASS: a decision_logged for the same gate resolves the block', run(GATE, [blk, { event_type: 'decision_logged', agent: 'lead', gate: 'recursive-delete', decision: 'safe variant: move to backup instead' }]).satisfied.includes('gate'));
  t('reaction PASS: a valid owner_override for the same gate resolves the block', run(GATE, [blk, ownerOv({ rule: 'gate:recursive-delete', gate: 'recursive-delete' })]).satisfied.includes('gate'));
  t('reaction FAIL: an owner_override with a non-owner `by` resolves nothing', run(GATE, [blk, ownerOv({ rule: 'gate:recursive-delete', gate: 'recursive-delete', by: 'Build Boss' })]).warnings.includes('gate'));
  t('reaction FAIL: a decision for ANOTHER gate resolves nothing', run(GATE, [blk, { event_type: 'decision_logged', agent: 'lead', gate: 'push' }]).warnings.includes('gate'));
  t('reaction edge: a gate_blocked without `gate` cannot be paired (reported, never silently cleared)', run(GATE, [{ event_type: 'gate_blocked', agent: 'orchestrator' }, { event_type: 'decision_logged', agent: 'lead', gate: 'x' }]).warnings.includes('gate'));
}

// ================================================================================================
console.log('\n4) file-touched');
// ================================================================================================
{
  const FT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-v2-files-'));
  fs.mkdirSync(path.join(FT_ROOT, '.claude'), { recursive: true });
  const mem = path.join(FT_ROOT, '.claude', 'FORGE_MEMORY.md');
  const led = path.join(FT_ROOT, '.claude', 'FORGE_AGENT_LEDGER.md');
  fs.writeFileSync(mem, '# memory v1\n');
  fs.writeFileSync(led, '# ledger v1\n');
  const FILES = ['.claude/FORGE_MEMORY.md', '.claude/FORGE_AGENT_LEDGER.md'];
  const FT = R('ft', { type: 'file-touched', files: FILES, mode: 'all', alt_event: 'memory_updated' });
  const baseline = RC.snapshotFileHashes(FT_ROOT, FILES);
  t('snapshotFileHashes: one sha256 per file, keyed by its relative path', Object.keys(baseline).length === 2 && /^[0-9a-f]{64}$/.test(baseline['.claude/FORGE_MEMORY.md']));
  const runFT = (events) => {
    const id = 'ft-' + (++fxN);
    writeRun(FT_ROOT, id, events);
    return RC.check({ run_id: id }, { root: FT_ROOT, rulesPath: rulesFile([FT]), ownerProfilePath: NO_OWNER_PROFILE });
  };
  const started = { event_type: 'run_started', agent: 'orchestrator', file_hashes: baseline };
  const unchanged = runFT([started]);
  t('file-touched FAIL: both files unchanged since run_started', unchanged.warnings.includes('ft') && /unchanged/.test(det(unchanged, 'ft').reason), JSON.stringify(det(unchanged, 'ft')));
  fs.writeFileSync(mem, '# memory v2\n');
  const oneChanged = runFT([started]);
  t('file-touched FAIL (mode all): only one of the two changed', oneChanged.warnings.includes('ft'));
  const anyMode = (() => {
    const id = 'ft-' + (++fxN);
    writeRun(FT_ROOT, id, [started]);
    return RC.check({ run_id: id }, { root: FT_ROOT, rulesPath: rulesFile([R('ftany', { type: 'file-touched', files: FILES, mode: 'any' })]), ownerProfilePath: NO_OWNER_PROFILE });
  })();
  t('file-touched PASS (mode any): one changed file is enough', anyMode.satisfied.includes('ftany'));
  const claimOnly = runFT([started, { event_type: 'memory_updated', agent: 'Docs Boss', files_changed: ['.claude/FORGE_AGENT_LEDGER.md'] }]);
  t('file-touched edge: with a baseline the HASH decides — a memory_updated claim for an unchanged file does not count', claimOnly.warnings.includes('ft') && /unchanged-despite-event/.test(JSON.stringify(det(claimOnly, 'ft').files)));
  fs.writeFileSync(led, '# ledger v2\n');
  const both = runFT([started]);
  t('file-touched PASS: both files really changed since run_started', both.satisfied.includes('ft'), JSON.stringify(det(both, 'ft')));
  const noBase = runFT([{ event_type: 'run_started', agent: 'orchestrator' }]);
  t('file-touched FAIL: no baseline and no naming event = unverified, not shown as updated', noBase.warnings.includes('ft') && det(noBase, 'ft').baseline_recorded === false && det(noBase, 'ft').files.every((f) => f.status === 'unverified'), JSON.stringify(det(noBase, 'ft')));
  // without the writer-stamped baseline an event NAMING the file is a
  // claim, never proof — and only the exact project-relative path is even recognised as naming it.
  const named = runFT([{ event_type: 'run_started', agent: 'orchestrator' }, { event_type: 'memory_updated', agent: 'Docs Boss', files_changed: ['.claude/FORGE_MEMORY.md'], evidence: 'elsewhere/FORGE_AGENT_LEDGER.md' }]);
  t('F08 file-touched FAIL without baseline: a memory_updated naming the file is "named-by-event-unverified", never a pass', named.warnings.includes('ft') && det(named, 'ft').files.find((f) => f.file === '.claude/FORGE_MEMORY.md').status === 'named-by-event-unverified', JSON.stringify(det(named, 'ft')));
  t('F08 file-touched: a basename/suffix mention (elsewhere/FORGE_AGENT_LEDGER.md) does not even count as naming the file', det(named, 'ft').files.find((f) => f.file === '.claude/FORGE_AGENT_LEDGER.md').status === 'unverified', JSON.stringify(det(named, 'ft')));
  const callerBaseline = (() => {
    const id = 'ft-' + (++fxN);
    // a caller-chosen baseline field with hashes that would read as "changed" — never trusted: only the writer's file_hashes count
    writeRun(FT_ROOT, id, [{ event_type: 'run_started', agent: 'orchestrator', my_hashes: { '.claude/FORGE_MEMORY.md': 'f'.repeat(64), '.claude/FORGE_AGENT_LEDGER.md': 'f'.repeat(64) } }]);
    return RC.check({ run_id: id }, { root: FT_ROOT, rulesPath: rulesFile([R('ftcb', { type: 'file-touched', files: FILES, baseline_field: 'my_hashes' })]), ownerProfilePath: NO_OWNER_PROFILE });
  })();
  t('F08 file-touched: a caller-chosen baseline_field is ignored (reported) — hashes come only from the writer-stamped file_hashes', callerBaseline.warnings.includes('ftcb') && det(callerBaseline, 'ftcb').baseline_field === 'file_hashes' && det(callerBaseline, 'ftcb').baseline_field_ignored === 'my_hashes', JSON.stringify(det(callerBaseline, 'ftcb')));
  const created = (() => {
    const id = 'ft-' + (++fxN);
    writeRun(FT_ROOT, id, [{ event_type: 'run_started', agent: 'orchestrator', file_hashes: { '.claude/NEW.md': null } }]);
    fs.writeFileSync(path.join(FT_ROOT, '.claude', 'NEW.md'), 'created during the run');
    return RC.check({ run_id: id }, { root: FT_ROOT, rulesPath: rulesFile([R('ftnew', { type: 'file-touched', files: ['.claude/NEW.md'] })]), ownerProfilePath: NO_OWNER_PROFILE });
  })();
  t('file-touched edge: a file absent at run_started (baseline null) and created since counts as changed', created.satisfied.includes('ftnew'));
  let unsafe = null; try { RC.snapshotFileHashes(FT_ROOT, ['../outside.md']); } catch (e) { unsafe = e; }
  t('snapshotFileHashes refuses a path that leaves the project root', unsafe instanceof Error);
  t('isSafeRelPath: absolute, drive, UNC and dot-dot paths are refused; a plain relative path is accepted',
    !RC.isSafeRelPath('/etc/passwd') && !RC.isSafeRelPath('C:/x') && !RC.isSafeRelPath('\\\\srv\\x') && !RC.isSafeRelPath('a/../b') && !RC.isSafeRelPath('./a') && RC.isSafeRelPath('.claude/FORGE_MEMORY.md'));
  fs.rmSync(FT_ROOT, { recursive: true, force: true });
}

// ================================================================================================
console.log('\n5) since (historical_exempt) and phase (phase_deferred)');
// ================================================================================================
{
  const rules = [R('new-warn', { type: 'event-present', key: 'never_logged' }, { since: SINCE }), R('old-block', { type: 'event-present', key: 'signal_must' }, { severity: 'block' })];
  const before = run(rules, [{ event_type: 'run_started' }, { event_type: 'signal_must' }], { start: '2026-10-06T09:55:22Z' });
  t('since: a run that started BEFORE the rule existed is historical_exempt, never warned or missing', before.historical_exempt.some((x) => x.id === 'new-warn' && x.since === SINCE) && !before.warnings.includes('new-warn') && !before.satisfied.includes('new-warn'));
  t('since: the exempt run reports when it started and from what', before.run_started_at === '2026-10-06T09:55:22.000Z' && before.run_started_source === 'run_started');
  const after = run(rules, [{ event_type: 'run_started' }, { event_type: 'signal_must' }], { start: '2026-10-09T00:00:00Z' });
  t('since: a run starting ON the since date is judged (boundary inclusive)', after.warnings.includes('new-warn') && !after.historical_exempt.length);
  const noRs = run(rules, [{ event_type: 'agent_note', note: 'x' }, { event_type: 'signal_must' }], { start: '2026-10-20T00:00:00Z' });
  t('since: without run_started the first timestamped event dates the run', noRs.run_started_source === 'first_event' && noRs.warnings.includes('new-warn'));
  const undated = run(rules, [{ event_type: 'signal_must' }], { noTimestamps: true });
  t('since: an undatable run is exempt from a WARN rule (under-claim) and says why', undated.historical_exempt.some((x) => x.id === 'new-warn' && /unknown/.test(x.reason)) && undated.run_started_at === null);
  const blockSince = [R('new-block', { type: 'event-present', key: 'never_logged' }, { since: SINCE, severity: 'block' })];
  const undatedBlock = run(blockSince, [{ event_type: 'signal_must' }], { noTimestamps: true });
  t('since: an undatable run is still judged by a BLOCK rule (fail-closed)', undatedBlock.missing.includes('new-block') && !undatedBlock.historical_exempt.length);
  const oldBlock = run(blockSince, [{ event_type: 'run_started' }], { start: '2026-01-01T00:00:00Z' });
  t('since: a historical run is never red on a newer BLOCK rule either', oldBlock.ok === true && oldBlock.historical_exempt.length === 1);
  const futureType = run([R('future-x', { type: 'zz-future-thing' }, { since: SINCE, severity: 'block' })], [{ event_type: 'run_started' }], { start: '2026-01-01T00:00:00Z' });
  t('since + unknown type: a historical run gets no unknown-rule marker for a newer rule it never owed', futureType.ok === true && !futureType.unevaluated.length && futureType.historical_exempt.length === 1);
}
{
  const rules = [
    R('p-pre', { type: 'event-present', key: 'a' }, { phase: 'preview', severity: 'block' }),
    R('p-wp', { type: 'event-present', key: 'b' }, { phase: 'wp', severity: 'block' }),
    R('p-done', { type: 'event-present', key: 'c' }, { severity: 'block' }),
  ];
  const ev = [{ event_type: 'a' }];
  const preview = run(rules, ev, { params: { phase: 'preview' } });
  t('phase preview: only preview rules are judged; later ones are phase_deferred, not missing', preview.ok === true && preview.phase === 'preview' && preview.phase_deferred.join() === 'p-wp,p-done');
  const wp = run(rules, ev, { params: { phase: 'wp' } });
  t('phase wp: preview + wp rules are judged', wp.missing.join() === 'p-wp' && wp.phase_deferred.join() === 'p-done');
  const full = run(rules, ev);
  t('phase default: a phase-less check is "complete" and judges every rule (pre-V2 behaviour)', full.phase === 'complete' && full.missing.join() === 'p-wp,p-done' && !full.phase_deferred.length);
  let badPhase = null; try { run(rules, ev, { params: { phase: 'later' } }); } catch (e) { badPhase = e; }
  t('phase: an unknown phase in the CALL is a usage error', badPhase instanceof Error && /phase must be one of/.test(badPhase.message));
  const futurePhase = run([R('p-future', { type: 'event-present', key: 'z' }, { phase: 'post-release', severity: 'block' })], ev, { params: { phase: 'wp' } });
  t('phase: a well-formed but unknown RULE phase is judged like complete (deferred at wp, never a crash)', futurePhase.phase_deferred.includes('p-future'));
  t('phaseRankOf: preview < wp < complete; absent and unknown read as complete', RC.phaseRankOf('preview') === 0 && RC.phaseRankOf('wp') === 1 && RC.phaseRankOf(undefined) === 2 && RC.phaseRankOf('post-release') === 2);
}

// ================================================================================================
console.log('\n6) loader: malformed V2 shapes throw, unknown option values degrade');
// ================================================================================================
{
  const throws = (rule) => { try { RC.loadRules(rulesFile([rule])); return null; } catch (e) { return e; } };
  t('closure without key throws', throws(R('x', { type: 'closure', open: 'a', close: 'b' })) instanceof Error);
  t('closure with an invalid close_where throws', throws(R('x', { type: 'closure', open: 'a', close: 'b', key: 'k', close_where: { verdict: {} } })) instanceof Error);
  t('sequence without after throws', throws(R('x', { type: 'sequence', before: 'a' })) instanceof Error);
  t('sequence with an empty before list throws', throws(R('x', { type: 'sequence', before: [], after: 'b' })) instanceof Error);
  t('reaction without require throws', throws(R('x', { type: 'reaction', on: 'a' })) instanceof Error);
  t('reaction with a non-boolean forbid_unprompted throws', throws(R('x', { type: 'reaction', on: 'a', require: 'b', forbid_unprompted: 'yes' })) instanceof Error);
  t('file-touched with an absolute path throws', throws(R('x', { type: 'file-touched', files: ['C:/Windows/win.ini'] })) instanceof Error);
  t('file-touched with a dot-dot path throws', throws(R('x', { type: 'file-touched', files: ['../other-project/.claude/FORGE_MEMORY.md'] })) instanceof Error);
  t('an invalid since throws', throws(R('x', { type: 'event-present', key: 'a' }, { since: '9 October' })) instanceof Error);
  t('a non-string phase throws', throws(R('x', { type: 'event-present', key: 'a' }, { phase: 3 })) instanceof Error);
  t('a valid V2 rule loads', throws(R('x', { type: 'reaction', on: 'a', require: 'b', count: 'exactly-one' })) === null);
  const p = rulesFile([R('cap', { type: 'reaction', on: 'a', require: 'b', count: 'at-most-two' }, { severity: 'block' }), R('plain', { type: 'event-present', key: 'a' }, { severity: 'block' })]);
  const meta = RC.loadRulesMeta(p);
  t('an unknown option value (reaction count) degrades like an unknown type, with its reason', meta.unknownCheckTypes.some((u) => u.id === 'cap' && /unknown reaction count "at-most-two"/.test(u.reason)));
  const id = 'fx-opt-' + (++fxN);
  writeRun(TMP, id, [{ event_type: 'a' }]);
  const res = RC.check({ run_id: id }, { root: TMP, rulesPath: p });
  t('... and a BLOCKING one becomes unknown-rule:<id> with that reason, never a silent pass', res.ok === false && res.missing.includes('unknown-rule:cap') && /at-most-two/.test(res.rule_details['unknown-rule:cap'].reason) && res.unevaluated.some((u) => u.id === 'cap' && /option/.test(u.reason)));
}

// ================================================================================================
console.log('\n7) the production registry (version 2)');
// ================================================================================================
const NEW_IDS = ['preview-preconditions', 'wp-closure', 'subagent-closure', 'wp-verified-per-wp', 'escalation-one-per-fail', 'memory-files-touched', 'pause-resume', 'gate-blocked-resolved'];
const V1_IDS = ['memory-read', 'owner-prefs-loaded', 'research-done', 'plan-or-prd-present', 'prd-required-for-heavy-work', 'dispatch-logged', 'evidence-satisfied', 'verify-checked', 'independent-verification', 'report-present', 'web-responsive-evidence', 'correctness-critical-fixtures'];
{
  const meta = RC.loadRulesMeta(PROD_RULES);
  // 21 part ii added owner-requests-reconciled (event-present, warn)
  t('production rules load with this checker: 21 rules, nothing degraded', meta.data.rules.length === 21 && !meta.unknownCheckTypes.length && !meta.unknownTriggers.length);
  const orr = PROD.rules.find((r) => r.id === 'owner-requests-reconciled');
  t('WP-7b-ii: owner-requests-reconciled is an event-present warn rule since 2026-10-10, gated by applies_if_exists on the scribe ledger', !!orr && orr.check.type === 'event-present' && orr.severity === 'warn' && orr.since === '2026-10-10' && orr.phase === 'complete' && orr.applies_if_exists === '.claude/forge-scribe/ledger.jsonl');
  t('registry version is 2', PROD.version === 2);
  const byId = Object.fromEntries(PROD.rules.map((r) => [r.id, r]));
  t('every version-2 rule is present, severity warn, since ' + SINCE, NEW_IDS.every((id) => byId[id] && byId[id].severity === 'warn' && byId[id].since === SINCE), NEW_IDS.filter((id) => !byId[id] || byId[id].severity !== 'warn' || byId[id].since !== SINCE).join(','));
  t('the 12 version-1 rules keep severity block, no since, and their honesty-core flags', V1_IDS.every((id) => byId[id] && byId[id].severity === 'block' && byId[id].since === undefined)
    && ['memory-read', 'dispatch-logged', 'evidence-satisfied', 'verify-checked', 'independent-verification', 'report-present'].every((id) => byId[id].cannot_override === true));
  t('every rule carries a known phase', PROD.rules.every((r) => RC.KNOWN_PHASES.includes(r.phase)), PROD.rules.filter((r) => !RC.KNOWN_PHASES.includes(r.phase)).map((r) => r.id).join(','));
  t('the version-2 rules use exactly the four new check types', new Set(NEW_IDS.map((id) => byId[id].check.type)).size === 4 && NEW_IDS.every((id) => RC.V2_CHECK_TYPES.has(byId[id].check.type)));
  t('S9: the stale HONEST GAP about owner_override registration is gone', !/it is not yet\s+registered in log-event\.cjs's KNOWN_EVENT_TYPES/.test(PROD._doc) && /RESOLVED/.test(PROD._doc));
  t('fileTouchedTargets reads the memory/ledger/task-history files from the ONE registry', JSON.stringify(RC.fileTouchedTargets(PROD)) === JSON.stringify(['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md']));
  const LABELS = new Set(['prose', 'hook', 'contract']);
  t('every orchestration rule carries an enforcement label prose|hook|contract plus its note', Array.isArray(PROD.orchestration_hard_rules) && PROD.orchestration_hard_rules.length >= 3
    && PROD.orchestration_hard_rules.every((r) => LABELS.has(r.enforcement) && typeof r.enforcement_note === 'string' && r.enforcement_note.length > 40 && Array.isArray(r.enforced_by) && r.enforced_by.length > 0));
  t('an orchestration rule labelled hook names a hook in enforced_by (the label is backed, not asserted)', PROD.orchestration_hard_rules.filter((r) => r.enforcement === 'hook').every((r) => r.enforced_by.some((x) => /^hook/.test(x))));
  t('contract_rules on an orchestration rule point at real rule ids', PROD.orchestration_hard_rules.every((r) => (r.contract_rules || []).every((id) => byId[id])));
  const LC_NEEDED = ['run-started', 'work-package-created', 'subagent-dispatched', 'wp-completed', 'verifier-fail', 'usage-limit', 'owner-changes-requirement', 'session-resumed', 'sync-finished', 'hard-gate-hit', 'run-completed', 'memory-update', 'config-changed'];
  const lc = Array.isArray(PROD.lifecycle) ? PROD.lifecycle : [];
  t('lifecycle table covers every audit trigger (T1-T13)', LC_NEEDED.every((id) => lc.some((row) => row.id === id)), LC_NEEDED.filter((id) => !lc.some((row) => row.id === id)).join(','));
  t('each lifecycle row has event, required_reaction, missing_reaction_behaviour, enforced_by and rule_ids that exist', lc.every((row) => typeof row.event === 'string' && row.required_reaction && row.missing_reaction_behaviour
    && Array.isArray(row.enforced_by) && row.enforced_by.length > 0 && Array.isArray(row.rule_ids) && row.rule_ids.every((id) => byId[id])));
  const cs = Array.isArray(PROD.completion_sequence) ? PROD.completion_sequence : [];
  t('completion_sequence is the canonical order: gate-evidence, final-report, contract-check, run-completed, finalize, then the advisory handoff (WP-12b)', cs.map((s) => s.id).join() === 'gate-evidence,final-report,contract-check,run-completed,finalize,handoff' && cs.every((s, i) => s.step === i + 1));
  t('completion_sequence step 5 finalizes AFTER step 4 logs run_completed (the order finalize enforces)', /--finalize/.test(cs[4].command) && /run_completed/.test(cs[3].command) && !/--finalize/.test(cs[2].command));
  t('WP-12b: step 1 runs a test gate through the forge-testrun wrapper (summary + failing names + log path only)', /forge-gate-evidence\.cjs --run <run_id> --gate "<name>::node \.claude\/forge-bin\/forge-testrun\.cjs -- <test command>"/.test(cs[0].command), cs[0].command);
  t('WP-12b: step 6 handoff is ADVISORY data — severity warn, blocks:false, after finalize, names the handoff command and /clear', !!cs[5] && cs[5].severity === 'warn' && cs[5].blocks === false && /forge-runcontract\.cjs handoff --run <run_id>/.test(cs[5].command) && /\/clear/.test(cs[5].action));
  t('WP-12b: the five completion steps before it carry no severity (each is judged)', cs.slice(0, 5).every((s) => s.severity === undefined && s.blocks === undefined));
  t('WP-12b: the built-in default mirrors the registry\'s five completion steps (id and command)', RC.DEFAULT_COMPLETION_SEQUENCE.length === 5 && RC.DEFAULT_COMPLETION_SEQUENCE.every((s, i) => s.id === cs[i].id && (s.command || null) === (cs[i].command || null)));
  t('WP-12b: the lifecycle table has the mission-phase-end row (handoff) and an up-to-date session-resumed row', lc.some((row) => row.id === 'mission-phase-end' && /handoff/.test(row.required_reaction)) && lc.some((row) => row.id === 'session-resumed' && /once per compaction/.test(row.required_reaction)));
  const ids = new Set();
  t('rule ids are unique across the registry', PROD.rules.every((r) => !ids.has(r.id) && ids.add(r.id)));
}
{
  // the production rules against a fixture run with 10 work packages and 0 wp_completed -> a warning
  const id = 'prod-10wp';
  const wps = Array.from({ length: 10 }, (_, i) => ({ event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP' + (i + 1), title: 'package ' + (i + 1) }));
  writeRun(TMP, id, [
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'memory_loaded', agent: 'orchestrator' },
    { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
  ].concat(wps), { start: '2026-10-10T08:00:00Z', files: { 'final-report.md': '# r\n' } });
  const r = RC.check({ run_id: id }, { root: TMP });
  t('PRODUCTION rules: 10 work packages and 0 wp_completed -> wp-closure WARNING', r.warnings.includes('wp-closure') && !r.missing.includes('wp-closure'), JSON.stringify({ warnings: r.warnings, missing: r.missing }));
  t('... the detail lists all 10 as unclosed', (r.rule_details['wp-closure'] || {}).unclosed_count === 10 && (r.rule_details['wp-closure'] || {}).opened === 10);
  t('... and the warning never appears in missing (warn stays warn)', !r.missing.some((m) => NEW_IDS.includes(m)));
  t('... a run started after ' + SINCE + ' is judged by every version-2 rule (none exempt)', r.historical_exempt.length === 0 && r.run_started_at === '2026-10-10T08:00:00.000Z');
  const old = 'prod-old';
  writeRun(TMP, old, [{ event_type: 'run_started', agent: 'orchestrator' }].concat(wps), { start: '2026-10-06T09:55:22Z' });
  const ro = RC.check({ run_id: old }, { root: TMP });
  t('PRODUCTION rules: the same run started 2026-10-06 is historical_exempt for all 8 version-2 rules', NEW_IDS.every((nid) => ro.historical_exempt.some((x) => x.id === nid)) && !ro.warnings.some((w) => NEW_IDS.includes(w)), JSON.stringify(ro.historical_exempt.map((x) => x.id)));
  const pv = RC.check({ run_id: id, phase: 'preview' }, { root: TMP });
  t('PRODUCTION rules, phase preview: only preview rules are judged', pv.phase === 'preview' && pv.satisfied.concat(pv.missing, pv.warnings).every((rid) => (PROD.rules.find((x) => x.id === rid) || {}).phase === 'preview') && pv.phase_deferred.includes('wp-closure'));
  t('PRODUCTION rules, phase preview: missing preconditions before the first package are a preview warning', pv.warnings.includes('preview-preconditions') && /gate_evaluated/.test((pv.rule_details['preview-preconditions'] || {}).reason || ''));
}

// ================================================================================================
console.log('\n8) one checklist: registry steps mirror run-checklist.json, forge-orchestrate reads the registry');
// ================================================================================================
{
  const cl = JSON.parse(fs.readFileSync(CHECKLIST, 'utf8'));
  const SHARED = ['id', 'label', 'required', 'produces_event', 'match'];
  const pick = (s) => JSON.stringify(SHARED.reduce((o, k) => (s[k] === undefined ? o : Object.assign(o, { [k]: s[k] })), {}));
  t('registry steps == run-checklist.json steps on every shared field, same order (no drift)', Array.isArray(PROD.steps) && PROD.steps.length === cl.steps.length && PROD.steps.every((s, i) => pick(s) === pick(cl.steps[i])),
    (PROD.steps || []).map((s, i) => pick(s) === pick(cl.steps[i]) ? null : s.id).filter(Boolean).join(','));
  const byId = Object.fromEntries(PROD.rules.map((r) => [r.id, r]));
  t('every step has a known phase and contract_rules that exist', PROD.steps.every((s) => RC.KNOWN_PHASES.includes(s.phase) && Array.isArray(s.contract_rules) && s.contract_rules.every((id) => byId[id])));
  const ORCH = require('./forge-orchestrate.cjs');
  const viaRegistry = ORCH.plan({ checklistPath: PROD_RULES }).map((s) => s.id);
  t('forge-orchestrate.plan() reads the registry through its checklistPath seam, unchanged', viaRegistry.join() === cl.steps.map((s) => s.id).join());
  const audit = ORCH.audit({ events: [{ event_type: 'memory_loaded' }, { event_type: 'owner_prefs_loaded' }] }, { checklistPath: PROD_RULES });
  const auditOld = ORCH.audit({ events: [{ event_type: 'memory_loaded' }, { event_type: 'owner_prefs_loaded' }] }, { checklistPath: CHECKLIST });
  t('forge-orchestrate.audit() gives the same verdict on the registry as on run-checklist.json', JSON.stringify(audit) === JSON.stringify(auditOld), JSON.stringify(audit).slice(0, 300));
}

// ================================================================================================
console.log('\n9) every event type the registry names is registered with the writer (or listed as pending)');
// ================================================================================================
// Names a rule may reference before the writer registers them (the strict writer refuses them until then, so a
// rule waiting for one stays open or vacuous). EMPTY part B registered the nine
// version-2 names in log-event.cjs KNOWN_EVENT_TYPES and the forge-verify.cjs mirror; a future rule that names a
// not-yet-registered type adds it here, and the test below prints a notice once it is registered.
const PENDING_REGISTRATION = new Set([]);
const V2_REGISTERED = ['wp_verified', 'escalation', 'run_paused', 'run_resumed', 'gate_blocked', 'route_assigned', 'session_resumed', 'sync_completed', 'owner_requirement_noted'];
{
  const src = fs.readFileSync(WRITER, 'utf8');
  const m = src.match(/const KNOWN_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  const known = new Set(m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : []);
  t('the writer registry could be read', known.size > 100, 'size ' + known.size);
  const named = new Set();
  const add = (spec) => { for (const x of [].concat(spec == null ? [] : spec)) { if (typeof x === 'string') named.add(x.toLowerCase()); else if (Array.isArray(x)) add(x); else if (x && typeof x === 'object' && x.event) add(x.event); } };
  for (const r of PROD.rules) {
    const c = r.check;
    if (c.type === 'event-present') add(c.key);
    add(c.open); add(c.close); add(c.before); add(c.after); add(c.on); add(c.require); add(c.alt_event); add(c.worker_exclude);
  }
  for (const row of PROD.lifecycle) add(row.event);
  for (const s of PROD.steps) add(s.produces_event);
  named.add('owner_override'); // the override convention itself
  const unregistered = [...named].filter((x) => !known.has(x) && !PENDING_REGISTRATION.has(x));
  t('every event type named by a rule, a lifecycle row or a step is registered or pending', unregistered.length === 0, 'unregistered and not pending: ' + unregistered.join(', '));
  const nowRegistered = [...PENDING_REGISTRATION].filter((x) => known.has(x));
  if (nowRegistered.length) console.log('  note: now registered, remove from PENDING_REGISTRATION: ' + nowRegistered.join(', '));
  t('every pending name is really named by the registry (no stale list)', [...PENDING_REGISTRATION].every((x) => named.has(x)), [...PENDING_REGISTRATION].filter((x) => !named.has(x)).join(','));
  t('WP-4 part B: the nine version-2 names are registered with the writer AND named by the registry', V2_REGISTERED.every((x) => known.has(x) && named.has(x)), V2_REGISTERED.filter((x) => !known.has(x) || !named.has(x)).join(','));
}

// ================================================================================================
console.log('\n10) CLI: --phase, gate_evaluated carries the phase, --finalize refuses a phased check');
// ================================================================================================
{
  const CLI_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-v2-cli-'));
  fs.mkdirSync(path.join(CLI_ROOT, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.mkdirSync(path.join(CLI_ROOT, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(PROD_RULES, path.join(CLI_ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const CAPTURE = path.join(CLI_ROOT, 'captured.jsonl');
  fs.writeFileSync(path.join(CLI_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), "require('fs').appendFileSync(" + JSON.stringify(CAPTURE) + ", process.argv[2] + '\\n');\n", 'utf8');
  writeRun(CLI_ROOT, 'cli-run', [
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'memory_loaded', agent: 'orchestrator' },
    { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
    { event_type: 'research_done', agent: 'orchestrator' },
  ], { start: '2026-10-10T08:00:00Z' });
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-runcontract.cjs'), ...args], { encoding: 'utf8' });
  const pv = cli('check', '--run', 'cli-run', '--root', CLI_ROOT, '--phase', 'preview', '--log-event');
  t('CLI --phase preview: the preview rules are met -> exit 0', pv.status === 0, pv.stdout + pv.stderr);
  t('CLI --phase preview: the text output names the phase and the rules not yet due', /phase preview/.test(pv.stdout) && /not yet due/.test(pv.stdout));
  let logged = null; try { logged = JSON.parse(fs.readFileSync(CAPTURE, 'utf8').trim().split('\n').pop()); } catch { logged = null; }
  t('CLI --phase preview --log-event: gate_evaluated carries phase:"preview" and says so in its note', !!logged && logged.phase === 'preview' && /\[phase preview\] PASSED/.test(logged.note), JSON.stringify(logged));
  const full = cli('check', '--run', 'cli-run', '--root', CLI_ROOT, '--json');
  let fj = null; try { fj = JSON.parse(full.stdout); } catch { fj = null; }
  t('CLI full check: still NOT DONE (later-phase block rules) and reports the V2 fields', full.status === 3 && !!fj && fj.phase === 'complete' && Array.isArray(fj.historical_exempt) && fj.ruleset_version_used === 2);
  const fin = cli('check', '--run', 'cli-run', '--root', CLI_ROOT, '--phase', 'wp', '--finalize');
  t('CLI --finalize with a partial phase is refused as a usage error (exit 2)', fin.status === 2 && /--finalize needs the complete contract/.test(fin.stderr), fin.stdout + fin.stderr);
  const warnText = cli('check', '--run', 'cli-run', '--root', CLI_ROOT);
  // no memory files and no baseline in this root -> memory-files-touched is the one live warning
  t('CLI text: a warning prints its reason, not only its id', /⚠ warn: memory-files-touched\s*\n\s*↳ .*unverified/.test(warnText.stdout), warnText.stdout.slice(0, 600));
  fs.rmSync(CLI_ROOT, { recursive: true, force: true });
}

// ================================================================================================
console.log('\n11) WP-12b: advisory steps after finalize, plan lists them, `handoff` writes the snapshot + digest');
// ================================================================================================
{
  // advisory split: the five completion steps stay the judged sequence; the handoff is listed separately
  const split = RC.completionSequenceOf(PROD);
  t('completionSequenceOf(production): steps = the five completion steps, advisory = [handoff]', split.source === 'registry' && split.steps.map((s) => s.id).join() === 'gate-evidence,final-report,contract-check,run-completed,finalize' && split.advisory.map((s) => s.id).join() === 'handoff');
  const weakened = JSON.parse(JSON.stringify(PROD));
  weakened.completion_sequence[0].severity = 'warn';
  weakened.completion_sequence[0].blocks = false;
  t('a severity:warn flag on a step BEFORE finalize is ignored — the step stays judged (data cannot weaken the gate)', RC.completionSequenceOf(weakened).steps.some((s) => s.id === 'gate-evidence') && !RC.completionSequenceOf(weakened).advisory.some((s) => s.id === 'gate-evidence'));
  const noFinalize = { completion_sequence: [{ step: 1, id: 'gate-evidence' }, { step: 2, id: 'extra', severity: 'warn', blocks: false }] };
  t('without a finalize step nothing is advisory (every step stays judged)', RC.completionSequenceOf(noFinalize).advisory.length === 0 && RC.completionSequenceOf(noFinalize).steps.length === 2);
  t('an older registry (no completion_sequence) -> the built-in five steps and no advisory step', RC.completionSequenceOf({ rules: [] }).steps.length === 5 && RC.completionSequenceOf({ rules: [] }).advisory.length === 0);

  // a run with four work packages: closed, + open, one without a wp_id
  const HROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-v2-handoff-'));
  const CFG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-v2-cfghome-'));
  const savedCfgHome = process.env.FORGE_CONFIG_HOME;
  process.env.FORGE_CONFIG_HOME = CFG_HOME; // the real forge-config reads a throwaway global settings file, never ~/.claude
  fs.mkdirSync(path.join(HROOT, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(PROD_RULES, path.join(HROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const hrun = (id, wps) => writeRun(HROOT, id, [
    { event_type: 'run_started', agent: 'orchestrator', task: 'handoff fixture' },
  ].concat(wps), { start: '2026-10-10T08:00:00Z' });
  hrun('h-two', [
    { event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP-A' },
    { event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP-B' },
    { event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP-C' },
    { event_type: 'agent_work_package_created', agent: 'Head Chef', title: 'no wp_id' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-A', command: 'x', output: 'ok' },
  ]);
  const evPath = path.join(HROOT, '.claude', 'forge-runs', 'h-two', 'events.jsonl');
  const evBefore = fs.readFileSync(evPath);
  const h = RC.handoffFor({ run_id: 'h-two' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE });
  t('handoff: the snapshot is written into the project (.claude/FORGE_SNAPSHOT.md)', h.snapshot.written === true && h.snapshot.path === '.claude/FORGE_SNAPSHOT.md' && fs.existsSync(path.join(HROOT, '.claude', 'FORGE_SNAPSHOT.md')), JSON.stringify(h.snapshot));
  t('handoff: open mission phases = the work packages without wp_completed/wp_failed (wp-closure), unkeyed ones named as such', h.open_phases.count === 3 && h.open_phases.ids.includes('WP-B') && h.open_phases.ids.includes('WP-C') && h.open_phases.unkeyed === 1, JSON.stringify(h.open_phases));
  t('handoff: more than one open phase -> advice to start the next phase in a fresh session (/clear)', /fresh session \(\/clear\)/.test(h.advice) && /still open/.test(h.advice), h.advice);
  t('handoff: the scribe is reported as not in use here (no ledger)', h.scribe.in_use === false);
  t('handoff: NOTHING is appended to the run (an event after run_completed would re-open it) — the log bytes are unchanged', Buffer.compare(evBefore, fs.readFileSync(evPath)) === 0 && h.event_logged === false);
  const txt = RC.formatHandoff(h);
  t('handoff text: names the snapshot path, the open phases and the advice, in at most 30 lines', /snapshot: \.claude\/FORGE_SNAPSHOT\.md/.test(txt) && /open mission phases: 3/.test(txt) && /Next: /.test(txt) && txt.split('\n').length <= 30, txt);

  hrun('h-one', [
    { event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP-A' },
    { event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP-B' },
    { event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'WP-A' },
  ]);
  const h1 = RC.handoffFor({ run_id: 'h-one' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE });
  t('handoff: exactly one open phase -> it may be finished in this session (no forced /clear)', h1.open_phases.count === 1 && /may be finished in this session/.test(h1.advice), h1.advice);
  hrun('h-none', [
    { event_type: 'agent_work_package_created', agent: 'Head Chef', wp_id: 'WP-A' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-A', command: 'x', output: 'ok' },
  ]);
  const h0 = RC.handoffFor({ run_id: 'h-none' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE });
  t('handoff: no open phase -> one session per mission: the next mission starts after /clear', h0.open_phases.count === 0 && /one session per mission/.test(h0.advice), h0.advice);

  // owner setting snapshots=off is honoured; a failing writer is reported (and the CLI exits 1)
  const off = RC.handoffFor({ run_id: 'h-none' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE, configModule: { safeGet: () => ({ value: false }) } });
  t('handoff: owner config snapshots=off -> the snapshot is skipped and says so', off.snapshot.written === false && off.snapshot.skipped === true && /snapshots=off/.test(off.snapshot.reason));
  const boom = RC.handoffFor({ run_id: 'h-none' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE, snapshotModule: { write() { throw new Error('disk full'); } } });
  t('handoff: a failing snapshot writer is reported as failed, never as written', boom.snapshot.written === false && boom.snapshot.failed === true && /disk full/.test(boom.snapshot.reason));

  // the scribe in use: the digest is refreshed and printed
  const S = require('./forge-scribe.cjs');
  S.capture('please also keep the old export button', { root: HROOT, source: 'cli', by: 'lead' });
  const hs = RC.handoffFor({ run_id: 'h-none' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE });
  t('handoff: with the scribe in use, the digest is refreshed and its text is in the result', hs.scribe.in_use === true && hs.scribe.refreshed === true && hs.scribe.path === '.claude/forge-scribe/DIGEST.md' && /Scribe: 1 active/.test(hs.scribe.text || '') && fs.existsSync(path.join(HROOT, '.claude', 'forge-scribe', 'DIGEST.md')), JSON.stringify(hs.scribe).slice(0, 300));
  t('handoff: an open owner request is named in the advice', /1 open owner request/.test(hs.advice), hs.advice);

  // CLI
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-runcontract.cjs'), ...args], { encoding: 'utf8' });
  const c1 = cli('handoff', '--run', 'h-two', '--root', HROOT);
  t('CLI handoff: exit 0, prints the snapshot path, the open phases and the /clear advice', c1.status === 0 && /snapshot: \.claude\/FORGE_SNAPSHOT\.md/.test(c1.stdout) && /open mission phases: 3/.test(c1.stdout) && /\/clear/.test(c1.stdout), c1.stdout + c1.stderr);
  const cj = cli('handoff', '--run', 'h-two', '--root', HROOT, '--json');
  let hj = null; try { hj = JSON.parse(cj.stdout); } catch { hj = null; }
  t('CLI handoff --json: one parseable object', cj.status === 0 && !!hj && hj.run_id === 'h-two' && hj.open_phases.count === 3, cj.stdout.slice(0, 300));
  t('CLI handoff without --run / on an unknown run: exit 2', cli('handoff').status === 2 && cli('handoff', '--run', 'no-such-run', '--root', HROOT).status === 2);

  // plan lists the advisory step after the five judged ones; it never becomes a pending/red obligation
  const plan = RC.planFor({ run_id: 'h-two' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE });
  t('plan: the judged sequence keeps exactly the five completion steps', plan.sequence.length === 5 && !plan.sequence.some((s) => s.id === 'handoff'));
  t('plan: the handoff is listed as advisory (status advisory, not due before finalize, never pending/red)', Array.isArray(plan.advisory) && plan.advisory.length === 1 && plan.advisory[0].id === 'handoff' && plan.advisory[0].status === 'advisory' && plan.advisory[0].due === false && /handoff --run h-two/.test(plan.advisory[0].command), JSON.stringify(plan.advisory));
  const ptxt = RC.formatPlan(plan);
  t('plan text: an "After completion (advisory, never blocks)" block names the handoff, within the line cap', /After completion \(advisory, never blocks\):/.test(ptxt) && /6 \[advisory\] handoff/.test(ptxt) && ptxt.split('\n').length <= RC.PLAN_MAX_LINES, ptxt);
  const gate = RC.completionGate({ run_id: 'h-two' }, { root: HROOT, ownerProfilePath: NO_OWNER_PROFILE });
  t('completionGate: the advisory handoff is never part of the steps judged before run_completed', !gate.steps.some((s) => s.id === 'handoff'));

  if (savedCfgHome === undefined) delete process.env.FORGE_CONFIG_HOME; else process.env.FORGE_CONFIG_HOME = savedCfgHome;
  fs.rmSync(HROOT, { recursive: true, force: true });
  fs.rmSync(CFG_HOME, { recursive: true, force: true });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
