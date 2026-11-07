'use strict';
// forge-skill-harvest-index.cjs — `index` + `status`: build corpus.jsonl (one record per unique SKILL.md content)
// and coverage.json (found / fetched / failed with reason / duplicates removed, per source).
const fs = require('fs');
const path = require('path');

function sourceNotes(store) {
  const cs = store.state('codesearch'); const tp = store.state('topics');
  const ls = store.state('lists'); const sh = store.state('skillssh');
  const leaves = cs.leaves || [];
  const capped = leaves.filter((l) => l.capped);
  return {
    codesearch: cs.queue ? { complete: cs.queue.length === 0, partitions_done: leaves.length, partitions_left: cs.queue.length,
      splits: cs.splits || 0, capped_partitions: capped.length, results_beyond_cap_estimate: capped.reduce((a, l) => a + (l.total - l.retrieved), 0),
      incomplete_partitions: leaves.filter((l) => l.incomplete).length, error_partitions: leaves.filter((l) => l.error).length,
      note: 'GitHub code search total_count values are estimates; capped = a single-size+facet partition still above 1000.' } : { complete: false, started: false },
    topics: tp.repos ? { complete: Object.values(tp.topics).every((t) => !t.queue.length) && tp.treeIndex >= tp.repos.length,
      repos: tp.repos.length, repos_treed: tp.treeIndex, capped_ranges: (tp.capped || []).length,
      per_topic: Object.fromEntries(Object.entries(tp.topics).map(([k, v]) => [k, { repos: v.total, ranges_left: v.queue.length }])) } : { complete: false, started: false },
    lists: ls.done ? { complete: ls.treeIndex >= ls.linked.length, lists_done: Object.keys(ls.done).length, docs_read: ls.docs,
      linked_repos: ls.linked.length, repos_treed: ls.treeIndex } : { complete: false, started: false },
    skillssh: sh.repos ? { complete: sh.treeIndex >= sh.repos.length, entries: sh.entries, repos: sh.repos.length, repos_treed: sh.treeIndex,
      resolved: sh.resolved, unresolved: sh.unresolved } : { complete: false, started: false },
  };
}

function collect(store) {
  const fetched = store.fetched();
  const sourcesOf = new Map(); const per = {};
  for (const src of store.sources()) {
    const s = per[src] = { found: 0, repo_path_duplicates_removed: store.dropped(src), fetched: 0, failed: {}, blob_duplicates: 0, pending: 0 };
    store.eachCandidate(src, (c) => {
      const key = store.keyOf(c.repo, c.path);
      s.found++;
      if (!sourcesOf.has(key)) sourcesOf.set(key, new Set());
      sourcesOf.get(key).add(src);
      const r = fetched.get(key);
      if (!r) s.pending++;
      else if (r.status === 'ok') s.fetched++;
      else if (r.status === 'dup_blob') s.blob_duplicates++;
      else s.failed[r.reason] = (s.failed[r.reason] || 0) + 1;
    });
  }
  return { fetched, sourcesOf, per };
}

function groupContent(fetched, sourcesOf) {
  const bySha = new Map();
  let blobDupes = 0; let failed = 0;
  const srcOf = (key) => [...(sourcesOf.get(key) || [])];
  for (const r of fetched.values()) {
    if (r.status === 'dup_blob') {
      blobDupes++;
      const owner = fetched.get(r.of);
      if (owner && owner.sha256 && bySha.has(owner.sha256)) bySha.get(owner.sha256).extra.push(r);
      else if (owner && owner.sha256) bySha.set(owner.sha256, { recs: [], extra: [r] });
      continue;
    }
    if (r.status !== 'ok') { failed++; continue; }
    if (!bySha.has(r.sha256)) bySha.set(r.sha256, { recs: [], extra: [] });
    bySha.get(r.sha256).recs.push(r);
  }
  const out = [];
  for (const [sha, g] of bySha) {
    if (!g.recs.length) continue;
    const primary = g.recs.reduce((a, b) => ((b.stars || 0) > (a.stars || 0) ? b : a));
    const copies = [...g.recs.filter((r) => r !== primary), ...g.extra];
    const sources = new Set([...g.recs, ...g.extra].flatMap((r) => srcOf(r.key)));
    out.push({ id: sha.slice(0, 16), name: primary.name, description: primary.description, frontmatter: primary.frontmatter,
      repo: primary.repo, path: primary.path, stars: primary.stars, license: primary.license, last_commit: primary.last_commit,
      pushed_at: primary.pushed_at, is_fork: primary.is_fork, sources: [...sources].sort(), ships: primary.ships, sha256: sha,
      bytes: primary.bytes, copies: copies.length, also_at: copies.slice(0, 50).map((r) => `${r.repo}/${r.path}`) });
  }
  const okCount = [...bySha.values()].reduce((a, g) => a + g.recs.length, 0);
  return { corpus: out, blobDupes, failed, contentDupes: okCount - out.length, ok: okCount };
}

function coverage(store) {
  const { fetched, sourcesOf, per } = collect(store);
  const g = groupContent(fetched, sourcesOf);
  const cov = {
    generated_at: new Date().toISOString(),
    totals: { candidates_unique: sourcesOf.size, fetched_ok: g.ok, failed: g.failed, blob_duplicates_removed: g.blobDupes,
      content_duplicates_removed: g.contentDupes, corpus_records: g.corpus.length, pending: [...sourcesOf.keys()].filter((k) => !fetched.has(k)).length },
    sources: per, enumeration: sourceNotes(store),
  };
  return { cov, corpus: g.corpus };
}

function buildIndex(store) {
  const { cov, corpus } = coverage(store);
  fs.mkdirSync(store.corpusDir, { recursive: true });
  const file = path.join(store.corpusDir, 'corpus.jsonl'); const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { for (const rec of corpus) fs.writeSync(fd, JSON.stringify(rec) + '\n'); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  store.writeAtomic(path.join(store.corpusDir, 'coverage.json'), JSON.stringify(cov, null, 2));
  return { corpus: corpus.length, coverage: cov };
}

function statusLines(store) {
  const { cov } = coverage(store);
  const t = cov.totals;
  const lines = [`coverage (live, from work files): candidates=${t.candidates_unique} fetched_ok=${t.fetched_ok} failed=${t.failed} pending=${t.pending} `
    + `blob_dupes=${t.blob_duplicates_removed} content_dupes=${t.content_duplicates_removed} corpus=${t.corpus_records}`];
  for (const [src, s] of Object.entries(cov.sources)) {
    lines.push(`  ${src}: found=${s.found} fetched=${s.fetched} pending=${s.pending} blob_dupes=${s.blob_duplicates} failed=${JSON.stringify(s.failed)}`);
  }
  for (const [src, n] of Object.entries(cov.enumeration)) lines.push(`  enum ${src}: ${JSON.stringify(n)}`);
  return lines;
}

module.exports = { buildIndex, coverage, statusLines };
