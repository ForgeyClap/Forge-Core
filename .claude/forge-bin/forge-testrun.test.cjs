'use strict';
// Local harness (not node:test) so the file prints the `N passed, M failed` line the doctor's tally parses;
// every case below is synchronous (spawnSync), so a plain try/catch runner is exact.
const assert = require('node:assert');
let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); }
};
process.on('exit', () => { console.log('\n' + pass + ' passed, ' + fail + ' failed'); if (fail) process.exitCode = 1; });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const NODE = process.execPath;
const TOOL = path.join(__dirname, 'forge-testrun.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testrun-'));

function fixture(name, body) { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; }
function run(fix, extra = []) {
  const logDir = path.join(tmp, 'logs');
  const r = spawnSync(NODE, [TOOL, '--log-dir', logDir, ...extra, '--', NODE, fix], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, logDir };
}

test('passing custom harness: counts, exit 0, log written', () => {
  const r = run(fixture('pass.js', 'console.log("noise");console.log("12 passed, 0 failed");'));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /^12 passed, 0 failed$/m);
  assert.match(r.out, /exit code: 0/);
  const m = r.out.match(/full log: (.+)/);
  assert.ok(m && fs.existsSync(m[1].trim()));
});

test('failing: exit code mirrored, failing name + lines shown', () => {
  const r = run(fixture('fail.js', 'console.log("not ok 1 - widget breaks");console.log("  boom detail line");console.log("# pass 3");console.log("# fail 1");process.exit(1);'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^3 passed, 1 failed$/m);
  assert.match(r.out, /FAIL: widget breaks/);
  assert.match(r.out, /boom detail line/);
});

test('node:test style summary parsed', () => {
  const r = run(fixture('nt.js', 'const t=require("node:test");t("a",()=>{});t("b",()=>{});'));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /^2 passed, 0 failed$/m);
});

test('no summary: says so and prints tail', () => {
  const r = run(fixture('nosum.js', 'for(let i=0;i<30;i++)console.log("line "+i);'));
  assert.match(r.out, /no pass\/fail summary/);
  assert.match(r.out, /line 29/);
  assert.doesNotMatch(r.out, /line 5\b/);
});

test('timeout: kills child, exit 124', () => {
  const t0 = Date.now();
  const r = run(fixture('hang.js', 'setInterval(()=>{},1000);'), ['--timeout-sec', '1']);
  assert.strictEqual(r.code, 124);
  assert.match(r.out, /TIMEOUT/);
  assert.ok(Date.now() - t0 < 15000);
});

test('output cap: at most 40 lines', () => {
  const body = 'for(let i=0;i<100;i++){console.log("not ok "+i+" - t"+i);console.log("  d"+i);}console.log("# pass 0");console.log("# fail 100");process.exit(1);';
  const r = run(fixture('many.js', body));
  assert.ok(r.out.trim().split('\n').length <= 40);
  assert.match(r.out, /full log:/);
});

test('secret-shaped string scrubbed from output and log', () => {
  const secret = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
  const r = run(fixture('sec.js', 'console.log("not ok 1 - leaks ' + secret + '");console.log("# pass 0");console.log("# fail 1");process.exit(1);'));
  assert.ok(!r.out.includes(secret));
  assert.match(r.out, /REDACTED/);
  const log = r.out.match(/full log: (.+)/)[1].trim();
  assert.ok(!fs.readFileSync(log, 'utf8').includes(secret));
});

// WP-TMP-HYGIENE: the wrapped command gets a private forge-run-<pid>-<n> temp folder that is removed afterwards.
const tmphSuite = (name, tail) => fixture(name,
  "const fs = require('fs'); const os = require('os'); const path = require('path');\n" +
  "const leak = fs.mkdtempSync(path.join(os.tmpdir(), 'leaky-')); fs.writeFileSync(path.join(leak, 'x'), 'x');\n" +
  "fs.writeFileSync(" + JSON.stringify(path.join(tmp, name + '.json')) + ", JSON.stringify({ tmp: os.tmpdir(), TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, leak }));\n" + tail);
const tmphSeen = (name) => JSON.parse(fs.readFileSync(path.join(tmp, name + '.json'), 'utf8'));
const tmphIsolated = (s) => s.TEMP === s.tmp && s.TMP === s.tmp && s.TMPDIR === s.tmp
  && path.dirname(path.resolve(s.tmp)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() && /^forge-run-\d+-\d+$/.test(path.basename(s.tmp));

test('WP-TMP-HYGIENE: passing command runs in a private temp folder that is removed afterwards', () => {
  const r = run(tmphSuite('tmph-pass.js', 'console.log("1 passed, 0 failed");'));
  assert.strictEqual(r.code, 0);
  const s = tmphSeen('tmph-pass.js');
  assert.ok(tmphIsolated(s), JSON.stringify(s));
  assert.ok(!fs.existsSync(s.tmp) && !fs.existsSync(s.leak));
});

test('WP-TMP-HYGIENE: failing command still has its private temp folder removed', () => {
  const r = run(tmphSuite('tmph-fail.js', 'console.log("0 passed, 1 failed"); process.exit(3);'));
  assert.strictEqual(r.code, 3);
  const s = tmphSeen('tmph-fail.js');
  assert.ok(tmphIsolated(s), JSON.stringify(s));
  assert.ok(!fs.existsSync(s.tmp) && !fs.existsSync(s.leak));
});

test('WP-TMP-HYGIENE: timed-out command still has its private temp folder removed', () => {
  const r = run(tmphSuite('tmph-hang.js', 'setInterval(() => {}, 1000);'), ['--timeout-sec', '2']);
  assert.strictEqual(r.code, 124);
  const s = tmphSeen('tmph-hang.js');
  assert.ok(tmphIsolated(s), JSON.stringify(s));
  assert.ok(!fs.existsSync(s.tmp) && !fs.existsSync(s.leak));
});

// WP-LONGPATH: the wrapped command gets core.longpaths=true + protocol.file.allow=always through GIT_CONFIG_COUNT env
// vars (no git config file), appended to any entries already in the environment. The clean HOME + GIT_CONFIG_NOSYSTEM
// prove the values come from the env, not from the owner's global or system git config.
const lpHome = fs.mkdtempSync(path.join(tmp, 'home-'));
const lpEnv = (extra) => {
  const e = Object.assign({}, process.env, { HOME: lpHome, USERPROFILE: lpHome, XDG_CONFIG_HOME: lpHome, GIT_CONFIG_NOSYSTEM: '1' });
  for (const k of Object.keys(e)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(k)) delete e[k];
  return Object.assign(e, extra);
};
const lpSuite = (name) => fixture(name,
  "const { spawnSync } = require('child_process'); const fs = require('fs');\n" +
  "const g = (k) => { const r = spawnSync('git', ['config', '--get', k], { encoding: 'utf8' }); return (r.stdout || '').trim(); };\n" +
  "fs.writeFileSync(" + JSON.stringify(path.join(tmp, name + '.json')) + ", JSON.stringify({ longpaths: g('core.longpaths'), fileAllow: g('protocol.file.allow'), marker: g('forge.lpmarker'), count: process.env.GIT_CONFIG_COUNT }));\n" +
  "console.log('1 passed, 0 failed');\n");
const lpRun = (fix, env) => spawnSync(NODE, [TOOL, '--log-dir', path.join(tmp, 'logs'), '--', NODE, fix], { encoding: 'utf8', env });

test('WP-LONGPATH: wrapped command sees core.longpaths=true and protocol.file.allow=always from a clean HOME', () => {
  const r = lpRun(lpSuite('lp-clean.js'), lpEnv({}));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(tmp, 'lp-clean.js.json'), 'utf8'));
  assert.deepStrictEqual([s.longpaths, s.fileAllow, s.count], ['true', 'always', '2'], JSON.stringify(s));
});

test('WP-LONGPATH: an existing GIT_CONFIG_COUNT entry is preserved and extended, not overwritten', () => {
  const r = lpRun(lpSuite('lp-keep.js'), lpEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'forge.lpmarker', GIT_CONFIG_VALUE_0: 'kept' }));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(tmp, 'lp-keep.js.json'), 'utf8'));
  assert.deepStrictEqual([s.marker, s.longpaths, s.fileAllow, s.count], ['kept', 'true', 'always', '3'], JSON.stringify(s));
});

test('usage error exits 2', () => {
  const r = spawnSync(NODE, [TOOL], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
