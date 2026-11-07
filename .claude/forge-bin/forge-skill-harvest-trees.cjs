'use strict';
// forge-skill-harvest-trees.cjs — list the SKILL.md files of many repos fast and within the limits (SA-HARVEST-FAST).
// 1. One batched GraphQL query per 100 repos (cost 1 point, measured) tells which repos are gone, empty or renamed, so
//    those cost no core request and a renamed repo is listed once under its real name.
// 2. The remaining repos are listed with the REST git trees endpoint (recursive, one core request each) by parallel
//    workers that share one token bucket (-bucket.cjs), so together they stay inside core 5000/h.
// Why not list the files themselves over GraphQL: GraphQL has no recursive tree. Measured live 2026-11-05: a nested
// three-level `entries` listing answered 502 even for 10 repos; two levels for 25 repos took 9 s and still left 828
// sub-folders unlisted, while SKILL.md files sit up to 9 levels deep. So REST stays the lister, GraphQL the triage.
const P = require('./forge-skill-harvest-parse.cjs');
const { ghJson } = require('./forge-skill-harvest-net.cjs');

const STOP = new Set(['rate_limited', 'request_budget_spent', 'server_error']);
const META_BATCH = 100;
const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 8;
const lit = (s) => JSON.stringify(String(s));

function buildMetaQuery(repos) {
  const lines = ['query {', '  rateLimit { cost remaining resetAt }'];
  repos.forEach((repo, i) => {
    const cut = repo.indexOf('/');
    lines.push(`  r${i}: repository(owner: ${lit(repo.slice(0, cut))}, name: ${lit(repo.slice(cut + 1))}) { nameWithOwner isEmpty defaultBranchRef { name } }`);
  });
  lines.push('}');
  return lines.join('\n');
}

// repo -> { status: 'not_found' | 'empty' | 'ok', canonical? }. A repo the answer does not settle is left out (REST decides).
function parseMeta(repos, json) {
  const out = new Map();
  const data = json && json.data;
  if (!data) return out;
  const errs = new Map((Array.isArray(json.errors) ? json.errors : []).filter((e) => e && Array.isArray(e.path)).map((e) => [e.path[0], e.type]));
  repos.forEach((repo, i) => {
    const v = data[`r${i}`];
    if (v === null || v === undefined) { if (errs.get(`r${i}`) === 'NOT_FOUND') out.set(repo, { status: 'not_found' }); return; }
    if (v.isEmpty) { out.set(repo, { status: 'empty' }); return; }
    out.set(repo, { status: 'ok', canonical: v.nameWithOwner || repo });
  });
  return out;
}

// Returns the meta map, or null when a rate limit / budget stops the run.
async function metaPass(ctx, repos) {
  const r = await ghJson(ctx, ['graphql', '--input', '-'], { resource: 'graphql', input: JSON.stringify({ query: buildMetaQuery(repos) }), serverRetries: 2 });
  if (!r.ok && STOP.has(r.error) && r.error !== 'server_error') return null;
  return parseMeta(repos, r.json);
}

// List SKILL.md files in a repo via the git tree API (cached across sources). Returns { entry, tree } or null on stop.
async function treeRepo(ctx, store, src, repo, { wantTree = false, canonical } = {}) {
  const cached = store.treeCache().get(repo.toLowerCase());
  if (cached && !wantTree) return { entry: cached, tree: null };
  const name = canonical || repo;
  const r = await ghJson(ctx, [`repos/${name}/git/trees/HEAD?recursive=1`], { resource: 'core' });
  if (!r.ok && STOP.has(r.error)) return null;
  const extra = name !== repo ? { canonical: name } : {};
  let entry; let tree = null;
  if (!r.ok) entry = { repo, ...extra, status: r.status === 404 ? 'not_found' : r.status === 409 ? 'empty' : r.error, skills: [] };
  else {
    tree = Array.isArray(r.json && r.json.tree) ? r.json.tree : [];
    entry = { repo, ...extra, status: 'ok', truncated: !!r.json.truncated,
      skills: tree.filter((e) => e.type === 'blob' && P.isSkillFile(e.path)).map((e) => ({ path: e.path, blob: e.sha })) };
  }
  if (!cached) store.saveTree(src, entry);
  return { entry, tree };
}
const treeCands = (entry, extra = () => ({})) => entry.skills.map((s) => ({ repo: entry.canonical || entry.repo, path: s.path, blob: s.blob, ...extra(s) }));

// Settle one repo without REST when the pre-pass already knows: gone, empty, or a rename of a repo listed before.
function settleFromMeta(store, src, repo, m) {
  if (!m) return null;
  if (m.status === 'not_found' || m.status === 'empty') { const e = { repo, status: m.status, skills: [], via: 'graphql' }; store.saveTree(src, e); return e; }
  if (m.canonical && m.canonical.toLowerCase() !== repo.toLowerCase()) {
    const known = store.treeCache().get(m.canonical.toLowerCase());
    if (known) { const e = { ...known, repo, canonical: known.canonical || known.repo }; store.saveTree(src, e); return e; }
  }
  return null;
}

// Run fn over items with at most `workers` in flight; a null result stops new work (rate limit / budget).
async function pool(items, workers, fn) {
  const results = new Array(items.length); let next = 0; let stopped = false;
  const run = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      const r = await fn(items[i]);
      if (r === null) { stopped = true; return; }
      results[i] = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
  return { results, stopped };
}

// Tree repos[st.treeIndex..] up to `limit` NEW tree listings, in chunks of META_BATCH. onEntry(entry, repo) runs in list
// order; st.treeIndex only moves past repos that are settled, so a stop or crash resumes at the first unfinished one
// (finished repos past it are in the tree cache and cost nothing on resume).
async function treeQueue(ctx, store, src, st, repos, opts, onEntry) {
  const workers = Math.max(1, Math.min(MAX_WORKERS, opts.workers || DEFAULT_WORKERS));
  let fresh = 0;
  while (st.treeIndex < repos.length) {
    const chunk = []; const todo = [];
    for (let i = st.treeIndex; i < repos.length && chunk.length < META_BATCH; i++) {
      const cached = store.treeCache().has(repos[i].toLowerCase());
      if (!cached && opts.limit && fresh + todo.length >= opts.limit) break;
      chunk.push(repos[i]);
      if (!cached) todo.push(repos[i]);
    }
    if (!chunk.length) break;
    const entries = new Map();
    let meta = new Map();
    if (todo.length) {
      meta = await metaPass(ctx, todo);
      if (!meta) { ctx.log(`${src}: stopped on rate limit/budget at repo ${st.treeIndex}/${repos.length}`); break; }
    }
    const rest = [];
    for (const repo of todo) { const e = settleFromMeta(store, src, repo, meta.get(repo)); if (e) entries.set(repo, e); else rest.push(repo); }
    // Two names for one repo (a rename and its new name in the same list) are listed once.
    const groups = new Map();
    for (const repo of rest) {
      const m = meta.get(repo); const k = ((m && m.canonical) || repo).toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(repo);
    }
    const res = await pool([...groups.values()], workers, async ([first, ...aliases]) => {
      const m = meta.get(first);
      const out = await treeRepo(ctx, store, src, first, { canonical: m && m.canonical });
      if (!out) return null;
      entries.set(first, out.entry);
      for (const alias of aliases) {
        const e = { ...out.entry, repo: alias, canonical: out.entry.canonical || out.entry.repo };
        store.saveTree(src, e); entries.set(alias, e);
      }
      ctx.log(`${src}: tree ${first} skills=${out.entry.skills.length}${out.entry.canonical ? ` (as ${out.entry.canonical})` : ''}`);
      return true;
    });
    fresh += todo.length;
    let added = 0; let done = 0;
    for (const repo of chunk) {
      const e = entries.get(repo) || store.treeCache().get(repo.toLowerCase());
      if (!e) break;
      added += onEntry(e, repo) || 0;
      done++;
    }
    st.treeIndex += done;
    store.saveState(src, st);
    const gone = [...meta.values()].filter((m) => m.status !== 'ok').length;
    ctx.log(`${src}: trees ${st.treeIndex}/${repos.length} chunk=${chunk.length} rest=${rest.length} settled_by_graphql=${todo.length - rest.length} (gone/empty=${gone}) new_candidates=${added}`);
    if (res.stopped || done < chunk.length) { ctx.log(`${src}: stopped on rate limit/budget at repo ${st.treeIndex}/${repos.length}`); break; }
  }
  store.saveState(src, st);
}

module.exports = { buildMetaQuery, parseMeta, metaPass, treeRepo, treeCands, treeQueue, pool, META_BATCH, DEFAULT_WORKERS, MAX_WORKERS };
