#!/usr/bin/env node
'use strict';
// forge-skill-harvest.cjs — harvest EVERY public SKILL.md, not a sample (owner HARD rule "research means ALL of it",
// 2026-11-04). Zero dependencies. Uses the logged-in gh CLI for read-only API calls and plain HTTPS GETs.
// Downloaded files are DATA: they are stored as text and grepped, never executed.
// Modules: -parse (pure parsers), -net (gh/HTTPS + rate limits), -store (state files), -enum, -fetch, -index.
const path = require('path');
const { openStore } = require('./forge-skill-harvest-store.cjs');
const { realCtx, redact } = require('./forge-skill-harvest-net.cjs');

const USAGE = `forge-skill-harvest — build a corpus of every public SKILL.md (read-only, resumable)

Usage: node .claude/forge-bin/forge-skill-harvest.cjs <command> [options]

Commands:
  enumerate   collect SKILL.md locations (--source codesearch|topics|lists|skillssh|all, default all)
  fetch       download each SKILL.md (data only) + record what its folder ships
  index       write corpus.jsonl + coverage.json under .claude/forge-research/skills-corpus/
  status      print coverage so far (writes nothing)

Options:
  --source <name>        enumerate one source (run sources as separate processes to use separate rate buckets)
  --max-partitions <n>   codesearch/topics: stop after n result partitions this run
  --limit <n>            topics/lists/skillssh: max new repo trees this run; fetch: max skills this run
  --max-requests <n>     hard cap on API requests this run
  --batch <n>            fetch: skills per GraphQL query (default 20)
  --workers <n>          topics/lists/skillssh: parallel tree workers sharing one rate-limit bucket (1-8, default 4)
  --shard <i/n>          fetch: handle only shard i of n (run n fetch processes in parallel)
  --retry-failed         fetch: fetch again the keys that failed on a transient error (server error, timeout)
  --root <dir>           project root (default: this repo)
  --help                 show this help

Re-running any command continues where it stopped. Rate limits: paced per bucket, waits for the reset on 403/429,
bounded retries; parallel workers share one token bucket per limit (core 5000/h, GraphQL 5000/h, search 30/min,
code search 10/min) and never rotate accounts or tokens. Nothing downloaded is executed.`;

const NUM = new Set(['--max-partitions', '--limit', '--max-requests', '--batch', '--workers']);
const STR = new Set(['--source', '--root', '--shard']);
const CMDS = new Set(['enumerate', 'fetch', 'index', 'status']);

function parseArgs(argv) {
  const o = { cmd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--retry-failed') { o.retryFailed = true; continue; }
    if (NUM.has(a) || STR.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (NUM.has(a)) { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`${a} must be a whole number`); o[k] = n; } else o[k] = v;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    if (!o.cmd && CMDS.has(a)) { o.cmd = a; continue; }
    throw new Error(`unknown command: ${a}`);
  }
  if (o.workers !== undefined && (o.workers < 1 || o.workers > 8)) throw new Error('--workers must be between 1 and 8');
  return o;
}

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n\n${USAGE}\n`); return 2; }
  if (o.help || !o.cmd) { process.stdout.write(USAGE + '\n'); return o.help ? 0 : 2; }
  const root = path.resolve(o.root || path.join(__dirname, '..', '..'));
  let store;
  try { store = openStore(root, { shard: o.shard }); } catch (e) { process.stderr.write(`${e.message}
`); return 2; }
  const ctx = realCtx({ maxRequests: o.maxRequests || 0 });
  const t0 = Date.now();
  if (o.cmd === 'status') {
    require('./forge-skill-harvest-index.cjs').statusLines(store).forEach((l) => ctx.log(l));
    return 0;
  }
  if (o.cmd === 'enumerate') {
    await require('./forge-skill-harvest-enum.cjs').enumerate(ctx, store, { source: o.source || 'all', maxPartitions: o.maxPartitions, limit: o.limit, workers: o.workers });
  } else if (o.cmd === 'fetch') {
    const r = await require('./forge-skill-harvest-fetch.cjs').fetchAll(ctx, store, { limit: o.limit, batch: o.batch, shard: o.shard, retryFailed: o.retryFailed });
    ctx.log(`fetch: done this run ok=${r.ok} failed=${r.failed} remaining=${r.remaining}`);
  } else if (o.cmd === 'index') {
    const r = require('./forge-skill-harvest-index.cjs').buildIndex(store);
    ctx.log(`index: corpus records=${r.corpus} -> ${path.join(store.corpusDir, 'corpus.jsonl')}`);
  }
  ctx.log(`${o.cmd}: finished in ${Math.round((Date.now() - t0) / 1000)}s, api requests=${ctx.requests || 0}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(redact(`forge-skill-harvest: ${e && e.stack ? e.stack : e}`) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main, USAGE };
