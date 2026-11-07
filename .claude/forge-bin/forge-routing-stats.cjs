#!/usr/bin/env node
'use strict';
/**
 * forge-routing-stats.cjs - telemetry-free ROUTING STATISTICS from the owner's own runs (`/forge stats`,
 * work package 3.5). Zero dependencies, READ-ONLY: it opens run folders with fs.readFileSync only and writes
 * nothing. Nothing leaves the machine.
 *
 * What it reads: every run's events.jsonl in BOTH run layouts (legacy `.claude/forge-runs` and the opt-in
 * `.forge/runs`, via forge-paths.cjs existingStateDirs, active first, a run id counted once) plus the presence
 * of `run-finalized.json`. What it prints: counts and LABELS only (event types, run ids, agent slugs, route /
 * model / effort labels from fixed allowlists, verdicts, timestamps). It never prints prompt text, notes,
 * summaries, evidence, commands or any other message content; unknown labels become "other".
 *
 * GOAT honesty rule: a package is counted under the route it ACTUALLY ran on (route/model/effort on its
 * completion or dispatch event, an `escalation.to`, an observed model), never under the intended route on its
 * `agent_work_package_created` / `route_assigned` event. A package with only an intended route is reported as
 * "actual route not recorded". Metrics without data say "not recorded"; false passes are "not measurable"
 * unless later evidence for the same package contradicts a PASS. No savings claims; cost appears only as the
 * sum of `cost_sampled` events (what forge-cost.cjs records), labelled as logged.
 *
 * Usage: node forge-routing-stats.cjs [--json] [--since <YYYY-MM-DD>] [--runs <n>] [--trend <n>] [--root <dir>]
 * Exit codes: 0 ok (including zero runs) · 1 real error / no project root · 2 usage error.
 */
const fs = require('fs');
const path = require('path');

const tryRequire = (name) => { try { return require(path.join(__dirname, name)); } catch { return null; } };
const forgePaths = tryRequire('forge-paths.cjs');
const forgeStats = tryRequire('forge-stats.cjs');

const ROUTES = ['quick', 'build', 'deep', 'escalate', 'triage', 'verifier'];
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Where a package's route/model/effort is taken from. INTENDED = the plan; USED = what actually ran.
const INTENDED_ROUTE_TYPES = new Set(['agent_work_package_created', 'route_assigned']);
const USED_ROUTE_TYPES = new Set(['wp_completed', 'agent_completed', 'wp_failed', 'subagent_started', 'agent_started']);
const COMPLETION_TYPES = new Set(['wp_completed', 'agent_completed', 'subagent_completed']);
const FAILURE_TYPES = new Set(['wp_failed', 'agent_failed', 'subagent_failed']);
const DISPATCH_TYPES = new Set(['subagent_started', 'agent_started']);
const CONTRADICTS_PASS = new Set(['wp_failed', 'check_failed']);
const REWORK_TYPES = new Set(['rework_task_created', 'rework_assigned']);
const DEFAULT_TREND = 10;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ---- label normalisation (allowlists only: free text never reaches the output) ----
/** pickOne(value, list) -> the ONE allowlisted token found in value, null when none or several differ
 *  (e.g. "A low / B high" is ambiguous, "not recorded in the journal" has none). */
function pickOne(value, list) {
  if (value == null || typeof value === 'object') return null;
  const found = new Set(String(value).toLowerCase().split(/[^a-z]+/).filter((w) => list.includes(w)));
  return found.size === 1 ? [...found][0] : null;
}
const normRoute = (v) => pickOne(v, ROUTES);
const normModel = (v) => pickOne(v, MODELS);
const normEffort = (v) => pickOne(v, EFFORTS);
function wpKeyOf(e) {
  for (const k of ['wp_id', 'work_package', 'wp']) {
    const v = e[k];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim().slice(0, 120);
  }
  return null;
}
function makeAgentNormaliser(registryFile) {
  const map = forgeStats && registryFile ? forgeStats.loadRegistrySlugMap(registryFile) : new Map();
  // registeredOnly: the creator of a work package is often the Lead ("orchestrator"), not its worker, so a
  // creation event names the package's agent only when that name is a registered agent.
  return (raw, registeredOnly) => {
    if (raw == null || typeof raw === 'object') return null;
    const s = String(raw).trim();
    if (!s) return null;
    const hit = forgeStats ? forgeStats.canonicalSlug(map, s) : null;
    if (hit || registeredOnly) return hit || null;
    const slug = s.toLowerCase().replace(/\s+/g, '-');
    return SAFE_SLUG.test(slug) ? slug : 'other';
  };
}

// ---- reading ----
/** readRunFolder(dir, id) -> {id, status:'ok'|'no-events'|'corrupt'|'unreadable'|'link', events, malformed, receipt}.
 *  Never throws. A run folder or events file that is a symlink/junction is skipped (never followed). */
function readRunFolder(dir, id) {
  const out = { id, status: 'ok', events: [], malformed: 0, receipt: false };
  try { if (fs.lstatSync(dir).isSymbolicLink()) { out.status = 'link'; return out; } } catch { out.status = 'unreadable'; return out; }
  const file = path.join(dir, 'events.jsonl');
  let raw;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) { out.status = 'link'; return out; }
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) { out.status = e && e.code === 'ENOENT' ? 'no-events' : 'unreadable'; return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.event_type === 'string') out.events.push(v); else out.malformed++; }
    catch { out.malformed++; }
  }
  if (!out.events.length) out.status = out.malformed ? 'corrupt' : 'no-events';
  try { out.receipt = fs.statSync(path.join(dir, 'run-finalized.json')).isFile(); } catch { out.receipt = false; }
  return out;
}
/** runFolders(runsDirs) -> [[id, dir]], active folder first, a run id counted once, unsafe folder names skipped. */
function runFolders(runsDirs) {
  const out = [], seen = new Set();
  let unsafe = 0, operational = 0;
  for (const base of runsDirs) {
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!(e.isDirectory() || e.isSymbolicLink()) || seen.has(e.name)) continue;
      if (/^[._]/.test(e.name)) { operational++; continue; } // _hooks, _testlogs, .hotspot-locks: tool folders, not runs
      if (!SAFE_ID.test(e.name)) { unsafe++; continue; }
      seen.add(e.name); out.push([e.name, path.join(base, e.name)]);
    }
  }
  return { folders: out, unsafe, operational };
}
function runsDirsFor(root) {
  const legacy = path.join(root, '.claude', 'forge-runs');
  if (forgePaths && typeof forgePaths.existingStateDirs === 'function') {
    try { return forgePaths.existingStateDirs(root, 'runs'); } catch { /* unreadable layout: legacy below */ }
  }
  return fs.existsSync(legacy) ? [legacy] : [];
}

// ---- analysing one run ----
const tsOf = (e) => { const t = Date.parse(e.timestamp); return Number.isFinite(t) ? t : null; };
function newUnit() { return { agent: null, route: null, intended: null, model: null, modelObserved: false, modelRank: 0, effort: null, escalations: 0, escalatedFrom: [], verdicts: [], secondFail: false, contradictedPasses: 0, retryRounds: 0 }; }
const MODEL_RANK = { agent_model_used: 4, observed: 3, completion: 2, dispatch: 1 };

function setModel(u, model, rank, observed) {
  if (model && rank >= u.modelRank) { u.model = model; u.modelRank = rank; u.modelObserved = observed; }
}

/** analyzeRun(run, agentOf) -> per-run summary built from event labels only. */
function analyzeRun(run, agentOf) {
  const wps = new Map();
  const loose = []; // dispatches without a work-package id
  const unit = (k) => wps.get(k) || (wps.set(k, newUnit()), wps.get(k));
  const openPasses = new Map(); // wp+area -> PASS verdicts not yet contradicted
  const lastVerdict = new Map(); // wp+area -> the latest verdict
  let rework = 0, escalationEvents = 0, finalizedEvent = false, completed = false;
  const reviews = { pass: 0, fail: 0, other: 0 };
  const costs = { events: 0, cost: 0, costEvents: 0, tokens: 0, tokenEvents: 0 };
  const times = [];
  for (const e of run.events) {
    const et = e.event_type, k = wpKeyOf(e), ts = tsOf(e);
    if (ts !== null) times.push(ts);
    if (et === 'run_finalized') finalizedEvent = true;
    else if (et === 'run_completed') completed = true;
    else if (REWORK_TYPES.has(et)) rework++;
    else if (et === 'review_completed') {
      const v = String(e.verdict != null ? e.verdict : (e.review_verdict != null ? e.review_verdict : '')).toLowerCase();
      if (/^pass/.test(v)) reviews.pass++; else if (/fail|changes|block/.test(v)) reviews.fail++; else reviews.other++;
    } else if (et === 'cost_sampled') {
      costs.events++;
      if (Number.isFinite(e.cost)) { costs.cost += e.cost; costs.costEvents++; }
      if (Number.isFinite(e.tokens)) { costs.tokens += e.tokens; costs.tokenEvents++; }
    }
    if (!k) {
      if (DISPATCH_TYPES.has(et)) {
        const u = newUnit();
        u.agent = agentOf(e.agent); u.route = normRoute(e.route); u.effort = normEffort(e.effort);
        setModel(u, normModel(e.model_observed), MODEL_RANK.observed, true);
        setModel(u, normModel(e.model), MODEL_RANK.dispatch, false);
        loose.push(u);
      }
      continue;
    }
    const u = unit(k);
    if (INTENDED_ROUTE_TYPES.has(et)) {
      if (!u.intended) u.intended = normRoute(e.route);
      if (!u.agent && et === 'agent_work_package_created') u.agent = agentOf(e.agent, true);
    }
    if (USED_ROUTE_TYPES.has(et)) {
      const r = normRoute(e.route);
      const isCompletion = !DISPATCH_TYPES.has(et);
      if (r && (isCompletion || !u.route)) u.route = r;
      const eff = normEffort(e.effort);
      if (eff && (isCompletion || !u.effort)) u.effort = eff;
      setModel(u, normModel(e.model), isCompletion ? MODEL_RANK.completion : MODEL_RANK.dispatch, false);
      if (DISPATCH_TYPES.has(et)) setModel(u, normModel(e.model_observed), MODEL_RANK.observed, true);
      const a = agentOf(e.agent);
      if (a && (isCompletion || DISPATCH_TYPES.has(et))) u.agent = a;
    } else if (COMPLETION_TYPES.has(et)) {
      const a = agentOf(e.agent); if (a) u.agent = a;
    }
    if (et === 'agent_model_used') setModel(u, normModel(e.model), MODEL_RANK.agent_model_used, true);
    if (et === 'escalation') {
      escalationEvents++; u.escalations++;
      u.escalatedFrom.push(normRoute(e.from) || u.route || null);
      const to = normRoute(e.to); if (to) u.route = to;
      // the model/effort seen so far belong to the attempt BEFORE the escalation: the escalated attempt reports its own
      u.model = null; u.modelRank = 0; u.modelObserved = false; u.effort = null;
    }
    if (et === 'wp_verified') {
      // One package can get several verdicts for DIFFERENT areas (the `area` field): a PASS for area A is only
      // contradicted by a later FAIL for the SAME area, or by a package-level wp_failed / check_failed.
      const v = String(e.verdict || '').toUpperCase();
      const verdict = v === 'PASS' ? 'PASS' : (v === 'FAIL' ? 'FAIL' : null);
      if (verdict) {
        const area = typeof e.area === 'string' && e.area.trim() ? e.area.trim().slice(0, 80) : '';
        const ak = k + '\u0000' + area;
        if (lastVerdict.get(ak) === 'FAIL') u.retryRounds++;
        if (verdict === 'FAIL' && u.escalations > 0) u.secondFail = true;
        if (verdict === 'FAIL') contradict(u, ak);
        u.verdicts.push(verdict);
        lastVerdict.set(ak, verdict);
        if (verdict === 'PASS') openPasses.set(ak, (openPasses.get(ak) || 0) + 1);
      }
    } else if (CONTRADICTS_PASS.has(et)) {
      for (const ak of openPasses.keys()) if (ak.split('\u0000')[0] === k) contradict(u, ak);
    }
  }
  function contradict(u, ak) { const open = openPasses.get(ak) || 0; if (open) { u.contradictedPasses += open; openPasses.set(ak, 0); } }
  times.sort((a, b) => a - b);
  return {
    id: run.id, events: run.events.length, malformed: run.malformed,
    start: times.length ? times[0] : null,
    durationMs: times.length >= 2 ? times[times.length - 1] - times[0] : null,
    status: run.receipt || finalizedEvent ? 'finalized' : (completed ? 'completed-not-finalized' : 'open'),
    wps: [...wps.values()], loose, rework, escalationEvents, reviews, costs,
  };
}

// ---- aggregation ----
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; return o; };
function quantile(sorted, q) { if (!sorted.length) return null; return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]; }
function median(sorted) { if (!sorted.length) return null; const m = sorted.length >> 1; return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; }
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const newRouteRow = () => ({ packages: 0, models: {}, efforts: {}, model_observed: 0, escalated_from: 0 });
const newAgentRow = () => ({ units: 0, packages: 0, routes: {}, models: {}, efforts: {}, model_observed: 0 });

/** computeRoutingStats(runsDirs, opts) -> stats object. opts: {since, runs, trend, registryFile, anticipate}. Never throws on bad runs. */
function computeRoutingStats(runsDirs, opts) {
  opts = opts || {};
  const agentOf = makeAgentNormaliser(opts.registryFile);
  const { folders, unsafe, operational } = runFolders(Array.isArray(runsDirs) ? runsDirs : [runsDirs]);
  const skipped = { 'no-events': 0, corrupt: 0, unreadable: 0, link: 0, 'unsafe-name': unsafe, 'tool-folder': operational, 'no-timestamp (with --since)': 0 };
  let summaries = [], malformed = 0;
  for (const [id, dir] of folders) {
    const run = readRunFolder(dir, id);
    if (run.status !== 'ok') { skipped[run.status]++; continue; }
    malformed += run.malformed;
    try { summaries.push(analyzeRun(run, agentOf)); } catch { skipped.corrupt++; }
  }
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  if (sinceMs !== null) {
    skipped['no-timestamp (with --since)'] = summaries.filter((s) => s.start === null).length;
    summaries = summaries.filter((s) => s.start !== null && s.start >= sinceMs);
  }
  summaries.sort((a, b) => (a.start === b.start ? a.id.localeCompare(b.id) : (a.start === null ? -1 : (b.start === null ? 1 : a.start - b.start))));
  if (Number.isFinite(opts.runs) && opts.runs > 0) summaries = summaries.slice(-opts.runs);

  const perRoute = {}, perAgent = {};
  const totals = { packages: 0, packages_actual_route: 0, packages_intended_only: 0, packages_no_route: 0, dispatches_without_wp: 0,
    escalations: 0, escalated_packages: 0, second_fails: 0, verdict_pass: 0, verdict_fail: 0, contradicted_passes: 0,
    retry_rounds: 0, rework_events: 0, failure_kinds: {} };
  const reviews = { pass: 0, fail: 0, other: 0 };
  const cost = { cost_sampled_events: 0, cost_usd_logged: 0, cost_events_with_amount: 0, tokens_logged: 0, token_events: 0 };
  const status = { finalized: 0, 'completed-not-finalized': 0, open: 0 };
  let runsWithRoute = 0, runsIntendedOnly = 0;
  const eventsPer = [], durations = [];
  const addAgent = (u, isPkg) => {
    if (!u.agent) return;
    const a = perAgent[u.agent] || (perAgent[u.agent] = newAgentRow());
    a.units++; if (isPkg) a.packages++;
    if (u.route) inc(a.routes, u.route);
    if (u.model) { inc(a.models, u.model); if (u.modelObserved) a.model_observed++; }
    if (u.effort) inc(a.efforts, u.effort);
  };
  for (const s of summaries) {
    status[s.status]++;
    eventsPer.push(s.events);
    if (s.durationMs !== null) durations.push(s.durationMs);
    totals.rework_events += s.rework;
    totals.escalations += s.escalationEvents;
    for (const k of Object.keys(reviews)) reviews[k] += s.reviews[k];
    cost.cost_sampled_events += s.costs.events; cost.cost_usd_logged += s.costs.cost; cost.cost_events_with_amount += s.costs.costEvents;
    cost.tokens_logged += s.costs.tokens; cost.token_events += s.costs.tokenEvents;
    let hasRoute = false, hasIntended = false;
    for (const u of s.wps) {
      totals.packages++;
      if (u.route) {
        hasRoute = true; totals.packages_actual_route++;
        const r = perRoute[u.route] || (perRoute[u.route] = newRouteRow());
        r.packages++;
        if (u.model) { inc(r.models, u.model); if (u.modelObserved) r.model_observed++; }
        if (u.effort) inc(r.efforts, u.effort);
      } else if (u.intended) { hasIntended = true; totals.packages_intended_only++; }
      else totals.packages_no_route++;
      for (const from of u.escalatedFrom) { const r = perRoute[from || 'not-recorded'] || (perRoute[from || 'not-recorded'] = newRouteRow()); r.escalated_from++; }
      if (u.escalations) totals.escalated_packages++;
      if (u.secondFail) totals.second_fails++;
      for (const v of u.verdicts) totals[v === 'PASS' ? 'verdict_pass' : 'verdict_fail']++;
      totals.contradicted_passes += u.contradictedPasses;
      totals.retry_rounds += u.retryRounds;
      addAgent(u, true);
    }
    for (const u of s.loose) { totals.dispatches_without_wp++; addAgent(u, false); }
    if (hasRoute) runsWithRoute++; else if (hasIntended) runsIntendedOnly++;
  }
  eventsPer.sort((a, b) => a - b); durations.sort((a, b) => a - b);
  const trendN = Number.isFinite(opts.trend) && opts.trend > 0 ? opts.trend : DEFAULT_TREND;
  const trend = summaries.slice(-trendN).map((s) => ({
    run_id: s.id, start: s.start === null ? null : new Date(s.start).toISOString(), events: s.events,
    packages: s.wps.length, with_actual_route: s.wps.filter((u) => u.route).length,
    escalations: s.escalationEvents, verify_pass: s.wps.reduce((n, u) => n + u.verdicts.filter((v) => v === 'PASS').length, 0),
    verify_fail: s.wps.reduce((n, u) => n + u.verdicts.filter((v) => v === 'FAIL').length, 0),
    status: s.status, duration_min: s.durationMs === null ? null : Math.round(s.durationMs / 6000) / 10,
  }));
  const verdicts = totals.verdict_pass + totals.verdict_fail;
  return {
    generated_at: new Date().toISOString(),
    runs_measured: summaries.length, runs_with_route_data: runsWithRoute, runs_with_intended_route_only: runsIntendedOnly,
    skipped, malformed_lines_skipped: malformed, filters: { since: opts.since || null, runs: opts.runs || null },
    per_route: perRoute, per_agent: perAgent, totals,
    rates: {
      escalation_rate_pct: totals.packages ? pct(totals.escalated_packages, totals.packages) : 'not recorded',
      escalation_rate_routed_pct: totals.packages_actual_route ? pct(totals.escalated_packages, totals.packages_actual_route) : 'not recorded',
      verifier_pass_rate_pct: verdicts ? pct(totals.verdict_pass, verdicts) : 'not recorded',
      false_pass: totals.verdict_pass === 0 ? 'not recorded'
        : (totals.contradicted_passes ? { contradicted: totals.contradicted_passes, of_passes: totals.verdict_pass, rate_pct: pct(totals.contradicted_passes, totals.verdict_pass) }
          : 'not measurable (no later evidence contradicts a PASS)'),
    },
    reviews_completed: reviews.pass + reviews.fail + reviews.other ? reviews : 'not recorded',
    runs_status: status,
    events_per_run: { median: median(eventsPer), p90: quantile(eventsPer, 0.9) },
    duration_min: durations.length ? { runs: durations.length, median: Math.round(median(durations) / 6000) / 10, p90: Math.round(quantile(durations, 0.9) / 6000) / 10 } : 'not recorded',
    cost: cost.cost_sampled_events ? Object.assign({ label: 'as logged by forge-cost (cost_sampled events); not a savings figure' }, cost) : 'not recorded',
    trend,
    owner_corrections: opts.anticipate === undefined ? 'not requested' : opts.anticipate,
  };
}

// ---- output ----
const mix = (o) => { const ks = Object.keys(o); return ks.length ? ks.sort().map((k) => k + ':' + o[k]).join(' ') : 'not recorded'; };
function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join(' | ').trimEnd());
}
const show = (v) => (v === null || v === undefined ? 'not recorded' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
function formatText(st) {
  const L = [];
  const t = st.totals;
  L.push('Forge routing stats - measured from ' + st.runs_measured + ' runs, ' + st.runs_with_route_data + ' with route data (actual route)'
    + (st.runs_with_intended_route_only ? ', ' + st.runs_with_intended_route_only + ' with an intended route only' : ''));
  const sk = Object.entries(st.skipped).filter(([, n]) => n).map(([k, n]) => k + ' ' + n);
  L.push('skipped: ' + (sk.length ? sk.join(', ') : 'none') + (st.malformed_lines_skipped ? ' · malformed lines skipped: ' + st.malformed_lines_skipped : '')
    + (st.filters.since ? ' · since ' + st.filters.since : '') + (st.filters.runs ? ' · last ' + st.filters.runs + ' runs' : ''));
  L.push('packages: ' + t.packages + ' (actual route ' + t.packages_actual_route + ', intended route only ' + t.packages_intended_only + ', no route ' + t.packages_no_route + ') · dispatches without a package id: ' + t.dispatches_without_wp);
  L.push('');
  const routes = Object.keys(st.per_route).sort();
  if (routes.length) {
    L.push('Per route (actual):');
    L.push(...table([['route', 'packages', 'models', 'efforts', 'observed', 'escalated-from']].concat(routes.map((r) => {
      const x = st.per_route[r]; return [r, x.packages, mix(x.models), mix(x.efforts), x.model_observed, x.escalated_from];
    }))).map((s) => '  ' + s));
  } else L.push('Per route (actual): not recorded');
  const agents = Object.keys(st.per_agent).sort();
  if (agents.length) {
    L.push('Per agent:');
    L.push(...table([['agent', 'units', 'packages', 'routes', 'models', 'efforts']].concat(agents.map((a) => {
      const x = st.per_agent[a]; return [a, x.units, x.packages, mix(x.routes), mix(x.models), mix(x.efforts)];
    }))).map((s) => '  ' + s));
  } else L.push('Per agent: not recorded');
  L.push('');
  L.push('Escalations: ' + t.escalations + ' event(s), ' + t.escalated_packages + ' package(s), rate ' + show(st.rates.escalation_rate_pct) + (typeof st.rates.escalation_rate_pct === 'number' ? '%' : '') + ' of all packages, ' + show(st.rates.escalation_rate_routed_pct) + (typeof st.rates.escalation_rate_routed_pct === 'number' ? '%' : '') + ' of routed packages · second FAIL after escalation: ' + t.second_fails);
  L.push('Verifier (wp_verified): PASS ' + t.verdict_pass + ' / FAIL ' + t.verdict_fail + ' · pass rate ' + show(st.rates.verifier_pass_rate_pct) + (typeof st.rates.verifier_pass_rate_pct === 'number' ? '%' : '') + ' · false pass: ' + show(st.rates.false_pass));
  L.push('Reviews (review_completed): ' + show(st.reviews_completed) + ' · retry rounds after a FAIL: ' + t.retry_rounds + ' · rework events: ' + t.rework_events);
  L.push('Runs: finalized ' + st.runs_status.finalized + ' · completed, not finalized ' + st.runs_status['completed-not-finalized'] + ' · open ' + st.runs_status.open);
  L.push('Events per run: median ' + show(st.events_per_run.median) + ', p90 ' + show(st.events_per_run.p90) + ' · duration (min): ' + (typeof st.duration_min === 'object' ? 'median ' + st.duration_min.median + ', p90 ' + st.duration_min.p90 + ' over ' + st.duration_min.runs + ' runs' : st.duration_min));
  L.push('Cost: ' + (typeof st.cost === 'object' ? st.cost.cost_sampled_events + ' cost_sampled event(s), $' + st.cost.cost_usd_logged.toFixed(2) + ' and ' + st.cost.tokens_logged + ' tokens as logged by forge-cost (no savings claim)' : st.cost));
  const oc = st.owner_corrections;
  L.push('Owner corrections (forge-anticipate metric, as-is): ' + (oc && typeof oc === 'object' ? (oc.message || JSON.stringify(oc)) : show(oc)));
  if (st.trend.length) {
    L.push('');
    L.push('Trend (last ' + st.trend.length + ' runs, oldest first):');
    L.push(...table([['run', 'events', 'pkgs', 'routed', 'esc', 'pass/fail', 'status', 'min']].concat(st.trend.map((r) => [r.run_id, r.events, r.packages, r.with_actual_route, r.escalations, r.verify_pass + '/' + r.verify_fail, r.status, r.duration_min === null ? '-' : r.duration_min]))).map((s) => '  ' + s));
  }
  return L.join('\n');
}

// ---- CLI ----
const USAGE = 'Usage: node forge-routing-stats.cjs [--json] [--since <YYYY-MM-DD>] [--runs <n>] [--trend <n>] [--root <dir>]';
function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || String(v).startsWith('--')) throw new Error(a + ' needs a value'); return v; };
    try {
      if (a === '--json') o.json = true;
      else if (a === '--since') { o.since = val(); if (!Number.isFinite(Date.parse(o.since))) throw new Error('--since must be a date (YYYY-MM-DD)'); }
      else if (a === '--runs' || a === '--trend') { const n = Number(val()); if (!Number.isInteger(n) || n < 1) throw new Error(a + ' must be a whole number >= 1'); o[a.slice(2)] = n; }
      else if (a === '--root') o.root = val();
      else if (a === '--help' || a === '-h') o.help = true;
      else throw new Error('unknown argument: ' + a);
    } catch (e) { o.error = e.message; break; }
  }
  return o;
}
function resolveRoot(o) {
  if (o.root) return path.resolve(o.root);
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  if (forgePaths && typeof forgePaths.scriptRoot === 'function') { try { return forgePaths.scriptRoot(__dirname); } catch { return null; } }
  return path.resolve(__dirname, '..', '..');
}
function ownerCorrections(root, since) {
  const a = tryRequire('forge-anticipate.cjs');
  if (!a || typeof a.metric !== 'function') return { available: false, message: 'forge-anticipate.cjs metric not available' };
  try { const r = a.metric({ root, since }); return r; } catch (e) { return { available: false, message: 'forge-anticipate metric failed: ' + String(e && e.message).slice(0, 200) }; }
}
/** main(argv, io?) -> exit code. io = {out, err} line writers (default console). */
function main(argv, io) {
  io = io || { out: (s) => console.log(s), err: (s) => console.error(s) };
  const o = parseArgs(argv);
  if (o.help) { io.out(USAGE); return 0; }
  if (o.error) { io.err('forge-routing-stats: ' + o.error); io.err(USAGE); return 2; }
  const root = resolveRoot(o);
  if (!root) { io.err('forge-routing-stats: no project root found (no .claude, .forge or .git above the current folder; use --root or FORGE_PROJECT_ROOT)'); return 1; }
  try { if (!fs.statSync(root).isDirectory()) throw new Error('not a folder'); } catch { io.err('forge-routing-stats: --root is not an existing folder: ' + root); return 1; }
  const st = computeRoutingStats(runsDirsFor(root), {
    since: o.since, runs: o.runs, trend: o.trend,
    registryFile: path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'),
    anticipate: ownerCorrections(root, o.since),
  });
  io.out(o.json ? JSON.stringify(st, null, 2) : formatText(st));
  return 0;
}

module.exports = { computeRoutingStats, analyzeRun, readRunFolder, runFolders, runsDirsFor, formatText, parseArgs, main, normRoute, normModel, normEffort, pickOne, INTENDED_ROUTE_TYPES, USED_ROUTE_TYPES };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('forge-routing-stats: error: ' + String(e && e.message).slice(0, 300)); process.exitCode = 1; }
}
