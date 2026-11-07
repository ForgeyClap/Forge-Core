#!/usr/bin/env node
'use strict';
/**
 * forge-plan-card.cjs — the PLAN CARD of Forge's think-with-the-user intake (modernization WP 3.2).
 * Zero-dependency and deterministic: no clock, no randomness, no network, no LLM. After the silent intake (goal ->
 * real intent -> assumptions -> at most ONE owner question) the Lead writes a mission JSON; this tool turns it into
 * ONE Markdown card plus a machine verdict, so the owner sees the plan once and work stops only for a real blocker.
 * Full contract (mission JSON v1, gate items, verdict table, approval record): .claude/skills/forge-intake/references/plan-card.md
 *   Optional key `switches` (forge-anticipate plan --json, WP I.2): announcement + waits_for_owner labels on the card, in its hash.
 * - Gate items REUSE forge-actiongate.cjs classify() (never re-implemented) on every declared gate, the mission goal,
 *   every package goal and every owns[] path (write-outside-root; a leading ~ is expanded first). A declared gate
 *   always counts, also when the classifier misses its words (fail-closed); an undeclared hit counts too.
 * - plan-approval (forge-config; --mode overrides it for one run): auto never stops; gated (default) stops only the
 *   packages holding an open gate item plus their dependents; always waits until the owner approved THIS card.
 *   Approving a card never unlocks a gate; approved scope (card hash + gate keys) is never asked again.
 * CLI:
 *   node forge-plan-card.cjs [render] --file <mission.json|-> [--mode auto|gated|always] [--lang en|nl]
 *        [--root <projectRoot>] [--request "<raw owner request>"] [--json] [--run <run_id>]
 *   node forge-plan-card.cjs question --domain <slug> [--trigger F<1-13>] [--lang en|nl] [--bank <file>] [--json]
 *   node forge-plan-card.cjs validate-bank [--bank <file>] [--json]
 *   --request merges forge-promptcheck's assumptions (and its ONE question when the mission has none). --run writes
 *   .claude/forge-runs/<run_id>/plan-card.{md,json} (the run folder must exist) and logs ONE agent_note via
 *   forge-dashboard/log-event.cjs; a logging failure is a warning, never fatal.
 * Exit: render 0 = no approval needed · 3 = approval needed · 2 = usage or invalid mission · 1 = internal error.
 *   question 0 (one question, or an honest null). validate-bank 0 valid, 3 invalid. Both: 2 usage, 1 unreadable bank.
 * FORGE_PROJECT_ROOT overrides the project root (config, isolation check, run folder, default bank).
 * Module API: { normalizeMission, collectGateItems, decide, planLanes, renderCard, buildCard, cardHash, resolveMode,
 *   validateBank, bankQuestions, pickQuestion, main, MODES, DEFAULT_MODE, MAX_OWNER_QUESTIONS }
 */
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');
const actiongate = require('./forge-actiongate.cjs');

const MODES = ['auto', 'gated', 'always'], DEFAULT_MODE = 'gated', WORKER_ROUTES = ['quick', 'build', 'deep'], ROUTE_FALLBACK = { quick: 'sonnet · low', build: 'opus · medium', deep: 'opus · xhigh' };
const MAX_OWNER_QUESTIONS = 1; // forge-intake THE QUESTION POLICY: one owner question per mission, pinned in code
const MISSION_KEYS = ['goal', 'intent', 'domain', 'assumptions', 'question', 'questions', 'packages', 'risks', 'wont_do', 'gates', 'proof', 'approval', 'switches'];
const PACKAGE_KEYS = ['id', 'goal', 'owns', 'route', 'deps', 'owner'], GATE_KEYS = ['text', 'wp', 'id', 'command', 'path'];
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })(), scriptProjectRoot = () => (process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : (forgePaths ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..'))), projectRootDefault = () => scriptProjectRoot() || path.resolve(__dirname, '..', '..'), runDirOf = (root, id) => { const legacy = path.join(root, '.claude', 'forge-runs', id); let active = legacy; try { if (forgePaths && forgePaths.layout(root) === 'forge') active = path.join(forgePaths.stateDir(root, 'runs'), id); } catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; } return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active; }; // WP 2.1 (guarded forge-paths): an installed copy keeps its own project, a plugin copy discovers it (null = none: config reads keep the old default, saving a card only warns); runDirOf = WP 2.1: the run's folder in this project's layout (legacy run kept where it is)

// ---- small pure helpers ----
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v), clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex'), esc = (s) => String(s).replace(/\|/g, '\\|');
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]), expandHome = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
/** bi(v) -> {nl, en} | null — a plain string counts for both languages. */
function bi(v) {
  if (typeof v === 'string') { const s = clean(v); return s ? { nl: s, en: s } : null; }
  if (isObj(v)) { const nl = clean(v.nl), en = clean(v.en); if (nl || en) return { nl: nl || en, en: en || nl }; }
  return null;
}
/** canon(v) — canonical JSON (sorted keys), so the key order of a mission never changes its hash. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function strList(raw, key, problems, min) {
  if (!Array.isArray(raw)) { problems.push(key + ' must be an array'); return []; }
  const out = [];
  raw.forEach((v, i) => { const s = clean(typeof v === 'number' ? String(v) : v); if (s) out.push(s); else problems.push(key + '[' + i + '] must be a non-empty string'); });
  if (out.length < min) problems.push(key + ' needs at least ' + min + ' entry');
  return out;
}
const warnUnknown = (obj, known, at, warnings) => { for (const k of Object.keys(obj)) if (!known.includes(k)) warnings.push(at + 'unknown key "' + k + '" (not used on the card)'); };

// ---- mission validation ----
function normQuestion(q, problems) {
  if (q == null) return null;
  if (!isObj(q)) { problems.push('question must be an object or null'); return null; }
  const text = bi(q.text), def = bi(q.default), choices = Array.isArray(q.choices) ? q.choices.map(bi) : [];
  const rec = q.recommended === undefined ? 0 : q.recommended;
  if (!text) problems.push('question.text is required');
  if (choices.length < 2 || choices.length > 4 || choices.some((c) => !c)) problems.push('question.choices needs 2-4 non-empty choices (2-3 outcomes + "something else")');
  if (!def) problems.push('question.default is required: the answer Forge uses when the owner does not answer');
  if (!(rec === null || (Number.isInteger(rec) && rec >= 0 && rec < choices.length))) problems.push('question.recommended must be null or the index of a choice');
  return { id: clean(q.id) || null, text, choices, recommended: rec, default: def, answer: clean(q.answer) || null, source: clean(q.source) || 'mission' };
}
function findCycle(packages) { // depth-first: 1 = on the current path, 2 = done
  const byId = Object.fromEntries(packages.map((p) => [p.id, p])), state = {};
  const visit = (id, trail) => {
    if (state[id]) return state[id] === 1 ? trail.slice(trail.indexOf(id)).concat(id) : null;
    state[id] = 1;
    for (const d of byId[id].deps) { const c = visit(d, trail.concat(id)); if (c) return c; }
    state[id] = 2; return null;
  };
  for (const p of packages) { const c = visit(p.id, []); if (c) return c; }
  return null;
}
function normPackages(raw, problems, warnings) {
  const packages = [];
  if (!Array.isArray(raw) || !raw.length) { problems.push('packages needs at least one work package'); return packages; }
  raw.forEach((p, i) => {
    const at = 'packages[' + i + ']';
    if (!isObj(p)) { problems.push(at + ' must be an object'); return; }
    warnUnknown(p, PACKAGE_KEYS, at + ': ', warnings);
    const id = clean(typeof p.id === 'number' ? String(p.id) : p.id), goal = clean(p.goal), route = clean(p.route);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) problems.push(at + '.id must be a short id (letters, digits, . _ -)');
    else if (packages.some((x) => x.id === id)) problems.push(at + '.id "' + id + '" is used twice');
    if (!goal) problems.push(at + '.goal is required');
    if (route === 'escalate') problems.push(at + '.route escalate is never chosen up front (GOAT: only after a failed check)');
    else if (!WORKER_ROUTES.includes(route)) problems.push(at + '.route must be quick, build or deep');
    const owns = strList(p.owns, at + '.owns', problems, 0), deps = p.deps === undefined ? [] : strList(p.deps, at + '.deps', problems, 0);
    packages.push({ id, goal, owner: clean(p.owner) || null, route, owns, deps });
  });
  const ids = new Set(packages.map((p) => p.id));
  for (const p of packages) for (const d of p.deps) {
    if (d === p.id) problems.push('package ' + p.id + ' depends on itself');
    else if (!ids.has(d)) problems.push('package ' + p.id + ' depends on unknown package "' + d + '"');
  }
  if (!problems.length) { const cycle = findCycle(packages); if (cycle) problems.push('dependency cycle: ' + cycle.join(' -> ')); }
  return packages;
}
function normGates(raw, ids, problems, warnings) {
  const known = new Set(actiongate.KNOWN_GATES);
  if (!Array.isArray(raw)) { problems.push('gates must be an array (may be empty)'); return []; }
  return raw.map((g, i) => {
    const at = 'gates[' + i + ']', o = typeof g === 'string' ? { text: g } : g;
    if (!isObj(o)) { problems.push(at + ' must be a string or an object'); return null; }
    warnUnknown(o, GATE_KEYS, at + ': ', warnings);
    const text = clean(o.text), wp = o.wp == null ? null : clean(String(o.wp)), id = clean(o.id) || null;
    if (!text) problems.push(at + '.text is required');
    if (wp !== null && !ids.has(wp)) problems.push(at + '.wp "' + wp + '" is not a package id');
    if (id && !known.has(id)) problems.push(at + '.id "' + id + '" is not a forge-actiongate gate id (' + [...known].join(', ') + ')');
    return { text, wp, id, command: clean(o.command) || null, path: clean(o.path) || null };
  }).filter(Boolean);
}
/** normalizeMission(raw) -> { mission|null, problems[], warnings[] } — pure; never mutates `raw`. */
function normalizeMission(raw) {
  const problems = [], warnings = [];
  if (!isObj(raw)) return { mission: null, problems: ['the mission must be one JSON object'], warnings };
  warnUnknown(raw, MISSION_KEYS, 'mission: ', warnings);
  if (raw.switches != null && !isObj(raw.switches)) warnings.push('switches must be the object of forge-anticipate plan --json (`switches`); ignored, not on the card');
  const goal = clean(raw.goal);
  if (!goal) problems.push('goal is required');
  const assumptions = [];
  if (!Array.isArray(raw.assumptions)) problems.push('assumptions must be an array (may be empty)');
  else raw.assumptions.forEach((a, i) => {
    const text = typeof a === 'string' ? bi(a) : isObj(a) ? bi(a.text !== undefined ? a.text : a) : null;
    if (text) assumptions.push({ id: isObj(a) ? clean(a.id) || null : null, text }); else problems.push('assumptions[' + i + '] needs a text');
  });
  let question = null;
  if (raw.questions !== undefined && raw.question != null) problems.push('give "question" or "questions", not both');
  else if (raw.questions === undefined) question = normQuestion(raw.question, problems);
  else if (!Array.isArray(raw.questions)) problems.push('questions must be an array');
  else if (raw.questions.length > MAX_OWNER_QUESTIONS) problems.push('ONE-question cap: ' + raw.questions.length + ' owner questions given; Forge asks at most ' + MAX_OWNER_QUESTIONS + ' per mission (forge-intake THE QUESTION POLICY). Decide the rest and record them as assumptions');
  else question = normQuestion(raw.questions[0], problems);
  const packages = normPackages(raw.packages, problems, warnings);
  const gates = normGates(raw.gates, new Set(packages.map((p) => p.id)), problems, warnings);
  let approval = { card: null, gates: [] };
  if (raw.approval != null) {
    if (!isObj(raw.approval) || (raw.approval.gates !== undefined && !Array.isArray(raw.approval.gates))) problems.push('approval must be {card?: <hash>, gates?: [<gate key>]}');
    else approval = { card: clean(raw.approval.card) || null, gates: (raw.approval.gates || []).map(clean).filter(Boolean) };
  }
  const mission = { goal, intent: clean(raw.intent) || null, domain: clean(raw.domain) || null, assumptions, question, packages,
    risks: strList(raw.risks, 'risks', problems, 0), wont_do: strList(raw.wont_do, 'wont_do', problems, 1), gates,
    proof: strList(raw.proof, 'proof', problems, 1), approval, switches: isObj(raw.switches) ? raw.switches : null };
  return { mission: problems.length ? null : mission, problems, warnings };
}
/** cardHash(mission) -> sha256 of the canonical content minus the owner's approval; no switches = the pre-switches hash. */
function cardHash(mission) { const { approval, ...content } = mission; if (content.switches == null) delete content.switches; return sha(canon(content)); }

// ---- hard-gate items (forge-actiongate is the single source of truth) ----
function classifyGate(input, root) {
  return actiongate.classify(input, { projectRoot: root }); // PLAN-CARD-CLASSIFIER-CALL (the mutation test stubs this line)
}
/** collectGateItems(mission, root) -> [{key, gate, class, source, declared, recognized, wp, text, matched}] */
function collectGateItems(mission, root) {
  const classes = Object.fromEntries(actiongate.listGates().map((g) => [g.id, g.class]));
  const items = [];
  for (const g of mission.gates) {
    const r = classifyGate({ text: g.text, command: g.command || undefined, path: g.path ? expandHome(g.path) : undefined }, root);
    items.push({ source: 'declared', declared: true, wp: g.wp, text: g.text, gate: g.id || (r.gate ? r.id : null),
      class: g.id ? classes[g.id] || null : r.class, recognized: !!g.id || r.gate, matched: r.matched });
  }
  const covered = (gate, wp) => items.some((it) => it.declared && it.gate === gate && it.wp === wp);
  const found = (source, wp, text, r) => {
    if (r.gate && !covered(r.id, wp)) items.push({ source, declared: false, wp, text, gate: r.id, class: r.class, recognized: true, matched: r.matched });
  };
  found('goal', null, mission.goal, classifyGate({ text: mission.goal }, root));
  for (const p of mission.packages) {
    found('package-goal', p.id, p.goal, classifyGate({ text: p.goal }, root));
    for (const o of p.owns) found('owns-path', p.id, o, classifyGate({ text: '', path: expandHome(o) }, root));
  }
  const seen = {};
  for (const it of items) {
    const base = (it.gate || 'owner-gate') + '@' + (it.wp || 'mission') + ':' + sha(it.text.toLowerCase()).slice(0, 8);
    seen[base] = (seen[base] || 0) + 1;
    it.key = seen[base] > 1 ? base + '#' + seen[base] : base;
  }
  return items;
}
/** dependents(packages, seeds) -> the seed packages plus every package that (transitively) depends on one. */
function dependents(packages, seeds) {
  const out = new Set(seeds);
  for (let grew = true; grew;) { grew = false; for (const p of packages) if (!out.has(p.id) && p.deps.some((d) => out.has(d))) { out.add(p.id); grew = true; } }
  return packages.map((p) => p.id).filter((id) => out.has(id));
}
/** decide(mission, items, mode, hash) -> { needsApproval, stop, blocked[], ready[], reasons[], questionDue, cardApproved, open[] } */
function decide(mission, items, mode, hash) {
  const ap = mission.approval, all = mission.packages.map((p) => p.id), reasons = [];
  const cardApproved = !!ap.card && ap.card.length >= 12 && hash.startsWith(ap.card.toLowerCase());
  const open = cardApproved ? [] : items.filter((it) => !ap.gates.includes(it.key));
  let needsApproval = false, stop = 'none', blocked = [];
  if (mode === 'auto') {
    reasons.push('plan-approval auto: the card is rendered and logged; work never waits for plan approval');
    if (items.length) reasons.push(items.length + ' hard-gate item(s) on the card still stop at the action itself (gate hook / forge-actiongate), never through this card');
  } else if (cardApproved) reasons.push('the owner approved this card (' + hash.slice(0, 12) + '); approved scope is never asked again');
  else if (mode === 'always') {
    needsApproval = true; stop = 'all'; blocked = all;
    reasons.push('plan-approval always: every plan waits for the owner\'s OK' + (ap.card ? ' (the card changed since the approved card ' + ap.card.slice(0, 12) + ')' : ''));
  } else if (open.length) {
    needsApproval = true;
    stop = open.some((it) => !it.wp) ? 'all' : 'gated-packages';
    blocked = stop === 'all' ? all : dependents(mission.packages, open.map((it) => it.wp));
    for (const it of open) {
      const how = !it.declared ? 'not declared; found by the classifier in the ' + it.source.replace('-', ' ') : it.recognized ? 'declared' : 'declared; the classifier does not recognise these words, kept as an owner gate (fail-closed)';
      reasons.push('hard-gate item ' + (it.gate || 'owner-gate') + ' (' + (it.wp ? 'WP ' + it.wp : 'mission') + ', ' + how + '): ' + it.text);
    }
    if (stop === 'all') reasons.push('a gate item without a work package blocks every package: link it with "wp" so the rest can run');
  } else reasons.push(items.length ? 'every hard-gate item on the card was already approved by the owner; approved scope is never asked again' : 'no hard-gate item on the card: work continues without waiting (plan-approval gated)');
  const q = mission.question;
  if (q && !q.answer) reasons.push('one owner question is open (asked once, together with the card): ' + q.text.en + ' (default if unanswered: ' + q.default.en + ')');
  return { needsApproval, stop, blocked, ready: all.filter((id) => !blocked.includes(id)), reasons, questionDue: !!(q && !q.answer), cardApproved, open: open.map((it) => it.key) };
}

// ---- expected lanes: dependency waves, one writer per file ----
const ownsKey = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/\*\*$|\/\*$|\/$/, '').toLowerCase();
function overlap(a, b) {
  for (const x of a) for (const y of b) {
    const kx = ownsKey(x), ky = ownsKey(y), gx = kx.search(/[*?{[]/), gy = ky.search(/[*?{[]/);
    const px = gx === -1 ? kx : kx.slice(0, gx), py = gy === -1 ? ky : ky.slice(0, gy);
    if (kx === ky || kx.startsWith(ky + '/') || ky.startsWith(kx + '/') || (gx !== -1 && py.startsWith(px)) || (gy !== -1 && px.startsWith(py))) return x === y ? x : x + ' / ' + y;
  }
  return null;
}
/** planLanes(packages) -> { waves:[[ids]], lanes:[n per wave], expected, collisions:[{a, b, path}], waveOf } */
function planLanes(packages) {
  const byId = Object.fromEntries(packages.map((p) => [p.id, p])), waveOf = {}, waves = [], collisions = [];
  const w = (id) => waveOf[id] || (waveOf[id] = 1 + Math.max(0, ...byId[id].deps.map(w)));
  packages.forEach((p) => w(p.id));
  for (let n = 1; n <= Math.max(...Object.values(waveOf)); n++) waves.push(packages.filter((p) => waveOf[p.id] === n).map((p) => p.id));
  const lanes = waves.map((ids) => { // colliding packages share one lane (union-find), so they run one after the other
    const parent = Object.fromEntries(ids.map((id) => [id, id]));
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const shared = overlap(byId[ids[i]].owns, byId[ids[j]].owns);
      if (shared) { collisions.push({ a: ids[i], b: ids[j], path: shared }); parent[find(ids[j])] = find(ids[i]); }
    }
    return new Set(ids.map(find)).size;
  });
  return { waves, lanes, expected: Math.max(...lanes), collisions, waveOf };
}

// ---- mode, routes, request merge ----
/** resolveMode(flag, root) -> { mode, source: 'flag'|<forge-config source>, warnings[] } — never throws. */
function resolveMode(flag, root) {
  if (flag) return MODES.includes(flag) ? { mode: flag, source: 'flag', warnings: [] } : { mode: DEFAULT_MODE, source: 'default', warnings: ['mode ' + JSON.stringify(flag) + ' is not auto/gated/always; using gated'] };
  try {
    const r = require('./forge-config.cjs').safeGet('plan-approval', { projectRoot: root, fallback: DEFAULT_MODE });
    const warnings = r.degraded ? ['plan-approval could not be read (' + r.reason + '); using ' + JSON.stringify(r.value)] : [];
    if (!MODES.includes(r.value)) return { mode: DEFAULT_MODE, source: 'default', warnings: warnings.concat('plan-approval ' + JSON.stringify(r.value) + ' is not auto/gated/always; using gated') };
    return { mode: r.value, source: r.degraded ? 'default' : r.source, warnings };
  } catch (e) { return { mode: DEFAULT_MODE, source: 'default', warnings: ['forge-config is unavailable (' + e.message + '); using the default gated'] }; }
}
function readRoutes() {
  try {
    const routes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'FORGE_MODEL_ROUTING.json'), 'utf8')).routes;
    return { map: Object.fromEntries(WORKER_ROUTES.map((r) => [r, routes[r].model + ' · ' + routes[r].effort])), warnings: [] };
  } catch (e) { return { map: ROUTE_FALLBACK, warnings: ['FORGE_MODEL_ROUTING.json is unreadable (' + e.message + '); route models come from the built-in GOAT table'] }; }
}
/** mergeRequest(raw, request) -> { raw: a copy with forge-promptcheck's assumptions (+ its ONE question), problems, warnings } */
function mergeRequest(raw, request) {
  if (!clean(request)) return { raw, problems: ['--request is empty'], warnings: [] };
  if (!isObj(raw)) return { raw, problems: [], warnings: [] };
  const pc = require('./forge-promptcheck.cjs');
  const pi = pc.planInputFromAsk(pc.scoreAsk(request)), warnings = [];
  const own = Array.isArray(raw.assumptions) ? raw.assumptions : [];
  const ids = new Set(own.map((a) => (isObj(a) ? a.id : null)).filter(Boolean));
  const out = Object.assign({}, raw, Array.isArray(raw.assumptions) || raw.assumptions === undefined ? { assumptions: own.concat(pi.assumptions.filter((a) => !ids.has(a.id))) } : {});
  const hasOwn = raw.question != null || (Array.isArray(raw.questions) && raw.questions.length > 0);
  if (pi.question && !hasOwn) out.question = pi.question;
  else if (pi.question) warnings.push('forge-promptcheck also proposed question ' + pi.question.id + '; the mission\'s own question is kept (one question per mission)');
  if (pi.free_question && !hasOwn) warnings.push('forge-promptcheck suggests a free question without choices ("' + pi.free_question.en + '"): pick a vetted one with `question --domain`, or decide it and record an assumption');
  return { raw: out, problems: [], warnings };
}

// ---- rendering: one label per line, [English, Dutch] ----
const LBL = {
  title: ['Plan card', 'Plankaart'], need: ['NEEDS YOUR OK', 'WACHT OP JOUW AKKOORD'], noStop: ['NO STOP', 'GEEN STOP'], srcflag: ['per-run flag', 'vlag voor deze run'],
  srcdefault: ['default', 'standaard'], srcsetting: ['setting', 'instelling'], goalH: ['Goal and real intent', 'Doel en echte bedoeling'], goal: ['Goal', 'Doel'],
  intent: ['Real intent', 'Echte bedoeling'], intentNone: ['not stated: the goal is read literally', 'niet genoemd: het doel wordt letterlijk gelezen'], domain: ['Domain', 'Domein'],
  assumH: ['Assumptions (auto-filled)', 'Aannames (automatisch ingevuld)'], assumNone: ['none: the request and the project answered every gap', 'geen: de opdracht en het project beantwoordden elk gat'],
  qH: ['Owner question (at most one)', 'Vraag aan de eigenaar (hooguit één)'], qNone: ['none: Forge decided every gap itself (see the assumptions)', 'geen: Forge besliste elk gat zelf (zie de aannames)'],
  rec: ['recommended', 'aanbevolen'], answer: ['Answer', 'Antwoord'], scopeH: ['Scope', 'Scope'], writes: ['Writes only', 'Schrijft alleen'],
  unanswered: ['Not answered yet. If it stays unanswered, Forge uses the default', 'Nog niet beantwoord. Blijft het onbeantwoord, dan gebruikt Forge de standaard'],
  readonly: ['everything else is read-only for this mission.', 'al het andere blijft alleen-lezen voor deze missie.'], pkgH: ['Work packages', 'Werkpakketten'],
  noWrites: ['nothing: this is a read-only mission.', 'niets: dit is een alleen-lezen missie.'], ro: ['read-only', 'alleen-lezen'], ready: ['ready', 'klaar om te starten'],
  cols: ['WP | Goal | Owner | Route | Owns | Deps | Wave | Status', 'WP | Doel | Eigenaar | Route | Bezit | Hangt af van | Golf | Status'],
  waits: ['waits for your OK', 'wacht op jouw akkoord'], lanesH: ['Expected lanes', 'Verwachte lanes'], wave: ['Wave', 'Golf'], lanes: ['lane(s)', 'lane(s)'],
  peak: ['Peak: {n} parallel lane(s) over {w} wave(s).', 'Piek: {n} parallelle lane(s) over {w} golf/golven.'],
  collide: ['One writer per file: WP {a} and WP {b} both own `{p}`, so they run one after the other.', 'Eén schrijver per bestand: WP {a} en WP {b} bezitten allebei `{p}`, dus die draaien na elkaar.'],
  risksH: ['Risks', 'Risico\'s'], risksNone: ['none identified', 'geen gevonden'], wontH: ['Will NOT do', 'Doet het NIET'],
  gatesH: ['Hard gates that need the owner', 'Harde poorten die de eigenaar nodig hebben'], gatesNone: ['none: nothing on this card needs the owner.', 'geen: niets op deze kaart heeft de eigenaar nodig.'],
  gateNote: ['Approving this card never unlocks a gate: each gate action still asks through its own yes-path when it is reached, batched at the end of the mission.',
    'Akkoord op deze kaart opent nooit een poort: elke poort-actie vraagt nog steeds via haar eigen ja-route wanneer ze aan de beurt is, gebundeld aan het eind van de missie.'],
  declared: ['declared', 'aangegeven'], undeclared: ['not declared, found by the classifier in the {s}', 'niet aangegeven, gevonden door de classifier in het {s}'],
  'in-goal': ['mission goal', 'missiedoel'], 'in-package-goal': ['package goal', 'pakketdoel'], 'in-owns-path': ['owns path', 'bezit-pad'],
  unrec: ['the classifier does not recognise these words; kept as an owner gate', 'de classifier herkent deze woorden niet; blijft een poort voor de eigenaar'],
  approved: ['approved', 'goedgekeurd'], proofH: ['How done is proven', 'Hoe "klaar" bewezen wordt'], verdictH: ['Verdict', 'Oordeel'],
  vAuto: ['No stop: plan-approval is auto. The card is logged; a gate action still stops at the action itself.', 'Geen stop: plan-approval staat op auto. De kaart is vastgelegd; een poort-actie stopt nog steeds bij de actie zelf.'],
  vNone: ['No stop: nothing on this card needs the owner. Building now.', 'Geen stop: niets op deze kaart heeft de eigenaar nodig. Forge bouwt nu.'],
  vApproved: ['No stop: the owner already approved this scope; it is never asked again.', 'Geen stop: de eigenaar keurde deze scope al goed; dat wordt nooit opnieuw gevraagd.'],
  vAll: ['Waits for your OK before any package starts.', 'Wacht op jouw akkoord voordat er een pakket start.'],
  vSome: ['Waits for your OK: {b}. Starting now: {r}.', 'Wacht op jouw akkoord: {b}. Start nu: {r}.'], vSomeAll: ['Waits for your OK: {b}.', 'Wacht op jouw akkoord: {b}.'],
  vQ: ['One question for you (asked once): see above.', 'Eén vraag aan jou (één keer gesteld): zie hierboven.'],
  swH: ['Switches (anticipation)', 'Schakelaars (vooruitgedacht)'], swWait: ['Waits for the owner', 'Wacht op de eigenaar'],
};
/** renderCard(model, lang) -> deterministic Markdown (same model + lang -> byte-identical text). */
function renderCard(model, lang) {
  const k = lang === 'nl' ? 'nl' : 'en', T = (key) => LBL[key][k === 'nl' ? 1 : 0];
  const { mission: m, verdict: v, lanes, items } = model;
  const bullets = (list, none) => (list.length ? list.map((s) => '- ' + s) : ['- ' + none]);
  const src = LBL['src' + model.modeSource] ? T('src' + model.modeSource) : T('srcsetting') + ' (' + model.modeSource + ')';
  const out = ['# ' + T('title') + ': ' + m.goal, '', '`card ' + model.cardHash.slice(0, 12) + '` · plan-approval **' + model.mode + '** (' + src + ') · **' + T(v.needsApproval ? 'need' : 'noStop') + '**',
    '', '## ' + T('goalH'), '- ' + T('goal') + ': ' + m.goal, '- ' + T('intent') + ': ' + (m.intent || T('intentNone'))];
  if (m.domain) out.push('- ' + T('domain') + ': ' + m.domain);
  out.push('', '## ' + T('assumH'), ...bullets(m.assumptions.map((a) => (a.id ? a.id + ': ' : '') + a.text[k]), T('assumNone')), '', '## ' + T('qH'));
  const q = m.question;
  if (!q) out.push('- ' + T('qNone'));
  else {
    out.push('- ' + (q.id ? q.id + ': ' : '') + q.text[k], ...q.choices.map((c, i) => '  - ' + 'ABCD'[i] + ') ' + c[k] + (i === q.recommended ? ' (' + T('rec') + ')' : '')));
    out.push('  - ' + (q.answer ? T('answer') + ': ' + q.answer : T('unanswered') + ': ' + q.default[k]));
  }
  const writes = [...new Set(m.packages.flatMap((p) => p.owns))];
  out.push('', '## ' + T('scopeH'), T('writes') + (writes.length ? ': ' + writes.map((s) => '`' + s + '`').join(', ') + '; ' + T('readonly') : ' ' + T('noWrites')));
  out.push('', '## ' + T('pkgH'), '| ' + T('cols') + ' |', '|' + ' --- |'.repeat(8));
  for (const p of m.packages) {
    out.push('| ' + [p.id, p.goal, p.owner || '-', p.route + ' (' + model.routes[p.route] + ')', p.owns.length ? p.owns.map((s) => '`' + s + '`').join(', ') : T('ro'),
      p.deps.length ? p.deps.join(', ') : '-', lanes.waveOf[p.id], T(v.blocked.includes(p.id) ? 'waits' : 'ready')].map(esc).join(' | ') + ' |');
  }
  out.push('', '## ' + T('lanesH'), ...lanes.waves.map((ids, i) => '- ' + T('wave') + ' ' + (i + 1) + ': ' + ids.join(', ') + ' (' + lanes.lanes[i] + ' ' + T('lanes') + ')'),
    '- ' + fill(T('peak'), { n: lanes.expected, w: lanes.waves.length }), ...lanes.collisions.map((c) => '- ' + fill(T('collide'), { a: c.a, b: c.b, p: c.path })));
  out.push('', '## ' + T('risksH'), ...bullets(m.risks, T('risksNone')), '', '## ' + T('wontH'), ...bullets(m.wont_do, '-'), '', '## ' + T('gatesH'));
  if (!items.length) out.push('- ' + T('gatesNone'));
  for (const it of items) {
    const how = it.declared ? T('declared') + (it.recognized ? '' : '; ' + T('unrec')) : fill(T('undeclared'), { s: T('in-' + it.source) }), mark = v.open.includes(it.key) || model.mode === 'auto' ? '' : ' · ' + T('approved');
    out.push('- **' + (it.gate || 'owner-gate') + '** · ' + (it.wp ? 'WP ' + it.wp : 'mission') + ' · ' + how + mark + ': ' + it.text + ' (`' + it.key + '`)');
  }
  if (items.length) out.push('', T('gateNote'));
  const sw = m.switches, swAnn = sw ? clean(sw.announcement) : '', swWait = sw && Array.isArray(sw.waits_for_owner) ? sw.waits_for_owner.map((w) => (isObj(w) ? (bi(w.label) || bi(w.id) || { [k]: '' })[k] : clean(w))).filter(Boolean) : [];
  if (swAnn || swWait.length) out.push('', '## ' + T('swH'), ...(swAnn ? ['- ' + swAnn] : []), ...swWait.map((l) => '- ' + T('swWait') + ': ' + l));
  out.push('', '## ' + T('proofH'), ...bullets(m.proof, '-'), '', '## ' + T('verdictH'));
  let line;
  if (model.mode === 'auto') line = T('vAuto');
  else if (!v.needsApproval) line = T(v.cardApproved || items.length ? 'vApproved' : 'vNone');
  else if (v.stop === 'all') line = T('vAll');
  else line = fill(T(v.ready.length ? 'vSome' : 'vSomeAll'), { b: v.blocked.join(', '), r: v.ready.join(', ') });
  out.push('- ' + line, ...(v.questionDue ? ['- ' + T('vQ')] : []));
  return out.join('\n') + '\n';
}

/** buildCard(raw, {mode, lang, root, request}) -> { ok, problems, warnings, model?, markdown?, json? } */
function buildCard(raw, opts) {
  opts = opts || {}; const root = path.resolve(opts.root || projectRootDefault());
  const merged = opts.request != null ? mergeRequest(raw, opts.request) : { raw, problems: [], warnings: [] };
  const { mission, problems, warnings } = normalizeMission(merged.raw);
  if (merged.problems.length || problems.length) return { ok: false, problems: merged.problems.concat(problems), warnings: merged.warnings.concat(warnings) };
  const m = resolveMode(opts.mode, root), hash = cardHash(mission), items = collectGateItems(mission, root);
  const verdict = decide(mission, items, m.mode, hash), lanes = planLanes(mission.packages), routes = readRoutes();
  const model = { mission, cardHash: hash, mode: m.mode, modeSource: m.source, items, verdict, lanes, routes: routes.map };
  const markdown = renderCard(model, opts.lang), all = merged.warnings.concat(warnings, m.warnings, routes.warnings);
  const json = { ok: true, cardHash: hash, mode: m.mode, modeSource: m.source, needsApproval: verdict.needsApproval, stop: verdict.stop,
    blocked: verdict.blocked, ready: verdict.ready, reasons: verdict.reasons, questionDue: verdict.questionDue, question: mission.question,
    gateItems: items.map((it) => Object.assign({}, it, { approved: m.mode !== 'auto' && !verdict.open.includes(it.key) })),
    lanes: { waves: lanes.waves, lanes: lanes.lanes, expected: lanes.expected, collisions: lanes.collisions },
    approvalRecord: { card: hash, gates: items.map((it) => it.key) }, warnings: all, card: markdown };
  return { ok: true, problems: [], warnings: all, model, markdown, json };
}

// ---- the question bank: vetted questions per domain, at most ONE asked ----
function bankQuestions(bank) { // [{domain, n, id: '<domain>#<n>', q}] — universal first, then byType in bank order
  const groups = [['universal', bank && bank.universal]].concat(bank && isObj(bank.byType) ? Object.entries(bank.byType) : []);
  return groups.flatMap(([domain, list]) => (Array.isArray(list) ? list : []).map((q, i) => ({ domain, n: i + 1, id: domain + '#' + (i + 1), q })));
}
/** validateBank(bank) -> problems[] — every question has choices + a default + a domain; the cap is exactly 1. */
function validateBank(bank) {
  if (!isObj(bank) || !Array.isArray(bank.universal)) return ['the bank must be an object with a "universal" array'];
  const problems = [], pol = bank.one_question_policy, byType = isObj(bank.byType) ? bank.byType : {};
  const okList = (a) => Array.isArray(a) && a.length >= 2 && a.length <= 4 && a.every((x) => clean(x));
  if (bank.byType !== undefined && !isObj(bank.byType)) problems.push('"byType" must be an object of domain -> questions');
  if (!isObj(pol)) problems.push('one_question_policy is missing');
  else if (pol.max_owner_questions_per_mission !== MAX_OWNER_QUESTIONS) problems.push('one_question_policy.max_owner_questions_per_mission must be ' + MAX_OWNER_QUESTIONS + ' (got ' + JSON.stringify(pol.max_owner_questions_per_mission) + '): Forge never asks more than one question');
  for (const d of Object.keys(byType)) {
    if (!/^[a-z][a-z0-9-]*$/.test(d) || d === 'universal') problems.push('byType key "' + d + '" is not a domain slug');
    if (!Array.isArray(byType[d])) problems.push('byType.' + d + ' must be an array of questions');
  }
  for (const { id, q } of bankQuestions(bank)) {
    const bad = (msg) => problems.push(id + ': ' + msg), b = isObj(q) ? q.beginner : null;
    if (!isObj(q)) { bad('must be an object'); continue; }
    if (!clean(q.question) || !clean(q.question_nl)) bad('needs question + question_nl');
    if (!isObj(b)) { bad('needs a beginner block (the choices + the default)'); continue; }
    if (!okList(b.options)) bad('beginner.options (the choices) needs 2-4 non-empty entries');
    if (!okList(b.options_nl) || (Array.isArray(b.options) && b.options_nl.length !== b.options.length)) bad('beginner.options_nl must match beginner.options 1:1');
    if (!clean(b.assume) || !clean(b.assume_nl)) bad('beginner.assume + assume_nl (the default used when unanswered) are required');
    if (!(b.recommended === null || (Number.isInteger(b.recommended) && Array.isArray(b.options) && b.recommended >= 0 && b.recommended < b.options.length))) bad('beginner.recommended must be null or the index of a choice');
  }
  return problems;
}
/** pickQuestion(bank, {domain, trigger}) -> exactly ONE vetted question (the domain set first, then universal; required
 *  before recommended; bank order) in the plan card's question shape, or null. Never a list. */
function pickQuestion(bank, opts) {
  const dom = clean(opts && opts.domain), trig = opts && opts.trigger;
  const all = bankQuestions(bank).filter((x) => isObj(x.q) && isObj(x.q.beginner) && Array.isArray(x.q.beginner.options));
  const fits = all.filter((x) => x.domain === dom).concat(all.filter((x) => x.domain === 'universal' && dom !== 'universal'))
    .filter((x) => !trig || (Array.isArray(x.q.triggers) && x.q.triggers.includes(trig)));
  const pick = fits.find((x) => x.q.tier === 'required') || fits[0];
  if (!pick) return null;
  const q = pick.q, b = q.beginner, nl = Array.isArray(b.options_nl) ? b.options_nl : [];
  return { id: pick.id, domain: pick.domain, dimension: clean(q.dimension) || null, tier: q.tier === 'required' ? 'required' : 'recommended',
    text: { en: clean(q.question), nl: clean(q.question_nl) || clean(q.question) }, choices: b.options.map((o, i) => ({ en: clean(o), nl: clean(nl[i]) || clean(o) })),
    recommended: Number.isInteger(b.recommended) ? b.recommended : null, default: { en: clean(b.assume), nl: clean(b.assume_nl) || clean(b.assume) },
    triggers: Array.isArray(q.triggers) ? q.triggers.slice() : [], source: 'question-bank' };
}

// ---- CLI ----
const USAGE = 'Usage: node forge-plan-card.cjs [render] --file <mission.json|-> [--mode auto|gated|always] [--lang en|nl] [--root <dir>] [--request "<text>"] [--json] [--run <run_id>]\n'
  + '       node forge-plan-card.cjs question --domain <slug> [--trigger F<1-13>] [--lang en|nl] [--bank <file>] [--json]\n'
  + '       node forge-plan-card.cjs validate-bank [--bank <file>] [--json]';
const ALLOWED = { render: ['--file', '--mode', '--lang', '--root', '--request', '--run', '--json'], question: ['--domain', '--trigger', '--lang', '--bank', '--json'], 'validate-bank': ['--bank', '--json'] };
function parseArgs(argv) {
  const cmd = ALLOWED[argv[0]] ? argv[0] : 'render', rest = ALLOWED[argv[0]] ? argv.slice(1) : argv, errors = [];
  const o = { cmd, file: null, mode: null, lang: 'en', root: null, request: null, run: null, domain: null, trigger: null, bank: null, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-' && cmd === 'render' && o.file === null) o.file = '-';
    else if (!ALLOWED[cmd].includes(a)) errors.push('unknown argument "' + a + '" for ' + cmd);
    else if (a === '--json') o.json = true;
    else if (rest[i + 1] === undefined) { errors.push(a + ' needs a value'); i++; }
    else o[a.slice(2)] = rest[++i];
  }
  if (o.mode !== null && !MODES.includes(o.mode)) errors.push('--mode must be auto, gated or always');
  if (!['en', 'nl'].includes(o.lang)) errors.push('--lang must be en or nl');
  if (o.run !== null && !/^[A-Za-z0-9_-]+$/.test(o.run)) errors.push('--run id may only hold A-Z a-z 0-9 _ -');
  if (o.trigger !== null) { const t = /^F(1[0-3]|[1-9])$/i.exec(o.trigger); if (t) o.trigger = 'F' + t[1]; else errors.push('--trigger must be F1..F13'); }
  if (cmd === 'render' && o.file === null) errors.push('give the mission with --file <path> or --file - (stdin)');
  if (cmd === 'question' && !clean(o.domain || '')) errors.push('question needs --domain <slug>');
  return { o, errors };
}
function saveAndLog(runId, root, res) {
  if (!root) return { saved: null, warnings: ['no project root found (no .claude, .forge or .git above the current folder): the card was printed, not saved or logged'] }; const dir = runDirOf(root, runId), rel = path.relative(root, dir).split(path.sep).join('/'); // legacy rel = '.claude/forge-runs/<id>' as before
  if (!fs.existsSync(dir)) return { saved: null, warnings: ['run folder ' + rel + ' does not exist: the card was printed, not saved or logged'] };
  const { card, saved, ...json } = res.json, v = res.model.verdict;
  fs.writeFileSync(path.join(dir, 'plan-card.md'), res.markdown, 'utf8');
  fs.writeFileSync(path.join(dir, 'plan-card.json'), JSON.stringify(Object.assign({}, json, { packages: res.model.mission.packages.length }), null, 2) + '\n', 'utf8'); // 2.9c run shape: lanes.expected + the package count, recorded
  const note = 'plan card ' + json.cardHash.slice(0, 12) + ' · plan-approval ' + json.mode + ' (' + json.modeSource + ') · needsApproval ' + (v.needsApproval ? 'yes' : 'no')
    + ' · stop ' + v.stop + ' · ' + res.model.items.length + ' gate item(s) · ' + res.model.mission.packages.length + ' WP · peak ' + res.model.lanes.expected + ' lane(s)';
  const r = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), runId, 'agent_note',
    JSON.stringify({ agent: 'orchestrator', role: 'lead', note, evidence: rel + '/plan-card.md' })], { encoding: 'utf8' });
  const warnings = r.status === 0 ? [] : ['log-event warning (the card is saved): ' + ((r.stderr || r.stdout || (r.error && r.error.message) || '').trim() || 'exit ' + r.status)];
  return { saved: { md: rel + '/plan-card.md', json: rel + '/plan-card.json' }, warnings };
}
function runBank(o) {
  const bankPath = o.bank ? path.resolve(o.bank) : path.join(projectRootDefault(), '.claude', 'config', 'intake', 'question-bank.json');
  let bank;
  try { bank = JSON.parse(fs.readFileSync(bankPath, 'utf8')); } catch (e) { console.error('forge-plan-card: cannot read the question bank (' + bankPath + '): ' + e.message); return 1; }
  if (o.cmd === 'validate-bank') {
    const problems = validateBank(bank), n = bankQuestions(bank).length;
    if (o.json) console.log(JSON.stringify({ valid: !problems.length, questions: n, max_owner_questions: MAX_OWNER_QUESTIONS, problems }));
    else console.log(problems.length ? 'question bank INVALID (' + problems.length + ' problem(s)):\n' + problems.map((p) => '  - ' + p).join('\n') : 'question bank valid: ' + n + ' vetted questions, each with choices, a default and a domain; at most ' + MAX_OWNER_QUESTIONS + ' asked per mission');
    return problems.length ? 3 : 0;
  }
  const q = pickQuestion(bank, { domain: o.domain, trigger: o.trigger });
  const note = o.domain === 'universal' || (isObj(bank.byType) && Array.isArray(bank.byType[o.domain])) ? null : 'unknown domain "' + o.domain + '": universal questions only';
  if (o.json) { console.log(JSON.stringify({ domain: o.domain, trigger: o.trigger, note, max_owner_questions: MAX_OWNER_QUESTIONS, question: q })); return 0; }
  if (note) console.error('forge-plan-card: ' + note);
  const k = o.lang;
  console.log(!q ? 'no vetted question for this domain' + (o.trigger ? ' and ' + o.trigger : '') + ': Forge decides and records the assumption'
    : q.id + ' — ' + q.text[k] + '\n' + q.choices.map((c, i) => '  ' + 'ABCD'[i] + ') ' + c[k] + (i === q.recommended ? ' *' : '')).join('\n') + '\n  default: ' + q.default[k]);
  return 0;
}
function main(argv) {
  const { o, errors } = parseArgs(argv);
  if (errors.length) { errors.forEach((e) => console.error('forge-plan-card: ' + e)); console.error(USAGE); return 2; }
  if (o.cmd !== 'render') return runBank(o);
  let raw;
  try { raw = JSON.parse(o.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(o.file), 'utf8')); }
  catch (e) { console.error('forge-plan-card: cannot read the mission (' + o.file + '): ' + e.message); return 2; }
  const res = buildCard(raw, { mode: o.mode, lang: o.lang, root: o.root, request: o.request });
  if (!res.ok) { res.problems.forEach((p) => console.error('forge-plan-card: ' + p)); if (o.json) console.log(JSON.stringify({ ok: false, problems: res.problems, warnings: res.warnings })); return 2; }
  if (o.run) { const saveRoot = o.root || scriptProjectRoot(); const s = saveAndLog(o.run, saveRoot ? path.resolve(saveRoot) : null, res); res.json.saved = s.saved; res.json.warnings = res.json.warnings.concat(s.warnings); }
  if (o.json) console.log(JSON.stringify(res.json));
  else { res.json.warnings.forEach((w) => console.error('forge-plan-card: warning: ' + w)); process.stdout.write(res.markdown); }
  return res.model.verdict.needsApproval ? 3 : 0;
}

module.exports = { normalizeMission, collectGateItems, decide, planLanes, renderCard, buildCard, cardHash, resolveMode,
  validateBank, bankQuestions, pickQuestion, main, MODES, DEFAULT_MODE, MAX_OWNER_QUESTIONS };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('forge-plan-card: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; }
}
