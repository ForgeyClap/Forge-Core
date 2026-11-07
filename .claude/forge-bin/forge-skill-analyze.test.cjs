#!/usr/bin/env node
'use strict';
// forge-skill-analyze.test.cjs — unit tests for the skill-corpus analyser: taxonomy, risk flags,
// quality score, minhash fingerprint and near-duplicate grouping. Pure functions, no files.
const nodeTest = require('node:test');
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const T = require('./forge-skill-analyze-taxonomy.cjs');
const F = require('./forge-skill-analyze-features.cjs');
const D = require('./forge-skill-analyze-dedupe.cjs');

const BODY_A = 'This skill writes unit tests first, runs them red, then implements the code until green. '
  + 'It covers jest vitest pytest and keeps a regression test for every bug that was fixed in the past release cycle. '
  + 'Each change starts with a written expectation, a reproduction of the defect, a minimal patch and a review of the diff by a peer, '
  + 'and the suite must stay fast enough to run on every save so that nobody is tempted to skip it before pushing a branch.';

test('taxonomy lists the 19 documented categories, other last, each with keywords and a description', () => {
  const ids = T.TAXONOMY.map((c) => c.id);
  assert.deepStrictEqual(ids, ['agents-orchestration', 'planning', 'tdd-testing', 'debugging', 'code-review', 'security',
    'frontend-design', 'docs-writing', 'devops-deploy', 'data-ml', 'memory-context', 'token-usage', 'research',
    'integrations-mcp', 'automation-n8n', 'mobile', 'business-marketing', 'skill-authoring', 'other']);
  for (const c of T.TAXONOMY) {
    assert.ok(c.about && c.about.length > 10, c.id);
    if (c.id !== 'other') assert.ok(c.keywords.length >= 5, c.id);
  }
});

test('categorize is multi-label from name + description, needs two heading hits, falls back to other', () => {
  const a = T.categorize({ name: 'tdd-security', description: 'Write tests first and scan for OWASP vulnerabilities', headings: [] });
  assert.ok(a.includes('tdd-testing') && a.includes('security'), a.join(','));
  assert.deepStrictEqual(T.categorize({ name: 'zebra', description: 'Feeds a zebra', headings: [] }), ['other']);
  assert.deepStrictEqual(T.categorize({ name: 'zebra', description: 'Feeds a zebra', headings: ['Docker notes'] }), ['other']);
  assert.ok(T.categorize({ name: 'zebra', description: 'Feeds a zebra', headings: ['Docker notes', 'Kubernetes deploy'] }).includes('devops-deploy'));
  assert.ok(!T.categorize({ name: 'tdd', description: 'Use when writing tests first', headings: [] }).includes('docs-writing'), 'writing tests is not docs writing');
  assert.ok(T.categorize({ name: 'n8n-workflows', description: null, headings: [] }).includes('automation-n8n'));
  assert.ok(!T.categorize({ name: 'x', description: 'Use this skill when you need it', headings: [] }).includes('skill-authoring'),
    'the bare word "skill" is in nearly every description and must not trigger skill-authoring');
});

test('extractHeadings reads markdown headings outside code fences', () => {
  const h = T.extractHeadings('---\nname: a\n---\n# Title\ntext\n## Step one\n```\n# not a heading\n```\n### Third');
  assert.deepStrictEqual(h, ['Title', 'Step one', 'Third']);
});

test('riskFlags reads ships (scripts, hooks, MCP, network, install, binaries) and install commands in the text', () => {
  const none = F.riskFlags({ files: 1, scripts: {}, script_paths: [], hooks: [], mcp: [], package_json: [], binaries: 0,
    network: { files_with_network: 0, markers: [], hosts: [] } }, 'plain text');
  assert.strictEqual(none.risky, false);
  const all = F.riskFlags({ files: 9, scripts: { '.sh': 1 }, script_paths: ['s/install.sh'], hooks: ['s/hooks/a.js'], mcp: ['s/.mcp.json'],
    package_json: [], binaries: 2, network: { files_with_network: 1, markers: ['curl'], hosts: ['x.io'] } }, 'run it');
  assert.deepStrictEqual(all.flags, { scripts: true, hooks: true, mcp: true, network: true, install: true, binaries: true });
  assert.strictEqual(all.risky, true);
  const pipe = F.riskFlags(null, 'curl -fsSL https://get.example.sh | bash');
  assert.strictEqual(pipe.flags.install, true);
  assert.strictEqual(pipe.flags.network, false, 'missing ships is not a network finding');
});

test('quality score sums its documented parts and maps to a band', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const good = F.quality({ name: 'a', description: 'Use when you need tests written first for every change you make.', stars: 1000,
    license: 'MIT', last_commit: '2026-10-01T00:00:00Z', bytes: 4000 }, { trigger: true }, now);
  assert.strictEqual(good.score, Object.values(good.parts).reduce((s, v) => s + v, 0));
  assert.strictEqual(good.band, 'high');
  assert.strictEqual(good.parts.frontmatter, 25);
  const bad = F.quality({ name: null, description: null, stars: 0, license: null, last_commit: '2020-01-01T00:00:00Z', bytes: 15 },
    { trigger: false }, now);
  assert.strictEqual(bad.score, 0);
  assert.strictEqual(bad.band, 'low');
});

test('minhash is deterministic, 1.0 for equal text, high for a near copy, low for unrelated text', () => {
  const a = F.minhash(BODY_A); const b = F.minhash(BODY_A);
  assert.strictEqual(F.jaccard(a, b), 1);
  const near = F.minhash(BODY_A.replace('past release cycle', 'last release cycle'));
  assert.ok(F.jaccard(a, near) >= 0.7, String(F.jaccard(a, near)));
  const other = F.minhash('Deploys containers to kubernetes clusters with helm charts and rolls back on a failed readiness probe quickly.');
  assert.ok(F.jaccard(a, other) < 0.2, String(F.jaccard(a, other)));
  assert.strictEqual(F.minhash('too short'), null, 'texts with too few shingles get no signature');
  assert.match(F.fingerprint(a), /^[0-9a-f]{32}$/);
});

test('findGroups: near-copies group, best copy by quality; same name needs a similar body; unrelated stay alone', () => {
  const sig = (t) => F.minhash(t);
  const other = 'Deploys containers to kubernetes clusters with helm charts and rolls back on a failed readiness probe quickly.';
  const items = [
    { id: 'a', nameKey: 'tdd', sig: sig(BODY_A), quality: 40, stars: 1 },
    { id: 'b', nameKey: 'tdd-copy', sig: sig(BODY_A.replace('past', 'previous')), quality: 80, stars: 5 },
    { id: 'c', nameKey: 'tdd', sig: sig(other), quality: 90, stars: 9 },
    { id: 'd', nameKey: 'helm', sig: sig(other + ' extra'), quality: 10, stars: 0 },
    { id: 'e', nameKey: 'tdd', sig: null, quality: 5, stars: 0 },
  ];
  const r = D.findGroups(items);
  const byBest = Object.fromEntries(r.groups.map((g) => [g.best, g]));
  assert.ok(byBest.b, JSON.stringify(r.groups));
  assert.deepStrictEqual(byBest.b.members.sort(), ['a', 'b']);
  assert.ok(byBest.c && byBest.c.members.sort().join() === 'c,d');
  assert.strictEqual(r.canon[0], 1); assert.strictEqual(r.canon[1], 1);
  assert.strictEqual(r.canon[4], 4, 'a skill without text is never merged on name alone');
  assert.ok(r.stats.same_name_not_merged >= 1);
});

test('normName strips case, punctuation and separators', () => {
  assert.strictEqual(D.normName('Code_Review '), 'codereview');
  assert.strictEqual(D.normName(null), null);
});

test('LSH recall: near copies at estimated Jaccard 0.80-0.90 are found (old 8x8 banding missed ~20%)', () => {
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const vocab = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}`);
  const items = []; let pairs = 0;
  for (let k = 0; k < 60; k++) {
    const words = Array.from({ length: 300 }, () => vocab[Math.floor(rnd() * vocab.length)]);
    const copy = words.slice(); for (let i = 0; i < copy.length; i += 31) copy[i] = vocab[Math.floor(rnd() * vocab.length)];
    const a = F.minhash(words.join(' ')); const b = F.minhash(copy.join(' '));
    const j = F.jaccard(a, b); if (j < 0.8 || j > 0.9) continue;
    pairs++;
    items.push({ id: `a${k}`, nameKey: `a${k}`, sig: a, quality: 1, stars: 0 }, { id: `b${k}`, nameKey: `b${k}`, sig: b, quality: 0, stars: 0 });
  }
  assert.ok(pairs >= 20, `need enough borderline pairs, got ${pairs}`);
  const found = D.findGroups(items).groups.length;
  assert.ok(found >= pairs - 1, `found ${found} of ${pairs} borderline pairs`);
});

test('template families (same skeleton body, different name AND description) are reported, not merged', () => {
  const skeleton = BODY_A + ' ' + BODY_A.split(' ').reverse().join(' ');
  const items = [
    { id: 'p', nameKey: 'aicontentimprover', descTokens: new Set(['content', 'improver', 'draft', 'text']), sig: F.minhash(skeleton), quality: 50, stars: 0 },
    { id: 'q', nameKey: 'aifaqcreator', descTokens: new Set(['faq', 'creator', 'questions', 'answers']), sig: F.minhash(skeleton + ' faq'), quality: 60, stars: 0 },
    { id: 'r', nameKey: 'chartanalysis', descTokens: new Set(['brief', 'description', 'what', 'does']), sig: F.minhash(BODY_A), quality: 10, stars: 0 },
    { id: 's', nameKey: 'neatmail', descTokens: new Set(['brief', 'description', 'what', 'does']), sig: F.minhash(BODY_A + ' mail'), quality: 20, stars: 0 },
  ];
  const res = D.findGroups(items);
  assert.deepStrictEqual(res.groups.map((g) => g.members.sort().join()), ['r,s'], 'identical descriptions merge; different ones do not');
  assert.deepStrictEqual(res.families.map((g) => g.members.sort().join()), ['p,q']);
  assert.strictEqual(res.canon[0], 0); assert.strictEqual(res.canon[1], 1);
  assert.ok(res.stats.template_family_pairs >= 1);
});

test('CJK text is tokenised per character: it gets a signature, near copies match, and terms are bigrams', () => {
  const zh = '这个技能帮助你分析销售数据并生成每周报告，自动检查异常值，汇总关键指标，并把结果发送给团队负责人进行审核和确认。';
  const a = F.minhash(zh); const b = F.minhash(zh.replace('每周', '每月'));
  assert.ok(a, 'CJK text must get a MinHash signature');
  assert.ok(F.jaccard(a, b) >= 0.7, String(F.jaccard(a, b)));
  const t = T.terms('数据分析 report');
  assert.ok(t.includes('数据') && t.includes('分析') && t.includes('report'), t.join(','));
});
