#!/usr/bin/env node
'use strict';
// forge-dispatch-fit.cjs — does the agent I am about to dispatch have the tools the brief needs?
// (W2-DISPATCHLINT). Zero dependencies, no shell.
//   check   --agent <name> --needs <Tool[,Tool]> [--json]   exit 0 fit / 1 missing / 2 unknown agent, cannot read tools
//                                                           (no frontmatter: fail closed) or bad usage
// Also runs automatically at dispatch time: forge-agent-tool-hook.cjs (PreToolUse Agent) prints a NON-blocking stderr
// warning when the dispatched agent lacks a tool the prompt seems to need (W2-REVIEWFIX).
//   infer   --brief <file|->                                print tools the brief text seems to need (helper, not a verdict)
//   suggest --needs <Tool[,Tool]>                           agents that have all of them
// Optional --agents-dir <dir> (repeatable) replaces the default agent folders (tests).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DIRS = [path.join(ROOT, '.claude', 'agents'), path.join(os.homedir(), '.claude', 'agents')];

const SIGNALS = [
  [/\b(re-?run|run|node |gh api|git |npm|probe|log-event|test file)/i, ['Bash']],
  [/\b(write|create the file|edit|fix)\b/i, ['Write', 'Edit']],
];

const ALL_RE = /^(\*|all|all tools)$/i;
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const stripComment = (s) => s.replace(/\s+#.*$/, '').replace(/^#.*$/, '');

/** readTools(text) -> {kind:'list', tools[]} | {kind:'all', note} | {kind:'unreadable', note}.
 *  Fails CLOSED: a file without a frontmatter block is 'unreadable', never "all tools". Only a frontmatter that has no
 *  tools: line (or an empty one, "*" or "All tools") is 'all' — that is Claude Code's real default for a subagent. */
function readTools(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!fm) return { kind: 'unreadable', note: 'no frontmatter block' };
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^tools\s*:/.test(l));
  if (i < 0) return { kind: 'all', note: 'no tools line = all tools (Claude Code default)' };
  let value = stripComment(lines[i].replace(/^tools\s*:/, '')).trim();
  let items;
  if (value === '') {
    items = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\s+-\s*(.*)$/.exec(lines[j]);
      if (m) { items.push(unquote(stripComment(m[1]))); continue; }
      if (/^\s*(#.*)?$/.test(lines[j])) continue;
      break;
    }
  } else {
    value = value.replace(/^\[(.*)\]$/, '$1');
    items = value.split(',').map(unquote);
  }
  items = items.filter(Boolean);
  if (!items.length) return { kind: 'all', note: 'empty tools value = all tools (Claude Code default)' };
  if (items.length === 1 && ALL_RE.test(items[0])) return { kind: 'all', note: `tools: ${items[0]} = all tools` };
  return { kind: 'list', tools: items };
}

/** parseTools(text) -> string[] (the list) | null (all tools) | undefined (cannot read tools: fail closed). */
function parseTools(text) {
  const r = readTools(text);
  return r.kind === 'list' ? r.tools : r.kind === 'all' ? null : undefined;
}

function loadAgent(name, dirs = DEFAULT_DIRS) {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) return undefined;
  for (const d of dirs) {
    const p = path.join(d, name + '.md');
    if (!fs.existsSync(p)) continue;
    let r;
    try { r = readTools(fs.readFileSync(p, 'utf8')); } catch (e) { r = { kind: 'unreadable', note: 'cannot read file: ' + (e.code || e.message) }; }
    return { name, file: p, tools: r.kind === 'list' ? r.tools : r.kind === 'all' ? null : undefined, read: r };
  }
  return undefined;
}

/** checkFit(name, needs) — case-SENSITIVE (Claude Code tool names are); a case-only near miss is listed in nearMiss. */
function checkFit(name, needs, opts = {}) {
  const a = loadAgent(name, opts.agentsDirs || DEFAULT_DIRS);
  if (!a) return { ok: false, unknown: true, agent: name, missing: [] };
  if (a.read.kind === 'unreadable') return { ok: false, unreadable: true, agent: name, missing: [], note: a.read.note, file: a.file };
  if (a.read.kind === 'all') return { ok: true, agent: name, missing: [], allTools: true, note: a.read.note, file: a.file };
  const have = new Set(a.tools);
  const missing = needs.filter((n) => !have.has(n));
  const nearMiss = [];
  for (const n of missing) {
    const hit = a.tools.find((t) => t.toLowerCase() === n.toLowerCase());
    if (hit) nearMiss.push({ need: n, have: hit });
  }
  const r = { ok: missing.length === 0, agent: name, missing, tools: a.tools, file: a.file };
  if (nearMiss.length) r.nearMiss = nearMiss;
  return r;
}

function inferTools(text) {
  const out = new Set();
  for (const [re, tools] of SIGNALS) if (re.test(text)) tools.forEach((t) => out.add(t));
  return [...out];
}

function listAgents(dirs = DEFAULT_DIRS) {
  const names = new Set();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) names.add(f.slice(0, -3));
  }
  return [...names].sort();
}

function suggest(needs, opts = {}) {
  const dirs = opts.agentsDirs || DEFAULT_DIRS;
  return listAgents(dirs).filter((n) => {
    const a = loadAgent(n, dirs);
    return a && Array.isArray(a.tools) && checkFit(n, needs, { agentsDirs: dirs }).ok;
  });
}

function parseArgs(argv) {
  const o = { dirs: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.flags.json = true;
    else if (a === '--agents-dir') o.dirs.push(argv[++i]);
    else if (a.startsWith('--')) o.flags[a.slice(2)] = argv[++i];
  }
  return o;
}

function main(argv) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  const dirs = o.dirs.length ? o.dirs : DEFAULT_DIRS;
  const needs = (o.flags.needs || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (cmd === 'check') {
    if (!o.flags.agent || !needs.length) { console.error('usage: check --agent <name> --needs <Tool[,Tool]> [--json]'); return 2; }
    const r = checkFit(o.flags.agent, needs, { agentsDirs: dirs });
    if (r.unknown) { console.error('unknown agent: ' + o.flags.agent); return 2; }
    if (r.unreadable) {
      if (o.flags.json) console.log(JSON.stringify(r));
      console.error(`cannot read tools of ${r.agent} (${r.note}): ${r.file}`);
      return 2;
    }
    if (o.flags.json) console.log(JSON.stringify(r));
    else if (r.allTools) console.log(`OK ${r.agent}: ${r.note}`);
    else if (r.ok) console.log(`OK ${r.agent} has ${needs.join(', ')}`);
    else console.log(`MISSING ${r.agent} lacks: ${r.missing.join(', ')} (has: ${r.tools.join(', ')}). Try: suggest --needs ${needs.join(',')}`);
    for (const m of r.nearMiss || []) console.error(`warning: ${r.agent} lists "${m.have}", which differs only in case from "${m.need}" (tool names are case-sensitive)`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'infer') {
    if (!o.flags.brief) { console.error('usage: infer --brief <file|->'); return 2; }
    let text;
    try { text = fs.readFileSync(o.flags.brief === '-' ? 0 : o.flags.brief, 'utf8'); }
    catch (e) { console.error('cannot read brief: ' + e.message); return 2; }
    console.log(inferTools(text).join(','));
    return 0;
  }
  if (cmd === 'suggest') {
    if (!needs.length) { console.error('usage: suggest --needs <Tool[,Tool]>'); return 2; }
    suggest(needs, { agentsDirs: dirs }).forEach((n) => console.log(n));
    return 0;
  }
  console.error('usage: forge-dispatch-fit.cjs check|infer|suggest ...');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { readTools, parseTools, loadAgent, checkFit, inferTools, suggest, listAgents };
