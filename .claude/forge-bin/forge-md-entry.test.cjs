#!/usr/bin/env node
'use strict';
/**
 * forge-md-entry.test.cjs — guard for the /forge entry text (R8B-F6). In category round 8b three Sonnet
 * Leads read commands/forge.md and followed none of it. The fix keeps the entry SHORT and makes it point at commands:
 * the first numbered item of the build flow (section C) names forge-start.cjs, rule 13 gives the exact
 * forge-run-file.cjs put shape (a Lead lost three calls guessing it), the file stays inside the always-loaded budget,
 * and forge-windows-shell says how a headless run builds native code (through the project's own node build script).
 *
 * Usage: node .claude/forge-bin/forge-md-entry.test.cjs [--forge-md <path>] [--shell-skill <path>]
 * The two flags point the checks at another copy (used to show the test fails on the pre-R8B-F6 text).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUDGET_BYTES = 16384; // doctor/checks-advisory.cjs ALWAYS_LOADED_BUDGET_BYTES

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : dflt;
}
const FORGE_MD = arg('--forge-md', path.join(ROOT, '.claude', 'commands', 'forge.md'));
const SHELL_SKILL = arg('--shell-skill', path.join(ROOT, '.claude', 'skills', 'forge-windows-shell', 'SKILL.md'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function section(text, start, end) {
  const i = text.indexOf(start);
  if (i === -1) return '';
  const j = text.indexOf(end, i + start.length);
  return j === -1 ? text.slice(i) : text.slice(i, j);
}
function numbered(sec, n) {
  return sec.split(/\r?\n/).find((l) => new RegExp('^\\s*' + n + '\\.\\s').test(l)) || '';
}

console.log('forge-md-entry tests (R8B-F6: /forge entry points at commands)');
const md = fs.readFileSync(FORGE_MD, 'utf8');
const secC = section(md, '\n## C.', '\n## D.');

t('section C exists', () => assert(secC.length > 0, 'no "## C." section'));
t('the first numbered item of section C names forge-start.cjs with --text', () => {
  const first = secC.split(/\r?\n/).find((l) => /^\s*\d+\.\s/.test(l)) || '';
  assert(/^\s*1\.\s/.test(first), 'first numbered item is not item 1: ' + JSON.stringify(first.slice(0, 80)));
  assert(/node \.claude\/forge-bin\/forge-start\.cjs --text/.test(first), 'item 1 does not name forge-start.cjs --text: ' + JSON.stringify(first.slice(0, 120)));
});
t('the numbered entry comes before the step table', () => {
  const entry = secC.search(/^\s*1\.\s.*forge-start\.cjs/m);
  const table = secC.indexOf('\n| # |');
  assert(entry !== -1 && table !== -1 && entry < table, 'entry at ' + entry + ', table at ' + table);
});
t('the entry names the NEXT line, the write guard and the Stop hook close (items 2-4)', () => {
  assert(/NEXT/.test(numbered(secC, 2)) && /forge-runcontract\.cjs plan --run/.test(numbered(secC, 2)), 'item 2: NEXT + contract plan');
  assert(/write guard/i.test(numbered(secC, 3)) && /internal/.test(numbered(secC, 3)), 'item 3: write guard + Lead-internal package');
  assert(/Stop hook/.test(numbered(secC, 4)) && /blocker/.test(numbered(secC, 4)), 'item 4: Stop hook + blocker');
});
t('rule 13 gives the exact forge-run-file.cjs put shape (--run, --name, --from)', () => {
  const r13 = numbered(section(md, '## A.', '## B.'), 13);
  assert(r13, 'no rule 13 in section A');
  assert(/forge-run-file\.cjs put --run \S+ --name \S+ --from \S+/.test(r13), 'rule 13 lacks "forge-run-file.cjs put --run <id> --name <file> --from <draft>"');
});
t('forge.md stays within the always-loaded budget (' + BUDGET_BYTES + ' bytes)', () => {
  const bytes = fs.statSync(FORGE_MD).size;
  assert(bytes <= BUDGET_BYTES, bytes + ' bytes');
});
t('forge-windows-shell names a node build script for headless native builds', () => {
  const skill = fs.readFileSync(SHELL_SKILL, 'utf8');
  const line = skill.split(/\r?\n/).find((l) => /headless/i.test(l) && /node scripts\/build\.cjs/.test(l)) || '';
  assert(line, 'no line naming headless runs and `node scripts/build.cjs`');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
