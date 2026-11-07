#!/usr/bin/env node
'use strict';
/**
 * forge-skillmap.test.cjs — the skill-map reader behind skill delivery (category finding SK1).
 * Covers: known skill names from the project AND the user skills folder, the two real map shapes (per agent type and
 * WP-keyed free text), display-name keys, the LAST skill_map_created event, and the transcript scan (Skill tool,
 * Read of a SKILL.md with either slash style, unrelated reads ignored, bounded, never throws). Throwaway roots only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const SM = require('./forge-skillmap.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const tmp = (p) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(r); return r; };
const addSkill = (base, name) => { const d = path.join(base, '.claude', 'skills', name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# ' + name + '\n'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const KNOWN = new Set(['frontend-design', 'forge-website', 'forge-testing', 'forge-verify', 'forge-craft', 'forge-game', 'forge-windows-shell']);
const RESTAURANT = { 'ui-boss': ['frontend-design', 'forge-website'], 'test-boss': ['forge-testing'], 'verify-boss': ['forge-verify'], 'review-boss': ['forge-craft'] };
const WINDOWS = {
  WP1: 'build-boss: GAME_SPEC s5 audio (native method)',
  WP2: 'build-boss: forge-game domain gates + GAME_SPEC s2-3',
  WP3: 'ui-boss: frontend-design principles + GAME_SPEC s4',
  WP4: 'build-boss: forge-windows-shell + GAME_SPEC s6',
  WP6: 'verify-boss: forge-verify',
  WP7: 'review-boss: forge-craft + game quality card',
};

try {
  console.log('\nA) knownSkillNames');
  const root = tmp('forge-skm-root-');
  const home = tmp('forge-skm-home-');
  addSkill(root, 'forge-verify');
  addSkill(home, 'frontend-design');
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'no-skill-md'), { recursive: true });
  const k = SM.knownSkillNames(root, { home });
  t('A1 project and user skills both known', k.has('forge-verify') && k.has('frontend-design'), [...k].join(','));
  t('A2 a folder without SKILL.md is not a skill', !k.has('no-skill-md'));
  t('A3 a missing root never throws (empty set)', SM.knownSkillNames(path.join(root, 'nope'), { home: path.join(home, 'nope') }).size === 0);
  t('A4 garbage root never throws', SM.knownSkillNames(null, { home: null }) instanceof Set);

  console.log('\nB) normalizeSkillMap');
  t('B1 restaurant shape kept as is', same(SM.normalizeSkillMap(RESTAURANT, KNOWN), RESTAURANT), JSON.stringify(SM.normalizeSkillMap(RESTAURANT, KNOWN)));
  const w = SM.normalizeSkillMap(WINDOWS, KNOWN);
  t('B2 WP-keyed free text -> agent type before ":" and only known skill tokens, duplicates merged',
    same(w, { 'build-boss': ['forge-game', 'forge-windows-shell'], 'ui-boss': ['frontend-design'], 'verify-boss': ['forge-verify'], 'review-boss': ['forge-craft'] }), JSON.stringify(w));
  t('B3 GAME_SPEC / principles dropped', !JSON.stringify(w).includes('GAME_SPEC') && !JSON.stringify(w).includes('principles'));
  const d = SM.normalizeSkillMap({ 'UI Boss': ['frontend-design', 'not-a-skill'], 'Verify Boss': 'forge-verify', 'Head Chef': [], 'ui-boss': ['forge-website', 'frontend-design'] }, KNOWN);
  t('B4 display-name keys lowercased with hyphens, merged with the same agent, unknown names dropped, empty agent left out',
    same(d, { 'ui-boss': ['frontend-design', 'forge-website'], 'verify-boss': ['forge-verify'] }), JSON.stringify(d));
  t('B5 plugin prefix on a skill name is stripped', same(SM.normalizeSkillMap({ 'ui-boss': ['some-plugin:frontend-design'] }, KNOWN), { 'ui-boss': ['frontend-design'] }));
  t('B6 unknown / empty inputs -> {}', same(SM.normalizeSkillMap(null, KNOWN), {}) && same(SM.normalizeSkillMap([], KNOWN), {}) && same(SM.normalizeSkillMap('x', KNOWN), {}) && same(SM.normalizeSkillMap(RESTAURANT, new Set()), {}));
  t('B7 a WP key without "agent:" text assigns nothing', same(SM.normalizeSkillMap({ WP9: 'forge-verify only' }, KNOWN), {}));
  t('B8 known may be an array', same(SM.normalizeSkillMap({ 'test-boss': ['forge-testing'] }, ['forge-testing']), { 'test-boss': ['forge-testing'] }));

  console.log('\nC) latestSkillMap');
  const runDir = tmp('forge-skm-run-');
  const ev = (o) => JSON.stringify(Object.assign({ run_id: 'r1', timestamp: new Date().toISOString() }, o));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), [
    ev({ event_type: 'run_started' }),
    ev({ event_type: 'skill_map_created', map: { 'ui-boss': ['old'] } }),
    '{broken json line',
    ev({ event_type: 'skill_map_created', map: RESTAURANT }),
    ev({ event_type: 'agent_started', note: 'skill_map_created mentioned in text' }),
  ].join('\n') + '\n');
  t('C1 the LAST skill_map_created map wins, broken lines skipped', same(SM.latestSkillMap(runDir), RESTAURANT), JSON.stringify(SM.latestSkillMap(runDir)));
  {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skillmap-legacy-'));
    fs.writeFileSync(path.join(legacyDir, 'events.jsonl'), JSON.stringify({ event_type: 'skill_map_created', skills: { 'ui-boss': ['frontend-design'] } }) + '\n');
    t('C1b the older `skills` field is read too (verifier finding)', same(SM.latestSkillMap(legacyDir), { 'ui-boss': ['frontend-design'] }), JSON.stringify(SM.latestSkillMap(legacyDir)));
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
  t('C2 no events file -> null', SM.latestSkillMap(path.join(runDir, 'missing')) === null && SM.latestSkillMap(null) === null);
  const noMap = tmp('forge-skm-run2-');
  fs.writeFileSync(path.join(noMap, 'events.jsonl'), ev({ event_type: 'run_started' }) + '\n');
  t('C3 no skill_map_created event -> null', SM.latestSkillMap(noMap) === null);

  console.log('\nD) skillsOpenedInTranscript');
  const tr = path.join(tmp('forge-skm-tr-'), 'agent-x.jsonl');
  const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
  const use = (name, input) => ({ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input });
  fs.writeFileSync(tr, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read .claude/skills/forge-fake/SKILL.md please' } }),
    asst([{ type: 'text', text: 'starting' }, use('Skill', { skill: 'frontend-design' })]),
    asst([use('Skill', { skill: 'superpowers:brainstorming' })]),
    asst([use('Read', { file_path: 'C:\\Users\\x\\proj\\.claude\\skills\\forge-website\\SKILL.md' })]),
    asst([use('Read', { file_path: '/home/x/.claude/skills/forge-verify/SKILL.md' })]),
    asst([use('Read', { file_path: 'C:/p/.claude/skills/forge-craft/references/notes.md' }), use('Read', { file_path: 'C:/p/src/app.js' })]),
    asst([use('Read', { file_path: 'C:/p/.claude/skills/frontend-design/SKILL.md' })]),
    'not json at all',
  ].join('\n') + '\n');
  const s = SM.skillsOpenedInTranscript(tr);
  t('D1 Skill tool + Read SKILL.md (both slash styles), plugin prefix stripped, deduped, in order',
    s.scanned === true && same(s.skills, ['frontend-design', 'brainstorming', 'forge-website', 'forge-verify']), JSON.stringify(s));
  t('D2 a user message naming a SKILL.md and a reference-file read are not counted', !s.skills.includes('forge-fake') && !s.skills.includes('forge-craft'));
  const missing = SM.skillsOpenedInTranscript(path.join(os.tmpdir(), 'forge-skm-does-not-exist.jsonl'));
  t('D3 an unreadable path -> scanned:false, no throw', missing.scanned === false && same(missing.skills, []));
  t('D4 no path -> scanned:false', SM.skillsOpenedInTranscript(null).scanned === false && SM.skillsOpenedInTranscript(42).scanned === false);
  const b = SM.skillsOpenedInTranscript(tr, { maxBytes: 200 });
  t('D5 bounded: only the first maxBytes are read', b.scanned === true && b.skills.length <= 1, JSON.stringify(b));
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-skillmap tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
