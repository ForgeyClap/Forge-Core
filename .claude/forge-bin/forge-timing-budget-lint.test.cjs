#!/usr/bin/env node
'use strict';
/**
 * forge-timing-budget-lint.test.cjs — category tests F4b. A fresh install of windows-game-v2 rolled back
 * because forge-snapshot-reinject.test.cjs asserted "fastest of 3 node spawns < 500 ms" while the machine was busy;
 * the same suite passes 36/0 when run alone. forge-toolhook.test.cjs learned this on 2026-09-26 (N3: default 2500 ms,
 * the tight 500 ms only under FORGE_STRICT_TIMING=1), but two later copies of the pattern kept the tight default.
 * The doctor (and so every install) runs these suites, and a wall-clock benchmark must never decide an install.
 * Guard: every suite that reads FORGE_HOOK_OFF_BUDGET_MS defaults to >= 2000 ms unless FORGE_STRICT_TIMING is set.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };

/** tightDefaults(text) -> the default budgets (ms) a suite falls back to without FORGE_STRICT_TIMING. */
function looseDefault(text) {
  const line = text.split('\n').find((l) => /const OFF_BUDGET_MS\s*=.*FORGE_HOOK_OFF_BUDGET_MS/.test(l));
  if (!line) return null;
  const m = line.match(/FORGE_STRICT_TIMING[^?]*\?\s*[A-Z_0-9]+\s*:\s*(\d+)/) || line.match(/\|\|\s*(\d+)\s*;?\s*$/);
  return m ? Number(m[1]) : NaN;
}

t('looseDefault reads both shapes', () => {
  assert.strictEqual(looseDefault("const OFF_BUDGET_MS = Number(process.env.FORGE_HOOK_OFF_BUDGET_MS) || 500;"), 500);
  assert.strictEqual(looseDefault("const OFF_BUDGET_MS = Number(process.env.FORGE_HOOK_OFF_BUDGET_MS) || (FORGE_STRICT_TIMING ? OFF_BUDGET_DESIGN_MS : 2500);"), 2500);
});
t('every hook OFF-path timing suite defaults to a lenient budget (>= 2000 ms) unless FORGE_STRICT_TIMING=1', () => {
  const tight = [];
  for (const n of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.cjs') && f !== path.basename(__filename))) {
    const d = looseDefault(fs.readFileSync(path.join(__dirname, n), 'utf8'));
    if (d !== null && !(d >= 2000)) tight.push(n + ' (default ' + d + ' ms)');
  }
  assert.deepStrictEqual(tight, []);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
