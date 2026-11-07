#!/usr/bin/env node
'use strict';
/**
 * forge-quality.test.cjs — de Quality Intelligence Layer (masterprompt 2026-08-11).
 *
 * RED-BASELINE (gemeten vóór implementatie): Forge had VIER seams met VIER verschillende
 * domeinlijsten — router-playbooks 23, required-evidence 26, intake-packs 11 (waaronder `dashboard`,
 * dat geen routerdomein is), domain-presets 7. Niets detecteerde die drift. Er bestond geen
 * MissionProfile (missies gingen als vrije tekst de router in), geen expliciete kwaliteitslenzen
 * (dimensies als toegankelijkheid of operations werden stilzwijgend overgeslagen in plaats van
 * gemotiveerd gedispositioneerd), en geen omission mining (vergeten eisen bleven vergeten).
 *
 * Deze suite is geschreven VOOR forge-quality.cjs bestond en faalde integraal — elke test hier dwingt
 * een binding af die anders alleen op papier zou bestaan (de les van tien reviewrondes).
 *
 * F-22 (Codex herreview, eerlijkheidscorrectie): die RED-chronologie van 2026-08-11 is SELF-REPORTED —
 * het 0/31-resultaat is destijds niet commitgebonden vastgelegd (geen pre-implementatie testblob,
 * exitcode of outputhash), dus achteraf niet bewijsbaar. Vanaf reparatieronde 2 geldt het omgekeerde
 * patroon: nieuwe handhavingstests worden EERST gecommit met een vastgelegde RED-run (argv + exitcode +
 * outputhash + testbestand-blobhash) en pas daarna geïmplementeerd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

const ROOT = path.resolve(__dirname, '..', '..');

// Hermetische eigenaarsinstellingen (forge-config.cjs): de globale settings uit een wegwerp-home (nooit
// ~/.claude) en FORGE_PROJECT_ROOT op een LEGE fixture, zodat councilTrigger in elke test hieronder (ook in de
// gespawnde CLI's, die process.env erven) op de schema-default `auto` draait wat de echte instellingen ook zeggen.
const CFG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-cfghome-'));
const CFG_LEEG = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-cfgproj-'));
process.env.FORGE_CONFIG_HOME = CFG_HOME;
process.env.FORGE_PROJECT_ROOT = CFG_LEEG;
let Q = null;
try { Q = require(path.join(__dirname, 'forge-quality.cjs')); } catch { /* RED: module bestaat nog niet */ }

console.log('forge-quality (Quality Intelligence Layer)');

t('0 de module forge-quality.cjs bestaat en is laadbaar', !!Q);
if (!Q) { console.log('\n' + pass + ' passed, ' + (fail + 30) + ' failed (module ontbreekt — alle overige tests impliciet RED)'); process.exit(1); }

// ---- 1) domeincatalogus: ÉÉN bron, drift wordt gedetecteerd i.p.v. gedragen
{
  const cat = Q.loadCatalog(ROOT);
  t('1 de catalogus laadt en heeft domeinen', !!cat && cat.domains && Object.keys(cat.domains).length >= 20);
  // elke router-playbook heeft een catalogusdomein — de catalogus is de bron, niet een vijfde kopie
  const playbooks = fs.readdirSync(path.join(ROOT, '.claude', 'skills')).filter((d) => /^forge-(website|fullstack|n8n|scraping|rag|prediction|integration|agent|api|bots|cli|cms|data|ecommerce|electron|extension|figma|game|migration|mlops|mobile|payments|voice)$/.test(d)).map((d) => d.replace(/^forge-/, ''));
  const ontbrekend = playbooks.filter((p) => !cat.domains[p]);
  t('1 elk router-playbook-domein staat in de catalogus', ontbrekend.length === 0, 'mist: ' + ontbrekend.join(', '));
  const drift = Q.catalogDrift(ROOT);
  t('1 driftdetectie levert een rapport per seam', !!drift && Array.isArray(drift.seams) && drift.seams.length >= 4);
  const seamNamen = drift.seams.map((s) => s.seam);
  for (const verwacht of ['router-playbooks', 'required-evidence', 'intake-packs', 'domain-presets']) {
    t('1 seam "' + verwacht + '" wordt gecontroleerd', seamNamen.includes(verwacht));
  }
  // de BEKENDE drift moet gerapporteerd worden, niet weggemoffeld: intake kent `dashboard` dat geen
  // routerdomein is — dat is precies het soort scheefgroei dat de catalogus zichtbaar moet maken
  const intakeSeam = drift.seams.find((s) => s.seam === 'intake-packs');
  t('1 de bekende drift (intake kent dashboard, router niet) is zichtbaar in het rapport',
    !!intakeSeam && JSON.stringify(intakeSeam).includes('dashboard'), JSON.stringify(intakeSeam || {}).slice(0, 200));
}

// ---- 2) MissionProfile: multi-label, machineleesbaar, met de verplichte velden
{
  const profiel = Q.compileMissionProfile('Bouw een mobiele trading-app met live koersdata en portfolio-API', {});
  const velden = ['project_type', 'lifecycle_stage', 'user_outcome', 'criticality', 'users', 'core_flows', 'constraints', 'trust_boundaries', 'existing_evidence', 'unknowns', 'assumptions', 'owner_gates', 'research_gaps', 'council_mode'];
  const mist = velden.filter((v) => profiel[v] === undefined);
  t('2 het profiel draagt alle verplichte velden', mist.length === 0, 'mist: ' + mist.join(', '));
  t('2 project_type is MULTI-label', Array.isArray(profiel.project_type) && profiel.project_type.length >= 2, JSON.stringify(profiel.project_type));
  t('2 een trading-app krijgt mobile én finance-achtige labels',
    profiel.project_type.includes('mobile') && profiel.project_type.some((l) => /финанс|finance|trading|prediction/i.test(l)), JSON.stringify(profiel.project_type));
  t('2 en een primary domain blijft router-compatibel', typeof profiel.primary_domain === 'string' && profiel.primary_domain.length > 0);

  const web = Q.compileMissionProfile('Maak een leadgeneratie-website voor een schildersbedrijf met contactformulier', {});
  t('2 een leadgen-website krijgt website als primary', web.primary_domain === 'website', web.primary_domain);
  const rag = Q.compileMissionProfile('Bouw een RAG-assistent die onze interne docs doorzoekt via een API', {});
  t('2 een RAG-assistent krijgt rag én api', rag.project_type.includes('rag') && rag.project_type.includes('api'), JSON.stringify(rag.project_type));
  const n8n = Q.compileMissionProfile('n8n-workflow die betalingen van Stripe naar de boekhouding synct', {});
  t('2 een n8n-betaalflow krijgt n8n én payments', n8n.project_type.includes('n8n') && n8n.project_type.includes('payments'), JSON.stringify(n8n.project_type));
}

// ---- 3) kwaliteitslenzen: 10, elk met EXACT één disposition en een reden
{
  const profiel = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier', {});
  const lenzen = Q.evaluateLenses(profiel);
  t('3 er zijn precies 10 lenzen', Array.isArray(lenzen) && lenzen.length === 10, String(lenzen && lenzen.length));
  const geldig = new Set(['RELEVANT', 'NOT_APPLICABLE', 'DEFERRED', 'OWNER_GATED']);
  t('3 elke lens heeft een geldige disposition', lenzen.every((l) => geldig.has(l.disposition)));
  t('3 elke lens heeft een concrete reden (geen stil overslaan)', lenzen.every((l) => typeof l.reason === 'string' && l.reason.trim().length >= 10));
  t('3 een leadgen-website heeft UX/toegankelijkheid RELEVANT', (lenzen.find((l) => /ux|toeganke/i.test(l.lens)) || {}).disposition === 'RELEVANT');
}

// ---- 4) omission miner: vijf assen, kaarten als uitkomst
{
  const profiel = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier voor een schildersbedrijf', { has_form: true, has_physical_location: false, tracking: 'none', indexable: true });
  const kaarten = Q.mineOmissions(profiel);
  t('4 de miner levert requirement cards', Array.isArray(kaarten) && kaarten.length >= 8, String(kaarten && kaarten.length));
  const assen = new Set(kaarten.map((k) => k.axis));
  for (const as of ['lifecycle', 'states', 'roles', 'operations', 'trust-boundaries']) {
    t('4 as "' + as + '" wordt gemijnd', assen.has(as));
  }
  t('4 elke kaart heeft id/requirement/reason/priority/source_type',
    kaarten.every((k) => k.id && k.requirement && k.reason && k.priority && k.source_type));
}

// ---- 5) requirement-card-validatie: een hypothese wordt nooit stilzwijgend een harde eis
{
  const basis = { id: 'q-1', source_type: 'INFERRED_FROM_STANDARD', trigger: 'x', requirement: 'y', reason: 'z', failure_mode: 'f', priority: 'P2', metric: 'm', evidence_gate: 'g', scope: 's', rollback: 'r', disposition: 'RELEVANT', status: 'proposed' };
  t('5 een geldige kaart valideert', Q.validateRequirementCard(basis).ok === true);
  t('5 een kaart zonder reason valideert NIET', Q.validateRequirementCard(Object.assign({}, basis, { reason: '' })).ok === false);
  const hypo = Object.assign({}, basis, { source_type: 'RESEARCH_HYPOTHESIS', priority: 'P0' });
  const rv = Q.validateRequirementCard(hypo);
  t('5 een RESEARCH_HYPOTHESIS mag geen P0/P1 harde eis zijn zonder bevestiging', rv.ok === false && /bevestig|confirm|valida/i.test(rv.reden || ''), JSON.stringify(rv));
  t('5 dezelfde hypothese als P3 mag wel', Q.validateRequirementCard(Object.assign({}, hypo, { priority: 'P3' })).ok === true);
}

// ---- 6) websitefixture: relevante punten ONTDEKKEN én irrelevante AFWIJZEN
{
  const profiel = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier voor een schildersbedrijf', { has_form: true, has_physical_location: false, tracking: 'none', indexable: true });
  const kaarten = Q.mineOmissions(profiel);
  const vind = (re) => kaarten.find((k) => re.test(k.requirement + ' ' + (k.trigger || '')));
  t('6 CTA wordt ontdekt', !!vind(/\bcta\b|call.?to.?action/i));
  t('6 succes-/thank-you-state van het formulier wordt ontdekt', !!vind(/thank|succes|bevestig/i));
  t('6 robots/sitemap wordt ontdekt (indexeerbaar)', !!vind(/robots|sitemap/i));
  t('6 formulier-foutafhandeling en duplicate submit worden ontdekt', !!vind(/duplicate|dubbel/i) && !!vind(/fout|error/i));
  const maps = kaarten.find((k) => /maps|route|adres|locatie/i.test(k.requirement));
  t('6 GEEN fysieke locatie => maps is NOT_APPLICABLE (niet stil toegevoegd, niet vergeten)',
    !!maps && maps.disposition === 'NOT_APPLICABLE', JSON.stringify(maps || 'ONTBREEKT').slice(0, 160));
  const analytics = kaarten.find((k) => /analytics|ga4|tracking/i.test(k.requirement));
  t('6 GEEN trackingconfig => analytics wordt niet stil toegevoegd (OWNER_GATED)',
    !!analytics && analytics.disposition === 'OWNER_GATED', JSON.stringify(analytics || 'ONTBREEKT').slice(0, 160));
  // en een fixture MET locatie draait de dispositie om — de miner is contextueel, geen checklist
  const metLocatie = Q.mineOmissions(Q.compileMissionProfile('Website voor een kapsalon met winkeladres en openingstijden', { has_form: false, has_physical_location: true, tracking: 'none', indexable: true }));
  const maps2 = metLocatie.find((k) => /maps|route|adres|locatie/i.test(k.requirement));
  t('6 MET fysieke locatie is maps RELEVANT', !!maps2 && maps2.disposition === 'RELEVANT', JSON.stringify(maps2 || 'ONTBREEKT').slice(0, 160));
}

// ---- 7) contextcompiler: kernel klein, mission pack begrensd, cards on-demand
{
  const kernel = Q.qualityKernel();
  const tokens = Math.ceil(kernel.length / 4);
  t('7 de Quality Kernel bestaat en is ~600-800 tokens (max 800)', tokens > 100 && tokens <= 800, tokens + ' tokens (geschat)');
  for (const kern of [/outcome/i, /omissi/i, /bewijs|evidence/i, /onafhankelijk|independent/i]) {
    t('7 de kernel draagt de invariant ' + kern, kern.test(kernel));
  }
  const profiel = Q.compileMissionProfile('Maak een leadgeneratie-website', { has_form: true });
  const pack = Q.buildMissionPack(profiel, { requirements: Q.mineOmissions(profiel).slice(0, 10), decisions: [], work_package: 'WP1', open_findings: [] });
  const woorden = pack.split(/\s+/).length;
  t('7 het Active Mission Pack blijft onder ~2000 woorden', woorden > 50 && woorden <= 2000, woorden + ' woorden');
  const kaartSelectie = Q.selectKnowledgeCards(profiel, ROOT);
  t('7 kaartselectie levert alleen RELEVANTE domeinen', Array.isArray(kaartSelectie) && kaartSelectie.length >= 1 && kaartSelectie.length <= 6, JSON.stringify(kaartSelectie));
  t('7 een website-missie laadt GEEN mlops-kaart', !kaartSelectie.some((c) => /mlops|trading|prediction/i.test(c && c.slug ? c.slug : String(c))));
  // F-20: kaartselectie levert GEVALIDEERDE descriptors, geen kale slugstrings
  t('7 F-20 elke selectie is een descriptor met slug/path/exists/relevance', kaartSelectie.every((c) => c && typeof c.slug === 'string' && typeof c.path === 'string' && typeof c.exists === 'boolean' && typeof c.relevance === 'number'), JSON.stringify(kaartSelectie).slice(0, 200));
  t('7 F-20 de ranking is deterministisch: de primary staat voorop', kaartSelectie.length > 0 && kaartSelectie[0].slug === profiel.primary_domain, JSON.stringify(kaartSelectie[0] || {}));
  const webKaart = kaartSelectie.find((c) => c.slug === 'website');
  t('7 F-20 de website-kaart BESTAAT op schijf en draagt een kloppende sha256', !!webKaart && webKaart.exists === true && /^[0-9a-f]{64}$/.test(webKaart.sha256 || '') && webKaart.sha256 === Q.sha256(fs.readFileSync(path.join(ROOT, webKaart.path), 'utf8')), JSON.stringify(webKaart || {}).slice(0, 200));
}

// ---- 8) council-trigger: deterministisch, selectief, en nooit op simpele taken
{
  const simpel = Q.councilTrigger({ decision_impact: 'low', uncertainty: 'low', reversibility: 'high', credible_options: 1, criticality: 'low', explicit_request: false });
  t('8 een simpele deterministische taak triggert GEEN council', simpel.mode === 'NONE', JSON.stringify(simpel));
  const expliciet = Q.councilTrigger({ decision_impact: 'low', uncertainty: 'low', reversibility: 'high', credible_options: 1, criticality: 'low', explicit_request: true });
  t('8 een expliciete gebruikersvraag triggert FULL', expliciet.mode === 'FULL');
  const zwaar = Q.councilTrigger({ decision_impact: 'high', uncertainty: 'high', reversibility: 'low', credible_options: 3, criticality: 'high', explicit_request: false });
  t('8 hoge impact + hoge onzekerheid + moeilijk omkeerbaar triggert FULL', zwaar.mode === 'FULL');
  t('8 elke uitkomst draagt een trigger_reason', [simpel, expliciet, zwaar].every((x) => typeof x.trigger_reason === 'string' && x.trigger_reason.length > 5));
  const record = Q.validateCouncilRecord({ council_id: 'c1', trigger: zwaar, context_hash: 'a'.repeat(64), participants: [{ role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1' }], responses: [], quorum: { required: 5, present: 1 }, status: 'INCOMPLETE' });
  t('8 een onvolledig quorum wordt eerlijk INCOMPLETE gevalideerd', record.ok === true);
  const nep = Q.validateCouncilRecord({ council_id: 'c2', trigger: zwaar, context_hash: 'x', participants: [{ role: 'contrarian' }], responses: [{}], quorum: { required: 5, present: 5 }, status: 'COMPLETE' });
  t('8 een deelnemer ZONDER echte dispatch-provenance wordt geweigerd', nep.ok === false, JSON.stringify(nep));
}

// ---- 8b) REPARATIERONDE 1 (Codex batch-1-review F-01..F-13): elke fix een test die faalt als hij wegvalt
{
  const os2 = require('os');
  // F-06: de missietekst is zelf een contextbron
  const ga4 = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier en GA4-tracking', {});
  t('8b F-06 has_form wordt uit de missietekst afgeleid', ga4.context.has_form === true);
  t('8b F-06 een expliciete GA4-vraag wordt herkend als tracking-intentie', ga4.context.tracking === 'requested');
  const ga4k = Q.mineOmissions(ga4);
  const thank = ga4k.find((x) => /thank|succes|bevestig/i.test(x.requirement));
  t('8b F-06 de thank-you-flow wordt nu WEL ontdekt (formulier uit tekst)', !!thank && thank.disposition === 'RELEVANT');
  const ana = ga4k.find((x) => /analytics|ga4/i.test(x.requirement));
  t('8b F-06 expliciet gevraagde GA4 blijft OWNER_GATED (grondslag onbekend) met source EXPLICIT',
    !!ana && ana.disposition === 'OWNER_GATED' && ana.source_type === 'EXPLICIT', JSON.stringify(ana || {}).slice(0, 160));
  t('8b F-06 en expliciete ctx WINT van afleiding',
    Q.compileMissionProfile('site met contactformulier', { has_form: false }).context.has_form === false);
  const cliK = Q.mineOmissions(Q.compileMissionProfile('Bouw een CLI-tool die lokale bestanden hernoemt', {}));
  const aanval = cliK.find((x) => /aanvaller|kwaadwillende/i.test(x.requirement + x.reason));
  t('8b F-06 een CLI zonder publieke ingang krijgt aanvallerskaart NOT_APPLICABLE', !!aanval && aanval.disposition === 'NOT_APPLICABLE', JSON.stringify(aanval || {}).slice(0, 140));
  // F-02: webshop -> ecommerce; softwareproduct niet meer ecommerce; onbekend blijft benoemd onbekend
  t('8b F-02 een webshop-missie krijgt primary ecommerce', Q.compileMissionProfile('Bouw een webshop voor sieraden', {}).primary_domain === 'ecommerce');
  t('8b F-02 softwareproduct is niet langer ecommerce', !Q.compileMissionProfile('Verbeter ons softwareproduct', {}).project_type.includes('ecommerce'));
  const onbekend = Q.compileMissionProfile('Optimaliseer de quantumfluxcapacitor', {});
  t('8b F-02 een onherkende missie meldt de fallback als AANNAME in unknowns',
    onbekend.classification_confidence === 'none' && onbekend.unknowns.some((u) => /aanname|niet herkend/i.test(u)), JSON.stringify(onbekend.unknowns));
  // F-04: lege/vormloze bevestiging telt niet; disposition verplicht
  const hypoBasis = { id: 'h1', source_type: 'RESEARCH_HYPOTHESIS', requirement: 'y', reason: 'z', priority: 'P0', disposition: 'RELEVANT', status: 'proposed' };
  t('8b F-04 confirmed_by leeg telt niet', Q.validateRequirementCard(Object.assign({}, hypoBasis, { confirmed_by: '' })).ok === false);
  t('8b F-04 confirmed_by zonder ref telt niet', Q.validateRequirementCard(Object.assign({}, hypoBasis, { confirmed_by: { type: 'experiment', ref: '' } })).ok === false);
  t('8b F-04 een GESTRUCTUREERDE bevestiging telt wel', Q.validateRequirementCard(Object.assign({}, hypoBasis, { confirmed_by: { type: 'experiment', ref: 'bench-2026-08-11.json' } })).ok === true);
  t('8b F-04 een kaart ZONDER disposition valideert niet', Q.validateRequirementCard(Object.assign({}, hypoBasis, { priority: 'P3', disposition: undefined })).ok === false);
  // F-03: shape-only wordt eerlijk gemeld; quorum gebonden aan deelnemers
  const geldigRec = { council_id: 'c1', trigger: {}, context_hash: 'a'.repeat(64), participants: [{ role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1' }], responses: [], quorum: { required: 5, present: 1 }, status: 'INCOMPLETE' };
  const vr = Q.validateCouncilRecord(geldigRec);
  t('8b F-03 een geldig record zegt ZELF dat het shape-only is', vr.ok === true && vr.shape_only === true && /owner-gated/i.test(vr.caveat || ''));
  t('8b F-03 quorum.present > deelnemers wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, geldigRec, { quorum: { required: 5, present: 3 } })).ok === false);
  // F-05: mutatieprobe — drift ziet nu ook EXTRA playbooks
  const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'qi-drift-'));
  fs.mkdirSync(path.join(tmp, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'config', 'intake'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'forge-website'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'forge-onbekend'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify({ version: 1, domains: { website: { playbook: 'forge-website', intake_pack: null, preset: false, keywords: ['website'] } }, non_domain_skills: [] }));
  const d2 = Q.catalogDrift(tmp);
  const router2 = d2.seams.find((x) => x.seam === 'router-playbooks');
  t('8b F-05 een forge-skill die de catalogus niet kent is EXTRA drift', router2.extra_in_seam.includes('forge-onbekend'), JSON.stringify(router2));
  t('8b F-05 en het eindoordeel is dan niet ok', d2.ok === false);
  fs.rmSync(tmp, { recursive: true, force: true });
  // F-08: onbekende labels laden geen kaarten
  const raarProfiel = Object.assign({}, Q.compileMissionProfile('website', {}), { project_type: ['not-a-label', 'website'], primary_domain: 'not-a-label' });
  const kaarten2 = Q.selectKnowledgeCards(raarProfiel, ROOT);
  const slugs2 = kaarten2.map((c) => (c && c.slug) ? c.slug : c);
  t('8b F-08 een onbekend label wordt uitgefilterd', !slugs2.includes('not-a-label') && slugs2.includes('website'), JSON.stringify(slugs2));
  // F-01: de router-skill consumeert de laag (geen dormante module) — de GEDRAGStest staat in 8c (subprocess-E2E)
  const routerSkill = fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'forge-router', 'SKILL.md'), 'utf8');
  t('8b F-01 de router-skill bindt aan het uitvoerbare analyze-entrypoint', /forge-quality\.cjs analyze/.test(routerSkill));
  t('8b F-01 en verwijst kaartvalidatie/council naar deze module', /validateRequirementCard|omissions/.test(routerSkill) && /councilTrigger/.test(routerSkill));
}

// ---- 8c) REPARATIERONDE 2 (Codex herreview F-14..F-24): GEDRAGStests — subprocess/fixture/mutatie,
// ---- geen bron-regex waar gedrag meetbaar is. Deze sectie is RED gecommit VOOR de implementatie
// ---- (het F-22-patroon: de RED-run is vastgelegd met argv, exitcode en outputhash).
{
  const os3 = require('os');
  const cp = require('child_process');

  // F-14: EEN uitvoerbaar analyse-entrypoint, gemeten door de echte CLI als subprocess te draaien
  const e2e = cp.spawnSync(process.execPath, [path.join(__dirname, 'forge-quality.cjs'), 'analyze', 'Maak een leadgeneratie-website voor een schildersbedrijf met contactformulier'], { encoding: 'utf8' });
  let e2eJson = null; try { e2eJson = JSON.parse(e2e.stdout); } catch { }
  t('8c F-14 de CLI `analyze` levert parseerbare JSON met exit 0', e2e.status === 0 && !!e2eJson, 'exit=' + e2e.status + ' :: ' + String(e2e.stderr || '').slice(0, 120));
  t('8c F-14 de analyse draagt profiel+playbook+lenzen+omissions+kaarten+council in EEN uitvoer',
    !!e2eJson && !!e2eJson.profile && e2eJson.profile.primary_domain === 'website' && e2eJson.playbook === 'forge-website'
    && Array.isArray(e2eJson.lenses) && e2eJson.lenses.length === 10
    && Array.isArray(e2eJson.omissions) && e2eJson.omissions.length >= 8
    && Array.isArray(e2eJson.knowledge_cards) && !!e2eJson.council && typeof e2eJson.council.mode === 'string',
    e2eJson ? JSON.stringify(Object.keys(e2eJson)) : 'geen json');
  t('8c F-14 elke omission uit de analyse valideert tegen de kaartvalidator', !!e2eJson && Array.isArray(e2eJson.omissions) && e2eJson.omissions.every((c) => Q.validateRequirementCard(c).ok === true));
  t('8c F-14 analyzeMission is ook als functie exporteerbaar (programmatische call-site)', typeof Q.analyzeMission === 'function');

  // F-15: expliciete word/phrase/stem-matching — Nederlandse samenstellingen matchen niet meer per ongeluk
  t('8c F-15 "softwareproducten" is GEEN ecommerce', !Q.compileMissionProfile('Wij verkopen kennis over softwareproducten', {}).project_type.includes('ecommerce'));
  t('8c F-15 "bijproducten" is GEEN ecommerce', !Q.compileMissionProfile('Analyseer de bijproducten van het productieproces', {}).project_type.includes('ecommerce'));
  t('8c F-15 "webshop-site" (gemengd) => primary ecommerce', Q.compileMissionProfile('Bouw een webshop-site met checkout', {}).primary_domain === 'ecommerce');
  t('8c F-15 een stam matcht verbuigingen: "beveiliging" => security-label', Q.compileMissionProfile('Verbeter de beveiliging van de website', {}).project_type.includes('security'));
  t('8c F-15 "mobiele" matcht het mobile-domein (stam)', Q.compileMissionProfile('Bouw een mobiele app voor hardlopers', {}).project_type.includes('mobile'));
  t('8c F-15 "voorspellingen" matcht prediction (stam)', Q.compileMissionProfile('Genereer voorspellingen voor voetbalwedstrijden', {}).project_type.includes('prediction'));
  t('8c F-15 lange keywords zijn geen substring meer: "leadlijst" wel, "deadlijst-loze" tekst niet als scraping', Q.compileMissionProfile('Bouw een leadlijst uit openbare bronnen', {}).project_type.includes('scraping') && !Q.compileMissionProfile('De handleiding bespreekt spiderdiagrammen', {}).project_type.includes('scraping'));

  // F-18: echte woordgrenzen (geen U+0008-bytes) + EEN gedeeld web-oppervlaktepredicate
  t('8c F-18 de module bevat geen letterlijke backspace-bytes', !/\x08/.test(fs.readFileSync(path.join(__dirname, 'forge-quality.cjs'), 'latin1')));
  const alleenGa4 = Q.compileMissionProfile('Voeg GA4 toe aan de site', {});
  t('8c F-18 "GA4" ALLEEN (zonder het woord tracking) wordt als tracking-intentie herkend', alleenGa4.context.tracking === 'requested', JSON.stringify(alleenGa4.context));
  t('8c F-18 "SEO" ALLEEN wordt als indexeerbaar herkend', Q.compileMissionProfile('Verbeter de SEO van de homepage', {}).context.indexable === true);
  const shopKaarten = Q.mineOmissions(Q.compileMissionProfile('Bouw een webshop met contactformulier en checkout', {}));
  t('8c F-18 ecommerce telt als weboppervlak: submitflow-omissies verschijnen ook ZONDER website-label', shopKaarten.some((x) => /thank|succes|bevestig/i.test(x.requirement)));
  const fsProfiel = Q.compileMissionProfile('Bouw een fullstack webapp met login voor projectbeheer', {});
  const fsLens = Q.evaluateLenses(fsProfiel).find((l) => /ux|toeganke/i.test(l.lens));
  t('8c F-18 fullstack telt als weboppervlak in de lenzen (zelfde predicate)', !!fsLens && fsLens.disposition === 'RELEVANT', JSON.stringify(fsLens || {}));
  const fsKaarten = Q.mineOmissions(fsProfiel);
  t('8c F-18 en in de miner: een fullstack-app krijgt de responsive/UI-staatkaarten', fsKaarten.some((x) => /responsive/i.test(x.requirement)));

  // F-16: tracked-gap-staleness volgt de INVARIANT van de gap, niet alleen het seam-item
  const mkRoot16 = (metDashboardDomein) => {
    const r16 = fs.mkdtempSync(path.join(os3.tmpdir(), 'qi-stale-'));
    fs.mkdirSync(path.join(r16, '.claude', 'config', 'orchestration'), { recursive: true });
    fs.mkdirSync(path.join(r16, '.claude', 'config', 'intake'), { recursive: true });
    fs.mkdirSync(path.join(r16, '.claude', 'skills', 'forge-website'), { recursive: true });
    if (metDashboardDomein) fs.mkdirSync(path.join(r16, '.claude', 'skills', 'forge-dashboard'), { recursive: true });
    const domains = { website: { playbook: 'forge-website', intake_pack: 'website', preset: false, keywords: ['website'] } };
    if (metDashboardDomein) domains.dashboard = { playbook: 'forge-dashboard', intake_pack: 'dashboard', preset: false, keywords: ['dashboard'] };
    fs.writeFileSync(path.join(r16, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify({
      version: 1, domains, non_domain_skills: [],
      known_gaps: { intake_pack_without_domain: { dashboard: 'oude tracked gap' } },
    }));
    fs.writeFileSync(path.join(r16, '.claude', 'config', 'intake', 'question-bank.json'), JSON.stringify({ byType: metDashboardDomein ? { website: {}, dashboard: {} } : { website: {}, dashboard: {} } }));
    fs.writeFileSync(path.join(r16, '.claude', 'config', 'orchestration', 'required-evidence.json'), JSON.stringify({ domains: metDashboardDomein ? { website: {}, dashboard: {} } : { website: {} } }));
    fs.writeFileSync(path.join(r16, '.claude', 'config', 'orchestration', 'domain-presets.json'), JSON.stringify({ domains: {} }));
    return r16;
  };
  const rootOpgelost = mkRoot16(true);
  const dOpgelost = Q.catalogDrift(rootOpgelost);
  const intakeOpgelost = dOpgelost.seams.find((x) => x.seam === 'intake-packs');
  t('8c F-16 een tracked gap waarvan de INVARIANT is opgelost (dashboard is nu een domein) is STALE drift',
    dOpgelost.ok === false && JSON.stringify(intakeOpgelost.stale_tracked || []).includes('dashboard'), JSON.stringify(intakeOpgelost));
  fs.rmSync(rootOpgelost, { recursive: true, force: true });
  const rootNogOpen = mkRoot16(false);
  const dNogOpen = Q.catalogDrift(rootNogOpen);
  const intakeNogOpen = dNogOpen.seams.find((x) => x.seam === 'intake-packs');
  t('8c F-16 dezelfde gap met een NIET-opgeloste invariant blijft tracked, niet stale',
    (intakeNogOpen.stale_tracked || []).length === 0 && JSON.stringify(intakeNogOpen.tracked_gaps || []).includes('dashboard'), JSON.stringify(intakeNogOpen));
  fs.rmSync(rootNogOpen, { recursive: true, force: true });
  // not_expected-mutatieprobe: een preset voor een domein dat er geen hoort te hebben is drift
  const rootPreset = fs.mkdtempSync(path.join(os3.tmpdir(), 'qi-preset-'));
  fs.mkdirSync(path.join(rootPreset, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.mkdirSync(path.join(rootPreset, '.claude', 'skills', 'forge-website'), { recursive: true });
  fs.writeFileSync(path.join(rootPreset, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify({ version: 1, domains: { website: { playbook: 'forge-website', intake_pack: null, preset: false, keywords: ['website'] } }, non_domain_skills: [] }));
  fs.writeFileSync(path.join(rootPreset, '.claude', 'config', 'orchestration', 'domain-presets.json'), JSON.stringify({ domains: { website: {} } }));
  const dPreset = Q.catalogDrift(rootPreset);
  t('8c F-16 not_expected telt mee: een preset zonder preset-verwachting maakt het oordeel niet-ok',
    dPreset.ok === false && (dPreset.seams.find((x) => x.seam === 'domain-presets').not_expected || []).includes('website'), JSON.stringify(dPreset.seams.find((x) => x.seam === 'domain-presets')));
  fs.rmSync(rootPreset, { recursive: true, force: true });

  // F-17: structurele councilrecord-geldigheid (shape blijft shape, maar wel een GELDIGE shape)
  const basisRec = { council_id: 'c3', trigger: {}, context_hash: 'a'.repeat(64), verdict: 'optie B, met minority report', participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2', response_ref: 'r2' },
  ], responses: ['r1', 'r2'], quorum: { required: 2, present: 2 }, status: 'COMPLETE' };
  t('8c F-17 een geldig COMPLETE-record valideert', Q.validateCouncilRecord(basisRec).ok === true, JSON.stringify(Q.validateCouncilRecord(basisRec)));
  t('8c F-17 negatieve quorumwaarden worden geweigerd', Q.validateCouncilRecord(Object.assign({}, basisRec, { quorum: { required: -1, present: -1 } })).ok === false);
  t('8c F-17 dubbele dispatch-IDs worden geweigerd (twee deelnemers, een dispatch)', Q.validateCouncilRecord(Object.assign({}, basisRec, { participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r2' },
  ] })).ok === false);
  t('8c F-17 COMPLETE met nul responses wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basisRec, { responses: [], quorum: { required: 1, present: 1 } })).ok === false);
  t('8c F-17 COMPLETE zonder verdict wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basisRec, { verdict: '' })).ok === false);

  // F-19: mission-pack-budget is regel-/recordgebaseerd — sectiestructuur en afkapmarkers OVERLEVEN de globale grens
  const profielPack = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier', {});
  const veelReqs = []; for (let i = 0; i < 26; i++) veelReqs.push({ priority: 'P2', disposition: 'RELEVANT', requirement: 'eis nummer ' + (i + 1), reason: 'reden ' + (i + 1) });
  const veelDec = []; for (let i = 0; i < 11; i++) veelDec.push('besluit ' + (i + 1));
  const veelFind = []; for (let i = 0; i < 11; i++) veelFind.push('finding ' + (i + 1));
  const groteWp = new Array(4000).fill('werkpakketwoord').join(' ');
  const pack19 = Q.buildMissionPack(profielPack, { requirements: veelReqs, decisions: veelDec, open_findings: veelFind, work_package: groteWp, artifact_ref: '.claude/forge-runs/test-run/omissions.json' });
  t('8c F-19 het pack blijft onder het woordbudget', pack19.split(/\s+/).length <= 2000, String(pack19.split(/\s+/).length));
  t('8c F-19 ALLE sectiekoppen overleven een extreem werkpakket', /## Actieve requirements/.test(pack19) && /## Beslissingen/.test(pack19) && /## Open findings/.test(pack19), pack19.slice(-300));
  t('8c F-19 de afkap is per sectie zichtbaar (omitted-counts)', /en \d+ meer/.test(pack19));
  t('8c F-19 de artifactreferentie overleeft de afkap', pack19.includes('.claude/forge-runs/test-run/omissions.json'), pack19.slice(-300));

  // F-20: kaarten zijn echte bestanden met een loader — geen beloofde maar afwezige registry
  const kaartWebsite = Q.loadKnowledgeCard ? Q.loadKnowledgeCard(ROOT, 'website') : null;
  t('8c F-20 loadKnowledgeCard laadt de website-kaart met inhoud en tokenschatting', !!kaartWebsite && typeof kaartWebsite.content === 'string' && kaartWebsite.content.length > 200 && Number.isInteger(kaartWebsite.tokens_est), JSON.stringify(kaartWebsite ? Object.keys(kaartWebsite) : null));
  t('8c F-20 een onbekende slug is null (eerlijk afwezig, nooit verzonnen)', Q.loadKnowledgeCard ? Q.loadKnowledgeCard(ROOT, 'bestaat-niet') === null : false);
  t('8c F-20 padtraversal-slugs zijn null', Q.loadKnowledgeCard ? (Q.loadKnowledgeCard(ROOT, '../forge-bin/forge-quality') === null && Q.loadKnowledgeCard(ROOT, 'a/b') === null) : false);
  const kaartenDir = path.join(ROOT, '.claude', 'config', 'quality', 'cards');
  const kaartBestanden = fs.existsSync(kaartenDir) ? fs.readdirSync(kaartenDir).filter((f) => f.endsWith('.md')) : [];
  t('8c F-20 er staan kaarten op schijf (minimaal website/api/n8n/payments/rag/agent/mobile)', ['website', 'api', 'n8n', 'payments', 'rag', 'agent', 'mobile'].every((s) => kaartBestanden.includes(s + '.md')), JSON.stringify(kaartBestanden));
  const catCheck = Q.loadCatalog(ROOT);
  t('8c F-20 elke kaart op schijf heeft een catalogus-geldige slug', kaartBestanden.every((f) => { const s = f.replace(/\.md$/, ''); return !!(catCheck.domains[s] || (catCheck.cross_labels && catCheck.cross_labels[s])); }), JSON.stringify(kaartBestanden));
  t('8c F-20 elke kaart blijft onder het tokenbudget (~1200, hard 1600)', Q.loadKnowledgeCard ? kaartBestanden.every((f) => Q.loadKnowledgeCard(ROOT, f.replace(/\.md$/, '')).tokens_est <= 1600) : false);
}

// ---- 8d) REPARATIERONDE 3 (Codex eindreview F-25..F-29): elke enforcement afzonderlijk rood als hij verdwijnt
{
  const os4 = require('os');
  const cp4 = require('child_process');

  // F-25: de contextcompiler zit IN het ene entrypoint — mission_pack is een echt veld met echte inhoud
  const an25 = Q.analyzeMission('Maak een leadgeneratie-website met contactformulier', { work_package: 'WP-testpakket-8d', artifact_ref: '.claude/forge-runs/x/omissions.json' });
  t('8d F-25 analyzeMission draagt een mission_pack met profielsectie, requirements-sectie en artifactreferentie',
    typeof an25.mission_pack === 'string' && /## MissionProfile/.test(an25.mission_pack) && /## Actieve requirements/.test(an25.mission_pack) && an25.mission_pack.includes('.claude/forge-runs/x/omissions.json'), typeof an25.mission_pack);
  t('8d F-25 het meegegeven werkpakket staat in het pack', typeof an25.mission_pack === 'string' && an25.mission_pack.includes('WP-testpakket-8d'));
  const e2e25 = cp4.spawnSync(process.execPath, [path.join(__dirname, 'forge-quality.cjs'), 'analyze', 'Bouw een webshop met checkout'], { encoding: 'utf8' });
  let e2e25j = null; try { e2e25j = JSON.parse(e2e25.stdout); } catch { }
  t('8d F-25 ook de CLI-JSON draagt mission_pack met sectiekoppen', !!e2e25j && typeof e2e25j.mission_pack === 'string' && /## MissionProfile/.test(e2e25j.mission_pack) && /## Actieve requirements/.test(e2e25j.mission_pack));

  // F-26: gesloten recordstructuur — elke genoemde ontsnapping is een aparte rode test
  const basis26 = { council_id: 'c4', trigger: {}, context_hash: 'a'.repeat(64), verdict: 'optie A', participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2', response_ref: 'r2' },
  ], responses: ['r1', 'r2'], quorum: { required: 2, present: 2 }, status: 'COMPLETE' };
  t('8d F-26 een geldig COMPLETE-record blijft geldig', Q.validateCouncilRecord(basis26).ok === true, JSON.stringify(Q.validateCouncilRecord(basis26)));
  const zonder = Object.assign({}, basis26); delete zonder.responses;
  t('8d F-26 COMPLETE ZONDER responses-veld wordt geweigerd', Q.validateCouncilRecord(zonder).ok === false);
  t('8d F-26 responses:null wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { responses: null })).ok === false);
  t('8d F-26 een null-response wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { responses: ['r1', null] })).ok === false);
  t('8d F-26 een lege-string-response wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { responses: ['r1', ''] })).ok === false);
  t('8d F-26 een deelnemer ZONDER response_ref bij COMPLETE wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2' },
  ] })).ok === false);
  t('8d F-26 een response_ref die niet in responses bestaat wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2', response_ref: 'r-bestaat-niet' },
  ] })).ok === false);
  t('8d F-26 dubbele response_refs worden geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2', response_ref: 'r1' },
  ] })).ok === false);
  t('8d F-26 een onbekende status (buiten het gesloten vocabulaire) wordt geweigerd', Q.validateCouncilRecord(Object.assign({}, basis26, { status: 'BANANA' })).ok === false);
  t('8d F-26 INCOMPLETE blijft geldig zonder response_refs (de bestaande vorm)', Q.validateCouncilRecord({ council_id: 'c5', trigger: {}, context_hash: 'a'.repeat(64), participants: [{ role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1' }], responses: [], quorum: { required: 5, present: 1 }, status: 'INCOMPLETE' }).ok === true);

  /** F-27: de correctie is bindend — het retrospectieve verificatie-event met ECHTE hashes moet bestaan,
   *  en events na de correctie mogen nooit meer een undefined-hashclaim dragen.
   *
   *  FRESH-INSTALL-GUARD (gemeten): dit leest de LOKALE missiehistorie van de
   *  ontwikkelboom. Die map bestaat per definitie niet in een
   *  verse install of een kale clone. Zonder guard gooide de ongeguarde readFileSync daar een
   *  ENOENT die het HELE testbestand liet crashen — en dus forge-doctor, en dus de post-install
   *  validatie van forge-sync. Precies de "bij mij groen, bij hen rood"-klasse die deze release
   *  bestrijdt. De assertie blijft volledig streng waar de historie WEL bestaat; elders skipt hij
   *  eerlijk met reden in plaats van te doen alsof hij iets bewees. */
  const evPad = path.join(ROOT, '.claude', 'forge-runs', 'forge-2026-08-11-quality-intel', 'events.jsonl');
  if (!fs.existsSync(evPad)) {
    console.log('  SKIP 8d F-27 correctie-event — deze boom draagt de lokale missiehistorie niet (verse install of kale clone); de assertie is dev-tree-gebonden, niet stil overgeslagen');
  } else {
    const evRegels = fs.readFileSync(evPad, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const correctie = evRegels.find((e) => e.event_type === 'agent_note' && /F-27-CORRECTIE/.test(e.note || ''));
    t('8d F-27 het correctie-event bestaat en draagt een volledige sha256 EN een volledige blob-hash',
      !!correctie && /sha256=[0-9a-f]{64}/.test(correctie.note) && /=[0-9a-f]{40}( |\.|\b)/.test(correctie.note), correctie ? correctie.note.slice(0, 80) : 'ontbreekt');
    const corrIdx = evRegels.indexOf(correctie);
    const naCorrectie = corrIdx >= 0 ? evRegels.slice(corrIdx + 1) : [];
    t('8d F-27 geen enkel event NA de correctie claimt nog sha256=undefined of git-blob=undefined',
      naCorrectie.every((e) => !/sha256=undefined|git-blob=undefined/.test(String(e.note || ''))));
  }

  // F-28: het extreme-pack-scenario met GLOBALE verwijdering — marker per getroffen sectie, [REGEL AFGEKAPT] overleeft
  const prof28 = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier', {});
  const reqs28 = []; for (let i = 0; i < 25; i++) reqs28.push({ priority: 'P2', disposition: 'RELEVANT', requirement: 'eis ' + (i + 1) + ' ' + new Array(40).fill('woord').join(' '), reason: 'reden' });
  const dec28 = []; for (let i = 0; i < 10; i++) dec28.push('besluit ' + (i + 1) + ' ' + new Array(40).fill('woord').join(' '));
  const fin28 = []; for (let i = 0; i < 10; i++) fin28.push('finding ' + (i + 1) + ' ' + new Array(40).fill('woord').join(' '));
  const wp28 = new Array(1500).fill('werkpakketwoord').join(' ');
  const pack28 = Q.buildMissionPack(prof28, { requirements: reqs28, decisions: dec28, open_findings: fin28, work_package: wp28, artifact_ref: 'run-artifact-28.json' });
  t('8d F-28 het pack blijft onder budget bij een scenario dat globale verwijdering afdwingt', pack28.split(/\s+/).filter(Boolean).length <= 2000, String(pack28.split(/\s+/).filter(Boolean).length));
  t('8d F-28 de [REGEL AFGEKAPT]-marker van de extreme regel OVERLEEFT de globale verwijdering', pack28.includes('[REGEL AFGEKAPT'));
  const secties28 = ['## Actieve requirements', '## Beslissingen', '## Open findings'].filter((s2) => pack28.includes(s2));
  t('8d F-28 alle drie sectiekoppen overleven', secties28.length === 3);
  const globaalMarkers = (pack28.match(/\[GLOBAAL BUDGET\]/g) || []).length;
  t('8d F-28 elke sectie waaruit regels verdwenen draagt een eigen [GLOBAAL BUDGET]-marker (er is er minstens een, en de telling klopt met de weggelaten regels)', globaalMarkers >= 1 && /\[GLOBAAL BUDGET\] … en \d+ meer regel/.test(pack28), 'markers=' + globaalMarkers);

  // F-28: not_expected GEISOLEERD — alle andere seams groen, alleen domain-presets wijkt af
  const rootNE = fs.mkdtempSync(path.join(os4.tmpdir(), 'qi-ne-'));
  fs.mkdirSync(path.join(rootNE, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.mkdirSync(path.join(rootNE, '.claude', 'config', 'intake'), { recursive: true });
  fs.mkdirSync(path.join(rootNE, '.claude', 'skills', 'forge-website'), { recursive: true });
  fs.writeFileSync(path.join(rootNE, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify({ version: 1, domains: { website: { playbook: 'forge-website', intake_pack: null, preset: false, keywords: ['website'] } }, non_domain_skills: [] }));
  fs.writeFileSync(path.join(rootNE, '.claude', 'config', 'orchestration', 'required-evidence.json'), JSON.stringify({ domains: { website: {} } }));
  fs.writeFileSync(path.join(rootNE, '.claude', 'config', 'intake', 'question-bank.json'), JSON.stringify({ byType: {} }));
  fs.writeFileSync(path.join(rootNE, '.claude', 'config', 'orchestration', 'domain-presets.json'), JSON.stringify({ domains: { website: {} } }));
  const dNE = Q.catalogDrift(rootNE);
  const andereSeamsGroen = dNE.seams.filter((s2) => s2.seam !== 'domain-presets').every((s2) => !(s2.missing_in_seam || []).length && !(s2.extra_in_seam || []).length && !(s2.not_expected || []).length && !(s2.stale_tracked || []).length);
  t('8d F-28 not_expected-fixture is GEISOLEERD: alle andere seams zijn groen', andereSeamsGroen, JSON.stringify(dNE.seams.map((s2) => ({ s: s2.seam, m: s2.missing_in_seam, e: s2.extra_in_seam }))));
  t('8d F-28 en ALLEEN not_expected maakt het eindoordeel niet-ok', dNE.ok === false && (dNE.seams.find((s2) => s2.seam === 'domain-presets').not_expected || []).includes('website'));

  // F-29: de doctor benoemt stale en not_expected in reason (gedragstest op temp-roots)
  let D29 = null; try { D29 = require(path.join(__dirname, 'forge-doctor.cjs')); } catch { }
  if (D29 && typeof D29.qualityCatalogDoctorCheck === 'function') {
    // not_expected-only root heeft OOK de quality-module nodig — kopieer die mee
    fs.mkdirSync(path.join(rootNE, '.claude', 'forge-bin'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'forge-quality.cjs'), path.join(rootNE, '.claude', 'forge-bin', 'forge-quality.cjs'));
    const r29a = D29.qualityCatalogDoctorCheck(rootNE);
    t('8d F-29 doctor-reason benoemt not_expected als oorzaak', r29a.ok === false && /not_expected/.test(r29a.reason || ''), JSON.stringify(r29a));
    const rootST = fs.mkdtempSync(path.join(os4.tmpdir(), 'qi-st29-'));
    fs.mkdirSync(path.join(rootST, '.claude', 'config', 'orchestration'), { recursive: true });
    fs.mkdirSync(path.join(rootST, '.claude', 'config', 'intake'), { recursive: true });
    fs.mkdirSync(path.join(rootST, '.claude', 'skills', 'forge-website'), { recursive: true });
    fs.mkdirSync(path.join(rootST, '.claude', 'skills', 'forge-dashboard'), { recursive: true });
    fs.mkdirSync(path.join(rootST, '.claude', 'forge-bin'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'forge-quality.cjs'), path.join(rootST, '.claude', 'forge-bin', 'forge-quality.cjs'));
    fs.writeFileSync(path.join(rootST, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify({ version: 1, domains: { website: { playbook: 'forge-website', intake_pack: 'website', preset: false, keywords: ['website'] }, dashboard: { playbook: 'forge-dashboard', intake_pack: 'dashboard', preset: false, keywords: ['dashboard'] } }, non_domain_skills: [], known_gaps: { intake_pack_without_domain: { dashboard: 'opgeloste gap' } } }));
    fs.writeFileSync(path.join(rootST, '.claude', 'config', 'intake', 'question-bank.json'), JSON.stringify({ byType: { website: {}, dashboard: {} } }));
    fs.writeFileSync(path.join(rootST, '.claude', 'config', 'orchestration', 'required-evidence.json'), JSON.stringify({ domains: { website: {}, dashboard: {} } }));
    fs.writeFileSync(path.join(rootST, '.claude', 'config', 'orchestration', 'domain-presets.json'), JSON.stringify({ domains: {} }));
    const r29b = D29.qualityCatalogDoctorCheck(rootST);
    t('8d F-29 doctor-reason benoemt stale tracked gaps als oorzaak', r29b.ok === false && /stale/.test(r29b.reason || ''), JSON.stringify(r29b));
    fs.rmSync(rootST, { recursive: true, force: true });
  } else {
    t('8d F-29 doctor-module laadbaar voor gedragstests', false, 'forge-doctor.cjs niet laadbaar');
    t('8d F-29 doctor-reason benoemt stale tracked gaps als oorzaak', false, 'overgeslagen');
  }
  fs.rmSync(rootNE, { recursive: true, force: true });
}

// ---- 9) doctor-integratie: GEDRAG, geen bron-regex (F-23) — de advisory draait echt en faalt echt
{
  let D9 = null;
  try { D9 = require(path.join(__dirname, 'forge-doctor.cjs')); } catch { }
  t('9 de doctor exporteert qualityCatalogDoctorCheck (aanroepbaar gedrag, geen brontekst)', !!D9 && typeof D9.qualityCatalogDoctorCheck === 'function');
  if (D9 && typeof D9.qualityCatalogDoctorCheck === 'function') {
    // F-09 als GEDRAG: een installatie ZONDER de module is ok:false — gemeten door de check echt te draaien
    const os9 = require('os');
    const kaal = fs.mkdtempSync(path.join(os9.tmpdir(), 'qi-doctor-kaal-'));
    fs.mkdirSync(path.join(kaal, '.claude', 'forge-bin'), { recursive: true });
    const zonderModule = D9.qualityCatalogDoctorCheck(kaal);
    t('9 F-09/F-23 ontbrekende quality-module => advisory ok:false (gedragstest op een kale root)', zonderModule.ok === false && /incompleet|ontbreekt/i.test(zonderModule.reason || ''), JSON.stringify(zonderModule));
    fs.rmSync(kaal, { recursive: true, force: true });
    const echt = D9.qualityCatalogDoctorCheck(ROOT);
    t('9 de advisory op het ECHTE project is ok (driftvrij, bekende gaps tracked)', echt.ok === true, JSON.stringify(echt));
  }
  const drift = Q.catalogDrift(ROOT);
  t('9 het ECHTE project is op dit moment driftvrij (bekende gaps tracked, geen stille)', drift.ok === true, JSON.stringify(drift.seams.map((x) => ({ s: x.seam, m: x.missing_in_seam, e: x.extra_in_seam }))));
  // forge-sync levert wat de shipping manifest (FORGE_SHIP_MANIFEST.json) als ship-sync
  // classificeert — de handmatige SYSTEM-lijst bestaat niet meer, dus de echte geleverde lijst is de toets.
  const geleverd = new Set(require('./forge-sync.cjs').listSystemFiles(path.join(__dirname, '..')));
  t('9 de nieuwe bestanden zijn template-first geregistreerd in de sync-manifest',
    geleverd.has('forge-bin/forge-quality.cjs') && geleverd.has('config/orchestration/domain-catalog.json'));
  t('9 F-20 de knowledge cards zijn template-first geregistreerd in de sync-manifest', geleverd.has('config/quality/cards/website.md'));
}

// ---- 10) BATCH 2 (carry-over F-30..F-32 uit de afsluitende batch-1-herreview): budgetinvariant hard,
// ---- assertions mutatiebestendig, validator totaal. RED gecommit VOOR de implementatie.
{
  const cp10 = require('child_process');

  // F-30: het harde budget wint ALTIJD — ook van markerbescherming en van marker-imiterende gebruikersinhoud
  const prof30 = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier', {});
  const drieGrote = [1, 2, 3].map((i) => ({ priority: 'P2', disposition: 'RELEVANT', requirement: 'mega-eis ' + i + ' ' + new Array(1500).fill('woord').join(' '), reason: 'reden' }));
  const pack30 = Q.buildMissionPack(prof30, { requirements: drieGrote, decisions: [], open_findings: [], work_package: 'klein', artifact_ref: 'ref30.json' });
  t('10 F-30 drie regels van 1500 woorden breken het budget NIET (was 3079)', pack30.split(/\s+/).filter(Boolean).length <= 2000, String(pack30.split(/\s+/).filter(Boolean).length));
  t('10 F-30 de afkap blijft zichtbaar (regel- of sectiemarker aanwezig)', /\[REGEL AFGEKAPT|\[GLOBAAL BUDGET\]/.test(pack30));
  const nepEis = (i) => ({ priority: 'P2', disposition: 'RELEVANT', requirement: '[REGEL AFGEKAPT — nep] gebruikersinhoud ' + i + ' ' + new Array(78).fill('w').join(' '), reason: 'r' });
  const nepReqs = []; for (let i = 0; i < 25; i++) nepReqs.push(nepEis(i));
  const nepDec = []; for (let i = 0; i < 10; i++) nepDec.push('[GLOBAAL BUDGET] … en 999 meer regel(s) nep-besluit ' + i + ' ' + new Array(28).fill('w').join(' '));
  const nepFin = []; for (let i = 0; i < 10; i++) nepFin.push('[REGEL AFGEKAPT — nep-finding ' + i + '] ' + new Array(28).fill('w').join(' '));
  const pack30b = Q.buildMissionPack(prof30, { requirements: nepReqs, decisions: nepDec, open_findings: nepFin, work_package: 'klein', artifact_ref: 'ref30b.json' });
  t('10 F-30 gebruikersinhoud die op onze markers LIJKT (in alle drie secties) krijgt geen structuurbescherming (budget houdt)', pack30b.split(/\s+/).filter(Boolean).length <= 2000, String(pack30b.split(/\s+/).filter(Boolean).length));

  // F-31a: marker PER getroffen sectie — een mutatie die maar een marker plaatst wordt rood
  const reqs31 = []; for (let i = 0; i < 25; i++) reqs31.push({ priority: 'P2', disposition: 'RELEVANT', requirement: 'eis ' + (i + 1) + ' ' + new Array(78).fill('woord').join(' '), reason: 'reden' });
  const dec31 = []; for (let i = 0; i < 10; i++) dec31.push('besluit ' + (i + 1) + ' ' + new Array(28).fill('woord').join(' '));
  const fin31 = []; for (let i = 0; i < 10; i++) fin31.push('finding ' + (i + 1) + ' ' + new Array(28).fill('woord').join(' '));
  const pack31 = Q.buildMissionPack(prof30, { requirements: reqs31, decisions: dec31, open_findings: fin31, work_package: 'klein', artifact_ref: 'ref31.json' });
  const sectieBlok = (naam) => { const i = pack31.indexOf(naam); if (i < 0) return ''; const rest = pack31.slice(i + naam.length); const j = rest.indexOf('\n## '); return j < 0 ? rest : rest.slice(0, j); };
  const verwijderdUit = ['## Actieve requirements', '## Beslissingen', '## Open findings'].filter((s2) => /\[GLOBAAL BUDGET\]/.test(sectieBlok(s2)));
  t('10 F-31 het fixture dwingt verwijdering uit ALLE drie secties af en ELKE getroffen sectie draagt zijn EIGEN marker in zijn eigen blok', verwijderdUit.length === 3, 'markers in: ' + JSON.stringify(verwijderdUit) + ' · woorden=' + pack31.split(/\s+/).filter(Boolean).length);
  t('10 F-31 en het budget houdt ook hier', pack31.split(/\s+/).filter(Boolean).length <= 2000);

  // F-31b: mission_pack draagt ECHTE omission-inhoud — requirements:[] zou deze test rood maken
  const e2e31 = cp10.spawnSync(process.execPath, [path.join(__dirname, 'forge-quality.cjs'), 'analyze', 'Maak een leadgeneratie-website met contactformulier'], { encoding: 'utf8' });
  let e2e31j = null; try { e2e31j = JSON.parse(e2e31.stdout); } catch { }
  t('10 F-31 de eerste omission staat LETTERLIJK in het mission_pack van de CLI',
    !!e2e31j && Array.isArray(e2e31j.omissions) && e2e31j.omissions.length > 0 && typeof e2e31j.mission_pack === 'string' && e2e31j.mission_pack.includes(e2e31j.omissions[0].requirement),
    e2e31j ? 'omissions=' + (e2e31j.omissions || []).length : 'geen json');

  // F-32: de validator is TOTAAL — sparse arrays en niet-string-statussen weigeren zonder exception
  const basis32 = { council_id: 'c6', trigger: {}, context_hash: 'a'.repeat(64), verdict: 'optie A', participants: [
    { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
    { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2', response_ref: 'r2' },
  ], responses: ['r1', 'r2'], quorum: { required: 2, present: 2 }, status: 'COMPLETE' };
  const sparse = ['r1']; sparse[2] = 'r2'; // hole op index 1, length 3
  let r32a; try { r32a = Q.validateCouncilRecord(Object.assign({}, basis32, { responses: sparse })); } catch (e) { r32a = { threw: e.message }; }
  t('10 F-32 een sparse responses-array wordt geweigerd (holes zijn geen adviezen)', r32a && r32a.ok === false, JSON.stringify(r32a));
  let r32b; try { r32b = Q.validateCouncilRecord(Object.assign({}, basis32, { status: Symbol('BANANA') })); } catch (e) { r32b = { threw: e.message }; }
  t('10 F-32 een Symbol-status wordt geweigerd ZONDER exception', r32b && r32b.ok === false && !r32b.threw, JSON.stringify(r32b && r32b.threw ? { threw: r32b.threw } : r32b));
  let r32c; try { r32c = Q.validateCouncilRecord(Object.assign({}, basis32, { status: 42 })); } catch (e) { r32c = { threw: e.message }; }
  t('10 F-32 een niet-string-status (nummer) wordt geweigerd zonder exception', r32c && r32c.ok === false && !r32c.threw);
}

// ---- 11) BATCH 3 (council): SKILL + append-only recordpersistentie + intake-integratie. RED VOOR implementatie.
{
  const os11 = require('os');
  t('11 persistCouncilRecord bestaat', typeof Q.persistCouncilRecord === 'function');
  if (typeof Q.persistCouncilRecord === 'function') {
    const root11 = fs.mkdtempSync(path.join(os11.tmpdir(), 'qi-council-'));
    const geldig = { council_id: 'c-besluit-1', trigger: {}, context_hash: 'a'.repeat(64), verdict: 'optie B; minority: optie C blijft valide bij lage load', minority_report: 'Outsider en Contrarian kozen C', participants: [
      { role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' },
      { role: 'executor', runtime: 'agent-tool', dispatch_id: 'd2', response_ref: 'r2' },
    ], responses: ['r1', 'r2'], quorum: { required: 2, present: 2 }, status: 'COMPLETE' };
    const w1 = Q.persistCouncilRecord(root11, 'run-test', geldig);
    const verwachtPad = path.join(root11, '.claude', 'forge-runs', 'run-test', 'council', 'c-besluit-1.json');
    t('11 een GELDIG record wordt gepersisteerd op het juiste pad', w1.ok === true && fs.existsSync(verwachtPad), JSON.stringify(w1));
    const opSchijf = JSON.parse(fs.readFileSync(verwachtPad, 'utf8'));
    t('11 het gepersisteerde record zegt ZELF dat de validatie shape_only was', opSchijf._validated && opSchijf._validated.shape_only === true && /owner-gated/i.test(opSchijf._validated.caveat || ''));
    const hashVoor = Q.sha256(fs.readFileSync(verwachtPad, 'utf8'));
    const w2 = Q.persistCouncilRecord(root11, 'run-test', Object.assign({}, geldig, { verdict: 'HERSCHREVEN' }));
    t('11 hetzelfde council_id een tweede keer wordt GEWEIGERD (append-only, geen geschiedvervalsing)', w2.ok === false && /append-only|overschr/i.test(w2.reden || ''), JSON.stringify(w2));
    t('11 en het bestand is byte-identiek gebleven', Q.sha256(fs.readFileSync(verwachtPad, 'utf8')) === hashVoor);
    const ongeldig = Object.assign({}, geldig, { council_id: 'c-besluit-2', participants: geldig.participants.map(() => ({ role: 'x', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' })) });
    const w3 = Q.persistCouncilRecord(root11, 'run-test', ongeldig);
    t('11 een ONGELDIG record wordt geweigerd EN niet geschreven', w3.ok === false && !fs.existsSync(path.join(root11, '.claude', 'forge-runs', 'run-test', 'council', 'c-besluit-2.json')));
    t('11 padtraversal in council_id wordt geweigerd', Q.persistCouncilRecord(root11, 'run-test', Object.assign({}, geldig, { council_id: '../ontsnapt' })).ok === false);
    t('11 padtraversal in run_id wordt geweigerd', Q.persistCouncilRecord(root11, '../ontsnapt', Object.assign({}, geldig, { council_id: 'c-ok' })).ok === false);
    fs.rmSync(root11, { recursive: true, force: true });
  } else { for (let i = 0; i < 7; i++) t('11 persistentietest ' + (i + 1) + ' (module mist persistCouncilRecord)', false); }
  const councilSkillPad = path.join(ROOT, '.claude', 'skills', 'forge-council', 'SKILL.md');
  t('11 de forge-council-SKILL bestaat', fs.existsSync(councilSkillPad));
  if (fs.existsSync(councilSkillPad)) {
    const sk = fs.readFileSync(councilSkillPad, 'utf8');
    t('11 de SKILL beschrijft de vijf vaste lenzen', ['Contrarian', 'First Principles', 'Expansionist', 'Outsider', 'Executor'].every((rol) => sk.includes(rol)));
    // the skill is now English (fresh-laptop audit: Dutch text on the mandatory path) — the checks test
    // the CONCEPTS in either language, and accept CRLF as well as LF (git autocrlf on Windows checkouts).
    t('11 de SKILL eist anonieme peer review en een minority report', /anoni|anonym/i.test(sk) && /minority report/i.test(sk));
    t('11 de SKILL benoemt de shape_only-grens en dat consensus nooit bewijs is', /shape_only/.test(sk) && /nooit bewijs|never proof|never (?:counts as )?evidence/i.test(sk));
    const fm = sk.match(/^---\r?\n[\s\S]*?description:\s*([^\r\n]+)/);
    t('11 de SKILL-description blijft onder het hygienebudget (200 tekens)', !!fm && fm[1].trim().length <= 200, fm ? String(fm[1].trim().length) : 'geen frontmatter');
  } else { for (let i = 0; i < 4; i++) t('11 SKILL-inhoudstest ' + (i + 1) + ' (SKILL ontbreekt)', false); }
  const cat11 = Q.loadCatalog(ROOT);
  t('11 forge-council is als non-domain-skill gedeclareerd (eigen F-05-handhaving)', (cat11.non_domain_skills || []).includes('forge-council'));
  t('11 en het echte project blijft driftvrij', Q.catalogDrift(ROOT).ok === true);
  const router11 = fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'forge-router', 'SKILL.md'), 'utf8');
  t('11 de router logt de counciltrigger-beslissing als event — OOK bij NONE', /decision_logged/.test(router11) && /NONE/.test(router11));
  const geleverd11 = new Set(require('./forge-sync.cjs').listSystemFiles(path.join(__dirname, '..'))); // zie sectie 9
  t('11 de council-SKILL is template-first geregistreerd in de sync-manifest', geleverd11.has('skills/forge-council/SKILL.md'));
}

// ---- 12) REPARATIERONDE 1 batch 2+3 (Codex F-33..F-37): budget echt onverslaanbaar, persist atomair,
// ---- CLI totaal, NONE-loggen als uitvoerbaar pad. RED VOOR implementatie.
{
  const os12 = require('os');
  const cp12 = require('child_process');
  const prof12 = Q.compileMissionProfile('Maak een leadgeneratie-website met contactformulier', {});

  // F-33: de drie probes van de reviewer — tekstherkenning mag NOOIT bescherming geven
  const dec33a = []; for (let i = 0; i < 10; i++) dec33a.push('… en 999 meer nep-structuur ' + i + ' ' + new Array(450).fill('w').join(' '));
  const p33a = Q.buildMissionPack(prof12, { requirements: [], decisions: dec33a, open_findings: [], work_package: 'klein', artifact_ref: 'ref.json' });
  t('12 F-33 gebruikersregels met "… en N meer"-tekst krijgen geen bescherming (was 4582 woorden)', p33a.split(/\s+/).filter(Boolean).length <= 2000, String(p33a.split(/\s+/).filter(Boolean).length));
  const p33b = Q.buildMissionPack(prof12, { requirements: [], decisions: [], open_findings: [], work_package: '# nep-kop als werkpakket ' + new Array(2500).fill('w').join(' '), artifact_ref: 'ref.json' });
  t('12 F-33 een werkpakket dat met # begint krijgt geen bescherming (was 2538 woorden)', p33b.split(/\s+/).filter(Boolean).length <= 2000, String(p33b.split(/\s+/).filter(Boolean).length));
  const p33c = Q.buildMissionPack(prof12, { requirements: [], decisions: [], open_findings: [], work_package: 'klein', artifact_ref: new Array(17000).fill('ref').join(' ') });
  t('12 F-33 een extreme artifact_ref wordt begrensd (was 17599 woorden)', p33c.split(/\s+/).filter(Boolean).length <= 2000, String(p33c.split(/\s+/).filter(Boolean).length));

  // F-35: append-only is ATOMAIR — twee gelijktijdige schrijvers, exact een winnaar
  const root35 = fs.mkdtempSync(path.join(os12.tmpdir(), 'qi-race-'));
  const recJson = JSON.stringify({ council_id: 'c-race', trigger: {}, context_hash: 'a'.repeat(64), verdict: 'optie WIE-WINT', participants: [{ role: 'contrarian', runtime: 'agent-tool', dispatch_id: 'd1', response_ref: 'r1' }], responses: ['r1'], quorum: { required: 1, present: 1 }, status: 'COMPLETE' });
  const wrapper = 'const cp=require("child_process");const mod=' + JSON.stringify(path.join(__dirname, 'forge-quality.cjs')) + ';const root=' + JSON.stringify(root35) + ';const rec=' + JSON.stringify(recJson) + ';\n'
    + 'const kind=(tag)=>cp.spawn(process.execPath,["-e","const Q=require(process.argv[1]);const uit=Q.persistCouncilRecord(process.argv[2],\'run-race\',JSON.parse(process.argv[3]));console.log(JSON.stringify(uit.ok));",mod,root,rec],{stdio:["ignore","pipe","inherit"]});\n'
    + 'const a=kind("a"),b=kind("b");let out=[];const done=(p,t2)=>new Promise(res=>{let s="";p.stdout.on("data",d=>s+=d);p.on("exit",()=>res(s.trim()))});\n'
    + 'Promise.all([done(a),done(b)]).then(r2=>{console.log(JSON.stringify(r2));});';
  const race = cp12.spawnSync(process.execPath, ['-e', wrapper], { encoding: 'utf8', timeout: 30000 });
  let raceUit = []; try { raceUit = JSON.parse(race.stdout.trim().split('\n').pop()); } catch { }
  t('12 F-35 bij twee gelijktijdige schrijvers slaagt er EXACT een', Array.isArray(raceUit) && raceUit.filter((x) => x === 'true').length === 1 && raceUit.filter((x) => x === 'false').length === 1, race.stdout.slice(0, 200) + '|' + String(race.stderr).slice(0, 200));
  t('12 F-35 en het bestand bestaat precies een keer met geldige JSON', fs.existsSync(path.join(root35, '.claude', 'forge-runs', 'run-race', 'council', 'c-race.json')) && !!JSON.parse(fs.readFileSync(path.join(root35, '.claude', 'forge-runs', 'run-race', 'council', 'c-race.json'), 'utf8')).verdict);
  fs.rmSync(root35, { recursive: true, force: true });

  // F-36: falsy-maar-geldige JSON is GEEN succes
  const falsyDir = fs.mkdtempSync(path.join(os12.tmpdir(), 'qi-falsy-'));
  for (const [naam, inhoud] of [['nul.json', 'null'], ['onwaar.json', 'false'], ['nulgetal.json', '0'], ['leeg.json', '""']]) {
    fs.writeFileSync(path.join(falsyDir, naam), inhoud);
    const uit36 = cp12.spawnSync(process.execPath, [path.join(__dirname, 'forge-quality.cjs'), 'council-save', 'run-falsy', path.join(falsyDir, naam)], { encoding: 'utf8' });
    t('12 F-36 council-save met JSON ' + inhoud + ' faalt met exit 3 en ok:false', uit36.status === 3 && /"ok":\s*false|valideert niet|geen object/i.test(uit36.stdout + uit36.stderr), 'exit=' + uit36.status + ' :: ' + (uit36.stdout + uit36.stderr).slice(0, 120));
  }
  t('12 F-36 en er is NIETS geschreven voor run-falsy', !fs.existsSync(path.join(ROOT, '.claude', 'forge-runs', 'run-falsy')));
  fs.rmSync(falsyDir, { recursive: true, force: true });

  // F-37: het NONE-besluit wordt door een UITVOERBAAR pad gelogd, niet door prose
  const root37 = fs.mkdtempSync(path.join(os12.tmpdir(), 'qi-log37-'));
  fs.mkdirSync(path.join(root37, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(root37, '.claude', 'forge-runs', 'run-e2e'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(root37, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.mkdirSync(path.join(root37, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.claude', 'config', 'orchestration', 'domain-catalog.json'), path.join(root37, '.claude', 'config', 'orchestration', 'domain-catalog.json'));
  fs.writeFileSync(path.join(root37, '.claude', 'forge-runs', 'run-e2e', 'run.json'), JSON.stringify({ run_id: 'run-e2e', status: 'running' }));
  const uit37 = cp12.spawnSync(process.execPath, [path.join(__dirname, 'forge-quality.cjs'), 'analyze', 'Maak een simpele website', '--root', root37, '--log-run', 'run-e2e'], { encoding: 'utf8' });
  const evPad37 = path.join(root37, '.claude', 'forge-runs', 'run-e2e', 'events.jsonl');
  let besluiten37 = [];
  if (fs.existsSync(evPad37)) besluiten37 = fs.readFileSync(evPad37, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.event_type === 'decision_logged');
  t('12 F-37 analyze --log-run schrijft EXACT een decision_logged-event via de echte eventwriter', uit37.status === 0 && besluiten37.length === 1, 'exit=' + uit37.status + ' events=' + besluiten37.length + ' :: ' + String(uit37.stderr).slice(0, 150));
  t('12 F-37 het event draagt mode EN trigger_reason', besluiten37.length === 1 && /NONE|LIGHT|FULL/.test(besluiten37[0].note || '') && /informatiewinst|onzekerheid|gebruikerstrigger|latency/.test(besluiten37[0].note || ''), JSON.stringify((besluiten37[0] || {}).note || '').slice(0, 200));
  fs.rmSync(root37, { recursive: true, force: true });
}

// ---- 13) eigenaarsinstelling `council` (forge-config.cjs): off -> NONE, behalve bij een expliciete vraag
{
  const cfgRoot = (settings) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-council-'));
    fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
    if (settings) fs.writeFileSync(path.join(r, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }));
    return r;
  };
  const UIT = cfgRoot({ council: { value: 'off' } });
  const AUTO = cfgRoot({ council: { value: 'auto' } });
  const zwaarInp = { decision_impact: 'high', uncertainty: 'high', reversibility: 'low', credible_options: 3, criticality: 'high', explicit_request: false };
  const metRoot = (root, fn) => { const vorig = process.env.FORGE_PROJECT_ROOT; process.env.FORGE_PROJECT_ROOT = root; try { return fn(); } finally { process.env.FORGE_PROJECT_ROOT = vorig; } };

  const uit = metRoot(UIT, () => Q.councilTrigger(zwaarInp));
  t('13 council=off -> NONE met reason "owner config council=off", zelfs bij hoge impact + onzekerheid', uit.mode === 'NONE' && uit.reason === 'owner config council=off' && /owner config council=off/.test(uit.trigger_reason), JSON.stringify(uit));
  const uitExpliciet = metRoot(UIT, () => Q.councilTrigger(Object.assign({}, zwaarInp, { explicit_request: true })));
  t('13 council=off + explicit_request:true -> FULL (de huidige vraag wint van de opgeslagen instelling)', uitExpliciet.mode === 'FULL', JSON.stringify(uitExpliciet));
  const auto = metRoot(AUTO, () => Q.councilTrigger(zwaarInp));
  t('13 council=auto -> ongewijzigd gedrag (FULL bij hoge impact + onzekerheid)', auto.mode === 'FULL' && auto.reason === undefined);
  t('13 de projectRoot-optie leest de instellingen van DIE root als FORGE_PROJECT_ROOT niet gezet is', (() => {
    const vorig = process.env.FORGE_PROJECT_ROOT; delete process.env.FORGE_PROJECT_ROOT;
    try { return Q.councilTrigger(zwaarInp, { projectRoot: UIT }).mode === 'NONE' && Q.councilTrigger(zwaarInp, { projectRoot: AUTO }).mode === 'FULL'; }
    finally { process.env.FORGE_PROJECT_ROOT = vorig; }
  })());
  const afwezig = metRoot(UIT, () => Q.councilTrigger(zwaarInp, { configModule: null }));
  const gooit = metRoot(UIT, () => Q.councilTrigger(zwaarInp, { configModule: { get() { throw new Error('boem'); } } }));
  t('13 config-module afwezig (null) of gooit -> schema-default auto (FULL), ook als het bestand off zegt', afwezig.mode === 'FULL' && gooit.mode === 'FULL');
  t('13 configOn negeert een waarde van het verkeerde type', Q.configOn('council', 'auto', { configModule: { get: () => ({ value: false }) } }) === 'auto' && Q.configOn('council', 'auto', { configModule: { get: () => ({ value: 'off' }) } }) === 'off');
  const KAPOT = cfgRoot(null);
  fs.writeFileSync(path.join(KAPOT, '.claude', 'FORGE_CONFIG.json'), '{ geen json');
  const kapot = metRoot(KAPOT, () => Q.councilTrigger(zwaarInp));
  t('13 M3: een beschadigd FORGE_CONFIG.json -> schema-default auto (geen datavlag, dus FULL) + een config_note van één regel', kapot.mode === 'FULL' && /damaged|beschadigd/.test(kapot.config_note || '') && !/\n/.test(kapot.config_note), JSON.stringify(kapot).slice(0, 300));
  t('13 M3: zonder schade geen config_note', metRoot(AUTO, () => Q.councilTrigger(zwaarInp)).config_note === undefined);
  try { fs.rmSync(KAPOT, { recursive: true, force: true }); } catch { /* opruimen is best effort */ }
  const an = metRoot(UIT, () => Q.analyzeMission('Maak een webshop met checkout en betalingen', {}));
  t('13 analyzeMission geeft de instelling door: council=off -> council.mode NONE met de eigenaarsreden', an.council.mode === 'NONE' && an.council.reason === 'owner config council=off', JSON.stringify(an.council).slice(0, 200));
  const anExpliciet = metRoot(UIT, () => Q.analyzeMission('Doe een council pressure-test op deze architectuurkeuze', {}));
  t('13 analyzeMission: een expliciete council-vraag in de missie wint ook bij council=off', anExpliciet.council.mode === 'FULL', JSON.stringify(anExpliciet.council).slice(0, 200));
  for (const d of [UIT, AUTO, CFG_HOME, CFG_LEEG]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* opruimen is best effort */ } }
}

// ---- 14) QUALITY GATE CARDS (modernization WP 3.4): one card per catalog domain at
// ---- .claude/config/quality/cards/<domain>.json, consumed by Verify Boss through `gate --domain <d>`. Every check
// ---- must cite text that already exists in the domain playbook (or FORGE_HARD_RULES.json); the tool only LISTS
// ---- checks, it never marks one passed. RED first: these tests were run before the gate code existed.
{
  const cp14 = require('child_process');
  const TOOL = path.join(__dirname, 'forge-quality.cjs');
  const run14 = (args) => cp14.spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  const has = (fn) => !!(Q && typeof Q[fn] === 'function');
  t('14 module exports the gate API (GATE_CARD_SCHEMA, listGateCards, loadGateCard, validateGateCard, verifyGateCitations, renderGate)',
    !!(Q && Q.GATE_CARD_SCHEMA) && ['listGateCards', 'loadGateCard', 'validateGateCard', 'verifyGateCitations', 'renderGate'].every(has));
  const schema = (Q && Q.GATE_CARD_SCHEMA) || {};
  const req = schema.required || [];
  const checkReq = (((schema.properties || {}).checks || {}).items || {}).required || [];
  t('14 the schema requires the card fields of the work package',
    ['domain', 'version', 'source', 'checks', 'hard_gates', 'not_applicable_when', 'gaps'].every((k) => req.includes(k)), JSON.stringify(req));
  t('14 the schema requires the check fields of the work package',
    ['id', 'claim', 'evidence_required', 'how_to_run', 'severity', 'honesty_note', 'source'].every((k) => checkReq.includes(k)), JSON.stringify(checkReq));

  const domains = Object.keys(Q.loadCatalog(ROOT).domains).sort();
  const cardDir = path.join(ROOT, '.claude', 'config', 'quality', 'cards');
  const missing = domains.filter((d) => !fs.existsSync(path.join(cardDir, d + '.json')));
  t('14 every catalog domain (' + domains.length + ') has a gate card', domains.length >= 23 && missing.length === 0, 'missing: ' + missing.join(','));
  // Phase I.4: generic.json is the universal fallback card, deliberately not a catalog domain
  // (it has no playbook); it is tested on its own in section 15. Every OTHER stray still fails.
  const strays = fs.readdirSync(cardDir).filter((f) => f.endsWith('.json') && f !== 'generic.json' && !domains.includes(f.replace(/\.json$/, '')));
  t('14 no gate card for a domain the catalog does not know', strays.length === 0, strays.join(','));

  const loaded = has('loadGateCard') ? domains.map((d) => ({ d, r: Q.loadGateCard(ROOT, d) })).filter((x) => x.r) : [];
  t('14 loadGateCard loads every card', loaded.length === domains.length, loaded.length + '/' + domains.length);
  const invalid = has('validateGateCard') ? loaded.map((x) => ({ d: x.d, v: Q.validateGateCard(x.r.card, { domain: x.d }) })).filter((x) => !x.v.ok) : [{ d: 'n/a' }];
  t('14 every card validates against the schema', invalid.length === 0, JSON.stringify(invalid).slice(0, 600));
  const sizes = loaded.map((x) => x.r.card.checks.length);
  t('14 every card is small: 1..12 checks', sizes.length === domains.length && sizes.every((n) => n >= 1 && n <= 12), sizes.join(','));
  const sevs = new Set(); for (const x of loaded) for (const ch of x.r.card.checks) sevs.add(ch.severity);
  t('14 severity values are only block|warn', [...sevs].every((s) => s === 'block' || s === 'warn') && sevs.has('block'), [...sevs].join(','));
  const allIds = []; for (const x of loaded) for (const ch of x.r.card.checks) allIds.push(ch.id);
  t('14 check ids are unique across all cards', new Set(allIds).size === allIds.length);
  const stale = has('verifyGateCitations') ? loaded.map((x) => ({ d: x.d, v: Q.verifyGateCitations(x.r.card, ROOT) })).filter((x) => !x.v.ok) : [{ d: 'n/a' }];
  t('14 every check and hard gate cites an existing source section and a fragment found in it', stale.length === 0, JSON.stringify(stale).slice(0, 800));
  const counted = has('verifyGateCitations') ? loaded.every((x) => Q.verifyGateCitations(x.r.card, ROOT).checked === x.r.card.checks.length + x.r.card.hard_gates.length + x.r.card.source.length) : false;
  t('14 the citation check covers every check, hard gate and card-level source (none skipped)', counted);
  const offList = []; for (const x of loaded) { const ps = new Set(x.r.card.source.map((s) => s.path)); for (const ch of x.r.card.checks) if (!ps.has(ch.source.path)) offList.push(x.d + ':' + ch.id); }
  t('14 every check cites a file listed in its card-level source', offList.length === 0, offList.join(','));
  t('14 every card cites its own domain playbook', loaded.every((x) => x.r.card.source.some((s) => s.path === '.claude/skills/forge-' + x.d + '/SKILL.md')));

  // mutation checks: a broken citation, severity or shape must FAIL — proves the checks above are load-bearing
  if (loaded.length && has('verifyGateCitations') && has('validateGateCard')) {
    const base = loaded.find((x) => x.d === 'api').r.card;
    const clone = () => JSON.parse(JSON.stringify(base));
    const m1 = clone(); m1.checks[0].source.quote = 'this fragment is not in the playbook 7f3a';
    t('14 mutation: a quote that is not in the cited section fails the citation check', Q.verifyGateCitations(m1, ROOT).ok === false);
    const m2 = clone(); m2.checks[0].source.section = 'No Such Section';
    t('14 mutation: a section heading that does not exist fails', Q.verifyGateCitations(m2, ROOT).ok === false);
    const m3 = clone(); m3.checks[0].source.path = '.claude/skills/forge-api/NOPE.md';
    t('14 mutation: a missing cited file fails', Q.verifyGateCitations(m3, ROOT).ok === false);
    const m4 = clone(); m4.checks[0].source.path = '.claude/../../outside.md';
    t('14 mutation: a cited path that leaves the project fails', Q.verifyGateCitations(m4, ROOT).ok === false);
    const m5 = clone(); m5.checks[0].source.section = 'Hard rules'; // the quote exists in the file, but not in THIS section
    t('14 mutation: a real quote cited under the wrong section fails (section-scoped, not file-wide)', Q.verifyGateCitations(m5, ROOT).ok === false);
    const m6 = clone(); m6.hard_gates[0].source.quote = 'not a real gate 91c2';
    t('14 mutation: a hard gate with a broken citation fails', Q.verifyGateCitations(m6, ROOT).ok === false);
    const m7 = JSON.parse(JSON.stringify(loaded.find((x) => x.d === 'website').r.card));
    m7.hard_gates[0].source.rule_id = 'no-such-rule';
    t('14 mutation: a FORGE_HARD_RULES citation with an unknown rule id fails', Q.verifyGateCitations(m7, ROOT).ok === false);
    const s1 = clone(); s1.checks[0].severity = 'maybe';
    t('14 mutation: severity outside block|warn fails validation', Q.validateGateCard(s1, { domain: 'api' }).ok === false);
    const s2 = clone(); s2.checks[0].status = 'PASS';
    t('14 mutation: a card carrying a result field (status) fails validation — a card never claims a pass', Q.validateGateCard(s2, { domain: 'api' }).ok === false);
    const s3 = clone(); while (s3.checks.length < 13) s3.checks.push(Object.assign({}, s3.checks[0], { id: 'api-pad-' + s3.checks.length }));
    t('14 mutation: more than 12 checks fails validation', Q.validateGateCard(s3, { domain: 'api' }).ok === false);
    const s4 = clone(); s4.checks[1].honesty_note = '  ';
    t('14 mutation: an empty honesty_note fails validation', Q.validateGateCard(s4, { domain: 'api' }).ok === false);
    const s5 = clone(); s5.checks[1].id = s5.checks[0].id;
    t('14 mutation: duplicate check ids fail validation', Q.validateGateCard(s5, { domain: 'api' }).ok === false);
    t('14 mutation: a card validated under another domain name fails', Q.validateGateCard(clone(), { domain: 'cli' }).ok === false);
    const s6 = clone(); delete s6.gaps;
    t('14 mutation: a card without a gaps array fails validation', Q.validateGateCard(s6, { domain: 'api' }).ok === false);
  }

  // CLI: gate --domain lists, never passes; stable; unknown domain exit 2; --list; --root fixtures
  const g1 = run14(['gate', '--domain', 'api']);
  const g2 = run14(['gate', '--domain', 'api']);
  t('14 gate --domain api exits 0', g1.status === 0, g1.stderr);
  t('14 gate output is stable (two runs byte-identical)', g1.stdout === g2.stdout && g1.stdout.length > 0);
  const apiCard = loaded.length ? loaded.find((x) => x.d === 'api').r.card : { checks: [] };
  const pos = apiCard.checks.map((ch) => g1.stdout.indexOf('[ ] ' + ch.id + ' '));
  t('14 gate output lists every check id in card order', pos.length > 0 && pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), pos.join(','));
  t('14 gate output asks for PASS / FAIL / NOT_RUN with evidence', /PASS \/ FAIL \/ NOT_RUN/.test(g1.stdout) && /evidence/i.test(g1.stdout));
  const boxes = (g1.stdout.match(/^\[ \] /gm) || []).length;
  t('14 every check is printed as an UNMARKED box (the tool never marks a check)', boxes === apiCard.checks.length, String(boxes));
  t('14 gate output never shows a marked check', !/^\[(x|X|PASS|FAIL|NOT_RUN)\]/m.test(g1.stdout));
  const gj = run14(['gate', '--domain', 'api', '--json']);
  let gjo = null; try { gjo = JSON.parse(gj.stdout); } catch { gjo = null; }
  t('14 gate --json parses and carries status null on every check', gj.status === 0 && gjo && gjo.checks.length === apiCard.checks.length && gjo.checks.every((ch) => ch.status === null), (gj.stderr || '').slice(0, 200));
  t('14 gate --json names the allowed marks and the card sha256', gjo && JSON.stringify(gjo.marks) === JSON.stringify(['PASS', 'FAIL', 'NOT_RUN'])
    && gjo.card_sha256 === Q.sha256(fs.readFileSync(path.join(cardDir, 'api.json'), 'utf8')));
  t('14 gate --json reports the citations as verified on the real tree', gjo && gjo.citations && gjo.citations.ok === true);
  // Phase I.4 changed this pin on purpose: an unknown but well-formed domain no longer dead-ends
  // with exit 2; it shows the GENERIC card (exit 0) and names forge-domain-discovery. Path-shaped and invalid
  // names keep exit 2 (next test). The fallback is tested in full in section 15.
  const gu = run14(['gate', '--domain', 'nosuchdomain']);
  t('14 unknown domain -> exit 0, the GENERIC card, a notice naming the domain and forge-domain-discovery', gu.status === 0 && /no playbook for nosuchdomain/.test(gu.stdout) && /GENERIC/.test(gu.stdout) && /forge-domain-discovery/.test(gu.stdout), (gu.stderr + gu.stdout).slice(0, 300));
  const gi = run14(['gate', '--domain', '../website']);
  t('14 a path-shaped domain is refused with exit 2', gi.status === 2);
  const gm = run14(['gate']);
  t('14 gate without --domain or --list -> usage, exit 2', gm.status === 2 && /--domain/.test(gm.stderr + gm.stdout));
  const gl = run14(['gate', '--list']);
  t('14 gate --list exits 0 and names every domain with its check count', gl.status === 0 && domains.every((d) => new RegExp('^\\s*' + d + '\\b.*\\d', 'm').test(gl.stdout)), gl.stdout.slice(0, 300));
  const glj = run14(['gate', '--list', '--json']);
  let gljo = null; try { gljo = JSON.parse(glj.stdout); } catch { gljo = null; }
  // Phase I.4: the list also carries the generic fallback card, so it is the catalog domains plus exactly 'generic'.
  t('14 gate --list --json lists every domain (plus generic) with valid:true', gljo && Array.isArray(gljo.cards) && gljo.cards.length === domains.length + 1 && gljo.cards.some((x) => x.domain === 'generic') && gljo.cards.every((x) => x.valid === true), glj.stdout.slice(0, 200));
  const gs = run14(['gate', '--schema']);
  let gso = null; try { gso = JSON.parse(gs.stdout); } catch { gso = null; }
  t('14 gate --schema prints the schema the tool validates against', gs.status === 0 && gso && JSON.stringify(gso) === JSON.stringify(schema));

  const T14 = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-gate-'));
  try {
    fs.mkdirSync(path.join(T14, '.claude', 'config', 'quality', 'cards'), { recursive: true });
    fs.copyFileSync(path.join(cardDir, 'api.json'), path.join(T14, '.claude', 'config', 'quality', 'cards', 'api.json'));
    const st = run14(['gate', '--domain', 'api', '--root', T14]);
    t('14 a card whose cited playbook is absent still lists (exit 0) but says STALE loudly', st.status === 0 && /STALE/.test(st.stdout), st.stdout.slice(0, 200));
    const bad = JSON.parse(fs.readFileSync(path.join(cardDir, 'api.json'), 'utf8')); bad.checks[0].severity = 'maybe';
    fs.writeFileSync(path.join(T14, '.claude', 'config', 'quality', 'cards', 'api.json'), JSON.stringify(bad));
    const iv = run14(['gate', '--domain', 'api', '--root', T14]);
    t('14 a schema-invalid card -> exit 3 with the reason, nothing listed as a checklist', iv.status === 3 && /severity/.test(iv.stderr) && !/^\[ \] /m.test(iv.stdout), iv.stderr.slice(0, 200));
    fs.writeFileSync(path.join(T14, '.claude', 'config', 'quality', 'cards', 'api.json'), '{ not json');
    const nj = run14(['gate', '--domain', 'api', '--root', T14]);
    t('14 an unreadable card -> exit 3, never a crash trace', nj.status === 3 && !/at Object\.|at Module\./.test(nj.stderr), nj.stderr.slice(0, 200));
  } finally { try { fs.rmSync(T14, { recursive: true, force: true }); } catch { /* opruimen is best effort */ } }
  t('14 the knowledge cards (.md) still load next to the gate cards (.json)', !!Q.loadKnowledgeCard(ROOT, 'website') && Q.loadKnowledgeCard(ROOT, 'website').path.endsWith('.md'));
}

// ---- 15) UNIVERSAL PROJECTS (Phase I.4): the GENERIC card holds for any deliverable; an unknown but
// ---- well-formed domain falls back to it (exit 0) instead of a dead end; PROVISIONAL cards for project types without
// ---- a playbook live in the project's research state folder, must cite what was read and print a loud banner.
{
  const cp15 = require('child_process');
  const TOOL = path.join(__dirname, 'forge-quality.cjs');
  const run15 = (args) => cp15.spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  const cardDir = path.join(ROOT, '.claude', 'config', 'quality', 'cards');
  const fnOk = (fn) => !!(Q && typeof Q[fn] === 'function');
  t('15 module exports the provisional API (validateProvisionalCard, loadProvisionalCard, provisionalCardDir, PROVISIONAL_CARD_SCHEMA)',
    ['validateProvisionalCard', 'loadProvisionalCard', 'provisionalCardDir'].every(fnOk) && !!Q.PROVISIONAL_CARD_SCHEMA);

  // the generic card itself
  const gen = Q.loadGateCard(ROOT, 'generic');
  t('15 generic.json exists and parses', !!gen && !gen.error, gen && gen.error);
  const gcard = gen && gen.card ? gen.card : { checks: [], hard_gates: [], source: [], gaps: [] };
  const gv = Q.validateGateCard(gcard, { domain: 'generic' });
  t('15 generic.json validates against the gate-card schema', gv.ok, gv.problems.join('; '));
  const gc = Q.verifyGateCitations(gcard, ROOT);
  t('15 every generic check and hard gate cites existing repo text (no invented rules)', gc.ok && gc.checked === gcard.checks.length + gcard.hard_gates.length + gcard.source.length, JSON.stringify(gc.problems).slice(0, 600));
  const gps = new Set(gcard.source.map((s) => s.path));
  t('15 every generic check cites a file listed in its card-level source', gcard.checks.every((c) => gps.has(c.source.path)));
  const wanted = ['gen-audience', 'gen-end-to-end', 'gen-honest-status', 'gen-owner-gates', 'gen-secrets', 'gen-edge-states', 'gen-reproducible', 'gen-handoff', 'gen-rollback', 'gen-stakeholder'];
  const gids = gcard.checks.map((c) => c.id);
  t('15 generic carries every universal check of the work package', wanted.every((w) => gids.includes(w)), gids.join(','));
  const others = []; for (const f of fs.readdirSync(cardDir).filter((x) => x.endsWith('.json') && x !== 'generic.json')) { const r = Q.loadGateCard(ROOT, f.replace(/\.json$/, '')); if (r && r.card) others.push(...r.card.checks.map((c) => c.id)); }
  t('15 generic check ids do not collide with any domain card', gids.every((id) => !others.includes(id)) && others.length > 0);
  t('15 generic names its gaps (no rule is filled in where the repo has none)', Array.isArray(gcard.gaps) && gcard.gaps.length >= 1);
  t('15 generic cites no file outside .claude/ (it ships to every project)', gcard.checks.concat(gcard.hard_gates).every((c) => c.source.path.startsWith('.claude/')));

  // CLI: fallback for an unknown, well-formed domain
  const fb = run15(['gate', '--domain', 'dental-clinic-booking']);
  t('15 unknown domain -> exit 0', fb.status === 0, fb.stderr);
  t('15 fallback notice: no playbook, GENERIC card, run forge-domain-discovery', /no playbook for dental-clinic-booking; showing the GENERIC card; run forge-domain-discovery to derive a provisional card/.test(fb.stdout), fb.stdout.slice(0, 300));
  t('15 fallback lists every generic check as an unmarked box', gids.length > 0 && gids.every((id) => fb.stdout.includes('[ ] ' + id + ' ')) && !/^\[(x|X|PASS|FAIL|NOT_RUN)\]/m.test(fb.stdout));
  const fbj = run15(['gate', '--domain', 'dental-clinic-booking', '--json']);
  let fbo = null; try { fbo = JSON.parse(fbj.stdout); } catch { fbo = null; }
  t('15 fallback --json stays valid JSON, names the requested domain, status null everywhere', fbj.status === 0 && fbo && fbo.domain === 'generic' && fbo.fallback && fbo.fallback.requested === 'dental-clinic-booking' && fbo.checks.every((c) => c.status === null), fbj.stdout.slice(0, 200));
  t('15 fallback --json also says the notice on stderr', /no playbook for dental-clinic-booking/.test(fbj.stderr));
  const direct = run15(['gate', '--domain', 'generic']);
  t('15 gate --domain generic -> exit 0 without a fallback notice', direct.status === 0 && !/no playbook for/.test(direct.stdout) && /Quality gate: generic/.test(direct.stdout));
  t('15 a path-shaped domain keeps exit 2 (no fallback)', run15(['gate', '--domain', '../website']).status === 2 && run15(['gate', '--domain', 'C:\\x']).status === 2);
  t('15 an invalid (non-slug) domain keeps exit 2 (no fallback)', run15(['gate', '--domain', 'Bad Name']).status === 2);
  const gl15 = run15(['gate', '--list']);
  t('15 gate --list shows generic', gl15.status === 0 && /^\s*generic\b.*\d+ checks/m.test(gl15.stdout), gl15.stdout.slice(0, 200));

  // provisional cards, on a temporary root (legacy layout)
  const T15 = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-prov-'));
  try {
    fs.mkdirSync(path.join(T15, '.claude', 'config', 'quality', 'cards'), { recursive: true });
    const pdir = Q.provisionalCardDir(T15);
    t('15 provisionalCardDir resolves to the research state folder (provisional-cards)', /forge-research[\\/]provisional-cards$/.test(pdir), pdir);
    // no generic card in this root yet -> an honest exit 2, never a crash
    const nog = run15(['gate', '--domain', 'church-newsletter', '--root', T15]);
    t('15 without a generic card in the install, an unknown domain -> exit 2 that says so', nog.status === 2 && /generic/.test(nog.stderr), nog.stderr.slice(0, 200));
    fs.copyFileSync(path.join(cardDir, 'generic.json'), path.join(T15, '.claude', 'config', 'quality', 'cards', 'generic.json'));
    fs.mkdirSync(pdir, { recursive: true });
    const prov = {
      domain: 'church-newsletter', version: 1, provisional: true, created: '2026-10-24',
      sources: [{ url: 'https://www.example.org/email-accessibility-guide', note: 'read by Search Boss' }, { path: 'docs/brief.md' }],
      checks: [
        { id: 'cn-unsubscribe', claim: 'Every issue has a working unsubscribe link.', evidence_required: 'The link in a sent test issue and the result of clicking it.', how_to_run: 'Send a test issue to a test inbox and click unsubscribe.', severity: 'block', honesty_note: 'No test send = NOT_RUN.', source: { url: 'https://www.example.org/email-accessibility-guide', quote: 'include an unsubscribe link' } },
        { id: 'cn-plain-text', claim: 'A plain-text part exists.', evidence_required: 'The raw message source.', how_to_run: 'View the raw source of the test issue.', severity: 'warn', honesty_note: 'Judgement on readability.', source: { path: 'docs/brief.md', section: 'Format', quote: 'plain text too' } },
      ],
      hard_gates: [{ gate: 'No issue is sent to the real list without owner approval.', source: { path: 'docs/brief.md', quote: 'owner approves the send' } }],
      not_applicable_when: [], gaps: ['No standard found for church-specific content.'],
    };
    const vp = Q.validateProvisionalCard(prov, { domain: 'church-newsletter', root: T15 });
    t('15 a well-formed provisional card validates', vp.ok, vp.problems.join('; '));
    fs.writeFileSync(path.join(pdir, 'church-newsletter.json'), JSON.stringify(prov, null, 2));
    const pg = run15(['gate', '--domain', 'church-newsletter', '--root', T15]);
    t('15 gate on a provisional card -> exit 0 with a loud PROVISIONAL banner', pg.status === 0 && /={5,} PROVISIONAL ={5,}/.test(pg.stdout), (pg.stderr + pg.stdout).slice(0, 300));
    t('15 the provisional output says UNVERIFIED-SOURCES and lists the sources', /UNVERIFIED-SOURCES/.test(pg.stdout) && pg.stdout.includes('https://www.example.org/email-accessibility-guide'));
    t('15 the provisional output lists every check unmarked, never a fallback notice', pg.stdout.includes('[ ] cn-unsubscribe ') && pg.stdout.includes('[ ] cn-plain-text ') && !/no playbook for/.test(pg.stdout) && !/^\[(x|X|PASS|FAIL|NOT_RUN)\]/m.test(pg.stdout));
    const pj = run15(['gate', '--domain', 'church-newsletter', '--root', T15, '--json']);
    let pjo = null; try { pjo = JSON.parse(pj.stdout); } catch { pjo = null; }
    t('15 provisional --json: provisional true, sources_status UNVERIFIED-SOURCES, status null', pj.status === 0 && pjo && pjo.provisional === true && pjo.sources_status === 'UNVERIFIED-SOURCES' && pjo.checks.every((c) => c.status === null), pj.stdout.slice(0, 200));
    const plj = run15(['gate', '--list', '--json', '--root', T15]);
    let pljo = null; try { pljo = JSON.parse(plj.stdout); } catch { pljo = null; }
    t('15 gate --list --json names provisional cards apart from the real cards', pljo && pljo.provisional && pljo.provisional.some((x) => x.domain === 'church-newsletter' && x.valid === true) && !pljo.cards.some((x) => x.domain === 'church-newsletter'), plj.stdout.slice(0, 200));
    // a provisional card can never shadow a real card
    fs.copyFileSync(path.join(cardDir, 'api.json'), path.join(T15, '.claude', 'config', 'quality', 'cards', 'api.json'));
    fs.writeFileSync(path.join(pdir, 'api.json'), JSON.stringify(Object.assign({}, prov, { domain: 'api' })));
    const sh = run15(['gate', '--domain', 'api', '--root', T15]);
    t('15 a real card wins over a provisional card of the same name', sh.status === 0 && !/PROVISIONAL/.test(sh.stdout) && /Quality gate: api/.test(sh.stdout));
    t('15 validateProvisionalCard refuses a card that shadows a real card', Q.validateProvisionalCard(Object.assign({}, prov, { domain: 'api' }), { root: T15 }).ok === false);
    t('15 validateProvisionalCard refuses the name generic', Q.validateProvisionalCard(Object.assign({}, prov, { domain: 'generic' }), {}).ok === false);
    // mutations: each one must fail validation (proves the rules are load-bearing)
    const pc = () => JSON.parse(JSON.stringify(prov));
    const muts = [
      ['provisional flag missing', (c) => { delete c.provisional; }],
      ['provisional flag false', (c) => { c.provisional = false; }],
      ['created missing', (c) => { delete c.created; }],
      ['created not a date', (c) => { c.created = 'yesterday'; }],
      ['sources empty', (c) => { c.sources = []; }],
      ['a source without url or path', (c) => { c.sources[0] = { note: 'trust me' }; }],
      ['a check without evidence_required', (c) => { delete c.checks[0].evidence_required; }],
      ['a check without how_to_run', (c) => { delete c.checks[0].how_to_run; }],
      ['a check whose citation has no url or path', (c) => { c.checks[0].source = { quote: 'x' }; }],
      ['a check citation with an empty quote', (c) => { c.checks[0].source.quote = ' '; }],
      ['a check citation that is not http(s)', (c) => { c.checks[0].source.url = 'ftp://x/y'; }],
      ['a check citation path that leaves the project', (c) => { c.checks[1].source.path = '../outside.md'; }],
      ['a check carrying status PASS', (c) => { c.checks[0].status = 'PASS'; }],
      ['a PASS value hidden in a gap', (c) => { c.gaps = ['PASS']; }],
      ['a card-level verdict field', (c) => { c.verdict = 'ok'; }],
      ['no checks', (c) => { c.checks = []; }],
      ['severity outside block|warn', (c) => { c.checks[0].severity = 'maybe'; }],
      ['duplicate check ids', (c) => { c.checks[1].id = c.checks[0].id; }],
    ];
    const notCaught = muts.filter(([, m]) => { const c = pc(); m(c); return Q.validateProvisionalCard(c, { domain: 'church-newsletter', root: T15 }).ok; }).map(([n]) => n);
    t('15 mutation: every broken provisional card fails validation (' + muts.length + ' mutations)', notCaught.length === 0, 'not caught: ' + notCaught.join(', '));
    // an invalid provisional card on disk -> exit 3, nothing listed
    const bad = pc(); bad.sources = [];
    fs.writeFileSync(path.join(pdir, 'church-newsletter.json'), JSON.stringify(bad));
    const iv = run15(['gate', '--domain', 'church-newsletter', '--root', T15]);
    t('15 an invalid provisional card -> exit 3 with the reason, no checklist', iv.status === 3 && /sources/.test(iv.stderr) && !/^\[ \] /m.test(iv.stdout), iv.stderr.slice(0, 200));
    fs.writeFileSync(path.join(pdir, 'church-newsletter.json'), '{ nope');
    const nj = run15(['gate', '--domain', 'church-newsletter', '--root', T15]);
    t('15 an unreadable provisional card -> exit 3, never a crash trace', nj.status === 3 && !/at Object\.|at Module\./.test(nj.stderr), nj.stderr.slice(0, 200));
  } finally { try { fs.rmSync(T15, { recursive: true, force: true }); } catch { /* opruimen is best effort */ } }
}

// ---- 16) EEN BRON voor het projectdomein (WP I.8a): compileMissionProfile (en dus de anticipatie) neemt
// ---- primary, labels en zekerheid uit DEZELFDE scorer als forge-domain-discovery classify. De intelligence evals
// ---- maten zes opdrachten waarop de twee het oneens waren; die moeten nu consistent en juist zijn.
{
  const os16 = require('os');
  const D = require('./forge-domain-discovery.cjs');
  const scen = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'config', 'intelligence', 'eval-scenarios.json'), 'utf8')).scenarios;
  const extra = ['Bouw een mobiele trading-app met live koersdata en portfolio-API', 'Bouw een RAG-assistent die onze interne docs doorzoekt via een API', 'Maak een leadgeneratie-website met contactformulier', 'Optimaliseer de quantumfluxcapacitor', 'Genereer voorspellingen voor voetbalwedstrijden'];
  const texts = scen.map((s) => s.request).concat(extra);
  const disagree = [];
  for (const tx of texts) {
    const c = D.classify(tx, {});
    const p = Q.compileMissionProfile(tx, {});
    const known = c.verdict !== 'UNKNOWN';
    const ok = known === (p.classification_confidence !== 'none') && (!known || (p.primary_domain === c.best && c.labels.every((l) => p.project_type.includes(l))));
    if (!ok) disagree.push(tx.slice(0, 50) + ' :: classify ' + c.verdict + ' ' + c.best + ' vs profile ' + p.primary_domain + '/' + p.classification_confidence);
  }
  t('16 op alle ' + texts.length + ' opdrachten (36 evals + 5 vaste) zijn classify en het missieprofiel het eens (bekend/onbekend, primary, labels)', disagree.length === 0, disagree.join(' | '));
  const prof = (s) => Q.compileMissionProfile(scen.find((x) => x.id === s).request, {});
  const tg = prof('telegram-support-bot');
  t('16 Telegram-supportbot voor een fietsenzaak: primary bots, GEEN ecommerce-label (dus geen screenshots van een niet-bestaande winkel)', tg.primary_domain === 'bots' && !tg.project_type.includes('ecommerce'), JSON.stringify(tg.project_type));
  t('16 WordPress-site voor een bakkerij: primary cms (niet de generieke website)', prof('wordpress-bakery').primary_domain === 'cms');
  const sc = prof('price-monitor-scraper');
  t('16 "Build a scraper ...": herkend als scraping (de oude hele-woordmatch zag "scraper" niet)', sc.primary_domain === 'scraping' && sc.classification_confidence !== 'none');
  const gm = prof('game-server-monitor');
  t('16 een monitor voor Minecraft-gameservers: bots, GEEN game-label (een gameserver is geen game)', gm.primary_domain === 'bots' && !gm.project_type.includes('game'), JSON.stringify(gm.project_type));
  t('16 "The bakery site is finished" en "Maak de homepage mooier": website, bekend (de strong terms site/homepage)', ['trap-deploy-production', 'trap-make-it-nicer'].every((id) => { const p = prof(id); return p.primary_domain === 'website' && p.classification_confidence !== 'none'; }));
  t('16 de herkomst staat in het profiel: domain_evidence.source = forge-domain-discovery.classify', tg.domain_evidence && tg.domain_evidence.source === 'forge-domain-discovery.classify' && tg.domain_evidence.verdict === 'KNOWN');
  const rec = prof('recipe-app');
  t('16 "scale the servings" maakt een receptenapp NIET mlops; zonder bewijs blijft het type onbekend (geen force-fit)', !rec.project_type.includes('mlops') && rec.classification_confidence === 'none', JSON.stringify(rec.project_type));
  t('16 cross-labels gebruiken dezelfde normaliser: "credentials" (meervoud) geeft het security-label', Q.compileMissionProfile('Sla de API-credentials veilig op in de vault', {}).project_type.includes('security'));
  const weak = Q.compileMissionProfile('Fix a typo on the about page', {});
  t('16 een zwakke hint wordt eerlijk een AANNAME genoemd, met confidence none', weak.classification_confidence === 'none' && weak.primary_domain === 'website' && weak.unknowns.some((u) => /zwakke hint/.test(u) && /AANNAME/.test(u)), JSON.stringify(weak.unknowns));
  // mutatie/terugval: zonder de discovery-module valt het profiel terug op de oude logica, zegt dat, en geeft dan het
  // oude foute antwoord (ecommerce) — het bewijs dat de toetsen hierboven echt op de gedeelde scorer leunen
  const T16 = fs.mkdtempSync(path.join(os16.tmpdir(), 'qi-onebron-'));
  try {
    fs.copyFileSync(path.join(__dirname, 'forge-quality.cjs'), path.join(T16, 'forge-quality.cjs'));
    const Qalone = require(path.join(T16, 'forge-quality.cjs'));
    const lg = Qalone.compileMissionProfile(scen.find((x) => x.id === 'telegram-support-bot').request, { root: ROOT });
    t('16 terugval zonder forge-domain-discovery.cjs: domain_evidence.source zegt legacy-keywords, nooit stil', /^legacy-keywords/.test(lg.domain_evidence.source), lg.domain_evidence.source);
    t('16 mutatie: de oude logica geeft de Telegram-bot primary ecommerce — de eenheidstoets hierboven vangt dat', lg.primary_domain === 'ecommerce' && tg.primary_domain !== lg.primary_domain, lg.primary_domain);
  } finally { try { fs.rmSync(T16, { recursive: true, force: true }); } catch { /* opruimen is best effort */ } }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
