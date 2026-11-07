#!/usr/bin/env node
'use strict';
/**
 * forge-anticipate-scope.test.cjs — category tests A2. The owner's category-test request (R-0157: three
 * projects, each in its own folder with a fresh Forge install, while the Lead watches skills, agents, quality, tokens and
 * usage) made forge-anticipate declare web-ui, copy-and-content, voice-and-chat and game-and-interactive for the Lead's
 * OWN run in the Forge dev tree, which only ships tooling fixes; the run contract then asked that run for craft reviews
 * and web screenshots. Guard: a meta mission (detected from the text, or declared with --scope meta) declares one
 * tooling type and says why; the three real project prompts keep their project types (no false negatives).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const CLI = path.join(__dirname, 'forge-anticipate.cjs');
const A = require('./forge-anticipate.cjs');
const types = (text, opts) => A.deliverableTypes(text, A.plan(text, opts || {}), opts || {});

// R-0157, the owner's real category-test request (forge-scribe), word for word.
const META = "/forge R-0152 akkoord. R-0154 akkoord. R-0155 akkoord. R-0156 akkoord. R-0153 annuleren.  Staat nu alles wat in globaal moet in globaal?! en niet in dit folder alleen maar ook globaal zo ja ga verder met dit prompt. Zo niet fix dit eerst en ga dan verder!\n\nik wil dat jij nu 3 testen en 3 aparte agents laat runnen gaan hun 3 catogorieen testen voeren dus 1 van de agent gaat een high end website voor Chinese  Restaurant bedrijf maken denk, de andere gaat een apk game maken en een .exe fun game. en ik wil dat jij alles monitoort als de forge systeem\n  doet wat het moet doen denk aan skills, agents, de werk kwaliteit, tokens, usage, en meer andere dingen waar er gemonitoord moeten zijn!\n\n  der zijn paar regels ik wil dat je niks met skills gaat zeggen de doel heirvam is om te kijken als de agents de skills aansluiten aan de agents of aan de catogorie correct!\n  tweede regel je prompts moeten niet ai achtig zijn maar menselijk! zodat de agents de prompten goed kunnen verbeteren! en hoe jij het wilt hebben!\n  derde regel zie je een fout opkomen verbeter de agent niet meteen maar wacht erop aan dde einde van de project en inspecteer je de fouten en verbeter je het in de forge systeem zodat het nooit meer voorkomt!\n  vierde regel de website moet er goed uit zien dit geldt ook voor de rest van de catogorieen!\n  vijfde regel werkt forge systeem hoe het moet en kunnen er dingen verbeterd worden?! dit is voor einde van de 3 catogorieen projecten!\n  zesde regel maak voor elke catogorie project een aparte map en installeer apart daar de forge systeem die we nu ook hebben de up to date en niet de oude!\n";
// _scratch/category-tests/prompts/*.txt (the real project prompts, word for word).
const RESTAURANT = "/forge Mijn oom heeft een Chinees restaurant in Rotterdam, het heet Jade Paviljoen (dim sum, Kantonese keuken, ook afhalen). Zijn website is heel oud en hij schaamt zich er eigenlijk voor. Kun je een nieuwe site voor hem maken die er echt chique en duur uitziet? Dus niet zo'n standaard ding met rode lampionnen en Comic Sans. Mensen moeten het menu kunnen bekijken, een tafel kunnen reserveren (een formulier is genoeg, het hoeft nog niet echt iets te versturen) en kunnen zien waar het zit en wanneer ze open zijn. Het moet ook goed werken op de telefoon, want daar kijken de meeste mensen op. Foto's heeft hij nog niet, dus los dat netjes op. Ik ben de komende uren niet bereikbaar, dus maak zelf de keuzes. Laat me aan het eind weten hoe ik het kan bekijken.";
const ANDROID = "/forge Ik wil een simpel maar verslavend spelletje voor mijn Android telefoon, als .apk die ik zelf kan installeren (dus niet via de Play Store). Iets met tikken of swipen, korte potjes, en een highscore die bewaard blijft als je de app sluit. Verzin zelf wat leuk is, maar het moet er wel goed uitzien en lekker aanvoelen, geen grijze blokjes. Java en de Android SDK staan al op deze pc (JAVA_HOME en ANDROID_HOME zijn gezet); als er nog iets mist mag je dat installeren. Ik ben de komende uren niet bereikbaar, dus maak zelf de keuzes. Als het klaar is wil ik weten waar de apk staat.";
const WINDOWS = "/forge Maak een leuk spelletje voor Windows dat ik gewoon als .exe kan openen met dubbelklikken, voor als ik even pauze heb op het werk. Iets grappigs, mag best een beetje gek zijn. Het moet meteen werken zonder dat ik eerst iets anders moet installeren, en het moet er verzorgd uitzien: een beginscherm, kunnen pauzeren, en geluid zou leuk zijn. Ik ben de komende uren niet bereikbaar, dus maak zelf de keuzes. Zeg me waar de exe staat als hij af is.";
const PROJECT_TYPES = ['web-ui', 'copy-and-content', 'voice-and-chat', 'game-and-interactive'];

console.log('forge-anticipate: a meta mission does not declare the projects\' deliverable types (A2)');
t('meta request: none of the project craft types is declared for the tooling run', () => {
  const dt = types(META);
  assert.deepStrictEqual(dt.types.filter((x) => PROJECT_TYPES.includes(x)), [], JSON.stringify(dt.types));
});
t('meta request: exactly one tooling type (code) is declared, and the reason names the meta scope', () => {
  const dt = types(META);
  assert.deepStrictEqual(dt.types, ['code'], JSON.stringify(dt));
  assert.ok(/meta mission/.test(dt.from[0].from) && /not declared for this run: .*web-ui/.test(dt.from[0].from), dt.from[0].from);
});
t('meta + --type cli-and-devtools: the explicit lens type is the one declared', () => {
  const dt = types(META, { type: 'cli-and-devtools' });
  assert.deepStrictEqual(dt.types, ['cli-and-devtools'], JSON.stringify(dt));
});
t('--scope project turns meta detection off: the request keeps its project types', () => {
  const dt = types(META, { scope: 'project' });
  assert.ok(dt.types.includes('web-ui') && dt.types.includes('game-and-interactive'), JSON.stringify(dt.types));
});
t('--scope meta on a website request declares the tooling type (structural signal wins)', () => {
  const dt = types(RESTAURANT, { scope: 'meta' });
  assert.deepStrictEqual(dt.types, ['code'], JSON.stringify(dt));
});

console.log('regression: the real project prompts keep their types');
t('restaurant prompt keeps web-ui', () => assert.ok(types(RESTAURANT).types.includes('web-ui'), JSON.stringify(types(RESTAURANT))));
t('Android game prompt keeps game-and-interactive', () => assert.ok(types(ANDROID).types.includes('game-and-interactive'), JSON.stringify(types(ANDROID))));
t('Windows game prompt keeps game-and-interactive', () => assert.ok(types(WINDOWS).types.includes('game-and-interactive'), JSON.stringify(types(WINDOWS))));
t('one signal alone is not meta: a website "in een eigen map" keeps web-ui', () => {
  const dt = types('Maak een website voor mijn bakkerij en zet het project in een eigen map.');
  assert.ok(dt.types.includes('web-ui') && dt.types.length > 1, JSON.stringify(dt.types));
});
t('one signal alone is not meta: "test forge op de website" keeps web-ui', () => {
  const dt = types('Bouw een landingspagina voor een kapper en test met forge of de website goed werkt.');
  assert.ok(dt.types.includes('web-ui'), JSON.stringify(dt.types));
});

console.log('CLI: apply --scope meta writes the tooling type into anticipate.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-anticipate-scope-test-'));
try {
  const root = path.join(TMP, 'proj'), rd = path.join(root, '.claude', 'forge-runs', 'run-1');
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), '// test stub: logs nothing\n');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ request: RESTAURANT }));
  const r = spawnSync(process.execPath, [CLI, 'apply', '--run', 'run-1', '--root', root, '--scope', 'meta', '--json'], { encoding: 'utf8' });
  t('apply --scope meta exits 0', () => assert.strictEqual(r.status, 0, r.stderr || r.stdout));
  const ov = (() => { try { return JSON.parse(fs.readFileSync(path.join(rd, 'anticipate.json'), 'utf8')); } catch { return {}; } })();
  t('anticipate.json declares only the tooling type and records the scope', () => {
    assert.deepStrictEqual(ov.deliverable_types, ['code'], JSON.stringify(ov.deliverable_types));
    assert.strictEqual(ov.input && ov.input.scope, 'meta', JSON.stringify(ov.input));
  });
  const bad = spawnSync(process.execPath, [CLI, 'apply', '--run', 'run-1', '--root', root, '--scope', 'galaxy', '--json'], { encoding: 'utf8' });
  t('an unknown --scope value is refused (exit 2, nothing guessed)', () => assert.strictEqual(bad.status, 2, bad.stdout + bad.stderr));
} finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort: the OS cleans its temp folder */ } }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
