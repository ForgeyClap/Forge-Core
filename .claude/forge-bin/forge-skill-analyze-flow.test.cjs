#!/usr/bin/env node
'use strict';
// forge-skill-analyze-flow.test.cjs — end-to-end test of forge-skill-analyze.cjs on a temp corpus:
// 100% coverage incl. bad lines, exact category counts, clusters that add up, our library, and the write guard.
const nodeTest = require('node:test');
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
const made = [];
nodeTest.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  console.log(passed + ' passed, ' + failed + ' failed');
});
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./forge-skill-analyze.cjs');

const SHIPS = { files: 1, scripts: {}, script_paths: [], hooks: [], mcp: [], package_json: [], binaries: 0, listing: 'deep',
  network: { files_scanned: 0, files_with_network: 0, markers: [], hosts: [] } };
const TDD = 'Write the failing test first, run it red, implement the smallest change, run it green, then refactor safely. '
  + 'Keep a regression test for every bug and run jest vitest or pytest before you call the work done. '
  + 'Each change starts with a written expectation, a reproduction of the defect, a minimal patch and a review of the diff by a peer, '
  + 'and the suite must stay fast enough to run on every save so that nobody is tempted to skip it before pushing a branch.';
const DEPLOY = 'Deploy the service to kubernetes with helm, watch the readiness probe and roll back on failure automatically. '
  + 'Use docker images tagged by commit and a github actions pipeline that gates on the smoke checks passing.';

function rec(id, name, desc, extra = {}) {
  return { id, name, description: desc, frontmatter: name ? { name, description: desc } : {}, repo: `o/${id}`, path: `skills/${id}/SKILL.md`,
    stars: 10, license: 'MIT', last_commit: '2026-10-20T00:00:00Z', pushed_at: '2026-10-20T00:00:00Z', is_fork: false,
    sources: ['codesearch'], ships: SHIPS, sha256: (id + '0'.repeat(64)).slice(0, 64), bytes: 900, copies: 1, also_at: [], ...extra };
}
const text = (r, body) => ({ sha256: r.sha256, repo: r.repo, path: r.path,
  text: `---\nname: ${r.name}\ndescription: ${r.description}\n---\n# ${r.name}\n## When to use\n${body}\n` });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsa-')); made.push(dir);
  const corpusDir = path.join(dir, 'skills-corpus'); const work = path.join(corpusDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const recs = [
    rec('t1', 'tdd-loop', 'Use when writing tests first with TDD'),
    rec('t2', 'tdd-loop-fork', 'Use when writing tests first with TDD', { stars: 500 }),
    rec('t3', 'deployer', 'Use when you deploy to kubernetes', { ships: { ...SHIPS, scripts: { '.sh': 1 }, script_paths: ['x/run.sh'] } }),
    rec('t4', 'zebra', 'Feeds a zebra'),
    rec('t5', null, null, { bytes: 15 }),
  ];
  const lines = recs.map((r) => JSON.stringify(r));
  lines.splice(2, 0, '{not json');
  fs.writeFileSync(path.join(corpusDir, 'corpus.jsonl'), lines.join('\n') + '\n\n');
  const texts = [text(recs[0], TDD), text(recs[1], TDD.replace('safely', 'carefully')), text(recs[2], DEPLOY), text(recs[3], 'zebra food')];
  fs.writeFileSync(path.join(work, 'texts-0of2.jsonl'), texts.slice(0, 2).map((t) => JSON.stringify(t)).join('\n') + '\n');
  fs.writeFileSync(path.join(work, 'texts-1of2.jsonl'), texts.slice(2).map((t) => JSON.stringify(t)).join('\n') + '\n');
  const home = path.join(dir, 'home'); const proj = path.join(dir, 'proj');
  const mk = (p, n, d) => { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'SKILL.md'), `---\nname: ${n}\ndescription: ${d}\n---\n# ${n}\n`); };
  mk(path.join(proj, '.claude', 'skills', 'forge-tdd'), 'forge-tdd', 'Use when writing tests first');
  mk(path.join(home, '.claude', 'skills', 'ecc', 'deploy-k8s'), 'deploy-k8s', 'Use when you deploy to kubernetes');
  const plug = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0');
  mk(path.join(plug, 'skills', 'seo-writer'), 'seo-writer', 'SEO marketing copy');
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: plug }] } }));
  return { dir, corpusDir, home, proj, out: path.join(corpusDir, 'analysis') };
}
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('analyze covers 100% of the lines: analysed + skipped equals records read, bad JSON is a named skip', async () => {
  const fx = fixture();
  const r = await A.analyze({ corpus: path.join(fx.corpusDir, 'corpus.jsonl'), out: fx.out, home: fx.home, projectRoot: fx.proj,
    now: Date.parse('2026-11-05T00:00:00Z') });
  const cov = readJ(path.join(fx.out, 'coverage.json'));
  assert.strictEqual(cov.records_read, 6);
  assert.strictEqual(cov.analysed, 5);
  assert.deepStrictEqual(cov.skipped, { bad_json: 1 });
  assert.strictEqual(cov.analysed + cov.skipped_total, cov.records_read);
  assert.strictEqual(cov.complete, true);
  assert.strictEqual(cov.text.found, 4); assert.strictEqual(cov.text.missing, 1);
  assert.strictEqual(r.analysed, 5);
  const feats = fs.readFileSync(path.join(fx.out, 'features.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(feats.length, 5);
  const t3 = feats.find((f) => f.id === 't3');
  assert.ok(t3.categories.includes('devops-deploy'));
  assert.strictEqual(t3.risk.flags.scripts, true); assert.strictEqual(t3.risk.risky, true);
  assert.ok(t3.quality.parts && typeof t3.quality.score === 'number');
  assert.match(t3.fingerprint, /^[0-9a-f]{32}$/);
  assert.deepStrictEqual(feats.find((f) => f.id === 't4').categories, ['other']);
});

test('dup groups, exact category counts and clusters that add up to the unique count', async () => {
  const fx = fixture();
  await A.analyze({ corpus: path.join(fx.corpusDir, 'corpus.jsonl'), out: fx.out, home: fx.home, projectRoot: fx.proj, now: Date.parse('2026-11-05T00:00:00Z') });
  const dup = readJ(path.join(fx.out, 'dup-groups.json'));
  assert.strictEqual(dup.groups.length, 1);
  assert.deepStrictEqual(dup.groups[0].members.map((m) => m.id).sort(), ['t1', 't2']);
  assert.strictEqual(dup.groups[0].best, 't2', 'more stars = higher quality = best copy');
  assert.ok(Array.isArray(dup.families), 'template families are reported beside the copy groups');
  const cats = readJ(path.join(fx.out, 'categories.json'));
  const tdd = cats.categories['tdd-testing'];
  assert.strictEqual(tdd.all, 2); assert.strictEqual(tdd.unique, 1); assert.strictEqual(tdd.risky, 0);
  assert.strictEqual(tdd.by_band.high + tdd.by_band.medium + tdd.by_band.low, tdd.all);
  assert.strictEqual(tdd.top[0].id, 't2');
  assert.strictEqual(cats.categories['devops-deploy'].risky, 1);
  assert.strictEqual(cats.totals.records, 5); assert.strictEqual(cats.totals.unique, 4);
  for (const [id, c] of Object.entries(cats.categories)) {
    if (!c.all) continue;
    const cl = readJ(path.join(fx.out, 'clusters', `${id}.json`));
    assert.strictEqual(cl.clusters.reduce((s, k) => s + k.count, 0), c.unique, id);
    for (const k of cl.clusters) assert.ok(k.representatives.length >= 1 && k.representatives.length <= cl.max_representatives);
  }
});

test('ours.json maps project, global/ecc and installed plugin skills onto the same categories', async () => {
  const fx = fixture();
  await A.analyze({ corpus: path.join(fx.corpusDir, 'corpus.jsonl'), out: fx.out, home: fx.home, projectRoot: fx.proj, now: Date.parse('2026-11-05T00:00:00Z') });
  const ours = readJ(path.join(fx.out, 'ours.json'));
  assert.deepStrictEqual(ours.skills.map((s) => s.source).sort(), ['ecc', 'plugin:p@m', 'project']);
  assert.strictEqual(ours.per_category['tdd-testing'].ours, 1);
  assert.strictEqual(ours.per_category['tdd-testing'].theirs_unique, 1);
  assert.strictEqual(ours.per_category['business-marketing'].ours, 1);
  assert.strictEqual(ours.per_category['business-marketing'].theirs_all, 0);
});

test('write guard: refuses an out dir that is the corpus dir or its work folder, and writes nothing else', async () => {
  const fx = fixture();
  const corpus = path.join(fx.corpusDir, 'corpus.jsonl');
  await assert.rejects(A.analyze({ corpus, out: path.join(fx.corpusDir, 'work'), home: fx.home, projectRoot: fx.proj }), /refus/i);
  await assert.rejects(A.analyze({ corpus, out: fx.corpusDir, home: fx.home, projectRoot: fx.proj }), /refus/i);
  const before = fs.readdirSync(fx.corpusDir).sort();
  await A.analyze({ corpus, out: fx.out, home: fx.home, projectRoot: fx.proj });
  assert.deepStrictEqual(fs.readdirSync(fx.corpusDir).sort(), [...before, 'analysis'].sort());
  assert.deepStrictEqual(fs.readdirSync(path.join(fx.corpusDir, 'work')).sort(), ['texts-0of2.jsonl', 'texts-1of2.jsonl']);
});

test('CLI: --help exits 0, an unknown option exits 2', async () => {
  assert.strictEqual(await A.main(['--help'], { log: () => {} }), 0);
  assert.strictEqual(await A.main(['--bogus'], { log: () => {}, err: () => {} }), 2);
});
