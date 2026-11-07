'use strict';
// forge-skill-analyze-cluster.cjs — deterministic sub-topic clusters inside one category.
// Method "seed-term TF-IDF" (no randomness, no iteration order effects):
//   1. every unique skill carries its content terms (name + description + headings, stop words removed);
//   2. TF-IDF weight = tf * ln(N / df) with df over the WHOLE corpus;
//   3. seed terms = the terms most skills of this category carry (category frequency >= minSupport), skipping terms
//      carried by more than half of a category of 20+ (too generic to split on); at most K = clamp(round(1.5*sqrt(m)), 1, 80);
//   4. each skill joins the seed term with the highest TF-IDF weight in that skill (ties: the more frequent seed);
//      a skill with no seed term, or a cluster that ends up with a single skill in a category of 20+, goes to "misc";
//   5. per cluster: exact count, count incl. near-copies, top terms (summed TF-IDF) and up to R representatives:
//      the best by quality first, then the most distinct (greedy: most top terms not yet covered by earlier picks).
const R_MAX = 10; const R_BEST = 5; const TOP_TERMS = 10;

const byQuality = (a, b) => b.quality - a.quality || (b.stars || 0) - (a.stars || 0) || (String(a.id) < String(b.id) ? -1 : 1);

// members: [{ id, quality, stars, copies (near-copies incl. itself), terms: Map<termId, tf>, rep: {...} }]
// df: Int32Array of corpus document frequency per termId; N: corpus size; termName: (id) => string
function clusterCategory(members, df, N, termName, opts = {}) {
  const m = members.length;
  const rMax = opts.maxRepresentatives || R_MAX;
  if (!m) return { clusters: [], seeds: 0 };
  const idf = (t) => Math.log((N + 1) / ((df[t] || 0) + 1)) + 1e-9;
  const weights = members.map((x) => { const w = new Map(); for (const [t, tf] of x.terms) w.set(t, tf * idf(t)); return w; });

  const cf = new Map();
  for (const x of members) for (const t of x.terms.keys()) cf.set(t, (cf.get(t) || 0) + 1);
  const minSupport = Math.max(2, Math.ceil(m * 0.005));
  const K = Math.max(1, Math.min(80, Math.round(1.5 * Math.sqrt(m))));
  const seeds = [...cf.entries()]
    .filter(([, c]) => c >= minSupport && !(m >= 20 && c > m / 2))
    .sort((a, b) => b[1] - a[1] || (termName(a[0]) < termName(b[0]) ? -1 : 1))
    .slice(0, K).map(([t]) => t);
  const rank = new Map(seeds.map((t, i) => [t, i]));

  const buckets = new Map(); // seed termId | -1 (misc) -> member indexes
  members.forEach((x, i) => {
    let best = -1; let bw = -1;
    for (const [t, w] of weights[i]) {
      if (!rank.has(t)) continue;
      if (w > bw || (w === bw && rank.get(t) < rank.get(best))) { best = t; bw = w; }
    }
    const arr = buckets.get(best); if (arr) arr.push(i); else buckets.set(best, [i]);
  });
  if (m >= 20) {
    for (const [k, arr] of [...buckets]) {
      if (k === -1 || arr.length > 1) continue;
      buckets.delete(k);
      const misc = buckets.get(-1); if (misc) misc.push(...arr); else buckets.set(-1, arr);
    }
  }

  const clusters = [];
  for (const [seed, idx] of buckets) {
    const sum = new Map();
    for (const i of idx) for (const [t, w] of weights[i]) sum.set(t, (sum.get(t) || 0) + w);
    const top = [...sum.entries()].sort((a, b) => b[1] - a[1] || (termName(a[0]) < termName(b[0]) ? -1 : 1)).slice(0, TOP_TERMS);
    const topSet = new Set(top.map(([t]) => t));
    const sorted = idx.slice().sort((a, b) => byQuality(members[a], members[b]));
    const picked = sorted.slice(0, Math.min(R_BEST, rMax));
    const covered = new Set(); for (const i of picked) for (const t of members[i].terms.keys()) if (topSet.has(t)) covered.add(t);
    const rest = sorted.slice(picked.length);
    while (picked.length < rMax && rest.length) {
      let bi = -1; let bg = -1;
      rest.forEach((i, k) => { let g = 0; for (const t of members[i].terms.keys()) if (!covered.has(t)) g++; if (g > bg) { bg = g; bi = k; } });
      const [i] = rest.splice(bi, 1); picked.push(i);
      for (const t of members[i].terms.keys()) covered.add(t);
    }
    clusters.push({
      label: seed === -1 ? 'misc' : termName(seed),
      count: idx.length,
      count_with_near_copies: idx.reduce((s, i) => s + (members[i].copies || 1), 0),
      top_terms: top.map(([t, w]) => ({ term: termName(t), weight: Math.round(w * 100) / 100 })),
      representatives: picked.map((i) => members[i].rep),
    });
  }
  clusters.sort((a, b) => (a.label === 'misc') - (b.label === 'misc') || b.count - a.count || (a.label < b.label ? -1 : 1));
  clusters.forEach((c, i) => { c.id = i; });
  return { clusters, seeds: seeds.length, min_support: minSupport, k_max: K };
}

module.exports = { clusterCategory, R_MAX };
