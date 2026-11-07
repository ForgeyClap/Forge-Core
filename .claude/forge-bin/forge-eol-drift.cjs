#!/usr/bin/env node
'use strict';
/**
 * forge-eol-drift.cjs — finds tracked files whose line-ending style changed against HEAD (LF <-> CRLF or mixed).
 * Category tests 2026-11-07: editing on Windows silently turned 7 LF files into CRLF, so commits showed thousands of
 * changed lines for a few real ones and every synced project would receive those files as "updated".
 *
 *   node .claude/forge-bin/forge-eol-drift.cjs [--root <repo>] [--json]
 * Exit 0 = no drift (or not a git work tree), 1 = drift listed. Read-only; it never rewrites a file.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** eolStyle(buffer|string) -> 'none' | 'lf' | 'crlf' | 'mixed'. */
function eolStyle(data) {
  const s = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
  const lf = (s.match(/\n/g) || []).length;
  if (!lf) return 'none';
  const crlf = (s.match(/\r\n/g) || []).length;
  return crlf === 0 ? 'lf' : crlf === lf ? 'crlf' : 'mixed';
}

function git(root, args, asBuffer) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks'].concat(args), { cwd: root, encoding: asBuffer ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

/** eolDrift(root) -> { applicable, drift: [{file, before, after}] }. Only modified tracked files are judged. */
function eolDrift(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top === null) return { applicable: false, drift: [], reason: 'not a git work tree' };
  const names = git(root, ['diff', '--name-only', 'HEAD']);
  if (names === null) return { applicable: false, drift: [], reason: 'no HEAD to compare with' };
  const drift = [];
  for (const rel of names.split('\n').map((x) => x.trim()).filter(Boolean)) {
    const abs = path.join(top.trim(), rel);
    let now; try { now = fs.readFileSync(abs); } catch { continue; } // deleted: not an EOL question
    const before = git(root, ['cat-file', '-p', 'HEAD:' + rel], true);
    if (before === null) continue;
    const a = eolStyle(before), b = eolStyle(now);
    if (a !== b && a !== 'none' && b !== 'none') drift.push({ file: rel, before: a, after: b });
  }
  return { applicable: true, drift };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  const root = i >= 0 ? argv[i + 1] : process.cwd();
  const r = eolDrift(root);
  if (argv.includes('--json')) console.log(JSON.stringify(r));
  else if (!r.applicable) console.log('forge-eol-drift: n/a (' + r.reason + ')');
  else if (!r.drift.length) console.log('forge-eol-drift: OK - no modified file changed its line endings');
  else console.log('forge-eol-drift: ' + r.drift.length + ' file(s) changed line endings:\n' + r.drift.map((d) => '  ' + d.before + ' -> ' + d.after + '  ' + d.file).join('\n'));
  process.exit(r.applicable && r.drift.length ? 1 : 0);
}

module.exports = { eolStyle, eolDrift };
