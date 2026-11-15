'use strict';
/**
 * doctor/checks-advisory.cjs — one module of forge-doctor.cjs (WP A11 part 2): scribe_wiring, unpublished, structure, always_loaded_budget, plugin_validate, skill/agent lint, config_scan, harness_score, run_liveness.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const {
  agentLintTool, claudeDir, configScanTool, harnessScoreTool, regGenTool, relPosix, runsDirOf, runwatchTool,
  shipcheckTool, skillLintTool, stateReadDir, stateWriteDir, syncTool,
} = require('./context.cjs');
const { readDevTreeMarker } = require('./checks-hygiene.cjs');
const { cleanLines, resolveOnPath, spawnResolved } = require('./checks-setup.cjs');

/** scribeWiring(root) — ADVISORY. Where forge-scribe.cjs exists: both scribe hooks are in .claude/settings.json
 *  (UserPromptSubmit -> forge-scribe-hook.cjs, Stop -> forge-scribe-stop.cjs), FORGE_SCRIBE.json parses, the
 *  hash chains verify when a ledger exists (forge-scribe verifyChains, read-only), and .claude/forge-scribe/ is
 *  gitignored (owner prompts, verbatim, must never be committed). */
function scribeWiring(root, opts) {
  const o = opts || {};
  const cd = claudeDir(root);
  const bin = path.join(cd, 'forge-bin');
  if (!fs.existsSync(path.join(bin, 'forge-scribe.cjs'))) return { ok: true, applicable: false, problems: [], notes: [], reason: 'forge-scribe.cjs is not installed here' };
  const problems = [], notes = [];
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(cd, 'settings.json'), 'utf8')); } catch (e) { problems.push('.claude/settings.json does not load (' + (e.code || e.message) + '), so the scribe hooks cannot be confirmed'); }
  const hookHas = (event, file) => {
    const groups = settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    return groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(file)));
  };
  if (settings) {
    if (!hookHas('UserPromptSubmit', 'forge-scribe-hook.cjs')) problems.push('no UserPromptSubmit hook runs forge-scribe-hook.cjs: owner prompts are not captured');
    if (!hookHas('Stop', 'forge-scribe-stop.cjs')) problems.push('no Stop hook runs forge-scribe-stop.cjs: open owner requests never block a stop');
  }
  const cfgPath = path.join(cd, 'config', 'orchestration', 'FORGE_SCRIBE.json');
  try { JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { problems.push('config/orchestration/FORGE_SCRIBE.json ' + (e.code === 'ENOENT' ? 'is missing' : 'does not parse (' + String(e.message).split('\n')[0] + ')')); }
  const storeDir = stateReadDir(root, 'scribe', 'forge-scribe'); // WP 2.1: where the scribe store is (.forge/scribe once it exists)
  if (fs.existsSync(path.join(storeDir, 'ledger.jsonl')) || fs.existsSync(path.join(storeDir, 'inbox.jsonl'))) {
    try {
      const scribe = o.scribeModule || require(path.join(bin, 'forge-scribe.cjs'));
      const v = scribe.verifyChains({ root });
      if (!v.ok) problems.push('forge-scribe verify-chain: BROKEN (inbox ' + (v.inbox && v.inbox.ok ? 'ok' : 'broken') + ', ledger ' + (v.ledger && v.ledger.ok ? 'ok' : 'broken') + ') — run node .claude/forge-bin/forge-scribe.cjs verify-chain');
      else notes.push('verify-chain OK (inbox ' + v.inbox.lines + ' line(s), ledger ' + v.ledger.lines + ' line(s))');
    } catch (e) { problems.push('forge-scribe verify-chain could not run: ' + String(e.message).split('\n')[0]); }
  } else notes.push('no scribe ledger yet (nothing captured in this project)');
  // WP 2.1 (R7): the store the scribe WRITES to must be ignored: .claude/forge-scribe/ in a legacy project, .forge/scribe/
  // once the project uses the .forge/ state root (then a legacy store that still exists is checked as well).
  const scribeDirs = [stateWriteDir(root, 'scribe', 'forge-scribe')];
  const legacyScribe = path.join(cd, 'forge-scribe');
  if (relPosix(root, scribeDirs[0]) !== relPosix(root, legacyScribe) && fs.existsSync(legacyScribe)) scribeDirs.push(legacyScribe);
  for (const dir of scribeDirs) {
    const rel = relPosix(root, dir);
    const gi = (o.spawnSyncImpl || spawnSync)('git', ['check-ignore', '-q', '--no-index', rel + '/inbox.jsonl'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    if (gi.status === 1) problems.push(rel + '/ is NOT gitignored: verbatim owner prompts could be committed — add `' + rel + '/` to .gitignore');
    else if (gi.status !== 0) notes.push('could not ask git whether ' + rel + '/ is ignored (' + (gi.error ? gi.error.message : 'exit ' + gi.status) + ')');
  }
  return { ok: problems.length === 0, applicable: true, problems, notes, reason: problems.join(' · ') };
}

/** unpublishedCheck(root) — ADVISORY, ALWAYS ok:true. In the development tree only: forge-sync.cjs
 *  verifyPublishTemplate({devDir, templateDir}) (read-only, local files + git, never network) compares the central
 *  template (~/.claude/forge/template/.claude) with what this tree would publish. A difference is reported as
 *  "UNPUBLISHED (template): ..." with the fix command; a missing template is a skip, never a finding. */
function unpublishedCheck(root, opts) {
  const o = opts || {};
  if (!readDevTreeMarker(root).valid) return { ok: true, applicable: false, reason: 'not the development tree — nothing is published from here' };
  const tool = o.syncTool !== undefined ? o.syncTool : syncTool;
  if (!tool || typeof tool.verifyPublishTemplate !== 'function') return { ok: true, applicable: false, reason: 'forge-sync.cjs verifyPublishTemplate is not available here' };
  const templateDir = o.templateDir || (typeof tool.defaultRealTemplateDir === 'function' ? tool.defaultRealTemplateDir() : path.join(os.homedir(), '.claude', 'forge', 'template', '.claude'));
  if (!fs.existsSync(templateDir)) return { ok: true, applicable: false, reason: 'no central template at ' + templateDir + ' — skipped' };
  const fix = 'node .claude/forge-bin/forge-sync.cjs publish-template --plan (then --apply in an owner-approved window)';
  let v;
  try { v = tool.verifyPublishTemplate({ devDir: claudeDir(root), templateDir }); } catch (e) { return { ok: true, applicable: true, verified: false, reason: 'could not verify the template: ' + e.message }; }
  if (v.error) return { ok: true, applicable: true, verified: false, reason: 'could not verify the template: ' + v.error };
  if (v.ok) return { ok: true, applicable: true, verified: true, unpublished: false, reason: 'the central template holds exactly what this tree publishes', warnings: v.warnings || [] };
  const diffs = (v.differences || []).map((d) => ({ kind: d.kind, count: (d.paths || []).length, paths: (d.paths || []).slice(0, 10), detail: d.detail || null }));
  return { ok: true, applicable: true, verified: true, unpublished: true, differences: diffs, warnings: v.warnings || [], fix, template_dir: templateDir,
    summary: 'UNPUBLISHED (template): ' + diffs.map((d) => d.kind + (d.count ? ' ' + d.count : '')).join(', ') + ' — fix: ' + fix };
}

/** structureCheck(root) — ADVISORY, development tree only (a user project's root and tool set are its own).
 *  Reuses forge-registry-gen.cjs buildReport(): tools without a <tool>.test.cjs sibling; source files over 800
 *  lines (tests and JSON excluded) that are not in FORGE_FEATURE_REGISTRY.json structure.size_allowlist; README
 *  tool-table rows vs tools on disk (local-only maintainer tools are not expected there); FORGE_SKILL_REGISTRY.md
 *  rows vs skills on disk; root clutter = a root file no root-level FORGE_SHIP_MANIFEST.json pattern names; and a
 *  repository without a git remote (nothing reaches GitHub). */
function structureCheck(root, opts) {
  const o = opts || {};
  if (!readDevTreeMarker(root).valid) return { ok: true, applicable: false, reason: 'not the development tree — the structure rules describe the Forge source tree' };
  const gen = o.regGen !== undefined ? o.regGen : regGenTool;
  if (!gen || typeof gen.buildReport !== 'function') return { ok: true, applicable: false, reason: 'forge-registry-gen.cjs is not available here' };
  let rep;
  try { rep = gen.buildReport(root); } catch (e) { return { ok: true, applicable: false, reason: 'buildReport threw: ' + e.message }; }
  let allow = [];
  try { const r = JSON.parse(fs.readFileSync(path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_FEATURE_REGISTRY.json'), 'utf8')); allow = (r.structure && Array.isArray(r.structure.size_allowlist)) ? r.structure.size_allowlist : []; } catch { allow = []; }
  const oversize = rep.oversize.files.filter((f) => !/\.test\.cjs$/.test(f.file) && !/\.json$/.test(f.file) && !allow.includes(f.file));
  let rules = null;
  const manifestPath = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
  if (shipcheckTool && fs.existsSync(manifestPath)) { const lm = shipcheckTool.loadManifest(manifestPath); if (!lm.errors.length) rules = lm.rules; }
  const classOf = (p) => (rules && shipcheckTool ? (shipcheckTool.classify(rules, p) || {}).class : null);
  const readmeMissing = rep.tools.missing_from_readme.filter((t) => classOf('.claude/forge-bin/' + t) !== 'local-only');
  let rootClutter = [], rootNote = '';
  if (rules) {
    const en = shipcheckTool.enumerateSource(root, o.files ? { files: o.files } : undefined);
    const rootRules = rules.filter((r) => typeof r.pattern === 'string' && !r.pattern.replace(/\{[^}]*\}/g, '').includes('/'));
    if (en.files) rootClutter = en.files.filter((f) => !f.includes('/') && !rootRules.some((r) => r.re.test(f))).sort();
    else rootNote = 'could not list the root (' + en.error + ')';
  } else rootNote = 'no loadable FORGE_SHIP_MANIFEST.json, root clutter not judged';
  const rem = (o.spawnSyncImpl || spawnSync)('git', ['remote'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const noRemote = rem.status === 0 && !String(rem.stdout || '').trim();
  const findings = {
    tools_without_test: rep.tools.without_test, oversize: oversize.map((f) => f.file + ' (' + f.lines + ')'),
    readme_missing: readmeMissing, readme_extra: rep.tools.extra_in_readme,
    skill_registry_missing: rep.skills.missing_from_registry, skill_registry_extra: rep.skills.extra_in_registry,
    root_clutter: rootClutter, no_remote: noRemote,
  };
  const ok = Object.entries(findings).every(([, v]) => (Array.isArray(v) ? v.length === 0 : !v));
  return { ok, applicable: true, findings, allowlisted_oversize: rep.oversize.files.filter((f) => allow.includes(f.file)).length, notes: rootNote ? [rootNote] : [], remote_probe: rem.status === 0 ? 'ok' : 'git remote failed (' + (rem.error ? rem.error.message : 'exit ' + rem.status) + ')' };
}

function advisorySafe(id, fn) {
  try { return fn(); } catch (e) { return { ok: true, applicable: false, reason: id + ' could not run: ' + String((e && e.message) || e).split('\n')[0] }; }
}

/** alwaysLoadedBudget(root) — ADVISORY. The two always-loaded instruction cores stay within 's budget
 *  (mirrors forge-wp11-coverage.test.cjs CORE_BYTE_BUDGET); the current sizes are reported on every run. */
const ALWAYS_LOADED_BUDGET_BYTES = 16384;
const ALWAYS_LOADED_FILES = ['.claude/commands/forge.md', '.claude/skills/forge-router/SKILL.md'];
function alwaysLoadedBudget(root) {
  const files = ALWAYS_LOADED_FILES.map((rel) => {
    let bytes = null;
    try { bytes = fs.statSync(path.join(root, ...rel.split('/'))).size; } catch { bytes = null; }
    return { file: rel, bytes, over: bytes != null && bytes > ALWAYS_LOADED_BUDGET_BYTES };
  });
  const present = files.filter((f) => f.bytes != null);
  if (!present.length) return { ok: true, applicable: false, budget: ALWAYS_LOADED_BUDGET_BYTES, files, reason: 'neither always-loaded core exists here' };
  return { ok: !present.some((f) => f.over), applicable: true, budget: ALWAYS_LOADED_BUDGET_BYTES, files };
}

/** globalForgeHandover(root, opts) — ADVISORY (category tests F8). Claude Code runs the personal
 *  ~/.claude/commands/forge.md instead of this project's own .claude/commands/forge.md; unless the global file hands
 *  over first, /forge here runs without router, Bosses, run or memory. Applies only when both files exist.
 *  opts: { home } (the folder holding commands/forge.md; default ~/.claude) so the test needs no real home. */
function globalForgeHandover(root, opts) {
  const home = (opts && opts.home) || path.join(require('os').homedir(), '.claude');
  const globalFile = path.join(home, 'commands', 'forge.md');
  if (!fs.existsSync(path.join(root, '.claude', 'commands', 'forge.md'))) return { ok: true, applicable: false, reason: 'this project has no /forge command of its own' };
  if (!fs.existsSync(globalFile)) return { ok: true, applicable: false, reason: 'no global /forge command (nothing shadows the project one)' };
  let H;
  try { H = require('../forge-global-handover.cjs'); } catch { return { ok: true, applicable: false, reason: 'forge-global-handover.cjs is not installed here' }; }
  const problems = H.handoverProblems(fs.readFileSync(globalFile, 'utf8'));
  return problems.length
    ? { ok: false, applicable: true, file: globalFile, problems, fix: 'put the Step 0 handover (read and follow .claude/commands/forge.md with $ARGUMENTS) first in ' + globalFile }
    : { ok: true, applicable: true, file: globalFile };
}

/** globalDrift(root, opts) — ADVISORY, development tree only (FB-INSTALL-2-F2 / CORE-5-F4). Compares the live ~/.claude
 *  files Forge depends on with the captured copies in global-install/ (forge-global-drift.cjs report()) and names the
 *  live_drift / copy_changed files and the allow-listed live files no capture covers. n/a on CI, outside the dev tree,
 *  without ~/.claude or without global-install/manifest.json. opts.home / opts.devTree / opts.env are test seams. Never red. */
function globalDrift(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (env.CI) return { ok: true, applicable: false, reason: 'CI: there is no live ~/.claude to compare' };
  if (!(o.devTree !== undefined ? o.devTree : readDevTreeMarker(root).valid)) return { ok: true, applicable: false, reason: 'not the development tree — global-install/ is kept only there' };
  const home = o.home || path.join(require('os').homedir(), '.claude');
  if (!fs.existsSync(home)) return { ok: true, applicable: false, reason: 'no ~/.claude folder on this machine' };
  if (!fs.existsSync(path.join(root, 'global-install', 'manifest.json'))) return { ok: true, applicable: false, reason: 'no global-install/manifest.json (nothing captured yet)' };
  const rep = require('../forge-global-drift.cjs').report({ root, home });
  const of = (s) => rep.entries.filter((e) => String(e.status).split('+').includes(s)).map((e) => String(e.live || e.path).split('\\').join('/').replace(/^.*?\.claude\//, ''));
  const liveDrift = of('live_drift'), copyChanged = of('copy_changed');
  const out = { ok: rep.ok, applicable: true, counts: rep.counts, live_drift: liveDrift, copy_changed: copyChanged, uncovered: rep.uncovered };
  if (!rep.ok) {
    out.reason = [liveDrift.length && liveDrift.length + ' live file(s) differ from the capture: ' + liveDrift.slice(0, 6).join(', '),
      copyChanged.length && copyChanged.length + ' captured copy(ies) edited: ' + copyChanged.slice(0, 6).join(', '),
      rep.uncovered.length && rep.uncovered.length + ' allow-listed live file(s) not captured: ' + rep.uncovered.slice(0, 6).join(', ')].filter(Boolean).join(' · ');
    out.fix = 'node .claude/forge-bin/forge-global-drift.cjs (report), then the same with --capture once the live files are the intended ones';
  }
  return out;
}

/** newestWorkRun(root, opts) -> {runId, lastWorkAt} of the newest run with real work (forge-snapshot.cjs pickRun, the
 *  doctor's own run ranker), or {runId:null}. opts.pickRun is a test seam. */
function newestWorkRun(root, opts) {
  const pick = (opts && opts.pickRun) || ((r) => require('../forge-snapshot.cjs').pickRun(r));
  const sel = pick(root) || {};
  const row = Array.isArray(sel.considered) ? sel.considered.find((c) => c && c.name === sel.runId) : null;
  return { runId: sel.runId || null, lastWorkAt: (row && row.lastWorkAt) || null };
}

/** rollbackCheckpoint(root, opts) — ADVISORY (FB-INSTALL-1-F1). The newest work run has a per-run rollback
 *  checkpoint record (forge-rollback.cjs list), so a bad run can be rolled back. n/a without a run or without git.
 *  opts.pickRun / opts.list are test seams. Never red. */
function rollbackCheckpoint(root, opts) {
  const o = opts || {};
  const { runId } = newestWorkRun(root, o);
  if (!runId) return { ok: true, applicable: false, reason: 'no run with real work yet' };
  let records;
  try { records = (o.list || ((r) => require('../forge-rollback.cjs').list({ root: r })))(root); }
  catch (e) { return { ok: true, applicable: false, reason: 'rollback records cannot be read here: ' + String((e && e.message) || e).split('\n')[0] }; }
  const n = Array.isArray(records) ? records.length : 0;
  if (n && records.some((r) => r && r.run_id === runId)) return { ok: true, applicable: true, run: runId, checkpoints: n };
  return { ok: false, applicable: true, run: runId, checkpoints: n, reason: 'the newest run ' + runId + ' has no rollback checkpoint record (' + n + ' checkpoint(s) in this project)',
    fix: 'node .claude/forge-bin/forge-rollback.cjs checkpoint --run ' + runId + ' right after the /forge git checkpoint commit (commands/forge.md setup row)' };
}

/** memoryStatusFresh(root, opts) — ADVISORY (CORE-5-F2). CLAUDE.md sends every session to the newest status
 *  block of .claude/FORGE_MEMORY.md; warn when that block is dated before the day of the newest run with real work, so
 *  a session does not resume from a state that no longer exists. opts.memoryText (null = no file) / opts.pickRun are
 *  test seams. Never red. */
function memoryStatusFresh(root, opts) {
  const o = opts || {};
  let text = o.memoryText;
  if (text === undefined) { try { text = fs.readFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), 'utf8'); } catch { text = null; } }
  if (typeof text !== 'string') return { ok: true, applicable: false, reason: 'no .claude/FORGE_MEMORY.md' };
  const block = require('../forge-run-file.cjs').latestStatusBlock(text);
  if (!block) return { ok: true, applicable: false, reason: 'FORGE_MEMORY.md has no "## Status <date>" block' };
  const { runId, lastWorkAt } = newestWorkRun(root, o);
  const workDay = String(lastWorkAt || '').slice(0, 10) || ((/(\d{4}-\d{2}-\d{2})/.exec(String(runId || '')) || [])[1] || '');
  if (!runId || !workDay) return { ok: true, applicable: false, reason: 'no run with real work to compare against' };
  const blockDay = block.key.slice(0, 10);
  if (blockDay >= workDay) return { ok: true, applicable: true, status_block: blockDay, run: runId };
  return { ok: false, applicable: true, status_block: blockDay, run: runId,
    reason: 'the newest FORGE_MEMORY.md status block is dated ' + blockDay + ', before the newest work run ' + runId + ' (' + workDay + '): a resume would read a past state',
    fix: 'append a current status block with node .claude/forge-bin/forge-run-file.cjs append (FORGE_MEMORY.md), then regenerate the snapshot' };
}

/** configConsumers(root, opts) — ADVISORY (CF-3-F4). Every `.claude/forge-bin/<x>.cjs` consumer the config
 *  schema names (unless marked "prose only") must mention its setting: the full key or its last dotted part, in the file
 *  itself or in a sibling it requires with require('./y.cjs'). A consumer that never mentions its key behaves the same
 *  with the setting off, so "off" would be a promise only. opts.schema is a test seam (null = no schema). Never red. */
function configConsumers(root, opts) {
  const o = opts || {};
  let schema = o.schema;
  if (schema === undefined) { try { schema = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8')); } catch { schema = null; } }
  if (!schema || !schema.settings) return { ok: true, applicable: false, reason: 'no readable FORGE_CONFIG_SCHEMA.json' };
  const bin = path.join(root, '.claude', 'forge-bin');
  const textOf = (f) => { try { return fs.readFileSync(path.join(bin, f), 'utf8'); } catch { return null; } };
  const unread = [];
  let checked = 0;
  for (const [key, spec] of Object.entries(schema.settings)) {
    for (const c of (spec && Array.isArray(spec.consumers)) ? spec.consumers : []) {
      const m = /^\.claude\/forge-bin\/([\w.-]+\.cjs)\b/.exec(String(c));
      if (!m || /prose only/i.test(c)) continue;
      checked++;
      const own = textOf(m[1]);
      if (own === null) { unread.push(key + ' -> .claude/forge-bin/' + m[1] + ' (file missing)'); continue; }
      const sibs = [...own.matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.cjs)?['"]\s*\)/g)].map((x) => textOf(x[1] + '.cjs')).filter((t) => t !== null);
      const words = [key, key.split('.').pop()];
      if (![own, ...sibs].some((t) => words.some((w) => t.includes(w)))) unread.push(key + ' -> .claude/forge-bin/' + m[1]);
    }
  }
  const out = { ok: !unread.length, applicable: true, checked, unread };
  if (unread.length) {
    out.reason = unread.length + ' code consumer(s) never mention their setting: ' + unread.slice(0, 6).join(', ');
    out.fix = 'read the setting in that tool (forge-config.cjs get / safeGet), or mark the consumer "(prose only: ...)" in FORGE_CONFIG_SCHEMA.json';
  }
  return out;
}

/** reportStatusEnum(root, opts) — ADVISORY (SK-8-F1). Every "status": "..." line in a .claude/agents/*.md
 *  report template uses only forge-report.cjs REQUIRED_STATUSES, and a template that lists several values (a | b) lists
 *  exactly that set: a Boss that ends with a status the ingest rejects is a report the dashboard never shows.
 *  opts.required is a test seam. n/a without an agents folder or a readable REQUIRED_STATUSES. Never red. */
function reportStatusEnum(root, opts) {
  const o = opts || {};
  let required = o.required;
  if (!required) { try { required = require(path.join(claudeDir(root), 'forge-bin', 'forge-report.cjs')).REQUIRED_STATUSES; } catch { required = null; } }
  if (!Array.isArray(required) || !required.length) return { ok: true, applicable: false, reason: 'forge-report.cjs REQUIRED_STATUSES is not readable here' };
  const dir = path.join(claudeDir(root), 'agents');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch { return { ok: true, applicable: false, reason: 'no .claude/agents folder' }; }
  const want = required.slice().sort().join('|');
  const mismatched = [];
  let checked = 0;
  for (const n of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/"status":\s*"([^"]+)"/g)) {
      checked++;
      const vals = m[1].split('|').map((v) => v.trim()).filter(Boolean);
      const bad = vals.some((v) => !required.includes(v)) || (vals.length > 1 && vals.slice().sort().join('|') !== want);
      if (bad) mismatched.push({ file: '.claude/agents/' + n, status: m[1] });
    }
  }
  const out = { ok: !mismatched.length, applicable: true, checked, required, mismatched };
  if (mismatched.length) {
    out.reason = mismatched.length + ' report template(s) use a status forge-report.cjs rejects or a partial list: ' + mismatched.slice(0, 6).map((m) => m.file + ' "' + m.status + '"').join(', ');
    out.fix = 'set the template line to "status": "' + required.join(' | ') + '" (forge-report.cjs REQUIRED_STATUSES)';
  }
  return out;
}

/** hooksDocumented(root) — ADVISORY (CF-2-F3). Every hook script the project settings.json runs is named
 *  in .claude/config/orchestration/HOOKS_OPT_IN.md or .claude/docs/HOOKS_OPT_IN.md, so an owner who wants to audit or
 *  switch off a hook finds its purpose and off switch. n/a without a readable settings file. Never red. */
function hooksDocumented(root) {
  const cd = claudeDir(root);
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(cd, 'settings.json'), 'utf8')); } catch { return { ok: true, applicable: false, reason: 'no readable .claude/settings.json' }; }
  const scripts = new Set();
  for (const groups of Object.values((settings && settings.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && Array.isArray(g.hooks)) ? g.hooks : []) {
        for (const m of String((h && h.command) || '').matchAll(/[\w.-]+\.(?:cjs|mjs|js|ps1|cmd|sh|py)\b/g)) scripts.add(m[0]);
      }
    }
  }
  const docs = [path.join(cd, 'config', 'orchestration', 'HOOKS_OPT_IN.md'), path.join(cd, 'docs', 'HOOKS_OPT_IN.md')]
    .map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }).join('\n');
  const undocumented = [...scripts].sort().filter((n) => !docs.includes(n));
  const out = { ok: !undocumented.length, applicable: true, checked: scripts.size, undocumented };
  if (undocumented.length) {
    out.reason = undocumented.length + ' hook script(s) in .claude/settings.json named in neither HOOKS_OPT_IN.md: ' + undocumented.join(', ');
    out.fix = 'add a row (event, matcher, script, purpose, off switch) to the inventory table in .claude/config/orchestration/HOOKS_OPT_IN.md';
  }
  return out;
}

/** systemSkillFresh(root) — ADVISORY (SK-1-F2). Runs forge-system-skill.cjs check on this root: the
 *  generated forge-system skill must match its sources, have no dead path reference and no secret pattern (this
 *  doctor's own copy of the tool, so a fixture root needs only its sources). n/a without the generated skill. Never red. */
function systemSkillFresh(root) {
  if (!fs.existsSync(path.join(claudeDir(root), 'skills', 'forge-system', 'SKILL.md'))) return { ok: true, applicable: false, reason: 'no generated .claude/skills/forge-system skill' };
  const r = require('../forge-system-skill.cjs').check({ root });
  const out = { ok: !!r.ok, applicable: true, stale: r.stale, dead_refs: r.deadRefs.map((d) => d.ref + ' in ' + d.file), secrets: r.secrets.length };
  if (!r.ok) {
    out.reason = [r.stale.length && r.stale.length + ' stale file(s): ' + r.stale.join(', '),
      r.deadRefs.length && r.deadRefs.length + ' dead path reference(s): ' + out.dead_refs.slice(0, 4).join(', '),
      r.secrets.length && r.secrets.length + ' secret pattern(s)'].filter(Boolean).join(' · ');
    out.fix = 'node .claude/forge-bin/forge-system-skill.cjs generate (then check again; a dead ref or secret is fixed in its source)';
  }
  return out;
}

/** scheduledTasks(root, opts) — ADVISORY (FB-MISC-2-F7). The scheduled tasks forge-killswitch.cjs KNOWN_TASKS
 *  names (the monthly sweep, the Command Center supervisor) are registered on this machine. Windows and the
 *  development tree only (the tasks are this machine's), never in CI. Re-registering is an owner action. A failed
 *  lookup is n/a, never red. opts: platform, devTree, env, known, listTasks (test seams). */
function scheduledTasks(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if ((o.platform || process.platform) !== 'win32') return { ok: true, applicable: false, reason: 'scheduled tasks are only checked on Windows' };
  if (env.CI) return { ok: true, applicable: false, reason: 'CI: no owner scheduled tasks to check' };
  if (!(o.devTree !== undefined ? o.devTree : readDevTreeMarker(root).valid)) return { ok: true, applicable: false, reason: 'not the development tree' };
  let known = o.known, listTasks = o.listTasks;
  if (!known || !listTasks) {
    let K = null;
    try { K = require(path.join(claudeDir(root), 'forge-bin', 'forge-killswitch.cjs')); } catch (e) { return { ok: true, applicable: false, reason: 'forge-killswitch.cjs does not load (' + String(e.message).split('\n')[0] + ')' }; }
    known = known || K.KNOWN_TASKS;
    listTasks = listTasks || K.listTasksWindows;
  }
  let tasks;
  try { tasks = listTasks() || []; } catch (e) { return { ok: true, applicable: false, reason: 'the scheduled-task lookup failed: ' + String((e && e.message) || e).split('\n')[0] }; }
  const names = new Set(tasks.map((t) => String((t && t.name) || '').replace(/^\\+/, '').toLowerCase()));
  const missing = known.filter((k) => !names.has(String(k).toLowerCase()));
  const out = { ok: !missing.length, applicable: true, known, missing };
  if (missing.length) {
    out.reason = missing.length + ' scheduled task(s) named in forge-killswitch.cjs KNOWN_TASKS are not registered on this machine: ' + missing.join(', ');
    out.fix = 'owner action: re-register the task (see the header of .claude/forge-bin/maand-sweep.cmd or start-command-center.cmd), or remove it from KNOWN_TASKS and the notes when it was retired on purpose';
  }
  return out;
}

/** referenceFit(root) — ADVISORY (CORE-3-F2 / CORE-3-F9). (1) every `.claude/forge-bin/<x>.cjs` a file under
 *  global-install/payload names exists in .claude/forge-bin itself (a tool only under archive/ is gone for the global
 *  copy); (2) every skill reference file (.claude/skills/**\/references/*.md) fits one Read: at most REFERENCE_MAX_BYTES
 *  (about 25k tokens). n/a when neither folder exists. Never red. */
const REFERENCE_MAX_BYTES = 100000;
function referenceFit(root) {
  const walk = (dir, keep, acc) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p, keep, acc); } else if (keep(p)) acc.push(p);
    }
    return acc;
  };
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const payload = path.join(root, 'global-install', 'payload');
  const skills = path.join(root, '.claude', 'skills');
  if (!fs.existsSync(payload) && !fs.existsSync(skills)) return { ok: true, applicable: false, reason: 'no global-install/payload and no .claude/skills' };
  const missing = [];
  for (const f of walk(payload, (p) => /\.(md|cjs|js|json)$/i.test(p), [])) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const name of new Set([...text.matchAll(/\.claude\/forge-bin\/([\w.-]+\.cjs)\b/g)].map((m) => m[1]))) {
      if (!fs.existsSync(path.join(root, '.claude', 'forge-bin', name))) missing.push(rel(f) + ' -> .claude/forge-bin/' + name);
    }
  }
  const oversized = [];
  for (const f of walk(skills, (p) => /\.md$/i.test(p) && path.basename(path.dirname(p)) === 'references', [])) {
    let size = 0;
    try { size = fs.statSync(f).size; } catch { continue; }
    if (size > REFERENCE_MAX_BYTES) oversized.push({ file: rel(f), bytes: size });
  }
  const out = { ok: !missing.length && !oversized.length, applicable: true, missing_tools: missing, oversized };
  if (!out.ok) {
    out.reason = [missing.length && missing.length + ' payload reference(s) to a missing forge-bin tool: ' + missing.slice(0, 4).join(', '),
      oversized.length && oversized.length + ' skill reference file(s) over ' + REFERENCE_MAX_BYTES + ' bytes (one Read): ' + oversized.slice(0, 4).map((x) => x.file).join(', ')].filter(Boolean).join(' · ');
    out.fix = 'point the payload at the live tool name (or drop the line); split an oversized reference into smaller files';
  }
  return out;
}

/** pluginValidate(root, opts) — ADVISORY (modernization WP 3.7). Runs `claude plugin validate dist/forge-plugin`
 *  when BOTH a built plugin (dist/forge-plugin/.claude-plugin/plugin.json) and the `claude` CLI exist; otherwise
 *  it is n/a with the reason (never red: CI runners and the public tree have no `claude` and no dist/). The CLI's
 *  own exit code is the verdict: 0 = ok, 1 = warn with its first error lines, anything else (timeout, spawn error,
 *  a signal) = n/a "could not run" — a validator that did not finish has not judged the plugin.
 *  opts: { env, platform, spawnImpl(file, args, env, timeoutMs, cwd), timeoutMs } — the spawn is injectable so
 *  the test never needs a real `claude`. Read-only: the CLI only reads the plugin folder. */
const PLUGIN_DIST_REL = 'dist/forge-plugin';
const PLUGIN_VALIDATE_TIMEOUT_MS = 60000;
function pluginValidate(root, opts) {
  const o = opts || {};
  const dist = path.join(root, ...PLUGIN_DIST_REL.split('/'));
  if (!fs.existsSync(path.join(dist, '.claude-plugin', 'plugin.json'))) {
    return { ok: true, applicable: false, status: 'skipped', reason: 'no built plugin at ' + PLUGIN_DIST_REL + ' (build it with `npm run verify:plugin`)' };
  }
  const claude = resolveOnPath('claude', o.env || process.env, o.platform || process.platform);
  if (!claude) return { ok: true, applicable: false, status: 'skipped', reason: 'the claude CLI is not on PATH, plugin not validated' };
  // the RELATIVE path with cwd = root: a fixed literal without spaces, so spawnResolved's verbatim cmd.exe line
  // for a claude.cmd shim needs no quoting (the project root itself may contain spaces).
  const r = (o.spawnImpl || spawnResolved)(claude, ['plugin', 'validate', PLUGIN_DIST_REL], o.env || process.env, o.timeoutMs || PLUGIN_VALIDATE_TIMEOUT_MS, root);
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out after ' + ((o.timeoutMs || PLUGIN_VALIDATE_TIMEOUT_MS) / 1000) + ' s' : (r.error.code || r.error.message)) : 'exit ' + r.status;
    return { ok: true, applicable: false, status: 'could-not-run', reason: '`claude plugin validate` could not run (' + why + ')' };
  }
  if (r.status === 0) return { ok: true, applicable: true, status: 'pass', plugin: PLUGIN_DIST_REL };
  const lines = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), 40).filter((l) => /✘|error|invalid|fail/i.test(l)).slice(0, 3);
  return { ok: false, applicable: true, status: 'fail', plugin: PLUGIN_DIST_REL, errors: lines.length ? lines : ['validation failed (exit 1), run `claude plugin validate ' + PLUGIN_DIST_REL + '` for details'] };
}

/** lintSummary(kind, tool, run) — ADVISORY (skill_lint, agent_lint). Runs a linter in its
 *  report mode and summarises it: ok = no error-level finding; the first errors (or warnings) are named. n/a when the
 *  linter module is absent (an older install) or there is nothing to lint. Never part of doctor.ok. Read-only. */
const LINT_SHOW = 3;
function lintSummary(kind, tool, run) {
  if (!tool) return { ok: true, applicable: false, reason: 'forge-' + kind + 'lint.cjs is not installed here' };
  const rep = run(tool);
  const units = kind === 'skill' ? rep.skills : rep.agents;
  if (!units) return { ok: true, applicable: false, reason: 'no ' + kind + 's to lint' };
  const pick = (lvl) => rep.findings.filter((f) => f.level === lvl).map((f) => f.file + ': ' + f.message);
  const errors = pick('error'), warnings = pick('warn');
  return { ok: errors.length === 0, applicable: true, checked: units, counts: rep.counts, errors: errors.slice(0, LINT_SHOW), warnings: warnings.slice(0, LINT_SHOW), command: 'node .claude/forge-bin/forge-' + kind + 'lint.cjs' };
}
function skillLint(root, opts) { const o = opts || {}; return lintSummary('skill', o.tool !== undefined ? o.tool : skillLintTool, (t) => t.lintSkills(root)); }
function agentLint(root, opts) { const o = opts || {}; return lintSummary('agent', o.tool !== undefined ? o.tool : agentLintTool, (t) => t.lintAgents(root)); }

/** configScan(root, opts) — ADVISORY (wired in package 2.9e). forge-config-scan.cjs's read-only
 *  scanConfig() in-process, summarised like lintSummary: ok = no error-level finding; the first errors (or warnings)
 *  are named as file:line rule (never a secret's value: the scanner itself masks it). n/a when the scanner module is
 *  absent or it found no configuration file to read. Never part of doctor.ok. A throw propagates to advisorySafe. */
function configScan(root, opts) {
  const o = opts || {};
  const tool = o.tool !== undefined ? o.tool : configScanTool;
  if (!tool) return { ok: true, applicable: false, reason: 'forge-config-scan.cjs is not installed here' };
  const rep = tool.scanConfig(root);
  const files = (rep.files_scanned || []).length;
  if (!files) return { ok: true, applicable: false, reason: 'no Claude configuration files to scan' };
  const pick = (lvl) => (rep.findings || []).filter((f) => f.level === lvl).map((f) => f.file + ':' + f.line + ' ' + f.rule);
  const errors = pick('error'), warnings = pick('warn');
  return { ok: errors.length === 0, applicable: true, checked: files, counts: rep.counts, errors: errors.slice(0, LINT_SHOW), warnings: warnings.slice(0, LINT_SHOW), command: 'node .claude/forge-bin/forge-config-scan.cjs' };
}

/** harnessScore(root, opts) — ADVISORY (wired in package 2.9e). forge-harness-score.cjs's
 *  scoreHarness() in-process, WITHOUT the doctor's own output (no --doctor-json: those checks are not_measured
 *  here, and the line says so). ok mirrors the tool's own `--strict` verdict, so the doctor and the CLI never
 *  disagree: overall >= HARNESS_MIN and no check failed outright. n/a when the module or its rubric is absent, or
 *  no category could be measured. Never part of doctor.ok. Any other throw propagates to advisorySafe. */
const HARNESS_MIN = 7;
function harnessScore(root, opts) {
  const o = opts || {};
  const tool = o.tool !== undefined ? o.tool : harnessScoreTool;
  if (!tool) return { ok: true, applicable: false, reason: 'forge-harness-score.cjs is not installed here' };
  let rep;
  try { rep = tool.scoreHarness(root, o.rubricPath ? { rubricPath: o.rubricPath } : {}); }
  catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    if (/^rubric not found/.test(msg)) return { ok: true, applicable: false, reason: msg };
    throw e;
  }
  if (rep.overall == null) return { ok: true, applicable: false, reason: 'no rubric category could be measured here' };
  const failed = [];
  for (const c of rep.categories || []) for (const ch of c.checks || []) if (ch.status === 'fail') failed.push(ch.id);
  return {
    ok: rep.overall >= HARNESS_MIN && failed.length === 0, applicable: true, overall: rep.overall, min: HARNESS_MIN,
    measured: rep.measured_categories, total: rep.total_categories, failed: failed.slice(0, LINT_SHOW),
    top_actions: (rep.top_actions || []).slice(0, LINT_SHOW).map((a) => a.category + '/' + a.check + ': ' + a.action),
    command: 'node .claude/forge-bin/forge-harness-score.cjs',
  };
}

// ===========================================================================================================
// RUN LIVENESS as a doctor advisory: forge-runwatch.cjs finally runs by itself.
//
// THE CONCRETE FAILURE THIS EXISTS TO CATCH: sat on status "running" for 30+
// hours — a `run_completed` event had been logged and 135 further events followed, but nothing ever compared
// the LEDGER (run.json's `status`) against the EVIDENCE (events.jsonl). forge-runwatch.cjs could answer that
// question exactly, terminal event line included, but it only ever ran when someone asked it to, so nobody
// asked. Wiring it into the doctor — which runs before every ship/handoff — is what makes it automatic.
//
// TWO HONEST WINDOWS, NOT ONE: forge-runwatch's own interactive default is 15 minutes, right for a Lead
// watching a live swarm. That is far too tight for a batch sweep over every historical run — an agent
// legitimately thinking for 20 minutes would be branded dead. LIVENESS_WINDOW_MS below is deliberately much
// wider (6h): well beyond any real single turn, far short of the 30+ hours actually observed. The window is
// an explicit parameter (opts.windowMs) so the test can prove the exclusion of a LIVE run is really about
// elapsed silence and not about that fixture being special.
//
// ADVISORY-ONLY, and it stays that way: a stale ledger is a bookkeeping error to correct by hand, not a
// reason to fail a build. It is reported under report.advisory.run_liveness with its own printSummary line,
// exactly like backfill_continuity.
const LIVENESS_WINDOW_MS = 6 * 60 * 60 * 1000;
// Status values that CLAIM the run is still going. Anything else (completed, done, failed, aborted, absent)
// is a ledger that is not claiming liveness, so there is nothing to contradict — never a finding.
const LIVENESS_RUNNING_STATUSES = new Set(['running', 'in_progress', 'in-progress', 'active', 'dispatched', 'started']);
// WP-DOC-ADV: a finding silent for a week or more is an ABANDONED ledger, not a live problem —
// tagged `abandoned: true` and counted separately in the summary line. Still advisory; no run.json is touched.
const LIVENESS_ABANDONED_MS = 7 * 24 * 60 * 60 * 1000;

/** runLiveness(root, opts) -> {ok, checked, findings, windowMs, reason}
 *  For every run whose run.json CLAIMS to be running, asks forge-runwatch.cjs what the events actually show
 *  and reports the contradictions, each with runwatch's OWN evidence attached (never a re-derived verdict):
 *    finished_but_open  — every started agent has a real terminal event AND the run has been silent past the
 *                         window: the work is provably over, the ledger just never said so. (The silence
 *                         requirement is what keeps a genuinely live run between two waves out of this.)
 *    stalled            — an agent started, never terminated, and has been silent past the window.
 *    no_agent_activity  — events exist but not one agent ever started, and it has been silent past the window.
 *    no_events          — the ledger says running and the run never logged a single event; age is measured
 *                         from run.json's own started_at (falling back to its mtime).
 *  A run directory with no parseable run.json is skipped entirely: nothing there claims to be running, so
 *  there is nothing to contradict. Missing forge-runs directory / missing forge-runwatch degrade to a clean,
 *  explicitly-reasoned ok:true — a fresh project must never produce a fabricated finding. */
function runLiveness(root, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = (Number.isFinite(opts.windowMs) && opts.windowMs > 0) ? opts.windowMs : LIVENESS_WINDOW_MS;
  if (!runwatchTool) return { ok: true, checked: 0, findings: [], windowMs, reason: 'forge-runwatch.cjs module not available (run-liveness check unavailable)' };
  const runsDir = runsDirOf(root);
  let entries;
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); }
  catch { return { ok: true, checked: 0, findings: [], windowMs, reason: 'no forge-runs directory yet' }; }
  const findings = [];
  let checked = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runJsonPath = path.join(runsDir, e.name, 'run.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')); } catch { continue; } // no real ledger -> nothing claims "running"
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const status = String(meta.status == null ? '' : meta.status).trim().toLowerCase();
    if (!LIVENESS_RUNNING_STATUSES.has(status)) continue;
    checked++;
    const st = runwatchTool.watch(e.name, { runsDir, now, stallMs: windowMs });
    if (st == null) {
      let startedAt = Date.parse(meta.started_at || meta.startedAt || '');
      if (!Number.isFinite(startedAt)) { try { startedAt = fs.statSync(runJsonPath).mtimeMs; } catch { startedAt = now; } }
      const silentMs = now - startedAt;
      if (silentMs >= windowMs) {
        findings.push({
          run_id: e.name, status, kind: 'no_events', overall: 'no-events', silent_ms: silentMs, abandoned: silentMs >= LIVENESS_ABANDONED_MS,
          last_event_at: null, counts: null, evidence: [], stalled_agents: [],
          detail: 'run.json says "' + status + '" but this run never logged a single event',
        });
      }
      continue;
    }
    const silentMs = st.lastEventAt == null ? null : (now - st.lastEventAt);
    const silentPastWindow = silentMs == null || silentMs >= windowMs;
    let kind = null, detail = '';
    if (st.overall === 'stalled') {
      kind = 'stalled';
      detail = st.counts.stalled + ' agent(s) started and never reported a terminal event';
    } else if (st.overall === 'done' && silentPastWindow) {
      kind = 'finished_but_open';
      detail = 'every started agent has a real terminal event (' + st.evidence.length + ' proof line(s)) — the work is over, the ledger still says "' + status + '"';
    } else if (st.overall === 'empty' && silentPastWindow) {
      kind = 'no_agent_activity';
      detail = 'events exist but no agent ever started';
    }
    if (!kind) continue;
    findings.push({
      run_id: e.name, status, kind, overall: st.overall, silent_ms: silentMs,
      abandoned: silentMs != null && silentMs >= LIVENESS_ABANDONED_MS, last_event_at: st.lastEventAt,
      counts: st.counts, evidence: st.evidence, stalled_agents: st.stalledAgents, detail,
    });
  }
  return { ok: findings.length === 0, checked, findings, windowMs, reason: '' };
}

module.exports = {
  scribeWiring, unpublishedCheck, structureCheck, advisorySafe, ALWAYS_LOADED_BUDGET_BYTES, ALWAYS_LOADED_FILES,
  alwaysLoadedBudget, globalForgeHandover, globalDrift, rollbackCheckpoint, memoryStatusFresh, configConsumers, reportStatusEnum, hooksDocumented, systemSkillFresh, scheduledTasks, REFERENCE_MAX_BYTES, referenceFit, PLUGIN_DIST_REL, PLUGIN_VALIDATE_TIMEOUT_MS, pluginValidate, LINT_SHOW, lintSummary, skillLint,
  agentLint, configScan, HARNESS_MIN, harnessScore, LIVENESS_WINDOW_MS, LIVENESS_RUNNING_STATUSES,
  LIVENESS_ABANDONED_MS, runLiveness,
};
