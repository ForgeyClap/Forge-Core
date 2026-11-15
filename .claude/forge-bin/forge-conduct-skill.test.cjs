#!/usr/bin/env node
'use strict';
/**
 * forge-conduct-skill.test.cjs — the compact behaviour skill every agent preloads (SD-T2).
 * Covers: the file exists and stays at most 80 lines, model-invocable frontmatter with a short description,
 * no dynamic-command line, the seven rules with their full-skill paths, and every named path resolves.
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const repoRoot = path.resolve(__dirname, '..', '..');
let name = 'forge-conduct';
try {
  const DS = require('./forge-default-skills.cjs');
  const r = DS.loadDefaults(repoRoot);
  if (r.data && r.data.conduct) name = r.data.conduct;
} catch (e) { console.error('  note: loader unavailable, using default name: ' + e.message); }
const file = path.join(repoRoot, '.claude', 'skills', name, 'SKILL.md');

try {
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  t('exists and small', exists && lines.length > 0 && lines.length <= 80, 'lines=' + lines.length);
  t('LF only', exists && !text.includes('\r'));

  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const front = fm ? fm[1] : '';
  const nameLine = /^name:\s*"?([^"\n]+?)"?\s*$/m.exec(front);
  const descLine = /^description:\s*"?(.*?)"?\s*$/m.exec(front);
  const desc = descLine ? descLine[1] : '';
  t('frontmatter', !!fm && nameLine && nameLine[1] === 'forge-conduct' && desc.length > 0 && desc.length <= 250
    && !/disable-model-invocation/.test(front) && !/^hooks:/m.test(front), 'name=' + (nameLine && nameLine[1]) + ' desc=' + desc.length);
  t('description is Use-when led', /^Use when/i.test(desc), desc);

  t('no dynamic command', !lines.some((l) => /(^|\s)!`[^`\n]+`/.test(l)));

  const paths = ['ponytail', 'forge-testing', 'forge-debug', 'forge-verify', 'forge-craft', 'humanizer'].map((s) => '.claude/skills/' + s + '/SKILL.md');
  const absent = paths.filter((p) => !text.includes(p));
  t('seven rules', absent.length === 0 && text.includes("owner's language"), 'absent: ' + absent.join(', '));
  t('access line', /Skill tool/.test(text) && /Read the SKILL\.md/.test(text));
  // Canary (deep research 2026-11-08): a preload fails silently (missing, disabled or disable-model-invocation skill, a
  // misspelled key), so delivery is measured, not assumed: the agent ends its report with this exact line and the
  // SubagentStop hook records conduct_seen.
  t('canary line', /`conduct: forge-conduct v1`/.test(text), 'the exact report line `conduct: forge-conduct v1` is missing');

  const named = Array.from(text.matchAll(/\.claude\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md/g)).map((m) => m[1]);
  const broken = named.filter((s) => !fs.existsSync(path.join(repoRoot, '.claude', 'skills', s, 'SKILL.md')));
  t('paths resolve', named.length >= 6 && broken.length === 0, 'broken: ' + broken.join(', '));
} catch (e) {
  fail++; console.error('  FAIL unexpected throw :: ' + (e && e.stack || e));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
