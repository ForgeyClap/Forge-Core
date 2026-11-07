#!/usr/bin/env node
'use strict';
/**
 * forge-craft-evidence.cjs — proof that a rendered UI was really looked at (modernization).
 *
 * Owner complaint: designs and output looked generic and sloppy, and "checked at all widths" was a sentence, not a
 * fact. A craft lens may carry an optional `guidance` block (a token plan to write before building, the tells of a
 * generated-looking design, copy and empty-state rules, Forge-written accessibility / performance / UX rule lines and
 * the evidence it requires). This helper owns that block's schema and the EVIDENCE RECORD: one JSON file per lens
 * type that lists, per view (page or screen), a screenshot per required viewport and per required state, each with
 * one line on what was checked there, or an explicit n/a with a reason. `check` confirms that every required viewport
 * and state is present, that every screenshot file exists INSIDE the project and is a real image, and that a PNG is
 * at least as wide as the CSS width it claims. It marks nothing as good-looking: it only proves the files exist and
 * the reviewer said what they looked at. Written from Forge's own idea list; no remote rule set is fetched, ever.
 *
 * Record: <run folder>/craft-evidence-<type>.json (run folder from forge-craft.cjs runDirFor, layout-aware via
 * forge-paths.cjs), or any file passed with --file. Paths inside it are project-relative with / separators.
 * CLI (--json for machine output; --root <dir> or FORGE_PROJECT_ROOT points at another project root):
 *   check --run <id> [--type <t>]   every craft-evidence-*.json in the run folder (or just <t>)
 *   check --file <record.json>      one record file
 *   template --type <t> [--views "home,contact"]   an empty record to fill (every entry still needs filling)
 * Exit: 0 complete · 1 incomplete or invalid (a gap, a missing file, no record) · 2 usage or cannot judge.
 * Deterministic: no clock, no randomness, no network. Zero dependencies; forge-craft.cjs is required lazily.
 */
const fs = require('fs'), path = require('path');

const RECORD_KIND = 'forge-craft-evidence', RECORD_VERSION = 1;
const RECORD_FILE_RE = /^craft-evidence-([a-z0-9][a-z0-9-]*)\.json$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const SLUG_P = '^[a-z0-9][a-z0-9-]*$', SLUG = new RegExp(SLUG_P);
const MIN_NOTE = 12; // a line on what was checked, or an n/a reason: "looked fine" says nothing
const EMPTY_NOTE = /^(ok|okay|fine|good|done|checked|looks? (good|fine|ok|okay)|all good|no issues?|n\/?a|none|-+)\.?$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_VIEWS = 50, MAX_SHOTS = 10;
const DPR = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];

const STR = { type: 'string', minLength: 1 };
const SLUG_S = { type: 'string', pattern: SLUG_P };
const GUIDANCE_SCHEMA = {
  type: 'object',
  required: ['precedence', 'before_build', 'tells', 'copy_rules', 'rule_lines'],
  additionalProperties: false,
  description: 'optional (WP-S3): what to do BEFORE building and the rule lines to build to; `requires_evidence` names the viewports and states a forge-craft-evidence record must cover. Guidance, never results.',
  properties: {
    precedence: Object.assign({ description: 'one sentence: the brief\'s explicit visual direction wins over this lens' }, STR),
    before_build: { type: 'array', minItems: 2, maxItems: 6, items: STR, description: 'the plan to write and review against the brief before any markup' },
    tells: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'object', required: ['id', 'tell', 'instead'], additionalProperties: false, properties: { id: SLUG_S, tell: STR, instead: STR } } },
    copy_rules: { type: 'array', minItems: 2, maxItems: 8, items: STR },
    rule_lines: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'object', required: ['id', 'area', 'rule'], additionalProperties: false, properties: { id: SLUG_S, area: { enum: ['accessibility', 'performance', 'ux'] }, rule: STR } } },
    requires_evidence: { type: 'object', required: ['viewports', 'states'], additionalProperties: false, properties: {
      viewports: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['id', 'min_px', 'max_px'], additionalProperties: false, properties: { id: SLUG_S, min_px: { type: 'integer', minimum: 200 }, max_px: { type: 'integer', minimum: 200 } } } },
      states: { type: 'array', minItems: 0, maxItems: 8, items: SLUG_S } } },
  },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const arr = (v) => (Array.isArray(v) ? v : []);
const note = (v) => isText(v) && v.trim().length >= MIN_NOTE && !EMPTY_NOTE.test(v.trim());
const defaultRoot = () => (process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..'));
const craft = () => require('./forge-craft.cjs'); // lazy: forge-craft.cjs requires this file at load time

/** shapeProblems(v, node, where) -> problems for the small schema subset GUIDANCE_SCHEMA uses. Total: never throws. */
function shapeProblems(v, node, where) {
  const P = [];
  if (node.enum) { if (!node.enum.includes(v)) P.push(where + ' must be one of ' + node.enum.join('|')); return P; }
  if (node.type === 'string') {
    if (!isText(v)) P.push(where + ' must be a non-empty string');
    else if (node.pattern && !new RegExp(node.pattern).test(v)) P.push(where + ' must be a slug');
    return P;
  }
  if (node.type === 'integer') { if (!Number.isInteger(v) || v < (node.minimum || 0)) P.push(where + ' must be an integer >= ' + (node.minimum || 0)); return P; }
  if (node.type === 'array') {
    if (!Array.isArray(v)) return [where + ' must be an array'];
    if (v.length < (node.minItems || 0) || v.length > (node.maxItems || Infinity)) P.push(where + ' must hold ' + (node.minItems || 0) + '..' + node.maxItems + ' items (has ' + v.length + ')');
    v.forEach((x, i) => P.push(...shapeProblems(x, node.items, where + '[' + i + ']')));
    return P;
  }
  if (!isObj(v)) return [where + ' must be an object'];
  for (const k of node.required || []) if (!(k in v)) P.push(where + '.' + k + ' is missing');
  for (const k of Object.keys(v)) {
    if (!node.properties[k]) P.push(where + '.' + k + ' is not a guidance field (a lens lists guidance, it never carries results)');
    else P.push(...shapeProblems(v[k], node.properties[k], where + '.' + k));
  }
  return P;
}
/** guidanceProblems(g) -> problems of a lens `guidance` block: the shape plus unique ids and sane viewport ranges. */
function guidanceProblems(g) {
  const P = shapeProblems(g, GUIDANCE_SCHEMA, 'lens.guidance');
  if (P.length) return P;
  for (const k of ['tells', 'rule_lines']) {
    const seen = new Set();
    for (const x of g[k]) { if (seen.has(x.id)) P.push('lens.guidance.' + k + ' id "' + x.id + '" is a duplicate'); seen.add(x.id); }
  }
  if (g.requires_evidence) {
    const vs = new Set(), ss = new Set();
    for (const v of g.requires_evidence.viewports) {
      if (vs.has(v.id)) P.push('lens.guidance.requires_evidence viewport "' + v.id + '" is a duplicate');
      vs.add(v.id);
      if (v.max_px < v.min_px) P.push('lens.guidance.requires_evidence viewport "' + v.id + '" has max_px below min_px');
    }
    for (const s of g.requires_evidence.states) { if (ss.has(s)) P.push('lens.guidance.requires_evidence state "' + s + '" is a duplicate'); ss.add(s); }
  }
  return P;
}

/** guidanceLines(g, type, {short}) -> the text lines forge-craft prints for a lens with guidance. */
function guidanceLines(g, type, opts) {
  const short = !!(opts && opts.short);
  const L = ['Precedence: ' + g.precedence, 'Before you build (write this plan and hold it against the brief):'];
  for (const s of g.before_build) L.push('  - ' + s);
  if (short) L.push('Looks-generated tells: ' + g.tells.map((t) => t.id).join(', ') + ' · rule lines: ' + g.rule_lines.map((r) => r.id).join(', ') + ' (full text: lens --type ' + type + ')');
  else {
    L.push('Looks-generated tells (each one found is a defect unless the brief asked for it):');
    for (const t of g.tells) L.push('  - ' + t.id + ': ' + t.tell + ' -> instead: ' + t.instead);
    L.push('Copy and empty-state rules:');
    for (const c of g.copy_rules) L.push('  - ' + c);
    L.push('Accessibility, performance and UX rule lines:');
    for (const r of g.rule_lines) L.push('  - [' + r.area + '] ' + r.id + ': ' + r.rule);
  }
  if (g.requires_evidence) {
    L.push('Evidence record: per view, a screenshot per viewport (' + g.requires_evidence.viewports.map((v) => v.id + ' ' + v.min_px + '-' + v.max_px + ' px').join(', ') + ')'
      + (g.requires_evidence.states.length ? ' and per state (' + g.requires_evidence.states.join(', ') + ')' : '') + ', or n/a with a reason.');
    L.push('  Fill: node .claude/forge-bin/forge-craft-evidence.cjs template --type ' + type + ' · prove: node .claude/forge-bin/forge-craft-evidence.cjs check --run <run_id> --type ' + type);
  }
  return L;
}

/** requirementFor(root, type) -> {ok, viewports, states, rel} | {ok:false, problem}: what the current lens demands. */
function requirementFor(root, type) {
  if (!isText(type) || !SLUG.test(type)) return { ok: false, problem: 'the record names no valid lens type' };
  const r = craft().loadLens(root, type);
  if (!r) return { ok: false, problem: 'no lens "' + type + '" in this project (.claude/config/quality/lenses/' + type + '.json)' };
  if (r.error || !r.valid) return { ok: false, problem: 'the ' + type + ' lens is not valid here: ' + (r.error || r.problems.slice(0, 3).join('; ')) };
  const ev = r.lens.guidance && r.lens.guidance.requires_evidence;
  if (!ev) return { ok: false, problem: 'the ' + type + ' lens asks for no evidence record (no guidance.requires_evidence)' };
  return { ok: true, viewports: ev.viewports, states: ev.states, rel: r.rel };
}

/** imageInfo(abs) -> {kind, width|null} | {problem}: magic bytes decide; a PNG also reports its pixel width. */
function imageInfo(abs) {
  let fd, buf = Buffer.alloc(32), n = 0;
  try { fd = fs.openSync(abs, 'r'); n = fs.readSync(fd, buf, 0, 32, 0); } catch (e) { return { problem: 'cannot be read (' + e.code + ')' }; } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (n >= 24 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString('latin1', 12, 16) === 'IHDR') return { kind: 'png', width: buf.readUInt32BE(16) };
  if (n >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'jpeg', width: null };
  if (n >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { kind: 'webp', width: null };
  return { problem: 'is not a PNG, JPEG or WebP image (wrong magic bytes)' };
}
/** shotProblem(root, rel) -> {problem} | {abs, info}: project-relative, inside the project after links, a real image. */
function shotProblem(root, rel) {
  if (!isText(rel)) return { problem: 'a screenshot path is empty' };
  const p = rel.replace(/\\/g, '/');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return { problem: '"' + rel + '" must be a project-relative path with / separators (no drive, URL or ..)' };
  if (!IMAGE_EXT.test(p)) return { problem: '"' + rel + '" is not a .png, .jpg or .webp file' };
  const abs = path.join(root, ...p.split('/'));
  let st;
  try { st = fs.statSync(abs); } catch { return { problem: '"' + rel + '" does not exist in the project' }; }
  if (!st.isFile()) return { problem: '"' + rel + '" is not a file' };
  try {
    const real = fs.realpathSync(abs), realRoot = fs.realpathSync(root), back = path.relative(realRoot, real);
    if (back.startsWith('..') || path.isAbsolute(back)) return { problem: '"' + rel + '" resolves outside the project' };
  } catch (e) { return { problem: '"' + rel + '" cannot be resolved (' + e.code + ')' }; }
  const info = imageInfo(abs);
  if (info.problem) return { problem: '"' + rel + '" ' + info.problem };
  return { abs, info, rel: p };
}

/** entryProblems(e, where, root, shots, W) -> problems of one viewport or state entry: shots + a note, or n/a + reason. */
function entryProblems(e, where, root, shots, W) {
  if (!isObj(e)) return [where + ' must be an object: {screenshots, checked} or {na}'];
  const P = [];
  const allowed = ['screenshots', 'checked', 'na', 'width'];
  for (const k of Object.keys(e)) if (!allowed.includes(k)) P.push(where + '.' + k + ' is not a record field');
  if ('na' in e) {
    if (!note(e.na)) P.push(where + ' is marked n/a without a real reason (at least ' + MIN_NOTE + ' characters that say why)');
    if ('screenshots' in e || 'checked' in e) P.push(where + ' is both n/a and filled: pick one');
    return P;
  }
  const list = arr(e.screenshots);
  if (!Array.isArray(e.screenshots) || !list.length) P.push(where + ' lists no screenshot (or mark it n/a with a reason)');
  if (list.length > MAX_SHOTS) P.push(where + ' lists more than ' + MAX_SHOTS + ' screenshots');
  if (!note(e.checked)) P.push(where + '.checked must say what was looked at in the image (at least ' + MIN_NOTE + ' characters, not "ok")');
  for (const rel of list.slice(0, MAX_SHOTS)) {
    const s = shotProblem(root, rel);
    if (s.problem) { P.push(where + ': ' + s.problem); continue; }
    shots.push(s);
    if (W && W.width && s.info.kind === 'png') {
      if (s.info.width < W.width) P.push(where + ': "' + s.rel + '" is ' + s.info.width + ' px wide, narrower than the ' + W.width + ' px viewport it claims (crop or wrong file)');
      else if (!DPR.some((d) => Math.abs(s.info.width / W.width - d) <= 0.02 * d)) W.warnings.push(where + ': "' + s.rel + '" is ' + s.info.width + ' px wide; at ' + W.width + ' px that is no usual pixel ratio. Check it is the right file.');
    }
  }
  return P;
}

/** validateRecord(record, {root, viewports, states}) -> {ok, problems, warnings, summary}. Total: never throws. */
function validateRecord(rec, req) {
  const P = [], warnings = [], root = req.root;
  const summary = { views: 0, entries_filled: 0, entries_na: 0, screenshots_verified: 0 };
  if (!isObj(rec)) return { ok: false, problems: ['the record is not a JSON object'], warnings, summary };
  if (rec.kind !== RECORD_KIND || rec.version !== RECORD_VERSION) P.push('kind must be "' + RECORD_KIND + '" and version ' + RECORD_VERSION + ' (start from: forge-craft-evidence.cjs template)');
  for (const k of Object.keys(rec)) if (!['kind', 'version', 'type', 'served_from', 'reviewer', 'views'].includes(k)) P.push(k + ' is not a record field');
  if (!isText(rec.served_from) || /^file:/i.test(rec.served_from.trim())) P.push('served_from must name where the pages were served (a localhost or preview URL, or the app build); never a file:// URL');
  if (!Array.isArray(rec.views) || !rec.views.length) { P.push('views must list at least one view (page or screen)'); return { ok: false, problems: P, warnings, summary }; }
  if (rec.views.length > MAX_VIEWS) P.push('views lists more than ' + MAX_VIEWS + ' views');
  const names = new Set();
  rec.views.slice(0, MAX_VIEWS).forEach((v, i) => {
    const w = 'views[' + i + ']';
    if (!isObj(v)) { P.push(w + ' must be an object'); return; }
    const name = isText(v.view) ? v.view.trim() : '';
    const vw = name ? 'view "' + name + '"' : w;
    if (!name) P.push(w + '.view must name the page or screen');
    else if (names.has(name)) P.push(vw + ' is listed twice');
    names.add(name);
    for (const k of Object.keys(v)) if (!['view', 'path', 'viewports', 'states'].includes(k)) P.push(vw + '.' + k + ' is not a record field');
    summary.views++;
    const shotsByViewport = new Map();
    for (const [group, wanted] of [['viewports', req.viewports.map((x) => x.id)], ['states', req.states]]) {
      const got = isObj(v[group]) ? v[group] : null;
      if (!got) { if (wanted.length) P.push(vw + '.' + group + ' is missing (needs ' + wanted.join(', ') + ')'); continue; }
      for (const k of Object.keys(got)) if (!wanted.includes(k)) P.push(vw + ' ' + group.slice(0, -1) + ' "' + k + '" is not one the lens asks for (' + wanted.join(', ') + ')');
      for (const id of wanted) {
        const where = vw + ' ' + group.slice(0, -1) + ' "' + id + '"';
        if (!(id in got)) { P.push(where + ' is missing (add screenshots, or n/a with a reason)'); continue; }
        const e = got[id];
        let W = null;
        if (group === 'viewports' && isObj(e) && !('na' in e)) {
          const spec = req.viewports.find((x) => x.id === id);
          if (!Number.isInteger(e.width) || e.width < spec.min_px || e.width > spec.max_px) P.push(where + '.width must be the CSS viewport width used, ' + spec.min_px + '-' + spec.max_px + ' px');
          else W = { width: e.width, warnings };
        } else if (isObj(e) && 'width' in e) P.push(where + '.width belongs to a filled viewport entry only');
        const shots = [];
        P.push(...entryProblems(e, where, root, shots, W));
        if (isObj(e) && 'na' in e) summary.entries_na++; else summary.entries_filled++;
        summary.screenshots_verified += shots.length;
        if (group === 'viewports') for (const s of shots) {
          if (shotsByViewport.has(s.rel) && shotsByViewport.get(s.rel) !== id) P.push(vw + ': "' + s.rel + '" is listed for viewport ' + shotsByViewport.get(s.rel) + ' and ' + id + ' (one image cannot prove two widths)');
          shotsByViewport.set(s.rel, id);
        }
      }
    }
  });
  return { ok: P.length === 0, problems: P, warnings, summary };
}

/** checkFile({root, file, type}) -> {code, type, file, ok, problems, warnings, summary}. code 0 / 1 / 2 as the CLI. */
function checkFile(opts) {
  const root = opts.root, rel = path.relative(root, opts.file).split(path.sep).join('/');
  const out = { type: opts.type || null, file: rel, ok: false, problems: [], warnings: [], summary: null, code: 1 };
  let text;
  try { text = fs.readFileSync(opts.file, 'utf8'); } catch (e) { out.problems.push('no evidence record at ' + rel + ' (' + e.code + ')'); out.code = e.code === 'ENOENT' ? 1 : 2; return out; }
  let rec;
  try { rec = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { out.problems.push(rel + ' is not valid JSON: ' + e.message); out.code = 2; return out; }
  const type = opts.type || (isObj(rec) ? rec.type : null);
  out.type = type;
  if (isObj(rec) && opts.type && rec.type !== opts.type) { out.problems.push(rel + ' is a record for "' + rec.type + '", not "' + opts.type + '"'); return out; }
  const req = requirementFor(root, type);
  if (!req.ok) { out.problems.push(req.problem); out.code = 2; return out; }
  const v = validateRecord(rec, { root, viewports: req.viewports, states: req.states });
  Object.assign(out, { ok: v.ok, problems: v.problems, warnings: v.warnings, summary: v.summary, code: v.ok ? 0 : 1 });
  return out;
}
/** checkRun({root, runId, type}) -> {code, run_id, folder, records[]}: every record in the run folder, or one type. */
function checkRun(opts) {
  const dir = craft().runDirFor(opts.root, opts.runId);
  const folder = path.relative(opts.root, dir).split(path.sep).join('/');
  let types;
  if (opts.type) types = [opts.type];
  else { try { types = fs.readdirSync(dir).map((n) => RECORD_FILE_RE.exec(n)).filter(Boolean).map((m) => m[1]).sort(); } catch { types = []; } }
  if (!types.length) return { code: 1, run_id: opts.runId, folder, records: [], problem: 'no craft-evidence-<type>.json in ' + folder };
  const records = types.map((t) => checkFile({ root: opts.root, file: path.join(dir, 'craft-evidence-' + t + '.json'), type: t }));
  return { code: Math.max(...records.map((r) => r.code)), run_id: opts.runId, folder, records };
}

/** templateFor(root, type, views[]) -> {record} | {problem}: an empty record shaped by the lens, every entry unfilled. */
function templateFor(root, type, views) {
  const req = requirementFor(root, type);
  if (!req.ok) return { problem: req.problem };
  const entry = () => ({ screenshots: [], checked: '' });
  return { record: { kind: RECORD_KIND, version: RECORD_VERSION, type, served_from: '', reviewer: '',
    views: (views.length ? views : ['home']).map((name) => ({ view: name, path: '',
      viewports: Object.fromEntries(req.viewports.map((v) => [v.id, Object.assign({ width: v.min_px }, entry())])),
      states: Object.fromEntries(req.states.map((s) => [s, entry()])) })) } };
}

const USAGE = ['usage: node forge-craft-evidence.cjs check --run <run_id> [--type <t>] [--json]',
  '       node forge-craft-evidence.cjs check --file <record.json> [--type <t>] [--json]',
  '       node forge-craft-evidence.cjs template --type <t> [--views "home,contact"]   (every command takes --root <projectRoot>)',
  'A filled entry: {"screenshots": ["docs/shots/home-375.png"], "checked": "what you looked at"} (viewports add "width": <css px>);',
  'an entry that does not apply: {"na": "the reason"}. Exit 0 complete · 1 incomplete · 2 usage or cannot judge.'].join('\n');

function printResult(r, out) {
  out(r.type + ' (' + r.file + '): ' + (r.ok ? 'COMPLETE · ' + r.summary.views + ' view(s), ' + r.summary.entries_filled + ' entries with screenshots, ' + r.summary.entries_na + ' n/a, ' + r.summary.screenshots_verified + ' screenshot file(s) verified' : 'INCOMPLETE (' + r.problems.length + ' problem(s))'));
  for (const p of r.problems) out('  - ' + p);
  for (const w of r.warnings) out('  warning: ' + w);
}

/** main(argv, io) -> exit code. io = {out, err, root} so tests can run it in-process. */
function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const err = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const [cmd, ...rest] = argv;
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined; };
  const root = val('--root') ? path.resolve(val('--root')) : ((io && io.root) || defaultRoot());
  const json = rest.includes('--json');
  const type = val('--type') ? val('--type').trim().toLowerCase() : undefined;
  if (cmd === 'help' || cmd === '--help') { out(USAGE); return 0; }
  if (type !== undefined && !SLUG.test(type)) { err(USAGE); return 2; }
  if (cmd === 'template') {
    if (!type) { err(USAGE); return 2; }
    const views = String(val('--views') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const t = templateFor(root, type, views);
    if (t.problem) { err('forge-craft-evidence: ' + t.problem); return 2; }
    out(JSON.stringify(t.record, null, 2));
    return 0;
  }
  if (cmd !== 'check') { err(USAGE); return 2; }
  const run = val('--run'), file = val('--file');
  if (!!run === !!file || (run && !RUN_ID_RE.test(run))) { err(USAGE); return 2; }
  if (file) {
    const r = checkFile({ root, file: path.resolve(file), type });
    if (json) out(JSON.stringify(r, null, 2)); else printResult(r, out);
    return r.code;
  }
  let r;
  try { r = checkRun({ root, runId: run, type }); } catch (e) { err('forge-craft-evidence: the run folder could not be resolved (' + e.message + ')'); return 2; }
  if (json) out(JSON.stringify(r, null, 2));
  else { if (r.problem) out('Run ' + run + ': ' + r.problem + ' — the rendered UI has no evidence record yet.'); for (const x of r.records) printResult(x, out); }
  return r.code;
}

module.exports = { GUIDANCE_SCHEMA, RECORD_KIND, RECORD_VERSION, MIN_NOTE, guidanceProblems, guidanceLines, requirementFor,
  imageInfo, shotProblem, validateRecord, checkFile, checkRun, templateFor, main };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-craft-evidence: internal error: ' + (e && e.stack || e) + '\n'); process.exitCode = 1; }
}
