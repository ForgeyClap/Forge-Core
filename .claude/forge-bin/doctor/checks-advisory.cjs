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
  // WP 2.1: the store the scribe WRITES to must be ignored: .claude/forge-scribe/ in a legacy project, .forge/scribe/
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
  alwaysLoadedBudget, globalForgeHandover, PLUGIN_DIST_REL, PLUGIN_VALIDATE_TIMEOUT_MS, pluginValidate, LINT_SHOW, lintSummary, skillLint,
  agentLint, configScan, HARNESS_MIN, harnessScore, LIVENESS_WINDOW_MS, LIVENESS_RUNNING_STATUSES,
  LIVENESS_ABANDONED_MS, runLiveness,
};
