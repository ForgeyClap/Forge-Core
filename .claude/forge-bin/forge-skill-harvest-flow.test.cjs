#!/usr/bin/env node
'use strict';
// forge-skill-harvest-flow.test.cjs — enumerate / fetch / index / CLI flow tests with fake gh + HTTPS.
// Every fixture lives in a fresh os.tmpdir() root; this file never touches the real corpus or network.
const nodeTest = require('node:test');
// project tally the doctor and forge-test-tally.test.cjs read (node:test's own 'pass N' line counts as no evidence)
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./forge-skill-harvest-store.cjs');
const E = require('./forge-skill-harvest-enum.cjs');
const F = require('./forge-skill-harvest-fetch.cjs');
const I = require('./forge-skill-harvest-index.cjs');

const CLI = path.join(__dirname, 'forge-skill-harvest.cjs');
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'skharv-')); }
function argOf(args, key) {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-f' && args[i + 1].startsWith(key + '=')) return args[i + 1].slice(key.length + 1);
  return null;
}
const ok = (obj) => ({ status: 200, headers: {}, body: JSON.stringify(obj) });
const notFound = { status: 404, headers: {}, body: '{"message":"Not Found"}' };

function baseCtx(gh, get) {
  return { gh, get: get || (async () => ({ status: 404, body: '' })), sleep: async () => {}, now: () => Date.UTC(2026, 10, 4), log: () => {} };
}

// ---- code search: sizes 0..9, size 4 is dense (1500) and needs facets; facet 0 is capped (1200).
function codeSearchFake() {
  const served = new Set();
  const gh = (args) => {
    const q = argOf(args, 'q'); const page = Number(argOf(args, 'page') || 1);
    const m = /size:(\d+)\.\.(\d+)(?: (.+))?$/.exec(q);
    const lo = Number(m[1]); const hi = Number(m[2]); const facet = m[3] || null;
    const items = [];
    for (let s = lo; s <= hi; s++) {
      if (s === 4 && !facet) { for (let i = 0; i < 1500; i++) items.push({ s, i }); continue; }
      if (s === 4 && facet) {
        const fi = E.FACETS_FOR_TEST.indexOf(facet);
        const n = fi === 0 ? 1200 : 400;
        for (let i = 0; i < n; i++) items.push({ s, i: fi === 2 && i < 50 ? `x${i}` : `f${fi}-${i}` });
        continue;
      }
      for (let i = 0; i < 30; i++) items.push({ s, i });
    }
    const pageItems = items.slice((page - 1) * 100, Math.min(page * 100, 1000)).map(({ s, i }) => {
      const p = `p${s}/${i}/SKILL.md`; served.add(`o/r${s}|${p}`);
      return { path: p, sha: `blob-${s}-${i}`, repository: { full_name: `o/r${s}` } };
    });
    return ok({ total_count: items.length, incomplete_results: false, items: pageItems });
  };
  return { gh, served };
}

test('codesearch splits partitions past the 1000 cap, resumes, and dedupes repo+path', async () => {
  const root = tmpRoot(); const { gh, served } = codeSearchFake();
  const opts = { source: 'codesearch', rootRanges: [{ lo: 0, hi: 9 }] };
  await E.enumerate(baseCtx(gh), S.openStore(root), { ...opts, maxPartitions: 2 });
  const st1 = S.openStore(root).state('codesearch');
  assert.ok(st1.queue.length > 0, 'work left after --max-partitions 2');
  await E.enumerate(baseCtx(gh), S.openStore(root), opts);
  const store = S.openStore(root); const st = store.state('codesearch');
  assert.strictEqual(st.queue.length, 0);
  assert.ok(st.leaves.every((l) => l.retrieved <= 1000));
  const capped = st.leaves.filter((l) => l.capped);
  assert.strictEqual(capped.length, 1);
  assert.strictEqual(capped[0].total - capped[0].retrieved, 200);
  const keys = store.candidates('codesearch').map((c) => `${c.repo}|${c.path}`);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate repo+path lines');
  assert.strictEqual(keys.length, served.size);
});

test('codesearch still splits a partition whose estimated total is under 1000 but that returned the full 1000', async () => {
  const root = tmpRoot();
  const gh = (args) => {
    const q = argOf(args, 'q'); const page = Number(argOf(args, 'page') || 1);
    const [lo, hi] = /size:(\d+)\.\.(\d+)/.exec(q).slice(1).map(Number);
    const n = lo < hi ? 1000 : 10; const items = [];
    for (let i = (page - 1) * 100; i < Math.min(n, page * 100); i++) items.push({ path: `s${lo}-${hi}/${i}/SKILL.md`, sha: `b${lo}-${hi}-${i}`, repository: { full_name: 'o/r' } });
    return ok({ total_count: lo < hi ? 990 : 10, items });
  };
  await E.enumerate(baseCtx(gh), S.openStore(root), { source: 'codesearch', rootRanges: [{ lo: 0, hi: 3 }] });
  const st = S.openStore(root).state('codesearch');
  assert.ok(st.leaves.every((l) => l.lo === l.hi), 'every leaf is a single size: ' + JSON.stringify(st.leaves.map((l) => [l.lo, l.hi])));
  assert.strictEqual(st.leaves.length, 4);
});

function treeFake(map) {
  return (args) => {
    const m = /^repos\/(.+?)\/git\/trees\/HEAD\?recursive=1$/.exec(args[0]);
    if (!m || !map[m[1]]) return notFound;
    return ok({ truncated: false, tree: map[m[1]].map((p, i) => ({ path: p, type: 'blob', sha: `${m[1]}-${i}` })) });
  };
}

test('skillssh reads the sitemap, resolves entries to GitHub paths, records unresolved ones', async () => {
  const root = tmpRoot();
  const pages = {
    'https://www.skills.sh/robots.txt': 'Sitemap: https://www.skills.sh/sitemap.xml',
    'https://www.skills.sh/sitemap.xml': '<sitemapindex><sitemap><loc>https://www.skills.sh/sitemap-skills-1.xml</loc></sitemap><sitemap><loc>https://www.skills.sh/sitemap-misc.xml</loc></sitemap></sitemapindex>',
    'https://www.skills.sh/sitemap-skills-1.xml': ['o/r1/alpha', 'o/r1/beta', 'o/r2/solo', 'o/gone/x'].map((s) => `<url><loc>https://www.skills.sh/${s}</loc></url>`).join(''),
  };
  const get = async (u) => (pages[u] ? { status: 200, body: pages[u] } : { status: 404, body: '' });
  const gh = treeFake({ 'o/r1': ['skills/alpha/SKILL.md', 'skills/gamma/SKILL.md', 'README.md'], 'o/r2': ['SKILL.md'] });
  await E.enumerate(baseCtx(gh, get), S.openStore(root), { source: 'skillssh' });
  const store = S.openStore(root); const st = store.state('skillssh');
  assert.strictEqual(st.entries, 4);
  assert.strictEqual(st.resolved, 2);
  assert.deepStrictEqual(st.unresolved, { no_match: 1, repo_not_found: 1 });
  assert.strictEqual(store.candidates('skillssh').length, 3);
});

test('lists follows every GitHub link in a curated list and trees each linked repo', async () => {
  const root = tmpRoot();
  const get = async (u) => (u === 'https://raw.githubusercontent.com/L/one/HEAD/README.md'
    ? { status: 200, body: '- [a](https://github.com/x/a)\n- https://github.com/x/b' } : { status: 404, body: '' });
  const gh = treeFake({ 'L/one': ['README.md', 'skills/own/SKILL.md'], 'x/a': ['s/SKILL.md'], 'x/b': ['README.md'] });
  await E.enumerate(baseCtx(gh, get), S.openStore(root), { source: 'lists', lists: ['L/one'] });
  const store = S.openStore(root);
  assert.deepStrictEqual(store.candidates('lists').map((c) => c.repo).sort(), ['L/one', 'x/a']);
  assert.strictEqual(store.state('lists').links, 2);
});

test('topics split date ranges past 1000 repos and respect --limit', async () => {
  const root = tmpRoot(); let treeCalls = 0;
  const gh = (args) => {
    if (args[0].startsWith('repos/')) { treeCalls++; return ok({ truncated: false, tree: [{ path: 'SKILL.md', type: 'blob', sha: args[0] }] }); }
    if (args[0] === 'graphql') return ok({ data: {} }); // repo pre-pass (SA-HARVEST-FAST): settles nothing, REST decides
    const q = argOf(args, 'q'); const m = /created:(\S+)\.\.(\S+)/.exec(q);
    const days = (Date.parse(m[2]) - Date.parse(m[1])) / 864e5;
    const total = days > 2000 ? 1500 : 3;
    const items = days > 2000 ? [] : [0, 1, 2].map((i) => ({ full_name: `t/${m[1]}-${i}` }));
    return ok({ total_count: total, items });
  };
  await E.enumerate(baseCtx(gh), S.openStore(root), { source: 'topics', topics: ['t1'], limit: 5 });
  const store = S.openStore(root); const st = store.state('topics');
  assert.ok(st.repos.length >= 6, 'repos collected from split ranges');
  assert.strictEqual(treeCalls, 5);
  assert.strictEqual(store.candidates('topics').length, 5);
});

// ---- fetch: a tiny GraphQL fake that answers repository/object aliases from an in-memory universe.
const ALPHA = '---\nname: alpha\ndescription: Does alpha things.\n---\nbody';
const UNIVERSE = {
  'o/r1': { stars: 10, files: { 'skills/alpha/SKILL.md': ALPHA, 'skills/alpha/scripts/get.py': 'import requests\nrequests.get("https://api.x.com")', 'skills/gamma/SKILL.md': '---\nname: gamma\n---\n' } },
  'o/r3': { stars: 1, files: { 'd/SKILL.md': ALPHA } },
};
function entriesOf(files, dir) {
  const kids = new Map();
  for (const p of Object.keys(files)) {
    if (!p.startsWith(dir + '/')) continue;
    const rest = p.slice(dir.length + 1).split('/');
    kids.set(rest[0], rest.length === 1 ? 'blob' : 'tree');
  }
  return [...kids].map(([name, type]) => ({ name, type, path: `${dir}/${name}`,
    object: type === 'blob' ? { byteSize: files[`${dir}/${name}`].length, isBinary: false } : { entries: entriesOf(files, `${dir}/${name}`) } }));
}
function graphqlFake(counter) {
  return (args, input) => {
    counter.n++;
    const query = JSON.parse(input).query; const data = {}; const errors = [];
    const repoRe = /(r\d+): repository\(owner: ("[^"]*"), name: ("[^"]*")\) \{([\s\S]*?)\n  \}/g; let m;
    while ((m = repoRe.exec(query))) {
      const repo = `${JSON.parse(m[2])}/${JSON.parse(m[3])}`; const u = UNIVERSE[repo];
      if (!u) { data[m[1]] = null; errors.push({ type: 'NOT_FOUND', path: [m[1]] }); continue; }
      const r = { nameWithOwner: repo, stargazerCount: u.stars, isFork: false, licenseInfo: { spdxId: 'MIT' }, pushedAt: '2026-10-01T00:00:00Z',
        defaultBranchRef: { target: { committedDate: '2026-10-02T00:00:00Z' } } };
      const objRe = /(\w+): object\(expression: ("[^"]*")\)/g; let o;
      while ((o = objRe.exec(m[4]))) {
        const p = JSON.parse(o[2]).replace(/^HEAD:/, '');
        if (u.files[p] !== undefined) r[o[1]] = { byteSize: u.files[p].length, isBinary: false, isTruncated: false, text: u.files[p] };
        else { const e = entriesOf(u.files, p); r[o[1]] = e.length ? { entries: e } : null; }
      }
      data[m[1]] = r;
    }
    return ok({ data, errors: errors.length ? errors : undefined });
  };
}

test('fetch records text, frontmatter, repo meta and ships; skips duplicate blobs; resumes', async () => {
  const root = tmpRoot(); const store = S.openStore(root);
  store.addCandidates('codesearch', [
    { repo: 'o/r1', path: 'skills/alpha/SKILL.md', blob: 'b1' }, { repo: 'o/r1', path: 'skills/gamma/SKILL.md', blob: 'b2' },
    { repo: 'fork/r1', path: 'skills/alpha/SKILL.md', blob: 'b1' }, { repo: 'o/gone', path: 'SKILL.md', blob: 'b7' },
    { repo: 'o/r1', path: 'skills/missing/SKILL.md', blob: 'b9' },
  ]);
  store.addCandidates('lists', [{ repo: 'o/r3', path: 'd/SKILL.md', blob: 'b3' }]);
  const counter = { n: 0 };
  await F.fetchAll(baseCtx(graphqlFake(counter)), S.openStore(root), {});
  const recs = [...S.openStore(root).fetched().values()];
  const alpha = recs.find((r) => r.repo === 'o/r1' && r.path === 'skills/alpha/SKILL.md');
  assert.strictEqual(alpha.status, 'ok');
  assert.strictEqual(alpha.name, 'alpha');
  assert.strictEqual(alpha.stars, 10);
  assert.strictEqual(alpha.license, 'MIT');
  assert.deepStrictEqual(alpha.ships.scripts, { '.py': 1 });
  assert.ok(alpha.ships.network.markers.includes('requests'));
  assert.deepStrictEqual(alpha.ships.network.hosts, ['api.x.com']);
  assert.strictEqual(recs.find((r) => r.repo === 'o/gone').reason, 'repo_not_found');
  assert.strictEqual(recs.find((r) => r.path === 'skills/missing/SKILL.md').reason, 'not_at_head');
  assert.strictEqual(recs.find((r) => r.repo === 'fork/r1').status, 'dup_blob');
  const before = counter.n;
  await F.fetchAll(baseCtx(graphqlFake(counter)), S.openStore(root), {});
  assert.strictEqual(counter.n, before, 'second run makes no calls');

  const out = I.buildIndex(S.openStore(root));
  const corpus = fs.readFileSync(path.join(root, '.claude/forge-research/skills-corpus/corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(corpus.length, 2, 'alpha content stored once');
  const a = corpus.find((r) => r.name === 'alpha');
  for (const k of ['id', 'name', 'description', 'frontmatter', 'repo', 'path', 'stars', 'license', 'last_commit', 'sources', 'ships', 'sha256']) assert.ok(k in a, k);
  assert.strictEqual(a.repo, 'o/r1', 'most-starred copy is primary');
  assert.deepStrictEqual(a.sources.sort(), ['codesearch', 'lists']);
  const cov = JSON.parse(fs.readFileSync(path.join(root, '.claude/forge-research/skills-corpus/coverage.json'), 'utf8'));
  assert.strictEqual(cov.sources.codesearch.found, 5);
  assert.strictEqual(cov.sources.codesearch.fetched, 2);
  assert.deepStrictEqual(cov.sources.codesearch.failed, { repo_not_found: 1, not_at_head: 1 });
  assert.strictEqual(cov.totals.content_duplicates_removed, 1);
  assert.strictEqual(cov.totals.blob_duplicates_removed, 1);
  assert.strictEqual(out.corpus, 2);
});

test('--retry-failed refetches transient failures only, and a later failed record never hides an ok one', async () => {
  const root = tmpRoot(); const store = S.openStore(root);
  store.addCandidates('codesearch', [{ repo: 'o/r1', path: 'skills/alpha/SKILL.md', blob: 'b1' }, { repo: 'o/r1', path: 'skills/missing/SKILL.md', blob: 'b9' }]);
  store.addFetched([
    { key: 'o/r1|skills/alpha/SKILL.md', repo: 'o/r1', path: 'skills/alpha/SKILL.md', blob: 'b1', status: 'failed', reason: 'graphql_server_error' },
    { key: 'o/r1|skills/missing/SKILL.md', repo: 'o/r1', path: 'skills/missing/SKILL.md', blob: 'b9', status: 'failed', reason: 'not_at_head' },
  ]);
  const counter = { n: 0 };
  await F.fetchAll(baseCtx(graphqlFake(counter)), S.openStore(root), {});
  assert.strictEqual(counter.n, 0, 'without --retry-failed a failed key is not fetched again');
  await F.fetchAll(baseCtx(graphqlFake(counter)), S.openStore(root), { retryFailed: true });
  assert.ok(counter.n > 0, 'the transient failure is fetched again');
  let recs = S.openStore(root).fetched();
  assert.strictEqual(recs.get('o/r1|skills/alpha/SKILL.md').status, 'ok');
  assert.strictEqual(recs.get('o/r1|skills/missing/SKILL.md').reason, 'not_at_head', 'a permanent failure is not retried');
  S.openStore(root, { shard: '1/2' }).addFetched([{ key: 'o/r1|skills/alpha/SKILL.md', repo: 'o/r1', path: 'skills/alpha/SKILL.md', blob: 'b1', status: 'failed', reason: 'graphql_server_error' }]);
  recs = S.openStore(root).fetched();
  assert.strictEqual(recs.get('o/r1|skills/alpha/SKILL.md').status, 'ok', 'a failed record in another shard file does not replace ok');
  assert.strictEqual(S.openStore(root).fetchedLite().get('o/r1|skills/alpha/SKILL.md').status, 'ok');
  assert.strictEqual(F.isRetryable('graphql_server_error'), true);
  assert.strictEqual(F.isRetryable('binary'), false);
});

test('fetch survives a skill whose folder listing times out: few retries, then a shallower listing', async () => {
  const root = tmpRoot(); const store = S.openStore(root);
  store.addCandidates('codesearch', [{ repo: 'o/r1', path: 'skills/alpha/SKILL.md', blob: 'b1' }, { repo: 'o/r1', path: 'skills/gamma/SKILL.md', blob: 'b2' }]);
  const counter = { n: 0 }; const inner = graphqlFake(counter); let bad = 0; const slept = [];
  const gh = (args, input) => {
    const q = JSON.parse(input).query;
    if (q.includes('HEAD:skills/alpha"') && /entries \{ name type path object \{ \.\.\. on Blob \{ byteSize isBinary \} \.\.\. on Tree/.test(q)) { bad++; return { status: 502, headers: {}, body: '<html>502</html>' }; }
    return inner(args, input);
  };
  const ctx = { ...baseCtx(gh), sleep: async (ms) => { slept.push(ms); } };
  await F.fetchAll(ctx, S.openStore(root), {});
  const recs = [...S.openStore(root).fetched().values()];
  const alpha = recs.find((r) => r.path === 'skills/alpha/SKILL.md');
  assert.strictEqual(alpha.status, 'ok');
  assert.strictEqual(alpha.ships.listing, 'flat');
  assert.strictEqual(recs.find((r) => r.path === 'skills/gamma/SKILL.md').status, 'ok');
  assert.ok(bad <= 6, `deep listing tried ${bad} times`);
  assert.ok(slept.reduce((a, b) => a + b, 0) <= 20000, `slept ${slept.reduce((a, b) => a + b, 0)}ms`);
});

test('fetch --shard i/n splits work by blob across processes with no overlap and keeps blob dedupe', async () => {
  const root = tmpRoot();
  S.openStore(root).addCandidates('codesearch', [
    { repo: 'o/r1', path: 'skills/alpha/SKILL.md', blob: 'b1' }, { repo: 'o/r1', path: 'skills/gamma/SKILL.md', blob: 'b2' },
    { repo: 'fork/r1', path: 'skills/alpha/SKILL.md', blob: 'b1' }, { repo: 'o/r3', path: 'd/SKILL.md', blob: 'b3' },
  ]);
  const counter = { n: 0 };
  for (let i = 0; i < 2; i++) await F.fetchAll(baseCtx(graphqlFake(counter)), S.openStore(root, { shard: `${i}/2` }), { shard: `${i}/2` });
  const files = fs.readdirSync(path.join(root, '.claude/forge-research/skills-corpus/work')).filter((f) => f.startsWith('fetched'));
  assert.ok(files.length >= 1 && files.every((f) => /^fetched-[01]of2\.jsonl$/.test(f)), files.join(','));
  const recs = [...S.openStore(root).fetched().values()];
  assert.strictEqual(recs.length, 4, 'every candidate recorded once across shards');
  assert.strictEqual(recs.filter((r) => r.status === 'ok').length, 3);
  assert.strictEqual(recs.find((r) => r.repo === 'fork/r1').status, 'dup_blob');
  const before = counter.n;
  await F.fetchAll(baseCtx(graphqlFake(counter)), S.openStore(root, { shard: '0/2' }), { shard: '0/2' });
  assert.strictEqual(counter.n, before, 'resume per shard makes no calls');
});

test('CLI refuses unknown options, --help writes nothing, status works on an empty root', () => {
  const root = tmpRoot();
  const bad = spawnSync(process.execPath, [CLI, 'enumerate', '--bogus', '--root', root], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /unknown option/);
  const help = spawnSync(process.execPath, [CLI, '--help', '--root', root], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /enumerate/);
  assert.ok(!fs.existsSync(path.join(root, '.claude')), '--help created nothing');
  const st = spawnSync(process.execPath, [CLI, 'status', '--root', root], { encoding: 'utf8' });
  assert.strictEqual(st.status, 0, st.stderr);
  assert.match(st.stdout, /coverage/i);
  assert.ok(!fs.existsSync(path.join(root, '.claude')), 'status created nothing');
});
