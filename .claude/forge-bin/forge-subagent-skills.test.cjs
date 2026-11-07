#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-skills.test.cjs — skill delivery through the harness hooks (category finding SK1).
 * The Lead logs skill_map_created, but agents never received or opened their skills. Covers, through the real CLIs:
 * the SubagentStart hook injects hookSpecificOutput.additionalContext naming the assigned skills (both map shapes,
 * display-name keys), prints NOTHING for an unassigned agent / no run / no map / opt-out / bad stdin (exit 0), and the
 * SubagentStop line carries skills_opened + transcript_scanned without ever storing the transcript path.
 * Throwaway roots and an isolated home folder only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); }
};
const roots = [];
const tmp = (p) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(r); return r; };
const HOME = tmp('forge-sks-home-');
const START = path.join(__dirname, 'forge-subagent-start.cjs');
const STOP = path.join(__dirname, 'forge-subagent-stop.cjs');
const cli = (script, root, input, extraEnv) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, HOME, USERPROFILE: HOME, FORGE_SUBAGENT_START_HOOK: '', FORGE_SUBAGENT_STOP_HOOK: '', FORGE_RUN_ID: '' }, extraEnv || {}) });
const SKILLS = ['frontend-design', 'forge-website', 'forge-testing', 'forge-verify', 'forge-craft', 'forge-game', 'forge-windows-shell'];

function project(map, opts) {
  opts = opts || {};
  const root = tmp('forge-sks-');
  for (const s of SKILLS) { const d = path.join(root, '.claude', 'skills', s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# ' + s + '\n'); }
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-sk-1');
  fs.mkdirSync(runDir, { recursive: true });
  const lines = [JSON.stringify({ run_id: 'run-sk-1', event_type: 'run_started' })];
  if (map) lines.push(JSON.stringify({ run_id: 'run-sk-1', event_type: 'skill_map_created', agent: 'orchestrator', map }));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n');
  if (!opts.noPointer) AR.setActiveRun(root, 'run-sk-1', { session: 'sess-sk' });
  return root;
}
const startPayload = (agentType) => JSON.stringify({ session_id: 'sess-sk', transcript_path: 'C:/x/main.jsonl', cwd: 'C:/x', hook_event_name: 'SubagentStart', agent_id: 'a1b2c3d4', agent_type: agentType });
const parseOut = (s) => { try { return JSON.parse(s); } catch { return null; } };
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const RESTAURANT = { 'ui-boss': ['frontend-design', 'forge-website'], 'test-boss': ['forge-testing'], 'verify-boss': ['forge-verify'], 'review-boss': ['forge-craft'] };
const WINDOWS = { WP2: 'build-boss: forge-game domain gates + GAME_SPEC s2-3', WP3: 'ui-boss: frontend-design principles + GAME_SPEC s4', WP4: 'build-boss: forge-windows-shell + GAME_SPEC s6', WP6: 'verify-boss: forge-verify' };

try {
  console.log('\nA) SubagentStart injects the assigned skills');
  const r1 = project(RESTAURANT);
  const c1 = cli(START, r1, startPayload('ui-boss'));
  const o1 = parseOut(c1.stdout);
  const ctx = o1 && o1.hookSpecificOutput && o1.hookSpecificOutput.additionalContext;
  t('A1 exit 0 and valid hookSpecificOutput for SubagentStart', c1.status === 0 && !!o1 && o1.hookSpecificOutput.hookEventName === 'SubagentStart' && typeof ctx === 'string', JSON.stringify({ s: c1.status, o: c1.stdout, e: c1.stderr }));
  t('A2 names both assigned skills and their SKILL.md path, not other agents\' skills',
    !!ctx && ctx.includes('frontend-design') && ctx.includes('forge-website') && ctx.includes('.claude/skills/frontend-design/SKILL.md') && !ctx.includes('forge-verify'), ctx);
  t('A3 says to open them first and to name the used skills in the report (EN + NL)', !!ctx && /open/i.test(ctx) && /report/i.test(ctx) && /rapport/i.test(ctx) && ctx.includes('Skill'), ctx);
  t('A4 the start line is still written', readLines(path.join(r1, '.claude', 'forge-runs', '_hooks', 'subagent-start.jsonl')).length === 1);
  t('A5 nothing but the JSON object on stdout', c1.stdout.trim().startsWith('{') && c1.stdout.trim().endsWith('}'));

  console.log('\nB) other map shapes');
  const r2 = project(WINDOWS);
  const ctx2 = (parseOut(cli(START, r2, startPayload('build-boss')).stdout) || { hookSpecificOutput: {} }).hookSpecificOutput.additionalContext || '';
  t('B1 WP-keyed free text: build-boss gets forge-game + forge-windows-shell, never GAME_SPEC', ctx2.includes('forge-game') && ctx2.includes('forge-windows-shell') && !ctx2.includes('GAME_SPEC'), ctx2);
  const r3 = project({ 'UI Boss': ['frontend-design'], 'Verify Boss': ['forge-verify'] });
  const ctx3 = (parseOut(cli(START, r3, startPayload('verify-boss')).stdout) || { hookSpecificOutput: {} }).hookSpecificOutput.additionalContext || '';
  t('B2 display-name key "Verify Boss" reaches agent_type verify-boss', ctx3.includes('forge-verify') && !ctx3.includes('frontend-design'), ctx3);

  console.log('\nC) silent when there is nothing to deliver');
  const c4 = cli(START, r1, startPayload('build-boss'));
  t('C1 unassigned agent: exit 0, empty stdout', c4.status === 0 && c4.stdout === '', JSON.stringify({ s: c4.status, o: c4.stdout }));
  const c5 = cli(START, project(RESTAURANT, { noPointer: true }), startPayload('ui-boss'));
  t('C2 no active run: empty stdout', c5.status === 0 && c5.stdout === '');
  const c6 = cli(START, project(null), startPayload('ui-boss'));
  t('C3 run without a skill map: empty stdout', c6.status === 0 && c6.stdout === '');
  const c7 = cli(START, r1, startPayload('ui-boss'), { FORGE_SUBAGENT_START_HOOK: 'off' });
  t('C4 opt-out: empty stdout', c7.status === 0 && c7.stdout === '');
  for (const [n, input] of [['bad JSON', '{{{nope'], ['empty', ''], ['array', '[]']]) {
    const c = cli(START, r1, input);
    t('C5 ' + n + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }

  console.log('\nD) SubagentStop records which skills were opened');
  const r8 = project(RESTAURANT);
  const tr = path.join(tmp('forge-sks-tr-'), 'subagents', 'agent-a1b2c3d4.jsonl');
  fs.mkdirSync(path.dirname(tr), { recursive: true });
  const use = (name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }] } });
  fs.writeFileSync(tr, [use('Skill', { skill: 'frontend-design' }), use('Read', { file_path: r8 + '\\.claude\\skills\\forge-website\\SKILL.md' }), use('Read', { file_path: r8 + '/src/x.js' })].join('\n') + '\n');
  const stopPayload = (extra) => JSON.stringify(Object.assign({ session_id: 'sess-sk', hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1b2c3d4', agent_type: 'ui-boss', agent_transcript_path: tr, last_assistant_message: 'done' }, extra || {}));
  const stopLog = path.join(r8, '.claude', 'forge-runs', '_hooks', 'subagent-stop.jsonl');
  const s1 = cli(STOP, r8, stopPayload());
  const L = readLines(stopLog);
  t('D1 skills_opened + transcript_scanned:true on the stop line, exit 0, empty stdout',
    s1.status === 0 && s1.stdout === '' && L.length === 1 && JSON.stringify(L[0].skills_opened) === JSON.stringify(['frontend-design', 'forge-website']) && L[0].transcript_scanned === true, JSON.stringify({ L, e: s1.stderr }));
  t('D2 the transcript path never reaches disk', !fs.readFileSync(stopLog, 'utf8').includes('agent-a1b2c3d4.jsonl') && !fs.readFileSync(stopLog, 'utf8').includes('subagents'));
  cli(STOP, r8, stopPayload({ agent_transcript_path: path.join(os.tmpdir(), 'forge-sks-missing.jsonl') }));
  cli(STOP, r8, stopPayload({ agent_transcript_path: undefined }));
  const L2 = readLines(stopLog);
  t('D3 unreadable / absent path -> transcript_scanned:false, skills_opened []', L2.length === 3 && L2[1].transcript_scanned === false && L2[2].transcript_scanned === false && L2[1].skills_opened.length === 0 && L2[2].skills_opened.length === 0, JSON.stringify(L2.slice(1)));
  const big = stopPayload({ last_assistant_message: 'M'.repeat(400000) });
  cli(STOP, r8, big);
  const L3 = readLines(stopLog);
  t('D4 a cut payload still scans the transcript (path salvaged from the head)', L3.length === 4 && L3[3].truncated === true && L3[3].transcript_scanned === true && L3[3].skills_opened.length === 2, JSON.stringify(L3[3]));
  const s5 = cli(STOP, r8, '{{{nope');
  t('D5 bad JSON stdin: exit 0, empty stdout', s5.status === 0 && s5.stdout === '');
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-subagent-skills tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
