#!/usr/bin/env node
'use strict';
/**
 * forge-text-normalize.test.cjs — WP I.8a. Zero dependencies, no assert library.
 * Covers the stable API (normalize, stems, hasStem), the Dutch and English plural rules with their verb guards, the
 * compound rules (head/modifier only, 5+ letters or the 'site' allow-list, rest >= 3, the stop-list), a regression
 * table of Dutch phrases (plural and compound variants) and negative controls that must never match.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const TOOL = path.join(__dirname, 'forge-text-normalize.cjs');
const N = require(TOOL);

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// ---- 1) the stable API
console.log('1) API');
t('1 normalize, stems and hasStem are functions (the stable API other lanes require)', ['normalize', 'stems', 'hasStem'].every((k) => typeof N[k] === 'function'));
t('1 the secondary helpers are exported', ['tokenize', 'stem', 'candidates', 'englishForms', 'compoundEligible', 'compoundPosition', 'matcher'].every((k) => typeof N[k] === 'function'));
t('1 hasStem takes (text, stem) and an optional opts', N.hasStem.length >= 2);

// ---- 2) normalize
console.log('2) normalize');
t('2 lowercase, accents folded, curly quotes straight, one space', N.normalize('  Café  IDEEËN’s “X” ') === 'cafe ideeen\'s "x"');
t('2 idempotent', N.normalize(N.normalize('Één Ïdee — “test”')) === N.normalize('Één Ïdee — “test”'));
t('2 punctuation that carries meaning stays (".exe", "make.com", "e-commerce")', N.normalize('Setup.EXE via Make.com, E-Commerce') === 'setup.exe via make.com, e-commerce');
t('2 null and undefined give an empty string', N.normalize(null) === '' && N.normalize(undefined) === '');

// ---- 3) stems and candidates
console.log('3) plural rules');
const STEM = [
  ['wachtwoorden', 'wachtwoord'], ['sessies', 'sessie'], ['afspraken', 'afspraak'], ['facturen', 'factuur'], ['modellen', 'model'],
  ['inloggen', 'inlog'], ['formulieren', 'formulier'], ['dieren', 'dier'], ['kinderen', 'kind'], ['bezorgdiensten', 'bezorgdienst'],
  ["pagina's", 'pagina'], ['video’s', 'video'], ['categorieën', 'categorie'], ['ideeën', 'idee'], ['quizzen', 'quiz'],
  ['spellen', 'spel'], ['spelen', 'speel'], ['boten', 'boot'], ['talen', 'taal'], ['bestellingen', 'bestelling'],
  ['bots', 'bot'], ['modules', 'module'], ['classes', 'class'], ['boxes', 'box'], ['games', 'game'],
  ['installeren', 'install'], ['leveren', 'leveren'], ['status', 'status'], ['process', 'process'], ['ios', 'ios'],
];
for (const [w, s] of STEM) t('3 stem(' + w + ') = ' + s, N.stem(w) === s, N.stem(w));
t('3 the word itself always stays a candidate', ['wachtwoorden', 'spelen', 'installeren', 'boten'].every((w) => N.candidates(w)[0] === N.normalize(w).replace(/'s$/, '')));
t('3 English -ies gives the -y form as a candidate ("categories" -> category)', N.candidates('categories').includes('category'));
t('3 verb guard: "installeren" never yields "installer", "leveren" never "lever"', !N.candidates('installeren').includes('installer') && !N.candidates('leveren').includes('lever'));
t('3 open syllable: "spelen" (to play) yields "speel", never the noun "spel"; "spellen" (games) yields "spel"', N.candidates('spelen').includes('speel') && !N.candidates('spelen').includes('spel') && N.candidates('spellen').includes('spel'));
t('3 short results are refused: "boten" never yields "bot"', !N.candidates('boten').includes('bot'));
t('3 English inflection of a term: scrape -> scraping/scraper, but "bot" never -> "boter"', N.englishForms('scrape').has('scraping') && N.englishForms('scrape').has('scraper') && !N.englishForms('bot').has('boter') && N.englishForms('bot').has('bots'));

// ---- 4) stems(text)
console.log('4) stems(text)');
const st = N.stems('Bouw een e-learningsite met modules, video\'s, quizzen en modules');
t('4 stems() returns the canonical stems in order, unique', JSON.stringify(st) === JSON.stringify(['bouw', 'een', 'e', 'learningsite', 'met', 'module', 'video', 'quiz', 'en']), JSON.stringify(st));
t('4 stems() of empty text is []', Array.isArray(N.stems('')) && N.stems('').length === 0);

// ---- 5) compound rules
console.log('5) compound rules');
t('5 eligible: 5+ letters, or the documented 4-letter allow-list (site)', N.compoundEligible('winkel') && N.compoundEligible('inlog') && N.compoundEligible('site') && !N.compoundEligible('shop') && !N.compoundEligible('port') && !N.compoundEligible('spel'));
t('5 every allow-listed short stem is exactly 4 letters', [...N.SHORT_COMPOUND_ALLOW].every((s) => s.length === 4));
t('5 head: "webwinkel" ends in winkel; modifier: "inlogflow" starts with inlog', N.compoundPosition('webwinkel', 'winkel') === 'head' && N.compoundPosition('inlogflow', 'inlog') === 'modifier');
t('5 never in the middle: "transportbedrijf" never yields "sport", "sportschool" never "port"', N.compoundPosition('transportbedrijf', 'sport') === null && N.compoundPosition('sportschool', 'port') === null);
t('5 the rest must be 3+ letters: "afspraak" is not af+spraak', N.compoundPosition('afspraak', 'spraak') === null && N.compoundPosition('afspraken', 'spraak') === null);
t('5 the stop-list blocks lexicalised look-alikes (toespraak, opposite)', N.compoundPosition('toespraak', 'spraak') === null && N.compoundPosition('opposite', 'site') === null && [...N.COMPOUND_STOP].every((w) => w === N.normalize(w)));
t('5 a plain plural is not a compound', N.compoundPosition('winkels', 'winkel') === null);
t('5 opts.compound === false turns compound matching off', N.hasStem('een webwinkel', 'winkel') && !N.hasStem('een webwinkel', 'winkel', { compound: false }));

// ---- 6) regression table: Dutch phrases, with and without plural/compound variants -> stem hit
console.log('6) Dutch regression table');
const NL = [
  ['Pas de inlogflow aan', 'inloggen', 'modifier compound'],
  ['Na het inloggen zie je je dashboard', 'inloggen', 'plain'],
  ['wachtwoorden opnieuw hashen met argon2', 'wachtwoord', 'plural -en'],
  ['het wachtwoord resetten', 'wachtwoord', 'singular'],
  ['sessies verlopen na 30 minuten', 'sessie', 'plural -s'],
  ['de sessie verloopt', 'sessie', 'singular'],
  ['een spraakassistent voor de kapsalon', 'spraak', 'modifier compound'],
  ['Bouw een e-learningsite', 'site', 'head compound, allow-listed site'],
  ['een fotosite voor mijn portfolio', 'site', 'head compound'],
  ['een afspraakformulier op de site', 'formulier', 'head compound'],
  ['twee formulieren', 'formulier', 'plural -en after -ier'],
  ['een webwinkel voor kaarsen', 'winkel', 'head compound'],
  ['bezorgdiensten vergelijken', 'dienst', 'plural + head compound'],
  ['alle facturen van dit kwartaal', 'factuur', 'plural -en, open syllable'],
  ['de factuur versturen', 'factuur', 'singular'],
  ["pagina's met producten", 'pagina', "plural -'s"],
  ['een RSVP-pagina', 'pagina', 'hyphen splits'],
  ["video's toevoegen", 'video', "plural -'s"],
  ['afspraken inplannen', 'afspraak', 'plural, open syllable'],
  ['bestellingen verwerken', 'bestelling', 'plural -en'],
  ['een taartbestelling', 'bestelling', 'head compound'],
  ['betalingen via iDEAL', 'betaling', 'plural -en'],
  ['een abonnementsbetaling', 'betaling', 'head compound with linking s'],
  ['een klantenportaal', 'portaal', 'head compound with linking en'],
  ['modellen trainen', 'model', 'plural, double consonant'],
  ['spellen voor kinderen', 'spel', 'plural, double consonant'],
  ['oefeningen voor kinderen', 'kind', 'plural -eren'],
  ['vragen beantwoorden', 'vraag', 'plural, open syllable'],
  ['voetbalwedstrijden voorspellen', 'wedstrijd', 'plural + head compound'],
  ['gebruikers beheren', 'gebruiker', 'plural -s'],
  ['verbeter de beveiliging', 'beveilig*', 'catalog stem prefix'],
  ['categorieën in het menu', 'categorie', 'accent fold + plural'],
  ['een datawarehouse', 'warehouse', 'head compound'],
  ['systeemintegratie met het CRM', 'integratie', 'head compound'],
  ['koppelingen met de boekhouding', 'koppeling', 'plural -en'],
  ['een loginpagina', 'login', 'modifier compound'],
  ['de inlogpagina', 'pagina', 'head compound'],
  ['korte quizzen', 'quiz', 'plural, double consonant'],
  ['twee landingspaginas', 'landingspagina', 'plural -s without apostrophe'],
  ['dieetwensen van de gasten', 'gast', 'plural -en'],
  ['de leden van de kerk', 'kerk', 'singular'],
  ['de mobiele weergave', 'mobiel*', 'stem prefix'],
  ['spraakgestuurde bediening', 'spraak', 'modifier compound'],
  ['winkelwagens en afrekenen', 'winkelwagen', 'plural -s'],
];
t('6 the table holds at least 40 Dutch phrases', NL.length >= 40, String(NL.length));
for (const [text, s, why] of NL) t('6 "' + text + '" has stem ' + s + ' (' + why + ')', N.hasStem(text, s), JSON.stringify(N.stems(text)));
const EN = [['two landing pages', 'landing page'], ['product categories', 'category'], ['the search boxes', 'box'], ['role-based access control', 'role-based access'], ['knowledge bases', 'knowledge base']];
for (const [text, s] of EN) t('6 EN "' + text + '" has stem ' + s, N.hasStem(text, s));

// ---- 7) negative controls: look-alikes that must NOT match
console.log('7) negative controls');
const NEG = [
  ['our support team', 'port', 'port is 4 letters: no compound, and never in the middle'],
  ['a client portal', 'port', 'portal is not port'],
  ['the airport shuttle', 'port', 'head of airport, but port is too short for compounds'],
  ['een sportschool', 'port', 'middle of a word'],
  ['afspraken inplannen', 'spraak', 'af+spraak: rest under 3 letters'],
  ['een toespraak houden', 'spraak', 'stop-list'],
  ['de uitspraak van de rechter', 'spraak', 'stop-list'],
  ['the opposite corner', 'site', 'stop-list'],
  ['a composite image', 'site', 'stop-list'],
  ['installeren op de server', 'installer', 'Dutch verb guard'],
  ['de boten in de haven', 'bot', 'boten -> boot'],
  ['brood met boter', 'bot', 'no -er inflection on a 3-letter term'],
  ['kinderen kunnen spelen', 'spel', 'spelen -> speel'],
  ['a workshop on design', 'shop', 'shop is 4 letters: no compound'],
  ['Photoshop files', 'shop', 'shop is 4 letters: no compound'],
  ['de agenda van de kerk', 'agent*', 'prefix needs the whole stem'],
  ['een spelling check', 'spel', 'spel is 4 letters'],
  ['de goederen leveren', 'lever', 'verb guard'],
  ['the support portal', 'port', 'neither word is port'],
  ['de botten van een dinosaurus', 'bot', 'an -en result under 4 letters is refused (bones are not bots)'],
  ['we appen even met de klant', 'app', 'an -en result under 4 letters is refused (to text is not an app)'],
  ['een webwinkel', 'winkel', 'only with compound off', { compound: false }],
];
for (const [text, s, why, opts] of NEG) t('7 "' + text + '" does NOT have stem ' + s + ' (' + why + ')', !N.hasStem(text, s, opts), JSON.stringify(N.stems(text)));

// ---- 7b) (2.9c follow-up) false friends of the plural/inflection rules: documented stop-lists, each entry proven
console.log('7b) false friends: INFLECTION_STOP and PLURAL_ONLY');
const FALSE_FRIENDS = [
  ['a 2D platformer in Godot', 'platform', 'INFLECTION_STOP: a platformer is a game genre, not a platform'],
  ['two platformers and a racer', 'platform', 'INFLECTION_STOP plural'],
  ['tight platforming controls', 'platform', 'INFLECTION_STOP: platforming is gameplay'],
  ['the company merger', 'merge', 'INFLECTION_STOP: a company merger is not a git merge'],
  ['het recht op inzage', 'rechten', 'PLURAL_ONLY: recht (a right, law) is not rechten (access rights)'],
  ['recht toe recht aan', 'rechten', 'PLURAL_ONLY: straight'],
  ['naar de rechtbank', 'rechten', 'PLURAL_ONLY: no compound of the singular (rechtbank = court)'],
  ['an open source library', 'sources', 'PLURAL_ONLY: open source is not cited sources'],
  ['read the source code', 'sources', 'PLURAL_ONLY: source code'],
  ['in the fast lane', 'lanes', 'PLURAL_ONLY: a road lane is not Forge lanes'],
  ['a bowling lane booking app', 'lanes', 'PLURAL_ONLY: a bowling lane'],
];
for (const [text, s, why] of FALSE_FRIENDS) t('7b "' + text + '" does NOT have stem ' + s + ' (' + why + ')', !N.hasStem(text, s), JSON.stringify(N.stems(text)));
const STILL = [
  ['three platforms', 'platform', 'a real plural still matches'],
  ['cross-platform builds', 'platform', 'the word itself'],
  ['merging two branches', 'merge', '-ing still matches'],
  ['merge the branches', 'merge', 'the word itself'],
  ['beheer de rechten', 'rechten', 'the plural itself'],
  ['toegangsrechten per rol', 'rechten', 'a compound that ends in the plural'],
  ['rechtenbeheer voor admins', 'rechten', 'a compound that starts with the plural'],
  ['answers with sources', 'sources', 'the plural itself'],
  ['run it in parallel lanes', 'lanes', 'the plural itself'],
  ['a scraper for prices', 'scrape', '-er stays for words not on the stop-list'],
];
for (const [text, s, why] of STILL) t('7b "' + text + '" still has stem ' + s + ' (' + why + ')', N.hasStem(text, s), JSON.stringify(N.stems(text)));
t('7b PLURAL_ONLY terms are their own stem; englishForms never gives their singular or a stop-listed form',
  [...N.PLURAL_ONLY].every((w) => N.stem(w) === w && !N.englishForms(w).has(w.replace(/(en|s)$/, ''))) && !N.englishForms('platform').has('platformer') && !N.englishForms('merge').has('merger') && N.englishForms('scrape').has('scraper'));
t('7b every stop-list entry is normalized and documented as a Set', N.INFLECTION_STOP instanceof Set && N.PLURAL_ONLY instanceof Set && [...N.INFLECTION_STOP, ...N.PLURAL_ONLY].every((w) => w === N.normalize(w) && /^[a-z]+$/.test(w)));

// ---- 8) CLI and hygiene
console.log('8) CLI + hygiene');
const cli = (args) => cp.spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
const c1 = cli(['stems', 'wachtwoorden en sessies']);
t('8 CLI stems prints JSON', c1.status === 0 && JSON.parse(c1.stdout).join(',') === 'wachtwoord,en,sessie');
t('8 CLI has: exit 0 yes, exit 1 no, exit 2 usage', cli(['has', 'de inlogflow', 'inloggen']).status === 0 && cli(['has', 'our support team', 'port']).status === 1 && cli([]).status === 2);
const src = fs.readFileSync(TOOL, 'utf8');
t('8 zero dependencies: no require other than none (pure functions)', !/require\(/.test(src.replace(/require\.main/g, '')));
t('8 deterministic: the same text gives the same stems', JSON.stringify(N.stems('Wachtwoorden, sessies en inlogflows')) === JSON.stringify(N.stems('Wachtwoorden, sessies en inlogflows')));
const big = 'webwinkel '.repeat(20000);
const tb = Date.now();
t('8 a 200 kB text is tokenized fast (' + (Date.now() - tb) + ' ms)', N.hasStem(big, 'winkel') && Date.now() - tb < 5000);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
