#!/usr/bin/env node
'use strict';
/**
 * forge-global-handover.cjs — checks that the global /forge command hands control to a project's own
 * .claude/commands/forge.md (category tests F8). Claude Code runs the personal command
 * (~/.claude/commands/forge.md) instead of a project command with the same name, so the global file must say, as its
 * first instruction, "read the project's command file and follow it with these arguments".
 *
 *   node .claude/forge-bin/forge-global-handover.cjs [file]   (default: the live ~/.claude/commands/forge.md)
 * Exit 0 = hands over, 1 = problems listed, 2 = file unreadable. Read-only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_CMD = '.claude/commands/forge.md';

/** handoverProblems(text) -> string[] (empty = the command hands over correctly). */
function handoverProblems(text) {
  const body = String(text || '').replace(/^﻿/, '').replace(/^---\n[\s\S]*?\n---\n/, '');
  const problems = [];
  const at = body.indexOf(PROJECT_CMD);
  if (at < 0) problems.push('never names ' + PROJECT_CMD + ', so a project install is never handed control');
  else {
    const window = body.slice(Math.max(0, at - 300), at + 400);
    if (!/\bRead\b/.test(window)) problems.push('names ' + PROJECT_CMD + ' but does not tell Claude to Read it');
    if (!/\$ARGUMENTS/.test(window)) problems.push('does not pass $ARGUMENTS on to the project command');
    if (!/follow/i.test(window)) problems.push('does not tell Claude to follow the project command');
    const core = body.search(/forge-core/);
    if (core >= 0 && core < at) problems.push('the forge-core instruction comes before the handover; the handover must be read first');
  }
  return problems;
}

if (require.main === module) {
  const file = process.argv[2] || path.join(os.homedir(), '.claude', 'commands', 'forge.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('forge-global-handover: cannot read ' + file + ': ' + e.code); process.exit(2); }
  const p = handoverProblems(text);
  if (!p.length) { console.log('OK: ' + file + ' hands /forge over to ' + PROJECT_CMD + ' first'); process.exit(0); }
  console.log('PROBLEM: ' + file + '\n  - ' + p.join('\n  - '));
  process.exit(1);
}

module.exports = { handoverProblems, PROJECT_CMD };
