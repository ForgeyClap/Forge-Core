#!/usr/bin/env node
'use strict';
/**
 * forge-run-file.cjs — writes a run's own files (final-report.md, run.json, plan.md, prd.md, artifacts/…) into
 * `.claude/forge-runs/<run_id>/` from a draft written OUTSIDE `.claude/`.
 *
 * Why (category tests O25): Claude Code treats every file under `.claude/` as sensitive. In a headless
 * session (`claude -p`, the way the Command Center and the category tests start Forge) there is nobody to approve the
 * edit, so Write/Edit of run.json and final-report.md is refused and the run stays open without a report. A node tool
 * call is an ordinary allowed command, so the Lead writes the draft (e.g. `_scratch/final-report.md`) and puts it here.
 *
 * CLI:
 *   node .claude/forge-bin/forge-run-file.cjs put --run <run_id> --name <file> --from <draft path | ->
 *     <file>: a relative name inside the run folder (sub-folders allowed, no `..`). Refused: events.jsonl (only
 *     log-event.cjs writes events, hash-chained) and run-finalized.json (only `forge-runcontract.cjs check --finalize`).
 *     run.json must be valid JSON. `--from -` reads the draft from stdin. Exit 0 = written, 1 = refused (plain reason).
 *   node .claude/forge-bin/forge-run-file.cjs append --file <name> --from <draft path | ->
 *     Appends the draft to ONE project memory file under `.claude/` (category tests A2/A4: these had no writer, so every
 *     headless run left them untouched). <name> is one of FORGE_MEMORY.md, FORGE_TASK_HISTORY.md, FORGE_AGENT_LEDGER.md,
 *     FORGE_DECISIONS.md, FORGE_SKILL_REGISTRY.md, or agent-memory/<boss>/MEMORY.md (<boss> = [a-z0-9-]+). A missing
 *     file is created; old and new text are joined by exactly one newline; the file is written LF. Anything else, or an
 *     empty draft, is refused. Exit 0 = appended, 1 = refused (plain reason).
 *     SD-MEM: FORGE_MEMORY.md is newest-first (its own header says so and forge-snapshot reads the top),
 *     so a draft that starts with a `## Status YYYY-MM-DD` heading is inserted ABOVE the file's first `## ` heading,
 *     followed by one blank line. Any other draft, and every other memory file, is appended at the end as before.
 *     CORE-1-F2: a FORGE_MEMORY.md draft headed `## YYYY-MM-DD …` becomes `## Status YYYY-MM-DD …` (so it
 *     goes on top and the snapshot sees it). A second append of the same entry is refused (exit 1): a draft whose first
 *     `## ` heading the file already has (with or without "Status"), or a headingless draft whose every line is already
 *     a line of the file (a byte-identical ledger row).
 * Module API: { putRunFile, checkName, appendMemoryFile, checkMemoryFile, statusBlocks, latestStatusBlock,
 *   compareStatusKeys, missionIsStale }
 * Root: the project that holds this copy (…/<project>/.claude/forge-bin), or FORGE_PROJECT_ROOT for tests.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WIN_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const OWN_WRITERS = { 'events.jsonl': 'log-event.cjs', 'run-finalized.json': 'forge-runcontract.cjs check --finalize' };

/** checkName(name) -> null when fine, else a plain reason. */
function checkName(name) {
  if (typeof name !== 'string' || !name) return 'give --name <file>';
  if (name.includes('\\') || path.isAbsolute(name) || name.startsWith('/')) return 'name must be a relative path with / (got "' + name + '")';
  const parts = name.split('/');
  if (parts.some((p) => !SEGMENT_RE.test(p) || p === '.' || p === '..')) return 'name "' + name + '" has an empty, dot or unusual segment';
  // Windows drops a trailing dot or space (`events.jsonl.` is events.jsonl) and treats device names as devices.
  if (parts.some((p) => /[. ]$/.test(p))) return 'name "' + name + '" ends a segment with a dot or space';
  if (parts.some((p) => WIN_DEVICE_RE.test(p))) return 'name "' + name + '" uses a Windows device name';
  const base = parts[parts.length - 1].toLowerCase();
  if (OWN_WRITERS[base] && parts.length === 1) return base + ' has its own writer (' + OWN_WRITERS[base] + ')';
  if (base.endsWith('.lock')) return 'lock files are not run files';
  return null;
}

// FB-CONTRACT-2-F10: the run folder follows the forge-paths layout like log-event.cjs and forge-run-state.cjs (.forge/runs
// once the project opted in); a run that only exists in the legacy folder, or a copy without forge-paths, keeps the legacy path.
function runDirOf(root, run) {
  const legacy = path.join(root, '.claude', 'forge-runs', run);
  let active = legacy;
  try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.layout === 'function' && fp.layout(root) === 'forge') active = path.join(fp.stateDir(root, 'runs'), run); } catch { /* legacy */ }
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}

/** putRunFile({run, name, content}, {root}) -> {ok, path} | {ok:false, reason} */
function putRunFile(args, opts) {
  const root = (opts && opts.root) || PROJECT_ROOT;
  const { run, name, content } = args || {};
  if (typeof run !== 'string' || !RUN_ID_RE.test(run)) return { ok: false, reason: 'run id "' + run + '" is not a valid run id' };
  const runDir = runDirOf(root, run);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) return { ok: false, reason: 'no run folder ' + path.relative(root, runDir).split(path.sep).join('/') + ' (log run_started first)' };
  const bad = checkName(name);
  if (bad) return { ok: false, reason: bad };
  const dst = path.resolve(runDir, name);
  if (path.relative(runDir, dst).startsWith('..')) return { ok: false, reason: 'name escapes the run folder' };
  if (path.basename(dst).toLowerCase() === 'run.json') {
    try { JSON.parse(String(content)); } catch (e) { return { ok: false, reason: 'run.json is not valid JSON: ' + e.message }; }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dst);
  return { ok: true, path: dst };
}

const MEMORY_FILES = ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_DECISIONS.md', 'FORGE_SKILL_REGISTRY.md'];
const BOSS_MEMORY_RE = /^agent-memory\/([a-z0-9][a-z0-9-]*)\/MEMORY\.md$/;

/** checkMemoryFile(name) -> null when `name` is a whitelisted memory file (relative to .claude/), else a plain reason. */
function checkMemoryFile(name) {
  if (typeof name !== 'string' || !name) return 'give --file <memory file>';
  if (MEMORY_FILES.includes(name)) return null;
  const m = BOSS_MEMORY_RE.exec(name);
  if (m && !WIN_DEVICE_RE.test(m[1])) return null;
  return '"' + name + '" is not a memory file (allowed: ' + MEMORY_FILES.join(', ') + ', agent-memory/<boss>/MEMORY.md)';
}

// ---- status blocks (SD-MEM) ----
// A status heading is `## Status YYYY-MM-DD[ ~HH:MM] …`. Its key is "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". Blocks are
// compared by date; the time only decides between two blocks of the same date that both carry one.
const STATUS_HEADING_RE = /^## Status (\d{4}-\d{2}-\d{2})(?:[ \t]+~?(\d{1,2}):(\d{2}))?.*$/gm;
const MISSION_STALE_DAYS = 7;
const DAY_MS = 86400000;

/** statusBlocks(text) -> [{heading, key, start, end}] in document order; end = the next `## ` heading or the end. */
function statusBlocks(text) {
  if (typeof text !== 'string' || !text) return [];
  const heads = [...text.matchAll(/^## .*$/gm)].map((m) => m.index);
  const out = [];
  for (const m of text.matchAll(STATUS_HEADING_RE)) {
    const next = heads.find((i) => i > m.index);
    const key = m[1] + (m[2] ? ' ' + m[2].padStart(2, '0') + ':' + m[3] : '');
    out.push({ heading: m[0].replace(/\s+$/, ''), key, start: m.index, end: next === undefined ? text.length : next });
  }
  return out;
}
/** compareStatusKeys(a, b) -> <0 when a is older, >0 when newer, 0 when the order cannot be told. */
function compareStatusKeys(a, b) {
  const da = String(a).slice(0, 10), db = String(b).slice(0, 10);
  if (da !== db) return da < db ? -1 : 1;
  const ta = String(a).slice(11), tb = String(b).slice(11);
  return ta && tb && ta !== tb ? (ta < tb ? -1 : 1) : 0;
}
/** latestStatusBlock(text) -> {heading, key, start, end} | null: the newest by date and time, whatever its position
 *  (on a tie the topmost wins, the file's own newest-first convention). Total: never throws. */
function latestStatusBlock(text) {
  let best = null;
  for (const b of statusBlocks(text)) if (!best || compareStatusKeys(b.key, best.key) > 0) best = b;
  return best;
}
const dayOf = (iso) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || '')); return m ? m[1] : null; };
/** missionIsStale(block, newestWorkRunId, newestWorkIso) -> boolean. True when the newest run id the block names is
 *  from an older day than the newest run with real work, or when the newest date it names is more than 7 days before
 *  that work. A block that names no run id and no date, or an unknown newest work, is never called stale (kept). */
function missionIsStale(block, newestWorkRunId, newestWorkIso) {
  if (typeof block !== 'string' || !block) return false;
  const workRunDay = dayOf(String(newestWorkRunId || '').replace(/^forge-/, ''));
  const workDay = dayOf(newestWorkIso) || workRunDay;
  if (!workDay) return false;
  const runDays = [...block.matchAll(/\bforge-(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort();
  const newestRun = runDays[runDays.length - 1];
  if (newestRun && workRunDay && newestRun < workRunDay) return true;
  const days = [...block.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]).filter((d) => !Number.isNaN(Date.parse(d))).sort();
  const newestDay = days[days.length - 1];
  if (!newestDay) return false;
  return Date.parse(workDay) - Date.parse(newestDay) > MISSION_STALE_DAYS * DAY_MS;
}

/** appendMemoryFile({file, content}, {root}) -> {ok, path} | {ok:false, reason}. Joins with one newline, writes LF. */
function appendMemoryFile(args, opts) {
  const root = (opts && opts.root) || PROJECT_ROOT;
  const { file, content } = args || {};
  const bad = checkMemoryFile(file);
  if (bad) return { ok: false, reason: bad };
  const add = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
  if (!add.trim()) return { ok: false, reason: 'the draft is empty' };
  const dst = path.join(root, '.claude', ...file.split('/'));
  let old = '';
  try { old = fs.readFileSync(dst, 'utf8').replace(/\r\n?/g, '\n'); }
  catch (e) { if (e.code !== 'ENOENT') return { ok: false, reason: 'cannot read ' + file + ' (' + e.code + ')' }; }
  let draft = add.replace(/^\n+/, '');
  // CORE-1-F2: a close-out headed `## 2026-11-09 — …` is a status block too; without "Status" it landed at the bottom.
  if (file === 'FORGE_MEMORY.md') draft = draft.replace(/^## (\d{4}-\d{2}-\d{2})/, '## Status $1');
  // CORE-1-F2: the same close-out was appended twice in three files. Refuse a heading (with or without "Status") the
  // file already has, and a headingless draft whose every line is already a line of the file.
  const head = (/^## .*$/m.exec(draft) || [''])[0].trim();
  const lines = new Set(old.split('\n').map((l) => l.trim()));
  const known = (l) => !l.trim() || lines.has(l.trim());
  if (head ? [head, head.replace(/^## Status /, '## ')].some((h) => lines.has(h)) : draft.split('\n').every(known)) {
    return { ok: false, reason: file + ' already has ' + (head ? 'the heading "' + head + '"' : 'this text') + ' (a second append of the same entry)' };
  }
  const firstHeading = file === 'FORGE_MEMORY.md' && /^## Status \d{4}-\d{2}-\d{2}/.test(draft) ? old.search(/^## /m) : -1;
  let text;
  if (firstHeading >= 0) {
    text = old.slice(0, firstHeading) + draft.replace(/\n*$/, '\n') + '\n' + old.slice(firstHeading);
  } else {
    const joined = (old && !old.endsWith('\n') ? old + '\n' : old) + draft;
    text = joined.endsWith('\n') ? joined : joined + '\n';
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, dst);
  return { ok: true, path: dst };
}

const USAGE = 'usage: forge-run-file.cjs put --run <run_id> --name <file> --from <draft|->\n'
  + '       forge-run-file.cjs append --file <memory file> --from <draft|->\n';

function main(argv) {
  const cmd = argv[0];
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (cmd !== 'put' && cmd !== 'append') { process.stderr.write(USAGE); return 1; }
  const from = flag('--from');
  if (!from) { process.stderr.write('REFUSED: give --from <draft path> (or - for stdin)\n'); return 1; }
  let content;
  try { content = from === '-' ? fs.readFileSync(0) : fs.readFileSync(path.resolve(process.cwd(), from)); }
  catch (e) { process.stderr.write('REFUSED: cannot read the draft ' + from + ' (' + e.code + ')\n'); return 1; }
  if (cmd === 'append') {
    const a = appendMemoryFile({ file: flag('--file'), content: content.toString('utf8') });
    if (!a.ok) { process.stderr.write('REFUSED: ' + a.reason + '\n'); return 1; }
    process.stdout.write('appended ' + path.relative(PROJECT_ROOT, a.path).split(path.sep).join('/') + '\n');
    return 0;
  }
  const r = putRunFile({ run: flag('--run'), name: flag('--name'), content });
  if (!r.ok) { process.stderr.write('REFUSED: ' + r.reason + '\n'); return 1; }
  process.stdout.write('written ' + path.relative(PROJECT_ROOT, r.path).split(path.sep).join('/') + '\n');
  return 0;
}

module.exports = { putRunFile, checkName, appendMemoryFile, checkMemoryFile, statusBlocks, latestStatusBlock, compareStatusKeys, missionIsStale };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
