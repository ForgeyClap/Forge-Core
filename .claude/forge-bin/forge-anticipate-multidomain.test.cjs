#!/usr/bin/env node
'use strict';
/**
 * forge-anticipate-multidomain.test.cjs — category tests A1. The real Windows-game and Android-game
 * prompts are classified with two domains (electron + game, mobile + game), but forge-anticipate took the playbook and
 * the deliverable types of the PRIMARY domain only: skills_to_use held forge-electron / forge-mobile and never
 * forge-game, and the run declared "web-ui" for a game (so the game craft lens never applied). Guard: every detected
 * domain contributes its playbook to skills_to_use, and its craft types to the declared deliverable types.
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const CLI = path.join(__dirname, 'forge-anticipate.cjs');
const plan = (text) => { const r = spawnSync(process.execPath, [CLI, 'plan', '--text', text, '--json'], { encoding: 'utf8' }); return JSON.parse(r.stdout); };
const A = require('./forge-anticipate.cjs');

const WINDOWS = 'Maak een leuk spelletje voor Windows dat ik gewoon als .exe kan openen met dubbelklikken, voor als ik even pauze heb op het werk. Iets grappigs, mag best een beetje gek zijn. Het moet meteen werken zonder dat ik eerst iets anders moet installeren, en het moet er verzorgd uitzien: een beginscherm, kunnen pauzeren, en geluid zou leuk zijn.';
const ANDROID = 'Ik wil een simpel maar verslavend spelletje voor mijn Android telefoon, als .apk die ik zelf kan installeren (dus niet via de Play Store). Iets met tikken of swipen, korte potjes, en een highscore die bewaard blijft als je de app sluit. Verzin zelf wat leuk is, maar het moet er wel goed uitzien en lekker aanvoelen, geen grijze blokjes.';
const SITE = 'Maak een high-end website voor een Chinees restaurant met menu, reserveren en openingstijden.';

console.log('forge-anticipate: every detected domain counts (A1)');
const w = plan(WINDOWS), a = plan(ANDROID), s = plan(SITE);
t('the Windows prompt is classified electron + game (precondition)', () => assert.ok(w.signals.domains.includes('game') && w.signals.domains.includes('electron'), JSON.stringify(w.signals)));
t('Windows game: skills_to_use holds forge-game AND forge-electron', () => assert.ok(w.skills_to_use.includes('forge-game') && w.skills_to_use.includes('forge-electron'), JSON.stringify(w.skills_to_use)));
t('Android game: skills_to_use holds forge-game AND forge-mobile', () => assert.ok(a.skills_to_use.includes('forge-game') && a.skills_to_use.includes('forge-mobile'), JSON.stringify(a.skills_to_use)));
t('the primary playbook still comes first (order kept for existing readers)', () => assert.strictEqual(w.skills_to_use.indexOf('forge-electron') < w.skills_to_use.indexOf('forge-game'), true, JSON.stringify(w.skills_to_use)));
t('a single-domain website prompt is unchanged: forge-website, no forge-game', () => assert.ok(s.skills_to_use.includes('forge-website') && !s.skills_to_use.includes('forge-game'), JSON.stringify(s.skills_to_use)));
t('Windows game: the declared deliverable types include game-and-interactive', () => {
  const dt = A.deliverableTypes(WINDOWS, w, {});
  assert.ok(dt.types.includes('game-and-interactive'), JSON.stringify(dt));
});
t('Android game: the declared deliverable types include game-and-interactive', () => {
  const dt = A.deliverableTypes(ANDROID, a, {});
  assert.ok(dt.types.includes('game-and-interactive'), JSON.stringify(dt));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
