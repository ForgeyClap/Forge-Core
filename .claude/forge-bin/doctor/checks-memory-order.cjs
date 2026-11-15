'use strict';
/**
 * doctor/checks-memory-order.cjs — SD-MEM: FORGE_MEMORY.md is newest-first (its own header says so, and
 * forge-snapshot and every resuming session read the top as the latest status). Until 3a6ee48 the newest `## Status`
 * blocks sat at the BOTTOM, because `forge-run-file.cjs append` wrote them there. This check is red when a status block
 * sits below an OLDER one, naming both headings and their line numbers.
 *
 * memoryOrderCheck(root) -> {ok, problems: string[], path|null}. Read-only. A missing memory file is not a problem
 * (a fresh install has none until the first scan). Registered in forge-doctor.cjs by the integrator.
 */
const fs = require('fs');
const path = require('path');
const { statusBlocks, compareStatusKeys } = require('../forge-run-file.cjs');

const forgePaths = (() => { try { const m = require('../forge-paths.cjs'); return m && typeof m.memoryFile === 'function' ? m : null; } catch { return null; } })();

function memoryPathFor(root) {
  if (forgePaths) { try { return forgePaths.memoryFile(root, 'FORGE_MEMORY.md', { read: true }); } catch { /* legacy below */ } }
  return path.join(root, '.claude', 'FORGE_MEMORY.md');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function memoryOrderCheck(root) {
  const p = memoryPathFor(path.resolve(String(root || '.')));
  let text;
  try { text = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: true, problems: [], path: null };
    return { ok: false, problems: ['cannot read FORGE_MEMORY.md (' + e.code + ')'], path: p };
  }
  const blocks = statusBlocks(text);
  const problems = [];
  blocks.forEach((b, i) => {
    const older = blocks.slice(0, i).find((above) => compareStatusKeys(above.key, b.key) < 0);
    if (!older) return;
    problems.push('"' + b.heading + '" (line ' + lineOf(text, b.start) + ') sits below the older "' + older.heading
      + '" (line ' + lineOf(text, older.start) + '); FORGE_MEMORY.md is newest-first: move the newer block up, word for word');
  });
  return { ok: problems.length === 0, problems, path: p };
}

module.exports = { memoryOrderCheck };
