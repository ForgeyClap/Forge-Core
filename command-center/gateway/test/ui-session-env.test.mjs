// FU-STEP2: the UI session secret and a launcher pairing code reach the gateway ONLY through its
// environment, are read once when security.mjs loads, and are then deleted from process.env, so no
// child the gateway spawns afterwards (helpers inherit the full environment; the `claude` child gets
// filteredEnv()) can see them. `node --test` runs every file in its own process, so setting the
// variables BEFORE the dynamic import below is exactly what a real gateway start does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const SECRET = 'b'.repeat(40) + '0123456789abcdef01234567';
const CODE = 'c0de'.repeat(12);
const NOW = Date.now();

process.env.FORGE_UI_SESSION_SECRET = SECRET;
process.env.FORGE_UI_PAIRING_CODE = CODE + '.' + (NOW + 60000);

const security = await import('../src/security.mjs');
const { createServer } = await import('../src/server.mjs');
const { filteredEnv } = await import('../src/exec-cli.mjs');

let server;
let port;

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('RED-first: loading security.mjs removes both variables from process.env', () => {
  assert.equal(process.env.FORGE_UI_SESSION_SECRET, undefined);
  assert.equal(process.env.FORGE_UI_PAIRING_CODE, undefined);
  const childEnv = filteredEnv();
  assert.ok(!Object.values(childEnv).includes(SECRET), 'filteredEnv() never carries the secret');
  assert.ok(!Object.keys(childEnv).some((k) => k.toUpperCase().startsWith('FORGE_UI_')), 'filteredEnv() never carries a FORGE_UI_ variable');
});

test('RED-first: a child that inherits the gateway environment sees neither the secret nor the code', () => {
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.toUpperCase().startsWith("FORGE_UI_"))))'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), []);
});

test('RED-first: the launcher code swaps once for a cookie whose value is the secret the parent handed over', async () => {
  const first = await get('/?pair=' + CODE, { 'Sec-Fetch-Site': 'none' });
  assert.equal(first.statusCode, 302);
  const cookie = [].concat(first.headers['set-cookie'] || [])[0] || '';
  assert.equal(cookie.split(';')[0], 'forge_ui=' + SECRET);
  const again = await get('/?pair=' + CODE, { 'Sec-Fetch-Site': 'none' });
  assert.equal([].concat(again.headers['set-cookie'] || []).length, 0, 'the launcher code is single use too');
  const status = await get('/api/ui-session', { Cookie: 'forge_ui=' + SECRET });
  assert.equal(JSON.parse(status.body).paired, true);
});

test('RED-first: parseUiSessionEnv keeps a well-formed secret and a live code, and drops everything else', () => {
  assert.equal(typeof security.parseUiSessionEnv, 'function');
  const parse = (env) => security.parseUiSessionEnv(env, NOW);
  assert.equal(parse({ FORGE_UI_SESSION_SECRET: SECRET }).secret, SECRET);
  assert.equal(parse({ FORGE_UI_SESSION_SECRET: 'short' }).secret, null, 'too short');
  assert.equal(parse({ FORGE_UI_SESSION_SECRET: 'x'.repeat(40) + ' ;=' }).secret, null, 'cookie-unsafe characters');
  assert.equal(parse({}).secret, null);

  assert.deepEqual(parse({ FORGE_UI_PAIRING_CODE: CODE + '.' + (NOW + 1000) }).pairing, { code: CODE, expiresAt: NOW + 1000 });
  assert.equal(parse({ FORGE_UI_PAIRING_CODE: CODE + '.' + (NOW - 1) }).pairing, null, 'already expired');
  assert.equal(parse({ FORGE_UI_PAIRING_CODE: CODE + '.' + (NOW + 10 * 60000) }).pairing.expiresAt, NOW + 120000, 'clamped to at most 120 s');
  assert.equal(parse({ FORGE_UI_PAIRING_CODE: CODE }).pairing.expiresAt, NOW + 120000, 'no expiry given: 120 s from now');
  assert.equal(parse({ FORGE_UI_PAIRING_CODE: 'abc.' + (NOW + 1000) }).pairing, null, 'too short');
  assert.equal(parse({ FORGE_UI_PAIRING_CODE: CODE + '.soon' }).pairing, null, 'unreadable expiry');
});
