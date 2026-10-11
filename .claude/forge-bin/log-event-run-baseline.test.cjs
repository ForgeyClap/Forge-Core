#!/usr/bin/env node
'use strict';
/** log-event-run-baseline.test.cjs — part B.
 *
 *  The writer side of the FORGE_HARD_RULES.json version-2 rules, proven against the REAL writer source:
 *   (1) the nine version-2 event types are registered — a hermetic copy of the real log-event.cjs accepts
 *       each one (exit 0, no UNKNOWN-TYPE stamp) and an invented type is still refused;
 *   (2) wp_verified is identity-checked: a phantom verifier is refused, Verify Boss is accepted, and an
 *       honest FAIL verdict is never refused as a contradicting pass claim;
 *   (3) every run_started gets a `file_hashes` baseline taken from the ONE registry (fileTouchedTargets),
 *       and the production memory-files-touched rule evaluates it end to end (unchanged -> warning,
 *       changed/created -> satisfied);
 *   (4) the baseline is fail-safe and never blocks run_started: a missing file is null, an unreadable one is
 *       listed in file_hashes_unreadable (never recorded as "absent"), a corrupt registry or a missing
 *       forge-runcontract.cjs gives file_hashes_unavailable, a project without a file-touched rule gets no
 *       baseline fields at all — and run_started is written with exit 0 in every case;
 *   (5) a caller cannot forge the baseline: a caller-supplied file_hashes is replaced and flagged;
 *   (6) the forge-verify.cjs mirror puts each type in its intended bucket (the seven bookkeeping types are
 *       BACKBONE, never a per-agent task; wp_verified's status follows its verdict), and the run contract
 *       counts exactly the seven bookkeeping types as non-work.
 *  Every fixture lives in its own os.mkdtemp root (removed at the end); the real project is only READ. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')); }
};

const CLAUDE = path.join(__dirname, '..');
const REAL_WRITER = path.join(CLAUDE, 'forge-dashboard', 'log-event.cjs');
const REAL_RC = path.join(__dirname, 'forge-runcontract.cjs');
const PROD_RULES = path.join(CLAUDE, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const REGISTRY = path.join(CLAUDE, 'config', 'agents', 'agent-registry.json');
const VERIFY_BOSS_FILE = path.join(CLAUDE, 'agents', 'verify-boss.md');
const RC = require('./forge-runcontract.cjs');
const V = require('./forge-verify.cjs');

const V2_TYPES = ['wp_verified', 'escalation', 'route_assigned', 'run_paused', 'run_resumed', 'session_resumed', 'gate_blocked', 'sync_completed', 'owner_requirement_noted'];
const INERT = ['wp_verified', 'escalation', 'route_assigned', 'run_paused', 'run_resumed', 'session_resumed', 'gate_blocked'];
const MEM = ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md'];
const NO_OWNER_PROFILE = path.join(os.tmpdir(), 'forge-le-baseline-no-owner-profile-' + process.pid + '.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const roots = [];
/** makeRoot(opts) — a temp project holding a COPY of the real writer and run contract, the production rules
 *  (or opts.rulesText; null = no rules file), the agent registry and the verify-boss agent file. */
function makeRoot(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-le-baseline-'));
  roots.push(root);
  const cd = path.join(root, '.claude');
  for (const d of ['forge-dashboard', 'forge-bin', path.join('config', 'orchestration'), path.join('config', 'agents'), 'agents']) fs.mkdirSync(path.join(cd, d), { recursive: true });
  fs.copyFileSync(REAL_WRITER, path.join(cd, 'forge-dashboard', 'log-event.cjs'));
  if (opts.runcontract !== false) fs.copyFileSync(REAL_RC, path.join(cd, 'forge-bin', 'forge-runcontract.cjs'));
  const rulesDest = path.join(cd, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  if (opts.rulesText === undefined) fs.copyFileSync(PROD_RULES, rulesDest);
  else if (opts.rulesText !== null) fs.writeFileSync(rulesDest, opts.rulesText, 'utf8');
  fs.copyFileSync(REGISTRY, path.join(cd, 'config', 'agents', 'agent-registry.json'));
  fs.copyFileSync(VERIFY_BOSS_FILE, path.join(cd, 'agents', 'verify-boss.md'));
  return root;
}
function log(root, runId, type, payload) {
  return spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), runId, type, JSON.stringify(payload || {})],
    { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' }) });
}
function events(root, runId) {
  return fs.readFileSync(path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const last = (root, runId) => { const all = events(root, runId); return all[all.length - 1]; };
const out = (r) => String(r.stdout || '') + String(r.stderr || '');

try {
  // ==============================================================================================
  console.log('log-event run baseline + version-2 event registration tests');
  console.log('\n1) the nine version-2 event types are accepted by the real writer');
  // ==============================================================================================
  {
    const root = makeRoot();
    const PAYLOAD = {
      wp_verified: { agent: 'Verify Boss', wp_id: 'WP1', verdict: 'PASS', evidence: 'node x.test.cjs -> exit 0, 12 passed, 0 failed' },
      escalation: { agent: 'Head Chef', wp_id: 'WP1', from: 'build', to: 'deep', reason: 'capability' },
      route_assigned: { agent: 'Head Chef', wp_id: 'WP1', route: 'build', model: 'opus', effort: 'medium', risk: 'low' },
      run_paused: { agent: 'orchestrator', reason: 'usage-limit' },
      run_resumed: { agent: 'orchestrator', note: 'usage window reset' },
      session_resumed: { agent: 'orchestrator', note: 'after compaction' },
      gate_blocked: { agent: 'orchestrator', gate: 'recursive-delete', command_digest: 'abc123' },
      sync_completed: { agent: 'orchestrator', doctor_ok: true, preserved_ok: true },
      owner_requirement_noted: { agent: 'orchestrator', req_id: 'REQ-1' },
    };
    for (const type of V2_TYPES) {
      const r = log(root, 'reg', type, PAYLOAD[type]);
      const ev = r.status === 0 ? last(root, 'reg') : null;
      t('writer accepts ' + type + ' (exit 0, lands, no UNKNOWN-TYPE stamp)', r.status === 0 && ev && ev.event_type === type && !(ev._forge_verify && ev._forge_verify.event_type_unknown), out(r));
    }
    const bad = log(root, 'reg', 'zz_v2_invented_type', { agent: 'orchestrator' });
    t('an invented event type is still STRICT-refused (exit 2, unknown event_type)', bad.status === 2 && /unknown event_type/.test(out(bad)), out(bad));
    const doctor = require('./forge-doctor.cjs');
    const seen = doctor.extractKnownEventTypesFromSource(fs.readFileSync(REAL_WRITER, 'utf8'));
    t('the doctor unregistered_event extractor sees all nine in the real KNOWN_EVENT_TYPES literal', !!seen && V2_TYPES.every((x) => seen.has(x)), V2_TYPES.filter((x) => !seen || !seen.has(x)).join(','));
  }

  // ==============================================================================================
  console.log('\n2) wp_verified identity and verdicts');
  // ==============================================================================================
  {
    const root = makeRoot();
    const phantom = log(root, 'id', 'wp_verified', { agent: 'No Such Verifier', wp_id: 'WP1', verdict: 'PASS', evidence: 'x' });
    t('a phantom verifier is refused (exit 2, unregistered agent) — the per-package rule decides from this agent', phantom.status === 2 && /unregistered agent/.test(out(phantom)), out(phantom));
    const vb = log(root, 'id', 'wp_verified', { agent: 'verify-boss', wp_id: 'WP1', verdict: 'PASS', evidence: 'node x.test.cjs exit 0' });
    const vbEv = vb.status === 0 ? last(root, 'id') : null;
    t('verify-boss (a real agent file) is accepted and stamped as a project agent', vb.status === 0 && vbEv && vbEv._forge_verify && vbEv._forge_verify.agent_kind === 'project-agent', out(vb));
    const failVerdict = log(root, 'id', 'wp_verified', { agent: 'Verify Boss', wp_id: 'WP2', verdict: 'FAIL', evidence: 'npm test exit 1: 2 failed' });
    t('an honest FAIL verdict is accepted — it is not a pass claim, so no contradiction oracle refuses it', failVerdict.status === 0, out(failVerdict));
    const boss = log(root, 'id', 'wp_verified', { agent: 'Review Boss', wp_id: 'WP3', verdict: 'PASS', evidence: 'read the diff' });
    t('a permanent Boss is accepted as verifier', boss.status === 0, out(boss));
  }

  // ==============================================================================================
  console.log('\n3) run_started stores the file_hashes baseline and the production rule evaluates it');
  // ==============================================================================================
  {
    const root = makeRoot();
    const abs = (rel) => path.join(root, ...rel.split('/'));
    fs.writeFileSync(abs(MEM[0]), '# memory v1\n');
    fs.writeFileSync(abs(MEM[2]), '# ledger v1\n'); // MEM[1] (task history) does not exist yet
    const r = log(root, 'base', 'run_started', { agent: 'orchestrator', note: 'baseline fixture' });
    const ev = r.status === 0 ? last(root, 'base') : {};
    const fh = ev.file_hashes || {};
    t('run_started is written (exit 0) and carries file_hashes', r.status === 0 && !!ev.file_hashes, out(r));
    t('file_hashes covers exactly the files the ONE registry watches (fileTouchedTargets, no second list)',
      JSON.stringify(Object.keys(fh)) === JSON.stringify(RC.fileTouchedTargets(JSON.parse(fs.readFileSync(PROD_RULES, 'utf8')))), JSON.stringify(Object.keys(fh)));
    t('an existing file is recorded as its real sha256', fh[MEM[0]] === sha('# memory v1\n') && fh[MEM[2]] === sha('# ledger v1\n'), JSON.stringify(fh));
    t('a missing file is recorded as null (absent at run start)', Object.prototype.hasOwnProperty.call(fh, MEM[1]) && fh[MEM[1]] === null, JSON.stringify(fh));
    t('a clean snapshot carries no unreadable/unavailable notes and prints no notice', ev.file_hashes_unreadable === undefined && ev.file_hashes_unavailable === undefined && !/baseline/i.test(String(r.stderr || '')), out(r));
    const judge = () => RC.check({ run_id: 'base' }, { root, ownerProfilePath: NO_OWNER_PROFILE });
    const before = judge();
    const d1 = (before.rule_details || {})['memory-files-touched'] || {};
    t('production rule, nothing touched yet: memory-files-touched is a WARNING with a recorded baseline', before.warnings.includes('memory-files-touched') && d1.baseline_recorded === true && !before.missing.includes('memory-files-touched'), JSON.stringify(d1));
    fs.writeFileSync(abs(MEM[0]), '# memory v2\n');
    const partial = judge();
    t('production rule, one of three updated: still a warning (mode all)', partial.warnings.includes('memory-files-touched'));
    fs.writeFileSync(abs(MEM[1]), '# task history, created during the run\n');
    fs.writeFileSync(abs(MEM[2]), '# ledger v2\n');
    const after = judge();
    t('production rule, all three updated or created since run_started: satisfied', after.satisfied.includes('memory-files-touched'), JSON.stringify((after.rule_details || {})['memory-files-touched']));
    const note = log(root, 'base', 'agent_note', { agent: 'orchestrator', note: 'not a run start' });
    t('only run_started gets a baseline (an agent_note carries no file_hashes)', note.status === 0 && last(root, 'base').file_hashes === undefined, out(note));
    const batch = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), '--batch', 'batchrun'],
      { input: JSON.stringify({ event_type: 'run_started', agent: 'orchestrator', note: 'batch start' }) + '\n', encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' }) });
    t('batch mode stamps the same baseline (one shared write path)', batch.status === 0 && !!last(root, 'batchrun').file_hashes && last(root, 'batchrun').file_hashes[MEM[0]] === sha('# memory v2\n'), out(batch));
  }

  // ==============================================================================================
  console.log('\n4) fail-safe: the baseline never blocks run_started');
  // ==============================================================================================
  {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.claude', 'FORGE_MEMORY.md')); // a directory where a file is expected -> unreadable
    fs.writeFileSync(path.join(root, '.claude', 'FORGE_AGENT_LEDGER.md'), '# ledger\n');
    const r = log(root, 'unread', 'run_started', { agent: 'orchestrator' });
    const ev = r.status === 0 ? last(root, 'unread') : {};
    const fh = ev.file_hashes || {};
    t('an unreadable watched file does not block run_started (exit 0)', r.status === 0, out(r));
    t('... it is listed in file_hashes_unreadable', Array.isArray(ev.file_hashes_unreadable) && ev.file_hashes_unreadable.some((x) => x.file === MEM[0] && typeof x.error === 'string' && x.error.length > 0), JSON.stringify(ev.file_hashes_unreadable));
    t('... and is NOT recorded as null (null means absent; an unreadable file existed, so it cannot count as created later)', !Object.prototype.hasOwnProperty.call(fh, MEM[0]), JSON.stringify(fh));
    t('... the readable files are still baselined', fh[MEM[2]] === sha('# ledger\n') && fh[MEM[1]] === null, JSON.stringify(fh));
    t('... and the writer says so on stderr (visible, not silent)', /file_hashes|baseline/i.test(String(r.stderr || '')), out(r));
  }
  {
    const root = makeRoot({ rulesText: '{ this is not json' });
    const r = log(root, 'corrupt', 'run_started', { agent: 'orchestrator' });
    const ev = r.status === 0 ? last(root, 'corrupt') : {};
    t('a corrupt rules registry: run_started still written (exit 0) with file_hashes_unavailable, no file_hashes', r.status === 0 && ev.file_hashes === undefined && /registry/.test(String(ev.file_hashes_unavailable || '')), out(r) + JSON.stringify(ev));
    t('... and the degraded baseline is announced with one NOTE line on stderr', /NOTE run_started/.test(String(r.stderr || '')), out(r));
  }
  {
    const root = makeRoot({ runcontract: false });
    const r = log(root, 'norc', 'run_started', { agent: 'orchestrator' });
    const ev = r.status === 0 ? last(root, 'norc') : {};
    t('forge-runcontract.cjs missing (registry present): exit 0 with file_hashes_unavailable naming it', r.status === 0 && ev.file_hashes === undefined && /forge-runcontract/.test(String(ev.file_hashes_unavailable || '')), out(r) + JSON.stringify(ev));
  }
  {
    const root = makeRoot({ rulesText: null });
    const r = log(root, 'norules', 'run_started', { agent: 'orchestrator' });
    const ev = r.status === 0 ? last(root, 'norules') : {};
    t('no rules registry at all (an older or minimal project): exit 0, no baseline fields, no notice', r.status === 0 && ev.file_hashes === undefined && ev.file_hashes_unavailable === undefined && !/baseline/i.test(String(r.stderr || '')), out(r) + JSON.stringify(ev));
  }
  {
    const rules = { version: 2, owners_allowlist: ['owner'], rules: [{ id: 'has-start', rule: 'x', trigger: 'always', check: { type: 'event-present', key: 'run_started' }, severity: 'block', override: 'n/a', source: 'test' }] };
    const root = makeRoot({ rulesText: JSON.stringify(rules) });
    const r = log(root, 'nofiles', 'run_started', { agent: 'orchestrator' });
    const ev = r.status === 0 ? last(root, 'nofiles') : {};
    t('a registry without any file-touched rule: nothing to baseline, no baseline fields at all', r.status === 0 && ev.file_hashes === undefined && ev.file_hashes_unavailable === undefined && ev.file_hashes_unreadable === undefined, out(r) + JSON.stringify(ev));
    const mixed = makeRoot({ rulesText: JSON.stringify(rules), runcontract: false });
    const m = log(mixed, 'mixed', 'run_started', { agent: 'orchestrator' });
    const mev = m.status === 0 ? last(mixed, 'mixed') : {};
    t('mixed-version project (older registry without file-touched, no snapshot helpers): no baseline fields and no NOTE noise',
      m.status === 0 && mev.file_hashes === undefined && mev.file_hashes_unavailable === undefined && !/NOTE/.test(String(m.stderr || '')), out(m) + JSON.stringify(mev));
  }

  // ==============================================================================================
  console.log('\n5) a caller cannot forge the baseline');
  // ==============================================================================================
  {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), '# real memory\n');
    const forged = { '.claude/FORGE_MEMORY.md': 'f'.repeat(64), '.claude/FORGE_TASK_HISTORY.md': 'e'.repeat(64), '.claude/FORGE_AGENT_LEDGER.md': 'd'.repeat(64) };
    const r = log(root, 'forge', 'run_started', { agent: 'orchestrator', file_hashes: forged, file_hashes_unavailable: 'caller text' });
    const ev = r.status === 0 ? last(root, 'forge') : {};
    t('a caller-supplied file_hashes is replaced by the writer snapshot (a forged baseline would fake "every file changed")',
      r.status === 0 && ev.file_hashes && ev.file_hashes['.claude/FORGE_MEMORY.md'] === sha('# real memory\n') && ev.file_hashes['.claude/FORGE_TASK_HISTORY.md'] === null, JSON.stringify(ev.file_hashes));
    t('... the other caller-supplied baseline field is dropped too', ev.file_hashes_unavailable === undefined, JSON.stringify(ev));
    t('... and the replacement is stamped and printed, never silent', ev._forge_verify && ev._forge_verify.file_hashes_replaced === true && /FILE-HASHES-REPLACED/.test(String(r.stdout || '')), out(r) + JSON.stringify(ev._forge_verify));
    const ok = log(root, 'forge', 'run_started', { agent: 'orchestrator' });
    t('a normal run_started is not stamped as replaced', ok.status === 0 && !(last(root, 'forge')._forge_verify && last(root, 'forge')._forge_verify.file_hashes_replaced), out(ok));
  }

  // ==============================================================================================
  console.log('\n6) forge-verify.cjs mirror and the run-contract work classification');
  // ==============================================================================================
  {
    const buckets = (type) => ['TERMINAL_TYPES', 'FAILED_TYPES', 'RUNNING_TYPES', 'PREVIEWING_TYPES', 'INTERNAL_TYPES', 'WAITING_TYPES'].filter((k) => V[k] && V[k].has(type));
    const EXPECT = {
      wp_verified: { backbone: true, buckets: [] },
      escalation: { backbone: true, buckets: ['PREVIEWING_TYPES'], status: 'previewing' },
      route_assigned: { backbone: true, buckets: ['PREVIEWING_TYPES'], status: 'previewing' },
      run_paused: { backbone: true, buckets: ['WAITING_TYPES'], status: 'waiting' },
      run_resumed: { backbone: true, buckets: ['RUNNING_TYPES'], status: 'running' },
      session_resumed: { backbone: true, buckets: ['RUNNING_TYPES'], status: 'running' },
      gate_blocked: { backbone: true, buckets: ['FAILED_TYPES'], status: 'failed' },
      sync_completed: { backbone: false, buckets: ['TERMINAL_TYPES'], status: 'done' },
      owner_requirement_noted: { backbone: false, buckets: ['TERMINAL_TYPES'], status: 'done' },
    };
    for (const type of V2_TYPES) {
      const e = EXPECT[type];
      t('forge-verify: ' + type + ' sits in exactly ' + (e.buckets.join('+') || 'no status bucket') + (e.backbone ? ' and BACKBONE' : ', not BACKBONE'),
        JSON.stringify(buckets(type)) === JSON.stringify(e.buckets) && V.BACKBONE.has(type) === e.backbone, JSON.stringify({ buckets: buckets(type), backbone: V.BACKBONE.has(type) }));
      if (e.status) t('forge-verify: taskStatus(' + type + ') is ' + e.status, V.taskStatus({ event_type: type }) === e.status, V.taskStatus({ event_type: type }));
    }
    t('forge-verify: every version-2 type is in TERMINAL_TYPES or BACKBONE (the doctor unregistered_event cross-check set)', V2_TYPES.every((x) => V.TERMINAL_TYPES.has(x) || V.BACKBONE.has(x)));
    t('forge-verify: wp_verified status follows its verdict — PASS done, FAIL failed, no verdict waiting (never implied done)',
      V.taskStatus({ event_type: 'wp_verified', verdict: 'PASS' }) === 'done' && V.taskStatus({ event_type: 'wp_verified', verdict: 'FAIL' }) === 'failed' && V.taskStatus({ event_type: 'wp_verified' }) === 'waiting');
    t('forge-verify: a disproven wp_verified is failed whatever its verdict', V.taskStatus({ event_type: 'wp_verified', verdict: 'PASS', _forge_verify: { proof_verified: false } }) === 'failed');
    // verifyRun: a verifier that logs a FAIL verdict and then completes is NOT a mismatch (its verdict is not its own open task)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-le-baseline-vr-'));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      { event_type: 'agent_started', agent: 'Verify Boss', dispatch_id: 'toolu_x' },
      { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP1', verdict: 'FAIL', evidence: 'npm test exit 1' },
      { event_type: 'gate_blocked', agent: 'Verify Boss', gate: 'recursive-delete' },
      { event_type: 'agent_completed', agent: 'Verify Boss', note: 'verdict delivered' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const vr = V.verifyRun(dir, {});
    const vb = vr.agents.find((a) => a.agent === 'Verify Boss') || {};
    t('verifyRun: a verifier that logged a FAIL verdict (and a gate block) and then completed is not a mismatch', vr.mismatches === 0 && vb.tasksTotal === 0, JSON.stringify(vb));

    t('run contract: the seven bookkeeping types are non-work', INERT.every((x) => RC.NON_WORK_EVENT_TYPES.has(x) && RC.isWorkEventType(x) === false), INERT.filter((x) => RC.isWorkEventType(x)).join(','));
    t('run contract: sync_completed and owner_requirement_noted stay WORK (a sync writes files; a new requirement must make an earlier review stale)',
      RC.isWorkEventType('sync_completed') === true && RC.isWorkEventType('owner_requirement_noted') === true);
  }
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
