#!/usr/bin/env node
'use strict';
// forge-skill-analyze.cjs — analyse EVERY record of the harvested skill corpus. Zero dependencies.
// Reads corpus.jsonl (streamed) and the SKILL.md texts by sha256 from work/texts*.jsonl (streamed, read-only), and writes
// ONLY into the analysis folder: features.jsonl, dup-groups.json, categories.json, clusters/<category>.json, ours.json,
// coverage.json. Downloaded text is data: it is tokenised and hashed, never executed.
// Modules: -taxonomy (categories), -features (risk/quality/MinHash), -dedupe, -cluster, -ours, -report.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forEachLine } = require('./forge-skill-harvest-store.cjs');
const { parseFrontmatter } = require('./forge-skill-harvest-parse.cjs');
const T = require('./forge-skill-analyze-taxonomy.cjs');
const F = require('./forge-skill-analyze-features.cjs');
const D = require('./forge-skill-analyze-dedupe.cjs');
const Rp = require('./forge-skill-analyze-report.cjs');
const { scanOurs } = require('./forge-skill-analyze-ours.cjs');

const USAGE = `forge-skill-analyze — categorise, score, dedupe and cluster every harvested SKILL.md (read-only on the corpus)

Usage: node .claude/forge-bin/forge-skill-analyze.cjs [options]

Options:
  --corpus <file>           corpus.jsonl (default <root>/.claude/forge-research/skills-corpus/corpus.jsonl)
  --texts-dir <dir>         folder with texts*.jsonl (default <corpus dir>/work)
  --out <dir>               output folder (default <corpus dir>/analysis); never the corpus folder or the texts folder
  --corpus-coverage <file>  the harvester's coverage.json to cross-check the record count (default <corpus dir>/coverage.json)
  --root <dir>              project root (default: this repo); our project skills are read from <root>/.claude/skills
  --home <dir>              home folder for ~/.claude/skills and installed plugins (default: the user's home)
  --audit <file>            skills audit raw json (default <root>/.claude/forge-research/skills-audit-2026-11-04/audit-raw.json)
  --now <iso date>          reference date for the "recent commit" score (default: now)
  --help                    show this help`;

const OPTS = new Set(['--corpus', '--texts-dir', '--out', '--corpus-coverage', '--root', '--home', '--audit', '--now']);
function parseArgs(argv) {
  const o = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (!OPTS.has(a)) throw new Error(`unknown option: ${a}`);
    const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`);
    o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  if (o.now !== undefined && !Number.isFinite(Date.parse(o.now))) throw new Error('--now must be a date');
  return o;
}

const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
function guardOut(out, corpus, textsDir) {
  if (inside(corpus, out)) throw new Error(`refusing to write to ${out}: the corpus file lies inside it (use a separate analysis folder)`);
  if (inside(out, textsDir)) throw new Error(`refusing to write to ${out}: it is (inside) the texts folder ${textsDir}`);
  if (inside(out, path.join(path.dirname(corpus), 'work'))) throw new Error(`refusing to write to ${out}: it is inside the harvester work folder`);
}

const TEXT_FILE_RE = /^texts(-\d+of\d+)?\.jsonl$/;
const keepRec = (r, i) => ({ index: i, id: String(r.id), name: typeof r.name === 'string' ? r.name : null, description: typeof r.description === 'string' ? r.description : null,
  repo: r.repo || null, path: r.path || null, stars: Number(r.stars) || 0, license: r.license || null, last_commit: r.last_commit || null, pushed_at: r.pushed_at || null,
  bytes: Number(r.bytes) || 0, copies: Number(r.copies) || 1, sources: Array.isArray(r.sources) ? r.sources : [], sha256: String(r.sha256),
  shipRisk: F.riskFlags(r.ships, ''), shipsSeen: !!r.ships, frontmatterKeys: r.frontmatter && typeof r.frontmatter === 'object' ? Object.keys(r.frontmatter).length : 0 });

// Pass 1 — corpus records (metadata only, ships reduced to risk flags so memory stays small at 170k+).
function readCorpus(corpus) {
  const recs = []; const skipped = {}; const samples = []; const ids = new Set(); let read = 0;
  const skip = (why, n) => { skipped[why] = (skipped[why] || 0) + 1; if (samples.length < 20) samples.push({ record_no: n, reason: why }); };
  const bad = forEachLine(corpus, (r) => {
    read++;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return skip('not_object', read);
    if (r.id == null || !r.sha256) return skip('no_id_or_sha256', read);
    if (ids.has(String(r.id))) return skip('duplicate_id', read);
    ids.add(String(r.id)); recs.push(keepRec(r, recs.length));
  });
  if (bad) { skipped.bad_json = bad; read += bad; }
  return { recs, skipped, samples, read };
}

// Pass 2 — text features for the needed sha256 values; the text itself is not kept.
function readTexts(textsDir, recs) {
  const need = new Map(recs.map((r) => [r.sha256, r]));
  const files = fs.existsSync(textsDir) ? fs.readdirSync(textsDir).filter((f) => TEXT_FILE_RE.test(f)).sort() : [];
  let lines = 0; let bad = 0;
  for (const f of files) {
    bad += forEachLine(path.join(textsDir, f), (t) => {
      lines++;
      const r = t && need.get(t.sha256); if (!r || r.text || typeof t.text !== 'string') return;
      const text = t.text; const body = F.bodyOf(text);
      const fm = r.name || r.description ? null : parseFrontmatter(text);
      r.text = { headings: T.extractHeadings(text), sig: F.minhash(`${r.description || (fm && fm.description) || ''}\n${body}`),
        trigger: F.TRIGGER_RE.test(body.slice(0, 20000)), pointer: F.isPointer(text), install: F.riskFlags(null, text).flags.install };
    });
  }
  return { files, lines, bad };
}

function features(r, nowMs) {
  const info = r.text || null;
  const headings = info ? info.headings : [];
  const risk = { flags: { ...r.shipRisk.flags, install: r.shipRisk.flags.install || !!(info && info.install) }, ships_known: r.shipsSeen };
  risk.risky = Object.values(risk.flags).some(Boolean);
  r.categories = T.categorize({ name: r.name, description: r.description, headings });
  r.quality = F.quality(r, info, nowMs); r.risk = risk; r.sig = info ? info.sig : null;
  r.termList = T.terms(`${r.name || ''} ${r.description || ''} ${headings.join(' ')}`).slice(0, 400);
  return { id: r.id, name: r.name, repo: r.repo, path: r.path, sha256: r.sha256, stars: r.stars, license: r.license, last_commit: r.last_commit,
    copies: r.copies, sources: r.sources, categories: r.categories, risk, quality: r.quality, text: info ? (info.pointer ? 'pointer' : 'ok') : 'missing',
    headings: headings.length, fingerprint: F.fingerprint(r.sig) };
}

function writeFeatures(file, recs, nowMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; const fd = fs.openSync(tmp, 'w');
  try {
    let buf = [];
    for (const r of recs) { buf.push(JSON.stringify(features(r, nowMs))); if (buf.length >= 2000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; } }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function harvesterCount(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.totals && Number.isInteger(j.totals.corpus_records) ? j.totals.corpus_records : null; } catch (e) {
    return { error: `unreadable harvester coverage: ${e.message}` };
  }
}

async function analyze(opts) {
  const t0 = Date.now(); let peak = process.memoryUsage().rss; const mark = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  const root = path.resolve(opts.projectRoot || path.join(__dirname, '..', '..'));
  const corpus = path.resolve(opts.corpus || path.join(root, '.claude', 'forge-research', 'skills-corpus', 'corpus.jsonl'));
  const corpusDir = path.dirname(corpus);
  const textsDir = path.resolve(opts.textsDir || path.join(corpusDir, 'work'));
  const out = path.resolve(opts.out || path.join(corpusDir, 'analysis'));
  guardOut(out, corpus, textsDir);
  if (!fs.existsSync(corpus)) throw new Error(`corpus not found: ${corpus}`);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const home = path.resolve(opts.home || os.homedir());

  const c = readCorpus(corpus); mark();
  c.recs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); c.recs.forEach((r, i) => { r.index = i; });
  const tx = readTexts(textsDir, c.recs); mark();
  writeFeatures(path.join(out, 'features.jsonl'), c.recs, nowMs); mark();
  for (const r of c.recs) r.text = r.text ? { pointer: r.text.pointer } : null;

  const dd = D.findGroups(c.recs.map((r) => ({ id: r.id, nameKey: D.normName(r.name), descTokens: r.description ? new Set(T.terms(r.description)) : undefined, sig: r.sig, quality: r.quality.score, stars: r.stars })));
  mark();
  Rp.writeJson(path.join(out, 'dup-groups.json'), Rp.dupGroups(c.recs, dd, { similarity_threshold: D.SIM, same_name_threshold: D.NAME_SIM, family_description_threshold: D.DESC_SIM,
    lsh: `${D.BANDS} bands x ${D.ROWS} rows over 64 MinHash values of word 3-shingles (description + body)`,
    note: 'byte-identical copies were already merged by the harvester (copies/also_at); groups here are NEAR copies' }));
  const { cats, uniqueMembers } = Rp.categoryCounts(c.recs, dd.canon);
  const uniqueTotal = c.recs.reduce((s, r, i) => s + (dd.canon[i] === i ? 1 : 0), 0);
  Rp.writeJson(path.join(out, 'categories.json'), { totals: { records: c.recs.length, unique: uniqueTotal, risky: c.recs.filter((r) => r.risk.risky).length },
    taxonomy: T.TAXONOMY.map((x) => ({ id: x.id, about: x.about, keywords: x.keywords })),
    rules: 'multi-label: a keyword in name/description counts 2, each heading keyword 1; score >= 2 assigns the category; none -> other. Bands: high >= 70, medium 40-69, low < 40.',
    categories: cats });
  const clusterCounts = Rp.writeClusters(out, c.recs, dd.canon, uniqueMembers); mark();
  const ours = scanOurs({ projectRoot: root, home, auditFile: opts.auditFile || path.join(root, '.claude', 'forge-research', 'skills-audit-2026-11-04', 'audit-raw.json') });
  Rp.writeJson(path.join(out, 'ours.json'), Rp.oursReport(ours, cats)); mark();

  const skippedTotal = Object.values(c.skipped).reduce((a, b) => a + b, 0);
  const found = c.recs.filter((r) => r.text).length; const pointer = c.recs.filter((r) => r.text && r.text.pointer).length;
  const expected = harvesterCount(opts.corpusCoverage || path.join(corpusDir, 'coverage.json'));
  const cov = { generated_at: new Date().toISOString(), reference_date: new Date(nowMs).toISOString(), corpus, texts_dir: textsDir, out, text_files: tx.files,
    records_read: c.read, analysed: c.recs.length, skipped_total: skippedTotal, skipped: c.skipped, skipped_samples: c.samples,
    complete: c.read === c.recs.length + skippedTotal,
    harvester_corpus_records: expected, matches_harvester_count: typeof expected === 'number' ? expected === c.read : null,
    text: { found, missing: c.recs.length - found, pointer_only: pointer, text_lines_read: tx.lines, text_bad_lines: tx.bad },
    dedupe: { groups: dd.groups.length, template_families: dd.families.length, unique: uniqueTotal, near_copies_removed: c.recs.length - uniqueTotal },
    clusters_per_category: clusterCounts, ours: ours.skills.length, duration_ms: Date.now() - t0, peak_rss_mb: Math.round(peak / 1048576) };
  Rp.writeJson(path.join(out, 'coverage.json'), cov);
  return cov;
}

async function main(argv, io = {}) {
  const log = io.log || ((s) => process.stdout.write(s + '\n')); const err = io.err || ((s) => process.stderr.write(s + '\n'));
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  const cov = await analyze({ corpus: o.corpus, textsDir: o.textsDir, out: o.out, corpusCoverage: o.corpusCoverage, projectRoot: o.root, home: o.home,
    auditFile: o.audit, now: o.now ? Date.parse(o.now) : undefined });
  log(`analyse: read=${cov.records_read} analysed=${cov.analysed} skipped=${cov.skipped_total} complete=${cov.complete} harvester_count=${cov.harvester_corpus_records}`);
  log(`analyse: text found=${cov.text.found} missing=${cov.text.missing} pointer=${cov.text.pointer_only}; unique=${cov.dedupe.unique} dup_groups=${cov.dedupe.groups}; ours=${cov.ours}`);
  log(`analyse: ${cov.duration_ms} ms, peak rss ${cov.peak_rss_mb} MB -> ${cov.out}`);
  return cov.complete ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`forge-skill-analyze: ${e && e.stack ? e.stack : e}\n`); process.exitCode = 1; });
}

module.exports = { analyze, main, parseArgs, USAGE };
