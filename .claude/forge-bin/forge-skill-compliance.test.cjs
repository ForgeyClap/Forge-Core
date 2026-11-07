#!/usr/bin/env node
'use strict';
/**
 * forge-skill-compliance.test.cjs —: forge-skill-compliance.cjs. Hermetic: the fixture project lives in one
 * os.mkdtemp folder (removed at the end); the real project is only read (one smoke run).
 *   A. step extraction: rule/step sections, must-items, fences skipped, prohibitions marked
 *   B. a fixture run: loaded skills found, each step observed / not_observed / not_checkable as expected
 *   C. the tool ledger: tagged lines for this run count, other runs and out-of-window lines do not
 *   D. red-green needs a check_failed BEFORE a later check_passed
 *   E. CLI exit codes, --latest, determinism, and no process spawning in the source
 *   F. mutations: a weakened rule makes the matching assertion fail
 *   G. the real repo: runs read-only on the newest run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const C = require('./forge-skill-compliance.cjs');

const SRC = path.join(__dirname, 'forge-skill-compliance.cjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-compliance-')));
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const put = (root, rel, content) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const SKILL = [
  '---', 'name: demo-skill', 'description: Demo. Use when testing.', '---', '# Demo',
  '', 'Intro text.', '- a loose bullet with no rule word',
  '- a loose bullet that must be honored by updating memory',
  '', '## Hard rules', '- Never claim fixed without proof.',
  '', '## The loop', '1. Reproduce the bug with an exact command.', '2. Write a failing test first (RED), then make it pass.',
  '3. Run the full test suite.', '4. Request a review of the diff.', '5. Search the web for prior art.', '6. Dance a small jig.',
  '', '```', '1. Reproduce inside a fence must not count.', '```', '',
].join('\n');

const W0 = '2026-01-02T10:00:00.000Z';
function fixture(name, opts) {
  const o = opts || {};
  const r = path.join(TMP, name);
  put(r, '.claude/skills/demo-skill/SKILL.md', SKILL);
  const runs = '.claude/forge-runs/';
  const evA = [
    { run_id: 'forge-2026-01-02-a', event_type: 'run_started', seq: 1, timestamp: W0 },
    { run_id: 'forge-2026-01-02-a', event_type: 'skill_loaded', skill: 'demo-skill', seq: 2, timestamp: '2026-01-02T10:01:00.000Z' },
    { run_id: 'forge-2026-01-02-a', event_type: 'skill_discovery', selected: ['missing-skill'], seq: 3, timestamp: '2026-01-02T10:02:00.000Z' },
  ];
  const order = o.passFirst
    ? [{ event_type: 'check_passed', command: 'node a.test.cjs' }, { event_type: 'check_failed', command: 'node a.test.cjs' }]
    : [{ event_type: 'check_failed', command: 'node a.test.cjs' }, { event_type: 'check_passed', command: 'node a.test.cjs' }];
  order.forEach((x, k) => evA.push(Object.assign({ run_id: 'forge-2026-01-02-a', seq: 4 + k, timestamp: '2026-01-02T10:1' + k + ':00.000Z' }, x)));
  evA.push({ run_id: 'forge-2026-01-02-a', event_type: 'review_completed', seq: 6, timestamp: '2026-01-02T11:00:00.000Z' });
  put(r, runs + 'forge-2026-01-02-a/events.jsonl', jsonl(evA));
  put(r, runs + 'forge-2026-01-01-old/events.jsonl', jsonl([{ event_type: 'run_started', timestamp: '2026-01-01T00:00:00.000Z' }]));
  put(r, runs + '_toollog/s1.jsonl', jsonl([
    { ts: '2026-01-02T10:30:00.000Z', tool: 'Read', target: 'C:/x/.claude/FORGE_MEMORY.md' },
    { ts: '2026-01-02T10:31:00.000Z', run: 'forge-other-run', tool: 'WebSearch', target: 'prior art' },
    { ts: '2026-01-03T10:00:00.000Z', tool: 'WebSearch', target: 'late' },
  ]));
  return r;
}
function loadMutant(from, to) {
  const src = fs.readFileSync(SRC, 'utf8');
  if (!src.includes(from)) return null;
  const m = new Module(SRC, module);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(src.replace(from, to), SRC);
  return m.exports;
}
function capture(argv) { const out = []; const err = []; const code = C.main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; }
const step = (rep, re) => rep.skills.find((s) => s.skill === 'demo-skill').steps.find((s) => re.test(s.text));

try {
  const steps = C.extractSteps(SKILL);
  const texts = steps.map((s) => s.text);
  t('A1 extracts the must-bullet, the hard rule and the 6 loop steps (8 steps)', steps.length === 8, JSON.stringify(texts));
  t('A2 a loose bullet without a rule word is skipped', !texts.some((x) => /loose bullet with no rule/.test(x)));
  t('A3 a list item inside a code fence is skipped', !texts.some((x) => /inside a fence/.test(x)));
  t('A4 "Never ..." is marked a prohibition', steps.find((s) => /^Never/.test(s.text)).prohibition === true);
  t('A5 frontmatter is not read as steps; line numbers are 1-based file lines', steps[0].line === 9 && steps.every((s) => s.line > 4), JSON.stringify(steps.map((s) => s.line)));

  const root = fixture('proj');
  const rep = C.complianceForRun(root, 'forge-2026-01-02-a');
  t('B1 loaded skills: demo-skill (skill_loaded) and missing-skill (skill_discovery)', rep.skills.map((s) => s.skill).join(',') === 'demo-skill,missing-skill' && rep.skills[0].loaded_by[0] === 'skill_loaded');
  t('B2 a skill without a SKILL.md is reported, not guessed', rep.skills[1].status === 'skill_file_not_found' && rep.skills[1].steps.length === 0);
  t('B3 reproduce -> observed (a check_failed exists)', step(rep, /^Reproduce/).status === 'observed', JSON.stringify(step(rep, /^Reproduce/)));
  t('B4 failing test first (RED) -> observed (tests + red-green)', step(rep, /failing test/).status === 'observed' && step(rep, /failing test/).concepts.includes('red-green'));
  t('B5 full test suite -> observed with event evidence', step(rep, /full test suite/).status === 'observed' && step(rep, /full test suite/).evidence.some((e) => /check_/.test(e)));
  t('B6 request a review -> observed (review_completed)', step(rep, /review/).status === 'observed');
  t('B7 the prohibition and the jig are not_checkable, with a reason', step(rep, /^Never/).status === 'not_checkable' && step(rep, /jig/).status === 'not_checkable' && /prohibition/.test(step(rep, /^Never/).reason));
  t('B8 every report says heuristic and carries the caveat', rep.heuristic === true && /not that it was skipped/.test(rep.caveat));

  t('C1 the untagged in-window Read of FORGE_MEMORY.md makes the memory step observed', step(rep, /memory/).status === 'observed' && step(rep, /memory/).evidence.some((e) => /toollog Read FORGE_MEMORY\.md/.test(e)), JSON.stringify(step(rep, /memory/)));
  t('C2 a line tagged for another run and an out-of-window line do not count: web search not_observed', step(rep, /Search the web/).status === 'not_observed', JSON.stringify(step(rep, /Search the web/)));
  t('C3 toollog lines counted = 1', rep.sources.toollog_lines === 1 && rep.sources.toollog_files === 1, JSON.stringify(rep.sources));
  const noTl = C.complianceForRun(root, 'forge-2026-01-02-a', { noToollog: true });
  t('C4 without the tool ledger the memory step is not_observed', step(noTl, /memory/).status === 'not_observed');

  const rev = C.complianceForRun(fixture('passfirst', { passFirst: true }), 'forge-2026-01-02-a');
  t('D1 pass-then-fail order: the RED step is only partial (tests seen, red-green not)', step(rev, /failing test/).status === 'partial' && /red-green/.test(step(rev, /failing test/).reason), JSON.stringify(step(rev, /failing test/)));

  t('E1 report mode exits 0; --strict exits 1 on a not_observed step', capture(['--root', root, '--run', 'forge-2026-01-02-a']).code === 0 && capture(['--root', root, '--run', 'forge-2026-01-02-a', '--strict']).code === 1);
  t('E2 --latest picks the newest dated run', JSON.parse(capture(['--root', root, '--latest', '--json']).out).run_id === 'forge-2026-01-02-a');
  t('E3 usage errors exit 2: no run, unknown run, traversal id, unknown flag', capture(['--root', root]).code === 2 && capture(['--root', root, '--run', 'forge-nope']).code === 2 && capture(['--root', root, '--run', '../x']).code === 2 && capture(['--zzz']).code === 2);
  t('E4 --skill adds a skill the run did not log', C.complianceForRun(root, 'forge-2026-01-01-old', { skills: ['demo-skill'] }).skills.map((s) => s.skill).join() === 'demo-skill');
  const a1 = capture(['--root', root, '--run', 'forge-2026-01-02-a', '--json']).out;
  const a2 = capture(['--root', root, '--run', 'forge-2026-01-02-a', '--json']).out;
  t('E5 deterministic: two JSON runs are byte-identical', a1 === a2 && a1.length > 200);
  const src = fs.readFileSync(SRC, 'utf8');
  t('E6 no process spawning or model call in the source', !/require\(['"](node:)?child_process['"]\)/.test(src) && !/\b(spawn|spawnSync|execSync|execFile|fork)\s*\(/.test(src));
  const outFile = path.join(TMP, 'c.json');
  t('E7 --out writes into an existing folder and refuses a missing one', capture(['--root', root, '--run', 'forge-2026-01-02-a', '--json', '--out', outFile]).code === 0 && JSON.parse(fs.readFileSync(outFile, 'utf8')).tool === 'forge-skill-compliance' && capture(['--root', root, '--run', 'forge-2026-01-02-a', '--out', path.join(TMP, 'none', 'x')]).code === 2);

  const muts = [
    ['prohibition-off', 'prohibition: PROHIBITION.test(text)', 'prohibition: false', (m) => m.complianceForRun(root, 'forge-2026-01-02-a').skills[0].steps.find((s) => /^Never/.test(s.text)).status === 'not_checkable'],
    ['window-off', 'if (win && Number.isFinite(ms) && ms >= win.start && ms <= win.end) out.push(l);', 'out.push(l);', (m) => m.complianceForRun(root, 'forge-2026-01-02-a').sources.toollog_lines === 1],
    ['tag-filter-off', 'if (l.run) { if (l.run === runId) out.push(l); continue; }', 'if (l.run) { out.push(l); continue; }', (m) => m.complianceForRun(root, 'forge-2026-01-02-a').skills[0].steps.find((s) => /Search the web/.test(s.text)).status === 'not_observed'],
    ['red-green-order-off', 'firstFail < lastPass', 'true', (m) => m.complianceForRun(path.join(TMP, 'passfirst'), 'forge-2026-01-02-a').skills[0].steps.find((s) => /failing test/.test(s.text)).status === 'partial'],
    ['fence-off', "if (/^\\s*(```|~~~)/.test(ln)) { fence = !fence; continue; }", "if (false) { fence = !fence; continue; }", (m) => !m.extractSteps(SKILL).some((s) => /inside a fence/.test(s.text))],
  ];
  for (const [label, from, to, stillPasses] of muts) {
    const m = loadMutant(from, to);
    let survived = null;
    try { survived = m ? stillPasses(m) : null; } catch { survived = false; }
    t('F ' + label + ' MUTANT applies and the matching assertion would fail', m && survived === false, m ? 'mutant survived' : 'anchor not found');
  }

  const realRoot = path.resolve(__dirname, '..', '..');
  const real = capture(['--root', realRoot, '--latest', '--json', '--no-toollog']);
  if (real.code === 0) {
    const j = JSON.parse(real.out);
    t('G1 the real repo: the newest run is read without throwing', j.tool === 'forge-skill-compliance' && j.sources.events > 0, j.run_id);
  } else t('G1 skipped: no run folder next to this tool (' + real.err.slice(0, 120) + ')', true);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
