'use strict';
// forge-skill-analyze-dedupe.cjs — near-duplicate groups over the skill corpus.
// The harvester already merged byte-identical SKILL.md files (sha256 -> copies/also_at). This finds NEAR copies:
//   similarity : MinHash estimate of word-3-shingle Jaccard >= SIM (0.8), candidates via LSH (16 bands x 4 rows,
//                ~0.5 LSH threshold so recall at J=0.8 is ~99.9%), every candidate verified on the full 64-value signature;
//   name       : same normalised name AND estimated Jaccard >= NAME_SIM (0.5). A shared name alone is not enough:
//                "review" or "deploy" is the name of hundreds of different skills. Same-name pairs that were NOT
//                merged are counted in stats.same_name_not_merged so nothing is hidden.
//   template family: a similarity pair whose names differ AND whose descriptions (both >= 3 content words) share
//                less than DESC_SIM (0.5) of their words is NOT a copy: it is one generator's skeleton filled in for different
//                skills ("AI FAQ creator" vs "AI content detector"). Such pairs go to `families` and keep their own count.
// Groups are connected components (union-find). The best copy = highest quality, then most stars, then lowest id.
const { jaccard, K } = require('./forge-skill-analyze-features.cjs');

const SIM = 0.8; const NAME_SIM = 0.5; const DESC_SIM = 0.5; const BANDS = 16; const ROWS = K / BANDS;
const PAIRWISE_MAX = 64; const NAME_REPS_MAX = 200;

const normName = (s) => (typeof s === 'string' && s.trim() ? s.toLowerCase().replace(/[^a-z0-9]+/g, '') || null : null);

function unionFind(n) {
  const p = new Int32Array(n); for (let i = 0; i < n; i++) p[i] = i;
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  return { find, union: (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) p[Math.max(ra, rb)] = Math.min(ra, rb); return ra !== rb; } };
}

const better = (items, a, b) => {
  const x = items[a]; const y = items[b];
  if (x.quality !== y.quality) return x.quality > y.quality;
  if ((x.stars || 0) !== (y.stars || 0)) return (x.stars || 0) > (y.stars || 0);
  return String(x.id) < String(y.id);
};

const setJaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const isFamily = (x, y) => x.nameKey !== y.nameKey && x.descTokens && y.descTokens && x.descTokens.size >= 3 && y.descTokens.size >= 3
  && setJaccard(x.descTokens, y.descTokens) < DESC_SIM;

function components(n, uf, items, minSize) {
  const comp = new Map();
  for (let i = 0; i < n; i++) { const r = uf.find(i); const arr = comp.get(r); if (arr) arr.push(i); else comp.set(r, [i]); }
  const out = [];
  for (const [root, arr] of comp) {
    if (arr.length < minSize) continue;
    let best = arr[0]; for (const i of arr) if (better(items, i, best)) best = i;
    out.push({ root, best, arr });
  }
  return out;
}

// items: [{ id, nameKey, descTokens (Set|undefined), sig (Uint32Array|null), quality, stars }]
// -> { groups: [{ best, members: [ids], reasons, size }], families: [{ best, members, size }], canon: Int32Array, stats }
function findGroups(items, opts = {}) {
  const sim = opts.sim || SIM; const nameSim = opts.nameSim || NAME_SIM;
  const n = items.length; const uf = unionFind(n); const fam = unionFind(n);
  const reasonsByPair = []; // [i, j, reason]
  const stats = { lsh_buckets: 0, candidate_pairs: 0, similar_pairs: 0, name_pairs: 0, same_name_not_merged: 0, without_signature: 0, template_family_pairs: 0 };
  const link = (i, j, reason) => { reasonsByPair.push([i, j, reason]); uf.union(i, j); };

  // 1. LSH over the signatures
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const s = items[i].sig; if (!s) continue;
      let key = ''; for (let r = 0; r < ROWS; r++) key += s[b * ROWS + r].toString(36) + ',';
      const arr = buckets.get(key); if (arr) arr.push(i); else buckets.set(key, [i]);
    }
    for (const arr of buckets.values()) {
      if (arr.length < 2) continue;
      stats.lsh_buckets++;
      const pairwise = arr.length <= PAIRWISE_MAX;
      for (let x = 1; x < arr.length; x++) {
        const lim = pairwise ? x : 1;
        for (let y = 0; y < lim; y++) {
          const i = arr[y]; const j = arr[x];
          if (uf.find(i) === uf.find(j) || fam.find(i) === fam.find(j)) continue;
          stats.candidate_pairs++;
          if (jaccard(items[i].sig, items[j].sig) < sim) continue;
          if (isFamily(items[i], items[j])) { stats.template_family_pairs++; fam.union(i, j); continue; }
          stats.similar_pairs++; link(i, j, 'similarity');
        }
      }
    }
  }
  // 2. same normalised name + a moderately similar body
  const byName = new Map();
  for (let i = 0; i < n; i++) {
    if (!items[i].sig) stats.without_signature++;
    const k = items[i].nameKey; if (!k || k.length < 2) continue;
    const arr = byName.get(k); if (arr) arr.push(i); else byName.set(k, [i]);
  }
  for (const arr of byName.values()) {
    if (arr.length < 2) continue;
    const reps = [];
    for (const i of arr) {
      const s = items[i].sig;
      if (!s) { stats.same_name_not_merged++; continue; }
      let hit = -1;
      for (const r of reps) { if (jaccard(items[r].sig, s) >= nameSim) { hit = r; break; } }
      if (hit >= 0) { stats.name_pairs++; if (uf.find(hit) !== uf.find(i)) link(hit, i, 'name'); } else {
        if (reps.length) stats.same_name_not_merged++;
        if (reps.length < NAME_REPS_MAX) reps.push(i);
      }
    }
  }
  // 3. components -> groups (copies) and families (reported only)
  const reasonOf = new Map();
  for (const [i, , why] of reasonsByPair) { const r = uf.find(i); if (!reasonOf.has(r)) reasonOf.set(r, new Set()); reasonOf.get(r).add(why); }
  const canon = new Int32Array(n); for (let i = 0; i < n; i++) canon[i] = i;
  const bySize = (x, y) => y.size - x.size || (String(x.best) < String(y.best) ? -1 : 1);
  const groups = components(n, uf, items, 2).map(({ root, best, arr }) => {
    for (const i of arr) canon[i] = best;
    return { best: items[best].id, bestIndex: best, members: arr.map((i) => items[i].id), indices: arr, reasons: [...(reasonOf.get(root) || [])].sort(), size: arr.length };
  }).sort(bySize);
  const families = components(n, fam, items, 2).map(({ best, arr }) => ({ best: items[best].id, bestIndex: best, members: arr.map((i) => items[i].id), indices: arr, size: arr.length })).sort(bySize);
  return { groups, families, canon, stats };
}

module.exports = { findGroups, normName, SIM, NAME_SIM, DESC_SIM, BANDS, ROWS };
