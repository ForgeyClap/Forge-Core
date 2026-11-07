#!/usr/bin/env node
'use strict';
/** W2-FRESHCLONE: featureRegistryCheck on a fresh clone of the outer repo. command-center/ is a
 *  separate, gitignored git repo, so a bare outer checkout has no Command Center sources to scan. A `wired` entry
 *  whose wired chain runs only THROUGH a Command-Center-called tool (forge-sync -> forge-shipcheck -> ...) cannot be
 *  judged there: it must be listed as unverifiable with a visible note, not red. With command-center/ present the
 *  check is unchanged, and a wired entry that truly lost its caller stays red in both shapes.
 *  Hermetic: every fixture is a temp root removed at exit; the real tree is only READ. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const D = require('./forge-doctor.cjs');
const RGEN = require('./forge-registry-gen.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fr-freshclone-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* tolerated */ } });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' :: ' + e.message); } };
function wf(root, rel, text) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

/** A dev tree where gw-entry.cjs is spawned by the Command Center gateway, and it in turn requires mid.cjs, which
 *  requires leaf.cjs. flow.cjs is wired through commands/forge.md (no Command Center link). */
function fixture(name, withGateway) {
  const root = path.join(TMP, name);
  wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  wf(root, '.claude/commands/forge.md', 'Run `node .claude/forge-bin/flow.cjs` at step 1.\n');
  wf(root, '.claude/forge-bin/flow.cjs', "'use strict';\n");
  wf(root, '.claude/forge-bin/gw-entry.cjs', "'use strict';\nrequire('./mid.cjs');\n");
  wf(root, '.claude/forge-bin/mid.cjs', "'use strict';\nrequire('./leaf.cjs');\n");
  wf(root, '.claude/forge-bin/leaf.cjs', "'use strict';\n");
  wf(root, 'command-center/gateway/src/paths.mjs', "import { spawn } from 'node:child_process';\nspawn(process.execPath, ['.claude/forge-bin/gw-entry.cjs']);\n");
  const data = RGEN.genFeatureRegistry(root, null).data;
  wf(root, '.claude/config/orchestration/FORGE_FEATURE_REGISTRY.json', JSON.stringify(data, null, 2));
  if (!withGateway) fs.rmSync(path.join(root, 'command-center'), { recursive: true, force: true });
  return { root, data };
}
const status = (data, id) => (data.features.find((f) => f.id === id) || {}).status;

console.log('forge-feature-registry-freshclone tests (hermetic tmp=' + TMP + ')');

t('fixture sanity: with command-center/ present the generator marks the whole gateway chain wired', () => {
  const { root, data } = fixture('present', true);
  assert.deepStrictEqual(['gw-entry.cjs', 'mid.cjs', 'leaf.cjs', 'flow.cjs'].map((id) => status(data, id)), ['wired', 'wired', 'wired', 'wired']);
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === true && fr.gateway_scanned === true && fr.unverifiable.length === 0, JSON.stringify(fr));
});

t('fresh clone (command-center/ absent): tools wired only THROUGH a Command-Center-called tool are unverifiable, not red', () => {
  const { root } = fixture('absent', false);
  const fr = D.featureRegistryCheck(root);
  assert.strictEqual(fr.gateway_scanned, false);
  assert.strictEqual(fr.ok, true, fr.reason);
  assert.deepStrictEqual(fr.unverifiable.slice().sort(), ['tool:gw-entry.cjs', 'tool:leaf.cjs', 'tool:mid.cjs']);
  assert.deepStrictEqual(fr.wired_without_caller, []);
});

t('fresh clone: the doctor summary line shows the skip visibly (a ✓ that names the absent command-center/ and the count)', () => {
  const { root } = fixture('absent-print', false);
  const fr = D.featureRegistryCheck(root);
  assert.ok(Array.isArray(fr.unverifiable) && fr.unverifiable.length === 3 && fr.applicable === true, JSON.stringify(fr));
  // the summary renderer (doctor/report.cjs) prints this count on the ✓ line; printSummary needs a whole report,
  // so the line it prints is asserted on its source here and on a real bare checkout in the W2-FRESHCLONE evidence.
  const src = fs.readFileSync(path.join(__dirname, 'doctor', 'report.cjs'), 'utf8');
  assert.ok(/fr\.unverifiable\.length \+ ' unverifiable here \(command-center\/ absent\)'/.test(src), 'report.cjs no longer prints the unverifiable count');
});

t('present and wrong stays red: with command-center/ present, a gateway-chain tool that lost its caller is red', () => {
  const { root } = fixture('present-wrong', true);
  wf(root, '.claude/forge-bin/mid.cjs', "'use strict';\n");
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === false && fr.wired_without_caller.some((w) => w.id === 'tool:leaf.cjs'), JSON.stringify(fr.wired_without_caller));
});

t('absent and wrong stays red: a wired tool with no Command Center link that lost its caller is red on a fresh clone too', () => {
  const { root } = fixture('absent-wrong', false);
  wf(root, '.claude/commands/forge.md', 'nothing runs a tool any more\n');
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === false && fr.wired_without_caller.some((w) => w.id === 'tool:flow.cjs'), JSON.stringify(fr.wired_without_caller));
  assert.ok(!fr.unverifiable.includes('tool:flow.cjs'), JSON.stringify(fr.unverifiable));
});

t('absent: a gateway-chain tool whose link to the chain was cut is red, not hidden as unverifiable', () => {
  const { root } = fixture('absent-cut', false);
  wf(root, '.claude/forge-bin/mid.cjs', "'use strict';\n");
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === false && fr.wired_without_caller.some((w) => w.id === 'tool:leaf.cjs'), JSON.stringify(fr));
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
