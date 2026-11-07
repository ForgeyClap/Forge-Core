#!/usr/bin/env node
'use strict';
/**
 * forge-global-input.cjs — finds GLOBAL keyboard/mouse input in code a tool call just wrote (W1, category tests round 6,
 * 2026-11-07). In windows-game-v6 a Build Boss drove the game with `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`
 * (and Esc, "b"). Global input goes to whatever window is in front, and it typed into another Claude session's terminal
 * of the owner. forge-toolhook.cjs (PostToolUse, Write|Edit|MultiEdit) calls feedbackFor() and, on a hit, prints
 * Claude Code PostToolUse feedback `{"decision":"block","reason":...}`: the write stays, the model reads the reason.
 * The command-line twin is the hard gate `global-input-command` in hard-gates.json (forge-gate-hook.cjs).
 *
 * WHAT COUNTS: Windows Forms SendKeys.Send/SendWait (also `[System.Windows.Forms.SendKeys]::SendWait`), SendWait(,
 * Win32 SendInput, keybd_event(, mouse_event(, AppActivate, and `.SendKeys` on a WScript.Shell object (only when that
 * object is in view in the same text or file, so Selenium's element `.SendKeys`/`.sendKeys` stays silent).
 * WHAT IS SKIPPED: comment-only lines (//, /*, *, #, <#, <!--; plus ' and REM in VB files, REM and :: in .bat/.cmd,
 * -- in SQL/Lua, ; in .ini/.ahk), Markdown/docs files, the project's
 * own .claude/ tree and node_modules. A trailing comment on a code line still counts (over-warn, the safe side).
 * NOT SEEN: a Write larger than the hook's 256 KB stdin head, input libraries that hide the API name (pyautogui,
 * robotjs, nut.js, AutoHotkey Send), and a script that builds the API name at run time.
 *
 * EXPORTS: scanText(text, opts) -> [{line, api, text}] · feedbackFor(payload, opts) -> {decision, reason} | null ·
 * reasonFor(hits) · PATTERNS. Pure apart from one bounded read of the edited file (WScript context); never throws.
 */
const fs = require('fs');
const path = require('path');

let WORDS = null;
try { WORDS = require('./forge-gate-messages.cjs').WORDS['global-input-command'] || null; } catch { WORDS = null; }
const FALLBACK_WORDS = {
  nl: 'dit gebruikt globale toetsenbord- of muisinvoer: die gaat naar het venster dat vooraan staat',
  en: 'this uses global keyboard or mouse input: it goes to whatever window is in front',
  safeNl: 'stuur de invoer naar het eigen venster van de app (PostMessage/SendMessage naar zijn hwnd) of gebruik een self-test-vlag',
  safeEn: 'post the input to the app\'s own window handle (PostMessage/SendMessage to its hwnd) or use a self-test flag',
};

const PATTERNS = [
  { api: 'SendKeys', re: /\bSendKeys\s*(?:\]\s*)?(?:::|\.)\s*Send(?:Wait)?\b/i },
  { api: 'SendKeys', re: /\bForms\.SendKeys\b/i },
  { api: 'SendWait', re: /\bSendWait\s*\(/ },
  { api: 'SendInput', re: /\bSendInput\s*\(|["']SendInput["']/ },
  { api: 'keybd_event', re: /\bkeybd_event\s*\(|["']keybd_event["']/ },
  { api: 'mouse_event', re: /\bmouse_event\s*\(|["']mouse_event["']/ },
  { api: 'AppActivate', re: /\bAppActivate\b/i },
];
const WSCRIPT_SENDKEYS = /\.SendKeys\b/i;
const WSCRIPT_CONTEXT = /\bWScript\.Shell\b|\bWshShell\b/i;
// generic comment starts; the shorter, ambiguous markers only count for the languages that use them (a JS line can
// start with a string literal `'...'`, which in VBScript would be a comment)
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|#|<#|<!--)/;
const COMMENT_BY_EXT = [
  { exts: ['.vbs', '.vba', '.vb', '.bas', '.cls', '.frm'], re: /^\s*(?:'|REM\b)/i },
  { exts: ['.bat', '.cmd'], re: /^\s*@?(?:REM\b|::)/i },
  { exts: ['.sql', '.lua', '.hs'], re: /^\s*--/ },
  { exts: ['.ini', '.ahk', '.asm', '.au3'], re: /^\s*;/ },
];
function commentLine(ln, ext) {
  if (COMMENT_LINE.test(ln)) return true;
  if (!ext) return false;
  for (const c of COMMENT_BY_EXT) if (c.exts.includes(ext) && c.re.test(ln)) return true;
  return false;
}
const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.log']);
const MAX_FILE_READ = 2 * 1024 * 1024;
const MAX_HITS = 5;
const MAX_LINE_SHOWN = 120;

/** scanText(text, opts) -> hits. opts.wscriptContext: true when the WScript.Shell object is known to be in view
 *  elsewhere (the file on disk), so a bare `.SendKeys` counts. Never throws; non-string input gives []. */
function scanText(text, opts) {
  if (typeof text !== 'string' || !text) return [];
  const o = opts || {};
  const wscript = o.wscriptContext === true || WSCRIPT_CONTEXT.test(text);
  const ext = typeof o.ext === 'string' ? o.ext.toLowerCase() : '';
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || commentLine(ln, ext)) continue;
    let api = null;
    for (const p of PATTERNS) { if (p.re.test(ln)) { api = p.api; break; } }
    if (!api && wscript && WSCRIPT_SENDKEYS.test(ln)) api = 'WScript.Shell.SendKeys';
    if (api) hits.push({ line: i + 1, api, text: ln.trim().slice(0, MAX_LINE_SHOWN) });
  }
  return hits;
}

function str(v) { return typeof v === 'string' && v.length ? v : null; }

/** written(toolName, input) -> the code text the call put into the file, or null for any other tool or shape. */
function written(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  if (toolName === 'Write') return str(input.content);
  if (toolName === 'Edit') return str(input.new_string);
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(input.edits)) return null;
    const parts = input.edits.map((e) => (e && typeof e.new_string === 'string' ? e.new_string : '')).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/** skipped(file, root) -> true for docs files, the project's own .claude/ tree and node_modules. */
function skipped(file, root) {
  if (DOC_EXT.has(path.extname(file).toLowerCase())) return true;
  const abs = path.resolve(root || process.cwd(), file);
  const rel = root ? path.relative(path.resolve(root), abs) : abs;
  const segs = rel.split(/[\\/]+/);
  if (root && !rel.startsWith('..') && !path.isAbsolute(rel) && segs[0].toLowerCase() === '.claude') return true;
  return segs.some((s) => s.toLowerCase() === 'node_modules');
}

/** fileHasWscript(file) -> true when the file on disk (bounded read) holds the WScript.Shell object. */
function fileHasWscript(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_READ) return false;
    return WSCRIPT_CONTEXT.test(fs.readFileSync(file, 'utf8'));
  } catch { return false; }
}

function displayPath(file, root) {
  const abs = path.resolve(root || process.cwd(), file);
  if (root) {
    const rel = path.relative(path.resolve(root), abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return abs.split(path.sep).join('/');
}

/** reasonFor(where, hits) -> the NL + EN feedback text (wording shared with the gate hook). */
function reasonFor(where, hits) {
  const w = WORDS || FALLBACK_WORDS;
  const at = hits.slice(0, MAX_HITS).map((h) => where + ':' + h.line + ' (' + h.api + ')').join(', ');
  return 'FORGE GLOBAL INPUT (' + at + '):\n'
    + '- ' + w.nl + '. Veilige variant: ' + w.safeNl + '. De wijziging staat er nog; pas de code nu aan.\n'
    + '- ' + w.en + '. Safe variant: ' + w.safeEn + '. The change was written; fix the code now.';
}

/** feedbackFor(payload, opts) -> { decision: 'block', reason } | null. opts.root = the project root. Never throws. */
function feedbackFor(payload, opts) {
  try {
    if (!payload || typeof payload !== 'object') return null;
    const toolName = str(payload.tool_name);
    const input = payload.tool_input;
    const text = written(toolName, input);
    if (!text) return null;
    const file = str(input.file_path) || str(input.filePath);
    if (!file) return null;
    const root = (opts && str(opts.root)) || null;
    if (skipped(file, root)) return null;
    const ext = path.extname(file).toLowerCase();
    let hits = scanText(text, { ext });
    if (!hits.length && toolName !== 'Write' && WSCRIPT_SENDKEYS.test(text)) {
      const abs = path.resolve(root || process.cwd(), file);
      if (fileHasWscript(abs)) hits = scanText(text, { ext, wscriptContext: true });
    }
    if (!hits.length) return null;
    return { decision: 'block', reason: reasonFor(displayPath(file, root), hits) };
  } catch { return null; }
}

module.exports = { scanText, feedbackFor, reasonFor, PATTERNS, DOC_EXT };

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length < 3) {
    console.log('Usage: node forge-global-input.cjs <file>...');
    console.log('  Lists lines that use global keyboard/mouse input (SendKeys, SendInput, keybd_event, mouse_event, AppActivate).');
    console.log('  Exit 1 when one is found, 0 when none. forge-toolhook.cjs runs the same check after every Write/Edit.');
    process.exit(0);
  }
  let found = 0;
  for (const f of process.argv.slice(2)) {
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) { console.error('cannot read ' + f + ': ' + e.message); process.exitCode = 2; continue; }
    for (const h of scanText(src, { ext: path.extname(f) })) { found++; console.log(f + ':' + h.line + ': ' + h.api + ': ' + h.text); }
  }
  if (found) process.exitCode = 1;
}
