#!/usr/bin/env node
'use strict';
// forge-rotator-setup.test.cjs — tests for the owner-run enrolment wizard forge-rotator-setup.ps1 (run
//). Every spawn uses a FAKE account-rotator.cjs in a fresh os.tmpdir() folder
// that records its argv, stdin and environment; the real rotator, the real vault and every real credential are never
// touched. The token is a generated fake (sk-ant-oat01-SELFTEST-<hex>) that the script creates inside -SelfTest.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'forge-rotator-setup.ps1');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rotator-setup-test-'));
process.env.FORGE_ACCOUNT_ROTATOR_HOME = path.join(TMP, 'trap-home'); // the vault module below only ever sees a trap
const vault = require('./account-rotator-vault.cjs');

let passed = 0, failed = 0, skipped = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const FAKE = path.join(TMP, 'fake-account-rotator.cjs');
fs.writeFileSync(FAKE, [
  "'use strict';",
  "const fs = require('fs');",
  "let d = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => { d += c; });",
  "process.stdin.on('end', () => {",
  "  fs.writeFileSync(process.env.FAKE_ROTATOR_RECORD, JSON.stringify({ argv: process.argv, stdin: d, env: process.env }));",
  "  console.log('token ingeschreven / token enrolled: ' + process.argv[3] + ' [token]');",
  "});",
].join('\n'));

const AGENT_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
function runPs(extraArgs, envPatch, dropKeys) {
  const env = Object.assign({}, process.env, envPatch || {});
  for (const k of dropKeys || []) delete env[k];
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...extraArgs],
    { env, encoding: 'utf8', timeout: 90000, windowsHide: true });
}
function selftestJson(r) {
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('SELFTEST-JSON '));
  assert.ok(line, 'no SELFTEST-JSON line; stdout=' + r.stdout + ' stderr=' + r.stderr);
  return JSON.parse(line.slice('SELFTEST-JSON '.length));
}

// ---- static checks (run everywhere) ---------------------------------------------------------------------------
t('static: ASCII-only source (PowerShell 5.1 reads a BOM-less .ps1 as ANSI)', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SRC), 'non-ASCII character found');
});
t('static: $ErrorActionPreference = Stop and the CLAUDECODE refusal are present', () => {
  assert.ok(/^\$ErrorActionPreference = 'Stop'/m.test(SRC));
  assert.ok(SRC.includes("'CLAUDECODE'"));
  assert.ok(/exit 2/.test(SRC) && /exit 3/.test(SRC));
});
t('static: the token is read only with Read-Host -AsSecureString and converted exactly once', () => {
  assert.ok(/Read-Host -AsSecureString/.test(SRC));
  assert.strictEqual((SRC.match(/-AsPlainText/g) || []).length, 0, 'no -AsPlainText anywhere');
  assert.strictEqual((SRC.match(/SecureStringToBSTR/g) || []).length, 1, 'one controlled conversion');
  assert.strictEqual((SRC.match(/ZeroFreeBSTR/g) || []).length, 1);
  assert.ok(/\$plain = \$null/.test(SRC), 'plain copy cleared');
});
t('static: nothing writes the token to disk, screen, history or an environment variable', () => {
  assert.ok(!/\b(Out-File|Set-Content|Add-Content|Export-Clixml|Export-Csv|Start-Transcript|Add-History|Tee-Object)\b/i.test(SRC), 'a file/transcript/history writer is present');
  assert.ok(!/(Write-Host|Write-Output|Write-Verbose|Write-Debug|Write-Information)[^\r\n]*\$(plain|sec|bytes|bstr|token)\b/i.test(SRC), 'a writer prints the token');
  assert.ok(!/\$env:FORGE_ROTATOR_ENROLL_TOKEN\s*=/.test(SRC), 'the token env var is never set');
  assert.ok(/EnvironmentVariables\.Remove\('FORGE_ROTATOR_ENROLL_TOKEN'\)/.test(SRC), 'the child env drops FORGE_ROTATOR_ENROLL_TOKEN');
});
t('static: every rotator command the wizard uses exists in account-rotator-cli.cjs', () => {
  const cli = fs.readFileSync(path.join(__dirname, 'account-rotator-cli.cjs'), 'utf8');
  for (const c of ["case 'enroll-token'", "case 'status'", "case 'start'", "case 'launch'"]) assert.ok(cli.includes(c), c);
  assert.ok(/launch \[--account <name>\|--auto\] -- <claude args>/.test(cli), 'launch --auto -- syntax');
  assert.ok(SRC.includes("@('enroll-token', $name)") && SRC.includes("@('status')") && SRC.includes('launch --auto -- <claude args>'));
});

// ---- live checks (Windows PowerShell) ------------------------------------------------------------------------
const psOk = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
if (!psOk) { skipped++; console.log('  skip live PowerShell checks — powershell.exe not available'); }
else {
  const rec = path.join(TMP, 'record.json');
  const r = runPs(['-SelfTest', '-RotatorPath', FAKE, '-NodePath', process.execPath],
    { FAKE_ROTATOR_RECORD: rec, FORGE_ROTATOR_ENROLL_TOKEN: 'leftover-env-value-must-not-reach-child' });
  let j = null;
  t('selftest: exits 0 and reports ok', () => {
    j = selftestJson(r);
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' stderr=' + r.stderr);
    assert.strictEqual(j.ok, true);
  });
  t('selftest: the name rule matches the rotator\'s own vault.validName on every sample', () => {
    assert.ok(j && j.names.length >= 15);
    for (const n of j.names) assert.strictEqual(n.valid, vault.validName(n.name), JSON.stringify(n.name));
  });
  t('selftest: refusal rules (agent marker, -NonInteractive, piped input; script args and empty markers ignored)', () => {
    assert.strictEqual(j.refusal.agent, 'agent:CLAUDECODE');
    assert.strictEqual(j.refusal.agentEmptyIgnored, null);
    assert.strictEqual(j.refusal.nonInteractiveFlag, 'noninteractive');
    assert.strictEqual(j.refusal.redirectedInput, 'noninteractive');
    assert.strictEqual(j.refusal.scriptArgNotCounted, null);
    assert.ok(j.refusal.thisProcess, 'this -NonInteractive test process itself must be refused');
  });
  t('dry enrolment: token on stdin only — absent from argv, env and the script\'s own output', () => {
    const got = JSON.parse(fs.readFileSync(rec, 'utf8'));
    assert.deepStrictEqual(got.argv.slice(2), ['enroll-token', 'selftest-acct']);
    const tok = got.stdin.replace(/^﻿/, '').trim();
    assert.ok(/^sk-ant-oat01-SELFTEST-[0-9a-f]{32}$/.test(tok), 'stdin carried the token');
    assert.ok(!got.argv.some((a) => a.includes(tok)), 'token in argv');
    assert.ok(!Object.values(got.env).some((v) => String(v).includes(tok)), 'token in child env');
    assert.ok(!('FORGE_ROTATOR_ENROLL_TOKEN' in got.env), 'FORGE_ROTATOR_ENROLL_TOKEN leaked into the child');
    assert.ok(!String(r.stdout).includes(tok) && !String(r.stderr).includes(tok), 'token in the script output');
    assert.strictEqual(j.dry.tokenEchoed, false);
    assert.ok(/token enrolled: selftest-acct/.test(j.dry.out), 'rotator result line shown');
  });
  t('selftest refuses to run its dry enrolment against the real account-rotator.cjs', () => {
    const r2 = runPs(['-SelfTest', '-RotatorPath', path.join(__dirname, 'account-rotator.cjs'), '-NodePath', process.execPath], {});
    const j2 = selftestJson(r2);
    assert.strictEqual(r2.status, 1);
    assert.strictEqual(j2.dry.ran, false);
    assert.ok(/refused/.test(j2.dry.error));
  });
  t('wizard refuses inside an agent (CLAUDECODE set): exit 2, nothing enrolled', () => {
    const rec3 = path.join(TMP, 'record-agent.json');
    const r3 = runPs(['-RotatorPath', FAKE, '-NodePath', process.execPath], { CLAUDECODE: '1', FAKE_ROTATOR_RECORD: rec3 });
    assert.strictEqual(r3.status, 2, 'exit ' + r3.status + ' ' + r3.stderr);
    assert.ok(/REFUSED/.test(r3.stderr) && /AI agent/.test(r3.stderr));
    assert.ok(!fs.existsSync(rec3));
  });
  t('wizard refuses a non-interactive session (no agent marker): exit 3, nothing enrolled', () => {
    const rec4 = path.join(TMP, 'record-nonint.json');
    const r4 = runPs(['-RotatorPath', FAKE, '-NodePath', process.execPath], { FAKE_ROTATOR_RECORD: rec4 }, AGENT_KEYS);
    assert.strictEqual(r4.status, 3, 'exit ' + r4.status + ' ' + r4.stderr);
    assert.ok(/interactive/.test(r4.stderr));
    assert.ok(!fs.existsSync(rec4));
  });
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exit(failed ? 1 : 0);
