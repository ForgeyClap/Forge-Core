#!/usr/bin/env node
'use strict';
// forge-mcp.test.cjs — tests the read-only Forge MCP server (JSON-RPC handlers + tools + resources +
// isolation). Uses the module exports (handle/callTool/listResources/readResource) so it is deterministic;
// PROJECT_ROOT resolves to the template (forge-mcp.cjs __dirname/../..), which has real forge-runs.
// Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const mcp = require('./forge-mcp.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }
// capture the last JSON-RPC line handle() writes to stdout
function cap(fn) { const orig = process.stdout.write; let out = ''; process.stdout.write = (s) => { out += s; return true; }; try { fn(); } finally { process.stdout.write = orig; } const lines = out.trim().split('\n').filter(Boolean); return lines.length ? JSON.parse(lines[lines.length - 1]) : null; }

console.log('forge MCP server tests (read-only, isolation-guarded)');

t('exposes exactly the 4 read-only tools', () => { assert.strictEqual(mcp.TOOLS.length, 4); assert.deepStrictEqual(mcp.TOOLS.map((x) => x.name).sort(), ['forge_get_run', 'forge_list_runs', 'forge_read_report', 'forge_status']); });

t('initialize returns serverInfo + tools/resources capabilities', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  assert.strictEqual(r.result.serverInfo.name, 'forge');
  assert.ok(r.result.capabilities.tools && r.result.capabilities.resources);
  assert.ok(r.result.protocolVersion);
});

t('notifications/initialized produces NO reply (it is a notification)', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.strictEqual(r, null);
});

t('tools/list returns the tool schemas', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.strictEqual(r.result.tools.length, 4);
  assert.ok(r.result.tools.every((x) => x.inputSchema && x.inputSchema.type === 'object'));
});

t('tools/call forge_status returns a text content block', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'forge_status', arguments: {} } }));
  assert.ok(Array.isArray(r.result.content) && r.result.content[0].type === 'text');
  const data = JSON.parse(r.result.content[0].text);
  assert.ok(typeof data.project === 'string' && typeof data.total_runs === 'number');
});

t('forge_list_runs returns a runs array', () => {
  const data = mcp.callTool('forge_list_runs', {});
  assert.ok(Array.isArray(data.runs));
});

t('forge_get_run rejects a traversal run_id', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'forge_get_run', arguments: { run_id: '../secrets' } } }));
  assert.ok(r.result.isError === true);
});

t('resources/list enumerates run + memory resources with forge:// uris', () => {
  const res = mcp.listResources();
  assert.ok(Array.isArray(res));
  assert.ok(res.every((x) => /^forge:\/\//.test(x.uri)));
});

t('resources/read rejects a path-traversal uri', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'forge://run/..%2f..%2fetc/run.json' } }));
  assert.ok(r.error && r.error.code === -32602);
});

t('every listed resource actually reads back (no dangling uris)', () => {
  const res = mcp.listResources();
  if (!res.length) { assert.ok(true); return; } // no runs/memory in template → vacuously ok
  for (const r of res.slice(0, 10)) { const out = mcp.readResource(r.uri); assert.ok(typeof out.text === 'string' && out.uri === r.uri, 'dangling resource: ' + r.uri); }
});

t('unknown method returns method-not-found', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 6, method: 'no/such/method' }));
  assert.ok(r.error && r.error.code === -32601);
});

// (laptop-audit Part V-G): this is a stdio server, not a flag-driven CLI — a bare `--help` used
// to fall straight into the stdin read loop (harmless once stdin is already closed, as it always is under a
// real spawn with no `input`, but left a real interactive terminal user waiting on a server they only meant
// to inspect). A real spawned process with a short timeout proves it now answers immediately and never logs
// the "server ready" startup line.
t('CLI --help (real spawn): exits 0 immediately with a registration snippet, never starts the stdio server', () => {
  const CLI = path.join(__dirname, 'forge-mcp.cjs');
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' stderr ' + r.stderr);
  assert.ok(r.stdout.includes('read-only MCP'), 'stdout: ' + r.stdout.slice(0, 120));
  assert.ok(!/server ready/.test(r.stderr || ''), 'must never start the real stdio server for --help');
});
t('CLI -h is the same shorthand for --help', () => {
  const CLI = path.join(__dirname, 'forge-mcp.cjs');
  const r = spawnSync(process.execPath, [CLI, '-h'], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, 'exit ' + r.status);
  assert.ok(r.stdout.includes('read-only MCP'));
});

// the memory rotation moved old history into .claude/FORGE_MEMORY_ARCHIVE_*.md. Those are
// shared read-only in the same tier as FORGE_MEMORY.md (listed, readable, redacted); anything else stays forbidden.
// PROJECT_ROOT is fixed at module load from FORGE_PROJECT_ROOT, so a child process drives the module on a temp project.
t('WP-9b: memory archives are listed and readable read-only (redacted); look-alikes and other files stay forbidden', () => {
  const fs = require('fs');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-archive-'));
  try {
    const cd = path.join(root, '.claude');
    fs.mkdirSync(cd);
    const FAKE_SK = 'sk-' + 'x'.repeat(24);
    fs.writeFileSync(path.join(cd, 'FORGE_MEMORY.md'), '# current\n');
    fs.writeFileSync(path.join(cd, 'FORGE_MEMORY_ARCHIVE_2026-10.md'), '# archive\nkey ' + FAKE_SK + '\n');
    fs.writeFileSync(path.join(cd, 'FORGE_MEMORY_ARCHIVE_notes.txt'), 'not shared\n');
    fs.writeFileSync(path.join(cd, 'FORGE_OTHER.md'), 'not shared\n');
    fs.mkdirSync(path.join(cd, 'FORGE_MEMORY_ARCHIVE_dir.md'));
    const script = [
      "const m = require(" + JSON.stringify(path.join(__dirname, 'forge-mcp.cjs')) + ");",
      "const uris = m.listResources().map((r) => r.uri);",
      "const read = (u) => { try { return { ok: true, text: m.readResource(u).text }; } catch (e) { return { ok: false, err: e.message }; } };",
      "console.log(JSON.stringify({ uris, archive: read('forge://memory/FORGE_MEMORY_ARCHIVE_2026-10.md'), txt: read('forge://memory/FORGE_MEMORY_ARCHIVE_notes.txt'), other: read('forge://memory/FORGE_OTHER.md'), dir: read('forge://memory/FORGE_MEMORY_ARCHIVE_dir.md'), trav: read('forge://memory/../FORGE_MEMORY_ARCHIVE_2026-10.md') }));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
    assert.strictEqual(r.status, 0, 'child exit ' + r.status + ' ' + r.stderr);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(o.uris, ['forge://memory/FORGE_MEMORY.md', 'forge://memory/FORGE_MEMORY_ARCHIVE_2026-10.md']);
    assert.strictEqual(o.archive.ok, true, JSON.stringify(o.archive));
    assert.ok(o.archive.text.includes('# archive'), 'archive body is served');
    assert.ok(!o.archive.text.includes(FAKE_SK), 'archive text passes through the same redactor');
    for (const k of ['txt', 'other', 'dir', 'trav']) assert.strictEqual(o[k].ok, false, k + ' must stay forbidden');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// WP 1.9: forge-memory-consolidate.cjs (WP 1.4) archives the history, ledger and decisions files as
// FORGE_<NAME>_ARCHIVE_<YYYY-MM>[-b].md. An archive of a file that is already shared is shared in the same tier; an
// archive-shaped name of a file that is NOT shared (owner profile, an invented name) stays forbidden, and so do
// LESSONS.md and agent-memory (never part of the MCP surface).
t('WP 1.9: archives of the shared history/ledger/decisions files are listed and readable; non-shared look-alikes stay forbidden', () => {
  for (const ok of ['FORGE_MEMORY_ARCHIVE_2026-10-24.md', 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md', 'FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.md', 'FORGE_PROJECT_PROFILE_ARCHIVE_2026-10.md']) assert.ok(mcp.MEMORY_ARCHIVE_RE.test(ok), ok);
  for (const bad of ['FORGE_OWNER_PROFILE_ARCHIVE_2026-10.md', 'FORGE_SECRET_ARCHIVE_2026-10.md', 'FORGE_ARCHIVE_2026-10.md', 'LESSONS.md', 'FORGE_DECISIONS_ARCHIVE_2026-10.txt']) assert.ok(!mcp.MEMORY_ARCHIVE_RE.test(bad), bad);
  const fs = require('fs');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-archive19-'));
  try {
    const cd = path.join(root, '.claude');
    fs.mkdirSync(path.join(cd, 'agent-memory', 'build-boss'), { recursive: true });
    const FAKE_SK = 'sk-' + 'z'.repeat(24);
    fs.writeFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md'), '# history\n');
    fs.writeFileSync(path.join(cd, 'FORGE_TASK_HISTORY_ARCHIVE_2026-10.md'), '# history archive\nkey ' + FAKE_SK + '\n');
    fs.writeFileSync(path.join(cd, 'FORGE_DECISIONS_ARCHIVE_2026-10.md'), '# decisions archive\n');
    fs.writeFileSync(path.join(cd, 'FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md'), '# ledger archive\n');
    fs.writeFileSync(path.join(cd, 'FORGE_OWNER_PROFILE_ARCHIVE_2026-10.md'), 'not shared\n');
    fs.writeFileSync(path.join(cd, 'LESSONS.md'), 'not shared\n');
    fs.writeFileSync(path.join(cd, 'agent-memory', 'build-boss', 'lessons-archive-2026-10-23.md'), 'not shared\n');
    const script = [
      "const m = require(" + JSON.stringify(path.join(__dirname, 'forge-mcp.cjs')) + ");",
      "const uris = m.listResources().map((r) => r.uri);",
      "const read = (u) => { try { return { ok: true, text: m.readResource(u).text }; } catch (e) { return { ok: false, err: e.message }; } };",
      "console.log(JSON.stringify({ uris, hist: read('forge://memory/FORGE_TASK_HISTORY_ARCHIVE_2026-10.md'), owner: read('forge://memory/FORGE_OWNER_PROFILE_ARCHIVE_2026-10.md'), lessons: read('forge://memory/LESSONS.md'), boss: read('forge://memory/agent-memory/build-boss/lessons-archive-2026-10-23.md') }));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
    assert.strictEqual(r.status, 0, 'child exit ' + r.status + ' ' + r.stderr);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(o.uris, ['forge://memory/FORGE_TASK_HISTORY.md', 'forge://memory/FORGE_AGENT_LEDGER_ARCHIVE_2026-10-b.md', 'forge://memory/FORGE_DECISIONS_ARCHIVE_2026-10.md', 'forge://memory/FORGE_TASK_HISTORY_ARCHIVE_2026-10.md']);
    assert.ok(o.hist.ok === true && o.hist.text.includes('# history archive') && !o.hist.text.includes(FAKE_SK), JSON.stringify(o.hist).slice(0, 200));
    for (const k of ['owner', 'lessons', 'boss']) assert.strictEqual(o[k].ok, false, k + ' must stay forbidden');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
