#!/usr/bin/env node
'use strict';
/** Tests for forge-intel-evals.cjs (modernization WP I.5). Hermetic: every CLI run gets a temp parent for the runner's own
 *  sandbox (FORGE_INTEL_EVALS_TMP), a PATH that holds ONLY a fake `claude` (so the real one is unreachable even by a bug)
 *  plus FORGE_INTEL_EVALS_CLAUDE pointing at a fake that writes a marker; any marker means a claude was started = FAIL.
 *  Sections: 1 schema (real file + mutants) · 2 offline run of every scenario (no claude, sandbox cleaned, nothing written
 *  into the project) · 3 determinism + stable JSON · 4 mutated scenario / gap / tool output detected · 5 hermetic vs
 *  --live-config · 6 live layer (dry run never spawns; liveRun with an injected spawn only, never a real or fake process) ·
 *  7 judge-pack, list, observe, baseline, metric (read-only forward), validate. Exit 0 = pass. */
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const E = require('./forge-intel-evals.cjs');
const CLI = path.join(__dirname, 'forge-intel-evals.cjs');
const REPO = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-intel-evals-test-'));
const SANDBOX_PARENT = path.join(TMP, 'sandbox-parent'), FAKE_BIN = path.join(TMP, 'fakebin'), MARKER = path.join(TMP, 'claude-was-started.txt');
for (const d of [SANDBOX_PARENT, FAKE_BIN]) fs.mkdirSync(d, { recursive: true });
const FAKE_JS = path.join(FAKE_BIN, 'fake-claude.cjs');
fs.writeFileSync(FAKE_JS, "require('fs').appendFileSync(" + JSON.stringify(MARKER) + ", 'started ' + process.argv.slice(2).join(' ') + '\\n'); process.stdout.write('{\"result\":\"fake\"}');\n");
fs.writeFileSync(path.join(FAKE_BIN, 'claude.cmd'), '@echo started>>"' + MARKER + '"\r\n');
fs.writeFileSync(path.join(FAKE_BIN, 'claude'), '#!/bin/sh\necho started >> "' + MARKER + '"\n', { mode: 0o755 });

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
function cliEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k) && !/^FORGE_(PROJECT_ROOT|CONFIG_HOME|ANTICIPATE_HOME|STATE_DIR|INTEL_EVALS_BIN)$/.test(k)) env[k] = v;
  return Object.assign(env, { PATH: FAKE_BIN, FORGE_INTEL_EVALS_TMP: SANDBOX_PARENT, FORGE_INTEL_EVALS_CLAUDE: FAKE_JS }, extra || {});
}
const run = (args, extra) => spawnSync(process.execPath, [CLI].concat(args), { cwd: REPO, encoding: 'utf8', timeout: 240000, env: cliEnv(extra), windowsHide: true });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const marker = () => fs.existsSync(MARKER);
const REAL = JSON.parse(fs.readFileSync(E.SCENARIOS_DEFAULT, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const writeTmp = (name, data) => { const p = path.join(TMP, name); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); return p; };
const scenario = (data, id) => data.scenarios.find((s) => s.id === id);
// (2.9c) the closed gaps moved into expect. (I.9) the last real gap (recipe-app/recipe-web-ui-lens) closed too. six
// new scenarios brought 13 new open gaps, which may close at any time. Tests that need a gap graft one onto a CLONE (never the
// real file), so they do not depend on which gaps happen to be open today: OPEN_GAP is a list gap whose `today` (absent) is
// what the tool really does for recipe-app.
const OPEN_SCENARIO = 'recipe-app';
const OPEN_GAP = 'grafted-open-lens';
const TOTAL_GAPS = REAL.scenarios.reduce((a, s) => a + (s.known_gaps || []).length, 0);
const graft = (d, id, gap, dropExpect) => { const s = scenario(d, id); s.known_gaps = (s.known_gaps || []).concat(Object.assign({ cause: 'test-graft', tool: 'forge-anticipate.cjs', note: 'grafted by the test onto a clone of the scenario file' }, gap)); if (dropExpect) dropExpect(s.expect); return d; };
const withOpenGap = (d) => graft(d, OPEN_SCENARIO, { id: OPEN_GAP, tool: 'forge-craft.cjs', field: 'craft_lens_types', item: 'voice-and-chat', today: 'absent', professional: 'present' });
const openFile = (name) => writeTmp(name || 'open-gap.json', withOpenGap(clone(REAL)));
console.log('forge-intel-evals tests (tmp=' + TMP + ')');

// ---- 1) schema ----
console.log('1) schema');
const R = E.refs();
const P0 = E.schemaProblems(REAL, R);
t('the real scenario file is valid', P0.length === 0, P0.join(' | '));
t('42 scenarios (36 + 6 of WP-E1), unique ids', REAL.scenarios.length === 42 && new Set(REAL.scenarios.map((s) => s.id)).size === 42);
t('six trap scenarios on the owner\'s real pains', REAL.scenarios.filter((s) => s.id.startsWith('trap-')).length === 6);
const kinds = new Set(REAL.scenarios.flatMap((s) => s.traps.map((x) => x.split(':')[0])));
t('every trap kind is covered', Object.keys(E.TRAP_KINDS).every((k) => kinds.has(k)), [...kinds].join(','));
t('both languages are covered (at least 8 Dutch scenarios)', REAL.scenarios.filter((s) => s.language === 'nl').length >= 8 && REAL.scenarios.some((s) => s.language === 'en'));
t('every known gap names a root cause and the tool responsible', REAL.scenarios.every((s) => (s.known_gaps || []).every((g) => g.cause && g.tool)));
const mutants = [
  ['a duplicate id', (d) => { d.scenarios[1].id = d.scenarios[0].id; }, /used twice/],
  ['an unsupported language', (d) => { d.scenarios[0].language = 'de'; }, /language must be nl or en/],
  ['a SAFE switch listed as gated', (d) => { d.scenarios[0].expect.gated_queued = ['screenshot-loop']; }, /not an OWNER-GATED entry/],
  ['an OWNER-GATED switch listed as safe', (d) => { d.scenarios[0].expect.safe_switches_planned.push('deploy'); }, /not a SAFE entry/],
  ['an unknown expect field', (d) => { d.scenarios[0].expect.vibes = true; }, /not an expect field/],
  ['a rubric of two items', (d) => { d.scenarios[0].rubric = d.scenarios[0].rubric.slice(0, 2); }, /rubric needs 3-6/],
  ['a gap whose today equals professional', (d) => { const g = scenario(withOpenGap(d), OPEN_SCENARIO).known_gaps[0]; g.professional = g.today; }, /must be present\/absent and differ/],
  ['a gap that is also asserted in expect', (d) => { scenario(withOpenGap(d), OPEN_SCENARIO).expect.craft_lens_types.push('voice-and-chat'); }, /either expected or a gap/],
  ['a gap whose item is also in the negative twin (not_craft_lens_types)', (d) => { scenario(withOpenGap(d), OPEN_SCENARIO).expect.not_craft_lens_types = ['voice-and-chat']; }, /either expected or a gap/],
  ['a required field left out without a gap', (d) => { delete d.scenarios[0].expect.gate_card; }, /expect\.gate_card is missing/],
  ['a gap without a cause', (d) => { delete scenario(withOpenGap(d), OPEN_SCENARIO).known_gaps[0].cause; }, /cause must be a slug/],
  ['an item in skills and not_skills at once', (d) => { scenario(d, 'game-server-monitor').expect.skills.push('forge-game'); }, /both in skills and not_skills/],
  ['an unknown skill in not_skills', (d) => { scenario(d, 'game-server-monitor').expect.not_skills.push('forge-nonsense'); }, /not_skills "forge-nonsense" is not a known skill/],
  ['an unknown lens in not_craft_lens_types', (d) => { scenario(d, 'game-server-monitor').expect.not_craft_lens_types.push('vibe-check'); }, /not a craft lens type/],
  ['an anticipate_domain that is no slug', (d) => { scenario(d, 'telegram-support-bot').expect.anticipate_domain = 'Bots!'; }, /anticipate_domain must be a domain slug or null/],
  ['an anticipate_domain gap while expect asserts it', (d) => { graft(d, 'telegram-support-bot', { id: 'g1', field: 'anticipate_domain', today: 'ecommerce', professional: 'bots' }); }, /anticipate_domain is asserted in expect too/],
  ['a scenario without an id (String(undefined) is no slug)', (d) => { delete d.scenarios[0].id; }, /id must be a slug/],
  ['a scenario without a project_type', (d) => { delete d.scenarios[0].project_type; }, /project_type must be a slug/],
  ['a request with a line break', (d) => { d.scenarios[0].request += '\nsecond line'; }, /one realistic owner sentence/],
  ['a trap of an unknown kind', (d) => { d.scenarios[0].traps.push('lazy: something'); }, /known kind/],
  ['an unknown lens type', (d) => { d.scenarios[0].expect.craft_lens_types.push('vibe-check'); }, /not a craft lens type/],
  ['fewer than 30 scenarios', (d) => { d.scenarios = d.scenarios.slice(0, 20); }, /at least 30 scenarios/],
];
for (const [name, mut, re] of mutants) { const d = clone(REAL); mut(d); const p = E.schemaProblems(d, R); t('schema rejects ' + name, p.some((x) => re.test(x)), p.join(' | ') || 'no problem reported'); }

// ---- 2) offline run of every scenario ----
console.log('2) offline structural run');
const projectTypes = [...new Set(REAL.scenarios.map((s) => s.project_type))];
const researchDir = path.join(REPO, '.claude', 'forge-research', 'discovery');
const preexisting = projectTypes.filter((p) => fs.existsSync(path.join(researchDir, p)));
const r1 = run(['run', '--json']);
const j1 = json(r1);
t('run --json exits 0 (no FAIL)', r1.status === 0, r1.stderr + ' ' + (j1 ? JSON.stringify(j1.summary) : r1.stdout.slice(0, 400)));
t('the summary covers all 42 scenarios with 0 FAIL', !!j1 && j1.summary.scenarios === 42 && j1.summary.FAIL === 0 && j1.summary.PASS + j1.summary['KNOWN-GAP'] === 42);
t('every scenario ran every tool call successfully', !!j1 && j1.results.every((x) => !x.failures.some((f) => f.field === 'tool-call')));
t('every expect check passed', !!j1 && j1.results.every((x) => x.checks.passed === x.checks.total && x.checks.total >= 7));
t('every known gap is still open (none drifted, none silently closed: a closed gap belongs in expect)', !!j1 && j1.summary.gaps.drift === 0 && j1.summary.gaps.closed === 0 && j1.summary.gaps.open === TOTAL_GAPS, j1 && JSON.stringify(j1.summary.gaps));
t('all 42 scenarios PASS (I.5: 11/36, 2.9c: 35/36, I.9: 36/36, E1: 38/42, I.10: 42/42), never a FAIL', !!j1 && j1.summary.PASS === 42 && j1.summary['KNOWN-GAP'] === 0, j1 && j1.summary.intelligence_bar);
t('(I.10) the four WP-E1 findings were closed in the tools and moved into expect: PASS with no known gap left', !!j1 && ['gym-churn-model', 'investor-pitch-deck', 'postgres-migration', 'orders-mcp-server'].every((id) => {
  const r = j1.results.find((x) => x.id === id); return r && r.status === 'PASS' && !(scenario(REAL, id).known_gaps || []).length; })
  && scenario(REAL, 'orders-mcp-server').expect.domain.best === 'agent' && scenario(REAL, 'postgres-migration').expect.not_craft_lens_types.includes('documents-and-spreadsheets'));
t('(WP-E1) the offline reliability is labelled deterministic: pass@k = pass^k = the PASS rate', !!j1 && j1.reliability.mode === 'deterministic' && /pass@k = pass\^k = pass/.test(j1.reliability.note)
  && j1.reliability.pass_at_k === j1.reliability.pass_hat_k && j1.reliability.pass_at_k === Math.round((42 / 42) * 1e6) / 1e6, j1 && JSON.stringify(j1.reliability));
t('(I.9) recipe-app gets the web-ui lens from "app where people can" while its type stays UNKNOWN with the generic gate card', !!j1 && (() => { const r = j1.results.find((x) => x.id === 'recipe-app'), e = scenario(REAL, 'recipe-app').expect; return r && r.status === 'PASS' && e.craft_lens_types.includes('web-ui') && e.domain.verdict === 'UNKNOWN' && e.gate_card === 'generic' && !(scenario(REAL, 'recipe-app').known_gaps || []).length; })());
t('the craft plan gets the request text (--text, as the Lead passes it): an UNKNOWN newsletter gets the copy lens', !!j1 && (() => { const r = j1.results.find((x) => x.id === 'church-newsletter'); return r && r.status === 'PASS' && scenario(REAL, 'church-newsletter').expect.craft_lens_types.includes('copy-and-content'); })());
t('mode is hermetic and no tool override is active', !!j1 && j1.mode === 'hermetic' && j1.overrides.length === 0);
t('no claude process was started (fake marker absent)', !marker());
t('the runner removed its own sandbox (temp parent is empty)', fs.readdirSync(SANDBOX_PARENT).length === 0, fs.readdirSync(SANDBOX_PARENT).join(','));
t('the discovery briefs went to the sandbox, not into the project', projectTypes.filter((p) => fs.existsSync(path.join(researchDir, p))).every((p) => preexisting.includes(p)));
t('the output never leaks the temp paths', !r1.stdout.includes(SANDBOX_PARENT) && !r1.stdout.includes(E.TMP_PREFIX));

// ---- 3) determinism ----
console.log('3) determinism');
const r2 = run(['run', '--json']);
t('a second run prints byte-identical JSON', r2.status === 0 && r2.stdout === r1.stdout);
const ids1 = j1 ? j1.results.map((x) => x.id) : [];
t('results keep the scenario order', JSON.stringify(ids1) === JSON.stringify(REAL.scenarios.map((s) => s.id)));
const rText = run(['run']);
t('the text table names every scenario and the score line', rText.status === 0 && REAL.scenarios.every((s) => rText.stdout.includes(s.id)) && /Score: 42 scenarios/.test(rText.stdout) && /root cause/.test(rText.stdout));
t('the text table says the offline reliability is deterministic', /reliability: deterministic: pass@k = pass\^k = pass = 42\/42/.test(rText.stdout));

// ---- 4) mutations are detected ----
console.log('4) mutations are detected');
{
  const d = clone(REAL); scenario(d, 'dental-clinic-website').expect.domain = { verdict: 'KNOWN', best: 'game' };
  const r = run(['run', '--only', 'dental-clinic-website', '--json', '--scenarios', writeTmp('wrong-domain.json', d)]), j = json(r);
  t('a wrong expected domain fails (exit 3, FAIL on domain)', r.status === 3 && !!j && j.results[0].status === 'FAIL' && j.results[0].failures.some((f) => f.field === 'domain'), r.stdout.slice(0, 300));
}
{
  const d = clone(REAL); scenario(d, 'dental-clinic-website').expect.safe_switches_planned.push('lane-watchdog'); scenario(d, 'dental-clinic-website').expect.not_planned = ['forge-prd'];
  const r = run(['run', '--only', 'dental-clinic-website', '--json', '--scenarios', writeTmp('wrong-switch.json', d)]), j = json(r);
  t('an expected switch the tool does not plan fails', r.status === 3 && !!j && j.results[0].failures.some((f) => f.field === 'safe_switches_planned' && f.item === 'lane-watchdog'));
}
{ // the grafted open gap is a list gap (present/absent), which cannot drift while it is observed; a scalar gap is grafted
  // onto the same scenario: its today ('domain') and professional ('provisional') both differ from what the tool says (generic)
  const d = graft(withOpenGap(clone(REAL)), OPEN_SCENARIO, { id: 'grafted-gate-card', tool: 'forge-quality.cjs', field: 'gate_card', today: 'domain', professional: 'provisional' }, (e) => { delete e.gate_card; });
  const r = run(['run', '--only', OPEN_SCENARIO, '--json', '--scenarios', writeTmp('drift.json', d)]), j = json(r);
  t('a gap whose today no longer matches drifts and fails', r.status === 3 && !!j && j.results[0].status === 'FAIL' && j.results[0].gaps.some((x) => x.id === 'grafted-gate-card' && x.state === 'DRIFT') && j.results[0].gaps.some((x) => x.id === OPEN_GAP && x.state === 'OPEN'), r.stdout.slice(0, 400));
}
{ // the open gap itself: flip it, so what the tool does today is the "professional" side -> CLOSED, reported
  const d = withOpenGap(clone(REAL)); const g = scenario(d, OPEN_SCENARIO).known_gaps.find((x) => x.id === OPEN_GAP); g.today = 'present'; g.professional = 'absent';
  const r = run(['run', '--only', OPEN_SCENARIO, '--json', '--scenarios', writeTmp('closed.json', d)]), j = json(r);
  t('a gap whose professional behaviour is observed counts as CLOSED (PASS, reported)', r.status === 0 && !!j && j.results[0].status === 'PASS' && j.summary.gaps.closed === 1 && j.summary.gaps.open === 0, r.stdout.slice(0, 400));
  const rt = run(['run', '--only', OPEN_SCENARIO, '--scenarios', writeTmp('closed.json', d)]);
  t('the text table tells the author to move a closed gap into expect', rt.status === 0 && new RegExp('Closed gaps \\(the tool now behaves professionally: move them into expect\\): recipe-app/' + OPEN_GAP).test(rt.stdout));
}
{
  const r = run(['run', '--only', OPEN_SCENARIO, '--json', '--scenarios', openFile()]), j = json(r);
  t('an open gap is a KNOWN-GAP, not a FAIL (exit 0): a finding stays visible without failing the run', r.status === 0 && !!j && j.results[0].status === 'KNOWN-GAP' && j.results[0].gaps.length === 1 && j.results[0].gaps[0].state === 'OPEN');
}
const OVR = path.join(TMP, 'override');
fs.mkdirSync(OVR, { recursive: true });
const wrapper = (tool, transform) => "const {spawnSync}=require('child_process');const r=spawnSync(process.execPath,[" + JSON.stringify(path.join(__dirname, tool)) + "].concat(process.argv.slice(2)),{encoding:'utf8'});"
  + "let o=r.stdout;try{const j=JSON.parse(o);" + transform + "o=JSON.stringify(j);}catch(e){}process.stdout.write(o);process.stderr.write(r.stderr||'');process.exitCode=r.status;";
fs.writeFileSync(path.join(OVR, 'forge-domain-discovery.cjs'), wrapper('forge-domain-discovery.cjs', "if(j.verdict){j.verdict='KNOWN';j.best='game';}"));
{
  const r = run(['run', '--only', 'dental-clinic-website', '--json'], { FORGE_INTEL_EVALS_BIN: OVR }), j = json(r);
  t('a mutated classify output is detected (FAIL on domain)', r.status === 3 && !!j && j.results[0].failures.some((f) => f.field === 'domain'), r.stdout.slice(0, 300));
  t('a run with a tool override says so (never a baseline)', !!j && j.overrides.includes('forge-domain-discovery.cjs'));
  const rt = run(['run', '--only', 'dental-clinic-website'], { FORGE_INTEL_EVALS_BIN: OVR });
  t('the text table warns TOOL OVERRIDE ACTIVE', /TOOL OVERRIDE ACTIVE/.test(rt.stdout));
}
fs.unlinkSync(path.join(OVR, 'forge-domain-discovery.cjs'));
fs.writeFileSync(path.join(OVR, 'forge-anticipate.cjs'), wrapper('forge-anticipate.cjs', "if(Array.isArray(j.safe_to_enable))j.safe_to_enable.push({id:'deploy',kind:'tool',label:'deploy'});"));
{
  const r = run(['run', '--only', 'trap-deploy-production', '--json'], { FORGE_INTEL_EVALS_BIN: OVR }), j = json(r);
  t('an owner-gated action that is auto-enabled is caught (must_not_auto_enable)', r.status === 3 && !!j && j.results[0].failures.some((f) => f.field === 'must_not_auto_enable' && f.item === 'deploy'));
}
{ // (2.9c) the checks that replaced closed gaps really guard: a regressed anticipation domain, a force-fit playbook, a force-fit lens
  fs.writeFileSync(path.join(OVR, 'forge-anticipate.cjs'), wrapper('forge-anticipate.cjs', "if(j.signals)j.signals.primary_domain='ecommerce';if(Array.isArray(j.skills_to_use))j.skills_to_use.push('forge-game');"));
  const ra = run(['run', '--only', 'telegram-support-bot,game-server-monitor', '--json'], { FORGE_INTEL_EVALS_BIN: OVR }), ja = json(ra);
  const fa = (id, field, item) => !!ja && ja.results.find((x) => x.id === id).failures.some((f) => f.field === field && (item === undefined || f.item === item));
  t('a regressed anticipation domain (a support bot planned as a webshop again) fails on expect.anticipate_domain', ra.status === 3 && fa('telegram-support-bot', 'anticipate_domain'), ra.stdout.slice(0, 400));
  t('a force-fit playbook (the game playbook for a server monitor) fails on expect.not_skills', fa('game-server-monitor', 'not_skills', 'forge-game'));
  fs.unlinkSync(path.join(OVR, 'forge-anticipate.cjs'));
  fs.writeFileSync(path.join(OVR, 'forge-craft.cjs'), wrapper('forge-craft.cjs', "if(Array.isArray(j.deliverables))j.deliverables.push('game-and-interactive');"));
  const rc = run(['run', '--only', 'game-server-monitor', '--json'], { FORGE_INTEL_EVALS_BIN: OVR }), jc = json(rc);
  t('a force-fit lens (the player lens for a server monitor) fails on expect.not_craft_lens_types', rc.status === 3 && !!jc && jc.results[0].failures.some((f) => f.field === 'not_craft_lens_types' && f.item === 'game-and-interactive'));
  fs.writeFileSync(path.join(OVR, 'forge-craft.cjs'), 'process.stderr.write("boom");process.exitCode=1;');
  const rx = run(['run', '--only', OPEN_SCENARIO, '--json', '--scenarios', openFile('open-gap-crash.json')], { FORGE_INTEL_EVALS_BIN: OVR }), jx = json(rx);
  t('a crashing craft tool turns the open lens gap into DRIFT (never OPEN or CLOSED on a missing observation)', rx.status === 3 && !!jx && jx.results[0].gaps.some((g) => g.id === OPEN_GAP && g.state === 'DRIFT'));
  fs.unlinkSync(path.join(OVR, 'forge-craft.cjs'));
}
fs.writeFileSync(path.join(OVR, 'forge-anticipate.cjs'), 'process.stderr.write("boom");process.exitCode=1;');
{ // a gap whose professional side is "absent" is what an empty plan looks like; it is grafted onto a clone (the real file has none)
  const d = graft(clone(REAL), 'cli-log-parser', { id: 'grafted-absent', field: 'safe_switches_planned', item: 'frontend-design', today: 'present', professional: 'absent' });
  const r = run(['run', '--only', 'cli-log-parser', '--json', '--scenarios', writeTmp('crash-gap.json', d)], { FORGE_INTEL_EVALS_BIN: OVR }), j = json(r);
  t('a crashing tool is a FAIL with the tool-call named', r.status === 3 && !!j && j.results[0].failures.some((f) => f.field === 'tool-call' && f.item === 'anticipate'));
  t('a crashing anticipation never makes a gap look closed', !!j && j.results[0].gaps.length === 1 && j.results[0].gaps.every((g) => g.state !== 'CLOSED'), j && JSON.stringify(j.results[0].gaps));
}
fs.unlinkSync(path.join(OVR, 'forge-anticipate.cjs'));
t('still no claude process started after the mutation runs', !marker());

// ---- 5) hermetic vs --live-config ----
console.log('5) hermetic vs --live-config');
const CFG_OFF = path.join(TMP, 'cfg-off');
fs.mkdirSync(CFG_OFF, { recursive: true });
fs.writeFileSync(path.join(CFG_OFF, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { anticipate: { value: false } } }));
{ // the I.5 gap "opening hours plan a long run" (proactive-status present -> absent) is grafted back onto a clone: an empty
  // plan (anticipation off) must never make it look closed, while the hermetic run (the tool fixed in I.8b) does close it
  const d = graft(clone(REAL), 'dental-clinic-website', { id: 'opening-hours-long-run', field: 'safe_switches_planned', item: 'proactive-status', today: 'present', professional: 'absent' },
    (e) => { e.not_planned = e.not_planned.filter((x) => x !== 'proactive-status'); });
  const f = writeTmp('dental-gap.json', d);
  const rh = run(['run', '--only', 'dental-clinic-website', '--json', '--scenarios', f], { FORGE_CONFIG_HOME: CFG_OFF }), jh = json(rh);
  t('hermetic mode ignores an owner config that switches anticipation off', rh.status === 0 && !!jh && jh.summary.gaps.closed === 1);
  const rl = run(['run', '--only', 'dental-clinic-website', '--json', '--live-config', '--scenarios', f], { FORGE_CONFIG_HOME: CFG_OFF }), jl = json(rl);
  t('--live-config uses it and fails honestly (anticipate-enabled), labelled live-config', rl.status === 3 && !!jl && jl.mode === 'live-config' && jl.results[0].failures.some((f2) => f2.field === 'anticipate-enabled'));
  t('with anticipation off no gap is reported as closed', !!jl && jl.summary.gaps.closed === 0 && jl.results[0].gaps.some((g) => g.id === 'opening-hours-long-run' && g.state === 'DRIFT'));
}

// ---- 6) live layer ----
console.log('6) live layer (never started here)');
{
  const r = run(['live']);
  t('live without --yes is a dry run (exit 0) and starts nothing', r.status === 0 && /DRY RUN/.test(r.stdout) && !marker());
  t('the dry run states the per-scenario budget cap, wall clock and read-only mode', /--max-budget-usd 0\.5/.test(r.stdout) && /--permission-mode plan/.test(r.stdout) && /wall clock <= 300 s/.test(r.stdout) && /--no-session-persistence/.test(r.stdout));
  t('the dry run gives an honest cost note and the owner-only command', /42 x \$0\.5 = \$21\.00/.test(r.stdout) && /live --yes/.test(r.stdout) && /YOUR account/.test(r.stdout));
  const r2l = run(['live', '--dry-run', '--only', 'trap-six-part-build', '--budget-usd', '1', '--timeout-sec', '120']);
  t('live --dry-run with options starts nothing either', r2l.status === 0 && /1 separate claude -p/.test(r2l.stdout) && /--max-budget-usd 1 /.test(r2l.stdout) && !marker());
  t('--yes and --dry-run together are a usage error', run(['live', '--yes', '--dry-run']).status === 2 && !marker());
}
{
  const lo = E.parseLiveOpts({});
  t('live defaults: budget 0.5 USD, 300 s, no --yes', lo.budget === 0.5 && lo.timeoutSec === 300 && lo.yes === false && !lo.problems.length);
  t('a budget above the hard cap is refused', E.parseLiveOpts({ 'budget-usd': '50' }).problems.length === 1);
  t('a non-numeric timeout is refused', E.parseLiveOpts({ 'timeout-sec': 'abc' }).problems.length === 1);
  t('a timeout above the hard cap is refused', E.parseLiveOpts({ 'timeout-sec': '99999' }).problems.length === 1);
}
{ // liveRun with an INJECTED spawn: no process of any kind is started
  const calls = [], dir = path.join(TMP, 'runs', '_evals');
  const two = [scenario(REAL, 'dental-clinic-website'), scenario(REAL, 'cli-log-parser')];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return calls.length === 1 ? { status: 0, stdout: JSON.stringify({ type: 'result', result: 'Plan: ... the patient ...', is_error: false, total_cost_usd: 0.12, session_id: 'x', usage: { input_tokens: 5 } }) } : { status: 1, stdout: 'not json', error: null }; };
  const res = E.liveRun(two, { budget: 0.5, timeoutSec: 300, claude: 'claude', dir, spawn: fakeSpawn });
  t('liveRun starts one session per scenario, one after the other', calls.length === 2 && calls[0].opts.input.includes(two[0].request) && calls[1].opts.input.includes(two[1].request));
  const a = calls[0].args;
  t('each session is print mode, JSON, no persistence, plan mode, write tools denied, budget-capped', a[0] === '-p' && a.join(' ').includes('--output-format json') && a.includes('--no-session-persistence') && a.join(' ').includes('--permission-mode plan') && a.join(' ').includes('--disallowedTools ' + E.LIVE_DENY) && a.join(' ').includes('--max-budget-usd 0.5'));
  t('each session has a bounded wall clock, runs in the project root and keeps the eval out of the scribe', calls[0].opts.timeout === 300000 && calls[0].opts.cwd === REPO && calls[0].opts.env.FORGE_SCRIBE_HOOK === 'off');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'dental-clinic-website.json'), 'utf8'));
  t('only the final message is stored (no transcript, usage or session id)', stored.final_message === 'Plan: ... the patient ...' && !('usage' in stored) && !('session_id' in stored) && !JSON.stringify(stored).includes('input_tokens') && stored.reported_cost_usd === 0.12);
  const bad = JSON.parse(fs.readFileSync(path.join(dir, 'cli-log-parser.json'), 'utf8'));
  t('an unparseable answer stores no raw output and counts as an error (exit 3)', bad.final_message === null && bad.is_error === true && !JSON.stringify(bad).includes('not json') && res.code === 3);
  const js = []; E.liveRun([two[0]], { budget: 0.5, timeoutSec: 10, claude: path.join(TMP, 'x.cjs'), dir, spawn: (c, args) => { js.push({ c, args }); return { status: 0, stdout: '{"result":"ok"}' }; } });
  t('a .cjs claude path runs under node (the seam the tests use)', js[0].c === process.execPath && js[0].args[0] === path.join(TMP, 'x.cjs'));
  t('the live prompt carries the request and gives no hints about the rubric', E.livePrompt(two[0]).includes(two[0].request) && !/stakeholder|switch|rubric/i.test(E.livePrompt(two[0])));
}

// ---- 7) other commands ----
console.log('7) judge-pack, list, observe, baseline, metric, validate');
{
  const sc = scenario(REAL, 'church-newsletter');
  const r = run(['judge-pack', '--only', 'church-newsletter']);
  t('judge-pack prints a self-contained prompt with the request and every rubric item', r.status === 0 && r.stdout.includes(sc.request) && sc.rubric.every((x) => r.stdout.includes(x)) && /Answer format/.test(r.stdout) && !marker());
  const f = writeTmp('live-result.json', { kind: 'forge-intel-eval-live', final_message: 'Ik maak een concept; versturen wacht op jou.' });
  t('judge-pack embeds a stored live answer between markers', /<<<\nIk maak een concept; versturen wacht op jou\.\n>>>/.test(E.judgePack(sc, f)));
  t('judge-pack needs exactly one id', run(['judge-pack']).status === 2);
}
{
  const r = run(['list', '--json']), j = json(r);
  t('list --json gives 42 entries with counts', r.status === 0 && Array.isArray(j) && j.length === 42 && j.every((x) => x.rubric >= 3));
  t('list --json is stable', run(['list', '--json']).stdout === r.stdout);
  t('an unknown --only id is a usage error', run(['run', '--only', 'no-such-scenario']).status === 2);
  t('an unknown argument is a usage error', run(['run', '--fast']).status === 2);
}
{
  const r = run(['observe', '--only', 'trap-unknown-project-type']), j = json(r);
  t('observe prints the raw observation (no force-fit: UNKNOWN, generic card, provisional brief, no playbook)', r.status === 0 && !!j && j.domain.verdict === 'UNKNOWN' && j.gate_card === 'generic' && j.provisional_discovery === true && !j.skills.some((s) => /^forge-(?!craft)/.test(s)));
}
{
  const r = run(['baseline']);
  t('baseline prints the Markdown score table, the root causes and every gap', r.status === 0 && /^\| # \| scenario/m.test(r.stdout) && /\| root cause \| tool \|/.test(r.stdout) && REAL.scenarios.every((s) => r.stdout.includes('| ' + s.id + ' |')));
}
{
  const proj = path.join(TMP, 'metric-proj'), led = path.join(proj, '.claude', 'forge-scribe', 'ledger.jsonl');
  fs.mkdirSync(path.dirname(led), { recursive: true });
  fs.writeFileSync(led, JSON.stringify({ seq: 1, rid: 'R-0001', class: 'toggle-correction', run_id: 'run-a', ts: '2026-10-20T10:00:00Z' }) + '\n' + JSON.stringify({ seq: 2, rid: 'R-0002', class: 'new', ts: '2026-10-21T10:00:00Z' }) + '\n');
  const before = crypto.createHash('sha256').update(fs.readFileSync(led)).digest('hex');
  const r = run(['metric', '--json', '--root', proj]), j = json(r);
  const direct = spawnSync(process.execPath, [path.join(__dirname, 'forge-anticipate.cjs'), 'metric', '--root', proj, '--json'], { encoding: 'utf8' });
  t('metric forwards to forge-anticipate metric (same JSON, exit 0)', r.status === 0 && !!j && j.available === true && j.total === 1 && r.stdout === direct.stdout);
  t('metric is read-only (the ledger is unchanged)', crypto.createHash('sha256').update(fs.readFileSync(led)).digest('hex') === before);
}
{
  const r = run(['validate', '--json']), j = json(r);
  t('validate runs every scenario\'s tool calls and all exit as expected', r.status === 0 && !!j && j.ok === true && j.scenarios === 42 && j.tool_calls >= 180);
  const bad = clone(REAL); bad.scenarios[0].language = 'xx';
  t('validate exits 3 on an invalid file', run(['validate', '--scenarios', writeTmp('invalid.json', bad)]).status === 3);
  t('validate exits 3 on an unreadable file', run(['validate', '--scenarios', writeTmp('broken.json', '{ not json')]).status === 3);
}
// ---- 8) reliability metrics and the regression baseline ----
console.log('8) pass@k / pass^k maths and the regression baseline');
{ // hand-computed: pass@k = 1 - C(n-c,k)/C(n,k), pass^k = C(c,k)/C(n,k)
  const cases = [
    ['k=1 is the pass rate (n=4, c=1)', 4, 1, 1, 0.25, 0.25],
    ['all pass (n=5, c=5, k=3)', 5, 5, 3, 1, 1],
    ['all fail (n=5, c=0, k=3)', 5, 0, 3, 0, 0],
    ['mixed (n=5, c=2, k=2): 1 - 3/10 and 1/10', 5, 2, 2, 0.7, 0.1],
    ['mixed (n=10, c=3, k=3): 1 - 35/120 and 1/120', 10, 3, 3, 0.708333, 0.008333],
    ['k = n with one fail (n=3, c=2, k=3)', 3, 2, 3, 1, 0],
  ];
  for (const [name, n, c, k, at, hat] of cases) t('maths: ' + name, E.passAtK(n, c, k) === at && E.passHatK(n, c, k) === hat, E.passAtK(n, c, k) + ' / ' + E.passHatK(n, c, k));
  t('maths: k above n has no value (null), never a guess', E.passAtK(2, 1, 3) === null && E.passHatK(2, 1, 3) === null);
  let threw = 0; for (const a of [[0, 0, 1], [3, 4, 1], [3, 1, 0], [3, 1.5, 1]]) { try { E.passAtK(...a); } catch (e) { if (e instanceof RangeError) threw++; } }
  t('maths: impossible inputs are refused (n 0, c above n, k 0, a fraction)', threw === 4);
  const runs = [{ scenario: 'a', attempt: 1, pass: true }, { scenario: 'a', attempt: 2, pass: false }, { scenario: 'a', attempt: 3, pass: true }, { scenario: 'b', attempt: 1, pass: false }, { scenario: 'b', attempt: 2, pass: false }];
  const r2k = E.reliability(runs, { order: ['b', 'a'] });
  t('reliability: k defaults to the fewest attempts (2) and keeps the scenario-file order', r2k.k === 2 && r2k.scenarios.map((s) => s.scenario).join() === 'b,a');
  const a = r2k.scenarios.find((s) => s.scenario === 'a');
  t('reliability: a 2-of-3 scenario at k=2 has pass@2 1 and pass^2 1/3; the mean over both is 0.5 and 1/6', a.pass_at_k === 1 && a.pass_hat_k === 0.333333 && r2k.mean_pass_at_k === 0.5 && r2k.mean_pass_hat_k === 0.166667, JSON.stringify(r2k));
  const r3k = E.reliability(runs, { k: 3 });
  t('reliability: a scenario with fewer than k attempts is left out and named', r3k.scored === 1 && r3k.too_few_attempts.join() === 'b' && r3k.mean_pass_at_k === 1 && r3k.mean_pass_hat_k === 0);
  const known = new Set(['a', 'b']);
  const bad = (rs, re) => E.runsProblems({ runs: rs }, known).some((p) => re.test(p));
  t('runs file: a duplicate attempt is refused', bad([runs[0], runs[0]], /listed twice/));
  t('runs file: a non-boolean pass, attempt 0 and an unknown scenario are refused', bad([{ scenario: 'a', attempt: 1, pass: 'yes' }], /pass must be/) && bad([{ scenario: 'a', attempt: 0, pass: true }], /attempt must be/) && bad([{ scenario: 'zz', attempt: 1, pass: true }], /not in the scenario file/));
  t('runs file: an empty list is refused, a bare list is accepted', E.runsProblems({ runs: [] }).length === 1 && E.runsProblems(runs, known).length === 0);
  const okFile = writeTmp('runs-ok.json', { runs: [{ scenario: 'dental-clinic-website', attempt: 1, pass: true }, { scenario: 'dental-clinic-website', attempt: 2, pass: false }, { scenario: 'recipe-app', attempt: 1, pass: true }, { scenario: 'recipe-app', attempt: 2, pass: true }] });
  const rr = run(['reliability', '--runs', okFile, '--json']), jr = json(rr);
  t('CLI reliability --runs computes pass@2 and pass^2 per scenario (exit 0, no claude)', rr.status === 0 && !!jr && jr.k === 2 && jr.scenarios[0].scenario === 'dental-clinic-website' && jr.scenarios[0].pass_at_k === 1 && jr.scenarios[0].pass_hat_k === 0 && jr.mean_pass_hat_k === 0.5 && !marker(), rr.stdout + rr.stderr);
  const rt = run(['reliability', '--runs', okFile, '--k', '1']);
  t('CLI reliability text names k and the means', rt.status === 0 && /k = 1/.test(rt.stdout) && /pass@1 0\.75 · pass\^1 0\.75/.test(rt.stdout), rt.stdout);
  t('CLI reliability: an invalid runs file exits 3, a missing --runs or a bad --k exits 2', run(['reliability', '--runs', writeTmp('runs-bad.json', { runs: [{ scenario: 'nope', attempt: 1, pass: true }] })]).status === 3 && run(['reliability']).status === 2 && run(['reliability', '--runs', okFile, '--k', 'x']).status === 2);
}
{
  const sc = (id) => ({ id, request: 'r ' + id });
  const res = (id, status, passed, total) => ({ id, status, checks: { total, passed }, gaps: [] });
  const list = ['a', 'b', 'c', 'new'].map(sc);
  const base = E.baselineRecord(['a', 'b', 'c'].map(sc), [res('a', 'PASS', 5, 5), res('b', 'KNOWN-GAP', 3, 3), res('c', 'PASS', 4, 4)], { scenarios: 3, PASS: 2, 'KNOWN-GAP': 1, FAIL: 0, checks: { total: 12, passed: 12 }, gaps: { open: 1 } });
  base.results.push({ id: 'gone', status: 'PASS', checks: { total: 1, passed: 1 } });
  t('baselineRecord writes a valid baseline', E.baselineProblems(base).length === 0 && base.results[0].scenario_sha256.length === 64);
  const cmp = E.compareBaseline(base, list, [res('a', 'FAIL', 4, 5), res('b', 'PASS', 4, 4), res('c', 'PASS', 3, 3), res('new', 'PASS', 2, 2)], new Set(['a', 'b', 'c', 'new']));
  const ch = (id) => (cmp.items.find((x) => x.id === id) || {}).change;
  t('compare: PASS -> FAIL is a REGRESSION', ch('a') === 'REGRESSION');
  t('compare: KNOWN-GAP -> PASS is an IMPROVEMENT', ch('b') === 'IMPROVEMENT');
  t('compare: a PASS with fewer checks is a REGRESSION (a dropped check is a weakening)', ch('c') === 'REGRESSION' && /a check was dropped/.test(cmp.items.find((x) => x.id === 'c').reason));
  t('compare: NEW and REMOVED are reported', ch('new') === 'NEW' && ch('gone') === 'REMOVED' && cmp.counts.REGRESSION === 2 && cmp.counts.unchanged === 0);
  t('baselineProblems rejects a file that is no baseline', E.baselineProblems({ kind: 'x' }).length === 1 && E.baselineProblems(Object.assign({}, base, { results: [{ id: 'a', status: 'GREAT', checks: { total: 1, passed: 1 } }] })).length === 1);
}
{
  const bfile = path.join(TMP, 'baseline.json');
  const rw = run(['baseline', '--write', '--baseline', bfile]);
  const written = fs.existsSync(bfile) ? JSON.parse(fs.readFileSync(bfile, 'utf8')) : null;
  t('baseline --write stores status and check counts per scenario (exit 0)', rw.status === 0 && !!written && written.results.length === 42 && !!j1 && written.results.every((x, i) => x.status === j1.results[i].status && x.checks.total === j1.results[i].checks.total), rw.stderr);
  const shipped = JSON.parse(fs.readFileSync(E.BASELINE_DEFAULT, 'utf8'));
  t('the shipped eval-baseline.json is current (same content as a fresh baseline --write)', !!written && JSON.stringify(shipped) === JSON.stringify(written), 'run baseline --write after a reviewed change');
  const rc = run(['run', '--compare', '--json']), jc = json(rc);
  t('run --compare against the shipped baseline: 0 regressions, exit 0', rc.status === 0 && !!jc && jc.compare.counts.REGRESSION === 0 && jc.compare.counts.unchanged === 42 && jc.compare.comparable === true, rc.stdout.slice(0, 300) + rc.stderr);
  fs.writeFileSync(path.join(OVR, 'forge-domain-discovery.cjs'), wrapper('forge-domain-discovery.cjs', "if(j.verdict){j.verdict='KNOWN';j.best='game';}"));
  const rg = run(['run', '--only', 'dental-clinic-website', '--compare', '--baseline', bfile, '--json'], { FORGE_INTEL_EVALS_BIN: OVR }), jg = json(rg);
  t('regression fixture: a broken classify turns PASS into FAIL -> REGRESSION, exit 1 (wins over 3)', rg.status === 1 && !!jg && jg.compare.counts.REGRESSION === 1 && jg.compare.items[0].id === 'dental-clinic-website' && jg.compare.items[0].change === 'REGRESSION', rg.stdout.slice(0, 400));
  t('regression fixture: the override is flagged (not comparable) and --only reports nothing as REMOVED', !!jg && jg.compare.comparable === false && /tool override/.test(jg.compare.warning) && jg.compare.counts.REMOVED === 0);
  const rgt = run(['run', '--only', 'dental-clinic-website', '--compare', '--baseline', bfile], { FORGE_INTEL_EVALS_BIN: OVR });
  t('regression fixture: the text output names the REGRESSION and why', rgt.status === 1 && /REGRESSION\s+dental-clinic-website: PASS 26\/26 -> FAIL/.test(rgt.stdout) && /status fell from PASS to FAIL/.test(rgt.stdout), rgt.stdout.slice(-600));
  fs.unlinkSync(path.join(OVR, 'forge-domain-discovery.cjs'));
  const edited = clone(written); edited.results.find((x) => x.id === 'recipe-app').status = 'FAIL'; edited.results.push({ id: 'retired-scenario', status: 'PASS', checks: { total: 3, passed: 3 } });
  const efile = writeTmp('baseline-edited.json', edited);
  const re = run(['run', '--only', 'recipe-app', '--compare', '--baseline', efile, '--json']), je = json(re);
  t('compare: a scenario that was FAIL and now PASSes is an IMPROVEMENT (exit 0)', re.status === 0 && !!je && je.compare.counts.IMPROVEMENT === 1 && je.compare.counts.REGRESSION === 0);
  const noFile = path.join(TMP, 'no-baseline.json');
  t('run --compare without a baseline file is a usage error (exit 2)', run(['run', '--only', 'recipe-app', '--compare', '--baseline', noFile]).status === 2);
  t('baseline --write refuses a partial run (--only) and --live-config (exit 2), and writes nothing', run(['baseline', '--write', '--only', 'recipe-app', '--baseline', noFile]).status === 2 && run(['baseline', '--write', '--live-config', '--baseline', noFile]).status === 2 && !fs.existsSync(noFile));
  t('--write and --compare belong to their own command (usage error elsewhere)', run(['run', '--write']).status === 2 && run(['baseline', '--compare']).status === 2);
}
t('no claude process was started by any test', !marker());

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort: our own temp folder */ }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
