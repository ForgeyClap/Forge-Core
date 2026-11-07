#!/usr/bin/env node
'use strict';
/**
 * forge-snapshot-mission-eol.test.cjs — category tests O20. FORGE_SNAPSHOT.md kept turning "mixed"
 * (LF + CRLF) after every regeneration: the MISSION block is preserved verbatim, and the one in this repo still
 * carried CRLF from an old copy, while the rest is written with LF. Guard: the preserved block keeps its words but
 * gets LF line endings, so a regenerated snapshot is all-LF.
 */
const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, 'forge-snapshot.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };

const existing = '# FORGE SNAPSHOT\n\n## 1. Mission\n\n<!-- MISSION:BEGIN -->\r\nBuild the thing.\r\nSecond line.\r\n<!-- MISSION:END -->\n\n## 2. State\n';
t('a CRLF mission block is preserved word for word but with LF line endings', () => {
  const m = S.resolveMission(process.cwd(), existing);
  assert.ok(!/\r/.test(m.block), JSON.stringify(m.block));
  assert.strictEqual(m.block, '<!-- MISSION:BEGIN -->\nBuild the thing.\nSecond line.\n<!-- MISSION:END -->');
});
t('an LF mission block is unchanged', () => {
  const m = S.resolveMission(process.cwd(), existing.replace(/\r\n/g, '\n'));
  assert.strictEqual(m.block, '<!-- MISSION:BEGIN -->\nBuild the thing.\nSecond line.\n<!-- MISSION:END -->');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
