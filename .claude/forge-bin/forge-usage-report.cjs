#!/usr/bin/env node
'use strict';
// forge-usage-report: READ-ONLY usage baseline from Claude Code transcripts.
// Reads ONLY usage numbers + message metadata (model, id, timestamp, compact markers).
// Never prints message text, tool I/O, tokens or credentials. Token estimates = chars/4.
// Run ids are taken from tool_use command inputs (log-event / runcontract calls) by a strict
// id regex and are ONLY accepted when a matching .claude/forge-runs/<id>/ folder exists, so
// nothing but a known run id can ever leave a transcript.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const USAGE = [
  'usage: node forge-usage-report.cjs [options]',
  '  --json                 print JSON instead of the table',
  '  --project-dir <dir>    transcript folder (default ~/.claude/projects/<this project>)',
  '  --root <dir>           project root (default cwd); runs are read from <root>/.claude/forge-runs',
  '  --since <iso>          ignore transcript turns before this timestamp',
  '  --limit <n>            only the n most recent main transcripts',
  '  --by-run               tokens/turns/subagent turns/compactions per Forge run (adds "by_run")',
  '  --verifier             verifier PASS/FAIL, escalations, rework after completion (adds "verifier")',
  '  --cache                cache-read share per session and per subagent first turn (adds "cache")',
  '  --compare <a> <b>      deltas between two --json reports; a section whose transcript',
  '                         population differs is NOT given a delta (reason printed instead)',
  'JSON schema (additive; every v1 field is kept): generated, project_dir_found, loaded_text, main,',
  '  subagents, model_share, total_assistant_turns, schema ("forge-usage-report/2"), and with flags:',
  '  by_run {runs[{run_id, tokens{input,cache_read,cache_write,output,total}, main_turns,',
  '    subagent_turns, subagent_transcripts, compactions, tokens_measured, tokens_estimated,',
  '    attribution, method_turns, turns_after_first_completion}], unattributed, totals, method_note}',
  '  verifier {runs_scanned, totals, runs[], runs_with_rework_after_completion[]}',
  '  cache {summary{session_share_p50/p90, subagent_first_turn_share_p50/p90, ...}, sessions[]}',
  'Labels: "measured" = numbers Claude Code wrote into transcripts/events; "estimated" = an',
  '  attribution or size heuristic (date windows, segments, bytes/4).',
].join('\n');

function parseArgs(argv) {
  const o = { json: false, limit: 0, since: null, projectDir: null, root: null,
    byRun: false, verifier: false, cache: false, compare: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--project-dir') o.projectDir = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--by-run') o.byRun = true;
    else if (a === '--verifier') o.verifier = true;
    else if (a === '--cache') o.cache = true;
    else if (a === '--compare') o.compare = [argv[++i], argv[++i]];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const r4 = (x) => +(+x).toFixed(4);
const mean4 = (a) => (a.length ? r4(a.reduce((x, y) => x + y, 0) / a.length) : 0);
function pct(a, p) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const share = (t) => (t.ctx > 0 ? t.read / t.ctx : 0);
const RUN_ID_RE = /forge-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*/g;
// a transcript command that touches a run: the legacy forge-runs folder and (WP 2.1) the opt-in .forge/runs folder
const RUN_CMD_RE = /log-event|runcontract|forge-runs|\.forge[\\/]+runs/;

// One streaming pass per transcript: usage records, compaction timestamps, run-id markers.
async function scanTranscript(file, since, knownRuns) {
  const seen = new Map();
  const compactTs = [];
  const markers = [];
  let first = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const ts = typeof r.timestamp === 'string' ? r.timestamp : '';
    if (knownRuns && r.type === 'assistant' && r.message && Array.isArray(r.message.content)) {
      for (const c of r.message.content) {
        if (!c || c.type !== 'tool_use' || !c.input) continue;
        const s = JSON.stringify(c.input);
        if (!RUN_CMD_RE.test(s)) continue;
        for (const m of s.match(RUN_ID_RE) || []) if (knownRuns.has(m)) markers.push({ ts, run: m });
      }
    }
    if (since && ts && ts < since) continue;
    if (r.type === 'system' && r.subtype === 'compact_boundary') { compactTs.push(ts); continue; }
    if (r.type !== 'assistant' || !r.message || !r.message.usage) continue;
    const u = r.message.usage;
    const model = String(r.message.model || 'unknown');
    if (model === '<synthetic>') continue;
    const input = num(u.input_tokens), read = num(u.cache_read_input_tokens);
    const write = num(u.cache_creation_input_tokens), output = num(u.output_tokens);
    const key = r.message.id || r.uuid || String(seen.size);
    const prev = seen.get(key);
    const rec = { ctx: input + read + write, read, write, input, output, model, ts: prev ? prev.ts : ts };
    seen.set(key, rec);
    if (!first) first = rec;
  }
  markers.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { turns: Array.from(seen.values()), compactTs, markers, first };
}

function listTranscripts(dir) {
  const main = [], sub = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) main.push(p);
    else if (e.isDirectory()) {
      const sd = path.join(p, 'subagents');
      try {
        for (const f of fs.readdirSync(sd)) if (f.endsWith('.jsonl')) sub.push(path.join(sd, f));
      } catch (_) { /* none */ }
    }
  }
  return { main, sub };
}

function fileSize(p) {
  try { const s = fs.statSync(p); return { bytes: s.size, tokens_estimate: Math.round(s.size / 4) }; }
  catch (_) { return null; }
}

function loadedText(projectRoot, home) {
  const out = { note: 'bytes are file sizes; tokens_estimate = bytes/4 (ESTIMATE)', files: {} };
  const globalMd = path.join(home, '.claude', 'CLAUDE.md');
  const seen = new Set();
  function add(label, p) {
    if (seen.has(p)) return;
    seen.add(p);
    const s = fileSize(p);
    if (s) out.files[label] = s;
  }
  add('~/.claude/CLAUDE.md', globalMd);
  try {
    const txt = fs.readFileSync(globalMd, 'utf8');
    const re = /^@([\w./-]+\.md)\s*$/gm;
    let m;
    while ((m = re.exec(txt))) add('@' + m[1], path.join(home, '.claude', m[1]));
  } catch (_) { /* absent */ }
  add('project CLAUDE.md', path.join(projectRoot, 'CLAUDE.md'));
  add('.claude/commands/forge.md', path.join(projectRoot, '.claude', 'commands', 'forge.md'));
  add('skills/forge-router/SKILL.md', path.join(projectRoot, '.claude', 'skills', 'forge-router', 'SKILL.md'));
  let b = 0;
  for (const v of Object.values(out.files)) b += v.bytes;
  out.total_bytes = b;
  out.total_tokens_estimate = Math.round(b / 4);
  return out;
}

// ---- Forge run events (counts and timestamps only; event text is never kept) ----
const WORK_TYPES = new Set(['file_changed', 'fix_started', 'fix_completed', 'rework_task_created',
  'rework_assigned', 'rework_completed', 'agent_work_package_created', 'wp_completed', 'subagent_started',
  'subagent_completed', 'agent_started', 'agent_completed', 'ticket_created', 'retest_completed']);
const isVerifierAgent = (e) => /verif/i.test(String(e.agent || '')) || /verif/i.test(String(e.role || ''));
const verdictOf = (e) => {
  const v = String(e.verdict || e.status || e.result || '').trim().toUpperCase();
  return v.startsWith('PASS') ? 'PASS' : v.startsWith('FAIL') ? 'FAIL' : null;
};

// WP 2.1 state paths: forge-paths.cjs decides the layout (the opt-in .forge/ folder, else the legacy .claude/forge-*
// folders exactly as before). Guarded: a missing or older forge-paths.cjs keeps the legacy paths and never crashes.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function statePath(root, key, read) {
  const legacy = path.join(root, '.claude', 'forge-' + key);
  if (!forgePaths) return legacy;
  try { return forgePaths.layout(root) !== 'forge' ? legacy : (read ? forgePaths.resolveExisting(root, key) : forgePaths.stateDir(root, key)); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return legacy; }
}

function loadRuns(projectRoot) {
  const runs = new Map();
  // the runs folder(s) of this project's layout: legacy = .claude/forge-runs only (as before); forge = the active
  // folder first, then the legacy one (a run id already loaded from the active folder wins)
  const active = statePath(projectRoot, 'runs'), legacy = path.join(projectRoot, '.claude', 'forge-runs');
  for (const dir of active === legacy ? [legacy] : [active, legacy]) loadRunsFrom(dir, runs);
  return runs;
}

function loadRunsFrom(dir, runs) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return runs; }
  for (const e of ents) {
    if (!e.isDirectory() || !/^forge-/.test(e.name) || runs.has(e.name)) continue;
    const run = { id: e.name, start: null, end: null, events: [] };
    let txt = '';
    try { txt = fs.readFileSync(path.join(dir, e.name, 'events.jsonl'), 'utf8'); } catch (_) { /* none */ }
    for (const l of txt.split('\n')) {
      if (!l) continue;
      let r;
      try { r = JSON.parse(l); } catch (_) { continue; }
      const ts = typeof r.timestamp === 'string' ? r.timestamp : '';
      const ev = { type: String(r.event_type || ''), ts, verifier: isVerifierAgent(r), verdict: verdictOf(r) };
      run.events.push(ev);
      if (ts) {
        if (!run.start || ts < run.start) run.start = ts;
        if (!run.end || ts > run.end) run.end = ts;
      }
    }
    run.firstCompletion = run.events.filter((x) => x.type === 'run_completed' && x.ts).map((x) => x.ts).sort()[0] || null;
    runs.set(e.name, run);
  }
  return runs;
}

function verifierSection(runs) {
  const T = { wp_verified_pass: 0, wp_verified_fail: 0, verifier_check_pass: 0, verifier_check_fail: 0,
    all_check_pass: 0, all_check_fail: 0, escalations: 0 };
  const rows = [];
  for (const run of runs.values()) {
    const row = { run_id: run.id, wp_verified: { pass: 0, fail: 0 }, verifier_checks: { pass: 0, fail: 0 },
      all_checks: { pass: 0, fail: 0 }, escalations: 0, first_completion: run.firstCompletion,
      rework_events_after_completion: 0, rework_types: {} };
    for (const e of run.events) {
      if (e.type === 'wp_verified') {
        if (e.verdict === 'PASS') row.wp_verified.pass++; else if (e.verdict === 'FAIL') row.wp_verified.fail++;
      } else if (e.type === 'check_passed' || e.type === 'check_failed') {
        const k = e.type === 'check_passed' ? 'pass' : 'fail';
        row.all_checks[k]++;
        if (e.verifier) row.verifier_checks[k]++;
      } else if (e.type === 'escalation' || e.type === 'escalated') row.escalations++;
      if (run.firstCompletion && e.ts > run.firstCompletion && WORK_TYPES.has(e.type)) {
        row.rework_events_after_completion++;
        row.rework_types[e.type] = (row.rework_types[e.type] || 0) + 1;
      }
    }
    T.wp_verified_pass += row.wp_verified.pass; T.wp_verified_fail += row.wp_verified.fail;
    T.verifier_check_pass += row.verifier_checks.pass; T.verifier_check_fail += row.verifier_checks.fail;
    T.all_check_pass += row.all_checks.pass; T.all_check_fail += row.all_checks.fail;
    T.escalations += row.escalations;
    rows.push(row);
  }
  const vp = T.wp_verified_pass + T.verifier_check_pass, vf = T.wp_verified_fail + T.verifier_check_fail;
  T.verifier_pass = vp; T.verifier_fail = vf;
  T.verifier_fail_rate = vp + vf ? r4(vf / (vp + vf)) : null;
  T.escalations_per_fail = vf ? r4(T.escalations / vf) : null;
  T.runs_completed = rows.filter((r) => r.first_completion).length;
  const withRework = rows.filter((r) => r.rework_events_after_completion > 0)
    .sort((a, b) => b.rework_events_after_completion - a.rework_events_after_completion);
  T.runs_with_rework_after_completion = withRework.length;
  return { label: 'measured (event counts from .claude/forge-runs/*/events.jsonl)',
    note: 'verifier = wp_verified verdicts + check_passed/check_failed whose agent/role names a verifier; ' +
      'rework = work-type events after the first run_completed', runs_scanned: rows.length, totals: T,
    runs: rows.sort((a, b) => (a.run_id < b.run_id ? -1 : 1)),
    runs_with_rework_after_completion: withRework.map((r) => ({ run_id: r.run_id, events: r.rework_events_after_completion })) };
}

// ---- attribution of transcript usage to runs ----
function lastMarkerAt(markers, ts) {
  let hit = null;
  for (const m of markers) { if (m.ts <= ts) hit = m; else break; }
  return hit;
}
function dateWindow(runs, ts) {
  let best = null, n = 0;
  for (const r of runs.values()) {
    if (!r.start || ts < r.start || ts > r.end) continue;
    n++;
    if (!best || r.start > best.start) best = r;
  }
  return best ? { run: best.id, ambiguous: n > 1 } : null;
}
function attribute(t, ts, parentMarkers, runs) {
  if (!ts) return null;
  const ids = new Set(t.markers.map((m) => m.run));
  if (ids.size === 1) return { run: t.markers[0].run, method: 'marker' };
  const own = lastMarkerAt(t.markers, ts);
  if (own) return { run: own.run, method: 'marker_segment' };
  const par = parentMarkers ? lastMarkerAt(parentMarkers, ts) : null;
  if (par) return { run: par.run, method: 'parent_marker' };
  const dw = dateWindow(runs, ts);
  return dw ? { run: dw.run, method: 'date_window', ambiguous: dw.ambiguous } : null;
}

function byRunSection(mainScans, subScans, runs) {
  const per = new Map();
  const un = { turns: 0, tokens: 0, compactions: 0 };
  let ambiguous = 0;
  const get = (id) => {
    if (!per.has(id)) {
      per.set(id, { run_id: id, tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 },
        main_turns: 0, subagent_turns: 0, subagents: new Set(), compactions: 0, tokens_measured: 0,
        tokens_estimated: 0, method_turns: { marker: 0, marker_segment: 0, parent_marker: 0, date_window: 0 },
        turns_after_first_completion: 0 });
    }
    return per.get(id);
  };
  const parentOf = new Map(mainScans.map((s) => [s.session, s.markers]));
  for (const s of mainScans.concat(subScans)) {
    const pm = s.isSub ? parentOf.get(s.session) : null;
    for (const t of s.turns) {
      const tot = t.input + t.read + t.write + t.output;
      const a = attribute(s, t.ts, pm, runs);
      if (!a) { un.turns++; un.tokens += tot; continue; }
      if (a.ambiguous) ambiguous++;
      const p = get(a.run);
      p.tokens.input += t.input; p.tokens.cache_read += t.read; p.tokens.cache_write += t.write;
      p.tokens.output += t.output; p.tokens.total += tot;
      if (s.isSub) { p.subagent_turns++; p.subagents.add(s.file); } else p.main_turns++;
      p.method_turns[a.method]++;
      if (a.method === 'marker') p.tokens_measured += tot; else p.tokens_estimated += tot;
      const run = runs.get(a.run);
      if (run && run.firstCompletion && t.ts > run.firstCompletion) p.turns_after_first_completion++;
    }
    for (const ts of s.compactTs) {
      const a = attribute(s, ts, pm, runs);
      if (a) get(a.run).compactions++; else un.compactions++;
    }
  }
  const rows = Array.from(per.values()).map((p) => {
    const out = Object.assign({}, p, { subagent_transcripts: p.subagents.size });
    delete out.subagents;
    out.attribution = p.tokens_estimated === 0 ? 'measured' : p.tokens_measured === 0 ? 'estimated' : 'mixed';
    return out;
  }).sort((a, b) => b.tokens.total - a.tokens.total);
  const totals = { runs: rows.length, tokens_total: 0, tokens_measured: 0, tokens_estimated: 0 };
  for (const r of rows) { totals.tokens_total += r.tokens.total; totals.tokens_measured += r.tokens_measured; totals.tokens_estimated += r.tokens_estimated; }
  totals.measured_share = totals.tokens_total ? r4(totals.tokens_measured / totals.tokens_total) : 0;
  return {
    method_note: 'Transcripts carry no run_id field. The run id is read from tool_use command inputs ' +
      '(log-event/runcontract calls) and kept only when .claude/forge-runs/<id>/ exists. marker = the ' +
      'transcript names exactly one run (measured join); marker_segment = multi-run transcript, turn goes to ' +
      'the last named run (estimated); parent_marker = subagent with no marker, parent session segment ' +
      '(estimated); date_window = run event time window, latest-started run wins on overlap (estimated). ' +
      'Token numbers themselves are measured; only their assignment to a run can be estimated.',
    totals, unattributed: un, date_window_ambiguous_turns: ambiguous, runs: rows,
  };
}

function cacheSection(mainScans, subScans) {
  const sessions = [];
  for (const s of mainScans) {
    if (!s.turns.length) continue;
    let rd = 0, cx = 0;
    for (const t of s.turns) { rd += t.read; cx += t.ctx; }
    sessions.push({ session: s.session, turns: s.turns.length, mean_turn_share: mean4(s.turns.map(share)),
      token_weighted_share: cx ? r4(rd / cx) : 0 });
  }
  const firstShares = subScans.filter((s) => s.first).map((s) => share(s.first));
  const subShares = subScans.filter((s) => s.turns.length).map((s) => {
    let rd = 0, cx = 0;
    for (const t of s.turns) { rd += t.read; cx += t.ctx; }
    return cx ? rd / cx : 0;
  });
  const ss = sessions.map((x) => x.mean_turn_share);
  return {
    label: 'measured (share = cache_read / (input + cache_read + cache_creation) per turn)',
    summary: {
      sessions: sessions.length,
      session_share_mean: mean4(ss), session_share_p50: r4(pct(ss, 50)), session_share_p90: r4(pct(ss, 90)),
      subagent_first_turns: firstShares.length,
      subagent_first_turn_share_mean: mean4(firstShares),
      subagent_first_turn_share_p50: r4(pct(firstShares, 50)), subagent_first_turn_share_p90: r4(pct(firstShares, 90)),
      subagent_transcript_share_p50: r4(pct(subShares, 50)), subagent_transcript_share_p90: r4(pct(subShares, 90)),
    },
    sessions,
  };
}

/** claudeProjectSlug(dir) — Claude Code's folder name for a project under ~/.claude/projects: every character that is
 *  not a letter or digit becomes '-' (the same rule as forge-sync.cjs / forge-scribe-owner.cjs claudeProjectSlug). */
function claudeProjectSlug(dir) { return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-'); }
/** transcriptDirFor(projectRoot, home) -> ~/.claude/projects/<slug>, computed at run time (never a machine path in
 *  the source). The drive letter's case varies, so an existing folder that differs only in case is preferred. */
function transcriptDirFor(projectRoot, home) {
  const base = path.join(home, '.claude', 'projects');
  const slug = claudeProjectSlug(projectRoot);
  try {
    const hit = fs.readdirSync(base).find((n) => n.toLowerCase() === slug.toLowerCase());
    if (hit) return path.join(base, hit);
  } catch (_) { /* no projects folder yet */ }
  return path.join(base, slug);
}

async function buildReport(opts) {
  const home = opts.home || os.homedir();
  const projectRoot = opts.root || process.cwd();
  const dir = opts.projectDir || transcriptDirFor(projectRoot, home);
  const rep = { generated: new Date().toISOString(), project_dir_found: false, loaded_text: loadedText(projectRoot, home) };
  const lt = listTranscripts(dir);
  if (!lt) { rep.error = 'transcript folder missing'; return rep; }
  rep.project_dir_found = true;
  rep.schema = 'forge-usage-report/2';
  let files = lt.main.slice();
  if (opts.limit > 0) {
    files = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, opts.limit).map((x) => x.f);
  }
  const needRuns = opts.byRun || opts.verifier;
  const runs = needRuns ? loadRuns(projectRoot) : new Map();
  const known = opts.byRun ? new Set(runs.keys()) : null;
  const mainScans = [], subScans = [];
  for (const f of files) {
    const s = await scanTranscript(f, opts.since, known);
    Object.assign(s, { file: f, isSub: false, session: path.basename(f, '.jsonl') });
    mainScans.push(s);
  }
  const subFiles = lt.sub;
  for (const f of subFiles) {
    const s = await scanTranscript(f, opts.since, known);
    Object.assign(s, { file: f, isSub: true, session: path.basename(path.dirname(path.dirname(f))) });
    subScans.push(s);
  }
  const mt = [].concat(...mainScans.map((s) => s.turns));
  const st = [].concat(...subScans.map((s) => s.turns));
  const subFirst = subScans.filter((s) => s.first).map((s) => s.first);
  const all = mt.concat(st);
  const shareM = {};
  for (const t of all) shareM[t.model] = (shareM[t.model] || 0) + 1;
  for (const k of Object.keys(shareM)) shareM[k] = { turns: shareM[k], share: +(shareM[k] / all.length).toFixed(4) };
  rep.main = {
    transcripts: files.length,
    assistant_turns: mt.length,
    avg_context_tokens_per_turn: avg(mt.map((t) => t.ctx)),
    avg_cache_read_tokens_per_turn: avg(mt.map((t) => t.read)),
    compactions: mainScans.reduce((n, s) => n + s.compactTs.length, 0),
  };
  rep.subagents = {
    transcripts: subFiles.length,
    assistant_turns: st.length,
    first_turn_samples: subFirst.length,
    first_turn_context_p50: pct(subFirst.map((t) => t.ctx), 50),
    first_turn_cache_read_p50: pct(subFirst.map((t) => t.read), 50),
    first_turn_cache_write_p50: pct(subFirst.map((t) => t.write), 50),
    first_turn_cache_read_avg: avg(subFirst.map((t) => t.read)),
    first_turn_cache_write_avg: avg(subFirst.map((t) => t.write)),
  };
  rep.model_share = shareM;
  rep.total_assistant_turns = all.length;
  if (opts.byRun) rep.by_run = byRunSection(mainScans, subScans, runs);
  if (opts.verifier) rep.verifier = verifierSection(runs);
  if (opts.cache) rep.cache = cacheSection(mainScans, subScans);
  return rep;
}

// ---- compare two --json reports ----
const SECTIONS = [
  { name: 'main', pop: (r) => r.main && r.main.transcripts, label: 'measured' },
  { name: 'subagents', pop: (r) => r.subagents && r.subagents.transcripts, label: 'measured' },
  { name: 'cache.summary', pop: (r) => r.cache && [r.cache.summary.sessions, r.cache.summary.subagent_first_turns].join('/'), label: 'measured' },
  { name: 'verifier.totals', pop: (r) => r.verifier && r.verifier.runs_scanned, label: 'measured' },
  { name: 'by_run.totals', pop: (r) => r.by_run && r.by_run.totals.runs, label: 'estimated (run attribution)' },
  { name: 'loaded_text', pop: (r) => r.loaded_text && Object.keys(r.loaded_text.files || {}).length, label: null },
];
const at = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

function compareReports(a, b) {
  const out = { sections: [] };
  for (const sec of SECTIONS) {
    const A = at(a, sec.name), B = at(b, sec.name);
    if (!A || !B) { out.sections.push({ section: sec.name, status: 'missing', in_baseline: !!A, in_current: !!B }); continue; }
    const pa = sec.pop(a), pb = sec.pop(b);
    const row = { section: sec.name, population: { baseline: pa, current: pb }, deltas: [] };
    if (pa !== pb) {
      row.status = 'withheld';
      row.reason = 'population differs (' + pa + ' vs ' + pb + ' transcripts/samples): a delta would compare different sets';
    } else row.status = 'ok';
    for (const k of Object.keys(B)) {
      if (typeof A[k] !== 'number' || typeof B[k] !== 'number') continue;
      const label = sec.label || (/estimate/.test(k) ? 'estimated' : 'measured');
      const d = { field: k, baseline: A[k], current: B[k], label };
      if (row.status === 'ok') { d.delta = r4(B[k] - A[k]); d.delta_pct = A[k] ? r4(((B[k] - A[k]) / A[k]) * 100) : null; }
      row.deltas.push(d);
    }
    out.sections.push(row);
  }
  return out;
}

function compareTable(c) {
  const L = [];
  for (const s of c.sections) {
    if (s.status === 'missing') { L.push('[' + s.section + '] missing in ' + (s.in_baseline ? 'current' : 'baseline') + ' report'); continue; }
    L.push('[' + s.section + '] population ' + s.population.baseline + ' -> ' + s.population.current +
      (s.status === 'withheld' ? '  DELTA WITHHELD: ' + s.reason : ''));
    for (const d of s.deltas) {
      L.push('  ' + d.field + ': ' + d.baseline + ' -> ' + d.current +
        (d.delta === undefined ? '' : '  (' + (d.delta >= 0 ? '+' : '') + d.delta + (d.delta_pct == null ? '' : ', ' + d.delta_pct + '%') + ')') +
        '  [' + d.label + ']');
    }
  }
  return L.join('\n');
}

function table(r) {
  const L = [];
  if (r.error) L.push('ERROR: ' + r.error);
  if (r.main) {
    L.push('main sessions      : ' + r.main.transcripts + ' transcripts, ' + r.main.assistant_turns + ' turns');
    L.push('avg context/turn   : ' + r.main.avg_context_tokens_per_turn);
    L.push('avg cache-read/turn: ' + r.main.avg_cache_read_tokens_per_turn);
    L.push('compactions        : ' + r.main.compactions);
    L.push('subagents          : ' + r.subagents.transcripts + ' transcripts, first-turn p50 read ' +
      r.subagents.first_turn_cache_read_p50 + ' / write ' + r.subagents.first_turn_cache_write_p50);
    for (const [m, v] of Object.entries(r.model_share)) L.push('  model ' + m + ': ' + v.turns + ' (' + (v.share * 100).toFixed(1) + '%)');
  }
  L.push('always-loaded text (bytes, tokens ESTIMATE = bytes/4):');
  for (const [k, v] of Object.entries(r.loaded_text.files)) L.push('  ' + k + ': ' + v.bytes + ' B, ~' + v.tokens_estimate + ' tok');
  L.push('  total: ' + r.loaded_text.total_bytes + ' B, ~' + r.loaded_text.total_tokens_estimate + ' tok');
  if (r.by_run) {
    const t = r.by_run.totals;
    L.push('by run (tokens = input+cache_read+cache_write+output; measured share ' + t.measured_share + '):');
    for (const x of r.by_run.runs) {
      L.push('  ' + x.run_id + ': ' + x.tokens.total + ' tok [' + x.attribution + '], main ' + x.main_turns +
        ' / sub ' + x.subagent_turns + ' turns, compactions ' + x.compactions + ', after-completion turns ' + x.turns_after_first_completion);
    }
    L.push('  unattributed: ' + r.by_run.unattributed.turns + ' turns, ' + r.by_run.unattributed.tokens + ' tok');
  }
  if (r.verifier) {
    const v = r.verifier.totals;
    L.push('verifier (measured): PASS ' + v.verifier_pass + ' / FAIL ' + v.verifier_fail + ', fail rate ' + v.verifier_fail_rate +
      ', escalations ' + v.escalations + ' (per FAIL ' + v.escalations_per_fail + '); all checks ' + v.all_check_pass + '/' + v.all_check_fail);
    L.push('  runs with rework after completion: ' + v.runs_with_rework_after_completion + ' of ' + v.runs_completed + ' completed');
    for (const x of r.verifier.runs_with_rework_after_completion) L.push('    ' + x.run_id + ': ' + x.events + ' work events');
  }
  if (r.cache) {
    const c = r.cache.summary;
    L.push('cache-read share (measured): sessions p50 ' + c.session_share_p50 + ' / p90 ' + c.session_share_p90 +
      '; subagent first turn p50 ' + c.subagent_first_turn_share_p50 + ' / p90 ' + c.subagent_first_turn_share_p90);
  }
  return L.join('\n');
}

module.exports = { buildReport, parseArgs, table, compareReports, compareTable, USAGE, claudeProjectSlug, transcriptDirFor };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  if (o.compare) {
    let a, b;
    try { a = JSON.parse(fs.readFileSync(o.compare[0], 'utf8')); b = JSON.parse(fs.readFileSync(o.compare[1], 'utf8')); }
    catch (e) { process.stderr.write('compare: cannot read both reports (' + (e.code || 'invalid JSON') + ')\n'); process.exit(2); }
    const c = compareReports(a, b);
    process.stdout.write((o.json ? JSON.stringify(c, null, 2) : compareTable(c)) + '\n');
    process.exit(0);
  }
  buildReport(o).then((r) => {
    process.stdout.write((o.json ? JSON.stringify(r, null, 2) : table(r)) + '\n');
  }).catch((e) => { process.stderr.write('usage-report failed: ' + e.message + '\n'); process.exit(1); });
}
