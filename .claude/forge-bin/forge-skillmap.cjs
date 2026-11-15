#!/usr/bin/env node
'use strict';
/**
 * forge-skillmap.cjs — read the Lead's skill map and measure which skills a subagent really opened (category finding
 * SK1, 2026-11-07).
 *
 * WHY: the Lead logs a skill_map_created event that assigns skills per agent, but on three measured runs the agents
 * never received or opened them. forge-subagent-start.cjs uses this module to inject the assigned skills into the
 * subagent (SubagentStart additionalContext); forge-subagent-stop.cjs uses it to record which skills the subagent's
 * own transcript shows it opened.
 *
 * Exports (every function is total: it never throws):
 *   knownSkillNames(root, {home?})        -> Set of skill folder names with a SKILL.md under <root>/.claude/skills/
 *                                            and under <home>/.claude/skills/ (home defaults to os.homedir()).
 *   skillLocations(root, {home?})         -> Map name -> display path of its SKILL.md (project wins over home).
 *   normalizeSkillMap(map, known)         -> { '<agent-type>': ['<skill>', ...] }.
 *   agentTypeKey(name)                    -> "UI Boss" -> "ui-boss" (null when not a usable agent type).
 *   latestSkillMap(runDir)                -> the map of the LAST skill_map_created event in <runDir>/events.jsonl, or null.
 *   skillsOpenedInTranscript(file, opts)  -> { skills, scanned }: Skill tool calls and Reads of skills/<name>/SKILL.md.
 *   agentFileInfo(root, type, {home?})    -> { found, file, skills, tools } from .claude/agents/<type>.md (SD-T4).
 *   preloadedSkillsOf(root, type, {home?})-> the agent file's frontmatter skills: ([] without a file).
 *   skillBody(root, name, {home?,maxChars?}) -> a SKILL.md without its frontmatter, or null.
 *   conductSeenInTranscript(file)         -> true | false | null: the forge-conduct canary in the last assistant text.
 * Zero dependencies.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TRANSCRIPT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_EVENTS_BYTES = 32 * 1024 * 1024;
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_TYPE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const WP_KEY_RE = /^(wp|work[-_ ]?package)[-_ .]?[A-Za-z0-9._-]*$/i;
const SKILL_MD_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function homeOf(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'home')) return typeof opts.home === 'string' ? opts.home : null;
  try { return os.homedir(); } catch { return null; }
}

/** skillDirsIn(base) -> names of folders under <base>/.claude/skills that hold a SKILL.md. Never throws. */
function skillDirsIn(base) {
  if (typeof base !== 'string' || !base) return [];
  const dir = path.join(base, '.claude', 'skills');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    try {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (!SKILL_NAME_RE.test(e.name)) continue;
      if (fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) out.push(e.name);
    } catch { /* skip an unreadable entry */ }
  }
  return out;
}

function skillLocations(root, opts) {
  const map = new Map();
  try {
    for (const n of skillDirsIn(root)) map.set(n, '.claude/skills/' + n + '/SKILL.md');
    for (const n of skillDirsIn(homeOf(opts))) if (!map.has(n)) map.set(n, '~/.claude/skills/' + n + '/SKILL.md');
  } catch { /* keep what was found */ }
  return map;
}

function knownSkillNames(root, opts) { return new Set(skillLocations(root, opts).keys()); }

/** agentTypeKey(name) — "UI Boss" / "ui_boss" / " Verify Boss " -> "ui-boss" / "verify-boss"; null when unusable. */
function agentTypeKey(name) {
  if (typeof name !== 'string') return null;
  const k = name.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return AGENT_TYPE_RE.test(k) ? k : null;
}

/** stripPlugin("some-plugin:frontend-design") -> "frontend-design". */
function stripPlugin(s) { const i = s.lastIndexOf(':'); return i >= 0 ? s.slice(i + 1) : s; }

/** knownLookup(known) -> Map lowercased -> canonical name. */
function knownLookup(known) {
  const m = new Map();
  const list = known instanceof Set ? [...known] : Array.isArray(known) ? known : [];
  for (const n of list) if (typeof n === 'string' && n) m.set(n.toLowerCase(), n);
  return m;
}

/** skillsInText(text, lookup) -> known skill names among the tokens of a free-text string, in order. */
function skillsInText(text, lookup) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const raw of text.split(/[^A-Za-z0-9._:-]+/)) {
    const tok = stripPlugin(raw).replace(/^[.\-]+|[.\-:]+$/g, '');
    if (!tok) continue;
    const hit = lookup.get(tok.toLowerCase());
    if (hit) out.push(hit);
  }
  return out;
}

function skillsInValue(v, lookup) {
  if (typeof v === 'string') return skillsInText(v, lookup);
  if (Array.isArray(v)) { const out = []; for (const x of v) out.push(...skillsInText(x, lookup)); return out; }
  if (isObj(v) && Array.isArray(v.skills)) return skillsInValue(v.skills, lookup);
  return [];
}

/** normalizeSkillMap(map, known) -> { agentType: [skill, ...] }. A WP-style key ("WP3") takes the agent type from the
 *  text before the first ':' of its string value; any other key is the agent (display names normalised). Only names in
 *  `known` survive; duplicates merge; an agent left with no skill is omitted. Never throws. */
function normalizeSkillMap(map, known) {
  const out = {};
  try {
    if (!isObj(map)) return out;
    const lookup = knownLookup(known);
    if (!lookup.size) return out;
    for (const [key, value] of Object.entries(map)) {
      let agent = null;
      let skillsFrom = value;
      if (WP_KEY_RE.test(key)) {
        if (typeof value !== 'string') continue;
        const i = value.indexOf(':');
        if (i <= 0) continue;
        agent = agentTypeKey(value.slice(0, i));
        skillsFrom = value.slice(i + 1);
      } else {
        agent = agentTypeKey(key);
      }
      if (!agent) continue;
      const skills = skillsInValue(skillsFrom, lookup);
      if (!skills.length) continue;
      const list = out[agent] || (out[agent] = []);
      for (const s of skills) if (!list.includes(s)) list.push(s);
    }
  } catch { /* return what was built */ }
  return out;
}

/** readBounded(file, maxBytes, fromEnd) -> string | null. */
function readBounded(file, maxBytes, fromEnd) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.max(0, Math.min(size, maxBytes));
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    const start = fromEnd ? size - len : 0;
    let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, start + got); if (n <= 0) break; got += n; }
    return buf.subarray(0, got).toString('utf8');
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** allSkillMaps(runDir) -> every skill_map_created map object of the run, in order ([] when none). Never throws. */
function allSkillMaps(runDir) {
  try {
    if (typeof runDir !== 'string' || !runDir) return [];
    const text = readBounded(path.join(runDir, 'events.jsonl'), MAX_EVENTS_BYTES, true);
    if (!text) return [];
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.includes('skill_map_created')) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!isObj(ev) || ev.event_type !== 'skill_map_created') continue;
      // `skills` is the older documented field (verifier finding): read it too, so the hook and the contract agree.
      const m = [ev.map, ev.skill_map, ev.skills, isObj(ev.payload) ? ev.payload.map : null, isObj(ev.details) ? ev.details.map : null].find(isObj);
      if (m) out.push(m);
    }
    return out;
  } catch { return []; }
}

/** latestSkillMap(runDir) -> map object of the last skill_map_created event, or null. Never throws. */
function latestSkillMap(runDir) { const all = allSkillMaps(runDir); return all.length ? all[all.length - 1] : null; }

/** unionSkillMap(maps, known) -> {agentType: [skill]} — every map normalised and merged (SK2: a later map adds, never drops). */
function unionSkillMap(maps, known) {
  const out = {};
  for (const m of maps || []) for (const [a, skills] of Object.entries(normalizeSkillMap(m, known))) out[a] = Array.from(new Set((out[a] || []).concat(skills)));
  return out;
}

/** Agent types that build, make the UI or test (SK4/SK6): they must work with skills; planning roles are not judged. */
const EXECUTOR_TYPES = new Set(['build-boss', 'ui-boss', 'test-boss', 'integration-boss', 'seo-boss', 'electron-pro', 'data-scientist', 'mcp-developer', 'ml-engineer', 'payment-integration']);

/** skillsOpenedInTranscript(file, {maxBytes}) -> { skills, scanned }. Reads at most maxBytes (default 25 MB) from the
 *  start of a Claude Code transcript JSONL; counts only assistant tool_use blocks: Skill -> input.skill (plugin prefix
 *  stripped), Read of .../skills/<name>/SKILL.md -> <name>. Never throws. */
function skillsOpenedInTranscript(file, opts) {
  const res = { skills: [], scanned: false };
  try {
    if (typeof file !== 'string' || !file) return res;
    const max = opts && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_TRANSCRIPT_MAX_BYTES;
    const text = readBounded(file, max, false);
    if (text === null) return res;
    res.scanned = true;
    const add = (n) => { if (typeof n === 'string' && SKILL_NAME_RE.test(n) && !res.skills.includes(n)) res.skills.push(n); };
    for (const line of text.split('\n')) {
      if (!line.includes('tool_use')) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      if (!isObj(o) || o.type !== 'assistant' || !isObj(o.message) || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (!isObj(b) || b.type !== 'tool_use' || !isObj(b.input)) continue;
        if (b.name === 'Skill' && typeof b.input.skill === 'string') add(stripPlugin(b.input.skill.trim()));
        else if (b.name === 'Read' && typeof b.input.file_path === 'string') { const m = SKILL_MD_RE.exec(b.input.file_path); if (m) add(m[1]); }
      }
    }
  } catch { /* keep what was found */ }
  return res;
}

// ---- SD-T4: agent-file preloads, skill bodies and the forge-conduct canary ----
const AGENT_FILE_MAX_BYTES = 64 * 1024;          // frontmatter lives in the head; a huge agent file is never read whole
const SKILL_BODY_MAX_BYTES = 64 * 1024;
const CANARY_TAIL_BYTES = 4 * 1024 * 1024;       // the last assistant text is at the END of a transcript
const AGENT_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // no dot, no colon, no slash: a file name, never a path
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:()*-]{0,127}$/;
/** The line forge-conduct asks every agent to end its report with (.claude/skills/forge-conduct/SKILL.md). */
const CONDUCT_CANARY = 'conduct: forge-conduct v1';

/** frontmatterLines(text) -> the lines between the opening '---' and the closing '---' (or the end of the bounded head). */
function frontmatterLines(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') break; out.push(lines[i]); }
  return out;
}
/** listField(lines, key) -> string[] for `key: a, b`, `key: [a, "b"]` or a YAML block list; null when the key is absent. */
function listField(lines, key) {
  const unq = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m || m[1] !== key) continue;
    const inline = m[2].replace(/\s+#.*$/, '').trim();
    if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(unq).filter(Boolean);
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const b = /^\s+-\s*(.*)$/.exec(lines[j]);
      if (b) { const v = unq(b[1]); if (v) out.push(v); continue; }
      if (/^\s*(#.*)?$/.test(lines[j])) continue;
      break;
    }
    return out;
  }
  return null;
}

/** agentFileInfo(root, agentType, {home?}) -> {found, file, skills, tools}. Reads `.claude/agents/<type>.md` in the
 *  project, then in <home>; at most 64 KB of its head. skills = the frontmatter `skills:` (valid names only, [] when
 *  absent); tools = the `tools:` list, or null when the agent declares none (it then inherits every tool). A
 *  plugin-scoped type ("x:build-boss") is never looked up: its file is not the project's. Never throws. */
function agentFileInfo(root, agentType, opts) {
  const none = { found: false, file: null, skills: [], tools: null };
  try {
    const type = agentTypeKey(agentType);
    if (!type || !AGENT_FILE_RE.test(type)) return none;
    for (const base of [root, homeOf(opts)]) {
      if (typeof base !== 'string' || !base) continue;
      const file = path.join(base, '.claude', 'agents', type + '.md');
      let isFile = false;
      try { isFile = fs.statSync(file).isFile(); } catch { isFile = false; }
      if (!isFile) continue;
      const text = readBounded(file, AGENT_FILE_MAX_BYTES, false);
      if (text === null) continue;
      const fm = frontmatterLines(text);
      const skills = [];
      for (const s of listField(fm, 'skills') || []) { const n = stripPlugin(s); if (SKILL_NAME_RE.test(n) && !skills.includes(n)) skills.push(n); }
      const rawTools = listField(fm, 'tools');
      const tools = rawTools === null ? null : rawTools.filter((x) => TOOL_NAME_RE.test(x));
      return { found: true, file, skills, tools };
    }
  } catch { /* fall through */ }
  return none;
}

/** preloadedSkillsOf(root, agentType, {home?}) -> the agent file's frontmatter `skills:`; [] without a file. Never throws. */
function preloadedSkillsOf(root, agentType, opts) { return agentFileInfo(root, agentType, opts).skills.slice(); }

/** skillBody(root, name, {home?, maxChars?}) -> the SKILL.md text without its frontmatter (project, then home), or null.
 *  Bounded: at most 64 KB is read, at most maxChars returned. Never throws. */
function skillBody(root, name, opts) {
  try {
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return null;
    for (const base of [root, homeOf(opts)]) {
      if (typeof base !== 'string' || !base) continue;
      const text = readBounded(path.join(base, '.claude', 'skills', name, 'SKILL.md'), SKILL_BODY_MAX_BYTES, false);
      if (text === null) continue;
      let body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
      const fm = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/.exec(body);
      if (fm) body = body.slice(fm[0].length);
      body = body.trim();
      const max = opts && Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : body.length;
      return body.length > max ? body.slice(0, max) : body;
    }
  } catch { /* none */ }
  return null;
}

/** textOf(content) -> the joined text blocks of an assistant message content (string or block array), or ''. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** stringsOf(v, depth) -> every string inside a JSON value (depth-capped at 6). */
function stringsOf(v, depth) {
  if (typeof v === 'string') return [v];
  if (depth > 6 || !v || typeof v !== 'object') return [];
  return (Array.isArray(v) ? v : Object.values(v)).flatMap((x) => stringsOf(x, depth + 1));
}

/** conductSeenInTranscript(file) -> true when the LAST assistant text (or, for a Workflow agent, the input of its final
 *  StructuredOutput call) of the transcript contains the forge-conduct
 *  canary line, false when it does not (or the transcript has no assistant text), null when the file cannot be read.
 *  Reads at most the last 4 MB. Never throws. */
function conductSeenInTranscript(file) {
  try {
    if (typeof file !== 'string' || !file) return null;
    const text = readBounded(file, CANARY_TAIL_BYTES, true);
    if (text === null) return null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"assistant"')) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { continue; } // the first line of a tail read may be cut
      if (!isObj(o) || o.type !== 'assistant' || !isObj(o.message)) continue;
      // FB-SKILLTOOLS-F8: a Workflow agent hands in its report as a StructuredOutput call; that input is its last word
      const so = Array.isArray(o.message.content) ? o.message.content.filter((b) => isObj(b) && b.type === 'tool_use' && b.name === 'StructuredOutput') : [];
      if (so.length) return so.some((b) => stringsOf(b.input, 0).some((s) => s.includes(CONDUCT_CANARY)));
      const said = textOf(o.message.content);
      if (!said.trim()) continue; // a tool_use-only turn: keep looking for the last real text
      return said.includes(CONDUCT_CANARY);
    }
    return false;
  } catch { return null; }
}

module.exports = { knownSkillNames, skillLocations, normalizeSkillMap, agentTypeKey, latestSkillMap, allSkillMaps, unionSkillMap, EXECUTOR_TYPES, skillsOpenedInTranscript, DEFAULT_TRANSCRIPT_MAX_BYTES,
  agentFileInfo, preloadedSkillsOf, skillBody, conductSeenInTranscript, CONDUCT_CANARY };
