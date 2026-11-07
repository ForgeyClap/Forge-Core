#!/usr/bin/env node
'use strict';
/**
 * forge-rotator-supervisor.test.cjs - Path A supervisor (R.2+R.3). A FAKE claude (a node script written into a temp
 * dir) plays every scenario; no real claude is ever started and no real account is touched. FORGE_CONFIG_HOME points
 * at a trap BEFORE any module loads; a decoy account vault proves nothing under forge-accounts is opened or changed.
 * The login variable is set to a FAKE sentinel so the fake can prove the child received it unchanged (no switching).
 * Covers: exact argv (incl. --resume <id> and --continue), status file content, marker + text + backoff detection,
 * bounded waits on a fake clock, max attempts / waits / wall clock, auto-resume off, SIGINT (waiting and running),
 * the stop file, env allowlist (Proxy), fs spy, static scan, .cmd shim (Windows), CLI exit codes, schema drift, and
 * mutation checks (unbounded retry and friends) that the tests must catch. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { spawnSync } = require('child_process');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rotsup-'));
process.env.FORGE_CONFIG_HOME = path.join(BASE, 'cfg-home');
delete process.env.FORGE_PROJECT_ROOT;
delete process.env.FORGE_STATE_DIR;
delete process.env.FORGE_ROTATOR_CLAUDE_BIN;
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.FORGE_CONFIG_HOME, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'rotator-auto-resume': { value: true } } }));
const DECOY = path.join(BASE, 'home', '.claude');
fs.mkdirSync(path.join(DECOY, 'forge-accounts'), { recursive: true });
for (const f of ['state.json', 'alpha.json']) fs.writeFileSync(path.join(DECOY, 'forge-accounts', f), '{"fake":true}');
fs.writeFileSync(path.join(DECOY, '.credentials.json'), '{"fake":true}');
const decoySnap = () => ['forge-accounts/state.json', 'forge-accounts/alpha.json', '.credentials.json'].map((f) => { const p = path.join(DECOY, f); return f + ':' + fs.readFileSync(p, 'utf8') + ':' + fs.statSync(p).mtimeMs; }).join('|');
const DECOY0 = decoySnap();
const TOK_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
const TOK_VAL = 'FAKE-SENTINEL-' + Math.random().toString(36).slice(2);
const TOK_PREV = process.env[TOK_VAR];
process.env[TOK_VAR] = TOK_VAL;

const S = require('./forge-rotator-supervisor.cjs');
const H = require('./forge-rotator-hook.cjs');
const SUP = path.join(__dirname, 'forge-rotator-supervisor.cjs');
const HOOK = path.join(__dirname, 'forge-rotator-hook.cjs');
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PROMPT = 'Build the "x" feature 100% \u2014 with care!';
const EXTRA = ['--model', 'sonnet'];

let pass = 0, fail = 0, n = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const FAKE_BIN = path.join(BASE, 'bin', 'fake-claude.cjs');
fs.mkdirSync(path.dirname(FAKE_BIN), { recursive: true });
fs.writeFileSync(FAKE_BIN, `'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const cwd = process.cwd();
const sc = JSON.parse(fs.readFileSync(path.join(cwd, 'scenario.json'), 'utf8'));
const callsFile = path.join(cwd, 'calls.jsonl');
const n = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\\n').filter(Boolean).length : 0;
const step = sc.steps[Math.min(n, sc.steps.length - 1)];
fs.appendFileSync(callsFile, JSON.stringify({ argv: process.argv.slice(2), step, pid: process.pid, tok_same: process.env[sc.tokVar] === sc.tokValue }) + '\\n');
const sid = sc.noSession ? undefined : sc.sid;
const out = (o, code) => { process.stdout.write(JSON.stringify(o)); process.exitCode = code; };
const err = (text) => out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text, session_id: sid }, 1);
if (step === 'ok') out({ type: 'result', subtype: 'success', is_error: false, result: 'done-' + n, session_id: sid }, 0);
else if (step === 'limit') err("You've hit your session limit \\u00b7 resets 3:45pm");
else if (step === 'limit-noreset') err('API Error: Rate limit reached');
else if (step === 'overloaded') err('API Error: Repeated 529 Overloaded errors. The API is at capacity');
else if (step === 'fatal') err("You've hit your monthly spend limit");
else if (step === 'fail') err('Tool exploded');
else if (step === 'notfound') out({ type: 'result', is_error: true, result: 'No conversation found with session ID: ' + sc.sid }, 1);
else if (step === 'garbage') { process.stdout.write('not json'); process.stderr.write('Error: rate limit reached (status 429)'); process.exitCode = 1; }
else if (step === 'limit-marker') {
  spawnSync(process.execPath, [sc.hook], { input: JSON.stringify({ session_id: sc.sid, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached', resets_at: sc.resetEpoch }), env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: cwd }) });
  err('API Error');
} else if (step === 'hang') setInterval(() => {}, 1000);
`);

function mkJob(steps, extra) {
  const r = path.join(BASE, 'job-' + (++n));
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r, 'scenario.json'), JSON.stringify(Object.assign({ steps, sid: SID, tokVar: TOK_VAR, tokValue: TOK_VAL, hook: HOOK }, extra || {})));
  return r;
}
const callsOf = (r) => { const f = path.join(r, 'calls.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const statusFile = (r, job) => path.join(r, '.claude', 'forge-runs', '_rotator', 'supervisor-' + job + '.json');
function clock() { const T0 = Date.now(); let off = 0; const sleeps = []; return { now: () => T0 + off, sleep: async (ms) => { sleeps.push(ms); off += ms; }, sleeps, total: () => sleeps.reduce((a, b) => a + b, 0), T0 }; }
const cfg = (auto, attempts, waits) => ({ safeGet: (k) => ({ value: k === 'rotator-auto-resume' ? auto : k === 'rotator-max-attempts' ? attempts : waits, source: 'test', degraded: false, reason: null }) });
const ALL_CALLS = [];
async function sup(root, o, d) {
  const c = (d && d.clock) || clock();
  const logs = [], outs = [], job = 'j' + (++n);
  const res = await S.supervise(Object.assign({ root, prompt: PROMPT, extraArgs: EXTRA, bin: FAKE_BIN, job }, o), Object.assign({
    now: c.now, sleep: c.sleep, random: () => 0.5, configModule: cfg(true, 8, 6), signals: new EventEmitter(), log: (s) => logs.push(s), out: (s) => outs.push(s), chunkMs: 60000,
  }, d));
  const calls = callsOf(root);
  ALL_CALLS.push(...calls);
  return { res, logs, outs, c, calls, job, st: res.status, file: statusFile(root, job) };
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
const RESUME = (sid) => ['-p', 'continue', '--resume', sid, '--output-format', 'json', ...EXTRA];
const KEYS = ['schema', 'job', 'pid', 'child_pid', 'phase', 'outcome', 'exit_code', 'started_at', 'updated_at', 'finished_at', 'wall_deadline', 'auto_resume', 'attempts', 'max_attempts', 'waits', 'max_waits', 'session_id', 'resume_mode', 'last_class', 'detect_source', 'resume_after', 'resume_after_source', 'wake_at', 'history'];

/** loadMutant(file, pairs) - the source with each [from, to] replaced exactly once, requires made absolute. */
function loadMutant(file, pairs) {
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    const count = src.split(from).length - 1;
    if (count !== 1) throw new Error('mutation target drifted (' + count + ' matches): ' + from.slice(0, 70));
    src = src.replace(from, to);
  }
  src = src.replace(/require\('\.\/([^']+)'\)/g, (_, f) => 'require(' + JSON.stringify(path.join(__dirname, f)) + ')');
  const out = path.join(BASE, 'mut', 'mutant-' + (++n) + '.cjs');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, src);
  lastMutant = out;
  return require(out);
}
let lastMutant = null;
const RES = {
  ok: { code: 0, stdout: JSON.stringify({ is_error: false, result: 'ok', session_id: SID }) },
  'limit-noreset': { code: 1, stdout: JSON.stringify({ is_error: true, result: 'API Error: Rate limit reached', session_id: SID }) },
  fail: { code: 1, stdout: JSON.stringify({ is_error: true, result: 'Tool exploded', session_id: SID }) },
};
async function runFake(mod, steps, o, cv) {
  const calls = [];
  const spawnRun = async (bin, args) => { calls.push(args); if (calls.length > 60) throw new Error('UNBOUNDED'); return Object.assign({ stderr: '', aborted: false, pid: 1 }, RES[steps[Math.min(calls.length - 1, steps.length - 1)]]); };
  const c = clock();
  const root = (o && o.root) || mkJob(['ok']);
  let res = null, err = null;
  try {
    res = await mod.supervise(Object.assign({ root, prompt: 'p', bin: 'C:\\fake\\claude.exe', job: 'm' + (++n) }, o), { spawnRun, now: c.now, sleep: c.sleep, random: () => 0.5, configModule: cfg(...(cv || [true, 8, 6])), signals: new EventEmitter(), log: () => {}, out: () => {}, chunkMs: 60000 });
  } catch (e) { err = e; }
  return { res, err, calls, c };
}

(async () => {
  let hangPid = null;
  try {
    console.log('\nA) completion, resume, detection');
    const a = await sup(mkJob(['ok']));
    t('A1 success first try: completed, exit 0, one launch', a.res.outcome === 'completed' && a.res.exitCode === 0 && a.calls.length === 1, JSON.stringify(a.res.outcome));
    t('A2 exact argv: -p <prompt> --output-format json <owner args>', eq(a.calls[0].argv, ['-p', PROMPT, '--output-format', 'json', ...EXTRA]), JSON.stringify(a.calls[0].argv));
    t('A3 the final JSON result is handed through to stdout', a.outs.length === 1 && JSON.parse(a.outs[0]).result === 'done-0');
    const sd = fs.readFileSync(a.file, 'utf8'); const s1 = JSON.parse(sd);
    t('A4 status file: exact key set and final values', eq(Object.keys(s1), KEYS) && s1.schema === S.STATUS_SCHEMA && s1.phase === 'done' && s1.outcome === 'completed' && s1.exit_code === 0
      && s1.attempts === 1 && s1.waits === 0 && s1.session_id === SID && s1.auto_resume === true && s1.history.length === 1 && s1.history[0].class === 'success' && s1.child_pid === null, sd);
    t('A5 status file holds no prompt, no owner args, no token, no output', !sd.includes('feature') && !sd.includes('sonnet') && !sd.includes(TOK_VAL) && !sd.includes('done-0'), sd);

    const b = await sup(mkJob(['limit', 'ok']));
    const sb = b.st;
    t('A6 limit (text, "resets 3:45pm") then success on --resume: completed after 2 launches', b.res.outcome === 'completed' && b.calls.length === 2 && sb.attempts === 2 && sb.waits === 1, JSON.stringify(sb));
    t('A7 relaunch argv is exactly -p continue --resume <session_id> --output-format json <owner args>', eq(b.calls[1].argv, RESUME(SID)), JSON.stringify(b.calls[1].argv));
    const ra = Date.parse(sb.resume_after);
    t('A8 waited until the reset + 90 s margin (fake clock), in chunks <= 60 s', sb.resume_after_source === 'result-text' && new Date(ra).getHours() === 15 && new Date(ra).getMinutes() === 45
      && b.c.now() >= ra + S.MARGIN_MS && b.c.now() - (ra + S.MARGIN_MS) < 60000 && b.c.sleeps.every((ms) => ms > 0 && ms <= 60000), JSON.stringify({ ra: sb.resume_after, end: new Date(b.c.now()).toISOString() }));
    t('A9 history records the limit (text) and the success', eq(sb.history.map((h) => [h.class, h.source, h.mode]), [['rate_limit', 'text', 'fresh'], ['success', null, 'resume']]), JSON.stringify(sb.history));

    const resetEpoch = Math.floor((Date.now() + 2 * 3600e3) / 1000);
    const rm = mkJob(['limit-marker', 'ok'], { resetEpoch });
    const m = await sup(rm);
    t('A10 StopFailure marker (real hook subprocess) is the detection source and gives resume_after', m.res.outcome === 'completed' && m.st.history[0].source === 'marker'
      && m.st.resume_after_source === 'marker' && m.st.resume_after === new Date(resetEpoch * 1000).toISOString() && eq(m.calls[1].argv, RESUME(SID)), JSON.stringify(m.st));
    const md = fs.readFileSync(H.markerPath(rm, {}), 'utf8');
    t('A11 the marker on disk is token- and text-free', !md.includes('Rate limit reached') && !md.includes('429') && !md.includes(TOK_VAL), md);

    const u = await sup(mkJob(['limit-noreset', 'ok']));
    t('A12 unknown reset: one bounded backoff of exactly 15 min x 1.05 (jitter 0.5 -> +5%)', u.res.outcome === 'completed' && u.c.total() === 945000 && u.st.resume_after === null && u.st.resume_after_source === 'backoff', String(u.c.total()));
    const ov = await sup(mkJob(['overloaded', 'overloaded', 'ok']));
    t('A13 overloaded: short growing backoff 63 s then 126 s', ov.res.outcome === 'completed' && eq(ov.c.sleeps, [60000, 3000, 60000, 60000, 6000]) && ov.c.total() === 189000, JSON.stringify(ov.c.sleeps));
    const nf = await sup(mkJob(['limit-noreset', 'notfound', 'ok']));
    t('A14 --resume says "no conversation found" -> exactly one --continue fallback', nf.res.outcome === 'completed' && nf.calls.length === 3 && eq(nf.calls[1].argv, RESUME(SID))
      && eq(nf.calls[2].argv, ['-p', 'continue', '--continue', '--output-format', 'json', ...EXTRA]), JSON.stringify(nf.calls.map((c) => c.argv)));
    const ns = await sup(mkJob(['limit-noreset', 'ok'], { noSession: true }));
    t('A15 no session id in the result -> relaunch with --continue', ns.res.outcome === 'completed' && eq(ns.calls[1].argv, ['-p', 'continue', '--continue', '--output-format', 'json', ...EXTRA]) && ns.st.session_id === null, JSON.stringify(ns.calls.map((c) => c.argv)));
    const g = await sup(mkJob(['garbage', 'ok']));
    t('A16 unparseable stdout + "rate limit ... 429" on stderr -> limit by text, --continue relaunch', g.res.outcome === 'completed' && g.st.history[0].class === 'rate_limit' && g.calls[1].argv.includes('--continue'));
    const fa = await sup(mkJob(['fatal']));
    t('A17 a spend limit is not waited out: failed, exit 1, no sleep', fa.res.outcome === 'failed' && fa.res.exitCode === 1 && fa.c.sleeps.length === 0 && fa.st.last_class === 'fatal');
    const ff = await sup(mkJob(['fail', 'ok']));
    t('A18 an ordinary failure is not retried', ff.res.outcome === 'failed' && ff.calls.length === 1);
    const rf = mkJob(['fail']);
    H.run(JSON.stringify({ session_id: 'other-session-1', hook_event_name: 'StopFailure', error: 'rate_limit' }), { root: rf, configModule: cfg(true), env: {} });
    const fm = await sup(rf);
    const rs = mkJob(['fail']);
    H.run(JSON.stringify({ session_id: SID, hook_event_name: 'StopFailure', error: 'rate_limit' }), { root: rs, configModule: cfg(true), env: {}, now: Date.now() - 60000 });
    const sm = await sup(rs);
    t('A19 a marker of ANOTHER session, or a stale one of ours, is ignored', fm.res.outcome === 'failed' && fm.calls.length === 1 && sm.res.outcome === 'failed' && sm.calls.length === 1);

    console.log('\nB) bounds and the owner switch');
    const ma = await sup(mkJob(['limit-noreset']), {}, { configModule: cfg(true, 3, 24) });
    t('B1 max attempts 3: exactly 3 launches, then gave-up:max-attempts (exit 4)', ma.res.outcome === 'gave-up:max-attempts' && ma.res.exitCode === 4 && ma.calls.length === 3 && ma.st.waits === 2
      && eq(ma.calls[2].argv, RESUME(SID)) && ma.c.total() === 2 * 945000, JSON.stringify({ o: ma.res.outcome, c: ma.calls.length, w: ma.st.waits }));
    const mw = await sup(mkJob(['limit-noreset']), {}, { configModule: cfg(true, 30, 2) });
    t('B2 max waits 2: 3 launches, gave-up:max-waits', mw.res.outcome === 'gave-up:max-waits' && mw.calls.length === 3 && mw.st.waits === 2);
    const wc = await sup(mkJob(['limit-noreset']), { maxWallMs: 20 * 60e3 }, { configModule: cfg(true, 30, 24) });
    t('B3 wall-clock cap 20 min: one 15.75 min wait, then gave-up:wall-clock; slept <= cap', wc.res.outcome === 'gave-up:wall-clock' && wc.calls.length === 2 && wc.c.total() === 945000);
    const wk = await sup(mkJob(['limit']), { maxWallMs: 60e3 });
    t('B4 a known reset past the cap: no sleep at all, resume_after kept for the owner', wk.res.outcome === 'gave-up:wall-clock' && wk.c.sleeps.length === 0 && wk.st.resume_after !== null && wk.st.wake_at !== null);
    const off = await sup(mkJob(['limit', 'ok']), {}, { configModule: cfg(false, 8, 6) });
    t('B5 rotator-auto-resume off: stop at the limit (exit 4), no wait, manual --resume command logged', off.res.outcome === 'limit-hit:auto-resume-off' && off.res.exitCode === 4 && off.calls.length === 1
      && off.c.sleeps.length === 0 && off.logs.some((l) => l.includes('--resume ' + SID)) && off.st.auto_resume === false, off.logs.join(' | '));
    const real = await sup(mkJob(['limit-noreset']), {}, { configModule: undefined });
    t('B6 real forge-config (trap global file: auto-resume on, schema defaults 8 attempts / 6 waits)', real.st.auto_resume === true && real.st.max_attempts === 8 && real.st.max_waits === 6 && real.res.outcome === 'gave-up:max-waits' && real.calls.length === 7, JSON.stringify({ o: real.res.outcome, c: real.calls.length }));

    console.log('\nC) SIGINT and stop');
    const sigs = new EventEmitter(); let during = -1;
    const c1 = clock();
    const iw = await sup(mkJob(['limit-noreset', 'ok']), {}, { signals: sigs, clock: c1, sleep: async (ms) => { during = sigs.listenerCount('SIGINT'); sigs.emit('SIGINT'); await c1.sleep(ms); } });
    t('C1 SIGINT while waiting: interrupted, exit 130, no relaunch', iw.res.outcome === 'interrupted' && iw.res.exitCode === 130 && iw.calls.length === 1, JSON.stringify(iw.res.outcome));
    t('C2 signal handlers were installed and are removed afterwards', during === 1 && sigs.listenerCount('SIGINT') === 0 && sigs.listenerCount('SIGTERM') === 0);
    const rh = mkJob(['hang']); const sh = new EventEmitter();
    const pr = sup(rh, {}, { signals: sh, graceMs: 300 });
    const started = await waitFor(() => callsOf(rh).length === 1, 10000);
    hangPid = started ? callsOf(rh)[0].pid : null;
    const midStatus = (() => { try { const d = path.join(rh, '.claude', 'forge-runs', '_rotator'); return readJson(path.join(d, fs.readdirSync(d).find((x) => x.endsWith('.json')))); } catch { return null; } })();
    sh.emit('SIGINT');
    const ih = await Promise.race([pr, new Promise((r) => setTimeout(() => r(null), 20000))]);
    const gone = hangPid ? await waitFor(() => !isAlive(hangPid), 5000) : false;
    t('C3 SIGINT while claude runs: the child is ended by its exact PID, outcome interrupted, exit 130', ih && ih.res.outcome === 'interrupted' && ih.res.exitCode === 130 && ih.calls.length === 1 && gone, JSON.stringify(ih && ih.res));
    t('C4 the status file showed the running child PID', midStatus && midStatus.phase === 'running' && midStatus.child_pid === hangPid, JSON.stringify(midStatus));
    const rj = mkJob(['limit-noreset', 'ok']); const c2 = clock(); let jobId = null;
    const stp = await sup(rj, { job: 'stopme' }, { clock: c2, sleep: async (ms) => { if (!jobId) { jobId = 'stopme'; await S.main(['stop', '--job', 'stopme', '--root', rj], { log: () => {} }); } await c2.sleep(ms); } });
    t('C5 `stop --job` during a wait: outcome stopped, exit 130, no relaunch', stp.res.outcome === 'stopped' && stp.res.exitCode === 130 && stp.calls.length === 1);

    console.log('\nD) no token, no account files, allowlisted env only');
    const seen = []; let enumerated = false;
    const target = { PATH: process.env.PATH, [TOK_VAR]: TOK_VAL, ANTHROPIC_API_KEY: 'FAKE', FORGE_ROTATOR_CLAUDE_BIN: FAKE_BIN };
    const envProxy = new Proxy(target, { get: (o, k) => { seen.push(String(k)); return o[k]; }, has: (o, k) => { seen.push(String(k)); return k in o; }, ownKeys: (o) => { enumerated = true; return Reflect.ownKeys(o); }, getOwnPropertyDescriptor: (o, k) => { enumerated = true; return Reflect.getOwnPropertyDescriptor(o, k); } });
    const ep = await sup(mkJob(['limit-noreset', 'ok']), { bin: undefined }, { env: envProxy });
    t('D1 env read only through the allowlist; never enumerated; no *TOKEN* name read', ep.res.outcome === 'completed' && !enumerated && seen.includes('FORGE_ROTATOR_CLAUDE_BIN') && seen.every((k) => S.ENV_NAMES.includes(k)) && !seen.some((k) => /TOKEN/i.test(k)), JSON.stringify(seen));
    const ops = [];
    const names = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'readFileSync', 'statSync', 'existsSync', 'readdirSync', 'openSync'];
    const orig = {};
    for (const k of names) { orig[k] = fs[k]; fs[k] = function (p, ...rest) { ops.push([k, String(p)]); return orig[k].call(fs, p, ...rest); }; }
    const rsp = mkJob(['limit', 'ok']);
    let spy;
    try { spy = await sup(rsp, {}, { configModule: undefined }); } finally { for (const k of names) fs[k] = orig[k]; }
    const writes = ops.filter(([k]) => /write|append|rename|mkdir|rm|unlink/i.test(k)).map(([, p]) => path.resolve(p));
    t('D2 fs spy: nothing under forge-accounts, no .credentials.json, no .claude.json touched', spy.res.outcome === 'completed' && ops.length > 0 && !ops.some(([, p]) => /forge-accounts|\.credentials|\.claude\.json$/i.test(p)), JSON.stringify(ops.filter(([, p]) => /accounts|credentials/i.test(p))));
    t('D3 every write stays inside the job root (project isolation)', writes.length > 0 && writes.every((p) => p.startsWith(path.resolve(rsp) + path.sep)), JSON.stringify(writes.filter((p) => !p.startsWith(path.resolve(rsp)))));
    t('D4 every launch received the login variable UNCHANGED (inherited, never set or switched)', ALL_CALLS.length > 20 && ALL_CALLS.every((c) => c.tok_same === true), String(ALL_CALLS.filter((c) => !c.tok_same).length));
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
    const code = [SUP, HOOK].map((f) => strip(fs.readFileSync(f, 'utf8'))).join('\n');
    t('D5 static: the code (comments stripped) never names a login variable, the vault or a credentials file', !/TOKEN|OAUTH/.test(code) && !/forge-accounts|\.credentials|account-rotator/.test(code));
    const rc = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(SUP) + ');console.log(JSON.stringify(Object.keys(require.cache)))'], { encoding: 'utf8' });
    t('D6 loading the supervisor loads no account-rotator module', rc.status === 0 && !JSON.parse(rc.stdout).some((k) => /account-rotator/.test(k)), rc.stdout.slice(0, 300));

    console.log('\nE) argument safety, Windows spawn, CLI');
    t('E1 exe: argv passed as-is', eq(S.launchPlan('C:\\x\\claude.exe', ['-p', 'a b'], 'win32'), { cmd: 'C:\\x\\claude.exe', argv: ['-p', 'a b'], verbatim: false }));
    t('E2 .cmd: cmd.exe /d /v:off /s /c with every word quoted, verbatim', eq(S.launchPlan('C:\\x\\claude.cmd', ['-p', 'hello world'], 'win32', 'C:\\W\\cmd.exe'), { cmd: 'C:\\W\\cmd.exe', argv: ['/d', '/v:off', '/s', '/c', '""C:\\x\\claude.cmd" "-p" "hello world""'], verbatim: true }));
    t('E3 .cmd refuses % ! " newline and a trailing backslash; .ps1 and NUL refused', ['100%', 'x!', 'a"b', 'a\nb', 'trail\\'].every((w) => S.launchPlan('C:\\x\\claude.cmd', ['-p', w], 'win32').refused)
      && S.launchPlan('C:\\x\\claude.ps1', [], 'win32').refused && S.launchPlan('C:\\x\\claude.exe', ['a\0'], 'win32').refused && S.launchPlan('/x/claude.cmd', ['100%'], 'linux').argv);
    const parityFile = path.join(BASE, 'parity.cjs');
    fs.writeFileSync(parityFile, [
      'const T = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-token.cjs')) + ');',
      'const S = require(' + JSON.stringify(SUP) + ');',
      "const V = [['a', 'b'], ['100%'], ['x!'], ['say \"hi\"'], ['l\\nb'], ['t\\\\'], ['ok words', '--model', 'sonnet']];",
      "const B = ['C:\\\\a\\\\claude.ps1', 'C:\\\\a\\\\claude.exe', '', 'a\\nb'];",
      "const W = 'C:\\\\x\\\\claude.cmd';",
      "console.log(JSON.stringify({ v: V.map((v) => [T.cmdArgsUnsafe(v) === null, S.cmdArgsUnsafe(v) === null, JSON.stringify(T.cmdWrapperArgv(W, v).argv || null) === JSON.stringify(S.launchPlan(W, v, 'win32').argv || null)]), b: B.map((b) => [T.binUnsafe(b) === null, S.binUnsafe(b) === null]) }));",
    ].join('\n'));
    const par = spawnSync(process.execPath, [parityFile], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_ACCOUNT_ROTATOR_HOME: DECOY, FORGE_USAGE_GUARD_HOME: DECOY }) });
    let pj = null; try { pj = JSON.parse(par.stdout); } catch { pj = null; }
    t('E4 the copied argument rules match account-rotator-token.cjs (decoy home)', pj && pj.v.every(([x, y, w]) => x === y && w) && pj.b.every(([x, y]) => x === y), par.stdout + par.stderr);
    t('E5 validateJob refuses a "-" prompt, reserved flags and flag clusters; allows ordinary flags', [
      { prompt: '-x', extraArgs: [], continuePrompt: 'continue' }, { prompt: 'p', extraArgs: ['--resume', 'x'], continuePrompt: 'continue' },
      { prompt: 'p', extraArgs: ['--output-format=json'], continuePrompt: 'continue' }, { prompt: 'p', extraArgs: ['-pc'], continuePrompt: 'continue' }, { prompt: '', extraArgs: [], continuePrompt: 'continue' },
    ].every((j) => S.validateJob(j)) && S.validateJob({ prompt: 'p', extraArgs: ['-v', '--model', 'opus', '--permission-mode', 'acceptEdits'], continuePrompt: 'continue' }) === null);
    if (process.platform === 'win32') {
      const shim = path.join(BASE, 'bin', 'claude.cmd');
      fs.writeFileSync(shim, '@"' + process.execPath + '" "' + FAKE_BIN + '" %*\r\n');
      const sc = await sup(mkJob(['ok']), { bin: shim, prompt: 'hello world' });
      t('E6 a real claude.cmd shim on Windows: the child gets the exact argv', sc.res.outcome === 'completed' && eq(sc.calls[0].argv, ['-p', 'hello world', '--output-format', 'json', ...EXTRA]), JSON.stringify(sc.calls[0] && sc.calls[0].argv));
      const su = await sup(mkJob(['ok']), { bin: shim, prompt: 'it is 100% done' });
      t('E7 an unsafe word through the shim is refused (exit 3) and nothing is started', su.res.outcome === 'refused' && su.res.exitCode === 3 && su.calls.length === 0);
    } else console.log('  skip E6/E7 (.cmd shim checks run on Windows only)');
    const cli = (args, extra) => spawnSync(process.execPath, [SUP, ...args], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, extra || {}) });
    const usage = [[], ['run'], ['run', '--max-attempts', '0', '--', 'p'], ['run', '--max-attempts', '31', '--', 'p'], ['run', '--max-hours', '0', '--', 'p'], ['run', '--bogus', '--', 'p'], ['run', '--', '-x'], ['run', '--', 'p', '--resume', 'x'], ['frobnicate']];
    const codes = usage.map((u) => cli(u).status);
    t('E8 CLI usage errors exit 2', codes.every((c) => c === 2), JSON.stringify(codes));
    t('E9 --help exits 0', cli(['--help']).status === 0);
    const rcl = mkJob(['ok']);
    const r1 = cli(['run', '--root', rcl, '--claude', FAKE_BIN, '--job', 'cliA', '--', 'hello world', '--model', 'sonnet']);
    let out1 = null; try { out1 = JSON.parse(r1.stdout); } catch { out1 = null; }
    t('E10 real CLI end-to-end: exit 0, stdout is the JSON result, nothing secret on stderr', r1.status === 0 && out1 && out1.session_id === SID && !r1.stderr.includes(TOK_VAL) && callsOf(rcl)[0].tok_same === true, r1.stderr);
    const r2 = cli(['status', '--root', rcl, '--job', 'cliA']);
    let st2 = null; try { st2 = JSON.parse(r2.stdout); } catch { st2 = null; }
    t('E11 `status` prints the job status', r2.status === 0 && Array.isArray(st2) && st2.length === 1 && st2[0].outcome === 'completed' && st2[0].job === 'cliA');
    t('E12 a .ps1 launcher is refused with exit 3', cli(['run', '--root', mkJob(['ok']), '--claude', 'C:\\x\\claude.ps1', '--', 'hi']).status === 3);
    const r3 = cli(['stop', '--root', rcl, '--job', 'cliB']);
    t('E13 `stop --job` writes the stop request', r3.status === 0 && fs.existsSync(path.join(rcl, '.claude', 'forge-runs', '_rotator', 'supervisor-cliB.stop')));

    console.log('\nF) schema drift');
    const SCH = readJson(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json')).settings;
    t('F1 rotator-auto-resume is a bool, default OFF, consumed by both tools', SCH['rotator-auto-resume'].type === 'bool' && SCH['rotator-auto-resume'].default === false && SCH['rotator-auto-resume'].consumers.some((c) => c.includes('forge-rotator-supervisor.cjs')) && SCH['rotator-auto-resume'].consumers.some((c) => c.includes('forge-rotator-hook.cjs')));
    t('F2 max-attempts / max-waits min, max and default equal the supervisor constants', eq([SCH['rotator-max-attempts'].min, SCH['rotator-max-attempts'].max, SCH['rotator-max-attempts'].default], [...S.LIMITS.attempts, S.DEFAULTS.maxAttempts])
      && eq([SCH['rotator-max-waits'].min, SCH['rotator-max-waits'].max, SCH['rotator-max-waits'].default], [...S.LIMITS.waits, S.DEFAULTS.maxWaits]));

    console.log('\nG) mutation checks (each mutant must FAIL the behaviour check the original passes)');
    const checks = {
      attempts: async (mod) => { const r = await runFake(mod, ['limit-noreset'], {}, [true, 3, 24]); return !r.err && r.calls.length === 3 && r.res.outcome === 'gave-up:max-attempts'; },
      waits: async (mod) => { const r = await runFake(mod, ['limit-noreset'], {}, [true, 30, 2]); return !r.err && r.calls.length === 3 && r.res.outcome === 'gave-up:max-waits'; },
      wall: async (mod) => { const r = await runFake(mod, ['limit-noreset'], { maxWallMs: 20 * 60e3 }, [true, 30, 24]); return !r.err && r.calls.length === 2 && r.res.outcome === 'gave-up:wall-clock'; },
      bounded: async (mod) => { const r = await runFake(mod, ['limit-noreset'], { maxWallMs: 1000 * 3600e3 }, [true, 30, 24]); return !r.err && r.calls.length <= 30; },
      resumeArgv: async (mod) => { const r = await runFake(mod, ['limit-noreset', 'ok']); return !r.err && eq(r.calls[1], ['-p', 'continue', '--resume', SID, '--output-format', 'json']); },
      jitter: async (mod) => { const r = await runFake(mod, ['limit-noreset', 'ok']); return !r.err && r.c.total() === 945000; },
      foreignMarker: async (mod) => { const root = mkJob(['ok']); H.run(JSON.stringify({ session_id: 'other-session-2', hook_event_name: 'StopFailure', error: 'rate_limit' }), { root, configModule: cfg(true), env: {} }); const r = await runFake(mod, ['fail'], { root }); return !r.err && r.res.outcome === 'failed' && r.calls.length === 1; },
      tokenUnchanged: async (mod) => { const root = mkJob(['ok']); const r = await mod.supervise({ root, prompt: 'p', bin: FAKE_BIN, job: 'tk' + (++n) }, { configModule: cfg(true, 8, 6), signals: new EventEmitter(), log: () => {}, out: () => {} }); return r.outcome === 'completed' && callsOf(root).every((c) => c.tok_same === true); },
    };
    const G = "    if (attempt >= S.maxAttempts) return finish('gave-up:max-attempts', EXIT.gaveUp);\n    if (waits >= S.maxWaits)";
    const mutants = [
      ['unbounded attempts (max-attempts guard removed)', 'attempts', [[G, '    if (waits >= S.maxWaits)']]],
      ['max-waits guard removed', 'waits', [["    if (waits >= S.maxWaits) return finish('gave-up:max-waits', EXIT.gaveUp);\n", '']]],
      ['wall-clock guard removed', 'wall', [['    if (wakeAt > deadline) {', '    if (false) {']]],
      ['UNBOUNDED RETRY (all three guards removed)', 'bounded', [[G, '    if (waits >= S.maxWaits)'], ["    if (waits >= S.maxWaits) return finish('gave-up:max-waits', EXIT.gaveUp);\n", ''], ['    if (wakeAt > deadline) {', '    if (false) {']]],
      ['relaunch without --resume <id>', 'resumeArgv', [["'--resume', sessionId, '--output-format'", "'--continue', '--output-format'"]]],
      ['unbounded jitter', 'jitter', [['base * (1 + JITTER * j)', 'base * (1 + JITTER * j * 40)']]],
      ['marker accepted for any session', 'foreignMarker', [['mk && sid && mk.session_id === sid && mk.ts', 'mk && mk.ts']]],
      ['child env gets a switched login variable', 'tokenUnchanged', [["{ cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'],", "{ cwd: o.cwd, env: Object.assign({}, process.env, { " + TOK_VAR + ": 'SWITCHED' }), stdio: ['ignore', 'pipe', 'pipe'],"]]],
    ];
    for (const [name, check, pairs] of mutants) {
      const okOrig = await checks[check](S);
      let mod = null, okMut = true, why = '';
      try { mod = loadMutant(SUP, pairs); } catch (e) { why = 'mutant did not load (target drifted or syntax): ' + e.message; }
      if (mod) { try { okMut = await checks[check](mod); } catch (e) { okMut = false; why = 'check threw: ' + e.message; } }
      t('G ' + name + ': original passes, mutant caught', okOrig === true && mod !== null && okMut === false, JSON.stringify({ okOrig, loaded: !!mod, okMut, why }));
    }
    t('G the static scan (D5) also flags the switched-login-variable mutant', /TOKEN/.test(strip(fs.readFileSync(lastMutant, 'utf8'))));
    t('H the decoy account vault and credentials file are byte- and mtime-identical', decoySnap() === DECOY0);
  } catch (e) {
    fail++;
    console.log('  FAIL uncaught: ' + (e && e.stack ? e.stack : e));
  } finally {
    if (hangPid && isAlive(hangPid)) { try { process.kill(hangPid); } catch { /* gone */ } }
    if (TOK_PREV === undefined) delete process.env[TOK_VAR]; else process.env[TOK_VAR] = TOK_PREV;
    try { if (BASE.startsWith(os.tmpdir())) fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
