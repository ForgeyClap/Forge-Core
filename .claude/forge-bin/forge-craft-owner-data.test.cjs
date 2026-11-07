#!/usr/bin/env node
'use strict';
/**
 * forge-craft-owner-data.test.cjs — category finding R2. The restaurant run could not close: block checks
 * that need data only the owner can give (real content, the client's facts, no placeholder copy, true claims) stayed a
 * block DEFECT although the site honestly labelled its sample data. Guard: those lens checks carry "owner_data": true; a
 * review may mark them WAITING_ON_OWNER, only with evidence of how the placeholder is labelled to the visitor; the run
 * contract lists such marks as a recorded, VISIBLE exception. WAITING_ON_OWNER on any other check stays a DEFECT.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

for (const k of ['FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'CLAUDE_PROJECT_DIR', 'FORGE_COMPLETION_GATE', 'FORGE_STRICT_EVENTS']) delete process.env[k];
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-craft-owner-')));
process.env.FORGE_CONFIG_HOME = path.join(TMP, 'cfg-home');
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });
const C = require('./forge-craft.cjs');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const SRC = path.join(__dirname, '..');
const LENS_SRC = path.join(SRC, 'config', 'quality', 'lenses');
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const lensOf = (type) => JSON.parse(fs.readFileSync(path.join(LENS_SRC, type + '.json'), 'utf8'));
const LABEL = 'Every sample dish and price carries a visible "Voorbeeld - nog niet definitief" badge, and the footer says the menu is a placeholder until the owner sends it.';
let n = 0;

function mkRoot() {
  const root = path.join(TMP, 'p' + (++n));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json'), path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const ld = path.join(root, '.claude', 'config', 'quality', 'lenses');
  fs.mkdirSync(ld, { recursive: true });
  for (const f of fs.readdirSync(LENS_SRC)) fs.copyFileSync(path.join(LENS_SRC, f), path.join(ld, f));
  return root;
}
function writeRun(root, id) {
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [{ event_type: 'run_started', agent: 'orchestrator' }, { event_type: 'memory_loaded', agent: 'orchestrator' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ deliverable_types: ['web-ui'] }));
}
function form(root, type, tweak) {
  const lines = [];
  if (C.main(['review-template', '--type', type, '--json', '--root', root], { out: (s) => lines.push(s), err: () => {} }) !== 0) throw new Error('template failed');
  const f = JSON.parse(lines.join('\n'));
  f.deliverable = 'Restaurant site (site/index.html)'; f.where = ['site/index.html']; f.reviewer = 'Review Boss';
  for (const l of f.lenses) {
    for (const q of l.first_ten_seconds) q.answer = 'Saw the hero, the menu and the booking button within ten seconds.';
    for (const s of l.stakeholders) {
      s.notice_in_10_seconds = 'The booking button is visible above the fold at 390px.';
      s.notice_on_closer_inspection = 'Every footer link resolves to a real page.';
      for (const c of s.checks) { c.mark = 'CLEAN'; c.evidence = 'artifacts/home-390.png read, plus 768 and 1440 px'; c.finding = 'nothing a ' + s.id + ' would notice'; }
    }
  }
  const byId = (id) => f.lenses.flatMap((l) => l.stakeholders.flatMap((s) => s.checks)).find((c) => c.id === id);
  if (tweak) tweak(byId, f);
  return f;
}
const waiting = (byId, id, evidence) => { const c = byId(id); c.mark = 'WAITING_ON_OWNER'; c.evidence = evidence; c.finding = 'the real menu and prices come from the owner'; };

console.log('forge-craft owner-data tests (hermetic root=' + TMP + ')');

// the lens data
const web = lensOf('web-ui'), copy = lensOf('copy-and-content');
const od = (l) => l.checks.filter((c) => c.owner_data === true).map((c) => c.id).sort().join(',');
t('web-ui marks real-content and facts-match-client as owner data', od(web) === 'facts-match-client,real-content', od(web));
t('copy-and-content marks claims-true and no-placeholder-copy as owner data', od(copy) === 'claims-true,no-placeholder-copy', od(copy));
t('every lens still validates', C.validateAll(SRC.replace(/[\\/]\.claude$/, '')).ok, JSON.stringify(C.validateAll(SRC.replace(/[\\/]\.claude$/, '')).lenses.filter((x) => !x.ok)));
const bad = JSON.parse(JSON.stringify(web)); bad.checks[0].owner_data = 'yes';
t('owner_data must be a boolean', !C.validateLens(bad, { type: 'web-ui' }).ok && C.validateLens(bad, { type: 'web-ui' }).problems.some((p) => /owner_data/.test(p)));
t('MARKS holds WAITING_ON_OWNER', C.MARKS.includes('WAITING_ON_OWNER'));

// the template documents it
const root = mkRoot();
const tpl = form(root, 'web-ui');
const tplCheck = tpl.lenses[0].stakeholders.flatMap((s) => s.checks);
t('the JSON template flags the owner-data checks', tplCheck.find((c) => c.id === 'real-content').owner_data === true && tplCheck.find((c) => c.id === 'contrast').owner_data === undefined);
t('the JSON template rules explain WAITING_ON_OWNER', tpl.rules.some((r) => /WAITING_ON_OWNER/.test(r) && /owner data/i.test(r)), JSON.stringify(tpl.rules));
const text = []; C.main(['review-template', '--type', 'web-ui', '--root', root], { out: (s) => text.push(s), err: () => {} });
t('the text template names the mark and tags the owner-data checks', /WAITING_ON_OWNER/.test(text.join('\n')) && /real-content \(block, owner data\)/.test(text.join('\n')), text.join('\n').slice(0, 400));

// record
writeRun(root, 'ok-run');
let rec = C.recordReview({ root, runId: 'ok-run', type: 'web-ui', form: form(root, 'web-ui', (b) => { waiting(b, 'real-content', LABEL); waiting(b, 'facts-match-client', LABEL); }), log: false });
t('WAITING_ON_OWNER on owner-data checks with label evidence: recorded', rec.code === 0, JSON.stringify(rec.problems));
t('... no unresolved block DEFECT, both listed as waiting on the owner', rec.code === 0 && rec.unresolved_block_defects.length === 0 && rec.summary.waiting_on_owner.map((w) => w.id).sort().join(',') === 'facts-match-client,real-content', JSON.stringify(rec.summary));
writeRun(root, 'no-ev');
rec = C.recordReview({ root, runId: 'no-ev', type: 'web-ui', form: form(root, 'web-ui', (b) => waiting(b, 'real-content', '')), log: false });
t('WAITING_ON_OWNER without evidence: refused, asking how the placeholder is labelled', rec.code === 3 && rec.problems.some((p) => /real-content/.test(p) && /labelled/.test(p)), JSON.stringify(rec.problems));
writeRun(root, 'non-od');
rec = C.recordReview({ root, runId: 'non-od', type: 'web-ui', form: form(root, 'web-ui', (b) => waiting(b, 'contrast', LABEL)), log: false });
t('WAITING_ON_OWNER on a non-owner-data check stays an unresolved block DEFECT', rec.code === 0 && rec.unresolved_block_defects.includes('contrast') && !rec.summary.waiting_on_owner.some((w) => w.id === 'contrast'), JSON.stringify(rec));
t('... and the record warns about it', (rec.warnings || []).some((w) => /contrast/.test(w) && /owner data/i.test(w)), JSON.stringify(rec.warnings));
const cr = C.checkRecorded({ root, runId: 'ok-run', type: 'web-ui' });
t('checkRecorded re-reads it valid with the waiting list', cr.valid && cr.unresolved_block_defects.length === 0 && cr.waiting_on_owner.length === 2, JSON.stringify(cr));

// the run contract
const chk = (id) => RC.check({ run_id: id }, { root, ownerProfilePath: NO_PROFILE });
let r = chk('ok-run');
const d = r.rule_details['craft-review-recorded'] || {};
t('contract: craft-review-recorded is met', r.satisfied.includes('craft-review-recorded'), JSON.stringify(d));
const ex = (r.exceptions || []).filter((x) => x.id === 'craft-review-recorded');
t('contract: the waiting marks are a recorded, visible exception with the type and check ids', ex.length === 1 && ex[0].decision === 'waiting-on-owner' && ex[0].deliverable_type === 'web-ui' && /real-content/.test(ex[0].reason) && /facts-match-client/.test(ex[0].reason) && /Voorbeeld/.test(ex[0].reason), JSON.stringify(ex));
t('contract: the reason says the checks wait on the owner', /waiting on the owner/i.test(d.reason), d.reason);
r = chk('non-od');
t('contract: WAITING_ON_OWNER on contrast keeps the rule MISSING as a block DEFECT', r.missing.includes('craft-review-recorded') && /unresolved block DEFECT\(s\): contrast/.test(r.rule_details['craft-review-recorded'].reason), r.rule_details['craft-review-recorded'].reason);
const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-runcontract.cjs'), 'check', '--run', 'ok-run', '--root', root], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_OWNER_PROFILE: NO_PROFILE }) });
t('CLI: the exception is printed as "exception (recorded, visible)"', /exception \(recorded, visible\): craft-review-recorded \[web-ui\]/.test(cli.stdout), cli.stdout.slice(-900) + cli.stderr.slice(-300));

// a lens that changed after recording still knows which checks are owner data (from the current lens file)
const lf = path.join(root, '.claude', 'config', 'quality', 'lenses', 'web-ui.json');
const lens = JSON.parse(fs.readFileSync(lf, 'utf8')); lens.covers += ' (edited later)'; fs.writeFileSync(lf, JSON.stringify(lens, null, 2));
const cr2 = C.checkRecorded({ root, runId: 'ok-run', type: 'web-ui' });
t('lens edited after recording: the waiting marks stay accepted', cr2.valid && cr2.unresolved_block_defects.length === 0 && cr2.waiting_on_owner.length === 2, JSON.stringify(cr2));
const lens2 = JSON.parse(fs.readFileSync(lf, 'utf8')); for (const c of lens2.checks) delete c.owner_data; fs.writeFileSync(lf, JSON.stringify(lens2, null, 2));
const cr3 = C.checkRecorded({ root, runId: 'ok-run', type: 'web-ui' });
t('... but a form that claims owner_data the lens no longer grants is not trusted (DEFECT)', cr3.unresolved_block_defects.includes('real-content'), JSON.stringify(cr3));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
