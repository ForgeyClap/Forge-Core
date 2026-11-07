#!/usr/bin/env node
'use strict';
// forge-workflows.test.cjs — structural + behavioural test for .claude/workflows/forge-build.js and forge-verify.js
// (package 2.3). Workflow scripts cannot be started from a test (a real run needs the owner's
// dynamic-workflows / ultracode opt-in), so this test checks them statically, runs them in a node:vm sandbox with a
// mocked agent()/parallel()/phase()/log(), and feeds them to the REAL GOAT guard hook as a child process.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, '.claude', 'workflows');
const SCRIPTS = { build: path.join(WF_DIR, 'forge-build.js'), verify: path.join(WF_DIR, 'forge-verify.js') };
const GUARD = path.join(os.homedir(), '.claude', 'hooks', 'goat-workflow-guard.cjs');
const ROUTING = path.join(ROOT, '.claude', 'FORGE_MODEL_ROUTING.json');
const SRC = { build: fs.readFileSync(SCRIPTS.build, 'utf8'), verify: fs.readFileSync(SCRIPTS.verify, 'utf8') };

let passed = 0, failed = 0, skipped = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn: fn === 'skip' ? fn : () => fn() }); }

/* ---------- a small lexer: blank strings, comments and template text, keep ${...} code ---------- */
function mask(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0; const stack = []; let depth = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (stack.length && stack[stack.length - 1] === 'tpl') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && d === '{') { stack.push(depth); i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (c === '/' && d === '/') { let j = i; while (j < src.length && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; blank(i, j); i = j; continue; }
    if (c === '\'' || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; blank(i + 1, j); i = j + 1; continue; }
    if (c === '`') { stack.push('tpl'); i++; continue; }
    if (c === '/' && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 4), i))) { // a regex literal
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n' && (src[j] !== '/' || cls)) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === '{') depth++;
    if (c === '}') { if (stack.length && stack[stack.length - 1] === depth) { stack.pop(); i++; continue; } /* back into the template */ depth--; }
    i++;
  }
  return out.join('');
}

function matchClose(m, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' }; const st = [];
  for (let i = open; i < m.length; i++) {
    if (pairs[m[i]]) st.push(pairs[m[i]]);
    else if (m[i] === ')' || m[i] === '}' || m[i] === ']') { if (st.pop() !== m[i]) return -1; if (!st.length) return i; }
  }
  return -1;
}

/** Every agent( call: {line, opts (masked options text), raw (original options text)}. */
function agentCalls(src) {
  const m = mask(src); const calls = []; const re = /(^|[^\w$.])agent\s*\(/g; let r;
  while ((r = re.exec(m))) {
    const open = r.index + r[0].length - 1; const close = matchClose(m, open);
    assert.ok(close > 0, 'unbalanced agent( call at offset ' + open);
    const lastBrace = m.lastIndexOf('}', close); const objOpen = (() => { // the options object is the last top-level {...}
      for (let i = open + 1, depth = 0; i < close; i++) {
        if (m[i] === '(' || m[i] === '[') depth++; else if (m[i] === ')' || m[i] === ']') depth--;
        else if (m[i] === '{' && depth === 0 && matchClose(m, i) === lastBrace) return i;
        else if (m[i] === '{') { const e = matchClose(m, i); if (e > 0) i = e; }
      }
      return -1;
    })();
    assert.ok(objOpen > 0, 'agent( call without an options object at line ' + (m.slice(0, open).split('\n').length));
    calls.push({ line: m.slice(0, open).split('\n').length, opts: m.slice(objOpen, lastBrace + 1), raw: src.slice(objOpen, lastBrace + 1) });
  }
  return calls;
}

// Public build: the generic GOAT route agents (quick/build/deep/escalate) are the owner's GLOBAL agents and do
// not ship with Forge-Core, so on a machine without them a call that names one cannot be judged here (Forge projects use
// the shipped Bosses instead). Those calls are then reported as SKIP with this reason, never counted as a pass or a fail.
const GOAT_ROUTE_AGENTS = ['quick', 'build', 'deep', 'escalate'];
const agentFileExists = (name) => [path.join(ROOT, '.claude', 'agents'), path.join(os.homedir(), '.claude', 'agents')].some((d) => fs.existsSync(path.join(d, name + '.md')));
const GOAT_INSTALLED = GOAT_ROUTE_AGENTS.every(agentFileExists);
function frontmatterRouted(name) {
  for (const dir of [path.join(ROOT, '.claude', 'agents'), path.join(os.homedir(), '.claude', 'agents')]) {
    let text; try { text = fs.readFileSync(path.join(dir, name + '.md'), 'utf8'); } catch { continue; }
    const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const model = (fm.match(/^model:\s*(\S+)/m) || [])[1]; const effort = (fm.match(/^effort:\s*(\S+)/m) || [])[1];
    return Boolean(model && effort && model !== 'inherit');
  }
  return false;
}

/* ---------- running a script in a sandbox with a mocked workflow runtime ---------- */
async function runScript(src, args, respond) {
  const body = src.replace(/^export const meta\s*=/m, 'const meta =');
  const calls = []; const phases = []; const logs = []; let active = 0; let maxActive = 0;
  const sandbox = {
    args,
    phase: (p) => phases.push(p),
    log: (s) => logs.push(String(s)),
    agent: async (prompt, opts) => {
      active++; maxActive = Math.max(maxActive, active);
      calls.push({ prompt, opts: JSON.parse(JSON.stringify(opts)) });
      await new Promise(r => setImmediate(r));
      try { return respond(prompt, opts, calls.length); } finally { active--; }
    },
    parallel: (thunks) => Promise.all(thunks.map(f => Promise.resolve().then(f).catch(() => null))),
  };
  const fn = vm.runInNewContext(`(async () => {\n${body}\n})`, sandbox, { filename: 'workflow.js' });
  const result = await fn();
  return { result, calls, phases, logs, maxActive };
}

const BASE = { task: 'Add a --json flag to the status command and test it.', projectRoot: 'C:/proj' };
const TRI = (route, extra = {}) => ({ route, risk: 'medium', checks: ['tests'], pattern: 'cli flag', ...extra });
const WORKER_OK = { status: 'completed', filesChanged: ['a.js'], testsRun: [{ command: 'node a.test.js', exitCode: 0 }] };
const V = (verdict, failureKind = verdict === 'PASS' ? 'none' : 'process') => ({ verdict, failureKind, checks: [], evidence: 'x' });

/** respond(): triage -> tri; workers -> ok; verifier -> verdicts in order. */
function responder(tri, verdicts) {
  let v = 0;
  return (prompt, opts) => {
    if (opts.phase === 'Triage') return tri;
    if (opts.phase === 'Verify') return verdicts[v++];
    return WORKER_OK;
  };
}
const workers = (calls) => calls.filter(c => c.opts.phase === 'Build' || c.opts.phase === 'Escalate');
const verifiers = (calls) => calls.filter(c => c.opts.phase === 'Verify');

/* ================================ static checks ================================ */

for (const [key, src] of Object.entries(SRC)) {
  t(`${key}: the script starts with an "export const meta = {...}" block that is a pure literal`, () => {
    assert.ok(src.startsWith('export const meta = {'), 'must start with export const meta = {');
    const m = mask(src); const open = m.indexOf('{'); const close = matchClose(m, open);
    const text = src.slice(open, close + 1);
    assert.ok(!text.includes('`'), 'no template literals in meta');
    const stripped = text.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, 'S');
    const words = stripped.match(/[A-Za-z_$][\w$]*/g) || [];
    const bad = words.filter((w, i) => w !== 'S' && w !== 'true' && w !== 'false' && w !== 'null' && !new RegExp(`\\b${w}\\s*:`).test(stripped));
    assert.deepStrictEqual(bad, [], 'meta contains non-literal identifiers: ' + bad.join(', '));
    assert.ok(/^[\s{}[\]:,S\w.-]*$/.test(stripped), 'meta contains operators or calls');
    const meta = vm.runInNewContext('(' + text + ')', Object.create(null));
    assert.ok(meta.name && meta.description && Array.isArray(meta.phases), 'meta needs name, description, phases');
  });

  t(`${key}: no Node API, clock or randomness (resume replays identical agent() calls)`, () => {
    const m = mask(src);
    for (const re of [/\brequire\s*\(/, /\bimport\b/, /\bprocess\./, /\bDate\b/, /Math\.random/, /\bfetch\s*\(/, /\bsetTimeout\b/]) assert.ok(!re.test(m), 'forbidden: ' + re);
  });

  t(`${key}: every agent() call carries a route (a literal routed agentType, or literal model + effort)`, () => {
    const calls = agentCalls(src);
    assert.ok(calls.length > 0, 'no agent() calls found');
    for (const c of calls) {
      const at = c.raw.match(/\bagentType\s*:\s*'([\w-]+)'/);
      const model = /\bmodel\s*:\s*'(sonnet|opus|fable)'/.test(c.raw);
      const effort = /\beffort\s*:\s*'(low|medium|high|xhigh|max)'/.test(c.raw);
      if (!GOAT_INSTALLED && at && GOAT_ROUTE_AGENTS.includes(at[1])) continue; // not judgeable here: see GOAT_ROUTE_AGENTS
      assert.ok((at && frontmatterRouted(at[1])) || (model && effort), `line ${c.line}: unrouted agent() options ${c.raw.replace(/\s+/g, ' ').slice(0, 120)}`);
      // explicit route opts: model + effort keys in the call, or a `...o` spread of a const o that carries both
      const spread = (c.opts.match(/\.\.\.([A-Za-z_$][\w$]*)/) || [])[1];
      const viaSpread = spread && new RegExp(`const ${spread} = \\{[^\\n]*\\bmodel: step\\.model, effort: step\\.effort`).test(src);
      assert.ok((/\bmodel\s*:/.test(c.opts) && /\beffort\s*:/.test(c.opts)) || viaSpread, `line ${c.line}: explicit model + effort opts expected on every call`);
    }
  });

  t(`${key}: haiku is never used`, () => assert.ok(!/haiku/i.test(src)));
}

t('build: MAX_ESCALATIONS is exactly 1 and fable appears only in the GOAT escalate entry', () => {
  assert.ok(/^const MAX_ESCALATIONS = 1$/m.test(SRC.build), 'const MAX_ESCALATIONS = 1');
  const m = mask(SRC.build);
  const fableLines = SRC.build.split('\n').filter(l => /fable/.test(l) && !/^\s*(\/\/|\{ title)/.test(l));
  assert.deepStrictEqual(fableLines.map(l => l.trim()), ["escalate: { model: 'fable', effort: 'high' },"]);
  const a = m.indexOf('// <escalation>'); // comments are masked; find markers in the raw source instead
  const s = SRC.build.indexOf('// <escalation>'); const e = SRC.build.indexOf('// </escalation>');
  assert.ok(a === -1 && s > 0 && e > s, 'escalation markers present');
  const outside = SRC.build.slice(0, s) + SRC.build.slice(e);
  assert.ok(!/GOAT\.escalate/.test(outside), 'GOAT.escalate is used only inside the escalation section');
});

t('verify: forge-verify is read-only (no worker agent types, no fable/opus)', () => {
  assert.ok(!/build-boss|'build'|'deep'|'quick'|fable|opus/.test(mask(SRC.verify).replace(/\s+/g, ' ')) && !/fable|opus/.test(SRC.verify));
});

t('build: the GOAT table in the script equals FORGE_MODEL_ROUTING.json routes', () => {
  const m = mask(SRC.build); const at = SRC.build.indexOf('const GOAT = {'); const open = SRC.build.indexOf('{', at);
  const goat = vm.runInNewContext('(' + SRC.build.slice(open, matchClose(m, open) + 1) + ')', Object.create(null));
  const routes = JSON.parse(fs.readFileSync(ROUTING, 'utf8')).routes;
  for (const r of ['triage', 'quick', 'build', 'deep', 'verifier', 'escalate']) {
    assert.deepStrictEqual({ model: goat[r].model, effort: goat[r].effort }, { model: routes[r].model, effort: routes[r].effort }, r);
  }
});

t('routing json: agentToolFacts no longer offers haiku as a route and documents workflow agent() facts', () => {
  const j = JSON.parse(fs.readFileSync(ROUTING, 'utf8'));
  assert.ok(!/sonnet\|opus\|haiku\|fable/.test(j.agentToolFacts.modelParam), 'modelParam must not list haiku as a routing option');
  assert.ok(/not a default route/i.test(j.agentToolFacts.modelParam));
  const w = j.agentToolFacts.workflowAgent;
  assert.ok(w && /stallMs/.test(w.documentedOptions) && /16/.test(w.concurrencyCap) && /-p/.test(w.ultracodeStart) && /re-probe/i.test(w.agentTypeEffort));
});

/* ================================ behaviour (sandbox) ================================ */

t('build: happy path in a Forge project — head-chef sonnet/low, build-boss opus/medium, verify-boss sonnet/medium, no escalation', async () => {
  const r = await runScript(SRC.build, BASE, responder(TRI('build'), [V('PASS')]));
  assert.strictEqual(r.result.status, 'PASS'); assert.strictEqual(r.result.escalations, 0); assert.strictEqual(r.result.lesson, null);
  const tri = r.calls[0].opts; assert.deepStrictEqual([tri.agentType, tri.model, tri.effort], ['head-chef', 'sonnet', 'low']);
  const w = workers(r.calls); assert.strictEqual(w.length, 1); assert.deepStrictEqual([w[0].opts.agentType, w[0].opts.model, w[0].opts.effort], ['build-boss', 'opus', 'medium']);
  const v = verifiers(r.calls); assert.deepStrictEqual([v[0].opts.agentType, v[0].opts.model, v[0].opts.effort], ['verify-boss', 'sonnet', 'medium']);
  assert.ok(w[0].opts.label.startsWith('Build Boss · ') && v[0].opts.label.startsWith('Verify Boss · '));
});

t('build: generic project uses the GOAT agents triage / quick / verifier', async () => {
  const r = await runScript(SRC.build, { ...BASE, forge: false }, responder(TRI('quick'), [V('PASS')]));
  assert.deepStrictEqual(r.calls.map(c => [c.opts.agentType, c.opts.model, c.opts.effort]), [['triage', 'sonnet', 'low'], ['quick', 'sonnet', 'low'], ['verifier', 'sonnet', 'medium']]);
});

t('build: executionEffort overrides the worker effort only (owner mission: opus/high)', async () => {
  const r = await runScript(SRC.build, { ...BASE, executionEffort: 'high' }, responder(TRI('build'), [V('PASS')]));
  const w = workers(r.calls)[0].opts; assert.deepStrictEqual([w.model, w.effort], ['opus', 'high']);
  assert.strictEqual(r.calls[0].opts.effort, 'low'); assert.strictEqual(verifiers(r.calls)[0].opts.effort, 'medium');
});

t('build: process failure -> ONE step of more effort on the same model, then PASS + lesson line', async () => {
  const r = await runScript(SRC.build, { ...BASE, today: '2026-10-24' }, responder(TRI('build'), [V('FAIL', 'process'), V('PASS')]));
  const w = workers(r.calls); assert.deepStrictEqual(w.map(c => [c.opts.model, c.opts.effort]), [['opus', 'medium'], ['opus', 'high']]);
  assert.strictEqual(r.result.status, 'PASS'); assert.strictEqual(r.result.escalations, 1);
  assert.strictEqual(r.result.lesson.line, '2026-10-24 cli flag -> build (opus/high)'); assert.strictEqual(r.result.lesson.written, false);
  assert.ok(w[1].prompt.includes('single escalation attempt'));
});

t('build: context failure on build -> bigger model (deep opus/xhigh), never fable', async () => {
  const r = await runScript(SRC.build, BASE, responder(TRI('build'), [V('FAIL', 'context'), V('PASS')]));
  assert.deepStrictEqual(workers(r.calls).map(c => [c.opts.model, c.opts.effort]), [['opus', 'medium'], ['opus', 'xhigh']]);
});

t('build: context failure on deep -> fable/high as the last step (generic: agentType escalate)', async () => {
  const r = await runScript(SRC.build, { ...BASE, forge: false }, responder(TRI('deep'), [V('FAIL', 'context'), V('PASS')]));
  const w = workers(r.calls); assert.deepStrictEqual(w.map(c => [c.opts.agentType, c.opts.model, c.opts.effort]), [['deep', 'opus', 'xhigh'], ['escalate', 'fable', 'high']]);
});

t('build: a second FAIL stops — exactly one escalation, two verifier runs, status FAIL, honest lesson', async () => {
  const r = await runScript(SRC.build, BASE, responder(TRI('quick'), [V('FAIL', 'context'), V('FAIL', 'context'), V('PASS')]));
  assert.strictEqual(r.result.status, 'FAIL'); assert.strictEqual(r.result.escalations, 1);
  assert.strictEqual(verifiers(r.calls).length, 2); assert.strictEqual(workers(r.calls).length, 2);
  assert.ok(/no route passed after one escalation/.test(r.result.lesson.line));
});

t('build: fable never appears unless a deep-route check failed on context', async () => {
  for (const route of ['quick', 'build', 'deep']) {
    const cases = [[V('PASS')], [V('FAIL', 'process'), V('PASS')], [V('FAIL', 'process'), V('FAIL', 'process')]];
    if (route !== 'deep') cases.push([V('FAIL', 'context'), V('FAIL', 'context')]);
    for (const vs of cases) {
      const r = await runScript(SRC.build, BASE, responder(TRI(route), vs));
      assert.ok(!r.calls.some(c => c.opts.model === 'fable'), `${route} ${vs.map(v => v.failureKind)}`);
    }
  }
});

t('build: a process failure on deep (xhigh) gets more effort (max) on opus, not fable', async () => {
  const r = await runScript(SRC.build, BASE, responder(TRI('deep'), [V('FAIL', 'process'), V('PASS')]));
  assert.deepStrictEqual(workers(r.calls).map(c => [c.opts.model, c.opts.effort]), [['opus', 'xhigh'], ['opus', 'max']]);
});

t('build: parts run in parallel with disjoint ownership in each prompt', async () => {
  const parts = [{ id: 'core', task: 'core', owns: ['src/core'] }, { id: 'tests', task: 'tests', owns: ['test/core.test.js'] }];
  const r = await runScript(SRC.build, { ...BASE, parts }, responder(TRI('build'), [V('PASS')]));
  const w = workers(r.calls); assert.strictEqual(w.length, 2); assert.strictEqual(r.maxActive, 2);
  assert.ok(w[0].prompt.includes('You own ONLY these paths: src/core') && w[0].prompt.includes('tests: test/core.test.js'));
});

t('build: overlapping ownership, >4 parts, bad paths and bad executionEffort fail before any agent starts', async () => {
  const bad = [
    { parts: [{ id: 'a', task: 'x', owns: ['src'] }, { id: 'b', task: 'y', owns: ['SRC/b.js'] }] },
    { parts: [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i, task: 'x', owns: ['f' + i] })) },
    { parts: [{ id: 'a', task: 'x', owns: ['../etc'] }] },
    { parts: [{ id: 'a', task: 'x', owns: ['src/*.js'] }] },
    { executionEffort: 'max' },
    { projectRoot: 'relative/path' },
    { task: '' },
  ];
  for (const extra of bad) {
    let n = 0;
    await assert.rejects(runScript(SRC.build, { ...BASE, ...extra }, () => { n++; return null; }), JSON.stringify(extra));
    assert.strictEqual(n, 0, 'an agent started for ' + JSON.stringify(extra));
  }
});

t('build: an invalid triage route falls back to deep; a missing verifier is UNVERIFIED, never PASS', async () => {
  const r = await runScript(SRC.build, BASE, responder(TRI('mega'), [V('PASS')]));
  assert.deepStrictEqual([workers(r.calls)[0].opts.model, workers(r.calls)[0].opts.effort], ['opus', 'xhigh']);
  const u = await runScript(SRC.build, BASE, responder(TRI('build'), [null]));
  assert.strictEqual(u.result.status, 'UNVERIFIED'); assert.strictEqual(u.result.escalations, 0);
});

t('build: deterministic — the same args produce identical agent() prompts and options (resume-safe)', async () => {
  const a = await runScript(SRC.build, BASE, responder(TRI('build'), [V('FAIL'), V('PASS')]));
  const b = await runScript(SRC.build, BASE, responder(TRI('build'), [V('FAIL'), V('PASS')]));
  assert.deepStrictEqual(a.calls, b.calls);
});

t('verify: parallel verifier rows -> PASS/FAIL/INCOMPLETE table, batches of at most 16', async () => {
  const pass = await runScript(SRC.verify, { projectRoot: 'C:/proj', checks: ['tests', { name: 'lint', command: 'npm run lint' }] }, () => ({ result: 'PASS', exitCode: 0, evidence: 'ok' }));
  assert.strictEqual(pass.result.verdict, 'PASS'); assert.strictEqual(pass.result.table.length, 2);
  assert.ok(pass.calls.every(c => c.opts.agentType === 'verify-boss' && c.opts.model === 'sonnet' && c.opts.effort === 'medium'));
  assert.ok(pass.result.markdown.startsWith('| Check | Result |'));
  const mixed = await runScript(SRC.verify, { projectRoot: 'C:/proj', checks: ['a', 'b', 'c'] }, (p) => (p.includes('Check: b') ? { result: 'FAIL', exitCode: 1, evidence: 'boom' } : { result: 'PASS', exitCode: 0, evidence: 'ok' }));
  assert.strictEqual(mixed.result.verdict, 'FAIL');
  const lost = await runScript(SRC.verify, { projectRoot: 'C:/proj', checks: ['a', 'b'] }, (p) => (p.includes('Check: b') ? null : { result: 'PASS', exitCode: 0, evidence: 'ok' }));
  assert.strictEqual(lost.result.verdict, 'INCOMPLETE');
  const many = await runScript(SRC.verify, { projectRoot: 'C:/proj', checks: Array.from({ length: 20 }, (_, i) => 'c' + i) }, () => ({ result: 'PASS', evidence: 'ok' }));
  assert.strictEqual(many.calls.length, 20); assert.ok(many.maxActive <= 16, 'max concurrent ' + many.maxActive);
});

/* ================================ the REAL guard hook ================================ */

function guard(payload) {
  const env = { ...process.env }; delete env.GOAT_WORKFLOW_GUARD;
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 15000 });
  const decision = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
  return { status: r.status, decision, stdout: r.stdout, stderr: r.stderr };
}
const payload = (tool_input) => ({ hook_event_name: 'PreToolUse', tool_name: 'Workflow', tool_input, cwd: ROOT, session_id: 'forge-workflows-test' });
const guardPresent = fs.existsSync(GUARD);
function tg(name, fn) { t(name, guardPresent ? fn : 'skip'); }

tg('guard: positive control — the real hook denies an unrouted agent()', () => {
  const g = guard(payload({ script: "export const meta = { name: 'x', description: 'x' }\nawait agent('hi', { label: 'x' })" }));
  assert.strictEqual(g.status, 0); assert.strictEqual(g.decision, 'deny', g.stdout + g.stderr);
});

for (const [key, file] of Object.entries(SCRIPTS)) {
  tg(`guard: accepts ${path.basename(file)} by scriptPath and inline (exit 0, no deny, no fail-open note)`, () => {
    for (const ti of [{ scriptPath: file }, { scriptPath: path.relative(ROOT, file) }, { script: SRC[key] }]) {
      const g = guard(payload(ti));
      assert.strictEqual(g.status, 0); assert.strictEqual(g.decision, 'allow', g.stdout); assert.strictEqual(g.stderr, '', 'stderr: ' + g.stderr);
    }
  });
}

function mutateAndGuard(src, from, to) {
  assert.ok(src.includes(from), 'mutation anchor missing: ' + from);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wf-mut-'));
  try {
    const f = path.join(dir, 'mutant.js'); fs.writeFileSync(f, src.replace(from, to));
    return guard(payload({ scriptPath: f }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

tg('guard: mutant — removing effort from the triage agent() is denied', () => {
  const g = mutateAndGuard(SRC.build, "{ agentType: TRIAGE_AGENT, model: 'sonnet', effort: 'low',", "{ agentType: TRIAGE_AGENT, model: 'sonnet',");
  assert.strictEqual(g.decision, 'deny', g.stdout + g.stderr); assert.ok(/effort/.test(g.stdout));
});

tg('guard: mutant — removing effort from the forge-verify agent() is denied', () => {
  const g = mutateAndGuard(SRC.verify, "model: 'sonnet', effort: 'medium',", "model: 'sonnet',");
  assert.strictEqual(g.decision, 'deny', g.stdout + g.stderr);
});

tg('guard: mutant — a worker with an unrouted agentType (runtime model/effort only) is denied', () => {
  const g = mutateAndGuard(SRC.build, "agent(prompt, { ...o, agentType: 'quick' })", "agent(prompt, { ...o, agentType: 'general-purpose' })");
  assert.strictEqual(g.decision, 'deny', g.stdout + g.stderr);
});

if (!GOAT_INSTALLED) queue.push({ name: 'build/verify: worker calls that name a generic GOAT route agent (quick/build/deep/escalate)', fn: { skip: 'those global agents are not installed on this machine (they do not ship with Forge-Core), so their route cannot be read from a frontmatter here' } });

/* ---------- runner ---------- */
(async () => {
  console.log('forge workflows tests (forge-build.js / forge-verify.js, static + sandbox + real guard)');
  for (const { name, fn } of queue) {
    if (fn === 'skip') { skipped++; console.log('  SKIP ' + name + ' — guard not found at ' + GUARD); continue; }
    if (fn && fn.skip) { skipped++; console.log('  SKIP ' + name + ' — ' + fn.skip); continue; }
    try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
})();
