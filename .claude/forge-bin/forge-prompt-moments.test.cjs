#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-prompt-moments.test.cjs — SD-T7 (default skills Task 7; design: .claude/docs/default-skills.md): the
 * main-session moment check. A vague owner prompt gets ONE directive line for forge-prompt-coach, new build work one for
 * forge-brainstorm; a precise prompt (a path or file token), a slash command and machine text get none. The hook case
 * runs the REAL forge-scribe-hook CLI against a throwaway project root (os.mkdtemp, removed at the end) that has no
 * scribe, so nothing is written anywhere; the real project is only read (the moments come from its loader).
 * Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')); }
};
const section = (name, fn) => { try { fn(); } catch (e) { fail++; console.error('  FAIL ' + name + ' threw: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } };

const PROJECT = path.join(__dirname, '..', '..');
const HOOK = path.join(__dirname, 'forge-scribe-hook.cjs');
let M = null;
try { M = require('./forge-prompt-moments.cjs'); } catch (e) { fail++; console.error('  FAIL module loads :: ' + e.message); }
const momentOf = (text) => (M && typeof M.momentFor === 'function' ? M.momentFor(text, { root: PROJECT }) : undefined);
const roots = [];

try {
  section('moments', () => {
    const vague = momentOf('maak het mooier');
    t('"maak het mooier" -> vague_prompt (forge-prompt-coach)', !!vague && vague.moment === 'vague_prompt' && vague.skill === 'forge-prompt-coach', JSON.stringify(vague));
    t('"zet de knop in index.html regel 40 op #1a1a1a" -> null (a file token makes it precise)', momentOf('zet de knop in index.html regel 40 op #1a1a1a') === null, JSON.stringify(momentOf('zet de knop in index.html regel 40 op #1a1a1a')));
    const nw = momentOf('bouw een nieuwe boekingspagina');
    t('"bouw een nieuwe boekingspagina" -> new_work (forge-brainstorm)', !!nw && nw.moment === 'new_work' && nw.skill === 'forge-brainstorm', JSON.stringify(nw));
    t('"Fix the null check in src/a.js line 12" -> null', momentOf('Fix the null check in src/a.js line 12') === null, JSON.stringify(momentOf('Fix the null check in src/a.js line 12')));
    t('"bouw een export functie in server.js" -> null (a lowercase x.js is a file token)', momentOf('bouw een export functie in server.js') === null, JSON.stringify(momentOf('bouw een export functie in server.js')));
    t('"/forge status" -> null (slash command)', momentOf('/forge status') === null, JSON.stringify(momentOf('/forge status')));
    // Lead follow-up 2026-11-08 (the builder's own replay): the owner types new work after /forge and chains routing
    // commands ("/forge /goal /superpowers:brainstorming ik wil ..."), so the free text after the leading slash words is
    // judged; a bare subcommand and a harness command stay null.
    const fw = momentOf('/forge bouw een nieuwe boekingspagina voor de kapper');
    t('"/forge bouw een nieuwe boekingspagina ..." -> new_work (the text after /forge is judged)', !!fw && fw.moment === 'new_work', JSON.stringify(fw));
    const fv = momentOf('/forge /goal /superpowers:brainstorming maak het mooier');
    t('"/forge /goal /superpowers:brainstorming maak het mooier" -> vague_prompt', !!fv && fv.moment === 'vague_prompt', JSON.stringify(fv));
    t('"/forge remember altijd Nederlands in rapporten" -> null (a Forge subcommand)', momentOf('/forge remember altijd Nederlands in rapporten') === null, JSON.stringify(momentOf('/forge remember altijd Nederlands in rapporten')));
    t('"/model opus" -> null (a harness command)', momentOf('/model opus') === null, JSON.stringify(momentOf('/model opus')));
    t('"/forge config set gate-hook off" -> null (a Forge subcommand)', momentOf('/forge config set gate-hook off') === null);
    t('machine text (a task notification) -> null', momentOf('<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\nmaak het mooier\n</task-notification>') === null);
    for (const p of ['fix het', 'doe iets', 'regel het', 'pak het aan', 'maak het beter', 'improve the site']) {
      const r = momentOf(p);
      t('"' + p + '" -> vague_prompt', !!r && r.moment === 'vague_prompt', JSON.stringify(r));
    }
    t('a vague word in a long prompt (400+ chars) gets no coach line', momentOf('maak het mooier ' + 'x'.repeat(400)) === null || momentOf('maak het mooier ' + 'x'.repeat(400)).moment !== 'vague_prompt');
    t('non-string input -> null, never a throw', M && M.momentFor(null) === null && M.momentFor(42) === null && M.momentFor({}) === null);
    const all = ['maak het mooier', 'bouw een nieuwe boekingspagina', 'create a landing page', 'doe iets'].map(momentOf).filter(Boolean);
    t('every directive is at most 300 characters and says it is a step to take before working', all.length === 4 && all.every((r) => typeof r.directive === 'string' && r.directive.length <= 300 && /before/i.test(r.directive) && /then/i.test(r.directive)), JSON.stringify(all.map((r) => r && r.directive.length)));
    t('directives come from the loader (FORGE_DEFAULT_SKILLS.json moments), not a local copy', (() => {
      const D = require('./forge-default-skills.cjs').loadDefaults(PROJECT);
      return D.data && vague && vague.directive === D.data.moments.vague_prompt.directive && nw && nw.directive === D.data.moments.new_work.directive;
    })());
  });

  section('hook carries it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-moments-hook-'));
    roots.push(root);
    const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root });
    delete env.FORGE_SCRIBE_HOOK;
    const run = (prompt) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ prompt, session_id: 's-mom', cwd: root }), env, encoding: 'utf8', timeout: 15000 });
    const r = run('maak het mooier');
    let ctx = null;
    try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { ctx = null; }
    t('hook carries it: the real hook CLI on a vague prompt prints additionalContext with forge-prompt-coach', r.status === 0 && typeof ctx === 'string' && ctx.includes('forge-prompt-coach'), JSON.stringify({ status: r.status, out: r.stdout, err: r.stderr }));
    const p = run('zet de knop in index.html regel 40 op #1a1a1a');
    t('hook: a precise prompt prints no directive (exit 0)', p.status === 0 && !/forge-prompt-coach|forge-brainstorm/.test(p.stdout), p.stdout);
    const s = run('/forge status');
    t('hook: a slash command prints no directive (exit 0)', s.status === 0 && !/forge-prompt-coach|forge-brainstorm/.test(s.stdout), s.stdout);
    t('hook: the temp root without a scribe stays empty (nothing written)', fs.readdirSync(root).length === 0, fs.readdirSync(root).join(','));
    const H = require('./forge-scribe-hook.cjs');
    const off = H.runPrompt({ prompt: 'maak het mooier' }, { projectRoot: root, env: { FORGE_SCRIBE_HOOK: 'off' }, scribe: null });
    t('hook: FORGE_SCRIBE_HOOK=off also turns the directive off', !off.print && !off.text, JSON.stringify(off));
    const inproc = H.runPrompt({ prompt: 'bouw een nieuwe boekingspagina' }, { projectRoot: root, env: {}, scribe: null });
    t('hook in-process: new work without a scribe still gets the forge-brainstorm line', inproc.print && /forge-brainstorm/.test(inproc.text || ''), JSON.stringify(inproc));
  });
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

console.log('\nforge-prompt-moments tests:');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
