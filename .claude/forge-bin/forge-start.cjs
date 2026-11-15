#!/usr/bin/env node
'use strict';
/**
 * forge-start.cjs — the /forge bootstrap in ONE call (R8B-F1). Category round 8b: a Sonnet Lead skipped the
 * /forge procedure (no contract plan, no memory_loaded / owner_prefs_loaded, a hand-typed run id, run_started without
 * agent or runtime) and the contract judged the run L1. This tool runs the opening steps through the EXISTING tools, in
 * order, so the procedure is one obvious command for any Lead model:
 *
 *   node .claude/forge-bin/forge-start.cjs --text "<raw request>" [--complexity L1|L2|L3|L4 --reason "..."] [--json]
 *
 *   1 run          mint forge-YYYY-MM-DD-HHMMSS (local time; the next free second when taken) and log run_started
 *                  through log-event.cjs: agent orchestrator, runtime internal, complexity = the flag, else L2 (any
 *                  /forge request is build or creative work; L1 only with --complexity L1 and a --reason)
 *   2 active-run   forge-active-run.cjs set <run_id>
 *   3 owner-prefs  forge-config.cjs diff --run <id> --mark-seen, forge-echo.cjs emit <id> (owner_prefs_loaded), and the
 *                  forge-standing.cjs list printed
 *   4 memory       FORGE_PROJECT_PROFILE.md, FORGE_MEMORY.md (first 120 lines each), FORGE_TASK_HISTORY.md,
 *                  FORGE_AGENT_LEDGER.md (last 40 lines each: the newest entries are at the end), found through
 *                  forge-paths.cjs, printed with the path for the rest or "absent"; then project_scanned and
 *                  memory_loaded with the files really read (path, sha256, bytes, lines) and the absent ones
 *   5 quality      forge-quality.cjs analyze "<request>" --log-run <id> (the councilTrigger decision)
 *   6 anticipate   forge-anticipate.cjs plan + apply --run <id> (the run-shape overlay)
 *   7 device       mobile, game or desktop work: node forge-device-env.cjs --json when that file exists (spawned,
 *                  never required): its verdict, AVDs and devices, and its commands with this run id; else a one-line hint
 *   8 plan         forge-runcontract.cjs plan --run <id>, then one line: NEXT: <the preview check command>
 *
 * A step that fails says so, logs nothing for that step (the tool it spawns logs only what it did itself) and the next
 * step runs. This tool never logs an event it did not earn: no research_done, skill map, work package or dispatch.
 * The request is secret-scrubbed (forge-scribe-store scrubText) before it reaches an event or another tool.
 * --json prints one object {ok, run_id, complexity, complexity_source, steps:[{id, ok, logged[], note}], next} instead
 * of the text (the file contents stay out of it). Exit 0 = the run was created; 1 = it was not (usage or run_started
 * refused). Zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let fp = null;
try { fp = require('./forge-paths.cjs'); } catch { fp = null; }
const ROOT = fp ? fp.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..'); // forge-paths fallback
const LEVEL_RE = /^L[1-4]$/;
const GOAL_MAX = 300;
const TOOL_TIMEOUT_MS = 120000;
const STANDING_MAX_LINES = 40;
const TOP_LEVEL_MAX = 60;
// [file, how much to print]: a profile and a memory read from the top, the two append-only logs from the end
const MEMORY_FILES = [['FORGE_PROJECT_PROFILE.md', 'head', 120], ['FORGE_MEMORY.md', 'head', 120], ['FORGE_TASK_HISTORY.md', 'tail', 40], ['FORGE_AGENT_LEDGER.md', 'tail', 40]];
const DEVICE_DOMAINS = new Set(['mobile', 'game', 'electron', 'desktop']);
const DEVICE_WORDS = /\b(android|ios|apk|mobiel\w*|mobile|spel\w*|game\w*|electron|desktop|\.exe)\b/i;
const USAGE = 'Usage: node .claude/forge-bin/forge-start.cjs --text "<raw request>" [--complexity L1|L2|L3|L4 --reason "..."] [--json]';

const oneLine = (s, max) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return max && t.length > max ? t.slice(0, max - 1) + '…' : t; };
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const firstLine = (s) => oneLine(String(s || '').split(/\r?\n/).find((l) => l.trim()) || '', 200);
const parseJson = (s) => { try { return JSON.parse(String(s).trim()); } catch { return null; } };

function parseArgs(argv) {
  const o = { text: null, complexity: null, reason: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--text' || a === '--complexity' || a === '--reason') {
      if (argv[i + 1] === undefined) throw new Error(a + ' needs a value');
      o[a.slice(2)] = argv[++i];
    } else throw new Error('unknown argument ' + JSON.stringify(a));
  }
  if (!oneLine(o.text)) throw new Error('--text "<raw request>" is required');
  if (o.complexity !== null) {
    o.complexity = String(o.complexity).trim().toUpperCase();
    if (!LEVEL_RE.test(o.complexity)) throw new Error('--complexity must be L1, L2, L3 or L4');
    if (o.complexity === 'L1' && !oneLine(o.reason)) throw new Error('--complexity L1 needs --reason "<why this is a one-file fix>" (a build or creative request is L2)');
  }
  return o;
}

/** scrub(text) -> {text, redacted}: the scribe's secret scrubber when it loads, else the text as it is. */
function scrub(text) {
  try { const S = require('./forge-scribe-store.cjs'); if (S && typeof S.scrubText === 'function') return S.scrubText(text); } catch { /* not installed */ }
  return { text, redacted: false };
}

/** tool(file, args, env) -> {status, stdout, stderr, error}. Spawns an existing tool; never throws. */
function tool(file, args, env) {
  if (!fs.existsSync(file)) return { status: null, stdout: '', stderr: '', error: path.basename(file) + ' is not installed' };
  const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, env || {}), timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error ? String(r.error.code || r.error.message) : null };
}
const bin = (name) => path.join(__dirname, name);
const why = (r) => r.error || ('exit ' + r.status + (firstLine(r.stderr || r.stdout) ? ': ' + firstLine(r.stderr || r.stdout) : ''));

function logEvent(runId, type, payload) {
  return tool(path.join(ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), [runId, type, '--env', 'FORGE_START_EVENT'], { FORGE_START_EVENT: JSON.stringify(payload) });
}

function runsDirs() {
  const legacy = path.join(ROOT, '.claude', 'forge-runs');
  if (!fp) return [legacy];
  try { return [fp.stateDir(ROOT, 'runs'), legacy]; } catch { return [legacy]; }
}
function mintRunId(now) {
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 120; i++) {
    const d = new Date(now.getTime() + i * 1000);
    const id = 'forge-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    if (!runsDirs().some((dir) => fs.existsSync(path.join(dir, id)))) return id;
  }
  return null;
}

// ---- the steps (each returns {ok, logged, note, body?}) --------------------------------------------------------------
function stepActiveRun(runId) {
  const r = tool(bin('forge-active-run.cjs'), ['set', runId, '--root', ROOT]);
  return r.status === 0 ? { ok: true, logged: [], note: firstLine(r.stdout) } : { ok: false, logged: [], note: 'forge-active-run set failed (' + why(r) + ')' };
}

/** standingLines(rules) -> {lines, skipped}. CF-4-F6: owner rules newest first, then template rules, so the STANDING_MAX_LINES
 *  cut drops the oldest rule, never the newest owner rule. A template rule copied from this project's CLAUDE.md (always
 *  loaded) is skipped and counted. Lines keep the `list` shape: id<TAB>[scope]<TAB>text. */
function standingLines(rules) {
  const mirrored = (r) => r._origin === 'template' && /^CLAUDE\.md \(this project's root\b/.test(String(r.source || ''));
  const user = rules.filter((r) => r._origin === 'user').reverse();
  const rest = rules.filter((r) => r._origin !== 'user' && !mirrored(r));
  return { lines: user.concat(rest).map((r) => r.id + '\t[' + r.scope + ']\t' + r.text), skipped: rules.filter(mirrored).length };
}

function stepOwnerPrefs(runId) {
  const notes = [], logged = [];
  let ok = true;
  const d = tool(bin('forge-config.cjs'), ['diff', '--run', runId, '--mark-seen', '--json']);
  const D = parseJson(d.stdout);
  if ((d.status === 0 || d.status === 3) && D) {
    if (D.logged) logged.push('config_changed');
    notes.push(D.first_run ? 'settings: first run, baseline recorded' : D.changed.length ? 'settings: ' + D.changed.length + ' changed since the last run' : 'settings: none changed since the last run');
  } else { ok = false; notes.push('forge-config diff failed (' + why(d) + ')'); }
  const e = tool(bin('forge-echo.cjs'), ['emit', runId, '--json']);
  const E = parseJson(e.stdout);
  if (e.status === 0 && E && E.logged) { logged.push('owner_prefs_loaded'); notes.push(oneLine(E.summary, 200)); }
  else { ok = false; notes.push('forge-echo emit failed (' + why(e) + '): owner_prefs_loaded not logged'); }
  const s = tool(bin('forge-standing.cjs'), ['list', '--json']);
  let body = [];
  const list = s.status === 0 ? parseJson(s.stdout) : null;
  if (Array.isArray(list)) {
    const { lines: rules, skipped } = standingLines(list);
    body = ['standing rules (' + rules.length + (skipped ? ', plus ' + skipped + ' already in CLAUDE.md' : '') + '):'].concat(rules.slice(0, STANDING_MAX_LINES).map((l) => '  ' + oneLine(l, 220)));
    if (rules.length > STANDING_MAX_LINES) body.push('  … ' + (rules.length - STANDING_MAX_LINES) + ' more: node .claude/forge-bin/forge-standing.cjs list');
  } else { ok = false; notes.push('forge-standing list failed (' + why(s) + ')'); }
  return { ok, logged, note: notes.join(' · '), body };
}

function memoryPath(name) {
  if (fp) { try { return fp.memoryFile(ROOT, name, { read: true }); } catch { /* legacy below */ } }
  return path.join(ROOT, '.claude', name);
}
const GRAPH_HINT = 'read graphify-out/GRAPH_REPORT.md first when it exists, query with: graphify query "<question>" (set GRAPHIFY_QUERY_LOG_DISABLE=1 first, or graphify logs each query to ~/.cache)';
const GRAPH_DEFAULT_REASON = { unavailable: 'graphify is not installed', skipped: 'not needed for this project' };
/** graphLine(ensure, root) -> one line, or null. The graph is an extra source beside memory. The start never waits for a
 *  build (at most a short graphify --version probe; the build runs detached), and this never throws. */
function graphLine(ensure, root) {
  if (typeof ensure !== 'function') return null;
  let g;
  try { g = ensure({ root, env: process.env, wait: false }); } catch { return null; }
  const status = g && typeof g === 'object' ? g.status : null;
  if (status === 'fresh' || status === 'built') return 'graph: ' + status + ' - ' + GRAPH_HINT;
  if (status === 'building') return 'graph: building - being built in the background; ' + GRAPH_HINT;
  if (status === 'unavailable' || status === 'skipped') return 'graph: ' + status + ' - ' + (oneLine(g.reason, 160) || GRAPH_DEFAULT_REASON[status]);
  return null;
}
function loadGraphEnsure() {
  try { const G = require('./forge-graphify.cjs'); return G && G.ensure; } catch { return null; } // missing or broken module: no line
}

function stepMemory(runId) {
  const read = [], absent = [], unreadable = [], body = [];
  for (const [name, mode, cap] of MEMORY_FILES) {
    const file = memoryPath(name);
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) {
      if (e && e.code === 'ENOENT') { absent.push(rel(file)); body.push(rel(file) + ': absent'); }
      else { unreadable.push({ path: rel(file), reason: String((e && e.code) || 'unreadable') }); body.push(rel(file) + ': unreadable (' + ((e && e.code) || 'error') + ')'); }
      continue;
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    read.push({ path: rel(file), sha256: hash, bytes: buf.length, lines: lines.length });
    body.push('--- ' + rel(file) + ' (' + lines.length + ' lines, sha256 ' + hash.slice(0, 12) + '…) ---');
    const shown = mode === 'head' ? lines.slice(0, cap) : lines.slice(-cap);
    body.push(...shown);
    if (lines.length > cap) body.push('(' + (mode === 'head' ? 'first ' : 'last ') + cap + ' of ' + lines.length + ' lines; the rest: ' + rel(file) + ')');
  }
  const graph = graphLine(loadGraphEnsure(), ROOT);
  if (graph) body.push(graph);
  try { const r = require('./forge-brain.cjs').afterRun(ROOT); body.push('brain: ' + (r.skipped || r.syncSkipped || 'synced ' + (r.sync ? r.sync.projects : 0) + ' projects') + ' - all projects in Documents/Forge-Brain/Brain-Home.md'); } catch { /* no line */ }
  // log only what was really done: a read error with nothing read means the step did not happen
  if (!read.length && unreadable.length) return { ok: false, logged: [], note: 'no memory file could be read: nothing logged', body };
  let top = null;
  try { top = fs.readdirSync(ROOT).sort(); } catch { top = null; }
  const files = { files_read: read, absent, unreadable };
  const summary = read.length + ' memory file(s) read, ' + absent.length + ' absent' + (unreadable.length ? ', ' + unreadable.length + ' unreadable' : '');
  const logged = [], fails = [];
  const scan = logEvent(runId, 'project_scanned', Object.assign({ agent: 'orchestrator', role: 'lead', runtime: 'internal', note: 'forge-start: ' + summary + (top ? '; ' + top.length + ' top-level entries' : '') },
    files, top ? { top_level: top.slice(0, TOP_LEVEL_MAX), top_level_count: top.length } : {}));
  if (scan.status === 0) logged.push('project_scanned'); else fails.push('project_scanned refused (' + why(scan) + ')');
  const mem = logEvent(runId, 'memory_loaded', Object.assign({ agent: 'orchestrator', role: 'lead', runtime: 'internal', note: 'forge-start: ' + summary }, files));
  if (mem.status === 0) logged.push('memory_loaded'); else fails.push('memory_loaded refused (' + why(mem) + ')');
  return { ok: !fails.length, logged, note: summary + (fails.length ? ' · ' + fails.join(' · ') : ''), body, files };
}

function stepQuality(runId, text) {
  const r = tool(bin('forge-quality.cjs'), ['analyze', text, '--log-run', runId]);
  const j = parseJson(r.stdout);
  const prof = j && j.profile && typeof j.profile === 'object' ? j.profile : null;
  const domains = prof && Array.isArray(prof.project_type) ? prof.project_type.map(String) : [];
  if (!j) return { ok: false, logged: [], note: 'forge-quality analyze failed (' + why(r) + ')', domains: null };
  const note = 'playbook ' + (j.playbook || '-') + ' · domains ' + (domains.join(', ') || '-') + ' · council ' + ((j.council && j.council.mode) || '-')
    + ' · ' + (Array.isArray(j.omissions) ? j.omissions.length : 0) + ' quality omission(s) to plan for';
  if (r.status !== 0) return { ok: false, logged: [], note: note + ' · the council decision was not logged (' + why(r) + ')', domains };
  return { ok: true, logged: ['decision_logged'], note, domains };
}

function stepAnticipate(runId, text) {
  const p = tool(bin('forge-anticipate.cjs'), ['plan', '--text', text, '--root', ROOT, '--json']);
  const P = parseJson(p.stdout);
  if (!P || P.ok === false) return { ok: false, logged: [], note: 'forge-anticipate plan failed (' + (P && P.error ? P.error : why(p)) + '): nothing applied' };
  const ids = (xs) => (Array.isArray(xs) ? xs.map((x) => x && x.id).filter(Boolean).join(', ') : '') || '-';
  const body = ['  use (SAFE): ' + ids(P.safe_to_enable), '  waits for the owner: ' + ids(P.gated_queue), '  skills: ' + ((Array.isArray(P.skills_to_use) && P.skills_to_use.join(', ')) || '-')];
  const a = tool(bin('forge-anticipate.cjs'), ['apply', '--run', runId, '--text', text, '--root', ROOT, '--json']);
  const A = parseJson(a.stdout);
  if (a.status !== 0 || !A || A.code !== 0) return { ok: false, logged: [], note: oneLine(P.announcement, 200) + ' · apply failed (' + (A && A.message ? oneLine(A.message, 160) : why(a)) + ')', body };
  return { ok: true, logged: A.wrote && !A.warning ? ['agent_note'] : [], note: oneLine(P.announcement, 200) + (A.file ? ' · overlay ' + A.file : '') + (A.warning ? ' · ' + oneLine(A.warning, 160) : ''), body };
}

const DEVICE_COMMANDS = [['boot', 'boot'], ['wait for boot', 'wait_for_boot'], ['install', 'install'], ['package name', 'package_name'], ['launch', 'launch'], ['screenshot', 'screenshot']];
/** stepDevice: relays the forge-device-env.cjs --json result (verdict, AVDs, devices, its commands with this run id). */
function stepDevice(runId, domains, text) {
  const wants = domains ? domains.some((d) => DEVICE_DOMAINS.has(d)) : DEVICE_WORDS.test(text);
  if (!wants) return { ok: true, logged: [], note: 'not a mobile, game or desktop task' };
  const file = bin('forge-device-env.cjs');
  if (!fs.existsSync(file)) return { ok: true, logged: [], note: 'forge-device-env.cjs is not installed here: check the device yourself (adb devices, emulator -list-avds, the Android SDK folder) and run the app on it before you say no device is available' };
  const r = tool(file, ['--json']);
  const j = parseJson(r.stdout);
  if (r.status !== 0 || !j || typeof j.verdict !== 'string') return { ok: false, logged: [], note: 'forge-device-env gave no verdict (' + why(r) + ')' };
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  const ready = Array.isArray(j.devices) ? j.devices.filter((d) => d && d.state === 'device').map((d) => String(d.serial)) : [];
  const withRun = (s) => String(s).replace(/<run_id>/g, runId);
  const body = [];
  const c = j.commands && typeof j.commands === 'object' ? j.commands : null;
  if (c && typeof c.shell === 'string') body.push('  ' + c.shell);
  if (c) for (const [label, key] of DEVICE_COMMANDS) if (typeof c[key] === 'string') body.push('  ' + label + ': ' + withRun(c[key]));
  const w = j.waiver && typeof j.waiver === 'object' ? j.waiver : null;
  if (w) for (const key of ['save', 'log']) if (typeof w[key] === 'string') body.push('  waiver ' + key + ': ' + withRun(w[key]));
  for (const n of list(j.notes)) body.push('  note: ' + oneLine(n, 240));
  body.push('  full report: node .claude/forge-bin/forge-device-env.cjs');
  return { ok: true, logged: [], note: 'verdict ' + j.verdict + ' · AVDs ' + (list(j.avds).join(', ') || 'none') + ' · devices ' + (ready.join(', ') || 'none attached'), body };
}

function stepPlan(runId) {
  const r = tool(bin('forge-runcontract.cjs'), ['plan', '--run', runId, '--root', ROOT]);
  if (r.status !== 0) return { ok: false, logged: [], note: 'forge-runcontract plan failed (' + why(r) + ')' };
  return { ok: true, logged: [], note: 'the contract plan for this run (read-only)', body: r.stdout.replace(/\s+$/, '').split(/\r?\n/) };
}

// ---- main --------------------------------------------------------------------------------------------------------
const STEPS = [['active-run', 'run pointer'], ['owner-prefs', 'owner preferences'], ['memory', 'project memory'], ['quality', 'quality'], ['anticipate', 'anticipation'], ['device', 'device'], ['plan', 'contract plan']];

function main(argv, io) {
  io = io || { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  let o;
  try { o = parseArgs(argv); } catch (e) { io.err('forge-start: ' + e.message + '\n' + USAGE); return 1; }
  if (!ROOT) { io.err('forge-start: no project root found (no .claude, .forge or .git above this tool): nothing created'); return 1; }
  const sc = scrub(o.text);
  const text = oneLine(sc.text);
  const complexity = o.complexity || 'L2';
  const source = o.complexity ? 'flag' : 'default';
  const runId = mintRunId(new Date());
  if (!runId) { io.err('forge-start: could not find a free run id in the next two minutes: nothing created'); return 1; }
  const started = { agent: 'orchestrator', role: 'lead', runtime: 'internal', goal: oneLine(text, GOAL_MAX), complexity, complexity_source: source, started_by: 'forge-start' };
  if (oneLine(o.reason)) started.complexity_reason = oneLine(o.reason, 300);
  if (sc.redacted) started.goal_redacted = true;
  const rs = logEvent(runId, 'run_started', started);
  if (rs.status !== 0) {
    const msg = 'forge-start: run_started was refused (' + why(rs) + '): no run created';
    if (o.json) io.out(JSON.stringify({ ok: false, run_id: null, error: msg, steps: [] })); else io.err(msg);
    return 1;
  }
  // FB-INSTALL-2-F7: the run's config baseline (the "before" settings forge-configdrift compares against); a failure is named, never silent
  let baseNote;
  try { const b = require('./forge-configdrift.cjs').ensureBaseline(ROOT, runId); baseNote = b.written ? 'config baseline written' : 'config baseline already there'; }
  catch (e) { baseNote = 'config baseline NOT written (' + oneLine(String((e && e.message) || e), 160) + ')'; }
  const steps = [{ id: 'run', ok: true, logged: ['run_started'], note: runId + ' · complexity ' + complexity + (source === 'flag' ? ' (--complexity' + (started.complexity_reason ? ': ' + started.complexity_reason : '') + ')' : ' (default for a build request)') + (sc.redacted ? ' · a secret-looking part of the request was redacted' : '') + ' · ' + baseNote }];
  if (!o.json) {
    io.out('RUN ' + runId + ' created (complexity ' + complexity + ', ' + source + ')');
    io.out('[1/8] run: ' + steps[0].note + ' · run_started logged (agent orchestrator, runtime internal)');
  }
  let domains = null;
  STEPS.forEach(([id, label], i) => {
    let s;
    try {
      if (id === 'active-run') s = stepActiveRun(runId);
      else if (id === 'owner-prefs') s = stepOwnerPrefs(runId);
      else if (id === 'memory') s = stepMemory(runId);
      else if (id === 'quality') { s = stepQuality(runId, text); domains = s.domains; }
      else if (id === 'anticipate') s = stepAnticipate(runId, text);
      else if (id === 'device') s = stepDevice(runId, domains, text);
      else s = stepPlan(runId);
    } catch (e) { s = { ok: false, logged: [], note: 'internal error: ' + oneLine((e && e.message) || e, 200) }; }
    steps.push({ id, ok: s.ok, logged: s.logged, note: s.note });
    if (!o.json) {
      io.out('[' + (i + 2) + '/8] ' + label + ': ' + (s.ok ? '' : 'FAILED — ') + s.note + (s.logged.length ? ' · logged ' + s.logged.join(', ') : ''));
      for (const l of s.body || []) io.out(l);
    }
  });
  const next = 'node .claude/forge-bin/forge-runcontract.cjs check --run ' + runId + ' --phase preview --log-event';
  if (o.json) io.out(JSON.stringify({ ok: true, run_id: runId, complexity, complexity_source: source, steps, next }));
  else io.out('NEXT: ' + next);
  return 0;
}

module.exports = { main, parseArgs, mintRunId, graphLine, standingLines, MEMORY_FILES };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
