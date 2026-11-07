#!/usr/bin/env node
'use strict';
// Guard: every *.test.cjs here must meet the two conventions the doctor and the forge-sync regression
// gate rely on, so a new suite cannot roll back a project sync:
//  1. it prints a '<n> passed, <m> failed' tally (node:test's own 'ℹ pass 5' reads as 0/0 = no evidence; that
//     rolled back the 26h2 sync for forge-export.test.cjs);
//  2. it has at least one real assertion site (doctor check_the_checks; this file itself first had none, which
//     rolled back the third 26h2 sync).
// Usage: node forge-test-tally.test.cjs [dir]
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { countAssertionSites } = require('./doctor/checks-testscan.cjs');

const TALLY_RE = /passed, '|passed, \$\{|' passed'|passed:/;

function suiteProblems(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.cjs')).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!TALLY_RE.test(text)) out.push(f + ': prints no "<n> passed, <m> failed" tally line');
    if (countAssertionSites(text) === 0) out.push(f + ': has no assertion site (doctor check_the_checks)');
  }
  return out;
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || __dirname);
  let passed = 0; let failed = 0;
  try { assert.deepStrictEqual(suiteProblems(dir), []); passed++; } catch (e) {
    failed++;
    for (const p of e.actual || []) console.log('FAIL ' + p);
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
module.exports = { suiteProblems };
