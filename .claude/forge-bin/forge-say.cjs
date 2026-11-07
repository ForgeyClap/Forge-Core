#!/usr/bin/env node
'use strict';
/**
 * forge-say.cjs — WP A1: the run's Team chat channel.
 *
 * Bosses talk to each other with Claude Code's SendMessage tool (granted to all 12 Bosses). SendMessage itself
 * leaves no trace in the run folder, so every message is ALSO appended here, one JSON line per message, to
 *   <runs>/<run_id>/team-chat.jsonl
 * A Boss with a shell writes its own line (via:"direct"); a Boss without one lists its messages under a
 * "TEAM MESSAGES" heading in its final text and the Lead relays them (--via lead, via:"lead").
 *
 * CLI:
 *   node forge-say.cjs <run_id> --from "<Boss>" --to "<Boss|lead>" --wp <id> [--kind message|handoff|blocker|question]
 *        [--via direct|lead] [--event] [--root <dir>] "<text>"
 *   node forge-say.cjs <run_id> --list [--wp <id>] [--json] [--root <dir>]
 *
 * Rules: from/to must be an agent-registry.json name (slug or display name, any case; Bosses and specialists) or
 * "lead"; names are stored as the registry display name. Empty text is refused. Every line passes the same secret
 * gate the stores and hooks use (forge-store.cjs redactText + redactValue over SECRET_PATTERNS / SECRET_KEY_RE); if
 * that module cannot be loaded nothing is written (fail closed). The run folder must already exist (a typo in the
 * run id never creates a stray run). --event mirrors the line as an agent_message event through log-event.cjs, but
 * only once that event type is registered in log-event.cjs KNOWN_EVENT_TYPES; until then it prints a notice and
 * writes the chat line only.
 *
 * Exit codes: 0 ok · 1 usage/validation error · 2 refused (secret gate unavailable, run folder missing).
 * Zero dependencies.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KINDS = ['message', 'handoff', 'blocker', 'question'];
const VIAS = ['direct', 'lead'];
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WP_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TEXT_MAX = 2000;
const CHAT_FILE = 'team-chat.jsonl';
const EVENT_TYPE = 'agent_message';
const EVENT_TIMEOUT_MS = 30000;

let forgePaths = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.scriptRoot === 'function') forgePaths = fp; } catch { forgePaths = null; }
let store = null;
try { const s = require('./forge-store.cjs'); if (s && typeof s.redactValue === 'function' && typeof s.redactText === 'function') store = s; } catch { store = null; }

function defaultRoot() {
  if (!forgePaths) return path.resolve(__dirname, '..', '..');
  try { return forgePaths.scriptRoot(__dirname); } catch { return null; }
}

/** parseArgs(argv) -> {runId, opts, text, errors[]} */
function parseArgs(argv) {
  const opts = { kind: 'message', via: 'direct' };
  const rest = [];
  const errors = [];
  const VALUE_FLAGS = { '--from': 'from', '--to': 'to', '--wp': 'wp', '--kind': 'kind', '--via': 'via', '--root': 'root' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, a)) {
      if (i + 1 >= argv.length) { errors.push(a + ' needs a value'); continue; }
      opts[VALUE_FLAGS[a]] = argv[++i];
    } else if (a === '--list') opts.list = true;
    else if (a === '--event') opts.event = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) errors.push('unknown flag ' + a);
    else rest.push(a);
  }
  return { runId: rest[0], text: rest.slice(1).join(' '), opts, errors };
}

/** loadNames(root) -> Map(lowercased slug|display -> display), or {error}. "lead" is always valid. */
function loadNames(root) {
  const file = path.join(root, '.claude', 'config', 'agents', 'agent-registry.json');
  let reg;
  try { reg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return { error: 'agent-registry.json unreadable (' + (e.code || e.message.split('\n')[0]) + ')' }; }
  const map = new Map([['lead', 'lead']]);
  for (const group of [reg.agents, reg.specialistAgents]) {
    if (!group || typeof group !== 'object') continue;
    for (const [slug, a] of Object.entries(group)) {
      if (slug.startsWith('_') || !a || typeof a !== 'object') continue;
      const display = a.name ? String(a.name) : slug;
      map.set(slug.toLowerCase(), display);
      map.set(display.toLowerCase(), display);
    }
  }
  return { map };
}

/** runDirOf(root, runId) -> existing run folder or null (new layout first, then legacy .claude/forge-runs). */
function runDirOf(root, runId) {
  const bases = [];
  if (forgePaths && typeof forgePaths.existingStateDirs === 'function') {
    try { for (const d of forgePaths.existingStateDirs(root, 'runs')) bases.push(d); } catch { /* fall through to the fixed list */ }
  }
  bases.push(path.join(root, '.forge', 'runs'), path.join(root, '.claude', 'forge-runs'));
  for (const base of bases) {
    const dir = path.join(base, runId);
    const rb = path.resolve(base), rd = path.resolve(dir);
    if (!rd.startsWith(rb + path.sep)) continue;
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* next */ }
  }
  return null;
}

/** scrub(record) -> record with secrets masked (free text first, then key/pattern pass). Requires forge-store. */
function scrub(record) {
  const r = Object.assign({}, record, { text: store.redactText(record.text) });
  return store.redactValue(r);
}

/** buildLine(fields, names) -> {line} | {error}. Pure: no I/O besides the clock. */
function buildLine(f, names) {
  const from = names.get(String(f.from || '').trim().toLowerCase());
  const to = names.get(String(f.to || '').trim().toLowerCase());
  if (!f.from) return { error: '--from is required' };
  if (!f.to) return { error: '--to is required' };
  if (!from) return { error: '--from "' + f.from + '" is not an agent-registry.json name (or "lead")' };
  if (!to) return { error: '--to "' + f.to + '" is not an agent-registry.json name (or "lead")' };
  if (!f.wp || !WP_RE.test(String(f.wp))) return { error: '--wp <id> is required (letters, digits, . _ -, max 64)' };
  if (!KINDS.includes(f.kind)) return { error: '--kind must be one of ' + KINDS.join('|') };
  if (!VIAS.includes(f.via)) return { error: '--via must be one of ' + VIAS.join('|') };
  const text = String(f.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'empty text refused: give the message as the last argument' };
  if (text.length > TEXT_MAX) return { error: 'text is ' + text.length + ' chars; the limit is ' + TEXT_MAX + ' (a message is one line, not a report)' };
  const rec = { ts: new Date().toISOString(), run_id: f.runId, from, to, wp_id: String(f.wp), kind: f.kind, text, via: f.via };
  return { line: scrub(rec) };
}

/** eventTypeRegistered(root) -> {registered:boolean, reason}. Reads log-event.cjs KNOWN_EVENT_TYPES at runtime. */
function eventTypeRegistered(root) {
  const file = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  if (!fs.existsSync(file)) return { registered: false, reason: 'log-event.cjs not found' };
  try {
    const le = require(file);
    if (le && le.KNOWN_EVENT_TYPES && typeof le.KNOWN_EVENT_TYPES.has === 'function') return { registered: le.KNOWN_EVENT_TYPES.has(EVENT_TYPE), reason: 'KNOWN_EVENT_TYPES' };
    return { registered: false, reason: 'log-event.cjs exports no KNOWN_EVENT_TYPES' };
  } catch (e) { return { registered: false, reason: 'log-event.cjs could not be loaded (' + e.message.split('\n')[0].slice(0, 120) + ')' }; }
}

/** mirrorEvent(root, line) -> {ok, message}. Writes the payload to a temp file and calls log-event.cjs --file. */
function mirrorEvent(root, line) {
  const reg = eventTypeRegistered(root);
  if (!reg.registered) return { ok: true, skipped: true, message: 'NOTICE --event: "' + EVENT_TYPE + '" is not registered in log-event.cjs KNOWN_EVENT_TYPES yet (' + reg.reason + '); only the team-chat line was written' };
  const payload = { agent: line.from === 'lead' ? 'orchestrator' : line.from, to: line.to, wp_id: line.wp_id, kind: line.kind, text: line.text, via: line.via, channel: CHAT_FILE };
  const tmp = path.join(os.tmpdir(), 'forge-say-' + process.pid + '-' + Date.now() + '.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    const r = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), line.run_id, EVENT_TYPE, '--file', tmp], { encoding: 'utf8', timeout: EVENT_TIMEOUT_MS, cwd: root });
    if (r.error) return { ok: false, message: 'agent_message event not written: ' + r.error.message };
    if (r.status !== 0) return { ok: false, message: 'agent_message event refused by log-event.cjs (exit ' + r.status + '): ' + String(r.stderr || r.stdout).trim().slice(0, 300) };
    return { ok: true, message: String(r.stdout).trim() };
  } finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
}

/** readChannel(file, wp) -> {lines, bad} in file order. */
function readChannel(file, wp) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lines = []; let bad = 0;
  for (const l of raw.split(/\r?\n/)) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { bad++; continue; }
    if (wp && o.wp_id !== wp) continue;
    lines.push(o);
  }
  return { lines, bad };
}

function fmt(o) { return o.ts + '  [' + o.from + ' -> ' + o.to + '] ' + o.text + ' | wp=' + o.wp_id + ' | kind=' + o.kind + (o.via === 'lead' ? ' | via=lead' : ''); }

function main(argv, io) {
  const out = io && io.out ? io.out : (s) => console.log(s);
  const err = io && io.err ? io.err : (s) => console.error(s);
  const p = parseArgs(argv);
  if (p.errors.length) { err('forge-say: ' + p.errors.join('; ')); return 1; }
  if (!p.runId || !RUN_ID_RE.test(p.runId)) { err('usage: node forge-say.cjs <run_id> --from "<Boss>" --to "<Boss|lead>" --wp <id> [--kind ' + KINDS.join('|') + '] "<text>"  |  <run_id> --list [--wp <id>]'); return 1; }
  const root = p.opts.root ? path.resolve(p.opts.root) : defaultRoot();
  if (!root) { err('forge-say: no project root found; pass --root <dir>'); return 1; }
  const runDir = runDirOf(root, p.runId);
  if (!runDir) { err('forge-say: run folder for "' + p.runId + '" does not exist (refused; start the run first)'); return 2; }
  const file = path.join(runDir, CHAT_FILE);

  if (p.opts.list) {
    const { lines, bad } = readChannel(file, p.opts.wp);
    if (p.opts.json) out(JSON.stringify(lines));
    else if (!lines.length) out('(no team messages' + (p.opts.wp ? ' for wp=' + p.opts.wp : '') + ')');
    else for (const o of lines) out(fmt(o));
    if (bad) err('forge-say: ' + bad + ' unreadable line(s) skipped');
    return 0;
  }

  if (!store) { err('forge-say: forge-store.cjs (the secret gate) could not be loaded; nothing written'); return 2; }
  const names = loadNames(root);
  if (names.error) { err('forge-say: ' + names.error); return 1; }
  const b = buildLine(Object.assign({}, p.opts, { runId: p.runId, text: p.text }), names.map);
  if (b.error) { err('forge-say: ' + b.error); return 1; }
  const json = JSON.stringify(b.line);
  fs.appendFileSync(file, json + '\n', { encoding: 'utf8', flag: 'a' });
  out(json);
  if (p.opts.event) {
    const m = mirrorEvent(root, b.line);
    (m.ok ? out : err)(m.message);
    if (!m.ok) return 1;
  }
  return 0;
}

module.exports = { parseArgs, loadNames, runDirOf, buildLine, scrub, readChannel, eventTypeRegistered, main, KINDS, CHAT_FILE, EVENT_TYPE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
