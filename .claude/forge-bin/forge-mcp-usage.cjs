#!/usr/bin/env node
'use strict';
/**
 * forge-mcp-usage.cjs — did the MCP least-privilege gate actually fire for the MCP tools that were used?
 *
 * WHY THIS EXISTS (broad Codex audit, finding #1, the heaviest one). `forge-mcp-gate.cjs`
 * enforces tiers, per-Boss allow-lists and owner-verified tier-3 writes... but it is a LIBRARY nobody is
 * obliged to call. A repository-wide call-site trace found no mandatory dispatch path invoking it, so an
 * MCP tool can simply be used and the gate never runs. Measured on this machine: `mcp_grant_validated`
 * is a registered event type with **0 occurrences across every run** — the same shape as the run-contract
 * gate, which existed and was tested for months while having been evaluated exactly zero times.
 *
 * Forge cannot hook Claude Code's own tool dispatcher, so this does the next honest thing: it makes the
 * gap VISIBLE and measurable instead of theoretical. The PostToolUse tool ledger
 * (`.claude/forge-runs/_toollog/*.jsonl`, written by forge-toolhook.cjs) records EVERY tool call, MCP
 * ones included (`mcp__<server>__<tool>`). Cross-referencing that against `mcp_grant_validated` events
 * answers a question nobody could answer before: *was any MCP tool used without the gate ever running?*
 *
 *   check(opts) -> { ok, usedTools, ungated, validations, reason }
 *     ok:false          — MCP tools were really used while the gate produced no validation at all.
 *     usedTools         — distinct mcp__ tool names found in the ledger, with counts + first/last seen.
 *     validations       — how many mcp_grant_validated / mcp_grant_denied events exist across runs.
 *     ok:true + no use  — honest "nothing to check", NOT "the gate is working".
 *
 * Read-only, zero-dependency, never throws. Advisory by design: it reports, it does not block.
 *
 * CLI: node forge-mcp-usage.cjs [--root <dir>] [--json]
 *      Exit codes: 0 = ok (gated or nothing to check) · 3 = MCP tools were used but never gated.
 */
const fs = require('fs');
const path = require('path');

// WP 2.1 (opt-in .forge layout): the tool ledger (<runs>/_toollog) and the run logs are read from EVERY run folder
// that exists (forge-paths.cjs existingStateDirs); a project without .forge reads exactly .claude/forge-runs as before.
// Guarded: an older or missing forge-paths.cjs keeps the legacy literals. A plugin copy outside any project has no
// default root (null): check() then reports UNKNOWN instead of reading beside its own script.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.existingStateDirs === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function viaForgePaths(fn, legacy) { if (forgePaths) { try { return fn(forgePaths); } catch { /* unresolvable root or canon: legacy */ } } return legacy(); }
const DEFAULT_ROOT = viaForgePaths((P) => P.scriptRoot(__dirname), () => path.resolve(__dirname, '..', '..'));
function runsDirsOf(root) { return viaForgePaths((P) => P.existingStateDirs(root, 'runs'), () => [path.join(root, '.claude', 'forge-runs')]); }
function activeRunsRel(root) { return path.relative(root, viaForgePaths((P) => P.stateDir(root, 'runs'), () => path.join(root, '.claude', 'forge-runs'))).split(path.sep).join('/'); }
const MCP_TOOL_RE = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/; // mcp__<server>__<tool>

function readJsonl(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* a torn last line is not evidence of anything */ }
  }
  return out;
}

/** collectMcpToolUse — every mcp__ tool call recorded by the PostToolUse ledger. */
function collectMcpToolUse(root) {
  const byTool = new Map();
  const ledgers = []; // [{dir, files}] — one per run folder whose _toollog is readable
  for (const runsDir of runsDirsOf(root)) {
    const dir = path.join(runsDir, '_toollog');
    try { ledgers.push({ dir, files: fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) }); } catch { /* no ledger in this run folder */ }
  }
  if (!ledgers.length) return { tools: [], ledgerPresent: false };
  for (const { dir, files } of ledgers) for (const f of files) {
    for (const rec of readJsonl(path.join(dir, f))) {
      const name = rec && typeof rec.tool === 'string' ? rec.tool : '';
      if (!MCP_TOOL_RE.test(name)) continue;
      const cur = byTool.get(name) || { tool: name, server: (name.match(MCP_TOOL_RE) || [])[1] || null, count: 0, first: null, last: null };
      cur.count++;
      const ts = rec.ts || null;
      if (ts && (!cur.first || ts < cur.first)) cur.first = ts;
      if (ts && (!cur.last || ts > cur.last)) cur.last = ts;
      byTool.set(name, cur);
    }
  }
  return { tools: Array.from(byTool.values()).sort((a, b) => b.count - a.count), ledgerPresent: true };
}

/** collectGateEvents — mcp_grant_validated / mcp_grant_denied across every run's events.jsonl. */
function collectGateEvents(root) {
  let validated = 0, denied = 0;
  for (const runsDir of runsDirsOf(root)) {
    let entries = [];
    try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const rec of readJsonl(path.join(runsDir, e.name, 'events.jsonl'))) {
        if (!rec || typeof rec.event_type !== 'string') continue;
        if (rec.event_type === 'mcp_grant_validated') validated++;
        else if (rec.event_type === 'mcp_grant_denied') denied++;
      }
    }
  }
  return { validated, denied };
}

function check(opts) {
  opts = opts || {};
  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  if (!root) {
    return { ok: true, unknown: true, usedTools: [], validations: { validated: 0, denied: 0 }, reason:
      'no project root found (this copy is not inside a project) — MCP tool use cannot be observed; reported as UNKNOWN, not as "the gate is fine"' };
  }
  const use = collectMcpToolUse(root);
  const gate = collectGateEvents(root);
  const totalUses = use.tools.reduce((n, t) => n + t.count, 0);
  const gateRan = gate.validated + gate.denied;

  if (!use.ledgerPresent) {
    return {
      ok: true, unknown: true, usedTools: [], validations: gate, reason:
        'no PostToolUse tool ledger on this machine (' + activeRunsRel(root) + '/_toollog/), so MCP tool use cannot be observed — reported as UNKNOWN, not as "the gate is fine"',
    };
  }
  if (totalUses === 0) {
    return {
      ok: true, usedTools: [], validations: gate, reason:
        'no MCP tool calls recorded in the ledger — nothing to gate (this is "nothing happened", not "the gate is working")',
    };
  }
  if (gateRan === 0) {
    return {
      ok: false, usedTools: use.tools, ungated: use.tools, validations: gate, reason:
        totalUses + ' MCP tool call(s) across ' + use.tools.length + ' distinct tool(s) were recorded, while forge-mcp-gate produced ZERO grant validations — '
        + 'the least-privilege gate (tiers, per-Boss allow-lists, owner-verified tier-3 writes) never ran for any of them: '
        + use.tools.slice(0, 6).map((t) => t.tool + ' ×' + t.count).join(', '),
    };
  }
  return {
    ok: true, usedTools: use.tools, validations: gate, reason:
      totalUses + ' MCP tool call(s) recorded and ' + gateRan + ' gate decision(s) logged — the gate is being exercised '
      + '(this check counts, it does not pair each call to its own decision)',
  };
}

module.exports = { check, collectMcpToolUse, collectGateEvents, MCP_TOOL_RE, DEFAULT_ROOT };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootArg = argv.indexOf('--root') >= 0 ? argv[argv.indexOf('--root') + 1] : null;
  const res = check({ root: rootArg });
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    console.log((res.ok ? (res.unknown ? 'UNKNOWN — ' : 'OK — ') : 'UNGATED MCP USE — ') + res.reason);
    for (const t of res.usedTools.slice(0, 10)) console.log('  ' + t.tool + ' ×' + t.count + (t.last ? ' (last ' + t.last + ')' : ''));
  }
  process.exit(res.ok ? 0 : 3);
}
