#!/usr/bin/env node
'use strict';
/**
 * forge-scribe-secret-redact.test.cjs — WP-SCRIBE-REDACT. An owner pasted a Roblox Open
 * Cloud API key (one long base64 blob, no known prefix) into a prompt and the scribe stored it in plain text. These tests
 * use SYNTHETIC keys of the same shape (random base64, generated at runtime) and prove that:
 *   1. forge-store.redactText and the scribe capture pipeline (normalizePrompt) redact such a key in the pasted form, after
 *      a label ("api key:", "api sleutel:", "token=") and as a bare line;
 *   2. ordinary text (prose, paths, URLs, git SHAs, sha256/sha512 hex, UUIDs, code) stays byte-identical;
 *   3. `forge-scribe.cjs scan-secrets` reports rid + field of stored items that still hold a secret, without printing the
 *      value and without changing the ledger (temp-dir fixture only; the real .claude/forge-scribe is never touched).
 * Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const store = require('./forge-store.cjs');
const S = require('./forge-scribe-store.cjs');

let pass = 0, fail = 0;
const t = (name, cond, info) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (info ? ' :: ' + String(info).slice(0, 300) : '')); } };

/** b64Key(bytes, {slashPlus}) — a random standard-base64 token; slashPlus:false maps + and / to letters. */
function b64Key(bytes, o) {
  for (;;) {
    let k = crypto.randomBytes(bytes).toString('base64');
    if (o && o.slashPlus === false) k = k.replace(/\+/g, 'Q').replace(/\//g, 'z');
    if (/[A-Z]/.test(k) && /[a-z]/.test(k) && /[0-9]/.test(k) && (!(o && o.slashPlus) || /[+/]/.test(k))) return k;
  }
}
/** leaked(out, key) -> true when any 16-char window of the key is still in the output. */
function leaked(out, key) { for (let i = 0; i + 16 <= key.length; i += 8) if (out.includes(key.slice(i, i + 16))) return true; return false; }

const KEY_PAD = b64Key(400, { slashPlus: true });     // 536 chars, ends with '=' padding? 400 % 3 = 1 -> '=='
const KEY_NOPAD = b64Key(300, { slashPlus: false });  // 400 chars, no + / =
const KEY_SHORT = b64Key(36, { slashPlus: false });   // 48 chars: only redacted after a label
t('fx: the synthetic keys have the intended shape', KEY_PAD.endsWith('==') && /[+/]/.test(KEY_PAD) && !/[+/=]/.test(KEY_NOPAD) && KEY_SHORT.length === 48);

const both = (s) => [store.redactText(s), S.normalizePrompt(s).text];

console.log('1. long base64 keys are redacted');
{
  const prompt = 'dit is de api sleutel: <pasted_content id="1" lines="1">\n' + KEY_PAD + '\n</pasted_content> wat moet ik nu doen?';
  const [a, b] = both(prompt);
  t('1a: pasted_content form, redactText', !leaked(a, KEY_PAD), a.slice(0, 120));
  t('1b: pasted_content form, scribe normalizePrompt', !leaked(b, KEY_PAD));
  t('1c: the owner words around it are kept', b.includes('wat moet ik nu doen?') && b.includes('dit is de api sleutel'));
  t('1d: normalizePrompt marks it redacted', S.normalizePrompt(prompt).redacted === true);
}
for (const [label, key] of [['api key: ', KEY_PAD], ['api sleutel: ', KEY_NOPAD], ['token=', KEY_NOPAD], ['API Key: ', KEY_SHORT], ['sleutel: ', KEY_SHORT], ['secret ', KEY_SHORT]]) {
  const s = 'hier is het: ' + label + key + ' klaar';
  const [a, b] = both(s);
  t('1e: after the label ' + JSON.stringify(label) + ' (' + key.length + ' chars), redactText', !leaked(a, key), a.slice(0, 120));
  t('1f: after the label ' + JSON.stringify(label) + ', normalizePrompt keeps the label', !leaked(b, key) && b.includes(label.trim()) && b.endsWith(' klaar'));
}
{
  const bare = KEY_NOPAD.slice(0, 220);
  const s = 'regel een\n' + bare + '\nregel drie';
  const [a, b] = both(s);
  t('1g: a bare 220-char base64 line, redactText', !leaked(a, bare), a);
  t('1h: a bare 220-char base64 line, normalizePrompt keeps the other lines', !leaked(b, bare) && b.startsWith('regel een\n') && b.endsWith('\nregel drie'));
  const inline = 'key ' + KEY_PAD + ' end';
  t('1i: a padded key inside a sentence', !leaked(store.redactText('zie ' + KEY_PAD + ' hier'), KEY_PAD) && !leaked(store.redactText(inline), KEY_PAD));
}

console.log('2. ordinary text stays unchanged');
{
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  const KEEP = [
    'Ik wil dat de scribe elke prompt bewaart, maar zonder geheimen. Kun je dat fixen en daarna verder gaan met de rest?',
    'Please keep going with the dashboard work, and make sure the tests run green before you commit anything at all.',
    'C:\\Users\\dev\\Documents\\my project\\.claude\\forge-bin\\forge-scribe-store.cjs',
    '/home/user/projects/forge/src/components/dashboard/widgets/charts/LineChartWithTooltipAndLegend2026Final.tsx',
    'src/A1/B2/C3/D4/E5/F6/G7/H8/I9/J0/K1/L2/M3/N4/O5/P6/Q7/R8/S9/T0/U1/V2/W3/X4/Y5/Z6/a7/b8/c9/d0/e1/f2/g3/h4/i5/j6/k7',
    'https://example.com/docs/getting-started/install?lang=nl&v=2#section-3',
    'commit ' + hex(20) + ' fixed it',
    'key: ' + hex(20),
    'sha256 ' + hex(32) + ' matches',
    'sha512 ' + hex(64),
    'uuid: 3f8e2c1a-9b7d-4e6f-8a5c-2d1b0e9f7a6c',
    'key: 3F8E2C1A-9B7D-4E6F-8A5C-2D1B0E9F7A6C',
    'id 3f8e2c1a-9b7d-4e6f-8a5c-2d1b0e9f7a6c and 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    'const result = items.filter((x) => x.status === "open").map((x) => x.rid).join(", ");',
    'forge-scribe-store-redacts-long-base64-tokens-in-pasted-content-blocks-and-keeps-ordinary-prose-unchanged-2026',
    'export function computeTheLongestPossibleIdentifierNameForTestingPurposesOnlyV2(a, b) { return a + b; }',
    'api key: MY_API_KEY_PLACEHOLDER',
    'The key point of the secret sauce is that every token counts, says the password manager guide from 2026.',
    // WP-REDACT-SLUG: a long Claude project slug in a transcript path is no key — redacting it broke the
    // owner-origin transcript check (forge-standing CF-4-F2 failed under a deep temp folder)
    'C:/Users/YOU/.claude/projects/C--Users-YOU-AppData-Local-Temp-forge-tmp-hygiene-ABxivf-forge-standing-bacXrF-standing-owner-root-Q3kd9Z/s1.jsonl',
    'C--Users-YOU-Documents-Projects-Client-Work-2026-Q4-NewWebsite-Redesign-Phase2-Final-Assets-Exports-Version3-Approved-By-Owner',
    'transcript_path=C:\\Users\\YOU\\.claude\\projects\\C--Users-YOU-Documents-Some-Very-Long-Project-Folder-Name-2026-With-Many-Words-And-Digits-123\\a1b2.jsonl',
  ];
  for (const s of KEEP) {
    t('2: unchanged by redactText: ' + JSON.stringify(s.slice(0, 50)), store.redactText(s) === s, store.redactText(s));
    t('2: unchanged by normalizePrompt: ' + JSON.stringify(s.slice(0, 50)), S.normalizePrompt(s).text === s, S.normalizePrompt(s).text);
  }
}

console.log('3. scan-secrets (read-only)');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-scan-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
    const p = S.paths(root);
    fs.mkdirSync(p.dir, { recursive: true });
    const leakText = 'dit is de api sleutel: <pasted_content>\n' + KEY_PAD + '\n</pasted_content> wat moet ik doen';
    // written raw, the way a pre-fix capture stored it (bypassing the scrubber on purpose)
    S.appendChained(p.inbox, { v: 1, pid: 'P-000001', ts: '2026-11-15T00:00:00Z', session_id: 's1', source: 'hook', text: leakText, redacted: false, text_sha256: S.sha256(leakText) });
    S.appendChained(p.inbox, { v: 1, pid: 'P-000002', ts: '2026-11-15T00:01:00Z', session_id: 's1', source: 'hook', text: 'gewone vraag zonder geheim', redacted: false, text_sha256: S.sha256('gewone vraag zonder geheim') });
    S.appendChained(p.ledger, { v: 1, seq: 1, ts: '2026-11-15T00:00:00Z', op: 'capture', rid: 'R-0001', pid: 'P-000001', class: 'question', title: 'api sleutel', quote: leakText, by: 'hook' });
    const before = fs.readFileSync(p.inbox, 'utf8') + fs.readFileSync(p.ledger, 'utf8');
    const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });
    const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-scribe.cjs'), 'scan-secrets', '--json'], { env, encoding: 'utf8' });
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
    t('3a: scan-secrets exits 3 when a stored secret is found', r.status === 3, 'status ' + r.status + ' ' + r.stderr);
    const hits = j && Array.isArray(j.findings) ? j.findings : [];
    t('3b: it reports the inbox record by pid and field', hits.some((h) => h.file === 'inbox.jsonl' && h.id === 'P-000001' && h.field === 'text'), JSON.stringify(hits));
    t('3c: it reports the ledger item by rid and field', hits.some((h) => h.file === 'ledger.jsonl' && h.id === 'R-0001' && h.field === 'quote'), JSON.stringify(hits));
    t('3d: the clean record is not reported', !hits.some((h) => h.id === 'P-000002'));
    t('3e: the output never holds the key value', !leaked(r.stdout + r.stderr, KEY_PAD));
    const human = spawnSync(process.execPath, [path.join(__dirname, 'forge-scribe.cjs'), 'scan-secrets'], { env, encoding: 'utf8' });
    t('3f: the plain output names the ids and hides the value', /P-000001/.test(human.stdout) && /R-0001/.test(human.stdout) && !leaked(human.stdout + human.stderr, KEY_PAD), human.stdout + human.stderr);
    t('3g: the ledger and inbox are byte-identical afterwards (read-only)', fs.readFileSync(p.inbox, 'utf8') + fs.readFileSync(p.ledger, 'utf8') === before);
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-scan-clean-'));
    try {
      const rc = spawnSync(process.execPath, [path.join(__dirname, 'forge-scribe.cjs'), 'scan-secrets'], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: clean }), encoding: 'utf8' });
      t('3h: an empty store scans clean (exit 0)', rc.status === 0, rc.stdout + rc.stderr);
    } finally { fs.rmSync(clean, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
