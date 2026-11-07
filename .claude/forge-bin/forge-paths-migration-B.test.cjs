#!/usr/bin/env node
'use strict';
/**
 * forge-paths-migration-B.test.cjs — WP 2.1.B layout matrix for the group-B (memory / state) tools.
 *   FORGE  a temp project WITH .forge/: scribe, stores, vault, snapshot, consolidate, tool index, retention, MCP server,
 *          secret scan, harvest/secondbrain, killswitch ... read and write .forge/<key> and .forge/memory, and NOTHING is
 *          written under the project's .claude (its whole tree is hashed before and after).
 *   LEGACY a temp project WITHOUT .forge/: the same tools write exactly the old .claude paths and no .forge appears.
 *   PLUGIN copies of the tools in <tmp>/plug/.../scripts (outside every project): with the cwd inside a project they
 *          act on that project; outside any project they refuse clearly; nothing ever lands in the script folder.
 *   OLDER  a synced project whose forge-paths.cjs predates stateDir: the guarded require keeps the legacy path, no crash.
 * Hermetic: everything under one os.tmpdir() folder, removed at the end. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
const t = (name, cond, info) => { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (info !== undefined ? ' :: ' + String(info).slice(0, 400) : '')); } };
const section = (name, fn) => { try { fn(); } catch (e) { failed++; console.log('  FAIL ' + name + ' threw: ' + String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } };

const BIN = __dirname;
const CLAUDE_SRC = path.join(__dirname, '..');
const CANON = fs.readFileSync(path.join(CLAUDE_SRC, 'config', 'orchestration', 'forge-canon.json'), 'utf8');
const SCRIBE_CFG = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_SCRIBE.json');
const HARD_RULES = path.join(CLAUDE_SRC, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mig-B-')));
const env0 = () => { const e = Object.assign({}, process.env); for (const k of ['CLAUDE_PROJECT_DIR', 'FORGE_PROJECT_ROOT', 'FORGE_STATE_DIR', 'FORGE_STORE_ROOT']) delete e[k]; return e; };
for (const k of ['FORGE_STATE_DIR', 'FORGE_PROJECT_ROOT', 'FORGE_STORE_ROOT']) delete process.env[k];

function w(root, rel, text) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
const ex = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const rd = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
function proj(name, forge) { const d = path.join(tmp, name); w(d, '.claude/config/orchestration/forge-canon.json', CANON); if (forge) fs.mkdirSync(path.join(d, '.forge'), { recursive: true }); return d; }
/** treeHash(dir) -> {rel: sha256} of every file below dir (the "nothing written here" proof). */
function treeHash(dir) {
  const out = {};
  (function walk(d) { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } })(dir);
  return out;
}
const diffTree = (a, b) => [...new Set(Object.keys(a).concat(Object.keys(b)))].filter((k) => a[k] !== b[k]).sort();
const ev = (o) => JSON.stringify(Object.assign({ timestamp: '2026-10-01T10:00:00.000Z', agent: 'Build Boss' }, o));
const fakeToken = () => 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3'; // assembled at runtime: no literal secret in this source
const OLD = new Date('2026-01-01T00:00:00Z');
function history(n) { const s = ['# Task history', '']; for (let i = n; i >= 1; i--) s.push('## 2026-09-' + String((i % 28) + 1).padStart(2, '0') + ' — entry ' + i, '', ('- line of real task history text for entry ' + i + '. ').repeat(24), ''); return s.join('\n'); }

// shared fixture content for both layouts
function seedRuns(root, runsRel) {
  w(root, runsRel + '/run-a/run.json', JSON.stringify({ run_id: 'run-a', request: 'Migrate the memory tools to the .forge layout', started_at: '2026-10-01T10:00:00Z' }));
  w(root, runsRel + '/run-a/events.jsonl', [
    ev({ run_id: 'run-a', event_type: 'run_started', note: 'Migrate the memory tools' }),
    ev({ run_id: 'run-a', event_type: 'wp_completed', wp_id: 'wp-1', status: 'done', note: 'export button shipped' }),
    ev({ run_id: 'run-a', event_type: 'mcp_grant_validated', note: 'gate ran' }),
  ].join('\n') + '\n');
}

const SC = require('./forge-scribe.cjs');
const SS = require('./forge-scribe-store.cjs');
const C = require('./forge-scribe-classify.cjs');
const V = require('./forge-vault.cjs');
const SN = require('./forge-snapshot.cjs');
const RI = require('./forge-snapshot-reinject.cjs');
const MC = require('./forge-memory-consolidate.cjs');
const TI = require('./forge-tool-index.cjs');
const R = require('./forge-retention.cjs');
const SCR = require('./forge-secret-scrub.cjs');
const MU = require('./forge-mcp-usage.cjs');
const D = require('./forge-distill.cjs');
const SB = require('./forge-secondbrain.cjs');
const H = require('./forge-harvest.cjs');
const PB = require('./forge-projectbrain.cjs');
const RM = require('./forge-repomap.cjs');
const K = require('./forge-killswitch.cjs');
const RP = require('./forge-rule-promotion.cjs');
const FP = require('./forge-paths.cjs');
const cfg = C.loadConfig();
const sopts = (root) => ({ root, config: cfg, source: 'cli', now: () => new Date('2026-10-01T11:00:00Z') });

/** scribeRoundTrip(root, runsRel) — capture (with a secret), classify/link/start, done with wp_completed evidence read
 *  from the run log, digest --write. Returns the captured rid. */
function scribeRoundTrip(root) {
  const cap = SC.capture('Please build a new export button on the dashboard, key ' + fakeToken(), sopts(root));
  let item = SC.list(sopts(root)).find((i) => i.rid === cap.rid);
  if (item && item.status === 'unclassified') { SC.transition(cap.rid, 'classify', { class: 'new' }, sopts(root)); item = SC.list(sopts(root)).find((i) => i.rid === cap.rid); }
  SC.transition(cap.rid, 'link', { wp_ids: ['wp-1'], run_id: 'run-a' }, sopts(root));
  SC.transition(cap.rid, 'start', {}, sopts(root));
  const done = SC.transition(cap.rid, 'done', { evidence: { type: 'wp_completed', ref: 'wp-1' }, run_id: 'run-a' }, sopts(root));
  SC.digest(Object.assign(sopts(root), { write: true }));
  return { cap, done };
}
const storePut = (claudeDir, store, id) => spawnSync(process.execPath, [path.join(BIN, 'forge-store.cjs'), 'put', store, id, JSON.stringify({ title: 'migration ' + id })], { encoding: 'utf8', env: Object.assign(env0(), { FORGE_STORE_ROOT: claudeDir }), timeout: 30000 });

try {
  // ======================================= FORGE layout =======================================
  console.log('FORGE layout (project with .forge/)');
  const P = proj('forge', true);
  seedRuns(P, '.forge/runs');
  w(P, '.claude/forge-runs/run-old/events.jsonl', ev({ run_id: 'run-old', event_type: 'scribe_head', _forge_verify: { scribe_head: { ledger_lines: 1, ledger_head: 'x', inbox_lines: 1, inbox_head: 'y' } } }) + '\n');
  fs.utimesSync(path.join(P, '.claude', 'forge-runs', 'run-old'), OLD, OLD);
  w(P, '.forge/runs/run-a/events.jsonl', rd(P, '.forge/runs/run-a/events.jsonl') + ev({ run_id: 'run-a', event_type: 'scribe_head', _forge_verify: { scribe_head: { ledger_lines: 1, ledger_head: 'x', inbox_lines: 1, inbox_head: 'y' } } }) + '\n');
  w(P, '.forge/runs/run-a/doctor.json', JSON.stringify({ ok: false }));
  w(P, '.forge/runs/_toollog/2026-10-01.jsonl', JSON.stringify({ tool: 'mcp__github__get_issue', ts: '2026-10-01T10:00:00Z' }) + '\n');
  w(P, '.forge/memory/FORGE_MEMORY.md', '# Memory\n\n## 2026-10-01 status\n\nThe memory tools moved to the forge layout today, all suites green.\n- leak ' + fakeToken() + '\n');
  w(P, '.forge/memory/FORGE_TASK_HISTORY.md', history(80));
  w(P, '.claude/FORGE_DECISIONS.md', '# Decisions\n\n## Store layout (run run-a — decided)\n\n- Runtime state moves to .forge only when a project opts in.\n');
  w(P, '.claude/FORGE_SNAPSHOT.md', '# old snapshot\n\n## 1. Mission\n' + SN.MISSION_BEGIN + '\nShip the opt-in .forge layout without breaking a single legacy project.\n' + SN.MISSION_END + '\n');
  w(P, '.claude/FORGE_KILLSWITCH_STATE.json', JSON.stringify({ engaged_at: '2026-10-01T00:00:00Z', disabled_tasks: [], stopped: [], port: 4100 }));
  for (const b of ['b1', 'b2']) { w(P, '.forge/backups/' + b + '/x.txt', b); fs.utimesSync(path.join(P, '.forge', 'backups', b), OLD, OLD); }
  w(P, '.claude/forge-backups/legacy-old/x.txt', 'must survive'); fs.utimesSync(path.join(P, '.claude', 'forge-backups', 'legacy-old'), OLD, OLD);
  fs.utimesSync(path.join(P, '.forge', 'runs', '_toollog', '2026-10-01.jsonl'), OLD, OLD);
  fs.utimesSync(path.join(P, '.forge', 'runs', '_toollog'), OLD, OLD); // not a run: never the "newest run" by mtime
  const claudeBefore = treeHash(path.join(P, '.claude'));

  section('F scribe', () => {
    const { cap, done } = scribeRoundTrip(P);
    t('F1 scribe capture writes the hash-chained inbox + ledger under .forge/scribe', ex(P, '.forge/scribe/inbox.jsonl') && ex(P, '.forge/scribe/ledger.jsonl') && ex(P, '.forge/scribe/state.json'), JSON.stringify(cap));
    t('F2 the done evidence (wp_completed) is read from the .forge/runs run log', done && done.status === 'done', JSON.stringify(done));
    t('F3 digest --write lands in .forge/scribe/DIGEST.md', ex(P, '.forge/scribe/DIGEST.md'));
    t('F4 the verbatim owner prompt in .forge/scribe is secret-scrubbed at capture (the token never reaches disk)', !rd(P, '.forge/scribe/inbox.jsonl').includes(fakeToken()) && rd(P, '.forge/scribe/inbox.jsonl').includes('export button'));
    const anchors = SC.anchorsOf(P).map((a) => a.run_id).sort();
    t('F5 run-log anchors are read from BOTH run folders (.forge/runs and the legacy one)', JSON.stringify(anchors) === JSON.stringify(['run-a', 'run-old']), JSON.stringify(anchors));
    t('F6 S.paths() names .forge/scribe', SS.paths(P).dir === path.join(P, '.forge', 'scribe'));
  });
  section('F store', () => {
    const r = storePut(path.join(P, '.claude'), 'tickets', 'T-1');
    t('F7 forge-store put (FORGE_STORE_ROOT=<project>/.claude) writes .forge/tickets/T-1.json + index.jsonl', r.status === 0 && ex(P, '.forge/tickets/T-1.json') && ex(P, '.forge/tickets/index.jsonl'), r.stderr);
  });
  section('F vault', () => {
    const r = V.updateVault(P, 'run-a', { configModule: null });
    t('F8 vault notes are written under .forge/vault (run note, decision note, Home.md)', r.ok && ex(P, '.forge/vault/runs/run-a.md') && ex(P, '.forge/vault/Home.md'), JSON.stringify(r));
    t('F9 vault reads the decisions log from its read path (the legacy .claude file, read only)', (r.decisions || []).length >= 1 && fs.readdirSync(path.join(P, '.forge', 'vault', 'decisions')).length >= 1, JSON.stringify(r));
    t('F10 statusOf() reports the .forge/vault folder', V.statusOf(P, { configModule: null }).dir === path.join(P, '.forge', 'vault'));
  });
  section('F snapshot', () => {
    const r = SN.write({ root: P, reason: 'manual', now: new Date('2026-10-02T00:00:00Z'), gitTimeoutMs: 500 });
    const txt = rd(P, '.forge/memory/FORGE_SNAPSHOT.md');
    t('F11 snapshot write goes to .forge/memory/FORGE_SNAPSHOT.md', r.path === path.join(P, '.forge', 'memory', 'FORGE_SNAPSHOT.md'));
    t('F12 the MISSION block is preserved from the legacy snapshot (read fallback)', txt.includes('Ship the opt-in .forge layout without breaking a single legacy project.'));
    t('F13 snapshot pointers name the .forge memory file', txt.includes('.forge/memory/FORGE_MEMORY.md'), txt.slice(0, 300));
    t('F14 check() reads the new snapshot', SN.check({ root: P }).path === path.join(P, '.forge', 'memory', 'FORGE_SNAPSHOT.md'));
  });
  section('F reinject', () => {
    const Q = proj('forge-reinject', true);
    w(Q, '.forge/memory/FORGE_SNAPSHOT.md', '# s\n\n## 1. Mission\nRe-inject me from the forge layout.\n\n## 3. Current state\nok\n\n## 8. Next actions\nnone\n');
    w(Q, '.claude/.forge-snapshot-due.json', JSON.stringify({ at: '2026-10-02T00:00:00Z', reason: 'auto' }));
    const r = RI.run({ projectRoot: Q, source: 'compact', claim: false, obligations: false, appendEvent: false, configModule: null });
    t('F15 snapshot-reinject prints the .forge snapshot and names its .forge pointer', r.printed && /Re-inject me from the forge layout/.test(r.text) && /\.forge\/memory\/FORGE_SNAPSHOT\.md/.test(r.text), r.text);
  });
  section('F consolidate', () => {
    const bk = path.join(tmp, 'bk-forge');
    const r = MC.run({ root: P, apply: true, backupDir: bk, now: '2026-10-02T00:00:00.000Z' });
    const arch = fs.readdirSync(path.join(P, '.forge', 'memory')).filter((n) => /^FORGE_TASK_HISTORY_ARCHIVE_/.test(n));
    t('F16 consolidate rotates the history where it is: archive beside it in .forge/memory', arch.length === 1 && r.plans.some((p) => p.archive === '.forge/memory/' + arch[0]), JSON.stringify(r.plans));
    t('F17 LESSONS.md is written to .forge/memory', ex(P, '.forge/memory/LESSONS.md') && r.lessons && r.lessons.file === '.forge/memory/LESSONS.md', JSON.stringify(r.lessons));
    const bkFiles = Object.keys(treeHash(bk));
    t('F18 the pre-consolidate backup never contains a .forge-named folder (no discovery marker, no ../ escape)', bkFiles.length >= 1 && bkFiles.every((f) => !f.split('/').includes('.forge') && !f.startsWith('..')), JSON.stringify(bkFiles));
    const v = MC.readArchive(fs.readFileSync(path.join(P, '.forge', 'memory', arch[0])));
    t('F19 the archive verifies (sha256 + line count of the moved bytes)', v.ok === true, v.reason);
  });
  section('F tool index', () => {
    const r = TI.ingest({ root: P, backend: 'jsonl' });
    const recs = fs.readFileSync(path.join(P, '.forge', 'index', 'tool-index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const refs = recs.map((x) => x.ref_path);
    t('F20 the index is written to .forge/index', r.ok && ex(P, '.forge/index/tool-index.jsonl') && ex(P, '.forge/index/state.json'), r.reason);
    t('F21 refs name the run folder each run was read from (.forge/runs and the legacy .claude/forge-runs)', refs.some((x) => x.startsWith('.forge/runs/run-a/')) && refs.some((x) => x.startsWith('.claude/forge-runs/run-old/')), JSON.stringify(refs));
    const okA = TI.resolve(refs.find((x) => x.startsWith('.forge/')), { root: P });
    const okOld = TI.resolve(refs.find((x) => x.startsWith('.claude/')), { root: P });
    t('F22 resolve() verifies a ref in either run folder', okA.ok && okOld.ok, JSON.stringify([okA.reason, okOld.reason]));
  });
  section('F readers', () => {
    const mu = MU.check({ root: P });
    t('F23 mcp-usage reads the tool ledger and gate events from .forge/runs', mu.ok && mu.usedTools.some((x) => x.tool === 'mcp__github__get_issue') && mu.validations.validated === 1, JSON.stringify(mu));
    const targets = SCR.projectTargets(P).map((f) => path.relative(P, f).split(path.sep).join('/'));
    t('F24 secret-scrub targets every run folder and every memory folder (.forge + legacy leftovers)', ['.forge/runs/run-a/events.jsonl', '.claude/forge-runs/run-old/events.jsonl', '.forge/memory/FORGE_MEMORY.md', '.claude/FORGE_DECISIONS.md'].every((x) => targets.includes(x)) && targets.some((x) => /^\.forge\/memory\/FORGE_TASK_HISTORY_ARCHIVE_/.test(x)), JSON.stringify(targets));
    const hits = SCR.scan(SCR.projectTargets(P)).hits.map((h) => path.relative(P, h.file).split(path.sep).join('/'));
    t('F25 a secret in .forge/memory is found (location only)', hits.includes('.forge/memory/FORGE_MEMORY.md'), JSON.stringify(hits));
    const dr = D.distillRun('run-a', { root: P, dryRun: true });
    const missing = D.distillRun('no-such-run', { root: P, dryRun: true });
    t('F26 distill reads the run from .forge/runs; a missing run names the .forge path', !dr.error && dr.totalEvents >= 3 && /\.forge/.test(String(missing.error)), JSON.stringify([dr.error, missing.error]));
    const doc = SB.checkDoctorReceipt({ project: 'p', path: P });
    const mem = SB.checkMemoryStaleness({ project: 'p', path: P }, { staleMemoryDays: 0 });
    t('F27 secondbrain evidence points at .forge/runs/<id>/doctor.json and .forge/memory/FORGE_MEMORY.md', doc.length === 1 && doc[0].evidence.file === '.forge/runs/run-a/doctor.json' && mem.length === 1 && mem[0].evidence.file === '.forge/memory/FORGE_MEMORY.md', JSON.stringify([doc, mem]));
    t('F28 killswitch: stop writes .forge/memory, restore still finds the legacy ledger (read path)', K.defaultStateFile(P) === path.join(P, '.forge', 'memory', 'FORGE_KILLSWITCH_STATE.json') && K.defaultStateFile(P, { read: true }) === path.join(P, '.claude', 'FORGE_KILLSWITCH_STATE.json') && K.restore({ root: P }).ok === true);
    const rp = RP.evaluate({ root: P, rules: HARD_RULES });
    t('F29 rule-promotion discovers runs in the .forge run folder', rp.runs_dir === path.join(P, '.forge', 'runs') && [].concat(rp.runs.not_completed, rp.runs.judged, rp.runs.not_real).includes('run-a'), JSON.stringify(rp.runs));
    const brain = PB.assemble({ projectDir: P });
    t('F30 projectbrain tells the project its memory lives in .forge/memory', brain.includes('`.forge/memory/FORGE_MEMORY.md`') && !brain.includes('Forge memory + governance live in `.claude/FORGE_*.md`'));
    const map = RM.map({ root: P });
    t('F31 repomap never walks into .forge (scribe inbox, runs, memory)', !map.files.some((f) => f.path === '.forge' || f.path.startsWith('.forge/')) && map.files.length > 0, JSON.stringify(map.files.map((f) => f.path)).slice(0, 300));
  });
  section('F mcp server', () => {
    const reqs = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forge_list_runs', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'forge://memory/FORGE_MEMORY.md' } },
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'forge://memory/inbox.jsonl' } },
    ];
    const r = spawnSync(process.execPath, [path.join(BIN, 'forge-mcp.cjs')], { input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', env: Object.assign(env0(), { FORGE_PROJECT_ROOT: P }), timeout: 30000 });
    const by = {}; for (const l of r.stdout.split('\n').filter(Boolean)) { try { const m = JSON.parse(l); by[m.id] = m; } catch { /* not json-rpc */ } }
    const runs = by[1] ? JSON.parse(by[1].result.content[0].text).runs.map((x) => x.id) : [];
    const uris = by[2] ? by[2].result.resources.map((x) => x.uri) : [];
    t('F32 the MCP server lists runs from both run folders', runs.includes('run-a') && runs.includes('run-old'), r.stdout.slice(0, 300) + r.stderr.slice(0, 200));
    t('F33 the MCP server shares the .forge memory file (redacted) and never the scribe inbox', uris.includes('forge://memory/FORGE_MEMORY.md') && by[3] && by[3].result && !by[3].result.contents[0].text.includes(fakeToken()) && by[4] && by[4].error && !uris.some((u) => /inbox/.test(u)), JSON.stringify([uris, by[4]]));
  });
  section('F retention', () => {
    const r = R.apply(P, 0, 0);
    t('F34 retention prunes only the active .forge folders (backups + _toollog)', r.backups.dir === path.join(P, '.forge', 'backups') && !ex(P, '.forge/backups/b1') && !ex(P, '.forge/runs/_toollog/2026-10-01.jsonl'), JSON.stringify(r));
    t('F35 a legacy backup batch is never touched in the forge layout', ex(P, '.claude/forge-backups/legacy-old/x.txt'));
  });
  section('F harvest', () => {
    const Q = path.join(tmp, 'portfolio', 'q'); w(Q, '.forge/memory/FORGE_MEMORY.md', '- A lesson that only lives in the forge layout memory file, with substance.\n'); fs.mkdirSync(path.join(Q, '.claude'), { recursive: true });
    const lessons = H.harvestProject({ project: 'q', path: Q });
    t('F36 harvest marks and reads a project whose memory lives only in .forge/memory', H.isMarkedProjectDir(Q) && lessons.some((l) => /forge layout memory file/.test(l.text)), JSON.stringify(lessons.map((l) => l.text)));
  });
  const claudeDiff = diffTree(claudeBefore, treeHash(path.join(P, '.claude')));
  t('F37 NOTHING under the forge project\'s .claude changed (no legacy folder or memory file written)', claudeDiff.length === 0, JSON.stringify(claudeDiff));

  // ======================================= LEGACY layout =======================================
  console.log('LEGACY layout (project without .forge/)');
  const L = proj('legacy', false);
  seedRuns(L, '.claude/forge-runs');
  w(L, '.claude/FORGE_MEMORY.md', '# Memory\n\n## 2026-10-01 status\n\nlegacy status line\n');
  section('L writes', () => {
    scribeRoundTrip(L);
    t('L1 scribe writes .claude/forge-scribe exactly as before', ex(L, '.claude/forge-scribe/inbox.jsonl') && ex(L, '.claude/forge-scribe/DIGEST.md') && SS.paths(L).dir === path.join(L, '.claude', 'forge-scribe'));
    const s = storePut(path.join(L, '.claude'), 'tickets', 'T-1');
    t('L2 forge-store writes .claude/forge-tickets', s.status === 0 && ex(L, '.claude/forge-tickets/T-1.json'), s.stderr);
    t('L3 vault writes .claude/forge-vault', V.updateVault(L, 'run-a', { configModule: null }).ok && ex(L, '.claude/forge-vault/Home.md'));
    const sn = SN.write({ root: L, reason: 'manual', now: new Date('2026-10-02T00:00:00Z'), gitTimeoutMs: 500 });
    t('L4 snapshot writes .claude/FORGE_SNAPSHOT.md with .claude pointers', sn.path === path.join(L, '.claude', 'FORGE_SNAPSHOT.md') && sn.markdown.includes('.claude/FORGE_MEMORY.md') && !sn.markdown.includes('.forge/'));
    const mc = MC.run({ root: L, apply: true, backupDir: path.join(tmp, 'bk-legacy'), now: '2026-10-02T00:00:00.000Z' });
    t('L5 consolidate writes .claude/LESSONS.md', ex(L, '.claude/LESSONS.md') && mc.lessons.file === '.claude/LESSONS.md');
    const ti = TI.ingest({ root: L, backend: 'jsonl' });
    const refs = fs.readFileSync(path.join(L, '.claude', 'forge-index', 'tool-index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).ref_path);
    t('L6 tool-index writes .claude/forge-index with .claude/forge-runs refs', ti.ok && refs.length >= 3 && refs.every((x) => x.startsWith('.claude/forge-runs/run-a/events.jsonl#L')), JSON.stringify(refs));
    t('L7 killswitch, retention and mcp-usage name the legacy locations', K.defaultStateFile(L) === path.join(L, '.claude', 'FORGE_KILLSWITCH_STATE.json') && R.scan(L, 5, 14).backups.dir === path.join(L, '.claude', 'forge-backups') && R.scan(L, 5, 14).toollog.dir === path.join(L, '.claude', 'forge-runs', '_toollog') && /\.claude\/forge-runs\/_toollog/.test(MU.check({ root: L }).reason));
    const brain = PB.assemble({ projectDir: L });
    t('L8 projectbrain text is unchanged for a legacy project', brain.includes('`.claude/FORGE_MEMORY.md`') && brain.includes('Forge memory + governance live in `.claude/FORGE_*.md`.'));
  });
  t('L9 no .forge folder was created anywhere in the legacy project (the layout never flips)', !fs.existsSync(path.join(L, '.forge')) && !Object.keys(treeHash(L)).some((f) => f.split('/').includes('.forge')));

  // ======================================= OLDER forge-paths (partial sync) =======================================
  console.log('OLDER forge-paths.cjs (a synced project from before WP 2.1)');
  section('O guard', () => {
    const O = proj('older', true);
    const ob = path.join(O, '.claude', 'forge-bin');
    fs.mkdirSync(ob, { recursive: true });
    for (const f of ['forge-scribe.cjs', 'forge-scribe-store.cjs', 'forge-scribe-classify.cjs', 'forge-store.cjs', 'forge-secret-scrub.cjs']) fs.copyFileSync(path.join(BIN, f), path.join(ob, f));
    fs.writeFileSync(path.join(ob, 'forge-paths.cjs'), "'use strict';\nmodule.exports = { resolve() { return null; }, resolveExisting() { return null; } }; // WP 1.2 shape: no stateDir\n");
    w(O, '.claude/config/orchestration/FORGE_SCRIBE.json', fs.readFileSync(SCRIBE_CFG, 'utf8'));
    const r = spawnSync(process.execPath, [path.join(ob, 'forge-scribe.cjs'), 'capture', '--text', 'Please add a status page for the gateway'], { cwd: O, encoding: 'utf8', env: env0(), timeout: 30000 });
    t('O1 an older forge-paths.cjs never crashes a tool: the legacy .claude/forge-scribe is used', r.status === 0 && ex(O, '.claude/forge-scribe/inbox.jsonl') && !ex(O, '.forge/scribe'), r.stderr + r.stdout);
  });

  // ======================================= PLUGIN layout =======================================
  console.log('PLUGIN layout (scripts outside the project)');
  const plugRoot = path.join(tmp, 'plug', 'cache', 'mkt', 'forge', '1.0.0');
  const scripts = path.join(plugRoot, 'scripts');
  fs.mkdirSync(path.join(plugRoot, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  for (const f of ['forge-paths.cjs', 'forge-store.cjs', 'forge-secret-scrub.cjs', 'forge-scribe.cjs', 'forge-scribe-store.cjs', 'forge-scribe-classify.cjs', 'forge-scribe-hook.cjs', 'forge-vault.cjs', 'forge-tool-index.cjs', 'forge-memory-consolidate.cjs']) fs.copyFileSync(path.join(BIN, f), path.join(scripts, f));
  w(plugRoot, 'config/orchestration/FORGE_SCRIBE.json', fs.readFileSync(SCRIBE_CFG, 'utf8'));
  const plugBefore = treeHash(path.join(tmp, 'plug'));
  const W = path.join(tmp, 'work'); fs.mkdirSync(path.join(W, '.claude'), { recursive: true }); fs.mkdirSync(path.join(W, 'src'), { recursive: true });
  const runP = (tool, args, cwd, extraEnv, input) => spawnSync(process.execPath, [path.join(scripts, tool)].concat(args), { cwd, input, encoding: 'utf8', env: Object.assign(env0(), extraEnv || {}), timeout: 30000 });
  section('P inside', () => {
    const hook = runP('forge-scribe-hook.cjs', [], path.join(W, 'src'), { CLAUDE_PROJECT_DIR: W }, JSON.stringify({ prompt: 'please add a gateway status page', session_id: 's1' }));
    t('P1 the plugin scribe hook exits 0 and captures nothing in a project without its own scribe (no fallback to the plugin copy)', hook.status === 0 && !ex(W, '.claude/forge-scribe'), hook.stderr);
    const st = runP('forge-store.cjs', ['put', 'tickets', 'T-9', '{"title":"from the plugin"}'], path.join(W, 'src'));
    t('P2 a plugin copy of forge-store with the cwd inside a project writes THAT project\'s store', st.status === 0 && ex(W, '.claude/forge-tickets/T-9.json'), st.stderr);
    const sc = runP('forge-scribe.cjs', ['capture', '--text', 'Please build a gateway status page'], path.join(W, 'src'));
    t('P3 a plugin copy of forge-scribe captures into the project it was started in', sc.status === 0 && ex(W, '.claude/forge-scribe/inbox.jsonl'), sc.stderr);
    const vs = runP('forge-vault.cjs', ['status', '--json'], path.join(W, 'src'));
    t('P4 a plugin copy of forge-vault reports the project\'s vault folder', vs.status === 0 && JSON.parse(vs.stdout).dir === path.join(W, '.claude', 'forge-vault'), vs.stdout + vs.stderr);
    const mc = runP('forge-memory-consolidate.cjs', ['--json'], path.join(W, 'src'));
    t('P5 a plugin copy of forge-memory-consolidate (dry run) acts on the project', mc.status === 0 && JSON.parse(mc.stdout).root === W, mc.stdout.slice(0, 200) + mc.stderr);
  });
  const OUTSIDE = [
    ['forge-store.cjs', ['put', 'tickets', 'T-0', '{"title":"x"}']], ['forge-scribe.cjs', ['capture', '--text', 'Please build something']],
    ['forge-vault.cjs', ['status']], ['forge-secret-scrub.cjs', []], ['forge-memory-consolidate.cjs', []], ['forge-tool-index.cjs', ['ingest']],
  ];
  const refusesAll = (dir, cwd, extraEnv) => OUTSIDE.map(([tool, args]) => [tool, spawnSync(process.execPath, [path.join(dir, tool)].concat(args), { cwd, encoding: 'utf8', env: Object.assign(env0(), extraEnv || {}), timeout: 30000 })])
    .filter(([, r]) => r.status === 0 || !/no project root|projectmap/i.test(r.stderr + r.stdout));
  section('P outside (real discovery)', () => {
    const N = path.join(tmp, 'nowhere', 'deep'); fs.mkdirSync(N, { recursive: true });
    const found = FP.findProjectRoot({ cwd: N, env: {} });
    if (found !== null) { console.log('  note P6 not run here: the temp folder lies inside a folder discovery accepts as a project (' + found + ')'); return; }
    const bad = refusesAll(scripts, N);
    t('P6 outside any project every plugin tool refuses with a clear "no project root found"', bad.length === 0, JSON.stringify(bad.map(([tool, r]) => [tool, r.status, (r.stderr + r.stdout).slice(0, 160)])));
  });
  section('P outside (no-project resolver)', () => {
    // Deterministic on every machine: the same copies with a forge-paths.cjs that answers "no project" (what the real
    // resolver returns outside every project — proven in forge-paths.test.cjs), so each TOOL's null-root path runs.
    const nullScripts = path.join(tmp, 'plug-null', 'cache', 'mkt', 'forge', '1.0.0', 'scripts');
    fs.mkdirSync(nullScripts, { recursive: true });
    for (const f of fs.readdirSync(scripts)) if (f !== 'forge-paths.cjs') fs.copyFileSync(path.join(scripts, f), path.join(nullScripts, f));
    w(path.dirname(nullScripts), 'config/orchestration/FORGE_SCRIBE.json', fs.readFileSync(SCRIBE_CFG, 'utf8'));
    fs.writeFileSync(path.join(nullScripts, 'forge-paths.cjs'), "'use strict';\nconst no = () => { throw new Error('no project'); };\n"
      + "module.exports = { scriptRoot: () => null, scriptRootInfo: () => ({ root: null, source: 'none' }), findProjectRoot: () => null, projectRootInfo: () => ({ root: null, source: 'none' }),\n"
      + "  stateDir: no, stateDirFor: no, existingStateDirs: no, memoryFile: no, memoryFileFor: no, layout: no, resolve: no, resolveExisting: no };\n");
    const nullBefore = treeHash(path.join(tmp, 'plug-null'));
    const N2 = path.join(tmp, 'nowhere2'); fs.mkdirSync(N2, { recursive: true });
    const bad = refusesAll(nullScripts, N2);
    t('P7 with no project root every plugin tool refuses with a clear "no project root found" (never a crash, never a guess)', bad.length === 0, JSON.stringify(bad.map(([tool, r]) => [tool, r.status, (r.stderr + r.stdout).slice(0, 200)])));
    const hook = spawnSync(process.execPath, [path.join(nullScripts, 'forge-scribe-hook.cjs')], { cwd: N2, input: JSON.stringify({ prompt: 'please add a page', session_id: 's' }), encoding: 'utf8', env: env0(), timeout: 30000 });
    t('P8 the scribe hook with no project root exits 0 silently', hook.status === 0 && hook.stdout.trim() === '', hook.stdout + hook.stderr);
    t('P9 nothing was created in the start folder or beside the scripts', Object.keys(treeHash(N2)).length === 0 && diffTree(nullBefore, treeHash(path.join(tmp, 'plug-null'))).length === 0);
  });
  const plugDiff = diffTree(plugBefore, treeHash(path.join(tmp, 'plug')));
  t('P10 NOTHING was written into the plugin (script) folder by any run above', plugDiff.length === 0, JSON.stringify(plugDiff));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
