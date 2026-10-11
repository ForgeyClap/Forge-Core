#!/usr/bin/env node
'use strict';
/**
 * forge-adopt-post-sync.test.cjs — hermetic tests for forge-adopt-post-sync.cjs. Every fixture lives under
 * os.tmpdir() (fs.mkdtempSync); no real project, no real template, no network. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const A = require('./forge-adopt-post-sync.cjs');

const BIN = __dirname;
const CLI = path.join(BIN, 'forge-adopt-post-sync.cjs');
const CLAUDE_SRC = path.resolve(BIN, '..');
let pass = 0, fail = 0;
const t = (name, cond, info) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (info ? ' :: ' + String(info).slice(0, 600) : '')); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TMP = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-' + p + '-')); TMP.push(d); return d; };
const write = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const cli = (args, opts) => spawnSync(process.execPath, [CLI].concat(args), Object.assign({ encoding: 'utf8' }, opts || {}));
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e instanceof A.AdoptError && (code == null || e.exitCode === code); } };

const POLICY = JSON.parse(fs.readFileSync(path.join(CLAUDE_SRC, 'config', 'agents', 'agent-tool-policy.json'), 'utf8'));
const SCRIBE_FILES = ['forge-scribe.cjs', 'forge-scribe-store.cjs', 'forge-scribe-classify.cjs', 'forge-store.cjs', 'forge-secret-scrub.cjs'];

/** project(): a small synced-looking Forge project with memory, a project-own agent, notes, receipts and a scribe. */
function project(opts) {
  const o = opts || {};
  const root = tmp('proj');
  write(root, '.claude/config/agents/agent-tool-policy.json', JSON.stringify({ classes: POLICY.classes, agents: { 'build-boss': POLICY.agents['build-boss'] } }, null, 2));
  write(root, '.claude/agents/build-boss.md', '---\nname: build-boss\ntools: Read, Write, Edit, Bash, PowerShell, Grep, Glob\nmodel: opus\n---\nx\n');
  write(root, '.claude/agents/idea-reviewer.md', '---\nname: idea-reviewer\ndescription: reviewer\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nbody\n');
  write(root, '.claude/agents/scripter.md', '---\nname: scripter\ntools: Read, Bash\nmodel: sonnet\n---\nbody\n');
  write(root, '.claude/agents/no-tools.md', '---\nname: no-tools\nmodel: sonnet\n---\nbody\n');
  write(root, '.claude/agents/odd.md', '---\nname: odd\ntools: Read\nforge_class: super-admin\n---\nbody\n');
  write(root, '.claude/FORGE_MEMORY.md', '# Geheugen\n\n- regel één\n- regel twee\n');
  write(root, '.claude/FORGE_TASK_HISTORY.md', '# Historie\n\n| Datum | Taak | Status |\n|---|---|---|\n| 2026-10-01 | Privacy-baseline | afgerond |\n| 2026-10-05 | Defender-uitzondering onderzoeken | open |\n\n- TODO: logboek exporteren naar docs\n- TODO klein\n');
  write(root, '.claude/agent-memory/idea-reviewer/MEMORY.md', '- les 1\n');
  write(root, 'tasks/RESUME-2026-10-09.md', '# Resume-notitie\n\n## Gedaan\n- [x] telemetrie getest\n- energieplan toegevoegd\n\n## Open punten\n- [ ] Defender-uitzondering testen op build 26200\n- Rollback-script voor de taakplanner schrijven\n- driver-check (klaar)\n\n## Achtergrond\n- dit is context, geen taak\n');
  write(root, 'scripts/tweak.ps1', 'Write-Host "app code"\n');
  write(root, '.env', 'TOKEN=FAKE-TEST-VALUE\n');
  // receipts: a pre-evidence one, a current one (has ruleset-pinned.json), and one written later
  write(root, '.claude/forge-runs/run-old/run-finalized.json', JSON.stringify({ schema: 2, run_id: 'run-old', digest: 'a'.repeat(64), bytes: 10, contract: 'ok', ruleset_sha256: 'b'.repeat(64), finalized_at: '2026-08-07T00:00:00Z' }));
  write(root, '.claude/forge-runs/run-old/events.jsonl', '{"event_type":"run_started"}\n');
  write(root, '.claude/forge-runs/run-new/run-finalized.json', JSON.stringify({ schema: 2, run_id: 'run-new', digest: 'c'.repeat(64), bytes: 10, contract: 'ok', ruleset_sha256: 'd'.repeat(64), evidence_digest: 'e'.repeat(64), code_commit: 'f'.repeat(40), independent_verification: {} }));
  write(root, '.claude/forge-runs/run-new/ruleset-pinned.json', '{}');
  write(root, '.claude/forge-runs/run-pinless/run-finalized.json', JSON.stringify({ schema: 2, run_id: 'run-pinless', digest: '1'.repeat(64), bytes: 10, contract: 'ok', ruleset_sha256: '2'.repeat(64), evidence_digest: '3'.repeat(64), code_commit: '4'.repeat(40), independent_verification: {}, finalized_at: '2026-09-01T00:00:00Z' }));
  write(root, '.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node old-gate.cjs' }] }] }, permissions: { deny: ['Bash(rm -rf:*)'] } }, null, 2));
  if (o.scribe !== false) {
    for (const f of SCRIBE_FILES) fs.copyFileSync(path.join(BIN, f), path.join(fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true }) || path.join(root, '.claude', 'forge-bin'), f));
    write(root, '.claude/config/orchestration/FORGE_SCRIBE.json', fs.readFileSync(path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_SCRIBE.json'), 'utf8'));
  }
  return root;
}
const outDir = tmp('out');
let seq = 0;
const outFile = (n) => path.join(outDir, (++seq) + '-' + n);

console.log('forge-adopt-post-sync hermetic tests (os.tmpdir() fixtures only)');

// ---------------------------------------------------------------- 1. summarizeDoctor / compareDoctor
{
  const d = A.summarizeDoctor({ ok: false, checks: { node_check: { ok: true }, leak_scan: { ok: false }, tests: { ok: false, suites: 3, passed: 9, failed: 1, suitesFailed: 1, suitesBlocked: 1, perSuite: [{ suite: 'a.test.cjs', ok: true }, { suite: 'b.test.cjs', ok: false, failures: ['secret text'] }, { suite: 'c.test.cjs', ok: false, timedOut: true }] } } }, { exitCode: 1, durationMs: 5 });
  t('1a: summarizeDoctor keeps names + counts, red checks and red/blocked suites', d.redChecks.join() === 'leak_scan,tests' && d.suites['a.test.cjs'] === 'green' && d.suites['b.test.cjs'] === 'red' && d.suites['c.test.cjs'] === 'blocked' && d.tests.passed === 9, JSON.stringify(d));
  t('1b: summarizeDoctor never carries failure text', !JSON.stringify(d).includes('secret text'));
  const mk = (suites, checks) => ({ state: 'ok', ok: false, checks, suites, redSuites: Object.keys(suites).filter((k) => suites[k] !== 'green'), redChecks: Object.keys(checks).filter((k) => !checks[k]) });
  const before = mk({ 'a.test.cjs': 'green', 'b.test.cjs': 'red', 'gone.test.cjs': 'green' }, { tests: false, agents: false, chain: true });
  let v = [], n = [];
  A.compareDoctor(before, mk({ 'a.test.cjs': 'green', 'b.test.cjs': 'red' }, { tests: false, agents: false, chain: true }), v, n);
  t('1c: the same red set is parity (already red is not a regression)', v.length === 0, JSON.stringify(v));
  t('1d: a suite that no longer runs is a note, not a violation', n.some((x) => /gone\.test\.cjs/.test(x)));
  v = []; n = [];
  A.compareDoctor(before, mk({ 'a.test.cjs': 'red', 'b.test.cjs': 'red', 'new.test.cjs': 'red' }, { tests: false, agents: false, chain: true, fresh: false }), v, n);
  t('1e: green->red, a new red suite and a new red check are each a violation', v.length === 3 && v.some((x) => /a\.test\.cjs was green/.test(x)) && v.some((x) => /new\.test\.cjs/.test(x)) && v.some((x) => /"fresh" is new and red/.test(x)), JSON.stringify(v));
  v = []; n = [];
  A.compareDoctor(before, mk({ 'a.test.cjs': 'green', 'b.test.cjs': 'green' }, { tests: true, agents: true }), v, n);
  t('1f: a green check that disappears is a violation; red->green is a note', v.length === 1 && /"chain" was green/.test(v[0]) && n.some((x) => /red before, green now: b\.test\.cjs/.test(x)), JSON.stringify(v) + JSON.stringify(n));
  v = [];
  A.compareDoctor(before, { state: 'timeout', reason: 'slow' }, v, []);
  t('1g: an unmeasurable post-sync doctor is a violation', v.length === 1 && /could not be measured/.test(v[0]));
}

// ---------------------------------------------------------------- 2. compareHooks
{
  const b = { hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'node old-gate.cjs' }], deny: ['x'] };
  const a = { hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'node new-gate.cjs' }, { event: 'Stop', matcher: null, command: 'node stop.cjs' }], deny: ['x', 'y'] };
  const plan = { settings: { hooksAdded: [{ event: 'Stop', command: 'node stop.cjs' }], hooksChanged: [{ kind: 'command-upgrade', event: 'PreToolUse', matcher: 'Bash', from: 'node old-gate.cjs', to: 'node new-gate.cjs' }], denyAdded: ['y'] } };
  let v = [];
  A.compareHooks(b, a, plan, v, []);
  t('2a: the announced delta (add + command upgrade + deny) is parity', v.length === 0, JSON.stringify(v));
  v = [];
  A.compareHooks(b, { hooks: a.hooks.concat([{ event: 'UserPromptSubmit', matcher: null, command: 'node sneaky.cjs' }]), deny: a.deny.concat(['z']) }, plan, v, []);
  t('2b: an unannounced hook and deny rule are violations', v.length === 2 && v.some((x) => /sneaky/.test(x)) && v.some((x) => /deny rule added.*z/.test(x)), JSON.stringify(v));
  v = [];
  A.compareHooks(b, a, null, v, []);
  t('2c: without a plan any settings change cannot be proven -> violation', v.length === 1 && /no --plan/.test(v[0]));
  v = [];
  A.compareHooks(b, { hooks: [], deny: [] }, plan, v, []);
  t('2d: a removed hook/deny rule nobody announced is a violation', v.some((x) => /removed by the sync: x/.test(x)) && v.some((x) => /announced is not active/.test(x)), JSON.stringify(v));
}

// ---------------------------------------------------------------- 3. inferClass / openLines / receiptGeneration
{
  const c = POLICY.classes;
  t('3a: read-only tools -> read-only-audit', A.inferClass(c, ['Read', 'Grep', 'Glob']).cls === 'read-only-audit');
  t('3b: write without exec -> write-no-exec', A.inferClass(c, ['Read', 'Write', 'Edit']).cls === 'write-no-exec');
  t('3c: exec without write -> exec-reviewer', A.inferClass(c, ['Read', 'Bash']).cls === 'exec-reviewer');
  t('3d: write + exec -> full-build', A.inferClass(c, ['Read', 'Write', 'Bash']).cls === 'full-build');
  t('3e: two equally strict fits -> no guess', A.inferClass({ x: { forbidden: ['A'] }, y: { forbidden: ['B'] } }, ['C']).cls === null);
  const res = A.openLines('# Resume\n## Gedaan\n- [x] klaar ding\n- iets gedaan\n## Open punten\n- [ ] eerste open taak\n- tweede open taak\n- derde (afgerond)\n### Achtergrond\n- context regel hier\n## Volgende stappen\n1. stap één uitvoeren\n', 'tasks/R.md', 'resume');
  t('3f: resume note: unchecked boxes + items under open/next headings; done and context excluded', JSON.stringify(res.map((x) => x.text)) === JSON.stringify(['eerste open taak', 'tweede open taak', 'stap één uitvoeren']), JSON.stringify(res));
  t('3g: every item names its file:line', res.every((x) => /^tasks\/R\.md:\d+$/.test(x.source)) && res[0].source === 'tasks/R.md:6');
  const hist = A.openLines('| a | Defender onderzoeken | open |\n|---|---|---|\n| b | klaar ding | afgerond |\n- TODO: export maken\n- gewone regel\n', 'H.md', 'history');
  t('3h: history: TODO/open rows and items only', hist.length === 2 && /Defender/.test(hist[0].text) && /export/.test(hist[1].text), JSON.stringify(hist));
  const dir = tmp('rg');
  const g = (o) => A.receiptGeneration(Buffer.from(JSON.stringify(o)), 'r1', dir);
  t('3i: schema-2 receipt without evidence/code/IV -> pre-evidence', g({ schema: 2, run_id: 'r1', ruleset_sha256: 'a'.repeat(64) }).generation === 'pre-evidence');
  t('3j: evidence-bearing without ruleset-pinned.json -> pre-pinned-ruleset', g({ schema: 2, run_id: 'r1', ruleset_sha256: 'a'.repeat(64), evidence_digest: 'b'.repeat(64) }).generation === 'pre-pinned-ruleset');
  fs.writeFileSync(path.join(dir, 'ruleset-pinned.json'), '{}');
  t('3k: a current receipt (pinned rules present) is never allowlisted', !!g({ schema: 2, run_id: 'r1', ruleset_sha256: 'a'.repeat(64), evidence_digest: 'b'.repeat(64) }).skip);
  t('3l: schema 1 / wrong run id are skipped', !!g({ schema: 1, run_id: 'r1' }).skip && !!g({ schema: 2, run_id: 'other' }).skip);
}

// ---------------------------------------------------------------- 4. baseline
{
  const p = project({ scribe: false });
  t('4a: baseline refuses --out inside the project', throwsCode(() => A.baseline({ project: p, out: path.join(p, 'b.json') }), 2));
  const out = outFile('baseline.json');
  const r = A.baseline({ project: p, out });
  const b = JSON.parse(fs.readFileSync(out, 'utf8'));
  t('4b: no doctor in the project -> doctor "none" (recorded, not invented)', b.doctor.state === 'none');
  t('4c: hooks, deny rules, agents and receipts are recorded', b.hooks.hooks.length === 1 && b.hooks.deny.length === 1 && b.agents.length === 5 && b.receipts.length === 3, JSON.stringify({ h: b.hooks, a: b.agents.length, r: b.receipts.length }));
  t('4d: .env is recorded by size + mtime only (content never read)', b.files['.env'] && b.files['.env'].meta === true && !b.files['.env'].sha256);
  t('4e: memory, notes and app code are in the file map', !!b.files['.claude/FORGE_MEMORY.md'] && !!b.files['tasks/RESUME-2026-10-09.md'] && !!b.files['scripts/tweak.ps1']);
  t('4f: baseline wrote nothing inside the project', !fs.readdirSync(path.join(p, '.claude')).some((n) => /baseline/.test(n)) && r.ok);
  const dj = outFile('doctor.json');
  fs.writeFileSync(dj, JSON.stringify({ ok: true, checks: { node_check: { ok: true }, tests: { ok: true, suites: 1, passed: 3, failed: 0, perSuite: [{ suite: 'x.test.cjs', ok: true }] } } }));
  const b2 = A.baseline({ project: p, out: outFile('b2.json'), doctorJson: dj }).baseline;
  t('4g: --doctor-json reuses a recorded doctor report', b2.doctor.state === 'ok' && b2.doctor.suites['x.test.cjs'] === 'green' && b2.doctor.source === path.resolve(dj));
  const c = cli(['baseline', '--project', p, '--out', outFile('b3.json'), '--json']);
  let cj = null; try { cj = JSON.parse(c.stdout); } catch { cj = null; }
  t('4h: CLI baseline --json exits 0', c.status === 0 && cj && cj.ok === true && cj.receipts === 3, c.stdout + c.stderr);
}

// ---------------------------------------------------------------- 5. parity end-to-end (stub verify-protect)
{
  const p = project({ scribe: false });
  const dj = outFile('doctor-pre.json');
  fs.writeFileSync(dj, JSON.stringify({ ok: false, checks: { agents: { ok: false }, tests: { ok: false, suites: 2, passed: 5, failed: 1, perSuite: [{ suite: 'a.test.cjs', ok: true }, { suite: 'agents.test.cjs', ok: false }] } } }));
  const bf = outFile('baseline.json');
  A.baseline({ project: p, out: bf, doctorJson: dj });
  // simulate a sync: one planned update, one seed creation, bookkeeping, settings with the announced hook
  write(p, '.claude/forge-bin/forge-tool.cjs', 'updated\n');
  write(p, '.claude/skills/x/learnings.md', 'seed\n');
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'b1', filesChanged: [{ rel: 'forge-bin/forge-tool.cjs' }] }));
  write(p, '.claude/FORGE_VERSION.json', '{}');
  write(p, '.claude/forge-sync-report-b1.md', '# report\n');
  write(p, '.claude/forge-backups/b1/manifest.json', '{}');
  const s = JSON.parse(read(p, '.claude/settings.json'));
  s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node stop.cjs' }] }];
  write(p, '.claude/settings.json', JSON.stringify(s));
  const plan = outFile('plan.json');
  fs.writeFileSync(plan, JSON.stringify({ files: [{ rel: 'forge-bin/forge-tool.cjs', action: 'add' }, { rel: 'skills/x/learnings.md', action: 'seed-created' }], settings: { hooksAdded: [{ event: 'Stop', command: 'node stop.cjs' }], hooksChanged: [], denyAdded: [] }, scaffold: {}, migrations: {} }));
  const stubOk = write(outDir, 'stub-ok.cjs', 'console.log(JSON.stringify({ok:true,checked:42,allowed:[],changed:[],added:[],removed:[]}));\n');
  const pm = write(outDir, 'pm.json', '{}');
  const dj2 = outFile('doctor-post.json');
  fs.writeFileSync(dj2, JSON.stringify({ ok: false, checks: { agents: { ok: false }, tests: { ok: false, suites: 3, passed: 9, failed: 1, perSuite: [{ suite: 'a.test.cjs', ok: true }, { suite: 'agents.test.cjs', ok: false }, { suite: 'new.test.cjs', ok: true }] } } }));
  const rep = outFile('parity.md');
  const r = A.parity({ project: p, baseline: bf, out: rep, plan, protectManifest: pm, forgeSync: stubOk, doctorJson: dj2 });
  t('5a: a sync that only did what the plan announced is PASS', r.ok && r.verdict === 'PASS', JSON.stringify(r.violations));
  t('5b: the report is plain language and names the verdict', /# Parity gate after the Forge sync — PASS/.test(fs.readFileSync(rep, 'utf8')));
  write(p, '.claude/agent-memory/idea-reviewer/MEMORY.md', '- les 1\n- door de sync geschreven!\n');
  write(p, 'scripts/tweak.ps1', 'changed app code\n');
  const stubBad = write(outDir, 'stub-bad.cjs', 'console.log(JSON.stringify({ok:false,checked:42,allowed:[],changed:[{key:".claude/agent-memory/idea-reviewer/MEMORY.md"}],added:[],removed:[]}));process.exitCode=1;\n');
  const r2 = A.parity({ project: p, baseline: bf, out: outFile('parity2.md'), plan, protectManifest: pm, forgeSync: stubBad, doctorJson: dj2 });
  t('5c: a memory change and an app-code change make it FAIL, each named', !r2.ok && r2.violations.some((x) => /agent-memory\/idea-reviewer\/MEMORY\.md/.test(x)) && r2.violations.some((x) => /scripts\/tweak\.ps1/.test(x)) && r2.violations.some((x) => /protect manifest does NOT verify/.test(x)), JSON.stringify(r2.violations));
  const c = cli(['parity', '--project', p, '--baseline', bf, '--out', outFile('p3.md'), '--plan', plan, '--protect-manifest', pm, '--forge-sync', stubBad, '--doctor-json', dj2]);
  t('5d: CLI parity exits 1 on FAIL and lists violations', c.status === 1 && /parity FAIL/.test(c.stdout) && /✗/.test(c.stdout), c.stdout + c.stderr);
  t('5e: parity refuses an --out inside the project outside .claude', throwsCode(() => A.parity({ project: p, baseline: bf, out: path.join(p, 'x.md') }), 2));
}
{
  // post-ADOPTION parity (--record): the adoption's own writes are explained, nothing else is
  const p = project();
  const dj = outFile('dj-rec.json');
  fs.writeFileSync(dj, JSON.stringify({ ok: true, checks: { tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [{ suite: 'a.test.cjs', ok: true }] } } }));
  const bf = outFile('b-rec.json');
  A.baseline({ project: p, out: bf, doctorJson: dj });
  write(p, '.claude/forge-bin/forge-tool.cjs', 'updated\n');
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'b2', filesChanged: [{ rel: 'forge-bin/forge-tool.cjs' }] }));
  const plan = outFile('plan-rec.json');
  fs.writeFileSync(plan, JSON.stringify({ files: [{ rel: 'forge-bin/forge-tool.cjs', action: 'add' }], settings: { hooksAdded: [], hooksChanged: [], denyAdded: [] }, scaffold: {}, migrations: {} }));
  const stubOk = write(outDir, 'stub-ok2.cjs', 'console.log(JSON.stringify({ok:true,checked:1,allowed:[],changed:[],added:[],removed:[]}));\n');
  const pm = write(outDir, 'pm2.json', '{}');
  const ad = A.adoptApply({ project: p, baseline: bf });
  const args = { project: p, baseline: bf, plan, protectManifest: pm, forgeSync: stubOk, doctorJson: dj };
  const noRec = A.parity(Object.assign({}, args, { out: outFile('p-norec.md') }));
  t('5f: after adoption, plain parity names the adoption writes as unexplained', !noRec.ok && noRec.violations.some((x) => /FORGE_MEMORY\.md/.test(x)) && noRec.violations.some((x) => /FORGE-SYNC-BRIEFING/.test(x)), JSON.stringify(noRec.violations));
  const withRec = A.parity(Object.assign({}, args, { out: outFile('p-rec.md'), record: ad.recordPath }));
  t('5g: with --record the post-adoption parity is PASS (phase after-adoption)', withRec.ok && withRec.phase === 'after-adoption', JSON.stringify(withRec.violations));
  const stubAdopt = write(outDir, 'stub-adopt.cjs', 'console.log(JSON.stringify({ok:false,checked:9,allowed:[],changed:[{key:".claude/FORGE_MEMORY.md"}],added:[{key:".claude/FORGE-SYNC-BRIEFING.md"},{key:".claude/forge-scribe"},{key:".claude/forge-scribe/ledger.jsonl"},{key:".claude/forge-adoption"},{key:".claude/config/agents/agent-tool-policy.user.json"}],removed:[]}));process.exitCode=1;\n');
  const pr = A.parity(Object.assign({}, args, { out: outFile('p-rec-protect.md'), record: ad.recordPath, forgeSync: stubAdopt }));
  t('5g2: protect findings the adoption record explains (files + its folders) are filtered, then PASS', pr.ok && pr.protect.explainedByAdoption.length === 6, JSON.stringify({ v: pr.violations, e: pr.protect && pr.protect.explainedByAdoption }));
  const stubMixed = write(outDir, 'stub-mixed.cjs', 'console.log(JSON.stringify({ok:false,checked:9,allowed:[],changed:[{key:".claude/FORGE_MEMORY.md"},{key:".claude/agent-memory/idea-reviewer/MEMORY.md"}],added:[],removed:[]}));process.exitCode=1;\n');
  const pm2 = A.parity(Object.assign({}, args, { out: outFile('p-rec-mixed.md'), record: ad.recordPath, forgeSync: stubMixed }));
  t('5g3: an agent-memory change the record did not make stays a protect violation', !pm2.ok && pm2.violations.some((x) => /protect manifest does NOT verify: changed \.claude\/agent-memory/.test(x)) && !pm2.violations.some((x) => /changed \.claude\/FORGE_MEMORY\.md/.test(x)), JSON.stringify(pm2.violations));
  // WP-ADOPT-VERIFIED: verify-protect reports inventoried / verified / notVerified — never claim "all unchanged" when some were not verified
  const stubPartial = write(outDir, 'stub-partial.cjs', 'console.log(JSON.stringify({ok:true,checked:10,inventoried:10,verified:7,notVerified:3,allowed:[],changed:[],added:[],removed:[]}));\n');
  const partRep = outFile('p-rec-partial.md');
  const part = A.parity(Object.assign({}, args, { out: partRep, record: ad.recordPath, forgeSync: stubPartial }));
  const partTxt = fs.readFileSync(partRep, 'utf8');
  t('5g4: parity JSON carries inventoried / verified / notVerified from verify-protect', part.ok && part.protect.inventoried === 10 && part.protect.verified === 7 && part.protect.notVerified === 3, JSON.stringify(part.protect));
  t('5g5: the report says 7 verified unchanged + 3 not verifiable, never "10 protected entries unchanged"', /verified 7 unchanged, 3 not verifiable \(unreadable worktree scratch\)/.test(partTxt) && !/10 protected entries unchanged/.test(partTxt), partTxt);
  const legacy = A.parity(Object.assign({}, args, { out: outFile('p-rec-legacy.md'), record: ad.recordPath }));
  const legTxt = fs.readFileSync(legacy.report, 'utf8');
  t('5g6: an older verify-protect without the new fields falls back to checked (all verified, 0 not verifiable)', legacy.protect.verified === 1 && legacy.protect.notVerified === 0 && /verified 1 unchanged, 0 not verifiable/.test(legTxt), JSON.stringify(legacy.protect) + legTxt);
  fs.appendFileSync(path.join(p, '.claude', 'FORGE-SYNC-BRIEFING.md'), 'later edit\n');
  write(p, '.claude/agent-memory/idea-reviewer/MEMORY.md', '- les 1\n- stiekem\n');
  const tampered = A.parity(Object.assign({}, args, { out: outFile('p-rec2.md'), record: ad.recordPath }));
  t('5h: a file changed after the adoption, or one the record never wrote, still FAILs', !tampered.ok && tampered.violations.some((x) => /FORGE-SYNC-BRIEFING/.test(x)) && tampered.violations.some((x) => /agent-memory/.test(x)), JSON.stringify(tampered.violations));
}

// ---------------------------------------------------------------- 6. adopt plan + apply + idempotency
const projA = project();
const baseA = outFile('baselineA.json');
A.baseline({ project: projA, out: baseA });
write(projA, '.claude/forge-runs/run-later/run-finalized.json', JSON.stringify({ schema: 2, run_id: 'run-later', digest: '9'.repeat(64), bytes: 1, contract: 'ok', ruleset_sha256: '8'.repeat(64) }));
write(projA, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'h2sync-test', templateVersionFrom: 'aaa', templateVersionTo: 'bbb', syncedAt: new Date(Date.now() + 1000).toISOString(), filesChanged: [{ rel: 'forge-bin/x.cjs' }, { rel: 'skills/forge-router/SKILL.md' }, { rel: 'agents/build-boss.md' }], report: 'forge-sync-report-h2sync-test.md' }));
const memBefore = fs.readFileSync(path.join(projA, '.claude', 'FORGE_MEMORY.md'));
const notesBefore = fs.readFileSync(path.join(projA, 'tasks', 'RESUME-2026-10-09.md'));
const histBefore = fs.readFileSync(path.join(projA, '.claude', 'FORGE_TASK_HISTORY.md'));
{
  const plan = A.adoptPlan({ project: projA, baseline: baseA });
  const steps = plan.actions.map((a) => a.step).sort().join(',');
  t('6a: the plan has agents, legacy-receipts, scribe, briefing and memory', steps === 'agents,briefing,legacy-receipts,memory,scribe', steps);
  const ag = plan.actions.find((a) => a.step === 'agents');
  t('6b: idea-reviewer -> read-only-audit, scripter -> exec-reviewer; shipped build-boss untouched', ag.add['idea-reviewer'].class === 'read-only-audit' && ag.add.scripter.class === 'exec-reviewer' && !ag.add['build-boss'], JSON.stringify(ag.add));
  t('6c: an agent without tools and one with an unknown forge_class are skipped visibly', plan.skipped.some((s) => s.item === 'no-tools' && /tools/.test(s.reason)) && plan.skipped.some((s) => s.item === 'odd' && /super-admin/.test(s.reason)), JSON.stringify(plan.skipped));
  const lg = plan.actions.find((a) => a.step === 'legacy-receipts');
  t('6d: only pre-sync receipts of an old generation are allowlisted', lg.add.map((x) => x.run_id + ':' + x.generation).sort().join() === 'run-old:pre-evidence,run-pinless:pre-pinned-ruleset', JSON.stringify(lg.add));
  t('6e: a receipt written after the baseline is never allowlisted', plan.skipped.some((s) => s.item === 'run-later' && /not in the pre-sync baseline/.test(s.reason)));
  const sc = plan.actions.find((a) => a.step === 'scribe');
  const texts = sc.items.map((x) => x.text);
  t('6f: scribe items = open resume items + open/TODO history lines, nothing done', texts.includes('Defender-uitzondering testen op build 26200') && texts.includes('Rollback-script voor de taakplanner schrijven') && texts.some((x) => /logboek exporteren/.test(x)) && !texts.some((x) => /telemetrie|energieplan|klaar|context/.test(x)), JSON.stringify(texts));
  t('6g: plan mode wrote nothing', !fs.existsSync(path.join(projA, '.claude', 'FORGE-SYNC-BRIEFING.md')) && fs.readFileSync(path.join(projA, '.claude', 'FORGE_MEMORY.md')).equals(memBefore));
  const c = cli(['adopt', '--project', projA, '--baseline', baseA]);
  t('6h: CLI adopt without --apply prints the plan and exits 0', c.status === 0 && /nothing written/.test(c.stdout), c.stdout + c.stderr);
}
let recA;
{
  const filesBefore = A.fileMap(projA).files;
  const r = A.adoptApply({ project: projA, baseline: baseA });
  recA = r.recordPath;
  t('6i: adopt --apply completes every step', r.ok && r.record.state === 'complete', JSON.stringify(r.record.actions.map((a) => a.step + ':' + a.ok + ':' + (a.error || ''))));
  const ov = JSON.parse(read(projA, '.claude/config/agents/agent-tool-policy.user.json'));
  t('6j: the overlay holds the two project agents with exact tools', ov.agents['idea-reviewer'].class === 'read-only-audit' && ov.agents['idea-reviewer'].tools.join() === 'Read,Grep,Glob' && ov.agents.scripter && Object.keys(ov).every((k) => ['agents', '_doc', '_note'].includes(k)), JSON.stringify(ov));
  const lg = JSON.parse(read(projA, '.claude/config/orchestration/FORGE_LEGACY_RECEIPTS.user.json'));
  const rOld = sha(fs.readFileSync(path.join(projA, '.claude', 'forge-runs', 'run-old', 'run-finalized.json')));
  t('6k: the legacy allowlist names run-old by its exact sha256', lg.schema === 'forge-legacy-receipts/v1' && lg.receipts.some((e) => e.run_id === 'run-old' && e.sha256 === rOld && e.generation === 'pre-evidence'));
  const finalize = require('./forge-finalize.cjs');
  const allowed = finalize.loadLegacyReceipts(projA);
  t('6l: forge-finalize itself accepts the written allowlist', !allowed.error && allowed.entries.some((e) => e.run_id === 'run-old'), JSON.stringify(allowed));
  const memAfter = fs.readFileSync(path.join(projA, '.claude', 'FORGE_MEMORY.md'));
  t('6m: FORGE_MEMORY.md: the old bytes are an exact prefix + one dated adoption entry', memAfter.subarray(0, memBefore.length).equals(memBefore) && /## \d{4}-\d{2}-\d{2} — Forge-Core sync adoption/.test(memAfter.toString()) && (memAfter.toString().match(/Forge-Core sync adoption/g) || []).length === 1);
  const br = read(projA, '.claude/FORGE-SYNC-BRIEFING.md');
  t('6n: the briefing carries the exact pickup sentence', br.includes(A.PICKUP_SENTENCE) && A.PICKUP_SENTENCE === 'Je geheugen en alle projectbestanden zijn intact. Lees eerst FORGE_MEMORY.md, FORGE_TASK_HISTORY.md, de agent-memory en je resume-notitie, en pak daar alles weer op. Wat er veranderd is staat in het wijzigingsrapport.');
  t('6o: the briefing is written from the real change set (batch, count, areas, report path)', /h2sync-test/.test(br) && /3 Forge-systeembestand/.test(br) && /forge-bin 1/.test(br) && /forge-sync-report-h2sync-test\.md/.test(br) && /idea-reviewer → read-only-audit/.test(br), br);
  const scribeState = JSON.parse(read(projA, '.claude/forge-scribe/state.json'));
  const items = Object.values(scribeState.items);
  t('6p: scribe holds the imported items as open, no inbox record', items.length >= 4 && items.every((i) => i.status === 'open' && i.imported_from) && !fs.existsSync(path.join(projA, '.claude', 'forge-scribe', 'inbox.jsonl')), JSON.stringify(items.map((i) => i.title)));
  t('6q: the sources (resume note, task history) are byte-identical', fs.readFileSync(path.join(projA, 'tasks', 'RESUME-2026-10-09.md')).equals(notesBefore) && fs.readFileSync(path.join(projA, '.claude', 'FORGE_TASK_HISTORY.md')).equals(histBefore));
  const filesAfter = A.fileMap(projA).files;
  const outside = Object.keys(filesAfter).filter((k) => !k.startsWith('.claude/') && (!filesBefore[k] || filesBefore[k].sha256 !== filesAfter[k].sha256 || filesBefore[k].size !== filesAfter[k].size));
  t('6r: nothing outside .claude/ was written or changed (app code, tasks/, .env)', outside.length === 0, JSON.stringify(outside));
  const rec = JSON.parse(fs.readFileSync(recA, 'utf8'));
  t('6s: the record lists every write with pre/post hashes', rec.schema === A.RECORD_SCHEMA && rec.actions.length === 5 && rec.actions.every((a) => a.post && (a.pre || a.kind === 'scribe')));
  const again = A.adoptApply({ project: projA, baseline: baseA, now: new Date(Date.now() + 2000).toISOString() });
  const memAgain = fs.readFileSync(path.join(projA, '.claude', 'FORGE_MEMORY.md'));
  t('6t: a second adopt adds nothing: no 2nd memory entry, briefing kept, no new agents/receipts/items', memAgain.equals(memAfter) && again.record.skipped.some((s) => s.step === 'memory') && again.record.skipped.some((s) => s.step === 'briefing') && !again.record.actions.some((a) => a.step === 'agents' || a.step === 'legacy-receipts') && again.record.actions.filter((a) => a.step === 'scribe').every((a) => a.imported === 0), JSON.stringify(again.record.actions.map((a) => a.step + ':' + a.imported)));
  const ig0 = A.integrity({ project: projA, baseline: baseA, record: recA });
  t('6u: integrity flags the receipt written after the baseline (not explained by the record)', !ig0.ok && ig0.violations.length === 1 && /run-later/.test(ig0.violations[0]), JSON.stringify(ig0.violations));
  const ig = A.integrity({ project: projA, baseline: baseA, record: recA, allow: ['.claude/forge-runs/run-later/run-finalized.json'] });
  t('6v: with that one path --allow-ed it is INTACT (only the explained append/merges/creations)', ig.ok && ig.explained.some((x) => /appended only.*FORGE_MEMORY\.md/.test(x)) && ig.explained.some((x) => /allowed by --allow/.test(x)), JSON.stringify(ig.violations));
}

// ---------------------------------------------------------------- 7. integrity catches tampering; undo restores
{
  write(projA, '.claude/agent-memory/idea-reviewer/MEMORY.md', '- les 1 (bewerkt)\n');
  write(projA, '.claude/forge-runs/event-wiring-test-123/events.jsonl', '{}\n');
  const ig = A.integrity({ project: projA, baseline: baseA, record: recA, allow: ['.claude/forge-runs/run-later/run-finalized.json'] });
  t('7a: an edited memory file and a stray forge-runs folder are violations', !ig.ok && ig.violations.some((x) => /changed: \.claude\/agent-memory\/idea-reviewer/.test(x)) && ig.violations.some((x) => /event-wiring-test-123/.test(x)), JSON.stringify(ig.violations));
  const c = cli(['integrity', '--project', projA, '--baseline', baseA, '--record', recA]);
  t('7b: CLI integrity exits 1 on a violation', c.status === 1 && /VIOLATION/.test(c.stdout), c.stdout + c.stderr);
  fs.rmSync(path.join(projA, '.claude', 'forge-runs', 'event-wiring-test-123'), { recursive: true });
  write(projA, '.claude/agent-memory/idea-reviewer/MEMORY.md', '- les 1\n');
  const plan = A.undo({ project: projA, record: recA });
  t('7c: undo without --apply is a plan only', plan.ok && !plan.applied && plan.steps.length === 5, JSON.stringify(plan));
  const u = A.undo({ project: projA, record: recA, apply: true });
  t('7d: undo --apply restores FORGE_MEMORY.md byte for byte and removes the created files', u.applied && fs.readFileSync(path.join(projA, '.claude', 'FORGE_MEMORY.md')).equals(memBefore)
    && !fs.existsSync(path.join(projA, '.claude', 'FORGE-SYNC-BRIEFING.md')) && !fs.existsSync(path.join(projA, '.claude', 'config', 'agents', 'agent-tool-policy.user.json')) && !fs.existsSync(path.join(projA, '.claude', 'forge-scribe', 'ledger.jsonl')), JSON.stringify(u));
}
{
  const p = project();
  const bf = outFile('bU.json');
  A.baseline({ project: p, out: bf });
  const r = A.adoptApply({ project: p, baseline: bf });
  fs.appendFileSync(path.join(p, '.claude', 'FORGE_MEMORY.md'), '- door een sessie toegevoegd\n');
  const u = A.undo({ project: p, record: r.recordPath, apply: true });
  t('7e: undo refuses when a file changed since the adoption (nothing reverted)', !u.ok && !u.applied && u.conflicts.some((x) => /FORGE_MEMORY\.md/.test(x)) && fs.existsSync(path.join(p, '.claude', 'FORGE-SYNC-BRIEFING.md')), JSON.stringify(u));
}

{
  // a seed-only default the SYNC created (receipt filesChanged overrideClass 'seed') is the sync's own write
  const p = project({ scribe: false });
  const bf = outFile('bSeed.json');
  A.baseline({ project: p, out: bf });
  const seedText = '# learnings (template default)\n';
  write(p, '.claude/skills/forge-scribe/learnings.md', seedText);
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'b-seed', filesChanged: [{ rel: 'skills/forge-scribe/learnings.md', oldHash: null, newHash: sha(Buffer.from(seedText)), overrideClass: 'seed' }] }));
  const ig = A.integrity({ project: p, baseline: bf });
  t('7f: a seed default the sync created (receipt) is explained, not a violation', ig.ok && ig.explained.some((x) => /seed-only default created by sync batch b-seed/.test(x)), JSON.stringify(ig));
  write(p, '.claude/skills/forge-scribe/learnings.md', seedText + '- iets\n');
  const ig2 = A.integrity({ project: p, baseline: bf });
  t('7g: ...but once it changed after the sync it is a violation again', !ig2.ok && /seeded it, but it changed since/.test(ig2.violations.join()), JSON.stringify(ig2.violations));
}

// ---------------------------------------------------------------- 8. refusals: lock, malformed overlay, merge-add, junction
{
  const p = project();
  fs.writeFileSync(path.join(p, '.claude', '.forge-sync.lock'), '{}');
  t('8a: adopt refuses while a forge-sync lock exists (exit 1)', throwsCode(() => A.adoptApply({ project: p }), 1));
  fs.rmSync(path.join(p, '.claude', '.forge-sync.lock'));
  write(p, '.claude/config/agents/agent-tool-policy.user.json', '{ not json');
  const plan = A.adoptPlan({ project: p });
  t('8b: a malformed overlay is never overwritten (agents step skipped with the reason)', !plan.actions.some((a) => a.step === 'agents') && plan.skipped.some((s) => s.step === 'agents' && /not valid JSON/.test(s.reason)));
  const existing = { schema: 'forge-legacy-receipts/v1', _doc: 'owner text', receipts: [{ run_id: 'keep-me', sha256: '0'.repeat(64), generation: 'pre-evidence', reason: 'owner-reviewed' }] };
  write(p, '.claude/config/orchestration/FORGE_LEGACY_RECEIPTS.user.json', JSON.stringify(existing, null, 2));
  const bf = outFile('b8.json');
  A.baseline({ project: p, out: bf });
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'b8', syncedAt: new Date(Date.now() + 1000).toISOString(), filesChanged: [] }));
  A.adoptApply({ project: p, baseline: bf });
  const lg = JSON.parse(read(p, '.claude/config/orchestration/FORGE_LEGACY_RECEIPTS.user.json'));
  t('8c: an existing allowlist is merge-added: the owner entry and _doc stay verbatim', lg._doc === 'owner text' && JSON.stringify(lg.receipts[0]) === JSON.stringify(existing.receipts[0]) && lg.receipts.length === 3, JSON.stringify(lg));
  const p2 = project();
  const outside = tmp('outside');
  fs.symlinkSync(outside, path.join(p2, '.claude', 'forge-adoption'), 'junction');
  t('8d: a junction where the record goes is refused (nothing written outside .claude)', throwsCode(() => A.adoptApply({ project: p2 }), 1) && fs.readdirSync(outside).length === 0);
  const p3 = project({ scribe: false });
  const pl3 = A.adoptPlan({ project: p3 });
  t('8e: without the scribe import command the scribe step is skipped with the reason', pl3.skipped.some((s) => s.step === 'scribe' && /import-lines/.test(s.reason)));
  t('8f: without --baseline no receipt is allowlisted', pl3.skipped.some((s) => s.step === 'legacy-receipts' && /needs --baseline/.test(s.reason)));
}

// ---------------------------------------------------------------- 9. resume-note + CLI usage
{
  const p = project();
  const before = A.fileMap(p).files;
  const c = cli(['resume-note', '--project', p]);
  t('9a: resume-note prints the pickup sentence and the resume note path', c.status === 0 && c.stdout.includes(A.PICKUP_SENTENCE) && /tasks\/RESUME-2026-10-09\.md/.test(c.stdout), c.stdout + c.stderr);
  t('9b: resume-note writes nothing', JSON.stringify(A.fileMap(p).files) === JSON.stringify(before));
  t('9c: unknown command -> exit 2 with usage', cli(['nope']).status === 2);
  t('9d: a missing project -> exit 2', cli(['adopt', '--project', path.join(outDir, 'does-not-exist')]).status === 2);
  t('9e: memory predicate covers the R11 paths', ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md', '.claude/agent-memory/x/MEMORY.md', '.claude/forge-runs/r/events.jsonl', '.claude/skills/a/learnings.md', '.claude/FORGE_OWNER_PROFILE.json', 'tasks/RESUME-x.md'].every(A.isMemoryRel) && !A.isMemoryRel('.claude/forge-bin/x.cjs'));
}

// ---------------------------------------------------------------- 10. WP-ADOPT-R2 hardening (security audit findings)
const adopted = () => {
  const p = project();
  const bf = outFile('b10.json');
  A.baseline({ project: p, out: bf });
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'b10', syncedAt: new Date(Date.now() + 1000).toISOString(), filesChanged: [] }));
  const r = A.adoptApply({ project: p, baseline: bf });
  return { p, bf, rec: r.recordPath, json: JSON.parse(fs.readFileSync(r.recordPath, 'utf8')) };
};
const forge = (p, name, recJson) => write(p, '.claude/forge-adoption/' + name, JSON.stringify(recJson, null, 2));
{
  // MEDIUM-1: a forged scribe key (..\..\victim.txt) must be refused; nothing written or deleted outside forge-scribe
  const { p, bf, json } = adopted();
  const victim = write(p, 'victim.txt', 'keep me\n');
  const key = path.join('..', '..', 'victim.txt');
  const forged = JSON.parse(JSON.stringify(json));
  const sa = forged.actions.find((a) => a.kind === 'scribe');
  sa.pre.files[key] = { exists: false };
  sa.post.files[key] = { exists: true, sha256: sha(fs.readFileSync(victim)), size: 8 };
  const fp = forge(p, 'adopt-forged-scribe.json', forged);
  const scribeBefore = fs.readFileSync(path.join(p, '.claude', 'forge-scribe', 'state.json'));
  t('10a: undo refuses a record whose scribe file key escapes (..\\..\\victim.txt); victim and scribe untouched', throwsCode(() => A.undo({ project: p, record: fp, apply: true }), 1) && fs.existsSync(victim) && fs.readFileSync(path.join(p, '.claude', 'forge-scribe', 'state.json')).equals(scribeBefore));
  const forged2 = JSON.parse(JSON.stringify(json));
  const settings = path.join(p, '.claude', 'settings.json');
  forged2.actions.push({ step: 'briefing', rel: 'settings.json', kind: 'create', ok: true, pre: { exists: false }, post: { exists: true, sha256: sha(fs.readFileSync(settings)) } });
  const fp2 = forge(p, 'adopt-forged-rel.json', forged2);
  t('10b: undo refuses a record naming a target outside the four known ones (.claude/settings.json kept)', throwsCode(() => A.undo({ project: p, record: fp2, apply: true }), 1) && fs.existsSync(settings));
  const forged3 = JSON.parse(JSON.stringify(json));
  forged3.actions.find((a) => a.step === 'memory').kind = 'create';
  t('10c: a known target with the wrong kind (memory as create -> unlink) is refused', throwsCode(() => A.undo({ project: p, record: forge(p, 'adopt-forged-kind.json', forged3) }), 1));
  const outsideRec = outFile('copied-record.json');
  fs.writeFileSync(outsideRec, JSON.stringify(json));
  t('10d: a record stored outside <project>/.claude/forge-adoption/ is refused (undo, integrity)', throwsCode(() => A.undo({ project: p, record: outsideRec }), 1) && throwsCode(() => A.integrity({ project: p, baseline: bf, record: outsideRec }), 1));
}
{
  const { p, json } = adopted();
  const jdir = tmp('jrec');
  fs.writeFileSync(path.join(jdir, 'adopt-x.json'), JSON.stringify(json));
  fs.renameSync(path.join(p, '.claude', 'forge-adoption'), path.join(p, '.claude', 'forge-adoption-real'));
  fs.symlinkSync(jdir, path.join(p, '.claude', 'forge-adoption'), 'junction');
  t('10e: a record reached through a junctioned forge-adoption folder is refused', throwsCode(() => A.undo({ project: p, record: path.join(p, '.claude', 'forge-adoption', 'adopt-x.json'), apply: true }), 1) && fs.existsSync(path.join(p, '.claude', 'FORGE-SYNC-BRIEFING.md')));
}
{
  // MEDIUM-2: the legacy-receipt allowlist needs a baseline that is outside the project and predates the sync
  const p = project();
  write(p, '.claude/forge-runs/run-future/run-finalized.json', JSON.stringify({ schema: 2, run_id: 'run-future', ruleset_sha256: '5'.repeat(64), finalized_at: '2099-01-01T00:00:00Z' }));
  write(p, '.claude/forge-runs/run-postcut/run-finalized.json', JSON.stringify({ schema: 2, run_id: 'run-postcut', ruleset_sha256: '6'.repeat(64), finalized_at: '2026-10-09T12:00:00Z' }));
  write(p, '.claude/config/orchestration/FORGE_HARD_RULES.json', JSON.stringify({ completion_proof: { enforcement_cutoff: '2099-01-01T00:00:00Z' } }));
  const bf = outFile('b10m2.json');
  A.baseline({ project: p, out: bf });
  const inside = write(p, '.claude/my-baseline.json', fs.readFileSync(bf, 'utf8'));
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'bm2', syncedAt: new Date(Date.now() + 1000).toISOString(), filesChanged: [] }));
  const pIn = A.adoptPlan({ project: p, baseline: inside });
  t('10f: a baseline stored inside the project allowlists nothing', !pIn.actions.some((a) => a.step === 'legacy-receipts') && pIn.skipped.some((s) => s.step === 'legacy-receipts' && /inside the project/.test(s.reason)), JSON.stringify(pIn.skipped));
  const pl = A.adoptPlan({ project: p, baseline: bf });
  const lg = pl.actions.find((a) => a.step === 'legacy-receipts');
  t('10g: a receipt finalized after the baseline is never allowlisted', lg && !lg.add.some((x) => x.run_id === 'run-future') && pl.skipped.some((s) => s.item === 'run-future' && /not before the baseline/.test(s.reason)), JSON.stringify(pl.skipped));
  t('10h: the project cannot move the cutoff later: a run finalized after the tool cutoff is skipped, run-old still allowlisted', lg && lg.add.some((x) => x.run_id === 'run-old') && !lg.add.some((x) => x.run_id === 'run-postcut') && pl.skipped.some((s) => s.item === 'run-postcut' && /enforcement cutoff 2026-10-09/.test(s.reason)), JSON.stringify(pl.skipped));
  write(p, '.claude/forge-sync-receipt.json', JSON.stringify({ batchId: 'bm2', syncedAt: '2020-01-01T00:00:00.000Z', filesChanged: [] }));
  const pOld = A.adoptPlan({ project: p, baseline: bf });
  t('10i: a baseline taken after the sync (takenAt >= syncedAt) allowlists nothing', !pOld.actions.some((a) => a.step === 'legacy-receipts') && pOld.skipped.some((s) => /not taken before the sync/.test(s.reason)), JSON.stringify(pOld.skipped));
}
{
  // L1: integrity compares against the hashes the record wrote, not "any later change"
  const { p, bf, rec } = adopted();
  const ok0 = A.integrity({ project: p, baseline: bf, record: rec });
  write(p, '.claude/config/agents/agent-tool-policy.user.json', JSON.stringify({ agents: { sneaky: { class: 'full-build', tools: ['Bash'] } } }));
  fs.appendFileSync(path.join(p, '.claude', 'forge-scribe', 'state.json'), ' ');
  const ig = A.integrity({ project: p, baseline: bf, record: rec });
  t('10j: an adopted overlay / scribe file edited after the adoption is a violation (L1)', ok0.ok && !ig.ok && ig.violations.some((x) => /agent-tool-policy\.user\.json/.test(x)) && ig.violations.some((x) => /forge-scribe\/state\.json/.test(x)), JSON.stringify({ ok0: ok0.violations, v: ig.violations }));
  // L2: parity --out never overwrites and never lands in a memory path
  const existing = outFile('exists.md');
  fs.writeFileSync(existing, 'old report\n');
  t('10k: parity --out refuses an existing file (left byte-identical)', throwsCode(() => A.parity({ project: p, baseline: bf, out: existing }), 2) && fs.readFileSync(existing, 'utf8') === 'old report\n');
  t('10l: parity --out refuses a project memory path', throwsCode(() => A.parity({ project: p, baseline: bf, out: path.join(p, '.claude', 'agent-memory', 'x', 'parity.md') }), 2) && !fs.existsSync(path.join(p, '.claude', 'agent-memory', 'x')));
  // L3: --now must be a strict ISO timestamp (it names the record file)
  t('10m: --now accepts only a strict ISO timestamp', throwsCode(() => A.adoptPlan({ project: p, now: '../../evil' }), 2) && throwsCode(() => A.adoptPlan({ project: p, now: '2026-10-10T12:00:00.000Z/../../x' }), 2) && throwsCode(() => A.adoptPlan({ project: p, now: '2026-13-45T99:00:00Z' }), 2) && !throwsCode(() => A.adoptPlan({ project: p, now: '2026-10-10T12:00:00.000Z' })));
}
{
  // WP-SYNC-R8: .claude/worktrees (26H2: ~3.2M files) is never walked; the file map holds one entry with the child count
  const { p } = adopted();
  for (let i = 0; i < 12; i++) for (let j = 0; j < 8; j++) write(p, '.claude/worktrees/wt-' + i + '/src/f' + j + '.txt', 'file ' + i + '-' + j + '\n');
  const fm = A.fileMap(p);
  const under = Object.keys(fm.files).filter((k) => k.startsWith('.claude/worktrees/'));
  t('10n: worktrees contents are not in the file map; one entry carries the child count', under.length === 0 && fm.files['.claude/worktrees'] && fm.files['.claude/worktrees'].size === 12 && !fm.truncated, JSON.stringify({ under: under.length, e: fm.files['.claude/worktrees'] }));
  t('10o: memory folders are still hashed file by file next to the skipped worktrees', Object.keys(fm.files).some((k) => /^\.claude\/(agent-memory|forge-scribe)\//.test(k)), Object.keys(fm.files).slice(0, 6).join(','));
}
{
  // WP-SYNC-R10: the ONE worktrees entry carries every child's name + kind + a hash, so a swap with the SAME
  // child count is seen; an R8 (count-only) baseline stays readable and the parity notes say what it cannot see.
  // Assertions marked failed against the pre-fix forge-adopt-post-sync.cjs in an os.tmpdir() harness. same(): the tool's own
  // comparison; against a module without it, the raw entries (identical JSON = the tool cannot tell them apart).
  const same = (a, b) => (typeof A.sameEntry === 'function' ? A.sameEntry(a, b) : JSON.stringify(a) === JSON.stringify(b));
  try {
  const { p } = adopted();
  write(p, '.claude/worktrees/wt-a/.git', 'gitdir: x/wt-a\n');
  write(p, '.claude/worktrees/wt-a/src/f.txt', 'checkout content');
  write(p, '.claude/worktrees/wt-b/.git', 'gitdir: x/wt-b\n');
  const e0 = A.fileMap(p).files['.claude/worktrees'];
  t('10p [R10]: the entry is versioned and carries the child names and a name/kind hash (the R8 fields size/mtimeMs/meta kept)', !!e0 && e0.worktrees === A.WORKTREES_ENTRY_VERSION && e0.size === 2 && /^[0-9a-f]{64}$/.test(e0.namesHash) && JSON.stringify(e0.names) === '["wt-a","wt-b"]' && e0.mtimeMs === 0 && e0.meta === true, JSON.stringify(e0));
  fs.rmSync(path.join(p, '.claude', 'worktrees', 'wt-b'), { recursive: true, force: true });
  write(p, '.claude/worktrees/wt-c/.git', 'gitdir: x/wt-c\n');
  const e1 = A.fileMap(p).files['.claude/worktrees'];
  t('10q [R10]: swapping checkout wt-b for checkout wt-c (the same count) changes the entry', !!e1 && e1.size === 2 && !same(e0, e1));
  fs.rmSync(path.join(p, '.claude', 'worktrees', 'wt-c'), { recursive: true, force: true });
  write(p, '.claude/worktrees/wt-c', 'now a file');
  const e2 = A.fileMap(p).files['.claude/worktrees'];
  t('10r [R10]: a checkout replaced by a FILE of the same name changes the entry', !!e2 && e2.size === 2 && !same(e1, e2));
  write(p, '.claude/worktrees/wt-a/.git', 'gitdir: x/OTHER\n');
  const e3 = A.fileMap(p).files['.claude/worktrees'];
  t('10s [R10]: a checkout swapped under the SAME name (its .git pointer changed) changes the entry', !!e3 && !same(e2, e3));
  write(p, '.claude/worktrees/wt-a/src/f.txt', 'edited INSIDE the checkout');
  t('10t: an edit INSIDE a checkout is not seen (never walked) — and an untouched folder compares equal (no false alarm)', same(e3, A.fileMap(p).files['.claude/worktrees']));
  const r8 = { size: e3.size, mtimeMs: 0, meta: true };
  t('10u [R10]: an R8 baseline entry (count only) stays readable: equal to the versioned entry with the same count, different with another count', typeof A.isR8WorktreesEntry === 'function' && A.isR8WorktreesEntry(r8) && same(r8, e3) && same(e3, r8) && !same({ size: 9, mtimeMs: 0, meta: true }, e3));
  const bf = outFile('b10v.json');
  A.baseline({ project: p, out: bf });
  const bj = JSON.parse(fs.readFileSync(bf, 'utf8'));
  bj.files['.claude/worktrees'] = r8; // as an R8 baseline recorded it
  fs.writeFileSync(bf, JSON.stringify(bj, null, 1));
  const pr = A.parity({ project: p, baseline: bf, out: outFile('p10v.md') });
  t('10v [R10]: parity against an R8 baseline says the worktrees comparison was by child COUNT only', pr.notes.some((n) => /\.claude\/worktrees by child COUNT only/.test(n)), JSON.stringify(pr.notes));
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const q = project();
    write(q, '.claude/Worktrees/wt-z/.git', 'gitdir: x\n');
    write(q, '.claude/Worktrees/wt-z/src/HASHME.txt', 'x');
    const fq = A.fileMap(q).files;
    t('10w [R10]: .claude/Worktrees (other case) is the same folder on Windows/macOS: one entry, never walked', !!fq['.claude/Worktrees'] && fq['.claude/Worktrees'].worktrees === A.WORKTREES_ENTRY_VERSION && !Object.keys(fq).some((k) => /HASHME/.test(k)));
  }
  } catch (e) { t('10p-10w [R10]: the block ran without throwing', false, e && e.message); }
}

for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log('\nforge-adopt-post-sync tests:');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
