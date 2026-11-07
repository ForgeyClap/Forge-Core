#!/usr/bin/env node
'use strict';
/**
 * forge-harness-score.test.cjs —: forge-harness-score.cjs + the shipped rubric. Hermetic: the fixture
 * project lives in one os.mkdtemp folder (removed at the end); the real project is only read (one smoke run).
 *   A. the shipped rubric validates; a broken rubric is refused (exit 2)
 *   B. the fixture project scores to known numbers per category and overall
 *   C. not-measured inputs never count as pass or fail; the top 3 actions are ranked by lost weighted points
 *   D. determinism: the same inputs give byte-identical JSON and text, twice
 *   E. CLI: exit codes for report mode, --strict, usage, --out
 *   F. mutations: a weakened check or scoring rule makes the matching assertion fail
 *   G. the real repo: scores without throwing
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const H = require('./forge-harness-score.cjs');

const SRC = path.join(__dirname, 'forge-harness-score.cjs');
const RUBRIC = path.join(__dirname, '..', 'config', 'quality', 'harness-rubric.json');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-harness-score-')));
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const put = (root, rel, content) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2)); return p; };
const cat = (rep, id) => rep.categories.find((c) => c.id === id);
const chk = (rep, id) => rep.categories.flatMap((c) => c.checks).find((c) => c.id === id);

function chained(n, runId) {
  const out = [];
  let prev = 'genesis:' + runId;
  for (let i = 1; i <= n; i++) { const h = 'h' + i; out.push(JSON.stringify({ run_id: runId, event_type: i === 1 ? 'run_started' : 'agent_note', seq: i, prev_hash: prev, entry_hash: h })); prev = h; }
  return out.join('\n') + '\n';
}
function fixture(name) {
  const r = path.join(TMP, name);
  put(r, '.claude/settings.json', { permissions: { deny: ['Read(./.env)', 'Read(./**/*.pem)', 'Read(~/.ssh/**)'] }, hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"' }] }] } });
  put(r, '.claude/forge-bin/forge-runcontract.cjs', '// fixture\n');
  put(r, '.claude/forge-bin/forge-gate-hook.cjs', '// fixture\n');
  const ids = ['memory-read', 'dispatch-logged', 'evidence-satisfied', 'independent-verification', 'report-present', 'end-self-review', 'r7', 'r8', 'r9', 'r10'];
  put(r, '.claude/config/orchestration/FORGE_HARD_RULES.json', { rules: ids.map((id) => ({ id })) });
  put(r, '.claude/config/orchestration/hard-gates.json', { gates: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) });
  for (const f of ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md']) put(r, '.claude/' + f, '# ' + f + '\n\n' + 'A real line of project memory text for the fixture.\n'.repeat(2));
  put(r, '.claude/forge-runs/forge-2026-01-01-old/events.jsonl', chained(3, 'forge-2026-01-01-old'));
  put(r, '.claude/forge-runs/forge-2026-01-01-old/run-finalized.json', { ok: true });
  put(r, '.claude/forge-runs/forge-2026-01-02-new/events.jsonl', chained(4, 'forge-2026-01-02-new') + '{broken\n');
  put(r, '.claude/skills/good-skill/SKILL.md', '---\nname: good-skill\ndescription: Reviews pull-request diffs for correctness. Use when the user asks for a code review.\n---\n# Good\n\nBody.\n');
  put(r, '.claude/agents/good-agent.md', '---\nname: good-agent\ndescription: Reviews code diffs for correctness. Use when a review is needed.\nmodel: sonnet\neffort: low\n---\nBody.\n');
  put(r, '.claude/config/intelligence/eval-baseline.json', { kind: 'forge-intel-evals-baseline', version: 1, summary: { scenarios: 10, PASS: 8, 'KNOWN-GAP': 2, FAIL: 0 }, results: [] });
  return r;
}
const DOCTOR = { ok: false, checks: { tests: { ok: true, passed: 10, failed: 0, suitesFailed: 0 }, node_check: { ok: true }, chain: { ok: false }, agents: { ok: true } } };
function loadMutant(from, to) {
  const src = fs.readFileSync(SRC, 'utf8');
  if (!src.includes(from)) return null;
  const m = new Module(SRC, module);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(src.replace(from, to), SRC);
  return m.exports;
}
function capture(argv) { const out = []; const err = []; const code = H.main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; }

try {
  t('A1 the shipped rubric validates', H.validateRubric(JSON.parse(fs.readFileSync(RUBRIC, 'utf8'))).length === 0, H.validateRubric(JSON.parse(fs.readFileSync(RUBRIC, 'utf8'))));
  const badRubric = put(TMP, 'bad-rubric.json', { kind: 'forge-harness-rubric', version: 1, categories: [{ id: 'x', weight: 1, checks: [{ id: 'c', type: 'no-such-type', points: 1 }] }] });
  t('A2 a rubric with an unknown check type is refused with exit 2', capture(['--root', TMP, '--rubric', badRubric]).code === 2);

  const root = fixture('proj');
  const doctorFile = put(root, '_scratch/doctor.json', DOCTOR);
  const rep = H.scoreHarness(root, { doctorJson: doctorFile });
  t('B1 tests: tests + node_check pass, 3/4 doctor checks ok -> 9.5/10 earned -> score 10', cat(rep, 'tests').score === 10 && cat(rep, 'tests').earned === 9.5, JSON.stringify(cat(rep, 'tests')));
  t('B2 run_contract 10/10', cat(rep, 'run_contract').score === 10, JSON.stringify(cat(rep, 'run_contract').checks));
  t('B3 hard_gates: file, tool, hook registered for Bash|PowerShell, gate-hook default on -> 10', cat(rep, 'hard_gates').score === 10, JSON.stringify(cat(rep, 'hard_gates').checks));
  const chain = chk(rep, 'latest-run-chained');
  t('B4 latest run = the newest dated folder; 4/5 lines chained -> partial 1.6/2', rep.latest_run === 'forge-2026-01-02-new' && chain.status === 'partial' && chain.earned === 1.6, JSON.stringify(chain));
  t('B5 latest-run-finalized fails (no run-finalized.json in the newest run)', chk(rep, 'latest-run-finalized').status === 'fail');
  t('B6 memory_ledger = round(7.6/10*10) = 8', cat(rep, 'memory_ledger').score === 8, JSON.stringify(cat(rep, 'memory_ledger')));
  t('B7 skill_lint and agent_lint measured on 1 skill / 1 agent', cat(rep, 'skill_lint').score != null && cat(rep, 'agent_lint').score != null && /1 skills/.test(chk(rep, 'skill-lint').detail) && /1 agents/.test(chk(rep, 'agent-lint').detail));
  t('B8 mcp: no registry -> not_measured; no .mcp.json -> pass; flag absent -> pass', chk(rep, 'mcp-registry-ok').status === 'not_measured' && chk(rep, 'mcp-host-pinned').status === 'pass' && chk(rep, 'mcp-not-auto-enabled').status === 'pass' && cat(rep, 'mcp_dormancy').max === 5);
  t('B9 plugin_build not measured outside a Forge development tree', cat(rep, 'plugin_build').score === null && chk(rep, 'plugin-identical').status === 'not_measured');
  t('B10 eval_bar: 8/10 PASS under a 0.9 bar -> partial', chk(rep, 'eval-pass-ratio').status === 'partial' && chk(rep, 'eval-no-fail').status === 'pass', JSON.stringify(cat(rep, 'eval_bar')));
  t('B11 config_scan clean on the fixture -> 10', cat(rep, 'config_scan').score === 10, JSON.stringify(cat(rep, 'config_scan').checks));
  const manual = (() => { let ws = 0, we = 0; for (const c of rep.categories) if (c.max > 0) { ws += c.weight; we += c.weight * (c.earned / c.max); } return Math.round(10 * we / ws); })();
  t('B12 overall = weighted mean of measured categories (' + manual + ')', rep.overall === manual && rep.measured_categories === 9 && rep.total_categories === 10);

  const noDoc = H.scoreHarness(root);
  t('C1 without --doctor-json the tests category is not measured (not 0, not 10)', cat(noDoc, 'tests').score === null && chk(noDoc, 'doctor-tests-ok').status === 'not_measured' && noDoc.measured_categories === 8);
  t('C2 top 3 actions: the latest-run-finalized fail outranks the partials', rep.top_actions.length === 3 && rep.top_actions[0].check === 'latest-run-finalized', JSON.stringify(rep.top_actions));
  t('C3 not-measured checks rank after every lost point', (() => { const i = noDoc.top_actions.findIndex((a) => a.status === 'not_measured'); return i === -1 || noDoc.top_actions.slice(i).every((a) => a.status === 'not_measured'); })(), JSON.stringify(noDoc.top_actions));
  t('C4 inputs name files relative to the root plus a sha256', rep.inputs.doctor_json.file === '_scratch/doctor.json' && /^[0-9a-f]{64}$/.test(rep.inputs.doctor_json.sha256) && rep.inputs.rubric.version === 1);

  const j1 = capture(['--root', root, '--doctor-json', doctorFile, '--json']).out;
  const j2 = capture(['--root', root, '--doctor-json', doctorFile, '--json']).out;
  const x1 = capture(['--root', root, '--doctor-json', doctorFile]).out;
  const x2 = capture(['--root', root, '--doctor-json', doctorFile]).out;
  t('D1 JSON output is byte-identical across two runs', j1 === j2 && j1.length > 100);
  t('D2 text output is byte-identical across two runs', x1 === x2 && /top actions/.test(x1));
  const copy = fixture('proj-copy');
  put(copy, '_scratch/doctor.json', DOCTOR);
  const jc = JSON.parse(capture(['--root', copy, '--doctor-json', path.join(copy, '_scratch', 'doctor.json'), '--json']).out);
  t('D3 a byte-identical fixture in another folder gives the same scores and actions', JSON.stringify(jc.categories) === JSON.stringify(JSON.parse(j1).categories) && JSON.stringify(jc.top_actions) === JSON.stringify(JSON.parse(j1).top_actions));

  t('E1 report mode exits 0', capture(['--root', root]).code === 0);
  t('E2 --strict exits 1 when a check failed', capture(['--root', root, '--strict']).code === 1);
  t('E3 --strict --min 0 still exits 1 on a failed check', capture(['--root', root, '--strict', '--min', '0']).code === 1);
  t('E4 unknown argument / bad --min / missing root / unreadable --doctor-json exit 2', capture(['--nope']).code === 2 && capture(['--min', '11']).code === 2 && capture(['--root', path.join(TMP, 'missing')]).code === 2 && capture(['--root', root, '--doctor-json', path.join(TMP, 'none.json')]).code === 2);
  const outFile = path.join(TMP, 'score.json');
  t('E5 --out writes into an existing folder, refuses a missing one', capture(['--root', root, '--json', '--out', outFile]).code === 0 && JSON.parse(fs.readFileSync(outFile, 'utf8')).tool === 'forge-harness-score' && capture(['--root', root, '--out', path.join(TMP, 'nodir', 'x.json')]).code === 2);

  const muts = [
    ['finalized-always-pass', "return readText(path.join(run.dir, 'run-finalized.json')) != null ?", 'return true ?', (m) => m.scoreHarness(root, { doctorJson: doctorFile }).categories.flatMap((c) => c.checks).find((c) => c.id === 'latest-run-finalized').status === 'fail'],
    ['not-measured-counts-as-zero', 'if (pts != null) { max += ch.points; earned += pts; }', 'max += ch.points; earned += pts || 0;', (m) => m.scoreHarness(root).categories.find((c) => c.id === 'tests').score === null],
    ['hook-matcher-ignored', 'const miss = c.matcher_includes.filter((m) => !covered.has(m));', 'const miss = [];', (m) => { const r2 = fixture('proj-nohook'); put(r2, '.claude/settings.json', { hooks: {} }); return m.scoreHarness(r2).categories.find((c) => c.id === 'hard_gates').checks.find((c) => c.id === 'gate-hook-registered').status === 'fail'; }],
    ['rank-reversed', 'candidates.sort((a, b) => (b.lost - a.lost)', 'candidates.sort((a, b) => (a.lost - b.lost)', (m) => m.scoreHarness(root, { doctorJson: doctorFile }).top_actions[0].check === 'latest-run-finalized'],
    ['chain-unchecked', "if (!e.entry_hash || !e.prev_hash) bad++; } catch { bad++; }", '} catch { /* ignore */ }', (m) => m.scoreHarness(root).categories.flatMap((c) => c.checks).find((c) => c.id === 'latest-run-chained').status === 'partial'],
  ];
  for (const [label, from, to, stillPasses] of muts) {
    const m = loadMutant(from, to);
    let survived = null;
    try { survived = m ? stillPasses(m) : null; } catch (e) { survived = false; }
    t('F ' + label + ' MUTANT applies and the matching assertion would fail', m && survived === false, m ? 'mutant survived' : 'anchor not found');
  }

  const realRoot = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(realRoot, '.claude', 'settings.json'))) {
    const real = H.scoreHarness(realRoot);
    t('G1 the real repo scores without throwing', typeof real.overall === 'number' && real.categories.length === 10 && real.top_actions.length <= 3, real.overall);
  } else t('G1 skipped: no .claude/settings.json next to this tool', true);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
