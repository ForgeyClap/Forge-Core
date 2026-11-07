'use strict';
/**
 * doctor/checks-setup.cjs — one module of forge-doctor.cjs (WP A11 part 2): beginner_setup: claude-md-size, path-tools, bypass-mode, wsl-mnt-c, claude-doctor, prompt-coach-present, settings-wired, model-choice-hint.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const { claudeDir } = require('./context.cjs');
const { applyDoctorOverride } = require('./overrides.cjs');

// ===========================================================================================================
// BEGINNER SETUP (wp17, 2026-09-24) — ADVISORY-ONLY, report.advisory.beginner_setup. The setup traps a
// first-time user hits and a doctor can see (research: .claude/forge-research/beginner-sweep-2026-09-24/
// web-track-a.md): A3 an over-long CLAUDE.md gets ignored · A32/B18 `claude`/`git`/`node` "not recognized" ·
// a native Claude Code install needs no Node while every Forge tool is a .cjs file · A20/B9 bypassPermissions
// as a default · B22 a WSL project under /mnt/c · A35 `claude doctor` exists and nobody knows it · (wp-l1,
// loop iteration 1, 2026-09-24) settings-wired: is Forge's own hooks/deny payload actually merged into this
// project's settings.json, via forge-settings-merge.cjs::checkSettingsMerge() · (wp-l4, loop iteration 4,
// 2026-09-24) model-choice-hint: theme 5 of the same beginner sweep (52/98 videos — model choice, usage
// limits & cost) had NO beginner-facing surface anywhere in Forge, only the owner's own global
// TOKEN_EFFICIENCY_GLOBAL_POLICY.md, which a beginner never reads. One plain, paraphrased sentence, always
// `info` (nothing here is evaluated, so it can never be `ok` or `warn`).
// Contract of every check: {id, ok, level:'ok'|'info'|'warn'|'n-a'|'note', detail, ms, ...evidence}; ok is
// false exactly when level is 'warn'. `note` is the same non-judgmental posture as `info` — used when a
// check genuinely has nothing to compare against (see settingsWired() below) rather than a real pass/fail.
// Each result passes through applyDoctorOverride() under its printed id, so an
// owner can acknowledge a deliberate warn (a throwaway VM that really runs bypassPermissions) with the same
// reasoned doctor_check_overrides entry the enforced checks use. Nothing here reads the user's home
// directory: only the project root, the PATH it is handed, and the tools that PATH resolves to.
// ===========================================================================================================
const CLAUDE_MD_MAX_LINES = 200;
const BEGINNER_PATH_TOOLS = ['claude', 'git', 'node'];
const TOOL_VERSION_TIMEOUT_MS = 3000;
const CLAUDE_DOCTOR_TIMEOUT_MS = 5000;
const CLAUDE_DOCTOR_MAX_LINES = 5;
const PATH_MISSING_HINT = 'Close and reopen your terminal; if it is still missing, the install folder is not on PATH.';
const NODE_MISSING_HINT = "Forge's own tools are Node scripts and need Node 18 or newer, even though Claude Code itself does not.";
const WIN_EXEC_EXTS = ['.COM', '.EXE', '.BAT', '.CMD'];
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** CLAUDE_VERSION_ADVISORY_MIN —: the Claude Code release that turned on Opus 5.5's
 *  medium-effort default and the current prompt-caching behaviour (usage-minimisation research,
 *  .claude/forge-research/2026-09-26-usage-minimisation/REPORT.md, citing the CHANGELOG). An older install
 *  just gets the older behaviour silently — worth a plain, non-red nudge, never a warn: this is a version
 *  observation, not a defect in the project or machine. */
const CLAUDE_VERSION_ADVISORY_MIN = '2.1.280';

function envGet(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
function beginnerResult(id, level, detail, extra) {
  return Object.assign({ id, ok: level !== 'warn', level, detail }, extra || {});
}
/** safeCheck — times one check and turns a throw into a visible warn. An advisory must never be able to take
 *  down the doctor it only advises, but a check that crashed is not "fine" either. */
function safeCheck(id, fn) {
  const t0 = Date.now();
  try { return Object.assign({}, fn(), { ms: Date.now() - t0 }); }
  catch (e) { return beginnerResult(id, 'warn', 'check could not run: ' + e.message, { ms: Date.now() - t0 }); }
}
function textLines(text) {
  if (!text) return 0;
  const n = text.split(/\r?\n/).length;
  return /\n$/.test(text) ? n - 1 : n;
}
function cleanLines(text, max) {
  return String(text || '').replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, max)
    .map((l) => (l.length > 160 ? l.slice(0, 157) + '...' : l));
}

/** claude-md-size — the project CLAUDE.md (root, or .claude/CLAUDE.md) line count against Anthropic's ~200
 *  guidance. Absent is fine and said so; unreadable is a warn (Claude Code cannot load it either). */
function claudeMdSize(root) {
  const files = [];
  for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    try { files.push({ file: rel, lines: textLines(fs.readFileSync(abs, 'utf8')) }); }
    catch (e) { files.push({ file: rel, lines: null, error: e.code || e.message }); }
  }
  if (!files.length) return beginnerResult('claude-md-size', 'ok', 'no project CLAUDE.md — nothing to measure', { files });
  const listing = files.map((f) => f.file + ' ' + (f.lines === null ? 'UNREADABLE (' + f.error + ')' : f.lines + ' lines')).join(' · ');
  const long = files.some((f) => f.lines > CLAUDE_MD_MAX_LINES);
  const unreadable = files.some((f) => f.lines === null);
  if (!long && !unreadable) return beginnerResult('claude-md-size', 'info', listing + ' (within the ~' + CLAUDE_MD_MAX_LINES + '-line guidance)', { files });
  return beginnerResult('claude-md-size', 'warn', listing
    + (long ? ' — over ~' + CLAUDE_MD_MAX_LINES + ' lines. Anthropic: long CLAUDE.md files get ignored; move procedures into skills' : '')
    + (unreadable ? ' — a CLAUDE.md that cannot be read is never loaded' : ''), { files });
}

/** resolveOnPath(name, env, platform) -> absolute path | null. The same lookup the shell does, in-process:
 *  `where`/`which` were measured at 437-470 ms per call on Windows, which alone breaks this check's 300 ms
 *  budget three times over. Windows: every PATH dir x PATHEXT (.com/.exe/.bat/.cmd only); POSIX: an
 *  executable regular file. Never spawns, never throws. */
function resolveOnPath(name, env, platform) {
  const isWin = platform === 'win32';
  // Windows PATH entries may be wrapped in quotes (cmd strips them); a POSIX PATH entry is taken literally.
  const dirs = String(envGet(env, 'PATH') || '').split(isWin ? ';' : ':').map((d) => (isWin ? d.trim().replace(/^"(.*)"$/, '$1') : d)).filter(Boolean);
  let exts = [''];
  if (isWin) {
    const fromEnv = String(envGet(env, 'PATHEXT') || '').split(';').map((e) => e.trim().toUpperCase()).filter((e) => WIN_EXEC_EXTS.includes(e));
    exts = (fromEnv.length ? fromEnv : WIN_EXEC_EXTS).map((e) => e.toLowerCase());
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* not here — keep looking */ }
    }
  }
  return null;
}
/** spawnResolved — run an already-resolved tool read-only: no shell, stdin closed (so nothing can wait for a
 *  keypress), hard timeout. Node refuses to spawn .cmd/.bat directly since the 2024 batch-file hardening, so
 *  those go through cmd.exe with ONE pre-quoted command line, verbatim — the same /d /s /c form Node itself
 *  builds for a shell spawn. The arguments are fixed literals chosen by this file, never user input. */
function spawnResolved(file, args, env, timeoutMs, cwd) {
  const base = { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, cwd, shell: false };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const comspec = envGet(env, 'ComSpec') || envGet(process.env, 'ComSpec') || 'cmd.exe';
    return spawnSync(comspec, ['/d', '/s', '/c', '""' + file + '" ' + args.join(' ') + '"'], Object.assign({}, base, { windowsVerbatimArguments: true }));
  }
  return spawnSync(file, args, base);
}
function toolVersion(file, env, cwd) {
  const r = spawnResolved(file, ['--version'], env, TOOL_VERSION_TIMEOUT_MS, cwd);
  if (r.error && r.error.code === 'ETIMEDOUT') return { version: null, version_note: '--version timed out after ' + (TOOL_VERSION_TIMEOUT_MS / 1000) + ' s' };
  if (r.error) return { version: null, version_note: '--version failed: ' + (r.error.code || r.error.message) };
  const first = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), 1)[0];
  return first ? { version: first } : { version: null, version_note: '--version printed nothing (exit ' + r.status + ')' };
}

function isSameFile(a, b) {
  try {
    const ra = fs.realpathSync(a), rb = fs.realpathSync(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch { return false; }
}
/** parseVersionTriple(str) -> [major, minor, patch] | null — pulls the first x.y.z-looking token out of an
 *  arbitrary `--version` first line (e.g. "2.1.220 (Claude Code)", or a test stub like "0.0.1-stub"). Never
 *  guesses: a string with no such token returns null rather than a fabricated triple. */
function parseVersionTriple(str) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(str || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** compareVersionTriples(a, b) -> negative | 0 | positive, ordinary numeric triple comparison. */
function compareVersionTriples(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
/** claudeVersionAdvisory(versionString) -> string | null —. A plain-words, non-judgmental nudge
 *  when the installed `claude` predates CLAUDE_VERSION_ADVISORY_MIN; null (no advisory at all) once it is
 *  current, and null on an unparseable string too — this ADVISES, it never guesses a verdict from a string
 *  it can't read. Pure function so it is directly testable with a stubbed version string, independent of
 *  ever spawning a real binary. */
function claudeVersionAdvisory(versionString) {
  const cur = parseVersionTriple(versionString);
  if (!cur) return null;
  const min = parseVersionTriple(CLAUDE_VERSION_ADVISORY_MIN);
  if (compareVersionTriples(cur, min) >= 0) return null;
  return 'your claude (' + versionString + ') is older than ' + CLAUDE_VERSION_ADVISORY_MIN + ' — that release '
    + "turned on Opus 5.5's medium-effort default and the current caching behaviour, so an older install just "
    + 'gets the earlier behaviour silently. `claude update` picks up the newer version when convenient — this '
    + 'is only a heads-up, no action required.';
}

/** path-tools — claude, git, node resolvable on PATH, each with the first line of its --version (3 s cap).
 *  When the `node` on PATH IS the binary running this doctor, its version is process.version — the exact
 *  string `node --version` prints — and one of three spawns is saved (measured 40-140 ms per spawn here).
 *  an outdated `claude` gets a plain version advisory tacked onto the SAME `ok`/`warn` verdict
 *  path-tools already computes from missing tools — the advisory never flips that verdict (never red). */
function pathTools(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const tools = {};
  for (const name of BEGINNER_PATH_TOOLS) {
    const found = resolveOnPath(name, env, platform);
    if (!found) { tools[name] = { found: false, path: null, version: null }; continue; }
    tools[name] = name === 'node' && isSameFile(found, process.execPath)
      ? { found: true, path: found, version: process.version, version_source: 'this doctor process' }
      : Object.assign({ found: true, path: found }, toolVersion(found, env, root));
  }
  if (tools.claude && tools.claude.found && tools.claude.version) {
    const advisory = claudeVersionAdvisory(tools.claude.version);
    if (advisory) tools.claude.version_advisory = advisory;
  }
  const missing = BEGINNER_PATH_TOOLS.filter((n) => !tools[n].found);
  const listing = BEGINNER_PATH_TOOLS.map((n) => n + ': ' + (!tools[n].found ? 'MISSING' : (tools[n].version || 'found (' + tools[n].version_note + ')'))).join(' · ');
  const versionAdvisorySuffix = (tools.claude && tools.claude.version_advisory) ? ' · ' + tools.claude.version_advisory : '';
  if (!missing.length) return beginnerResult('path-tools', 'ok', listing + versionAdvisorySuffix, { tools, missing });
  return beginnerResult('path-tools', 'warn', listing + ' — not recognized on PATH: ' + missing.join(', ') + '. ' + PATH_MISSING_HINT
    + (missing.includes('node') ? ' ' + NODE_MISSING_HINT : '') + versionAdvisorySuffix, { tools, missing });
}

/** bypass-mode — the PROJECT's .claude/settings.json + settings.local.json only (never a global settings
 *  file): permissions.defaultMode "bypassPermissions" is a warn; a file that does not parse is a warn too. */
function bypassMode(root) {
  const files = [];
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (e) { files.push({ file: rel, readable: false, error: e.code || e.name }); continue; }
    const perms = data && typeof data === 'object' && data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
    files.push({ file: rel, readable: true, defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null });
  }
  const bypass = files.filter((f) => f.defaultMode === 'bypassPermissions').map((f) => f.file);
  const unreadable = files.filter((f) => !f.readable).map((f) => f.file + ' (' + f.error + ')');
  const problems = [];
  if (bypass.length) problems.push(bypass.join(', ') + ' sets permissions.defaultMode "bypassPermissions": every tool call runs without asking — keep that for a throwaway container or VM, not a real machine. Meer uitleg / more detail: .claude/skills/forge-prompt-coach/references/unsafe-advice.md');
  if (unreadable.length) problems.push('settings unreadable: ' + unreadable.join(', ') + ' — Claude Code cannot apply a settings file it cannot parse');
  if (problems.length) return beginnerResult('bypass-mode', 'warn', problems.join(' · '), { files });
  if (!files.length) return beginnerResult('bypass-mode', 'info', 'no project settings file — Claude Code asks before risky actions by default', { files });
  return beginnerResult('bypass-mode', 'info', 'no bypassPermissions default in ' + files.map((f) => f.file + (f.defaultMode ? ' (defaultMode ' + f.defaultMode + ')' : '')).join(' + '), { files });
}

/** wsl-mnt-c — a Linux (WSL) process whose project root sits under /mnt/ is working on the Windows drive
 *  through the 9P bridge: slow, and file watching there is incomplete. Pure string check, no file access. */
function wslMntC(root, opts) {
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'linux') return beginnerResult('wsl-mnt-c', 'n-a', 'not applicable on ' + platform + ' (WSL-only check)');
  if (String(root).startsWith('/mnt/')) return beginnerResult('wsl-mnt-c', 'warn', 'project root ' + root + ' is on the Windows drive seen from WSL (slow file access, incomplete file watching). WSL: keep the project inside the Linux home for speed');
  return beginnerResult('wsl-mnt-c', 'ok', 'project root is on the Linux filesystem');
}

/** claude-doctor — Anthropic's own read-only installation check, surfaced because beginners do not know it
 *  exists. Runs ONLY when the caller asks (the forge-doctor CLI does; library and fixture calls do not, so a
 *  test suite never spends 5 s per runDoctor() on it), only when `claude` resolved on PATH, with stdin
 *  closed and a 5 s cap: it can never become an interactive session — a CLI that insists on a terminal just
 *  times out, and that is reported as such. The first 5 non-empty lines are shown verbatim, never parsed. */
function claudeDoctorProbe(root, opts) {
  const o = opts || {};
  if (!o.claudePath) return beginnerResult('claude-doctor', 'info', 'not run (claude CLI absent from PATH)', { ran: false, lines: [] });
  if (!o.probe) return beginnerResult('claude-doctor', 'info', 'not run (library call — the read-only `claude doctor` probe runs from the forge-doctor CLI only)', { ran: false, lines: [] });
  const timeoutMs = o.timeoutMs || CLAUDE_DOCTOR_TIMEOUT_MS;
  const r = spawnResolved(o.claudePath, ['doctor'], o.env || process.env, timeoutMs, root);
  if (r.error && r.error.code === 'ETIMEDOUT') return beginnerResult('claude-doctor', 'info', 'not run (timed out after ' + (timeoutMs / 1000) + ' s — the doctor runs `claude doctor` read-only itself and stopped it because it was waiting for an interactive terminal; nothing for you to do, the next doctor run tries again)', { ran: false, timed_out: true, lines: [] });
  if (r.error) return beginnerResult('claude-doctor', 'info', 'not run (' + (r.error.code || r.error.message) + ')', { ran: false, lines: [] });
  const lines = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), CLAUDE_DOCTOR_MAX_LINES);
  return beginnerResult('claude-doctor', 'info', '`claude doctor` ran read-only (exit ' + r.status + ')' + (lines.length ? ', first ' + lines.length + ' line(s):' : ' but printed nothing'), { ran: true, exit: r.status, lines });
}

/** prompt-coach-present — completeness: an install that has forge-intake must also have forge-prompt-coach,
 *  the skill the intake hands a vague request to. */
function promptCoachPresent(root) {
  const skills = path.join(claudeDir(root), 'skills');
  const intake = fs.existsSync(path.join(skills, 'forge-intake', 'SKILL.md'));
  const coach = fs.existsSync(path.join(skills, 'forge-prompt-coach', 'SKILL.md'));
  if (!intake) return beginnerResult('prompt-coach-present', 'n-a', 'forge-intake is not installed here, so there is no pairing to check', { intake, coach });
  if (coach) return beginnerResult('prompt-coach-present', 'ok', 'forge-intake and forge-prompt-coach are both installed', { intake, coach });
  return beginnerResult('prompt-coach-present', 'warn', 'forge-intake is installed but .claude/skills/forge-prompt-coach/SKILL.md is missing — an incomplete install or sync', { intake, coach });
}

/** settingsTemplatePath(opts) -> absolute path to a template settings.json, or null. Mirrors forge-sync.cjs's
 *  OWN template-resolution order: an injected opts.source (test/CLI) first, then FORGE_SYNC_TEMPLATE_DIR,
 *  then the SAME canonical global template forge-sync.cjs itself falls back to —
 *  `<home>/.claude/forge/template/.claude/settings.json` — because that is exactly where install.ps1 and
 *  install.sh copy the shipped `.claude` tree on an installer install (N8, 2026-09-26 laptop re-audit:
 *  without this fallback, settings-wired could never run on an installer install and only ever said "note").
 *  This is a READ-ONLY existence check — it never writes here or anywhere else. Comparing a project's
 *  settings.json against itself is still avoided: this path is the shared template dir, not the project's
 *  own .claude, so it never trivially reads "up to date" for the wrong reason. With none of the three
 *  sources available there is honestly no template to compare against (reported as `note`, never guessed). */
function settingsTemplatePath(opts) {
  const o = opts || {};
  if (o.source) return o.source;
  const envDir = process.env.FORGE_SYNC_TEMPLATE_DIR;
  if (envDir) {
    const p = path.join(path.resolve(envDir), 'settings.json');
    if (fs.existsSync(p)) return p;
  }
  const globalTemplate = path.join(os.homedir(), '.claude', 'forge', 'template', '.claude', 'settings.json');
  if (fs.existsSync(globalTemplate)) return globalTemplate;
  return null;
}

/** settings-wired — wp-l1 (loop iteration 1): forge-settings-merge.cjs::checkSettingsMerge()
 *  (the pure, exported function — never a spawned CLI) against a genuine EXTERNAL template settings.json.
 *  `ok` when every Forge hook + deny rule the template ships is already present in this project's own
 *  settings.json; `warn` (never a hard failure — this stays advisory-only) when something from the template
 *  is missing; `note` when there is no settings.json here yet, or no template could be found to compare
 *  against (checkSettingsMerge() itself never writes anything either way). */
function settingsWired(root, opts) {
  const o = opts || {};
  const target = path.join(claudeDir(root), 'settings.json');
  if (!fs.existsSync(target)) {
    return beginnerResult('settings-wired', 'note', 'no .claude/settings.json in this project yet — nothing to compare', { target, source: null });
  }
  const source = settingsTemplatePath(o);
  if (!source) {
    return beginnerResult('settings-wired', 'note', 'no template settings.json found to compare against (set FORGE_SYNC_TEMPLATE_DIR to a template .claude dir to enable this check) — cannot judge whether Forge hooks/deny rules are wired', { target, source: null });
  }
  let mergeTool;
  try { mergeTool = require('../forge-settings-merge.cjs'); }
  catch (e) { return beginnerResult('settings-wired', 'note', 'forge-settings-merge.cjs unavailable: ' + e.message, { target, source }); }
  const r = mergeTool.checkSettingsMerge({ target, source });
  if (r.status === 'usage-error' || r.status === 'missing') {
    return beginnerResult('settings-wired', 'note', 'could not compare settings.json against the template: ' + r.message, { target, source });
  }
  if (r.ok) return beginnerResult('settings-wired', 'ok', 'every Forge hook and deny rule from the template is already wired into settings.json', { target, source });
  const upgraded = Array.isArray(r.upgraded) ? r.upgraded : [];
  return beginnerResult('settings-wired', 'warn', 'settings.json is missing ' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + upgraded.length + ' hook command update(s), ' + r.deny_added.length + ' deny rule(s) from the template — run forge-sync (or forge-settings-merge.cjs apply) to wire it in', { target, source, added: r.added, adjusted: r.adjusted, upgraded, deny_added: r.deny_added });
}

/** model-choice-hint — wp-l4 (loop iteration 4): a paraphrase of the owner's own
 *  TOKEN_EFFICIENCY_GLOBAL_POLICY.md for a beginner who has never seen that file. Pure education, not an
 *  evaluation of this project or machine, so it is always `info` — never `ok` (nothing passed) and never
 *  `warn` (nothing failed). One plain sentence, no jargon, no imperative telling the reader to run a specific
 *  command — it DESCRIBES that `/costs` and `/insights` exist rather than instructing "run /costs now".
 *  English-only, like every other beginner_setup check here (none of them branch on language either) —
 *  written in short, idiom-free sentences so it reads the same for a Dutch or English first-time user.
 *
 * added the CACHE-DISCIPLINE sentence, in the same descriptive, non-imperative
 *  register: switching model or tools mid-session, or compacting right after a long gap, is what actually
 *  costs the most (research: .claude/forge-research/2026-09-26-usage-minimisation/REPORT.md — a cache miss
 *  costs roughly 25-40x a cache read of the same content), so this is worth a beginner knowing even though
 *  Forge itself has no switch to flip for it — see the forge.md "CACHE DISCIPLINE" section for the fuller
 *  version of the same guidance. */
function modelChoiceHint() {
  return beginnerResult('model-choice-hint', 'info',
    'model choice affects quality and cost together: a balanced, Sonnet-class model already covers everyday '
    + 'work well, a heavier model is worth reaching for only on genuinely high-risk work (security, '
    + 'production, a hard bug), a usage guard pauses Forge when you near your usage limit (it measures on an '
    + 'interval, so it is a pause before the limit, not a guaranteed instant block), and both `/costs` and '
    + '`/insights` keep the amount already used visible inside Claude Code. Picking the model and effort level '
    + 'once at the start of a session and keeping both for its whole length is what keeps the cached context '
    + 'cheap — switching model partway through, or turning a tool on or off, makes the next step re-read the '
    + 'whole conversation at full price instead of the cached rate; `/compact` is cheapest at a natural break '
    + 'between tasks rather than after a long gap (which already lost the saving), and `/rewind` is the cheaper '
    + 'way back when a path is being abandoned instead of compacting past it.');
}

/** beginnerSetup(root, {env, platform, probeClaudeDoctor, claudeDoctorTimeoutMs, overrideMap, settingsSource}) ->
 *  {ok, checks:{claude_md_size, path_tools, bypass_mode, wsl_mnt_c, claude_doctor, prompt_coach_present,
 *  settings_wired, model_choice_hint}, ms}. env/platform default to this process — injectable so the tests
 *  can hand it a fake PATH or a Linux root; settingsSource is the same test/CLI injection
 *  settingsTemplatePath() honors. */
function beginnerSetup(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const overrideMap = o.overrideMap || new Map();
  const t0 = Date.now();
  const pt = safeCheck('path-tools', () => pathTools(root, { env, platform }));
  const claudePath = pt.tools && pt.tools.claude && pt.tools.claude.found ? pt.tools.claude.path : null;
  const raw = {
    claude_md_size: safeCheck('claude-md-size', () => claudeMdSize(root)),
    path_tools: pt,
    bypass_mode: safeCheck('bypass-mode', () => bypassMode(root)),
    wsl_mnt_c: safeCheck('wsl-mnt-c', () => wslMntC(root, { platform })),
    claude_doctor: safeCheck('claude-doctor', () => claudeDoctorProbe(root, { claudePath, probe: !!o.probeClaudeDoctor, env, timeoutMs: o.claudeDoctorTimeoutMs })),
    prompt_coach_present: safeCheck('prompt-coach-present', () => promptCoachPresent(root)),
    settings_wired: safeCheck('settings-wired', () => settingsWired(root, { source: o.settingsSource })),
    model_choice_hint: safeCheck('model-choice-hint', () => modelChoiceHint()),
  };
  const checks = {};
  for (const [key, res] of Object.entries(raw)) checks[key] = applyDoctorOverride(overrideMap, res.id, res);
  return { ok: Object.values(checks).every((c) => c.ok), checks, ms: Date.now() - t0 };
}

module.exports = {
  CLAUDE_MD_MAX_LINES, BEGINNER_PATH_TOOLS, TOOL_VERSION_TIMEOUT_MS, CLAUDE_DOCTOR_TIMEOUT_MS,
  CLAUDE_DOCTOR_MAX_LINES, PATH_MISSING_HINT, NODE_MISSING_HINT, WIN_EXEC_EXTS, ANSI_RE, CLAUDE_VERSION_ADVISORY_MIN,
  envGet, beginnerResult, safeCheck, textLines, cleanLines, claudeMdSize, resolveOnPath, spawnResolved, toolVersion,
  isSameFile, parseVersionTriple, compareVersionTriples, claudeVersionAdvisory, pathTools, bypassMode, wslMntC,
  claudeDoctorProbe, promptCoachPresent, settingsTemplatePath, settingsWired, modelChoiceHint, beginnerSetup,
};
