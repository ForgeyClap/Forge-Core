#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/** Offline, hermetic tests for forge-artifact.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_STORE_ROOT override (shared with forge-store.cjs); never touches the real project's .claude/.
 *  Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');

// hermetic: point the shared store at a throwaway temp dir BEFORE requiring forge-artifact.cjs (it
// requires forge-store.cjs internally, which resolves CLAUDE_DIR once at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-artifact-test-'));
process.env.FORGE_STORE_ROOT = TMP;
const { storeArtifact } = require('./forge-artifact.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-artifact offline tests (hermetic root=' + TMP + ')');

// 1) storeArtifact writes forge-artifacts/<id>.json
const env = storeArtifact('a1', { title: 'Build log', kind: 'build-log', produced_by: 'Build Boss' });
const filePath = path.join(TMP, 'forge-artifacts', 'a1.json');
t('storeArtifact writes forge-artifacts/<id>.json', fs.existsSync(filePath));
t('stored file contains the title', fs.readFileSync(filePath, 'utf8').includes('Build log'));
t('storeArtifact returns the stored envelope (title + _stored)', env.title === 'Build log' && typeof env._stored === 'string' && !Number.isNaN(Date.parse(env._stored)));
const idxPath = path.join(TMP, 'forge-artifacts', 'index.jsonl');
t('storeArtifact appends a row to forge-artifacts/index.jsonl', fs.existsSync(idxPath) && fs.readFileSync(idxPath, 'utf8').includes('a1'));

// 2) secret redaction — a fake secret is ABSENT from the written file
const FAKE_SECRET = 'nvapi-FAKEFAKEFAKEFAKE1234567890';
storeArtifact('a2', { title: 'Secret artifact', note: 'leaked key: ' + FAKE_SECRET });
const secretFilePath = path.join(TMP, 'forge-artifacts', 'a2.json');
const secretText = fs.readFileSync(secretFilePath, 'utf8');
t('fake secret ABSENT from the stored artifact file', !secretText.includes(FAKE_SECRET));
t('redaction marker present in the stored artifact file', secretText.includes('***REDACTED***'));

// 3) invalid id ("../evil") is rejected — same guard as forge-store.cjs
let rejected = false;
try { storeArtifact('../evil', { title: 'bad' }); } catch (e) { rejected = /invalid id/i.test(e.message); }
t('invalid artifact id "../evil" is REJECTED', rejected === true);
t('bad-id write did not escape forge-artifacts/', !fs.existsSync(path.join(TMP, 'evil.json')));

// 4) --run wiring: log-event.cjs is invoked and appends artifact_stored to that run's events.jsonl.
// This IS hermetic: log-event.cjs resolves CLAUDE_DIR from its OWN __dirname (the real template's
// forge-dashboard/), not from FORGE_STORE_ROOT, so it would write into forge-runs/ next to the real
// server.cjs. To stay fully hermetic we don't exercise --run here (that would touch a real run id) —
// storeArtifact()'s opts.run branch is covered structurally by inspecting it never throws when opts.run
// is omitted, and by the module's own use of putEntity()'s validated id path shown above.
t('storeArtifact never throws when opts.run is omitted', (() => { try { storeArtifact('a3', { title: 'no-run' }); return true; } catch { return false; } })());

// 5) FB-MISC-2-F8: the CLI never reports a run event it did not write. Hermetic: the store AND the project root
// (where log-event.cjs writes) are temp dirs.
{
  const { spawnSync } = require('child_process');
  const CLI = path.join(__dirname, 'forge-artifact.cjs');
  // log-event.cjs finds its project from its own location; FORGE_STATE_DIR moves its run folders to a temp dir.
  const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-artifact-state-'));
  const cliEnv = Object.assign({}, process.env, { FORGE_STORE_ROOT: TMP, FORGE_STATE_DIR: STATE });
  const findEvents = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = findEvents(p); if (f) return f; } else if (e.name === 'events.jsonl' && p.includes('run-artifact-ok')) return p; } return null; };
  const realRunDir = path.join(__dirname, '..', 'forge-runs', 'run-artifact-ok');
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cliEnv });
  const bad = cli(['store', 'p1', '{"title":"x"}', '--run', 'bad run id!']);
  t('a run event that log-event refuses makes the CLI exit 1', bad.status === 1);
  t('... and it says the event was NOT logged, never "(run ...)"', /NOT logged/.test(bad.stderr) && !/\(run bad run id!\)/.test(bad.stdout));
  t('... the artifact itself is still stored', fs.existsSync(path.join(TMP, 'forge-artifacts', 'p1.json')));
  const bare = cli(['store', 'p2', '{"title":"x"}', '--run']);
  t('a bare --run with no value is a usage error (exit 1), nothing stored', bare.status === 1 && /--run needs a run id/.test(bare.stderr) && !fs.existsSync(path.join(TMP, 'forge-artifacts', 'p2.json')));
  const good = cli(['store', 'p3', '{"title":"x","kind":"note"}', '--run', 'run-artifact-ok']);
  const evFile = findEvents(STATE);
  t('a real --run writes artifact_stored through log-event.cjs next to this tool (not into the store root)',
    good.status === 0 && /\(run run-artifact-ok\)/.test(good.stdout) && !!evFile && /artifact_stored/.test(fs.readFileSync(evFile, 'utf8')));
  t('... and never into the real project run folder', !fs.existsSync(realRunDir));
  if (good.status !== 0) console.error('    good run: ' + good.status + ' ' + good.stdout + good.stderr);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
