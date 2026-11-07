// check-dist-clean (WP B5 part BUILD): proves a distributed dashboard build carries no
// development-only account-rotation code. Walks every file under the target folder (default:
// dashboard/dist) and looks for the never-ship text of scripts/dist-strip.mjs in each relative file
// name and in the file bytes (UTF-8). Prints {file, needle, where} only, never the bytes around a hit.
// Exit codes: 0 clean, 3 findings, 2 usage error or unreadable input (fail closed).
//
// CLI: node scripts/check-dist-clean.mjs [--json] [<dist folder>]   (default: $FORGE_DIST_OUT_DIR, else dist)
/* global process, console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbidden } from './dist-strip.mjs';

const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT = Object.freeze({ CLEAN: 0, USAGE: 2, FINDINGS: 3 });
const USAGE = 'usage: node scripts/check-dist-clean.mjs [--json] [<dist folder>]  (default: $FORGE_DIST_OUT_DIR, else dist)';

function listFiles(root, rel, out) {
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) listFiles(root, r, out);
    else out.push(r);
  }
}

/** Scans a folder. Returns {target, scanned_files, findings, errors, exit_code}. */
export function checkDistClean(target) {
  const files = [];
  const findings = [];
  const errors = [];
  listFiles(target, '', files);
  for (const rel of files) {
    for (const n of findForbidden(rel)) findings.push({ file: rel, needle: n, where: 'name' });
    try {
      for (const n of findForbidden(fs.readFileSync(path.join(target, rel)).toString('utf8'))) findings.push({ file: rel, needle: n, where: 'content' });
    } catch (err) {
      errors.push({ file: rel, error: err && err.message ? err.message : String(err) });
    }
  }
  const exit_code = errors.length ? EXIT.USAGE : findings.length ? EXIT.FINDINGS : EXIT.CLEAN;
  return { target, scanned_files: files.length, findings, errors, exit_code };
}

/** CLI entry; returns the exit code so tests can call it. */
export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let json = false;
  const positional = [];
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') { io.out(USAGE); return EXIT.CLEAN; }
    else if (a.startsWith('-')) { io.err('check-dist-clean: unknown option ' + a + '\n' + USAGE); return EXIT.USAGE; }
    else positional.push(a);
  }
  if (positional.length > 1) { io.err('check-dist-clean: one folder only\n' + USAGE); return EXIT.USAGE; }
  const target = path.resolve(positional[0] || process.env.FORGE_DIST_OUT_DIR || path.join(DASHBOARD_DIR, 'dist'));
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    io.err('check-dist-clean: folder not found: ' + target + ' (build first: npm run build:dist)');
    return EXIT.USAGE;
  }
  const r = checkDistClean(target);
  if (r.scanned_files === 0) { io.err('check-dist-clean: ' + target + ' is empty (build first: npm run build:dist)'); return EXIT.USAGE; }
  if (json) io.out(JSON.stringify(r, null, 2));
  else {
    for (const f of r.findings) io.err('check-dist-clean: FINDING ' + f.where + ' ' + f.file + ' contains ' + f.needle);
    for (const e of r.errors) io.err('check-dist-clean: ERROR ' + e.file + ': ' + e.error);
    (r.exit_code ? io.err : io.out)('check-dist-clean: ' + r.findings.length + ' finding(s), ' + r.errors.length + ' unreadable, ' + r.scanned_files + ' files scanned in ' + target + ', exit ' + r.exit_code);
  }
  return r.exit_code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
