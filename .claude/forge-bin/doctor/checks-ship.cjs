'use strict';
/**
 * doctor/checks-ship.cjs — one module of forge-doctor.cjs (WP A11 part 2): release_exclusions, ship_manifest, feature_registry, skill_frontmatter.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { claudeDir, regGenTool, releaseCheckTool, shipcheckTool } = require('./context.cjs');
const { parseFrontmatter } = require('./checks-agents.cjs');
const { listSkillFiles } = require('./checks-completeness.cjs');
const { SKILL_DESCRIPTION_MAX_CHARS, detectVendorPin, readDevTreeMarker } = require('./checks-hygiene.cjs');

/** DIST_REPO_MARKERS — the exact three paths (relative to `root`) that together mean "this root IS the
 *  Forge distribution repository" (the thing `install.sh`/`install.ps1` set up and the public release
 *  tree looks like) rather than a development checkout or an ordinary project with Forge installed into
 *  it. All three must be present — any one alone is not distinctive enough (an ordinary project could
 *  plausibly ship its own unrelated install.sh, for instance). */
const DIST_REPO_MARKERS = ['install.sh', 'install.ps1', path.join('plugins', 'forge', '.claude-plugin', 'plugin.json')];
/** looksLikeDistRepo(root) -> true only when every DIST_REPO_MARKERS path exists under root. */
function looksLikeDistRepo(root) {
  return DIST_REPO_MARKERS.every((rel) => { try { return fs.existsSync(path.join(root, rel)); } catch { return false; } });
}

/** releaseExclusionsCheck(root) -> {ok, reason, dist_checked, dist_reason, pattern_counts, method?,
 *  files_checked?, violations?} — (prd-w2-discipline M2). ENFORCED (wired into the
 *  main `checks` object, not `advisory`): "nothing private slips into a public release unnoticed" is a
 *  real build gate, not a bookkeeping nicety.
 *
 *  Two independent things can fail here, both honestly:
 *   1) the config itself is broken (unreadable, invalid JSON, a missing required list, or any pattern
 *      that does not compile) — loadExclusions() throws for all four, caught here as ok:false. This half
 *      runs on EVERY call, everywhere, because a config this tool cannot parse can never be trusted to
 *      mean "nothing is forbidden".
 *   2) `root` IS the Forge distribution repository (see looksLikeDistRepo()) and it actually TRACKS a
 *      forbidden path — forge-release-check.checkDist() reports every one.
 *
 *  In every OTHER root — the development tree, or an ordinary project with Forge installed into it,
 *  whose own real forge-runs/agent-memory/etc. are legitimate and may well be tracked by that project's
 *  own git repo — checkDist() is deliberately NOT run at all: this check cannot tell "a private file
 *  leaked into a public release" from "a project owner's own repo, which is private by construction,
 *  tracks its own run history" without the dist-repo marker, so it stays silent rather than guess. Those
 *  roots still get a real answer: ok:true with the pattern counts and an explicit reason naming why the
 *  dist check was skipped.
 *
 *  Cheap by construction: no network, and the only filesystem work beyond loadExclusions() is three
 *  fs.existsSync() calls plus (only in the distribution repo) one `git ls-files`/walk. */
function releaseExclusionsCheck(root, opts) {
  const o = opts || {};
  if (!releaseCheckTool) {
    return { ok: false, reason: 'forge-release-check.cjs module not available (release-exclusions check unavailable)', dist_checked: false, pattern_counts: null };
  }
  let ex;
  try {
    // o.configPath is test-only injection (same posture as settingsSource/env/platform/windowMs
    // elsewhere in this file) — a real run always resolves the config this install actually ships,
    // via forge-release-check.cjs's own defaultConfigPath(), never anything root-dependent.
    ex = releaseCheckTool.loadExclusions(o.configPath);
  } catch (e) {
    return { ok: false, reason: 'release-exclusions config failed to load: ' + e.message, dist_checked: false, pattern_counts: null };
  }
  const patternCounts = {
    sync_folders: ex.sync_folders.length,
    never_sync: ex.never_sync.length,
    dist_forbidden: ex.dist_forbidden.length,
  };
  if (!looksLikeDistRepo(root)) {
    return {
      ok: true,
      reason: 'not the Forge distribution repo (install.sh + install.ps1 + plugins/forge/.claude-plugin/plugin.json not all present) — dist check skipped; this root may legitimately track its own run history/memory',
      dist_checked: false,
      pattern_counts: patternCounts,
    };
  }
  try {
    // o.distCheckOpts is test-only injection (same posture as o.configPath above), passed straight through
    // to forge-release-check.checkDist()'s own opts.spawn/opts.readdir seams — see that function's doc
    // comment. A real run never sets it, so checkDist always uses the real spawnSync/fs.readdirSync.
    const res = releaseCheckTool.checkDist(root, ex, o.distCheckOpts);
    // res.error means checkDist could not even FINISH enumerating the tree (a
    // real git failure, or an unreadable directory mid-walk) — distinct from, and never conflated with,
    // "0 forbidden path(s) tracked" (which would misleadingly read as an almost-clean result). Report the
    // real failure instead.
    if (res.error) {
      return {
        ok: false,
        reason: 'could not enumerate the distribution tree: ' + res.error,
        dist_checked: true,
        method: res.method || null,
        pattern_counts: patternCounts,
      };
    }
    return {
      ok: res.ok,
      reason: res.ok ? '' : (res.violations.length + ' forbidden path(s) tracked in the distribution tree: ' + res.violations.map((v) => v.path).join(', ')),
      dist_checked: true,
      method: res.method,
      files_checked: res.files_checked,
      violations: res.violations,
      pattern_counts: patternCounts,
    };
  } catch (e) {
    return { ok: false, reason: 'forge-release-check checkDist threw: ' + e.message, dist_checked: true, pattern_counts: patternCounts };
  }
}

/** shipManifestCheck(root, opts) -> {ok, applicable, reason, failures?, warnings?, stale_known_gaps?, by_class?,
 *  sources?, delivered?, refs_checked?, ms?} — (2026-10-09,;
 *  audit F12/F5/ORG-04/SYNC-08). ENFORCED from day one (wired into `checks`).
 *
 *  In the DEVELOPMENT tree (readDevTreeMarker(): .claude/config/forge-dev-tree.json says dev_tree:true) it runs
 *  forge-shipcheck.runShipcheck() over the whole source against config/orchestration/FORGE_SHIP_MANIFEST.json:
 *  every source path classified, every ship-* entry present, retired entries carry a replacement, forge-sync's
 *  listSystemFiles() equals the manifest's ship-sync set in BOTH directions, and no file that lands in a project
 *  points at a file a project never receives (reference closure — .md/.cjs/.json, the class test 83 only covered
 *  for config/orchestration/*.json). A violation listed under the manifest's `known_gaps` (with its owner work
 *  package) is a warning; EVERY other violation fails the doctor. Measured 0.3-1.0 s on this tree on 2026-10-09
 *  (git ls-files, ~3,100 existence checks, ~517 shipped files read), cheap enough to run on every doctor call.
 *
 *  Everywhere else it is applicable:false/ok:true: a synced or redistributed project holds only shipped files plus
 *  its own data, so classification, drift and closure cannot be judged there — and a check that is new AND red
 *  after a sync counts as a regression in forge-sync's regressionCheck(), which would roll every sync back. The one
 *  thing still judged there: a shipped manifest that is present but does not load fails (a broken manifest must
 *  never land quietly). sync_completeness (advisory) is kept beside it on purpose — see the header doc.
 *  opts.shipcheckOpts is a TEST-ONLY passthrough to runShipcheck (files/delivered/manifestPath injection). */
function shipManifestCheck(root, opts) {
  const o = opts || {};
  const marker = readDevTreeMarker(root);
  const manifestPath = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
  if (!marker.valid) {
    if (!fs.existsSync(manifestPath)) return { ok: true, applicable: false, reason: 'not the development tree and no shipped FORGE_SHIP_MANIFEST.json here — the full shipcheck runs only in the development tree' };
    if (!shipcheckTool) return { ok: true, applicable: false, reason: 'not the development tree — the full shipcheck runs only there (forge-shipcheck.cjs absent, manifest shape not checked)' };
    const loaded = shipcheckTool.loadManifest(manifestPath);
    if (loaded.errors.length) return { ok: false, applicable: false, reason: 'the shipped FORGE_SHIP_MANIFEST.json does not load: ' + loaded.errors.slice(0, 3).map((e) => e.path + ' (' + e.detail + ')').join('; '), failures: loaded.errors };
    return { ok: true, applicable: false, reason: 'not the development tree — full shipcheck skipped; the shipped manifest loads (' + loaded.rules.length + ' rules)' };
  }
  if (!shipcheckTool) return { ok: false, applicable: true, reason: 'forge-shipcheck.cjs module not available in the development tree (ship-manifest check unavailable)' };
  let rep;
  try { rep = shipcheckTool.runShipcheck(root, o.shipcheckOpts); } catch (e) { return { ok: false, applicable: true, reason: 'forge-shipcheck threw: ' + e.message }; }
  return {
    ok: rep.ok,
    applicable: true,
    reason: rep.ok ? '' : rep.failures.length + ' violation(s) not covered by a known gap',
    failures: rep.failures,
    warnings: rep.warnings,
    stale_known_gaps: rep.stale_known_gaps,
    by_class: rep.by_class,
    sources: rep.enumeration ? rep.enumeration.files || 0 : 0,
    delivered: rep.delivered,
    refs_checked: rep.refs ? rep.refs.checked : 0,
    ms: rep.ms,
  };
}

// ===========================================================================================================
// + part ii (audit S3/F4, ORG-02/05/07/11/12/14).
// The owner's complaint: "many features, and everything slips through without it knowing; mind maps and other
// features were not there". A tool nothing calls, or a skill nothing registers, has to be VISIBLE (red or
// labelled), never silent. Two ENFORCED checks (development tree only, n/a or labelled elsewhere so a synced
// project never gets a new red check that forge-sync's regressionCheck would treat as a regression) and four
// ADVISORY ones (report.advisory.*, never part of doctor.ok).
// ===========================================================================================================
const FEATURE_REGISTRY_FIX = 'node .claude/forge-bin/forge-registry-gen.cjs feature-registry --write';
/** featureRegistryCheck(root) — ENFORCED in the development tree. Reads FORGE_FEATURE_REGISTRY.json and re-runs
 *  the SAME static caller scan the generator uses (forge-registry-gen.cjs classifyFeatures — one scanner, never two).
 *  Red, with exact names, when: a tool/skill on disk is not in the registry; a non-retired entry's file is gone; a
 *  `wired` entry has no wired caller chain any more; the registry does not load or has an invalid entry. `dormant`
 *  and `on-request` are NEVER red (a stale classification or a dormant entry without a note is a warning).
 *  A `wired` entry whose recorded callers include the Command Center while command-center/ is absent here cannot be
 *  judged and is listed as unverifiable, not red. Outside the development tree: applicable:false, ok:true. */
function featureRegistryCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const gen = o.regGen !== undefined ? o.regGen : regGenTool;
  const regPath = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_FEATURE_REGISTRY.json');
  if (!readDevTreeMarker(root).valid) {
    return { ok: true, applicable: false, reason: fs.existsSync(regPath)
      ? 'not the development tree — the feature registry is judged only there (this copy is not checked)'
      : 'not the development tree and no FORGE_FEATURE_REGISTRY.json here — the feature registry is judged only in the development tree' };
  }
  if (!gen || typeof gen.classifyFeatures !== 'function') return { ok: false, applicable: true, reason: 'forge-registry-gen.cjs is not available in the development tree (the feature-registry check cannot run)', fix: FEATURE_REGISTRY_FIX };
  let c;
  try { c = gen.classifyFeatures(root); } catch (e) { return { ok: false, applicable: true, reason: 'the feature scan threw: ' + e.message }; }
  const onDisk = c.nodes;
  const loaded = gen.loadFeatureRegistry(root);
  if (!loaded.present) return { ok: false, applicable: true, reason: 'FORGE_FEATURE_REGISTRY.json is missing: ' + onDisk.size + ' tool(s)/skill(s) on disk are registered nowhere', missing: [...onDisk.keys()], fix: FEATURE_REGISTRY_FIX, ms: Date.now() - t0 };
  if (loaded.error) return { ok: false, applicable: true, reason: 'FORGE_FEATURE_REGISTRY.json does not load (' + loaded.error + ')', fix: 'repair the JSON by hand (the generator refuses to overwrite it, so hand notes are not lost)' };
  const invalid = gen.validateFeatureRegistry(loaded.data);
  const entries = (Array.isArray(loaded.data.features) ? loaded.data.features : []).filter((f) => f && typeof f.id === 'string' && f.id);
  const byKey = new Map(entries.map((f) => [f.kind + ':' + f.id, f]));
  const missing = [...onDisk.keys()].filter((k) => !byKey.has(k));
  const gone = entries.filter((f) => f.status !== 'retired' && !onDisk.has(f.kind + ':' + f.id)).map((f) => f.kind + ':' + f.id);
  // W2-FRESHCLONE: command-center/ is a separate gitignored repo, so a fresh outer clone cannot scan it.
  // A wired entry the Command Center calls directly, or one whose CURRENT caller is such an entry (transitively),
  // cannot be judged here: unverifiable (shown on the ✓ line), not red. A link cut inside the outer repo stays red.
  const ccLinked = new Set();
  if (!c.gatewayScanned) {
    for (const f of entries) if (f.status === 'wired' && (f.invoked_by || []).some((s) => /^command-center\//.test(String(s)))) ccLinked.add(f.kind + ':' + f.id);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of entries) {
        const k = f.kind + ':' + f.id, n = onDisk.get(k);
        if (f.status !== 'wired' || ccLinked.has(k) || !n || !n.callers.some((x) => x.node && ccLinked.has(x.node))) continue;
        ccLinked.add(k); grew = true;
      }
    }
  }
  const wiredWithoutCaller = [], unverifiable = [], stale = [];
  for (const f of entries) {
    const n = onDisk.get(f.kind + ':' + f.id);
    if (!n || f.status === 'retired' || n.status === f.status) continue;
    if (f.status === 'wired') {
      if (ccLinked.has(f.kind + ':' + f.id)) unverifiable.push(f.kind + ':' + f.id);
      else wiredWithoutCaller.push({ id: f.kind + ':' + f.id, now: n.status, callers: n.callers.map((x) => x.from + ' (' + x.kind + ')').slice(0, 3) });
    } else stale.push({ id: f.kind + ':' + f.id, registry: f.status, now: n.status });
  }
  const dormantWithoutNote = entries.filter((f) => f.status === 'dormant' && !(typeof f.note === 'string' && f.note.trim())).map((f) => f.kind + ':' + f.id);
  const counts = {};
  for (const k of ['tool', 'skill']) { counts[k] = {}; for (const s of ['wired', 'on-request', 'dormant', 'retired']) counts[k][s] = entries.filter((f) => f.kind === k && f.status === s).length; }
  const ok = invalid.length === 0 && missing.length === 0 && gone.length === 0 && wiredWithoutCaller.length === 0;
  const parts = [];
  if (missing.length) parts.push(missing.length + ' on disk but not registered: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', +' + (missing.length - 8) : ''));
  if (gone.length) parts.push(gone.length + ' registered but the file is gone: ' + gone.slice(0, 8).join(', '));
  if (wiredWithoutCaller.length) parts.push(wiredWithoutCaller.length + ' marked wired with no wired caller now: ' + wiredWithoutCaller.slice(0, 8).map((w) => w.id + ' (now ' + w.now + ')').join(', '));
  if (invalid.length) parts.push(invalid.length + ' invalid entr(y/ies): ' + invalid.slice(0, 4).join('; '));
  return {
    ok, applicable: true, reason: ok ? '' : parts.join(' · '), fix: ok ? null : FEATURE_REGISTRY_FIX + ' (then review every new dormant note by hand)',
    counts, entries: entries.length, missing, gone, wired_without_caller: wiredWithoutCaller, invalid, stale, dormant_without_note: dormantWithoutNote,
    unverifiable, gateway_scanned: c.gatewayScanned, ms: Date.now() - t0,
  };
}

/** skillDescriptionIssues(raw) -> [issue] for the RAW text after `description:` on its frontmatter line. YAML reads
 *  `a: b` inside an unquoted value as a nested key and fails; Claude Code then drops the description and shows the
 *  skill under its first heading instead (seen live: forge-agent listed as "Forge playbook — Agent / LLM app + evals").
 *  A plain value must not contain ": " or " #" or start with a YAML indicator; a quoted value must be closed.
 *  WP 1.9: `field` (default 'description') names the key in the messages, so the SAME rule is applied
 *  to `when_to_use`; the description messages are unchanged. */
function skillDescriptionIssues(raw, field) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return [];
  const isDesc = !field || field === 'description';
  const noun = isDesc ? 'description' : field + ' value';
  const subj = isDesc ? 'the description' : field;
  if (v[0] === '"') return /^"(?:[^"\\]|\\.)*"$/.test(v) ? [] : ['the double-quoted ' + noun + ' is not closed properly (or has an unescaped " inside)'];
  if (v[0] === "'") return /^'(?:[^']|'')*'$/.test(v) ? [] : ['the single-quoted ' + noun + ' is not closed properly'];
  if (v[0] === '>' || v[0] === '|') return [subj + ' is a block scalar (' + v[0] + '): the repo frontmatter parser reads one line only — put it on one line, in double quotes'];
  const issues = [];
  if (/: |:$/.test(v)) issues.push(subj + ' contains ": " but is not quoted — YAML reads it as a nested key, so ' + (isDesc ? 'Claude Code drops it and shows the first heading instead' : 'the whole frontmatter stops being valid YAML (the failure that made Claude Code drop a description live)') + '; wrap the whole ' + noun + ' in double quotes');
  if (/\s#/.test(v)) issues.push(subj + ' contains " #" unquoted — YAML cuts it off there as a comment; wrap it in double quotes');
  if (/^(?:[[\]{}&*!%@`,]|[-?:](?:\s|$))/.test(v)) issues.push(subj + ' starts with a YAML indicator character; wrap it in double quotes');
  return issues;
}
// WP 1.9, verified against the live Claude Code docs on 2026-10-24 (modernization lane 0.2): the skill
// listing shows description + when_to_use together and cuts that entry at 1,536 characters.
const SKILL_LISTING_ENTRY_MAX_CHARS = 1536;
// Claude Code's on/off skill switches: only an unquoted true/false is a boolean to its YAML reader ("true" in quotes,
// yes/no and an empty value are strings or null, so the switch silently does nothing).
const SKILL_BOOLEAN_KEYS = ['disable-model-invocation', 'user-invocable'];
/** frontmatterScalarText(raw) -> the one-line YAML scalar as text: surrounding quotes removed, \" and '' unescaped. */
function frontmatterScalarText(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(.)/g, '$1');
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
// SA-P1-SKILLS (PHASE2-PLAN A7 + B2, rule "added = installed + wired + used"). Three guards:
// (a) a trigger phrase ("Use when/whenever/before/after/during") in description/when_to_use while
//     disable-model-invocation is true: Claude Code keeps such a skill out of the model listing, so the phrase can never
//     fire. Allowed only when the description says "User-invoked only". An issue (red in the development tree).
// (c) a frontmatter name that differs from the folder name: a warning only.
// (b) pluginInstallCheck(): an ENABLED plugin whose installed_plugins.json installPath does not exist.
const SKILL_TRIGGER_PHRASE_RE = /\buse\s+(?:it\s+|this\s+)?(?:when|whenever|before|after|during)\b/i;
const SKILL_USER_ONLY_RE = /\buser[- ]invoked only\b/i;
/** skillInvocationConflict(fm) -> an issue string, or null. fm = parseFrontmatter() output. */
function skillInvocationConflict(fm) {
  if (!fm || String(fm['disable-model-invocation'] || '').replace(/\s+#.*$/, '').trim() !== 'true') return null;
  const desc = frontmatterScalarText(fm.description);
  const text = desc + ' ' + frontmatterScalarText(fm.when_to_use);
  const m = SKILL_TRIGGER_PHRASE_RE.exec(text);
  if (!m || SKILL_USER_ONLY_RE.test(desc)) return null;
  return 'description says "' + m[0] + '" but disable-model-invocation is true — the skill is kept out of the model listing, so it can never auto-trigger; remove the flag or rewrite the description as "User-invoked only: /<cmd> ..."';
}
/** skillNameMismatch(folder, fm) -> a warning string, or null. */
function skillNameMismatch(folder, fm) {
  const name = fm ? frontmatterScalarText(fm.name) : '';
  return name && name !== folder ? 'frontmatter name "' + name + '" differs from its folder "' + folder + '" — Claude Code lists it under one of the two; rename one so they match' : null;
}
/** claudeHomeDir(opts) -> the Claude Code config folder: opts.claudeHome, else CLAUDE_CONFIG_DIR, else ~/.claude. */
function claudeHomeDir(o) {
  if (o && o.claudeHome) return o.claudeHome;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  try { return path.join(require('os').homedir(), '.claude'); } catch { return null; }
}
const readJsonOrNull = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/** pluginInstallCheck(opts) -> {ok, applicable, enabled[], missing[{plugin, reason, installPath?}], disabled_stale[], warnings[], reason}.
 *  READ ONLY: parses <home>/settings.json (only enabledPlugins is used; nothing else is copied into the report) and
 *  <home>/plugins/installed_plugins.json. Red when an enabled plugin has no install record, or none of its records'
 *  installPath exists — the silent claude-mem breakage of 2026-11 (enabled, cache folder gone, every skill dead). */
function pluginInstallCheck(opts) {
  const home = claudeHomeDir(opts || {});
  const settings = home ? readJsonOrNull(path.join(home, 'settings.json')) : null;
  const enabledMap = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : null;
  if (!enabledMap) return { ok: true, applicable: false, enabled: [], missing: [], disabled_stale: [], warnings: [], reason: 'no readable settings.json with enabledPlugins in the Claude home — nothing to check' };
  const enabled = Object.keys(enabledMap).filter((k) => enabledMap[k] === true);
  const installedDoc = readJsonOrNull(path.join(home, 'plugins', 'installed_plugins.json'));
  const installed = installedDoc && installedDoc.plugins && typeof installedDoc.plugins === 'object' ? installedDoc.plugins : {};
  const missing = [];
  for (const id of enabled) {
    const recs = (Array.isArray(installed[id]) ? installed[id] : []).filter((r) => r && typeof r.installPath === 'string' && r.installPath);
    if (!recs.length) { missing.push({ plugin: id, reason: 'enabled but not installed (no installPath in installed_plugins.json)' }); continue; }
    if (!recs.some((r) => { try { return fs.existsSync(r.installPath); } catch { return false; } })) missing.push({ plugin: id, reason: 'enabled but its installPath does not exist', installPath: recs[0].installPath });
  }
  // Rework 2026-11-04: a plugin switched OFF in enabledPlugins (explicit false) whose install record points to a gone
  // folder is a WARNING, never red — it cannot break a session, but "added = installed + wired + used" is not met
  // (claude-mem@thedotmack was switched off on this machine during the audit, so it is no longer an enabled-broken red).
  const disabledStale = Object.keys(enabledMap).filter((k) => enabledMap[k] === false).filter((id) => {
    const recs = (Array.isArray(installed[id]) ? installed[id] : []).filter((r) => r && typeof r.installPath === 'string' && r.installPath);
    return recs.length > 0 && !recs.some((r) => { try { return fs.existsSync(r.installPath); } catch { return false; } });
  });
  const warnings = disabledStale.map((id) => id + ': switched off in enabledPlugins and its installPath is gone — reinstall it (owner: /plugin install ' + id + ') if it should be used, otherwise ignore');
  return {
    ok: missing.length === 0, applicable: true, enabled, missing, disabled_stale: disabledStale, warnings,
    reason: missing.length ? missing.length + ' enabled plugin(s) broken: ' + missing.map((m) => m.plugin + ' (' + (m.installPath ? 'installPath missing' : 'not installed') + ')').join('; ') + ' — reinstall (owner: /plugin install <name>) or disable it' : '',
  };
}
/** isOwnProjectRoot(root) -> true when root is the project this doctor copy lives in (doctor/ -> forge-bin -> .claude -> root).
 *  The machine plugin check only runs there (or with an explicit opts.claudeHome): a fixture root says nothing about this machine. */
function isOwnProjectRoot(root) {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch { /* keep resolved */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(root) === norm(path.join(__dirname, '..', '..', '..'));
}

/** skillFrontmatterCheck(root) — ENFORCED in the development tree; labelled (ok:true, findings listed) elsewhere.
 *  Every TOP-LEVEL .claude/skills/<name>/SKILL.md: the frontmatter parses with this file's parseFrontmatter(), has
 *  a name and a description, the description is <= SKILL_DESCRIPTION_MAX_CHARS exactly as skill_hygiene measures it
 *  (a vendored skill's length is reported as vendored_style, never counted), and skillDescriptionIssues() finds
 *  nothing. WP 1.9: the same quoting rule for `when_to_use`, description + when_to_use <=
 *  SKILL_LISTING_ENTRY_MAX_CHARS (vendored: vendored_style), and disable-model-invocation / user-invocable, when
 *  present, exactly true or false. Plus the quality drift rule, REUSED from forge-quality.cjs catalogDrift() (never duplicated): every
 *  forge-* skill folder is a domain playbook in domain-catalog.json or listed in non_domain_skills. */
function skillFrontmatterCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dev = readDevTreeMarker(root).valid;
  const cd = claudeDir(root);
  const skills = [];
  const warnings = [];
  for (const rel of listSkillFiles(root)) {
    if (rel.split('/').length !== 3) continue; // skills/<name>/SKILL.md only (nested folders are not discovered as skills)
    const id = rel.split('/')[1];
    let text;
    try { text = fs.readFileSync(path.join(cd, rel.split('/').join(path.sep)), 'utf8'); } catch (e) { skills.push({ skill: id, issues: ['SKILL.md is unreadable (' + (e.code || e.message) + ')'] }); continue; }
    const issues = [];
    const vendoredStyle = [];
    const fm = parseFrontmatter(text);
    if (!fm) { skills.push({ skill: id, issues: ['no frontmatter block (--- ... ---) at the top of SKILL.md'] }); continue; }
    if (!fm.name) issues.push('no name in the frontmatter');
    if (!fm.description) issues.push('no description in the frontmatter');
    const vendored = detectVendorPin(text);
    if (fm.description && fm.description.length > SKILL_DESCRIPTION_MAX_CHARS) (vendored ? vendoredStyle : issues).push('description is ' + fm.description.length + ' chars (max ' + SKILL_DESCRIPTION_MAX_CHARS + ')');
    const block = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text) || [])[1] || '';
    const line = block.split(/\r?\n/).find((l) => /^description:/.test(l));
    if (line) for (const i of skillDescriptionIssues(line.replace(/^description:/, ''))) issues.push(i);
    // WP 1.9: when_to_use is listed next to the description, so the same quoting rule applies and the two together
    // must fit the listing entry; the on/off switches must be real booleans.
    const wtuLine = block.split(/\r?\n/).find((l) => /^when_to_use:/.test(l));
    if (wtuLine) for (const i of skillDescriptionIssues(wtuLine.replace(/^when_to_use:/, ''), 'when_to_use')) issues.push(i);
    const listed = frontmatterScalarText(fm.description).length + frontmatterScalarText(fm.when_to_use).length;
    if (listed > SKILL_LISTING_ENTRY_MAX_CHARS) (vendored ? vendoredStyle : issues).push('description + when_to_use is ' + listed + ' chars (max ' + SKILL_LISTING_ENTRY_MAX_CHARS + ', where Claude Code cuts the listing entry)');
    for (const key of SKILL_BOOLEAN_KEYS) {
      if (fm[key] === undefined) continue;
      const val = fm[key].replace(/\s+#.*$/, '');
      if (val !== 'true' && val !== 'false') issues.push(key + ' is ' + (val ? JSON.stringify(val.slice(0, 40)) : 'empty') + ' — it must be true or false (unquoted, lowercase), otherwise Claude Code does not read it as a switch');
    }
    const conflict = skillInvocationConflict(fm); // SA-P1-SKILLS (a)
    if (conflict) issues.push(conflict);
    const entry = { skill: id, issues };
    const mismatch = skillNameMismatch(id, fm); // SA-P1-SKILLS (c): a warning, never an issue
    if (mismatch) { entry.warnings = [mismatch]; warnings.push(id + ': ' + mismatch); }
    if (vendored && vendoredStyle.length) entry.vendored_style = vendoredStyle;
    skills.push(entry);
  }
  const hasCatalog = fs.existsSync(path.join(cd, 'config', 'orchestration', 'domain-catalog.json'));
  let catalog = { applicable: hasCatalog, checked: false, uncatalogued: [], reason: '' };
  let Q = null;
  try { Q = o.qualityModule !== undefined ? o.qualityModule : require(path.join(cd, 'forge-bin', 'forge-quality.cjs')); } catch { Q = null; }
  if (!hasCatalog) catalog.reason = 'no domain-catalog.json here (nothing to catalogue against)';
  else if (Q && typeof Q.catalogDrift === 'function') {
    try {
      const seam = (Q.catalogDrift(root).seams || []).find((s) => s.seam === 'router-playbooks') || {};
      catalog = { applicable: true, checked: true, uncatalogued: seam.extra_in_seam || [], domains_without_playbook: seam.missing_in_seam || [], reason: '' };
      for (const sk of catalog.uncatalogued) {
        const e = skills.find((s) => s.skill === sk) || (skills.push({ skill: sk, issues: [] }), skills[skills.length - 1]);
        e.issues.push('forge-* skill that is neither a domain playbook in domain-catalog.json nor listed in its non_domain_skills — the router cannot place it; add it to one of the two');
      }
    } catch (e) { catalog = { applicable: true, checked: false, uncatalogued: [], reason: 'forge-quality catalogDrift threw: ' + e.message }; }
  } else catalog.reason = 'forge-quality.cjs is missing or does not load, so the catalog rule could not run';
  const failing = skills.filter((s) => s.issues.length);
  const catalogBroken = dev && catalog.applicable && !catalog.checked; // fail-closed, like quality_catalog (F-09)
  // SA-P1-SKILLS (b): enabled plugins whose install is gone. Runs for this doctor's own project root (the machine it
  // runs on) or with an explicit opts.claudeHome (tests); a fixture root never reads the real machine's plugins.
  let plugins;
  if (o.claudeHome || isOwnProjectRoot(root)) {
    try { plugins = pluginInstallCheck({ claudeHome: o.claudeHome }); } catch (e) { plugins = { ok: false, applicable: true, enabled: [], missing: [], disabled_stale: [], warnings: [], reason: 'plugin install check threw: ' + e.message }; }
  } else plugins = { ok: true, applicable: false, enabled: [], missing: [], disabled_stale: [], warnings: [], reason: 'not this doctor\'s own project root — machine plugins not checked' };
  const pluginsBroken = plugins.applicable && !plugins.ok;
  const ok = dev ? failing.length === 0 && !catalogBroken && !pluginsBroken : true;
  const reason = failing.length
    ? failing.length + ' skill(s) with frontmatter/catalog problems: ' + failing.slice(0, 6).map((s) => s.skill + ' (' + s.issues[0].split(' — ')[0] + ')').join('; ') + (failing.length > 6 ? '; +' + (failing.length - 6) + ' more' : '')
    : (catalogBroken ? catalog.reason : '');
  const baseReason = (catalogBroken && failing.length ? reason + ' · ' + catalog.reason : reason) + (!dev && failing.length ? ' (not enforced outside the development tree — fix it anyway: Claude Code cannot read these descriptions)' : '');
  return {
    ok, applicable: dev, enforced: dev, checked: skills.length, failing: failing.map((s) => s.skill), skills, catalog, warnings, plugins,
    reason: pluginsBroken ? (baseReason ? baseReason + ' · ' : '') + plugins.reason + (dev ? '' : ' (not enforced outside the development tree)') : baseReason,
    ms: Date.now() - t0,
  };
}

module.exports = {
  DIST_REPO_MARKERS, looksLikeDistRepo, releaseExclusionsCheck, shipManifestCheck, FEATURE_REGISTRY_FIX,
  featureRegistryCheck, skillDescriptionIssues, SKILL_LISTING_ENTRY_MAX_CHARS, SKILL_BOOLEAN_KEYS,
  frontmatterScalarText, skillFrontmatterCheck,
  // SA-P1-SKILLS: the A7 invocation guard, the name/folder warning and the enabled-plugin install guard
  SKILL_TRIGGER_PHRASE_RE, SKILL_USER_ONLY_RE, skillInvocationConflict, skillNameMismatch, pluginInstallCheck, isOwnProjectRoot,
};
