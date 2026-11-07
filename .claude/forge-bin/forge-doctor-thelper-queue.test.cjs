#!/usr/bin/env node
'use strict';
/**
 * forge-doctor-thelper-queue.test.cjs — category tests round 5. Every v5 install rolled back: the doctor's
 * checkTheChecks flagged six "bare function literal" call sites in forge-wait.test.cjs, whose helper is
 * `function t(name, fn) { queue.push({ name, fn }); }` (an async queue that runs every fn later). The classifier only
 * knew "invokes fn" (callback) or "does not" (boolean), so a QUEUEING helper read as boolean and real assertions read as
 * no-ops. Its own doc says such shapes are not judged. Guard: a helper that stores its second parameter (push into a
 * queue, or an object literal) is unclassified (null), so it is left alone; boolean and callback helpers stay as before.
 */
const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, 'doctor', 'checks-testscan.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };

t('a queueing helper (queue.push({ name, fn })) is not judged (null)', () => {
  assert.strictEqual(S.classifyTHelper("function t(name, fn) { queue.push({ name, fn }); }\n"), null);
});
t('a queueing helper with push(fn) directly is not judged either', () => {
  assert.strictEqual(S.classifyTHelper("function t(name, fn) { jobs.push([name, fn]); }\n"), null);
});
t('... so its function-literal call sites are never flagged', () => {
  const src = "function t(name, fn) { queue.push({ name, fn }); }\nt('a', () => { assert.ok(1); });\n";
  assert.deepStrictEqual(S.vacuousBooleanTHelperSites(src), []);
});
t('a boolean helper still reads boolean and its bare function literal is still flagged', () => {
  const src = "const t = (name, cond) => { if (cond) pass++; else fail++; };\nt('a', () => { assert.ok(1); });\n";
  assert.strictEqual(S.classifyTHelper(src), 'boolean');
  assert.strictEqual(S.vacuousBooleanTHelperSites(src).length, 1);
});
t('a callback helper (try { fn() }) still reads callback', () => {
  assert.strictEqual(S.classifyTHelper("const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; } };\n"), 'callback');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
