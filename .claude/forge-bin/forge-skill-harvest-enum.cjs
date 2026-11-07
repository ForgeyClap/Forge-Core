'use strict';
// forge-skill-harvest-enum.cjs — `enumerate`: collect candidate SKILL.md locations from four sources.
//   codesearch  GitHub code search filename:SKILL.md, partitioned by size (then facets) past the 1000-result cap
//   topics      repos under the skill/plugin topics (date-partitioned), each listed via -trees.cjs (GraphQL triage + parallel REST trees)
//   lists       every GitHub repo linked from the big curated lists (+ the list repos themselves)
//   skillssh    every skills.sh entry from its public sitemap (robots.txt allows it; /api/ is not used)
// Every source is resumable (state-<source>.json) and stops cleanly on a spent budget or exhausted rate limit.
const P = require('./forge-skill-harvest-parse.cjs');
const { ghJson, getText } = require('./forge-skill-harvest-net.cjs');
const { treeRepo, treeCands, treeQueue } = require('./forge-skill-harvest-trees.cjs');

const ROOT_RANGES = [[0, 499], [500, 999], [1000, 1999], [2000, 3999], [4000, 7999], [8000, 15999],
  [16000, 31999], [32000, 63999], [64000, 1000000]].map(([lo, hi]) => ({ lo, hi }));
const TOPICS = ['claude-code-skills', 'agent-skills', 'claude-skills', 'claude-code-plugin', 'claude-code-plugins',
  'claude-code-subagents', 'claude-code-hooks', 'agent-memory'];
const LISTS = ['anthropics/skills', 'anthropics/claude-plugins-official', 'VoltAgent/awesome-agent-skills',
  'sickn33/agentic-awesome-skills', 'hesreallyhim/awesome-claude-code', 'alirezarezvani/claude-skills', 'wshobson/agents'];
const CAP = 1000;
const STOP = new Set(['rate_limited', 'request_budget_spent', 'server_error']);

async function searchPage(ctx, endpoint, q, page, resource) {
  return ghJson(ctx, ['-X', 'GET', endpoint, '-f', `q=${q}`, '-f', 'per_page=100', '-f', `page=${page}`], { resource });
}

// Fetch every page of one partition (max 1000 results). Returns { total, items, incomplete, error }.
async function allPages(ctx, endpoint, q, resource, first) {
  const items = [...first.json.items]; const total = first.json.total_count;
  let incomplete = !!first.json.incomplete_results;
  for (let page = 2; items.length < Math.min(total, CAP) && first.json.items.length === 100; page++) {
    const r = await searchPage(ctx, endpoint, q, page, resource);
    if (!r.ok) return { total, items, incomplete, error: r.error };
    if (r.json.incomplete_results) incomplete = true;
    items.push(...r.json.items);
    if (r.json.items.length < 100 || page >= CAP / 100) break;
  }
  return { total, items, incomplete, error: null };
}

async function enumCodeSearch(ctx, store, opts) {
  const st = store.state('codesearch');
  if (!st.queue) Object.assign(st, { queue: (opts.rootRanges || ROOT_RANGES).map((r) => ({ ...r })), leaves: [], splits: 0 });
  let leavesThisRun = 0;
  while (st.queue.length) {
    if (opts.maxPartitions && leavesThisRun >= opts.maxPartitions) break;
    const part = st.queue[0]; const q = P.codeQuery(part);
    const first = await searchPage(ctx, 'search/code', q, 1, 'code_search');
    if (!first.ok) {
      if (STOP.has(first.error)) { ctx.log(`codesearch: stopped (${first.error}); re-run to continue`); break; }
      st.queue.shift(); st.leaves.push({ ...part, total: 0, retrieved: 0, error: first.error });
      store.saveState('codesearch', st); continue;
    }
    const total = first.json.total_count;
    const kids = total > CAP ? P.splitPartition(part) : [];
    if (kids.length) {
      store.addCandidates('codesearch', toCands(first.json.items));
      st.queue.shift(); st.queue.unshift(...kids); st.splits++;
      store.saveState('codesearch', st);
      continue;
    }
    const got = await allPages(ctx, 'search/code', q, 'code_search', first);
    if (got.error && STOP.has(got.error)) { ctx.log(`codesearch: stopped mid-partition (${got.error}); re-run to continue`); break; }
    const added = store.addCandidates('codesearch', toCands(got.items));
    const deeper = got.items.length >= CAP ? P.splitPartition(part) : [];
    if (deeper.length) {
      // The estimate said <= 1000 but the cap was hit: the real count is higher, so split anyway.
      st.queue.shift(); st.queue.unshift(...deeper); st.splits++;
      store.saveState('codesearch', st);
      continue;
    }
    st.queue.shift();
    st.leaves.push({ ...part, total, retrieved: got.items.length, capped: total > CAP || got.items.length >= CAP, incomplete: got.incomplete, error: got.error || undefined });
    store.saveState('codesearch', st);
    leavesThisRun++;
    ctx.log(`codesearch: ${q} total=${total} got=${got.items.length} new=${added} | leaves=${st.leaves.length} queue=${st.queue.length}`);
  }
  return { leaves: st.leaves.length, queue: st.queue.length };
}
const toCands = (items) => items.filter((it) => it && it.repository && P.isSkillFile(it.path))
  .map((it) => ({ repo: it.repository.full_name, path: it.path, blob: it.sha }));

async function enumTopics(ctx, store, opts) {
  const st = store.state('topics');
  const today = P.isoDay(ctx.now());
  if (!st.topics) Object.assign(st, { topics: {}, repos: [], treeIndex: 0, capped: [] });
  const seen = new Set(st.repos.map((r) => r.toLowerCase()));
  let leaves = 0;
  topicLoop: for (const topic of opts.topics || TOPICS) {
    const t = st.topics[topic] || (st.topics[topic] = { queue: [{ from: '2008-01-01', to: today }], total: 0 });
    while (t.queue.length) {
      if (opts.maxPartitions && leaves >= opts.maxPartitions) break topicLoop;
      const range = t.queue[0]; const q = `topic:${topic} created:${range.from}..${range.to}`;
      const first = await searchPage(ctx, 'search/repositories', q, 1, 'search');
      if (!first.ok) { if (STOP.has(first.error)) { store.saveState('topics', st); return; } t.queue.shift(); continue; }
      const kids = first.json.total_count > CAP ? P.splitDateRange(range) : [];
      if (kids.length) { t.queue.shift(); t.queue.unshift(...kids); store.saveState('topics', st); continue; }
      const got = await allPages(ctx, 'search/repositories', q, 'search', first);
      if (got.error && STOP.has(got.error)) { store.saveState('topics', st); return; }
      for (const it of got.items) if (it && it.full_name && !seen.has(it.full_name.toLowerCase())) { seen.add(it.full_name.toLowerCase()); st.repos.push(it.full_name); }
      if (first.json.total_count > CAP) st.capped.push({ topic, ...range, total: first.json.total_count });
      t.total += got.items.length; t.queue.shift(); leaves++;
      store.saveState('topics', st);
      ctx.log(`topics: ${q} total=${first.json.total_count} | repos=${st.repos.length}`);
    }
  }
  await treeQueue(ctx, store, 'topics', st, st.repos, opts, (e) => store.addCandidates('topics', treeCands(e)));
}

// Root docs, README files up to two folders deep, CSV resource tables, plugin marketplace manifests.
const DOC_RE = /^[^/]+\.(md|markdown|csv|json)$|^([^/]+\/){1,2}readme[^/]*\.md$|\.csv$|(^|\/)marketplace\.json$/i;
async function enumLists(ctx, store, opts) {
  const st = store.state('lists');
  const lists = opts.lists || LISTS;
  if (!st.done) Object.assign(st, { done: {}, linked: [], links: 0, treeIndex: 0, docs: 0 });
  const listSet = new Set(lists.map((l) => l.toLowerCase()));
  const linked = new Set(st.linked.map((r) => r.toLowerCase()));
  for (const list of lists) {
    if (st.done[list]) continue;
    const res = await treeRepo(ctx, store, 'lists', list, { wantTree: true });
    if (!res) { store.saveState('lists', st); return; }
    store.addCandidates('lists', treeCands(res.entry, () => ({ via: list })));
    const docs = (res.tree || []).filter((e) => e.type === 'blob' && DOC_RE.test(e.path) && (e.size || 0) < 8e6).slice(0, 200);
    for (const d of docs) {
      const r = await getText(ctx, `https://raw.githubusercontent.com/${list}/HEAD/${d.path.split('/').map(encodeURIComponent).join('/')}`);
      if (!r || r.status !== 200) continue;
      st.docs++;
      const found = /marketplace\.json$/i.test(d.path) ? P.parseMarketplace(r.body, list) : [];
      for (const repo of [...found, ...P.extractGithubRepos(r.body)]) {
        const k = repo.toLowerCase();
        if (listSet.has(k) || linked.has(k)) continue;
        linked.add(k); st.linked.push(repo);
      }
    }
    st.done[list] = true; st.links = st.linked.length;
    store.saveState('lists', st);
    ctx.log(`lists: ${list} docs=${docs.length} linked repos so far=${st.links}`);
  }
  await treeQueue(ctx, store, 'lists', st, st.linked, opts, (e) => store.addCandidates('lists', treeCands(e)));
}

async function enumSkillsSh(ctx, store, opts) {
  const st = store.state('skillssh');
  if (!st.repos) {
    const robots = await getText(ctx, 'https://www.skills.sh/robots.txt');
    const maps = robots && robots.status === 200 ? [...robots.body.matchAll(/^Sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
    const index = maps.length ? maps : ['https://www.skills.sh/sitemap.xml'];
    const locs = [];
    for (const u of index) {
      const r = await getText(ctx, u);
      if (!r || r.status !== 200) continue;
      const inner = P.parseSitemapLocs(r.body);
      const children = /<sitemapindex/i.test(r.body) ? inner.filter((l) => /skills/i.test(l)) : [];
      if (!children.length) locs.push(...inner);
      for (const c of children) { const cr = await getText(ctx, c); if (cr && cr.status === 200) locs.push(...P.parseSitemapLocs(cr.body)); }
    }
    const byRepo = {};
    for (const e of locs.map(P.parseSkillsShLoc).filter(Boolean)) (byRepo[e.repo] = byRepo[e.repo] || []).push(e.skill);
    Object.assign(st, { entries: Object.values(byRepo).reduce((a, s) => a + s.length, 0), byRepo, repos: Object.keys(byRepo),
      resolved: 0, unresolved: {}, unresolvedList: [], treeIndex: 0 });
    store.saveState('skillssh', st);
    ctx.log(`skillssh: sitemap entries=${st.entries} repos=${st.repos.length}`);
  }
  const miss = (reason, repo, skill) => {
    st.unresolved[reason] = (st.unresolved[reason] || 0) + 1;
    if (st.unresolvedList.length < 5000) st.unresolvedList.push({ repo, skill, reason });
  };
  await treeQueue(ctx, store, 'skillssh', st, st.repos, opts, (entry, repo) => {
    const skills = st.byRepo[repo] || [];
    const paths = entry.skills.map((s) => s.path); const slugOf = {};
    for (const skill of skills) {
      if (entry.status !== 'ok') { miss(entry.status === 'not_found' ? 'repo_not_found' : `repo_${entry.status}`, repo, skill); continue; }
      const p = P.resolveSkillsSh(skill, paths);
      if (p) { st.resolved++; slugOf[p] = skill; } else miss('no_match', repo, skill);
    }
    return store.addCandidates('skillssh', treeCands(entry, (s) => (slugOf[s.path] ? { skillssh: slugOf[s.path] } : {})));
  });
}

const SOURCES = { codesearch: enumCodeSearch, topics: enumTopics, lists: enumLists, skillssh: enumSkillsSh };
async function enumerate(ctx, store, opts) {
  const names = opts.source && opts.source !== 'all' ? [opts.source] : Object.keys(SOURCES);
  for (const n of names) {
    if (!SOURCES[n]) throw new Error(`unknown source: ${n}`);
    await SOURCES[n](ctx, store, opts);
  }
}

module.exports = { enumerate, treeRepo, SOURCES, TOPICS, LISTS, ROOT_RANGES, FACETS_FOR_TEST: P.SIZE_FACETS };
