#!/usr/bin/env node
'use strict';
/**
 * forge-eol-drift.test.cjs — category tests 2026-11-07: Windows edits turned 7 LF files into CRLF unnoticed. The guard
 * flags a modified tracked file whose line-ending style differs from HEAD, and stays quiet for a real LF edit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const E = require('./forge-eol-drift.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-'));
const g = (...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=t@t', '-c', 'user.name=t'].concat(a), { cwd: TMP, encoding: 'utf8' });

t('eolStyle tells lf, crlf, mixed and none apart', () => {
  assert.deepStrictEqual([E.eolStyle('a\nb\n'), E.eolStyle('a\r\nb\r\n'), E.eolStyle('a\r\nb\n'), E.eolStyle('ab')], ['lf', 'crlf', 'mixed', 'none']);
});
t('a CRLF rewrite of an LF file is drift; a real LF edit and an untouched file are not', () => {
  assert.strictEqual(g('init', '-q').status, 0);
  assert.strictEqual(g('config', 'core.autocrlf', 'false').status, 0); // the tool reads the repo's own config
  fs.writeFileSync(path.join(TMP, 'a.cjs'), 'one\ntwo\n');
  fs.writeFileSync(path.join(TMP, 'b.md'), 'x\ny\n');
  fs.writeFileSync(path.join(TMP, 'c.md'), 'keep\n');
  g('add', '.'); assert.strictEqual(g('commit', '-q', '-m', 'base').status, 0);
  fs.writeFileSync(path.join(TMP, 'a.cjs'), 'one\r\ntwo\r\nthree\r\n'); // edited AND switched to CRLF
  fs.writeFileSync(path.join(TMP, 'b.md'), 'x\ny\nz\n'); // real edit, still LF
  const r = E.eolDrift(TMP);
  assert.strictEqual(r.applicable, true);
  assert.deepStrictEqual(r.drift, [{ file: 'a.cjs', before: 'lf', after: 'crlf' }]);
});
t('FB-INSTALL-1-F7: with core.autocrlf=true a CRLF work tree over an LF blob is normal, a one-line edit is no drift', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-autocrlf-'));
  const ga = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t'].concat(a), { cwd: repo, encoding: 'utf8' });
  try {
    assert.strictEqual(ga('init', '-q').status, 0);
    assert.strictEqual(ga('config', 'core.autocrlf', 'true').status, 0);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\r\ntwo\r\n');
    ga('add', '.'); assert.strictEqual(ga('commit', '-q', '-m', 'base').status, 0);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\r\nTWO\r\n'); // real one-line edit, CRLF as git checks it out
    const r = E.eolDrift(repo);
    assert.strictEqual(r.applicable, true);
    assert.deepStrictEqual(r.drift, []);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
t('outside a git work tree it is n/a, never a pass that looked', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-plain-'));
  const r = E.eolDrift(plain);
  fs.rmSync(plain, { recursive: true, force: true });
  assert.strictEqual(r.applicable, false);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
