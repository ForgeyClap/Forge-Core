#!/usr/bin/env node
'use strict';
/**
 * forge-global-forge-handover.test.cjs — category tests F8. In three fresh Forge projects `/forge <task>`
 * ran the GLOBAL ~/.claude/commands/forge.md ("Forge (global, lightweight)": load forge-core) instead of the project's
 * own .claude/commands/forge.md (router, Head Chef triage, Verify Boss, run contract, scribe). Claude Code picked the
 * personal command over the project command of the same name, and the global file only SAID "the project-local
 * /forge takes over" without making it happen. Result: no run, no playbooks, no Bosses, no memory, in all three.
 * Guard: the versioned copy of the global command (global-install/payload/commands/forge.md, kept equal to the live
 * file by forge-global-drift) must, BEFORE any lightweight instruction, hand over to the project's own command file
 * with the arguments. Skips in an installed project, where global-install/ is not shipped.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };

const ROOT = path.resolve(__dirname, '..', '..');
const COPY = path.join(ROOT, 'global-install', 'payload', 'commands', 'forge.md');
const H = require('./forge-global-handover.cjs');

t('handoverProblems: a command that only SAYS the project takes over is refused', () => {
  const old = '---\ndescription: x\n---\n# /forge (global)\n\nRun Forge for: **$ARGUMENTS**. Load the **`forge-core`** skill. If this project has a local Forge V2 install, the project-local /forge takes over.\n';
  assert.ok(H.handoverProblems(old).length > 0);
});
t('handoverProblems: a command whose first instruction reads and follows .claude/commands/forge.md with $ARGUMENTS passes', () => {
  const good = '---\ndescription: x\n---\n# /forge (global)\n\n**Step 0 (always first):** if the current folder has `.claude/commands/forge.md`, Read that file now and follow it as the /forge command with the arguments **$ARGUMENTS**; skip everything below.\n\nRun Forge for: **$ARGUMENTS**. Load the **`forge-core`** skill.\n';
  assert.deepStrictEqual(H.handoverProblems(good), []);
});
t('handoverProblems: the handover must come before the forge-core instruction', () => {
  const late = '---\ndescription: x\n---\nLoad the **`forge-core`** skill.\n\nIf the current folder has `.claude/commands/forge.md`, Read that file and follow it with **$ARGUMENTS**.\n';
  assert.ok(H.handoverProblems(late).some((p) => /before/.test(p)));
});
t('REAL versioned global /forge hands over to the project command first', () => {
  if (!fs.existsSync(COPY)) return; // installed project: global-install/ is not shipped
  assert.deepStrictEqual(H.handoverProblems(fs.readFileSync(COPY, 'utf8')), []);
});

t('doctor advisory global_forge_handover: red on a lightweight-only global command, green with the handover, n/a without a project command', () => {
  const os = require('os');
  const A = require('./doctor/checks-advisory.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-handover-'));
  const home = path.join(tmp, 'home'); const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(home, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'commands', 'forge.md'), '# project /forge\n');
  fs.writeFileSync(path.join(home, 'commands', 'forge.md'), '# /forge (global)\n\nRun Forge for: **$ARGUMENTS**. Load the **`forge-core`** skill.\n');
  const red = A.globalForgeHandover(proj, { home });
  fs.writeFileSync(path.join(home, 'commands', 'forge.md'), '# /forge (global)\n\n**Step 0:** if the current folder has `.claude/commands/forge.md`, Read that file and follow it with **$ARGUMENTS**.\n\nOtherwise load `forge-core`.\n');
  const green = A.globalForgeHandover(proj, { home });
  const na = A.globalForgeHandover(tmp, { home });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(red.ok, false); assert.strictEqual(red.applicable, true);
  assert.strictEqual(green.ok, true); assert.strictEqual(green.applicable, true);
  assert.strictEqual(na.applicable, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
