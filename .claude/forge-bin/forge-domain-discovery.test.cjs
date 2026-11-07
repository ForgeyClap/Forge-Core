#!/usr/bin/env node
'use strict';
/**
 * forge-domain-discovery.test.cjs — Phase I.4 universal projects. node:assert-free, zero deps.
 * Covers: the lexicon (built from repo text only), classify on a 30-row A-to-Z table of realistic project
 * descriptions, the confidence rules (with a mutation proving the low-confidence rule is load-bearing), brief
 * (writes a template, never content), validate-card, and the no-network / determinism guarantees.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(__dirname, 'forge-domain-discovery.cjs');
const D = require(TOOL);
const Q = require('./forge-quality.cjs');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const run = (args) => cp.spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

// ---- 1) lexicon: built from the catalog, the router table and the playbook descriptions — nothing else
const lex = D.buildLexicon(ROOT);
const catalogDomains = Object.keys(Q.loadCatalog(ROOT).domains).sort();
t('1 the lexicon covers every catalog domain (' + catalogDomains.length + ')', catalogDomains.length >= 23 && catalogDomains.every((d) => lex.domains[d] && lex.domains[d].size > 0));
t('1 the lexicon reads every source without a problem on the real tree', lex.problems.length === 0, lex.problems.join('; '));
const routerText = fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'forge-router', 'SKILL.md'), 'utf8');
const rows = D.routerRows(routerText);
t('1 every catalog domain has a router Step 1 row', catalogDomains.every((d) => rows.some((r) => r.domain === d)), catalogDomains.filter((d) => !rows.some((r) => r.domain === d)).join(','));
const srcs = new Set(); for (const m of Object.values(lex.domains)) for (const e of m.values()) for (const s of e.sources) srcs.add(s);
t('1 term evidence comes only from catalog, router and description', [...srcs].sort().join(',') === 'catalog,description,router', [...srcs].join(','));
const allDesc = catalogDomains.map((d) => { const m = /description:\s*"(.*)"/.exec(fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'forge-' + d, 'SKILL.md'), 'utf8')); return m ? m[1] : ''; });
const rawFrags = new Set(); for (const desc of allDesc) for (const f of desc.replace(/^playbook for\s+/i, '').split(/[,:;]|\band\b/i)) rawFrags.add(f.trim().toLowerCase());
t('1 description stop words: each one is really produced by a description (no speculative list)', [...D.DESCRIPTION_STOP].every((w) => rawFrags.has(w)), [...D.DESCRIPTION_STOP].filter((w) => !rawFrags.has(w)).join(','));
const strongTerm = (w) => Object.values(lex.domains).some((m) => { const e = m.get(w); return e && (e.sources.includes('catalog') || e.sources.includes('router')); });
t('1 description stop words never drop a catalog or router term', [...D.DESCRIPTION_STOP].every((w) => !strongTerm(w)));
t('1 a term counts once per source: "game", "game*" and "games" are ONE entry for game', (() => { const e = lex.domains.game.get('game'); return !!e && e.sources.filter((s) => s === 'catalog').length === 1 && !lex.domains.game.has('games') && !lex.domains.game.has('game*'); })());

// ---- 2) matcher
t('2 whole words only: "site" does not match "website"', D.termMatches(' my website ', 'site') === false);
t('2 plural and -ing forms match: scrape -> scraping, game -> games', D.termMatches(' a scraping job ', 'scrape') && D.termMatches(' two games ', 'game'));
t('2 a catalog stem* stays open on the right: game* -> gameplay', D.termMatches(' smooth gameplay ', 'game*') && !D.termMatches(' smooth gameplay ', 'game'));

// ---- 3) the A-to-Z table. expect: a domain (best, or primary/secondary of a MIXED), 'UNKNOWN', or null (= ambiguous,
// ---- recorded and reported, never forced). Expectations come from the playbooks' "Use for" lines, decided first.
const TABLE = [
  ['dental clinic booking site', 'Booking website for a dental clinic: patients pick a free time slot and get a confirmation', 'website'],
  ['accountant invoice spreadsheet', 'An invoice spreadsheet for an accountant that totals VAT per quarter', 'UNKNOWN'],
  ['kids drawing game', 'A drawing game for kids where they paint animals with their finger', 'game'],
  ['3D-print shop', 'An online shop for my 3D-print business with a cart and checkout', 'ecommerce'],
  ['podcast pipeline', 'A podcast pipeline: record an episode, transcribe it and publish it to Spotify', 'UNKNOWN'],
  ['church newsletter', 'A monthly newsletter for our church congregation', 'UNKNOWN'],
  ['warehouse inventory sheet', 'An inventory sheet for our warehouse to count stock per shelf', null], // homonym: "warehouse" is a data keyword
  ['wedding RSVP page', 'An RSVP page on our wedding website where guests confirm and choose a meal', 'website'],
  ['a trading project-style prediction bot', 'A a trading project-style prediction bot that forecasts event odds and backtests its picks', 'prediction'],
  ['Telegram support bot', 'A Telegram support bot that answers customer questions', 'bots'],
  ['Chrome extension', 'A Chrome extension that blocks distracting sites while I work', 'extension'],
  ['Godot platformer', 'A platformer game in Godot with three levels', 'game'],
  ['WordPress for a bakery', 'A WordPress site for a bakery with an opening-hours page', 'cms'],
  ['n8n lead router', 'An n8n workflow that routes new leads to the right salesperson', 'n8n'],
  ['CLI log parser', 'A CLI tool that parses server log files and prints error counts', 'cli'],
  ['dbt data warehouse', 'A data warehouse in dbt with staging and marts models', 'data'],
  ['mobile habit tracker', 'A mobile habit tracker app for iOS and Android', 'mobile'],
  ['voice receptionist', 'A voice receptionist that answers the phone for a hair salon and books appointments', 'voice'],
  ['scraping price monitor', 'A scraping price monitor that checks competitor prices every night', 'scraping'],
  ['internal admin dashboard', 'An internal admin dashboard for our support team with login and user management', 'fullstack'],
  ['legal-document generator', 'A legal-document generator that fills contract templates from a questionnaire', 'UNKNOWN'],
  ['recipe app', 'A recipe app where people save and share recipes', 'UNKNOWN'], // web or mobile? no playbook fits on its own
  ['IoT sensor dashboard', 'An IoT sensor dashboard that shows live temperature readings', null], // dashboards fold into website/fullstack; IoT has no playbook
  ['research paper pipeline', 'A research paper pipeline that collects papers, summarises them and builds a reading list', 'UNKNOWN'],
  ['language-learning bot', 'A language-learning bot on Telegram that quizzes vocabulary every day', 'bots'],
  ['music playlist tool', 'A music playlist tool that sorts my Spotify playlists by mood', 'UNKNOWN'],
  // WP I.8a: was UNKNOWN. The router's Step 1 table routes "assistant" to forge-rag and the catalog already had the
  // Dutch "assistent"; the intelligence evals (cause 3) found the English word missing. "assistant" is now a catalog
  // keyword (2 + router 1) and "assistent" weighs 3, so both languages reach the floor alike.
  ['grant-application assistant', 'A grant-application assistant that drafts answers from our past applications', 'rag'],
  ['game-server monitor', 'A monitor for our Minecraft game server that alerts when it goes down', null], // homonym: an ops monitor, not a game
  ['e-learning course site', 'An e-learning course website with video lessons and quizzes', 'website'],
  ['charity donation page', 'A donation page for a charity with Stripe payments', 'payments'],
];
t('3 the table holds 30 realistic descriptions', TABLE.length === 30);
const meets = (r, exp) => (exp === 'UNKNOWN' ? r.verdict === 'UNKNOWN' : r.verdict !== 'UNKNOWN' && (r.best === exp || r.mixed.includes(exp)));
const results = TABLE.map(([label, text, exp]) => ({ label, exp, r: D.classify(text, { lexicon: lex }) }));
for (const x of results) {
  const shape = ['KNOWN', 'MIXED', 'UNKNOWN'].includes(x.r.verdict) && ['high', 'medium', 'low', 'none'].includes(x.r.confidence);
  if (x.exp === null) t('3 ambiguous, recorded not forced: ' + x.label + ' -> ' + x.r.verdict + ' ' + x.r.best + ' (' + x.r.confidence + ')', shape);
  else t('3 ' + x.label + ' -> ' + x.exp, shape && meets(x.r, x.exp), x.r.verdict + ' ' + x.r.best + ' ' + JSON.stringify(x.r.scores));
}
t('3 UNKNOWN always comes with confidence low or none', results.every((x) => (x.r.verdict === 'UNKNOWN') === (x.r.confidence === 'low' || x.r.confidence === 'none')));
const mixedR = D.classify('A Next.js SaaS with login, a Postgres database and Stripe billing', { lexicon: lex });
t('3 a SaaS with Stripe billing is MIXED fullstack + payments', mixedR.verdict === 'MIXED' && mixedR.mixed.includes('fullstack') && mixedR.mixed.includes('payments'), JSON.stringify(mixedR.scores));
// WP I.8a: "a site" was the example here; "site" is now a strong term (the trap "The bakery site is finished" must
// plan the website card), so a plain, non-strong keyword carries the rule instead.
const one = D.classify('a page', { lexicon: lex });
t('3 one weak keyword is not evidence: "a page" is UNKNOWN (low), with the hint kept', one.verdict === 'UNKNOWN' && one.confidence === 'low' && one.top_candidate === 'website');
const strong1 = D.classify('a site', { lexicon: lex });
t('3 one STRONG keyword is evidence: "a site" is KNOWN website (medium), the strong term is named', strong1.verdict === 'KNOWN' && strong1.best === 'website' && strong1.confidence === 'medium' && (strong1.strong_terms.website || []).includes('site'), JSON.stringify(strong1));
const tie = D.classify('a webshop page', { lexicon: lex });
t('3 a strong term does not lift a tie: "a webshop page" (ecommerce 2 = website 2) stays UNKNOWN', tie.verdict === 'UNKNOWN' && tie.scores.ecommerce === tie.scores.website, JSON.stringify(tie.scores));
t('3 empty text -> UNKNOWN, none', D.classify('', { lexicon: lex }).confidence === 'none');
t('3 classify is deterministic', JSON.stringify(D.classify(TABLE[8][1], { lexicon: lex })) === JSON.stringify(D.classify(TABLE[8][1], {})));

// ---- 4) mutation: remove the low-confidence rule -> the table must catch it
{
  const src = fs.readFileSync(TOOL, 'utf8');
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.includes('RULE:low-confidence'));
  t('4 the low-confidence rule is one marked line', idx > 0 && lines.filter((l) => l.includes('RULE:low-confidence')).length === 1);
  const MDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-mut-'));
  try {
    const mutant = path.join(MDIR, 'forge-domain-discovery.cjs');
    fs.writeFileSync(mutant, lines.filter((_, i) => i !== idx).join('\n'));
    for (const dep of ['forge-text-normalize.cjs', 'forge-domain-deliverable.cjs']) fs.copyFileSync(path.join(__dirname, dep), path.join(MDIR, dep)); // its dependencies
    const M = require(mutant);
    const broken = TABLE.filter(([, text, exp]) => exp !== null && !meets(M.classify(text, { root: ROOT }), exp)).map(([label]) => label);
    t('4 mutation: without the low-confidence rule at least one table expectation fails (' + broken.join(', ') + ')', broken.length >= 1);
    t('4 mutation: the recipe app is force-fitted to a playbook by the mutant', M.classify(TABLE[21][1], { root: ROOT }).verdict !== 'UNKNOWN');
  } finally { try { fs.rmSync(MDIR, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// ---- 5) CLI classify
const c1 = run(['classify', '--text', 'A monthly newsletter for our church congregation']);
t('5 classify CLI exit 0 and says UNKNOWN + brief', c1.status === 0 && /UNKNOWN/.test(c1.stdout) && /brief/.test(c1.stdout), c1.stderr);
const c2 = run(['classify', '--text', 'A platformer game in Godot with three levels', '--json']);
let c2o = null; try { c2o = JSON.parse(c2.stdout); } catch { c2o = null; }
t('5 classify --json returns {best, confidence, scores, matched_terms, mixed}', c2.status === 0 && c2o && c2o.best === 'game' && typeof c2o.scores === 'object' && Array.isArray(c2o.matched_terms.game) && Array.isArray(c2o.mixed) && c2o.confidence === 'high');
t('5 classify without --text -> usage exit 2', run(['classify']).status === 2);
t('5 an unknown subcommand -> usage exit 2', run(['research']).status === 2);

// ---- 6) brief + validate-card on a temporary project root
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-brief-'));
try {
  fs.mkdirSync(path.join(T, '.claude', 'config', 'quality', 'cards'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.claude', 'config', 'quality', 'cards', 'api.json'), path.join(T, '.claude', 'config', 'quality', 'cards', 'api.json'));
  const b = run(['brief', '--text', 'A monthly newsletter for our church congregation', '--name', 'church-newsletter', '--root', T, '--date', '2026-10-24']);
  const bdir = path.join(Q.provisionalCardDir(T), '..', 'discovery', 'church-newsletter');
  const briefPath = path.join(bdir, 'BRIEF.md');
  const skelPath = path.join(bdir, 'card-skeleton.json');
  t('6 brief exit 0 and writes BRIEF.md + card-skeleton.json in the research state folder', b.status === 0 && fs.existsSync(briefPath) && fs.existsSync(skelPath), b.stderr);
  const brief = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, 'utf8') : '';
  const qs = ['Who uses it?', 'What does good look like?', 'What breaks it?', 'Which standards, regulations or conventions apply?', 'What evidence proves it is done?', 'Which hard gates apply?'];
  t('6 the brief asks all six questions', qs.every((q) => brief.includes(q)));
  t('6 the brief demands real sources and says the classifier verdict', /Sources read \(URL or repo file\)/.test(brief) && /never fill a gap from memory/.test(brief) && /Classifier: UNKNOWN/.test(brief));
  t('6 the brief carries no answers (every Answer: is empty)', (brief.match(/^Answer:\s*\n\s*\n/gm) || []).length === qs.length);
  let skel = null; try { skel = JSON.parse(fs.readFileSync(skelPath, 'utf8')); } catch { skel = null; }
  t('6 the skeleton is empty on purpose: provisional, dated, no sources, no checks', skel && skel.provisional === true && skel.created === '2026-10-24' && skel.domain === 'church-newsletter' && skel.sources.length === 0 && skel.checks.length === 0);
  const vs = run(['validate-card', skelPath, '--root', T]);
  t('6 validate-card refuses the unfilled skeleton (exit 3, names sources and checks)', vs.status === 3 && /sources/.test(vs.stderr) && /checks/.test(vs.stderr), vs.stderr.slice(0, 300));
  t('6 brief refuses to overwrite (exit 3) unless --force', run(['brief', '--text', 'x', '--name', 'church-newsletter', '--root', T]).status === 3
    && run(['brief', '--text', 'x', '--name', 'church-newsletter', '--root', T, '--force', '--date', '2026-10-25']).status === 0);
  t('6 brief refuses a path-shaped name (exit 2)', run(['brief', '--text', 'x', '--name', '../evil', '--root', T]).status === 2);
  t('6 brief refuses a real card name and generic (exit 2)', run(['brief', '--text', 'x', '--name', 'api', '--root', T]).status === 2 && run(['brief', '--text', 'x', '--name', 'generic', '--root', T]).status === 2);
  t('6 brief without --text -> exit 2', run(['brief', '--name', 'abc', '--root', T]).status === 2);
  // fill the skeleton as the Lead would (sources actually read), then validate and gate it
  const filled = Object.assign({}, skel, {
    sources: [{ url: 'https://www.example.org/newsletter-guide' }],
    checks: [{ id: 'cn-unsub', claim: 'Every issue has a working unsubscribe link.', evidence_required: 'The link in a test issue and the result of clicking it.', how_to_run: 'Send a test issue to a test inbox; click unsubscribe.', severity: 'block', honesty_note: 'No test send = NOT_RUN.', source: { url: 'https://www.example.org/newsletter-guide', quote: 'unsubscribe link' } }],
  });
  const provDir = Q.provisionalCardDir(T);
  fs.mkdirSync(provDir, { recursive: true });
  const cardPath = path.join(provDir, 'church-newsletter.json');
  fs.writeFileSync(cardPath, JSON.stringify(filled, null, 2));
  const vf = run(['validate-card', cardPath, '--root', T]);
  t('6 validate-card accepts a filled card and says UNVERIFIED-SOURCES', vf.status === 0 && /VALID/.test(vf.stdout) && /UNVERIFIED-SOURCES/.test(vf.stdout), vf.stderr);
  const misnamed = path.join(provDir, 'other-name.json');
  fs.writeFileSync(misnamed, JSON.stringify(filled));
  t('6 validate-card in the provisional folder checks the file name matches the domain', run(['validate-card', misnamed, '--root', T]).status === 3);
  fs.writeFileSync(misnamed, JSON.stringify(Object.assign({}, filled, { domain: 'other-name', checks: [Object.assign({}, filled.checks[0], { status: 'PASS' })] })));
  const vp = run(['validate-card', misnamed, '--root', T, '--json']);
  let vpo = null; try { vpo = JSON.parse(vp.stdout); } catch { vpo = null; }
  t('6 validate-card refuses a card carrying a PASS field (exit 3, --json lists the problem)', vp.status === 3 && vpo && vpo.ok === false && vpo.problems.some((p) => /status/.test(p)));
  fs.writeFileSync(misnamed, '{ broken');
  t('6 validate-card on unreadable JSON -> exit 3, no crash trace', (() => { const r = run(['validate-card', misnamed, '--root', T]); return r.status === 3 && !/at Object\.|at Module\./.test(r.stderr); })());
  t('6 validate-card without a file -> exit 2', run(['validate-card']).status === 2);
  fs.unlinkSync(misnamed);
  const g = cp.spawnSync(process.execPath, [path.join(__dirname, 'forge-quality.cjs'), 'gate', '--domain', 'church-newsletter', '--root', T], { encoding: 'utf8' });
  t('6 end to end: the validated card is what gate --domain <slug> shows, behind the PROVISIONAL banner', g.status === 0 && /PROVISIONAL/.test(g.stdout) && g.stdout.includes('[ ] cn-unsub '), (g.stderr + g.stdout).slice(0, 300));
} finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } }

// ---- 7) the tool stays offline and never researches
const toolSrc = fs.readFileSync(TOOL, 'utf8');
t('7 no network or process modules, no fetch', !/require\(['"](https?|net|dns|tls|child_process)['"]\)/.test(toolSrc) && !/\bfetch\(/.test(toolSrc));
t('7 only reads the catalog, router and playbooks, and writes only under the research state folder', !/writeFileSync\((?!files\[)/.test(toolSrc));

// ---- 8) WP I.8a: Dutch (and English) domain regression table, with plural and compound variants
const NL_DOMAINS = [
  ['Maak een spraakassistent die de telefoon opneemt voor de kapsalon', 'voice'],
  ['Bouw een e-learningsite voor onze fotografiecursus', 'website'],
  ['Bouw een RSVP-pagina voor onze bruiloft', 'website'],
  ["Maak twee landingspagina's voor de zomeractie", 'website'],
  ['Maak de homepage mooier', 'website'],
  ['Bouw een webwinkel voor handgemaakte kaarsen', 'ecommerce'],
  ['Een webshop met een winkelwagen en afrekenen via iDEAL', 'ecommerce'],
  ['Bouw een klantenportaal waar klanten inloggen en facturen zien', 'fullstack'],
  ['Een beheerpaneel met gebruikersbeheer voor het supportteam', 'fullstack'],
  ['Genereer voorspellingen voor voetbalwedstrijden', 'prediction'],
  ['Bouw een mobiele app voor hardlopers', 'mobile'],
  ['Maak een chatbot op basis van onze kennisbank', 'rag'],
  ['Een AI-assistent die vragen beantwoordt uit onze handleidingen', 'rag'],
  ['Koppel de betalingen van Mollie aan onze boekhouding', 'payments'],
  ['Bouw een Discord-bot die elke dag Spaanse woorden overhoort', 'bots'],
  ['Zet een WordPress-site op voor de bakkerij', 'cms'],
  ['Bouw een datawarehouse met dbt-modellen', 'data'],
  ['Migreer de legacy-applicatie stap voor stap', 'migration'],
  ['Een scraper die elke nacht de prijzen van concurrenten ophaalt', 'scraping'],
  ['n8n-workflows die nieuwe leads naar het CRM sturen', 'n8n'],
  ['Bouw een Chrome-extensie die prijzen omrekent', 'extension'],
  ['Maak een spel voor kinderen met drie levels', 'game'],
  ['Twee bordspellen voor in de browser', 'game'],
  // the unknown-type controls stay UNKNOWN (intelligence bar rule 3: no force-fit)
  ['Een maandelijkse nieuwsbrief voor de kerk met de agenda', 'UNKNOWN'],
  ['Een podcast-pipeline die afleveringen transcribeert en shownotes schrijft', 'UNKNOWN'],
  ['Een tooltje dat mijn Spotify-afspeellijsten op tempo sorteert', 'UNKNOWN'],
  ['Een pipeline die wetenschappelijke artikelen verzamelt en samenvat', 'UNKNOWN'],
  ['Een Excel-spreadsheet voor de administratie met alle facturen', 'UNKNOWN'], // "spreadsheet" is deliberately no strong term
  ['Een tafelschikking voor een gala met 120 gasten', 'UNKNOWN'],
];
for (const [text, exp] of NL_DOMAINS) {
  const r = D.classify(text, { lexicon: lex });
  t('8 "' + text + '" -> ' + exp, exp === 'UNKNOWN' ? r.verdict === 'UNKNOWN' : r.verdict !== 'UNKNOWN' && r.best === exp, r.verdict + ' ' + r.best + ' ' + JSON.stringify(r.scores));
}
// negative controls: look-alikes that must NOT produce the domain (as best, mixed or label)
const NEG_DOMAINS = [
  ['Start the Command Center on port 4100', 'migration'],
  ['Our support team needs a ticket list', 'migration'],
  ['A client portal for our accountants', 'migration'],
  ['Integrate the payment gateway for the shop checkout', 'migration'],
  ['Build a recipe app where people can save recipes and scale the servings', 'mlops'],
  ['Een website voor onze personal training studio', 'mlops'],
  ['A Telegram bot for our bike repair shop', 'ecommerce'],
  ['Een website voor onze fietsenwinkel met openingstijden', 'ecommerce'],
  ['Build a monitor for our Minecraft game servers that alerts in Discord', 'game'],
  ['Wij verkopen kennis over softwareproducten', 'ecommerce'],
  ['Analyseer de bijproducten van het productieproces', 'ecommerce'],
  ['Deploy the site after the production build', 'ecommerce'],
  ['De handleiding bespreekt spiderdiagrammen', 'scraping'],
  ['Maak de releases voorspelbaarder', 'prediction'],
  ['A quick tip for the homepage hero', 'prediction'],
  ['Maak de website mobielvriendelijk', 'mobile'],
  ['Een vectorlogo voor de bakkerij', 'rag'],
  ['Een website voor een tandartsassistent in opleiding', 'rag'],
  ['Een contactformulier met naam, e-mail en telefoonnummer', 'voice'],
  ['Schrijf een toespraak voor de bruiloft', 'voice'],
  ['Maak een afspraakformulier op de website', 'voice'],
  ['Brood met boter op de menukaart', 'bots'],
  ['Wat staat er op het spel bij deze migratie?', 'game'],
  // 2.9c follow-up: a git checkout is a command, not a webshop checkout (exclude on ecommerce AND payments)
  ['doe een git checkout van main en maak een nieuwe branch', 'ecommerce'],
  ['doe een git checkout van main en maak een nieuwe branch', 'payments'],
  ['checkout branch feature-x and rebase it on main', 'ecommerce'],
  ['Checkout the branch and run the tests', 'ecommerce'],
];
for (const [text, dom] of NEG_DOMAINS) {
  const r = D.classify(text, { lexicon: lex });
  const hitDom = (r.verdict !== 'UNKNOWN' && (r.best === dom || r.mixed.includes(dom))) || (r.labels || []).includes(dom);
  t('8 negative control: "' + text + '" is NOT ' + dom, !hitDom, r.verdict + ' ' + r.best + ' ' + JSON.stringify(r.scores));
}
t('8 the Dutch tables hold at least 40 phrases with an expected domain or a forbidden one', NL_DOMAINS.length + NEG_DOMAINS.length >= 40);

// ---- 9) WP I.8a: the matching rules behind the table
const wl = D.classify('Bouw een webwinkel', { lexicon: lex });
t('9 a compound match is reported with the word it was found in', (wl.matched_terms.ecommerce || []).some((m) => /webwinkel/.test(m)) || (wl.matched_terms.ecommerce || []).includes('webwinkel'));
const ea = D.classify('Bouw een e-learningsite', { lexicon: lex });
t('9 the allow-listed short stem "site" matches as a compound head ("site (in learningsite)")', (ea.matched_terms.website || []).some((m) => m === 'site (in learningsite)'), JSON.stringify(ea.matched_terms));
const sp = D.classify('Maak een spraakassistent', { lexicon: lex });
t('9 a token some term matches exactly is never split: "spraakassistent" counts for voice only, not for rag', sp.scores.voice > 0 && !sp.scores.rag, JSON.stringify(sp.scores));
const pp = D.classify('Bouw een productpagina voor onze schoenen', { lexicon: lex });
t('9 an exact word is not also read as a compound: "productpagina" is ecommerce and adds no website "pagina"', pp.scores.ecommerce > 0 && !pp.scores.website, JSON.stringify(pp.scores));
const va = D.classify('Build a voice assistant that answers the phone', { lexicon: lex });
t('9 a multi-word catalog phrase owns its words: "voice assistant" is KNOWN voice, the rag "assistant" is not counted', va.verdict === 'KNOWN' && va.best === 'voice' && !va.scores.rag, JSON.stringify(va.scores));
const ws = D.classify('Bouw een webshop-site met checkout', { lexicon: lex });
t('9 a hyphenated catalog compound ("webshop-site") does not own its words: "webshop" still counts for ecommerce', (ws.matched_terms.ecommerce || []).includes('webshop'), JSON.stringify(ws.matched_terms));
const tg = D.classify('Create a Telegram bot that answers customer questions for our bike repair shop', { lexicon: lex });
t('9 needs_support: "shop" alone does not count for ecommerce and the result says so (unsupported_terms)', !tg.scores.ecommerce && tg.unsupported_terms && (tg.unsupported_terms.ecommerce || []).includes('shop'), JSON.stringify(tg));
const sup = D.classify('An online shop with a cart for our bike repair shop', { lexicon: lex });
t('9 needs_support: next to another ecommerce term "shop" counts again', (sup.matched_terms.ecommerce || []).includes('shop'), JSON.stringify(sup.matched_terms));
const gs = D.classify('A Godot game with a game server for multiplayer', { lexicon: lex });
t('9 exclude is local: "game server" is blanked but "Godot game" still counts for game', gs.best === 'game', JSON.stringify(gs.scores));
t('9 classify returns labels (the domains that pass the floor on their own, best first) and strong_terms', Array.isArray(wl.labels) && wl.labels[0] === 'ecommerce' && wl.strong_terms.ecommerce.includes('webwinkel'));
t('9 UNKNOWN carries no labels (nothing passed the floor)', D.classify('a page', { lexicon: lex }).labels.length === 0);
// 2.9c follow-up: the git-checkout exclude is local to that phrase; a shop checkout still counts
const gco = D.classify('doe een git checkout van main en maak een nieuwe branch', { lexicon: lex });
t('9 "doe een git checkout van main ..." is not KNOWN ecommerce (UNKNOWN, no checkout evidence left)', gco.verdict === 'UNKNOWN' && !gco.scores.ecommerce && !gco.scores.payments, JSON.stringify(gco));
const shopCo = D.classify('Een webshop met een snelle checkout en een git checkout van de code', { lexicon: lex });
t('9 the exclude only blanks "git checkout": the shop checkout in the same sentence still counts for ecommerce', shopCo.verdict !== 'UNKNOWN' && shopCo.best === 'ecommerce' && (shopCo.matched_terms.ecommerce || []).includes('checkout'), JSON.stringify(shopCo.matched_terms));
// 2.9c follow-up: the normaliser stop-lists reach the lexicon shapes (no -er look-alike, a plural-only term keeps its plural)
t('9 a lexicon word never gets a stop-listed -er form ("platform" -> no "platformer") and a plural-only term is keyed by its plural',
  !D.termShape('platform').surface.has('platformer') && D.termShape('rechten').key === 'rechten' && D.termShape('sources').key === 'sources' && !D.termShape('sources').surface.has('source') && D.termShape('wachtwoorden').key === 'wachtwoord');
const plat = D.classify('A 2D platformer for a chat bot platform company', { lexicon: lex });
t('9 "platformer" does not complete the bots phrase "chat bot platform" a second time, the real phrase still does', (plat.matched_terms.bots || []).includes('chat bot platform') && !((D.classify('a chat bot platformer', { lexicon: lex }).matched_terms.bots || []).includes('chat bot platform')), JSON.stringify(plat.matched_terms));

// ---- 10) WP I.8a: the catalog classifier fields are validated (a typo is a lexicon problem, never silent)
{
  const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cat-'));
  try {
    fs.mkdirSync(path.join(RT, '.claude', 'config', 'orchestration'), { recursive: true });
    const writeCat = (website) => fs.writeFileSync(path.join(RT, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify({ version: 1, domains: { website } }));
    const probs = () => D.buildLexicon(RT).problems.filter((p) => !/unreadable/.test(p));
    writeCat({ playbook: 'forge-website', keywords: ['website', 'site'], strong_terms: ['site'], exclude: ['on site'], needs_support: ['site'], no_compound: ['website'], weights: { site: 3 } });
    t('10 a strong term that also needs support is refused', probs().some((p) => /strong term and need support/.test(p)), probs().join('; '));
    writeCat({ playbook: 'forge-website', keywords: ['website'], strong_terms: ['homepage'] });
    t('10 a strong term that is not a keyword is refused', probs().some((p) => /strong term "homepage" is not one of its keywords/.test(p)));
    writeCat({ playbook: 'forge-website', keywords: ['website'], no_compound: ['webshop'] });
    t('10 a no_compound entry that is not a keyword is refused', probs().some((p) => /no_compound "webshop"/.test(p)));
    writeCat({ playbook: 'forge-website', keywords: ['website'], weights: { website: 7, other: 2 } });
    t('10 a weight outside 1..3 and a weight for an unknown keyword are refused', probs().some((p) => /1\.\.3/.test(p)) && probs().some((p) => /weights names "other"/.test(p)));
    writeCat({ playbook: 'forge-website', keywords: ['website'], exclude: ['site.com'] });
    t('10 an exclude phrase with punctuation is refused', probs().some((p) => /exclude "site\.com"/.test(p)));
    writeCat({ playbook: 'forge-website', keywords: ['website'], needs_support: ['nowhere'] });
    t('10 a needs_support term that is not in the lexicon is refused', probs().some((p) => /needs_support "nowhere" is not in its lexicon/.test(p)));
    writeCat({ playbook: 'forge-website', keywords: ['website', 'site'], strong_terms: ['site'] });
    t('10 a clean catalog has no classifier problems', probs().length === 0, probs().join('; '));
  } finally { try { fs.rmSync(RT, { recursive: true, force: true }); } catch { /* best effort */ } }
}
const realCat = Q.loadCatalog(ROOT);
const strongAll = Object.entries(realCat.domains).flatMap(([d, def]) => (def.strong_terms || []).map((s) => d + ':' + s));
t('10 the real strong-term list is short and reviewed (<= 40 terms) and never names "spreadsheet"', strongAll.length > 0 && strongAll.length <= 40 && !strongAll.some((s) => /spreadsheet/.test(s)), strongAll.length + ' terms');
t('10 every classifier field in the real catalog is one of the documented ones', Object.values(realCat.domains).every((def) => Object.keys(def).every((k) => ['playbook', 'intake_pack', 'preset', 'keywords'].concat(D.CLASSIFIER_FIELDS).includes(k))));

// ---- 11) the cache never serves a stale lexicon
{
  const a = D.buildLexicon(ROOT);
  t('11 the lexicon is cached per root while its files are unchanged', D.buildLexicon(ROOT) === a);
}

// ---- 12) WP I.10: the deliverable rule, the verb "migrate" and verb-object sequences (each with false friends)
{
  const c = (text) => D.classify(text, { lexicon: lex });
  const known = (r, d) => r.verdict !== 'UNKNOWN' && r.best === d;
  const not = (r, d) => !((r.verdict !== 'UNKNOWN' && (r.best === d || r.mixed.includes(d))) || (r.labels || []).includes(d));
  // (1) what is BUILT wins a conflict with the words for the data it touches
  const mcp = c('Build an MCP server that lets Claude look up orders in our shop by order number, read-only, for the support team.');
  t('12 an MCP server that looks up shop orders is KNOWN agent, the shop words are reported as context, not counted', known(mcp, 'agent') && not(mcp, 'ecommerce') && mcp.deliverable.phrase === 'an mcp server' && (mcp.deliverable.context_terms.ecommerce || []).includes('order'), JSON.stringify(mcp));
  t('12 Dutch verb-final: "een MCP-server bouwen die bestellingen opzoekt" is agent (the built artifact wins the tie)', known(c('Ik wil een MCP-server bouwen die bestellingen opzoekt'), 'agent'));
  t('12 false friend: the deliverable is the webshop ("Build a webshop with an order page; later ... an MCP server") -> ecommerce', known(c('Build a webshop with an order page; later we may add an MCP server'), 'ecommerce'));
  t('12 false friend: no build verb ("Our MCP server needs a shop page with orders") -> no deliverable, ecommerce stays', (() => { const r = c('Our MCP server needs a shop page with orders'); return !r.deliverable && known(r, 'ecommerce'); })());
  const nr = c('Build an n8n workflow that takes leads from our contact form webhook, scores them, routes hot leads to the sales channel in Slack and puts the rest on a nurture list.');
  t('12 no conflict, no change: an n8n workflow that is already on top keeps its mixed API evidence', nr.verdict === 'MIXED' && nr.best === 'n8n' && Object.keys(nr.deliverable.context_terms).length === 0, JSON.stringify(nr.scores));
  const pb = c('Build a bot that watches prices on a a trading project-style prediction market, backtests a simple strategy and shows its forecasts with a confidence label.');
  t('12 a reviewed catalog keyword is never demoted: a prediction-market bot stays prediction (only weak words become context)', known(pb, 'prediction'), JSON.stringify(pb.scores));
  // (2) the verb migrate
  t('12 "Migrate our customer database from MySQL to Postgres ..." is KNOWN migration', known(c('Migrate our customer database from MySQL to Postgres without downtime and keep the old customer IDs working for the invoices.'), 'migration'));
  t('12 Dutch: "We migreren de klantendatabase naar Postgres" is KNOWN migration', known(c('We migreren de klantendatabase naar Postgres'), 'migration'));
  t('12 false friend: "A website that shows where birds migrate in autumn" stays website', known(c('A website that shows where birds migrate in autumn'), 'website'));
  // (3) train ... model, in that order
  t('12 "Train a model on our sales data" and "a churn model trained on check-ins" are KNOWN mlops', known(c('Train a model on our sales data'), 'mlops') && known(c('A churn model trained on two years of check-ins'), 'mlops'));
  t('12 false friend: "Our model train club needs a website" is not mlops (object before verb)', not(c('Our model train club needs a website'), 'mlops'));
  t('12 false friend: "A 3D model of a steam train for the museum shop" is not mlops', not(c('A 3D model of a steam train for the museum shop'), 'mlops'));
  t('12 false friend: "Train the staff to use the new booking model" is not mlops (too far apart)', not(c('Train the staff to use the new booking model'), 'mlops'));
  // the new catalog fields are validated
  const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-i10-'));
  try {
    fs.mkdirSync(path.join(RT, '.claude', 'config', 'orchestration'), { recursive: true });
    const writeCat = (website, rule) => fs.writeFileSync(path.join(RT, '.claude', 'config', 'orchestration', 'domain-catalog.json'), JSON.stringify(Object.assign({ version: 1, domains: { website } }, rule ? { deliverable_rule: rule } : {})));
    const probs = () => D.buildLexicon(RT).problems.filter((p) => !/unreadable/.test(p));
    writeCat({ playbook: 'forge-website', keywords: ['website'], deliverable_terms: ['webapp'] });
    t('12 a deliverable term that is not a keyword is refused', probs().some((p) => /deliverable term "webapp"/.test(p)), probs().join('; '));
    writeCat({ playbook: 'forge-website', keywords: ['website'], sequences: [{ label: 'x', first: ['build'], then: ['two words'], max_gap: 9 }] });
    t('12 a malformed sequence (a phrase as a word, max_gap 9) is refused', probs().some((p) => /sequences\[0\]/.test(p)), probs().join('; '));
    writeCat({ playbook: 'forge-website', keywords: ['website'] }, { verbs: 'build', max_words: 0 });
    t('12 a malformed deliverable_rule is refused', probs().some((p) => /deliverable_rule\.verbs/.test(p)) && probs().some((p) => /max_words/.test(p)), probs().join('; '));
  } finally { try { fs.rmSync(RT, { recursive: true, force: true }); } catch { /* best effort */ } }
  // a half-synced install without the helper: the classifier still works, with both I.10 signals off and said so
  const HS = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-half-'));
  try {
    for (const f of ['forge-domain-discovery.cjs', 'forge-text-normalize.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(HS, f));
    const H = require(path.join(HS, 'forge-domain-discovery.cjs'));
    const hl = H.buildLexicon(ROOT);
    const hr = H.classify('Build a webshop with a cart and checkout', { lexicon: hl });
    t('12 without forge-domain-deliverable.cjs: no crash, the webshop still classifies, and the lexicon names what is off', known(hr, 'ecommerce') && hl.problems.some((p) => /deliverable_rule is off/.test(p)) && hl.problems.some((p) => /sequences are off/.test(p)) && !H.classify('Train a model on our sales data', { lexicon: hl }).deliverable, hl.problems.join('; '));
  } finally { try { fs.rmSync(HS, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
