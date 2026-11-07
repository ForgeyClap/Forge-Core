#!/usr/bin/env node
'use strict';
// forge-skill-harvest.test.cjs — pure parsing + rate-limit tests for the skill harvester.
// No network: every gh / HTTPS call is a fake injected through ctx.
const nodeTest = require('node:test');
// project tally the doctor and forge-test-tally.test.cjs read (node:test's own 'pass N' line counts as no evidence)
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const P = require('./forge-skill-harvest-parse.cjs');
const N = require('./forge-skill-harvest-net.cjs');

test('parseSitemapLocs extracts and unescapes every <loc>', () => {
  const xml = '<urlset><url><loc>https://www.skills.sh/a/b/c</loc></url><url><loc>https://x.y/?a=1&amp;b=2</loc></url></urlset>';
  assert.deepStrictEqual(P.parseSitemapLocs(xml), ['https://www.skills.sh/a/b/c', 'https://x.y/?a=1&b=2']);
});

test('parseSkillsShLoc accepts owner/repo/skill on skills.sh only', () => {
  assert.deepStrictEqual(P.parseSkillsShLoc('https://www.skills.sh/vercel-labs/skills/find-skills'),
    { repo: 'vercel-labs/skills', skill: 'find-skills' });
  assert.deepStrictEqual(P.parseSkillsShLoc('https://skills.sh/travisjneuman/.claude/business-strategy'),
    { repo: 'travisjneuman/.claude', skill: 'business-strategy' });
  assert.strictEqual(P.parseSkillsShLoc('https://www.skills.sh/docs/cli'), null);
  assert.strictEqual(P.parseSkillsShLoc('https://evil.example/a/b/c'), null);
});

test('extractGithubRepos finds repo links, strips .git, skips non-repo pages, dedupes', () => {
  const md = [
    '[x](https://github.com/Owner/Repo/tree/main/skills/pdf)',
    'https://github.com/owner/repo.git and https://github.com/topics/claude',
    '<https://github.com/a-b/c.d>', 'https://github.com/sponsors/someone',
    'https://github.com/owner/repo/blob/main/README.md',
  ].join('\n');
  const repos = P.extractGithubRepos(md);
  assert.deepStrictEqual(repos.sort(), ['a-b/c.d', 'owner/repo']);
});

test('parseMarketplace resolves local, github and url sources', () => {
  const j = JSON.stringify({ plugins: [
    { name: 'a', source: './plugins/a' },
    { name: 'b', source: { source: 'github', repo: 'x/y' } },
    { name: 'c', source: { source: 'url', url: 'https://github.com/p/q.git' } },
    { name: 'd', source: { source: 'url', url: 'https://gitlab.com/p/q' } },
  ] });
  assert.deepStrictEqual(P.parseMarketplace(j, 'anthropics/claude-plugins-official').sort(),
    ['anthropics/claude-plugins-official', 'p/q', 'x/y']);
  assert.deepStrictEqual(P.parseMarketplace('not json', 'a/b'), []);
});

test('parseFrontmatter reads quoted, plain and folded values', () => {
  const fm = P.parseFrontmatter('---\nname: "pdf"\ndescription: >\n  Reads PDFs\n  and forms.\nlicense: MIT\n---\n# body');
  assert.strictEqual(fm.name, 'pdf');
  assert.strictEqual(fm.description, 'Reads PDFs and forms.');
  assert.strictEqual(fm.fields.license, 'MIT');
  const none = P.parseFrontmatter('# no frontmatter');
  assert.strictEqual(none.name, null);
  assert.strictEqual(none.raw, null);
});

test('splitPartition halves size ranges, then facets, then stops', () => {
  assert.deepStrictEqual(P.splitPartition({ lo: 0, hi: 9 }), [{ lo: 0, hi: 4 }, { lo: 5, hi: 9 }]);
  const facets = P.splitPartition({ lo: 7, hi: 7 });
  assert.ok(facets.length >= 5 && facets.every((f) => f.lo === 7 && f.hi === 7 && f.facet));
  assert.deepStrictEqual(P.splitPartition({ lo: 7, hi: 7, facet: 'path:skills' }), []);
  assert.strictEqual(P.codeQuery({ lo: 3, hi: 9, facet: 'path:skills' }), 'filename:SKILL.md size:3..9 path:skills');
});

test('classifyShips counts scripts, hooks, MCP config and package.json inside the skill dir', () => {
  const s = P.classifyShips([
    { path: 'skills/pdf/SKILL.md', type: 'blob', size: 10 },
    { path: 'skills/pdf/scripts/fill.py', type: 'blob', size: 10 },
    { path: 'skills/pdf/scripts/run.sh', type: 'blob', size: 10 },
    { path: 'skills/pdf/hooks/hooks.json', type: 'blob', size: 10 },
    { path: 'skills/pdf/.mcp.json', type: 'blob', size: 10 },
    { path: 'skills/pdf/package.json', type: 'blob', size: 10 },
    { path: 'skills/other/x.py', type: 'blob', size: 10 },
  ], 'skills/pdf');
  assert.strictEqual(s.files, 6);
  assert.deepStrictEqual(s.scripts, { '.py': 1, '.sh': 1 });
  assert.deepStrictEqual(s.hooks, ['skills/pdf/hooks/hooks.json']);
  assert.deepStrictEqual(s.mcp, ['skills/pdf/.mcp.json']);
  assert.deepStrictEqual(s.package_json, ['skills/pdf/package.json']);
  assert.deepStrictEqual(s.script_paths.sort(), ['skills/pdf/scripts/fill.py', 'skills/pdf/scripts/run.sh']);
});

test('grepNetwork flags network calls and hosts, nothing on clean code', () => {
  const g = P.grepNetwork('import requests\nr = requests.get("https://api.example.com/v1")\ncurl -s http://x.io');
  assert.ok(g.markers.includes('requests'));
  assert.ok(g.markers.includes('curl'));
  assert.deepStrictEqual(g.hosts.sort(), ['api.example.com', 'x.io']);
  assert.deepStrictEqual(P.grepNetwork('print(1 + 1)'), { markers: [], hosts: [] });
});

test('resolveSkillsSh matches the dir name, the only skill, or nothing', () => {
  const paths = ['skills/find-skills/SKILL.md', 'skills/Other_Thing/SKILL.md'];
  assert.strictEqual(P.resolveSkillsSh('find-skills', paths), 'skills/find-skills/SKILL.md');
  assert.strictEqual(P.resolveSkillsSh('other-thing', paths), 'skills/Other_Thing/SKILL.md');
  assert.strictEqual(P.resolveSkillsSh('nope', paths), null);
  assert.strictEqual(P.resolveSkillsSh('whatever', ['SKILL.md']), 'SKILL.md');
});

test('parseGhOutput splits status, lowercased headers and body', () => {
  const r = N.parseGhOutput('HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 100\r\n\r\n{"a":1}');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.headers['x-ratelimit-remaining'], '0');
  assert.strictEqual(r.body, '{"a":1}');
});

test('rateLimitWaitMs uses reset time, retry-after, and caps the wait', () => {
  const now = 50000;
  assert.strictEqual(N.rateLimitWaitMs({ status: 200, headers: {} }, now), 0);
  assert.strictEqual(N.rateLimitWaitMs({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' } }, now), 51000);
  assert.strictEqual(N.rateLimitWaitMs({ status: 429, headers: { 'retry-after': '7' } }, now), 7000);
  assert.strictEqual(N.rateLimitWaitMs({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999999' } }, now), N.MAX_WAIT_MS);
  assert.strictEqual(N.rateLimitWaitMs({ status: 403, headers: {}, body: 'Not rate' }, now), 0);
  assert.ok(N.rateLimitWaitMs({ status: 403, headers: {}, body: 'You have exceeded a secondary rate limit' }, now) > 0);
});

function fakeCtx(responses) {
  const slept = [];
  let calls = 0;
  return {
    slept, get calls() { return calls; },
    gh: () => { const r = responses[Math.min(calls, responses.length - 1)]; calls++; return r; },
    sleep: async (ms) => { slept.push(ms); }, now: () => 0, log: () => {},
  };
}

test('ghJson waits on a rate limit and then succeeds', async () => {
  const ctx = fakeCtx([
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5' }, body: '{}' },
    { status: 200, headers: {}, body: '{"ok":true}' },
  ]);
  const r = await N.ghJson(ctx, ['rate_limit'], { resource: 'core' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, { ok: true });
  assert.deepStrictEqual(ctx.slept, [6000]);
});

test('ghJson gives up after a bounded number of rate-limit retries', async () => {
  const ctx = fakeCtx([{ status: 429, headers: { 'retry-after': '1' }, body: '' }]);
  const r = await N.ghJson(ctx, ['x'], { resource: 'core' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'rate_limited');
  assert.strictEqual(ctx.calls, N.MAX_ATTEMPTS);
});

test('ghJson returns a 404 at once without retrying', async () => {
  const ctx = fakeCtx([{ status: 404, headers: {}, body: '{"message":"Not Found"}' }]);
  const r = await N.ghJson(ctx, ['x'], { resource: 'core' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(ctx.calls, 1);
});

test('redact hides token-shaped strings in log lines', () => {
  const line = N.redact('failed gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789 and github' + '_pat_11ABCDEFG0123456789_abcdefghijklmnop');
  assert.ok(!/ghp_[a-z0-9]{20}/i.test(line));
  assert.ok(!/github_pat_[A-Za-z0-9_]{20}/.test(line));
  assert.ok(line.includes('[redacted]'));
});
