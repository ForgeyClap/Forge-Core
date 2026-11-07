#!/usr/bin/env node
'use strict';
/**
 * forge-rotator-hook.test.cjs - the Path A StopFailure hook (R.2+R.3). Throwaway roots only (os.mkdtemp, removed at
 * the end); FORGE_CONFIG_HOME points at a trap dir BEFORE any module loads, so the owner's real FORGE_CONFIG.json is
 * never read. Payloads follow the documented StopFailure shape (hooks reference): common fields + error,
 * error_details, last_assistant_message. Covers reset-time parsing, the token-free marker on disk (canaries hunted in
 * the file), every gate, the real CLI (exit 0, empty stdout, runtime), the settings fragment, and mutation checks
 * proving the tests catch a marker that leaks text, a missing config gate and a missing error allowlist.
 * Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rothook-'));
process.env.FORGE_CONFIG_HOME = path.join(BASE, 'cfg-home');
delete process.env.FORGE_PROJECT_ROOT;
delete process.env.FORGE_STATE_DIR;
fs.mkdirSync(process.env.FORGE_CONFIG_HOME, { recursive: true });

const H = require('./forge-rotator-hook.cjs');
const SCRIPT = path.join(__dirname, 'forge-rotator-hook.cjs');
const FRAGMENT = path.join(__dirname, '..', 'config', 'orchestration', 'rotator-hooks.fragment.json');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')); }
};
let n = 0;
const mkRoot = (withClaude = true) => { const r = path.join(BASE, 'root-' + (++n)); fs.mkdirSync(withClaude ? path.join(r, '.claude') : r, { recursive: true }); return r; };
const ON = { safeGet: () => ({ value: true, source: 'test', degraded: false, reason: null }) };
const OFF = { safeGet: () => ({ value: false, source: 'test', degraded: false, reason: null }) };
const SK = 'sk' + '-ant-' + 'oat01-' + 'CANARYHOOK0123456789abcdefABCDEF';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const payload = (over) => Object.assign({
  session_id: SID, transcript_path: 'C:/Users/x/.claude/projects/p/' + SID + '.jsonl', cwd: 'C:/Users/x/secret-project',
  hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests ' + SK,
  last_assistant_message: "API Error: You've hit your session limit · resets 3:45pm MESSAGE-CANARY",
}, over || {});
const markerFile = (root) => path.join(root, '.claude', 'forge-runs', '_rotator', 'pending-resume.json');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** loadMutant(from, to) - this hook's source with ONE exact replacement, requires made absolute. */
function loadMutant(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  const count = src.split(from).length - 1;
  if (count !== 1) throw new Error('mutation target drifted (' + count + ' matches): ' + from.slice(0, 60));
  const mutated = src.replace(from, to).replace(/require\('\.\/([^']+)'\)/g, (_, f) => 'require(' + JSON.stringify(path.join(__dirname, f)) + ')');
  const out = path.join(BASE, 'mutant-' + (++n) + '.cjs');
  fs.writeFileSync(out, mutated);
  return require(out);
}

try {
  console.log('\nA) reset-time parsing (pure)');
  const r1 = H.parseResetText("You've hit your session limit · resets 3:45pm", NOW);
  t('A1 "resets 3:45pm" -> the next local 15:45, within 24 h', r1 > NOW && r1 - NOW <= 24 * 3600e3 && new Date(r1).getHours() === 15 && new Date(r1).getMinutes() === 45, r1 && new Date(r1).toString());
  const r2 = H.parseResetText("You've hit your weekly limit · resets Mon 12:00am", NOW);
  t('A2 "resets Mon 12:00am" -> a local Monday 00:00 within 8 days', r2 > NOW && r2 - NOW <= 8 * 24 * 3600e3 && new Date(r2).getDay() === 1 && new Date(r2).getHours() === 0, r2 && new Date(r2).toString());
  t('A3 "resets 3pm (UTC)" -> exactly the next 15:00Z', H.parseResetText('limit · resets 3pm (UTC)', NOW) === Date.parse('2026-10-24T15:00:00Z'));
  t('A4 a named zone across the EU DST switch: Mon 9:00am Europe/Amsterdam = 08:00Z', H.parseResetText('resets Mon 9:00am (Europe/Amsterdam)', NOW) === Date.parse('2026-10-26T08:00:00Z'));
  const ep = Math.floor((NOW + 3600e3) / 1000);
  t('A5 older "|<epoch>" form: future accepted, past refused', H.parseResetText('Claude AI usage limit reached|' + ep, NOW) === ep * 1000 && H.parseResetText('Claude AI usage limit reached|' + (ep - 7200), NOW) === null);
  t('A6 "resets <ISO>" accepted', H.parseResetText('resets at 2026-10-24T18:00:00Z', NOW) === Date.parse('2026-10-24T18:00:00Z'));
  t('A7 junk refused: bare hour, 13pm, :75, >8 days, no reset word', [
    'resets 5', 'resets 13pm', 'resets 3:75pm', 'resets at 2026-11-20T00:00:00Z', 'try again at 3pm', '', null,
  ].every((s) => H.parseResetText(s, NOW) === null));
  const f1 = H.findResumeAfter({ resets_at: ep }, NOW);
  const f2 = H.findResumeAfter({ retry_after: 120 }, NOW);
  const f3 = H.findResumeAfter({ error_details: { reset_at: '2026-10-24T12:00:00Z' } }, NOW);
  const f4 = H.findResumeAfter({ error_details: 'resets 3pm (UTC)' }, NOW);
  const f5 = H.findResumeAfter({ resets_at: ep, last_assistant_message: 'resets 3pm (UTC)' }, NOW);
  t('A8 findResumeAfter: epoch field, relative retry_after, nested ISO, text; a field beats text', f1.at === ep * 1000 && f1.source === 'payload-field'
    && f2.at === NOW + 120000 && f3.at === Date.parse('2026-10-24T12:00:00Z') && f4.at === Date.parse('2026-10-24T15:00:00Z') && f4.source === 'message-text'
    && f5.at === ep * 1000 && f5.source === 'payload-field', JSON.stringify([f1, f2, f3, f4, f5]));

  console.log('\nB) run(): the token-free marker');
  const root = mkRoot();
  const rr = H.run(JSON.stringify(payload()), { root, configModule: ON, env: {}, now: NOW });
  t('B1 a rate_limit payload writes the marker', rr.ok && rr.wrote && rr.path === markerFile(root) && fs.existsSync(markerFile(root)), JSON.stringify(rr));
  const disk = fs.readFileSync(markerFile(root), 'utf8');
  const M = JSON.parse(disk);
  t('B2 exact key set', JSON.stringify(Object.keys(M).sort()) === JSON.stringify(['error_details_type', 'event', 'matcher', 'payload_fields', 'resume_after', 'resume_after_source', 'schema', 'session_id', 'ts'].sort()), Object.keys(M).join(','));
  t('B3 values: schema, ts, session, matcher, resume_after from the message text', M.schema === H.MARKER_SCHEMA && M.ts === new Date(NOW).toISOString() && M.session_id === SID
    && M.matcher === 'rate_limit' && M.resume_after_source === 'message-text' && new Date(M.resume_after).getHours() === 15 && M.error_details_type === 'string', disk);
  t('B4 payload_fields = the raw top-level NAMES, sorted', JSON.stringify(M.payload_fields) === JSON.stringify(Object.keys(payload()).sort()), JSON.stringify(M.payload_fields));
  t('B5 no content on disk: no token canary, no message text, no paths', !disk.includes('CANARYHOOK') && !disk.includes('MESSAGE-CANARY') && !disk.includes('session limit')
    && !disk.includes('429') && !disk.includes('secret-project') && !disk.includes('.jsonl') && !disk.includes('Users'), disk);
  t('B6 no tmp file left next to the marker', fs.readdirSync(path.dirname(markerFile(root))).join(',') === 'pending-resume.json');
  const ro = mkRoot();
  H.run(JSON.stringify(payload({ error: 'overloaded', error_details: undefined, last_assistant_message: 'API Error: Repeated 529 Overloaded errors' })), { root: ro, configModule: ON, env: {}, now: NOW });
  const MO = readJson(markerFile(ro));
  t('B7 overloaded -> matcher overloaded, resume_after null, error_details absent', MO.matcher === 'overloaded' && MO.resume_after === null && MO.resume_after_source === null && MO.error_details_type === 'absent', JSON.stringify(MO));
  const skip = (p, o, why) => { const r = mkRoot(o && o.noClaude === true ? false : true); const res = H.run(typeof p === 'string' ? p : JSON.stringify(p), Object.assign({ root: r, configModule: ON, env: {}, now: NOW }, o)); return { res, none: !fs.existsSync(markerFile(r)), why }; };
  const cases = [
    skip(payload({ error: 'authentication_failed' }), {}, 'other error class'),
    skip(payload({ error: undefined }), {}, 'missing error field'),
    skip(payload({ hook_event_name: 'Stop' }), {}, 'not StopFailure'),
    skip('not json', {}, 'garbage'),
    skip(payload(), { configModule: OFF }, 'rotator-auto-resume off'),
    skip(payload(), { configModule: null }, 'forge-config absent -> built-in default off'),
    skip(payload(), { env: { FORGE_ROTATOR_HOOK: 'off' } }, 'FORGE_ROTATOR_HOOK=off'),
    skip(payload(), { noClaude: true }, 'no .claude folder'),
  ];
  for (const c of cases) t('B8 no marker when: ' + c.why, c.none && c.res.wrote === false && c.res.ok === true, JSON.stringify(c.res));
  const rl = mkRoot();
  fs.writeFileSync(path.join(rl, '.claude', '.forge-sync.lock'), JSON.stringify({ started_at: new Date().toISOString() }));
  const lr = H.run(JSON.stringify(payload()), { root: rl, configModule: ON, env: {} });
  t('B9 no marker during forge-sync maintenance', lr.wrote === false && !fs.existsSync(markerFile(rl)), JSON.stringify(lr));
  const rs = mkRoot();
  const weird = payload({ session_id: SK });
  weird[SK.replace(/-/g, '_')] = 1;
  weird[SK] = 2;
  weird.agentTranscriptPath = 3;
  H.run(JSON.stringify(weird), { root: rs, configModule: ON, env: {}, now: NOW });
  const ws = fs.readFileSync(markerFile(rs), 'utf8');
  t('B10 a secret-shaped session id -> unknown-session; secret-shaped field NAMES (_ and - forms) are dropped', JSON.parse(ws).session_id === 'unknown-session' && !ws.includes('CANARYHOOK') && !/oat01/i.test(ws), ws);
  t('B10b an ordinary camelCase name survives', JSON.parse(ws).payload_fields.includes('agentTranscriptPath'), ws);
  const rn = mkRoot();
  fs.mkdirSync(path.join(rn, '.forge', 'runs'), { recursive: true });
  H.run(JSON.stringify(payload()), { root: rn, configModule: ON, env: {}, now: NOW });
  t('B11 the marker follows forge-paths: .forge/runs when it exists', fs.existsSync(path.join(rn, '.forge', 'runs', '_rotator', 'pending-resume.json')) && !fs.existsSync(markerFile(rn)));
  const back = H.readMarker(root, {});
  t('B12 readMarker round-trips the marker', back && back.session_id === SID && back.matcher === 'rate_limit' && back.ts === NOW && back.resume_after === Date.parse(M.resume_after) && back.resume_after_source === 'message-text', JSON.stringify(back));
  const rt = mkRoot();
  fs.mkdirSync(path.dirname(markerFile(rt)), { recursive: true });
  const bads = [Object.assign({}, M, { schema: 'x' }), Object.assign({}, M, { matcher: 'billing_error' }), Object.assign({}, M, { session_id: '../x' }), Object.assign({}, M, { pad: 'x'.repeat(20000) })];
  t('B13 readMarker refuses a tampered or oversized marker', bads.every((b) => { fs.writeFileSync(markerFile(rt), JSON.stringify(b)); return H.readMarker(rt, {}) === null; }));
  H.run(JSON.stringify(payload({ error: 'overloaded' })), { root, configModule: ON, env: {}, now: NOW + 5000 });
  t('B14 a second StopFailure replaces the single marker', readJson(markerFile(root)).matcher === 'overloaded' && fs.readdirSync(path.dirname(markerFile(root))).length === 1);

  console.log('\nC) the real CLI (fail-open, silent, fast)');
  const env0 = (r) => Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: r, FORGE_ROTATOR_HOOK: '' });
  const cli = (r, input, extraEnv) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 15000, env: Object.assign(env0(r), extraEnv || {}) });
  for (const [name, input] of [['garbage', 'not json {{{'], ['empty', ''], ['array', '[1,2]'], ['binary', '\u0000\u0001\u00ff']]) {
    const c = cli(mkRoot(), input);
    t('C1 CLI on ' + name + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }
  const rc = mkRoot();
  const c2 = cli(rc, JSON.stringify(payload()));
  t('C2 default config (rotator-auto-resume off): exit 0, silent, no marker', c2.status === 0 && c2.stdout === '' && !fs.existsSync(markerFile(rc)), c2.stderr);
  fs.writeFileSync(path.join(process.env.FORGE_CONFIG_HOME, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'rotator-auto-resume': { value: true } } }));
  const t0 = Date.now();
  const c3 = cli(rc, JSON.stringify(payload()));
  const ms = Date.now() - t0;
  t('C3 real forge-config + global rotator-auto-resume on: marker written, exit 0, silent', c3.status === 0 && c3.stdout === '' && fs.existsSync(markerFile(rc)) && readJson(markerFile(rc)).session_id === SID, c3.stderr);
  t('C4 runtime well under the 2 s failsafe (' + ms + ' ms)', ms < 2000);
  const c5 = cli(mkRoot(), JSON.stringify(payload()), { FORGE_ROTATOR_HOOK: 'off' });
  t('C5 FORGE_ROTATOR_HOOK=off through the CLI: exit 0, silent', c5.status === 0 && c5.stdout === '');
  const c6 = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  t('C6 --help: exit 0, nothing on stdout', c6.status === 0 && c6.stdout === '' && /StopFailure/.test(c6.stderr));
  fs.rmSync(path.join(process.env.FORGE_CONFIG_HOME, 'FORGE_CONFIG.json'), { force: true });

  console.log('\nD) settings fragment');
  const F = readJson(FRAGMENT);
  const entries = F.hooks && F.hooks.StopFailure;
  const h0 = entries && entries[0] && entries[0].hooks && entries[0].hooks[0];
  t('D1 one StopFailure entry, matcher rate_limit|overloaded', Array.isArray(entries) && entries.length === 1 && entries[0].matcher === 'rate_limit|overloaded');
  t('D2 the matcher uses only the StopFailure exact-match charset (letters, digits, _ and |)', /^[A-Za-z0-9_|]+$/.test(entries[0].matcher));
  t('D3 command hook, same shape and timeout as settings.json hooks', h0 && h0.type === 'command' && h0.timeout === 5 && h0.command === 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-rotator-hook.cjs"');
  t('D4 NOT async (-p kills async hooks at teardown; the supervisor needs the marker from -p runs)', h0 && h0.async !== true && !('async' in h0));
  t('D5 only the hooks block besides _doc (nothing else to merge)', JSON.stringify(Object.keys(F).sort()) === JSON.stringify(['_doc', 'hooks']) && JSON.stringify(Object.keys(F.hooks)) === JSON.stringify(['StopFailure']));
  t('D6 the referenced hook file exists', fs.existsSync(path.join(__dirname, 'forge-rotator-hook.cjs')));
  const realSettings = readJson(path.join(__dirname, '..', 'settings.json'));
  t('D7 merged into settings.json exactly as the fragment (work package 2.9)', JSON.stringify(realSettings.hooks && realSettings.hooks.StopFailure) === JSON.stringify(F.hooks.StopFailure));

  console.log('\nE) mutation checks (the tests above must catch each mutant)');
  const leak = loadMutant(SCRIPT, "    error_details_type: det === undefined", "    leaked: payload.last_assistant_message,\n    error_details_type: det === undefined");
  const rm1 = mkRoot();
  leak.run(JSON.stringify(payload()), { root: rm1, configModule: ON, env: {}, now: NOW });
  t('E1 a marker that stores message text is caught by the B5 canary check', fs.readFileSync(markerFile(rm1), 'utf8').includes('MESSAGE-CANARY'));
  const nogate = loadMutant(SCRIPT, "if (gate.value !== true) return", "if (false) return");
  const rm2 = mkRoot();
  nogate.run(JSON.stringify(payload()), { root: rm2, configModule: OFF, env: {}, now: NOW });
  t('E2 a hook without the rotator-auto-resume gate is caught by B8', fs.existsSync(markerFile(rm2)));
  const noallow = loadMutant(SCRIPT, "if (!MATCHERS.includes(payload.error)) return", "if (false) return");
  const rm3 = mkRoot();
  noallow.run(JSON.stringify(payload({ error: 'authentication_failed' })), { root: rm3, configModule: ON, env: {}, now: NOW });
  t('E3 a hook without the error allowlist is caught by B8', fs.existsSync(markerFile(rm3)));
  const nowin = loadMutant(SCRIPT, "function inWindow(t, now) { return Number.isFinite(t) && t > now && t <= now + MAX_AHEAD_MS ? t : null; }", "function inWindow(t) { return Number.isFinite(t) ? t : null; }");
  t('E4 a parser that accepts past/far resets is caught by A5/A7', nowin.parseResetText('Claude AI usage limit reached|' + (ep - 7200), NOW) !== null);
} catch (e) {
  fail++;
  console.log('  FAIL uncaught: ' + (e && e.stack ? e.stack : e));
} finally {
  try { if (BASE.startsWith(os.tmpdir())) fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
