// Forge Command Center gateway — data-dir migration tool (WP B1a).
//
// Moves a gateway data dir (conversations, attachments, sessions, discord state, edit logs) to a new
// location, e.g. from a dev checkout's command-center/.data to the installed app's
// %APPDATA%/Forge Systeem. Safe by construction:
//   - dry-run by default: nothing is copied unless --apply is given;
//   - the source is NEVER modified or deleted (copy only);
//   - an existing target file is NEVER overwritten: same hash = "identical", other hash = "conflict";
//   - every copied file is re-hashed (sha256) at the target and must match the source;
//   - symlinks/junctions in the source are not followed (reported as "skipped_link");
//   - a JSON report is written into the target dir in both modes, so the plan can be read first.
//
// CLI: node gateway/src/data-migrate.mjs --from <dir> --to <dir> [--apply]
// Exit codes: 0 = done, nothing left over; 3 = conflicts were left untouched; 1 = a copy or
// verification failed; 2 = invalid arguments.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HASH_CHUNK_BYTES = 1024 * 1024;
const NETWORK_PATH_RE = /^[\\/]{2}/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, CONFLICTS: 3 });

/** sha256 hex of a file, read in bounded chunks (no whole-file buffer). */
export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function isInside(container, target) {
  const rel = path.relative(container, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Validates the two dirs; returns { ok:true, from, to } or { ok:false, error }. */
export function validateDirs(fromRaw, toRaw) {
  for (const [name, v] of [['--from', fromRaw], ['--to', toRaw]]) {
    if (typeof v !== 'string' || v.trim() === '') return { ok: false, error: name + ' is required' };
    if (NETWORK_PATH_RE.test(v.trim())) return { ok: false, error: name + ' must be a local path, not a network or device path' };
    if (CONTROL_CHAR_RE.test(v)) return { ok: false, error: name + ' contains control characters' };
  }
  const from = path.resolve(fromRaw.trim());
  const to = path.resolve(toRaw.trim());
  let st;
  try { st = fs.statSync(from); } catch { return { ok: false, error: '--from does not exist: ' + from }; }
  if (!st.isDirectory()) return { ok: false, error: '--from is not a directory: ' + from };
  if (isInside(from, to) || isInside(to, from)) return { ok: false, error: '--from and --to must not be the same folder or inside each other' };
  return { ok: true, from, to };
}

/** Lists every regular file under `root` (relative paths, sorted); links are reported, not followed. */
function walk(root) {
  const files = [];
  const links = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    for (const e of entries) {
      const rel = relDir ? path.join(relDir, e.name) : e.name;
      if (e.isSymbolicLink()) links.push(rel);
      else if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) files.push(rel);
    }
  }
  return { files: files.sort(), links: links.sort() };
}

/** Builds the plan: one entry per source file with its hash and what would happen to it. */
export function planMigration(from, to) {
  const { files, links } = walk(from);
  const entries = files.map((rel) => {
    const src = path.join(from, rel);
    const sha256 = sha256File(src);
    const size = fs.statSync(src).size;
    const dst = path.join(to, rel);
    let action = 'copy';
    if (fs.existsSync(dst)) {
      let dstHash = null;
      try { dstHash = fs.statSync(dst).isFile() ? sha256File(dst) : null; } catch { dstHash = null; }
      action = dstHash === sha256 ? 'identical' : 'conflict';
    }
    return { path: rel, size, sha256, action };
  });
  for (const rel of links) entries.push({ path: rel, size: null, sha256: null, action: 'skipped_link' });
  return entries;
}

function copyVerified(from, to, entry) {
  const src = path.join(from, entry.path);
  const dst = path.join(to, entry.path);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    const got = sha256File(dst);
    if (got !== entry.sha256) return { ...entry, action: 'verify_failed', target_sha256: got };
    return { ...entry, action: 'copied' };
  } catch (err) {
    return { ...entry, action: 'copy_failed', error: err && err.message ? err.message : String(err) };
  }
}

function tally(entries) {
  const counts = {};
  for (const e of entries) counts[e.action] = (counts[e.action] || 0) + 1;
  return counts;
}

/** Runs a migration (dry-run unless apply) and writes the report into `to`. Never touches `from`. */
export function migrateDataDir({ from: fromRaw, to: toRaw, apply = false, now = new Date() }) {
  const v = validateDirs(fromRaw, toRaw);
  if (!v.ok) return { ok: false, exitCode: EXIT.USAGE, error: v.error };
  const planned = planMigration(v.from, v.to);
  const entries = apply ? planned.map((e) => (e.action === 'copy' ? copyVerified(v.from, v.to, e) : e)) : planned;
  const counts = tally(entries);
  const failed = (counts.copy_failed || 0) + (counts.verify_failed || 0);
  const exitCode = failed > 0 ? EXIT.FAILED : (counts.conflict ? EXIT.CONFLICTS : EXIT.OK);
  const report = {
    schema: 1,
    tool: 'data-migrate',
    mode: apply ? 'apply' : 'dry-run',
    from: v.from,
    to: v.to,
    created_at: now.toISOString(),
    source_deleted: false,
    counts,
    exit_code: exitCode,
    files: entries,
  };
  fs.mkdirSync(v.to, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(v.to, 'forge-data-migration-' + stamp + '-' + report.mode + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { ok: exitCode === EXIT.OK, exitCode, reportPath, report };
}

export function parseArgs(argv) {
  const out = { from: null, to: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--from' || a === '--to') {
      if (i + 1 >= argv.length) return { error: a + ' needs a value' };
      out[a.slice(2)] = argv[i + 1];
      i += 1;
    } else return { error: 'unknown argument: ' + a };
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error('data-migrate: ' + args.error + '\nusage: node gateway/src/data-migrate.mjs --from <dir> --to <dir> [--apply]');
    return EXIT.USAGE;
  }
  let result;
  try {
    result = migrateDataDir(args);
  } catch (err) {
    console.error('data-migrate: failed: ' + (err && err.message ? err.message : String(err)));
    return EXIT.FAILED;
  }
  if (result.error) {
    console.error('data-migrate: ' + result.error);
    return result.exitCode;
  }
  console.log('data-migrate ' + result.report.mode + ': ' + JSON.stringify(result.report.counts) + ' (source untouched)');
  console.log('report: ' + result.reportPath);
  return result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
