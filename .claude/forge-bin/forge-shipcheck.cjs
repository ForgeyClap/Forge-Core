#!/usr/bin/env node
'use strict';
/**
 * forge-shipcheck.cjs — the ONE shipping truth, checked (;
 *).
 *
 * Reads .claude/config/orchestration/FORGE_SHIP_MANIFEST.json (schema forge-ship-manifest/v1): an ordered list
 * of glob rules, LAST MATCH WINS (like .gitignore), that gives every source path exactly one class —
 *   ship-sync · seed-only · ship-release-only · installer-only · global-install · per-project · local-only · retired
 * — plus the channels it travels on (sync, release, plugin, template) and a reason. Then it fails on:
 *   unclassified               a source path matches no rule
 *   ship_missing_in_source     a literal ship-* entry (or a forge-sync-delivered ship-sync path) is not in source
 *   retired_without_replacement / retired_present   a retired entry has no replacement / still exists in source
 *   sync_not_delivered         the manifest says ship-sync, forge-sync's listSystemFiles() does not deliver it
 *   sync_delivers_non_ship_sync  forge-sync delivers a path the manifest does not classify ship-sync (drift)
 *   seed_not_delivered         a seed-only path forge-sync does not seed (no seed mechanism yet:)
 *   ref_not_shipped            a file that lands in projects references a path a synced project never gets — or
 *                              (test-83 parity) a non-test one names a .claude/config/ path that does not exist
 *                              although a shipped glob claims it (per-project runtime state must be classified so).
 *                              A reference to a RETIRED path is advisory (`refs.retired_refs`), an unclassified
 *                              nonexistent one is advisory (`refs.unresolved`); the manifest itself is not scanned.
 *   release_orphan / release_unexpected / release_missing / plugin_missing / plugin_unlisted  (--release-tree)
 *   release_placeholder_missing / release_placeholder_unreadable / release_placeholder_secret (never gappable)
 *                              a `release_placeholder` entry's placeholder must be tracked in the release tree and,
 *                              when the tree folder is readable, hold no forge-store SECRET_PATTERNS shape;
 *                              protected_path_shipped also runs over the release enumeration (channel 'release')
 *   manifest_invalid · enumeration_failed · sync_delivery_unavailable  (the check could not be trusted)
 * A violation that matches a `known_gaps` entry (kind + path glob, with an owner WP) is a WARNING; every other
 * one is a FAILURE. manifest_invalid / retired_without_replacement / enumeration_failed are never gappable.
 *
 * Source = `git ls-files -co --exclude-standard` (tracked + untracked-not-ignored; an ignored file is local
 * by definition) — or a filesystem walk ONLY when git confirms the folder is not a repository.
 * The reference extractor lives in forge-shipcheck-refs.cjs (see its header for the exact rules and skips).
 *
 * CLI: node forge-shipcheck.cjs [--root <dir>] [--manifest <file>] [--release-tree <dir>] [--no-known-gaps]
 *                               [--json] [--verbose]
 *   exit 0 = no failures (warnings allowed) · 3 = failures · 1 = could not run (bad args)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const refs = require('./forge-shipcheck-refs.cjs');
// SOFT sibling dependencies (same posture as forge-doctor.cjs): a missing module degrades one check honestly.
let syncTool = null;
try { syncTool = require('./forge-sync.cjs'); } catch { syncTool = null; }
let releaseCheck = null;
try { releaseCheck = require('./forge-release-check.cjs'); } catch { releaseCheck = null; }
// the secret SHAPES a release placeholder must never contain are forge-store.cjs SECRET_PATTERNS (the
// one served-redaction list) — never a second copy here. Missing module = placeholder content cannot be checked,
// which is reported (release_placeholder_unreadable), never assumed clean.
let storeTool = null;
try { storeTool = require('./forge-store.cjs'); } catch { storeTool = null; }

const SCHEMA = 'forge-ship-manifest/v1';
const MANIFEST_REL = '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json';
const CHANNELS = ['sync', 'release', 'plugin', 'template'];
/** must/mustNot = channel rules; available = a synced project has this path (so a shipped file may point at
 *  it); landsInProject = its CONTENT is scanned for references (it is what a synced project actually runs). */
const CLASS_SPEC = {
  'ship-sync': { must: ['sync'], mustNot: [], available: true, landsInProject: true },
  'seed-only': { must: ['sync'], mustNot: [], available: true, landsInProject: true },
  'ship-release-only': { must: ['release'], mustNot: ['sync'], available: false, landsInProject: false },
  'installer-only': { must: ['release'], mustNot: ['sync', 'plugin'], available: false, landsInProject: false },
  'global-install': { must: ['release'], mustNot: ['sync'], available: false, landsInProject: false },
  'per-project': { empty: true, available: true, landsInProject: false },
  'local-only': { empty: true, available: false, landsInProject: false },
  'retired': { empty: true, available: false, landsInProject: false },
};
const SHIPPED_CLASSES = new Set(['ship-sync', 'seed-only', 'ship-release-only', 'installer-only', 'global-install']);
const NEVER_GAPPABLE = new Set(['manifest_invalid', 'retired_without_replacement', 'enumeration_failed', 'protected_path_shipped', 'release_placeholder_secret']);
const RELEASE_KINDS = new Set(['release_orphan', 'release_unexpected', 'release_missing', 'plugin_missing', 'plugin_unlisted', 'release_enumeration_failed', 'release_placeholder_missing', 'release_placeholder_unreadable']);
const GAPPABLE_KINDS = new Set(['unclassified', 'ship_missing_in_source', 'retired_present', 'sync_not_delivered',
  'sync_delivers_non_ship_sync', 'seed_not_delivered', 'ref_not_shipped', 'sync_delivery_unavailable', 'broad_override', ...RELEASE_KINDS]);
// a rule this broad would classify everything and make `unclassified` impossible to trip — refused outright
const CATCH_ALL = new Set(['**', '*', '**/*', '.claude/**', '.claude/*', '.claude/**/*']);
/** three guards that do not depend on what forge-sync happens to deliver:
 *  1. isCatchAllGlob(): the catch-all test used to compare literal strings, so `**\/**`, `*\/**`, `.claude/**\/**` and
 *     every brace alternative of that shape slipped through. Now evaluated on the EXPANDED glob: after dropping a
 *     leading `.claude` segment, a pattern (or any {a,b} alternative) whose every segment is wildcard-only is a
 *     catch-all.
 *  2. BROAD_RULE_MAX_SHARE: a rule that by itself matches more than this share of the source tree is refused as
 *     manifest_invalid — except a `per-project` rule, which legitimately owns the bulk of a project (runs, memory:
 *     measured 79.9% in this tree on 2026-10-10; the broadest non-per-project rule was 10.1%).
 *  3. PROTECTED_PATHS: paths that must never travel on any channel (secrets, env files, credentials, agent memory,
 *     run data, backups). Every REAL source path matching one and classified in a shipped class, and every synthetic
 *     probe path (so an empty tree cannot hide a broad shipped glob), is `protected_path_shipped` — never gappable.
 *  Plus `broad_override` (gappable, needs an owner WP): a non-literal local-only/per-project/retired rule that
 *  demotes more than BROAD_OVERRIDE_MAX_DEMOTED paths an EARLIER shipped rule claimed — the shape that hid an
 *  undelivered helper behind a `local-only` catch-all. Measured maximum in this tree: 1 path per demoting rule. */
const BROAD_RULE_MAX_SHARE = 0.5;
const BROAD_OVERRIDE_MAX_DEMOTED = 5;
const PROTECTED_PATHS = [
  { glob: '.env', probe: '.env' }, { glob: '.env.*', probe: '.env.local', except: ['.env.example'] },
  { glob: '**/.env', probe: 'apps/web/.env' }, { glob: '**/.env.*', probe: 'apps/web/.env.production', except: ['**/.env.example'] },
  { glob: '**/*.pem', probe: 'secrets/server.pem' }, { glob: '**/*.key', probe: 'certs/private.key' },
  { glob: '**/id_rsa*', probe: '.ssh/id_rsa' }, { glob: '**/credentials*.json', probe: '.claude/.credentials.json' },
  { glob: 'secrets/**', probe: 'secrets/api-token.txt' }, { glob: '**/secrets/**', probe: 'ops/secrets/token.txt' },
  { glob: '.claude/agent-memory/**', probe: '.claude/agent-memory/head-chef/MEMORY.md' },
  { glob: '.claude/forge-runs/**', probe: '.claude/forge-runs/forge-2026-01-01-probe/events.jsonl' },
  { glob: '.claude/forge-vault/**', probe: '.claude/forge-vault/entries.jsonl' },
  { glob: '.claude/forge-backups/**', probe: '.claude/forge-backups/2026-01-01/x.cjs' },
  { glob: '.claude/forge-backups-central/**', probe: '.claude/forge-backups-central/x/y.cjs' },
  // WP 2.1: the opt-in .forge/ state root holds the same runs, memory, scribe store and backups as the folders above.
  // Root level only: a nested .forge/ inside a shipped tree (plugins/**) is release-exclusions dist_forbidden's job.
  { glob: '.forge/**', probe: '.forge/runs/forge-2026-01-01-probe/events.jsonl' },
  { glob: '.claude/config/forge-owner-grant*', probe: '.claude/config/forge-owner-grant.txt' },
  { glob: '.claude/config/forge-usage-guard-override-grant.json', probe: '.claude/config/forge-usage-guard-override-grant.json' },
  { glob: '.claude/config/**/*.user.json', probe: '.claude/config/orchestration/codex-review.user.json' },
];
const WILDCARD_ONLY_SEGMENT_RE = /^[*?]+$/;
/** expandBraces(g) -> every alternative of a (one-level) {a,b} glob; a glob without braces is its own alternative. */
function expandBraces(g) {
  const m = /^([^{]*)\{([^{}]*)\}(.*)$/.exec(g);
  if (!m) return [g];
  const tails = expandBraces(m[3]);
  const out = [];
  for (const alt of m[2].split(',')) for (const tail of tails) out.push(m[1] + alt + tail);
  return out;
}
/** isCatchAllGlob(g) — true when the pattern (or any brace alternative) has only wildcard segments once a leading
 *  `.claude` is dropped: `**`, `*`, `**\/*`, `**\/**`, `*\/**`, `.claude/**`, `.claude/**\/**`, `.claude/*\/**`, … */
function isCatchAllGlob(g) {
  if (typeof g !== 'string' || !g.trim()) return false;
  if (CATCH_ALL.has(g)) return true;
  return expandBraces(g).some((alt) => {
    const segs = alt.split('/').filter((s) => s !== '');
    if (!segs.length) return true;
    const rest = segs[0] === '.claude' ? segs.slice(1) : segs;
    return rest.length > 0 && rest.every((s) => WILDCARD_ONLY_SEGMENT_RE.test(s));
  });
}
const REF_SCAN_EXTS = new Set(['.md', '.cjs', '.js', '.mjs', '.json']);
const REF_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const WALK_SKIP = new Set(['.git', 'node_modules']);

const toPosix = (p) => String(p).split('\\').join('/').replace(/^\.\/+/, '');
const escRe = (s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&');

/** globFragment / globToRegExp — `**` any depth (as `**\/` also zero folders), `*` and `?` never cross `/`,
 *  `{a,b}` alternatives (each alternative may itself use * ? **). `*` also matches dot-files. */
function globFragment(g) {
  let re = '';
  for (let i = 0; i < g.length;) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if ((i === 0 || g[i - 1] === '/') && g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; continue; }
      re += '.*'; i += 2; continue;
    }
    if (c === '*') { re += '[^/]*'; i++; continue; }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0 || g.slice(i + 1, end).includes('{')) throw new Error('unbalanced or nested {} in glob ' + JSON.stringify(g));
      re += '(?:' + g.slice(i + 1, end).split(',').map(globFragment).join('|') + ')'; i = end + 1; continue;
    }
    re += escRe(c); i++;
  }
  return re;
}
function globToRegExp(g) { return new RegExp('^' + globFragment(g) + '$'); }
/** protectedSpecOf(p) -> the PROTECTED_PATHS matcher for p (honouring `except`), or null. Compiled once, shared by
 *  the source pass and the release enumeration. */
let protectedMatchersCache = null;
function protectedMatchers() {
  if (!protectedMatchersCache) protectedMatchersCache = PROTECTED_PATHS.map((p) => ({ re: globToRegExp(p.glob), exceptRes: (p.except || []).map(globToRegExp), spec: p }));
  return protectedMatchersCache;
}
function protectedSpecOf(p) { return protectedMatchers().find((x) => x.re.test(p) && !x.exceptRes.some((e) => e.test(p))) || null; }
/** secretShapeIn(text) -> 'SECRET_PATTERNS[i]' for the first forge-store secret shape found, null when none, or
 *  undefined when forge-store.cjs is unavailable. Never returns the match itself. */
function secretShapeIn(text) {
  const pats = storeTool && Array.isArray(storeTool.SECRET_PATTERNS) ? storeTool.SECRET_PATTERNS : null;
  if (!pats) return undefined;
  for (let i = 0; i < pats.length; i++) {
    const re = new RegExp(pats[i].source, pats[i].flags.replace('g', '')); // a fresh, non-global copy: no lastIndex state
    if (re.test(String(text))) return 'SECRET_PATTERNS[' + i + ']';
  }
  return null;
}
/** readReleaseFile(relRoot, f) -> {text} | {error} — a tracked release-tree file read for a content check; a link,
 *  folder, oversized or unreadable entry is an error (never content-checked through a link). */
function readReleaseFile(relRoot, f) {
  const abs = path.join(relRoot, ...String(f).split('/'));
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return { error: 'tracked in the release tree but not readable there (' + (e.code || e.message) + ')' }; }
  if (!st.isFile()) return { error: 'not a regular file in the release tree (a link or folder cannot be content-checked)' };
  if (st.size > REF_SCAN_MAX_BYTES) return { error: 'larger than ' + REF_SCAN_MAX_BYTES + ' bytes — too large to content-check' };
  try { return { text: fs.readFileSync(abs, 'utf8') }; } catch (e) { return { error: 'unreadable (' + (e.code || e.message) + ')' }; }
}
const isLiteral = (g) => !/[*?{]/.test(g);
/** literalPaths(g) -> the exact paths a wildcard-free pattern names (one level of {a,b} expanded), or null
 *  when the pattern has a wildcard — so `.claude/FORGE_{A,B}.json` is checked file by file for existence. */
function literalPaths(g) {
  if (/[*?]/.test(g)) return null;
  const m = /^([^{]*)\{([^{}]*)\}(.*)$/.exec(g);
  if (!m) return g.includes('{') ? null : [g];
  const rest = literalPaths(m[3]);
  if (!rest) return null;
  const out = [];
  for (const alt of m[2].split(',')) for (const tail of rest) out.push(m[1] + alt + tail);
  return out;
}

/** loadManifest(file) -> {manifest, rules, knownGaps, refIgnore, errors[]} — never throws; every problem is an
 *  entry in errors[] ({kind, path, detail}) so a broken manifest is reported, never half-trusted. */
function loadManifest(file) {
  const errors = [];
  const bad = (kind, p, detail) => errors.push({ kind, path: p, detail });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { bad('manifest_invalid', toPosix(file), 'unreadable or not JSON: ' + e.message); return { manifest: null, rules: [], knownGaps: [], refIgnore: [], errors }; }
  if (!manifest || manifest.schema !== SCHEMA) bad('manifest_invalid', 'schema', 'schema must be ' + JSON.stringify(SCHEMA));
  if (!Array.isArray(manifest && manifest.rules) || !manifest.rules.length) { bad('manifest_invalid', 'rules', 'rules must be a non-empty array'); return { manifest, rules: [], knownGaps: [], refIgnore: [], errors }; }
  const rules = []; const seen = new Set();
  manifest.rules.forEach((r, index) => {
    const at = 'rules[' + index + ']' + (r && r.pattern ? ' ' + r.pattern : '');
    if (!r || typeof r.pattern !== 'string' || !r.pattern.trim()) return bad('manifest_invalid', at, 'pattern must be a non-empty string');
    if (isCatchAllGlob(r.pattern)) return bad('manifest_invalid', at, 'catch-all pattern refused (every segment is a wildcard once a leading .claude is dropped — it would hide every unclassified path)');
    if (seen.has(r.pattern)) bad('manifest_invalid', at, 'duplicate pattern');
    seen.add(r.pattern);
    let re; try { re = globToRegExp(r.pattern); } catch (e) { return bad('manifest_invalid', at, e.message); }
    const spec = CLASS_SPEC[r.class];
    if (!spec) return bad('manifest_invalid', at, 'unknown class ' + JSON.stringify(r.class));
    if (typeof r.reason !== 'string' || !r.reason.trim()) bad('manifest_invalid', at, 'reason is required');
    const ch = r.channels;
    if (!Array.isArray(ch) || ch.some((c) => !CHANNELS.includes(c)) || new Set(ch).size !== ch.length) bad('manifest_invalid', at, 'channels must be a list of distinct values from ' + CHANNELS.join('/'));
    else if (spec.empty && ch.length) bad('manifest_invalid', at, r.class + ' must have channels []');
    else if (!spec.empty && (spec.must.some((c) => !ch.includes(c)) || spec.mustNot.some((c) => ch.includes(c)))) bad('manifest_invalid', at, r.class + ' channels must include ' + spec.must.join('+') + (spec.mustNot.length ? ' and exclude ' + spec.mustNot.join('+') : ''));
    if (r.class === 'retired' && (typeof r.replacement !== 'string' || !r.replacement.trim())) bad('retired_without_replacement', r.pattern, 'a retired entry needs a replacement (or an explicit "none: <why>")');
    if ((r.class === 'ship-sync' || r.class === 'seed-only') && Array.isArray(ch) && !ch.includes('release') && !(typeof r.release_excluded === 'string' && r.release_excluded.trim())) bad('manifest_invalid', at, 'a ' + r.class + ' entry without the release channel needs a release_excluded reason');
    if (r.release_placeholder && r.class !== 'per-project') bad('manifest_invalid', at, 'release_placeholder is only meaningful on per-project entries');
    if (r.delivery !== undefined && !(r.delivery === 'copy' || (r.delivery === 'settings-merge' && r.class === 'ship-release-only'))) bad('manifest_invalid', at, 'delivery must be "copy", or "settings-merge" on a ship-release-only entry');
    // origin "release-tree": the entry lives only in the public release tree (installers, plugin, global-install),
    // so it is exempt from the "missing from source" check; it never applies to a sync-channel entry.
    if (r.origin !== undefined && !(r.origin === 'source' || (r.origin === 'release-tree' && Array.isArray(ch) && !ch.includes('sync')))) bad('manifest_invalid', at, 'origin must be "source", or "release-tree" on an entry without the sync channel');
    rules.push(Object.assign({}, r, { re, index, literal: isLiteral(r.pattern), literalPaths: literalPaths(r.pattern) }));
  });
  const knownGaps = []; const gapIds = new Set();
  (Array.isArray(manifest.known_gaps) ? manifest.known_gaps : []).forEach((g, i) => {
    const at = 'known_gaps[' + i + ']' + (g && g.id ? ' ' + g.id : '');
    if (!g || typeof g.id !== 'string' || !g.id.trim() || gapIds.has(g.id)) return bad('manifest_invalid', at, 'id must be a unique non-empty string');
    gapIds.add(g.id);
    if (!Array.isArray(g.kinds) || !g.kinds.length || g.kinds.some((k) => !GAPPABLE_KINDS.has(k))) return bad('manifest_invalid', at, 'kinds must be a non-empty list of gappable kinds (' + [...GAPPABLE_KINDS].join(', ') + ')');
    if (!Array.isArray(g.paths) || !g.paths.length) return bad('manifest_invalid', at, 'paths must be a non-empty list of globs');
    if (typeof g.owner_wp !== 'string' || !g.owner_wp.trim() || typeof g.reason !== 'string' || !g.reason.trim()) return bad('manifest_invalid', at, 'owner_wp and reason are required');
    try { knownGaps.push(Object.assign({}, g, { res: g.paths.map(globToRegExp) })); } catch (e) { bad('manifest_invalid', at, e.message); }
  });
  const refIgnore = [];
  (Array.isArray(manifest.ref_ignore) ? manifest.ref_ignore : []).forEach((x, i) => {
    const at = 'ref_ignore[' + i + ']';
    if (!x || typeof x.from !== 'string' || typeof x.ref !== 'string' || typeof x.reason !== 'string' || !x.reason.trim()) return bad('manifest_invalid', at, 'from, ref and reason are required');
    try { refIgnore.push(Object.assign({}, x, { fromRe: globToRegExp(x.from), refRe: globToRegExp(x.ref) })); } catch (e) { bad('manifest_invalid', at, e.message); }
  });
  return { manifest, rules, knownGaps, refIgnore, errors };
}

/** classify(rules, p) -> the LAST rule whose glob matches p, or null. */
function classify(rules, p) {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].re.test(p)) return rules[i];
  return null;
}
const isAvailable = (rule) => !!rule && (CLASS_SPEC[rule.class].available || rule.delivery === 'settings-merge');
const landsInProject = (rule) => !!rule && (CLASS_SPEC[rule.class].landsInProject || rule.delivery === 'settings-merge');

function walk(base, rel, out) {
  let entries;
  try { entries = fs.readdirSync(rel ? path.join(base, rel) : base, { withFileTypes: true }); }
  catch (e) { return 'cannot read directory "' + (rel || '.') + '": ' + e.message; }
  for (const e of entries) {
    if (WALK_SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { const err = walk(base, r, out); if (err) return err; } else if (e.isFile()) out.push(r);
  }
  return null;
}
/** enumerateSource(root, opts) -> {files, method, error}. opts.files (test injection) wins; otherwise git
 *  (tracked + untracked-not-ignored) when root is a work tree, a walk only when git CONFIRMS it is not one. */
function enumerateSource(root, opts) {
  const o = opts || {};
  if (Array.isArray(o.files)) return { files: o.files.map(toPosix), method: 'injected', error: null };
  const env = Object.assign({}, process.env, { LC_ALL: 'C', LANGUAGE: 'C' });
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', env });
  if (!probe.error && probe.status === 0 && String(probe.stdout).trim() === 'true') {
    const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error || r.status !== 0) return { files: null, method: 'git', error: 'git ls-files failed: ' + (r.error ? r.error.message : 'exit ' + r.status) };
    // `-c` still lists a tracked file deleted from disk but not yet committed: it is no longer source, so drop it
    // (a pinned file deleted this way then surfaces as ship_missing_in_source, which is the truth).
    const files = [...new Set(r.stdout.split('\0').filter(Boolean).map(toPosix))].filter((f) => fs.existsSync(path.join(root, f)));
    return files.length ? { files, method: 'git', error: null } : { files: null, method: 'git', error: '0 files enumerated (is the root ignored by an enclosing repository?)' };
  }
  const notRepo = !probe.error && /not a git repository \(or any of the parent directories\)/i.test(String(probe.stderr));
  if (!notRepo) return { files: null, method: null, error: 'git could not confirm what this folder is: ' + (probe.error ? probe.error.message : String(probe.stderr || '').trim() || 'exit ' + probe.status) };
  const files = []; const err = walk(root, '', files);
  return err ? { files: null, method: 'walk', error: err } : { files, method: 'walk', error: null };
}

/** runShipcheck(root, opts) -> report. opts (all optional, mostly test injection): manifestPath, files,
 *  delivered (.claude-relative list = forge-sync's listSystemFiles), seedDelivered, releaseTree,
 *  releaseFiles, ignoreKnownGaps, skipSyncDrift. Never throws for an ordinary problem: it reports it. */
function runShipcheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const absRoot = path.resolve(root);
  const manifestPath = o.manifestPath || path.join(absRoot, MANIFEST_REL);
  const violations = [];
  const v = (kind, p, detail, extra) => violations.push(Object.assign({ kind, path: p, detail }, extra || {}));
  const loaded = loadManifest(manifestPath);
  for (const e of loaded.errors) v(e.kind, e.path, e.detail);
  const finish = (extra) => finalize(Object.assign({ root: absRoot, manifest: toPosix(path.relative(absRoot, manifestPath)) || manifestPath, violations, loaded, o, t0 }, extra || {}));
  if (loaded.errors.some((e) => e.kind === 'manifest_invalid') || !loaded.rules.length) return finish();
  const { rules } = loaded;

  const en = enumerateSource(absRoot, o);
  if (en.error) { v('enumeration_failed', '.', en.error); return finish({ enumeration: { method: en.method } }); }
  const sourceSet = new Set(en.files);
  const byClass = {}; const ruleHits = new Map();
  // standalone match counts (every rule the path matches, not only the winner) and demotions by non-shipped rules
  const standalone = new Map(); const demoted = new Map();
  const protectedRes = protectedMatchers();
  const isProtected = protectedSpecOf;
  for (const p of en.files) {
    const r = classify(rules, p);
    for (const x of rules) if (x.re.test(p)) standalone.set(x.index, (standalone.get(x.index) || 0) + 1);
    if (!r) { v('unclassified', p, 'matches no manifest rule'); continue; }
    byClass[r.class] = (byClass[r.class] || 0) + 1;
    ruleHits.set(r.index, (ruleHits.get(r.index) || 0) + 1);
    if (r.class === 'retired') v('retired_present', p, 'retired (' + r.reason + ') but still present in source');
    if (!SHIPPED_CLASSES.has(r.class) && !r.literal && rules.slice(0, r.index).some((x) => SHIPPED_CLASSES.has(x.class) && x.re.test(p))) demoted.set(r.index, (demoted.get(r.index) || 0) + 1);
    const prot = SHIPPED_CLASSES.has(r.class) ? isProtected(p) : null;
    if (prot) v('protected_path_shipped', p, 'protected path (' + prot.spec.glob + ') is classified ' + r.class + ' by rule ' + JSON.stringify(r.pattern) + ' — secrets, env files, credentials, agent memory and run data never travel on any channel', { rule: r.pattern, protected_by: prot.spec.glob });
  }
  // synthetic probes — a broad shipped glob must not accept a private path even when no such file exists today
  for (const x of protectedRes) {
    const r = classify(rules, x.spec.probe);
    if (r && SHIPPED_CLASSES.has(r.class)) v('protected_path_shipped', x.spec.probe, 'synthetic probe: a path of the protected shape ' + x.spec.glob + ' would be classified ' + r.class + ' by rule ' + JSON.stringify(r.pattern) + ' — add a per-project/local-only rule for it', { rule: r.pattern, protected_by: x.spec.glob, synthetic: true });
  }
  // breadth — a non-per-project rule matching more than BROAD_RULE_MAX_SHARE of the tree is a catch-all in effect
  for (const r of rules) {
    const n = standalone.get(r.index) || 0;
    if (r.class !== 'per-project' && en.files.length >= 20 && n / en.files.length > BROAD_RULE_MAX_SHARE) v('manifest_invalid', 'rules[' + r.index + '] ' + r.pattern, 'rule too broad: it matches ' + n + ' of ' + en.files.length + ' source paths (' + Math.round(100 * n / en.files.length) + '% > ' + Math.round(100 * BROAD_RULE_MAX_SHARE) + '%) — a glob this wide hides unclassified and undelivered paths behind one class');
    const d = demoted.get(r.index) || 0;
    if (d > BROAD_OVERRIDE_MAX_DEMOTED) v('broad_override', r.pattern, 'broad override: this ' + r.class + ' rule demotes ' + d + ' path(s) that an earlier shipped rule claimed (max ' + BROAD_OVERRIDE_MAX_DEMOTED + ' without a known gap) — it can hide an undelivered helper', { demoted: d, class: r.class });
  }
  const reportedMissing = new Set();
  for (const r of rules) {
    if (!r.literalPaths || !SHIPPED_CLASSES.has(r.class) || r.origin === 'release-tree') continue;
    for (const lp of r.literalPaths) {
      if (sourceSet.has(lp) || classify(rules, lp) !== r) continue; // present, or overridden by a later rule
      reportedMissing.add(lp);
      v('ship_missing_in_source', lp, r.class + ' entry is not in source' + (fs.existsSync(path.join(absRoot, lp)) ? ' (it exists on disk but git ignores it)' : ''));
    }
  }
  const unusedRules = rules.filter((r) => !r.literal && !ruleHits.get(r.index)).map((r) => r.pattern);

  // --- forge-sync drift (both directions) ---
  let deliveredCount = null;
  const st = o.syncTool !== undefined ? o.syncTool : syncTool; // o.syncTool: test-only injection (null = absent)
  if (!o.skipSyncDrift) {
    let delivered = Array.isArray(o.delivered) ? o.delivered : null;
    if (!delivered && st && typeof st.listSystemFiles === 'function') {
      try { delivered = st.listSystemFiles(path.join(absRoot, '.claude')); } catch (e) { v('sync_delivery_unavailable', '.claude/forge-bin/forge-sync.cjs', 'listSystemFiles threw: ' + e.message); }
    } else if (!delivered) v('sync_delivery_unavailable', '.claude/forge-bin/forge-sync.cjs', 'forge-sync.cjs (listSystemFiles) is not available — drift cannot be checked');
    if (delivered) {
      const dset = new Set(delivered.map((d) => '.claude/' + toPosix(d)));
      deliveredCount = dset.size;
      for (const d of dset) {
        const r = classify(rules, d);
        if (!r || r.class !== 'ship-sync') v('sync_delivers_non_ship_sync', d, 'forge-sync delivers it, the manifest says ' + (r ? r.class : 'nothing (unclassified)'));
        else if (!sourceSet.has(d) && !reportedMissing.has(d)) v('ship_missing_in_source', d, 'forge-sync pins it but it is not in source');
      }
      for (const p of en.files) { const r = classify(rules, p); if (r && r.class === 'ship-sync' && !dset.has(p)) v('sync_not_delivered', p, 'manifest: ship-sync · forge-sync does not deliver it'); }
    }
    let seeds = o.seedDelivered || null;
    if (!seeds && st && typeof st.listSeedFiles === 'function') { try { seeds = st.listSeedFiles(path.join(absRoot, '.claude')); } catch { seeds = null; } }
    const seedSet = new Set((seeds || []).map((d) => '.claude/' + toPosix(d)));
    for (const p of en.files) { const r = classify(rules, p); if (r && r.class === 'seed-only' && !seedSet.has(p)) v('seed_not_delivered', p, seeds ? 'forge-sync does not seed it' : 'forge-sync has no seed-only mechanism yet'); }
  }

  // --- reference closure ---
  // The manifest itself is never scanned (it names every path by design). A reference to a RETIRED path is
  // not a ship gap — the file is gone everywhere and its entry names the replacement — so it is collected as
  // the advisory `retired_refs` list (stale mentions: input for the feature-registry/organisation work), never
  // a failure. A reference to a path no rule classifies and that does not exist is `unresolved` (advisory):
  // runtime-created, example or home-dir paths cannot be told apart statically.
  const manifestRel = toPosix(path.relative(absRoot, manifestPath));
  const ctx = { sourceSet };
  let scanned = 0, refsChecked = 0, refsIgnored = 0; const unresolved = []; const retiredRefs = [];
  for (const p of en.files) {
    const r = classify(rules, p);
    if (p === manifestRel || p === MANIFEST_REL || !landsInProject(r) || !REF_SCAN_EXTS.has(path.extname(p).toLowerCase())) continue;
    let text;
    try { const abs = path.join(absRoot, p); if (fs.statSync(abs).size > REF_SCAN_MAX_BYTES) continue; text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    scanned++;
    const isTest = /\.test\.(c|m)?js$/.test(p);
    for (const { target, via } of refs.extractRefs(text, p, ctx)) {
      if (target === p) continue;
      refsChecked++;
      const tr = classify(rules, target);
      if (!tr) { if (!sourceSet.has(target)) unresolved.push({ from: p, ref: target, via }); continue; }
      if (tr.class === 'retired') { retiredRefs.push({ from: p, ref: target, via }); continue; }
      // test-83 parity, generalised: a NON-test shipped file that names a config path which does not exist, but
      // which a shipped glob claims, points at something nothing ships — either per-project runtime/owner state
      // (then classify it so) or a ship gap. Limited to .claude/config/ on purpose: elsewhere such paths are
      // mostly examples in prose, and test files name fixture paths by the hundred (measured 2026-10-09).
      if (!sourceSet.has(target) && CLASS_SPEC[tr.class].landsInProject && !isTest && target.startsWith('.claude/config/')
        && !loaded.refIgnore.some((x) => x.fromRe.test(p) && x.refRe.test(target))) {
        v('ref_not_shipped', target, 'read by ' + p + ' (' + via + ') but it does not exist in source — classify it per-project (runtime/owner state) or add and ship it', { from: p, class: tr.class });
        continue;
      }
      if (isAvailable(tr) || (typeof tr.ref_ok === 'string' && tr.ref_ok.trim())) continue;
      if (loaded.refIgnore.some((x) => x.fromRe.test(p) && x.refRe.test(target))) { refsIgnored++; continue; }
      v('ref_not_shipped', target, 'referenced by ' + p + ' (' + via + ') but classified ' + tr.class + ' — a synced project never gets it', { from: p, class: tr.class });
    }
  }

  const release = o.releaseTree || o.releaseFiles ? releaseTreeCheck(absRoot, loaded, sourceSet, o, v) : null;
  return finish({ enumeration: { method: en.method, files: en.files.length }, by_class: byClass, delivered: deliveredCount, unused_rules: unusedRules,
    refs: { scanned_files: scanned, checked: refsChecked, ignored_by_manifest: refsIgnored, unresolved, retired_refs: retiredRefs }, release });
}

/** releaseTreeCheck — orphans (tracked, but retired / unclassified / gone from source), unexpected (a class or
 *  rule that must not be released), missing (a release-channel source file the tree lacks), plugin membership. */
function releaseTreeCheck(absRoot, loaded, sourceSet, o, v) {
  const { rules, manifest } = loaded;
  let files = o.releaseFiles || null; let method = 'injected';
  if (!files) {
    if (!releaseCheck) { v('release_enumeration_failed', String(o.releaseTree), 'forge-release-check.cjs is not available'); return { checked: 0 }; }
    const lt = releaseCheck.listTrackedFiles(path.resolve(o.releaseTree));
    if (lt.error) { v('release_enumeration_failed', String(o.releaseTree), lt.error); return { checked: 0 }; }
    files = lt.files; method = lt.method;
  }
  const tracked = new Set(files.map(toPosix));
  for (const f of tracked) {
    /** the protected-path guard used to run over the SOURCE enumeration only, so a secret, env file,
     *  agent memory or run data tracked in the release tree (where nothing classifies it shipped) went unseen. Any
     *  protected path tracked there is protected_path_shipped on the release channel — never gappable, placeholder
     *  or not; the normal release checks below still run (the finding is additive). */
    const prot = protectedSpecOf(f);
    if (prot) v('protected_path_shipped', f, 'protected path (' + prot.spec.glob + ') is tracked in the RELEASE tree — secrets, env files, credentials, agent memory and run data never travel on any channel', { channel: 'release', protected_by: prot.spec.glob });
    const r = classify(rules, f);
    if (!r) { v('release_orphan', f, 'tracked in the release tree, matches no manifest rule'); continue; }
    if (r.class === 'retired') { v('release_orphan', f, 'retired (replacement: ' + r.replacement + ') but still tracked in the release tree'); continue; }
    const releasable = (r.channels || []).includes('release');
    if (!releasable && !r.release_placeholder) { v('release_unexpected', f, 'classified ' + r.class + (r.release_excluded ? ' (release excluded: ' + r.release_excluded + ')' : '') + ' but tracked in the release tree'); continue; }
    if (f.startsWith('.claude/') && SHIPPED_CLASSES.has(r.class) && !sourceSet.has(f)) v('release_orphan', f, 'tracked in the release tree but no longer in source');
  }
  for (const p of sourceSet) { const r = classify(rules, p); if (r && (r.channels || []).includes('release') && !tracked.has(p)) v('release_missing', p, r.class + ' with the release channel, absent from the release tree'); }
  /** `release_placeholder:true` used to be a pure exemption from release_unexpected. A placeholder is
   *  now validated: every literal path of such an entry must be tracked in the release tree (release_placeholder_
   *  missing), and — when the release tree folder itself is given — every tracked placeholder file must hold no
   *  content matching a forge-store SECRET_PATTERNS shape (release_placeholder_secret, never gappable; the match is
   *  never echoed). Without a readable tree (an injected file list only) the content check is reported as not run. */
  const relRoot = o.releaseTree ? path.resolve(o.releaseTree) : null;
  let placeholders = 0, placeholderContentChecked = 0;
  for (const r of rules) {
    if (!r.release_placeholder) continue;
    for (const lp of r.literalPaths || []) {
      if (classify(rules, lp) === r && !tracked.has(lp)) v('release_placeholder_missing', lp, 'per-project entry ' + JSON.stringify(r.pattern) + ' is marked release_placeholder, but the release tree does not track ' + lp + ' — ship the curated placeholder or drop the flag');
    }
    for (const f of tracked) {
      if (!r.re.test(f) || classify(rules, f) !== r) continue;
      placeholders++;
      if (!relRoot) continue;
      const res = readReleaseFile(relRoot, f);
      if (res.error) { v('release_placeholder_unreadable', f, 'release placeholder cannot be content-checked: ' + res.error); continue; }
      const shape = secretShapeIn(res.text);
      if (shape === undefined) { v('release_placeholder_unreadable', f, 'forge-store.cjs (SECRET_PATTERNS) is not available — the placeholder content cannot be checked for secrets'); continue; }
      placeholderContentChecked++;
      if (shape) v('release_placeholder_secret', f, 'release placeholder content matches a secret shape (' + shape + ' of forge-store.cjs) — a placeholder must hold no real credential; the matched text is not echoed');
    }
  }
  const pl = (manifest && manifest.plugin) || {};
  const proot = toPosix(pl.root || 'plugins/forge');
  const ext = pl.external || {};
  const present = { skills: new Set(), agents: new Set(), commands: new Set() };
  for (const f of tracked) {
    if (!f.startsWith(proot + '/')) continue;
    const rest = f.slice(proot.length + 1).split('/');
    if (rest[0] === 'skills' && rest.length >= 3) present.skills.add(rest[1]);
    if ((rest[0] === 'agents' || rest[0] === 'commands') && rest.length === 2) present[rest[0]].add(rest[1]);
  }
  const expected = { skills: new Set(), agents: new Set(), commands: new Set() };
  for (const p of sourceSet) {
    const r = classify(rules, p);
    if (!r || !(r.channels || []).includes('plugin')) continue;
    let m;
    if ((m = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p))) expected.skills.add(m[1]);
    else if ((m = /^\.claude\/(agents|commands)\/([^/]+\.md)$/.exec(p))) expected[m[1]].add(m[2]);
  }
  for (const k of ['skills', 'agents', 'commands']) {
    const extSet = new Set(ext[k] || []);
    for (const name of expected[k]) if (!present[k].has(name)) v('plugin_missing', '.claude/' + k + '/' + name + (k === 'skills' ? '/SKILL.md' : ''), 'marked with the plugin channel, absent from ' + proot + '/' + k);
    for (const name of present[k]) if (!expected[k].has(name) && !extSet.has(name)) v('plugin_unlisted', proot + '/' + k + '/' + name, 'carried by the plugin but no manifest entry has the plugin channel (and it is not listed under plugin.external)');
  }
  return { method, checked: tracked.size, plugin_root: proot, placeholders, placeholder_content_checked: relRoot ? placeholderContentChecked : null };
}

function finalize(s) {
  const { violations, loaded, o, t0 } = s;
  const evaluatedKinds = new Set(['unclassified', 'ship_missing_in_source', 'retired_present', 'ref_not_shipped', 'protected_path_shipped', 'broad_override']);
  if (!o.skipSyncDrift) ['sync_not_delivered', 'sync_delivers_non_ship_sync', 'seed_not_delivered', 'sync_delivery_unavailable'].forEach((k) => evaluatedKinds.add(k));
  if (s.release) RELEASE_KINDS.forEach((k) => evaluatedKinds.add(k));
  const gapHits = new Map();
  for (const x of violations) {
    if (o.ignoreKnownGaps || NEVER_GAPPABLE.has(x.kind)) continue;
    const g = loaded.knownGaps.find((k) => k.kinds.includes(x.kind) && k.res.some((re) => re.test(x.path)));
    if (g) { x.known_gap = g.id; x.owner_wp = g.owner_wp; gapHits.set(g.id, (gapHits.get(g.id) || 0) + 1); }
  }
  const failures = violations.filter((x) => !x.known_gap);
  const warnings = violations.filter((x) => x.known_gap);
  const staleKnownGaps = o.ignoreKnownGaps ? [] : loaded.knownGaps.filter((g) => !gapHits.get(g.id) && g.kinds.some((k) => evaluatedKinds.has(k))).map((g) => g.id);
  const known_gaps = loaded.knownGaps.map((g) => ({ id: g.id, owner_wp: g.owner_wp, kinds: g.kinds, matched: gapHits.get(g.id) || 0 }));
  return {
    ok: failures.length === 0, schema: SCHEMA, root: s.root, manifest: s.manifest, enumeration: s.enumeration || null,
    by_class: s.by_class || {}, delivered: s.delivered === undefined ? null : s.delivered, unused_rules: s.unused_rules || [],
    refs: s.refs || null, release: s.release || null, failures, warnings, known_gaps, stale_known_gaps: staleKnownGaps,
    ignored_known_gaps: !!o.ignoreKnownGaps, ms: Date.now() - t0,
  };
}

function groupByKind(list) { const m = new Map(); for (const x of list) { if (!m.has(x.kind)) m.set(x.kind, []); m.get(x.kind).push(x); } return m; }
/** formatReport(rep, verbose) -> human text (the CLI's default output). */
function formatReport(rep, verbose) {
  const out = [];
  const cap = verbose ? Infinity : 12;
  out.push('forge-shipcheck — ' + rep.root + ' · manifest ' + rep.manifest);
  if (rep.enumeration) out.push('  source: ' + (rep.enumeration.files || 0) + ' path(s) via ' + rep.enumeration.method + ' · forge-sync delivers ' + (rep.delivered == null ? 'n/a' : rep.delivered) + ' · ' + rep.ms + ' ms');
  const cls = Object.entries(rep.by_class || {}).map(([k, n]) => k + ' ' + n).join(' · ');
  if (cls) out.push('  classes: ' + cls);
  if (rep.refs) out.push('  references: ' + rep.refs.checked + ' checked in ' + rep.refs.scanned_files + ' shipped file(s) · ' + rep.refs.ignored_by_manifest + ' ignored by ref_ignore · advisory: ' + rep.refs.unresolved.length + ' unresolved, ' + rep.refs.retired_refs.length + ' to retired paths');
  if (rep.refs && verbose) for (const x of rep.refs.retired_refs) out.push('    retired ref (advisory): ' + x.from + ' -> ' + x.ref);
  if (rep.release) out.push('  release tree: ' + rep.release.checked + ' tracked file(s)' + (rep.release.method ? ' via ' + rep.release.method : ''));
  for (const [label, list] of [['FAILURES', rep.failures], ['WARNINGS (known gaps)', rep.warnings]]) {
    if (!list.length) continue;
    out.push('  ' + label + ': ' + list.length);
    for (const [kind, items] of groupByKind(list)) {
      out.push('    ' + kind + ' (' + items.length + ')');
      for (const x of items.slice(0, cap)) out.push('      ' + x.path + (x.known_gap ? '  [' + x.known_gap + ' → ' + x.owner_wp + ']' : '') + ' — ' + x.detail);
      if (items.length > cap) out.push('      … +' + (items.length - cap) + ' more (--verbose)');
    }
  }
  if (rep.stale_known_gaps.length) out.push('  stale known gaps (nothing matches them any more — remove them): ' + rep.stale_known_gaps.join(', '));
  if (rep.unused_rules.length) out.push('  info: ' + rep.unused_rules.length + ' glob rule(s) currently match no source path: ' + rep.unused_rules.slice(0, 8).join(', ') + (rep.unused_rules.length > 8 ? ', …' : ''));
  out.push(rep.ok ? '  ⇒ OK' + (rep.warnings.length ? ' (' + rep.warnings.length + ' known-gap warning(s))' : '') : '  ⇒ FAILED (' + rep.failures.length + ')');
  return out.join('\n');
}

function devTreeMarkerValid(root) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'), 'utf8'));
    return !!d && d.dev_tree === true;
  } catch { return false; }
}
// WP 2.1: forge-paths.cjs is optional (a copied tool or an older install keeps the own-folder default). Plugin copy:
// scriptRoot discovers the project (CLAUDE_PROJECT_DIR / cwd), never the plugin folder; none found -> --root needed.
let forgePaths = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.scriptRoot === 'function') forgePaths = fp; } catch { forgePaths = null; }
function defaultRoot() {
  if (!forgePaths) return path.resolve(__dirname, '..', '..'); // forge-paths fallback
  try { return forgePaths.scriptRoot(__dirname); } catch { return null; }
}
function parseArgs(argv) {
  const a = { root: defaultRoot(), manifest: null, releaseTree: null, json: false, verbose: false, ignoreKnownGaps: false, error: null };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--root') a.root = argv[++i];
    else if (x === '--manifest') a.manifest = argv[++i];
    else if (x === '--release-tree') a.releaseTree = argv[++i];
    else if (x === '--json') a.json = true;
    else if (x === '--verbose') a.verbose = true;
    else if (x === '--no-known-gaps') a.ignoreKnownGaps = true;
    else if (x === '--force-dev') a.forceDev = true;
    else a.error = 'unknown argument ' + x;
  }
  if (!a.error && a.root === null && !argv.includes('--root')) a.error = 'no project root found (no .claude, .forge or .git above the current folder) — pass --root <dir>';
  if (!a.error && (!a.root || (a.releaseTree === undefined) || (a.manifest === undefined))) a.error = 'a flag is missing its value';
  return a;
}
function main(argv) {
  const a = parseArgs(argv);
  if (a.error) { console.error('forge-shipcheck: ' + a.error + '\nUsage: forge-shipcheck.cjs [--root <dir>] [--manifest <file>] [--release-tree <dir>] [--no-known-gaps] [--json] [--verbose]'); process.exitCode = 1; return; }
  // Outside the development tree (no valid config/forge-dev-tree.json) this tool describes a repository that is not
  // here: report "not applicable" (exit 0) like the doctor does. --force-dev / FORGE_SHIPCHECK_FORCE_DEV=1 override.
  if (!a.forceDev && process.env.FORGE_SHIPCHECK_FORCE_DEV !== '1' && !devTreeMarkerValid(a.root)) {
    console.log(a.json ? JSON.stringify({ ok: true, applicable: false, reason: 'no config/forge-dev-tree.json' }) : 'shipcheck: not applicable outside the development tree (no config/forge-dev-tree.json)');
    process.exitCode = 0; return;
  }
  const rep = runShipcheck(a.root, { manifestPath: a.manifest ? path.resolve(a.manifest) : undefined, releaseTree: a.releaseTree || undefined, ignoreKnownGaps: a.ignoreKnownGaps });
  console.log(a.json ? JSON.stringify(rep, null, 2) : formatReport(rep, a.verbose));
  process.exitCode = rep.ok ? 0 : 3;
}
if (require.main === module) main(process.argv);

module.exports = { runShipcheck, loadManifest, classify, globToRegExp, enumerateSource, formatReport, isAvailable, landsInProject,
  SCHEMA, MANIFEST_REL, CLASS_SPEC, CHANNELS, GAPPABLE_KINDS, NEVER_GAPPABLE, CATCH_ALL,
  // expanded catch-all detection, breadth/override guards and the protected-path list
  isCatchAllGlob, expandBraces, PROTECTED_PATHS, BROAD_RULE_MAX_SHARE, BROAD_OVERRIDE_MAX_DEMOTED,
  // the shared protected-path matcher and the placeholder secret-shape check
  protectedSpecOf, secretShapeIn, RELEASE_KINDS };
