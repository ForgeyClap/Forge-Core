#!/usr/bin/env node
'use strict';
/**
 * forge-agentlint.test.cjs —: forge-agentlint.cjs. Hermetic: fixtures in one os.mkdtemp folder (removed at
 * the end), each with its own small FORGE_MODEL_ROUTING.json; the real project is only read (one smoke run).
 *   A. a clean agent on its GOAT route has no error and no warning
 *   B. each fixture is flagged: typo key, missing description, --- on line 2, missing name, bad values
 *   C. GOAT: wrong model, wrong effort, missing effort, an unlisted agent (info only)
 *   D. the description-token estimate and the 15k warning; the advisory audits are info, never errors
 *   E. CLI: report exit 0, --strict exit 1, --json
 *   F. mutations: a weakened rule makes the matching assertion fail
 *   G. the real repo: runs read-only and returns a report
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./forge-agentlint.cjs');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agentlint-')));
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const ROUTING = { agentDefaults: { 'good-agent': 'build', 'reader': 'verifier', 'wrong-model': 'build', 'wrong-effort': 'build', 'no-effort': 'build', 'typo': 'build', 'bad-values': 'build' },
  routes: { build: { model: 'opus', effort: 'medium' }, verifier: { model: 'sonnet', effort: 'medium' } } };
let n = 0;
function mkRoot(files, routing) {
  const r = path.join(TMP, 'r' + (++n));
  fs.mkdirSync(path.join(r, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'FORGE_MODEL_ROUTING.json'), JSON.stringify(routing || ROUTING));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(r, '.claude', 'agents', f), c);
  return r;
}
const fm = (lines, body) => '---\n' + lines.join('\n') + '\n---\n' + (body || 'You are an agent.\n');
const GOOD = ['name: good-agent', 'description: Implements work packages. Use after triage.', 'tools: Read, Write, Edit, Bash', 'model: opus', 'effort: medium', 'maxTurns: 100', 'isolation: worktree'];
const of = (rep, file) => rep.findings.filter((f) => f.file.endsWith('/' + file));
const has = (rep, file, rule, level) => of(rep, file).some((f) => f.rule === rule && (!level || f.level === level));

try {
  const root = mkRoot({
    'good-agent.md': fm(GOOD),
    'typo.md': fm(['name: typo', 'description: Does things. Use when asked.', 'tools: Read', 'model: opus', 'effort: medium', 'maxTurn: 50', 'Model_x: 1']),
    'no-desc.md': fm(['name: no-desc', 'model: opus']),
    'line-two.md': '\n' + fm(GOOD.map((l) => l.replace('good-agent', 'line-two'))),
    'no-name.md': fm(['description: An agent without a name.']),
    'bad-values.md': fm(['name: bad-values', 'description: x', 'model: gpt-4', 'effort: huge', 'isolation: container', 'memory: global', 'background: "true"', 'maxTurns: 0', 'autoCompactWindow: 200k', 'color: magenta', 'permissionMode: yolo']),
    'wrong-model.md': fm(['name: wrong-model', 'description: x', 'model: sonnet', 'effort: medium']),
    'wrong-effort.md': fm(['name: wrong-effort', 'description: x', 'model: opus', 'effort: xhigh']),
    'no-effort.md': fm(['name: no-effort', 'description: x', 'model: opus']),
    'unlisted.md': fm(['name: unlisted', 'description: x', 'model: opus', 'effort: high']),
    'reader.md': fm(['name: reader', 'description: Reviews code read-only.', 'tools: Read, Grep, Glob', 'model: sonnet', 'effort: medium', 'maxTurns: 40']),
    'dup.md': fm(['name: dup', 'description: x', 'name: dup2']),
    'notes.txt': 'not an agent',
  });
  const rep = A.lintAgents(root);

  // A
  t('A1 a clean agent on its GOAT route has no error or warning', of(rep, 'good-agent.md').filter((f) => f.level !== 'info').length === 0, JSON.stringify(of(rep, 'good-agent.md')));
  t('A2 only .md files are agents', rep.agents === 12);
  t('A3 every documented key is known (name..experimental)', ['tools', 'disallowedTools', 'permissionMode', 'maxTurns', 'autoCompactWindow', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd', 'effort', 'isolation', 'color', 'initialPrompt', 'experimental'].every((k) => A.KNOWN_KEYS.includes(k)));

  // B
  const typo = of(rep, 'typo.md').filter((f) => f.rule === 'unknown_key');
  t('B1 typo key maxTurn -> error unknown_key suggesting maxTurns', typo.some((f) => f.level === 'error' && /"maxTurn"/.test(f.message) && /did you mean "maxTurns"/.test(f.message)), JSON.stringify(typo));
  t('B2 a second unknown key is flagged too', typo.length === 2);
  t('B3 missing description -> error description_missing', has(rep, 'no-desc.md', 'description_missing', 'error'));
  t('B4 --- on line 2 -> error frontmatter (agent skipped)', of(rep, 'line-two.md').some((f) => f.rule === 'frontmatter' && f.level === 'error' && /line 2/.test(f.message)));
  t('B5 missing name -> error name_missing', has(rep, 'no-name.md', 'name_missing', 'error'));
  const bad = of(rep, 'bad-values.md').map((f) => f.rule);
  t('B6 bad values: model, effort, isolation, memory, boolean, maxTurns, autoCompactWindow, permissionMode are errors',
    ['value_model', 'value_effort', 'value_isolation', 'value_memory', 'value_boolean', 'value_maxTurns', 'value_autoCompactWindow', 'value_permissionMode'].every((r) => has(rep, 'bad-values.md', r, 'error')), bad.join(','));
  t('B7 an unknown color is a warning', has(rep, 'bad-values.md', 'value_color', 'warn'));
  t('B8 a duplicate key -> error frontmatter_duplicate', has(rep, 'dup.md', 'frontmatter_duplicate', 'error'));
  t('B9 closestKey maps case and underscore variants', A.closestKey('max_turns') === 'maxTurns' && A.closestKey('Description') === 'description' && A.closestKey('zzzzzzzz') === null);

  // C
  t('C1 model differs from the GOAT route -> error goat_model_mismatch', has(rep, 'wrong-model.md', 'goat_model_mismatch', 'error'));
  t('C2 effort differs from the GOAT route -> error goat_effort_mismatch', has(rep, 'wrong-effort.md', 'goat_effort_mismatch', 'error'));
  t('C3 effort missing on a routed agent -> error goat_effort_missing', has(rep, 'no-effort.md', 'goat_effort_missing', 'error'));
  t('C4 an agent with no default route -> info goat_unlisted only', has(rep, 'unlisted.md', 'goat_unlisted', 'info') && !of(rep, 'unlisted.md').some((f) => f.level === 'error'));
  const noRouting = path.join(TMP, 'no-routing');
  fs.mkdirSync(path.join(noRouting, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(noRouting, '.claude', 'agents', 'a.md'), fm(['name: a', 'description: x']));
  t('C5 no routing file -> info goat_unavailable, never a crash', A.lintAgents(noRouting).findings.some((f) => f.rule === 'goat_unavailable' && f.level === 'info'));

  // D
  const tok = rep.findings.find((f) => f.rule === 'description_tokens');
  t('D1 the description token estimate is reported (info under 15k)', tok && tok.level === 'info' && rep.description_tokens_estimate === Math.ceil(rep.description_chars / 4));
  const big = {};
  for (let i = 0; i < 4; i++) big['big' + i + '.md'] = fm(['name: big' + i, 'description: "' + 'x'.repeat(16000) + '"']);
  t('D2 more than 15k description tokens -> warn description_tokens', A.lintAgents(mkRoot(big)).findings.some((f) => f.rule === 'description_tokens' && f.level === 'warn'));
  t('D3 a writer without isolation -> info audit_isolation', has(rep, 'typo.md', 'audit_isolation', 'info') === false && has(rep, 'no-desc.md', 'audit_isolation', 'info'));
  t('D4 a read-only agent without omitClaudeMd -> info audit_omitClaudeMd', has(rep, 'reader.md', 'audit_omitClaudeMd', 'info') && !has(rep, 'good-agent.md', 'audit_omitClaudeMd'));
  t('D5 no maxTurns -> info audit_maxTurns', has(rep, 'no-desc.md', 'audit_maxTurns', 'info') && !has(rep, 'good-agent.md', 'audit_maxTurns'));
  t('D6 advisory audits are never errors', rep.findings.filter((f) => /^audit_/.test(f.rule)).every((f) => f.level === 'info'));

  // E
  const outs = [];
  const io = { out: (s) => outs.push(s) };
  t('E1 report mode exits 0 even with errors', A.main(['--root', root], io) === 0 && /error/.test(outs[0]));
  t('E2 --strict exits 1 on an error-level finding', A.main(['--root', root, '--strict'], io) === 1);
  t('E3 --strict exits 0 on a clean tree', A.main(['--root', mkRoot({ 'good-agent.md': fm(GOOD) }), '--strict'], io) === 0);
  outs.length = 0;
  A.main(['--root', root, '--json'], io);
  let parsed = null; try { parsed = JSON.parse(outs[0]); } catch { parsed = null; }
  t('E4 --json prints a parseable report', parsed && parsed.counts.error > 0 && parsed.agents === 12);

  // F — mutations on a copy of the tool (with its parser dependency beside it)
  const SRC = fs.readFileSync(path.join(__dirname, 'forge-agentlint.cjs'), 'utf8');
  fs.copyFileSync(path.join(__dirname, 'forge-skilllint.cjs'), path.join(TMP, 'forge-skilllint.cjs'));
  const mutant = (label, from, to) => {
    if (!SRC.includes(from)) { t('F mutation anchor present: ' + label, false, from); return null; }
    const f = path.join(TMP, 'mutant-' + label + '.cjs');
    fs.writeFileSync(f, SRC.replace(from, to));
    return require(f).lintAgents(root);
  };
  const m1 = mutant('allow-all', 'if (KNOWN_KEYS.includes(key)) continue;', 'continue;');
  t('F1 MUTANT every key allowed: B1 would fail', m1 && !has(m1, 'typo.md', 'unknown_key'));
  const m2 = mutant('no-desc', "if (!desc) push('error', 'description_missing'", "if (false) push('error', 'description_missing'");
  t('F2 MUTANT description not required: B3 would fail', m2 && !has(m2, 'no-desc.md', 'description_missing'));
  const m3 = mutant('goat', "else if (have !== want[k])", 'else if (false)');
  t('F3 MUTANT GOAT compare off: C1 would fail', m3 && !has(m3, 'wrong-model.md', 'goat_model_mismatch'));
  const m4 = mutant('tok', 'const DESCRIPTION_TOKEN_WARN = 15000;', 'const DESCRIPTION_TOKEN_WARN = 1e9;');
  t('F4 MUTANT token warn raised: D2 would fail', m4 && (() => { const f = path.join(TMP, 'mutant-tok.cjs'); return !require(f).lintAgents(mkRoot(big)).findings.some((x) => x.rule === 'description_tokens' && x.level === 'warn'); })());

  // G
  const realRoot = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(realRoot, '.claude', 'agents'))) {
    const real = A.lintAgents(realRoot);
    t('G1 the real repo lints without throwing and finds agents', real.agents > 0 && real.counts && typeof real.description_chars === 'number', real.agents);
  } else t('G1 skipped: no .claude/agents next to this tool', true);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
