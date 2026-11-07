#!/usr/bin/env node
'use strict';
/**
 * forge-mcp-skill.test.cjs — presence/lint tests for the forge-mcp-clients doctrine skill (2026-07-19,
 * WAVE G / G2). Hermetic: reads real files under this repo (no fixtures needed — the skill/example live
 * at fixed, checked-in paths) and asserts frontmatter validity, required sections, doctrine keywords, and
 * that the DORMANT `.mcp.json.example` exists while a LIVE `.mcp.json` does not. Convention: prints
 * "<N> passed, <M> failed"; exit non-zero on any failure (mirrors forge-mcp.test.cjs's assert-based style).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'forge-mcp-clients', 'SKILL.md');
const EXAMPLE_PATH = path.join(REPO_ROOT, '.claude', 'config', 'mcp', '.mcp.json.example');
const LIVE_MCP_PATH = path.join(REPO_ROOT, '.mcp.json');

const REQUIRED_SECTIONS = [
  '## Hard rules',
  '## What "MCP-as-client" means here',
  '## The 4 capability tiers',
  '## Per-Boss least-privilege model',
  '## "mcp-write is a write-primitive" → hard-gate',
  '## Defer-loading',
  '## Opt-in flow',
  '## Requesting + validating a grant',
  '## Honest native fallback',
];

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

/** parseFrontmatter — minimal YAML-ish frontmatter reader for `name:` and `description:` (single-line
 *  scalar values), mirroring the simple frontmatter shape every SKILL.md in this project uses. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const body = m[1];
  const nameM = /^name:\s*(.+)$/m.exec(body);
  const descM = /^description:\s*(.+)$/m.exec(body);
  return { raw: body, name: nameM ? nameM[1].trim() : null, description: descM ? descM[1].trim() : null };
}

console.log('forge-mcp-clients skill presence/lint tests');

t('SKILL.md exists at the expected path', () => {
  assert.ok(fs.existsSync(SKILL_PATH), 'missing ' + SKILL_PATH);
});

const skillText = fs.existsSync(SKILL_PATH) ? fs.readFileSync(SKILL_PATH, 'utf8') : '';
const fm = parseFrontmatter(skillText);

t('SKILL.md has valid frontmatter (--- delimited block)', () => {
  assert.ok(fm, 'no --- ... --- frontmatter block found');
});

t('frontmatter name is exactly "forge-mcp-clients"', () => {
  assert.strictEqual(fm && fm.name, 'forge-mcp-clients');
});

t('frontmatter description is present and non-trivial', () => {
  assert.ok(fm && fm.description && fm.description.length > 40, 'description missing or too short');
});

t('frontmatter description mentions MCP and opt-in (discoverability keywords)', () => {
  const d = (fm && fm.description) || '';
  assert.ok(/MCP/i.test(d), 'description does not mention MCP');
  assert.ok(/opt-in/i.test(d), 'description does not mention opt-in');
});

for (const section of REQUIRED_SECTIONS) {
  t('SKILL.md contains required section: ' + section, () => {
    assert.ok(skillText.includes(section), 'missing section heading: ' + section);
  });
}

t('SKILL.md mentions all 4 capability tiers (0/1/2/3) explicitly', () => {
  assert.ok(/\|\s*0\s*\|/.test(skillText) || /\btier\s*0\b/i.test(skillText), 'tier 0 not found');
  assert.ok(/\|\s*1\s*\|/.test(skillText) || /\btier\s*1\b/i.test(skillText), 'tier 1 not found');
  assert.ok(/\|\s*2\s*\|/.test(skillText) || /\btier\s*2\b/i.test(skillText), 'tier 2 not found');
  assert.ok(/\|\s*3\s*\|/.test(skillText) || /\btier\s*3\b/i.test(skillText), 'tier 3 not found');
});

t('SKILL.md states the write-primitive → hard-gate rule and names forge-actiongate.cjs', () => {
  assert.ok(/write-primitive/i.test(skillText), 'does not mention write-primitive');
  assert.ok(/forge-actiongate\.cjs/.test(skillText), 'does not name forge-actiongate.cjs');
});

t('SKILL.md states the per-Boss least-privilege model and names mcp-grants.json', () => {
  assert.ok(/least-privilege/i.test(skillText), 'does not mention least-privilege');
  assert.ok(/mcp-grants\.json/.test(skillText), 'does not name mcp-grants.json');
});

t('SKILL.md states defer-loading via ToolSearch', () => {
  assert.ok(/ToolSearch/.test(skillText), 'does not mention ToolSearch');
});

t('SKILL.md states nothing is active until the owner opts in (dormant-by-default doctrine)', () => {
  assert.ok(/dormant/i.test(skillText), 'does not mention "dormant"');
  assert.ok(/opt(s|ed)?[\s-]?in/i.test(skillText), 'does not mention opt-in');
});

t('SKILL.md never claims a server as "active" in this project (doctrine must stay honest/dormant)', () => {
  assert.ok(!/\bstatus['"]?\s*:\s*['"]active['"]/.test(skillText), 'SKILL.md appears to declare a server active');
});

// --- .mcp.json.example: the DORMANT worked example must exist, and no LIVE .mcp.json may exist ---

t('.mcp.json.example exists at .claude/config/mcp/', () => {
  assert.ok(fs.existsSync(EXAMPLE_PATH), 'missing ' + EXAMPLE_PATH);
});

t('.mcp.json.example is valid JSON', () => {
  const raw = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

t('.mcp.json.example is explicitly labeled EXAMPLE ONLY', () => {
  const raw = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  assert.ok(/EXAMPLE ONLY/.test(raw), 'missing "EXAMPLE ONLY" marker');
});

t('.mcp.json.example demonstrates an explicit opted_in:true marker', () => {
  const data = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  const servers = data.mcpServers || {};
  const anyOptedIn = Object.values(servers).some((s) => s && s._forge_opt_in && s._forge_opt_in.opted_in === true);
  assert.ok(anyOptedIn, 'no server entry has _forge_opt_in.opted_in === true');
});

t('.mcp.json.example scopes its opted-in example to a least-privilege tier + allow-list', () => {
  const data = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  const ctx7 = data.mcpServers && data.mcpServers.context7;
  assert.ok(ctx7 && ctx7._forge_opt_in, 'context7 example entry missing');
  assert.strictEqual(typeof ctx7._forge_opt_in.tier, 'number');
  assert.ok(Array.isArray(ctx7._forge_opt_in.allow_bosses) && ctx7._forge_opt_in.allow_bosses.length > 0);
});

t('NO live .mcp.json exists at the project root (this wave must stay dormant)', () => {
  assert.ok(!fs.existsSync(LIVE_MCP_PATH), 'a LIVE .mcp.json exists at project root — this wave must not activate anything');
});

// --- supply-chain pin-check doctrine + the server picker, kept in step with the registry ---
const PICKER_REL = 'references/server-picker.md';
const PICKER_PATH = path.join(path.dirname(SKILL_PATH), 'references', 'server-picker.md');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'config', 'orchestration', 'mcp-registry.json'), 'utf8'));
const GRANTS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'config', 'orchestration', 'mcp-grants.json'), 'utf8'));

t('SKILL.md has the supply-chain pin-check section and names forge-mcp-pin.cjs', () => {
  assert.ok(skillText.includes('## Supply-chain pin-check'), 'missing "## Supply-chain pin-check" section');
  assert.ok(/forge-mcp-pin\.cjs/.test(skillText), 'does not name forge-mcp-pin.cjs');
});

t('SKILL.md states that HIGH and UNVERIFIED refuse a grant, before the tier-3 branch', () => {
  assert.ok(/\*\*HIGH\*\* or \*\*UNVERIFIED\*\*/.test(skillText), 'does not state that HIGH or UNVERIFIED refuse a grant');
  assert.ok(/before the tier-3 branch/i.test(skillText), 'does not state the pin gate runs before the tier-3 branch');
});

t('SKILL.md says naming a server is not enabling it, and links the picker one level deep with forward slashes', () => {
  assert.ok(/Naming is\s+not enabling/i.test(skillText), 'does not say naming is not enabling');
  assert.ok(skillText.includes(PICKER_REL), 'SKILL.md does not link ' + PICKER_REL);
  assert.ok(fs.existsSync(PICKER_PATH), 'missing ' + PICKER_PATH);
});

const pickerText = fs.existsSync(PICKER_PATH) ? fs.readFileSync(PICKER_PATH, 'utf8') : '';
/** pickerRows() -> [{id, tier, pin, askers}] from every "| `id` | tier | pin | use when | who may ask |" row. */
function pickerRows() {
  const rows = [];
  for (const line of pickerText.split(/\r?\n/)) {
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(\d)\s*\|\s*([^|]+?)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (m) rows.push({ id: m[1], tier: Number(m[2]), pin: m[3], askers: m[4] });
  }
  return rows;
}

t('picker: every registry server appears exactly once, with the registry tier and pin', () => {
  const rows = pickerRows();
  for (const s of REGISTRY.servers) {
    const hits = rows.filter((r) => r.id === s.id);
    assert.strictEqual(hits.length, 1, 'server "' + s.id + '" appears ' + hits.length + ' time(s) in the picker');
    assert.strictEqual(hits[0].tier, s.tier, s.id + ': picker tier ' + hits[0].tier + ' != registry tier ' + s.tier);
    assert.strictEqual(hits[0].pin, s.pin, s.id + ': picker pin ' + hits[0].pin + ' != registry pin ' + s.pin);
  }
  assert.strictEqual(rows.length, REGISTRY.servers.length, 'picker lists a server the registry does not have');
});

t('picker: "who may ask" matches the mcp-grants.json allow-lists exactly', () => {
  for (const r of pickerRows()) {
    const want = Object.entries(GRANTS.bosses).filter(([, g]) => g.allow_servers.includes(r.id)).map(([b]) => b).sort();
    const got = r.askers === 'nobody by default' ? [] : r.askers.split(',').map((x) => x.trim()).sort();
    assert.deepStrictEqual(got, want, r.id + ': picker says ' + JSON.stringify(got) + ', grants say ' + JSON.stringify(want));
  }
});

t('picker: states that naming never enables and that every result is untrusted', () => {
  assert.ok(/Naming a server never enables it/.test(pickerText), 'picker does not say naming never enables');
  assert.ok(/untrusted/i.test(pickerText), 'picker does not mark results untrusted');
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
