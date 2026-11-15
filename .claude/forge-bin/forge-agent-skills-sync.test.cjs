#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-agent-skills-sync.test.cjs — SD-T3. Every case runs on a throwaway temp root (copied agent files, tool
 * policy, default-skills source and the named skills) and a temp --home; the real repo and the real home are only
 * READ. Plain node script: prints `N passed, M failed`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TOOL = path.join(__dirname, 'forge-agent-skills-sync.cjs');
let passed = 0; let failed = 0;
function t(name, cond, detail) {
  if (cond) { passed++; process.stdout.write('  ok  ' + name + '\n'); }
  else { failed++; process.stdout.write('  FAIL ' + name + (detail ? ' — ' + detail : '') + '\n'); }
}

let mod = null;
try { mod = require(TOOL); } catch (e) { mod = null; }
const DS = require('./forge-default-skills.cjs');

const temps = [];
function tmpDir(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fass-' + tag + '-')); temps.push(d); return d; }
function copy(rel, root) {
  const src = path.join(REPO, rel); const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
// The pre-migration shape (before the marked block existed), rebuilt from the current files so the one-time
// migration stays tested after the repo itself has been migrated: the block + its on-demand line become the old
// "Preloaded at startup" paragraph again; a block in its own Core skills section is removed with that section.
const LEGACY_PREFIX = 'Preloaded at startup from the `skills:` frontmatter (the full SKILL.md text is injected): ';
const LEGACY_READ = '. You have no Skill tool, so nothing else loads by itself: when one of these is relevant, Read `.claude/skills/<name>/SKILL.md` (else `~/.claude/skills/<name>/SKILL.md`; if neither exists, say so and go on without it): ';
function toLegacy(text) {
  const re = /<!-- forge-skills:begin -->[\s\S]*?<!-- forge-skills:end -->/;
  const m = re.exec(text);
  if (!m) return text;
  const after = m.index + m[0].length;
  const od = /^\nOn demand, when relevant: (.+)/.exec(text.slice(after));
  if (od) return text.slice(0, m.index) + LEGACY_PREFIX + 'forge-old-a, forge-old-b' + LEGACY_READ + od[1] + text.slice(after + od[0].length);
  return text.replace('## Core skills\n\n' + m[0] + '\n\n', '');
}
function makeRoot(legacy) {
  const root = tmpDir('root');
  copy(path.join('.claude', 'agents'), root);
  copy(path.join('.claude', 'config', 'agents', 'agent-tool-policy.json'), root);
  copy(path.join('.claude', 'config', 'agents', 'agent-skill-map.json'), root);
  copy(DS.SOURCE_REL, root);
  const data = JSON.parse(fs.readFileSync(path.join(REPO, DS.SOURCE_REL), 'utf8'));
  const names = new Set([data.conduct]);
  for (const l of Object.values(data.role_baseline || {})) l.forEach((n) => names.add(n));
  for (const l of Object.values(data.specialist_extra || {})) l.forEach((n) => names.add(n));
  for (const l of Object.values(data.agent_domain || {})) l.forEach((n) => names.add(n));
  for (const m of Object.values(data.moments || {})) names.add(m.skill);
  for (const n of names) copy(path.join('.claude', 'skills', n), root);
  if (legacy) for (const f of fs.readdirSync(path.join(root, '.claude', 'agents'))) {
    const fp = path.join(root, '.claude', 'agents', f);
    fs.writeFileSync(fp, toLegacy(fs.readFileSync(fp, 'utf8')));
  }
  return root;
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const agentFile = (root, name) => path.join(root, '.claude', 'agents', name + '.md');
const read = (f) => fs.readFileSync(f, 'utf8');
function fm(text) { const m = /^---\n([\s\S]*?)\n---\n/.exec(text); return m ? m[1] : ''; }
function body(text) { const m = /^---\n[\s\S]*?\n---\n/.exec(text); return m ? text.slice(m[0].length) : text; }
function toolsOf(text) { const m = /^tools:\s*(.*)$/m.exec(fm(text)); return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null; }
function skillsOf(text) {
  const lines = fm(text).split('\n'); const i = lines.findIndex((l) => /^skills:\s*$/.test(l));
  if (i < 0) return [];
  const out = []; for (let j = i + 1; j < lines.length && /^\s+-\s+/.test(lines[j]); j++) out.push(lines[j].replace(/^\s+-\s+/, '').trim());
  return out;
}
const BEGIN = '<!-- forge-skills:begin -->'; const END = '<!-- forge-skills:end -->';
function blockOf(text) { const i = text.indexOf(BEGIN); const j = text.indexOf(END); return i >= 0 && j > i ? text.slice(i, j + END.length) : null; }
function outside(text) { const b = blockOf(text); return b === null ? text : text.replace(b, '@@BLOCK@@'); }
const mapOf = (root) => JSON.parse(read(path.join(root, '.claude', 'config', 'agents', 'agent-skill-map.json')));
const policyOf = (root) => JSON.parse(read(path.join(root, '.claude', 'config', 'agents', 'agent-tool-policy.json')));

try {
  t('module loads and exports the interface', !!mod && ['planAgentEdits', 'applyAgentEdits', 'isExecClass'].every((k) => typeof mod[k] === 'function'));

  // --- write then check -----------------------------------------------------------------------------------
  const root = makeRoot(true);
  t('legacy fixture has no block left (the migration is really exercised)', fs.readdirSync(path.join(root, '.claude', 'agents')).every((f) => !read(path.join(root, '.claude', 'agents', f)).includes('forge-skills:begin')));
  const bodiesBefore = {};
  for (const f of fs.readdirSync(path.join(root, '.claude', 'agents'))) bodiesBefore[f] = body(read(path.join(root, '.claude', 'agents', f)));
  const policyBefore = policyOf(root);
  const w = run(['--write', '--root', root]);
  t('--write exits 0', w.code === 0, w.out);
  const c = run(['--check', '--root', root]);
  t('write then check is clean (exit 0)', c.code === 0, c.out);

  const data = DS.loadDefaults(root).data;
  const agents = fs.readdirSync(path.join(root, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  t('every agent preloads exactly preloadFor(agent)', agents.length >= 20 && agents.every((a) => JSON.stringify(skillsOf(read(agentFile(root, a)))) === JSON.stringify(DS.preloadFor(a, data))),
    agents.filter((a) => JSON.stringify(skillsOf(read(agentFile(root, a)))) !== JSON.stringify(DS.preloadFor(a, data))).join(','));
  t('build-boss preloads forge-conduct first, its role baseline, then its domain', JSON.stringify(skillsOf(read(agentFile(root, 'build-boss')))) === JSON.stringify(['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail', 'forge-code-review', 'forge-worktrees']));
  t('electron-pro preloads the build-boss baseline but not its domain', JSON.stringify(skillsOf(read(agentFile(root, 'electron-pro')))) === JSON.stringify(['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail']));
  t('payment-integration also preloads forge-security-review', skillsOf(read(agentFile(root, 'payment-integration'))).includes('forge-security-review'));

  // --- Skill tool by class --------------------------------------------------------------------------------
  t('exec gets Skill: build-boss', (toolsOf(read(agentFile(root, 'build-boss'))) || []).includes('Skill'));
  t('exec gets Skill: verify-boss', (toolsOf(read(agentFile(root, 'verify-boss'))) || []).includes('Skill'));
  t('exec gets Skill: scribe (exec-reviewer)', (toolsOf(read(agentFile(root, 'scribe'))) || []).includes('Skill'));
  const ro = ['review-boss', 'security-boss', 'boss', 'docs-boss', 'head-chef', 'skill-boss', 'seo-boss', 'search-boss'];
  t('read-only never gets Skill (agent files)', ro.every((a) => !(toolsOf(read(agentFile(root, a))) || []).includes('Skill')), ro.filter((a) => (toolsOf(read(agentFile(root, a))) || []).includes('Skill')).join(','));
  const pol = policyOf(root);
  t('policy: read-only-audit and write-no-exec forbid Skill', pol.classes['read-only-audit'].forbidden.includes('Skill') && pol.classes['write-no-exec'].forbidden.includes('Skill'));
  t('policy: full-build and exec-reviewer class tools include Skill', pol.classes['full-build'].tools.includes('Skill') && pol.classes['exec-reviewer'].tools.includes('Skill'));
  t('policy: every exec-class agent row has Skill, no other row has it',
    Object.entries(pol.agents).every(([, e]) => (['full-build', 'exec-reviewer'].includes(e.class)) === e.tools.includes('Skill')));
  t('policy: every agent row equals its agent file tools', agents.every((a) => JSON.stringify(pol.agents[a] && pol.agents[a].tools) === JSON.stringify(toolsOf(read(agentFile(root, a))))));
  t('policy: nothing else changed (rationale, classes, model)', Object.keys(policyBefore.agents).every((a) => pol.agents[a].class === policyBefore.agents[a].class && pol.agents[a].rationale === policyBefore.agents[a].rationale && pol.agents[a].model === policyBefore.agents[a].model) && pol._doc === policyBefore._doc);
  t('isExecClass: full-build and exec-reviewer only', mod.isExecClass('build-boss', pol) && mod.isExecClass('verify-boss', pol) && !mod.isExecClass('review-boss', pol) && !mod.isExecClass('boss', pol) && !mod.isExecClass('nobody', pol) && !mod.isExecClass('build-boss', null));

  // --- body and other keys untouched ----------------------------------------------------------------------
  // --- the generated body block -----------------------------------------------------------------------------
  const blockProblems = agents.filter((a) => {
    const txt = read(agentFile(root, a)); const b = blockOf(txt);
    return !b || txt.split(BEGIN).length !== 2 || txt.split(END).length !== 2 || !b.includes(DS.preloadFor(a, data).join(', ') + '.') || !/forge-agent-skills-sync\.cjs/.test(b) || !/FORGE_DEFAULT_SKILLS\.json/.test(b);
  });
  t('every body holds exactly one generated block naming its preloads and its generator', blockProblems.length === 0, blockProblems.join(','));
  t('the stale "Preloaded at startup ... (the full SKILL.md text is injected)" paragraph is gone', agents.every((a) => !read(agentFile(root, a)).includes('(the full SKILL.md text is injected)')));
  const bb = read(agentFile(root, 'build-boss'));
  // The expected line is read from the real build-boss.md (2026-11-13: its list drops the unshipped
  // code-review-excellence in the agent-file lane; a pinned literal would break on that edit).
  const odReal = /^On demand, when relevant: .+$/m.exec(read(path.join(REPO, '.claude', 'agents', 'build-boss.md')));
  t('migration keeps the on-demand list word for word, right after the block',
    !!odReal && odReal[0].includes('test-driven-development') && bb.includes(END + '\n' + odReal[0] + '\n'), odReal && odReal[0]);
  // Read from the real ui-boss.md as well (2026-11-13: FIX-TUNE-B renamed design-is to claude-mem:design-is and
  // dropped the switched-off browser skill; a pinned literal broke on that agent-file edit).
  const odUi = /^On demand, when relevant: .+$/m.exec(read(path.join(REPO, '.claude', 'agents', 'ui-boss.md')));
  t('migration keeps per-agent notes (ui-boss)', !!odUi && odUi[0].includes('forge-ui-polish') && read(agentFile(root, 'ui-boss')).includes(odUi[0]), odUi && odUi[0]);
  const staleBefore = bodiesBefore['build-boss.md'];
  const staleLine = /^Preloaded at startup from the `skills:` frontmatter.*$/m.exec(staleBefore)[0];
  const odLine = '\nOn demand, when relevant: ' + /say so and go on without it\): (.+)$/.exec(staleLine)[1];
  t('migration replaces only the stale paragraph (build-boss)', outside(body(bb)).replace('@@BLOCK@@' + odLine, '@@X@@') === staleBefore.replace(staleLine, '@@X@@'));
  const vb = body(read(agentFile(root, 'verify-boss')));
  t('a body without the paragraph gets one Core skills section, nothing else changes (verify-boss)',
    blockOf(vb) !== null && vb.replace('## Core skills\n\n' + blockOf(vb) + '\n\n', '') === bodiesBefore['verify-boss.md']);
  t('exec agent block says it has the Skill tool', ['build-boss', 'verify-boss', 'scribe'].every((a) => /You have the Skill tool: call it by name/.test(blockOf(read(agentFile(root, a))))));
  t('read-only and write-no-exec blocks say they have none', ro.every((a) => /You have no Skill tool: when another skill fits, Read/.test(blockOf(read(agentFile(root, a)))) && !/You have the Skill tool/.test(read(agentFile(root, a)))));
  const origBuild = fm(read(path.join(REPO, '.claude', 'agents', 'build-boss.md'))).split('\n').filter((l) => !/^(tools|skills):/.test(l) && !/^\s+-\s+/.test(l));
  const newBuild = fm(read(agentFile(root, 'build-boss'))).split('\n').filter((l) => !/^(tools|skills):/.test(l) && !/^\s+-\s+/.test(l));
  t('other frontmatter keys untouched (order and bytes)', JSON.stringify(origBuild) === JSON.stringify(newBuild));
  t('files stay LF', agents.every((a) => !read(agentFile(root, a)).includes('\r')));

  // --- idempotent -----------------------------------------------------------------------------------------
  const snap = agents.map((a) => read(agentFile(root, a))).join('\0') + read(path.join(root, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
  const w2 = run(['--write', '--root', root, '--json']);
  let j2 = null; try { j2 = JSON.parse(w2.out); } catch (e) { j2 = null; }
  const snap2 = agents.map((a) => read(agentFile(root, a))).join('\0') + read(path.join(root, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
  t('idempotent: a second --write changes nothing', w2.code === 0 && snap === snap2 && !!j2 && Array.isArray(j2.written) && j2.written.length === 0, w2.out.slice(0, 300));

  // --- pure plan ------------------------------------------------------------------------------------------
  const plan = mod.planAgentEdits(root, data, pol);
  t('planAgentEdits returns one entry per agent with the documented fields', Array.isArray(plan) && plan.length === agents.length && plan.every((p) => ['file', 'agent', 'skillsBefore', 'skillsAfter', 'toolsBefore', 'toolsAfter'].every((k) => k in p) && typeof p.bodyChanged === 'boolean' && typeof p.changed === 'boolean' && p.changed === false && p.bodyChanged === false));

  // --- drift ----------------------------------------------------------------------------------------------
  const rb = agentFile(root, 'review-boss');
  fs.writeFileSync(rb, read(rb).replace(/\n  - forge-craft\n/, '\n'));
  const d = run(['--check', '--root', root]);
  t('hand edit is drift: --check exits 1 and names the file', d.code === 1 && /review-boss\.md/.test(d.out), 'code=' + d.code + ' ' + d.out.slice(0, 300));
  const rb2 = agentFile(root, 'docs-boss');
  fs.writeFileSync(rb2, read(rb2).replace(/^tools: (.*)$/m, 'tools: $1, Skill'));
  const d2 = run(['--check', '--root', root, '--json']);
  let jd = null; try { jd = JSON.parse(d2.out); } catch (e) { jd = null; }
  t('Skill hand-added to a write-no-exec agent is drift', d2.code === 1 && !!jd && jd.drift.some((x) => /docs-boss\.md/.test(x.file)), d2.out.slice(0, 300));
  run(['--write', '--root', root]);
  t('--write removes Skill from a non-exec agent again', !(toolsOf(read(rb2)) || []).includes('Skill') && run(['--check', '--root', root]).code === 0);
  const pf = path.join(root, '.claude', 'config', 'agents', 'agent-tool-policy.json');
  const pj = policyOf(root); pj.classes['write-no-exec'].forbidden = pj.classes['write-no-exec'].forbidden.filter((x) => x !== 'Skill');
  fs.writeFileSync(pf, JSON.stringify(pj, null, 2) + '\n');
  t('policy drift: --check exits 1 and names agent-tool-policy.json', (() => { const r = run(['--check', '--root', root]); return r.code === 1 && /agent-tool-policy\.json/.test(r.out); })());

  run(['--write', '--root', root]);
  // --- marked block drift and outside-byte-identity --------------------------------------------------------
  const tb = agentFile(root, 'test-boss');
  const tbText = read(tb);
  fs.writeFileSync(tb, tbText.replace(/(<!-- forge-skills:begin -->[\s\S]*?)forge-verify/, '$1forge-hand-edited'));
  const he = run(['--check', '--root', root, '--json']);
  let jh = null; try { jh = JSON.parse(he.out); } catch (e) { jh = null; }
  t('a hand edit inside the markers is drift (exit 1, names the file)', he.code === 1 && !!jh && jh.drift.some((x) => /test-boss\.md/.test(x.file) && x.body === true), he.out.slice(0, 300));
  const pe = mod.planAgentEdits(root, data, policyOf(root)).find((p) => p.agent === 'test-boss');
  t('plan: bodyChanged and changed are true for the hand-edited block only', !!pe && pe.bodyChanged === true && pe.changed === true && JSON.stringify(pe.skillsBefore) === JSON.stringify(pe.skillsAfter));
  const db = agentFile(root, 'docs-boss');
  fs.writeFileSync(db, read(db) + '\nA hand-kept closing line outside the markers.\n');
  fs.writeFileSync(rb, read(rb).replace(/\n  - forge-craft\n/, '\n'));
  const outsideBefore = {}; for (const a of agents) outsideBefore[a] = outside(read(agentFile(root, a)));
  run(['--write', '--root', root]);
  t('text outside the markers is byte-identical after --write', agents.every((a) => outside(read(agentFile(root, a))) === outsideBefore[a] || a === 'review-boss'),
    agents.filter((a) => a !== 'review-boss' && outside(read(agentFile(root, a))) !== outsideBefore[a]).join(','));
  t('review-boss: only the skills lines changed outside the block', outside(read(rb)).replace(/\n  - forge-craft\n/, '\n') === outsideBefore['review-boss']);
  t('the hand edit inside the markers is regenerated', read(tb) === tbText && run(['--check', '--root', root]).code === 0);

  // --- CRLF ---------------------------------------------------------------------------------------------------
  const crRoot = makeRoot(); run(['--write', '--root', crRoot]);
  const cf = agentFile(crRoot, 'search-boss');
  const lfText = read(cf);
  fs.writeFileSync(cf, lfText.replace(/\n/g, '\r\n'));
  const crCheck = run(['--check', '--root', crRoot]);
  t('CRLF: an in-sync CRLF agent file is parsed correctly (no drift)', crCheck.code === 0, crCheck.out.slice(0, 300));
  fs.writeFileSync(cf, lfText.replace(/\n  - forge-scout\n/, '\n').replace(/\n/g, '\r\n'));
  run(['--write', '--root', crRoot]);
  const crAfter = read(cf);
  t('CRLF: --write keeps CRLF line endings and restores the skills', !/[^\r]\n/.test(crAfter) && crAfter.replace(/\r\n/g, '\n') === lfText);

  // --- agent-skill-map.json ---------------------------------------------------------------------------------
  const mf = path.join(root, '.claude', 'config', 'agents', 'agent-skill-map.json');
  const m0 = mapOf(root);
  t('skill map lists every preload for every agent after --write', agents.every((a) => DS.preloadFor(a, data).every((s) => Array.isArray(m0.agents[a]) && m0.agents[a].includes(s))));
  const mOrig = JSON.parse(read(path.join(REPO, '.claude', 'config', 'agents', 'agent-skill-map.json')));
  t('skill map: existing names are never dropped', Object.entries(mOrig.agents).every(([a, l]) => l.every((s) => m0.agents[a].includes(s))) && JSON.stringify(m0.invocationNotes) === JSON.stringify(mOrig.invocationNotes));
  const m1 = mapOf(root); m1.agents['build-boss'] = m1.agents['build-boss'].filter((s) => s !== 'ponytail');
  fs.writeFileSync(mf, JSON.stringify(m1, null, 4) + '\n');
  const mc = run(['--check', '--root', root]);
  t('a skill map missing a preload is drift (exit 1, names the map)', mc.code === 1 && /agent-skill-map\.json/.test(mc.out), mc.out.slice(0, 300));
  run(['--write', '--root', root]);
  t('--write adds the missing preload back to the map', mapOf(root).agents['build-boss'].includes('ponytail') && run(['--check', '--root', root]).code === 0);

  // --- usage and load errors ------------------------------------------------------------------------------
  t('usage error: no mode exits 2', run(['--root', root]).code === 2);
  t('usage error: both modes exits 2', run(['--check', '--write', '--root', root]).code === 2);
  const empty = tmpDir('empty');
  t('load error: a root without the source exits 2', run(['--check', '--root', empty]).code === 2);

  // --- global into a temp home ----------------------------------------------------------------------------
  const groot = makeRoot(); run(['--write', '--root', groot]);
  const home = tmpDir('home');
  const gdir = path.join(home, '.claude', 'agents'); fs.mkdirSync(gdir, { recursive: true });
  const goat = {
    triage: '---\nname: triage\ndescription: t\ntools: Read, Grep, Glob\nmodel: sonnet\neffort: low\nmemory: project\n---\n\nTriage body.\n',
    quick: '---\nname: quick\ndescription: q\nmodel: sonnet\neffort: low\n---\n\nQuick body.\n',
    build: '---\nname: build\ndescription: b\nmodel: opus\neffort: medium\n---\n\nBuild body.\n',
    deep: '---\nname: deep\ndescription: d\nmodel: opus\neffort: xhigh\n---\n\nDeep body.\n',
    verifier: '---\nname: verifier\ndescription: v\ntools: Read, Grep, Glob, Bash, PowerShell\nmodel: sonnet\neffort: medium\n---\n\nVerifier body.\n',
  }; // escalate deliberately absent
  for (const [n, txt] of Object.entries(goat)) fs.writeFileSync(path.join(gdir, n + '.md'), txt);
  const g = run(['--write', '--global', '--home', home, '--root', groot, '--json']);
  let jg = null; try { jg = JSON.parse(g.out); } catch (e) { jg = null; }
  t('global into temp home: exit 0', g.code === 0, g.out.slice(0, 400));
  t('global: every present GOAT file preloads forge-conduct', Object.keys(goat).every((n) => skillsOf(read(path.join(gdir, n + '.md')))[0] === 'forge-conduct'));
  t('global: the missing escalate is SKIP and never created', !fs.existsSync(path.join(gdir, 'escalate.md')) && !!jg && jg.global && jg.global.skipped.includes('escalate'));
  t('global: verifier (explicit tools with Bash) gets Skill', (toolsOf(read(path.join(gdir, 'verifier.md'))) || []).includes('Skill'));
  t('global: triage (no Bash) does not get Skill', !(toolsOf(read(path.join(gdir, 'triage.md'))) || []).includes('Skill'));
  t('global: quick keeps no tools line (inherits every tool)', toolsOf(read(path.join(gdir, 'quick.md'))) === null);
  t('global: bodies untouched', Object.entries(goat).every(([n, txt]) => body(read(path.join(gdir, n + '.md'))) === body(txt)));
  const conductCopy = path.join(home, '.claude', 'skills', 'forge-conduct', 'SKILL.md');
  t('global: forge-conduct copied byte-identical', fs.existsSync(conductCopy) && read(conductCopy) === read(path.join(groot, '.claude', 'skills', 'forge-conduct', 'SKILL.md')));
  t('global: --check after --write is clean', run(['--check', '--global', '--home', home, '--root', groot]).code === 0);
  fs.appendFileSync(conductCopy, 'stale line\n');
  const gc = run(['--check', '--global', '--home', home, '--root', groot]);
  t('global: a stale conduct copy is drift', gc.code === 1 && /forge-conduct/.test(gc.out), gc.out.slice(0, 300));
  const crHome = tmpDir('crhome'); const crg = path.join(crHome, '.claude', 'agents'); fs.mkdirSync(crg, { recursive: true });
  fs.writeFileSync(path.join(crg, 'verifier.md'), goat.verifier.replace(/\n/g, '\r\n'));
  run(['--write', '--global', '--home', crHome, '--root', groot]);
  const gv = read(path.join(crg, 'verifier.md'));
  t('global CRLF: parsed, conduct preloaded, CRLF kept, body untouched', !/[^\r]\n/.test(gv) && skillsOf(gv.replace(/\r\n/g, '\n'))[0] === 'forge-conduct' && body(gv.replace(/\r\n/g, '\n')) === body(goat.verifier) && !gv.includes(BEGIN));
  t('global: never touches the project agents dir of the home when absent', !fs.existsSync(path.join(home, '.claude', 'config')));
} catch (e) {
  failed++; process.stdout.write('  FAIL unexpected throw — ' + (e && e.stack || e) + '\n');
} finally {
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* temp cleanup is best effort */ } }
}

process.stdout.write(passed + ' passed, ' + failed + ' failed\n');
process.exitCode = failed ? 1 : 0;
