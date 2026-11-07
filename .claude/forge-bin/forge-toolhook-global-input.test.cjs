#!/usr/bin/env node
'use strict';
/**
 * forge-toolhook-global-input.test.cjs — W1 (category tests round 6). In windows-game-v6 a Build Boss wrote
 * a launch check that ran `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')` (and Esc, "b") to drive the game.
 * Global input goes to whatever window is in front: it typed into another Claude session's terminal of the owner.
 * Guard: forge-toolhook.cjs (PostToolUse after Write|Edit|MultiEdit) now answers with PostToolUse feedback
 * `{"decision":"block","reason":...}` on stdout when the written code uses global input. The write itself stays (a
 * PostToolUse hook cannot undo it); the reason is shown to the model in Dutch and English.
 *
 * Sections: A) the detector (forge-global-input.cjs scanText), B) feedbackFor() per tool shape, C) the REAL CLI
 * subprocess of forge-toolhook.cjs (exit 0 always, feedback JSON only on a hit, silent otherwise).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'forge-toolhook.cjs');
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gi-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
let GI = null;
try { GI = require('./forge-global-input.cjs'); } catch (e) { GI = null; console.log('  (forge-global-input.cjs not loadable: ' + e.message + ')'); }
const need = () => assert.ok(GI, 'forge-global-input.cjs is missing');

const TMPS = [];
function tmpRoot(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gi-' + label + '-'));
  fs.mkdirSync(path.join(d, '.claude', 'forge-runs'), { recursive: true });
  TMPS.push(d);
  return d;
}

// the real line from windows-game-v6/scripts/launch-check.cjs (before its own fix), and its siblings
const REAL_LINE = "  return ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`);";
const FIRES = [
  REAL_LINE,
  "[System.Windows.Forms.SendKeys]::SendWait('{ESC}')",
  'SendKeys.Send("b");',
  'System.Windows.Forms.SendKeys.SendWait("{ENTER}");',
  '[DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);',
  'ctypes.windll.user32.keybd_event(0x0D, 0, 0, 0)',
  'user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)',
  'shell.AppActivate("Untitled - Notepad")',
  'Interaction.AppActivate(pid)',
];
const SILENT = [
  '// never use SendKeys or SendInput here: post to the hwnd',
  '# SendKeys.SendWait would type into the terminal',
  ' * keybd_event / mouse_event are banned',
  "  [W]::PostMessage($h, 0x0100, [IntPtr]13, [IntPtr]1) | Out-Null",
  "await driver.findElement(By.id('q')).sendKeys('forge');", // Selenium: element input, not global
  'element.send_keys("forge")',
  'function handleSendInput(e) { submit(); }',
  'const mouse_event = window.event;',
  'SendMessage(hwnd, WM_CHAR, ch, 0);',
  // the project's own guard (windows-game-v6/scripts/check-no-global-input.cjs) names the APIs in a regex: no call
  'const BANNED = /\\b(SendKeys|SendWait|SendInput|keybd_event|mouse_event)\\b/;',
];

console.log('forge-toolhook global-input feedback tests (W1, 2026-11-07)');
console.log('\nA) scanText — global input in code, not in comments or element-scoped APIs');
for (const line of FIRES) {
  t('A fires: ' + JSON.stringify(line).slice(0, 90), () => {
    need();
    const hits = GI.scanText(line);
    assert.ok(hits.length >= 1, 'no hit');
    assert.strictEqual(hits[0].line, 1);
  });
}
for (const line of SILENT) {
  t('A silent: ' + JSON.stringify(line).slice(0, 90), () => {
    need();
    assert.deepStrictEqual(GI.scanText(line), []);
  });
}
t('A WScript.Shell .SendKeys fires only with the WScript.Shell object in view (Selenium C# element.SendKeys stays silent)', () => {
  need();
  const vbs = 'Set sh = WScript.CreateObject("WScript.Shell")\nsh.SendKeys "{ENTER}"';
  assert.deepStrictEqual(GI.scanText(vbs).map((h) => h.line), [2]);
  const ps = '$w = New-Object -ComObject WScript.Shell\n$w.SendKeys("b")';
  assert.deepStrictEqual(GI.scanText(ps).map((h) => h.line), [2]);
  assert.deepStrictEqual(GI.scanText('driver.FindElement(By.Id("q")).SendKeys("forge");'), []);
  assert.deepStrictEqual(GI.scanText('x.SendKeys("{ENTER}")', { wscriptContext: true }).map((h) => h.line), [1]);
});
t('A reports the right line numbers in a multi-line file, CRLF included', () => {
  need();
  const src = ['const a = 1;', '// SendKeys in a comment', "ps(\"[System.Windows.Forms.SendKeys]::SendWait('b')\");", 'ok();'].join('\r\n');
  assert.deepStrictEqual(GI.scanText(src).map((h) => h.line), [3]);
});
t('A never throws on odd input', () => {
  need();
  for (const v of [null, undefined, 42, {}, '', '\u0000'.repeat(10)]) assert.deepStrictEqual(GI.scanText(v), []);
});

console.log('\nB) feedbackFor — which tool calls get feedback');
const ROOT_B = tmpRoot('b');
const write = (rel, content) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(ROOT_B, rel), content } });
t('B Write of a .cjs with SendWait -> a NL + EN reason with file:line, the hwnd/PostMessage alternative and the self-test hook', () => {
  need();
  const fb = GI.feedbackFor(write('scripts/launch-check.cjs', 'x();\n' + REAL_LINE + '\n'), { root: ROOT_B });
  assert.ok(fb && fb.decision === 'block', JSON.stringify(fb));
  assert.ok(fb.reason.includes('scripts/launch-check.cjs:2'), fb.reason);
  assert.ok(/PostMessage/.test(fb.reason) && /hwnd/.test(fb.reason), 'names the window-handle route');
  assert.ok(/self-test/.test(fb.reason), 'names the self-test route');
  assert.ok(/venster/.test(fb.reason) && /window/.test(fb.reason), 'Dutch and English');
  assert.ok(/terminal/.test(fb.reason), 'says why: it once typed into the owner terminal');
});
t('B Markdown/docs files are ignored', () => {
  need();
  for (const f of ['docs/notes.md', 'README.markdown', 'docs/x.mdx', 'notes.txt', 'docs/a.rst']) {
    assert.strictEqual(GI.feedbackFor(write(f, REAL_LINE), { root: ROOT_B }), null, f);
  }
});
t('B the project\'s own .claude/ tree and node_modules are skipped', () => {
  need();
  assert.strictEqual(GI.feedbackFor(write('.claude/forge-bin/x.cjs', REAL_LINE), { root: ROOT_B }), null);
  assert.strictEqual(GI.feedbackFor(write('node_modules/robot/index.js', REAL_LINE), { root: ROOT_B }), null);
});
t('B Edit (new_string) and MultiEdit (edits[].new_string) are scanned', () => {
  need();
  const f = path.join(ROOT_B, 'src', 'drive.ps1');
  const e = GI.feedbackFor({ tool_name: 'Edit', tool_input: { file_path: f, old_string: 'a', new_string: "[System.Windows.Forms.SendKeys]::SendWait('{ESC}')" } }, { root: ROOT_B });
  assert.ok(e && e.decision === 'block', 'Edit');
  const m = GI.feedbackFor({ tool_name: 'MultiEdit', tool_input: { file_path: f, edits: [{ old_string: 'a', new_string: 'ok()' }, { old_string: 'b', new_string: 'user32.keybd_event(13, 0, 0, 0)' }] } }, { root: ROOT_B });
  assert.ok(m && m.decision === 'block', 'MultiEdit');
});
t('B an Edit adding .SendKeys( fires when the file on disk holds the WScript.Shell object', () => {
  need();
  const f = path.join(ROOT_B, 'tools', 'drive.vbs');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'Set sh = WScript.CreateObject("WScript.Shell")\nsh.SendKeys "x"\n');
  const e = GI.feedbackFor({ tool_name: 'Edit', tool_input: { file_path: f, old_string: '"x"', new_string: 'sh.SendKeys "{ENTER}"' } }, { root: ROOT_B });
  assert.ok(e && e.decision === 'block');
});
t('B clean code, a Read/Bash tool, and malformed payloads give null (no feedback), never a throw', () => {
  need();
  assert.strictEqual(GI.feedbackFor(write('src/app.js', 'PostMessage(hwnd, WM_KEYDOWN, VK_RETURN, 0);'), { root: ROOT_B }), null);
  assert.strictEqual(GI.feedbackFor({ tool_name: 'Bash', tool_input: { command: REAL_LINE } }, { root: ROOT_B }), null);
  assert.strictEqual(GI.feedbackFor({ tool_name: 'Read', tool_input: { file_path: 'x.cjs' } }, { root: ROOT_B }), null);
  for (const p of [null, 'x', 1, {}, { tool_name: 'Write' }, { tool_name: 'Write', tool_input: { content: REAL_LINE } }, { tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: 'x' } }]) {
    assert.strictEqual(GI.feedbackFor(p, { root: ROOT_B }), null, JSON.stringify(p));
  }
});
t('B the reason is shared with the gate hook wording (forge-gate-messages.cjs WORDS["global-input-command"])', () => {
  need();
  const W = require('./forge-gate-messages.cjs').WORDS['global-input-command'];
  assert.ok(W, 'no gate wording');
  const fb = GI.feedbackFor(write('a.js', 'SendKeys.Send("b")'), { root: ROOT_B });
  for (const k of ['nl', 'en', 'safeNl', 'safeEn']) assert.ok(fb.reason.includes(W[k]), k);
});

console.log('\nC) the real forge-toolhook.cjs CLI (PostToolUse) — feedback on a hit, silent otherwise, always exit 0');
function runCli(obj, root) {
  const input = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return spawnSync(process.execPath, [HOOK], { input, cwd: root, encoding: 'utf8', timeout: 25000,
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }) });
}
t('C Write with global input -> exit 0 and stdout is exactly one PostToolUse feedback object {decision:"block", reason}', () => {
  const root = tmpRoot('c1');
  const r = runCli({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, 'scripts', 'launch-check.cjs'), content: REAL_LINE }, tool_response: { success: true } }, root);
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' stderr=' + r.stderr);
  let out;
  try { out = JSON.parse(r.stdout); } catch { assert.fail('stdout is not JSON: ' + JSON.stringify(r.stdout)); }
  assert.strictEqual(out.decision, 'block');
  assert.ok(typeof out.reason === 'string' && out.reason.includes('scripts/launch-check.cjs:1'), out.reason);
});
t('C Edit with global input via the CLI -> feedback', () => {
  const root = tmpRoot('c2');
  const r = runCli({ session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'drive.ps1'), old_string: 'a', new_string: 'user32.mouse_event(2, 0, 0, 0, 0)' } }, root);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).decision, 'block');
});
t('C clean Write, a .md Write, a Bash call and garbage stay byte-silent (exit 0, empty stdout)', () => {
  const root = tmpRoot('c3');
  const cases = [
    { session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(root, 'a.js'), content: 'PostMessage(h, 0x100, 13, 1);' } },
    { session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs', 'a.md'), content: REAL_LINE } },
    { session_id: 's1', tool_name: 'Bash', tool_input: { command: REAL_LINE } },
    'not json {{{',
  ];
  for (const c of cases) {
    const r = runCli(c, root);
    assert.strictEqual(r.status, 0, JSON.stringify(c).slice(0, 60));
    assert.strictEqual(r.stdout, '', 'stdout for ' + JSON.stringify(c).slice(0, 60) + ': ' + JSON.stringify(r.stdout));
  }
});

t('C fail-open: a throwing or absent detector, a truncated payload and a non-file tool give "" (nothing printed)', () => {
  const hook = require('./forge-toolhook.cjs');
  const raw = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a.js', content: REAL_LINE } });
  assert.strictEqual(hook.globalInputFeedback(raw, { root: ROOT_B, globalInputModule: { feedbackFor: () => { throw new Error('boom'); } } }), '');
  assert.strictEqual(hook.globalInputFeedback(raw, { root: ROOT_B, globalInputModule: null }), '');
  assert.strictEqual(hook.globalInputFeedback(raw, { root: ROOT_B, truncated: true }), '');
  assert.strictEqual(hook.globalInputFeedback(JSON.stringify({ tool_name: 'Bash', tool_input: { command: REAL_LINE } }), { root: ROOT_B }), '');
  assert.strictEqual(JSON.parse(hook.globalInputFeedback(raw, { root: ROOT_B })).decision, 'block');
});

for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
try { fs.rmSync(CONFIG_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
