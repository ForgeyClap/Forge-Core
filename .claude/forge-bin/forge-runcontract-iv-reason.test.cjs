#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-iv-reason.test.cjs — category finding R1. When a run has no review completion, the
 * independent-verification reason used to ask for "review_id, subject_log_hash, commit_sha en evidence_digest" even on a
 * root without git, where commit_sha is not required (opts.noGit). Guard: the reason names only the fields required at
 * THIS root and gives the exact one-line log command, without shell chaining.
 */
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };

const WORK = [
  { event_type: 'run_started', agent: 'orchestrator' },
  { event_type: 'subagent_started', agent: 'build-boss', dispatch_id: 'toolu_1' },
  { event_type: 'subagent_completed', agent: 'build-boss', dispatch_id: 'toolu_1' },
];
const SHA = 'a'.repeat(40);

const noGit = RC.independentVerification(WORK, { noGit: true, runId: 'forge-2026-11-07-x' });
t('no git at the root: the run is not verified', noGit.ok === false, noGit.reason);
t('no git: the reason does not ask for commit_sha', !/commit_sha/.test(noGit.reason), noGit.reason);
t('no git: the reason names review_id, review_verdict, subject_log_hash and evidence_digest', ['review_id', 'review_verdict', 'subject_log_hash', 'evidence_digest'].every((f) => noGit.reason.includes(f)), noGit.reason);
t('no git: the reason gives the one-line log command for this run', noGit.reason.includes("node .claude/forge-dashboard/log-event.cjs forge-2026-11-07-x review_completed '{"), noGit.reason);
const cmd = (noGit.reason.match(/node \.claude\/forge-dashboard\/log-event\.cjs [^']*'[^']*'/) || [''])[0];
t('the command is one line with no shell chaining (&&, ;, |)', cmd && !/&&|;|\|/.test(cmd) && !/\n/.test(cmd), cmd);
t('the command JSON parses', (() => { try { JSON.parse(cmd.slice(cmd.indexOf("'") + 1, -1)); return true; } catch { return false; } })(), cmd);

const git = RC.independentVerification(WORK, { noGit: false, commitSha: SHA, runId: 'r-git' });
t('a git root: the reason asks for commit_sha too', /commit_sha/.test(git.reason), git.reason);
t('a git root: the command carries the current HEAD', git.reason.includes('"commit_sha":"' + SHA + '"'), git.reason);
t('a git root: the command names this run', git.reason.includes('log-event.cjs r-git review_completed'), git.reason);

const anon = RC.independentVerification(WORK, { noGit: true });
t('without a run id the command keeps a <run_id> placeholder', anon.reason.includes('log-event.cjs <run_id> review_completed'), anon.reason);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
