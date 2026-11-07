#!/usr/bin/env node
'use strict';
/**
 * forge-harness-score.cjs — (modernization 2026-10-24): a 0-10 scorecard of a project's own Forge gates,
 * driven by a versioned rubric (.claude/config/quality/harness-rubric.json). Written from the idea list in
 * .claude/forge-research/open-source-skills-2026-10-24.md (no external code copied).
 *
 * SCORING: each check earns 0..points (lint and config-scan checks lose points per finding). A check whose input
 * is absent (no --doctor-json, a missing tool or file, nothing to lint) is 'not_measured' and leaves the max, so a
 * missing input never looks like a pass or a fail. Category score = round(earned / max x 10) over measured checks;
 * overall = round(10 x sum(weight x earned/max) / sum(weight)) over measured categories. The top 3 actions are the
 * failed or partial checks that lose the most weighted points (ties: check id), then not-measured checks.
 * DETERMINISTIC: no clock, no random, sorted output; the same inputs give byte-identical output. Inputs are named
 * by path relative to the root plus a sha256, never by an absolute path that differs per machine.
 * READ-ONLY: it only reads files and calls the read-only lint/scan/plan functions of its sibling tools in-process
 * (forge-skilllint, forge-agentlint, forge-mcp-pin, forge-config-scan, forge-plugin-build planBuild+checkBuild,
 * forge-config safeGet); it never spawns a process and never writes, except an explicit --out file.
 * CLI: node forge-harness-score.cjs [--root <dir>] [--rubric <file>] [--doctor-json <file>] [--json] [--strict]
 *        [--min <0-10>] [--out <file>]
 *   exit 0 = scored (report mode) · 1 = --strict and (overall < --min (default 7) or a check failed outright) ·
 *   2 = usage error, a missing root or an invalid rubric
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUBRIC_REL = '.claude/config/quality/harness-rubric.json';
const opt = (name) => { try { return require('./' + name); } catch { return null; } };
const forgePaths = opt('forge-paths.cjs');

function defaultRoot() {
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  try { const r = forgePaths && forgePaths.scriptRoot(__dirname); if (r) return r; } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..');
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const r2 = (n) => Math.round(n * 100) / 100;
function readText(abs) { try { const st = fs.lstatSync(abs); if (st.isSymbolicLink() || !st.isFile()) return null; return fs.readFileSync(abs, 'utf8'); } catch { return null; } }
function readJson(abs) { const t = readText(abs); if (t == null) return { missing: true }; try { return { data: JSON.parse(t.replace(/^﻿/, '')) }; } catch (e) { return { invalid: e.message }; } }
const at = (root, rel) => path.join(root, ...String(rel).split('/'));
const relName = (root, abs) => { const r = path.relative(root, abs); return r.startsWith('..') || path.isAbsolute(r) ? path.basename(abs) : r.split(path.sep).join('/'); };

// ---- check result helpers -----------------------------------------------------------------------------------
const PASS = (detail) => ({ status: 'pass', ratio: 1, detail });
const FAIL = (detail) => ({ status: 'fail', ratio: 0, detail });
const NM = (detail) => ({ status: 'not_measured', ratio: null, detail });
const PART = (ratio, detail) => ({ status: ratio >= 1 ? 'pass' : ratio <= 0 ? 'fail' : 'partial', ratio: Math.max(0, Math.min(1, ratio)), detail });

function runsDirs(root) {
  try { if (forgePaths) return forgePaths.existingStateDirs(root, 'runs'); } catch { /* fall back */ }
  const legacy = path.join(root, '.claude', 'forge-runs');
  return fs.existsSync(legacy) ? [legacy] : [];
}
function latestRun(root) {
  const all = [];
  for (const d of runsDirs(root)) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) if (e.isDirectory() && /^forge-\d{4}-\d{2}-\d{2}/.test(e.name)) all.push({ id: e.name, dir: path.join(d, e.name) });
  }
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return all.length ? all[all.length - 1] : null;
}
function lintCounts(check, root) {
  if (check.tool === 'skill') { const L = opt('forge-skilllint.cjs'); if (!L) return null; const r = L.lintSkills(root); return { n: r.skills, counts: r.counts }; }
  const L = opt('forge-agentlint.cjs'); if (!L) return null; const r = L.lintAgents(root); return { n: r.agents, counts: r.counts };
}
function penalty(check, counts) {
  const lost = (counts.error || 0) * (check.per_error || 0) + (counts.warn || 0) * (check.per_warn || 0);
  return PART((check.points - lost) / check.points, (counts.error || 0) + ' error, ' + (counts.warn || 0) + ' warn');
}

const CHECKS = {
  'doctor-check'(c, ctx) {
    if (!ctx.doctor) return NM('no --doctor-json given');
    const x = ctx.doctor.checks && ctx.doctor.checks[c.check];
    if (!x) return NM('the doctor output has no checks.' + c.check);
    const extra = c.check === 'tests' && typeof x.passed === 'number' ? ' (' + x.passed + ' passed, ' + (x.failed || 0) + ' failed, ' + (x.suitesFailed || 0) + ' suites failed)' : '';
    return x.ok === true ? PASS('checks.' + c.check + ' ok' + extra) : FAIL('checks.' + c.check + ' not ok' + extra);
  },
  'doctor-all-checks'(c, ctx) {
    if (!ctx.doctor) return NM('no --doctor-json given');
    const ks = Object.keys(ctx.doctor.checks || {}).sort();
    if (!ks.length) return NM('the doctor output has no checks');
    const bad = ks.filter((k) => !ctx.doctor.checks[k] || ctx.doctor.checks[k].ok !== true);
    return bad.length ? PART((ks.length - bad.length) / ks.length, 'not ok: ' + bad.join(', ')) : PASS(ks.length + ' checks ok');
  },
  'file-present'(c, ctx) { return readText(at(ctx.root, c.path)) != null ? PASS(c.path + ' present') : FAIL(c.path + ' missing'); },
  'json-array-min'(c, ctx) {
    const j = readJson(at(ctx.root, c.path));
    if (j.missing) return FAIL(c.path + ' missing');
    if (j.invalid) return FAIL(c.path + ' is not valid JSON');
    const arr = j.data && j.data[c.array];
    const n = Array.isArray(arr) ? arr.length : 0;
    return n >= c.min ? PASS(n + ' ' + c.array) : FAIL(n + ' ' + c.array + ' (need ' + c.min + ')');
  },
  'json-ids-present'(c, ctx) {
    const j = readJson(at(ctx.root, c.path));
    if (!j.data) return FAIL(c.path + (j.missing ? ' missing' : ' is not valid JSON'));
    const have = new Set((Array.isArray(j.data[c.array]) ? j.data[c.array] : []).map((x) => x && x[c.key]));
    const miss = c.ids.filter((id) => !have.has(id));
    return PART((c.ids.length - miss.length) / c.ids.length, miss.length ? 'missing: ' + miss.join(', ') : 'all ' + c.ids.length + ' present');
  },
  'settings-hook'(c, ctx) {
    const j = readJson(at(ctx.root, '.claude/settings.json'));
    if (!j.data) return FAIL('.claude/settings.json ' + (j.missing ? 'missing' : 'not valid JSON'));
    const groups = (j.data.hooks && j.data.hooks[c.event]) || [];
    const covered = new Set();
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || !(g.hooks || []).some((h) => h && typeof h.command === 'string' && h.command.includes(c.command_includes))) continue;
      String(g.matcher || '').split('|').forEach((m) => covered.add(m.trim()));
    }
    const miss = c.matcher_includes.filter((m) => !covered.has(m));
    return PART((c.matcher_includes.length - miss.length) / c.matcher_includes.length, miss.length ? c.command_includes + ' not registered for: ' + miss.join(', ') : c.command_includes + ' registered for ' + c.matcher_includes.join('|'));
  },
  'config-value'(c, ctx) {
    const C = opt('forge-config.cjs');
    if (!C || typeof C.safeGet !== 'function') return NM('forge-config.cjs not available');
    let v;
    try { v = C.safeGet(c.key, { projectRoot: ctx.root }); } catch (e) { return NM('could not read ' + c.key + ': ' + e.message); }
    return v.value === c.equals ? PASS(c.key + ' = ' + JSON.stringify(v.value) + ' (' + v.source + ')') : FAIL(c.key + ' = ' + JSON.stringify(v.value) + ' (' + v.source + ')');
  },
  'memory-file'(c, ctx) {
    let abs = path.join(ctx.root, '.claude', c.name);
    try { if (forgePaths) abs = forgePaths.memoryFile(ctx.root, c.name, { read: true }); } catch { /* legacy path */ }
    const t = readText(abs);
    if (t == null) return FAIL(c.name + ' missing');
    return Buffer.byteLength(t) >= c.min_bytes ? PASS(c.name + ' present') : FAIL(c.name + ' nearly empty');
  },
  'latest-run-chain'(c, ctx) {
    const run = ctx.latest;
    if (!run) return NM('no run folder found');
    const t = readText(path.join(run.dir, 'events.jsonl'));
    if (t == null) return FAIL(run.id + ': no events.jsonl');
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    let bad = 0;
    for (const l of lines) { try { const e = JSON.parse(l); if (!e.entry_hash || !e.prev_hash) bad++; } catch { bad++; } }
    return lines.length ? PART((lines.length - bad) / lines.length, run.id + ': ' + (lines.length - bad) + '/' + lines.length + ' events parse and are chained') : FAIL(run.id + ': events.jsonl is empty');
  },
  'latest-run-finalized'(c, ctx) {
    const run = ctx.latest;
    if (!run) return NM('no run folder found');
    return readText(path.join(run.dir, 'run-finalized.json')) != null ? PASS(run.id + ' finalized') : FAIL(run.id + ' has no run-finalized.json');
  },
  lint(c, ctx) {
    let r;
    try { r = lintCounts(c, ctx.root); } catch (e) { return NM(c.tool + ' lint threw: ' + e.message); }
    if (!r) return NM('forge-' + c.tool + 'lint.cjs not available');
    if (!r.n) return NM('no ' + c.tool + 's to lint');
    const p = penalty(c, r.counts);
    p.detail = r.n + ' ' + c.tool + 's: ' + p.detail;
    return p;
  },
  'mcp-registry'(c, ctx) {
    const M = opt('forge-mcp-pin.cjs');
    if (!M) return NM('forge-mcp-pin.cjs not available');
    const abs = at(ctx.root, '.claude/config/orchestration/mcp-registry.json');
    const raw = readText(abs);
    if (raw == null) return NM('no mcp-registry.json');
    let data; try { data = JSON.parse(raw.replace(/^﻿/, '')); } catch { return FAIL('mcp-registry.json is not valid JSON'); }
    const r = M.checkRegistry(data, { rawText: raw });
    return r.ok ? PASS(r.entries.length + ' entries, 0 violations') : FAIL(r.violations.length + ' violations: ' + [...new Set(r.violations.map((v) => v.rule))].sort().join(', '));
  },
  'mcp-host'(c, ctx) {
    const j = readJson(at(ctx.root, '.mcp.json'));
    if (j.missing) return PASS('no .mcp.json (no project MCP servers)');
    if (j.invalid) return FAIL('.mcp.json is not valid JSON');
    const M = opt('forge-mcp-pin.cjs');
    if (!M) return NM('forge-mcp-pin.cjs not available');
    const r = M.scanHostConfig(j.data);
    const high = r.servers.filter((s) => s.risk === 'HIGH').map((s) => s.id).sort();
    return high.length ? FAIL('unpinned: ' + high.join(', ')) : PASS(r.servers.length + ' servers pinned or not launchers');
  },
  'settings-flag-absent'(c, ctx) {
    const on = ['settings.json', 'settings.local.json'].filter((n) => { const j = readJson(at(ctx.root, '.claude/' + n)); return j.data && j.data[c.flag] === true; });
    return on.length ? FAIL(c.flag + ' is true in ' + on.join(', ')) : PASS(c.flag + ' not set');
  },
  'plugin-identical'(c, ctx) {
    const B = opt('forge-plugin-build.cjs');
    if (!B) return NM('forge-plugin-build.cjs not available');
    if (!fs.existsSync(path.join(ctx.root, B.TEMPLATE_REL, '.claude-plugin', 'plugin.json'))) return NM('not a Forge development tree (no ' + B.TEMPLATE_REL + '): no plugin to compare');
    let r;
    try { r = B.checkBuild(B.planBuild({ root: ctx.root }), path.resolve(ctx.root, B.OUT_REL)); } catch (e) { return FAIL('plugin plan failed: ' + e.message); }
    return r.ok ? PASS(B.OUT_REL + ' identical') : FAIL(B.OUT_REL + ' drift: missing ' + r.missing.length + ', extra ' + r.extra.length + ', changed ' + r.changed.length + ', links ' + r.links.length);
  },
  'eval-baseline-present'(c, ctx) {
    const j = readJson(at(ctx.root, c.path));
    if (j.missing) return FAIL('no eval baseline');
    return j.data && j.data.kind === 'forge-intel-evals-baseline' && Array.isArray(j.data.results) ? PASS(j.data.results.length + ' scenarios') : FAIL('not a forge-intel-evals baseline');
  },
  'eval-baseline-nofail'(c, ctx) {
    const j = readJson(at(ctx.root, c.path));
    if (!j.data || !j.data.summary) return NM('no eval baseline summary');
    return (j.data.summary.FAIL || 0) === 0 ? PASS('0 FAIL') : FAIL(j.data.summary.FAIL + ' FAIL');
  },
  'eval-baseline-ratio'(c, ctx) {
    const j = readJson(at(ctx.root, c.path));
    const s = j.data && j.data.summary;
    if (!s || !s.scenarios) return NM('no eval baseline summary');
    const ratio = (s.PASS || 0) / s.scenarios;
    return ratio >= c.min ? PASS(s.PASS + '/' + s.scenarios + ' PASS') : PART(ratio / c.min, s.PASS + '/' + s.scenarios + ' PASS (bar ' + c.min + ')');
  },
  'config-scan'(c, ctx) {
    const S = opt('forge-config-scan.cjs');
    if (!S) return NM('forge-config-scan.cjs not available');
    return penalty(c, S.scanConfig(ctx.root).counts);
  },
};

function validateRubric(r) {
  const errs = [];
  if (!r || r.kind !== 'forge-harness-rubric' || !Number.isInteger(r.version) || !Array.isArray(r.categories) || !r.categories.length) return ['not a forge-harness-rubric (kind, integer version, categories[])'];
  const ids = new Set();
  for (const cat of r.categories) {
    if (!cat || typeof cat.id !== 'string' || !(cat.weight > 0) || !Array.isArray(cat.checks) || !cat.checks.length) { errs.push('category ' + JSON.stringify(cat && cat.id) + ': needs id, weight > 0 and checks[]'); continue; }
    for (const ch of cat.checks) {
      if (!ch || typeof ch.id !== 'string' || ids.has(ch.id)) errs.push(cat.id + ': a check needs a unique id (' + JSON.stringify(ch && ch.id) + ')');
      else ids.add(ch.id);
      if (!ch || !CHECKS[ch.type]) errs.push(cat.id + '/' + (ch && ch.id) + ': unknown check type ' + JSON.stringify(ch && ch.type));
      if (!ch || !(ch.points > 0)) errs.push(cat.id + '/' + (ch && ch.id) + ': points must be > 0');
    }
  }
  return errs;
}

function scoreHarness(rootIn, opts) {
  const o = opts || {};
  const root = path.resolve(rootIn);
  const rubricPath = path.resolve(o.rubricPath || path.join(__dirname, '..', 'config', 'quality', 'harness-rubric.json'));
  const rubricRaw = readText(rubricPath);
  if (rubricRaw == null) throw new Error('rubric not found: ' + rubricPath);
  let rubric; try { rubric = JSON.parse(rubricRaw); } catch (e) { throw new Error('rubric is not valid JSON: ' + e.message); }
  const errs = validateRubric(rubric);
  if (errs.length) throw new Error('invalid rubric: ' + errs.join('; '));
  const inputs = { rubric: { file: relName(root, rubricPath), version: rubric.version, sha256: sha(rubricRaw) }, doctor_json: null };
  let doctor = null;
  if (o.doctorJson) {
    const raw = readText(path.resolve(o.doctorJson));
    if (raw == null) throw new Error('--doctor-json not readable: ' + o.doctorJson);
    try { doctor = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { throw new Error('--doctor-json is not valid JSON: ' + e.message); }
    inputs.doctor_json = { file: relName(root, path.resolve(o.doctorJson)), sha256: sha(raw) };
  }
  const ctx = { root, doctor, latest: latestRun(root) };
  const categories = [];
  const candidates = [];
  let wSum = 0, wEarned = 0;
  for (const cat of rubric.categories) {
    const checks = [];
    let max = 0, earned = 0;
    for (const ch of cat.checks) {
      let res;
      try { res = CHECKS[ch.type](ch, ctx); } catch (e) { res = NM('check threw: ' + e.message); }
      const pts = res.ratio == null ? null : r2(ch.points * res.ratio);
      if (pts != null) { max += ch.points; earned += pts; }
      checks.push({ id: ch.id, status: res.status, points: ch.points, earned: pts, detail: res.detail });
      if (res.status !== 'pass') candidates.push({ id: ch.id, category: cat.id, status: res.status, lost: res.ratio == null ? -1 : r2(cat.weight * (ch.points - pts)), action: ch.action || ('Fix ' + ch.id), detail: res.detail, catMax: cat.checks.reduce((s, x) => s + x.points, 0) });
    }
    const measured = max > 0;
    const score = measured ? Math.round((earned / max) * 10) : null;
    if (measured) { wSum += cat.weight; wEarned += cat.weight * (earned / max); }
    categories.push({ id: cat.id, title: cat.title || cat.id, weight: cat.weight, score, earned: r2(earned), max, checks });
  }
  candidates.forEach((x) => { if (x.lost >= 0) x.lost = r2(x.lost / x.catMax); });
  candidates.sort((a, b) => (b.lost - a.lost) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const top = candidates.slice(0, 3).map((x) => ({ check: x.id, category: x.category, status: x.status, action: x.action, why: x.detail }));
  const overall = wSum ? Math.round((10 * wEarned) / wSum) : null;
  const measuredCats = categories.filter((c) => c.score != null).length;
  return { tool: 'forge-harness-score', version: 1, inputs, latest_run: ctx.latest ? ctx.latest.id : null, overall, measured_categories: measuredCats, total_categories: categories.length, categories, top_actions: top };
}

function formatReport(rep) {
  const L = ['forge-harness-score (rubric v' + rep.inputs.rubric.version + '): overall ' + (rep.overall == null ? 'n/a' : rep.overall + '/10') + ' over ' + rep.measured_categories + '/' + rep.total_categories + ' measured categories'];
  for (const c of rep.categories) {
    L.push('  ' + (c.score == null ? ' n/a' : String(c.score).padStart(2) + '/10') + '  ' + c.id + ' (w' + c.weight + ') ' + c.title);
    for (const ch of c.checks) if (ch.status !== 'pass') L.push('         ' + ch.status.toUpperCase() + ' ' + ch.id + ': ' + ch.detail);
  }
  L.push('  top actions:');
  rep.top_actions.forEach((a, i) => L.push('   ' + (i + 1) + '. [' + a.category + '/' + a.check + '] ' + a.action + ' (' + a.why + ')'));
  if (!rep.top_actions.length) L.push('   none: every check passed');
  return L.join('\n');
}

function main(argv, io) {
  const a = argv || [];
  const w = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const e = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const v = {};
  const flags = new Set();
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (['--root', '--rubric', '--doctor-json', '--out', '--min'].includes(x)) {
      const val = a[++i];
      if (!val || val.startsWith('--')) { e('forge-harness-score: ' + x + ' needs a value'); return 2; }
      v[x] = val;
    } else if (['--json', '--strict', '--help', '-h'].includes(x)) flags.add(x);
    else { e('forge-harness-score: unknown argument ' + x); return 2; }
  }
  if (flags.has('--help') || flags.has('-h')) { w('usage: node forge-harness-score.cjs [--root <dir>] [--rubric <file>] [--doctor-json <file>] [--json] [--strict] [--min <0-10>] [--out <file>]'); return 0; }
  const min = v['--min'] == null ? 7 : Number(v['--min']);
  if (!Number.isFinite(min) || min < 0 || min > 10) { e('forge-harness-score: --min must be a number from 0 to 10'); return 2; }
  const root = v['--root'] ? path.resolve(v['--root']) : defaultRoot();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { e('forge-harness-score: root not found: ' + root); return 2; }
  let rep;
  try { rep = scoreHarness(root, { rubricPath: v['--rubric'], doctorJson: v['--doctor-json'] }); } catch (err) { e('forge-harness-score: ' + err.message); return 2; }
  const text = flags.has('--json') ? JSON.stringify(rep, null, 2) : formatReport(rep);
  if (v['--out']) {
    const abs = path.resolve(v['--out']);
    if (!fs.existsSync(path.dirname(abs)) || !fs.statSync(path.dirname(abs)).isDirectory()) { e('forge-harness-score: --out folder does not exist: ' + path.dirname(abs)); return 2; }
    fs.writeFileSync(abs, text + '\n');
  } else w(text);
  const anyFail = rep.categories.some((c) => c.checks.some((ch) => ch.status === 'fail'));
  return flags.has('--strict') && (rep.overall == null || rep.overall < min || anyFail) ? 1 : 0;
}

module.exports = { scoreHarness, validateRubric, formatReport, main, CHECKS, RUBRIC_REL };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { process.stderr.write('forge-harness-score: internal error: ' + ((err && err.stack) || err) + '\n'); process.exitCode = 2; }
}
