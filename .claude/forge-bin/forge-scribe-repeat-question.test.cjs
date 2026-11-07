'use strict';
/* forge-scribe-repeat-question.test.cjs — S-FP2: a plain owner QUESTION whose few words happen to sit inside
 * a long earlier INSTRUCTION is not a repeat. Real cases: "wat is de 3e project wat doet het?" was flagged
 * "REPEAT x18 of R-0055,R-0025,R-0026" (cover 1.00, dice 0.05-0.08, shared: project, doet) and "welke skills werden bij
 * de restaurant website gebruikt?" REPEAT of R-0157 (cover 0.75, dice 0.07). A question may still repeat an earlier ask
 * when it is mutually similar (dice), when it holds a repeat cue, or when the earlier item is itself a question.
 * Zero dependencies: node forge-scribe-repeat-question.test.cjs */
const SC = require('./forge-scribe.cjs');
const C = require('./forge-scribe-classify.cjs');

const cfg = C.loadConfig();
let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}
const itemOf = (rid, quote, o) => Object.assign({ rid, pid: 'P-' + rid.slice(2), status: 'acked', class: 'change', quote }, o || {});

// long instructions shaped like R-0025 / R-0055 / R-0157 (many words, among them the few the later question uses)
const BIG_PROJECT = '/forge ik wil dat je naar de hele project kijkt en gaat kijken kunnen dingen beter, ook zijn er skills erin die '
  + 'moeten geupdate worden want dit project was bedoeld voor claude van vier maanden terug, kijk wat elke agent doet en '
  + 'verbeter de workflows, de dashboard pagina, de installer en de documentatie zodat alles weer klopt met de nieuwste versie';
const THINK_AHEAD = '/forge voeg dit als een phase en in claude.md. ik heb ook gemerkt dat ik steeds moet zeggen zet dit aan zet dat aan '
  + 'en het denkt niet met mij mee waardoor extra tokens verspild worden, het design is soms slordig en het project doet niet '
  + 'wat een professional zou doen, los dat op voor elk type project van begin tot eind';
const RESTAURANT = '/forge R-0152 akkoord. R-0154 akkoord. staat nu alles wat in globaal moet in globaal? bouw daarna de restaurant '
  + 'website opnieuw met de beste skills, test hem op mobiel en desktop en zet de menukaart en reserveringen erop';
const NEWS = 'Maandelijkse nieuws sweep (automatische taak). Werk volledig autonoom. Zoek de nieuwste informatie over claude code, '
  + 'zet de bevindingen in de forge dashboard kaart, update de skills registry en schrijf een korte samenvatting voor de owner';

const items = [itemOf('R-0025', BIG_PROJECT), itemOf('R-0055', THINK_AHEAD), itemOf('R-0157', RESTAURANT, { class: 'new' })];

console.log('S-FP2 question vs instruction');
const q1 = SC.ownerAnalysis('wat is de 3e project wat doet het?>', items, cfg);
t('Q-a: "wat is de 3e project wat doet het?" is not a repeat of a long instruction (real R-0160)', q1.repeat === null, JSON.stringify(q1.repeat));
const q2 = SC.ownerAnalysis('welke skills werden bij de restaurant website gebruikt?', items, cfg);
t('Q-b: "welke skills werden bij de restaurant website gebruikt?" is not a repeat of R-0157 (real R-0161)', q2.repeat === null, JSON.stringify(q2.repeat));
t('Q-c: the trap is real — without the question the same words still match (cover path for an instruction)',
  !!SC.ownerRepeats('zet de skills van de restaurant website erop', items, cfg));

console.log('true repeats kept');
const lanes = [itemOf('R-0001', 'zet extra lanes open zodat er parralel aan de gan kan gaan alleen als ze niet elkaar botsen!', { class: 'new' }),
  itemOf('R-0006', 'kan je niet parallel werken?')];
const ml = SC.ownerRepeats('meer lanes?', lanes, cfg);
t('Q-d: "meer lanes?" (a question) still repeats "kan je niet parallel werken?" (mutual similarity, real R-0013)', !!ml && ml.repeat_of.includes('R-0006'), JSON.stringify(ml));
const fd = SC.ownerRepeats('forge dashboard', [itemOf('R-0071', NEWS, { class: 'new' })], cfg);
t('Q-e: a short instruction inside a long earlier ask still repeats it (real R-0105 of R-0071)', !!fd && fd.repeat_of[0] === 'R-0071', JSON.stringify(fd));
const cue = SC.ownerRepeats('welke skills werden weer niet bij de restaurant website gebruikt?', items, cfg);
t('Q-f: a question WITH a repeat cue ("weer") may repeat an instruction', !!cue && cue.repeat_of.includes('R-0157'), JSON.stringify(cue));
const earlierQ = itemOf('R-0090', 'welke skills werden bij de restaurant website gebruikt en welke bij de an accounting desktop app app en de scraper en de bot?', { class: 'question', status: 'open' });
const qq = SC.ownerRepeats('welke skills werden bij de restaurant website gebruikt?', [earlierQ], cfg);
t('Q-g: a question that asks an earlier OPEN question again is a repeat (cover path kept between questions)', !!qq && qq.repeat_of[0] === 'R-0090', JSON.stringify(qq));

console.log('stored links re-judged');
const st = { items: {}, counts: { open: 2 }, next_rid: 3, last_seq: 2 };
st.items['R-0157'] = itemOf('R-0157', RESTAURANT, { class: 'new' });
st.items['R-0161'] = itemOf('R-0161', 'welke skills werden bij de restaurant website gebruikt?', { class: 'question', status: 'open', repeat_of: ['R-0157'], repeat_count: 2 });
const view = SC.ownerView(st, cfg);
t('Q-h: the owner view drops the stored false link R-0161 -> R-0157', !view.items['R-0161'].repeat_of && !view.items['R-0161'].repeat_count, JSON.stringify(view.items['R-0161']));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
