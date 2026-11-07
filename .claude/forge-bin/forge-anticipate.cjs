#!/usr/bin/env node
'use strict';
/**
 * forge-anticipate.cjs — the ANTICIPATION ENGINE (modernization WP I.2). Owner rule (intelligence-bar.md
 * rule 1, standing rule owner-remember-mvlqw2ut-gmtk93): before starting, work out which skills, switches, checks and
 * tools a task needs and use every SAFE one without being asked; say in ONE line what and why; OWNER-GATED items
 * (cost, outbound, credentials, destructive, production) wait in the owner queue, batched at the end of the run.
 * Zero-dependency. The data is .claude/config/intelligence/switch-catalog.json; this file only reads it.
 *
 * plan     --text "<task>" [--lanes N] [--type <deliverable>] [--files N] [--lang en|nl] [--json]
 *          -> {matched, safe_to_enable, already_on, gated_queue, respected_off, skipped, skills_to_use, checks_to_run,
 *          tools_to_run, announcement (one line, <= 200 chars, the task's language), reasons, switches}. It ONLY plans
 *          (planned_only:true): it never changes a setting and never puts an OWNER-GATED entry in a "use" list. A
 *          setting the owner turned off is respected (respected_off), never overridden. Hook-like: any error -> one
 *          stderr line, nothing changed, exit 0 (with --json a {"ok":false} object on stdout).
 * apply    --run <run_id> [--text ...] [plan flags] -> forge-config has no run scope (only global/project files and a
 *          per-call --flag that is never written), so apply changes NOTHING persistent: it writes the per-run overlay
 *          <runs>/<run_id>/anticipate.json (<runs> = .forge/runs or .claude/forge-runs, 2.9c) {status, active, applied[{id,
 *          lead_action, revert}], config_flags (forge-config --flag k=v for this run only), waits_for_owner, deliverable_types
 *          (craft lens types, 2.9c), revert} and logs one agent_note. Only
 *          SAFE run/session entries are applied. The text defaults to run.json "request", the lanes to plan-card.json.
 * revert   --run <run_id> -> the overlay becomes status "reverted" with active [] (kept for the audit trail).
 * explain  <id> [--json] · validate [--json] (catalog shape, every mechanism opened, the SAFE cross-check) ·
 * metric   [--since <date>] [--json] -> owner "turn it on / you forgot" corrections per mission, read-only from
 *          .claude/forge-scribe/ledger.jsonl: a record counts when its class is "toggle-correction" or its tags hold it
 *          (forge-scribe.cjs tags new owner prompts since WP I.8c; retag --toggle-correction --apply back-fills older ones,
 *          dated by item_ts); a ledger without any judged record says so instead of guessing.
 * Matching (WP I.8b): keywords go word by word through forge-text-normalize.cjs (plurals, compounds by marker, phrases).
 * Plan-card contract: copy plan --json `switches` {v, announcement, auto_enabled[], waits_for_owner[], already_on[],
 *   respected_off[]} into the mission JSON as "switches" (today the card lists it as an unknown key, never an error).
 * Kill switch: config `anticipate` (bool, default on). Exit: plan 0 · apply/revert 0 ok, 2 usage, 1 internal ·
 *   explain 0, 1 unknown id · metric 0, 2 usage · validate 0 valid, 3 invalid. FORGE_PROJECT_ROOT or --root = project.
 */
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const BIN_DIR = __dirname; // ANTICIPATE-BIN-DIR (the mutation tests point this at the real forge-bin)
const INSTALL_ROOT = path.resolve(BIN_DIR, '..', '..');
const CATALOG_DEFAULT = path.join(INSTALL_ROOT, '.claude', 'config', 'intelligence', 'switch-catalog.json');
const req = (name) => require(path.join(BIN_DIR, name));
const KINDS = ['config-key', 'skill', 'check', 'tool', 'workflow'], SCOPES = ['run', 'session', 'project'];
const CLASSES = ['SAFE', 'OWNER-GATED'], REASONS = ['cost', 'outbound', 'credentials', 'destructive', 'production', 'none'];
const STATES = ['on', 'off', 'config'], ENFORCE = ['mechanical', 'partial', 'prose-only'];
const EVIDENCE_CLASSES = ['SAFE', 'OWNER-GATED', 'ALREADY-DEFAULT', 'SAFE-LOCAL-ONLY'];
const TRIGGER_KEYS = ['always', 'keywords', 'signals_any', 'min_lanes', 'min_files', 'domains_any', 'deliverables_any', 'domain_known'];
const VERIFY_TYPES = ['schema-key', 'skill', 'global-skill', 'file', 'global-file', 'hard-rule', 'gate', 'locked', 'skill-registry', 'standing-rule', 'owner-rule', 'evidence-row', 'quality-cards', 'playbooks']; // owner-rule: evidence only (26h2 sync)
const MAX_TEXT = 20000, MAX_LINE = 200, MAX_LANES = 12, RUN_ID_RE = /^[A-Za-z0-9_-]+$/, OWNER_SOURCES = ['global', 'project', 'flag', 'product-default'];
// Independent second opinion on SAFE (kept in code, not in the catalog, so one catalog edit cannot defeat it).
const RISK_WORDS = [
  ['outbound', /\b(push|pushes|pushed|pushing|publish\w*|releases?|released|deploy\w*|upload\w*|send|sends|sent|sending|e-?mails?|sms|outreach|openai|groq)\b/i],
  ['credentials', /\b(credentials?|tokens?|passwords?|wachtwoord\w*|secrets?|api[- ]?keys?|login files?|oauth|enroll\w*)\b/i],
  ['destructive', /\b(delete\w*|remove\w*|wipe\w*|purge\w*|prune\w*|verwijder\w*|overwrite\w*|drop table|reset --hard)\b/i],
  ['production', /\b(production|prod|live site|go[- ]live|dns|vercel)\b/i],
  ['cost', /\b(quota|paid|purchase\w*|charge\w*|billing|credits?|spend\w*|unattended|onbeheerd)\b/i],
];
const FLAG_REASON = { C: 'credentials', N: 'outbound', $: 'cost', U: 'cost', X: 'outbound', D: 'destructive' };
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12 };
const LANE_UNITS = 'parts|pieces|components|modules|packages|work packages|workstreams|lanes|agents|tasks|features|delen|onderdelen|stukken|werkpakketten|pakketten|componenten|taken';
const LANE_RE = new RegExp('(?<![a-z0-9])(\\d{1,2}|' + Object.keys(NUM_WORDS).join('|') + ')\\s+(?:[a-z\\u00c0-\\u024f-]+\\s+){0,2}?(?:' + LANE_UNITS + ')(?![a-z0-9])', 'g');
const NL_WORDS = new Set(('de het een en van voor met maak bouw niet ik wil dat zet onderzoek graag deze mijn aan op ook naar bij werk alles daarna welke past bekijk vat wissel als raakt '
  + 'dit wat je nog moet kan hoe waarom zodat geen nu meteen alleen zijn wordt worden heb hebben kunnen zou gaan ga dan typfout fout aanpassen toevoegen verbeteren veranderen kleur knop veiliger').split(' '));
const EN_WORDS = new Set(('the a an and of for with make build not i want that turn research please this my on to it into all then which watch summarize switch when hits '
  + 'should can how why so now also only are be will would have from your do does add update use').split(' '));
const TXT = {
  en: { uses: 'Forge uses: ', because: ' — for ', and: ' and ', waits: 'Waits for you: ', nothing: 'Forge needs nothing extra for this task.', nothingOn: 'Nothing extra to turn on.',
    off: 'Anticipation is off (setting anticipate): Forge plans no extra switches.', lanes: (n) => n + ' parallel parts', web_ui: 'a web page or UI', long_running: 'a long run', security: 'a security-sensitive change', research: 'research', domain: (d) => 'a ' + d + ' project' },
  nl: { uses: 'Forge gebruikt: ', because: ' — vanwege ', and: ' en ', waits: 'Wacht op jou: ', nothing: 'Forge heeft niets extra nodig voor deze taak.', nothingOn: 'Niets extra aan te zetten.',
    off: 'Anticipatie staat uit (instelling anticipate): Forge plant geen extra schakelaars.', lanes: (n) => n + ' parallelle delen', web_ui: 'een webpagina of UI', long_running: 'een lange run', security: 'een beveiligingsgevoelige wijziging', research: 'onderzoek', domain: (d) => 'een ' + d + '-project' },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const projectRoot = (o) => path.resolve((o && o.root) || process.env.FORGE_PROJECT_ROOT || INSTALL_ROOT);
const homeDir = (o) => path.resolve((o && o.home) || process.env.FORGE_ANTICIPATE_HOME || os.homedir());
function loadCatalog(file) { return readJson(file || CATALOG_DEFAULT); }

// ---- matching (WP I.8b): word by word through the shared NL/EN normaliser; a keyword matches itself, its plurals and -ing form
// (wachtwoorden, parsing), never a shorter word ("rechten" is not "recht"); 'word*' starts with; '-word' / 'word-' = compound end / start ----
const NZ = (() => { try { return req('forge-text-normalize.cjs'); } catch { return null; } })(); // missing: whole words only
const KW = new Map(), EF = new Map(), ef = (w) => { if (!EF.has(w)) EF.set(w, new Set(NZ ? [...NZ.englishForms(w)].filter((f) => f === w + 's' || f === w + 'es' || (f.endsWith('ing') && f.length > w.length)) : [])); return EF.get(w); }; // plural + -ing only: -er/-ed make other words (platform -> platformer)
const words = (s) => (NZ ? NZ.tokenize(s).map((x) => x.raw) : String(s).toLowerCase().split(/[^a-z0-9À-ɏ']+/).filter(Boolean));
function parseKw(kw) { if (KW.has(kw)) return KW.get(kw); let k = String(kw).trim().toLowerCase(); const prefix = k.endsWith('*'); if (prefix) k = k.slice(0, -1);
  const m = { prefix, head: /^-[a-z]/.test(k), mod: /[a-z]-$/.test(k), raw: words(k) }; KW.set(kw, m); return m; }
function lexOf(text) { const toks = words(String(text).slice(0, MAX_TEXT)); return { toks, cands: toks.map((w) => (NZ ? NZ.candidates(w) : [w])) }; }
function tokHas(L, i, m, j) { // L.toks[i] null = blanked by a signal's exclude list
  const tok = L.toks[i], raw = m.raw[j]; if (tok === null) return false; if (m.prefix && j === m.raw.length - 1) return tok.startsWith(raw);
  if (L.cands[i].includes(raw) || ef(raw).has(tok)) return true;
  const pos = (m.head || m.mod) && NZ ? NZ.compoundPosition(tok, raw, L.cands[i]) : null; return (pos === 'head' && m.head) || (pos === 'modifier' && m.mod); }
const hitAt = (L, m, i) => m.raw.every((_, j) => tokHas(L, i + j, m, j));
const spans = (L, kw) => { const m = parseKw(kw), out = []; for (let i = 0; m.raw.length && i + m.raw.length <= L.toks.length; i++) if (hitAt(L, m, i)) out.push([i, i + m.raw.length]); return out; };
const lexMask = (L, phrases) => { const toks = L.toks.slice(); for (const p of phrases) for (const [a, b] of spans(L, p)) toks.fill(null, a, b); return { toks, cands: L.cands }; };
const both = (o) => arr(o && o.en).concat(arr(o && o.nl));
function kwHit(L, kws) { for (const k of both(kws)) if (spans(L, k).length) return k; return null; }
const kwMatch = (text, kw) => spans(lexOf(text), kw).length > 0;
function kwProblem(k) { const m = parseKw(k); if (!m.raw.length) return 'keyword ' + JSON.stringify(k) + ' holds no word'; // validate
  return (m.head || m.mod) && (m.raw.length !== 1 || (NZ && !NZ.compoundEligible(m.raw[0]))) ? 'keyword ' + JSON.stringify(k) + ': a compound marker (-word / word-) needs one word of at least 5 letters' : null; }
function detectLang(t) {
  let nl = 0, en = 0;
  for (const w of t.split(/[^a-zÀ-ɏ']+/)) { if (NL_WORDS.has(w)) nl++; if (EN_WORDS.has(w)) en++; }
  return nl > en ? 'nl' : en > nl ? 'en' : null;
}
function parseLanes(t) {
  let n = 1, m; LANE_RE.lastIndex = 0;
  while ((m = LANE_RE.exec(t))) n = Math.max(n, /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]]);
  return Math.min(n, MAX_LANES);
}
function intOpt(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? Math.min(n, 10000) : 0; }

// ---- settings (forge-config.cjs is the only resolver; read fail-safe) ----
function configReader(root) {
  let cfg = null, values = null;
  try { cfg = req('forge-config.cjs'); values = cfg.resolve({ projectRoot: root }).settings; } catch { values = null; }
  return (key, fallback) => {
    if (values && values[key]) return { value: values[key].value, source: values[key].source, degraded: false };
    try { if (cfg) { const r = cfg.safeGet(key, { projectRoot: root, fallback }); return { value: r.value, source: r.source, degraded: !!r.degraded }; } } catch { /* fall through */ }
    return { value: fallback, source: 'built-in', degraded: true };
  };
}
function stateOf(e, read) {
  const owner = (r) => OWNER_SOURCES.includes(r.source);
  if (e.requires_config) {
    const r = read(e.requires_config.key, e.requires_config.on_values[0]);
    if (!r.degraded && !e.requires_config.on_values.includes(r.value) && owner(r)) return { state: 'off-by-owner', key: e.requires_config.key, value: r.value, source: r.source };
  }
  if (e.default_state !== 'config') return { state: e.default_state };
  const r = read(e.config_key, e.on_values[0]);
  if (r.degraded) return { state: 'unknown', key: e.config_key };
  if (e.on_values.includes(r.value)) return { state: 'on', key: e.config_key, value: r.value, source: r.source };
  if (arr(e.ask_values).includes(r.value)) return { state: 'off', key: e.config_key, value: r.value, source: r.source };
  return owner(r) ? { state: 'off-by-owner', key: e.config_key, value: r.value, source: r.source } : { state: 'off', key: e.config_key, value: r.value, source: r.source };
}

// ---- signals from the mission ----
function profileOf(t) {
  try {
    const q = req('forge-quality.cjs'), p = q.compileMissionProfile(t, { root: INSTALL_ROOT });
    const known = p.classification_confidence !== 'none';
    const cat = known ? q.loadCatalog(INSTALL_ROOT).domains : {}, pb = (dom) => { const d = cat[dom]; return d && d.playbook && exists(path.join(INSTALL_ROOT, '.claude', 'skills', d.playbook, 'SKILL.md')) ? d.playbook : null; };
    const playbook = known ? pb(p.primary_domain) : null, playbooks = known ? [...new Set([p.primary_domain].concat(arr(p.project_type)).map(pb).filter(Boolean))] : []; // A1 2026-11-07: every detected domain, primary first
    return { domains: known ? p.project_type : [], primary: known ? p.primary_domain : null, known, playbook, playbooks };
  } catch { return { domains: [], primary: null, known: false, playbook: null, playbooks: [] }; }
}
function computeSignals(text, opts, catalog, read) {
  const t = String(text == null ? '' : text).slice(0, MAX_TEXT).toLowerCase();
  const prof = profileOf(t), deliverable = opts.type ? String(opts.type).toLowerCase().trim().replace(/\s+/g, '-') : null;
  let lanes = Math.max(intOpt(opts.lanes) ? Math.min(intOpt(opts.lanes), MAX_LANES) : 1, parseLanes(t));
  const fm = /(?<![a-z0-9])(\d{1,4})\s+(?:[a-z-]+\s+)?(?:files|bestanden)(?![a-z0-9])/.exec(t);
  const files = intOpt(opts.files) || (fm ? Number(fm[1]) : 0);
  const sigDefs = isObj(catalog.signals) ? catalog.signals : {}, flags = {}, L0 = lexOf(t);
  const test = (name) => {
    const s = sigDefs[name]; if (!isObj(s)) return null;
    const L = isObj(s.exclude) ? lexMask(L0, both(s.exclude)) : L0, k = kwHit(L, s.keywords); if (k) return 'keyword "' + k + '"';
    for (const p of arr(s.together)) { const a = kwHit(L, p && p.a), b = a && kwHit(L, p.b); if (b) return 'keywords "' + a + '" + "' + b + '"'; }
    const d = arr(s.domains).find((x) => prof.domains.includes(x)); if (d) return 'domain ' + d;
    if (deliverable && arr(s.deliverables).includes(deliverable)) return 'deliverable ' + deliverable;
    if (s.min_lanes && lanes >= s.min_lanes) return lanes + ' lanes';
    return null;
  };
  if (sigDefs.parallel) { flags.parallel = test('parallel'); if (flags.parallel && lanes < 2) lanes = 2; }
  for (const name of Object.keys(sigDefs)) if (name !== 'parallel') flags[name] = test(name);
  let lang = opts.lang === 'nl' || opts.lang === 'en' ? opts.lang : detectLang(t);
  if (!lang) { const l = read('language', 'auto').value; lang = l === 'nl' || l === 'en' ? l : 'en'; }
  return { t, L: L0, lang, lanes, files, deliverable, domains: prof.domains, primary: prof.primary, domain_known: prof.known, playbook: prof.playbook, playbooks: prof.playbooks || [], flags };
}
function triggerWhy(tr, s) {
  const why = [];
  for (const k of Object.keys(tr)) {
    const v = tr[k];
    if (k === 'always') why.push('always for a build');
    else if (k === 'keywords') { const h = kwHit(s.L, v); if (!h) return null; why.push('keyword "' + h + '"'); }
    else if (k === 'signals_any') { const n = arr(v).find((x) => s.flags[x]); if (!n) return null; why.push(n + ' (' + s.flags[n] + ')'); }
    else if (k === 'min_lanes') { if (s.lanes < v) return null; why.push(s.lanes + ' lanes >= ' + v); }
    else if (k === 'min_files') { if (s.files < v) return null; why.push(s.files + ' files >= ' + v); }
    else if (k === 'domains_any') { const d = arr(v).find((x) => s.domains.includes(x)); if (!d) return null; why.push('domain ' + d); }
    else if (k === 'deliverables_any') { if (!s.deliverable || !arr(v).includes(s.deliverable)) return null; why.push('deliverable ' + s.deliverable); }
    else if (k === 'domain_known') { if (!s.domain_known) return null; why.push('domain ' + s.primary + ' recognised'); }
    else return null;
  }
  return why.length ? why.join(' + ') : null;
}
const entryWhy = (e, s) => arr(e.triggers).map((tr) => (isObj(tr) ? triggerWhy(tr, s) : null)).filter(Boolean);

// ---- mechanism checks (also used by plan: a runtime ref that is missing makes an entry unavailable) ----
function verifyRef(ref, ctx) {
  const T = String(ref.target || ''), R = ctx.root, ok = { ok: true }, bad = (m) => ({ ok: false, problem: m }), soft = (m) => ({ ok: false, warn: m });
  const inRoot = (rel) => { const p = path.resolve(R, rel); return p.startsWith(R + path.sep) ? p : null; };
  switch (ref.type) {
    case 'schema-key': return ctx.schema && isObj(ctx.schema.settings) && ctx.schema.settings[T] ? ok : bad('config key ' + T + ' is not in FORGE_CONFIG_SCHEMA.json');
    case 'skill': return exists(path.join(R, '.claude', 'skills', T, 'SKILL.md')) ? ok : bad('skill .claude/skills/' + T + '/SKILL.md does not exist');
    case 'global-skill': return exists(path.join(ctx.home, '.claude', 'skills', T, 'SKILL.md')) ? ok : soft('global skill ' + T + ' is not installed on this machine');
    case 'file': { const p = inRoot(T); return p && exists(p) ? ok : bad('file ' + T + ' does not exist in this install'); }
    case 'global-file': return exists(path.join(ctx.home, T.replace(/^~[\\/]/, ''))) ? ok : soft(T + ' is not installed on this machine');
    case 'hard-rule': return ctx.hardRules.has(T) ? ok : bad('hard rule ' + T + ' is not in FORGE_HARD_RULES.json');
    case 'gate': return ctx.gates.has(T) ? ok : bad(T + ' is not a forge-actiongate gate id');
    case 'locked': return ctx.locked.has(T) ? ok : bad(T + ' is not a locked id in FORGE_CONFIG_SCHEMA.json');
    case 'skill-registry': return ctx.registry.has(T) ? ok : bad('skill ' + T + ' is not in .claude/config/skills/global-skills.json');
    case 'standing-rule': return ctx.rules.shipped.has(T) ? ok : bad('standing rule ' + T + ' is not in the shipped FORGE_STANDING_RULES.json (a rule only an owner overlay holds is cited as an owner-rule ref)');
    case 'owner-rule': return ctx.rules.shipped.has(T) ? bad('owner rule ' + T + ' ships in FORGE_STANDING_RULES.json: cite it as a standing-rule ref') : ctx.rules.owner.has(T) ? ok : ctx.devTree && !ctx.rules.ownerPresent ? soft('owner rule ' + T + ' not judged: FORGE_STANDING_RULES.user.json is absent in this checkout (the owner overlay is user-local, never shipped, e.g. a fresh clone)') : ctx.devTree ? bad('owner rule ' + T + ' is not in this development tree\'s FORGE_STANDING_RULES.user.json') : soft('owner rule ' + T + ' cites the Forge maintainer\'s owner overlay (never shipped): not judged in this install');
    case 'evidence-row': return ctx.evidence === null ? soft('docs/audit/intelligence-evidence.md is not in this install (local-only)') : ctx.evidence.has(T) ? ok : bad('row #' + T + ' is not in intelligence-evidence.md section 1');
    case 'quality-cards': { const d = inRoot(T); let n = 0; try { n = fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { n = 0; } return n ? ok : bad('no quality gate cards in ' + T); }
    case 'playbooks': { const miss = ctx.playbooks.filter((p) => !exists(path.join(R, '.claude', 'skills', p, 'SKILL.md'))); return ctx.playbooks.length && !miss.length ? ok : bad('domain playbooks missing: ' + (miss.join(', ') || 'no domain-catalog')); }
    default: return bad('unknown verify type ' + JSON.stringify(ref.type));
  }
}
function verifyContext(opts) {
  const R = path.resolve((opts && opts.installRoot) || INSTALL_ROOT), orch = path.join(R, '.claude', 'config', 'orchestration'), tryJ = (p) => { try { return readJson(p); } catch { return null; } };
  const schema = tryJ(path.join(orch, 'FORGE_CONFIG_SCHEMA.json')), hard = tryJ(path.join(orch, 'FORGE_HARD_RULES.json')), reg = tryJ(path.join(R, '.claude', 'config', 'skills', 'global-skills.json'));
  const ruleIds = (f) => { const j = tryJ(path.join(orch, f)); return new Set(arr(j && j.rules).filter((r) => r && r.id).map((r) => r.id)); }, dt = tryJ(path.join(R, '.claude', 'config', 'forge-dev-tree.json')); // shipped rules vs this install's owner overlay, judged strictly only in the development tree (a synced project's overlay holds ITS owner's rules)
  const registry = new Set(); (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (isObj(v)) { if (typeof v.skill === 'string') registry.add(v.skill); Object.values(v).forEach(walk); } })(reg);
  let evidence = null; try { evidence = new Set([...fs.readFileSync(path.join(R, 'docs', 'audit', 'intelligence-evidence.md'), 'utf8').matchAll(/^\| (\d+) \|/gm)].map((m) => m[1])); } catch { evidence = null; }
  const dc = tryJ(path.join(orch, 'domain-catalog.json'));
  let gates = []; try { gates = req('forge-actiongate.cjs').KNOWN_GATES; } catch { gates = []; }
  return { root: R, home: homeDir(opts), schema, hardRules: new Set(arr(hard && hard.rules).map((r) => r && r.id)), gates: new Set(gates), locked: new Set(arr(schema && schema.locked).map((l) => l && l.id)),
    registry, rules: { shipped: ruleIds('FORGE_STANDING_RULES.json'), owner: ruleIds('FORGE_STANDING_RULES.user.json'), ownerPresent: exists(path.join(orch, 'FORGE_STANDING_RULES.user.json')) }, devTree: !!(dt && dt.dev_tree === true), evidence, playbooks: dc && isObj(dc.domains) ? Object.values(dc.domains).map((d) => d.playbook).filter(Boolean) : [] };
}
const available = (e, ctx) => arr(e.verify).filter((r) => isObj(r) && r.runtime).every((r) => verifyRef(r, ctx).ok);

// ---- plan ----
const pub = (e, lang, extra) => Object.assign({ id: e.id, kind: e.kind, label: e.label[lang] || e.label.en }, extra);
function announcement(res, s) {
  const L = TXT[res.lang] || TXT.en;
  if (!res.enabled) return L.off;
  const on = res.safe_to_enable.map((x) => x.label), wait = res.gated_queue.map((x) => x.label);
  const because = [];
  if (s.lanes >= 2) because.push(L.lanes(s.lanes));
  for (const k of ['web_ui', 'security', 'long_running', 'research']) if (s.flags[k] && because.length < 2) because.push(L[k]);
  if (!because.length && s.domain_known) because.push(L.domain(s.primary));
  const list = (xs, n) => xs.slice(0, n).join(', ') + (xs.length > n ? ' (+' + (xs.length - n) + ')' : '');
  const fmt = (o, w, b) => oneLine((on.length ? L.uses + list(on, o) + (b && because.length ? L.because + because.join(L.and) : '') + '.' : wait.length ? L.nothingOn : L.nothing) + (wait.length ? ' ' + L.waits + list(wait, w) + '.' : ''));
  // the longest line that fits, scored: up to 4 items turned on, up to 3 waiting and the reason first, then more items
  let best = null, bestScore = -1;
  for (const b of [true, false]) for (let w = wait.length; w >= Math.min(1, wait.length); w--) for (let o = on.length; o >= Math.min(1, on.length); o--) {
    const line = fmt(o, w, b), score = Math.min(o, 4) * 100 + Math.min(w, 3) * 60 + (b ? 120 : 0) + o + w;
    if (line.length <= MAX_LINE && score > bestScore) { best = line; bestScore = score; }
  }
  return best || fmt(1, 1, false).slice(0, MAX_LINE - 1) + '…';
}
function plan(text, opts) {
  opts = opts || {};
  const root = projectRoot(opts), catalog = opts.catalog || loadCatalog(opts.catalogPath), read = configReader(root), ctx = verifyContext(opts);
  if (!isObj(catalog) || !Array.isArray(catalog.entries)) throw new Error('the switch catalog has no entries list');
  const s = computeSignals(text, opts, catalog, read), lang = s.lang;
  const res = { ok: true, planned_only: true, enabled: read('anticipate', true).value !== false, lang,
    signals: { lanes: s.lanes, files: s.files, deliverable: s.deliverable, domains: s.domains, primary_domain: s.primary, flags: s.flags },
    matched: [], safe_to_enable: [], already_on: [], gated_queue: [], respected_off: [], skipped: [], skills_to_use: [], checks_to_run: [], tools_to_run: [], reasons: [] };
  if (!res.enabled) res.reasons.push('config anticipate is off: nothing planned'); // ANTICIPATE-KILLSWITCH
  for (const e of res.enabled ? catalog.entries : []) {
    if (!isObj(e) || !isObj(e.label) || !CLASSES.includes(e.class)) continue;
    const why = entryWhy(e, s);
    if (!why.length) continue;
    const st = stateOf(e, read), gated = e.class !== 'SAFE'; // ANTICIPATE-GATED-TEST
    res.matched.push(pub(e, lang, { class: e.class, why }));
    const how = String(e.how_to_enable).replace(/<domain>/g, s.primary || '<domain>');
    const enf = isObj(e.enforcement) ? { enforced: e.enforcement.status === 'mechanical', gap: e.enforcement.gap || null } : {};
    if (st.state === 'off-by-owner') { res.respected_off.push(pub(e, lang, { key: st.key, value: st.value, source: st.source })); res.reasons.push(e.id + ': you set ' + st.key + '=' + JSON.stringify(st.value) + ' (' + st.source + '); Forge respects it'); continue; }
    if (st.state === 'unknown') { res.skipped.push(pub(e, lang, { reason: 'setting ' + st.key + ' could not be read' })); continue; }
    if (gated) {
      if (st.state === 'on') { res.already_on.push(pub(e, lang, Object.assign({ gated: true, allowed_by: st.key + '=' + JSON.stringify(st.value) + ' (' + st.source + ')' }, enf))); res.reasons.push(e.id + ': OWNER-GATED, already allowed by your setting ' + st.key); }
      else { res.gated_queue.push(pub(e, lang, { class_reason: arr(e.class_reason), how_to_enable: how, why })); res.reasons.push(e.id + ': OWNER-GATED (' + arr(e.class_reason).join(', ') + '): queued for the owner, never turned on by Forge'); }
      continue;
    }
    if (!available(e, ctx)) { res.skipped.push(pub(e, lang, { reason: 'not installed on this machine' })); res.reasons.push(e.id + ': skipped, its mechanism is not installed here'); continue; }
    if (st.state === 'on') res.already_on.push(pub(e, lang, Object.assign({ gated: false }, st.key ? { allowed_by: st.key + '=' + JSON.stringify(st.value) + ' (' + st.source + ')' } : {}, enf)));
    else if (e.kind === 'config-key' && !SCOPES.slice(0, 2).includes(e.scope)) res.safe_to_enable.push(pub(e, lang, { scope: 'run', how_to_enable: 'forge-config --flag ' + e.config_key + '=' + JSON.stringify(e.on_values[0]) + ' (this run only, never written)', config_flag: { [e.config_key]: e.on_values[0] }, why }));
    else res.safe_to_enable.push(pub(e, lang, { scope: e.scope, how_to_enable: how, why }));
    res.reasons.push(e.id + ': ' + why[0]);
    const skills = e.id === 'domain-playbook' ? (s.playbooks && s.playbooks.length ? s.playbooks : [s.playbook]) : [e.skill]; // A1: every detected domain's playbook (a Windows game is electron + game)
    for (const skill of skills) if (skill && !res.skills_to_use.includes(skill)) res.skills_to_use.push(skill);
    if (e.kind === 'check') res.checks_to_run.push({ id: e.id, command: how });
    if (e.kind === 'tool' || e.kind === 'workflow') res.tools_to_run.push({ id: e.id, command: how });
  }
  res.announcement = announcement(res, s);
  res.switches = { v: 1, announcement: res.announcement, auto_enabled: res.safe_to_enable.map((x) => ({ id: x.id, label: x.label, kind: x.kind })),
    waits_for_owner: res.gated_queue.map((x) => ({ id: x.id, label: x.label, class_reason: x.class_reason })), already_on: res.already_on.map((x) => ({ id: x.id, label: x.label, enforced: x.enforced !== false })),
    respected_off: res.respected_off.map((x) => x.id) };
  return res;
}

// ---- validate: shape, mechanisms, and the conservative SAFE cross-check ----
function classifyText(text) { return req('forge-actiongate.cjs').classify(String(text), { projectRoot: INSTALL_ROOT }); } // ANTICIPATE-CLASSIFIER-CALL
function riskSignals(e, schema) {
  const out = [], how = String(e && e.how_to_enable || '');
  const r = classifyText(how);
  if (r && r.gate) out.push({ source: 'actiongate', reason: r.id, detail: r.reason || r.id });
  const spec = e && e.config_key && schema && isObj(schema.settings) ? schema.settings[e.config_key] : null;
  if (spec && arr(spec.flags).length) out.push({ source: 'schema-flags', reason: [...new Set(spec.flags.map((f) => FLAG_REASON[f] || 'outbound'))].join('+'), detail: spec.flags.join('') });
  for (const [reason, re] of RISK_WORDS) { const m = re.exec(how); if (m) out.push({ source: 'lexicon', reason, detail: m[0] }); } // ANTICIPATE-LEXICON
  return out;
}
const bi = (v, max) => isObj(v) && ['en', 'nl'].every((l) => typeof v[l] === 'string' && v[l].trim() && (!max || v[l].length <= max) && !/[\r\n]/.test(v[l]));
const kwList = (v) => isObj(v) && ['en', 'nl'].every((l) => Array.isArray(v[l]) && v[l].length && v[l].every((x) => typeof x === 'string' && x.trim()));
function checkTrigger(tr, sigNames, at, P) {
  if (!isObj(tr) || !Object.keys(tr).length) return P(at + ' must be a non-empty object');
  for (const [k, v] of Object.entries(tr)) {
    if (!TRIGGER_KEYS.includes(k)) P(at + ': unknown trigger key "' + k + '"');
    else if (k === 'keywords' && !kwList(v)) P(at + '.keywords needs non-empty "en" AND "nl" lists');
    else if (k === 'keywords') both(v).map(kwProblem).filter(Boolean).forEach((p) => P(at + ': ' + p));
    else if (k === 'signals_any' && !(Array.isArray(v) && v.length && v.every((x) => sigNames.includes(x)))) P(at + '.signals_any must name catalog signals (' + sigNames.join(', ') + ')');
    else if ((k === 'min_lanes' || k === 'min_files') && !(Number.isInteger(v) && v >= 1)) P(at + '.' + k + ' must be an integer >= 1');
    else if ((k === 'always' || k === 'domain_known') && v !== true) P(at + '.' + k + ' must be true');
    else if ((k === 'domains_any' || k === 'deliverables_any') && !(Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x))) P(at + '.' + k + ' must be a non-empty string list');
  }
}
function validateCatalog(cat, opts) {
  const problems = [], warnings = [], P = (m) => problems.push(m), ctx = verifyContext(opts), counts = { entries: 0, SAFE: 0, 'OWNER-GATED': 0, kinds: {} };
  if (!isObj(cat) || cat.version !== 1 || !Array.isArray(cat.entries) || !cat.entries.length) return { ok: false, problems: ['the catalog must be {version: 1, signals, entries: [...]} with at least one entry'], warnings, counts, verified: 0 };
  if (!ctx.schema) P('FORGE_CONFIG_SCHEMA.json is unreadable, so config keys cannot be checked');
  const sigs = isObj(cat.signals) ? cat.signals : {}, sigNames = Object.keys(sigs), ids = new Set();
  for (const [n, s] of Object.entries(sigs)) {
    if (!isObj(s) || !(isObj(s.keywords) && ['en', 'nl'].every((l) => Array.isArray(s.keywords[l]) && s.keywords[l].length))) P('signal ' + n + ' needs keywords with "en" AND "nl" lists');
    if (s && s.min_lanes !== undefined && !(Number.isInteger(s.min_lanes) && s.min_lanes >= 1)) P('signal ' + n + '.min_lanes must be an integer >= 1');
    if (s && s.exclude !== undefined && !kwList(s.exclude)) P('signal ' + n + '.exclude needs non-empty "en" AND "nl" phrase lists');
    if (s && s.together !== undefined && !(Array.isArray(s.together) && s.together.length && s.together.every((p) => isObj(p) && kwList(p.a) && kwList(p.b)))) P('signal ' + n + '.together must be [{a: {en, nl}, b: {en, nl}}]');
    if (isObj(s)) [s.keywords, s.exclude].concat(arr(s.together).flatMap((p) => [p && p.a, p && p.b])).flatMap(both).map(kwProblem).filter(Boolean).forEach((p) => P('signal ' + n + ': ' + p));
  }
  let verified = 0;
  cat.entries.forEach((e, i) => {
    const at = 'entry ' + (isObj(e) && e.id ? e.id : '#' + i);
    if (!isObj(e)) return P(at + ' must be an object');
    counts.entries++;
    if (!/^[a-z][a-z0-9-]*$/.test(String(e.id))) P(at + ': id must be a slug'); else if (ids.has(e.id)) P(at + ': id is used twice'); else ids.add(e.id);
    if (!KINDS.includes(e.kind)) P(at + ': kind must be one of ' + KINDS.join('|')); else counts.kinds[e.kind] = (counts.kinds[e.kind] || 0) + 1;
    if (!bi(e.label, 40)) P(at + ': label needs short one-line en + nl (<= 40 chars)');
    if (!bi(e.announce)) P(at + ': announce needs one-line en + nl');
    if (typeof e.how_to_enable !== 'string' || e.how_to_enable.trim().length < 8 || /[\r\n]/.test(e.how_to_enable)) P(at + ': how_to_enable must be the exact command or mechanism on one line');
    if (!SCOPES.includes(e.scope)) P(at + ': scope must be run|session|project');
    if (typeof e.reversible !== 'boolean') P(at + ': reversible must be true or false');
    if (typeof e.revert !== 'string' || !e.revert.trim()) P(at + ': revert must say how to undo it');
    if (typeof e.evidence !== 'string' || !e.evidence.trim()) P(at + ': evidence must point at its source');
    if (e.evidence_class !== undefined && !EVIDENCE_CLASSES.includes(e.evidence_class)) P(at + ': evidence_class must be one of ' + EVIDENCE_CLASSES.join('|'));
    const reasons = arr(e.class_reason);
    if (!CLASSES.includes(e.class)) P(at + ': class must be SAFE or OWNER-GATED'); else counts[e.class]++;
    if (!reasons.length || !reasons.every((r) => REASONS.includes(r))) P(at + ': class_reason must list ' + REASONS.join('|'));
    if (e.class === 'SAFE' && (reasons.length !== 1 || reasons[0] !== 'none')) P(at + ': a SAFE entry has class_reason ["none"]; any cost/outbound/credentials/destructive/production reason makes it OWNER-GATED');
    if (e.class === 'SAFE' && e.reversible !== true) P(at + ': a SAFE entry must be reversible');
    if (e.class === 'OWNER-GATED' && reasons.includes('none')) P(at + ': an OWNER-GATED entry needs a real reason, not "none"');
    if (!STATES.includes(e.default_state)) P(at + ': default_state must be on|off|config');
    if (e.kind === 'config-key' && e.default_state !== 'config') P(at + ': a config-key entry reads its state live (default_state "config")');
    if (e.default_state === 'config' && !(ctx.schema && ctx.schema.settings[e.config_key] && Array.isArray(e.on_values) && e.on_values.length)) P(at + ': default_state config needs a real config_key and on_values');
    if (e.requires_config !== undefined && !(isObj(e.requires_config) && ctx.schema && ctx.schema.settings[e.requires_config.key] && Array.isArray(e.requires_config.on_values) && e.requires_config.on_values.length)) P(at + ': requires_config needs a real key and on_values');
    if (!Array.isArray(e.triggers) || !e.triggers.length) P(at + ': triggers must be a non-empty list'); else e.triggers.forEach((tr, j) => checkTrigger(tr, sigNames, at + ' trigger ' + j, P));
    if (e.enforcement !== undefined) {
      const en = e.enforcement;
      if (!isObj(en) || !ENFORCE.includes(en.status) || !Array.isArray(en.by) || !en.by.length) P(at + ': enforcement needs status ' + ENFORCE.join('|') + ' and a "by" list');
      else { if (en.status !== 'mechanical' && !(typeof en.gap === 'string' && en.gap.trim())) P(at + ': enforcement that is not mechanical must name its gap'); for (const b of en.by) { const f = String(b).split(' (')[0]; if (!exists(path.join(ctx.root, f))) P(at + ': enforcement file ' + f + ' does not exist'); } }
    }
    if (!Array.isArray(e.verify) || !e.verify.length) P(at + ': verify must name at least one real mechanism'); else if (e.verify.some((r) => isObj(r) && r.type === 'owner-rule')) P(at + ': an owner-rule ref is evidence only (evidence_ref), never a verify mechanism: the owner overlay never ships');
    for (const ref of arr(e.verify).concat(arr(e.evidence_ref))) {
      if (!isObj(ref) || !VERIFY_TYPES.includes(ref.type)) { P(at + ': unknown verify/evidence type ' + JSON.stringify(ref && ref.type)); continue; }
      const v = verifyRef(ref, ctx);
      if (v.ok) verified++; else if (v.warn) warnings.push(at + ': ' + v.warn); else P(at + ': ' + v.problem);
    }
    if (e.class === 'SAFE') for (const r of riskSignals(e, ctx.schema)) P(at + ': SAFE but ' + (r.source === 'actiongate' ? 'the hard-gate classifier (forge-actiongate) flags it as ' + r.reason : r.source === 'schema-flags' ? 'its config key carries disclosure flags ' + r.detail + ' (' + r.reason + ')' : 'its how_to_enable uses the ' + r.reason + ' word "' + r.detail + '"') + ': classify it OWNER-GATED');
  });
  return { ok: !problems.length, problems, warnings, counts, verified };
}

// ---- apply / revert (run overlay; nothing persistent changes) ----
const FP = (() => { try { const m = req('forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.existingStateDirs === 'function' ? m : null; } catch { return null; } })(); // runDir (WP 2.9c): the run folder by forge-paths (.forge/runs in a .forge project, else .claude/forge-runs); a run already in the other layout's folder (partial migration) is used where it is; no forge-paths = legacy unless the project opted into .forge
function runDir(runId, opts) { if (!RUN_ID_RE.test(String(runId || ''))) return { error: '--run id may only hold A-Z a-z 0-9 _ -' }; const root = projectRoot(opts), rel = (d) => path.relative(root, d).split(path.sep).join('/'); let active = path.join(root, '.claude', 'forge-runs'), dirs = [active];
  if (FP) { try { active = FP.stateDir(root, 'runs'); dirs = [active].concat(FP.existingStateDirs(root, 'runs').filter((d) => path.relative(d, active) !== '')); } catch (e) { return { error: 'the run folder could not be resolved (' + oneLine(e && e.message).slice(0, 160) + '): nothing was written' }; } } else if (process.env.FORGE_STATE_DIR || exists(path.join(root, '.forge'))) return { error: 'forge-paths.cjs is missing next to this tool, so the .forge run folder cannot be found: nothing was written' };
  const hit = dirs.map((d) => path.join(d, runId)).find((d) => exists(d)); return hit ? { dir: hit, rel: rel(hit) } : { error: 'run folder ' + rel(path.join(active, runId)) + ' does not exist: nothing was written' }; }
/** deliverableTypes(text, res, opts) -> {types, from[{type, from}], scope} (WP 2.9c) in the craft lens vocabulary the run contract reads: an explicit --type that names a lens, the lenses forge-craft selectTypes picks (domain + request words; generic = safety net) and web-ui when the web_ui signal fired. A META mission (A2: --scope meta, or a request that installs/tests Forge in separate project folders, see forge-anticipate-scope.cjs) declares one tooling type instead, because its projects run in their own folders and runs. Never throws. */ function deliverableTypes(text, res, opts) { let S = null; try { S = req('forge-anticipate-scope.cjs'); } catch { S = null; } const p = projectTypes(text, res, opts), sc = S ? S.scopeOf(text, opts) : { scope: 'project' }; if (sc.scope !== 'meta') return Object.assign(p, { scope: 'project' }); const pr = projectRoot(opts); let lt = []; try { lt = req('forge-craft.cjs').lensTypes(exists(path.join(pr, '.claude', 'config', 'quality', 'lenses')) ? pr : INSTALL_ROOT); } catch { lt = []; } return Object.assign(S.metaTypes(opts, lt, p.types, sc), { scope: 'meta' }); }
function projectTypes(text, res, opts) { const out = [], from = [], add = (t, why) => { if (t && !out.includes(t)) { out.push(t); from.push({ type: t, from: why }); } }, sig = res.signals || {}, pr = projectRoot(opts), lensRoot = exists(path.join(pr, '.claude', 'config', 'quality', 'lenses')) ? pr : INSTALL_ROOT; let C = null; try { C = req('forge-craft.cjs'); } catch { C = null; }
  try { if (sig.deliverable && C && C.lensTypes(lensRoot).includes(sig.deliverable)) add(sig.deliverable, '--type'); for (const dom of [...new Set([sig.primary_domain || ''].concat(arr(sig.domains)))]) for (const s of arr(C ? C.selectTypes(lensRoot, { domain: dom, text }).selection : [])) add(s.type, 'forge-craft selectTypes: ' + s.from); } catch (e) { from.push({ type: null, from: 'forge-craft selectTypes failed: ' + oneLine(e && e.message).slice(0, 120) }); } if (!C) from.push({ type: null, from: 'forge-craft.cjs is not available: signals only' }); if (sig.flags && sig.flags.web_ui) add('web-ui', 'signal web_ui (' + sig.flags.web_ui + ')'); return { types: out, from }; }
function writeAtomic(file, obj) { const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, file); }
function logNote(runId, opts, note, evidence) {
  const le = path.join(projectRoot(opts), '.claude', 'forge-dashboard', 'log-event.cjs');
  if (!exists(le)) return 'log-event.cjs not found: the overlay is saved, not logged';
  const r = spawnSync(process.execPath, [le, runId, 'agent_note', JSON.stringify({ agent: 'orchestrator', role: 'lead', runtime: 'internal', note, evidence })], { encoding: 'utf8' });
  return r.status === 0 ? null : 'log-event warning (the overlay is saved): ' + oneLine(r.stderr || r.stdout || 'exit ' + r.status).slice(0, 200);
}
function applyRun(runId, opts) {
  opts = opts || {};
  const rd = runDir(runId, opts); if (rd.error) return { code: 2, message: rd.error };
  if (configReader(projectRoot(opts))('anticipate', true).value === false) return { code: 0, wrote: false, message: TXT.en.off + ' Nothing was written.' };
  const tryJ = (f) => { try { return readJson(path.join(rd.dir, f)); } catch { return null; } };
  const run = tryJ('run.json'), card = tryJ('plan-card.json');
  const text = opts.text || (run && typeof run.request === 'string' ? run.request : '');
  if (!oneLine(text)) return { code: 2, message: 'no task text: pass --text or give run.json a "request"' };
  const lanes = intOpt(opts.lanes) || (card && card.lanes && intOpt(card.lanes.expected)) || 0;
  const res = plan(text, Object.assign({}, opts, { lanes }));
  const applied = res.safe_to_enable.filter((x) => x.scope === 'run' || x.scope === 'session');
  const cat = opts.catalog || loadCatalog(opts.catalogPath), byId = Object.fromEntries(cat.entries.map((e) => [e.id, e]));
  const flags = Object.assign({}, ...applied.map((x) => x.config_flag || {}));
  const dt = deliverableTypes(text, res, opts); // WP 2.9c: the run shape (craft-review-recorded) reads the visible ones
  const overlay = { v: 1, tool: 'forge-anticipate.cjs', run_id: runId, status: 'applied', planned_only: false, lang: res.lang,
    input: { text_sha256: crypto.createHash('sha256').update(text).digest('hex'), lanes: res.signals.lanes, type: res.signals.deliverable, files: res.signals.files, scope: dt.scope },
    deliverable_types: dt.types, deliverable_types_from: dt.from,
    announcement: res.announcement, active: applied.map((x) => x.id),
    applied: applied.map((x) => ({ id: x.id, kind: x.kind, scope: x.scope, mechanism: x.config_flag ? 'forge-config --flag (per run, never written)' : 'run-overlay', lead_action: x.how_to_enable.replace(/<run_id>/g, runId), revert: byId[x.id] ? byId[x.id].revert : 'drop it' })),
    config_flags: flags, waits_for_owner: res.gated_queue.map((x) => ({ id: x.id, class_reason: x.class_reason, how_to_enable: x.how_to_enable })),
    already_on: res.already_on.map((x) => x.id), respected_off: res.respected_off.map((x) => x.id), ...(dt.scope === 'meta' ? { skills_to_use: [], skills_withheld_meta: res.skills_to_use } : { skills_to_use: res.skills_to_use }), checks_to_run: res.checks_to_run, // A2b: a meta run hands no project skills to the SK6 fallback
    never_changed: ['.claude/FORGE_CONFIG.json', '~/.claude/FORGE_CONFIG.json', 'settings.json'], revert: 'node .claude/forge-bin/forge-anticipate.cjs revert --run ' + runId };
  writeAtomic(path.join(rd.dir, 'anticipate.json'), overlay);
  const warn = logNote(runId, opts, 'anticipation applied: ' + applied.length + ' safe item(s) for this run, ' + res.gated_queue.length + ' waiting for the owner · ' + res.announcement, rd.rel + '/anticipate.json');
  return { code: 0, wrote: true, overlay, file: rd.rel + '/anticipate.json', warning: warn, message: res.announcement };
}
function revertRun(runId, opts) {
  const rd = runDir(runId, opts); if (rd.error) return { code: 2, message: rd.error };
  const file = path.join(rd.dir, 'anticipate.json');
  if (!exists(file)) return { code: 0, message: 'nothing to revert: no anticipate.json in ' + rd.rel };
  let o; try { o = readJson(file); } catch (e) { return { code: 2, message: rd.rel + '/anticipate.json is damaged (' + e.message + '): nothing changed' }; }
  if (o.status === 'reverted') return { code: 0, message: 'already reverted: ' + rd.rel + '/anticipate.json' };
  const out = Object.assign({}, o, { status: 'reverted', reverted: arr(o.active), active: [], reverted_config_flags: o.config_flags || {}, config_flags: {} });
  writeAtomic(file, out);
  const warn = logNote(runId, opts, 'anticipation reverted: ' + out.reverted.length + ' run item(s) no longer active', rd.rel + '/anticipate.json');
  return { code: 0, overlay: out, warning: warn, message: 'reverted ' + out.reverted.length + ' item(s); the Lead stops each one (see "revert" per item)' };
}

// ---- metric (read-only) ----
const NOT_YET = 'metric not yet available: this scribe ledger holds no judged owner record yet (since WP I.8c forge-scribe.cjs tags every new owner prompt; older records: forge-scribe.cjs retag --toggle-correction --apply)';
function metric(opts) {
  opts = opts || {};
  const file = path.join(projectRoot(opts), '.claude', 'forge-scribe', 'ledger.jsonl');
  const since = opts.since ? Date.parse(opts.since) : null;
  if (opts.since && !Number.isFinite(since)) return { code: 2, message: '--since must be a date (YYYY-MM-DD)' };
  let lines; try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return { code: 0, available: false, message: NOT_YET, reason: 'no scribe ledger found' }; }
  let records = 0, malformed = 0, tagged = false; const hits = new Map();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let r; try { r = JSON.parse(ln); } catch { malformed++; continue; }
    if (!isObj(r)) { malformed++; continue; }
    records++; if (Array.isArray(r.tags)) tagged = true;
    if (!(r.class === 'toggle-correction' || (Array.isArray(r.tags) && r.tags.includes('toggle-correction')))) continue;
    const ts = Date.parse(r.item_ts || r.ts); if (since !== null && !(ts >= since)) continue; // a back-filled tag op dates by its item
    const key = r.rid || 'seq-' + r.seq; if (!hits.has(key)) hits.set(key, { rid: r.rid || null, run_id: r.run_id || 'unknown', ts: r.ts || null });
  }
  if (!hits.size && !tagged) return { code: 0, available: false, message: NOT_YET, records, malformed };
  const per = {}; for (const h of hits.values()) per[h.run_id] = (per[h.run_id] || 0) + 1;
  return { code: 0, available: true, total: hits.size, per_mission: per, since: opts.since || null, records, malformed, message: hits.size + ' owner toggle correction(s) across ' + Object.keys(per).length + ' mission(s)' };
}

// ---- CLI ----
const USAGE = 'Usage: node forge-anticipate.cjs plan --text "<task>" [--lanes N] [--type <deliverable>] [--files N] [--lang en|nl] [--json]\n'
  + '       node forge-anticipate.cjs apply --run <run_id> [--text "<task>"] [--lanes N] [--type T] [--scope meta|project] [--json] | revert --run <run_id> [--json]\n'
  + '       node forge-anticipate.cjs explain <id> [--json] | metric [--since <date>] [--json] | validate [--json]   (all: [--root <dir>] [--catalog <file>])';
const VALUE_FLAGS = ['--text', '--lanes', '--type', '--scope', '--files', '--lang', '--run', '--root', '--since', '--catalog'];
function parseArgs(argv) {
  const o = { cmd: argv[0], pos: [], json: false }, errors = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (VALUE_FLAGS.includes(a)) { if (argv[i + 1] === undefined) errors.push(a + ' needs a value'); else o[a.slice(2)] = argv[++i]; }
    else if (a.startsWith('--')) errors.push('unknown argument ' + a);
    else o.pos.push(a);
  }
  return { o, errors };
}
const optsOf = (o) => ({ root: o.root, catalogPath: o.catalog, lanes: o.lanes, type: o.type, scope: o.scope, files: o.files, lang: o.lang, text: o.text, since: o.since });
function printPlan(res) {
  const ids = (xs) => xs.map((x) => x.id).join(', ') || '-';
  console.log(res.announcement);
  console.log('  auto (SAFE): ' + ids(res.safe_to_enable) + '\n  already on: ' + ids(res.already_on) + '\n  waits for owner: ' + ids(res.gated_queue)
    + (res.respected_off.length ? '\n  respected (you turned off): ' + ids(res.respected_off) : '') + '\n  skills: ' + (res.skills_to_use.join(', ') || '-') + '\n  checks: ' + ids(res.checks_to_run) + '\n  (plan only: nothing was changed)');
}
function main(argv) {
  const { o, errors } = parseArgs(argv);
  if (o.cmd === 'plan') {
    try {
      if (errors.length) throw new Error(errors.join('; '));
      if (!oneLine(o.text)) throw new Error('plan needs --text "<task>"');
      const res = plan(o.text, optsOf(o));
      if (o.json) console.log(JSON.stringify(res)); else printPlan(res);
    } catch (e) {
      console.error('forge-anticipate: ' + oneLine(e && e.message ? e.message : e).slice(0, 300) + ' (nothing changed)');
      if (o.json) console.log(JSON.stringify({ ok: false, planned_only: true, error: oneLine(e && e.message).slice(0, 300), switches: { v: 1, announcement: '', auto_enabled: [], waits_for_owner: [], already_on: [], respected_off: [] } }));
    }
    return 0;
  }
  if (o.scope !== undefined && !['meta', 'project'].includes(String(o.scope).trim().toLowerCase())) errors.push('--scope must be meta or project'); if (!['apply', 'revert', 'explain', 'metric', 'validate'].includes(o.cmd) || errors.length) { errors.forEach((e) => console.error('forge-anticipate: ' + e)); console.error(USAGE); return 2; }
  const opts = optsOf(o), say = (r) => { if (o.json) console.log(JSON.stringify(r)); else { console.log(r.message); if (r.warning) console.error('forge-anticipate: ' + r.warning); } return r.code; };
  if (o.cmd === 'apply' || o.cmd === 'revert') { if (!o.run) { console.error('forge-anticipate: ' + o.cmd + ' needs --run <run_id>'); return 2; } return say((o.cmd === 'apply' ? applyRun : revertRun)(o.run, opts)); }
  if (o.cmd === 'metric') return say(metric(opts));
  let cat; try { cat = loadCatalog(opts.catalogPath); } catch (e) { console.error('forge-anticipate: the switch catalog is unreadable: ' + e.message); return o.cmd === 'validate' ? 3 : 1; }
  if (o.cmd === 'validate') {
    const v = validateCatalog(cat, opts);
    if (o.json) console.log(JSON.stringify(v));
    else console.log(v.ok ? 'switch catalog valid: ' + v.counts.entries + ' entries (' + v.counts.SAFE + ' SAFE, ' + v.counts['OWNER-GATED'] + ' OWNER-GATED), ' + v.verified + ' mechanism/evidence refs opened' + (v.warnings.length ? '\n  notes:\n  - ' + v.warnings.join('\n  - ') : '')
      : 'switch catalog INVALID (' + v.problems.length + '):\n  - ' + v.problems.join('\n  - '));
    return v.ok ? 0 : 3;
  }
  const e = arr(cat.entries).find((x) => x && x.id === o.pos[0]);
  if (!e) { console.error('forge-anticipate: unknown id ' + JSON.stringify(o.pos[0] || '') + '; known: ' + arr(cat.entries).map((x) => x && x.id).join(', ')); return 1; }
  const st = stateOf(e, configReader(projectRoot(opts)));
  if (o.json) { console.log(JSON.stringify(Object.assign({}, e, { live_state: st }))); return 0; }
  console.log(e.id + ' — ' + e.label.en + ' (' + e.kind + ', ' + e.class + (e.class === 'SAFE' ? '' : ': ' + arr(e.class_reason).join(', ')) + ')\n  ' + e.announce.en + '\n  how: ' + e.how_to_enable + '\n  scope: ' + e.scope + ' · reversible: ' + e.reversible + ' · undo: ' + e.revert
    + '\n  state now: ' + st.state + (st.key ? ' (' + st.key + '=' + JSON.stringify(st.value) + ', ' + st.source + ')' : '') + '\n  evidence: ' + e.evidence + (e.enforcement ? '\n  enforcement: ' + e.enforcement.status + (e.enforcement.gap ? ' — gap: ' + e.enforcement.gap : '') : '') + (e.caveat ? '\n  caveat: ' + e.caveat.en : ''));
  return 0;
}

module.exports = { plan, validateCatalog, riskSignals, computeSignals, applyRun, revertRun, metric, loadCatalog, verifyContext, verifyRef, main, kwMatch, parseLanes, deliverableTypes, MAX_LINE, CATALOG_DEFAULT, NOT_YET };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('forge-anticipate: ' + oneLine(e && e.stack ? e.stack : e).slice(0, 400)); process.exitCode = process.argv[2] === 'plan' ? 0 : 1; }
}
