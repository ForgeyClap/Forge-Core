'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-brain.test.cjs — node:test for forge-brain.cjs (per-project digest + one central brain vault + mindmap).
// Every test builds throwaway fixture projects and a throwaway brain under os.tmpdir() and removes them file by file.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Guard (2026-11-13: a red run once fell through to the real ~/Documents/Forge-Brain and rewrote it): every call that
// reads process.env lands in a throwaway folder and a throwaway config home; the last test proves nothing was written there.
const GUARD_BRAIN = path.join(os.tmpdir(), 'fbrain-guard-' + process.pid);
process.env.FORGE_BRAIN_PATH = GUARD_BRAIN;
process.env.FORGE_CONFIG_HOME = path.join(os.tmpdir(), 'fbrain-guard-config-' + process.pid);
const B = require('./forge-brain.cjs');

// Count results so the doctor's tally check sees a '<n> passed, <m> failed' line (node:test's own summary reads as 0/0).
let pass = 0; let fail = 0;
function T(name, fn) { test(name, async (ctx) => { try { const r = await fn(ctx); pass++; return r; } catch (e) { fail++; throw e; } }); }
process.on('exit', () => { console.log(pass + ' passed, ' + fail + ' failed (forge-brain)'); });

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlZmFrZTEyMzQ1Njc4OTA';
const ENV_SECRET = 'sk-envSECRETvalue1234567890abcdef'; // FAKE test fixture (reviewed for the public release verify)

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}
function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmTree(p); else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
function treeHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of walk(dir).sort()) { h.update(path.relative(dir, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex');
}
function events(lines) { return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'; }

/** A Forge project with two real runs, decisions, agent memory, scribe asks and a .env that must never be read. */
function makeProject(base, name, o = {}) {
  const root = path.join(base, name);
  write(root, '.claude/FORGE_VERSION.json', { version: 'v11' });
  write(root, '.claude/FORGE_PROJECT_PROFILE.md', '# Forge Project Profile\n\n- **Project name:** ' + name + '\n- **Project type:** ' + (o.type || 'website') + '\n- **Stack:** Astro\n');
  write(root, '.env', 'API_KEY=' + ENV_SECRET + '\n');
  write(root, '.claude/forge-runs/forge-2026-11-01-alpha/events.jsonl', events([
    { run_id: 'forge-2026-11-01-alpha', event_type: 'run_started', agent: 'orchestrator', goal: 'Build the landing page ' + name, timestamp: '2026-11-01T10:00:00Z' },
    { run_id: 'forge-2026-11-01-alpha', event_type: 'agent_started', agent: 'Build Boss', skill: 'forge-website, forge-craft', timestamp: '2026-11-01T10:01:00Z' },
    { run_id: 'forge-2026-11-01-alpha', event_type: 'run_completed', agent: 'orchestrator', status: 'done', timestamp: '2026-11-01T11:00:00Z' },
    { run_id: 'forge-2026-11-01-alpha', event_type: 'run_finalized', agent: 'orchestrator', timestamp: '2026-11-01T11:01:00Z' },
  ]));
  write(root, '.claude/forge-runs/forge-2026-11-05-beta/events.jsonl', events([
    { run_id: 'forge-2026-11-05-beta', event_type: 'run_started', agent: 'orchestrator', goal: 'Fix the contact form', timestamp: '2026-11-05T09:00:00Z' },
    { run_id: 'forge-2026-11-05-beta', event_type: 'agent_started', agent: o.agent || 'Test Boss', skill: o.skill || 'forge-testing', timestamp: '2026-11-05T09:01:00Z' },
  ]));
  write(root, '.claude/forge-runs/_hooks/events.jsonl', events([{ event_type: 'run_started', goal: 'not a run' }]));
  write(root, '.claude/FORGE_DECISIONS.md', '# Forge Decisions Log\n\n| Date/time | Decision | Reason | Impact |\n|---|---|---|---|\n| 2026-11-01 | Use Astro | Static and fast | site |\n| 2026-11-02 | Token ' + FAKE_JWT + ' never stored | safety | none |\n');
  write(root, '.claude/agent-memory/build-boss/MEMORY.md', '# Build Boss memory\n\n- 2026-11-01 Run the full suite, not only the new file.\n- 2026-11-02 Leaked ' + FAKE_JWT + ' in a log once.\n' + (o.lesson ? '- ' + o.lesson + '\n' : ''));
  write(root, '.claude/forge-scribe/state.json', { items: [{ rid: 'R-0001', status: 'open' }, { rid: 'R-0002', status: 'acked' }, { rid: 'R-0003', status: 'planned' }] });
  return root;
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fbrain-'));
  return { base, docs: path.join(base, 'Documents'), brain: path.join(base, 'Forge-Brain') };
}

// A config home with no FORGE_CONFIG.json: the owner's real ~/.claude settings never leak into a test.
const NO_CFG = { FORGE_CONFIG_HOME: path.join(os.tmpdir(), 'fbrain-no-config-home') };
const DEFAULT_BRAIN = path.join(os.homedir(), 'Documents', 'Forge-Brain');
/** A stand-in for forge-config.cjs: safeGet('brain-path') answers `value`, or throws when value is an Error. */
function fakeConfig(value, seen = []) {
  return { safeGet(key, o) { seen.push([key, o]); if (value instanceof Error) throw value; return { key, value, source: 'global', degraded: false, reason: null, notes: [] }; } };
}

T('brainPath: FORGE_BRAIN_PATH wins, default is <home>/Documents/Forge-Brain', () => {
  assert.strictEqual(B.brainPath({ FORGE_BRAIN_PATH: '/x/brain' }), path.resolve('/x/brain'));
  assert.strictEqual(B.brainPath(NO_CFG), DEFAULT_BRAIN);
});

T('brainLocation: env var beats the brain-path setting, the setting beats the default', () => {
  const vault = path.join(os.tmpdir(), 'Big BRain!');
  const seen = [];
  assert.deepStrictEqual(B.brainLocation({ FORGE_BRAIN_PATH: '/x/brain' }, { config: fakeConfig(vault) }), { path: path.resolve('/x/brain'), source: 'env' });
  assert.deepStrictEqual(B.brainLocation(NO_CFG, { config: fakeConfig(vault, seen) }), { path: vault, source: 'setting' });
  assert.strictEqual(seen[0][0], 'brain-path', 'the setting is read by its schema key');
  assert.strictEqual(seen[0][1].configHome, NO_CFG.FORGE_CONFIG_HOME, 'the env object picks the config home');
  assert.deepStrictEqual(B.brainLocation(NO_CFG, { config: fakeConfig('') }), { path: DEFAULT_BRAIN, source: 'default' });
});

T('brainLocation: a read failure, a relative or a non-string value fall back silently to the default', () => {
  for (const v of [new Error('config broken'), 'relative/brain', 42, null]) {
    assert.deepStrictEqual(B.brainLocation(NO_CFG, { config: fakeConfig(v) }), { path: DEFAULT_BRAIN, source: 'default' }, String(v));
  }
  // the real forge-config.cjs with an empty config home: no brain-path value, so the default, and no throw
  assert.deepStrictEqual(B.brainLocation(NO_CFG), { path: DEFAULT_BRAIN, source: 'default' });
});

T('sync: a brain-path folder that does not exist is refused in one line and nothing is written', () => {
  const { base, docs } = setup();
  try {
    makeProject(docs, 'Shop One');
    const vault = path.join(base, 'X-drive', 'Big BRain!');
    const opts = { env: NO_CFG, config: fakeConfig(vault), scanRoots: [docs], registryFile: path.join(base, 'none.json') };
    const r = B.sync(opts);
    assert.strictEqual(r.written, 0);
    assert.match(r.refused, /does not exist/);
    assert.ok(r.refused.includes(vault) && /brain-path/.test(r.refused) && !r.refused.includes('\n'), r.refused);
    assert.ok(!fs.existsSync(path.join(base, 'X-drive')), 'no folder is created');
    const a = B.afterRun(makeProject(docs, 'Shop Two'), Object.assign({ force: true }, opts));
    assert.match(String(a.syncRefused), /does not exist/, JSON.stringify(a));
    assert.ok(!fs.existsSync(path.join(base, 'X-drive')), 'afterRun creates nothing either');
    const own = path.join(base, 'own');
    write(own, '.claude/forge-bin/forge-brain.cjs', '// present\n');
    const w = B.brainWired(own, { env: NO_CFG, config: fakeConfig(vault) });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.source, 'setting');
    assert.ok(w.problems.join(' ').includes(vault) && /brain-path/.test(w.problems.join(' ')), JSON.stringify(w.problems));
  } finally { rmTree(base); }
});

T('sync: into an existing brain-path vault; the owner notes there are never touched, also not by the stale-note cleanup', () => {
  const { base, docs } = setup();
  try {
    makeProject(docs, 'Shop One');
    const gone = makeProject(docs, 'Game Two', { skill: 'forge-game' });
    const vault = path.join(base, 'Big BRain!');
    write(vault, '.obsidian/app.json', { theme: 'dark' });
    write(vault, 'Daily/2026-11-12.md', '# my day\n');
    write(vault, 'Ideas.md', '---\ntags:\n  - idea\n---\n# Ideas\n\ngenerated: forge-brain is quoted here, outside the frontmatter\n');
    write(vault, 'skills/forge-game.md', '# my own notes on forge-game\n');
    write(vault, 'Brain-Home.md', '# my own home page\n');
    const own = () => treeHash(path.join(vault, '.obsidian')) + [ 'Daily/2026-11-12.md', 'Ideas.md', 'skills/forge-game.md', 'Brain-Home.md'].map((f) => fs.readFileSync(path.join(vault, f), 'utf8')).join('|');
    const before = own();
    const opts = { env: NO_CFG, config: fakeConfig(vault), scanRoots: [docs], registryFile: path.join(base, 'none.json') };
    const r1 = B.sync(opts);
    assert.strictEqual(r1.brain, vault);
    assert.ok(fs.existsSync(path.join(vault, 'projects/shop-one/Project.md')), 'the brain is written into the vault');
    assert.deepStrictEqual(r1.kept.sort(), ['Brain-Home.md', 'skills/forge-game.md'], 'a hand-written note at a generated path is kept, not overwritten');
    rmTree(gone);
    const r2 = B.sync(opts);
    assert.ok(r2.removed >= 1, 'generated notes of the gone project are cleaned');
    assert.ok(!fs.existsSync(path.join(vault, 'projects/game-two/Project.md')));
    assert.strictEqual(own(), before, 'owner notes and .obsidian are byte-identical');
  } finally { rmTree(base); }
});

T('harvest: runs, decisions, lessons, open asks, skills and agents; never a secret, never .env', () => {
  const { base, docs } = setup();
  try {
    const root = makeProject(docs, 'Shop One');
    const d = B.harvest(root);
    assert.strictEqual(d.name, 'Shop One');
    assert.strictEqual(d.type, 'website');
    assert.strictEqual(d.runCount, 2, 'the _hooks folder is not a run');
    assert.deepStrictEqual(d.runs.map((r) => [r.id, r.status]), [['forge-2026-11-05-beta', 'open'], ['forge-2026-11-01-alpha', 'finalized']]);
    assert.strictEqual(d.runs[1].goal, 'Build the landing page Shop One');
    assert.strictEqual(d.openAsks, 2, 'open + planned are open; acked is closed');
    assert.deepStrictEqual(d.skills, ['forge-craft', 'forge-testing', 'forge-website']);
    assert.deepStrictEqual(d.agents, ['build-boss', 'test-boss'], 'orchestrator is the Lead, not an agent');
    assert.strictEqual(d.decisions.length, 2);
    assert.strictEqual(d.decisions[0].decision, 'Use Astro');
    assert.ok(d.lessons['build-boss'].some((l) => /full suite/.test(l)));
    const all = JSON.stringify(d);
    assert.ok(!all.includes(FAKE_JWT), 'JWT scrubbed');
    assert.ok(!all.includes(ENV_SECRET), '.env never read');
  } finally { rmTree(base); }
});

T('harvest: a lane label like db-boss-wp0607 counts as the agent itself', () => {
  const { base, docs } = setup();
  try {
    const d = B.harvest(makeProject(docs, 'Shop One', { agent: 'db-boss-wp0607' }));
    assert.deepStrictEqual(d.agents, ['build-boss', 'db-boss']);
  } finally { rmTree(base); }
});

T('harvest: an unfilled template type is unknown; links from another vault become plain text', () => {
  const { base, docs } = setup();
  try {
    const root = makeProject(docs, 'Shop One', { type: '<website | landing | full-stack>', lesson: 'See [Catalog batch](catalog-batch.md) and [[map/agents/x|the x note]].' });
    const d = B.harvest(root);
    assert.strictEqual(d.type, 'unknown');
    assert.ok(d.lessons['build-boss'].includes('See Catalog batch and the x note.'), JSON.stringify(d.lessons));
  } finally { rmTree(base); }
});

T('project: writes the project digest and the project vault map; a second call writes nothing', () => {
  const { base, docs } = setup();
  try {
    const root = makeProject(docs, 'Shop One');
    const r1 = B.project({ root, date: '2026-11-11' });
    const digest = path.join(root, '.claude', 'forge-vault', 'brain', 'Project-Digest.md');
    assert.ok(r1.written >= 1);
    const text = fs.readFileSync(digest, 'utf8');
    assert.match(text, /# Shop One/);
    assert.match(text, /forge-2026-11-01-alpha/);
    assert.match(text, /Open owner asks: 2/);
    assert.ok(!text.includes(FAKE_JWT) && !text.includes(ENV_SECRET));
    assert.ok(fs.existsSync(path.join(root, '.claude', 'forge-vault', 'map', 'Map-Home.md')), 'vault map generated');
    const r2 = B.project({ root, date: '2026-11-11' });
    assert.strictEqual(r2.written, 0, 'idempotent');
  } finally { rmTree(base); }
});

T('discover: marker projects one level deep; skips node_modules, backups, e2e and test folders without real runs', () => {
  const { base, docs } = setup();
  try {
    makeProject(docs, 'Shop One');
    write(docs, 'stress-test-1/.claude/FORGE_VERSION.json', {});
    makeProject(docs, 'game-test');
    write(docs, 'node_modules/.claude/FORGE_VERSION.json', {});
    write(docs, 'forge-backups-2026/.claude/FORGE_VERSION.json', {});
    write(docs, 'Forge-e2e-abc/.claude/forge-runs/x/events.jsonl', events([{ event_type: 'run_started' }]));
    write(docs, 'plain-folder/readme.txt', 'no forge here');
    write(docs, 'deep/inner/.claude/FORGE_VERSION.json', {});
    const r = B.discover({ scanRoots: [docs, path.join(base, 'missing')], registryFile: path.join(base, 'none.json') });
    assert.deepStrictEqual(r.projects.map((p) => path.basename(p.root)).sort(), ['Shop One', 'game-test']);
    const skipped = Object.fromEntries(r.skipped.map((s) => [path.basename(s.path), s.reason]));
    assert.match(skipped['stress-test-1'], /test or stress folder without real runs/);
    assert.match(skipped['node_modules'], /excluded name/);
    assert.match(skipped['forge-backups-2026'], /excluded name/);
    assert.match(skipped['Forge-e2e-abc'], /excluded name/);
    assert.ok(!('plain-folder' in skipped), 'a folder without a Forge marker is not noise in the skip list');
  } finally { rmTree(base); }
});

T('discover: the installer registry, when present, is the project list', () => {
  const { base, docs } = setup();
  try {
    const a = makeProject(docs, 'Shop One');
    makeProject(docs, 'Shop Two');
    write(base, 'projects.json', { schema: 1, projects: [a, path.join(base, 'gone')] });
    const r = B.discover({ scanRoots: [docs], registryFile: path.join(base, 'projects.json') });
    assert.deepStrictEqual(r.projects.map((p) => path.basename(p.root)), ['Shop One']);
    assert.strictEqual(r.source, 'registry');
    assert.ok(r.skipped.some((s) => /gone$/.test(s.path) && /not a Forge project/.test(s.reason)));
  } finally { rmTree(base); }
});

T('sync: one central brain with projects, skills, agents, deduped lessons and a valid canvas; read-only on projects; idempotent', () => {
  const { base, docs, brain } = setup();
  try {
    const shared = 'Always run the whole suite before you call it done.';
    const a = makeProject(docs, 'Shop One', { lesson: '2026-11-03 ' + shared });
    const b = makeProject(docs, 'Game Two', { type: 'game', skill: 'forge-game', agent: 'UI Boss', lesson: '2026-11-04 ' + shared });
    const before = [treeHash(a), treeHash(b)];
    const r = B.sync({ brain, scanRoots: [docs], registryFile: path.join(base, 'none.json'), now: new Date('2026-11-11T12:00:00Z') });
    assert.deepStrictEqual([treeHash(a), treeHash(b)], before, 'sync never writes into a project');
    assert.strictEqual(r.projects.length, 2);
    for (const f of ['Brain-Home.md', 'Brain-Mindmap.canvas', 'projects/shop-one/Project.md', 'projects/shop-one/Runs.md', 'projects/shop-one/Decisions.md', 'projects/shop-one/Lessons.md', 'projects/game-two/Project.md', 'skills/forge-craft.md', 'skills/forge-game.md', 'agents/build-boss.md', 'agents/ui-boss.md', 'lessons/build-boss.md', 'brain-state.json']) {
      assert.ok(fs.existsSync(path.join(brain, f)), f + ' exists');
    }
    const craft = fs.readFileSync(path.join(brain, 'skills/forge-craft.md'), 'utf8');
    assert.match(craft, /\[\[projects\/shop-one\/Project\|Shop One\]\]/);
    assert.match(craft, /\[\[projects\/game-two\/Project\|Game Two\]\]/);
    const lessons = fs.readFileSync(path.join(brain, 'lessons/build-boss.md'), 'utf8');
    assert.strictEqual(lessons.split(shared).length - 1, 1, 'the shared lesson is listed once');
    assert.match(lessons, /shared by 2 projects/);
    const home = fs.readFileSync(path.join(brain, 'Brain-Home.md'), 'utf8');
    assert.match(home, /\[\[projects\/game-two\/Project\|Game Two\]\]/);
    const cv = JSON.parse(fs.readFileSync(path.join(brain, 'Brain-Mindmap.canvas'), 'utf8'));
    const ids = new Set(cv.nodes.map((n) => n.id));
    assert.ok(cv.nodes.some((n) => n.type === 'file' && n.file === 'projects/shop-one/Project.md'));
    assert.ok(cv.nodes.some((n) => n.type === 'group' && /^Projects/.test(n.label)));
    assert.ok(cv.edges.length > 0 && cv.edges.every((e) => ids.has(e.fromNode) && ids.has(e.toNode)), 'every edge joins two real nodes');
    assert.ok(cv.nodes.every((n) => n.type !== 'file' || fs.existsSync(path.join(brain, n.file))));
    const all = walk(brain).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    assert.ok(!all.includes(FAKE_JWT) && !all.includes(ENV_SECRET), 'no secret reaches the brain');
    assert.deepStrictEqual(B.check(brain), { dead: [], secrets: [] });
    const r2 = B.sync({ brain, scanRoots: [docs], registryFile: path.join(base, 'none.json'), now: new Date('2026-11-11T13:00:00Z') });
    assert.strictEqual(r2.written, 0, 'only the sync receipt changes on a second run');
  } finally { rmTree(base); }
});

T('sync: a project that is gone loses its generated notes (single files); a hand-written note stays', () => {
  const { base, docs, brain } = setup();
  try {
    makeProject(docs, 'Shop One');
    const b = makeProject(docs, 'Game Two', { skill: 'forge-game' });
    const opts = { brain, scanRoots: [docs], registryFile: path.join(base, 'none.json') };
    B.sync(opts);
    write(brain, 'my-own-note.md', '# mine\n');
    rmTree(b);
    const r = B.sync(opts);
    assert.ok(r.removed >= 4);
    assert.ok(!fs.existsSync(path.join(brain, 'projects/game-two/Project.md')));
    assert.ok(!fs.existsSync(path.join(brain, 'skills/forge-game.md')));
    assert.ok(fs.existsSync(path.join(brain, 'my-own-note.md')));
    assert.deepStrictEqual(B.check(brain).dead, []);
  } finally { rmTree(base); }
});

T('sync: two projects with the same folder name get distinct slugs', () => {
  const { base, docs, brain } = setup();
  try {
    makeProject(docs, 'site');
    makeProject(path.join(base, 'Desktop'), 'site');
    const r = B.sync({ brain, scanRoots: [docs, path.join(base, 'Desktop')], registryFile: path.join(base, 'none.json') });
    const slugs = r.projects.map((p) => p.slug).sort();
    assert.strictEqual(new Set(slugs).size, 2, JSON.stringify(slugs));
  } finally { rmTree(base); }
});

T('check: finds a dead wikilink and a secret pattern in the brain', () => {
  const { base, brain } = setup();
  try {
    write(brain, 'Brain-Home.md', '# Brain\n\nSee [[projects/nope/Project]].\n');
    write(brain, 'leak.md', 'token ' + FAKE_JWT + '\n');
    const r = B.check(brain);
    assert.deepStrictEqual(r.dead, ['Brain-Home.md -> projects/nope/Project']);
    assert.deepStrictEqual(r.secrets, ['leak.md']);
  } finally { rmTree(base); }
});

T('brainWired: missing brain, stale sync and a secret are named problems; a fresh clean brain is ok', () => {
  const { base, docs, brain } = setup();
  try {
    const own = path.join(base, 'own');
    write(own, '.claude/forge-bin/forge-brain.cjs', '// present\n');
    const none = B.brainWired(path.join(base, 'no-tool'), { brain });
    assert.strictEqual(none.applicable, false);
    const missing = B.brainWired(own, { brain });
    assert.strictEqual(missing.ok, false);
    assert.match(missing.problems.join(' '), /Brain-Home\.md/);
    makeProject(docs, 'Shop One');
    B.sync({ brain, scanRoots: [docs], registryFile: path.join(base, 'none.json'), now: new Date('2026-11-11T12:00:00Z') });
    const fresh = B.brainWired(own, { brain, now: new Date('2026-11-12T12:00:00Z') });
    assert.strictEqual(fresh.ok, true, JSON.stringify(fresh));
    assert.strictEqual(fresh.projects, 1);
    const stale = B.brainWired(own, { brain, now: new Date('2026-11-19T12:00:01Z') });
    assert.strictEqual(stale.ok, false);
    assert.match(stale.problems.join(' '), /older than 7 days/);
    write(brain, 'leak.md', FAKE_JWT);
    const leak = B.brainWired(own, { brain, now: new Date('2026-11-12T12:00:00Z') });
    assert.match(leak.problems.join(' '), /secret-like text in 1 file/);
  } finally { rmTree(base); }
});

T('afterRun: off switch and temp roots never touch the central brain', () => {
  const { base, docs, brain } = setup();
  try {
    const root = makeProject(docs, 'Shop One');
    assert.strictEqual(B.afterRun(root, { env: { FORGE_BRAIN: 'off', FORGE_BRAIN_PATH: brain } }).skipped, 'FORGE_BRAIN=off');
    const tmp = B.afterRun(root, { env: { FORGE_BRAIN_PATH: brain } });
    assert.match(String(tmp.skipped), /temp folder/);
    assert.ok(!fs.existsSync(brain));
    // FB-BRAIN-F3: the owner's vault setting off means no vault map, no digest and no central brain sync
    const seen = [];
    const off = B.afterRun(root, { env: { FORGE_BRAIN_PATH: brain }, force: true, config: fakeConfig(false, seen), scanRoots: [docs], registryFile: path.join(base, 'none.json') });
    assert.match(String(off.skipped), /vault off/, JSON.stringify(off));
    assert.ok(seen.some(([k]) => k === 'vault'), 'the vault setting is read: ' + JSON.stringify(seen.map(([k]) => k)));
    assert.ok(!fs.existsSync(brain) && !fs.existsSync(path.join(root, '.claude', 'forge-vault')), 'nothing written with vault off');
    const forced = B.afterRun(root, { env: { FORGE_BRAIN_PATH: brain }, force: true, scanRoots: [docs], registryFile: path.join(base, 'none.json') });
    assert.ok(forced.project && forced.sync, JSON.stringify(forced));
    assert.ok(fs.existsSync(path.join(brain, 'Brain-Home.md')));
    const again = B.afterRun(root, { env: { FORGE_BRAIN_PATH: brain }, force: true, scanRoots: [docs], registryFile: path.join(base, 'none.json') });
    assert.match(String(again.syncSkipped), /synced less than/, 'sync is throttled');
  } finally { rmTree(base); }
});

T('guard: no test wrote a brain through process.env (the real brain is never a test target)', () => {
  assert.ok(!fs.existsSync(GUARD_BRAIN), 'a test fell through to process.env and wrote ' + GUARD_BRAIN);
});
