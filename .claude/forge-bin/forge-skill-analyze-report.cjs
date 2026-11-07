'use strict';
// forge-skill-analyze-report.cjs — builds the summary files of the skill-corpus analyser from the analysed records
// dup-groups.json, categories.json, clusters/<category>.json and ours.json. Pure apart from writeJson.
const fs = require('fs');
const path = require('path');
const T = require('./forge-skill-analyze-taxonomy.cjs');
const { clusterCategory, R_MAX } = require('./forge-skill-analyze-cluster.cjs');
const { jaccard } = require('./forge-skill-analyze-features.cjs');

const TOP_N = 10;
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
const rep = (r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path, quality: r.quality.score, stars: r.stars, risky: r.risk.risky, categories: r.categories });
const byQuality = (a, b) => b.quality.score - a.quality.score || (b.stars || 0) - (a.stars || 0) || (a.id < b.id ? -1 : 1);

function dupGroups(recs, dd, method) {
  const groups = dd.groups.map((g) => {
    const best = recs[g.bestIndex];
    return { best: g.best, size: g.size, reasons: g.reasons,
      members: g.indices.map((i) => recs[i]).sort(byQuality).map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path, quality: r.quality.score,
        stars: r.stars, similarity_to_best: r.sig && best.sig ? Math.round(jaccard(r.sig, best.sig) * 1000) / 1000 : null })) };
  });
  const families = dd.families.map((g) => ({ best: g.best, size: g.size,
    members: g.indices.map((i) => recs[i]).sort(byQuality).map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path, quality: r.quality.score })) }));
  const inGroups = groups.reduce((s, g) => s + g.size, 0);
  return { method, stats: { ...dd.stats, groups: groups.length, records_in_groups: inGroups, removed_as_near_copies: inGroups - groups.length, template_families: families.length },
    groups, families_note: 'template families: same skeleton body, different name and description; NOT merged, every member keeps its own count', families };
}

const emptyBands = () => ({ high: 0, medium: 0, low: 0 });
function categoryCounts(recs, canon) {
  const cats = {};
  for (const id of T.CAT_IDS) cats[id] = { all: 0, unique: 0, risky: 0, risky_unique: 0, by_band: emptyBands(), by_band_unique: emptyBands(), top: [] };
  const tops = Object.fromEntries(T.CAT_IDS.map((id) => [id, []]));
  recs.forEach((r, i) => {
    const uniq = canon[i] === i;
    for (const c of r.categories) {
      const k = cats[c]; k.all++; k.by_band[r.quality.band]++;
      if (r.risk.risky) k.risky++;
      if (uniq) { k.unique++; k.by_band_unique[r.quality.band]++; if (r.risk.risky) k.risky_unique++; tops[c].push(r); }
    }
  });
  for (const id of T.CAT_IDS) cats[id].top = tops[id].sort(byQuality).slice(0, TOP_N).map(rep);
  return { cats, uniqueMembers: tops };
}

// Terms -> interned ids with corpus document frequency.
function internTerms(recs) {
  const ids = new Map(); const names = []; const dfArr = [];
  for (const r of recs) {
    const tf = new Map();
    for (const t of r.termList) { let id = ids.get(t); if (id === undefined) { id = names.length; ids.set(t, id); names.push(t); dfArr.push(0); } tf.set(id, (tf.get(id) || 0) + 1); }
    for (const id of tf.keys()) dfArr[id]++;
    r.terms = tf;
  }
  return { names, df: Int32Array.from(dfArr) };
}

function writeClusters(outDir, recs, canon, uniqueMembers) {
  const { names, df } = internTerms(recs);
  const copies = new Map(); recs.forEach((r, i) => copies.set(canon[i], (copies.get(canon[i]) || 0) + 1));
  const summary = {};
  for (const id of T.CAT_IDS) {
    const members = uniqueMembers[id].map((r) => ({ id: r.id, quality: r.quality.score, stars: r.stars, copies: copies.get(r.index) || 1, terms: r.terms, rep: rep(r) }));
    const res = clusterCategory(members, df, recs.length, (t) => names[t]);
    writeJson(path.join(outDir, 'clusters', `${id}.json`), { category: id, about: T.TAXONOMY.find((c) => c.id === id).about,
      unique_members: members.length, cluster_count: res.clusters.length, max_representatives: R_MAX,
      method: 'seed-term TF-IDF (see forge-skill-analyze-cluster.cjs)', seeds: res.seeds || 0, min_support: res.min_support || null, clusters: res.clusters });
    summary[id] = res.clusters.length;
  }
  return summary;
}

function oursReport(ours, cats) {
  const per = {};
  for (const id of T.CAT_IDS) per[id] = { ours: 0, ours_names: [], theirs_all: cats[id].all, theirs_unique: cats[id].unique };
  for (const s of ours.skills) for (const c of s.categories) { per[c].ours++; if (per[c].ours_names.length < 60) per[c].ours_names.push(`${s.source}:${s.name}`); }
  const bySource = {}; for (const s of ours.skills) bySource[s.source] = (bySource[s.source] || 0) + 1;
  return { totals: { ours: ours.skills.length, by_source: bySource }, roots: ours.roots, audit_used: ours.audit_used, errors: ours.errors, per_category: per, skills: ours.skills };
}

module.exports = { writeJson, dupGroups, categoryCounts, writeClusters, oursReport, rep, byQuality };
