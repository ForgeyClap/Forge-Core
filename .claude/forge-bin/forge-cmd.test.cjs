#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-cmd.test.cjs — argument handling of forge.cmd (FB-MISC-2-F1). Windows only (cmd.exe).
// Each argument token below is quote-balanced for the OUTER cmd line, so the outer shell never sees a bare
// ampersand; the old dispatcher re-expanded the argument inside a new pair of quotes (the tilde form), which
// flipped the quote state and broke the line (exit 255) or ran the rest as a command. Runs in a temp cwd; the
// log-event cases only reach log-event.cjs with a missing --file path, so nothing is ever written.
// Part 2 checks the unattended monthly sweep wrapper (maand-sweep.cmd + its prompt) statically (FB-MISC-2-F2/F3).
// FORGE_CMD_TEST_DIR=<dir> points the test at other copies of these files (used to prove the test red on the old files).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); } }

const DIR = process.env.FORGE_CMD_TEST_DIR || __dirname;
const CMD = path.join(DIR, 'forge.cmd');
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cmd-'));
function run(tokens) {
  const line = '"' + CMD + '" ' + tokens.join(' ');
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], { encoding: 'utf8', windowsVerbatimArguments: true, cwd: CWD, timeout: 30000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('forge-cmd tests');
if (process.platform !== 'win32') {
  console.log('  skip (cmd.exe only exists on Windows)');
} else {
  t('a 4th argument with an embedded ampersand is refused with exit 2, never run as a command', () => {
    const r = run(['log-event', 'no-such-run-zz9', 'wp_completed', 'a"&echo PWN-d7e8"']);
    assert.strictEqual(r.code, 2, r.out);
    assert.ok(/only a \.json file is accepted/.test(r.out), r.out);
    assert.ok(!/PWN-d7e8/.test(r.out), r.out);
  });
  t('a hostile first argument shows the command list, not a cmd syntax error', () => {
    const r = run(['a"&echo PWN-f9a0"']);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/Forge commands:/.test(r.out), r.out);
    assert.ok(!/PWN-f9a0/.test(r.out), r.out);
  });
  t('inline text that is not a .json path is refused with exit 2', () => {
    const r = run(['log-event', 'no-such-run-zz9', 'wp_completed', 'inline-not-json']);
    assert.strictEqual(r.code, 2, r.out);
  });
  t('a quoted .json path with spaces still reaches log-event.cjs as one --file argument', () => {
    const r = run(['log-event', 'no-such-run-zz9', 'wp_completed', '"C:\\no such dir zz9\\p.json"']);
    assert.ok(/--file C:\\no such dir zz9\\p\.json: ENOENT/.test(r.out), r.out);
  });
}
fs.rmdirSync(CWD);

const SWEEP_CMD = path.join(DIR, 'maand-sweep.cmd');
const SWEEP_PROMPT = path.join(DIR, 'maand-sweep-prompt.txt');
if (!fs.existsSync(SWEEP_CMD) || !fs.existsSync(SWEEP_PROMPT)) {
  console.log('  skip maand-sweep.cmd is not part of this distribution (maintainer-only unattended wrapper)');
} else {
  const cmdText = fs.readFileSync(SWEEP_CMD, 'utf8');
  const promptText = fs.readFileSync(SWEEP_PROMPT, 'utf8');
  t('the unattended sweep never runs with bypassPermissions and passes an explicit tool allowlist', () => {
    assert.ok(!/bypassPermissions/.test(cmdText.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l)).join('\n')), 'bypassPermissions on a command line');
    assert.ok(/--allowedTools\s/.test(cmdText), 'no --allowedTools');
    assert.ok(!/"Bash"|"Write"|"Edit"/.test(cmdText), 'an unscoped Bash/Write/Edit entry');
    assert.ok(/"Write\(\.claude\/forge-research\/\*\*\)"/.test(cmdText), 'writes are not scoped to forge-research');
  });
  t('FB-MISC-2-F4: the unattended sweep waits on background tasks for a FINITE time (never ceiling 0 = forever)', () => {
    const m = /^\s*set "?CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=(\d+)"?\s*$/im.exec(cmdText);
    assert.ok(m, 'no CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS line');
    const ms = Number(m[1]);
    assert.ok(ms > 600000 && ms <= 4 * 3600000, 'ceiling ' + ms + ' ms is not a finite wait above the old 600 s cut-off');
  });
  t('maand-sweep.cmd stays pure ASCII (cmd.exe mangles other bytes in its OEM code page)', () => {
    assert.ok(!/[^\x00-\x7F]/.test(cmdText));
  });
  t('the sweep prompt sends lessons through forge-memory.cjs and never asks for a raw append to lessons.jsonl', () => {
    assert.ok(/forge-memory\.cjs global add/.test(promptText), 'no forge-memory.cjs global add');
    assert.ok(!/toe aan \.claude\/agent-memory\/global\/lessons\.jsonl/.test(promptText), 'raw append instruction still there');
    assert.ok(/onbetrouwbare DATA/.test(promptText), 'no untrusted-data warning');
  });
  t('the sweep prompt logs run_started first and closes through the run contract, run_completed only when green', () => {
    const started = promptText.indexOf('run_started');
    assert.ok(started > -1 && started < promptText.indexOf('1. Zoek'), 'run_started is not the first step');
    assert.ok(/forge-runcontract\.cjs plan --run/.test(promptText) && /--finalize/.test(promptText), 'no run contract close');
    assert.ok(/run_completed[^\n]*ALLEEN als de check daarvoor groen is/.test(promptText), 'run_completed is not conditional on a green check');
  });
}
// Part 3 (FB-MISC-2-F5): start-command-center.cmd in a copy with no command-center\ exits 1 instead of reporting success.
const SCC = path.join(DIR, 'start-command-center.cmd');
if (process.platform === 'win32' && fs.existsSync(SCC)) {
  t('start-command-center.cmd exits 1 (and says why) when command-center\\gateway\\supervisor.mjs is missing', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scc-'));
    try {
      const bin = path.join(proj, '.claude', 'forge-bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.copyFileSync(SCC, path.join(bin, 'start-command-center.cmd'));
      const r = spawnSync('cmd.exe', ['/d', '/c', path.join(bin, 'start-command-center.cmd')], { encoding: 'utf8', cwd: proj, timeout: 30000 });
      assert.strictEqual(r.status, 1, (r.stdout || '') + (r.stderr || ''));
      assert.ok(/supervisor\.mjs/.test((r.stdout || '') + (r.stderr || '')), (r.stdout || '') + (r.stderr || ''));
    } finally { // a node the old script started may still hold the folder for a moment: bounded retries
      try { fs.rmSync(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log('  note: temp folder left for the OS to clean: ' + proj + ' (' + e.code + ')'); }
    }
  });
}
// Part 4 (FB-MISC-2-F6): forge.ps1 log-event forwards --file (and a .json path) to log-event.cjs unchanged.
const PS1 = path.join(DIR, 'forge.ps1');
if (process.platform === 'win32' && fs.existsSync(PS1) && fs.existsSync(path.join(DIR, '..', 'forge-dashboard', 'log-event.cjs'))) {
  const ps = (tokens) => { const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1].concat(tokens), { encoding: 'utf8', cwd: os.tmpdir(), timeout: 60000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  t('forge.ps1 log-event <run> <type> --file <path> reaches log-event.cjs as --file, not as inline JSON', () => {
    const r = ps(['log-event', 'no-such-run-zz9', 'wp_completed', '--file', 'C:\\no-such-dir-zz9\\p.json']);
    assert.ok(!/Invalid extra JSON/.test(r.out), r.out);
    assert.ok(/--file C:\\no-such-dir-zz9\\p\.json: ENOENT/.test(r.out), r.out);
  });
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
