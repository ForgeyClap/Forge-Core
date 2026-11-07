#!/usr/bin/env node
'use strict';
/**
 * forge-agent-tool-hook.test.cjs — the PreToolUse/PostToolUse(Agent) hook (WP A2). Throwaway roots only.
 * Covers: a sample Pre payload -> exactly { ts, event, session, tool, tool_use_id, subagent_type, name, model, effort,
 * background }; a sample Post payload -> the dispatched agent id from the response key that held it (agent_id_key),
 * status, ok; absent fields recorded as 'absent', free text as 'unlabelled'; the prompt, description and response text
 * NEVER on disk; secrets scrubbed; the caller fields of a nested dispatch; non-Agent tools skipped; a cut payload salvaged;
 * fail-open CLI (exit 0, empty stdout — a PreToolUse hook that exits 2 would BLOCK the Agent call); opt-out; the run
 * pointer. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AT = require('./forge-agent-tool-hook.cjs');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const mkRoot = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ath-')); fs.mkdirSync(path.join(r, '.claude')); roots.push(r); return r; };
const SCRIPT = path.join(__dirname, 'forge-agent-tool-hook.cjs');
const cli = (root, input, extraEnv) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, FORGE_AGENT_TOOL_HOOK: '', FORGE_RUN_ID: '' }, extraEnv || {}) });
const logOf = (root) => path.join(root, '.claude', 'forge-runs', '_hooks', 'agent-tool.jsonl');
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const SK = 'sk' + '-' + 'canaryAGENTTOOL0123456789abcdef';
const PROMPT = 'You are Build Boss. canaryPROMPTBODY implement the package';
const RESPONSE = 'Build Summary canaryRESPONSEBODY all green';

const pre = {
  session_id: 'sess-at-1', transcript_path: 'C:/Users/x/.claude/projects/p/s.jsonl', cwd: 'C:/proj', permission_mode: 'default',
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01ABCdef234',
  tool_input: { subagent_type: 'build-boss', description: 'Build canaryDESCRIPTION', prompt: PROMPT + ' ' + SK, name: 'Build Boss', model: 'opus', effort: 'medium', run_in_background: false },
};
const post = Object.assign({}, pre, {
  hook_event_name: 'PostToolUse',
  tool_response: { status: 'completed', agentId: 'a0123456789abcdef', prompt: PROMPT, content: [{ type: 'text', text: RESPONSE + ' ' + SK }], totalTokens: 1234 },
});

try {
  console.log('\nA) PreToolUse(Agent) record');
  const root = mkRoot();
  const r = AT.run(JSON.stringify(pre), { root, env: {} });
  let L = readLines(logOf(root));
  t('A1 one line in _hooks/agent-tool.jsonl', r.ok && r.wrote && L.length === 1, JSON.stringify(r));
  t('A2 exactly the token-free Pre fields', JSON.stringify(Object.keys(L[0]).sort()) === JSON.stringify(['background', 'effort', 'event', 'model', 'name', 'session', 'subagent_type', 'tool', 'tool_use_id', 'ts']), JSON.stringify(L[0]));
  t('A3 values carried through', L[0].event === 'PreToolUse' && L[0].tool === 'Agent' && L[0].tool_use_id === 'toolu_01ABCdef234' && L[0].subagent_type === 'build-boss'
    && L[0].name === 'Build Boss' && L[0].model === 'opus' && L[0].effort === 'medium' && L[0].background === false && L[0].session === 'sess-at-1', JSON.stringify(L[0]));

  console.log('\nB) PostToolUse(Agent) record');
  AT.run(JSON.stringify(post), { root, env: {} });
  L = readLines(logOf(root));
  t('B1 exactly the token-free Post fields', JSON.stringify(Object.keys(L[1]).sort()) === JSON.stringify(['agent_id', 'agent_id_key', 'event', 'ok', 'ok_basis', 'session', 'status', 'tool', 'tool_use_id', 'ts']), JSON.stringify(L[1]));
  t('B2 the dispatched agent id and the key that held it', L[1].event === 'PostToolUse' && L[1].agent_id === 'a0123456789abcdef' && L[1].agent_id_key === 'agentId' && L[1].status === 'completed' && L[1].ok === true, JSON.stringify(L[1]));
  t('B3 other response keys are read too (agent_id, resumedAgentId)', AT.agentIdOf({ agent_id: 'a1b2c3' }).agent_id_key === 'agent_id' && AT.agentIdOf({ resumedAgentId: 'a9' }).agent_id === 'a9');

  console.log('\nC) never content, never secrets (hunted on disk)');
  const disk = fs.readFileSync(logOf(root), 'utf8');
  t('C1 the prompt, the description and the response text never reach disk', !disk.includes('canaryPROMPTBODY') && !disk.includes('canaryDESCRIPTION') && !disk.includes('canaryRESPONSEBODY') && !disk.includes('canaryAGENTTOOL'));
  t('C2 no transcript path, no cwd', !disk.includes('transcript') && !disk.includes('C:/proj'));
  AT.run(JSON.stringify(Object.assign({}, pre, { session_id: SK, tool_use_id: SK, tool_input: { subagent_type: SK } })), { root, env: {} });
  t('C3 a secret-shaped session / id / subagent_type is not written raw', !fs.readFileSync(logOf(root), 'utf8').includes('canaryAGENTTOOL'));

  console.log('\nD) absent and unlabelled fields, nested caller, other tools');
  const bareRec = AT.buildRecord({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_x1y2z3a4', tool_input: { prompt: 'p' } });
  t('D1 missing Pre fields are recorded as "absent"', ['subagent_type', 'name', 'model', 'effort', 'background'].every((k) => bareRec[k] === 'absent'), JSON.stringify(bareRec));
  t('D2 a name with quotes or newlines is "unlabelled" (its text is never stored)', AT.buildRecord({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { name: 'Bob "the" builder\nX' } }).name === 'unlabelled');
  const strResp = AT.buildRecord({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_q1w2e3r4', tool_response: 'plain text result' });
  t('D3 a Post with a string response: agent_id absent, agent_id_key null, status absent', strResp.agent_id === 'absent' && strResp.agent_id_key === null && strResp.status === 'absent', JSON.stringify(strResp));
  const nested = AT.buildRecord(Object.assign({}, pre, { agent_id: 'afeedfeedfeedfeed', agent_type: 'boss' }));
  t('D4 a nested dispatch records the CALLER as caller_agent_id / caller_agent_type', nested.caller_agent_id === 'afeedfeedfeedfeed' && nested.caller_agent_type === 'boss' && nested.subagent_type === 'build-boss');
  t('D5 the older tool name Task is recorded too', AT.run(JSON.stringify(Object.assign({}, pre, { tool_name: 'Task' })), { root: mkRoot(), env: {} }).wrote === true);
  const other = mkRoot();
  t('D6 a non-Agent tool (Bash) is skipped: nothing written', AT.run(JSON.stringify(Object.assign({}, pre, { tool_name: 'Bash' })), { root: other, env: {} }).wrote === false && !fs.existsSync(logOf(other)));

  console.log('\nE) CLI: fail-open, never blocks, cut payload, opt-out, run pointer');
  for (const [name, input] of [['garbage', '{{{not json'], ['empty', ''], ['number', '7']]) {
    const c = cli(mkRoot(), input);
    t('E1 CLI on ' + name + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }
  const cr = mkRoot();
  fs.mkdirSync(path.join(cr, '.claude', 'forge-runs', 'run-at-7'), { recursive: true });
  AR.setActiveRun(cr, 'run-at-7', { session: 'sess-at-1' });
  const t0 = Date.now();
  const c = cli(cr, JSON.stringify(pre));
  const ms = Date.now() - t0;
  const cl = readLines(logOf(cr));
  t('E2 a valid PreToolUse: exit 0 and EMPTY stdout (no decision JSON, the Agent call is never blocked)', c.status === 0 && c.stdout === '' && cl.length === 1, JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  t('E3 the run comes from the session pointer', cl[0].run === 'run-at-7' && cl[0].run_source === 'pointer-session', JSON.stringify(cl[0]));
  t('E4 runtime under 5 s (measured ' + ms + ' ms)', ms < 5000);
  const big = '{"session_id":"sess-at-1","hook_event_name":"PreToolUse","tool_name":"Agent","tool_use_id":"toolu_BIG000001","tool_input":{"subagent_type":"test-boss","prompt":"' + 'P'.repeat(400000) + '"}}';
  const cb = cli(cr, big);
  const bl = readLines(logOf(cr));
  t('E5 a cut payload: ids salvaged, truncated:true, no prompt bytes', cb.status === 0 && cb.stdout === '' && bl.length === 2 && bl[1].tool_use_id === 'toolu_BIG000001' && bl[1].subagent_type === 'test-boss' && bl[1].truncated === true && !fs.readFileSync(logOf(cr), 'utf8').includes('PPPP'), JSON.stringify(bl[1]));
  const off = mkRoot();
  t('E6 FORGE_AGENT_TOOL_HOOK=off writes nothing', AT.run(JSON.stringify(pre), { root: off, env: { FORGE_AGENT_TOOL_HOOK: 'off' } }).wrote === false && !fs.existsSync(logOf(off)));

  console.log('\nF) dispatch-fit warning (W2-REVIEWFIX M2b): visible on stderr, never blocks');
  const FIT_PROMPT = 'run the tests with node and write the report file';
  const fitPre = (type) => JSON.stringify(Object.assign({}, pre, { tool_input: { subagent_type: type, prompt: FIT_PROMPT, description: 'd' } }));
  const fs1 = cli(mkRoot(), fitPre('search-boss'));
  t('F1 search-boss + a run/write prompt: exit 0, empty stdout, stderr names the agent, the missing tools and a suggestion',
    fs1.status === 0 && fs1.stdout === '' && /search-boss/.test(fs1.stderr) && /Bash/.test(fs1.stderr) && /Write/.test(fs1.stderr) && /build-boss/.test(fs1.stderr),
    JSON.stringify({ s: fs1.status, o: fs1.stdout, e: fs1.stderr }));
  const fs2 = cli(mkRoot(), fitPre('build-boss'));
  t('F2 build-boss + the same prompt: no warning', fs2.status === 0 && fs2.stdout === '' && !/dispatch-fit/.test(fs2.stderr), JSON.stringify({ s: fs2.status, e: fs2.stderr }));
  const fr = AT.run(fitPre('search-boss'), { root: mkRoot(), env: {} });
  t('F3 run() returns the warning and still records the dispatch', typeof fr.fit_warning === 'string' && /search-boss/.test(fr.fit_warning) && fr.wrote === true, JSON.stringify(fr));
  t('F4 an unknown / built-in agent type gives no warning', !AT.run(fitPre('general-purpose'), { root: mkRoot(), env: {} }).fit_warning);
  t('F5 FORGE_DISPATCH_FIT=off silences the warning', !AT.run(fitPre('search-boss'), { root: mkRoot(), env: { FORGE_DISPATCH_FIT: 'off' } }).fit_warning);
  const nf = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ath-agents-'));
  roots.push(nf);
  fs.writeFileSync(path.join(nf, 'nofm.md'), 'no frontmatter here\n');
  const fw = AT.fitWarning(JSON.parse(fitPre('nofm')), { agentsDirs: [nf], env: {} });
  t('F6 an agent file without frontmatter: the warning says the tools cannot be read', typeof fw === 'string' && /cannot read tools/.test(fw), String(fw));
  let threw = null;
  const malformed = ['{{{', '', '7', 'null', '[]', JSON.stringify({ tool_name: 'Agent', tool_input: 'x' }), JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 5, prompt: { a: 1 } } }),
    JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: '../../etc/passwd', prompt: 'run node' } })];
  for (const m of malformed) { try { AT.run(m, { root: mkRoot(), env: {} }); AT.fitWarning(m, {}); } catch (e) { threw = e; } }
  t('F7 malformed inputs never throw', threw === null, threw && threw.stack);
  const fm = malformed.map((m) => cli(mkRoot(), m));
  t('F8 CLI on malformed inputs: exit 0, empty stdout', fm.every((c) => c.status === 0 && c.stdout === ''), JSON.stringify(fm.map((c) => [c.status, c.stdout, c.stderr])));
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-agent-tool-hook tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
