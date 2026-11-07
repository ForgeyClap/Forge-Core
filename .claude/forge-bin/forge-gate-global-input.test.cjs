#!/usr/bin/env node
'use strict';
/**
 * forge-gate-global-input.test.cjs — W1 (category tests round 6): the command gate `global-input-command`.
 * In windows-game-v6 a launch check drove the game with `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`; global
 * input goes to whatever window is in front and typed into the owner's other terminal. A Bash/PowerShell command whose
 * OWN text uses those APIs (SendKeys, SendWait, SendInput, keybd_event, mouse_event, WScript.Shell SendKeys/AppActivate)
 * is now blocked by forge-gate-hook.cjs. The quoted-data rule holds: a grep for "SendKeys", an echo literal or a commit
 * message only MENTION it and pass.
 *
 * Sections: 1) classify() verdicts, 2) mutation (line_all_of is load-bearing), 3) the REAL spawned hook, 4) the
 * cannot-judge keyword scan mirrors the gate.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gate = require('./forge-actiongate.cjs');
const CJ = require('./forge-gate-cannot-judge.cjs');
const ID = 'global-input-command';
const HOOK = path.join(__dirname, 'forge-gate-hook.cjs');
const CONFIG = path.join(__dirname, '..', 'config', 'orchestration', 'hard-gates.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-gi-'));
const HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'project');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const fires = (text, opts) => (gate.classify(text, opts).matched || []).includes(ID);

const BLOCKS = [
  { tool: 'Bash', cmd: "powershell -c \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')\"" },
  { tool: 'Bash', cmd: "powershell.exe -NoProfile -Command \"[System.Windows.Forms.SendKeys]::SendWait('{ESC}')\"" },
  { tool: 'Bash', cmd: "pwsh -c '$w = New-Object -ComObject WScript.Shell; $w.SendKeys(\"b\")'" },
  { tool: 'PowerShell', cmd: "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')" },
  { tool: 'PowerShell', cmd: "$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate('Game'); $ws.SendKeys('{ENTER}')" },
  { tool: 'PowerShell', cmd: 'Add-Type -TypeDefinition \'public class K { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e); }\'; [K]::keybd_event(13, 0, 0, [UIntPtr]::Zero)' },
  { tool: 'Bash', cmd: 'python -c "import ctypes; ctypes.windll.user32.mouse_event(2, 0, 0, 0, 0)"' },
  { tool: 'Bash', cmd: "node -e \"require('child_process').execSync('powershell -c [System.Windows.Forms.SendKeys]::SendWait(1)')\"" },
];
const ALLOWS = [
  { tool: 'Bash', cmd: 'grep -rn "SendKeys" scripts' },
  { tool: 'Bash', cmd: "rg -n 'SendWait\\(' scripts tools" },
  { tool: 'PowerShell', cmd: "Select-String -Pattern '[System.Windows.Forms.SendKeys]::SendWait' -Path scripts\\*.cjs" },
  { tool: 'Bash', cmd: 'echo "never use [System.Windows.Forms.SendKeys]::SendWait in tests"' },
  { tool: 'Bash', cmd: 'git commit -m "guard: block SendKeys.SendWait( and keybd_event( in launch checks"' },
  { tool: 'Bash', cmd: 'node scripts/check-no-global-input.cjs' },
  { tool: 'Bash', cmd: 'node .claude/forge-bin/forge-global-input.cjs scripts/launch-check.cjs' },
  { tool: 'PowerShell', cmd: "[W]::PostMessage($h, 0x0100, [IntPtr]13, [IntPtr]1) | Out-Null" },
  { tool: 'Bash', cmd: 'npm test' },
];
// the hook strips inert data (heredoc bodies, log-event payloads) before it classifies; classify() alone does not
const HOOK_ONLY_ALLOWS = [
  { tool: 'Bash', cmd: "cat <<'EOF' > docs/notes.md\n[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')\nEOF" },
  { tool: 'Bash', cmd: "node .claude/forge-dashboard/log-event.cjs '{\"msg\":\"blocked [System.Windows.Forms.SendKeys]::SendWait in launch-check\"}'" },
];

console.log('forge-gate global-input-command tests (W1, 2026-11-07)');
console.log('\n1) classify() — the API in a command\'s own code fires; a mention in quoted data does not');
for (const c of BLOCKS) {
  t('fires [' + c.tool + '] ' + JSON.stringify(c.cmd).slice(0, 90), () => assert.ok(fires(c.cmd), JSON.stringify(gate.classify(c.cmd).matched)));
}
for (const c of ALLOWS) {
  t('silent [' + c.tool + '] ' + JSON.stringify(c.cmd).slice(0, 90), () => assert.ok(!fires(c.cmd), JSON.stringify(gate.classify(c.cmd).matched)));
}
t('the gate is a hook-enforced command gate of class irreversible, with NL+EN wording', () => {
  const g = gate.loadGates().gates.find((x) => x.id === ID);
  assert.ok(g, 'no gate ' + ID);
  assert.strictEqual(g.match.kind, 'command');
  assert.strictEqual(g.class, 'irreversible');
  assert.ok(gate.KNOWN_GATES.includes(ID));
  const W = require('./forge-gate-messages.cjs').WORDS[ID];
  assert.ok(W && W.nl && W.en && /PostMessage/.test(W.safeEn) && /hwnd/.test(W.safeNl));
});

console.log('\n2) mutation — the inline-interpreter rule (line_all_of) is what catches `powershell -c "..."`');
t('MUTATION: without match.line_all_of a quoted -c argument goes silent; with it, it fires', () => {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  delete cfg.gates.find((g) => g.id === ID).match.line_all_of;
  const p = path.join(TMP, 'hard-gates.no-line-all-of.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  const cmd = BLOCKS[0].cmd;
  assert.ok(!fires(cmd, { configPath: p }), 'expected silence without line_all_of');
  assert.ok(fires(cmd), 'expected the real config to fire');
  assert.ok(fires(BLOCKS[3].cmd, { configPath: p }), 'the direct PowerShell form needs only the segment pattern');
});

console.log('\n3) the REAL spawned PreToolUse hook');
function spawnHook(c) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: c.tool, tool_input: { command: c.cmd } }),
    encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: PROJ }),
  });
}
for (const c of BLOCKS) {
  t('hook BLOCKS (exit 2) [' + c.tool + '] ' + JSON.stringify(c.cmd).slice(0, 80), () => {
    const r = spawnHook(c);
    assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
    assert.ok(r.stderr.split('\n')[0].includes(ID), r.stderr.split('\n')[0]);
    assert.ok(r.stderr.includes('Forge vraagt eerst') && r.stderr.includes('Forge asks first'), 'NL and EN');
    assert.ok(r.stderr.includes('PostMessage') && r.stderr.includes('terminal'), 'names the hwnd route and why');
    assert.strictEqual(r.stdout, '');
  });
}
for (const c of ALLOWS.concat(HOOK_ONLY_ALLOWS)) {
  t('hook ALLOWS (exit 0) [' + c.tool + '] ' + JSON.stringify(c.cmd).slice(0, 80), () => {
    const r = spawnHook(c);
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
  });
}

console.log('\n4) the cannot-judge keyword scan reports this gate for every blocked shape');
t('riskySignals() names ' + ID + ' for every BLOCKS command and every examples.match string', () => {
  const g = gate.loadGates().gates.find((x) => x.id === ID);
  const all = BLOCKS.map((c) => c.cmd).concat((g && g.examples && g.examples.match) || []);
  const missing = all.filter((cmd) => !CJ.riskySignals(cmd).includes(ID));
  assert.deepStrictEqual(missing, []);
});

t('the classifier-unavailable FALLBACK_RE of the hook also blocks every BLOCKS command', () => {
  const hook = require('./forge-gate-hook.cjs');
  const missing = BLOCKS.map((c) => c.cmd).filter((cmd) => !hook.FALLBACK_RE.test(cmd));
  assert.deepStrictEqual(missing, []);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
