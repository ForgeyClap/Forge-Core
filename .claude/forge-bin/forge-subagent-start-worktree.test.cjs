#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-start-worktree.test.cjs: own mistake, 2026-11-07. The Lead launched a Workflow with
 * isolation:'worktree' while the session's working folder was command-center/dashboard (a NESTED git repository). Both
 * builder lanes started in worktrees of the command-center repo (<root>/command-center/.claude/worktrees/wf_...), where
 * the Forge files they had to change do not exist; one lane copied the whole dev tree into its worktree. Guard, through
 * the real SubagentStart hook CLI: an agent whose cwd is an agent worktree of ANOTHER repository than the project root
 * gets a STOP instruction in its start context (even with no active run); a worktree of the project itself, the project
 * root and an ordinary sub-folder get no such text; FORGE_SUBAGENT_START_HOOK=off keeps it silent.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); } };
const roots = [];
const tmp = (p) => { const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); roots.push(r); return r; };
const HOME = tmp('forge-ssw-home-');
const START = path.join(__dirname, 'forge-subagent-start.cjs');
const cli = (root, cwd, extraEnv) => spawnSync(process.execPath, [START], {
  input: JSON.stringify({ session_id: 'sess-ssw', transcript_path: 'C:/x/main.jsonl', cwd, hook_event_name: 'SubagentStart', agent_id: 'a1b2c3d4', agent_type: 'build-boss' }),
  encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, HOME, USERPROFILE: HOME, FORGE_SUBAGENT_START_HOOK: '', FORGE_RUN_ID: '' }, extraEnv || {}) });
const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; } };

try {
  console.log('forge-subagent-start: worktree of another repository (own mistake 2026-11-07)');
  const root = tmp('forge-ssw-');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const nested = path.join(root, 'command-center', '.claude', 'worktrees', 'wf_0d3236e7-a5b-1');
  fs.mkdirSync(nested, { recursive: true });
  let r = cli(root, nested);
  let c = ctxOf(r);
  t('W1 the real shape (worktree of the nested command-center repo): STOP text, exit 0', r.status === 0 && /STOP/.test(c) && /command-center/.test(c), JSON.stringify({ s: r.status, o: r.stdout, e: r.stderr }));
  t('W1b ... it names the project root the work belongs to', c.includes(root) || c.includes(root.replace(/\\/g, '/')), c);
  r = cli(root, nested.replace(/\\/g, '/'));
  t('W2 the same path written with forward slashes is caught too', /STOP/.test(ctxOf(r)), r.stdout);
  const own = path.join(root, '.claude', 'worktrees', 'wf_ok-1');
  fs.mkdirSync(own, { recursive: true });
  r = cli(root, own);
  t('W3 a worktree of the project itself: no STOP text', r.status === 0 && !/STOP/.test(ctxOf(r)), r.stdout);
  r = cli(root, root);
  t('W4 the project root: no STOP text', r.status === 0 && !/STOP/.test(ctxOf(r)), r.stdout);
  r = cli(root, path.join(root, 'command-center', 'dashboard'));
  t('W5 an ordinary sub-folder (not a worktree): no STOP text', r.status === 0 && !/STOP/.test(ctxOf(r)), r.stdout);
  r = cli(root, nested, { FORGE_SUBAGENT_START_HOOK: 'off' });
  t('W6 FORGE_SUBAGENT_START_HOOK=off keeps the hook silent', r.status === 0 && r.stdout === '', r.stdout);
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
