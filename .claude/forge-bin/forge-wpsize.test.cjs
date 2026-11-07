#!/usr/bin/env node
'use strict';
// forge-wpsize.test.cjs — the Head Chef work-package size classifier. Pure function + CLI;
// no file is written anywhere (the CLI reads --files-from only from a fixture under os.tmpdir()).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const W = require('./forge-wpsize.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const CLI = path.join(__dirname, 'forge-wpsize.cjs');
const run = (argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });

console.log('forge-wpsize tests (Head Chef size classifier, WP-S5)');

t('fixture: a one-file change touching auth is at least standard', () => {
  const r = W.classifySize({ files: ['src/auth/login.js'] });
  assert.strictEqual(r.tier, 'standard');
  assert.strictEqual(r.floor, 'standard');
  assert.ok(r.security_paths.includes('src/auth/login.js'), JSON.stringify(r));
});

t('the same one-file change outside security is small', () => {
  const r = W.classifySize({ files: ['src/ui/button.css'] });
  assert.strictEqual(r.tier, 'small');
  assert.strictEqual(r.floor, null);
});

t('security path words: session, token, secret, crypto, permission, oauth, jwt, payment, billing, password', () => {
  for (const f of ['lib/session.ts', 'api/token-store.js', 'config/secrets.yaml', 'util/crypto.go', 'core/permissions.py', 'oauth/callback.js', 'mw/jwt.js', 'pay/payment.ts', 'billing/invoice.rb', 'forms/password-reset.tsx']) {
    assert.strictEqual(W.classifySize({ files: [f] }).tier, 'standard', f);
  }
});

t('false friends: author, authority-free words and "tokenizer" docs are NOT security paths', () => {
  for (const f of ['docs/authors.md', 'src/text/tokenizer-notes.md', 'assets/sessions-photo.png']) {
    assert.strictEqual(W.classifySize({ files: [f] }).tier, 'small', f);
  }
});

t('an explicit security flag sets the standard floor without any path', () => {
  assert.strictEqual(W.classifySize({ files: ['a.js'], security: true }).tier, 'standard');
});

t('a public API change (flag, contract public, or an OpenAPI/GraphQL/proto file) is at least standard', () => {
  assert.strictEqual(W.classifySize({ files: ['a.js'], publicApi: true }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['a.js'], contract: 'public' }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['api/openapi.yaml'] }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['schema/user.graphql'] }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['proto/svc.proto'] }).tier, 'standard');
});

t('files touched: 0-2 small, 3-8 standard, 9+ large', () => {
  const n = (k) => Array.from({ length: k }, (_, i) => 'src/f' + i + '.js');
  assert.strictEqual(W.classifySize({ files: n(2) }).tier, 'small');
  assert.strictEqual(W.classifySize({ files: n(3) }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: n(8) }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: n(9) }).tier, 'large');
});

t('duplicate and empty file entries are not counted twice', () => {
  assert.strictEqual(W.classifySize({ files: ['a.js', 'a.js', ' ', './a.js', 'b.js'] }).factors.files.count, 2);
});

t('a new dependency or an internal contract is standard; a breaking contract is large', () => {
  assert.strictEqual(W.classifySize({ files: ['a.js'], newDependency: true }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['a.js'], contract: 'internal' }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['a.js'], contract: 'breaking' }).tier, 'large');
});

t('design ambiguity: none small, some standard, high large', () => {
  assert.strictEqual(W.classifySize({ files: ['a.js'], ambiguity: 'none' }).tier, 'small');
  assert.strictEqual(W.classifySize({ files: ['a.js'], ambiguity: 'some' }).tier, 'standard');
  assert.strictEqual(W.classifySize({ files: ['a.js'], ambiguity: 'high' }).tier, 'large');
});

t('the highest tier wins: few files + high ambiguity is large, not an average', () => {
  const r = W.classifySize({ files: ['a.js'], ambiguity: 'high', contract: 'none' });
  assert.strictEqual(r.tier, 'large');
  assert.ok(r.reasons.some((x) => /ambiguity/.test(x)), JSON.stringify(r.reasons));
});

t('the floor never lowers a higher tier: a 12-file auth change stays large', () => {
  const files = Array.from({ length: 12 }, (_, i) => 'src/auth/f' + i + '.js');
  assert.strictEqual(W.classifySize({ files }).tier, 'large');
});

t('every reason names its factor; a small result says why it is small', () => {
  const r = W.classifySize({ files: ['a.js'] });
  assert.ok(r.reasons.length >= 1 && r.reasons.every((x) => typeof x === 'string' && x.length > 5), JSON.stringify(r));
});

t('invalid input throws with a clear message (unknown contract, unknown ambiguity, files not a list)', () => {
  assert.throws(() => W.classifySize({ files: ['a.js'], contract: 'huge' }), /contract/);
  assert.throws(() => W.classifySize({ files: ['a.js'], ambiguity: 'maybe' }), /ambiguity/);
  assert.throws(() => W.classifySize({ files: 'a.js' }), /files/);
});

t('suggested GOAT route: small -> quick, standard -> build, large -> deep; security or public API -> deep', () => {
  assert.strictEqual(W.classifySize({ files: ['a.js'] }).route_hint, 'quick');
  assert.strictEqual(W.classifySize({ files: ['a.js', 'b.js', 'c.js'] }).route_hint, 'build');
  assert.strictEqual(W.classifySize({ files: ['a.js'], ambiguity: 'high' }).route_hint, 'deep');
  assert.strictEqual(W.classifySize({ files: ['src/auth/login.js'] }).route_hint, 'deep');
});

t('CLI --files + --json prints the classification and exits 0', () => {
  const r = run(['--files', 'src/auth/login.js', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).tier, 'standard');
});

t('CLI --files-from reads one path per line (git diff --name-only output)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wpsize-'));
  const list = path.join(dir, 'files.txt');
  fs.writeFileSync(list, 'a.js\r\nb.js\n\nc.js\n');
  const r = run(['--files-from', list, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).factors.files.count, 3);
  fs.unlinkSync(list); fs.rmdirSync(dir);
});

t('CLI text mode prints the tier first; a bad flag value exits 2', () => {
  const ok = run(['--files', 'a.js', '--ambiguity', 'some']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(/^tier: standard/m.test(ok.stdout), ok.stdout);
  const bad = run(['--files', 'a.js', '--contract', 'huge']);
  assert.strictEqual(bad.status, 2);
  assert.ok(/contract/.test(bad.stderr), bad.stderr);
});

t('CLI with no input at all exits 2 with usage', () => {
  const r = run([]);
  assert.strictEqual(r.status, 2);
  assert.ok(/Usage/.test(r.stderr), r.stderr);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
