#!/usr/bin/env node
'use strict';
/**
 * forge-craft.cjs — the CRAFT LENS (modernization Phase I, work package I.3).
 *
 * Owner rule (Intelligence bar, rule 2): before "done", ask of every deliverable who will look at it or work with
 * it and what they would notice; sloppy output is a defect, not a style. A lens is one deliverable type with its
 * STAKEHOLDERS, a short DETAIL checklist per stakeholder, the EVIDENCE that proves each check, a first-ten-seconds
 * test and the common sloppy defects a professional spots. Lenses are data in .claude/config/quality/lenses/<type>.json;
 * this tool validates and prints them. It NEVER marks a check (like `forge-quality.cjs gate`, it only lists): the
 * reviewing Boss marks every check CLEAN / DEFECT / NOT_INSPECTED / N/A with evidence. R2: a lens check flagged
 * "owner_data": true (it needs data only the owner can give) may be marked WAITING_ON_OWNER, with evidence of how the
 * placeholder is labelled to the visitor; the run contract lists it as a visible exception. On any other check that mark
 * counts as an unresolved DEFECT. Which checks are owner data is always read from the lens file, never from the form.
 *
 * Provenance per check: `cited` (a quote that must still be found in a playbook section, an agent checklist, a
 * FORGE_HARD_RULES / FORGE_STANDING_RULES rule, or the owner's evidence and rule text) or `professional_practice`
 * (a one-line rationale). Citations under docs/ exist only in the development tree: in a synced project they are
 * reported as "not shipped here", never as stale. Self-contained on purpose (zero dependencies, no require of
 * forge-quality.cjs): the citation rules match the gate cards (section prefix match, bold/backticks/whitespace ignored).
 * The only sibling it touches is an optional, guarded require of forge-paths.cjs (record/check find the run folder in the
 * project's layout; without it the legacy .claude/forge-runs folder is used, never a crash).
 *
 * CLI (add --json for machine output; --root <dir> or FORGE_PROJECT_ROOT points at another project root):
 *   lens --type <t>                      one lens; an unknown type falls back to the generic lens and says so
 *   lens --list | lens --schema          every lens with its counts | the lens schema
 *   plan --deliverables "a,b" | --domain <d> [--text "<request>"]   the combined review plan for a mission
 *   review-template --type <t> | --deliverables "a,b" | --domain <d> [--text "<request>"]   the self-critique form to fill
 *                                        (I.8b) --domain picks the domain's lenses; --text adds every lens whose `selected_by`
 *                                        words the request names (spreadsheet, nieuwsbrief, donation page ...); a type the
 *                                        catalog does not know is judged by its own name too, and keeps generic as safety net.
 *                                        (I.9) `selected_together` selects a lens when ONE sentence names a word of every
 *                                        group ("an app where users can book" -> web-ui), unless it names an `unless` word
 *   validate                             schema + citations of every lens (exit 3 when any lens is invalid or stale)
 *   record --run <id> --type <t> --file <review.json|->   (I.6) validate a FILLED review against the lens and store it
 *                                        as craft-review-<t>.json in the run folder + log one agent_note. Exit 0 recorded
 *                                        (it still says when a block DEFECT is unresolved) · 3 refused, nothing written · 2 usage
 *   check --run <id> [--type <t>]        (I.6) re-read the recorded reviews: exit 0 = every one is untampered, valid and
 *                                        has no unresolved block DEFECT · 3 otherwise (or none recorded)
 * A lens may carry an optional `guidance` block (token plan, generated-look tells, copy rules, rule lines, the
 * evidence record it needs); its schema, its text and the screenshot evidence check live in forge-craft-evidence.cjs.
 * Exit: 0 printed · 2 usage · 3 invalid lens · 1 internal error. Deterministic: no clock, no randomness, no network.
 * record/check never set a mark: the reviewer marks, these commands only validate and store what was marked.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const EV = (() => { try { const m = require('./forge-craft-evidence.cjs'); return m && typeof m.guidanceProblems === 'function' ? m : null; } catch { return null; } })();

const MARKS = ['CLEAN', 'DEFECT', 'NOT_INSPECTED', 'N/A', 'WAITING_ON_OWNER'];
const SEVERITIES = ['block', 'warn'];
const PROVENANCE = ['cited', 'professional_practice'];
const FALLBACK = 'generic';
const MAX_RATIONALE = 200, MIN_CHECK_TEXT = 20;
// user-facing lenses first, code and the fallback last; a lens added later sorts after these, alphabetically
const ORDER = ['web-ui', 'copy-and-content', 'game-and-interactive', 'voice-and-chat', 'automation-workflow', 'api-and-integration',
  'cli-and-devtools', 'data-and-reports', 'documents-and-spreadsheets', 'code', 'generic'];
const QUESTION = 'Ask of every detail: who looks at this or works with it, and what would they notice?';
const RULES = [
  'A block check marked DEFECT or NOT_INSPECTED means the deliverable is not done.',
  'A warn check marked DEFECT is fixed, or listed under stated weaknesses in plain words.',
  'Never mark CLEAN without the evidence the check names (a screenshot that was read, a command with its exit code, a rendered message).',
  'Sloppy output is a defect, not a style. Fix it, or say plainly what is still weak.',
  'WAITING_ON_OWNER is accepted only on a check flagged owner data (owner_data: true), only with evidence of how the placeholder is labelled to the visitor; the run contract lists it as a visible exception. On any other check it counts as a DEFECT.',
];

const STR = { type: 'string', minLength: 1 };
const SLUG_P = '^[a-z0-9][a-z0-9-]*$';
const CITE = { type: 'object', required: ['path', 'quote'], additionalProperties: false, description: 'markdown: {path, section, quote}; FORGE_HARD_RULES.json or FORGE_STANDING_RULES.json: {path, rule_id, quote}', properties: { path: STR, section: STR, rule_id: STR, quote: STR } };
const RATIONALE = { type: 'object', required: ['rationale'], additionalProperties: false, properties: { rationale: { type: 'string', minLength: 1, maxLength: MAX_RATIONALE } } };
const LENS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Forge craft lens',
  type: 'object',
  required: ['type', 'version', 'title', 'covers', 'domains', 'stakeholders', 'first_ten_seconds', 'checks', 'common_sloppy_defects'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', pattern: SLUG_P, description: 'equals the file name' },
    version: { type: 'integer', minimum: 1 },
    title: STR,
    covers: STR,
    domains: { type: 'array', items: { type: 'string', pattern: SLUG_P }, description: 'domain-catalog.json domains this lens usually applies to (plan --domain); empty is allowed' },
    selected_by: { type: 'object', required: ['en', 'nl'], additionalProperties: false, description: 'optional (I.8b): request words that select this lens next to its domains (plan --text, and the name of a type the catalog does not know). A word also matches its plurals and its -ing form, never a shorter word; "word*" = starts with; "-word" / "word-" = also as the end / start of a Dutch compound (one word of 5+ letters). The switch-catalog keyword rule.', properties: { en: { type: 'array', minItems: 1, items: STR }, nl: { type: 'array', minItems: 1, items: STR } } },
    selected_together: { type: 'array', minItems: 1, maxItems: 5, description: 'optional (I.9): word groups that select this lens only TOGETHER, for requests that describe a product by what people do with it instead of naming the deliverable ("an app where users can book", "een app waarmee mensen recepten kunnen delen"). A rule hits when ONE sentence of the request names a word from every group in `all` (any order, not adjacent) and that sentence names no `unless` word ("a CLI tool users can run from the terminal"). Words follow the selected_by rule. Only the request text is read, never a type name.', items: { type: 'object', required: ['all'], additionalProperties: false, properties: { all: { type: 'array', minItems: 2, maxItems: 4, items: { $ref: '#/properties/selected_by' } }, unless: { $ref: '#/properties/selected_by' } } } },
    stakeholders: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', required: ['id', 'who', 'cares_about', 'would_notice'], additionalProperties: false, properties: { id: { type: 'string', pattern: SLUG_P }, who: STR, cares_about: { type: 'array', minItems: 1, maxItems: 6, items: STR }, would_notice: { type: 'array', minItems: 1, maxItems: 8, items: STR } } } },
    first_ten_seconds: { type: 'array', minItems: 2, maxItems: 6, items: STR },
    checks: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['id', 'stakeholder', 'claim', 'how_to_inspect', 'evidence_required', 'severity', 'provenance', 'source'], additionalProperties: false, properties: { id: { type: 'string', pattern: SLUG_P }, stakeholder: { type: 'string', pattern: SLUG_P }, claim: STR, how_to_inspect: STR, evidence_required: STR, severity: { enum: SEVERITIES }, owner_data: { type: 'boolean', description: 'optional (R2, 2026-11-07): the check depends on data only the owner can give (real content, the client facts); a review may mark it WAITING_ON_OWNER with evidence of how the placeholder is labelled' }, provenance: { enum: PROVENANCE }, source: { oneOf: [CITE, RATIONALE] } } } },
    guidance: EV ? EV.GUIDANCE_SCHEMA : { type: 'object', description: 'optional (WP-S3); its schema lives in forge-craft-evidence.cjs' },
    common_sloppy_defects: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object', required: ['defect', 'symptom'], additionalProperties: false, properties: { defect: STR, symptom: STR } } },
  },
  'x-rules': [
    'every stakeholder has at least one block check; every check names a declared stakeholder',
    'provenance cited -> source is a citation with exactly one of section (markdown) or rule_id (JSON rules file); the quote must still be found there',
    'provenance professional_practice -> source is {rationale}: one line, at most ' + MAX_RATIONALE + ' characters',
    'claim, how_to_inspect and evidence_required are concrete (at least ' + MIN_CHECK_TEXT + ' characters)',
    'a lens lists checks; it never carries results (no status, mark or passed field anywhere)',
  ],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const SLUG = new RegExp(SLUG_P);
const arr = (v) => (Array.isArray(v) ? v : []);
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const defaultRoot = () => (process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..'));
const lensDir = (root) => path.join(root, '.claude', 'config', 'quality', 'lenses');
const lensRel = (type) => '.claude/config/quality/lenses/' + type + '.json';

/** closedShape(obj, node, where, P): required keys present, no key outside the schema node. */
function closedShape(obj, node, where, P) {
  if (!isObj(obj)) { P.push(where + ' is not an object'); return false; }
  for (const k of node.required || []) if (!(k in obj)) P.push(where + '.' + k + ' is missing');
  for (const k of Object.keys(obj)) if (!(node.properties || {})[k]) P.push(where + '.' + k + ' is not a lens field (a lens lists checks, it never carries results)');
  return true;
}
/** textList(v, [min, max], where, P): an array of non-empty strings within the size limits. */
function textList(v, lim, where, P) {
  if (!Array.isArray(v)) return P.push(where + ' must be an array');
  if (v.length < lim[0] || v.length > lim[1]) P.push(where + ' must hold ' + lim[0] + '..' + lim[1] + ' items (has ' + v.length + ')');
  if (!v.every(isText)) P.push(where + ' must hold non-empty strings');
  return null;
}
const lim = (node) => [node.minItems || 0, node.maxItems || Infinity];

/** sourceProblems(ch, where) -> problems for the source shape that the provenance demands. */
function sourceProblems(ch, where) {
  const P = [], s = ch.source;
  if (!isObj(s)) return [where + '.source must be an object'];
  if (ch.provenance === 'cited') {
    closedShape(s, CITE, where + '.source', P);
    for (const k of ['path', 'quote', 'section', 'rule_id']) if (k in s && !isText(s[k])) P.push(where + '.source.' + k + ' must be a non-empty string');
    if (isText(s.section) === isText(s.rule_id)) P.push(where + '.source needs exactly one of section or rule_id');
  } else if (ch.provenance === 'professional_practice') {
    closedShape(s, RATIONALE, where + '.source', P);
    if (!isText(s.rationale)) P.push(where + '.source.rationale must be a non-empty string');
    else if (/[\r\n]/.test(s.rationale) || s.rationale.length > MAX_RATIONALE) P.push(where + '.source.rationale must be one line of at most ' + MAX_RATIONALE + ' characters');
  }
  return P;
}

/** validateLens(lens, {type}) -> {ok, problems[]} against LENS_SCHEMA and its x-rules. Total: never throws. */
function validateLens(lens, opts) {
  const P = [];
  const S = LENS_SCHEMA.properties;
  if (!closedShape(lens, LENS_SCHEMA, 'lens', P)) return { ok: false, problems: P };
  if (!isText(lens.type) || !SLUG.test(lens.type)) P.push('lens.type must be a slug');
  else if (opts && opts.type && lens.type !== opts.type) P.push('lens.type "' + lens.type + '" does not match the file name "' + opts.type + '"');
  if (!Number.isInteger(lens.version) || lens.version < 1) P.push('lens.version must be an integer >= 1');
  for (const k of ['title', 'covers']) if (!isText(lens[k])) P.push('lens.' + k + ' must be a non-empty string');
  if (!Array.isArray(lens.domains) || !lens.domains.every((d) => isText(d) && SLUG.test(d))) P.push('lens.domains must be an array of domain slugs (empty is allowed)');
  if ('selected_by' in lens) P.push(...selectedByProblems(lens.selected_by));
  if ('selected_together' in lens) P.push(...togetherProblems(lens.selected_together));
  if ('guidance' in lens) P.push(...(EV ? EV.guidanceProblems(lens.guidance) : ['lens.guidance cannot be checked here: forge-craft-evidence.cjs is missing']));
  const ids = new Set();
  if (!Array.isArray(lens.stakeholders)) P.push('lens.stakeholders must be an array');
  else {
    const [mn, mx] = lim(S.stakeholders);
    if (lens.stakeholders.length < mn || lens.stakeholders.length > mx) P.push('lens.stakeholders must hold ' + mn + '..' + mx + ' stakeholders');
    lens.stakeholders.forEach((st, i) => {
      const w = 'stakeholders[' + i + ']';
      if (!closedShape(st, S.stakeholders.items, w, P)) return;
      if (!isText(st.id) || !SLUG.test(st.id)) P.push(w + '.id must be a slug');
      else if (ids.has(st.id)) P.push(w + '.id "' + st.id + '" is a duplicate');
      else ids.add(st.id);
      if (!isText(st.who)) P.push(w + '.who must be a non-empty string');
      textList(st.cares_about, lim(S.stakeholders.items.properties.cares_about), w + '.cares_about', P);
      textList(st.would_notice, lim(S.stakeholders.items.properties.would_notice), w + '.would_notice', P);
    });
  }
  textList(lens.first_ten_seconds, lim(S.first_ten_seconds), 'lens.first_ten_seconds', P);
  const checkIds = new Set(), blockBy = new Set();
  if (!Array.isArray(lens.checks)) P.push('lens.checks must be an array');
  else {
    const [mn, mx] = lim(S.checks);
    if (lens.checks.length < mn || lens.checks.length > mx) P.push('lens.checks must hold ' + mn + '..' + mx + ' checks (lenses stay short)');
    lens.checks.forEach((ch, i) => {
      const w = 'checks[' + i + ']';
      if (!closedShape(ch, S.checks.items, w, P)) return;
      if (!isText(ch.id) || !SLUG.test(ch.id)) P.push(w + '.id must be a slug');
      else if (checkIds.has(ch.id)) P.push(w + '.id "' + ch.id + '" is a duplicate');
      else checkIds.add(ch.id);
      if (!ids.has(ch.stakeholder)) P.push(w + '.stakeholder "' + ch.stakeholder + '" is not a declared stakeholder');
      for (const k of ['claim', 'how_to_inspect', 'evidence_required']) if (!isText(ch[k]) || ch[k].trim().length < MIN_CHECK_TEXT) P.push(w + '.' + k + ' must be concrete text (at least ' + MIN_CHECK_TEXT + ' characters)');
      if (!SEVERITIES.includes(ch.severity)) P.push(w + '.severity "' + ch.severity + '" is not block|warn');
      else if (ch.severity === 'block') blockBy.add(ch.stakeholder);
      if ('owner_data' in ch && typeof ch.owner_data !== 'boolean') P.push(w + '.owner_data must be true or false');
      if (!PROVENANCE.includes(ch.provenance)) P.push(w + '.provenance "' + ch.provenance + '" is not cited|professional_practice');
      P.push(...sourceProblems(ch, w));
    });
  }
  for (const id of ids) if (!blockBy.has(id)) P.push('stakeholder "' + id + '" has no block check (every stakeholder needs at least one)');
  if (!Array.isArray(lens.common_sloppy_defects)) P.push('lens.common_sloppy_defects must be an array');
  else {
    const [mn, mx] = lim(S.common_sloppy_defects);
    if (lens.common_sloppy_defects.length < mn || lens.common_sloppy_defects.length > mx) P.push('lens.common_sloppy_defects must hold ' + mn + '..' + mx + ' items');
    lens.common_sloppy_defects.forEach((d, i) => {
      const w = 'common_sloppy_defects[' + i + ']';
      if (closedShape(d, S.common_sloppy_defects.items, w, P) && !(isText(d.defect) && isText(d.symptom))) P.push(w + ' needs a non-empty defect and symptom');
    });
  }
  return { ok: P.length === 0, problems: P };
}

/** citation text compare: bold markers, backticks and whitespace runs do not count (the gate-card rule). */
const normCite = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
/** mdSection(text, heading) -> the body under the first heading whose text starts with `heading`, up to the next
 *  heading of the same or a higher level; null when there is no such heading. */
function mdSection(text, heading) {
  let level = 0, body = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (body !== null && m && m[1].length <= level) break;
    if (body !== null) { body.push(line); continue; }
    if (m && m[2].trim().startsWith(heading)) { level = m[1].length; body = []; }
  }
  return body === null ? null : body.join('\n');
}
function citePathProblem(rel) {
  if (!isText(rel)) return 'path is empty';
  if (rel.includes('\\') || /^[A-Za-z]:|^\//.test(rel) || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'path "' + rel + '" must be project-relative with / separators';
  if (!rel.startsWith('.claude/') && !rel.startsWith('docs/')) return 'path "' + rel + '" must stay under .claude/ or docs/';
  return null;
}
/** sourceKind(source) -> a short label for where a citation points. */
function sourceKind(c) {
  const p = String(c && c.path);
  if (p.startsWith('docs/audit/')) return 'owner evidence';
  if (p.startsWith('docs/claude-md/')) return 'owner rule';
  if (/HARD_RULES\.json$/.test(p)) return 'hard rule';
  if (/STANDING_RULES\.json$/.test(p)) return 'standing rule';
  if (p.startsWith('.claude/agents/')) return 'agent checklist';
  if (p.startsWith('.claude/skills/')) return 'playbook';
  return 'Forge doc';
}
/** verifyLensCitations(lens, root) -> {ok, checked, problems[], unavailable[]}: every cited check points at a file
 *  under root, a heading (markdown) or rule id (JSON rules file) that exists, and a quote found THERE. A missing
 *  docs/ file is `unavailable` (development-tree provenance), a missing .claude/ file is a problem. */
function verifyLensCitations(lens, root) {
  const problems = [], unavailable = [];
  let checked = 0;
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) { try { cache.set(rel, { text: fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8') }); } catch { cache.set(rel, { missing: true }); } }
    return cache.get(rel);
  };
  for (const ch of arr(lens && lens.checks)) {
    if (!isObj(ch) || ch.provenance !== 'cited' || !isObj(ch.source)) continue;
    checked++;
    const c = ch.source, w = String(ch.id);
    const bad = citePathProblem(c.path);
    if (bad) { problems.push(w + ': ' + bad); continue; }
    const f = read(c.path);
    if (f.missing) {
      if (c.path.startsWith('docs/')) unavailable.push(w + ': ' + c.path + ' (development-tree provenance, not shipped to this project)');
      else problems.push(w + ': ' + c.path + ' does not exist');
      continue;
    }
    if (/\.json$/.test(c.path)) {
      if (!isText(c.rule_id)) { problems.push(w + ': a JSON source needs rule_id'); continue; }
      let j; try { j = JSON.parse(f.text); } catch { problems.push(w + ': ' + c.path + ' is not valid JSON'); continue; }
      const r = [...arr(j && j.rules), ...arr(j && j.orchestration_hard_rules)].find((x) => isObj(x) && x.id === c.rule_id);
      if (!r) { problems.push(w + ': rule id "' + c.rule_id + '" not in ' + c.path); continue; }
      const text = typeof r.rule === 'string' ? r.rule : (typeof r.text === 'string' ? r.text : '');
      if (!normCite(text).includes(normCite(c.quote))) problems.push(w + ': quote not found in rule ' + c.rule_id + ' of ' + c.path);
      continue;
    }
    if (!isText(c.section)) { problems.push(w + ': a markdown source needs section'); continue; }
    const body = mdSection(f.text, c.section);
    if (body === null) { problems.push(w + ': no heading "' + c.section + '" in ' + c.path); continue; }
    if (!normCite(body).includes(normCite(c.quote))) problems.push(w + ': quote "' + String(c.quote).slice(0, 60) + '" not found under "' + c.section + '" in ' + c.path);
  }
  return { ok: problems.length === 0, checked, problems, unavailable };
}

/** lensTypes(root) -> every lens file's type, in ORDER (unknown ones after, alphabetically). */
function lensTypes(root) {
  let files = [];
  try { files = fs.readdirSync(lensDir(root)).filter((f) => /^[a-z0-9][a-z0-9-]*\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { files = []; }
  const rank = (t) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);
  return files.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}
/** loadLens(root, type) -> {lens, rel, sha256, valid, problems} | {error, rel} | null (null = no lens of that type). */
function loadLens(root, type) {
  if (!isText(type) || !SLUG.test(type)) return null;
  const rel = lensRel(type);
  let raw;
  try { raw = fs.readFileSync(path.join(lensDir(root), type + '.json'), 'utf8'); } catch { return null; }
  let lens;
  try { lens = JSON.parse(raw); } catch (e) { return { error: rel + ' is not valid JSON: ' + e.message, rel }; }
  const v = validateLens(lens, { type });
  return { lens, rel, sha256: sha(raw), valid: v.ok, problems: v.problems };
}
function counts(lens) {
  const cs = arr(lens && lens.checks);
  return { checks: cs.length, block: cs.filter((c) => c.severity === 'block').length, warn: cs.filter((c) => c.severity === 'warn').length,
    cited: cs.filter((c) => c.provenance === 'cited').length, professional_practice: cs.filter((c) => c.provenance === 'professional_practice').length,
    stakeholders: arr(lens && lens.stakeholders).length };
}
/** listLenses(root) -> [{type, title, checks, block, warn, cited, professional_practice, stakeholders, valid, problems}]. */
function listLenses(root) {
  return lensTypes(root).map((type) => {
    const r = loadLens(root, type);
    if (!r || r.error) return Object.assign({ type, title: null, valid: false, problems: [r ? r.error : 'unreadable'] }, counts(null));
    return Object.assign({ type, title: r.lens.title, valid: r.valid, problems: r.problems }, counts(r.lens));
  });
}
const parseList = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const fallbackNote = (what) => 'no lens for ' + what + ': using the generic lens. Derive the professional bar for this deliverable first (check bar-derived).';
/** resolveTypes(root, requested[]) -> {types, notices}: known types kept in request order, anything else -> generic once. */
function resolveTypes(root, requested) {
  const known = new Set(lensTypes(root)), types = [], notices = [];
  for (const t of requested) {
    if (known.has(t)) { if (!types.includes(t)) types.push(t); continue; }
    notices.push(fallbackNote('"' + t + '"'));
    if (!types.includes(FALLBACK)) types.push(FALLBACK);
  }
  return { types, notices };
}
/** typesForDomain(root, domain) -> {types, notices}: the lenses whose `domains` list the catalog domain, else generic. */
function typesForDomain(root, domain) {
  const types = lensTypes(root).filter((t) => { const r = loadLens(root, t); return !!(r && r.lens && arr(r.lens.domains).includes(domain)); });
  return types.length ? { types, notices: [] } : { types: [FALLBACK], notices: [fallbackNote('the domain "' + domain + '"')] };
}
function catalogDomains(root) {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'domain-catalog.json'), 'utf8')).domains || {}); } catch { return null; }
}

// ---- I.8b: deliverable words select lenses too (selected_by), through the shared NL/EN normaliser ----------
// Same keyword rule as the switch catalog (forge-anticipate.cjs): a word matches itself, its plurals and its -ing form (never
// -er/-ed: "platformer" is not a platform), never a shorter word ("tabel" is not in "databasetabel", "sheet" is not in
// "stylesheet"); 'w*' starts with; '-w' / 'w-'
// also as the end / start of a Dutch compound ("-contract" -> huurcontracten). Without the normaliser: whole words only.
const NZ = (() => { try { const m = require('./forge-text-normalize.cjs'); return m && typeof m.tokenize === 'function' ? m : null; } catch { return null; } })();
const words = (s) => (NZ ? NZ.tokenize(s).map((x) => x.raw) : String(s).toLowerCase().split(/[^a-z0-9À-ɏ']+/).filter(Boolean));
const lexOf = (text) => { const toks = words(String(text).slice(0, 20000)); return { toks, cands: toks.map((t) => (NZ ? NZ.candidates(t) : [t])) }; };
function parseWord(w) {
  let k = String(w).trim().toLowerCase(); const prefix = k.endsWith('*'); if (prefix) k = k.slice(0, -1);
  return { prefix, head: /^-[a-z]/.test(k), mod: /[a-z]-$/.test(k), raw: words(k) };
}
/** wordHit(L, word) -> does the tokenized text L (lexOf) name this selected_by word? */
function wordHit(L, w) {
  const m = parseWord(w);
  const has = (i, j) => {
    const tok = L.toks[i], r = m.raw[j];
    if (m.prefix && j === m.raw.length - 1) return tok.startsWith(r);
    if (L.cands[i].includes(r) || (NZ && tok.length > r.length && (tok === r + 's' || tok === r + 'es' || (tok.endsWith('ing') && NZ.englishForms(r).has(tok))))) return true;
    const pos = (m.head || m.mod) && NZ && m.raw.length === 1 ? NZ.compoundPosition(tok, r, L.cands[i]) : null;
    return (pos === 'head' && m.head) || (pos === 'modifier' && m.mod);
  };
  for (let i = 0; m.raw.length && i + m.raw.length <= L.toks.length; i++) if (m.raw.every((_, j) => has(i + j, j))) return true;
  return false;
}
function selectedByProblems(sb) {
  if (!isObj(sb) || Object.keys(sb).some((k) => k !== 'en' && k !== 'nl') || !['en', 'nl'].every((l) => Array.isArray(sb[l]) && sb[l].length && sb[l].every(isText))) return ['lens.selected_by must be {en: [...], nl: [...]}: two non-empty lists of request words'];
  const P = [];
  for (const w of sb.en.concat(sb.nl)) {
    const m = parseWord(w);
    if (!m.raw.length) P.push('lens.selected_by "' + w + '" holds no word');
    else if ((m.head || m.mod) && (m.raw.length !== 1 || (NZ && !NZ.compoundEligible(m.raw[0])))) P.push('lens.selected_by "' + w + '": a compound marker (-word / word-) needs one word of at least 5 letters');
  }
  return P;
}
// ---- I.9: selected_together: "app/platform/tool" + "people/users/klanten" + "can/kunnen/laten" in one sentence
const TOGETHER_GROUPS = [2, 4];
function togetherProblems(st) {
  const shape = 'lens.selected_together must be [{all: [{en, nl}, ...' + TOGETHER_GROUPS[0] + '..' + TOGETHER_GROUPS[1] + ' groups], unless?: {en, nl}}], 1..5 rules';
  if (!Array.isArray(st) || !st.length || st.length > 5) return [shape];
  const P = [];
  st.forEach((r, i) => {
    const w = 'lens.selected_together[' + i + ']';
    if (!isObj(r) || Object.keys(r).some((k) => k !== 'all' && k !== 'unless') || !Array.isArray(r.all) || r.all.length < TOGETHER_GROUPS[0] || r.all.length > TOGETHER_GROUPS[1]) { P.push(w + ': ' + shape); return; }
    r.all.forEach((g, j) => P.push(...selectedByProblems(g).map((p) => w + '.all[' + j + ']: ' + p)));
    if ('unless' in r) P.push(...selectedByProblems(r.unless).map((p) => w + '.unless: ' + p));
  });
  return P;
}
const groupWords = (g) => (isObj(g) ? arr(g.en).concat(arr(g.nl)).filter(isText) : []);
const sentences = (text) => String(text).slice(0, 20000).split(/[.!?;\r\n]+/).filter((s) => s.trim());
/** togetherHit(text, rules) -> the words of the first rule that one sentence fully names (one word per group), else null. */
function togetherHit(text, rules) {
  for (const s of sentences(text)) {
    const L = lexOf(s);
    for (const r of arr(rules)) {
      if (!isObj(r) || !Array.isArray(r.all) || groupWords(r.unless).some((w) => wordHit(L, w))) continue;
      const hit = r.all.map((g) => groupWords(g).find((w) => wordHit(L, w)));
      if (hit.length && hit.every(Boolean)) return hit;
    }
  }
  return null;
}
/** selectTypes(root, {domain, text}) -> {types, notices, selection[{type, from, words}]}: the lenses of a catalog domain,
 *  plus each lens whose selected_by words the request names, plus (a type the catalog does not know) the lenses its own
 *  name selects ("invoice-spreadsheet" names a spreadsheet) and generic as the safety net. Lens ORDER, generic last. */
function selectTypes(root, opts) {
  const domain = String((opts && opts.domain) || '').trim().toLowerCase(), cat = catalogDomains(root), known = !!(domain && cat && cat.includes(domain));
  const lenses = lensTypes(root).map((t) => loadLens(root, t)).filter((r) => r && r.lens);
  const sel = new Map(), add = (t, from, w) => { if (!sel.has(t)) sel.set(t, { type: t, from, words: w || [] }); };
  if (known) for (const r of lenses) if (arr(r.lens.domains).includes(domain)) add(r.lens.type, 'domain ' + domain);
  for (const [txt, from] of [[opts && opts.text, 'request'], [known ? '' : domain.replace(/-/g, ' '), 'type name']]) {
    if (!isText(txt)) continue;
    const L = lexOf(txt);
    for (const r of lenses) {
      const hit = [...new Set(groupWords(r.lens.selected_by).filter((w) => wordHit(L, w)))];
      if (hit.length) { add(r.lens.type, from, hit.slice(0, 3)); continue; }
      const both = from === 'request' ? togetherHit(txt, r.lens.selected_together) : null;
      if (both) add(r.lens.type, from, both);
    }
  }
  const extra = [...sel.values()].filter((s) => !s.from.startsWith('domain ')).map((s) => s.type + ' ("' + s.words.join('", "') + '")');
  const what = domain ? 'the domain "' + domain + '"' : 'this request', notices = [];
  if (!known || !sel.size) {
    add(FALLBACK, 'safety net');
    notices.push(extra.length ? 'no lens for ' + what + ': using the closest lenses by the deliverable words (' + extra.join(', ') + ') and the generic lens as the safety net. Derive the professional bar for this deliverable first (check bar-derived).' : fallbackNote(what));
  } else if (extra.length) notices.push('the request also names deliverables: ' + extra.join(', ') + '.');
  const types = lenses.map((r) => r.lens.type).filter((t) => sel.has(t));
  if (!types.length) types.push(FALLBACK); // no generic lens file: entriesFor reports it
  return { types, notices, selection: types.map((t) => sel.get(t) || { type: t, from: 'safety net', words: [] }) };
}

function sourceText(ch) {
  const c = ch.source || {};
  if (ch.provenance === 'professional_practice') return 'professional practice: ' + c.rationale;
  return 'cited (' + sourceKind(c) + '): ' + c.path + (c.rule_id ? ' rule ' + c.rule_id : ' § ' + c.section) + ' — "' + c.quote + '"';
}
function headerLines(e) {
  const L = [];
  for (const n of e.notices || []) L.push('NOTE: ' + n);
  if (!e.citations.ok) { L.push('STALE LENS ' + e.lens.type + ': ' + e.citations.problems.length + ' citation(s) no longer match their source; report this and judge those checks with care:'); for (const p of e.citations.problems) L.push('  - ' + p); }
  if (e.citations.unavailable.length) L.push('Not shipped here (provenance kept in the Forge development tree): ' + e.citations.unavailable.length + ' citation(s).');
  return L;
}
const plainCheck = (c) => ({ id: c.id, stakeholder: c.stakeholder, severity: c.severity, claim: c.claim, how_to_inspect: c.how_to_inspect, evidence_required: c.evidence_required, provenance: c.provenance, source: c.source });

/** renderLens(entry, {json}) -> the stakeholder checklist of one lens. entry = {lens, rel, sha256, citations, notices}. */
function renderLens(e, opts) {
  const lens = e.lens, n = counts(lens);
  if (opts && opts.json) {
    return JSON.stringify({ kind: 'forge-craft-lens', type: lens.type, version: lens.version, title: lens.title, covers: lens.covers, file: e.rel, sha256: e.sha256,
      notices: e.notices || [], citations: e.citations, question: QUESTION, rules: RULES, domains: lens.domains, stakeholders: lens.stakeholders,
      first_ten_seconds: lens.first_ten_seconds, checks: lens.checks.map(plainCheck), common_sloppy_defects: lens.common_sloppy_defects, ...(lens.guidance ? { guidance: lens.guidance } : {}), counts: n }, null, 2);
  }
  const L = ['Craft lens: ' + lens.type + ' (v' + lens.version + ') — ' + lens.title, 'Covers: ' + lens.covers, 'File: ' + e.rel + ' (sha256 ' + e.sha256.slice(0, 12) + ')'];
  L.push(...headerLines(e), '', QUESTION, 'This lens lists what to inspect; it marks nothing. Fill the form: node .claude/forge-bin/forge-craft.cjs review-template --type ' + lens.type, '');
  L.push('First ten seconds (do this first, cold, as the stakeholder):');
  for (const q of lens.first_ten_seconds) L.push('  - ' + q);
  if (lens.guidance && EV) L.push('', ...EV.guidanceLines(lens.guidance, lens.type));
  L.push('', 'Stakeholders:');
  for (const s of lens.stakeholders) L.push('  ' + s.id + ': ' + s.who, '    cares about:  ' + s.cares_about.join('; '), '    would notice: ' + s.would_notice.join('; '));
  L.push('', 'Checks (block: a professional would not hand this over; warn: fix it or state it):');
  for (const c of lens.checks) L.push('[ ] ' + c.id + '  (' + c.severity + ' · ' + c.stakeholder + ')', '    claim:    ' + c.claim, '    inspect:  ' + c.how_to_inspect, '    evidence: ' + c.evidence_required, '    source:   ' + sourceText(c));
  L.push('', 'Common sloppy defects (what a professional spots):');
  for (const d of lens.common_sloppy_defects) L.push('  - ' + d.defect + ': ' + d.symptom);
  L.push('', 'Counts: ' + n.checks + ' checks (' + n.block + ' block, ' + n.warn + ' warn) · provenance ' + n.cited + ' cited, ' + n.professional_practice + ' professional practice.');
  return L.join('\n');
}

/** renderPlan(entries, notices, {json}) -> the combined review plan for a mission. */
function renderPlan(entries, notices, opts) {
  const types = entries.map((e) => e.lens.type);
  const steps = ['Do the first-ten-seconds test of every lens, cold, as each stakeholder, before reading the checks.', 'Work the block checks and collect the evidence each one names.', 'Work the warn checks.',
    'Fill the review form (review-template) per stakeholder: what they notice in ten seconds and on closer inspection, then a mark with evidence per check.', 'Fix what you can, inspect again, and state plainly what stays weak.'];
  const next = 'node .claude/forge-bin/forge-craft.cjs review-template --deliverables "' + types.join(',') + '"';
  if (opts && opts.json) {
    return JSON.stringify({ kind: 'forge-craft-plan', deliverables: types, notices, selection: (opts && opts.selection) || types.map((t) => ({ type: t, from: 'named', words: [] })), question: QUESTION, rules: RULES, steps,
      lenses: entries.map((e) => ({ type: e.lens.type, version: e.lens.version, file: e.rel, sha256: e.sha256, citations: e.citations, counts: counts(e.lens),
        stakeholders: e.lens.stakeholders.map((s) => ({ id: s.id, who: s.who })), first_ten_seconds: e.lens.first_ten_seconds,
        block_checks: e.lens.checks.filter((c) => c.severity === 'block').map(plainCheck), warn_checks: e.lens.checks.filter((c) => c.severity === 'warn').map((c) => c.id), ...(e.lens.guidance ? { guidance: e.lens.guidance } : {}) })),
      next }, null, 2);
  }
  const L = ['Craft review plan: ' + types.join(' + ')];
  for (const n of notices) L.push('NOTE: ' + n);
  L.push(QUESTION + ' Sloppy output is a defect, not a style.', 'Steps:');
  steps.forEach((s, i) => L.push('  ' + (i + 1) + '. ' + s));
  for (const e of entries) {
    const n = counts(e.lens);
    L.push('', '== ' + e.lens.type + ' (v' + e.lens.version + ', ' + n.checks + ' checks: ' + n.block + ' block, ' + n.warn + ' warn) — ' + e.rel);
    L.push(...headerLines(Object.assign({}, e, { notices: [] })));
    L.push('Stakeholders: ' + e.lens.stakeholders.map((s) => s.id + ' (' + s.who + ')').join('; '), 'First ten seconds:');
    for (const q of e.lens.first_ten_seconds) L.push('  - ' + q);
    if (e.lens.guidance && EV) L.push(...EV.guidanceLines(e.lens.guidance, e.lens.type, { short: true }));
    L.push('Block checks (evidence to collect):');
    for (const c of e.lens.checks.filter((x) => x.severity === 'block')) L.push('  - ' + c.id + ' [' + c.stakeholder + ']: ' + c.claim, '      evidence: ' + c.evidence_required);
    L.push('Warn checks: ' + (e.lens.checks.filter((c) => c.severity === 'warn').map((c) => c.id).join(', ') || '(none)'));
  }
  L.push('', 'Next: ' + next);
  return L.join('\n');
}

/** renderTemplate(entries, notices, {json}) -> the self-critique form; every mark, finding and evidence is empty. */
function renderTemplate(entries, notices, opts) {
  const types = entries.map((e) => e.lens.type);
  const total = entries.reduce((a, e) => { const n = counts(e.lens); return { block: a.block + n.block, warn: a.warn + n.warn }; }, { block: 0, warn: 0 });
  if (opts && opts.json) {
    return JSON.stringify({ kind: 'forge-craft-review', version: 1, deliverables: types, notices, marks: MARKS, question: QUESTION, rules: RULES, deliverable: null, where: null, reviewer: null,
      lenses: entries.map((e) => ({ type: e.lens.type, version: e.lens.version, file: e.rel, sha256: e.sha256, citations_ok: e.citations.ok,
        first_ten_seconds: e.lens.first_ten_seconds.map((q) => ({ question: q, answer: null })),
        stakeholders: e.lens.stakeholders.map((s) => ({ id: s.id, who: s.who, notice_in_10_seconds: null, notice_on_closer_inspection: null,
          checks: e.lens.checks.filter((c) => c.stakeholder === s.id).map((c) => Object.assign({ id: c.id, severity: c.severity }, c.owner_data === true ? { owner_data: true } : {}, { claim: c.claim, how_to_inspect: c.how_to_inspect, evidence_required: c.evidence_required, mark: null, evidence: null, finding: null, fix_or_weakness: null })) })) })),
      stated_weaknesses: [], counts: { block_checks: total.block, warn_checks: total.warn } }, null, 2);
  }
  const L = ['# Craft review: ' + types.join(' + '), '', 'Deliverable: ________  Where (paths, URLs): ________  Reviewer (Boss): ________'];
  for (const n of notices) L.push('NOTE: ' + n);
  L.push('Marks: CLEAN (inspected, evidence attached, nothing a stakeholder would notice) · DEFECT · NOT_INSPECTED · N/A (give the reason) · WAITING_ON_OWNER (only on a check tagged "owner data": the evidence says how the placeholder is labelled to the visitor). This form marks nothing; the reviewer does, with evidence.');
  for (const r of RULES) L.push('- ' + r);
  for (const e of entries) {
    L.push('', '## ' + e.lens.type + ' (lens v' + e.lens.version + ', sha256 ' + e.sha256.slice(0, 12) + ')' + (e.citations.ok ? '' : ' (STALE LENS: see lens --type ' + e.lens.type + ')'), '', 'First ten seconds, cold:');
    for (const q of e.lens.first_ten_seconds) L.push('- ' + q + ' → ');
    for (const s of e.lens.stakeholders) {
      L.push('', '### Stakeholder ' + s.id + ': ' + s.who, 'Would notice in the first ten seconds: ', 'Would notice on closer inspection: ');
      for (const c of e.lens.checks.filter((x) => x.stakeholder === s.id)) {
        L.push('- [ ] ' + c.id + ' (' + c.severity + (c.owner_data === true ? ', owner data' : '') + '): ' + c.claim, '      inspect: ' + c.how_to_inspect, '      needs:   ' + c.evidence_required, '      mark: ____ · evidence: ____ · finding: ____ · fix or stated weakness: ____');
      }
    }
  }
  L.push('', '## Stated weaknesses (not fixed: what it is, who would notice, why not now)', '- ', '', '## Count',
    'Block checks: ' + total.block + ' · warn checks: ' + total.warn + ' · block marked DEFECT: __ · block marked NOT_INSPECTED: __ (either above 0 means not done)');
  return L.join('\n');
}

const USAGE = ['usage: node forge-craft.cjs lens --type <t> [--json] | lens --list [--json] | lens --schema',
  '       node forge-craft.cjs plan --deliverables "a,b" | --domain <d> [--text "<request>"] [--json]',
  '       node forge-craft.cjs review-template --type <t> | --deliverables "a,b" | --domain <d> [--text "<request>"] [--json]',
  '       node forge-craft.cjs record --run <run_id> --type <t> --file <filled review.json | -> [--json]',
  '       node forge-craft.cjs check --run <run_id> [--type <t>] [--json]',
  '       node forge-craft.cjs validate [--json]          (every command takes --root <projectRoot>)'].join('\n');

/** entriesFor(root, types, notices) -> {entries} | {error}: loads and validates each lens, verifies its citations. */
function entriesFor(root, types, notices) {
  const entries = [];
  for (const t of types) {
    const r = loadLens(root, t);
    if (!r) return { error: 'no lens file for "' + t + '" (' + lensRel(t) + ')' };
    if (r.error) return { error: r.error };
    if (!r.valid) return { error: r.rel + ' is invalid (fix the lens; nothing is listed):\n  - ' + r.problems.join('\n  - ') };
    entries.push({ lens: r.lens, rel: r.rel, sha256: r.sha256, citations: verifyLensCitations(r.lens, root), notices: types.length === 1 ? notices : [] });
  }
  return { entries };
}
/** validateAll(root) -> {ok, lenses[]}: every lens valid, citations ok, domains in the catalog, the fallback present. */
function validateAll(root) {
  const cat = catalogDomains(root), out = [];
  for (const type of lensTypes(root)) {
    const r = loadLens(root, type);
    if (!r || r.error) { out.push({ type, ok: false, problems: [r ? r.error : 'unreadable'], citations: null }); continue; }
    const problems = r.problems.slice();
    if (cat) for (const d of arr(r.lens.domains)) if (!cat.includes(d)) problems.push('domain "' + d + '" is not in domain-catalog.json');
    const cit = r.valid ? verifyLensCitations(r.lens, root) : null;
    if (cit && !cit.ok) problems.push(...cit.problems);
    out.push(Object.assign({ type, ok: problems.length === 0, problems, unavailable: cit ? cit.unavailable : [] }, counts(r.lens)));
  }
  const missingFallback = !out.some((x) => x.type === FALLBACK);
  return { ok: out.length > 0 && !missingFallback && out.every((x) => x.ok), fallback_present: !missingFallback, lenses: out };
}

// ---- record / check (I.6): a FILLED review becomes run evidence; the tool still marks nothing ----------
// `record` validates a review the reviewer filled (review-template --json) against the CURRENT lens and stores it as
// craft-review-<type>.json in the run folder (layout-aware: .forge/runs/<id> or .claude/forge-runs/<id>), then logs ONE
// agent_note through the project's own writer. `check` re-reads a stored record. forge-runcontract.cjs's rule
// craft-review-recorded calls checkRecorded(): it passes for a type only when the record is untampered, valid and holds
// no unresolved block DEFECT. Neither command ever sets a mark, fills a field or accepts an empty review.
const RECORD_KIND = 'forge-craft-record', RECORD_VERSION = 1, REVIEW_KIND = 'forge-craft-review';
const MIN_NOTE = 8; // evidence, findings and reasons: at least this many characters ("ok" or "x" says nothing)
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const RECORD_FILE_RE = /^craft-review-([a-z0-9][a-z0-9-]*)\.json$/;
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.layout === 'function' ? m : null; } catch { return null; } })();
const recordRel = (type) => 'craft-review-' + type + '.json';
const note = (v) => isText(v) && v.trim().length >= MIN_NOTE;
/** canon(v) — canonical JSON (sorted keys): the record hash never depends on key order. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
/** runDirFor(root, runId) -> the run folder in this project's layout (the .forge runs folder when the project opted in,
 *  else .claude/forge-runs; a run that only exists in the legacy folder stays there). Same rule as forge-plan-card. */
function runDirFor(root, runId) {
  const legacy = path.join(root, '.claude', 'forge-runs', runId);
  let active = legacy;
  try { if (forgePaths && forgePaths.layout(root) === 'forge') active = path.join(forgePaths.stateDir(root, 'runs'), runId); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; }
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}
/** fixOrWeakness(v) -> 'fix' | 'weakness' | null. A fix names what changed and how it was inspected again; an accepted
 *  weakness names what stays weak and why it is not fixed now. Anything else does not resolve a DEFECT. */
function fixOrWeakness(v) {
  if (!isObj(v)) return null;
  if (note(v.fix) && note(v.evidence)) return 'fix';
  if (note(v.weakness) && note(v.reason)) return 'weakness';
  return null;
}
/** markProblem(lensCheck, formCheck) -> null | the plain reason this one mark is not acceptable. */
function markProblem(ch, fc) {
  const id = ch.id + ' (' + ch.severity + ')', m = fc.mark;
  if (m === null || m === undefined || m === '') return id + ': no mark — an empty review is never accepted; mark CLEAN, DEFECT, NOT_INSPECTED or N/A';
  if (!MARKS.includes(m)) return id + ': mark "' + String(m).slice(0, 30) + '" is not one of ' + MARKS.join(', ');
  if (m === 'CLEAN' && !note(fc.evidence)) return id + ': CLEAN needs the evidence this check names (' + String(ch.evidence_required || '').slice(0, 90) + ')';
  if (m === 'WAITING_ON_OWNER' && !note(fc.evidence)) return id + ': WAITING_ON_OWNER needs evidence of how the placeholder is labelled to the visitor (write it in "evidence": the badge, banner or note a visitor sees)';
  if (m === 'N/A' && !note(fc.finding) && !note(fc.reason)) return id + ': N/A needs the reason it does not apply (write it in "finding")';
  if (m === 'NOT_INSPECTED' && ch.severity === 'block') return id + ': NOT_INSPECTED is not accepted on a block check — inspect it and mark CLEAN, DEFECT or N/A with a reason (an uninspected block check means not done)'; // CRAFT-RECORD-NOT-INSPECTED-BLOCK
  if (m === 'NOT_INSPECTED' && !note(fc.finding) && !note(fc.reason)) return id + ': NOT_INSPECTED needs the reason the evidence could not be produced (write it in "finding")';
  if (m === 'DEFECT' && !note(fc.finding)) return id + ': DEFECT needs a finding — what the stakeholder would notice';
  if (m === 'DEFECT' && !fixOrWeakness(fc.fix_or_weakness)) return id + ': DEFECT needs "fix_or_weakness": {"fix": "<what was changed>", "evidence": "<how it was inspected again>"} or {"weakness": "<what stays weak>", "reason": "<why it is not fixed now>"}';
  return null;
}
/** validateReview(form, {lens, sha256}) -> {ok, problems[], section} — the filled form against the lens: the right lens
 *  version, every first-ten-seconds answer, every stakeholder covered, every check of the lens present and marked
 *  acceptably (markProblem), and at least one block check really inspected. Total: never throws. */
function validateReview(form, entry) {
  const P = [], lens = entry && entry.lens, type = lens && lens.type;
  if (!isObj(lens)) return { ok: false, problems: ['no lens to judge the review against'], section: null };
  if (!isObj(form)) return { ok: false, problems: ['the review must be one JSON object: the filled output of review-template --type ' + type + ' --json'], section: null };
  if (form.kind !== REVIEW_KIND) P.push('kind must be "' + REVIEW_KIND + '": fill the form printed by review-template --type ' + type + ' --json');
  if (!isText(form.deliverable) || form.deliverable.trim().length < 3) P.push('deliverable is empty: name what was reviewed');
  const where = Array.isArray(form.where) ? form.where.filter(isText) : (isText(form.where) ? [form.where] : []);
  if (!where.length) P.push('where is empty: give the paths or URLs that were inspected');
  if (!isText(form.reviewer) || form.reviewer.trim().length < 3) P.push('reviewer is empty: name the Boss who reviewed it');
  const sections = arr(form.lenses).filter((l) => isObj(l) && l.type === type);
  if (sections.length !== 1) {
    P.push(sections.length ? 'the form holds the ' + type + ' lens more than once' : 'the form holds no ' + type + ' lens: print it with review-template --type ' + type + ' --json');
    return { ok: false, problems: P, section: null };
  }
  const s = sections[0];
  if (entry.sha256 && s.sha256 !== entry.sha256) P.push('the form was filled against another version of the ' + type + ' lens (form ' + String(s.sha256).slice(0, 12) + ', lens ' + String(entry.sha256).slice(0, 12) + '): print a fresh form and fill that');
  const f10 = arr(s.first_ten_seconds).filter(isObj);
  for (const q of arr(lens.first_ten_seconds)) {
    const a = f10.find((x) => x.question === q);
    if (!a || !note(a.answer)) P.push('first ten seconds: no answer to "' + String(q).slice(0, 70) + '" — write what you saw, cold, before reading the checks');
  }
  const formSt = new Map(arr(s.stakeholders).filter((x) => isObj(x) && isText(x.id)).map((x) => [x.id, x]));
  const lensIds = new Set(arr(lens.stakeholders).map((x) => x.id));
  for (const id of formSt.keys()) if (!lensIds.has(id)) P.push('stakeholder "' + id + '" is not in the ' + type + ' lens');
  let inspectedBlock = 0;
  for (const st of arr(lens.stakeholders)) {
    const got = formSt.get(st.id);
    if (!got) { P.push('stakeholder ' + st.id + ' (' + (st.who || st.id) + ') is missing: every stakeholder must be covered'); continue; }
    if (!note(got.notice_in_10_seconds)) P.push('stakeholder ' + st.id + ': write what they would notice in the first ten seconds');
    const own = arr(lens.checks).filter((ch) => ch.stakeholder === st.id);
    const formChecks = new Map(arr(got.checks).filter((x) => isObj(x) && isText(x.id)).map((x) => [x.id, x]));
    for (const id of formChecks.keys()) if (!own.some((ch) => ch.id === id)) P.push('check "' + id + '" is not a ' + st.id + ' check of the ' + type + ' lens');
    for (const ch of own) {
      const fc = formChecks.get(ch.id);
      if (!fc) { P.push('check ' + ch.id + ' (' + ch.severity + ', ' + st.id + ') is missing from the form'); continue; }
      const why = markProblem(ch, fc);
      if (why) P.push(why);
      else if (ch.severity === 'block' && (fc.mark === 'CLEAN' || fc.mark === 'DEFECT' || (fc.mark === 'WAITING_ON_OWNER' && ch.owner_data === true))) inspectedBlock++;
    }
  }
  if (!inspectedBlock && arr(lens.checks).some((ch) => ch.severity === 'block')) P.push('no block check was inspected (none is marked CLEAN or DEFECT): a review that inspected nothing is an empty review — inspect the block checks, or record an exception for this deliverable type instead'); // CRAFT-RECORD-EMPTY-GUARD
  return { ok: P.length === 0, problems: P, section: s }; // CRAFT-RECORD-VERDICT
}
/** summarizeReview(section, lens) -> counts per mark and the DEFECT ids by state, computed from the marks (never read
 *  from a stored summary). A block DEFECT is resolved only by a fix; an accepted weakness on it stays unresolved. */
function summarizeReview(section, lens) {
  const sev = new Map(arr(lens && lens.checks).map((c) => [c.id, c.severity]));
  const ownerData = new Set(arr(lens && lens.checks).filter((c) => c.owner_data === true).map((c) => c.id));
  const marks = { CLEAN: 0, DEFECT: 0, NOT_INSPECTED: 0, 'N/A': 0, WAITING_ON_OWNER: 0 };
  const out = { checks: 0, block: 0, warn: 0, marks, block_defects_fixed: [], block_defects_unresolved: [], warn_defects: [], not_inspected: [], waiting_on_owner: [], waiting_not_owner_data: [] };
  for (const st of arr(section && section.stakeholders)) {
    for (const fc of arr(st && st.checks)) {
      if (!isObj(fc) || !sev.has(fc.id)) continue;
      const s = sev.get(fc.id) === 'warn' ? 'warn' : 'block';
      out.checks++; out[s]++;
      if (MARKS.includes(fc.mark)) marks[fc.mark]++;
      if (fc.mark === 'NOT_INSPECTED') out.not_inspected.push(fc.id);
      // WAITING_ON_OWNER is accepted only where the LENS (never the form) flags the check as owner data
      if (fc.mark === 'WAITING_ON_OWNER' && ownerData.has(fc.id)) { out.waiting_on_owner.push({ id: fc.id, severity: s, evidence: String(fc.evidence).trim().slice(0, 300) }); continue; }
      if (fc.mark === 'WAITING_ON_OWNER') { out.waiting_not_owner_data.push(fc.id); (s === 'block' ? out.block_defects_unresolved : out.warn_defects).push(fc.id); continue; }
      if (fc.mark !== 'DEFECT') continue;
      if (s === 'block') (fixOrWeakness(fc.fix_or_weakness) === 'fix' ? out.block_defects_fixed : out.block_defects_unresolved).push(fc.id); // CRAFT-UNRESOLVED-BLOCK
      else out.warn_defects.push(fc.id);
    }
  }
  return out;
}
/** lensFromSection(type, review) -> a lens rebuilt from the RECORDED form (ids, stakeholders, severities, questions), used
 *  when the lens file changed after recording; an unknown severity is read as block (the strict direction). */
function lensFromSection(type, review, currentLens) {
  const s = arr(review && review.lenses).find((l) => isObj(l) && l.type === type);
  if (!s) return null;
  const sts = arr(s.stakeholders).filter((x) => isObj(x) && isText(x.id));
  // which checks are owner data comes from the CURRENT lens file, never from the recorded form (a form can be edited
  // before recording); no readable lens = no owner-data check, so a WAITING_ON_OWNER mark then counts as a DEFECT
  const ownerData = new Set(arr(currentLens && currentLens.checks).filter((c) => isObj(c) && c.owner_data === true).map((c) => c.id));
  return { type, first_ten_seconds: arr(s.first_ten_seconds).map((q) => q && q.question).filter(isText),
    stakeholders: sts.map((x) => ({ id: x.id, who: isText(x.who) ? x.who : x.id })),
    checks: sts.flatMap((x) => arr(x.checks).filter((c) => isObj(c) && isText(c.id)).map((c) => Object.assign({ id: c.id, stakeholder: x.id, severity: c.severity === 'warn' ? 'warn' : 'block', evidence_required: isText(c.evidence_required) ? c.evidence_required : 'the evidence the check names' }, ownerData.has(c.id) ? { owner_data: true } : {}))) };
}
function writeAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
/** logRecorded(...) -> null | a warning. ONE agent_note (narrative, not work) through the project's own writer, so the
 *  reviewer who records never becomes a "worker" in independent-verification. A logging failure never undoes the record. */
function logRecorded(root, runId, evidence, type, summary, reviewer) {
  const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  if (!fs.existsSync(le)) return 'log-event.cjs not found: the review is recorded, not logged';
  const text = 'craft review recorded: ' + type + ' · ' + summary.checks + ' checks (' + MARKS.map((m) => summary.marks[m] + ' ' + m).join(', ') + ') · '
    + summary.block_defects_unresolved.length + ' unresolved block DEFECT(s) · reviewer ' + String(reviewer).slice(0, 80);
  const r = require('child_process').spawnSync(process.execPath, [le, runId, 'agent_note', JSON.stringify({ agent: 'orchestrator', role: 'lead', note: text, evidence })], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? null : 'log-event warning (the review is recorded): ' + String(r.stderr || r.stdout || (r.error && r.error.message) || 'exit ' + r.status).trim().slice(0, 200);
}
/** recordReview({root, runId, type, form, log?}) -> {code, ok, problems?, file?, summary?, unresolved_block_defects?,
 *  warnings?}. code 0 = recorded · 3 = refused, nothing written · 2 = usage (no such lens / run / bad id). */
function recordReview(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot()), runId = opts.runId, type = opts.type;
  if (!RUN_ID_RE.test(String(runId || ''))) return { code: 2, ok: false, problems: ['--run id may only hold A-Z a-z 0-9 _ -'] };
  if (!isText(type) || !SLUG.test(type)) return { code: 2, ok: false, problems: ['--type must be a lens type such as web-ui'] };
  const L = loadLens(root, type);
  if (!L) return { code: 2, ok: false, problems: ['no lens for "' + type + '" (' + lensRel(type) + '): record against a real lens type (' + lensTypes(root).join(', ') + ')'] };
  if (L.error || !L.valid) return { code: 3, ok: false, problems: [L.error || (L.rel + ' is invalid: ' + L.problems.join('; '))] };
  let dir;
  try { dir = runDirFor(root, runId); } catch (e) { return { code: 2, ok: false, problems: ['the run folder could not be resolved (' + e.message + ')'] }; }
  const rel = path.relative(root, dir).split(path.sep).join('/');
  if (!fs.existsSync(dir)) return { code: 2, ok: false, problems: ['run folder ' + rel + ' does not exist: start the run first (nothing was written)'] };
  const v = validateReview(opts.form, { lens: L.lens, sha256: L.sha256 });
  if (!v.ok) return { code: 3, ok: false, type, problems: v.problems };
  const f = opts.form;
  const review = { kind: REVIEW_KIND, deliverable: f.deliverable.trim(), where: (Array.isArray(f.where) ? f.where : [f.where]).filter(isText).map((x) => x.trim()),
    reviewer: f.reviewer.trim(), stated_weaknesses: arr(f.stated_weaknesses), lenses: [v.section] };
  const summary = summarizeReview(v.section, L.lens);
  const record = { kind: RECORD_KIND, version: RECORD_VERSION, run_id: runId, type, lens: { type, version: L.lens.version, sha256: L.sha256, file: L.rel },
    review, summary, record_sha256: sha(canon(review)) };
  writeAtomic(path.join(dir, recordRel(type)), record);
  const warnings = summary.waiting_not_owner_data.map((id) => id + ' is marked WAITING_ON_OWNER but the ' + type + ' lens does not flag it as owner data: it counts as a DEFECT (fix it, or mark it DEFECT with a fix or weakness)');
  if (opts.log !== false) { const w = logRecorded(root, runId, rel + '/' + recordRel(type), type, summary, review.reviewer); if (w) warnings.push(w); }
  return { code: 0, ok: true, type, file: rel + '/' + recordRel(type), summary, unresolved_block_defects: summary.block_defects_unresolved.slice(), waiting_on_owner: summary.waiting_on_owner.slice(), warnings };
}
/** checkRecorded({root, runDir|runId, type}) -> {type, recorded, valid, unresolved_block_defects, problems, notes,
 *  summary?, file}. Read-only. Re-validates the stored form: its hash (edited after recording?), the run id, and the marks —
 *  against the current lens when it is still the recorded version, else against the recorded form (with a note). */
function checkRecorded(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || defaultRoot()), type = opts.type;
  const out = { type, recorded: false, valid: false, unresolved_block_defects: [], problems: [], notes: [], file: recordRel(type) };
  if (!isText(type) || !SLUG.test(type)) { out.problems.push('not a lens type: ' + JSON.stringify(type)); return out; }
  const dir = opts.runDir ? path.resolve(opts.runDir) : runDirFor(root, opts.runId);
  let raw;
  try { raw = fs.readFileSync(path.join(dir, recordRel(type)), 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return out; out.recorded = true; out.problems.push(recordRel(type) + ' could not be read (' + ((e && e.code) || 'unreadable') + ')'); return out; }
  out.recorded = true;
  let rec;
  try { rec = JSON.parse(raw.replace(/^﻿/, '')); } catch { out.problems.push(recordRel(type) + ' is not valid JSON'); return out; }
  if (!isObj(rec) || rec.kind !== RECORD_KIND || rec.version !== RECORD_VERSION) { out.problems.push(recordRel(type) + ' is not a forge-craft record (write it with forge-craft.cjs record)'); return out; }
  if (rec.type !== type) out.problems.push('it records type "' + String(rec.type).slice(0, 40) + '", not ' + type);
  if (opts.runId && rec.run_id !== opts.runId) out.problems.push('it belongs to run "' + String(rec.run_id).slice(0, 80) + '", not ' + opts.runId);
  if (!isObj(rec.review) || rec.record_sha256 !== sha(canon(rec.review))) { out.problems.push('it was edited after it was recorded (record_sha256 no longer matches its review) — record the review again with forge-craft.cjs record'); return out; }
  const recLens = isObj(rec.lens) ? rec.lens : {};
  const L = loadLens(root, type);
  let entry;
  if (L && !L.error && L.valid && L.sha256 === recLens.sha256) entry = { lens: L.lens, sha256: L.sha256 };
  else {
    entry = { lens: lensFromSection(type, rec.review, L && !L.error ? L.lens : null), sha256: isText(recLens.sha256) ? recLens.sha256 : null };
    out.notes.push(L && L.sha256 ? 'the ' + type + ' lens changed since this review was recorded (recorded under ' + String(recLens.sha256).slice(0, 12) + ', now ' + L.sha256.slice(0, 12) + '); judged against the recorded form' : 'the ' + type + ' lens is not readable here; judged against the recorded form');
  }
  if (!entry.lens) { out.problems.push('the recorded form holds no ' + type + ' lens section'); return out; }
  const v = validateReview(rec.review, entry);
  out.problems.push(...v.problems);
  out.summary = summarizeReview(v.section, entry.lens);
  out.unresolved_block_defects = out.summary.block_defects_unresolved.slice();
  out.waiting_on_owner = out.summary.waiting_on_owner.slice();
  out.reviewer = isText(rec.review.reviewer) ? rec.review.reviewer.trim().slice(0, 80) : null;
  out.valid = out.problems.length === 0;
  return out;
}
/** recordedTypes(dir) -> the types with a craft-review-<type>.json in the run folder. */
function recordedTypes(dir) {
  try { return fs.readdirSync(dir).map((n) => RECORD_FILE_RE.exec(n)).filter(Boolean).map((m) => m[1]).sort(); } catch { return []; }
}
function summaryLine(s) {
  return s.checks + ' checks (' + MARKS.map((m) => (s.marks[m] || 0) + ' ' + m).join(', ') + ')' + (s.block_defects_fixed.length ? ' · block DEFECT fixed: ' + s.block_defects_fixed.join(', ') : '') + (s.warn_defects.length ? ' · warn DEFECT: ' + s.warn_defects.join(', ') : '')
    + (arr(s.waiting_on_owner).length ? ' · waiting on the owner (visible exception): ' + s.waiting_on_owner.map((w) => w.id).join(', ') : '');
}

/** main(argv, io) -> exit code. io = {out, err, root} (all optional) so tests can run it in-process. */
function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const err = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const [cmd, ...rest] = argv;
  const has = (f) => rest.includes(f);
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined; };
  const root = val('--root') ? path.resolve(val('--root')) : ((io && io.root) || defaultRoot());
  const json = has('--json');
  if (cmd === 'help' || cmd === '--help') { out(USAGE); return 0; }
  if (cmd === 'validate') {
    const v = validateAll(root);
    if (json) out(JSON.stringify(v, null, 2));
    else {
      out('Craft lenses (' + v.lenses.length + '): ' + (v.ok ? 'all valid, citations found' : 'PROBLEMS FOUND') + (v.fallback_present ? '' : ' · the generic fallback lens is missing'));
      for (const l of v.lenses) {
        out('  ' + l.type.padEnd(27) + ' ' + l.checks + ' checks (' + l.block + ' block, ' + l.warn + ' warn; ' + l.cited + ' cited, ' + l.professional_practice + ' professional practice)' + (l.ok ? '' : '  INVALID'));
        for (const p of l.problems) out('      - ' + p);
        if (l.unavailable && l.unavailable.length) out('      (' + l.unavailable.length + ' citation(s) point at development-tree docs not shipped here)');
      }
    }
    return v.ok ? 0 : 3;
  }
  if (cmd === 'record') {
    const run = val('--run'), type = val('--type'), file = val('--file');
    if (!run || !type || !file) { err(USAGE); return 2; }
    let form;
    try { form = JSON.parse((file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8')).replace(/^﻿/, '')); }
    catch (e) { err('forge-craft: cannot read the filled review (' + file + '): ' + e.message); return 2; }
    const r = recordReview({ root, runId: run, type: type.trim().toLowerCase(), form });
    if (json) out(JSON.stringify(r, null, 2));
    else if (r.code === 0) {
      out('Craft review recorded: ' + r.type + ' for run ' + run + ' -> ' + r.file);
      out('  ' + summaryLine(r.summary));
      out(r.unresolved_block_defects.length
        ? '  Unresolved block DEFECT: ' + r.unresolved_block_defects.join(', ') + ' — the run is not done for ' + r.type + ' until each is fixed (fix + evidence) and the review is recorded again.'
        : '  Unresolved block DEFECT: none — the run contract can count this review for ' + r.type + '.');
      for (const w of r.warnings) err('forge-craft: warning: ' + w);
    } else {
      err('Craft review NOT recorded (nothing was written)' + (r.problems.length > 1 ? ' — ' + r.problems.length + ' problems:' : ':'));
      for (const p of r.problems) err('  - ' + p);
    }
    return r.code;
  }
  if (cmd === 'check') {
    const run = val('--run'), only = val('--type');
    if (!run || !RUN_ID_RE.test(run)) { err(USAGE); return 2; }
    let dir;
    try { dir = runDirFor(root, run); } catch (e) { err('forge-craft: the run folder could not be resolved (' + e.message + ')'); return 2; }
    const types = only ? [only.trim().toLowerCase()] : recordedTypes(dir);
    const reviews = types.map((t) => checkRecorded({ root, runDir: dir, runId: run, type: t }));
    const done = reviews.length > 0 && reviews.every((x) => x.recorded && x.valid && !x.unresolved_block_defects.length);
    if (json) out(JSON.stringify({ run_id: run, folder: path.relative(root, dir).split(path.sep).join('/'), done, reviews }, null, 2));
    else {
      if (!reviews.length) out('No craft review recorded for run ' + run + '.');
      for (const x of reviews) {
        out(x.type + ': ' + (!x.recorded ? 'not recorded' : !x.valid ? 'NOT VALID — ' + x.problems.slice(0, 3).join('; ') : x.unresolved_block_defects.length ? 'recorded, ' + x.unresolved_block_defects.length + ' unresolved block DEFECT(s): ' + x.unresolved_block_defects.join(', ') : 'recorded, no unresolved block DEFECT · ' + summaryLine(x.summary)));
        for (const n of x.notes) out('  note: ' + n);
      }
    }
    return done ? 0 : 3;
  }
  if (cmd === 'lens' && has('--schema')) { out(JSON.stringify(LENS_SCHEMA, null, 2)); return 0; }
  if (cmd === 'lens' && has('--list')) {
    const ls = listLenses(root);
    if (json) out(JSON.stringify({ lenses: ls }, null, 2));
    else { out('Craft lenses (' + ls.length + '):'); for (const l of ls) out('  ' + l.type.padEnd(27) + ' ' + l.checks + ' checks (' + l.block + ' block, ' + l.warn + ' warn), ' + l.stakeholders + ' stakeholders' + (l.valid ? '' : '  INVALID: ' + l.problems.join('; '))); }
    return 0;
  }
  let sel = null;
  const type = val('--type'), deliv = val('--deliverables'), domain = val('--domain'), text = val('--text');
  if (cmd === 'lens' && type) sel = resolveTypes(root, parseList(type).slice(0, 1));
  else if ((cmd === 'plan' || cmd === 'review-template') && (type || deliv)) sel = resolveTypes(root, parseList(deliv || type));
  else if ((cmd === 'plan' || cmd === 'review-template') && (domain || text)) {
    const d = domain ? domain.trim().toLowerCase() : '', cat = catalogDomains(root);
    sel = selectTypes(root, { domain: d, text });
    if (d && cat && !cat.includes(d)) sel.notices.unshift('"' + d + '" is not a domain in domain-catalog.json.');
  }
  if (!sel || !sel.types.length) { err(USAGE); return 2; }
  const r = entriesFor(root, sel.types, sel.notices);
  if (r.error) { err(r.error); return 3; }
  if (cmd === 'lens') out(renderLens(r.entries[0], { json }));
  else if (cmd === 'plan') out(renderPlan(r.entries, sel.notices, { json, selection: sel.selection }));
  else out(renderTemplate(r.entries, sel.notices, { json }));
  return 0;
}

module.exports = {
  LENS_SCHEMA, MARKS, SEVERITIES, PROVENANCE, FALLBACK, ORDER, RULES,
  validateLens, verifyLensCitations, mdSection, normCite, sourceKind, loadLens, lensTypes, listLenses,
  resolveTypes, typesForDomain, selectTypes, wordHit, lexOf, selectedByProblems, togetherProblems, togetherHit, validateAll, renderLens, renderPlan, renderTemplate, main,
  // I.6: a filled review becomes run evidence (forge-runcontract craft-review-recorded reads checkRecorded)
  RECORD_KIND, RECORD_VERSION, REVIEW_KIND, MIN_NOTE, validateReview, markProblem, fixOrWeakness, summarizeReview,
  recordReview, checkRecorded, recordedTypes, runDirFor, lensFromSection,
};

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-craft: internal error: ' + (e && e.stack || e) + '\n'); process.exitCode = 1; }
}
