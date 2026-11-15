#!/usr/bin/env node
'use strict';
/**
 * log-event-proof-oracle.test.cjs — CORE-2-F3. The writer's proof oracle refused honest proof:
 * check_passed with result "69 passed, 0 failed" matched the word "failed" and was STRICT REFUSED as a
 * self-contradiction, and an artifact that is a URL, "n/a" or a description with a slash ("desktop/mobile captures")
 * was joined to the project root as a file path and refused as "proof path missing". A true pass was harder to log
 * than a vague one. Guard (validateForWrite only, nothing is written): a failure word right after a zero count is not
 * a contradiction, and a URL, "n/a" or a value with whitespace is not read as a file path. Real contradictions and
 * real missing files stay refused, and a screenshot proof keeps its file check.
 */
const assert = require('assert');
const path = require('path');
const L = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const ev = (o) => Object.assign({ run_id: 'r-proof-oracle', event_type: 'check_passed', agent: 'Test Boss', command: 'node --test x.test.cjs' }, o);
const okWrite = (r) => assert.ok(r.ok === true, JSON.stringify(r));
const refused = (r, re) => assert.ok(r.ok === false && re.test(r.message || ''), JSON.stringify(r));

console.log('log-event proof oracle (CORE-2-F3)');
for (const res of ['69 passed, 0 failed', '12 passed, 0 errors', 'all green, no failures', '5 ok, zero failed']) {
  t('result "' + res + '" (a zero failure count) is not a contradiction', () => okWrite(L.validateForWrite(ev({ result: res }))));
}
t('wp_completed with status "69 passed, 0 failed" is accepted', () => okWrite(L.validateForWrite(ev({ event_type: 'wp_completed', wp_id: 'W1', status: '69 passed, 0 failed' }))));
for (const res of ['3 failed', '69 passed, 2 failed', 'failed', '0 failed, 3 errors']) {
  t('result "' + res + '" is still refused as a contradiction', () => refused(L.validateForWrite(ev({ result: res })), /contradicts/));
}
for (const a of ['http://127.0.0.1:4100/api/health', 'n/a', 'desktop/mobile captures']) {
  t('check_passed with evidence and artifact "' + a + '" is not refused as a missing path', () => okWrite(L.validateForWrite(ev({ evidence: 'health 200', artifact: a }))));
}
t('a real missing relative file is still refused as "proof path missing"', () => refused(L.validateForWrite(ev({ evidence: 'x', artifact: '_scratch/does-not-exist-core2f3/out.txt' })), /proof path missing/));
t('a missing ABSOLUTE path with spaces is still refused (this project folder has spaces)', () => refused(L.validateForWrite(ev({ evidence: 'x', artifact: path.join(__dirname, 'no such dir core2f3', 'out') })), /proof path missing/));
t('a missing relative path with spaces and a file extension is still refused', () => refused(L.validateForWrite(ev({ evidence: 'x', artifact: '_scratch/no such dir core2f3/out.txt' })), /proof path missing/));
t('a screenshot proof keeps its file check (URL is not a capture)', () => refused(L.validateForWrite(ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'http://127.0.0.1:4100/shot.png' })), /proof path missing/));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
