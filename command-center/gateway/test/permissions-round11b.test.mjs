// WP-AUTONOMY-GW, security review round 11b (WP-AUTO-SEC2FIX). Each row marked RED was
// run against ecdf03b and failed there; rows without a label guard ordinary work that must stay routine.
//   L1  the gate code was protected only as `command-center/gateway/src|bin.mjs|supervisor.mjs`. A packaged copy
//       (`command-center/desktop/dist/<x>/resources/gateway/src/...`) was a routine write. Now gateway/src, bin.mjs and
//       supervisor.mjs at any depth under command-center, and the whole command-center/desktop/dist tree, ask.
//   N2  a Forge tool (`node .claude/forge-bin/forge-doctor.cjs`, a committed forge-bin test file) runs project code but
//       skipped the write-then-run and first-runner checks. It is now a runner of family 'forge'.
//   I3  Git Bash `/mnt/c/` and `/cygdrive/c/` are no drive mounts (only `/c/` is); such a path is no longer read as C:.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { classifyHardGate } from '../src/permissions/hard-gate.mjs';

const WIN = process.platform === 'win32';
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round11b-')));
const HOME = path.join(BASE, 'home');
const TMP = path.join(BASE, 'temp');
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const P = path.join(BASE, 'proj');
put(path.join(P, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
put(path.join(P, '.git', 'HEAD'), 'ref: refs/heads/main\n');
for (const rel of ['src/a.js', 'notes.txt', '.claude/forge-bin/forge-doctor.cjs', '.claude/forge-bin/forge-doctor.test.cjs']) put(path.join(P, rel));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));

const OPTS = { cwd: P, home: HOME, tmp: TMP };
const run = (tool, input, opts = {}) => classifyHardGate(tool, input, { ...OPTS, ...opts });
const write = (rel) => run('Write', { file_path: path.join(P, ...rel.split('/')), content: 'x' });

describe('L1 packaged gateway copies are gate code', () => {
  for (const rel of [
    'command-center/desktop/dist/win-unpacked/resources/gateway/src/server.mjs',
    'command-center/desktop/dist/win-unpacked/resources/gateway/src/permissions/hard-gate.mjs',
    'command-center/desktop/dist/win-unpacked/resources/gateway/bin.mjs',
    'command-center/desktop/dist/win-unpacked/resources/gateway/supervisor.mjs',
    'command-center/desktop/dist/win-unpacked/resources/app.asar',
    'command-center/desktop/dist/latest.yml',
  ]) {
    test('L1 RED a write to ' + rel + ' asks (settings)', () => {
      const got = write(rel);
      assert.equal(got.code, 'settings', JSON.stringify(got));
    });
  }
  test('the gateway source itself still asks', () => assert.equal(write('command-center/gateway/src/server.mjs').code, 'settings'));
  test('a gateway test file stays routine', () => assert.equal(write('command-center/gateway/test/x.test.mjs').code, 'routine'));
  test('an ordinary source file stays routine', () => assert.equal(write('src/b.js').code, 'routine'));
});

describe('N2 Forge tools are runners (family forge)', () => {
  const doctor = { command: 'node .claude/forge-bin/forge-doctor.cjs' };
  const doctorTest = { command: 'node .claude/forge-bin/forge-doctor.test.cjs' };
  test('N2 RED forge-doctor after an unapproved code write asks (wrote_code)', () => {
    assert.equal(run('Bash', doctor, { codeWritten: true }).code, 'wrote_code');
  });
  test('N2 RED a committed forge-bin test file after an unapproved code write asks (wrote_code)', () => {
    assert.equal(run('Bash', doctorTest, { codeWritten: true }).code, 'wrote_code');
  });
  test('N2 RED the first forge-doctor in a folder after a start asks (first_runner) and names family forge', () => {
    const runners = new Set();
    const got = run('Bash', doctor, { codeWritten: (f) => (f === 'forge' ? 'first_runner' : false), runners });
    assert.equal(got.code, 'first_runner');
    assert.ok(runners.has('forge'), [...runners].join(','));
  });
  test('N2 a trailing slash or other case does not dodge the runner check', () => {
    assert.notEqual(run('Bash', { command: 'node .claude/forge-bin/forge-doctor.cjs/' }, { codeWritten: true }).code, 'routine');
    assert.notEqual(run('Bash', { command: 'node .claude/forge-bin/FORGE-DOCTOR.cjs' }, { codeWritten: true }).code, 'routine');
  });
  test('a read-only Forge tool stays routine after a write (round 6)', () => {
    assert.equal(run('Bash', { command: 'node .claude/forge-bin/forge-runinfo.cjs status' }, { codeWritten: true }).code, 'routine');
  });
  test('forge-doctor on a clean, approved folder stays routine', () => {
    assert.equal(run('Bash', doctor, { codeWritten: () => false }).code, 'routine');
    assert.equal(run('Bash', { command: 'node .claude/forge-bin/forge-doctor.cjs --json' }).code, 'routine');
  });
});

describe('I3 only /<letter>/ is a Git Bash drive', { skip: !WIN && 'Git Bash drive paths are Windows only' }, () => {
  const drive = P[0].toLowerCase();
  const tail = P.slice(3).split(path.sep).join('/');
  test('/' + drive + '/... inside the project stays routine', () => {
    assert.equal(run('Bash', { command: 'cat /' + drive + '/' + tail + '/notes.txt' }).code, 'routine');
  });
  for (const pre of ['/mnt/', '/cygdrive/']) {
    test('I3 RED ' + pre + drive + '/... is not read as the project folder', () => {
      assert.notEqual(run('Bash', { command: 'cat ' + pre + drive + '/' + tail + '/notes.txt' }).code, 'routine');
    });
  }
});
