'use strict';
/**
 * doctor/checks-completeness.cjs — one module of forge-doctor.cjs (WP A11 part 2): advisory completeness: sync_completeness, memory_discipline, unregistered_event (enforced), mcp_dormancy.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { BIN_DIR, claudeDir, listByExt, memoryReadPath, relPosix, syncTool, verifyTool } = require('./context.cjs');

// ===========================================================================================================
// WAVE A / A2 — doctor completeness checks. All four are ADVISORY-ONLY (see the header doc
// comment above for why); each function below is a pure `(root) -> {ok, ...}` reader, mirroring the shape of
// every other check in this file, so they compose the same way in runDoctor()/printSummary().
// ===========================================================================================================

// --- sync-completeness: every real skill dir / forge-bin tool / agent .md is in forge-sync's delivery list
// (listSystemFiles).: that list is DERIVED from the shipping manifest
// (config/orchestration/FORGE_SHIP_MANIFEST.json — the root's own copy, else forge-sync's), which ships skill
// folders whole and globs forge-bin/agents; the hand-kept SYSTEM[] pin list and SYSTEM_GLOB are gone. This stays an
// honest regression guard: a SKILL.md, tool or agent that the manifest does NOT classify ship-sync (a narrowed or
// broken rule — the old "forge-router silent-drift bug" class) is still flagged here.
function listSkillFiles(root) {
  const base = path.join(claudeDir(root), 'skills');
  const cd = claudeDir(root);
  const out = [];
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'SKILL.md') out.push(path.relative(cd, p).split(path.sep).join('/'));
    }
  })(base);
  return out.sort();
}
function syncCompleteness(root) {
  if (!syncTool) return { ok: false, reason: 'forge-sync.cjs module not available (sync-completeness unavailable)', missing: [] };
  const cd = claudeDir(root);
  let manifestList;
  try { manifestList = syncTool.listSystemFiles(cd); } catch (e) { return { ok: false, reason: 'forge-sync.listSystemFiles threw: ' + e.message, missing: [] }; }
  const manifestSet = new Set(manifestList.map((r) => r.split(path.sep).join('/')));
  const skillFiles = listSkillFiles(root);
  const binFiles = listByExt(path.join(cd, 'forge-bin'), ['.cjs', '.ps1', '.cmd', '.sh', '.md', '.bat']).map((p) => 'forge-bin/' + path.basename(p));
  const agentFiles = listByExt(path.join(cd, 'agents'), ['.md']).map((p) => 'agents/' + path.basename(p));
  // WP-DOC-ADV: a file the shipping manifest DELIBERATELY classifies local-only (maintainer tools
  // such as forge-fresh-repo.cjs / forge-release-sync.cjs) is not a sync gap — it is reported under
  // intentionallyLocal instead of missing. ONLY the local-only class is exempt: an unclassified file or any other
  // class (a narrowed/broken ship rule) is still flagged. A manifest that cannot be loaded keeps the old behaviour.
  let ship = null;
  try { ship = syncTool.loadShipManifest ? syncTool.loadShipManifest(cd) : null; } catch { ship = null; }
  const isLocalOnly = (rel) => {
    if (!ship) return false;
    try { const r = ship.sc.classify(ship.rules, '.claude/' + rel); return !!r && r.class === 'local-only'; } catch { return false; }
  };
  const missing = [];
  const intentionallyLocal = [];
  for (const rel of skillFiles.concat(binFiles, agentFiles)) {
    if (manifestSet.has(rel)) continue;
    if (isLocalOnly(rel)) intentionallyLocal.push(rel);
    else missing.push(rel);
  }
  return { ok: missing.length === 0, checkedSkills: skillFiles.length, checkedBinTools: binFiles.length, checkedAgents: agentFiles.length, missing, intentionallyLocal };
}

// --- memory-discipline: FORGE_MEMORY.md is absent/empty, or still carries an unfilled scaffold-placeholder
// marker. Deliberately narrow (angle-bracket ALL-CAPS/underscore tokens + explicit TODO/TBD/FIXME markers)
// so it never false-positives on ordinary lowercase prose placeholders this project's real memory legitimately
// uses (e.g. "<boss>" as a variable reference in a sentence) — proven clean against the real FORGE_MEMORY.md.
const MEMORY_PLACEHOLDER_RE = /<PLACEHOLDER>|<TODO>|<TBD>|<FILL[_ ]IN>|<[A-Z][A-Z0-9]*(_[A-Z0-9]+)+>|\[TODO\]|\[TBD\]|\bTODO:|\bFIXME\b|\bTBD\b/;
function memoryDiscipline(root) {
  const file = memoryReadPath(root, 'FORGE_MEMORY.md'); // WP 2.1: .forge/memory/ in a .forge project (legacy fallback)
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { ok: false, present: false, reason: 'FORGE_MEMORY.md is absent (expected at ' + relPosix(root, file) + ')', placeholderLines: [] }; }
  if (!text.trim()) return { ok: false, present: true, reason: 'FORGE_MEMORY.md exists but is empty', placeholderLines: [] };
  const placeholderLines = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (MEMORY_PLACEHOLDER_RE.test(lines[i])) placeholderLines.push(i + 1);
  return { ok: placeholderLines.length === 0, present: true, reason: placeholderLines.length ? placeholderLines.length + ' unfilled placeholder line(s)' : '', placeholderLines };
}

// --- unregistered-event: a forge-bin/*.cjs tool's local logEvent(...) wrapper is called with a literal
// event_type string that log-event.cjs's KNOWN_EVENT_TYPES does not recognize (it would be STRICT-REJECTED,
// exit 2, at write time — see strictEventCheck above). Cross-checked against forge-verify.cjs's own
// TERMINAL_TYPES/BACKBONE mirror too, per the plan's 3-place event-registration discipline.
/** stripJsComments(text) -> the same source with // line comments and block comments removed.
 *  String-literal aware, single left-to-right pass: while inside a quoted string a `//` or a block-comment
 *  opener is just text, and while inside a comment a quote character is just text. That statefulness is the
 *  whole point — the naive stateless literal regex below cannot tell the two apart, which is exactly how an
 *  APOSTROPHE in comment prose used to flip quote parity and hide every event type after it (see
 *  extractKnownEventTypesFromSource). Same idea forge-event-wiring.test.cjs already applies before reading
 *  app.js's taskStatus() buckets, generalized here to trailing and block comments as well.
 *  Newlines are preserved (line structure stays intact) — INCLUDING every newline a multi-line block comment
 *  itself contained (2026-09-26: this doc comment already promised "line structure stays intact",
 *  but the implementation collapsed a whole multi-line `/** ... *\/` block down to a single space, silently
 *  losing every embedded newline; any caller computing a LINE NUMBER from an index into the stripped text —
 *  e.g. vacuousBooleanTHelperSites' own findings below — would report a line far too early for any code
 *  after the first multi-line JSDoc-style comment, and this codebase is full of those). A block comment now
 *  collapses to one leading space plus exactly as many `\n` as it consumed, so it can never weld two tokens
 *  together AND never shifts a later line number. Not a JS parser: a `/` that starts a regex literal is out
 *  of scope, which is fine for the string-literal lists this is used on. */
function stripJsComments(text) {
  let out = '';
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;   // the '\n' itself is kept by the default branch
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      let nl = 0;
      for (let k = start; k < i && k < n; k++) if (text[k] === '\n') nl++;
      out += ' ' + '\n'.repeat(nl); // one space so tokens never weld together, plus every newline the comment consumed
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] || ''); i += 2; continue; }
        out += text[i];
        const closed = text[i] === quote;
        i++;
        if (closed) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
/** extractKnownEventTypesFromSource(text) -> Set of the event types log-event.cjs really registers.
 *  Comments are stripped from the WHOLE source FIRST — before the Set literal is located and before any
 *  string literal is read — so neither the locating regex nor the literal scan can be steered by comment
 *  prose. Measured on this project's real log-event.cjs when the strip was missing: 186 types
 *  registered, 175 seen, 20 real types silently invisible to the ENFORCED unregistered_event gate, and 9
 *  junk "types" invented out of comment text. */
function extractKnownEventTypesFromSource(text) {
  const m = stripJsComments(text).match(/KNOWN_EVENT_TYPES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) return null;
  const out = new Set();
  const re = /'([^']+)'|"([^"]+)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out.add(mm[1] || mm[2]);
  return out;
}
const EVENT_TYPE_SHAPE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // snake_case, matches KNOWN_EVENT_TYPES' own naming convention
/** extractLoggedEventTypes — for every `logEvent(` call site, reads only the argument text BEFORE the call's
 *  object-literal payload (its first `{`) — every real logEvent() wrapper in this codebase places the literal
 *  event_type string there, whether as the 1st positional arg (forge-paperclip.cjs's `logEvent(type, obj)`) or
 *  the 2nd/3rd (forge-artifact.cjs/forge-deeplearn.cjs/forge-mindmap.cjs/forge-prd.cjs/forge-registry.cjs's
 *  `logEvent(runId, eventType, extra)`). This avoids ever matching an unrelated string INSIDE the payload
 *  object (a `note`/`evidence` value). A dynamically-built event_type (e.g. `ev.event_type`, a variable) has
 *  no quoted literal to find and is honestly skipped — never guessed. Best-effort static scan only; it does
 *  not attempt to resolve every possible spawnSync/execFileSync call shape in the codebase. */
function extractLoggedEventTypes(text) {
  const out = new Set();
  const callRe = /\blogEvent\s*\(/g;
  let cm;
  while ((cm = callRe.exec(text)) !== null) {
    const start = cm.index + cm[0].length;
    let depth = 1, i = start, braceIdx = -1;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '{' && braceIdx === -1) braceIdx = i;
    }
    const argsPrefix = text.slice(start, braceIdx !== -1 ? braceIdx : i);
    const litRe = /'([^']*)'|"([^"]*)"/g;
    let lm;
    while ((lm = litRe.exec(argsPrefix)) !== null) {
      const lit = lm[1] !== undefined ? lm[1] : lm[2];
      if (EVENT_TYPE_SHAPE_RE.test(lit)) out.add(lit);
    }
  }
  return out;
}
function unregisteredEvent(root) {
  const logEventPath = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  let leText;
  try { leText = fs.readFileSync(logEventPath, 'utf8'); }
  catch (e) { return { ok: false, reason: 'could not read log-event.cjs: ' + e.message, unregistered: [] }; }
  const known = extractKnownEventTypesFromSource(leText);
  if (!known) return { ok: false, reason: 'could not statically parse KNOWN_EVENT_TYPES from log-event.cjs', unregistered: [] };
  const verifySet = new Set();
  if (verifyTool) {
    try {
      for (const t of verifyTool.TERMINAL_TYPES || []) verifySet.add(t);
      for (const t of verifyTool.BACKBONE || []) verifySet.add(t);
    } catch { /* best effort — verify cross-check stays empty */ }
  }
  const dir = path.join(claudeDir(root), 'forge-bin');
  const files = listByExt(dir, ['.cjs']).filter((f) => !f.endsWith('.test.cjs'));
  const unregistered = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const type of extractLoggedEventTypes(text)) {
      if (known.has(type)) continue;
      const missingFrom = ['log-event.KNOWN_EVENT_TYPES'];
      if (verifyTool && !verifySet.has(type)) missingFrom.push('forge-verify.allow-list');
      unregistered.push({ file: path.relative(root, f).split(path.sep).join('/'), event_type: type, missingFrom });
    }
  }
  return { ok: unregistered.length === 0, checkedFiles: files.length, unregistered };
}

// --- mcp-dormancy (WAVE G / G-INTEGRATE): the MCP-as-client SAFETY DOCTRINE self-test.
// Reads config/orchestration/mcp-registry.json + mcp-grants.json (+ an owner-authored real `.mcp.json` MCP
// host config at the project root, if one exists — NOT config/mcp/.mcp.json.example, which is a reference
// template, never live config) and asserts, purely by reading JSON (never by requiring forge-mcp-gate.cjs,
// so a malformed/adversarial fixture can be reported as a finding instead of crashing the whole doctor run):
//   (a) no registry server is status:"active"/active:true without being listed in mcp-opt-in.json's
//       opted_in[] (the owner-authored dormancy marker), and no server configured in a real `.mcp.json`
//       host file is missing from that same opt-in list;
//   (b) no boss's mcp-grants.json allow_servers entry exceeds that boss's own declared max_tier, and no
//       allow_servers entry references a server id absent from the registry;
//   (c) no boss's allow_servers ever contains a tier-3 (WRITE-PRIMITIVE) server — tier-3 must never be a
//       standing/default grant, regardless of the boss's numeric max_tier (doctrine #3/#4).
// ADVISORY-ONLY (folded into report.advisory.completeness, same discipline as the other 4 WAVE A/A2 checks
// above) — a brand-new heuristic must never flip a healthy project's doctor run red the first time it ships.
function mcpDormancy(root, opts) {
  opts = opts || {};
  const cd = claudeDir(root);
  const registryPath = opts.registryPath || path.join(cd, 'config', 'orchestration', 'mcp-registry.json');
  const grantsPath = opts.grantsPath || path.join(cd, 'config', 'orchestration', 'mcp-grants.json');
  const optInPath = opts.optInPath || path.join(cd, 'config', 'orchestration', 'mcp-opt-in.json');
  const mcpJsonPath = opts.mcpJsonPath || path.join(root, '.mcp.json'); // real owner-authored MCP host config — NOT the .example template

  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'could not read/parse mcp-registry.json: ' + e.message, violations: [] }; }
  if (!registry || !Array.isArray(registry.servers)) return { ok: false, reason: 'mcp-registry.json has no "servers" array', violations: [] };

  let grants;
  try { grants = JSON.parse(fs.readFileSync(grantsPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'could not read/parse mcp-grants.json: ' + e.message, violations: [] }; }
  if (!grants || !grants.bosses || typeof grants.bosses !== 'object') return { ok: false, reason: 'mcp-grants.json has no "bosses" object', violations: [] };

  let optIn = { opted_in: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(optInPath, 'utf8'));
    if (parsed && Array.isArray(parsed.opted_in)) optIn = parsed;
  } catch { /* missing/malformed opt-in file -> dormant default; the forge-mcp-gate live path hard-errors on a MALFORMED (not missing) file, but this advisory reader stays lenient by design */ }
  const optedIn = new Set(optIn.opted_in);

  const violations = [];

  // (a) no server auto-active without an explicit opt-in marker
  for (const s of registry.servers) {
    if (!s || typeof s.id !== 'string') continue;
    const autoActive = s.status === 'active' || s.active === true;
    if (autoActive && !optedIn.has(s.id)) {
      violations.push({ type: 'auto_active_without_optin', server: s.id, detail: 'registry entry is active/auto-active but "' + s.id + '" is not listed in mcp-opt-in.json opted_in[]' });
    }
  }
  let mcpJson = null;
  try { mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')); } catch { mcpJson = null; }
  if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') {
    for (const id of Object.keys(mcpJson.mcpServers)) {
      if (!optedIn.has(id)) violations.push({ type: 'mcp_json_server_without_optin', server: id, detail: 'a real .mcp.json configures server "' + id + '" but it is not listed in mcp-opt-in.json opted_in[]' });
    }
  }

  // (a2) REGISTRY DRIFT. The check above only ever read `.mcp.json`, which is exactly one of
  // the places Claude Code takes MCP servers from — so servers enabled through `.claude/settings.local.json`
  // (`enabledMcpjsonServers`) or `~/.claude.json` (global `mcpServers`) were invisible here. Measured on this
  // machine: claude-flow (≈400 tools, incl. terminal_execute/http_fetch) and n8n were connected and in NO
  // registry entry, so no tier and no per-Boss grant governed them — the tier-3 write gate hardened the day
  // before applied only to servers that do not exist here. forge-mcp-gate.unregisteredServers() reads every
  // real source; this stays ADVISORY and never auto-adds anything: inventing a tier for someone else's
  // server would be the same fabricated authority the doctrine exists to prevent.
  // Scope: the REAL machine only. Discovery reads machine-global sources (~/.claude.json,
  // ~/.claude/settings.json) that exist regardless of which root is being checked, so running it against
  // a hermetic fixture registry would report the machine's own servers as "missing" from a fixture — a
  // finding about nothing. A caller that supplies its own registryPath is by definition testing the
  // dormancy LOGIC on a fixture; drift is about reality, so it is checked only on the real config.
  // WP 2.1: "this doctor file lives in <root>/.claude/forge-bin" — the same test as before, written without building
  // a root from its own folder, so a plugin copy (scripts/) is simply never "own project" (false, as before).
  const isOwnProject = path.resolve(root, '.claude', 'forge-bin') === path.resolve(BIN_DIR);

  // (a3) WAS THE GATE EVER REACHED? (broad Codex audit #1, wired 2026-08-05.) forge-mcp-gate enforces
  // tiers, allow-lists and owner-verified tier-3 writes — but it is a library nobody must call, and
  // `mcp_grant_validated` had ZERO occurrences across every run: the same shape as the run-contract gate,
  // which existed and was tested for months while never once being evaluated. Forge cannot hook Claude
  // Code's tool dispatcher, so this cross-references the PostToolUse tool ledger (which records every
  // `mcp__*` call) against the gate's own decisions. A quiet machine reports "nothing to gate" — never
  // "the gate works".
  try {
    const usage = require('../forge-mcp-usage.cjs');
    const u = usage.check({ root });
    if (u && u.ok === false) {
      violations.push({ type: 'mcp_tool_used_without_gate', detail: u.reason, tools: (u.ungated || []).map((t) => t.tool + ' x' + t.count) });
    }
  } catch { /* sibling tool unavailable -> sub-check not run; never a fabricated all-clear */ }
  try {
    const gate = isOwnProject ? require('../forge-mcp-gate.cjs') : null;
    if (gate && typeof gate.unregisteredServers === 'function') {
      const drift = gate.unregisteredServers({ registryPath, projectRoot: root, homeDir: opts.homeDir });
      for (const u of (drift.unregistered || [])) {
        violations.push({
          type: 'configured_server_not_in_registry', server: u.id, sources: u.sources,
          detail: 'MCP server "' + u.id + '" is configured on this machine (' + u.sources.join(', ') + ') but is absent from mcp-registry.json — it is governed by no tier and no per-Boss grant',
        });
      }
    }
  } catch { /* sibling tool unavailable -> this sub-check is simply not run; never a fabricated all-clear */ }

  // (b)+(c) per-boss grant self-consistency
  const serverById = new Map(registry.servers.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
  for (const [bossId, g] of Object.entries(grants.bosses)) {
    if (!g || typeof g.max_tier !== 'number' || !Array.isArray(g.allow_servers)) {
      violations.push({ type: 'malformed_grant', boss: bossId, detail: 'grant entry missing max_tier/allow_servers' });
      continue;
    }
    for (const serverId of g.allow_servers) {
      const entry = serverById.get(serverId);
      if (!entry) { violations.push({ type: 'unknown_server_in_grant', boss: bossId, server: serverId, detail: 'grant references a server id not present in mcp-registry.json' }); continue; }
      // Type-normalize the registry tier before comparing. A poisoned config (tier as a string like '3',
      // a float, out-of-range, or missing) must NOT slip past these guards — the enforcement gate
      // (forge-mcp-gate.loadRegistry) hard-rejects a non-number tier, and this advisory check is deliberately
      // decoupled from it, so it must replicate that validation itself rather than trust the JSON shape.
      // (Found by the Wave-G break-swarm: `tier:'3'` defeated the strict `=== 3` / `> max_tier` guards.)
      const t = (typeof entry.tier === 'number') ? entry.tier
        : (typeof entry.tier === 'string' && /^\d+$/.test(entry.tier.trim()) ? Number(entry.tier.trim()) : NaN);
      if (!Number.isInteger(t) || t < 0 || t > 3) { violations.push({ type: 'malformed_server_tier', boss: bossId, server: serverId, tier: entry.tier, detail: 'server tier is not an integer 0-3 (poisoned/invalid registry entry) — treated as a violation, never all-clear' }); continue; }
      if (t === 3) { violations.push({ type: 'tier3_default_grant', boss: bossId, server: serverId, detail: 'tier-3 write-primitive must never be a standing/default grant (doctrine #3/#4)' }); continue; }
      if (t > g.max_tier) { violations.push({ type: 'grant_exceeds_max_tier', boss: bossId, server: serverId, tier: t, max_tier: g.max_tier, detail: 'server tier exceeds this boss\'s declared max_tier' }); }
    }
  }

  return { ok: violations.length === 0, checkedServers: registry.servers.length, checkedBosses: Object.keys(grants.bosses).length, violations };
}

module.exports = {
  listSkillFiles, syncCompleteness, MEMORY_PLACEHOLDER_RE, memoryDiscipline, stripJsComments,
  extractKnownEventTypesFromSource, EVENT_TYPE_SHAPE_RE, extractLoggedEventTypes, unregisteredEvent, mcpDormancy,
};
