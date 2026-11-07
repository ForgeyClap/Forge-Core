#!/usr/bin/env node
'use strict';
/**
 * forge-scribe-classify.test.cjs — WP I.8c: the toggle-correction TAG of forge-scribe-classify.cjs
 * (toggleCorrection). Pure-function tests, hermetic (the only file system use is a temp copy of the classifier for the
 * mutation checks, removed at the end). The capture / digest / list / retag / hook side lives in forge-scribe.test.cjs
 * section 49 and forge-scribe-hook.test.cjs section TC.
 *   1  positive corpus: >= 30 NL + EN corrections, among them FRESH paraphrases (not copies) of the owner's 12 real switch
 *      requests in docs/audit/intelligence-evidence.md section 1 (#10, a model/effort preference, is a negative: the
 *      evidence itself calls it a preference, not a correction);
 *   2  negative corpus: >= 40 ordinary task requests (also ones that contain "aan"/"on" or a Forge word), questions,
 *      acks, product-actor sentences, pasted boilerplate and quoted corrections inside a pasted block;
 *   3  shape, the classes stay pinned, short-message context, kill switch, bounded time;
 *   4  mutation checks: each guard switched off in a temp copy makes a named negative FAIL.
 * Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./forge-scribe-classify.cjs');

const cfg = C.loadConfig();
let pass = 0, fail = 0;
const t = (name, cond, info) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (info ? ' :: ' + String(info).slice(0, 700) : '')); } };
const tag = (txt, c) => C.toggleCorrection(txt, c || cfg);

console.log('forge-scribe-classify: toggle-correction tag (WP I.8c)');

// ---------------------------------------------------------------- 1. positives
// [text, expected cue family or null] — the cue is asserted for a few, the tag for all
const POSITIVE = [
  // fresh paraphrases of the 12 real switch requests (evidence section 1), NL
  ['Zet meer lanes open, ze botsen toch niet met elkaar.', 'toggle-on'],                                   // #1 parallel lanes
  ['Waarom draai je dit nog met één agent? Zet parallelle lanes aan.', null],                               // #1
  ['Vraag niet steeds of je door mag gaan, gewoon doorwerken tot het af is.', 'stop-asking'],               // #2 stop asking
  ['Je hoeft niet telkens te vragen of je verder mag.', 'stop-asking'],                                     // #2
  ['Ik moet steeds alles zelf aanzetten, zet de veilige dingen standaard aan.', 'burden'],                  // #3 defaults on
  ['Je bent de Codex review weer vergeten bij deze auth-wijziging.', null],                                 // #4 codex
  ['Er draaide alweer geen watchdog terwijl er drie lanes liepen.', null],                                  // #5 watchdog
  ['Vergeet niet de nieuwe versie ook echt te releasen.', 'forgot'],                                        // #6 release
  ['Je had hier zelf deep research moeten starten.', 'should-have'],                                        // #7 deep research
  ['Ik moet steeds vragen hoe ver je bent, geef zelf een statusupdate.', 'burden'],                         // #8 status
  ['Waarom heb je de rotator niet gebruikt toen de limiet bereikt was?', 'why-not'],                        // #9 rotator
  ['Heb je ook /watch gebruikt voor die TikTok-filmpjes?', 'did-you-also'],                                 // #11 /watch
  ['Ik moet telkens zeggen zet dit aan, zet dat aan; denk zelf eens mee.', 'burden'],                      // #12 meta
  ['Forge denkt niet met me mee, dat kost elke keer extra tokens.', 'meta'],                                // #12
  // more NL
  ['Dit moet je zelf doen, zonder dat ik erom hoef te vragen.', 'meta'],
  ['Hoe vaak moet ik nog zeggen dat je de tests moet draaien?', 'burden'],
  ['De lanes stoppen alweer na één ronde, dit mag niet meer gebeuren.', null],
  ['Waarom staan de checks niet aan?', 'why-not'],
  ['Je hebt de typecheck niet gedraaid, dat had je zelf moeten doen.', null],
  ['Kan je niet gewoon meer agents tegelijk laten werken?', 'cant-you'],
  ['Gebruik ook de forge-debug skill voor zo een crash.', 'use'],
  ['Dat heb ik al vaker gezegd: de watchdog hoort bij elke run.', 'already-said'],
  // EN
  ['You forgot the watchdog again with four lanes running.', null],
  ["Why didn't you run the Codex review on this auth change?", 'why-not'],
  ['Stop asking me whether to continue, just keep going.', 'stop-asking'],
  ['I have to keep asking for a progress update; give one without being asked.', 'burden'],
  ['You should have started parallel agents for this refactor.', 'should-have'],
  ["Why aren't you using parallel lanes? I shouldn't have to ask.", null],
  ['Turn on the lane watchdog, you keep forgetting it.', null],
  ['Enable the Codex review by default, I have to remind you every time.', 'burden'],
  ["You didn't use /watch on the YouTube links I sent.", 'omission'],
  ['How many times do I have to tell you to run the tests?', 'burden'],
  ['Again you ran everything in one lane and did not use the subagents.', null],
  ['You are not thinking ahead: the usage guard should have been on.', 'meta'],
  ['I already told you: use the deep research workflow for this.', 'already-said'],
];
{
  const miss = POSITIVE.filter(([x]) => !tag(x).tagged);
  t('1a: the positive corpus has >= 30 NL + EN corrections (' + POSITIVE.length + ')', POSITIVE.length >= 30);
  t('1b: every positive is tagged toggle-correction', miss.length === 0, miss.map((x) => x[0]).join(' | '));
  const cueMiss = POSITIVE.filter(([x, cue]) => cue && tag(x).cue !== cue).map(([x, cue]) => JSON.stringify(x) + ' want ' + cue + ' got ' + tag(x).cue);
  t('1c: the named cue family fires where the corpus names one', cueMiss.length === 0, cueMiss.join(' | '));
  const nl = POSITIVE.slice(0, 22).length, en = POSITIVE.length - 22;
  t('1d: both languages are covered (NL ' + nl + ', EN ' + en + ')', nl >= 12 && en >= 12);
}

// ---------------------------------------------------------------- 2. negatives
const NEGATIVE = [
  // ordinary task requests, some with "aan"/"on" or a Forge word but no corrective cue
  'Zet de lamp aan in de app.',
  'Turn on dark mode in the settings page.',
  'Enable reviews on the product page.',
  'Zet de donkere modus standaard aan voor nieuwe gebruikers.',
  'Voeg een watchdog toe aan de deploy-pipeline.',
  'Draai de tests en de lint voordat je commit.',
  'Start drie parallelle agents voor de migratie.',
  'Gebruik Inter in plaats van Roboto voor de body.',
  'Use Postgres instead of SQLite.',
  'You must use the existing auth module.',
  'Voeg een contactformulier toe aan de homepage.',
  'Zet de linter uit voor de demo-branch.',
  'Turn off the watchdog for this run.',
  'Enable the linter in the CI pipeline.',
  'Zet de voice agent aan in de app.',
  'Zet de knop rechtsboven in beeld.',
  'Gebruik voor de planning Fable 5.1 op effort high.',                                       // real #10: a preference
  'Voeg ook toe dat elke run met meer dan één lane een watchdog krijgt.',                   // a new requirement, no cue
  'Ik wil ook dat je de account rotator in het plan zet, want ik doe het nu nog steeds met de hand.',
  'ruim alle onnodige bestanden op, ik heb geen schijfruimte meer!',
  'Always run the tests before you report done.',
  'Never use default Tailwind colors.',
  'Ik moet morgen vroeg op, plan de taken voor vandaag.',
  'Ik zeg altijd: eerst een plan, dan bouwen.',
  'I keep the lanes small; just keep going with the ones you have.',
  // cancels that contain "vergeet" / "forget"
  'Vergeet die PDF-export.',
  'Vergeet de tests maar, die doen we later.',
  'Forget about the watchdog for now.',
  // a product actor asks or is asked (not the owner, not Forge)
  'De voice agent moet niet steeds opnieuw naar de naam vragen.',
  'De bot vraagt steeds om de postcode, haal die vraag weg.',
  'Ik moet klanten steeds herinneren aan hun afspraak; automatiseer dat.',
  'the voice agent keeps asking callers for their zip code, remove that question',
  'Stop asking for the zip code in the checkout form.',
  // "again" / "opnieuw" / "alweer" without an omission
  'Run the tests again.',
  'Draai de tests opnieuw.',
  'De tests falen alweer, kijk ernaar.',
  // questions (also with a Forge word) and acks
  'Why did the deploy fail?',
  "Why didn't the deploy work?",
  'Waarom is de build zo traag?',
  'Kun je uitleggen hoe de watchdog werkt?',
  'Kan je niet even uitleggen hoe de lanes werken?',
  'wat moeten er nog gedaan worden?',
  'klaar??',
  'meer lanes?',
  'Is de watchdog al aan?',
  'open vragen nog voor mij of wat ik moet doen?',
  'Waarom niet? Parallel lanes lijken me prima.',
  'R-0006, R-0007 en R-0012 kloppen.',
  'LGTM, the watchdog works again.',
  'Thanks, dat klopt.',
  // pasted boilerplate and quoted corrections inside a pasted block (someone else's words)
  '```\nUser: you forgot the watchdog again\nAssistant: sorry, I will enable it\n```\nVat dit gesprek samen.',
  'Kijk naar deze log:\n> ik moet steeds vragen om extra lanes\n> zet de watchdog aan\nWat is hier de fout?',
  'De klant schreef: "waarom heb je de tests niet gedraaid?" Beantwoord die mail vriendelijk.',
  "Zet 'gebruik ook parallel agents' als voorbeeldzin in de docs.",
];
{
  const hits = NEGATIVE.filter((x) => tag(x).tagged).map((x) => JSON.stringify(x) + ' -> ' + tag(x).cue + ':' + tag(x).switch_word);
  t('2a: the negative corpus has >= 40 entries (' + NEGATIVE.length + ')', NEGATIVE.length >= 40);
  t('2b: no negative is tagged', hits.length === 0, hits.join(' | '));
}

// ---------------------------------------------------------------- 3. shape, pinned classes, context rule, kill switch, bounds
{
  const r = tag('Ik moet steeds vragen om extra parallel agents.');
  t('3a: a hit carries {tagged, tag, cue, strong, switch_word, sentence}', r.tagged === true && r.tag === 'toggle-correction' && r.cue === 'burden' && r.strong === true && r.switch_word === 'parallel' && typeof r.sentence === 'string' && r.sentence.length <= 80, JSON.stringify(r));
  const w = tag('Zet extra lanes open.');
  t('3b: a weak cue reports its switch word and strong:false', w.tagged && w.cue === 'toggle-on' && w.strong === false && w.switch_word === 'lanes', JSON.stringify(w));
  const n = tag('Voeg een footer toe.');
  t('3c: a miss is the all-null verdict', n.tagged === false && n.tag === null && n.cue === null && n.switch_word === null);
  t('3d: the classes stay pinned: toggle-correction is a TAG, never a class, and classify() is unchanged', !C.CLASSES.includes('toggle-correction') && C.CLASSES.join(',') === 'new,change,cancel,preference,question,ack,unclassified'
    && C.TOGGLE_TAG === 'toggle-correction' && !('tags' in C.classify('Ik moet steeds vragen om extra lanes', cfg)));
  t('3e: non-string input never throws and is never tagged', [null, undefined, 42, {}, [], ''].every((x) => tag(x).tagged === false));
  t('3f: a short message is ONE context (cue and switch word in different sentences)', tag('Je bent het alweer vergeten. De watchdog.').tagged === true);
  const pad = ' Dit is verder een lange uitleg over de homepage en het menu en de kleuren van de footer.'.repeat(4);
  t('3g: ... a long message is judged per sentence (the cue sentence names no switch word)', tag('Je bent het alweer vergeten.' + pad + ' De watchdog.').tagged === false);
  const off = JSON.parse(JSON.stringify(cfg)); off.toggle_correction = { enabled: false };
  t('3h: kill switch: toggle_correction.enabled=false in FORGE_SCRIBE.json tags nothing', tag(POSITIVE[0][0], off).tagged === false && tag(POSITIVE[0][0]).tagged === true);
  const big = 'Verander de tekst van de homepage naar iets beters en maak de knoppen groter. '.repeat(30000);
  const t0 = Date.now(); const rb = tag(big); const ms = Date.now() - t0;
  t('3i: a 2 MB prompt is judged in bounded time (max_chars cut; ' + ms + ' ms)', rb.tagged === false && ms < 1500);
  t('3j: a /command is a switch word, a path inside a word is not', tag('Je bent /watch vergeten.').switch_word === '/watch' && tag('Je bent TikTok/YouTube vergeten.').tagged === false);
  t('3k: an ambiguous switch word counts without a product word, not with one', tag('Je bent de tests vergeten.').tagged === true && tag('Je bent de tests vergeten op de checkout-pagina.').tagged === false
    && tag('Je bent de watchdog vergeten op de checkout-pagina.').tagged === true);
}

// ---------------------------------------------------------------- 4. mutation checks
const TMP = [];
/** mutant(find, repl) -> the classifier module with one source edit applied ({applied:false} when the anchor is gone). */
function mutant(find, repl) {
  const src = fs.readFileSync(path.join(__dirname, 'forge-scribe-classify.cjs'), 'utf8');
  if (!src.includes(find)) return { applied: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-tc-mut-'));
  TMP.push(dir);
  const f = path.join(dir, 'forge-scribe-classify.cjs');
  fs.writeFileSync(f, src.split(find).join(repl));
  return { applied: true, M: require(f) };
}
{
  const cases = [
    ['M1 TC-NEED-CUE (the omission/corrective-cue requirement)', 'const TC_CUE_REQUIRED = true;', 'const TC_CUE_REQUIRED = false;', 'Voeg een watchdog toe aan de deploy-pipeline.'],
    ['M2 TC-OFF-NEEDS-OMISSION ("zet ... uit" alone)', 'const TC_OFF_ALONE = false;', 'const TC_OFF_ALONE = true;', 'Zet de linter uit voor de demo-branch.'],
    ['M3 TC-GUARD-PRODUCT', 'if (amb && TC_PRODUCT_RE.test(ctx)) return null; // TC-GUARD-PRODUCT', '// guard removed', 'Enable reviews on the product page.'],
    ['M4 TC-NEED-SWITCH', 'if (!sw) continue; // TC-NEED-SWITCH', '// guard removed', "Why didn't the deploy work?"],
    ['M5 TC-GUARD-ACTOR', 'if (TC_ACTOR_RE.test(s)) return false; // TC-GUARD-ACTOR', '// guard removed', 'Ik moet klanten steeds herinneren aan hun afspraak; automatiseer dat.'],
  ];
  for (const [name, find, repl, neg] of cases) {
    const m = mutant(find, repl);
    t(name + ': the anchor exists and, switched off, the negative ' + JSON.stringify(neg) + ' is tagged — so test 2b fails on such code',
      m.applied && NEGATIVE.includes(neg) && m.M.toggleCorrection(neg, cfg).tagged === true && tag(neg).tagged === false, JSON.stringify({ applied: m.applied }));
  }
  const src = fs.readFileSync(path.join(__dirname, 'forge-scribe-classify.cjs'), 'utf8');
  t('M0: each mutation anchor sits on exactly ONE line', ['TC-NEED-CUE', 'TC-OFF-NEEDS-OMISSION', 'TC-GUARD-PRODUCT', 'TC-NEED-SWITCH', 'TC-GUARD-ACTOR'].every((a) => src.split(a).length === 2));
}

// ---------------------------------------------------------------- 5. id ranges in owner acks (WP-ACK-RANGE)
// Live defect: the owner's prompt P-000122 "R-0103 t/m R-0121 klopt" approved only the two endpoints; `transition R-0104
// ack --prompt P-000122` was refused with "no sentence names R-0104 or a batch ack phrase". An inclusive range now
// authorises every id inside it, with the fail-closed rules of a shared list act (authorizes(), pure).
console.log('\nforge-scribe-classify: id ranges in owner acks (WP-ACK-RANGE)');
{
  const rid = (n) => 'R-' + String(n).padStart(4, '0');
  const span = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(rid(i)); return o; };
  const auth = (txt, id, intent, c) => C.authorizes(txt, id, intent || 'ack', c || cfg);
  const okIds = (txt, ids, intent, c) => ids.filter((id) => auth(txt, id, intent, c).ok);
  const allOf = (txt, ids, intent, c) => okIds(txt, ids, intent, c).length === ids.length;
  const noneOf = (txt, ids, intent, c) => okIds(txt, ids, intent, c).length === 0;
  const IN = span(103, 121);
  const OUT = ['R-0001', 'R-0100', 'R-0102', 'R-0122', 'R-0200'];

  // 5a. the owner's exact prompt and the accepted forms
  const OWNER = 'R-0103 t/m R-0121 klopt';
  t('R1: the owner\'s exact prompt P-000122 authorises every id from R-0103 through R-0121 (19 ids)', allOf(OWNER, IN), JSON.stringify(IN.filter((id) => !auth(OWNER, id).ok)));
  t('R1b: an inner id is reported as a range act, an endpoint as before', auth(OWNER, 'R-0104').how === 'range' && auth(OWNER, 'R-0103').ok === true && auth(OWNER, 'R-0103').how !== 'range',
    JSON.stringify([auth(OWNER, 'R-0104'), auth(OWNER, 'R-0103')]));
  t('R1c: ids outside the range stay unauthorised', noneOf(OWNER, OUT), JSON.stringify(okIds(OWNER, OUT)));
  t('R1d: an ack range never serves a cancel', noneOf(OWNER, ['R-0103', 'R-0110', 'R-0121'], 'cancel'));
  const FORMS = ['R-0103 tot en met R-0121 klopt.', 'R-0103 tm R-0121 klopt.', 'R-0103 t/m R-0121 kloppen.', 'R-0103 t / m R-0121 akkoord.',
    'R-0103 through R-0121 approved.', 'R-0103 to R-0121 confirmed.', 'Approve R-0103 to R-0121.', 'R-0103 - R-0121 klopt.', 'R-0103-R-0121 klopt.',
    'R-0103–R-0121 klopt.', 'R-0103 – R-0121 klopt.', 'R-103 t/m R-121 klopt.', 'r-0103 T/M r-0121 KLOPT', 'R-0103 TOT EN MET R-0121 klopt'];
  const badForms = FORMS.filter((x) => !allOf(x, ['R-0103', 'R-0104', 'R-0110', 'R-0120', 'R-0121']) || !noneOf(x, OUT));
  t('R2: every range form (t/m, tm, tot en met, through, to, a hyphen or en dash between two ids, any case, leading zeros optional) authorises the ids inside and none outside',
    badForms.length === 0, badForms.join(' | '));
  t('R2b: a cancel range authorises the cancel of each id inside it, never an ack', allOf('Annuleer R-0103 t/m R-0105.', span(103, 105), 'cancel')
    && allOf('Cancel R-0103 to R-0105.', span(103, 105), 'cancel') && noneOf('Annuleer R-0103 t/m R-0105.', span(103, 105), 'ack'));
  t('R2c: a range and a named id in one shared act ("R-0103 t/m R-0105 en R-0110 kloppen.")',
    allOf('R-0103 t/m R-0105 en R-0110 kloppen.', ['R-0103', 'R-0104', 'R-0105', 'R-0110']) && noneOf('R-0103 t/m R-0105 en R-0110 kloppen.', ['R-0106', 'R-0107', 'R-0109', 'R-0111']));
  t('R2d: two ranges in one sentence, and one per sentence', allOf('R-0001 t/m R-0003 en R-0010 t/m R-0012 kloppen.', span(1, 3).concat(span(10, 12)))
    && noneOf('R-0001 t/m R-0003 en R-0010 t/m R-0012 kloppen.', span(4, 9).concat(['R-0013']))
    && allOf('R-0001 t/m R-0003 klopt. R-0010 t/m R-0012 klopt.', span(1, 3).concat(span(10, 12))));

  // 5b. fail closed: exceptions, negations, questions, conditions
  const NEG = [
    'R-0103 t/m R-0121 klopt behalve R-0110', 'R-0103 t/m R-0121 klopt niet', 'R-0103 t/m R-0121 klopt, maar R-0125 nog niet',
    'R-0103 t/m R-0121 klopt – R-0110 niet', 'R-0103 t/m R-0121 klopt - R-0110 niet', 'R-0103 t/m R-0121 klopt (R-0110 niet)', 'R-0103 t/m R-0121 kloppen, R-0110 niet',
    'R-0103 t/m R-0121 klopt?', 'Zijn R-0103 t/m R-0121 akkoord', 'R-0103 t/m R-0121 klopt als de tests slagen', 'R-0103 t/m R-0121 nog niet',
    'Approve R-0103 through R-0121 except R-0110.', 'Approve R-0103 to R-0121, not yet.', 'R-0103 t/m R-0121 approved?', 'Don\'t approve R-0103 t/m R-0121.',
  ];
  const leaks = NEG.map((x) => [x, okIds(x, IN)]).filter(([, ok]) => ok.length).map(([x, ok]) => JSON.stringify(x) + ' -> ' + ok.join(','));
  t('R3: an exception, a negation, a question or a condition anywhere in the sentence refuses EVERY id of the range, endpoints included', leaks.length === 0, leaks.join(' | '));
  t('R3b: the refusal of an inner id names the range', /R-0103 t\/m R-0121/.test(auth('R-0103 t/m R-0121 klopt behalve R-0110', 'R-0104').reason || ''), auth('R-0103 t/m R-0121 klopt behalve R-0110', 'R-0104').reason);

  // 5c. malformed ranges refuse every id they touch, and every other id named in that sentence
  t('R4: a reversed range ("R-0121 t/m R-0103") refuses all, endpoints included', noneOf('R-0121 t/m R-0103 klopt', IN) && /backwards/.test(auth('R-0121 t/m R-0103 klopt', 'R-0110').reason || ''),
    JSON.stringify([okIds('R-0121 t/m R-0103 klopt', IN), auth('R-0121 t/m R-0103 klopt', 'R-0110').reason]));
  t('R4b: a range from an id to itself ("R-0103 t/m R-0103") refuses', noneOf('R-0103 t/m R-0103 klopt', ['R-0103']));
  t('R4c: a chained range ("R-0001 t/m R-0003 t/m R-0005") refuses all', noneOf('R-0001 t/m R-0003 t/m R-0005 klopt', span(1, 5)), JSON.stringify(okIds('R-0001 t/m R-0003 t/m R-0005 klopt', span(1, 5))));
  t('R4d: a malformed range poisons every other id named in the same sentence', noneOf('R-0121 t/m R-0103 klopt, R-0200 klopt', ['R-0200']));
  t('R5: the cap: 60 ids are accepted, 61 are refused (endpoints included)', allOf('R-0001 t/m R-0060 klopt', span(1, 60))
    && noneOf('R-0001 t/m R-0061 klopt', ['R-0001', 'R-0030', 'R-0061']) && /range_max/.test(auth('R-0001 t/m R-0061 klopt', 'R-0030').reason || ''),
    JSON.stringify(auth('R-0001 t/m R-0061 klopt', 'R-0030')));
  t('R5b: FORGE_SCRIBE.json pins owner_check.range_max = 60', cfg.owner_check.range_max === 60);
  const capped = (v) => { const c = JSON.parse(JSON.stringify(cfg)); c.owner_check.range_max = v; return c; };
  t('R5c: owner_check.range_max is read from the config (5: R-0001 t/m R-0005 yes, R-0001 t/m R-0006 no)',
    allOf('R-0001 t/m R-0005 klopt', span(1, 5), 'ack', capped(5)) && noneOf('R-0001 t/m R-0006 klopt', span(1, 6), 'ack', capped(5)));
  t('R5d: range_max 0 turns ranges off (every range refuses); a non-integer value falls back to the default 60',
    noneOf('R-0001 t/m R-0002 klopt', ['R-0001', 'R-0002'], 'ack', capped(0)) && allOf('R-0001 t/m R-0060 klopt', ['R-0030'], 'ack', capped('veel'))
    && noneOf('R-0001 t/m R-0061 klopt', ['R-0030'], 'ack', capped(-3)));

  // 5d. what is NOT a range
  t('R6: "tot" alone, an em dash, "en" and "of" are not range connectors (the id in between stays unauthorised)',
    ['R-0103 tot R-0121 klopt', 'R-0103 — R-0121 klopt', 'R-0103 en R-0121 kloppen', 'R-0103 of R-0121 klopt', 'R-0103, R-0121 kloppen'].every((x) => auth(x, 'R-0110').ok === false));
  t('R6b: a connector with words between it and the ids is no range ("R-0103 klopt t/m R-0121")', auth('R-0103 klopt t/m R-0121', 'R-0110').ok === false);

  // 5e. the dash decision: a hyphen / en dash DIRECTLY between two ids is a range connector; anywhere else it still cuts
  // clauses as a contrast, exactly as before
  t('D1: a dash directly between two ids is a range', allOf('R-0103 - R-0105 klopt', span(103, 105)) && allOf('R-0103–R-0105 klopt', span(103, 105)));
  t('D2: a dash after an act still cuts clauses as a contrast (unchanged): "R-0103 klopt - R-0104 niet" approves R-0103 only',
    auth('R-0103 klopt - R-0104 niet', 'R-0103').ok === true && auth('R-0103 klopt - R-0104 niet', 'R-0104').ok === false
    && auth('R-0103 klopt – R-0105 niet', 'R-0104').ok === false);
  t('D3: a negation after a dash range belongs to the whole range: "Akkoord R-0103 - R-0105 niet" approves none', noneOf('Akkoord R-0103 - R-0105 niet', span(103, 105)));
  t('D4: a reversed dash range ("R-0105 – R-0103 klopt") approves none', noneOf('R-0105 – R-0103 klopt', span(103, 105)));
  t('D5: a dash range is never a batch exception cut: "Alles akkoord - behalve R-0110" still refuses R-0110 (unchanged)', auth('Alles akkoord - behalve R-0110', 'R-0110').ok === false);

  // 5f. the owner's real ack prompts (scribe inbox P-000017 .. P-000122, verbatim, no secrets): the authorised ids per
  // prompt are exactly what the code before WP-ACK-RANGE gave, except P-000122 (the range). Every id from one below the
  // lowest to one above the highest named id, both intents.
  const REAL = [
    ['P-000017', 'R-0001 klopt, R-0002 klopt, R-0004 klopt.', ['R-0001', 'R-0002', 'R-0004'], []],
    ['P-000019', 'R-0006, R-0007, R-0008, R-0009, R-0010, R-0014, R-0016 en R-0012 kloppen.\nlopen deze ook vast?', ['R-0006', 'R-0007', 'R-0008', 'R-0009', 'R-0010', 'R-0012', 'R-0014', 'R-0016'], []],
    ['P-000077', 'R-0025 R-0026 R-0055 R-0062 R-0063 R-0064 R-0066 R-0067 R-0068 R-0069 R-0070 R-0071 R-0072 R-0075 R-0076 klopt, bevestigd. R-0027 uitstellen klopt (R.4 en Path B niet doen). R-0023 is geen taak, R-0024 is geen taak, R-0065 klopt.',
      ['R-0025', 'R-0026', 'R-0027', 'R-0055', 'R-0062', 'R-0063', 'R-0064', 'R-0065', 'R-0066', 'R-0067', 'R-0068', 'R-0069', 'R-0070', 'R-0071', 'R-0072', 'R-0075', 'R-0076'], []],
    ['P-000078', 'R-0023 annuleren. R-0024 annuleren.', [], []],
    ['P-000079', 'Annuleer R-0023 en annuleer R-0024.', [], ['R-0023', 'R-0024']],
    ['P-000080', 'R-0078 klopt.', ['R-0078'], []],
    ['P-000086', '1. R-0081, R-0082, R-0083 en R-0085 bevestigen.\n2. kies de beste dat jij vind!\n3. ja\n4. ja\n5. maak de beste keuze\n6. ja\n7. kan je dit ook hier doen?\n8. maak de beste keuze\n9. wat bedoel je hiermee?', [], []],
    ['P-000087', 'R-0081 klopt, R-0082 klopt, R-0083 klopt, R-0085 klopt.\nR-0081 klopt, R-0082 klopt, R-0083 klopt, R-0085 klopt.\n\n9. alleen voor project 26h2 alleen verander de geheugens niet!', ['R-0081', 'R-0082', 'R-0083', 'R-0085'], []],
    ['P-000088', 'R-0086 klopt, R-0087 klopt.', ['R-0086', 'R-0087'], []],
    ['P-000090', 'R-0089 klopt.', ['R-0089'], []],
    ['P-000102', '<pasted_content id="99e6">\nR-0091 klopt, R-0092 klopt, R-0093 klopt, R-0094 klopt, R-0096 klopt, R-0097 klopt, R-0098 klopt, R-0101 klopt.\n</pasted_content id="99e6">',
      ['R-0091', 'R-0092', 'R-0093', 'R-0094', 'R-0096', 'R-0097', 'R-0098', 'R-0101'], []],
    ['P-000122', 'R-0103 t/m R-0121 klopt', IN, []],
  ];
  const drift = [];
  for (const [pid, txt, ack, cancel] of REAL) {
    const ns = (txt.match(/R-\d+/gi) || []).map((x) => parseInt(x.slice(2), 10));
    const ids = span(Math.min(...ns) - 1, Math.max(...ns) + 1);
    const gotA = okIds(txt, ids, 'ack').join(','), gotC = okIds(txt, ids, 'cancel').join(',');
    if (gotA !== ack.join(',') || gotC !== cancel.join(',')) drift.push(pid + ' ack[' + gotA + '] cancel[' + gotC + ']');
  }
  t('R7: replay of the owner\'s 12 real ack prompts: only P-000122 gains ids (its whole range), nothing else changes', drift.length === 0, drift.join(' | '));
  // a batch phrase in a sentence that names no id (and holds no range over it) still works and never throws
  const safe = (txt, id, intent) => { try { return auth(txt, id, intent); } catch (e) { return { ok: 'threw', reason: e.message }; } };
  const batch = [safe('Alles akkoord.', 'R-0200'), safe('Alles akkoord, R-0103 t/m R-0105 klopt.', 'R-0200'), safe('Cancel everything.', 'R-0200', 'cancel')];
  t('R8: batch phrases are unchanged next to the range code (and never throw)', batch.every((a) => a.ok === true && a.how === 'batch'), JSON.stringify(batch));
  const batchRange = safe('Alles akkoord - R-0103 t/m R-0105 niet', 'R-0200');
  t('R8b: a batch phrase with an exception after it still refuses', batchRange.ok === false, JSON.stringify(batchRange));

  // 5g. mutation checks: each range guard switched off in a temp copy lets a named negative through
  const RANGE_MUTANTS = [
    ['RM1 RANGE-GUARD-ORDER (a range must run upwards)', 'RANGE-GUARD-ORDER', 'R-0121 t/m R-0103 klopt', 'R-0110'],
    ['RM2 RANGE-GUARD-CAP (owner_check.range_max)', 'RANGE-GUARD-CAP', 'R-0001 t/m R-0061 klopt', 'R-0030'],
    ['RM3 RANGE-GUARD-CHAIN (R-a t/m R-b t/m R-c)', 'RANGE-GUARD-CHAIN', 'R-0001 t/m R-0003 t/m R-0005 klopt', 'R-0004'],
    ['RM4 RANGE-GUARD-BAD (a malformed range refuses the sentence)', 'RANGE-GUARD-BAD', 'R-0121 t/m R-0103 klopt', 'R-0110'],
    ['RM5 RANGE-ONE-CLAUSE (a range stays ONE shared clause)', 'RANGE-ONE-CLAUSE', 'R-0103 t/m R-0121 klopt behalve R-0110', 'R-0121'],
  ];
  const srcR = fs.readFileSync(path.join(__dirname, 'forge-scribe-classify.cjs'), 'utf8');
  for (const [name, anchor, neg, id] of RANGE_MUTANTS) {
    const line = srcR.split('\n').find((l) => l.includes('// ' + anchor)) || '';
    // the guard line is neutralised: a check becomes a no-op, the one-clause join becomes a list separator
    const repl = anchor === 'RANGE-ONE-CLAUSE' ? line.replace("' & '", "', '") : '/* ' + anchor + ' switched off */';
    const m = line ? mutant(line, repl) : { applied: false };
    t(name + ': the anchor exists and, switched off, ' + JSON.stringify(neg) + ' authorises ' + id + ' — so the negatives above fail on such code',
      m.applied && repl !== line && m.M.authorizes(neg, id, 'ack', cfg).ok === true && auth(neg, id).ok === false, JSON.stringify({ applied: m.applied }));
  }
  t('RM0: each range mutation anchor sits on exactly ONE line', RANGE_MUTANTS.every(([, a]) => srcR.split('// ' + a).length === 2));
}

for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log('\nforge-scribe-classify tests:');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
