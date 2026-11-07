'use strict';
// forge-skill-harvest-fetch.cjs — `fetch`: download each candidate SKILL.md as DATA plus what its folder ships.
// One batched read-only GraphQL query returns, per skill: repo meta (stars, license, fork, last commit), the SKILL.md
// text and a two-level listing of the skill folder. A second query reads the shipped script files ONLY to grep them
// for network calls. Nothing downloaded is ever written as an executable file or run.
const P = require('./forge-skill-harvest-parse.cjs');
const { parseShard } = require('./forge-skill-harvest-store.cjs');
const { ghJson, getText } = require('./forge-skill-harvest-net.cjs');

const BATCH = 20;
const MAX_SCRIPTS = 12;
const MAX_SCRIPT_BYTES = 300000;
const STOP = new Set(['rate_limited', 'request_budget_spent']);
const lit = (s) => JSON.stringify(String(s));
const BLOB = '... on Blob { byteSize isBinary }';
const TREE2 = `... on Tree { entries { name type path object { ${BLOB} ... on Tree { entries { name type path object { ${BLOB} } } } } } }`;
const TREE1 = `... on Tree { entries { name type path object { ${BLOB} } } }`;
// A two-level listing of a huge folder can time out (502); fall back to one level, then to no listing.
const LISTING = { deep: TREE2, flat: TREE1, none: null };
const SHALLOWER = { deep: 'flat', flat: 'none' };

function groupByRepo(targets) {
  const groups = new Map();
  targets.forEach((t, i) => { const k = t.repo.toLowerCase(); if (!groups.has(k)) groups.set(k, { repo: t.repo, items: [] }); groups.get(k).items.push(i); });
  return [...groups.values()];
}
function repoHead(g, gi) {
  const cut = g.repo.indexOf('/');
  return `  r${gi}: repository(owner: ${lit(g.repo.slice(0, cut))}, name: ${lit(g.repo.slice(cut + 1))}) {`;
}

function buildSkillQuery(targets, listing = 'deep') {
  const lines = ['query {', '  rateLimit { cost remaining resetAt }'];
  groupByRepo(targets).forEach((g, gi) => {
    lines.push(repoHead(g, gi));
    lines.push('    nameWithOwner stargazerCount isFork licenseInfo { spdxId } pushedAt defaultBranchRef { target { ... on Commit { committedDate } } }');
    for (const i of g.items) {
      lines.push(`    s${i}: object(expression: ${lit('HEAD:' + targets[i].path)}) { ... on Blob { byteSize isBinary isTruncated text } }`);
      if (LISTING[listing]) lines.push(`    d${i}: object(expression: ${lit('HEAD:' + P.dirOf(targets[i].path))}) { ${LISTING[listing]} }`);
    }
    lines.push('  }');
  });
  lines.push('}');
  return lines.join('\n');
}

function buildScriptQuery(jobs) {
  const lines = ['query {'];
  groupByRepo(jobs).forEach((g, gi) => {
    lines.push(repoHead(g, gi));
    for (const i of g.items) lines.push(`    f${i}: object(expression: ${lit('HEAD:' + jobs[i].path)}) { ... on Blob { text } }`);
    lines.push('  }');
  });
  lines.push('}');
  return lines.join('\n');
}

function flatEntries(tree) {
  const out = [];
  const walk = (t) => (t && Array.isArray(t.entries) ? t.entries : []).forEach((e) => {
    out.push({ path: e.path, type: e.type, size: e.object && e.object.byteSize, isBinary: e.object && e.object.isBinary });
    if (e.type === 'tree') walk(e.object);
  });
  walk(tree);
  return out;
}

function aliasError(json, alias) {
  const e = (json && Array.isArray(json.errors) ? json.errors : []).find((x) => Array.isArray(x.path) && x.path[0] === alias);
  return e ? (e.type === 'NOT_FOUND' ? 'repo_not_found' : `graphql_${String(e.type || 'error').toLowerCase()}`) : 'repo_not_found';
}

async function gql(ctx, query) {
  return ghJson(ctx, ['graphql', '--input', '-'], { resource: 'graphql', input: JSON.stringify({ query }), serverRetries: 1 });
}

// Fetch one batch. Returns { recs, texts } or null when stopped by rate limit / budget.
async function fetchBatch(ctx, targets, listing = 'deep') {
  const r = await gql(ctx, buildSkillQuery(targets, listing));
  if (!r.ok && STOP.has(r.error)) return null;
  const data = r.json && r.json.data;
  if (!data) {
    // Most failures are a deep folder listing timing out: first retry the whole batch one level shallower,
    // then halve to isolate the slow skill, then drop its listing (text still saved, ships marked listing:none).
    if (listing === 'deep') return fetchBatch(ctx, targets, 'flat');
    if (targets.length > 1) {
      const half = Math.ceil(targets.length / 2);
      const a = await fetchBatch(ctx, targets.slice(0, half), listing); if (!a) return null;
      const b = await fetchBatch(ctx, targets.slice(half), listing); if (!b) return null;
      return { recs: [...a.recs, ...b.recs], texts: [...a.texts, ...b.texts] };
    }
    if (SHALLOWER[listing]) return fetchBatch(ctx, targets, SHALLOWER[listing]);
    return { recs: [fail(targets[0], `graphql_${r.error || 'no_data'}`)], texts: [] };
  }
  const recs = []; const texts = []; const jobs = [];
  for (const [gi, g] of groupByRepo(targets).entries()) {
    const repoData = data[`r${gi}`];
    for (const i of g.items) {
      const t = targets[i];
      if (!repoData) { recs.push(fail(t, aliasError(r.json, `r${gi}`))); continue; }
      const blob = repoData[`s${i}`];
      if (!blob) { recs.push(fail(t, 'not_at_head')); continue; }
      if (blob.isBinary) { recs.push(fail(t, 'binary')); continue; }
      let text = blob.text;
      if (text == null || blob.isTruncated) {
        const raw = await getText(ctx, `https://raw.githubusercontent.com/${t.repo}/HEAD/${t.path.split('/').map(encodeURIComponent).join('/')}`);
        text = raw && raw.status === 200 ? raw.body : null;
      }
      if (text == null) { recs.push(fail(t, 'no_text')); continue; }
      const fm = P.parseFrontmatter(text); const sha = P.sha256(text);
      const ships = { ...P.classifyShips(flatEntries(repoData[`d${i}`]), P.dirOf(t.path)), listing };
      const dirEntries = flatEntries(repoData[`d${i}`]);
      const scripts = ships.script_paths.filter((p) => { const e = dirEntries.find((x) => x.path === p); return !e || !e.size || e.size <= MAX_SCRIPT_BYTES; }).slice(0, MAX_SCRIPTS);
      const rec = { key: `${t.repo.toLowerCase()}|${t.path}`, repo: repoData.nameWithOwner || t.repo, path: t.path, blob: t.blob, status: 'ok', sha256: sha,
        bytes: Buffer.byteLength(text, 'utf8'), name: fm.name, description: fm.description, frontmatter: fm.fields,
        stars: repoData.stargazerCount, is_fork: repoData.isFork, license: repoData.licenseInfo ? repoData.licenseInfo.spdxId : null,
        last_commit: repoData.defaultBranchRef && repoData.defaultBranchRef.target ? repoData.defaultBranchRef.target.committedDate : null,
        pushed_at: repoData.pushedAt, ships: { ...ships, script_paths: ships.script_paths.slice(0, 50) }, fetched_at: new Date(ctx.now()).toISOString() };
      rec.ships.network = { files_scanned: 0, files_with_network: 0, markers: [], hosts: [] };
      scripts.forEach((p) => jobs.push({ repo: t.repo, path: p, rec }));
      recs.push(rec); texts.push({ sha256: sha, repo: rec.repo, path: t.path, text });
    }
  }
  if (jobs.length && !(await scanScripts(ctx, jobs))) return null;
  return { recs, texts };
}

async function scanScripts(ctx, jobs) {
  for (let k = 0; k < jobs.length; k += 40) {
    const part = jobs.slice(k, k + 40);
    const r = await gql(ctx, buildScriptQuery(part));
    if (!r.ok && STOP.has(r.error)) return false;
    part.forEach((job, i) => {
      const repoData = r.json && r.json.data ? r.json.data[groupIndex(part, i)] : null;
      const f = repoData && repoData[`f${i}`];
      if (!f || typeof f.text !== 'string') return;
      const net = job.rec.ships.network; const g = P.grepNetwork(f.text);
      net.files_scanned++;
      if (g.markers.length || g.hosts.length) net.files_with_network++;
      net.markers = [...new Set([...net.markers, ...g.markers])].sort();
      net.hosts = [...new Set([...net.hosts, ...g.hosts])].slice(0, 25);
    });
  }
  return true;
}
function groupIndex(jobs, i) {
  const groups = groupByRepo(jobs);
  return `r${groups.findIndex((g) => g.items.includes(i))}`;
}
// Transient failures that --retry-failed fetches again; binary files and not_at_head stay failed.
const isRetryable = (reason) => /^graphql_/.test(String(reason || '')) || reason === 'no_text';
const fail = (t, reason) => ({ key: `${t.repo.toLowerCase()}|${t.path}`, repo: t.repo, path: t.path, blob: t.blob, status: 'failed', reason });

// Collect unfetched candidates (all sources, deduped by repo+path) and fetch them in batches.
// Shard by blob (else key) so every copy of one file lands in the same shard and blob dedupe still holds.
const shardOf = (id, n) => parseInt(P.sha256(id).slice(0, 8), 16) % n;

async function fetchAll(ctx, store, opts = {}) {
  const sh = parseShard(opts.shard);
  const done = store.fetchedLite();
  const blobOwner = new Map();
  for (const [key, r] of done) if (r.status === 'ok' && r.blob) blobOwner.set(r.blob, key);
  const seen = new Set(); const targets = []; const dupsOf = new Map();
  for (const src of store.sources()) {
    store.eachCandidate(src, (c) => {
      const key = store.keyOf(c.repo, c.path);
      if (seen.has(key)) return;
      const prev = done.get(key);
      if (prev && !(opts.retryFailed && prev.status === 'failed' && isRetryable(prev.reason))) return;
      seen.add(key);
      const t = { repo: c.repo, path: c.path, blob: c.blob || null };
      if (sh && shardOf(t.blob || key, sh.n) !== sh.i) return;
      if (t.blob && (blobOwner.has(t.blob) || dupsOf.has(t.blob))) {
        if (blobOwner.has(t.blob)) { store.addFetched([{ key, repo: t.repo, path: t.path, blob: t.blob, status: 'dup_blob', of: blobOwner.get(t.blob) }]); return; }
        dupsOf.get(t.blob).push(t); return;
      }
      if (t.blob) dupsOf.set(t.blob, []);
      targets.push(t);
    });
  }
  const cap = opts.limit || Infinity; const lim = () => Math.min(cap, targets.length);
  const size = opts.batch || BATCH; let ok = 0; let failed = 0; let k = 0;
  ctx.log(`fetch: ${targets.length} unique blobs to fetch (${done.size} already recorded); this run: ${lim()}`);
  for (; k < lim(); k += size) {
    const batch = targets.slice(k, Math.min(k + size, lim()));
    const res = await fetchBatch(ctx, batch);
    if (!res) { ctx.log('fetch: stopped on rate limit/budget; re-run to continue'); break; }
    store.addTexts(res.texts);
    const extra = [];
    for (const rec of res.recs) {
      if (rec.status === 'ok') ok++; else failed++;
      const dups = rec.blob ? dupsOf.get(rec.blob) || [] : [];
      if (rec.status === 'ok') dups.forEach((d) => extra.push({ key: store.keyOf(d.repo, d.path), repo: d.repo, path: d.path, blob: d.blob, status: 'dup_blob', of: rec.key }));
      else if (dups.length) { const next = dups.shift(); targets.push(next); }
    }
    store.addFetched([...res.recs, ...extra]);
    ctx.log(`fetch: ${Math.min(k + size, lim())}/${lim()} ok=${ok} failed=${failed} dup_blob+=${extra.length}`);
  }
  return { ok, failed, remaining: Math.max(0, targets.length - Math.min(k, targets.length)) };
}

module.exports = { isRetryable, fetchAll, buildSkillQuery, buildScriptQuery, flatEntries };
