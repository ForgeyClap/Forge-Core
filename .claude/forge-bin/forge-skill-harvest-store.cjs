'use strict';
// forge-skill-harvest-store.cjs — on-disk state of the skill harvester.
// Layout under <root>/.claude/forge-research/skills-corpus/ (gitignored):
//   work/state-<source>.json      resumable per-source state (atomic writes)
//   work/candidates-<source>.jsonl one line per (repo, path) found by that source, deduped
//   work/trees-<source>.jsonl     repo -> SKILL.md paths from the git tree API (shared skip-cache)
//   work/fetched[-<i>of<n>].jsonl fetch result per candidate key (ok / failed + reason / dup_blob); one file per shard
//   work/texts[-<i>of<n>].jsonl   SKILL.md text by sha256 (data only)
//   corpus.jsonl, coverage.json   written by `index`
// Directories are created only on the first write, so `status` and `--help` never create anything.
const fs = require('fs');
const path = require('path');

const keyOf = (repo, p) => `${String(repo).toLowerCase()}|${p}`;

function forEachLine(file, fn) {
  if (!fs.existsSync(file)) return 0;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let rest = ''; let bad = 0; let n;
  const take = (line) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { bad++; return; }
    fn(obj);
  };
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const chunk = rest + buf.toString('utf8', 0, n);
      const lines = chunk.split('\n');
      rest = lines.pop();
      lines.forEach(take);
    }
    take(rest);
  } finally { fs.closeSync(fd); }
  return bad;
}

// Parse "i/n" into { i, n } (0 <= i < n); null when absent.
function parseShard(spec) {
  if (spec == null) return null;
  const m = /^(\d+)\/(\d+)$/.exec(String(spec));
  if (!m || Number(m[2]) < 1 || Number(m[1]) >= Number(m[2])) throw new Error(`--shard must look like i/n with 0 <= i < n, got ${spec}`);
  return { i: Number(m[1]), n: Number(m[2]) };
}
const listWork = (work, re) => (fs.existsSync(work) ? fs.readdirSync(work).filter((f) => re.test(f)).sort() : []);

// On Windows a rename onto a file another process has open (a virus scanner, the search indexer, a reader) fails with
// EPERM/EACCES/EBUSY for a moment. Live incident 2026-11-05: that killed `enumerate skillssh` at repo 323/2331 and
// `enumerate lists`. Retry with a bounded backoff (about 15 s in total); any other error is thrown at once.
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_NAPS_MS = [50, 100, 200, 400, 800, 1500, 2500, 4000, 5000];
const sleepSyncReal = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameWithRetry(tmp, file, ops) {
  for (let i = 0; ; i++) {
    try { ops.renameSync(tmp, file); return; } catch (e) {
      if (!RENAME_RETRY.has(e && e.code) || i >= RENAME_NAPS_MS.length) {
        try { fs.unlinkSync(tmp); } catch { /* the temp file may already be gone; the original error is what matters */ }
        throw new Error(`could not replace ${path.basename(file)} (${e && e.code ? e.code : e}) after ${i + 1} attempt(s): ${e && e.message ? e.message : e}`);
      }
      ops.sleepSync(RENAME_NAPS_MS[i]);
    }
  }
}

function openStore(root, { shard, fsOps } = {}) {
  const ops = { renameSync: fs.renameSync, sleepSync: sleepSyncReal, ...(fsOps || {}) };
  const sh = parseShard(shard);
  const suffix = sh ? `-${sh.i}of${sh.n}` : '';
  const corpusDir = path.join(root, '.claude', 'forge-research', 'skills-corpus');
  const work = path.join(corpusDir, 'work');
  const ensure = () => fs.mkdirSync(work, { recursive: true });
  const states = {}; const candKeys = {}; let trees = null; let fetchedMap = null; let fetchedLiteMap = null; let textShas = null;
  const FETCHED_RE = /^fetched(-\d+of\d+)?\.jsonl$/;
  // A retried key has several records across shard files, read in any order: a failed record never replaces an ok or dup_blob one.
  const lite = (r) => (r.status === 'failed' ? { status: r.status, blob: r.blob || null, reason: r.reason } : { status: r.status, blob: r.blob || null });
  const keepBest = (map, key, rec) => { const prev = map.get(key); if (prev && prev.status !== 'failed' && rec.status === 'failed') return; map.set(key, rec); };

  const append = (file, objs) => {
    if (!objs.length) return;
    ensure();
    fs.appendFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  };
  const writeAtomic = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, file, ops);
  };
  const candFile = (src) => path.join(work, `candidates-${src}.jsonl`);

  const store = {
    root, corpusDir, work, forEachLine, keyOf, shard: sh,
    state(name) {
      if (!states[name]) {
        const f = path.join(work, `state-${name}.json`);
        states[name] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
      }
      return states[name];
    },
    saveState(name, obj) { states[name] = obj; writeAtomic(path.join(work, `state-${name}.json`), JSON.stringify(obj)); },
    sources() {
      if (!fs.existsSync(work)) return [];
      return fs.readdirSync(work).map((f) => /^candidates-(.+)\.jsonl$/.exec(f)).filter(Boolean).map((m) => m[1]).sort();
    },
    // Adds candidates for one source, dropping repo+path keys that source already has. Returns how many were new.
    addCandidates(src, items) {
      if (!candKeys[src]) { candKeys[src] = new Set(); forEachLine(candFile(src), (c) => candKeys[src].add(keyOf(c.repo, c.path))); }
      const fresh = [];
      for (const it of items) {
        const k = keyOf(it.repo, it.path);
        if (candKeys[src].has(k)) continue;
        candKeys[src].add(k);
        fresh.push({ ...it, src });
      }
      append(candFile(src), fresh);
      const dropped = items.length - fresh.length;
      if (dropped) {
        const f = path.join(work, `dropped-${src}.json`);
        const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).dropped : 0;
        writeAtomic(f, JSON.stringify({ dropped: prev + dropped }));
      }
      return fresh.length;
    },
    dropped(src) { const f = path.join(work, `dropped-${src}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).dropped : 0; },
    candidates(src) { const out = []; forEachLine(candFile(src), (c) => out.push(c)); return out; },
    eachCandidate(src, fn) { return forEachLine(candFile(src), fn); },
    treeCache() {
      if (!trees) {
        trees = new Map();
        if (fs.existsSync(work)) {
          for (const f of fs.readdirSync(work).filter((x) => /^trees-.+\.jsonl$/.test(x))) {
            forEachLine(path.join(work, f), (t) => trees.set(t.repo.toLowerCase(), t));
          }
        }
      }
      return trees;
    },
    saveTree(src, entry) { store.treeCache().set(entry.repo.toLowerCase(), entry); append(path.join(work, `trees-${src}.jsonl`), [entry]); },
    fetched() {
      if (!fetchedMap) { fetchedMap = new Map(); listWork(work, FETCHED_RE).forEach((f) => forEachLine(path.join(work, f), (r) => keepBest(fetchedMap, r.key, r))); }
      return fetchedMap;
    },
    // Light view for fetch: key -> { status, blob } only (full records stay on disk).
    fetchedLite() {
      if (!fetchedLiteMap) {
        fetchedLiteMap = new Map();
        listWork(work, FETCHED_RE).forEach((f) => forEachLine(path.join(work, f), (r) => keepBest(fetchedLiteMap, r.key, lite(r))));
      }
      return fetchedLiteMap;
    },
    addFetched(recs) {
      if (fetchedMap) recs.forEach((r) => keepBest(fetchedMap, r.key, r));
      if (fetchedLiteMap) recs.forEach((r) => keepBest(fetchedLiteMap, r.key, lite(r)));
      append(path.join(work, `fetched${suffix}.jsonl`), recs);
    },
    addTexts(list) {
      if (!textShas) { textShas = new Set(); listWork(work, /^texts(-\d+of\d+)?\.jsonl$/).forEach((f) => forEachLine(path.join(work, f), (t) => textShas.add(t.sha256))); }
      const fresh = [];
      for (const t of list) { if (!textShas.has(t.sha256)) { textShas.add(t.sha256); fresh.push(t); } }
      append(path.join(work, `texts${suffix}.jsonl`), fresh);
    },
    writeAtomic,
  };
  return store;
}

module.exports = { openStore, keyOf, forEachLine, parseShard };
