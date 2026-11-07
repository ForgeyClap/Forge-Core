#!/usr/bin/env node
'use strict';
/**
 * forge-stale-notes.test.cjs — guards against stale facts coming back into the registries and routing docs
 * (WP A5, mission).
 *
 * 1. The claim that the Agent tool has no effort parameter is false since Claude Code 2.1.292 (installed
 *    2.1.316). It must not return in the seven files below. FORGE_HARD_RULES.json is owned by WP A2: its
 *    copy is a KNOWN-PENDING expectation — reported on stdout, never failed — until A2 lands; once it is
 *    clean the test says so, and from then on a return there fails as well.
 * 2. Other facts that went stale before: forge-resume-brief.cjs registered as a hook but listed dormant,
 *    FORGE_VERSION.json not matching forge-canon.json, the profile's hook count not matching settings.json,
 *    and plan status rows that still say "built, uncommitted" after the work was committed.
 * Read-only: this test never writes a file (its portability fixtures are in-memory objects).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const rel = (p) => path.join(ROOT, ...p.split('/'));
const read = (p) => fs.readFileSync(rel(p), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

/** Phrasings of the stale claim seen in this repo ("NO effort param", "**no effort param**",
 *  "has no `effort` parameter", "no effort parameter"). Markdown emphasis and backticks are allowed around
 *  the word effort. A history note must describe the old text without repeating these words. */
const STALE_EFFORT = [
  /\bno\s+[`*_]*effort[`*_]*\s+param(eter)?s?\b/i,
  /\bagent tool (has|had)\s+no\s+[`*_]*effort/i,
];

const FILES = [
  '.claude/config/agents/agent-registry.json',
  '.claude/FORGE_MODEL_ROUTING.json',
  '.claude/config/agents/agent-model-map.json',
  '.claude/docs/model-routing.md',
  '.claude/docs/forge-reference/router-team-routing-and-goat.md',
  '.claude/docs/forge-reference/forge-cmd-routing-cache-bosses.md',
  '.claude/config/orchestration/codex-review.json',
  '.claude/config/orchestration/FORGE_HARD_RULES.json', // fixed by WP A2 on 2026-11-01; guarded from here on
];
const KNOWN_PENDING = []; //nothing pending: A2 landed its FORGE_HARD_RULES.json fix

/** staleHits(text) -> [{line, text}] for every line that matches a stale phrasing. */
function staleHits(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => { if (STALE_EFFORT.some((re) => re.test(l))) out.push({ line: i + 1, text: l.trim().slice(0, 160) }); });
  return out;
}

console.log('forge-stale-notes tests');

t('the stale-phrase patterns catch every phrasing seen before (self-check, so a clean result is not vacuous)', () => {
  for (const s of ['the Agent tool has NO effort param, so', 'The Agent tool has **no effort param**:',
    'It has **no `effort` parameter**: effort', 'The Agent tool has no effort parameter: the run']) {
    assert.ok(staleHits(s).length === 1, 'not caught: ' + s);
  }
  for (const s of ['Pass the route effort with the Agent tool\'s **`effort` param**', 'updated 2026-11-01: Claude Code 2.1.292 added the Agent-tool `effort` param']) {
    assert.strictEqual(staleHits(s).length, 0, 'false positive: ' + s);
  }
});

for (const f of FILES) {
  t('no stale "no effort param" claim in ' + f, () => {
    const hits = staleHits(read(f));
    assert.deepStrictEqual(hits, [], JSON.stringify(hits));
  });
}

for (const f of KNOWN_PENDING) {
  t('KNOWN-PENDING (reported, not failed): ' + f, () => {
    if (!fs.existsSync(rel(f))) { console.log('    note: ' + f + ' not found'); return; }
    const hits = staleHits(read(f));
    if (hits.length) console.log('    KNOWN-PENDING: ' + f + ' still carries the stale claim on line(s) ' + hits.map((h) => h.line).join(', ') + ' — WP A2 owns this file');
    else console.log('    clean: ' + f + ' no longer carries the stale claim — move it from KNOWN_PENDING to FILES');
  });
}

t('Codex default (owner 2026-11-01): the step-10 reference no longer calls codex-review `auto` the default, and says Codex is off by default', () => {
  const doc = read('.claude/docs/forge-reference/forge-cmd-steps-7-14.md');
  const hits = doc.split(/\r?\n/).map((l, i) => ({ line: i + 1, l })).filter((x) => /`auto`\s*\(default\)/.test(x.l)).map((x) => x.line);
  assert.deepStrictEqual(hits, [], 'stale "`auto` (default)" on line(s) ' + hits.join(', '));
  assert.ok(/Codex is OFF by default/.test(doc) && /forge-codexreview-config\.cjs decide/.test(doc));
  const schema = JSON.parse(read('.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json'));
  assert.strictEqual(schema.settings['codex-review'].default, 'off');
});

// ---- Portability: the three checks below guard facts that are hand-kept in the DEVELOPMENT tree (the
// local-only feature registry, the `forge` label in FORGE_VERSION.json, the hook-count line in the profile). A synced
// project has no registry (local-only), its FORGE_VERSION.json is forge-sync's own stamp, and its profile is owner-owned
// — so 26h2 turned this suite red. Each check is a pure function of its inputs: byte-strict in the development tree
// (.claude/config/forge-dev-tree.json), the right portable assertion elsewhere. All read-only.
const DEV_TREE = (() => { try { return JSON.parse(read('.claude/config/forge-dev-tree.json')).dev_tree === true; } catch { return false; } })();
const readJsonOrNull = (p) => (fs.existsSync(rel(p)) ? JSON.parse(read(p)) : null);
const hookScripts = (settings) => {
  let entries = 0; const scripts = new Set(), events = Object.keys(settings.hooks || {});
  for (const e of events) for (const g of settings.hooks[e] || []) for (const h of (g && g.hooks) || []) {
    entries++;
    for (const m of String(h.command || '').match(/[\w.-]+\.cjs/g) || []) scripts.add(m);
  }
  return { entries, events: events.length, scripts };
};
/** registryVerdict(settings, registry|null, devTree, toolExists) -> notes. Dev: the SessionStart resume brief is hooked and
 *  the (required) registry lists no hooked tool dormant. Synced: the registry is local-only, so the portable form of the
 *  same fact holds instead — every Forge tool a hook runs exists in .claude/forge-bin. */
function registryVerdict(settings, registry, devTree, toolExists) {
  const hooked = hookScripts(settings).scripts;
  if (devTree) {
    assert.ok(hooked.has('forge-resume-brief.cjs'), 'expected the SessionStart resume brief in settings.json');
    assert.ok(registry, 'FORGE_FEATURE_REGISTRY.json is missing in the development tree');
    assert.deepStrictEqual((registry.features || []).filter((e) => e.kind === 'tool' && hooked.has(e.id) && e.status === 'dormant').map((e) => e.id), []);
    return [];
  }
  const missing = [...hooked].filter((s) => /^forge-/.test(s) && !toolExists(s));
  assert.deepStrictEqual(missing, [], 'a hook runs a Forge tool that is not in .claude/forge-bin');
  return ['synced project: the feature registry is a development-tree file (local-only); checked instead that the ' + hooked.size + ' hooked tool(s) exist'];
}
/** versionVerdict(ver|null, canon, devTree) -> notes. Dev: the hand-kept `forge` label equals forge-canon version.forge. Synced:
 *  FORGE_VERSION.json is forge-sync's stamp (written after the post-sync doctor, absent before the first sync) with a
 *  forge_version hash and no hand-kept label; a `forge` label that is there must still equal the canon. */
function versionVerdict(ver, canon, devTree) {
  if (devTree) { assert.ok(ver, 'FORGE_VERSION.json is missing in the development tree'); assert.strictEqual(ver.forge, canon.version.forge); return []; }
  if (!ver) return ['synced project: no FORGE_VERSION.json yet (forge-sync writes it after its post-sync doctor)'];
  if (ver.forge !== undefined) assert.strictEqual(ver.forge, canon.version.forge, 'a hand-kept "forge" label in FORGE_VERSION.json is stale');
  assert.ok(typeof ver.forge_version === 'string' && ver.forge_version.length > 0, 'FORGE_VERSION.json is neither a forge-sync stamp (forge_version) nor carries a "forge" label');
  return ver.forge === undefined ? ['synced project: FORGE_VERSION.json is the forge-sync stamp ' + ver.forge_version + ' (no hand-kept "forge" label to go stale)'] : [];
}
/** profileVerdict(profileText|null, settings, devTree) -> notes. Dev: the profile's hook-count line exists and matches.
 *  Synced: the profile is owner-owned and the sync itself changes the hook count, so a line there is reported, not judged. */
function profileVerdict(profileText, settings, devTree) {
  const c = hookScripts(settings), want = [c.entries, c.events, c.scripts.size];
  const m = String(profileText || '').match(/(\d+) hook entries on (\d+) events, running (\d+) scripts/);
  if (devTree) {
    assert.ok(m, 'profile has no "<n> hook entries on <n> events, running <n> scripts" line');
    assert.deepStrictEqual([+m[1], +m[2], +m[3]], want);
    return [];
  }
  assert.ok(c.entries > 0, 'settings.json has no hooks at all');
  if (!m) return ['synced project: the owner-owned profile carries no hook-count line; settings.json has ' + want.join('/') + ' (entries/events/scripts)'];
  const same = [+m[1], +m[2], +m[3]].join('/') === want.join('/');
  return ['synced project: the owner-owned profile says ' + [m[1], m[2], m[3]].join('/') + ', settings.json has ' + want.join('/') + (same ? '' : ' (differs — the owner\'s file, reported only)')];
}
const showNotes = (notes) => { for (const n of notes) console.log('    note: ' + n); };

t('feature registry: every tool run by a hook in settings.json is not listed dormant (synced project: every hooked Forge tool exists)', () => {
  showNotes(registryVerdict(JSON.parse(read('.claude/settings.json')), DEV_TREE ? readJsonOrNull('.claude/config/orchestration/FORGE_FEATURE_REGISTRY.json') : null, DEV_TREE,
    (s) => fs.existsSync(rel('.claude/forge-bin/' + s))));
});

t('FORGE_VERSION.json "forge" equals forge-canon.json version.forge (synced project: a forge-sync stamp with no stale label)', () => {
  showNotes(versionVerdict(readJsonOrNull('.claude/FORGE_VERSION.json'), JSON.parse(read('.claude/config/orchestration/forge-canon.json')), DEV_TREE));
});

t('FORGE_PROJECT_PROFILE.md hook count matches .claude/settings.json (entries, events, scripts) (synced project: owner-owned, reported)', () => {
  showNotes(profileVerdict(fs.existsSync(rel('.claude/FORGE_PROJECT_PROFILE.md')) ? read('.claude/FORGE_PROJECT_PROFILE.md') : null, JSON.parse(read('.claude/settings.json')), DEV_TREE));
});

// PORTABLE fixtures (in memory, nothing written): the 26h2 shape — no registry, a forge-sync stamp, a profile without the
// line — passes the synced judgement and fails the development-tree one; real stale facts still fail in both.
const FX_SETTINGS = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-resume-brief.cjs"' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-stop-obligations.cjs"' }, { type: 'command', command: 'node my-own-stop.js' }] }] } };
const FX_CANON = { version: { forge: 'v11' } }, FX_STAMP = { forge_version: '04d21f8b660e', synced_at: '2026-10-11T12:38:28.401Z' };
const allTools = () => true;
t('PORTABLE: the 26h2 shape (no registry, a forge-sync stamp, a profile without the line) passes the synced judgement and fails the dev one', () => {
  assert.ok(registryVerdict(FX_SETTINGS, null, false, allTools).length === 1);
  assert.ok(/forge-sync stamp 04d21f8b660e/.test(versionVerdict(FX_STAMP, FX_CANON, false)[0]));
  assert.ok(/carries no hook-count line; settings.json has 3\/2\/2/.test(profileVerdict('# profile\n', FX_SETTINGS, false)[0]));
  assert.throws(() => registryVerdict(FX_SETTINGS, null, true, allTools), /registry is missing|FEATURE_REGISTRY/);
  assert.throws(() => versionVerdict(FX_STAMP, FX_CANON, true));
  assert.throws(() => profileVerdict('# profile\n', FX_SETTINGS, true), /no "<n> hook entries/);
});
t('PORTABLE: real stale facts still fail in a synced project (a hooked tool missing, a stale "forge" label, a non-stamp version file)', () => {
  assert.throws(() => registryVerdict(FX_SETTINGS, null, false, (s) => s !== 'forge-stop-obligations.cjs'), /not in \.claude\/forge-bin/);
  assert.throws(() => versionVerdict(Object.assign({ forge: 'v10' }, FX_STAMP), FX_CANON, false), /stale/);
  assert.throws(() => versionVerdict({ synced_at: 'x' }, FX_CANON, false), /neither a forge-sync stamp/);
  assert.deepStrictEqual(versionVerdict(null, FX_CANON, false).length, 1);
});
t('PORTABLE: the development-tree judgement still catches a dormant hooked tool, a stale label and a wrong hook count', () => {
  assert.throws(() => registryVerdict(FX_SETTINGS, { features: [{ kind: 'tool', id: 'forge-stop-obligations.cjs', status: 'dormant' }] }, true, allTools));
  assert.throws(() => versionVerdict({ forge: 'v10' }, FX_CANON, true));
  assert.throws(() => profileVerdict('9 hook entries on 2 events, running 2 scripts', FX_SETTINGS, true));
  assert.deepStrictEqual(profileVerdict('3 hook entries on 2 events, running 2 scripts', FX_SETTINGS, true), []);
});

// (Lead) The former check of the modernization plan's status table was removed from this SHIPPED test:
// that plan is a development-tree document synced projects never receive (shipcheck ref_not_shipped). WP A5 fixed the
// table itself; the dev tree keeps the plan under docs/ and reviews it by hand.

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
