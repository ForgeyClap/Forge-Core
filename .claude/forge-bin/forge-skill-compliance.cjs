#!/usr/bin/env node
'use strict';
/**
 * forge-skill-compliance.cjs — (modernization 2026-10-24): for each skill a run says it loaded, does the
 * run's own trace show the steps that skill asks for? Written from the idea list in
 * .claude/forge-research/open-source-skills-2026-10-24.md (no external code copied).
 *
 * HEURISTIC, READ-ONLY, NO MODEL CALL. It never spawns a process (no `claude -p`), never contacts anything and
 * never writes, except an explicit --out file. Every report carries heuristic:true.
 *
 * INPUTS (read-only)
 *   <runs>/<run_id>/events.jsonl                 the run ledger (forge-paths 'runs', both layouts)
 *   <runs>/<run_id>/run.json                     only for the time window (started_at .. finalized/completed_at)
 *   <runs>/_toollog/*.jsonl                      the tool ledger forge-toolhook writes; a line counts for the run
 *                                                when it is tagged run=<id>, or untagged with ts inside the window
 *   .claude/skills/<name>/SKILL.md               the skill's own text (frontmatter skipped)
 * WHICH SKILLS: events skill_loaded / custom_skill_used (field skill), skill_discovery (field selected[]), any
 *   event with a skills[] array of names, toollog lines with tool=Skill, plus every --skill <name>.
 * WHICH STEPS: list items under headings that read like rules or steps (rules, steps, loop, workflow, procedure,
 *   checklist, order, process, must, gate, when invoked) plus any list item that says must/always/required.
 * HOW A STEP IS MATCHED: the step text is mapped to trace concepts by keyword (tests, red-green, review, verify,
 *   memory, read-first, plan, report, research, worktree, owner-gate, reproduce, evidence, finalize, commit); a
 *   concept is "seen" when a matching event type or toollog line exists. Status: observed (all concepts seen),
 *   partial, not_observed, or not_checkable (a prohibition, or no concept matched). Absence of evidence in the
 *   trace is NOT proof the step was skipped: the ledger only holds what was logged.
 * CLI: node forge-skill-compliance.cjs (--run <id> | --latest) [--root <dir>] [--skill <name>]... [--json] [--strict]
 *        [--out <file>]
 *   exit 0 = report (report mode) · 1 = --strict and at least one not_observed step · 2 = usage / run not found
 */
const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TOOLLOG_BYTES = 16 * 1024 * 1024;
const MAX_STEPS = 30;
const forgePaths = (() => { try { return require('./forge-paths.cjs'); } catch { return null; } })();

const STEP_HEADING = /rule|step|loop|workflow|procedure|checklist|order|process|must|gate|when invoked|sequence/i;
const MUST_WORD = /\b(must|always|required|mandatory)\b/i;
const PROHIBITION = /^(never|do not|don't|no\b|avoid|not\b)/i;

// concept -> how it shows in a step's text, and how it shows in the trace
const CONCEPTS = [
  { id: 'red-green', text: /\bRED\b|fail(s|ed|ing)? (before|first)|failing test|before the (change|fix)/ },
  { id: 'tests', text: /\btests?\b|test suite|regression/i, events: ['check_passed', 'check_failed', 'check_started'], grep: /test/i, tool: (l) => /\.test\.|\.spec\.|[\\/]tests?[\\/]/i.test(String(l.target || '')) },
  { id: 'review', text: /\breview/i, events: ['review_started', 'review_completed', 'codex_review_started', 'codex_review_completed', 'lead_review_completed', 'wp_verified'] },
  { id: 'verify', text: /\bverif/i, events: ['wp_verified', 'check_passed', 'integration_gate_passed', 'quality_gate_passed'] },
  { id: 'memory', text: /\bmemory\b|learnings\.md|MEMORY\.md|\blessons?\b/i, events: ['memory_loaded', 'memory_updated', 'owner_prefs_loaded'], tool: (l) => /MEMORY|learnings\.md|LESSONS|TASK_HISTORY|LEDGER/i.test(String(l.target || '')) },
  { id: 'read-first', text: /\bread\b|\binspect|before (writing|editing|any)|surrounding code/i, events: ['project_scanned', 'file_read', 'memory_loaded', 'profile_loaded'], tool: (l) => ['Read', 'Grep', 'Glob'].includes(l.tool) },
  { id: 'plan', text: /\bplan\b|\bPRD\b|work package/i, events: ['prd_generated', 'mission_blueprint_created', 'agent_work_package_created', 'decision_logged'] },
  { id: 'report', text: /\breport\b/i, events: ['report_generated', 'final_output_created', 'run_completed'] },
  { id: 'research', text: /\bresearch\b|\bsearch\b/i, events: ['research_done'], tool: (l) => ['WebSearch', 'WebFetch', 'Grep'].includes(l.tool) },
  { id: 'worktree', text: /worktree/i, grep: /worktree/i },
  { id: 'owner-gate', text: /\bowner\b|approv|hard[- ]gate/i, events: ['gate_blocked', 'gate_evaluated', 'decision_logged'] },
  { id: 'reproduce', text: /reproduc|\brepro\b/i, events: ['check_failed'], grep: /repro/i },
  { id: 'evidence', text: /evidence|\bproof\b/i, events: ['agent_evidence_added', 'check_passed', 'wp_verified'] },
  { id: 'finalize', text: /finali[sz]e/i, events: ['run_finalized'] },
  { id: 'commit', text: /\bgit commit\b|\bcommit (the|your|each|it|them|changes|work)\b/i, grep: /"commit"\s*:/ },
];

function defaultRoot() {
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  try { const r = forgePaths && forgePaths.scriptRoot(__dirname); if (r) return r; } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..');
}
function runsDirs(root) {
  try { if (forgePaths) return forgePaths.existingStateDirs(root, 'runs'); } catch { /* fall back */ }
  const legacy = path.join(root, '.claude', 'forge-runs');
  return fs.existsSync(legacy) ? [legacy] : [];
}
function readSafe(abs, cap) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > (cap || MAX_TOOLLOG_BYTES)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}
function parseLines(text) {
  const out = []; let bad = 0;
  for (const l of String(text || '').split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { bad++; } }
  return { rows: out, bad };
}
function findRun(root, runId) {
  for (const d of runsDirs(root)) { const p = path.join(d, runId); try { if (fs.lstatSync(p).isDirectory()) return { dir: p, runsDir: d }; } catch { /* next */ } }
  return null;
}
function latestRunId(root) {
  const ids = [];
  for (const d of runsDirs(root)) { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && /^forge-\d{4}-\d{2}-\d{2}/.test(e.name)) ids.push(e.name); } catch { /* none */ } }
  return ids.sort().pop() || null;
}

/** Steps a skill asks for, from its own markdown (heuristic). */
function extractSteps(md) {
  const lines = String(md).split(/\r?\n/);
  let i = 0;
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i++; i++; }
  const steps = [];
  let heading = '', fence = false;
  for (; i < lines.length && steps.length < MAX_STEPS; i++) {
    const ln = lines[i];
    if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(ln);
    if (h) { heading = h[1]; continue; }
    const item = /^ {0,3}(?:\d+[.)]|[-*])\s+(.*)$/.exec(ln);
    if (!item) continue;
    if (!(STEP_HEADING.test(heading) || MUST_WORD.test(item[1]))) continue;
    const text = item[1].replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    if (text.length < 6) continue;
    steps.push({ n: steps.length + 1, line: i + 1, heading: heading.replace(/[*`]/g, '').trim(), text: text.length > 160 ? text.slice(0, 157) + '...' : text, prohibition: PROHIBITION.test(text) });
  }
  return steps;
}

function buildIndex(events, toollog) {
  const byType = new Map();
  let firstFail = null, lastPass = null;
  events.forEach((e, k) => {
    const ty = String(e.event_type || e.type || '');
    if (!byType.has(ty)) byType.set(ty, []);
    byType.get(ty).push(k);
    if (ty === 'check_failed' && firstFail == null) firstFail = k;
    if (ty === 'check_passed') lastPass = k;
  });
  const texts = events.map((e) => JSON.stringify(e).slice(0, 4000));
  return { events, byType, texts, toollog, redGreen: firstFail != null && lastPass != null && firstFail < lastPass };
}
const evRef = (ix, k) => 'event ' + (ix.events[k].event_type || ix.events[k].type) + (ix.events[k].seq != null ? ' seq ' + ix.events[k].seq : ' #' + (k + 1));
function evidenceFor(concept, ix) {
  if (concept.id === 'red-green') return ix.redGreen ? ['a check_failed before a later check_passed'] : [];
  const ev = [];
  for (const ty of concept.events || []) {
    for (const k of ix.byType.get(ty) || []) {
      if (concept.id === 'tests' && !concept.grep.test(ix.texts[k])) continue;
      ev.push(evRef(ix, k));
      if (ev.length >= 2) break;
    }
    if (ev.length >= 2) break;
  }
  if (!ev.length && concept.grep && concept.id !== 'tests') { const k = ix.texts.findIndex((s) => concept.grep.test(s)); if (k >= 0) ev.push(evRef(ix, k) + ' mentions it'); }
  if (ev.length < 2 && concept.tool) { const l = ix.toollog.find(concept.tool); if (l) ev.push('toollog ' + l.tool + (l.target ? ' ' + path.basename(String(l.target)) : '')); }
  return ev;
}
function judge(step, ix) {
  if (step.prohibition) return { status: 'not_checkable', concepts: [], evidence: [], reason: 'a prohibition: absence cannot be proven from a trace' };
  const concepts = CONCEPTS.filter((c) => c.text.test(step.text));
  if (!concepts.length) return { status: 'not_checkable', concepts: [], evidence: [], reason: 'no trace signal maps to this step' };
  const seen = []; const missing = []; const evidence = [];
  for (const c of concepts) { const e = evidenceFor(c, ix); if (e.length) { seen.push(c.id); evidence.push(...e.map((x) => c.id + ': ' + x)); } else missing.push(c.id); }
  const status = !missing.length ? 'observed' : seen.length ? 'partial' : 'not_observed';
  return { status, concepts: concepts.map((c) => c.id), evidence: evidence.slice(0, 4), reason: missing.length ? 'no trace of: ' + missing.join(', ') : null };
}

function loadedSkills(events, toollog, extra) {
  const map = new Map();
  const add = (name, src) => {
    if (typeof name !== 'string') return;
    const n = name.includes(':') ? name.split(':').pop() : name;
    if (!SKILL_RE.test(n)) return;
    if (!map.has(n)) map.set(n, new Set());
    map.get(n).add(src);
  };
  for (const e of events) {
    const ty = e.event_type || e.type;
    if ((ty === 'skill_loaded' || ty === 'custom_skill_used') && e.skill) add(e.skill, ty);
    if (ty === 'skill_discovery' && Array.isArray(e.selected)) e.selected.forEach((s) => add(s, ty));
    if (Array.isArray(e.skills)) e.skills.forEach((s) => add(s, (ty || 'event') + '.skills'));
  }
  for (const l of toollog) if (l.tool === 'Skill' && l.target) add(String(l.target), 'toollog Skill');
  for (const s of extra || []) add(s, '--skill');
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([skill, src]) => ({ skill, loaded_by: [...src].sort() }));
}

function runWindow(runDir, events) {
  let rj = null;
  try { rj = JSON.parse(readSafe(path.join(runDir, 'run.json'), 1024 * 1024) || 'null'); } catch { rj = null; }
  const ts = events.map((e) => Date.parse(e.timestamp || e.ts || '')).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const start = rj && Date.parse(rj.started_at) ? Date.parse(rj.started_at) : ts[0];
  const end = rj && Date.parse(rj.finalized_at || rj.completed_at || '') ? Date.parse(rj.finalized_at || rj.completed_at) : ts[ts.length - 1];
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end: Math.max(start, end) } : null;
}
function readToollog(runsDir, runId, win) {
  const dir = path.join(runsDir, '_toollog');
  const out = []; const notes = [];
  let st; try { st = fs.lstatSync(dir); } catch { return { rows: out, files: 0, notes: ['no _toollog folder'] }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { rows: out, files: 0, notes: ['_toollog is not a plain folder: not read'] };
  let files = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const t = readSafe(path.join(dir, f));
    if (t == null) { notes.push('skipped ' + f + ' (a link, unreadable or over ' + MAX_TOOLLOG_BYTES + ' bytes)'); continue; }
    files++;
    for (const l of parseLines(t).rows) {
      if (l.run) { if (l.run === runId) out.push(l); continue; }
      const ms = Date.parse(l.ts || '');
      if (win && Number.isFinite(ms) && ms >= win.start && ms <= win.end) out.push(l);
    }
  }
  return { rows: out, files, notes };
}

function complianceForRun(rootIn, runId, opts) {
  const o = opts || {};
  const root = path.resolve(rootIn);
  if (!ID_RE.test(String(runId || ''))) throw new Error('invalid run id: ' + JSON.stringify(runId));
  const run = findRun(root, runId);
  if (!run) throw new Error('run not found: ' + runId);
  const evText = readSafe(path.join(run.dir, 'events.jsonl'));
  if (evText == null) throw new Error('no readable events.jsonl in run ' + runId);
  const ev = parseLines(evText);
  const win = runWindow(run.dir, ev.rows);
  const tl = o.noToollog ? { rows: [], files: 0, notes: ['toollog not read (--no-toollog)'] } : readToollog(run.runsDir, runId, win);
  const ix = buildIndex(ev.rows, tl.rows);
  const skillsDir = path.resolve(o.skillsDir || path.join(root, '.claude', 'skills'));
  const skills = [];
  const totals = { observed: 0, partial: 0, not_observed: 0, not_checkable: 0 };
  for (const s of loadedSkills(ev.rows, tl.rows, o.skills)) {
    const abs = path.join(skillsDir, s.skill, 'SKILL.md');
    const md = readSafe(abs, 2 * 1024 * 1024);
    if (md == null) { skills.push({ skill: s.skill, loaded_by: s.loaded_by, file: null, status: 'skill_file_not_found', steps: [], summary: null }); continue; }
    const steps = extractSteps(md).map((st) => Object.assign(st, judge(st, ix)));
    const summary = { observed: 0, partial: 0, not_observed: 0, not_checkable: 0 };
    steps.forEach((st) => { summary[st.status]++; totals[st.status]++; });
    skills.push({ skill: s.skill, loaded_by: s.loaded_by, file: path.relative(root, abs).split(path.sep).join('/'), status: steps.length ? 'checked' : 'no_steps_found', steps, summary });
  }
  const notes = tl.notes.slice();
  if (!skills.length) notes.push('the run records no loaded skill (no skill_loaded / custom_skill_used / skill_discovery event, no Skill tool line); pass --skill <name> to check one anyway');
  return {
    tool: 'forge-skill-compliance', version: 1, heuristic: true,
    caveat: 'Heuristic: a step is matched to logged events and tool-ledger lines by keyword. "not_observed" means the trace holds no sign of it, not that it was skipped.',
    run_id: runId, sources: { events: ev.rows.length, events_unparseable: ev.bad, toollog_files: tl.files, toollog_lines: tl.rows.length, window: win ? { start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString() } : null },
    totals, skills, notes,
  };
}

function formatReport(rep) {
  const L = ['forge-skill-compliance (HEURISTIC) run ' + rep.run_id + ': ' + rep.skills.length + ' skills · events ' + rep.sources.events + ' · toollog lines ' + rep.sources.toollog_lines,
    '  steps: ' + rep.totals.observed + ' observed · ' + rep.totals.partial + ' partial · ' + rep.totals.not_observed + ' not observed · ' + rep.totals.not_checkable + ' not checkable'];
  for (const s of rep.skills) {
    L.push('  ' + s.skill + ' [' + s.loaded_by.join(', ') + ']: ' + (s.steps.length ? s.summary.observed + '/' + s.steps.length + ' observed' : s.status));
    for (const st of s.steps) if (st.status !== 'observed' && st.status !== 'not_checkable') L.push('     ' + st.status.toUpperCase() + ' step ' + st.n + ' (line ' + st.line + '): ' + st.text + (st.reason ? ' — ' + st.reason : ''));
  }
  for (const n of rep.notes) L.push('  note: ' + n);
  L.push('  ' + rep.caveat);
  return L.join('\n');
}

function main(argv, io) {
  const a = argv || [];
  const w = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const e = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const v = {}; const skills = []; const flags = new Set();
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (['--root', '--run', '--skill', '--out'].includes(x)) {
      const val = a[++i];
      if (!val || val.startsWith('--')) { e('forge-skill-compliance: ' + x + ' needs a value'); return 2; }
      if (x === '--skill') skills.push(val); else v[x] = val;
    } else if (['--json', '--strict', '--latest', '--no-toollog', '--help', '-h'].includes(x)) flags.add(x);
    else { e('forge-skill-compliance: unknown argument ' + x); return 2; }
  }
  const usage = 'usage: node forge-skill-compliance.cjs (--run <id> | --latest) [--root <dir>] [--skill <name>]... [--no-toollog] [--json] [--strict] [--out <file>]';
  if (flags.has('--help') || flags.has('-h')) { w(usage); return 0; }
  const root = v['--root'] ? path.resolve(v['--root']) : defaultRoot();
  if (!fs.existsSync(root)) { e('forge-skill-compliance: root not found: ' + root); return 2; }
  const runId = v['--run'] || (flags.has('--latest') ? latestRunId(root) : null);
  if (!runId) { e(usage); return 2; }
  let rep;
  try { rep = complianceForRun(root, runId, { skills, noToollog: flags.has('--no-toollog') }); } catch (err) { e('forge-skill-compliance: ' + err.message); return 2; }
  const text = flags.has('--json') ? JSON.stringify(rep, null, 2) : formatReport(rep);
  if (v['--out']) {
    const abs = path.resolve(v['--out']);
    if (!fs.existsSync(path.dirname(abs)) || !fs.statSync(path.dirname(abs)).isDirectory()) { e('forge-skill-compliance: --out folder does not exist: ' + path.dirname(abs)); return 2; }
    fs.writeFileSync(abs, text + '\n');
  } else w(text);
  return flags.has('--strict') && rep.totals.not_observed > 0 ? 1 : 0;
}

module.exports = { complianceForRun, extractSteps, loadedSkills, judge, buildIndex, formatReport, main, CONCEPTS };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { process.stderr.write('forge-skill-compliance: internal error: ' + ((err && err.stack) || err) + '\n'); process.exitCode = 2; }
}
