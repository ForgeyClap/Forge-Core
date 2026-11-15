#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-subagent-start-defaults.test.cjs — SD-T4 and SD-T12c (design: .claude/docs/default-skills.md).
 * The SubagentStart hook records the agent file's preloaded skills (skills_preloaded) and injects only the rest of
 * (run skill map ∪ role baseline ∪ agent domain from FORGE_DEFAULT_SKILLS.json); each start line carries defaults_sha;
 * a file-less agent also gets the forge-conduct body;
 * the wording follows whether the agent has the Skill tool; the injected text never passes 10000 characters. The
 * SubagentStop hook records conduct_seen from the forge-conduct canary line. Throwaway roots and a throwaway home only.
 * Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const ST = require('./forge-subagent-start.cjs');
const SS = require('./forge-subagent-stop.cjs');
const SM = require('./forge-skillmap.cjs');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); } };
const roots = [];
const tmp = (p) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(r); return r; };
const REPO = path.resolve(__dirname, '..', '..');
const HOME = tmp('forge-ssd-home-');
const RUN = 'run-ssd-1';
const SESSION = 'sess-ssd';
const CANARY = 'conduct: forge-conduct v1';
const BASE_SKILLS = ['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail', 'forge-craft', 'forge-ui-polish', 'forge-website',
  'forge-verify', 'forge-code-review', 'forge-game', 'forge-security-review', 'forge-report', 'humanizer', 'forge-quality'];
const CONDUCT_BODY = '# forge-conduct: how every Forge agent works\n\n## 1. Make the smallest complete change\nSolve it.\n\n'
  + '## Last line of your report\nEnd your final report with this exact line: `' + CANARY + '`.\n';

function writeSkill(root, name, body) {
  const d = path.join(root, '.claude', 'skills', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), body || ('---\nname: ' + name + '\ndescription: "Use when testing."\n---\n# ' + name + '\n'));
}
function writeAgent(root, name, tools, skills) {
  const d = path.join(root, '.claude', 'agents');
  fs.mkdirSync(d, { recursive: true });
  const lines = ['---', 'name: ' + name, 'description: test agent'];
  if (tools) lines.push('tools: ' + tools.join(', '));
  if (skills) { lines.push('skills:'); for (const s of skills) lines.push('  - ' + s); }
  lines.push('---', '', '# ' + name, '');
  fs.writeFileSync(path.join(d, name + '.md'), lines.join('\n'));
}
/** project({maps, pointer, extraSkills, conductBody}) -> a throwaway Forge root with the REAL FORGE_DEFAULT_SKILLS.json. */
function project(o) {
  o = o || {};
  const root = tmp('forge-ssd-');
  for (const s of BASE_SKILLS.concat(o.extraSkills || [])) writeSkill(root, s);
  writeSkill(root, 'forge-conduct', '---\nname: forge-conduct\ndescription: "Use when doing any Forge work."\n---\n' + (o.conductBody || CONDUCT_BODY));
  const cfg = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(cfg, { recursive: true });
  fs.copyFileSync(path.join(REPO, '.claude', 'config', 'orchestration', 'FORGE_DEFAULT_SKILLS.json'), path.join(cfg, 'FORGE_DEFAULT_SKILLS.json'));
  const runDir = path.join(root, '.claude', 'forge-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  const lines = [JSON.stringify({ run_id: RUN, event_type: 'run_started' })]
    .concat((o.maps || []).map((m) => JSON.stringify({ run_id: RUN, event_type: 'skill_map_created', agent: 'orchestrator', map: m })));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n');
  if (o.pointer !== false) AR.setActiveRun(root, RUN, { session: SESSION });
  return root;
}
const payload = (agentType) => JSON.stringify({ session_id: SESSION, transcript_path: 'C:/x/main.jsonl', cwd: 'C:/x', hook_event_name: 'SubagentStart', agent_id: 'a1b2c3d4', agent_type: agentType });
/** start(root, agentType) -> {line, ctx}: the written start record and the additionalContext (or ''). */
function start(root, agentType, extra) {
  const opts = { root, env: {}, home: HOME };
  const r = ST.run(payload(agentType), opts);
  const out = ST.hookOutput(r, opts, extra || null);
  let ctx = '';
  try { ctx = out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''; } catch { ctx = 'UNPARSEABLE:' + out; }
  return { r, line: r.record || null, ctx, out };
}
const listed = (ctx, skill) => ctx.split('\n').some((l) => l.startsWith('- ' + skill + ' ('));
function transcript(lastText) {
  const f = path.join(tmp('forge-ssd-tr-'), 'agent-a1.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working, ' + CANARY + ' is a line I will add later' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: lastText }] } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

try {
  console.log('forge-subagent-start defaults (SD-T4)');

  console.log('\nP) preload recorded');
  let root = project();
  writeAgent(root, 'build-boss', ['Read', 'Write', 'Edit', 'Bash', 'Skill'], ['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail']);
  let s = start(root, 'build-boss');
  t('P1 preload recorded: build-boss start line has skills_preloaded = the agent file skills:',
    s.line && JSON.stringify(s.line.skills_preloaded) === JSON.stringify(['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail']), JSON.stringify(s.line));
  t('P2 written to disk too', fs.readFileSync(s.r.path, 'utf8').includes('"skills_preloaded":["forge-conduct","forge-testing","forge-debug","ponytail"]'), s.r.path);
  t('P3 preloadedSkillsOf reads the file; [] without one',
    JSON.stringify(SM.preloadedSkillsOf(root, 'Build Boss', { home: HOME })) === JSON.stringify(['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail'])
    && JSON.stringify(SM.preloadedSkillsOf(root, 'ui-boss', { home: HOME })) === '[]');
  const inl = project();
  fs.mkdirSync(path.join(inl, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(inl, '.claude', 'agents', 'test-boss.md'), '---\r\nname: test-boss\r\nskills: [forge-conduct, "forge-verify"]\r\n---\r\nbody\r\n');
  t('P4 inline list and CRLF are read', JSON.stringify(SM.preloadedSkillsOf(inl, 'test-boss', { home: HOME })) === JSON.stringify(['forge-conduct', 'forge-verify']));
  const gh = tmp('forge-ssd-gh-');
  fs.mkdirSync(path.join(gh, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(gh, '.claude', 'agents', 'verifier.md'), '---\nname: verifier\nskills:\n  - forge-conduct\n---\n');
  t('P5 the home agent file is the fallback (~/.claude/agents/<type>.md)', JSON.stringify(SM.preloadedSkillsOf(inl, 'verifier', { home: gh })) === JSON.stringify(['forge-conduct']));
  t('P6 total on junk: no throw, []', ['', null, 42, '../x', 'a:b', 'x/y'].every((v) => Array.isArray(SM.preloadedSkillsOf(inl, v, { home: gh })) && SM.preloadedSkillsOf(inl, v, { home: gh }).length === 0)
    && SM.preloadedSkillsOf(null, 'build-boss', { home: null }).length === 0);
  const big = project();
  fs.mkdirSync(path.join(big, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(big, '.claude', 'agents', 'build-boss.md'), '---\nname: build-boss\nskills:\n  - forge-conduct\n' + 'x'.repeat(3 * 1024 * 1024) + '\n---\n');
  const t0 = Date.now(); const bigRes = SM.preloadedSkillsOf(big, 'build-boss', { home: HOME }); const ms = Date.now() - t0;
  t('P7 a 3 MB agent file is read bounded (head only) and fast (' + ms + ' ms)', Array.isArray(bigRes) && ms < 1000, JSON.stringify(bigRes));
  s = start(project(), 'ui-boss');
  t('P8 no agent file -> skills_preloaded is absent from the line (old shape kept)', s.line && !('skills_preloaded' in s.line), JSON.stringify(s.line));
  root = project();
  writeAgent(root, 'test-boss', ['Read', 'Bash'], null);
  s = start(root, 'test-boss');
  t('P9 an agent file without skills: -> skills_preloaded absent too (nothing preloaded)', s.line && !('skills_preloaded' in s.line), JSON.stringify(s.line));
  const srcFile = (r) => path.join(r, '.claude', 'config', 'orchestration', 'FORGE_DEFAULT_SKILLS.json');
  root = project();
  const want = crypto.createHash('sha256').update(fs.readFileSync(srcFile(root))).digest('hex').slice(0, 12);
  s = start(root, 'build-boss');
  t('P10 defaults_sha = first 12 hex of sha256 of the FORGE_DEFAULT_SKILLS.json bytes', s.line && s.line.defaults_sha === want && /^[0-9a-f]{12}$/.test(want), JSON.stringify(s.line));
  t('P11 ... and it is on disk too', fs.readFileSync(s.r.path, 'utf8').includes('"defaults_sha":"' + want + '"'));
  fs.appendFileSync(srcFile(root), ' ');
  const sha2 = start(root, 'build-boss').line.defaults_sha;
  t('P12 one changed byte gives another sha', /^[0-9a-f]{12}$/.test(String(sha2)) && sha2 !== want, sha2);
  const noSrc = project();
  fs.rmSync(srcFile(noSrc));
  s = start(noSrc, 'build-boss');
  t('P13 no FORGE_DEFAULT_SKILLS.json -> defaults_sha absent (null for a reader), old line shape kept', s.line && !('defaults_sha' in s.line), JSON.stringify(s.line));
  const dirSrc = project();
  fs.rmSync(srcFile(dirSrc)); fs.mkdirSync(srcFile(dirSrc));
  s = start(dirSrc, 'build-boss');
  t('P14 unreadable FORGE_DEFAULT_SKILLS.json (a folder) -> defaults_sha absent', s.line && !('defaults_sha' in s.line), JSON.stringify(s.line));

  console.log('\nI) injection = (map ∪ baseline) minus preloaded');
  root = project({ maps: [{ 'build-boss': ['forge-testing', 'forge-game'] }] });
  writeAgent(root, 'build-boss', ['Read', 'Bash', 'Skill'], ['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail']);
  s = start(root, 'build-boss');
  t('I1 no double injection: forge-testing (map + preload) is not listed, forge-game (map only) is',
    listed(s.ctx, 'forge-game') && !listed(s.ctx, 'forge-testing') && !listed(s.ctx, 'forge-debug') && !listed(s.ctx, 'ponytail'), s.ctx);
  s = start(project(), 'ui-boss');
  t('I2 baseline and domain without map: ui-boss (no agent file, no map) gets its baseline forge-craft, forge-ui-polish and its domain forge-website, forge-verify',
    listed(s.ctx, 'forge-craft') && listed(s.ctx, 'forge-ui-polish') && listed(s.ctx, 'forge-website') && listed(s.ctx, 'forge-verify'), s.ctx);
  const DSK = require('./forge-default-skills.cjs');
  const realData = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'config', 'orchestration', 'FORGE_DEFAULT_SKILLS.json'), 'utf8'));
  const known = new Set(BASE_SKILLS);
  const offered = (ctx) => ctx.split('\n').filter((l) => /^- [a-z0-9]/.test(l)).map((l) => l.slice(2, l.indexOf(' (')));
  const offerOk = ['build-boss', 'ui-boss', 'review-boss', 'payment-integration', 'boss'].every((a) => {
    const exp = DSK.preloadFor(a, realData).filter((n) => n !== realData.conduct && known.has(n));
    const got = offered(start(project(), a).ctx);
    return JSON.stringify(got.slice().sort()) === JSON.stringify(exp.slice().sort());
  });
  t('I2b without agent file or map the offered set equals preloadFor minus the conduct skill (shipped skills only)', offerOk);
  s = start(project(), 'forge:ui-boss');
  t('I2c a plugin-scoped type (forge:ui-boss) gets the domain of its bare name too', listed(s.ctx, 'forge-website') && listed(s.ctx, 'forge-verify'), s.ctx);
  root = project();
  writeAgent(root, 'ui-boss', ['Read', 'Bash', 'Skill'], DSK.preloadFor('ui-boss', realData));
  t('I3 everything preloaded and no map -> nothing injected', start(root, 'ui-boss').out === '');
  s = start(project(), 'payment-integration');
  t('I4 a specialist gets its Boss baseline plus its extra (payment-integration: forge-debug, ponytail, forge-security-review)',
    listed(s.ctx, 'forge-debug') && listed(s.ctx, 'ponytail') && listed(s.ctx, 'forge-security-review'), s.ctx);
  s = start(project(), 'some-ecc-agent');
  t('I5 an unknown agent type with no map gets nothing', s.out === '', s.out);
  s = start(project(), 'head-chef');
  t('I6 a planning role still gets its declared baseline (head-chef: forge-quality)', listed(s.ctx, 'forge-quality'), s.ctx);
  const noCfg = project();
  fs.rmSync(path.join(noCfg, '.claude', 'config'), { recursive: true, force: true });
  t('I7 no FORGE_DEFAULT_SKILLS.json (older install) -> no baseline, no throw', start(noCfg, 'ui-boss').out === '');

  console.log('\nF) file-less agents');
  s = start(project(), 'general-purpose');
  t('F1 general-purpose gets the forge-conduct body', s.ctx.includes('## 1. Make the smallest complete change') && s.ctx.includes(CANARY), s.ctx);
  t('F2 ... without its frontmatter', !s.ctx.includes('name: forge-conduct') && !s.ctx.includes('description: "Use when doing any Forge work."'), s.ctx);
  root = project({ maps: [{ 'general-purpose': ['forge-game'] }] });
  s = start(root, 'general-purpose');
  t('F3 ... and its map skills next to it', s.ctx.includes(CANARY) && listed(s.ctx, 'forge-game'), s.ctx);

  console.log('\nW) wording by tool access');
  root = project({ maps: [{ 'verify-boss': ['forge-game'], 'review-boss': ['forge-game'] }] });
  writeAgent(root, 'verify-boss', ['Bash', 'PowerShell', 'Read', 'Grep', 'Glob', 'Skill'], ['forge-conduct', 'forge-verify']);
  writeAgent(root, 'review-boss', ['Read', 'Grep', 'Glob', 'SendMessage'], ['forge-conduct', 'forge-code-review', 'forge-craft']);
  const v = start(root, 'verify-boss'), rv = start(root, 'review-boss');
  t('W1 verify-boss (has Skill) is told to call the Skill tool', /call the Skill tool/.test(v.ctx) && !/Read the SKILL\.md at/.test(v.ctx), v.ctx);
  t('W2 review-boss (no Skill) is told to Read the SKILL.md, never promised the Skill tool', /Read the SKILL\.md at/.test(rv.ctx) && !/Skill tool/.test(rv.ctx), rv.ctx);

  console.log('\nC) context never exceeds 10000 chars');
  t('C0 MAX_CONTEXT_CHARS is exported as 10000', ST.MAX_CONTEXT_CHARS === 10000);
  const longNames = Array.from({ length: 40 }, (_, i) => 'forge-long-skill-name-for-the-context-cap-test-number-' + String(i).padStart(3, '0'));
  root = project({ maps: [{ 'build-boss': longNames, 'general-purpose': longNames }], extraSkills: longNames });
  s = start(root, 'build-boss');
  t('C1 a map of 40 long names stays at most 10000 chars and points to the rest with "+N more"',
    s.ctx.length > 0 && s.ctx.length <= 10000 && /\+\d+ more in .claude\/config\/orchestration\/FORGE_DEFAULT_SKILLS\.json/.test(s.ctx), s.ctx.length + ' ' + s.ctx.slice(-300));
  root = project({ maps: [{ 'general-purpose': longNames }], extraSkills: longNames, conductBody: ('A long conduct rule line.\n').repeat(2000) });
  s = start(root, 'general-purpose', 'STOP / STOP: ' + 'w'.repeat(900));
  t('C2 a 50 KB conduct body + 40 names + the worktree warning still fit in 10000 chars', s.ctx.length > 0 && s.ctx.length <= 10000 && s.ctx.startsWith('STOP / STOP:'), s.ctx.length);
  t('C3 ... and the skill list is still there (not pushed out by the body)', listed(s.ctx, longNames[0]) && /\+\d+ more/.test(s.ctx), s.ctx.slice(-400));
  t('C4 an oversized extra alone is cut to 10000 chars', (() => { const o = ST.hookOutput(null, {}, 'x'.repeat(20000)); try { return JSON.parse(o).hookSpecificOutput.additionalContext.length <= 10000; } catch { return false; } })());

  console.log('\nO) old behaviour kept');
  root = project({ pointer: false, maps: [{ 'build-boss': ['forge-game'] }] });
  s = start(root, 'build-boss');
  t('O1 no run pointer -> no output', s.out === '', s.out);
  t('O2 hookOutput on junk never throws', ST.hookOutput(undefined) === '' && ST.hookOutput({ record: { run: RUN, agent_type: 42 } }, { root: '\0bad' }) === '');
  root = project({ maps: [{ 'build-boss': ['forge-game'] }] });
  const c = spawnSync(process.execPath, [path.join(__dirname, 'forge-subagent-start.cjs')], { input: payload('build-boss'), encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, HOME, USERPROFILE: HOME, FORGE_SUBAGENT_START_HOOK: '', FORGE_RUN_ID: '' }) });
  let cliCtx = '';
  try { cliCtx = JSON.parse(c.stdout).hookSpecificOutput.additionalContext; } catch { cliCtx = ''; }
  t('O3 real CLI: exit 0, one JSON object, forge-game and the build-boss baseline listed', c.status === 0 && listed(cliCtx, 'forge-game') && listed(cliCtx, 'forge-testing'), JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));

  console.log('\nK) conduct canary at SubagentStop');
  const yes = transcript('Done. All green.\n\n' + CANARY);
  const no = transcript('Done. All green.');
  t('K1 canary seen: last assistant text ends with the canary -> true', SM.conductSeenInTranscript(yes) === true);
  t('K2 no canary in the last assistant text -> false (an earlier mention does not count)', SM.conductSeenInTranscript(no) === false);
  t('K3 unreadable / missing file -> null', SM.conductSeenInTranscript(path.join(HOME, 'nope.jsonl')) === null && SM.conductSeenInTranscript(null) === null);
  const sroot = tmp('forge-ssd-stop-'); fs.mkdirSync(path.join(sroot, '.claude'));
  const stopPayload = (f) => JSON.stringify({ session_id: SESSION, agent_id: 'a1b2c3d4', agent_type: 'build-boss', agent_transcript_path: f, last_assistant_message: 'x' });
  const sy = SS.run(stopPayload(yes), { root: sroot, env: {} });
  const sn = SS.run(stopPayload(no), { root: sroot, env: {} });
  const sx = SS.run(stopPayload(path.join(HOME, 'missing.jsonl')), { root: sroot, env: {} });
  t('K4 stop record conduct_seen:true / false from the transcript', sy.record && sy.record.conduct_seen === true && sn.record && sn.record.conduct_seen === false, JSON.stringify([sy.record, sn.record]));
  t('K5 not scanned -> conduct_seen absent', sx.record && !('conduct_seen' in sx.record), JSON.stringify(sx.record));
  t('K6 on disk the canary text itself is never stored, only the boolean', (() => { const d = fs.readFileSync(sy.path, 'utf8'); return d.includes('"conduct_seen":true') && !d.includes(CANARY); })());
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
