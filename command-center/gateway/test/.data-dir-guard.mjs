// WP-NONET: test helper (dot-prefixed so `node --test` never runs it as a test file,
// same convention as ./.real-data-guard.mjs).
//
// Several gateway tests deliberately nest their fixtures under COMMAND_CENTER_DATA_DIR
// (command-center/.data/gateway-test-tmp-*) because the code under test confines paths to
// PROJECT_ROOT, so a plain os.tmpdir() fixture would be rejected. Each file already removes its own
// FIXTURE_PARENT, but on a fresh/public checkout `.data` itself did not exist before the run and
// was left behind as an empty folder.
//
// `node --test` runs test files as CONCURRENT processes, so "did .data exist when THIS process
// started" is not enough (the last file to finish usually started after another file created it).
// The first test process that finds `.data` absent therefore creates it together with a sentinel
// file; every test process that started while `.data` was absent or carried the sentinel knows it
// is a test-created folder and, at the end of its after(), removes it when nothing but the
// sentinel is left. A real `.data` (no sentinel, e.g. the live gateway's own data) is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const SENTINEL_NAME = '.created-by-gateway-tests';
const SENTINEL = path.join(COMMAND_CENTER_DATA_DIR, SENTINEL_NAME);

function writeSentinel() {
  try {
    fs.mkdirSync(COMMAND_CENTER_DATA_DIR, { recursive: true });
    fs.writeFileSync(SENTINEL, 'created by command-center/gateway tests; removed when they finish\n', 'utf8');
  } catch {
    // best-effort: without the sentinel the folder is merely left behind, never wrongly removed
  }
}

const dataDirIsTestCreated = !fs.existsSync(COMMAND_CENTER_DATA_DIR) || fs.existsSync(SENTINEL);
if (dataDirIsTestCreated) writeSentinel();

/** Call at the END of a test file's top-level after(), after its own fixtures are removed. */
export function removeDataDirIfCreatedByTests() {
  if (!dataDirIsTestCreated) return;
  let entries;
  try {
    entries = fs.readdirSync(COMMAND_CENTER_DATA_DIR);
  } catch {
    return; // already gone
  }
  if (entries.some((name) => name !== SENTINEL_NAME)) return; // another test file is still using it
  try {
    fs.rmSync(SENTINEL, { force: true });
    fs.rmdirSync(COMMAND_CENTER_DATA_DIR); // non-recursive: only succeeds when empty
  } catch {
    // ENOTEMPTY: a concurrent test file just created its fixture — put the sentinel back so the
    // last one to finish removes the folder.
    if (fs.existsSync(COMMAND_CENTER_DATA_DIR)) writeSentinel();
  }
}
