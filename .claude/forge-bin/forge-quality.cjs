#!/usr/bin/env node
'use strict';
/**
 * forge-quality.cjs — de Forge Quality Intelligence Layer (masterprompt 2026-08-11). Zero-dependency.
 *
 * PROBLEEM dat dit oplost (gemeten, niet aangenomen): missies gingen als vrije tekst de router in en
 * werden op de LETTERLIJKE opdracht gebouwd. Vergeten eisen (thank-you-state, robots.txt, duplicate
 * submit, consent) bleven vergeten omdat niets er ooit naar vroeg; kwaliteitsdimensies werden stil
 * overgeslagen in plaats van gemotiveerd afgewezen; en vier seams droegen vier verschillende
 * domeinlijsten (router 23 · evidence 26 · intake 11 incl. 'dashboard' · presets 7) zonder dat iets
 * die drift zag.
 *
 * MODEL — één keten:
 *   missie → compileMissionProfile() (multi-label, machineleesbaar)
 *         → evaluateLenses()        (10 universele lenzen, elk EXACT één disposition + reden)
 *         → mineOmissions()         (vijf assen: lifecycle/states/roles/operations/trust-boundaries)
 *         → validateRequirementCard() (een RESEARCH_HYPOTHESIS wordt nooit stil een harde eis)
 *   plus: loadCatalog()/catalogDrift() (de ENE domeincatalogus, drift per seam zichtbaar),
 *         qualityKernel()/buildMissionPack()/selectKnowledgeCards() (contextcompiler: kleine kern,
 *         begrensd missiepak, kaarten on-demand),
 *         councilTrigger()/validateCouncilRecord() (LLM Council: selectief, nooit op simpele taken,
 *         en een record zonder echte dispatch-provenance valideert niet — labels bewijzen niets,
 *         dezelfde les als F-02).
 *
 * PROVENANCE (F-13/F-24): het council-patroon (5 adviseurs -> anonieme peer review -> chairman) is
 * als CONCEPT bestudeerd uit zeero/dotfiles home/.claude/skills/llm-council/SKILL.md — GEPINDE
 * upstream-commit 604a11ddb4dae8a650dbed09e3d1e11e36eb40e3 (2026-06-01, laatste commit die dat pad
 * raakte; GEEN licentie = copyright-by-default) — en karpathy/llm-council (licentie onbevestigd).
 * Claimscope (F-24, eerlijk begrensd): bij handmatige vergelijking op 2026-08-12/13 is GEEN
 * materiële overlap aangetroffen — deze module deelt alleen het abstracte concept (rollen,
 * anonieme peer review, synthese), geen zinnen, structuur of code. Dit is een menselijke
 * vergelijking, geen reproduceerbare diff-scan; de geraadpleegde raw-URL + pin staan in de
 * research-source-ledger van.
 *
 * Dispositions zijn een GESLOTEN vocabulaire: RELEVANT · NOT_APPLICABLE · DEFERRED · OWNER_GATED.
 * Elke disposition draagt een reden — stil overslaan is precies de fout die deze laag bestrijdt.
 *
 * EIGENAARSINSTELLING `council` (forge-config.cjs, standaard auto): `off` -> councilTrigger()
 * geeft mode NONE met reason 'owner config council=off' — BEHALVE als de invoer explicit_request:true
 * draagt: een expliciete "council"-vraag van nu wint van een opgeslagen instelling. Gelezen voor de root
 * waarop de analyse draait (opts.projectRoot; FORGE_PROJECT_ROOT, de eigen seam van de resolver, wint als
 * die gezet is). forge-config.cjs is soft-required en wordt via de fail-safe safeGet() gelezen: afwezig, een
 * throw of een beschadigd instellingenbestand -> de schema-default (auto; geen datavlag) plus een `config_note`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// WP 2.1 (forge-paths): SCRIPT_ROOT = this copy's project (an installed .claude/forge-bin copy keeps its own project
// exactly as before; a plugin copy discovers it from the cwd, null when there is none). Reads of shipped config keep
// a default (CONFIG_ROOT, the old two-folders-up answer when no project is found); every WRITE needs SCRIPT_ROOT or
// an explicit root and is refused otherwise, never beside the script. Guarded: a missing or older forge-paths.cjs
// keeps the old answer. Run folders follow the project's layout (runDirOf).
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
const SCRIPT_ROOT = forgePaths ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..');
const CONFIG_ROOT = SCRIPT_ROOT || path.resolve(__dirname, '..', '..');
function statePath(root, key, read) {
  const legacy = path.join(root, '.claude', 'forge-' + key);
  if (!forgePaths) return legacy;
  try { return forgePaths.layout(root) !== 'forge' ? legacy : (read ? forgePaths.resolveExisting(root, key) : forgePaths.stateDir(root, key)); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return legacy; }
}
/** runDirOf(root, id) -> the run's folder: the active runs folder, or the legacy one when the run only exists there. */
function runDirOf(root, id) {
  const active = path.join(statePath(root, 'runs'), id), legacy = path.join(root, '.claude', 'forge-runs', id);
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}

// Eigenaarsinstellingen (forge-config.cjs) — soft-required, zie de header.
const COUNCIL_OFF_REASON = 'owner config council=off';
let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on). `fallback` is this file's copy of
 *  the schema default, used only when forge-config.cjs is absent or broken; an older copy without safeGet is read
 *  through get(). Never throws. opts.projectRoot = the root this tool acts on (ignored when FORGE_PROJECT_ROOT is
 *  set); opts.configModule injects a module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : cfg;
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}
/** configOn(key, def, opts) -> just the value of configRead(). */
function configOn(key, def, opts) { return configRead(key, def, opts).value; }

const DISPOSITIES = new Set(['RELEVANT', 'NOT_APPLICABLE', 'DEFERRED', 'OWNER_GATED']);
const SOURCE_TYPES = new Set(['EXPLICIT', 'INFERRED_FROM_LOCAL_EVIDENCE', 'INFERRED_FROM_STANDARD', 'RESEARCH_HYPOTHESIS', 'OPTIONAL', 'OWNER_GATED']);
const PRIORITEITEN = new Set(['P0', 'P1', 'P2', 'P3']);
/** primary-volgorde: het meest specifieke bouwdomein wint van generieke (api/integration/cli). Sinds WP I.8a ALLEEN
 *  nog de terugval van compileMissionProfile wanneer forge-domain-discovery.cjs niet laadbaar is (domain_evidence.source
 *  zegt dat dan); normaal komt de primary uit de gedeelde scorer. Blijft geëxporteerd voor bestaande aanroepers. */
const PRIMARY_VOLGORDE = ['ecommerce', 'website', 'fullstack', 'n8n', 'rag', 'agent', 'voice', 'prediction', 'mobile', 'electron', 'game', 'extension', 'cms', 'figma', 'migration', 'mlops', 'data', 'scraping', 'payments', 'bots', 'api', 'integration', 'cli'];

function loadCatalog(root) {
  const p = path.join(root, '.claude', 'config', 'orchestration', 'domain-catalog.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!j || typeof j.domains !== 'object' || !Object.keys(j.domains).length) throw new Error('forge-quality: domain-catalog.json mist een niet-lege domains-map');
  return j;
}

/** catalogDrift — legt de WERKELIJKHEID van elke seam naast de catalogus-verwachting.
 *  Elke afwijking wordt gerapporteerd; bekende gaps (known_gaps) blijven zichtbaar als tracked. */
function catalogDrift(root) {
  const cat = loadCatalog(root);
  const domeinen = Object.keys(cat.domains);
  const seams = [];
  const bekend = cat.known_gaps || {};

  // seam 1: router-playbooks (skills-map op schijf)
  let skillDirs = [];
  try { skillDirs = fs.readdirSync(path.join(root, '.claude', 'skills')).filter((d) => d.startsWith('forge-')); } catch { }
  /** F-05: extra_in_seam was hardcoded leeg en het catalogusveld `playbook` werd nooit gebruikt —
   *  twee false-negatives. Nu: elk catalogusdomein moet zijn EIGEN playbook-map hebben, en elke
   *  forge-*-skill die geen domein-playbook en geen gedeclareerde non-domain-skill is, is drift
   *  (dwingt een catalogusbeslissing af bij elke nieuwe skill). */
  const verwachtePlaybooks = domeinen.map((d) => cat.domains[d].playbook).filter(Boolean);
  const nonDomain = new Set(cat.non_domain_skills || []);
  seams.push({
    seam: 'router-playbooks',
    missing_in_seam: domeinen.filter((d) => !skillDirs.includes(cat.domains[d].playbook)),
    extra_in_seam: skillDirs.filter((sk) => !verwachtePlaybooks.includes(sk) && !nonDomain.has(sk)),
  });

  // seam 2: required-evidence.json
  let evDomeinen = [];
  try { evDomeinen = Object.keys(require(path.join(root, '.claude', 'config', 'orchestration', 'required-evidence.json')).domains || {}); } catch { }
  const evBekend = Object.keys((bekend.evidence_domain_without_playbook) || {});
  seams.push({
    seam: 'required-evidence',
    missing_in_seam: domeinen.filter((d) => !evDomeinen.includes(d)),
    extra_in_seam: evDomeinen.filter((d) => !domeinen.includes(d) && !evBekend.includes(d)),
    tracked_gaps: evDomeinen.filter((d) => evBekend.includes(d)),
  });

  // seam 3: intake-packs (question-bank byType)
  let packs = [];
  try { packs = Object.keys(require(path.join(root, '.claude', 'config', 'intake', 'question-bank.json')).byType || {}); } catch { }
  const packBekend = Object.keys((bekend.intake_pack_without_domain) || {});
  seams.push({
    seam: 'intake-packs',
    // een domein ZONDER pack is geen fout (universal fallback) — maar de catalogus verklaart welke
    // domeinen een eigen pack HOREN te hebben; ontbreekt die, dan is dat drift.
    missing_in_seam: domeinen.filter((d) => cat.domains[d].intake_pack && !packs.includes(cat.domains[d].intake_pack)),
    extra_in_seam: packs.filter((p2) => !domeinen.some((d) => cat.domains[d].intake_pack === p2) && !packBekend.includes(p2)),
    tracked_gaps: packs.filter((p2) => packBekend.includes(p2)).map((p2) => ({ pack: p2, note: bekend.intake_pack_without_domain[p2] })),
  });

  // seam 4: domain-presets
  let presets = [];
  try { const dp = require(path.join(root, '.claude', 'config', 'orchestration', 'domain-presets.json')); presets = Object.keys(dp.domains || dp); } catch { }
  seams.push({
    seam: 'domain-presets',
    missing_in_seam: domeinen.filter((d) => cat.domains[d].preset === true && !presets.includes(d)),
    extra_in_seam: presets.filter((d) => !domeinen.includes(d)),
    not_expected: domeinen.filter((d) => cat.domains[d].preset !== true && presets.includes(d)),
  });

  /** F-16 (Codex herreview): staleness volgt de INVARIANT van de gap, niet alleen het seam-item.
   *  'intake kent dashboard zonder domein' is óók stale wanneer dashboard inmiddels WEL een
   *  catalogusdomein is — de gap-notitie beschrijft dan een opgeloste werkelijkheid en moet worden
   *  opgeruimd, anders noemt de doctor een verouderde verklaring driftvrij. */
  for (const seam of seams) {
    if (seam.seam === 'required-evidence') seam.stale_tracked = evBekend.filter((d) => !evDomeinen.includes(d) || !!cat.domains[d]);
    if (seam.seam === 'intake-packs') seam.stale_tracked = packBekend.filter((p2) => !packs.includes(p2) || domeinen.some((d) => cat.domains[d].intake_pack === p2 || d === p2));
  }
  /** F-05: not_expected en stale tracked gaps tellen mee in het eindoordeel — een preset die er niet
   *  hoort of een tracked gap die allang is opgelost, is net zo goed drift als een ontbrekend domein. */
  const ok = seams.every((s) => (s.missing_in_seam || []).length === 0 && (s.extra_in_seam || []).length === 0 && (s.not_expected || []).length === 0 && (s.stale_tracked || []).length === 0);
  return { ok, seams, domains_total: domeinen.length };
}

/** trefwoordmatch met EXPLICIETE matchtypen (F-15, Codex herreview): substringmatching bestaat niet
 *  meer — 'producten' ving "softwareproducten" en "bijproducten", dus gewone Nederlandse
 *  samenstellingen kozen een verkeerd playbook. Nu:
 *  - een gewone sleutel matcht als HEEL woord/frase (grenzen aan beide alfanumerieke uiteinden;
 *    'api' vangt "portfolio-API" maar niet "rapid", 'webshop' vangt "webshop-site");
 *  - een sleutel met '*'-suffix is een STAM (linkergrens, rechts open): 'beveilig*' vangt
 *    "beveiliging", 'mobiel*' vangt "mobiele" — de catalogus kiest bewust welke sleutels stam zijn;
 *  - grenzen gelden alleen naast alfanumerieke uiteinden, zodat '.exe' en 'make.com' blijven werken. */
function raakt(tekst, kw) {
  let k = String(kw).toLowerCase();
  const stam = k.endsWith('*');
  if (stam) k = k.slice(0, -1);
  if (!k) return false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const links = /^[a-z0-9]/.test(k) ? '(?<![a-z0-9])' : '';
  const rechts = /[a-z0-9]$/.test(k) ? '(?![a-z0-9])' : '';
  return new RegExp(links + esc + (stam ? '' : rechts)).test(tekst);
}

/** EEN bron voor het projectdomein (WP I.8a): primary, domeinlabels en classification_confidence komen
 *  uit DEZELFDE scorer als `forge-domain-discovery.cjs classify`. Daarvoor koos dit profiel met een vaste
 *  PRIMARY_VOLGORDE (ecommerce eerst, bots bijna achteraan) en hele-woordmatching: de intelligence evals maten 6 van
 *  36 opdrachten waarop de twee classifiers het oneens waren (een Telegram-supportbot voor een fietsenzaak werd als
 *  webshop gepland, een WordPress-site als generieke website, een "scraper" werd niet herkend, een gameserver-monitor
 *  kreeg het game-playbook). Is de discovery-module niet laadbaar (een half gesynchroniseerde installatie), dan valt
 *  het profiel EERLIJK terug op de oude trefwoordlogica en zegt dat in domain_evidence.source. */
let discoveryModule;
function discovery() {
  if (discoveryModule === undefined) { try { discoveryModule = require('./forge-domain-discovery.cjs'); } catch { discoveryModule = null; } }
  return discoveryModule;
}
let normalizeModule;
function normalizer() {
  if (normalizeModule === undefined) { try { normalizeModule = require('./forge-text-normalize.cjs'); } catch { normalizeModule = null; } }
  return normalizeModule;
}
const HINT_MIN = 2; // een onbekend type houdt alleen hints met minstens één catalogusterm (2 punten) als label
/** domeinBewijs(missie, cat, root) -> { routerLabels, herkend, primary, bewijs }. */
function domeinBewijs(missie, tekst, cat, root) {
  const D = discovery();
  let cls = null;
  if (D && typeof D.classify === 'function') { try { cls = D.classify(String(missie || ''), { root }); } catch { cls = null; } }
  if (cls) {
    const herkend = cls.verdict !== 'UNKNOWN';
    const ranked = Object.keys(cls.scores || {});
    const routerLabels = (herkend ? (cls.labels || [cls.best]) : ranked.filter((d) => cls.scores[d] >= HINT_MIN)).filter((d) => cat.domains[d]);
    const primary = herkend ? cls.best : (routerLabels[0] || 'fullstack');
    return { routerLabels, herkend, primary, bewijs: { source: 'forge-domain-discovery.classify', verdict: cls.verdict, confidence: cls.confidence, best: cls.best, mixed: cls.mixed, scores: cls.scores } };
  }
  const routerLabels = Object.entries(cat.domains).filter(([, def]) => (def.keywords || []).some((k) => raakt(tekst, k))).map(([slug]) => slug);
  const herkend = routerLabels.length > 0;
  const primary = PRIMARY_VOLGORDE.find((d) => routerLabels.includes(d)) || routerLabels[0] || 'fullstack';
  return { routerLabels, herkend, primary, bewijs: { source: 'legacy-keywords (forge-domain-discovery.cjs niet laadbaar: vaste primary-volgorde, alleen hele woorden)', verdict: herkend ? 'KNOWN' : 'UNKNOWN' } };
}

function compileMissionProfile(missie, ctx) {
  ctx = ctx || {};
  const tekst = String(missie || '').toLowerCase();
  const root = ctx.root || CONFIG_ROOT;
  const cat = loadCatalog(root);
  const dom = domeinBewijs(missie, tekst, cat, root);
  const labels = [...dom.routerLabels];
  // cross-labels: dezelfde normaliser (meervoud: "credentials" -> credential), geen samenstellingen
  const M = normalizer();
  const m = M && typeof M.matcher === 'function' ? M.matcher(tekst) : null;
  const kruis = (k) => (m ? m.has(k, { compound: false }) : raakt(tekst, k));
  for (const [label, kws] of Object.entries(cat.cross_labels || {})) {
    if (label.startsWith('_')) continue;
    if (kws.some(kruis)) labels.push(label);
  }
  const routerLabels = dom.routerLabels;
  /** F-06 (Codex batch-1-review): een missie die LETTERLIJK 'contactformulier' of 'GA4' zegt, werd
   *  genegeerd omdat alleen ctx-vlaggen telden — de vlaggenschipomissies (thank-you, duplicate submit)
   *  werden dan standaard gemist. De missietekst is nu zelf een contextbron; expliciet meegegeven ctx
   *  wint altijd van afleiding (de aanroeper weet meer dan de tekst). */
  const afgeleid = {
    has_form: /formulier|contacts?form|aanmeldform|offerteform|inschrijf/.test(tekst) ? true : undefined,
    tracking: (raakt(tekst, 'ga4') || /analytics|tracking|meetpixel/.test(tekst)) ? 'requested' : undefined,
    has_physical_location: /winkeladres|openingstijden|vestiging|fysieke locatie|bezoekadres/.test(tekst) ? true : undefined,
    indexable: (raakt(tekst, 'seo') || /vindbaar|indexeer|zoekmachine/.test(tekst)) ? true : undefined,
  };
  for (const k of Object.keys(afgeleid)) { if (ctx[k] === undefined && afgeleid[k] !== undefined) ctx = Object.assign({}, ctx, { [k]: afgeleid[k] }); }
  const herkend = dom.herkend;
  const primary = dom.primary;
  /** onbekenden EERLIJK benoemen: wat niet uit de missietekst of context af te leiden is, wordt een
   *  unknown — niet een stil ingevulde aanname. Aannames die we WEL doen staan in assumptions. */
  const unknowns = [];
  if (!herkend && routerLabels.length) unknowns.push('projecttype NIET met voldoende bewijs herkend (forge-domain-discovery classify: UNKNOWN) — primary "' + primary + '" is een zwakke hint en een AANNAME, geen classificatie; stel het type expliciet vast (of maak een discovery brief) voor er wordt gebouwd');
  else if (!herkend) unknowns.push('projecttype NIET herkend uit de missietekst — primary "fullstack" is een fallback-AANNAME, geen classificatie; stel het type expliciet vast voor er wordt gebouwd');
  if (ctx.has_form === undefined) unknowns.push('heeft het project een formulier/submitflow? (has_form niet meegegeven)');
  if (ctx.has_physical_location === undefined && (routerLabels.includes('website') || routerLabels.includes('ecommerce'))) unknowns.push('is er een fysieke locatie? (bepaalt maps/route-eisen)');
  if (ctx.tracking === undefined && routerLabels.includes('website')) unknowns.push('is er een analytics/tracking-behoefte én grondslag? (bepaalt consent-eisen)');
  return {
    project_type: labels.length ? [...new Set(labels)] : [primary],
    primary_domain: primary,
    lifecycle_stage: ctx.lifecycle_stage || 'build',
    user_outcome: ctx.user_outcome || ('het werkende, volledige resultaat van: ' + String(missie || '').slice(0, 200)),
    criticality: ctx.criticality || (labels.some((l) => ['payments', 'finance', 'prediction', 'voice'].includes(l)) ? 'high' : 'normal'),
    users: ctx.users || ['eindgebruiker', 'beheerder'],
    core_flows: ctx.core_flows || [],
    constraints: ctx.constraints || [],
    trust_boundaries: ctx.trust_boundaries || ['gebruikersinput', 'externe API’s'],
    existing_evidence: ctx.existing_evidence || [],
    unknowns,
    assumptions: ctx.assumptions || [],
    owner_gates: ctx.owner_gates || [],
    research_gaps: ctx.research_gaps || [],
    council_mode: ctx.council_mode || 'NONE',
    classification_confidence: herkend ? (routerLabels.length > 1 ? 'multi' : 'single') : 'none',
    context: { has_form: ctx.has_form, has_physical_location: ctx.has_physical_location, tracking: ctx.tracking, indexable: ctx.indexable },
    domain_evidence: dom.bewijs,
  };
}

/** F-18 (Codex herreview): EEN web-oppervlaktepredicate, gedeeld tussen lenzen en miner — 'web' was
 *  in de miner alleen 'website', waardoor een webshop of fullstack-app de submitflow-/responsive-/
 *  indexeerbaarheidskaarten stil miste terwijl de lenzen ze wél als weboppervlak behandelden. */
function isWebOppervlak(profiel) {
  return ['website', 'ecommerce', 'fullstack'].some((l) => profiel.project_type.includes(l));
}

/** 10 universele lenzen — ELK krijgt een disposition + reden; stil overslaan bestaat niet meer. */
function evaluateLenses(profiel) {
  const heeft = (l) => profiel.project_type.includes(l);
  const web = isWebOppervlak(profiel);
  const lens = (naam, disposition, reason) => ({ lens: naam, disposition, reason });
  return [
    lens('gebruikerswaarde-en-volledigheid', 'RELEVANT', 'elk project moet het BEOOGDE resultaat leveren, niet alleen de letterlijk genoemde feature — dit is de kernlens en nooit afwezig'),
    lens('correctheid-en-data-integriteit', 'RELEVANT', 'onjuiste uitvoer of dataverlies maakt elk ander kwaliteitsaspect irrelevant'),
    lens('security-privacy-compliance', (heeft('payments') || heeft('finance') || heeft('security') || heeft('privacy') || profiel.context.has_form) ? 'RELEVANT' : 'RELEVANT', profiel.context.has_form ? 'formulierinput is een trust boundary: validatie, spambescherming en privacygrondslag zijn vereist' : 'basisveiligheid (input-validatie, geen secrets in code) geldt voor elk project; verdieping schaalt met labels'),
    lens('betrouwbaarheid-herstel-idempotency', (heeft('n8n') || heeft('integration') || heeft('payments') || heeft('api')) ? 'RELEVANT' : 'RELEVANT', (heeft('n8n') || heeft('payments')) ? 'retries, duplicate events en herstel zijn in flows/betalingen een hoofdrisico' : 'fouten en herstel bestaan in elk systeem; de diepte volgt de labels'),
    lens('snelheid-capaciteit-kosten', (heeft('realtime') || heeft('data') || web) ? 'RELEVANT' : 'DEFERRED', (heeft('realtime') || web) ? 'laadtijd/latency raakt hier direct het gebruikersresultaat (Core Web Vitals / live data)' : 'geen gemeten bottleneck of realtime-eis in het profiel — meten vóór optimaliseren, dus uitgesteld tot een baseline bestaat'),
    lens('ux-toegankelijkheid-compatibiliteit', web || heeft('mobile') || heeft('electron') || heeft('game') ? 'RELEVANT' : 'NOT_APPLICABLE', web ? 'een publieke interface eist responsive gedrag, toegankelijkheid en werkende interactiestaten' : (heeft('mobile') || heeft('electron') || heeft('game')) ? 'de interface is het product — UX-staten en compatibiliteit horen bij de kern' : 'dit profiel heeft geen eindgebruikersinterface; UI-eisen zouden verzonnen werk zijn'),
    lens('vindbaarheid-integraties-interoperabiliteit', (profiel.context.indexable || heeft('api') || heeft('integration')) ? 'RELEVANT' : 'NOT_APPLICABLE', profiel.context.indexable ? 'een indexeerbare publieke site eist robots/sitemap/metadata' : (heeft('api') || heeft('integration')) ? 'een koppelvlak is het product: contract, versionering en foutsemantiek tellen' : 'geen publieke vindbaarheid of koppelvlak in dit profiel'),
    lens('observability-diagnose-operations', 'RELEVANT', 'zonder diagnose- en herstelpad is elke storing een raadsel — de diepte (logging vs. volledige monitoring) volgt criticality: ' + profiel.criticality),
    lens('onderhoudbaarheid-testbaarheid', 'RELEVANT', 'code zonder tests of met verweven verantwoordelijkheden maakt elke volgende wijziging duurder — geldt altijd, diepte schaalt met omvang'),
    lens('bewijsbaarheid-rollback-verificatie', 'RELEVANT', 'claims zonder bewijs en wijzigingen zonder rollback zijn in dit systeem per definitie onaf (Forge honesty core)'),
  ];
}

let _kaartTeller = 0;
function kaart(axis, requirement, reason, opts) {
  opts = opts || {};
  return {
    id: 'q-' + (++_kaartTeller),
    axis,
    requirement,
    reason,
    trigger: opts.trigger || '',
    failure_mode: opts.failure_mode || 'het beoogde resultaat is stil onvolledig',
    priority: opts.priority || 'P2',
    source_type: opts.source_type || 'INFERRED_FROM_STANDARD',
    disposition: opts.disposition || 'RELEVANT',
    metric: opts.metric || null,
    evidence_gate: opts.evidence_gate || 'test of screenshot in de bewijsronde',
    scope: opts.scope || 'project',
    rollback: opts.rollback || 'wijziging is lokaal en omkeerbaar via git',
    status: 'proposed',
  };
}

/** mineOmissions — vijf assen. Contextueel, geen checklist: dezelfde kandidaat krijgt in een ander
 *  profiel een andere disposition (maps: NOT_APPLICABLE zonder locatie, RELEVANT mét). */
function mineOmissions(profiel) {
  _kaartTeller = 0;
  const k = [];
  const heeft = (l) => profiel.project_type.includes(l);
  const c = profiel.context || {};
  /** F-18: hetzelfde predicate als de lenzen — website, ecommerce en fullstack zijn ALLE drie een
   *  weboppervlak. De marketingkaarten (CTA/USP/FAQ) gelden alleen voor bezoekersgerichte oppervlakken
   *  (website/ecommerce), de flow-/staat-/vindbaarheidskaarten voor het hele weboppervlak. */
  const web = isWebOppervlak(profiel);
  const marketing = heeft('website') || heeft('ecommerce');

  if (marketing) {
    k.push(kaart('lifecycle', 'duidelijke CTA (call-to-action) boven de fold, ook mobiel', 'bezoekers beslissen in seconden; zonder zichtbare CTA is de leadflow dood vóór hij begint', { trigger: 'vóór de hoofdactie', priority: 'P1' }));
    k.push(kaart('lifecycle', 'USP/waardepropositie zichtbaar vóór de eerste scroll', 'de bezoeker moet weten WAAROM hier blijven — anders is elke andere kwaliteit onzichtbaar', { trigger: 'vóór de hoofdactie' }));
    k.push(kaart('lifecycle', 'FAQ die echte bezwaren beantwoordt', 'onbeantwoorde twijfel is de stilste conversiekiller', { trigger: 'vóór de hoofdactie', priority: 'P3' }));
  }
  if (web) {
    if (c.has_form) {
      k.push(kaart('states', 'complete submitflow met succes-/thank-you-state', 'zonder bevestiging weet de bezoeker niet of het formulier aankwam — en jij niet of de lead echt is', { trigger: 'success-state', priority: 'P1' }));
      k.push(kaart('states', 'formulier-foutafhandeling (error-state met bruikbare melding)', 'een stil falend formulier verliest leads zonder spoor', { trigger: 'error-state', priority: 'P1' }));
      k.push(kaart('states', 'duplicate submit voorkomen (dubbelklik/refresh) en loading-state tonen', 'dubbele submits vervuilen de leadflow en verwarren de bezoeker', { trigger: 'duplicate/loading-state', priority: 'P2' }));
      k.push(kaart('trust-boundaries', 'formulierbeveiliging: server-side validatie + spam-/botbescherming', 'een publiek formulier is een aanvalsvlak; client-only validatie is geen validatie', { trigger: 'gebruikersinput als trust boundary', priority: 'P1' }));
      k.push(kaart('roles', 'privacyverklaring en verwerkingsgrondslag bij het formulier', 'persoonsgegevens verwerken zonder grondslag is geen detail maar een verplichting', { trigger: 'rol: bezoeker die gegevens afgeeft', priority: 'P1', source_type: 'INFERRED_FROM_STANDARD' }));
    }
    if (c.indexable) {
      k.push(kaart('operations', 'robots.txt en sitemap.xml aanwezig en kloppend', 'een indexeerbare productiesite zonder robots/sitemap laat vindbaarheid aan het toeval', { trigger: 'operations: publicatie', priority: 'P2' }));
      k.push(kaart('operations', 'canonicals, meta titles en meta descriptions per pagina (geen verzonnen bedrijfsinfo)', 'metadata bepaalt hoe de site in zoekresultaten verschijnt; verzonnen inhoud is erger dan geen', { trigger: 'operations: publicatie', priority: 'P2' }));
      k.push(kaart('operations', 'Open Graph/social sharing image', 'gedeelde links zonder OG-beeld ogen kapot en verlagen doorkliks', { trigger: 'operations: delen', priority: 'P3' }));
    }
    k.push(kaart('roles', 'alt-teksten voor betekenisvolle afbeeldingen', 'toegankelijkheid is een rol-eis (screenreader-gebruiker), geen nice-to-have', { trigger: 'rol: gebruiker met hulptechnologie', priority: 'P2' }));
    k.push(kaart('states', 'responsive gedrag op mobiel/tablet/desktop aangetoond met screenshots', 'de meerderheid van leadverkeer is mobiel; een desktop-only site faalt stil', { trigger: 'state: klein scherm', priority: 'P1' }));
    k.push(kaart('states', '404- en fouttoestanden met een weg terug', 'een kale 404 is een doodlopend pad voor bezoeker én crawler', { trigger: 'error-state', priority: 'P3' }));
    k.push(kaart('states', 'Core Web Vitals/performance gemeten (geen claim zonder meting)', 'trage laadtijd kost conversie; "voelt snel" is geen meting', { trigger: 'state: traag netwerk', priority: 'P2', metric: 'LCP/CLS/INP via Lighthouse' }));
    const locatieDisp = c.has_physical_location === true ? 'RELEVANT' : (c.has_physical_location === false ? 'NOT_APPLICABLE' : 'DEFERRED');
    k.push(kaart('lifecycle', 'maps/route/adres en openingstijden', c.has_physical_location === true ? 'bezoekers van een fysieke locatie zoeken adres en route — dit is een kernbehoefte' : c.has_physical_location === false ? 'er is GEEN fysieke locatie: maps toevoegen zou verzonnen werk zijn' : 'onbekend of er een fysieke locatie is — eerst uitvragen', { trigger: 'na de hoofdactie: bezoek', disposition: locatieDisp, priority: 'P2' }));
    const trackDisp = (c.tracking === 'none' || c.tracking === undefined || c.tracking === 'requested') ? 'OWNER_GATED' : 'RELEVANT';
    k.push(kaart('operations', 'analytics/GA4-integratie', c.tracking === 'requested' ? 'EXPLICIET gevraagd in de missie, maar er is geen config/toestemming/grondslag bekend — grondslag bevestigen is een owner-besluit, dus niet stil toevoegen' : c.tracking === 'none' || c.tracking === undefined ? 'er is geen trackingconfig, geen toestemming en geen vastgestelde grondslag — analytics stil toevoegen zou een owner-besluit omzeilen' : 'tracking is geconfigureerd: metingen horen bij de leadflow', { trigger: 'operations: meten', disposition: trackDisp, priority: 'P3', source_type: c.tracking === 'requested' ? 'EXPLICIT' : (trackDisp === 'OWNER_GATED' ? 'OWNER_GATED' : 'INFERRED_FROM_STANDARD') }));
    k.push(kaart('operations', 'cookie/consent-banner', (c.tracking && c.tracking !== 'none') ? 'tracking (of de expliciete wens daartoe) vereist toestemming vóór het eerste event' : 'zonder tracking is een consentbanner onnodig — toevoegen zou schijnzorgvuldigheid zijn', { trigger: 'operations: compliance', disposition: (c.tracking && c.tracking !== 'none') ? 'RELEVANT' : 'NOT_APPLICABLE', priority: 'P2' }));
  }

  // generieke assen — gelden voor ELK profiel, zodat de miner nooit leeg terugkomt
  k.push(kaart('lifecycle', 'installatie-/setup-pad gedocumenteerd en getest vanaf een schone omgeving', 'wat alleen op de bouwmachine werkt, werkt niet', { trigger: 'vóór de hoofdactie: installatie' }));
  const heeftUi = web || heeft('fullstack') || heeft('mobile') || heeft('electron') || heeft('game') || heeft('ecommerce');
  k.push(kaart('states', 'lege-staat (empty state) expliciet ontworpen', heeftUi ? 'de eerste gebruiker ziet ALTIJD de lege staat — die is vaker gezien dan elke andere' : 'geen eindgebruikers-UI in dit profiel: lege-staat-ontwerp is hier uitgesteld tot er een weergavelaag bestaat', { trigger: 'empty-state', disposition: heeftUi ? 'RELEVANT' : 'DEFERRED' }));
  k.push(kaart('states', 'onderbroken/halverwege-afgebroken actie herstelbaar (resume/recovery)', 'crashes en onderbrekingen zijn geen uitzondering maar een gegarandeerde toestand', { trigger: 'interrupted/retry/resume' }));
  const publiekeIngang = web || heeft('api') || heeft('bots') || heeft('n8n') || heeft('fullstack') || heeft('ecommerce') || c.has_form === true;
  k.push(kaart('roles', 'aanvallersperspectief: wat kan een kwaadwillende met de publieke ingangen?', publiekeIngang ? 'elke publieke ingang wordt gevonden; de vraag is alleen door wie het eerst' : 'dit profiel heeft geen publieke ingang — een aanvalsanalyse zonder aanvalsvlak is verzonnen werk', { trigger: 'rol: aanvaller', priority: 'P1', disposition: publiekeIngang ? 'RELEVANT' : 'NOT_APPLICABLE' }));
  const draaiendeDienst = web || heeft('fullstack') || heeft('api') || heeft('n8n') || heeft('bots') || heeft('voice') || heeft('integration') || heeft('ecommerce');
  k.push(kaart('roles', 'beheerder/operator kan de status zien en ingrijpen zonder de bouwer', draaiendeDienst ? 'een systeem dat alleen de bouwer kan bedienen is niet af' : 'geen draaiende dienst in dit profiel — operator-tooling is hier uitgesteld', { trigger: 'rol: beheerder', disposition: draaiendeDienst ? 'RELEVANT' : 'DEFERRED' }));
  k.push(kaart('operations', 'diagnosepad: logging die een storing verklaarbaar maakt', 'zonder spoor is elke storing een reconstructie uit geheugen', { trigger: 'operations: diagnose' }));
  k.push(kaart('operations', 'rollback-pad gedocumenteerd en getest', 'een wijziging zonder terugweg is een gok, geen wijziging', { trigger: 'operations: rollback' }));
  k.push(kaart('trust-boundaries', 'alle externe input gevalideerd op de grens (API-antwoorden, bestanden, user input)', 'externe data is onbetrouwbaar tot het tegendeel is gevalideerd — ook van "eigen" API’s', { trigger: 'trust boundary: netwerk/input', priority: 'P1' }));
  if (heeft('payments') || heeft('finance')) {
    k.push(kaart('trust-boundaries', 'idempotency keys op elke geldmutatie en verified webhooks', 'dubbele betalingen en ongeverifieerde webhooks zijn de twee klassieke geldfouten', { trigger: 'trust boundary: geld', priority: 'P0' }));
  }
  if (heeft('n8n') || heeft('integration')) {
    k.push(kaart('states', 'retry-gedrag en duplicate-event-afhandeling per koppeling expliciet', 'integraties leveren minstens één keer dubbel — wie dat niet afvangt boekt dubbel', { trigger: 'duplicate/retry', priority: 'P1' }));
  }
  return k;
}

function validateRequirementCard(card) {
  if (!card || typeof card !== 'object') return { ok: false, reden: 'kaart is geen object' };
  for (const veld of ['id', 'source_type', 'requirement', 'reason', 'priority', 'status']) {
    if (typeof card[veld] !== 'string' || card[veld].trim() === '') return { ok: false, reden: 'veld "' + veld + '" ontbreekt of is leeg — een kaart zonder ' + veld + ' is geen controleerbare eis' };
  }
  if (!SOURCE_TYPES.has(card.source_type)) return { ok: false, reden: 'onbekende source_type "' + card.source_type + '"' };
  if (!PRIORITEITEN.has(card.priority)) return { ok: false, reden: 'onbekende priority "' + card.priority + '" (P0-P3)' };
  /** F-04 (Codex batch-1-review): disposition was optioneel, dus de claim 'elke kaart exact één
   *  disposition' werd niet afgedwongen — en een lege confirmed_by ('' / null / false) telde als
   *  bevestiging. Beide zijn nu bindend. */
  if (!DISPOSITIES.has(card.disposition)) return { ok: false, reden: 'disposition ontbreekt of is onbekend ("' + card.disposition + '") — elke kaart draagt er EXACT een, met reden' };
  /** de kernregel: een onderzoekshypothese wordt NOOIT rechtstreeks een harde eis. Eerst lokale
   *  validatie, een officiële bron of een meetbaar experiment — anders bouwt Forge features omdat
   *  een video ze aanraadde, precies wat de anti-overengineering-regel verbiedt. */
  const bevestigingGeldig = card.confirmed_by && typeof card.confirmed_by === 'object'
    && ['lokale-validatie', 'officiele-bron', 'experiment'].includes(card.confirmed_by.type)
    && typeof card.confirmed_by.ref === 'string' && card.confirmed_by.ref.trim() !== '';
  if (card.source_type === 'RESEARCH_HYPOTHESIS' && (card.priority === 'P0' || card.priority === 'P1') && !bevestigingGeldig) {
    return { ok: false, reden: 'een RESEARCH_HYPOTHESIS mag geen P0/P1 zijn zonder GESTRUCTUREERDE bevestiging (confirmed_by: {type: lokale-validatie|officiele-bron|experiment, ref: niet-leeg}) — een leeg of vormloos veld bevestigt niets; bevestig eerst, verhoog dan de prioriteit' };
  }
  return { ok: true };
}

/** de vaste kern (~700 tokens): alleen invarianten, geen domeinkennis — die komt uit cards. */
function qualityKernel() {
  return [
    '# Forge Quality Kernel',
    '',
    'Invarianten voor ELKE missie (domeinkennis komt on-demand uit knowledge cards, nooit hieruit):',
    '',
    '1. BEGRIJP DE OUTCOME. Bouw het gewenste gebruikers-/bedrijfsresultaat, niet alleen de letterlijk',
    '   genoemde feature. Vraag: wat moet er VOOR, TIJDENS en NA de hoofdactie bestaan?',
    '2. CLASSIFICEER MULTI-LABEL. Een missie heeft zelden één domein (mobiele trading-app = mobile +',
    '   api + finance + data). De primary kiest het playbook; ALLE labels sturen de kwaliteitsdiscovery.',
    '3. ZOEK OMISSIES LANGS VIJF ASSEN: lifecycle (voor/tijdens/na) · toestanden (success, empty, error,',
    '   slow, offline, duplicate, partial, interrupted, retry, resume) · rollen (eindgebruiker, beheerder,',
    '   operator, AANVALLER, integratie) · operations (installatie, configuratie, monitoring, diagnose,',
    '   herstel, upgrade, rollback) · trust boundaries (input, opslag, netwerk, tools, credentials).',
    '4. DISPOSITIONEER EXPLICIET. Elke kwaliteitslens en elke gevonden kandidaat krijgt EXACT een van:',
    '   RELEVANT · NOT_APPLICABLE · DEFERRED · OWNER_GATED — altijd met reden. Stil overslaan bestaat',
    '   niet; stil toevoegen evenmin (geen maps zonder locatie, geen analytics zonder grondslag).',
    '5. LAAD ALLEEN RELEVANTE KENNIS. Knowledge cards per label, maximaal drie retrievalrondes per',
    '   werkpakket. Geen volledige logs, repos of rapporten in context — verwijs met pad+hash.',
    '6. MEET VOOR JE OPTIMALISEERT. Geen verbetering zonder lokaal probleem, falsifieerbare hypothese,',
    '   baseline, target, scope en rollback. Een onderzoekshypothese wordt nooit stil een harde eis.',
    '7. RESPECTEER GATES. Push/deploy/outbound/secrets/dependencies/productie zijn owner-beslissingen.',
    '   Een geblokkeerde actie wordt overgeslagen en gebundeld gerapporteerd, nooit omzeild.',
    '8. GEEN DONE ZONDER ONAFHANKELIJKE HERCONTROLE. Bewijs is een receipt (command, exitcode, hash,',
    '   commit-binding), geen bewering. Council-consensus is een voorstel, nooit bewijs. Elke write na',
    '   een review maakt die review stale. Evidence over rode poorten bestaat niet.',
  ].join('\n');
}

/** Active Mission Pack — begrensd (~2000 woorden): missie + profiel + actieve eisen + beslissingen.
 *  F-33 (review batch 2+3): structuur wordt UITSLUITEND op het aanmaakpunt toegekend (st() hieronder)
 *  — nooit meer afgeleid uit tekstvorm. Caller-inhoud (werkpakket, eisen, besluiten, findings,
 *  profielvelden) is ALTIJD content (inh()), hoe hij er ook uitziet; en artifact_ref is caller-data
 *  die begrensd wordt VOOR hij in beschermde markerregels terechtkomt. */
function buildMissionPack(profiel, delen) {
  delen = delen || {};
  const regels = [];
  const st = (t2) => regels.push({ t: t2, s: true });
  const inh = (t2) => regels.push({ t: t2, s: false });
  st('# Active Mission Pack');
  st('');
  st('## MissionProfile');
  inh('- outcome: ' + profiel.user_outcome);
  inh('- labels: ' + profiel.project_type.join(', ') + ' (primary: ' + profiel.primary_domain + ')');
  inh('- criticality: ' + profiel.criticality + ' · lifecycle: ' + profiel.lifecycle_stage + ' · council: ' + profiel.council_mode);
  if (profiel.unknowns.length) inh('- UNKNOWNS: ' + profiel.unknowns.join(' · '));
  if (profiel.assumptions.length) inh('- aannames: ' + profiel.assumptions.join(' · '));
  if (profiel.owner_gates.length) inh('- owner gates: ' + profiel.owner_gates.join(' · '));
  st('');
  st('## Actief werkpakket');
  inh(String(delen.work_package || '(geen)'));
  st('');
  st('## Actieve requirements (top)');
  const reqs = delen.requirements || [];
  for (const q of reqs.slice(0, 25)) {
    inh('- [' + q.priority + '/' + (q.disposition || 'RELEVANT') + '] ' + q.requirement + ' — ' + q.reason);
  }
  if (reqs.length > 25) st('- … en ' + (reqs.length - 25) + ' meer (volledige lijst in het run-artifact — F-07: afkap is zichtbaar, nooit stil)');
  if ((delen.decisions || []).length) {
    st('');
    st('## Beslissingen');
    for (const d of delen.decisions.slice(0, 10)) inh('- ' + d);
    if (delen.decisions.length > 10) st('- … en ' + (delen.decisions.length - 10) + ' meer (run-artifact)');
  }
  if ((delen.open_findings || []).length) {
    st('');
    st('## Open findings');
    for (const f of delen.open_findings.slice(0, 10)) inh('- ' + f);
    if (delen.open_findings.length > 10) st('- … en ' + (delen.open_findings.length - 10) + ' meer (run-artifact)');
  }
  /** F-19/F-28/F-30/F-33: het budget is REGEL-gebaseerd en het harde budget wint ALTIJD.
   *  F-33 (review batch 2+3): de vorige vorm kende structuur alsnog toe via r.map + tekstvorm
   *  ('#', '… en N meer'), dus caller-regels in die vorm kregen gratis bescherming (4582/2538
   *  woorden gemeten), en een onbegrensde artifact_ref liftte mee in elke beschermde marker
   *  (17599 woorden). Nu: {t,s} wordt op het AANMAAKPUNT gezet (st()/inh() hierboven), caller-data
   *  is altijd content, artifact_ref is begrensd, en een slotcontrole dwingt het budget ook af
   *  wanneer de structuur zelf te groot zou worden. */
  const BUDGET = 2000;
  const wc = (s2) => s2.split(/\s+/).filter(Boolean).length;
  const refRuw = String(delen.artifact_ref || 'het run-artifact');
  const refW = refRuw.split(/\s+/).filter(Boolean);
  const artifactRef = refW.length > 12 ? refW.slice(0, 12).join(' ') + ' …[referentie ingekort]' : refRuw;
  const LIJN_MAX = 400;
  // stap 1: een megaregel wordt ingekort tot LIJN_MAX en krijgt een APARTE compacte markerregel
  for (let i = regels.length - 1; i >= 0; i--) {
    if (!regels[i].s && wc(regels[i].t) > LIJN_MAX) {
      const w = regels[i].t.split(/\s+/).filter(Boolean);
      regels[i].t = w.slice(0, LIJN_MAX).join(' ');
      regels.splice(i + 1, 0, { t: '[REGEL AFGEKAPT — ' + (w.length - LIJN_MAX) + ' woorden van de vorige regel weggelaten; volledig in ' + artifactRef + ']', s: true });
    }
  }
  // stap 2: contentregels verwijderen van achter naar voren tot het HARDE doel — structuur blijft.
  // Doelmarge: sectie-markers (max ~14 woorden per sectie) + slotregel passen gegarandeerd binnen BUDGET.
  const weggelatenPerSectie = {};
  const sectieVan = (idx) => { for (let j = idx; j >= 0; j--) { if (regels[j].t.startsWith('##')) return regels[j].t.replace(/^#+\s*/, ''); } return '(kop)'; };
  let totaal = regels.reduce((n2, x2) => n2 + wc(x2.t), 0);
  const DOEL = BUDGET - 100;
  for (let i = regels.length - 1; i >= 0 && totaal > DOEL; i--) {
    if (regels[i].s) continue;
    const sectie = sectieVan(i);
    totaal -= wc(regels[i].t);
    regels.splice(i, 1);
    weggelatenPerSectie[sectie] = (weggelatenPerSectie[sectie] || 0) + 1;
  }
  for (const [sectie, n] of Object.entries(weggelatenPerSectie)) {
    const kopIdx = regels.findIndex((x2) => x2.t.replace(/^#+\s*/, '') === sectie);
    const marker = { t: '- [GLOBAAL BUDGET] … en ' + n + ' meer regel(s) uit deze sectie weggelaten (volledig in ' + artifactRef + ')', s: true };
    if (kopIdx >= 0) regels.splice(kopIdx + 1, 0, marker); else regels.push(marker);
  }
  regels.push({ t: '', s: true });
  regels.push({ t: '[budget ' + BUDGET + ' woorden — volledige lijsten leven in ' + artifactRef + ']', s: true });
  /** F-33 slotcontrole: mocht de structuur zelf (veel capmarkers) het budget overschrijden, dan
   *  wint het budget alsnog — niet-kop-structuurregels verdwijnen van achter naar voren. Koppen
   *  blijven altijd staan; dit pad is een laatste vangnet, geen normale route. */
  let eind = regels.reduce((n2, x2) => n2 + wc(x2.t), 0);
  if (eind > BUDGET) {
    for (let i = regels.length - 1; i >= 0 && eind > BUDGET; i--) {
      if (regels[i].t.startsWith('#')) continue;
      eind -= wc(regels[i].t);
      regels.splice(i, 1);
    }
  }
  return regels.map((x2) => x2.t).join('\n');
}

/** loadKnowledgeCard — laag 3 van progressive disclosure: een kaart kost 0 tokens tot hij geladen
 *  wordt. Eerlijk: een ontbrekende kaart is null (de aanroeper meldt dat), nooit verzonnen inhoud.
 *  tokens_est is een SCHATTING (woorden × 1.35), geen tokenizer-meting, en zo gelabeld. */
function loadKnowledgeCard(root, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) return null; // padinjectie uitgesloten
  const p = path.join(root || CONFIG_ROOT, '.claude', 'config', 'quality', 'cards', slug + '.md');
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8');
  const woorden = content.split(/\s+/).filter(Boolean).length;
  return { slug, path: p, content, words: woorden, tokens_est: Math.round(woorden * 1.35), tokens_est_note: 'schatting (woorden × 1.35), geen tokenizer-meting' };
}

/** selectKnowledgeCards — F-20 (Codex herreview): geen kale slugstrings meer maar GEVALIDEERDE
 *  descriptors: elk item draagt slug, repo-relatief pad, of het bestand BESTAAT, de sha256 van de
 *  inhoud en een deterministische relevantiescore (primary 1.0 > overige domeinlabels 0.8 >
 *  cross-labels 0.6; volgorde binnen een band volgt het profiel). Max 6, max 3 retrievalrondes
 *  blijft de afspraak in de kernel. */
function selectKnowledgeCards(profiel, root) {
  const basis = root || CONFIG_ROOT;
  const cat = loadCatalog(basis);
  /** F-08: alleen labels die de catalogus KENT tellen; de primary telt alleen mee als hij geldig is. */
  const isDomein = (l) => !!cat.domains[l];
  const isCross = (l) => !!(cat.cross_labels && cat.cross_labels[l] && !String(l).startsWith('_'));
  const geldig = (l) => isDomein(l) || isCross(l);
  const kandidaten = profiel.project_type.filter(geldig);
  const geordend = [...new Set([profiel.primary_domain, ...kandidaten])].filter(geldig);
  return geordend.slice(0, 6).map((slug) => {
    const relPad = path.join('.claude', 'config', 'quality', 'cards', slug + '.md');
    const volPad = path.join(basis, relPad);
    const bestaat = fs.existsSync(volPad);
    return {
      slug,
      path: relPad.split(path.sep).join('/'),
      exists: bestaat,
      sha256: bestaat ? sha256(fs.readFileSync(volPad, 'utf8')) : null,
      relevance: slug === profiel.primary_domain ? 1.0 : (isDomein(slug) ? 0.8 : 0.6),
      reason: slug === profiel.primary_domain ? 'primary domain' : (isDomein(slug) ? 'domeinlabel uit het profiel' : 'cross-label uit het profiel'),
    };
  }).sort((a, b) => b.relevance - a.relevance);
}

/** analyzeMission — F-14 (Codex herreview): het ENE uitvoerbare entrypoint dat de hele keten in één
 *  aanroep levert, zodat de router niet vijf losse functienamen in prose hoeft na te leven. Elke
 *  omission-kaart is gegarandeerd validator-geldig (de keten levert nooit kaarten af die zijn eigen
 *  validator zou weigeren). */
function analyzeMission(missie, ctx) {
  ctx = ctx || {};
  const basis = ctx.root || CONFIG_ROOT;
  const profiel = compileMissionProfile(missie, ctx);
  const cat = loadCatalog(basis);
  const omissions = mineOmissions(profiel);
  const validatie = omissions.map((c) => validateRequirementCard(c));
  return {
    profile: profiel,
    playbook: (cat.domains[profiel.primary_domain] && cat.domains[profiel.primary_domain].playbook) || null,
    lenses: evaluateLenses(profiel),
    omissions,
    omissions_valid: validatie.every((v) => v.ok === true),
    /** F-25 (Codex eindreview): de contextcompiler hoort IN het ene entrypoint — het Active Mission
     *  Pack wordt hier echt gebouwd uit profiel + gevalideerde omissions + meegegeven werkpakket-
     *  context, zodat de router nooit een losse tweede aanroep hoeft te onthouden. */
    mission_pack: buildMissionPack(profiel, {
      requirements: omissions,
      decisions: ctx.decisions || [],
      work_package: ctx.work_package || '(nog geen werkpakket — analysefase)',
      open_findings: ctx.open_findings || [],
      artifact_ref: ctx.artifact_ref || 'het run-artifact',
    }),
    knowledge_cards: selectKnowledgeCards(profiel, basis),
    council: councilTrigger({
      decision_impact: profiel.criticality === 'high' ? 'high' : 'medium',
      uncertainty: profiel.classification_confidence === 'none' ? 'high' : 'low',
      credible_options: 1,
      criticality: profiel.criticality,
      explicit_request: /council|pressure.?test|debat/i.test(String(missie || '')),
    }, { projectRoot: basis, configModule: ctx.configModule }),
  };
}

/** councilTrigger(inp, opts) — deterministisch en SELECTIEF: council is duur (latency, tokens, context) en
 *  levert alleen waarde bij echte beslisonzekerheid. Nooit op simpele taken. Een expliciete vraag wint
 *  altijd; daarna geldt de eigenaarsinstelling `council` (off -> NONE). opts: { projectRoot, configModule }. */
function councilTrigger(inp, opts) {
  inp = inp || {};
  opts = opts || {};
  if (inp.explicit_request === true) return { mode: 'FULL', trigger_reason: 'expliciete gebruikerstrigger (council/pressure-test/debate) — de owner vroeg om tegenspraak', scores: inp };
  const sc = configRead('council', 'auto', { projectRoot: opts.projectRoot, configModule: opts.configModule });
  const r = councilByScores(inp, sc.value);
  return sc.degraded ? Object.assign(r, { config_note: sc.reason }) : r; // degraded settings: zeg het in het resultaat
}
function councilByScores(inp, councilSetting) {
  if (councilSetting === 'off') {
    return { mode: 'NONE', reason: COUNCIL_OFF_REASON, trigger_reason: COUNCIL_OFF_REASON + ' — automatische council staat uit (terugzetten: /forge config set council auto); een expliciete council-vraag wint nog steeds', scores: inp };
  }
  const zwaar = (inp.decision_impact === 'high') + (inp.uncertainty === 'high') + (inp.reversibility === 'low') + (Number(inp.credible_options) >= 2) + (inp.criticality === 'high');
  if (inp.decision_impact === 'high' && inp.uncertainty === 'high' && zwaar >= 3) {
    return { mode: 'FULL', trigger_reason: 'hoge impact + hoge onzekerheid' + (inp.reversibility === 'low' ? ' + moeilijk omkeerbaar' : '') + ' (' + zwaar + '/5 zwaartefactoren) — de verwachte informatiewinst overstijgt de kosten', scores: inp };
  }
  const middel = (inp.decision_impact === 'medium' || inp.decision_impact === 'high') && (inp.uncertainty === 'medium' || inp.uncertainty === 'high') && Number(inp.credible_options) >= 2;
  if (middel) return { mode: 'LIGHT', trigger_reason: 'middelgrote ambiguïteit met meerdere geloofwaardige opties — LIGHT council, alleen als benchmarks waarde aantonen', scores: inp };
  return { mode: 'NONE', trigger_reason: 'deterministisch of laag-risico: de verwachte informatiewinst is lager dan latency, kosten en contextbelasting — lokale tests geven het antwoord', scores: inp };
}

/** validateCouncilRecord — een record zonder ECHTE dispatch-provenance valideert niet. Een rolnaam is
 *  geen deelnemer (dezelfde les als F-02: labels bewijzen geen principal). */
function validateCouncilRecord(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, reden: 'record is geen object' };
  if (typeof rec.council_id !== 'string' || !rec.council_id) return { ok: false, reden: 'council_id ontbreekt' };
  if (typeof rec.context_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(rec.context_hash)) return { ok: false, reden: 'context_hash ontbreekt of is geen sha256 — zonder hash is onbekend waarover de council oordeelde' };
  if (!Array.isArray(rec.participants) || !rec.participants.length) return { ok: false, reden: 'geen deelnemers' };
  for (const p of rec.participants) {
    if (!p || typeof p.role !== 'string') return { ok: false, reden: 'deelnemer zonder rol' };
    if (typeof p.runtime !== 'string' || !p.runtime || typeof p.dispatch_id !== 'string' || !p.dispatch_id) {
      return { ok: false, reden: 'deelnemer "' + p.role + '" mist echte runtime/dispatch-provenance — een rolnaam alleen is geen deelnemer (gefabriceerde agents valideren niet)' };
    }
  }
  /** F-17 (Codex herreview): shape-only betekent niet vorm-loos — dubbele dispatch-IDs, negatieve
   *  quorumwaarden en een COMPLETE record zonder responses/verdict zijn structureel ongeldig,
   *  onafhankelijk van de (owner-gated) provenance-vraag. */
  const dispatchIds = rec.participants.map((p) => p.dispatch_id);
  if (new Set(dispatchIds).size !== dispatchIds.length) return { ok: false, reden: 'dubbele dispatch-IDs — twee deelnemers kunnen niet uit dezelfde dispatch komen; elk advies eist een eigen echte dispatch' };
  if (!rec.quorum || !Number.isInteger(rec.quorum.required) || !Number.isInteger(rec.quorum.present)) return { ok: false, reden: 'quorum ontbreekt' };
  if (rec.quorum.required < 1 || rec.quorum.present < 0) return { ok: false, reden: 'quorum met negatieve of nul-vereiste waarden (required=' + rec.quorum.required + ', present=' + rec.quorum.present + ') is geen quorum' };
  /** F-03: present kan niet groter zijn dan het aantal deelnemers met provenance — een quorum dat
   *  niet aan de deelnemerslijst gebonden is, is een vrij invulbaar getal. */
  if (rec.quorum.present > rec.participants.length) return { ok: false, reden: 'quorum.present (' + rec.quorum.present + ') is groter dan het aantal deelnemers (' + rec.participants.length + ') — het quorum is niet aan de deelnemerslijst gebonden' };
  if (rec.quorum.present < rec.quorum.required && rec.status !== 'INCOMPLETE') {
    return { ok: false, reden: 'quorum niet gehaald (' + rec.quorum.present + '/' + rec.quorum.required + ') maar status is niet INCOMPLETE — een onvolledig quorum eerlijk markeren is verplicht' };
  }
  /** F-26 (Codex eindreview): "responses werd alleen gecontroleerd wanneer het al een array was" —
   *  ontbrekend/null/verkeerd getypt glipte erdoor, net als null-responses, ontbrekende response_refs
   *  en een verzonnen status. Het vocabulaire en de structuur zijn nu GESLOTEN. */
  /** F-32 (afsluitende herreview): de validator moet TOTAAL zijn — een niet-string-status (Symbol,
   *  nummer) mag nooit een exception veroorzaken (typecheck VOOR elke interpolatie), en een sparse
   *  array telt holes in length terwijl every() ze overslaat, dus dichtheid wordt expliciet
   *  gecontroleerd per indexslot. */
  const GELDIGE_STATUSSEN = new Set(['COMPLETE', 'INCOMPLETE']);
  if (typeof rec.status !== 'string' || !GELDIGE_STATUSSEN.has(rec.status)) return { ok: false, reden: 'status ' + (typeof rec.status === 'string' ? '"' + rec.status + '"' : 'van type ' + typeof rec.status) + ' valt buiten het gesloten vocabulaire (COMPLETE|INCOMPLETE) — een verzonnen status is geen status' };
  if (rec.status === 'COMPLETE') {
    if (typeof rec.verdict !== 'string' || rec.verdict.trim() === '') return { ok: false, reden: 'een COMPLETE record zonder verdict is geen besluit — de synthese (met minority report) is de reden dat de council bestond' };
    if (!Array.isArray(rec.responses)) return { ok: false, reden: 'een COMPLETE record EIST een responses-array — ontbrekend of verkeerd getypt is geen "geen responses" maar een ongeldig record' };
    for (let i = 0; i < rec.responses.length; i++) {
      if (!(i in rec.responses)) return { ok: false, reden: 'responses is een sparse array (hole op index ' + i + ') — een gat is geen advies, en length mag niet meer beloven dan er staat' };
    }
    if (!rec.responses.every((x) => typeof x === 'string' && x.trim() !== '')) return { ok: false, reden: 'responses bevat lege of niet-string-waarden — een advies zonder inhoud telt niet' };
    if (rec.responses.length < rec.quorum.present) return { ok: false, reden: 'quorum.present zegt ' + rec.quorum.present + ' deelnemers leverden, maar responses draagt er ' + rec.responses.length + ' — een compleet record zonder de adviezen zelf is een lege huls' };
    const refs = rec.participants.map((p) => p.response_ref);
    if (!refs.every((x) => typeof x === 'string' && x.trim() !== '')) return { ok: false, reden: 'een COMPLETE record eist een response_ref per deelnemer — een deelnemer zonder gekoppeld advies is niet aanwezig geweest' };
    if (new Set(refs).size !== refs.length) return { ok: false, reden: 'dubbele response_refs — twee deelnemers kunnen niet hetzelfde advies zijn' };
    const responsesSet = new Set(rec.responses);
    const zoek = refs.find((x) => !responsesSet.has(x));
    if (zoek !== undefined) return { ok: false, reden: 'response_ref "' + zoek + '" bestaat niet in responses — de deelnemerslijst en de adviezen zijn niet aan elkaar gebonden' };
  }
  /** F-03 — EERLIJKE GRENS (dezelfde als F-02 label!=principal): deze validatie toetst de VORM.
   *  runtime/dispatch_id zijn caller-strings; een niet-vervalsbaar dispatchreceipt vereist de gateway
   *  en is OWNER-GATED. Tot die tijd zegt elk geldig record dit er zelf bij. */
  return { ok: true, shape_only: true, caveat: 'structurele validatie — runtime/dispatch_id zijn niet cryptografisch gebonden; echte provenance is owner-gated (zie OWNER-GATED.md)' };
}

/** persistCouncilRecord — batch 3: een CouncilDecisionRecord wordt ALLEEN gepersisteerd als hij
 *  valideert; een ongeldig record weigeren (met reden) is het eerlijke resultaat, geen bestand.
 *  Append-only per council_id: een bestaand besluit overschrijven is geschiedvervalsing. */
function persistCouncilRecord(root, runId, rec) {
  const v = validateCouncilRecord(rec);
  if (!v.ok) return { ok: false, reden: 'record valideert niet: ' + v.reden, written: null };
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(runId)) return { ok: false, reden: 'ongeldig run_id (padtekens geweigerd)', written: null };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(rec.council_id)) return { ok: false, reden: 'council_id met padtekens geweigerd', written: null };
  const dir = path.join(runDirOf(root, runId), 'council');
  const p = path.join(dir, rec.council_id + '.json');
  fs.mkdirSync(dir, { recursive: true });
  /** F-35 (review batch 2+3): existsSync + writeFileSync was een TOCTOU-paar — twee gelijktijdige
   *  schrijvers konden beide de check passeren en de tweede herschreef de eerste. De exclusieve
   *  'wx'-creatie laat het OS de ene winnaar kiezen; EEXIST is de append-only-weigering. */
  try {
    fs.writeFileSync(p, JSON.stringify(Object.assign({}, rec, { _validated: { shape_only: true, caveat: v.caveat, at: new Date().toISOString() } }), null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, reden: 'council_id "' + rec.council_id + '" bestaat al — records zijn append-only, een besluit wordt nooit overschreven', written: null };
    throw e;
  }
  return { ok: true, reden: v.caveat, written: p };
}

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/* ---- Quality gate cards (modernization WP 3.4) -------------------------------------------------
 * One card per catalog domain at .claude/config/quality/cards/<domain>.json (the .md files next to them are the
 * knowledge cards above). Verify Boss runs `gate --domain <d>` and marks every listed check PASS / FAIL / NOT_RUN
 * with evidence. Every check cites a section of the domain playbook (or a FORGE_HARD_RULES.json rule) plus a
 * fragment that must still be found there; verifyGateCitations() re-checks that against the current files. This
 * code only LISTS checks: a card that carries a result field does not validate, and nothing here marks a pass. */
const GATE_MARKS = ['PASS', 'FAIL', 'NOT_RUN'];
const CITE = { type: 'object', description: 'markdown: {path, section, quote}; FORGE_HARD_RULES.json: {path, rule_id, quote}', required: ['path', 'quote'], properties: { path: { type: 'string' }, section: { type: 'string' }, rule_id: { type: 'string' }, quote: { type: 'string' } }, additionalProperties: false };
const GATE_CARD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Forge quality gate card',
  type: 'object',
  required: ['domain', 'version', 'source', 'checks', 'hard_gates', 'not_applicable_when', 'gaps'],
  additionalProperties: false,
  properties: {
    domain: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'equals the file name and a domain-catalog.json domain' },
    version: { type: 'integer', minimum: 1 },
    source: { type: 'array', minItems: 1, items: { type: 'object', required: ['path', 'section'], properties: { path: { type: 'string' }, section: { type: 'string' } }, additionalProperties: false } },
    checks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['id', 'claim', 'evidence_required', 'how_to_run', 'severity', 'honesty_note', 'source'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' }, claim: { type: 'string' }, evidence_required: { type: 'string' }, how_to_run: { type: 'string' }, severity: { enum: ['block', 'warn'] }, honesty_note: { type: 'string' }, source: CITE } } },
    hard_gates: { type: 'array', items: { type: 'object', required: ['gate', 'source'], properties: { gate: { type: 'string' }, source: CITE }, additionalProperties: false } },
    not_applicable_when: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' }, description: 'places where the playbook has no verifiable gate — said, never filled in' },
  },
};

const isText = (v) => typeof v === 'string' && v.trim() !== '';
/** shapeProblems(obj, schemaNode, where) -> problems for required/additional keys and non-empty strings (one level). */
function shapeProblems(obj, node, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [where + ' is not an object'];
  const out = [];
  for (const k of node.required || []) if (!(k in obj)) out.push(where + '.' + k + ' is missing');
  for (const k of Object.keys(obj)) if (!(node.properties || {})[k]) out.push(where + '.' + k + ' is not a card field (a card lists checks, it never carries results)');
  for (const [k, p] of Object.entries(node.properties || {})) if (p.type === 'string' && k in obj && !isText(obj[k])) out.push(where + '.' + k + ' must be a non-empty string');
  return out;
}

/** citeShape(c, where) -> problems: the CITE shape plus exactly one locator (section for markdown, rule_id for the hard rules). */
function citeShape(c, where) {
  const out = shapeProblems(c, CITE, where);
  if (c && typeof c === 'object' && !isText(c.section) === !isText(c.rule_id)) out.push(where + ' needs exactly one of section or rule_id');
  return out;
}
/** validateGateCard(card, {domain}) -> {ok, problems[]} against GATE_CARD_SCHEMA. Never throws. */
function validateGateCard(card, opts) {
  const S = GATE_CARD_SCHEMA.properties;
  const problems = shapeProblems(card, GATE_CARD_SCHEMA, 'card');
  if (problems.length && (!card || typeof card !== 'object')) return { ok: false, problems };
  if (!isText(card.domain) || !/^[a-z0-9-]+$/.test(card.domain)) problems.push('card.domain must be a slug');
  if (opts && opts.domain && card.domain !== opts.domain) problems.push('card.domain "' + card.domain + '" does not match the file name "' + opts.domain + '"');
  if (!Number.isInteger(card.version) || card.version < 1) problems.push('card.version must be an integer >= 1');
  if (!Array.isArray(card.source) || !card.source.length) problems.push('card.source must list at least one playbook section');
  else card.source.forEach((s, i) => problems.push(...shapeProblems(s, S.source.items, 'card.source[' + i + ']')));
  if (!Array.isArray(card.checks) || card.checks.length < 1 || card.checks.length > 12) problems.push('card.checks must hold 1..12 checks (cards stay small)');
  const ids = new Set();
  (Array.isArray(card.checks) ? card.checks : []).forEach((ch, i) => {
    const w = 'checks[' + i + ']';
    problems.push(...shapeProblems(ch, S.checks.items, w));
    if (!ch || typeof ch !== 'object') return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(ch.id))) problems.push(w + '.id must be a slug');
    if (ids.has(ch.id)) problems.push(w + '.id "' + ch.id + '" is a duplicate');
    ids.add(ch.id);
    if (!S.checks.items.properties.severity.enum.includes(ch.severity)) problems.push(w + '.severity "' + ch.severity + '" is not block|warn');
    problems.push(...citeShape(ch.source, w + '.source'));
  });
  if (!Array.isArray(card.hard_gates)) problems.push('card.hard_gates must be an array');
  else card.hard_gates.forEach((g, i) => { problems.push(...shapeProblems(g, S.hard_gates.items, 'hard_gates[' + i + ']')); if (g && typeof g === 'object') problems.push(...citeShape(g.source, 'hard_gates[' + i + '].source')); });
  for (const k of ['not_applicable_when', 'gaps']) {
    if (!Array.isArray(card[k])) problems.push('card.' + k + ' must be an array (empty is allowed)');
    else if (!card[k].every(isText)) problems.push('card.' + k + ' must hold non-empty strings');
  }
  return { ok: problems.length === 0, problems };
}

/** citation text compare: bold markers, backticks and whitespace runs do not count. */
const normCite = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
/** mdSection(text, heading) -> the body under the first heading whose text starts with `heading`, up to the next
 *  heading of the same or a higher level; null when there is no such heading. */
function mdSection(text, heading) {
  const lines = String(text).split(/\r?\n/);
  let level = 0, body = null;
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (body !== null && m && m[1].length <= level) break;
    if (body !== null) { body.push(line); continue; }
    if (m && m[2].trim().startsWith(heading)) { level = m[1].length; body = []; }
  }
  return body === null ? null : body.join('\n');
}
/** verifyGateCitations(card, root) -> {ok, checked, problems[]}: every card-level source, check and hard gate
 *  must point at a file inside root, a heading (or hard-rule id / JSON key) that exists, and a quote found in
 *  THAT section. A playbook edit that drops the cited text makes the card stale, visibly. */
function verifyGateCitations(card, root) {
  const problems = [];
  let checked = 0;
  const cache = new Map();
  const read = (rel) => {
    if (!isText(rel) || !rel.startsWith('.claude/') || rel.split('/').includes('..')) return { err: 'path "' + rel + '" must stay inside .claude/' };
    if (!cache.has(rel)) { try { cache.set(rel, { text: fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8') }); } catch { cache.set(rel, { err: rel + ' does not exist' }); } }
    return cache.get(rel);
  };
  const one = (where, c, needQuote) => {
    checked++;
    const f = read(c && c.path);
    if (f.err) return problems.push(where + ': ' + f.err);
    if (/\.json$/.test(c.path)) {
      let j; try { j = JSON.parse(f.text); } catch { return problems.push(where + ': ' + c.path + ' is not valid JSON'); }
      if (c.rule_id === undefined) return (c.section in j) ? null : problems.push(where + ': key "' + c.section + '" not in ' + c.path);
      const r = [...(j.rules || []), ...(j.orchestration_hard_rules || [])].find((x) => x && x.id === c.rule_id);
      if (!r) return problems.push(where + ': rule id "' + c.rule_id + '" not in ' + c.path);
      if (needQuote && !normCite(r.rule).includes(normCite(c.quote))) problems.push(where + ': quote not found in rule ' + c.rule_id);
      return null;
    }
    const body = mdSection(f.text, String(c.section || ''));
    if (body === null) return problems.push(where + ': no heading "' + c.section + '" in ' + c.path);
    if (needQuote && !normCite(body).includes(normCite(c.quote))) problems.push(where + ': quote "' + String(c.quote).slice(0, 60) + '" not found under "' + c.section + '" in ' + c.path);
    return null;
  };
  (card.source || []).forEach((s, i) => one('source[' + i + ']', s, false));
  (card.checks || []).forEach((ch) => one(ch.id, ch.source, true));
  (card.hard_gates || []).forEach((g, i) => one('hard_gates[' + i + ']', g.source, true));
  return { ok: problems.length === 0, checked, problems };
}

const gateCardDir = (root) => path.join(root, '.claude', 'config', 'quality', 'cards');
/** loadGateCard(root, domain) -> {card, path, rel, sha256} | {error} | null (null = no card for that slug). */
function loadGateCard(root, domain) {
  if (typeof domain !== 'string' || !/^[a-z0-9-]+$/.test(domain)) return null;
  const p = path.join(gateCardDir(root), domain + '.json');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const rel = '.claude/config/quality/cards/' + domain + '.json';
  try { return { card: JSON.parse(raw), path: p, rel, sha256: sha256(raw) }; } catch (e) { return { error: rel + ' is not valid JSON: ' + e.message, path: p, rel }; }
}
/** listGateCards(root) -> [{domain, checks, block, warn, valid, problems}] sorted by domain. */
function listGateCards(root) {
  let files = [];
  try { files = fs.readdirSync(gateCardDir(root)).filter((f) => f.endsWith('.json')).sort(); } catch { files = []; }
  return files.map((f) => {
    const domain = f.replace(/\.json$/, '');
    const r = loadGateCard(root, domain);
    if (!r || r.error) return { domain, checks: 0, block: 0, warn: 0, valid: false, problems: [r ? r.error : 'unreadable'] };
    const v = validateGateCard(r.card, { domain });
    const cs = Array.isArray(r.card.checks) ? r.card.checks : [];
    return { domain, checks: cs.length, block: cs.filter((c) => c.severity === 'block').length, warn: cs.filter((c) => c.severity === 'warn').length, valid: v.ok, problems: v.problems };
  });
}
const citeText = (c) => (c.url || c.path) + (c.rule_id ? ' rule ' + c.rule_id : c.section ? ' § ' + c.section : '') + ' — "' + c.quote + '"';

/* ---- Generic fallback + provisional cards (Phase I.4 universal projects) ---------------------------
 * generic.json (in the card folder, not a catalog domain) holds the checks that apply to ANY deliverable. A
 * well-formed domain without a card first looks for a PROVISIONAL card in the project's research state folder
 * (written by the Lead from sources Search Boss actually read, see forge-domain-discovery.cjs), else falls back to
 * generic. A provisional card must say provisional: true, carry created + sources[] and a citation on every check;
 * the tool cannot check those sources, so its output is marked UNVERIFIED-SOURCES behind a loud banner. */
const GENERIC_DOMAIN = 'generic';
const SLUG_RE = /^[a-z0-9-]+$/;
const PCITE = { type: 'object', description: 'exactly one of url (http/https) or path (project-relative), plus the quote that was read', required: ['quote'], properties: { url: { type: 'string' }, path: { type: 'string' }, section: { type: 'string' }, quote: { type: 'string' } }, additionalProperties: false };
const PROVISIONAL_CARD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Forge PROVISIONAL quality card (a project type without a playbook)',
  type: 'object',
  required: ['domain', 'version', 'provisional', 'created', 'sources', 'checks', 'hard_gates', 'not_applicable_when', 'gaps'],
  additionalProperties: false,
  properties: {
    domain: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'equals the file name; never generic, never the name of a real card' },
    version: { type: 'integer', minimum: 1 },
    provisional: { const: true },
    created: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}', description: 'ISO date the card was derived' },
    sources: { type: 'array', minItems: 1, items: { type: 'object', description: 'exactly one of url or path: what the Lead / Search Boss actually read', properties: { url: { type: 'string' }, path: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false } },
    checks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['id', 'claim', 'evidence_required', 'how_to_run', 'severity', 'honesty_note', 'source'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' }, claim: { type: 'string' }, evidence_required: { type: 'string' }, how_to_run: { type: 'string' }, severity: { enum: ['block', 'warn'] }, honesty_note: { type: 'string' }, source: PCITE } } },
    hard_gates: { type: 'array', items: { type: 'object', required: ['gate', 'source'], properties: { gate: { type: 'string' }, source: PCITE }, additionalProperties: false } },
    not_applicable_when: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
};
const RESULT_KEYS = new Set(['status', 'result', 'verdict', 'pass', 'passed', 'evidence', 'marked']);

/** provisionalCardDir(root) -> <research state folder>/provisional-cards (forge-paths.cjs stateDir when it can
 *  resolve this root, else the legacy literal .claude/forge-research/provisional-cards). */
function provisionalCardDir(root) {
  try {
    const P = require('./forge-paths.cjs');
    if (typeof P.stateDir === 'function') return path.join(P.stateDir(root, 'research'), 'provisional-cards');
  } catch { /* a root forge-paths cannot resolve (no canon, bare fixture) uses the legacy literal below */ }
  return path.join(root, '.claude', 'forge-research', 'provisional-cards');
}
/** locatorProblems(c, where) -> problems unless c carries exactly one of url / path, each well-formed. */
function locatorProblems(c, where) {
  if (!c || typeof c !== 'object') return [];
  const out = [];
  if (isText(c.url) === isText(c.path)) out.push(where + ' needs exactly one of url or path (what was actually read)');
  if (isText(c.url) && !/^https?:\/\/\S+$/.test(c.url)) out.push(where + '.url must be an http(s) URL');
  if (isText(c.path) && (path.isAbsolute(c.path) || /^[a-zA-Z]:/.test(c.path) || c.path.split(/[\\/]/).includes('..'))) out.push(where + '.path must be project-relative without ..');
  return out;
}
/** resultFieldProblems(node, where) -> problems for any result-shaped key or a PASS value anywhere in the card. */
function resultFieldProblems(node, where, out) {
  const acc = out || [];
  if (Array.isArray(node)) node.forEach((x, i) => resultFieldProblems(x, where + '[' + i + ']', acc));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (RESULT_KEYS.has(k.toLowerCase())) acc.push(where + '.' + k + ' is a result field (a card never carries results)');
      resultFieldProblems(v, where + '.' + k, acc);
    }
  } else if (typeof node === 'string' && /^(pass|passed)$/i.test(node.trim())) acc.push(where + ' carries a PASS value (a card never claims a pass)');
  return acc;
}
/** validateProvisionalCard(card, {domain, root}) -> {ok, problems[]} against PROVISIONAL_CARD_SCHEMA. Never throws. */
function validateProvisionalCard(card, opts) {
  const o = opts || {};
  const S = PROVISIONAL_CARD_SCHEMA.properties;
  const problems = shapeProblems(card, PROVISIONAL_CARD_SCHEMA, 'card');
  if (!card || typeof card !== 'object' || Array.isArray(card)) return { ok: false, problems };
  if (card.provisional !== true) problems.push('card.provisional must be true (a provisional card says so)');
  if (!isText(card.domain) || !SLUG_RE.test(card.domain)) problems.push('card.domain must be a slug');
  else {
    if (card.domain === GENERIC_DOMAIN) problems.push('card.domain "generic" is the shipped fallback card; pick the project type slug');
    if (o.root && fs.existsSync(path.join(gateCardDir(o.root), card.domain + '.json'))) problems.push('card.domain "' + card.domain + '" shadows a real playbook card; use that card instead');
  }
  if (o.domain && card.domain !== o.domain) problems.push('card.domain "' + card.domain + '" does not match the file name "' + o.domain + '"');
  if (!Number.isInteger(card.version) || card.version < 1) problems.push('card.version must be an integer >= 1');
  if (!isText(card.created) || !/^\d{4}-\d{2}-\d{2}/.test(card.created)) problems.push('card.created must be an ISO date (YYYY-MM-DD)');
  if (!Array.isArray(card.sources) || !card.sources.length) problems.push('card.sources must list at least one source that was actually read');
  else card.sources.forEach((s, i) => problems.push(...shapeProblems(s, S.sources.items, 'card.sources[' + i + ']'), ...locatorProblems(s, 'card.sources[' + i + ']')));
  if (!Array.isArray(card.checks) || card.checks.length < 1 || card.checks.length > 12) problems.push('card.checks must hold 1..12 checks (cards stay small)');
  const ids = new Set();
  (Array.isArray(card.checks) ? card.checks : []).forEach((ch, i) => {
    const w = 'checks[' + i + ']';
    problems.push(...shapeProblems(ch, S.checks.items, w));
    if (!ch || typeof ch !== 'object') return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(ch.id))) problems.push(w + '.id must be a slug');
    if (ids.has(ch.id)) problems.push(w + '.id "' + ch.id + '" is a duplicate');
    ids.add(ch.id);
    if (!S.checks.items.properties.severity.enum.includes(ch.severity)) problems.push(w + '.severity "' + ch.severity + '" is not block|warn');
    problems.push(...shapeProblems(ch.source, PCITE, w + '.source'), ...locatorProblems(ch.source, w + '.source'));
  });
  if (!Array.isArray(card.hard_gates)) problems.push('card.hard_gates must be an array');
  else card.hard_gates.forEach((g, i) => { problems.push(...shapeProblems(g, S.hard_gates.items, 'hard_gates[' + i + ']')); if (g && typeof g === 'object') problems.push(...shapeProblems(g.source, PCITE, 'hard_gates[' + i + '].source'), ...locatorProblems(g.source, 'hard_gates[' + i + '].source')); });
  for (const k of ['not_applicable_when', 'gaps']) {
    if (!Array.isArray(card[k])) problems.push('card.' + k + ' must be an array (empty is allowed)');
    else if (!card[k].every(isText)) problems.push('card.' + k + ' must hold non-empty strings');
  }
  resultFieldProblems(card, 'card', problems);
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
/** loadProvisionalCard(root, domain) -> {card, path, rel, sha256} | {error} | null. */
function loadProvisionalCard(root, domain) {
  if (typeof domain !== 'string' || !SLUG_RE.test(domain)) return null;
  const p = path.join(provisionalCardDir(root), domain + '.json');
  if (!fs.existsSync(p)) return null;
  const rel = path.relative(root, p).split(path.sep).join('/');
  const raw = fs.readFileSync(p, 'utf8');
  try { return { card: JSON.parse(raw), path: p, rel, sha256: sha256(raw) }; } catch (e) { return { error: rel + ' is not valid JSON: ' + e.message, path: p, rel }; }
}
/** listProvisionalCards(root) -> [{domain, checks, valid, problems}] sorted by domain. */
function listProvisionalCards(root) {
  let files = [];
  try { files = fs.readdirSync(provisionalCardDir(root)).filter((f) => f.endsWith('.json')).sort(); } catch { files = []; }
  return files.map((f) => {
    const domain = f.replace(/\.json$/, '');
    const r = loadProvisionalCard(root, domain);
    if (!r || r.error) return { domain, checks: 0, valid: false, problems: [r ? r.error : 'unreadable or not a slug name'] };
    const v = validateProvisionalCard(r.card, { domain, root });
    return { domain, checks: Array.isArray(r.card.checks) ? r.card.checks.length : 0, valid: v.ok, problems: v.problems };
  });
}
const PROVISIONAL_BANNER = (card) => [
  '==================== PROVISIONAL ====================',
  'PROVISIONAL quality card for "' + card.domain + '" (created ' + card.created + '): derived for a project type without a Forge playbook; it is not a reviewed playbook.',
  'UNVERIFIED-SOURCES: this tool cannot check the cited web pages or files; it only checked that every check cites one. Judge each source before trusting a check.',
  'The generic card (gate --domain generic) applies on top.',
  '=====================================================',
];
const fallbackNotice = (d) => 'no playbook for ' + d + '; showing the GENERIC card; run forge-domain-discovery to derive a provisional card';

/** renderGate(card, meta, {json}) -> the checklist Verify Boss fills in. Deterministic: no clock, no randomness.
 *  meta.provisional -> banner + UNVERIFIED-SOURCES (no citation check); meta.fallback -> the generic-card notice first. */
function renderGate(card, meta, opts) {
  const cit = meta.citations;
  if (opts && opts.json) {
    const out = {
      domain: card.domain, version: card.version, card: meta.rel, card_sha256: meta.sha256, marks: GATE_MARKS,
      instructions: 'Mark every check PASS, FAIL or NOT_RUN with evidence. A block check that is FAIL or NOT_RUN fails the gate; a warn check is reported. This output claims nothing passed.',
      citations: { ok: cit.ok, checked: cit.checked, problems: cit.problems },
      checks: card.checks.map((c) => Object.assign({}, c, { status: null, evidence: null })),
      hard_gates: card.hard_gates, not_applicable_when: card.not_applicable_when, gaps: card.gaps,
    };
    if (meta.provisional) Object.assign(out, { provisional: true, created: card.created, sources: card.sources, sources_status: 'UNVERIFIED-SOURCES', banner: PROVISIONAL_BANNER(card).slice(1, -1) });
    if (meta.fallback) out.fallback = { requested: meta.fallback.requested, notice: fallbackNotice(meta.fallback.requested) };
    return JSON.stringify(out, null, 2);
  }
  const L = [];
  if (meta.fallback) { L.push(fallbackNotice(meta.fallback.requested)); L.push('  (node .claude/forge-bin/forge-domain-discovery.cjs classify --text "<project description>", then brief --name ' + meta.fallback.requested + ')'); L.push(''); }
  if (meta.provisional) { L.push(...PROVISIONAL_BANNER(card)); L.push(''); }
  L.push('Quality gate: ' + card.domain + ' (card v' + card.version + ', ' + meta.rel + ', sha256 ' + meta.sha256.slice(0, 12) + ')');
  L.push('Sources: ' + (card.source || card.sources).map((s) => (s.url || s.path) + (s.section ? ' § ' + s.section : '')).join('; '));
  if (!cit.ok && !meta.provisional) { L.push('STALE CARD: ' + cit.problems.length + ' citation(s) no longer match the playbook — report this, judge the checks with care:'); for (const p of cit.problems) L.push('  - ' + p); }
  L.push('');
  L.push('Verify Boss: mark every check PASS / FAIL / NOT_RUN with evidence (the command and its output, a screenshot path, a run id).');
  L.push('A block check that is FAIL or NOT_RUN fails the gate; a warn check is reported. This list claims nothing passed.');
  L.push('');
  for (const c of card.checks) {
    L.push('[ ] ' + c.id + '  (' + c.severity + ')');
    L.push('    claim:    ' + c.claim);
    L.push('    evidence: ' + c.evidence_required);
    L.push('    run:      ' + c.how_to_run);
    L.push('    honesty:  ' + c.honesty_note);
    L.push('    source:   ' + citeText(c.source));
  }
  L.push('');
  L.push('Hard gates (confirm none was bypassed):' + (card.hard_gates.length ? '' : ' none beyond the shared gates'));
  for (const g of card.hard_gates) L.push('  - ' + g.gate + '  [' + citeText(g.source) + ']');
  L.push('Not applicable when:' + (card.not_applicable_when.length ? '' : ' (none listed)'));
  for (const n of card.not_applicable_when) L.push('  - ' + n);
  L.push('Gaps (no verifiable gate in the playbook):' + (card.gaps.length ? '' : ' none found'));
  for (const g of card.gaps) L.push('  - ' + g);
  L.push('Shared gates for every playbook: .claude/docs/forge-reference/playbook-template.md (Shared gates).');
  return L.join('\n');
}

/** gateCli(rest, root) -> exit code; prints to stdout/stderr. */
function gateCli(rest, root) {
  const has = (f) => rest.includes(f);
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  const r0 = val('--root') || root;
  const json = has('--json');
  if (has('--schema')) { console.log(JSON.stringify(GATE_CARD_SCHEMA, null, 2)); return 0; }
  if (has('--list')) {
    const cards = listGateCards(r0);
    const prov = listProvisionalCards(r0);
    if (json) console.log(JSON.stringify({ cards, provisional: prov }, null, 2));
    else {
      console.log('Quality gate cards (' + cards.length + '):'); for (const c of cards) console.log('  ' + c.domain.padEnd(12) + ' ' + c.checks + ' checks (' + c.block + ' block, ' + c.warn + ' warn)' + (c.valid ? '' : '  INVALID: ' + c.problems.join('; ')));
      if (prov.length) { console.log('PROVISIONAL cards in this project (' + prov.length + ', unreviewed):'); for (const c of prov) console.log('  ' + c.domain.padEnd(12) + ' ' + c.checks + ' checks' + (c.valid ? '' : '  INVALID: ' + c.problems.join('; '))); }
    }
    return 0;
  }
  const domain = val('--domain');
  if (!domain) { console.error('usage: node forge-quality.cjs gate --domain <domain> [--json] | gate --list [--json] | gate --schema'); return 2; }
  const known = listGateCards(r0).map((c) => c.domain);
  if (!SLUG_RE.test(domain)) { console.error('no quality gate card for domain "' + domain + '": a domain is a slug (a-z, 0-9, -). Known domains: ' + (known.join(', ') || '(none)')); return 2; }
  const r = loadGateCard(r0, domain);
  if (r) {
    if (r.error) { console.error('gate card unreadable: ' + r.error); return 3; }
    const v = validateGateCard(r.card, { domain });
    if (!v.ok) { console.error('gate card ' + r.rel + ' is invalid (fix the card, nothing is listed):\n  - ' + v.problems.join('\n  - ')); return 3; }
    console.log(renderGate(r.card, { rel: r.rel, sha256: r.sha256, citations: verifyGateCitations(r.card, r0) }, { json }));
    return 0;
  }
  const pr = loadProvisionalCard(r0, domain);
  if (pr) {
    if (pr.error) { console.error('provisional card unreadable: ' + pr.error); return 3; }
    const pv = validateProvisionalCard(pr.card, { domain, root: r0 });
    if (!pv.ok) { console.error('provisional card ' + pr.rel + ' is invalid (fix it with forge-domain-discovery.cjs validate-card; nothing is listed):\n  - ' + pv.problems.join('\n  - ')); return 3; }
    console.log(renderGate(pr.card, { rel: pr.rel, sha256: pr.sha256, citations: { ok: null, checked: 0, problems: [] }, provisional: true }, { json }));
    return 0;
  }
  const g = loadGateCard(r0, GENERIC_DOMAIN);
  if (!g) { console.error('no quality gate card for domain "' + domain + '" and no generic card in this install (' + gateCardDir(r0) + '). Known domains: ' + (known.join(', ') || '(none)')); return 2; }
  if (g.error) { console.error('generic card unreadable: ' + g.error); return 3; }
  const gv = validateGateCard(g.card, { domain: GENERIC_DOMAIN });
  if (!gv.ok) { console.error('generic card ' + g.rel + ' is invalid (fix the card, nothing is listed):\n  - ' + gv.problems.join('\n  - ')); return 3; }
  if (json) console.error(fallbackNotice(domain));
  console.log(renderGate(g.card, { rel: g.rel, sha256: g.sha256, citations: verifyGateCitations(g.card, r0), fallback: { requested: domain } }, { json }));
  return 0;
}

module.exports = {
  loadCatalog, catalogDrift, compileMissionProfile, evaluateLenses, mineOmissions,
  validateRequirementCard, qualityKernel, buildMissionPack, selectKnowledgeCards,
  councilTrigger, validateCouncilRecord, sha256, configOn, configRead, COUNCIL_OFF_REASON,
  loadKnowledgeCard, analyzeMission, persistCouncilRecord,
  GATE_CARD_SCHEMA, GATE_MARKS, validateGateCard, verifyGateCitations, loadGateCard, listGateCards, renderGate,
  GENERIC_DOMAIN, PROVISIONAL_CARD_SCHEMA, validateProvisionalCard, loadProvisionalCard, listProvisionalCards, provisionalCardDir,
  DISPOSITIES, SOURCE_TYPES, PRIMARY_VOLGORDE,
};

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = CONFIG_ROOT; // reads; a write below needs SCRIPT_ROOT (or --root) and is refused without one
  const NO_ROOT = 'forge-quality: no project root found (no .claude, .forge or .git above the current folder) — refused, nothing is written beside this script';
  if (cmd === 'drift') {
    const d = catalogDrift(root);
    console.log(JSON.stringify(d, null, 2));
    process.exitCode = d.ok ? 0 : 3;
  } else if (cmd === 'profile') {
    console.log(JSON.stringify(compileMissionProfile(rest.join(' '), {}), null, 2));
  } else if (cmd === 'analyze') {
    /** F-14: het ene entrypoint voor de router — de hele keten in één JSON-uitvoer.
     *  F-37: met --log-run <run_id> wordt het counciltrigger-besluit (mode + trigger_reason) via de
     *  ECHTE eventwriter als decision_logged gelogd — óók bij NONE; de instructie in de router-SKILL
     *  heeft daarmee een uitvoerbaar pad. --root maakt het E2E-testbaar op een tijdelijke root. */
    let analyseRoot = root, logRun = null;
    const missieDelen = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--root') { analyseRoot = rest[++i]; }
      else if (rest[i] === '--log-run') { logRun = rest[++i]; }
      else missieDelen.push(rest[i]);
    }
    const uitkomst = analyzeMission(missieDelen.join(' '), { root: analyseRoot });
    console.log(JSON.stringify(uitkomst, null, 2));
    if (logRun && analyseRoot === root && !SCRIPT_ROOT) { console.error(NO_ROOT); process.exitCode = 3; }
    else if (logRun) {
      const writer = path.join(analyseRoot, '.claude', 'forge-dashboard', 'log-event.cjs');
      const extra = JSON.stringify({ agent: 'forge-router', note: 'councilTrigger-besluit: mode=' + uitkomst.council.mode + ' — ' + uitkomst.council.trigger_reason, decision: 'council-mode-' + uitkomst.council.mode });
      const rr = require('child_process').spawnSync(process.execPath, [writer, logRun, 'decision_logged', extra], { encoding: 'utf8' });
      if (rr.status !== 0) { console.error('decision_logged niet gelogd: ' + ((rr.stderr || '') + (rr.stdout || '')).slice(0, 300)); process.exitCode = 3; }
    }
  } else if (cmd === 'card') {
    const kaartRes = loadKnowledgeCard(root, rest[0] || '');
    if (!kaartRes) { console.error('kaart "' + (rest[0] || '') + '" bestaat niet (eerlijk afwezig — zie config/quality/cards/)'); process.exitCode = 3; }
    else console.log(kaartRes.content);
  } else if (cmd === 'council-save') {
    /** F-36: parse-succes staat los van de JSON-waarde — null/false/0/"" zijn geldig geparsede
     *  waarden die de validator moet weigeren, geen stil succes. */
    const [runId, recPad] = rest;
    let rec; let geparsed = false;
    try { rec = JSON.parse(fs.readFileSync(recPad, 'utf8')); geparsed = true; } catch (e) { console.error('record onleesbaar: ' + e.message); process.exitCode = 3; }
    if (geparsed && !SCRIPT_ROOT) { console.error(NO_ROOT); process.exitCode = 3; }
    else if (geparsed) {
      const uit = persistCouncilRecord(SCRIPT_ROOT, runId, rec);
      console.log(JSON.stringify(uit, null, 2));
      process.exitCode = uit.ok ? 0 : 3;
    }
  } else if (cmd === 'gate') {
    process.exitCode = gateCli(rest, root);
  } else if (cmd === 'kernel') {
    console.log(qualityKernel());
  } else {
    console.log('usage: node forge-quality.cjs drift | profile "<missie>" | analyze "<missie>" | card <slug> | gate --domain <d> [--json] | gate --list | gate --schema | council-save <run_id> <record.json> | kernel');
    process.exitCode = 2;
  }
}
