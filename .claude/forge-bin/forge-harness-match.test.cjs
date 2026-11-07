#!/usr/bin/env node
'use strict';
/**
 * forge-harness-match.test.cjs — WP A2: forge-harness-match.cjs, the run-contract rule dispatch-harness-match
 * and the log-event.cjs write-time stamp. Hermetic: one os.mkdtemp folder (removed at the end) holds every project root
 * AND the Claude home (CLAUDE_CONFIG_DIR) the journal / agent-meta auto-discovery reads; the real project is only read
 * (production FORGE_HARD_RULES.json, agent-registry.json, the shipped log-event.cjs).
 *   A. matcher: every correlation path (agent-tool, agent id, Workflow lane, named workflow + --journal, agent meta), every
 *      verdict (matched / unmatched / unverifiable + kind), dedupe, internal skipped, orphans
 *   B. (a) THE FAKE-DISPATCH PROOF: a subagent_started whose dispatch_id has no harness record is unmatched once the harness
 *      recorded the run — and section E shows the pre-A2 writer accepted the same event silently
 *   C. CLI exit codes and --json
 *   D. (d) the contract: the production rule is a WARN on an L2 fixture run with a fake dispatch, satisfied when all match,
 *      not applicable on L1, exempt before 2026-11-01, owner_override, fail-closed without the matcher, mutants
 *   E. log-event.cjs: old path (no matcher next to the writer) accepts the fake silently; new path still writes it (strict
 *      mode) but stamps dispatch_unverified + reason + a warning; a real dispatch is not stamped; no dispatch_id is still
 *      refused; a run the harness never recorded is not stamped. Env FORGE_A2_LOG_EVENT_SRC swaps in another writer source
 *      (used once to show section E is RED on the pre-A2 writer).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const CLAUDE_SRC = path.join(BIN, '..');
const REAL_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const REAL_REGISTRY = path.join(CLAUDE_SRC, 'config', 'agents', 'agent-registry.json');
const LOG_EVENT_SRC = process.env.FORGE_A2_LOG_EVENT_SRC || path.join(CLAUDE_SRC, 'forge-dashboard', 'log-event.cjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hm-')));
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS', 'FORGE_HARNESS_FIND_JOURNALS', 'FORGE_HARNESS_STAMP', 'FORGE_RUN_ID']) delete process.env[k];
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude-home');
process.env.FORGE_CONFIG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });

const HM = require('./forge-harness-match.cjs');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const PROD = JSON.parse(fs.readFileSync(REAL_RULES, 'utf8'));
const RULE = 'dispatch-harness-match';
let rootN = 0;
function mkRoot(opts) {
  opts = opts || {};
  const root = mk(TMP, 'p' + (++rootN));
  mk(root, '.claude', 'config', 'orchestration');
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), opts.rules ? JSON.stringify(opts.rules, null, 2) : fs.readFileSync(REAL_RULES));
  mk(root, '.claude', 'forge-runs', '_hooks');
  return root;
}
const TS = '2026-11-01T10:00:00.000Z';
function writeRun(root, id, events, opts) {
  opts = opts || {};
  const dir = mk(root, '.claude', 'forge-runs', id);
  const all = [{ event_type: 'run_started', agent: 'orchestrator', timestamp: opts.ts || TS }].concat(events);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ complexity: opts.level || 'L2' }));
  return dir;
}
function hooks(root, file, lines) {
  fs.appendFileSync(path.join(root, '.claude', 'forge-runs', '_hooks', file), lines.map((l) => JSON.stringify(Object.assign({ ts: TS, session: 'sess-1' }, l))).join('\n') + '\n');
}
const sessDir = (root, sess) => mk(process.env.CLAUDE_CONFIG_DIR, 'projects', HM.projectSlug(root), sess);
/** journal(root, sess, wf, lanes) -> the journal path; lanes: [{id, label, meta?}] (meta = the harness agentType). */
function journal(root, sess, wf, lanes, dirOverride) {
  const dir = dirOverride || mk(sessDir(root, sess), 'subagents', 'workflows', wf);
  const lines = [{ type: 'launched' }].concat(lanes.map((l) => ({ type: 'started', key: 'v2:' + l.id, agentId: l.id, label: l.label, phase: 'Build' })));
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const l of lanes) if (l.meta) fs.writeFileSync(path.join(dir, 'agent-' + l.id + '.meta.json'), JSON.stringify({ agentType: l.meta, isBuiltIn: false }));
  return path.join(dir, 'journal.jsonl');
}
const sub = (agent, dispatch_id, extra) => Object.assign({ event_type: 'subagent_started', agent, runtime: 'agent-tool', timestamp: TS }, dispatch_id === undefined ? {} : { dispatch_id }, extra || {});
const byId = (rep, id) => rep.items.find((i) => i.dispatch_id === id);
const chk = (root, id) => RC.check({ run_id: id }, { root, ownerProfilePath: NO_PROFILE });

try {
  // ================================================================================================
  console.log('\nA) matcher: correlation paths and verdicts');
  // ================================================================================================
  const A = mkRoot();
  const R = 'run-a1';
  hooks(A, 'agent-tool.jsonl', [
    { event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000001', subagent_type: 'build-boss', run: R },
    { event: 'PostToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000001', agent_id: 'a1111111111111111', agent_id_key: 'agentId', run: R },
    { event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_MISMATCH0001', subagent_type: 'general-purpose', run: R },
    { event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_ORPHAN000001', subagent_type: 'docs-boss', run: R },
  ]);
  hooks(A, 'subagent-stop.jsonl', [
    { event: 'SubagentStop', agent_id: 'a1111111111111111', agent_type: 'build-boss', run: R },
    { event: 'SubagentStop', agent_id: 'a2222222222222222', agent_type: 'test-boss', run: R },
    { event: 'SubagentStop', agent_id: 'a3333333333333333', agent_type: 'build-boss', run: 'run-other' },
    { event: 'SubagentStop', agent_id: 'a4444444444444444', agent_type: null, agent_type_shape: 'absent', run: R },
  ]);
  journal(A, 'sess-1', 'wf_abc123-def', [
    { id: 'a5555555555555555', label: 'verify-boss · A5 rework', meta: 'verify-boss' },
    { id: 'a6666666666666666', label: 'build-boss · A10', meta: 'build-boss' },
    { id: 'a7777777777777777', label: 'head-chef · classify', meta: 'head-chef' },
  ]);
  const named = journal(A, 'sess-1', 'wf_named00-001', [{ id: 'a8888888888888888', label: 'search-boss · B2', meta: 'search-boss' }]);
  const meta = mk(sessDir(A, 'sess-2'), 'subagents');
  fs.writeFileSync(path.join(meta, 'agent-a9999999999999999.meta.json'), JSON.stringify({ agentType: 'seo-boss' }));
  writeRun(A, R, [
    sub('Build Boss', 'toolu_REAL00000001'),
    Object.assign(sub('Build Boss', 'toolu_REAL00000001'), { event_type: 'agent_started' }),
    sub('Test Boss', 'a2222222222222222'),
    sub('Verify Boss', 'wf_abc123-def:A5', { runtime: 'workflow' }),
    sub('Build Boss', 'wf_abc123-def:A1', { runtime: 'workflow' }),
    sub('Review Boss', 'toolu_MISMATCH0001'),
    sub('codex-reviewer', 'codex-job-1', { runtime: 'codex' }),
    sub('Build Boss', undefined, { runtime: 'internal' }),
    sub('Docs Boss', 'pending'),
    sub('Docs Boss', undefined),
    sub('Search Boss', 'workflow:my-flow:B2', { runtime: 'workflow' }),
    sub('Build Boss', 'a3333333333333333'),
    sub('Integration Boss', 'a4444444444444444'),
    sub('SEO Boss', 'a9999999999999999'),
    sub('lead', 'wf_abc123-def:classify', { runtime: 'workflow' }),
  ]);
  let rep = HM.matchRun({ root: A, runId: R, final: true });
  t('A1 Agent-tool dispatch: PreToolUse + PostToolUse records, type agrees -> matched (agent id from the response)', byId(rep, 'toolu_REAL00000001').status === 'matched' && byId(rep, 'toolu_REAL00000001').agent_id === 'a1111111111111111' && byId(rep, 'toolu_REAL00000001').sources.includes('agent-tool:pre'), JSON.stringify(byId(rep, 'toolu_REAL00000001')));
  t('A2 agent_started + subagent_started for one dispatch count once', rep.items.filter((i) => i.dispatch_id === 'toolu_REAL00000001').length === 1 && byId(rep, 'toolu_REAL00000001').event_types.length === 2);
  t('A3 agent-id dispatch backed by a SubagentStop record -> matched', byId(rep, 'a2222222222222222').status === 'matched' && byId(rep, 'a2222222222222222').type_check === 'agree');
  const w5 = byId(rep, 'wf_abc123-def:A5');
  t('A4 Workflow lane: journal + agent meta, "A5" matches the rework lane "A5 rework" (first word)', w5.status === 'matched' && w5.lane_match === 'first-word' && w5.sources.includes('agent-meta'), JSON.stringify(w5));
  t('A5 lane "A1" never matches "A10" -> unmatched (lane not in the journal)', byId(rep, 'wf_abc123-def:A1').status === 'unmatched' && /not in the journal/.test(byId(rep, 'wf_abc123-def:A1').reason));
  const mm = byId(rep, 'toolu_MISMATCH0001');
  t('A6 harness says general-purpose, the event claims Review Boss -> unmatched, type_check mismatch', mm.status === 'unmatched' && mm.type_check === 'mismatch' && mm.harness_type === 'general-purpose', JSON.stringify(mm));
  t('A7 runtime codex -> unverifiable(external-cli), left out of the percentage', byId(rep, 'codex-job-1').unverifiable_kind === 'external-cli');
  t('A8 runtime internal is not a dispatch (skipped_internal 1)', rep.summary.skipped_internal === 1);
  t('A9 a free-text dispatch_id ("pending") -> unmatched (no correlatable shape)', byId(rep, 'pending').status === 'unmatched' && byId(rep, 'pending').kind === 'unknown');
  t('A10 no dispatch_id -> unmatched', rep.items.some((i) => i.dispatch_id === null && i.status === 'unmatched' && i.kind === 'none'));
  t('A11 workflow:<name>:<lane> without --journal -> unverifiable(journal-missing)', byId(rep, 'workflow:my-flow:B2').unverifiable_kind === 'journal-missing');
  t('A12 a harness record stamped with ANOTHER run -> unmatched', byId(rep, 'a3333333333333333').status === 'unmatched' && /belongs to run run-other/.test(byId(rep, 'a3333333333333333').reason));
  t('A13 a record without an agent type -> unverifiable(type-absent)', byId(rep, 'a4444444444444444').unverifiable_kind === 'type-absent');
  t('A14 agent-id without a hook line: the harness agent-<id>.meta.json in the session folder proves it', byId(rep, 'a9999999999999999').status === 'matched' && byId(rep, 'a9999999999999999').sources[0] === 'agent-meta');
  t('A15 a generic actor (lead) claims no type -> matched, type_check not-claimed', byId(rep, 'wf_abc123-def:classify').type_check === 'not-claimed' && byId(rep, 'wf_abc123-def:classify').harness_type === 'head-chef');
  t('A16 an Agent call of this run that no event names is reported as an orphan', rep.orphans.some((o) => o.tool_use_id === 'toolu_ORPHAN000001'), JSON.stringify(rep.orphans));
  const s = rep.summary;
  t('A17 summary: 13 dispatches, 5 matched, 5 unmatched, 3 unverifiable; external left out; match_pct = 5/12', s.dispatches === 13 && s.matched === 5 && s.unmatched === 5 && s.unverifiable === 3 && s.provable === 12 && s.match_pct === 41.7, JSON.stringify(s));
  rep = HM.matchRun({ root: A, runId: R, final: true, journals: [named] });
  t('A18 --journal makes the named workflow lane provable', byId(rep, 'workflow:my-flow:B2').status === 'matched' && rep.harness.journals.some((j) => j.source === 'explicit'));
  rep = HM.matchRun({ root: A, runId: R, final: true, findJournals: false });
  t('A19 --no-find-journals: wf lanes become journal-missing and the meta fallback is off', byId(rep, 'wf_abc123-def:A5').unverifiable_kind === 'journal-missing' && byId(rep, 'a9999999999999999').status !== 'matched');

  // liveness: absent vs live, pending vs final
  const L = mkRoot();
  writeRun(L, 'run-l1', [sub('Build Boss', 'toolu_LIVE00000001'), sub('Test Boss', 'abbbbbbbbbbbbbbbb')]);
  rep = HM.matchRun({ root: L, runId: 'run-l1', final: true, findJournals: false });
  t('A20 the harness recorded nothing for this run -> unverifiable(harness-absent), never "unmatched"', rep.items.every((i) => i.unverifiable_kind === 'harness-absent'), JSON.stringify(rep.items.map((i) => i.unverifiable_kind)));
  hooks(L, 'subagent-stop.jsonl', [{ event: 'SubagentStop', agent_id: 'acccccccccccccccc', agent_type: 'ui-boss', run: 'run-l1' }]);
  t('A21 only the stop hook recorded the run: at write time an unknown agent id is harness-pending', HM.matchRun({ root: L, runId: 'run-l1', final: false, findJournals: false }).items[1].unverifiable_kind === 'harness-pending');
  t('A22 ... and at completion (final) it is unmatched', HM.matchRun({ root: L, runId: 'run-l1', final: true, findJournals: false }).items[1].status === 'unmatched');

  // ================================================================================================
  console.log('\nB) (a) the fake-dispatch proof');
  // ================================================================================================
  const B = mkRoot();
  hooks(B, 'agent-tool.jsonl', [{ event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000002', subagent_type: 'build-boss', run: 'run-fake' }]);
  writeRun(B, 'run-fake', [sub('Build Boss', 'toolu_REAL00000002'), sub('Build Boss', 'toolu_FAKE00000099')]);
  rep = HM.matchRun({ root: B, runId: 'run-fake', final: true });
  const fake = byId(rep, 'toolu_FAKE00000099');
  t('B1 a subagent_started whose dispatch_id has NO harness record is UNMATCHED (the harness recorded this run)', fake.status === 'unmatched' && /no PreToolUse\(Agent\) record/.test(fake.reason), JSON.stringify(fake));
  t('B2 the real one next to it is matched', byId(rep, 'toolu_REAL00000002').status === 'matched');
  t('B3 match 50% -> below the 95% default (meetsThreshold false); 0 dispatches or nothing provable -> true', rep.summary.match_pct === 50 && !HM.meetsThreshold(rep.summary) && HM.meetsThreshold({ dispatches: 0 }) && HM.meetsThreshold({ dispatches: 2, provable: 0, match_pct: null }));
  t('B4 harnessProofFor (the write-time view) says unmatched for the fake, matched for the real', HM.harnessProofFor({ root: B, runId: 'run-fake', event: sub('Build Boss', 'toolu_FAKE00000099') }).status === 'unmatched'
    && HM.harnessProofFor({ root: B, runId: 'run-fake', event: sub('Build Boss', 'toolu_REAL00000002') }).status === 'matched');
  t('B5 harnessProofFor on a run the harness never recorded -> not-live (nothing to judge against)', HM.harnessProofFor({ root: B, runId: 'run-other-x', event: sub('Build Boss', 'toolu_FAKE00000099') }).status === 'not-live');

  // ================================================================================================
  console.log('\nC) CLI');
  // ================================================================================================
  const cli = (args) => spawnSync(process.execPath, [path.join(BIN, 'forge-harness-match.cjs')].concat(args), { encoding: 'utf8', timeout: 20000, env: process.env });
  let x = cli(['--run', 'run-fake', '--root', B]);
  t('C1 below the threshold -> exit 1, text report names the fake as unmatched', x.status === 1 && /toolu_FAKE00000099/.test(x.stdout) && /unmatched/.test(x.stdout), JSON.stringify({ s: x.status, o: x.stdout.slice(0, 400), e: x.stderr }));
  x = cli(['--run', 'run-fake', '--root', B, '--min', '50', '--json']);
  const j = x.status === 0 ? JSON.parse(x.stdout) : null;
  t('C2 --min 50 --json -> exit 0 and the report shape', !!j && j.meets_min === true && j.min_match_pct === 50 && j.summary.dispatches === 2 && Array.isArray(j.items) && j.harness.live.tool === 1, x.stdout.slice(0, 300) + x.stderr);
  t('C3 usage errors -> exit 2 (no --run, bad --min, unknown run)', cli(['--root', B]).status === 2 && cli(['--run', 'run-fake', '--min', '150']).status === 2 && cli(['--run', 'no-such-run', '--root', B]).status === 2);

  // ================================================================================================
  console.log('\nD) (d) the contract rule dispatch-harness-match');
  // ================================================================================================
  const rule = PROD.rules.find((r) => r.id === RULE);
  t('D1 production rule: run-evidence dispatch-harness, warn, complexity:>=L2, complete, since 2026-11-01, min 95',
    !!rule && rule.check.type === 'run-evidence' && rule.check.evidence === 'dispatch-harness' && rule.check.min_match_pct === 95 && rule.severity === 'warn' && rule.trigger === 'complexity:>=L2' && rule.phase === 'complete' && rule.since === '2026-11-01', JSON.stringify(rule && rule.check));
  t('D2 no agent exception, owner_override only; message en/nl; next_step; promotion documents >=95% over 3 runs',
    !!rule && rule.check.exception === undefined && rule.cannot_override === undefined && /owner_override/.test(rule.override) && rule.message.en.length > 80 && rule.message.nl.length > 80 && /forge-harness-match\.cjs --run <run_id>/.test(rule.next_step) && /95/.test(rule.promotion) && /3 applicable real runs/.test(rule.promotion));
  const meta0 = RC.loadRulesMeta(REAL_RULES);
  t('D3 this checker knows the evidence kind (nothing degraded)', !meta0.unknownCheckTypes.length && !meta0.unknownTriggers.length && RC.RUN_EVIDENCE_KINDS.has('dispatch-harness'));
  const goat = (PROD.orchestration_hard_rules || []).find((r) => r.id === 'goat-model-routing');
  t('D4 goat-model-routing no longer says the Agent tool lacks an effort param', !!goat && !/no\s+effort\s+param/i.test(goat.rule) && /2\.1\.292/.test(goat.rule));
  const lc = (PROD.lifecycle || []).find((r) => r.id === 'subagent-dispatched');
  t('D5 the lifecycle row subagent-dispatched points at the rule', !!lc && lc.rule_ids.includes(RULE));

  let c = chk(B, 'run-fake');
  const d = c.rule_details[RULE] || {};
  t('D6 L2 fixture run with a fake dispatch -> dispatch-harness-match is a WARNING (not missing, not satisfied)', c.warnings.includes(RULE) && !c.missing.includes(RULE) && !c.satisfied.includes(RULE), JSON.stringify({ w: c.warnings, m: c.missing }));
  t('D7 its detail carries the harness counts, the open dispatch and the next command for this run', d.harness && d.harness.matched === 1 && d.harness.unmatched === 1 && d.harness.match_pct === 50 && d.harness.open[0].dispatch_id === 'toolu_FAKE00000099' && /--run run-fake/.test(d.next_step || '') && /--run run-fake/.test((d.message || {}).en || ''), JSON.stringify(d).slice(0, 700));
  writeRun(B, 'run-ok', [sub('Build Boss', 'toolu_REAL00000002')]);
  hooks(B, 'agent-tool.jsonl', [{ event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000002', subagent_type: 'build-boss', run: 'run-ok' }]);
  c = chk(B, 'run-ok');
  t('D8 every dispatch matched -> satisfied (via evidence)', c.satisfied.includes(RULE) && !c.warnings.includes(RULE) && c.rule_details[RULE].via === 'evidence', JSON.stringify(c.rule_details[RULE]));
  writeRun(B, 'run-l1x', [sub('Build Boss', 'toolu_FAKE00000099')], { level: 'L1' });
  c = chk(B, 'run-l1x');
  t('D9 an L1 run: the rule does not apply', !c.warnings.includes(RULE) && !c.satisfied.includes(RULE));
  writeRun(B, 'run-old', [sub('Build Boss', 'toolu_FAKE00000099')], { ts: '2026-10-20T09:00:00.000Z' });
  c = chk(B, 'run-old');
  t('D10 a run that started before 2026-11-01 is historical_exempt', c.historical_exempt.some((h) => h.id === RULE) && !c.warnings.includes(RULE));
  writeRun(B, 'run-own', [sub('Build Boss', 'toolu_FAKE00000099'), { event_type: 'owner_override', rule: RULE, reason: 'owner saw the dispatch live in the session', by: 'owner', timestamp: TS }]);
  c = chk(B, 'run-own');
  t('D11 a valid owner_override clears it (overridden)', c.overridden.some((o) => o.id === RULE) && !c.warnings.includes(RULE));
  writeRun(B, 'run-agent', [sub('Build Boss', 'toolu_FAKE00000099'), { event_type: 'decision_logged', agent: 'orchestrator', rule: RULE, decision: 'not-applicable', reason: 'the lead says these dispatches were real' }]);
  t('D12 an agent cannot excuse it with a decision_logged exception', chk(B, 'run-agent').warnings.includes(RULE));
  writeRun(B, 'run-none', []);
  c = chk(B, 'run-none');
  t('D13 no dispatch event at all -> satisfied with "nothing to match" (dispatch-logged judges the absence)', c.satisfied.includes(RULE) && /nothing to match/.test(c.rule_details[RULE].reason));

  // fail-closed: the matcher is absent next to the checker
  const hmPath = require.resolve('./forge-harness-match.cjs');
  const saved = require.cache[hmPath];
  const Module = require('module');
  const stub = new Module(hmPath);
  stub.filename = hmPath; stub.loaded = true; stub.exports = {};
  require.cache[hmPath] = stub;
  try {
    c = chk(B, 'run-ok');
    t('D14 without forge-harness-match.cjs the rule is NOT satisfied (fail-closed), with the reason', c.warnings.includes(RULE) && /fail-closed/.test(c.rule_details[RULE].reason), JSON.stringify(c.rule_details[RULE]));
  } finally { require.cache[hmPath] = saved; }

  // mutants: the assertions above bite
  const blockRules = JSON.parse(JSON.stringify(PROD)); blockRules.rules.find((r) => r.id === RULE).severity = 'block';
  const fakeRunIn = (root) => {
    hooks(root, 'agent-tool.jsonl', [{ event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000002', subagent_type: 'build-boss', run: 'run-fake' }]);
    writeRun(root, 'run-fake', [sub('Build Boss', 'toolu_REAL00000002'), sub('Build Boss', 'toolu_FAKE00000099')]);
  };
  const M1 = mkRoot({ rules: blockRules });
  fakeRunIn(M1);
  t('D15 MUTANT severity block: the rule lands in missing -> D6 would fail', chk(M1, 'run-fake').missing.includes(RULE));
  const lowRules = JSON.parse(JSON.stringify(PROD)); lowRules.rules.find((r) => r.id === RULE).check.min_match_pct = 50;
  const M2 = mkRoot({ rules: lowRules });
  fakeRunIn(M2);
  t('D16 min_match_pct is honoured: 50 makes the 50% run satisfied', chk(M2, 'run-fake').satisfied.includes(RULE));
  const badRules = JSON.parse(JSON.stringify(PROD)); badRules.rules.find((r) => r.id === RULE).check.min_match_pct = 150;
  const badPath = path.join(TMP, 'bad-rules.json');
  fs.writeFileSync(badPath, JSON.stringify(badRules));
  let threw = null;
  try { RC.loadRulesMeta(badPath); } catch (e) { threw = e.message; }
  t('D17 an out-of-range min_match_pct is a malformed rules file (throws, names the field)', !!threw && /min_match_pct/.test(threw), threw);

  // ================================================================================================
  console.log('\nE) log-event.cjs: backfill is a labelled exception');
  // ================================================================================================
  function writerRoot(withMatcher) {
    const root = mkRoot();
    fs.copyFileSync(LOG_EVENT_SRC, path.join(mk(root, '.claude', 'forge-dashboard'), 'log-event.cjs'));
    fs.copyFileSync(REAL_REGISTRY, path.join(mk(root, '.claude', 'config', 'agents'), 'agent-registry.json'));
    if (withMatcher) fs.copyFileSync(path.join(BIN, 'forge-harness-match.cjs'), path.join(mk(root, '.claude', 'forge-bin'), 'forge-harness-match.cjs'));
    return root;
  }
  const log = (root, run, type, extra, env) => spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), run, type, JSON.stringify(extra)],
    { encoding: 'utf8', timeout: 30000, cwd: root, env: Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '', FORGE_HARNESS_STAMP: '' }, env || {}) });
  const lastEvent = (root, run) => { const l = fs.readFileSync(path.join(root, '.claude', 'forge-runs', run, 'events.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); };
  const FAKE = { agent: 'Build Boss', role: 'builder', runtime: 'agent-tool', dispatch_id: 'toolu_FAKE00000099', task: 'WP x' };

  const old = writerRoot(false);
  let w = log(old, 'run-le', 'run_started', { agent: 'orchestrator' });
  w = log(old, 'run-le', 'subagent_started', FAKE);
  let ev = w.status === 0 ? lastEvent(old, 'run-le') : {};
  t('E1 OLD PATH (no matcher next to the writer, i.e. log-event before A2): the fake dispatch is accepted SILENTLY — no flag, no stamp',
    w.status === 0 && !/\[/.test(w.stdout) && !(ev._forge_verify || {}).dispatch_unverified, JSON.stringify({ s: w.status, o: w.stdout, e: w.stderr, fv: ev._forge_verify }));

  const nw = writerRoot(true);
  hooks(nw, 'agent-tool.jsonl', [{ event: 'PreToolUse', tool: 'Agent', tool_use_id: 'toolu_REAL00000002', subagent_type: 'build-boss', run: 'run-le' }]);
  log(nw, 'run-le', 'run_started', { agent: 'orchestrator' });
  w = log(nw, 'run-le', 'subagent_started', FAKE);
  ev = w.status === 0 ? lastEvent(nw, 'run-le') : {};
  const fv = ev._forge_verify || {};
  t('E2 NEW PATH: the same fake is still WRITTEN under default strict mode (exit 0) — never refused', w.status === 0 && ev.dispatch_id === 'toolu_FAKE00000099', JSON.stringify({ s: w.status, e: w.stderr }));
  t('E3 ... stamped dispatch_unverified:true + dispatch_unverified_reason "no-harness-proof: ..." + dispatch_unverified_accepted',
    fv.dispatch_unverified === true && /^no-harness-proof: /.test(fv.dispatch_unverified_reason || '') && fv.dispatch_unverified_accepted === true, JSON.stringify(fv));
  t('E4 ... tagged NO-HARNESS-PROOF on stdout and warned on stderr', /\[NO-HARNESS-PROOF\]/.test(w.stdout) && /WARNING — dispatch_unverified \(no-harness-proof:/.test(w.stderr), JSON.stringify({ o: w.stdout, e: w.stderr }));
  w = log(nw, 'run-le', 'subagent_started', Object.assign({}, FAKE, { dispatch_id: 'toolu_REAL00000002' }));
  ev = w.status === 0 ? lastEvent(nw, 'run-le') : {};
  t('E5 a dispatch the harness recorded is NOT stamped', w.status === 0 && !(ev._forge_verify || {}).dispatch_unverified && !/NO-HARNESS-PROOF/.test(w.stdout), JSON.stringify({ s: w.status, fv: ev._forge_verify }));
  const before = fs.readFileSync(path.join(nw, '.claude', 'forge-runs', 'run-le', 'events.jsonl'), 'utf8');
  w = log(nw, 'run-le', 'subagent_started', { agent: 'Build Boss', role: 'builder', runtime: 'agent-tool', task: 'no id' });
  t('E6 no dispatch_id at all is still REFUSED in strict mode (unchanged), nothing written', w.status === 2 && fs.readFileSync(path.join(nw, '.claude', 'forge-runs', 'run-le', 'events.jsonl'), 'utf8') === before, JSON.stringify({ s: w.status, e: w.stderr }));
  log(nw, 'run-le2', 'run_started', { agent: 'orchestrator' });
  w = log(nw, 'run-le2', 'subagent_started', FAKE);
  ev = w.status === 0 ? lastEvent(nw, 'run-le2') : {};
  t('E7 a run the harness never recorded is not stamped (behaviour unchanged until the pointer is adopted)', w.status === 0 && !(ev._forge_verify || {}).dispatch_unverified, JSON.stringify(ev._forge_verify));
  w = log(nw, 'run-le', 'subagent_started', FAKE, { FORGE_HARNESS_STAMP: 'off' });
  ev = w.status === 0 ? lastEvent(nw, 'run-le') : {};
  t('E8 FORGE_HARNESS_STAMP=off turns the stamp off', w.status === 0 && !(ev._forge_verify || {}).dispatch_unverified);
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\nforge-harness-match tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
