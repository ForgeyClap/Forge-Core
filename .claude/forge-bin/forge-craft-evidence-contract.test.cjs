#!/usr/bin/env node
'use strict';
/**
 * forge-craft-evidence-contract.test.cjs — S3b: the run-contract rule craft-evidence-recorded. A run that
 * declares a web-ui deliverable cannot be called clean without <run folder>/craft-evidence-web-ui.json, judged by
 * forge-craft-evidence.cjs (every viewport and state the web-ui lens asks for, real screenshot files in the project).
 * Hermetic: every fixture lives in one os.mkdtemp folder (removed at the end); the real project is only read (the
 * production FORGE_HARD_RULES.json and the web-ui lens).
 *   A. the registry entry: run-evidence craft-evidence, block, run-shape:web-ui-deliverable, complete, since 2026-10-24
 *   B. contract, legacy and .forge layout: non-web run -> not applicable; web run without a record -> MISSING (blocks)
 *      with the run id filled in; complete record -> clean; a missing screenshot file -> missing
 *   C. historical run exempt; owner_override clears; an agent cannot excuse it; fail-closed without the helper
 *   D. mutations: the rule removed / the evidence kind misspelt -> the assertions above would fail
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const BIN = __dirname;
const CLAUDE_SRC = path.join(BIN, '..');
const REAL_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const REAL_LENS = path.join(CLAUDE_SRC, 'config', 'quality', 'lenses', 'web-ui.json');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-craft-ev-contract-')));
for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete process.env[k];
process.env.FORGE_CONFIG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });

const RC = require('./forge-runcontract.cjs');
const V = require('./forge-craft-evidence.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const ID = 'craft-evidence-recorded';
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const PROD = JSON.parse(fs.readFileSync(REAL_RULES, 'utf8'));
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
let rootN = 0;

// ---- a tiny but VALID png (signature, IHDR, one IDAT, IEND, real CRCs) of the given pixel width ----------------
const CRC_TABLE = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(width) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale, 1 row
  const row = Buffer.alloc(1 + width, 0xee); row[0] = 0; // filter byte 0 + light grey pixels
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(row)), chunk('IEND', Buffer.alloc(0))]);
}

/** mkRoot({forge, rules}) -> a project root with the production rules (or `rules`) and the real web-ui lens. */
function mkRoot(opts) {
  opts = opts || {};
  const root = mk(TMP, 'p' + (++rootN));
  mk(root, '.claude', 'config', 'orchestration');
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), opts.rules ? JSON.stringify(opts.rules, null, 2) : fs.readFileSync(REAL_RULES));
  fs.copyFileSync(REAL_LENS, path.join(mk(root, '.claude', 'config', 'quality', 'lenses'), 'web-ui.json'));
  if (opts.forge) mk(root, '.forge');
  return root;
}
const runDirIn = (root, id) => (fs.existsSync(path.join(root, '.forge')) ? path.join(root, '.forge', 'runs', id) : path.join(root, '.claude', 'forge-runs', id));
const TS = '2026-10-24T12:00:00.000Z';
const BASE_EVENTS = [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: TS },
  { event_type: 'memory_loaded', agent: 'orchestrator', timestamp: TS },
];
function writeRun(root, id, opts) {
  opts = opts || {};
  const dir = mk(runDirIn(root, id));
  const events = (opts.events || BASE_EVENTS).concat(opts.extra || []);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(Object.assign({ complexity: 'L2' }, opts.run === undefined ? { deliverable_types: ['web-ui'] } : opts.run)));
  return dir;
}
/** writeEvidence(root, id) -> the record path: a complete web-ui record with real PNG files, built from the lens. */
function writeEvidence(root, id) {
  const req = V.requirementFor(root, 'web-ui');
  if (!req.ok) throw new Error('fixture lens: ' + req.problem);
  const shot = (rel, w) => { const abs = path.join(root, ...rel.split('/')); mk(path.dirname(abs)); fs.writeFileSync(abs, png(w)); return rel; };
  const viewports = {}, states = {};
  for (const vp of req.viewports) viewports[vp.id] = { width: vp.min_px, screenshots: [shot('docs/shots/' + id + '-home-' + vp.id + '.png', vp.min_px)], checked: 'nav, hero and footer at ' + vp.min_px + ' px, no sideways scroll' };
  for (const s of req.states) states[s] = { screenshots: [shot('docs/shots/' + id + '-home-state-' + s + '.png', 1280)], checked: 'the ' + s + ' message, its words and the next step' };
  const rec = { kind: V.RECORD_KIND, version: V.RECORD_VERSION, type: 'web-ui', served_from: 'http://localhost:3000', reviewer: 'UI Boss', views: [{ view: 'home', path: '/', viewports, states }] };
  const file = path.join(runDirIn(root, id), 'craft-evidence-web-ui.json');
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return { file, rec };
}
const chk = (root, id) => RC.check({ run_id: id }, { root, ownerProfilePath: NO_PROFILE });
const notJudged = (c) => !c.warnings.includes(ID) && !c.missing.includes(ID) && !c.satisfied.includes(ID);

try {
  console.log('forge-craft-evidence contract tests (rule ' + ID + '; hermetic root=' + TMP + ')');
  // ================================================================================================
  console.log('\nA) the registry entry');
  // ================================================================================================
  const rule = PROD.rules.find((r) => r.id === ID);
  {
    t('the rule is in the production registry: run-evidence craft-evidence, BLOCK (F13: restaurant-v5 shipped without a record and the contract still said OK), run-shape:web-ui-deliverable, phase complete, since 2026-10-24',
      !!rule && rule.check.type === 'run-evidence' && rule.check.evidence === 'craft-evidence' && rule.severity === 'block' && rule.trigger === 'run-shape:web-ui-deliverable' && rule.phase === 'complete' && rule.since === '2026-10-24');
    t('no agent exception and not cannot_override: only the owner_override path clears it', !!rule && rule.check.exception === undefined && rule.cannot_override === undefined && /owner_override/.test(rule.override));
    t('message {en, nl} and next_step name the forge-craft-evidence template / check commands', !!rule && /forge-craft-evidence\.cjs template --type web-ui/.test(rule.message.en) && /forge-craft-evidence\.cjs check --run <run_id>/.test(rule.message.nl) && /forge-craft-evidence\.cjs check --run <run_id> --type web-ui/.test(rule.next_step));
    const meta = RC.loadRulesMeta(REAL_RULES);
    t('this checker knows the shape and the evidence kind (nothing degraded)', !meta.unknownCheckTypes.length && !meta.unknownTriggers.length && RC.RUN_EVIDENCE_KINDS.has('craft-evidence') && RC.RUN_SHAPES.has('web-ui-deliverable'));
    const step2 = PROD.completion_sequence.find((s) => s.id === 'final-report');
    t('completion step 2 names the rule and the template / check commands', step2.rule_ids.includes(ID) && /forge-craft-evidence\.cjs template --type web-ui/.test(step2.produces) && /forge-craft-evidence\.cjs check --run <run_id>/.test(step2.produces));
  }

  // ================================================================================================
  console.log('\nB) the contract, legacy and .forge layout');
  // ================================================================================================
  for (const forge of [false, true]) {
    const L = forge ? '[.forge]' : '[legacy]';
    const root = mkRoot({ forge });
    writeRun(root, 'c-copy', { run: { deliverable_types: ['copy-and-content'] } });
    let c = chk(root, 'c-copy');
    t(L + ' a visible but non-web run (copy-and-content) -> the rule does not apply', notJudged(c) && c.run_shape.applies['visible-deliverable'] === true && c.run_shape.applies['web-ui-deliverable'] === false, JSON.stringify(c.run_shape));
    writeRun(root, 'c-dom', { run: { domain: 'website' } });
    c = chk(root, 'c-dom');
    t(L + ' a website domain without a declared type -> not applicable (never inferred from the domain)', notJudged(c) && c.run_shape.applies['web-ui-deliverable'] === false);

    writeRun(root, 'c-none');
    c = chk(root, 'c-none');
    const d = c.rule_details[ID] || {};
    t(L + ' web-ui run without a record -> MISSING, the run is not done (not a warning, not satisfied)', c.missing.includes(ID) && !c.warnings.includes(ID) && !c.satisfied.includes(ID) && c.ok === false, JSON.stringify({ w: c.warnings, m: c.missing }));
    t(L + ' its detail says why and fills the run id into next_step and message', /no evidence record/.test(d.reason || '') && /check --run c-none --type web-ui/.test(d.next_step || '') && /check --run c-none --type web-ui/.test((d.message || {}).en || ''), JSON.stringify(d));

    writeRun(root, 'c-ok');
    const ev = writeEvidence(root, 'c-ok');
    c = chk(root, 'c-ok');
    t(L + ' web-ui run with a complete record and real PNG files -> satisfied (clean)', c.satisfied.includes(ID) && !c.missing.includes(ID) && c.rule_details[ID].via === 'evidence' && /screenshot file\(s\) verified/.test(c.rule_details[ID].reason), JSON.stringify(c.rule_details[ID]));
    const one = ev.rec.views[0].viewports.mobile.screenshots[0];
    fs.rmSync(path.join(root, ...one.split('/')));
    c = chk(root, 'c-ok');
    t(L + ' the same record with one screenshot file missing -> missing again, naming the file', c.missing.includes(ID) && /does not exist/.test((c.rule_details[ID] || {}).reason || ''), JSON.stringify(c.rule_details[ID]));
  }

  // ================================================================================================
  console.log('\nC) exemptions, override, fail-closed');
  // ================================================================================================
  {
    const root = mkRoot();
    writeRun(root, 'c-old', { events: [{ event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-10-20T09:00:00.000Z' }] });
    const o = chk(root, 'c-old');
    t('a run that started before 2026-10-24 is historical_exempt', o.historical_exempt.some((x) => x.id === ID) && !o.missing.includes(ID));
    writeRun(root, 'c-own', { extra: [{ event_type: 'owner_override', rule: ID, reason: 'owner looked at the live preview on three devices', by: 'owner' }] });
    const w = chk(root, 'c-own');
    t('a valid owner_override clears it and is reported as overridden', w.overridden.some((x) => x.id === ID) && !w.missing.includes(ID), JSON.stringify(w.overridden));
    writeRun(root, 'c-agent', { extra: [{ event_type: 'owner_override', rule: ID, reason: 'ui boss says the screens are fine', by: 'ui-boss' }, { event_type: 'decision_logged', agent: 'orchestrator', rule: ID, decision: 'not-applicable', reason: 'screenshots were looked at in chat only' }] });
    t('an agent cannot excuse it: a non-owner override and a decision_logged exception do not count', chk(root, 'c-agent').missing.includes(ID));

    // fail-closed: the checker's soft require of forge-craft-evidence.cjs yields a module without checkRun/checkFile
    // (as a missing or broken helper does); the require cache entry is restored right after.
    writeRun(root, 'c-lone');
    writeEvidence(root, 'c-lone');
    const helperPath = require.resolve('./forge-craft-evidence.cjs');
    const saved = require.cache[helperPath];
    let l;
    try {
      require.cache[helperPath] = Object.assign(Object.create(Object.getPrototypeOf(saved)), saved, { exports: {} });
      l = chk(root, 'c-lone');
    } finally { require.cache[helperPath] = saved; }
    t('without a usable forge-craft-evidence.cjs a complete record is NOT satisfied (fail-closed, said out loud)', l.missing.includes(ID) && !l.satisfied.includes(ID) && /fail-closed/.test((l.rule_details[ID] || {}).reason || ''), JSON.stringify(l.rule_details[ID]));
    t('control: the real checker satisfies the same run', chk(root, 'c-lone').satisfied.includes(ID));
  }

  // ================================================================================================
  console.log('\nD) mutations (the assertions above bite)');
  // ================================================================================================
  {
    const noRule = JSON.parse(JSON.stringify(PROD));
    noRule.rules = noRule.rules.filter((r) => r.id !== ID);
    const root = mkRoot({ rules: noRule });
    writeRun(root, 'm-1');
    const c = chk(root, 'm-1');
    t('MUTANT rule removed: a web-ui run without a record blocks nothing -> the B missing test would fail', !c.missing.includes(ID) && !c.rule_details[ID]);
    const unknownKind = JSON.parse(JSON.stringify(PROD));
    unknownKind.rules.find((r) => r.id === ID).check.evidence = 'craft-evidences';
    const root2 = mkRoot({ rules: unknownKind });
    writeRun(root2, 'm-2');
    writeEvidence(root2, 'm-2');
    const meta = RC.loadRulesMeta(path.join(root2, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
    t('MUTANT evidence kind misspelt: degraded and never satisfied -> the B clean test would fail', meta.unknownCheckTypes.some((u) => u.id === ID) && !chk(root2, 'm-2').satisfied.includes(ID));
    const otherShape = JSON.parse(JSON.stringify(PROD));
    otherShape.rules.find((r) => r.id === ID).trigger = 'run-shape:visible-deliverable';
    const root3 = mkRoot({ rules: otherShape });
    writeRun(root3, 'm-3', { run: { deliverable_types: ['copy-and-content'] } });
    t('MUTANT trigger widened to visible-deliverable: the non-web run is blocked -> the B not-applicable test would fail', chk(root3, 'm-3').missing.includes(ID));
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
