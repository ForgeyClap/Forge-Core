#!/usr/bin/env node
'use strict';
// forge-skill-harvest-fast.test.cjs — SA-HARVEST-FAST: shared token bucket, batched GraphQL repo pre-pass,
// parallel tree workers, Windows-safe state writes. Fake gh / clock only; every fixture lives in a fresh os.tmpdir() root.
const nodeTest = require('node:test');
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./forge-skill-harvest-bucket.cjs');
const N = require('./forge-skill-harvest-net.cjs');
const S = require('./forge-skill-harvest-store.cjs');
const E = require('./forge-skill-harvest-enum.cjs');
const T = require('./forge-skill-harvest-trees.cjs');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skharv-fast-'));
const ok = (obj, headers = {}) => ({ status: 200, headers, body: JSON.stringify(obj) });

// A virtual clock with real concurrency: sleeps that overlap in time overlap on the clock too (the earliest timer fires
// first, once every worker has had its turn), so waits are measured, never slept for real.
function clock(start = 0) {
  const c = { t: start, slept: [], timers: [] };
  let scheduled = false;
  const tick = () => {
    scheduled = false;
    if (!c.timers.length) return;
    c.timers.sort((a, b) => a.at - b.at);
    const x = c.timers.shift();
    c.t = Math.max(c.t, x.at);
    x.resolve();
    if (c.timers.length) schedule();
  };
  const schedule = () => { if (!scheduled) { scheduled = true; setImmediate(tick); } };
  c.now = () => c.t;
  c.sleep = (ms) => { c.slept.push(ms); return new Promise((resolve) => { c.timers.push({ at: c.t + ms, resolve }); schedule(); }); };
  return c;
}

// ---- token bucket
test('bucket: the documented limits are the defaults (core 5000/h, graphql 5000/h, search 30/min, code search 10/min)', () => {
  assert.deepStrictEqual(B.LIMITS.core.windows[0], { cap: 5000, ms: 3600000 });
  assert.deepStrictEqual(B.LIMITS.graphql.windows[0], { cap: 5000, ms: 3600000 });
  assert.deepStrictEqual(B.LIMITS.search.windows[0], { cap: 30, ms: 60000 });
  assert.deepStrictEqual(B.LIMITS.code_search.windows[0], { cap: 10, ms: 60000 });
});

test('bucket: never hands out more than the cap per window, even to concurrent workers', async () => {
  const c = clock(); const b = B.createBucket({ windows: [{ cap: 10, ms: 60000 }], minGapMs: 0 }, c);
  const at = [];
  await Promise.all(Array.from({ length: 25 }, () => b.acquire().then(() => at.push(c.now()))));
  assert.strictEqual(at.length, 25);
  for (const t0 of at) assert.ok(at.filter((t) => t >= t0 && t < t0 + 60000).length <= 10, 'at most 10 grants in any 60 s span');
  assert.ok(c.now() >= 120000, `25 grants at 10/min need two refills, clock=${c.now()}`);
});

test('bucket: minimum gap spaces calls (code search stays at one per 6 s)', async () => {
  const c = clock(); const b = B.createBucket(B.LIMITS.code_search, c);
  const at = [];
  for (let i = 0; i < 4; i++) { await b.acquire(); at.push(c.now()); }
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 6000, `gap ${at[i] - at[i - 1]}`);
});

test('bucket: server headers win, so other processes on the same account are counted', async () => {
  const c = clock(1000); const b = B.createBucket({ windows: [{ cap: 5000, ms: 3600000 }], minGapMs: 0 }, c);
  b.observe({ remaining: 2, resetMs: 1000 + 30000 });
  await b.acquire(); await b.acquire();
  assert.strictEqual(c.now(), 1000, 'two left: no wait');
  await b.acquire();
  assert.ok(c.now() >= 31000, `third call waits for the server reset, clock=${c.now()}`);
});

test('bucket: a GraphQL cost above 1 is charged in full', async () => {
  const c = clock(); const b = B.createBucket({ windows: [{ cap: 10, ms: 60000 }], minGapMs: 0 }, c);
  await b.acquire(4); await b.acquire(4);
  assert.strictEqual(c.now(), 0);
  await b.acquire(4);
  assert.ok(c.now() >= 60000, 'third 4-point query waits for the window');
});

test('net: ghJson feeds x-ratelimit headers back into the shared bucket', async () => {
  const c = clock(5000); let calls = 0;
  const ctx = { gh: () => { calls++; return ok({}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '65', 'x-ratelimit-resource': 'core' }); },
    sleep: c.sleep, now: c.now, log: () => {} };
  await N.ghJson(ctx, ['repos/a/b'], { resource: 'core' });
  await N.ghJson(ctx, ['repos/a/c'], { resource: 'core' });
  assert.strictEqual(calls, 2);
  assert.ok(c.now() >= 65000, `second call waited for the reset the server reported, clock=${c.now()}`);
});

// ---- batched GraphQL repo pre-pass
test('meta: one GraphQL query covers up to 100 repos, with rateLimit cost and literal-safe names', () => {
  const q = T.buildMetaQuery(['a/b', 'we"ird/x', 'o/r.s']);
  assert.match(q, /rateLimit \{ cost remaining resetAt \}/);
  assert.match(q, /r0: repository\(owner: "a", name: "b"\)/);
  assert.match(q, /r1: repository\(owner: "we\\"ird", name: "x"\)/);
  assert.strictEqual((q.match(/repository\(/g) || []).length, 3);
  assert.strictEqual(T.META_BATCH, 100);
});

test('meta: parseMeta tells not_found, empty, renamed and plain repos apart', () => {
  const repos = ['a/gone', 'a/empty', 'Old/name', 'a/ok', 'a/nobranch'];
  const json = { data: { rateLimit: { cost: 1 }, r0: null, r1: { nameWithOwner: 'a/empty', isEmpty: true, defaultBranchRef: null },
    r2: { nameWithOwner: 'new/name', isEmpty: false, defaultBranchRef: { name: 'main' } },
    r3: { nameWithOwner: 'a/ok', isEmpty: false, defaultBranchRef: { name: 'main' } },
    r4: { nameWithOwner: 'a/nobranch', isEmpty: false, defaultBranchRef: null } },
  errors: [{ type: 'NOT_FOUND', path: ['r0'] }] };
  const m = T.parseMeta(repos, json);
  assert.deepStrictEqual(m.get('a/gone'), { status: 'not_found' });
  assert.deepStrictEqual(m.get('a/empty'), { status: 'empty' });
  assert.deepStrictEqual(m.get('Old/name'), { status: 'ok', canonical: 'new/name' });
  assert.deepStrictEqual(m.get('a/ok'), { status: 'ok', canonical: 'a/ok' });
  assert.deepStrictEqual(m.get('a/nobranch'), { status: 'ok', canonical: 'a/nobranch' }, 'unsure -> let REST decide');
});

test('meta: an alias error that is not NOT_FOUND is unknown (REST decides), never a fake not_found', () => {
  const m = T.parseMeta(['a/x'], { data: { r0: null }, errors: [{ type: 'FORBIDDEN', path: ['r0'] }] });
  assert.strictEqual(m.get('a/x'), undefined);
  assert.strictEqual(T.parseMeta(['a/y'], null).size, 0, 'a failed query decides nothing');
});

// ---- parallel tree workers
function treeWorld({ meta = {}, trees = {}, latency = 50 }, c) {
  const log = { meta: 0, tree: [], inFlight: 0, maxInFlight: 0 };
  const gh = async (args, input) => {
    if (args[0] === 'graphql') {
      log.meta++;
      const q = JSON.parse(input).query; const data = { rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-11-05T02:00:00Z' } }; const errors = [];
      for (const m of q.matchAll(/(r\d+): repository\(owner: ("(?:[^"\\]|\\.)*"), name: ("(?:[^"\\]|\\.)*")\)/g)) {
        const repo = `${JSON.parse(m[2])}/${JSON.parse(m[3])}`; const v = meta[repo];
        if (v === null) { data[m[1]] = null; errors.push({ type: 'NOT_FOUND', path: [m[1]] }); } else {
          data[m[1]] = { nameWithOwner: (v && v.canonical) || repo, isEmpty: !!(v && v.empty), defaultBranchRef: v && v.empty ? null : { name: 'main' } };
        }
      }
      return ok({ data, errors });
    }
    const m = /^repos\/(.+?)\/git\/trees\/HEAD\?recursive=1$/.exec(args[0]);
    log.tree.push(m[1]); log.inFlight++; log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
    await c.sleep(latency); log.inFlight--;
    const files = trees[m[1]];
    if (!files) return { status: 404, headers: {}, body: '{"message":"Not Found"}' };
    return ok({ truncated: false, tree: files.map((p, i) => ({ path: p, type: 'blob', sha: `${m[1]}#${i}` })) });
  };
  return { gh, log };
}

test('trees: workers run REST tree calls in parallel (bounded), skip dead repos via the pre-pass, keep order-safe resume', async () => {
  const c = clock(); const root = tmpRoot();
  const repos = Array.from({ length: 12 }, (_, i) => `o/r${i}`);
  const trees = {}; repos.forEach((r) => { trees[r] = [`skills/${r.slice(2)}/SKILL.md`, 'README.md']; });
  const meta = { 'o/r3': null, 'o/r5': { empty: true } };
  const { gh, log } = treeWorld({ meta, trees }, c);
  const ctx = { gh, sleep: c.sleep, now: c.now, log: () => {} };
  const store = S.openStore(root); const st = { treeIndex: 0 }; const seen = [];
  await T.treeQueue(ctx, store, 'lists', st, repos, { workers: 4 }, (e, repo) => { seen.push([repo, e.status]); return 0; });
  assert.strictEqual(log.meta, 1, 'one GraphQL query for 12 repos');
  assert.strictEqual(log.tree.length, 10, 'no REST call for the not-found and the empty repo');
  assert.ok(log.maxInFlight > 1 && log.maxInFlight <= 4, `in flight ${log.maxInFlight}`);
  assert.deepStrictEqual(seen.map((s) => s[0]), repos, 'onEntry runs in list order');
  assert.deepStrictEqual(seen.find((s) => s[0] === 'o/r3')[1], 'not_found');
  assert.deepStrictEqual(seen.find((s) => s[0] === 'o/r5')[1], 'empty');
  assert.strictEqual(st.treeIndex, 12);
  const again = treeWorld({ meta, trees }, c);
  const st2 = { treeIndex: 0 };
  await T.treeQueue({ ...ctx, gh: again.gh }, S.openStore(root), 'lists', st2, repos, { workers: 4 }, () => 0);
  assert.strictEqual(again.log.tree.length + again.log.meta, 0, 'resume from the tree cache makes no calls');
});

test('trees: 4 workers tree ~4x more repos per minute than 1 worker at the same latency', async () => {
  const repos = Array.from({ length: 40 }, (_, i) => `o/p${i}`);
  const trees = {}; repos.forEach((r) => { trees[r] = ['SKILL.md']; });
  const timeFor = async (workers) => {
    const c = clock(); const { gh } = treeWorld({ trees, latency: 500 }, c);
    await T.treeQueue({ gh, sleep: c.sleep, now: c.now, log: () => {} }, S.openStore(tmpRoot()), 'topics', { treeIndex: 0 }, repos, { workers }, () => 0);
    return c.now();
  };
  const one = await timeFor(1); const four = await timeFor(4);
  assert.ok(one / four >= 3, `1 worker ${one} ms vs 4 workers ${four} ms`);
});

test('trees: a renamed repo is treed once under its canonical name; candidates use that name', async () => {
  const c = clock(); const root = tmpRoot();
  const { gh, log } = treeWorld({ meta: { 'old/x': { canonical: 'new/x' } }, trees: { 'new/x': ['SKILL.md'] } }, c);
  const store = S.openStore(root);
  const got = [];
  await T.treeQueue({ gh, sleep: c.sleep, now: c.now, log: () => {} }, store, 'lists', { treeIndex: 0 }, ['old/x', 'new/x'], { workers: 2 },
    (e) => { got.push(...T.treeCands(e)); return 0; });
  assert.deepStrictEqual(log.tree, ['new/x']);
  assert.deepStrictEqual(got.map((g) => g.repo), ['new/x', 'new/x']);
  assert.strictEqual(new Set(got.map((g) => `${g.repo}|${g.path}|${g.blob}`)).size, 1, 'same blob, same key: one candidate after dedupe');
});

test('trees: --limit caps NEW tree calls and a rate-limit stop keeps the cursor at the first unfinished repo', async () => {
  const c = clock(); const root = tmpRoot();
  const repos = Array.from({ length: 10 }, (_, i) => `o/q${i}`);
  const trees = {}; repos.forEach((r) => { trees[r] = ['SKILL.md']; });
  const { gh, log } = treeWorld({ trees }, c);
  const st = { treeIndex: 0 };
  await T.treeQueue({ gh, sleep: c.sleep, now: c.now, log: () => {} }, S.openStore(root), 'topics', st, repos, { workers: 3, limit: 4 }, () => 0);
  assert.strictEqual(log.tree.length, 4);
  assert.strictEqual(st.treeIndex, 4);
  let n = 0;
  const limited = async (args, input) => {
    if (args[0] !== 'graphql' && ++n > 2) return { status: 403, headers: {}, body: 'secondary rate limit' };
    return gh(args, input);
  };
  const st2 = { treeIndex: 4 };
  await T.treeQueue({ gh: limited, sleep: c.sleep, now: c.now, log: () => {}, maxRequests: 0 }, S.openStore(root), 'topics', st2, repos, { workers: 1 }, () => 0);
  assert.strictEqual(st2.treeIndex, 6, 'two finished, stopped at the third');
});

test('enum: skillssh still resolves sitemap entries through the parallel tree path', async () => {
  const c = clock(); const root = tmpRoot();
  const pages = {
    'https://www.skills.sh/robots.txt': 'Sitemap: https://www.skills.sh/sitemap.xml',
    'https://www.skills.sh/sitemap.xml': ['o/r1/alpha', 'o/r1/beta', 'o/r2/solo', 'o/gone/x'].map((s) => `<url><loc>https://www.skills.sh/${s}</loc></url>`).join(''),
  };
  const { gh, log } = treeWorld({ meta: { 'o/gone': null }, trees: { 'o/r1': ['skills/alpha/SKILL.md', 'skills/gamma/SKILL.md'], 'o/r2': ['SKILL.md'] } }, c);
  const ctx = { gh, get: async (u) => (pages[u] ? { status: 200, body: pages[u] } : { status: 404, body: '' }), sleep: c.sleep, now: c.now, log: () => {} };
  await E.enumerate(ctx, S.openStore(root), { source: 'skillssh', workers: 4 });
  const st = S.openStore(root).state('skillssh');
  assert.strictEqual(st.resolved, 2);
  assert.deepStrictEqual(st.unresolved, { no_match: 1, repo_not_found: 1 });
  assert.ok(!log.tree.includes('o/gone'), 'dead repo cost no core call');
});

// ---- Windows-safe atomic state writes (live incident 2026-11-05: EPERM on rename killed enumerate skillssh and lists)
test('store: a state write survives a transient EPERM on rename (file briefly locked)', () => {
  const root = tmpRoot(); let fails = 2; const naps = [];
  const fsOps = { renameSync: (a, b) => { if (fails-- > 0) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; } fs.renameSync(a, b); },
    sleepSync: (ms) => naps.push(ms) };
  const store = S.openStore(root, { fsOps });
  store.saveState('skillssh', { treeIndex: 7 });
  assert.strictEqual(S.openStore(root).state('skillssh').treeIndex, 7);
  assert.strictEqual(naps.length, 2);
  const left = fs.readdirSync(store.work).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(left, [], 'no temp file left behind');
});

test('store: a rename that keeps failing gives up after a bounded wait, cleans its temp file and names the file', () => {
  const root = tmpRoot(); const naps = [];
  const fsOps = { renameSync: () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }, sleepSync: (ms) => naps.push(ms) };
  const store = S.openStore(root, { fsOps });
  assert.throws(() => store.saveState('lists', { a: 1 }), /state-lists\.json/);
  assert.ok(naps.length >= 5 && naps.reduce((a, b) => a + b, 0) <= 30000, `waited ${naps.reduce((a, b) => a + b, 0)} ms in ${naps.length} naps`);
  assert.deepStrictEqual(fs.readdirSync(store.work).filter((f) => f.endsWith('.tmp')), []);
  const other = { renameSync: () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; }, sleepSync: (ms) => naps.push(ms) };
  const n0 = naps.length;
  assert.throws(() => S.openStore(tmpRoot(), { fsOps: other }).saveState('x', {}), /ENOSPC/);
  assert.strictEqual(naps.length, n0, 'a real error is not retried');
});

test('CLI: --workers is accepted from 1 to 8 and refused outside that range', () => {
  const C = require('./forge-skill-harvest.cjs');
  assert.strictEqual(C.parseArgs(['enumerate', '--workers', '6']).workers, 6);
  assert.throws(() => C.parseArgs(['enumerate', '--workers', '0']), /between 1 and 8/);
  assert.throws(() => C.parseArgs(['enumerate', '--workers', '9']), /between 1 and 8/);
});
