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

// LEAD-S1: two real false repeats seen live. R-0239 was "REPEAT x23 of
// R-0157,R-0081" at 63% on parallel/website/andere/project (one concept hit through the word "agents", one content word and
// two generic words inside two long earlier asks); R-0244, a forge-config command line, was "REPEAT x2 of R-0188" at 56% on
// node/claude/forge/bin (the words of a command and a path). Earlier items: the first 1000 (R-0081) and 1400 (R-0157)
// characters of the real quotes, R-0188 whole (the path's user name replaced).
console.log('LEAD-S1 command text, paths and generic words');
const R0157 = "/forge R-0152 akkoord. R-0154 akkoord. R-0155 akkoord. R-0156 akkoord. R-0153 annuleren.  Staat nu alles wat in globaal moet in globaal?! en niet in dit folder alleen maar ook globaal zo ja ga verder met dit prompt. Zo niet fix dit eerst en ga dan verder!\n\nik wil dat jij nu 3 testen en 3 aparte agents laat runnen gaan hun 3 catogorieen testen voeren dus 1 van de agent gaat een high end website voor Chinese  Restaurant bedrijf maken denk, de andere gaat een apk game maken en een .exe fun game. en ik wil dat jij alles monitoort als de forge systeem\n  doet wat het moet doen denk aan skills, agents, de werk kwaliteit, tokens, usage, en meer andere dingen waar er gemonitoord moeten zijn!\n\n  der zijn paar regels ik wil dat je niks met skills gaat zeggen de doel heirvam is om te kijken als de agents de skills aansluiten aan de agents of aan de catogorie correct!\n  tweede regel je prompts moeten niet ai achtig zijn maar menselijk! zodat de agents de prompten goed kunnen verbeteren! en hoe jij "
  + "het wilt hebben!\n  derde regel zie je een fout opkomen verbeter de agent niet meteen maar wacht erop aan dde einde van de project en inspecteer je de fouten en verbeter je het in de forge systeem zodat het nooit meer voorkomt!\n  vierde regel de website moet er goed uit zien dit geldt ook voor de rest van de catogorieen!\n  vijfde regel werkt forge systeem hoe het moet en kunnen er dingen verbeterd ";
const R0081 = "/forge /goal /deep-research  gebruik fable 5.1 om dit project 10x beter te maken, eerst wil ik dat je een uitgebreide plan gaat schrijven en dan pas gaat act! ik wil nu dat je de hele project scant en  naar foute en oplossingen en verbeteringen en betere functies gaat vinden. je gaat kijken naar wat kan beter, wat moeten de ai als taken moeten uitvoeren, werken de agents op de beste manier, is er een team gesprek, zijn de agents echt en werken ze ook echt, werken alles echt hoe het echt werkt en staat alles in de .claude forge systeem? vraag je zelf heel veel vragen en beantwoord het door te kijken naar dit complete forge project!  nadat dit klaar is willen we onze forge systeem net als hoe claude desktop werkt maar dan als forge systeem en hoe onze systeem en alles werkt! we willen in de app alles kunnen koppelen zoals ollama modellen, open ai, en meer andere dingen ook moeten niet alleen de api ook de subscripties zoals bij chatgpt, codex en claude! we willen een soort werking hebben";
const R0188 = 'als ik dit ! node .claude/forge-bin/forge-sync.cjs install "C:/Users/owner/Desktop/Roblox high end game" --quiesce-override "owner approved: own planner is the only writer, project has no Forge yet" naar roblox project doe krijg ik error';
const s1 = [itemOf('R-0081', R0081), itemOf('R-0157', R0157, { class: 'new', status: 'deferred' }), itemOf('R-0188', R0188, { class: 'unclassified', status: 'defer-proposed' })];
const r239 = SC.ownerRepeats('/forge finetune ook alle agents! maak ook agents for website en andere projecten  die we tot nu toe allemaal hebben gemaakt!', s1, cfg);
t('S1-a: R-0239 ("finetune ook alle agents ... website en andere projecten") is not a repeat of R-0157 or R-0081 (real: REPEAT x23 at 63%)', r239 === null, JSON.stringify(r239));
const r244 = SC.ownerRepeats(' ! node .claude/forge-bin/forge-config.cjs set usage-guard uit', s1, cfg);
t('S1-b: R-0244 (a "! node .claude/forge-bin/forge-config.cjs ..." command line) is not a repeat of R-0188 (real: REPEAT x2 at 56%)', r244 === null, JSON.stringify(r244));
const inline = SC.ownerRepeats('draai `node .claude/forge-bin/forge-doctor.cjs` en .claude/forge-bin/forge-sync.cjs --quiet naar https://github.com/x/forge-bin', [itemOf('R-0188', R0188)], cfg);
t('S1-c: inline code, paths, flags and URLs carry no repeat words', inline === null, JSON.stringify(inline));
t('S1-d: a true repeat about the same problem still repeats (an install error on the roblox project, with a repeat cue, vs R-0188)',
  !!SC.ownerRepeats('ik krijg weer een error bij forge sync install naar het roblox project', [itemOf('R-0188', R0188)], cfg));

console.log('stored links re-judged');
const st = { items: {}, counts: { open: 2 }, next_rid: 3, last_seq: 2 };
st.items['R-0157'] = itemOf('R-0157', RESTAURANT, { class: 'new' });
st.items['R-0161'] = itemOf('R-0161', 'welke skills werden bij de restaurant website gebruikt?', { class: 'question', status: 'open', repeat_of: ['R-0157'], repeat_count: 2 });
const view = SC.ownerView(st, cfg);
t('Q-h: the owner view drops the stored false link R-0161 -> R-0157', !view.items['R-0161'].repeat_of && !view.items['R-0161'].repeat_count, JSON.stringify(view.items['R-0161']));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
